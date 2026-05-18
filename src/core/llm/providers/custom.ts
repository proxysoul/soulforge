import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getProviderApiKey } from "../../secrets.js";
import { buildOpenAICompatReasoningBody, createReasoningFetchWrapper } from "./reasoning-fetch.js";
import type {
  CustomProviderConfig,
  CustomReasoningConfig,
  ProviderDefinition,
  ProviderModelInfo,
} from "./types.js";

interface OpenAIModelListEntry {
  id: string;
  owned_by?: string;
  context_window?: number;
}

/**
 * Normalize a baseURL path by stripping a trailing `/v1` segment so that
 * appending `/models` does not produce `/v1/v1/models`.
 *
 * Examples:
 *   "https://api.example.com/v1"         → "https://api.example.com"
 *   "https://api.example.com/v1/"        → "https://api.example.com"
 *   "https://api.example.com"            → "https://api.example.com"
 *   "https://api.example.com/api/v1"     → "https://api.example.com/api"
 *   "https://api.example.com/"           → "https://api.example.com/"
 */
function normalizeBaseURLPath(baseURL: string): string {
  return baseURL.replace(/\/v1(?:\/)?$/i, "").replace(/\/+$/, "");
}

/**
 * Build the models-api endpoint for an OpenAI-compatible custom provider.
 *
 * Resolution order:
 *   1. Explicit `modelsAPI` from config — user-configured endpoint, used as-is.
 *   2. Auto-constructed URL derived from `baseURL` — strip trailing `/v1`, append `/models`.
 *      This enables zero-config model discovery for standard OpenAI-compatible servers.
 *      Returns null only when `baseURL` itself is absent (should not happen in practice).
 */
function resolveModelsAPIUrl(config: CustomProviderConfig): string | null {
  if (config.modelsAPI) return config.modelsAPI;
  const normalized = normalizeBaseURLPath(config.baseURL);
  return `${normalized}/models`;
}

function normalizeModels(models?: (string | ProviderModelInfo)[]): ProviderModelInfo[] {
  if (!models || models.length === 0) return [];
  return models.map((m) => (typeof m === "string" ? { id: m, name: m } : m));
}

function buildReasoningBody(reasoning?: CustomReasoningConfig): Record<string, unknown> {
  if (!reasoning) return {};
  return buildOpenAICompatReasoningBody(reasoning.effort, {
    enabled: reasoning.enabled,
    budget: reasoning.budget,
    extraParams: reasoning.extraParams,
  });
}

export function buildCustomProvider(config: CustomProviderConfig): ProviderDefinition {
  const envVar = config.envVar ?? "";
  const reasoningBody = buildReasoningBody(config.reasoning);
  const reasoningFetch = createReasoningFetchWrapper(reasoningBody);

  return {
    id: config.id,
    name: config.name ?? config.id,
    envVar,
    icon: "\uF29F", // nf-fa-diamond U+F29F
    asciiIcon: "◇",
    custom: true,
    customReasoning: config.reasoning,

    createModel(modelId: string) {
      const apiKey = envVar ? (getProviderApiKey(envVar) ?? "") : "custom";
      const client = createOpenAICompatible({
        name: config.id,
        baseURL: config.baseURL,
        apiKey,
        ...(reasoningFetch ? { fetch: reasoningFetch as typeof fetch } : {}),
      });
      return client.chatModel(modelId);
    },

    async fetchModels(): Promise<ProviderModelInfo[] | null> {
      const modelsUrl = resolveModelsAPIUrl(config);
      if (!modelsUrl) return null;

      const apiKey = envVar ? (getProviderApiKey(envVar) ?? "") : "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      let res: Response;
      try {
        res = await fetch(modelsUrl, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        return null;
      }
      if (!res.ok) return null;

      let parsed: { data?: OpenAIModelListEntry[] };
      try {
        parsed = (await res.json()) as { data?: OpenAIModelListEntry[] };
      } catch {
        return null;
      }
      if (!Array.isArray(parsed.data)) return null;

      return parsed.data.map((m) => ({
        id: m.id,
        name: m.id,
        ...(typeof m.context_window === "number" ? { contextWindow: m.context_window } : {}),
      }));
    },

    fallbackModels: normalizeModels(config.models),
    contextWindows: [],

    async checkAvailability() {
      if (envVar) return Boolean(getProviderApiKey(envVar));
      try {
        const res = await fetch(config.baseURL, { signal: AbortSignal.timeout(2000) });
        return res.ok || res.status === 401 || res.status === 403;
      } catch {
        return false;
      }
    },
  };
}
