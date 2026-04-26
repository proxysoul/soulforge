import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SECRETS_DIR = join(homedir(), ".soulforge");
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
  if (process.platform === "darwin") return true;
  if (process.platform === "linux") {
    const result = spawnSync("which", ["secret-tool"], { timeout: 2000 });
    return result.status === 0;
  }
  return false;
}

function keychainGet(key: SecretKey): string | null {
  try {
    if (process.platform === "darwin") {
      const result = spawnSync(
        "security",
        ["find-generic-password", "-a", KEYCHAIN_SERVICE, "-s", key, "-w"],
        { timeout: 5000, encoding: "utf-8" },
      );
      if (result.status === 0 && result.stdout) {
        return result.stdout.trim();
      }
      return null;
    }

    if (process.platform === "linux") {
      const result = spawnSync("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "key", key], {
        timeout: 5000,
        encoding: "utf-8",
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
    if (process.platform === "darwin") {
      spawnSync("security", ["delete-generic-password", "-a", KEYCHAIN_SERVICE, "-s", key], {
        timeout: 5000,
      });
      // H3: prior form passed the token as `-w <value>` which is visible in
      // `ps auxww` while `security` runs. The `-w` flag without a value makes
      // `security` read the password from stdin; pipe it in via the `input`
      // option so the secret never touches argv.
      const result = spawnSync(
        "security",
        ["add-generic-password", "-a", KEYCHAIN_SERVICE, "-s", key, "-w"],
        { input: `${value}\n`, timeout: 5000, encoding: "utf-8" },
      );
      return result.status === 0;
    }

    if (process.platform === "linux") {
      const result = spawnSync(
        "secret-tool",
        ["store", "--label", `SoulForge ${key}`, "service", KEYCHAIN_SERVICE, "key", key],
        { input: value, timeout: 5000, encoding: "utf-8" },
      );
      return result.status === 0;
    }
  } catch {}
  return false;
}

function keychainDelete(key: SecretKey): boolean {
  try {
    if (process.platform === "darwin") {
      const result = spawnSync(
        "security",
        ["delete-generic-password", "-a", KEYCHAIN_SERVICE, "-s", key],
        { timeout: 5000 },
      );
      return result.status === 0;
    }

    if (process.platform === "linux") {
      const result = spawnSync("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "key", key], {
        timeout: 5000,
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
  chmodSync(SECRETS_FILE, 0o600);
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
  const hasKeychain = keychainAvailable() && !!keychainGet(key);
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
  const getEnv = () => {
    if (!envVar) return null;
    const val = process.env[envVar];
    if (!val) return null;
    // Check if it's a comma-separated list (multiple keys)
    if (val.includes(",")) {
      const keys = val.split(",").map((k: string) => k.trim()).filter(Boolean);
      if (keys.length > 0) return keys[0] ?? null; // Simplified: just return first for now
    }
    return val;
  };
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

/**
 * Add a key to a pool of multiple keys for a given SecretKey.
 * Stored as a JSON array in the file backend; keychain stores only the first key.
 * Returns the updated list of keys.
 */
export function addPooledKey(key: SecretKey | string, value: string): string[] {
  // For keychain, just overwrite with the new single key (keychain limitation)
  if (keychainAvailable()) {
    keychainSet(key as SecretKey, value);
    return [value];
  }

  const data = fileRead();
  const existing = data[key as string] as string | undefined;
  let keys: string[] = [];
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (Array.isArray(parsed)) keys = parsed as string[];
      else keys = [existing];
    } catch {
      keys = [existing];
    }
  }
  keys.push(value);
  data[key as string] = JSON.stringify(keys);
  fileWrite(data);
  return keys;
}

/**
 * Get all pooled keys for a SecretKey.
 * Returns an array of key strings, or empty array if none set.
 */
export function getPooledKeys(key: SecretKey | string): string[] {
  if (keychainAvailable()) {
    const value = keychainGet(key as SecretKey);
    return value ? [value] : [];
  }

  const data = fileRead();
  const existing = data[key as string] as string | undefined;
  if (!existing) return [];

  try {
    const parsed = JSON.parse(existing) as unknown;
    if (Array.isArray(parsed)) return parsed as string[];
    return [existing];
  } catch {
    return [existing];
  }
}

/**
 * Remove a specific key from the pool.
 */
export function removePooledKey(key: SecretKey | string, value: string): string[] {
  if (keychainAvailable()) {
    keychainDelete(key as SecretKey);
    return [];
  }

  const data = fileRead();
  const existing = data[key as string] as string | undefined;
  if (!existing) return [];

  let keys: string[] = [];
  try {
    keys = JSON.parse(existing) as string[];
    if (!Array.isArray(keys)) keys = [existing];
  } catch {
    keys = [existing];
  }

  keys = keys.filter((k) => k !== value);
  if (keys.length === 0) {
    delete data[key as string];
  } else if (keys.length === 1) {
    data[key as string] = keys[0] ?? ""; // Simplify back to single string
  } else {
    data[key as string] = JSON.stringify(keys);
  }
  fileWrite(data);
  return keys;
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

  const getEnv = () => {
    const val = process.env[envVar];
    if (!val) return undefined;
    // Check if it's a comma-separated list (multiple keys)
    if (val.includes(",")) {
      const keys = val.split(",").map((k: string) => k.trim()).filter(Boolean);
      if (keys.length > 0) return keys[0] ?? undefined; // Simplified: just return first for now
    }
    return val;
  };
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
