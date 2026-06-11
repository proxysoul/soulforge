import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { loadConfig } from "../../../config/index.js";
import { getProviderApiKey } from "../../secrets.js";
import { getCompatReasoningBody } from "../compat-reasoning.js";
import { createSessionFetchWrapper } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

const BASE_URL = "https://integrate.api.nvidia.com/v1";

interface NimModel {
  id: string;
}

export const nim: ProviderDefinition = {
  id: "nim",
  name: "NVIDIA NIM",
  envVar: "NVIDIA_API_KEY",
  icon: "\uF0E7", // nf-fa-bolt U+F0E7
  secretKey: "nvidia-api-key",
  keyUrl: "build.nvidia.com",
  asciiIcon: "N",
  description: "NVIDIA-hosted open models",

  createModel(modelId: string) {
    const apiKey = getProviderApiKey("NVIDIA_API_KEY");
    if (!apiKey) {
      throw new Error("NVIDIA_API_KEY is not set");
    }
    const reasoningBody = getCompatReasoningBody(`nim/${modelId}`, loadConfig());
    const reasoningFetch = createSessionFetchWrapper(reasoningBody);
    return createOpenAICompatible({
      name: "nim",
      baseURL: BASE_URL,
      apiKey,
      ...(reasoningFetch ? { fetch: reasoningFetch as typeof fetch } : {}),
    })(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey("NVIDIA_API_KEY");
    if (!apiKey) return null;
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`NVIDIA NIM API ${String(res.status)}`);
    const data = (await res.json()) as { data: NimModel[] };
    return data.data.map((m) => ({ id: m.id, name: m.id }));
  },

  fallbackModels: [
    { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" },
    { id: "deepseek-ai/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-ai/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "zai/glm-5.1", name: "GLM-5.1" },
    { id: "mistralai/mistral-medium-3.5", name: "Mistral Medium 3.5" },
    { id: "mistralai/mistral-small-4", name: "Mistral Small 4" },
    { id: "google/gemma-4-31b", name: "Gemma 4 31B" },
    { id: "nvidia/nemotron-3-super-120b", name: "Nemotron 3 Super 120B" },
    { id: "minimaxai/minimax-m2.7", name: "MiniMax M2.7" },
  ],

  contextWindows: [
    ["kimi-k2.6", 256_000],
    ["deepseek-v4-flash", 1_000_000],
    ["deepseek-v4-pro", 1_000_000],
    ["glm-5.1", 200_000],
    ["mistral-medium-3.5", 131_072],
    ["mistral-small-4", 256_000],
    ["gemma-4-31b", 131_072],
    ["nemotron-3-super-120b", 1_000_000],
    ["minimax-m2.7", 200_000],
  ],
};
