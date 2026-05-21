import { readFile, stat as statAsync, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { analyzeFile } from "../analysis/complexity.js";
import { markToolWrite, reloadBuffer } from "../editor/instance.js";
import { memoryHintComposite } from "../memory/hints.js";
import { isForbidden } from "../security/forbidden.js";
import { displayPath } from "../utils/path-display.js";
import { buildRichEditError, fuzzyWhitespaceMatch } from "./edit-file.js";
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

interface EditEntry {
  oldString: string;
  newString: string;
  lineStart?: number;
}

interface MultiEditArgs {
  path: string;
  edits: EditEntry[];
  tabId?: string;
}

/**
 * Transactional multi-edit: reads file once, validates ALL edits upfront,
 * applies atomically, pushes one undo entry, runs diagnostics once.
 */
export const multiEditTool = {
  name: "multi_edit",
  description:
    "Apply multiple edits to a single non-TS/JS file atomically (JSON, YAML, Markdown, config, raw text). For TS/JS files use ast_edit with operations:[...] — safer and no line drift. " +
    "All-or-nothing: if any edit fails, ZERO edits are applied. lineStart values reference the ORIGINAL file (pre-edit) — the tool tracks cumulative line offsets internally. " +
    "Provide lineStart (1-indexed) for reliable line-anchored matching. Without it, falls back to string matching against evolved content. The range is derived from oldString line count. " +
    "Each oldString is matched against the ORIGINAL file content, not against the result of earlier edits in the batch — do not emit overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into ONE edit. " +
    "Keep each oldString minimal and unique. Don't pad with large unchanged regions just to span distant changes. " +
    "If the call atomically rolls back, re-read the file and retry ALL edits with fresh content.",
  execute: async (args: MultiEditArgs): Promise<ToolResult> => {
    try {
      const filePath = resolve(args.path);

      const blocked = isForbidden(filePath);
      if (blocked) {
        const msg = `Access denied: "${args.path}" matches forbidden pattern "${blocked}".`;
        return { success: false, output: msg, error: msg };
      }

      if (!args.edits || args.edits.length === 0) {
        const msg = "No edits provided. Pass an array of {oldString, newString} objects.";
        return { success: false, output: msg, error: msg };
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

      const originalContent = await readFile(filePath, "utf-8");
      let content = originalContent;

      // Phase 1: Validate and apply edits sequentially against evolving content.
      // Each edit sees the result of all prior edits — overlapping edits fail explicitly.
      // lineOffset tracks cumulative line count changes from prior edits so that
      // lineStart values (which reference the ORIGINAL file) stay accurate.
      // Sort edits top-to-bottom by lineStart so the cumulative offset is correct —
      // each edit only shifts lines below it. Edits without lineStart go last (string-match fallback).
      const sortedEdits = [...args.edits].sort((a, b) => {
        if (a.lineStart == null && b.lineStart == null) return 0;
        if (a.lineStart == null) return 1;
        if (b.lineStart == null) return -1;
        return a.lineStart - b.lineStart;
      });
      let lineOffset = 0;

      for (let i = 0; i < sortedEdits.length; i++) {
        const edit = sortedEdits[i];
        if (!edit) continue;
        const label = `Edit ${String(i + 1)}/${String(args.edits.length)}`;
        const adjustedLineStart = edit.lineStart != null ? edit.lineStart + lineOffset : undefined;
        const oldLineCount = edit.oldString.split("\n").length;
        const newLineCount = edit.newString.split("\n").length;

        // Helper: apply line-based replacement at a given range
        const applyLineReplace = (start: number, end: number, replacement?: string): boolean => {
          const lines = content.split("\n");
          if (start < 0 || end > lines.length || start >= end) return false;
          const before = lines.slice(0, start);
          const after = lines.slice(end);
          content = [...before, ...(replacement ?? edit.newString).split("\n"), ...after].join(
            "\n",
          );
          return true;
        };

        // ── PRIMARY: line-based editing (when lineStart is provided) ──
        // Line numbers are AUTHORITATIVE — oldString is verification only.
        if (adjustedLineStart != null) {
          const start = adjustedLineStart - 1;
          const end = start + oldLineCount;
          const lines = content.split("\n");

          if (start >= 0 && end <= lines.length && start < end) {
            const rangeContent = lines.slice(start, end).join("\n");

            // Exact match at range — high confidence
            if (rangeContent === edit.oldString) {
              applyLineReplace(start, end);
              lineOffset += newLineCount - oldLineCount;
              continue;
            }

            // Fuzzy match at range (whitespace/escape normalization)
            const rangeFixed = fuzzyWhitespaceMatch(rangeContent, edit.oldString, edit.newString);
            if (rangeFixed) {
              applyLineReplace(start, end, rangeFixed.newStr);
              lineOffset += rangeFixed.newStr.split("\n").length - (end - start);
              continue;
            }

            // oldString doesn't match at the adjusted line range.
            // Fall through to string-based matching — the content may still
            // exist elsewhere in the evolved file (e.g. adjacent edits shifted it).
          }
          // Line range invalid — fall through to string-based matching
        }

        // ── FALLBACK: string-based editing (no lineStart or invalid range) ──
        if (content.includes(edit.oldString)) {
          const occurrences = countOccurrences(content, edit.oldString);
          if (occurrences > 1) {
            const msg = `${label}: found ${String(occurrences)} matches. Provide lineStart to disambiguate. NO edits were applied (atomic rollback).`;
            return {
              success: false,
              output: msg,
              error: `${label}: ambiguous match (0 edits applied)`,
            };
          }
          // Single occurrence — safe to replace
          const idx = content.indexOf(edit.oldString);
          content =
            content.slice(0, idx) + edit.newString + content.slice(idx + edit.oldString.length);
          lineOffset += newLineCount - oldLineCount;
          continue;
        }

        // Fuzzy match (whitespace + escape normalization)
        const fixed = fuzzyWhitespaceMatch(content, edit.oldString, edit.newString);
        if (fixed && content.includes(fixed.oldStr)) {
          const fixedOccurrences = countOccurrences(content, fixed.oldStr);
          if (fixedOccurrences === 1) {
            const fixedOldLines = fixed.oldStr.split("\n").length;
            const fixedNewLines = fixed.newStr.split("\n").length;
            const idx = content.indexOf(fixed.oldStr);
            content =
              content.slice(0, idx) + fixed.newStr + content.slice(idx + fixed.oldStr.length);
            lineOffset += fixedNewLines - fixedOldLines;
            continue;
          }
        }

        const err = buildRichEditError(content, edit.oldString, adjustedLineStart);
        return {
          success: false,
          output: `${label} failed: ${err.output}\nNO edits were applied (atomic rollback). Re-read the file and retry ALL edits.`,
          error: `edit ${String(i + 1)} failed (0 edits applied)`,
        };
      }

      // Phase 2: All edits validated — compute metrics and apply
      const beforeMetrics = analyzeFile(originalContent);
      const afterMetrics = analyzeFile(content);

      const diagsPromise = startPreEditDiagnostics(filePath);

      // CAS: verify file hasn't been modified since we read it
      const currentOnDisk = await readFile(filePath, "utf-8");
      if (currentOnDisk !== originalContent) {
        const msg =
          "File was modified concurrently since last read. NO edits were applied (atomic rollback). Re-read and retry ALL edits.";
        return { success: false, output: msg, error: "concurrent modification (0 edits applied)" };
      }

      // Push single undo entry for the entire batch — write immediately
      pushEdit(filePath, originalContent, content, args.tabId);

      await writeFile(filePath, content, "utf-8");
      markToolWrite(filePath);
      emitFileEdited(filePath, content);

      await reloadBuffer(filePath);

      // Build output
      const lineDelta = afterMetrics.lineCount - beforeMetrics.lineCount;
      const importDelta = afterMetrics.importCount - beforeMetrics.importCount;
      const deltas: string[] = [];
      if (lineDelta !== 0) {
        const sign = lineDelta > 0 ? "+" : "";
        deltas.push(
          `lines: ${String(beforeMetrics.lineCount)}→${String(afterMetrics.lineCount)} (${sign}${String(lineDelta)})`,
        );
      }
      if (importDelta !== 0) {
        const sign = importDelta > 0 ? "+" : "";
        deltas.push(
          `imports: ${String(beforeMetrics.importCount)}→${String(afterMetrics.importCount)} (${sign}${String(importDelta)})`,
        );
      }

      let output = `Applied ${String(args.edits.length)} edits to ${displayPath(filePath)}`;
      if (deltas.length > 0) output += ` (${deltas.join(", ")})`;

      output = await appendAutoFormatResult(filePath, content, output, args.tabId);
      output = await appendPostEditDiagnostics(diagsPromise, filePath, output);
      output = await appendCloneHints(filePath, output);

      // Nudge: warn if any edits lacked lineStart (consistent with edit_file)
      const missingLineStart = args.edits.some((e) => e.lineStart == null);
      if (missingLineStart) {
        output +=
          "\n⚠ Some edits lacked lineStart — pass lineStart from read output to make edits escape-proof.";
      }

      const nudge = await consumeAstEditNudge(filePath);
      if (nudge) output += `\n${nudge}`;

      const cwd = process.cwd();
      const rel = filePath.startsWith(`${cwd}/`) ? filePath.slice(cwd.length + 1) : filePath;
      output += memoryHintComposite({ paths: [rel], context: "edit", tabId: args.tabId });

      return { success: true, output };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};
