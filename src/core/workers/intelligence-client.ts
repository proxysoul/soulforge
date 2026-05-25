import { join } from "node:path";
import { logBackgroundError } from "../../stores/errors.js";
import { useWorkerStore } from "../../stores/workers.js";
import type { RepoMapOptions, SymbolForSummary } from "../intelligence/repo-map.js";
import type { HealthCheckResult } from "../intelligence/router.js";
import type {
  CallHierarchyResult,
  CodeAction,
  Diagnostic,
  ExportInfo,
  FileOutline,
  FormatEdit,
  ImportInfo,
  Language,
  RefactorResult,
  SourceLocation,
  SymbolInfo,
  TypeHierarchyResult,
  TypeInfo,
  UnusedItem,
} from "../intelligence/types.js";
import { dataDir, isCompiledBinary } from "../platform/index.js";
import { WorkerClient } from "./rpc.js";

export type TrackedResult<T> = { value: T; backend: string } | null;

const IS_COMPILED = isCompiledBinary(import.meta.url);
const IS_DIST =
  !IS_COMPILED && (import.meta.dir.includes("/dist") || import.meta.dir.includes("\\dist"));

type SummaryGenerator = (
  batch: SymbolForSummary[],
  batchTotal?: number,
) => Promise<Array<{ name: string; summary: string }>>;

interface RepoMapStats {
  files: number;
  symbols: number;
  edges: number;
  summaries: number;
  calls: number;
}

interface SummaryBreakdown {
  ast: number;
  llm: number;
  synthetic: number;
  lsp: number;
  total: number;
  eligible: number;
}

export class IntelligenceClient extends WorkerClient {
  // Cached sync values (pushed from worker via events)
  private _isReady = false;
  private _cwd: string;
  private _stats: RepoMapStats = { files: 0, symbols: 0, edges: 0, summaries: 0, calls: 0 };
  private _dbSize = 0;
  private _semanticMode: "off" | "ast" | "synthetic" | "llm" | "full" | "on" = "synthetic";
  private _symbolCache = new Map<
    string,
    Array<{ name: string; kind: string; isExported: boolean; line: number; endLine: number }>
  >();
  private _heapWatchdog: ReturnType<typeof setInterval> | null = null;

  /** Heap threshold in bytes. When the worker exceeds this, it gets recycled. */
  private static readonly HEAP_LIMIT = 6 * 1024 * 1024 * 1024; // 6 GB
  private static readonly HEAP_CHECK_INTERVAL = 30_000; // 30s

  onProgress: ((indexed: number, total: number) => void) | null = null;
  onScanComplete: ((success: boolean) => void) | null = null;
  onStaleSymbols: ((count: number) => void) | null = null;

  // Large repos (React: 6k files, 36k symbols) have post-indexing phases
  // with heavy synchronous SQLite transactions that block the worker thread
  // for minutes at a time — no heartbeats can be delivered during these.
  // Worker crash detection (handleWorkerClose/handleWorkerError) is the
  // primary safety net. This timeout is a last resort for true hangs.
  private static readonly SCAN_IDLE_TIMEOUT = 600_000; // 10 min

  constructor(cwd: string) {
    const workerPath = IS_COMPILED
      ? join(dataDir(), "workers", "intelligence.worker.js")
      : IS_DIST
        ? join(import.meta.dir, "workers", "intelligence.worker.js")
        : join(import.meta.dir, "intelligence.worker.ts");
    super(workerPath, { cwd });
    this._cwd = cwd;

    const ws = useWorkerStore.getState();
    ws.markStarted("intelligence");

    this.onStatusChange = (status) => {
      const store = useWorkerStore.getState();
      switch (status) {
        case "starting":
          store.setWorkerStatus("intelligence", "starting");
          break;
        case "ready":
          store.markStarted("intelligence");
          break;
        case "crashed":
          store.setWorkerError("intelligence", "Worker crashed unexpectedly");
          break;
        case "restarting":
          store.incrementRestarts("intelligence");
          store.setWorkerStatus("intelligence", "restarting");
          break;
      }
    };

    this.onRpcStart = () => {
      useWorkerStore.getState().updateRpcInFlight("intelligence", 1);
    };
    this.onRpcEnd = (error) => {
      const store = useWorkerStore.getState();
      store.updateRpcInFlight("intelligence", -1);
      store.incrementCalls("intelligence");
      if (error) store.incrementErrors("intelligence");
    };

    this.on("init-error", (data) => {
      const d = data as { message: string };
      useWorkerStore.getState().setWorkerError("intelligence", d.message);
    });

    this.startHeapWatchdog();

    this.on("progress", (data) => {
      const d = data as {
        indexed: number;
        total: number;
        stats: RepoMapStats;
        dbSize: number;
      };
      this._stats = d.stats;
      this._dbSize = d.dbSize;
      this.onProgress?.(d.indexed, d.total);
    });

    this.on("scan-complete", (data) => {
      const d = data as {
        success: boolean;
        stats: RepoMapStats;
        dbSize: number;
        isReady: boolean;
      };
      this._isReady = d.isReady;
      this._stats = d.stats;
      this._dbSize = d.dbSize;
      if (d.success) this.resetRestartCount();
      this.onScanComplete?.(d.success);
    });

    this.on("stale-symbols", (data) => {
      const d = data as { count: number };
      this.onStaleSymbols?.(d.count);
    });

    this.on("index-error", (data) => {
      const d = data as { message: string };
      logBackgroundError("Soul Map", d.message);
    });
  }

  // ── Cached Sync Getters ────────────────────────────────────────────

  get isReady(): boolean {
    return this._isReady;
  }

  getCwd(): string {
    return this._cwd;
  }

  // ── Core ───────────────────────────────────────────────────────────

  async scan(): Promise<void> {
    // Activity-based timeout: resets every time a progress event arrives.
    // Large repos can take 30+ min — stays alive as long as progress is made.
    // Only aborts if no progress for SCAN_IDLE_TIMEOUT (scan is stuck).
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectScan: ((err: Error) => void) | undefined;
    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        this.off("progress", resetTimer);
        const err = new Error("Soul map scan stalled — no progress for 2 minutes");
        logBackgroundError("Soul Map", err.message);
        rejectScan?.(err);
      }, IntelligenceClient.SCAN_IDLE_TIMEOUT);
    };
    this.on("progress", resetTimer);
    resetTimer();
    try {
      await Promise.race([
        this.callWithTimeout<void>(24 * 60 * 60_000, "scan"),
        new Promise<never>((_, reject) => {
          rejectScan = reject;
        }),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logBackgroundError("Soul Map", `Scan failed: ${msg}`);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      this.off("progress", resetTimer);
    }
  }

  async close(): Promise<void> {
    if (this._heapWatchdog) {
      clearInterval(this._heapWatchdog);
      this._heapWatchdog = null;
    }
    try {
      await this.call<void>("close");
    } catch {
      // Worker may already be dead — still need to dispose
    }
    this.dispose();
  }

  /**
   * Periodically check worker heap. If it exceeds HEAP_LIMIT, recycle the
   * worker. RepoMap state lives in SQLite — survives restart. ts-morph and
   * shiki rebuild lazily on next use. Users see a brief "restarting" status
   * instead of 20+ GB memory and a warm laptop.
   */
  private startHeapWatchdog(): void {
    this._heapWatchdog = setInterval(async () => {
      try {
        // Only recycle when idle — never kill mid-operation.
        const wk = useWorkerStore.getState().intelligence;
        if (wk.rpcInFlight > 0) return;

        const mem = await this.queryMemory();
        if (mem.heapUsed > IntelligenceClient.HEAP_LIMIT) {
          // Re-check idle after the async queryMemory round-trip
          if (useWorkerStore.getState().intelligence.rpcInFlight > 0) return;

          logBackgroundError(
            "Intelligence",
            `Worker heap ${Math.round(mem.heapUsed / 1024 / 1024)}MB exceeds ${Math.round(IntelligenceClient.HEAP_LIMIT / 1024 / 1024)}MB limit — recycling`,
          );
          this.recycleWorker();
        }
      } catch {
        // Worker might be mid-restart or crashed — skip this cycle
      }
    }, IntelligenceClient.HEAP_CHECK_INTERVAL);
  }

  /** Force-restart the worker to reclaim memory. Safe — SQLite state persists. */
  private recycleWorker(): void {
    this._symbolCache.clear();
    this._isReady = false;
    this.resetRestartCount();
    this.tryRestart();
  }

  clear(): Promise<void> {
    return this.call<void>("clear");
  }

  // ── Semantic ───────────────────────────────────────────────────────

  setSemanticMode(mode: "off" | "ast" | "synthetic" | "llm" | "full" | "on"): void {
    this._semanticMode = mode;
    this.fire("setSemanticMode", mode);
  }

  getSemanticMode(): "off" | "ast" | "synthetic" | "llm" | "full" | "on" {
    return this._semanticMode;
  }

  isSemanticEnabled(): boolean {
    return this._semanticMode !== "off";
  }

  async detectPersistedSemanticMode(): Promise<
    "off" | "ast" | "synthetic" | "llm" | "full" | "on"
  > {
    const mode = await this.call<"off" | "ast" | "synthetic" | "llm" | "full" | "on">(
      "detectPersistedSemanticMode",
    );
    this._semanticMode = mode;
    return mode;
  }

  setSummaryGenerator(generator: SummaryGenerator | null): void {
    if (generator) {
      this.registerCallback("summaryGenerator", async (data) => {
        const { batch, batchTotal } = data as {
          batch: SymbolForSummary[];
          batchTotal?: number;
        };
        return generator(batch, batchTotal);
      });
    }
  }

  async generateAstSummaries(): Promise<number> {
    return this.call<number>("generateAstSummaries");
  }

  async generateSyntheticSummaries(limit?: number): Promise<number> {
    return this.call<number>("generateSyntheticSummaries", limit);
  }

  async generateSemanticSummaries(maxSymbols?: number): Promise<number> {
    return this.callWithTimeout<number>(300_000, "generateSemanticSummaries", maxSymbols);
  }

  clearFreeSummaries(): void {
    this.fire("clearFreeSummaries");
  }

  clearSemanticSummaries(): void {
    this.fire("clearSemanticSummaries");
  }

  async getStaleSummaryCount(): Promise<number> {
    return this.call<number>("getStaleSummaryCount");
  }

  async getSummaryBreakdown(): Promise<SummaryBreakdown> {
    return this.call<SummaryBreakdown>("getSummaryBreakdown");
  }

  // ── File Monitoring ────────────────────────────────────────────────

  onFileChanged(absPath: string): void {
    const rel = absPath.startsWith(`${this._cwd}/`) ? absPath.slice(this._cwd.length + 1) : absPath;
    this._symbolCache.delete(rel);
    this.fire("onFileChanged", absPath);
  }

  recheckModifiedFiles(): void {
    this.fire("recheckModifiedFiles");
  }

  // ── Render ─────────────────────────────────────────────────────────

  async render(opts: RepoMapOptions = {}): Promise<{ content: string; paths: string[] }> {
    return this.call<{ content: string; paths: string[] }>("render", opts);
  }

  // ── Symbol Lookup ──────────────────────────────────────────────────

  async findSymbols(
    name: string,
  ): Promise<Array<{ path: string; kind: string; isExported: boolean; pagerank: number }>> {
    return this.call("findSymbols", name);
  }

  async findSymbol(name: string): Promise<string | null> {
    return this.call("findSymbol", name);
  }

  async searchSymbolsSubstring(
    query: string,
    limit?: number,
  ): Promise<
    Array<{ name: string; path: string; kind: string; isExported: boolean; pagerank: number }>
  > {
    return this.call("searchSymbolsSubstring", query, limit);
  }

  async getFileSymbols(
    relPath: string,
  ): Promise<
    Array<{ name: string; kind: string; isExported: boolean; line: number; endLine: number }>
  > {
    const symbols = await this.call<
      Array<{ name: string; kind: string; isExported: boolean; line: number; endLine: number }>
    >("getFileSymbols", relPath);
    this._symbolCache.set(relPath, symbols);
    return symbols;
  }

  getFileSymbolsCached(
    relPath: string,
  ): Array<{ name: string; kind: string; isExported: boolean; line: number; endLine: number }> {
    return this._symbolCache.get(relPath) ?? [];
  }

  async getFileSymbolRanges(relPath: string): Promise<
    Array<{
      name: string;
      qualifiedName: string | null;
      kind: string;
      line: number;
      endLine: number | null;
    }>
  > {
    return this.call("getFileSymbolRanges", relPath);
  }

  async searchSymbolsFts(
    query: string,
    limit?: number,
  ): Promise<
    Array<{
      name: string;
      path: string;
      kind: string;
      line: number;
      isExported: boolean;
      pagerank: number;
    }>
  > {
    return this.call("searchSymbolsFts", query, limit);
  }

  async getSymbolSignature(
    name: string,
  ): Promise<Array<{ path: string; kind: string; signature: string | null; line: number }>> {
    return this.call("getSymbolSignature", name);
  }

  async getSymbolsByKind(
    kind: string,
    limit?: number,
  ): Promise<Array<{ name: string; path: string; signature: string | null; line: number }>> {
    return this.call("getSymbolsByKind", kind, limit);
  }

  // ── File Analysis ──────────────────────────────────────────────────

  async matchFiles(pattern: string, limit?: number): Promise<string[]> {
    return this.call("matchFiles", pattern, limit);
  }

  async getFileDependents(relPath: string): Promise<Array<{ path: string; weight: number }>> {
    return this.call("getFileDependents", relPath);
  }

  async getFileDependencies(relPath: string): Promise<Array<{ path: string; weight: number }>> {
    return this.call("getFileDependencies", relPath);
  }

  async getFileCoChanges(relPath: string): Promise<Array<{ path: string; count: number }>> {
    return this.call("getFileCoChanges", relPath);
  }

  async getFileExportCount(relPath: string): Promise<number> {
    return this.call("getFileExportCount", relPath);
  }

  async getFileBlastRadius(relPath: string): Promise<number> {
    return this.call("getFileBlastRadius", relPath);
  }

  async getFileIdByPath(relPath: string): Promise<number | null> {
    return this.call("getFileIdByPath", relPath);
  }

  async getFilePathById(id: number): Promise<string | null> {
    return this.call("getFilePathById", id);
  }

  async getFileBlastRadiusById(id: number): Promise<number> {
    return this.call("getFileBlastRadiusById", id);
  }

  async getFileDiffBlock(relPath: string): Promise<{
    blastRadius: number;
    symbols: Array<{ name: string; kind: string; signature: string | null; line: number }>;
  }> {
    return this.call("getFileDiffBlock", relPath);
  }

  async getFilesByPackage(pkg: string): Promise<Array<{ path: string; specifiers: string }>> {
    return this.call("getFilesByPackage", pkg);
  }

  async listDirectory(dirPath: string): Promise<Array<{
    name: string;
    type: "file" | "dir";
    language?: string;
    lines?: number;
    symbols?: number;
    importance?: number;
  }> | null> {
    return this.call("listDirectory", dirPath);
  }

  // ── Code Analysis ─────────────────────────────────────────────────

  async getIdentifierFrequency(
    limit?: number,
  ): Promise<Array<{ name: string; fileCount: number }>> {
    return this.call("getIdentifierFrequency", limit);
  }

  async getUnusedExports(limit?: number): Promise<
    Array<{
      name: string;
      path: string;
      kind: string;
      line: number;
      endLine: number;
      lineCount: number;
      usedInternally: boolean;
    }>
  > {
    return this.call("getUnusedExports", limit);
  }

  async getTestOnlyExports(): Promise<
    Array<{ name: string; path: string; kind: string; line: number; endLine: number }>
  > {
    return this.call("getTestOnlyExports");
  }

  async getDeadBarrels(): Promise<Array<{ path: string; lineCount: number; language: string }>> {
    return this.call("getDeadBarrels");
  }

  async getRepeatedFragments(limit?: number): Promise<
    Array<{
      count: number;
      locations: Array<{ name: string; path: string; line: number }>;
    }>
  > {
    return this.call("getRepeatedFragments", limit);
  }

  async getDuplicateStructures(limit?: number): Promise<
    Array<{
      shapeHash: string;
      kind: string;
      nodeCount: number;
      members: Array<{ name: string; path: string; line: number; endLine: number }>;
    }>
  > {
    return this.call("getDuplicateStructures", limit);
  }

  async getNearDuplicates(
    threshold?: number,
    limit?: number,
  ): Promise<
    Array<{
      similarity: number;
      a: { name: string; path: string; line: number; endLine: number };
      b: { name: string; path: string; line: number; endLine: number };
    }>
  > {
    return this.call("getNearDuplicates", threshold, limit);
  }

  async getFileDuplicates(relPath: string): Promise<
    Array<{
      name: string;
      line: number;
      similarity: number;
      clones: Array<{ name: string; path: string; line: number }>;
    }>
  > {
    return this.call("getFileDuplicates", relPath);
  }

  async getCalleesForSymbol(
    relPath: string,
    symbolName: string,
  ): Promise<Array<{ calleeName: string }>> {
    return this.call("getCalleesForSymbol", relPath, symbolName);
  }

  async getCallees(symbolId: number): Promise<
    Array<{
      calleeName: string;
      calleeFile: string;
      calleeLine: number;
      callLine: number;
    }>
  > {
    return this.call("getCallees", symbolId);
  }

  async getCallers(
    name: string,
    filePath?: string,
  ): Promise<
    Array<{
      callerName: string;
      callerPath: string;
      callerLine: number;
      callLine: number;
    }>
  > {
    return this.call("getCallers", name, filePath);
  }

  async getClassMembers(className: string): Promise<
    Array<{
      name: string;
      kind: string;
      line: number;
      endLine: number;
      signature: string | null;
      isExported: boolean;
    }>
  > {
    return this.call("getClassMembers", className);
  }

  async getSymbolSummaries(
    file?: string,
    name?: string,
  ): Promise<
    Array<{
      symbolName: string;
      filePath: string;
      summary: string;
      source: string;
    }>
  > {
    return this.call("getSymbolSummaries", file, name);
  }

  // ── Stats ──────────────────────────────────────────────────────────

  async getStats(): Promise<RepoMapStats> {
    const stats = await this.call<RepoMapStats>("getStats");
    this._stats = stats;
    return stats;
  }

  getStatsCached(): RepoMapStats {
    return this._stats;
  }

  async dbSizeBytes(): Promise<number> {
    const size = await this.call<number>("dbSizeBytes");
    this._dbSize = size;
    return size;
  }

  dbSizeBytesCached(): number {
    return this._dbSize;
  }

  async getTopFiles(limit?: number): Promise<
    Array<{
      path: string;
      pagerank: number;
      lines: number;
      symbols: number;
      language: string;
    }>
  > {
    return this.call("getTopFiles", limit);
  }

  async getExternalPackages(
    limit?: number,
  ): Promise<Array<{ package: string; fileCount: number; specifiers: string[] }>> {
    return this.call("getExternalPackages", limit);
  }

  // ── Shiki Highlighting ─────────────────────────────────────────────

  async codeToAnsi(code: string, lang?: string): Promise<string> {
    return this.call("codeToAnsi", code, lang);
  }

  async codeToStyledTokens(
    code: string,
    lang?: string,
  ): Promise<Array<Array<{ content: string; color?: string }>>> {
    return this.call("codeToStyledTokens", code, lang);
  }

  async isShikiLanguage(lang: string): Promise<boolean> {
    return this.call("isShikiLanguage", lang);
  }

  // ── Intelligence Router Operations ────────────────────────────────
  // These proxy to the CodeIntelligenceRouter running in the worker thread.
  // All parsing, LSP, and symbol resolution happens off the main/UI thread.

  async routerDetectLanguage(file?: string): Promise<Language> {
    return this.call("routerDetectLanguage", file);
  }

  async routerFindSymbols(file: string, query?: string): Promise<TrackedResult<SymbolInfo[]>> {
    return this.call("routerFindSymbols", file, query);
  }

  async routerFindDefinition(
    file: string,
    symbol: string,
  ): Promise<TrackedResult<SourceLocation[]>> {
    return this.call("routerFindDefinition", file, symbol);
  }

  async routerFindReferences(
    file: string,
    symbol: string,
  ): Promise<TrackedResult<SourceLocation[]>> {
    return this.call("routerFindReferences", file, symbol);
  }

  async routerGetDiagnostics(file: string): Promise<TrackedResult<Diagnostic[]>> {
    return this.call("routerGetDiagnostics", file);
  }

  async routerGetFileOutline(file: string): Promise<TrackedResult<FileOutline>> {
    return this.call("routerGetFileOutline", file);
  }

  async routerFindImports(file: string): Promise<TrackedResult<ImportInfo[]>> {
    return this.call("routerFindImports", file);
  }

  async routerFindExports(file: string): Promise<TrackedResult<ExportInfo[]>> {
    return this.call("routerFindExports", file);
  }

  async routerGetTypeInfo(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<TrackedResult<TypeInfo>> {
    return this.call("routerGetTypeInfo", file, symbol, line, column);
  }

  async routerFindUnused(file: string): Promise<TrackedResult<UnusedItem[]>> {
    return this.call("routerFindUnused", file);
  }

  async routerRename(
    file: string,
    symbol: string,
    newName: string,
  ): Promise<TrackedResult<RefactorResult>> {
    return this.call("routerRename", file, symbol, newName);
  }

  async routerGetCodeActions(
    file: string,
    startLine: number,
    endLine: number,
  ): Promise<TrackedResult<CodeAction[]>> {
    return this.call("routerGetCodeActions", file, startLine, endLine);
  }

  async routerFormatDocument(file: string): Promise<TrackedResult<FormatEdit>> {
    return this.call("routerFormatDocument", file);
  }

  async routerFormatRange(
    file: string,
    startLine: number,
    endLine: number,
  ): Promise<TrackedResult<FormatEdit>> {
    return this.call("routerFormatRange", file, startLine, endLine);
  }

  async routerFindWorkspaceSymbols(query: string): Promise<TrackedResult<SymbolInfo[]>> {
    return this.call("routerFindWorkspaceSymbols", query);
  }

  async routerGetCallHierarchy(
    file: string,
    symbol: string,
  ): Promise<TrackedResult<CallHierarchyResult>> {
    return this.call("routerGetCallHierarchy", file, symbol);
  }

  async routerGetTypeHierarchy(
    file: string,
    symbol: string,
  ): Promise<TrackedResult<TypeHierarchyResult>> {
    return this.call("routerGetTypeHierarchy", file, symbol);
  }

  async routerFindImplementation(
    file: string,
    symbol: string,
  ): Promise<TrackedResult<SourceLocation[]>> {
    return this.call("routerFindImplementation", file, symbol);
  }

  async routerGetFileRenameEdits(
    files: Array<{ oldPath: string; newPath: string }>,
  ): Promise<TrackedResult<RefactorResult>> {
    return this.callWithTimeout(35_000, "routerGetFileRenameEdits", files);
  }

  routerNotifyFilesRenamed(files: Array<{ oldPath: string; newPath: string }>): void {
    this.fire("routerNotifyFilesRenamed", files);
  }

  routerInvalidateFileCache(file: string): void {
    this.fire("routerInvalidateFileCache", file);
  }

  async routerExtractFunction(
    file: string,
    startLine: number,
    endLine: number,
    functionName: string,
  ): Promise<TrackedResult<RefactorResult>> {
    return this.callWithTimeout(
      35_000,
      "routerExtractFunction",
      file,
      startLine,
      endLine,
      functionName,
    );
  }

  async routerExtractVariable(
    file: string,
    startLine: number,
    endLine: number,
    variableName: string,
  ): Promise<TrackedResult<RefactorResult>> {
    return this.callWithTimeout(
      35_000,
      "routerExtractVariable",
      file,
      startLine,
      endLine,
      variableName,
    );
  }

  async routerOrganizeImports(file: string): Promise<TrackedResult<RefactorResult>> {
    return this.callWithTimeout(35_000, "routerOrganizeImports", file);
  }

  async routerFixAll(file: string): Promise<TrackedResult<RefactorResult>> {
    return this.callWithTimeout(35_000, "routerFixAll", file);
  }

  // ── Router Management ─────────────────────────────────────────────

  async routerGetStatus(): Promise<{
    initialized: string[];
    lspServers: Array<{ language: string; command: string }>;
  }> {
    return this.call("routerGetStatus");
  }

  async routerGetDetailedLspServers(): Promise<
    Array<{
      language: string;
      command: string;
      args: string[];
      pid: number | null;
      cwd: string;
      openFiles: number;
      diagnosticCount: number;
      diagnostics: Array<{ file: string; message: string; severity: number }>;
      ready: boolean;
    }>
  > {
    return this.call("routerGetDetailedLspServers");
  }

  async routerRestartLspServers(filter?: string): Promise<string[]> {
    return this.call("routerRestartLspServers", filter);
  }

  async routerGetChildPids(): Promise<number[]> {
    return this.call("routerGetChildPids");
  }

  async routerWarmup(): Promise<void> {
    return this.call("routerWarmup");
  }

  async routerRunHealthCheck(): Promise<HealthCheckResult> {
    return this.call("routerRunHealthCheck");
  }

  private _entryPointsCache: string[] | null = null;

  async getEntryPoints(): Promise<string[]> {
    if (this._entryPointsCache) return this._entryPointsCache;
    const result = await this.call<string[]>("getEntryPoints");
    this._entryPointsCache = result;
    return result;
  }

  getEntryPointsCached(): string[] {
    return this._entryPointsCache ?? [];
  }
}
