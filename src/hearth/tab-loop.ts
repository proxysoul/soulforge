/**
 * TabLoop — one long-running runChat invocation per tab.
 *
 * Hearth daemon spawns one TabLoop per active tab in each chat workspace.
 * All four seam options are wired: readPrompt pulls from an async queue
 * the surface feeds, onEvent routes to the surface renderer, signal lets
 * the daemon abort a turn, and callbacks route human-in-loop prompts back
 * through the surface.
 */

import { randomUUID } from "node:crypto";
import { runChat } from "../headless/run.js";
import type { HeadlessChatOptions, HeadlessEvent } from "../headless/types.js";
import type { AppConfig, ForgeMode, InteractiveCallbacks } from "../types/index.js";
import type { ExternalChatId, Surface } from "./types.js";
import { cancelRemoteCallbacksForTab } from "./bridge.js";

/** Cap per-tab prompt queue so a flooding chat can't OOM the daemon. */
const MAX_QUEUED_PROMPTS = 200;

export interface TabLoopOptions {
  tabId: string;
  tabLabel: string;
  surface: Surface;
  externalId: ExternalChatId;
  cwd: string;
  model?: string;
  mode?: ForgeMode;
  callbacks: InteractiveCallbacks;
  mergedConfig: AppConfig;
  sessionId?: string;
  onEvent?: (ev: HeadlessEvent) => void;
  onExit?: (reason: "normal" | "error" | "aborted", err?: Error) => void;
  onApproveDestructive?: (description: string) => Promise<boolean>;
  onApproveOutsideCwd?: (toolName: string, path: string) => Promise<boolean>;
}

interface QueuedPrompt {
  id: string;
  text: string;
  enqueuedAt: number;
}

export class TabLoop {
  readonly tabId: string;
  readonly tabLabel: string;
  readonly externalId: ExternalChatId;
  readonly cwd: string;

  private surface: Surface;
  private queue: QueuedPrompt[] = [];
  private waiters: Array<(p: string | null) => void> = [];
  private abortCtl = new AbortController();
  private started = false;
  private closed = false;
  private loopPromise: Promise<void> | null = null;
  private lastError: Error | null = null;
  private mergedConfig: AppConfig;
  private options: TabLoopOptions;

  constructor(opts: TabLoopOptions) {
    this.tabId = opts.tabId;
    this.tabLabel = opts.tabLabel;
    this.externalId = opts.externalId;
    this.cwd = opts.cwd;
    this.surface = opts.surface;
    this.mergedConfig = opts.mergedConfig;
    this.options = opts;
  }

  /** Start the loop. Idempotent. */
  start(): Promise<void> {
    if (this.started) return this.loopPromise ?? Promise.resolve();
    this.started = true;

    const headlessOpts: HeadlessChatOptions = {
      modelId: this.options.model,
      mode: this.options.mode ?? "default",
      cwd: this.cwd,
      sessionId: this.options.sessionId,
      quiet: true,
      embedded: true,
      readPrompt: () => this.readPrompt(),
      signal: this.abortCtl.signal,
      callbacks: this.options.callbacks,
      onApproveDestructive: this.options.onApproveDestructive,
      onApproveOutsideCwd: this.options.onApproveOutsideCwd,
      tabId: this.tabId,
      tabLabel: this.tabLabel,
      onEvent: (ev) => {
        this.options.onEvent?.(ev);
        this.surface
          .render({ externalId: this.externalId, tabId: this.tabId, event: ev })
          .catch(() => {});
      },
    };

    this.loopPromise = runChat(headlessOpts, this.mergedConfig)
      .then(() => {
        if (this.options.onExit) this.options.onExit(this.closed ? "normal" : "normal");
      })
      .catch((err: unknown) => {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        this.lastError = wrapped;
        if (this.options.onExit) {
          this.options.onExit(this.abortCtl.signal.aborted ? "aborted" : "error", wrapped);
        }
      })
      .finally(() => {
        this.closed = true;
        // Drain any outstanding waiters so they don't hang
        for (const w of this.waiters.splice(0)) w(null);
      });

    return this.loopPromise;
  }

  /** Enqueue a prompt from the surface. Returns prompt id (or null if dropped). */
  enqueuePrompt(text: string): string | null {
    const id = randomUUID();
    if (this.closed) return null;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(text);
      return id;
    }
    if (this.queue.length >= MAX_QUEUED_PROMPTS) {
      // Drop oldest rather than reject — surface stays responsive even under flood
      this.queue.shift();
    }
    this.queue.push({ id, text, enqueuedAt: Date.now() });
    return id;
  }

  /**
   * Abort the currently running turn (interrupt chain). runChat installs the abort
   * listener once per turn, so we renew the controller BEFORE forwarding so the
   * next turn's listener is attached to a fresh signal, not the aborted one.
   */
  abortTurn(): void {
    const current = this.abortCtl;
    this.abortCtl = new AbortController();
    current.abort();
    // Resolve any parked remote prompt (ask_user / plan-review / approval) so the
    // agent's awaiting callback returns its fallback now instead of after the 5-min
    // timeout — otherwise the entry leaks and the stall watchdog sees a dead tab.
    cancelRemoteCallbacksForTab(this.tabId);
  }

  /** Close the loop — aborts, then releases pending waiters. */
  async close(): Promise<void> {
    if (this.closed) {
      await this.loopPromise;
      return;
    }
    this.closed = true;
    this.abortCtl.abort();
    cancelRemoteCallbacksForTab(this.tabId);
    for (const w of this.waiters.splice(0)) w(null);
    await this.loopPromise;
  }

  isClosed(): boolean {
    return this.closed;
  }

  lastErrorMessage(): string | null {
    return this.lastError ? this.lastError.message : null;
  }

  private readPrompt(): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    const next = this.queue.shift();
    if (next) return Promise.resolve(next.text);
    return new Promise<string | null>((resolve) => {
      if (this.closed) {
        resolve(null);
        return;
      }
      this.waiters.push(resolve);
    });
  }

  /** Test hook — inspect the queue without draining it. */
  queueLength(): number {
    return this.queue.length;
  }

  /** Test hook — count waiters blocked on readPrompt. */
  waiterCount(): number {
    return this.waiters.length;
  }
}
