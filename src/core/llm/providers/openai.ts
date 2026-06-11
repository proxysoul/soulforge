import { createOpenAI } from "@ai-sdk/openai";
import { getProviderApiKey } from "../../secrets.js";
import { withSessionHeaders } from "./reasoning-fetch.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

interface OpenAIModel {
  id: string;
  context_window?: number;
}

const OPENAI_PREFIXES = ["gpt-4", "gpt-5", "gpt-3.5", "o1", "o3", "o4", "chatgpt"];

export const openai: ProviderDefinition = {
  id: "openai",
  name: "OpenAI",
  envVar: "OPENAI_API_KEY",
  icon: "󰧑", // nf-md-head_snowflake U+F09D1
  secretKey: "openai-api-key",
  keyUrl: "platform.openai.com",
  asciiIcon: "O",
  description: "GPT & o-series",

  createModel(modelId: string) {
    const apiKey = getProviderApiKey("OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    return createOpenAI({ apiKey, fetch: withSessionHeaders() as typeof fetch })(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey("OPENAI_API_KEY");
    if (!apiKey) return null;
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenAI API ${String(res.status)}`);
    const data = (await res.json()) as { data: OpenAIModel[] };
    const result: ProviderModelInfo[] = [];
    for (const m of data.data) {
      if (OPENAI_PREFIXES.some((p) => m.id.startsWith(p))) {
        result.push({ id: m.id, name: m.id });
      }
    }
    return result;
  },

  fallbackModels: [
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.5-pro", name: "GPT-5.5 Pro" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.4-pro", name: "GPT-5.4 Pro" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
    { id: "gpt-5.4-nano", name: "GPT-5.4 Nano" },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "gpt-5.2", name: "GPT-5.2" },
    { id: "gpt-5.2-pro", name: "GPT-5.2 Pro" },
    { id: "gpt-5.1", name: "GPT-5.1" },
    { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
    { id: "gpt-5", name: "GPT-5" },
    { id: "gpt-5-codex", name: "GPT-5 Codex" },
    { id: "gpt-5-pro", name: "GPT-5 Pro" },
    { id: "gpt-5-mini", name: "GPT-5 Mini" },
    { id: "gpt-5-nano", name: "GPT-5 Nano" },
    { id: "gpt-4.1", name: "GPT-4.1" },
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "o3-pro", name: "o3 Pro" },
    { id: "o4-mini", name: "o4 Mini" },
    { id: "o3-mini", name: "o3 Mini" },
  ],

  contextWindows: [
    ["gpt-5.5-pro", 1_050_000],
    ["gpt-5.5", 1_050_000],
    ["gpt-5.4-pro", 1_050_000],
    ["gpt-5.4-mini", 400_000],
    ["gpt-5.4-nano", 400_000],
    ["gpt-5.4", 1_050_000],
    ["gpt-5.3-codex", 400_000],
    ["gpt-5.2-pro", 400_000],
    ["gpt-5.2", 400_000],
    ["gpt-5.1-codex", 400_000],
    ["gpt-5.1", 400_000],
    ["gpt-5-codex", 400_000],
    ["gpt-5-pro", 400_000],
    ["gpt-5-mini", 400_000],
    ["gpt-5-nano", 400_000],
    ["gpt-5", 400_000],
    ["gpt-4.1", 1_048_576],
    ["gpt-4o-mini", 128_000],
    ["gpt-4o", 128_000],
    ["gpt-4-turbo", 128_000],
    ["gpt-4-32k", 32_000],
    ["gpt-4", 8_192],
    ["gpt-3.5-turbo-16k", 16_000],
    ["gpt-3.5", 4_096],
    ["o3-pro", 200_000],
    ["o4-mini", 200_000],
    ["o3-pro", 200_000],
    ["o3-mini", 200_000],
    ["o3", 200_000],
    ["o1-pro", 200_000],
    ["o1-mini", 128_000],
    ["o1", 200_000],
  ],
};
