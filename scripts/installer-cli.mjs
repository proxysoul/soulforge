#!/usr/bin/env node
/**
 * SoulForge branded self-extracting installer (Windows).
 *
 * Cross-platform shape but only meaningful as the Windows entrypoint —
 * POSIX users have install.sh. This file gets bun-compiled into a small
 * .exe and shipped as the "soulforge-installer.exe" release asset, paired
 * with the irm-iex style PowerShell flow:
 *
 *   irm https://soulforge.dev/install.exe -o sf.exe; .\\sf.exe
 *
 * What it does (every line visible to the user, brand-coherent):
 *   1. Paints the SoulForge wordmark + tagline in the same color pipeline
 *      as boot.tsx — the user sees the brand BEFORE the binary is even
 *      installed.
 *   2. Resolves the latest GitHub Release (or version pinned via
 *      $env:SOULFORGE_VERSION) and downloads soulforge-<ver>-windows-<arch>.zip.
 *   3. Extracts into %LOCALAPPDATA%\\Programs\\SoulForge.
 *   4. Adds the install dir to User PATH via setx (idempotent).
 *   5. Writes a "$INSTDIR\\sf.exe" companion copy so users get both
 *      `soulforge` and `sf` from any shell.
 *   6. Registers an uninstaller entry in HKCU so it shows in Settings → Apps.
 *
 * No EULA click-through. LICENSE is dropped next to the .exe (BUSL-1.1).
 *
 * Why a node ESM script bun-compiled to .exe rather than PowerShell?
 *   - Same look as the TUI itself — same wordmark, same colors, same
 *     spinner — instead of a stock Windows wizard.
 *   - PS1 -> .exe via ps2exe is fragile and AV-flagged.
 *   - Bun compile gives us a 60MB self-contained binary with zero deps;
 *     the heavy lift (the actual soulforge runtime) is downloaded after.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

const IS_WIN = process.platform === "win32";
if (!IS_WIN) {
  console.error("This installer targets Windows. POSIX users: see https://github.com/proxysoul/soulforge#install");
  process.exit(2);
}

// ── Brand pipeline (mirrors src/boot.tsx) ──────────────────────────
const COLOR = {
  amber: "\x1b[38;2;232;163;71m",
  forge: "\x1b[38;2;255;107;42m",
  muted: "\x1b[38;2;128;128;128m",
  ok:    "\x1b[38;2;127;200;127m",
  err:   "\x1b[38;2;232;90;90m",
  reset: "\x1b[0m",
  italic: "\x1b[3m",
  bold:   "\x1b[1m",
};

const WORDMARK = [
  "  ___ ___  _   _ _      ___ ___  ___  ___ ___",
  " / __| _ \\| | | | |    | __/ _ \\| _ \\/ __| __|",
  " \\__ \\ |_/| |_| | |__  | _| (_) |   / (_ | _|",
  " |___/___/ \\___/|____| |_| \\___/|_|_\\\\___|___|",
];
const TAGLINE = "graph-powered code intelligence";

function paintWordmark() {
  for (const line of WORDMARK) console.log(`  ${COLOR.amber}${line}${COLOR.reset}`);
  console.log(`  ${COLOR.muted}${COLOR.italic}${TAGLINE}${COLOR.reset}`);
  console.log();
}

const SPINNER = ["ᛝ", "ᛉ", "ᛋ", "ᛏ", "ᚦ", "ᚱ"];
let spinFrame = 0;
let spinTimer = null;
let spinLabel = "";
function startSpinner(label) {
  spinLabel = label;
  process.stdout.write("\x1b[?25l"); // hide cursor
  spinTimer = setInterval(() => {
    spinFrame = (spinFrame + 1) % SPINNER.length;
    process.stdout.write(`\r  ${COLOR.forge}${SPINNER[spinFrame]}${COLOR.reset}  ${spinLabel}   `);
  }, 80);
}
function stopSpinner(ok, msg) {
  if (spinTimer) {
    clearInterval(spinTimer);
    spinTimer = null;
  }
  const glyph = ok ? `${COLOR.ok}✓${COLOR.reset}` : `${COLOR.err}✗${COLOR.reset}`;
  process.stdout.write(`\r  ${glyph}  ${msg}${" ".repeat(20)}\n`);
  process.stdout.write("\x1b[?25h"); // show cursor
}

// ── Arch detection ────────────────────────────────────────────────
let arch = process.env.PROCESSOR_ARCHITEW6432 ?? process.env.PROCESSOR_ARCHITECTURE ?? "AMD64";
arch = arch.toUpperCase();
let assetArch;
if (arch === "AMD64" || arch === "X64") {
  assetArch = "x64";
} else if (arch === "ARM64") {
  console.error(`${COLOR.err}Windows ARM64 is not yet supported (tracked in roadmap_local/windows-support.md).`);
  console.error(`Workaround: set PROCESSOR_ARCHITEW6432=AMD64 and re-run for x64-on-ARM emulation.${COLOR.reset}`);
  process.exit(1);
} else {
  console.error(`${COLOR.err}Unsupported architecture: ${arch}${COLOR.reset}`);
  process.exit(1);
}

// ── Resolve version ───────────────────────────────────────────────
const REPO = "proxysoul/soulforge";
async function resolveVersion() {
  if (process.env.SOULFORGE_VERSION) return process.env.SOULFORGE_VERSION.replace(/^v/, "");
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": "soulforge-installer" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: cannot resolve latest version`);
  const data = await res.json();
  return String(data.tag_name).replace(/^v/, "");
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  await pipeline(res.body, createWriteStream(dest));
}

// ── Paths ─────────────────────────────────────────────────────────
const INSTALL_DIR = process.env.SOULFORGE_INSTALL_DIR
  ?? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "SoulForge");

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log();
  paintWordmark();

  const version = await resolveVersion();
  console.log(`  ${COLOR.muted}version  : ${COLOR.reset}${version}`);
  console.log(`  ${COLOR.muted}arch     : ${COLOR.reset}${assetArch}`);
  console.log(`  ${COLOR.muted}install  : ${COLOR.reset}${INSTALL_DIR}`);
  console.log();

  // Stop any running soulforge.exe so we can overwrite.
  spawnSync("taskkill", ["/F", "/IM", "soulforge.exe", "/T"], { stdio: "ignore" });
  spawnSync("taskkill", ["/F", "/IM", "sf.exe", "/T"], { stdio: "ignore" });

  const zipName = `soulforge-${version}-windows-${assetArch}.zip`;
  const zipUrl = `https://github.com/${REPO}/releases/download/v${version}/${zipName}`;
  const tmpZip = join(tmpdir(), zipName);
  const tmpExtract = join(tmpdir(), `soulforge-${version}-extract`);

  startSpinner(`downloading ${zipName}`);
  try {
    await downloadFile(zipUrl, tmpZip);
    const size = statSync(tmpZip).size;
    if (size < 1024 * 1024) throw new Error(`downloaded file is suspiciously small (${size} bytes)`);
    stopSpinner(true, `downloaded ${(size / 1024 / 1024).toFixed(1)} MB`);
  } catch (err) {
    stopSpinner(false, `download failed: ${err.message}`);
    process.exit(1);
  }

  startSpinner("extracting");
  try {
    if (existsSync(tmpExtract)) rmSync(tmpExtract, { recursive: true, force: true });
    mkdirSync(tmpExtract, { recursive: true });
    // Pass paths via PS param block so the quoting is handled by PowerShell's
    // parameter binder, not by string interpolation. -LiteralPath disables
    // wildcard expansion on the source path.
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "param([Parameter(Mandatory)][string]$Src,[Parameter(Mandatory)][string]$Dst) Expand-Archive -LiteralPath $Src -DestinationPath $Dst -Force",
        "-Src", tmpZip,
        "-Dst", tmpExtract,
      ],
      { stdio: "ignore" },
    );
    if (r.status !== 0) throw new Error(`Expand-Archive exited ${r.status}`);
    stopSpinner(true, "extracted");
  } catch (err) {
    stopSpinner(false, `extract failed: ${err.message}`);
    process.exit(1);
  }

  startSpinner("installing");
  try {
    mkdirSync(INSTALL_DIR, { recursive: true });
    // Remove the previous install's deps/ so leftover files don't accumulate.
    const oldDeps = join(INSTALL_DIR, "deps");
    if (existsSync(oldDeps)) rmSync(oldDeps, { recursive: true, force: true });

    for (const name of readdirSync(tmpExtract)) {
      const src = join(tmpExtract, name);
      const dst = join(INSTALL_DIR, name);
      if (existsSync(dst) && statSync(dst).isFile()) rmSync(dst, { force: true });
      renameSync(src, dst);
    }

    // sf alias — same binary, second name.
    const mainExe = join(INSTALL_DIR, "soulforge.exe");
    const sfExe = join(INSTALL_DIR, "sf.exe");
    if (existsSync(mainExe)) copyFileSync(mainExe, sfExe);

    rmSync(tmpExtract, { recursive: true, force: true });
    rmSync(tmpZip, { force: true });
    stopSpinner(true, `installed to ${INSTALL_DIR}`);
  } catch (err) {
    stopSpinner(false, `install failed: ${err.message}`);
    process.exit(1);
  }

  // Add to PATH (User scope) — idempotent. INSTALL_DIR is passed as a
  // -Dir parameter (binder-quoted), and the `-notlike` glob uses an
  // escaped literal so `[` `]` `*` `?` in the path can't break matching.
  startSpinner("updating PATH");
  try {
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "param([Parameter(Mandatory)][string]$Dir) " +
          "$existing = [Environment]::GetEnvironmentVariable('Path','User'); " +
          "if ($null -eq $existing) { $existing = '' }; " +
          "$norm = $Dir.TrimEnd('\\'); " +
          "$parts = $existing -split ';' | Where-Object { $_ -and $_.Trim() -ne '' }; " +
          "$present = $parts | Where-Object { $_.TrimEnd('\\') -ieq $norm }; " +
          "if (-not $present) { $newPath = if ($existing) { \"$Dir;$existing\" } else { $Dir }; [Environment]::SetEnvironmentVariable('Path', $newPath, 'User') }",
        "-Dir", INSTALL_DIR,
      ],
      { stdio: "ignore" },
    );
    if (r.status !== 0) throw new Error(`PATH update exited ${r.status}`);
    stopSpinner(true, "PATH updated (open a new terminal)");
  } catch (err) {
    stopSpinner(false, `PATH update failed: ${err.message}`);
  }

  // Durable uninstaller — copy this installer into the install dir so the
  // registered UninstallString points at a stable location, not at
  // process.execPath (which is the disposable copy the user ran from
  // Downloads). Settings -> Apps stays valid even after the original is
  // moved or deleted.
  const persistentUninstaller = join(INSTALL_DIR, "soulforge-uninstall.exe");
  try {
    copyFileSync(process.execPath, persistentUninstaller);
  } catch (err) {
    process.stderr.write(`  ${COLOR.muted}warn:${COLOR.reset} could not stage uninstaller (${err.message})\n`);
  }

  // Uninstaller registry entry — points at the staged uninstaller.
  startSpinner("registering uninstaller");
  try {
    const uninstallCmd = `"${persistentUninstaller}" --uninstall`;
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SoulForge";
    spawnSync("reg", ["add", key, "/v", "DisplayName", "/t", "REG_SZ", "/d", "SoulForge", "/f"], { stdio: "ignore" });
    spawnSync("reg", ["add", key, "/v", "DisplayVersion", "/t", "REG_SZ", "/d", version, "/f"], { stdio: "ignore" });
    spawnSync("reg", ["add", key, "/v", "Publisher", "/t", "REG_SZ", "/d", "proxySoul", "/f"], { stdio: "ignore" });
    spawnSync("reg", ["add", key, "/v", "InstallLocation", "/t", "REG_SZ", "/d", INSTALL_DIR, "/f"], { stdio: "ignore" });
    spawnSync("reg", ["add", key, "/v", "DisplayIcon", "/t", "REG_SZ", "/d", join(INSTALL_DIR, "soulforge.exe"), "/f"], { stdio: "ignore" });
    spawnSync("reg", ["add", key, "/v", "UninstallString", "/t", "REG_SZ", "/d", uninstallCmd, "/f"], { stdio: "ignore" });
    spawnSync("reg", ["add", key, "/v", "URLInfoAbout", "/t", "REG_SZ", "/d", "https://github.com/proxysoul/soulforge", "/f"], { stdio: "ignore" });
    spawnSync("reg", ["add", key, "/v", "NoModify", "/t", "REG_DWORD", "/d", "1", "/f"], { stdio: "ignore" });
    spawnSync("reg", ["add", key, "/v", "NoRepair", "/t", "REG_DWORD", "/d", "1", "/f"], { stdio: "ignore" });
    stopSpinner(true, "registered");
  } catch (err) {
    stopSpinner(false, `registry write failed: ${err.message}`);
  }

  console.log();
  console.log(`  ${COLOR.bold}${COLOR.ok}Done.${COLOR.reset} Open a new terminal and run:`);
  console.log(`     ${COLOR.amber}soulforge${COLOR.reset}    ${COLOR.muted}or${COLOR.reset}    ${COLOR.amber}sf${COLOR.reset}`);
  console.log();
}

async function uninstall() {
  console.log();
  paintWordmark();
  console.log(`  ${COLOR.muted}uninstalling SoulForge${COLOR.reset}`);
  console.log();

  spawnSync("taskkill", ["/F", "/IM", "soulforge.exe", "/T"], { stdio: "ignore" });
  spawnSync("taskkill", ["/F", "/IM", "sf.exe", "/T"], { stdio: "ignore" });

  startSpinner("removing files");
  try {
    if (existsSync(INSTALL_DIR)) rmSync(INSTALL_DIR, { recursive: true, force: true });
    stopSpinner(true, `removed ${INSTALL_DIR}`);
  } catch (err) {
    stopSpinner(false, `remove failed: ${err.message}`);
  }

  startSpinner("cleaning PATH");
  try {
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "param([Parameter(Mandatory)][string]$Dir) " +
          "$norm = $Dir.TrimEnd('\\'); " +
          "$existing = [Environment]::GetEnvironmentVariable('Path','User'); " +
          "$clean = ($existing -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ine $norm) }) -join ';'; " +
          "[Environment]::SetEnvironmentVariable('Path', $clean, 'User')",
        "-Dir", INSTALL_DIR,
      ],
      { stdio: "ignore" },
    );
    stopSpinner(true, "PATH cleaned");
  } catch (err) {
    stopSpinner(false, `PATH clean failed: ${err.message}`);
  }

  spawnSync("reg", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SoulForge", "/f"], { stdio: "ignore" });

  console.log();
  console.log(`  ${COLOR.ok}Goodbye.${COLOR.reset}`);
  console.log();
}

const arg = process.argv[2];
if (arg === "--uninstall" || arg === "-u") {
  uninstall().catch((err) => {
    console.error(`${COLOR.err}fatal:${COLOR.reset} ${err.stack ?? err}`);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error(`${COLOR.err}fatal:${COLOR.reset} ${err.stack ?? err}`);
    process.exit(1);
  });
}
