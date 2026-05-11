/**
 * Embedder resolution — pick the right embedding model for the current
 * provider + config + task router state, with safe fallback to hashbag-v2.
 *
 * Pipeline:
 *   1. config.memory.embeddingModel       (explicit user override)
 *   2. config.taskRouter.semantic         (reuse the existing semantic slot)
 *   3. heuristic from active chat model's provider
 *   4. null → hashbag-v2
 *
 * Failures NEVER throw. Every error returns null, which the caller treats
 * as "stay on hashbag-v2". This module is pure — no I/O, no side effects.
 */

import type { AppConfig } from "../../types/index.js";

export interface EmbedderResolution {
  /** AI SDK model id ("provider/model"), or null when no provider embedder applies. */
  modelId: string | null;
  /** Where the choice came from — surfaced in audit/logs. */
  source: "explicit" | "task-router" | "heuristic" | "none";
  /** Human-readable reason, used by logBackgroundError on failure. */
  reason: string;
}

/**
 * Provider → known embedding model map. Conservative — only entries we
 * have actually verified work via Vercel AI SDK 6's `embed()` call.
 * Anthropic has no embedding API; proxy is anthropic-chat-only; codex,
 * copilot, ollama-with-no-embedder all return null and fall back to hashbag.
 */
const PROVIDER_DEFAULTS: Readonly<Record<string, string | null>> = {
  openai: "openai/text-embedding-3-small",
  google: "google/text-embedding-004",
  // Gateways forward to OpenAI's embedding model — these are verified routes.
  vercel_gateway: "vercel_gateway/openai/text-embedding-3-small",
  llmgateway: "llmgateway/openai/text-embedding-3-small",
  openrouter: "openrouter/openai/text-embedding-3-small",
  // No embedding API on these providers — fall back to hashbag.
  anthropic: null,
  proxy: null,
  xai: null,
  codex: null,
  copilot: null,
  groq: null,
  fireworks: null,
  deepseek: null,
  mistral: null,
  minimax: null,
  bedrock: null,
  // Local providers: user must opt-in explicitly (different models per install).
  ollama: null,
  lmstudio: null,
  "opencode-go": null,
  "opencode-zen": null,
  "github-models": null,
};

function extractProviderId(modelId: string): string {
  if (!modelId) return "";
  const slashIdx = modelId.indexOf("/");
  return slashIdx >= 0 ? modelId.slice(0, slashIdx) : "";
}

/**
 * Resolve which embedding model to use. Pure function — never throws.
 *
 * @param config Full AppConfig.
 * @param activeModelId The chat model currently in use ("provider/model").
 *                      May be "none" or empty during boot — handled.
 */
export function resolveEmbeddingModel(
  config: AppConfig | null | undefined,
  activeModelId: string | null | undefined,
): EmbedderResolution {
  // 1. Explicit override always wins.
  const explicit = config?.memory?.embeddingModel;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return {
      modelId: explicit.trim(),
      source: "explicit",
      reason: "config.memory.embeddingModel",
    };
  }
  // Explicit null disables the provider embedder entirely.
  if (explicit === null) {
    return { modelId: null, source: "none", reason: "explicitly disabled via config" };
  }

  // 2. Reuse the existing taskRouter.semantic slot — same model already
  // selected by user for semantic summaries.
  const semantic = config?.taskRouter?.semantic;
  if (typeof semantic === "string" && semantic.trim().length > 0) {
    return {
      modelId: semantic.trim(),
      source: "task-router",
      reason: "taskRouter.semantic",
    };
  }

  // 3. Heuristic from active provider.
  const provider = extractProviderId(activeModelId ?? "");
  if (!provider || provider === "none") {
    return { modelId: null, source: "none", reason: "no active provider" };
  }
  if (provider in PROVIDER_DEFAULTS) {
    const def = PROVIDER_DEFAULTS[provider];
    if (def) {
      return { modelId: def, source: "heuristic", reason: `default for ${provider}` };
    }
    return {
      modelId: null,
      source: "none",
      reason: `provider ${provider} has no embedding API; using hashbag-v2`,
    };
  }

  // Unknown provider (custom OpenAI-compatible) — default to no embedder,
  // user can set memory.embeddingModel explicitly.
  return {
    modelId: null,
    source: "none",
    reason: `unknown provider ${provider}; set config.memory.embeddingModel to enable`,
  };
}
