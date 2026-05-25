/**
 * Telegram surface — zero-dep long-poll bot.
 *
 * Uses Telegram's Bot API (HTTPS) via global fetch. No third-party library —
 * keeps the attack surface narrow and means we control update parsing,
 * callback-query round-tripping, and Markdown escape semantics ourselves.
 *
 * Security:
 *   - Identity allowlist: numeric `from.id`, NEVER usernames.
 *   - Unknown senders are silently dropped (existence non-disclosure).
 *   - Bot token lives in the keychain — we read it via getSecret.
 *   - All outbound strings pass through `redact()` (BaseSurface handles this).
 *
 * Pairing:
 *   - `/pair` DM issues a 6-char code via surface.notify
 *   - User runs `soulforge-remote pair telegram:<botId> <code>` locally
 *
 * Approvals render as inline keyboards with Approve / Deny buttons.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../../core/platform/index.js";
import { getSecret } from "../../core/secrets.js";
import type { HeadlessEvent } from "../../headless/types.js";
import { redact } from "../redact.js";
import type {
  ApprovalUI,
  ExternalChatId,
  InboundMessage,
  PermissionDecision,
  SurfaceId,
  SurfaceRenderInput,
} from "../types.js";
import { BaseSurface, parseCommand } from "./base.js";
import { TextRenderer } from "./render-text.js";

export interface TelegramSurfaceOptions {
  /** Fixed portion of the SurfaceId after "telegram:" (usually the bot id). */
  botId: string;
  /** Allowed Telegram user ids (from `message.from.id`) for each chat. */
  allowedUserIdsByChat?: Record<string, number[]>;
  /** Polling timeout in seconds (Telegram supports up to 50). */
  longPollTimeoutSec?: number;
  log?: (line: string) => void;
  /** Override for tests — inject a fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Override keychain for tests. */
  readToken?: () => Promise<string | null>;
}

interface TGUpdate {
  update_id: number;
  message?: TGMessage;
  edited_message?: TGMessage;
  channel_post?: TGMessage;
  callback_query?: TGCallbackQuery;
}

interface TGMessage {
  message_id: number;
  from?: { id: number; is_bot?: boolean; username?: string };
  sender_chat?: { id: number; type: string };
  chat: { id: number; type: string };
  text?: string;
  date: number;
  caption?: string;
  forward_origin?: {
    type: "user" | "hidden_user" | "chat" | "channel";
    sender_user?: { id: number };
    sender_chat?: { id: number };
    chat?: { id: number };
  };
  via_bot?: { id: number; username?: string };
  photo?: Array<{
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    width?: number;
    height?: number;
  }>;
  document?: {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
}

interface TGCallbackQuery {
  id: string;
  from: { id: number; username?: string };
  message?: TGMessage;
  data?: string;
}

interface PendingApprovalEntry {
  resolve: (r: { decision: PermissionDecision; remember?: "once" | "session" | "always" }) => void;
  externalId: ExternalChatId;
  ui: ApprovalUI;
}

export class TelegramSurface extends BaseSurface {
  private token: string | null = null;
  private polling = false;
  private offset = 0;
  private botId: string;
  private allowedUserIdsByChat: Record<string, number[]>;
  private longPollTimeoutSec: number;
  private renderers = new Map<string, TextRenderer>();
  private useHtml = true;
  private pendingApprovals = new Map<string, PendingApprovalEntry>();
  /** Last remote-callback id emitted per chat (ask-user / plan-review / approval).
   *  Persisted to disk so a TUI restart doesn't orphan a pending callback. */
  private lastCallbackByChat = new Map<
    string,
    { callbackId: string; options?: { label: string; value: string }[] }
  >();
  /** Per-chat outbound throttle — enforces 1 msg/sec soft cap. */
  private lastSendAt = new Map<ExternalChatId, number>();
  private fetchImpl: typeof fetch;
  private readToken: () => Promise<string | null>;
  private stopRequested = false;

  constructor(opts: TelegramSurfaceOptions) {
    super(`telegram:${opts.botId}` as SurfaceId, "telegram", opts.log);
    this.botId = opts.botId;
    this.allowedUserIdsByChat = opts.allowedUserIdsByChat ?? {};
    this.longPollTimeoutSec = opts.longPollTimeoutSec ?? 25;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.readToken =
      opts.readToken ??
      (async () => getSecret(`telegram.bot.${this.botId}`) ?? getSecret("telegram.bot.default"));
    this.loadCallbackState();
  }

  // ── lastCallbackByChat persistence (~/.soulforge/hearth-callbacks.json) ──

  private callbackStatePath(): string {
    return join(configDir(), `hearth-callbacks-${this.botId}.json`);
  }

  private loadCallbackState(): void {
    const path = this.callbackStatePath();
    if (!existsSync(path)) return;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as Record<
        string,
        { callbackId: string; options?: { label: string; value: string }[] }
      >;
      for (const [chatId, entry] of Object.entries(parsed)) {
        this.lastCallbackByChat.set(chatId, entry);
      }
    } catch {
      // corrupt state — ignore.
    }
  }

  private persistCallbackState(): void {
    try {
      const path = this.callbackStatePath();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const obj: Record<string, unknown> = {};
      for (const [k, v] of this.lastCallbackByChat) obj[k] = v;
      writeFileSync(path, JSON.stringify(obj), { mode: 0o600 });
    } catch {
      // non-fatal.
    }
  }

  /** Access to the per-chat renderer used by the bridge. */
  getRendererFor(externalId: ExternalChatId): TextRenderer {
    return this.getRenderer(externalId);
  }

  /** Public send used by the bridge when forwarding rendered lines. */
  async sendTextTo(chatId: ExternalChatId, text: string): Promise<void> {
    return this.sendText(chatId, text);
  }

  private apiUrl(method: string): string {
    if (!this.token) throw new Error("telegram token not loaded");
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  protected async connect(): Promise<void> {
    const token = await this.readToken();
    if (!token) throw new Error("telegram bot token missing — set telegram.bot.<botId>");
    this.token = token;
    this.stopRequested = false;
    // If a webhook was previously set on this bot, getUpdates fails with 409
    // forever. Clear any webhook before polling. Idempotent when unset.
    void this.clearWebhookIfSet();
    void this.pollLoop();
  }

  /** Defensive deleteWebhook — no-op if no webhook is configured. */
  private async clearWebhookIfSet(): Promise<void> {
    if (!this.token) return;
    try {
      await this.fetchImpl(this.apiUrl("deleteWebhook"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ drop_pending_updates: false }),
      });
    } catch {
      // Non-fatal — if a webhook remains, the 409 loop self-logs.
    }
  }

  protected async disconnect(): Promise<void> {
    this.stopRequested = true;
    // Resolve pending approvals as deny so callers unblock
    for (const entry of this.pendingApprovals.values()) entry.resolve({ decision: "deny" });
    this.pendingApprovals.clear();
    this.renderers.clear();
    // Drop the cached token so a subsequent start() re-reads from keychain
    this.token = null;
    this.offset = 0;
  }

  private async pollLoop(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    // 409 Conflict = another getUpdates poller owns this bot. Back off
    // exponentially and log once per escalation instead of spamming a line
    // every cycle. Self-heals when the competing process exits.
    let conflictStreak = 0;
    try {
      while (!this.stopRequested) {
        try {
          const url = new URL(this.apiUrl("getUpdates"));
          url.searchParams.set("timeout", String(this.longPollTimeoutSec));
          url.searchParams.set("offset", String(this.offset));
          url.searchParams.set("allowed_updates", JSON.stringify(["message", "callback_query"]));
          const resp = await this.fetchImpl(url.toString());
          if (resp.status === 409) {
            // Exponential backoff up to 30s. Log only on streak milestones
            // (1, 2, 5, 10, 20 …) so the transcript doesn't drown.
            conflictStreak++;
            const backoffMs = Math.min(30_000, 2_000 * 2 ** Math.min(4, conflictStreak - 1));
            if ([1, 2, 5, 10, 20, 50].includes(conflictStreak)) {
              this.log(
                redact(
                  `tg getUpdates 409 conflict (streak ${String(conflictStreak)}) — another poller owns bot, backing off ${String(backoffMs)}ms`,
                ),
              );
            }
            await sleep(backoffMs);
            continue;
          }
          if (resp.status === 429) {
            // Honor Retry-After — ignoring it triggers bans. Prefer the
            // response body's parameters.retry_after (seconds), fall back
            // to Retry-After header, then a 5s default.
            let retryAfter = 5;
            try {
              const body = (await resp.json()) as {
                parameters?: { retry_after?: number };
              };
              retryAfter = body.parameters?.retry_after ?? retryAfter;
            } catch {
              const hdr = resp.headers.get("retry-after");
              if (hdr) retryAfter = Number.parseInt(hdr, 10) || retryAfter;
            }
            this.log(redact(`tg getUpdates 429 — retry after ${String(retryAfter)}s`));
            await sleep(retryAfter * 1000);
            continue;
          }
          if (!resp.ok) {
            if (conflictStreak > 0) {
              this.log(redact(`tg getUpdates recovered after ${String(conflictStreak)} conflicts`));
              conflictStreak = 0;
            }
            this.log(redact(`tg getUpdates HTTP ${String(resp.status)}`));
            await sleep(2000);
            continue;
          }
          if (conflictStreak > 0) {
            this.log(redact(`tg getUpdates recovered after ${String(conflictStreak)} conflicts`));
            conflictStreak = 0;
          }
          const body = (await resp.json()) as { ok: boolean; result?: TGUpdate[] };
          if (!body.ok || !Array.isArray(body.result)) {
            await sleep(1000);
            continue;
          }
          for (const update of body.result) {
            this.offset = Math.max(this.offset, update.update_id + 1);
            this.handleUpdate(update);
          }
        } catch (err) {
          this.log(redact(`tg poll error: ${err instanceof Error ? err.message : String(err)}`));
          await sleep(3000);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private handleUpdate(update: TGUpdate): void {
    if (update.callback_query) {
      this.handleCallback(update.callback_query);
      return;
    }
    // Drop edited_message and channel_post — we only accept fresh direct
    // messages. An edited update carries a new update_id but the same logical
    // content; replaying it could double-submit a prompt.
    if (update.edited_message || update.channel_post) return;
    const msg = update.message;
    if (!msg?.from) return;

    // Identity allowlist — numeric id only. Default-deny: unknown chat,
    // empty list, or sender-not-listed all drop silently. Prior form
    // (`allowed.length > 0 && !allowed.includes(...)`) fell OPEN on any
    // chat that wasn't explicitly configured.
    const senderId = String(msg.from.id);
    const chatId = String(msg.chat.id);
    const allowed = this.allowedUserIdsByChat[chatId];
    if (!allowed?.includes(msg.from.id)) {
      // Silent drop — no reply. Never disclose the bot's presence to strangers.
      return;
    }
    // Spoof detection — drop forwarded / bot-proxied / anonymous-admin
    // messages. A legitimate user-at-keyboard doesn't set any of these.
    if (msg.forward_origin) {
      this.log(
        redact(`tg dropped forwarded msg from ${senderId} origin=${msg.forward_origin.type}`),
      );
      return;
    }
    if (msg.via_bot) {
      this.log(redact(`tg dropped via_bot msg from ${senderId} via=${String(msg.via_bot.id)}`));
      return;
    }
    if (msg.sender_chat) {
      this.log(redact(`tg dropped sender_chat msg from ${senderId}`));
      return;
    }
    // Replay guard — messages older than 60s are likely stale (Telegram clock
    // is NTP-synced; legitimate updates arrive within seconds).
    if (msg.date * 1000 < Date.now() - 60_000) {
      this.log(redact(`tg dropped stale msg from ${senderId} age>60s`));
      return;
    }

    // Attachment support: photos + documents. Both carry an optional caption
    // which we treat as the inbound text. If neither is present, fall through
    // to the text-only path.
    const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
    const hasDocument = !!msg.document;
    if (hasPhoto || hasDocument) {
      void this.handleAttachment(msg, senderId, chatId).catch((err) =>
        this.log(
          redact(`tg attachment error: ${err instanceof Error ? err.message : String(err)}`),
        ),
      );
      return;
    }

    if (!msg.text) return;
    const text = msg.text;

    // Remote-callback resolution — /ans <value> or a bare number matching the
    // last ask-user / plan-review / approval-request emitted in this chat.
    const lastCb = this.lastCallbackByChat.get(chatId);
    if (lastCb) {
      const trimmed = text.trim();
      const ansMatch = /^\/ans\s+(.+)$/i.exec(trimmed);
      if (ansMatch) {
        void import("../bridge.js").then(({ resolveRemoteCallback }) => {
          resolveRemoteCallback(lastCb.callbackId, ansMatch[1]);
        });
        this.lastCallbackByChat.delete(chatId);
        this.persistCallbackState();
        return;
      }
      const idx = Number.parseInt(trimmed, 10);
      if (!Number.isNaN(idx) && lastCb.options && idx >= 1 && idx <= lastCb.options.length) {
        const choice = lastCb.options[idx - 1];
        void import("../bridge.js").then(({ resolveRemoteCallback }) => {
          resolveRemoteCallback(lastCb.callbackId, choice?.value ?? "");
        });
        this.lastCallbackByChat.delete(chatId);
        this.persistCallbackState();
        return;
      }
    }

    const command = parseCommand(text);
    const inbound: InboundMessage = {
      externalId: chatId,
      senderId,
      text,
      command,
      platformTs: msg.date * 1000,
    };
    this.emitInbound(inbound);
  }

  private handleCallback(q: TGCallbackQuery): void {
    if (!q.data) return;
    // H3/H4 — enforce the same allowlist on callback_query as we do on
    // messages. Without this, a non-allowlisted user who discovers a
    // callback_id can tap Approve on our tool-use prompts.
    const chatIdForAllow = q.message ? String(q.message.chat.id) : null;
    if (!chatIdForAllow || q.from?.id == null) {
      this.sendAnswerCallback(q.id, "not authorised");
      return;
    }
    const allowed = this.allowedUserIdsByChat[chatIdForAllow];
    if (!allowed?.includes(q.from.id)) {
      this.sendAnswerCallback(q.id, "not authorised");
      return;
    }
    const parts = q.data.split(":");
    const kind = parts[0];
    // Legacy approval keyboards: apr:<approvalId>:a|d
    if (kind === "apr") {
      const approvalId = parts[1];
      const decisionRaw = parts[2];
      if (!approvalId || !decisionRaw) return;
      const entry = this.pendingApprovals.get(approvalId);
      if (!entry) {
        this.sendAnswerCallback(q.id, "expired");
        return;
      }
      this.pendingApprovals.delete(approvalId);
      const decision: PermissionDecision = decisionRaw === "a" ? "allow" : "deny";
      entry.resolve({ decision });
      this.sendAnswerCallback(q.id, decision === "allow" ? "approved" : "denied");
      return;
    }
    // Bridge remote callbacks: cb:<callbackId>:<value> — routes to askRemote.
    if (kind === "cb") {
      const callbackId = parts[1];
      const value = parts.slice(2).join(":");
      if (!callbackId) return;
      const chatId = q.message ? String(q.message.chat.id) : null;
      if (chatId) {
        this.lastCallbackByChat.delete(chatId);
        this.persistCallbackState();
      }
      void import("../bridge.js").then(({ resolveRemoteCallback }) => {
        const ok = resolveRemoteCallback(callbackId, value);
        this.sendAnswerCallback(q.id, ok ? "received" : "expired");
      });
      return;
    }
  }

  private sendAnswerCallback(callbackId: string, text: string): void {
    if (!this.token) return;
    const url = new URL(this.apiUrl("answerCallbackQuery"));
    url.searchParams.set("callback_query_id", callbackId);
    url.searchParams.set("text", text);
    void this.fetchImpl(url.toString()).catch(() => {});
  }

  private getRenderer(externalId: ExternalChatId): TextRenderer {
    let r = this.renderers.get(externalId);
    if (!r) {
      r = new TextRenderer({ format: this.useHtml ? "html" : "plain" });
      this.renderers.set(externalId, r);
    }
    return r;
  }

  protected async renderImpl(input: SurfaceRenderInput): Promise<void> {
    if (!this.token) return;
    const ev = input.event as HeadlessEvent;
    // Intercept remote-callback events — render as inline keyboard or text with
    // a clear "reply with /ans <value>" hint. Callback id is remembered per
    // chat so plain numeric replies can resolve it.
    if (ev.type === "ask-user") {
      this.lastCallbackByChat.set(input.externalId, {
        callbackId: ev.callbackId,
        options: [...ev.options],
      });
      this.persistCallbackState();
      // Inline keyboard — one button per option, callback_data encodes the
      // bridge callbackId + option value. Text reply fallbacks (number, /ans)
      // still resolve via lastCallbackByChat.
      const reply_markup = {
        inline_keyboard: chunkButtons(
          ev.options.map((opt) => ({
            text: opt.label,
            callback_data: `cb:${ev.callbackId}:${opt.value}`,
          })),
        ),
      };
      await this.postMethod("sendMessage", {
        chat_id: input.externalId,
        text: `❓ ${ev.question}`,
        reply_markup,
      });
      return;
    }
    if (ev.type === "plan-review") {
      const options = [
        { label: "✓ Approve", value: "execute" },
        { label: "✗ Cancel", value: "cancel" },
        { label: "✎ Edit", value: "edit" },
      ];
      this.lastCallbackByChat.set(input.externalId, {
        callbackId: ev.callbackId,
        options,
      });
      this.persistCallbackState();
      const reply_markup = {
        inline_keyboard: chunkButtons(
          options.map((opt) => ({
            text: opt.label,
            callback_data: `cb:${ev.callbackId}:${opt.value}`,
          })),
        ),
      };
      await this.postMethod("sendMessage", {
        chat_id: input.externalId,
        text: `📋 Plan: ${ev.title}\n${ev.summary}`,
        reply_markup,
      });
      return;
    }
    if (ev.type === "approval-request") {
      const options = [
        { label: "✓ Allow", value: "allow" },
        { label: "✗ Deny", value: "deny" },
      ];
      this.lastCallbackByChat.set(input.externalId, {
        callbackId: ev.callbackId,
        options,
      });
      this.persistCallbackState();
      const reply_markup = {
        inline_keyboard: chunkButtons(
          options.map((opt) => ({
            text: opt.label,
            callback_data: `cb:${ev.callbackId}:${opt.value}`,
          })),
        ),
      };
      await this.postMethod("sendMessage", {
        chat_id: input.externalId,
        text: `🔐 ${ev.tool} requests approval\n${ev.summary}`,
        reply_markup,
      });
      return;
    }
    const r = this.getRenderer(input.externalId);
    const lines = r.renderAll(ev);
    for (const line of lines) {
      if (!line.text) continue;
      await this.sendText(input.externalId, line.text, line.parseMode);
    }
  }

  protected async requestApprovalImpl(
    externalId: ExternalChatId,
    ui: ApprovalUI,
  ): Promise<{ decision: PermissionDecision; remember?: "once" | "session" | "always" }> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(ui.approvalId, { resolve, externalId, ui });
      const body = [`🔐 Approval · ${ui.toolName}`, redact(ui.summary), `cwd: ${ui.cwd}`].join(
        "\n",
      );
      const reply_markup = {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: `apr:${ui.approvalId}:a` },
            { text: "Deny", callback_data: `apr:${ui.approvalId}:d` },
          ],
        ],
      };
      void this.postMethod("sendMessage", {
        chat_id: externalId,
        text: body,
        reply_markup,
      });
    });
  }

  protected async notifyImpl(externalId: ExternalChatId, message: string): Promise<void> {
    await this.sendText(externalId, message);
  }

  protected async sendPairingPromptImpl(externalId: ExternalChatId, code: string): Promise<void> {
    await this.sendText(
      externalId,
      ["Pairing code:", code, "", `Run locally: soulforge-remote pair ${this.id} ${code}`].join(
        "\n",
      ),
    );
  }

  private async sendText(
    chatId: ExternalChatId,
    text: string,
    parseMode?: "HTML" | "MarkdownV2" | "plain",
  ): Promise<void> {
    if (!this.token) return;
    // T10 — Telegram hard-caps messages at 4096 chars. Paginate on code-block
    // and paragraph boundaries so a long diff/log never gets silently truncated.
    const pages = splitForTelegram(text);
    for (const page of pages) {
      await this.enforcePerChatPace(chatId);
      try {
        const body: Record<string, unknown> = {
          chat_id: chatId,
          text: page,
          link_preview_options: { is_disabled: true },
        };
        if (parseMode === "HTML" || parseMode === "MarkdownV2") {
          body.parse_mode = parseMode;
        }
        await this.postMethod("sendMessage", body);
      } catch (err) {
        this.log(redact(`tg send failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  /** Per-chat token-bucket — max 1 outbound msg/sec per chat (Telegram soft
   *  cap). Blocks just long enough to stay under the ban threshold. */
  private async enforcePerChatPace(chatId: ExternalChatId): Promise<void> {
    const MIN_INTERVAL_MS = 1000;
    const last = this.lastSendAt.get(chatId) ?? 0;
    const wait = last + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastSendAt.set(chatId, Date.now());
  }

  /**
   * Handle an inbound photo or document. Downloads the file via Telegram's
   * getFile → data-URL round-trip, then emits an InboundMessage with the
   * image/document attached. Caption becomes the message text.
   */
  private async handleAttachment(msg: TGMessage, senderId: string, chatId: string): Promise<void> {
    if (!this.token) return;
    const images: { url: string; mediaType: string }[] = [];
    // Photo: take the largest size (last entry in the photo array).
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      if (largest) {
        // L1 — enforce size cap using the file_size Telegram reports.
        const size = largest.file_size;
        if (size !== undefined && size > ATTACHMENT_MAX_BYTES) {
          this.log(
            `tg attachment rejected: photo ${String(size)}B > ${String(ATTACHMENT_MAX_BYTES)}B`,
          );
        } else {
          const url = await this.downloadFileAsDataUrl(largest.file_id, "image/jpeg");
          if (url) images.push({ url, mediaType: "image/jpeg" });
        }
      }
    }
    // Document: only route images through the ImageAttachment channel. Other
    // docs (pdf/txt/etc.) become a short text note so the agent knows a file
    // was sent but doesn't get binary garbage injected.
    if (msg.document) {
      const mime = msg.document.mime_type ?? "application/octet-stream";
      if (mime.startsWith("image/")) {
        const size = msg.document.file_size;
        if (size !== undefined && size > ATTACHMENT_MAX_BYTES) {
          this.log(
            `tg attachment rejected: document ${String(size)}B > ${String(ATTACHMENT_MAX_BYTES)}B`,
          );
        } else {
          const url = await this.downloadFileAsDataUrl(msg.document.file_id, mime);
          if (url) images.push({ url, mediaType: mime });
        }
      } else {
        // L3 + L11 — scrub filename (strip C0 controls, cap length) before
        // interpolating into the agent's prompt context. Prevents terminal
        // escape injection AND filename-based prompt injection.
        const rawName = msg.document.file_name ?? "file";
        const safeName = sanitizeFilename(rawName);
        const note = `[attachment: ${safeName} · ${mime} · ${String(msg.document.file_size ?? 0)} bytes — binary not loaded]`;
        const caption = msg.caption ? `${msg.caption}\n\n${note}` : note;
        const inbound: InboundMessage = {
          externalId: chatId,
          senderId,
          text: caption,
          command: parseCommand(caption),
          platformTs: msg.date * 1000,
        };
        this.emitInbound(inbound);
        return;
      }
    }
    if (images.length === 0 && !msg.caption) return;
    const text = msg.caption ?? "";
    const inbound: InboundMessage = {
      externalId: chatId,
      senderId,
      text,
      command: text ? parseCommand(text) : undefined,
      images: images.length > 0 ? images : undefined,
      platformTs: msg.date * 1000,
    };
    this.emitInbound(inbound);
  }

  /** Fetch a Telegram file by file_id and return a data: URL. Null on failure. */
  private async downloadFileAsDataUrl(fileId: string, mediaType: string): Promise<string | null> {
    if (!this.token) return null;
    try {
      const metaRes = await this.fetchImpl(this.apiUrl("getFile"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
      });
      if (!metaRes.ok) return null;
      const meta = (await metaRes.json()) as {
        ok: boolean;
        result?: { file_path?: string; file_size?: number };
      };
      if (!meta.ok || !meta.result?.file_path) return null;
      // L1 — second-line defence: re-check reported size from the getFile
      // response in case the initial update.message.photo[].file_size was
      // missing or spoofed. Telegram includes file_size in the getFile result
      // for most (not all) file types.
      const reportedSize = meta.result.file_size;
      if (reportedSize !== undefined && reportedSize > ATTACHMENT_MAX_BYTES) {
        this.log(
          `tg download rejected: ${String(reportedSize)}B > ${String(ATTACHMENT_MAX_BYTES)}B`,
        );
        return null;
      }
      const fileRes = await this.fetchImpl(
        `https://api.telegram.org/file/bot${this.token}/${meta.result.file_path}`,
      );
      if (!fileRes.ok) return null;
      // L1 — third-line defence: stop reading once we cross the cap. A liar
      // upstream (mismatched Content-Length, streamed content) can't OOM us.
      const contentLength = Number(fileRes.headers.get("content-length") ?? 0);
      if (contentLength > ATTACHMENT_MAX_BYTES) {
        this.log(`tg download rejected: content-length ${String(contentLength)}B > cap`);
        return null;
      }
      const buf = new Uint8Array(await fileRes.arrayBuffer());
      if (buf.length > ATTACHMENT_MAX_BYTES) {
        this.log(`tg download rejected: actual ${String(buf.length)}B > cap`);
        return null;
      }
      // Chunked base64 — avoid the O(n) String.fromCharCode(...giant) stack
      // blowup. 64 KiB chunks keep peak intermediate memory bounded.
      const b64 = chunkedBase64(buf);
      return `data:${mediaType};base64,${b64}`;
    } catch {
      return null;
    }
  }

  private async postMethod(method: string, body: unknown): Promise<void> {
    if (!this.token) return;
    // Retry once on 429 honoring parameters.retry_after. Further 429s bubble
    // as a log line — we don't spin forever on a blocked bot.
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await this.fetchImpl(this.apiUrl(method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (resp.status === 429) {
        let retryAfter = 5;
        try {
          const parsed = (await resp.json()) as {
            parameters?: { retry_after?: number };
          };
          retryAfter = parsed.parameters?.retry_after ?? retryAfter;
        } catch {
          const hdr = resp.headers.get("retry-after");
          if (hdr) retryAfter = Number.parseInt(hdr, 10) || retryAfter;
        }
        this.log(redact(`tg ${method} 429 — retry after ${String(retryAfter)}s`));
        if (attempt === 0) {
          await sleep(retryAfter * 1000);
          continue;
        }
      }
      if (!resp.ok) {
        this.log(redact(`tg ${method} HTTP ${String(resp.status)}`));
      }
      return;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Telegram caps message text at 4096 chars. Split a long string on:
 *   1. Triple-backtick code-block boundaries (never break a code block).
 *   2. Blank lines (paragraph break).
 *   3. Single newlines (line break).
 *   4. Hard char cap as a last resort.
 *
 * If a code block crosses a page boundary, close it on the source page and
 * reopen on the next so syntax stays intact.
 */
const TG_HARD_LIMIT = 4096;
const TG_PAGE_LIMIT = 3900; // Leave headroom for "(page X/N)" suffix.

export function splitForTelegram(text: string): string[] {
  if (text.length <= TG_HARD_LIMIT) return [text];

  // Quick path: the text is short enough that simple paragraph slicing works.
  const pages: string[] = [];
  let buf = "";
  let openFence: string | null = null; // "```lang" if we're mid-fence

  const flush = () => {
    if (buf.length === 0) return;
    if (openFence) {
      pages.push(`${buf}\n\`\`\``);
      buf = `${openFence}\n`;
    } else {
      pages.push(buf);
      buf = "";
    }
  };

  const lines = text.split("\n");
  for (const line of lines) {
    // Detect fence transitions.
    if (line.startsWith("```")) {
      if (openFence) openFence = null;
      else openFence = line;
    }
    const projected = buf.length + line.length + 1;
    if (projected > TG_PAGE_LIMIT) {
      // If this single line is itself > limit, hard-split it.
      if (line.length > TG_PAGE_LIMIT) {
        flush();
        let rest = line;
        while (rest.length > TG_PAGE_LIMIT) {
          pages.push(rest.slice(0, TG_PAGE_LIMIT));
          rest = rest.slice(TG_PAGE_LIMIT);
        }
        buf = rest;
        continue;
      }
      flush();
    }
    buf += (buf.length > 0 ? "\n" : "") + line;
  }
  if (buf.length > 0) pages.push(buf);

  // Stamp page markers on every page when there's more than one.
  if (pages.length <= 1) return pages;
  return pages.map((p, i) => `${p}\n\n(page ${String(i + 1)}/${String(pages.length)})`);
}

/**
 * Lay out inline-keyboard buttons in rows of at most 3 — Telegram has no
 * hard limit but >3 wide buttons wrap awkwardly on mobile. Single row when
 * total ≤ 3, otherwise pairs of 2.
 */
function chunkButtons<T>(buttons: T[]): T[][] {
  if (buttons.length === 0) return [];
  if (buttons.length <= 3) return [buttons];
  const rows: T[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return rows;
}
// ── Attachment limits + scrub helpers ───────────────────────────────────────

/** Maximum byte size we accept for inbound image attachments. */
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Scrub a filename coming from Telegram before it reaches the agent's prompt.
 * Strips C0 control bytes (0x00–0x1F except newline we'd also strip) and DEL,
 * and caps at 120 chars. Prevents:
 *   - Terminal escape injection (\x1b[...) rendering in a shell showing logs.
 *   - Newline-based prompt injection ("foo.pdf\n\nIgnore previous instructions").
 *   - Runaway length filenames bloating context.
 */
function sanitizeFilename(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length && out.length < 120; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) continue;
    out += raw[i];
  }
  return out || "file";
}

/**
 * Chunked base64 encode — avoids allocating a giant intermediate string via
 * `String.fromCharCode(...buf)` which can stack-overflow or OOM on large
 * buffers. 48 KiB chunks (multiple of 3 to keep base64 boundaries clean).
 */
function chunkedBase64(buf: Uint8Array): string {
  const CHUNK = 49152; // 48 KiB, divisible by 3
  let out = "";
  for (let i = 0; i < buf.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, buf.length);
    let s = "";
    for (let j = i; j < end; j++) s += String.fromCharCode(buf[j] ?? 0);
    out += btoa(s);
  }
  return out;
}
