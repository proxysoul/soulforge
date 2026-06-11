import { createXai } from "@ai-sdk/xai";
import { getProviderApiKey } from "../../secrets.js";
import { withSessionHeaders } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

interface XaiModel {
  id: string;
  context_window?: number;
}

export const xai: ProviderDefinition = {
  id: "xai",
  name: "Grok",
  envVar: "XAI_API_KEY",
  icon: "\uF0E7", // nf-fa-bolt U+F0E7
  secretKey: "xai-api-key",
  keyUrl: "console.x.ai",
  asciiIcon: "X",
  description: "Grok models",

  createModel(modelId: string) {
    const apiKey = getProviderApiKey("XAI_API_KEY");
    if (!apiKey) {
      throw new Error("XAI_API_KEY is not set");
    }
    return createXai({ apiKey, fetch: withSessionHeaders() as typeof fetch })(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey("XAI_API_KEY");
    if (!apiKey) return null;
    const res = await fetch("https://api.x.ai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`xAI API ${String(res.status)}`);
    const data = (await res.json()) as { data: XaiModel[] };
    const result: ProviderModelInfo[] = [];
    for (const m of data.data) {
      if (!m.id.includes("embed")) {
        result.push({ id: m.id, name: m.id, contextWindow: m.context_window });
      }
    }
    return result;
  },

  fallbackModels: [
    { id: "grok-4.3", name: "Grok 4.3" },
    { id: "grok-4.20", name: "Grok 4.20" },
    { id: "grok-4.1-fast", name: "Grok 4.1 Fast" },
    { id: "grok-4-fast", name: "Grok 4 Fast" },
    { id: "grok-4", name: "Grok 4" },
    { id: "grok-code-fast-1", name: "Grok Code Fast 1" },
    { id: "grok-3", name: "Grok 3" },
    { id: "grok-3-mini", name: "Grok 3 Mini" },
  ],

  contextWindows: [
    ["grok-4.3", 2_000_000],
    ["grok-4.20", 2_000_000],
    ["grok-4.1-fast", 2_000_000],
    ["grok-4-fast", 2_000_000],
    ["grok-code-fast-1", 256_000],
    ["grok-4.1", 2_000_000],
    ["grok-4.20", 2_000_000],
    ["grok-4", 256_000],
    ["grok-3", 131_072],
    ["grok-2", 131_072],
    ["grok", 131_072],
  ],
};
