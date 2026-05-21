import { access, stat as statAsync } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { isBinaryFile } from "isbinaryfile";
import type { ToolResult } from "../../types";
import { readBufferContent } from "../editor/instance";
import { getIntelligenceClient } from "../intelligence/index.js";
import type { SymbolKind } from "../intelligence/types.js";
import { memoryHintForPaths } from "../memory/hints.js";
import { isForbidden } from "../security/forbidden.js";
import { getIOClient, type ReadFileResult } from "../workers/io-client.js";
import { binaryHint } from "./binary-detect.js";
import { emitFileRead } from "./file-events.js";

function toRelPath(abs: string): string {
  const cwd = process.cwd();
  return abs.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1) : abs;
}

type ReadTarget = string;

interface ReadFileArgs {
  path: string;
  startLine?: number;
  endLine?: number;
  target?: ReadTarget;
  name?: string;
  tabId?: string;
}

const MAX_READ_LINES = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_READ_SIZE = 250 * 1024;
const SMART_TRUNCATE_LINES = 200;

/**
 * Build an outline of symbols beyond the truncation point.
 * Uses repo map symbol data (cached in SQLite, zero I/O).
 */
async function buildSymbolOutline(
  filePath: string,
  cutoffLine: number,
  totalLines: number,
  symbolName?: string,
): Promise<string> {
  try {
    const client = getIntelligenceClient();
    if (!client) return "";
    const cwd = process.cwd();
    const rel = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
    const symbols = await client.getFileSymbolRanges(rel);

    const parts: string[] = [];

    // Callees: if we know the symbol name, show what it calls (from calls table)
    if (symbolName) {
      try {
        const callees = await client.getCalleesForSymbol(rel, symbolName);
        if (callees && callees.length > 0) {
          const top = callees.slice(0, 10).map((c) => c.calleeName);
          const remaining = callees.length - top.length;
          const suffix = remaining > 0 ? `, +${String(remaining)} more` : "";
          parts.push(`Calls: ${top.join(", ")}${suffix}`);
        }
      } catch {}
    }

    // Symbols beyond the cutoff
    if (symbols && symbols.length > 0) {
      const beyond = symbols.filter((s) => s.line > cutoffLine);
      if (beyond.length > 0) {
        parts.push(
          `Symbols below:\n${beyond
            .map((s) => {
              const range = s.endLine
                ? `:${String(s.line)}-${String(s.endLine)}`
                : `:${String(s.line)}`;
              const label = s.qualifiedName ?? s.name;
              return `  ${range} ${s.kind} ${label}`;
            })
            .join("\n")}`,
        );
      }
    }

    if (parts.length === 0) return "";

    parts.push("Use ranges:[{start:N, end:M}] to read specific sections.");
    return `\n... ${String(totalLines - cutoffLine)} more lines.\n${parts.join("\n")}`;
  } catch {
    return `\n... ${String(totalLines - cutoffLine)} more lines. Use ranges to read specific sections.`;
  }
}

/**
 * Offload the heavy read path (stat, binary check, read, line-number) to the
 * IO worker thread so parallel tool calls don't block the UI event loop.
 */
async function readViaWorker(filePath: string, args: ReadFileArgs): Promise<ToolResult> {
  let result: ReadFileResult;
  try {
    result = await getIOClient().readFileNumbered(filePath, args.startLine, args.endLine);
  } catch {
    // Worker unavailable (crashed / not started) — fall back to main-thread read
    return readOnMainThread(filePath, args);
  }

  if ("error" in result) {
    switch (result.error) {
      case "directory": {
        const msg = `Path is a directory: ${filePath}`;
        return { success: false, output: msg, error: msg };
      }
      case "binary": {
        const hint = binaryHint(result.ext);
        const msg = `Cannot read binary file: "${args.path}" (${result.ext || "no extension"}, ${result.sizeStr}).${hint}`;
        return { success: false, output: msg, error: "binary" };
      }
      case "too_large": {
        const msg = `File too large (${result.sizeStr}). Maximum is ${String(MAX_READ_SIZE / 1024)}KB. Use ranges:[{start:N, end:M}] to read a specific section.`;
        return { success: false, output: msg, error: "file too large" };
      }
      case "not_found": {
        return { success: false, output: result.message, error: result.message };
      }
    }
  }

  emitFileRead(filePath);

  const lineCount = result.numbered.split("\n").length;
  const isRangeRead = args.startLine != null || args.endLine != null;

  const tail = memoryHintForPaths([toRelPath(filePath)], "read", args.tabId);

  if (!isRangeRead && lineCount > SMART_TRUNCATE_LINES) {
    const cutoffLine = result.start + SMART_TRUNCATE_LINES;
    const outline = await buildSymbolOutline(filePath, cutoffLine, result.totalLines);
    if (outline) {
      const truncatedLines = result.numbered.split("\n").slice(0, SMART_TRUNCATE_LINES);
      return {
        success: true,
        output: `${truncatedLines.join("\n")}${outline}${tail}`,
      };
    }
  }

  let output = result.numbered;
  if (result.truncated) {
    const outline = await buildSymbolOutline(
      filePath,
      result.start + MAX_READ_LINES,
      result.totalLines,
    );
    const nextOffset = result.start + MAX_READ_LINES + 1;
    const remaining = result.totalLines - result.start - MAX_READ_LINES;
    output +=
      outline ||
      `\n... ${String(remaining)} more lines. Use ranges:[{start:${String(nextOffset)}, end:N}] to continue.`;
  }
  return { success: true, output: `${output}${tail}` };
}

/** Main-thread fallback — used for symbol reads and when worker is unavailable. */
async function readOnMainThread(filePath: string, args: ReadFileArgs): Promise<ToolResult> {
  let fileStat: Awaited<ReturnType<typeof statAsync>>;
  try {
    fileStat = await statAsync(filePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    const msg =
      code === "EACCES" || code === "EPERM"
        ? `Permission denied: ${filePath}`
        : `File not found: ${filePath}`;
    return { success: false, output: msg, error: msg };
  }

  if (fileStat.isDirectory()) {
    return {
      success: false,
      output: `Path is a directory: ${filePath}`,
      error: `Path is a directory: ${filePath}`,
    };
  }

  if (await isBinaryFile(filePath)) {
    const ext = extname(filePath).toLowerCase();
    const sizeStr =
      fileStat.size > 1024 * 1024
        ? `${(fileStat.size / (1024 * 1024)).toFixed(1)}MB`
        : `${(fileStat.size / 1024).toFixed(0)}KB`;
    const hint = binaryHint(ext);
    return {
      success: false,
      output: `Cannot read binary file: "${args.path}" (${ext || "no extension"}, ${sizeStr}).${hint}`,
      error: "binary",
    };
  }

  if (fileStat.size > MAX_READ_SIZE) {
    const sizeStr =
      fileStat.size > 1024 * 1024
        ? `${(fileStat.size / (1024 * 1024)).toFixed(1)}MB`
        : `${String(Math.round(fileStat.size / 1024))}KB`;
    return {
      success: false,
      output: `File too large (${sizeStr}). Maximum is ${String(MAX_READ_SIZE / 1024)}KB. Use ranges:[{start:N, end:M}] to read a specific section.`,
      error: "file too large",
    };
  }

  const content = await readBufferContent(filePath);
  const lines = content.split("\n");

  const start = (args.startLine ?? 1) - 1;
  const end = args.endLine ?? lines.length;
  let slice = lines.slice(start, end);

  const totalLines = lines.length;
  const truncated = slice.length > MAX_READ_LINES;
  if (truncated) slice = slice.slice(0, MAX_READ_LINES);

  const numbered = slice
    .map((line: string, i: number) => {
      const l = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...` : line;
      return `${String(start + i + 1).padStart(4)}  ${l}`;
    })
    .join("\n");

  emitFileRead(filePath);

  let output = numbered;
  if (truncated) {
    output += `\n\n(File has ${String(totalLines)} lines. Showing first ${String(MAX_READ_LINES)}. Use ranges:[{start:${String(start + MAX_READ_LINES)}, end:N}] to continue.)`;
  }
  output += memoryHintForPaths([toRelPath(filePath)], "read", args.tabId);

  return { success: true, output };
}

export const readFileTool = {
  name: "read",
  description:
    "[TIER-1] Read files. Pass files array: files=[{path:'a.ts'}, {path:'b.ts', ranges:[{start:10,end:50}]}]. " +
    "Ranges go INSIDE each file object. Omit ranges for full file. " +
    "AST extraction: {path:'c.ts', target:'function', name:'foo'}. All reads run in parallel. " +
    "For context around a range, widen start/end (e.g. start-10, end+10). " +
    "To find call sites, use navigate(references) instead. Skip re-reads.",
  execute: async (args: ReadFileArgs): Promise<ToolResult> => {
    try {
      const filePath = resolve(args.path);

      if (args.target) {
        return readSymbolFromFile(filePath, args);
      }

      const blocked = isForbidden(filePath);
      if (blocked) {
        const msg = `Access denied: "${args.path}" matches forbidden pattern "${blocked}". This file is blocked for security.`;
        return { success: false, output: msg, error: msg };
      }

      // Offload heavy I/O (stat, binary check, read, line-number) to worker thread.
      // Security checks (isForbidden) must stay on main thread — they use in-memory state.
      // Symbol reads (target) also stay on main thread — they need the intelligence router.
      return await readViaWorker(filePath, args);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};

async function readSymbolFromFile(filePath: string, args: ReadFileArgs): Promise<ToolResult> {
  const blocked = isForbidden(filePath);
  if (blocked) {
    return {
      success: false,
      output: `Access denied: "${filePath}" matches forbidden pattern "${blocked}"`,
      error: "forbidden",
    };
  }

  try {
    await access(filePath);
  } catch {
    return {
      success: false,
      output: `File not found: ${filePath}`,
      error: "not_found",
    };
  }

  const client = getIntelligenceClient();
  let language: import("../intelligence/types.js").Language;
  if (client) {
    language = await client.routerDetectLanguage(filePath);
  } else {
    const { getIntelligenceRouter } = await import("../intelligence/index.js");
    const router = getIntelligenceRouter(process.cwd());
    language = router.detectLanguage(filePath);
  }

  // readScope/readSymbol have no client proxy — use router directly
  const { getIntelligenceRouter } = await import("../intelligence/index.js");
  const router = getIntelligenceRouter(process.cwd());

  if (args.target === "scope") {
    const scopeStart = args.startLine;
    if (!scopeStart) {
      return {
        success: false,
        output: "startLine is required for scope",
        error: "missing startLine",
      };
    }
    const tracked = await router.executeWithFallbackTracked(language, "readScope", (b) =>
      b.readScope ? b.readScope(filePath, scopeStart, args.endLine) : Promise.resolve(null),
    );
    if (!tracked) {
      return { success: false, output: "Could not read scope", error: "failed" };
    }
    const block = tracked.value;
    const range = block.location.endLine
      ? `${String(block.location.line)}-${String(block.location.endLine)}`
      : String(block.location.line);
    emitFileRead(filePath);
    return {
      success: true,
      output: `${filePath}:${range}\n\n${block.content}`,
      backend: tracked.backend,
    };
  }

  const name = args.name;
  if (!name) {
    return {
      success: false,
      output: `name is required for target '${args.target}'`,
      error: "missing name",
    };
  }

  const kindMap: Record<string, SymbolKind> = {
    function: "function",
    class: "class",
    type: "type",
    interface: "interface",
    variable: "variable",
    enum: "enum",
  };

  const targetKind = kindMap[args.target as string];
  let tracked = await router.executeWithFallbackTracked(language, "readSymbol", (b) =>
    b.readSymbol ? b.readSymbol(filePath, name, targetKind) : Promise.resolve(null),
  );

  if (!tracked) {
    tracked = await router.executeWithFallbackTracked(language, "readSymbol", (b) =>
      b.readSymbol ? b.readSymbol(filePath, name) : Promise.resolve(null),
    );
  }

  if (!tracked) {
    return { success: false, output: `'${name}' not found in ${filePath}`, error: "not found" };
  }

  const block = tracked.value;
  const range = block.location.endLine
    ? `${String(block.location.line)}-${String(block.location.endLine)}`
    : String(block.location.line);
  const header = block.symbolKind ? `${block.symbolKind} ${block.symbolName ?? name}` : name;
  emitFileRead(filePath);

  const contentLines = block.content.split("\n");
  if (contentLines.length > SMART_TRUNCATE_LINES) {
    const truncated = contentLines.slice(0, SMART_TRUNCATE_LINES).join("\n");
    const symbolStart = block.location.line;
    const cutoffLine = symbolStart + SMART_TRUNCATE_LINES;
    const totalSymbolLines = contentLines.length;
    const remaining = totalSymbolLines - SMART_TRUNCATE_LINES;
    // Try file-level outline first (works for top-level symbols)
    const outline = await buildSymbolOutline(
      filePath,
      cutoffLine,
      block.location.endLine ?? symbolStart + totalSymbolLines,
      name,
    );
    // If no outline (symbol is a large function with nested locals), suggest analyze(outline)
    const suffix =
      outline ||
      `\n... ${String(remaining)} more lines. Use analyze(action:'outline', file:'${filePath}') for nested symbols, or ranges:[{start:N, end:M}] for specific sections.`;
    return {
      success: true,
      output: `${header} — ${filePath}:${range} (${String(totalSymbolLines)} lines, showing first ${String(SMART_TRUNCATE_LINES)})\n\n${truncated}${suffix}`,
      backend: tracked.backend,
    };
  }

  return {
    success: true,
    output: `${header} — ${filePath}:${range}\n\n${block.content}`,
    backend: tracked.backend,
  };
}
