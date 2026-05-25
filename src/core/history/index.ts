/**
 * History subsystem — three SQLite-backed surfaces over one db file:
 *  - HistoryDB: prompt history (recent + FTS)
 *  - StashDB: durable drafts, per-project LIFO
 *  - FrecencyDB: freq × recency ranking for files/agents/commands/models
 *
 * Singletons are lazy + reused so the input box, autocomplete, and pickers
 * all share one connection per process.
 */

import { join } from "node:path";
import { configDir } from "../platform/index.js";
import { HistoryDB } from "./db.js";
import { FrecencyDB, type FrecencyKind, frecencyScore } from "./frecency.js";
import { StashDB } from "./stash.js";

// ── Draft restore bus ────────────────────────────────────────────────────
// Lets out-of-tree code (slash commands, hearth, plugins) push a draft into
// the focused InputBox without holding a ref to it.

export type DraftRestoreListener = (content: string) => void;
const _draftListeners = new Set<DraftRestoreListener>();

export function onDraftRestore(fn: DraftRestoreListener): () => void {
  _draftListeners.add(fn);
  return () => _draftListeners.delete(fn);
}

export function emitDraftRestore(content: string): void {
  for (const fn of _draftListeners) {
    try {
      fn(content);
    } catch {}
  }
}

export { HistoryDB } from "./db.js";
export { FrecencyDB, type FrecencyKind, type FrecencyRow, frecencyScore } from "./frecency.js";
export { StashDB, type StashEntry } from "./stash.js";

const DB_PATH = join(configDir(), "history.db");

let _history: HistoryDB | null = null;
let _stash: StashDB | null = null;
let _frecency: FrecencyDB | null = null;

export function getHistoryDB(): HistoryDB {
  if (!_history) _history = new HistoryDB(DB_PATH);
  return _history;
}

export function getStashDB(): StashDB {
  if (!_stash) _stash = new StashDB(DB_PATH);
  return _stash;
}

export function getFrecencyDB(): FrecencyDB {
  if (!_frecency) _frecency = new FrecencyDB(DB_PATH);
  return _frecency;
}

/** Rank a list of candidates by frecency score (highest first). Stable for ties. */
export function rankByFrecency<T extends { key: string }>(kind: FrecencyKind, items: T[]): T[] {
  if (items.length <= 1) return items;
  const db = getFrecencyDB();
  const lookup = db.byKeys(
    kind,
    items.map((i) => i.key),
  );
  const now = Date.now();
  return [...items].sort((a, b) => {
    const ra = lookup.get(a.key);
    const rb = lookup.get(b.key);
    const sa = ra ? frecencyScore(ra.frequency, ra.lastUsedAt, now) : 0;
    const sb = rb ? frecencyScore(rb.frequency, rb.lastUsedAt, now) : 0;
    return sb - sa;
  });
}

export function closeHistoryDBs(): void {
  try {
    _history?.close();
  } catch {}
  try {
    _stash?.close();
  } catch {}
  try {
    _frecency?.close();
  } catch {}
  _history = null;
  _stash = null;
  _frecency = null;
}
