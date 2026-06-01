import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getCwd } from "../cwd.js";
import { getIntelligenceClient, getIntelligenceRouter } from "../intelligence/index.js";
import type { FormatEdit, RefactorResult } from "../intelligence/types.js";
import { pushEdit } from "./edit-stack.js";
import { emitFileEdited } from "./file-events.js";

/**
 * Post-edit auto-fix: runs LSP source actions on a file after edits.
 * Same as VS Code's "organize imports on save" + "fix all on save".
 *
 * - source.organizeImports → removes unused imports, sorts
 * - source.fixAll → removes unused variables, auto-fixes diagnostics
 *
 * Returns list of actions applied (empty if nothing changed).
 */
async function autoFixFile(filePath: string, tabId?: string): Promise<string[]> {
  const absPath = resolve(filePath);
  const client = getIntelligenceClient();
  const router = getIntelligenceRouter(getCwd());
  const language = client
    ? await client.routerDetectLanguage(absPath)
    : router.detectLanguage(absPath);
  const applied: string[] = [];

  // 1. Organize imports
  let organizeResult: import("../intelligence/types.js").RefactorResult | null = null;
  if (client) {
    const tracked = await client.routerOrganizeImports(absPath);
    organizeResult = tracked?.value ?? null;
  } else {
    organizeResult = await router.executeWithFallback(language, "organizeImports", (b) =>
      b.organizeImports ? b.organizeImports(absPath) : Promise.resolve(null),
    );
  }
  if (organizeResult) {
    await applyRefactorEdits(organizeResult, tabId);
    applied.push("organizeImports");
  }

  // 2. Fix all (unused vars, auto-fixable diagnostics)
  let fixResult: import("../intelligence/types.js").RefactorResult | null = null;
  if (client) {
    const tracked = await client.routerFixAll(absPath);
    fixResult = tracked?.value ?? null;
  } else {
    fixResult = await router.executeWithFallback(language, "fixAll", (b) =>
      b.fixAll ? b.fixAll(absPath) : Promise.resolve(null),
    );
  }
  if (fixResult) {
    await applyRefactorEdits(fixResult, tabId);
    applied.push("fixAll");
  }

  // 3. Format — final pass (after imports/fixAll may have shifted lines)
  // Priority: project formatter (authoritative) → LSP formatDocument → skip
  try {
    const { formatFile } = await import("./project.js");
    const preFormat = await readFile(absPath, "utf-8");
    const formatted = await formatFile(absPath);
    if (formatted) {
      // Re-read the file that the formatter wrote and push to edit stack
      const afterFormat = await readFile(absPath, "utf-8");
      if (afterFormat !== preFormat) {
        pushEdit(absPath, preFormat, afterFormat, tabId);
        emitFileEdited(absPath, afterFormat);
        applied.push("format");
      }
    } else {
      let formatResult: import("../intelligence/types.js").FormatEdit | null = null;
      const client = getIntelligenceClient();
      if (client) {
        const tracked = await client.routerFormatDocument(absPath);
        formatResult = tracked?.value ?? null;
      } else {
        formatResult = await router.executeWithFallback(language, "formatDocument", (b) =>
          b.formatDocument ? b.formatDocument(absPath) : Promise.resolve(null),
        );
      }
      if (formatResult) {
        await applyFormatEdits(formatResult, tabId);
        applied.push("format");
      }
    }
  } catch {
    // Formatting unavailable — no-op
  }

  return applied;
}

/**
 * Auto-fix multiple files in parallel. Best-effort — failures are silently skipped.
 * Returns map of file → actions applied.
 */
export async function autoFixFiles(
  filePaths: string[],
  tabId?: string,
): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>();
  const unique = [...new Set(filePaths.map((f) => resolve(f)))];

  await Promise.all(
    unique.map(async (file) => {
      try {
        const actions = await autoFixFile(file, tabId);
        if (actions.length > 0) results.set(file, actions);
      } catch {
        // Best-effort
      }
    }),
  );

  return results;
}

async function applyFormatEdits(formatEdit: FormatEdit, tabId?: string): Promise<void> {
  const content = await readFile(formatEdit.file, "utf-8");

  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      lineStarts.push(i + 1);
    }
  }

  const sorted = [...formatEdit.edits].sort((a, b) => {
    if (a.startLine !== b.startLine) return b.startLine - a.startLine;
    return b.startCol - a.startCol;
  });

  let result = content;
  for (const edit of sorted) {
    const startOffset = (lineStarts[edit.startLine] ?? 0) + edit.startCol - 1;
    const endOffset = (lineStarts[edit.endLine] ?? 0) + edit.endCol - 1;
    result = result.slice(0, startOffset) + edit.newText + result.slice(endOffset);
  }

  if (result === content) return;
  pushEdit(formatEdit.file, content, result, tabId);
  await writeFile(formatEdit.file, result, "utf-8");
  emitFileEdited(formatEdit.file, result);
}

async function applyRefactorEdits(result: RefactorResult, tabId?: string): Promise<void> {
  for (const edit of result.edits) {
    try {
      const current = await readFile(edit.file, "utf-8");
      if (current === edit.newContent) continue;
      pushEdit(edit.file, current, edit.newContent, tabId);
      await writeFile(edit.file, edit.newContent, "utf-8");
      emitFileEdited(edit.file, edit.newContent);
    } catch {
      // Skip files that can't be written
    }
  }
}
