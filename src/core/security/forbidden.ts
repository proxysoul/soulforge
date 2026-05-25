import { existsSync, readFileSync, realpathSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { configDir } from "../platform/index.js";
import { ensureSoulforgeDir } from "../utils/ensure-soulforge-dir.js";

/**
 * Forbidden file guard — prevents the LLM from reading or editing sensitive files.
 *
 * Config priority: session patterns > project (.soulforge/forbidden.json) > global (~/.soulforge/forbidden.json)
 * Built-in defaults always apply and cannot be removed.
 */

const BUILTIN_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "*.pub", // SSH public keys (usually fine but safer to block)
  "credentials.json",
  "service-account*.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".docker/config.json",
  "token.json",
  "tokens.json",
  "**/aws/credentials",
  "**/.aws/credentials",
  ".htpasswd",
];

interface ForbiddenConfig {
  /** Glob-like patterns to block (e.g. ".env", "*.pem", "secrets/**") */
  patterns: string[];
}

let globalPatterns: string[] = [];
let projectPatterns: string[] = [];
const sessionPatternsMap = new Map<string, string[]>();
let aiIgnorePatterns: string[] = [];
let initialized = false;
let aiIgnoreWatcher: ReturnType<typeof watch> | null = null;
const regexCache = new Map<string, RegExp>();

function globToRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0DOUBLESTAR\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0DOUBLESTAR\0/g, ".*")
    .replace(/\?/g, ".");
  const regex = new RegExp(`(^|/)${re}$`, "i");
  regexCache.set(pattern, regex);
  return regex;
}

function loadPatternsFromFile(filePath: string): string[] {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ForbiddenConfig;
    return Array.isArray(parsed.patterns) ? parsed.patterns : [];
  } catch {
    return [];
  }
}

/** Parse a .gitignore / .aiignore style file into patterns */
function parseIgnoreFile(filePath: string): string[] {
  try {
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

export function initForbidden(cwd: string): void {
  const globalFile = join(configDir(), "forbidden.json");
  const projectFile = join(cwd, ".soulforge", "forbidden.json");

  // Migration fallback: if the canonical location is empty but the historic
  // `~/.soulforge/forbidden.json` exists, honour the legacy file so upgrade
  // installs don't silently lose user blocks. New writes always go to the
  // canonical configDir().
  if (existsSync(globalFile)) {
    globalPatterns = loadPatternsFromFile(globalFile);
  } else {
    const legacyFile = join(homedir(), ".soulforge", "forbidden.json");
    if (legacyFile !== globalFile && existsSync(legacyFile)) {
      globalPatterns = loadPatternsFromFile(legacyFile);
    } else {
      globalPatterns = [];
    }
  }
  projectPatterns = loadPatternsFromFile(projectFile);
  sessionPatternsMap.clear();

  const aiIgnorePath = join(cwd, ".aiignore");
  aiIgnorePatterns = parseIgnoreFile(aiIgnorePath);

  if (aiIgnoreWatcher) {
    aiIgnoreWatcher.close();
    aiIgnoreWatcher = null;
  }
  if (existsSync(aiIgnorePath)) {
    try {
      aiIgnoreWatcher = watch(aiIgnorePath, () => {
        aiIgnorePatterns = parseIgnoreFile(aiIgnorePath);
        regexCache.clear();
      });
      aiIgnoreWatcher.unref();
    } catch {}
  }

  initialized = true;
}

/** Add a session-scoped pattern (lost on restart). Optional tabId for per-tab patterns. */
export function addSessionPattern(pattern: string, tabId?: string): void {
  const key = tabId ?? "default";
  const patterns = sessionPatternsMap.get(key) ?? [];
  if (!patterns.includes(pattern)) {
    patterns.push(pattern);
    sessionPatternsMap.set(key, patterns);
  }
}

/** Remove a session-scoped pattern */
export function removeSessionPattern(pattern: string, tabId?: string): void {
  const key = tabId ?? "default";
  const patterns = sessionPatternsMap.get(key) ?? [];
  const filtered = patterns.filter((p) => p !== pattern);
  if (filtered.length > 0) {
    sessionPatternsMap.set(key, filtered);
  } else {
    sessionPatternsMap.delete(key);
  }
}

/** Clear all session patterns for a specific tab */
export function clearTabSessionPatterns(tabId: string): void {
  sessionPatternsMap.delete(tabId);
}

/** Add a pattern to the project config (.soulforge/forbidden.json) */
export function addProjectPattern(cwd: string, pattern: string): void {
  const filePath = join(cwd, ".soulforge", "forbidden.json");
  const existing = loadPatternsFromFile(filePath);
  if (!existing.includes(pattern)) {
    existing.push(pattern);
    ensureSoulforgeDir(cwd);
    writeFileSync(filePath, JSON.stringify({ patterns: existing }, null, 2));
    projectPatterns = existing;
  }
}

/** Remove a pattern from the project config */
export function removeProjectPattern(cwd: string, pattern: string): void {
  const filePath = join(cwd, ".soulforge", "forbidden.json");
  const existing = loadPatternsFromFile(filePath);
  const updated = existing.filter((p) => p !== pattern);
  if (updated.length !== existing.length) {
    writeFileSync(filePath, JSON.stringify({ patterns: updated }, null, 2));
    projectPatterns = updated;
  }
}

/** Get all session patterns merged across all tabs */
function getAllSessionPatterns(tabId?: string): string[] {
  if (tabId) {
    // Return only the specific tab's patterns + default
    const tabPatterns = sessionPatternsMap.get(tabId) ?? [];
    const defaultPatterns = tabId !== "default" ? (sessionPatternsMap.get("default") ?? []) : [];
    return [...new Set([...defaultPatterns, ...tabPatterns])];
  }
  // Return all patterns across all tabs
  const all: string[] = [];
  for (const patterns of sessionPatternsMap.values()) {
    all.push(...patterns);
  }
  return [...new Set(all)];
}

/** Get all active patterns grouped by source */
export function getAllPatterns(tabId?: string): {
  builtin: string[];
  global: string[];
  project: string[];
  session: string[];
  aiignore: string[];
} {
  return {
    builtin: [...BUILTIN_PATTERNS],
    global: [...globalPatterns],
    project: [...projectPatterns],
    session: getAllSessionPatterns(tabId),
    aiignore: [...aiIgnorePatterns],
  };
}

/** Check if a file path is forbidden. Returns the matching pattern or null. */
export function isForbidden(filePath: string, tabId?: string): string | null {
  if (!initialized) return null;

  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch {
    resolved = resolve(filePath);
  }
  const name = basename(resolved);

  const allPatterns = [
    ...BUILTIN_PATTERNS,
    ...globalPatterns,
    ...projectPatterns,
    ...getAllSessionPatterns(tabId),
    ...aiIgnorePatterns,
  ];

  for (const pattern of allPatterns) {
    const re = globToRegex(pattern);
    // Test against both the full path and just the filename
    if (re.test(resolved) || re.test(name)) {
      return pattern;
    }
  }

  return null;
}

/** Build a summary for the system prompt */
export function buildForbiddenContext(tabId?: string): string {
  const all = [
    ...BUILTIN_PATTERNS,
    ...globalPatterns,
    ...projectPatterns,
    ...getAllSessionPatterns(tabId),
    ...aiIgnorePatterns,
  ];
  const unique = [...new Set(all)];
  if (unique.length === 0) return "";
  return [
    "## Forbidden Files (Security)",
    "You MUST NOT read, edit, display, `cat`, `echo`, or access in ANY way files matching these patterns — not even via `shell`.",
    "Do NOT suggest workarounds, alternative commands, or ways to bypass this restriction.",
    "If asked, reply briefly: the file is blocked for security. One sentence max. Do not over-explain.",
    "The user can manage these rules with `/privacy`.",
    `Patterns: ${unique.map((p) => `\`${p}\``).join(", ")}`,
  ].join("\n");
}
