import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir, IS_WIN } from "../platform/index.js";

/**
 * Effective API key soulforge uses to authenticate to CLIProxyAPI.
 *
 * Resolution order:
 *   1. `PROXY_API_KEY` env var (explicit override, always wins)
 *   2. Default `"soulforge"` if the live proxy accepts it
 *   3. First plausible key parsed from a known CLIProxyAPI config file
 *
 * The live probe in `lifecycle.ts` replaces the cached value when it finds
 * a working candidate. Any synchronous read (e.g. provider factory) gets
 * whatever has been resolved most recently. On a cold start this is the
 * default, which matches the vendored config — so the common case is fine
 * without a probe.
 */

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^your[-_]?(?:api[-_]?)?key/i,
  /^changeme$/i,
  /^replace[-_ ]?me/i,
  /^xxx+$/i,
];
const BCRYPT_RE = /^\$2[aby]\$/;
// SHA-256 hex. CLIProxyAPI may hash plaintext keys on startup on some
// configurations; a pre-hashed entry is not usable as an API key.
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

/** Paths checked, in order. First file found wins; others aren't read. */
export function candidateConfigPaths(): string[] {
  const programData = process.env.ProgramData ?? "C:\\ProgramData";
  const paths: (string | undefined)[] = [
    process.env.PROXY_CONFIG_PATH,
    join(configDir(), "proxy", "config.yaml"),
    ...(IS_WIN
      ? [join(programData, "cliproxyapi", "config.yaml"), join(programData, "cliproxyapi.conf")]
      : [
          "/opt/homebrew/etc/cliproxyapi.conf",
          "/opt/homebrew/etc/cliproxyapi/config.yaml",
          "/usr/local/etc/cliproxyapi.conf",
          "/usr/local/etc/cliproxyapi/config.yaml",
          "/etc/cliproxyapi.conf",
          "/etc/cliproxyapi/config.yaml",
          // POSIX-only home-dir fallbacks — silently skipped on Windows.
          join(homedir(), ".config", "cliproxyapi", "config.yaml"),
          join(homedir(), ".cli-proxy-api", "config.yaml"),
        ]),
  ];
  return paths.filter((p): p is string => typeof p === "string" && p.length > 0);
}

export function isPlausibleKey(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  if (PLACEHOLDER_PATTERNS.some((re) => re.test(s))) return false;
  if (BCRYPT_RE.test(s)) return false;
  if (SHA256_HEX_RE.test(s)) return false;
  return true;
}

/**
 * Minimal line-based parser for the `api-keys:` list in a CLIProxyAPI
 * YAML config. CLIProxyAPI's config shape is flat and predictable, so
 * a scanner is safer than pulling in a full YAML dependency for one
 * well-defined field.
 *
 * Handles:
 *   api-keys:
 *     - "foo"
 *     - 'bar'
 *     - baz
 */
export function parseApiKeys(content: string): string[] {
  const lines = content.split("\n");
  const keys: string[] = [];
  let inList = false;
  let listIndent = -1;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    const stripped = line.replace(/^\s*/, "");
    if (stripped.startsWith("#")) continue;
    if (!inList) {
      if (/^api-keys\s*:\s*$/.test(stripped) && !line.startsWith(" ") && !line.startsWith("\t")) {
        inList = true;
        listIndent = -1;
      }
      continue;
    }
    if (stripped === "") continue;
    const indentMatch = line.match(/^(\s+)/);
    const indent = indentMatch?.[1]?.length ?? 0;
    if (indent === 0) break; // sibling key ends the list
    if (listIndent === -1) listIndent = indent;
    if (indent < listIndent) break;
    const item = line.slice(indent).match(/^-\s+(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/);
    if (!item) continue;
    const v = item[1] ?? item[2] ?? item[3] ?? "";
    keys.push(v);
  }
  return keys;
}

export interface DiscoveredKey {
  key: string;
  source: string;
}

/** Scan known config paths and return every plausible key in order. */
export function discoverApiKeys(): DiscoveredKey[] {
  const out: DiscoveredKey[] = [];
  const seen = new Set<string>();
  for (const path of candidateConfigPaths()) {
    try {
      if (!existsSync(path)) continue;
      const content = readFileSync(path, "utf-8");
      for (const k of parseApiKeys(content)) {
        if (!isPlausibleKey(k)) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ key: k, source: path });
      }
    } catch {
      // Unreadable → try next path
    }
  }
  return out;
}

/**
 * Find the config file that contains at least one `api-keys:` entry. Used
 * for the error message when no key works, so we can point the user at the
 * exact file to edit.
 */
export function primaryConfigPath(): string | null {
  for (const path of candidateConfigPaths()) {
    try {
      if (!existsSync(path)) continue;
      const content = readFileSync(path, "utf-8");
      if (/^api-keys\s*:\s*$/m.test(content)) return path;
    } catch {}
  }
  return null;
}

let cached = process.env.PROXY_API_KEY?.trim() || "soulforge";
let cachedIsProbed = false;

export function getActiveProxyApiKey(): string {
  return cached;
}

export function setActiveProxyApiKey(key: string): void {
  cached = key;
  cachedIsProbed = true;
}

export function hasProbedProxyApiKey(): boolean {
  return cachedIsProbed;
}

/**
 * Candidate keys the live probe should try, in priority order.
 * Duplicates are filtered.
 */
export function candidateApiKeys(): string[] {
  const out: string[] = [];
  const push = (v: string | undefined) => {
    if (!v) return;
    const s = v.trim();
    if (!s) return;
    if (!out.includes(s)) out.push(s);
  };
  push(process.env.PROXY_API_KEY);
  push("soulforge");
  for (const d of discoverApiKeys()) push(d.key);
  return out;
}
