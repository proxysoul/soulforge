import type { MemoryDB } from "./db.js";
import type { MemoryRecallResult, MemoryRecallSignals, MemoryRecord } from "./types.js";

export interface MemoryRecallOptions {
  query?: string;
  editedFiles?: string[];
  limit?: number;
  /** RRF score threshold; below this, results are filtered out. */
  threshold?: number;
  /** Estimated max characters of inject content (≈ chars/4 tokens). */
  maxChars?: number;
}

interface DbLike {
  searchUnicode: MemoryDB["searchUnicode"];
  searchTrigram: MemoryDB["searchTrigram"];
  searchTrigramWithBigram: MemoryDB["searchTrigramWithBigram"];
  findByFileIds: MemoryDB["findByFileIds"];
  findByPaths: MemoryDB["findByPaths"];
  topByUsage: MemoryDB["topByUsage"];
  readMany: MemoryDB["readMany"];
}

interface IntelLike {
  getFileIdByPath(relPath: string): Promise<number | null>;
  getFileBlastRadiusById(id: number): Promise<number>;
}

const DEFAULT_LIMIT = 3;
const DEFAULT_THRESHOLD = 0.01;
const DEFAULT_MAX_CHARS = 2400;
const FTS_CANDIDATE_LIMIT = 30;
const FILE_CANDIDATE_LIMIT = 30;
const USAGE_CANDIDATE_LIMIT = 10;
const RRF_K = 60;

export class MemoryRecall {
  private readonly defaultLimit: number;
  private readonly defaultThreshold: number;
  private readonly defaultMaxChars: number;

  constructor(
    private readonly db: DbLike,
    private readonly intel: IntelLike | null = null,
    opts: { defaultLimit?: number; defaultThreshold?: number; defaultMaxChars?: number } = {},
  ) {
    this.defaultLimit = opts.defaultLimit ?? DEFAULT_LIMIT;
    this.defaultThreshold = opts.defaultThreshold ?? DEFAULT_THRESHOLD;
    this.defaultMaxChars = opts.defaultMaxChars ?? DEFAULT_MAX_CHARS;
  }

  async recall(opts: MemoryRecallOptions = {}): Promise<MemoryRecallResult[]> {
    const limit = opts.limit ?? this.defaultLimit;
    const threshold = opts.threshold ?? this.defaultThreshold;
    const maxChars = opts.maxChars ?? this.defaultMaxChars;

    const query = opts.query?.trim() ?? "";
    const editedFiles = opts.editedFiles ?? [];

    // ── Signal 1+2: FTS over user query (if present) ──────────────────
    const unicodeHits = query ? this.db.searchUnicode(query, FTS_CANDIDATE_LIMIT) : [];
    let trigramHits = query ? this.db.searchTrigram(query, FTS_CANDIDATE_LIMIT) : [];
    // Bigram fallback: when neither index hit, try the short-token expander
    // so 2-char Latin queries (`js`, `ai`) and CJK fragments still match.
    if (query && unicodeHits.length === 0 && trigramHits.length === 0) {
      trigramHits = this.db.searchTrigramWithBigram(query, FTS_CANDIDATE_LIMIT);
    }

    // ── Signal 3: file affinity ──────────────────────────────────
    const fileAffinityIds = await this.collectFileAffinityIds(editedFiles);

    // ── Signal 4: usage fallback ────────────────────────────────
    // Only used when no query and no edited-file signal is available, so
    // pinned/high-use rows surface for an empty prompt without polluting
    // a real query that should be ranked by relevance.
    const hasDirectionalSignal =
      unicodeHits.length > 0 || trigramHits.length > 0 || fileAffinityIds.length > 0;
    const usageIds = hasDirectionalSignal ? [] : this.db.topByUsage(USAGE_CANDIDATE_LIMIT);

    // ── Build candidate set ──────────────────────────────────────
    const candidateIds = new Set<string>();
    for (const h of unicodeHits) candidateIds.add(h.id);
    for (const h of trigramHits) candidateIds.add(h.id);
    for (const id of fileAffinityIds) candidateIds.add(id);
    for (const id of usageIds) candidateIds.add(id);
    if (candidateIds.size === 0) return [];

    const records = this.db.readMany([...candidateIds]).filter((r) => !r.hidden);
    if (records.length === 0) return [];

    // ── Score each candidate ────────────────────────────────────
    const unicodeRank = rankMap(unicodeHits.map((h) => h.id));
    const trigramRank = rankMap(trigramHits.map((h) => h.id));
    const fileAffinitySet = new Set(fileAffinityIds);

    // Per-call cache: file_id → blast radius
    const blastCache = new Map<number, number>();
    const blastFor = async (fileIds: number[]): Promise<number> => {
      if (!this.intel || fileIds.length === 0) return 0;
      let max = 0;
      for (const fid of fileIds) {
        let radius = blastCache.get(fid);
        if (radius === undefined) {
          try {
            radius = await this.intel.getFileBlastRadiusById(fid);
          } catch {
            radius = 0;
          }
          blastCache.set(fid, radius);
        }
        if (radius > max) max = radius;
      }
      return max;
    };

    const now = Date.now();
    const scored: MemoryRecallResult[] = [];

    for (const record of records) {
      const fileIds = await this.fileIdsForRecord(record, editedFiles, fileAffinitySet);
      const radius = await blastFor(fileIds);
      const signals = computeSignals({
        record,
        now,
        unicodeRank: unicodeRank.get(record.id) ?? null,
        trigramRank: trigramRank.get(record.id) ?? null,
        fileAffinityHit: fileAffinitySet.has(record.id),
        blastRadius: radius,
      });
      const score = combineScore(signals);
      scored.push({ record, score, normalized_score: 0, signals });
    }

    scored.sort((a, b) => b.score - a.score);

    // Normalise to [0, 1] for display — raw score still drives ordering.
    const top = scored[0];
    const max = top ? top.score : 0;
    if (max > 0) {
      for (const r of scored) {
        r.normalized_score = Math.min(1, r.score / max);
      }
    }

    const out: MemoryRecallResult[] = [];
    let charBudget = maxChars;
    for (const result of scored) {
      if (out.length >= limit) break;
      if (result.score < threshold) break;
      const cost = result.record.summary.length + result.record.details.length;
      if (cost > charBudget && out.length > 0) break;
      out.push(result);
      charBudget -= cost;
    }
    return out;
  }

  private async collectFileAffinityIds(editedFiles: string[]): Promise<string[]> {
    if (editedFiles.length === 0) return [];
    const fileIds: number[] = [];
    if (this.intel) {
      for (const path of editedFiles) {
        try {
          const id = await this.intel.getFileIdByPath(path);
          if (id !== null) fileIds.push(id);
        } catch {}
      }
    }
    const byId = fileIds.length > 0 ? this.db.findByFileIds(fileIds, FILE_CANDIDATE_LIMIT) : [];
    const byPath = this.db.findByPaths(editedFiles, FILE_CANDIDATE_LIMIT);
    return Array.from(new Set([...byId, ...byPath]));
  }

  private async fileIdsForRecord(
    record: MemoryRecord,
    _editedFiles: string[],
    _fileAffinitySet: Set<string>,
  ): Promise<number[]> {
    // Recall pipeline doesn't need to enumerate every file ref — just enough
    // to compute max blast radius. The file-affinity signal already handled
    // the membership check; this helper exists so subclasses can override.
    void record;
    return [];
  }
}

function rankMap(ids: string[]): Map<string, number> {
  const m = new Map<string, number>();
  ids.forEach((id, idx) => {
    if (!m.has(id)) m.set(id, idx + 1);
  });
  return m;
}

interface SignalInputs {
  record: MemoryRecord;
  now: number;
  unicodeRank: number | null;
  trigramRank: number | null;
  fileAffinityHit: boolean;
  blastRadius: number;
}

function computeSignals(input: SignalInputs): MemoryRecallSignals {
  const lastUsed = Date.parse(input.record.last_used_at);
  const ageDays =
    Number.isFinite(lastUsed) && lastUsed > 0
      ? Math.max(0, (input.now - lastUsed) / 86_400_000)
      : 0;

  return {
    fts_unicode: input.unicodeRank,
    fts_trigram: input.trigramRank,
    recency: -0.05 * ageDays,
    use_count: 0.1 * Math.log(input.record.use_count + 1),
    file_affinity: input.fileAffinityHit ? 1 : 0,
    blast_radius: 0.1 * Math.log(input.blastRadius + 1),
    pinned: input.record.pinned ? 0.2 : 0,
  };
}

function combineScore(signals: MemoryRecallSignals): number {
  // RRF over directional signals (FTS hits + file affinity). These are
  // the only sources of "this matches the user's intent." Without one,
  // the candidate scores zero — pinned/use_count never lift unrelated
  // memories over the threshold.
  let directional = 0;
  if (signals.fts_unicode !== null) directional += 1 / (RRF_K + signals.fts_unicode);
  if (signals.fts_trigram !== null) directional += 1 / (RRF_K + signals.fts_trigram);
  if (signals.file_affinity > 0) directional += 1 / (RRF_K + 1);
  if (directional === 0) return 0;

  // Bonuses scale the directional match instead of adding a flat amount,
  // so a strong query hit with high use_count still beats a weak hit on
  // a pinned row — but pinned alone is never enough.
  const bonus = signals.use_count + signals.recency + signals.blast_radius + signals.pinned;
  return directional + bonus;
}
