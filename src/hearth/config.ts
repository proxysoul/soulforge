/**
 * Hearth config loader — merges ~/.soulforge/hearth.json and .soulforge/hearth.json
 * and fills defaults. Single source of truth for daemon + approve-cli.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  configDir,
  IS_WIN,
  expandHome as platformExpandHome,
  safeRename,
} from "../core/platform/index.js";
import { makeIpcSocketPath } from "../core/platform/socket.js";
import type {
  ChatBinding,
  ExternalChatId,
  HearthConfig,
  HearthSurfaceConfig,
  SurfaceId,
} from "./types.js";

// All hearth paths live under configDir() (the trust root used by containPath).
// On POSIX that's ~/.soulforge; on Windows it's %APPDATA%\SoulForge.
export const DEFAULT_SOCKET_PATH = IS_WIN
  ? makeIpcSocketPath(`soulforge-hearth-${process.env.USERNAME ?? "user"}`)
  : join(configDir(), "hearth.sock");
export const DEFAULT_STATE_PATH = join(configDir(), "hearth-state.json");
export const DEFAULT_LOG_PATH = join(configDir(), "hearth.log");
export const GLOBAL_CONFIG_PATH = join(configDir(), "hearth.json");

const DEFAULT_AUTO_APPROVE = [
  "read",
  "Read",
  "soul_grep",
  "soul_find",
  "soul_analyze",
  "soul_impact",
  "navigate",
  "Grep",
  "Glob",
  "list_dir",
  "discover_pattern",
];

const DEFAULT_AUTO_DENY = [
  "rm -rf /",
  "rm -rf /*",
  "git push --force*",
  "git push --force-with-lease*",
  "DROP TABLE *",
  "DROP DATABASE *",
];

export function makeDefaultConfig(): HearthConfig {
  return {
    surfaces: {},
    defaults: {
      autoApprove: [...DEFAULT_AUTO_APPROVE],
      autoDeny: [...DEFAULT_AUTO_DENY],
      readDenylistExtra: [],
      maxTabs: 5,
      caps: "main",
    },
    daemon: {
      socketPath: DEFAULT_SOCKET_PATH,
      stateFile: DEFAULT_STATE_PATH,
      logFile: DEFAULT_LOG_PATH,
      maxChats: 20,
      maxTabsPerChat: 5,
      approvalTimeoutMs: 5 * 60_000,
      pairingTtlMs: 10 * 60_000,
    },
  };
}

const HEARTH_MAX_CONFIG_BYTES = 1 * 1024 * 1024; // 1 MiB — a JSON file larger than this is certainly corrupt

function readJsonFile<T>(path: string): Partial<T> | null {
  if (!existsSync(path)) return null;
  try {
    const { statSync } = require("node:fs") as typeof import("node:fs");
    const size = statSync(path).size;
    if (size > HEARTH_MAX_CONFIG_BYTES) {
      // H8: refuse huge/malformed configs instead of OOMing the TUI on boot.
      process.stderr.write(
        `hearth config ${path} is ${String(size)} bytes (> ${String(HEARTH_MAX_CONFIG_BYTES)}); ignoring.\n`,
      );
      return null;
    }
    return JSON.parse(readFileSync(path, "utf-8")) as Partial<T>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  Warning: invalid ${path} — ${msg}. Ignoring.\n`);
    return null;
  }
}

export function containPath(p: string, label: string): string {
  // Hearth's trust root: ~/.soulforge on POSIX, %APPDATA%\SoulForge on Windows.
  // A compromised config cannot redirect the log file or socket to an
  // arbitrary location outside this dir.
  //
  // Exception: named pipes on Windows (\\.\pipe\*) are kernel objects, not
  // filesystem paths — let them through but constrain the leaf-name charset so
  // a config-injected pipe path can't smuggle path-traversal or whitespace.
  if (IS_WIN && p.startsWith("\\\\.\\pipe\\")) {
    const leaf = p.slice(9);
    if (/^[A-Za-z0-9._-]+$/.test(leaf)) return p;
    process.stderr.write(
      `hearth config: ${label}=${p} pipe name contains invalid chars; falling back to default\n`,
    );
    return "";
  }
  const trustRoot = resolve(configDir());
  const abs = resolve(expandHome(p));
  if (abs === trustRoot) return abs;
  if (!abs.startsWith(`${trustRoot}/`) && !abs.startsWith(`${trustRoot}\\`)) {
    process.stderr.write(
      `hearth config: ${label}=${p} escapes ${trustRoot}; falling back to default\n`,
    );
    return "";
  }
  return abs;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Minimal runtime shape guard — rejects a surface block whose allowed/chats
 *  aren't the expected record shape. Prevents adapter crashes on a malformed
 *  hearth.json instead of silently falling open. */
export function validateSurfaceShape(
  sid: string,
  cfg: Partial<HearthSurfaceConfig> | undefined,
): cfg is Partial<HearthSurfaceConfig> {
  if (!cfg) return false;
  if (cfg.allowed !== undefined && !isPlainObject(cfg.allowed)) {
    process.stderr.write(`hearth config: ${sid}.allowed is not an object; dropping surface\n`);
    return false;
  }
  if (cfg.chats !== undefined && !isPlainObject(cfg.chats)) {
    process.stderr.write(`hearth config: ${sid}.chats is not an object; dropping surface\n`);
    return false;
  }
  return true;
}

function mergeSurfaces(
  a: Record<string, HearthSurfaceConfig>,
  b: Record<string, Partial<HearthSurfaceConfig>> | undefined,
): Record<SurfaceId, HearthSurfaceConfig> {
  const out: Record<string, HearthSurfaceConfig> = { ...a };
  for (const [id, cfg] of Object.entries(b ?? {})) {
    const existing = out[id];
    out[id] = {
      enabled: cfg?.enabled ?? existing?.enabled ?? true,
      transport: cfg?.transport ?? existing?.transport,
      chats: { ...(existing?.chats ?? {}), ...(cfg?.chats ?? {}) },
      allowed: { ...(existing?.allowed ?? {}), ...(cfg?.allowed ?? {}) },
    };
  }
  return out as Record<SurfaceId, HearthSurfaceConfig>;
}

export function loadHearthConfig(cwd?: string): HearthConfig {
  const base = makeDefaultConfig();
  const global = readJsonFile<HearthConfig>(GLOBAL_CONFIG_PATH) ?? {};
  const project = cwd
    ? (readJsonFile<HearthConfig>(join(cwd, ".soulforge", "hearth.json")) ?? {})
    : {};

  // H8: drop malformed surface entries rather than crashing surface-factory.
  const filterSurfaces = (
    src: Record<string, Partial<HearthSurfaceConfig>> | undefined,
  ): Record<string, Partial<HearthSurfaceConfig>> => {
    const out: Record<string, Partial<HearthSurfaceConfig>> = {};
    for (const [sid, cfg] of Object.entries(src ?? {})) {
      if (validateSurfaceShape(sid, cfg)) out[sid] = cfg;
    }
    return out;
  };

  const merged: HearthConfig = {
    surfaces: mergeSurfaces(base.surfaces, {
      ...filterSurfaces(global.surfaces),
      ...filterSurfaces(project.surfaces),
    }),
    defaults: {
      ...base.defaults,
      ...(global.defaults ?? {}),
      ...(project.defaults ?? {}),
    },
    daemon: {
      ...base.daemon,
      ...(global.daemon ?? {}),
      ...(project.daemon ?? {}),
    },
  };

  // H7: clamp daemon paths to ~/.soulforge. Empty string → default.
  const socketPath = containPath(merged.daemon.socketPath, "socketPath");
  const stateFile = containPath(merged.daemon.stateFile, "stateFile");
  const logFile = containPath(merged.daemon.logFile, "logFile");
  merged.daemon.socketPath = socketPath || DEFAULT_SOCKET_PATH;
  merged.daemon.stateFile = stateFile || DEFAULT_STATE_PATH;
  merged.daemon.logFile = logFile || DEFAULT_LOG_PATH;
  return merged;
}

function expandHome(p: string): string {
  return platformExpandHome(p);
}

/** Resolve a chat binding with surface+global defaults applied. */
export function resolveChatBinding(
  config: HearthConfig,
  surfaceId: SurfaceId,
  externalId: ExternalChatId,
): ChatBinding | null {
  const surface = config.surfaces[surfaceId];
  if (!surface) return null;
  const chat = surface.chats[externalId];
  if (!chat) return null;

  const cwd = chat.cwd ? resolve(expandHome(chat.cwd)) : null;
  if (!cwd) return null;

  return {
    surfaceId,
    externalId,
    label: chat.label,
    cwd,
    defaultModel: chat.defaultModel,
    mode: chat.mode,
    caps: chat.caps ?? config.defaults.caps,
    autoApprove: chat.autoApprove ?? config.defaults.autoApprove,
    autoDeny: chat.autoDeny ?? config.defaults.autoDeny,
    readDenylistExtra: chat.readDenylistExtra ?? config.defaults.readDenylistExtra,
    dailyTokenBudget: chat.dailyTokenBudget,
    maxTabs: chat.maxTabs ?? config.defaults.maxTabs,
  };
}

export function writeGlobalHearthConfig(config: HearthConfig): void {
  mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true, mode: 0o700 });
  // H9: atomic write via tmp+rename so a crash mid-write can't truncate
  // hearth.json (which would silently drop every pairing on next boot).
  const tmp = `${GLOBAL_CONFIG_PATH}.tmp.${String(process.pid)}.${String(Date.now())}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  safeRename(tmp, GLOBAL_CONFIG_PATH);
}

/** Persist a freshly paired chat into the global config. Idempotent. */
export function upsertChatBinding(
  config: HearthConfig,
  surfaceId: SurfaceId,
  externalId: ExternalChatId,
  patch: Partial<ChatBinding>,
): HearthConfig {
  const surface = config.surfaces[surfaceId] ?? { enabled: true, chats: {}, allowed: {} };
  const existing = surface.chats[externalId] ?? {};
  const next: Partial<ChatBinding> = { ...existing, ...patch, surfaceId, externalId };
  return {
    ...config,
    surfaces: {
      ...config.surfaces,
      [surfaceId]: { ...surface, chats: { ...surface.chats, [externalId]: next } },
    },
  };
}
export const DEFAULT_PID_PATH = join(configDir(), "hearth.pid");
