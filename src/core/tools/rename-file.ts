import { mkdir, readFile, rename, stat as statAsync, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getCwd } from "../cwd.js";
import { getIntelligenceClient, getIntelligenceRouter } from "../intelligence/index.js";
import { isForbidden } from "../security/forbidden.js";
import { pushEdit } from "./edit-stack.js";
import { emitFileEdited } from "./file-events.js";

interface RenameFileArgs {
  from: string;
  to: string;
  tabId?: string;
}

export const renameFileTool = {
  name: "rename_file",
  description:
    "Rename or move a file. LSP automatically updates all imports/references across the project. Use for refactoring file structure.",
  execute: async (args: RenameFileArgs): Promise<ToolResult> => {
    const from = resolve(args.from);
    const to = resolve(args.to);
    const cwd = getCwd();

    try {
      await statAsync(from);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      const msg =
        code === "EACCES" || code === "EPERM"
          ? `Permission denied: ${relative(cwd, from)}`
          : `File not found: ${relative(cwd, from)}`;
      return {
        success: false,
        output: msg,
        error: code === "EACCES" || code === "EPERM" ? "permission denied" : "not found",
      };
    }

    const forbiddenFrom = isForbidden(from);
    if (forbiddenFrom) {
      return {
        success: false,
        output: `Cannot move forbidden file: ${from} (${forbiddenFrom})`,
        error: "forbidden",
      };
    }
    const forbiddenTo = isForbidden(to);
    if (forbiddenTo) {
      return {
        success: false,
        output: `Cannot move to forbidden path: ${to} (${forbiddenTo})`,
        error: "forbidden",
      };
    }

    if (from === to) {
      return { success: false, output: "Source and destination are the same", error: "same path" };
    }

    try {
      await statAsync(to);
      return {
        success: false,
        output: `Destination already exists: ${relative(cwd, to)}`,
        error: "exists",
      };
    } catch {}

    const client = getIntelligenceClient();
    const router = getIntelligenceRouter(cwd);
    const output: string[] = [];

    // 1. Ask LSP for import edits BEFORE moving the file
    let lspEdits: Array<{ file: string; oldContent: string; newContent: string }> = [];
    if (client) {
      const tracked = await client.routerGetFileRenameEdits([{ oldPath: from, newPath: to }]);
      if (tracked?.value) {
        lspEdits = tracked.value.edits;
      }
    } else {
      const language = router.detectLanguage(from);
      const renameResult = await router.executeWithFallback(
        language,
        "getFileRenameEdits",
        (b) => b.getFileRenameEdits?.([{ oldPath: from, newPath: to }]) ?? Promise.resolve(null),
      );
      if (renameResult) {
        lspEdits = renameResult.edits;
      }
    }

    // 2. Apply LSP import edits to all affected files
    const appliedFiles: string[] = [];
    for (const edit of lspEdits) {
      try {
        const forbidden = isForbidden(edit.file);
        if (forbidden) continue;
        pushEdit(edit.file, edit.oldContent, edit.newContent, args.tabId);
        await writeFile(edit.file, edit.newContent, "utf-8");
        emitFileEdited(edit.file, edit.newContent);
        if (client) {
          client.routerInvalidateFileCache(edit.file);
        } else {
          router.fileCache.invalidate(edit.file);
        }
        appliedFiles.push(edit.file);
      } catch {
        // Best-effort — continue with other files
      }
    }

    // 3. Move the file
    const toDir = dirname(to);
    await mkdir(toDir, { recursive: true });

    const originalContent = await readFile(from, "utf-8");
    pushEdit(from, originalContent, originalContent, args.tabId);

    try {
      await rename(from, to);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Failed to move file: ${msg}`, error: "move failed" };
    }

    // Invalidate old path cache, emit events for new path
    if (client) {
      client.routerInvalidateFileCache(from);
    } else {
      router.fileCache.invalidate(from);
    }
    emitFileEdited(to, originalContent);

    // 4. Notify LSP servers that the rename completed
    if (client) {
      client.routerNotifyFilesRenamed([{ oldPath: from, newPath: to }]);
    } else {
      const language = router.detectLanguage(from);
      router.executeWithFallback(language, "notifyFilesRenamed", (b) => {
        b.notifyFilesRenamed?.([{ oldPath: from, newPath: to }]);
        return Promise.resolve(null);
      });
    }

    // 5. Report
    output.push(`Moved ${relative(cwd, from)} → ${relative(cwd, to)}`);

    if (appliedFiles.length > 0) {
      output.push(
        `LSP updated imports in ${String(appliedFiles.length)} file(s):`,
        ...appliedFiles.map((f) => `  ${relative(cwd, f)}`),
      );
    } else if (lspEdits.length === 0) {
      output.push("No import updates needed.");
    }

    // 6. Auto-fix all affected files (organize imports, fix unused vars)
    try {
      const { autoFixFiles } = await import("./post-edit-fix.js");
      const fixes = await autoFixFiles([to, ...appliedFiles]);
      if (fixes.size > 0) {
        const fixed = [...fixes.entries()]
          .map(([f, actions]) => `  ${relative(cwd, f)}: ${actions.join(", ")}`)
          .join("\n");
        output.push(`Auto-fixed:\n${fixed}`);
      }
    } catch {
      // Auto-fix unavailable
    }

    return { success: true, output: output.join("\n") };
  },
};
