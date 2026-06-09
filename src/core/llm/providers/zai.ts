import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { loadConfig } from "../../../config/index.js";
import { getProviderApiKey } from "../../secrets.js";
import { getCompatReasoningBody } from "../compat-reasoning.js";
import { createReasoningFetchWrapper } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

// Z.AI GLM Coding Plan — OpenAI-compatible *coding* endpoint, which draws on the
// subscription quota. (An Anthropic-compatible endpoint exists at
// https://api.z.ai/api/anthropic, but the OpenAI-compatible path surfaces GLM's
// `reasoning_content` as reasoning parts via @ai-sdk/openai-compatible.)
// Using the wrong base URL silently bills pay-as-you-go instead of the plan.
const BASE_URL = "https://api.z.ai/api/coding/paas/v4";

export const zai: ProviderDefinition = {
  id: "zai",
  name: "Z.AI",
  envVar: "ZAI_API_KEY",
  icon: "\u{F0AD6}", // nf-md-alpha_z
  secretKey: "zai-api-key",
  keyUrl: "z.ai/manage-apikey/apikey-list",
  asciiIcon: "Z",
  description: "GLM Coding Plan (GLM-4.6 / 4.7 / 5.x)",

  createModel(modelId: string): LanguageModel {
    const apiKey = getProviderApiKey("ZAI_API_KEY");
    if (!apiKey) {
      throw new Error("ZAI_API_KEY is not set");
    }
    // @ai-sdk/openai-compatible (not @ai-sdk/openai) so GLM `reasoning_content`
    // is surfaced as reasoning parts. Reasoning body is injected per config.
    const reasoningBody = getCompatReasoningBody(`zai/${modelId}`, loadConfig());
    const reasoningFetch = createReasoningFetchWrapper(reasoningBody);
    return createOpenAICompatible({
      name: "zai",
      baseURL: BASE_URL,
      apiKey,
      ...(reasoningFetch ? { fetch: reasoningFetch as typeof fetch } : {}),
    }).chatModel(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey("ZAI_API_KEY");
    if (!apiKey) return null;
    try {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      if (!data.data?.length) return null;
      return data.data.map((m) => ({ id: m.id, name: m.id }));
    } catch {
      return null;
    }
  },

  // Offline fallback — the live list comes from fetchModels() when a key is set.
  fallbackModels: [
    { id: "glm-4.6", name: "GLM-4.6" },
    { id: "glm-4.5", name: "GLM-4.5" },
    { id: "glm-4.5-air", name: "GLM-4.5 Air" },
    { id: "glm-4.5-flash", name: "GLM-4.5 Flash" },
    { id: "glm-4.7", name: "GLM-4.7" },
    { id: "glm-5", name: "GLM-5" },
    { id: "glm-5.1", name: "GLM-5.1" },
  ],

  // Prefix patterns — match every minor variant. Specific before generic.
  contextWindows: [
    ["glm-5", 200_000],
    ["glm-4.7", 200_000],
    ["glm-4.6", 200_000],
    ["glm-4.5-air", 128_000],
    ["glm-4.5-flash", 128_000],
    ["glm-4.5", 128_000],
  ],
};
