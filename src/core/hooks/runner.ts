/**
 * Hook runner — executes hook commands and parses their output.
 *
 * Protocol (matching Claude Code):
 * - Hook receives JSON via stdin
 * - Exit 0 = success (parse stdout as JSON for decisions)
 * - Exit 2 = blocking error (tool call is denied)
 * - Other exit codes = non-blocking error (continue, log warning)
 *
 * Safety:
 * - Uses spawn (not execFile) with stdout size cap to prevent OOM
 * - Propagates abort signal to kill hook processes on Ctrl+X
 * - Short default timeout (10s) to prevent deadlocks — hooks should be fast
 * - All errors resolve (never reject) to prevent unhandled promise crashes
 */

import { spawn } from "node:child_process";
import { logBackgroundError } from "../../stores/errors.js";
import { shellInvocation } from "../platform/index.js";
import { buildSafeEnv } from "../spawn.js";
import { getHooks } from "./loader.js";
import { matchesToolName, toClaudeToolName } from "./tool-names.js";
import type {
  CommandHook,
  HookEventName,
  HookInput,
  HookOutput,
  HookResult,
  HookRule,
} from "./types.js";

/** Default timeout for hook commands — kept short to avoid blocking the agent. */
const DEFAULT_TIMEOUT_S = 10;
/** Max stdout bytes to capture from a hook process. */
const MAX_STDOUT_BYTES = 256 * 1024; // 256KB

// ── once: true tracking ──────────────────────────────────────────────
// Keyed by command string — a hook with once:true only fires once per
// process lifetime (session). Survives cache invalidation.
const _onceFired = new Set<string>();

/** Reset once-tracking (for tests). */
export function resetOnceTracking(): void {
  _onceFired.clear();
}

// ── Per-event disable (session-scoped, toggled via /hooks) ──────────
const _disabledEvents = new Set<string>();

/** Disable a hook event for this session. */
export function disableHookEvent(event: string): void {
  _disabledEvents.add(event);
}

/** Enable a hook event for this session. */
export function enableHookEvent(event: string): void {
  _disabledEvents.delete(event);
}

/** Check if a hook event is disabled for this session. */
export function isHookEventDisabled(event: string): boolean {
  return _disabledEvents.has(event);
}

/** Get all currently disabled hook events. */
export function getDisabledHookEvents(): ReadonlySet<string> {
  return _disabledEvents;
}

// ── if: conditional execution ────────────────────────────────────────

/**
 * Check if a hook's `if` condition matches the current tool input.
 *
 * Format: `ToolName(glob_pattern)` — e.g. `Bash(git *)`, `Edit(*.ts)`
 * The ToolName must match the current tool, and the glob pattern is tested
 * against the first string value in tool_input (typically `command` or `path`).
 *
 * Simple glob: `*` matches any sequence, `?` matches one char.
 */
function matchesIfCondition(
  condition: string,
  claudeToolName: string,
  toolInput?: Record<string, unknown>,
): boolean {
  const m = condition.match(/^(\w+)\((.+)\)$/);
  if (!m) return true; // Malformed condition — don't block

  const [, condTool, pattern] = m;
  if (condTool !== claudeToolName) return false;

  // Find the first string value in tool input to match against
  if (!toolInput) return false;
  const firstStr = Object.values(toolInput).find((v): v is string => typeof v === "string");
  if (!firstStr) return false;

  // Convert simple glob to regex: * → .*, ? → .
  const escaped = (pattern ?? "")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${escaped}$`).test(firstStr);
  } catch {
    return true; // Bad pattern — don't block
  }
}

/** Resolve the shell binary. Windows: cmd.exe. POSIX: /bin/sh. */
function getShell(): { cmd: string; args: string[] } {
  const inv = shellInvocation();
  return { cmd: inv.cmd, args: inv.flag.split(" ") };
}

/** Parse hook JSON output into a HookResult. */
function parseHookOutput(stdout: string, stderr: string, exitCode: number): HookResult {
  // Exit 2 = blocking error (Claude Code convention)
  if (exitCode === 2) {
    let reason = stderr.trim() || "Hook blocked the action";
    let output: HookOutput | undefined;
    try {
      output = JSON.parse(stdout.trim()) as HookOutput;
      if (output.reason) reason = output.reason;
      if (output.hookSpecificOutput && "permissionDecisionReason" in output.hookSpecificOutput) {
        reason = output.hookSpecificOutput.permissionDecisionReason ?? reason;
      }
    } catch {}
    return {
      ok: false,
      blocked: true,
      reason,
      output,
      additionalContext: output?.hookSpecificOutput?.additionalContext,
    };
  }

  // Non-zero exit (not 2) = non-blocking error
  if (exitCode !== 0) {
    return {
      ok: false,
      blocked: false,
      reason: stderr.trim() || `Hook exited with code ${String(exitCode)}`,
    };
  }

  // Exit 0 = success — parse JSON output
  let output: HookOutput | undefined;
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      output = JSON.parse(trimmed) as HookOutput;
    } catch {
      // Non-JSON stdout is fine — just means no structured output
    }
  }

  // Check for explicit block decision
  if (output?.decision === "block") {
    return {
      ok: true,
      blocked: true,
      reason: output.reason ?? "Hook blocked the action",
      output,
      additionalContext: output.hookSpecificOutput?.additionalContext,
    };
  }

  // Check for deny permission in hookSpecificOutput
  const specific = output?.hookSpecificOutput;
  if (specific && "permissionDecision" in specific && specific.permissionDecision === "deny") {
    return {
      ok: true,
      blocked: true,
      reason: specific.permissionDecisionReason ?? "Hook denied permission",
      output,
      updatedInput: "updatedInput" in specific ? specific.updatedInput : undefined,
      additionalContext: specific.additionalContext,
    };
  }

  // Success
  return {
    ok: true,
    blocked: false,
    output,
    updatedInput: specific && "updatedInput" in specific ? specific.updatedInput : undefined,
    additionalContext: specific?.additionalContext,
  };
}

/** Run a single command hook and return the parsed result. Never rejects. */
function runCommandHook(
  hook: CommandHook,
  input: HookInput,
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<HookResult> {
  const timeoutMs = (hook.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
  const stdinData = JSON.stringify(input);
  const shell = getShell();

  return new Promise<HookResult>((resolve) => {
    // Already aborted before we even start
    if (abortSignal?.aborted) {
      resolve({ ok: false, blocked: false, reason: "Aborted" });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell.cmd, [...shell.args, hook.command], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...buildSafeEnv(),
          SOULFORGE_PROJECT_DIR: cwd,
          CLAUDE_PROJECT_DIR: cwd, // Claude Code compat
        },
      });
    } catch (err) {
      resolve({
        ok: false,
        blocked: false,
        reason: `Failed to spawn hook: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let settled = false;

    const settle = (result: HookResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Timeout — kill the process and resolve as non-blocking error
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      settle({
        ok: false,
        blocked: false,
        reason: `Hook timed out after ${String(hook.timeout ?? DEFAULT_TIMEOUT_S)}s`,
      });
    }, timeoutMs);

    // Abort signal — kill hook process when user hits Ctrl+X
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
      settle({ ok: false, blocked: false, reason: "Aborted" });
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    // Capture stdout with size cap
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_STDOUT_BYTES) {
        stdout += chunk.toString("utf-8");
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      // Only keep last 4KB of stderr for error messages
      stderr += chunk.toString("utf-8");
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      settle({
        ok: false,
        blocked: false,
        reason: `Hook process error: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      settle(parseHookOutput(stdout, stderr, code ?? 1));
    });

    // Send input via stdin — handle write errors gracefully
    if (child.stdin) {
      child.stdin.on("error", () => {}); // Ignore EPIPE if process exits early
      child.stdin.write(stdinData);
      child.stdin.end();
    }
  });
}

/** Get matching hook rules for an event + optional tool name. */
function getMatchingRules(event: HookEventName, toolName?: string, cwd?: string): HookRule[] {
  if (_disabledEvents.has(event)) return [];
  const hooks = getHooks(cwd);
  const rules = hooks[event];
  if (!rules || rules.length === 0) return [];

  if (!toolName) return rules;

  return rules.filter((rule) => matchesToolName(rule.matcher, toolName));
}

// ── Public API ───────────────────────────────────────────────────────

export interface RunHooksOptions {
  event: HookEventName;
  /** SoulForge tool name (e.g. "shell", "edit_file"). */
  toolName?: string;
  /** Tool input arguments. */
  toolInput?: Record<string, unknown>;
  /** Tool response (for PostToolUse). */
  toolResponse?: unknown;
  /** Tool call ID. */
  toolCallId?: string;
  /** Session ID. */
  sessionId?: string;
  /** Working directory. */
  cwd?: string;
  /** Abort signal — kills hook processes on Ctrl+X. */
  abortSignal?: AbortSignal;
}

/**
 * Run all matching hooks for an event.
 *
 * For PreToolUse: runs hooks sequentially. If any hook blocks, returns immediately.
 * For PostToolUse: runs all hooks (blocking decisions are ignored — tool already ran).
 * For other events: runs all hooks sequentially.
 *
 * Returns a combined result. If no hooks match, returns `{ ok: true, blocked: false }`.
 * Never throws — all errors are captured in the result.
 */
export async function runHooks(opts: RunHooksOptions): Promise<HookResult> {
  const cwd = opts.cwd ?? process.cwd();
  const rules = getMatchingRules(opts.event, opts.toolName, cwd);

  if (rules.length === 0) {
    return { ok: true, blocked: false };
  }

  const input: HookInput = {
    session_id: opts.sessionId ?? "",
    cwd,
    hook_event_name: opts.event,
    ...(opts.toolName ? { tool_name: toClaudeToolName(opts.toolName) } : {}),
    ...(opts.toolInput ? { tool_input: opts.toolInput } : {}),
    ...(opts.toolResponse !== undefined ? { tool_response: opts.toolResponse } : {}),
    ...(opts.toolCallId ? { tool_use_id: opts.toolCallId } : {}),
  };

  const combinedContext: string[] = [];
  let updatedInput = opts.toolInput;

  for (const rule of rules) {
    for (const hook of rule.hooks) {
      if (hook.type !== "command") continue;

      // once: true — skip if this command already fired this session
      if (hook.once) {
        const key = `${opts.event}:${hook.command}`;
        if (_onceFired.has(key)) continue;
        _onceFired.add(key);
      }

      // if: conditional — skip if condition doesn't match tool input
      if (hook.if && opts.toolName) {
        const claudeName = toClaudeToolName(opts.toolName);
        if (!matchesIfCondition(hook.if, claudeName, updatedInput ?? opts.toolInput)) continue;
      }

      if (hook.async) {
        // Fire-and-forget — don't await, don't block
        runCommandHook(hook, { ...input, tool_input: updatedInput }, cwd, opts.abortSignal).catch(
          () => {},
        );
        continue;
      }

      const result = await runCommandHook(
        hook,
        { ...input, tool_input: updatedInput },
        cwd,
        opts.abortSignal,
      );

      if (result.additionalContext) {
        combinedContext.push(result.additionalContext);
      }

      // PreToolUse: if blocked, stop immediately
      if (opts.event === "PreToolUse" && result.blocked) {
        return {
          ...result,
          additionalContext: combinedContext.length > 0 ? combinedContext.join("\n") : undefined,
        };
      }

      // Carry forward input modifications
      if (result.updatedInput) {
        updatedInput = result.updatedInput;
      }

      // Log non-blocking errors but don't interrupt
      if (!result.ok && !result.blocked) {
        logBackgroundError(
          "hooks",
          `${opts.event} hook warning: ${result.reason ?? "unknown error"}`,
        );
      }
    }
  }

  return {
    ok: true,
    blocked: false,
    updatedInput: updatedInput !== opts.toolInput ? updatedInput : undefined,
    additionalContext: combinedContext.length > 0 ? combinedContext.join("\n") : undefined,
  };
}

/**
 * Quick check: are there any hooks configured for PreToolUse or PostToolUse?
 * Used to skip the hook wrapper entirely when no hooks are configured.
 */
export function hasToolHooks(cwd?: string): boolean {
  const hooks = getHooks(cwd);
  const pre = hooks.PreToolUse;
  const post = hooks.PostToolUse;
  return (Array.isArray(pre) && pre.length > 0) || (Array.isArray(post) && post.length > 0);
}
