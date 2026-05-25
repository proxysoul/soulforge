import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { extractArchive, extractTarXz } from "../platform/archive.js";
import { dataDir, EXE, IS_DARWIN, IS_WIN, systemFontDirs, userFontDir } from "../platform/index.js";

const SOULFORGE_DIR = dataDir();
const BIN_DIR = join(SOULFORGE_DIR, "bin");
const INSTALLS_DIR = join(SOULFORGE_DIR, "installs");
const FONTS_DIR = join(SOULFORGE_DIR, "fonts");

const NVIM_VERSION = "0.11.1";
const RG_VERSION = "14.1.1";
const FD_VERSION = "10.2.0";
const LAZYGIT_VERSION = "0.44.1";
/**
 * Offline safety-net for fresh installs when GitHub is unreachable. The
 * *actual* version used on a fresh install is the latest GitHub release
 * (or `SOULFORGE_PROXY_VERSION` if set). Bump this occasionally for users
 * on locked-down networks; most users will never see it.
 */
export const FALLBACK_PROXY_VERSION = "6.9.29";

const PROXY_RELEASES_URL = "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest";

export async function fetchLatestProxyVersion(timeoutMs = 5000): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(PROXY_RELEASES_URL, {
      signal: ctl.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string };
    return data.tag_name?.replace(/^v/, "")?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve which CLIProxyAPI version to install when the caller does not
 * request a specific one. Priority:
 *   1. `SOULFORGE_PROXY_VERSION` env (CI / reproducible builds / pin)
 *   2. Latest GitHub release tag
 *   3. `FALLBACK_PROXY_VERSION` (offline)
 */
export async function resolveProxyVersion(): Promise<string> {
  const env = process.env.SOULFORGE_PROXY_VERSION?.trim();
  if (env) return env;
  const latest = await fetchLatestProxyVersion();
  if (latest) return latest;
  return FALLBACK_PROXY_VERSION;
}

export interface NerdFont {
  id: string;
  name: string;
  /** Name as it appears in font selectors */
  family: string;
  /** Nerd Fonts release asset name (without .tar.xz) */
  asset: string;
  /** Prefix used in font filenames, e.g. "FiraCodeNerdFont" */
  filePrefix: string;
  description: string;
}

export const NERD_FONTS: NerdFont[] = [
  {
    id: "jetbrains-mono",
    name: "JetBrains Mono",
    family: "JetBrainsMono Nerd Font",
    asset: "JetBrainsMono",
    filePrefix: "JetBrainsMonoNerdFont",
    description: "Excellent ligatures, crisp at all sizes",
  },
  {
    id: "fira-code",
    name: "Fira Code",
    family: "FiraCode Nerd Font",
    asset: "FiraCode",
    filePrefix: "FiraCodeNerdFont",
    description: "Popular ligature font, wide language support",
  },
  {
    id: "cascadia-code",
    name: "Cascadia Code",
    family: "CaskaydiaCove Nerd Font",
    asset: "CascadiaCode",
    filePrefix: "CaskaydiaCoveNerdFont",
    description: "Microsoft's terminal font, cursive italics",
  },
  {
    id: "iosevka",
    name: "Iosevka",
    family: "Iosevka Nerd Font",
    asset: "Iosevka",
    filePrefix: "IosevkaNerdFont",
    description: "Narrow and compact, fits more on screen",
  },
  {
    id: "hack",
    name: "Hack",
    family: "Hack Nerd Font",
    asset: "Hack",
    filePrefix: "HackNerdFont",
    description: "Classic monospace, very readable",
  },
];

interface PlatformAsset {
  url: string;
  binPath: string;
}

type PlatformKey = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "win32-x64";

function getPlatformKey(): PlatformKey {
  const key = `${process.platform}-${process.arch}` as PlatformKey;
  if (
    key !== "darwin-arm64" &&
    key !== "darwin-x64" &&
    key !== "linux-x64" &&
    key !== "linux-arm64" &&
    key !== "win32-x64"
  ) {
    throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
  }
  return key;
}

interface BinaryConfig {
  name: string;
  binName: string;
  version: string;
  getAsset: (key: PlatformKey) => PlatformAsset;
}

async function installBinary(config: BinaryConfig): Promise<string> {
  ensureDirs();
  const key = getPlatformKey();
  const asset = config.getAsset(key);
  const extractDir = join(INSTALLS_DIR, `${config.name}-${config.version}`);

  if (!existsSync(asset.binPath)) {
    await downloadAndExtract(asset.url, extractDir);
  }
  if (!existsSync(asset.binPath)) {
    throw new Error(`${config.name} binary not found after extraction at ${asset.binPath}`);
  }

  // NTFS has no POSIX execute bit; downloaded .exe is already runnable.
  if (!IS_WIN) {
    try {
      chmodSync(asset.binPath, 0o755);
    } catch {}
  }
  createSymlink(asset.binPath, join(BIN_DIR, config.binName + EXE));
  return join(BIN_DIR, config.binName + EXE);
}

const NVIM_ASSETS: Record<PlatformKey, string> = {
  "darwin-arm64": "nvim-macos-arm64.tar.gz",
  "darwin-x64": "nvim-macos-x86_64.tar.gz",
  "linux-x64": "nvim-linux-x86_64.tar.gz",
  "linux-arm64": "nvim-linux-arm64.tar.gz",
  "win32-x64": "nvim-win64.zip",
};

const RUST_TRIPLETS: Record<PlatformKey, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

const FD_TRIPLETS: Record<PlatformKey, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

const PROXY_SUFFIXES: Record<PlatformKey, string> = {
  "darwin-arm64": "darwin_aarch64",
  "darwin-x64": "darwin_amd64",
  "linux-x64": "linux_amd64",
  "linux-arm64": "linux_aarch64",
  "win32-x64": "windows_amd64",
};

// Pre-v6.10 releases used `arm64` instead of `aarch64`. Used as a fallback
// when the primary asset 404s (e.g. user pins an older version).
const PROXY_SUFFIXES_LEGACY: Record<PlatformKey, string> = {
  "darwin-arm64": "darwin_arm64",
  "darwin-x64": "darwin_amd64",
  "linux-x64": "linux_amd64",
  "linux-arm64": "linux_arm64",
  "win32-x64": "windows_amd64",
};

const LAZYGIT_SUFFIXES: Record<PlatformKey, string> = {
  "darwin-arm64": "Darwin_arm64",
  "darwin-x64": "Darwin_x86_64",
  "linux-x64": "Linux_x86_64",
  "linux-arm64": "Linux_arm64",
  "win32-x64": "Windows_x86_64",
};

export function getVendoredPath(
  binary: "nvim" | "rg" | "fd" | "lazygit" | "cli-proxy-api",
): string | null {
  const binLink = join(BIN_DIR, binary + EXE);
  return existsSync(binLink) ? binLink : null;
}

function ensureDirs(): void {
  mkdirSync(BIN_DIR, { recursive: true });
  mkdirSync(INSTALLS_DIR, { recursive: true });
}

async function downloadAndExtract(url: string, extractDir: string): Promise<void> {
  mkdirSync(extractDir, { recursive: true });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`);
  }

  // Pick filename + extractor from URL extension. Windows nvim ships as .zip;
  // every other asset is .tar.gz. tar.exe on Win10 1803+ handles both formats.
  const lower = url.toLowerCase();
  const ext = lower.endsWith(".zip") ? ".zip" : ".tar.gz";
  const tmpFile = join(extractDir, `download${ext}`);
  const buffer = await response.arrayBuffer();
  await Bun.write(tmpFile, buffer);

  const result = extractArchive(tmpFile, extractDir);
  if (!result.success) {
    throw new Error(`Extract failed: ${result.error}`);
  }
  unlinkSync(tmpFile);
}

function createSymlink(target: string, link: string): void {
  if (existsSync(link)) {
    unlinkSync(link);
  }
  // Windows: symlinks need Developer Mode or admin token. Copy instead — bin
  // dir lives under %LOCALAPPDATA% (user-writable), and the wasted disk is
  // a few MB per tool.
  if (IS_WIN) {
    const { copyFileSync } = require("node:fs") as typeof import("node:fs");
    copyFileSync(target, link);
    return;
  }
  symlinkSync(target, link);
}

export async function installNeovim(): Promise<string> {
  return installBinary({
    name: "nvim",
    binName: "nvim",
    version: NVIM_VERSION,
    getAsset: (key) => {
      const asset = NVIM_ASSETS[key];
      // Windows nvim release: nvim-win64.zip extracts to "nvim-win64/" with
      // bin/nvim.exe inside. All other platforms extract to a directory
      // named after the tarball stem.
      if (key === "win32-x64") {
        return {
          url: `https://github.com/neovim/neovim/releases/download/v${NVIM_VERSION}/${asset}`,
          binPath: join(INSTALLS_DIR, `nvim-${NVIM_VERSION}`, "nvim-win64", "bin", "nvim.exe"),
        };
      }
      const dirName = asset.replace(".tar.gz", "");
      return {
        url: `https://github.com/neovim/neovim/releases/download/v${NVIM_VERSION}/${asset}`,
        binPath: join(INSTALLS_DIR, `nvim-${NVIM_VERSION}`, dirName, "bin", "nvim"),
      };
    },
  });
}

export async function installRipgrep(): Promise<string> {
  return installBinary({
    name: "ripgrep",
    binName: "rg",
    version: RG_VERSION,
    getAsset: (key) => {
      const triplet = RUST_TRIPLETS[key];
      const dirName = `ripgrep-${RG_VERSION}-${triplet}`;
      // Windows ripgrep release ships as a .zip with rg.exe at the top level.
      if (key === "win32-x64") {
        return {
          url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${dirName}.zip`,
          binPath: join(INSTALLS_DIR, `ripgrep-${RG_VERSION}`, dirName, "rg.exe"),
        };
      }
      return {
        url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${dirName}.tar.gz`,
        binPath: join(INSTALLS_DIR, `ripgrep-${RG_VERSION}`, dirName, "rg"),
      };
    },
  });
}

export async function installFd(): Promise<string> {
  return installBinary({
    name: "fd",
    binName: "fd",
    version: FD_VERSION,
    getAsset: (key) => {
      const triplet = FD_TRIPLETS[key];
      const dirName = `fd-v${FD_VERSION}-${triplet}`;
      // Windows fd release ships as a .zip with fd.exe at the top level.
      if (key === "win32-x64") {
        return {
          url: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${dirName}.zip`,
          binPath: join(INSTALLS_DIR, `fd-${FD_VERSION}`, dirName, "fd.exe"),
        };
      }
      return {
        url: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${dirName}.tar.gz`,
        binPath: join(INSTALLS_DIR, `fd-${FD_VERSION}`, dirName, "fd"),
      };
    },
  });
}

export async function installLazygit(): Promise<string> {
  return installBinary({
    name: "lazygit",
    binName: "lazygit",
    version: LAZYGIT_VERSION,
    getAsset: (key) => {
      const suffix = LAZYGIT_SUFFIXES[key];
      // Windows lazygit ships as .zip; everything else is .tar.gz. The archive
      // unpacks lazygit(.exe) directly into the extract dir on both.
      const ext = key === "win32-x64" ? "zip" : "tar.gz";
      const binName = key === "win32-x64" ? "lazygit.exe" : "lazygit";
      return {
        url: `https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_${suffix}.${ext}`,
        binPath: join(INSTALLS_DIR, `lazygit-${LAZYGIT_VERSION}`, binName),
      };
    },
  });
}

export async function installProxy(version?: string): Promise<{ path: string; version: string }> {
  const v = version ?? (await resolveProxyVersion());
  const buildAsset = (suffix: string): PlatformAsset => {
    const isWin = getPlatformKey() === "win32-x64";
    const ext = isWin ? "zip" : "tar.gz";
    const binName = isWin ? "cli-proxy-api.exe" : "cli-proxy-api";
    return {
      url: `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${v}/CLIProxyAPI_${v}_${suffix}.${ext}`,
      binPath: join(INSTALLS_DIR, `cliproxyapi-${v}`, binName),
    };
  };
  try {
    const path = await installBinary({
      name: "cliproxyapi",
      binName: "cli-proxy-api",
      version: v,
      getAsset: (key) => buildAsset(PROXY_SUFFIXES[key]),
    });
    return { path, version: v };
  } catch (err) {
    // Fall back to the pre-v6.10 asset naming scheme.
    const legacyDiffers = Object.keys(PROXY_SUFFIXES).some(
      (k) => PROXY_SUFFIXES[k as PlatformKey] !== PROXY_SUFFIXES_LEGACY[k as PlatformKey],
    );
    const msg = err instanceof Error ? err.message : String(err);
    if (!legacyDiffers || !msg.includes("404")) throw err;
    const path = await installBinary({
      name: "cliproxyapi",
      binName: "cli-proxy-api",
      version: v,
      getAsset: (key) => buildAsset(PROXY_SUFFIXES_LEGACY[key]),
    });
    return { path, version: v };
  }
}

function getUserFontDir(): string {
  return userFontDir();
}

function getFontDirs(): string[] {
  return systemFontDirs();
}

/**
 * Check if a font's files exist in any system font directory.
 */
function fontExistsOnSystem(font: NerdFont): boolean {
  for (const dir of getFontDirs()) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir, { recursive: true });
      for (const f of files) {
        const name = typeof f === "string" ? f : f.toString();
        if (name.includes(font.filePrefix) && (name.endsWith(".ttf") || name.endsWith(".otf"))) {
          return true;
        }
      }
    } catch {}
  }
  return false;
}

/**
 * Detect which nerd fonts are installed (checks vendored dir + system font dirs).
 */
export function detectInstalledFonts(): NerdFont[] {
  const installed: NerdFont[] = [];

  for (const font of NERD_FONTS) {
    const vendoredDir = join(FONTS_DIR, font.id);
    if (existsSync(vendoredDir)) {
      try {
        const files = readdirSync(vendoredDir);
        if (files.some((f) => f.endsWith(".ttf") || f.endsWith(".otf"))) {
          installed.push(font);
          continue;
        }
      } catch {}
    }

    if (fontExistsOnSystem(font)) {
      installed.push(font);
    }
  }

  return installed;
}

/**
 * Check if any nerd font is installed.
 */
export function hasAnyNerdFont(): boolean {
  return detectInstalledFonts().length > 0;
}

/**
 * Install a nerd font from GitHub releases to ~/.soulforge/fonts/ and
 * symlink/copy into the user's font directory.
 */
export async function installFont(fontId: string): Promise<string> {
  const font = NERD_FONTS.find((f) => f.id === fontId);
  if (!font) {
    throw new Error(
      `Unknown font: ${fontId}. Available: ${NERD_FONTS.map((f) => f.id).join(", ")}`,
    );
  }

  mkdirSync(FONTS_DIR, { recursive: true });
  const fontDir = join(FONTS_DIR, font.id);

  if (!existsSync(fontDir) || readdirSync(fontDir).length === 0) {
    mkdirSync(fontDir, { recursive: true });

    // Download from Nerd Fonts releases (tar.xz)
    const url = `https://github.com/ryanoasis/nerd-fonts/releases/latest/download/${font.asset}.tar.xz`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Font download failed: ${response.status} ${response.statusText}`);
    }

    const tmpFile = join(fontDir, "download.tar.xz");
    const buffer = await response.arrayBuffer();
    await Bun.write(tmpFile, buffer);

    const result = extractTarXz(tmpFile, fontDir);
    if (!result.success) {
      throw new Error(`Font extract failed: ${result.error}`);
    }
    unlinkSync(tmpFile);

    // Remove non-font files (LICENSE, README)
    for (const f of readdirSync(fontDir)) {
      if (!f.endsWith(".ttf") && !f.endsWith(".otf")) {
        try {
          unlinkSync(join(fontDir, f));
        } catch {
          // directory or locked file, skip
        }
      }
    }
  }

  // Copy font files to user font directory
  const userFontDir = getUserFontDir();
  mkdirSync(userFontDir, { recursive: true });

  for (const file of readdirSync(fontDir)) {
    if (file.endsWith(".ttf") || file.endsWith(".otf")) {
      const src = join(fontDir, file);
      const dest = join(userFontDir, file);
      if (!existsSync(dest)) {
        const data = await Bun.file(src).arrayBuffer();
        await Bun.write(dest, data);
      }
    }
  }

  // Refresh font cache on Linux. macOS picks up new fonts automatically.
  // Windows: per-user fonts in %LOCALAPPDATA%\Microsoft\Windows\Fonts are
  // picked up on the next process launch — no admin / cache refresh required
  // on Win10 1809+.
  if (!IS_WIN && !IS_DARWIN) {
    try {
      const { spawnSync } = await import("node:child_process");
      spawnSync("fc-cache", ["-f"], { stdio: "ignore", timeout: 10_000 });
    } catch {
      // non-fatal
    }
  }

  return font.family;
}
