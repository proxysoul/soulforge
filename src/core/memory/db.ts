import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type {
  MemoryCategory,
  MemoryFileRef,
  MemoryIndex,
  MemoryRecord,
  MemoryScope,
  MemorySource,
} from "./types.js";

const SCHEMA_VERSION = 1;

interface RawMemoryRow {
  id: string;
  category: string | null;
  summary: string;
  details: string;
  topics: string;
  source: string;
  session_id: string | null;
  created_at: string;
  last_used_at: string;
  use_count: number;
  content_hash: string;
  pinned: number;
  hidden: number;
  superseded_by: string | null;
}

interface RawFileRefRow {
  memory_id: string;
  file_id: number | null;
  path: string;
}

export interface MemoryWriteInput {
  id?: string;
  category: MemoryCategory | null;
  summary: string;
  details: string;
  topics?: string[];
  source: MemorySource;
  session_id?: string | null;
  /** When dedup hits and incoming topics differ, union them into stored topics. */
  mergeTopics?: boolean;
}

export interface MemoryListOpts {
  category?: MemoryCategory | null;
  topic?: string;
  pinned?: boolean;
  includeHidden?: boolean;
  source?: MemorySource;
}

export interface FtsHit {
  id: string;
  rowid: number;
  bm25: number;
  rank: number;
}

export interface MemoryWriteResult {
  record: MemoryRecord;
  deduped: boolean;
  /** True when dedup hit and incoming topics differed from stored. */
  topicDiff?: boolean;
}

export class MemoryDB {
  private db: Database;
  readonly scope: MemoryScope;

  /**
   * Path to the rotated legacy DB after a fresh-start migration, if one
   * happened on this open. `null` otherwise. Surfaced so callers can show
   * a one-time "your old memories were saved at <path>" notice.
   */
  readonly legacyBackupPath: string | null;

  constructor(dbPath: string, scope: MemoryScope) {
    this.scope = scope;
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    this.legacyBackupPath = dbPath !== ":memory:" ? rotateLegacyDb(dbPath) : null;

    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA foreign_keys = ON");
    if (dbPath !== ":memory:") {
      try {
        this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {}
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          chmodSync(dbPath + suffix, 0o600);
        } catch {}
      }
    }
    this.init();
  }

  private init(): void {
    this.db.transaction(() => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      // Legacy schema rotation already happened on disk in rotateLegacyDb()
      // before the Database was opened — nothing more to do here.

      this.db.run(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          category TEXT CHECK(category IS NULL OR category IN ('pref','decision','gotcha','context')),
          summary TEXT NOT NULL,
          details TEXT NOT NULL DEFAULT '',
          topics TEXT NOT NULL DEFAULT '[]',
          source TEXT NOT NULL CHECK(source IN ('user','agent')),
          session_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
          use_count INTEGER NOT NULL DEFAULT 0,
          content_hash TEXT NOT NULL UNIQUE,
          pinned INTEGER NOT NULL DEFAULT 0,
          hidden INTEGER NOT NULL DEFAULT 0,
          superseded_by TEXT REFERENCES memories(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category) WHERE hidden=0;
        CREATE INDEX IF NOT EXISTS idx_memories_last_used ON memories(last_used_at) WHERE hidden=0;
        CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned) WHERE hidden=0;
        CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash);
      `);

      this.db.run(`
        CREATE TABLE IF NOT EXISTS memory_files (
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          file_id INTEGER,
          path TEXT NOT NULL,
          PRIMARY KEY (memory_id, path)
        );

        CREATE INDEX IF NOT EXISTS idx_memory_files_file ON memory_files(file_id) WHERE file_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_memory_files_path ON memory_files(path);
      `);

      const hasFts = this.db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'",
        )
        .get();

      if (!hasFts) {
        this.db.run(`
          CREATE VIRTUAL TABLE memories_fts USING fts5(
            summary, details, topics,
            content='memories', content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
          );

          CREATE VIRTUAL TABLE memories_fts_tri USING fts5(
            summary, details, topics,
            content='memories', content_rowid='rowid',
            tokenize="trigram case_sensitive 0 remove_diacritics 1"
          );

          CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
            INSERT INTO memories_fts(rowid, summary, details, topics)
            VALUES (new.rowid, new.summary, new.details, new.topics);
            INSERT INTO memories_fts_tri(rowid, summary, details, topics)
            VALUES (new.rowid, new.summary, new.details, new.topics);
          END;

          CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, summary, details, topics)
            VALUES ('delete', old.rowid, old.summary, old.details, old.topics);
            INSERT INTO memories_fts_tri(memories_fts_tri, rowid, summary, details, topics)
            VALUES ('delete', old.rowid, old.summary, old.details, old.topics);
          END;

          CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, summary, details, topics)
            VALUES ('delete', old.rowid, old.summary, old.details, old.topics);
            INSERT INTO memories_fts_tri(memories_fts_tri, rowid, summary, details, topics)
            VALUES ('delete', old.rowid, old.summary, old.details, old.topics);
            INSERT INTO memories_fts(rowid, summary, details, topics)
            VALUES (new.rowid, new.summary, new.details, new.topics);
            INSERT INTO memories_fts_tri(rowid, summary, details, topics)
            VALUES (new.rowid, new.summary, new.details, new.topics);
          END;
        `);
      }

      const versionRow = this.db
        .query<{ version: number }, []>("SELECT MAX(version) as version FROM schema_version")
        .get();
      const current = versionRow?.version ?? 0;
      if (current < SCHEMA_VERSION) {
        this.db
          .query("INSERT OR IGNORE INTO schema_version (version) VALUES (?)")
          .run(SCHEMA_VERSION);
      }
    })();
  }

  static computeContentHash(summary: string, details: string): string {
    const normalized = `${normalize(summary)}\n${normalize(details)}`;
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(normalized);
    return hasher.digest("hex");
  }

  write(input: MemoryWriteInput): MemoryWriteResult {
    const hash = MemoryDB.computeContentHash(input.summary, input.details);
    const existing = this.getByContentHash(hash);
    if (existing) {
      const now = new Date().toISOString();
      const incoming = input.topics ?? [];
      const stored = existing.topics;
      const incomingSet = new Set(incoming.map((t) => t.toLowerCase()));
      const storedSet = new Set(stored.map((t) => t.toLowerCase()));
      const topicDiff =
        incoming.length > 0 &&
        (incoming.length !== stored.length ||
          [...incomingSet].some((t) => !storedSet.has(t)) ||
          [...storedSet].some((t) => !incomingSet.has(t)));

      if (topicDiff && input.mergeTopics) {
        const merged: string[] = [...stored];
        const seen = new Set(storedSet);
        for (const t of incoming) {
          const key = t.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(t);
          }
        }
        this.db
          .query(
            "UPDATE memories SET use_count = use_count + 1, last_used_at = ?, hidden = 0, topics = ? WHERE id = ?",
          )
          .run(now, JSON.stringify(merged), existing.id);
      } else {
        this.db
          .query(
            "UPDATE memories SET use_count = use_count + 1, last_used_at = ?, hidden = 0 WHERE id = ?",
          )
          .run(now, existing.id);
      }
      const updated = this.read(existing.id);
      if (!updated) throw new Error(`Failed to read memory ${existing.id} after dedup update`);
      return { record: updated, deduped: true, topicDiff };
    }

    const id = input.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const topics = JSON.stringify(input.topics ?? []);

    const row = this.db
      .query<
        RawMemoryRow,
        [
          string,
          string | null,
          string,
          string,
          string,
          string,
          string | null,
          string,
          string,
          string,
        ]
      >(
        `INSERT INTO memories (id, category, summary, details, topics, source, session_id, created_at, last_used_at, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        id,
        input.category,
        input.summary,
        input.details,
        topics,
        input.source,
        input.session_id ?? null,
        now,
        now,
        hash,
      );

    if (!row) throw new Error(`Failed to write memory ${id}`);
    return { record: toRecord(row), deduped: false };
  }

  getByContentHash(hash: string): MemoryRecord | null {
    const row = this.db
      .query<RawMemoryRow, [string]>("SELECT * FROM memories WHERE content_hash = ?")
      .get(hash);
    return row ? toRecord(row) : null;
  }

  read(id: string): MemoryRecord | null {
    const row = this.db
      .query<RawMemoryRow, [string]>("SELECT * FROM memories WHERE id = ?")
      .get(id);
    return row ? toRecord(row) : null;
  }

  /**
   * Fetch many memories by id. Used by the recall pipeline to resolve
   * candidate ids → full records in one query.
   */
  readMany(ids: string[]): MemoryRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .query<RawMemoryRow, string[]>(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids);
    return rows.map(toRecord);
  }

  list(opts?: MemoryListOpts): MemoryRecord[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts?.category !== undefined) {
      if (opts.category === null) {
        conditions.push("category IS NULL");
      } else {
        conditions.push("category = ?");
        params.push(opts.category);
      }
    }
    if (opts?.topic) {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(memories.topics) WHERE json_each.value = ?)",
      );
      params.push(opts.topic);
    }
    if (opts?.pinned !== undefined) {
      conditions.push("pinned = ?");
      params.push(opts.pinned ? 1 : 0);
    }
    if (!opts?.includeHidden) {
      conditions.push("hidden = 0");
    }
    if (opts?.source) {
      conditions.push("source = ?");
      params.push(opts.source);
    }

    let sql = "SELECT * FROM memories";
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY pinned DESC, last_used_at DESC";

    const rows = this.db.query<RawMemoryRow, (string | number)[]>(sql).all(...params);
    return rows.map(toRecord);
  }

  /**
   * FTS5 unicode61 search. Word-aware, fast, good for Latin/Cyrillic/Greek.
   * Returns rowid + bm25 (smaller is better) + rank position (1-indexed).
   */
  searchUnicode(query: string, limit = 50): FtsHit[] {
    return this.runFts("memories_fts", query, limit);
  }

  /**
   * FTS5 trigram search. Script-agnostic — works for CJK, Arabic, anything.
   */
  searchTrigram(query: string, limit = 50): FtsHit[] {
    return this.runFts("memories_fts_tri", query, limit);
  }

  /**
   * Trigram search with a bigram-pad fallback for short Latin tokens.
   * `js`, `ai`, `tsx` are unindexable as trigrams; we expand each short
   * token to its overlapping bigrams padded to length 3 (`js` → `"js "`,
   * `" js"`) and OR them with the standard trigram query. Recall layer
   * uses this only when unicode61 misses, so cost stays bounded.
   */
  searchTrigramWithBigram(query: string, limit = 50): FtsHit[] {
    const expanded = buildTrigramOrBigramQuery(query);
    if (!expanded) return [];
    try {
      const rows = this.db
        .query<{ id: string; rowid: number; bm25: number }, [string, number]>(
          `SELECT m.id as id, m.rowid as rowid, bm25(memories_fts_tri) as bm25
           FROM memories_fts_tri f
           JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts_tri MATCH ? AND m.hidden = 0
           ORDER BY bm25
           LIMIT ?`,
        )
        .all(expanded, limit);
      return rows.map((r, idx) => ({ id: r.id, rowid: r.rowid, bm25: r.bm25, rank: idx + 1 }));
    } catch {
      return [];
    }
  }

  private runFts(
    table: "memories_fts" | "memories_fts_tri",
    query: string,
    limit: number,
  ): FtsHit[] {
    const ftsQuery =
      table === "memories_fts" ? buildFtsQuery(query, true) : buildTrigramQuery(query);
    if (!ftsQuery) return [];
    try {
      const rows = this.db
        .query<{ id: string; rowid: number; bm25: number }, [string, number]>(
          `SELECT m.id as id, m.rowid as rowid, bm25(${table}) as bm25
           FROM ${table} f
           JOIN memories m ON m.rowid = f.rowid
           WHERE ${table} MATCH ? AND m.hidden = 0
           ORDER BY bm25
           LIMIT ?`,
        )
        .all(ftsQuery, limit);
      return rows.map((r, idx) => ({ id: r.id, rowid: r.rowid, bm25: r.bm25, rank: idx + 1 }));
    } catch {
      return [];
    }
  }

  /**
   * Find memories whose linked file_ids intersect the given set.
   * Used by recall for file-affinity scoring on edited files.
   */
  findByFileIds(fileIds: number[], limit = 50): string[] {
    if (fileIds.length === 0) return [];
    const placeholders = fileIds.map(() => "?").join(",");
    const rows = this.db
      .query<{ id: string }, number[]>(
        `SELECT DISTINCT m.id
         FROM memories m
         JOIN memory_files mf ON mf.memory_id = m.id
         WHERE mf.file_id IN (${placeholders}) AND m.hidden = 0
         ORDER BY m.last_used_at DESC
         LIMIT ${limit}`,
      )
      .all(...fileIds);
    return rows.map((r) => r.id);
  }

  /**
   * Find memories whose linked paths intersect the given set.
   * Fallback when file_ids weren't resolved at write time (Soul Map cold).
   */
  findByPaths(paths: string[], limit = 50): string[] {
    if (paths.length === 0) return [];
    const placeholders = paths.map(() => "?").join(",");
    const rows = this.db
      .query<{ id: string }, string[]>(
        `SELECT DISTINCT m.id
         FROM memories m
         JOIN memory_files mf ON mf.memory_id = m.id
         WHERE mf.path IN (${placeholders}) AND m.hidden = 0
         ORDER BY m.last_used_at DESC
         LIMIT ${limit}`,
      )
      .all(...paths);
    return rows.map((r) => r.id);
  }

  /** Top-N by recency × use_count, used as a fallback candidate pool. */
  topByUsage(limit = 20): string[] {
    const rows = this.db
      .query<{ id: string }, [number]>(
        `SELECT id FROM memories
         WHERE hidden = 0
         ORDER BY pinned DESC, use_count DESC, last_used_at DESC
         LIMIT ?`,
      )
      .all(limit);
    return rows.map((r) => r.id);
  }

  softDelete(id: string): boolean {
    const result = this.db.query("UPDATE memories SET hidden = 1 WHERE id = ?").run(id);
    return result.changes > 0;
  }

  restore(id: string): boolean {
    const result = this.db.query("UPDATE memories SET hidden = 0 WHERE id = ?").run(id);
    return result.changes > 0;
  }

  pin(id: string): boolean {
    const result = this.db.query("UPDATE memories SET pinned = 1 WHERE id = ?").run(id);
    return result.changes > 0;
  }

  unpin(id: string): boolean {
    const result = this.db.query("UPDATE memories SET pinned = 0 WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /**
   * Mark `oldId` as superseded by `newId`. The old row is hidden from recall
   * but kept for audit; superseded_by points to the replacement.
   */
  supersede(oldId: string, newId: string): boolean {
    const tx = this.db.transaction(() => {
      const r = this.db
        .query("UPDATE memories SET superseded_by = ?, hidden = 1 WHERE id = ?")
        .run(newId, oldId);
      return r.changes > 0;
    });
    return tx();
  }

  recordRecall(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .query(
        `UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id IN (${placeholders})`,
      )
      .run(now, ...ids);
  }

  addFileRef(memoryId: string, path: string, fileId: number | null): void {
    this.db
      .query(
        `INSERT INTO memory_files (memory_id, file_id, path) VALUES (?, ?, ?)
         ON CONFLICT(memory_id, path) DO UPDATE SET file_id = excluded.file_id`,
      )
      .run(memoryId, fileId, path);
  }

  removeFileRef(memoryId: string, path: string): boolean {
    const result = this.db
      .query("DELETE FROM memory_files WHERE memory_id = ? AND path = ?")
      .run(memoryId, path);
    return result.changes > 0;
  }

  listFileRefs(memoryId: string): MemoryFileRef[] {
    const rows = this.db
      .query<RawFileRefRow, [string]>(
        "SELECT memory_id, file_id, path FROM memory_files WHERE memory_id = ?",
      )
      .all(memoryId);
    return rows.map((r) => ({ memory_id: r.memory_id, file_id: r.file_id, path: r.path }));
  }

  clearAll(): number {
    const tx = this.db.transaction(() => {
      const count =
        this.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM memories").get()?.c ?? 0;
      if (count > 0) {
        this.db.run("DELETE FROM memories");
        this.db.run("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
        this.db.run("INSERT INTO memories_fts_tri(memories_fts_tri) VALUES('rebuild')");
      }
      return count;
    });
    return tx();
  }

  clearByCategory(category: MemoryCategory): number {
    const tx = this.db.transaction(() => {
      const count =
        this.db
          .query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM memories WHERE category = ?")
          .get(category)?.c ?? 0;
      if (count > 0) {
        this.db.query("DELETE FROM memories WHERE category = ?").run(category);
      }
      return count;
    });
    return tx();
  }

  getIndex(): MemoryIndex {
    const total =
      this.db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM memories WHERE hidden = 0")
        .get()?.count ?? 0;

    const cats = this.db
      .query<{ category: string | null; count: number }, []>(
        "SELECT category, COUNT(*) as count FROM memories WHERE hidden = 0 GROUP BY category",
      )
      .all();

    const byCategory: Record<MemoryCategory, number> = {
      pref: 0,
      decision: 0,
      gotcha: 0,
      context: 0,
    };
    for (const c of cats) {
      if (c.category && c.category in byCategory) {
        byCategory[c.category as MemoryCategory] = c.count;
      }
    }

    const pinned =
      this.db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) as count FROM memories WHERE hidden = 0 AND pinned = 1",
        )
        .get()?.count ?? 0;

    return {
      scope: this.scope,
      total,
      byCategory,
      pinned,
    };
  }

  close(): void {
    this.db.close();
  }

  /**
   * Find duplicate-by-content pairs. content_hash already enforces uniqueness
   * at write time, so this is for repairing old data — but it also surfaces
   * near-duplicate (case/whitespace) collisions that escaped normalize().
   * Pinned and superseded rows are skipped — those are user/system-curated.
   */
  findDuplicates(): Array<{ kept: MemoryRecord; dupes: MemoryRecord[] }> {
    const rows = this.db
      .query<{ content_hash: string; ids: string }, []>(
        `SELECT content_hash, GROUP_CONCAT(id, '\u0001') as ids
         FROM memories
         WHERE hidden = 0 AND superseded_by IS NULL
         GROUP BY content_hash
         HAVING COUNT(*) > 1`,
      )
      .all();
    const out: Array<{ kept: MemoryRecord; dupes: MemoryRecord[] }> = [];
    for (const r of rows) {
      const ids = r.ids.split("\u0001");
      const records = this.readMany(ids).sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return Date.parse(b.last_used_at) - Date.parse(a.last_used_at);
      });
      const [kept, ...dupes] = records;
      if (kept && dupes.length > 0) out.push({ kept, dupes });
    }
    return out;
  }

  /**
   * Memories whose every linked file is missing on disk per the resolver.
   * Memories with no file refs are excluded (they aren't "broken" — they're
   * file-agnostic). Pinned rows are excluded from candidates.
   *
   * Resolver receives the stored path; returns true when the file exists.
   * Recall already grounds via Soul Map IDs, so dead refs only matter when
   * the path itself was deleted/moved without renaming Soul Map's row.
   */
  findDeadFileRefs(fileExists: (path: string) => boolean): Array<{
    record: MemoryRecord;
    deadPaths: string[];
  }> {
    const rows = this.db
      .query<{ id: string; paths: string }, []>(
        `SELECT m.id as id, GROUP_CONCAT(mf.path, '\u0001') as paths
         FROM memories m
         JOIN memory_files mf ON mf.memory_id = m.id
         WHERE m.hidden = 0 AND m.pinned = 0
         GROUP BY m.id`,
      )
      .all();
    const out: Array<{ record: MemoryRecord; deadPaths: string[] }> = [];
    for (const r of rows) {
      const paths = r.paths.split("\u0001");
      const dead = paths.filter((p) => !fileExists(p));
      if (dead.length === paths.length) {
        const record = this.read(r.id);
        if (record) out.push({ record, deadPaths: dead });
      }
    }
    return out;
  }

  staleCandidates(limit = 25): Array<{ record: MemoryRecord; ageDays: number }> {
    const rows = this.db
      .query<{ id: string; age_seconds: number }, [number]>(
        `SELECT id,
                (CAST(strftime('%s', 'now') AS INTEGER)
                 - CAST(strftime('%s', last_used_at) AS INTEGER)) as age_seconds
         FROM memories
         WHERE hidden = 0 AND pinned = 0
         ORDER BY age_seconds DESC, use_count ASC
         LIMIT ?`,
      )
      .all(limit);
    const out: Array<{ record: MemoryRecord; ageDays: number }> = [];
    for (const r of rows) {
      const record = this.read(r.id);
      if (record) out.push({ record, ageDays: Math.max(0, r.age_seconds / 86_400) });
    }
    return out;
  }

  /** Active (non-hidden) memory count. Used for cleanup-hint thresholding. */
  activeCount(): number {
    return (
      this.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM memories WHERE hidden = 0").get()
        ?.c ?? 0
    );
  }
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Build a safe FTS5 MATCH query for the unicode61 index.
 * Strips characters that would break the query, splits on whitespace,
 * quotes each token (escaping internal quotes) and optionally appends `*`
 * for prefix match. Joins with OR. Returns null when nothing usable remains.
 */
function buildFtsQuery(query: string, prefix: boolean): string | null {
  const tokens = query
    .replace(/["()*:]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => (prefix ? `"${t}"*` : `"${t}"`)).join(" OR ");
}

/**
 * Build a trigram MATCH query. Trigram FTS5 only matches tokens with ≥3
 * code points and rejects prefix `*` on shorter fragments. Strategy:
 *   - drop tokens shorter than 3 chars (they cannot match anything)
 *   - quote each remaining token verbatim (no `*` suffix)
 *   - join with OR
 * If a multi-word query yields no usable tokens, fall back to scanning the
 * whole input as one phrase so CJK queries like `中文` (2 chars) still match.
 */
function buildTrigramQuery(query: string): string | null {
  const cleaned = query.replace(/["()*:]/g, " ").trim();
  if (!cleaned) return null;

  const longTokens: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    if (codePointCount(raw) >= 3) longTokens.push(raw);
  }
  if (longTokens.length > 0) {
    return longTokens.map((t) => `"${t}"`).join(" OR ");
  }
  // Fallback: any token short enough that trigram can't index it on its own.
  // If the entire phrase has ≥3 code points, search for it as a phrase.
  if (codePointCount(cleaned) >= 3) return `"${cleaned}"`;
  return null;
}

/**
 * Trigram query with bigram-pad fallback for tokens of length 2.
 * Each 2-char token expands to two 3-char phrases padded with a leading or
 * trailing space so the trigram tokenizer indexes them as part of words at
 * boundaries (`js` → `" js"`, `"js "`). 1-char tokens are dropped — too
 * noisy. ≥3-char tokens are passed through verbatim.
 */
function buildTrigramOrBigramQuery(query: string): string | null {
  const cleaned = query.replace(/["()*:]/g, " ").trim();
  if (!cleaned) return null;

  const phrases: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    const len = codePointCount(raw);
    if (len >= 3) {
      phrases.push(`"${raw}"`);
    } else if (len === 2) {
      phrases.push(`" ${raw}"`, `"${raw} "`);
    }
  }
  if (phrases.length > 0) return phrases.join(" OR ");
  if (codePointCount(cleaned) >= 3) return `"${cleaned}"`;
  return null;
}

function codePointCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * If the file at `dbPath` is a legacy v0 memory DB (pre-Phase-1 schema with
 * `title`/`tags` columns), rename it aside as `<path>.legacy-<timestamp>` so
 * it's preserved for the user. Returns the backup path, or null when no
 * rotation happened. Side effects: file system only — does not touch any
 * Database connection (must be called before opening one).
 */
function rotateLegacyDb(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;

  let needsRotation = false;
  // Open read-only briefly to inspect the schema.
  let probe: Database | null = null;
  try {
    probe = new Database(dbPath, { readonly: true });
    const row = probe
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'",
      )
      .get();
    if (row && !row.sql.toLowerCase().includes("content_hash")) {
      needsRotation = true;
    }
  } catch {
    // Corrupt or unreadable — let the main open path surface the error.
    return null;
  } finally {
    probe?.close();
  }

  if (!needsRotation) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.legacy-${stamp}`;
  try {
    renameSync(dbPath, backup);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) {
        try {
          renameSync(dbPath + suffix, backup + suffix);
        } catch {}
      }
    }
    return backup;
  } catch {
    return null;
  }
}

function toRecord(row: RawMemoryRow): MemoryRecord {
  let topics: string[] = [];
  try {
    const parsed = JSON.parse(row.topics) as unknown;
    if (Array.isArray(parsed)) topics = parsed.filter((t): t is string => typeof t === "string");
  } catch {}
  return {
    id: row.id,
    category: (row.category as MemoryCategory | null) ?? null,
    summary: row.summary,
    details: row.details,
    topics,
    source: row.source as MemorySource,
    session_id: row.session_id,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    use_count: row.use_count,
    content_hash: row.content_hash,
    pinned: row.pinned === 1,
    hidden: row.hidden === 1,
    superseded_by: row.superseded_by,
  };
}
