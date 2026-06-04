import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateText } from "ai";
import { loadConfig } from "../../config/index.js";
import { logBackgroundError } from "../../stores/errors.js";
import { recordModelCall } from "../../stores/model-events.js";
import { useRepoMapStore } from "../../stores/repomap.js";
import type { EditorIntegration, ForgeMode, TaskRouter } from "../../types/index.js";
import { toErrorMessage } from "../../utils/errors.js";
import { setNeovimFileWrittenHandler } from "../editor/neovim.js";
import { setIntelligenceClient } from "../intelligence/instance.js";
import type { SymbolForSummary } from "../intelligence/repo-map.js";
import { cacheTtlToMs, supportsPromptCache } from "../llm/cache-support.js";
import { resolveModel } from "../llm/provider.js";
import { EPHEMERAL_CACHE, supportsTemperature } from "../llm/provider-options.js";
import {
  memoryMarkersForPaths,
  resetSurfacedHints,
  setMemoryHintProvider,
} from "../memory/hints.js";
import { MemoryManager } from "../memory/manager.js";
import { MemoryRecall } from "../memory/recall.js";
import { describeRecallSignals, MEMORY_RECALL_ACK } from "../memory/types.js";
import {
  buildDirectoryTree,
  buildSystemPrompt as buildPrompt,
  buildSoulMapUserMessage as buildSoulMapContent,
  getModeInstructions,
  invalidateDirectoryTree,
  type PromptBuilderOptions,
} from "../prompts/index.js";
// buildForbiddenContext removed from system prompt — gates enforce at tool level
import { emitFileEdited, onFileEdited, onFileRead } from "../tools/file-events.js";
import { IntelligenceClient } from "../workers/intelligence-client.js";
// extractConversationTerms removed — FTS boosting was noisy
import { walkDir } from "./file-tree.js";
import { SoulMapSnapshot } from "./soul-map-snapshot.js";
import { detectToolchain } from "./toolchain.js";

// System prompt assembly is handled by src/core/prompts/builder.ts
// Tool guidance is in src/core/prompts/shared/tool-guidance.ts
// Mode instructions are in src/core/prompts/modes/index.ts

export interface SharedContextResources {
  repoMap: IntelligenceClient;
  memoryManager: MemoryManager;
  memoryRecall?: MemoryRecall;
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
  private memoryRecall: MemoryRecall;
  /** Cache for buildMemoryRecallMessages — keyed on (memGen, editEpoch, lastUserMsg, editedFiles). */
  private recallCache: {
    key: string;
    pair: [{ role: "user"; content: string }, { role: "assistant"; content: string }] | null;
  } | null = null;
  /** Bumped on every onFileEdited so recall cache misses when the working set shifts. */
  private recallEditEpoch = 0;
  /** Memory ids surfaced earlier in this turn-stream — skipped on subsequent recall to avoid duplicate <recalled_memories> blocks. Cleared on cache reset (compaction, /clear, session restore). */
  private surfacedMemoryIds = new Set<string>();
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
  private lastInstructionsSize: number | undefined;
  private repoMapCache: { content: string; at: number } | null = null;
  /** Changed files since snapshot, ordered by most recent edit (re-edits move to end). */
  private soulMapDiffChangedFiles = new Map<string, number>(); // rel path → edit sequence number
  private soulMapDiffSeq = 0;
  /** File paths that were included in the frozen soul map snapshot — used to detect new vs modified files in diffs. */
  private soulMapSnapshotPaths = new Set<string>();
  /** Pre-rendered diff blocks for changed files. Eagerly populated in onFileChanged via getFileDiffBlock. */
  private soulMapDiffBlocks = new Map<string, { radiusTag: string; symbolBlock: string }>();
  /**
   * Frozen soul-map snapshot for this tab. Byte-stable across reads until
   * idle-expired, compacted, or explicitly reset. Mutations land in the delta
   * channel — never modify the snapshot. Null = needs rebuild on next request.
   */
  private soulMapSnapshot: SoulMapSnapshot | null = null;
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
      setMemoryHintProvider(shared.memoryManager);

      this.repoMap = shared.repoMap;
      this.memoryManager = shared.memoryManager;
      this.memoryRecall = shared.memoryRecall ?? this.createMemoryRecall();
      this.shared = shared;
      this.isChild = true;
      this.wireFileEventHandlers();
    } else {
      this.memoryManager = new MemoryManager(cwd);
      this.memoryManager.noteSessionStart();
      setMemoryHintProvider(this.memoryManager);
      this.repoMap = new IntelligenceClient(cwd);
      this.memoryRecall = this.createMemoryRecall();
      setIntelligenceClient(this.repoMap);
      this.wireFileEventHandlers();
      if (this.repoMapEnabled) {
        this.wireRepoMapCallbacks();
        this.startRepoMapScan();
      }
    }
    this.maybeWireMemoryEmbedder();
    this.subscribeToProviderSwitches();
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
    memoryManager.noteSessionStart();
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
    await cm.maybeWireMemoryEmbedder();
    return cm;
  }

  getSharedResources(): SharedContextResources {
    return {
      repoMap: this.repoMap,
      memoryManager: this.memoryManager,
      memoryRecall: this.memoryRecall,
      workspaceCoordinator: this.shared?.workspaceCoordinator,
      parent: this,
    };
  }

  getMemoryRecall(): MemoryRecall {
    return this.memoryRecall;
  }

  private createMemoryRecall(): MemoryRecall {
    const projectDb = this.memoryManager.getDbForScope("project");
    const globalDb = this.memoryManager.getDbForScope("global");
    const adapt = (db: typeof projectDb) => ({
      searchUnicode: (q: string, l?: number) => db.searchUnicode(q, l),
      searchTrigram: (q: string, l?: number) => db.searchTrigram(q, l),
      searchTrigramWithBigram: (q: string, l?: number) => db.searchTrigramWithBigram(q, l),
      findByFileIds: (ids: number[], l?: number) => db.findByFileIds(ids, l),
      findByPaths: (paths: string[], l?: number) => db.findByPaths(paths, l),
      topByUsage: (l?: number) => db.topByUsage(l),
      readMany: (ids: string[]) => db.readMany(ids),
      fileIdsByMemoryIds: (ids: string[]) => db.fileIdsByMemoryIds(ids),
    });
    return new MemoryRecall(
      [
        { scope: "project", db: adapt(projectDb) },
        { scope: "global", db: adapt(globalDb) },
      ],
      this.repoMap,
    );
  }

  async buildMemoryRecallMessages(
    lastUserMessage: string,
  ): Promise<[{ role: "user"; content: string }, { role: "assistant"; content: string }] | null> {
    const editedPaths = [...this.editedFiles]
      .map((abs) => (abs.startsWith(`${this.cwd}/`) ? abs.slice(this.cwd.length + 1) : abs))
      .sort();
    const memGen = this.memoryManager.generation;
    const readScope = this.memoryManager.scopeConfig.readScope;
    if (readScope === "none") return null;
    const cacheKey = `${memGen}|${this.recallEditEpoch}|${readScope}|${lastUserMessage}|${editedPaths.join(",")}`;
    if (this.recallCache && this.recallCache.key === cacheKey) {
      return this.recallCache.pair;
    }

    let results: import("../memory/types.js").MemoryRecallResult[];
    try {
      results = await this.memoryRecall.recall({
        query: lastUserMessage,
        editedFiles: editedPaths,
        readScope,
      });
    } catch {
      this.recallCache = { key: cacheKey, pair: null };
      return null;
    }
    // Usage accounting covers EVERY recalled id, every turn — recall is
    // consumption. The `fresh` filter below gates only re-injection (avoid
    // re-showing the same stub), not whether the memory counts as used.
    this.memoryManager.recordRecallAcross(
      results.map((r) => ({ scope: r.scope, id: r.record.id })),
    );

    const fresh = results.filter((r) => !this.surfacedMemoryIds.has(r.record.id));
    if (fresh.length === 0) {
      this.recallCache = { key: cacheKey, pair: null };
      return null;
    }

    // Stub-mode inject: summary + id + signals only. Details live in the DB
    // and are pulled on demand via memory(get, id) when the agent decides
    // the memory is actually relevant. Cuts per-turn cost ~80% vs inline.
    const lines: string[] = ["<recalled_memories>"];
    const surfacedIds: Array<{ scope: "global" | "project"; id: string }> = [];
    let anyHasDetails = false;
    for (const { record, scope, signals } of fresh) {
      surfacedIds.push({ scope, id: record.id });
      this.surfacedMemoryIds.add(record.id);
      const cat = record.category ?? "—";
      const why = describeRecallSignals(signals);
      const whySuffix = why ? `  · via ${why}` : "";
      const hasBody = record.details.length > 0;
      if (hasBody) anyHasDetails = true;
      const bodyHint = hasBody ? "  ↳ has details" : "";
      lines.push(`[${cat}] ${record.id.slice(0, 8)} — ${record.summary}${whySuffix}${bodyHint}`);
    }
    if (anyHasDetails) {
      lines.push("(call memory(action:'get', id:<8-char prefix>) to read full details)");
    }
    lines.push("</recalled_memories>");

    const userMessage = lines.join("\n");
    const assistantAck = MEMORY_RECALL_ACK(surfacedIds.length);
    const pair: [{ role: "user"; content: string }, { role: "assistant"; content: string }] = [
      { role: "user" as const, content: userMessage },
      { role: "assistant" as const, content: assistantAck },
    ];
    this.recallCache = { key: cacheKey, pair };
    return pair;
  }

  /** Provider options for the memory recall message pair — cached ephemerally. */
  static readonly MEMORY_RECALL_PROVIDER_OPTIONS = EPHEMERAL_CACHE;

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
    this.unsubEdit = onFileEdited((absPath, _content, origin) => {
      this.recallEditEpoch++;
      // Foreign edit = produced by another tab or a subagent. We use this
      // signal to decide whether the next delta should render a session
      // header — self-only edits don't need one since the model just made
      // them; cross-tab / subagent edits do, so the parent learns who.
      if (origin) {
        const sameTab = origin.tabId && this.tabId && origin.tabId === this.tabId;
        const isSubagent = !!origin.agentId;
        if (!sameTab || isSubagent) {
          const rel = absPath.startsWith(`${this.cwd}/`)
            ? absPath.slice(this.cwd.length + 1)
            : absPath;
          this.foreignEditOrigins.set(rel, {
            tabId: origin.tabId ?? null,
            agentLabel: origin.agentLabel ?? origin.agentId ?? null,
          });
        }
      }
      this.onFileChanged(absPath);
    });
    this.unsubRead = onFileRead((absPath) => this.trackMentionedFile(absPath));
    this.unsubNvimWritten = setNeovimFileWrittenHandler((absPath) => {
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
        // A pending mode means setSemanticSummaries was called while the scan
        // was still in flight (fast cached startup races config-sync writes).
        // Re-applying it now drives the UI past the "waiting for soul map" stub.
        const pending = this.pendingSemanticMode;
        const current = pending ?? this.repoMap.getSemanticMode();
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
        this.generateSemanticSummaries(modelId).catch((e) => {
          logBackgroundError(
            "context-manager",
            `generateSemanticSummaries failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
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

  buildModeMessage(modeOverride?: ForgeMode): string | null {
    const mode = modeOverride ?? this.forgeMode;
    if (mode === "default") return null;
    const instructions = getModeInstructions(mode, {
      contextPercent: this.getContextPercent(),
    });
    const banner = `Active mode: ${mode.toUpperCase()}.`;
    return instructions ? `${banner}\n${instructions}` : banner;
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
    invalidateDirectoryTree(this.cwd);
    const rel = absPath.startsWith(`${this.cwd}/`) ? absPath.slice(this.cwd.length + 1) : absPath;
    this.soulMapDiffChangedFiles.set(rel, ++this.soulMapDiffSeq);
    this.pendingSoulMapDiff = null; // invalidate so buildSoulMapDiff() rebuilds with new file
    // Mark the render-state cache stale so warmRepoMapCache picks up fresh symbols.
    // The frozen soulMapSnapshot is NOT touched — file edits append to deltas only.
    if (this.repoMapCache) this.repoMapCache.at = 0;

    // Eagerly fetch rich diff block (blast radius + symbols with signatures).
    // Fire-and-forget — by the time the next prepareStep runs, this will have resolved.
    if (this.repoMapReady) {
      this.prefetchDiffBlock(rel);
    }
  }

  /** Pre-render a rich diff block for a changed file (blast radius + exported symbols with signatures).
   *  Debounced per-file — rapid edits collapse into a single fetch after the burst settles. */
  private prefetchDiffBlock(rel: string): void {
    const existing = this.prefetchTimers.get(rel);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.prefetchTimers.delete(rel);
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
        .catch((e) => {
          logBackgroundError(
            "context-manager",
            `prefetchDiffBlock failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
    }, 300);
    this.prefetchTimers.set(rel, timer);
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

  /**
   * Reset per-conversation tracking. Use for new session / context clear /
   * session restore. **Not** for compaction — that crosses no semantic boundary,
   * so already-surfaced memory ids must persist (otherwise they re-inject after
   * the summary already folded them in). Use `resetForCompaction()` instead.
   */
  resetConversationTracking(): void {
    this.editedFiles.clear();
    this.surfacedMemoryIds.clear();
    resetSurfacedHints(this.tabId ?? undefined);
    this.recallCache = null;
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
    this.soulMapSnapshot = null; // force rebuild on next snapshot request
    this.warmRepoMapCache();
  }

  /**
   * Lighter reset for mid-session compaction. Keeps `surfacedMemoryIds` so
   * memories already shown this conversation don't re-inject after the summary
   * already references them. Soul-map diff state still resets — the post-compact
   * message stream is a fresh prefix from the model's perspective.
   */
  resetForCompaction(): void {
    // Mark next delta as post-compaction so the session header is rendered
    // even when the agent itself produced all the edits — the prompt prefix
    // was just rewritten and orientation is genuinely useful again.
    this.postCompactionPending = true;
    this.recallCache = null;
    resetSurfacedHints(this.tabId ?? undefined);
    if (this.repoMapCache) this.repoMapCache.at = 0;
    this.repoMapGeneration++;
    this.soulMapDiffChangedFiles.clear();
    this.soulMapDiffSeq = 0;
    this.soulMapSnapshotPaths.clear();
    this.soulMapDiffBlocks.clear();
    this.pendingSoulMapDiff = null;
    this.lastEmittedSoulMapDiff = null;
    // Compaction crosses a hard prefix boundary — drop the frozen snapshot so
    // the next prompt rebuilds with current DB state and a fresh cache key.
    this.soulMapSnapshot = null;
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
    // Warm entry-points cache so renderSnapshotContent can include them
    // synchronously without forcing the snapshot path through async.
    this.repoMap.getEntryPoints().catch(() => {});
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
      logBackgroundError(
        "context-manager",
        `warmRepoMapCache failed: ${e instanceof Error ? e.message : String(e)}`,
      );
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
    this.soulMapSnapshot = null;

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

  setInstructionsSize(size: number): void {
    this.lastInstructionsSize = size;
  }

  getInstructionsSize(): number | undefined {
    return this.lastInstructionsSize;
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
      this.pendingSemanticMode = null;
      return;
    }
    store.setSemanticModel("");

    if (!this.repoMapReady) {
      // Queue the mode for re-application once the scan completes. onScanComplete
      // re-invokes setSemanticSummaries with this value, so the UI doesn't get
      // stuck on "waiting for soul map" when a late config-sync write races
      // a fast cached startup.
      this.pendingSemanticMode = mode;
      store.setSemanticStatus("generating");
      store.setSemanticProgress(`${mode} — waiting for soul map...`);
      return;
    }

    this.pendingSemanticMode = null;
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

      const semStartedAt = Date.now();
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
      recordModelCall({
        modelId,
        source: "other",
        startedAt: semStartedAt,
        durationMs: Math.max(0, Date.now() - semStartedAt),
        state: "ok",
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cacheRead,
      });

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
    this.unsubNvimWritten?.();
    this.unsubEdit = null;
    this.unsubRead = null;
    this.unsubNvimWritten = null;
    for (const t of this.prefetchTimers.values()) clearTimeout(t);
    this.prefetchTimers.clear();
    this._unsubProviderSwitch?.();
    this._unsubProviderSwitch = null;
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
    this.soulMapSnapshot = null;
    this.syncRepoMapStore("scanning");
    useRepoMapStore.getState().setScanError("");
    await this.repoMap.scan().catch((err: unknown) => this.handleScanError(err));
  }

  async clearRepoMap(): Promise<void> {
    await this.repoMap.clear();
    this.repoMapReady = false;
    this.repoMapCache = null;
    this.soulMapSnapshot = null;
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

    // System prompt size — use actual cached size from forge if available, else estimate
    const cachedSize = this.getInstructionsSize();
    sections.push({
      section: "System prompt + tools",
      chars: cachedSize ?? 1800,
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
        this.hasGhCli =
          Bun.spawnSync(["gh", "--version"], {
            stdout: "ignore",
            stderr: "ignore",
            windowsHide: true,
          }).exitCode === 0;
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

  /**
   * Build or reuse the soul-map snapshot for the given model.
   *
   * Providers that support prompt caching (Claude direct + all gateways routing
   * to Claude, OpenAI, Gemini, DeepSeek, xAI implicit caches) get a frozen
   * snapshot with idle-TTL semantics — same bytes on every read until idle past
   * `config.cache.ttl` (5m or 1h).
   *
   * Providers without prompt caching (Groq legacy, unknown gateways) render
   * fresh every call: no cache to preserve means stale data has no upside.
   * `buildSoulMapDiff()` returns null in this case so we never inject deltas
   * that duplicate content already in the fresh snapshot.
   *
   * @param opts.modelId — active model; gates the freeze + delta channel.
   * @param opts.force — bypass freeze on this call (session start, /clear, refresh).
   */
  buildSoulMapSnapshot(
    opts: { modelId?: string; force?: boolean } | boolean = false,
  ): string | null {
    // Legacy boolean signature: `true` = force fresh, `false` = reuse if possible.
    const { modelId, force } =
      typeof opts === "boolean" ? { modelId: undefined, force: opts } : opts;
    if (!this.isRepoMapReady()) return null;

    const cacheSupport = modelId
      ? supportsPromptCache(modelId)
      : { enabled: true, explicit: false };
    const ttlMs = cacheTtlToMs(loadConfig().cache?.ttl ?? "5m");
    const now = Date.now();

    // Provider has no cache to preserve → live render, no freeze, no deltas.
    if (!cacheSupport.enabled) {
      const rendered = this.renderSnapshotContent();
      if (rendered) {
        this.soulMapSnapshot = new SoulMapSnapshot(
          { content: rendered, paths: new Set(this.soulMapSnapshotPaths), ttlMs: 0 },
          now,
        );
        this.clearDeltaState();
      }
      return rendered;
    }

    const expired = !this.soulMapSnapshot || this.soulMapSnapshot.isIdleExpired(now);
    if (!force && !expired && this.soulMapSnapshot) {
      return this.soulMapSnapshot.read(now);
    }

    const rendered = this.renderSnapshotContent();
    if (!rendered) return null;

    this.soulMapSnapshot = new SoulMapSnapshot(
      { content: rendered, paths: new Set(this.soulMapSnapshotPaths), ttlMs },
      now,
    );
    this.clearDeltaState();
    return rendered;
  }

  private renderSnapshotContent(): string | null {
    const rendered = this.renderRepoMap();
    if (!rendered) return null;
    const isMinimal = this.contextWindowTokens <= 32_000;
    const treeLimit = this.repoMapTokenBudget ? Math.ceil(this.repoMapTokenBudget / 100) : 60;
    const dirTree = buildDirectoryTree(this.cwd, treeLimit);
    const entryPoints = this.repoMap.getEntryPointsCached();
    return buildSoulMapContent(rendered, isMinimal, dirTree, entryPoints);
  }

  private clearDeltaState(): void {
    this.soulMapDiffChangedFiles.clear();
    this.soulMapDiffSeq = 0;
    this.soulMapDiffBlocks.clear();
    this.pendingSoulMapDiff = null;
    this.lastEmittedSoulMapDiff = null;
    this.soulMapNewFilesEmitted.clear();
    this.recentToolFailures.length = 0;
    this.foreignEditOrigins.clear();
  }

  private pendingSoulMapDiff: string | null = null;
  /** The diff string that was last emitted — used to detect changes and avoid re-emitting identical diffs. */
  private lastEmittedSoulMapDiff: string | null = null;

  buildSoulMapDiff(modelId?: string): string | null {
    if (!this.isRepoMapReady()) return null;

    // Non-caching providers always see a live snapshot; deltas would duplicate.
    if (modelId && !supportsPromptCache(modelId).enabled) return null;

    // Purge any stale entries outside cwd (e.g. /tmp scripts tracked before guard)
    for (const path of this.soulMapDiffChangedFiles.keys()) {
      if (path.startsWith("/")) this.soulMapDiffChangedFiles.delete(path);
    }

    if (this.soulMapDiffChangedFiles.size === 0) return null;

    // Rebuild the diff string if the file set changed since last build
    if (!this.pendingSoulMapDiff) {
      // Deterministic ordering: edit recency DESC, path ASC for ties.
      // Byte-stable across runs so caching layers can hash-match.
      const changed = [...this.soulMapDiffChangedFiles.entries()]
        .sort((a, b) => {
          const recency = b[1] - a[1];
          return recency !== 0 ? recency : a[0].localeCompare(b[0]);
        })
        .map(([path]) => path);
      const hasSnapshot = this.soulMapSnapshotPaths.size > 0;
      const lines = ["<soul_map_update>"];
      // Session header — only when it carries non-redundant information.
      // Skipped when every recorded edit originated from this agent in this
      // turn (the model just made them — no orientation needed). Rendered
      // when:
      //   - foreign edits exist (cross-tab or subagent contributed), OR
      //   - we're post-compaction (the prefix was just rewritten),
      // with explicit cause + origin breakdown so the reader knows WHY they
      // need orientation.
      const hasForeign = this.foreignEditOrigins.size > 0;
      const postCompaction = this.postCompactionPending;
      if (this.editedFiles.size > 0 && (hasForeign || postCompaction)) {
        const hotFiles = [...this.soulMapDiffChangedFiles.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([p]) => p.split("/").pop() ?? p);
        const hot = hotFiles.length > 0 ? ` (hot: ${hotFiles.join(", ")})` : "";
        const causes: string[] = [];
        if (postCompaction) causes.push("post-compaction");
        if (hasForeign) {
          const labels = new Set<string>();
          for (const o of this.foreignEditOrigins.values()) {
            if (o.agentLabel) labels.add(`subagent ${o.agentLabel}`);
            else if (o.tabId && o.tabId !== this.tabId) labels.add(`tab ${o.tabId.slice(0, 8)}`);
          }
          if (labels.size > 0) causes.push([...labels].sort().join(", "));
          else causes.push("foreign edits");
        }
        const causeTag = causes.length > 0 ? ` — ${causes.join("; ")}` : "";
        lines.push(`# session: ${String(this.editedFiles.size)} files edited${hot}${causeTag}`);
      }
      const MAX_RICH_BLOCKS = 5;
      let richBlockCount = 0;

      // Batch-lookup memory markers for all delta paths in a single DB call.
      // Surfaces `[gotcha]` / `[pref]` / `[pinned]` next to files with stored
      // intent so Forge sees relevant history at-a-glance.
      const memoryMarkers = memoryMarkersForPaths(changed.slice(0, 15));

      for (const file of changed.slice(0, 15)) {
        const absPath = join(this.cwd, file);
        const fileExists = existsSync(absPath);
        const block = this.soulMapDiffBlocks.get(file);
        const provenance = this.classifyDeltaFile(absPath, file, memoryMarkers.get(file));

        if (!fileExists) {
          // Deleted file
          lines.push(`- ${file} [deleted]`);
        } else if (hasSnapshot && !this.soulMapSnapshotPaths.has(file)) {
          // New file — not in the frozen snapshot
          const tag = block
            ? `${file}:${block.radiusTag} [new] ${provenance}`.trimEnd()
            : `${file}: [new] ${provenance}`.trimEnd();
          lines.push(tag);
          if (block?.symbolBlock && richBlockCount < MAX_RICH_BLOCKS) {
            lines.push(block.symbolBlock);
            richBlockCount++;
          }
        } else {
          // Modified file — include blast radius + symbols if prefetched
          const tag = block
            ? `${file}:${block.radiusTag} ${provenance}`.trimEnd()
            : `${file}: ${provenance}`.trimEnd();
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

  private classifyDeltaFile(
    absPath: string,
    rel: string,
    memMarker?: { category: string | null; count: number; pinned: boolean },
  ): string {
    const tags: string[] = [];
    if (this.editedFiles.has(absPath)) tags.push("[edited]");
    if (this.mentionedFiles.has(absPath)) tags.push("[mentioned]");
    if (this.editorFile === absPath) tags.push("[open]");
    if (this.soulMapNewFilesEmitted.has(rel) && existsSync(absPath)) {
      tags.push("[modified-since-new]");
    }
    const failure = this.recentToolFailures.find((f) => f.target === absPath || f.target === rel);
    if (failure) tags.push(`[recent failure: ${failure.tool} — ${failure.reason}]`);
    if (memMarker && memMarker.count > 0) {
      const cat = memMarker.category ?? "memory";
      const pin = memMarker.pinned ? "pinned " : "";
      const n = memMarker.count > 1 ? ` ×${String(memMarker.count)}` : "";
      tags.push(`[${pin}${cat}${n}]`);
    }
    return tags.join(" ");
  }

  /** Drop the cached snapshot so the next call rebuilds. */
  forceSnapshotRefresh(): void {
    this.soulMapSnapshot = null;
  }

  commitSoulMapDiff(): void {
    if (this.pendingSoulMapDiff) {
      // Mark all files currently in the delta as "emitted" so the next edit
      // gets [modified-since-new] instead of repeating [new].
      const hasSnapshot = this.soulMapSnapshotPaths.size > 0;
      if (hasSnapshot) {
        for (const rel of this.soulMapDiffChangedFiles.keys()) {
          if (!this.soulMapSnapshotPaths.has(rel)) {
            this.soulMapNewFilesEmitted.add(rel);
          }
        }
      }
      this.lastEmittedSoulMapDiff = this.pendingSoulMapDiff;
      this.pendingSoulMapDiff = null;
      // Header causes are turn-scoped — once emitted, future deltas in the
      // same TTL window shouldn't re-announce them.
      this.postCompactionPending = false;
      this.foreignEditOrigins.clear();
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

  /**
   * Resolve and wire the memory embedder. Pipeline:
   *   1. config.memory.embeddingModel (explicit)
   *   2. config.taskRouter.semantic
   *   3. heuristic from active chat model's provider
   *   4. null → hashbag-v2 fallback
   *
   * Best-effort — every failure path falls back to hashbag-v2 and logs
   * once to background errors. NEVER throws. Idempotent: re-calling with
   * the same resolved model is a no-op via MemoryManager.configureEmbedder.
   */
  private async maybeWireMemoryEmbedder(activeModelId?: string): Promise<void> {
    try {
      const [{ loadConfig }, { resolveEmbeddingModel }] = await Promise.all([
        import("../../config/index.js"),
        import("../memory/embedder-resolver.js"),
      ]);
      const cfg = loadConfig();
      const active = activeModelId ?? this.lastActiveModel ?? cfg.defaultModel ?? "";
      const resolution = resolveEmbeddingModel(cfg, active);
      this._lastEmbedderResolution = resolution;
      if (!resolution.modelId) {
        // Explicitly nothing to wire — stay on hashbag, no error.
        this.memoryManager.setProviderEmbedder(null);
        this.memoryRecall.setProviderEmbedder(null);
        return;
      }
      const provider = await this.memoryManager.configureEmbedder(resolution.modelId);
      if (provider) {
        this.memoryRecall.setProviderEmbedder(provider);
      } else {
        // configureEmbedder smoke-tested and rejected — log once, fall back.
        try {
          const { logBackgroundError } = await import("../../stores/errors.js");
          logBackgroundError(
            "memory.embedder",
            `Failed to wire ${resolution.modelId} (${resolution.reason}) — using hashbag-v2`,
          );
        } catch {}
        this.memoryRecall.setProviderEmbedder(null);
      }
    } catch {
      // Unrecoverable resolver error — stay on hashbag, no crash.
      try {
        this.memoryManager.setProviderEmbedder(null);
        this.memoryRecall.setProviderEmbedder(null);
      } catch {}
    }
  }

  /** Last embedder resolution result — used by audit/debug surfaces. */
  private _lastEmbedderResolution:
    | import("../memory/embedder-resolver.js").EmbedderResolution
    | null = null;

  getEmbedderResolution(): import("../memory/embedder-resolver.js").EmbedderResolution | null {
    return this._lastEmbedderResolution;
  }

  /**
   * Re-resolve the embedder when the active model changes. Called from
   * notifyProviderSwitch. Safe to call repeatedly; idempotent when resolved
   * model id is unchanged.
   */
  async refreshMemoryEmbedder(activeModelId: string): Promise<void> {
    await this.maybeWireMemoryEmbedder(activeModelId);
  }

  /**
   * Subscribe to provider switches so the memory embedder refreshes when
   * the user changes the active chat model. Child CMs (shared resources)
   * skip this — the parent CM owns the subscription and the shared
   * memoryManager/memoryRecall pair gets updated in-place.
   */
  private subscribeToProviderSwitches(): void {
    if (this.isChild) return;
    void import("../llm/provider.js")
      .then(({ onProviderSwitch }) => {
        const unsub = onProviderSwitch(async (newModelId) => {
          try {
            await this.refreshMemoryEmbedder(newModelId);
          } catch {}
        });
        this._unsubProviderSwitch = unsub;
      })
      .catch(() => {});
  }

  private _unsubProviderSwitch: (() => void) | null = null;
  private unsubNvimWritten: (() => void) | null = null;
  private prefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Cheap O(1) check — true when buildSoulMapDiff would produce content. */
  hasSoulMapDiff(): boolean {
    return this.soulMapDiffChangedFiles.size > 0 && this.isRepoMapReady();
  }

  private lastTurnAt = 0;

  /**
   * Anthropic ephemeral cache lives 5 minutes. After that idle window the
   * cached prefix is dead — accumulated soul-map diff blocks become pure
   * token cost with zero cache benefit. Reseed the snapshot from current
   * state and clear diff accumulation so the next API call writes a fresh,
   * clean cache. Returns true when a reseed fired.
   *
   * Call at user-turn boundary, BEFORE building the agent. Never call
   * mid-step.
   */
  maybeReseedExpiredCache(idleMs = 270_000): boolean {
    const now = Date.now();
    const prev = this.lastTurnAt;
    this.lastTurnAt = now;
    if (prev === 0) return false;
    if (now - prev < idleMs) return false;
    if (this.soulMapDiffChangedFiles.size === 0) return false;
    this.resetForCompaction();
    return true;
  }

  private pendingSemanticMode: "ast" | "synthetic" | "llm" | "full" | "on" | null = null;
  private soulMapNewFilesEmitted = new Set<string>();
  private recentToolFailures: Array<{ tool: string; target: string; reason: string; at: number }> =
    [];

  recordToolFailure(tool: string, target: string, reason: string): void {
    const at = Date.now();
    const key = `${tool}:${target}`;
    const existing = this.recentToolFailures.findIndex((f) => `${f.tool}:${f.target}` === key);
    if (existing >= 0) this.recentToolFailures.splice(existing, 1);
    this.recentToolFailures.push({ tool, target, reason, at });
    if (this.recentToolFailures.length > 5) this.recentToolFailures.shift();
    this.pendingSoulMapDiff = null;
    if (target) {
      const rel = target.startsWith(`${this.cwd}/`) ? target.slice(this.cwd.length + 1) : target;
      if (!this.soulMapDiffChangedFiles.has(rel)) {
        this.soulMapDiffChangedFiles.set(rel, ++this.soulMapDiffSeq);
      }
    }
  }

  private foreignEditOrigins: Map<string, { tabId: string | null; agentLabel: string | null }> =
    new Map();
  private postCompactionPending = false;
}

export { extractConversationTerms } from "./conversation-terms.js";
