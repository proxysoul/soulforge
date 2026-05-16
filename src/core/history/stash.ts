/**
 * Prompt stash — durable draft storage for the input box.
 *
 * The user stashes a half-written prompt (Ctrl+S) and pops it later. Drafts
 * survive session restart. Keyed by project so drafts don't bleed across
 * unrelated codebases.
 *
 * Backed by the existing `history.db` SQLite file — one file, one connection
 * per process, two tables. Schema is cheap (LIFO with project scoping).
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MAX_PER_PROJECT = 50;

export interface StashEntry {
  id: number;
  content: string;
  project: string | null;
  createdAt: string;
}

export class StashDB {
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
      CREATE TABLE IF NOT EXISTS stash (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        project TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_stash_project ON stash(project, created_at DESC);
    `);
  }

  /** Save a draft. Returns the row id. Trims oldest entries beyond MAX_PER_PROJECT. */
  push(content: string, project?: string): number {
    if (!content.trim()) return 0;
    const result = this.db
      .query("INSERT INTO stash (content, project) VALUES (?, ?)")
      .run(content, project ?? null);
    const id = Number(result.lastInsertRowid);
    this.trim(project ?? null);
    return id;
  }

  /** Pop the most recent entry. Returns null when empty. */
  pop(project?: string): StashEntry | null {
    const row = this.peekTop(project);
    if (!row) return null;
    this.db.query("DELETE FROM stash WHERE id = ?").run(row.id);
    return row;
  }

  /** Peek the most recent entry without removing it. */
  peekTop(project?: string): StashEntry | null {
    const where = project !== undefined ? "WHERE project = ?" : "";
    const sql = `SELECT id, content, project, created_at as createdAt
                 FROM stash ${where}
                 ORDER BY created_at DESC LIMIT 1`;
    const params = project !== undefined ? [project] : [];
    return (
      (this.db
        .query<
          { id: number; content: string; project: string | null; createdAt: string },
          (string | number)[]
        >(sql)
        .get(...params) as StashEntry | null) ?? null
    );
  }

  /** List drafts for the project (most recent first). */
  list(project?: string, limit = MAX_PER_PROJECT): StashEntry[] {
    const where = project !== undefined ? "WHERE project = ?" : "";
    const sql = `SELECT id, content, project, created_at as createdAt
                 FROM stash ${where}
                 ORDER BY created_at DESC LIMIT ?`;
    const params = project !== undefined ? [project, limit] : [limit];
    return this.db
      .query<
        { id: number; content: string; project: string | null; createdAt: string },
        (string | number)[]
      >(sql)
      .all(...params) as StashEntry[];
  }

  /** Remove a specific entry. */
  remove(id: number): void {
    this.db.query("DELETE FROM stash WHERE id = ?").run(id);
  }

  /** Drop all drafts for a project. */
  clear(project?: string): void {
    if (project === undefined) {
      this.db.run("DELETE FROM stash");
      return;
    }
    this.db.query("DELETE FROM stash WHERE project = ?").run(project);
  }

  private trim(project: string | null): void {
    this.db
      .query(
        `DELETE FROM stash
         WHERE id NOT IN (
           SELECT id FROM stash
           WHERE project IS ?
           ORDER BY created_at DESC LIMIT ?
         )
         AND project IS ?`,
      )
      .run(project, MAX_PER_PROJECT, project);
  }

  close(): void {
    this.db.close();
  }
}
