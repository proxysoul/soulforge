import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";
import { loadConfig } from "../../../config/index.js";
import { getActiveProxyApiKey } from "../../proxy/key-resolver.js";
import { ensureProxy, stopProxy } from "../../proxy/lifecycle.js";
import { getCompatReasoningBody } from "../compat-reasoning.js";
import { SHARED_CONTEXT_WINDOWS } from "./context-windows.js";
import { createSessionFetchWrapper, withSessionHeaders } from "./reasoning-fetch.js";
import { recoverLeakedToolCallsMiddleware } from "./recover-leaked-tool-calls.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

const baseURL = process.env.PROXY_API_URL || "http://127.0.0.1:8317/v1";
const GPT_55_INPUT_CONTEXT = 272_000;

function isAnthropicModel(modelId: string): boolean {
  return modelId.toLowerCase().startsWith("claude");
}

/** Some proxies (e.g. CLIProxyAPI) intermittently leak Claude's native tool-call
 *  syntax as plain text instead of a structured tool_use block, which strands the
 *  agent loop (it sees text, not a tool call, and stops). Recover those into real
 *  tool calls. Scoped to Claude-over-proxy only; opt out with
 *  SOULFORGE_PROXY_TOOL_RECOVERY=0. */
function leakRecoveryEnabled(): boolean {
  const v = process.env.SOULFORGE_PROXY_TOOL_RECOVERY;
  return v !== "0" && v !== "false";
}

export const proxy: ProviderDefinition = {
  id: "proxy",
  name: "Proxy",
  envVar: "",
  icon: "󰌆", // nf-md-shield_key U+F0306
  asciiIcon: "⛨",
  grouped: true,

  createModel(modelId: string) {
    // Claude → Anthropic SDK (proxy serves /v1/messages)
    // Everything else → OpenAI SDK chat completions (proxy serves /v1/chat/completions)
    // Must use .chat() — default uses Responses API (/v1/responses) which proxy can't translate for all providers
    // Read the key at createModel time so discoveries done by ensureProxy
    // (e.g. brew config's first non-placeholder entry) are picked up. The
    // AI SDK captures `apiKey` at factory-call time, so this must not be a
    // module-level constant.
    const apiKey = getActiveProxyApiKey();
    if (isAnthropicModel(modelId)) {
      const model = createAnthropic({
        baseURL,
        apiKey,
        fetch: withSessionHeaders() as typeof fetch,
      })(modelId);
      return leakRecoveryEnabled()
        ? wrapLanguageModel({ model, middleware: recoverLeakedToolCallsMiddleware() })
        : model;
    }
    // Non-Claude routed through OpenAI SDK — inject reasoning body params for
    // upstream providers (xAI, Gemini, GLM, etc.) that accept reasoning_effort.
    const reasoningBody = getCompatReasoningBody(`proxy/${modelId}`, loadConfig());
    const reasoningFetch = createSessionFetchWrapper(reasoningBody);
    return createOpenAI({
      baseURL,
      apiKey,
      ...(reasoningFetch ? { fetch: reasoningFetch as typeof fetch } : {}),
    }).chat(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    return null;
  },

  // Hide the proxy provider from `/model` and Ctrl+L until the addon is
  // installed. Lazy-imported so we don't pull addons.ts into every provider
  // module's load graph; called once per `checkProviders()` boot pass.
  async checkAvailability(): Promise<boolean> {
    const { isAddonInstalled } = await import("../../setup/addons.js");
    return isAddonInstalled("proxy");
  },

  async onActivate() {
    await ensureProxy();
  },

  onDeactivate() {
    stopProxy();
  },

  fallbackModels: [
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
    { id: "claude-haiku-3-5-20241022", name: "Claude Haiku 3.5" },
    { id: "gpt-5.5", name: "GPT-5.5", contextWindow: GPT_55_INPUT_CONTEXT },
  ],

  contextWindowOverrides: [["gpt-5.5", GPT_55_INPUT_CONTEXT]],

  // Specific overrides first → shared patterns → generic catch-alls last.
  contextWindows: [
    // Claude (both dot/hyphen styles)
    ["claude-opus-4-8", 1_000_000],
    ["claude-opus-4.8", 1_000_000],
    ["claude-opus-4-7", 1_000_000],
    ["claude-opus-4.7", 1_000_000],
    ["claude-opus-4-6", 1_000_000],
    ["claude-opus-4.6", 1_000_000],
    ["claude-sonnet-4-6", 1_000_000],
    ["claude-sonnet-4.6", 1_000_000],
    ["claude-sonnet-4-5", 200_000],
    ["claude-sonnet-4.5", 200_000],
    ["claude-opus-4-5", 200_000],
    ["claude-opus-4.5", 200_000],
    ["claude-sonnet-4", 200_000],
    ["claude-opus-4", 200_000],
    ["claude-haiku-4", 200_000],
    ["claude-3.7-sonnet", 200_000],
    ["claude-3-7-sonnet", 200_000],
    ["claude-3.5-sonnet", 200_000],
    ["claude-3-5-sonnet", 200_000],
    ["claude-3.5-haiku", 200_000],
    ["claude-3-5-haiku", 200_000],
    // GPT
    ["gpt-5.5", GPT_55_INPUT_CONTEXT],
    ["gpt-5-chat", 128_000],
    ["gpt-4.1", 1_048_576],
    // Grok
    ["grok-4.1", 2_000_000],
    ["grok-4-1", 2_000_000],
    ["grok-4.20", 2_000_000],
    ["grok-4-20", 2_000_000],
    // Llama
    ["llama-4-scout", 327_680],
    ["llama-3.2", 131_072],
    ["llama-3.1", 131_072],
    // Shared patterns
    ...SHARED_CONTEXT_WINDOWS,
    // Generic catch-alls AFTER shared
    ["gpt-5.4", 1_050_000],
    ["gpt-5", 400_000],
    ["gpt-4", 128_000],
    ["qwen3.5", 262_144],
    ["qwen3", 131_072],
    ["qwen2.5", 32_768],
    ["qwen", 32_768],
    ["mistral-large", 128_000],
    ["mistral-medium", 131_072],
    ["mistral-small", 32_768],
    ["mistral", 128_000],
    ["gemma-3", 131_072],
    ["gemma", 128_000],
    ["grok", 131_072],
    ["llama", 131_072],
  ],
};
