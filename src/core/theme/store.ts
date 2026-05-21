import { create } from "zustand";
import { BUILTIN_THEMES, DARK_THEME, normalizeTokenKey, type ThemeTokens } from "./tokens.js";

interface ThemeState {
  name: string;
  tokens: ThemeTokens;
  setTheme: (name: string, tokens: ThemeTokens) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  name: "proxysoul-coffee",
  tokens: BUILTIN_THEMES["proxysoul-coffee"] ?? DARK_THEME,
  setTheme: (name, tokens) => set({ name, tokens }),
}));

/** Convenience hook — returns just the tokens */
export function useTheme(): ThemeTokens {
  return useThemeStore((s) => s.tokens);
}

/** Non-hook access for boot.tsx, splash.ts, commands, and other non-React code */
export function getThemeTokens(): ThemeTokens {
  return useThemeStore.getState().tokens;
}

/**
 * Tailwind-style shorthand: tw("brand"), tw("bg-elevated"), tw("text-muted").
 * Accepts both camelCase and kebab-case keys.
 */
export function tw(key: string): string {
  const tokens = useThemeStore.getState().tokens;
  const normalized = normalizeTokenKey(key) as keyof ThemeTokens;
  return tokens[normalized] ?? key;
}
