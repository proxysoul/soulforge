import { createOpenAI } from "@ai-sdk/openai";
import { loadConfig } from "../../../config/index.js";
import { getProviderApiKey } from "../../secrets.js";
import { getCompatReasoningBody } from "../compat-reasoning.js";
import { createSessionFetchWrapper } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

const ENV_VAR = "GITHUB_MODELS_API_KEY";
const BASE_URL = "https://models.github.ai/inference";
const CATALOG_URL = "https://models.github.ai/catalog/models";
const GH_HEADERS: Record<string, string> = {
  "X-GitHub-Api-Version": "2026-03-10",
  Accept: "application/vnd.github+json",
};

interface CatalogModel {
  id: string;
  name?: string;
  rate_limit_tier?: string;
  supported_output_modalities?: string[];
  limits?: { max_input_tokens?: number };
}

export const githubModels: ProviderDefinition = {
  id: "github-models",
  name: "GitHub Models",
  envVar: ENV_VAR,
  icon: "\uF09B", // nf-fa-github U+F09B
  secretKey: "github-models-api-key",
  keyUrl: "github.com/settings/tokens",
  asciiIcon: "GH",
  description: "Free with GitHub PAT",

  createModel(modelId: string) {
    const apiKey = getProviderApiKey(ENV_VAR);
    if (!apiKey) {
      throw new Error(
        `${ENV_VAR} is not set. Create a fine-grained PAT with models:read at github.com/settings/tokens`,
      );
    }
    const reasoningBody = getCompatReasoningBody(`github-models/${modelId}`, loadConfig());
    const reasoningFetch = createSessionFetchWrapper(reasoningBody);
    return createOpenAI({
      baseURL: BASE_URL,
      apiKey,
      headers: GH_HEADERS,
      ...(reasoningFetch ? { fetch: reasoningFetch as typeof fetch } : {}),
    }).chat(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey(ENV_VAR);
    if (!apiKey) return null;
    const res = await fetch(CATALOG_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, ...GH_HEADERS },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as CatalogModel[];
    if (!Array.isArray(data)) return null;
    const result: ProviderModelInfo[] = [];
    for (const m of data) {
      if (!m.supported_output_modalities?.includes("text")) continue;
      result.push({
        id: m.id,
        name: m.name ?? m.id,
        contextWindow: m.limits?.max_input_tokens,
      });
    }
    return result;
  },

  fallbackModels: [
    { id: "openai/gpt-5", name: "GPT-5", contextWindow: 200_000 },
    { id: "openai/gpt-5-mini", name: "GPT-5 Mini", contextWindow: 200_000 },
    { id: "openai/gpt-5-nano", name: "GPT-5 Nano", contextWindow: 200_000 },
    { id: "openai/gpt-4.1", name: "GPT-4.1", contextWindow: 1_048_576 },
    { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini", contextWindow: 1_048_576 },
    { id: "openai/gpt-4o", name: "GPT-4o", contextWindow: 131_072 },
    { id: "openai/o4-mini", name: "o4 Mini", contextWindow: 200_000 },
    { id: "openai/o3", name: "o3", contextWindow: 200_000 },
    {
      id: "meta/llama-4-maverick-17b-128e-instruct-fp8",
      name: "Llama 4 Maverick",
      contextWindow: 1_000_000,
    },
    { id: "meta/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout", contextWindow: 10_000_000 },
    { id: "deepseek/deepseek-r1-0528", name: "DeepSeek R1 (0528)", contextWindow: 128_000 },
    { id: "deepseek/deepseek-v3-0324", name: "DeepSeek V3 (0324)", contextWindow: 128_000 },
    { id: "mistral-ai/codestral-2501", name: "Codestral 2501", contextWindow: 256_000 },
    { id: "mistral-ai/mistral-medium-2505", name: "Mistral Medium 2505", contextWindow: 128_000 },
    { id: "xai/grok-3", name: "Grok 3", contextWindow: 131_072 },
    { id: "microsoft/phi-4-reasoning", name: "Phi 4 Reasoning", contextWindow: 32_768 },
    { id: "microsoft/phi-4", name: "Phi 4", contextWindow: 16_384 },
    { id: "cohere/cohere-command-a", name: "Cohere Command A", contextWindow: 131_072 },
  ],

  contextWindows: [
    ["openai/gpt-5", 200_000],
    ["openai/gpt-5-mini", 200_000],
    ["openai/gpt-5-nano", 200_000],
    ["openai/gpt-5-chat", 200_000],
    ["openai/gpt-4.1-mini", 1_048_576],
    ["openai/gpt-4.1-nano", 1_048_576],
    ["openai/gpt-4.1", 1_048_576],
    ["openai/gpt-4o-mini", 128_000],
    ["openai/gpt-4o", 128_000],
    ["openai/o4-mini", 200_000],
    ["openai/o3", 200_000],
    ["openai/o1", 200_000],
    ["meta/llama-4-maverick", 1_000_000],
    ["meta/llama-4-scout", 10_000_000],
    ["meta/meta-llama-3.1", 131_072],
    ["meta/llama-3", 131_072],
    ["mistral-ai/codestral-2501", 256_000],
    ["mistral-ai/mistral-medium-2505", 128_000],
    ["mistral-ai/mistral-small-2503", 128_000],
    ["mistral-ai/ministral-3b", 131_072],
    ["mistral", 128_000],
    ["deepseek/deepseek-r1-0528", 128_000],
    ["deepseek/deepseek-r1", 128_000],
    ["deepseek/deepseek-v3-0324", 128_000],
    ["deepseek/deepseek-v3", 128_000],
    ["cohere/", 131_072],
    ["xai/grok-3", 131_072],
    ["microsoft/phi-4-reasoning", 32_768],
    ["microsoft/phi-4-mini", 128_000],
    ["microsoft/phi-4-multimodal", 128_000],
    ["microsoft/phi-4", 16_384],
    ["microsoft/mai-ds-r1", 128_000],
    ["ai21-", 262_144],
  ],

  grouped: true,
};
