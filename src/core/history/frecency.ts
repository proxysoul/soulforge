/**
 * Frecency scoring — frequency × recency.
 *
 * Surfaces recently-touched files/agents/commands first in autocomplete.
 * Standard formula: `score = freq × (1 / (1 + daysSinceLastUse))`. Linear
 * decay keeps yesterday's pick competitive with today's; week-old picks
 * fade fast.
 *
 * Persists in `history.db` alongside prompt history + stash. Keyed by
 * `(kind, key)` so files, agents, and commands share infra without
 * cross-contaminating.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MAX_ENTRIES = 1000;
const DAY_MS = 86_400_000;

export type FrecencyKind = "file" | "agent" | "command" | "model";

export interface FrecencyRow {
  kind: FrecencyKind;
  key: string;
  frequency: number;
  /** Unix ms. */
  lastUsedAt: number;
}

export class FrecencyDB {
  private db: Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.init();
  }

  private init(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS frecency (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        frequency INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL,
        PRIMARY KEY (kind, key)
      );
      CREATE INDEX IF NOT EXISTS idx_frecency_kind_last ON frecency(kind, last_used_at DESC);
    `);
  }

  /** Record a use. Increments frequency, bumps last_used_at to now. */
  bump(kind: FrecencyKind, key: string): void {
    if (!key) return;
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO frecency (kind, key, frequency, last_used_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(kind, key) DO UPDATE SET
           frequency = frequency + 1,
           last_used_at = excluded.last_used_at`,
      )
      .run(kind, key, now);
    this.trim(kind);
  }

  /** Read a single entry. Returns null when not seen yet. */
  get(kind: FrecencyKind, key: string): FrecencyRow | null {
    const row = this.db
      .query<
        { kind: string; key: string; frequency: number; last_used_at: number },
        [string, string]
      >(
        `SELECT kind, key, frequency, last_used_at
         FROM frecency WHERE kind = ? AND key = ?`,
      )
      .get(kind, key);
    if (!row) return null;
    return {
      kind: row.kind as FrecencyKind,
      key: row.key,
      frequency: row.frequency,
      lastUsedAt: row.last_used_at,
    };
  }

  /** Top N entries by frecency score, descending. */
  top(kind: FrecencyKind, limit = 20): FrecencyRow[] {
    const now = Date.now();
    const rows = this.db
      .query<
        { kind: string; key: string; frequency: number; last_used_at: number },
        [string, number]
      >(
        `SELECT kind, key, frequency, last_used_at
         FROM frecency WHERE kind = ?
         ORDER BY last_used_at DESC LIMIT ?`,
      )
      .all(kind, Math.max(limit * 4, 100));
    return rows
      .map((r) => ({
        kind: r.kind as FrecencyKind,
        key: r.key,
        frequency: r.frequency,
        lastUsedAt: r.last_used_at,
        score: frecencyScore(r.frequency, r.last_used_at, now),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ kind, key, frequency, lastUsedAt }) => ({
        kind: kind as FrecencyKind,
        key,
        frequency,
        lastUsedAt,
      }));
  }

  /** Bulk-fetch entries by key. Returns a Map so callers can score lookups O(1). */
  byKeys(kind: FrecencyKind, keys: readonly string[]): Map<string, FrecencyRow> {
    if (keys.length === 0) return new Map();
    const placeholders = keys.map(() => "?").join(",");
    const rows = this.db
      .query<
        { kind: string; key: string; frequency: number; last_used_at: number },
        (string | number)[]
      >(
        `SELECT kind, key, frequency, last_used_at
         FROM frecency WHERE kind = ? AND key IN (${placeholders})`,
      )
      .all(kind, ...keys);
    const out = new Map<string, FrecencyRow>();
    for (const r of rows) {
      out.set(r.key, {
        kind: r.kind as FrecencyKind,
        key: r.key,
        frequency: r.frequency,
        lastUsedAt: r.last_used_at,
      });
    }
    return out;
  }

  private trim(kind: FrecencyKind): void {
    this.db
      .query(
        `DELETE FROM frecency
         WHERE kind = ? AND key NOT IN (
           SELECT key FROM frecency WHERE kind = ?
           ORDER BY last_used_at DESC LIMIT ?
         )`,
      )
      .run(kind, kind, MAX_ENTRIES);
  }

  close(): void {
    this.db.close();
  }
}

/** Pure scoring fn — exported so callers can blend into custom rankings. */
export function frecencyScore(frequency: number, lastUsedAt: number, now = Date.now()): number {
  const daysSince = Math.max(0, (now - lastUsedAt) / DAY_MS);
  return frequency * (1 / (1 + daysSince));
}
