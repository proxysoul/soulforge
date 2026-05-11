import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ImagePart,
  ModelMessage,
  StreamTextResult,
  TextPart,
  ToolCallPart,
  ToolSet,
} from "ai";
import { generateText } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StreamSegment } from "../components/chat/StreamSegmentList.js";
import type { LiveToolCall } from "../components/chat/ToolCallDisplay.js";
import { normalizePath } from "../core/agents/agent-bus.js";
import { createForgeAgent } from "../core/agents/index.js";
import { onAgentStats, onMultiAgentEvent, onSubagentStep } from "../core/agents/subagent-events.js";
import type { SharedCacheRef } from "../core/agents/subagent-tools.js";
import {
  buildV2Summary,
  DEFAULT_COMPACTION_CONFIG,
  extractFromAssistantMessage,
  extractFromToolCall,
  extractFromToolResult,
  extractFromUserMessage,
  WorkingStateManager,
} from "../core/compaction/index.js";
import type { ContextManager } from "../core/context/manager.js";
import { getWorkspaceCoordinator } from "../core/coordination/WorkspaceCoordinator.js";
import { setCoAuthorEnabled } from "../core/git/status.js";
import { hasToolHooks, runHooks } from "../core/hooks/index.js";
import {
  getModelContextInfo,
  getModelContextInfoSync,
  getModelContextWindow,
  getShortModelLabel,
} from "../core/llm/models.js";
import { getActiveProviderId, resolveModel } from "../core/llm/provider.js";
import {
  buildProviderOptions,
  degradeProviderOptions,
  isProviderOptionsError,
  supportsTemperature,
} from "../core/llm/provider-options.js";
import { resolveTaskModel } from "../core/llm/task-router.js";
import { onCompaction, writeDiary } from "../core/mcp/mempalace.js";
import { bounceProxy, proxyHealthProbe } from "../core/proxy/lifecycle.js";
import { resolveRetrySettings } from "../core/retry/settings.js";
import { updateEmergencySnapshot } from "../core/sessions/emergency-save.js";
import { SessionManager } from "../core/sessions/manager.js";
import { createThinkingParser } from "../core/thinking-parser.js";
import { emitCacheReset, onFileEdited } from "../core/tools/file-events.js";
import { planFileName } from "../core/tools/index.js";
import { setShellCoAuthorEnabled } from "../core/tools/shell.js";
import {
  clearTasks,
  completeInProgressTasks,
  resetInProgressTasks,
} from "../core/tools/task-list.js";
import { onToolProgress } from "../core/tools/tool-progress.js";
import { getIOClient } from "../core/workers/io-client.js";
import { logCompaction } from "../stores/compaction-logs.js";
import { logBackgroundError } from "../stores/errors.js";
import { useRepoMapStore } from "../stores/repomap.js";
import { accumulateModelUsage, useStatusBarStore, ZERO_USAGE } from "../stores/statusbar.js";
import { useToolsStore } from "../stores/tools.js";
import type {
  AppConfig,
  ChatMessage,
  ImageAttachment,
  InteractiveCallbacks,
  MessageSegment,
  PendingPlanReview,
  PendingQuestion,
  Plan,
  PlanReviewAction,
  PlanStepStatus,
  QueuedMessage,
} from "../types/index.js";
import { clampWatchdogTimeouts } from "../types/index.js";
import { compressImageForApi } from "../utils/image-compress.js";
import { reprimeContextFromMessages, safeParseArgs } from "./chat/message-processing.js";
import { buildAssistantMessage, hasRenderableAssistantContent } from "./useChat-content.js";
import { cycleForgeMode } from "./useForgeMode.js";
import { buildSessionMeta } from "./useSessionBuilder.js";

export interface TabState {
  id: string;
  label: string;
  messages: ChatMessage[];
  coreMessages: ModelMessage[];
  activeModel: string;
  activePlan: Plan | null;
  sidebarPlan: Plan | null;
  tokenUsage: TokenUsage;
  coAuthorCommits: boolean;
  sessionId: string;
  planMode: boolean;
  planRequest: string | null;
  forgeMode: import("../types/index.js").ForgeMode;
}

interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  subagentInput: number;
  subagentOutput: number;
  lastStepInput: number;
  lastStepOutput: number;
  lastStepCacheRead: number;
  modelBreakdown: Record<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number }
  >;
}

const CHARS_PER_TOKEN = 4;
const PRUNE_PROTECT_TOKENS = 40_000;
const PRUNE_MINIMUM_TOKENS = 20_000;

function pruneOldToolResults(msgs: ModelMessage[]): ModelMessage[] {
  let protectedTokens = 0;
  let prunableTokens = 0;
  const toPrune = new Set<number>();

  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (!msg || msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (typeof part !== "object" || part === null || !("type" in part)) continue;
      const p = part as { type: string; output?: unknown };
      if (p.type !== "tool-result") continue;
      const text =
        typeof p.output === "string"
          ? p.output
          : typeof (p.output as Record<string, unknown>)?.value === "string"
            ? ((p.output as Record<string, unknown>).value as string)
            : JSON.stringify(p.output ?? "");
      const tokens = Math.round(text.length / CHARS_PER_TOKEN);
      if (protectedTokens < PRUNE_PROTECT_TOKENS) {
        protectedTokens += tokens;
      } else {
        prunableTokens += tokens;
        toPrune.add(i);
      }
    }
  }

  if (prunableTokens < PRUNE_MINIMUM_TOKENS || toPrune.size === 0) return msgs;

  return msgs.map((msg, idx) => {
    if (!toPrune.has(idx)) return msg;
    if (msg.role !== "tool" || !Array.isArray(msg.content)) return msg;
    const newContent = msg.content.map((part) => {
      if (typeof part !== "object" || part === null || !("type" in part)) return part;
      const p = part as { type: string; output?: unknown; toolName?: string };
      if (p.type !== "tool-result") return part;
      if (
        p.toolName === "edit_file" ||
        p.toolName === "multi_edit" ||
        p.toolName === "write_file" ||
        p.toolName === "create_file"
      )
        return part;
      return {
        ...p,
        output: { type: "text" as const, value: "[Old tool result content cleared]" },
      };
    });
    return { ...msg, content: newContent } as ModelMessage;
  });
}

export interface WorkspaceSnapshot {
  tabStates: TabState[];
  activeTabId: string;
}

export interface UseChatOptions {
  effectiveConfig: AppConfig;
  contextManager: ContextManager;
  sessionManager: SessionManager;
  cwd: string;
  tabId: string;
  tabLabel?: string;
  openEditorWithFile: (file: string) => void;
  openEditor: () => void;
  onSuspend: (opts: { command: string; args?: string[]; noAltScreen?: boolean }) => void;
  initialState?: TabState;
  getWorkspaceSnapshot?: () => WorkspaceSnapshot;
  visible?: boolean;
}

export interface ChatInstance {
  // State
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  coreMessages: ModelMessage[];
  setCoreMessages: React.Dispatch<React.SetStateAction<ModelMessage[]>>;
  isLoading: boolean;
  isCompacting: boolean;
  streamSegments: StreamSegment[];
  liveToolCalls: LiveToolCall[];
  activePlan: Plan | null;
  setActivePlan: React.Dispatch<React.SetStateAction<Plan | null>>;
  sidebarPlan: Plan | null;
  setSidebarPlan: React.Dispatch<React.SetStateAction<Plan | null>>;
  pendingQuestion: PendingQuestion | null;
  setPendingQuestion: React.Dispatch<React.SetStateAction<PendingQuestion | null>>;
  messageQueue: QueuedMessage[];
  setMessageQueue: React.Dispatch<React.SetStateAction<QueuedMessage[]>>;
  activeModel: string;
  setActiveModel: React.Dispatch<React.SetStateAction<string>>;
  coAuthorCommits: boolean;
  setCoAuthorCommits: React.Dispatch<React.SetStateAction<boolean>>;
  tokenUsage: TokenUsage;
  setTokenUsage: React.Dispatch<React.SetStateAction<TokenUsage>>;
  /** Timestamp when actual generation started (after Soul Map wait). */
  loadingStartedAt: number;
  contextTokens: number;
  lastStepOutput: number;
  chatChars: number;
  sessionId: string;
  customTitle: string | null;
  setCustomTitle: (title: string | null) => void;
  planFile: string;
  planMode: boolean;
  planRequest: string | null;
  // Actions
  handleSubmit: (
    input: string,
    images?: ImageAttachment[],
    opts?: { inboundId?: string; origin?: ChatMessage["origin"] },
  ) => Promise<void>;
  summarizeConversation: (opts?: { skipQueueDrain?: boolean }) => Promise<void>;
  abort: () => void;
  interactiveCallbacks: InteractiveCallbacks;
  // Plan mode
  setPlanMode: (on: boolean) => void;
  setPlanRequest: (req: string | null) => void;
  pendingPlanReview: PendingPlanReview | null;
  setPendingPlanReview: React.Dispatch<React.SetStateAction<PendingPlanReview | null>>;
  snapshot: (label: string) => TabState;
  contextManager: ContextManager;
  forgeMode: import("../types/index.js").ForgeMode;
  setForgeMode: (mode: import("../types/index.js").ForgeMode) => void;
  cycleMode: () => import("../types/index.js").ForgeMode;
}

export function useChat({
  effectiveConfig,
  contextManager,
  sessionManager,
  cwd,
  tabId,
  tabLabel,
  openEditorWithFile,
  openEditor,
  initialState,
  getWorkspaceSnapshot,
  visible = true,
}: UseChatOptions): ChatInstance {
  const [messages, setMessages] = useState<ChatMessage[]>(initialState?.messages ?? []);
  const [coreMessages, setCoreMessages] = useState<ModelMessage[]>(
    initialState?.coreMessages ?? [],
  );
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStartedAt, setLoadingStartedAt] = useState(0);
  const [streamSegments, setStreamSegments] = useState<StreamSegment[]>([]);
  const [liveToolCalls, setLiveToolCalls] = useState<LiveToolCall[]>([]);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const streamSegmentsBuffer = useRef<StreamSegment[]>([]);
  const liveToolCallsBuffer = useRef<LiveToolCall[]>([]);
  const pendingTokenUsage = useRef<TokenUsage | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const segmentsDirty = useRef(false);
  const toolCallsDirty = useRef(false);
  const lastFlushedSegments = useRef<StreamSegment[]>([]);
  const lastFlushedToolCalls = useRef<LiveToolCall[]>([]);
  const lastFlushedStreamingChars = useRef(0);
  const flushStreamState = useCallback(() => {
    {
      if (segmentsDirty.current) {
        const buf = streamSegmentsBuffer.current;
        const prev = lastFlushedSegments.current;
        let changed = buf.length !== prev.length;
        const next: StreamSegment[] = new Array(buf.length);
        for (let i = 0; i < buf.length; i++) {
          const s = buf[i] as StreamSegment;
          const p = prev[i];
          if (p && s.type === p.type) {
            let same = false;
            if (s.type === "text" && p.type === "text") {
              same = s.content === p.content;
            } else if (s.type === "reasoning" && p.type === "reasoning") {
              same = s.content === p.content && s.id === p.id && s.done === p.done;
            } else if (s.type === "tools" && p.type === "tools") {
              same =
                s.callIds.length === p.callIds.length &&
                s.callIds.every((id, j) => id === p.callIds[j]);
            }
            if (same) {
              next[i] = p;
              continue;
            }
          }
          changed = true;
          next[i] = s.type === "tools" ? { ...s, callIds: [...s.callIds] } : { ...s };
        }
        if (changed) {
          lastFlushedSegments.current = next;
          setStreamSegments(next);
        }
        segmentsDirty.current = false;
      }
      if (toolCallsDirty.current) {
        const buf = liveToolCallsBuffer.current;
        const prev = lastFlushedToolCalls.current;
        let changed = buf.length !== prev.length;
        const next: LiveToolCall[] = new Array(buf.length);
        for (let i = 0; i < buf.length; i++) {
          const tc = buf[i] as LiveToolCall;
          const p = prev[i];
          if (
            p &&
            tc.id === p.id &&
            tc.toolName === p.toolName &&
            tc.state === p.state &&
            tc.args === p.args &&
            tc.result === p.result &&
            tc.error === p.error &&
            tc.progressText === p.progressText
          ) {
            next[i] = p;
            continue;
          }
          changed = true;
          next[i] = { ...tc };
        }
        if (changed) {
          lastFlushedToolCalls.current = next;
          setLiveToolCalls(next);
        }
        toolCallsDirty.current = false;
      }
      const tu = pendingTokenUsage.current;
      if (tu) {
        setTokenUsageRaw(tu);
        if (visibleRef.current)
          useStatusBarStore.getState().setTokenUsage(tu, activeModelRef.current);
        pendingTokenUsage.current = null;
      }
      const ct = pendingContextTokens.current;
      if (ct !== null) {
        setContextTokens(ct);
        pendingContextTokens.current = null;
      }
      const so = pendingLastStepOutput.current;
      if (so !== null) {
        setLastStepOutput(so);
        pendingLastStepOutput.current = null;
      }
      const nextChars = streamingCharsRef.current + toolCharsRef.current;
      if (nextChars !== lastFlushedStreamingChars.current) {
        lastFlushedStreamingChars.current = nextChars;
        setStreamingChars(nextChars);
      }
    }
  }, []);

  const flushMicrotaskQueued = useRef(false);
  const flushMicrotaskTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushTime = useRef(0);
  /** Minimum ms between microtask-triggered flushes — align with renderer frame rate. */
  const MIN_FLUSH_INTERVAL_MS = 16;
  const queueMicrotaskFlush = useCallback(() => {
    if (flushMicrotaskQueued.current) return;
    flushMicrotaskQueued.current = true;
    const elapsed = Date.now() - lastFlushTime.current;
    const delay = elapsed >= MIN_FLUSH_INTERVAL_MS ? 0 : MIN_FLUSH_INTERVAL_MS - elapsed;
    flushMicrotaskTimer.current = setTimeout(() => {
      flushMicrotaskQueued.current = false;
      flushMicrotaskTimer.current = null;
      lastFlushTime.current = Date.now();
      flushStreamState();
    }, delay);
  }, [flushStreamState]);

  // Clean up pending microtask flush and stream flush timer on unmount
  useEffect(() => {
    return () => {
      if (flushMicrotaskTimer.current) {
        clearTimeout(flushMicrotaskTimer.current);
        flushMicrotaskTimer.current = null;
      }
      if (flushTimerRef.current) {
        clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  // Interactive state
  const abortRef = useRef<AbortController | null>(null);
  const autoApproveWebAccessRef = useRef(false);
  const webAccessMutexRef = useRef<Promise<void>>(Promise.resolve());
  const autoApproveOutsideCwdRef = useRef(false);
  const outsideCwdMutexRef = useRef<Promise<void>>(Promise.resolve());
  // Counts concurrent remote approval callbacks awaiting the user on their
  // phone. Stall watchdog pauses while > 0 — the user may need minutes to
  // tap Allow/Deny, which is not stream inactivity.
  const remoteApprovalActiveRef = useRef(0);
  const webSearchModelLabelRef = useRef<string | null>(null);
  const [activePlan, setActivePlanRaw] = useState<Plan | null>(initialState?.activePlan ?? null);
  const activePlanRef = useRef<Plan | null>(activePlan);
  const setActivePlan = useCallback<typeof setActivePlanRaw>((v) => {
    if (typeof v === "function") {
      setActivePlanRaw((prev) => {
        const next = v(prev);
        activePlanRef.current = next;
        return next;
      });
    } else {
      activePlanRef.current = v;
      setActivePlanRaw(v);
    }
  }, []);
  const [sidebarPlan, setSidebarPlan] = useState<Plan | null>(initialState?.sidebarPlan ?? null);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const pendingQuestionRef = useRef(pendingQuestion);
  pendingQuestionRef.current = pendingQuestion;
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const messageQueueRef = useRef<QueuedMessage[]>([]);
  messageQueueRef.current = messageQueue;
  const steeringAbortedRef = useRef(false);
  const abortedSegmentsSnapshot = useRef<StreamSegment[]>([]);
  const abortedToolCallsSnapshot = useRef<LiveToolCall[]>([]);

  // LLM state
  const [activeModel, setActiveModel] = useState(
    initialState?.activeModel ?? effectiveConfig.defaultModel,
  );
  const [coAuthorCommits, setCoAuthorCommits] = useState(initialState?.coAuthorCommits ?? true);

  const [forgeMode, setForgeModeState] = useState<import("../types/index.js").ForgeMode>(
    initialState?.forgeMode ?? effectiveConfig.defaultForgeMode ?? "default",
  );
  const forgeModeRef = useRef(forgeMode);
  forgeModeRef.current = forgeMode;

  const setForgeMode = useCallback(
    (mode: import("../types/index.js").ForgeMode) => {
      setForgeModeState(mode);
      forgeModeRef.current = mode;
      contextManager.setForgeMode(mode);
    },
    [contextManager],
  );

  const cycleModeFn = useCallback((): import("../types/index.js").ForgeMode => {
    const next = cycleForgeMode(forgeModeRef.current);
    setForgeMode(next);
    return next;
  }, [setForgeMode]);

  // Sync forgeMode to contextManager on mount (covers session resume) and on
  // every change. Each tab has its own contextManager (TabInstance.tsx), so
  // syncing for inactive tabs is safe — the agent only reads forgeMode at
  // turn start, which only happens when the tab is active anyway.
  useEffect(() => {
    contextManager.setForgeMode(forgeMode);
  }, [forgeMode, contextManager]);

  // Sync co-author flag with git module + shell interceptor
  useEffect(() => {
    setCoAuthorEnabled(coAuthorCommits);
    setShellCoAuthorEnabled(coAuthorCommits);
  }, [coAuthorCommits]);

  // Sync context window size to contextManager + status bar store.
  // Pin per model — never downgrade if API cache expires (prevents 1M→200k drop).
  const contextManagerRef = useRef(contextManager);
  contextManagerRef.current = contextManager;
  const pinnedContextWindow = useRef(new Map<string, number>());

  // Context window: show sync fallback immediately, then correct from async API data.
  // The sync fallback comes from hardcoded patterns (per-provider, never cross-provider).
  // The async fetch gets the real value from the provider API or OpenRouter metadata.
  const prevSyncedModel = useRef("");
  if (activeModel !== prevSyncedModel.current && activeModel !== "none") {
    prevSyncedModel.current = activeModel;
    const cached = pinnedContextWindow.current.get(activeModel);
    const sync = cached || getModelContextInfoSync(activeModel).tokens;
    pinnedContextWindow.current.set(activeModel, sync);
    contextManagerRef.current.setContextWindow(sync);
    if (visible) useStatusBarStore.getState().setContextWindow(sync);
  }

  // Async fetch — resolves the authoritative context window from provider API.
  // Replaces the sync fallback with real data when available.
  const activeModelForEffect = activeModel;
  useEffect(() => {
    if (activeModelForEffect === "none") return;
    let cancelled = false;
    getModelContextInfo(activeModelForEffect).then(({ tokens: accurate, source }) => {
      if (cancelled) return;
      const prev = pinnedContextWindow.current.get(activeModelForEffect) ?? 0;
      // API/OpenRouter data is authoritative — replace even if lower than fallback estimate.
      // Fallback data only upgrades (never downgrades) since it's a guess.
      const best = source !== "fallback" ? accurate : Math.max(prev, accurate);
      if (best !== prev) {
        pinnedContextWindow.current.set(activeModelForEffect, best);
        contextManagerRef.current.setContextWindow(best);
        if (visibleRef.current) useStatusBarStore.getState().setContextWindow(best);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeModelForEffect]);

  const [tokenUsage, setTokenUsageRaw] = useState<TokenUsage>(
    initialState?.tokenUsage ?? { ...ZERO_USAGE },
  );
  const sessionIdRef = useRef<string>(initialState?.sessionId ?? crypto.randomUUID());
  const customTitleRef = useRef<string | null>(null);
  const setCustomTitle = useCallback((title: string | null) => {
    customTitleRef.current = title;
  }, []);
  const sharedCacheRef = useRef<SharedCacheRef>(
    (() => {
      const ref: SharedCacheRef = {
        current: undefined,
        updateFile(absPath: string, content: string) {
          if (!ref.current) return;
          const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
          const rel = absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
          const key = normalizePath(rel);
          ref.current.files.set(key, content);
          for (const k of ref.current.toolResults.keys()) {
            if (k.includes(key)) ref.current.toolResults.delete(k);
          }
        },
      };
      return ref;
    })(),
  );

  useEffect(() => {
    return onFileEdited((absPath, content) => sharedCacheRef.current.updateFile(absPath, content));
  }, []);

  // First-run onboarding is now handled by the FirstRunWizard modal in App.tsx.

  // Streaming token estimation
  const streamingCharsRef = useRef(0);
  const toolCharsRef = useRef(0);
  const [streamingChars, setStreamingChars] = useState(0);
  const baseTokenUsageRef = useRef<TokenUsage>({ ...ZERO_USAGE });
  const tokenUsageRef = useRef(tokenUsage);
  tokenUsageRef.current = tokenUsage;

  // Latest step's tokens = actual context size + generation reported by the API
  const [contextTokens, setContextTokens] = useState(0);
  const [lastStepOutput, setLastStepOutput] = useState(0);
  const pendingContextTokens = useRef<number | null>(null);
  const pendingLastStepOutput = useRef<number | null>(null);

  const setTokenUsage: typeof setTokenUsageRaw = useCallback((action) => {
    setTokenUsageRaw((prev) => {
      const next = typeof action === "function" ? action(prev) : action;
      if (next.total === 0 || next.total < prev.total) {
        baseTokenUsageRef.current = { ...next };
        streamingCharsRef.current = 0;
        toolCharsRef.current = 0;
        if (next.total === 0) {
          setContextTokens(0);
          setStreamingChars(0);
        }
      }
      if (visibleRef.current)
        useStatusBarStore.getState().setTokenUsage(next, activeModelRef.current);
      return next;
    });
  }, []);

  // Plan mode
  const [pendingPlanReview, setPendingPlanReview] = useState<PendingPlanReview | null>(null);
  const pendingPlanReviewRef = useRef(pendingPlanReview);
  pendingPlanReviewRef.current = pendingPlanReview;
  const planPostActionRef = useRef<{
    action: "execute" | "clear_execute" | "cancel" | "revise";
    planContent: string | null;
    plan?: Plan;
    reviseFeedback?: string;
  } | null>(null);
  const planModeRef = useRef(initialState?.planMode ?? false);
  const planRequestRef = useRef<string | null>(initialState?.planRequest ?? null);
  const planExecutionRef = useRef(false);

  const coreCharsCache = useRef({ len: 0, chars: 0 });
  const coreChars = useMemo(() => {
    const cache = coreCharsCache.current;
    let sum = cache.len <= coreMessages.length ? cache.chars : 0;
    const start = cache.len <= coreMessages.length ? cache.len : 0;
    for (let i = start; i < coreMessages.length; i++) {
      const m = coreMessages[i] as ModelMessage;
      if (typeof m.content === "string") {
        sum += m.content.length;
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          sum +=
            typeof part === "object" && part !== null && "text" in part
              ? String((part as { text: string }).text).length
              : JSON.stringify(part).length;
        }
      }
    }
    coreCharsCache.current = { len: coreMessages.length, chars: sum };
    return sum;
  }, [coreMessages]);

  const chatChars = coreChars + streamingChars;

  useEffect(() => {
    if (visible) useStatusBarStore.getState().setContext(contextTokens, chatChars);
  }, [contextTokens, chatChars, visible]);

  // Sync tokenUsage + contextWindow to statusbar store when this tab becomes visible
  useEffect(() => {
    if (visible) {
      useStatusBarStore.getState().setTokenUsage(tokenUsageRef.current, activeModel);
      useStatusBarStore.getState().setCompacting(isCompactingRef.current);
      const ctxWindow = pinnedContextWindow.current.get(activeModel);
      if (ctxWindow) useStatusBarStore.getState().setContextWindow(ctxWindow);
    }
  }, [visible, activeModel]);

  const coreMessagesRef = useRef(coreMessages);
  coreMessagesRef.current = coreMessages;

  // Wrapped setter that eagerly updates the ref so callers reading
  // coreMessagesRef.current in the same tick see the new value.
  const setCoreMessagesEager: typeof setCoreMessages = useCallback((action) => {
    if (typeof action === "function") {
      setCoreMessages((prev) => {
        const next = action(prev);
        coreMessagesRef.current = next;
        return next;
      });
    } else {
      coreMessagesRef.current = action;
      setCoreMessages(action);
    }
  }, []);
  const activeModelRef = useRef(activeModel);
  activeModelRef.current = activeModel;
  const effectiveConfigRef = useRef(effectiveConfig);
  effectiveConfigRef.current = effectiveConfig;
  const [isCompacting, setIsCompacting] = useState(false);
  const isCompactingRef = useRef(false);
  const compactAbortRef = useRef<AbortController | null>(null);
  const pendingCompactRef = useRef(false);
  const initialStrategy =
    effectiveConfig.compaction?.strategy ?? DEFAULT_COMPACTION_CONFIG.strategy;
  const workingStateRef = useRef<WorkingStateManager | null>(
    initialStrategy === "v2" ? new WorkingStateManager(effectiveConfig.compaction) : null,
  );

  // Rehydrate v2 working state from restored session messages
  const didRehydrate = useRef(false);
  if (!didRehydrate.current && workingStateRef.current && initialState?.coreMessages?.length) {
    didRehydrate.current = true;
    const wsm = workingStateRef.current;
    for (const msg of initialState.coreMessages) {
      if (msg.role === "user") {
        extractFromUserMessage(wsm, msg);
      } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
        extractFromAssistantMessage(wsm, msg);
        for (const part of msg.content) {
          if (typeof part === "object" && "type" in part && part.type === "tool-call") {
            const tc = part as { toolName: string; input: Record<string, unknown> };
            extractFromToolCall(wsm, tc.toolName, tc.input);
          }
        }
      } else if (msg.role === "tool" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === "object" && "type" in part && part.type === "tool-result") {
            const tr = part as { toolName: string; output: unknown };
            extractFromToolResult(wsm, tr.toolName, tr.output);
          }
        }
      }
    }
  }
  const prevCompactionStrategy = useRef(effectiveConfig.compaction?.strategy);

  // Sync store on mount (useRef initializer doesn't trigger the change block)
  const didInitCompaction = useRef(false);
  if (!didInitCompaction.current) {
    didInitCompaction.current = true;
    if (visible) useStatusBarStore.getState().setCompactionStrategy(initialStrategy);
  }

  // React to compaction strategy changes: create/destroy WSM as needed
  if (effectiveConfig.compaction?.strategy !== prevCompactionStrategy.current) {
    prevCompactionStrategy.current = effectiveConfig.compaction?.strategy;
    const strategy = effectiveConfig.compaction?.strategy ?? DEFAULT_COMPACTION_CONFIG.strategy;
    if (visible) useStatusBarStore.getState().setCompactionStrategy(strategy);
    logCompaction("strategy-change", `Strategy → ${strategy}`);
    if (strategy === "v2") {
      workingStateRef.current = new WorkingStateManager(effectiveConfig.compaction);
    } else {
      workingStateRef.current = null;
      if (visible) useStatusBarStore.getState().setV2Slots(0);
    }
  }

  const syncV2SlotsRef = useRef(() => {
    if (workingStateRef.current && visibleRef.current) {
      useStatusBarStore.getState().setV2Slots(workingStateRef.current.slotCount());
    }
  });
  const syncV2Slots = syncV2SlotsRef.current;

  const handleSubmitRef = useRef<(input: string) => void>(() => {});
  // Stream stall watchdog state — persists across handleSubmit calls so
  // auto-retry "Continue." inherits the count from the previous attempt.
  const stallRetryCountRef = useRef<number>(0);
  const stallRetryPendingRef = useRef(false);
  // Per-turn token deltas captured from finish-step events. Reset at the start
  // of each handleSubmit run so the value emitted to the Hearth bridge in
  // turn-done reflects only this turn (not cumulative session totals).
  const turnTokensRef = useRef<{ input: number; output: number; cacheRead: number }>({
    input: 0,
    output: 0,
    cacheRead: 0,
  });
  const summarizeConversationRef = useRef<(opts?: { skipQueueDrain?: boolean }) => Promise<void>>(
    async () => {},
  );

  const summarizeConversation = useCallback(
    async (opts?: { skipQueueDrain?: boolean }) => {
      if (isCompactingRef.current) {
        // Already compacting — don't silently drop, queue for later
        pendingCompactRef.current = true;
        return;
      }

      // If a generation is in progress, defer compact until it settles
      if (abortRef.current) {
        pendingCompactRef.current = true;
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: "Compact queued — will run after current generation settles, then continue.",
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      // Snapshot coreMessages — must be a copy, not a live reference.
      // Without this, user input during async compaction mutates the array
      // and causes stale keepStart calculations + lost messages.
      const currentCore = [...coreMessagesRef.current];
      if (currentCore.length < 4) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: "Not enough conversation to compact (need at least 4 messages).",
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      isCompactingRef.current = true;
      setIsCompacting(true);
      if (visibleRef.current) useStatusBarStore.getState().setCompacting(true);

      // ── PreCompact hook ──
      runHooks({ event: "PreCompact", sessionId: sessionIdRef.current, cwd }).catch(() => {});

      const compactAbort = new AbortController();
      compactAbortRef.current = compactAbort;
      const startTime = Date.now();
      const compactTimer = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (visibleRef.current) useStatusBarStore.getState().setCompactElapsed(elapsed);
      }, 1000);

      try {
        const compactModelId = resolveTaskModel(
          "compact",
          effectiveConfig.taskRouter,
          activeModelRef.current,
        );
        const model = resolveModel(compactModelId);
        const modelLabel = getShortModelLabel(compactModelId);

        const contextWindow = await getModelContextWindow(activeModelRef.current);
        const charsPerToken = 3;
        const systemChars = (await contextManager.getContextBreakdown()).reduce(
          (sum, s) => sum + s.chars,
          0,
        );
        // Use the exact token counts already displayed in the context bar / topbar.
        // These come from the API's inputTokens — no char-based estimation needed.
        // When API tokens aren't available (dot not green), fall back to the same
        // char-based estimation the ContextBar uses so we don't show 0%.
        const barState = useStatusBarStore.getState();
        const beforePct =
          barState.contextTokens > 0 && contextWindow > 0
            ? Math.round((barState.contextTokens / contextWindow) * 100)
            : (() => {
                const totalChars = systemChars + barState.chatChars + barState.subagentChars;
                const estTokens = totalChars / charsPerToken;
                return estTokens > 0
                  ? Math.min(100, Math.max(1, Math.round((estTokens / contextWindow) * 100)))
                  : 0;
              })();

        const compactionCfg = effectiveConfig.compaction;
        const isV2 = compactionCfg?.strategy === "v2";
        const KEEP_RECENT = compactionCfg?.keepRecent ?? DEFAULT_COMPACTION_CONFIG.keepRecent ?? 4;
        let keepStart = Math.max(0, currentCore.length - KEEP_RECENT);
        // Never split between assistant tool-call and its tool-result pair
        while (keepStart > 0 && currentCore[keepStart]?.role === "tool") {
          keepStart--;
        }
        // After ackMsg (assistant), recentMessages must start with "user" to maintain alternation.
        // If it starts with "assistant", back up one more to include the preceding user message.
        if (keepStart > 0 && currentCore[keepStart]?.role === "assistant") {
          keepStart--;
        }
        const olderMessages = currentCore.slice(0, keepStart);
        const recentMessages = currentCore.slice(keepStart);

        if (olderMessages.length < 2) {
          isCompactingRef.current = false;
          setIsCompacting(false);
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content:
                "Not enough older messages to compact (recent messages are already preserved).",
              timestamp: Date.now(),
            },
          ]);
          return;
        }

        const strategyLabel = isV2 ? "v2 incremental" : modelLabel;
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: `Compacting ${olderMessages.length} messages with ${strategyLabel}...`,
            timestamp: Date.now(),
          },
        ]);

        const planContext = (() => {
          const plan = activePlanRef.current;
          if (!plan) return "";
          const lines = [`\n## Active Plan: ${plan.title}`];
          for (const step of plan.steps) {
            const icon =
              step.status === "done"
                ? "✓"
                : step.status === "active"
                  ? "▸"
                  : step.status === "skipped"
                    ? "⊘"
                    : "○";
            lines.push(`  ${icon} [${step.id}] ${step.label} — ${step.status}`);
          }
          return lines.join("\n");
        })();

        const {
          providerOptions,
          headers,
          contextWindow: compactCtxWindow,
        } = await buildProviderOptions(compactModelId, effectiveConfig);
        // Update pinned context window for the compaction model (authoritative from API)
        if (compactCtxWindow > 0) {
          pinnedContextWindow.current.set(compactModelId, compactCtxWindow);
        }

        let summary: string;
        let compactUsage:
          | {
              inputTokens: number;
              outputTokens: number;
              cacheReadTokens?: number;
              cacheWriteTokens?: number;
            }
          | undefined;

        if (isV2 && workingStateRef.current) {
          // The working state was built incrementally during the conversation.
          // Inject plan context if active, then serialize + optional gap-fill.
          const wsm = workingStateRef.current;
          if (activePlanRef.current) {
            wsm.setPlan(
              activePlanRef.current.steps.map((s) => ({
                id: s.id,
                label: s.label,
                status: s.status,
              })),
            );
          }
          let ioClient: import("../core/workers/io-client.js").IOClient | undefined;
          try {
            ioClient = getIOClient();
          } catch {}
          const v2Result = await buildV2Summary({
            wsm,
            olderMessages,
            model: compactionCfg?.llmExtraction !== false ? model : undefined,
            providerOptions,
            headers,
            skipLlm: compactionCfg?.llmExtraction === false,
            abortSignal: compactAbort.signal,
            ioClient,
          });
          summary = v2Result.summary;
          compactUsage = v2Result.usage;

          // Save to MemPalace if connected (fire-and-forget, never blocks compaction)
          const ws = wsm.getState();
          onCompaction(
            summary,
            {
              decisions: [...ws.decisions],
              discoveries: [...ws.discoveries],
              failures: [...ws.failures],
            },
            cwd,
          );

          // Write agent diary entry summarising this compaction chunk
          if (ws.task) {
            const diaryParts = [`TASK:${ws.task}`];
            if (ws.decisions.length > 0) diaryParts.push(`DECISIONS:${ws.decisions.join("|")}`);
            if (ws.discoveries.length > 0)
              diaryParts.push(`DISCOVERIES:${ws.discoveries.join("|")}`);
            if (ws.failures.length > 0) diaryParts.push(`FAILURES:${ws.failures.join("|")}`);
            diaryParts.push(`FILES:${[...ws.files.keys()].slice(0, 10).join("|")}`);
            writeDiary("forge", diaryParts.join("|"));
          }

          wsm.reset();
        } else {
          const formatMessage = (m: ModelMessage, charLimit: number) => {
            const role = m.role;
            if (typeof m.content === "string") {
              return `${role}: ${m.content.slice(0, charLimit)}`;
            }
            if (Array.isArray(m.content)) {
              const parts = m.content
                .map((p) => {
                  if (typeof p === "object" && p !== null) {
                    if ("text" in p)
                      return String((p as { text: string }).text).slice(0, charLimit);
                    if ("type" in p && (p as { type: string }).type === "tool-result") {
                      const tr = p as { toolName?: string; result?: unknown };
                      const resultStr = tr.result != null ? JSON.stringify(tr.result) : "null";
                      return `[tool-result: ${tr.toolName ?? "unknown"} → ${resultStr.slice(0, 8000)}]`;
                    }
                  }
                  return JSON.stringify(p).slice(0, 3000);
                })
                .join("\n");
              return `${role}: ${parts}`;
            }
            return `${role}: [complex content]`;
          };

          const convoText = olderMessages.map((m) => formatMessage(m, 6000)).join("\n\n");

          const v1Result = await generateText({
            model,
            ...(supportsTemperature(activeModelRef.current) ? { temperature: 0 } : {}),
            maxOutputTokens: 8192,
            abortSignal: compactAbort.signal,
            ...(providerOptions && Object.keys(providerOptions).length > 0
              ? { providerOptions }
              : {}),
            ...(headers ? { headers } : {}),
            prompt: [
              "You are summarizing the older portion of a coding assistant conversation.",
              "The most recent messages will be preserved verbatim — focus on summarizing what came before.",
              "Output ONLY the structured summary below. Do not include any meta-commentary about the summarization process.",
              "",
              "Create a structured summary with these sections:",
              "",
              "## Environment",
              "Project type, key technologies, working directory, any config details mentioned.",
              "",
              "## Files Touched",
              "Every file path that was read, edited, or created. For EDITS: include the specific old→new changes (function signatures, variable names, logic). For READS: note key content found.",
              "",
              "## Tool Results",
              "Key tool results that inform future decisions: grep matches, test output, diagnostics, build errors. Include literal output where it matters — don't just say 'tests passed', say which tests and any warnings.",
              "",
              "## Key Decisions",
              "Architectural choices, design patterns chosen, trade-offs discussed.",
              "",
              "## Work Completed",
              "What was accomplished. Include specific function names, variable names, code patterns.",
              "",
              "## Errors & Resolutions",
              "Problems encountered and how they were resolved. Include the actual error messages.",
              "",
              "## Current State",
              "What was being worked on at the end of this section. What remains to be done.",
              planContext
                ? `\n${planContext}\nINCLUDE the plan progress above VERBATIM in ## Current State so the agent knows which steps are done/active/pending.`
                : "",
              "",
              "Be thorough — preserve specific details (file contents, error messages, code changes).",
              "CRITICAL: Preserve specific details from tool results (file contents, error messages, test output). Generic summaries like 'edited file X' are useless — include WHAT was changed.",
              "",
              "CONVERSATION TO SUMMARIZE:",
              convoText,
            ].join("\n"),
          });
          summary = v1Result.text;
          const v1u = v1Result.usage;
          if (v1u) {
            const v1Details = (
              v1u as { inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } }
            ).inputTokenDetails;
            compactUsage = {
              inputTokens: v1u.inputTokens ?? 0,
              outputTokens: v1u.outputTokens ?? 0,
              cacheReadTokens: v1Details?.cacheReadTokens ?? 0,
              cacheWriteTokens: v1Details?.cacheWriteTokens ?? 0,
            };
          }
        }

        if (!summary || summary.trim().length < 50) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content:
                "Compaction produced an empty or too-short summary — aborting to preserve context.",
              timestamp: Date.now(),
            },
          ]);
          return;
        }

        const summaryMsg: ModelMessage = {
          role: "user" as const,
          content: summary,
        };

        const ackMsg: ModelMessage = {
          role: "assistant" as const,
          content: "Continuing.",
        };

        // Structural validation of recentMessages.
        // After compaction, messages may have broken invariants:
        // 1. Orphaned tool_result at the start (no preceding assistant with tool_use)
        // 2. Two user messages in a row after ackMsg (assistant) + recentMessages[0] (user skipped, next is user)
        // 3. tool messages in the middle without their assistant counterpart
        //
        // Fix: drop leading tool messages, then ensure alternation is valid.
        let validStart = 0;
        for (let i = 0; i < recentMessages.length; i++) {
          if (recentMessages[i]?.role === "tool") {
            validStart = i + 1;
          } else {
            break;
          }
        }
        // After ackMsg (assistant), next must be user or tool-with-assistant.
        // If recentMessages starts with assistant, drop it to avoid assistant→assistant.
        if (
          validStart < recentMessages.length &&
          recentMessages[validStart]?.role === "assistant"
        ) {
          validStart++;
        }
        const validRecent = validStart > 0 ? recentMessages.slice(validStart) : recentMessages;

        // Final pass: strip any remaining orphaned tool messages throughout.
        // A tool message is valid only if preceded by an assistant message.
        const sanitized: typeof validRecent = [];
        for (const msg of validRecent) {
          if (msg.role === "tool") {
            const prev = sanitized[sanitized.length - 1];
            if (!prev || prev.role !== "assistant") continue; // drop orphan
          }
          sanitized.push(msg);
        }

        // If sanitization removed everything, keep at least one recent user message
        // to maintain valid conversation structure.
        if (sanitized.length === 0) {
          const lastUser = recentMessages.findLast((m) => m.role === "user");
          if (lastUser) sanitized.push(lastUser);
        }

        const newMessages = [summaryMsg, ackMsg, ...sanitized];
        setCoreMessages(newMessages);
        emitCacheReset(); // Old read results are gone — allow re-reads
        const trackedFiles = contextManager.getTrackedFiles();
        contextManager.resetForCompaction();
        for (const f of trackedFiles.edited) {
          try {
            contextManager.onFileChanged(f);
          } catch {
            // File may have been deleted — skip re-tracking
          }
        }
        for (const f of trackedFiles.mentioned) contextManager.trackMentionedFile(f);
        reprimeContextFromMessages(contextManager, sanitized);

        const newCoreChars = newMessages.reduce((sum, m) => {
          if (typeof m.content === "string") return sum + m.content.length;
          if (Array.isArray(m.content)) {
            return (
              sum + m.content.reduce((s: number, p: unknown) => s + JSON.stringify(p).length, 0)
            );
          }
          return sum;
        }, 0);
        const afterChars = systemChars + newCoreChars;
        const afterPct = Math.round((afterChars / charsPerToken / contextWindow) * 100);
        const estimatedTokens = Math.ceil(afterChars / charsPerToken);
        setContextTokens(0);
        setStreamingChars(0);
        setTokenUsage((prev) => {
          let bd = prev.modelBreakdown;
          if (compactUsage) {
            // SDK inputTokens = total prompt (noCache + cacheRead + cacheWrite).
            // Split so cache-read tokens are billed at the cache-read rate (10× cheaper)
            // instead of the full input rate. Without this, compaction over-bills ~10×.
            const cacheRead = compactUsage.cacheReadTokens ?? 0;
            const cacheWrite = compactUsage.cacheWriteTokens ?? 0;
            const noCache = Math.max(0, compactUsage.inputTokens - cacheRead - cacheWrite);
            bd = accumulateModelUsage(bd, compactModelId, {
              input: noCache,
              output: compactUsage.outputTokens,
              cacheRead,
              cacheWrite,
            });
          }
          return {
            ...ZERO_USAGE,
            prompt: estimatedTokens,
            total: estimatedTokens,
            cacheRead: prev.cacheRead,
            cacheWrite: prev.cacheWrite,
            subagentInput: prev.subagentInput,
            subagentOutput: prev.subagentOutput,
            modelBreakdown: bd,
          };
        });

        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: `Context optimized (${beforePct}% → ${afterPct}%).`,
            timestamp: Date.now(),
          },
        ]);

        logCompaction("compact", `${beforePct}% → ${afterPct}%`, {
          model: modelLabel,
          strategy: isV2 ? "v2" : "v1",
          slotsBefore:
            isV2 && workingStateRef.current ? workingStateRef.current.slotCount() : undefined,
          contextBefore: `${beforePct}%`,
          contextAfter: `${afterPct}%`,
          messagesBefore: currentCore.length,
          messagesAfter: newMessages.length,
          summaryLength: summary.length,
          summarySnippet: summary.slice(0, 2000),
        });
        // ── PostCompact hook ──
        runHooks({ event: "PostCompact", sessionId: sessionIdRef.current, cwd }).catch(() => {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logBackgroundError("compact", msg);
        logCompaction("error", msg);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: `Failed to compact: ${msg}`,
            timestamp: Date.now(),
          },
        ]);
      } finally {
        clearInterval(compactTimer);
        compactAbortRef.current = null;
        isCompactingRef.current = false;
        setIsCompacting(false);
        // Always reset WSM — prevents corrupted state from failed compactions
        // leaking into subsequent conversation extraction.
        const wsm = workingStateRef.current;
        if (wsm) wsm.reset();
        if (visibleRef.current) useStatusBarStore.getState().setCompacting(false);
        if (!opts?.skipQueueDrain) {
          setMessageQueue((queue) => {
            if (queue.length > 0) {
              const [next, ...rest] = queue;
              if (next) {
                setTimeout(() => handleSubmitRef.current(next.content), 0);
              }
              return rest;
            }
            return queue;
          });
        }
      }
    },
    [setTokenUsage, effectiveConfig, contextManager, cwd],
  );
  summarizeConversationRef.current = summarizeConversation;

  const autoSummarizedRef = useRef(false);
  useEffect(() => {
    if (effectiveConfig.compaction?.strategy === "disabled") return;
    if (activeModelRef.current === "none") return;
    if (contextTokens <= 0) return;
    // Only use pinned value (set by async fetch). If async hasn't resolved yet,
    // skip this check — better to delay compaction than trigger on a wrong fallback.
    const ctxWindow = pinnedContextWindow.current.get(activeModelRef.current);
    if (!ctxWindow) return;
    const pct = contextTokens / ctxWindow;
    const triggerAt =
      effectiveConfig.compaction?.triggerThreshold ??
      DEFAULT_COMPACTION_CONFIG.triggerThreshold ??
      0.7;
    const resetAt =
      effectiveConfig.compaction?.resetThreshold ?? DEFAULT_COMPACTION_CONFIG.resetThreshold ?? 0.4;
    if (pct > triggerAt && !autoSummarizedRef.current && coreMessagesRef.current.length >= 6) {
      autoSummarizedRef.current = true;
      const strategy = effectiveConfig.compaction?.strategy === "v2" ? "v2" : "v1";
      logCompaction(
        "auto-trigger",
        `Context at ${Math.round(pct * 100)}% — strategy: ${strategy}`,
        {
          contextBefore: `${Math.round(pct * 100)}%`,
          messagesBefore: coreMessagesRef.current.length,
        },
      );
      summarizeConversation();
    }
    if (pct < resetAt) {
      autoSummarizedRef.current = false;
    }
  }, [
    contextTokens,
    summarizeConversation,
    effectiveConfig.compaction?.triggerThreshold,
    effectiveConfig.compaction?.resetThreshold,
    effectiveConfig.compaction?.strategy,
  ]);

  interface RemoteApprovalPayload {
    tool: string;
    summary: string;
  }
  function createPermissionPrompt(
    autoApproveRef: React.MutableRefObject<boolean>,
    mutexRef: React.MutableRefObject<Promise<void>>,
    questionFn: (...args: string[]) => string,
    remotePayload?: (...args: string[]) => RemoteApprovalPayload,
  ) {
    return (...args: string[]): Promise<boolean> => {
      if (autoApproveRef.current) return Promise.resolve(true);
      const result = mutexRef.current.then(() => {
        if (autoApproveRef.current) return true;
        return new Promise<boolean>((resolve) => {
          let done = false;
          let remoteCancel: (() => void) | null = null;
          const settle = (allowed: boolean, fromLocal: boolean, isAlways: boolean): void => {
            if (done) return;
            done = true;
            if (fromLocal) setPendingQuestion(null);
            if (isAlways) autoApproveRef.current = true;
            // Local settle (user answered or abort skipped) kills any
            // outstanding remote callback so Telegram's button doesn't
            // outlive the turn.
            if (fromLocal && remoteCancel) remoteCancel();
            resolve(allowed);
          };
          setPendingQuestion({
            id: crypto.randomUUID(),
            question: questionFn(...args),
            options: [
              { label: "Allow", value: "allow" },
              { label: "Allow all (session)", value: "always" },
              { label: "Deny", value: "deny" },
            ],
            allowSkip: false,
            resolve: (answer: string) => {
              // abort()/unmount resolves with "__skipped__" — treat as deny
              // (no "Allow all" promotion). Any other non-allow value: deny.
              const allowed = answer === "allow" || answer === "always";
              settle(allowed, true, answer === "always");
            },
          });
          if (remotePayload) {
            const payload = remotePayload(...args);
            void import("../hearth/bridge.js").then(
              ({ askRemote, cancelRemoteCallbacksForTab }) => {
                if (done) return;
                remoteCancel = () => cancelRemoteCallbacksForTab(tabId);
                remoteApprovalActiveRef.current++;
                void askRemote<string>(
                  tabId,
                  (callbackId) => ({
                    type: "approval-request",
                    callbackId,
                    tool: payload.tool,
                    summary: payload.summary,
                  }),
                  "",
                )
                  .then((answer) => {
                    if (done) return;
                    if (answer === "allow") {
                      setPendingQuestion(null);
                      settle(true, false, false);
                    } else if (answer === "deny") {
                      setPendingQuestion(null);
                      settle(false, false, false);
                    }
                    // Any other value (empty from offline-fallback/timeout/cancel):
                    // leave local TUI prompt as the sole authority.
                  })
                  .finally(() => {
                    remoteApprovalActiveRef.current = Math.max(
                      0,
                      remoteApprovalActiveRef.current - 1,
                    );
                  });
              },
            );
          }
        });
      });
      mutexRef.current = result.then(() => {});
      return result;
    };
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const promptWebSearchApproval = useCallback(
    createPermissionPrompt(
      autoApproveWebAccessRef,
      webAccessMutexRef,
      (query) => `Forge wants to access the web:\n\nSearch: "${query}"`,
      (query) => ({
        tool: "web_search",
        summary: `Web search: ${query.slice(0, 120)}`,
      }),
    ),
    [],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const promptFetchPageApproval = useCallback(
    createPermissionPrompt(
      autoApproveWebAccessRef,
      webAccessMutexRef,
      (url) => `Forge wants to access the web:\n\nFetch: ${url}`,
      (url) => ({
        tool: "fetch_page",
        summary: `Fetch page: ${url.slice(0, 140)}`,
      }),
    ),
    [],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const promptOutsideCwd = useCallback(
    createPermissionPrompt(
      autoApproveOutsideCwdRef,
      outsideCwdMutexRef,
      (toolName, path) => `Forge wants to ${toolName} outside project directory:\n\n${path}`,
    ),
    [],
  );

  const promptDestructive = useCallback((description: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setPendingQuestion({
        id: crypto.randomUUID(),
        question: `⚠ Potentially destructive action:\n\n${description}`,
        options: [
          { label: "Allow", value: "allow" },
          { label: "Deny", value: "deny" },
        ],
        allowSkip: false,
        resolve: (answer: string) => {
          setPendingQuestion(null);
          resolve(answer === "allow");
        },
      });
    });
  }, []);

  // Interactive callbacks for plan/question tools
  const interactiveCallbacks = useMemo<InteractiveCallbacks>(
    () => ({
      onPlanCreate: (plan: Plan) => {
        setActivePlan(plan);
        setSidebarPlan(plan);
      },
      onPlanStepUpdate: (stepId: string, status: PlanStepStatus) => {
        if (status === "active") clearTasks(tabId);
        const updater = (prev: Plan | null) => {
          if (!prev) return prev;
          return {
            ...prev,
            steps: prev.steps.map((s) =>
              s.id === stepId
                ? { ...s, status, ...(status === "active" ? { startedAt: Date.now() } : {}) }
                : s,
            ),
          };
        };
        setActivePlan(updater);
        setSidebarPlan(updater);
      },
      onPlanReview: (plan: Plan, planFile: string, planContent: string) => {
        return new Promise<PlanReviewAction>((resolve) => {
          let done = false;
          const applyAction = async (action: PlanReviewAction): Promise<void> => {
            if (action === "execute" || action === "clear_execute") {
              let content: string | null = null;
              try {
                content = await readFile(
                  join(cwd, ".soulforge", "plans", planFileName(sessionIdRef.current)),
                  "utf-8",
                );
              } catch {
                content = planContent;
              }
              planPostActionRef.current = {
                action: action === "clear_execute" ? "clear_execute" : "execute",
                planContent: content,
                plan,
              };
            } else if (action === "cancel") {
              planPostActionRef.current = { action: "cancel", planContent: null, plan };
            } else {
              planPostActionRef.current = {
                action: "revise",
                planContent: null,
                reviseFeedback: action,
              };
            }
          };
          const settle = (action: PlanReviewAction): void => {
            if (done) return;
            done = true;
            setPendingPlanReview(null);
            void applyAction(action).then(() => {
              resolve(action);
              abortRef.current?.abort();
            });
          };
          setPendingPlanReview({
            plan,
            planFile,
            planContent,
            resolve: (action: PlanReviewAction) => settle(action),
          });
          // Race remote bridge. Remote reply resolves into `settle` → same
          // plan-post-action flow as TUI approval.
          void import("../hearth/bridge.js").then(({ askRemote }) => {
            if (done) return;
            void askRemote<string>(
              tabId,
              (callbackId) => ({
                type: "plan-review",
                callbackId,
                title: plan.title,
                summary: `${String(plan.steps.length)} step(s)`,
              }),
              "",
            ).then((answer) => {
              if (!answer) return;
              // Valid plan-review actions: execute / clear_execute / cancel / revise:<text>
              const action: PlanReviewAction =
                answer === "execute" || answer === "clear_execute" || answer === "cancel"
                  ? answer
                  : answer;
              settle(action);
            });
          });
        });
      },
      onAskUser: (question, options, allowSkip) => {
        // Race TUI prompt against remote bridge prompt. Whichever resolves first
        // wins; the loser is cancelled via setPendingQuestion(null).
        return new Promise<string>((resolve) => {
          let done = false;
          const settle = (v: string): void => {
            if (done) return;
            done = true;
            setPendingQuestion(null);
            resolve(v);
          };
          setPendingQuestion({
            id: crypto.randomUUID(),
            question,
            options,
            allowSkip,
            resolve: (answer) => settle(answer),
          });
          void import("../hearth/bridge.js").then(({ askRemote }) => {
            if (done) return;
            void askRemote<string>(
              tabId,
              (callbackId) => ({
                type: "ask-user",
                callbackId,
                question,
                options: [...options],
                allowSkip,
              }),
              "",
            ).then((answer) => {
              if (answer) settle(answer);
            });
          });
        });
      },
      onOpenEditor: async (file?: string) => {
        if (file) {
          openEditorWithFile(file);
        } else {
          openEditor();
        }
      },
      onWebSearchApproval: (query: string) => promptWebSearchApproval(query),
      onFetchPageApproval: (url: string) => promptFetchPageApproval(url),
    }),
    [
      openEditor,
      openEditorWithFile,
      cwd,
      setActivePlan,
      promptWebSearchApproval,
      promptFetchPageApproval,
      tabId,
    ],
  );

  const handleSubmit = useCallback(
    async (
      input: string,
      images?: ImageAttachment[],
      opts?: { inboundId?: string; origin?: ChatMessage["origin"] },
    ) => {
      // Read current config via ref — effectiveConfig object is NOT in deps
      // (new object every render would force constant callback recreation)
      const effectiveConfig = effectiveConfigRef.current;
      // Concurrency guard — prevent dual-stream corruption if called while streaming
      if (abortRef.current) return;

      if (activeModelRef.current === "none") {
        const hint: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content:
            "No model selected. Press **Ctrl+L** or type **/model** to choose a provider and model.",
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, hint]);
        return;
      }

      // ── UserPromptSubmit hook ──
      if (hasToolHooks(cwd)) {
        const hookResult = await runHooks({
          event: "UserPromptSubmit",
          toolInput: { prompt: input },
          sessionId: sessionIdRef.current,
          cwd,
        });
        if (hookResult.blocked) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: `[Hook blocked] ${hookResult.reason ?? "Prompt blocked by hook"}`,
              timestamp: Date.now(),
            },
          ]);
          return;
        }
      }

      // Reset per-turn token accumulator so the Hearth bridge turn-done
      // reflects only THIS turn, not cumulative session totals.
      turnTokensRef.current = { input: 0, output: 0, cacheRead: 0 };

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: input,
        timestamp: Date.now(),
        images: images && images.length > 0 ? images : undefined,
        // Origin is stamped synchronously at message creation time — no post-submit
        // scan required, so rapid-fire inbound messages can never land on the
        // wrong row.
        origin: opts?.origin,
      };
      setMessages((prev) => {
        const allMsgs = [...prev, userMsg];
        // Persist immediately after user sends — crash-safe checkpoint
        queueMicrotask(() => {
          try {
            const snapshot = getWorkspaceSnapshot?.();
            if (!snapshot) return;
            const { meta, tabMessages, tabCoreMessages } = buildSessionMeta({
              sessionId: sessionIdRef.current,
              title: customTitleRef.current ?? SessionManager.deriveTitle(allMsgs),
              customTitle: customTitleRef.current,
              cwd,
              snapshot,
              currentTabMessages: allMsgs.filter((m) => m.role !== "system" || m.showInChat),
              currentTabCoreMessages: coreMessagesRef.current,
            });
            updateEmergencySnapshot(sessionManager, meta, tabMessages, tabCoreMessages);
            sessionManager.saveSession(meta, tabMessages, tabCoreMessages).catch(() => {});
          } catch {
            // Don't let checkpoint failures interrupt the request
          }
        });
        return allMsgs;
      });

      const currentCoreMessages = coreMessagesRef.current;
      // Build user content: text + optional image parts for multimodal models
      let userContent: string | Array<TextPart | ImagePart>;
      if (images && images.length > 0) {
        const parts: Array<TextPart | ImagePart> = [{ type: "text" as const, text: input }];
        for (const img of images) {
          const raw = Buffer.from(img.base64, "base64");
          const { data, mediaType } = await compressImageForApi(raw, img.mediaType);
          parts.push({
            type: "image" as const,
            image: data,
            mediaType,
          });
        }
        userContent = parts;
      } else {
        userContent = input;
      }
      const userCoreMsg: ModelMessage = { role: "user" as const, content: userContent };
      // Sanitize: strip empty assistant text blocks that would cause Anthropic to reject.
      // These can persist from prior sessions or aborted streams.
      const sanitized = currentCoreMessages.filter((m, i, arr) => {
        if (m.role !== "assistant") return true;
        if (typeof m.content === "string" && m.content.length === 0) {
          // Keep if next message is a tool message (assistant→tool pairing required)
          return arr[i + 1]?.role === "tool";
        }
        if (Array.isArray(m.content) && m.content.length === 0) {
          return arr[i + 1]?.role === "tool";
        }
        return true;
      });
      const newCoreMessages: ModelMessage[] = [...sanitized, userCoreMsg];
      setCoreMessages(newCoreMessages);

      if (workingStateRef.current) {
        extractFromUserMessage(workingStateRef.current, userCoreMsg);
        syncV2Slots();
      }

      const estimatedTokens = tokenUsageRef.current.total;
      contextManager.updateConversationContext(input, estimatedTokens);

      setPendingPlanReview(null);
      streamSegmentsBuffer.current = [];
      liveToolCallsBuffer.current = [];
      lastFlushedSegments.current = [];
      lastFlushedToolCalls.current = [];
      lastFlushedStreamingChars.current = 0;
      setStreamSegments([]);
      setLiveToolCalls([]);
      if (!planExecutionRef.current) {
        setActivePlan(null);
        setSidebarPlan(null);
      }
      setPendingQuestion(null);

      // Capture pre-stream token baseline for live estimation
      streamingCharsRef.current = 0;
      toolCharsRef.current = 0;
      const currentUsage = tokenUsageRef.current;
      baseTokenUsageRef.current = { ...currentUsage };

      // Abort controller for Ctrl+X
      let abortController: AbortController;

      let fullText = "";
      let lastIncrementalSave = 0;
      const completedCalls: import("../types/index.js").ToolCall[] = [];
      const finalSegments: MessageSegment[] = [];

      // Track subagent token usage and aggregate into the main total
      const subagentCumulative = new Map<
        string,
        { input: number; output: number; cache: number; cacheWrite: number }
      >();
      const completedResultChars = new Map<string, number>();

      // All values in chars for consistent units with ContextBar (divides by CHARS_PER_TOKEN)
      const updateSubagentChars = () => {
        let total = 0;
        for (const chars of completedResultChars.values()) total += chars;
        for (const [id, stats] of subagentCumulative) {
          if (!completedResultChars.has(id)) total += stats.output * 4;
        }
        if (visibleRef.current) useStatusBarStore.getState().setSubagentChars(total);
      };

      const isOurDispatch = (parentToolCallId: string) =>
        liveToolCallsBuffer.current.some((c) => c.id === parentToolCallId);

      const unsubAgentStats = onAgentStats((event) => {
        if (!isOurDispatch(event.parentToolCallId)) return;
        useStatusBarStore.getState().upsertDispatchAgent(event.parentToolCallId, {
          agentId: event.agentId,
          modelId: event.modelId,
          toolUses: event.toolUses,
          input: event.tokenUsage.input,
          output: event.tokenUsage.output,
          cacheRead: event.cacheHits ?? 0,
          cacheWrite: event.cacheWrite ?? 0,
        });
        const prev = subagentCumulative.get(event.agentId) ?? {
          input: 0,
          output: 0,
          cache: 0,
          cacheWrite: 0,
        };
        const deltaIn = event.tokenUsage.input - prev.input;
        const deltaOut = event.tokenUsage.output - prev.output;
        const deltaCache = (event.cacheHits ?? 0) - prev.cache;
        const deltaCacheWrite = (event.cacheWrite ?? 0) - prev.cacheWrite;
        subagentCumulative.set(event.agentId, {
          input: event.tokenUsage.input,
          output: event.tokenUsage.output,
          cache: event.cacheHits ?? 0,
          cacheWrite: event.cacheWrite ?? 0,
        });
        if (deltaIn > 0 || deltaOut > 0 || deltaCache > 0 || deltaCacheWrite > 0) {
          const base = baseTokenUsageRef.current;
          const subModelId = event.modelId ?? "unknown";
          // inputTokens from SDK = total (noCache + cacheRead + cacheWrite).
          // Subtract cache tokens to get uncached input only — same as main agent path.
          const uncachedIn = Math.max(
            0,
            deltaIn -
              (deltaCache > 0 ? deltaCache : 0) -
              (deltaCacheWrite > 0 ? deltaCacheWrite : 0),
          );
          const newUsage: TokenUsage = {
            ...base,
            total: base.total + deltaIn + deltaOut,
            subagentInput: base.subagentInput + uncachedIn,
            subagentOutput: base.subagentOutput + deltaOut,
            cacheRead: base.cacheRead + (deltaCache > 0 ? deltaCache : 0),
            cacheWrite: base.cacheWrite + (deltaCacheWrite > 0 ? deltaCacheWrite : 0),
            modelBreakdown: accumulateModelUsage(base.modelBreakdown, subModelId, {
              input: uncachedIn,
              output: deltaOut,
              cacheRead: deltaCache > 0 ? deltaCache : 0,
              cacheWrite: deltaCacheWrite > 0 ? deltaCacheWrite : 0,
            }),
          };
          pendingTokenUsage.current = newUsage;
          baseTokenUsageRef.current = newUsage;
          updateSubagentChars();
          toolCallsDirty.current = true;
          queueMicrotaskFlush();
        }
      });

      const unsubMultiAgent = onMultiAgentEvent((event) => {
        if (!isOurDispatch(event.parentToolCallId)) return;
        // ── Per-agent snapshot for /context Dispatch tab ──
        if (event.type === "dispatch-start") {
          useStatusBarStore
            .getState()
            .startDispatch(event.parentToolCallId, event.totalAgents ?? 0);
        }
        if (event.type === "agent-start" && event.agentId) {
          useStatusBarStore.getState().upsertDispatchAgent(event.parentToolCallId, {
            agentId: event.agentId,
            role: event.role,
            modelId: event.modelId,
            tier: event.tier,
            task: event.task,
            state: "running",
          });
          // ── SubagentStart hook ──
          runHooks({
            event: "SubagentStart",
            toolInput: { agent_id: event.agentId, agent_type: event.role },
            sessionId: sessionIdRef.current,
            cwd,
          }).catch(() => {});
        }
        if ((event.type === "agent-done" || event.type === "agent-error") && event.agentId) {
          useStatusBarStore.getState().upsertDispatchAgent(event.parentToolCallId, {
            agentId: event.agentId,
            role: event.role,
            modelId: event.modelId,
            tier: event.tier,
            task: event.task,
            toolUses: event.toolUses,
            ...(event.tokenUsage
              ? { input: event.tokenUsage.input, output: event.tokenUsage.output }
              : {}),
            ...(event.cacheHits != null ? { cacheRead: event.cacheHits } : {}),
            succeeded: event.succeeded,
            state: event.type === "agent-error" ? "error" : "done",
          });
        }
        if (event.type === "agent-done" && event.agentId) {
          runHooks({
            event: "SubagentStop",
            toolInput: { agent_id: event.agentId, agent_type: event.role },
            sessionId: sessionIdRef.current,
            cwd,
          }).catch(() => {});
          completedResultChars.set(event.agentId, event.resultChars ?? 0);
          updateSubagentChars();
          toolCallsDirty.current = true;
          queueMicrotaskFlush();
        }
        if (event.type === "dispatch-done") {
          useStatusBarStore.getState().finishDispatch(event.parentToolCallId);
          completedResultChars.clear();
          subagentCumulative.clear();
          if (visibleRef.current) useStatusBarStore.getState().setSubagentChars(0);
          toolCallsDirty.current = true;
          queueMicrotaskFlush();
        }
      });

      const unsubToolProgress = onToolProgress((event) => {
        const tc = liveToolCallsBuffer.current.find((c) => c.id === event.toolCallId);
        if (tc && tc.state === "running") {
          tc.progressText = event.text;
          toolCallsDirty.current = true;
          queueMicrotaskFlush();
        }
      });

      // Steering messages are now flushed immediately in drainSteering —
      // no longer accumulated and appended at the end.

      // Stream stall watchdog — hoisted so catch/finally can access.
      // Initialized after stream starts; no-ops if stream never starts.
      const STALL_MAX_RETRIES = resolveRetrySettings(effectiveConfig.retry).maxRetries;
      let stallWatchdog: ReturnType<typeof setInterval> | null = null;
      let unsubStallWatch1: (() => void) | null = null;
      let unsubStallWatch2: (() => void) | null = null;
      let unsubStallWatch3: (() => void) | null = null;
      let userAborted = false;
      let stallTriggered = false; // only true when the watchdog itself fires
      let stallAborted = false; // true when abort is from stall watchdog
      // Resolve retry settings once at handleSubmit scope so they're accessible
      // in both the retry loop AND the outer catch block for streaming errors.
      const { maxRetries: MAX_TRANSIENT_RETRIES, baseDelayMs: RETRY_BASE_DELAY_MS } =
        resolveRetrySettings(effectiveConfig.retry);
      let streamRetryCount = 0; // local retry counter (not a ref)
      // Reset retry count on real user messages (not auto-retry "Continue.")
      if (input !== "Continue." || !stallRetryPendingRef.current) {
        stallRetryCountRef.current = 0;
      }
      stallRetryPendingRef.current = false;

      const responseStartedAt = Date.now();

      for (;;) {
        // Reset state for retry
        let proxyBounced = false;
        abortController = new AbortController();
        abortRef.current = abortController;
        fullText = "";
        completedCalls.length = 0;
        finalSegments.length = 0;
        subagentCumulative.clear();
        completedResultChars.clear();

        try {
          setIsLoading(true);
          const modelId = activeModelRef.current;
          const model = resolveModel(modelId);

          // Resolve subagent models from task router
          // spark/ember are primary; coding/exploration/trivial are legacy config fallbacks
          const tr = effectiveConfig.taskRouter;
          const sparkModelId = tr?.spark ?? tr?.exploration ?? tr?.trivial ?? undefined;
          const emberModelId = tr?.ember ?? tr?.coding ?? undefined;
          const webSearchModelId = tr?.webSearch ?? undefined;
          const desloppifyModelId = tr?.desloppify ?? undefined;
          const verifyModelId = tr?.verify ?? undefined;
          const hasSubagentModels =
            sparkModelId || emberModelId || desloppifyModelId || verifyModelId;
          const subagentModels = hasSubagentModels
            ? {
                spark: sparkModelId ? resolveModel(sparkModelId) : undefined,
                ember: emberModelId ? resolveModel(emberModelId) : undefined,
                desloppify: desloppifyModelId ? resolveModel(desloppifyModelId) : undefined,
                verify: verifyModelId ? resolveModel(verifyModelId) : undefined,
              }
            : undefined;
          const webSearchModel = webSearchModelId ? resolveModel(webSearchModelId) : undefined;
          webSearchModelLabelRef.current = webSearchModelId
            ? getShortModelLabel(webSearchModelId)
            : null;

          // Web access: when disabled, null out both approval AND model so the tool is inert
          const webSearchEnabled = effectiveConfig.webSearch !== false;
          const webSearchApproval = webSearchEnabled
            ? interactiveCallbacks.onWebSearchApproval
            : undefined;
          const fetchPageApproval = interactiveCallbacks.onFetchPageApproval;
          const effectiveWebSearchModel = webSearchEnabled ? webSearchModel : undefined;

          // Build providerOptions (thinking, effort, context management)
          const {
            providerOptions,
            headers,
            contextWindow: fetchedCtxWindow,
          } = await buildProviderOptions(modelId, effectiveConfig);
          // Propagate accurate context window from provider metadata (authoritative)
          if (fetchedCtxWindow > 0) {
            const prev = pinnedContextWindow.current.get(modelId) ?? 0;
            if (fetchedCtxWindow !== prev) {
              pinnedContextWindow.current.set(modelId, fetchedCtxWindow);
              contextManagerRef.current.setContextWindow(fetchedCtxWindow);
              if (visibleRef.current)
                useStatusBarStore.getState().setContextWindow(fetchedCtxWindow);
            }
          }

          steeringAbortedRef.current = false;
          /**
           * flushBeforeSteering — commit accumulated assistant content + steering
           * messages into the messages list so the UI shows:
           *   <previous assistant response> → <steering> → <new streaming>
           * instead of lumping steering before the final combined response.
           */
          const flushBeforeSteering = (steeringMsgs: ChatMessage[]) => {
            // Merge completed tool calls + in-progress ones from the live buffer
            const completedIds = new Set(completedCalls.map((c) => c.id));
            const livePending = liveToolCallsBuffer.current
              .filter((tc) => !completedIds.has(tc.id))
              .map((tc) => ({
                id: tc.id,
                name: tc.toolName,
                args: safeParseArgs(tc.args),
                ...(tc.state === "done" && tc.result
                  ? { result: { success: true as const, output: tc.result } }
                  : tc.state === "error" && tc.error
                    ? { result: { success: false as const, output: tc.error, error: tc.error } }
                    : {}),
              }));
            const allCalls = [...completedCalls, ...livePending];
            const hasContent = hasRenderableAssistantContent({
              fullText,
              toolCallCount: allCalls.length,
              segments: finalSegments,
            });

            if (!hasContent) {
              setMessages((prev) => [...prev, ...steeringMsgs]);
            } else {
              const flushedAssistant: ChatMessage = {
                id: crypto.randomUUID(),
                role: "assistant",
                content: fullText,
                timestamp: Date.now(),
                toolCalls: allCalls.length > 0 ? allCalls : undefined,
                segments: finalSegments.length > 0 ? [...finalSegments] : undefined,
              };
              setMessages((prev) => [...prev, flushedAssistant, ...steeringMsgs]);
            }

            // Reset accumulators so subsequent steps start fresh
            fullText = "";
            completedCalls.length = 0;
            finalSegments.length = 0;

            // Clear streaming display buffers (mutate in-place — closures hold direct refs)
            streamSegmentsBuffer.current.length = 0;
            liveToolCallsBuffer.current.length = 0;
            lastFlushedSegments.current = [];
            lastFlushedToolCalls.current = [];
            lastFlushedStreamingChars.current = 0;
            streamingCharsRef.current = 0;
            toolCharsRef.current = 0;
            segmentsDirty.current = false;
            toolCallsDirty.current = false;
            setStreamSegments([]);
            setLiveToolCalls([]);
          };

          const drainSteering = (): { text: string; images?: ImageAttachment[] } | null => {
            if (steeringAbortedRef.current) return null;
            const queue = messageQueueRef.current;
            if (queue.length === 0) return null;
            // Drain ALL queued steering messages at once
            const drained: ChatMessage[] = [];
            const texts: string[] = [];
            const allImages: ImageAttachment[] = [];
            for (const item of queue) {
              const content = item?.content;
              if (content) {
                drained.push({
                  id: crypto.randomUUID(),
                  role: "user" as const,
                  content,
                  timestamp: Date.now(),
                  showInChat: true,
                  isSteering: true,
                  images: item.images && item.images.length > 0 ? item.images : undefined,
                });
                texts.push(content);
                if (item.images) allImages.push(...item.images);
              }
            }
            messageQueueRef.current = [];
            setMessageQueue([]);

            if (drained.length > 0) {
              // Flush current progress + steering into messages
              flushBeforeSteering(drained);
            }

            if (texts.length === 0) return null;
            return {
              text: texts.join("\n\n"),
              images: allImages.length > 0 ? allImages : undefined,
            };
          };

          if (!contextManager.isRepoMapReady()) {
            setIsLoading(true);

            const answer = await new Promise<string>((resolve) => {
              const questionId = crypto.randomUUID();
              const warning =
                "\n\nProceeding without it will significantly reduce capabilities — no soul tools (search, impact analysis, structural queries), no surgical file reads.";

              const updateQuestion = () => {
                const s = useRepoMapStore.getState();
                const progress = s.scanProgress || "starting…";
                const stats =
                  s.files > 0 ? ` (${String(s.files)} files, ${String(s.symbols)} symbols)` : "";
                const status = s.scanError
                  ? `**Soul Map scan failed:** ${s.scanError}`
                  : `**Soul Map indexing:** ${progress}${stats}`;
                setPendingQuestion((prev) =>
                  prev?.id === questionId ? { ...prev, question: `${status}${warning}` } : prev,
                );
              };

              const cleanup = () => {
                clearInterval(progressTimer);
                clearInterval(readyPoller);
              };

              setPendingQuestion({
                id: questionId,
                question: `**Soul Map indexing:** starting…${warning}`,
                options: [{ label: "Proceed without Soul Map", value: "skip" }],
                allowSkip: false,
                hideOther: true,
                resolve: (answer) => {
                  cleanup();
                  setPendingQuestion(null);
                  resolve(answer);
                },
              });

              const progressTimer = setInterval(updateQuestion, 500);

              const readyPoller = setInterval(() => {
                if (contextManager.isRepoMapReady()) {
                  cleanup();
                  setPendingQuestion(null);
                  resolve("ready");
                }
              }, 200);

              abortController.signal.addEventListener(
                "abort",
                () => {
                  cleanup();
                  resolve("abort");
                },
                { once: true },
              );
            });

            if (answer === "abort" || abortController.signal.aborted) return;

            if (answer === "skip") {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "system",
                  content:
                    "⚠ Proceeding without Soul Map — soul tools unavailable, dispatch agents will have limited capabilities.",
                  timestamp: Date.now(),
                },
              ]);
            }
          }

          setLoadingStartedAt(Date.now());

          const agent = createForgeAgent({
            model,
            fullModelId: modelId,
            contextManager,
            forgeMode: contextManager.getForgeMode(),
            interactive: interactiveCallbacks,
            editorIntegration: effectiveConfig.editorIntegration,
            subagentModels,
            webSearchModel: effectiveWebSearchModel,
            onApproveWebSearch: webSearchApproval,
            onApproveFetchPage: fetchPageApproval,
            onApproveOutsideCwd: promptOutsideCwd,
            onApproveDestructive: promptDestructive,
            providerOptions,
            headers,
            codeExecution: effectiveConfig.codeExecution,
            computerUse: effectiveConfig.computerUse,
            anthropicTextEditor: effectiveConfig.anthropicTextEditor,
            cwd,
            sessionId: sessionIdRef.current,
            sharedCacheRef: sharedCacheRef.current,
            agentFeatures: {
              ...effectiveConfig.agentFeatures,
              onDemandTools: !useToolsStore.getState().disabledTools.has("request_tools"),
            },
            planExecution: planExecutionRef.current,
            drainSteering,
            disablePruning: !["subagents", "both"].includes(
              effectiveConfig.contextManagement?.pruningTarget ?? "subagents",
            ),
            disabledTools: useToolsStore.getState().disabledTools,
            tabId,
            tabLabel,
          });
          let result: StreamTextResult<ToolSet, never> | undefined;
          for (let degradeLevel = 0; degradeLevel <= 2; degradeLevel++) {
            if (abortController.signal.aborted) break;
            try {
              const currentAgent =
                degradeLevel === 0
                  ? agent
                  : (() => {
                      const degraded = degradeProviderOptions(activeModelRef.current, degradeLevel);
                      return createForgeAgent({
                        model,
                        fullModelId: modelId,
                        contextManager,
                        forgeMode: contextManager.getForgeMode(),
                        interactive: interactiveCallbacks,
                        editorIntegration: effectiveConfig.editorIntegration,
                        subagentModels,
                        webSearchModel: effectiveWebSearchModel,
                        onApproveWebSearch: webSearchApproval,
                        onApproveFetchPage: fetchPageApproval,
                        onApproveOutsideCwd: promptOutsideCwd,
                        onApproveDestructive: promptDestructive,
                        providerOptions: degraded.providerOptions,
                        headers: degraded.headers,
                        codeExecution: effectiveConfig.codeExecution,
                        computerUse: effectiveConfig.computerUse,
                        anthropicTextEditor: effectiveConfig.anthropicTextEditor,
                        cwd,
                        sessionId: sessionIdRef.current,
                        sharedCacheRef: sharedCacheRef.current,
                        agentFeatures: {
                          ...effectiveConfig.agentFeatures,
                          onDemandTools: !useToolsStore
                            .getState()
                            .disabledTools.has("request_tools"),
                        },
                        planExecution: planExecutionRef.current,
                        drainSteering,
                        disablePruning: !["subagents", "both"].includes(
                          effectiveConfig.contextManagement?.pruningTarget ?? "subagents",
                        ),
                        disabledTools: useToolsStore.getState().disabledTools,
                        tabId,
                        tabLabel,
                      });
                    })();
              result = (await currentAgent.stream({
                messages: newCoreMessages,
                abortSignal: abortController.signal,
                options: { userMessage: input },
              })) as unknown as StreamTextResult<ToolSet, never>;
              break;
            } catch (err: unknown) {
              if (!isProviderOptionsError(err) || degradeLevel === 2) throw err;
            }
          }

          const toolCallArgs = new Map<string, string>();
          const thinkingParser = createThinkingParser();
          let hasNativeReasoning = false;
          let thinkingIdCounter = 0;
          const streamErrors: string[] = [];

          const buf = streamSegmentsBuffer.current;
          const tcBuf = liveToolCallsBuffer.current;

          const updateStreamingEstimate = (newChars: number) => {
            streamingCharsRef.current += newChars;
            const estimatedNewTokens = Math.round(streamingCharsRef.current / 3.5);
            const base = baseTokenUsageRef.current;
            pendingTokenUsage.current = {
              ...base,
              completion: base.completion + estimatedNewTokens,
              total: base.total + estimatedNewTokens,
            };
            pendingLastStepOutput.current = estimatedNewTokens;
          };

          const appendText = (text: string) => {
            fullText += text;
            updateStreamingEstimate(text.length);
            segmentsDirty.current = true;
            const lastSeg = finalSegments[finalSegments.length - 1];
            if (lastSeg?.type === "text") {
              lastSeg.content += text;
            } else {
              finalSegments.push({ type: "text", content: text });
            }
            const lastBuf = buf[buf.length - 1];
            if (lastBuf?.type === "text") {
              lastBuf.content += text;
            } else {
              buf.push({ type: "text" as const, content: text });
            }
          };

          const pushReasoningSegment = (id: string) => {
            // Coalesce consecutive reasoning blocks: if the last segment is still
            // an open reasoning block (e.g. provider emits multiple <think>...</think>
            // pairs back-to-back, or native reasoning resumes after a brief pause),
            // reuse it instead of allocating a new one. Without this, models that
            // emit hundreds of small think blocks per step grow segments[] unbounded
            // and flushStreamState becomes O(N²) over the step.
            const lastFinal = finalSegments[finalSegments.length - 1];
            const lastBuf = buf[buf.length - 1];
            if (lastFinal?.type === "reasoning" && lastBuf?.type === "reasoning" && !lastBuf.done) {
              return;
            }
            segmentsDirty.current = true;
            finalSegments.push({ type: "reasoning", content: "", id });
            buf.push({ type: "reasoning", content: "", id, done: false } as StreamSegment);
          };

          const appendReasoningContent = (text: string) => {
            updateStreamingEstimate(text.length);
            segmentsDirty.current = true;
            const lastSeg = finalSegments[finalSegments.length - 1];
            if (lastSeg?.type === "reasoning") {
              lastSeg.content += text;
            }
            const lastBuf = buf[buf.length - 1];
            if (lastBuf?.type === "reasoning") {
              lastBuf.content += text;
            }
          };

          const markReasoningDone = () => {
            const lastBuf = buf[buf.length - 1];
            if (lastBuf?.type === "reasoning" && !lastBuf.done) {
              segmentsDirty.current = true;
              lastBuf.done = true;
            }
          };

          flushTimerRef.current = setInterval(flushStreamState, 32);

          if (!result) {
            throw new Error("Stream aborted before result was assigned");
          }

          // ── Stream stall watchdog ──────────────────────────────────
          // Detects hung API connections and auto-retries transparently.
          //
          // How it works:
          //   - Every stream event + subagent event resets a timer
          //   - Tool execution pauses the timer (tools have their own timeouts)
          //   - On stall: abort + auto-retry with backoff (up to 2 retries)
          //   - User Ctrl+X always wins — sets userAborted flag
          //   - After max retries, surfaces error to user
          //
          // Stall threshold: 90s between content chunks, 180s before first content.
          // "First content" = actual text or tool-call, not just start-step metadata.
          // First-content is generous for free tiers, deep reasoning, and large contexts.
          // Paused entirely while tools execute (they have their own timeouts).
          const wd = clampWatchdogTimeouts(effectiveConfig.watchdogTimeouts);
          const STALL_CHUNK_MS = wd.chunkMs;
          const STALL_FIRST_CHUNK_MS = wd.firstChunkMs;
          const STALL_TOOL_MAX_MS = wd.toolMaxMs; // 15min — dispatch worst case
          let lastActivityTs = Date.now();
          let lastToolActivityTs = Date.now();
          let toolsInFlight = 0;
          let gotFirstContent = false;
          let betweenSteps = false; // true after finish-step until next start-step
          const markActivity = () => {
            lastActivityTs = Date.now();
          };
          const markToolStart = () => {
            toolsInFlight++;
            lastToolActivityTs = Date.now();
          };
          const markToolEnd = () => {
            toolsInFlight = Math.max(0, toolsInFlight - 1);
            lastActivityTs = Date.now();
            lastToolActivityTs = Date.now();
          };
          const onUserAbort = () => {
            // Only mark as user-aborted if the abort wasn't from the stall watchdog.
            if (!stallAborted) {
              userAborted = true;
            }
          };
          abortController.signal.addEventListener("abort", onUserAbort, { once: true });
          // Filter subagent events to this tab's own dispatches only —
          // global event bus is shared across tabs, so unfiltered events from
          // other tabs would keep our watchdog alive during a genuine stall.
          const isOurEvent = (parentToolCallId: string) =>
            liveToolCallsBuffer.current.some((c) => c.id === parentToolCallId);
          unsubStallWatch1 = onMultiAgentEvent((evt) => {
            if (!isOurEvent(evt.parentToolCallId)) return;
            markActivity();
            lastToolActivityTs = Date.now();
          });
          unsubStallWatch2 = onSubagentStep((evt) => {
            if (!isOurEvent(evt.parentToolCallId)) return;
            markActivity();
            lastToolActivityTs = Date.now();
          });
          unsubStallWatch3 = onAgentStats((evt) => {
            if (!isOurEvent(evt.parentToolCallId)) return;
            markActivity();
            lastToolActivityTs = Date.now();
          });
          // Track whether the watchdog already fired abort — subsequent interval
          // ticks should force-resolve the stream if the abort didn't propagate.
          let stallAbortedAt = 0;
          const STALL_FORCE_RESOLVE_MS = wd.forceResolveMs; // 5s grace after abort before force-kill
          if (effectiveConfig.watchdog)
            stallWatchdog = setInterval(() => {
              // If watchdog aborted but the for-await loop is stuck on a dead
              // connection that didn't honor the AbortSignal, force-resolve it.
              if (stallAborted && Date.now() - stallAbortedAt >= STALL_FORCE_RESOLVE_MS) {
                // Force the stream iterator to end by calling return() on the SAME
                // iterator the for-await loop holds. A new [Symbol.asyncIterator]()
                // call would create a fresh reader and fail on the locked stream.
                try {
                  streamIterator?.return?.();
                } catch {}
                // Clear ourselves — nothing more we can do
                if (stallWatchdog) {
                  clearInterval(stallWatchdog);
                  stallWatchdog = null;
                }
                return;
              }
              if (abortController.signal.aborted) return;
              // Pause while a user prompt is active (local TUI popup, plan review,
              // ask_user) or a remote approval callback is awaiting Telegram/etc.
              // The user may need minutes to tap — not stream inactivity.
              if (
                pendingQuestionRef.current ||
                pendingPlanReviewRef.current ||
                remoteApprovalActiveRef.current > 0
              ) {
                lastActivityTs = Date.now();
                lastToolActivityTs = Date.now();
                return;
              }
              // While tools run, only fire if tool itself is stuck (15min max)
              if (toolsInFlight > 0) {
                if (Date.now() - lastToolActivityTs <= STALL_TOOL_MAX_MS) return;
              } else {
                // Between steps (SDK making a new API call) or before first chunk:
                // use the generous first-chunk timeout since the provider may be
                // processing a large context or queueing the request.
                const threshold =
                  !gotFirstContent || betweenSteps ? STALL_FIRST_CHUNK_MS : STALL_CHUNK_MS;
                if (Date.now() - lastActivityTs <= threshold) return;
              }
              // Capture the actual threshold that fired for the user-facing message
              const firedThresholdMs =
                toolsInFlight > 0
                  ? STALL_TOOL_MAX_MS
                  : !gotFirstContent || betweenSteps
                    ? STALL_FIRST_CHUNK_MS
                    : STALL_CHUNK_MS;
              stallTriggered = true;
              stallRetryCountRef.current++;
              const count = stallRetryCountRef.current;
              if (count <= STALL_MAX_RETRIES) {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    role: "system",
                    content: `Connection stalled — no activity for ${String(Math.round(firedThresholdMs / 1000))}s. Auto-retrying (${String(count)}/${String(STALL_MAX_RETRIES)})…`,
                    timestamp: Date.now(),
                    showInChat: true,
                  },
                ]);
                logBackgroundError(
                  "stream-stall",
                  `No stream activity — auto-retrying (${String(count)}/${String(STALL_MAX_RETRIES)})`,
                );
              } else {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    role: "system",
                    content: `Connection stalled ${String(STALL_MAX_RETRIES)} times — giving up. You can resend your message to try again.`,
                    timestamp: Date.now(),
                    showInChat: true,
                  },
                ]);
                logBackgroundError(
                  "stream-stall",
                  `Stream stalled ${String(STALL_MAX_RETRIES)} times — giving up`,
                );
              }
              stallAborted = true; // Mark that abort is from watchdog
              stallAbortedAt = Date.now(); // Keep for force-resolve timing
              abortController.abort();
            }, 10_000);

          let streamEventCount = 0;
          let yieldBeforeNext = false;
          // Capture the iterator so the watchdog can call .return() on the SAME
          // instance the loop holds. Calling [Symbol.asyncIterator]() again would
          // try getReader() on an already-locked ReadableStream and throw.
          const streamIterator = (
            result.fullStream as AsyncIterable<
              typeof result.fullStream extends AsyncIterable<infer T> ? T : never
            >
          )[Symbol.asyncIterator]();
          for await (const part of { [Symbol.asyncIterator]: () => streamIterator }) {
            markActivity();
            if (yieldBeforeNext || ++streamEventCount % 5 === 0) {
              yieldBeforeNext = false;
              await new Promise<void>((r) => setTimeout(r, 0));
            }
            switch (part.type) {
              case "start-step": {
                betweenSteps = false;
                const warnings = (part as { warnings?: Array<{ type: string; message?: string }> })
                  .warnings;
                if (warnings && warnings.length > 0) {
                  const msg = warnings
                    .map((w) => `[${w.type}]${w.message ? ` ${w.message}` : ""}`)
                    .join("; ");
                  if (process.env.SOULFORGE_DEBUG_API) {
                    import("../core/tools/tee.js").then(({ saveTee }) =>
                      saveTee("provider-warnings", msg),
                    );
                  }
                }
                break;
              }
              case "reasoning-start": {
                hasNativeReasoning = true;
                pushReasoningSegment(part.id);
                break;
              }
              case "reasoning-delta": {
                gotFirstContent = true;
                appendReasoningContent(part.text);
                void import("../hearth/bridge.js").then(({ reasoningStreamEmitter }) => {
                  reasoningStreamEmitter.append(tabId, part.text);
                });
                break;
              }
              case "reasoning-end":
                markReasoningDone();
                break;
              case "text-delta": {
                gotFirstContent = true;
                if (hasNativeReasoning) {
                  appendText(part.text);
                } else {
                  const parsed = thinkingParser.feed(part.text);
                  for (const chunk of parsed) {
                    switch (chunk.type) {
                      case "text":
                        appendText(chunk.content);
                        break;
                      case "reasoning-start":
                        pushReasoningSegment(`thinking-${String(thinkingIdCounter++)}`);
                        break;
                      case "reasoning-content":
                        appendReasoningContent(chunk.content);
                        break;
                      case "reasoning-end":
                        markReasoningDone();
                        break;
                    }
                  }
                }
                // Stream visible text to Hearth surfaces in real time (coalesced).
                void import("../hearth/bridge.js").then(({ bridgeStreamEmitter }) => {
                  bridgeStreamEmitter.stream(tabId, { type: "text", content: part.text });
                });
                queueMicrotaskFlush();
                break;
              }
              case "tool-input-start": {
                gotFirstContent = true;
                markToolStart();
                segmentsDirty.current = true;
                toolCallsDirty.current = true;
                void import("../hearth/bridge.js").then(({ bridgeStreamEmitter }) => {
                  bridgeStreamEmitter.stream(tabId, {
                    type: "tool-call",
                    tool: part.toolName,
                    toolCallId: part.id,
                  });
                });

                // Detect code_execution child calls: if a code_execution call is currently
                // running (state !== "done"/"error"), any new tool call is a child spawned from it.
                const activeCodeExec = tcBuf.find(
                  (c) => c.toolName === "code_execution" && c.state === "running",
                );
                const isChildCall = activeCodeExec && part.toolName !== "code_execution";

                // Child calls don't get their own segment — they're nested under the parent
                if (!isChildCall) {
                  const lastToolSeg = finalSegments[finalSegments.length - 1];
                  if (lastToolSeg?.type === "tools") {
                    lastToolSeg.toolCallIds.push(part.id);
                  } else {
                    finalSegments.push({ type: "tools", toolCallIds: [part.id] });
                  }
                  const lastBufSeg = buf[buf.length - 1];
                  if (lastBufSeg?.type === "tools") {
                    lastBufSeg.callIds.push(part.id);
                  } else {
                    buf.push({ type: "tools" as const, callIds: [part.id] });
                  }
                }

                tcBuf.push({
                  id: part.id,
                  toolName: part.toolName,
                  state: "running",
                  ...(isChildCall ? { parentId: activeCodeExec.id } : {}),
                  ...(part.toolName === "web_search" && webSearchModelLabelRef.current
                    ? { backend: webSearchModelLabelRef.current }
                    : {}),
                });
                toolCallArgs.set(part.id, "");
                queueMicrotaskFlush();
                break;
              }
              case "tool-input-delta": {
                toolCallArgs.set(part.id, (toolCallArgs.get(part.id) ?? "") + part.delta);
                const tc = tcBuf.find((c) => c.id === part.id);
                if (tc) {
                  tc.args = toolCallArgs.get(part.id);
                  if (
                    tc.toolName === "dispatch" ||
                    tc.toolName === "plan" ||
                    tc.toolName === "write_plan"
                  ) {
                    toolCallsDirty.current = true;
                    queueMicrotaskFlush();
                  }
                }
                toolCharsRef.current += part.delta.length;
                break;
              }
              case "file": {
                // Code execution can generate image files — capture them for inline display
                const file = (part as { file?: { mediaType?: string; uint8Array?: Uint8Array } })
                  .file;
                if (
                  file?.mediaType?.startsWith("image/") &&
                  file.uint8Array &&
                  file.uint8Array.length > 0
                ) {
                  // Find the active code_execution tool call to attach the image to
                  const codeExecTc = tcBuf.find(
                    (c) => c.toolName === "code_execution" && c.state === "running",
                  );
                  if (codeExecTc) {
                    try {
                      const { renderImageFromData } = await import("../core/terminal/image.js");
                      const art = await renderImageFromData(
                        Buffer.from(file.uint8Array),
                        `image-${String(Date.now())}.png`,
                      );
                      if (art) {
                        if (!codeExecTc.imageArt) codeExecTc.imageArt = [];
                        codeExecTc.imageArt.push(art);
                        toolCallsDirty.current = true;
                        queueMicrotaskFlush();
                      }
                    } catch {
                      // Image rendering failed — silently skip
                    }
                  }
                }
                break;
              }
              case "tool-result": {
                markToolEnd();
                toolCallsDirty.current = true;
                const resultStr =
                  typeof part.output === "string" ? part.output : JSON.stringify(part.output);
                const tc = tcBuf.find((c) => c.id === part.toolCallId);
                if (tc) {
                  tc.state = "done";
                  tc.result = resultStr;
                  tc.progressText = undefined;
                  // Extract half-block image art from shell tool results
                  if (
                    typeof part.output === "object" &&
                    part.output !== null &&
                    "_imageArt" in part.output
                  ) {
                    tc.imageArt = (
                      part.output as {
                        _imageArt: Array<{
                          name: string;
                          lines: string[];
                          kittyImageId?: number;
                          kittyCols?: number;
                          kittyRows?: number;
                        }>;
                      }
                    )._imageArt;
                  }
                }
                toolCharsRef.current += resultStr.length;
                const parsedArgs = safeParseArgs(toolCallArgs.get(part.toolCallId));
                // Extract structured result — part.output is already our {success, output, error?} object
                let toolResult: import("../types/index.js").ToolResult;
                if (
                  typeof part.output === "object" &&
                  part.output !== null &&
                  "success" in part.output
                ) {
                  const r = part.output as {
                    success: boolean;
                    output?: string;
                    error?: string;
                    backend?: string;
                    outlineOnly?: boolean;
                    filesEdited?: string[];
                  };
                  toolResult = {
                    success: r.success,
                    output: r.output ?? "",
                    error: r.error,
                    backend: r.backend,
                    outlineOnly: r.outlineOnly,
                    filesEdited: r.filesEdited,
                  };
                } else {
                  toolResult = { success: true, output: resultStr };
                }
                // Dispatch tool returns DispatchOutput (no `success` field) — extract filesEdited
                if (
                  typeof part.output === "object" &&
                  part.output !== null &&
                  "filesEdited" in part.output
                ) {
                  const d = part.output as { filesEdited?: string[] };
                  if (d.filesEdited) toolResult.filesEdited = d.filesEdited;
                }
                // Preserve imageArt from the streaming LiveToolCall for the final ToolCall
                const streamingTc = tcBuf.find((c) => c.id === part.toolCallId);
                const completedCall: import("../types/index.js").ToolCall = {
                  id: part.toolCallId,
                  name: part.toolName,
                  args: parsedArgs,
                  result: toolResult,
                };
                if (streamingTc?.parentId) {
                  completedCall.parentId = streamingTc.parentId;
                }
                if (streamingTc?.imageArt) {
                  completedCall.imageArt = streamingTc.imageArt;
                }
                completedCalls.push(completedCall);
                if (workingStateRef.current) {
                  extractFromToolCall(workingStateRef.current, part.toolName, parsedArgs);
                  extractFromToolResult(
                    workingStateRef.current,
                    part.toolName,
                    resultStr,
                    parsedArgs,
                  );
                  syncV2Slots();
                }
                // Stream tool-result summary to Hearth (truncated — adapters render).
                void import("../hearth/bridge.js").then(({ bridgeStreamEmitter }) => {
                  bridgeStreamEmitter.stream(tabId, {
                    type: "tool-result",
                    tool: part.toolName,
                    toolCallId: part.toolCallId,
                    summary: toolResult.error
                      ? `✗ ${toolResult.error.slice(0, 200)}`
                      : `✓ ${(toolResult.output ?? "").slice(0, 200)}`,
                  });
                });
                flushStreamState();
                yieldBeforeNext = true;
                break;
              }
              case "tool-error": {
                markToolEnd();
                toolCallsDirty.current = true;
                let errorMsg: string;
                if (typeof part.error === "string") {
                  errorMsg = part.error;
                } else if (typeof part.error === "object" && part.error !== null) {
                  const e = part.error;
                  if ("errorCode" in e && typeof e.errorCode === "string") errorMsg = e.errorCode;
                  else if ("error_code" in e && typeof e.error_code === "string")
                    errorMsg = e.error_code;
                  else if ("message" in e && typeof e.message === "string") errorMsg = e.message;
                  else errorMsg = JSON.stringify(e);
                } else {
                  errorMsg = String(part.error);
                }
                const tc = tcBuf.find((c) => c.id === part.toolCallId);
                if (tc) {
                  tc.state = "error";
                  tc.error = errorMsg;
                  tc.progressText = undefined;
                }
                const errorArgs = safeParseArgs(toolCallArgs.get(part.toolCallId));
                completedCalls.push({
                  id: part.toolCallId,
                  name: part.toolName,
                  args: errorArgs,
                  result: { success: false, output: "", error: errorMsg },
                });
                if (workingStateRef.current) {
                  extractFromToolCall(workingStateRef.current, part.toolName, errorArgs);
                  workingStateRef.current.addFailure(`${part.toolName}: ${errorMsg.slice(0, 200)}`);
                  syncV2Slots();
                }
                void import("../hearth/bridge.js").then(({ bridgeStreamEmitter }) => {
                  bridgeStreamEmitter.stream(tabId, {
                    type: "tool-result",
                    tool: part.toolName,
                    toolCallId: part.toolCallId,
                    summary: `✗ ${errorMsg.slice(0, 200)}`,
                  });
                });
                flushStreamState();
                yieldBeforeNext = true;
                break;
              }
              case "finish-step": {
                betweenSteps = true;
                const stepTotal = part.usage.inputTokens ?? 0;
                const stepOut = part.usage.outputTokens ?? 0;
                const details = (
                  part.usage as {
                    inputTokenDetails?: {
                      cacheReadTokens?: number;
                      cacheWriteTokens?: number;
                      noCacheTokens?: number;
                    };
                  }
                ).inputTokenDetails;
                const stepCache = details?.cacheReadTokens ?? 0;
                const stepCacheWrite = details?.cacheWriteTokens ?? 0;
                const stepNoCache = details?.noCacheTokens ?? 0;
                // prompt = uncached input ONLY. cacheWrite tracked separately.
                // inputTokens from SDK = total (noCache + cacheRead + cacheWrite)
                const stepIn =
                  stepNoCache > 0
                    ? stepNoCache
                    : Math.max(0, stepTotal - stepCache - stepCacheWrite);
                if (process.env.SOULFORGE_DEBUG_API) {
                  const line = `[cache] step total=${String(stepTotal)} noCache=${String(stepNoCache)} cacheRead=${String(stepCache)} cacheWrite=${String(stepCacheWrite)} prompt=${String(stepIn)} output=${String(stepOut)}\n`;
                  try {
                    const g = globalThis as unknown as Record<string, string>;
                    g.__cacheLog = (g.__cacheLog ?? "") + line;
                    Bun.write(
                      `${process.cwd()}/.soulforge/api-export/cache-steps.log`,
                      g.__cacheLog,
                    );
                  } catch {}
                }
                const base = baseTokenUsageRef.current;
                const newUsage: TokenUsage = {
                  ...base,
                  prompt: base.prompt + stepIn,
                  completion: base.completion + stepOut,
                  total: base.total + stepTotal + stepOut,
                  cacheRead: base.cacheRead + stepCache,
                  cacheWrite: base.cacheWrite + stepCacheWrite,
                  lastStepInput: stepIn,
                  lastStepOutput: stepOut,
                  lastStepCacheRead: stepCache,
                  modelBreakdown: accumulateModelUsage(base.modelBreakdown, modelId, {
                    input: stepIn,
                    output: stepOut,
                    cacheRead: stepCache,
                    cacheWrite: stepCacheWrite,
                  }),
                };
                pendingTokenUsage.current = newUsage;
                baseTokenUsageRef.current = newUsage;
                streamingCharsRef.current = 0;
                if (stepTotal > 0) pendingContextTokens.current = stepTotal;
                pendingLastStepOutput.current = stepOut;
                // Accumulate per-turn delta so the Hearth bridge's turn-done
                // reports real numbers instead of zeros.
                turnTokensRef.current = {
                  input: turnTokensRef.current.input + stepIn,
                  output: turnTokensRef.current.output + stepOut,
                  cacheRead: turnTokensRef.current.cacheRead + stepCache,
                };
                queueMicrotaskFlush();

                if (completedCalls.length > 0 && Date.now() - lastIncrementalSave > 10_000) {
                  lastIncrementalSave = Date.now();
                  queueMicrotask(() => {
                    try {
                      const snapshot = getWorkspaceSnapshot?.();
                      if (!snapshot) return;
                      const partialMsg: ChatMessage = {
                        id: crypto.randomUUID(),
                        role: "assistant",
                        content: fullText,
                        timestamp: Date.now(),
                        toolCalls: [...completedCalls],
                        segments: finalSegments.length > 0 ? [...finalSegments] : undefined,
                      };
                      setMessages((prev) => {
                        const allMsgs = [...prev, partialMsg];
                        const { meta, tabMessages, tabCoreMessages } = buildSessionMeta({
                          sessionId: sessionIdRef.current,
                          title: customTitleRef.current ?? SessionManager.deriveTitle(allMsgs),
                          customTitle: customTitleRef.current,
                          cwd,
                          snapshot,
                          currentTabMessages: allMsgs.filter(
                            (m) => m.role !== "system" || m.showInChat,
                          ),
                          currentTabCoreMessages: coreMessagesRef.current,
                        });
                        updateEmergencySnapshot(sessionManager, meta, tabMessages, tabCoreMessages);
                        sessionManager
                          .saveSession(meta, tabMessages, tabCoreMessages)
                          .catch(() => {});
                        return prev;
                      });
                    } catch {
                      // Don't let checkpoint failures interrupt streaming
                    }
                  });
                }
                break;
              }
              case "error": {
                const err = part.error;
                const errText =
                  (err instanceof Error ? err.message : null) ||
                  (typeof err === "string" ? err : null) ||
                  JSON.stringify(err);
                const errStack = err instanceof Error ? err.stack : undefined;
                const sErr =
                  err != null && typeof err === "object" ? (err as Record<string, unknown>) : null;
                const sBody =
                  sErr && typeof sErr.responseBody === "string" && sErr.responseBody.length > 0
                    ? (sErr.responseBody as string).slice(0, 500)
                    : undefined;
                const sData =
                  sErr?.data != null ? JSON.stringify(sErr.data).slice(0, 500) : undefined;
                const enriched = sBody ?? sData;
                const displayErr = enriched ? `${errText} · ${enriched}` : errText;
                logBackgroundError("api", displayErr);
                appendText(`\n\n_Error: ${displayErr}_`);
                if (streamErrors.length < 50) {
                  streamErrors.push(
                    errStack ? `Error: ${displayErr}\n\n${errStack}` : `Error: ${displayErr}`,
                  );
                }
                break;
              }
            }
          }

          // Clean up stream stall watchdog
          if (stallWatchdog) clearInterval(stallWatchdog);
          unsubStallWatch1?.();
          unsubStallWatch2?.();
          unsubStallWatch3?.();

          // If the watchdog fired but the stream ended gracefully (some providers
          // close the stream instead of throwing on abort), re-throw so the catch
          // block's auto-retry logic kicks in.
          if (stallTriggered && abortController.signal.aborted && !userAborted) {
            throw new Error("Stream stall — abort did not throw");
          }

          // Log agent stop reason for debugging (visible via /errors) — only when errors occurred
          if (streamErrors.length > 0) {
            logBackgroundError(
              "agent-stop",
              `streamErrors=${String(streamErrors.length)}: ${streamErrors[0]?.slice(0, 200)}`,
            );
          }

          if (flushTimerRef.current) {
            clearInterval(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          flushStreamState();

          if (!hasNativeReasoning) {
            for (const chunk of thinkingParser.flush()) {
              switch (chunk.type) {
                case "text":
                  appendText(chunk.content);
                  break;
                case "reasoning-content":
                  appendReasoningContent(chunk.content);
                  break;
                default:
                  break;
              }
            }
          }

          let responseMessages: ModelMessage[];
          try {
            const timeout = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("response timeout")), 10_000),
            );
            const responseData = await Promise.race([result.response, timeout]);
            responseMessages = responseData.messages;
          } catch {
            responseMessages =
              fullText.length > 0 ? [{ role: "assistant" as const, content: fullText }] : [];
          }

          // Embed plan as a segment if one was created (skip when plan post-action will handle it)
          if (activePlanRef.current && !planPostActionRef.current) {
            finalSegments.push({ type: "plan", plan: activePlanRef.current });
          }
          setActivePlan(null);
          setSidebarPlan(null);

          if (workingStateRef.current && fullText.length > 0) {
            extractFromAssistantMessage(workingStateRef.current, {
              role: "assistant",
              content: fullText,
            });
            syncV2Slots();
          }

          const assistantMsg = buildAssistantMessage({
            fullText,
            completedCalls,
            segments: finalSegments,
            responseStartedAt,
            now: Date.now(),
          });

          const errorMsgs: ChatMessage[] = streamErrors.map((errContent) => ({
            id: crypto.randomUUID(),
            role: "system" as const,
            content: errContent,
            timestamp: Date.now(),
          }));

          setMessages((prev) => {
            const allMsgs = [...prev, ...(assistantMsg ? [assistantMsg] : []), ...errorMsgs];
            queueMicrotask(() => {
              const snapshot = getWorkspaceSnapshot?.();
              if (snapshot) {
                const { meta, tabMessages, tabCoreMessages } = buildSessionMeta({
                  sessionId: sessionIdRef.current,
                  title: customTitleRef.current ?? SessionManager.deriveTitle(allMsgs),
                  customTitle: customTitleRef.current,
                  cwd,
                  snapshot,
                  currentTabMessages: allMsgs.filter((m) => m.role !== "system" || m.showInChat),
                  currentTabCoreMessages: coreMessagesRef.current,
                });
                updateEmergencySnapshot(sessionManager, meta, tabMessages, tabCoreMessages);
                sessionManager.saveSession(meta, tabMessages, tabCoreMessages).catch(() => {});
              }
            });
            // Finalize streaming: flush any remaining text + reasoning + emit turn-done.
            // Individual text-delta / tool-call / tool-result / reasoning-delta events
            // were already streamed during the turn.
            if (assistantMsg) {
              void import("../hearth/bridge.js").then(
                ({ bridgeStreamEmitter, reasoningStreamEmitter }) => {
                  reasoningStreamEmitter.flushNow(tabId);
                  bridgeStreamEmitter.flushNow(tabId);
                  bridgeStreamEmitter.stream(tabId, {
                    type: "turn-done",
                    turn: 0,
                    output: assistantMsg.content,
                    steps: assistantMsg.toolCalls?.length ?? 0,
                    tokens: { ...turnTokensRef.current },
                    toolCalls: (assistantMsg.toolCalls ?? []).map((c) => c.name),
                    filesEdited: [],
                    duration: assistantMsg.durationMs ?? 0,
                  });
                },
              );
            }
            return allMsgs;
          });

          // Sanitize empty assistant content — Anthropic rejects empty text blocks.
          // Instead of filtering (which could orphan tool messages), patch empty content.
          const filteredResponseMessages = responseMessages
            .map((m) => {
              if (m.role !== "assistant") return m;
              if (typeof m.content === "string" && m.content.length === 0) {
                // Completely empty string content — drop the message only if the
                // next message is NOT a tool message (which would be orphaned).
                return null;
              }
              if (Array.isArray(m.content)) {
                // Strip empty text parts from arrays — keep tool-call parts intact
                const cleaned = m.content.filter(
                  (p: { type: string; text?: string }) =>
                    p.type !== "text" || (typeof p.text === "string" && p.text.length > 0),
                );
                if (cleaned.length === 0) return null;
                if (cleaned.length !== m.content.length) return { ...m, content: cleaned };
              }
              return m;
            })
            .filter((m, i, arr) => {
              if (m !== null) return true;
              // Keep null (empty assistant) if next message is a tool message — replace with placeholder
              const next = arr[i + 1];
              return next?.role === "tool";
            })
            .map(
              (m) =>
                // Replace nulls kept for tool pairing with minimal valid content
                m ?? { role: "assistant" as const, content: "(continued)" },
            );
          setCoreMessages((prev) => {
            const updated = [...prev, ...filteredResponseMessages];
            const target = effectiveConfig.contextManagement?.pruningTarget ?? "subagents";
            return ["main", "both"].includes(target) ? pruneOldToolResults(updated) : updated;
          });
          streamSegmentsBuffer.current = [];
          liveToolCallsBuffer.current = [];
          lastFlushedSegments.current = [];
          lastFlushedToolCalls.current = [];
          lastFlushedStreamingChars.current = 0;
          streamingCharsRef.current = 0;
          toolCharsRef.current = 0;
          setStreamingChars(0);
          setStreamSegments([]);
          setLiveToolCalls([]);
          completeInProgressTasks(tabId);
          break;
        } catch (err: unknown) {
          if (flushTimerRef.current) {
            clearInterval(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          const isAbort = abortController.signal.aborted;
          const msg = err instanceof Error ? err.message : String(err);
          const chain = causeChain(err);
          const isTransient =
            /overloaded|529|429|rate.?limit|too many requests|503|502|timeout|timed out|fetch failed|network|econnreset|econnrefused|enotfound|eai_again|socket hang up|connection (?:error|reset|refused|closed)|stream (?:error|closed)|premature close|terminated|aborted.*connection/i.test(
              chain,
            );
          const isConnErr =
            /cannot connect|unable to connect|fetch failed|failed to fetch|socket hang up|econnreset|econnrefused|enotfound|eai_again|network error|stream (?:error|closed)|premature close|terminated|connection (?:error|reset|refused|closed)/i.test(
              chain,
            );
          if (!proxyBounced && isConnErr && getActiveProviderId() === "proxy") {
            proxyBounced = true;
            const healthy = await proxyHealthProbe().catch(() => false);
            if (!healthy) {
              await Promise.race([
                bounceProxy().catch(() => false),
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000)),
              ]);
            }
          }
          const isStallRetry =
            isAbort &&
            stallTriggered &&
            !userAborted &&
            stallRetryCountRef.current <= STALL_MAX_RETRIES;

          // Retry on transient errors during streaming (e.g. "socket connection closed unexpectedly")
          if (isTransient && !isStallRetry) {
            streamRetryCount++;
            if (streamRetryCount <= MAX_TRANSIENT_RETRIES && !abortController.signal.aborted) {
              const delay = RETRY_BASE_DELAY_MS * 2 ** (streamRetryCount - 1) + Math.random() * 500;
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "system",
                  content: `Transient error: ${msg}. Retry ${String(streamRetryCount)}/${String(MAX_TRANSIENT_RETRIES)} [delay:${String(Math.round(delay / 1000))}s]`,
                  timestamp: Date.now(),
                },
              ]);

              // If partial assistant/tool output exists, commit it and continue with "Continue."
              // This avoids re-running tools and safely resumes from where we left off.
              if (fullText.trim().length > 0 || completedCalls.length > 0) {
                // Commit partial work (following stall retry pattern)
                const partialMsg = buildAssistantMessage({
                  fullText,
                  completedCalls,
                  segments: finalSegments,
                  responseStartedAt,
                  now: Date.now(),
                });
                if (partialMsg) {
                  setMessages((prev) => [...prev, partialMsg]);

                  // Update coreMessages with partial work
                  const assistantContent: Array<TextPart | ToolCallPart> = [];
                  if (fullText.length > 0) {
                    assistantContent.push({ type: "text", text: fullText });
                  }
                  for (const call of completedCalls) {
                    const args = call.args;
                    assistantContent.push({
                      type: "tool-call",
                      toolCallId: call.id,
                      toolName: call.name,
                      input:
                        typeof args === "object" && args !== null && !Array.isArray(args)
                          ? args
                          : {},
                    });
                  }
                  if (completedCalls.length > 0) {
                    const toolContent = completedCalls.map((call) => ({
                      type: "tool-result" as const,
                      toolCallId: call.id,
                      toolName: call.name,
                      output: { type: "text" as const, value: call.result?.output ?? "" },
                    }));
                    setCoreMessages((prev) => [
                      ...prev,
                      { role: "assistant" as const, content: assistantContent },
                      { role: "tool" as const, content: toolContent },
                    ]);
                  } else if (fullText.length > 0) {
                    setCoreMessages((prev) => [
                      ...prev,
                      { role: "assistant" as const, content: fullText },
                    ]);
                  }
                }

                // Clean up stream state
                streamSegmentsBuffer.current = [];
                liveToolCallsBuffer.current = [];
                lastFlushedSegments.current = [];
                lastFlushedToolCalls.current = [];
                lastFlushedStreamingChars.current = 0;
                streamingCharsRef.current = 0;
                toolCharsRef.current = 0;
                setStreamingChars(0);
                setStreamSegments([]);
                setLiveToolCalls([]);

                // Signal that a retry is pending
                stallRetryPendingRef.current = true;

                // Stay in-loop: await backoff then continue (avoids racing finally block)
                await new Promise((resolve) => setTimeout(resolve, delay));
                continue;
              } else {
                // No partial output - retry the stream directly
                stallRetryPendingRef.current = true;
                const backoffDelay =
                  RETRY_BASE_DELAY_MS * 2 ** (streamRetryCount - 1) + Math.random() * 500;
                await new Promise((resolve) => setTimeout(resolve, backoffDelay));
                continue;
              }
            }
          }

          // Auto-retry on stall: clean up, show a subtle system message, then
          // re-submit "Continue." so the agent picks up where it left off.
          // We preserve partial work (completedCalls, fullText, coreMessages)
          // so the agent has full context on the retry.
          if (isStallRetry) {
            if (flushTimerRef.current) {
              clearInterval(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            // Commit any partial assistant output so the retry has context
            if (fullText.trim().length > 0 || completedCalls.length > 0) {
              const partialMsg = buildAssistantMessage({
                fullText,
                completedCalls,
                segments: finalSegments,
                responseStartedAt,
                now: Date.now(),
              });
              if (!partialMsg) return;
              setMessages((prev) => [...prev, partialMsg]);
              // Flush the streaming buffer and send the stall warning — tool-calls
              // and text were already streamed in real time during the turn.
              void import("../hearth/bridge.js").then(({ bridgeStreamEmitter }) => {
                bridgeStreamEmitter.flushNow(tabId);
                bridgeStreamEmitter.stream(tabId, {
                  type: "warning",
                  message: `Stream stalled, auto-retrying (${String(stallRetryCountRef.current)}/${String(STALL_MAX_RETRIES)})`,
                });
              });
              if (completedCalls.length > 0) {
                const assistantContent: Array<TextPart | ToolCallPart> = [];
                if (fullText.length > 0) {
                  assistantContent.push({ type: "text", text: fullText });
                }
                for (const call of completedCalls) {
                  const args = call.args;
                  assistantContent.push({
                    type: "tool-call",
                    toolCallId: call.id,
                    toolName: call.name,
                    input:
                      typeof args === "object" && args !== null && !Array.isArray(args) ? args : {},
                  });
                }
                const toolContent = completedCalls.map((call) => ({
                  type: "tool-result" as const,
                  toolCallId: call.id,
                  toolName: call.name,
                  output: { type: "text" as const, value: call.result?.output ?? "" },
                }));
                setCoreMessages((prev) => [
                  ...prev,
                  { role: "assistant" as const, content: assistantContent },
                  { role: "tool" as const, content: toolContent },
                ]);
              } else if (fullText.length > 0) {
                setCoreMessages((prev) => [
                  ...prev,
                  { role: "assistant" as const, content: fullText },
                ]);
              }
            }
            // System message already shown by the watchdog — no duplicate needed.
            // Clean up stream state
            streamSegmentsBuffer.current = [];
            liveToolCallsBuffer.current = [];
            lastFlushedSegments.current = [];
            lastFlushedToolCalls.current = [];
            lastFlushedStreamingChars.current = 0;
            streamingCharsRef.current = 0;
            toolCharsRef.current = 0;
            setStreamingChars(0);
            setStreamSegments([]);
            setLiveToolCalls([]);
            // Signal that a stall retry is pending so:
            // 1. finally block doesn't fire competing handleSubmit (messageQueue/compact)
            // 2. next handleSubmit("Continue.") preserves the retry count
            stallRetryPendingRef.current = true;
            // Backoff: 2s first, 5s second
            const backoffMs = stallRetryCountRef.current === 1 ? 2_000 : 5_000;
            setTimeout(() => handleSubmitRef.current("Continue."), backoffMs);
            // Skip the rest of the catch — finally block will clean up
            return;
          }

          const rawMsg = err instanceof Error ? err.message : String(err);
          const rawStack = err instanceof Error ? err.stack : undefined;
          const rawChain = causeChain(err);
          // Log non-abort errors to /errors for debugging — include cause chain + stack trace
          if (!isAbort) {
            const parts = [rawChain];
            if (rawStack) parts.push(rawStack);
            logBackgroundError("agent-error", parts.join("\n\n"));
          }
          // ── StopFailure hook ──
          if (!isAbort) {
            runHooks({
              event: "StopFailure",
              toolInput: { error: rawMsg },
              sessionId: sessionIdRef.current,
              cwd,
            }).catch(() => {});
          }
          const isTransientStream =
            /overloaded|529|429|rate.?limit|too many requests|503|502/i.test(rawMsg);
          const errObj =
            err != null && typeof err === "object" ? (err as Record<string, unknown>) : null;
          const apiBody =
            errObj && typeof errObj.responseBody === "string" && errObj.responseBody.length > 0
              ? errObj.responseBody
              : undefined;
          const apiData =
            errObj?.data != null ? JSON.stringify(errObj.data).slice(0, 500) : undefined;
          const detail = apiBody?.slice(0, 500) ?? apiData;
          const enrichedMsg = detail ? `${rawMsg} · ${detail}` : rawMsg;
          const errorMsg = isTransientStream
            ? `Provider returned a transient error (${rawMsg.slice(0, 120)}). Please retry.`
            : enrichedMsg;
          const errorStack = !isTransientStream && err instanceof Error ? err.stack : undefined;
          // Mark in-flight tool calls as interrupted so they don't show stuck spinners
          if (isAbort) {
            const completedIds = new Set(completedCalls.map((c) => c.id));
            // Use snapshot saved before abort() cleared the buffers
            const liveBuf =
              abortedToolCallsSnapshot.current.length > 0
                ? abortedToolCallsSnapshot.current
                : liveToolCallsBuffer.current;
            for (const seg of finalSegments) {
              if (seg.type === "tools") {
                for (const id of seg.toolCallIds) {
                  if (!completedIds.has(id)) {
                    const live = liveBuf.find((c: LiveToolCall) => c.id === id);
                    const args = live?.args ? safeParseArgs(live.args) : {};
                    completedCalls.push({
                      id,
                      name: live?.toolName ?? "unknown",
                      args,
                      result: { success: false, output: "", error: "Interrupted by user (Ctrl+X)" },
                    });
                  }
                }
              }
            }
            abortedSegmentsSnapshot.current = [];
            abortedToolCallsSnapshot.current = [];
          }

          const hasPlanPostAction = !!planPostActionRef.current;
          if (
            !hasPlanPostAction &&
            hasRenderableAssistantContent({
              fullText,
              toolCallCount: completedCalls.length,
              segments: finalSegments,
            })
          ) {
            const partialMsg = buildAssistantMessage({
              fullText,
              completedCalls,
              segments: finalSegments,
              responseStartedAt,
              now: Date.now(),
            });
            if (!partialMsg) return;
            setMessages((prev) => [...prev, partialMsg]);

            if (completedCalls.length > 0) {
              const assistantContent: Array<TextPart | ToolCallPart> = [];
              if (fullText.length > 0) {
                assistantContent.push({ type: "text", text: fullText });
              }
              for (const call of completedCalls) {
                const args = call.args;
                assistantContent.push({
                  type: "tool-call",
                  toolCallId: call.id,
                  toolName: call.name,
                  input:
                    typeof args === "object" && args !== null && !Array.isArray(args) ? args : {},
                });
              }
              const toolContent = completedCalls.map((call) => ({
                type: "tool-result" as const,
                toolCallId: call.id,
                toolName: call.name,
                output: { type: "text" as const, value: call.result?.output ?? "" },
              }));
              setCoreMessages((prev) => [
                ...prev,
                { role: "assistant" as const, content: assistantContent },
                { role: "tool" as const, content: toolContent },
              ]);
            } else {
              setCoreMessages((prev) => [
                ...prev,
                { role: "assistant" as const, content: fullText },
              ]);
            }
          }
          if (!hasPlanPostAction) {
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: isAbort
                  ? "Generation interrupted."
                  : errorStack
                    ? `Error: ${errorMsg}\n\n${errorStack}`
                    : `Error: ${errorMsg}`,
                timestamp: Date.now(),
              },
            ]);
            // Flush streaming buffers (text + reasoning) and emit abort/error + turn-done.
            void import("../hearth/bridge.js").then(
              ({ bridgeStreamEmitter, reasoningStreamEmitter }) => {
                reasoningStreamEmitter.discard(tabId);
                bridgeStreamEmitter.flushNow(tabId);
                if (isAbort) {
                  bridgeStreamEmitter.stream(tabId, {
                    type: "warning",
                    message: "Generation interrupted.",
                  });
                } else {
                  bridgeStreamEmitter.stream(tabId, {
                    type: "error",
                    error: errorMsg,
                  });
                }
                bridgeStreamEmitter.stream(tabId, {
                  type: "turn-done",
                  turn: 0,
                  output: fullText,
                  steps: completedCalls.length,
                  tokens: { ...turnTokensRef.current },
                  toolCalls: completedCalls.map((c) => c.name),
                  filesEdited: [],
                  duration: 0,
                });
              },
            );
          }
          streamSegmentsBuffer.current = [];
          liveToolCallsBuffer.current = [];
          lastFlushedSegments.current = [];
          lastFlushedToolCalls.current = [];
          lastFlushedStreamingChars.current = 0;
          streamingCharsRef.current = 0;
          toolCharsRef.current = 0;
          setStreamingChars(0);
          setStreamSegments([]);
          setLiveToolCalls([]);
          resetInProgressTasks(tabId);
        } finally {
          if (stallWatchdog) clearInterval(stallWatchdog);
          unsubStallWatch1?.();
          unsubStallWatch2?.();
          unsubStallWatch3?.();
          unsubAgentStats();
          unsubMultiAgent();
          unsubToolProgress();
          if (visibleRef.current) useStatusBarStore.getState().setSubagentChars(0);
          if (abortController.signal.aborted) getWorkspaceCoordinator().releaseAll(tabId);
          if (!stallRetryPendingRef.current) setIsLoading(false);
          // ── Stop hook ── (fires when agent finishes responding)
          if (!stallRetryPendingRef.current) {
            runHooks({
              event: "Stop",
              toolInput: { stop_hook_active: true },
              sessionId: sessionIdRef.current,
              cwd,
            }).catch(() => {});
          }
          abortRef.current = null;
          planExecutionRef.current = false;
          setPendingQuestion(null);
          setPendingPlanReview(null);
          contextManager.invalidateFileTree();

          const postAction = planPostActionRef.current;
          let willContinue = false;
          if (postAction) {
            planPostActionRef.current = null;
            const pContent = postAction.planContent;

            if (postAction.action === "revise") {
              willContinue = true;
              setActivePlan(null);
              setSidebarPlan(null);
              setCoreMessages((prev) => {
                let planIdx = -1;
                for (let i = prev.length - 1; i >= 0; i--) {
                  const m = prev[i];
                  if (
                    m?.role === "assistant" &&
                    Array.isArray(m.content) &&
                    m.content.some(
                      (p: unknown) =>
                        typeof p === "object" &&
                        p !== null &&
                        "type" in p &&
                        (p as { type: string }).type === "tool-call" &&
                        "toolName" in p &&
                        (p as { toolName: string }).toolName === "plan",
                    )
                  ) {
                    planIdx = i;
                    break;
                  }
                }
                if (planIdx < 0) return prev;
                return prev.slice(0, planIdx);
              });
              setTimeout(() => handleSubmit(postAction.reviseFeedback ?? "Revise the plan."), 0);
            } else {
              planModeRef.current = false;
              planRequestRef.current = null;
              setForgeMode("default");

              if (postAction.action === "cancel") {
                clearTasks(tabId);
                setMessages((prev) => [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    role: "system",
                    content: `Plan cancelled: ${postAction.plan?.title ?? ""}`,
                    timestamp: Date.now(),
                    showInChat: true,
                  },
                ]);
              } else if (
                (postAction.action === "clear_execute" || postAction.action === "execute") &&
                pContent
              ) {
                willContinue = true;
                const isClear = postAction.action === "clear_execute";
                if (isClear) {
                  contextManager.resetConversationTracking();
                  setCoreMessages([]);
                  setTokenUsage({ ...ZERO_USAGE });
                }
                const statusMsg: ChatMessage = {
                  id: crypto.randomUUID(),
                  role: "system",
                  content: isClear
                    ? "Context cleared — executing plan with fresh context..."
                    : "Plan accepted — executing...",
                  timestamp: Date.now(),
                };
                setMessages(isClear ? [statusMsg] : (prev) => [...prev, statusMsg]);
                if (postAction.plan) {
                  setActivePlan(postAction.plan);
                  setSidebarPlan(postAction.plan);
                }
                planExecutionRef.current = true;
                const isFullPlan = postAction.plan?.depth !== "light";
                const execPrompt = isFullPlan
                  ? `Execute this plan. The checklist is already live in the UI.\n` +
                    `Workflow per step:\n` +
                    `1. update_plan_step(stepId, "active")\n` +
                    `2. Apply edits: each step has old→new diffs — use edit_file with the exact old/new text.\n` +
                    `3. Run shell commands from the step if present.\n` +
                    `4. update_plan_step(stepId, "done")\n\n` +
                    `All file content is included in the code_snippets below. Edits are pre-validated against this content.\n\n${pContent}`
                  : `Execute this plan. The checklist is already live in the UI.\n` +
                    `Workflow per step:\n` +
                    `1. update_plan_step(stepId, "active")\n` +
                    `2. Read the target files, then apply the changes described in the step details.\n` +
                    `3. Run shell commands from the step if present.\n` +
                    `4. update_plan_step(stepId, "done")\n\n` +
                    `This is a light plan — read files as needed before editing.\n\n${pContent}`;
                setTimeout(() => handleSubmit(execPrompt), 0);
              }
            }
          } else if (pendingCompactRef.current) {
            willContinue = true;
            pendingCompactRef.current = false;
            const planSnapshot = activePlanRef.current;
            const buildPlanHint = () =>
              planSnapshot
                ? (() => {
                    const active = planSnapshot.steps.find((s) => s.status === "active");
                    const done = planSnapshot.steps.filter((s) => s.status === "done").length;
                    const total = planSnapshot.steps.length;
                    return ` You are executing plan "${planSnapshot.title}" — ${String(done)}/${String(total)} steps done.${active ? ` Currently on step [${active.id}]: ${active.label}.` : ""}`;
                  })()
                : "";
            summarizeConversationRef
              .current({ skipQueueDrain: true })
              .then(() => {
                setTimeout(() => handleSubmitRef.current(`Continue.${buildPlanHint()}`), 0);
              })
              .catch(() => {
                // Compaction failed — still continue so the agent doesn't hang
                setTimeout(() => handleSubmitRef.current(`Continue.${buildPlanHint()}`), 0);
              });
          }

          if (!willContinue && !stallRetryPendingRef.current) {
            setActivePlan(null);
            setSidebarPlan(null);
            clearTasks(tabId);
            setMessageQueue((queue) => {
              if (queue.length > 0) {
                const [next, ...rest] = queue;
                if (next) {
                  setTimeout(() => handleSubmitRef.current(next.content), 0);
                }
                return rest;
              }
              return queue;
            });
          }
        }
      }
    },
    [
      contextManager,
      sessionManager,
      interactiveCallbacks,
      cwd,
      flushStreamState,
      queueMicrotaskFlush,
      getWorkspaceSnapshot,
      setTokenUsage,
      setActivePlan,
      syncV2Slots,
      promptOutsideCwd,
      promptDestructive,
      tabId,
      tabLabel,
      setForgeMode,
    ],
  );
  handleSubmitRef.current = handleSubmit;

  // pendingQuestionRef / pendingPlanReviewRef are declared near their state (lines ~438, ~594)
  // so the stall watchdog inside handleSubmit can access them.

  const abort = useCallback(() => {
    if (compactAbortRef.current) {
      compactAbortRef.current.abort();
      compactAbortRef.current = null;
      isCompactingRef.current = false;
      setIsCompacting(false);
      if (visibleRef.current) useStatusBarStore.getState().setCompacting(false);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system" as const,
          content: "Compaction aborted.",
          timestamp: Date.now(),
        },
      ]);
      // Don't return — also kill any concurrent generation below
    }
    if (abortRef.current) {
      const pq = pendingQuestionRef.current;
      if (pq) {
        pq.resolve("__skipped__");
        setPendingQuestion(null);
      }
      const pr = pendingPlanReviewRef.current;
      if (pr) {
        pr.resolve("cancel");
        setPendingPlanReview(null);
      }
      // Kill any outstanding remote callbacks (approval/ask/plan-review waiting
      // on Telegram button taps) so they can't resolve a dead turn after abort.
      void import("../hearth/bridge.js").then(({ cancelRemoteCallbacksForTab }) => {
        cancelRemoteCallbacksForTab(tabId);
      });
      setActivePlan(null);
      setSidebarPlan(null);
      steeringAbortedRef.current = true;
      // Snapshot buffers before clearing so the catch block can reconstruct partial content
      abortedSegmentsSnapshot.current = [...streamSegmentsBuffer.current];
      abortedToolCallsSnapshot.current = [...liveToolCallsBuffer.current];
      abortRef.current.abort();
      abortRef.current = null;
      setIsLoading(false);
      resetInProgressTasks(tabId);
      setLiveToolCalls([]);
      setStreamSegments([]);
      messageQueueRef.current = [];
      setMessageQueue([]);
      liveToolCallsBuffer.current = [];
      streamSegmentsBuffer.current = [];
      lastFlushedToolCalls.current = [];
      streamingCharsRef.current = 0;
      toolCharsRef.current = 0;
      segmentsDirty.current = false;
      toolCallsDirty.current = false;
    }
  }, [setActivePlan, tabId]);

  // Snapshot current state for tab switching
  const snapshot = useCallback(
    (label: string): TabState => ({
      id: sessionIdRef.current,
      label,
      messages,
      coreMessages,
      activeModel,
      activePlan,
      sidebarPlan,
      tokenUsage,
      coAuthorCommits,
      sessionId: sessionIdRef.current,
      planMode: planModeRef.current,
      planRequest: planRequestRef.current,
      forgeMode,
    }),
    [
      messages,
      coreMessages,
      activeModel,
      activePlan,
      sidebarPlan,
      tokenUsage,
      coAuthorCommits,
      forgeMode,
    ],
  );

  const setPlanMode = useCallback((on: boolean) => {
    planModeRef.current = on;
  }, []);

  const setPlanRequest = useCallback((req: string | null) => {
    planRequestRef.current = req;
  }, []);

  // Abort everything on unmount (tab close) — kill streaming, compaction, agents
  useEffect(() => {
    return () => {
      if (compactAbortRef.current) {
        compactAbortRef.current.abort();
        compactAbortRef.current = null;
      }
      if (abortRef.current) {
        const pq = pendingQuestionRef.current;
        if (pq) pq.resolve("__skipped__");
        const pr = pendingPlanReviewRef.current;
        if (pr) pr.resolve("cancel");
        // Kill remote callbacks so Telegram buttons don't resolve a dead turn
        // after tab unmount.
        void import("../hearth/bridge.js").then(({ cancelRemoteCallbacksForTab }) => {
          cancelRemoteCallbacksForTab(tabId);
        });
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [tabId]);

  return {
    messages,
    setMessages,
    coreMessages,
    setCoreMessages: setCoreMessagesEager,
    isLoading,
    loadingStartedAt,
    isCompacting,
    streamSegments,
    liveToolCalls,
    activePlan,
    setActivePlan,
    sidebarPlan,
    setSidebarPlan,
    pendingQuestion,
    setPendingQuestion,
    messageQueue,
    setMessageQueue,
    activeModel,
    setActiveModel,
    coAuthorCommits,
    setCoAuthorCommits,
    tokenUsage,
    setTokenUsage,
    contextTokens,
    lastStepOutput,
    chatChars,
    sessionId: sessionIdRef.current,
    customTitle: customTitleRef.current,
    setCustomTitle,
    planFile: planFileName(sessionIdRef.current),
    planMode: planModeRef.current,
    planRequest: planRequestRef.current,
    handleSubmit,
    summarizeConversation,
    abort,
    interactiveCallbacks,
    setPlanMode,
    setPlanRequest,
    pendingPlanReview,
    setPendingPlanReview,
    snapshot,
    contextManager,
    forgeMode,
    setForgeMode,
    cycleMode: cycleModeFn,
  };
}
function causeChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    parts.push(cur instanceof Error ? `${cur.name}: ${cur.message}` : String(cur));
    cur = (cur as { cause?: unknown })?.cause;
  }
  return parts.join("\n  caused by: ");
}
