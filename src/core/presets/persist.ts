import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../platform/index.js";
import { ensureSoulforgeDir } from "../utils/ensure-soulforge-dir.js";

export type PresetScope = "global" | "project";

function getGlobalDir(): string {
  return configDir();
}
function getGlobalFile(): string {
  return join(getGlobalDir(), "config.json");
}

function resolveScopeFile(scope: PresetScope, cwd: string): string {
  if (scope === "global") {
    const dir = getGlobalDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return getGlobalFile();
  }
  const dir = ensureSoulforgeDir(cwd);
  return join(dir, "config.json");
}

function readJsonObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function dedupeAppend(existing: string[], additions: string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const a of additions) {
    if (!seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

/**
 * Append preset specs to the `presets[]` array of a config scope (global or
 * project). Idempotent: existing entries are kept, duplicates skipped, no
 * other config keys touched. Production-safe — never overwrites the file
 * with a single-key object.
 */
export function appendPresets(
  scope: PresetScope,
  specs: string[],
  cwd: string = process.cwd(),
): { file: string; before: string[]; after: string[] } {
  const file = resolveScopeFile(scope, cwd);
  const existing = readJsonObject(file);
  const currentRaw = existing.presets;
  const current = Array.isArray(currentRaw)
    ? currentRaw.filter((s): s is string => typeof s === "string")
    : [];
  const merged = dedupeAppend(current, specs.filter(Boolean));
  existing.presets = merged;
  writeFileSync(file, JSON.stringify(existing, null, 2));
  return { file, before: current, after: merged };
}

/**
 * Remove preset specs from a scope. Returns the new list. If the array becomes
 * empty, the `presets` key is removed entirely (cleaner config files).
 */
export function removePresets(
  scope: PresetScope,
  specs: string[],
  cwd: string = process.cwd(),
): { file: string; before: string[]; after: string[] } {
  const file = resolveScopeFile(scope, cwd);
  const existing = readJsonObject(file);
  const currentRaw = existing.presets;
  const current = Array.isArray(currentRaw)
    ? currentRaw.filter((s): s is string => typeof s === "string")
    : [];
  const drop = new Set(specs);
  const filtered = current.filter((s) => !drop.has(s));
  if (filtered.length === 0) {
    existing.presets = undefined;
  } else {
    existing.presets = filtered;
  }
  if (existsSync(file)) {
    writeFileSync(file, JSON.stringify(existing, null, 2));
  }
  return { file, before: current, after: filtered };
}

/** Read the `presets[]` array for a scope. Returns [] if missing or invalid. */
export function listPresets(scope: PresetScope, cwd: string = process.cwd()): string[] {
  const file = resolveScopeFile(scope, cwd);
  const existing = readJsonObject(file);
  const raw = existing.presets;
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}
