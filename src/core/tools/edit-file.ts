import { mkdir, readFile, stat as statAsync, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolResult } from "../../types";
import { analyzeFile } from "../analysis/complexity";
import { markToolWrite, reloadBuffer } from "../editor/instance";
import { memoryHintComposite } from "../memory/hints.js";
import { isForbidden } from "../security/forbidden.js";
import { displayPath } from "../utils/path-display.js";
import { pushEdit } from "./edit-stack.js";
import { emitFileEdited } from "./file-events.js";
import {
  appendAutoFormatResult,
  appendCloneHints,
  appendPostEditDiagnostics,
  countOccurrences,
  startPreEditDiagnostics,
} from "./post-edit-helpers.js";
import { consumeAstEditNudge } from "./ts-project-detect.js";

interface EditFileArgs {
  path: string;
  oldString: string;
  newString: string;
  lineStart?: number;
  tabId?: string;
}

/** @internal — exported for testing only */
export function formatMetricDelta(label: string, before: number, after: number): string {
  const delta = after - before;
  if (delta === 0) return "";
  const sign = delta > 0 ? "+" : "";
  return `${label}: ${String(before)}→${String(after)} (${sign}${String(delta)})`;
}

/**
 * When exact match fails, try normalizing leading whitespace (tabs↔spaces).
 * Returns the corrected oldStr/newStr with the file's actual indentation,
 * or null if no match is possible.
 */
export function buildRichEditError(
  content: string,
  oldStr: string,
  lineHint?: number,
): { output: string } {
  const lines = content.split("\n");
  const center = lineHint ? Math.min(lineHint - 1, lines.length - 1) : Math.floor(lines.length / 2);
  const start = Math.max(0, center - 5);
  const end = Math.min(lines.length, center + 6);
  const snippet = lines
    .slice(start, end)
    .map((l, i) => `${String(start + i + 1).padStart(4)} │ ${l}`)
    .join("\n");
  // Detect escape-heavy content — likely JSON escaping corruption
  const backslashDensity = (oldStr.match(/\\/g) || []).length / Math.max(oldStr.length, 1);
  const escapeHint =
    backslashDensity > 0.05
      ? "\n[Escape-heavy content detected — use lineStart for line-based replacement, or use editor(action: edit, startLine, endLine, replacement)]"
      : "";
  return {
    output: `old_string not found in file. Current content at that region:\n${snippet}${escapeHint}`,
  };
}

export function fuzzyWhitespaceMatch(
  content: string,
  oldStr: string,
  newStr: string,
): { oldStr: string; newStr: string } | null {
  const contentLines = content.split("\n");
  const oldLines = oldStr.split("\n");
  if (oldLines.length === 0) return null;

  // Try progressively looser normalization: whitespace-only, then escape-aware
  for (const normalize of [
    // Level 1: whitespace normalization only
    (line: string) => line.replace(/^[\t ]+/, "").trimEnd(),
    // Level 2: also normalize escape sequences (handles JSON double-escape corruption)
    (line: string) =>
      line
        .replace(/^[\t ]+/, "")
        .trimEnd()
        .replace(/\\{2,}/g, "\\") // collapse multiple backslashes
        .replace(/\\([[\](){}|.*+?^$])/g, "$1"), // unescape regex metacharacters
    // Level 3: strip ALL spurious backslash escapes from LLM markdown corruption.
    // After JSON parsing, only standard escapes survive (\n, \t, \r, \\, \", \/).
    // Anything else (\`, \#, \', \@, \~, \!, etc.) is LLM corruption.
    // We strip \X where X is not an alphanumeric char or standard escape target —
    // this covers every language without maintaining a character list.
    (line: string) =>
      line
        .replace(/^[\t ]+/, "")
        .trimEnd()
        .replace(/\\{2,}/g, "\\")
        .replace(/\\([^nrtbfuU0-9a-zA-Z\\])/g, "$1"),
  ]) {
    const normalizedOld = oldLines.map(normalize);

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      let match = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (normalize(contentLines[i + j] as string) !== normalizedOld[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        const actualOld = contentLines.slice(i, i + oldLines.length).join("\n");
        if (content.split(actualOld).length - 1 !== 1) continue;

        const correctedNew = correctIndentation(oldLines, contentLines, i, newStr);
        return { oldStr: actualOld, newStr: correctedNew };
      }
    }
  }
  return null;
}

function correctIndentation(
  oldLines: string[],
  contentLines: string[],
  matchStart: number,
  newStr: string,
): string {
  const newLines = newStr.split("\n");
  let lastOldIndent = "";
  let lastActualIndent = "";
  return newLines
    .map((newLine, idx) => {
      const oldLine = oldLines[idx];
      if (!oldLine) {
        // NEW line beyond oldStr — apply the last known indent delta
        if (lastOldIndent !== lastActualIndent) {
          const newIndent = newLine.match(/^[\t ]*/)?.[0] ?? "";
          if (newIndent.startsWith(lastOldIndent)) {
            return lastActualIndent + newLine.slice(lastOldIndent.length);
          }
        }
        return newLine;
      }
      const oldIndent = oldLine.match(/^[\t ]*/)?.[0] ?? "";
      const actualLine = contentLines[matchStart + idx] as string;
      const actualIndent = actualLine.match(/^[\t ]*/)?.[0] ?? "";
      lastOldIndent = oldIndent;
      lastActualIndent = actualIndent;
      if (oldIndent === actualIndent) return newLine;
      const newIndent = newLine.match(/^[\t ]*/)?.[0] ?? "";
      if (newIndent === oldIndent) {
        return actualIndent + newLine.slice(oldIndent.length);
      }
      return newLine;
    })
    .join("\n");
}

async function applyEdit(
  filePath: string,
  content: string,
  updated: string,
  editLine: number,
  label: string,
  tabId?: string,
): Promise<ToolResult> {
  const beforeMetrics = analyzeFile(content);
  const afterMetrics = analyzeFile(updated);

  const diagsPromise = startPreEditDiagnostics(filePath);

  // CAS: verify file hasn't been modified since we read it (prevents concurrent edit races)
  const currentOnDisk = await readFile(filePath, "utf-8");
  if (currentOnDisk !== content) {
    const msg = "File was modified concurrently since last read. Re-read and retry.";
    return { success: false, output: msg, error: "concurrent modification" };
  }

  // Write file immediately — don't wait for diagnostics
  pushEdit(filePath, content, updated, tabId);
  await writeFile(filePath, updated, "utf-8");
  markToolWrite(filePath);
  emitFileEdited(filePath, updated);

  // Fire-and-forget: reload the nvim buffer (don't block tool result)
  reloadBuffer(filePath, editLine).catch(() => {});

  const deltas = [
    formatMetricDelta("lines", beforeMetrics.lineCount, afterMetrics.lineCount),
    formatMetricDelta("imports", beforeMetrics.importCount, afterMetrics.importCount),
  ].filter(Boolean);

  let output = `Edited ${displayPath(filePath)}${label}`;
  if (deltas.length > 0) output += ` (${deltas.join(", ")})`;

  output = await appendAutoFormatResult(filePath, updated, output, tabId);
  output = await appendPostEditDiagnostics(diagsPromise, filePath, output);
  output = await appendCloneHints(filePath, output);

  const nudge = await consumeAstEditNudge(filePath);
  if (nudge) output += `\n${nudge}`;

  output += memoryHintComposite({
    paths: [toRelEditPath(filePath)],
    context: "edit",
    tabId,
  });

  return { success: true, output };
}

function resolveLineRange(
  content: string,
  oldStr: string,
  lineStart: number,
): { start: number; end: number } | null {
  const lines = content.split("\n");
  const oldLineCount = oldStr.split("\n").length;
  const start = lineStart - 1;
  const end = start + oldLineCount;
  if (start < 0 || start >= lines.length || end > lines.length || start >= end) return null;
  return { start, end };
}

export const editFileTool = {
  name: "edit_file",
  description:
    "Edit a non-TS/JS file by replacing content (JSON, YAML, Markdown, config, raw text). For .ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs files use ast_edit — it's safer and won't drift. " +
    "Read first, then provide path, oldString, newString. " +
    "Provide lineStart (1-indexed from read output) for reliable line-anchored matching — the range is derived from oldString line count. Without lineStart, falls back to string matching (fails if ambiguous). " +
    "Keep oldString minimal and unique in the file — don't pad with large unchanged regions just to anchor a small change. " +
    "Empty oldString creates a new file. Use multi_edit for multiple changes to the same file. " +
    "Edits are applied immediately.",
  execute: async (args: EditFileArgs): Promise<ToolResult> => {
    try {
      const filePath = resolve(args.path);

      const blocked = isForbidden(filePath);
      if (blocked) {
        const msg = `Access denied: "${args.path}" matches forbidden pattern "${blocked}". This file is blocked for security.`;
        return { success: false, output: msg, error: msg };
      }

      const oldStr = args.oldString;
      const newStr = args.newString;

      // Create new file
      if (oldStr === "") {
        const dir = dirname(filePath);
        let dirCreated = false;
        try {
          await statAsync(dir);
        } catch {
          dirCreated = true;
        }
        await mkdir(dir, { recursive: true });
        await writeFile(filePath, newStr, "utf-8");
        markToolWrite(filePath);
        emitFileEdited(filePath, newStr);
        const openedInEditor = await reloadBuffer(filePath);
        const metrics = analyzeFile(newStr);
        let out = `Created ${displayPath(filePath)} (lines: ${String(metrics.lineCount)}, imports: ${String(metrics.importCount)})`;
        if (dirCreated) out += ` [directory created: ${dir}]`;
        if (openedInEditor) out += " → opened in editor";
        out = await appendCloneHints(filePath, out);
        out += memoryHintComposite({
          paths: [toRelEditPath(filePath)],
          context: "edit",
          tabId: args.tabId,
        });
        return { success: true, output: out };
      }

      try {
        await statAsync(filePath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        const msg =
          code === "EACCES" || code === "EPERM"
            ? `Permission denied: ${filePath}`
            : `File not found: ${filePath}`;
        return { success: false, output: msg, error: msg };
      }

      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");

      // ═══════════════════════════════════════════════════════════════
      // PRIMARY PATH: line-based editing (when lineStart is provided)
      // Line numbers are AUTHORITATIVE — oldString is verification only.
      // This prevents edits landing at the wrong location when oldString
      // matches multiple places in the file.
      // ═══════════════════════════════════════════════════════════════
      if (args.lineStart != null) {
        const range = resolveLineRange(content, oldStr, args.lineStart);
        if (range) {
          const replacedLines = lines.slice(range.start, range.end);
          const newLines = newStr.split("\n");

          // Safety: don't delete large blocks with empty/whitespace-only replacement
          if (replacedLines.length > 10 && newStr.trim() === "") {
            return {
              success: false,
              output: `Refusing to delete ${String(replacedLines.length)} lines with empty replacement.`,
              error: "safety: empty replacement for large range",
            };
          }

          // Verify oldString matches the line range content (warn if mismatch)
          const rangeContent = replacedLines.join("\n");
          const label = ` (lines ${String(args.lineStart)}-${String(range.end)})`;

          // If oldString exactly matches the range, great — high confidence edit
          if (rangeContent === oldStr) {
            const before = lines.slice(0, range.start);
            const after = lines.slice(range.end);
            const updated = [...before, ...newLines, ...after].join("\n");
            return applyEdit(filePath, content, updated, args.lineStart, label, args.tabId);
          }

          // Try fuzzy match against the range content
          const rangeFixed = fuzzyWhitespaceMatch(rangeContent, oldStr, newStr);
          if (rangeFixed) {
            const before = lines.slice(0, range.start);
            const after = lines.slice(range.end);
            const updated = [...before, ...rangeFixed.newStr.split("\n"), ...after].join("\n");
            return applyEdit(filePath, content, updated, args.lineStart, label, args.tabId);
          }

          // oldString doesn't match the range — FAIL instead of blindly applying.
          // Applying by stale line numbers after formatting causes corruption.
          const rangeSnippet = lines
            .slice(range.start, range.end)
            .map((l, i) => `${String(range.start + i + 1).padStart(4)} │ ${l}`)
            .join("\n");
          return {
            success: false,
            output: `oldString does not match lines ${String(args.lineStart)}-${String(range.end)}. Actual content at those lines:\n${rangeSnippet}\nRe-read the file and retry with the correct content.`,
            error: "oldString mismatch at line range",
          };
        }

        // Line range invalid — fall back to string match as last resort
        if (content.includes(oldStr)) {
          const occurrences = countOccurrences(content, oldStr);
          if (occurrences === 1) {
            const matchIdx = content.indexOf(oldStr);
            const matchLine = content.slice(0, matchIdx).split("\n").length;
            const updated =
              content.slice(0, matchIdx) + newStr + content.slice(matchIdx + oldStr.length);
            return applyEdit(
              filePath,
              content,
              updated,
              matchLine,
              " [line range invalid, used string match]",
              args.tabId,
            );
          }
        }

        return {
          success: false,
          output: `Invalid line range: ${String(args.lineStart)} (file has ${String(lines.length)} lines)`,
          error: "invalid line range",
        };
      }

      // ═══════════════════════════════════════════════════════════════
      // FALLBACK PATH: string-based editing (no lineStart provided)
      // Uses exact match → fuzzy whitespace → fuzzy escape → error
      // ═══════════════════════════════════════════════════════════════
      let resolvedOld = oldStr;
      let resolvedNew = newStr;

      if (!content.includes(oldStr)) {
        const fixed = fuzzyWhitespaceMatch(content, oldStr, newStr);
        if (fixed) {
          resolvedOld = fixed.oldStr;
          resolvedNew = fixed.newStr;
        } else {
          const rich = buildRichEditError(content, oldStr, args.lineStart);
          return { success: false, output: rich.output, error: "old_string not found" };
        }
      }

      const occurrences = countOccurrences(content, resolvedOld);
      if (occurrences > 1) {
        const msg = `Found ${String(occurrences)} matches. Provide more context or use lineStart to disambiguate.`;
        return { success: false, output: msg, error: msg };
      }

      const matchIdx = content.indexOf(resolvedOld);
      const editLine = matchIdx >= 0 ? content.slice(0, matchIdx).split("\n").length : 1;
      const updated =
        content.slice(0, matchIdx) + resolvedNew + content.slice(matchIdx + resolvedOld.length);
      const result = await applyEdit(filePath, content, updated, editLine, "", args.tabId);
      if (result.success) {
        result.output +=
          "\n! lineStart not provided — pass lineStart from read output to make edits escape-proof.";
      }
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};
function toRelEditPath(abs: string): string {
  const cwd = process.cwd();
  return abs.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1) : abs;
}
