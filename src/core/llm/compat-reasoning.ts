/** Standalone OpenAI-compatible reasoning body builder.
 *  Lives in its own file (no provider-registry imports) to break the cycle:
 *    providers/<x>.ts → provider-options.ts → providers/index.ts → providers/<x>.ts
 *  Each provider's createModel imports from here directly. */

import type { AppConfig } from "../../types/index.js";
import { isAdaptiveOnly } from "./model-id.js";

function parseProvider(modelId: string): { provider: string; model: string } {
  const slash = modelId.indexOf("/");
  if (slash === -1) return { provider: "", model: modelId };
  return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

function baseModel(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();
}

const COMPAT_PROVIDERS = new Set([
  "deepseek",
  "groq",
  "fireworks",
  "minimax",
  "zai",
  "copilot",
  "github-models",
  "opencode-go",
  "opencode-zen",
  "lmstudio",
  "ollama",
  "proxy",
  "llmgateway",
]);

export function getCompatReasoningBody(
  modelId: string,
  config: AppConfig,
): Record<string, unknown> {
  const { provider } = parseProvider(modelId);
  if (!COMPAT_PROVIDERS.has(provider)) return {};

  const base = baseModel(modelId);

  let effort: "low" | "medium" | "high" | "xhigh" | "max" | "off" | undefined =
    config.performance?.compatReasoningEffort;

  // DeepSeek V4 takes a dedicated knob and accepts only high|max natively.
  // Only a real level overrides — "off"/unset falls through to the shared knobs.
  if (provider === "deepseek") {
    const d = config.performance?.deepseekReasoningEffort;
    if (d && d !== "off") effort = d;
  }

  if (provider === "groq") {
    const g = config.performance?.groqReasoningEffort;
    if (g) effort = g === "off" ? "off" : g;
  }

  if (!effort || effort === "off") {
    const e = config.performance?.effort;
    if (e && e !== "off") {
      // DeepSeek understands "max" directly; other compat providers cap at "xhigh".
      effort = e === "max" && provider !== "deepseek" ? "xhigh" : e;
    }
  }

  if (!effort || effort === "off") return {};

  // DeepSeek's API enum is strictly high|max. Fold the generic ladder down.
  if (provider === "deepseek") {
    const dsEffort = effort === "max" || effort === "xhigh" ? "max" : "high";
    return { reasoning_effort: dsEffort };
  }

  const isClaude = base.startsWith("claude");

  // Claude on opencode-zen — emit Anthropic-shape thinking body.
  // Zen's normaliser forwards the OpenAI-compat /v1/chat/completions request
  // to upstream Anthropic which expects { thinking: { type, budget_tokens } }.
  if (isClaude && provider === "opencode-zen") {
    // Opus 4.7+ only supports adaptive thinking — type:"enabled" returns 400.
    if (isAdaptiveOnly(base)) {
      return { thinking: { type: "adaptive" } };
    }
    const explicitBudget = config.thinking?.budgetTokens;
    const budget =
      explicitBudget ??
      { low: 2048, medium: 5000, high: 10000, xhigh: 20000, max: 32000 }[effort] ??
      5000;
    return { thinking: { type: "enabled", budget_tokens: budget } };
  }

  // Other gateways routing Claude through OpenAI-compat: skip — the upstream
  // rejects reasoning_effort and we have no way to emit Anthropic shape.
  if (isClaude && provider !== "proxy") {
    return {};
  }

  // Groq Qwen3 uses { none | default }, not low/medium/high (Groq docs, May 2026).
  // GPT-OSS on Groq uses low/medium/high. Default to the model's expected shape.
  if (provider === "groq" && /qwen3/.test(base)) {
    return { reasoning_effort: "default" };
  }

  const isDashscope = /qwen|glm-|kimi-/.test(base);

  // LLM Gateway is strict: it rejects requests carrying both reasoning_effort
  // and reasoning.effort ("Use one or the other"). Emit the single canonical key.
  if (provider === "llmgateway") {
    const body: Record<string, unknown> = { reasoning_effort: effort };
    if (isDashscope) body.enable_thinking = true;
    return body;
  }

  const body: Record<string, unknown> = {
    reasoning_effort: effort,
    reasoning: { effort },
  };
  if (isDashscope) body.enable_thinking = true;
  return body;
}
