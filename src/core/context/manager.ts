import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateText } from "ai";
import { useRepoMapStore } from "../../stores/repomap.js";
import type { EditorIntegration, ForgeMode, TaskRouter } from "../../types/index.js";
import { toErrorMessage } from "../../utils/errors.js";
import { setNeovimFileWrittenHandler } from "../editor/neovim.js";
import { setIntelligenceClient } from "../intelligence/instance.js";
import type { SymbolForSummary } from "../intelligence/repo-map.js";
import { resolveModel } from "../llm/provider.js";
import { EPHEMERAL_CACHE, supportsTemperature } from "../llm/provider-options.js";
import { MemoryManager } from "../memory/manager.js";
import {
  buildDirectoryTree,
  buildSystemPrompt as buildPrompt,
  buildSoulMapUserMessage as buildSoulMapContent,
  getModeInstructions,
  type PromptBuilderOptions,
} from "../prompts/index.js";
// buildForbiddenContext removed from system prompt — gates enforce at tool level
import { emitFileEdited, onFileEdited, onFileRead } from "../tools/file-events.js";
import { IntelligenceClient } from "../workers/intelligence-client.js";
// extractConversationTerms removed — FTS boosting was noisy
import { walkDir } from "./file-tree.js";
import { detectToolchain } from "./toolchain.js";

// System prompt assembly is handled by src/core/prompts/builder.ts
// Tool guidance is in src/core/prompts/shared/tool-guidance.ts
// Mode instructions are in src/core/prompts/modes/index.ts

export interface SharedContextResources {
  repoMap: IntelligenceClient;
  memoryManager: MemoryManager;
  workspaceCoordinator?: import("../coordination/WorkspaceCoordinator.js").WorkspaceCoordinator;
  parent?: ContextManager;
}

/**
 * Context Manager — gathers relevant context from the codebase
 * to include in LLM prompts for better responses.
 *
 * When constructed with `shared`, uses existing RepoMap/MemoryManager
 * instead of creating new ones. Per-tab instances use this to share
 * expensive resources while maintaining independent conversation tracking.
 */
const DEFAULT_CONTEXT_WINDOW = 200_000;

export class ContextManager {
  private cwd: string;
  private hasGhCli: boolean | null = null;
  private skills = new Map<string, string>();
  private memoryManager: MemoryManager;
  private forgeMode: ForgeMode = "default";
  private editorFile: string | null = null;
  private editorOpen = false;
  private editorIntegration: EditorIntegration | null = null;
  private fileTreeCache: { tree: string; at: number } | null = null;
  private projectInfoCache: { info: string | null; at: number } | null = null;
  private repoMap: IntelligenceClient;
  private repoMapReady = false;
  private repoMapEnabled = process.env.SOULFORGE_NO_REPOMAP !== "1";
  private repoMapGeneration = 0;
  private editedFiles = new Set<string>();
  private mentionedFiles = new Set<string>();
  // conversationTerms removed — FTS boosting was noisy, PageRank handles ranking
  private conversationTokens = 0;
  private contextWindowTokens = DEFAULT_CONTEXT_WINDOW;
  private repoMapCache: { content: string; at: number } | null = null;
  /** Changed files since snapshot, ordered by most recent edit (re-edits move to end). */
  private soulMapDiffChangedFiles = new Map<string, number>(); // rel path → edit sequence number
  private soulMapDiffSeq = 0;
  /** File paths that were included in the frozen soul map snapshot — used to detect new vs modified files in diffs. */
  private soulMapSnapshotPaths = new Set<string>();
  /** Pre-rendered diff blocks for changed files. Eagerly populated in onFileChanged via getFileDiffBlock. */
  private soulMapDiffBlocks = new Map<string, { radiusTag: string; symbolBlock: string }>();
  private taskRouter: TaskRouter | undefined;
  private semanticSummaryLimit = 500;
  private semanticAutoRegen = false;
  private repoMapTokenBudget: number | undefined = undefined;
  private lastActiveModel = "";
  private semanticGenId = 0;
  /** True when user explicitly set mode to "off" — prevents auto-enable in onScanComplete */
  private semanticModeExplicit = false;
  private isChild = false;
  private projectInstructions = "";
  private projectInstructionsVersion = 0;
  private static readonly REPO_MAP_TTL = 5_000; // 5s — covers getContextBreakdown + buildSystemPrompt in same prompt

  private static readonly FILE_TREE_TTL = 30_000; // 30s
  private static readonly PROJECT_INFO_TTL = 300_000; // 5min
  private shared: SharedContextResources | null = null;
  private tabId: string | null = null;
  private tabLabel: string | null = null;

  constructor(cwd: string, shared?: SharedContextResources) {
    this.cwd = cwd;
    if (shared) {
      this.repoMap = shared.repoMap;
      this.memoryManager = shared.memoryManager;
      this.shared = shared;
      this.isChild = true;
      this.wireFileEventHandlers();
    } else {
      this.memoryManager = new MemoryManager(cwd);
      this.repoMap = new IntelligenceClient(cwd);
      setIntelligenceClient(this.repoMap);
      this.wireFileEventHandlers();
      if (this.repoMapEnabled) {
        this.wireRepoMapCallbacks();
        this.startRepoMapScan();
      }
    }
    // Eagerly populate project info cache so sync callers get data immediately
    this.refreshProjectInfo();
  }

  /**
   * Async factory that yields to the event loop between heavy sync steps.
   * Use this from boot to keep the spinner alive during DB init.
   */
  static async createAsync(
    cwd: string,
    onStep?: (label: string) => void,
    opts?: { repoMapEnabled?: boolean },
  ): Promise<ContextManager> {
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    onStep?.("Opening the memory vaults…");
    const memoryManager = new MemoryManager(cwd);
    await tick();

    onStep?.("Mapping the codebase…");
    const repoMap = new IntelligenceClient(cwd);
    setIntelligenceClient(repoMap);
    await tick();

    onStep?.("Wiring up the forge…");
    const cm = new ContextManager(cwd, { repoMap, memoryManager });
    cm.isChild = false;
    if (opts?.repoMapEnabled === false) cm.repoMapEnabled = false;
    if (cm.repoMapEnabled) {
      cm.wireRepoMapCallbacks();
      cm.startRepoMapScan();
    }
    return cm;
  }

  getSharedResources(): SharedContextResources {
    return {
      repoMap: this.repoMap,
      memoryManager: this.memoryManager,
      workspaceCoordinator: this.shared?.workspaceCoordinator,
      parent: this,
    };
  }

  setTabId(tabId: string): void {
    this.tabId = tabId;
  }

  setTabLabel(tabLabel: string): void {
    this.tabLabel = tabLabel;
  }

  getTabId(): string | null {
    return this.tabId;
  }

  getTabLabel(): string | null {
    return this.tabLabel;
  }

  private unsubEdit: (() => void) | null = null;
  private unsubRead: (() => void) | null = null;

  private wireFileEventHandlers(): void {
    this.unsubEdit = onFileEdited((absPath) => this.onFileChanged(absPath));
    this.unsubRead = onFileRead((absPath) => this.trackMentionedFile(absPath));
    setNeovimFileWrittenHandler((absPath) => {
      emitFileEdited(absPath, "");
    });
  }

  private handleScanError(err: unknown): void {
    const msg = toErrorMessage(err);
    this.repoMapReady = false;
    this.syncRepoMapStore("error");
    useRepoMapStore.getState().setScanError(`Soul map scan failed: ${msg}`);
  }

  private startRepoMapScan(): void {
    this.syncRepoMapStore("scanning");
    this.repoMap.scan().catch((err: unknown) => this.handleScanError(err));
  }

  private wireRepoMapCallbacks(): void {
    this.repoMap.onProgress = (indexed: number, total: number) => {
      const store = useRepoMapStore.getState();
      const phaseLabels: Record<number, string> = {
        [-1]: "resolving refs",
        [-2]: "building call graph",
        [-3]: "building edges",
        [-4]: "linking tests",
        [-5]: "analyzing git history",
      };
      const label = phaseLabels[indexed] ?? `${String(indexed)}/${String(total)}`;
      store.setScanProgress(label);
      const stats = this.repoMap.getStatsCached();
      store.setStats(stats.files, stats.symbols, stats.edges, this.repoMap.dbSizeBytesCached());
    };
    this.repoMap.onScanComplete = async (success: boolean) => {
      if (success) {
        this.repoMapReady = true;
        this.repoMapGeneration++;
        this.syncRepoMapStore("ready");
        useRepoMapStore.getState().setScanError("");
        const current = this.repoMap.getSemanticMode();
        let semanticTask: Promise<unknown>;
        if (current !== "off") {
          semanticTask = this.setSemanticSummaries(current);
        } else if (this.semanticModeExplicit) {
          // User explicitly set "off" — don't auto-enable
          semanticTask = Promise.resolve();
        } else {
          // First scan or mode never configured — auto-enable based on existing data
          semanticTask = this.repoMap
            .detectPersistedSemanticMode()
            .then((persisted) =>
              this.setSemanticSummaries(persisted === "off" ? "ast" : persisted),
            );
        }
        await Promise.all([semanticTask, this.warmRepoMapCache()]);
      } else {
        this.repoMapReady = false;
        this.syncRepoMapStore("error");
        useRepoMapStore.getState().setScanError("Soul map scan completed with errors");
      }
    };

    this.repoMap.onStaleSymbols = async (count: number) => {
      const mode = this.repoMap.getSemanticMode();
      if (mode === "off" || !this.repoMapReady) return;

      const tasks: Promise<unknown>[] = [this.repoMap.generateAstSummaries()];
      if (mode === "synthetic" || mode === "full") {
        tasks.push(this.repoMap.generateSyntheticSummaries());
      }
      await Promise.all(tasks);

      if ((mode === "llm" || mode === "full" || mode === "on") && this.semanticAutoRegen) {
        const modelId = this.getSemanticModelId(this.lastActiveModel ?? "");
        if (!modelId || modelId === "none") return;
        const store = useRepoMapStore.getState();
        store.setSemanticStatus("generating");
        store.setSemanticProgress(`${String(count)} stale — regenerating...`);
        this.generateSemanticSummaries(modelId).catch((e) => { console.error("[context-manager] generateSemanticSummaries failed:", e instanceof Error ? e.message : String(e)); });
      } else {
        const stats = this.repoMap.getStatsCached();
        useRepoMapStore.getState().setSemanticCount(stats.summaries);
      }
    };
  }

  private syncRepoMapStore(status: "off" | "scanning" | "ready" | "error"): void {
    const store = useRepoMapStore.getState();
    if (status !== "scanning") {
      const stats = this.repoMap.getStatsCached();
      store.setStats(stats.files, stats.symbols, stats.edges, this.repoMap.dbSizeBytesCached());
      store.setScanProgress("");
    }
    store.setStatus(status);
  }

  getMemoryManager(): MemoryManager {
    return this.memoryManager;
  }

  getForgeMode(): ForgeMode {
    return this.forgeMode;
  }

  setProjectInstructions(content: string): void {
    if (this.projectInstructions === content) return;
    this.projectInstructions = content;
    this.projectInstructionsVersion++;
  }

  setForgeMode(mode: ForgeMode): void {
    this.forgeMode = mode;
  }

  setContextWindow(tokens: number): void {
    this.contextWindowTokens = tokens;
  }

  getContextPercent(): number {
    const window = this.contextWindowTokens > 0 ? this.contextWindowTokens : DEFAULT_CONTEXT_WINDOW;
    if (this.conversationTokens <= 0) return 0;
    return Math.round((this.conversationTokens / window) * 100);
  }

  setEditorIntegration(settings: EditorIntegration): void {
    this.editorIntegration = settings;
  }

  getEditorIntegration(): EditorIntegration | undefined {
    return this.editorIntegration ?? undefined;
  }

  isEditorOpen(): boolean {
    return this.editorOpen;
  }

  /** Update editor state so Forge knows what's open in neovim */
  setEditorState(
    open: boolean,
    file: string | null,
    vimMode?: string,
    cursorLine?: number,
    cursorCol?: number,
    visualSelection?: string | null,
  ): void {
    this.editorOpen = open;
    this.editorFile = file;
    (this as Record<string, unknown>).editorVimMode = vimMode ?? null;
    (this as Record<string, unknown>).editorCursorLine = cursorLine ?? 1;
    (this as Record<string, unknown>).editorCursorCol = cursorCol ?? 0;
    (this as Record<string, unknown>).editorVisualSelection = visualSelection ?? null;
  }

  /** Invalidate cached file tree (call after agent edits files) */
  invalidateFileTree(): void {
    this.fileTreeCache = null;
  }

  /** Notify repo map that a file changed (call after edits) */
  onFileChanged(absPath: string): void {
    // Skip files outside the project directory (e.g. /tmp scripts)
    if (!absPath.startsWith(`${this.cwd}/`)) return;

    if (!this.isChild) {
      this.repoMap.onFileChanged(absPath);
      if (this.repoMapReady) {
        setTimeout(() => {
          const stats = this.repoMap.getStatsCached();
          useRepoMapStore
            .getState()
            .setStats(stats.files, stats.symbols, stats.edges, this.repoMap.dbSizeBytesCached());
        }, 200);
      }
    }
    this.editedFiles.add(absPath);
    const rel = absPath.startsWith(`${this.cwd}/`) ? absPath.slice(this.cwd.length + 1) : absPath;
    this.soulMapDiffChangedFiles.set(rel, ++this.soulMapDiffSeq);
    this.pendingSoulMapDiff = null; // invalidate so buildSoulMapDiff() rebuilds with new file
    if (this.repoMapCache) this.repoMapCache.at = 0;

    // Eagerly fetch rich diff block (blast radius + symbols with signatures).
    // Fire-and-forget — by the time the next prepareStep runs, this will have resolved.
    if (this.repoMapReady) {
      this.prefetchDiffBlock(rel);
    }
  }

  /** Pre-render a rich diff block for a changed file (blast radius + exported symbols with signatures). */
  private prefetchDiffBlock(rel: string): void {
    // Delay slightly to let the reindex settle
    setTimeout(() => {
      this.repoMap
        .getFileDiffBlock(rel)
        .then(({ blastRadius, symbols }) => {
          const MAX_SYMBOLS = 8;
          const capped = symbols.slice(0, MAX_SYMBOLS);
          const parts: string[] = [];
          for (const s of capped) {
            const sig = s.signature
              ? s.signature.replace(/^export\s+(default\s+)?/, "").replace(/\s*\{[\s\S]*$/, "")
              : `${s.kind} ${s.name}`;
            parts.push(`  +${sig} :${String(s.line)}`);
          }
          if (symbols.length > MAX_SYMBOLS) {
            parts.push(`  ... +${String(symbols.length - MAX_SYMBOLS)} more exports`);
          }
          const radiusTag = blastRadius >= 2 ? ` (→${String(blastRadius)})` : "";
          this.soulMapDiffBlocks.set(rel, { radiusTag, symbolBlock: parts.join("\n") });
          // Only invalidate if no diff was emitted yet — avoids re-emitting a thin
          // diff as rich (the rich data will be included on the next new-file trigger).
          if (!this.lastEmittedSoulMapDiff) {
            this.pendingSoulMapDiff = null;
          }
        })
        .catch((e) => { console.error("[context-manager] prefetchDiffBlock failed:", e instanceof Error ? e.message : String(e)); });
    }, 300);
  }

  /** Track a file mentioned in conversation (tool reads, grep hits, etc.) */
  trackMentionedFile(absPath: string): void {
    this.mentionedFiles.add(absPath);
  }

  /** Update conversation context for repo map ranking */
  updateConversationContext(_input: string, totalTokens: number): void {
    this.conversationTokens = totalTokens;
    // conversationTerms removed — FTS boosting from user input was noisy.
    // Personalized PageRank (edits/reads/editor boosts) handles ranking better.
  }

  /** Get a snapshot of tracked files (for preserving across compaction) */
  getTrackedFiles(): { edited: string[]; mentioned: string[] } {
    return {
      edited: [...this.editedFiles],
      mentioned: [...this.mentionedFiles],
    };
  }

  /** Reset per-conversation tracking (call on new session / context clear / compaction) */
  resetConversationTracking(): void {
    this.editedFiles.clear();
    this.mentionedFiles.clear();

    this.conversationTokens = 0;
    if (this.repoMapCache) this.repoMapCache.at = 0;
    // Increment generation so buildInstructions() re-renders the soul map
    // with fresh DB state instead of returning the stale cached string.
    this.repoMapGeneration++;
    this.soulMapDiffChangedFiles.clear();
    this.soulMapDiffSeq = 0;
    this.soulMapSnapshotPaths.clear();
    this.soulMapDiffBlocks.clear();
    this.pendingSoulMapDiff = null;
    this.lastEmittedSoulMapDiff = null;
    this.warmRepoMapCache();
  }

  private repoMapRefreshing = false;

  /** Render repo map with full tracked context (returns cached, refreshes in background) */
  renderRepoMap(): string {
    if (!this.isRepoMapReady()) return "";
    const now = Date.now();
    if (this.repoMapCache) {
      if (now - this.repoMapCache.at >= ContextManager.REPO_MAP_TTL) {
        this.warmRepoMapCache();
      }
      return this.repoMapCache.content;
    }
    this.warmRepoMapCache();
    return "";
  }

  private async warmRepoMapCache(): Promise<void> {
    if (this.repoMapRefreshing) return;
    this.repoMapRefreshing = true;
    try {
      const result = await this.repoMap.render({
        editorFile: this.editorFile,
        editedFiles: [...this.editedFiles],
        mentionedFiles: [...this.mentionedFiles],
        conversationTokens: this.conversationTokens,
        tokenBudget: this.repoMapTokenBudget,
      });
      this.repoMapCache = { content: result.content, at: Date.now() };
      // Only set snapshot paths if they haven't been set yet (first render).
      // Don't update mid-conversation — the diff system relies on a stable
      // baseline to distinguish new vs modified files.
      if (this.soulMapSnapshotPaths.size === 0) {
        this.soulMapSnapshotPaths = new Set(result.paths);
      }
    } catch (e) {
      console.error("[context-manager] warmRepoMapCache failed:", e instanceof Error ? e.message : String(e));
    }
    this.repoMapRefreshing = false;
  }

  getRepoMap(): IntelligenceClient {
    return this.repoMap;
  }

  isRepoMapEnabled(): boolean {
    return this.repoMapEnabled;
  }

  isRepoMapReady(): boolean {
    if (!this.repoMapEnabled) return false;
    if (this.isChild) return this.shared?.parent?.isRepoMapReady() ?? false;
    return this.repoMapReady;
  }

  getRepoMapGeneration(): number {
    if (this.isChild) return this.repoMap.getStatsCached().files;
    return this.repoMapGeneration;
  }

  getInstructionsCacheKey(modelId: string): string {
    const gen = this.getRepoMapGeneration();
    const skillCount = this.skills.size;
    const skillNames = [...this.skills.keys()].sort().join(",");
    const memGen = this.memoryManager.generation;
    const mode = this.forgeMode;
    return `${String(gen)}|${modelId}|${mode}|${String(skillCount)}:${skillNames}|m${String(memGen)}|pi${String(this.projectInstructionsVersion)}`;
  }

  waitForRepoMap(timeoutMs = 120_000, signal?: AbortSignal): Promise<boolean> {
    if (!this.repoMapEnabled) return Promise.resolve(false);
    if (this.isRepoMapReady()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const start = Date.now();
      const onAbort = () => resolve(false);
      if (signal) {
        if (signal.aborted) return resolve(false);
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const check = () => {
        if (this.isRepoMapReady()) {
          signal?.removeEventListener("abort", onAbort);
          return resolve(true);
        }
        if (signal?.aborted || Date.now() - start > timeoutMs) {
          signal?.removeEventListener("abort", onAbort);
          return resolve(false);
        }
        setTimeout(check, 200);
      };
      check();
    });
  }

  setRepoMapEnabled(enabled: boolean): void {
    if (this.repoMapEnabled === enabled) return;
    this.repoMapEnabled = enabled;
    this.repoMapCache = null;

    if (!enabled) {
      // Disconnect callbacks so any in-flight scan can't touch the UI or ready state
      this.repoMap.onProgress = null;
      this.repoMap.onScanComplete = null;
      this.repoMap.onStaleSymbols = null;
      this.repoMapReady = false;
      this.syncRepoMapStore("off");
    } else {
      // Re-wire and kick off a scan if one hasn't run yet or was interrupted
      this.wireRepoMapCallbacks();
      if (!this.repoMapReady) this.startRepoMapScan();
    }
  }

  async setSemanticSummaries(
    modeOrBool: "off" | "ast" | "synthetic" | "llm" | "full" | "on" | boolean,
  ): Promise<void> {
    const mode =
      modeOrBool === true
        ? "synthetic"
        : modeOrBool === false
          ? "off"
          : modeOrBool === "on"
            ? "full"
            : modeOrBool;
    this.repoMap.setSemanticMode(mode);
    this.semanticModeExplicit = mode === "off";
    const store = useRepoMapStore.getState();
    if (mode === "off") {
      store.setSemanticStatus("off");
      store.setSemanticCount(0);
      store.setSemanticProgress("");
      store.setSemanticModel("");
      return;
    }
    store.setSemanticModel("");

    if (!this.repoMapReady) {
      store.setSemanticStatus("generating");
      store.setSemanticProgress(`${mode} — waiting for soul map...`);
      return;
    }

    store.setSemanticStatus("generating");
    store.setSemanticProgress("generating summaries...");
    const genTasks: Promise<unknown>[] = [this.repoMap.generateAstSummaries()];
    if (mode === "synthetic" || mode === "full") {
      genTasks.push(this.repoMap.generateSyntheticSummaries());
    }
    await Promise.all(genTasks);

    const bd = await this.repoMap.getSummaryBreakdown();
    store.setSemanticCount(bd.total);
    store.setLspStatus(bd.lsp > 0 ? "ready" : "off");
    store.setLspProgress(bd.lsp > 0 ? `${String(bd.lsp)} symbols enriched` : "");

    if (mode === "llm" || mode === "full") {
      const modelId = this.getSemanticModelId(this.lastActiveModel);
      if (modelId && modelId !== "none") {
        store.setSemanticModel(modelId);
      }
    }
    store.setSemanticStatus(bd.total > 0 ? "ready" : "off");
    store.setSemanticProgress(bd.total > 0 ? this.formatBreakdown(bd) : "no summaries");
  }

  async clearFreeSummaries(): Promise<void> {
    this.repoMap.clearFreeSummaries();
    const bd = await this.repoMap.getSummaryBreakdown();
    const store = useRepoMapStore.getState();
    store.setSemanticCount(bd.total);
    store.setSemanticProgress(bd.total > 0 ? this.formatBreakdown(bd) : "");
  }

  /** Clear ALL summaries including paid LLM ones. Use only for explicit user "clear" action. */
  clearSemanticSummaries(): void {
    ++this.semanticGenId;
    this.repoMap.clearSemanticSummaries();
    this.repoMapCache = null;
    const store = useRepoMapStore.getState();
    store.setSemanticCount(0);
    store.setSemanticProgress("");
    store.setSemanticModel("");
    store.resetSemanticTokens();
    store.setSemanticStatus("off");
  }

  async enrichWithLsp(maxFiles = 50): Promise<number> {
    const store = useRepoMapStore.getState();
    store.setLspStatus("generating");
    store.setLspProgress("LSP enriching symbols...");
    try {
      const { isNvimAvailable, documentSymbols } = await import(
        "../intelligence/backends/lsp/nvim-bridge.js"
      );
      if (!isNvimAvailable()) {
        store.setLspProgress("not available — open editor first");
        store.setLspStatus("error");
        return 0;
      }

      // Open the DB directly from main thread (WAL mode supports concurrent access)
      const { Database } = await import("bun:sqlite");
      const { join } = await import("node:path");
      const dbPath = join(this.cwd, ".soulforge", "repomap.db");
      const db = new Database(dbPath);
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA busy_timeout = 5000");

      const files = db
        .query<{ id: number; path: string }, [number]>(
          "SELECT id, path FROM files WHERE language IN ('typescript','javascript','python','rust','go','java','kotlin') ORDER BY pagerank DESC LIMIT ?",
        )
        .all(maxFiles);

      const update = db.prepare("UPDATE symbols SET qualified_name = ? WHERE id = ?");
      let enriched = 0;

      for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        if (!file) continue;
        const pathLabel = file.path.length > 30 ? `...${file.path.slice(-27)}` : file.path;
        store.setLspProgress(`${String(fi + 1)}/${String(files.length)}: ${pathLabel}`);
        const absPath = join(this.cwd, file.path);
        let raw: unknown[] | null;
        try {
          raw = await documentSymbols(absPath);
        } catch {
          continue;
        }
        if (!raw || raw.length === 0) continue;

        // Walk LSP document symbol tree, extract containerName
        const containerMap = new Map<string, string>();
        const walk = (symbols: unknown[], container?: string): void => {
          for (const sym of symbols) {
            const s = sym as Record<string, unknown>;
            const name = s.name as string;
            if (!name) continue;
            let line: number | undefined;
            if (s.range) {
              const r = s.range as { start: { line: number } };
              line = r.start.line + 1;
            } else if (s.location) {
              const l = s.location as { range: { start: { line: number } } };
              line = l.range.start.line + 1;
            }
            if (line !== undefined && container) {
              containerMap.set(`${name}:${String(line)}`, container);
            }
            if (s.containerName && typeof s.containerName === "string" && line !== undefined) {
              containerMap.set(`${name}:${String(line)}`, s.containerName as string);
            }
            if (s.children && Array.isArray(s.children)) {
              walk(s.children as unknown[], name);
            }
          }
        };
        walk(raw);

        if (containerMap.size === 0) continue;
        const dbSymbols = db
          .query<{ id: number; name: string; line: number }, [number]>(
            "SELECT id, name, line FROM symbols WHERE file_id = ?",
          )
          .all(file.id);

        const tx = db.transaction(() => {
          for (const sym of dbSymbols) {
            const container = containerMap.get(`${sym.name}:${String(sym.line)}`);
            if (container) {
              update.run(`${container}.${sym.name}`, sym.id);
              enriched++;
            }
          }
        });
        tx();
      }

      db.close();
      this.repoMapCache = null;
      const bd = await this.repoMap.getSummaryBreakdown();
      store.setSemanticCount(bd.total);
      store.setSemanticProgress(this.formatBreakdown(bd));
      store.setLspProgress(`${String(bd.lsp)} symbols enriched`);
      store.setLspStatus(bd.lsp > 0 ? "ready" : "off");
      return enriched;
    } catch {
      store.setLspStatus("error");
      store.setLspProgress("enrich failed");
      return 0;
    }
  }

  isSemanticEnabled(): boolean {
    return this.repoMap.isSemanticEnabled();
  }

  getSemanticMode(): "off" | "ast" | "synthetic" | "llm" | "full" | "on" {
    return this.repoMap.getSemanticMode();
  }

  setSemanticSummaryLimit(limit: number | undefined): void {
    this.semanticSummaryLimit = limit ?? 500;
  }

  setSemanticAutoRegen(enabled: boolean | undefined): void {
    this.semanticAutoRegen = enabled ?? false;
  }

  setRepoMapTokenBudget(budget: number | undefined): void {
    this.repoMapTokenBudget = budget;
    this.repoMapCache = null;
  }

  setTaskRouter(router: TaskRouter | undefined): void {
    this.taskRouter = router;
  }

  setActiveModel(modelId: string): void {
    if (!modelId || modelId === "none") return;
    const hadModel = !!this.lastActiveModel;
    this.lastActiveModel = modelId;
    // If mode needs LLM and we just got a model for the first time, trigger generation
    if (!hadModel && this.repoMapReady) {
      const mode = this.repoMap.getSemanticMode();
      if (mode === "llm" || mode === "full" || mode === "on") {
        this.setSemanticSummaries(mode);
      }
    }
  }

  private formatBreakdown(bd: {
    ast: number;
    llm: number | string;
    synthetic: number;
    lsp?: number;
    total?: number;
    eligible?: number;
  }): string {
    const fmtVal = (v: number | string): string =>
      typeof v === "string" ? v : v > 0 ? String(v) : "off";
    return [
      `ast: ${fmtVal(bd.ast)}`,
      `syn: ${fmtVal(bd.synthetic)}`,
      `llm: ${fmtVal(bd.llm)}`,
    ].join(" | ");
  }

  getSemanticModelId(fallback: string): string {
    return this.taskRouter?.semantic ?? fallback;
  }

  async generateSemanticSummaries(modelId: string): Promise<number> {
    if (!this.repoMapReady) return 0;
    this.lastActiveModel = modelId;
    const myGenId = ++this.semanticGenId;

    const store = useRepoMapStore.getState();
    store.setSemanticStatus("generating");
    store.setSemanticProgress("preparing...");
    store.setSemanticModel(modelId);
    store.resetSemanticTokens();

    const baseBd = await this.repoMap.getSummaryBreakdown();
    const model = resolveModel(modelId);
    let cumProcessed = 0;
    let totalKnown = 0;

    const generator = async (batch: SymbolForSummary[], batchTotal?: number) => {
      if (batchTotal !== undefined) totalKnown = batchTotal;
      const all: Array<{ name: string; summary: string }> = [];

      if (this.semanticGenId !== myGenId) return all;

      if (this.semanticGenId === myGenId) {
        const end = cumProcessed + batch.length;
        const total = totalKnown > 0 ? totalKnown : end;
        const llmProgress = `${String(cumProcessed + 1)}-${String(end)}/${String(total)}`;
        store.setSemanticProgress(
          this.formatBreakdown({ ast: baseBd.ast, synthetic: baseBd.synthetic, llm: llmProgress }),
        );
      }

      const prompt = batch
        .map((s, j) => {
          const meta: string[] = [];
          if (s.lineSpan) meta.push(`${String(s.lineSpan)}L`);
          if (s.dependents) meta.push(`${String(s.dependents)} dependents`);
          const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : "";
          return `[${String(j + 1)}] ${s.kind} \`${s.name}\` in ${s.filePath}${metaStr}:\n${s.signature ? `${s.signature}\n` : ""}${s.code}`;
        })
        .join("\n\n");

      const { text, usage } = await generateText({
        model,
        ...(supportsTemperature(modelId) ? { temperature: 0 } : {}),
        providerOptions: EPHEMERAL_CACHE,
        system: [
          "Summarize each code symbol in ONE line (max 80 chars). Focus on BEHAVIOR: what it does, key side effects, non-obvious logic.",
          "BAD: 'Checks if Neovim is available' (restates name)",
          "GOOD: 'Pings nvim RPC, returns false on timeout or socket error'",
          "BAD: 'Renders a widget component' (generic)",
          "GOOD: 'Memoized tree-view with virtual scroll, collapses on blur'",
          "Output ONLY lines: SymbolName: summary",
          "No numbering, no backticks, no extra text.",
        ].join("\n"),
        prompt,
      });

      const cacheRead =
        (usage as { inputTokenDetails?: { cacheReadTokens?: number } }).inputTokenDetails
          ?.cacheReadTokens ?? 0;
      store.addSemanticTokens(usage.inputTokens ?? 0, usage.outputTokens ?? 0, cacheRead);

      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx < 1) continue;
        const name = trimmed
          .slice(0, colonIdx)
          .replace(/^[`*\d.)\]\s]+/, "")
          .replace(/[`*([\s]+$/, "")
          .trim();
        const summary = trimmed.slice(colonIdx + 1).trim();
        if (name && summary && /^\w+$/.test(name)) {
          all.push({ name, summary });
        }
      }

      cumProcessed += batch.length;
      return all;
    };

    this.repoMap.setSummaryGenerator(generator);

    try {
      const count = await this.repoMap.generateSemanticSummaries(this.semanticSummaryLimit);
      if (this.semanticGenId === myGenId) {
        const bd = await this.repoMap.getSummaryBreakdown();
        store.setSemanticCount(bd.total);
        store.setSemanticStatus(bd.total > 0 ? "ready" : "off");
        store.setSemanticProgress(bd.total > 0 ? this.formatBreakdown(bd) : "");
      }
      return count;
    } catch (err) {
      if (this.semanticGenId === myGenId) {
        const msg = toErrorMessage(err);
        store.setSemanticStatus("error");
        store.setSemanticProgress(msg.slice(0, 80));
        store.setSemanticModel("");
        store.resetSemanticTokens();
        const fallbackStats = this.repoMap.getStatsCached();
        store.setSemanticCount(fallbackStats.summaries);
      }
      throw err;
    }
  }

  dispose(): void {
    this.unsubEdit?.();
    this.unsubRead?.();
    this.unsubEdit = null;
    this.unsubRead = null;
    if (!this.isChild) {
      this.repoMap.close().catch(() => {});
      this.memoryManager.close();
      import("../workers/io-client.js")
        .then(({ disposeIOClient }) => disposeIOClient())
        .catch(() => {});
    }
  }

  async refreshRepoMap(): Promise<void> {
    this.repoMapReady = false;
    this.repoMapCache = null;
    this.syncRepoMapStore("scanning");
    useRepoMapStore.getState().setScanError("");
    await this.repoMap.scan().catch((err: unknown) => this.handleScanError(err));
  }

  async clearRepoMap(): Promise<void> {
    await this.repoMap.clear();
    this.repoMapReady = false;
    this.repoMapCache = null;
    // Zero all counters immediately — worker stats cache is stale after clear
    const store = useRepoMapStore.getState();
    store.setStats(0, 0, 0, 0);
    store.setScanProgress("");
    store.setScanError("");
    store.setSemanticCount(0);
    store.setSemanticProgress("");
    store.setSemanticStatus("off");
    if (this.repoMapEnabled) {
      this.startRepoMapScan();
    } else {
      store.setStatus("off");
    }
  }

  /** Add a loaded skill to the system prompt. Content capped at 16k chars. */
  addSkill(name: string, content: string): void {
    if (!content.trim()) return;
    const MAX_SKILL_CHARS = 16_000;
    this.skills.set(
      name,
      content.length > MAX_SKILL_CHARS
        ? `${content.slice(0, MAX_SKILL_CHARS)}\n[... truncated]`
        : content,
    );
  }

  /** Remove a loaded skill from the system prompt */
  removeSkill(name: string): void {
    this.skills.delete(name);
  }

  /** Get the names of all currently loaded skills */
  getActiveSkills(): string[] {
    return [...this.skills.keys()];
  }

  getActiveSkillEntries(): Array<{ name: string; content: string }> {
    return [...this.skills.entries()].map(([name, content]) => ({ name, content }));
  }

  /** Get a breakdown of what's in the context and how much space each section uses */
  getContextBreakdown(): { section: string; chars: number; active: boolean }[] {
    const sections: { section: string; chars: number; active: boolean }[] = [];

    // Core + tools reference (always present)
    sections.push({
      section: "Core + tool reference",
      chars: 1800, // approximate: identity + all tool docs + guidelines
      active: true,
    });

    const projectInfo = this.projectInfoCache?.info ?? null;
    sections.push({
      section: "Project info",
      chars: projectInfo?.length ?? 0,
      active: projectInfo !== null,
    });

    if (this.isRepoMapReady()) {
      const cached = this.repoMapCache?.content;
      const map = cached ?? this.renderRepoMap();
      if (map) {
        sections.push({ section: "Soul map", chars: map.length, active: true });
      } else {
        const fileTree = this.getFileTree(3);
        sections.push({
          section: "File tree (soul map empty)",
          chars: fileTree.length,
          active: true,
        });
      }
    } else {
      const fileTree = this.getFileTree(3);
      sections.push({ section: "File tree", chars: fileTree.length, active: true });
    }

    sections.push({
      section: "Editor",
      chars: this.editorOpen && this.editorFile ? 200 : 0,
      active: this.editorOpen && this.editorFile !== null,
    });

    const memoryContext = this.memoryManager.buildMemoryIndex();
    sections.push({
      section: "Project memory",
      chars: memoryContext?.length ?? 0,
      active: memoryContext !== null,
    });

    const modeInstructions = getModeInstructions(this.forgeMode, {
      contextPercent: this.getContextPercent(),
    });
    sections.push({
      section: `Mode (${this.forgeMode})`,
      chars: modeInstructions?.length ?? 0,
      active: modeInstructions !== null,
    });

    let skillChars = 0;
    for (const [, content] of this.skills) {
      skillChars += content.length;
    }
    sections.push({
      section: `Skills (${String(this.skills.size)})`,
      chars: skillChars,
      active: this.skills.size > 0,
    });

    return sections;
  }

  /** Clear optional context sections */
  clearContext(what: "memory" | "skills" | "all"): string[] {
    const cleared: string[] = [];
    if (what === "skills" || what === "all") {
      if (this.skills.size > 0) {
        const names = [...this.skills.keys()];
        for (const n of names) this.skills.delete(n);
        cleared.push(`skills (${names.join(", ")})`);
      }
    }
    // Memory can't be "cleared" from context without deleting files,
    // but we can note it. Memory is read fresh each prompt anyway.
    if (what === "memory" || what === "all") {
      cleared.push("memory (will reload next prompt if .soulforge/ exists)");
    }
    return cleared;
  }

  /** Build a system prompt with project context, scaled to context window. */
  buildSystemPrompt(modelIdOverride?: string): string {
    if (this.hasGhCli === null) {
      try {
        this.hasGhCli = Bun.spawnSync(["gh", "--version"]).exitCode === 0;
      } catch {
        this.hasGhCli = false;
      }
    }
    const opts: PromptBuilderOptions = {
      modelId: modelIdOverride || this.lastActiveModel,
      hasRepoMap: this.isRepoMapReady(),
      hasSymbols: this.isRepoMapReady() && this.repoMap.getStatsCached().symbols > 0,
      forgeMode: this.forgeMode,
      projectInstructions: this.projectInstructions || null,
      cwd: this.cwd,
      hasGhCli: this.hasGhCli,
    };
    return buildPrompt(opts);
  }

  /**
   * Build skills as a user→assistant message pair.
   * Keeps the system prompt stable when skills are loaded/unloaded.
   * Returns null if no skills are loaded.
   */
  buildSkillsMessages():
    | [{ role: "user"; content: string }, { role: "assistant"; content: string }]
    | null {
    if (this.skills.size === 0) return null;

    const names = [...this.skills.keys()];
    const skillBlocks = [...this.skills.entries()]
      .map(([name, content]) => `<skill name="${name}">\n${content}\n</skill>`)
      .join("\n\n");

    const userMessage =
      `<loaded_skills>\n` +
      `The following ${String(names.length)} skill(s) are loaded: ${names.join(", ")}.\n` +
      `Apply them when the task matches their domain.\n\n` +
      `${skillBlocks}\n` +
      `</loaded_skills>`;

    const assistantAck =
      `Noted — ${String(names.length)} skill(s) loaded: ${names.join(", ")}. ` +
      `I'll apply them when relevant to the task.`;

    return [
      { role: "user" as const, content: userMessage },
      { role: "assistant" as const, content: assistantAck },
    ];
  }

  buildSoulMapSnapshot(clearDiffTracker = true): string | null {
    if (!this.isRepoMapReady()) return null;
    const rendered = this.renderRepoMap();
    if (!rendered) return null;
    const isMinimal = this.contextWindowTokens <= 32_000;
    const treeLimit = this.repoMapTokenBudget ? Math.ceil(this.repoMapTokenBudget / 100) : 60;
    const dirTree = buildDirectoryTree(this.cwd, treeLimit);

    // soulMapSnapshotPaths is populated by warmRepoMapCache() from render()'s
    // lastRenderedPaths — no string parsing needed.

    if (clearDiffTracker) {
      this.soulMapDiffChangedFiles.clear();
      this.soulMapDiffSeq = 0;
      this.soulMapDiffBlocks.clear();
      this.pendingSoulMapDiff = null;
      this.lastEmittedSoulMapDiff = null;
    }
    return buildSoulMapContent(rendered, isMinimal, dirTree);
  }

  private pendingSoulMapDiff: string | null = null;
  /** The diff string that was last emitted — used to detect changes and avoid re-emitting identical diffs. */
  private lastEmittedSoulMapDiff: string | null = null;

  /**
   * Build a cumulative soul map diff covering ALL files changed since the snapshot.
   * Returns null if nothing changed, or if the diff is identical to the last emitted one
   * (avoids duplicate content across injects — coalescing).
   */
  buildSoulMapDiff(): string | null {
    if (!this.isRepoMapReady()) return null;

    // Purge any stale entries outside cwd (e.g. /tmp scripts tracked before guard)
    for (const path of this.soulMapDiffChangedFiles.keys()) {
      if (path.startsWith("/")) this.soulMapDiffChangedFiles.delete(path);
    }

    if (this.soulMapDiffChangedFiles.size === 0) return null;

    // Rebuild the diff string if the file set changed since last build
    if (!this.pendingSoulMapDiff) {
      // Sort by most recent edit so the 15-file cap shows latest changes, not earliest
      const changed = [...this.soulMapDiffChangedFiles.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([path]) => path);
      const hasSnapshot = this.soulMapSnapshotPaths.size > 0;
      const lines = ["<soul_map_update>"];
      const MAX_RICH_BLOCKS = 5;
      let richBlockCount = 0;

      for (const file of changed.slice(0, 15)) {
        const absPath = join(this.cwd, file);
        const fileExists = existsSync(absPath);
        const block = this.soulMapDiffBlocks.get(file);

        if (!fileExists) {
          // Deleted file
          lines.push(`- ${file}`);
        } else if (hasSnapshot && !this.soulMapSnapshotPaths.has(file)) {
          // New file — not in the frozen snapshot
          const tag = block ? `${file}:${block.radiusTag} [NEW FILE]` : `${file}: [NEW FILE]`;
          lines.push(tag);
          if (block?.symbolBlock && richBlockCount < MAX_RICH_BLOCKS) {
            lines.push(block.symbolBlock);
            richBlockCount++;
          }
        } else {
          // Modified file — include blast radius + symbols if prefetched
          const tag = block ? `${file}:${block.radiusTag}` : `${file}:`;
          lines.push(tag);
          if (block?.symbolBlock && richBlockCount < MAX_RICH_BLOCKS) {
            lines.push(block.symbolBlock);
            richBlockCount++;
          }
        }
      }
      if (changed.length > 15) lines.push(`(+${String(changed.length - 15)} more)`);
      lines.push("</soul_map_update>");
      this.pendingSoulMapDiff = lines.join("\n");
    }

    // Skip if identical to what was already injected in a previous step
    if (this.pendingSoulMapDiff === this.lastEmittedSoulMapDiff) return null;
    return this.pendingSoulMapDiff;
  }

  commitSoulMapDiff(): void {
    if (this.pendingSoulMapDiff) {
      // Don't clear soulMapDiffChangedFiles — keep accumulating so the diff
      // is always cumulative since the snapshot. Only clear the built string
      // so it rebuilds if new files are added.
      this.lastEmittedSoulMapDiff = this.pendingSoulMapDiff;
      this.pendingSoulMapDiff = null;
    }
  }

  buildSkillsBlock(): string | null {
    if (this.skills.size === 0) return null;
    const names = [...this.skills.keys()];
    const skillBlocks = [...this.skills.entries()]
      .map(([name, content]) => `<skill name="${name}">\n${content}\n</skill>`)
      .join("\n\n");
    return (
      `<loaded_skills>\n` +
      `The following ${String(names.length)} skill(s) are loaded: ${names.join(", ")}.\n` +
      `Apply them when the task matches their domain.\n\n` +
      `${skillBlocks}\n` +
      `</loaded_skills>`
    );
  }

  /**
   * Build the cross-tab coordination section for system prompt or prepareStep injection.
   * Returns null when no other tabs have claims.
   */
  buildCrossTabSection(): string | null {
    if (!this.shared?.workspaceCoordinator || !this.tabId) return null;
    const coordinator = this.shared.workspaceCoordinator;
    // Single pass, zero allocations for the common case (no other tabs)
    const byTab = new Map<string, { label: string; paths: string[]; total: number }>();
    coordinator.forEachClaim((path, claim) => {
      if (claim.tabId === this.tabId) return;
      let entry = byTab.get(claim.tabId);
      if (!entry) {
        entry = { label: claim.tabLabel, paths: [], total: 0 };
        byTab.set(claim.tabId, entry);
      }
      entry.total++;
      if (entry.paths.length < 10) {
        const rel = path.startsWith(`${this.cwd}/`) ? path.slice(this.cwd.length + 1) : path;
        entry.paths.push(rel);
      }
    });
    if (byTab.size === 0) return null;

    const otherClaims: string[] = [];
    for (const [, { label, paths, total }] of byTab) {
      const extra = total > 10 ? ` (+${String(total - 10)} more)` : "";
      otherClaims.push(`  Tab "${label}": ${paths.join(", ")}${extra}`);
    }
    if (otherClaims.length === 0) return null;

    return [
      "",
      "## Cross-Tab File Coordination (passive FYI — do not reply to this)",
      "Files currently claimed by other tabs:",
      ...otherClaims,
      "Rules:",
      "- This block is context only. Do not acknowledge it, summarize it, or state how it does/doesn't affect your plan. Silence = received.",
      "- Only speak up when edit_file/multi_edit returns a ⚠️ conflict warning on a file you just edited. Then: note the conflict once (file + owning tab), proceed with the edit, and do not repeat the notice on subsequent edits in the same turn.",
      "- If multiple files you need to edit conflict, ask the user once whether to continue or wait.",
    ].join("\n");
  }

  /** Async refresh of project info cache. Called eagerly on init and can be re-called to refresh. */
  async refreshProjectInfo(): Promise<string | null> {
    const now = Date.now();
    if (this.projectInfoCache && now - this.projectInfoCache.at < ContextManager.PROJECT_INFO_TTL) {
      return this.projectInfoCache.info;
    }

    const checks = [
      { file: "package.json", label: "Node.js project" },
      { file: "Cargo.toml", label: "Rust project" },
      { file: "go.mod", label: "Go project" },
      { file: "pyproject.toml", label: "Python project" },
      { file: "pom.xml", label: "Java/Maven project" },
    ];

    for (const check of checks) {
      try {
        await readFile(join(this.cwd, check.file), "utf-8");
        const toolchain = this.detectToolchain();
        const profileStr = this.buildProfileString();
        const info = `${check.label}${toolchain ? ` · Toolchain: ${toolchain}` : ""}${profileStr}`;
        this.projectInfoCache = { info, at: now };
        return info;
      } catch {}
    }

    this.projectInfoCache = { info: null, at: now };
    return null;
  }

  private projectProfileCache: string | null = null;

  private buildProfileString(): string {
    if (this.projectProfileCache !== null) return this.projectProfileCache;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("../tools/project.js") as {
        detectProfile: (cwd: string) => Record<string, string | null>;
      };
      const profile = mod.detectProfile(this.cwd);
      const parts: string[] = [];
      for (const action of ["lint", "typecheck", "test", "build"] as const) {
        if (profile[action]) parts.push(`${action}: \`${profile[action]}\``);
      }
      this.projectProfileCache = parts.length > 0 ? `\nProject commands: ${parts.join(" · ")}` : "";
    } catch {
      this.projectProfileCache = "";
    }
    return this.projectProfileCache;
  }

  private detectToolchain(): string | null {
    return detectToolchain(this.cwd);
  }

  private fileTreeRefreshing = false;

  /** Generate a simple file tree (returns cached, refreshes via IO worker in background) */
  private getFileTree(maxDepth: number): string {
    const now = Date.now();
    if (this.fileTreeCache) {
      if (now - this.fileTreeCache.at >= ContextManager.FILE_TREE_TTL) {
        this.warmFileTreeCache(maxDepth);
      }
      return this.fileTreeCache.tree;
    }
    const lines: string[] = [];
    walkDir(this.cwd, "", maxDepth, lines);
    const tree = lines.slice(0, 50).join("\n");
    this.fileTreeCache = { tree, at: now };
    this.warmFileTreeCache(maxDepth);
    return tree;
  }

  private async warmFileTreeCache(maxDepth: number): Promise<void> {
    if (this.fileTreeRefreshing) return;
    this.fileTreeRefreshing = true;
    try {
      const { getIOClient } = await import("../workers/io-client.js");
      const lines = await getIOClient().walkDir(this.cwd, "", maxDepth);
      const tree = lines.slice(0, 50).join("\n");
      this.fileTreeCache = { tree, at: Date.now() };
    } catch {}
    this.fileTreeRefreshing = false;
  }
}

export { extractConversationTerms } from "./conversation-terms.js";
