import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MemoryDB } from "../src/core/memory/db.js";
import { MemoryRecall } from "../src/core/memory/recall.js";

let db: MemoryDB;
let recall: MemoryRecall;

function makeRecall(intel?: {
  getFileIdByPath: (p: string) => Promise<number | null>;
  getFileBlastRadiusById: (id: number) => Promise<number>;
}) {
  return new MemoryRecall(
    {
      searchUnicode: (q, l) => db.searchUnicode(q, l),
      searchTrigram: (q, l) => db.searchTrigram(q, l),
      searchTrigramWithBigram: (q, l) => db.searchTrigramWithBigram(q, l),
      findByFileIds: (ids, l) => db.findByFileIds(ids, l),
      findByPaths: (paths, l) => db.findByPaths(paths, l),
      topByUsage: (l) => db.topByUsage(l),
      readMany: (ids) => db.readMany(ids),
    },
    intel ?? null,
  );
}

beforeEach(() => {
  db = new MemoryDB(":memory:", "project");
  recall = makeRecall();
});

afterEach(() => {
  db.close();
});

describe("MemoryRecall — bigram fallback", () => {
  it("matches 2-char Latin token via bigram pad when unicode/trigram miss", async () => {
    db.write({
      summary: "Use bun js runtime, not node",
      details: "We standardized on bun.",
      category: "decision",
      topics: ["bun", "js"],
      source: "agent",
    });

    const hits = await recall.recall({ query: "js", limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].record.summary).toContain("bun");
  });

  it("still matches >=3-char tokens through normal trigram path", async () => {
    db.write({
      summary: "Prefer SQLite for memory storage",
      details: "Phase 1 decision.",
      category: "decision",
      topics: ["sqlite"],
      source: "agent",
    });
    const hits = await recall.recall({ query: "sqlite", limit: 5 });
    expect(hits.length).toBe(1);
  });
});

describe("MemoryRecall — score normalisation", () => {
  it("normalized_score is in [0,1] with top result == 1", async () => {
    db.write({
      summary: "Auth uses JWT tokens",
      details: "Tokens rotate every 90 days.",
      category: "gotcha",
      topics: ["auth", "jwt"],
      source: "agent",
    });
    db.write({
      summary: "JWT secrets stored in env",
      details: "Never commit them.",
      category: "gotcha",
      topics: ["jwt"],
      source: "agent",
    });
    const hits = await recall.recall({ query: "JWT auth", limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].normalized_score).toBeCloseTo(1, 5);
    for (const h of hits) {
      expect(h.normalized_score).toBeGreaterThanOrEqual(0);
      expect(h.normalized_score).toBeLessThanOrEqual(1);
    }
  });
});

describe("MemoryRecall — threshold + ordering", () => {
  it("filters out results below threshold", async () => {
    db.write({
      summary: "Use bun runtime",
      details: "",
      category: "pref",
      topics: [],
      source: "agent",
    });
    const hitsLow = await recall.recall({ query: "bun", threshold: 0, limit: 5 });
    expect(hitsLow.length).toBe(1);
    const hitsHigh = await recall.recall({ query: "bun", threshold: 999, limit: 5 });
    expect(hitsHigh.length).toBe(0);
  });

  it("sorts by raw RRF score descending", async () => {
    for (let i = 0; i < 5; i++) {
      db.write({
        summary: `Bun decision ${String(i)}`,
        details: "",
        category: "decision",
        topics: ["bun"],
        source: "agent",
      });
    }
    const hits = await recall.recall({ query: "bun", limit: 5 });
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });
});

describe("MemoryRecall — file affinity + blast radius", () => {
  it("boosts memories tied to edited files", async () => {
    const tied = db.write({
      summary: "JWT rotation gotcha",
      details: "rotate every 90d",
      category: "gotcha",
      topics: [],
      source: "agent",
    });
    db.addFileRef(tied.record.id, "src/auth/jwt.ts", 42);

    db.write({
      summary: "JWT general note",
      details: "general",
      category: "context",
      topics: [],
      source: "agent",
    });

    const intel = {
      getFileIdByPath: async (p: string) => (p === "src/auth/jwt.ts" ? 42 : null),
      getFileBlastRadiusById: async () => 10,
    };
    recall = makeRecall(intel);

    const hits = await recall.recall({
      query: "JWT",
      editedFiles: ["src/auth/jwt.ts"],
      limit: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].record.id).toBe(tied.record.id);
    expect(hits[0].signals.file_affinity).toBe(1);
  });
});

describe("MemoryDB — dedup wakes hidden + topic merge", () => {
  it("dedup re-write un-hides a soft-deleted memory", () => {
    const first = db.write({
      summary: "S",
      details: "D",
      category: "pref",
      topics: ["a"],
      source: "agent",
    });
    db.softDelete(first.record.id);
    expect(db.read(first.record.id)?.hidden).toBe(true);

    const again = db.write({
      summary: "S",
      details: "D",
      category: "pref",
      topics: ["a"],
      source: "agent",
    });
    expect(again.deduped).toBe(true);
    expect(db.read(first.record.id)?.hidden).toBe(false);
  });

  it("merge_topics=true unions new topics into stored set on dedup", () => {
    const first = db.write({
      summary: "S",
      details: "D",
      category: "pref",
      topics: ["a", "b"],
      source: "agent",
    });
    const merged = db.write({
      summary: "S",
      details: "D",
      category: "pref",
      topics: ["b", "c"],
      source: "agent",
      mergeTopics: true,
    });
    expect(merged.deduped).toBe(true);
    expect(merged.topicDiff).toBe(true);
    const stored = db.read(first.record.id);
    expect(new Set(stored?.topics)).toEqual(new Set(["a", "b", "c"]));
  });

  it("merge_topics=false flags topic_diff but does not modify stored topics", () => {
    const first = db.write({
      summary: "S",
      details: "D",
      category: "pref",
      topics: ["a"],
      source: "agent",
    });
    const result = db.write({
      summary: "S",
      details: "D",
      category: "pref",
      topics: ["b"],
      source: "agent",
    });
    expect(result.topicDiff).toBe(true);
    expect(db.read(first.record.id)?.topics).toEqual(["a"]);
  });
});
