import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logBackgroundError } from "../../stores/errors.js";
import type { ChatMessage } from "../../types/index.js";
import { safeRename } from "../platform/index.js";
import { ensureSoulforgeDir } from "../utils/ensure-soulforge-dir.js";
import { getIOClient } from "../workers/io-client.js";
import { rebuildCoreMessages, validateCoreMessages } from "./rebuild.js";
import type { SessionMeta, TabMeta } from "./types.js";

export interface SessionListEntry {
  id: string;
  title: string;
  messageCount: number;
  startedAt: number;
  updatedAt: number;
  sizeBytes: number;
}

export class SessionManager {
  private dir: string;
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.dir = join(cwd, ".soulforge", "sessions");
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      ensureSoulforgeDir(this.cwd);
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private sessionDirSize(sessionDir: string): number {
    let total = 0;
    for (const file of ["meta.json", "messages.jsonl"]) {
      try {
        total += statSync(join(sessionDir, file)).size;
      } catch {
        // file may not exist
      }
    }
    return total;
  }

  async saveSession(
    meta: SessionMeta,
    tabMessages: Map<string, ChatMessage[]>,
    tabCoreMessages?: Map<string, import("ai").ModelMessage[]>,
  ): Promise<void> {
    // Serialize saves for the same session — concurrent saves race on the
    // two-file rename (meta.json + messages.jsonl) and can interleave such that
    // meta's messageRange offsets point into a different save's messages.jsonl.
    // Symptom: tab N's content gets sliced from tab M's range → restored tabs
    // show wrong (often duplicated) content, and the last assistant message
    // can disappear when an earlier-issued save finishes last.
    const prev = this.saveChains.get(meta.id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.doSave(meta, tabMessages, tabCoreMessages));
    this.saveChains.set(meta.id, next);
    try {
      await next;
    } finally {
      if (this.saveChains.get(meta.id) === next) {
        this.saveChains.delete(meta.id);
      }
    }
  }

  private async doSave(
    meta: SessionMeta,
    tabMessages: Map<string, ChatMessage[]>,
    tabCoreMessages?: Map<string, import("ai").ModelMessage[]>,
  ): Promise<void> {
    this.ensureDir();
    const sessionDir = join(this.dir, meta.id);

    try {
      const io = getIOClient();
      const coreEntries = tabCoreMessages
        ? ([...tabCoreMessages.entries()] as [string, import("ai").ModelMessage[]][])
        : undefined;
      await io.saveSession(sessionDir, meta, [...tabMessages.entries()], coreEntries);
      return;
    } catch {
      // IO worker unavailable — fall back to local serialization
    }

    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    }

    const allMessages: ChatMessage[] = [];
    const updatedTabs: TabMeta[] = [];

    for (const tab of meta.tabs) {
      const msgs = tabMessages.get(tab.id) ?? [];
      const startLine = allMessages.length;
      for (const msg of msgs) {
        allMessages.push(msg);
      }
      const endLine = allMessages.length;
      updatedTabs.push({ ...tab, messageRange: { startLine, endLine } });
    }

    const updatedMeta: SessionMeta = { ...meta, tabs: updatedTabs };
    const metaPath = join(sessionDir, "meta.json");
    const jsonlPath = join(sessionDir, "messages.jsonl");
    const lines = allMessages.map((m) => JSON.stringify(m)).join("\n");

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const metaTmp = `${metaPath}.${suffix}.tmp`;
    const jsonlTmp = `${jsonlPath}.${suffix}.tmp`;
    await writeFile(metaTmp, JSON.stringify(updatedMeta, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await writeFile(jsonlTmp, lines ? `${lines}\n` : "", { encoding: "utf-8", mode: 0o600 });
    await rename(jsonlTmp, jsonlPath);
    await rename(metaTmp, metaPath);

    // Save core messages (API-facing, survives compaction)
    if (tabCoreMessages) {
      const coreData: Record<string, import("ai").ModelMessage[]> = {};
      for (const [tabId, cores] of tabCoreMessages) {
        coreData[tabId] = cores;
      }
      const corePath = join(sessionDir, "core.json");
      const coreTmp = `${corePath}.${suffix}.tmp`;
      await writeFile(coreTmp, JSON.stringify(coreData), { encoding: "utf-8", mode: 0o600 });
      await rename(coreTmp, corePath);
    }
  }

  loadSession(id: string): {
    meta: SessionMeta;
    tabMessages: Map<string, ChatMessage[]>;
    tabCoreMessages?: Map<string, import("ai").ModelMessage[]>;
  } | null {
    const sessionDir = join(this.dir, id);
    const metaPath = join(sessionDir, "meta.json");
    if (!existsSync(metaPath)) return null;

    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SessionMeta;
      const jsonlPath = join(sessionDir, "messages.jsonl");
      const allMessages: ChatMessage[] = [];

      if (existsSync(jsonlPath)) {
        const content = readFileSync(jsonlPath, "utf-8").trim();
        if (content) {
          for (const line of content.split("\n")) {
            if (!line.trim()) continue;
            try {
              allMessages.push(JSON.parse(line) as ChatMessage);
            } catch {
              break;
            }
          }
        }
      }

      const tabMessages = new Map<string, ChatMessage[]>();
      for (const tab of meta.tabs) {
        const { startLine, endLine } = tab.messageRange;
        tabMessages.set(tab.id, allMessages.slice(startLine, endLine));
      }

      // Load saved core messages (API-facing, survives compaction)
      const corePath = join(sessionDir, "core.json");
      let tabCoreMessages: Map<string, import("ai").ModelMessage[]> | undefined;
      if (existsSync(corePath)) {
        try {
          const coreData = JSON.parse(readFileSync(corePath, "utf-8")) as Record<
            string,
            import("ai").ModelMessage[]
          >;
          tabCoreMessages = new Map();
          for (const [tabId, cores] of Object.entries(coreData)) {
            const validated = validateCoreMessages(cores);
            if (validated) tabCoreMessages.set(tabId, validated);
            // invalid → omit; loadSessionMessages / useTabs will rebuildCoreMessages
          }
        } catch {
          /* ignore corrupt core.json — will fall back to rebuild */
        }
      }

      return { meta, tabMessages, tabCoreMessages };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logBackgroundError("session-load", `Failed to load session ${id}: ${msg}`);
      return null;
    }
  }

  async loadSessionAsync(id: string): Promise<{
    meta: SessionMeta;
    tabMessages: Map<string, ChatMessage[]>;
    tabCoreMessages?: Map<string, import("ai").ModelMessage[]>;
  } | null> {
    const sessionDir = join(this.dir, id);
    try {
      const io = getIOClient();
      const result = await io.loadSession(sessionDir);
      if (!result) return null;
      const tabMessages = new Map<string, ChatMessage[]>();
      for (const [tabId, msgs] of result.tabEntries) {
        tabMessages.set(tabId, msgs);
      }
      let tabCoreMessages: Map<string, import("ai").ModelMessage[]> | undefined;
      if (result.coreEntries) {
        tabCoreMessages = new Map();
        for (const [tabId, cores] of result.coreEntries) {
          const validated = validateCoreMessages(cores as unknown[]);
          if (validated) tabCoreMessages.set(tabId, validated);
        }
      }
      return { meta: result.meta, tabMessages, tabCoreMessages };
    } catch {
      return this.loadSession(id);
    }
  }

  loadSessionMessages(
    id: string,
  ): { messages: ChatMessage[]; coreMessages: import("ai").ModelMessage[] } | null {
    const data = this.loadSession(id);
    if (!data) return null;
    const firstTab = data.meta.tabs[0];
    if (!firstTab) return null;
    const msgs = data.tabMessages.get(firstTab.id) ?? [];
    const savedCore = data.tabCoreMessages?.get(firstTab.id);
    return { messages: msgs, coreMessages: savedCore ?? rebuildCoreMessages(msgs) };
  }

  findByPrefix(prefix: string): string | null {
    if (!existsSync(this.dir)) return null;
    const normalizedPrefix = prefix.toLowerCase();

    const entries = readdirSync(this.dir);
    for (const entry of entries) {
      if (entry.toLowerCase().startsWith(normalizedPrefix)) {
        const metaPath = join(this.dir, entry, "meta.json");
        if (existsSync(metaPath)) return entry;
      }
    }
    return null;
  }

  listSessions(): SessionListEntry[] {
    if (!existsSync(this.dir)) return [];
    try {
      const entries = readdirSync(this.dir);
      const metas: SessionListEntry[] = [];

      for (const entry of entries) {
        try {
          const fullPath = join(this.dir, entry);
          const s = statSync(fullPath);
          if (!s.isDirectory()) continue;

          const metaPath = join(fullPath, "meta.json");
          if (!existsSync(metaPath)) continue;

          const raw = readFileSync(metaPath, "utf-8");
          const meta = JSON.parse(raw) as SessionMeta;
          const totalMessages = meta.tabs.reduce(
            (sum, t) => sum + (t.messageRange.endLine - t.messageRange.startLine),
            0,
          );
          metas.push({
            id: meta.id,
            title: meta.title,
            messageCount: totalMessages,
            startedAt: meta.startedAt,
            updatedAt: meta.updatedAt,
            sizeBytes: this.sessionDirSize(fullPath),
          });
        } catch {
          // Skip corrupted entries
        }
      }

      return metas.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  /** Async version — offloads FS scanning + JSON parsing to IO worker. */
  async listSessionsAsync(): Promise<SessionListEntry[]> {
    try {
      const io = getIOClient();
      return await io.listSessions(this.dir);
    } catch {
      return this.listSessions();
    }
  }

  /**
   * Synchronous save — used only for emergency crash-recovery writes
   * (signal handlers, uncaughtException). Never call from normal async paths.
   */
  saveSessionSync(
    meta: SessionMeta,
    tabMessages: Map<string, ChatMessage[]>,
    tabCoreMessages?: Map<string, import("ai").ModelMessage[]>,
  ): void {
    this.ensureDir();
    const sessionDir = join(this.dir, meta.id);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    }

    const allMessages: ChatMessage[] = [];
    const updatedTabs: TabMeta[] = [];

    for (const tab of meta.tabs) {
      const msgs = tabMessages.get(tab.id) ?? [];
      const startLine = allMessages.length;
      for (const msg of msgs) allMessages.push(msg);
      const endLine = allMessages.length;
      updatedTabs.push({ ...tab, messageRange: { startLine, endLine } });
    }

    const updatedMeta: SessionMeta = { ...meta, tabs: updatedTabs };
    const metaPath = join(sessionDir, "meta.json");
    const jsonlPath = join(sessionDir, "messages.jsonl");
    const lines = allMessages.map((m) => JSON.stringify(m)).join("\n");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const metaTmp = `${metaPath}.${suffix}.tmp`;
    const jsonlTmp = `${jsonlPath}.${suffix}.tmp`;

    writeFileSync(metaTmp, JSON.stringify(updatedMeta, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    writeFileSync(jsonlTmp, lines ? `${lines}\n` : "", { encoding: "utf-8", mode: 0o600 });
    safeRename(jsonlTmp, jsonlPath);
    safeRename(metaTmp, metaPath);

    if (tabCoreMessages) {
      const coreData: Record<string, import("ai").ModelMessage[]> = {};
      for (const [tabId, cores] of tabCoreMessages) {
        coreData[tabId] = cores;
      }
      const corePath = join(sessionDir, "core.json");
      const coreTmp = `${corePath}.${suffix}.tmp`;
      writeFileSync(coreTmp, JSON.stringify(coreData), { encoding: "utf-8", mode: 0o600 });
      safeRename(coreTmp, corePath);
    }
  }

  deleteSession(id: string): boolean {
    const dir = join(this.dir, id);
    if (!existsSync(dir)) return false;
    // Clean up checkpoint git tags before deleting session files (sync to complete before rmSync)
    try {
      const metaPath = join(dir, "meta.json");
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SessionMeta;
        for (const tab of meta.tabs) {
          if (tab.checkpointTags) {
            for (const ct of tab.checkpointTags) {
              spawnSync("git", ["tag", "-d", ct.gitTag], {
                windowsHide: true,
                cwd: this.cwd,
                timeout: 5_000,
                stdio: "ignore",
              });
            }
          }
        }
      }
    } catch {
      // Best-effort — don't block deletion if tag cleanup fails
    }
    rmSync(dir, { recursive: true });
    return true;
  }

  renameSession(id: string, newTitle: string): boolean {
    const metaPath = join(this.dir, id, "meta.json");
    if (!existsSync(metaPath)) return false;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SessionMeta;
      meta.title = newTitle;
      meta.customTitle = newTitle;
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tmp = `${metaPath}.${suffix}.tmp`;
      writeFileSync(tmp, JSON.stringify(meta, null, 2), { encoding: "utf-8", mode: 0o600 });
      safeRename(tmp, metaPath);
      return true;
    } catch {
      return false;
    }
  }

  clearAllSessions(): number {
    if (!existsSync(this.dir)) return 0;
    const entries = readdirSync(this.dir);
    let count = 0;
    for (const entry of entries) {
      try {
        const fullPath = join(this.dir, entry);
        rmSync(fullPath, { recursive: true });
        count++;
      } catch {
        // skip
      }
    }
    return count;
  }

  totalSizeBytes(): number {
    if (!existsSync(this.dir)) return 0;
    return this.listSessions().reduce((sum, s) => sum + s.sizeBytes, 0);
  }

  sessionCount(): number {
    if (!existsSync(this.dir)) return 0;
    try {
      return readdirSync(this.dir).filter((e) => {
        try {
          return statSync(join(this.dir, e)).isDirectory();
        } catch {
          return false;
        }
      }).length;
    } catch {
      return 0;
    }
  }

  static deriveTitle(messages: ChatMessage[]): string {
    const first = messages.find((m) => m.role === "user");
    if (!first) return "Empty session";
    const text = first.content.trim();
    if (text.length <= 60) return text;
    return `${text.slice(0, 57)}...`;
  }

  private saveChains: Map<string, Promise<void>> = new Map();

  /**
   * Persist a single tab's slice into the session dir, preserving every other
   * tab's existing on-disk content. Used by per-tab autosave so concurrent
   * tabs never overwrite each other's history with a stale snapshot.
   *
   * Reads existing meta.json + messages.jsonl + core.json, splices in the new
   * slice (or appends a new tab entry if missing), recomputes messageRange
   * offsets, atomically rewrites. Serialized per session id via saveChains.
   */
  async saveTab(
    sessionId: string,
    tabMeta: TabMeta,
    messages: ChatMessage[],
    coreMessages: import("ai").ModelMessage[] | undefined,
    fallback: {
      title: string;
      customTitle?: string | null;
      cwd: string;
      forgeMode: import("../../types/index.js").ForgeMode;
      activeTabId: string;
    },
  ): Promise<void> {
    const prev = this.saveChains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => this.doSaveTab(sessionId, tabMeta, messages, coreMessages, fallback));
    this.saveChains.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.saveChains.get(sessionId) === next) {
        this.saveChains.delete(sessionId);
      }
    }
  }

  private async doSaveTab(
    sessionId: string,
    tabMeta: TabMeta,
    messages: ChatMessage[],
    coreMessages: import("ai").ModelMessage[] | undefined,
    fallback: {
      title: string;
      customTitle?: string | null;
      cwd: string;
      forgeMode: import("../../types/index.js").ForgeMode;
      activeTabId: string;
    },
  ): Promise<void> {
    this.ensureDir();
    const sessionDir = join(this.dir, sessionId);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    }

    const metaPath = join(sessionDir, "meta.json");
    const jsonlPath = join(sessionDir, "messages.jsonl");
    const corePath = join(sessionDir, "core.json");

    // ── Load existing state (if any) so we splice this tab into the rest ──
    let existingMeta: SessionMeta | null = null;
    if (existsSync(metaPath)) {
      try {
        existingMeta = JSON.parse(readFileSync(metaPath, "utf-8")) as SessionMeta;
      } catch {
        existingMeta = null;
      }
    }

    const existingAllMessages: ChatMessage[] = [];
    if (existsSync(jsonlPath)) {
      const content = readFileSync(jsonlPath, "utf-8").trim();
      if (content) {
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            existingAllMessages.push(JSON.parse(line) as ChatMessage);
          } catch {
            break;
          }
        }
      }
    }

    let existingCore: Record<string, import("ai").ModelMessage[]> = {};
    if (existsSync(corePath)) {
      try {
        existingCore = JSON.parse(readFileSync(corePath, "utf-8")) as Record<
          string,
          import("ai").ModelMessage[]
        >;
      } catch {
        existingCore = {};
      }
    }

    // ── Build tab list: keep existing tabs in order, update/insert this one ──
    const oldTabs = existingMeta?.tabs ?? [];
    const tabIdx = oldTabs.findIndex((t) => t.id === tabMeta.id);
    const updatedTabsRaw: TabMeta[] =
      tabIdx >= 0 ? oldTabs.map((t, i) => (i === tabIdx ? tabMeta : t)) : [...oldTabs, tabMeta];

    // ── Reassemble messages.jsonl by walking tabs in order ──
    // Each non-target tab keeps its existing slice (sliced from existingAllMessages
    // using its prior messageRange). Target tab uses the new messages.
    //
    // TRUNCATION GUARD: if `messages` is shorter than the target tab's prior
    // on-disk slice, prefer the on-disk version. A shorter incoming array is
    // almost always a stale closure (older snapshot races a newer save) —
    // accepting it would permanently drop user-visible history because the
    // next save reads the truncated jsonl back as authoritative. UI must be a
    // superset of what the model sees; we never shrink messages.jsonl unless
    // the caller went through an explicit clear flow.
    const allMessages: ChatMessage[] = [];
    const updatedTabs: TabMeta[] = updatedTabsRaw.map((t) => {
      let msgs: ChatMessage[];
      if (t.id === tabMeta.id) {
        if (tabIdx >= 0) {
          const prevRange = oldTabs[tabIdx]?.messageRange;
          const priorSlice = prevRange
            ? existingAllMessages.slice(prevRange.startLine, prevRange.endLine)
            : [];
          if (messages.length < priorSlice.length) {
            // Stale-closure save — keep durable on-disk history.
            msgs = priorSlice;
          } else {
            msgs = messages;
          }
        } else {
          msgs = messages;
        }
      } else {
        const prevRange = t.messageRange;
        msgs = existingAllMessages.slice(prevRange.startLine, prevRange.endLine);
      }
      const startLine = allMessages.length;
      for (const m of msgs) allMessages.push(m);
      const endLine = allMessages.length;
      return { ...t, messageRange: { startLine, endLine } };
    });

    // ── Merge core.json: replace target tab's slot, keep others ──
    const updatedCore: Record<string, import("ai").ModelMessage[]> = { ...existingCore };
    if (coreMessages) {
      updatedCore[tabMeta.id] = coreMessages;
    }
    // Drop entries for tabs no longer in the meta (e.g. closed tabs).
    for (const k of Object.keys(updatedCore)) {
      if (!updatedTabs.some((t) => t.id === k)) delete updatedCore[k];
    }

    const updatedMeta: SessionMeta = {
      id: sessionId,
      title: existingMeta?.title ?? fallback.title,
      ...(existingMeta?.customTitle || fallback.customTitle
        ? { customTitle: existingMeta?.customTitle ?? fallback.customTitle ?? undefined }
        : {}),
      cwd: existingMeta?.cwd ?? fallback.cwd,
      startedAt: existingMeta?.startedAt ?? allMessages[0]?.timestamp ?? Date.now(),
      updatedAt: Date.now(),
      activeTabId: fallback.activeTabId,
      forgeMode: fallback.forgeMode,
      tabs: updatedTabs,
    };

    const lines = allMessages.map((m) => JSON.stringify(m)).join("\n");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const metaTmp = `${metaPath}.${suffix}.tmp`;
    const jsonlTmp = `${jsonlPath}.${suffix}.tmp`;

    await writeFile(metaTmp, JSON.stringify(updatedMeta, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await writeFile(jsonlTmp, lines ? `${lines}\n` : "", { encoding: "utf-8", mode: 0o600 });
    await rename(jsonlTmp, jsonlPath);
    await rename(metaTmp, metaPath);

    if (Object.keys(updatedCore).length > 0) {
      const coreTmp = `${corePath}.${suffix}.tmp`;
      await writeFile(coreTmp, JSON.stringify(updatedCore), { encoding: "utf-8", mode: 0o600 });
      await rename(coreTmp, corePath);
    }
  }

  /**
   * Drop any tabs from the on-disk session whose ids are NOT in `keepIds`.
   * Used at exit/new-session to garbage-collect tabs the user has closed,
   * preventing the saved tab list from growing unbounded across restarts.
   * Best-effort: missing dir or parse errors are silent.
   */
  async pruneTabsNotIn(sessionId: string, keepIds: Set<string>): Promise<void> {
    const sessionDir = join(this.dir, sessionId);
    const metaPath = join(sessionDir, "meta.json");
    if (!existsSync(metaPath)) return;
    const prev = this.saveChains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        let meta: SessionMeta;
        try {
          meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SessionMeta;
        } catch {
          return;
        }
        const keptTabs = meta.tabs.filter((t) => keepIds.has(t.id));
        if (keptTabs.length === meta.tabs.length) return;
        const jsonlPath = join(sessionDir, "messages.jsonl");
        const allMessages: ChatMessage[] = [];
        if (existsSync(jsonlPath)) {
          const content = readFileSync(jsonlPath, "utf-8").trim();
          if (content) {
            for (const line of content.split("\n")) {
              if (!line.trim()) continue;
              try {
                allMessages.push(JSON.parse(line) as ChatMessage);
              } catch {
                break;
              }
            }
          }
        }
        const rebuiltAll: ChatMessage[] = [];
        const updatedTabs: TabMeta[] = keptTabs.map((t) => {
          const { startLine, endLine } = t.messageRange;
          const slice = allMessages.slice(startLine, endLine);
          const newStart = rebuiltAll.length;
          for (const m of slice) rebuiltAll.push(m);
          return { ...t, messageRange: { startLine: newStart, endLine: rebuiltAll.length } };
        });
        const updatedMeta: SessionMeta = { ...meta, tabs: updatedTabs, updatedAt: Date.now() };
        const corePath = join(sessionDir, "core.json");
        let updatedCore: Record<string, import("ai").ModelMessage[]> | null = null;
        if (existsSync(corePath)) {
          try {
            const coreData = JSON.parse(readFileSync(corePath, "utf-8")) as Record<
              string,
              import("ai").ModelMessage[]
            >;
            updatedCore = {};
            for (const id of keepIds) {
              if (coreData[id]) updatedCore[id] = coreData[id];
            }
          } catch {
            updatedCore = null;
          }
        }
        const lines = rebuiltAll.map((m) => JSON.stringify(m)).join("\n");
        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const metaTmp = `${metaPath}.${suffix}.tmp`;
        const jsonlTmp = `${jsonlPath}.${suffix}.tmp`;
        await writeFile(metaTmp, JSON.stringify(updatedMeta, null, 2), {
          encoding: "utf-8",
          mode: 0o600,
        });
        await writeFile(jsonlTmp, lines ? `${lines}\n` : "", {
          encoding: "utf-8",
          mode: 0o600,
        });
        await rename(jsonlTmp, jsonlPath);
        await rename(metaTmp, metaPath);
        if (updatedCore) {
          const coreTmp = `${corePath}.${suffix}.tmp`;
          await writeFile(coreTmp, JSON.stringify(updatedCore), {
            encoding: "utf-8",
            mode: 0o600,
          });
          await rename(coreTmp, corePath);
        }
      });
    this.saveChains.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.saveChains.get(sessionId) === next) {
        this.saveChains.delete(sessionId);
      }
    }
  }
}
