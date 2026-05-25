/**
 * /hearth commands — surface the remote-control layer inside the TUI.
 *
 * Status popup shows: running daemon, configured surfaces, paired chats,
 * whether bot tokens are present in the keychain, and quick-action buttons
 * to spawn a pairing code or open `docs/hearth.md`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { hasSecret, setSecret } from "../../core/secrets.js";
import { loadHearthConfig } from "../../hearth/config.js";
import { socketRequest } from "../../hearth/protocol.js";
import {
  HEARTH_PROTOCOL_VERSION,
  type HealthResponse,
  type IssueCodeRequest,
  type IssueCodeResponse,
  type SurfaceId,
} from "../../hearth/types.js";
import { icon } from "../icons.js";
import { configDir } from "../platform/index.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

async function daemonHealth(socketPath: string): Promise<HealthResponse | null> {
  if (!existsSync(socketPath)) return null;
  try {
    const res = (await socketRequest(
      { op: "health", v: HEARTH_PROTOCOL_VERSION },
      { path: socketPath, timeoutMs: 1500 },
    )) as unknown as HealthResponse;
    if (res && res.ok === true) return res;
    return null;
  } catch {
    return null;
  }
}

async function handleHearthStatus(_input: string, ctx: CommandContext): Promise<void> {
  // Prefer the full-UI modal when available — fall back to the info popup for
  // headless/legacy hosts that don't expose a HearthSettings wiring.
  if (typeof ctx.openHearthSettings === "function") {
    ctx.openHearthSettings();
    return;
  }
  const theme = getThemeTokens();
  const config = loadHearthConfig(ctx.cwd);
  const health = await daemonHealth(config.daemon.socketPath);
  let owner: "daemon" | "tui" | "none" = health ? "daemon" : "none";
  let ownerPid: number | undefined;
  let uptimeMs = health?.uptime ?? 0;
  // TUI in-process host counts as "hearth alive" even when the daemon is down.
  try {
    const { getTuiHost } = await import("../../hearth/tui-host.js");
    const tui = getTuiHost();
    if (tui.isActive() && owner !== "daemon") {
      owner = "tui";
      ownerPid = process.pid;
      uptimeMs = tui.getUptimeMs();
    } else if (health?.surfaceOwner === "tui") {
      owner = "tui";
      ownerPid = health.surfaceOwnerPid;
    }
  } catch {}
  const running = owner !== "none";

  const lines: Array<{
    type: "header" | "separator" | "entry" | "text" | "spacer";
    label?: string;
    desc?: string;
    color?: string;
    descColor?: string;
  }> = [
    {
      type: "entry",
      label: "Hearth",
      desc:
        owner === "tui"
          ? `running (TUI pid ${String(ownerPid ?? process.pid)})`
          : owner === "daemon"
            ? "running (daemon)"
            : "stopped",
      descColor: running ? theme.success : theme.warning,
    },
    { type: "entry", label: "Socket", desc: config.daemon.socketPath },
  ];
  if (running) {
    lines.push({
      type: "entry",
      label: "Uptime",
      desc: `${String(Math.floor(uptimeMs / 1000))}s`,
    });
    if (health) {
      lines.push({
        type: "entry",
        label: "Pending approvals",
        desc: String(health.pendingApprovals),
      });
    }
  }
  try {
    const { getServiceStatus } = await import("../../hearth/service.js");
    const svc = await getServiceStatus();
    const persistenceDesc = svc.installed
      ? svc.active
        ? `active on boot · ${svc.unitLabel}`
        : `installed (inactive) · ${svc.unitLabel}`
      : svc.platform === "unsupported"
        ? "not supported on this OS"
        : "not installed";
    lines.push({
      type: "entry",
      label: "Persistence",
      desc: persistenceDesc,
      descColor:
        svc.installed && svc.active ? theme.success : svc.installed ? theme.warning : theme.textDim,
    });
  } catch {}
  lines.push({ type: "spacer" });
  lines.push({ type: "header", label: "Surfaces" });

  const surfaceEntries = Object.entries(config.surfaces);
  if (surfaceEntries.length === 0) {
    lines.push({
      type: "text",
      label: "No surfaces configured. Run `/hearth login <surface:id>` to add one.",
      color: theme.textDim,
    });
  }

  let tuiSurfaceStates: { id: string; connected: boolean }[] = [];
  if (owner === "tui") {
    try {
      const { getTuiHost } = await import("../../hearth/tui-host.js");
      tuiSurfaceStates = getTuiHost().listSurfaceStates();
    } catch {}
  }

  for (const [surfaceId, cfg] of surfaceEntries) {
    const [kind, id] = surfaceId.split(":");
    const chats = Object.keys(cfg.chats ?? {}).length;
    const tokenKey = kind && id ? `${kind}.bot.${id}` : null;
    const tokenPresent = tokenKey ? hasSecret(tokenKey) : false;
    const connection = surfaceSnapshot(running, surfaceId, health, tuiSurfaceStates);

    lines.push({
      type: "entry",
      label: surfaceId,
      desc: `${cfg.enabled ? "enabled" : "disabled"} · ${String(chats)} chat(s) · ${connection}`,
      descColor: cfg.enabled ? theme.success : theme.textDim,
    });
    if (tokenKey) {
      lines.push({
        type: "text",
        label: `  keychain: ${tokenKey} · ${tokenPresent ? "present" : "MISSING"}`,
        color: tokenPresent ? theme.textMuted : theme.warning,
      });
    }
  }

  lines.push({ type: "spacer" });
  lines.push({
    type: "text",
    label: "Quick commands: /hearth login /hearth pair /hearth unpair /hearth docs",
    color: theme.textDim,
  });

  ctx.openInfoPopup({
    title: "Hearth [experimental]",
    icon: icon("network"),
    lines,
  });
}

function surfaceSnapshot(
  hearthAlive: boolean,
  surfaceId: string,
  health: HealthResponse | null,
  tuiSurfaces: { id: string; connected: boolean }[] = [],
): string {
  if (!hearthAlive) return "offline";
  const tuiMatch = tuiSurfaces.find((s) => s.id === surfaceId);
  if (tuiMatch) return tuiMatch.connected ? "connected" : "starting";
  const match = health?.surfaces.find((s) => s.id === surfaceId);
  if (!match) return "not started";
  return match.connected ? "connected" : "starting";
}

async function handleHearthLogin(input: string, ctx: CommandContext): Promise<void> {
  const parts = input.trim().split(/\s+/);
  const surfaceId = parts[2] as SurfaceId | undefined;
  if (!surfaceId?.includes(":")) {
    sysMsg(ctx, "Usage: /hearth login <surface:id>  (e.g. telegram:1234567890)");
    return;
  }
  const [kind, id] = surfaceId.split(":");
  if (!kind || !id) {
    sysMsg(ctx, `Surface id must be 'kind:id' — got: ${surfaceId}`);
    return;
  }
  const secretKey = `${kind}.bot.${id}`;
  sysMsg(
    ctx,
    [
      `Store the bot token for ${surfaceId} from a terminal:`,
      `  cat token.txt | soulforge hearth login ${surfaceId}`,
      `(or)  soulforge hearth login ${surfaceId} <token>`,
      `This stores ${secretKey} in the keychain so it never appears in logs.`,
    ].join("\n"),
  );
  void setSecret; // keep import; real storage happens via the CLI path above
}

async function handleHearthPair(input: string, ctx: CommandContext): Promise<void> {
  const parts = input.trim().split(/\s+/);
  const surfaceId = parts[2] as SurfaceId | undefined;
  if (!surfaceId?.includes(":")) {
    sysMsg(ctx, "Usage: /hearth pair <surface:id>");
    return;
  }
  const config = loadHearthConfig(ctx.cwd);
  let code: string;
  let expiresAt: number | undefined;

  // Prefer the in-TUI TuiHost when it owns surfaces — no daemon required.
  // Fall back to the daemon socket when the TUI is passive.
  try {
    const { getTuiHost } = await import("../../hearth/tui-host.js");
    const tui = getTuiHost();
    if (tui.isActive()) {
      const entry = tui.issuePairingCode(surfaceId);
      code = entry.code;
      expiresAt = entry.expiresAt;
    } else if (existsSync(config.daemon.socketPath)) {
      const res = await socketRequest<IssueCodeRequest, IssueCodeResponse>(
        { op: "issue-code", v: HEARTH_PROTOCOL_VERSION, surfaceId },
        { path: config.daemon.socketPath, timeoutMs: 3000 },
      );
      if (!res.ok || !res.code) {
        sysMsg(ctx, `Failed to mint pairing code: ${res.error ?? "unknown error"}`);
        return;
      }
      code = res.code;
      expiresAt = res.expiresAt;
    } else {
      sysMsg(
        ctx,
        "No surface host active. Open /hearth and enable a surface in the TUI, or start the daemon.",
      );
      return;
    }
  } catch (err) {
    sysMsg(ctx, `Pairing failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const ttlSec = expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 0;
  ctx.openInfoPopup({
    title: `Hearth · pair ${surfaceId}`,
    icon: icon("key"),
    lines: [
      { type: "text", label: "Pairing code:", color: getThemeTokens().textDim },
      { type: "text", label: code, color: getThemeTokens().brand },
      ...(ttlSec > 0
        ? [
            {
              type: "text" as const,
              label: `expires in ${String(Math.floor(ttlSec / 60))}m ${String(ttlSec % 60)}s`,
              color: getThemeTokens().textMuted,
            },
          ]
        : []),
      { type: "spacer" },
      { type: "text", label: "Next: DM your bot in the chat, then send:" },
      { type: "text", label: `/pair ${code}`, color: getThemeTokens().textMuted },
      { type: "spacer" },
      {
        type: "text",
        label: "Or locally, once the chat is identified:",
        color: getThemeTokens().textDim,
      },
      {
        type: "text",
        label: `soulforge hearth pair ${surfaceId} ${code}`,
        color: getThemeTokens().textMuted,
      },
    ],
  });
}

function handleHearthDocs(_input: string, ctx: CommandContext): void {
  ctx.openInfoPopup({
    title: "Hearth · docs",
    icon: icon("book"),
    lines: [
      {
        type: "text",
        label: "See docs/hearth.md for setup, security model, and per-surface steps.",
      },
      { type: "spacer" },
      {
        type: "text",
        label: "~/.soulforge/hearth.json — global config",
        color: getThemeTokens().textMuted,
      },
      {
        type: "text",
        label: `${join(configDir(), "hearth.log")} — daemon log`,
        color: getThemeTokens().textMuted,
      },
    ],
  });
}

function handleHearthSettings(_input: string, ctx: CommandContext): void {
  if (typeof ctx.openHearthSettings === "function") {
    ctx.openHearthSettings();
  } else {
    sysMsg(ctx, "Hearth UI not available in this host. Use /hearth status instead.");
  }
}

/**
 * /hearth bind — bind the currently active tab to a Hearth chat.
 *
 *   /hearth bind                     → open a picker listing every configured chat
 *   /hearth bind surface:id/chatId   → bind that specific pairing non-interactively
 */
async function handleHearthBind(input: string, ctx: CommandContext): Promise<void> {
  const parts = input.trim().split(/\s+/);
  const target = parts[2];
  const config = loadHearthConfig(ctx.cwd);
  const { hearthBridge } = await import("../../hearth/bridge.js");
  const allChats: Array<{ surfaceId: string; externalId: string }> = [];
  for (const [sid, cfg] of Object.entries(config.surfaces)) {
    for (const chatId of Object.keys(cfg.chats ?? {})) {
      allChats.push({ surfaceId: sid, externalId: chatId });
    }
  }

  if (allChats.length === 0) {
    sysMsg(
      ctx,
      "No Hearth chats configured. Open /hearth settings and run the Telegram quickstart first.",
    );
    return;
  }

  const bindTo = (surfaceId: string, externalId: string): void => {
    const activeTab = ctx.tabMgr.activeTab;
    hearthBridge.setBinding({
      surfaceId: surfaceId as import("../../hearth/types.js").SurfaceId,
      externalId,
      tabId: activeTab.id,
      tabLabel: activeTab.label,
    });
    hearthBridge.setTabListProvider(() =>
      ctx.tabMgr.tabs.map((t) => ({ id: t.id, label: t.label })),
    );
    sysMsg(
      ctx,
      `Bound ${surfaceId} · ${externalId} → ${activeTab.label}. Messages from that chat now route here; output mirrors back.`,
    );
  };

  // Explicit target — bind directly.
  if (target?.includes("/")) {
    const [sid, chat] = target.split("/");
    if (!sid || !chat) {
      sysMsg(ctx, "Usage: /hearth bind [surface:id/chatId]");
      return;
    }
    bindTo(sid, chat);
    return;
  }

  // Single configured chat — skip the picker.
  if (allChats.length === 1) {
    const only = allChats[0];
    if (!only) return;
    bindTo(only.surfaceId, only.externalId);
    return;
  }

  // Multiple chats — open the picker modal.
  const theme = getThemeTokens();
  ctx.openCommandPicker({
    title: "Bind tab to chat",
    icon: icon("link"),
    searchable: true,
    options: allChats.map(({ surfaceId, externalId }) => ({
      value: `${surfaceId}/${externalId}`,
      label: `${surfaceId} · ${externalId}`,
      description: `Bind to ${ctx.tabMgr.activeTab.label}`,
      color: theme.textMuted,
    })),
    onSelect: (value: string) => {
      const [sid, chat] = value.split("/");
      if (!sid || !chat) return;
      bindTo(sid, chat);
    },
  });
}

async function handleHearthUnbind(_input: string, ctx: CommandContext): Promise<void> {
  const { hearthBridge } = await import("../../hearth/bridge.js");
  const bindings = hearthBridge.listBindings();
  if (bindings.length === 0) {
    sysMsg(ctx, "No bindings active.");
    return;
  }
  for (const b of bindings) hearthBridge.clearBinding(b.surfaceId, b.externalId);
  sysMsg(ctx, `Cleared ${String(bindings.length)} binding(s).`);
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/hearth", handleHearthStatus);
  map.set("/hearth settings", handleHearthSettings);
  map.set("/hearth status", handleHearthStatus);
  map.set("/hearth login", handleHearthLogin);
  map.set("/hearth pair", handleHearthPair);
  map.set("/hearth bind", handleHearthBind);
  map.set("/hearth unbind", handleHearthUnbind);
  map.set("/hearth docs", handleHearthDocs);
}
