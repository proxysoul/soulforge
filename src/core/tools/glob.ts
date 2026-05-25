import { spawn } from "node:child_process";
import type { ToolResult } from "../../types";
import { commandExists, IS_WIN } from "../platform/index.js";
import { isForbidden } from "../security/forbidden.js";

interface GlobArgs {
  pattern: string;
  path?: string;
}

let _fdBin: string | null | undefined;
let _fdBinPromise: Promise<string | null> | undefined;
function getFdBin(): Promise<string | null> {
  if (_fdBin !== undefined) return Promise.resolve(_fdBin);
  if (_fdBinPromise) return _fdBinPromise;
  _fdBinPromise = (async () => {
    for (const bin of ["fd", "fdfind"]) {
      if (commandExists(bin)) {
        _fdBin = bin;
        return bin;
      }
    }
    _fdBin = null;
    return null;
  })();
  return _fdBinPromise;
}

function runFd(bin: string, pattern: string, basePath: string): Promise<ToolResult | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      bin,
      ["--glob", pattern, basePath, "--max-results", "50", "--max-depth", "8"],
      {
        cwd: process.cwd(),
        timeout: 10_000,
      },
    );
    const chunks: string[] = [];
    proc.stdout.on("data", (data: Buffer) => chunks.push(data.toString()));
    proc.on("error", () => resolve(null));
    proc.on("close", (code: number | null) => {
      if (code === 0) {
        resolve({ success: true, output: chunks.join("") || "No files found." });
      } else {
        resolve(null);
      }
    });
  });
}

function runFind(pattern: string, basePath: string): Promise<ToolResult> {
  return new Promise((resolve) => {
    // POSIX `find` is missing on Windows; the bundled PowerShell equivalent
    // (`Get-ChildItem -Recurse`) is slow and has different semantics. Surface
    // a clear, actionable error instead of spawning ENOENT.
    if (IS_WIN) {
      resolve({
        success: false,
        output: "",
        error:
          "Glob fallback unavailable on Windows: install `fd` (winget install sharkdp.fd) or use the `grep` tool with a path filter.",
      });
      return;
    }
    const proc = spawn("find", [basePath, "-name", pattern, "-maxdepth", "5"], {
      cwd: process.cwd(),
      timeout: 10_000,
    });
    const chunks: string[] = [];
    proc.stdout.on("data", (data: Buffer) => chunks.push(data.toString()));
    proc.on("error", () => resolve({ success: true, output: "No files found." }));
    proc.on("close", () => {
      resolve({ success: true, output: chunks.join("") || "No files found." });
    });
  });
}

function filterForbidden(result: ToolResult): ToolResult {
  if (!result.success || result.output === "No files found.") return result;
  const filtered = result.output
    .split("\n")
    .filter((line) => !line.trim() || isForbidden(line.trim()) === null)
    .join("\n");
  return { ...result, output: filtered || "No files found." };
}

export const globTool = {
  name: "glob",
  description:
    "[TIER-2] File pattern matching — use soul_find first for fuzzy search. " +
    "Glob patterns: '**/*.ts', 'src/**/*.test.*'. Returns paths sorted by modification time. " +
    "LIMITATIONS: Max 100 files. Hidden files skipped.",
  execute: async (args: GlobArgs): Promise<ToolResult> => {
    const pattern = args.pattern;
    const basePath = args.path ?? ".";

    const fdBin = await getFdBin();
    if (fdBin) {
      const result = await runFd(fdBin, pattern, basePath);
      if (result) return filterForbidden(result);
    }
    return filterForbidden(await runFind(pattern, basePath));
  },
};
