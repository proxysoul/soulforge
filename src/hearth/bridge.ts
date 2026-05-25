/**
 * HearthBridge — in-process router between the TUI's live tabs and Hearth surfaces.
 *
 * Architecture:
 *   TUI (useChat per tab) ─┐            ┌─→ Telegram/Discord adapter
 *                          │            │
 *                          └── Bridge ──┘
 *
 * The bridge is a module-level singleton:
 *
 *   1. TUI side calls `registerTab({ tabId, submit, abort })` when a tab mounts,
 *      and `unregisterTab(tabId)` when it unmounts.
 *   2. TUI side calls `emitTabEvent(tabId, event)` for each HeadlessEvent of a
 *      finalized turn (we only need turn boundaries — raw streaming deltas are
 *      discarded server-side to avoid message spam).
 *   3. Daemon side calls `setBinding({ surfaceId, externalId, tabId, muted })`
 *      when a user picks a Telegram chat -> TUI tab pairing. Unset via
 *      `clearBinding(surfaceId, externalId)`.
 *   4. Surface adapters call `handleInbound({ surfaceId, externalId, text,
 *      command })` when a Telegram/Discord message arrives. If the
 *      chat has a binding, the bridge routes to the TUI tab's submit handler.
 *
 * No callbacks cross this module by value — everything is registered by id and
 * looked up per call, so reloads, hot-module replaces, and detached daemon
 * modes degrade to "binding exists but tab not registered" (drop silently).
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir, safeRename } from "../core/platform/index.js";
import type { HeadlessEvent } from "../headless/types.js";
import type { ExternalChatId, SurfaceId } from "./types.js";

/** Where the live bridge bindings persist between TUI restarts. */
export const BRIDGE_STATE_PATH = join(configDir(), "hearth-bridge.json");

export interface TabHandle {
  tabId: string;
  /** Called when Telegram sends free text (optionally with images).
   *  inboundId lets the caller correlate the user message stamp without a race. */
  submit: (
    input: string,
    origin: BridgeOrigin,
    inboundId: string,
    images?: Array<{ url: string; mediaType: string }>,
  ) => void | Promise<void>;
  /** Called when Telegram sends /stop. */
  abort: () => void;
  /** Human-readable label — used by `/tabs` command and persistent restore. */
  label: string;
}

export type BridgeOrigin = "telegram" | "discord" | "fakechat";

/** A chat ↔ tab pairing. */
export interface BridgeBinding {
  surfaceId: SurfaceId;
  externalId: ExternalChatId;
  tabId: string;
  /** Snapshot of the tab's label at bind time — used to re-resolve after restart. */
  tabLabel?: string;
  /** When true, outbound events from the tab are NOT forwarded to the surface. */
  muted?: boolean;
  /** Outbound filter:
   *   "on"     → everything (default)
   *   "off"    → nothing (same as muted, granular replacement)
   *   "errors" → only errors + turn-done
   */
  notifyMode?: "on" | "off" | "errors";
}

/** Callable registered by the daemon to push events out to surfaces. */
export type BridgeOutboundSender = (
  surfaceId: SurfaceId,
  externalId: ExternalChatId,
  event: HeadlessEvent,
) => void | Promise<void>;

/** Inbound message coming from a surface (Telegram/Discord). */
export interface BridgeInbound {
  surfaceId: SurfaceId;
  externalId: ExternalChatId;
  text: string;
  senderLabel?: string;
  /** Optional caller-side id (e.g. surface message id). Generated if omitted. */
  inboundId?: string;
  /** Optional image attachments (data:/ URL with mime type). */
  images?: Array<{ url: string; mediaType: string }>;
}

interface PersistedBridgeState {
  version: 1;
  bindings: BridgeBinding[];
  activeTabByChat?: Record<string, string>;
}

/** Key for chat binding map. */
function chatKey(surfaceId: SurfaceId, externalId: ExternalChatId): string {
  return `${surfaceId}\u0000${externalId}`;
}

/** Snapshot of a TUI tab — returned to remote `/status`. */
export interface TabStatusSnapshot {
  tabId: string;
  label: string;
  activeModel: string;
  forgeMode: string;
  isLoading: boolean;
  messageCount: number;
  tokenUsage: { input: number; output: number };
  /** Lifetime cost — dollars. Optional (provider may not report). */
  costUsd?: number;
  /** Working directory for this tab. */
  cwd?: string;
  /** Pending message-queue items (count). */
  queueCount?: number;
}

/** Provider callbacks the TUI registers on boot so remote commands reach React state. */
export interface TuiActions {
  createTab?: (label?: string) => string | null;
  closeTab?: (tabId: string) => boolean;
  getTabStatus?: (tabId: string) => TabStatusSnapshot | null;
  // T1 — writer commands
  setActiveModel?: (tabId: string, model: string) => boolean;
  setForgeMode?: (tabId: string, mode: string) => boolean;
  clearTab?: (tabId: string) => boolean;
  // T2 — tab-state
  getCost?: (
    tabId: string,
  ) => { input: number; output: number; cacheRead?: number; usd?: number } | null;
  getQueue?: (tabId: string) => string[];
  appendQueue?: (tabId: string, text: string) => boolean;
  getDiff?: (tabId: string) => string;
  getFiles?: (tabId: string) => string;
  getCwd?: (tabId: string) => string;
  setCwd?: (tabId: string, path: string) => { ok: boolean; error?: string };
  // T3 — history
  listSessions?: (limit?: number) => Array<{ id: string; title: string; updatedAt: number }>;
  resumeSession?: (idPrefix: string) => { ok: boolean; tabId?: string; error?: string };
  listCheckpoints?: (tabId: string) => Array<{ index: number; label: string; ts: number }>;
  undoCheckpoint?: (
    tabId: string,
    index?: number,
  ) => { ok: boolean; restoredTo?: number; error?: string };
  // T4 — agents
  listAgents?: (tabId: string) => Array<{ id: string; task: string; status: string }>;
  cancelAgent?: (tabId: string, id: string) => boolean;
  // T5 — mcp
  listMcp?: () => Array<{ name: string; enabled: boolean; status: string }>;
  toggleMcp?: (name: string) => { ok: boolean; enabled?: boolean; error?: string };
  // T6 — notify (supersedes mute)
  setNotifyMode?: (tabId: string, mode: "on" | "off" | "errors") => boolean;
  // T7 — cross-tab
  sendToTab?: (tabId: string, text: string) => boolean;
  // T8 — find / branch
  findInTab?: (
    tabId: string,
    query: string,
    limit?: number,
  ) => Array<{ msgId: string; snippet: string }>;
  branchTab?: (tabId: string, label?: string) => { ok: boolean; tabId?: string; error?: string };
}

class HearthBridgeImpl {
  private tabs = new Map<string, TabHandle>();
  private bindings = new Map<string, BridgeBinding>();
  private outboundSender: BridgeOutboundSender | null = null;
  /** Per-chat "currentTabId" — defaults to the binding tab but /tab N overrides. */
  private activeTabByChat = new Map<string, string>();
  private listTabsCallback: (() => Array<{ id: string; label: string }>) | null = null;
  private tuiActions: TuiActions = {};
  /** Pending bindings waiting on a tab that hasn't mounted yet. Keyed by label. */
  private pendingByLabel = new Map<string, BridgeBinding[]>();
  /** When true, persistence is disabled (tests). */
  private persistDisabled = false;

  // ── TUI side API ────────────────────────────────────────────────────────

  registerTab(handle: TabHandle): void {
    this.tabs.set(handle.tabId, handle);
    // Resolve any pending bindings whose label matches the new tab — handles
    // the "binding restored before tab mounts" race.
    const queued = this.pendingByLabel.get(handle.label);
    if (queued) {
      for (const b of queued) this.setBinding({ ...b, tabId: handle.tabId });
      this.pendingByLabel.delete(handle.label);
    }
  }

  unregisterTab(tabId: string): void {
    this.tabs.delete(tabId);
    // Drop bindings that reference this tab. Re-queue them by label so they
    // re-resolve when the tab is re-created (session restore, hot reload).
    // Preserve activeTabByChat: the chat's view selection survives HMR and
    // transient tab unmounts; it only resets when the user issues /tab N.
    for (const [key, binding] of this.bindings) {
      if (binding.tabId === tabId) {
        this.bindings.delete(key);
        if (binding.tabLabel) {
          const arr = this.pendingByLabel.get(binding.tabLabel) ?? [];
          arr.push(binding);
          this.pendingByLabel.set(binding.tabLabel, arr);
        }
      }
    }
    this.persist();
  }

  /** TUI registers this once on boot so the bridge can enumerate tabs for /tabs. */
  setTabListProvider(cb: () => Array<{ id: string; label: string }>): void {
    this.listTabsCallback = cb;
  }

  listTabs(): Array<{ id: string; label: string }> {
    return this.listTabsCallback?.() ?? [];
  }

  /** TUI registers callbacks so remote commands can create / close / inspect tabs. */
  setTuiActions(actions: TuiActions): void {
    this.tuiActions = { ...this.tuiActions, ...actions };
  }

  createTab(label?: string): string | null {
    return this.tuiActions.createTab?.(label) ?? null;
  }

  closeRemoteTab(tabId: string): boolean {
    return this.tuiActions.closeTab?.(tabId) ?? false;
  }

  getTabStatus(tabId: string): TabStatusSnapshot | null {
    return this.tuiActions.getTabStatus?.(tabId) ?? null;
  }

  /** TUI pushes a finalized turn's HeadlessEvents here. */
  emitTabEvent(tabId: string, event: HeadlessEvent): void {
    if (!this.outboundSender) return;
    for (const binding of this.bindings.values()) {
      if (binding.muted) continue;
      // notifyMode filter — "off" drops all, "errors" drops non-critical.
      const mode = binding.notifyMode ?? "on";
      if (mode === "off") continue;
      if (mode === "errors") {
        const t = event.type;
        if (t !== "error" && t !== "turn-done" && t !== "done") continue;
      }
      // Route to chats whose *currently-viewed* tab matches (activeTabByChat
      // overlay), falling back to the home binding tabId. This way /tab N
      // switches the view without orphaning the home tab's stream.
      const key = chatKey(binding.surfaceId, binding.externalId);
      const viewTabId = this.activeTabByChat.get(key) ?? binding.tabId;
      if (viewTabId !== tabId) continue;
      try {
        void this.outboundSender(binding.surfaceId, binding.externalId, event);
      } catch {
        // Never let outbound errors crash the TUI.
      }
    }
  }

  // ── Daemon side API ─────────────────────────────────────────────────────

  setOutboundSender(sender: BridgeOutboundSender | null): void {
    this.outboundSender = sender;
  }

  setBinding(binding: BridgeBinding): void {
    const key = chatKey(binding.surfaceId, binding.externalId);
    // Capture current label if the tab is registered and the caller didn't pass one.
    const live = this.tabs.get(binding.tabId);
    const enriched: BridgeBinding = {
      ...binding,
      tabLabel: binding.tabLabel ?? live?.label,
    };
    this.bindings.set(key, enriched);
    // Only seed activeTabByChat when the chat has no view selection yet.
    // /tab N moves the view; do not let restore/reregister snap it back.
    if (!this.activeTabByChat.has(key)) {
      this.activeTabByChat.set(key, enriched.tabId);
    }
    this.persist();
  }

  clearBinding(surfaceId: SurfaceId, externalId: ExternalChatId): void {
    const key = chatKey(surfaceId, externalId);
    this.bindings.delete(key);
    this.activeTabByChat.delete(key);
    this.persist();
  }

  getBinding(surfaceId: SurfaceId, externalId: ExternalChatId): BridgeBinding | null {
    return this.bindings.get(chatKey(surfaceId, externalId)) ?? null;
  }

  listBindings(): BridgeBinding[] {
    return [...this.bindings.values()];
  }

  /** Switch the active tab for a bound chat. Returns the new tab id or null. */
  switchActiveTab(surfaceId: SurfaceId, externalId: ExternalChatId, tabId: string): string | null {
    const key = chatKey(surfaceId, externalId);
    if (!this.tabs.has(tabId)) return null;
    this.activeTabByChat.set(key, tabId);
    // NOTE: do NOT mutate binding.tabId here. The binding records the *home*
    // tab for inbound routing; activeTabByChat is the *view selector* for /tab N.
    // Outbound fan-out keys off activeTabByChat (see emitTabEvent) so streams
    // from the currently-viewed tab reach the chat regardless of the home tab.
    this.persist();
    return tabId;
  }

  getActiveTabId(surfaceId: SurfaceId, externalId: ExternalChatId): string | null {
    const key = chatKey(surfaceId, externalId);
    return this.activeTabByChat.get(key) ?? this.bindings.get(key)?.tabId ?? null;
  }

  /** Toggle the mute flag for a binding. Returns the new state or null. */
  setMuted(surfaceId: SurfaceId, externalId: ExternalChatId, muted: boolean): boolean | null {
    const key = chatKey(surfaceId, externalId);
    const existing = this.bindings.get(key);
    if (!existing) return null;
    this.bindings.set(key, { ...existing, muted });
    return muted;
  }

  // ── Surface side API (called by adapter inbound handlers) ───────────────

  /**
   * Deliver a Telegram/Discord message to the bound TUI tab.
   * Returns true if the bridge handled it, false if there's no binding
   * (caller should fall back to daemon workspace behavior).
   *
   * Errors thrown by `tab.submit` propagate back via the outbound sender
   * as a synthetic `error` HeadlessEvent so the remote user sees a hint.
   */
  handleInbound(msg: BridgeInbound, origin: BridgeOrigin): boolean {
    const tabId = this.getActiveTabId(msg.surfaceId, msg.externalId);
    if (!tabId) return false;
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const inboundId = msg.inboundId ?? randomInboundId();
    // H7 — stamp the origin into the text the agent sees so the model can
    // distinguish remote-surface input from local-keyboard input. Prompt-
    // injection defence: a Telegram user saying "ignore previous
    // instructions" still prefixes with [via telegram] in the conversation
    // history, so the model has a signal that this is an untrusted remote
    // source rather than the operator at the keyboard.
    const stampedText =
      origin === "fakechat" || !msg.text
        ? msg.text
        : `[via ${origin} — remote surface] ${msg.text}`;
    const result = tab.submit(stampedText, origin, inboundId, msg.images);
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch((err) =>
        this.notifyError(msg.surfaceId, msg.externalId, err),
      );
    }
    return true;
  }

  /** Push a synthetic error event back to the surface so the remote sees it. */
  notifyError(surfaceId: SurfaceId, externalId: ExternalChatId, err: unknown): void {
    if (!this.outboundSender) return;
    const msg = err instanceof Error ? err.message : String(err);
    try {
      void this.outboundSender(surfaceId, externalId, {
        type: "error",
        error: `Forge error: ${msg}`,
      });
    } catch {}
  }

  /** Abort the turn in the tab bound to this chat. */
  abortBoundTab(surfaceId: SurfaceId, externalId: ExternalChatId): boolean {
    const tabId = this.getActiveTabId(surfaceId, externalId);
    if (!tabId) return false;
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    tab.abort();
    return true;
  }

  /** Enumerate tabs eligible for /tab <n>. */
  tabForIndex(index: number): { id: string; label: string } | null {
    const list = this.listTabs();
    return list[index] ?? null;
  }

  // ── Persistence (~/.soulforge/hearth-bridge.json) ───────────────────────

  /** Re-load bindings from disk. Call once on TUI boot before tabs mount. */
  restoreFromDisk(): void {
    if (!existsSync(BRIDGE_STATE_PATH)) return;
    try {
      const raw = readFileSync(BRIDGE_STATE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as PersistedBridgeState;
      if (parsed.version !== 1 || !Array.isArray(parsed.bindings)) return;
      for (const b of parsed.bindings) {
        // Live tab might exist already (HMR). If so, rebind; otherwise queue
        // for resolution when registerTab fires with a matching label.
        const live = b.tabId ? this.tabs.get(b.tabId) : null;
        if (live) {
          this.bindings.set(chatKey(b.surfaceId, b.externalId), { ...b, tabLabel: live.label });
          this.activeTabByChat.set(chatKey(b.surfaceId, b.externalId), b.tabId);
          continue;
        }
        if (b.tabLabel) {
          const arr = this.pendingByLabel.get(b.tabLabel) ?? [];
          arr.push(b);
          this.pendingByLabel.set(b.tabLabel, arr);
        }
      }
      // Restore persisted view selections (/tab N survives restart).
      if (parsed.activeTabByChat) {
        for (const [key, tabId] of Object.entries(parsed.activeTabByChat)) {
          this.activeTabByChat.set(key, tabId);
        }
      }
    } catch {
      // Corrupted state — ignore and continue with empty bridge.
    }
  }

  private persist(): void {
    if (this.persistDisabled) return;
    try {
      mkdirSync(dirname(BRIDGE_STATE_PATH), { recursive: true, mode: 0o700 });
      const state: PersistedBridgeState = {
        version: 1,
        bindings: [...this.bindings.values()],
        activeTabByChat: Object.fromEntries(this.activeTabByChat),
      };
      // H9: atomic write via tmp+rename — a crash mid-write can't truncate the
      // bindings file and lose every chat->tab mapping on next boot.
      const tmp = `${BRIDGE_STATE_PATH}.tmp.${String(process.pid)}.${String(Date.now())}`;
      writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      safeRename(tmp, BRIDGE_STATE_PATH);
    } catch {
      // Persistence failure is non-fatal — bridge keeps working in memory.
    }
  }

  // ── Test helpers ────────────────────────────────────────────────────────

  /** Disable disk writes — only used in tests. */
  _disablePersistForTests(): void {
    this.persistDisabled = true;
  }

  /** Reset everything — only used in tests. */
  _resetForTests(): void {
    this.tabs.clear();
    this.bindings.clear();
    this.activeTabByChat.clear();
    this.pendingByLabel.clear();
    this.outboundSender = null;
    this.listTabsCallback = null;
    this.tuiActions = {};
  }

  setActiveModelFor(tabId: string, model: string): boolean {
    return this.tuiActions.setActiveModel?.(tabId, model) ?? false;
  }

  setForgeModeFor(tabId: string, mode: string): boolean {
    return this.tuiActions.setForgeMode?.(tabId, mode) ?? false;
  }

  clearTab(tabId: string): boolean {
    return this.tuiActions.clearTab?.(tabId) ?? false;
  }

  getCost(tabId: string) {
    return this.tuiActions.getCost?.(tabId) ?? null;
  }

  getQueue(tabId: string): string[] {
    return this.tuiActions.getQueue?.(tabId) ?? [];
  }

  appendQueue(tabId: string, text: string): boolean {
    return this.tuiActions.appendQueue?.(tabId, text) ?? false;
  }

  getDiff(tabId: string): string {
    return this.tuiActions.getDiff?.(tabId) ?? "";
  }

  getFiles(tabId: string): string {
    return this.tuiActions.getFiles?.(tabId) ?? "";
  }

  getCwd(tabId: string): string {
    return this.tuiActions.getCwd?.(tabId) ?? "";
  }

  setCwd(tabId: string, path: string) {
    return this.tuiActions.setCwd?.(tabId, path) ?? { ok: false, error: "no provider" };
  }

  listSessions(limit?: number) {
    return this.tuiActions.listSessions?.(limit) ?? [];
  }

  resumeSession(idPrefix: string) {
    return this.tuiActions.resumeSession?.(idPrefix) ?? { ok: false, error: "no provider" };
  }

  listCheckpoints(tabId: string) {
    return this.tuiActions.listCheckpoints?.(tabId) ?? [];
  }

  undoCheckpoint(tabId: string, index?: number) {
    return this.tuiActions.undoCheckpoint?.(tabId, index) ?? { ok: false, error: "no provider" };
  }

  listAgents(tabId: string) {
    return this.tuiActions.listAgents?.(tabId) ?? [];
  }

  cancelAgent(tabId: string, id: string): boolean {
    return this.tuiActions.cancelAgent?.(tabId, id) ?? false;
  }

  listMcp() {
    return this.tuiActions.listMcp?.() ?? [];
  }

  toggleMcp(name: string) {
    return this.tuiActions.toggleMcp?.(name) ?? { ok: false, error: "no provider" };
  }

  setNotifyMode(tabId: string, mode: "on" | "off" | "errors"): boolean {
    return this.tuiActions.setNotifyMode?.(tabId, mode) ?? false;
  }

  sendToTab(tabId: string, text: string): boolean {
    return this.tuiActions.sendToTab?.(tabId, text) ?? false;
  }

  findInTab(tabId: string, query: string, limit?: number) {
    return this.tuiActions.findInTab?.(tabId, query, limit) ?? [];
  }

  branchTab(tabId: string, label?: string) {
    return this.tuiActions.branchTab?.(tabId, label) ?? { ok: false, error: "no provider" };
  }

  /** Set outbound filter per chat: "on" | "off" | "errors". Returns new value or null. */
  setNotifyModeForChat(
    surfaceId: SurfaceId,
    externalId: ExternalChatId,
    mode: "on" | "off" | "errors",
  ): "on" | "off" | "errors" | null {
    const key = chatKey(surfaceId, externalId);
    const existing = this.bindings.get(key);
    if (!existing) return null;
    this.bindings.set(key, { ...existing, notifyMode: mode });
    this.persist();
    return mode;
  }

  /** True when a surface host is attached (daemon live, or TUI host up).
   *  Used by askRemote to avoid emitting approval-requests into the void when
   *  Hearth is offline — the callback would just time out and the approval
   *  would silently deny. */
  isBridgeLive(): boolean {
    return this.outboundSender !== null;
  }
}

function randomInboundId(): string {
  // Short, monotonic-ish id — only used to correlate the user message stamp.
  return `in_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export const hearthBridge = new HearthBridgeImpl();
export type HearthBridge = HearthBridgeImpl;

// ── Bridge ownership lock ─────────────────────────────────────────────────
// Advisory file-based mutex so a running TUI and a separately-started daemon
// don't both try to route inbound Telegram traffic. The TUI writes its pid on
// boot; the daemon reads it before installing its own outbound sender.
//
// Lock file format (one line): `<pid>:<startedMs>`
//   - pid       — owning process id
//   - startedMs — Date.now() at the moment of acquisition
//
// The `startedMs` tag guards against pid reuse: if an unrelated process
// inherits the pid after the TUI crashes, `kill(pid,0)` would still succeed
// and the daemon/TUI would wrongly treat it as the owner. We record our own
// boot wall-clock and only trust the lock if its timestamp is plausibly in
// the past (< now, and written by a still-live pid). A future rewrite could
// bind to `/proc/<pid>/stat` start-time on Linux, but that's platform-specific
// and a wall-clock sanity check is sufficient to break pid-reuse shadows.

export const BRIDGE_LOCK_PATH = join(configDir(), "hearth-bridge.lock");

interface BridgeLock {
  pid: number;
  startedMs: number;
}

function parseLock(raw: string): BridgeLock | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Legacy format: bare pid. Treat as stale — force-steal on next acquire.
  if (!trimmed.includes(":")) return null;
  const [pidStr, msStr] = trimmed.split(":", 2);
  const pid = Number.parseInt(pidStr ?? "", 10);
  const startedMs = Number.parseInt(msStr ?? "", 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (!Number.isFinite(startedMs) || startedMs <= 0) return null;
  return { pid, startedMs };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the current bridge owner (live pid or null).
 *  Returns null if the lock is malformed, stale (legacy bare-pid format),
 *  the pid is dead, or the timestamp is implausible (in the future). */
export function readBridgeOwner(): number | null {
  try {
    if (!existsSync(BRIDGE_LOCK_PATH)) return null;
    const lock = parseLock(readFileSync(BRIDGE_LOCK_PATH, "utf-8"));
    if (!lock) return null;
    if (lock.startedMs > Date.now() + 60_000) return null;
    if (!isPidAlive(lock.pid)) return null;
    return lock.pid;
  } catch {
    return null;
  }
}

export function acquireBridgeLock(): boolean {
  const existing = readBridgeOwner();
  if (existing && existing !== process.pid) return false;
  try {
    mkdirSync(dirname(BRIDGE_LOCK_PATH), { recursive: true, mode: 0o700 });
    const payload = `${String(process.pid)}:${String(Date.now())}`;
    // M5: O_EXCL create so two TUIs racing at boot can't both 'win'. If the
    // file already exists (stale from a crashed owner, or already-held by
    // our own pid) fall into the recovery path.
    const {
      openSync,
      writeSync,
      closeSync,
      unlinkSync: unlinkLock,
    } = require("node:fs") as typeof import("node:fs");
    let fd: number;
    try {
      fd = openSync(BRIDGE_LOCK_PATH, "wx", 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") return false;
      // EEXIST: file exists. Three cases:
      //   (a) owned by another live pid — refuse (readBridgeOwner != our pid).
      //   (b) owned by our own pid — idempotent re-acquire: unlink + rewrite.
      //   (c) stale (dead pid / malformed / implausible ts) — reap + retake.
      const owner = readBridgeOwner();
      if (owner && owner !== process.pid) return false;
      try {
        unlinkLock(BRIDGE_LOCK_PATH);
      } catch {}
      try {
        fd = openSync(BRIDGE_LOCK_PATH, "wx", 0o600);
      } catch {
        return false;
      }
    }
    try {
      writeSync(fd, payload);
    } finally {
      closeSync(fd);
    }
    installExitCleanup();
    return true;
  } catch {
    return false;
  }
}

/** TUI call: releases the bridge-ownership lock on exit. No-op if not held. */
export function releaseBridgeLock(): void {
  try {
    const owner = readBridgeOwner();
    if (owner === process.pid) unlinkSync(BRIDGE_LOCK_PATH);
  } catch {}
}

// Belt-and-suspenders: also drop the lock on abnormal exit so a crash doesn't
// leave a stale owner lingering for the next TUI boot to fight with.
let exitCleanupInstalled = false;
function installExitCleanup(): void {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  const cleanup = () => releaseBridgeLock();
  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  process.once("SIGHUP", cleanup);
}
/**
 * Streaming emitter \u2014 coalesces rapid `text` deltas into periodic flushes so
 * Telegram/etc. don't get a storm of 1-token messages. Non-text events flush
 * the buffer first so ordering is preserved.
 *
 * Usage: call `beginTurn(tabId)` at the start of a turn, feed events via
 * `stream(tabId, event)`, and `endTurn(tabId)` flushes remaining text. A hard
 * flush also happens on tool-call / tool-result / warning / error boundaries
 * so the outbound stream reads naturally.
 *
 * If no surface is bound to this tab, the emitter is a no-op.
 */
/**
 * Shared buffer/flush machinery for per-tab text coalescing. Subclasses
 * supply the emit event type; this base owns timers, buffers, and the
 * flush/discard/schedule lifecycle.
 */
abstract class BufferedTabEmitter {
  protected buffers = new Map<string, string>();
  protected timers = new Map<string, ReturnType<typeof setTimeout>>();
  protected readonly flushMs: number;

  constructor(flushMs: number) {
    this.flushMs = flushMs;
  }

  protected abstract buildEvent(content: string): HeadlessEvent;

  flushNow(tabId: string): void {
    const buf = this.buffers.get(tabId);
    if (buf && buf.length > 0) {
      this.buffers.delete(tabId);
      hearthBridge.emitTabEvent(tabId, this.buildEvent(buf));
    }
    const timer = this.timers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(tabId);
    }
  }

  discard(tabId: string): void {
    this.buffers.delete(tabId);
    const timer = this.timers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(tabId);
    }
  }

  protected scheduleFlush(tabId: string): void {
    if (this.timers.has(tabId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(tabId);
      this.flushNow(tabId);
    }, this.flushMs);
    this.timers.set(tabId, timer);
  }
}

export class BridgeStreamEmitter extends BufferedTabEmitter {
  constructor(flushMs = 350) {
    super(flushMs);
  }

  protected buildEvent(content: string): HeadlessEvent {
    return { type: "text", content };
  }

  stream(tabId: string, event: HeadlessEvent): void {
    if (event.type === "text") {
      const prev = this.buffers.get(tabId) ?? "";
      this.buffers.set(tabId, prev + event.content);
      this.scheduleFlush(tabId);
      return;
    }
    // Any non-text event flushes pending text first — preserves chronology.
    this.flushNow(tabId);
    hearthBridge.emitTabEvent(tabId, event);
  }
}

/** Singleton emitter \u2014 shared across useChat instances in the same process. */
export const bridgeStreamEmitter = new BridgeStreamEmitter();
interface PendingCallback {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Owning tab — lets cancelRemoteCallbacksForTab scope cleanly so aborting
   *  one tab doesn't nuke approvals belonging to another tab. */
  tabId: string;
}

const pendingCallbacks = new Map<string, PendingCallback>();

export function askRemote<T>(
  tabId: string,
  outbound: (callbackId: string) => HeadlessEvent,
  fallback: T,
  timeoutMs = 5 * 60_000,
): Promise<T> {
  const binding = [...hearthBridge.listBindings()].find((b) => b.tabId === tabId);
  if (!binding) return Promise.resolve(fallback);
  // Bridge offline — the event would be dropped and the promise would time out,
  // silently collapsing the local approval into a deny. Short-circuit instead.
  if (!hearthBridge.isBridgeLive()) return Promise.resolve(fallback);

  return new Promise<T>((resolve) => {
    const callbackId = `cb_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const timer = setTimeout(() => {
      pendingCallbacks.delete(callbackId);
      resolve(fallback);
    }, timeoutMs);
    pendingCallbacks.set(callbackId, {
      resolve: (v) => resolve(v as T),
      timer,
      tabId,
    });
    hearthBridge.emitTabEvent(tabId, outbound(callbackId));
  });
}

/** Adapter-side: resolve a pending remote callback. */
export function resolveRemoteCallback(callbackId: string, value: unknown): boolean {
  const entry = pendingCallbacks.get(callbackId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingCallbacks.delete(callbackId);
  entry.resolve(value);
  return true;
}

/** Cancel all pending callbacks for a tab (e.g. on tab close / abort).
 *  Resolves each callback with `null` so awaiting code sees a non-answer
 *  rather than hanging until the 5-min timeout. */
export function cancelRemoteCallbacksForTab(tabId: string): number {
  let n = 0;
  for (const [id, entry] of pendingCallbacks) {
    if (entry.tabId !== tabId) continue;
    clearTimeout(entry.timer);
    pendingCallbacks.delete(id);
    entry.resolve(null);
    n++;
  }
  return n;
}

/** True when a tab has an outstanding remote callback. Used by the stall
 *  watchdog to pause while the user is thinking on their phone. */
export function hasPendingCallbackForTab(tabId: string): boolean {
  for (const entry of pendingCallbacks.values()) {
    if (entry.tabId === tabId) return true;
  }
  return false;
}
/**
 * ReasoningStreamEmitter — separate coalescer for reasoning deltas so native
 * thinking tokens don't interleave with visible text on the bridge. Flushes
 * on any non-reasoning event, on abort, or after 800ms of silence.
 */
export class ReasoningStreamEmitter extends BufferedTabEmitter {
  constructor(flushMs = 800) {
    super(flushMs);
  }

  protected buildEvent(content: string): HeadlessEvent {
    return { type: "reasoning", content };
  }

  append(tabId: string, text: string): void {
    const prev = this.buffers.get(tabId) ?? "";
    this.buffers.set(tabId, prev + text);
    this.scheduleFlush(tabId);
  }
}

/** Singleton reasoning emitter. */
export const reasoningStreamEmitter = new ReasoningStreamEmitter();
