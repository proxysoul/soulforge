import { createLLMGateway } from "@llmgateway/ai-sdk-provider";
import { getProviderApiKey } from "../../secrets.js";
import { SHARED_CONTEXT_WINDOWS } from "./context-windows.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

export const llmgateway: ProviderDefinition = {
  id: "llmgateway",
  name: "LLM Gateway",
  envVar: "LLM_GATEWAY_API_KEY",
  icon: "󰒍", // nf-md-cloud_sync U+F048D
  secretKey: "llmgateway-api-key",
  keyUrl: "llmgateway.io/dashboard",
  asciiIcon: "☁",
  description: "All models, one key",
  grouped: true,

  createModel(modelId) {
    const apiKey = getProviderApiKey("LLM_GATEWAY_API_KEY");
    if (!apiKey) {
      throw new Error("LLM_GATEWAY_API_KEY is not set");
    }

    const provider = createLLMGateway({ apiKey, headers: { "X-Source": "soulforge" } });

    // LLMGatewayChatModelId is a union of literal model IDs, not exported.
    // We accept arbitrary model IDs at runtime so cast is needed.
    // biome-ignore lint/suspicious/noExplicitAny: model ID union not exported from SDK
    return provider.chat(modelId as any);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    return null; // grouped provider — uses fetchGroupedModels instead
  },

  fallbackModels: [
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
    { id: "gpt-5", name: "GPT-5" },
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "grok-4.3", name: "Grok 4.3" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  ],

  // Corrections for known-incorrect upstream API values.
  contextWindowOverrides: [
    ["glm-5.1", 204_800],
    ["glm-5-turbo", 202_752],
    ["glm-5", 204_800],
    ["glm-4.7", 200_000],
    ["glm-4.6", 200_000],
    ["glm-4.5", 128_000],
    ["glm-4", 128_000],
  ],

  // Specific overrides first → shared patterns → generic catch-alls last.
  contextWindows: [
    // Claude (LLM Gateway uses hyphens: claude-opus-4-6)
    ["claude-opus-4-8", 1_000_000],
    ["claude-opus-4-7", 1_000_000],
    ["claude-opus-4-6", 1_000_000],
    ["claude-sonnet-4-6", 200_000],
    ["claude-sonnet-4-5", 200_000],
    ["claude-opus-4-5", 200_000],
    ["claude-haiku-4-5", 200_000],
    ["claude-sonnet-4", 200_000],
    ["claude-opus-4", 200_000],
    ["claude-3-7-sonnet", 200_000],
    ["claude-3-5-sonnet", 200_000],
    ["claude-3-5-haiku", 200_000],
    // GPT
    ["gpt-5-chat", 128_000],
    ["gpt-5.4-mini", 400_000],
    ["gpt-5.4-nano", 400_000],
    ["gpt-4.1", 1_000_000],
    // Grok (LLM Gateway hyphen-style)
    ["grok-4-1", 2_000_000],
    ["grok-4-20", 2_000_000],
    // Llama
    ["llama-4-scout-17b", 131_072],
    ["llama-4-scout", 32_768],
    ["llama-3.1", 128_000],
    // Qwen — specific before shared
    ["qwen-turbo", 1_000_000],
    ["qwen-flash", 1_000_000],
    ["qwen-plus-latest", 1_000_000],
    ["qwen-coder-plus", 131_072],
    // Mistral
    ["mistral-large-2512", 262_144],
    ["mistral-small-2603", 262_144],
    ["mistral-small-2506", 128_000],
    // Shared patterns
    ...SHARED_CONTEXT_WINDOWS,
    // Generic catch-alls AFTER shared
    ["gpt-5.4", 1_050_000],
    ["gpt-5", 400_000],
    ["gpt-4", 8_192],
    ["qwen3.5", 262_144],
    ["qwen3", 40_960],
    ["qwen-plus", 131_072],
    ["qwen2.5", 32_768],
    ["qwen", 32_768],
    ["mistral-large", 128_000],
    ["mistral-medium", 131_072],
    ["mistral-small", 32_768],
    ["mistral", 128_000],
    ["gemma-3", 1_000_000],
    ["gemma", 128_000],
    ["sonar-pro", 200_000],
    ["sonar", 130_000],
    ["kimi", 256_000],
    ["seed-", 256_000],
    ["minimax", 200_000],
    ["grok", 131_072],
    ["llama-3.2", 32_768],
    ["llama", 128_000],
  ],
};
