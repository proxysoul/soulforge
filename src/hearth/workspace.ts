/**
 * ChatWorkspace — one per (surfaceId, externalId) pair.
 * Owns tabs, session persistence, and a reference to the chat binding.
 */

import { randomUUID } from "node:crypto";
import { loadConfig, loadProjectConfig, mergeConfigs } from "../config/index.js";
import { SessionManager } from "../core/sessions/manager.js";
import type { SessionMeta, TabMeta } from "../core/sessions/types.js";
import type { AppConfig, ForgeMode, InteractiveCallbacks } from "../types/index.js";
import { buildHearthApprovals, buildHearthCallbacks } from "./callbacks.js";
import { TabLoop } from "./tab-loop.js";
import type { ChatBinding, HearthConfig, Surface } from "./types.js";

export interface WorkspaceDeps {
  surface: Surface;
  binding: ChatBinding;
  hearthConfig: HearthConfig;
  log?: (line: string) => void;
  buildCallbacks?: (ctx: { tabId: string }) => InteractiveCallbacks;
  /** Optional hook for the daemon to observe per-tab HeadlessEvents (stats, telemetry). */
  onTabEvent?: (ev: import("../headless/types.js").HeadlessEvent) => void;
}

interface TabRecord {
  loop: TabLoop;
  meta: TabMeta;
}

export class ChatWorkspace {
  readonly surface: Surface;
  readonly binding: ChatBinding;
  private hearthConfig: HearthConfig;
  private log: (line: string) => void;
  /** Keep a reference so tests/tools can inspect the active config without reaching into daemon state. */
  public get effectiveHearthConfig(): HearthConfig {
    return this.hearthConfig;
  }
  private mergedConfig: AppConfig;
  private sessionManager: SessionManager;
  private tabs = new Map<string, TabRecord>();
  private activeTabId: string | null = null;
  private sessionId: string;
  private closed = false;
  private buildCallbacksOverride?: (ctx: { tabId: string }) => InteractiveCallbacks;
  private onTabEvent?: (ev: import("../headless/types.js").HeadlessEvent) => void;

  constructor(deps: WorkspaceDeps) {
    this.surface = deps.surface;
    this.binding = deps.binding;
    this.hearthConfig = deps.hearthConfig;
    this.log = deps.log ?? (() => {});
    this.sessionId = randomUUID();
    this.buildCallbacksOverride = deps.buildCallbacks;
    this.onTabEvent = deps.onTabEvent;

    const globalCfg = loadConfig();
    const projectCfg = loadProjectConfig(deps.binding.cwd);
    this.mergedConfig = mergeConfigs(globalCfg, projectCfg);
    if (deps.binding.defaultModel) this.mergedConfig.defaultModel = deps.binding.defaultModel;

    this.sessionManager = new SessionManager(deps.binding.cwd);
  }

  /** Open a tab with the given label. Returns the tabId. */
  async openTab(label?: string, forgeMode?: ForgeMode): Promise<string> {
    if (this.closed) throw new Error("workspace closed");
    if (this.tabs.size >= this.binding.maxTabs) {
      throw new Error(`max tabs reached (${String(this.binding.maxTabs)})`);
    }

    const tabId = randomUUID();
    const tabLabel = label ?? `TAB-${String(this.tabs.size + 1)}`;
    const callbacks =
      this.buildCallbacksOverride?.({ tabId }) ??
      buildHearthCallbacks({
        surface: this.surface,
        externalId: this.binding.externalId,
        tabId,
        log: this.log,
      });
    const approvals = buildHearthApprovals({
      surface: this.surface,
      externalId: this.binding.externalId,
      tabId,
      log: this.log,
    });

    const loop = new TabLoop({
      tabId,
      tabLabel,
      surface: this.surface,
      externalId: this.binding.externalId,
      cwd: this.binding.cwd,
      model: this.binding.defaultModel,
      mode: forgeMode ?? this.binding.mode,
      callbacks,
      onApproveDestructive: approvals.onApproveDestructive,
      onApproveOutsideCwd: approvals.onApproveOutsideCwd,
      mergedConfig: this.mergedConfig,
      sessionId: this.sessionId,
      onEvent: this.onTabEvent,
      onExit: (reason, err) => {
        this.log(`tab ${tabId.slice(0, 8)} exit (${reason})${err ? `: ${err.message}` : ""}`);
        this.tabs.delete(tabId);
        if (this.activeTabId === tabId) {
          const [firstId] = this.tabs.keys();
          this.activeTabId = firstId ?? null;
        }
      },
    });

    const meta: TabMeta = {
      id: tabId,
      label: tabLabel,
      activeModel: this.binding.defaultModel ?? this.mergedConfig.defaultModel ?? "",
      sessionId: this.sessionId,
      planMode: false,
      planRequest: null,
      coAuthorCommits: false,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      messageRange: { startLine: 0, endLine: 0 },
      forgeMode: forgeMode ?? this.binding.mode,
    };

    this.tabs.set(tabId, { loop, meta });
    if (!this.activeTabId) this.activeTabId = tabId;
    void loop.start();
    return tabId;
  }

  setActiveTab(tabId: string): boolean {
    if (!this.tabs.has(tabId)) return false;
    this.activeTabId = tabId;
    return true;
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  listTabs(): TabMeta[] {
    return [...this.tabs.values()].map((r) => r.meta);
  }

  getTab(tabId: string): TabRecord | undefined {
    return this.tabs.get(tabId);
  }

  /** Send a prompt to the active tab (or the given tabId if specified). */
  sendPrompt(text: string, tabId?: string): string | null {
    const targetId = tabId ?? this.activeTabId;
    if (!targetId) return null;
    const rec = this.tabs.get(targetId);
    if (!rec) return null;
    const id = rec.loop.enqueuePrompt(text);
    return id;
  }

  abortActiveTurn(tabId?: string): boolean {
    const targetId = tabId ?? this.activeTabId;
    if (!targetId) return false;
    const rec = this.tabs.get(targetId);
    if (!rec) return false;
    rec.loop.abortTurn();
    return true;
  }

  async closeTab(tabId: string): Promise<boolean> {
    const rec = this.tabs.get(tabId);
    if (!rec) return false;
    await rec.loop.close();
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      const [firstId] = this.tabs.keys();
      this.activeTabId = firstId ?? null;
    }
    return true;
  }

  /**
   * Flush session metadata. Skips when there are no tabs — calling saveSession
   * with an empty tab map would overwrite the messages.jsonl of an active session
   * with an empty file. We only write when we have real tab state to persist.
   */
  async flush(): Promise<void> {
    if (this.tabs.size === 0) return;
    try {
      const meta: SessionMeta = {
        id: this.sessionId,
        title: `Hearth · ${this.binding.label ?? this.binding.externalId}`,
        cwd: this.binding.cwd,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        activeTabId: this.activeTabId ?? "",
        forgeMode: this.binding.mode ?? "default",
        tabs: this.listTabs(),
      };
      await this.sessionManager.saveSession(meta, new Map());
    } catch (err) {
      this.log(`flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const rec of [...this.tabs.values()]) {
      try {
        await rec.loop.close();
      } catch {}
    }
    this.tabs.clear();
    await this.flush();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Refresh the merged AppConfig (re-read project config after edits). */
  reloadConfig(): void {
    const globalCfg = loadConfig();
    const projectCfg = loadProjectConfig(this.binding.cwd);
    this.mergedConfig = mergeConfigs(globalCfg, projectCfg);
    if (this.binding.defaultModel) this.mergedConfig.defaultModel = this.binding.defaultModel;
  }

  /** Update the cached hearth config (daemon reloads). */
  updateHearthConfig(cfg: HearthConfig): void {
    this.hearthConfig = cfg;
  }
}
