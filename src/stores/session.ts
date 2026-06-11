/**
 * App-level session id store.
 *
 * One id per app instance — every tab persists into the *same* session dir.
 * Replaces the previous per-tab `sessionIdRef` scheme that caused stale-tab
 * losses on restore (each tab used to write a different dir, and the resume
 * banner pointed at whichever tab was last active — its dir's snapshot of
 * other tabs could be one render behind, dropping their final messages or
 * even the tab itself).
 *
 * Saves now target `sessions/<appSessionId>/` regardless of which tab fired
 * the write. Reads (loadSession) are unchanged — same dir layout.
 */
import { create } from "zustand";

interface SessionStore {
  /** App-level session id — used as meta.id for every save. */
  appSessionId: string;
  /** Replace the active id (called on restore so subsequent saves target the loaded dir). */
  setAppSessionId: (id: string) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  appSessionId: crypto.randomUUID(),
  setAppSessionId: (id) => set({ appSessionId: id }),
}));

/** Non-React access — refs in useChat read this on every save. */
export function getAppSessionId(): string {
  return useSessionStore.getState().appSessionId;
}

export function setAppSessionId(id: string): void {
  useSessionStore.getState().setAppSessionId(id);
}

/**
 * Active chat/conversation session id — the per-chat id sent to upstream
 * gateways (e.g. LLMGateway `x-session-id`) to pin provider routing for
 * prompt-cache locality. Set by each surface (TUI tab, hearth tab-loop,
 * headless run) immediately before resolving the model for a turn.
 *
 * Distinct from the app/telemetry id: this is conversation-grained, so a
 * cleared or new chat rotates it.
 */
let _activeSessionId: string | null = null;

export function setActiveSessionId(id: string | null): void {
  _activeSessionId = id;
}

export function getActiveSessionId(): string | null {
  return _activeSessionId;
}
