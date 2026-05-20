import { execFile } from "node:child_process";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { CompactionStrategy } from "../core/compaction/types.js";
import { getNvimPid } from "../core/editor/instance.js";
import { getIntelligenceChildPids } from "../core/intelligence/index.js";
import { getOpenRouterModelPricing } from "../core/llm/models.js";
import { getProxyPid } from "../core/proxy/lifecycle.js";

interface PerModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  subagentInput: number;
  subagentOutput: number;
  lastStepInput: number;
  lastStepOutput: number;
  lastStepCacheRead: number;
  modelBreakdown: Record<string, PerModelUsage>;
}

interface ModelPricing {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

// Prices in USD per million tokens. Sources (verified 2026-04-30):
// Anthropic: https://docs.claude.com/en/docs/about-claude/pricing
// OpenAI:    https://openai.com/api/pricing/
// Google:    https://ai.google.dev/gemini-api/docs/pricing
// DeepSeek:  https://api-docs.deepseek.com/quick_start/pricing
const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── Anthropic Claude ──────────────────────────────────────────────
  // Source: https://docs.claude.com/en/docs/about-claude/pricing (2026-04-30)
  // cacheWrite = 5-min TTL (1.25× base). 1h TTL would be 2× base; SDK doesn't
  // expose which TTL was used, and we always request the 5m default.
  // cacheRead = 0.1× base input.
  "claude-opus-4-7": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-6": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-5": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-1": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-opus-4-0": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-opus-4": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-sonnet-4-6": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4-5": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-3.7-sonnet": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-3.5-sonnet": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  "claude-3.5-haiku": { input: 0.8, cacheWrite: 1.0, cacheRead: 0.08, output: 4 },
  "claude-3-opus": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-3-haiku": { input: 0.25, cacheWrite: 0.3, cacheRead: 0.03, output: 1.25 },

  // ── OpenAI ────────────────────────────────────────────────────────
  // Source: https://openai.com/api/pricing/ (2026-04-30)
  // Only GPT-5.5 / 5.4 / 5.4-mini are on the official flagship page.
  // Older models retained as fallbacks for historical model IDs.
  // cacheRead = 10% of input across the GPT-5.x family.
  "gpt-5.5": { input: 5, cacheWrite: 5, cacheRead: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cacheWrite: 2.5, cacheRead: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cacheWrite: 0.75, cacheRead: 0.075, output: 4.5 },
  // Legacy / no-longer-listed (estimates retained for back-compat with old IDs)
  "gpt-4.1": { input: 2, cacheWrite: 2, cacheRead: 0.5, output: 8 },
  "gpt-4.1-mini": { input: 0.4, cacheWrite: 0.4, cacheRead: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cacheWrite: 0.1, cacheRead: 0.025, output: 0.4 },
  "gpt-4o": { input: 2.5, cacheWrite: 2.5, cacheRead: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, cacheWrite: 0.15, cacheRead: 0.075, output: 0.6 },
  o3: { input: 10, cacheWrite: 10, cacheRead: 2, output: 40 },
  "o3-mini": { input: 1.1, cacheWrite: 1.1, cacheRead: 0.275, output: 4.4 },
  "o4-mini": { input: 1.1, cacheWrite: 1.1, cacheRead: 0.275, output: 4.4 },

  // ── Google Gemini ─────────────────────────────────────────────────
  // Source: https://ai.google.dev/gemini-api/docs/pricing (2026-04-30)
  // Pro tiers double for prompts >200k; we use the ≤200k rate (typical agent context).
  // cacheRead = 10% of input.
  "gemini-3.1-pro": { input: 2, cacheWrite: 2, cacheRead: 0.2, output: 12 },
  "gemini-3-flash": { input: 0.5, cacheWrite: 0.5, cacheRead: 0.05, output: 3 },
  "gemini-3.1-flash-lite": { input: 0.25, cacheWrite: 0.25, cacheRead: 0.025, output: 1.5 },
  "gemini-2.5-pro": { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10 },
  "gemini-2.5-flash": { input: 0.3, cacheWrite: 0.3, cacheRead: 0.03, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, cacheWrite: 0.1, cacheRead: 0.01, output: 0.4 },
  "gemini-2.0-flash": { input: 0.1, cacheWrite: 0.1, cacheRead: 0.025, output: 0.4 },
  "gemini-2.0-flash-lite": { input: 0.075, cacheWrite: 0.075, cacheRead: 0.019, output: 0.3 },

  // ── DeepSeek ──────────────────────────────────────────────────────
  // Source: https://api-docs.deepseek.com/quick_start/pricing (2026-04-30)
  // deepseek-chat / deepseek-reasoner are aliases for deepseek-v4-flash (non-thinking / thinking).
  // Cache hit price reduced to 1/10 of input on 2026-04-26.
  // v4-pro list price; 75%-off promo runs until 2026-05-31.
  "deepseek-v4-pro": { input: 1.74, cacheWrite: 1.74, cacheRead: 0.0145, output: 3.48 },
  "deepseek-v4-flash": { input: 0.14, cacheWrite: 0.14, cacheRead: 0.014, output: 0.28 },
  "deepseek-chat": { input: 0.14, cacheWrite: 0.14, cacheRead: 0.014, output: 0.28 },
  "deepseek-reasoner": { input: 0.14, cacheWrite: 0.14, cacheRead: 0.014, output: 0.28 },
  "deepseek-v3": { input: 0.28, cacheWrite: 0.28, cacheRead: 0.028, output: 0.42 },
  "deepseek-r1": { input: 0.28, cacheWrite: 0.28, cacheRead: 0.028, output: 0.42 },

  // ── Groq ───────────────────────────────────────────────────────────
  // Source: https://groq.com/pricing/ (2026-07)
  // cacheRead = 50% of input (Groq prompt caching discount)
  "llama-3.3-70b": { input: 0.59, cacheWrite: 0.59, cacheRead: 0.295, output: 0.79 },
  "llama-3.1-8b": { input: 0.05, cacheWrite: 0.05, cacheRead: 0.025, output: 0.08 },
  "llama-4-scout": { input: 0.11, cacheWrite: 0.11, cacheRead: 0.055, output: 0.34 },
  "qwen3-32b": { input: 0.29, cacheWrite: 0.29, cacheRead: 0.145, output: 0.59 },
  "gpt-oss-20b": { input: 0.075, cacheWrite: 0.075, cacheRead: 0.0375, output: 0.3 },
  "gpt-oss-120b": { input: 0.15, cacheWrite: 0.15, cacheRead: 0.075, output: 0.6 },

  // ── Mistral ────────────────────────────────────────────────────────
  // Source: https://docs.mistral.ai/getting-started/models/compare (2026-07)
  "mistral-large": { input: 0.5, cacheWrite: 0.5, cacheRead: 0.05, output: 1.5 },
  "mistral-medium": { input: 0.4, cacheWrite: 0.4, cacheRead: 0.04, output: 2 },
  "mistral-small": { input: 0.1, cacheWrite: 0.1, cacheRead: 0.01, output: 0.3 },
  codestral: { input: 0.3, cacheWrite: 0.3, cacheRead: 0.03, output: 0.9 },
  magistral: { input: 0.5, cacheWrite: 0.5, cacheRead: 0.05, output: 1.5 },
  ministral: { input: 0.1, cacheWrite: 0.1, cacheRead: 0.01, output: 0.1 },
  pixtral: { input: 0.15, cacheWrite: 0.15, cacheRead: 0.015, output: 0.15 },
  devstral: { input: 0.1, cacheWrite: 0.1, cacheRead: 0.01, output: 0.3 },
};

const FREE_PRICING: ModelPricing = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
const DEFAULT_PRICING: ModelPricing = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };

// ── GitHub Copilot (premium request model) ─────────────────────
// Copilot bills per "premium request" ($0.04 × multiplier per API call).
// Per-token costs are estimated from multiplier / typical request size.
// Models with multiplier 0 (GPT-4o, GPT-4.1, GPT-5-mini) are free on paid plans.
// Source: https://docs.github.com/en/copilot/managing-copilot/monitoring-usage-and-entitlements/about-premium-requests (verified 2026-04-30)
// Premium request multiplier → per-1M-token cost estimate.
// (Starting 2026-06-01 Copilot moves to usage-based billing; multipliers remain informative.)
// Formula: multiplier × $0.04 per request, ~5k tokens/request avg → $/1M = multiplier × $8
// input:output ratio ~4:1 in typical coding, so input = mult×$2, output = mult×$10
const FREE: ModelPricing = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
const M025: ModelPricing = { input: 0.5, cacheWrite: 0.5, cacheRead: 0.05, output: 2.5 };
const M033: ModelPricing = { input: 0.66, cacheWrite: 0.66, cacheRead: 0.07, output: 3.3 };
const M1: ModelPricing = { input: 2, cacheWrite: 2, cacheRead: 0.2, output: 10 };
const M3: ModelPricing = { input: 6, cacheWrite: 6, cacheRead: 0.6, output: 30 };
const M30: ModelPricing = { input: 60, cacheWrite: 60, cacheRead: 6, output: 300 };
const M75: ModelPricing = { input: 15, cacheWrite: 15, cacheRead: 1.5, output: 75 };

const COPILOT_PRICING: Record<string, ModelPricing> = {
  // multiplier 0 (free on paid plans)
  "gpt-4o": FREE,
  "gpt-4o-mini": FREE,
  "gpt-4.1": FREE,
  "gpt-5-mini": FREE,
  "raptor-mini": FREE,
  // multiplier 0.25
  "grok-code-fast": M025,
  grok: M025,
  "gpt-5.4-nano": M025,
  // multiplier 0.33
  "claude-haiku-4.5": M033,
  "gpt-5.4-mini": M033,
  "gpt-5.1-codex-mini": M033,
  "gemini-3-flash": M033,
  // multiplier 1
  "claude-sonnet-4.6": M1,
  "claude-sonnet-4.5": M1,
  "claude-sonnet-4": M1,
  "claude-3.7-sonnet": M1,
  "claude-3.5-sonnet": M1,
  "gemini-2.5-pro": M1,
  "gemini-3.1-pro": M1,
  "gemini-3-pro": M1,
  "gpt-5.1": M1,
  "gpt-5.2": M1,
  "gpt-5.2-codex": M1,
  "gpt-5.3": M1,
  "gpt-5.3-codex": M1,
  "gpt-5.4": M1,
  "o3-mini": M1,
  "o4-mini": M1,
  // multiplier 3
  "claude-opus-4.5": M3,
  "claude-opus-4.6": M3,
  // multiplier 7.5
  "claude-opus-4.7": M75,
  "gpt-5.5": M75,
  // multiplier 30 (Opus 4.6 fast mode preview)
  "claude-opus-4.6-fast": M30,
};

function matchCopilotPricing(model: string): ModelPricing | undefined {
  const entries = Object.entries(COPILOT_PRICING).sort((a, b) => b[0].length - a[0].length);
  for (const [key, pricing] of entries) {
    if (model.includes(key)) return pricing;
  }
  return undefined;
}

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio"]);

/** Check if a model runs locally (Ollama, LM Studio, etc.) — always zero cost. */
export function isModelLocal(modelId: string): boolean {
  const slash = modelId.indexOf("/");
  if (slash < 0) return false;
  return LOCAL_PROVIDERS.has(modelId.slice(0, slash).toLowerCase());
}

/** Check if a model is free (`:free` / `-free` suffix, or zero pricing from OpenRouter). */
export function isModelFree(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (id.endsWith(":free") || id.endsWith("-free")) return true;
  // Check OpenRouter catalog for zero pricing
  if (id.startsWith("openrouter/")) {
    const orModel = id.slice("openrouter/".length);
    const orPricing = getOpenRouterModelPricing(orModel);
    if (orPricing && orPricing.input === 0 && orPricing.output === 0) return true;
  }
  return false;
}

function matchPricing(modelId: string): ModelPricing {
  const id = modelId.toLowerCase();

  // Local and free models — zero cost
  if (isModelLocal(modelId) || isModelFree(modelId)) return FREE_PRICING;

  // GitHub Copilot: premium request-based pricing
  if (id.startsWith("copilot/")) {
    const model = id.slice("copilot/".length);
    return matchCopilotPricing(model) ?? M1;
  }
  // GitHub Models: per-token pricing via multipliers ($0.00001/unit)
  // The catalog provides real per-model pricing; fall through to standard matching
  // since github-models model IDs include provider prefix (openai/gpt-4o etc)
  if (id.startsWith("github-models/")) {
    const model = id.slice("github-models/".length);
    const entries = Object.entries(MODEL_PRICING).sort((a, b) => b[0].length - a[0].length);
    for (const [key, pricing] of entries) {
      if (model.includes(key)) return pricing;
    }
    return DEFAULT_PRICING;
  }
  // OpenRouter: use real pricing from the API catalog when available
  if (id.startsWith("openrouter/")) {
    const orModel = id.slice("openrouter/".length);
    const orPricing = getOpenRouterModelPricing(orModel);
    if (orPricing) return orPricing;
  }
  // Fireworks: tier-based pricing differs from direct provider pricing.
  // Model IDs are fireworks/accounts/fireworks/models/<model-name>.
  // Source: https://fireworks.ai/pricing (2026-07). cacheRead = 50% of input.
  if (id.startsWith("fireworks/")) {
    const model = id.slice("fireworks/".length);
    if (model.includes("deepseek-v3") || model.includes("deepseek-r1"))
      return { input: 0.56, cacheWrite: 0.56, cacheRead: 0.28, output: 1.68 };
    if (model.includes("mixtral-8x22b"))
      return { input: 1.2, cacheWrite: 1.2, cacheRead: 0.6, output: 1.2 };
    if (model.includes("mixtral-8x7b"))
      return { input: 0.5, cacheWrite: 0.5, cacheRead: 0.25, output: 0.5 };
    // >16B params (llama 70B+, qwen 72B, etc): $0.90/M tokens
    return { input: 0.9, cacheWrite: 0.9, cacheRead: 0.45, output: 0.9 };
  }
  // Sort by key length descending so "claude-opus-4-6" matches before "claude-opus-4"
  const entries = Object.entries(MODEL_PRICING).sort((a, b) => b[0].length - a[0].length);
  for (const [key, pricing] of entries) {
    if (id.includes(key)) return pricing;
  }
  // Fallback heuristics for unknown variants / OpenRouter prefixed IDs
  if (id.includes("opus")) return MODEL_PRICING["claude-opus-4-6"] ?? DEFAULT_PRICING;
  if (id.includes("sonnet")) return DEFAULT_PRICING;
  if (id.includes("haiku")) return MODEL_PRICING["claude-haiku-4-5"] ?? DEFAULT_PRICING;
  if (id.includes("gemini")) return MODEL_PRICING["gemini-2.5-flash"] ?? DEFAULT_PRICING;
  if (id.includes("gpt")) return MODEL_PRICING["gpt-5.4"] ?? DEFAULT_PRICING;
  if (id.includes("deepseek")) return MODEL_PRICING["deepseek-chat"] ?? DEFAULT_PRICING;
  return DEFAULT_PRICING;
}

/** Compute session cost in USD.
 *  prompt = uncached input only (noCache tokens).
 *  cacheWrite and cacheRead tracked separately with their own rates.
 *  @internal — exported for testing only; production code uses computeTotalCostFromBreakdown */
export function computeCost(usage: TokenUsage, modelId: string): number {
  const p = matchPricing(modelId);
  const uncached = usage.prompt + usage.subagentInput;
  const totalOutput = usage.completion + usage.subagentOutput;
  return (
    (uncached / 1e6) * p.input +
    (usage.cacheWrite / 1e6) * p.cacheWrite +
    (usage.cacheRead / 1e6) * p.cacheRead +
    (totalOutput / 1e6) * p.output
  );
}

/** Compute total cost from per-model breakdown. More accurate than computeCost when router mixes models. */
export function computeTotalCostFromBreakdown(breakdown: Record<string, PerModelUsage>): number {
  let total = 0;
  for (const [modelId, usage] of Object.entries(breakdown)) {
    const p = matchPricing(modelId);
    const cost =
      ((usage.input ?? 0) / 1e6) * p.input +
      ((usage.cacheWrite ?? 0) / 1e6) * p.cacheWrite +
      ((usage.cacheRead ?? 0) / 1e6) * p.cacheRead +
      ((usage.output ?? 0) / 1e6) * p.output;
    if (Number.isFinite(cost)) total += cost;
  }
  return total;
}

/** Compute cost for a single model from the breakdown. */
export function computeModelCost(modelId: string, usage: PerModelUsage): number {
  const p = matchPricing(modelId);
  const cost =
    ((usage.input ?? 0) / 1e6) * p.input +
    ((usage.cacheWrite ?? 0) / 1e6) * p.cacheWrite +
    ((usage.cacheRead ?? 0) / 1e6) * p.cacheRead +
    ((usage.output ?? 0) / 1e6) * p.output;
  return Number.isFinite(cost) ? cost : 0;
}

/** Accumulate tokens for a specific model in the breakdown. Returns a new breakdown object. */
export function accumulateModelUsage(
  breakdown: Record<string, PerModelUsage>,
  modelId: string,
  delta: Partial<PerModelUsage>,
): Record<string, PerModelUsage> {
  const prev = breakdown[modelId] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    ...breakdown,
    [modelId]: {
      input: prev.input + (delta.input ?? 0),
      output: prev.output + (delta.output ?? 0),
      cacheRead: prev.cacheRead + (delta.cacheRead ?? 0),
      cacheWrite: prev.cacheWrite + (delta.cacheWrite ?? 0),
    },
  };
}

export const ZERO_USAGE: TokenUsage = {
  prompt: 0,
  completion: 0,
  total: 0,
  cacheRead: 0,
  cacheWrite: 0,
  subagentInput: 0,
  subagentOutput: 0,
  lastStepInput: 0,
  lastStepOutput: 0,
  lastStepCacheRead: 0,
  modelBreakdown: {},
};

interface ProcessRss {
  mainMB: number;
  nvimMB: number;
  proxyMB: number;
  lspMB: number;
}

const ZERO_PROCESS_RSS: ProcessRss = { mainMB: 0, nvimMB: 0, proxyMB: 0, lspMB: 0 };

export interface LastDispatchAgent {
  agentId: string;
  role?: string;
  modelId?: string;
  tier?: string;
  task?: string;
  toolUses: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  succeeded?: boolean;
  state: "running" | "done" | "error";
}

export interface LastDispatchSnapshot {
  parentToolCallId: string;
  startedAt: number;
  finishedAt?: number;
  totalAgents: number;
  completedAgents: number;
  agents: Record<string, LastDispatchAgent>;
}

export interface RetryStatus {
  /** "transient" = mid-transient-error retry on current model, "fallback" = switching to next fallback */
  type: "transient" | "fallback";
  /** Current attempt / limit, e.g. "2/3" */
  label: string;
  /** Model being retried/fallen back to (nil for transient) */
  model?: string;
  /** >0 when backoff before next attempt is in progress */
  backoffMs: number;
}

interface StatusBarState {
  tokenUsage: TokenUsage;
  activeModel: string;
  contextTokens: number;
  contextWindow: number;
  chatChars: number;
  chatCharsAtSnapshot: number;
  subagentChars: number;
  rssMB: number;
  processRss: ProcessRss;
  compacting: boolean;
  compactElapsed: number;
  compactionStrategy: CompactionStrategy;
  v2Slots: number;
  /** True when the user is browsing a past checkpoint */
  browsingCheckpoint: boolean;
  /** Most recent dispatch (cleared/replaced on each new dispatch-start). */
  lastDispatch: LastDispatchSnapshot | null;
  /** Active retry state — shows in the context bar, not chat messages. Null when idle. */
  retryStatus: RetryStatus | null;
  setTokenUsage: (usage: TokenUsage, modelId?: string) => void;
  resetTokenUsage: () => void;
  setContext: (contextTokens: number, chatChars: number) => void;
  setBrowsingCheckpoint: (v: boolean) => void;
  setContextWindow: (tokens: number) => void;
  setSubagentChars: (chars: number) => void;
  setRssMB: (mb: number) => void;
  setProcessRss: (rss: ProcessRss) => void;
  setCompacting: (v: boolean) => void;
  setCompactElapsed: (s: number) => void;
  setCompactionStrategy: (s: CompactionStrategy) => void;
  setV2Slots: (n: number) => void;
  setRetryStatus: (s: RetryStatus | null) => void;
  startDispatch: (parentToolCallId: string, totalAgents: number) => void;
  upsertDispatchAgent: (
    parentToolCallId: string,
    agent: Partial<LastDispatchAgent> & { agentId: string },
  ) => void;
  finishDispatch: (parentToolCallId: string) => void;
}

export const useStatusBarStore = create<StatusBarState>()(
  subscribeWithSelector((set) => ({
    tokenUsage: { ...ZERO_USAGE },
    activeModel: "none",
    contextTokens: 0,
    contextWindow: 0,
    chatChars: 0,
    chatCharsAtSnapshot: 0,
    subagentChars: 0,
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    processRss: {
      ...ZERO_PROCESS_RSS,
      mainMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    compacting: false,
    compactElapsed: 0,
    compactionStrategy: "v2",
    v2Slots: 0,
    browsingCheckpoint: false,
    lastDispatch: null,
    retryStatus: null,

    setTokenUsage: (usage, modelId) =>
      set({ tokenUsage: usage, ...(modelId ? { activeModel: modelId } : {}) }),
    resetTokenUsage: () => set({ tokenUsage: { ...ZERO_USAGE } }),
    setContext: (contextTokens, chatChars) =>
      set({
        contextTokens,
        chatChars,
        chatCharsAtSnapshot: contextTokens > 0 ? chatChars : 0,
        subagentChars: 0,
      }),
    setContextWindow: (tokens) => set({ contextWindow: tokens }),
    setSubagentChars: (chars) => set({ subagentChars: chars }),
    setRssMB: (mb) => set({ rssMB: mb }),
    setProcessRss: (rss) =>
      set({
        processRss: rss,
        rssMB: Math.round(rss.mainMB + rss.nvimMB + rss.proxyMB + rss.lspMB),
      }),
    setCompacting: (v) => set({ compacting: v }),
    setCompactElapsed: (s) => set({ compactElapsed: s }),
    setCompactionStrategy: (s) => set({ compactionStrategy: s }),
    setV2Slots: (n) => set({ v2Slots: n }),
    setRetryStatus: (s) => set({ retryStatus: s }),
    setBrowsingCheckpoint: (v) => set({ browsingCheckpoint: v }),

    startDispatch: (parentToolCallId, totalAgents) =>
      set({
        lastDispatch: {
          parentToolCallId,
          startedAt: Date.now(),
          totalAgents,
          completedAgents: 0,
          agents: {},
        },
      }),
    upsertDispatchAgent: (parentToolCallId, agent) =>
      set((s) => {
        const cur = s.lastDispatch;
        if (!cur || cur.parentToolCallId !== parentToolCallId) return s;
        const prev = cur.agents[agent.agentId] ?? {
          agentId: agent.agentId,
          toolUses: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          state: "running" as const,
        };
        const merged: LastDispatchAgent = { ...prev, ...agent };
        const wasRunning = prev.state === "running";
        const nowDone = merged.state === "done" || merged.state === "error";
        const completedAgents =
          wasRunning && nowDone ? cur.completedAgents + 1 : cur.completedAgents;
        return {
          lastDispatch: {
            ...cur,
            completedAgents,
            agents: { ...cur.agents, [agent.agentId]: merged },
          },
        };
      }),
    finishDispatch: (parentToolCallId) =>
      set((s) => {
        const cur = s.lastDispatch;
        if (!cur || cur.parentToolCallId !== parentToolCallId) return s;
        return { lastDispatch: { ...cur, finishedAt: Date.now() } };
      }),
  })),
);

export function resetStatusBarStore(): void {
  if (memPollTimer) {
    clearInterval(memPollTimer);
    memPollTimer = null;
    memPollStarted = false;
  }
  useStatusBarStore.setState({
    tokenUsage: { ...ZERO_USAGE },
    activeModel: "none",
    contextTokens: 0,
    contextWindow: 0,
    chatChars: 0,
    chatCharsAtSnapshot: 0,
    subagentChars: 0,
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    processRss: {
      ...ZERO_PROCESS_RSS,
      mainMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    compacting: false,
    compactElapsed: 0,
    compactionStrategy: "v2",
    v2Slots: 0,
    retryStatus: null,
  });
}

interface PidGroup {
  nvim: number | null;
  proxy: number | null;
  lsp: number[];
}

async function collectPidGroups(): Promise<PidGroup> {
  return {
    nvim: getNvimPid(),
    proxy: getProxyPid(),
    lsp: await getIntelligenceChildPids(),
  };
}

function getPerPidRssKB(pids: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (pids.length === 0) return Promise.resolve(result);
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile(
        "wmic",
        [
          "process",
          "where",
          `(${pids.map((p) => `ProcessId=${String(p)}`).join(" or ")})`,
          "get",
          "ProcessId,WorkingSetSize",
          "/format:csv",
        ],
        (err, stdout) => {
          if (err) {
            resolve(result);
            return;
          }
          for (const line of stdout.split("\n")) {
            const parts = line.trim().split(",");
            const pidStr = parts[1];
            const bytesStr = parts[2];
            if (pidStr && bytesStr) {
              const pid = Number.parseInt(pidStr, 10);
              const bytes = Number.parseInt(bytesStr, 10);
              if (!Number.isNaN(pid) && !Number.isNaN(bytes)) {
                result.set(pid, bytes / 1024);
              }
            }
          }
          resolve(result);
        },
      );
    });
  }
  return new Promise((resolve) => {
    execFile("ps", ["-p", pids.join(","), "-o", "pid=,rss="], (err, stdout) => {
      if (err) {
        resolve(result);
        return;
      }
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        const pidStr = parts[0];
        const kbStr = parts[1];
        if (pidStr && kbStr) {
          const pid = Number.parseInt(pidStr, 10);
          const kb = Number.parseInt(kbStr, 10);
          if (!Number.isNaN(pid) && !Number.isNaN(kb)) {
            result.set(pid, kb);
          }
        }
      }
      resolve(result);
    });
  });
}

/**
 * Resolve the main process's true memory footprint.
 *
 * `process.memoryUsage().rss` and `ps -o rss` both exclude macOS-compressed
 * pages — they'll report 4 GB while Activity Monitor shows 9 GB because
 * the OS silently compresses cold heap. We need the "physical footprint"
 * number, which matches what Activity Monitor displays.
 *
 * On macOS: read the footprint via the Mach task_info VM bookkeeping by
 * falling back through vmmap → ps rss. vmmap owns the accurate number
 * but costs ~80ms, so we only hit it on the main process and only when
 * the compressed portion is non-trivial.
 *
 * On Linux/Windows: RSS already includes everything meaningful.
 */
async function getMainFootprintMB(): Promise<number> {
  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (process.platform !== "darwin") return rssMB;
  const footprint = await macFootprintMB(process.pid);
  return footprint ?? rssMB;
}

function macFootprintMB(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "vmmap",
      ["--summary", String(pid)],
      { timeout: 2000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        // "Physical footprint:         9.8G" — match whatever unit vmmap emits
        const m = stdout.match(/Physical footprint:\s+([\d.]+)([KMGT])/);
        if (!m?.[1] || !m[2]) {
          resolve(null);
          return;
        }
        const n = Number.parseFloat(m[1]);
        const unit = m[2];
        const mb =
          unit === "G"
            ? n * 1024
            : unit === "M"
              ? n
              : unit === "K"
                ? n / 1024
                : unit === "T"
                  ? n * 1024 * 1024
                  : n;
        resolve(Math.round(mb));
      },
    );
  });
}

let memPollStarted = false;
let memPollTimer: ReturnType<typeof setInterval> | null = null;
export function startMemoryPoll(intervalMs = 2000) {
  if (memPollStarted) return;
  memPollStarted = true;
  memPollTimer = setInterval(async () => {
    const mainMB = await getMainFootprintMB();
    const groups = await collectPidGroups();
    const allPids: number[] = [];
    if (groups.nvim != null) allPids.push(groups.nvim);
    if (groups.proxy != null) allPids.push(groups.proxy);
    allPids.push(...groups.lsp);

    if (allPids.length === 0) {
      useStatusBarStore.getState().setProcessRss({ mainMB, nvimMB: 0, proxyMB: 0, lspMB: 0 });
      return;
    }
    getPerPidRssKB(allPids).then((rssMap) => {
      const kbToMB = (pid: number | null) =>
        pid != null ? Math.round((rssMap.get(pid) ?? 0) / 1024) : 0;
      let lspMB = 0;
      for (const pid of groups.lsp) {
        lspMB += Math.round((rssMap.get(pid) ?? 0) / 1024);
      }
      useStatusBarStore.getState().setProcessRss({
        mainMB,
        nvimMB: kbToMB(groups.nvim),
        proxyMB: kbToMB(groups.proxy),
        lspMB,
      });
    });
  }, intervalMs);
}
