import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getCwd } from "../cwd.js";
import { isForbidden } from "../security/forbidden.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";

interface ListDirArgs {
  path?: string | string[];
  depth?: number;
}

/** Max entries across all paths to avoid blowing up context */
const MAX_TOTAL_ENTRIES = 500;

/**
 * Repo-map-aware directory listing. When the repo map is available,
 * returns file metadata (language, lines, symbols, importance).
 * Falls back to filesystem readdir for non-indexed directories.
 *
 * Supports multiple paths in a single call and recursive depth.
 * Cross-platform: uses node:path for separator handling.
 */
export const listDirTool = {
  name: "list_dir",
  description:
    "List directory contents with file metadata. Accepts a single path or array of paths to list multiple directories in one call. Use depth for recursive listing.",
  execute: async (args: ListDirArgs, repoMap?: IntelligenceClient): Promise<ToolResult> => {
    try {
      const cwd = getCwd();
      const depth = Math.min(Math.max(args.depth ?? 1, 1), 5);

      // Normalize paths: support single string, array, or default to cwd
      const rawPaths: string[] = !args.path
        ? [cwd]
        : Array.isArray(args.path)
          ? args.path.length === 0
            ? [cwd]
            : args.path
          : [args.path];

      // Deduplicate resolved paths while preserving order
      const seen = new Set<string>();
      const targetPaths: Array<{ raw: string; abs: string; rel: string }> = [];
      for (const raw of rawPaths) {
        const abs = resolve(raw);
        if (seen.has(abs)) continue;
        seen.add(abs);
        targetPaths.push({ raw, abs, rel: relative(cwd, abs) });
      }

      const sections: string[] = [];
      let totalEntries = 0;
      let capped = false;

      for (const { raw, abs, rel } of targetPaths) {
        if (totalEntries >= MAX_TOTAL_ENTRIES) {
          capped = true;
          break;
        }

        const blocked = isForbidden(abs);
        if (blocked) {
          sections.push(`❌ ${raw} — access denied (matches "${blocked}")`);
          continue;
        }

        const result = await listSingleDir(
          abs,
          rel,
          depth,
          repoMap,
          MAX_TOTAL_ENTRIES - totalEntries,
        );
        totalEntries += result.count;
        sections.push(result.output);
      }

      if (capped) {
        sections.push(
          `\n⚠️ Output capped at ${String(MAX_TOTAL_ENTRIES)} entries. Narrow with specific paths or reduce depth.`,
        );
      }

      return {
        success: true,
        output: sections.join("\n\n"),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};

/** Format a single entry line */
function formatEntry(
  name: string,
  isDir: boolean,
  meta?: { language?: string; lines?: number; symbols?: number; importance?: number },
): string {
  if (isDir) return `📁 ${name}/`;
  const parts: string[] = [];
  if (meta) {
    if (meta.language && meta.language !== "unknown") parts.push(meta.language);
    if (meta.lines) parts.push(`${String(meta.lines)}L`);
    if (meta.symbols) parts.push(`${String(meta.symbols)} syms`);
    if (meta.importance && meta.importance > 0.001) parts.push(`★${String(meta.importance)}`);
  }
  const suffix = parts.length > 0 ? `  (${parts.join(", ")})` : "";
  return `   ${name}${suffix}`;
}

/** List a single directory, optionally recursing up to `depth` levels */
async function listSingleDir(
  absPath: string,
  relPath: string,
  depth: number,
  repoMap: IntelligenceClient | undefined,
  budget: number,
): Promise<{ output: string; count: number }> {
  const header = relPath === "" ? "." : relPath;

  // Try repo map first (depth=1 only — repo map doesn't support recursive)
  if (repoMap && depth === 1) {
    const dirKey = relPath === "" ? "." : relPath;
    const entries = await repoMap.listDirectory(dirKey);
    if (entries && entries.length > 0) {
      const limited = entries.slice(0, budget);
      const lines: string[] = [];
      for (const e of limited) {
        lines.push(formatEntry(e.name, e.type === "dir", e));
      }
      const truncNote =
        limited.length < entries.length
          ? ` (showing ${String(limited.length)}/${String(entries.length)})`
          : "";
      return {
        output: `${header}/ — ${String(entries.length)} entries (soul map)${truncNote}\n${lines.join("\n")}`,
        count: limited.length,
      };
    }
  }

  // Filesystem fallback with recursive support
  return listDirFS(absPath, header, depth, 0, budget);
}

/** Recursive filesystem listing */
async function listDirFS(
  absPath: string,
  displayPath: string,
  maxDepth: number,
  currentDepth: number,
  budget: number,
): Promise<{ output: string; count: number }> {
  let rawEntries: string[];
  try {
    rawEntries = await readdir(absPath);
  } catch {
    return { output: `❌ ${displayPath} — cannot read directory`, count: 0 };
  }

  const visible = rawEntries.filter(
    (name) => (!name.startsWith(".") || name === ".gitignore") && !isForbidden(join(absPath, name)),
  );

  const classified = await Promise.all(
    visible.map(async (name) => {
      try {
        const s = await stat(join(absPath, name));
        return { name, isDir: s.isDirectory() };
      } catch {
        return { name, isDir: false };
      }
    }),
  );

  // Sort: dirs first, then files, alphabetically within each group
  const dirs = classified.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  const files = classified.filter((e) => !e.isDir).sort((a, b) => a.name.localeCompare(b.name));

  const indent = "  ".repeat(currentDepth);
  const lines: string[] = [];
  let count = 0;

  if (currentDepth === 0) {
    lines.push(`${displayPath}/ — ${String(dirs.length + files.length)} entries`);
  }

  // Dirs
  for (const { name } of dirs) {
    if (count >= budget) break;
    lines.push(`${indent}📁 ${name}/`);
    count++;

    // Recurse if depth allows
    if (currentDepth + 1 < maxDepth && count < budget) {
      const childAbs = join(absPath, name);
      const childDisplay = `${displayPath}/${name}`;
      const sub = await listDirFS(
        childAbs,
        childDisplay,
        maxDepth,
        currentDepth + 1,
        budget - count,
      );
      if (sub.count > 0) {
        lines.push(sub.output);
        count += sub.count;
      }
    }
  }

  // Files
  for (const { name } of files) {
    if (count >= budget) break;
    lines.push(`${indent}${formatEntry(name, false)}`);
    count++;
  }

  return { output: lines.join("\n"), count };
}
