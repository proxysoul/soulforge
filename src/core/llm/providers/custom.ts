import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getProviderApiKey } from "../../secrets.js";
import type {
  CustomProviderConfig,
  CustomReasoningConfig,
  ProviderDefinition,
  ProviderModelInfo,
} from "./types.js";

// Fetch function alias — avoids Bun's typeof fetch which includes preconnect
type FetchFn = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

interface OpenAIModelListResponse {
  data: { id: string; owned_by?: string }[];
}

function normalizeModels(models?: (string | ProviderModelInfo)[]): ProviderModelInfo[] {
  if (!models || models.length === 0) return [];
  return models.map((m) => (typeof m === "string" ? { id: m, name: m } : m));
}

/** Build request body params from reasoning config.
 *  Supports three API styles simultaneously:
 *  1. OpenAI-style: { reasoning: { effort: "high" } }
 *  2. DashScope-style: { enable_thinking: true, thinking_budget: 4096 }
 *  3. Raw extra params: forwarded verbatim */
function buildReasoningBody(reasoning?: CustomReasoningConfig): Record<string, unknown> {
  if (!reasoning) return {};

  const body: Record<string, unknown> = {};

  // OpenAI-style reasoning effort
  // Always forward the effort value — "none" is a valid signal for APIs
  // that support explicitly disabling thinking/thought generation.
  if (reasoning.effort) {
    body.reasoning = { effort: reasoning.effort };
  }

  // DashScope-style thinking control
  if (reasoning.enabled !== undefined) {
    body.enable_thinking = reasoning.enabled;
  }
  if (reasoning.budget !== undefined) {
    body.thinking_budget = reasoning.budget;
  }

  // Raw extra params (highest priority — overrides above keys on collision)
  if (reasoning.extraParams) {
    Object.assign(body, reasoning.extraParams);
  }

  return body;
}

/** Create a fetch wrapper that injects reasoning params into every request body.
 *  This ensures thinking control works for any OpenAI-compatible API endpoint.
 *  Matches the FetchFunction signature used by @ai-sdk/provider-utils to avoid
 *  incompatibility with callers that pass a Request object or omit init. */
function createReasoningFetchWrapper(reasoningBody: Record<string, unknown>): FetchFn | undefined {
  if (Object.keys(reasoningBody).length === 0) {
    return undefined;
  }

  return async (input, init): Promise<Response> => {
    if (!init?.body || typeof init.body !== "string") {
      return fetch(input, init);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      return fetch(input, init);
    }

    const merged = { ...parsed, ...reasoningBody };
    // Shallow-copy init to avoid mutating the caller's object
    const patchedInit: RequestInit = { ...init, body: JSON.stringify(merged) };
    return fetch(input, patchedInit);
  };
}

export function buildCustomProvider(config: CustomProviderConfig): ProviderDefinition {
  const envVar = config.envVar ?? "";
  const reasoningBody = buildReasoningBody(config.reasoning);
  const reasoningFetch = createReasoningFetchWrapper(reasoningBody);

  return {
    id: config.id,
    name: config.name ?? config.id,
    envVar,
    secretKey: `${config.id}-api-key`,
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
      if (!config.modelsAPI) return null;
      const apiKey = envVar ? (getProviderApiKey(envVar) ?? "") : "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const res = await fetch(config.modelsAPI, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as OpenAIModelListResponse;
      if (!Array.isArray(data.data)) return null;

      return data.data.map((m) => ({ id: m.id, name: m.id }));
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
