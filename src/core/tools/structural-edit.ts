import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getCwd } from "../cwd.js";
import { findOnPath, IS_WIN } from "../platform/index.js";
import { isForbidden } from "../security/forbidden.js";
import { getVendoredPath } from "../setup/install.js";

const EXE = IS_WIN ? ".exe" : "";
const RUN_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 32_000;

/**
 * ast-grep `--lang` value per file extension. TS/JS are intentionally absent —
 * those route to `ast_edit` (ts-morph, type-aware). This tool fills the gap for
 * the polyglot, non-TS languages where the only alternative was fragile
 * text-matching via multi_edit.
 */
const EXT_TO_LANG: Record<string, string> = {
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".scala": "scala",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".lua": "lua",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
};

const TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

/**
 * Resolve the ast-grep binary across platforms.
 *
 * Resolution order:
 *  1. Vendored binary in ~/.soulforge/bin (installed by the prerequisite
 *     pipeline — the always-available production source, same as rg/fd/nvim).
 *  2. node_modules — dev mode. `.bin` entries differ by OS: a bare symlink on
 *     POSIX, npm `.cmd`/`.ps1` shims on Windows (never `.exe`); also the native
 *     per-platform package.
 *  3. PATH — user-installed system binary.
 *
 * Returns null only when ast-grep is genuinely unavailable everywhere.
 */
function resolveAstGrep(cwd: string): string | null {
  // 1. Vendored — present in every production install once prerequisites run.
  const vendored = getVendoredPath("ast-grep");
  if (vendored) return vendored;

  // 2. node_modules (dev). On Windows npm writes `ast-grep.cmd` (+ `.ps1`).
  const binDir = join(cwd, "node_modules", ".bin");
  const localCandidates = IS_WIN
    ? ["ast-grep.cmd", "ast-grep.exe", "ast-grep.ps1", "ast-grep", "sg.cmd", "sg.exe", "sg"]
    : ["ast-grep", "sg"];
  for (const name of localCandidates) {
    const candidate = join(binDir, name);
    if (existsSync(candidate)) return candidate;
  }
  const nativeDir = join(cwd, "node_modules", "@ast-grep", "cli");
  for (const name of [`ast-grep${EXE}`, `sg${EXE}`]) {
    const candidate = join(nativeDir, name);
    if (existsSync(candidate)) return candidate;
  }

  // 3. PATH.
  return findOnPath("ast-grep") ?? findOnPath("sg") ?? null;
}

const MISSING_HINT =
  "ast-grep is not yet available. SoulForge auto-installs it on startup (vendored into " +
  "~/.soulforge/bin); this usually means the first-run download hasn't completed or failed " +
  "(e.g. offline). Restart to retry, or install manually (`brew install ast-grep` / " +
  "`cargo install ast-grep`). For TS/JS use ast_edit — type-aware, no external binary needed.";

interface StructuralEditArgs {
  file: string;
  pattern: string;
  rewrite: string;
  lang?: string;
  preview?: boolean;
}

function runAstGrep(bin: string, cliArgs: string[], cwd: string): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    const proc = spawn(bin, cliArgs, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);

    proc.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString();
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise({
        success: false,
        output: `ast-grep failed to start: ${e.message}`,
        error: "spawn",
      });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        resolvePromise({ success: false, output: "ast-grep timed out", error: "timeout" });
        return;
      }
      if (code !== 0) {
        resolvePromise({
          success: false,
          output: stderr.trim() || stdout.trim() || `ast-grep exited with code ${String(code)}`,
          error: "ast-grep",
        });
        return;
      }
      resolvePromise({ success: true, output: (stdout || stderr).trim() || "No matches." });
    });
  });
}

export const structuralEditTool = {
  name: "structural_edit",
  description:
    "[TIER-2] Polyglot AST-aware structural find/replace via ast-grep — for non-TS/JS files " +
    "(Python, Go, Rust, Java, C/C++, Ruby, PHP, etc). Pattern + rewrite use meta-variables ($X, $$$ARGS) " +
    "matched against the syntax tree, not text — robust to whitespace/formatting. For .ts/.tsx/.js/.jsx " +
    "use ast_edit instead (type-aware ts-morph). Set preview=true to see the diff without writing.",
  execute: async (args: StructuralEditArgs): Promise<ToolResult> => {
    const cwd = getCwd();
    const abs = resolve(cwd, args.file);

    const forbidden = isForbidden(abs);
    if (forbidden) {
      return {
        success: false,
        output: `Refusing to edit forbidden path: ${forbidden}`,
        error: "forbidden",
      };
    }
    if (!existsSync(abs)) {
      return { success: false, output: `File not found: ${args.file}`, error: "not found" };
    }

    const ext = extname(abs).toLowerCase();
    if (TS_JS_EXTS.has(ext)) {
      return {
        success: false,
        output: `${args.file} is TypeScript/JavaScript — use ast_edit (type-aware ts-morph), not structural_edit.`,
        error: "wrong tool",
      };
    }

    const lang = args.lang ?? EXT_TO_LANG[ext];
    if (!lang) {
      return {
        success: false,
        output: `Unsupported file type "${ext}" for structural_edit. Pass an explicit lang, or use multi_edit for raw text.`,
        error: "unsupported",
      };
    }

    const bin = resolveAstGrep(cwd);
    if (!bin) {
      return { success: false, output: MISSING_HINT, error: "missing-binary" };
    }

    const cliArgs = ["run", "--pattern", args.pattern, "--rewrite", args.rewrite, "--lang", lang];
    if (!args.preview) cliArgs.push("--update-all");
    cliArgs.push(abs);

    return runAstGrep(bin, cliArgs, cwd);
  },
};
