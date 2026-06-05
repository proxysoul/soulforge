#!/usr/bin/env bun

globalThis.AI_SDK_LOG_WARNINGS = false;

// Reap orphaned LSP processes from previous sessions BEFORE anything else.
// Synchronous so a crashed-during-boot run still cleans up its predecessors.
import { reapOrphanedLspProcesses } from "./core/intelligence/backends/lsp/pid-tracker.js";
// Replace Bun's native fetch with undici before any provider/module loads.
// See src/core/llm/http-agent.ts for rationale.
import { installGlobalFetch } from "./core/llm/http-agent.js";
// Self-heal the per-user data dir from `deps/` sibling to the .exe.
// No-op when running from source or as `dist/index.js` under bun.
import { hydrateCompiledRuntime } from "./core/utils/hydrate-runtime.js";

installGlobalFetch();
reapOrphanedLspProcesses();
hydrateCompiledRuntime();

const cliArgs = process.argv.slice(2);

// Honour --cwd before any module reads process.cwd(). One process = one cwd:
// every downstream consumer (config, repo map / soul map, intelligence,
// memory, all tools) inherits it for free via process.cwd().
resolveCwdFromArgv(cliArgs);

const hasCli =
  cliArgs.includes("--headless") ||
  cliArgs.includes("--list-providers") ||
  cliArgs.includes("--list-models") ||
  cliArgs.includes("--set-key") ||
  cliArgs.includes("--version") ||
  cliArgs.includes("-v") ||
  cliArgs.includes("--help") ||
  cliArgs.includes("-h");

// `soulforge hearth <sub>` takes precedence over the TUI boot path.
if (cliArgs[0] === "hearth") {
  const { parseHearthArgs, runHearthCli } = await import("./hearth/cli.js");
  const action = parseHearthArgs(cliArgs.slice(1));
  const code = await runHearthCli(action);
  process.exit(code);
}

// `soulforge remote <sub>` re-exports the permission CLI so users don't need
// the separate `soulforge-remote` bin on their PATH.
if (cliArgs[0] === "remote") {
  process.argv = [process.argv[0] ?? "bun", process.argv[1] ?? "soulforge", ...cliArgs.slice(1)];
  await import("./hearth/approve-cli.js");
  // approve-cli calls process.exit itself
  process.exit(0);
}

// `soulforge addon <install|remove|update|list> [proxy|neovim]` —
// out-of-band component management. Runs without booting the TUI.
// Accept both positional (`soulforge addon …`) and flag (`--addon …`) forms.
// Handled BEFORE the generic --help short-circuit so `addon -h` and
// `--addon -h` surface addon-specific usage instead of headless help.
{
  const isAddonVerb = cliArgs[0] === "addon" || cliArgs[0] === "addons";
  const flagIdx = cliArgs.findIndex((a) => a === "--addon" || a === "--addons");
  if (isAddonVerb || flagIdx !== -1) {
    const rest = isAddonVerb ? cliArgs.slice(1) : cliArgs.slice(flagIdx + 1);
    const { runAddonCli } = await import("./core/setup/addons.js");
    const code = await runAddonCli(rest);
    process.exit(code);
  }
}

if (hasCli) {
  const { parseHeadlessArgs, runHeadless } = await import("./headless/index.js");
  const action = await parseHeadlessArgs(cliArgs);
  if (action) await runHeadless(action);
  process.exit(0);
}

// Interactive presets wizard — pre-TUI, uses @clack/prompts.
if (cliArgs.includes("--presets") || cliArgs[0] === "presets") {
  const { runPresetsWizard } = await import("./core/presets/index.js");
  const code = await runPresetsWizard();
  process.exit(code);
}

// First-run addon wizard — pre-TUI, uses @clack/prompts. Runs once per
// install (gated on config.addonsPromptShown), skipped in non-TTY and when
// SOULFORGE_NO_PROMPT=1. Already-installed addons are dropped from the list.
{
  const { shouldRunAddonWizard, runAddonWizard } = await import("./core/setup/addon-wizard.js");
  if (shouldRunAddonWizard()) {
    await runAddonWizard();
  }
}

// Collect `--plugin <spec>` (stackable) and pass to the boot pipeline via env.
// Resolution + merge happens once AppConfig is loaded.
{
  const plugins: string[] = [];
  for (let i = 0; i < cliArgs.length; i++) {
    if (cliArgs[i] === "--plugin" && i + 1 < cliArgs.length) {
      const next = cliArgs[i + 1];
      if (next) plugins.push(next);
      i++;
    }
  }
  if (plugins.length > 0) process.env.SOULFORGE_PRESETS = plugins.join(",");
}

// Resolve presets (from config + --plugin env) into the AppConfig overlay
// before any loadConfig() consumer reads. Network call; fail-open if offline.
{
  const { initPresetsFromEnv } = await import("./core/presets/index.js");
  const verbose = cliArgs.includes("--verbose-presets");
  const report = await initPresetsFromEnv({
    onStatus: verbose ? (msg: string) => process.stderr.write(`[presets] ${msg}\n`) : undefined,
  });
  if (report.failed.length > 0 && !verbose) {
    process.stderr.write(
      `[presets] ${report.failed.length} failed (run with --verbose-presets for detail)\n`,
    );
  }
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commandExists, configDir, dataDir, isCompiledBinary } from "./core/platform/index.js";

const IS_COMPILED = isCompiledBinary(import.meta.url);
if (IS_COMPILED) {
  const bundledWorker = join(dataDir(), "opentui-assets", "parser.worker.js");
  if (!process.env.OTUI_TREE_SITTER_WORKER_PATH && existsSync(bundledWorker)) {
    process.env.OTUI_TREE_SITTER_WORKER_PATH = bundledWorker;
  }
}

import { getCwd } from "./core/cwd.js";
import { applyTheme, getThemeTokens, watchThemes } from "./core/theme/index.js";
import { resolveCwdFromArgv } from "./core/utils/resolve-cwd.js";
import { pickWordmark } from "./core/utils/splash.js";
import { logBackgroundError } from "./stores/errors.js";

// Sync-load theme name from config before React mounts
try {
  const raw = readFileSync(join(configDir(), "config.json"), "utf-8");
  const cfg = JSON.parse(raw);
  if (cfg.theme?.name)
    applyTheme(cfg.theme.name, cfg.theme?.transparent, {
      userMessageOpacity: cfg.theme?.userMessageOpacity,
      diffOpacity: cfg.theme?.diffOpacity,
      borderStrength: cfg.theme?.borderStrength,
    });
} catch {
  applyTheme("dark", true);
}
watchThemes();

const _t = getThemeTokens();

const cols = process.stdout.columns ?? 80;
const rows = process.stdout.rows ?? 24;

const bootStartWall = Date.now();

// ── Boot splash — wordmark animates, status line tracks modules ─────
// Hand-drawn "soulforge" wordmark (shared via splash.ts) recolored by
// the subprocess so the forge warms up as it loads.

const WORDMARK = pickWordmark(cols);
const WM_W = WORDMARK[0]?.length ?? 0;
const WM_H = WORDMARK.length;

// Layout: word (WM_H) + gap(1) + tagline(1) + gap(1) + status(1).
const LAYOUT_H = WM_H + 4;
const base = Math.max(1, Math.floor((rows - LAYOUT_H) / 2));

const ROW = {
  word: base,
  tagline: base + WM_H + 1,
  status: base + WM_H + 3,
};

// Minimal rune spinner — purposefully quiet. One glyph, rotating slowly.
const RUNES = ["ᛝ", "ᛉ", "ᛋ", "ᛏ", "ᚦ", "ᚱ", "ᚦ", "ᛏ", "ᛋ", "ᛉ"];

// Hex → ANSI SGR for the subprocess — backslash-escaped for embedding.
function hexToAnsi(hex: string): string {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `\\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

// Main-thread ANSI (for the one-time static paint).
function rgb(hex: string): string {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}
const RST = "\x1b[0m";
const ITALIC = "\x1b[3m";

// Main-thread colors (for the one-time tagline paint only).
const AMBER_C = rgb(_t.amber);
const MUTED_C = rgb(_t.textMuted);

// Ensure spinner subprocess is killed if boot crashes or is interrupted.
// This runs BEFORE index.tsx's signal handlers are registered.
function killSpinner(): void {
  try {
    spinnerProc?.kill();
  } catch {}
}
process.on("exit", killSpinner);
process.on("SIGINT", killSpinner);
process.on("SIGTERM", killSpinner);

// Spinner subprocess — recolors the wordmark each tick (smooth color
// cycle through brand → brandAlt → amber, applied uniformly to all
// rows so the chiseled forms stay readable) and draws the status line.
const spinnerProc = Bun.spawn(
  [
    process.execPath,
    "-e",
    `
const RST = "\\x1b[0m";
const BOLD_C = "\\x1b[1m";
const DIM_C = "\\x1b[2m";

const AMBER = "${hexToAnsi(_t.amber)}";
const MUTED = "${hexToAnsi(_t.textMuted)}";
const SUBTLE = "${hexToAnsi(_t.textFaint)}";

const PALETTE = ${JSON.stringify([_t.brand, _t.brandAlt, _t.amber])};
const WORDMARK = ${JSON.stringify(WORDMARK)};
const WM_W = ${WM_W};
const WM_H = ${WM_H};
const wmRow = ${ROW.word};
const wmCol = Math.max(1, Math.floor((${cols} - WM_W) / 2) + 1);

const statusRow = ${ROW.status};
const cols = ${cols};
const bootStart = ${bootStartWall};
const RUNES = ${JSON.stringify(RUNES)};

const at = (r, c) => "\\x1b[" + r + ";" + c + "H";

// Cycle through PALETTE every CYCLE_MS ms. Returns the interpolated
// hex (#rrggbb) so callers can further blend (e.g. sweep highlight).
const CYCLE_MS = 6000;
function cycledHex(now) {
  const t = ((now - bootStart) % CYCLE_MS) / CYCLE_MS; // 0..1
  const segments = PALETTE.length;
  const scaled = t * segments;
  const i = Math.floor(scaled);
  const frac = scaled - i;
  const a = PALETTE[i % segments];
  const b = PALETTE[(i + 1) % segments];
  return lerpHexRaw(a, b, frac);
}

// lerpHex returns an ANSI escape; lerpHexRaw returns "#rrggbb" so we
// can blend further before emitting.
function lerpHexRaw(a, b, t) {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  const hx = (v) => v.toString(16).padStart(2, "0");
  return "#" + hx(r) + hx(g) + hx(bl);
}

function hexToEsc(h) {
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return "\\x1b[38;2;" + r + ";" + g + ";" + b + "m";
}

let msgs = ["Awakening"];
let msgIdx = 0;
let msgSetAt = Date.now();
let tick = 0;

process.stdin.setEncoding("utf-8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line === "EXIT") { process.exit(0); }
    try { msgs = JSON.parse(line); msgIdx = 0; msgSetAt = Date.now(); } catch {}
  }
});

// Slow highlight sweep — a 3-cell bright band travels across the
// wordmark every SWEEP_MS ms, lifting glyphs toward HOT.
const SWEEP_MS = 4200;
const HOT = "#ffd68a"; // warm highlight target (amber-cream)

function sweepX(now) {
  const t = ((now - bootStart) % SWEEP_MS) / SWEEP_MS;
  return Math.floor(t * (WM_W + 8)) - 4;
}

function renderWordmark(now) {
  const baseHex = cycledHex(now);
  const baseEsc = hexToEsc(baseHex) + BOLD_C;
  const warmEsc = hexToEsc(lerpHexRaw(baseHex, HOT, 0.55)) + BOLD_C;
  const sx = sweepX(now);
  let out = "";
  for (let r = 0; r < WM_H; r++) {
    const line = WORDMARK[r];
    out += at(wmRow + r, wmCol);
    let curColor = "";
    for (let x = 0; x < line.length; x++) {
      const ch = line.charAt(x);
      if (ch === " ") { out += " "; continue; }
      const d = Math.abs(x - sx);
      const want = d <= 1 ? warmEsc : baseEsc;
      if (want !== curColor) {
        out += RST + want;
        curColor = want;
      }
      out += ch;
    }
    out += RST;
  }
  process.stdout.write(out);
}

function renderStatus(now) {
  if (msgs.length > 1 && now - msgSetAt > 1200) {
    msgIdx = (msgIdx + 1) % msgs.length;
    msgSetAt = now;
  }
  const msg = msgs[msgIdx % msgs.length] || msgs[0];
  const rune = RUNES[tick % RUNES.length];
  const plainW = 1 + 2 + msg.length;
  const c = Math.max(1, Math.floor((cols - plainW) / 2) + 1);
  process.stdout.write(
    at(statusRow, 1) + "\\x1b[2K" + at(statusRow, c)
    + AMBER + BOLD_C + rune + RST + "  "
    + MUTED + msg + RST
  );
}

setInterval(() => {
  tick++;
  const now = Date.now();
  renderWordmark(now);
  renderStatus(now);
}, 100);
`,
  ],
  {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "ignore",
    env: { ...process.env, BUN_BE_BUN: "1" },
    windowsHide: true,
  },
);

function status(...msgs: string[]): void {
  spinnerProc.stdin.write(`${JSON.stringify(msgs)}\n`);
}

function stopSpinner(): void {
  spinnerProc.stdin.write("EXIT\n");
  spinnerProc.stdin.end();
  // Remove early-boot signal handlers — index.tsx takes over cleanup from here.
  process.removeListener("exit", killSpinner);
  process.removeListener("SIGINT", killSpinner);
  process.removeListener("SIGTERM", killSpinner);
}

process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");

// Paint the tagline once. Wordmark is animated by the subprocess.
const QUIPS = [
  "forged in the graph · powered by soul",
  "runes tempered · embers rising",
  "every edit leaves a trace on the anvil",
  "the forge remembers what the flame forgets",
  "steel on graph · intent on wire",
];
const TAGLINE = QUIPS[Math.floor(Math.random() * QUIPS.length)] ?? QUIPS[0] ?? "";

{
  const tagCol = Math.max(1, Math.floor((cols - TAGLINE.length) / 2) + 1);
  let tag = `\x1b[${ROW.tagline};${tagCol}H`;
  for (const ch of TAGLINE) {
    if (ch === "·") tag += AMBER_C + ch + RST;
    else tag += MUTED_C + ITALIC + ch + RST;
  }
  tag += RST;
  process.stdout.write(tag);
}

const earlyModules = Promise.all([
  import("./config/index.js"),
  import("./core/editor/detect.js"),
  import("./core/icons.js"),
  import("./core/setup/install.js"),
]);

// App.tsx pulls in the entire tool/hook/AI SDK module graph (~3s).
// Kick it off here so the spinner (child process) shows progress.

status("Gathering soul fragments", "Unpacking the forge");
const appReady = import("./components/App.js");
const [configMod, detectMod, iconsMod, installMod] = await earlyModules;

const { loadConfig, loadProjectConfig } = configMod;
const { detectNeovim } = detectMod;
const { initNerdFont } = iconsMod;
const { getVendoredPath, installRipgrep, installFd, installLazygit, installAstGrep } = installMod;

// Honour `SOULFORGE_AUTO_INSTALL_ADDONS=proxy,neovim` BEFORE detection runs.
// CI / Docker hook — silent install of opted-in addons on first boot. Failures
// are logged, never fatal; we keep booting either way.
{
  const { autoInstallFromEnv } = await import("./core/setup/addons.js");
  await autoInstallFromEnv();
}

let resumeSessionId: string | undefined;
let forceWizard = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--session" || arg === "--resume" || arg === "-s") {
    resumeSessionId = args[i + 1];
    i++;
  } else if (arg?.startsWith("--session=")) {
    resumeSessionId = arg.slice("--session=".length);
  } else if (arg?.startsWith("--resume=")) {
    resumeSessionId = arg.slice("--resume=".length);
  } else if (arg === "--wizard") {
    forceWizard = true;
  }
}

status("Reading the scrolls");
const config = loadConfig();
const projectConfig = loadProjectConfig(getCwd());
initNerdFont(config.nerdFont);

{
  const priority = projectConfig?.keyPriority ?? config.keyPriority;
  if (priority) {
    const { setDefaultKeyPriority } = await import("./core/secrets.js");
    setDefaultKeyPriority(priority);
  }
}

// Register custom providers from global + project config (project overrides global by id)
{
  const globalP = config.providers ?? [];
  const projectP = projectConfig?.providers ?? [];
  if (globalP.length > 0 || projectP.length > 0) {
    const map = new Map(globalP.map((p) => [p.id, p]));
    for (const p of projectP) map.set(p.id, p);
    const { registerCustomProviders } = await import("./core/llm/providers/index.js");
    registerCustomProviders([...map.values()]);
  }
  // Sync provider secret keys into the secrets system (single source of truth)
  const { getProviderSecretEntries } = await import("./core/llm/providers/index.js");
  const { registerProviderSecrets } = await import("./core/secrets.js");
  registerProviderSecrets(getProviderSecretEntries());
}

// Pre-init ContextManager async — yields between heavy sync steps so the spinner stays alive.
const repoMapEnabled = (projectConfig?.repoMap ?? config.repoMap) !== false;
const contextManagerReady = import("./core/context/manager.js").then(({ ContextManager }) =>
  ContextManager.createAsync(getCwd(), (step) => status(step), { repoMapEnabled }),
);

// Detect nvim — DO NOT auto-install. Neovim is an opt-in addon now:
// users run `soulforge addon install neovim` (or set
// SOULFORGE_AUTO_INSTALL_ADDONS) to pull it in. When absent, the editor
// panel surfaces the install hint.
status("Summoning the editor spirit");
const nvim = detectNeovim();
if (nvim) {
  config.nvimPath = nvim.path;
  import("./core/editor/neovim.js")
    .then(({ bootstrapNeovimPlugins }) => {
      bootstrapNeovimPlugins(nvim.path);
    })
    .catch(() => {});
}

if (!getVendoredPath("rg")) {
  status("Sharpening the search blade");
  installRipgrep().catch((err) => {
    logBackgroundError(
      "boot",
      `ripgrep install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

if (!getVendoredPath("fd")) {
  status("Summoning the file finder");
  installFd().catch((err) => {
    logBackgroundError(
      "boot",
      `fd install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

if (!getVendoredPath("lazygit")) {
  status("Conjuring the git spirit");
  installLazygit().catch((err) => {
    logBackgroundError(
      "boot",
      `lazygit install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

// ast-grep powers structural_edit (polyglot AST edits) — a first-class edit
// tool, so vendor it eagerly like rg/fd. Skipped if a system copy is on PATH.
if (!getVendoredPath("ast-grep") && !commandExists("ast-grep") && !commandExists("sg")) {
  status("Forging the polyglot chisel");
  installAstGrep().catch((err) => {
    logBackgroundError(
      "boot",
      `ast-grep install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

status("Reaching out to the LLM gods", "Negotiating API keys");
const { checkProviders, notifyProviderSwitch } = await import("./core/llm/provider.js");
const { checkPrerequisites } = await import("./core/setup/prerequisites.js");
const { prewarmAllModels } = await import("./core/llm/models.js");
const [bootProviders, bootPrereqs] = await Promise.all([
  checkProviders(),
  Promise.resolve(checkPrerequisites()),
]);

// Auto-activate the saved provider (starts proxy if defaultModel is proxy/*).
// Without this the proxy stays dormant until the user re-selects it in /model.
{
  const bootModel = projectConfig?.defaultModel ?? config.defaultModel;
  if (bootModel && bootModel !== "none") {
    notifyProviderSwitch(bootModel).catch((err) => {
      logBackgroundError(
        "boot",
        `provider activation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
// Fire-and-forget — populates caches in background so Ctrl+L opens instantly.
prewarmAllModels();

// Fire-and-forget — keep a long-lived PowerShell process ready to serve
// clipboard image reads via stdin/stdout. After the one-time ~500-1500ms
// boot startup, each Ctrl+V image paste is ~50-200ms (just GetImage +
// PNG encode), not the 2-3s spawn-per-paste cost. On non-Windows no-op.
{
  const { startClipboardDaemon } = await import("./core/platform/clipboard.js");
  startClipboardDaemon();
}

status("Kicking the neurons awake", "Waking the tree-sitter");
// Ensure setIntelligenceClient() has run before warmup to avoid spawning
// duplicate LSP servers on both main thread and worker.
contextManagerReady
  .then(() => import("./core/intelligence/index.js"))
  .then(({ warmupIntelligence }) => warmupIntelligence(getCwd(), config.codeIntelligence))
  .catch((err) => {
    logBackgroundError(
      "boot",
      `intelligence warmup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

status("Assembling the forge", "Almost there", "Sharpening the tools");
const [{ App }, contextManager] = await Promise.all([appReady, contextManagerReady]);
// Instant — App.tsx already pulled these into the module cache
const { createCliRenderer } = await import("@opentui/core");
const { createRoot } = await import("@opentui/react");
const { start } = await import("./index.js");

status("Igniting");

stopSpinner();
process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");

await start({
  App,
  createCliRenderer,
  createRoot,
  config,
  projectConfig,
  resumeSessionId,
  forceWizard,
  bootProviders,
  bootPrereqs,
  contextManager,
});
