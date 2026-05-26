/**
 * Optional addons — components that are NOT bundled by default and that the
 * user explicitly fetches with `soulforge addon install <name>`.
 *
 * - proxy   → CLIProxyAPI (multi-provider LLM gateway, ~25 MB)
 * - neovim  → bundled Neovim (editor integration, ~15 MB)
 *
 * Install records live in AppConfig.addons. The presence of an entry with
 * `installed: true` is the source of truth — `getVendoredPath()` returning
 * null after that means the binary was manually removed, in which case we
 * treat the addon as gone and the user can reinstall.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveGlobalConfig } from "../../config/index.js";
import { logBackgroundError } from "../../stores/errors.js";
import { commandExists, dataDir, EXE } from "../platform/index.js";
import { getVendoredPath, installNeovim, installProxy } from "./install.js";

export const ADDON_NAMES = ["proxy", "neovim"] as const;
export type AddonName = (typeof ADDON_NAMES)[number];

const BIN_DIR = join(dataDir(), "bin");
const INSTALLS_DIR = join(dataDir(), "installs");

/** Names of files under ${BIN_DIR} that addon-install creates. */
const ADDON_BIN: Record<AddonName, string> = {
  proxy: `cli-proxy-api${EXE}`,
  neovim: `nvim${EXE}`,
};

/** Filesystem prefix used by the existing install pipeline under `installs/`. */
const ADDON_INSTALL_PREFIX: Record<AddonName, string> = {
  proxy: "cliproxyapi-",
  neovim: "nvim-",
};

export interface AddonStatus {
  name: AddonName;
  installed: boolean;
  path?: string;
  version?: string;
  installedAt?: string;
}

/**
 * Source of truth for "can we use this addon". Considers BOTH the vendored
 * install AND a system binary on PATH (brew, apt, scoop, etc.) — otherwise a
 * user with `brew install cliproxyapi` would see proxy hidden from /model
 * despite having a working binary.
 *
 * Note: `getVendoredPath` already covers manual cleanup (returns null on
 * missing/dangling symlink). System PATH check is the second source so
 * package-manager-managed installs Just Work without `addon install`.
 */
export function isAddonInstalled(name: AddonName): boolean {
  if (name === "proxy") {
    return (
      getVendoredPath("cli-proxy-api") !== null ||
      commandExists("cli-proxy-api") ||
      commandExists("cliproxyapi")
    );
  }
  if (name === "neovim") {
    return getVendoredPath("nvim") !== null || commandExists("nvim");
  }
  return false;
}

/** True only when our vendored binary is present (not a system PATH copy).
 *  Used by `remove` to know whether there's anything WE can uninstall. */
export function isVendoredAddonInstalled(name: AddonName): boolean {
  if (name === "proxy") return getVendoredPath("cli-proxy-api") !== null;
  if (name === "neovim") return getVendoredPath("nvim") !== null;
  return false;
}

/** True when a usable binary lives outside our managed install dir. */
function hasSystemBinary(name: AddonName): boolean {
  if (name === "proxy") {
    return commandExists("cli-proxy-api") || commandExists("cliproxyapi");
  }
  if (name === "neovim") return commandExists("nvim");
  return false;
}

export function listAddons(): AddonStatus[] {
  const cfg = loadConfig();
  return ADDON_NAMES.map((name) => {
    const record = cfg.addons?.[name];
    const vendored = isVendoredAddonInstalled(name);
    const installed = isAddonInstalled(name);
    // `path` reflects what soulforge controls — only set when WE installed it.
    // System-PATH binaries are visible via isAddonInstalled but not "ours".
    const path = vendored ? join(BIN_DIR, ADDON_BIN[name]) : undefined;
    return {
      name,
      installed,
      path,
      version: record?.version,
      installedAt: record?.installedAt,
    };
  });
}

type StatusCallback = (msg: string) => void;

export interface InstallOptions {
  /** Reinstall even if a vendored copy already exists. Default: false. */
  force?: boolean;
}

export async function installAddon(
  name: AddonName,
  onStatus?: StatusCallback,
  opts: InstallOptions = {},
): Promise<void> {
  const log = (m: string) => onStatus?.(m);

  // Already vendored — skip the download to avoid clobbering a healthy
  // install. `update` callers pass force:true to bypass this.
  if (!opts.force && isVendoredAddonInstalled(name)) {
    log(`${name} addon is already installed. Use \`soulforge addon update ${name}\` to reinstall.`);
    return;
  }

  // System binary on PATH — print a hint but proceed (vendoring our own copy
  // keeps versions consistent across machines + survives PATH changes).
  if (!opts.force && hasSystemBinary(name)) {
    log(
      `Note: a system \`${name === "proxy" ? "cli-proxy-api" : "nvim"}\` is already on your PATH; the addon will install a separate vendored copy under ~/.soulforge/bin.`,
    );
  }

  if (name === "proxy") {
    log("Installing CLIProxyAPI…");
    const { path, version } = await installProxy();
    recordInstall(name, version);
    log(`CLIProxyAPI v${version} installed at ${path}`);
    return;
  }

  if (name === "neovim") {
    log("Installing Neovim…");
    const path = await installNeovim();
    recordInstall(name);
    // Reset the palette nvim cache so editor commands surface immediately.
    try {
      const { resetNvimDetection } = await import("../commands/registry.js");
      resetNvimDetection();
    } catch {}
    log(`Neovim installed at ${path}`);
    return;
  }

  throw new Error(`Unknown addon: ${String(name)}`);
}

export async function removeAddon(name: AddonName, onStatus?: StatusCallback): Promise<void> {
  const log = (m: string) => onStatus?.(m);

  // Nothing of ours to remove — surface a clear message instead of pretending
  // we did something. System binaries on PATH are managed by their owner
  // (brew/apt/scoop/etc.) and must be removed there.
  if (!isVendoredAddonInstalled(name)) {
    if (hasSystemBinary(name)) {
      log(
        `${name} is not managed by soulforge — it's installed on your system PATH. Remove it via your package manager.`,
      );
    } else {
      log(`${name} addon is not installed.`);
    }
    return;
  }

  // Best-effort: kill any running instance so unlink doesn't EBUSY on Windows.
  // Also wipe the cached version stamp so a reinstall doesn't see stale state.
  if (name === "proxy") {
    try {
      const { stopProxy } = await import("../proxy/lifecycle.js");
      stopProxy();
    } catch {}
  }

  const binPath = join(BIN_DIR, ADDON_BIN[name]);
  if (existsSync(binPath)) {
    try {
      rmSync(binPath, { force: true });
    } catch (err) {
      logBackgroundError(
        "addons",
        `failed to remove ${binPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Remove every versioned install dir matching this addon's prefix +
  // version digit, so a stray sibling like `nvim-config/` is never touched.
  const prefix = ADDON_INSTALL_PREFIX[name];
  try {
    const { readdirSync } = await import("node:fs");
    if (existsSync(INSTALLS_DIR)) {
      for (const entry of readdirSync(INSTALLS_DIR)) {
        if (entry.startsWith(prefix) && /\d/.test(entry.slice(prefix.length, prefix.length + 1))) {
          rmSync(join(INSTALLS_DIR, entry), { recursive: true, force: true });
        }
      }
    }
  } catch (err) {
    logBackgroundError(
      "addons",
      `failed to clean installs/ for ${name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Clear config entry — preserves the other addon's record.
  const cfg = loadConfig();
  if (cfg.addons?.[name]) {
    const next = { ...cfg.addons };
    delete next[name];
    saveGlobalConfig({ addons: next });
  }
  if (name === "neovim") {
    try {
      const { resetNvimDetection } = await import("../commands/registry.js");
      resetNvimDetection();
    } catch {}
  }

  log(`Removed ${name} addon.`);
  if (hasSystemBinary(name)) {
    log(
      `A system \`${name === "proxy" ? "cli-proxy-api" : "nvim"}\` is still on your PATH and will continue to be used.`,
    );
  }
}

function recordInstall(name: AddonName, version?: string): void {
  const entry: { installed: true; version?: string; installedAt: string } = {
    installed: true,
    installedAt: new Date().toISOString(),
  };
  if (version) entry.version = version;
  saveGlobalConfig({ addons: { [name]: entry } });
}

export async function runAddonCli(args: string[]): Promise<number> {
  // Accept `--help`/`-h` anywhere — `soulforge addon -h`, `--addon -h`,
  // `--addon install -h` all surface usage.
  if (args.some((a) => a === "--help" || a === "-h" || a === "help")) {
    process.stdout.write(usage());
    return 0;
  }

  // Treat `--list`/`-l` flags the same as the `list` verb so
  // `soulforge --addon --list` Just Works.
  const isListFlag = (a: string) => a === "--list" || a === "-l" || a === "list" || a === "ls";

  // Strip leading verb-position flags so `--addon --list` resolves to verb=list.
  // Anything else with a leading `--` is an unknown flag — surface it.
  const target = args[1];
  let verb = args[0];
  if (verb && isListFlag(verb)) verb = "list";

  if (!verb || verb === "list") {
    printList();
    return 0;
  }

  if (verb === "install" || verb === "add") {
    if (!target) {
      process.stderr.write(usage());
      return 1;
    }
    if (!isAddonName(target)) {
      process.stderr.write(`Unknown addon: ${target}\n${usage()}`);
      return 1;
    }
    try {
      await installAddon(target, (m) => process.stdout.write(`${m}\n`));
      return 0;
    } catch (err) {
      process.stderr.write(`Install failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  if (verb === "remove" || verb === "rm" || verb === "uninstall") {
    if (!target) {
      process.stderr.write(usage());
      return 1;
    }
    if (!isAddonName(target)) {
      process.stderr.write(`Unknown addon: ${target}\n${usage()}`);
      return 1;
    }
    try {
      await removeAddon(target, (m) => process.stdout.write(`${m}\n`));
      return 0;
    } catch (err) {
      process.stderr.write(`Remove failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  if (verb === "update" || verb === "upgrade") {
    if (!target) {
      process.stderr.write(usage());
      return 1;
    }
    if (!isAddonName(target)) {
      process.stderr.write(`Unknown addon: ${target}\n${usage()}`);
      return 1;
    }
    // Update = reinstall over the top (force bypasses the already-installed guard).
    try {
      await installAddon(target, (m) => process.stdout.write(`${m}\n`), { force: true });
      return 0;
    } catch (err) {
      process.stderr.write(`Update failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  process.stderr.write(`Unknown addon command: ${verb}\n${usage()}`);
  return 1;
}

function isAddonName(s: string): s is AddonName {
  return (ADDON_NAMES as readonly string[]).includes(s);
}

function printList(): void {
  const rows = listAddons();
  process.stdout.write("Addons\n");
  for (const r of rows) {
    const vendored = isVendoredAddonInstalled(r.name);
    const system = !vendored && hasSystemBinary(r.name);
    const status = vendored ? "installed" : system ? "system PATH" : "not installed";
    const ver = r.version ? ` v${r.version}` : "";
    process.stdout.write(`  ${r.name.padEnd(8)} ${status}${ver}\n`);
    if (vendored && r.path) process.stdout.write(`           ${r.path}\n`);
  }
  process.stdout.write("\nUsage: soulforge addon <install|remove|update|list> [proxy|neovim]\n");
}

function usage(): string {
  return [
    "Usage: soulforge addon <install|remove|update|list> [proxy|neovim]",
    "",
    "  install proxy    download + activate CLIProxyAPI (~25 MB)",
    "  install neovim   download + activate Neovim (~15 MB)",
    "  remove <name>    uninstall the addon",
    "  update <name>    reinstall the addon (latest version)",
    "  list             show installed/available state",
    "",
  ].join("\n");
}

/**
 * CI / Docker hook: if `SOULFORGE_AUTO_INSTALL_ADDONS=proxy,neovim` is set,
 * silently install the listed addons that aren't already present.
 * Called from boot.tsx before any UI mounts. Failures are logged, not fatal.
 */
export async function autoInstallFromEnv(): Promise<void> {
  const raw = process.env.SOULFORGE_AUTO_INSTALL_ADDONS;
  if (!raw) return;
  const wanted = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(isAddonName);
  for (const name of wanted) {
    if (isAddonInstalled(name)) continue;
    try {
      await installAddon(name);
    } catch (err) {
      logBackgroundError(
        "addons",
        `auto-install ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
