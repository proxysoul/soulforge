/**
 * HearthDaemon — single-process coordinator.
 *
 * Responsibilities:
 *   - Own the UNIX permission socket (0o600)
 *   - Register surfaces, route inbound messages → ChatWorkspace → TabLoop
 *   - Resolve PreToolUse approvals via policy + surface prompts
 *   - Mint pairing codes and bind fresh chats to the config
 *   - Persist workspace state + flush on graceful shutdown
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";
import { ApprovalRegistry } from "./approvals.js";
import { hearthBridge, readBridgeOwner } from "./bridge.js";
import {
  DEFAULT_PID_PATH,
  loadHearthConfig,
  resolveChatBinding,
  upsertChatBinding,
  writeGlobalHearthConfig,
} from "./config.js";
import { PairingRegistry } from "./pairing.js";
import { checkPeer } from "./peer-auth.js";
import { describeTool, evaluatePolicy } from "./policy.js";
import { attachFrameReader, writeFrame } from "./protocol.js";
import { installGlobalRedaction, redact } from "./redact.js";
import { ChatWorkspaceRegistry } from "./registry.js";
import { SurfaceHost } from "./surface-host.js";
import {
  HEARTH_PROTOCOL_VERSION,
  type HearthConfig,
  type HearthLifetimeStats,
  type HearthPersistedState,
  type InboundMessage,
  type PermissionRequest,
  type PermissionResponse,
  type ReloadResponse,
  type RemoteWorkspaceSnapshot,
  type SocketRequest,
  type SurfaceId,
} from "./types.js";
import { ChatWorkspace } from "./workspace.js";

export interface HearthDaemonOptions {
  config?: HearthConfig;
  /** Stream daemon log lines. Defaults to stderr. */
  onLog?: (line: string) => void;
  /** Skip redaction install (tests). */
  skipRedaction?: boolean;
}

export class HearthDaemon {
  private config: HearthConfig;
  private host: SurfaceHost;
  private workspaces = new ChatWorkspaceRegistry();
  private approvals: ApprovalRegistry;
  private pairings: PairingRegistry;
  private socketServer: Server | null = null;
  private started = false;
  private startedAt = 0;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private lockWatchTimer: ReturnType<typeof setInterval> | null = null;
  private surfacesUp = false;
  /** Pid of the TUI that currently holds the bridge lock. null = we hold / vacant. */
  private tuiOwnerPid: number | null = null;
  /** Debounce state for reconcileOwnership — require two consecutive readings
   *  agreeing before we flip ownership. Guards against FS hiccups or racy
   *  `kill(pid,0)` checks causing the daemon to thrash acquire/release. */
  private pendingTransition: { to: number | null; count: number } | null = null;
  /** Set while a transition (acquireSurfaces or releaseSurfaces) is in flight
   *  so the reconcile loop doesn't double-fire and start two polling loops. */
  private transitioning = false;
  private logFn: (line: string) => void;

  /** Lifetime counters since daemon boot. Reset on start, never persisted. */
  private stats: HearthLifetimeStats = {
    messagesIn: 0,
    eventsOut: 0,
    approvalsHandled: 0,
    approvalsAllowed: 0,
    approvalsDenied: 0,
    pairingsIssued: 0,
    tabsOpened: 0,
    turnsCompleted: 0,
    toolCalls: 0,
    workspacesEver: 0,
  };

  /** Snapshot current counters — consumed by health RPC and /status. */
  getStats(): HearthLifetimeStats {
    return { ...this.stats };
  }

  /** Bump counters in response to HeadlessEvents from TabLoops. */
  private recordTabEvent(ev: import("../headless/types.js").HeadlessEvent): void {
    this.stats.eventsOut++;
    if (ev.type === "tool-call") this.stats.toolCalls++;
    else if (ev.type === "turn-done") this.stats.turnsCompleted++;
  }

  constructor(private opts: HearthDaemonOptions = {}) {
    this.config = opts.config ?? loadHearthConfig();
    this.approvals = new ApprovalRegistry(this.config.daemon.approvalTimeoutMs);
    this.pairings = new PairingRegistry(this.config.daemon.pairingTtlMs);
    const fileLogger = createFileLogger(this.config.daemon.logFile);
    const userLog = opts.onLog;
    this.logFn = (line) => {
      // M8: redact at the sink. Every daemon log line passes through here,
      // so callers that forget to wrap err.message in redact() still can't
      // leak tokens to disk or to the optional user log callback.
      const scrubbed = redact(line);
      fileLogger(scrubbed);
      if (userLog) userLog(scrubbed);
      else process.stderr.write(`${scrubbed}\n`);
    };
    this.host = new SurfaceHost({
      config: this.config,
      log: this.logFn,
      router: { onInbound: (sid, msg) => this.handleInbound(sid, msg) },
    });
    // Pre-provided surfaces (legacy CLI path) are now discarded — SurfaceHost
    // builds its own from config. The CLI should not pass `surfaces` going forward.
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.startedAt = Date.now();

    if (!this.opts.skipRedaction) installGlobalRedaction();

    this.log(`hearth starting — socket: ${this.config.daemon.socketPath}`);

    // Write pidfile so the UI (and CLI) can kill us reliably without pattern matching.
    const pidPath = DEFAULT_PID_PATH;
    try {
      mkdirSync(dirname(pidPath), { recursive: true, mode: 0o700 });
      writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
    } catch (err) {
      this.log(`pidfile write failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    await this.startSocket();

    // Decide who owns surfaces: TUI wins if it holds the bridge lock.
    const tuiOwner = readBridgeOwner();
    this.tuiOwnerPid = tuiOwner && tuiOwner !== process.pid ? tuiOwner : null;
    if (this.tuiOwnerPid) {
      this.log(`bridge owned by pid ${String(this.tuiOwnerPid)} — daemon staying out of routing`);
    } else {
      await this.acquireSurfaces();
    }

    // Poll the lock every 2s so we hand off / pick up surfaces when the TUI
    // boots or exits without calling us via `bridge-notify`.
    this.lockWatchTimer = setInterval(() => {
      void this.reconcileOwnership();
    }, 2_000);

    this.pruneTimer = setInterval(() => {
      this.pairings.prune();
    }, 60_000);

    process.on("SIGTERM", () => void this.stop());
    process.on("SIGINT", () => void this.stop());
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.lockWatchTimer) clearInterval(this.lockWatchTimer);
    this.lockWatchTimer = null;

    this.approvals.stop();
    await this.releaseSurfaces({ persist: true });

    if (this.socketServer) {
      await new Promise<void>((res) => this.socketServer?.close(() => res()));
      this.socketServer = null;
    }
    if (existsSync(this.config.daemon.socketPath)) {
      try {
        unlinkSync(this.config.daemon.socketPath);
      } catch (e) {
        this.log(`failed to remove socket: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Remove pidfile so the UI knows we're gone.
    try {
      unlinkSync(DEFAULT_PID_PATH);
    } catch (e) {
      this.log(`failed to remove pidfile: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.log("hearth stopped");
  }

  getConfig(): HearthConfig {
    return this.config;
  }

  listWorkspaces(): ReturnType<ChatWorkspaceRegistry["list"]> {
    return this.workspaces.list();
  }

  issuePairingCode(surfaceId: SurfaceId, externalId: string): string {
    this.stats.pairingsIssued++;
    return this.pairings.issue(surfaceId, externalId).code;
  }

  async sendPairingPromptForExternal(surfaceId: SurfaceId, externalId: string): Promise<string> {
    const code = this.issuePairingCode(surfaceId, externalId);
    const ok = await this.host.sendPairingPrompt(surfaceId, externalId, code);
    if (!ok) throw new Error(`surface not registered: ${surfaceId}`);
    return code;
  }

  /** Acquire the surface adapters: build + start them via SurfaceHost.
   *  Re-checks the bridge lock at the last moment — refuses to start if a
   *  TUI grabbed the lock between the poll and this call. */
  private async acquireSurfaces(): Promise<void> {
    if (this.surfacesUp) return;
    const owner = readBridgeOwner();
    if (owner && owner !== process.pid) {
      this.log(`refused to acquire surfaces — bridge held by pid ${String(owner)}`);
      this.tuiOwnerPid = owner;
      return;
    }
    this.surfacesUp = true;
    this.restoreWorkspaces();
    const { ok, failed } = await this.host.start();
    for (const sid of ok) this.log(`surface ${sid} online`);
    for (const f of failed) this.log(`surface ${f.id} failed to start: ${f.error}`);
    // Keep bridge outbound sender pointed at our host while we own surfaces.
    hearthBridge.setOutboundSender((sid, externalId, event) => {
      void this.host.render(sid, externalId, event);
    });
  }

  /** Release surface adapters (TUI took over, or we're shutting down). */
  private async releaseSurfaces(opts: { persist?: boolean } = {}): Promise<void> {
    if (!this.surfacesUp && this.workspaces.size() === 0) return;
    this.surfacesUp = false;
    await this.host.stop();
    if (opts.persist) await this.persistState();
    await this.workspaces.closeAll();
    hearthBridge.setOutboundSender(null);
  }

  /** Poll the bridge lock and swap ownership on transitions.
   *  Debounced: require 2 consecutive readings agreeing before flipping state
   *  so a transient FS miss doesn't bounce the surfaces.
   *  Serialized: `transitioning` guard prevents overlap between acquire/release
   *  so we can never have two polling loops live at once. */
  private async reconcileOwnership(): Promise<void> {
    if (!this.started) return;
    if (this.transitioning) return;

    const owner = readBridgeOwner();
    const tuiPid = owner && owner !== process.pid ? owner : null;
    const current = this.tuiOwnerPid;

    // Same as current — clear any pending transition, nothing to do.
    if (tuiPid === current) {
      this.pendingTransition = null;
      return;
    }

    // Build / bump the debounce entry.
    if (!this.pendingTransition || this.pendingTransition.to !== tuiPid) {
      this.pendingTransition = { to: tuiPid, count: 1 };
      return;
    }
    this.pendingTransition.count++;
    if (this.pendingTransition.count < 2) return;
    this.pendingTransition = null;

    this.transitioning = true;
    try {
      if (tuiPid && !current) {
        this.tuiOwnerPid = tuiPid;
        this.log(`TUI pid ${String(tuiPid)} took bridge lock — releasing surfaces`);
        await this.releaseSurfaces({ persist: true });
      } else if (!tuiPid && current) {
        this.log(`TUI pid ${String(current)} released bridge — picking up surfaces`);
        this.tuiOwnerPid = null;
        await this.acquireSurfaces();
      }
    } finally {
      this.transitioning = false;
    }
  }

  /** Surface-level adapters use this to start approvals directly (no CLI round-trip). */
  async requestApproval(
    surfaceId: SurfaceId,
    externalId: string,
    req: PermissionRequest,
  ): Promise<PermissionResponse> {
    const binding = resolveChatBinding(this.config, surfaceId, externalId);
    const decision = evaluatePolicy(req, binding);
    if (decision.kind === "allow") {
      return { v: HEARTH_PROTOCOL_VERSION, decision: "allow", reason: decision.matched };
    }
    if (decision.kind === "deny") {
      return { v: HEARTH_PROTOCOL_VERSION, decision: "deny", reason: decision.reason };
    }

    if (!this.host.getSurface(surfaceId)) {
      return { v: HEARTH_PROTOCOL_VERSION, decision: "deny", reason: "surface offline" };
    }

    return new Promise<PermissionResponse>((resolve) => {
      const entry = this.approvals.register(
        {
          sessionId: req.sessionId,
          toolName: req.toolName,
          toolCallId: req.toolCallId,
          cwd: req.cwd,
          tabId: req.tabId,
          toolInput: req.toolInput,
        },
        resolve,
      );
      this.host
        .requestApproval(surfaceId, externalId, {
          approvalId: entry.id,
          toolName: req.toolName,
          summary: redact(describeTool(req)),
          cwd: req.cwd,
          tabId: req.tabId,
        })
        .then((resp) => {
          this.approvals.resolve(entry.id, {
            v: HEARTH_PROTOCOL_VERSION,
            decision: resp.decision,
            remember: resp.remember,
          });
        })
        .catch((err) => {
          this.approvals.resolve(entry.id, {
            v: HEARTH_PROTOCOL_VERSION,
            decision: "deny",
            reason: err instanceof Error ? err.message : String(err),
          });
        });
    });
  }

  private async startSocket(): Promise<void> {
    const path = this.config.daemon.socketPath;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch (e) {
        this.log(`failed to remove stale socket: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Cache our euid once — every connection compares against this. Bun/Node
    // expose process.geteuid() on darwin+linux; fall back to process.getuid()
    // when euid is unavailable.
    const daemonEuid =
      typeof process.geteuid === "function"
        ? process.geteuid()
        : typeof process.getuid === "function"
          ? process.getuid()
          : -1;

    this.socketServer = createServer((sock) => {
      // Peer-auth check — reject any same-box process whose euid differs from
      // the daemon's. Belt-and-braces: the socket is already chmod 0600 so
      // only the owning uid can even open this connection, but this blocks
      // sandboxed same-uid shims (containers, dlopen, postinstall scripts).
      if (daemonEuid >= 0) {
        const peer = checkPeer(sock, daemonEuid);
        if (!peer.ok) {
          this.log(`socket rejected: ${peer.reason}`);
          try {
            sock.destroy();
          } catch {}
          return;
        }
      }
      attachFrameReader(sock, {
        onFrame: async (frame) => {
          try {
            const res = await this.handleFrame(frame);
            writeFrame(sock, res as never);
          } finally {
            try {
              sock.end();
            } catch {}
          }
        },
        onError: (err) => this.log(`socket error: ${err.message}`),
      });
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.socketServer;
      if (!server) {
        reject(new Error("socket server not initialised"));
        return;
      }
      server.once("error", reject);
      server.listen(path, () => {
        try {
          chmodSync(path, 0o600);
        } catch (e) {
          this.log(`failed to chmod socket: ${e instanceof Error ? e.message : String(e)}`);
        }
        resolve();
      });
    });
    this.log(`socket listening: ${path}`);
  }

  private async handleFrame(req: SocketRequest): Promise<unknown> {
    switch (req.op) {
      case "approve": {
        const decision = await this.routeApproval(req);
        return decision;
      }
      case "deny-read": {
        // Real match is handled by the CLI's builtin list; daemon only consults per-chat extras.
        return {
          v: HEARTH_PROTOCOL_VERSION,
          decision: "allow",
        };
      }
      case "health": {
        const liveOwner = readBridgeOwner();
        const tuiActive = liveOwner && liveOwner !== process.pid ? liveOwner : null;
        const surfaceOwner: "daemon" | "tui" | "unknown" = tuiActive
          ? "tui"
          : this.surfacesUp
            ? "daemon"
            : "unknown";
        return {
          v: HEARTH_PROTOCOL_VERSION,
          ok: true,
          surfaces: this.host.listSurfaces().map((s) => ({
            id: s.id,
            connected: s.isConnected(),
            chats: this.workspaces.list().filter((w) => w.binding.surfaceId === s.id).length,
          })),
          pendingApprovals: this.approvals.count(),
          uptime: Date.now() - this.startedAt,
          stats: this.getStats(),
          surfaceOwner,
          ...(tuiActive ? { surfaceOwnerPid: tuiActive } : {}),
        };
      }
      case "pair": {
        // Socket pair op — attemptKey is the socket caller's pid proxy, which
        // we don't have here; use a fixed key so CLI-path brute force still
        // counts. Rate-limit only triggers after 5 bad codes, CLI users have
        // the code at hand so this is defense-in-depth.
        const attemptKey = `socket:${req.surfaceId}`;
        if (this.pairings.isLocked(req.surfaceId, attemptKey)) {
          return {
            v: HEARTH_PROTOCOL_VERSION,
            ok: false,
            error: "locked out: too many bad attempts",
          };
        }
        const entry = this.pairings.consume(req.surfaceId, req.code, attemptKey);
        if (!entry) {
          return { v: HEARTH_PROTOCOL_VERSION, ok: false, error: "invalid or expired code" };
        }
        const updated = upsertChatBinding(this.config, entry.surfaceId, entry.externalId, {
          caps: this.config.defaults.caps,
          maxTabs: this.config.defaults.maxTabs,
        });
        this.config = updated;
        writeGlobalHearthConfig(updated);
        return { v: HEARTH_PROTOCOL_VERSION, ok: true, externalId: entry.externalId };
      }
      case "reload": {
        return this.reload();
      }
      case "issue-code": {
        if (!this.host.getSurface(req.surfaceId)) {
          return {
            v: HEARTH_PROTOCOL_VERSION,
            ok: false,
            error: `surface not registered: ${req.surfaceId}`,
          };
        }
        // Use a placeholder externalId when the TUI doesn't know which chat
        // will redeem — the daemon stamps the real chat id on /pair redemption.
        const externalId = req.externalId ?? `__pending_${Date.now().toString(36)}`;
        const entry = this.pairings.issue(req.surfaceId, externalId);
        this.stats.pairingsIssued++;
        return {
          v: HEARTH_PROTOCOL_VERSION,
          ok: true,
          code: entry.code,
          expiresAt: entry.expiresAt,
        };
      }
      case "list-workspaces": {
        const all = this.workspaces.list();
        const filtered = req.cwd ? all.filter((w) => w.binding.cwd === req.cwd) : all;
        const snapshots: RemoteWorkspaceSnapshot[] = filtered.map((w) => ({
          surfaceId: w.binding.surfaceId,
          externalId: w.binding.externalId,
          cwd: w.binding.cwd,
          sessionId: w.getSessionId(),
          activeTabId: w.getActiveTabId(),
          tabs: w.listTabs().map((t) => ({ id: t.id, label: t.label })),
        }));
        return {
          v: HEARTH_PROTOCOL_VERSION,
          ok: true,
          workspaces: snapshots,
        };
      }
      case "claim-workspace": {
        const ws = this.workspaces.get(req.surfaceId, req.externalId);
        if (!ws) {
          return {
            v: HEARTH_PROTOCOL_VERSION,
            ok: false,
            error: "no live workspace for this chat",
          };
        }
        const snapshot: RemoteWorkspaceSnapshot = {
          surfaceId: ws.binding.surfaceId,
          externalId: ws.binding.externalId,
          cwd: ws.binding.cwd,
          sessionId: ws.getSessionId(),
          activeTabId: ws.getActiveTabId(),
          tabs: ws.listTabs().map((t) => ({ id: t.id, label: t.label })),
        };
        try {
          await ws.flush();
          await ws.close();
        } catch (err) {
          this.log(`claim flush failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.workspaces.delete(req.surfaceId, req.externalId);
        return {
          v: HEARTH_PROTOCOL_VERSION,
          ok: true,
          snapshot,
        };
      }
      case "bridge-notify": {
        // Serialize with the reconcile loop so we never run two transitions
        // at once (prevents double polling on handoff).
        while (this.transitioning) {
          await new Promise<void>((r) => setTimeout(r, 50));
        }
        this.transitioning = true;
        try {
          if (req.state === "acquired") {
            this.tuiOwnerPid = req.pid;
            this.pendingTransition = null;
            await this.releaseSurfaces({ persist: true });
            this.log(`bridge-notify acquired by pid ${String(req.pid)} — surfaces released`);
          } else {
            this.tuiOwnerPid = null;
            this.pendingTransition = null;
            await this.acquireSurfaces();
            this.log(`bridge-notify released by pid ${String(req.pid)} — surfaces online`);
          }
        } finally {
          this.transitioning = false;
        }
        return {
          v: HEARTH_PROTOCOL_VERSION,
          ok: true,
          surfacesActive: this.host.listSurfaces().length,
        };
      }
      default:
        return { v: HEARTH_PROTOCOL_VERSION, ok: false, error: "unknown op" } as never;
    }
  }

  /**
   * Re-read config from disk and diff against the live surface registry.
   * Starts any newly-enabled surfaces, stops any that were removed or disabled.
   * In-flight chats / approvals on unaffected surfaces are untouched.
   */
  private async reload(): Promise<ReloadResponse> {
    const next = loadHearthConfig();
    this.config = next;
    const { started, stopped, errors } = await this.host.reload(next);
    for (const id of started) this.log(`surface ${id} online (reload)`);
    return {
      v: HEARTH_PROTOCOL_VERSION,
      ok: errors.length === 0,
      started,
      stopped,
      errors,
    };
  }

  private async routeApproval(req: PermissionRequest): Promise<PermissionResponse> {
    this.stats.approvalsHandled++;
    // Find the workspace that owns req.cwd — the hook doesn't know tabId/surface.
    const workspace = this.workspaces.list().find((w) => w.binding.cwd === req.cwd);
    const bumpCounters = (res: PermissionResponse): PermissionResponse => {
      if (res.decision === "allow") this.stats.approvalsAllowed++;
      else this.stats.approvalsDenied++;
      return res;
    };
    if (!workspace) {
      const decision = evaluatePolicy(req, null);
      if (decision.kind === "allow") {
        return bumpCounters({
          v: HEARTH_PROTOCOL_VERSION,
          decision: "allow",
          reason: decision.matched,
        });
      }
      if (decision.kind === "deny") {
        return bumpCounters({
          v: HEARTH_PROTOCOL_VERSION,
          decision: "deny",
          reason: decision.reason,
        });
      }
      return bumpCounters({
        v: HEARTH_PROTOCOL_VERSION,
        decision: "deny",
        reason: "no Hearth workspace bound to this cwd",
      });
    }
    const res = await this.requestApproval(
      workspace.binding.surfaceId,
      workspace.binding.externalId,
      req,
    );
    return bumpCounters(res);
  }

  private async handleInbound(surfaceId: SurfaceId, msg: InboundMessage): Promise<void> {
    const surface = this.host.getSurface(surfaceId);
    if (!surface) return;

    // Route built-in slash commands first
    if (msg.command) {
      await this.handleCommand(surfaceId, msg);
      return;
    }

    // When the TUI holds the bridge lock, it owns the surface adapters and
    // bridge routing in its own process — we never see inbound traffic at all.
    // If we do (defensively), and the TUI is the owner, drop silently.
    const tuiOwner = readBridgeOwner();
    if (msg.text && tuiOwner && tuiOwner !== process.pid) {
      this.log(
        `routing to TUI pid ${String(tuiOwner)} — skipping daemon workspace for ${surfaceId}/${msg.externalId}`,
      );
      return;
    }

    // Bridge path (same-process): if a workspace was claimed from this daemon
    // into our own tabs (rare — dev+test), honor it. The TUI-in-another-proc
    // case is handled above.
    if (
      (msg.text || (msg.images && msg.images.length > 0)) &&
      hearthBridge.getBinding(surfaceId, msg.externalId)
    ) {
      this.stats.messagesIn++;
      const originKind = surface.kind === "fakechat" ? "fakechat" : surface.kind;
      const handled = hearthBridge.handleInbound(
        {
          surfaceId,
          externalId: msg.externalId,
          text: msg.text ?? "",
          images: msg.images,
        },
        originKind as "telegram" | "discord" | "fakechat",
      );
      if (handled) return;
    }

    const workspace = await this.ensureWorkspace(surfaceId, msg.externalId);
    if (!workspace) {
      await surface.notify(
        msg.externalId,
        "This chat is not paired. Run `/pair` on a trusted device.",
      );
      return;
    }

    if (!msg.text) return;
    this.stats.messagesIn++;
    workspace.sendPrompt(msg.text);
  }

  private pendingWorkspaces = new Map<string, Promise<ChatWorkspace | null>>();

  private async ensureWorkspace(
    surfaceId: SurfaceId,
    externalId: string,
  ): Promise<ChatWorkspace | null> {
    const existing = this.workspaces.get(surfaceId, externalId);
    if (existing) return existing;
    // Deduplicate concurrent ensureWorkspace calls so a flood of inbound messages
    // for an unbound chat doesn't race multiple TabLoop creations past maxTabs.
    const key = `${surfaceId}\u0000${externalId}`;
    const inflight = this.pendingWorkspaces.get(key);
    if (inflight) return inflight;

    const promise = (async () => {
      const binding = resolveChatBinding(this.config, surfaceId, externalId);
      if (!binding) return null;
      const surface = this.host.getSurface(surfaceId);
      if (!surface) return null;
      const ws = new ChatWorkspace({
        surface,
        binding,
        hearthConfig: this.config,
        log: (line) => this.log(line),
        onTabEvent: (ev) => this.recordTabEvent(ev),
      });
      this.workspaces.set(surfaceId, externalId, ws);
      this.stats.workspacesEver++;
      await ws.openTab(binding.label ?? "TAB-1");
      this.stats.tabsOpened++;
      return ws;
    })().finally(() => {
      this.pendingWorkspaces.delete(key);
    });

    this.pendingWorkspaces.set(key, promise);
    return promise;
  }

  private async handleCommand(surfaceId: SurfaceId, msg: InboundMessage): Promise<void> {
    const cmd = msg.command;
    if (!cmd) return;
    const surface = this.host.getSurface(surfaceId);
    if (!surface) return;
    const ws = this.workspaces.get(surfaceId, msg.externalId);
    const hasBridge = hearthBridge.getBinding(surfaceId, msg.externalId) !== null;

    // Bridge mode: a TUI tab is bound to this chat. /tab, /tabs, /stop,
    // /mute and /unmute route through the bridge. /pair, /new, /close still
    // manage daemon-side state if someone wants it.
    if (hasBridge) {
      switch (cmd.name) {
        case "/tabs":
        case "/list": {
          const tabs = hearthBridge.listTabs();
          const active = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (tabs.length === 0) {
            await surface.notify(msg.externalId, "No tabs registered in the TUI.");
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
          if (!target) {
            const tabs = hearthBridge.listTabs();
            const active = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
            const body = tabs
              .map((t, i) => `${String(i + 1)}. ${t.label}${t.id === active ? " (active)" : ""}`)
              .join("\n");
            await surface.notify(msg.externalId, body || "(no tabs)");
            return;
          }
          const idx = Number.parseInt(target, 10);
          const tabs = hearthBridge.listTabs();
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
          const next = hearthBridge.switchActiveTab(surfaceId, msg.externalId, picked.id);
          if (!next) {
            await surface.notify(msg.externalId, "Tab no longer registered.");
            return;
          }
          await surface.notify(msg.externalId, `Active tab: ${picked.label}`);
          // /tab N <prompt> one-shot: any extra words are sent as a prompt to
          // the newly-active tab. Matches TuiHost behaviour.
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
            state === null ? "No binding." : "Muted — output hidden until /unmute.",
          );
          return;
        }
        case "/unmute": {
          const state = hearthBridge.setMuted(surfaceId, msg.externalId, false);
          await surface.notify(
            msg.externalId,
            state === null ? "No binding." : "Unmuted — output resumed.",
          );
          return;
        }
        case "/status": {
          const binding = hearthBridge.getBinding(surfaceId, msg.externalId);
          const activeId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!binding || !activeId) {
            await surface.notify(msg.externalId, "Not bound.");
            return;
          }
          const snap = hearthBridge.getTabStatus(activeId);
          if (!snap) {
            await surface.notify(msg.externalId, `Active tab: ${binding.tabLabel ?? activeId}`);
            return;
          }
          await surface.notify(
            msg.externalId,
            [
              `▸ ${snap.label}`,
              `model: ${snap.activeModel || "(default)"}`,
              `mode: ${snap.forgeMode}`,
              `state: ${snap.isLoading ? "running" : "idle"}`,
              `messages: ${String(snap.messageCount)}`,
              `tokens: in ${String(snap.tokenUsage.input)} · out ${String(snap.tokenUsage.output)}`,
              binding.muted ? "muted: yes" : "muted: no",
            ].join("\n"),
          );
          return;
        }
        case "/model": {
          const tabId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!tabId) {
            await surface.notify(msg.externalId, "No bound tab.");
            return;
          }
          const target = cmd.args.join(" ").trim();
          if (!target) {
            const snap = hearthBridge.getTabStatus(tabId);
            await surface.notify(msg.externalId, `model: ${snap?.activeModel || "(default)"}`);
            return;
          }
          const ok = hearthBridge.setActiveModelFor(tabId, target);
          await surface.notify(msg.externalId, ok ? `model \u2192 ${target}` : "Could not set.");
          return;
        }
        case "/mode": {
          const tabId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!tabId) {
            await surface.notify(msg.externalId, "No bound tab.");
            return;
          }
          const target = cmd.args[0];
          if (!target) {
            const snap = hearthBridge.getTabStatus(tabId);
            await surface.notify(msg.externalId, `mode: ${snap?.forgeMode ?? "(unknown)"}`);
            return;
          }
          const ok = hearthBridge.setForgeModeFor(tabId, target);
          await surface.notify(msg.externalId, ok ? `mode \u2192 ${target}` : "Invalid mode.");
          return;
        }
        case "/clear": {
          const tabId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!tabId) {
            await surface.notify(msg.externalId, "No bound tab.");
            return;
          }
          const ok = hearthBridge.clearTab(tabId);
          await surface.notify(msg.externalId, ok ? "Tab cleared." : "Cannot clear.");
          return;
        }
        case "/cost": {
          const tabId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!tabId) {
            await surface.notify(msg.externalId, "No bound tab.");
            return;
          }
          const cost = hearthBridge.getCost(tabId);
          if (!cost) {
            await surface.notify(msg.externalId, "No cost data.");
            return;
          }
          const lines = [
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
          const tabId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!tabId) {
            await surface.notify(msg.externalId, "No bound tab.");
            return;
          }
          const extra = cmd.args.join(" ").trim();
          if (extra) {
            hearthBridge.appendQueue(tabId, extra);
            await surface.notify(msg.externalId, "Queued.");
            return;
          }
          const q = hearthBridge.getQueue(tabId);
          await surface.notify(
            msg.externalId,
            q.length === 0 ? "(queue empty)" : q.map((s, i) => `${String(i + 1)}. ${s}`).join("\n"),
          );
          return;
        }
        case "/diff": {
          const tabId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!tabId) {
            await surface.notify(msg.externalId, "No bound tab.");
            return;
          }
          await surface.notify(msg.externalId, hearthBridge.getDiff(tabId) || "(no edits)");
          return;
        }
        case "/files": {
          const tabId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!tabId) {
            await surface.notify(msg.externalId, "No bound tab.");
            return;
          }
          await surface.notify(msg.externalId, hearthBridge.getFiles(tabId) || "(clean)");
          return;
        }
        case "/cwd": {
          const tabId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!tabId) {
            await surface.notify(msg.externalId, "No bound tab.");
            return;
          }
          await surface.notify(msg.externalId, hearthBridge.getCwd(tabId) || "(unknown)");
          return;
        }
        case "/sessions": {
          const list = hearthBridge.listSessions(10);
          if (list.length === 0) {
            await surface.notify(msg.externalId, "(no sessions)");
            return;
          }
          await surface.notify(
            msg.externalId,
            list
              .map((s, i) => {
                const dt = new Date(s.updatedAt).toISOString().slice(0, 16).replace("T", " ");
                return `${String(i + 1).padStart(2)}. ${s.id.slice(0, 8)} \u00b7 ${dt} \u00b7 ${s.title.slice(0, 40)}`;
              })
              .join("\n"),
          );
          return;
        }
        case "/resume": {
          const prefix = cmd.args[0];
          if (!prefix) {
            await surface.notify(msg.externalId, "Usage: /resume <id-prefix>");
            return;
          }
          const res = hearthBridge.resumeSession(prefix);
          await surface.notify(msg.externalId, res.ok ? `Resumed.` : (res.error ?? "fail"));
          return;
        }
        case "/checkpoint": {
          const tabId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!tabId) {
            await surface.notify(msg.externalId, "No bound tab.");
            return;
          }
          const list = hearthBridge.listCheckpoints(tabId);
          await surface.notify(
            msg.externalId,
            list.length === 0
              ? "(no checkpoints)"
              : list
                  .map(
                    (c) =>
                      `#${String(c.index).padStart(3)} \u00b7 ${new Date(c.ts).toISOString().slice(0, 16).replace("T", " ")} \u00b7 ${c.label}`,
                  )
                  .join("\n"),
          );
          return;
        }
        case "/undo": {
          const tabId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!tabId) {
            await surface.notify(msg.externalId, "No bound tab.");
            return;
          }
          const idx = cmd.args[0] ? Number.parseInt(cmd.args[0], 10) : undefined;
          const res = hearthBridge.undoCheckpoint(tabId, idx);
          await surface.notify(
            msg.externalId,
            res.ok ? `Restored to #${String(res.restoredTo ?? "?")}.` : (res.error ?? "fail"),
          );
          return;
        }
        case "/agents": {
          const tabId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!tabId) {
            await surface.notify(msg.externalId, "No bound tab.");
            return;
          }
          const list = hearthBridge.listAgents(tabId);
          await surface.notify(
            msg.externalId,
            list.length === 0
              ? "(no active agents)"
              : list
                  .map(
                    (a) => `${a.id.slice(0, 8)} \u00b7 ${a.status} \u00b7 ${a.task.slice(0, 60)}`,
                  )
                  .join("\n"),
          );
          return;
        }
        case "/cancel": {
          const tabId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!tabId) {
            await surface.notify(msg.externalId, "No bound tab.");
            return;
          }
          const id = cmd.args[0];
          if (!id) {
            await surface.notify(msg.externalId, "Usage: /cancel <agent-id>");
            return;
          }
          const ok = hearthBridge.cancelAgent(tabId, id);
          await surface.notify(msg.externalId, ok ? "Cancelled." : "Not found.");
          return;
        }
        case "/mcp": {
          const sub = cmd.args[0];
          if (!sub || sub === "list") {
            const list = hearthBridge.listMcp();
            await surface.notify(
              msg.externalId,
              list.length === 0
                ? "(no MCP servers)"
                : list
                    .map(
                      (m) => `${m.enabled ? "\u25cf" : "\u25cb"} ${m.name.padEnd(20)} ${m.status}`,
                    )
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
          const tabId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!tabId) {
            await surface.notify(msg.externalId, "No bound tab.");
            return;
          }
          const q = cmd.args.join(" ").trim();
          if (!q) {
            await surface.notify(msg.externalId, "Usage: /find <query>");
            return;
          }
          const hits = hearthBridge.findInTab(tabId, q, 10);
          await surface.notify(
            msg.externalId,
            hits.length === 0 ? "(no matches)" : hits.map((h) => `\u2022 ${h.snippet}`).join("\n"),
          );
          return;
        }
        case "/branch": {
          const tabId = hearthBridge.getActiveTabId(surfaceId, msg.externalId);
          if (!tabId) {
            await surface.notify(msg.externalId, "No bound tab.");
            return;
          }
          const label = cmd.args.join(" ").trim() || undefined;
          const res = hearthBridge.branchTab(tabId, label);
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
              "/branch [label]        fork current tab",
              "",
              "\u2501\u2501 Chat \u2501\u2501",
              "/model [name]          show or set model",
              "/mode [name]           show or set forge mode",
              "/clear                 wipe current tab's history",
              "/stop                  abort current turn",
              "/say <n> <text>        send text to another tab",
              "/queue [text]          show or append queue",
              "",
              "\u2501\u2501 State \u2501\u2501",
              "/status                snapshot",
              "/cost                  token usage",
              "/diff                  files edited",
              "/files                 working-copy changes",
              "/cwd                   working directory",
              "/find <q>              grep messages",
              "",
              "\u2501\u2501 History \u2501\u2501",
              "/sessions              list recent sessions",
              "/resume <prefix>       resume",
              "/checkpoint            list checkpoints",
              "/undo [n]              revert",
              "",
              "\u2501\u2501 Agents / MCP \u2501\u2501",
              "/agents                active dispatched agents",
              "/cancel <id>           cancel an agent",
              "/mcp [list|toggle <n>] MCP server ops",
              "",
              "\u2501\u2501 Notifications \u2501\u2501",
              "/notify on|off|errors  outbound filter",
              "/mute, /unmute         legacy",
              "",
              "\u2501\u2501 Pairing \u2501\u2501",
              "/pair [CODE]           pair this chat",
              "/unpair                revoke",
              "/help                  this list",
            ].join("\n"),
          );
          return;
        }
      }
      // Fall through to workspace commands only for /pair etc.
    }

    switch (cmd.name) {
      case "/pair": {
        const arg = cmd.args[0]?.trim().toUpperCase();

        // /pair <CODE> — redeem a code minted on the trusted side (TUI / CLI).
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
              `✗ Invalid or expired code: ${arg}. Mint a fresh one with /pair.`,
            );
            return;
          }
          // The CLI/TUI path mints codes without knowing the externalId — we
          // stamp this chat's id as the binding target on redemption so the
          // pairing actually maps back to the sender.
          const updated = upsertChatBinding(this.config, surfaceId, msg.externalId, {
            caps: this.config.defaults.caps,
            maxTabs: this.config.defaults.maxTabs,
          });
          this.config = updated;
          writeGlobalHearthConfig(updated);
          await surface.notify(msg.externalId, `✓ Paired ${surfaceId} · ${msg.externalId}`);
          return;
        }

        // /pair (no arg) — already-paired short-circuit so we don't mint
        // redundant codes for a chat that's already bound.
        const existingBinding = resolveChatBinding(this.config, surfaceId, msg.externalId);
        if (existingBinding) {
          await surface.notify(
            msg.externalId,
            "✓ This chat is already paired. Send a message to start a turn, or /help for commands.",
          );
          return;
        }

        // /pair (no arg, unpaired) — mint + send a code. sendPairingPromptImpl
        // already emits the full "Pairing code: …\nRun locally: …" message —
        // no second notify() needed (was double-posting).
        await this.sendPairingPromptForExternal(surfaceId, msg.externalId);
        return;
      }
      case "/new": {
        if (!ws) {
          await surface.notify(msg.externalId, "No workspace bound. Run `/pair`.");
          return;
        }
        const tabId = await ws.openTab(cmd.args.join(" ").trim() || undefined);
        await surface.notify(msg.externalId, `Opened tab ${tabId.slice(0, 8)}.`);
        return;
      }
      case "/tabs":
      case "/list": {
        if (!ws) {
          await surface.notify(msg.externalId, "No workspace bound. Run `/pair`.");
          return;
        }
        const active = ws.getActiveTabId();
        const body = ws
          .listTabs()
          .map(
            (t, i) =>
              `${String(i + 1)}. ${t.label} (${t.id.slice(0, 8)})${
                t.id === active ? " (active)" : ""
              }`,
          )
          .join("\n");
        await surface.notify(msg.externalId, body || "(no tabs)");
        return;
      }
      case "/tab": {
        if (!ws) return;
        const target = cmd.args[0];
        if (!target) {
          const list = ws
            .listTabs()
            .map((t, i) => `${String(i + 1)}. ${t.label} (${t.id.slice(0, 8)})`)
            .join("\n");
          await surface.notify(msg.externalId, list || "(no tabs)");
          return;
        }
        const tabs = ws.listTabs();
        const idx = Number.parseInt(target, 10);
        let tab =
          !Number.isNaN(idx) && idx >= 1 && idx <= tabs.length ? (tabs[idx - 1] ?? null) : null;
        if (!tab) {
          tab = tabs.find((t) => t.id.startsWith(target) || t.label === target) ?? null;
        }
        if (!tab) {
          await surface.notify(msg.externalId, `No tab matching "${target}"`);
          return;
        }
        ws.setActiveTab(tab.id);
        await surface.notify(msg.externalId, `Active tab: ${tab.label}`);
        // /tab N <prompt> one-shot — send the rest as a prompt to the switched tab.
        const extra = cmd.args.slice(1).join(" ").trim();
        if (extra) ws.sendPrompt(extra, tab.id);
        return;
      }
      case "/stop": {
        if (!ws) return;
        ws.abortActiveTurn();
        await surface.notify(msg.externalId, "Aborting current turn.");
        return;
      }
      case "/close": {
        if (!ws) return;
        const target = cmd.args[0] ?? ws.getActiveTabId();
        if (!target) return;
        const ok = await ws.closeTab(target);
        await surface.notify(msg.externalId, ok ? `Closed ${target.slice(0, 8)}` : "No such tab.");
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
        if (ws) {
          await ws.close();
          this.workspaces.delete(surfaceId, msg.externalId);
        }
        await surface.notify(msg.externalId, "✓ Unpaired. Run /pair to bind again.");
        return;
      }
      case "/help": {
        await surface.notify(
          msg.externalId,
          [
            "Commands:",
            "/pair [CODE]      pair this chat · redeem a CODE",
            "/unpair           revoke pairing",
            "/tabs             list tabs",
            "/tab <n> [..]     switch tab; extra words sent as prompt",
            "/new [label]      open a new tab",
            "/close [n]        close a tab (default: active)",
            "/stop             abort current turn",
            "/help             this list",
          ].join("\n"),
        );
        return;
      }
      default:
        await surface.notify(msg.externalId, "Unknown command. Try /help.");
    }
  }

  private restoreWorkspaces(): void {
    const stateFile = this.config.daemon.stateFile;
    if (!existsSync(stateFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(stateFile, "utf-8")) as HearthPersistedState;
      for (const entry of parsed.workspaces ?? []) {
        const surface = this.host.getSurface(entry.surfaceId);
        const binding = resolveChatBinding(this.config, entry.surfaceId, entry.externalId);
        if (!surface || !binding) continue;
        const ws = new ChatWorkspace({
          surface,
          binding,
          hearthConfig: this.config,
          log: (line) => this.log(line),
          onTabEvent: (ev) => this.recordTabEvent(ev),
        });
        this.workspaces.set(entry.surfaceId, entry.externalId, ws);
        this.stats.workspacesEver++;
        void ws.openTab(binding.label ?? "TAB-1").then(() => {
          this.stats.tabsOpened++;
        });
      }
    } catch (err) {
      this.log(`restore failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async persistState(): Promise<void> {
    try {
      const state: HearthPersistedState = {
        version: 1,
        workspaces: this.workspaces.list().map((ws) => ({
          surfaceId: ws.binding.surfaceId,
          externalId: ws.binding.externalId,
          cwd: ws.binding.cwd,
          lastSessionId: ws.getSessionId(),
          activeTabId: ws.getActiveTabId() ?? undefined,
        })),
      };
      mkdirSync(dirname(this.config.daemon.stateFile), { recursive: true, mode: 0o700 });
      writeFileSync(this.config.daemon.stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch (err) {
      this.log(`persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private log(line: string): void {
    this.logFn(redact(`[hearth] ${line}`));
  }
}

function createFileLogger(logPath: string | undefined): (line: string) => void {
  if (!logPath) return () => {};
  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {}
  return (line: string) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch {}
  };
}

export async function startHearth(opts: HearthDaemonOptions = {}): Promise<HearthDaemon> {
  const daemon = new HearthDaemon(opts);
  await daemon.start();
  return daemon;
}
