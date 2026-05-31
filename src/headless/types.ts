import type { ForgeMode, InteractiveCallbacks } from "../types/index.js";

export interface HeadlessRunOptions {
  prompt: string;
  modelId?: string;
  mode?: ForgeMode;
  json?: boolean;
  events?: boolean;
  quiet?: boolean;
  maxSteps?: number;
  timeout?: number;
  cwd?: string;
  sessionId?: string;
  saveSession?: boolean;
  system?: string;
  noRepomap?: boolean;
  include?: string[];
  diff?: boolean;
  render?: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * Typed event union emitted by runChat/runPrompt. Default sink is JSONL to stdout
 * when `events: true` — Hearth replaces this with its own sink so surfaces can
 * render streams directly.
 */
export type HeadlessEvent =
  | {
      type: "start";
      model: string;
      mode: ForgeMode;
      chat?: boolean;
      session?: string | null;
      repoMap?: { files: number; symbols: number } | null;
      workers?: { intelligence: string; io: string } | null;
    }
  | { type: "ready" }
  | { type: "text"; content: string }
  | { type: "tool-call"; tool: string; toolCallId?: string; input?: Record<string, unknown> }
  | { type: "tool-result"; tool: string; toolCallId?: string; summary: string }
  | {
      type: "step";
      step: number;
      tokens: TokenUsage & {
        lastStepInput?: number;
        lastStepOutput?: number;
        lastStepCacheRead?: number;
      };
    }
  | {
      type: "turn-done";
      turn: number;
      output: string;
      steps: number;
      tokens: TokenUsage;
      toolCalls: string[];
      filesEdited: string[];
      duration: number;
      error?: string;
    }
  | { type: "chat-done"; turns: number; tokens: TokenUsage; sessionId?: string }
  | {
      type: "done";
      output: string;
      steps: number;
      tokens: TokenUsage;
      toolCalls: string[];
      filesEdited: string[];
      duration: number;
      error?: string;
    }
  | { type: "session-saved"; sessionId: string }
  | { type: "warning"; message: string }
  | { type: "error"; error: string }
  | { type: "reasoning"; content: string }
  | {
      type: "ask-user";
      callbackId: string;
      question: string;
      options: { label: string; value: string }[];
      allowSkip?: boolean;
    }
  | {
      type: "plan-review";
      callbackId: string;
      title: string;
      summary: string;
    }
  | {
      type: "approval-request";
      callbackId: string;
      tool: string;
      summary: string;
    };

export interface HeadlessChatOptions {
  modelId?: string;
  mode?: ForgeMode;
  json?: boolean;
  events?: boolean;
  quiet?: boolean;
  maxSteps?: number;
  timeout?: number;
  cwd?: string;
  sessionId?: string;
  system?: string;
  noRepomap?: boolean;

  // Hearth seam (all optional — defaults preserve CLI behavior)
  /** Prompt source. Default: line-buffered stdin reader. */
  readPrompt?: () => Promise<string | null>;
  /** External abort. Default: process SIGINT handler. */
  signal?: AbortSignal;
  /** Human-in-loop callbacks. Default: none (auto-allow today). */
  callbacks?: InteractiveCallbacks;
  /** Approve a destructive op (sensitive-file edit / destructive shell). Default: deny. */
  onApproveDestructive?: (description: string) => Promise<boolean>;
  /** Approve a write outside the workspace cwd. Default: deny. */
  onApproveOutsideCwd?: (toolName: string, path: string) => Promise<boolean>;
  /** Event sink. Default: JSONL writeEvent to stdout (only when events=true). */
  onEvent?: (event: HeadlessEvent) => void;
  /** Tab identity for WorkspaceCoordinator. Default: "headless". */
  tabId?: string;
  /** Human label for tab. */
  tabLabel?: string;
  /** Daemon-embedded mode — disables process-wide SIGINT/exit/MCP teardown. */
  embedded?: boolean;
}

export type HeadlessAction =
  | { type: "run"; opts: HeadlessRunOptions }
  | { type: "chat"; opts: HeadlessChatOptions }
  | { type: "list-providers" }
  | { type: "list-models"; provider?: string }
  | { type: "set-key"; provider: string; key: string }
  | { type: "version" };
