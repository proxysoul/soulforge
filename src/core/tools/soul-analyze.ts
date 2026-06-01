import { extname, relative } from "node:path";
import type { ToolResult } from "../../types";
import { getCwd } from "../cwd.js";
import {
  IMPORT_TRACKABLE_LANGUAGES,
  INDEXABLE_EXTENSIONS,
} from "../intelligence/repo-map-utils.js";
import { isForbidden } from "../security/forbidden.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";
import { execFileAsync } from "./util.js";

type AnalyzeAction =
  | "identifier_frequency"
  | "unused_exports"
  | "file_profile"
  | "duplication"
  | "top_files"
  | "packages"
  | "symbols_by_kind"
  | "call_graph"
  | "class_members"
  | "summaries"
  | "search_symbols";

interface SoulAnalyzeArgs {
  action: AnalyzeAction;
  file?: string;
  name?: string;
  kind?: string;
  limit?: number;
}

export const soulAnalyzeTool = {
  name: "soul_analyze",
  description:
    "[TIER-2] Codebase analysis from Soul Map — zero file I/O, instant. Actions: identifier_frequency, unused_exports, file_profile, duplication, top_files, packages, symbols_by_kind, call_graph, class_members, summaries, search_symbols.",

  createExecute: (repoMap?: IntelligenceClient) => {
    return async (args: SoulAnalyzeArgs): Promise<ToolResult> => {
      const cwd = getCwd();

      if (!repoMap?.isReady) {
        // Grep fallback for actions that can be approximated
        if (args.action === "identifier_frequency" && args.name) {
          try {
            const out = await execFileAsync(
              "rg",
              ["-c", "--word-regexp", "--glob=!node_modules", "--glob=!.git", args.name, "."],
              { cwd, timeout: 10_000, maxBuffer: 256_000 },
            );
            const lines = out
              .split("\n")
              .filter(Boolean)
              .sort((a: string, b: string) => {
                const ca = Number.parseInt(a.split(":").pop() ?? "0", 10);
                const cb = Number.parseInt(b.split(":").pop() ?? "0", 10);
                return cb - ca;
              })
              .slice(0, args.limit ?? 20);
            return {
              success: true,
              output: `"${args.name}" frequency (grep fallback):\n${lines.join("\n")}`,
            };
          } catch {
            return {
              success: true,
              output: `"${args.name}" — 0 matches (grep fallback — soul map not indexed).`,
            };
          }
        }
        return {
          success: true,
          output: `Soul map not indexed — "${String(args.action)}" requires the dependency graph. Run /repo-map to enable.`,
        };
      }

      switch (args.action) {
        case "identifier_frequency":
          return await identifierFrequency(repoMap, cwd, args.name, args.limit);
        case "unused_exports":
          return await unusedExports(repoMap, cwd, args.limit);
        case "file_profile":
          return await fileProfile(repoMap, cwd, args.file);
        case "duplication":
          return await duplication(repoMap, cwd, args.file, args.limit);
        case "top_files":
          return await topFiles(repoMap, cwd, args.limit);
        case "packages":
          return await packages(repoMap, args.name, args.limit);
        case "symbols_by_kind":
          return await symbolsByKind(repoMap, cwd, args.kind, args.name, args.limit);
        case "call_graph":
          return await callGraph(repoMap, cwd, args.name, args.file, args.limit);
        case "class_members":
          return await classMembers(repoMap, cwd, args.name);
        case "summaries":
          return await symbolSummaries(repoMap, cwd, args.file, args.name);
        case "search_symbols":
          return await searchSymbols(repoMap, cwd, args.name, args.limit);
        default:
          return {
            success: false,
            output: `Unknown action: ${String(args.action)}`,
            error: "invalid action",
          };
      }
    };
  },
};

async function identifierFrequency(
  repoMap: IntelligenceClient,
  cwd: string,
  name: string | undefined,
  limit: number | undefined,
): Promise<ToolResult> {
  if (name) {
    const symbols = await repoMap.findSymbols(name);
    const freq = await repoMap.getIdentifierFrequency(500);
    const match = freq.find((f: { name: string; fileCount: number }) => f.name === name);

    const lines: string[] = [`Identifier "${name}":`];

    if (match) {
      lines.push(`  Referenced in ${String(match.fileCount)} files`);
    } else {
      lines.push("  Not found in refs index");
    }

    if (symbols.length > 0) {
      lines.push(`  Defined in ${String(symbols.length)} location(s):`);
      for (const sym of symbols) {
        const rel = relative(cwd, sym.path);
        if (isForbidden(rel) !== null) continue;
        lines.push(`    ${rel} (${sym.kind}, pagerank: ${sym.pagerank.toFixed(3)})`);
      }
    }

    return { success: true, output: lines.join("\n") };
  }

  const entries = await repoMap.getIdentifierFrequency(limit ?? 25);
  if (entries.length === 0) {
    return { success: true, output: "No identifiers indexed." };
  }

  const lines = [
    `Top ${String(entries.length)} identifiers by cross-file reference count:\n`,
    ...entries.map(
      (e, i) => `  ${String(i + 1).padStart(3)}. ${e.name} — ${String(e.fileCount)} files`,
    ),
  ];

  return { success: true, output: lines.join("\n") };
}

async function unusedExports(
  repoMap: IntelligenceClient,
  cwd: string,
  limit: number | undefined,
): Promise<ToolResult> {
  const unused = await repoMap.getUnusedExports(limit ?? 500);
  const testOnly = await repoMap.getTestOnlyExports();
  const deadBarrels = await repoMap.getDeadBarrels();

  if (unused.length === 0 && testOnly.length === 0 && deadBarrels.length === 0) {
    return {
      success: true,
      output: "No unused exports found (all exports are referenced somewhere).",
    };
  }

  const filtered = unused.filter((u) => isForbidden(u.path) === null);

  // Group by file
  interface FileEntry {
    dead: Sym[];
    unnecessary: Sym[];
    lineCount: number;
  }
  const byFile = new Map<string, FileEntry>();

  for (const u of filtered) {
    const rel = relative(cwd, `${cwd}/${u.path}`);
    if (!byFile.has(rel)) byFile.set(rel, { dead: [], unnecessary: [], lineCount: u.lineCount });
    const entry = byFile.get(rel);
    if (!entry) continue;
    const sym: Sym = { name: u.name, kind: u.kind, line: u.line, endLine: u.endLine };
    if (u.usedInternally) {
      entry.unnecessary.push(sym);
    } else {
      entry.dead.push(sym);
    }
  }

  // Helper: can we reliably track imports for this file's language?
  const canTrackFileImports = (filePath: string): boolean => {
    const ext = extname(filePath).toLowerCase();
    const lang = INDEXABLE_EXTENSIONS[ext];
    return lang != null && IMPORT_TRACKABLE_LANGUAGES.has(lang);
  };

  // Classify files: dead file = ALL exports are dead (none alive)
  type Sym = { name: string; kind: string; line: number; endLine: number };
  const deadFiles: Array<{
    file: string;
    symbols: Sym[];
    lineCount: number;
  }> = [];
  const exportGroups: Array<{
    file: string;
    dead: Sym[];
    unnecessary: Sym[];
    lineCount: number;
  }> = [];
  const scatteredDead: Array<{ file: string; symbols: Sym[] }> = [];
  const scatteredUnnecessary: Array<{ file: string; symbols: Sym[] }> = [];

  for (const [file, entry] of byFile) {
    const totalExported = await repoMap.getFileExportCount(file);
    const totalDead = entry.dead.length + entry.unnecessary.length;
    const allDead = totalExported > 0 && totalDead >= totalExported;
    const hasDependents = (await repoMap.getFileDependents(file)).length > 0;

    if (allDead && !hasDependents && canTrackFileImports(file)) {
      deadFiles.push({
        file,
        symbols: [...entry.dead, ...entry.unnecessary],
        lineCount: entry.lineCount,
      });
    } else if (entry.dead.length + entry.unnecessary.length >= 3) {
      exportGroups.push({
        file,
        dead: entry.dead,
        unnecessary: entry.unnecessary,
        lineCount: entry.lineCount,
      });
    } else {
      if (entry.dead.length > 0) scatteredDead.push({ file, symbols: entry.dead });
      if (entry.unnecessary.length > 0)
        scatteredUnnecessary.push({ file, symbols: entry.unnecessary });
    }
  }

  // Sort dead files by line count (biggest cleanup wins first)
  deadFiles.sort((a, b) => b.lineCount - a.lineCount);
  exportGroups.sort(
    (a, b) => b.dead.length + b.unnecessary.length - (a.dead.length + a.unnecessary.length),
  );

  // Test-only exports grouped by file
  const testOnlyByFile = new Map<string, Sym[]>();
  for (const t of testOnly) {
    if (isForbidden(t.path) !== null) continue;
    const rel = relative(cwd, `${cwd}/${t.path}`);
    const arr = testOnlyByFile.get(rel) ?? [];
    arr.push({ name: t.name, kind: t.kind, line: t.line, endLine: t.endLine });
    testOnlyByFile.set(rel, arr);
  }

  const lines: string[] = [];
  let totalDeadLines = 0;

  if (deadFiles.length > 0) {
    lines.push(`Dead files (${String(deadFiles.length)} — all exports unused, no dependents):\n`);
    for (const f of deadFiles) {
      totalDeadLines += f.lineCount;
      lines.push(`  ${f.file}  (${String(f.lineCount)}L, ${String(f.symbols.length)} exports)`);
      for (const s of f.symbols)
        lines.push(`    ${s.kind} ${s.name} :${String(s.line)}-${String(s.endLine)}`);
    }
    lines.push("");
  }

  const barrelPaths = new Set(deadFiles.map((f) => f.file));
  const liveDeadBarrels = deadBarrels.filter(
    (b) => !barrelPaths.has(relative(cwd, `${cwd}/${b.path}`)),
  );
  if (liveDeadBarrels.length > 0) {
    lines.push(
      `Dead barrels (${String(liveDeadBarrels.length)} — nothing imports through them):\n`,
    );
    for (const b of liveDeadBarrels) {
      const rel = relative(cwd, `${cwd}/${b.path}`);
      lines.push(`  ${rel}  (${String(b.lineCount)}L)`);
    }
    lines.push("");
  }

  if (exportGroups.length > 0) {
    lines.push(
      `Dead export clusters (${String(exportGroups.length)} files with 3+ dead exports):\n`,
    );
    for (const g of exportGroups) {
      const total = g.dead.length + g.unnecessary.length;
      lines.push(`  ${g.file}  (${String(total)} dead, ${String(g.lineCount)}L)`);
      for (const s of g.dead)
        lines.push(`    ${s.kind} ${s.name} :${String(s.line)}-${String(s.endLine)}`);
      for (const s of g.unnecessary)
        lines.push(
          `    ${s.kind} ${s.name} :${String(s.line)}-${String(s.endLine)}  (internal-only)`,
        );
    }
    lines.push("");
  }

  if (testOnlyByFile.size > 0) {
    const testCount = [...testOnlyByFile.values()].reduce((n, a) => n + a.length, 0);
    lines.push(`Test-only exports (${String(testCount)} — only imported by test files):\n`);
    for (const [file, symbols] of testOnlyByFile) {
      lines.push(`  ${file}`);
      for (const s of symbols)
        lines.push(`    ${s.kind} ${s.name} :${String(s.line)}-${String(s.endLine)}`);
    }
    lines.push("");
  }

  if (scatteredDead.length > 0) {
    const count = scatteredDead.reduce((n, s) => n + s.symbols.length, 0);
    lines.push(`Scattered dead exports (${String(count)}):\n`);
    for (const s of scatteredDead) {
      lines.push(`  ${s.file}`);
      for (const sym of s.symbols)
        lines.push(`    ${sym.kind} ${sym.name} :${String(sym.line)}-${String(sym.endLine)}`);
    }
    lines.push("");
  }

  if (scatteredUnnecessary.length > 0) {
    const count = scatteredUnnecessary.reduce((n, s) => n + s.symbols.length, 0);
    lines.push(
      `Unnecessary exports (${String(count)} — used internally, export keyword removable):\n`,
    );
    for (const s of scatteredUnnecessary) {
      lines.push(`  ${s.file}`);
      for (const sym of s.symbols)
        lines.push(`    ${sym.kind} ${sym.name} :${String(sym.line)}-${String(sym.endLine)}`);
    }
    lines.push("");
  }

  const totalDead = filtered.filter((u) => !u.usedInternally).length;
  const totalUnnecessary = filtered.filter((u) => u.usedInternally).length;
  lines.push("───");
  lines.push(
    `Summary: ${String(deadFiles.length)} dead files (${String(totalDeadLines)}L removable), ` +
      `${String(liveDeadBarrels.length)} dead barrels, ` +
      `${String(totalDead)} dead exports, ` +
      `${String(totalUnnecessary)} unnecessary exports, ` +
      `${String(testOnlyByFile.size > 0 ? [...testOnlyByFile.values()].reduce((n, a) => n + a.length, 0) : 0)} test-only`,
  );
  lines.push("\nNote: dynamic imports not tracked. Verify before removing.");

  return { success: true, output: lines.join("\n") };
}

async function fileProfile(
  repoMap: IntelligenceClient,
  cwd: string,
  file: string | undefined,
): Promise<ToolResult> {
  if (!file) {
    return {
      success: false,
      output: "file param required for file_profile",
      error: "missing file",
    };
  }

  if (isForbidden(file) !== null) {
    return {
      success: false,
      output: `Access denied: "${file}" is blocked for security.`,
      error: "forbidden",
    };
  }

  const relPath = file.startsWith("/") ? relative(cwd, file) : file;

  const deps = await repoMap.getFileDependencies(relPath);
  const dependents = await repoMap.getFileDependents(relPath);
  const cochanges = await repoMap.getFileCoChanges(relPath);
  const blastRadius = await repoMap.getFileBlastRadius(relPath);
  const symbols = await repoMap.getFileSymbols(relPath);

  if (deps.length === 0 && dependents.length === 0 && symbols.length === 0) {
    return { success: true, output: `"${relPath}" not found in soul map index.` };
  }

  const lines = [`File profile: ${relPath}\n`];

  lines.push(`Blast radius: ${String(blastRadius)} files depend on this`);
  lines.push("");

  if (symbols.length > 0) {
    lines.push(`Exports (${String(symbols.length)}):`);
    for (const s of symbols) {
      const sigs = await repoMap.getSymbolSignature(s.name);
      const sig = sigs.find(
        (x: { path: string; kind: string; signature: string | null; line: number }) =>
          x.path === relPath || x.path.endsWith(`/${relPath}`),
      );
      lines.push(`  ${sig?.signature ?? `${s.kind} ${s.name}`}`);
    }
    lines.push("");
  }

  if (deps.length > 0) {
    lines.push(`Dependencies (${String(deps.length)}):`);
    for (const d of deps.slice(0, 15)) {
      lines.push(`  ${d.path} (w:${Math.round(d.weight)})`);
    }
    if (deps.length > 15) lines.push(`  ... and ${String(deps.length - 15)} more`);
    lines.push("");
  }

  if (dependents.length > 0) {
    lines.push(`Dependents (${String(dependents.length)}) — files that import from this:`);
    for (const d of dependents.slice(0, 15)) {
      lines.push(`  ${d.path} (w:${Math.round(d.weight)})`);
    }
    if (dependents.length > 15) lines.push(`  ... and ${String(dependents.length - 15)} more`);
    lines.push("");
  }

  if (cochanges.length > 0) {
    lines.push(
      `Co-changes (${String(cochanges.length)}) — files that historically change together:`,
    );
    for (const c of cochanges.slice(0, 10)) {
      lines.push(`  ${c.path} (${String(c.count)} co-commits)`);
    }
    lines.push("");
  }

  // Call graph: show top callers for each exported symbol
  const callHotspots: Array<{ name: string; callerCount: number }> = [];
  for (const s of symbols) {
    const callers = await repoMap.getCallers(s.name, relPath);
    if (callers.length >= 3) {
      callHotspots.push({ name: s.name, callerCount: callers.length });
    }
  }
  if (callHotspots.length > 0) {
    callHotspots.sort((a, b) => b.callerCount - a.callerCount);
    lines.push(`Call hotspots (${String(callHotspots.length)} symbols with 3+ callers):`);
    for (const h of callHotspots.slice(0, 10)) {
      lines.push(`  ${h.name} — ${String(h.callerCount)} callers`);
    }
    lines.push("");
  }

  // Semantic summaries for this file
  const summaries = await repoMap.getSymbolSummaries(relPath);
  const astSummaries = summaries.filter((s) => s.source === "ast");
  if (astSummaries.length > 0) {
    lines.push(`Summaries (${String(astSummaries.length)} from doc comments):`);
    for (const s of astSummaries.slice(0, 10)) {
      lines.push(`  ${s.symbolName} — ${s.summary}`);
    }
    if (astSummaries.length > 10) {
      lines.push(`  ... and ${String(astSummaries.length - 10)} more`);
    }
    lines.push("");
  }

  return { success: true, output: lines.join("\n") };
}

async function duplication(
  repoMap: IntelligenceClient,
  cwd: string,
  file: string | undefined,
  limit: number | undefined,
): Promise<ToolResult> {
  if (file) {
    if (isForbidden(file) !== null) {
      return {
        success: false,
        output: `Access denied: "${file}" is blocked for security.`,
        error: "forbidden",
      };
    }
    const relPath = file.startsWith("/") ? relative(cwd, file) : file;
    const fileDups = await repoMap.getFileDuplicates(relPath);
    if (fileDups.length === 0) {
      return { success: true, output: `No structural clones found for functions in "${relPath}".` };
    }

    const lines = [`Near-duplicate functions in ${relPath}:\n`];
    for (const dup of fileDups) {
      const pct = `${String(Math.round(dup.similarity * 100))}%`;
      lines.push(
        `  ${dup.name} (line ${String(dup.line)}) — ${pct} similar, ${String(dup.clones.length)} match(es):`,
      );
      for (const c of dup.clones.slice(0, 10)) {
        lines.push(`    ${c.path}:${String(c.line)} — ${c.name}`);
      }
      if (dup.clones.length > 10) {
        lines.push(`    + ${String(dup.clones.length - 10)} more`);
      }
    }
    return { success: true, output: lines.join("\n") };
  }

  const cap = limit ?? 15;
  const lines: string[] = [];

  const clusters = await repoMap.getDuplicateStructures(cap);
  if (clusters.length > 0) {
    lines.push(`Exact structural clones (${String(clusters.length)} groups):\n`);
    for (const cluster of clusters) {
      const memberCount = cluster.members.length;
      lines.push(
        `  Cluster — ${String(memberCount)} ${cluster.kind}s, ${String(cluster.nodeCount)} AST nodes each:`,
      );
      for (const m of cluster.members.slice(0, 8)) {
        lines.push(`    ${m.path}:${String(m.line)}-${String(m.endLine)} — ${m.name}`);
      }
      if (memberCount > 8) {
        lines.push(`    + ${String(memberCount - 8)} more`);
      }
      lines.push("");
    }
  }

  const nearDups = await repoMap.getNearDuplicates(0.8, cap);
  if (nearDups.length > 0) {
    lines.push(`Near-duplicates (>80% token similarity, ${String(nearDups.length)} pairs):\n`);
    for (const pair of nearDups) {
      const pct = Math.round(pair.similarity * 100);
      lines.push(
        `  ${String(pct)}% — ${pair.a.path}:${String(pair.a.line)} ${pair.a.name}`,
        `       ↔ ${pair.b.path}:${String(pair.b.line)} ${pair.b.name}`,
        "",
      );
    }
  }

  const fragments = await repoMap.getRepeatedFragments(cap);
  if (fragments.length > 0) {
    lines.push(
      `Repeated code fragments (${String(fragments.length)} patterns across multiple functions):\n`,
    );
    for (const frag of fragments) {
      lines.push(`  Pattern — ${String(frag.count)} occurrences:`);
      for (const loc of frag.locations.slice(0, 6)) {
        lines.push(`    ${loc.path}:${String(loc.line)} in ${loc.name}`);
      }
      if (frag.locations.length > 6) {
        lines.push(`    + ${String(frag.locations.length - 6)} more`);
      }
      lines.push("");
    }
  }

  if (lines.length === 0) {
    return { success: true, output: "No duplication detected in the codebase." };
  }

  lines.push(
    "Use read with target + name to inspect specific pairs and determine if they can be unified.",
  );
  return { success: true, output: lines.join("\n") };
}

async function topFiles(
  repoMap: IntelligenceClient,
  cwd: string,
  limit: number | undefined,
): Promise<ToolResult> {
  const files = await repoMap.getTopFiles(limit ?? 20);
  if (files.length === 0) {
    return { success: true, output: "No files indexed." };
  }

  const lines = [`Top ${String(files.length)} files by importance (PageRank):\n`];
  for (const f of files) {
    if (isForbidden(f.path) !== null) continue;
    const rel = relative(cwd, `${cwd}/${f.path}`);
    lines.push(
      `  ${rel}  ${f.language} ${String(f.lines)}L ${String(f.symbols)} symbols  PR:${f.pagerank.toFixed(3)}`,
    );
  }

  return { success: true, output: lines.join("\n") };
}

async function packages(
  repoMap: IntelligenceClient,
  name: string | undefined,
  limit: number | undefined,
): Promise<ToolResult> {
  if (name) {
    const files = await repoMap.getFilesByPackage(name);
    if (files.length === 0) {
      return { success: true, output: `No files import "${name}" (or package not indexed).` };
    }

    const lines = [`${String(files.length)} files import "${name}":\n`];
    for (const f of files) {
      if (isForbidden(f.path) !== null) continue;
      const specs = f.specifiers ? ` — ${f.specifiers}` : "";
      lines.push(`  ${f.path}${specs}`);
    }
    return { success: true, output: lines.join("\n") };
  }

  const pkgs = await repoMap.getExternalPackages(limit ?? 20);
  if (pkgs.length === 0) {
    return { success: true, output: "No external packages detected." };
  }

  const lines = [`${String(pkgs.length)} external packages:\n`];
  for (const p of pkgs) {
    const specs = p.specifiers.length > 0 ? ` — ${p.specifiers.join(", ")}` : "";
    lines.push(`  ${p.package} (${String(p.fileCount)} files)${specs}`);
  }

  return { success: true, output: lines.join("\n") };
}

async function symbolsByKind(
  repoMap: IntelligenceClient,
  cwd: string,
  kind: string | undefined,
  name: string | undefined,
  limit: number | undefined,
): Promise<ToolResult> {
  if (name) {
    const sigs = await repoMap.getSymbolSignature(name);
    if (sigs.length === 0) {
      return { success: true, output: `Symbol "${name}" not found in index.` };
    }

    const lines = [`Symbol "${name}":\n`];
    for (const s of sigs) {
      if (isForbidden(s.path) !== null) continue;
      const rel = relative(cwd, `${cwd}/${s.path}`);
      const sig = s.signature ? `  ${s.signature}` : "";
      lines.push(`  ${rel}:${String(s.line)} (${s.kind})${sig}`);
    }
    return { success: true, output: lines.join("\n") };
  }

  if (!kind) {
    return {
      success: false,
      output:
        "kind param required (e.g., interface, class, function, type, enum, trait, struct). Use name param to look up a specific symbol's signature.",
      error: "missing kind",
    };
  }

  const symbols = await repoMap.getSymbolsByKind(kind, limit ?? 30);
  if (symbols.length === 0) {
    return { success: true, output: `No exported ${kind} symbols found.` };
  }

  const lines = [`${String(symbols.length)} exported ${kind} symbols:\n`];
  for (const s of symbols) {
    if (isForbidden(s.path) !== null) continue;
    const rel = relative(cwd, `${cwd}/${s.path}`);
    const sig = s.signature ?? s.name;
    lines.push(`  ${rel}:${String(s.line)}  ${sig}`);
  }

  return { success: true, output: lines.join("\n") };
}

async function callGraph(
  repoMap: IntelligenceClient,
  cwd: string,
  name: string | undefined,
  file: string | undefined,
  limit: number | undefined,
): Promise<ToolResult> {
  if (!name) {
    return {
      success: false,
      output: "name param required for call_graph (symbol name to analyze)",
      error: "missing name",
    };
  }

  const relFile = file ? (file.startsWith("/") ? relative(cwd, file) : file) : undefined;

  const callers = await repoMap.getCallers(name, relFile);
  const cap = limit ?? 30;

  const symbols = await repoMap.findSymbols(name);

  const lines: string[] = [`Call graph for "${name}":\n`];

  if (callers.length > 0) {
    lines.push(`Callers (${String(callers.length)}) — functions that call ${name}:`);
    const shown = callers.slice(0, cap);
    for (const c of shown) {
      if (isForbidden(c.callerPath) !== null) continue;
      lines.push(`  ${c.callerPath}:${String(c.callLine)} in ${c.callerName}`);
    }
    if (callers.length > cap) {
      lines.push(`  ... and ${String(callers.length - cap)} more`);
    }
    lines.push("");
  } else {
    lines.push("No callers found in call graph.\n");
  }

  if (callers.length === 0 && symbols.length === 0) {
    return { success: true, output: `"${name}" not found in call graph or symbol index.` };
  }

  if (symbols.length > 0) {
    lines.push(`Defined in ${String(symbols.length)} location(s):`);
    for (const s of symbols) {
      if (isForbidden(s.path) !== null) continue;
      lines.push(`  ${s.path} (${s.kind}, PR:${s.pagerank.toFixed(3)})`);
    }
  }

  return { success: true, output: lines.join("\n") };
}

async function classMembers(
  repoMap: IntelligenceClient,
  cwd: string,
  name: string | undefined,
): Promise<ToolResult> {
  if (!name) {
    return {
      success: false,
      output: "name param required for class_members (class name to inspect)",
      error: "missing name",
    };
  }

  const members = await repoMap.getClassMembers(name);
  if (members.length === 0) {
    return {
      success: true,
      output: `No members found for class "${name}" (class not indexed or has no qualified_name entries).`,
    };
  }

  const symbols = await repoMap.findSymbols(name);
  const classSymbol = symbols.find((s) => s.kind === "class");
  const filePath = classSymbol?.path ?? "";

  const lines: string[] = [];
  if (filePath) {
    const rel = relative(cwd, `${cwd}/${filePath}`);
    lines.push(`Class "${name}" in ${rel} — ${String(members.length)} members:\n`);
  } else {
    lines.push(`Class "${name}" — ${String(members.length)} members:\n`);
  }

  for (const m of members) {
    const exported = m.isExported ? "+" : " ";
    const sig = m.signature
      ? m.signature.replace(/^(export\s+)?(async\s+)?/, (_, _e, a) => a ?? "")
      : `${m.kind} ${m.name}`;
    const span = m.endLine > m.line ? ` (${String(m.endLine - m.line + 1)}L)` : "";
    lines.push(`  ${exported}${m.name} :${String(m.line)}${span} — ${sig}`);
  }

  return { success: true, output: lines.join("\n") };
}

async function symbolSummaries(
  repoMap: IntelligenceClient,
  cwd: string,
  file: string | undefined,
  name: string | undefined,
): Promise<ToolResult> {
  if (!file && !name) {
    return {
      success: false,
      output: "file or name param required for summaries",
      error: "missing params",
    };
  }

  const relFile = file ? (file.startsWith("/") ? relative(cwd, file) : file) : undefined;

  const summaries = await repoMap.getSymbolSummaries(relFile, name);
  if (summaries.length === 0) {
    const target = relFile ?? name ?? "";
    return {
      success: true,
      output: `No semantic summaries found for "${target}". Summaries are generated from doc comments (AST) and synthetic analysis.`,
    };
  }

  const lines: string[] = [];
  if (relFile) {
    lines.push(`Semantic summaries for ${relFile} (${String(summaries.length)} symbols):\n`);
  } else {
    lines.push(`Semantic summaries for "${name}" (${String(summaries.length)} entries):\n`);
  }

  for (const s of summaries) {
    const sourceTag = s.source === "ast" ? "[AST]" : s.source === "llm" ? "[LLM]" : "[SYN]";
    if (relFile) {
      lines.push(`  ${s.symbolName} ${sourceTag} — ${s.summary}`);
    } else {
      lines.push(`  ${s.filePath}  ${s.symbolName} ${sourceTag} — ${s.summary}`);
    }
  }

  return { success: true, output: lines.join("\n") };
}

async function searchSymbols(
  repoMap: IntelligenceClient,
  cwd: string,
  query: string | undefined,
  limit: number | undefined,
): Promise<ToolResult> {
  if (!query) {
    return {
      success: false,
      output: 'name param required for search_symbols (e.g. "build*", "parse*", "detect")',
      error: "missing name",
    };
  }

  const cap = Math.min(limit ?? 20, 30);
  const results = await repoMap.searchSymbolsFts(query, cap);

  if (results.length === 0) {
    return { success: true, output: `No symbols matching "${query}".` };
  }

  const lines = [`${String(results.length)} symbols matching "${query}":\n`];
  for (const r of results) {
    if (isForbidden(r.path) !== null) continue;
    const rel = relative(cwd, `${cwd}/${r.path}`);
    const exported = r.isExported ? "+" : " ";
    lines.push(`  ${exported}${r.kind} ${r.name}  ${rel}:${String(r.line)}`);
  }

  return { success: true, output: lines.join("\n") };
}
