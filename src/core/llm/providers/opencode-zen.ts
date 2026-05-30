import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { loadConfig } from "../../../config/index.js";
import { getProviderApiKey } from "../../secrets.js";
import { getCompatReasoningBody } from "../compat-reasoning.js";
import { SHARED_CONTEXT_WINDOWS } from "./context-windows.js";
import { createReasoningFetchWrapper } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

const BASE_URL = "https://opencode.ai/zen/v1";

export const opencodeZen: ProviderDefinition = {
  id: "opencode-zen",
  name: "OpenCode Zen",
  envVar: "OPENCODE_ZEN_API_KEY",
  icon: "\uE795", // nf-dev-zen U+E795
  secretKey: "opencode-zen-api-key",
  keyUrl: "opencode.ai",
  asciiIcon: "Z",
  description: "GPT, Claude, Gemini, MiniMax, GLM, Kimi, Qwen, Nemotron models",
  grouped: true,

  createModel(modelId: string): LanguageModel {
    const apiKey = getProviderApiKey("OPENCODE_ZEN_API_KEY");
    if (!apiKey) {
      throw new Error("OPENCODE_ZEN_API_KEY is not set");
    }
    // Use @ai-sdk/openai-compatible to properly handle reasoning_content
    // Fixes 400 error: "thinking is enabled but reasoning_content is missing"
    const reasoningBody = getCompatReasoningBody(`opencode-zen/${modelId}`, loadConfig());
    const reasoningFetch = createReasoningFetchWrapper(reasoningBody);
    const provider = createOpenAICompatible({
      name: "opencode-zen",
      baseURL: BASE_URL,
      apiKey,
      ...(reasoningFetch ? { fetch: reasoningFetch as typeof fetch } : {}),
    });
    return provider.chatModel(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey("OPENCODE_ZEN_API_KEY");
    if (!apiKey) return null;
    try {
      const res = await fetch("https://opencode.ai/zen/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { data: Array<{ id: string }> };
      return data.data.map((m) => ({ id: m.id, name: m.id }));
    } catch {
      return null;
    }
  },

  // model list from https://opencode.ai/zen/v1/models (live API)
  fallbackModels: [
    { id: "gpt-5.5-pro", name: "GPT 5.5 Pro" },
    { id: "gpt-5.5", name: "GPT 5.5" },
    { id: "gpt-5.4-pro", name: "GPT 5.4 Pro" },
    { id: "gpt-5.4", name: "GPT 5.4" },
    { id: "gpt-5.4-mini", name: "GPT 5.4 Mini" },
    { id: "gpt-5.4-nano", name: "GPT 5.4 Nano" },
    { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    { id: "gpt-5.3-codex-spark", name: "GPT 5.3 Codex Spark" },
    { id: "gpt-5.2", name: "GPT 5.2" },
    { id: "gpt-5.2-codex", name: "GPT 5.2 Codex" },
    { id: "gpt-5.1", name: "GPT 5.1" },
    { id: "gpt-5.1-codex", name: "GPT 5.1 Codex" },
    { id: "gpt-5.1-codex-max", name: "GPT 5.1 Codex Max" },
    { id: "gpt-5.1-codex-mini", name: "GPT 5.1 Codex Mini" },
    { id: "gpt-5", name: "GPT 5" },
    { id: "gpt-5-codex", name: "GPT 5 Codex" },
    { id: "gpt-5-nano", name: "GPT 5 Nano" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "minimax-m2.7", name: "MiniMax M2.7" },
    { id: "minimax-m2.5", name: "MiniMax M2.5" },
    { id: "minimax-m2.5-free", name: "MiniMax M2.5 Free" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5", name: "GLM 5" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash Free" },
    { id: "qwen3.6-plus", name: "Qwen3.6 Plus" },
    { id: "qwen3.5-plus", name: "Qwen3.5 Plus" },
    { id: "big-pickle", name: "Big Pickle" },
    { id: "nemotron-3-super-free", name: "Nemotron 3 Super Free" },
    { id: "ring-2.6-1t-free", name: "Ring 2.6 1T Free" },
    { id: "trinity-large-preview-free", name: "Trinity Large Preview Free" },
  ],

  contextWindows: [
    ...SHARED_CONTEXT_WINDOWS,
    // GPT
    ["gpt-5.5-pro", 1_050_000],
    ["gpt-5.5", 1_050_000],
    ["gpt-5.4", 1_050_000],
    ["gpt-5.4-pro", 1_050_000],
    ["gpt-5.4-mini", 400_000],
    ["gpt-5.4-nano", 400_000],
    ["gpt-5.3-codex", 400_000],
    ["gpt-5.3-codex-spark", 400_000],
    ["gpt-5.2", 400_000],
    ["gpt-5.2-codex", 400_000],
    ["gpt-5.1", 400_000],
    ["gpt-5.1-codex", 400_000],
    ["gpt-5.1-codex-max", 400_000],
    ["gpt-5.1-codex-mini", 400_000],
    ["gpt-5", 400_000],
    ["gpt-5-codex", 400_000],
    ["gpt-5-nano", 400_000],
    ["gpt-5.4-pro", 1_050_000],
    ["gpt-5.4-mini", 400_000],
    ["gpt-5.4-nano", 400_000],
    ["gpt-5.3-codex", 400_000],
    ["gpt-5.3-codex-spark", 400_000],
    ["gpt-5.2", 400_000],
    ["gpt-5.2-codex", 400_000],
    ["gpt-5.1", 400_000],
    ["gpt-5.1-codex", 400_000],
    ["gpt-5.1-codex-max", 400_000],
    ["gpt-5.1-codex-mini", 400_000],
    ["gpt-5", 400_000],
    ["gpt-5-codex", 400_000],
    ["gpt-5-nano", 400_000],
    // Claude (hyphen-style on Zen)
    ["claude-opus-4-8", 1_000_000],
    ["claude-opus-4-7", 1_000_000],
    ["claude-opus-4-6", 1_000_000],
    ["claude-opus-4-5", 200_000],
    ["claude-opus-4-1", 200_000],
    ["claude-sonnet-4-6", 1_000_000],
    ["claude-sonnet-4-5", 1_000_000],
    ["claude-sonnet-4", 200_000],
    ["claude-haiku-4-5", 200_000],
    // also tolerate dot-style if returned
    ["claude-opus-4.8", 1_000_000],
    ["claude-opus-4.6", 1_000_000],
    ["claude-sonnet-4.6", 1_000_000],
    ["claude-sonnet-4.5", 1_000_000],
    ["claude-sonnet-4.6", 1_000_000],
    ["claude-sonnet-4.5", 200_000],
    // MiniMax
    ["minimax-m2.5", 196_000],
    ["minimax-m2.5-free", 196_000],
    // Kimi
    ["kimi-k2.5", 262_000],
    // Gemini
    ["gemini-3.1-pro", 1_048_576],
    ["gemini-3-flash", 1_048_576],
    // Qwen
    ["qwen3.6-plus", 1_000_000],
    ["qwen3.5-plus", 1_000_000],
    // DeepSeek
    ["deepseek-v4-flash-free", 131_072],
    // Other models
    ["big-pickle", 200_000],
    ["nemotron-3-super-free", 262_000],
    ["ring-2.6-1t-free", 131_072],
    ["trinity-large-preview-free", 262_144],
  ],
};
