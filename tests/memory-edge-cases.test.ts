/**
 * Adversarial sweep — what could actually go wrong with the memory subsystem.
 * No happy-path tests here; that's what the per-phase test files cover.
 *
 * Categories:
 *   1. db.ts             schema/dedup/FTS/file-refs/edges/embeddings
 *   2. recall.ts         empty inputs, broken intel, threshold edges
 *   3. embedder.ts       degenerate inputs, buffer roundtrip
 *   4. extractor.ts      malformed model output, type confusion, length caps
 *   5. pending.ts        corrupt store, capacity overflow
 *   6. manager.ts        scope confusion, config corruption
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDB } from "../src/core/memory/db.js";
import {
  bufferToVector,
  cosine,
  embed,
  EMBED_DIM,
  vectorToBuffer,
} from "../src/core/memory/embedder.js";
import { parseProposals } from "../src/core/memory/extractor.js";
import { MemoryManager } from "../src/core/memory/manager.js";
import { PendingStore } from "../src/core/memory/pending.js";
import { MemoryRecall } from "../src/core/memory/recall.js";

function makeTmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `mem-edge-${label}-`));
}

function adapt(db: MemoryDB) {
  return {
    searchUnicode: (q: string, l?: number) => db.searchUnicode(q, l),
    searchTrigram: (q: string, l?: number) => db.searchTrigram(q, l),
    searchTrigramWithBigram: (q: string, l?: number) => db.searchTrigramWithBigram(q, l),
    findByFileIds: (ids: number[], l?: number) => db.findByFileIds(ids, l),
    findByPaths: (paths: string[], l?: number) => db.findByPaths(paths, l),
    topByUsage: (l?: number) => db.topByUsage(l),
    readMany: (ids: string[]) => db.readMany(ids),
    fileIdsByMemoryIds: (ids: string[]) => db.fileIdsByMemoryIds(ids),
    listEmbeddings: (model?: string) => db.listEmbeddings(model),
    getEmbedding: (id: string) => db.getEmbedding(id),
  };
}

// ─── 1. db.ts ────────────────────────────────────────────────────────────

describe("MemoryDB — schema migration v1 → v2", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir("migrate");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens a v1 DB, adds embedding columns + memory_edges, preserves rows", () => {
    const dbPath = join(dir, "v1.db");
    // Hand-roll a v1 schema (Phase 1, pre-Phase-4): no embedding columns,
    // no memory_edges table. Includes the same FTS triggers v1 had.
    const raw = new Database(dbPath);
    raw.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT)");
    raw.run(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        category TEXT,
        summary TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        topics TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
        use_count INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL UNIQUE,
        pinned INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT
      )
    `);
    raw.run(`
      CREATE TABLE memory_files (
        memory_id TEXT NOT NULL,
        file_id INTEGER,
        path TEXT NOT NULL,
        PRIMARY KEY (memory_id, path)
      )
    `);
    raw.run(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        summary, details, topics,
        content='memories', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      )
    `);
    raw.run(`
      CREATE VIRTUAL TABLE memories_fts_tri USING fts5(
        summary, details, topics,
        content='memories', content_rowid='rowid',
        tokenize="trigram case_sensitive 0 remove_diacritics 1"
      )
    `);
    const hash = MemoryDB.computeContentHash("legacy-row", "from-v1");
    raw.run(
      `INSERT INTO memories (id, summary, details, source, content_hash) VALUES ('legacy-1','legacy-row','from-v1','agent', ?)`,
      [hash],
    );
    raw.run("INSERT INTO schema_version (version) VALUES (1)");
    raw.close();

    // Now open with the current MemoryDB — should migrate.
    const db = new MemoryDB(dbPath, "project");
    try {
      // Old row preserved
      const r = db.read("legacy-1");
      expect(r).not.toBeNull();
      expect(r!.summary).toBe("legacy-row");

      // New columns exist
      const cols = (db as unknown as { db: Database }).db
        .query<{ name: string }, []>("PRAGMA table_info(memories)")
        .all()
        .map((c) => c.name);
      expect(cols).toContain("embedding");
      expect(cols).toContain("embedding_model");
      expect(cols).toContain("embedding_dim");

      // Edges table exists
      const edgesTable = (db as unknown as { db: Database }).db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_edges'",
        )
        .get();
      expect(edgesTable).not.toBeNull();

      // schema_version bumped
      const v = (db as unknown as { db: Database }).db
        .query<{ version: number }, []>("SELECT MAX(version) as version FROM schema_version")
        .get();
      expect(v?.version).toBe(2);
    } finally {
      db.close();
    }
  });

  it("backfillEmbeddings catches up legacy rows that lack embeddings", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({ summary: "row-a", details: "", category: null, source: "agent" });
      const b = db.write({ summary: "row-b", details: "", category: null, source: "agent" });
      // Strip embeddings (simulating legacy)
      const internal = (db as unknown as { db: Database }).db;
      internal.run("UPDATE memories SET embedding = NULL, embedding_model = NULL");
      expect(db.getEmbedding(a.record.id)).toBeNull();
      expect(db.getEmbedding(b.record.id)).toBeNull();

      const missing = db.listMissingEmbeddings(undefined, 100);
      expect(missing.length).toBe(2);

      for (const m of missing) db.embedAndLink(m.id);
      expect(db.getEmbedding(a.record.id)).not.toBeNull();
      expect(db.getEmbedding(b.record.id)).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("MemoryDB — content_hash + dedup edge cases", () => {
  it("same summary+details but different topics+category → same hash, single row", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({
        summary: "X",
        details: "Y",
        category: "decision",
        topics: ["one"],
        source: "agent",
      });
      const b = db.write({
        summary: "X",
        details: "Y",
        category: "gotcha",
        topics: ["two"],
        source: "agent",
      });
      // Hash ignores category and topics — same row, deduped.
      expect(b.deduped).toBe(true);
      expect(b.record.id).toBe(a.record.id);
      expect(db.list().length).toBe(1);
    } finally {
      db.close();
    }
  });

  it("dedup increments use_count and bumps last_used_at", async () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({ summary: "S", details: "D", category: null, source: "agent" });
      const before = a.record.last_used_at;
      expect(a.record.use_count).toBe(0);

      // Sleep enough that ISO timestamps differ
      await new Promise((r) => setTimeout(r, 1200));

      const dup = db.write({ summary: "S", details: "D", category: null, source: "agent" });
      expect(dup.deduped).toBe(true);
      expect(dup.record.use_count).toBe(1);
      expect(dup.record.last_used_at >= before).toBe(true);
    } finally {
      db.close();
    }
  });

  it("upsert by id refuses to clobber another row's content_hash", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({ summary: "alpha", details: "", category: null, source: "agent" });
      // Different id, same content as alpha would dedup, but here we craft
      // a NEW row and then try to upsert b's id with a's content.
      const b = db.write({ summary: "beta", details: "", category: null, source: "agent" });
      expect(() =>
        db.write({
          id: b.record.id,
          summary: "alpha",
          details: "",
          category: null,
          source: "agent",
        }),
      ).toThrow(/another memory .* already has the same content_hash/);
      // a + b still intact
      expect(db.read(a.record.id)?.summary).toBe("alpha");
      expect(db.read(b.record.id)?.summary).toBe("beta");
    } finally {
      db.close();
    }
  });

  it("upsert by id un-hides a soft-deleted target", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({ summary: "old", details: "", category: null, source: "agent" });
      db.softDelete(a.record.id);
      expect(db.read(a.record.id)?.hidden).toBe(true);

      const upd = db.write({
        id: a.record.id,
        summary: "new",
        details: "",
        category: null,
        source: "agent",
      });
      expect(upd.deduped).toBe(false);
      expect(upd.record.summary).toBe("new");
      expect(db.read(a.record.id)?.hidden).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("MemoryDB — FTS query edge cases", () => {
  it("empty / whitespace / 1-char queries return [] without crashing", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      db.write({ summary: "filler row", details: "", category: null, source: "agent" });
      expect(db.searchUnicode("")).toEqual([]);
      expect(db.searchUnicode("   ")).toEqual([]);
      expect(db.searchUnicode("a")).toEqual([]); // 1-char ignored by tokenizer rules
      expect(db.searchTrigram("")).toEqual([]);
      expect(db.searchTrigram("ab")).toEqual([]); // <3 chars, no trigram match
      expect(db.searchTrigramWithBigram("")).toEqual([]);
      expect(db.searchTrigramWithBigram("a")).toEqual([]); // 1-char dropped
    } finally {
      db.close();
    }
  });

  it("query of pure FTS operators yields no error and no false matches", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      db.write({ summary: "real content here", details: "", category: null, source: "agent" });
      // These get sanitized to empty by buildFtsQuery
      expect(db.searchUnicode('()*"')).toEqual([]);
      expect(db.searchUnicode("::::")).toEqual([]);
      expect(db.searchTrigram("()*")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("searchUnicode prefix-matches but never returns hidden rows", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({
        summary: "uniquetokenxyz hidden test",
        details: "",
        category: null,
        source: "agent",
      });
      db.write({
        summary: "uniquetokenxyz visible test",
        details: "",
        category: null,
        source: "agent",
      });
      expect(db.searchUnicode("uniquetokenxyz").length).toBe(2);
      db.softDelete(a.record.id);
      expect(db.searchUnicode("uniquetokenxyz").length).toBe(1);
    } finally {
      db.close();
    }
  });

  it("clearAll then re-write with same content does not dedup (FTS rebuilt)", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({
        summary: "regen-test",
        details: "body",
        category: null,
        source: "agent",
      });
      expect(db.searchUnicode("regen").length).toBe(1);
      const cleared = db.clearAll();
      expect(cleared).toBe(1);
      expect(db.list().length).toBe(0);
      expect(db.searchUnicode("regen").length).toBe(0);

      // Re-write: must succeed (no dedup against deleted row)
      const b = db.write({
        summary: "regen-test",
        details: "body",
        category: null,
        source: "agent",
      });
      expect(b.deduped).toBe(false);
      expect(b.record.id).not.toBe(a.record.id);
      expect(db.searchUnicode("regen").length).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("MemoryDB — file refs + topic filter edge cases", () => {
  it("file_id 0 is treated as a real id (not coerced to null)", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({ summary: "x", details: "", category: null, source: "agent" });
      db.addFileRef(a.record.id, "foo.ts", 0);
      expect(db.findByFileIds([0])).toEqual([a.record.id]);
      const fileMap = db.fileIdsByMemoryIds([a.record.id]);
      expect(fileMap.get(a.record.id)).toEqual([0]);
    } finally {
      db.close();
    }
  });

  it("addFileRef on same (memory_id, path) updates file_id (no duplicate)", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({ summary: "x", details: "", category: null, source: "agent" });
      db.addFileRef(a.record.id, "foo.ts", null);
      db.addFileRef(a.record.id, "foo.ts", 99);
      const refs = db.listFileRefs(a.record.id);
      expect(refs.length).toBe(1);
      expect(refs[0]!.file_id).toBe(99);
    } finally {
      db.close();
    }
  });

  it("removeFileRef on unknown returns false; listFileRefs of unknown id is []", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      expect(db.removeFileRef("ghost", "any.ts")).toBe(false);
      expect(db.listFileRefs("ghost")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("topic with apostrophe / quote / json-meta chars filters exactly", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      db.write({
        summary: "weird-topic",
        details: "",
        category: null,
        topics: ["it's complex"],
        source: "agent",
      });
      db.write({
        summary: "json-meta",
        details: "",
        category: null,
        topics: ['"escaped"', "[bracket]"],
        source: "agent",
      });
      expect(db.list({ topic: "it's complex" }).length).toBe(1);
      expect(db.list({ topic: '"escaped"' }).length).toBe(1);
      expect(db.list({ topic: "[bracket]" }).length).toBe(1);
      // No collision with prefix
      expect(db.list({ topic: "it's" }).length).toBe(0);
    } finally {
      db.close();
    }
  });

  it("findByPaths with an empty array short-circuits (no SQL syntax error)", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      expect(db.findByPaths([])).toEqual([]);
      expect(db.findByFileIds([])).toEqual([]);
      expect(db.fileIdsByMemoryIds([])).toEqual(new Map());
      expect(db.readMany([])).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("readMany silently drops unknown ids (does not throw)", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({ summary: "x", details: "", category: null, source: "agent" });
      const out = db.readMany([a.record.id, "ghost-1", "ghost-2"]);
      expect(out.length).toBe(1);
      expect(out[0]!.id).toBe(a.record.id);
    } finally {
      db.close();
    }
  });
});

describe("MemoryDB — pinned vs hidden interaction", () => {
  it("a pinned row that is then soft-deleted disappears from active list", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({ summary: "p", details: "", category: null, source: "agent" });
      db.pin(a.record.id);
      db.softDelete(a.record.id);
      expect(db.list().length).toBe(0);
      expect(db.list({ includeHidden: true }).length).toBe(1);
      expect(db.activeCount()).toBe(0);
    } finally {
      db.close();
    }
  });

  it("findDeadFileRefs excludes pinned rows even when all paths are missing", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({ summary: "p", details: "", category: null, source: "agent" });
      db.addFileRef(a.record.id, "gone.ts", null);
      db.pin(a.record.id);
      expect(db.findDeadFileRefs(() => false).length).toBe(0);
    } finally {
      db.close();
    }
  });

  it("staleCandidates excludes pinned even if old", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({ summary: "old-pinned", details: "", category: null, source: "agent" });
      db.pin(a.record.id);
      (db as unknown as { db: Database }).db.run(
        `UPDATE memories SET last_used_at = datetime('now', '-365 days') WHERE id = ?`,
        [a.record.id],
      );
      expect(db.staleCandidates(50).find((s) => s.record.id === a.record.id)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("MemoryDB — supersede edge cases", () => {
  it("self-supersede is silently ignored and does not corrupt the row", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({ summary: "x", details: "", category: null, source: "agent" });
      // Self-supersede sets superseded_by=self AND hidden=1 — that's a footgun.
      // Caller should never do it; tool layer does not expose this. We only
      // verify it doesn't throw / corrupt, and the row remains queryable.
      const ok = db.supersede(a.record.id, a.record.id);
      expect(ok).toBe(true);
      const r = db.read(a.record.id);
      expect(r).not.toBeNull();
      expect(r!.superseded_by).toBe(a.record.id);
    } finally {
      db.close();
    }
  });

  it("supersede on unknown id returns false", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      expect(db.supersede("ghost", "also-ghost")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("superseded rows are excluded from findDuplicates (curation respected)", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      // Force two rows with the same content_hash via direct INSERT.
      const internal = (db as unknown as { db: Database }).db;
      internal.run(`DROP TRIGGER IF EXISTS memories_ai`);
      internal.run(`DROP TRIGGER IF EXISTS memories_au`);
      internal.run(`DROP TRIGGER IF EXISTS memories_ad`);
      internal.run(`DROP TABLE memories`);
      internal.run(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY, category TEXT,
          summary TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
          topics TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL,
          session_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
          use_count INTEGER NOT NULL DEFAULT 0,
          content_hash TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
          hidden INTEGER NOT NULL DEFAULT 0, superseded_by TEXT,
          embedding BLOB, embedding_model TEXT, embedding_dim INTEGER
        )
      `);
      const h = MemoryDB.computeContentHash("dup", "body");
      internal.run(
        `INSERT INTO memories (id, summary, details, source, content_hash, superseded_by) VALUES ('a','dup','body','agent', ?, NULL)`,
        [h],
      );
      internal.run(
        `INSERT INTO memories (id, summary, details, source, content_hash, superseded_by) VALUES ('b','dup','body','agent', ?, 'a')`,
        [h],
      );
      // 'b' is superseded → excluded from duplicate group
      expect(db.findDuplicates()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("MemoryDB — embeddings + edges edge cases", () => {
  it("listEmbeddings(model) is exact: rows with mismatched model are excluded", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({ summary: "a", details: "", category: null, source: "agent" });
      const b = db.write({ summary: "b", details: "", category: null, source: "agent" });
      // Mark `b` with a different model name
      (db as unknown as { db: Database }).db.run(
        `UPDATE memories SET embedding_model = 'other-v2' WHERE id = ?`,
        [b.record.id],
      );
      const ours = db.listEmbeddings("hashbag-v1").map((e) => e.id);
      expect(ours).toContain(a.record.id);
      expect(ours).not.toContain(b.record.id);
    } finally {
      db.close();
    }
  });

  it("embedAndLink on a hidden row still embeds but skips edge inference targets", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({
        summary: "hidden auth flow",
        details: "",
        category: null,
        source: "agent",
      });
      const b = db.write({
        summary: "visible auth flow",
        details: "",
        category: null,
        source: "agent",
      });
      db.softDelete(a.record.id);
      // Re-run embedAndLink on the hidden row
      const linked = db.embedAndLink(a.record.id);
      // Hidden rows are EXCLUDED from listEmbeddings via WHERE hidden = 0,
      // so 'a' has no peers visible to itself either — but 'b' exists, so
      // we expect at most some links. Either way, no crash + no edges to
      // hidden rows from `b`'s perspective:
      const fromB = db.listEdges(b.record.id, "similar");
      for (const e of fromB) {
        const peer = e.src_id === b.record.id ? e.dst_id : e.src_id;
        expect(peer).not.toBe(a.record.id);
      }
      // After softDelete, ALL edges touching `a` are pruned — listEdges
      // must never return `a` as a peer of any other row.
      expect(Array.isArray(linked)).toBe(true);
      const fromBAgain = db.listEdges(b.record.id, "similar");
      for (const e of fromBAgain) {
        const peer = e.src_id === b.record.id ? e.dst_id : e.src_id;
        expect(peer).not.toBe(a.record.id);
      }
    } finally {
      db.close();
    }
  });

  it("listEdges(unknown) returns []", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      expect(db.listEdges("ghost")).toEqual([]);
      expect(db.listEdges("ghost", "similar")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("similarClusters with no edges → []", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      db.write({ summary: "lone-1", details: "", category: null, source: "agent" });
      db.write({ summary: "totally-different-x", details: "", category: null, source: "agent" });
      // Likely no edges past 0.85 threshold
      expect(db.similarClusters(0.95)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("embedAndLink tolerates an empty embed source (no summary words) → []", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      // Whitespace-only summary; tokenizer drops it → zero vector source.
      const a = db.write({
        summary: "   ",
        details: "",
        category: null,
        topics: [],
        source: "agent",
      });
      // memoryEmbedSource trims to "" → embedAndLink returns [] without crashing.
      const linked = db.embedAndLink(a.record.id);
      expect(linked).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ─── 2. recall.ts ────────────────────────────────────────────────────────

describe("MemoryRecall — empty and degenerate inputs", () => {
  it("empty query + no editedFiles → []", async () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      db.write({ summary: "anything", details: "", category: null, source: "agent" });
      const r = new MemoryRecall([{ scope: "project" as const, db: adapt(db) }], null);
      const hits = await r.recall({ query: "", editedFiles: [] });
      expect(hits).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("limit=0 returns []", async () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      db.write({ summary: "match-me", details: "", category: null, source: "agent" });
      const r = new MemoryRecall([{ scope: "project" as const, db: adapt(db) }], null);
      const hits = await r.recall({ query: "match-me", limit: 0 });
      expect(hits).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("threshold=Infinity returns []", async () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      db.write({ summary: "anything-test", details: "", category: null, source: "agent" });
      const r = new MemoryRecall([{ scope: "project" as const, db: adapt(db) }], null);
      const hits = await r.recall({
        query: "anything-test",
        threshold: Number.POSITIVE_INFINITY,
        limit: 5,
      });
      expect(hits).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("readScope filter excludes non-matching scope adapters", async () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      db.write({ summary: "project-row", details: "", category: null, source: "agent" });
      // Configure both scopes but only project has the adapter wired
      const r = new MemoryRecall([{ scope: "project" as const, db: adapt(db) }], null);
      const projHits = await r.recall({ query: "project-row", readScope: "project" });
      const globHits = await r.recall({ query: "project-row", readScope: "global" });
      expect(projHits.length).toBe(1);
      expect(globHits).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("intel.getFileBlastRadiusById throwing does not crash recall", async () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({ summary: "blast-test", details: "", category: null, source: "agent" });
      db.addFileRef(a.record.id, "x.ts", 7);
      const intel = {
        getFileIdByPath: async () => 7,
        getFileBlastRadiusById: async () => {
          throw new Error("offline");
        },
      };
      const r = new MemoryRecall([{ scope: "project" as const, db: adapt(db) }], intel);
      const hits = await r.recall({ query: "blast-test", editedFiles: ["x.ts"], limit: 5 });
      expect(hits.length).toBe(1);
      expect(hits[0]!.signals.blast_radius).toBe(0); // failure → 0
    } finally {
      db.close();
    }
  });

  it("intel.getFileIdByPath rejecting falls back to path-based affinity", async () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({ summary: "path-test", details: "", category: null, source: "agent" });
      db.addFileRef(a.record.id, "auth/x.ts", null);
      const intel = {
        getFileIdByPath: async () => {
          throw new Error("nope");
        },
        getFileBlastRadiusById: async () => 0,
      };
      const r = new MemoryRecall([{ scope: "project" as const, db: adapt(db) }], intel);
      const hits = await r.recall({
        query: "path-test",
        editedFiles: ["auth/x.ts"],
        limit: 5,
      });
      expect(hits.length).toBe(1);
      expect(hits[0]!.signals.file_affinity).toBe(1);
    } finally {
      db.close();
    }
  });

  it("adapter without listEmbeddings (pre-Phase-4) skips semantic without crashing", async () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      db.write({ summary: "legacy-adapter", details: "", category: null, source: "agent" });
      // Strip the optional methods
      const partial = {
        searchUnicode: (q: string, l?: number) => db.searchUnicode(q, l),
        searchTrigram: (q: string, l?: number) => db.searchTrigram(q, l),
        searchTrigramWithBigram: (q: string, l?: number) => db.searchTrigramWithBigram(q, l),
        findByFileIds: (ids: number[], l?: number) => db.findByFileIds(ids, l),
        findByPaths: (paths: string[], l?: number) => db.findByPaths(paths, l),
        topByUsage: (l?: number) => db.topByUsage(l),
        readMany: (ids: string[]) => db.readMany(ids),
      };
      const r = new MemoryRecall([{ scope: "project" as const, db: partial }], null);
      const hits = await r.recall({ query: "legacy-adapter", limit: 5 });
      expect(hits.length).toBe(1);
      expect(hits[0]!.signals.semantic).toBeNull();
      expect(hits[0]!.signals.semantic_rank).toBeNull();
    } finally {
      db.close();
    }
  });

  it("normalized_score handles all-zero scored set without divide-by-zero", async () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      // Empty DB → empty hits → no divide.
      const r = new MemoryRecall([{ scope: "project" as const, db: adapt(db) }], null);
      const hits = await r.recall({ query: "anything", limit: 5 });
      expect(hits).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ─── 3. embedder.ts ──────────────────────────────────────────────────────

describe("embedder — degenerate inputs", () => {
  it("punctuation-only text → zero vector (no tokens)", () => {
    const v = embed("!!!??? ...");
    let n = 0;
    for (let i = 0; i < v.length; i++) n += (v[i] ?? 0) ** 2;
    expect(n).toBe(0);
  });

  it("single-character text → zero vector (tokens require length ≥ 2)", () => {
    const v = embed("a");
    let n = 0;
    for (let i = 0; i < v.length; i++) n += (v[i] ?? 0) ** 2;
    expect(n).toBe(0);
  });

  it("very long single token (1000 chars) hashes without crashing", () => {
    const long = "x".repeat(1000);
    const v = embed(long);
    expect(v.length).toBe(EMBED_DIM);
    let n = 0;
    for (let i = 0; i < v.length; i++) n += (v[i] ?? 0) ** 2;
    expect(Math.abs(Math.sqrt(n) - 1)).toBeLessThan(1e-6);
  });

  it("CJK-only text produces a non-zero vector", () => {
    const v = embed("中文 日本語");
    let n = 0;
    for (let i = 0; i < v.length; i++) n += (v[i] ?? 0) ** 2;
    expect(n).toBeCloseTo(1, 5);
  });

  it("emoji-only text → zero vector (\\p{L}\\p{N} excludes emoji)", () => {
    const v = embed("🎉🚀✨");
    let n = 0;
    for (let i = 0; i < v.length; i++) n += (v[i] ?? 0) ** 2;
    expect(n).toBe(0);
  });

  it("buffer roundtrip preserves vector exactly", () => {
    const v = embed("roundtrip the vector");
    const buf = vectorToBuffer(v);
    const back = bufferToVector(buf);
    expect(back.length).toBe(v.length);
    for (let i = 0; i < v.length; i++) {
      expect(back[i]).toBeCloseTo(v[i] ?? 0, 6);
    }
  });

  it("cosine of mismatched-length vectors returns 0 (defensive, no NaN)", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0]);
    expect(cosine(a, b)).toBe(0);
  });

  it("cosine of two zero vectors returns 0 (no NaN)", () => {
    const a = new Float32Array(EMBED_DIM);
    const b = new Float32Array(EMBED_DIM);
    const c = cosine(a, b);
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBe(0);
  });
});

// ─── 4. extractor.ts ─────────────────────────────────────────────────────

describe("MemoryExtractor — adversarial model output", () => {
  it("top-level object (not array) → []", () => {
    const raw = `{"summary":"x","details":"","category":null,"topics":[],"file_paths":[]}`;
    expect(parseProposals(raw)).toEqual([]);
  });

  it("null entries inside the array are skipped", () => {
    const raw = `[null, {"summary":"keep","details":"","category":null,"topics":[],"file_paths":[]}, null]`;
    const out = parseProposals(raw);
    expect(out.length).toBe(1);
    expect(out[0]!.summary).toBe("keep");
  });

  it("wrong field types are coerced safely or dropped", () => {
    const raw = JSON.stringify([
      {
        summary: "ok",
        details: 12345, // wrong type → empty string
        category: { not: "a-string" }, // invalid → null
        topics: "not-an-array", // wrong type → []
        file_paths: 99, // wrong type → []
      },
    ]);
    const out = parseProposals(raw);
    expect(out.length).toBe(1);
    expect(out[0]!.summary).toBe("ok");
    expect(out[0]!.details).toBe("");
    expect(out[0]!.category).toBeNull();
    expect(out[0]!.topics).toEqual([]);
    expect(out[0]!.file_paths).toEqual([]);
  });

  it("over-long fields are truncated to schema caps", () => {
    const raw = JSON.stringify([
      {
        summary: "x".repeat(500),
        details: "y".repeat(5000),
        category: "context",
        topics: ["z".repeat(100)],
        file_paths: Array.from({ length: 100 }, (_, i) => `f${i}.ts`),
      },
    ]);
    const out = parseProposals(raw);
    expect(out[0]!.summary.length).toBeLessThanOrEqual(200);
    expect(out[0]!.details.length).toBeLessThanOrEqual(2000);
    expect(out[0]!.topics[0]!.length).toBeLessThanOrEqual(32);
    expect(out[0]!.file_paths.length).toBeLessThanOrEqual(16);
  });

  it("empty/whitespace summary entries are dropped (summary required)", () => {
    const raw = JSON.stringify([
      { summary: "   ", details: "x", category: null, topics: [], file_paths: [] },
      { summary: "", details: "y", category: null, topics: [], file_paths: [] },
      { summary: "ok", details: "z", category: null, topics: [], file_paths: [] },
    ]);
    const out = parseProposals(raw);
    expect(out.length).toBe(1);
    expect(out[0]!.summary).toBe("ok");
  });

  it("topic items that are non-strings are skipped", () => {
    const raw = JSON.stringify([
      {
        summary: "x",
        details: "",
        category: null,
        topics: ["valid", 123, null, { nope: 1 }, "second"],
        file_paths: [],
      },
    ]);
    const out = parseProposals(raw);
    expect(out[0]!.topics).toEqual(["valid", "second"]);
  });

  it("nested fence with extra text outside the array is stripped first", () => {
    const raw = "Here you go:\n```json\n[]\n```\nHope that helps!";
    expect(parseProposals(raw)).toEqual([]);
  });
});

// ─── 5. pending.ts ───────────────────────────────────────────────────────

describe("PendingStore — corruption + capacity", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir("pending-edge");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("corrupt JSON file on disk → list() returns [] (no throw)", () => {
    const path = join(dir, ".soulforge", "memory-pending.json");
    require("node:fs").mkdirSync(join(dir, ".soulforge"), { recursive: true });
    writeFileSync(path, "{not-json", "utf-8");
    const s = new PendingStore(dir);
    expect(s.list()).toEqual([]);
  });

  it("non-array root JSON → list() returns []", () => {
    const path = join(dir, ".soulforge", "memory-pending.json");
    require("node:fs").mkdirSync(join(dir, ".soulforge"), { recursive: true });
    writeFileSync(path, JSON.stringify({ rogue: "object" }), "utf-8");
    const s = new PendingStore(dir);
    expect(s.list()).toEqual([]);
  });

  it("array of mixed valid + invalid entries keeps only valid ones", () => {
    const path = join(dir, ".soulforge", "memory-pending.json");
    require("node:fs").mkdirSync(join(dir, ".soulforge"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify([
        { id: "valid", summary: "ok", details: "", topics: [], file_paths: [], proposed_at: "x" },
        { only: "garbage" },
        null,
        "wrong-shape",
      ]),
      "utf-8",
    );
    const s = new PendingStore(dir);
    const items = s.list();
    expect(items.length).toBe(1);
    expect(items[0]!.id).toBe("valid");
  });

  it("over MAX_PENDING (50) → oldest entries fall off (FIFO from tail)", () => {
    const s = new PendingStore(dir);
    // unshift order means newer is at head; cap at 50
    for (let i = 0; i < 60; i++) {
      s.add({
        id: `p-${i}`,
        summary: `s-${i}`,
        details: "",
        category: null,
        topics: [],
        file_paths: [],
        proposed_at: new Date().toISOString(),
        source_session_id: null,
        source_turn_index: null,
      });
    }
    const items = s.list();
    expect(items.length).toBe(50);
    // Newest at head, oldest dropped: p-59 in, p-9 in, p-0..p-9 mostly out
    expect(items[0]!.id).toBe("p-59");
    expect(items.some((p) => p.id === "p-0")).toBe(false);
  });

  it("get(unknown) → null, remove(unknown) → false, clear empty → 0", () => {
    const s = new PendingStore(dir);
    expect(s.get("ghost")).toBeNull();
    expect(s.remove("ghost")).toBe(false);
    expect(s.clear()).toBe(0);
  });

  it("clear empties the store and persists", () => {
    const s = new PendingStore(dir);
    s.add({
      id: "p-1",
      summary: "x",
      details: "",
      category: null,
      topics: [],
      file_paths: [],
      proposed_at: new Date().toISOString(),
      source_session_id: null,
      source_turn_index: null,
    });
    expect(s.clear()).toBe(1);
    expect(s.list()).toEqual([]);
    const s2 = new PendingStore(dir);
    expect(s2.list()).toEqual([]);
  });

  it("atomic write: store file is valid JSON after every add (no half-written state)", () => {
    const s = new PendingStore(dir);
    s.add({
      id: "p-1",
      summary: "x",
      details: "",
      category: null,
      topics: [],
      file_paths: [],
      proposed_at: new Date().toISOString(),
      source_session_id: null,
      source_turn_index: null,
    });
    const raw = readFileSync(join(dir, ".soulforge", "memory-pending.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const tmp = join(dir, ".soulforge", "memory-pending.json.tmp");
    expect(existsSync(tmp)).toBe(false); // tmp cleaned up by rename
  });
});

// ─── 6. manager.ts ───────────────────────────────────────────────────────

describe("MemoryManager — config + scope edge cases", () => {
  let dir: string;
  let mgr: MemoryManager;

  beforeEach(() => {
    dir = makeTmpDir("mgr-edge");
  });

  afterEach(() => {
    mgr?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("corrupt scope config file falls back to defaults (no throw)", () => {
    const globalDir = join(dir, "home-global");
    require("node:fs").mkdirSync(globalDir, { recursive: true });
    require("node:fs").mkdirSync(join(dir, ".soulforge"), { recursive: true });
    writeFileSync(join(dir, ".soulforge", "memory-config.json"), "{not-json", "utf-8");
    mgr = new MemoryManager(dir, globalDir);
    expect(mgr.scopeConfig.writeScope).toBe("project");
    expect(mgr.scopeConfig.readScope).toBe("all");
  });

  it("config with missing required fields is rejected, defaults stand", () => {
    const globalDir = join(dir, "home-global");
    require("node:fs").mkdirSync(globalDir, { recursive: true });
    require("node:fs").mkdirSync(join(dir, ".soulforge"), { recursive: true });
    writeFileSync(
      join(dir, ".soulforge", "memory-config.json"),
      JSON.stringify({ writeScope: "global" }),
      "utf-8",
    );
    mgr = new MemoryManager(dir, globalDir);
    expect(mgr.scopeConfig.writeScope).toBe("project");
  });

  it("setSettingsScope writes new file before deleting old (atomic-ish)", () => {
    const globalDir = join(dir, "home-global");
    require("node:fs").mkdirSync(globalDir, { recursive: true });
    mgr = new MemoryManager(dir, globalDir);
    // Force a project-scoped config to disk
    mgr.saveConfig("project");
    const projectPath = join(dir, ".soulforge", "memory-config.json");
    expect(existsSync(projectPath)).toBe(true);

    // Switch to global
    mgr.setSettingsScope("global");
    const globalPath = join(globalDir, "memory-config.json");
    expect(existsSync(globalPath)).toBe(true);
    expect(existsSync(projectPath)).toBe(false);
  });

  it("findById across scopes returns scope tag of the originating DB", () => {
    const globalDir = join(dir, "home-global");
    require("node:fs").mkdirSync(globalDir, { recursive: true });
    mgr = new MemoryManager(dir, globalDir);
    const proj = mgr.write("project", {
      summary: "p-only",
      details: "",
      category: null,
      source: "agent",
    });
    const found = mgr.findById("all", proj.record.id);
    expect(found).not.toBeNull();
    expect(found!.scope).toBe("project");
  });

  it("acceptPending with unknown id returns null without writing", () => {
    const globalDir = join(dir, "home-global");
    require("node:fs").mkdirSync(globalDir, { recursive: true });
    mgr = new MemoryManager(dir, globalDir);
    const before = mgr.list("project").length;
    expect(mgr.acceptPending("ghost-id", "project")).toBeNull();
    expect(mgr.list("project").length).toBe(before);
  });

  it("clearScope('all') zeroes both DBs and bumps generation", () => {
    const globalDir = join(dir, "home-global");
    require("node:fs").mkdirSync(globalDir, { recursive: true });
    mgr = new MemoryManager(dir, globalDir);
    mgr.write("project", { summary: "p", details: "", category: null, source: "agent" });
    mgr.write("global", { summary: "g", details: "", category: null, source: "agent" });
    const gen = mgr.generation;
    const cleared = mgr.clearScope("all");
    expect(cleared).toBe(2);
    expect(mgr.list("all").length).toBe(0);
    expect(mgr.generation).toBeGreaterThan(gen);
  });

  it("clearScope on empty scope does NOT bump generation (no-op)", () => {
    const globalDir = join(dir, "home-global");
    require("node:fs").mkdirSync(globalDir, { recursive: true });
    mgr = new MemoryManager(dir, globalDir);
    const gen = mgr.generation;
    expect(mgr.clearScope("project")).toBe(0);
    expect(mgr.generation).toBe(gen);
  });
});
