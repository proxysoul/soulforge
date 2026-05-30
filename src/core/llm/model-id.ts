/**
 * Worker-safe leaf module for model-ID utilities.
 *
 * Imported by code that runs inside worker threads (io.worker.ts via
 * compaction/convo-text.ts). MUST stay dependency-free — no zustand stores,
 * no provider registry, no UI imports. Adding deps here re-poisons the
 * worker bundle with the entire TUI tree (see scripts/build.ts canary).
 *
 * Re-exported from provider-options.ts for backwards compatibility.
 */

/** Extract model ID string from a LanguageModel (object with .modelId) or pass-through strings. */
export function getModelId(model: unknown): string {
  if (typeof model === "string") return model;
  if (typeof model === "object" && model !== null && "modelId" in model) {
    return String((model as { modelId: unknown }).modelId);
  }
  return "";
}

export function extractBaseModel(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();
}

/** Parse opus major/minor version from a base model ID. Returns null if not an Opus model. */
export function parseOpusVersion(base: string): { major: number; minor: number } | null {
  // Match both hyphen (4-7) and dot (4.7) conventions.
  // Minor is 1-2 digits with negative lookahead to avoid matching date suffixes (e.g. opus-4-20250514).
  const m = base.match(/opus-(?:(\d+)[.-](\d{1,2})(?!\d)|(\d+))/);
  if (!m) return null;
  return { major: Number(m[1] ?? m[3]), minor: m[2] ? Number(m[2]) : 0 };
}

/** Opus 4.7+ rejects temperature/top_p/top_k — return false for those models. */
export function supportsTemperature(modelId: string): boolean {
  const base = extractBaseModel(modelId);
  if (!base.startsWith("claude")) return true;
  const v = parseOpusVersion(base);
  if (!v) return true;
  return v.major < 5 && (v.major < 4 || v.minor < 7);
}
/** Opus 4.7+ only supports adaptive thinking — rejects type:"enabled" with budget_tokens. */
export function isAdaptiveOnly(modelId: string): boolean {
  const base = extractBaseModel(modelId);
  const v = parseOpusVersion(base);
  if (!v) return false;
  return v.major >= 5 || (v.major === 4 && v.minor >= 7);
}
