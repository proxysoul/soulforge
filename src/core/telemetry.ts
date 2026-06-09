/**
 * Anonymous usage beacon.
 *
 * Fire-and-forget. Sends ONE tiny GET to a Cloudflare Worker when a session
 * starts, so we can count active installs across surfaces (tui / headless /
 * hearth). Never blocks, never throws, never logs on failure.
 *
 * Privacy contract — what we DO and DON'T send:
 *   DO:   app version, os, arch, surface, event, install method, model FAMILY
 *         (claude/openai/…), and a random rotating id used only to count
 *         distinct installs.
 *   DON'T: prompts, file contents/paths, cwd, hostname, username, API keys,
 *         model ids, custom provider URLs, or the client IP (never in payload).
 *
 * Opt-out (any one disables it):
 *   - env DO_NOT_TRACK=1            (cross-tool industry standard)
 *   - env SOULFORGE_TELEMETRY=0
 *   - config { "telemetry": false }
 *
 * Endpoint is a public, unauthenticated write-only beacon URL (custom domain,
 *   no auth, no key, returns 204). Override with SOULFORGE_TELEMETRY_URL for
 *   self-hosting / testing.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./platform/index.js";

export type TelemetrySurface = "tui" | "headless" | "hearth";

const DEFAULT_ENDPOINT = "https://t.soulforge.proxysoul.com/b";

// Stable, install-scoped random id. Identifies an INSTALL, not a person —
// no PII, no machine fingerprint. Stable so distinct-id counts give exact
// DAU / MAU / unique-install / retention metrics.
const ID_FILE = "anon-id.json";

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/** Returns true when the user has opted out by any mechanism. */
export function telemetryDisabled(configEnabled?: boolean): boolean {
  if (truthy(process.env.DO_NOT_TRACK)) return true;
  if (process.env.SOULFORGE_TELEMETRY !== undefined) {
    // Explicit env wins over config: "0"/"false" disables.
    if (!truthy(process.env.SOULFORGE_TELEMETRY)) return true;
  }
  if (configEnabled === false) return true;
  return false;
}

function endpoint(): string {
  return process.env.SOULFORGE_TELEMETRY_URL || DEFAULT_ENDPOINT;
}

/**
 * Read or lazily create the stable anonymous install id — a random UUID
 * persisted at ~/.soulforge/anon-id.json. Stable across runs so distinct-id
 * counts measure unique installs / DAU / MAU exactly. Returns a fresh
 * ephemeral id (never persisted) if the dir is unwritable.
 */
function anonId(): string {
  try {
    const dir = configDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, ID_FILE);
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf-8")) as { id?: string };
      if (data.id) return data.id;
    }
    const id = randomUUID();
    writeFileSync(file, JSON.stringify({ id, ts: Date.now() }), { mode: 0o600 });
    return id;
  } catch {
    return randomUUID();
  }
}

/**
 * One-time, non-blocking notice telling the user telemetry is on and how to
 * disable it. Prints to stderr once (gated on config.telemetryNoticeShown),
 * then persists the flag. No-op when opted out or already shown.
 */
export function maybeShowTelemetryNotice(
  config: { telemetry?: boolean; telemetryNoticeShown?: boolean },
  markShown: () => void,
): void {
  if (telemetryDisabled(config.telemetry)) return;
  if (config.telemetryNoticeShown) return;
  try {
    process.stderr.write(
      "\x1b[2mSoulForge collects anonymous usage stats (version, OS, surface — no prompts, paths, or keys).\n" +
        'Opt out: set "telemetry": false in config, or DO_NOT_TRACK=1.\x1b[0m\n',
    );
    markShown();
  } catch {}
}

function normArch(): string {
  const a = process.arch;
  if (a === "arm64") return "arm64";
  if (a === "x64") return "x64";
  return "other";
}

export interface BeaconFields {
  surface: TelemetrySurface;
  version: string;
  /** Install method (npm/brew/binary/…). Optional. */
  install?: string;
  /** Model FAMILY only (claude/openai/…). Never the model id or key. */
  family?: string;
  /** Provider id (anthropic/llmgateway/…) or "custom". Never a custom URL. */
  provider?: string;
  /** Public base model name (claude-sonnet-4-5/…) or "other". Never custom names. */
  model?: string;
  /** Agent mode (default/architect/plan/auto). Optional. */
  mode?: string;
  /** Coarse terminal bucket (kitty/ghostty/iterm/vscode/other). Optional. */
  terminal?: string;
  /** JS runtime + major version (bun-1/node-22). Optional. */
  runtime?: string;
  /** Whether the repo-map scan was skipped this session ("on"|"skipped"). Optional. */
  repomap?: string;
  event?: "session_start" | "session_end";
}

/** Coarse, non-identifying terminal bucket from env. No PII, no fingerprint. */
export function detectTerminalBucket(): string {
  const term = process.env.TERM_PROGRAM?.toLowerCase() ?? "";
  if (process.env.KITTY_WINDOW_ID || term === "kitty") return "kitty";
  if (term === "ghostty") return "ghostty";
  if (process.env.ITERM_SESSION_ID || term === "iterm.app" || term === "iterm2") return "iterm";
  if (term === "vscode") return "vscode";
  if (process.env.WEZTERM_PANE !== undefined || term === "wezterm") return "wezterm";
  if (term === "warp") return "warp";
  if (process.env.TMUX) return "tmux";
  return "other";
}

/** JS runtime + MAJOR version only (bun-1 / node-22). No build/patch detail. */
export function detectRuntime(): string {
  const bun = process.versions.bun;
  if (bun) return `bun-${bun.split(".")[0]}`;
  const node = process.versions.node;
  if (node) return `node-${node.split(".")[0]}`;
  return "other";
}

/**
 * Fire the beacon. Resolves immediately; the network call runs in the
 * background and is abandoned after 1.5s. Any failure is swallowed.
 */
export function sendBeacon(fields: BeaconFields, configEnabled?: boolean): void {
  if (telemetryDisabled(configEnabled)) return;

  try {
    const params = new URLSearchParams({
      e: fields.event ?? "session_start",
      sf: fields.surface,
      v: fields.version.slice(0, 24),
      os: process.platform,
      ar: normArch(),
      id: anonId(),
    });
    if (fields.install) params.set("im", fields.install.slice(0, 16));
    if (fields.family) params.set("mf", fields.family.slice(0, 20));
    if (fields.provider) params.set("pv", fields.provider.slice(0, 24));
    if (fields.model) params.set("md", fields.model.slice(0, 40));
    if (fields.mode) params.set("mo", fields.mode.slice(0, 16));
    if (fields.terminal) params.set("tm", fields.terminal.slice(0, 16));
    if (fields.runtime) params.set("rt", fields.runtime.slice(0, 16));
    if (fields.repomap) params.set("rm", fields.repomap.slice(0, 8));

    const url = `${endpoint()}?${params.toString()}`;
    // Don't await — fire and forget. Abort quickly so it never lingers.
    // The "soulforge/<version>" UA is the marker the beacon's gate checks to
    // drop drive-by/browser noise — not a secret, just a cheap filter.
    void fetch(url, {
      method: "GET",
      headers: { "user-agent": `soulforge/${fields.version.slice(0, 24)}` },
      signal: AbortSignal.timeout(1500),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Never let telemetry affect the app.
  }
}
