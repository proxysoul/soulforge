import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { ContextManager, type SharedContextResources } from "../../core/context/manager.js";
import { getWorkspaceCoordinator } from "../../core/coordination/WorkspaceCoordinator.js";
import { icon } from "../../core/icons.js";
import { buildInstructionPrompt, loadInstructions } from "../../core/instructions.js";
import type { ProviderStatus } from "../../core/llm/provider.js";
import { clearTabSessionPatterns } from "../../core/security/forbidden.js";
import type { SessionManager } from "../../core/sessions/manager.js";
import type { PrerequisiteStatus } from "../../core/setup/prerequisites.js";
import { type ThemeTokens, useTheme } from "../../core/theme/index.js";
import { clearEditStacks } from "../../core/tools/edit-stack.js";
import { planFileName } from "../../core/tools/index.js";
import { disposeTaskScope, setActiveTaskTab } from "../../core/tools/task-list.js";
import { type ChatInstance, type TabState, useChat } from "../../hooks/useChat.js";
import { useLandingTransition } from "../../hooks/useLandingTransition.js";
import type { TabActivity } from "../../hooks/useTabs.js";
import { useCheckpointStore } from "../../stores/checkpoints.js";
import { useStatusBarStore } from "../../stores/statusbar.js";
import { useUIStore } from "../../stores/ui.js";
import type {
  AppConfig,
  ChatMessage,
  EditorIntegration,
  ImageAttachment,
} from "../../types/index.js";
import { CheckpointRail } from "../chat/CheckpointRail.js";
import { FinalResponseLiveAutoView } from "../chat/FinalResponseView.js";
import { InputBox } from "../chat/InputBox.js";
import { CodeExpandedProvider, VerboseProvider } from "../chat/Markdown.js";
import {
  ExpandToggleProvider,
  RAIL_BORDER,
  ReasoningExpandedProvider,
  StaticMessage,
} from "../chat/MessageList.js";
import { StreamSegmentList } from "../chat/StreamSegmentList.js";
import { PlanProgress } from "../plan/PlanProgress.js";
import { PlanReviewPrompt } from "../plan/PlanReviewPrompt.js";
import { TaskProgress, useTaskList } from "../plan/TaskProgress.js";
import { QuestionPrompt } from "../QuestionPrompt.js";
import { chatScrollAccel } from "../ui/scroll.js";
import { AnimatedBorder } from "./AnimatedBorder.js";
import { ChangedFilesBar, ChangesPanel } from "./ChangedFiles.js";
import { LandingPage } from "./LandingPage.js";
import { LoadingStatus } from "./LoadingStatus.js";
import { SystemBanner } from "./SystemBanner.js";
import { TerminalsPanel } from "./TerminalList.js";

interface TabInstanceProps {
  tabId: string;
  tabLabel: string;
  visible: boolean;
  effectiveConfig: AppConfig;
  sharedResources: SharedContextResources;
  sessionManager: SessionManager;
  cwd: string;
  openEditorWithFile: (file: string) => void;
  openEditor: () => void;
  onSuspend: (opts: { command: string; args?: string[]; noAltScreen?: boolean }) => void;
  onCommand: (input: string, chat: ChatInstance) => void;
  onModeChange?: (mode: import("../../types/index.js").ForgeMode) => void;
  onModelChange?: (modelId: string) => void;
  onExit: () => void;
  registerChat: (id: string, chat: ChatInstance) => void;
  unregisterChat: (id: string) => void;
  setTabActivity: (id: string, activity: Partial<TabActivity>) => void;
  initialState?: TabState;
  editorVisible: boolean;
  focusMode: "chat" | "editor";
  anyModalOpen: boolean;
  bootProviders: ProviderStatus[];
  bootPrereqs: PrerequisiteStatus[];
  editorIntegration?: EditorIntegration;
  editorOpen: boolean;
  editorFile: string | null;
  editorModeName: string;
  editorCursorLine: number;
  editorCursorCol: number;
  editorVisualSelection: string | null;
  clearEditorSelection: () => void;
  onCycleTab?: (direction: 1 | -1) => void;
}

const MAX_RENDERED = 40;
const SCROLLBOX_STYLE = { contentOptions: { justifyContent: "flex-end" as const } };
const SCROLLBAR_HIDDEN = { visible: false } as const;
function getScrollbarVisible(tk: ThemeTokens) {
  return {
    visible: true as const,
    trackOptions: {
      foregroundColor: tk.textMuted,
      backgroundColor: tk.textSubtle,
    },
  };
}

export const TabInstance = memo(function TabInstance({
  tabId,
  tabLabel,
  visible,
  effectiveConfig,
  sharedResources,
  sessionManager,
  cwd,
  openEditorWithFile,
  openEditor,
  onSuspend,
  onCommand,
  onModeChange,
  onModelChange,
  onExit,
  registerChat,
  unregisterChat,
  setTabActivity,
  initialState,
  editorVisible,
  focusMode,
  anyModalOpen,
  bootProviders,
  bootPrereqs,
  editorIntegration,
  editorOpen,
  editorFile,
  editorModeName,
  editorCursorLine,
  editorCursorCol,
  editorVisualSelection,
  clearEditorSelection,
  onCycleTab,
}: TabInstanceProps) {
  const t = useTheme();
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  // Per-tab ContextManager sharing expensive resources
  const contextManager = useMemo(
    () => new ContextManager(cwd, sharedResources),
    [cwd, sharedResources],
  );

  // Register tabId with contextManager for cross-tab awareness
  useEffect(() => {
    contextManager.setTabId(tabId);
    contextManager.setTabLabel(tabLabel);
  }, [tabId, tabLabel, contextManager]);

  // Set active task tab when this tab becomes visible
  useEffect(() => {
    if (visible) setActiveTaskTab(tabId);
  }, [tabId, visible]);

  // Dispose task scope only on unmount (tab close), not on hide
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup-only on unmount
  useEffect(() => () => disposeTaskScope(tabId), []);

  useEffect(() => {
    if (editorIntegration) contextManager.setEditorIntegration(editorIntegration);
  }, [editorIntegration, contextManager]);

  useEffect(() => {
    contextManager.setEditorState(
      editorOpen,
      editorFile,
      editorModeName,
      editorCursorLine,
      editorCursorCol,
      editorVisualSelection,
    );
  }, [
    editorOpen,
    editorFile,
    editorModeName,
    editorCursorLine,
    editorCursorCol,
    editorVisualSelection,
    contextManager,
  ]);

  useEffect(() => {
    contextManager.setRepoMapEnabled(effectiveConfig.repoMap !== false);
  }, [effectiveConfig.repoMap, contextManager]);

  useEffect(() => {
    contextManager.setTaskRouter(effectiveConfig.taskRouter);
  }, [effectiveConfig.taskRouter, contextManager]);

  useEffect(() => {
    const loaded = loadInstructions(cwd, effectiveConfig.instructionFiles);
    contextManager.setProjectInstructions(buildInstructionPrompt(loaded));
  }, [effectiveConfig.instructionFiles, cwd, contextManager]);

  useEffect(() => {
    if (effectiveConfig.semanticSummaries !== undefined)
      contextManager.setSemanticSummaries(effectiveConfig.semanticSummaries);
    contextManager.setSemanticSummaryLimit(effectiveConfig.semanticSummaryLimit);
    contextManager.setSemanticAutoRegen(effectiveConfig.semanticAutoRegen);
    contextManager.setRepoMapTokenBudget(effectiveConfig.repoMapTokenBudget);
  }, [
    effectiveConfig.semanticSummaries,
    effectiveConfig.semanticSummaryLimit,
    effectiveConfig.semanticAutoRegen,
    effectiveConfig.repoMapTokenBudget,
    contextManager,
  ]);

  // Per-tab useChat instance
  const chat = useChat({
    effectiveConfig,
    contextManager,
    sessionManager,
    cwd,
    tabId,
    tabLabel,
    openEditorWithFile,
    openEditor,
    onSuspend,
    initialState,
    visible,
    onModelChange,
  });

  // Sync coAuthorCommits from config
  useEffect(() => {
    if (effectiveConfig.coAuthorCommits !== undefined)
      chat.setCoAuthorCommits(effectiveConfig.coAuthorCommits);
  }, [effectiveConfig.coAuthorCommits, chat.setCoAuthorCommits]);

  // Seed active model for semantic summary generation
  useEffect(() => {
    contextManager.setActiveModel(chat.activeModel);
  }, [chat.activeModel, contextManager]);

  // Register/unregister chat instance with tab manager
  useEffect(() => {
    registerChat(tabId, chat);
    return () => unregisterChat(tabId);
  }, [tabId, chat, registerChat, unregisterChat]);

  // Register this tab's chat handle with the Hearth bridge so Telegram/Discord/
  // App-level bootstrap (TuiHost start + auto-claim)
  // runs once in App.tsx; this effect only wires the per-tab submit/abort.
  useEffect(() => {
    let cancelled = false;
    void import("../../hearth/bridge.js")
      .then(({ hearthBridge }) => {
        if (cancelled) return;
        hearthBridge.registerTab({
          tabId,
          label: tabLabel,
          submit: async (input, origin, inboundId, images) => {
            try {
              type IA = import("../../types/index.js").ImageAttachment;
              const imgs: IA[] | undefined =
                images && images.length > 0
                  ? images
                      .map((im, i): IA | null => {
                        const mt = im.mediaType;
                        if (
                          mt !== "image/png" &&
                          mt !== "image/jpeg" &&
                          mt !== "image/gif" &&
                          mt !== "image/webp"
                        )
                          return null;
                        const base64 = im.url.startsWith("data:")
                          ? (im.url.split(",")[1] ?? "")
                          : im.url;
                        return { label: `image-${String(i + 1)}`, base64, mediaType: mt };
                      })
                      .filter((x): x is IA => x !== null)
                  : undefined;
              await chat.handleSubmit(input, imgs, {
                inboundId,
                origin,
              });
            } catch (err) {
              throw err instanceof Error ? err : new Error(String(err));
            }
          },
          abort: () => chat.abort(),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      void import("../../hearth/bridge.js").then(({ hearthBridge }) => {
        hearthBridge.unregisterTab(tabId);
      });
    };
  }, [tabId, tabLabel, chat]);

  // Sync forge mode to header when it changes in the active tab
  useEffect(() => {
    if (visible && onModeChange) onModeChange(chat.forgeMode);
  }, [visible, chat.forgeMode, onModeChange]);

  // Sync status bar when this tab is active
  useEffect(() => {
    if (visible) {
      useStatusBarStore.getState().setTokenUsage(chat.tokenUsage, chat.activeModel);
    }
  }, [visible, chat.tokenUsage, chat.activeModel]);

  // Per-tab loading start timestamp — driven by useChat (set after Soul Map wait)
  const loadingStartedAtRef = useRef(0);
  if (chat.loadingStartedAt > 0) loadingStartedAtRef.current = chat.loadingStartedAt;

  // Report loading state to tab manager, sync coordinator idle/active, update claim count
  const prevLoading = useRef(chat.isLoading);
  useEffect(() => {
    const coordinator = getWorkspaceCoordinator();
    setTabActivity(tabId, { isLoading: chat.isLoading, isCompacting: chat.isCompacting });
    // Mark unread if loading finished while tab is in background
    if (prevLoading.current && !chat.isLoading && !visible) {
      setTabActivity(tabId, { hasUnread: true });
    }
    // Signal coordinator idle/active state
    if (!chat.isLoading && prevLoading.current) {
      coordinator.markIdle(tabId);
    } else if (chat.isLoading && !prevLoading.current) {
      coordinator.markActive(tabId);
    }
    prevLoading.current = chat.isLoading;
  }, [chat.isLoading, chat.isCompacting, tabId, setTabActivity, visible]);

  // Signal attention when tab is waiting for user input (plan review or question)
  useEffect(() => {
    const needs = !!(chat.pendingPlanReview || chat.pendingQuestion);
    setTabActivity(tabId, { needsAttention: needs });
  }, [chat.pendingPlanReview, chat.pendingQuestion, tabId, setTabActivity]);

  // Sync claim count to tab activity for tab bar indicator
  useEffect(() => {
    const coordinator = getWorkspaceCoordinator();
    let lastCount = coordinator.getClaimCount(tabId);
    const unsub = coordinator.on((event, eventTabId) => {
      if (eventTabId === tabId || event === "release") {
        const newCount = coordinator.getClaimCount(tabId);
        if (newCount !== lastCount) {
          lastCount = newCount;
          setTabActivity(tabId, { editedFileCount: newCount });
        }
      }
    });
    return unsub;
  }, [tabId, setTabActivity]);

  // ── Checkpoint sync ──
  useEffect(() => {
    useCheckpointStore.getState().syncFromMessages(tabId, chat.messages, chat.isLoading);
  }, [tabId, chat.messages, chat.isLoading]);

  // Auto-tag checkpoints on completion (loading → false) — tag ALL untagged checkpoints with edits
  useEffect(() => {
    if (prevLoading.current && !chat.isLoading) {
      const store = useCheckpointStore.getState();
      const cps = store.getCheckpoints(tabId);
      for (const cp of cps) {
        if (cp.filesEdited.length > 0 && !cp.gitTag && !cp.undone) {
          store.createGitTag(tabId, cp.index, cwd);
        }
      }
    }
  }, [chat.isLoading, tabId, cwd]);

  // Checkpoint browsing state
  const checkpoints = useCheckpointStore((s) => s.tabs[tabId]?.checkpoints ?? []);
  const checkpointViewing = useCheckpointStore((s) => s.tabs[tabId]?.viewing ?? null);

  // Scroll to the viewed checkpoint's user message (pinned to top of viewport).
  // Use a microtask so layout has settled after the state change.
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb) return;
    if (checkpointViewing === null) {
      sb.scrollTo(sb.scrollHeight);
      return;
    }
    queueMicrotask(() => {
      const cp = checkpoints.find((c) => c.index === checkpointViewing);
      if (!cp) return;
      const child = sb.content.findDescendantById(`msg-${cp.anchorMessageId}`);
      if (child) {
        // Offset slightly so the "You" header is fully visible, not clipped
        sb.scrollTop = Math.max(0, child.y - 1);
      } else {
        sb.scrollChildIntoView(`msg-${cp.anchorMessageId}`);
      }
    });
  }, [checkpointViewing, checkpoints]);

  // Override context bar estimate when viewing a past checkpoint
  useEffect(() => {
    if (!visible) return;
    if (checkpointViewing === null) return;
    const cp = checkpoints.find((c) => c.index === checkpointViewing);
    if (!cp) return;
    const store = useStatusBarStore.getState();
    const savedChars = store.chatChars;
    // Sum chars from live messages up to (and including) this checkpoint's anchor.
    const anchorIdx = chat.messages.findIndex((m) => m.id === cp.anchorMessageId);
    const slice = anchorIdx >= 0 ? chat.messages.slice(0, anchorIdx + 1) : chat.messages;
    let chars = 0;
    for (const m of slice) {
      if (typeof m.content === "string") chars += m.content.length;
    }
    store.setContext(0, chars);
    store.setBrowsingCheckpoint(true);
    return () => {
      const s = useStatusBarStore.getState();
      s.setContext(0, savedChars);
      s.setBrowsingCheckpoint(false);
    };
  }, [checkpointViewing, checkpoints, visible, chat.messages]);

  // Cleanup / dispose on unmount
  useEffect(() => {
    return () => {
      contextManager.dispose();
      clearTabSessionPatterns(tabId);
      clearEditStacks(tabId);
      // Close tab in coordinator — releases claims, clears agents, blocks ghost claims
      getWorkspaceCoordinator().closeTab(tabId);
      // Clean up checkpoint git tags (skip if session is being saved) and state
      if (!useCheckpointStore.getState().shouldSkipCleanup(tabId)) {
        useCheckpointStore.getState().cleanupGitTags(tabId, cwd);
      }
      useCheckpointStore.getState().clear(tabId);
      // Clean up any pending plan file on disk
      const p = join(cwd, ".soulforge", "plans", planFileName(chat.sessionId));
      unlink(p).catch(() => {});
    };
  }, [contextManager, tabId, cwd, chat.sessionId]);

  // Derived state
  const isStreaming = chat.streamSegments.length > 0 || chat.liveToolCalls.length > 0;

  // Compute which messages should be dimmed.
  // Two independent sources:
  // 1. Undone checkpoints (permanent, from /checkpoint undo) — shows separator
  // 2. Viewing a past checkpoint (temporary, from ^B/^F) — no separator, clears on ^F to live
  const { dimmedMessageIds, firstDimmedMessageId, dimmedReason } = useMemo(() => {
    const ids = new Set<string>();
    let firstId: string | null = null;
    let reason: "undone" | "viewing" | null = null;

    // --- Undone checkpoints (permanent) ---
    const undoneAnchors = new Set(
      checkpoints.filter((cp) => cp.undone).map((cp) => cp.anchorMessageId),
    );
    if (undoneAnchors.size > 0) {
      let inUndone = false;
      for (const msg of chat.messages) {
        const isUserNonSteering = msg.role === "user" && !msg.isSteering;
        if (isUserNonSteering && undoneAnchors.has(msg.id)) {
          inUndone = true;
          if (!firstId) {
            firstId = msg.id;
            reason = "undone";
          }
        } else if (isUserNonSteering && !undoneAnchors.has(msg.id)) {
          inUndone = false;
        }
        if (inUndone) ids.add(msg.id);
      }
    }

    // --- Viewing a past checkpoint (temporary) ---
    if (checkpointViewing !== null) {
      let cpCounter = 0;
      let pastViewed = false;
      for (const msg of chat.messages) {
        if (msg.role === "user" && !msg.isSteering) {
          cpCounter++;
          if (cpCounter > checkpointViewing) pastViewed = true;
        }
        if (pastViewed) {
          if (!ids.has(msg.id) && !firstId) {
            firstId = msg.id;
            reason = "viewing";
          }
          ids.add(msg.id);
        }
      }
    }

    return { dimmedMessageIds: ids, firstDimmedMessageId: firstId, dimmedReason: reason };
  }, [chat.messages, checkpoints, checkpointViewing]);

  const nonSystemCount = useMemo(() => {
    let count = 0;
    for (const m of chat.messages) {
      if (m.role !== "system" || m.showInChat) count++;
    }
    return count;
  }, [chat.messages]);

  const hasContent = nonSystemCount > 0 || isStreaming;
  const transition = useLandingTransition(hasContent);
  const showLanding = transition.phase !== "chat";
  const showChat = transition.phase !== "landing";

  // Show scrollbar as soon as we have content. The stickyScroll + stickyStart="bottom"
  // combo handles initial positioning correctly.
  const scrollbarReady = hasContent;

  const {
    codeExpandedMap,
    changesExpanded,
    terminalsExpanded,
    chatStyle,
    editorSplit,
    showReasoning,
    reasoningExpandedMap,
    tabVerbose,
  } = useUIStore(
    useShallow((s) => ({
      codeExpandedMap: s.codeExpanded,
      changesExpanded: s.changesExpanded,
      terminalsExpanded: s.terminalsExpanded,
      chatStyle: s.chatStyle,
      editorSplit: s.editorSplit,
      showReasoning: s.showReasoning,
      reasoningExpandedMap: s.reasoningExpanded,
      tabVerbose: s.verboseByTab[tabId] ?? false,
    })),
  );
  const codeExpanded = !!codeExpandedMap[tabId];
  const reasoningExpanded = !!reasoningExpandedMap[tabId];
  const toggleAllExpandedForTab = useCallback(
    () => useUIStore.getState().toggleAllExpanded(tabId),
    [tabId],
  );

  const showPlanProgress = !!chat.activePlan;
  const tasks = useTaskList(tabId);

  const hasChangedFiles = useMemo(() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const msg = chat.messages[i];
      if (msg?.role !== "assistant" || !msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        if ((tc.name === "edit_file" || tc.name === "multi_edit") && tc.result?.success)
          return true;
        if (tc.name === "dispatch" && tc.result?.filesEdited?.length) return true;
      }
    }
    return false;
  }, [chat.messages]);

  const visibleMessages = useMemo(() => {
    const msgs = chat.messages;
    const keep = (m: ChatMessage) => m.role !== "system" || m.showInChat;
    if (nonSystemCount <= MAX_RENDERED) return msgs.filter(keep);

    // When viewing a past checkpoint (not the latest), shift window to include it
    if (checkpointViewing !== null) {
      const isLatest = checkpoints.length > 0 && checkpointViewing >= checkpoints.length;
      if (!isLatest) {
        const cp = checkpoints.find((c) => c.index === checkpointViewing);
        if (cp) {
          // For checkpoint 1, start from the beginning so no "earlier messages" banner
          const startIdx =
            checkpointViewing === 1
              ? 0
              : Math.max(0, msgs.findIndex((m) => m.id === cp.anchorMessageId) - 4);
          const result: typeof msgs = [];
          for (let i = startIdx; i < msgs.length && result.length < MAX_RENDERED; i++) {
            if (keep(msgs[i] as ChatMessage)) result.push(msgs[i] as (typeof msgs)[0]);
          }
          return result;
        }
      }
    }

    const result: typeof msgs = [];
    for (let i = msgs.length - 1; i >= 0 && result.length < MAX_RENDERED; i--) {
      if (keep(msgs[i] as ChatMessage)) result.push(msgs[i] as (typeof msgs)[0]);
    }
    result.reverse();
    return result;
  }, [chat.messages, nonSystemCount, checkpointViewing, checkpoints]);
  const hiddenCount = nonSystemCount - visibleMessages.length;

  // Trim old tool results
  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow trigger
  useEffect(() => {
    const TRIM_THRESHOLD = 50;
    const KEEP_RECENT = 30;
    if (chat.messages.length < TRIM_THRESHOLD) return;
    const trimCount = chat.messages.length - KEEP_RECENT;
    let changed = false;
    const updated = chat.messages.map((msg, i) => {
      if (i >= trimCount || !msg.toolCalls) return msg;
      let tcChanged = false;
      const newToolCalls = msg.toolCalls.map((tc) => {
        if (tc.result && tc.result.output.length > 200) {
          tcChanged = true;
          return {
            ...tc,
            result: { ...tc.result, output: `${tc.result.output.slice(0, 100)}…[trimmed]` },
          };
        }
        return tc;
      });
      if (!tcChanged) return msg;
      changed = true;
      return { ...msg, toolCalls: newToolCalls };
    });
    if (changed) chat.setMessages(updated);
  }, [chat.messages.length]);

  const cleanupPlanFile = useCallback(() => {
    const p = join(cwd, ".soulforge", "plans", planFileName(chat.sessionId));
    unlink(p).catch(() => {});
  }, [cwd, chat.sessionId]);

  const onAcceptPlan = useCallback(() => {
    chat.pendingPlanReview?.resolve("execute");
    cleanupPlanFile();
  }, [chat.pendingPlanReview, cleanupPlanFile]);

  const onClearAndImplementPlan = useCallback(() => {
    chat.pendingPlanReview?.resolve("clear_execute");
    cleanupPlanFile();
  }, [chat.pendingPlanReview, cleanupPlanFile]);

  const onRevisePlan = useCallback(
    (feedback: string) => {
      chat.pendingPlanReview?.resolve(feedback);
    },
    [chat.pendingPlanReview],
  );

  const onCancelPlan = useCallback(() => {
    chat.pendingPlanReview?.resolve("cancel");
    cleanupPlanFile();
  }, [chat.pendingPlanReview, cleanupPlanFile]);

  const branchingRef = useRef(false);
  const handleInputSubmit = useCallback(
    async (input: string, images?: ImageAttachment[]) => {
      if (input.startsWith("/")) {
        onCommand(input, chat);
        return;
      }
      // Branch-on-submit: if viewing a past checkpoint, undo to that point (reverts files + messages)
      const cpStore = useCheckpointStore.getState();
      const viewingIdx = cpStore.getViewing(tabId);
      if (viewingIdx !== null) {
        if (branchingRef.current) return; // guard against double-submit during async undo
        branchingRef.current = true;
        try {
          const undoResult = await cpStore.undoToCheckpoint(tabId, viewingIdx, cwd, chat.messages);
          const msgs = undoResult?.messages;
          if (msgs) {
            chat.setMessages(msgs);
            try {
              const { rebuildCoreMessages } = await import("../../core/sessions/rebuild.js");
              chat.setCoreMessages(rebuildCoreMessages(msgs));
            } catch {
              chat.setCoreMessages([]);
            }
          }
          if (!undoResult) cpStore.setViewing(tabId, null);
        } finally {
          branchingRef.current = false;
        }
      }
      chat.handleSubmit(input, images);
      clearEditorSelection();
      // Re-engage sticky scroll so new messages are visible
      const sb = scrollRef.current;
      if (sb) {
        sb.scrollTo(sb.scrollHeight);
      }
    },
    [chat, onCommand, clearEditorSelection, tabId, cwd],
  );

  const isFocused = visible && focusMode === "chat" && !anyModalOpen;

  return (
    <box
      visible={visible}
      flexDirection="column"
      flexGrow={editorVisible ? 0 : 1}
      flexShrink={editorVisible ? 1 : 0}
      width={editorVisible ? (`${String(100 - editorSplit)}%` as `${number}%`) : "100%"}
    >
      <SystemBanner messages={chat.messages} expanded={codeExpanded} />

      <box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="row">
        {/* ── Landing page layer (fades out during transition) ── */}
        {showLanding && (
          <box
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            style={{ opacity: transition.landingOpacity }}
            position={showChat ? "absolute" : "relative"}
            width={showChat ? "100%" : undefined}
            height={showChat ? "100%" : undefined}
          >
            <LandingPage
              bootProviders={bootProviders}
              bootPrereqs={bootPrereqs}
              activeModel={chat.activeModel}
            />
          </box>
        )}

        {/* ── Chat content layer (fades in during transition) ── */}
        {showChat && (
          <box
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            flexDirection="row"
            style={{ opacity: transition.chatOpacity }}
          >
            <AnimatedBorder active={chat.isLoading || chat.isCompacting}>
              <scrollbox
                ref={scrollRef}
                stickyScroll={true}
                stickyStart="bottom"
                scrollAcceleration={chatScrollAccel}
                viewportCulling={true}
                focusable={false}
                flexGrow={1}
                flexShrink={1}
                minHeight={0}
                style={SCROLLBOX_STYLE}
                verticalScrollbarOptions={
                  scrollbarReady ? getScrollbarVisible(t) : SCROLLBAR_HIDDEN
                }
                horizontalScrollbarOptions={SCROLLBAR_HIDDEN}
              >
                <ExpandToggleProvider value={toggleAllExpandedForTab}>
                  <CodeExpandedProvider value={codeExpanded}>
                    <VerboseProvider value={effectiveConfig.verbose === true}>
                      <ReasoningExpandedProvider value={reasoningExpanded}>
                        {hiddenCount > 0 && (
                          <box paddingX={1} marginBottom={1}>
                            <text fg={t.textDim}>
                              ── {String(hiddenCount)} earlier message{hiddenCount > 1 ? "s" : ""}{" "}
                              ──
                            </text>
                          </box>
                        )}
                        {visibleMessages.map((msg) => (
                          <box
                            key={msg.id}
                            id={`msg-${msg.id}`}
                            flexDirection="column"
                            width="100%"
                          >
                            {msg.id === firstDimmedMessageId && (
                              <box marginTop={1} height={1} paddingX={1}>
                                <text fg={dimmedReason === "viewing" ? t.textMuted : t.warning}>
                                  {dimmedReason === "viewing"
                                    ? `${icon("rewind")} Viewing checkpoint #${String(checkpointViewing)}, send a message to rewind here.`
                                    : `${icon("rewind")} Rewound past this point.`}
                                </text>
                              </box>
                            )}
                            <StaticMessage
                              msg={msg}
                              chatStyle={chatStyle}
                              diffStyle={effectiveConfig.diffStyle}
                              collapseDiffs={effectiveConfig.collapseDiffs === true}
                              showReasoning={showReasoning}
                              reasoningExpanded={reasoningExpanded}
                              animate={false}
                              tabVerbose={tabVerbose}
                              dimmed={dimmedMessageIds.has(msg.id)}
                              verbose={effectiveConfig.verbose === true}
                            />
                          </box>
                        ))}
                        {isStreaming && (
                          <box paddingX={1} flexShrink={0} marginBottom={1}>
                            <box
                              flexDirection="column"
                              border={["left"]}
                              borderColor={t.brand}
                              customBorderChars={RAIL_BORDER}
                              paddingLeft={2}
                            >
                              <box>
                                <text fg={t.brand}>{icon("ai")} Forge</text>
                              </box>
                              {tabVerbose ? (
                                <StreamSegmentList
                                  segments={chat.streamSegments}
                                  toolCalls={chat.liveToolCalls}
                                  streaming={chat.isLoading}
                                  verbose={effectiveConfig.verbose === true}
                                  diffStyle={effectiveConfig.diffStyle}
                                  showReasoning={showReasoning}
                                  reasoningExpanded={reasoningExpanded}
                                />
                              ) : (
                                <FinalResponseLiveAutoView
                                  segments={chat.streamSegments}
                                  liveToolCalls={chat.liveToolCalls}
                                  loadingStartedAt={loadingStartedAtRef.current}
                                  messagesLength={chat.messages.length}
                                  finalResponseCalled={chat.finalResponseCalled}
                                />
                              )}
                            </box>
                          </box>
                        )}
                      </ReasoningExpandedProvider>
                    </VerboseProvider>
                  </CodeExpandedProvider>
                </ExpandToggleProvider>
                {tabVerbose ? (
                  <LoadingStatus
                    isLoading={chat.isLoading}
                    isCompacting={chat.isCompacting}
                    loadingStartedAt={loadingStartedAtRef.current}
                  />
                ) : chat.isLoading ? (
                  <box paddingX={1} height={1} flexShrink={0}>
                    <text fg={t.error} attributes={TextAttributes.BOLD}>
                      {icon("stop")} ^X to stop
                    </text>
                  </box>
                ) : null}
              </scrollbox>
            </AnimatedBorder>
            {checkpoints.length >= 1 && (
              <CheckpointRail
                checkpoints={checkpoints}
                viewing={checkpointViewing}
                isLoading={chat.isLoading}
              />
            )}
          </box>
        )}
        {(changesExpanded || terminalsExpanded) && (
          <box flexDirection="column" width="20%">
            {changesExpanded && <ChangesPanel messages={chat.messages} cwd={cwd} />}
            {terminalsExpanded && <TerminalsPanel />}
          </box>
        )}
      </box>

      {chat.pendingPlanReview ? (
        <box flexShrink={0} paddingX={1}>
          <PlanReviewPrompt
            isActive={isFocused}
            plan={chat.pendingPlanReview.plan}
            planFile={chat.pendingPlanReview.planFile}
            onAccept={onAcceptPlan}
            onClearAndImplement={onClearAndImplementPlan}
            onRevise={onRevisePlan}
            onCancel={onCancelPlan}
          />
        </box>
      ) : chat.pendingQuestion ? (
        <>
          <box flexShrink={0} paddingX={1}>
            <QuestionPrompt question={chat.pendingQuestion} isActive={isFocused} />
          </box>
          {showPlanProgress && chat.activePlan && (
            <box flexShrink={0} paddingX={1}>
              <PlanProgress plan={chat.activePlan} tasks={tasks} />
            </box>
          )}
          {!showPlanProgress && tasks.length > 0 && (
            <box flexShrink={0} paddingX={1}>
              <TaskProgress tabId={tabId} />
            </box>
          )}
          {hasChangedFiles && (
            <box flexShrink={0} paddingX={1}>
              <ChangedFilesBar messages={chat.messages} />
            </box>
          )}
        </>
      ) : (
        <>
          {showPlanProgress && chat.activePlan && (
            <box flexShrink={0} paddingX={1}>
              <PlanProgress plan={chat.activePlan} tasks={tasks} />
            </box>
          )}
          {!showPlanProgress && tasks.length > 0 && (
            <box flexShrink={0} paddingX={1}>
              <TaskProgress tabId={tabId} />
            </box>
          )}
          {(hasChangedFiles || chat.messageQueue.length > 0) && (
            <box flexShrink={0} paddingX={1} flexDirection="row" gap={1} height={1}>
              {hasChangedFiles && <ChangedFilesBar messages={chat.messages} />}
              {chat.messageQueue.length > 0 &&
                (() => {
                  const latest = chat.messageQueue[chat.messageQueue.length - 1]?.content ?? "";
                  const firstLine = latest.split("\n")[0] ?? "";
                  const extraLines = latest.split("\n").length - 1;
                  const prevCount = chat.messageQueue.length - 1;
                  return (
                    <text fg={t.warning} truncate>
                      │ Steering: {firstLine}
                      {extraLines > 0 && (
                        <span fg={t.textMuted}> (+{String(extraLines)} lines)</span>
                      )}
                      {prevCount > 0 && (
                        <span fg={t.textMuted}> (+{String(prevCount)} queued)</span>
                      )}
                    </text>
                  );
                })()}
            </box>
          )}
          <box
            flexShrink={0}
            zIndex={10}
            alignItems={transition.phase !== "chat" ? "center" : undefined}
          >
            <box
              width={
                transition.phase === "chat"
                  ? "100%"
                  : (`${String(Math.round(transition.inputWidthPct))}%` as `${number}%`)
              }
              flexShrink={0}
            >
              <InputBox
                tabId={tabId}
                onSubmit={handleInputSubmit}
                isLoading={chat.isLoading}
                isCompacting={chat.isCompacting}
                isFocused={isFocused}
                cwd={cwd}
                onExit={onExit}
                widthPct={transition.phase === "chat" ? undefined : transition.inputWidthPct}
                onQueue={(msg, images) =>
                  chat.setMessageQueue((prev) =>
                    prev.length >= 5
                      ? prev
                      : [...prev, { content: msg, queuedAt: Date.now(), images }],
                  )
                }
                onCycleTab={onCycleTab}
                viewingCheckpoint={checkpointViewing}
              />
            </box>
          </box>
        </>
      )}
    </box>
  );
});
