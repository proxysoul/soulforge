import { spawn } from "node:child_process";
import stripAnsi from "strip-ansi";
import type { ToolResult } from "../../types";
import { isForbidden } from "../security/forbidden.js";
// TODO(beta): inline image rendering — disabled until suspend/resume bridge is stable
// import { canRenderImages, renderImages } from "../terminal/image.js";
import { buildSafeEnv, SAFE_SPAWN_OPTS } from "../spawn.js";
import { getIOClient } from "../workers/io-client.js";
import { checkShellBinaryRead } from "./binary-detect.js";
import { compressShellOutputFull as compressLocal } from "./shell-compress.js";
import { saveTee, truncateWithTee } from "./tee.js";

import { getToolTimeoutMs } from "./tool-timeout.js";

// Intercept `git commit -m "..."` to:
// 1. Auto-run lint/typecheck on staged files before committing
// 2. Append co-author trailer when enabled

const CO_AUTHOR_LINE = "Co-Authored-By: SoulForge <soulforge@proxysoul.com>";
let _shellCoAuthorEnabled = true;

export function setShellCoAuthorEnabled(enabled: boolean) {
  _shellCoAuthorEnabled = enabled;
}

const GIT_COMMIT_MSG_RE = /\bgit\s+commit\b.*?\s-m\s+/;

const _preCommitEnabled = true;

async function runPreCommitChecks(cwd: string): Promise<string | null> {
  if (!_preCommitEnabled) return null;

  let lintCmd: string | null = null;
  try {
    const { detectNativeChecks } = await import("./project.js");
    lintCmd = await detectNativeChecks(cwd);
  } catch {
    return null;
  }
  if (!lintCmd) return null;

  try {
    const { exitCode, stdout, stderr } = await new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const chunks: string[] = [];
      const errChunks: string[] = [];
      let lintBytes = 0;
      const proc = spawn("sh", ["-c", lintCmd], {
        cwd,
        timeout: 15_000,
        env: buildSafeEnv(),
        ...SAFE_SPAWN_OPTS,
      });
      proc.stdout?.on("data", (d: Buffer) => {
        lintBytes += d.length;
        if (lintBytes <= MAX_COLLECT_BYTES) chunks.push(d.toString());
      });
      proc.stderr?.on("data", (d: Buffer) => {
        lintBytes += d.length;
        if (lintBytes <= MAX_COLLECT_BYTES) errChunks.push(d.toString());
      });
      proc.on("close", (code) =>
        resolve({ exitCode: code, stdout: chunks.join(""), stderr: errChunks.join("") }),
      );
      proc.on("error", () => resolve({ exitCode: 1, stdout: "", stderr: "lint process error" }));
    });

    if (exitCode !== 0) {
      const output = (stderr.trim() || stdout.trim()).split("\n");
      const truncated =
        output.length > 30
          ? `${output.slice(0, 30).join("\n")}\n... (${String(output.length - 30)} more lines)`
          : output.join("\n");
      return `Pre-commit check failed (${lintCmd}):\n${truncated}\n\nFix errors before committing. Use project(action: "lint", fix: true) to auto-fix.`;
    }
  } catch {
    return null;
  }
  return null;
}

function injectCoAuthor(command: string): string {
  if (!_shellCoAuthorEnabled) return command;
  if (!GIT_COMMIT_MSG_RE.test(command)) return command;
  if (command.includes("Co-Authored-By")) return command;
  if (command.includes("--amend")) return command;

  // Match -m "msg" or -m 'msg' and inject trailer before closing quote
  return command.replace(
    /(-m\s+)(["'])([\s\S]*?)\2/,
    (_match, flag: string, quote: string, msg: string) => {
      const trailer = `\\n\\n${CO_AUTHOR_LINE}`;
      return `${flag}${quote}${msg}${trailer}${quote}`;
    },
  );
}
const MAX_OUTPUT_BYTES = 16_384;
/** Cap bytes collected during streaming to prevent OOM on huge outputs */
const MAX_COLLECT_BYTES = 256_000;
/** Control chars to strip (keep \t \n \r) */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping terminal control chars from shell output
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function sanitizeOutput(text: string): string {
  return stripAnsi(text).replace(CTRL_RE, "");
}

// Commands that read file content
const FILE_READ_RE =
  /\b(cat|head|tail|less|more|bat|xxd|hexdump|strings|base64|tac|nl|od|file)\s+(.+)/;
// Commands that search file content
const FILE_SEARCH_RE = /\b(grep|rg|ag|ack|sed|awk)\s+(.+)/;
// Input redirection: command < file
const INPUT_REDIR_RE = /<\s*([^\s|&;]+)/g;
// Output redirection to a file: > file, >> file
const OUTPUT_REDIR_RE = />{1,2}\s*([^\s|&;]+)/g;

function extractPathArgs(argsStr: string): string[] {
  const tokens = argsStr.match(/(?:'([^']*)'|"([^"]*)"|(\S+))/g) ?? [];
  const re = /^'([^']*)'$|^"([^"]*)"$|^(\S+)$/;
  return tokens.flatMap((t) => {
    const m = t.match(re);
    if (!m) return [];
    const val = m[1] ?? m[2] ?? m[3] ?? "";
    return val.startsWith("-") ? [] : [val];
  });
}

// Subshell / variable expansion patterns that could bypass direct path checks
const SUBSHELL_RE = /\$\(|`[^`]*`|\$\{/;

function extractAllPathLikeArgs(command: string): string[] {
  const paths: string[] = [];
  const words = command.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
  for (const w of words) {
    const cleaned = w.replace(/^['"]|['"]$/g, "");
    if (cleaned.startsWith("-") || cleaned.includes("=")) continue;
    if (/^[a-z_/~.][\w./~*?-]*$/i.test(cleaned)) {
      paths.push(cleaned);
    }
  }
  return paths;
}

// Strip inline code from -e/-c flags (node -e "...", python -c "...") so the
// forbidden guard doesn't scan code strings for sensitive keywords like "env".
const INLINE_CODE_RE = /\s-[ec]\s+(?:"(?:[^"\\]|\\.)*"|'[^']*')/g;

function checkShellForbidden(command: string): string | null {
  // Check ALL path-like arguments in the command against forbidden patterns
  // Use command with inline code stripped to avoid false positives on code strings
  const commandForPaths = command.replace(INLINE_CODE_RE, " __CODE_STRIPPED__ ");
  for (const arg of extractAllPathLikeArgs(commandForPaths)) {
    const blocked = isForbidden(arg);
    if (blocked) return blocked;
  }

  // Check direct file-reading commands
  const readMatch = command.match(FILE_READ_RE);
  if (readMatch) {
    for (const arg of extractPathArgs(readMatch[2] ?? "")) {
      const blocked = isForbidden(arg);
      if (blocked) return blocked;
    }
  }

  // Check search commands (last non-flag arg is often the path)
  const searchMatch = command.match(FILE_SEARCH_RE);
  if (searchMatch) {
    for (const arg of extractPathArgs(searchMatch[2] ?? "")) {
      const blocked = isForbidden(arg);
      if (blocked) return blocked;
    }
  }

  // Check input redirection (< file)
  for (const m of command.matchAll(INPUT_REDIR_RE)) {
    if (m[1]) {
      const blocked = isForbidden(m[1].replace(/['"]/g, ""));
      if (blocked) return blocked;
    }
  }

  // Check output redirection (> file, >> file)
  for (const m of command.matchAll(OUTPUT_REDIR_RE)) {
    if (m[1]) {
      const blocked = isForbidden(m[1].replace(/['"]/g, ""));
      if (blocked) return blocked;
    }
  }

  // Block subshell / variable expansion — extract inner content and check paths
  // Use stripped command so inline code (-e/-c) doesn't trigger false positives
  if (SUBSHELL_RE.test(commandForPaths)) {
    const SENSITIVE_KW = [
      "env",
      "pem",
      "key",
      "credentials",
      "secrets",
      "npmrc",
      "netrc",
      "htpasswd",
      "ssh",
      "token",
      "passwd",
      "shadow",
      "aws",
    ];
    const lower = commandForPaths.toLowerCase();
    for (const kw of SENSITIVE_KW) {
      if (lower.includes(kw)) return `suspicious subshell referencing "${kw}"`;
    }
    for (const m of commandForPaths.matchAll(/\$\(([^)]+)\)/g)) {
      const inner = m[1] ?? "";
      for (const arg of extractAllPathLikeArgs(inner)) {
        const blocked = isForbidden(arg);
        if (blocked) return blocked;
      }
    }
    for (const m of commandForPaths.matchAll(/`([^`]+)`/g)) {
      const inner = m[1] ?? "";
      for (const arg of extractAllPathLikeArgs(inner)) {
        const blocked = isForbidden(arg);
        if (blocked) return blocked;
      }
    }
  }

  return null;
}

interface ShellArgs {
  command: string;
  cwd?: string;
  timeout?: number;
}

const READ_CMD_REDIRECT: Record<string, string> = {
  cat: "read",
  head: "read",
  tail: "read",
  less: "read",
  more: "read",
  bat: "read",
  tac: "read",
  nl: "read",
  grep: "grep",
  rg: "grep",
  ag: "grep",
  ack: "grep",
  find: "glob",
};

const PROJECT_CMD_RE =
  /^(?:bun run|bunx|npm run|npx|pnpm|yarn|deno|cargo|go |mix |dotnet |flutter |dart |swift |zig )\s*(lint|test|typecheck|build|check|clippy|vet|fmt|format)\b/;

function detectReadCommand(command: string): string | null {
  const trimmed = command.trim();
  const first = trimmed.split(/[\s|;&]/)[0]?.replace(/^.*\//, "") ?? "";
  const target = READ_CMD_REDIRECT[first];
  if (!target) return null;
  if (trimmed.includes("|") || trimmed.includes("&&") || trimmed.includes(";")) return null;
  return `Command succeeded, but ${target} is faster, gets cached, and is visible to dispatch dedup. Use ${target} instead of shell for this.`;
}

function detectProjectCommand(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.includes("|") || trimmed.includes("&&") || trimmed.includes(";")) return null;
  const m = trimmed.match(PROJECT_CMD_RE);
  if (!m) return null;
  const action = m[1] ?? "";
  const mapped =
    action === "check" ||
    action === "clippy" ||
    action === "vet" ||
    action === "fmt" ||
    action === "format"
      ? "lint"
      : action;
  if (["lint", "test", "typecheck", "build"].includes(mapped)) {
    return `Command succeeded. Next time use project(action: "${mapped}") — it auto-detects the toolchain, results are structured, and output is visible in the UI.`;
  }
  return null;
}

const SHELL_DESCRIPTION =
  "[TIER-2] Shell command execution. Use for git operations, package installs, system commands. " +
  "Always use dedicated tools instead: read for reading files, soul_grep for searching code (dep param for node_modules/vendor), " +
  "navigate for definitions/types/references, list_dir for directory listings, project for typecheck/lint/test. " +
  "LIMITATIONS: Output truncated at 30000 chars. Use '&&' to chain commands, not newlines.";

export const shellTool = {
  name: "shell",
  description: SHELL_DESCRIPTION,
  execute: async (args: ShellArgs, abortSignal?: AbortSignal): Promise<ToolResult> => {
    const command = injectCoAuthor(args.command);
    const cwd = args.cwd ?? process.cwd();

    const blocked = checkShellForbidden(command);
    if (blocked) {
      const msg = `Access denied: command references a file matching forbidden pattern "${blocked}".`;
      return { success: false, output: msg, error: msg };
    }

    const binaryErr = checkShellBinaryRead(command, cwd);
    if (binaryErr) return { success: false, output: binaryErr, error: binaryErr };

    if (GIT_COMMIT_MSG_RE.test(args.command)) {
      const lintErr = await runPreCommitChecks(cwd);
      if (lintErr) return { success: false, output: lintErr, error: lintErr };
    }
    const timeout = args.timeout ?? getToolTimeoutMs();

    return new Promise((resolve) => {
      const chunks: string[] = [];
      const errChunks: string[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      const proc = spawn("sh", ["-c", command], {
        cwd,
        timeout,
        env: buildSafeEnv(),
        ...SAFE_SPAWN_OPTS,
      });

      let cleanupAbortListener: (() => void) | undefined;
      if (abortSignal) {
        const onAbort = () => {
          try {
            proc.kill("SIGTERM");
          } catch {}
          setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {}
          }, 500);
        };
        if (abortSignal.aborted) {
          onAbort();
        } else {
          abortSignal.addEventListener("abort", onAbort, { once: true });
          cleanupAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
        }
      }

      proc.stdout?.on("data", (data: Buffer) => {
        stdoutBytes += data.length;
        if (stdoutBytes <= MAX_COLLECT_BYTES) chunks.push(data.toString());
      });
      proc.stderr?.on("data", (data: Buffer) => {
        stderrBytes += data.length;
        if (stderrBytes <= MAX_COLLECT_BYTES) errChunks.push(data.toString());
      });

      proc.on("close", async (code: number | null) => {
        cleanupAbortListener?.();
        let raw = sanitizeOutput(chunks.join(""));
        if (stdoutBytes > MAX_COLLECT_BYTES) {
          raw += `\n[output truncated — ${String(Math.round(stdoutBytes / 1024))}KB total, showing first ${String(Math.round(MAX_COLLECT_BYTES / 1024))}KB]`;
        }
        let compressed: { text: string; original: string | null };
        try {
          compressed = await getIOClient().compressShellOutputFull(raw);
        } catch {
          compressed = compressLocal(raw);
        }
        let stdout = compressed.text;
        const stderr = sanitizeOutput(errChunks.join(""));

        if (compressed.original) {
          const teeFile = await saveTee("shell-full", compressed.original);
          stdout += `\n[full output: ${teeFile}]`;
        }

        if (stdout.length > MAX_OUTPUT_BYTES) {
          const { text } = await truncateWithTee(stdout, MAX_OUTPUT_BYTES, 4000, 10000, "shell");
          stdout = text;
        }

        if (code === 0) {
          const hint = detectReadCommand(command) ?? detectProjectCommand(command);
          const output = hint ? `${stdout || stderr}\n\n${hint}` : stdout || stderr;
          resolve({ success: true, output });
        } else if (code === null) {
          resolve({
            success: false,
            output: stdout || stderr,
            error: `Command timed out after ${String(timeout / 1000)}s`,
          });
        } else {
          resolve({
            success: false,
            output: stdout,
            error: stderr || `Exit code: ${code}`,
          });
        }
      });

      proc.on("error", (err: Error) => {
        resolve({ success: false, output: err.message, error: err.message });
      });
    });
  },
};
