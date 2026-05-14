/**
 * Model-events sidecar — read-only observer of LLM call activity.
 *
 * Purpose: per-call timeline (model, latency, tokens, error) for the
 * `/model-events` debug view. Sidecar by design — the existing
 * `useStatusBarStore` token breakdown and `useErrorStore` keep working
 * unchanged; this store is observed in addition.
 *
 * Emitted from:
 *   - src/hooks/useChat.ts        (main loop, on finish-step)
 *   - src/core/agents/agent-runner.ts (subagent runs, on completion)
 *
 * Every emit site wraps the call in try/catch so a bug here cannot
 * affect chat/agent execution.
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type ModelCallSource = "main" | "subagent" | "compaction" | "embed" | "other";
export type ModelCallState = "ok" | "error";

export interface ModelCallEvent {
  id: string;
  modelId: string;
  source: ModelCallSource;
  startedAt: number;
  durationMs: number;
  state: ModelCallState;
  tabId?: string;
  agentId?: string;
  messageId?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  errorMessage?: string;
}

export interface ModelAggregate {
  modelId: string;
  calls: number;
  errors: number;
  totalMs: number;
  avgMs: number;
  lastMs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  lastAt: number;
}

const MAX_EVENTS = 500;

interface ModelEventsState {
  /** Off by default — opt-in for performance. UI flips this. */
  enabled: boolean;
  events: ModelCallEvent[];
  setEnabled: (v: boolean) => void;
  push: (event: Omit<ModelCallEvent, "id"> & { id?: string }) => string | null;
  clear: () => void;
}

export const useModelEventsStore = create<ModelEventsState>()(
  subscribeWithSelector((set, get) => ({
    enabled: false,
    events: [],
    setEnabled: (v) => set(v ? { enabled: true } : { enabled: false, events: [] }),
    push: (event) => {
      if (!get().enabled) return null;
      const id = event.id ?? crypto.randomUUID();
      const full: ModelCallEvent = { ...event, id };
      set((s) => {
        const events =
          s.events.length >= MAX_EVENTS
            ? [...s.events.slice(-(MAX_EVENTS - 1)), full]
            : [...s.events, full];
        return { events };
      });
      return id;
    },
    clear: () => set({ events: [] }),
  })),
);

/**
 * Safe emit — never throws and is a no-op when the sidecar is disabled.
 * The store is a passive observer; if it ever fails (OOM, zustand bug,
 * anything) the LLM call must continue.
 */
export function recordModelCall(event: Omit<ModelCallEvent, "id">): void {
  try {
    const s = useModelEventsStore.getState();
    if (!s.enabled) return;
    s.push(event);
  } catch {}
}

/** Fast path used by hot emit sites to avoid building the event object. */
export function isModelEventsEnabled(): boolean {
  try {
    return useModelEventsStore.getState().enabled;
  } catch {
    return false;
  }
}

/** Roll up events into per-model aggregates. Pure derivation. */
export function aggregateModelEvents(events: readonly ModelCallEvent[]): ModelAggregate[] {
  const byModel = new Map<string, ModelAggregate>();
  for (const ev of events) {
    const prev = byModel.get(ev.modelId) ?? {
      modelId: ev.modelId,
      calls: 0,
      errors: 0,
      totalMs: 0,
      avgMs: 0,
      lastMs: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      lastAt: 0,
    };
    prev.calls += 1;
    if (ev.state === "error") prev.errors += 1;
    prev.totalMs += ev.durationMs;
    prev.lastMs = ev.durationMs;
    prev.input += ev.input ?? 0;
    prev.output += ev.output ?? 0;
    prev.cacheRead += ev.cacheRead ?? 0;
    prev.cacheWrite += ev.cacheWrite ?? 0;
    prev.lastAt = Math.max(prev.lastAt, ev.startedAt + ev.durationMs);
    byModel.set(ev.modelId, prev);
  }
  for (const agg of byModel.values()) {
    agg.avgMs = agg.calls > 0 ? Math.round(agg.totalMs / agg.calls) : 0;
  }
  return [...byModel.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** Filter to just errors — drives the error-feed tab. */
export function modelErrorEvents(events: readonly ModelCallEvent[]): ModelCallEvent[] {
  return events.filter((e) => e.state === "error");
}
