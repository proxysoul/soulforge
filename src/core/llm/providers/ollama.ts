import { createOpenAI } from "@ai-sdk/openai";
import { loadConfig } from "../../../config/index.js";
import { getCompatReasoningBody } from "../compat-reasoning.js";
import { createSessionFetchWrapper } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

interface OllamaModel {
  name: string;
}

/** Ollama host — override with OLLAMA_HOST (e.g. "http://192.168.1.5:11434"). */
function getOllamaHost(): string {
  return (process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(/\/+$/, "");
}

export const ollama: ProviderDefinition = {
  id: "ollama",
  name: "Ollama",
  envVar: "",
  icon: "\uEBA2", // nf-cod-server_process U+EBA2
  asciiIcon: "O",
  description: "Local models — no key needed",

  createModel(modelId: string) {
    const reasoningBody = getCompatReasoningBody(`ollama/${modelId}`, loadConfig());
    const reasoningFetch = createSessionFetchWrapper(reasoningBody);
    const client = createOpenAI({
      baseURL: `${getOllamaHost()}/v1`,
      apiKey: "ollama",
      ...(reasoningFetch ? { fetch: reasoningFetch as typeof fetch } : {}),
    });
    return client.chat(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const res = await fetch(`${getOllamaHost()}/api/tags`);
    if (!res.ok) throw new Error(`Ollama API ${String(res.status)}`);
    const data = (await res.json()) as { models: OllamaModel[] };
    return data.models.map((m) => {
      const name = m.name.replace(/:latest$/, "");
      return { id: name, name };
    });
  },

  fallbackModels: [
    { id: "llama3.3", name: "Llama 3.3" },
    { id: "qwen3", name: "Qwen 3" },
    { id: "deepseek-coder-v2", name: "DeepSeek Coder v2" },
    { id: "mistral", name: "Mistral" },
  ],

  async checkAvailability() {
    try {
      const res = await fetch(`${getOllamaHost()}/api/tags`, {
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  contextWindows: [
    ["llama3.3", 131_072],
    ["llama3.1:70b", 128_000],
    ["llama3.1", 128_000],
    ["codellama", 16_000],
    ["deepseek-coder", 128_000],
    ["deepseek", 128_000],
    ["mistral", 128_000],
    ["qwen3", 131_072],
    ["qwen2.5", 128_000],
    ["qwen", 128_000],
  ],
};
