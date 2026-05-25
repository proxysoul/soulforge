import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadProjectConfig } from "../../../../config/index.js";
import { commandExists, configDir, IS_WIN, userDataDir } from "../../../platform/index.js";
import type { Language } from "../../types.js";

export interface LspServerConfig {
  command: string;
  args: string[];
  language: Language;
}

interface ServerCandidate {
  command: string;
  args: string[];
}

const SERVER_CANDIDATES: Record<string, ServerCandidate[]> = {
  typescript: [
    { command: "typescript-language-server", args: ["--stdio"] },
    { command: "biome", args: ["lsp-proxy"] },
    { command: "deno", args: ["lsp"] },
    { command: "vscode-eslint-language-server", args: ["--stdio"] },
  ],
  javascript: [
    { command: "typescript-language-server", args: ["--stdio"] },
    { command: "biome", args: ["lsp-proxy"] },
    { command: "deno", args: ["lsp"] },
    { command: "vscode-eslint-language-server", args: ["--stdio"] },
  ],
  python: [
    { command: "pyright-langserver", args: ["--stdio"] },
    { command: "pylsp", args: [] },
  ],
  go: [{ command: "gopls", args: ["serve"] }],
  rust: [{ command: "rust-analyzer", args: [] }],
  lua: [{ command: "lua-language-server", args: [] }],
  c: [{ command: "clangd", args: [] }],
  cpp: [{ command: "clangd", args: [] }],
  ruby: [{ command: "solargraph", args: ["stdio"] }],
  php: [{ command: "intelephense", args: ["--stdio"] }],
  zig: [{ command: "zls", args: [] }],
  bash: [{ command: "bash-language-server", args: ["start"] }],
  css: [
    { command: "vscode-css-language-server", args: ["--stdio"] },
    { command: "biome", args: ["lsp-proxy"] },
    { command: "tailwindcss-language-server", args: ["--stdio"] },
  ],
  html: [
    { command: "vscode-html-language-server", args: ["--stdio"] },
    { command: "emmet-language-server", args: ["--stdio"] },
  ],
  json: [
    { command: "vscode-json-language-server", args: ["--stdio"] },
    { command: "biome", args: ["lsp-proxy"] },
  ],
  yaml: [{ command: "yaml-language-server", args: ["--stdio"] }],
  toml: [{ command: "taplo", args: ["lsp", "stdio"] }],
  dockerfile: [{ command: "docker-langserver", args: ["--stdio"] }],
  java: [{ command: "jdtls", args: [] }],
  kotlin: [{ command: "kotlin-language-server", args: [] }],
  scala: [{ command: "metals", args: [] }],
  csharp: [
    { command: "csharp-ls", args: [] },
    { command: "OmniSharp", args: ["--languageserver"] },
  ],
  swift: [{ command: "sourcekit-lsp", args: [] }],
  dart: [{ command: "dart", args: ["language-server", "--protocol=lsp"] }],
  elixir: [
    { command: "elixir-ls", args: [] },
    { command: "expert", args: [] },
  ],
  ocaml: [{ command: "ocamllsp", args: [] }],
  vue: [{ command: "vue-language-server", args: ["--stdio"] }],
};

/** Mason installs LSP servers here (NVIM_APPNAME=soulforge isolates the data dir) */
const MASON_BIN_DIR = join(userDataDir(), "mason", "bin");

/** SoulForge installs LSP servers here via /lsp-install */
const SOULFORGE_BIN_DIR = join(configDir(), "lsp-servers");

/** Suffixes to probe when looking up a server binary. Windows installs as
 * `.cmd` shims (npm) or `.exe` (native), so we must try those before giving up. */
const BIN_SUFFIXES = IS_WIN ? [".exe", ".cmd", ""] : [""];

function firstExisting(dir: string, cmd: string): string | null {
  for (const sfx of BIN_SUFFIXES) {
    const p = join(dir, cmd + sfx);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Check if a command exists in Mason's bin directory */
function commandExistsInMason(cmd: string): string | null {
  return firstExisting(MASON_BIN_DIR, cmd);
}

/** Check SoulForge's own install directory */
function findInSoulforge(cmd: string): string | null {
  // npm-installed servers go to node_modules/.bin/
  const npmBin = firstExisting(join(SOULFORGE_BIN_DIR, "node_modules", ".bin"), cmd);
  if (npmBin) return npmBin;
  // pip/go/cargo-installed servers go to bin/
  const directBin = firstExisting(join(SOULFORGE_BIN_DIR, "bin"), cmd);
  if (directBin) return directBin;
  return null;
}

/** Cache of resolved commands: name → absolute path (or name if on PATH) */
const probeCache = new Map<string, string | null>();

/**
 * Resolve a command name to an executable path.
 * Checks $PATH first, then Mason's bin directory.
 * Returns the resolved command string or null if not found.
 */
function resolveCommand(cmd: string): string | null {
  const cached = probeCache.get(cmd);
  if (cached !== undefined) return cached;

  // 1. Check $PATH
  if (commandExists(cmd)) {
    probeCache.set(cmd, cmd);
    return cmd;
  }

  // 2. Check SoulForge's install directory
  const sfPath = findInSoulforge(cmd);
  if (sfPath) {
    probeCache.set(cmd, sfPath);
    return sfPath;
  }

  // 3. Check Mason's install directory
  const masonPath = commandExistsInMason(cmd);
  if (masonPath) {
    probeCache.set(cmd, masonPath);
    return masonPath;
  }

  probeCache.set(cmd, null);
  return null;
}

/** Check if a server command is disabled by user config */
function isServerDisabled(cmd: string): boolean {
  const cwd = process.cwd();
  const global = loadConfig();
  const project = loadProjectConfig(cwd);
  const disabled = project?.disabledLspServers ?? global.disabledLspServers ?? [];
  return disabled.includes(cmd);
}

/**
 * Find ALL available LSP servers for the given language.
 * Returns them in priority order (first = highest priority).
 * Skips servers that are disabled in user config or not found on PATH.
 */
export function findServersForLanguage(language: Language): LspServerConfig[] {
  const candidates = SERVER_CANDIDATES[language];
  if (!candidates) return [];

  const results: LspServerConfig[] = [];
  for (const candidate of candidates) {
    if (isServerDisabled(candidate.command)) continue;
    const resolved = resolveCommand(candidate.command);
    if (resolved) {
      results.push({
        command: resolved,
        args: candidate.args,
        language,
      });
    }
  }
  return results;
}

/** Clear the probe cache (useful for testing) */
export function clearProbeCache(): void {
  probeCache.clear();
}
