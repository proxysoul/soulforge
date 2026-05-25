/**
 * HearthSettings — full-screen dashboard for Hearth surfaces / daemon / pairings / logs.
 *
 * Layout:
 *   ┌─ header ───────────────────────────────────────────────────────────┐
 *   │ sidebar (nav)     │  content pane (detail / forms)                 │
 *   │ • Surfaces        │  ┌ title ──────────────────────┐                │
 *   │   Daemon          │  │ master list │ detail panel │                │
 *   │   Pairings        │  └──────────────────────────────┘                │
 *   │   Logs            │                                                 │
 *   └─ footer hints ─────────────────────────────────────────────────────┘
 *
 * Paste works in every input via the renderer's bracketed-paste event — tokens,
 * chat ids, cwds, kind/id fields and the log filter share one handler.
 *
 * Daemon start/stop spawn detached so the TUI survives restarts. Log tail
 * auto-scrolls, severity-colours each line, and supports a live filter.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { decodePasteBytes, type PasteEvent, TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { icon } from "../../core/icons.js";
import { configDir, findOnPath, IS_WIN } from "../../core/platform/index.js";
import { hasSecret, setSecret } from "../../core/secrets.js";
import { useTheme } from "../../core/theme/index.js";
import {
  getMe,
  loadHearthConfig,
  type TelegramBotInfo,
  writeGlobalHearthConfig,
} from "../../hearth/index.js";
import { socketRequest } from "../../hearth/protocol.js";
import {
  getServiceStatus,
  installService,
  type ServiceStatus,
  uninstallService,
} from "../../hearth/service.js";
import {
  HEARTH_PROTOCOL_VERSION,
  type HealthResponse,
  type HearthConfig,
  type HearthSurfaceConfig,
  type IssueCodeRequest,
  type IssueCodeResponse,
  type ReloadRequest,
  type ReloadResponse,
  type SurfaceId,
} from "../../hearth/types.js";
import { logBackgroundError } from "../../stores/errors.js";
import { Overlay } from "../layout/shared.js";

// ── Layout constants ───────────────────────────────────────────────────────

const MIN_WIDTH = 100;
const MAX_WIDTH = 150;
const WIDTH_RATIO = 0.92;
const SIDEBAR_W = 22;
const MAX_HEIGHT_RATIO = 0.9;
const MIN_BODY_ROWS = 18;
const CARD_PAD = 2;

// ── Types ──────────────────────────────────────────────────────────────────

type Tab = "surfaces" | "daemon" | "pairings" | "logs";
const TABS: Tab[] = ["surfaces", "daemon", "pairings", "logs"];
const TAB_LABEL: Record<Tab, string> = {
  surfaces: "Surfaces",
  daemon: "Daemon",
  pairings: "Pairings",
  logs: "Logs",
};
const TAB_ICON: Record<Tab, string> = {
  surfaces: "network",
  daemon: "bolt",
  pairings: "key",
  logs: "plan",
};
const TAB_BLURB: Record<Tab, string> = {
  surfaces: "Bots · tokens · chats",
  daemon: "Lifecycle · health · sockets",
  pairings: "Chats bound per surface",
  logs: "Live tail · severity · filter",
};

interface Props {
  visible: boolean;
  onClose: () => void;
}

type ProviderKind = "telegram" | "discord";

type QuickTelegramField = "token" | "userId" | "cwd";
type QuickDiscordField = "appId" | "token" | "channelId" | "userId" | "cwd";

type Mode =
  | { k: "list" }
  | { k: "pickProvider"; cursor: number }
  | {
      k: "quickTelegram";
      field: QuickTelegramField;
      token: string;
      userId: string;
      cwd: string;
      bot: TelegramBotInfo | null;
      validating: boolean;
      error: string | null;
    }
  | {
      k: "quickDiscord";
      field: QuickDiscordField;
      appId: string;
      token: string;
      channelId: string;
      userId: string;
      cwd: string;
      error: string | null;
    }
  | { k: "addSurface"; field: "kind" | "id"; kind: string; id: string }
  | { k: "addChat"; surfaceId: SurfaceId; field: "chatId" | "cwd"; chatId: string; cwd: string }
  | { k: "token"; surfaceId: SurfaceId; value: string }
  | { k: "pairCode"; surfaceId: SurfaceId; code: string }
  | {
      k: "addAllowed";
      surfaceId: SurfaceId;
      field: "chatId" | "userId";
      chatId: string;
      userId: string;
    };

const PROVIDERS: Array<{
  kind: ProviderKind;
  label: string;
  blurb: string;
  macOnly: boolean;
}> = [
  {
    kind: "telegram",
    label: "Telegram",
    blurb: "Bot API · long-poll · works anywhere",
    macOnly: false,
  },
  {
    kind: "discord",
    label: "Discord",
    blurb: "Gateway WS · DM or channel · MESSAGE_CONTENT intent",
    macOnly: false,
  },
];

interface DaemonStatus {
  running: boolean;
  uptimeMs?: number;
  pendingApprovals?: number;
  surfaces?: HealthResponse["surfaces"];
  stats?: import("../../hearth/types.js").HearthLifetimeStats;
  /** Which process drives long-polls — surfaced in the daemon header. */
  surfaceOwner?: "daemon" | "tui" | "unknown";
  surfaceOwnerPid?: number;
  error?: string;
}

type Theme = ReturnType<typeof useTheme>;

// ── Helpers ────────────────────────────────────────────────────────────────

function surfaceIdFrom(kind: string, id: string): SurfaceId {
  return `${kind}:${id}` as SurfaceId;
}

function tokenSecretKey(surfaceId: string): string | null {
  const [kind, id] = surfaceId.split(":");
  if (!kind || !id) return null;
  return `${kind}.bot.${id}`;
}

function formatUptime(ms?: number): string {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ${String(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${String(h)}h ${String(m % 60)}m`;
}

async function probeDaemon(socketPath: string): Promise<DaemonStatus> {
  if (!existsSync(socketPath)) return { running: false };
  try {
    const res = (await socketRequest(
      { op: "health", v: HEARTH_PROTOCOL_VERSION },
      { path: socketPath, timeoutMs: 1200 },
    )) as unknown as HealthResponse;
    if (!res || res.ok !== true) return { running: false, error: "health check failed" };
    return {
      running: true,
      uptimeMs: res.uptime,
      pendingApprovals: res.pendingApprovals,
      surfaces: res.surfaces,
      stats: res.stats,
      surfaceOwner: res.surfaceOwner,
      surfaceOwnerPid: res.surfaceOwnerPid,
    };
  } catch (err) {
    return { running: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Mint a pairing code via the running daemon. Local generation doesn't work —
 *  only the daemon's PairingRegistry is consulted when the user types
 *  `/pair <CODE>` from Telegram. Returns `{error}` when the daemon is down. */
async function issuePairingCodeViaDaemon(
  socketPath: string,
  surfaceId: SurfaceId,
): Promise<{ code?: string; error?: string }> {
  if (!existsSync(socketPath)) {
    return { error: "Daemon not running — start it from the Daemon tab first." };
  }
  try {
    const res = await socketRequest<IssueCodeRequest, IssueCodeResponse>(
      { op: "issue-code", v: HEARTH_PROTOCOL_VERSION, surfaceId },
      { path: socketPath, timeoutMs: 3000 },
    );
    if (!res.ok || !res.code) {
      return { error: res.error ?? "daemon refused to mint a code" };
    }
    return { code: res.code };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function appendToMode(mode: Mode, chunk: string): Mode {
  if (!chunk) return mode;
  switch (mode.k) {
    case "addSurface":
      return mode.field === "kind"
        ? { ...mode, kind: mode.kind + chunk }
        : { ...mode, id: mode.id + chunk };
    case "addChat":
      return mode.field === "chatId"
        ? { ...mode, chatId: mode.chatId + chunk }
        : { ...mode, cwd: mode.cwd + chunk };
    case "token":
      return { ...mode, value: mode.value + chunk };
    case "addAllowed":
      return mode.field === "chatId"
        ? { ...mode, chatId: mode.chatId + chunk }
        : { ...mode, userId: mode.userId + chunk };
    case "quickTelegram": {
      const next = { ...mode } as Extract<Mode, { k: "quickTelegram" }>;
      if (mode.field === "token") next.token = mode.token + chunk;
      else if (mode.field === "userId") next.userId = mode.userId + chunk;
      else next.cwd = mode.cwd + chunk;
      return next;
    }
    case "quickDiscord": {
      const next = { ...mode } as Extract<Mode, { k: "quickDiscord" }>;
      if (mode.field === "appId") next.appId = mode.appId + chunk;
      else if (mode.field === "token") next.token = mode.token + chunk;
      else if (mode.field === "channelId") next.channelId = mode.channelId + chunk;
      else if (mode.field === "userId") next.userId = mode.userId + chunk;
      else next.cwd = mode.cwd + chunk;
      return next;
    }
    default:
      return mode;
  }
}

function cycleField<T extends string>(current: T, order: readonly T[]): T {
  const idx = order.indexOf(current);
  return order[(idx + 1) % order.length] ?? current;
}

const TG_FIELD_ORDER: readonly QuickTelegramField[] = ["token", "userId", "cwd"];
const DISCORD_FIELD_ORDER: readonly QuickDiscordField[] = [
  "appId",
  "token",
  "channelId",
  "userId",
  "cwd",
];
function severityColor(line: string, t: Theme): string {
  const l = line.toLowerCase();
  if (l.includes(" error") || l.includes("failed") || l.includes("✗")) return t.error;
  if (l.includes(" warn") || l.includes("⚠") || l.includes("timeout")) return t.warning;
  if (l.includes("online") || l.includes("ready") || l.includes("✓")) return t.success;
  if (l.includes("pair") || l.includes("approval") || l.includes("socket")) return t.info;
  return t.textSecondary;
}

// ── Layout primitives ──────────────────────────────────────────────────────

function HRow({ w, children }: { w: number; children: ReactNode }) {
  const t = useTheme();
  return (
    <box flexDirection="row" width={w} flexShrink={0} backgroundColor={t.bgPopup}>
      {children}
    </box>
  );
}

function VSpacer({ rows = 1 }: { rows?: number }) {
  const t = useTheme();
  return <box height={rows} flexShrink={0} backgroundColor={t.bgPopup} />;
}

function Divider({ w, label, t }: { w: number; label?: string; t: Theme }) {
  if (!label) {
    return (
      <HRow w={w}>
        <text bg={t.bgPopup} fg={t.textFaint}>
          {"─".repeat(Math.max(0, w))}
        </text>
      </HRow>
    );
  }
  const pad = Math.max(0, w - label.length - 6);
  const left = 2;
  const right = pad - left;
  return (
    <HRow w={w}>
      <text bg={t.bgPopup} fg={t.textFaint}>
        {"─".repeat(left)}
      </text>
      <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
        {" "}
        {label}{" "}
      </text>
      <text bg={t.bgPopup} fg={t.textFaint}>
        {"─".repeat(Math.max(0, right))}
      </text>
    </HRow>
  );
}

function StatusDot({ t, on }: { t: Theme; on: boolean }) {
  return (
    <text bg={t.bgPopup} fg={on ? t.success : t.textDim}>
      {on ? "●" : "○"}
    </text>
  );
}

function KV({
  k,
  v,
  t,
  labelW = 22,
  valueColor,
}: {
  k: string;
  v: string;
  t: Theme;
  labelW?: number;
  valueColor?: string;
}) {
  return (
    <box flexDirection="row" flexShrink={0} backgroundColor={t.bgPopup}>
      <text bg={t.bgPopup} fg={t.textDim}>
        {"  "}
        {k.padEnd(labelW).slice(0, labelW)}
      </text>
      <text bg={t.bgPopup} fg={valueColor ?? t.textPrimary}>
        {v}
      </text>
    </box>
  );
}

function FooterHints({
  hints,
  w,
  t,
}: {
  hints: { key: string; label: string }[];
  w: number;
  t: Theme;
}) {
  return (
    <box
      flexDirection="row"
      width={w}
      flexShrink={0}
      paddingX={CARD_PAD}
      height={1}
      backgroundColor={t.bgPopup}
    >
      {hints.map((h, i) => (
        <text key={`${h.key}-${String(i)}`} bg={t.bgPopup}>
          <span bg={t.bgPopup} fg={t.textFaint}>
            {i === 0 ? "" : "   "}
          </span>
          <span bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
            {h.key}
          </span>
          <span bg={t.bgPopup} fg={t.textMuted}>
            {" "}
            {h.label}
          </span>
        </text>
      ))}
    </box>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export function HearthSettings({ visible, onClose }: Props) {
  const t = useTheme();
  const renderer = useRenderer();
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const popupWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(termCols * WIDTH_RATIO)));
  const innerW = popupWidth - 2;
  const contentW = innerW - SIDEBAR_W - 1;
  const popupHeight = Math.max(
    MIN_BODY_ROWS + 8,
    Math.min(termRows - 2, Math.floor(termRows * MAX_HEIGHT_RATIO)),
  );
  const bodyRows = Math.max(MIN_BODY_ROWS, popupHeight - 8);

  const [tab, setTab] = useState<Tab>("surfaces");
  const [config, setConfig] = useState<HearthConfig>(() => loadHearthConfig());
  const [status, setStatus] = useState<DaemonStatus>({ running: false });
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ k: "list" });
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logScroll, setLogScroll] = useState(0);
  const [logAutoscroll, setLogAutoscroll] = useState(true);
  const [logFilter, setLogFilter] = useState("");
  const [logFilterFocused, setLogFilterFocused] = useState(false);
  const logWatcherRef = useRef<FSWatcher | null>(null);
  const daemonProcRef = useRef<ChildProcess | null>(null);
  const mountedRef = useRef(false);
  const bootLogRef = useRef<string | null>(null);
  const statusRef = useRef<DaemonStatus>({ running: false });
  const [startupError, setStartupError] = useState<string | null>(null);
  const [service, setService] = useState<ServiceStatus | null>(null);

  const flashMsg = useCallback((kind: "ok" | "err", msg: string) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlash({ kind, msg });
    flashTimer.current = setTimeout(() => setFlash(null), 3000);
  }, []);

  const refreshConfig = useCallback(() => {
    setConfig(loadHearthConfig());
  }, []);

  const refreshStatus = useCallback(async () => {
    const cfg = loadHearthConfig();
    const st = await probeDaemon(cfg.daemon.socketPath);
    // If the TUI owns surfaces in this process, fold its live state into
    // status.surfaces so the Connection field reflects reality (otherwise the
    // daemon reports an empty surface list while the TUI is the actual poller).
    try {
      const { getTuiHost } = await import("../../hearth/tui-host.js");
      const tui = getTuiHost();
      if (tui.isActive()) {
        const tuiSurfaces = tui.listSurfaceStates();
        const merged = [...(st.surfaces ?? [])];
        for (const s of tuiSurfaces) {
          const idx = merged.findIndex((m) => m.id === s.id);
          if (idx >= 0) merged[idx] = s;
          else merged.push(s);
        }
        st.surfaces = merged;
        if (!st.running) {
          st.running = true;
          st.uptimeMs = tui.getUptimeMs();
          st.surfaceOwner = "tui";
          st.surfaceOwnerPid = process.pid;
        }
      }
    } catch {}
    statusRef.current = st;
    setStatus(st);
    if (st.running) setStartupError(null);
  }, []);

  useEffect(() => {
    if (!visible) return;
    mountedRef.current = true;
    refreshConfig();
    void refreshStatus();
    const poll = setInterval(() => {
      void refreshStatus();
    }, 4000);
    return () => {
      mountedRef.current = false;
      clearInterval(poll);
    };
  }, [visible, refreshConfig, refreshStatus]);

  // Filtered log lines (case-insensitive substring)
  const filteredLogs = useMemo(() => {
    if (!logFilter.trim()) return logLines;
    const q = logFilter.trim().toLowerCase();
    return logLines.filter((l) => l.toLowerCase().includes(q));
  }, [logLines, logFilter]);

  // Log tailing — watch file and re-read
  useEffect(() => {
    if (!visible || tab !== "logs") {
      if (logWatcherRef.current) {
        logWatcherRef.current.close();
        logWatcherRef.current = null;
      }
      return;
    }
    const path = config.daemon.logFile;
    const read = () => {
      try {
        if (!existsSync(path)) {
          setLogLines(["(log file not yet created — start the daemon from the Daemon tab)"]);
          return;
        }
        const raw = readFileSync(path, "utf-8");
        const lines = raw.split("\n").filter(Boolean).slice(-1000);
        setLogLines(lines);
      } catch (err) {
        setLogLines([`(failed to read log: ${err instanceof Error ? err.message : String(err)})`]);
      }
    };
    read();
    try {
      logWatcherRef.current = watch(path, { persistent: false }, () => read());
    } catch {
      const iv = setInterval(read, 2000);
      return () => clearInterval(iv);
    }
    return () => {
      logWatcherRef.current?.close();
      logWatcherRef.current = null;
    };
  }, [visible, tab, config.daemon.logFile]);

  // Autoscroll follows new lines when enabled
  useEffect(() => {
    if (tab !== "logs" || !logAutoscroll) return;
    setLogScroll(Math.max(0, filteredLogs.length - bodyRows));
  }, [filteredLogs.length, tab, logAutoscroll, bodyRows]);

  // Bracketed-paste → active input
  useEffect(() => {
    if (!visible) return;
    const handler = (event: PasteEvent) => {
      const chunk = decodePasteBytes(event.bytes).replace(/\r/g, "").replace(/\n/g, " ").trim();
      if (!chunk) return;
      if (logFilterFocused && tab === "logs" && mode.k === "list") {
        setLogFilter((v) => v + chunk);
        return;
      }
      setMode((m) => appendToMode(m, chunk));
    };
    renderer.keyInput.on("paste", handler);
    return () => {
      renderer.keyInput.off("paste", handler);
    };
  }, [visible, renderer, tab, mode.k, logFilterFocused]);

  const startDaemon = useCallback(async () => {
    try {
      const launcher = resolveLauncher();
      if (!launcher) {
        flashMsg(
          "err",
          "could not locate a soulforge launcher — set SOULFORGE_HEARTH_LAUNCHER or run `soulforge hearth start` manually",
        );
        return;
      }
      const bootLog = join(tmpdir(), `soulforge-hearth-boot-${String(Date.now())}.log`);
      appendFileSync(
        bootLog,
        `# ${new Date().toISOString()} starting via ${launcher.kind}\n` +
          `# cmd: ${launcher.cmd} ${launcher.args.join(" ")}\n\n`,
        { mode: 0o600 },
      );
      // Windows: spawn directly with detached + windowsHide; the OS handles
      // process detachment, no shell wrapper. POSIX: use `nohup … &` so the
      // daemon survives parent exit and doesn't claim the controlling TTY.
      const env = {
        ...process.env,
        SOULFORGE_HEARTH_BOOT_LOG: bootLog,
        TERM: "dumb",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        SOULFORGE_NO_TTY: "1",
      };
      const proc = IS_WIN
        ? spawn(launcher.cmd, [...launcher.args, "hearth", "start"], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env,
          })
        : spawn(
            "/bin/sh",
            [
              "-c",
              `nohup ${[launcher.cmd, ...launcher.args].map(shellEscape).join(" ")} hearth start >>${shellEscape(bootLog)} 2>&1 &`,
            ],
            { detached: true, stdio: "ignore", env },
          );
      proc.unref();
      daemonProcRef.current = proc;
      bootLogRef.current = bootLog;
      flashMsg("ok", `daemon starting… (${launcher.kind})`);
      setTimeout(() => {
        void refreshStatus();
      }, 1500);
      // Escalate to a hard failure message if the socket still isn't up after 6s
      setTimeout(() => {
        void refreshStatus().then(() => {
          if (mountedRef.current && !statusRef.current.running) {
            const tail = readTailSafe(bootLog, 40);
            flashMsg(
              "err",
              tail ? `daemon failed to come up — ${tail}` : "daemon failed to start (see boot log)",
            );
          }
        });
      }, 6000);
    } catch (err) {
      flashMsg("err", err instanceof Error ? err.message : String(err));
    }
  }, [flashMsg, refreshStatus]);

  const stopDaemon = useCallback(async () => {
    try {
      // If the TUI owns surfaces in-process, stop its host — not the daemon.
      // Pressing [s] while TUI-owned previously fell through to pkill because
      // there's no daemon pidfile, which could kill unrelated processes.
      if (statusRef.current.surfaceOwner === "tui") {
        const { getTuiHost } = await import("../../hearth/tui-host.js");
        const tui = getTuiHost();
        if (tui.isActive()) {
          await tui.stop();
          flashMsg("ok", "TUI surfaces stopped");
          setTimeout(() => void refreshStatus(), 500);
          return;
        }
      }

      // Read the pidfile the daemon writes on start — direct kill, no pattern matching.
      const pidPath = join(configDir(), "hearth.pid");
      let pid: number | null = null;
      if (existsSync(pidPath)) {
        const raw = readFileSync(pidPath, "utf-8").trim();
        const n = Number.parseInt(raw, 10);
        if (!Number.isNaN(n) && n > 0) pid = n;
      }

      if (pid !== null) {
        try {
          process.kill(pid, "SIGTERM");
          flashMsg("ok", `SIGTERM → pid ${String(pid)}`);
        } catch (err) {
          // ESRCH = process already gone — treat as success
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ESRCH") {
            flashMsg("ok", "daemon already stopped");
          } else {
            flashMsg("err", `kill failed: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
        }
      } else {
        // No pidfile, no TUI host — nothing to stop. pkill fallback removed
        // because it could target unrelated `hearth start` processes and
        // would never be the right tool for a TUI-owned host anyway.
        flashMsg("ok", "nothing to stop (no daemon pid, TUI surfaces not active)");
      }

      setTimeout(() => void refreshStatus(), 1000);
    } catch (err) {
      flashMsg("err", err instanceof Error ? err.message : String(err));
    }
  }, [flashMsg, refreshStatus]);

  const persist = useCallback(
    (next: HearthConfig) => {
      try {
        writeGlobalHearthConfig(next);
        setConfig(next);
        flashMsg("ok", "config saved");
      } catch (err) {
        flashMsg("err", err instanceof Error ? err.message : String(err));
        logBackgroundError("hearth-settings", err instanceof Error ? err.message : String(err));
        return;
      }
      // Tell a live daemon to diff its registry against the new config — start
      // newly-enabled surfaces, stop removed ones — without restarting.
      // No-ops silently when the daemon isn't running.
      if (!existsSync(next.daemon.socketPath)) return;
      void socketRequest<ReloadRequest, ReloadResponse>(
        { op: "reload", v: HEARTH_PROTOCOL_VERSION },
        { path: next.daemon.socketPath, timeoutMs: 8000 },
      )
        .then((res) => {
          const parts: string[] = [];
          if (res.started.length > 0) parts.push(`+${res.started.join(", ")}`);
          if (res.stopped.length > 0) parts.push(`-${res.stopped.join(", ")}`);
          if (res.errors.length > 0)
            parts.push(`errors: ${res.errors.map((e) => `${e.id} (${e.error})`).join(", ")}`);
          if (parts.length > 0)
            flashMsg(res.ok ? "ok" : "err", `daemon reloaded · ${parts.join(" · ")}`);
          void refreshStatus();
        })
        .catch((err) => {
          flashMsg("err", `reload failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    },
    [flashMsg, refreshStatus],
  );

  const refreshService = useCallback(async () => {
    try {
      const s = await getServiceStatus();
      setService(s);
    } catch {
      // ignore — status is best-effort
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void refreshService();
  }, [visible, refreshService]);

  const installPersistent = useCallback(async () => {
    try {
      const launcher = resolveLauncher();
      if (!launcher) {
        flashMsg(
          "err",
          "could not locate a soulforge launcher — set SOULFORGE_HEARTH_LAUNCHER or run manually",
        );
        return;
      }
      const s = await installService({
        cmd: launcher.cmd,
        args: [...launcher.args, "hearth", "start"],
      });
      if (s.error) {
        flashMsg("err", `install failed: ${s.error}`);
      } else if (s.platform === "unsupported") {
        flashMsg("err", "persistent service not supported on this platform");
      } else {
        flashMsg("ok", `installed · ${s.unitLabel} (${s.platform})`);
      }
      setService(s);
      setTimeout(() => void refreshStatus(), 1500);
    } catch (err) {
      flashMsg("err", err instanceof Error ? err.message : String(err));
    }
  }, [flashMsg, refreshStatus]);

  const uninstallPersistent = useCallback(async () => {
    try {
      const s = await uninstallService();
      if (s.error) {
        flashMsg("err", `uninstall failed: ${s.error}`);
      } else {
        flashMsg("ok", "persistent service removed");
      }
      setService(s);
    } catch (err) {
      flashMsg("err", err instanceof Error ? err.message : String(err));
    }
  }, [flashMsg]);

  const surfaceEntries = useMemo(() => Object.entries(config.surfaces), [config.surfaces]);

  const toggleSurface = useCallback(
    (surfaceId: string) => {
      const current = config.surfaces[surfaceId as SurfaceId];
      if (!current) return;
      persist({
        ...config,
        surfaces: {
          ...config.surfaces,
          [surfaceId]: { ...current, enabled: !current.enabled },
        },
      });
    },
    [config, persist],
  );

  const removeSurface = useCallback(
    (surfaceId: string) => {
      const next = { ...config, surfaces: { ...config.surfaces } };
      delete (next.surfaces as Record<string, HearthSurfaceConfig>)[surfaceId];
      persist(next);
    },
    [config, persist],
  );

  const removeChat = useCallback(
    (surfaceId: string, chatId: string) => {
      const surface = config.surfaces[surfaceId as SurfaceId];
      if (!surface) return;
      const chats = { ...surface.chats };
      delete chats[chatId];
      persist({
        ...config,
        surfaces: {
          ...config.surfaces,
          [surfaceId]: { ...surface, chats },
        },
      });
    },
    [config, persist],
  );

  const addSurface = useCallback(
    (kind: string, id: string) => {
      const trimmedKind = kind.trim().toLowerCase();
      const trimmedId = id.trim();
      if (!trimmedKind || !trimmedId) {
        flashMsg("err", "kind and id required");
        return;
      }
      const sid = surfaceIdFrom(trimmedKind, trimmedId);
      persist({
        ...config,
        surfaces: {
          ...config.surfaces,
          [sid]: { enabled: true, chats: {}, allowed: {} },
        },
      });
    },
    [config, flashMsg, persist],
  );

  const addChat = useCallback(
    (surfaceId: SurfaceId, chatId: string, cwd: string) => {
      const trimmedChat = chatId.trim();
      const trimmedCwd = cwd.trim();
      if (!trimmedChat || !trimmedCwd) {
        flashMsg("err", "chatId and cwd required");
        return;
      }
      const surface = config.surfaces[surfaceId];
      if (!surface) return;
      persist({
        ...config,
        surfaces: {
          ...config.surfaces,
          [surfaceId]: {
            ...surface,
            chats: {
              ...surface.chats,
              [trimmedChat]: {
                surfaceId,
                externalId: trimmedChat,
                cwd: trimmedCwd,
                caps: config.defaults.caps,
                maxTabs: config.defaults.maxTabs,
              },
            },
          },
        },
      });
    },
    [config, flashMsg, persist],
  );

  const setToken = useCallback(
    (surfaceId: string, value: string) => {
      const key = tokenSecretKey(surfaceId);
      const trimmed = value.trim();
      if (!key || !trimmed) {
        flashMsg("err", "token empty");
        return;
      }
      const res = setSecret(key, trimmed);
      flashMsg(
        res.success ? "ok" : "err",
        res.success ? `stored ${key} (${res.storage})` : "failed to store token",
      );
    },
    [flashMsg],
  );

  const addAllowedUser = useCallback(
    (surfaceId: SurfaceId, chatId: string, userId: string) => {
      const trimmedChat = chatId.trim();
      const trimmedUser = userId.trim();
      if (!trimmedChat || !trimmedUser) {
        flashMsg("err", "chatId and userId required");
        return;
      }
      const surface = config.surfaces[surfaceId];
      if (!surface) return;
      const existing = surface.allowed?.[trimmedChat] ?? [];
      if (existing.includes(trimmedUser)) {
        flashMsg("err", `${trimmedUser} already allowed in ${trimmedChat}`);
        return;
      }
      persist({
        ...config,
        surfaces: {
          ...config.surfaces,
          [surfaceId]: {
            ...surface,
            allowed: {
              ...(surface.allowed ?? {}),
              [trimmedChat]: [...existing, trimmedUser],
            },
          },
        },
      });
    },
    [config, flashMsg, persist],
  );

  /**
   * Single-shot quickstart save. Stores the token in the keychain, enables the
   * surface, and writes `allowed` + `chats` in one atomic config persist.
   * Handles both provider shapes (telegram / discord).
   */
  const saveQuickstart = useCallback(
    (
      args:
        | {
            kind: "telegram";
            botId: string;
            token: string;
            userId: string;
            cwd: string;
          }
        | {
            kind: "discord";
            appId: string;
            token: string;
            channelId: string;
            userId: string;
            cwd: string;
          },
    ): boolean => {
      const cwd = args.cwd.trim();
      if (!cwd) {
        flashMsg("err", "cwd required");
        return false;
      }

      let sid: SurfaceId;
      let allowed: Record<string, string[]>;
      let chats: Record<string, Partial<import("../../hearth/types.js").ChatBinding>>;
      let tokenKey: string | null = null;
      let tokenValue: string | null = null;

      if (args.kind === "telegram") {
        const botId = args.botId.trim();
        const userId = args.userId.trim();
        const token = args.token.trim();
        if (!botId || !userId || !token) {
          flashMsg("err", "bot id, user id and token all required");
          return false;
        }
        sid = surfaceIdFrom("telegram", botId);
        // For a 1:1 DM, chat.id === user.id in Telegram. No pairing needed.
        allowed = { [userId]: [userId] };
        chats = {
          [userId]: {
            surfaceId: sid,
            externalId: userId,
            cwd,
            caps: config.defaults.caps,
            maxTabs: config.defaults.maxTabs,
          },
        };
        tokenKey = `telegram.bot.${botId}`;
        tokenValue = token;
      } else {
        const appId = args.appId.trim();
        const channelId = args.channelId.trim();
        const userId = args.userId.trim();
        const token = args.token.trim();
        if (!appId || !channelId || !userId || !token) {
          flashMsg("err", "app id, channel id, user id and token all required");
          return false;
        }
        // Discord snowflakes are 17–20 decimal digits. Reject non-digits and
        // the classic footgun of pasting the channel id into the user field.
        if (!/^\d{17,20}$/.test(appId)) {
          flashMsg("err", "application id must be 17–20 digits (Developer Portal → General)");
          return false;
        }
        if (!/^\d{17,20}$/.test(channelId)) {
          flashMsg("err", "channel id must be 17–20 digits (right-click channel → Copy ID)");
          return false;
        }
        if (!/^\d{17,20}$/.test(userId)) {
          flashMsg("err", "user id must be 17–20 digits (right-click your name → Copy User ID)");
          return false;
        }
        if (channelId === userId) {
          flashMsg(
            "err",
            "channel id and user id are identical — you pasted the channel into the user field. Right-click YOUR name, not the channel.",
          );
          return false;
        }
        if (appId === userId || appId === channelId) {
          flashMsg("err", "application id collides with channel or user id — re-copy each");
          return false;
        }
        sid = surfaceIdFrom("discord", appId);
        allowed = { [channelId]: [userId] };
        chats = {
          [channelId]: {
            surfaceId: sid,
            externalId: channelId,
            cwd,
            caps: config.defaults.caps,
            maxTabs: config.defaults.maxTabs,
          },
        };
        tokenKey = `discord.bot.${appId}`;
        tokenValue = token;
      }

      if (tokenKey && tokenValue) {
        const res = setSecret(tokenKey, tokenValue);
        if (!res.success) {
          flashMsg("err", "failed to store token in keychain");
          return false;
        }
      }

      const existing = config.surfaces[sid];
      persist({
        ...config,
        surfaces: {
          ...config.surfaces,
          [sid]: {
            enabled: true,
            chats: { ...(existing?.chats ?? {}), ...chats },
            allowed: { ...(existing?.allowed ?? {}), ...allowed },
          },
        },
      });
      flashMsg("ok", `${sid} saved · start the daemon to connect`);
      return true;
    },
    [config, flashMsg, persist],
  );

  // Selected surface + pairings flattened
  const surfacesList = surfaceEntries;
  const selectedSurface =
    tab === "surfaces" && surfacesList.length > 0
      ? surfacesList[Math.min(cursor, surfacesList.length - 1)]
      : null;

  const pairingsList = useMemo(() => {
    const out: Array<{ sid: string; chatId: string; cwd: string; caps: string }> = [];
    for (const [sid, cfg] of surfaceEntries) {
      for (const [chatId, chat] of Object.entries(cfg.chats ?? {})) {
        out.push({
          sid,
          chatId,
          cwd: (chat.cwd as string | undefined) ?? "—",
          caps: (chat.caps as string | undefined) ?? "—",
        });
      }
    }
    return out;
  }, [surfaceEntries]);

  useKeyboard((evt) => {
    if (!visible) return;

    // ── Input modes ──
    if (mode.k === "addSurface") {
      if (evt.name === "escape") return void setMode({ k: "list" });
      if (evt.name === "return") {
        addSurface(mode.kind, mode.id);
        setMode({ k: "list" });
        return;
      }
      if (evt.name === "tab") {
        setMode({ ...mode, field: mode.field === "kind" ? "id" : "kind" });
        return;
      }
      if (evt.name === "backspace") {
        if (mode.field === "kind") setMode({ ...mode, kind: mode.kind.slice(0, -1) });
        else setMode({ ...mode, id: mode.id.slice(0, -1) });
        return;
      }
      if (evt.sequence && evt.sequence.length === 1 && !evt.ctrl && !evt.meta) {
        if (mode.field === "kind") setMode({ ...mode, kind: mode.kind + evt.sequence });
        else setMode({ ...mode, id: mode.id + evt.sequence });
      }
      return;
    }
    if (mode.k === "addChat") {
      if (evt.name === "escape") return void setMode({ k: "list" });
      if (evt.name === "return") {
        addChat(mode.surfaceId, mode.chatId, mode.cwd);
        setMode({ k: "list" });
        return;
      }
      if (evt.name === "tab") {
        setMode({ ...mode, field: mode.field === "chatId" ? "cwd" : "chatId" });
        return;
      }
      if (evt.name === "backspace") {
        if (mode.field === "chatId") setMode({ ...mode, chatId: mode.chatId.slice(0, -1) });
        else setMode({ ...mode, cwd: mode.cwd.slice(0, -1) });
        return;
      }
      if (evt.sequence && evt.sequence.length === 1 && !evt.ctrl && !evt.meta) {
        if (mode.field === "chatId") setMode({ ...mode, chatId: mode.chatId + evt.sequence });
        else setMode({ ...mode, cwd: mode.cwd + evt.sequence });
      }
      return;
    }
    if (mode.k === "token") {
      if (evt.name === "escape") return void setMode({ k: "list" });
      if (evt.name === "return") {
        setToken(mode.surfaceId, mode.value);
        setMode({ k: "list" });
        return;
      }
      if (evt.name === "backspace") {
        setMode({ ...mode, value: mode.value.slice(0, -1) });
        return;
      }
      if (evt.sequence && evt.sequence.length === 1 && !evt.ctrl && !evt.meta) {
        setMode({ ...mode, value: mode.value + evt.sequence });
      }
      return;
    }
    if (mode.k === "pairCode") {
      if (evt.name === "escape" || evt.name === "return") setMode({ k: "list" });
      return;
    }
    if (mode.k === "addAllowed") {
      if (evt.name === "escape") return void setMode({ k: "list" });
      if (evt.name === "return") {
        addAllowedUser(mode.surfaceId, mode.chatId, mode.userId);
        setMode({ k: "list" });
        return;
      }
      if (evt.name === "tab") {
        setMode({ ...mode, field: mode.field === "chatId" ? "userId" : "chatId" });
        return;
      }
      if (evt.name === "backspace") {
        if (mode.field === "chatId") setMode({ ...mode, chatId: mode.chatId.slice(0, -1) });
        else setMode({ ...mode, userId: mode.userId.slice(0, -1) });
        return;
      }
      if (evt.sequence && evt.sequence.length === 1 && !evt.ctrl && !evt.meta) {
        if (mode.field === "chatId") setMode({ ...mode, chatId: mode.chatId + evt.sequence });
        else setMode({ ...mode, userId: mode.userId + evt.sequence });
      }
      return;
    }

    // ── Provider picker ──
    if (mode.k === "pickProvider") {
      if (evt.name === "escape") return void setMode({ k: "list" });
      if (evt.name === "up" || evt.name === "k") {
        setMode({ ...mode, cursor: (mode.cursor - 1 + PROVIDERS.length) % PROVIDERS.length });
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        setMode({ ...mode, cursor: (mode.cursor + 1) % PROVIDERS.length });
        return;
      }
      if (evt.name === "return" || evt.name === " ") {
        const pick = PROVIDERS[mode.cursor];
        if (!pick) return;
        if (pick.macOnly && process.platform !== "darwin") {
          flashMsg("err", `${pick.label} is macOS-only`);
          return;
        }
        if (pick.kind === "telegram") {
          setMode({
            k: "quickTelegram",
            field: "token",
            token: "",
            userId: "",
            cwd: process.cwd(),
            bot: null,
            validating: false,
            error: null,
          });
        } else {
          setMode({
            k: "quickDiscord",
            field: "appId",
            appId: "",
            token: "",
            channelId: "",
            userId: "",
            cwd: process.cwd(),
            error: null,
          });
        }
      }
      return;
    }

    // ── Telegram quickstart ──
    if (mode.k === "quickTelegram") {
      if (evt.name === "escape") return void setMode({ k: "pickProvider", cursor: 0 });
      if (evt.name === "tab") {
        setMode({ ...mode, field: cycleField(mode.field, TG_FIELD_ORDER) });
        return;
      }
      if (evt.name === "return") {
        // Enter on the token field validates + auto-fills bot id. On any other
        // field, enter triggers save if all three inputs are filled.
        if (mode.field === "token" && !mode.bot) {
          setMode({ ...mode, validating: true, error: null });
          void getMe(mode.token).then((res) => {
            if (res.ok) {
              setMode((m) =>
                m.k === "quickTelegram"
                  ? { ...m, validating: false, bot: res.info, error: null, field: "userId" }
                  : m,
              );
              flashMsg("ok", `token valid · @${res.info.username ?? String(res.info.id)}`);
            } else {
              setMode((m) =>
                m.k === "quickTelegram" ? { ...m, validating: false, error: res.error } : m,
              );
              flashMsg("err", res.error);
            }
          });
          return;
        }
        if (mode.bot && mode.userId.trim() && mode.cwd.trim()) {
          const ok = saveQuickstart({
            kind: "telegram",
            botId: String(mode.bot.id),
            token: mode.token,
            userId: mode.userId,
            cwd: mode.cwd,
          });
          if (ok) setMode({ k: "list" });
        } else {
          flashMsg("err", "validate token first, then fill user id + cwd");
        }
        return;
      }
      if (evt.name === "backspace") {
        if (mode.field === "token") setMode({ ...mode, token: mode.token.slice(0, -1), bot: null });
        else if (mode.field === "userId") setMode({ ...mode, userId: mode.userId.slice(0, -1) });
        else setMode({ ...mode, cwd: mode.cwd.slice(0, -1) });
        return;
      }
      if (evt.sequence && evt.sequence.length === 1 && !evt.ctrl && !evt.meta) {
        if (mode.field === "token")
          setMode({ ...mode, token: mode.token + evt.sequence, bot: null });
        else if (mode.field === "userId") setMode({ ...mode, userId: mode.userId + evt.sequence });
        else setMode({ ...mode, cwd: mode.cwd + evt.sequence });
      }
      return;
    }

    // ── Discord quickstart ──
    if (mode.k === "quickDiscord") {
      if (evt.name === "escape") return void setMode({ k: "pickProvider", cursor: 1 });
      if (evt.name === "tab") {
        setMode({ ...mode, field: cycleField(mode.field, DISCORD_FIELD_ORDER) });
        return;
      }
      if (evt.name === "return") {
        const ok = saveQuickstart({
          kind: "discord",
          appId: mode.appId,
          token: mode.token,
          channelId: mode.channelId,
          userId: mode.userId,
          cwd: mode.cwd,
        });
        if (ok) setMode({ k: "list" });
        return;
      }
      if (evt.name === "backspace") {
        const slice = (s: string) => s.slice(0, -1);
        if (mode.field === "appId") setMode({ ...mode, appId: slice(mode.appId) });
        else if (mode.field === "token") setMode({ ...mode, token: slice(mode.token) });
        else if (mode.field === "channelId") setMode({ ...mode, channelId: slice(mode.channelId) });
        else if (mode.field === "userId") setMode({ ...mode, userId: slice(mode.userId) });
        else setMode({ ...mode, cwd: slice(mode.cwd) });
        return;
      }
      if (evt.sequence && evt.sequence.length === 1 && !evt.ctrl && !evt.meta) {
        const add = (s: string) => s + evt.sequence;
        if (mode.field === "appId") setMode({ ...mode, appId: add(mode.appId) });
        else if (mode.field === "token") setMode({ ...mode, token: add(mode.token) });
        else if (mode.field === "channelId") setMode({ ...mode, channelId: add(mode.channelId) });
        else if (mode.field === "userId") setMode({ ...mode, userId: add(mode.userId) });
        else setMode({ ...mode, cwd: add(mode.cwd) });
      }
      return;
    }

    // ── Browse mode ──
    if (evt.name === "escape") {
      if (logFilterFocused) {
        setLogFilterFocused(false);
        return;
      }
      onClose();
      return;
    }

    // Tab nav — sidebar arrow keys
    if (evt.name === "tab" || evt.sequence === "\t") {
      const idx = TABS.indexOf(tab);
      setTab(TABS[(idx + 1) % TABS.length] ?? "surfaces");
      setCursor(0);
      return;
    }

    // Log filter typing when focused
    if (tab === "logs" && logFilterFocused) {
      if (evt.name === "return") {
        setLogFilterFocused(false);
        return;
      }
      if (evt.name === "backspace") {
        setLogFilter((v) => v.slice(0, -1));
        return;
      }
      if (evt.sequence && evt.sequence.length === 1 && !evt.ctrl && !evt.meta) {
        setLogFilter((v) => v + evt.sequence);
      }
      return;
    }

    // Per-tab keys
    if (tab === "logs") {
      if (evt.name === "up" || evt.name === "k") {
        setLogAutoscroll(false);
        setLogScroll((v) => Math.max(0, v - 1));
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        setLogScroll((v) => Math.min(Math.max(0, filteredLogs.length - bodyRows), v + 1));
        return;
      }
      if (evt.name === "home") {
        setLogAutoscroll(false);
        setLogScroll(0);
        return;
      }
      if (evt.name === "end") {
        setLogAutoscroll(true);
        setLogScroll(Math.max(0, filteredLogs.length - bodyRows));
        return;
      }
      if (evt.name === "a") {
        setLogAutoscroll((v) => !v);
        return;
      }
      if (evt.name === "/") {
        setLogFilterFocused(true);
        return;
      }
      if (evt.name === "c") {
        setLogFilter("");
        return;
      }
      return;
    }

    if (tab === "daemon") {
      if (evt.name === "s") {
        if (status.running) void stopDaemon();
        else void startDaemon();
        return;
      }
      if (evt.name === "r") {
        void refreshStatus();
        void refreshService();
        return;
      }
      if (evt.name === "b") {
        if (service?.installed) void uninstallPersistent();
        else void installPersistent();
        return;
      }
      return;
    }

    if (tab === "surfaces") {
      if (evt.name === "a") {
        setMode({ k: "pickProvider", cursor: 0 });
        return;
      }
      if (evt.name === "A") {
        // Advanced: raw kind/id entry for custom surfaces (fakechat etc).
        setMode({ k: "addSurface", field: "kind", kind: "telegram", id: "" });
        return;
      }
      if (surfacesList.length === 0) return;
      if (evt.name === "up" || evt.name === "k") {
        setCursor((c) => (c > 0 ? c - 1 : surfacesList.length - 1));
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        setCursor((c) => (c < surfacesList.length - 1 ? c + 1 : 0));
        return;
      }
      const sel = selectedSurface;
      if (!sel) return;
      const [sid] = sel;
      if (evt.name === "return" || evt.name === " ") {
        toggleSurface(sid);
        return;
      }
      if (evt.name === "d" || evt.name === "delete") {
        removeSurface(sid);
        return;
      }
      if (evt.name === "t") {
        setMode({ k: "token", surfaceId: sid as SurfaceId, value: "" });
        return;
      }
      if (evt.name === "c") {
        setMode({
          k: "addChat",
          surfaceId: sid as SurfaceId,
          field: "chatId",
          chatId: "",
          cwd: process.cwd(),
        });
        return;
      }
      if (evt.name === "p") {
        const surfaceId = sid as SurfaceId;
        void issuePairingCodeViaDaemon(config.daemon.socketPath, surfaceId).then((res) => {
          if (!res.code) {
            flashMsg("err", `Pair: ${res.error ?? "failed"}`);
            return;
          }
          setMode({ k: "pairCode", surfaceId, code: res.code });
        });
        return;
      }
      if (evt.name === "u") {
        setMode({
          k: "addAllowed",
          surfaceId: sid as SurfaceId,
          field: "chatId",
          chatId: "",
          userId: "",
        });
        return;
      }
      if (evt.name === "x") {
        // Remove last allowed entry from selected surface
        const surface = config.surfaces[sid as SurfaceId];
        if (!surface?.allowed) return;
        const entries = Object.entries(surface.allowed);
        if (entries.length === 0) return;
        const last = entries[entries.length - 1];
        if (!last) return;
        const [lastChatId, userIds] = last;
        if (userIds.length <= 1) {
          const allowed = { ...surface.allowed };
          delete allowed[lastChatId];
          persist({
            ...config,
            surfaces: { ...config.surfaces, [sid]: { ...surface, allowed } },
          });
        } else {
          persist({
            ...config,
            surfaces: {
              ...config.surfaces,
              [sid]: {
                ...surface,
                allowed: {
                  ...surface.allowed,
                  [lastChatId]: userIds.slice(0, -1),
                },
              },
            },
          });
        }
        return;
      }
      return;
    }

    if (tab === "pairings") {
      if (pairingsList.length === 0) return;
      if (evt.name === "up" || evt.name === "k") {
        setCursor((c) => (c > 0 ? c - 1 : pairingsList.length - 1));
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        setCursor((c) => (c < pairingsList.length - 1 ? c + 1 : 0));
        return;
      }
      const sel = pairingsList[Math.min(cursor, pairingsList.length - 1)];
      if (!sel) return;
      if (evt.name === "d" || evt.name === "delete" || evt.name === "backspace") {
        removeChat(sel.sid, sel.chatId);
        return;
      }
      if (evt.name === "p") {
        const surfaceId = sel.sid as SurfaceId;
        void issuePairingCodeViaDaemon(config.daemon.socketPath, surfaceId).then((res) => {
          if (!res.code) {
            flashMsg("err", `Pair: ${res.error ?? "failed"}`);
            return;
          }
          setMode({ k: "pairCode", surfaceId, code: res.code });
        });
      }
    }
  });

  if (!visible) return null;

  // ── Rendered content pane ──

  const sidebar = (
    <box
      flexDirection="column"
      width={SIDEBAR_W}
      flexShrink={0}
      backgroundColor={t.bgPopup}
      paddingY={1}
      paddingX={1}
    >
      <text bg={t.bgPopup} fg={t.brand} attributes={TextAttributes.BOLD}>
        {" ⌂ Hearth [experimental]"}
      </text>
      <VSpacer />
      {TABS.map((tk) => {
        const active = tk === tab;
        const bg = active ? t.bgPopupHighlight : t.bgPopup;
        return (
          <text
            key={tk}
            bg={bg}
            fg={active ? t.brand : t.textPrimary}
            attributes={active ? TextAttributes.BOLD : undefined}
          >
            {active ? " ▸ " : "   "}
            {icon(TAB_ICON[tk])} {TAB_LABEL[tk]}
          </text>
        );
      })}
      <VSpacer />
      <text bg={t.bgPopup} fg={status.running ? t.success : t.warning}>
        {" "}
        {status.running ? `● up ${formatUptime(status.uptimeMs)}` : "○ stopped"}
      </text>
    </box>
  );

  const content = (() => {
    if (mode.k === "pickProvider") return renderPickProvider(contentW, bodyRows, mode, t);
    if (mode.k === "quickTelegram") return renderQuickTelegram(contentW, bodyRows, mode, t);
    if (mode.k === "quickDiscord") return renderQuickDiscord(contentW, bodyRows, mode, t);
    if (mode.k === "addSurface") return renderAddSurface(contentW, bodyRows, mode, t);
    if (mode.k === "addChat") return renderAddChat(contentW, bodyRows, mode, t);
    if (mode.k === "token") return renderTokenInput(contentW, bodyRows, mode, t);
    if (mode.k === "pairCode") return renderPairCode(contentW, bodyRows, mode, t);
    if (mode.k === "addAllowed") return renderAddAllowed(contentW, bodyRows, mode, t);

    if (tab === "surfaces") {
      return renderSurfaces(
        contentW,
        bodyRows,
        t,
        surfaceEntries,
        Math.min(cursor, Math.max(0, surfaceEntries.length - 1)),
        status,
      );
    }
    if (tab === "daemon")
      return renderDaemon(
        contentW,
        bodyRows,
        t,
        config,
        status,
        filteredLogs,
        startupError,
        service,
      );
    if (tab === "pairings") {
      return renderPairings(
        contentW,
        bodyRows,
        t,
        pairingsList,
        Math.min(cursor, Math.max(0, pairingsList.length - 1)),
      );
    }
    return renderLogs(
      contentW,
      bodyRows,
      t,
      filteredLogs,
      logScroll,
      logAutoscroll,
      logFilter,
      logFilterFocused,
    );
  })();

  const footerHints = buildFooterHints(tab, mode, status, logAutoscroll);

  return (
    <Overlay>
      <box
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor={t.brandAlt}
        width={popupWidth}
        height={popupHeight}
        backgroundColor={t.bgPopup}
      >
        <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
          {sidebar}
          <VSep t={t} />
          <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
            {content}
          </box>
        </box>

        <box flexDirection="column" height={2} flexShrink={0} backgroundColor={t.bgPopup}>
          <HRow w={innerW}>
            <text bg={t.bgPopup} fg={t.textFaint}>
              {"─".repeat(innerW)}
            </text>
          </HRow>
          <FooterHints w={innerW} t={t} hints={footerHints} />
        </box>

        {flash ? (
          <box flexDirection="row" height={1} flexShrink={0} paddingX={CARD_PAD}>
            <text bg={t.bgPopup} fg={flash.kind === "ok" ? t.success : t.error}>
              {flash.kind === "ok" ? "✓ " : "✗ "}
              {flash.msg}
            </text>
          </box>
        ) : null}
      </box>
    </Overlay>
  );
}

// ── Footer hints ───────────────────────────────────────────────────────────

function buildFooterHints(
  tab: Tab,
  mode: Mode,
  status: DaemonStatus,
  autoscroll: boolean,
): { key: string; label: string }[] {
  if (mode.k === "pickProvider") {
    return [
      { key: "↑↓", label: "choose" },
      { key: "⏎", label: "continue" },
      { key: "esc", label: "cancel" },
    ];
  }
  if (mode.k === "quickTelegram") {
    return [
      { key: "⏎", label: mode.bot ? "save" : "validate token" },
      { key: "tab", label: "next field" },
      { key: "esc", label: "back" },
    ];
  }
  if (mode.k === "quickDiscord") {
    return [
      { key: "⏎", label: "save" },
      { key: "tab", label: "next field" },
      { key: "esc", label: "back" },
    ];
  }
  if (
    mode.k === "addSurface" ||
    mode.k === "addChat" ||
    mode.k === "token" ||
    mode.k === "addAllowed"
  ) {
    return [
      { key: "⏎", label: "save" },
      { key: "tab", label: "next field" },
      { key: "esc", label: "cancel" },
    ];
  }
  if (mode.k === "pairCode") {
    return [{ key: "esc", label: "close" }];
  }
  if (tab === "logs") {
    return [
      { key: "↑↓", label: "scroll" },
      { key: "/", label: "filter" },
      { key: "c", label: "clear" },
      { key: "a", label: autoscroll ? "autoscroll on" : "autoscroll off" },
      { key: "tab", label: "next tab" },
      { key: "esc", label: "close" },
    ];
  }
  if (tab === "daemon") {
    const stopLabel = status.surfaceOwner === "tui" ? "stop TUI host" : "stop daemon";
    const startLabel = "start daemon";
    return [
      { key: "s", label: status.running ? stopLabel : startLabel },
      { key: "b", label: "persist on boot" },
      { key: "r", label: "refresh" },
      { key: "tab", label: "next tab" },
      { key: "esc", label: "close" },
    ];
  }
  if (tab === "surfaces") {
    return [
      { key: "↑↓", label: "nav" },
      { key: "⏎", label: "enable/disable" },
      { key: "a", label: "add (guided)" },
      { key: "A", label: "advanced" },
      { key: "d", label: "delete" },
      { key: "t", label: "token" },
      { key: "c", label: "bind chat" },
      { key: "u", label: "allow user" },
      { key: "p", label: "pair" },
      { key: "esc", label: "close" },
    ];
  }
  return [
    { key: "↑↓", label: "nav" },
    { key: "d", label: "unpair" },
    { key: "p", label: "new code" },
    { key: "esc", label: "close" },
  ];
}

// ── Content renderers ──────────────────────────────────────────────────────

function truncateMid(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max < 5) return s.slice(0, max);
  const keep = Math.floor((max - 1) / 2);
  return `${s.slice(0, keep)}…${s.slice(s.length - (max - keep - 1))}`;
}

function renderSurfaces(
  w: number,
  rows: number,
  t: Theme,
  entries: [string, HearthSurfaceConfig][],
  cursor: number,
  status: DaemonStatus,
) {
  const listW = Math.max(30, Math.floor(w * 0.42));
  const detailW = Math.max(40, w - listW - 1);
  const selected = entries[cursor];

  return (
    <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
      {/* Master list */}
      <box
        flexDirection="column"
        width={listW}
        flexShrink={0}
        paddingX={1}
        paddingY={1}
        backgroundColor={t.bgPopup}
      >
        <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
          Surfaces
        </text>
        <text bg={t.bgPopup} fg={t.textFaint}>
          {entries.length === 0
            ? "press 'a' to add your first"
            : `${String(entries.length)} configured`}
        </text>
        <VSpacer />
        {entries.length === 0 ? (
          <text bg={t.bgPopup} fg={t.textDim}>
            (none)
          </text>
        ) : (
          entries.slice(0, rows - 4).map(([sid, cfg], i) => {
            const isSel = i === cursor;
            const bg = isSel ? t.bgPopupHighlight : t.bgPopup;
            const chatCount = Object.keys(cfg.chats ?? {}).length;
            return (
              <box key={sid} flexDirection="row" flexShrink={0} backgroundColor={bg} paddingX={1}>
                <text bg={bg} fg={isSel ? t.brand : t.textDim}>
                  {isSel ? "▸ " : "  "}
                </text>
                <StatusDot t={t} on={cfg.enabled} />
                <text
                  bg={bg}
                  fg={t.textPrimary}
                  attributes={isSel ? TextAttributes.BOLD : undefined}
                >
                  {" "}
                  {truncateMid(sid, listW - 10)}
                </text>
                <text bg={bg} fg={t.textMuted}>
                  {"  "}
                  {String(chatCount)}
                </text>
              </box>
            );
          })
        )}
      </box>

      <VSep t={t} />

      {/* Detail */}
      <box
        flexDirection="column"
        width={detailW}
        flexShrink={1}
        paddingX={2}
        paddingY={1}
        backgroundColor={t.bgPopup}
      >
        {selected ? (
          renderSurfaceDetail(detailW - 4, t, selected, status)
        ) : (
          <>
            <text bg={t.bgPopup} fg={t.textDim}>
              No surfaces yet.
            </text>
            <VSpacer />
            <text bg={t.bgPopup} fg={t.textMuted}>
              Press{" "}
              <span bg={t.bgPopup} fg={t.brandAlt}>
                a
              </span>{" "}
              to start a guided setup for Telegram or Discord.
            </text>
            <VSpacer />
            <text bg={t.bgPopup} fg={t.textFaint}>
              • Telegram — paste bot token, we derive the bot id for you.
            </text>
            <text bg={t.bgPopup} fg={t.textFaint}>
              • Discord — app id + bot token + channel id + your snowflake.
            </text>
            <VSpacer />
            <text bg={t.bgPopup} fg={t.textFaint}>
              (Shift+A opens the legacy raw-entry form for Fakechat/custom.)
            </text>
          </>
        )}
      </box>
    </box>
  );
}

function renderSurfaceDetail(
  w: number,
  t: Theme,
  entry: [string, HearthSurfaceConfig],
  status: DaemonStatus,
) {
  const [sid, cfg] = entry;
  const tokenKey = tokenSecretKey(sid);
  const hasToken = tokenKey ? hasSecret(tokenKey).set : false;
  const online = status.surfaces?.find((s) => s.id === sid)?.connected === true;
  const chatEntries = Object.entries(cfg.chats ?? {});

  return (
    <>
      <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
        {sid}
      </text>
      <text bg={t.bgPopup} fg={t.textFaint}>
        {TAB_BLURB.surfaces}
      </text>
      <VSpacer />
      <box flexDirection="column" flexShrink={0} backgroundColor={t.bgPopup}>
        <KV
          k="State"
          v={cfg.enabled ? "enabled" : "disabled"}
          t={t}
          valueColor={cfg.enabled ? t.success : t.textDim}
        />
        <KV
          k="Connection"
          v={online ? "connected" : status.running ? "offline" : "(daemon stopped)"}
          t={t}
          valueColor={online ? t.success : t.warning}
        />
        {tokenKey ? (
          <KV
            k="Token"
            v={hasToken ? `present · ${tokenKey}` : `missing · ${tokenKey}`}
            t={t}
            valueColor={hasToken ? t.success : t.warning}
          />
        ) : null}
        <KV k="Chats bound" v={String(chatEntries.length)} t={t} />
      </box>
      <VSpacer />
      <Divider w={w} t={t} label="Actions" />
      <VSpacer />
      <text bg={t.bgPopup} fg={t.textMuted}>
        <span bg={t.bgPopup} fg={t.brandAlt}>
          ⏎
        </span>{" "}
        toggle enabled{" "}
        <span bg={t.bgPopup} fg={t.brandAlt}>
          t
        </span>{" "}
        set token{" "}
        <span bg={t.bgPopup} fg={t.brandAlt}>
          c
        </span>{" "}
        bind chat{" "}
        <span bg={t.bgPopup} fg={t.brandAlt}>
          p
        </span>{" "}
        pair code{" "}
        <span bg={t.bgPopup} fg={t.brandAlt}>
          d
        </span>{" "}
        delete surface
      </text>
      <VSpacer />
      <Divider w={w} t={t} label={`Chats (${String(chatEntries.length)})`} />
      <VSpacer />
      {chatEntries.length === 0 ? (
        <text bg={t.bgPopup} fg={t.textDim}>
          No chats bound — press 'c' to add one.
        </text>
      ) : (
        chatEntries.map(([chatId, chat]) => (
          <box key={chatId} flexDirection="column" flexShrink={0} backgroundColor={t.bgPopup}>
            <text bg={t.bgPopup} fg={t.textPrimary}>
              <span bg={t.bgPopup} fg={t.info}>
                •
              </span>{" "}
              {chatId}
            </text>
            <text bg={t.bgPopup} fg={t.textFaint}>
              {"    cwd: "}
              {truncateMid(String(chat.cwd ?? "—"), w - 10)}
            </text>
            <text bg={t.bgPopup} fg={t.textFaint}>
              {"    caps: "}
              {String(chat.caps ?? "—")} {" · maxTabs: "}
              {String(chat.maxTabs ?? "—")}
            </text>
          </box>
        ))
      )}
      <VSpacer />
      <Divider w={w} t={t} label="Allowed users" />
      <VSpacer />
      {renderAllowedList(w, t, cfg)}
    </>
  );
}

function renderAllowedList(_w: number, t: Theme, cfg: HearthSurfaceConfig) {
  const allowed = cfg.allowed ?? {};
  const entries = Object.entries(allowed);
  if (entries.length === 0) {
    return (
      <>
        <text bg={t.bgPopup} fg={t.textDim}>
          No allowed users — press 'u' to add one.
        </text>
        <text bg={t.bgPopup} fg={t.textFaint}>
          Without an allowlist, all messages are silently dropped.
        </text>
      </>
    );
  }
  return (
    <>
      {entries.map(([chatId, userIds]) => (
        <box key={chatId} flexDirection="column" flexShrink={0} backgroundColor={t.bgPopup}>
          <text bg={t.bgPopup} fg={t.textPrimary}>
            <span bg={t.bgPopup} fg={t.info}>
              ▸
            </span>{" "}
            chat {chatId}
          </text>
          {(userIds as string[]).map((uid) => (
            <text key={uid} bg={t.bgPopup} fg={t.textMuted}>
              {"    "}
              {uid}
            </text>
          ))}
        </box>
      ))}
      <VSpacer />
      <text bg={t.bgPopup} fg={t.textFaint}>
        <span bg={t.bgPopup} fg={t.brandAlt}>
          u
        </span>{" "}
        add user{"  "}
        <span bg={t.bgPopup} fg={t.brandAlt}>
          x
        </span>{" "}
        remove last
      </text>
    </>
  );
}

function renderDaemon(
  w: number,
  rows: number,
  t: Theme,
  config: HearthConfig,
  status: DaemonStatus,
  logs: string[],
  startupError: string | null,
  service: ServiceStatus | null,
) {
  const cardRows = startupError ? 15 : 12;
  const previewRows = Math.max(3, rows - cardRows - 3);
  const preview = logs.slice(-previewRows);

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} paddingX={2} paddingY={1}>
      <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
        Daemon
      </text>
      <text bg={t.bgPopup} fg={t.textFaint}>
        {TAB_BLURB.daemon}
      </text>
      <VSpacer />
      {/* Status card */}
      <box
        flexDirection="column"
        flexShrink={0}
        borderStyle="rounded"
        border={true}
        borderColor={status.running ? t.success : t.warning}
        paddingX={2}
        paddingY={1}
        backgroundColor={t.bgPopup}
      >
        <box flexDirection="row" flexShrink={0} backgroundColor={t.bgPopup}>
          <text
            bg={t.bgPopup}
            fg={status.running ? t.success : t.warning}
            attributes={TextAttributes.BOLD}
          >
            {status.running ? "● RUNNING" : "○ STOPPED"}
          </text>
          <text bg={t.bgPopup} fg={t.textFaint}>
            {"   uptime "}
          </text>
          <text bg={t.bgPopup} fg={t.textPrimary}>
            {formatUptime(status.uptimeMs)}
          </text>
          <text bg={t.bgPopup} fg={t.textFaint}>
            {"   pending "}
          </text>
          <text bg={t.bgPopup} fg={status.pendingApprovals ? t.warning : t.textPrimary}>
            {String(status.pendingApprovals ?? 0)}
          </text>
          {status.running ? (
            <>
              <text bg={t.bgPopup} fg={t.textFaint}>
                {"   owner "}
              </text>
              <text
                bg={t.bgPopup}
                fg={
                  status.surfaceOwner === "tui"
                    ? t.info
                    : status.surfaceOwner === "daemon"
                      ? t.success
                      : t.warning
                }
              >
                {status.surfaceOwner === "tui"
                  ? `TUI ${status.surfaceOwnerPid ? String(status.surfaceOwnerPid) : ""}`.trim()
                  : status.surfaceOwner === "daemon"
                    ? "daemon"
                    : "handoff"}
              </text>
            </>
          ) : null}
        </box>
        <VSpacer />
        <KV k="Socket" v={truncateMid(config.daemon.socketPath, w - 28)} t={t} />
        <KV k="State file" v={truncateMid(config.daemon.stateFile, w - 28)} t={t} />
        <KV k="Log file" v={truncateMid(config.daemon.logFile, w - 28)} t={t} />
        <KV
          k="Approval timeout"
          v={`${String(Math.floor(config.daemon.approvalTimeoutMs / 1000))}s`}
          t={t}
        />
        <KV k="Pairing TTL" v={`${String(Math.floor(config.daemon.pairingTtlMs / 1000))}s`} t={t} />
        <KV k="Max chats" v={String(config.daemon.maxChats)} t={t} />
        <KV k="Max tabs/chat" v={String(config.daemon.maxTabsPerChat)} t={t} />
        {status.error ? (
          <>
            <VSpacer />
            <text bg={t.bgPopup} fg={t.error}>
              {"  error: "}
              {status.error}
            </text>
          </>
        ) : null}
        {startupError ? (
          <>
            <VSpacer />
            <text bg={t.bgPopup} fg={t.error} attributes={TextAttributes.BOLD}>
              {"  boot failure"}
            </text>
            <text bg={t.bgPopup} fg={t.error}>
              {"  "}
              {truncateMid(startupError, w - 4)}
            </text>
          </>
        ) : null}
      </box>
      <VSpacer />

      {status.running && status.stats ? (
        <>
          <Divider w={w - 4} t={t} label="Lifetime stats" />
          <VSpacer />
          <box flexDirection="row" flexShrink={0} backgroundColor={t.bgPopup}>
            <box flexDirection="column" width={Math.floor((w - 4) / 2)} flexShrink={0}>
              <KV k="Messages in" v={String(status.stats.messagesIn)} t={t} />
              <KV k="Events out" v={String(status.stats.eventsOut)} t={t} />
              <KV k="Turns completed" v={String(status.stats.turnsCompleted)} t={t} />
              <KV k="Tool calls" v={String(status.stats.toolCalls)} t={t} />
            </box>
            <box flexDirection="column" width={Math.floor((w - 4) / 2)} flexShrink={0}>
              <KV
                k="Approvals"
                v={`${String(status.stats.approvalsHandled)} (${String(status.stats.approvalsAllowed)}✓ · ${String(status.stats.approvalsDenied)}✗)`}
                t={t}
              />
              <KV k="Tabs opened" v={String(status.stats.tabsOpened)} t={t} />
              <KV k="Workspaces" v={String(status.stats.workspacesEver)} t={t} />
              <KV k="Pairings issued" v={String(status.stats.pairingsIssued)} t={t} />
            </box>
          </box>
          <VSpacer />
        </>
      ) : null}

      {/* Persistent-service row — survives TUI exit and reboot via launchd/systemd */}
      <box flexDirection="row" flexShrink={0} paddingX={1} backgroundColor={t.bgPopup}>
        <text bg={t.bgPopup} fg={t.textMuted}>
          {"Persistence   "}
          <span
            bg={t.bgPopup}
            fg={service?.installed ? t.success : t.textDim}
            attributes={TextAttributes.BOLD}
          >
            {service?.installed
              ? service.active
                ? "active on boot"
                : "installed (inactive)"
              : service?.platform === "unsupported"
                ? "not supported on this OS"
                : "not installed"}
          </span>
          {service?.installed && service.unitLabel ? (
            <>
              {" · "}
              <span bg={t.bgPopup} fg={t.textDim}>
                {service.unitLabel}
              </span>
            </>
          ) : null}
        </text>
      </box>
      <VSpacer />

      {/* Actions row */}
      <box flexDirection="row" flexShrink={0} paddingX={1} backgroundColor={t.bgPopup}>
        <text bg={t.bgPopup} fg={t.textMuted}>
          <span bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
            [s]
          </span>{" "}
          {status.running
            ? status.surfaceOwner === "tui"
              ? "stop TUI host"
              : "stop daemon"
            : "start daemon"}
        </text>
        <text bg={t.bgPopup} fg={t.textMuted}>
          {"     "}
          <span bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
            [b]
          </span>{" "}
          {service?.installed ? "uninstall persist" : "persist on boot"}
        </text>
        <text bg={t.bgPopup} fg={t.textMuted}>
          {"     "}
          <span bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
            [r]
          </span>{" "}
          refresh
        </text>
      </box>
      <VSpacer />
      <Divider w={w - 4} t={t} label="Recent log" />
      <VSpacer />
      {preview.length === 0 ? (
        <text bg={t.bgPopup} fg={t.textDim}>
          {"  (no log lines yet — start the daemon)"}
        </text>
      ) : (
        preview.map((line, i) => (
          <text key={`p-${String(i)}`} bg={t.bgPopup} fg={severityColor(line, t)}>
            {"  "}
            {truncateMid(line, w - 4)}
          </text>
        ))
      )}
    </box>
  );
}

function renderPairings(
  w: number,
  _rows: number,
  t: Theme,
  pairings: Array<{ sid: string; chatId: string; cwd: string; caps: string }>,
  cursor: number,
) {
  if (pairings.length === 0) {
    return (
      <box flexDirection="column" paddingX={2} paddingY={1}>
        <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
          Pairings
        </text>
        <VSpacer />
        <text bg={t.bgPopup} fg={t.textDim}>
          No paired chats yet. Open Surfaces, select a surface, then press 'c'.
        </text>
      </box>
    );
  }

  // Group by surface
  const groups = new Map<string, Array<{ chatId: string; cwd: string; caps: string }>>();
  for (const p of pairings) {
    const arr = groups.get(p.sid) ?? [];
    arr.push({ chatId: p.chatId, cwd: p.cwd, caps: p.caps });
    groups.set(p.sid, arr);
  }

  const listW = Math.max(34, Math.floor(w * 0.45));
  const detailW = Math.max(40, w - listW - 1);
  const selected = pairings[cursor];

  let flatIdx = 0;
  return (
    <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
      <box
        flexDirection="column"
        width={listW}
        flexShrink={0}
        paddingX={1}
        paddingY={1}
        backgroundColor={t.bgPopup}
      >
        <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
          Paired chats
        </text>
        <text bg={t.bgPopup} fg={t.textFaint}>
          {String(pairings.length)} total · {String(groups.size)} surface(s)
        </text>
        <VSpacer />
        {[...groups.entries()].map(([sid, chats]) => (
          <box key={sid} flexDirection="column" flexShrink={0} backgroundColor={t.bgPopup}>
            <text bg={t.bgPopup} fg={t.info} attributes={TextAttributes.BOLD}>
              {"  ▾ "}
              {sid}
            </text>
            {chats.map((c) => {
              const isSel = flatIdx === cursor;
              const bg = isSel ? t.bgPopupHighlight : t.bgPopup;
              const row = (
                <box
                  key={`${sid}#${c.chatId}`}
                  flexDirection="row"
                  flexShrink={0}
                  backgroundColor={bg}
                >
                  <text bg={bg} fg={isSel ? t.brand : t.textDim}>
                    {isSel ? "    ▸ " : "      "}
                  </text>
                  <text bg={bg} fg={t.textPrimary}>
                    {truncateMid(c.chatId, listW - 8)}
                  </text>
                </box>
              );
              flatIdx++;
              return row;
            })}
          </box>
        ))}
      </box>

      <VSep t={t} />

      <box
        flexDirection="column"
        width={detailW}
        flexShrink={1}
        paddingX={2}
        paddingY={1}
        backgroundColor={t.bgPopup}
      >
        {selected ? (
          <>
            <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
              {selected.sid}
            </text>
            <text bg={t.bgPopup} fg={t.info}>
              {"chat: "}
              {selected.chatId}
            </text>
            <VSpacer />
            <KV k="cwd" v={truncateMid(selected.cwd, detailW - 12)} t={t} />
            <KV k="caps" v={selected.caps} t={t} />
            <VSpacer />
            <Divider w={detailW - 4} t={t} label="Actions" />
            <VSpacer />
            <text bg={t.bgPopup} fg={t.textMuted}>
              <span bg={t.bgPopup} fg={t.brandAlt}>
                d
              </span>{" "}
              unpair this chat{" "}
              <span bg={t.bgPopup} fg={t.brandAlt}>
                p
              </span>{" "}
              new pairing code
            </text>
          </>
        ) : (
          <text bg={t.bgPopup} fg={t.textDim}>
            No selection.
          </text>
        )}
      </box>
    </box>
  );
}

function renderLogs(
  w: number,
  rows: number,
  t: Theme,
  lines: string[],
  scroll: number,
  autoscroll: boolean,
  filter: string,
  filterFocused: boolean,
) {
  const headerRows = 4;
  const tailRows = Math.max(4, rows - headerRows);
  const view = lines.slice(scroll, scroll + tailRows);

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} paddingX={2} paddingY={1}>
      <box flexDirection="row" flexShrink={0} backgroundColor={t.bgPopup}>
        <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
          Logs
        </text>
        <text bg={t.bgPopup} fg={t.textFaint}>
          {"   "}
          {String(lines.length)} lines · {autoscroll ? "autoscroll on" : "autoscroll off"}
        </text>
      </box>
      <VSpacer />
      {/* Filter bar */}
      <box flexDirection="row" flexShrink={0} backgroundColor={t.bgPopup}>
        <text bg={t.bgPopup} fg={t.textDim}>
          {"  filter  "}
        </text>
        <text
          bg={filterFocused ? t.bgPopupHighlight : t.bgPopup}
          fg={filterFocused ? t.brand : t.textPrimary}
        >
          {filter || "(press / to focus, paste supported)"}
          {filterFocused ? "▎" : ""}
        </text>
      </box>
      <VSpacer />
      <box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        backgroundColor={t.bgPopup}
      >
        {view.length === 0 ? (
          <text bg={t.bgPopup} fg={t.textDim}>
            {"  (no log lines match)"}
          </text>
        ) : (
          view.map((line, i) => (
            <text key={`l-${String(scroll + i)}`} bg={t.bgPopup} fg={severityColor(line, t)}>
              {"  "}
              {truncateMid(line, w - 4)}
            </text>
          ))
        )}
      </box>
      <box flexDirection="row" flexShrink={0} backgroundColor={t.bgPopup}>
        <text bg={t.bgPopup} fg={t.textFaint}>
          {"  "}
          {lines.length > 0
            ? `lines ${String(scroll + 1)}–${String(Math.min(scroll + view.length, lines.length))} / ${String(lines.length)}`
            : ""}
        </text>
      </box>
    </box>
  );
}

function renderAddSurface(
  _w: number,
  _rows: number,
  mode: { k: "addSurface"; field: "kind" | "id"; kind: string; id: string },
  t: Theme,
) {
  return (
    <box flexDirection="column" flexGrow={1} paddingX={3} paddingY={2}>
      <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
        Add surface
      </text>
      <text bg={t.bgPopup} fg={t.textFaint}>
        'kind:id' forms the stable surface identifier (e.g. telegram:1234567890)
      </text>
      <VSpacer rows={2} />
      <text bg={t.bgPopup} fg={t.textDim}>
        Kind
      </text>
      <text
        bg={mode.field === "kind" ? t.bgPopupHighlight : t.bgPopup}
        fg={mode.field === "kind" ? t.brand : t.textPrimary}
      >
        {"  "}
        {mode.kind || "(telegram / discord / fakechat)"}
        {mode.field === "kind" ? "▎" : ""}
      </text>
      <VSpacer />
      <text bg={t.bgPopup} fg={t.textDim}>
        Id
      </text>
      <text
        bg={mode.field === "id" ? t.bgPopupHighlight : t.bgPopup}
        fg={mode.field === "id" ? t.brand : t.textPrimary}
      >
        {"  "}
        {mode.id || "(bot id / app id / 'default')"}
        {mode.field === "id" ? "▎" : ""}
      </text>
      <VSpacer rows={2} />
      <text bg={t.bgPopup} fg={t.textFaint}>
        Preview: {mode.kind && mode.id ? `${mode.kind.toLowerCase()}:${mode.id}` : "—"}
      </text>
    </box>
  );
}

function renderAddChat(
  _w: number,
  _rows: number,
  mode: {
    k: "addChat";
    surfaceId: SurfaceId;
    field: "chatId" | "cwd";
    chatId: string;
    cwd: string;
  },
  t: Theme,
) {
  return (
    <box flexDirection="column" flexGrow={1} paddingX={3} paddingY={2}>
      <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
        Bind chat
      </text>
      <text bg={t.bgPopup} fg={t.textFaint}>
        surface: {mode.surfaceId}
      </text>
      <VSpacer rows={2} />
      <text bg={t.bgPopup} fg={t.textDim}>
        Chat id
      </text>
      <text
        bg={mode.field === "chatId" ? t.bgPopupHighlight : t.bgPopup}
        fg={mode.field === "chatId" ? t.brand : t.textPrimary}
      >
        {"  "}
        {mode.chatId || "(tg user/chat id · discord channel)"}
        {mode.field === "chatId" ? "▎" : ""}
      </text>
      <VSpacer />
      <text bg={t.bgPopup} fg={t.textDim}>
        cwd
      </text>
      <text
        bg={mode.field === "cwd" ? t.bgPopupHighlight : t.bgPopup}
        fg={mode.field === "cwd" ? t.brand : t.textPrimary}
      >
        {"  "}
        {mode.cwd || "(absolute path on your host)"}
        {mode.field === "cwd" ? "▎" : ""}
      </text>
    </box>
  );
}

function renderTokenInput(
  _w: number,
  _rows: number,
  mode: { k: "token"; surfaceId: SurfaceId; value: string },
  t: Theme,
) {
  const masked =
    mode.value.length > 0
      ? `${"*".repeat(Math.max(0, mode.value.length - 4))}${mode.value.slice(-4)}`
      : "";
  return (
    <box flexDirection="column" flexGrow={1} paddingX={3} paddingY={2}>
      <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
        Bot token
      </text>
      <text bg={t.bgPopup} fg={t.textFaint}>
        surface: {mode.surfaceId} · stored in OS keychain, never logged
      </text>
      <VSpacer rows={2} />
      <box flexDirection="row" flexShrink={0}>
        <text bg={t.bgPopupHighlight} fg={t.brandAlt}>
          {masked || "(paste your token — Cmd/Ctrl+V)"}
        </text>
        <text bg={t.bgPopupHighlight} fg={t.brand}>
          {"▎"}
        </text>
      </box>
      <VSpacer />
      <text bg={t.bgPopup} fg={t.warning}>
        keychain key: {tokenSecretKey(mode.surfaceId) ?? "—"}
      </text>
      <VSpacer />
      <text bg={t.bgPopup} fg={t.textMuted}>
        Paste is enabled — bracketed-paste reads multi-line tokens in one go.
      </text>
    </box>
  );
}

function renderPairCode(
  _w: number,
  _rows: number,
  mode: { k: "pairCode"; surfaceId: SurfaceId; code: string },
  t: Theme,
) {
  return (
    <box flexDirection="column" flexGrow={1} paddingX={3} paddingY={2}>
      <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
        Pairing code
      </text>
      <text bg={t.bgPopup} fg={t.textFaint}>
        surface: {mode.surfaceId}
      </text>
      <VSpacer rows={2} />
      <text bg={t.bgPopup} fg={t.brand} attributes={TextAttributes.BOLD}>
        {"    "}
        {mode.code}
      </text>
      <VSpacer rows={2} />
      <text bg={t.bgPopup} fg={t.textMuted}>
        From the chat: DM your bot and send{" "}
        <span bg={t.bgPopup} fg={t.brandAlt}>
          /pair {mode.code}
        </span>
      </text>
      <text bg={t.bgPopup} fg={t.textFaint}>
        Or from the host terminal:{" "}
        <span bg={t.bgPopup} fg={t.brandAlt}>
          soulforge hearth pair {mode.surfaceId} {mode.code}
        </span>
      </text>
    </box>
  );
}

function maskToken(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "*".repeat(value.length);
  return `${value.slice(0, 3)}${"*".repeat(Math.max(0, value.length - 7))}${value.slice(-4)}`;
}

function FieldRow({
  label,
  value,
  placeholder,
  focused,
  t,
  mask,
}: {
  label: string;
  value: string;
  placeholder: string;
  focused: boolean;
  t: Theme;
  mask?: boolean;
}) {
  const display = mask ? maskToken(value) : value;
  return (
    <>
      <text bg={t.bgPopup} fg={t.textDim}>
        {label}
      </text>
      <text bg={focused ? t.bgPopupHighlight : t.bgPopup} fg={focused ? t.brand : t.textPrimary}>
        {"  "}
        {display || placeholder}
        {focused ? "▎" : ""}
      </text>
      <VSpacer />
    </>
  );
}

function renderPickProvider(
  _w: number,
  _rows: number,
  mode: { k: "pickProvider"; cursor: number },
  t: Theme,
) {
  const isMac = process.platform === "darwin";
  return (
    <box flexDirection="column" flexGrow={1} paddingX={3} paddingY={2}>
      <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
        Add surface
      </text>
      <text bg={t.bgPopup} fg={t.textFaint}>
        Pick a platform. We'll guide you through the minimum fields needed.
      </text>
      <VSpacer rows={2} />
      {PROVIDERS.map((p, i) => {
        const active = i === mode.cursor;
        const disabled = p.macOnly && !isMac;
        const bg = active ? t.bgPopupHighlight : t.bgPopup;
        const fg = disabled ? t.textFaint : active ? t.brand : t.textPrimary;
        return (
          <box key={p.kind} flexDirection="column" flexShrink={0} backgroundColor={bg} paddingX={1}>
            <text bg={bg} fg={fg} attributes={active ? TextAttributes.BOLD : undefined}>
              {active ? "▸ " : "  "}
              {p.label}
              {disabled ? "  (not available on this host)" : ""}
            </text>
            <text bg={bg} fg={t.textMuted}>
              {"    "}
              {p.blurb}
            </text>
          </box>
        );
      })}
      <VSpacer rows={2} />
      <text bg={t.bgPopup} fg={t.textFaint}>
        ↑↓ choose · ⏎ continue · esc cancel
      </text>
    </box>
  );
}

function renderQuickTelegram(
  _w: number,
  _rows: number,
  mode: Extract<Mode, { k: "quickTelegram" }>,
  t: Theme,
) {
  const derivedId = mode.bot ? String(mode.bot.id) : "(validate token to derive)";
  const username = mode.bot?.username ? `@${mode.bot.username}` : "—";
  return (
    <box flexDirection="column" flexGrow={1} paddingX={3} paddingY={1}>
      <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
        Telegram setup
      </text>
      <text bg={t.bgPopup} fg={t.textFaint}>
        Paste token → ⏎ validates via getMe → bot id auto-fills. Then add your user id.
      </text>
      <VSpacer />
      <FieldRow
        label="Bot token"
        value={mode.token}
        placeholder="(paste from @BotFather — Ctrl/Cmd+V)"
        focused={mode.field === "token"}
        t={t}
        mask={true}
      />
      <FieldRow
        label="Your user id (numeric)"
        value={mode.userId}
        placeholder="(DM @userinfobot to get yours)"
        focused={mode.field === "userId"}
        t={t}
      />
      <FieldRow
        label="Working directory"
        value={mode.cwd}
        placeholder="(absolute path on this host)"
        focused={mode.field === "cwd"}
        t={t}
      />
      <Divider w={60} t={t} label="Derived" />
      <VSpacer />
      <KV k="Bot id" v={derivedId} t={t} valueColor={mode.bot ? t.success : t.textDim} />
      <KV k="Username" v={username} t={t} valueColor={mode.bot ? t.success : t.textDim} />
      <KV
        k="Surface id"
        v={mode.bot ? `telegram:${String(mode.bot.id)}` : "—"}
        t={t}
        valueColor={mode.bot ? t.info : t.textDim}
      />
      <VSpacer />
      {mode.validating ? (
        <text bg={t.bgPopup} fg={t.info}>
          validating token with Telegram…
        </text>
      ) : mode.error ? (
        <text bg={t.bgPopup} fg={t.error}>
          {mode.error}
        </text>
      ) : null}
    </box>
  );
}

function renderQuickDiscord(
  _w: number,
  _rows: number,
  mode: Extract<Mode, { k: "quickDiscord" }>,
  t: Theme,
) {
  const snowflakeOk = (v: string) => /^\d{17,20}$/.test(v);
  const sameChannelUser =
    mode.channelId.length > 0 && mode.userId.length > 0 && mode.channelId === mode.userId;
  const appIdOk = mode.appId.length === 0 || snowflakeOk(mode.appId);
  const channelOk = mode.channelId.length === 0 || snowflakeOk(mode.channelId);
  const userOk = mode.userId.length === 0 || snowflakeOk(mode.userId);
  const hint = (ok: boolean, warn: string) =>
    ok ? null : (
      <text bg={t.bgPopup} fg={t.warning}>
        {`   ⚠  ${warn}`}
      </text>
    );
  return (
    <box flexDirection="column" flexGrow={1} paddingX={3} paddingY={1}>
      <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
        Discord setup
      </text>
      <text bg={t.bgPopup} fg={t.textFaint}>
        DMs only. Toggle MESSAGE_CONTENT intent on in the Developer Portal (Bot tab).
      </text>
      <text bg={t.bgPopup} fg={t.textFaint}>
        Channel id ≠ user id — right-click the channel, then right-click YOUR name.
      </text>
      <VSpacer />
      <FieldRow
        label="Application id"
        value={mode.appId}
        placeholder="(Developer Portal → General → Application ID)"
        focused={mode.field === "appId"}
        t={t}
      />
      {hint(appIdOk, "application id must be 17–20 digits")}
      <FieldRow
        label="Bot token"
        value={mode.token}
        placeholder="(Developer Portal → Bot → Reset Token)"
        focused={mode.field === "token"}
        t={t}
        mask={true}
      />
      <FieldRow
        label="Channel id (DM or guild)"
        value={mode.channelId}
        placeholder="(right-click channel → Copy ID; Dev Mode must be on)"
        focused={mode.field === "channelId"}
        t={t}
      />
      {hint(channelOk, "channel id must be 17–20 digits")}
      <FieldRow
        label="Your user id (snowflake)"
        value={mode.userId}
        placeholder="(right-click YOUR name → Copy User ID)"
        focused={mode.field === "userId"}
        t={t}
      />
      {hint(userOk, "user id must be 17–20 digits")}
      {sameChannelUser ? (
        <text bg={t.bgPopup} fg={t.error} attributes={TextAttributes.BOLD}>
          {"   ✕  channel id = user id. Right-click YOUR name, not the channel."}
        </text>
      ) : null}
      <FieldRow
        label="Working directory"
        value={mode.cwd}
        placeholder="(absolute path on this host)"
        focused={mode.field === "cwd"}
        t={t}
      />
      <Divider w={60} t={t} label="Derived" />
      <VSpacer />
      <KV
        k="Surface id"
        v={mode.appId ? `discord:${mode.appId}` : "—"}
        t={t}
        valueColor={mode.appId ? t.info : t.textDim}
      />
      {mode.error ? (
        <>
          <VSpacer />
          <text bg={t.bgPopup} fg={t.error}>
            {mode.error}
          </text>
        </>
      ) : null}
    </box>
  );
}

function renderAddAllowed(
  _w: number,
  _rows: number,
  mode: {
    k: "addAllowed";
    surfaceId: SurfaceId;
    field: "chatId" | "userId";
    chatId: string;
    userId: string;
  },
  t: Theme,
) {
  return (
    <box flexDirection="column" flexGrow={1} paddingX={3} paddingY={2}>
      <text bg={t.bgPopup} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
        Allow user
      </text>
      <text bg={t.bgPopup} fg={t.textFaint}>
        surface: {mode.surfaceId}
      </text>
      <VSpacer rows={2} />
      <text bg={t.bgPopup} fg={t.textDim}>
        Chat id (numeric for TG, channel snowflake for Discord)
      </text>
      <text
        bg={mode.field === "chatId" ? t.bgPopupHighlight : t.bgPopup}
        fg={mode.field === "chatId" ? t.brand : t.textPrimary}
      >
        {"  "}
        {mode.chatId || "(paste or type the chat/channel id)"}
        {mode.field === "chatId" ? "▎" : ""}
      </text>
      <VSpacer />
      <text bg={t.bgPopup} fg={t.textDim}>
        User id (numeric TG user.id, Discord snowflake)
      </text>
      <text
        bg={mode.field === "userId" ? t.bgPopupHighlight : t.bgPopup}
        fg={mode.field === "userId" ? t.brand : t.textPrimary}
      >
        {"  "}
        {mode.userId || "(paste or type the user id)"}
        {mode.field === "userId" ? "▎" : ""}
      </text>
      <VSpacer rows={2} />
      <text bg={t.bgPopup} fg={t.textFaint}>
        For Telegram DMs, chat id and user id are the same number.
      </text>
      <text bg={t.bgPopup} fg={t.textFaint}>
        DM @userinfobot on Telegram to get your numeric id.
      </text>
    </box>
  );
}

/**
 * Locate a runnable `soulforge` binary. Priority:
 *   1. Explicit env override (SOULFORGE_HEARTH_LAUNCHER)
 *   2. Anything on PATH (brew / apt / npm link / user install) — macOS + Linux
 *   3. Sibling dist/bin.sh next to argv[1]
 * Returns an absolute path or null if nothing can be found.
 */
interface LauncherPlan {
  kind: "env" | "dev-bun" | "dev-bin" | "dist" | "path";
  cmd: string;
  args: string[];
}

/**
 * Decide how to spawn `soulforge hearth start`.
 *
 * Priority:
 *   1. SOULFORGE_HEARTH_LAUNCHER  (absolute path, trumps everything)
 *   2. Source checkout: find package.json with module === src/boot.tsx and
 *      spawn `bun src/boot.tsx hearth start`. Prevents accidentally invoking
 *      a stale system binary when you're clearly developing from source.
 *   3. Same checkout's dist/bin.sh if present
 *   4. PATH lookup — only when no local checkout found
 */
function resolveLauncher(): LauncherPlan | null {
  const envOverride = process.env.SOULFORGE_HEARTH_LAUNCHER;
  if (envOverride && existsSync(envOverride)) {
    return { kind: "env", cmd: envOverride, args: [] };
  }

  const checkout = findSourceCheckout(process.argv[1] ?? process.cwd());
  if (checkout) {
    const bootTsx = join(checkout, "src", "boot.tsx");
    const distEntry = join(checkout, "dist", "bin.sh");
    const bin = join(checkout, "bin", "soulforge");
    if (existsSync(bootTsx)) {
      const bunBin = process.execPath.includes("bun")
        ? process.execPath
        : (findBinaryOnPath("bun") ?? "bun");
      return { kind: "dev-bun", cmd: bunBin, args: [bootTsx] };
    }
    if (existsSync(distEntry)) {
      return { kind: "dist", cmd: distEntry, args: [] };
    }
    if (existsSync(bin) && isExecutable(bin)) {
      return { kind: "dev-bin", cmd: bin, args: [] };
    }
  }

  const which = findBinaryOnPath("soulforge");
  if (which) return { kind: "path", cmd: which, args: [] };
  return null;
}

function findSourceCheckout(startPath: string): string | null {
  let dir =
    startPath && existsSync(startPath) ? resolve(dirname(startPath)) : resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf-8")) as { name?: string; module?: string };
        if (parsed.name === "@proxysoul/soulforge" || parsed.module?.includes("boot.tsx")) {
          return dir;
        }
      } catch {}
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    // POSIX exec bits aren't reliable on Windows (libuv reports 0 here).
    // PATHEXT matching in findBinaryOnPath already gates by suffix.
    if (IS_WIN) return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function findBinaryOnPath(name: string): string | null {
  // First try the canonical shim helper (handles Windows PATHEXT + POSIX exec).
  const resolved = findOnPath(name);
  if (resolved && existsSync(resolved) && isExecutable(resolved)) return resolved;
  // Fallback PATH walk for paranoia — covers shims with non-default exts.
  const exts = IS_WIN
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate) && isExecutable(candidate)) return candidate;
    }
  }
  return null;
}
/** Read the last N lines of a file; returns a one-line summary or null. */
function readTailSafe(path: string, maxLines: number): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    const lines = raw.split("\n").filter(Boolean).slice(-maxLines);
    const joined = lines.join(" · ");
    return joined.length > 240 ? `…${joined.slice(-240)}` : joined;
  } catch {
    return null;
  }
}
/** POSIX shell single-quote escape — works on macOS sh and Linux dash/bash. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
/** Full-height vertical separator — renders as a coloured column that fills
 * 100% of the parent's height, regardless of child content. */
function VSep({ t }: { t: Theme }) {
  return <box width={1} flexShrink={0} backgroundColor={t.textFaint} alignSelf="stretch" />;
}
