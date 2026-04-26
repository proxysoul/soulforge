/**
 * Credential Pool — share API keys across providers with compatible auth.
 *
 * Use cases:
 *   - OpenRouter and other gateways may forward credentials to upstream providers.
 *   - If the user sets ANTHROPIC_API_KEY, we can reuse it for anthropic/ and
 *     any gateway that routes to Anthropic (openrouter/, llmgateway/, etc.)
 *   - Avoids duplicate env vars and "key not set" errors when the model ID
 *     includes a gateway prefix but the user only configured the upstream provider.
 *
 * Pool rules (checked in order):
 *   1. Exact env var match (current behavior, no change).
 *   2. Provider family match (e.g., anthropic/ → ANTHROPIC_API_KEY).
 *   3. Gateway forwards credentials (configured per-gateway in GATEWAY_POOL_MAP).
 */

import { getProviderApiKey } from "../secrets.js";
import { getProvider } from "./providers/index.js";

/** Map of gateway provider ID → upstream provider ID whose credentials are forwarded. */
const GATEWAY_POOL_MAP: Record<string, string> = {
  openrouter: "anthropic",
  llmgateway: "anthropic",
  vercel_gateway: "anthropic",
  opencode_zen: "anthropic",
  opencode_go: "anthropic",
};

/** Provider family → env var name (the "canonical" key for that family). */
const FAMILY_ENV_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  xai: "XAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
};

/**
 * Resolve an API key for a provider, with pool fallback.
 *
 * Order:
 *   1. Direct env var for the provider (e.g., openrouter → OPENROUTER_API_KEY).
 *   2. Canonical family key (e.g., openrouter → ANTHROPIC_API_KEY via gateway map).
 *   3. Gateway forwarding (e.g., openrouter → ANTHROPIC_API_KEY).
 *
 * Returns the key string, or undefined if not found.
 */
export function getPooledApiKey(providerId: string): string | undefined {
  // 1. Direct env var for this provider
  const provider = getProvider(providerId);
  if (provider?.envVar) {
    const direct = getProviderApiKey(provider.envVar);
    if (direct) return direct;
  }

  // 2. Gateway forwarding (e.g., openrouter → anthropic → ANTHROPIC_API_KEY)
  const upstreamId = GATEWAY_POOL_MAP[providerId];
  if (upstreamId) {
    const upstreamProvider = getProvider(upstreamId);
    if (upstreamProvider?.envVar) {
      const upstreamKey = getProviderApiKey(upstreamProvider.envVar);
      if (upstreamKey) return upstreamKey;
    }
  }

  // 3. Check if provider is a known family and try its canonical key
  // (e.g., any custom anthropic-compatible provider → ANTHROPIC_API_KEY)
  for (const [family, envVar] of Object.entries(FAMILY_ENV_MAP)) {
    if (providerId.includes(family) || providerId.startsWith(family)) {
      const key = getProviderApiKey(envVar);
      if (key) return key;
    }
  }

  return undefined;
}

/**
 * Check if a provider has credentials available (direct or pooled).
 */
export function hasPooledCredentials(providerId: string): boolean {
  return Boolean(getPooledApiKey(providerId));
}

/**
 * Get diagnostic info about credential resolution for a provider.
 * Useful for debugging and user-facing messages.
 */
export function getCredentialDiagnostics(providerId: string): {
  providerId: string;
  directEnvVar: string | undefined;
  directKeySet: boolean;
  pooledFrom: string | undefined;
  effectiveKeySet: boolean;
} {
  const provider = getProvider(providerId);
  const directEnvVar = provider?.envVar;
  const directKeySet = directEnvVar ? Boolean(getProviderApiKey(directEnvVar)) : false;

  let pooledFrom: string | undefined;
  if (!directKeySet) {
    const upstreamId = GATEWAY_POOL_MAP[providerId];
    if (upstreamId) {
      const upstreamProvider = getProvider(upstreamId);
      if (upstreamProvider?.envVar) {
        const upstreamKey = getProviderApiKey(upstreamProvider.envVar);
        if (upstreamKey) {
          pooledFrom = upstreamId;
        }
      }
    }
  }

  const effectiveKeySet = directKeySet || Boolean(pooledFrom);

  return {
    providerId,
    directEnvVar,
    directKeySet,
    pooledFrom,
    effectiveKeySet,
  };
}
