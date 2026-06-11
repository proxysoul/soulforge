import { createAnthropic } from "@ai-sdk/anthropic";
import { getProviderApiKey } from "../../secrets.js";
import { withSessionHeaders } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

interface AnthropicModel {
  id: string;
  type: string;
  display_name?: string;
  context_window?: number;
}

export const anthropic: ProviderDefinition = {
  id: "anthropic",
  name: "Claude",
  envVar: "ANTHROPIC_API_KEY",
  icon: "󱜙", // nf-md-* U+F1719
  secretKey: "anthropic-api-key",
  keyUrl: "console.anthropic.com",
  asciiIcon: "A",
  description: "Claude models",

  createModel(modelId: string) {
    const apiKey = getProviderApiKey("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    return createAnthropic({ apiKey, fetch: withSessionHeaders() as typeof fetch })(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey("ANTHROPIC_API_KEY");
    if (!apiKey) return null;
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) throw new Error(`Anthropic API ${String(res.status)}`);
    const data = (await res.json()) as { data: AnthropicModel[] };
    const result: ProviderModelInfo[] = [];
    for (const m of data.data) {
      if (m.type === "model") {
        result.push({
          id: m.id,
          name: m.display_name ?? m.id,
          contextWindow: m.context_window,
        });
      }
    }
    return result;
  },

  fallbackModels: [
    { id: "claude-fable-5", name: "Claude Fable 5" },
    { id: "claude-mythos-5", name: "Claude Mythos 5" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-opus-4", name: "Claude Opus 4" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
    { id: "claude-haiku-4", name: "Claude Haiku 4" },
  ],

  contextWindows: [
    ["claude-fable-5", 1_000_000],
    ["claude-mythos-5", 1_000_000],
    ["claude-opus-4-8", 1_000_000],
    ["claude-opus-4-7", 1_000_000],
    ["claude-opus-4-6", 1_000_000],
    ["claude-sonnet-4-6", 1_000_000],
    ["claude-sonnet-4-5", 200_000],
    ["claude-opus-4-5", 200_000],
    ["claude-sonnet-4", 200_000],
    ["claude-opus-4", 200_000],
    ["claude-haiku-4", 200_000],
    ["claude-3.7-sonnet", 200_000],
    ["claude-3-7-sonnet", 200_000],
    ["claude-3.5-sonnet", 200_000],
    ["claude-3-5-sonnet", 200_000],
    ["claude-3-5-haiku", 200_000],
    ["claude-3.5-haiku", 200_000],
    ["claude-3-opus", 200_000],
    ["claude-3-sonnet", 200_000],
    ["claude-3-haiku", 200_000],
    ["claude", 200_000],
  ],
};
