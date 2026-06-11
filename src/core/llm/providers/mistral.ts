import { createMistral } from "@ai-sdk/mistral";
import { getProviderApiKey } from "../../secrets.js";
import { withSessionHeaders } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

interface MistralModel {
  id: string;
  name?: string;
  max_context_length?: number;
}

export const mistral: ProviderDefinition = {
  id: "mistral",
  name: "Mistral",
  envVar: "MISTRAL_API_KEY",
  icon: "󰫈", // nf-md-alpha_m U+F0AC8
  secretKey: "mistral-api-key",
  keyUrl: "console.mistral.ai",
  asciiIcon: "M",
  description: "Mistral & Codestral",

  createModel(modelId: string) {
    const apiKey = getProviderApiKey("MISTRAL_API_KEY");
    if (!apiKey) {
      throw new Error("MISTRAL_API_KEY is not set");
    }
    return createMistral({ apiKey, fetch: withSessionHeaders() as typeof fetch })(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey("MISTRAL_API_KEY");
    if (!apiKey) return null;
    const res = await fetch("https://api.mistral.ai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Mistral API ${String(res.status)}`);
    const data = (await res.json()) as { data: MistralModel[] };
    const result: ProviderModelInfo[] = [];
    for (const m of data.data) {
      result.push({
        id: m.id,
        name: m.name ?? m.id,
        contextWindow: m.max_context_length,
      });
    }
    return result;
  },

  fallbackModels: [
    { id: "mistral-large-latest", name: "Mistral Large" },
    { id: "mistral-medium-latest", name: "Mistral Medium" },
    { id: "mistral-small-latest", name: "Mistral Small" },
    { id: "codestral-latest", name: "Codestral" },
    { id: "magistral-medium-2509", name: "Magistral Medium" },
    { id: "magistral-small-2509", name: "Magistral Small" },
  ],

  contextWindows: [
    ["mistral-large", 256_000],
    ["mistral-medium", 131_072],
    ["mistral-small", 131_072],
    ["mistral-nemo", 131_072],
    ["magistral", 128_000],
    ["pixtral-large", 128_000],
    ["pixtral-12b", 128_000],
    ["codestral", 256_000],
    ["devstral", 262_144],
    ["ministral", 262_144],
    ["open-mistral-7b", 32_000],
    ["open-mixtral-8x7b", 32_000],
    ["open-mixtral-8x22b", 65_536],
  ],
};
