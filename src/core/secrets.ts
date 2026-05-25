import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, IS_DARWIN, IS_LINUX, IS_WIN } from "./platform/index.js";
import {
  windowsKeychainAvailable,
  windowsKeychainDelete,
  windowsKeychainGet,
  windowsKeychainSet,
} from "./platform/keychain.js";

// Cache for keychain probes — sync `security` exec is ~50-200ms each. Without
// caching, opening the API key popup blocks the UI for seconds while probing
// every provider. Invalidated by setSecret/deleteSecret.
const _keychainHasCache = new Map<string, boolean>();
function _invalidateKeychainCache(key?: string) {
  if (key) _keychainHasCache.delete(key);
  else _keychainHasCache.clear();
}

const SECRETS_DIR = configDir();
const SECRETS_FILE = join(SECRETS_DIR, "secrets.json");
const KEYCHAIN_SERVICE = "soulforge";

let _defaultPriority: "env" | "app" = "env";

export function setDefaultKeyPriority(p: "env" | "app"): void {
  _defaultPriority = p;
}

export function getDefaultKeyPriority(): "env" | "app" {
  return _defaultPriority;
}

/** Secret key identifier — kebab-case string used in keychain/file storage. */
type SecretKey = string;

/**
 * Non-provider secret keys (web search, etc.) that live outside the provider registry.
 * Provider keys are registered dynamically via `registerProviderSecrets()`.
 */
const STATIC_SECRETS: Record<string, string> = {
  "brave-api-key": "BRAVE_SEARCH_API_KEY",
  "jina-api-key": "JINA_API_KEY",
};

/** secretKey → envVar mapping. Initialized with static keys, extended by providers at boot. */
const ENV_MAP: Record<string, string> = { ...STATIC_SECRETS };

/**
 * Register provider secret keys from the provider registry.
 * Called once at boot after providers are loaded — single source of truth.
 */
export function registerProviderSecrets(entries: { secretKey: string; envVar: string }[]): void {
  for (const { secretKey, envVar } of entries) {
    ENV_MAP[secretKey] = envVar;
  }
  // Rebuild reverse lookup
  ENV_TO_SECRET.clear();
  for (const [k, v] of Object.entries(ENV_MAP)) {
    ENV_TO_SECRET.set(v, k);
  }
}

function keychainAvailable(): boolean {
  if (IS_DARWIN) return true;
  if (IS_WIN) return windowsKeychainAvailable();
  if (IS_LINUX) {
    const result = spawnSync("which", ["secret-tool"], { timeout: 2000 });
    return result.status === 0;
  }
  return false;
}

function keychainGet(key: SecretKey): string | null {
  try {
    if (IS_DARWIN) {
      const result = spawnSync(
        "security",
        ["find-generic-password", "-a", KEYCHAIN_SERVICE, "-s", key, "-w"],
        { timeout: 5000, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
      if (result.status === 0 && result.stdout) {
        return result.stdout.trim();
      }
      return null;
    }

    if (IS_WIN) {
      return windowsKeychainGet(key);
    }

    if (IS_LINUX) {
      const result = spawnSync("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "key", key], {
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.status === 0 && result.stdout) {
        return result.stdout.trim();
      }
      return null;
    }
  } catch {}
  return null;
}

function keychainSet(key: SecretKey, value: string): boolean {
  try {
    if (!value) return false;
    if (IS_DARWIN) {
      // We pass the secret via `-w <value>` on argv. The stdin alternative
      // (`-w` with no value, password piped via stdin) does NOT work when the
      // parent has a controlling TTY: `security` opens /dev/tty directly,
      // bypasses the stdio pipe, prints "password data for new item:" to the
      // terminal, and hangs until the 5s timeout. Argv exposure is bounded —
      // `security` runs ~25ms, modern `ps` hides other users' argv, and any
      // attacker on this user account can already read the keychain.
      const result = spawnSync(
        "security",
        ["add-generic-password", "-U", "-a", KEYCHAIN_SERVICE, "-s", key, "-w", value],
        {
          timeout: 5000,
          encoding: "utf-8",
          stdio: ["ignore", "ignore", "ignore"],
        },
      );
      return result.status === 0;
    }

    if (IS_WIN) {
      return windowsKeychainSet(key, value);
    }

    if (IS_LINUX) {
      const result = spawnSync(
        "secret-tool",
        ["store", "--label", `SoulForge ${key}`, "service", KEYCHAIN_SERVICE, "key", key],
        {
          input: value,
          timeout: 5000,
          encoding: "utf-8",
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
      return result.status === 0;
    }
  } catch {}
  return false;
}

function keychainDelete(key: SecretKey): boolean {
  try {
    if (IS_DARWIN) {
      const result = spawnSync(
        "security",
        ["delete-generic-password", "-a", KEYCHAIN_SERVICE, "-s", key],
        { timeout: 5000, stdio: ["ignore", "ignore", "ignore"] },
      );
      return result.status === 0;
    }

    if (IS_WIN) {
      return windowsKeychainDelete(key);
    }

    if (IS_LINUX) {
      const result = spawnSync("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "key", key], {
        timeout: 5000,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return result.status === 0;
    }
  } catch {}
  return false;
}

function fileRead(): Record<string, string> {
  try {
    if (existsSync(SECRETS_FILE)) {
      return JSON.parse(readFileSync(SECRETS_FILE, "utf-8")) as Record<string, string>;
    }
  } catch {}
  return {};
}

function fileWrite(data: Record<string, string>): void {
  if (!existsSync(SECRETS_DIR)) {
    mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(SECRETS_FILE, JSON.stringify(data, null, 2));
  // NTFS has no POSIX perms — %APPDATA% is user-only by default ACL inheritance.
  if (!IS_WIN) {
    chmodSync(SECRETS_FILE, 0o600);
  }
}

export type KeyPriority = "env" | "app";

export interface SecretSources {
  env: boolean;
  keychain: boolean;
  file: boolean;
  active: "env" | "keychain" | "file" | "none";
}

export function getSecretSources(
  key: SecretKey,
  priority: KeyPriority = _defaultPriority,
): SecretSources {
  const envVar = ENV_MAP[key];
  const hasEnv = !!(envVar && process.env[envVar]);
  let hasKeychain = false;
  if (keychainAvailable()) {
    const cached = _keychainHasCache.get(key);
    if (cached !== undefined) {
      hasKeychain = cached;
    } else {
      hasKeychain = !!keychainGet(key);
      _keychainHasCache.set(key, hasKeychain);
    }
  }
  const hasFile = !!fileRead()[key];

  let active: SecretSources["active"] = "none";
  if (priority === "app") {
    if (hasKeychain) active = "keychain";
    else if (hasFile) active = "file";
    else if (hasEnv) active = "env";
  } else {
    if (hasEnv) active = "env";
    else if (hasKeychain) active = "keychain";
    else if (hasFile) active = "file";
  }

  return { env: hasEnv, keychain: hasKeychain, file: hasFile, active };
}

export function getSecret(key: SecretKey, priority: KeyPriority = _defaultPriority): string | null {
  const envVar = ENV_MAP[key];
  const getEnv = () => (envVar ? (process.env[envVar] ?? null) : null);
  const getApp = () => {
    if (keychainAvailable()) {
      const value = keychainGet(key);
      if (value) return value;
    }
    return fileRead()[key] ?? null;
  };

  if (priority === "app") {
    return getApp() ?? getEnv();
  }
  return getEnv() ?? getApp();
}

interface SetSecretResult {
  success: boolean;
  storage: "keychain" | "file";
  path?: string;
}

export function setSecret(key: SecretKey | string, value: string): SetSecretResult {
  if (keychainAvailable()) {
    if (keychainSet(key as SecretKey, value)) {
      _invalidateKeychainCache(key);
      const data = fileRead();
      if (data[key]) {
        delete data[key];
        fileWrite(data);
      }
      return { success: true, storage: "keychain" };
    }
  }

  const data = fileRead();
  data[key] = value;
  fileWrite(data);
  return { success: true, storage: "file", path: SECRETS_FILE };
}

/** @deprecated Use `setSecret` directly — it now accepts arbitrary string keys. */
export function setCustomSecret(label: string, value: string): SetSecretResult {
  return setSecret(label, value);
}

export function deleteSecret(key: SecretKey): { success: boolean; storage: "keychain" | "file" } {
  let deleted = false;
  let storage: "keychain" | "file" = "file";

  if (keychainAvailable()) {
    deleted = keychainDelete(key);
    if (deleted) storage = "keychain";
    _invalidateKeychainCache(key);
  }

  const data = fileRead();
  if (data[key]) {
    delete data[key];
    fileWrite(data);
    deleted = true;
  }

  return { success: deleted, storage };
}

export function hasSecret(
  key: SecretKey,
  priority: KeyPriority = _defaultPriority,
): {
  set: boolean;
  source: "env" | "keychain" | "file" | "none";
} {
  const sources = getSecretSources(key, priority);
  return { set: sources.active !== "none", source: sources.active };
}

export function getStorageBackend(): "keychain" | "file" {
  return keychainAvailable() ? "keychain" : "file";
}

export type { SecretKey };

/** Reverse lookup: given an env var name, find its SecretKey */
const ENV_TO_SECRET = new Map(Object.entries(ENV_MAP).map(([k, v]) => [v, k as SecretKey]));

/**
 * Resolve a provider API key: checks process.env first, then secrets store.
 * Used by provider createModel/fetchModels as a drop-in for process.env[envVar].
 */
export function getProviderApiKey(
  envVar: string,
  priority: KeyPriority = _defaultPriority,
): string | undefined {
  const secretKey = ENV_TO_SECRET.get(envVar);
  if (secretKey) return getSecret(secretKey, priority) ?? undefined;

  const getEnv = () => process.env[envVar] ?? undefined;
  const getApp = () => {
    if (keychainAvailable()) {
      const value = keychainGet(envVar as SecretKey);
      if (value) return value;
    }
    return fileRead()[envVar] ?? undefined;
  };

  if (priority === "app") {
    return getApp() ?? getEnv();
  }
  return getEnv() ?? getApp();
}
