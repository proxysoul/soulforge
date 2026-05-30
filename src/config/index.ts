import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CustomProviderConfig } from "../core/llm/providers/types.js";
import { configDir } from "../core/platform/index.js";
import { ensureSoulforgeDir } from "../core/utils/ensure-soulforge-dir.js";
import type { AppConfig, MCPServerConfig } from "../types";

function mergeProviders(
  base?: CustomProviderConfig[],
  overlay?: CustomProviderConfig[],
): CustomProviderConfig[] | undefined {
  if (!base && !overlay) return undefined;
  if (!overlay) return base;
  if (!base) return overlay;

  const map = new Map(base.map((p) => [p.id, p]));
  for (const p of overlay) map.set(p.id, p);
  return [...map.values()];
}

function mergeMCPServers(
  base?: MCPServerConfig[],
  overlay?: MCPServerConfig[],
): MCPServerConfig[] | undefined {
  if (!base && !overlay) return undefined;
  if (!overlay) return base;
  if (!base) return overlay;

  const map = new Map(base.map((s) => [s.name, s]));
  for (const s of overlay) map.set(s.name, s);
  return [...map.values()];
}

function getConfigDir(): string {
  return configDir();
}
function getConfigFile(): string {
  return join(getConfigDir(), "config.json");
}

export const DEFAULT_CONFIG: AppConfig = {
  defaultModel: "none",
  routerRules: [],
  editor: {
    command: "nvim",
    args: [],
  },
  theme: {
    name: "proxysoul-main",
    transparent: true,
  },
  nvimConfig: "default",
  editorIntegration: {
    diagnostics: true,
    symbols: true,
    hover: true,
    references: true,
    definition: true,
    codeActions: true,
    editorContext: true,
    rename: true,
    lspStatus: true,
    format: true,
    syncEditorOnEdit: false,
  },
  codeExecution: true,
  webSearch: true,
  compaction: {
    strategy: "v2",
    triggerThreshold: 0.7,
    resetThreshold: 0.4,
    keepRecent: 4,
    maxToolResults: 30,
    llmExtraction: true,
  },
};

// Preset overlay precomputed at boot. Sync to keep loadConfig() sync for all
// existing call sites. Set via setPresetOverlay() once presets are resolved.
let _presetOverlay: Partial<AppConfig> | null = null;

export function setPresetOverlay(overlay: Partial<AppConfig> | null): void {
  _presetOverlay = overlay;
}

export function getPresetOverlay(): Partial<AppConfig> | null {
  return _presetOverlay;
}

export function loadConfig(): AppConfig {
  const configDir = getConfigDir();
  const configFile = getConfigFile();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  let userConfig: Partial<AppConfig> = {};
  let fileExists = existsSync(configFile);
  if (!fileExists) {
    writeFileSync(configFile, JSON.stringify(DEFAULT_CONFIG, null, 2));
    fileExists = true;
  } else {
    try {
      userConfig = JSON.parse(readFileSync(configFile, "utf-8")) as Partial<AppConfig>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `\n  Error: invalid config.json — ${msg}\n\n` +
          `  Path: ${configFile}\n\n` +
          `  Fix the JSON syntax error and try again.\n` +
          `  (Your config was NOT overwritten.)\n\n`,
      );
      process.exit(1);
    }
  }

  // Layer order: defaults → presets → user (user wins, but only on keys the user
  // explicitly customized vs defaults — otherwise presets would never override
  // the seeded DEFAULT_CONFIG values). Nested objects merge shallow via applyConfigPatch.
  let merged: AppConfig = { ...DEFAULT_CONFIG };
  if (_presetOverlay) merged = applyConfigPatch(merged, _presetOverlay) as AppConfig;
  const userPatch = diffAgainstDefaults(userConfig);
  if (Object.keys(userPatch).length > 0) {
    merged = applyConfigPatch(merged, userPatch) as AppConfig;
  }
  return merged;
}

function diffAgainstDefaults(userConfig: Partial<AppConfig>): Partial<AppConfig> {
  const out: Record<string, unknown> = {};
  const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
  const nested = new Set<string>(NESTED_KEYS);
  for (const [key, value] of Object.entries(userConfig as Record<string, unknown>)) {
    if (value === undefined) continue;
    const def = defaults[key];
    if (
      nested.has(key) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      def &&
      typeof def === "object" &&
      !Array.isArray(def)
    ) {
      // For NESTED_KEYS, diff each subfield so user-untouched subfields
      // do not shadow the preset's nested values.
      const subPatch: Record<string, unknown> = {};
      const defRec = def as Record<string, unknown>;
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (subValue === undefined) continue;
        if (JSON.stringify(subValue) !== JSON.stringify(defRec[subKey])) {
          subPatch[subKey] = subValue;
        }
      }
      if (Object.keys(subPatch).length > 0) out[key] = subPatch;
      continue;
    }
    if (JSON.stringify(value) !== JSON.stringify(def)) {
      out[key] = value;
    }
  }
  return out as Partial<AppConfig>;
}

/** Load project-level config from <cwd>/.soulforge/config.json */
export function loadProjectConfig(cwd: string): Partial<AppConfig> | null {
  const projectFile = join(cwd, ".soulforge", "config.json");
  if (!existsSync(projectFile)) return null;
  try {
    const raw = readFileSync(projectFile, "utf-8");
    return JSON.parse(raw) as Partial<AppConfig>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `\n  Warning: invalid project config.json — ${msg}\n` +
        `  Path: ${projectFile}\n` +
        `  Fix the JSON syntax error. Ignoring project config for now.\n\n`,
    );
    return null;
  }
}

/**
 * Merge configs with priority: project > global.
 * Nested objects (editor, theme) are shallow-merged.
 */
export function mergeConfigs(global: AppConfig, project: Partial<AppConfig> | null): AppConfig {
  const layers: Partial<AppConfig>[] = [global];
  if (project) layers.push(project);

  let merged: AppConfig = { ...global };
  for (const layer of layers.slice(1)) {
    const ei = layer.editorIntegration
      ? { ...merged.editorIntegration, ...layer.editorIntegration }
      : merged.editorIntegration;
    const ci = layer.codeIntelligence
      ? { ...merged.codeIntelligence, ...layer.codeIntelligence }
      : merged.codeIntelligence;
    const th = layer.thinking ? { ...merged.thinking, ...layer.thinking } : merged.thinking;
    const perf = layer.performance
      ? { ...merged.performance, ...layer.performance }
      : merged.performance;
    const cm = layer.contextManagement
      ? { ...merged.contextManagement, ...layer.contextManagement }
      : merged.contextManagement;
    const comp = layer.compaction
      ? { ...merged.compaction, ...layer.compaction }
      : merged.compaction;
    const retry = layer.retry ? { ...merged.retry, ...layer.retry } : merged.retry;
    const providers = mergeProviders(merged.providers, layer.providers);
    const mcpServers = mergeMCPServers(merged.mcpServers, layer.mcpServers);
    merged = {
      ...merged,
      ...layer,
      editor: { ...merged.editor, ...layer.editor },
      theme: { ...merged.theme, ...layer.theme },
      editorIntegration: ei,
      codeIntelligence: ci,
      thinking: th,
      performance: perf,
      contextManagement: cm,
      compaction: comp,
      retry,
      providers,
      mcpServers,
    };
  }
  return merged;
}

/** Save global config to ~/.soulforge/config.json */
export function saveConfig(config: AppConfig): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(getConfigFile(), JSON.stringify(config, null, 2));
}

/** Save a partial config to <cwd>/.soulforge/config.json (deep-merge). */
export function saveProjectConfig(cwd: string, patch: Partial<AppConfig>): void {
  const dir = ensureSoulforgeDir(cwd);
  const file = join(dir, "config.json");

  let existing: Partial<AppConfig> = {};
  try {
    existing = JSON.parse(readFileSync(file, "utf-8")) as Partial<AppConfig>;
  } catch {
    // no existing file
  }

  const merged: Partial<AppConfig> = { ...existing, ...patch };
  if (patch.thinking) merged.thinking = { ...existing.thinking, ...patch.thinking };
  if (patch.performance) merged.performance = { ...existing.performance, ...patch.performance };
  if (patch.contextManagement)
    merged.contextManagement = { ...existing.contextManagement, ...patch.contextManagement };
  if (patch.agentFeatures)
    merged.agentFeatures = { ...existing.agentFeatures, ...patch.agentFeatures };
  if (patch.retry) merged.retry = { ...existing.retry, ...patch.retry };

  writeFileSync(file, JSON.stringify(merged, null, 2));
}

/** Save a partial config to ~/.soulforge/config.json (deep-merge). */
export function saveGlobalConfig(patch: Partial<AppConfig>): void {
  const configDir = getConfigDir();
  const configFile = getConfigFile();
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });

  let existing: AppConfig = DEFAULT_CONFIG;
  try {
    existing = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configFile, "utf-8")) };
  } catch {
    // no existing file
  }

  const merged: AppConfig = { ...existing, ...patch };
  if (patch.thinking) merged.thinking = { ...existing.thinking, ...patch.thinking };
  if (patch.performance) merged.performance = { ...existing.performance, ...patch.performance };
  if (patch.contextManagement)
    merged.contextManagement = { ...existing.contextManagement, ...patch.contextManagement };
  if (patch.agentFeatures)
    merged.agentFeatures = { ...existing.agentFeatures, ...patch.agentFeatures };
  if (patch.retry) merged.retry = { ...existing.retry, ...patch.retry };
  if (patch.addons) merged.addons = { ...existing.addons, ...patch.addons };

  writeFileSync(configFile, JSON.stringify(merged, null, 2));
}

/** Remove specific top-level keys from project config. */
export function removeProjectConfigKeys(cwd: string, keys: string[]): void {
  const file = join(cwd, ".soulforge", "config.json");
  if (!existsSync(file)) return;
  try {
    const existing = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    for (const k of keys) delete existing[k];
    writeFileSync(file, JSON.stringify(existing, null, 2));
  } catch {}
}

/** Remove specific top-level keys from global config. */
export function removeGlobalConfigKeys(keys: string[]): void {
  const configFile = getConfigFile();
  if (!existsSync(configFile)) return;
  try {
    const existing = JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
    for (const k of keys) delete existing[k];
    writeFileSync(configFile, JSON.stringify(existing, null, 2));
  } catch {}
}

const NESTED_KEYS = [
  "editor",
  "theme",
  "editorIntegration",
  "codeIntelligence",
  "thinking",
  "performance",
  "contextManagement",
  "agentFeatures",
  "compaction",
  "retry",
  "addons",
] as const;

export function applyConfigPatch<T extends Partial<AppConfig>>(
  base: T,
  patch: Partial<AppConfig>,
): T {
  const result = { ...base, ...patch } as Record<string, unknown>;
  for (const key of NESTED_KEYS) {
    const b = (base as Record<string, unknown>)[key];
    const p = (patch as Record<string, unknown>)[key];
    if (p && b && typeof b === "object" && typeof p === "object") {
      result[key] = { ...b, ...p };
    }
  }
  return result as T;
}

export function stripConfigKeys<T extends Partial<AppConfig>>(config: T, keys: string[]): T {
  const result = { ...config };
  for (const k of keys) delete (result as Record<string, unknown>)[k];
  return result;
}
