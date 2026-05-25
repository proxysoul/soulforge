import { join } from "node:path";
import type { ModelMessage } from "ai";
import { useWorkerStore } from "../../stores/workers.js";
import type { ChatMessage } from "../../types/index.js";
import type { WorkingState } from "../compaction/types.js";
import { dataDir, isCompiledBinary } from "../platform/index.js";
import type { SessionListEntry } from "../sessions/manager.js";
import type { SessionMeta } from "../sessions/types.js";
import { WorkerClient } from "./rpc.js";

export interface FetchModelsWorkerResult {
  models: Array<{ id: string; name: string; contextWindow?: number }>;
  grouped?: {
    subProviders: Array<{ id: string; name: string }>;
    modelsByProvider: Record<string, Array<{ id: string; name: string; contextWindow?: number }>>;
  };
  error?: string;
}

const IS_COMPILED = isCompiledBinary(import.meta.url);
const IS_DIST =
  !IS_COMPILED && (import.meta.dir.includes("/dist") || import.meta.dir.includes("\\dist"));

interface CompressResult {
  text: string;
  original: string | null;
}

interface GitLogEntry {
  hash: string;
  subject: string;
  date: string;
}

interface LoadSessionResult {
  meta: SessionMeta;
  tabEntries: [string, ChatMessage[]][];
  coreEntries?: [string, unknown[]][];
}

export type ReadFileResult =
  | { ok: true; numbered: string; totalLines: number; truncated: boolean; start: number }
  | { error: "directory"; message: string }
  | { error: "binary"; ext: string; sizeStr: string }
  | { error: "too_large"; sizeStr: string }
  | { error: "not_found"; message: string };

let _instance: IOClient | null = null;

export function getIOClient(): IOClient {
  if (!_instance) _instance = new IOClient();
  return _instance;
}

export function disposeIOClient(): void {
  _instance?.dispose();
  _instance = null;
}

export class IOClient extends WorkerClient {
  constructor() {
    const workerPath = IS_COMPILED
      ? join(dataDir(), "workers", "io.worker.js")
      : IS_DIST
        ? join(import.meta.dir, "workers", "io.worker.js")
        : join(import.meta.dir, "io.worker.ts");
    super(workerPath, undefined, { smol: true });
    useWorkerStore.getState().markStarted("io");
    this.onStatusChange = (status) => {
      const store = useWorkerStore.getState();
      if (status === "crashed") store.setWorkerError("io", "IO worker crashed");
      else if (status === "restarting") {
        store.incrementRestarts("io");
        store.setWorkerStatus("io", "restarting");
      } else if (status === "starting") store.setWorkerStatus("io", "starting");
      else store.markStarted("io");
    };
    this.onRpcStart = () => {
      useWorkerStore.getState().updateRpcInFlight("io", 1);
    };
    this.onRpcEnd = (error) => {
      const store = useWorkerStore.getState();
      store.updateRpcInFlight("io", -1);
      store.incrementCalls("io");
      if (error) store.incrementErrors("io");
    };
  }

  // ── File Read (offloaded from main thread) ─────────────────────

  async readFileNumbered(
    filePath: string,
    startLine?: number | null,
    endLine?: number | null,
  ): Promise<ReadFileResult> {
    return this.call("readFileNumbered", filePath, startLine, endLine);
  }

  // ── Shell Compression ────────────────────────────────────────────

  async compressShellOutput(raw: string): Promise<string> {
    return this.call("compressShellOutput", raw);
  }

  async compressShellOutputFull(raw: string): Promise<CompressResult> {
    return this.call("compressShellOutputFull", raw);
  }

  // ── File Tree ────────────────────────────────────────────────────

  async walkDir(dir: string, prefix: string, depth: number): Promise<string[]> {
    return this.call("walkDir", dir, prefix, depth);
  }

  // ── Git Parsing ──────────────────────────────────────────────────

  async parseGitLogLine(line: string): Promise<GitLogEntry> {
    return this.call("parseGitLogLine", line);
  }

  async parseGitLogBatch(lines: string[]): Promise<GitLogEntry[]> {
    return this.call("parseGitLogBatch", lines);
  }

  // ── Compaction Serialization ─────────────────────────────────────

  async serializeWorkingState(state: Readonly<WorkingState>): Promise<string> {
    return this.call("serializeWorkingState", state);
  }

  async buildConvoText(messages: ModelMessage[], charBudget: number): Promise<string> {
    return this.call("buildConvoText", messages, charBudget);
  }

  // ── Session Persistence ──────────────────────────────────────────

  async saveSession(
    sessionDir: string,
    meta: SessionMeta,
    tabEntries: [string, ChatMessage[]][],
    coreEntries?: [string, import("ai").ModelMessage[]][],
  ): Promise<void> {
    return this.call("saveSession", sessionDir, meta, tabEntries, coreEntries ?? null);
  }

  async loadSession(sessionDir: string): Promise<LoadSessionResult | null> {
    return this.call("loadSession", sessionDir);
  }

  // ── Session Listing (offloaded from main thread) ─────────────────

  async listSessions(sessionsDir: string): Promise<SessionListEntry[]> {
    return this.call("listSessions", sessionsDir);
  }

  // ── Model Fetching (offloaded JSON parse + grouping) ─────────────

  async fetchModelsFromUrl(
    url: string,
    headers: Record<string, string>,
    providerId: string,
    grouped: boolean,
  ): Promise<FetchModelsWorkerResult> {
    return this.call("fetchModelsFromUrl", url, headers, providerId, grouped);
  }
}
