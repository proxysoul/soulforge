/**
 * TuiHost — TUI-side Hearth owner.
 *
 * Runs inside the interactive TUI process. When the TUI holds the bridge lock,
 * it:
 *   - Spins up a SurfaceHost so Telegram/Discord poll/stream from the
 *     TUI process (not the daemon).
 *   - Pipes inbound surface messages into the in-process `hearthBridge`, which
 *     routes to the right TabInstance via its registered `submit` handler.
 *   - Handles slash commands (/pair, /tab, /stop, /mute, /unmute, /help) in the
 *     same switch the daemon uses \u2014 behavior parity regardless of owner.
 *   - fs.watches `hearth.json` so config edits (Settings UI quickstart, manual
 *     edits, pair redemption) roll through to adapters live.
 *   - Notifies the daemon on boot / exit via the `bridge-notify` socket op so
 *     the daemon releases surfaces immediately (no 2s poll wait).
 *
 * Lifetime:
 *   - `start()` is idempotent and only brings surfaces up when the TUI owns
 *     the bridge lock. If another pid owns it, we stay passive.
 *   - `stop()` tears down surfaces, config watch, and releases the lock.
 *   - `refresh()` re-reads config and calls `host.reload()`.
 */

import { appendFileSync, existsSync, mkdirSync, unlinkSync, unwatchFile, watchFile } from "node:fs";
import { dirname } from "node:path";
import {
  acquireBridgeLock,
  BRIDGE_LOCK_PATH,
  hearthBridge,
  readBridgeOwner,
  releaseBridgeLock,
} from "./bridge.js";
import {
  GLOBAL_CONFIG_PATH,
  loadHearthConfig,
  resolveChatBinding,
  upsertChatBinding,
  writeGlobalHearthConfig,
} from "./config.js";
import { generatePairingCode, PairingRegistry } from "./pairing.js";
import { socketRequest } from "./protocol.js";
import {
  handleSettingsCommand,
  SETTINGS_COMMAND_NAMES,
  settingsHelpLines,
} from "./provider-commands.js";
import { redact } from "./redact.js";
import { SurfaceHost } from "./surface-host.js";
import {
  type BridgeNotifyRequest,
  type BridgeNotifyResponse,
  HEARTH_PROTOCOL_VERSION,
  type HearthConfig,
  type InboundMessage,
  type SurfaceId,
} from "./types.js";

export interface TuiHostOptions {
  /** Override config load (tests). Default: loadHearthConfig(). */
  loadConfig?: () => HearthConfig;
  log?: (line: string) => void;
}

export class TuiHost {
  private config: HearthConfig;
  private host: SurfaceHost | null = null;
  private started = false;
  private log: (line: string) => void;
  private loadConfigFn: () => HearthConfig;
  private pairings = new PairingRegistry(10 * 60_000);
  private configWatcher = false;

  constructor(opts: TuiHostOptions = {}) {
    this.loadConfigFn = opts.loadConfig ?? (() => loadHearthConfig());
    this.config = this.loadConfigFn();
    this.log = opts.log ?? (() => {});
  }

  /** Acquire bridge lock, build+start surfaces, install outbound sender.
   *  Order is critical: lock → daemon release ack → our surfaces start.
   *  Without awaiting the daemon's release, both long-polls race → Telegram
   *  returns HTTP 409 on every poll.
   *
   *  Contention model: the TUI is the preferred owner. If another *live* TUI
   *  already holds the lock we stay passive (two TUIs don't coexist). But if
   *  the lock points at the daemon (or any non-TUI holder), we notify it to
   *  release first, then steal — TUI-first is the product rule. */
  async start(): Promise<void> {
    if (this.started) return;
    const owner = readBridgeOwner();
    if (owner && owner !== process.pid) {
      // Ask the current owner to step aside. If it's the daemon, `bridge-notify
      // acquired` triggers releaseSurfaces() on the daemon side and returns
      // ok=true. If it's another TUI the socket call fails (no listener) and
      // we stay passive so two TUIs don't fight.
      const released = await this.notifyDaemon("acquired");
      if (!released) {
        this.log(`bridge owned by pid ${String(owner)} — TUI host staying passive`);
        return;
      }
      // Daemon released — force-steal the lock so acquireBridgeLock below
      // doesn't refuse on the stale owner.
      try {
        if (existsSync(BRIDGE_LOCK_PATH)) unlinkSync(BRIDGE_LOCK_PATH);
      } catch {}
    }
    if (!acquireBridgeLock()) {
      this.log("could not acquire bridge lock — TUI host staying passive");
      return;
    }
    this.started = true;
    this.startedAt = Date.now();

    // Re-ack after taking the lock so the daemon's reconcile loop sees the
    // new pid immediately even if the first notify raced the lock write.
    await this.notifyDaemon("acquired");

    this.host = new SurfaceHost({
      config: this.config,
      log: this.log,
      router: { onInbound: (sid, msg) => this.handleInbound(sid, msg) },
    });

    const { ok, failed } = await this.host.start();
    for (const sid of ok) this.log(`surface ${sid} online (tui)`);
    for (const f of failed) this.log(`surface ${f.id} failed (tui): ${f.error}`);

    hearthBridge.setOutboundSender((sid, externalId, event) => {
      if (!this.host) return;
      void this.host.render(sid, externalId, event);
    });

    if (existsSync(GLOBAL_CONFIG_PATH) && !this.configWatcher) {
      watchFile(GLOBAL_CONFIG_PATH, { interval: 1500 }, () => {
        void this.refresh();
      });
      this.configWatcher = true;
    }
  }

  /** Tear down surfaces, release lock, notify daemon. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.startedAt = 0;

    if (this.configWatcher) {
      try {
        unwatchFile(GLOBAL_CONFIG_PATH);
      } catch {}
      this.configWatcher = false;
    }

    hearthBridge.setOutboundSender(null);

    if (this.host) {
      await this.host.stop();
      this.host = null;
    }

    releaseBridgeLock();
    await this.notifyDaemon("released");
  }

  /** Re-read config from disk and diff-reload adapters (live pairing). */
  async refresh(): Promise<void> {
    if (!this.host) return;
    const next = this.loadConfigFn();
    this.config = next;
    const { started, stopped, errors } = await this.host.reload(next);
    for (const id of started) this.log(`surface ${id} online (reload)`);
    for (const id of stopped) this.log(`surface ${id} stopped (reload)`);
    for (const e of errors) this.log(`surface ${e.id} reload error: ${e.error}`);
  }

  getConfig(): HearthConfig {
    return this.config;
  }

  /** Mint a pairing code locally so the TUI works without a running daemon.
   *  Stored in this TuiHost's PairingRegistry; the Telegram `/pair <CODE>`
   *  handler consumes from the same registry, so redemption is in-process. */
  issuePairingCode(surfaceId: SurfaceId, externalId?: string): { code: string; expiresAt: number } {
    const target = externalId ?? `__pending_${Date.now().toString(36)}`;
    const entry = this.pairings.issue(surfaceId, target);
    return { code: entry.code, expiresAt: entry.expiresAt };
  }

  /** True when this TuiHost owns the bridge lock and has surfaces running. */
  isActive(): boolean {
    return this.started && this.host !== null;
  }

  /** Surface-host-owned inbound handler. Replicates daemon slash-command semantics. */
  private async handleInbound(surfaceId: SurfaceId, msg: InboundMessage): Promise<void> {
    if (!this.host) return;
    const surface = this.host.getSurface(surfaceId);
    if (!surface) return;
    this.log(
      `handleInbound ${surfaceId}/${msg.externalId}: cmd=${msg.command?.name ?? "-"} text=${(msg.text ?? "").slice(0, 60)}`,
    );

    if (msg.command) {
      await this.handleCommand(surfaceId, msg);
      return;
    }

    const binding = hearthBridge.getBinding(surfaceId, msg.externalId);
    if (!binding) {
      this.log(
        `handleInbound ${surfaceId}/${msg.externalId}: no bridge binding — will prompt to pair`,
      );
    }
    // Bridge path: forward text (+ images) to the TUI tab bound to this chat.
    if ((msg.text || (msg.images && msg.images.length > 0)) && binding) {
      const kind = surface.kind === "fakechat" ? "fakechat" : surface.kind;
      const handled = hearthBridge.handleInbound(
        {
          surfaceId,
          externalId: msg.externalId,
          text: msg.text ?? "",
          images: msg.images,
        },
        kind as "telegram" | "discord" | "fakechat",
      );
      if (handled) return;
    }

    // No binding yet \u2014 prompt the user to pair.
    if (msg.text) {
      await surface.notify(
        msg.externalId,
        "This chat is not bound to a TUI tab. Run /pair or bind from the TUI.",
      );
    }
  }

  private async handleCommand(surfaceId: SurfaceId, msg: InboundMessage): Promise<void> {
    const cmd = msg.command;
    if (!cmd || !this.host) return;
    const surface = this.host.getSurface(surfaceId);
    if (!surface) return;

    // Provider-settings commands — handled uniformly out of the switch so
    // tui-host and daemon share the same logic. Returns true when consumed.
    if (SETTINGS_COMMAND_NAMES.includes(cmd.name)) {
      const handled = await handleSettingsCommand(cmd.name, cmd.args, (text) =>
        surface.notify(msg.externalId, text),
      );
      if (handled) return;
    }

    switch (cmd.name) {
      case "/tabs":
      case "/list": {
        const tabs = hearthBridge.listTabs();
        const active = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
        if (tabs.length === 0) {
          await surface.notify(msg.externalId, "No TUI tabs open.");
          return;
        }
        const body = tabs
          .map((t, i) => `${String(i + 1)}. ${t.label}${t.id === active ? " (active)" : ""}`)
          .join("\n");
        await surface.notify(msg.externalId, body);
        return;
      }
      case "/tab": {
        const target = cmd.args[0];
        const tabs = hearthBridge.listTabs();
        if (!target) {
          const active = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          const body = tabs
            .map((t, i) => `${String(i + 1)}. ${t.label}${t.id === active ? " (active)" : ""}`)
            .join("\n");
          await surface.notify(msg.externalId, body || "(no tabs)");
          return;
        }
        const idx = Number.parseInt(target, 10);
        let picked: { id: string; label: string } | null = null;
        if (!Number.isNaN(idx) && idx >= 1 && idx <= tabs.length) {
          picked = tabs[idx - 1] ?? null;
        } else {
          picked = tabs.find((t) => t.id.startsWith(target) || t.label === target) ?? null;
        }
        if (!picked) {
          await surface.notify(msg.externalId, `No tab matching "${target}"`);
          return;
        }
        // Auto-bind: if chat has no binding yet, bind it to the picked tab so
        // subsequent messages route automatically.
        if (!hearthBridge.getBinding(surfaceId, msg.externalId)) {
          hearthBridge.setBinding({
            surfaceId,
            externalId: msg.externalId,
            tabId: picked.id,
            tabLabel: picked.label,
          });
        }
        const next = hearthBridge.switchActiveTab(surfaceId, msg.externalId, picked.id);
        if (!next) {
          await surface.notify(msg.externalId, "Tab no longer registered.");
          return;
        }
        await surface.notify(msg.externalId, `Active tab: ${picked.label}`);
        // /tab N <prompt> \u2014 one-shot: if extra words follow, route as text.
        const extra = cmd.args.slice(1).join(" ").trim();
        if (extra) {
          hearthBridge.handleInbound(
            { surfaceId, externalId: msg.externalId, text: extra },
            (surface.kind === "fakechat" ? "fakechat" : surface.kind) as
              | "telegram"
              | "discord"
              | "fakechat",
          );
        }
        return;
      }
      case "/stop": {
        const ok = hearthBridge.abortBoundTab(surfaceId, msg.externalId);
        await surface.notify(msg.externalId, ok ? "Aborted current turn." : "Nothing to stop.");
        return;
      }
      case "/mute": {
        const state = hearthBridge.setMuted(surfaceId, msg.externalId, true);
        await surface.notify(
          msg.externalId,
          state === null ? "No binding." : "Muted \u2014 output hidden until /unmute.",
        );
        return;
      }
      case "/unmute": {
        const state = hearthBridge.setMuted(surfaceId, msg.externalId, false);
        await surface.notify(
          msg.externalId,
          state === null ? "No binding." : "Unmuted \u2014 output resumed.",
        );
        return;
      }
      case "/pair": {
        const arg = cmd.args[0]?.trim().toUpperCase();
        if (arg) {
          if (this.pairings.isLocked(surfaceId, msg.externalId)) {
            await surface.notify(
              msg.externalId,
              "✗ Too many bad pairing attempts. Try again later.",
            );
            return;
          }
          const entry = this.pairings.consume(surfaceId, arg, msg.externalId);
          if (!entry) {
            await surface.notify(
              msg.externalId,
              `\u2717 Invalid or expired code: ${arg}. Mint a fresh one with /pair.`,
            );
            return;
          }
          const updated = upsertChatBinding(this.config, surfaceId, msg.externalId, {
            caps: this.config.defaults.caps,
            maxTabs: this.config.defaults.maxTabs,
          });
          this.config = updated;
          writeGlobalHearthConfig(updated);
          await surface.notify(
            msg.externalId,
            `\u2713 Paired ${surfaceId} \u00b7 ${msg.externalId}`,
          );
          // Auto-bind to the active TUI tab if available.
          const tabs = hearthBridge.listTabs();
          const firstTab = tabs[0];
          if (firstTab) {
            hearthBridge.setBinding({
              surfaceId,
              externalId: msg.externalId,
              tabId: firstTab.id,
              tabLabel: firstTab.label,
            });
            await surface.notify(msg.externalId, `Bound to ${firstTab.label}.`);
          }
          return;
        }
        // /pair (no arg): already-paired short-circuit. If paired but no
        // runtime binding exists, auto-bind to the first available tab —
        // otherwise the user is stuck in a loop where /pair claims success
        // but plain messages report "not bound to a TUI tab".
        const existing = resolveChatBinding(this.config, surfaceId, msg.externalId);
        if (existing) {
          const currentBinding = hearthBridge.getBinding(surfaceId, msg.externalId);
          if (currentBinding) {
            await surface.notify(
              msg.externalId,
              "\u2713 This chat is already paired. Send a message to start a turn.",
            );
            return;
          }
          const tabs = hearthBridge.listTabs();
          const firstTab = tabs[0];
          if (!firstTab) {
            await surface.notify(
              msg.externalId,
              "Paired, but no TUI tab is open yet. Open a tab in the TUI, then send a message here.",
            );
            return;
          }
          hearthBridge.setBinding({
            surfaceId,
            externalId: msg.externalId,
            tabId: firstTab.id,
            tabLabel: firstTab.label,
          });
          await surface.notify(
            msg.externalId,
            `\u2713 Bound to ${firstTab.label}. Send a message to start a turn.`,
          );
          return;
        }
        // Mint a fresh code, store in our registry, send via adapter.
        const code = generatePairingCode();
        this.pairings.injectForTests({
          code,
          surfaceId,
          externalId: msg.externalId,
          createdAt: Date.now(),
          expiresAt: Date.now() + 10 * 60_000,
        });
        await surface.sendPairingPrompt(msg.externalId, code);
        return;
      }
      case "/unpair": {
        const existing = resolveChatBinding(this.config, surfaceId, msg.externalId);
        if (!existing) {
          await surface.notify(msg.externalId, "This chat is not paired.");
          return;
        }
        const next = { ...this.config };
        const sc = next.surfaces[surfaceId];
        if (sc) {
          const chats = { ...sc.chats };
          delete chats[msg.externalId];
          next.surfaces[surfaceId] = { ...sc, chats };
        }
        this.config = next;
        writeGlobalHearthConfig(next);
        hearthBridge.clearBinding(surfaceId, msg.externalId);
        await surface.notify(msg.externalId, "\u2713 Unpaired. Run /pair to bind again.");
        return;
      }
      case "/new": {
        const label = cmd.args.join(" ").trim() || undefined;
        const newTabId = hearthBridge.createTab(label);
        if (!newTabId) {
          await surface.notify(
            msg.externalId,
            "Cannot create tabs from here (TUI not active or max tabs reached).",
          );
          return;
        }
        hearthBridge.setBinding({
          surfaceId,
          externalId: msg.externalId,
          tabId: newTabId,
          tabLabel: label,
        });
        await surface.notify(
          msg.externalId,
          `Opened ${label ?? "new tab"} \u00b7 bound to this chat.`,
        );
        return;
      }
      case "/close": {
        const target = cmd.args[0];
        const tabs = hearthBridge.listTabs();
        let targetId: string | null = null;
        if (!target) {
          targetId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
        } else {
          const idx = Number.parseInt(target, 10);
          if (!Number.isNaN(idx) && idx >= 1 && idx <= tabs.length) {
            targetId = tabs[idx - 1]?.id ?? null;
          } else {
            targetId = tabs.find((t) => t.id.startsWith(target) || t.label === target)?.id ?? null;
          }
        }
        if (!targetId) {
          await surface.notify(msg.externalId, "No tab to close.");
          return;
        }
        const ok = hearthBridge.closeRemoteTab(targetId);
        await surface.notify(msg.externalId, ok ? "Tab closed." : "Cannot close that tab.");
        return;
      }
      case "/status": {
        const binding = hearthBridge.getBinding(surfaceId, msg.externalId);
        if (!binding) {
          await surface.notify(msg.externalId, "Not bound. Run /pair or /tab <n>.");
          return;
        }
        const activeId = hearthBridge.getActiveTabId(surfaceId, msg.externalId) ?? binding.tabId;
        const snap = hearthBridge.getTabStatus(activeId);
        if (!snap) {
          await surface.notify(msg.externalId, "Active tab not available.");
          return;
        }
        const lines = [
          `\u25b8 ${snap.label}`,
          `model: ${snap.activeModel || "(default)"}`,
          `mode: ${snap.forgeMode}`,
          `state: ${snap.isLoading ? "running" : "idle"}`,
          `messages: ${String(snap.messageCount)}`,
          `tokens: in ${String(snap.tokenUsage.input)} \u00b7 out ${String(snap.tokenUsage.output)}`,
          binding.muted ? "muted: yes" : "muted: no",
        ];
        await surface.notify(msg.externalId, lines.join("\n"));
        return;
      }
      case "/model": {
        const snap = this.getBoundSnapshot(surfaceId, msg.externalId);
        if (!snap) {
          await surface.notify(msg.externalId, "No bound tab.");
          return;
        }
        const target = cmd.args.join(" ").trim();
        if (!target) {
          await surface.notify(msg.externalId, `model: ${snap.activeModel || "(default)"}`);
          return;
        }
        const ok = hearthBridge.setActiveModelFor(snap.tabId, target);
        await surface.notify(
          msg.externalId,
          ok ? `model \u2192 ${target}` : "Could not set model (tab unavailable).",
        );
        return;
      }
      case "/mode": {
        const snap = this.getBoundSnapshot(surfaceId, msg.externalId);
        if (!snap) {
          await surface.notify(msg.externalId, "No bound tab.");
          return;
        }
        const target = cmd.args[0];
        if (!target) {
          await surface.notify(msg.externalId, `mode: ${snap.forgeMode}`);
          return;
        }
        const ok = hearthBridge.setForgeModeFor(snap.tabId, target);
        await surface.notify(
          msg.externalId,
          ok
            ? `mode \u2192 ${target}`
            : "Invalid mode. Valid: default, architect, socratic, challenge, plan, auto.",
        );
        return;
      }
      case "/clear": {
        const snap = this.getBoundSnapshot(surfaceId, msg.externalId);
        if (!snap) {
          await surface.notify(msg.externalId, "No bound tab.");
          return;
        }
        const ok = hearthBridge.clearTab(snap.tabId);
        await surface.notify(msg.externalId, ok ? "Tab cleared." : "Cannot clear tab.");
        return;
      }
      case "/cost": {
        const snap = this.getBoundSnapshot(surfaceId, msg.externalId);
        if (!snap) {
          await surface.notify(msg.externalId, "No bound tab.");
          return;
        }
        const cost = hearthBridge.getCost(snap.tabId);
        if (!cost) {
          await surface.notify(msg.externalId, "No cost data.");
          return;
        }
        const lines = [
          `\u25b8 ${snap.label}`,
          `in  ${String(cost.input).padStart(7)} tokens`,
          `out ${String(cost.output).padStart(7)} tokens`,
        ];
        if (cost.cacheRead && cost.cacheRead > 0)
          lines.push(`cache ${String(cost.cacheRead).padStart(5)} tokens`);
        if (cost.usd !== undefined) lines.push(`usd $${cost.usd.toFixed(4)}`);
        await surface.notify(msg.externalId, lines.join("\n"));
        return;
      }
      case "/queue": {
        const snap = this.getBoundSnapshot(surfaceId, msg.externalId);
        if (!snap) {
          await surface.notify(msg.externalId, "No bound tab.");
          return;
        }
        const extra = cmd.args.join(" ").trim();
        if (extra) {
          hearthBridge.appendQueue(snap.tabId, extra);
          await surface.notify(msg.externalId, "Queued.");
          return;
        }
        const queue = hearthBridge.getQueue(snap.tabId);
        if (queue.length === 0) {
          await surface.notify(msg.externalId, "(queue empty)");
          return;
        }
        await surface.notify(
          msg.externalId,
          queue.map((q, i) => `${String(i + 1)}. ${q}`).join("\n"),
        );
        return;
      }
      case "/diff": {
        const snap = this.getBoundSnapshot(surfaceId, msg.externalId);
        if (!snap) {
          await surface.notify(msg.externalId, "No bound tab.");
          return;
        }
        const diff = hearthBridge.getDiff(snap.tabId);
        await surface.notify(msg.externalId, diff || "(no edits)");
        return;
      }
      case "/files": {
        const snap = this.getBoundSnapshot(surfaceId, msg.externalId);
        if (!snap) {
          await surface.notify(msg.externalId, "No bound tab.");
          return;
        }
        const files = hearthBridge.getFiles(snap.tabId);
        await surface.notify(msg.externalId, files || "(clean)");
        return;
      }
      case "/cwd": {
        const snap = this.getBoundSnapshot(surfaceId, msg.externalId);
        if (!snap) {
          await surface.notify(msg.externalId, "No bound tab.");
          return;
        }
        const cwd = hearthBridge.getCwd(snap.tabId);
        await surface.notify(msg.externalId, cwd || "(unknown)");
        return;
      }
      case "/sessions": {
        const list = hearthBridge.listSessions(10);
        if (list.length === 0) {
          await surface.notify(msg.externalId, "(no sessions)");
          return;
        }
        const lines = list.map((s, i) => {
          const dt = new Date(s.updatedAt).toISOString().slice(0, 16).replace("T", " ");
          return `${String(i + 1).padStart(2)}. ${s.id.slice(0, 8)} \u00b7 ${dt} \u00b7 ${s.title.slice(0, 40)}`;
        });
        await surface.notify(msg.externalId, lines.join("\n"));
        return;
      }
      case "/resume": {
        const prefix = cmd.args[0];
        if (!prefix) {
          await surface.notify(msg.externalId, "Usage: /resume <id-prefix>");
          return;
        }
        const res = hearthBridge.resumeSession(prefix);
        await surface.notify(msg.externalId, res.ok ? `Resumed ${prefix}.` : (res.error ?? "fail"));
        return;
      }
      case "/checkpoint": {
        const snap = this.getBoundSnapshot(surfaceId, msg.externalId);
        if (!snap) {
          await surface.notify(msg.externalId, "No bound tab.");
          return;
        }
        const list = hearthBridge.listCheckpoints(snap.tabId);
        if (list.length === 0) {
          await surface.notify(msg.externalId, "(no checkpoints)");
          return;
        }
        const lines = list.map(
          (c) =>
            `#${String(c.index).padStart(3)} \u00b7 ${new Date(c.ts).toISOString().slice(0, 16).replace("T", " ")} \u00b7 ${c.label}`,
        );
        await surface.notify(msg.externalId, lines.join("\n"));
        return;
      }
      case "/undo": {
        const snap = this.getBoundSnapshot(surfaceId, msg.externalId);
        if (!snap) {
          await surface.notify(msg.externalId, "No bound tab.");
          return;
        }
        const idx = cmd.args[0] ? Number.parseInt(cmd.args[0], 10) : undefined;
        const res = hearthBridge.undoCheckpoint(snap.tabId, idx);
        await surface.notify(
          msg.externalId,
          res.ok ? `Restored to #${String(res.restoredTo ?? "?")}.` : (res.error ?? "fail"),
        );
        return;
      }
      case "/agents": {
        const snap = this.getBoundSnapshot(surfaceId, msg.externalId);
        if (!snap) {
          await surface.notify(msg.externalId, "No bound tab.");
          return;
        }
        const list = hearthBridge.listAgents(snap.tabId);
        if (list.length === 0) {
          await surface.notify(msg.externalId, "(no active agents)");
          return;
        }
        await surface.notify(
          msg.externalId,
          list
            .map((a) => `${a.id.slice(0, 8)} \u00b7 ${a.status} \u00b7 ${a.task.slice(0, 60)}`)
            .join("\n"),
        );
        return;
      }
      case "/cancel": {
        const snap = this.getBoundSnapshot(surfaceId, msg.externalId);
        if (!snap) {
          await surface.notify(msg.externalId, "No bound tab.");
          return;
        }
        const id = cmd.args[0];
        if (!id) {
          await surface.notify(msg.externalId, "Usage: /cancel <agent-id>");
          return;
        }
        const ok = hearthBridge.cancelAgent(snap.tabId, id);
        await surface.notify(msg.externalId, ok ? "Cancelled." : "Not found or not cancellable.");
        return;
      }
      case "/mcp": {
        const sub = cmd.args[0];
        if (!sub || sub === "list") {
          const list = hearthBridge.listMcp();
          if (list.length === 0) {
            await surface.notify(msg.externalId, "(no MCP servers configured)");
            return;
          }
          await surface.notify(
            msg.externalId,
            list
              .map((m) => `${m.enabled ? "\u25cf" : "\u25cb"} ${m.name.padEnd(20)} ${m.status}`)
              .join("\n"),
          );
          return;
        }
        if (sub === "toggle") {
          const name = cmd.args[1];
          if (!name) {
            await surface.notify(msg.externalId, "Usage: /mcp toggle <name>");
            return;
          }
          const res = hearthBridge.toggleMcp(name);
          await surface.notify(
            msg.externalId,
            res.ok
              ? `${name} \u2192 ${res.enabled ? "enabled" : "disabled"}`
              : (res.error ?? "fail"),
          );
          return;
        }
        await surface.notify(msg.externalId, "Usage: /mcp [list|toggle <name>]");
        return;
      }
      case "/notify": {
        const m = cmd.args[0];
        if (m !== "on" && m !== "off" && m !== "errors") {
          await surface.notify(msg.externalId, "Usage: /notify on|off|errors");
          return;
        }
        const res = hearthBridge.setNotifyModeForChat(surfaceId, msg.externalId, m);
        await surface.notify(msg.externalId, res ? `notify \u2192 ${m}` : "No binding.");
        return;
      }
      case "/say": {
        const target = cmd.args[0];
        if (!target || cmd.args.length < 2) {
          await surface.notify(msg.externalId, "Usage: /say <tab-n|label> <text>");
          return;
        }
        const tabs = hearthBridge.listTabs();
        const idx = Number.parseInt(target, 10);
        let picked: { id: string; label: string } | null = null;
        if (!Number.isNaN(idx) && idx >= 1 && idx <= tabs.length) {
          picked = tabs[idx - 1] ?? null;
        } else {
          picked = tabs.find((t) => t.id.startsWith(target) || t.label === target) ?? null;
        }
        if (!picked) {
          await surface.notify(msg.externalId, `No tab "${target}"`);
          return;
        }
        const text = cmd.args.slice(1).join(" ");
        const ok = hearthBridge.sendToTab(picked.id, text);
        await surface.notify(msg.externalId, ok ? `\u2192 ${picked.label}` : "Send failed.");
        return;
      }
      case "/find": {
        const snap = this.getBoundSnapshot(surfaceId, msg.externalId);
        if (!snap) {
          await surface.notify(msg.externalId, "No bound tab.");
          return;
        }
        const q = cmd.args.join(" ").trim();
        if (!q) {
          await surface.notify(msg.externalId, "Usage: /find <query>");
          return;
        }
        const hits = hearthBridge.findInTab(snap.tabId, q, 10);
        if (hits.length === 0) {
          await surface.notify(msg.externalId, "(no matches)");
          return;
        }
        await surface.notify(msg.externalId, hits.map((h) => `\u2022 ${h.snippet}`).join("\n"));
        return;
      }
      case "/branch": {
        const snap = this.getBoundSnapshot(surfaceId, msg.externalId);
        if (!snap) {
          await surface.notify(msg.externalId, "No bound tab.");
          return;
        }
        const label = cmd.args.join(" ").trim() || undefined;
        const res = hearthBridge.branchTab(snap.tabId, label);
        await surface.notify(
          msg.externalId,
          res.ok ? `Branched \u2192 ${String(res.tabId ?? "")}` : (res.error ?? "fail"),
        );
        return;
      }
      case "/help": {
        await surface.notify(
          msg.externalId,
          [
            "\u2501\u2501 Tabs \u2501\u2501",
            "/tabs, /list           list TUI tabs",
            "/tab <n> [text]        switch tab; extra words \u2192 prompt",
            "/new [label]           open + bind a new tab",
            "/close [n]             close a tab",
            "/branch [label]        fork current tab (not yet wired)",
            "",
            "\u2501\u2501 Chat \u2501\u2501",
            "/model [name]          show or set model",
            "/mode [name]           show or set forge mode",
            "/clear                 wipe current tab's history",
            "/stop                  abort current turn",
            "/say <n> <text>        send text to another tab",
            "/queue [text]          show or append to message queue",
            "",
            "\u2501\u2501 State \u2501\u2501",
            "/status                active tab + model + tokens",
            "/cost                  token usage breakdown",
            "/diff                  files edited in this tab",
            "/files                 working-copy changes",
            "/cwd                   current working directory",
            "/find <q>              grep messages in tab",
            "",
            "\u2501\u2501 History \u2501\u2501",
            "/sessions              list recent sessions",
            "/resume <prefix>       resume a session (TUI only)",
            "/checkpoint            list tab checkpoints",
            "/undo [n]              revert to a checkpoint",
            "",
            "\u2501\u2501 Agents / MCP \u2501\u2501",
            "/agents                active dispatched agents",
            "/cancel <id>           cancel an agent",
            "/mcp [list|toggle <n>] MCP server ops",
            "",
            "\u2501\u2501 Notifications \u2501\u2501",
            "/notify on|off|errors  outbound filter",
            "/mute, /unmute         legacy on/off",
            "",
            "\u2501\u2501 Pairing \u2501\u2501",
            "/pair [CODE]           pair this chat \u00b7 redeem a code",
            "/unpair                revoke pairing",
            "",
            ...settingsHelpLines(),
            "",
            "/help                  this list",
          ].join("\n"),
        );
        return;
      }
      default:
        await surface.notify(msg.externalId, "Unknown command. Try /help.");
    }
  }

  /** Resolve the TabStatusSnapshot for the tab currently bound to a chat. */
  private getBoundSnapshot(
    surfaceId: SurfaceId,
    externalId: string,
  ): import("./bridge.js").TabStatusSnapshot | null {
    const activeId = hearthBridge.getActiveTabId(surfaceId, externalId);
    if (!activeId) return null;
    return hearthBridge.getTabStatus(activeId);
  }

  /** Returns true when a live daemon acknowledged the state change, false when
   *  no daemon is reachable. Callers use the return value to decide whether
   *  contention is with a daemon (handoff) or another TUI (stay passive). */
  private async notifyDaemon(state: "acquired" | "released"): Promise<boolean> {
    const socketPath = this.config.daemon.socketPath;
    if (!existsSync(socketPath)) return false;
    try {
      const res = await socketRequest<BridgeNotifyRequest, BridgeNotifyResponse>(
        { op: "bridge-notify", v: HEARTH_PROTOCOL_VERSION, state, pid: process.pid },
        { path: socketPath, timeoutMs: 1500 },
      );
      return res.ok === true;
    } catch {
      // Daemon not running or unreachable — the file-lock watcher will reconcile.
      return false;
    }
  }

  /** Surface states for UI status panes (Connection field in HearthSettings). */
  listSurfaceStates(): { id: SurfaceId; connected: boolean; chats: number }[] {
    if (!this.host) return [];
    return this.host.listSurfaces().map((s) => ({
      id: s.id,
      connected: s.isConnected(),
      chats: hearthBridge.listBindings().filter((b) => b.surfaceId === s.id).length,
    }));
  }

  private startedAt = 0;

  getUptimeMs(): number {
    return this.startedAt > 0 ? Date.now() - this.startedAt : 0;
  }
}

/** Singleton \u2014 one TuiHost per process. */
let _tuiHost: TuiHost | null = null;

export function getTuiHost(): TuiHost {
  if (!_tuiHost) {
    const cfg = loadHearthConfig();
    const logPath = cfg.daemon.logFile;
    try {
      if (logPath) {
        const dir = dirname(logPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      }
    } catch {}
    _tuiHost = new TuiHost({
      log: (line) => {
        // M8: redact at the sink so every TUI-owned surface log line is
        // scrubbed regardless of caller discipline — matches the daemon's
        // logFn behavior.
        const scrubbed = redact(line);
        if (logPath) {
          try {
            appendFileSync(logPath, `${new Date().toISOString()} [hearth-tui] ${scrubbed}\n`);
          } catch {}
        }
        void import("../stores/errors.js").then(({ logBackgroundError }) => {
          logBackgroundError("Hearth", scrubbed);
        });
      },
    });
  }
  return _tuiHost;
}

/** Test hook. */
export function _resetTuiHost(): void {
  _tuiHost = null;
}
