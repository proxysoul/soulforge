#!/usr/bin/env bun
/**
 * soulforge-remote — tiny CLI invoked by PreToolUse hooks.
 *
 * Modes:
 *   approve     — ask the daemon whether to allow the current tool call
 *   deny-read   — fast-path read-denylist check; runs without daemon contact
 *
 * Reads Claude-Code-compatible hook JSON from stdin, exits:
 *   0  → allow / no opinion
 *   2  → block (Claude Code convention — stderr becomes the denial reason)
 *  >0  → non-blocking error (agent continues, warning logged)
 *
 * Behavior is deliberately boring: minimal imports, no daemon = deny-fail-closed
 * for `approve`, allow-fail-open for `deny-read` (pattern file missing means
 * "no extra patterns, defer to builtin tooling"). This keeps a wedged daemon
 * from bricking local CLI sessions that don't use Hearth.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { configDir, matchGlob, expandHome as platformExpandHome } from "../core/platform/index.js";
import { socketRequest } from "./protocol.js";
import {
  type DenyReadRequest,
  type DenyReadResponse,
  HEARTH_PROTOCOL_VERSION,
  type PermissionRequest,
  type PermissionResponse,
  type SurfaceId,
} from "./types.js";

interface HookStdin {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
}

/** Built-in read-denylist — always active in deny-read mode. */
const BUILTIN_DENYLIST = [
  "**/.env",
  "**/.env.*",
  "**/secrets/**",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  "~/.ssh/**",
  "~/.aws/credentials",
  `${configDir()}/secrets.*`,
  `${configDir()}/hearth.sock`,
];

function expandHome(p: string): string {
  return platformExpandHome(p);
}

/** Glob matcher delegated to the shared shim — backslash-aware + case-insensitive on win32. */
function matchesPattern(path: string, pattern: string): boolean {
  return matchGlob(path, expandHome(pattern));
}

function matchesGlob(path: string, patterns: string[]): string | null {
  for (const pat of patterns) {
    try {
      if (matchesPattern(path, pat)) return pat;
    } catch {
      // bad pattern — skip
    }
  }
  return null;
}

function readStdinSync(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function getSocketPath(): string {
  return process.env.SOULFORGE_HEARTH_SOCKET ?? join(configDir(), "hearth.sock");
}

/** Hearth config shape we care about for deny-read. */
interface MinimalHearthConfig {
  defaults?: { readDenylistExtra?: string[] };
  surfaces?: Record<
    string,
    { chats?: Record<string, { readDenylistExtra?: string[]; cwd?: string }> }
  >;
}

function loadExtraDenylist(cwd: string): string[] {
  const paths = [join(configDir(), "hearth.json"), join(cwd, ".soulforge", "hearth.json")];
  const extras = new Set<string>();
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as MinimalHearthConfig;
      for (const glob of parsed.defaults?.readDenylistExtra ?? []) extras.add(glob);
      for (const surface of Object.values(parsed.surfaces ?? {})) {
        for (const chat of Object.values(surface.chats ?? {})) {
          if (chat.cwd === cwd) {
            for (const glob of chat.readDenylistExtra ?? []) extras.add(glob);
          }
        }
      }
    } catch {
      // corrupt config — ignore
    }
  }
  return [...extras];
}

function normalizePath(p: string, cwd: string): string {
  if (!p) return p;
  const expanded = expandHome(p);
  // path.resolve collapses `..` and `.` so a request for "../../etc/passwd"
  // can't escape to a location the denylist doesn't match.
  const isAbs =
    expanded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(expanded) || expanded.startsWith("\\\\");
  return isAbs ? resolvePath(expanded) : resolvePath(cwd, expanded);
}

function extractPath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  // read / Read / files array / path string — cover all shapes Forge emits
  if (typeof input.path === "string") return input.path;
  if (typeof input.file === "string") return input.file;
  const files = input.files;
  if (Array.isArray(files) && files.length > 0) {
    const first = files[0] as { path?: unknown };
    if (first && typeof first.path === "string") return first.path;
  }
  return null;
}

async function runApprove(hook: HookStdin): Promise<number> {
  const req: PermissionRequest = {
    op: "approve",
    v: HEARTH_PROTOCOL_VERSION,
    sessionId: hook.session_id ?? "",
    toolName: hook.tool_name ?? "",
    toolCallId: hook.tool_use_id ?? "",
    cwd: hook.cwd ?? process.cwd(),
    toolInput: hook.tool_input,
    event: hook.hook_event_name,
  };

  const timeout = Number.parseInt(process.env.SOULFORGE_HEARTH_APPROVAL_TIMEOUT_MS ?? "300000", 10);

  try {
    const res = await socketRequest<PermissionRequest, PermissionResponse>(req, {
      path: getSocketPath(),
      timeoutMs: timeout,
    });
    if (res.decision === "allow") {
      if (res.reason) process.stderr.write(`${res.reason}\n`);
      return 0;
    }
    // Exit 2 + stderr reason → Claude Code block protocol
    process.stderr.write(`${res.reason ?? "Denied by Hearth"}\n`);
    return 2;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fail closed for destructive ops — safer default than letting a wedged
    // daemon silently allow `rm -rf`.
    process.stderr.write(`Hearth approval unavailable: ${msg}\n`);
    return 2;
  }
}

async function runDenyRead(hook: HookStdin): Promise<number> {
  const cwd = hook.cwd ?? process.cwd();
  const rawPath = extractPath(hook.tool_input);
  if (!rawPath) return 0; // nothing to check

  const normalized = normalizePath(rawPath, cwd);
  const extras = loadExtraDenylist(cwd);
  const patterns = [...BUILTIN_DENYLIST, ...extras];

  const matched = matchesGlob(normalized, patterns);
  if (matched) {
    const reason = `Read denied by Hearth (${matched})`;
    process.stderr.write(`${reason}\n`);
    process.stdout.write(
      `${JSON.stringify({
        decision: "block",
        reason,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      })}\n`,
    );
    return 2;
  }

  // Best-effort daemon check for per-chat dynamic policies — skip silently if unavailable.
  if (process.env.SOULFORGE_HEARTH_DENY_READ_REMOTE === "1") {
    const req: DenyReadRequest = {
      op: "deny-read",
      v: HEARTH_PROTOCOL_VERSION,
      path: normalized,
      cwd,
    };
    try {
      const res = await socketRequest<DenyReadRequest, DenyReadResponse>(req, {
        path: getSocketPath(),
        timeoutMs: 2000,
      });
      if (res.decision === "deny") {
        const reason = `Read denied by Hearth (${res.matchedPattern ?? "remote"})`;
        process.stderr.write(`${reason}\n`);
        return 2;
      }
    } catch {
      // offline — allow, builtin already covered the danger zone
    }
  }
  return 0;
}

async function runHealth(): Promise<number> {
  const sock = getSocketPath();
  if (!existsSync(sock)) {
    process.stderr.write(`socket missing: ${sock}\n`);
    return 1;
  }
  try {
    const res = await socketRequest(
      { op: "health", v: HEARTH_PROTOCOL_VERSION },
      { path: sock, timeoutMs: 3000 },
    );
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function runPair(argv: string[]): Promise<number> {
  const surfaceId = argv[0] as SurfaceId | undefined;
  const code = argv[1];
  if (!surfaceId || !code) {
    process.stderr.write("usage: soulforge-remote pair <surface:id> <code>\n");
    return 1;
  }
  try {
    const res = await socketRequest(
      { op: "pair", v: HEARTH_PROTOCOL_VERSION, surfaceId, code },
      { path: getSocketPath(), timeoutMs: 5000 },
    );
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return res.v === HEARTH_PROTOCOL_VERSION && "ok" in res && res.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = argv[0] ?? "approve";
  const rest = argv.slice(1);

  let hook: HookStdin = {};
  if (mode === "approve" || mode === "deny-read") {
    const raw = readStdinSync();
    if (raw.trim()) {
      try {
        hook = JSON.parse(raw) as HookStdin;
      } catch {
        process.stderr.write("invalid hook JSON on stdin\n");
        process.exit(1);
      }
    }
  }

  let code = 0;
  switch (mode) {
    case "approve":
      code = await runApprove(hook);
      break;
    case "deny-read":
      code = await runDenyRead(hook);
      break;
    case "health":
      code = await runHealth();
      break;
    case "pair":
      code = await runPair(rest);
      break;
    default:
      process.stderr.write(
        `soulforge-remote modes: approve, deny-read, health, pair\nunknown: ${mode}\n`,
      );
      code = 1;
  }

  process.exit(code);
}

void main();
