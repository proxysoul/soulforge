import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { loadConfig } from "../../../config/index.js";
import { getProviderApiKey } from "../../secrets.js";
import { CURRENT_VERSION } from "../../version.js";
import { getCompatReasoningBody } from "../compat-reasoning.js";
import { withSessionHeaders } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

const ENV_VAR = "COPILOT_API_KEY";
const COPILOT_API = "https://api.githubcopilot.com";
const TOKEN_EXCHANGE = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_CHAT_VERSION = "0.26.7";
const COPILOT_API_VERSION = "2025-04-01";
const COPILOT_HEADERS: Record<string, string> = {
  "Editor-Version": "vscode/1.95.0",
  "Editor-Plugin-Version": `copilot-chat/${COPILOT_CHAT_VERSION}`,
  "Copilot-Integration-Id": "vscode-chat",
  "User-Agent": `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`,
  "OpenAI-Intent": "conversation-panel",
  "X-GitHub-Api-Version": COPILOT_API_VERSION,
  "X-VSCode-User-Agent-Library-Version": "electron-fetch",
};

interface TokenResponse {
  token: string;
  expires_at: number;
}

let cachedBearer: { token: string; expiresAt: number } | null = null;
let bearerInflight: Promise<string> | null = null;

async function exchangeToken(githubToken: string): Promise<string> {
  if (cachedBearer && Date.now() / 1000 < cachedBearer.expiresAt - 60) {
    return cachedBearer.token;
  }
  if (bearerInflight) return bearerInflight;
  bearerInflight = (async () => {
    try {
      const res = await fetch(TOKEN_EXCHANGE, {
        headers: {
          Authorization: `Token ${githubToken}`,
          "User-Agent": `SoulForge/${CURRENT_VERSION}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        cachedBearer = null;
        const body = await res.text().catch(() => "");
        const hint =
          res.status === 401 || res.status === 403
            ? " — your GitHub OAuth token is invalid or expired. Re-run the login flow in VS Code/JetBrains and copy the fresh oauth_token from ~/.config/github-copilot/apps.json."
            : res.status >= 500
              ? " — GitHub is having issues, try again in a moment."
              : "";
        throw new Error(
          `Copilot token exchange failed (${String(res.status)})${body ? `: ${body.slice(0, 200)}` : ""}${hint}`,
        );
      }
      const data = (await res.json()) as TokenResponse;
      if (!data.token) throw new Error("Copilot token exchange returned empty token");
      cachedBearer = { token: data.token, expiresAt: data.expires_at };
      return data.token;
    } finally {
      bearerInflight = null;
    }
  })();
  return bearerInflight;
}

/** Invalidate cached bearer so next request triggers a fresh exchange. */
function invalidateBearer(): void {
  cachedBearer = null;
}

function getGitHubToken(): string {
  const stored = getProviderApiKey(ENV_VAR);
  if (stored) return stored;
  throw new Error(
    "GitHub Copilot requires an OAuth token. Sign in via VS Code or JetBrains, then copy oauth_token from ~/.config/github-copilot/apps.json and save it with /keys or --set-key copilot.",
  );
}

function detectInitiator(body: unknown): "agent" | "user" {
  if (typeof body !== "string") return "user";
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
    if (Array.isArray(parsed.messages)) {
      for (const m of parsed.messages) {
        if (m?.role === "assistant" || m?.role === "tool") return "agent";
      }
    }
  } catch {}
  return "user";
}

function createCopilotFetch(
  githubToken: string,
  reasoningBody: Record<string, unknown>,
): typeof fetch {
  const injectReasoning = Object.keys(reasoningBody).length > 0;
  // biome-ignore lint/suspicious/noExplicitAny: Bun fetch type mismatch with preconnect
  return (async (url: any, init: any) => {
    let bearer: string;
    try {
      bearer = await exchangeToken(githubToken);
    } catch {
      invalidateBearer();
      bearer = await exchangeToken(githubToken);
    }
    let patchedBody = init?.body;
    if (injectReasoning && typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body);
        patchedBody = JSON.stringify({ ...parsed, ...reasoningBody });
      } catch {}
    }
    const buildHeaders = (token: string): Headers => {
      const h = new Headers(init?.headers);
      h.set("Authorization", `Bearer ${token}`);
      h.set("X-Request-Id", crypto.randomUUID());
      h.set("X-Initiator", detectInitiator(patchedBody));
      return h;
    };
    const res = await fetch(url, { ...init, body: patchedBody, headers: buildHeaders(bearer) });
    if (res.status === 401) {
      invalidateBearer();
      const retryBearer = await exchangeToken(githubToken);
      return fetch(url, { ...init, body: patchedBody, headers: buildHeaders(retryBearer) });
    }
    return res;
  }) as typeof fetch;
}

// Cache of model -> supported endpoints, populated by fetchModels.
// Empty set means "unknown, allow through" so we don't break offline use.
const supportedEndpoints = new Map<string, string[]>();

function assertChatCompletionsSupported(modelId: string): void {
  const endpoints = supportedEndpoints.get(modelId);
  if (!endpoints || endpoints.length === 0) return; // unknown, let SDK try
  const hasChat = endpoints.some((e) => e.includes("chat") || e.includes("completions"));
  if (hasChat) return;
  throw new Error(
    `Copilot model "${modelId}" only supports ${endpoints.join(", ")} — ` +
      "SoulForge routes Copilot through /chat/completions. " +
      "Try claude-sonnet-4.6, gpt-4.1, or another chat-compatible model.",
  );
}

function createCopilotModel(modelId: string): LanguageModel {
  assertChatCompletionsSupported(modelId);
  const githubToken = getGitHubToken();
  const reasoningBody = getCompatReasoningBody(`copilot/${modelId}`, loadConfig());
  const copilotFetch = createCopilotFetch(githubToken, reasoningBody);

  // Copilot exposes /chat/completions for both OpenAI and Claude models
  // (translated server-side). The /responses path requires a separate parser
  // we don't ship; /messages returns 404 entirely.
  const client = createOpenAI({
    baseURL: COPILOT_API,
    apiKey: "copilot",
    headers: { ...COPILOT_HEADERS },
    fetch: withSessionHeaders(copilotFetch) as typeof fetch,
  });

  return client.chat(modelId);
}

export const copilot: ProviderDefinition = {
  id: "copilot",
  name: "GitHub Copilot",
  envVar: ENV_VAR,
  icon: "\uEC1E", // nf-cod-copilot U+EC1E
  secretKey: "copilot-api-key",
  keyUrl: "github.com/features/copilot",
  asciiIcon: "CP",
  description: "Free with Copilot sub",
  badge: "unofficial",

  createModel: createCopilotModel,

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    try {
      const githubToken = getGitHubToken();
      const bearer = await exchangeToken(githubToken);
      const res = await fetch(`${COPILOT_API}/models`, {
        headers: { Authorization: `Bearer ${bearer}`, ...COPILOT_HEADERS },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        data: Array<{ id: string; supported_endpoints?: string[] }>;
      };
      if (!Array.isArray(data?.data)) return null;
      const skip = /embed|text-embedding|oswe|goldeneye|inference/i;
      const result: ProviderModelInfo[] = [];
      for (const m of data.data) {
        if (skip.test(m.id)) continue;
        if (result.some((r) => r.id === m.id)) continue;
        if (Array.isArray(m.supported_endpoints)) {
          supportedEndpoints.set(m.id, m.supported_endpoints);
        }
        result.push({ id: m.id, name: m.id });
      }
      return result;
    } catch {
      return null;
    }
  },

  fallbackModels: [
    { id: "claude-opus-4.8", name: "Claude Opus 4.8", contextWindow: 1_000_000 },
    { id: "claude-opus-4.7", name: "Claude Opus 4.7", contextWindow: 1_000_000 },
    { id: "claude-opus-4.6", name: "Claude Opus 4.6", contextWindow: 1_000_000 },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextWindow: 1_000_000 },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", contextWindow: 128_000 },
    { id: "claude-opus-4.5", name: "Claude Opus 4.5", contextWindow: 200_000 },
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", contextWindow: 200_000 },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", contextWindow: 200_000 },
    { id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000 },
    { id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128_000 },
    { id: "gpt-4.1", name: "GPT-4.1", contextWindow: 128_000 },
    { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 200_000 },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: 200_000 },
    { id: "o4-mini", name: "o4 Mini", contextWindow: 128_000 },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 128_000 },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", contextWindow: 1_000_000 },
  ],

  contextWindows: [
    ["claude-opus-4.8", 1_000_000],
    ["claude-opus-4.7", 1_000_000],
    ["claude-opus-4.6", 1_000_000],
    ["claude-sonnet-4.6", 1_000_000],
    ["claude-opus-4.5", 200_000],
    ["claude-sonnet-4.5", 200_000],
    ["claude-sonnet-4", 128_000],
    ["claude-haiku-4.5", 200_000],
    ["claude-3.7-sonnet", 200_000],
    ["claude-3.5-sonnet", 90_000],
    ["gpt-5.4", 200_000],
    ["gpt-5.3", 200_000],
    ["gpt-5.2", 200_000],
    ["gpt-5.1", 200_000],
    ["gpt-5-mini", 128_000],
    ["gpt-4.1", 128_000],
    ["gpt-4o-mini", 128_000],
    ["gpt-4o", 128_000],
    ["gpt-4", 32_768],
    ["o4-mini", 128_000],
    ["o3-mini", 200_000],
    ["gemini-3", 1_000_000],
    ["gemini-2.5-pro", 128_000],
    ["gemini-2.0-flash", 1_000_000],
    ["grok", 131_072],
  ],

  async checkAvailability() {
    return !!getProviderApiKey(ENV_VAR);
  },

  grouped: true,
};
