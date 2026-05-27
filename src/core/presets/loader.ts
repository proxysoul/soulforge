import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { expandHome } from "../platform/index.js";
import { fetchRegistry, getCacheDir } from "./registry.js";

const NETWORK_TIMEOUT_MS = 10_000;
const MAX_PRESET_BYTES = 512 * 1024; // 512KB

export interface Preset {
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  tags?: string[];
  router?: Record<string, unknown>;
  routerRules?: unknown;
  providers?: unknown;
  theme?: unknown;
  themes?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
  config?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ResolvedPreset {
  preset: Preset;
  source: "path" | "url" | "registry";
  origin: string;
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function looksLikePath(s: string): boolean {
  return s.startsWith(".") || s.startsWith("/") || s.startsWith("~") || isAbsolute(s);
}

function expandEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => process.env[key] ?? "");
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandEnv(v);
    return out;
  }
  return value;
}

function validatePreset(raw: unknown, origin: string): Preset {
  const expanded = expandEnv(raw);
  const parsed = PresetSchema.safeParse(expanded);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "<root>";
    throw new Error(`Preset at ${origin}: ${path} — ${issue?.message ?? "invalid shape"}`);
  }
  return parsed.data as Preset;
}

function cacheFile(name: string, version: string): string {
  return join(getCacheDir(), `${name}@${version}.json`);
}

async function fetchPresetFromUrl(url: string): Promise<Preset> {
  if (!/^https:\/\//i.test(url)) {
    throw new Error(`Preset URL must use https:// — got ${url}`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`Fetch ${url} failed: HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_PRESET_BYTES) {
      throw new Error(`Preset too large (${text.length} bytes, max ${MAX_PRESET_BYTES})`);
    }
    const parsed = JSON.parse(text) as Preset;
    const validated = validatePreset(parsed, url);
    try {
      writeFileSync(cacheFile(validated.name, validated.version), text);
    } catch {}
    return validated;
  } finally {
    clearTimeout(timer);
  }
}

function resolveLocalPath(spec: string): string {
  const expanded = expandHome(spec);
  const abs = resolve(expanded);
  if (!existsSync(abs)) throw new Error(`Preset file not found: ${abs}`);
  const stat = lstatSync(abs);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to load preset from symlink: ${abs}`);
  }
  if (!stat.isFile()) throw new Error(`Preset path is not a regular file: ${abs}`);
  if (stat.size > MAX_PRESET_BYTES) {
    throw new Error(`Preset too large (${stat.size} bytes, max ${MAX_PRESET_BYTES})`);
  }
  return abs;
}

export async function resolvePreset(spec: string): Promise<ResolvedPreset> {
  // URL check FIRST — `http://...` and `https://...` look path-ish to the
  // local-path heuristic (they end in .json), so a URL would be mis-resolved.
  if (isUrl(spec) || /^https?:/i.test(spec)) {
    return { preset: await fetchPresetFromUrl(spec), source: "url", origin: spec };
  }
  if (looksLikePath(spec) || spec.endsWith(".json")) {
    const abs = resolveLocalPath(spec);
    const raw = JSON.parse(readFileSync(abs, "utf-8"));
    return { preset: validatePreset(raw, abs), source: "path", origin: abs };
  }
  const registry = await fetchRegistry();
  const entry = registry.presets[spec];
  if (!entry) throw new Error(`Preset "${spec}" not found in registry`);
  return { preset: await fetchPresetFromUrl(entry.url), source: "registry", origin: entry.url };
}

export interface ResolvePresetsOptions {
  onProgress?: (
    spec: string,
    status: "ok" | "failed",
    detail?: { source?: ResolvedPreset["source"]; error?: string },
  ) => void;
  concurrency?: number;
}

/**
 * Resolve specs concurrently, preserving order. Failed specs do not abort the
 * batch — caller inspects ResolvePresetsResult.failures.
 */
export interface ResolvePresetsResult {
  resolved: ResolvedPreset[];
  failures: Array<{ spec: string; error: string }>;
}

export async function resolvePresets(
  specs: string[],
  opts: ResolvePresetsOptions = {},
): Promise<ResolvePresetsResult> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 8));
  const results: (ResolvedPreset | null)[] = new Array(specs.length).fill(null);
  const failures: Array<{ spec: string; error: string }> = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= specs.length) return;
      const spec = specs[idx];
      if (!spec) continue;
      try {
        const r = await resolvePreset(spec);
        results[idx] = r;
        opts.onProgress?.(spec, "ok", { source: r.source });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ spec, error: msg });
        opts.onProgress?.(spec, "failed", { error: msg });
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, specs.length) }, () => worker());
  await Promise.all(workers);
  return {
    resolved: results.filter((r): r is ResolvedPreset => r !== null),
    failures,
  };
}
const PresetSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        "name must be lowercase, start with [a-z0-9], hyphen-separated",
      ),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver (x.y.z)"),
    description: z.string().optional(),
    author: z.string().optional(),
    homepage: z.string().optional(),
    tags: z.array(z.string()).optional(),
    router: z.record(z.string(), z.unknown()).optional(),
    routerRules: z.unknown().optional(),
    providers: z.unknown().optional(),
    theme: z.unknown().optional(),
    themes: z.record(z.string(), z.unknown()).optional(),
    hooks: z.record(z.string(), z.unknown()).optional(),
    prompts: z.record(z.string(), z.unknown()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
