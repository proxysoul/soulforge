import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { loadConfig } from "../../../config/index.js";
import { getProviderApiKey } from "../../secrets.js";
import { getCompatReasoningBody } from "../compat-reasoning.js";
import { SHARED_CONTEXT_WINDOWS } from "./context-windows.js";
import { createSessionFetchWrapper } from "./reasoning-fetch.js";
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
    const reasoningFetch = createSessionFetchWrapper(reasoningBody);
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

  // Offline fallback only — the live list comes from fetchModels()
  // (https://opencode.ai/zen/v1/models). Keep this short; it just needs to
  // populate the selector when there's no key/network.
  fallbackModels: [
    { id: "gpt-5.5", name: "GPT 5.5" },
    { id: "gpt-5.4", name: "GPT 5.4" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "minimax-m3", name: "MiniMax M3" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "qwen3.7-max", name: "Qwen3.7 Max" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "grok-build-0.1", name: "Grok Build 0.1" },
  ],

  // Only IDs the shared table can't infer. GPT/Claude/Gemini/GLM/Qwen base
  // patterns resolve via SHARED_CONTEXT_WINDOWS; list the Zen-specific outliers.
  contextWindows: [
    ...SHARED_CONTEXT_WINDOWS,
    // GPT on Zen — larger than the shared gpt-4 defaults
    ["gpt-5.5", 1_050_000],
    ["gpt-5.4", 1_050_000],
    ["gpt-5", 400_000],
    // Claude hyphen-style IDs Zen returns (shared table is generic "claude" 200k)
    ["claude-opus-4-8", 1_000_000],
    ["claude-opus-4-7", 1_000_000],
    ["claude-opus-4-6", 1_000_000],
    ["claude-sonnet-4-6", 1_000_000],
    ["claude-sonnet-4-5", 1_000_000],
    // MiniMax / Kimi / MiMo / Nemotron — no shared pattern
    ["minimax-m3", 196_000],
    ["minimax-m2", 196_000],
    ["kimi-k2", 262_000],
    ["mimo-v2", 262_144],
    ["nemotron-3", 262_000],
    ["grok-build", 256_000],
    ["big-pickle", 200_000],
    ["deepseek-v4", 131_072],
  ],
};
