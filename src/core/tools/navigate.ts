import { stat as statAsync } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getCwd } from "../cwd.js";
import { getIntelligenceClient, getIntelligenceRouter } from "../intelligence/index.js";
import type { CallHierarchyItem, SourceLocation, SymbolInfo } from "../intelligence/types.js";
import { isForbidden } from "../security/forbidden.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";
import { fallbackTracked } from "./intelligence-helpers.js";
import { rgBin } from "./util.js";

type NavigateAction =
  | "definition"
  | "references"
  | "symbols"
  | "imports"
  | "exports"
  | "workspace_symbols"
  | "call_hierarchy"
  | "implementation"
  | "type_hierarchy"
  | "search_symbols";

interface NavigateArgs {
  action: NavigateAction;
  symbol?: string;
  file?: string;
  scope?: string;
  query?: string;
}

function formatLocation(loc: SourceLocation): string {
  const end = loc.endLine ? `-${String(loc.endLine)}` : "";
  return `${loc.file}:${String(loc.line)}${end}`;
}

function formatSymbol(s: SymbolInfo): string {
  const endStr = s.location.endLine ? `-${String(s.location.endLine)}` : "";
  const loc = `${s.location.file}:${String(s.location.line)}${endStr}`;
  const container = s.containerName ? ` (in ${s.containerName})` : "";
  return `${s.kind} ${s.name}${container} — ${loc}`;
}

const FILE_REQUIRED_ACTIONS = new Set<NavigateAction>([
  "definition",
  "references",
  "symbols",
  "imports",
  "exports",
  "call_hierarchy",
  "implementation",
  "type_hierarchy",
]);

type RepoMapLike = {
  isReady: boolean;
  findSymbols(name: string): Promise<Array<{ path: string; kind: string; isExported: boolean }>>;
  getFileBlastRadius?(relPath: string): Promise<number>;
  getFileCoChanges?(relPath: string): Promise<Array<{ path: string; count: number }>>;
};

type ResolveResult = { resolved: string } | { candidates: string[] } | null;

// Multi-language definition pattern for rg fallback.
// Covers: TS/JS, Python, Go, Rust, Java/Kotlin/Scala, C/C++, C#, Ruby, PHP, Swift, Elixir, Dart, Zig, Lua
// Each alternative is a language-family keyword set + the symbol name.
const DEFINITION_KEYWORDS = [
  // TS/JS: function, class, interface, type, const, let, var, enum (with optional export/async/abstract/default)
  String.raw`(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|const|let|var|enum)\s+`,
  // Python: def, class (with optional async)
  String.raw`(?:async\s+)?(?:def|class)\s+`,
  // Go: func (with optional receiver), type ... struct/interface
  String.raw`(?:func\s+(?:\([^)]*\)\s+)?|type\s+)`,
  // Rust: fn, struct, trait, type, const, static, enum, mod (with optional pub/async)
  String.raw`(?:pub(?:\([^)]*\)\s+)?)?(?:async\s+)?(?:fn|struct|trait|type|const|static|enum|mod|union)\s+`,
  // Java/Kotlin/Scala: class, interface, enum, record + visibility/abstract
  String.raw`(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|static\s+|final\s+|sealed\s+|data\s+|open\s+|internal\s+)*(?:class|interface|enum|record|object|annotation)\s+`,
  // C/C++: class, struct, enum, namespace, typedef, using + template
  String.raw`(?:class|struct|enum(?:\s+class)?|namespace|typedef|using)\s+`,
  // C#: class, struct, interface, enum, record, delegate
  String.raw`(?:public\s+|private\s+|protected\s+|internal\s+)?(?:abstract\s+|static\s+|sealed\s+|partial\s+)*(?:class|struct|interface|enum|record|delegate)\s+`,
  // Ruby: def, class, module
  String.raw`(?:def\s+(?:self\.)?|class\s+|module\s+)`,
  // PHP: function, class, interface, trait, enum
  String.raw`(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:function|class|interface|trait|enum)\s+`,
  // Swift: func, class, struct, protocol, enum, typealias
  String.raw`(?:public\s+|private\s+|internal\s+|open\s+)?(?:class|struct|protocol|enum|typealias|func)\s+`,
  // Elixir: def, defp, defmodule, defmacro
  String.raw`(?:def|defp|defmodule|defmacro|defstruct)\s+`,
  // Dart: class, mixin, extension, typedef
  String.raw`(?:abstract\s+)?(?:class|mixin|extension|typedef|enum)\s+`,
  // Zig: fn, const (pub optional)
  String.raw`(?:pub\s+)?(?:fn|const)\s+`,
  // Lua: function (local optional)
  String.raw`(?:local\s+)?function\s+(?:\w+[.:])?`,
];

const RG_FILE_TYPES =
  "*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,kts,scala,c,h,cpp,hpp,cc,cxx,cs,rb,php,swift,ex,exs,dart,zig,lua}";

function buildDefinitionPattern(symbol: string): string {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alts = DEFINITION_KEYWORDS.map((kw) => `(?:${kw})`).join("|");
  return `(?:${alts})${escaped}\\b`;
}

async function autoResolveFile(
  client: IntelligenceClient | null,
  symbol: string,
  repoMap?: RepoMapLike,
): Promise<ResolveResult> {
  // Tier 1: Repo map (instant SQLite lookup, ~0ms)
  if (repoMap?.isReady) {
    const matches = await repoMap.findSymbols(symbol);
    if (matches.length === 1) return { resolved: (matches[0] as { path: string }).path };
    if (matches.length > 1) {
      const exported = matches.filter((m) => m.isExported);
      if (exported.length === 1) return { resolved: (exported[0] as { path: string }).path };
      return { candidates: matches.map((m) => m.path) };
    }
  }

  // Tier 2: Workspace symbols via LSP/tree-sitter (~10-50ms)
  let results: SymbolInfo[] | null = null;
  if (client) {
    const tracked = await client.routerFindWorkspaceSymbols(symbol);
    results = tracked?.value ?? null;
  } else {
    const router = getIntelligenceRouter(getCwd());
    const language = router.detectLanguage();
    results = await router.executeWithFallback(language, "findWorkspaceSymbols", (b) =>
      b.findWorkspaceSymbols ? b.findWorkspaceSymbols(symbol) : Promise.resolve(null),
    );
  }

  if (results && results.length > 0) {
    const exact = results.filter((s) => s.name === symbol);
    const matches = exact.length > 0 ? exact : results.slice(0, 1);

    const validFiles: string[] = [];
    for (const m of matches) {
      const f = resolve(m.location.file);
      try {
        const st = await statAsync(f);
        if (st.isFile()) validFiles.push(f);
      } catch {}
    }

    const unique = [...new Set(validFiles)];
    if (unique.length === 1) return { resolved: unique[0] as string };
    if (unique.length > 1) return { candidates: unique };
  }

  // Tier 3: ripgrep with multi-language definition patterns (~50-200ms)
  try {
    const pattern = buildDefinitionPattern(symbol);
    const proc = Bun.spawn(
      [rgBin(), "--files-with-matches", "--glob", RG_FILE_TYPES, pattern, "."],
      {
        cwd: getCwd(),
        stdout: "pipe",
        stderr: "ignore",
        windowsHide: true,
      },
    );
    const text = await new Response(proc.stdout).text();
    const grepMatches = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((p) => resolve(p));
    if (grepMatches.length === 1) return { resolved: grepMatches[0] as string };
    if (grepMatches.length > 1) return { candidates: grepMatches };
  } catch {
    // rg not available
  }

  // Tier 4: Find a file that imports the symbol (~50-200ms)
  // Useful for dependency types (e.g. from node_modules) where the symbol
  // isn't defined in the project but is imported/used. The LSP can then
  // resolve the definition from the usage site.
  try {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const importPattern = `\\b${escaped}\\b`;
    const proc = Bun.spawn(
      [rgBin(), "--files-with-matches", "--glob", RG_FILE_TYPES, importPattern, "."],
      {
        cwd: getCwd(),
        stdout: "pipe",
        stderr: "ignore",
        windowsHide: true,
      },
    );
    const text = await new Response(proc.stdout).text();
    const importMatches = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((p) => resolve(p));
    if (importMatches.length >= 1) return { resolved: importMatches[0] as string };
  } catch {
    // rg not available
  }

  return null;
}

/** Annotate a file path with blast radius + co-changes from the repo map DB. Zero-cost enrichment. */
async function buildAnnotation(
  filePath: string | undefined,
  repoMap: RepoMapLike | undefined,
): Promise<string | null> {
  if (!filePath || !repoMap?.isReady) return null;
  if (!repoMap.getFileBlastRadius || !repoMap.getFileCoChanges) return null;

  try {
    const cwd = getCwd();
    const rel = filePath.startsWith(`${cwd}/`) ? filePath.slice(cwd.length + 1) : filePath;

    const [blastRadius, coChanges] = await Promise.all([
      repoMap.getFileBlastRadius(rel),
      repoMap.getFileCoChanges(rel),
    ]);

    const parts: string[] = [];
    if (blastRadius >= 2) parts.push(`→${String(blastRadius)} dependents`);
    if (coChanges.length > 0) {
      const top = coChanges
        .slice(0, 3)
        .map((c) => c.path.replace(/.*\//, ""))
        .join(", ");
      parts.push(`co-changes: ${top}`);
    }
    if (parts.length === 0) return null;
    return `\n(${parts.join(", ")})`;
  } catch {
    return null;
  }
}

export const navigateTool = {
  name: "navigate",
  description:
    "[TIER-1] LSP-powered symbol lookup. Auto-resolves file from symbol name — just pass the symbol. " +
    "Find where a function is called: references. Find what calls what: call_hierarchy. " +
    "Get type info, props, inherited members from dependencies without reading node_modules. " +
    "Works across project + dependency files (.d.ts, stubs, headers). " +
    "Actions: definition, references, symbols, imports, exports, call_hierarchy, implementation, type_hierarchy, workspace_symbols, search_symbols.",
  execute: async (args: NavigateArgs, repoMap?: RepoMapLike): Promise<ToolResult> => {
    try {
      const client = getIntelligenceClient();
      let file = args.file ? resolve(args.file) : undefined;
      const symbol = args.symbol;

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

      if (!file && FILE_REQUIRED_ACTIONS.has(args.action) && symbol) {
        const resolved = await autoResolveFile(client, symbol, repoMap);
        if (resolved && "resolved" in resolved) {
          file = resolved.resolved;
          const resolvedBlocked = isForbidden(file);
          if (resolvedBlocked) {
            return {
              success: false,
              output: `Access denied: resolved file "${file}" matches forbidden pattern "${resolvedBlocked}"`,
              error: "forbidden",
            };
          }
        } else if (resolved && "candidates" in resolved) {
          const cwd = getCwd();
          const display = resolved.candidates.map((c) =>
            c.startsWith(cwd) ? c.slice(cwd.length + 1) : c,
          );
          return {
            success: false,
            output: `file is required for ${args.action} — '${symbol}' found in multiple files:\n${display.map((f) => `  ${f}`).join("\n")}\nRe-call with file set to the correct one.`,
            error: "ambiguous symbol",
          };
        }
      }

      if (!file && FILE_REQUIRED_ACTIONS.has(args.action)) {
        const hint = symbol ? ` Try workspace_symbols to locate '${symbol}' first.` : "";
        return {
          success: false,
          output: `file is required for ${args.action}.${hint}`,
          error: "missing file",
        };
      }

      // After the guard above, file is guaranteed non-null for FILE_REQUIRED_ACTIONS.
      // Bind to a const so TS narrows it for all case blocks below.
      const resolvedFile = file as string;

      switch (args.action) {
        case "definition": {
          if (!symbol) {
            return {
              success: false,
              output: "symbol is required for definition lookup",
              error: "missing symbol",
            };
          }

          const tracked = client
            ? await client.routerFindDefinition(resolvedFile, symbol)
            : await fallbackTracked(resolvedFile, "findDefinition", (b) =>
                b.findDefinition ? b.findDefinition(resolvedFile, symbol) : Promise.resolve(null),
              );

          if (!tracked) {
            return {
              success: false,
              output: `No definition backend available for this file type. Try navigate(workspace_symbols) to locate the symbol, or read to inspect the source directly.`,
              error: "unsupported",
            };
          }
          if (tracked.value.length === 0) {
            return {
              success: false,
              output: `No definition found for '${symbol}'`,
              error: "not found",
            };
          }

          const defOutput = `Definition of '${symbol}':\n${tracked.value.map(formatLocation).join("\n")}`;
          const annotation = await buildAnnotation(tracked.value[0]?.file, repoMap);
          return {
            success: true,
            output: annotation ? `${defOutput}${annotation}` : defOutput,
            backend: tracked.backend,
          };
        }

        case "references": {
          if (!symbol) {
            return {
              success: false,
              output: "symbol is required for references lookup",
              error: "missing symbol",
            };
          }

          const tracked = client
            ? await client.routerFindReferences(resolvedFile, symbol)
            : await fallbackTracked(resolvedFile, "findReferences", (b) =>
                b.findReferences ? b.findReferences(resolvedFile, symbol) : Promise.resolve(null),
              );

          if (!tracked) {
            return {
              success: false,
              output: `No references backend available for this file type. Try navigate(workspace_symbols) to locate the symbol, or soul_grep to search for usages.`,
              error: "unsupported",
            };
          }
          if (tracked.value.length === 0) {
            return {
              success: false,
              output: `No references found for '${symbol}'`,
              error: "not found",
            };
          }

          const MAX_REFS = 50;
          const refs = tracked.value;
          const capped = refs.length > MAX_REFS ? refs.slice(0, MAX_REFS) : refs;
          const overflow =
            refs.length > MAX_REFS
              ? `\n+ ${String(refs.length - MAX_REFS)} more — narrow your query`
              : "";

          // Fused references + scope: annotate each hit with its enclosing
          // function/class so the agent doesn't follow up with a per-site
          // definition/outline lookup. One symbol-range query per file (soul map
          // cache, zero file I/O), guarded to ≤25 files to bound work.
          const refLines = await formatReferencesWithScope(capped, client);
          const refsOutput = `References to '${symbol}' (${String(refs.length)}):\n${refLines}${overflow}`;
          const refsAnnotation = await buildAnnotation(resolvedFile, repoMap);
          return {
            success: true,
            output: refsAnnotation ? `${refsOutput}${refsAnnotation}` : refsOutput,
            backend: tracked.backend,
          };
        }

        case "symbols": {
          const tracked = client
            ? await client.routerFindSymbols(resolvedFile, args.scope)
            : await fallbackTracked(resolvedFile, "findSymbols", (b) =>
                b.findSymbols ? b.findSymbols(resolvedFile, args.scope) : Promise.resolve(null),
              );

          if (!tracked || tracked.value.length === 0) {
            return { success: true, output: "No symbols found" };
          }

          return {
            success: true,
            output: `Symbols in ${file} (${String(tracked.value.length)}):\n${tracked.value.map(formatSymbol).join("\n")}`,
            backend: tracked.backend,
          };
        }

        case "imports": {
          const tracked = client
            ? await client.routerFindImports(resolvedFile)
            : await fallbackTracked(resolvedFile, "findImports", (b) =>
                b.findImports ? b.findImports(resolvedFile) : Promise.resolve(null),
              );

          if (!tracked || tracked.value.length === 0) {
            return { success: true, output: "No imports found" };
          }

          const lines = tracked.value.map((imp) => {
            const specs = imp.specifiers.length > 0 ? ` { ${imp.specifiers.join(", ")} }` : "";
            return `${imp.source}${specs} — line ${String(imp.location.line)}`;
          });
          return {
            success: true,
            output: `Imports in ${file} (${String(tracked.value.length)}):\n${lines.join("\n")}`,
            backend: tracked.backend,
          };
        }

        case "exports": {
          const tracked = client
            ? await client.routerFindExports(resolvedFile)
            : await fallbackTracked(resolvedFile, "findExports", (b) =>
                b.findExports ? b.findExports(resolvedFile) : Promise.resolve(null),
              );

          if (!tracked || tracked.value.length === 0) {
            return { success: true, output: "No exports found" };
          }

          const lines = tracked.value.map((exp) => {
            const def = exp.isDefault ? " (default)" : "";
            return `${exp.kind} ${exp.name}${def} — line ${String(exp.location.line)}`;
          });
          return {
            success: true,
            output: `Exports from ${file} (${String(tracked.value.length)}):\n${lines.join("\n")}`,
            backend: tracked.backend,
          };
        }

        case "workspace_symbols": {
          const query = args.query ?? args.symbol ?? "";
          if (!query) {
            return {
              success: false,
              output: "query or symbol is required for workspace_symbols",
              error: "missing query",
            };
          }

          const tracked = client
            ? await client.routerFindWorkspaceSymbols(query)
            : await fallbackTracked(undefined, "findWorkspaceSymbols", (b) =>
                b.findWorkspaceSymbols ? b.findWorkspaceSymbols(query) : Promise.resolve(null),
              );

          if (!tracked || tracked.value.length === 0) {
            return { success: true, output: `No workspace symbols matching '${query}'` };
          }

          const MAX_WS_SYMBOLS = 50;
          const wsSyms = tracked.value;
          const cappedWs =
            wsSyms.length > MAX_WS_SYMBOLS ? wsSyms.slice(0, MAX_WS_SYMBOLS) : wsSyms;
          const wsOverflow =
            wsSyms.length > MAX_WS_SYMBOLS
              ? `\n+ ${String(wsSyms.length - MAX_WS_SYMBOLS)} more — narrow your query`
              : "";
          return {
            success: true,
            output: `Workspace symbols matching '${query}' (${String(wsSyms.length)}):\n${cappedWs.map(formatSymbol).join("\n")}${wsOverflow}`,
            backend: tracked.backend,
          };
        }

        case "call_hierarchy": {
          if (!symbol) {
            return {
              success: false,
              output: "symbol is required for call_hierarchy",
              error: "missing symbol",
            };
          }

          const tracked = client
            ? await client.routerGetCallHierarchy(resolvedFile, symbol)
            : await fallbackTracked(resolvedFile, "getCallHierarchy", (b) =>
                b.getCallHierarchy
                  ? b.getCallHierarchy(resolvedFile, symbol)
                  : Promise.resolve(null),
              );

          if (!tracked) {
            return {
              success: false,
              output: "No call hierarchy backend available",
              error: "unsupported",
            };
          }

          const ch = tracked.value;
          const formatCH = (i: CallHierarchyItem) =>
            `${i.kind} ${i.name} — ${i.file}:${String(i.line)}`;
          const parts = [`Call hierarchy for ${ch.item.name}:`];
          if (ch.incoming.length > 0) {
            parts.push(`\nIncoming calls (${String(ch.incoming.length)}):`);
            parts.push(...ch.incoming.map((i) => `  ${formatCH(i)}`));
          }
          if (ch.outgoing.length > 0) {
            parts.push(`\nOutgoing calls (${String(ch.outgoing.length)}):`);
            parts.push(...ch.outgoing.map((i) => `  ${formatCH(i)}`));
          }
          if (ch.incoming.length === 0 && ch.outgoing.length === 0) {
            parts.push("  No incoming or outgoing calls found.");
          }

          return {
            success: true,
            output: parts.join("\n"),
            backend: tracked.backend,
          };
        }

        case "implementation": {
          if (!symbol) {
            return {
              success: false,
              output: "symbol is required for implementation lookup",
              error: "missing symbol",
            };
          }

          const tracked = client
            ? await client.routerFindImplementation(resolvedFile, symbol)
            : await fallbackTracked(resolvedFile, "findImplementation", (b) =>
                b.findImplementation
                  ? b.findImplementation(resolvedFile, symbol)
                  : Promise.resolve(null),
              );

          if (!tracked || tracked.value.length === 0) {
            return {
              success: false,
              output: `No implementations found for '${symbol}' — for interfaces/abstract classes, ensure the editor is open. For concrete symbols, use definition instead.`,
              error: "not found",
            };
          }

          const MAX_IMPLS = 50;
          const impls = tracked.value;
          const cappedImpls = impls.length > MAX_IMPLS ? impls.slice(0, MAX_IMPLS) : impls;
          const implOverflow =
            impls.length > MAX_IMPLS
              ? `\n+ ${String(impls.length - MAX_IMPLS)} more — narrow your query`
              : "";
          return {
            success: true,
            output: `Implementations of '${symbol}' (${String(impls.length)}):\n${cappedImpls.map(formatLocation).join("\n")}${implOverflow}`,
            backend: tracked.backend,
          };
        }

        case "type_hierarchy": {
          if (!symbol) {
            return {
              success: false,
              output: "symbol is required for type_hierarchy",
              error: "missing symbol",
            };
          }

          const tracked = client
            ? await client.routerGetTypeHierarchy(resolvedFile, symbol)
            : await fallbackTracked(resolvedFile, "getTypeHierarchy", (b) =>
                b.getTypeHierarchy
                  ? b.getTypeHierarchy(resolvedFile, symbol)
                  : Promise.resolve(null),
              );

          if (!tracked) {
            return {
              success: false,
              output: "No type hierarchy backend available",
              error: "unsupported",
            };
          }

          const th = tracked.value;
          const parts = [`Type hierarchy for ${th.item.name} (${th.item.kind}):`];
          if (th.supertypes.length > 0) {
            parts.push(`\nSupertypes (${String(th.supertypes.length)}):`);
            for (const s of th.supertypes) {
              parts.push(`  ${s.kind} ${s.name} — ${s.file}:${String(s.line)}`);
            }
          }
          if (th.subtypes.length > 0) {
            parts.push(`\nSubtypes (${String(th.subtypes.length)}):`);
            for (const s of th.subtypes) {
              parts.push(`  ${s.kind} ${s.name} — ${s.file}:${String(s.line)}`);
            }
          }
          if (th.supertypes.length === 0 && th.subtypes.length === 0) {
            parts.push("  No supertypes or subtypes found.");
          }

          return {
            success: true,
            output: parts.join("\n"),
            backend: tracked.backend,
          };
        }

        case "search_symbols": {
          const query = args.query ?? args.symbol ?? "";
          if (!query) {
            return {
              success: false,
              output: "query or symbol is required for search_symbols",
              error: "missing query",
            };
          }

          // Try workspace symbols first (LSP), then fall back to symbol index
          const tracked = client
            ? await client.routerFindWorkspaceSymbols(query)
            : await fallbackTracked(undefined, "findWorkspaceSymbols", (b) =>
                b.findWorkspaceSymbols ? b.findWorkspaceSymbols(query) : Promise.resolve(null),
              );

          if (!tracked || tracked.value.length === 0) {
            return { success: true, output: `No symbols matching '${query}'` };
          }

          const MAX_SEARCH_SYMS = 50;
          const searchSyms = tracked.value;
          const cappedSearch =
            searchSyms.length > MAX_SEARCH_SYMS ? searchSyms.slice(0, MAX_SEARCH_SYMS) : searchSyms;
          const searchOverflow =
            searchSyms.length > MAX_SEARCH_SYMS
              ? `\n+ ${String(searchSyms.length - MAX_SEARCH_SYMS)} more — narrow your query`
              : "";
          return {
            success: true,
            output: `Symbols matching '${query}' (${String(searchSyms.length)}):\n${cappedSearch.map(formatSymbol).join("\n")}${searchOverflow}`,
            backend: tracked.backend,
          };
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
/**
 * Format reference locations, annotating each with its enclosing function/class.
 * Groups hits by file and does one symbol-range lookup per file (soul-map cached).
 * Falls back to plain `file:line` when scope data is unavailable or too many files.
 */
async function formatReferencesWithScope(
  refs: SourceLocation[],
  client: IntelligenceClient | null,
): Promise<string> {
  const byFile = new Map<string, number[]>();
  for (const r of refs) {
    const arr = byFile.get(r.file);
    if (arr) arr.push(r.line);
    else byFile.set(r.file, [r.line]);
  }

  const cwd = getCwd();
  const rel = (f: string) => (f.startsWith(`${cwd}/`) ? f.slice(cwd.length + 1) : f);

  type Range = { name: string; kind: string; line: number; endLine: number | null };
  const scopes = new Map<string, Range[]>();
  if (client && byFile.size <= 25) {
    await Promise.all(
      [...byFile.keys()].map(async (f) => {
        try {
          const ranges = await client.getFileSymbolRanges(rel(f));
          if (ranges && ranges.length > 0) scopes.set(f, ranges);
        } catch {}
      }),
    );
  }

  const enclosing = (f: string, line: number): Range | null => {
    const ranges = scopes.get(f);
    if (!ranges) return null;
    let best: Range | null = null;
    for (const s of ranges) {
      const end = s.endLine ?? s.line;
      if (s.line <= line && end >= line && (!best || s.line > best.line)) best = s;
    }
    return best;
  };

  const out: string[] = [];
  for (const [f, lns] of byFile) {
    lns.sort((a, b) => a - b);
    if (!scopes.has(f)) {
      for (const ln of lns) out.push(`${rel(f)}:${String(ln)}`);
      continue;
    }
    for (const ln of lns) {
      const sc = enclosing(f, ln);
      out.push(sc ? `${rel(f)}:${String(ln)} — ${sc.kind} ${sc.name}` : `${rel(f)}:${String(ln)}`);
    }
  }
  return out.join("\n");
}
