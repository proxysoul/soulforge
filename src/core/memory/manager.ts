import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  MemoryDB,
  type MemoryListOpts,
  type MemoryWriteInput,
  type MemoryWriteResult,
} from "./db.js";
import type { ProviderEmbedder } from "./embedder.js";
import { memoryEmbedSource as memoryEmbedSourceImport } from "./embedder.js";
import type {
  MemoryCategory,
  MemoryFileRef,
  MemoryRecord,
  MemoryScope,
  MemoryScopeConfig,
} from "./types.js";

export interface CleanupTracker {
  /** ISO timestamp of last successful cleanup pass, or null. */
  lastCleanupAt: string | null;
  /** Sessions started since last cleanup. Drives the hint threshold. */
  sessionsSinceCleanup: number;
}

type SettingsScope = "project" | "global";

const CONFIG_FILE = "memory-config.json";
const DEFAULT_CONFIG: MemoryScopeConfig = { writeScope: "project", readScope: "all" };

export type ScopedMemory = MemoryRecord & { scope: MemoryScope };

export class MemoryManager {
  private globalDb: MemoryDB;
  private projectDb: MemoryDB;
  private cwd: string;
  private _scopeConfig: MemoryScopeConfig = { ...DEFAULT_CONFIG };
  private _settingsScope: SettingsScope = "project";
  private _generation = 0;
  /**
   * In-memory mirror of the cleanup tracker persisted alongside the scope
   * config. `lastCleanupAt`: ISO timestamp; `sessionsSinceCleanup`: count of
   * fresh sessions since the user last ran /memory cleanup. Used by the hint
   * banner threshold (≥20 sessions, ≥30 memories, ≥10 stale candidates).
   */
  private _cleanup: CleanupTracker = { lastCleanupAt: null, sessionsSinceCleanup: 0 };

  get scopeConfig(): MemoryScopeConfig {
    return this._scopeConfig;
  }

  set scopeConfig(config: MemoryScopeConfig) {
    this._scopeConfig = config;
    this.saveConfig(this._settingsScope);
  }

  get settingsScope(): SettingsScope {
    return this._settingsScope;
  }

  get cleanupTracker(): Readonly<CleanupTracker> {
    return this._cleanup;
  }

  constructor(cwd: string, globalDir?: string) {
    this.cwd = cwd;
    this._globalDir = globalDir ?? join(homedir(), ".soulforge");

    const globalPath = join(this._globalDir, "memory.db");
    const projectPath = join(cwd, ".soulforge", "memory.db");

    this.globalDb = new MemoryDB(globalPath, "global");
    this.projectDb = new MemoryDB(projectPath, "project");

    this.loadConfig();
  }

  private configPath(scope: "project" | "global"): string {
    return scope === "global"
      ? join(this._globalDir, CONFIG_FILE)
      : join(this.cwd, ".soulforge", CONFIG_FILE);
  }

  private loadConfig(): void {
    for (const scope of ["project", "global"] as const) {
      const path = this.configPath(scope);
      if (!existsSync(path)) continue;
      try {
        const data = JSON.parse(readFileSync(path, "utf-8")) as MemoryScopeConfig & {
          cleanup?: CleanupTracker;
        };
        if (data.writeScope && data.readScope) {
          this._scopeConfig = { writeScope: data.writeScope, readScope: data.readScope };
          this._settingsScope = scope;
          if (data.cleanup) this._cleanup = data.cleanup;
          return;
        }
      } catch {}
    }
  }

  saveConfig(to: "project" | "global"): void {
    const path = this.configPath(to);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload = { ...this._scopeConfig, cleanup: this._cleanup };
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf-8");
    this._settingsScope = to;
  }

  deleteConfig(from: "project" | "global"): void {
    const path = this.configPath(from);
    if (existsSync(path)) rmSync(path);
    if (from === this._settingsScope) {
      this._settingsScope = "project";
    }
  }

  setSettingsScope(scope: SettingsScope): void {
    if (this._settingsScope === scope) {
      this.saveConfig(scope);
      return;
    }
    // Atomic: write the new file first, only then delete the old.
    // A crash mid-call leaves both files; loadConfig picks project first
    // (deterministic). Worst case: stale config in old slot, easy to clean.
    const previous = this._settingsScope;
    this.saveConfig(scope);
    this.deleteConfigOnly(previous);
  }

  private getDb(scope: MemoryScope): MemoryDB {
    return scope === "global" ? this.globalDb : this.projectDb;
  }

  getDbForScope(scope: MemoryScope): MemoryDB {
    return this.getDb(scope);
  }

  private getReadDbs(scope: MemoryScope | "both" | "all" | "none"): MemoryDB[] {
    if (scope === "none") return [];
    if (scope === "project") return [this.projectDb];
    if (scope === "global") return [this.globalDb];
    return [this.projectDb, this.globalDb];
  }

  get generation(): number {
    return this._generation;
  }

  write(scope: MemoryScope, input: MemoryWriteInput): MemoryWriteResult {
    const result = this.getDb(scope).write(input);
    this._generation++;
    // If a provider embedder is wired, re-embed the row asynchronously with
    // real vectors — fire-and-forget so callers don't pay the latency.
    // similar_hints from the sync hash-bag path stay (they're advisory).
    if (this._providerEmbedder && !result.deduped) {
      void this.getDb(scope)
        .embedAndLinkAsync(result.record.id, this._providerEmbedder)
        .catch(() => {
          // Already fell back to hash-bag inside embedAndLinkAsync.
        });
    }
    return result;
  }

  read(scope: MemoryScope, id: string): MemoryRecord | null {
    return this.getDb(scope).read(id);
  }

  /**
   * Locate a memory by id across read scopes — useful for tools that don't
   * know which DB the id lives in. Returns the first match.
   */
  findById(scope: MemoryScope | "both" | "all", id: string): ScopedMemory | null {
    for (const db of this.getReadDbs(scope)) {
      const r = db.read(id);
      if (r) return { ...r, scope: db.scope };
    }
    return null;
  }

  list(scope: MemoryScope | "both" | "all", opts?: MemoryListOpts): ScopedMemory[] {
    const results: ScopedMemory[] = [];
    for (const db of this.getReadDbs(scope)) {
      for (const m of db.list(opts)) {
        results.push({ ...m, scope: db.scope });
      }
    }
    return results;
  }

  listByScope(scope: MemoryScope, opts?: MemoryListOpts): ScopedMemory[] {
    const db = this.getDb(scope);
    return db.list(opts).map((m) => ({ ...m, scope }));
  }

  softDelete(scope: MemoryScope, id: string): boolean {
    const ok = this.getDb(scope).softDelete(id);
    if (ok) this._generation++;
    return ok;
  }

  restore(scope: MemoryScope, id: string): boolean {
    const ok = this.getDb(scope).restore(id);
    if (ok) this._generation++;
    return ok;
  }

  pin(scope: MemoryScope, id: string): boolean {
    const ok = this.getDb(scope).pin(id);
    if (ok) this._generation++;
    return ok;
  }

  unpin(scope: MemoryScope, id: string): boolean {
    const ok = this.getDb(scope).unpin(id);
    if (ok) this._generation++;
    return ok;
  }

  supersede(scope: MemoryScope, oldId: string, newId: string): boolean {
    const ok = this.getDb(scope).supersede(oldId, newId);
    if (ok) this._generation++;
    return ok;
  }

  recordRecall(scope: MemoryScope, ids: string[]): void {
    if (ids.length === 0) return;
    this.getDb(scope).recordRecall(ids);
  }

  recordRecallAcross(entries: Array<{ scope: MemoryScope; id: string }>): void {
    if (entries.length === 0) return;
    const byScope = new Map<MemoryScope, string[]>();
    for (const e of entries) {
      const arr = byScope.get(e.scope);
      if (arr) arr.push(e.id);
      else byScope.set(e.scope, [e.id]);
    }
    for (const [scope, ids] of byScope) this.getDb(scope).recordRecall(ids);
  }

  addFileRef(scope: MemoryScope, memoryId: string, path: string, fileId: number | null): void {
    this.getDb(scope).addFileRef(memoryId, path, fileId);
  }

  listFileRefs(scope: MemoryScope, memoryId: string): MemoryFileRef[] {
    return this.getDb(scope).listFileRefs(memoryId);
  }

  clearScope(scope: MemoryScope | "all"): number {
    let cleared = 0;
    const dbs = scope === "all" ? [this.projectDb, this.globalDb] : [this.getDb(scope)];
    for (const db of dbs) {
      cleared += db.clearAll();
    }
    if (cleared > 0) this._generation++;
    return cleared;
  }

  /**
   * Aggregated duplicate-content groups across the requested read scopes.
   * Each group: kept (most-recent/pinned) + dupes (soft-delete candidates).
   * Used by Quick cleanup mode.
   */
  findDuplicates(scope: MemoryScope | "both" | "all"): Array<{
    scope: MemoryScope;
    kept: MemoryRecord;
    dupes: MemoryRecord[];
  }> {
    const out: Array<{ scope: MemoryScope; kept: MemoryRecord; dupes: MemoryRecord[] }> = [];
    for (const db of this.getReadDbs(scope)) {
      for (const g of db.findDuplicates()) out.push({ scope: db.scope, ...g });
    }
    return out;
  }

  /**
   * Memories whose every linked file is missing on disk. Caller supplies the
   * existence resolver so the manager doesn't import fs directly (keeps it
   * mockable in tests).
   */
  findDeadFileRefs(
    scope: MemoryScope | "both" | "all",
    fileExists: (path: string) => boolean,
  ): Array<{ scope: MemoryScope; record: MemoryRecord; deadPaths: string[] }> {
    const out: Array<{ scope: MemoryScope; record: MemoryRecord; deadPaths: string[] }> = [];
    for (const db of this.getReadDbs(scope)) {
      for (const r of db.findDeadFileRefs(fileExists)) out.push({ scope: db.scope, ...r });
    }
    return out;
  }

  /** Bottom-N by decay (age × use_count⁻¹), pinned excluded. */
  staleCandidates(
    scope: MemoryScope | "both" | "all",
    limit = 25,
  ): Array<{ scope: MemoryScope; record: MemoryRecord; ageDays: number }> {
    const out: Array<{ scope: MemoryScope; record: MemoryRecord; ageDays: number }> = [];
    for (const db of this.getReadDbs(scope)) {
      for (const r of db.staleCandidates(limit)) out.push({ scope: db.scope, ...r });
    }
    out.sort((a, b) => b.ageDays - a.ageDays);
    return out.slice(0, limit);
  }

  /** Increment session counter — call once per fresh session start. */
  noteSessionStart(): void {
    this._cleanup = {
      ...this._cleanup,
      sessionsSinceCleanup: this._cleanup.sessionsSinceCleanup + 1,
    };
    this.saveConfig(this._settingsScope);
  }

  /** Reset cleanup tracker after a successful cleanup pass. */
  noteCleanupCompleted(): void {
    this._cleanup = { lastCleanupAt: new Date().toISOString(), sessionsSinceCleanup: 0 };
    this.saveConfig(this._settingsScope);
  }

  /**
   * Cleanup-hint criteria: ≥20 sessions since last cleanup AND ≥30 active
   * memories AND ≥10 stale candidates. Returns null when not warranted so
   * the UI can render nothing instead of empty state.
   */
  cleanupHint(): { sessions: number; total: number; stale: number } | null {
    const total = this.projectDb.activeCount() + this.globalDb.activeCount();
    if (total < 30) return null;
    if (this._cleanup.sessionsSinceCleanup < 20) return null;
    const stale = this.staleCandidates("all", 25).length;
    if (stale < 10) return null;
    return { sessions: this._cleanup.sessionsSinceCleanup, total, stale };
  }

  buildMemoryIndex(): string | null {
    const projectIdx = this.projectDb.getIndex();
    const globalIdx = this.globalDb.getIndex();
    if (projectIdx.total === 0 && globalIdx.total === 0) return null;

    const fmt = (label: string, idx: typeof projectIdx): string | null => {
      if (idx.total === 0) return null;
      const cats: string[] = [];
      for (const [k, v] of Object.entries(idx.byCategory) as [MemoryCategory, number][]) {
        if (v > 0) cats.push(`${k} ${String(v)}`);
      }
      const pinned = idx.pinned > 0 ? `, ${String(idx.pinned)} pinned` : "";
      const catStr = cats.length > 0 ? ` — ${cats.join(", ")}` : "";
      return `${label}: ${String(idx.total)}${catStr}${pinned}`;
    };

    const lines = [
      "Persistent memory active. Relevant entries surface automatically when you edit or mention related files. Use memory(action: search) for explicit lookup. Write only durable, non-code knowledge the user wants remembered.",
    ];
    const proj = fmt("project", projectIdx);
    const glob = fmt("global", globalIdx);
    if (proj) lines.push(proj);
    if (glob) lines.push(glob);
    const out = lines.join("\n");
    // Hard cap ~200 tokens (≈800 chars). Defensive: current shape always fits,
    // but a future schema growth shouldn't blow the prompt budget silently.
    return out.length > 800 ? `${out.slice(0, 797)}...` : out;
  }

  close(): void {
    this.globalDb.close();
    this.projectDb.close();
  }

  getLegacyBackupPaths(): { project: string | null; global: string | null } {
    return {
      project: this.projectDb.legacyBackupPath,
      global: this.globalDb.legacyBackupPath,
    };
  }

  private deleteConfigOnly(from: "project" | "global"): void {
    const path = this.configPath(from);
    if (existsSync(path)) {
      try {
        rmSync(path);
      } catch {}
    }
  }

  /**
   * Phase 4 Deep cleanup: cluster groups of similar memories across scopes.
   * Each group is a connected component in the similar-edge graph; members
   * may span scopes. UI uses this to surface merge/supersede candidates.
   */
  similarClusters(
    scope: MemoryScope | "both" | "all",
    minWeight = 0.7,
  ): Array<{ scope: MemoryScope; members: MemoryRecord[]; avgWeight: number }> {
    const out: Array<{ scope: MemoryScope; members: MemoryRecord[]; avgWeight: number }> = [];
    for (const db of this.getReadDbs(scope)) {
      for (const c of db.similarClusters(minWeight)) {
        const members: MemoryRecord[] = [];
        for (const id of c.memberIds) {
          const r = db.read(id);
          if (r && !r.hidden) members.push(r);
        }
        if (members.length >= 2) {
          out.push({ scope: db.scope, members, avgWeight: c.avgWeight });
        }
      }
    }
    out.sort((a, b) => b.avgWeight - a.avgWeight);
    return out;
  }

  /**
   * Backfill missing embeddings. When a provider embedder is set, uses
   * batched provider calls. Otherwise falls back to the synchronous hash-bag.
   * Both paths skip rows that already have an embedding tagged with the
   * active model — flip the model and they'll re-embed on next pass.
   */
  async backfillEmbeddings(
    scope: MemoryScope | "both" | "all" = "all",
    maxPerScope = 200,
  ): Promise<number> {
    let n = 0;
    const provider = this._providerEmbedder;
    for (const db of this.getReadDbs(scope)) {
      const missing = db.listMissingEmbeddings(provider?.model, maxPerScope);
      if (provider) {
        const sources = missing.map((m) => memoryEmbedSourceImport(m.summary, m.details, m.topics));
        try {
          const vecs = await provider.embedMany(sources);
          for (let i = 0; i < missing.length; i++) {
            const row = missing[i];
            const vec = vecs[i];
            if (!row || !vec) continue;
            db.setEmbedding(row.id, vec, provider.model);
            try {
              await db.embedAndLinkAsync(row.id, provider);
              n++;
            } catch {}
          }
        } catch {
          // Provider failed mid-batch — fall back to hash-bag for the rest.
          for (const m of missing) {
            try {
              db.embedAndLink(m.id);
              n++;
            } catch {}
          }
        }
      } else {
        for (const m of missing) {
          try {
            db.embedAndLink(m.id);
            n++;
          } catch {}
        }
      }
    }
    if (n > 0) this._generation++;
    return n;
  }

  private _globalDir: string;

  /**
   * Resolve an id (full or ≥4-char prefix) across the requested read scopes.
   * Returns the unique scoped record, null if no match, or {ambiguous} when
   * the prefix matches 2+ memories (across all scopes combined).
   */
  resolveId(
    scope: MemoryScope | "both" | "all",
    prefix: string,
  ): ScopedMemory | null | { ambiguous: Array<{ scope: MemoryScope; id: string }> } {
    if (!prefix) return null;
    const matches: Array<{ scope: MemoryScope; id: string }> = [];
    for (const db of this.getReadDbs(scope)) {
      const r = db.resolveId(prefix);
      if (typeof r === "string") {
        matches.push({ scope: db.scope, id: r });
      } else if (r && typeof r === "object" && "ambiguous" in r) {
        for (const id of r.ambiguous) matches.push({ scope: db.scope, id });
      }
    }
    if (matches.length === 0) return null;
    if (matches.length === 1) {
      const m = matches[0];
      if (!m) return null;
      return this.findById(m.scope, m.id);
    }
    return { ambiguous: matches };
  }

  private _providerEmbedder: ProviderEmbedder | null = null;

  /**
   * Wire a provider-backed embedder (Vercel AI SDK or compatible). When set,
   * writes use real embeddings; recall queries embed via the provider too.
   * Pass null to fall back to the deterministic hash-bag.
   */
  setProviderEmbedder(provider: ProviderEmbedder | null): void {
    this._providerEmbedder = provider;
  }

  getProviderEmbedder(): ProviderEmbedder | null {
    return this._providerEmbedder;
  }

  /**
   * Configure a provider-backed embedder by AI SDK model id (e.g.
   * "openai/text-embedding-3-small"). Pass null/empty to fall back to hashbag.
   * Backfills in the background — does not block. Idempotent: re-calling
   * with the same model id is a no-op.
   *
   * NEVER throws. All failures (missing API key, provider unavailable,
   * model not supported, network error) silently return null and the
   * embedder stays on hashbag-v2.
   */
  async configureEmbedder(modelId: string | null | undefined): Promise<ProviderEmbedder | null> {
    if (!modelId || typeof modelId !== "string" || modelId.trim().length === 0) {
      this._providerEmbedder = null;
      return null;
    }
    const target = modelId.trim();
    // Idempotent — avoid redundant backfills on tab churn / model re-select.
    if (this._providerEmbedder && this._providerEmbedder.model === target) {
      return this._providerEmbedder;
    }
    try {
      const { createAiSdkEmbedder } = await import("./embedder.js");
      const provider = await createAiSdkEmbedder(target);
      // Smoke-test the embedder before committing — catches missing API
      // keys, unsupported models, and provider-down conditions BEFORE we
      // start using it for recall queries.
      try {
        const probe = await provider.embed("ok");
        if (!probe || probe.length === 0) throw new Error("empty embedding");
      } catch (_err) {
        this._providerEmbedder = null;
        return null;
      }
      this._providerEmbedder = provider;
      // Kick off background backfill — fire-and-forget, never blocks.
      void this.backfillEmbeddings("all", 200).catch(() => {});
      return provider;
    } catch {
      this._providerEmbedder = null;
      return null;
    }
  }
}
