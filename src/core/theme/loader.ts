import { existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { configDir } from "../platform/index.js";
import { useThemeStore } from "./store.js";
import {
  BUILTIN_THEMES,
  DARK_THEME,
  normalizeTokenKey,
  THEME_META,
  type ThemeTokens,
} from "./tokens.js";

const THEMES_DIR = join(configDir(), "themes");
const THEMES_FILE = join(configDir(), "themes.json");

const VALID_KEYS = new Set<string>(Object.keys(DARK_THEME));

/** Normalize user-supplied keys (kebab-case → camelCase) and strip unknown keys */
function normalizeKeys(raw: Record<string, unknown>): Partial<ThemeTokens> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "_extends" || k === "_label" || k === "_description" || k === "_variant") continue;
    const normalized = normalizeTokenKey(k);
    if (VALID_KEYS.has(normalized) && typeof v === "string") {
      result[normalized] = v;
    }
  }
  return result as Partial<ThemeTokens>;
}

interface RawThemeEntry extends Record<string, unknown> {
  _extends?: string;
  _label?: string;
  _description?: string;
  _variant?: string;
}

function loadCustomThemes(): Record<string, RawThemeEntry> {
  const result: Record<string, RawThemeEntry> = {};

  // Load from themes.json (legacy / simple)
  if (existsSync(THEMES_FILE)) {
    try {
      const data = JSON.parse(readFileSync(THEMES_FILE, "utf-8"));
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
          if (typeof val === "object" && val !== null && !Array.isArray(val)) {
            result[key] = val as RawThemeEntry;
          }
        }
      }
    } catch {}
  }

  // Load from individual .json files in themes/ directory
  if (existsSync(THEMES_DIR)) {
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      for (const file of readdirSync(THEMES_DIR)) {
        if (!file.endsWith(".json")) continue;
        try {
          const data = JSON.parse(readFileSync(join(THEMES_DIR, file), "utf-8"));
          if (typeof data === "object" && data !== null && !Array.isArray(data)) {
            const name = file.replace(/\.json$/, "");
            // If name already exists, merge: later values override earlier ones
            if (result[name]) {
              result[name] = { ...result[name], ...data } as RawThemeEntry;
            } else {
              result[name] = data as RawThemeEntry;
            }
          }
        } catch {}
      }
    } catch {}
  }

  return result;
}

/** Resolve a theme by name — checks builtins first, then custom themes.json */
export function resolveTheme(name: string): ThemeTokens {
  if (BUILTIN_THEMES[name]) return BUILTIN_THEMES[name];

  const custom = loadCustomThemes();
  if (custom[name]) {
    const raw = custom[name];
    const extendsBase = typeof raw._extends === "string" ? raw._extends : "dark";
    const base = BUILTIN_THEMES[extendsBase] ?? DARK_THEME;
    const overrides = normalizeKeys(raw);
    return { ...base, ...overrides };
  }

  return BUILTIN_THEMES["proxysoul-coffee"] ?? DARK_THEME;
}

/**
 * Blend a hex color toward black by a given opacity (0–100).
 * 0 = fully transparent, 100 = original color.
 */
function blendBgOpacity(hex: string, opacity: number): string {
  if (opacity <= 0) return "transparent";
  if (opacity >= 100) return hex;
  const h = hex.replace("#", "");
  const r = Math.round((Number.parseInt(h.slice(0, 2), 16) * opacity) / 100);
  const g = Math.round((Number.parseInt(h.slice(2, 4), 16) * opacity) / 100);
  const b = Math.round((Number.parseInt(h.slice(4, 6), 16) * opacity) / 100);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Brighten a hex color toward white by a factor (1.0 = no change, 2.0 = double brightness, clamped to #fff). */
function brighten(hex: string, factor: number): string {
  const h = hex.replace("#", "");
  const r = Math.min(255, Math.round(Number.parseInt(h.slice(0, 2), 16) * factor));
  const g = Math.min(255, Math.round(Number.parseInt(h.slice(2, 4), 16) * factor));
  const b = Math.min(255, Math.round(Number.parseInt(h.slice(4, 6), 16) * factor));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

const BORDER_STRENGTH_FACTOR: Record<BorderStrength, number> = {
  default: 1.0,
  strong: 1.8,
  op: 2.8,
};

export type BorderStrength = "default" | "strong" | "op";

interface TransparencyOptions {
  userMessageOpacity?: number;
  diffOpacity?: number;
  borderStrength?: BorderStrength;
}

/** Resolve theme and push to Zustand store */
export function applyTheme(
  name: string,
  transparent?: boolean,
  opts?: number | TransparencyOptions,
): void {
  // Backward compat: bare number = userMessageOpacity
  const tOpts: TransparencyOptions =
    typeof opts === "number" ? { userMessageOpacity: opts } : (opts ?? {});

  let tokens = resolveTheme(name);
  if (transparent) {
    tokens = { ...tokens, bgApp: "transparent" };
    const msgOp = tOpts.userMessageOpacity;
    if (msgOp != null && msgOp < 100) {
      tokens = { ...tokens, bgUser: blendBgOpacity(tokens.bgUser, msgOp) };
    }
    const diffOp = tOpts.diffOpacity;
    if (diffOp != null && diffOp < 100) {
      tokens = {
        ...tokens,
        diffAddedBg: blendBgOpacity(tokens.diffAddedBg, diffOp),
        diffRemovedBg: blendBgOpacity(tokens.diffRemovedBg, diffOp),
      };
    }
  }
  // Border strength applies regardless of transparent mode
  const bdrStr = tOpts.borderStrength;
  if (bdrStr && bdrStr !== "default") {
    const f = BORDER_STRENGTH_FACTOR[bdrStr];
    tokens = {
      ...tokens,
      border: brighten(tokens.border, f),
      textFaint: brighten(tokens.textFaint, f),
      textSubtle: brighten(tokens.textSubtle, f),
    };
  }
  useThemeStore.getState().setTheme(name, tokens);
}

let watcher: FSWatcher | null = null;

/** Watch ~/.soulforge/themes.json for hot-reload */
export function watchThemes(): void {
  if (watcher) return;
  const reload = () => {
    const { name, tokens } = useThemeStore.getState();
    const isTransparent = tokens.bgApp === "transparent";
    applyTheme(name, isTransparent);
  };

  if (existsSync(THEMES_FILE)) {
    try {
      watcher = watch(THEMES_FILE, reload);
    } catch {}
  }

  if (existsSync(THEMES_DIR)) {
    try {
      const dirWatcher = watch(THEMES_DIR, reload);
      if (!watcher) watcher = dirWatcher;
    } catch {}
  }
}

export interface ResolvedThemeInfo {
  id: string;
  label: string;
  description: string;
  variant: "dark" | "light";
  isCustom: boolean;
  brand: string;
  brandSecondary: string;
  bgPrimary: string;
  textPrimary: string;
}

/** List all available themes with metadata for the picker */
export function listThemes(): ResolvedThemeInfo[] {
  const result: ResolvedThemeInfo[] = [];

  for (const id of Object.keys(BUILTIN_THEMES)) {
    const meta = THEME_META[id];
    const tokens = BUILTIN_THEMES[id] ?? DARK_THEME;
    result.push({
      id,
      label: meta?.label ?? id,
      description: meta?.description ?? "",
      variant: meta?.variant ?? "dark",
      isCustom: false,
      brand: tokens.brand,
      brandSecondary: tokens.brandSecondary,
      bgPrimary: tokens.bgPrimary,
      textPrimary: tokens.textPrimary,
    });
  }

  const custom = loadCustomThemes();
  for (const [id, raw] of Object.entries(custom)) {
    // Skip if it collides with a builtin — custom overrides are handled in resolveTheme
    if (BUILTIN_THEMES[id]) continue;
    const tokens = resolveTheme(id);
    result.push({
      id,
      label: typeof raw._label === "string" ? raw._label : id,
      description: typeof raw._description === "string" ? raw._description : "Custom theme",
      variant: (typeof raw._variant === "string" ? raw._variant : "dark") as "dark" | "light",
      isCustom: true,
      brand: tokens.brand,
      brandSecondary: tokens.brandSecondary,
      bgPrimary: tokens.bgPrimary,
      textPrimary: tokens.textPrimary,
    });
  }

  return result;
}

/** List all available theme names (builtins + custom) */
export function listThemeNames(): string[] {
  const builtins = Object.keys(BUILTIN_THEMES);
  const custom = Object.keys(loadCustomThemes());
  return [...new Set([...builtins, ...custom])];
}
