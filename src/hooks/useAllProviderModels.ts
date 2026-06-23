import { useEffect, useMemo, useState } from "react";
import {
  fetchGroupedModels,
  fetchProviderModels,
  getCachedGroupedModels,
  getCachedModels,
  PROVIDER_CONFIGS,
  type ProviderModelInfo,
} from "../core/llm/models.js";
import { checkProviders, getCachedProviderStatuses } from "../core/llm/provider.js";
import { hasSecret, type SecretKey } from "../core/secrets.js";

const BG_REFRESH_COOLDOWN = 10_000;
let lastBgRefresh = 0;

const ENV_SK: Record<string, SecretKey> = {
  ANTHROPIC_API_KEY: "anthropic-api-key",
  OPENAI_API_KEY: "openai-api-key",
  GOOGLE_GENERATIVE_AI_API_KEY: "google-api-key",
  XAI_API_KEY: "xai-api-key",
  OPENROUTER_API_KEY: "openrouter-api-key",
  LLM_GATEWAY_API_KEY: "llmgateway-api-key",
  AI_GATEWAY_API_KEY: "vercel-gateway-api-key",
};

interface ProviderModelsState {
  items: ProviderModelInfo[];
  loading: boolean;
  error?: string;
}

interface UseAllProviderModelsReturn {
  providerData: Record<string, ProviderModelsState>;
  availability: Map<string, boolean>;
  anyLoading: boolean;
}

function flattenGrouped(r: {
  subProviders: { id: string }[];
  modelsByProvider: Record<string, ProviderModelInfo[]>;
}): ProviderModelInfo[] {
  const out: ProviderModelInfo[] = [];
  for (const s of r.subProviders) for (const m of r.modelsByProvider[s.id] ?? []) out.push(m);
  return out;
}

export function useAllProviderModels(active: boolean): UseAllProviderModelsReturn {
  const [providerData, setProviderData] = useState<Record<string, ProviderModelsState>>(() => {
    // Initialize from cache immediately — prewarmAllModels() populates these at boot
    const init: Record<string, ProviderModelsState> = {};
    for (const cfg of PROVIDER_CONFIGS) {
      if (cfg.grouped) {
        const cached = getCachedGroupedModels(cfg.id);
        init[cfg.id] = cached
          ? { items: flattenGrouped(cached), loading: false }
          : { items: [], loading: true };
      } else {
        const cached = getCachedModels(cfg.id);
        init[cfg.id] = cached ? { items: cached, loading: false } : { items: [], loading: true };
      }
    }
    return init;
  });
  const [availability, setAvailability] = useState<Map<string, boolean>>(() => {
    const cached = getCachedProviderStatuses();
    const map = new Map<string, boolean>();
    if (cached) {
      for (const s of cached) map.set(s.id, s.available);
    } else {
      for (const cfg of PROVIDER_CONFIGS) {
        const sk = cfg.envVar ? ENV_SK[cfg.envVar] : null;
        map.set(cfg.id, sk ? hasSecret(sk).set : true);
      }
    }
    return map;
  });

  useEffect(() => {
    if (!active) return;

    // Re-read caches — prewarmAllModels() may have populated them since initial state
    const init: Record<string, ProviderModelsState> = {};
    for (const cfg of PROVIDER_CONFIGS) {
      if (cfg.grouped) {
        const cached = getCachedGroupedModels(cfg.id);
        init[cfg.id] = cached
          ? { items: flattenGrouped(cached), loading: false }
          : { items: [], loading: true };
      } else {
        const cached = getCachedModels(cfg.id);
        init[cfg.id] = cached ? { items: cached, loading: false } : { items: [], loading: true };
      }
    }

    // Only trigger a re-render if the fresh cache differs from current state.
    // Checks loading/error flags (value comparison) and items (reference
    // comparison — cache returns the same array object on re-read).
    setProviderData((prev) => {
      const initKeys = Object.keys(init);
      const prevKeys = Object.keys(prev);
      if (initKeys.length !== prevKeys.length) return init;
      // Detect replaced keys: same length but different key set
      for (const k of prevKeys) {
        if (!(k in init)) return init;
      }
      for (const k of initKeys) {
        const a = prev[k];
        const b = init[k];
        if (!a || !b || a.loading !== b.loading || a.items !== b.items || a.error !== b.error) {
          return init;
        }
      }
      return prev;
    });

    // Re-sync availability from the global cache (cheap map read).
    // If checkProviders() ran elsewhere (auth flow, config reload) the
    // global cache was updated but our local state wasn't.
    const cachedStatuses = getCachedProviderStatuses();
    if (cachedStatuses) {
      const map = new Map<string, boolean>();
      for (const s of cachedStatuses) map.set(s.id, s.available);
      setAvailability(map);
    }

    let dead = false;

    // Refresh availability in the background even when cache exists.
    // This keeps local providers (e.g. Ollama/LM Studio) from staying stale.
    checkProviders()
      .then((statuses) => {
        if (dead) return;
        const map = new Map<string, boolean>();
        for (const s of statuses) map.set(s.id, s.available);
        setAvailability(map);
      })
      .catch(() => undefined);

    // Background-refresh models — catches proxy upgrades, new deployments, etc.
    // Cooldown prevents hammering when the picker is opened repeatedly.
    // Stamp deferred until fetches land — if picker closes before completion,
    // next open retries instead of serving stale data.
    const now = Date.now();
    const shouldBgRefresh = now - lastBgRefresh >= BG_REFRESH_COOLDOWN;

    const toFetch: { cfg: (typeof PROVIDER_CONFIGS)[number]; wasCached: boolean }[] = [];
    for (const cfg of PROVIDER_CONFIGS) {
      const wasCached = !init[cfg.id]?.loading;
      if (wasCached && !shouldBgRefresh) continue;
      toFetch.push({ cfg, wasCached });
    }

    // Defer the fetch storm one tick so React commits and OpenTUI paints the
    // scrollbox before the worker-thread HTTP burst lands. On Windows the
    // native renderer + io.worker FFI overlapping during mount can segfault
    // (see #120) — separating paint from fetch removes that contention.
    let fetchTimer: ReturnType<typeof setTimeout> | null = null;
    if (toFetch.length > 0) {
      // Collect results, apply as single batch update to avoid N re-renders
      const results = new Map<string, { items: ProviderModelInfo[]; error?: string }>();
      let pending = toFetch.length;

      const flush = () => {
        if (dead) return;
        setProviderData((p) => {
          const next = { ...p };
          for (const [id, val] of results) {
            next[id] = { items: val.items, loading: false, error: val.error };
          }
          return next;
        });
        // Only stamp cooldown after successful flush
        if (shouldBgRefresh) lastBgRefresh = Date.now();
      };

      const done = (id: string, items: ProviderModelInfo[], error?: string) => {
        results.set(id, { items, error });
        if (--pending === 0) flush();
      };

      fetchTimer = setTimeout(() => {
        if (dead) return;
        for (const { cfg, wasCached } of toFetch) {
          const fail = () => {
            if (!wasCached) done(cfg.id, []);
            else if (--pending === 0) flush();
          };

          if (cfg.grouped) {
            fetchGroupedModels(cfg.id, { bypassCache: wasCached })
              .then((r) => done(cfg.id, flattenGrouped(r), r.error))
              .catch(fail);
          } else {
            fetchProviderModels(cfg.id, { bypassCache: wasCached })
              .then((r) => done(cfg.id, r.models, r.error))
              .catch(fail);
          }
        }
      }, 0);
    }

    return () => {
      dead = true;
      if (fetchTimer) clearTimeout(fetchTimer);
    };
  }, [active]);

  const anyLoading = useMemo(
    () => Object.values(providerData).some((p) => p.loading),
    [providerData],
  );

  return { providerData, availability, anyLoading };
}
