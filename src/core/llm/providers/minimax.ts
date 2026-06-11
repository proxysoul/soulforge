import { createMinimax } from "vercel-minimax-ai-provider";
import { loadConfig } from "../../../config/index.js";
import { getProviderApiKey } from "../../secrets.js";
import { getCompatReasoningBody } from "../compat-reasoning.js";
import { createReasoningFetchWrapper } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

export const minimax: ProviderDefinition = {
  id: "minimax",
  name: "MiniMax",
  envVar: "MINIMAX_API_KEY",
  icon: "󰫈", // nf-md-alpha_m U+F0AC8
  secretKey: "minimax-api-key",
  keyUrl: "platform.minimaxi.com",
  asciiIcon: "M",
  description: "M3 / M2 series models",

  createModel(modelId: string) {
    const apiKey = getProviderApiKey("MINIMAX_API_KEY");
    if (!apiKey) {
      throw new Error("MINIMAX_API_KEY is not set");
    }
    const reasoningBody = getCompatReasoningBody(`minimax/${modelId}`, loadConfig());
    const reasoningFetch = createReasoningFetchWrapper(reasoningBody);
    return createMinimax({
      apiKey,
      ...(reasoningFetch ? { fetch: reasoningFetch as typeof fetch } : {}),
    })(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    // MiniMax doesn't expose a public models listing endpoint
    return null;
  },

  fallbackModels: [
    { id: "MiniMax-M3", name: "MiniMax M3" },
    { id: "MiniMax-M3-highspeed", name: "MiniMax M3 HighSpeed" },
    { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
    { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 HighSpeed" },
    { id: "MiniMax-M2.5", name: "MiniMax M2.5" },
    { id: "MiniMax-M2.5-highspeed", name: "MiniMax M2.5 HighSpeed" },
    { id: "MiniMax-M2.1", name: "MiniMax M2.1" },
    { id: "MiniMax-M2.1-highspeed", name: "MiniMax M2.1 Lightning" },
    { id: "MiniMax-M2", name: "MiniMax M2" },
  ],

  // from https://platform.minimax.io/docs/api-reference/text-openai-api#supported-models
  contextWindows: [
    ["MiniMax-M3", 1_000_000],
    ["MiniMax-M3-highspeed", 1_000_000],
    ["MiniMax-M2.7", 204_800],
    ["MiniMax-M2.7-highspeed", 204_800],
    ["MiniMax-M2.5", 204_800],
    ["MiniMax-M2.5-highspeed", 204_800],
    ["MiniMax-M2.1", 204_800],
    ["MiniMax-M2.1-highspeed", 204_800],
    ["MiniMax-M2", 204_800],
  ],
};
