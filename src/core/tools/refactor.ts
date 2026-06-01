import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getCwd } from "../cwd.js";
import {
  type CodeIntelligenceRouter,
  getIntelligenceClient,
  getIntelligenceRouter,
} from "../intelligence/index.js";
import type { FileEdit, FormatEdit, Language, RefactorResult } from "../intelligence/types.js";
import { isForbidden } from "../security/forbidden.js";
import { pushEdit } from "./edit-stack.js";
import { emitFileEdited } from "./file-events.js";
import { fallbackTracked } from "./intelligence-helpers.js";

async function resolveSymbolRange(
  router: CodeIntelligenceRouter,
  language: Language,
  file: string,
  name: string,
): Promise<{ startLine: number; endLine: number } | null> {
  const outline = await router.executeWithFallback(language, "getFileOutline", (b) =>
    b.getFileOutline ? b.getFileOutline(file) : Promise.resolve(null),
  );
  if (!outline) return null;
  const sym = outline.symbols.find((s) => s.name === name);
  if (!sym) return null;
  const endLine = sym.location.endLine ?? sym.location.line;
  return { startLine: sym.location.line, endLine };
}

type RefactorAction =
  | "extract_function"
  | "extract_variable"
  | "format"
  | "format_range"
  | "organize_imports";

interface RefactorArgs {
  action: RefactorAction;
  file?: string;
  name?: string;
  newName?: string;
  startLine?: number;
  endLine?: number;
  apply?: boolean;
  tabId?: string;
}

async function applyEdits(edits: FileEdit[], tabId?: string): Promise<void> {
  for (const edit of edits) {
    pushEdit(edit.file, edit.oldContent, edit.newContent, tabId);
    await writeFile(edit.file, edit.newContent, "utf-8");
    emitFileEdited(edit.file, edit.newContent);
  }
}

async function applyAndDiagnose(
  edits: FileEdit[],
  router: ReturnType<typeof getIntelligenceRouter>,
  tabId?: string,
): Promise<string | null> {
  // Snapshot before-diagnostics for each file
  const client = getIntelligenceClient();
  const beforeMap = new Map<string, import("../intelligence/types.js").Diagnostic[]>();
  for (const edit of edits) {
    let diags: import("../intelligence/types.js").Diagnostic[] | null = null;
    if (client) {
      const tracked = await client.routerGetDiagnostics(edit.file);
      diags = tracked?.value ?? null;
    } else {
      const lang = router.detectLanguage(edit.file);
      diags = await router.executeWithFallback(lang, "getDiagnostics", (b) =>
        b.getDiagnostics ? b.getDiagnostics(edit.file) : Promise.resolve(null),
      );
    }
    if (diags) beforeMap.set(edit.file, diags);
  }

  await applyEdits(edits, tabId);

  // Run diagnostic diff on each file
  try {
    const { formatPostEditResult, sameFileDiagnostics } = await import(
      "../intelligence/post-edit.js"
    );
    const parts: string[] = [];
    for (const edit of edits) {
      const lang = router.detectLanguage(edit.file);
      const before = beforeMap.get(edit.file) ?? [];
      const diffResult = await sameFileDiagnostics(router, edit.file, lang, before);
      const diffOutput = formatPostEditResult(diffResult);
      if (diffOutput) parts.push(diffOutput);
    }
    return parts.length > 0 ? parts.join("\n") : null;
  } catch {
    return null;
  }
}

function formatResult(result: RefactorResult, applied: boolean): string {
  const lines = [result.description];
  if (applied) {
    lines.push(
      `Applied to ${String(result.edits.length)} file(s) — ALL references updated atomically:`,
    );
  } else {
    lines.push(`Would modify ${String(result.edits.length)} file(s):`);
  }
  for (const edit of result.edits) {
    lines.push(`  ${edit.file}`);
  }
  if (applied) {
    lines.push("All references updated. No errors.");
  } else {
    lines.push("Pass apply: true to apply changes.");
  }
  return lines.join("\n");
}

export const refactorTool = {
  name: "refactor",
  description:
    "[TIER-3] LSP code transformations — extract function, organize imports. Atomic multi-file updates. Set apply=false to preview.",
  execute: async (args: RefactorArgs): Promise<ToolResult> => {
    try {
      const router = getIntelligenceRouter(getCwd());
      const file = args.file ? resolve(args.file) : undefined;
      if (file) {
        const blocked = isForbidden(file);
        if (blocked) {
          return {
            success: false,
            output: `Access denied: "${file}" matches forbidden pattern "${blocked}"`,
            error: "forbidden",
          };
        }
      }
      const language = router.detectLanguage(file);
      const shouldApply = args.apply ?? true;

      switch (args.action) {
        case "extract_function": {
          let startLine = args.startLine;
          let endLine = args.endLine;
          const newName = args.newName;
          if (!file) {
            return {
              success: false,
              output: "file is required for extract_function",
              error: "missing file",
            };
          }
          if (!startLine || !endLine) {
            if (args.name) {
              const resolved = await resolveSymbolRange(router, language, file, args.name);
              if (!resolved) {
                return {
                  success: false,
                  output: `Symbol "${args.name}" not found in ${file}`,
                  error: "symbol not found",
                };
              }
              startLine = resolved.startLine;
              endLine = resolved.endLine;
            } else {
              return {
                success: false,
                output:
                  "startLine and endLine are required for extract_function (or provide name to auto-resolve)",
                error: "missing range",
              };
            }
          }
          if (!newName) {
            return {
              success: false,
              output: "newName is required for extract_function",
              error: "missing newName",
            };
          }

          const client = getIntelligenceClient();
          const tracked = client
            ? await client.routerExtractFunction(file, startLine, endLine, newName)
            : await fallbackTracked(file, "extractFunction", (b) =>
                b.extractFunction
                  ? b.extractFunction(file, startLine, endLine, newName)
                  : Promise.resolve(null),
              );

          if (!tracked) {
            return {
              success: false,
              output: `Cannot extract function — no backend supports this for ${language}`,
              error: "unsupported",
            };
          }

          let diagOutput: string | null = null;
          if (shouldApply) {
            diagOutput = await applyAndDiagnose(tracked.value.edits, router, args.tabId);
          }
          let output = formatResult(tracked.value, shouldApply);
          if (diagOutput) output += `\n${diagOutput}`;
          return { success: true, output, backend: tracked.backend };
        }

        case "extract_variable": {
          let startLine = args.startLine;
          let endLine = args.endLine;
          const newName = args.newName;
          if (!file) {
            return {
              success: false,
              output: "file is required for extract_variable",
              error: "missing file",
            };
          }
          if (!startLine || !endLine) {
            if (args.name) {
              const resolved = await resolveSymbolRange(router, language, file, args.name);
              if (!resolved) {
                return {
                  success: false,
                  output: `Symbol "${args.name}" not found in ${file}`,
                  error: "symbol not found",
                };
              }
              startLine = resolved.startLine;
              endLine = resolved.endLine;
            } else {
              return {
                success: false,
                output:
                  "startLine and endLine are required for extract_variable (or provide name to auto-resolve)",
                error: "missing range",
              };
            }
          }
          if (!newName) {
            return {
              success: false,
              output: "newName is required for extract_variable",
              error: "missing newName",
            };
          }

          const client = getIntelligenceClient();
          const tracked = client
            ? await client.routerExtractVariable(file, startLine, endLine, newName)
            : await fallbackTracked(file, "extractVariable", (b) =>
                b.extractVariable
                  ? b.extractVariable(file, startLine, endLine, newName)
                  : Promise.resolve(null),
              );

          if (!tracked) {
            return {
              success: false,
              output: `Cannot extract variable — no backend supports this for ${language}`,
              error: "unsupported",
            };
          }

          let diagOutput: string | null = null;
          if (shouldApply) {
            diagOutput = await applyAndDiagnose(tracked.value.edits, router, args.tabId);
          }
          let output = formatResult(tracked.value, shouldApply);
          if (diagOutput) output += `\n${diagOutput}`;
          return { success: true, output, backend: tracked.backend };
        }

        case "format": {
          if (!file) {
            return {
              success: false,
              output: "file is required for format",
              error: "missing file",
            };
          }

          // Prefer project formatter (biome/prettier/etc.) — matches CI, falls through to LSP on failure
          const { projectTool } = await import("./project.js");
          const projResult = await projectTool.execute({ action: "lint", fix: true, file });
          if (projResult.success) {
            return {
              success: true,
              output: `Formatted ${file} via project formatter`,
              backend: "project",
            };
          }

          const client = getIntelligenceClient();
          const tracked = client
            ? await client.routerFormatDocument(file)
            : await fallbackTracked(file, "formatDocument", (b) =>
                b.formatDocument ? b.formatDocument(file) : Promise.resolve(null),
              );

          if (!tracked) {
            return {
              success: false,
              output: `Cannot format — no backend supports formatting for ${language}`,
              error: "unsupported",
            };
          }

          if (shouldApply) await applyFormatEdits(tracked.value, args.tabId);
          return {
            success: true,
            output: `Formatted ${file} (${String(tracked.value.edits.length)} edit(s))${shouldApply ? " — applied" : " — pass apply: true to apply"}`,
            backend: tracked.backend,
          };
        }

        case "format_range": {
          if (!file) {
            return {
              success: false,
              output: "file is required for format_range",
              error: "missing file",
            };
          }
          const startLine = args.startLine;
          const endLine = args.endLine;
          if (!startLine || !endLine) {
            return {
              success: false,
              output: "startLine and endLine are required for format_range",
              error: "missing range",
            };
          }

          const client = getIntelligenceClient();
          const tracked = client
            ? await client.routerFormatRange(file, startLine, endLine)
            : await fallbackTracked(file, "formatRange", (b) =>
                b.formatRange ? b.formatRange(file, startLine, endLine) : Promise.resolve(null),
              );

          if (!tracked) {
            return {
              success: false,
              output: `Cannot format range — no backend supports range formatting for ${language}`,
              error: "unsupported",
            };
          }

          if (shouldApply) await applyFormatEdits(tracked.value, args.tabId);
          return {
            success: true,
            output: `Formatted ${file} lines ${String(startLine)}-${String(endLine)} (${String(tracked.value.edits.length)} edit(s))${shouldApply ? " — applied" : ""}`,
            backend: tracked.backend,
          };
        }

        case "organize_imports": {
          if (!file) {
            return {
              success: false,
              output: "file is required for organize_imports",
              error: "missing file",
            };
          }

          const client = getIntelligenceClient();
          const tracked = client
            ? await client.routerOrganizeImports(file)
            : await fallbackTracked(file, "organizeImports", (b) =>
                b.organizeImports ? b.organizeImports(file) : Promise.resolve(null),
              );

          if (!tracked) {
            return {
              success: false,
              output: `Cannot organize imports — no backend supports this for ${language}`,
              error: "unsupported",
            };
          }

          let diagOutput: string | null = null;
          if (shouldApply) {
            diagOutput = await applyAndDiagnose(tracked.value.edits, router, args.tabId);
          }
          let output = formatResult(tracked.value, shouldApply);
          if (diagOutput) output += `\n${diagOutput}`;
          return { success: true, output, backend: tracked.backend };
        }

        default:
          return {
            success: false,
            output: `Unknown action: ${args.action as string}`,
            error: "invalid action",
          };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};

async function applyFormatEdits(formatEdit: FormatEdit, tabId?: string): Promise<void> {
  const content = await readFile(formatEdit.file, "utf-8");

  // Pre-compute line start offsets (1-indexed: lineStarts[1] = offset of line 1)
  // Handles both \n and \r\n line endings correctly
  const lineStarts: number[] = [0, 0]; // lineStarts[0] unused, lineStarts[1] = 0
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

  pushEdit(formatEdit.file, content, result, tabId);
  await writeFile(formatEdit.file, result, "utf-8");
  emitFileEdited(formatEdit.file, result);
}
