import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { loadConfig } from "../../../config/index.js";
import { getProviderApiKey } from "../../secrets.js";
import { getCompatReasoningBody } from "../compat-reasoning.js";
import { createSessionFetchWrapper } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

const BASE_URL = "https://opencode.ai/zen/go/v1";

export const opencodeGo: ProviderDefinition = {
  id: "opencode-go",
  name: "OpenCode Go",
  envVar: "OPENCODE_GO_API_KEY",
  icon: "\uE795", // nf-dev-go U+E795
  secretKey: "opencode-go-api-key",
  keyUrl: "opencode.ai",
  asciiIcon: "GO",
  description: "GLM, Kimi, MiMo, MiniMax, Qwen, DeepSeek models",

  createModel(modelId: string): LanguageModel {
    const apiKey = getProviderApiKey("OPENCODE_GO_API_KEY");
    if (!apiKey) {
      throw new Error("OPENCODE_GO_API_KEY is not set");
    }
    // Use @ai-sdk/openai-compatible to properly handle reasoning_content
    // Fixes 400 error: "thinking is enabled but reasoning_content is missing"
    const reasoningBody = getCompatReasoningBody(`opencode-go/${modelId}`, loadConfig());
    const reasoningFetch = createSessionFetchWrapper(reasoningBody);
    const provider = createOpenAICompatible({
      name: "opencode-go",
      baseURL: BASE_URL,
      apiKey,
      ...(reasoningFetch ? { fetch: reasoningFetch as typeof fetch } : {}),
    });
    return provider.chatModel(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey("OPENCODE_GO_API_KEY");
    if (!apiKey) return null;
    try {
      const res = await fetch("https://opencode.ai/zen/go/v1/models", {
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
  // (https://opencode.ai/zen/go/v1/models). Keep this short.
  fallbackModels: [
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "minimax-m3", name: "MiniMax M3" },
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  ],

  // Prefix patterns — match every minor variant the live API returns.
  contextWindows: [
    ["glm-5", 204_800],
    ["kimi-k2", 262_000],
    ["mimo-v2", 262_144],
    ["minimax-m3", 196_000],
    ["minimax-m2", 196_000],
    ["qwen3", 1_000_000],
    ["deepseek-v4", 131_072],
    ["hy3", 262_144],
  ],
};
