import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logBackgroundError } from "../../stores/errors.js";
import { toErrorMessage } from "../../utils/errors.js";
import { commandExists, configDir, IS_WIN } from "../platform/index.js";
import { trackProcess } from "../process-tracker.js";
import { getVendoredPath, installProxy } from "../setup/install.js";
import {
  candidateApiKeys,
  discoverApiKeys,
  getActiveProxyApiKey,
  primaryConfigPath,
  setActiveProxyApiKey,
} from "./key-resolver.js";

let proxyProcess: ChildProcess | null = null;

const PROXY_URL = process.env.PROXY_API_URL || "http://127.0.0.1:8317/v1";
const PROXY_CONFIG_DIR = join(configDir(), "proxy");
const PROXY_CONFIG_PATH = join(PROXY_CONFIG_DIR, "config.yaml");
const HEALTH_TIMEOUT_MS = 2000;
const STARTUP_POLL_MS = 500;
const STARTUP_POLL_ATTEMPTS = 10;

type ProxyState = "stopped" | "starting" | "running" | "needs-auth" | "error";

let currentState: ProxyState = "stopped";
let lastError: string | null = null;
const stateListeners = new Set<(state: ProxyState, error: string | null) => void>();

function setState(state: ProxyState, error: string | null = null): void {
  currentState = state;
  lastError = error;
  for (const fn of stateListeners) fn(state, error);
}

function getProxyState(): { state: ProxyState; error: string | null } {
  return { state: currentState, error: lastError };
}

const VERSION_FILE = join(PROXY_CONFIG_DIR, "version");

function getInstalledProxyVersion(): string {
  const vendored = getVendoredPath("cli-proxy-api");
  const binaryVersion = vendored ? getBinaryVersion(vendored) : null;

  try {
    if (existsSync(VERSION_FILE)) {
      const v = readFileSync(VERSION_FILE, "utf-8").trim();
      if (v) {
        // If the version file disagrees with the actual binary on disk,
        // trust the binary — the file may be stale from a failed upgrade.
        if (binaryVersion && v !== binaryVersion) {
          saveInstalledProxyVersion(binaryVersion);
          return binaryVersion;
        }
        return v;
      }
    }
  } catch {}
  // Self-heal: if the version file is missing but we have a vendored
  // binary, read the version directly from it. Keeps the status dashboard
  // accurate after a fresh install, cache reset, or file deletion.
  if (binaryVersion) {
    saveInstalledProxyVersion(binaryVersion);
    return binaryVersion;
  }
  return "";
}

function saveInstalledProxyVersion(version: string): void {
  mkdirSync(PROXY_CONFIG_DIR, { recursive: true });
  writeFileSync(VERSION_FILE, version);
}

// Legacy marker from older versions that stamped perf defaults into the
// user's config. We no longer inject anything — just strip the old block
// on first run so upstream CLIProxyAPI defaults take over cleanly.
const LEGACY_PERF_MARKER_PREFIX = "# soulforge-perf-defaults";

function stripLegacyPerfBlock(content: string): string {
  if (!content.includes(LEGACY_PERF_MARKER_PREFIX)) return content;
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.startsWith(LEGACY_PERF_MARKER_PREFIX));
  if (start === -1) return content;
  let end = start + 1;
  while (end < lines.length && lines[end]?.trim() !== "") end++;
  lines.splice(start, end - start);
  return lines.join("\n");
}

function ensureConfig(): void {
  mkdirSync(PROXY_CONFIG_DIR, { recursive: true });

  if (!existsSync(PROXY_CONFIG_PATH)) {
    // Minimal bootstrap config — required so soulforge knows the port and
    // auth key to reach the proxy on. Everything else is left to
    // CLIProxyAPI's own defaults.
    writeFileSync(
      PROXY_CONFIG_PATH,
      [
        "host: 127.0.0.1",
        "port: 8317",
        'auth-dir: "~/.cli-proxy-api"',
        "api-keys:",
        '  - "soulforge"',
        "",
      ].join("\n"),
    );
    return;
  }

  // Existing config — remove any perf block stamped by older soulforge
  // versions so the user's (and CLIProxyAPI's) defaults apply unchanged.
  try {
    const existing = readFileSync(PROXY_CONFIG_PATH, "utf-8");
    const cleaned = stripLegacyPerfBlock(existing);
    if (cleaned !== existing) {
      writeFileSync(PROXY_CONFIG_PATH, cleaned);
    }
  } catch {
    // Don't block startup if config is unreadable
  }
}

/**
 * Run `<binary> -help` and extract the version string. CLIProxyAPI prints
 * "CLIProxyAPI Version: X.Y.Z, ..." as the first line. `-help` exits non-
 * zero on this binary, so we capture output from the thrown error too.
 */
function getBinaryVersion(binary: string): string | null {
  const parse = (s: string): string | null => {
    const m = s.match(/Version:\s*(\d+\.\d+\.\d+)/);
    return m?.[1] ?? null;
  };
  try {
    const out = execFileSync(binary, ["-help"], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parse(out);
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? "");
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
    return parse(stdout + stderr);
  }
}

/** Compare semver-like strings. Missing components treated as 0. */
function compareVersions(a: string, b: string): number {
  const ap = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const bp = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const diff = (ap[i] ?? 0) - (bp[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function getProxyBinary(): string | null {
  // Prefer a system-installed binary (brew, apt, user install) so upgrades
  // managed by the user take effect — but only when it is at least as new
  // as the vendored pin. Brew's `cliproxyapi` formula often lags upstream;
  // falling back to the vendored copy in that case gives users bug fixes
  // without requiring them to juggle formulae.
  const systemBinary = commandExists("cli-proxy-api")
    ? "cli-proxy-api"
    : commandExists("cliproxyapi")
      ? "cliproxyapi"
      : null;
  const vendored = getVendoredPath("cli-proxy-api");

  if (systemBinary && vendored) {
    const sysVersion = getBinaryVersion(systemBinary);
    const vendoredVersion = getBinaryVersion(vendored);
    if (sysVersion && vendoredVersion) {
      if (compareVersions(sysVersion, vendoredVersion) >= 0) return systemBinary;
      logBackgroundError(
        "CLIProxyAPI",
        `system binary v${sysVersion} is older than vendored v${vendoredVersion} — using vendored`,
      );
      return vendored;
    }
    return systemBinary;
  }
  return systemBinary ?? vendored;
}

/**
 * Check whether a process is currently listening on the proxy port.
 * Used to distinguish "no proxy running" from "orphan proxy wedged".
 */
function portIsOccupied(): boolean {
  const portMatch = PROXY_URL.match(/:([0-9]+)/);
  if (!portMatch) return false;
  const port = portMatch[1];
  if (!port) return false;
  try {
    if (IS_WIN) {
      // netstat -ano lists LISTENING state with PID in the last column.
      // findstr filters by port. Any match means the port is occupied.
      const out = execFileSync(
        "cmd.exe",
        ["/c", `netstat -ano | findstr LISTENING | findstr :${port}`],
        {
          encoding: "utf-8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      );
      return parseNetstatPidsForPort(out, port).length > 0;
    }
    try {
      const out = execFileSync("lsof", ["-ti", `tcp:${port}`], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out.length > 0) return true;
    } catch {
      // lsof not installed on this host — fall through to fuser.
    }
    // fuser fallback: prints PIDs on stdout when the TCP port is bound.
    try {
      const out = execFileSync("fuser", [`${port}/tcp`], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out.length > 0;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/** Public: returns true if the proxy answers /v1/models with the active key. */
export async function proxyHealthProbe(): Promise<boolean> {
  return (await healthCheck(getActiveProxyApiKey())) === "ok";
}

async function healthCheck(key: string): Promise<"ok" | "auth-required" | "unreachable"> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`${PROXY_URL}/models`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}` },
    });
    clearTimeout(timeout);
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "auth-required";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

/**
 * Probe each candidate API key against the live proxy until one works.
 * Returns the working key, or null if every candidate was rejected /
 * the proxy is unreachable. The first `auth-required` response caches
 * candidate errors so we can tell the user their keys don't match.
 */
async function probeForWorkingKey(): Promise<
  { key: string; state: "ok" } | { state: "unreachable" } | { state: "auth-required" }
> {
  let sawAuthRequired = false;
  let sawUnreachable = false;
  for (const candidate of candidateApiKeys()) {
    const r = await healthCheck(candidate);
    if (r === "ok") return { key: candidate, state: "ok" };
    if (r === "auth-required") sawAuthRequired = true;
    if (r === "unreachable") sawUnreachable = true;
  }
  if (sawAuthRequired) return { state: "auth-required" };
  if (sawUnreachable) return { state: "unreachable" };
  return { state: "unreachable" };
}

export async function ensureProxy(): Promise<{ ok: boolean; error?: string }> {
  if (currentState === "starting") {
    return { ok: false, error: "Proxy is already starting" };
  }

  // Try every candidate API key (env, default, config files) against a
  // live proxy on the port. A brew-managed service ships with placeholder
  // keys, so "soulforge" alone won't authenticate — we discover whatever
  // key is actually configured.
  const probe = await probeForWorkingKey();
  if (probe.state === "ok") {
    setActiveProxyApiKey(probe.key);
    setState("running");
    return { ok: true };
  }
  if (probe.state === "auth-required") {
    const cfg = primaryConfigPath();
    const discovered = discoverApiKeys();
    if (cfg && discovered.length === 0) {
      // Port answers, but every key listed in the config is a placeholder.
      // Tell the user exactly which file to edit. Do not touch their config.
      const msg = `Proxy rejected every candidate API key. Edit ${cfg} (replace placeholder in \`api-keys:\`) or set PROXY_API_KEY, then restart the proxy.`;
      setState("needs-auth", msg);
      return { ok: false, error: msg };
    }
    setState("needs-auth", "Authentication required — run /proxy login");
    return { ok: false, error: "Authentication required — run /proxy login" };
  }

  // Port is bound but not answering health — orphan from a crashed/wedged
  // previous run. Kill it so our spawn doesn't collide on the listen port.
  if (portIsOccupied()) {
    logBackgroundError("CLIProxyAPI", "orphan process on port — clearing");
    killProxyOnPort();
    await new Promise((r) => setTimeout(r, 200));
  }

  setState("starting");

  const binary = getProxyBinary();
  if (!binary) {
    // Proxy is an opt-in addon — do NOT lazy-install. Surface a clear,
    // actionable error so the user knows exactly what to run.
    const msg = "Proxy addon not installed. Run `soulforge addon install proxy` to install it.";
    setState("error", msg);
    return { ok: false, error: msg };
  }

  ensureConfig();
  try {
    proxyProcess = spawn(binary, ["-config", PROXY_CONFIG_PATH], {
      detached: false,
      stdio: "ignore",
    });
    trackProcess(proxyProcess);
    proxyProcess.on("error", (err) => {
      logBackgroundError("CLIProxyAPI", err.message);
      setState("error", `Process error: ${err.message}`);
      proxyProcess = null;
    });
    proxyProcess.on("exit", (code, signal) => {
      if (code != null && code !== 0) {
        logBackgroundError("CLIProxyAPI", `exited with code ${code}`);
        setState("error", `Process exited with code ${String(code)}`);
      } else if (signal) {
        logBackgroundError("CLIProxyAPI", `killed by ${signal}`);
        if (currentState !== "stopped") {
          setState("error", `Process killed by ${signal}`);
        }
      } else {
        setState("stopped");
      }
      proxyProcess = null;
    });
  } catch (err) {
    const msg = toErrorMessage(err);
    setState("error", `Failed to spawn CLIProxyAPI: ${msg}`);
    return { ok: false, error: `Failed to spawn CLIProxyAPI: ${msg}` };
  }

  for (let i = 0; i < STARTUP_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
    // During post-spawn polling the soulforge-managed proxy uses the
    // vendored config, so the default key is correct. No need to re-probe.
    const status = await healthCheck(getActiveProxyApiKey());
    if (status === "ok") {
      setState("running");
      return { ok: true };
    }
    if (status === "auth-required") {
      setState("needs-auth", "Authentication required — run /proxy login");
      return { ok: false, error: "Authentication required — run /proxy login" };
    }
  }

  stopProxy();
  setState("error", "CLIProxyAPI started but not responding after 5s");
  return {
    ok: false,
    error:
      "CLIProxyAPI started but not responding. You may need to authenticate — run /proxy login",
  };
}

/**
 * Restart the proxy child process. Use after a connection failure that
 * suggests the proxy is wedged (stale upstream session, broken keepalive).
 * Safe to call concurrently — inner ensureProxy early-returns when already
 * "starting". Returns true if the proxy came back healthy.
 */
let bounceInFlight: Promise<boolean> | null = null;
export async function bounceProxy(): Promise<boolean> {
  if (bounceInFlight) return bounceInFlight;
  bounceInFlight = (async () => {
    try {
      stopProxy();
      // Wait for the old process to actually exit and release the port.
      // Without this, ensureProxy()'s healthcheck can hit the still-alive
      // wedged process, see "ok", and skip the fresh spawn entirely.
      await waitForPortFree(3000);
      const res = await ensureProxy();
      return res.ok;
    } catch (err) {
      logBackgroundError("CLIProxyAPI", `bounce failed: ${toErrorMessage(err)}`);
      return false;
    }
  })();
  try {
    return await bounceInFlight;
  } finally {
    bounceInFlight = null;
  }
}

/**
 * Poll until the proxy port is no longer bound, or until timeoutMs elapses.
 * If the process refuses to die, escalate to SIGKILL before giving up.
 */
async function waitForPortFree(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let escalated = false;
  while (Date.now() < deadline) {
    if (!portIsOccupied()) return;
    // Halfway through, escalate to SIGKILL if SIGTERM didn't take.
    if (!escalated && Date.now() - (deadline - timeoutMs) > timeoutMs / 2) {
      escalated = true;
      killProxyOnPort(true);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function stopProxy(): void {
  if (proxyProcess) {
    const pid = proxyProcess.pid;
    try {
      proxyProcess.kill();
    } catch (err) {
      if (pid != null) {
        logBackgroundError(
          "CLIProxyAPI",
          `Failed to kill process ${String(pid)}: ${toErrorMessage(err)}`,
        );
      }
    }
    proxyProcess = null;
  }
  killProxyOnPort();
  setState("stopped");
}

/**
 * Kill any process listening on the proxy port.
 * Catches orphans from previous SoulForge sessions where proxyProcess handle was lost.
 */
function killProxyOnPort(force = false): void {
  const portMatch = PROXY_URL.match(/:([0-9]+)/);
  if (!portMatch) return;
  const port = portMatch[1];
  if (!port) return;

  const pids: number[] = [];

  if (IS_WIN) {
    try {
      // netstat -ano LISTENING line: "  TCP    0.0.0.0:5555    0.0.0.0:0   LISTENING   1234"
      // Capture the trailing PID column.
      const out = execFileSync(
        "cmd.exe",
        ["/c", `netstat -ano | findstr LISTENING | findstr :${port}`],
        {
          encoding: "utf-8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      );
      for (const pid of parseNetstatPidsForPort(out, port)) {
        if (pid !== process.pid) pids.push(pid);
      }
    } catch {
      return;
    }
    for (const pid of pids) {
      // taskkill /F forces termination; /T kills the descendant tree too.
      try {
        execFileSync(
          "taskkill",
          force ? ["/PID", String(pid), "/F", "/T"] : ["/PID", String(pid), "/T"],
          {
            stdio: ["ignore", "ignore", "ignore"],
            timeout: 3000,
            windowsHide: true,
          },
        );
      } catch {}
    }
    return;
  }

  let out = "";
  try {
    // macOS + most Linux: lsof. Silence stderr — lsof writes warnings
    // to stderr on no-match on some platforms.
    out = execFileSync("lsof", ["-ti", `tcp:${port}`], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    try {
      // Linux fallback: fuser. Silence stderr — fuser always writes
      // "<port>/tcp: does not exist" to stderr when no process is on
      // the port, which was leaking into our output.
      out = execFileSync("fuser", [`${port}/tcp`], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return;
    }
  }

  if (!out) return;
  const signal = force ? "SIGKILL" : "SIGTERM";
  for (const token of out.split(/[\s\n]+/)) {
    const pid = Number.parseInt(token.trim(), 10);
    if (pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, signal);
      } catch {}
    }
  }
}

export function getProxyPid(): number | null {
  return proxyProcess?.pid ?? null;
}

interface ProxyProvider {
  id: string;
  name: string;
  flag: string;
  prefix: string;
}

export const PROXY_PROVIDERS: ProxyProvider[] = [
  { id: "claude", name: "Claude", flag: "-claude-login", prefix: "claude-" },
  { id: "google", name: "Google (Gemini)", flag: "-login", prefix: "gemini-" },
  { id: "openai", name: "OpenAI (Codex)", flag: "-codex-login", prefix: "codex-" },
  { id: "codex", name: "Codex (device)", flag: "-codex-device-login", prefix: "codex-" },
  { id: "antigravity", name: "Antigravity", flag: "-antigravity-login", prefix: "antigravity-" },
  { id: "xai", name: "xAI (Grok)", flag: "-xai-login", prefix: "xai-" },
  { id: "kimi", name: "Kimi", flag: "-kimi-login", prefix: "kimi-" },
];

const AUTH_DIR = join(homedir(), ".cli-proxy-api");

export interface ProxyAccount {
  file: string;
  provider: string;
  label: string;
}

export function listProxyAccounts(): ProxyAccount[] {
  if (!existsSync(AUTH_DIR)) return [];
  const files = readdirSync(AUTH_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const base = f.replace(/\.json$/, "");
    const provider =
      PROXY_PROVIDERS.find((p) => base.startsWith(p.prefix))?.name ??
      base.split("-")[0] ??
      "Unknown";
    const label = base.replace(/^[^-]+-/, "");
    return { file: f, provider, label };
  });
}

export function removeProxyAccount(file: string): boolean {
  if (file.includes("/") || file.includes("\\") || file.includes("..")) return false;
  const resolved = join(AUTH_DIR, file);
  if (!resolved.startsWith(AUTH_DIR)) return false;
  if (!existsSync(resolved)) return false;
  unlinkSync(resolved);
  return true;
}

interface ProxyLoginHandle {
  promise: Promise<{ ok: boolean }>;
  abort: () => void;
}

export function runProxyLogin(
  onOutput: (line: string) => void,
  providerFlag?: string,
): ProxyLoginHandle {
  const binary = getProxyBinary();
  if (!binary) {
    onOutput("CLIProxyAPI binary not found. Run /proxy install first.");
    return { promise: Promise.resolve({ ok: false }), abort: () => {} };
  }
  ensureConfig();

  const flag = providerFlag ?? "-claude-login";

  // Credential files for the provider we're logging in as, captured before
  // the login runs. `<flag>` exits 0 after writing a `<prefix>*.json` file to
  // AUTH_DIR (it does NOT start a server), so a new/updated file is the
  // authoritative signal that auth actually succeeded — independent of
  // whether the proxy server is currently healthy.
  const prefix = PROXY_PROVIDERS.find((p) => p.flag === flag)?.prefix ?? "";
  const credSnapshot = snapshotProviderCreds(prefix);

  const proc = spawn(binary, ["-config", PROXY_CONFIG_PATH, flag], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackProcess(proc);

  const handleData = (data: Buffer) => {
    const text = data.toString().trim();
    if (!text) return;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) onOutput(trimmed);
    }
  };

  proc.stdout?.on("data", handleData);
  proc.stderr?.on("data", handleData);

  const promise = new Promise<{ ok: boolean }>((resolve) => {
    proc.on("close", async (code) => {
      // Auth success is decided by the credential file, NOT by code alone and
      // NOT by proxy health: a stale running proxy answers /v1/models with the
      // API key regardless of upstream auth, so ensureProxy() can't tell us
      // whether THIS login worked.
      const authed = code === 0 && credsChangedSince(prefix, credSnapshot);
      if (!authed) {
        resolve({ ok: false });
        return;
      }

      // Credentials landed. Force the live server to pick them up: a proxy
      // that was already running loaded its auth files at startup, before this
      // new credential file existed, so it would otherwise keep serving with
      // stale upstream auth. bounceProxy() stops it, waits for the port to
      // free, and starts fresh. Report auth success regardless of the bounce
      // outcome — the credentials are saved either way.
      try {
        const healthy = await bounceProxy();
        if (!healthy) {
          onOutput("Credentials saved, but the proxy did not come back up. Run /proxy restart.");
        }
      } catch {
        onOutput("Credentials saved, but restarting the proxy failed. Run /proxy restart.");
      }
      resolve({ ok: true });
    });
    proc.on("error", (err) => {
      onOutput(`Login failed: ${err.message}`);
      resolve({ ok: false });
    });
  });

  const abort = () => {
    try {
      proc.kill();
    } catch {}
  };

  return { promise, abort };
}

interface ProxyVersionInfo {
  installed: string;
  latest: string | null;
  updateAvailable: boolean;
}

let cachedLatest: { version: string; checkedAt: number } | null = null;
const VERSION_CACHE_TTL = 10 * 60 * 1000; // 10 min

export async function checkForProxyUpdate(): Promise<ProxyVersionInfo> {
  const installed = getInstalledProxyVersion();
  const now = Date.now();

  if (cachedLatest && now - cachedLatest.checkedAt < VERSION_CACHE_TTL) {
    return {
      installed,
      latest: cachedLatest.version,
      updateAvailable: cachedLatest.version !== installed,
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest",
      {
        signal: controller.signal,
        headers: { Accept: "application/vnd.github+json" },
      },
    );
    clearTimeout(timeout);
    if (!res.ok) return { installed, latest: null, updateAvailable: false };
    const data = (await res.json()) as { tag_name?: string };
    const tag = data.tag_name?.replace(/^v/, "") ?? null;
    if (tag) cachedLatest = { version: tag, checkedAt: now };
    return { installed, latest: tag, updateAvailable: tag != null && tag !== installed };
  } catch {
    return { installed, latest: null, updateAvailable: false };
  }
}

export async function upgradeProxy(
  onStatus: (msg: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  if (!getProxyBinary()) {
    const msg = "Proxy addon not installed. Run `soulforge addon install proxy` to install it.";
    onStatus(msg);
    return { ok: false, error: msg };
  }
  const vinfo = await checkForProxyUpdate();
  if (!vinfo.updateAvailable || !vinfo.latest) {
    return { ok: true };
  }

  const wasRunning = currentState === "running";

  if (wasRunning) {
    onStatus("Stopping proxy…");
    stopProxy();
    await waitForPortFree(3000);
  }

  onStatus(`Downloading CLIProxyAPI v${vinfo.latest}…`);
  try {
    await installProxy(vinfo.latest);
    saveInstalledProxyVersion(vinfo.latest);
  } catch (err) {
    const msg = toErrorMessage(err);
    onStatus(`Upgrade failed: ${msg}`);
    if (wasRunning) {
      onStatus("Restarting proxy with previous version…");
      await ensureProxy();
    }
    return { ok: false, error: msg };
  }

  cachedLatest = null;

  if (wasRunning) {
    onStatus("Starting proxy…");
    const result = await ensureProxy();
    if (!result.ok) {
      onStatus(`Upgraded but failed to restart: ${result.error ?? "unknown"}`);
      return { ok: false, error: result.error };
    }
  }

  onStatus(`Upgraded to v${vinfo.latest}`);
  return { ok: true };
}

interface ProxyStatus {
  installed: boolean;
  binaryPath: string | null;
  running: boolean;
  state: ProxyState;
  endpoint: string;
  pid: number | null;
  models: string[];
  error: string | null;
  version: ProxyVersionInfo | null;
}

export async function fetchProxyStatus(): Promise<ProxyStatus> {
  const binaryPath = getProxyBinary();
  const pid = getProxyPid();
  const { state, error } = getProxyState();
  const status: ProxyStatus = {
    installed: !!binaryPath,
    binaryPath,
    running: false,
    state,
    endpoint: PROXY_URL.replace(/\/v1$/, ""),
    pid,
    models: [],
    error,
    version: null,
  };

  const [, versionInfo] = await Promise.all([
    (async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
        const res = await fetch(`${PROXY_URL}/models`, {
          signal: controller.signal,
          headers: { Authorization: `Bearer ${getActiveProxyApiKey()}` },
        });
        clearTimeout(timeout);
        if (res.ok) {
          status.running = true;
          const data = (await res.json()) as { data?: { id: string }[] };
          status.models = (data.data ?? []).map((m) => m.id);
        }
      } catch (err) {
        status.error = toErrorMessage(err);
      }
    })(),
    checkForProxyUpdate(),
  ]);
  status.version = versionInfo;

  return status;
}
/** Parse `netstat -ano | findstr LISTENING` output and return the PIDs whose
 *  local-address column ends in `:<port>` exactly. findstr alone substring-matches
 *  (`:8317` would catch `:83170`), so we re-tokenise here. */
function parseNetstatPidsForPort(out: string, port: string): number[] {
  const pids: number[] = [];
  const needle = `:${port}`;
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s+/);
    // netstat -ano line: "  TCP    0.0.0.0:5555    0.0.0.0:0   LISTENING   1234"
    // cols indices: 0=proto 1=local 2=foreign 3=state 4=pid
    if (cols.length < 5) continue;
    const local = cols[1] ?? "";
    if (!local.endsWith(needle)) continue;
    const pid = Number.parseInt(cols[cols.length - 1] ?? "0", 10);
    if (Number.isFinite(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}
/**
 * Map of `<prefix>*.json` credential filenames → mtimeMs, taken before a
 * login runs. Compared afterwards by credsChangedSince() to detect whether
 * the login wrote or refreshed a credential file. Empty prefix matches
 * nothing, so an unknown provider flag never reports a false positive.
 */
function snapshotProviderCreds(prefix: string): Map<string, number> {
  const snap = new Map<string, number>();
  if (!prefix || !existsSync(AUTH_DIR)) return snap;
  for (const f of readdirSync(AUTH_DIR)) {
    if (!f.startsWith(prefix) || !f.endsWith(".json")) continue;
    try {
      snap.set(f, statSync(join(AUTH_DIR, f)).mtimeMs);
    } catch {}
  }
  return snap;
}

/**
 * True if a credential file for `prefix` appeared, or an existing one's mtime
 * advanced, since the snapshot. This is the authoritative proof that a login
 * succeeded — CLIProxyAPI's `<flag>` exits 0 after saving creds, and a fresh
 * or rewritten file is the only reliable signal it actually did.
 */
function credsChangedSince(prefix: string, before: Map<string, number>): boolean {
  if (!prefix || !existsSync(AUTH_DIR)) return false;
  for (const f of readdirSync(AUTH_DIR)) {
    if (!f.startsWith(prefix) || !f.endsWith(".json")) continue;
    const prev = before.get(f);
    if (prev === undefined) return true; // new credential file
    try {
      if (statSync(join(AUTH_DIR, f)).mtimeMs > prev) return true; // refreshed
    } catch {}
  }
  return false;
}
