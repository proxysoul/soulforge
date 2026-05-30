import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { getProviderApiKey } from "../../secrets.js";
import { SHARED_CONTEXT_WINDOWS } from "./context-windows.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

export const openrouter: ProviderDefinition = {
  id: "openrouter",
  name: "OpenRouter",
  envVar: "OPENROUTER_API_KEY",
  icon: "\uF0AC", // nf-fa-globe U+F0AC
  secretKey: "openrouter-api-key",
  keyUrl: "openrouter.ai",
  asciiIcon: "⊕",
  description: "Multi-provider router",
  grouped: true,

  createModel(modelId: string) {
    const apiKey = getProviderApiKey("OPENROUTER_API_KEY");
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set");
    }
    const provider = createOpenRouter({ apiKey });
    return provider(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    return null; // grouped provider — uses fetchGroupedModels instead
  },

  fallbackModels: [
    { id: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6" },
    { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5" },
    { id: "openai/gpt-5.5", name: "GPT-5.5" },
    { id: "openai/gpt-5.4", name: "GPT-5.4" },
    { id: "openai/gpt-5.4-mini", name: "GPT-5.4 Mini" },
    { id: "openai/gpt-5.1-codex", name: "GPT-5.1 Codex" },
    { id: "openai/gpt-5", name: "GPT-5" },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
    { id: "google/gemini-3-flash-preview", name: "Gemini 3 Flash" },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "x-ai/grok-4.3", name: "Grok 4.3" },
    { id: "x-ai/grok-4.20", name: "Grok 4.20" },
    { id: "x-ai/grok-4", name: "Grok 4" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "z-ai/glm-5", name: "GLM 5" },
    { id: "z-ai/glm-4.7", name: "GLM 4.7" },
    { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick" },
    { id: "qwen/qwen3-coder", name: "Qwen 3 Coder" },
  ],

  // Corrections for known-incorrect upstream API values.
  contextWindowOverrides: [
    // OpenRouter lists GLM-5 as 80k — actual is ~200k (docs.z.ai)
    ["glm-5.1", 204_800],
    ["glm-5-turbo", 202_752],
    ["glm-5", 204_800],
    ["glm-4.7", 200_000],
    ["glm-4.6", 200_000],
    ["glm-4.5", 128_000],
    ["glm-4", 128_000],
  ],

  // Specific overrides first → shared patterns → generic catch-alls last.
  // Specific overrides must NOT be substrings of shared patterns (ordering matters).
  contextWindows: [
    // Claude (OpenRouter uses dots: claude-opus-4.6)
    ["claude-opus-4.8", 1_000_000],
    ["claude-opus-4.7", 1_000_000],
    ["claude-opus-4.6", 1_000_000],
    ["claude-sonnet-4.6", 1_000_000],
    ["claude-sonnet-4.5", 1_000_000],
    ["claude-opus-4.5", 200_000],
    ["claude-haiku-4.5", 200_000],
    ["claude-sonnet-4", 200_000],
    ["claude-opus-4", 200_000],
    ["claude-3.7-sonnet", 200_000],
    ["claude-3.5-sonnet", 200_000],
    ["claude-3.5-haiku", 200_000],
    // GPT
    ["gpt-5-chat", 128_000],
    ["gpt-5.4-mini", 400_000],
    ["gpt-5.4-nano", 400_000],
    ["gpt-4.1", 1_047_576],
    ["gpt-4-0314", 8_191],
    // Grok (OpenRouter dot-style: grok-4.1, grok-4.20)
    ["grok-4.1", 2_000_000],
    ["grok-4.20", 2_000_000],
    // Llama
    ["llama-4-scout", 327_680],
    ["llama-3.2", 131_072],
    ["llama-3.1", 131_072],
    // Qwen — specific variants before shared, generic after
    ["qwen3.5-flash", 1_000_000],
    ["qwen3.5-plus", 1_000_000],
    ["qwen-plus", 1_000_000],
    // Mistral — specific before shared
    ["mistral-large-2512", 262_144],
    ["mistral-small-2603", 262_144],
    ["mistral-small-3.1", 131_072],
    ["mistral-small-3.2", 128_000],
    // Shared patterns (qwen3-coder-flash, qwen3-max, etc)
    ...SHARED_CONTEXT_WINDOWS,
    // Generic catch-alls AFTER shared
    ["gpt-5.4", 1_050_000],
    ["gpt-5", 400_000],
    ["gpt-4", 8_191],
    ["qwen3.5", 262_144],
    ["qwen3", 40_960],
    ["qwen-turbo", 131_072],
    ["qwen2.5", 32_768],
    ["qwen", 32_768],
    ["mistral-large", 128_000],
    ["mistral-medium", 131_072],
    ["mistral-small", 32_768],
    ["mistral", 128_000],
    ["gemma-3", 131_072],
    ["gemma", 128_000],
    ["sonar-pro", 200_000],
    ["sonar", 128_000],
    ["kimi", 131_072],
    ["grok", 131_072],
    ["llama", 131_072],
  ],
};
