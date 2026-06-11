import { createGroq } from "@ai-sdk/groq";
import { loadConfig } from "../../../config/index.js";
import { getProviderApiKey } from "../../secrets.js";
import { getCompatReasoningBody } from "../compat-reasoning.js";
import { createSessionFetchWrapper } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

interface GroqModel {
  id: string;
  context_window?: number;
}

export const groq: ProviderDefinition = {
  id: "groq",
  name: "Groq",
  envVar: "GROQ_API_KEY",
  icon: "\uF0E7", // nf-fa-bolt U+F0E7
  secretKey: "groq-api-key",
  keyUrl: "console.groq.com",
  asciiIcon: "Q",
  description: "Fast inference",

  createModel(modelId: string) {
    const apiKey = getProviderApiKey("GROQ_API_KEY");
    if (!apiKey) {
      throw new Error("GROQ_API_KEY is not set");
    }
    const reasoningBody = getCompatReasoningBody(`groq/${modelId}`, loadConfig());
    const reasoningFetch = createSessionFetchWrapper(reasoningBody);
    return createGroq({
      apiKey,
      ...(reasoningFetch ? { fetch: reasoningFetch as typeof fetch } : {}),
    })(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey("GROQ_API_KEY");
    if (!apiKey) return null;
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Groq API ${String(res.status)}`);
    const data = (await res.json()) as { data: GroqModel[] };
    const result: ProviderModelInfo[] = [];
    for (const m of data.data) {
      if (
        !m.id.includes("whisper") &&
        !m.id.includes("guard") &&
        !m.id.includes("tts") &&
        !m.id.includes("orpheus")
      ) {
        result.push({ id: m.id, name: m.id, contextWindow: m.context_window });
      }
    }
    return result;
  },

  fallbackModels: [
    { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" },
    { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B" },
    { id: "meta-llama/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout" },
    { id: "qwen/qwen3-32b", name: "Qwen3 32B" },
  ],

  contextWindows: [
    ["llama-3.3-70b", 131_072],
    ["llama-3.1-8b", 131_072],
    ["llama-4-scout", 131_072],
    ["qwen3-32b", 131_072],
    ["gpt-oss-20b", 131_072],
    ["gpt-oss-120b", 131_072],
  ],
};
