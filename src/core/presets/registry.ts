import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../platform/index.js";

const REGISTRY_URL =
  "https://raw.githubusercontent.com/proxysoul/soulforge-presets/main/registry.json";

function getCacheDirInternal(): string {
  return join(configDir(), "presets");
}
function getRegistryCacheFile(): string {
  return join(getCacheDirInternal(), "registry.json");
}
const REGISTRY_TTL_MS = 60 * 60 * 1000; // 1h

export interface RegistryEntry {
  url: string;
  description?: string;
  tags?: string[];
  author?: string;
}

export interface Registry {
  version: number;
  presets: Record<string, RegistryEntry>;
}

function ensureCacheDir(): void {
  const dir = getCacheDirInternal();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readCachedRegistry(): Registry | null {
  const file = getRegistryCacheFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Registry;
  } catch {
    return null;
  }
}

function cacheAge(): number {
  const file = getRegistryCacheFile();
  if (!existsSync(file)) return Number.POSITIVE_INFINITY;
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const NETWORK_TIMEOUT_MS = 10_000;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024; // 2MB

function validateRegistry(parsed: unknown, origin: string): Registry {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Registry at ${origin} is not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!obj.presets || typeof obj.presets !== "object") {
    throw new Error(`Registry at ${origin} has no "presets" map`);
  }
  return obj as unknown as Registry;
}

export async function fetchRegistry(force = false): Promise<Registry> {
  ensureCacheDir();
  if (!force && cacheAge() < REGISTRY_TTL_MS) {
    const cached = readCachedRegistry();
    if (cached) return cached;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_REGISTRY_BYTES) {
      throw new Error(`Registry too large (${text.length} bytes, max ${MAX_REGISTRY_BYTES})`);
    }
    const parsed = validateRegistry(JSON.parse(text), REGISTRY_URL);
    writeFileSync(getRegistryCacheFile(), text);
    return parsed;
  } catch (err) {
    const cached = readCachedRegistry();
    if (cached) return cached;
    throw new Error(
      `Failed to fetch registry from ${REGISTRY_URL}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function getRegistryUrl(): string {
  return REGISTRY_URL;
}

export function getCacheDir(): string {
  return getCacheDirInternal();
}
