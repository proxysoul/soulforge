import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PKG_NAME = "@proxysoul/soulforge";
const CONFIG_DIR = configDir();
const VERSION_CACHE_FILE = join(CONFIG_DIR, "version-cache.json");
const CACHE_TTL = 30 * 60 * 1000; // 30 min
const DISMISSED_FILE = join(CONFIG_DIR, "update-dismissed.json");

// ── Current version ──────────────────────────────────────────────────
// Read from package.json at import time. Works in dev (bun run) and
// in compiled binaries (Bun embeds JSON imports).

// Static import — bundler inlines this at build time.
// Works in dev (bun resolves from src/core/), dist bundle, and compiled binary.
import pkgJson from "../../package.json";
import { configDir, IS_WIN, isCompiledBinary, localAppData } from "./platform/index.js";

const _currentVersion: string = pkgJson.version ?? "0.0.0";

export const CURRENT_VERSION: string = _currentVersion;

// ── Install method detection ─────────────────────────────────────────

export type InstallMethod = "npm" | "pnpm" | "yarn" | "bun" | "brew" | "binary" | "unknown";

export function detectInstallMethod(): InstallMethod {
  try {
    const execPath = process.argv[0] ?? "";
    const moduleUrl = import.meta.url;

    // Homebrew — the brew formula installs a compiled binary to Cellar with
    // a symlink at $HOMEBREW_PREFIX/bin/soulforge. But ~/.soulforge/bin/ may
    // shadow it in PATH, so `which` and argv[0] are unreliable. Check:
    //   1. `which soulforge` contains homebrew/Cellar (works when not shadowed)
    //   2. argv[0]/execPath directly contains a Cellar/homebrew path
    //   3. $HOMEBREW_PREFIX/bin/soulforge exists as a symlink (bypasses PATH)
    // Skip POSIX-only `which` / homebrew probes on Windows entirely.
    if (!IS_WIN) {
      try {
        const which = execFileSync("which", ["soulforge"], {
          encoding: "utf8",
          timeout: 2000,
        }).trim();
        if (which.includes("homebrew") || which.includes("Cellar")) return "brew";
      } catch {}

      if (execPath.includes("/Cellar/") || execPath.includes("/homebrew/")) return "brew";
    }

    // Windows: detect winget vs scoop vs raw install.ps1 via install dir.
    if (IS_WIN) {
      const local = localAppData() ?? "";
      if (local && execPath.includes(local)) return "binary";
      // npm/bun/pnpm/yarn lookups below still apply on win32.
    }

    // ~/.soulforge/bin/ can shadow the brew symlink in PATH. Check directly
    // whether brew owns a `soulforge` symlink — this works regardless of PATH.
    const homebrewPrefix = process.env.HOMEBREW_PREFIX ?? "";
    if (homebrewPrefix) {
      try {
        const brewBin = `${homebrewPrefix}/bin/soulforge`;
        if (existsSync(brewBin) && lstatSync(brewBin).isSymbolicLink()) return "brew";
      } catch {}
    }

    // Compiled binary (bun --compile)
    if (isCompiledBinary(moduleUrl)) return "binary";

    // Check if running from a global node_modules
    const dir = import.meta.dir;
    if (dir.includes("/pnpm/")) return "pnpm";
    if (dir.includes("/.bun/")) return "bun";
    if (dir.includes("/yarn/")) return "yarn";
    if (dir.includes("/npm/") || dir.includes("/node_modules/")) return "npm";

    // Fallback: check npm_config_user_agent
    const ua = process.env.npm_config_user_agent ?? "";
    if (ua.startsWith("pnpm/")) return "pnpm";
    if (ua.startsWith("yarn/")) return "yarn";
    if (ua.startsWith("bun/")) return "bun";
    if (ua.startsWith("npm/")) return "npm";
  } catch {}
  return "unknown";
}

export function getUpgradeCommand(method?: InstallMethod): string {
  const m = method ?? detectInstallMethod();
  switch (m) {
    case "npm":
      return `npm install -g ${PKG_NAME}@latest`;
    case "pnpm":
      return `pnpm add -g ${PKG_NAME}@latest`;
    case "yarn":
      return `yarn global add ${PKG_NAME}@latest`;
    case "bun":
      return `bun install -g ${PKG_NAME}@latest`;
    case "brew":
      return "brew update && brew upgrade soulforge";
    case "binary":
      return "Download the latest release from GitHub";
    default:
      return `npm install -g ${PKG_NAME}@latest`;
  }
}

/** Split upgrade command into [binary, ...args] for spawn. */
export function getUpgradeArgs(method?: InstallMethod): { command: string; args: string[] } | null {
  const m = method ?? detectInstallMethod();
  switch (m) {
    case "npm":
      return { command: "npm", args: ["install", "-g", `${PKG_NAME}@latest`] };
    case "pnpm":
      return { command: "pnpm", args: ["add", "-g", `${PKG_NAME}@latest`] };
    case "yarn":
      return { command: "yarn", args: ["global", "add", `${PKG_NAME}@latest`] };
    case "bun":
      return { command: "bun", args: ["install", "-g", `${PKG_NAME}@latest`] };
    case "brew":
      return { command: "sh", args: ["-c", "brew update && brew upgrade soulforge"] };
    case "binary":
      return null;
    default:
      return { command: "npm", args: ["install", "-g", `${PKG_NAME}@latest`] };
  }
}

// ── Perform upgrade ──────────────────────────────────────────────────

export interface UpgradeResult {
  ok: boolean;
  output: string;
  error?: string;
}

export async function performUpgrade(
  method?: InstallMethod,
  onStatus?: (msg: string) => void,
): Promise<UpgradeResult> {
  const { spawn } = await import("node:child_process");
  const args = getUpgradeArgs(method);

  if (!args) {
    return {
      ok: false,
      output: "",
      error: "Cannot auto-upgrade binary installs. Download the latest release from GitHub.",
    };
  }

  onStatus?.(`Running: ${args.command} ${args.args.join(" ")}…`);

  return new Promise((resolve) => {
    const chunks: string[] = [];
    const proc = spawn(args.command, args.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    proc.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        chunks.push(line);
        onStatus?.(line);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        chunks.push(line);
        onStatus?.(line);
      }
    });

    const timeout = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, output: chunks.join("\n"), error: "Upgrade timed out after 60s" });
    }, 60_000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ ok: true, output: chunks.join("\n") });
      } else {
        resolve({ ok: false, output: chunks.join("\n"), error: `Exit code ${code}` });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, output: chunks.join("\n"), error: err.message });
    });
  });
}

// ── Changelog types ──────────────────────────────────────────────────

export interface ChangelogCommit {
  type: "feat" | "fix" | "perf" | "refactor" | "docs" | "other";
  scope?: string;
  message: string;
  breaking?: boolean;
}

export interface ChangelogRelease {
  version: string;
  date?: string;
  commits: ChangelogCommit[];
}

function parseReleaseBody(body: string): ChangelogCommit[] {
  const commits: ChangelogCommit[] = [];
  const lines = body.split("\n");
  let currentGroup: ChangelogCommit["type"] = "other";

  for (const line of lines) {
    // Detect group headers like "### Features", "### Bug Fixes"
    const groupMatch = line.match(/^###\s+(.+)/);
    if (groupMatch) {
      const g = (groupMatch[1] ?? "").trim().toLowerCase();
      if (g.includes("feature")) currentGroup = "feat";
      else if (g.includes("bug") || g.includes("fix")) currentGroup = "fix";
      else if (g.includes("perf")) currentGroup = "perf";
      else if (g.includes("refactor")) currentGroup = "refactor";
      else if (g.includes("doc")) currentGroup = "docs";
      else currentGroup = "other";
      continue;
    }

    // Parse commit lines like "- **scope**: message" or "- message"
    const scopedMatch = line.match(/^\s*-\s+\*\*([^*]+)\*\*:\s*(.+)/);
    const plainMatch = !scopedMatch && line.match(/^\s*-\s+(.+)/);

    if (scopedMatch) {
      const breaking = scopedMatch[2]?.includes("[**BREAKING**]") ?? false;
      commits.push({
        type: currentGroup,
        scope: scopedMatch[1]?.trim(),
        message: (scopedMatch[2] ?? "").replace(/\s*\[\*\*BREAKING\*\*\]/, "").trim(),
        ...(breaking && { breaking: true }),
      });
    } else if (plainMatch) {
      const msg = plainMatch[1] ?? "";
      const breaking = msg.includes("[**BREAKING**]");
      commits.push({
        type: currentGroup,
        message: msg.replace(/\s*\[\*\*BREAKING\*\*\]/, "").trim(),
        ...(breaking && { breaking: true }),
      });
    }
  }
  return commits;
}

// ── Version cache ────────────────────────────────────────────────────

interface VersionCache {
  latest: string;
  changelog: ChangelogRelease[];
  currentRelease: ChangelogRelease | null;
  checkedAt: number;
}

function readCache(): VersionCache | null {
  try {
    if (!existsSync(VERSION_CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(VERSION_CACHE_FILE, "utf-8")) as VersionCache;
    if (Date.now() - data.checkedAt > CACHE_TTL) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(cache: VersionCache): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(VERSION_CACHE_FILE, JSON.stringify(cache));
  } catch {}
}

// ── Dismissed version tracking ───────────────────────────────────────

interface DismissedInfo {
  version: string;
  dismissedAt: number;
}

export function isDismissed(version: string): boolean {
  try {
    if (!existsSync(DISMISSED_FILE)) return false;
    const data = JSON.parse(readFileSync(DISMISSED_FILE, "utf-8")) as DismissedInfo;
    return data.version === version;
  } catch {
    return false;
  }
}

export function dismissVersion(version: string): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(DISMISSED_FILE, JSON.stringify({ version, dismissedAt: Date.now() }));
  } catch {}
}

// ── Semver comparison ────────────────────────────────────────────────

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

export function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

// ── Fetch changelog from GitHub releases ─────────────────────────────

const GH_REPO = "ProxySoul/soulforge";

interface GitHubChangelogResult {
  changelog: ChangelogRelease[];
  currentRelease: ChangelogRelease | null;
  changelogError: boolean;
}

async function fetchGitHubChangelog(
  current: string,
  latest: string,
): Promise<GitHubChangelogResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/releases?per_page=15`, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    clearTimeout(timeout);

    if (!res.ok) return { changelog: [], currentRelease: null, changelogError: true };

    const releases = (await res.json()) as Array<{
      tag_name: string;
      published_at?: string;
      body?: string;
    }>;

    const changelog: ChangelogRelease[] = [];
    let currentRelease: ChangelogRelease | null = null;

    for (const rel of releases) {
      const ver = rel.tag_name.replace(/^v/, "");
      const commits = rel.body ? parseReleaseBody(rel.body) : [];
      const entry: ChangelogRelease = {
        version: ver,
        date: rel.published_at?.split("T")[0],
        commits,
      };

      // Capture the current version's release notes
      if (ver === current) {
        currentRelease = entry;
        continue;
      }

      // Only include versions newer than current, up to latest
      if (!isNewer(ver, current)) continue;
      if (isNewer(ver, latest)) continue;
      changelog.push(entry);
    }

    return { changelog, currentRelease, changelogError: false };
  } catch {
    return { changelog: [], currentRelease: null, changelogError: true };
  }
}

// ── Fetch latest version from npm ────────────────────────────────────

export interface VersionCheckResult {
  current: string;
  latest: string | null;
  changelog: ChangelogRelease[];
  currentRelease: ChangelogRelease | null;
  changelogError: boolean;
  updateAvailable: boolean;
}

export async function checkForUpdate(force = false): Promise<VersionCheckResult> {
  const current = CURRENT_VERSION;

  // Try cache first (skip if forced)
  if (!force) {
    const cached = readCache();
    if (cached) {
      return {
        current,
        latest: cached.latest,
        changelog: cached.changelog,
        currentRelease: cached.currentRelease ?? null,
        changelogError: false,
        updateAvailable: isNewer(cached.latest, current),
      };
    }
  }

  try {
    // Fetch latest version from npm
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);

    if (!res.ok)
      return {
        current,
        latest: null,
        changelog: [],
        currentRelease: null,
        changelogError: false,
        updateAvailable: false,
      };

    const data = (await res.json()) as {
      "dist-tags"?: { latest?: string };
    };

    const latest = data["dist-tags"]?.latest ?? null;
    if (!latest)
      return {
        current,
        latest: null,
        changelog: [],
        currentRelease: null,
        changelogError: false,
        updateAvailable: false,
      };

    // Fetch changelog from GitHub releases
    const { changelog, currentRelease, changelogError } = await fetchGitHubChangelog(
      current,
      latest,
    );

    if (!changelogError) {
      writeCache({ latest, changelog, currentRelease, checkedAt: Date.now() });
    }

    return {
      current,
      latest,
      changelog,
      currentRelease,
      changelogError,
      updateAvailable: isNewer(latest, current),
    };
  } catch {
    return {
      current,
      latest: null,
      changelog: [],
      currentRelease: null,
      changelogError: false,
      updateAvailable: false,
    };
  }
}
