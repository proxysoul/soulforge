import { createOpenAI } from "@ai-sdk/openai";
import { loadConfig } from "../../../config/index.js";
import { getCompatReasoningBody } from "../compat-reasoning.js";
import { createSessionFetchWrapper } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

/** Base origin — override with LM_STUDIO_URL (e.g. "http://192.168.1.5:1234"). */
function getBaseOrigin(): string {
  return (process.env.LM_STUDIO_URL ?? "http://localhost:1234").replace(/\/+$/, "");
}

function openaiBase(): string {
  return `${getBaseOrigin()}/v1`;
}

function restBase(): string {
  return `${getBaseOrigin()}/api/v0`;
}

/** REST API v0 model shape — richer than the OpenAI-compat endpoint. */
interface LMStudioRestModel {
  id: string;
  type: "llm" | "vlm" | "embeddings";
  publisher?: string;
  arch?: string;
  quantization?: string;
  state?: "loaded" | "not-loaded";
  max_context_length?: number;
}

function getApiToken(): string {
  return process.env.LM_API_TOKEN ?? "lm-studio";
}

function authHeaders(): Record<string, string> {
  const token = getApiToken();
  return token && token !== "lm-studio" ? { Authorization: `Bearer ${token}` } : {};
}

export const lmstudio: ProviderDefinition = {
  id: "lmstudio",
  name: "LM Studio",
  envVar: "LM_API_TOKEN",
  secretKey: "lm-api-token",
  icon: "\uEA79", // nf-cod-beaker U+EA79
  asciiIcon: "L",
  description: "Local models via LM Studio — no key needed",

  createModel(modelId: string) {
    const reasoningBody = getCompatReasoningBody(`lmstudio/${modelId}`, loadConfig());
    const reasoningFetch = createSessionFetchWrapper(reasoningBody);
    const client = createOpenAI({
      baseURL: openaiBase(),
      apiKey: getApiToken(),
      ...(reasoningFetch ? { fetch: reasoningFetch as typeof fetch } : {}),
    });
    return client.chat(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    // Prefer the REST API v0 — returns context length, type, arch, quantization
    const res = await fetch(`${restBase()}/models`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`LM Studio API ${String(res.status)}`);
    const data = (await res.json()) as { data: LMStudioRestModel[] };
    if (!Array.isArray(data.data)) return null;

    return data.data
      .filter((m) => m.type === "llm" || m.type === "vlm")
      .map((m) => ({
        id: m.id,
        name: m.id,
        contextWindow: m.max_context_length,
      }));
  },

  fallbackModels: [],

  async checkAvailability() {
    try {
      const res = await fetch(`${restBase()}/models`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  contextWindows: [],
};
