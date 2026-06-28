import type { WorkerHandlerContext } from "./rpc.js";
import { createWorkerHandler } from "./rpc.js";

let repoMap: import("../intelligence/repo-map.js").RepoMap | null = null;
let router: import("../intelligence/router.js").CodeIntelligenceRouter | null = null;
let highlighter: import("shiki").Highlighter | null = null;
let ctx: WorkerHandlerContext;

const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  dockerfile: "docker",
  tf: "terraform",
  cs: "csharp",
  "c++": "cpp",
  "c#": "csharp",
  objc: "objective-c",
};

const SHIKI_LANGS = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "rust",
  "go",
  "bash",
  "json",
  "yaml",
  "toml",
  "html",
  "css",
  "sql",
  "markdown",
  "ruby",
  "java",
  "kotlin",
  "swift",
  "c",
  "cpp",
  "csharp",
  "php",
  "lua",
  "zig",
  "elixir",
  "haskell",
  "ocaml",
  "scala",
  "dart",
  "dockerfile",
  "graphql",
  "terraform",
  "vim",
  "diff",
  "ini",
  "xml",
] as const;

function normalizeLang(lang: string): string {
  const lower = lang.toLowerCase().trim();
  return LANG_ALIASES[lower] ?? lower;
}

async function ensureHighlighter() {
  if (highlighter) return highlighter;
  const { createHighlighter } = await import("shiki");
  // Start with zero languages — load on demand via loadLanguage() below.
  // Eagerly loading 38 grammars costs ~300-400 MB that stays resident forever.
  highlighter = await createHighlighter({
    themes: ["catppuccin-mocha"],
    langs: [],
  });
  return highlighter;
}

async function loadLanguage(hl: Awaited<ReturnType<typeof ensureHighlighter>>, lang: string) {
  if (hl.getLoadedLanguages().includes(lang)) return;
  try {
    await hl.loadLanguage(lang as import("shiki").BundledLanguage);
  } catch {
    // Unknown language — fall back to "text" at call site
  }
}

function requireRepoMap() {
  if (!repoMap) throw new Error("RepoMap not initialized — send init first");
  return repoMap;
}

function requireRouter() {
  if (!router) throw new Error("Router not initialized — send init first");
  return router;
}

const handlers: Record<string, (...args: unknown[]) => unknown> = {
  // ── Core ──
  scan: async () => {
    await requireRepoMap().scan();
  },
  getCwd: () => requireRepoMap().getCwd(),
  close: async () => {
    await requireRepoMap().close();
    repoMap = null;
  },
  clear: () => requireRepoMap().clear(),

  // ── Semantic ──
  setSemanticMode: (mode: unknown) =>
    requireRepoMap().setSemanticMode(mode as "off" | "ast" | "synthetic" | "llm" | "full" | "on"),
  getSemanticMode: () => requireRepoMap().getSemanticMode(),
  isSemanticEnabled: () => requireRepoMap().isSemanticEnabled(),
  detectPersistedSemanticMode: () => requireRepoMap().detectPersistedSemanticMode(),
  generateAstSummaries: () => requireRepoMap().generateAstSummaries(),
  generateSyntheticSummaries: (limit: unknown) =>
    requireRepoMap().generateSyntheticSummaries(limit as number | undefined),
  clearFreeSummaries: () => requireRepoMap().clearFreeSummaries(),
  clearSemanticSummaries: () => requireRepoMap().clearSemanticSummaries(),
  getStaleSummaryCount: () => requireRepoMap().getStaleSummaryCount(),
  getSummaryBreakdown: () => requireRepoMap().getSummaryBreakdown(),

  generateSemanticSummaries: async (maxSymbols: unknown) => {
    const rm = requireRepoMap();
    rm.setSummaryGenerator(async (batch, batchTotal) => {
      return ctx.requestCallback<Array<{ name: string; summary: string }>>(
        "summaryGenerator",
        { batch, batchTotal },
        300_000,
      );
    });
    const count = await rm.generateSemanticSummaries(maxSymbols as number | undefined);
    rm.setSummaryGenerator(null);
    return count;
  },

  // ── File Monitoring ──
  onFileChanged: (absPath: unknown) => requireRepoMap().onFileChanged(absPath as string),
  recheckModifiedFiles: () => requireRepoMap().recheckModifiedFiles(),

  getEntryPoints: () => requireRepoMap().getEntryPoints(),

  // ── Render ──
  render: (opts: unknown) => {
    const repoMap = requireRepoMap();
    const content = repoMap.render(opts as import("../intelligence/repo-map.js").RepoMapOptions);
    return { content, paths: repoMap.lastRenderedPaths };
  },

  // ── Symbol Lookup ──
  findSymbols: (name: unknown) => requireRepoMap().findSymbols(name as string),
  findSymbol: (name: unknown) => requireRepoMap().findSymbol(name as string),
  searchSymbolsSubstring: (query: unknown, limit: unknown) =>
    requireRepoMap().searchSymbolsSubstring(query as string, limit as number | undefined),
  searchTrigramCandidates: (pattern: unknown, limit: unknown) =>
    requireRepoMap().searchTrigramCandidates(pattern as string, limit as number | undefined),
  searchSymbolsFts: (query: unknown, limit: unknown) =>
    requireRepoMap().searchSymbolsFts(query as string, limit as number | undefined),
  getFileSymbols: (relPath: unknown) => requireRepoMap().getFileSymbols(relPath as string),
  getFileSymbolRanges: (relPath: unknown) =>
    requireRepoMap().getFileSymbolRanges(relPath as string),
  getEnclosingSymbols: (relPath: unknown) =>
    requireRepoMap().getEnclosingSymbols(relPath as string),
  resolveMoniker: (moniker: unknown) => requireRepoMap().resolveMoniker(moniker as string),
  getSymbolSignature: (name: unknown) => requireRepoMap().getSymbolSignature(name as string),
  getSymbolsByKind: (kind: unknown, limit: unknown) =>
    requireRepoMap().getSymbolsByKind(kind as string, limit as number | undefined),

  // ── File Analysis ──
  matchFiles: (pattern: unknown, limit: unknown) =>
    requireRepoMap().matchFiles(pattern as string, limit as number | undefined),
  getFileDependents: (relPath: unknown) => requireRepoMap().getFileDependents(relPath as string),
  getFileDependencies: (relPath: unknown) =>
    requireRepoMap().getFileDependencies(relPath as string),
  getFileCoChanges: (relPath: unknown) => requireRepoMap().getFileCoChanges(relPath as string),
  getFileExportCount: (relPath: unknown) => requireRepoMap().getFileExportCount(relPath as string),
  getFileBlastRadius: (relPath: unknown) => requireRepoMap().getFileBlastRadius(relPath as string),
  getFileIdByPath: (relPath: unknown) => requireRepoMap().getFileIdByPath(relPath as string),
  getFilePathById: (id: unknown) => requireRepoMap().getFilePathById(id as number),
  getFileBlastRadiusById: (id: unknown) => requireRepoMap().getFileBlastRadiusById(id as number),
  getFileDiffBlock: (relPath: unknown) => requireRepoMap().getFileDiffBlock(relPath as string),
  getFilesByPackage: (pkg: unknown) => requireRepoMap().getFilesByPackage(pkg as string),
  listDirectory: (dirPath: unknown) => requireRepoMap().listDirectory(dirPath as string),

  // ── Code Analysis ──
  getIdentifierFrequency: (limit: unknown) =>
    requireRepoMap().getIdentifierFrequency(limit as number | undefined),
  getUnusedExports: (limit: unknown) =>
    requireRepoMap().getUnusedExports(limit as number | undefined),
  getTestOnlyExports: () => requireRepoMap().getTestOnlyExports(),
  getDeadBarrels: () => requireRepoMap().getDeadBarrels(),
  getRepeatedFragments: (limit: unknown) =>
    requireRepoMap().getRepeatedFragments(limit as number | undefined),
  getDuplicateStructures: (limit: unknown) =>
    requireRepoMap().getDuplicateStructures(limit as number | undefined),
  getNearDuplicates: (threshold: unknown, limit: unknown) =>
    requireRepoMap().getNearDuplicates(
      threshold as number | undefined,
      limit as number | undefined,
    ),
  getFileDuplicates: (relPath: unknown) => requireRepoMap().getFileDuplicates(relPath as string),
  getCallees: (symbolId: unknown) => requireRepoMap().getCallees(symbolId as number),
  getCalleesForSymbol: (relPath: unknown, symbolName: unknown) =>
    requireRepoMap().getCalleesForSymbol(relPath as string, symbolName as string),
  getCallers: (name: unknown, filePath: unknown) =>
    requireRepoMap().getCallers(name as string, filePath as string | undefined),
  getClassMembers: (className: unknown) => requireRepoMap().getClassMembers(className as string),
  getSymbolSummaries: (file: unknown, name: unknown) =>
    requireRepoMap().getSymbolSummaries(file as string | undefined, name as string | undefined),

  // ── Stats ──
  getStats: () => requireRepoMap().getStats(),
  dbSizeBytes: () => requireRepoMap().dbSizeBytes(),
  getTopFiles: (limit: unknown) => requireRepoMap().getTopFiles(limit as number | undefined),
  getExternalPackages: (limit: unknown) =>
    requireRepoMap().getExternalPackages(limit as number | undefined),

  // ── Ready State ──
  getIsReady: () => requireRepoMap().isReady,

  // ── Intelligence Router Operations ──
  // These run the full backend fallback chain (LSP → ts-morph → tree-sitter → regex)
  // entirely in this worker thread, keeping the main/UI thread free.

  routerDetectLanguage: (file: unknown) =>
    requireRouter().detectLanguage(file as string | undefined),

  routerFindSymbols: async (file: unknown, query: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "findSymbols",
      (b) => b.findSymbols?.(file as string, query as string | undefined) ?? Promise.resolve(null),
    );
  },

  routerFindDefinition: async (file: unknown, symbol: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "findDefinition",
      (b) => b.findDefinition?.(file as string, symbol as string) ?? Promise.resolve(null),
    );
  },

  routerFindReferences: async (file: unknown, symbol: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "findReferences",
      (b) => b.findReferences?.(file as string, symbol as string) ?? Promise.resolve(null),
    );
  },

  routerGetDiagnostics: async (file: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "getDiagnostics",
      (b) => b.getDiagnostics?.(file as string) ?? Promise.resolve(null),
    );
  },

  routerGetFileOutline: async (file: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "getFileOutline",
      (b) => b.getFileOutline?.(file as string) ?? Promise.resolve(null),
    );
  },

  routerFindImports: async (file: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "findImports",
      (b) => b.findImports?.(file as string) ?? Promise.resolve(null),
    );
  },

  routerFindExports: async (file: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "findExports",
      (b) => b.findExports?.(file as string) ?? Promise.resolve(null),
    );
  },

  routerGetTypeInfo: async (file: unknown, symbol: unknown, line: unknown, column: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "getTypeInfo",
      (b) =>
        b.getTypeInfo?.(
          file as string,
          symbol as string,
          line as number | undefined,
          column as number | undefined,
        ) ?? Promise.resolve(null),
    );
  },

  routerFindUnused: async (file: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "findUnused",
      (b) => b.findUnused?.(file as string) ?? Promise.resolve(null),
    );
  },

  routerRename: async (file: unknown, symbol: unknown, newName: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "rename",
      (b) =>
        b.rename?.(file as string, symbol as string, newName as string) ?? Promise.resolve(null),
    );
  },

  routerGetCodeActions: async (file: unknown, startLine: unknown, endLine: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "getCodeActions",
      (b) =>
        b.getCodeActions?.(file as string, startLine as number, endLine as number) ??
        Promise.resolve(null),
    );
  },

  routerFormatDocument: async (file: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "formatDocument",
      (b) => b.formatDocument?.(file as string) ?? Promise.resolve(null),
    );
  },

  routerFormatRange: async (file: unknown, startLine: unknown, endLine: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "formatRange",
      (b) =>
        b.formatRange?.(file as string, startLine as number, endLine as number) ??
        Promise.resolve(null),
    );
  },

  routerFindWorkspaceSymbols: async (query: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage();
    return r.executeWithFallbackTracked(
      lang,
      "findWorkspaceSymbols",
      (b) => b.findWorkspaceSymbols?.(query as string) ?? Promise.resolve(null),
    );
  },

  routerGetCallHierarchy: async (file: unknown, symbol: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "getCallHierarchy",
      (b) => b.getCallHierarchy?.(file as string, symbol as string) ?? Promise.resolve(null),
    );
  },

  routerGetTypeHierarchy: async (file: unknown, symbol: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "getTypeHierarchy",
      (b) => b.getTypeHierarchy?.(file as string, symbol as string) ?? Promise.resolve(null),
    );
  },

  routerFindImplementation: async (file: unknown, symbol: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "findImplementation",
      (b) => b.findImplementation?.(file as string, symbol as string) ?? Promise.resolve(null),
    );
  },

  routerGetFileRenameEdits: async (files: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage((files as Array<{ oldPath: string }>)[0]?.oldPath);
    return r.executeWithFallbackTracked(
      lang,
      "getFileRenameEdits",
      (b) =>
        b.getFileRenameEdits?.(files as Array<{ oldPath: string; newPath: string }>) ??
        Promise.resolve(null),
    );
  },

  routerNotifyFilesRenamed: (files: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage((files as Array<{ oldPath: string }>)[0]?.oldPath);
    r.executeWithFallback(lang, "notifyFilesRenamed", (b) => {
      b.notifyFilesRenamed?.(files as Array<{ oldPath: string; newPath: string }>);
      return Promise.resolve(null);
    });
  },

  routerInvalidateFileCache: (file: unknown) => {
    requireRouter().fileCache.invalidate(file as string);
  },

  routerExtractFunction: async (
    file: unknown,
    startLine: unknown,
    endLine: unknown,
    functionName: unknown,
  ) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "extractFunction",
      (b) =>
        b.extractFunction?.(
          file as string,
          startLine as number,
          endLine as number,
          functionName as string,
        ) ?? Promise.resolve(null),
    );
  },

  routerExtractVariable: async (
    file: unknown,
    startLine: unknown,
    endLine: unknown,
    variableName: unknown,
  ) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "extractVariable",
      (b) =>
        b.extractVariable?.(
          file as string,
          startLine as number,
          endLine as number,
          variableName as string,
        ) ?? Promise.resolve(null),
    );
  },

  routerOrganizeImports: async (file: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "organizeImports",
      (b) => b.organizeImports?.(file as string) ?? Promise.resolve(null),
    );
  },

  routerFixAll: async (file: unknown) => {
    const r = requireRouter();
    const lang = r.detectLanguage(file as string);
    return r.executeWithFallbackTracked(
      lang,
      "fixAll",
      (b) => b.fixAll?.(file as string) ?? Promise.resolve(null),
    );
  },

  // Router management
  routerGetStatus: () => requireRouter().getStatus(),
  routerGetDetailedLspServers: () => requireRouter().getDetailedLspServers(),
  routerRestartLspServers: (filter: unknown) =>
    requireRouter().restartLspServers(filter as string | undefined),
  routerGetChildPids: () => requireRouter().getChildPids(),
  routerGetAvailableBackends: (language: unknown) =>
    requireRouter().getAvailableBackends(language as import("../intelligence/types.js").Language),
  routerWarmup: () => requireRouter().warmup(),
  routerRunHealthCheck: () => requireRouter().runHealthCheck(),

  // ── Shiki Highlighting ──
  codeToAnsi: async (code: unknown, lang: unknown) => {
    const hl = await ensureHighlighter();
    const normalized = lang ? normalizeLang(lang as string) : "text";
    if (normalized !== "text") await loadLanguage(hl, normalized);
    const langId = hl.getLoadedLanguages().includes(normalized) ? normalized : "text";
    try {
      const RST = "\x1b[0m";
      const result = hl.codeToTokens(code as string, {
        lang: langId as import("shiki").BundledLanguage,
        theme: "catppuccin-mocha",
      });
      const lines: string[] = [];
      for (const line of result.tokens) {
        let lineStr = "";
        for (const token of line) {
          if (token.color) {
            const h = token.color.startsWith("#") ? token.color.slice(1) : token.color;
            const r = Number.parseInt(h.slice(0, 2), 16);
            const g = Number.parseInt(h.slice(2, 4), 16);
            const b = Number.parseInt(h.slice(4, 6), 16);
            lineStr += `\x1b[38;2;${String(r)};${String(g)};${String(b)}m${token.content}${RST}`;
          } else {
            lineStr += token.content;
          }
        }
        lines.push(lineStr);
      }
      return lines.join("\n");
    } catch {
      return code as string;
    }
  },

  codeToStyledTokens: async (code: unknown, lang: unknown) => {
    const hl = await ensureHighlighter();
    const normalized = lang ? normalizeLang(lang as string) : "text";
    if (normalized !== "text") await loadLanguage(hl, normalized);
    const langId = hl.getLoadedLanguages().includes(normalized) ? normalized : "text";
    try {
      const result = hl.codeToTokens(code as string, {
        lang: langId as import("shiki").BundledLanguage,
        theme: "catppuccin-mocha",
      });
      return result.tokens.map((line) =>
        line.map((token) => ({
          content: token.content,
          color: token.color ?? undefined,
        })),
      );
    } catch {
      return (code as string).split("\n").map((line) => [{ content: line }]);
    }
  },

  isShikiLanguage: async (lang: unknown) => {
    const normalized = normalizeLang(lang as string);
    return (SHIKI_LANGS as readonly string[]).includes(normalized);
  },
};

ctx = createWorkerHandler(
  handlers,
  async (config) => {
    const cwd = config.cwd as string;

    const { initForbidden } = await import("../security/forbidden.js");
    initForbidden(cwd);

    // Initialize RepoMap (SQLite index)
    const { RepoMap } = await import("../intelligence/repo-map.js");
    repoMap = new RepoMap(cwd);
    if (typeof config.maxFiles === "number" && config.maxFiles > 0) {
      repoMap.maxFiles = config.maxFiles;
    }

    // Seed from DB so stats are correct immediately (e.g. after worker restart
    // where the DB has data but no files need re-indexing).
    let lastStats = repoMap.getStats();
    let lastDbSize = repoMap.dbSizeBytes();

    repoMap.onProgress = (indexed, total) => {
      const rm = repoMap;
      if (!rm) return;
      // Negative sentinels are heartbeats from post-indexing phases.
      // Skip expensive DB stats queries for heartbeats — they can fail
      // inside write transactions and would kill the heartbeat silently.
      if (indexed < 0) {
        ctx.emit("progress", { indexed, total, stats: lastStats, dbSize: lastDbSize });
        return;
      }
      try {
        lastStats = rm.getStats();
        lastDbSize = rm.dbSizeBytes();
      } catch {}
      ctx.emit("progress", { indexed, total, stats: lastStats, dbSize: lastDbSize });
    };
    repoMap.onScanComplete = (success) => {
      const rm = repoMap;
      if (!rm) return;
      const stats = rm.getStats();
      const dbSize = rm.dbSizeBytes();
      ctx.emit("scan-complete", { success, stats, dbSize, isReady: rm.isReady });
    };
    repoMap.onStaleSymbols = (count) => {
      ctx.emit("stale-symbols", { count });
    };
    repoMap.onError = (message) => {
      ctx.emit("index-error", { message });
    };

    // Initialize CodeIntelligenceRouter with all backends
    // This runs the full backend chain in the worker thread,
    // keeping the main/UI thread free from parsing and LSP work.
    const { CodeIntelligenceRouter } = await import("../intelligence/router.js");
    const { LspBackend } = await import("../intelligence/backends/lsp/index.js");
    const { TsMorphBackend } = await import("../intelligence/backends/ts-morph.js");
    const { TreeSitterBackend } = await import("../intelligence/backends/tree-sitter.js");
    const { RegexBackend } = await import("../intelligence/backends/regex.js");

    router = new CodeIntelligenceRouter(cwd);
    router.registerBackend(new LspBackend());
    router.registerBackend(new TsMorphBackend());
    router.registerBackend(new TreeSitterBackend());
    const regex = new RegexBackend();
    regex.setCache(router.fileCache);
    router.registerBackend(regex);

    // Fire-and-forget warmup — spawns LSP servers in background
    router.warmup().catch(() => {});
  },
  async () => {
    if (router) {
      router.dispose();
      router = null;
    }
    if (repoMap) {
      await repoMap.close();
      repoMap = null;
    }
  },
);
