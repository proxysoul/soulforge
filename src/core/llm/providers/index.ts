export { anthropic } from "./anthropic.js";
export { bedrock } from "./bedrock.js";
export { codex } from "./codex.js";
export { copilot } from "./copilot.js";
export { buildCustomProvider } from "./custom.js";
export { deepseek } from "./deepseek.js";
export { fireworks } from "./fireworks.js";
export { githubModels } from "./github-models.js";
export { google } from "./google.js";
export { groq } from "./groq.js";
export { llmgateway } from "./llmgateway.js";
export { lmstudio } from "./lmstudio.js";
export { minimax } from "./minimax.js";
export { mistral } from "./mistral.js";
export { nim } from "./nim.js";
export { ollama } from "./ollama.js";
export { openai } from "./openai.js";
export { opencodeGo } from "./opencode-go.js";
export { opencodeZen } from "./opencode-zen.js";
export { openrouter } from "./openrouter.js";
export { proxy } from "./proxy.js";
export type { CustomProviderConfig, ProviderDefinition, ProviderModelInfo } from "./types.js";
export { vercelGatewayProvider } from "./vercel-gateway.js";
export { xai } from "./xai.js";
export { zai } from "./zai.js";

import { anthropic } from "./anthropic.js";
import { bedrock } from "./bedrock.js";
import { codex } from "./codex.js";
import { copilot } from "./copilot.js";
import { buildCustomProvider } from "./custom.js";
import { deepseek } from "./deepseek.js";
import { fireworks } from "./fireworks.js";
import { githubModels } from "./github-models.js";
import { google } from "./google.js";
import { groq } from "./groq.js";
import { llmgateway } from "./llmgateway.js";
import { lmstudio } from "./lmstudio.js";
import { minimax } from "./minimax.js";
import { mistral } from "./mistral.js";
import { nim } from "./nim.js";
import { ollama } from "./ollama.js";
import { openai } from "./openai.js";
import { opencodeGo } from "./opencode-go.js";
import { opencodeZen } from "./opencode-zen.js";
import { openrouter } from "./openrouter.js";
import { proxy } from "./proxy.js";
import type { CustomProviderConfig, ProviderDefinition } from "./types.js";
import { vercelGatewayProvider } from "./vercel-gateway.js";
import { xai } from "./xai.js";
import { zai } from "./zai.js";

const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  llmgateway,
  anthropic,
  proxy,
  vercelGatewayProvider,
  openai,
  xai,
  google,
  groq,
  deepseek,
  mistral,
  bedrock,
  fireworks,
  minimax,
  zai,
  nim,
  codex,
  copilot,
  githubModels,
  openrouter,
  opencodeZen,
  opencodeGo,
  ollama,
  lmstudio,
];

let allProviders: ProviderDefinition[] = [...BUILTIN_PROVIDERS];
let providerMap = new Map(allProviders.map((p) => [p.id, p]));

const changeListeners: Array<() => void> = [];

/** Register a callback that fires when custom providers are added. */
export function onProvidersChanged(fn: () => void): void {
  changeListeners.push(fn);
}

export function registerCustomProviders(configs: CustomProviderConfig[]): void {
  const builtinIds = new Set(BUILTIN_PROVIDERS.map((p) => p.id));

  const seen = new Map<string, ProviderDefinition>();
  for (const c of configs) {
    const def = buildCustomProvider(c);
    if (builtinIds.has(c.id) || seen.has(c.id)) {
      def.id = `${c.id}-custom`;
      // If still conflicts (e.g. builtin called "x-custom"), keep appending
      let id = def.id;
      let n = 2;
      while (builtinIds.has(id) || seen.has(id)) {
        id = `${c.id}-custom-${String(n++)}`;
      }
      def.id = id;
    }
    seen.set(def.id, def);
  }

  allProviders = [...BUILTIN_PROVIDERS, ...seen.values()];
  providerMap = new Map(allProviders.map((p) => [p.id, p]));

  for (const fn of changeListeners) fn();
}

export function getProvider(id: string): ProviderDefinition | undefined {
  return providerMap.get(id);
}

const BUILTIN_PROVIDER_IDS = new Set(BUILTIN_PROVIDERS.map((p) => p.id));

/** True for a built-in provider id (custom providers are suffixed "-custom"). */
export function isBuiltinProvider(id: string): boolean {
  return BUILTIN_PROVIDER_IDS.has(id);
}

export function getAllProviders(): ProviderDefinition[] {
  return allProviders;
}

export interface ProviderSecretEntry {
  secretKey: string;
  envVar: string;
  providerId: string;
  label: string;
  keyUrl?: string;
}

/** Derive secret key entries from all registered providers (single source of truth). */
export function getProviderSecretEntries(): ProviderSecretEntry[] {
  return allProviders
    .filter((p): p is typeof p & { secretKey: string } => !!(p.envVar && p.secretKey))
    .map((p) => ({
      secretKey: p.secretKey,
      envVar: p.envVar,
      providerId: p.id,
      label: p.name,
      keyUrl: p.keyUrl,
    }));
}
