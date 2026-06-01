import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolResult } from "../../types";
import { getCwd } from "../cwd.js";
import { isForbidden } from "../security/forbidden.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";
import { execFileAsync } from "./util.js";

type ImpactAction = "dependents" | "dependencies" | "cochanges" | "blast_radius";

interface SoulImpactArgs {
  action: ImpactAction;
  file: string;
}

export const soulImpactTool = {
  name: "soul_impact",
  description:
    "[TIER-1] Check before editing high-impact files. Queries: dependents, dependencies, cochanges, blast_radius. Use when Soul Map shows (→N) > 10.",

  createExecute: (repoMap?: IntelligenceClient) => {
    return async (args: SoulImpactArgs): Promise<ToolResult> => {
      if (isForbidden(args.file) !== null) {
        return {
          success: false,
          output: `Access denied: "${args.file}" is blocked for security.`,
          error: "forbidden",
        };
      }

      const cwd = getCwd();
      const relPath = args.file.startsWith("/") ? relative(cwd, args.file) : args.file;

      // Fallback to grep when soul map not ready
      if (!repoMap?.isReady) {
        switch (args.action) {
          case "dependents":
            return await grepDependents(cwd, relPath);
          case "dependencies":
            return await grepDependencies(cwd, relPath);
          default:
            return {
              success: true,
              output: `Soul map not indexed — "${String(args.action)}" requires the dependency graph. Run /repo-map to enable.`,
            };
        }
      }

      switch (args.action) {
        case "dependents":
          return await showDependents(repoMap, relPath);
        case "dependencies":
          return await showDependencies(repoMap, relPath);
        case "cochanges":
          return await showCoChanges(repoMap, relPath);
        case "blast_radius":
          return await showBlastRadius(repoMap, relPath);
        default:
          return {
            success: false,
            output: `Unknown action: ${String(args.action)}`,
            error: "invalid",
          };
      }
    };
  },
};

async function showDependents(repoMap: IntelligenceClient, relPath: string): Promise<ToolResult> {
  const dependents = await repoMap.getFileDependents(relPath);
  if (dependents.length === 0) {
    return { success: true, output: `No files depend on "${relPath}" (or file not indexed).` };
  }

  const lines = [
    `${String(dependents.length)} files import from "${relPath}":\n`,
    ...dependents
      .filter((d) => isForbidden(d.path) === null)
      .map((d) => `  ${d.path} (w:${Math.round(d.weight)})`),
  ];

  return { success: true, output: lines.join("\n") };
}

async function showDependencies(repoMap: IntelligenceClient, relPath: string): Promise<ToolResult> {
  const deps = await repoMap.getFileDependencies(relPath);
  if (deps.length === 0) {
    return {
      success: true,
      output: `"${relPath}" has no tracked dependencies (or file not indexed).`,
    };
  }

  const lines = [
    `"${relPath}" imports from ${String(deps.length)} files:\n`,
    ...deps
      .filter((d) => isForbidden(d.path) === null)
      .map((d) => `  ${d.path} (w:${Math.round(d.weight)})`),
  ];

  return { success: true, output: lines.join("\n") };
}

async function showCoChanges(repoMap: IntelligenceClient, relPath: string): Promise<ToolResult> {
  const cochanges = await repoMap.getFileCoChanges(relPath);
  if (cochanges.length === 0) {
    return { success: true, output: `No co-change partners found for "${relPath}".` };
  }

  const lines = [
    `Files that historically change together with "${relPath}":\n`,
    ...cochanges
      .filter((c) => isForbidden(c.path) === null)
      .map((c) => `  ${c.path} (${String(c.count)} co-commits)`),
  ];

  return { success: true, output: lines.join("\n") };
}

async function showBlastRadius(repoMap: IntelligenceClient, relPath: string): Promise<ToolResult> {
  const dependents = await repoMap.getFileDependents(relPath);
  const cochanges = await repoMap.getFileCoChanges(relPath);
  const blastCount = await repoMap.getFileBlastRadius(relPath);
  const symbols = await repoMap.getFileSymbols(relPath);

  if (dependents.length === 0 && cochanges.length === 0 && symbols.length === 0) {
    return { success: true, output: `"${relPath}" not found in soul map index.` };
  }

  const allAffected = new Set<string>();
  for (const d of dependents) allAffected.add(d.path);
  for (const c of cochanges) allAffected.add(c.path);

  const lines = [
    `Blast radius for "${relPath}":\n`,
    `  Direct dependents: ${String(blastCount)}`,
    `  Co-change partners: ${String(cochanges.length)}`,
    `  Total affected files: ${String(allAffected.size)}`,
  ];

  if (symbols.length > 0) {
    lines.push(`\nExported symbols (${String(symbols.length)}):`);
    for (const s of symbols) {
      lines.push(`  ${s.kind} ${s.name}`);
    }
  }

  if (dependents.length > 0) {
    lines.push(`\nDirect dependents (${String(dependents.length)}):`);
    for (const d of dependents.filter((d) => isForbidden(d.path) === null).slice(0, 20)) {
      lines.push(`  ${d.path} (w:${Math.round(d.weight)})`);
    }
    if (dependents.length > 20) lines.push(`  ... and ${String(dependents.length - 20)} more`);
  }

  if (cochanges.length > 0) {
    const coOnly = cochanges.filter(
      (c) => !dependents.some((d) => d.path === c.path) && isForbidden(c.path) === null,
    );
    if (coOnly.length > 0) {
      lines.push(`\nCo-change only (related by git history, not imports):`);
      for (const c of coOnly.slice(0, 10)) {
        lines.push(`  ${c.path} (${String(c.count)} co-commits)`);
      }
    }
  }

  return { success: true, output: lines.join("\n") };
}

async function grepDependents(cwd: string, relPath: string): Promise<ToolResult> {
  const basename = relPath.replace(/\.(ts|tsx|js|jsx|py|rs|go|rb|java|kt)$/, "");
  const stripped = basename.replace(/\/index$/, "");
  const escaped = stripped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    const out = await execFileAsync(
      "rg",
      ["-l", "--glob=!node_modules", "--glob=!.git", "--max-count=1", escaped, "."],
      { cwd, timeout: 10_000, maxBuffer: 512_000 },
    );
    const files = out
      .split("\n")
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//, ""))
      .filter((f) => f !== relPath && isForbidden(join(cwd, f)) === null);
    if (files.length === 0) {
      return {
        success: true,
        output: `No files reference "${relPath}" (grep fallback — soul map not indexed).`,
      };
    }
    return {
      success: true,
      output: `${String(files.length)} files likely reference "${relPath}" (grep fallback):\n${files.map((f) => `  ${f}`).join("\n")}`,
    };
  } catch {
    return {
      success: true,
      output: `No files reference "${relPath}" (grep fallback — soul map not indexed).`,
    };
  }
}

async function grepDependencies(cwd: string, relPath: string): Promise<ToolResult> {
  const absPath = join(cwd, relPath);
  try {
    const content = await readFile(absPath, "utf-8");
    const importRe = /(?:import|from|require)\s*[(\s]['"`]([^'"`]+)['"`]/g;
    const deps: string[] = [];
    for (const match of content.matchAll(importRe)) {
      if (match[1] && !match[1].startsWith("node:") && !match[1].startsWith("bun:")) {
        deps.push(match[1]);
      }
    }
    if (deps.length === 0) {
      return {
        success: true,
        output: `"${relPath}" has no imports (grep fallback — soul map not indexed).`,
      };
    }
    return {
      success: true,
      output: `"${relPath}" imports (grep fallback):\n${deps.map((d) => `  ${d}`).join("\n")}`,
    };
  } catch {
    return { success: true, output: `Could not read "${relPath}" (grep fallback).` };
  }
}
