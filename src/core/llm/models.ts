import { toErrorMessage } from "../../utils/errors.js";
// getProviderApiKey is used in other parts of the file or removed if unused
import { getIOClient } from "../workers/io-client.js";
import { inferModelGroup } from "./model-utils.js";
import { getAllProviders, getProvider, onProvidersChanged } from "./providers/index.js";
import { getPooledApiKey } from "./credential-pool.js";
import type { ProviderModelInfo } from "./providers/types.js";

// Re-export for backward compatibility
export type { ProviderModelInfo } from "./providers/types.js";

export interface FetchModelsResult {
  models: ProviderModelInfo[];
  error?: string;
}

export interface SubProvider {
  id: string;
  name: string;
}

export interface GroupedModelsResult {
  subProviders: SubProvider[];
  modelsByProvider: Record<string, ProviderModelInfo[]>;
  error?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  envVar: string;
  grouped?: boolean;
  badge?: string;
  noAuthLabel?: string;
  authErrorLabel?: string;
  fallbackModels?: ProviderModelInfo[];
}

function buildProviderConfigs(): ProviderConfig[] {
  return getAllProviders().map((p) => ({
    id: p.id,
    name: p.name,
    envVar: p.envVar,
    grouped: p.grouped,
    badge: p.badge,
    noAuthLabel: p.noAuthLabel,
    authErrorLabel: p.authErrorLabel,
    fallbackModels: p.fallbackModels,
  }));
}

export const PROVIDER_CONFIGS: ProviderConfig[] = buildProviderConfigs();

onProvidersChanged(() => {
  PROVIDER_CONFIGS.splice(0, PROVIDER_CONFIGS.length, ...buildProviderConfigs());
});

const DEFAULT_CONTEXT_TOKENS = 128_000;
const METADATA_FETCH_TIMEOUT = 5_000;

type ContextWindowSource = "api" | "openrouter" | "fallback";

interface ContextWindowResult {
  tokens: number;
  source: ContextWindowSource;
}

/**
 * Synchronous cache-only lookup — returns best-known value from populated caches.
 * Used internally and as fallback when async fetch times out.
 */
export function getModelContextInfoSync(modelId: string): ContextWindowResult {
  const slashIdx = modelId.indexOf("/");
  const providerId = slashIdx >= 0 ? modelId.slice(0, slashIdx) : "";
  const model = slashIdx >= 0 ? modelId.slice(slashIdx + 1) : modelId;

  // 0. Provider-specific overrides for known-incorrect upstream API values
  //    (e.g. OpenRouter lists GLM-5 as 80k, actual ~200k)
  const ownProvider = providerId ? getProvider(providerId) : null;
  if (ownProvider?.contextWindowOverrides) {
    for (const [pattern, tokens] of ownProvider.contextWindowOverrides) {
      if (model.includes(pattern)) return { tokens, source: "fallback" };
    }
  }

  // 1. Provider's own API data (most accurate)
  if (providerId && !ownProvider?.grouped) {
    const entry = modelCache.get(providerId);
    if (entry && Date.now() - entry.ts <= MODEL_CACHE_TTL) {
      const match = entry.models.find((m) => m.id === model);
      if (match?.contextWindow) return { tokens: match.contextWindow, source: "api" };
    }
  }
  if (providerId) {
    const grouped = getCachedGroupedModels(providerId);
    if (grouped) {
      for (const models of Object.values(grouped.modelsByProvider)) {
        const match = models.find((m) => m.id === model || modelId.endsWith(m.id));
        if (match?.contextWindow) return { tokens: match.contextWindow, source: "api" };
      }
    }
  }

  // 2. OpenRouter metadata (broad coverage, but sometimes inaccurate)
  const orMatch = findOpenRouterModel(model);
  if (orMatch?.context_length) return { tokens: orMatch.context_length, source: "openrouter" };

  // 3. Hardcoded fallback patterns — own provider only for grouped providers
  //    (e.g. Ollama's "qwen" pattern must not match OpenRouter's qwen models)
  if (ownProvider) {
    for (const [pattern, tokens] of ownProvider.contextWindows) {
      if (model.includes(pattern)) return { tokens, source: "fallback" };
    }
  }
  if (!ownProvider?.grouped) {
    for (const provider of getAllProviders()) {
      if (provider === ownProvider) continue;
      for (const [pattern, tokens] of provider.contextWindows) {
        if (model.includes(pattern)) return { tokens, source: "fallback" };
      }
    }
  }
  return { tokens: DEFAULT_CONTEXT_TOKENS, source: "fallback" };
}

/**
 * Get the context window size (in tokens) for a model ID.
 * Async — fetches metadata if cache is empty, with 5s timeout.
 * Falls back to hardcoded patterns on timeout/failure.
 */
export async function getModelContextWindow(modelId: string): Promise<number> {
  return (await getModelContextInfo(modelId)).tokens;
}

/**
 * Synchronous cache-only context window lookup.
 * Returns best-known value from already-populated caches.
 * Use only where async is impossible (e.g. React render). Prefer getModelContextWindow.
 */
export function getModelContextWindowSync(modelId: string): number {
  return getModelContextInfoSync(modelId).tokens;
}

export async function getModelContextInfo(modelId: string): Promise<ContextWindowResult> {
  // Fast path: check caches first (no async needed)
  const cached = getModelContextInfoSync(modelId);
  if (cached.source !== "fallback") {
    return cached;
  }

  // Cache miss on a non-hardcoded model — fetch metadata
  try {
    await ensureModelMetadata(modelId);
  } catch {
    // timeout or network failure — fall through to sync result
  }

  // Re-check after fetch
  return getModelContextInfoSync(modelId);
}

/**
 * Fetch and cache metadata for a model's provider. Deduped, 5s timeout.
 * Safe to call multiple times — no-ops if cache is already populated.
 */
export async function ensureModelMetadata(modelId: string): Promise<void> {
  const slashIdx = modelId.indexOf("/");
  const providerId = slashIdx >= 0 ? modelId.slice(0, slashIdx) : "";
  if (!providerId) return;

  const provider = getProvider(providerId);

  const doFetch = async () => {
    if (provider?.grouped) {
      // Grouped providers (openrouter, proxy, vercel_gateway, llmgateway)
      // fetchGroupedModels is already deduped via cache check
      await fetchGroupedModels(providerId);
    } else if (provider) {
      // Direct providers (anthropic, openai, google, xai, ollama)
      await fetchProviderModels(providerId);
    }
    // Also fetch OpenRouter catalog as universal fallback
    await fetchOpenRouterMetadata();
  };

  // Race against timeout — never block forever
  await Promise.race([
    doFetch(),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("metadata fetch timeout")), METADATA_FETCH_TIMEOUT),
    ),
  ]);
}

interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
}

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing?: OpenRouterPricing;
}

let openRouterCache: OpenRouterModel[] | null = null;

/** Look up OpenRouter pricing for a model ID. Returns per-million-token costs or null. */
export function getOpenRouterModelPricing(
  modelId: string,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  const match = findOpenRouterModel(modelId);
  if (!match?.pricing) return null;
  const p = match.pricing;
  // OpenRouter prices are per-token strings; convert to per-million-token numbers
  const input = Number(p.prompt ?? "0") * 1e6;
  const output = Number(p.completion ?? "0") * 1e6;
  const cacheRead = Number(p.input_cache_read ?? "0") * 1e6;
  // If no cache write price, default to input price (most providers charge same as input)
  const cacheWrite = p.input_cache_write ? Number(p.input_cache_write) * 1e6 : input;
  if (
    Number.isNaN(input) ||
    Number.isNaN(output) ||
    Number.isNaN(cacheRead) ||
    Number.isNaN(cacheWrite)
  )
    return null;
  return { input, output, cacheRead, cacheWrite };
}

/**
 * Ensure the OpenRouter model catalog is cached. Delegates to the grouped fetch
 * which works with or without an API key and populates both openRouterCache
 * (flat, for context-window lookups) and groupedCache (for model picker).
 */
export async function fetchOpenRouterMetadata(): Promise<void> {
  if (openRouterCache) return;
  await fetchGroupedModels("openrouter");
}

function findOpenRouterModel(model: string): OpenRouterModel | undefined {
  if (!openRouterCache) return undefined;
  const lower = model.toLowerCase();

  // Exact full-ID match (handles "qwen/qwen3.6-plus-preview:free" style)
  const fullMatch = openRouterCache.find((m) => m.id.toLowerCase() === lower);
  if (fullMatch) return fullMatch;

  // Exact suffix match (case-insensitive) — handles bare model names like "claude-opus-4-6"
  const exact =
    openRouterCache.find((m) => m.id.endsWith(`/${lower}`)) ??
    openRouterCache.find((m) => m.id.endsWith(`/${model}`));
  if (exact) return exact;

  // Normalize hyphens → dots for version matching (Anthropic uses "claude-opus-4-6",
  // OpenRouter uses "claude-opus-4.6") and try exact match again
  const dotNormalized = lower.replace(/-(\d+)-(\d)/g, "-$1.$2");
  if (dotNormalized !== lower) {
    const dotMatch =
      openRouterCache.find((m) => m.id.toLowerCase() === dotNormalized) ??
      openRouterCache.find((m) => m.id.endsWith(`/${dotNormalized}`));
    if (dotMatch) return dotMatch;
  }

  // Fuzzy match — compare bare model names (after last slash).
  // Prefer exact bare match, then closest-length prefix match.
  const lowerBare = lower.includes("/") ? (lower.split("/").pop() ?? lower) : lower;
  let best: OpenRouterModel | undefined;
  let bestDist = Infinity;
  for (const m of openRouterCache) {
    const orModel = (m.id.split("/").pop() ?? "").toLowerCase();
    if (orModel === lowerBare) return m;
    if (lowerBare.startsWith(orModel) || orModel.startsWith(lowerBare)) {
      const dist = Math.abs(orModel.length - lowerBare.length);
      if (dist < bestDist) {
        best = m;
        bestDist = dist;
      }
    }
  }
  return best;
}

function getOpenRouterModelName(model: string): string | undefined {
  const match = findOpenRouterModel(model);
  if (!match) return undefined;
  return match.name.replace(/^[^:]+:\s*/, "");
}

/**
 * Get a short display label for a model ID (e.g. "Claude Sonnet 4", "GPT-4o Mini").
 * Resolution: provider API cache → grouped cache → OpenRouter cache → smart fallback.
 * No hardcoded model names — all labels come from API data or clean truncation.
 */
export function getShortModelLabel(modelId: string): string {
  if (modelId === "none") return "No model";
  const slashIdx = modelId.indexOf("/");
  const providerId = slashIdx >= 0 ? modelId.slice(0, slashIdx) : "";
  const bareModel = slashIdx >= 0 ? modelId.slice(slashIdx + 1) : modelId;

  // 1. Provider API cache (direct providers)
  if (providerId) {
    const entry = modelCache.get(providerId);
    if (entry && Date.now() - entry.ts <= MODEL_CACHE_TTL) {
      const match = entry.models.find((m) => m.id === bareModel);
      if (match) return match.name;
    }
  }

  // 2. Grouped provider cache (vercel_gateway, proxy)
  for (const entry of groupedCache.values()) {
    if (Date.now() - entry.ts > MODEL_CACHE_TTL) continue;
    for (const models of Object.values(entry.result.modelsByProvider)) {
      const match = models.find((m) => m.id === bareModel || m.id === modelId);
      if (match && match.name !== match.id) return match.name;
    }
  }

  // 3. Fallback models from provider definitions
  const stripped = bareModel.replace(/-\d{8}$/, "");
  let bestFallback: { name: string; specificity: number } | null = null;
  for (const provider of getAllProviders()) {
    for (const m of provider.fallbackModels) {
      if (m.id === bareModel || m.id === stripped) return m.name;
      if (stripped.startsWith(m.id) || m.id.startsWith(stripped)) {
        const specificity = m.id.length;
        if (!bestFallback || specificity > bestFallback.specificity) {
          bestFallback = { name: m.name, specificity };
        }
      }
    }
  }
  if (bestFallback) return bestFallback.name;

  // 4. OpenRouter metadata
  const orName = getOpenRouterModelName(bareModel);
  if (orName) return orName;

  // 5. Smart fallback — strip date suffix, clean up
  const clean = bareModel.replace(/-\d{8}$/, "");
  return clean.length > 24 ? `${clean.slice(0, 21)}...` : clean;
}

const MODEL_CACHE_TTL = 30 * 60_000;
const modelCache = new Map<string, { models: ProviderModelInfo[]; ts: number }>();

function getCached<T>(cache: Map<string, { result: T; ts: number }>, key: string): T | null;
function getCached<T>(cache: Map<string, { models: T; ts: number }>, key: string): T | null;
function getCached(
  cache: Map<string, { result?: unknown; models?: unknown; ts: number }>,
  key: string,
): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > MODEL_CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.result ?? entry.models ?? null;
}

export function getCachedModels(providerId: string): ProviderModelInfo[] | null {
  return getCached(modelCache, providerId);
}

export function invalidateProviderModelCache(providerId: string): void {
  modelCache.delete(providerId);
  groupedCache.delete(providerId);
}

export async function fetchProviderModels(
  providerId: string,
  { bypassCache = false }: { bypassCache?: boolean } = {},
): Promise<FetchModelsResult> {
  // Check cache first
  const entry = modelCache.get(providerId);
  if (!bypassCache && entry && Date.now() - entry.ts <= MODEL_CACHE_TTL)
    return { models: entry.models };

  const provider = getProvider(providerId);
  if (!provider) return { models: [] };

  try {
    const models = await provider.fetchModels();
    if (models) {
      modelCache.set(providerId, { models, ts: Date.now() });
      return { models };
    }
    return { models: provider.fallbackModels };
  } catch (err) {
    const msg = toErrorMessage(err);
    return { models: [], error: `API error: ${msg}` };
  }
}

/**
 * Pre-warm model caches for ALL providers in parallel.
 * Fire-and-forget — each provider fetch is independent and swallows errors.
 * Call at boot so the LlmSelector popup opens instantly with cached data.
 */
export function prewarmAllModels(): void {
  for (const cfg of PROVIDER_CONFIGS) {
    // Skip proxy — it auto-installs and spawns a binary.
    // Only start it when the user explicitly selects the proxy provider.
    if (cfg.id === "proxy") continue;
    if (cfg.grouped) {
      fetchGroupedModels(cfg.id).catch(() => {});
    } else {
      fetchProviderModels(cfg.id).catch(() => {});
    }
  }
}

interface OpenAIModelEntry {
  id: string;
  owned_by?: string;
  name?: string;
  type?: string;
}

interface AnthropicModelEntry {
  id: string;
  type: string;
  display_name?: string;
  context_window?: number;
}

/**
 * Fetch context window sizes from Anthropic's /v1/models API.
 * Returns a map of modelId → context_window tokens.
 * Falls back gracefully if ANTHROPIC_API_KEY is unavailable or the call fails.
 */
async function fetchAnthropicContextWindows(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const apiKey = getPooledApiKey("anthropic");
  if (!apiKey) return map;
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) return map;
    const data = (await res.json()) as { data: AnthropicModelEntry[] };
    for (const m of data.data) {
      if (m.context_window) map.set(m.id, m.context_window);
    }
  } catch {}
  return map;
}

const groupedCache = new Map<string, { result: GroupedModelsResult; ts: number }>();

export function getCachedGroupedModels(providerId: string): GroupedModelsResult | null {
  return getCached(groupedCache, providerId);
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const GROUP_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  meta: "Meta",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  other: "Other",
};

export async function fetchGroupedModels(
  providerId: string,
  { bypassCache = false }: { bypassCache?: boolean } = {},
): Promise<GroupedModelsResult> {
  const entry = groupedCache.get(providerId);
  if (!bypassCache && entry && Date.now() - entry.ts <= MODEL_CACHE_TTL) return entry.result;

  if (providerId === "vercel_gateway") return fetchVercelGatewayGrouped();
  if (providerId === "llmgateway") return fetchLLMGatewayGrouped();
  if (providerId === "proxy") return fetchProxyGrouped();
  if (providerId === "openrouter") return fetchOpenRouterGrouped();

  // Generic fallback: use fetchModels/fallbackModels and group by model prefix
  return fetchGenericGrouped(providerId);
}

// Backward-compat wrapper
async function fetchGenericGrouped(providerId: string): Promise<GroupedModelsResult> {
  const { models, error } = await fetchProviderModels(providerId);
  if (error || models.length === 0) {
    return { subProviders: [], modelsByProvider: {}, error };
  }

  const grouped: Record<string, ProviderModelInfo[]> = {};
  for (const m of models) {
    const group = inferModelGroup(m.id);
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(m);
  }

  const subProviders = Object.keys(grouped).map((g) => ({
    id: g,
    name: GROUP_DISPLAY_NAMES[g] ?? g,
  }));

  const result: GroupedModelsResult = { subProviders, modelsByProvider: grouped };
  groupedCache.set(providerId, { result, ts: Date.now() });
  return result;
}

export async function fetchVercelGatewayModels(): Promise<GroupedModelsResult> {
  return fetchGroupedModels("vercel_gateway");
}

async function fetchVercelGatewayGrouped(): Promise<GroupedModelsResult> {
  const apiKey = getPooledApiKey("vercel_gateway");
  if (!apiKey) {
    return { subProviders: [], modelsByProvider: {}, error: "vercel_gateway credentials not set" };
  }

  try {
    const io = getIOClient();
    const r = await io.fetchModelsFromUrl(
      "https://ai-gateway.vercel.sh/v1/models",
      { Authorization: `Bearer ${apiKey}` },
      "vercel_gateway",
      true,
    );
    if (r.error && !r.grouped) {
      return { subProviders: [], modelsByProvider: {}, error: `Gateway error: ${r.error}` };
    }
    const result: GroupedModelsResult = r.grouped
      ? {
          subProviders: r.grouped.subProviders,
          modelsByProvider: r.grouped.modelsByProvider,
          error: r.error,
        }
      : { subProviders: [], modelsByProvider: {}, error: r.error };
    groupedCache.set("vercel_gateway", { result, ts: Date.now() });
    return result;
  } catch (err) {
    const msg = toErrorMessage(err);
    return { subProviders: [], modelsByProvider: {}, error: `Gateway error: ${msg}` };
  }
}

async function fetchLLMGatewayGrouped(): Promise<GroupedModelsResult> {
  const apiKey = getPooledApiKey("llmgateway");

  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const io = getIOClient();
    const r = await io.fetchModelsFromUrl(
      "https://api.llmgateway.io/v1/models",
      headers,
      "llmgateway",
      true,
    );
    if (r.error && !r.grouped) {
      return { subProviders: [], modelsByProvider: {}, error: `LLM Gateway: ${r.error}` };
    }
    const result: GroupedModelsResult = r.grouped
      ? {
          subProviders: r.grouped.subProviders,
          modelsByProvider: r.grouped.modelsByProvider,
          error: r.error,
        }
      : { subProviders: [], modelsByProvider: {}, error: r.error };
    groupedCache.set("llmgateway", { result, ts: Date.now() });
    return result;
  } catch (err) {
    const msg = toErrorMessage(err);
    return { subProviders: [], modelsByProvider: {}, error: `LLM Gateway: ${msg}` };
  }
}

async function fetchOpenRouterGrouped(): Promise<GroupedModelsResult> {
  const apiKey = getPooledApiKey("openrouter");
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const io = getIOClient();
    let r = await io.fetchModelsFromUrl(
      "https://openrouter.ai/api/v1/models",
      headers,
      "openrouter",
      true,
    );
    // Key might be invalid — retry without it
    if (r.error && apiKey && r.error.includes("HTTP 4")) {
      r = await io.fetchModelsFromUrl(
        "https://openrouter.ai/api/v1/models",
        {},
        "openrouter",
        true,
      );
    }
    if (r.error && !r.grouped) {
      return { subProviders: [], modelsByProvider: {}, error: `OpenRouter: ${r.error}` };
    }

    // Populate flat cache for context-window lookups
    if (r.models.length > 0) {
      openRouterCache = r.models.map((m) => ({
        id: m.id,
        name: m.name,
        context_length: m.contextWindow ?? 0,
      }));
    }

    const result: GroupedModelsResult = r.grouped
      ? {
          subProviders: r.grouped.subProviders,
          modelsByProvider: r.grouped.modelsByProvider,
          error: r.error,
        }
      : { subProviders: [], modelsByProvider: {}, error: r.error };
    groupedCache.set("openrouter", { result, ts: Date.now() });
    return result;
  } catch (err) {
    const msg = toErrorMessage(err);
    return { subProviders: [], modelsByProvider: {}, error: `OpenRouter: ${msg}` };
  }
}

async function fetchProxyGrouped(): Promise<GroupedModelsResult> {
  const baseURL = process.env.PROXY_API_URL || "http://127.0.0.1:8317/v1";
  const apiKey = process.env.PROXY_API_KEY || "soulforge";

  // Don't auto-install or spawn the proxy just to browse models.
  // Only fetch if the proxy is already running. The user must explicitly
  // select the proxy provider (onActivate → ensureProxy) to install/start it.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${baseURL}/models`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    clearTimeout(timeout);
    if (!res.ok) return { subProviders: [], modelsByProvider: {} };

    const data = (await res.json()) as {
      data: (OpenAIModelEntry & { context_length?: number })[];
    };

    // Tier 1: context windows from proxy /models response
    // Tier 2: Anthropic API + OpenRouter catalog (parallel fetch)
    const [anthropicCtx] = await Promise.all([
      fetchAnthropicContextWindows(),
      fetchOpenRouterMetadata(),
    ]);

    const grouped: Record<string, ProviderModelInfo[]> = {};

    for (const m of data.data) {
      const group = inferModelGroup(m.id);
      if (!grouped[group]) grouped[group] = [];

      // Tier 1: proxy response, Tier 2: Anthropic API / OpenRouter, Tier 3: hardcoded (via caller)
      const ctxWindow =
        m.context_length ?? anthropicCtx.get(m.id) ?? findOpenRouterModel(m.id)?.context_length;

      grouped[group].push({
        id: m.id,
        name: m.id,
        contextWindow: ctxWindow,
      });
    }

    const subProviders: SubProvider[] = Object.keys(grouped)
      .sort()
      .map((id) => ({ id, name: GROUP_DISPLAY_NAMES[id] ?? titleCase(id) }));

    const result: GroupedModelsResult = {
      subProviders,
      modelsByProvider: grouped,
    };
    groupedCache.set("proxy", { result, ts: Date.now() });
    return result;
  } catch {
    return { subProviders: [], modelsByProvider: {}, error: "Proxy not running" };
  }
}
