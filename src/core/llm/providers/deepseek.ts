import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { loadConfig } from "../../../config/index.js";
import { getProviderApiKey } from "../../secrets.js";
import { getCompatReasoningBody } from "../compat-reasoning.js";
import { createSessionFetchWrapper } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

export const deepseek: ProviderDefinition = {
  id: "deepseek",
  name: "DeepSeek",
  envVar: "DEEPSEEK_API_KEY",
  icon: "󰧑", // nf-md-head_snowflake U+F09D1
  secretKey: "deepseek-api-key",
  keyUrl: "platform.deepseek.com",
  asciiIcon: "D",
  description: "DeepSeek models",

  createModel(modelId: string): LanguageModel {
    const apiKey = getProviderApiKey("DEEPSEEK_API_KEY");
    if (!apiKey) {
      throw new Error("DEEPSEEK_API_KEY is not set");
    }
    // Use @ai-sdk/openai-compatible to properly handle reasoning_content
    // Fixes 400 error: "reasoning_content in the thinking mode must be passed back to the API"
    const reasoningBody = getCompatReasoningBody(`deepseek/${modelId}`, loadConfig());
    const reasoningFetch = createSessionFetchWrapper(reasoningBody);
    const provider = createOpenAICompatible({
      name: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
      apiKey,
      ...(reasoningFetch ? { fetch: reasoningFetch as typeof fetch } : {}),
    });
    return provider.chatModel(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey("DEEPSEEK_API_KEY");
    if (!apiKey) return null;
    const res = await fetch("https://api.deepseek.com/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`DeepSeek API ${String(res.status)}`);
    const data = (await res.json()) as {
      data: { id: string; owned_by?: string }[];
    };
    return data.data.map((m) => ({ id: m.id, name: m.id }));
  },

  fallbackModels: [
    { id: "deepseek-chat", name: "DeepSeek V3" },
    { id: "deepseek-reasoner", name: "DeepSeek R1" },
  ],

  contextWindows: [
    ["deepseek-chat", 131_072],
    ["deepseek-reasoner", 131_072],
    ["deepseek-v3", 131_072],
    ["deepseek-r1", 131_072],
    ["deepseek-coder", 128_000],
  ],
};
