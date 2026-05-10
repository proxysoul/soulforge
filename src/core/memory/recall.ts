import type { MemoryDB } from "./db.js";
import { cosine, EMBED_MODEL, embed, memoryEmbedSource } from "./embedder.js";
import type { MemoryRecallResult, MemoryRecallSignals, MemoryRecord } from "./types.js";

export interface MemoryRecallOptions {
  query?: string;
  editedFiles?: string[];
  limit?: number;
  /** RRF score threshold; below this, results are filtered out. */
  threshold?: number;
  /** Estimated max characters of inject content (≈ chars/4 tokens). */
  maxChars?: number;
  /** Restrict scoring to a subset of configured scopes. Default: all configured. */
  readScope?: import("./types.js").MemoryScope | "both" | "all";
}

interface DbLike {
  searchUnicode: MemoryDB["searchUnicode"];
  searchTrigram: MemoryDB["searchTrigram"];
  searchTrigramWithBigram: MemoryDB["searchTrigramWithBigram"];
  findByFileIds: MemoryDB["findByFileIds"];
  findByPaths: MemoryDB["findByPaths"];
  topByUsage: MemoryDB["topByUsage"];
  readMany: MemoryDB["readMany"];
  fileIdsByMemoryIds?: MemoryDB["fileIdsByMemoryIds"];
  listEmbeddings?: MemoryDB["listEmbeddings"];
  getEmbedding?: MemoryDB["getEmbedding"];
}

interface ProviderEmbedderLike {
  readonly model: string;
  embed(text: string): Promise<Float32Array>;
}

export interface DbScopeAdapter {
  scope: import("./types.js").MemoryScope;
  db: DbLike;
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
  private readonly scopes: readonly DbScopeAdapter[];
  private providerEmbedder: ProviderEmbedderLike | null = null;

  constructor(
    db: DbLike | readonly DbScopeAdapter[],
    private readonly intel: IntelLike | null = null,
    opts: { defaultLimit?: number; defaultThreshold?: number; defaultMaxChars?: number } = {},
  ) {
    this.scopes = isAdapterArray(db) ? db : [{ scope: "project", db }];
    this.defaultLimit = opts.defaultLimit ?? DEFAULT_LIMIT;
    this.defaultThreshold = opts.defaultThreshold ?? DEFAULT_THRESHOLD;
    this.defaultMaxChars = opts.defaultMaxChars ?? DEFAULT_MAX_CHARS;
  }

  setProviderEmbedder(provider: ProviderEmbedderLike | null): void {
    this.providerEmbedder = provider;
  }

  async recall(opts: MemoryRecallOptions = {}): Promise<MemoryRecallResult[]> {
    const limit = opts.limit ?? this.defaultLimit;
    const threshold = opts.threshold ?? this.defaultThreshold;
    const maxChars = opts.maxChars ?? this.defaultMaxChars;

    const query = opts.query?.trim() ?? "";
    const editedFiles = opts.editedFiles ?? [];
    const filtered = filterScopes(this.scopes, opts.readScope);
    if (filtered.length === 0) return [];

    // Resolve the query → vector ONCE per call. Provider path is async +
    // shared across scopes. Hash-bag fallback is sync.
    const queryVec = await this.resolveQueryVector(query);

    const editedFileIds = await this.resolveEditedFileIds(editedFiles);

    const perScope = await Promise.all(
      filtered.map((s) => this.gatherScope(s, query, queryVec, editedFiles, editedFileIds)),
    );

    const blastCache = new Map<number, number>();
    const intel = this.intel;
    const blastFor = async (fileIds: number[]): Promise<number> => {
      if (!intel || fileIds.length === 0) return 0;
      const radii = await Promise.all(
        fileIds.map(async (fid) => {
          let radius = blastCache.get(fid);
          if (radius === undefined) {
            try {
              radius = await intel.getFileBlastRadiusById(fid);
            } catch {
              radius = 0;
            }
            blastCache.set(fid, radius);
          }
          return radius;
        }),
      );
      return radii.reduce((m, r) => (r > m ? r : m), 0);
    };

    const now = Date.now();
    const scored: MemoryRecallResult[] = [];

    for (const sc of perScope) {
      const scoredEntries = await Promise.all(
        sc.records.map(async (record) => {
          const fileIds = sc.fileIdsByMemory.get(record.id) ?? [];
          const radius = await blastFor(fileIds);
          const signals = computeSignals({
            record,
            now,
            unicodeRank: sc.unicodeRank.get(record.id) ?? null,
            trigramRank: sc.trigramRank.get(record.id) ?? null,
            fileAffinityHit: sc.fileAffinitySet.has(record.id),
            blastRadius: radius,
            semantic: sc.semanticScore.get(record.id) ?? null,
            semanticRank: sc.semanticRank.get(record.id) ?? null,
          });
          return {
            record,
            scope: sc.scope,
            score: combineScore(signals),
            normalized_score: 0,
            signals,
          } satisfies MemoryRecallResult;
        }),
      );
      scored.push(...scoredEntries);
    }

    scored.sort((a, b) => b.score - a.score);

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

  private async resolveQueryVector(
    query: string,
  ): Promise<{ vec: Float32Array; model: string } | null> {
    if (!query) return null;
    if (this.providerEmbedder) {
      try {
        const vec = await this.providerEmbedder.embed(query);
        return { vec, model: this.providerEmbedder.model };
      } catch {
        // fall through to hash-bag
      }
    }
    return { vec: embed(memoryEmbedSource(query, "", [])), model: EMBED_MODEL };
  }

  private async resolveEditedFileIds(editedFiles: string[]): Promise<number[]> {
    const intel = this.intel;
    if (editedFiles.length === 0 || !intel) return [];
    const lookups = await Promise.all(
      editedFiles.map((path) => intel.getFileIdByPath(path).catch(() => null)),
    );
    const ids: number[] = [];
    for (const id of lookups) {
      if (id !== null) ids.push(id);
    }
    return ids;
  }

  private async gatherScope(
    s: DbScopeAdapter,
    query: string,
    queryVec: { vec: Float32Array; model: string } | null,
    editedFiles: string[],
    editedFileIds: number[],
  ): Promise<{
    scope: import("./types.js").MemoryScope;
    records: MemoryRecord[];
    unicodeRank: Map<string, number>;
    trigramRank: Map<string, number>;
    fileAffinitySet: Set<string>;
    fileIdsByMemory: Map<string, number[]>;
    semanticScore: Map<string, number>;
    semanticRank: Map<string, number>;
  }> {
    const db = s.db;
    const unicodeHits = query ? db.searchUnicode(query, FTS_CANDIDATE_LIMIT) : [];
    let trigramHits = query ? db.searchTrigram(query, FTS_CANDIDATE_LIMIT) : [];
    if (query && unicodeHits.length === 0 && trigramHits.length === 0) {
      trigramHits = db.searchTrigramWithBigram(query, FTS_CANDIDATE_LIMIT);
    }

    const fileAffinityIds = collectFileAffinity(db, editedFiles, editedFileIds);

    const semanticHits = collectSemanticHits(db, queryVec);
    const semanticScore = new Map<string, number>();
    for (const h of semanticHits) semanticScore.set(h.id, h.weight);
    const semanticRank = rankMap(semanticHits.map((h) => h.id));

    const hasDirectionalSignal =
      unicodeHits.length > 0 ||
      trigramHits.length > 0 ||
      fileAffinityIds.length > 0 ||
      semanticHits.length > 0;
    const usageIds = hasDirectionalSignal ? [] : db.topByUsage(USAGE_CANDIDATE_LIMIT);

    const candidateIds = new Set<string>();
    for (const h of unicodeHits) candidateIds.add(h.id);
    for (const h of trigramHits) candidateIds.add(h.id);
    for (const id of fileAffinityIds) candidateIds.add(id);
    for (const h of semanticHits) candidateIds.add(h.id);
    for (const id of usageIds) candidateIds.add(id);

    if (candidateIds.size === 0) {
      return {
        scope: s.scope,
        records: [],
        unicodeRank: new Map(),
        trigramRank: new Map(),
        fileAffinitySet: new Set(),
        fileIdsByMemory: new Map(),
        semanticScore: new Map(),
        semanticRank: new Map(),
      };
    }

    const idList = [...candidateIds];
    const records = db.readMany(idList).filter((r) => !r.hidden);
    const fileIdsByMemory = db.fileIdsByMemoryIds
      ? db.fileIdsByMemoryIds(records.map((r) => r.id))
      : new Map<string, number[]>();

    return {
      scope: s.scope,
      records,
      unicodeRank: rankMap(unicodeHits.map((h) => h.id)),
      trigramRank: rankMap(trigramHits.map((h) => h.id)),
      fileAffinitySet: new Set(fileAffinityIds),
      fileIdsByMemory,
      semanticScore,
      semanticRank,
    };
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
  semantic: number | null;
  semanticRank: number | null;
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
    // Soft, bounded recency penalty. Older = less juice, but never negative
    // enough to flip a strong directional match. Half-life ≈ 14 days.
    recency: -0.05 * (1 - Math.exp(-ageDays / 14)),
    use_count: 0.05 * Math.log(input.record.use_count + 1),
    file_affinity: input.fileAffinityHit ? 1 : 0,
    blast_radius: 0.05 * Math.log(input.blastRadius + 1),
    pinned: input.record.pinned ? 0.1 : 0,
    semantic: input.semantic,
    semantic_rank: input.semanticRank,
  };
}

function combineScore(signals: MemoryRecallSignals): number {
  // RRF over directional signals (FTS hits + file affinity + semantic rank)
  // PLUS a magnitude term scaled to the embedder's actual paraphrase range.
  // Hashbag-v2 puts paraphrases at 0.3-0.9 and unrelated <0.15. Semantic
  // gets extra weight because FTS matches anything sharing a token (noisy)
  // while semantic ranks by meaning. Strong cosine matches dominate.
  let directional = 0;
  if (signals.fts_unicode !== null) directional += 1 / (RRF_K + signals.fts_unicode);
  if (signals.fts_trigram !== null) directional += 1 / (RRF_K + signals.fts_trigram);
  if (signals.file_affinity > 0) directional += 1 / (RRF_K + 1);
  if (signals.semantic_rank !== null) directional += 2 / (RRF_K + signals.semantic_rank);
  if (directional === 0) return 0;

  // Quadratic boost on cosine: weak matches contribute little, strong
  // matches dominate. 0.4² × 1.5 = 0.24; 0.7² × 1.5 = 0.74; 0.85² × 1.5 = 1.08.
  const sem = signals.semantic ?? 0;
  const semanticMagnitude = sem > 0 ? 1.5 * sem * sem + 0.1 * sem : 0;
  const bonus =
    signals.use_count + signals.recency + signals.blast_radius + signals.pinned + semanticMagnitude;
  return directional + bonus;
}
function isAdapterArray(v: DbLike | readonly DbScopeAdapter[]): v is readonly DbScopeAdapter[] {
  return Array.isArray(v);
}

function filterScopes(
  scopes: readonly DbScopeAdapter[],
  readScope: MemoryRecallOptions["readScope"],
): DbScopeAdapter[] {
  if (!readScope || readScope === "all" || readScope === "both") return [...scopes];
  return scopes.filter((s) => s.scope === readScope);
}

function collectFileAffinity(db: DbLike, editedFiles: string[], editedFileIds: number[]): string[] {
  if (editedFiles.length === 0 && editedFileIds.length === 0) return [];
  const byId =
    editedFileIds.length > 0 ? db.findByFileIds(editedFileIds, FILE_CANDIDATE_LIMIT) : [];
  const byPath = editedFiles.length > 0 ? db.findByPaths(editedFiles, FILE_CANDIDATE_LIMIT) : [];
  return Array.from(new Set([...byId, ...byPath]));
}
function collectSemanticHits(
  db: DbLike,
  queryVec: { vec: Float32Array; model: string } | null,
  limit = 20,
  threshold = 0.18,
): Array<{ id: string; weight: number }> {
  if (!queryVec || !db.listEmbeddings) return [];
  const all = db.listEmbeddings(queryVec.model);
  if (all.length === 0) return [];
  const scored: Array<{ id: string; weight: number }> = [];
  for (const e of all) {
    const w = cosine(queryVec.vec, e.vector);
    if (w >= threshold) scored.push({ id: e.id, weight: w });
  }
  scored.sort((a, b) => b.weight - a.weight);
  return scored.slice(0, limit);
}
