import { type createCliRenderer as CreateCliRenderer, TextAttributes } from "@opentui/core";
import type { createRoot as CreateRoot } from "@opentui/react";
import { startTransition, useCallback, useEffect, useState } from "react";
import type { App as AppComponent } from "./components/App.js";
import type { ContextManager } from "./core/context/manager.js";
import { getCwd } from "./core/cwd.js";
import { killAllNvimProcesses } from "./core/editor/neovim.js";
import { icon } from "./core/icons.js";
import { killAllLspSync } from "./core/intelligence/backends/lsp/pid-tracker.js";
import { disposeIntelligenceRouter } from "./core/intelligence/index.js";
import { deactivateCurrentProvider, type ProviderStatus } from "./core/llm/provider.js";
import { disposeMCPManager } from "./core/mcp/index.js";
import {
  disableProcessedInput,
  flushInputBuffer,
  installCtrlCGuard,
} from "./core/platform/console-win32.js";
import { killAllTracked, killProcessGroup } from "./core/process-tracker.js";
import { getRestartSpec } from "./core/restart.js";
import { flushEmergencySession } from "./core/sessions/emergency-save.js";
import type { PrerequisiteStatus } from "./core/setup/prerequisites.js";
import { closeAllTerminals } from "./core/terminal/manager.js";
import { getThemeTokens, useTheme } from "./core/theme/index.js";
import { garble } from "./core/utils/splash.js";
import { resetStatusBarStore } from "./stores/statusbar.js";
import { resetUIStore } from "./stores/ui.js";
import type { AppConfig } from "./types/index.js";
import { copyOsc52, copyToClipboard as nativeCopyToClipboard } from "./utils/clipboard.js";

let exitSessionId: string | null = null;
let renderer: Awaited<ReturnType<typeof CreateCliRenderer>> | null = null;

export function setExitSessionId(id: string | null): void {
  exitSessionId = id;
}

function restoreTerminal(): void {
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
  } catch {}
  try {
    // ?2048l: disable in-band resize notifications enabled at startup.
    process.stdout.write("\x1b[?2048l\x1b[?25h\x1b[0m");
  } catch {}
}

let cleanedUp = false;

function runCleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  restoreTerminal();
  try {
    deactivateCurrentProvider();
  } catch {}
  try {
    disposeIntelligenceRouter();
  } catch {}
  try {
    closeAllTerminals();
  } catch {}
  try {
    killAllTracked();
  } catch {}
  try {
    killAllNvimProcesses();
  } catch {}
  try {
    disposeMCPManager();
  } catch {}
  // Kill all LSP processes tracked by PID file — survives crashes/SIGKILL
  try {
    killAllLspSync();
  } catch {}
  // Nuclear fallback: kill entire process group to catch any orphaned grandchildren
  try {
    killProcessGroup();
  } catch {}
}

let bannerPrinted = false;

function hexToAnsi(hex: string): string {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = Number.parseInt(h, 16);
  return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

function printExitBanner(): void {
  if (bannerPrinted) return;
  bannerPrinted = true;
  process.stdout.write("\x1b[2J\x1b[H");
  if (exitSessionId) {
    const t = getThemeTokens();
    const brand = `\x1b[1m${hexToAnsi(t.brand)}`;
    const accent = `\x1b[1m${hexToAnsi(t.info)}`;
    const secondary = hexToAnsi(t.brandSecondary);
    const rst = "\x1b[0m";
    const shortId = exitSessionId.slice(0, 8);
    process.stdout.write(
      `${brand}${icon("ghost")} SoulForge${rst} session saved.\n` +
        `  Resume: ${accent}soulforge --session ${shortId}${rst}\n` +
        `  by ${brand}Proxy${secondary}Soul${rst}.com\n\n`,
    );
  }
}

export function cleanupAndExit(code = 0): void {
  runCleanup();
  renderer?.destroy();
  flushInputBuffer();
  printExitBanner();
  process.exit(code);
}

let triggerRestart: (() => void) | null = null;

export function restart(): void {
  triggerRestart?.();
}

/**
 * Replace the current process with a fresh instance of the binary.
 * Used after an in-app upgrade so the new version's code is actually loaded.
 * Works on macOS and Linux — spawns the new binary with inherited stdio,
 * then exits the current process so the terminal seamlessly transfers.
 */
export function hardRestart(): void {
  runCleanup();
  renderer?.destroy();
  // Clear screen and restore cursor before handing off
  process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
  const restart = getRestartSpec();
  // Spawn the (now-updated) binary with full terminal inheritance
  const child = Bun.spawn([restart.command, ...restart.args], {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
    windowsHide: false,
  });
  // Detach: let the child own the terminal, then exit this process.
  // unref() ensures our event loop doesn't wait for the child.
  child.unref();
  process.exit(0);
}

process.on("exit", () => {
  runCleanup();
  printExitBanner();
});

/**
 * Handle a caught signal: flush state, restore terminal, print exit banner,
 * then exit cleanly. We intentionally do NOT re-raise the signal — doing so
 * causes the parent shell (zsh, bash) to print "terminated sf" on the next
 * line, which scrolls past our exit banner.
 */
function reraiseSignal(_signal: NodeJS.Signals): void {
  flushEmergencySession();
  runCleanup();
  renderer?.destroy();
  printExitBanner();
  process.exit(0);
}

process.on("SIGINT", () => reraiseSignal("SIGINT"));
process.on("SIGTERM", () => reraiseSignal("SIGTERM"));
process.on("SIGHUP", () => reraiseSignal("SIGHUP"));

process.on("uncaughtException", (err) => {
  flushEmergencySession();
  restoreTerminal();
  process.stderr.write(`\nUncaught exception: ${err?.stack ?? err?.message ?? String(err)}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  flushEmergencySession();
  process.stderr.write(`\nUnhandled rejection: ${String(reason)}\n`);
});

const RESTART_STEPS = [
  "Quenching active flames…",
  "Rereading the scrolls…",
  "Consulting the LLM gods…",
  "Reforging the soul…",
];

const RESTART_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function RestartSplash({ onComplete }: { onComplete: () => void }) {
  const t = useTheme();
  const ghost = icon("ghost");
  const label = "Restarting";

  const [anim, setAnim] = useState({
    phase: 0,
    ghostFrame: ghost,
    typeIdx: 0,
    wordmark: garble("SOULFORGE"),
    spinIdx: 0,
  });

  useEffect(() => {
    let step = 0;
    const timer = setInterval(() => {
      step++;
      setAnim((prev) => {
        const next = { ...prev, spinIdx: prev.spinIdx + 1 };
        // Ghost fade out: frames 1-4
        if (step === 1) next.ghostFrame = "▓";
        if (step === 2) next.ghostFrame = "▒";
        if (step === 3) next.ghostFrame = "░";
        if (step === 4) next.ghostFrame = " ";
        // Ghost fade in: frames 6-9
        if (step === 6) next.ghostFrame = "░";
        if (step === 7) next.ghostFrame = "▒";
        if (step === 8) next.ghostFrame = "▓";
        if (step === 9) next.ghostFrame = ghost;
        // Typewriter: frames 10+
        if (step >= 10 && step <= 10 + label.length) {
          next.typeIdx = step - 10;
        }
        // Status steps
        if (step === 10 + label.length + 2) next.phase = 1;
        if (step === 10 + label.length + 5) next.phase = 2;
        if (step === 10 + label.length + 8) next.phase = 3;
        // Wordmark glitch
        if (step === 10 + label.length + 11) next.wordmark = garble("SOULFORGE");
        if (step === 10 + label.length + 12) next.wordmark = "SOULFORGE";
        if (step === 10 + label.length + 13) next.wordmark = garble("SOULFORGE");
        return next;
      });
      // Done
      if (step === 10 + label.length + 16) {
        clearInterval(timer);
        onComplete();
      }
    }, 50);
    return () => clearInterval(timer);
  }, [onComplete, ghost]);

  const visibleLabel = label.slice(0, anim.typeIdx);
  const cursor = anim.typeIdx < label.length ? "█" : "";
  const spin = RESTART_SPINNER[anim.spinIdx % RESTART_SPINNER.length];

  return (
    <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
      <text fg={t.brand} attributes={TextAttributes.BOLD}>
        {anim.ghostFrame}
      </text>
      <box height={1} />
      <text>
        <span fg={t.textSecondary}>{visibleLabel}</span>
        <span fg={t.brandSecondary}>{cursor}</span>
      </text>
      <box height={1} />
      <text fg={t.textDim}>{"─".repeat(30)}</text>
      <box height={1} />
      {RESTART_STEPS.map((step, i) => {
        if (i > anim.phase) return null;
        const done = i < anim.phase;
        return (
          <box key={step} gap={1} flexDirection="row">
            <text fg={done ? t.success : t.brand}>{done ? "✓" : spin}</text>
            <text fg={done ? t.textSecondary : t.textPrimary}>{step}</text>
          </box>
        );
      })}
      <box height={1} />
      <text fg={t.brand} attributes={TextAttributes.BOLD}>
        {anim.wordmark}
      </text>
    </box>
  );
}

interface StartOptions {
  App: typeof AppComponent;
  createCliRenderer: typeof CreateCliRenderer;
  createRoot: typeof CreateRoot;
  config: AppConfig;
  projectConfig: Partial<AppConfig> | null;
  resumeSessionId?: string;
  forceWizard?: boolean;
  bootProviders: ProviderStatus[];
  bootPrereqs: PrerequisiteStatus[];
  contextManager?: ContextManager;
}

function AppRoot({ opts }: { opts: StartOptions }) {
  const [appKey, setAppKey] = useState(0);
  const [restarting, setRestarting] = useState(false);
  const [freshConfig, setFreshConfig] = useState(opts.config);
  const [freshProjectConfig, setFreshProjectConfig] = useState(opts.projectConfig);
  const [freshProviders, setFreshProviders] = useState(opts.bootProviders);
  const [freshPrereqs, setFreshPrereqs] = useState(opts.bootPrereqs);
  const [contextManager, setContextManager] = useState(opts.contextManager);

  useEffect(() => {
    triggerRestart = () => setRestarting(true);
    return () => {
      triggerRestart = null;
    };
  }, []);

  const handleRestartComplete = useCallback(async () => {
    resetStatusBarStore();
    resetUIStore();

    try {
      const { loadConfig, loadProjectConfig } = await import("./config/index.js");
      const { checkProviders } = await import("./core/llm/provider.js");
      const { checkPrerequisites } = await import("./core/setup/prerequisites.js");

      const newConfig = loadConfig();
      const newProjectConfig = loadProjectConfig(getCwd());
      const [newProviders, newPrereqs] = await Promise.all([
        checkProviders(),
        Promise.resolve(checkPrerequisites()),
      ]);

      const kp = newProjectConfig?.keyPriority ?? newConfig.keyPriority;
      if (kp) {
        const { setDefaultKeyPriority } = await import("./core/secrets.js");
        setDefaultKeyPriority(kp);
      }

      setFreshConfig(newConfig);
      setFreshProjectConfig(newProjectConfig);
      setFreshProviders(newProviders);
      setFreshPrereqs(newPrereqs);
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: intentional error surfacing on restart failure
      console.error("Restart config reload failed:", err);
    }
    // Batch all state updates to avoid 7 separate re-renders after await
    startTransition(() => {
      setContextManager(undefined);
      setExitSessionId(null);
      setAppKey((k) => k + 1);
      setRestarting(false);
    });
  }, []);

  if (restarting) {
    return <RestartSplash onComplete={handleRestartComplete} />;
  }

  return (
    <opts.App
      key={appKey}
      config={freshConfig}
      projectConfig={freshProjectConfig}
      resumeSessionId={appKey === 0 ? opts.resumeSessionId : undefined}
      forceWizard={appKey === 0 && opts.forceWizard}
      bootProviders={freshProviders}
      bootPrereqs={freshPrereqs}
      preloadedContextManager={contextManager}
    />
  );
}

export async function start(opts: StartOptions): Promise<void> {
  const r = await opts.createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: { disambiguate: true },
    openConsoleOnError: false,
    // Pipes child-process output (nvim, shell tools, lazygit) directly to the
    // host terminal instead of buffering in the renderer.
    externalOutputMode: "passthrough",
    // Cap render rate to a steady 60fps so streaming chat + animations don't
    // burn CPU on fast terminals (default is uncapped).
    targetFps: 60,
    // Track mouse motion so onMouseOver/onMouseOut fire on hovered rows
    // (user messages, tool rows, reasoning fold). Hold Shift in most
    // terminals to bypass the renderer and select text natively.
    enableMouseMovement: true,
    useMouse: true,
    consoleOptions: {
      keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
    },
  });
  renderer = r;
  disableProcessedInput();
  installCtrlCGuard();
  r.console.onCopySelection = (text: string) => {
    if (!text || text.length === 0) return;
    if (!r.copyToClipboardOSC52(text)) copyOsc52(text);
    nativeCopyToClipboard(text);
    r.clearSelection();
  };
  // Set initial terminal title; per-tab/session updates wire in App.tsx.
  try {
    r.setTerminalTitle("SoulForge");
  } catch {}

  // 20+ components use useKeyboard/useOnResize concurrently — raise the
  // default EventEmitter limit (10) to suppress spurious leak warnings.
  r.setMaxListeners(30);
  r.keyInput.setMaxListeners(30);

  // Resize handling beyond SIGWINCH (#91) — some transports drop the signal
  // entirely (Win32-OpenSSH client → sshd loses window-change), so the
  // renderer's SIGWINCH handler never fires even though the PTY size updated.
  //
  // Primary: DEC mode 2048 in-band resize notifications (the mechanism modern
  // TUIs use instead of SIGWINCH). The terminal reports size changes as a
  // stdin escape sequence — CSI 48 ; rows ; cols ; hpix ; wpix t — which
  // travels the same data stream as keystrokes, so it survives any transport
  // that delivers input at all. Supported by kitty, ghostty, iTerm2, foot;
  // unsupported terminals ignore the enable sequence — strictly additive.
  if (process.stdout.isTTY) {
    r.addInputHandler((sequence: string) => {
      const m = sequence.match(/^\x1b\[48;(\d+);(\d+)(?:;\d+;\d+)?t$/);
      if (!m?.[1] || !m[2]) return false;
      const rows = Number.parseInt(m[1], 10);
      const cols = Number.parseInt(m[2], 10);
      if (rows > 0 && cols > 0) r.resize(cols, rows);
      return true;
    });
    process.stdout.write("\x1b[?2048h");

    // Fallback: 1s watchdog reconciling TIOCGWINSZ-backed stdout dims for
    // terminals without mode 2048 (xterm, Alacritty, Windows Terminal — the
    // exact transport in #91). No-op when sizes match; renderer.resize() is
    // the documented hook for externally-driven resizes.
    const resizePoll = setInterval(() => {
      try {
        const cols = process.stdout.columns;
        const rows = process.stdout.rows;
        if (!cols || !rows) return;
        if (cols !== r.terminalWidth || rows !== r.terminalHeight) {
          r.resize(cols, rows);
        }
      } catch {}
    }, 1000);
    resizePoll.unref?.();
  }

  // Register custom renderables for JSX usage
  {
    const { extend } = await import("@opentui/react");
    const { TextTableRenderable } = await import("@opentui/core");
    extend({ "text-table": TextTableRenderable });

    // Native .node addon can't be embedded in compiled binaries — graceful fallback.
    // Windows: ghostty-opentui currently segfaults during dlopen on bun 1.3.x
    // (native addon ABI mismatch), crashing the whole process before any
    // JS catch can fire. Skip entirely unless the user opts in with
    // SOULFORGE_ENABLE_GHOSTTY=1 so floating terminal can be tested
    // once upstream ships a compatible build.
    const { ghosttyDisabled } = await import("./core/platform/index.js");
    if (!ghosttyDisabled()) {
      try {
        const { GhosttyTerminalRenderable } = await import("ghostty-opentui/terminal-buffer");
        // ghostty-opentui may resolve a different @opentui/core version, so the
        // class can't satisfy extend()'s precise generic. Bridge via `unknown`
        // to keep strict-mode happy without an `as any` escape hatch.
        type Extendable = Parameters<typeof extend>[0][string];
        extend({ "ghostty-terminal": GhosttyTerminalRenderable as unknown as Extendable });
      } catch {}
    }
  }

  try {
    const { sendBeacon, maybeShowTelemetryNotice, detectTerminalBucket, detectRuntime } =
      await import("./core/telemetry.js");
    const { detectModelFamily, telemetryModelInfo } = await import(
      "./core/llm/provider-options.js"
    );
    const { CURRENT_VERSION, detectInstallMethod } = await import("./core/version.js");
    const { loadConfig, saveGlobalConfig } = await import("./config/index.js");
    const cfg = loadConfig();
    maybeShowTelemetryNotice(cfg, () => saveGlobalConfig({ telemetryNoticeShown: true }));
    const hasModel = cfg.defaultModel !== "none";
    const info = hasModel ? telemetryModelInfo(cfg.defaultModel) : undefined;
    sendBeacon(
      {
        surface: "tui",
        version: CURRENT_VERSION,
        install: detectInstallMethod(),
        family: hasModel ? detectModelFamily(cfg.defaultModel) : undefined,
        provider: info?.provider,
        model: info?.model,
        mode: cfg.defaultForgeMode ?? "default",
        terminal: detectTerminalBucket(),
        runtime: detectRuntime(),
        repomap: process.env.SOULFORGE_NO_REPOMAP === "1" ? "skipped" : "on",
      },
      cfg.telemetry,
    );
  } catch {}

  opts.createRoot(r).render(<AppRoot opts={opts} />);
}
export function getActiveRenderer(): Awaited<ReturnType<typeof CreateCliRenderer>> | null {
  return renderer;
}
