export type MemoryScope = "global" | "project";

/**
 * Memory scope configuration.
 * - writeScope: where new memories are saved. Default 'project' (safer than global).
 * - readScope:  which memories are visible to recall.
 */
export interface MemoryScopeConfig {
  writeScope: MemoryScope | "none";
  readScope: MemoryScope | "all" | "none";
}

export type MemoryCategory = "pref" | "decision" | "gotcha" | "context";

export const MEMORY_CATEGORIES: MemoryCategory[] = ["pref", "decision", "gotcha", "context"];

export type MemorySource = "user" | "agent";

export interface MemoryRecord {
  id: string;
  category: MemoryCategory | null;
  summary: string;
  details: string;
  topics: string[];
  source: MemorySource;
  session_id: string | null;
  created_at: string;
  last_used_at: string;
  use_count: number;
  content_hash: string;
  pinned: boolean;
  hidden: boolean;
  superseded_by: string | null;
}

export interface MemoryFileRef {
  memory_id: string;
  file_id: number | null;
  path: string;
}

export interface MemoryRecallSignals {
  fts_unicode: number | null;
  fts_trigram: number | null;
  recency: number;
  use_count: number;
  file_affinity: number;
  blast_radius: number;
  pinned: number;
}

export interface MemoryRecallResult {
  record: MemoryRecord;
  score: number;
  normalized_score: number;
  signals: MemoryRecallSignals;
}

export interface MemoryIndex {
  scope: MemoryScope;
  total: number;
  byCategory: Record<MemoryCategory, number>;
  pinned: number;
}
