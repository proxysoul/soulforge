import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { AppConfig, ContextManagementConfig, EffortLevel } from "../../types/index.js";
import { getModelContextWindow } from "./models.js";
import { getProvider } from "./providers/index.js";

interface ModelCapabilities {
  provider: "anthropic" | "openai" | "google" | "other";
  thinking: boolean;
  adaptiveThinking: boolean;
  effort: boolean;
  speed: boolean;
  contextManagement: boolean;
  interleavedThinking: boolean;
  openaiReasoning: boolean;
  openaiServiceTier: boolean;
}

interface ProviderConstraints {
  anthropicOptions: boolean;
  openaiOptions: boolean;
  effort: boolean;
  speed: boolean;
  contextManagement: boolean;
  adaptiveThinking: boolean;
  interleavedThinking: boolean;
}

const ANTHROPIC_FULL: ProviderConstraints = {
  anthropicOptions: true,
  openaiOptions: false,
  effort: true,
  speed: true,
  contextManagement: true,
  adaptiveThinking: true,
  interleavedThinking: true,
};

const OPENAI_FULL: ProviderConstraints = {
  anthropicOptions: false,
  openaiOptions: true,
  effort: false,
  speed: false,
  contextManagement: false,
  adaptiveThinking: false,
  interleavedThinking: false,
};

const GATEWAY_FULL: ProviderConstraints = {
  anthropicOptions: true,
  openaiOptions: true,
  effort: true,
  speed: true,
  contextManagement: true,
  adaptiveThinking: true,
  interleavedThinking: true,
};

const PROVIDER_CONSTRAINTS: Record<string, ProviderConstraints> = {
  anthropic: ANTHROPIC_FULL,
  proxy: GATEWAY_FULL,
  openai: OPENAI_FULL,
  xai: OPENAI_FULL,
  vercel_gateway: GATEWAY_FULL,
  llmgateway: GATEWAY_FULL,
  opencode_zen: GATEWAY_FULL,
  opencode_go: GATEWAY_FULL,
  openrouter: GATEWAY_FULL,
  bedrock: GATEWAY_FULL,
};

const NO_SUPPORT: ProviderConstraints = {
  anthropicOptions: false,
  openaiOptions: false,
  effort: false,
  speed: false,
  contextManagement: false,
  adaptiveThinking: false,
  interleavedThinking: false,
};

function parseModelId(modelId: string): { provider: string; model: string } {
  const slash = modelId.indexOf("/");
  if (slash === -1) return { provider: "", model: modelId };
  return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

function extractBaseModel(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();
}

type ClaudeGen = "legacy" | "3.5" | "4+" | "non-claude";

const LEGACY_PREFIXES = [
  "claude-3-haiku",
  "claude-3-opus",
  "claude-3-sonnet",
  "claude-3.0",
  "claude-2",
  "claude-instant",
];

function getClaudeGen(model: string): ClaudeGen {
  if (!model.startsWith("claude")) return "non-claude";
  for (const p of LEGACY_PREFIXES) {
    if (model.startsWith(p)) return "legacy";
  }
  if (model.startsWith("claude-3.5") || model.startsWith("claude-3-5")) return "3.5";
  return "4+";
}

//
// For direct providers (anthropic/, openai/), the provider prefix tells us everything.
// For gateways (llmgateway/, openrouter/, vercel_gateway/), we inspect the model name
// to determine the underlying provider family.

export type ModelFamily = "claude" | "openai" | "google" | "other";

export function detectModelFamily(modelId: string): ModelFamily {
  const { provider } = parseModelId(modelId);

  // Direct providers — no guessing needed
  if (provider === "anthropic") return "claude";
  if (provider === "openai" || provider === "xai") return "openai";
  if (provider === "google") return "google";

  // Proxy is multi-provider — inspect model name like gateways
  const base = extractBaseModel(modelId);
  if (base.startsWith("claude")) return "claude";
  if (
    base.startsWith("gpt-") ||
    base.startsWith("o1") ||
    base.startsWith("o3") ||
    base.startsWith("o4")
  )
    return "openai";
  if (base.startsWith("gemini")) return "google";

  // OpenRouter nested paths like "anthropic/claude-*" or "openai/gpt-*"
  const model = parseModelId(modelId).model;
  if (model.startsWith("anthropic/")) return "claude";
  if (model.startsWith("openai/")) return "openai";
  if (model.startsWith("google/")) return "google";

  return "other";
}

function getModelCapabilities(modelId: string): ModelCapabilities {
  const base = extractBaseModel(modelId);
  const family = detectModelFamily(modelId);

  if (family === "openai") {
    // Reasoning models: o1, o3, o4, gpt-5+
    const isReasoning =
      base.startsWith("o1") ||
      base.startsWith("o3") ||
      base.startsWith("o4") ||
      base.startsWith("gpt-5");
    return {
      provider: "openai",
      thinking: false,
      adaptiveThinking: false,
      effort: false,
      speed: false,
      contextManagement: false,
      interleavedThinking: false,
      openaiReasoning: isReasoning,
      openaiServiceTier: true,
    };
  }

  if (family === "google") {
    return {
      provider: "google",
      thinking: false,
      adaptiveThinking: false,
      effort: false,
      speed: false,
      contextManagement: false,
      interleavedThinking: false,
      openaiReasoning: false,
      openaiServiceTier: false,
    };
  }

  if (family !== "claude") {
    return {
      provider: "other",
      thinking: false,
      adaptiveThinking: false,
      effort: false,
      speed: false,
      contextManagement: false,
      interleavedThinking: false,
      openaiReasoning: false,
      openaiServiceTier: false,
    };
  }

  // Claude models — generation-based capabilities
  const gen = getClaudeGen(base);

  if (gen === "legacy") {
    return {
      provider: "anthropic",
      thinking: false,
      adaptiveThinking: false,
      effort: false,
      speed: false,
      contextManagement: false,
      interleavedThinking: false,
      openaiReasoning: false,
      openaiServiceTier: false,
    };
  }

  if (gen === "3.5") {
    return {
      provider: "anthropic",
      thinking: true,
      adaptiveThinking: false,
      effort: false,
      speed: false,
      contextManagement: false,
      interleavedThinking: false,
      openaiReasoning: false,
      openaiServiceTier: false,
    };
  }

  return {
    provider: "anthropic",
    thinking: true,
    adaptiveThinking: true,
    effort: !base.includes("haiku"),
    speed: base.includes("opus"),
    contextManagement: !base.includes("haiku"),
    interleavedThinking: true,
    openaiReasoning: false,
    openaiServiceTier: false,
  };
}

function getProviderConstraints(providerId: string): ProviderConstraints {
  if (!providerId) return NO_SUPPORT;

  const exact = PROVIDER_CONSTRAINTS[providerId];
  if (exact) return exact;

  // Vercel Gateway with Claude models gets Anthropic-level support
  if (providerId === "vercel_gateway") return PROVIDER_CONSTRAINTS.anthropic as ProviderConstraints;

  return NO_SUPPORT;
}

interface EffectiveCaps extends ModelCapabilities {
  anthropicOptions: boolean;
  openaiOptions: boolean;
}

function getEffectiveCaps(modelId: string): EffectiveCaps {
  const model = getModelCapabilities(modelId);
  const { provider } = parseModelId(modelId);
  const pc = getProviderConstraints(provider);
  const family = detectModelFamily(modelId);

  return {
    ...model,
    anthropicOptions: pc.anthropicOptions && family === "claude",
    openaiOptions: pc.openaiOptions && family === "openai",
    adaptiveThinking: model.adaptiveThinking && pc.adaptiveThinking,
    effort: model.effort && pc.effort,
    speed: model.speed && pc.speed,
    contextManagement: model.contextManagement && pc.contextManagement,
    interleavedThinking: model.interleavedThinking && pc.interleavedThinking,
  };
}

export function isAnthropicNative(modelId: string): boolean {
  return detectModelFamily(modelId) === "claude";
}

/** Extract model ID string from a LanguageModel (object with .modelId) or pass-through strings. */
export function getModelId(model: unknown): string {
  if (typeof model === "string") return model;
  if (typeof model === "object" && model !== null && "modelId" in model) {
    return String((model as { modelId: unknown }).modelId);
  }
  return "";
}

/** Parse opus major/minor version from a base model ID. Returns null if not an Opus model. */
function parseOpusVersion(base: string): { major: number; minor: number } | null {
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

export function getSupportedClaudeEfforts(modelId: string): EffortLevel[] | null {
  const base = extractBaseModel(modelId);
  if (!base.startsWith("claude")) return null;

  // Haiku does not support the effort parameter — Anthropic API rejects it.
  if (base.includes("haiku")) return null;

  // Opus 4.7+: full range
  const v = parseOpusVersion(base);
  if (v && (v.major >= 5 || (v.major === 4 && v.minor >= 7))) {
    return ["max", "xhigh", "high", "medium", "low"];
  }

  // Opus 4.6 and Sonnet 4.6: max but NOT xhigh
  if (
    base.includes("opus-4-6") ||
    base.includes("opus-4.6") ||
    base.includes("sonnet-4-6") ||
    base.includes("sonnet-4.6")
  ) {
    return ["max", "high", "medium", "low"];
  }

  // Opus 4.5: up to high only
  if (base.includes("opus-4-5") || base.includes("opus-4.5")) {
    return ["high", "medium", "low"];
  }

  // Other Claude 4+ models with effort capability
  return ["high", "medium", "low"];
}

/** Clamp an effort value to the nearest supported level (descending). Returns null if the model has no effort support. */
export function clampEffort(modelId: string, effort: EffortLevel): EffortLevel | null {
  const supported = getSupportedClaudeEfforts(modelId);
  if (!supported) return null;
  if (supported.includes(effort)) return effort;
  // Walk down from the requested level until we find a supported one.
  const order: EffortLevel[] = ["max", "xhigh", "high", "medium", "low"];
  const requestedIdx = order.indexOf(effort);
  for (let i = requestedIdx; i < order.length; i++) {
    const level = order[i];
    if (level && supported.includes(level)) return level;
  }
  return supported[supported.length - 1] ?? null;
}

/** Programmatic tool calling (allowedCallers) requires Claude 4+ non-haiku. */
export function supportsProgrammaticToolCalling(modelId: string): boolean {
  const base = extractBaseModel(modelId);
  const gen = getClaudeGen(base);
  if (gen !== "4+") return false;
  return !base.includes("haiku");
}

/** Resolve which Anthropic server tool versions a model supports.
 *  Based on https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference */
export function getAnthropicToolVersions(modelId: string): {
  /** computer_20251124 (zoom) vs 20250124 vs null */
  computerUse: "20251124" | "20250124" | null;
  /** text_editor_20250728 (Claude 4) vs 20250124 (3.7) vs null */
  textEditor: "20250728" | "20250124" | null;
  /** Whether allowed_callers / programmatic tool calling is supported */
  programmaticToolCalling: boolean;
} {
  const base = extractBaseModel(modelId);
  const gen = getClaudeGen(base);
  const family = detectModelFamily(modelId);

  if (family !== "claude") {
    return {
      computerUse: null,
      textEditor: null,
      programmaticToolCalling: false,
    };
  }

  const isHaiku = base.includes("haiku");
  const is46 =
    base.includes("opus-4-6") ||
    base.includes("sonnet-4-6") ||
    base.includes("claude-opus-4-6") ||
    base.includes("claude-sonnet-4-6");
  const isOpus45 = base.includes("opus-4-5") || base.includes("opus-4.5");

  // Programmatic tool calling: Claude 4+ non-Haiku
  const programmaticToolCalling = gen === "4+" && !isHaiku;

  // Computer use: 20251124 for Opus 4.6, Sonnet 4.6, Opus 4.5; 20250124 for other Claude 4+/3.5
  let computerUse: "20251124" | "20250124" | null = null;
  if (is46 || isOpus45) {
    computerUse = "20251124";
  } else if (gen === "4+" || gen === "3.5") {
    computerUse = "20250124";
  }

  // Text editor: 20250728 for Claude 4, 20250124 for 3.5/3.7
  let textEditor: "20250728" | "20250124" | null = null;
  if (gen === "4+") {
    textEditor = "20250728";
  } else if (gen === "3.5") {
    textEditor = "20250124";
  }

  return { computerUse, textEditor, programmaticToolCalling };
}

function supportsAnthropicOptions(modelId: string): boolean {
  return getEffectiveCaps(modelId).anthropicOptions;
}

function buildContextEdits(
  config: ContextManagementConfig | undefined,
  contextWindow: number,
  thinkingEnabled: boolean,
): unknown[] | null {
  const edits: unknown[] = [];

  // Default: preserve all thinking blocks for maximum cache hits.
  // Clearing thinking busts the prompt cache at the clearing point.
  // With keep: "all", thinking stays in context and the prefix stays stable.
  // The API default (without this edit) only keeps the last 1 turn — sending
  // keep: "all" explicitly overrides that to preserve the full prefix.
  if (config?.clearThinking !== false && thinkingEnabled) {
    edits.push({
      type: "clear_thinking_20251015",
      keep: "all",
    });
  }

  // Opt-in: clear old tool uses server-side. Off by default because it busts
  // the prompt cache every time it fires. Only enable for very long sessions
  // where context pressure outweighs cache savings.
  if (config?.clearToolUses === true) {
    // Trigger late — 65% of window, minimum 120k. Most conversations never hit this.
    const clearTrigger = Math.max(120_000, Math.floor(contextWindow * 0.65));
    // When we do bust cache, clear at least 40k tokens to make it worthwhile.
    const clearAtLeast = Math.max(40_000, Math.floor(contextWindow * 0.2));
    edits.push({
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: clearTrigger },
      keep: { type: "tool_uses", value: 5 },
      clearToolInputs: true,
      clearAtLeast: { type: "input_tokens", value: clearAtLeast },
    });
  }

  // Server-side compaction (Anthropic): opt-in via config (disabled by default).
  // Summarizes older context when approaching context limit. Uses pause_after_compaction
  // so we can inject plan state / working context after the summary.
  if (config?.compact && contextWindow >= 200_000) {
    // Trigger at 80% of context window — late enough to maximize usable context,
    // early enough to leave room for the summary + continued work.
    // Minimum 160k tokens to avoid triggering on small context windows.
    const trigger = Math.max(160_000, Math.floor(contextWindow * 0.8));
    edits.push({
      type: "compact_20260112",
      trigger: { type: "input_tokens", value: trigger },
      instructions: [
        "Write a concise summary of the conversation so far.",
        "Focus on: files modified, key decisions made, current task progress, and next steps.",
        "Preserve exact file paths, function names, and error messages.",
        "Do NOT list what you plan to do — only what has already been done and what remains.",
        "Do NOT dump internal state or repeat tool outputs.",
        "Keep the summary under 2000 tokens.",
        "Wrap in <summary></summary> tags.",
      ].join("\n"),
    });
  }

  return edits.length > 0 ? edits : null;
}

//
// Ephemeral cache breakpoints for prompt caching. Set on all provider keys
// so caching works regardless of which provider routes to Anthropic/Claude.
// The Vercel AI SDK silently ignores keys that don't match the active provider.

const CACHE_EPHEMERAL = { cacheControl: { type: "ephemeral" } } as const;

export const EPHEMERAL_CACHE: ProviderOptions = {
  anthropic: CACHE_EPHEMERAL,
  google: CACHE_EPHEMERAL,
  proxy: CACHE_EPHEMERAL,
  llmgateway: CACHE_EPHEMERAL,
  opencode_zen: CACHE_EPHEMERAL,
  opencode_go: CACHE_EPHEMERAL,
  openrouter: CACHE_EPHEMERAL,
  vercel_gateway: CACHE_EPHEMERAL,
} as ProviderOptions;

export interface ProviderOptionsResult {
  providerOptions: ProviderOptions;
  headers: Record<string, string> | undefined;
  /** Accurate context window (tokens) for the model — fetched from provider/OpenRouter cache. */
  contextWindow: number;
}

async function buildAnthropicOptions(
  modelId: string,
  caps: EffectiveCaps,
  config: AppConfig,
): Promise<{
  opts: Record<string, unknown>;
  headers: Record<string, string>;
  thinkingEnabled: boolean;
}> {
  // biome-ignore lint/suspicious/noExplicitAny: ProviderOptions inner shape is parsed by Zod at runtime
  const opts: Record<string, any> = {};
  const headers: Record<string, string> = {};
  let thinkingEnabled = false;

  if (caps.thinking) {
    const mode = config.thinking?.mode ?? "off";
    if (mode === "auto" || mode === "adaptive") {
      if (caps.adaptiveThinking) {
        opts.thinking = { type: "adaptive" };
        thinkingEnabled = true;
      }
    } else if (mode === "enabled") {
      opts.thinking = {
        type: "enabled",
        ...(config.thinking?.budgetTokens ? { budgetTokens: config.thinking.budgetTokens } : {}),
      };
      thinkingEnabled = true;
    }
  }

  if (caps.effort && config.performance?.effort && config.performance.effort !== "off") {
    const clamped = clampEffort(modelId, config.performance.effort);
    if (clamped) opts.effort = clamped;
  }

  if (caps.speed && config.performance?.speed && config.performance.speed !== "off") {
    opts.speed = config.performance.speed;
  }

  if (config.performance?.toolStreaming === false) {
    opts.toolStreaming = false;
  }

  if (config.performance?.disableParallelToolUse) {
    opts.disableParallelToolUse = true;
  }

  if (config.performance?.sendReasoning === false) {
    opts.sendReasoning = false;
  }

  if (caps.contextManagement) {
    const contextWindow = await getModelContextWindow(modelId);
    const edits = buildContextEdits(config.contextManagement, contextWindow, thinkingEnabled);
    if (edits) {
      opts.contextManagement = { edits };
    }
  }

  if (thinkingEnabled && caps.interleavedThinking) {
    headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  }

  return { opts, headers, thinkingEnabled };
}

function buildOpenAIOptions(
  caps: EffectiveCaps,
  config: AppConfig,
): { opts: Record<string, unknown> } {
  // biome-ignore lint/suspicious/noExplicitAny: ProviderOptions inner shape is parsed by Zod at runtime
  const opts: Record<string, any> = {};

  if (caps.openaiReasoning) {
    const effort = config.performance?.openaiReasoningEffort;
    if (effort && effort !== "off") {
      opts.reasoningEffort = effort;
    }
  }

  if (caps.openaiServiceTier) {
    const tier = config.performance?.serviceTier;
    if (tier && tier !== "off") {
      opts.serviceTier = tier;
    }
  }

  if (config.performance?.disableParallelToolUse) {
    opts.parallelToolCalls = false;
  }

  return { opts };
}

export async function buildProviderOptions(
  modelId: string,
  config: AppConfig,
): Promise<ProviderOptionsResult> {
  const caps = getEffectiveCaps(modelId);
  const providerOptions: Record<string, unknown> = {};
  let headers: Record<string, string> = {};

  // Fetch accurate context window (triggers metadata fetch if cache empty)
  const contextWindow = await getModelContextWindow(modelId);

  if (caps.anthropicOptions) {
    const result = await buildAnthropicOptions(modelId, caps, config);
    if (Object.keys(result.opts).length > 0) {
      providerOptions.anthropic = result.opts;
    }
    headers = result.headers;
  }

  if (caps.openaiOptions) {
    const result = buildOpenAIOptions(caps, config);
    if (Object.keys(result.opts).length > 0) {
      providerOptions.openai = result.opts;
    }
  }

  // Custom provider reasoning params — injected for any custom provider
  // that declares a reasoning config. The actual body injection is handled
  // by the custom provider's fetch wrapper, but we also surface the params
  // here for logging, degradation, and future extensibility.
  const { provider } = parseModelId(modelId);
  const customProvider = provider ? getProvider(provider) : null;
  if (customProvider?.custom && customProvider.customReasoning) {
    const r = customProvider.customReasoning;
    const customOpts: Record<string, unknown> = {};
    if (r.effort) {
      customOpts.effort = r.effort;
    }
    if (r.enabled !== undefined) {
      customOpts.enabled = r.enabled;
    }
    if (r.budget !== undefined) {
      customOpts.budget = r.budget;
    }
    if (r.extraParams) {
      customOpts.extraParams = r.extraParams;
    }
    if (Object.keys(customOpts).length > 0) {
      providerOptions.custom = customOpts;
    }
  }

  return {
    providerOptions: providerOptions as ProviderOptions,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    contextWindow,
  };
}

export function degradeProviderOptions(modelId: string, level: number): ProviderOptionsResult {
  if (level >= 2 || !supportsAnthropicOptions(modelId)) {
    return { providerOptions: {}, headers: undefined, contextWindow: 0 };
  }

  const caps = getModelCapabilities(modelId);
  // biome-ignore lint/suspicious/noExplicitAny: ProviderOptions inner shape is parsed by Zod at runtime
  const opts: Record<string, any> = {};

  if (caps.thinking) {
    opts.thinking = { type: "enabled", budgetTokens: 5_000 };
  }

  return {
    providerOptions: { anthropic: opts } as ProviderOptions,
    headers: undefined,
    contextWindow: 0,
  };
}

export function isProviderOptionsError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("not supported") ||
    lower.includes("not available") ||
    lower.includes("does not support") ||
    lower.includes("invalid parameter") ||
    lower.includes("inputschema") ||
    lower.includes("thinking is not supported") ||
    lower.includes("adaptive thinking") ||
    lower.includes("clear_thinking") ||
    lower.includes("context management") ||
    lower.includes("unknown parameter") ||
    lower.includes("temperature is deprecated")
  );
}
