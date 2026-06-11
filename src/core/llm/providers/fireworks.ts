import { createFireworks } from "@ai-sdk/fireworks";
import { loadConfig } from "../../../config/index.js";
import { getProviderApiKey } from "../../secrets.js";
import { getCompatReasoningBody } from "../compat-reasoning.js";
import { createSessionFetchWrapper } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

export const fireworks: ProviderDefinition = {
  id: "fireworks",
  name: "Fireworks",
  envVar: "FIREWORKS_API_KEY",
  icon: "\uF0E7", // nf-fa-bolt U+F0E7
  secretKey: "fireworks-api-key",
  keyUrl: "fireworks.ai",
  asciiIcon: "F",
  description: "Fast open models",

  createModel(modelId: string) {
    const apiKey = getProviderApiKey("FIREWORKS_API_KEY");
    if (!apiKey) {
      throw new Error("FIREWORKS_API_KEY is not set");
    }
    const reasoningBody = getCompatReasoningBody(`fireworks/${modelId}`, loadConfig());
    const reasoningFetch = createSessionFetchWrapper(reasoningBody);
    return createFireworks({
      apiKey,
      ...(reasoningFetch ? { fetch: reasoningFetch as typeof fetch } : {}),
    })(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey("FIREWORKS_API_KEY");
    if (!apiKey) return null;
    const res = await fetch("https://api.fireworks.ai/inference/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Fireworks API ${String(res.status)}`);
    const data = (await res.json()) as {
      data: { id: string; owned_by?: string }[];
    };
    return data.data.map((m) => ({ id: m.id, name: m.id }));
  },

  fallbackModels: [
    { id: "accounts/fireworks/models/llama-v3p3-70b-instruct", name: "Llama 3.3 70B" },
    { id: "accounts/fireworks/models/deepseek-v3", name: "DeepSeek V3" },
    { id: "accounts/fireworks/models/qwen2p5-72b-instruct", name: "Qwen 2.5 72B" },
    { id: "accounts/fireworks/models/mixtral-8x22b-instruct", name: "Mixtral 8x22B" },
  ],

  contextWindows: [
    ["llama-v3p3-70b", 131_072],
    ["llama-v3p1-405b", 131_072],
    ["llama-v3p1-70b", 131_072],
    ["llama-v3p1-8b", 131_072],
    ["deepseek-v3", 163_840],
    ["deepseek-r1", 64_000],
    ["qwen2p5-72b", 131_072],
    ["qwen2p5-coder-32b", 131_072],
    ["mixtral-8x22b", 65_536],
    ["mixtral-8x7b", 32_768],
    ["firefunction", 32_768],
  ],
};
