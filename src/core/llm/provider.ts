import type { LanguageModel } from "ai";
import { getProviderApiKey } from "../secrets.js";
import { getAllProviders, getProvider } from "./providers/index.js";

export interface ProviderStatus {
  id: string;
  name: string;
  available: boolean;
  envVar: string;
}

let cachedStatuses: ProviderStatus[] | null = null;
const providerStatusListeners = new Set<(statuses: ProviderStatus[]) => void>();

export function getCachedProviderStatuses(): ProviderStatus[] | null {
  return cachedStatuses;
}

export function subscribeProviderStatuses(
  listener: (statuses: ProviderStatus[]) => void,
): () => void {
  providerStatusListeners.add(listener);
  return () => {
    providerStatusListeners.delete(listener);
  };
}

export async function checkProviders(): Promise<ProviderStatus[]> {
  const results = await Promise.all(
    getAllProviders().map(async (p) => {
      let available: boolean;
      if (p.checkAvailability) {
        available = await p.checkAvailability();
      } else {
        available = p.envVar === "" ? true : Boolean(getProviderApiKey(p.envVar));
      }
      return { id: p.id, name: p.name, envVar: p.envVar, available };
    }),
  );
  cachedStatuses = results;
  for (const listener of providerStatusListeners) listener(results);
  return results;
}

let activeProviderId: string | null = null;

export function getActiveProviderId(): string | null {
  return activeProviderId;
}

function extractProviderId(modelId: string): string {
  const slashIdx = modelId.indexOf("/");
  return slashIdx >= 0 ? modelId.slice(0, slashIdx) : "";
}

/**
 * Notify the provider system that the active model changed.
 * Deactivates the previous provider and activates the new one if they differ.
 */
export async function notifyProviderSwitch(newModelId: string): Promise<void> {
  const newProviderId = extractProviderId(newModelId);

  // Same provider — re-run onActivate so stateful providers (e.g. proxy) can
  // self-heal after a crashed child process. onActivate implementations must
  // be idempotent and cheap when already healthy (ensureProxy healthchecks first).
  if (newProviderId === activeProviderId) {
    const provider = getProvider(newProviderId);
    if (provider?.onActivate) {
      await provider.onActivate();
    }
    for (const listener of providerSwitchListeners) {
      try {
        await listener(newModelId);
      } catch {}
    }
    return;
  }

  const oldProvider = activeProviderId ? getProvider(activeProviderId) : null;
  if (oldProvider?.onDeactivate) {
    oldProvider.onDeactivate();
  }

  activeProviderId = newProviderId;

  const newProvider = getProvider(newProviderId);
  if (newProvider?.onActivate) {
    await newProvider.onActivate();
  }

  for (const listener of providerSwitchListeners) {
    try {
      await listener(newModelId);
    } catch {}
  }
}

/**
 * Deactivate the current provider (e.g. on app shutdown).
 */
export function deactivateCurrentProvider(): void {
  if (activeProviderId) {
    const provider = getProvider(activeProviderId);
    if (provider?.onDeactivate) {
      provider.onDeactivate();
    }
    activeProviderId = null;
  }
}

/**
 * Resolve a model ID (e.g. "anthropic/claude-sonnet-4") to a LanguageModel.
 * Vercel Gateway path: "vercel_gateway/anthropic/claude-opus-4.6" → gateway("anthropic/claude-opus-4.6")
 * Direct path:  "anthropic/claude-opus-4.6" → createAnthropic()("claude-opus-4.6")
 */
export function resolveModel(modelId: string): LanguageModel {
  if (modelId === "none") {
    throw new Error("No model selected — use Ctrl+L or /model to choose a provider and model");
  }
  const slashIdx = modelId.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(`Invalid model ID "${modelId}" — expected "provider/model" format`);
  }

  const providerId = modelId.slice(0, slashIdx);
  const model = modelId.slice(slashIdx + 1);

  const provider = getProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown provider "${providerId}"`);
  }
  return provider.createModel(model);
}
type ProviderSwitchListener = (newModelId: string) => void | Promise<void>;
const providerSwitchListeners = new Set<ProviderSwitchListener>();
/**
 * Subscribe to provider/model switches. Listeners fire AFTER the new
 * provider's onActivate completes. Used by ContextManager to refresh
 * the memory embedder when the user changes models. Listeners must not
 * throw — errors are swallowed.
 */
export function onProviderSwitch(listener: ProviderSwitchListener): () => void {
  providerSwitchListeners.add(listener);
  return () => {
    providerSwitchListeners.delete(listener);
  };
}
