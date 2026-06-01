import { join } from "node:path";
import { type Selection, TextAttributes } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  applyConfigPatch,
  mergeConfigs,
  removeGlobalConfigKeys,
  removeProjectConfigKeys,
  saveGlobalConfig,
  saveProjectConfig,
  stripConfigKeys,
} from "../config/index.js";
import { handleCommand } from "../core/commands/registry.js";
import { ContextManager } from "../core/context/manager.js";
import { getWorkspaceCoordinator } from "../core/coordination/WorkspaceCoordinator.js";
import { setEditorRequestCallback } from "../core/editor/instance.js";
import { icon, providerIcon, UI_ICONS } from "../core/icons.js";
import { runIntelligenceHealthCheck } from "../core/intelligence/index.js";
import {
  fetchGroupedModels,
  fetchOpenRouterMetadata,
  fetchProviderModels,
  getShortModelLabel,
  PROVIDER_CONFIGS,
} from "../core/llm/models.js";
import { notifyProviderSwitch } from "../core/llm/provider.js";
import { disposeMCPManager, getMCPManager } from "../core/mcp/index.js";
import { initForbidden } from "../core/security/forbidden.js";
import { SessionManager } from "../core/sessions/manager.js";
import { getMissingRequired } from "../core/setup/prerequisites.js";
import { suspendAndRun } from "../core/terminal/suspend.js";
import { useTheme } from "../core/theme/index.js";
import { restoreSessionImages } from "../core/tools/show-image.js";
import { pickWordmark } from "../core/utils/splash.js";
import { isDismissed } from "../core/version.js";
import type { ChatInstance, WorkspaceSnapshot } from "../hooks/useChat.js";
import { useConfigSync } from "../hooks/useConfigSync.js";
import { useEditorFocus } from "../hooks/useEditorFocus.js";
import { useEditorInput } from "../hooks/useEditorInput.js";
import { getModeColor, getModeLabel } from "../hooks/useForgeMode.js";
import { useGitStatus } from "../hooks/useGitStatus.js";
import { useGlobalKeyboard } from "../hooks/useGlobalKeyboard.js";
import { useNeovim } from "../hooks/useNeovim.js";
import { buildTabMeta } from "../hooks/useSessionBuilder.js";
import { useTabs } from "../hooks/useTabs.js";
import { useVersionCheck } from "../hooks/useVersionCheck.js";
import { cleanupAndExit, restart, setExitSessionId } from "../index.js";
import { useCheckpointStore } from "../stores/checkpoints.js";
import { logBackgroundError } from "../stores/errors.js";
import { startMemoryPoll } from "../stores/statusbar.js";
import { useToolsStore } from "../stores/tools.js";
import { type ModalName, selectIsAnyModalOpen, useUIStore } from "../stores/ui.js";
import { useVersionStore } from "../stores/version.js";
import type { AppConfig, ChatMessage, EditorIntegration, TaskRouter } from "../types/index.js";
import { copyToClipboard as nativeCopyToClipboard } from "../utils/clipboard.js";
import { BrandTag } from "./layout/BrandTag.js";
import { ContextBar } from "./layout/ContextBar.js";
import { EditorPanel } from "./layout/EditorPanel.js";
import { FloatingTerminal } from "./layout/FloatingTerminal.js";
import { Footer } from "./layout/Footer.js";
import type { ConfigScope } from "./layout/shared.js";
import { TabBar } from "./layout/TabBar.js";
import { TabInstance } from "./layout/TabInstance.js";
import { TokenDisplay } from "./layout/TokenDisplay.js";
import { SimpleModalLayer } from "./ModalLayer.js";
import { CommandPalette } from "./modals/CommandPalette.js";
import { CommandPicker } from "./modals/CommandPicker.js";
import { DiagnosePopup } from "./modals/DiagnosePopup.js";
import { FirstRunWizard } from "./modals/FirstRunWizard.js";
import { GitCommitModal } from "./modals/GitCommitModal.js";
import { GitMenu } from "./modals/GitMenu.js";
import { InfoPopup } from "./modals/InfoPopup.js";
import { LlmSelector } from "./modals/LlmSelector.js";
import { SessionPicker } from "./modals/SessionPicker.js";
import { StatusDashboard } from "./modals/StatusDashboard.js";
import { TabNamePopup } from "./modals/TabNamePopup.js";
import { UiDemo } from "./modals/UiDemo.js";
import { UpdateModal } from "./modals/UpdateModal.js";
import { EditorSettings } from "./settings/EditorSettings.js";
import { HearthSettings } from "./settings/HearthSettings.js";
import { LspInstallSearch } from "./settings/LspInstallSearch.js";
import { MCPSettings } from "./settings/MCPSettings.js";
import { ModelEventsPopup } from "./settings/ModelEventsPopup.js";
import { ProviderSettings } from "./settings/ProviderSettings.js";
import { RepoMapStatusPopup } from "./settings/RepoMapStatusPopup.js";
import { RouterSettings } from "./settings/RouterSettings.js";
import { SkillSearch } from "./settings/SkillSearch.js";
import { ToolsPopup } from "./settings/ToolsPopup.js";

startMemoryPoll();

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

const ABORT_ON_LOADING = new Set([
  "/clear",
  "/compact",
  "/plan",
  "/session clear",
  "/session compact",
  "/session plan",
]);

const DEFAULT_TASK_ROUTER: TaskRouter = {
  spark: null,
  ember: null,
  webSearch: null,
  desloppify: null,
  verify: null,
  compact: null,
  semantic: null,
  default: null,
};

const SHUTDOWN_STEPS = [
  "quenching active flames",
  "forging session to disk",
  "sealing the vault",
  "until next time, forgemaster",
];

// Linear interpolate two #rrggbb hex colors → #rrggbb. Mirrors boot.tsx.
function lerpHex(a: string, b: string, tVal: number): string {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * tVal);
  const g = Math.round(ag + (bg - ag) * tVal);
  const bl = Math.round(ab + (bb - ab) * tVal);
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(bl)}`;
}

function ShutdownSplash({
  phase,
  sessionId,
  height,
}: {
  phase: number;
  sessionId: string | null;
  height: number;
}) {
  const shortId = sessionId?.slice(0, 8);
  const [tick, setTick] = useState(0);
  const { width: termWidth } = useTerminalDimensions();

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 80);
    return () => clearInterval(timer);
  }, []);

  const t = useTheme();
  const wordmark = pickWordmark(termWidth ?? 80);
  const wmW = wordmark[0]?.length ?? 0;

  // Inverse of the boot warm-up: the forge cools. Start amber (hot
  // from use) and fade down through warning → brandAlt → brand →
  // brandDim over ~3s. One-shot — no loop.
  const FADE_TICKS = 40; // 40 * 80ms = 3.2s
  const fadeT = Math.min(1, tick / FADE_TICKS);
  const stops = [t.amber, t.warning, t.brandAlt, t.brand, t.brandDim];
  const scaled = fadeT * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - i;
  const wordmarkColor = lerpHex(stops[i] ?? t.brand, stops[i + 1] ?? t.brandDim, frac);

  // Slow highlight sweep (same idea as boot, inverse direction — the
  // ember trails off toward the left as the forge cools). 4.2s cycle,
  // 3-cell bright band, tinted 55% toward #ffd68a (amber-cream).
  const SWEEP_TICKS = 52;
  const sweepT = (tick % SWEEP_TICKS) / SWEEP_TICKS;
  const sweepX = Math.floor((1 - sweepT) * (wmW + 8)) - 4;
  const warmColor = lerpHex(wordmarkColor, "#ffd68a", 0.55);

  const renderRow = (line: string): React.ReactNode => {
    const nodes: React.ReactNode[] = [];
    let buffer = "";
    let bufferColor = wordmarkColor;
    const flush = (key: string) => {
      if (!buffer) return;
      nodes.push(
        <span key={key} fg={bufferColor}>
          {buffer}
        </span>,
      );
      buffer = "";
    };
    for (let x = 0; x < line.length; x++) {
      const ch = line.charAt(x);
      if (ch === " ") {
        const target = wordmarkColor;
        if (target !== bufferColor) {
          flush(`s-${x}`);
          bufferColor = target;
        }
        buffer += " ";
        continue;
      }
      const d = Math.abs(x - sweepX);
      const target = d <= 1 ? warmColor : wordmarkColor;
      if (target !== bufferColor) {
        flush(`c-${x}`);
        bufferColor = target;
      }
      buffer += ch;
    }
    flush("end");
    return nodes;
  };

  return (
    <box flexDirection="column" height={height} justifyContent="center" alignItems="center">
      {wordmark.map((line, idx) => (
        <text
          // biome-ignore lint/suspicious/noArrayIndexKey: wordmark rows are positional
          key={idx}
          attributes={TextAttributes.BOLD}
        >
          {renderRow(line)}
        </text>
      ))}
      <box height={1} />
      <box
        flexDirection="column"
        gap={0}
        alignItems="flex-start"
        height={SHUTDOWN_STEPS.length + 3}
      >
        {SHUTDOWN_STEPS.map((label, i) => {
          if (i > phase) return null;
          const active = i === phase;
          const done = i < phase;
          const dotColor = done ? t.textFaint : active ? wordmarkColor : t.textFaint;
          const textColor = done ? t.textFaint : active ? t.textPrimary : t.textFaint;
          return (
            <text key={label}>
              <span fg={dotColor}>·</span>
              <span fg={textColor}> {label}</span>
            </text>
          );
        })}
        {shortId && phase >= 3 && (
          <>
            <box height={1} />
            <text>
              <span fg={t.textMuted}>resume </span>
              <span fg={wordmarkColor}>soulforge --session {shortId}</span>
            </text>
          </>
        )}
      </box>
    </box>
  );
}

import { getCwd } from "../core/cwd.js";
import {
  getCachedProviderStatuses,
  type ProviderStatus,
  subscribeProviderStatuses,
} from "../core/llm/provider.js";
import type { PrerequisiteStatus } from "../core/setup/prerequisites.js";
import { getEditedFilesForTab } from "../core/tools/edit-stack.js";
import { useMCPStore } from "../stores/mcp.js";
import { getAppSessionId, setAppSessionId } from "../stores/session.js";
import { MemoryBrowser } from "./modals/MemoryBrowser.js";
import { DialogHost } from "./ui/DialogHost.js";

interface Props {
  config: AppConfig;
  projectConfig?: Partial<AppConfig> | null;
  resumeSessionId?: string;
  forceWizard?: boolean;
  bootProviders: ProviderStatus[];
  bootPrereqs: PrerequisiteStatus[];
  preloadedContextManager?: ContextManager;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal protocol responses
const KITTY_PROTOCOL_RESPONSE_RE = /\x1b\[\?\d+u/g;

function CheckpointLegend({ tabId, fallbackSpacer }: { tabId: string; fallbackSpacer?: boolean }) {
  const t = useTheme();
  const count = useCheckpointStore((s) => s.tabs[tabId]?.checkpoints?.length ?? 0);
  if (count <= 1) return fallbackSpacer ? <box height={1} flexShrink={0} /> : null;
  return (
    <box
      flexShrink={0}
      height={1}
      paddingX={1}
      flexDirection="row"
      justifyContent="flex-end"
      flexGrow={1}
    >
      <text fg={t.textDim}>
        <span fg={t.brand}>◆</span> latest
        <span fg={t.textFaint}> │ </span>
        <span fg={t.warning}>●</span> viewing
        <span fg={t.textFaint}> │ </span>
        <span fg={t.textMuted}>●</span> edits
        <span fg={t.textFaint}> │ </span>
        <span fg={t.textFaint}>○</span> read
        <span fg={t.textFaint}> │ </span>
        <span fg={t.textMuted}>^B</span>/<span fg={t.textMuted}>^F</span> navigate
      </text>
    </box>
  );
}

export function App({
  config,
  projectConfig,
  resumeSessionId,
  forceWizard,
  bootProviders,
  bootPrereqs,
  preloadedContextManager,
}: Props) {
  const renderer = useRenderer();
  const { height: termHeight, width: termWidth } = useTerminalDimensions();
  // `useTheme()` reads `state.tokens` — when `setTheme()` replaces the tokens
  // object zustand fires a subscriber update, so the App rerenders on theme
  // change without a second subscription to `state.name`.
  const t = useTheme();
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>(() => {
    return getCachedProviderStatuses() ?? bootProviders;
  });
  const [shutdownPhase, setShutdownPhase] = useState(-1);
  const savedSessionIdRef = useRef<string | null>(null);

  // Strip Kitty keyboard protocol query responses (\x1b[?<n>u) from stdin.
  // These leak when Neovim queries the terminal's protocol state.
  useEffect(() => {
    const stdin = process.stdin;
    const originalRead = stdin.read.bind(stdin);
    const patchedRead = (size?: number) => {
      const chunk = originalRead(size);
      if (chunk === null) return null;
      const str = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf-8");
      KITTY_PROTOCOL_RESPONSE_RE.lastIndex = 0;
      if (!KITTY_PROTOCOL_RESPONSE_RE.test(str)) return chunk;
      const cleaned = str.replace(KITTY_PROTOCOL_RESPONSE_RE, "");
      if (cleaned.length === 0) return null;
      if (typeof chunk === "string") return cleaned;
      return Buffer.from(cleaned, "utf-8");
    };
    stdin.read = patchedRead as typeof stdin.read;
    return () => {
      stdin.read = originalRead;
    };
  }, []);

  const copyToClipboard = useCallback(
    (text: string) => {
      if (!renderer.copyToClipboardOSC52(text)) {
        nativeCopyToClipboard(text);
      }
    },
    [renderer],
  );

  useEffect(() => {
    setProviderStatuses(getCachedProviderStatuses() ?? bootProviders);
  }, [bootProviders]);

  useEffect(() => subscribeProviderStatuses(setProviderStatuses), []);

  useEffect(() => {
    const onSelection = (sel: Selection) => {
      const text = sel.getSelectedText();
      if (text) copyToClipboard(text);
    };
    renderer.on("selection", onSelection);
    return () => {
      renderer.off("selection", onSelection);
    };
  }, [renderer, copyToClipboard]);

  useEffect(() => {
    fetchOpenRouterMetadata();
  }, []);

  const [globalConfig, setGlobalConfig] = useState<AppConfig>(config);
  const [projConfig, setProjConfig] = useState<Partial<AppConfig> | null>(projectConfig ?? null);
  const [routerScope, setRouterScope] = useState<ConfigScope>(() =>
    projectConfig && "taskRouter" in projectConfig ? "project" : "global",
  );
  const modelScope = useMemo(
    () =>
      projConfig && "defaultModel" in projConfig
        ? ("project" as ConfigScope)
        : ("global" as ConfigScope),
    [projConfig],
  );
  const effectiveConfig = useMemo(
    () => mergeConfigs(globalConfig, projConfig),
    [globalConfig, projConfig],
  );

  const { focusMode, editorOpen, toggleEditor, openEditor, closeEditor, focusChat, focusEditor } =
    useEditorFocus();
  const [editorVisible, setEditorVisible] = useState(false);

  const tabMgr = useTabs((survivingIds) => {
    // A tab was closed — immediately drop it from the on-disk session so it
    // can't reappear on the next restore. Best-effort; failures are non-fatal.
    const sm = sessionManagerRef.current;
    const sid = getAppSessionId();
    if (sm && sid) sm.pruneTabsNotIn(sid, survivingIds).catch(() => {});
  });
  const tabMgrRef = useRef(tabMgr);
  tabMgrRef.current = tabMgr;
  // Ref so the closeTab callback (created above) can reach sessionManager,
  // which is declared later — avoids a TDZ on the const binding.
  const sessionManagerRef = useRef<SessionManager | null>(null);

  const hasTabBarRef = useRef(false);
  hasTabBarRef.current = tabMgr.tabCount > 1;
  const editorSplitRef = useRef(60);
  const {
    ready: nvimReady,
    ptyWrite,
    ptyOnData,
    nvimCols,
    nvimRows,
    modeName: nvimMode,
    fileName: editorFile,
    cursorLine,
    cursorCol,
    visualSelection,
    clearSelection: clearNvimSelection,
    openFile: nvimOpen,
    error: nvimError,
  } = useNeovim(
    true,
    effectiveConfig.nvimPath,
    effectiveConfig.nvimConfig,
    closeEditor,
    hasTabBarRef.current,
    editorSplitRef.current,
  );

  const pendingEditorFileRef = useRef<string | null>(null);

  useEffect(() => {
    if (nvimReady && pendingEditorFileRef.current) {
      const file = pendingEditorFileRef.current;
      pendingEditorFileRef.current = null;
      nvimOpen(file).catch((err) => {
        logBackgroundError(
          "editor",
          `failed to open ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }, [nvimReady, nvimOpen]);

  const openEditorWithFile = useCallback(
    (file: string) => {
      if (editorOpen && nvimReady) {
        nvimOpen(file).catch((err) => {
          logBackgroundError(
            "editor",
            `failed to open ${file}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      } else {
        pendingEditorFileRef.current = file;
        openEditor();
      }
    },
    [editorOpen, nvimReady, nvimOpen, openEditor],
  );

  useEffect(() => {
    setEditorRequestCallback((file) => {
      if (file) openEditorWithFile(file);
    });
    return () => setEditorRequestCallback(null);
  }, [openEditorWithFile]);

  useEffect(() => {
    if (editorOpen) setEditorVisible(true);
  }, [editorOpen]);

  // Mirror the active tab + activity into the terminal window title.
  // Truncates long labels so OS title bars stay readable.
  useEffect(() => {
    const activity = tabMgr.getTabActivity(tabMgr.activeTabId);
    const label = tabMgr.activeTab.label;
    const truncated = label.length > 40 ? `${label.slice(0, 37)}…` : label;
    const marker = activity.isLoading || activity.isCompacting ? "● " : "";
    try {
      renderer.setTerminalTitle(`${marker}SoulForge · ${truncated}`);
    } catch {}
  }, [renderer, tabMgr.activeTabId, tabMgr.activeTab.label, tabMgr]);

  // Kick the renderer after layout-affecting transitions to prevent stale paints.
  // requestRender() is a no-op if nothing is dirty — safe to call.
  const reasoningExpanded = useUIStore((s) => s.reasoningExpanded);
  const codeExpanded = useUIStore((s) => s.codeExpanded);
  const hasTabBar = tabMgr.tabCount > 1;
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run on layout transitions, not just renderer change
  useEffect(() => {
    renderer.requestRender();
  }, [editorOpen, editorVisible, focusMode, reasoningExpanded, codeExpanded, hasTabBar, renderer]);

  const handleEditorClosed = useCallback(() => {
    setEditorVisible(false);
  }, []);

  useEditorInput({
    ptyWrite,
    isEditorFocused: focusMode === "editor" && nvimReady,
    isEditorVisible: editorVisible,
    onFocusChat: focusChat,
    onFocusEditor: focusEditor,
    hasTabBar: hasTabBarRef.current,
    editorSplit: editorSplitRef.current,
  });

  const { routerSlotPicking, commandPickerConfig, infoPopupConfig, suspended, editorSplit } =
    useUIStore(
      useShallow((s) => ({
        routerSlotPicking: s.routerSlotPicking,
        commandPickerConfig: s.commandPickerConfig,
        infoPopupConfig: s.infoPopupConfig,
        suspended: s.suspended,
        editorSplit: s.editorSplit,
      })),
    );

  const modalLlmSelector = useUIStore((s) => s.modals.llmSelector);
  const modalGitCommit = useUIStore((s) => s.modals.gitCommit);
  const modalGitMenu = useUIStore((s) => s.modals.gitMenu);
  const modalSessionPicker = useUIStore((s) => s.modals.sessionPicker);
  const modalSkillSearch = useUIStore((s) => s.modals.skillSearch);
  const modalLspInstall = useUIStore((s) => s.modals.lspInstall);
  const modalEditorSettings = useUIStore((s) => s.modals.editorSettings);
  const modalProviderSettings = useUIStore((s) => s.modals.providerSettings);
  const modalRouterSettings = useUIStore((s) => s.modals.routerSettings);
  const modalCommandPicker = useUIStore((s) => s.modals.commandPicker);
  const modalCommandPalette = useUIStore((s) => s.modals.commandPalette);
  const modalInfoPopup = useUIStore((s) => s.modals.infoPopup);
  const modalDiagnose = useUIStore((s) => s.modals.diagnosePopup);
  const modalStatusDashboard = useUIStore((s) => s.modals.statusDashboard);
  const modalModelEvents = useUIStore((s) => s.modals.modelEvents);
  const modalToolsPopup = useUIStore((s) => s.modals.toolsPopup);
  const modalMCPSettings = useUIStore((s) => s.modals.mcpSettings);
  const modalHearthSettings = useUIStore((s) => s.modals.hearthSettings);
  const modalFirstRunWizard = useUIStore((s) => s.modals.firstRunWizard);
  const modalUpdateModal = useUIStore((s) => s.modals.updateModal);
  const modalTabNamePopup = useUIStore((s) => s.modals.tabNamePopup);
  const modalMemoryBrowser = useUIStore((s) => s.modals.memoryBrowser);
  const modalUiDemo = useUIStore((s) => s.modals.uiDemo);
  const toolsState = useToolsStore();

  // Init tools store from config and persist changes
  useEffect(() => {
    toolsState.initFromConfig(effectiveConfig.disabledTools);
  }, [effectiveConfig.disabledTools, toolsState.initFromConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    saveGlobalConfig({ disabledTools: [...toolsState.disabledTools] });
  }, [toolsState.disabledTools]);
  const statusDashboardTab = useUIStore((s) => s.statusDashboardTab);
  const modalRepoMapStatus = useUIStore((s) => s.modals.repoMapStatus);
  const isModalOpen = useUIStore(selectIsAnyModalOpen);

  const wizardOpenedLlm = useRef(false);
  const closerCache = useRef<Partial<Record<ModalName, () => void>>>({});
  const getCloser = (name: ModalName) =>
    (closerCache.current[name] ??= () => useUIStore.getState().closeModal(name));

  useVersionCheck();
  const versionCurrent = useVersionStore((s) => s.current);
  const versionLatest = useVersionStore((s) => s.latest);
  const versionUpdateAvailable = useVersionStore((s) => s.updateAvailable);

  // Show update modal on first launch when a new version is available
  const updateModalShown = useRef(false);
  useEffect(() => {
    if (!versionUpdateAvailable || !versionLatest || updateModalShown.current) return;
    if (isDismissed(versionLatest)) return;
    updateModalShown.current = true;
    // Small delay so it doesn't fight with wizard/setup modals
    const timer = setTimeout(() => {
      const ui = useUIStore.getState();
      if (!ui.modals.firstRunWizard && !ui.modals.setup) {
        ui.openModal("updateModal");
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [versionUpdateAvailable, versionLatest]);

  useEffect(() => {
    if (getMissingRequired().length > 0) {
      useUIStore.getState().openModal("setup");
    } else if (forceWizard || (!config.onboardingComplete && !resumeSessionId)) {
      useUIStore.getState().openModal("firstRunWizard");
    }
  }, [config.onboardingComplete, forceWizard, resumeSessionId]);

  const cwd = getCwd();

  const saveToScope = useCallback(
    (patch: Partial<AppConfig>, toScope: ConfigScope, fromScope?: ConfigScope) => {
      if (toScope === "global") {
        saveGlobalConfig(patch);
        setGlobalConfig((prev) => applyConfigPatch(prev, patch));
      } else if (toScope === "project") {
        saveProjectConfig(cwd, patch);
        setProjConfig((prev) => applyConfigPatch(prev ?? {}, patch));
      }

      if (fromScope && fromScope !== toScope) {
        const keys = Object.keys(patch);
        if (fromScope === "global") {
          removeGlobalConfigKeys(keys);
          setGlobalConfig((prev) => stripConfigKeys(prev, keys));
        }
        if (fromScope === "project") {
          removeProjectConfigKeys(cwd, keys);
          setProjConfig((prev) => (prev ? stripConfigKeys(prev, keys) : prev));
        }
      }
    },
    [cwd],
  );

  const detectScope = useCallback(
    (key: string): ConfigScope => {
      if (projConfig && key in projConfig) return "project";
      return "global";
    },
    [projConfig],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time init
  useEffect(() => {
    initForbidden(cwd);
    for (const cfg of PROVIDER_CONFIGS) {
      if (cfg.grouped) fetchGroupedModels(cfg.id).catch(() => {});
      else fetchProviderModels(cfg.id).catch(() => {});
    }
  }, []);

  const contextManager = useMemo(
    () => preloadedContextManager ?? new ContextManager(cwd),
    [cwd, preloadedContextManager],
  );
  const sessionManager = useMemo(() => new SessionManager(cwd), [cwd]);
  sessionManagerRef.current = sessionManager;

  const mcpManager = useMemo(() => getMCPManager(), []);

  // MCP lifecycle: connectAll is idempotent and serialized — safe to call on every config change.
  // It handles connect, disconnect, enable, disable, edit, and removal.
  useEffect(() => {
    mcpManager.connectAll(effectiveConfig.mcpServers ?? []);
  }, [mcpManager, effectiveConfig.mcpServers]);

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      disposeMCPManager();
    };
  }, []);

  const git = useGitStatus(cwd);
  const [forgeMode, setForgeModeHeader] =
    useState<import("../types/index.js").ForgeMode>("default");
  const modeLabel = getModeLabel(forgeMode);
  const modeColor = getModeColor(forgeMode);

  useConfigSync({
    effectiveConfig,
    contextManager,
    cwd,
    editorOpen,
    editorFile,
    nvimMode,
    cursorLine,
    cursorCol,
    visualSelection,
  });

  const handleSuspend = useCallback(
    async (opts: { command: string; args?: string[]; noAltScreen?: boolean }) => {
      useUIStore.getState().setSuspended(true);
      await new Promise((r) => setTimeout(r, 50));
      const result = await suspendAndRun({ ...opts, cwd });
      useUIStore.getState().setSuspended(false);
      if (result.exitCode === null) {
        const activeChat = tabMgrRef.current?.getActiveChat();
        activeChat?.setMessages((prev: ChatMessage[]) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system" as const,
            content: `Failed to launch ${opts.command}. Is it installed?`,
            timestamp: Date.now(),
          },
        ]);
      }
      git.refresh();
    },
    [cwd, git],
  );

  editorSplitRef.current = editorSplit;

  const sharedResources = useMemo(
    () => ({
      ...contextManager.getSharedResources(),
      workspaceCoordinator: getWorkspaceCoordinator(),
    }),
    [contextManager],
  );

  const workspaceSnapshotRef = useRef<(() => WorkspaceSnapshot) | null>(null);
  workspaceSnapshotRef.current = () => ({
    tabStates: tabMgr.getAllTabStates(),
    activeTabId: tabMgr.activeTabId,
  });

  const addSystemMessage = useCallback((msg: string) => {
    const activeChat = tabMgrRef.current?.getActiveChat();
    activeChat?.setMessages((prev: ChatMessage[]) => [
      ...prev,
      { id: crypto.randomUUID(), role: "system" as const, content: msg, timestamp: Date.now() },
    ]);
  }, []);

  const refreshGit = useCallback(() => {
    git.refresh();
  }, [git]);

  const shutdownPhaseRef = useRef(shutdownPhase);
  shutdownPhaseRef.current = shutdownPhase;
  const exitTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const handleCycleTab = useCallback(
    (direction: 1 | -1) => {
      if (tabMgr.tabCount <= 1) return;
      if (direction === 1) tabMgr.nextTab();
      else tabMgr.prevTab();
    },
    [tabMgr.tabCount, tabMgr.nextTab, tabMgr.prevTab],
  );

  const handleExit = useCallback(() => {
    if (shutdownPhaseRef.current >= 0) return;
    setShutdownPhase(0);

    const schedule = (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      exitTimersRef.current.push(t);
      return t;
    };

    schedule(() => {
      for (const tab of tabMgrRef.current.tabs) {
        tabMgrRef.current.getChat(tab.id)?.abort();
      }
      setShutdownPhase(1);

      schedule(async () => {
        try {
          const sid = getAppSessionId();
          const liveTabs = tabMgrRef.current.tabs;
          const activeChat = tabMgrRef.current.getActiveChat();
          const activeTabId = tabMgrRef.current.activeTabId;
          const anyContent = liveTabs.some((t) => {
            const c = tabMgrRef.current.getChat(t.id);
            return c?.messages.some(
              (m: ChatMessage) => m.role === "user" || m.role === "assistant",
            );
          });
          if (anyContent) {
            // Per-tab save: each registered chat writes its own slice via
            // saveTab, which splice-merges into the shared session dir
            // without clobbering siblings. Saves are serialized per-session
            // inside saveTab so the loop is safe.
            const liveIds = new Set(liveTabs.map((t) => t.id));
            const fallbackTitle =
              activeChat?.customTitle ?? SessionManager.deriveTitle(activeChat?.messages ?? []);
            for (const tab of liveTabs) {
              const chat = tabMgrRef.current.getChat(tab.id);
              if (!chat) continue;
              const filtered = chat.messages.filter(
                (m: ChatMessage) => m.role !== "system" || m.showInChat,
              );
              const { tabMeta } = buildTabMeta({
                tabId: tab.id,
                tabLabel: tab.label,
                activeModel: chat.activeModel,
                sessionId: sid,
                planMode: chat.planMode,
                planRequest: chat.planRequest,
                coAuthorCommits: chat.coAuthorCommits,
                forgeMode: chat.forgeMode,
                tokenUsage: chat.tokenUsage,
                messages: filtered,
                coreMessages: chat.coreMessages,
              });
              await sessionManager.saveTab(sid, tabMeta, filtered, chat.coreMessages, {
                title: fallbackTitle,
                customTitle: activeChat?.customTitle ?? null,
                cwd,
                forgeMode: activeChat?.forgeMode ?? "default",
                activeTabId,
              });
            }
            // Prune any on-disk tabs not in the live set (e.g. tabs closed
            // this session). Best-effort — failures are non-fatal.
            try {
              await sessionManager.pruneTabsNotIn(sid, liveIds);
            } catch {}
            setExitSessionId(sid);
            savedSessionIdRef.current = sid;
          }
        } catch (err) {
          logBackgroundError(
            "shutdown",
            `session save failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        setShutdownPhase(2);

        schedule(() => {
          setShutdownPhase(3);
          schedule(() => {
            renderer.destroy();
            try {
              contextManager.dispose();
              getWorkspaceCoordinator().releaseAllGlobal();
            } catch (err) {
              logBackgroundError(
                "shutdown",
                `dispose failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            cleanupAndExit(0);
          }, 1000);
        }, 350);
      }, 300);
    }, 250);
  }, [cwd, sessionManager, contextManager, renderer]);

  const hasRestoredRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time restore on mount
  useEffect(() => {
    if (hasRestoredRef.current || !resumeSessionId) return;
    hasRestoredRef.current = true;

    const fullId = sessionManager.findByPrefix(resumeSessionId);
    if (!fullId) {
      addSystemMessage(`Session not found: ${resumeSessionId}`);
      return;
    }

    const data = sessionManager.loadSession(fullId);
    if (data) {
      // Adopt loaded session id BEFORE restoreFromMeta so freshly mounted
      // TabInstances see the right app session id on first render.
      setAppSessionId(data.meta.id);
      tabMgr.restoreFromMeta(
        data.meta.tabs,
        data.meta.activeTabId,
        data.tabMessages,
        data.tabCoreMessages,
      );
      setForgeModeHeader(data.meta.forgeMode);
      setExitSessionId(data.meta.id);
      // Restore checkpoint git tags from saved session (synchronous — must run
      // before React renders TabInstance, which triggers syncFromMessages)
      for (const tab of data.meta.tabs) {
        if (tab.checkpointTags?.length) {
          useCheckpointStore.getState().restoreTagsFromMeta(tab.id, tab.checkpointTags ?? []);
        }
      }
      // Restore custom title if user renamed this session
      setTimeout(() => {
        if (data.meta.customTitle) {
          tabMgr.getChat(data.meta.activeTabId)?.setCustomTitle(data.meta.customTitle);
        }
        const allMessages = [...data.tabMessages.values()].flat();
        restoreSessionImages(allMessages, cwd)
          .then((restored) => {
            if (restored > 0) {
              // Force React re-render — the objects were mutated in-place
              for (const tab of data.meta.tabs) {
                tabMgr.getChat(tab.id)?.setMessages((prev) => [...prev]);
              }
            }
          })
          .catch(() => {});
      }, 100);
    }
  }, []);

  // ── Hearth bootstrap + auto-claim ────────────────────────────────────────
  // One-shot per process: restore bridge bindings from disk, start the TUI-side
  // SurfaceHost (no-op if another process owns the bridge lock), then pull any
  // daemon-owned workspaces for this cwd. Claimed sessions rehydrate as real
  // TUI tabs via `tabMgr.restoreFromMeta` so history, tool state, and plan
  // review survive the hand-off.
  const hasBootedHearthRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time boot
  useEffect(() => {
    if (hasBootedHearthRef.current) return;
    hasBootedHearthRef.current = true;
    void (async () => {
      try {
        const [
          { hearthBridge },
          { getTuiHost },
          { autoClaimDaemonWorkspaces, bindClaimedSessions },
        ] = await Promise.all([
          import("../hearth/bridge.js"),
          import("../hearth/tui-host.js"),
          import("../hearth/claim.js"),
        ]);
        hearthBridge.restoreFromDisk();
        hearthBridge.setTabListProvider(() =>
          tabMgrRef.current.tabs.map((t) => ({ id: t.id, label: t.label })),
        );
        hearthBridge.setTuiActions({
          createTab: (label?: string) => tabMgrRef.current.createTab(label),
          closeTab: (id: string) => tabMgrRef.current.closeTab(id),
          getTabStatus: (tabId: string) => {
            const chat = tabMgrRef.current.getChat(tabId);
            const tab = tabMgrRef.current.tabs.find((t) => t.id === tabId);
            if (!chat || !tab) return null;
            return {
              tabId,
              label: tab.label,
              activeModel: chat.activeModel,
              forgeMode: chat.forgeMode,
              isLoading: chat.isLoading,
              messageCount: chat.messages.length,
              tokenUsage: {
                input: chat.tokenUsage.prompt,
                output: chat.tokenUsage.completion,
              },
              cwd: cwd,
              queueCount: chat.messageQueue.length,
            };
          },
          setActiveModel: (tabId, model) => {
            const chat = tabMgrRef.current.getChat(tabId);
            if (!chat) return false;
            chat.setActiveModel(model);
            return true;
          },
          setForgeMode: (tabId, mode) => {
            const chat = tabMgrRef.current.getChat(tabId);
            if (!chat) return false;
            const valid = ["default", "architect", "socratic", "challenge", "plan", "auto"];
            if (!valid.includes(mode)) return false;
            chat.setForgeMode(mode as import("../types/index.js").ForgeMode);
            return true;
          },
          clearTab: (tabId) => {
            const chat = tabMgrRef.current.getChat(tabId);
            if (!chat) return false;
            chat.setMessages([]);
            chat.setCoreMessages([]);
            chat.setMessageQueue([]);
            chat.setActivePlan(null);
            chat.setSidebarPlan(null);
            return true;
          },
          getCost: (tabId) => {
            const chat = tabMgrRef.current.getChat(tabId);
            if (!chat) return null;
            return {
              input: chat.tokenUsage.prompt,
              output: chat.tokenUsage.completion,
              cacheRead: chat.tokenUsage.cacheRead,
            };
          },
          getQueue: (tabId) => {
            const chat = tabMgrRef.current.getChat(tabId);
            if (!chat) return [];
            return chat.messageQueue.map((q) => q.content);
          },
          appendQueue: (tabId, text) => {
            const chat = tabMgrRef.current.getChat(tabId);
            if (!chat) return false;
            chat.setMessageQueue((q) => [
              ...q,
              { id: crypto.randomUUID(), content: text, queuedAt: Date.now() },
            ]);
            return true;
          },
          getCwd: (_tabId) => cwd,
          getDiff: (tabId) => {
            try {
              const files = getEditedFilesForTab(tabId);
              if (files.length === 0) return "(no edits in this tab yet)";
              return files.map((f) => `${String(f.edits).padStart(3)} × ${f.path}`).join("\n");
            } catch {
              return "(diff unavailable)";
            }
          },
          getFiles: (_tabId) => "(run /diff for a per-tab edit list)",
          listSessions: (limit = 10) => {
            try {
              const entries = sessionManager.listSessions();
              return entries.slice(0, limit).map((e) => ({
                id: e.id,
                title: e.title,
                updatedAt: e.updatedAt,
              }));
            } catch {
              return [];
            }
          },
          resumeSession: (_idPrefix) => ({
            ok: false,
            error: "resume from remote not yet wired — use TUI /sessions",
          }),
          listCheckpoints: (_tabId) => [],
          undoCheckpoint: (_tabId, _idx) => ({
            ok: false,
            error: "remote undo not yet wired — use TUI Ctrl+Z",
          }),
          listAgents: (_tabId) => [],
          cancelAgent: (_tabId, _id) => false,
          listMcp: () => {
            try {
              const servers = useMCPStore.getState().servers;
              return Object.values(servers).map((s) => ({
                name: s.config.name,
                enabled: !s.config.disabled,
                status: s.status,
              }));
            } catch {
              return [];
            }
          },
          toggleMcp: (_name) => ({
            ok: false,
            error: "remote mcp toggle not yet wired — use TUI /mcp",
          }),
          setNotifyMode: (_tabId, _mode) => false,
          sendToTab: (tabId, text) => {
            const chat = tabMgrRef.current.getChat(tabId);
            if (!chat) return false;
            void chat.handleSubmit(text, undefined, { origin: "telegram" });
            return true;
          },
          findInTab: (tabId, query, limit = 10) => {
            const chat = tabMgrRef.current.getChat(tabId);
            if (!chat) return [];
            const q = query.toLowerCase();
            const hits: Array<{ msgId: string; snippet: string }> = [];
            for (const m of chat.messages) {
              const content = typeof m.content === "string" ? m.content : "";
              const idx = content.toLowerCase().indexOf(q);
              if (idx < 0) continue;
              const start = Math.max(0, idx - 30);
              const end = Math.min(content.length, idx + query.length + 60);
              hits.push({
                msgId: m.id,
                snippet: `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`,
              });
              if (hits.length >= limit) break;
            }
            return hits;
          },
          branchTab: (_tabId, _label) => ({
            ok: false,
            error: "branch from remote not yet wired",
          }),
        });
        try {
          await getTuiHost().start();
        } catch {}
        process.once("exit", () => {
          void import("../hearth/tui-host.js").then(({ getTuiHost: g2 }) => {
            void g2().stop();
          });
        });

        // Skip auto-claim when we're already mid-resume from the CLI's
        // --resume flag — that path already restored a full session and the
        // user intent is "load that specific session", not "pick up whatever
        // the daemon was running".
        if (resumeSessionId) return;

        const result = await autoClaimDaemonWorkspaces(cwd);
        if (result.sessions.length === 0) return;

        // Merge all claimed sessions into a single multi-tab restore. Pick the
        // first session's activeTabId as the active; union all tab metas and
        // messages. Daemon-side session ids don't collide (uuidv4).
        const allTabMetas = result.sessions.flatMap((s) => s.meta.tabs);
        const combinedMessages = new Map<string, ChatMessage[]>();
        const combinedCore = new Map<string, import("ai").ModelMessage[]>();
        let hasCore = false;
        for (const s of result.sessions) {
          for (const [tid, msgs] of s.tabMessages) combinedMessages.set(tid, msgs);
          if (s.tabCoreMessages) {
            hasCore = true;
            for (const [tid, cm] of s.tabCoreMessages) combinedCore.set(tid, cm);
          }
        }
        const activeId = result.sessions[0]?.meta.activeTabId ?? allTabMetas[0]?.id ?? "";
        if (allTabMetas.length > 0 && activeId) {
          tabMgrRef.current.restoreFromMeta(
            allTabMetas,
            activeId,
            combinedMessages,
            hasCore ? combinedCore : undefined,
          );
        }
        // Bind surfaces → tabs now that tabs exist.
        bindClaimedSessions(result.sessions);
      } catch {
        // Hearth unavailable / socket missing — silent.
      }
    })();
  }, []);

  const [activeModelForHeader, setActiveModelForHeader] = useState(effectiveConfig.defaultModel);
  const activeChatRef = useRef<ChatInstance | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: derived from activeTabId — stable trigger
  useEffect(() => {
    const chat = tabMgr.getActiveChat();
    activeChatRef.current = chat;
    if (chat) {
      setActiveModelForHeader(chat.activeModel);
      setForgeModeHeader(chat.forgeMode);
      const hasContent = chat.messages.some(
        (m: ChatMessage) => m.role === "user" || m.role === "assistant",
      );
      // Use the app-level session id — every tab persists into the same dir
      // so the exit banner always points at the right session regardless of
      // which tab is active.
      setExitSessionId(hasContent ? getAppSessionId() : null);
    }
  }, [tabMgr.activeTabId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow trigger — only re-run on tab count/active changes
  useEffect(() => {
    if (tabMgr.tabCount <= 1) return;
    (async () => {
      try {
        const { mkdir, writeFile } = await import("node:fs/promises");
        const dir = join(cwd, ".soulforge");
        await mkdir(dir, { recursive: true });
        const activeChat = tabMgr.getActiveChat();
        const layout = tabMgr.tabs.map((t) => ({
          id: t.id,
          label: t.label,
          activeModel: t.id === tabMgr.activeTabId ? activeChat?.activeModel : undefined,
        }));
        await writeFile(join(dir, "tabs.json"), JSON.stringify(layout, null, 2));
      } catch {}
    })();
  }, [tabMgr.tabCount, tabMgr.activeTabId]);

  const { displayProvider, displayModel, isGateway, isProxy } = useMemo(() => {
    const model = activeModelForHeader;
    if (model === "none") {
      return {
        displayProvider: "none",
        displayModel: "Ctrl+L to select",
        isGateway: false,
        isProxy: false,
      };
    }
    const isGw = model.startsWith("vercel_gateway/");
    const isPrx = model.startsWith("proxy/");
    if (isGw || isPrx) {
      const prefix = isGw ? "vercel_gateway/" : "proxy/";
      const rest = model.slice(prefix.length);
      const idx = rest.indexOf("/");
      return {
        displayProvider: idx >= 0 ? rest.slice(0, idx) : rest,
        displayModel: idx >= 0 ? rest.slice(idx + 1) : rest,
        isGateway: isGw,
        isProxy: isPrx,
      };
    }
    const idx = model.indexOf("/");
    return {
      displayProvider: idx >= 0 ? model.slice(0, idx) : "unknown",
      displayModel: idx >= 0 ? model.slice(idx + 1) : model,
      isGateway: false,
      isProxy: false,
    };
  }, [activeModelForHeader]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow trigger — only re-run when nvimError changes
  useEffect(() => {
    // Skip the "neovim-not-found" sentinel — Neovim is an opt-in addon,
    // not a hard requirement. Surfacing it as a red banner on boot scares
    // users who never asked for the editor. The EditorPanel still shows
    // its own install hint splash if they open the panel.
    if (nvimError && nvimError !== "neovim-not-found") {
      addSystemMessage(`Neovim error: ${nvimError}`);
    }
  }, [nvimError]);

  // Surface a one-time notice when a legacy memory DB was rotated aside on
  // first open (Phase 1 schema migration). Skipped after the first tick so
  // re-mounts inside the same process don't re-toast.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only
  useEffect(() => {
    const memMgr = contextManager.getMemoryManager();
    const { project, global } = memMgr.getLegacyBackupPaths();
    const parts: string[] = [];
    if (project) parts.push(`project: ${project}`);
    if (global) parts.push(`global: ${global}`);
    if (parts.length > 0) {
      addSystemMessage(
        `Legacy memory schema detected — your old DB was preserved at ${parts.join(
          ", ",
        )}. Phase 1 schema is now active in .soulforge/memory.db.`,
      );
    }
  }, []);

  const handleNewSession = useCallback(async () => {
    const activeChat = tabMgrRef.current?.getActiveChat();
    const hasContent = activeChat?.messages.some(
      (m: ChatMessage) => m.role === "user" || m.role === "assistant",
    );
    if (hasContent && activeChat) {
      try {
        const sid = getAppSessionId();
        const liveTabs = tabMgrRef.current?.tabs ?? [];
        const activeTabId = tabMgrRef.current?.activeTabId ?? "";
        const liveIds = new Set(liveTabs.map((t) => t.id));
        const fallbackTitle =
          activeChat.customTitle ?? SessionManager.deriveTitle(activeChat.messages);
        for (const tab of liveTabs) {
          const chat = tabMgrRef.current?.getChat(tab.id);
          if (!chat) continue;
          const filtered = chat.messages.filter(
            (m: ChatMessage) => m.role !== "system" || m.showInChat,
          );
          const { tabMeta } = buildTabMeta({
            tabId: tab.id,
            tabLabel: tab.label,
            activeModel: chat.activeModel,
            sessionId: sid,
            planMode: chat.planMode,
            planRequest: chat.planRequest,
            coAuthorCommits: chat.coAuthorCommits,
            forgeMode: chat.forgeMode,
            tokenUsage: chat.tokenUsage,
            messages: filtered,
            coreMessages: chat.coreMessages,
          });
          await sessionManager.saveTab(sid, tabMeta, filtered, chat.coreMessages, {
            title: fallbackTitle,
            customTitle: activeChat.customTitle ?? null,
            cwd,
            forgeMode: activeChat.forgeMode,
            activeTabId,
          });
        }
        try {
          await sessionManager.pruneTabsNotIn(sid, liveIds);
        } catch {}
      } catch (err) {
        logBackgroundError(
          "new-session",
          `session save failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Mark all tabs for skip-cleanup so git tags survive the restart
    const cpStore = useCheckpointStore.getState();
    const allTabs = tabMgrRef.current?.tabs ?? [];
    for (const tab of allTabs) cpStore.skipCleanup(tab.id);
    restart();
  }, [cwd, sessionManager]);

  const handleTabCommand = useCallback(
    (input: string, chat: ChatInstance) => {
      const cmd = input.trim().toLowerCase().split(/\s+/)[0] ?? "";
      const twoWord = input.trim().toLowerCase().split(/\s+/).slice(0, 2).join(" ");
      if (chat.isLoading && (ABORT_ON_LOADING.has(cmd) || ABORT_ON_LOADING.has(twoWord))) {
        chat.abort();
        chat.setMessageQueue([]);
      }

      if (cmd === "/continue" || twoWord === "/session continue") {
        chat.handleSubmit("Continue from where you left off. Complete any remaining work.");
        return;
      }
      if (
        cmd === "/plan" ||
        input.trim().toLowerCase().startsWith("/plan ") ||
        twoWord === "/session plan" ||
        input.trim().toLowerCase().startsWith("/session plan ")
      ) {
        const desc = input
          .trim()
          .replace(/^\/(session\s+)?plan\s*/i, "")
          .trim();
        if (chat.planMode) {
          chat.setPlanMode(false);
          chat.setPlanRequest(null);
          chat.setForgeMode("default");
          setForgeModeHeader("default");
          chat.setPendingPlanReview(null);
          chat.setMessages((prev: ChatMessage[]) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system" as const,
              content: "Plan mode OFF",
              timestamp: Date.now(),
            },
          ]);
        } else {
          chat.setPlanMode(true);
          chat.setPlanRequest(desc || null);
          chat.setForgeMode("plan");
          setForgeModeHeader("plan");
          chat.setMessages((prev: ChatMessage[]) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system" as const,
              content: "Plan mode ON — Forge will research and plan without making changes.",
              timestamp: Date.now(),
            },
          ]);
          if (desc) {
            setTimeout(() => chat.handleSubmit(desc), 0);
          }
        }
        return;
      }
      const uiState = useUIStore.getState();
      handleCommand(input, {
        chat,
        tabMgr,
        toggleFocus: toggleEditor,
        nvimOpen,
        exit: handleExit,
        openSkills: () => uiState.openModal("skillSearch"),
        openLspInstall: () => uiState.openModal("lspInstall"),
        openGitCommit: () => uiState.openModal("gitCommit"),
        openSessions: () => uiState.openModal("sessionPicker"),
        newSession: () => handleNewSession(),
        openHelp: () => uiState.openModal("helpPopup"),
        openErrorLog: () => uiState.openModal("errorLog"),
        cwd,
        refreshGit: () => {
          git.refresh();
        },
        setForgeMode: (mode: import("../types/index.js").ForgeMode) => {
          chat.setForgeMode(mode);
          setForgeModeHeader(mode);
        },
        currentMode: chat.forgeMode,
        currentModeLabel: getModeLabel(chat.forgeMode),
        contextManager,
        chatStyle: uiState.chatStyle,
        setChatStyle: uiState.setChatStyle,
        handleSuspend,
        openGitMenu: () => uiState.openModal("gitMenu"),
        openEditorWithFile,
        effectiveNvimConfig: effectiveConfig.nvimConfig,
        vimHints: effectiveConfig.vimHints !== false,
        verbose: effectiveConfig.verbose === true,
        diffStyle: effectiveConfig.diffStyle ?? "default",
        collapseDiffs: effectiveConfig.collapseDiffs === true,
        compactionStrategy: effectiveConfig.compaction?.strategy ?? "v2",
        showReasoning: uiState.showReasoning,
        setShowReasoning: uiState.setShowReasoning,
        tabVerbose: uiState.verboseByTab[tabMgr.activeTabId] ?? false,
        setTabVerbose: (v) => uiState.setTabVerbose(tabMgr.activeTabId, v),
        watchdog: effectiveConfig.watchdog === true,
        openSetup: () => uiState.openModal("setup"),
        openEditorSettings: () => uiState.openModal("editorSettings"),
        openRouterSettings: () => {
          setRouterScope(detectScope("taskRouter"));
          uiState.openModal("routerSettings");
        },
        openProviderSettings: () => uiState.openModal("providerSettings"),
        openWebSearchSettings: () => uiState.openModal("webSearchSettings"),
        openApiKeySettings: () => uiState.openModal("apiKeySettings"),
        openLspStatus: () => uiState.openModal("lspStatus"),
        openHearthSettings: () => uiState.openModal("hearthSettings"),
        openCompactionLog: () => uiState.openModal("compactionLog"),
        openCommandPicker: (pickerConfig) => uiState.openCommandPicker(pickerConfig),
        openInfoPopup: (popupConfig) => uiState.openInfoPopup(popupConfig),
        openMemoryBrowser: () => uiState.openModal("memoryBrowser"),
        toggleChanges: () => uiState.toggleChangesExpanded(),
        saveToScope,
        detectScope,
        agentFeatures: effectiveConfig.agentFeatures,
        instructionFiles: effectiveConfig.instructionFiles,
        syncActiveModel: (modelId: string) => {
          chat.setActiveModel(modelId);
          setActiveModelForHeader(modelId);
        },
      });
    },
    [
      tabMgr,
      toggleEditor,
      nvimOpen,
      handleExit,
      cwd,
      git,
      contextManager,
      handleSuspend,
      openEditorWithFile,
      effectiveConfig.nvimConfig,
      effectiveConfig.vimHints,
      effectiveConfig.verbose,
      effectiveConfig.diffStyle,
      effectiveConfig.collapseDiffs,
      effectiveConfig.compaction?.strategy,
      saveToScope,
      detectScope,
      effectiveConfig.agentFeatures,
      effectiveConfig.instructionFiles,
      handleNewSession,
      effectiveConfig.watchdog,
    ],
  );

  const closeLlmSelector = useCallback(() => {
    const wasPickingSlot = useUIStore.getState().routerSlotPicking != null;
    const wasFallbackForModel = useUIStore.getState().fallbackForModel != null;
    const wasFromWizard = wizardOpenedLlm.current;
    useUIStore.getState().closeModal("llmSelector");
    useUIStore.getState().setRouterSlotPicking(null);
    useUIStore.getState().setFallbackForModel(null);
    wizardOpenedLlm.current = false;
    if (wasPickingSlot || wasFallbackForModel) {
      useUIStore.getState().openModal("routerSettings");
    } else if (wasFromWizard) {
      useUIStore.getState().openModal("firstRunWizard");
    }
  }, []);

  const closeInfoPopup = useCallback(() => {
    const cfg = useUIStore.getState().infoPopupConfig;
    useUIStore.getState().closeInfoPopup();
    cfg?.onClose?.();
  }, []);

  const onGitMenuCommit = useCallback(() => {
    useUIStore.getState().closeModal("gitMenu");
    useUIStore.getState().openModal("gitCommit");
  }, []);

  useGlobalKeyboard({
    shutdownPhase,
    handleExit,
    newSession: handleNewSession,
    toggleEditor,
    focusMode,
    renderer,
    copyToClipboard,
    activeChatRef,
    cycleMode: useCallback(() => {
      const chat = tabMgrRef.current?.getActiveChat();
      if (chat) {
        const next = chat.cycleMode();
        setForgeModeHeader(next);
      }
    }, []),
    tabMgr,
  });

  if (suspended) {
    return <box height={termHeight} />;
  }

  if (shutdownPhase >= 0) {
    return (
      <ShutdownSplash
        phase={shutdownPhase}
        sessionId={savedSessionIdRef.current}
        height={termHeight}
      />
    );
  }

  const anyModalOpen = shutdownPhase >= 0 || isModalOpen;

  return (
    <box flexDirection="column" height={termHeight} backgroundColor={t.bgApp}>
      <box
        flexShrink={0}
        width="100%"
        paddingX={1}
        justifyContent="space-between"
        height={1}
        flexDirection="row"
      >
        <box flexShrink={0} flexDirection="row" gap={0}>
          <text fg={t.brand} attributes={TextAttributes.BOLD}>
            {icon("ghost")} SoulForge
          </text>
          <text fg={t.textFaint}> v{versionCurrent}</text>
          {versionUpdateAvailable && <text fg={t.success}> ({versionLatest} available)</text>}
        </box>
        <box gap={1} flexShrink={1} flexDirection="row" justifyContent="center" overflow="hidden">
          <text truncate>
            {isProxy && (
              <span fg={t.brandAlt}>
                {icon("proxy")} proxy<span fg={t.textDim}>›</span>
              </span>
            )}
            {isGateway && (
              <span fg={t.textMuted}>
                {icon("vercel_gateway")} gateway<span fg={t.textDim}>›</span>
              </span>
            )}
            <span fg={t.textMuted}>{providerIcon(displayProvider)} </span>
            {displayProvider !== displayModel && (
              <>
                <span fg={t.textMuted}>{displayProvider}</span>
                <span fg={t.textDim}>›</span>
              </>
            )}
            <span fg={t.textSecondary}>
              {truncate(displayModel, isProxy || isGateway ? 20 : 28)}
            </span>
          </text>
          {git.isRepo && (
            <>
              <text fg={t.textFaint}>│</text>
              <text fg={git.isDirty ? t.amber : t.success} truncate>
                {UI_ICONS.git} {truncate(git.branch ?? "HEAD", termWidth >= 120 ? 30 : 15)}
                {git.isDirty ? "*" : ""}
              </text>
            </>
          )}
          {tabMgr.tabCount <= 1 && forgeMode !== "default" && (
            <>
              <text fg={t.textFaint}>│</text>
              <text fg={modeColor} attributes={TextAttributes.BOLD}>
                [{modeLabel}]
              </text>
            </>
          )}
          <text fg={t.textFaint}>│</text>
          <ContextBar
            contextManager={contextManager}
            modelId={activeModelForHeader}
            suppressCompacting={tabMgr.tabCount > 1}
          />
          <text fg={t.textFaint}>│</text>
          <TokenDisplay />
        </box>
        {termWidth >= 80 && <BrandTag />}
      </box>

      {tabMgr.tabCount > 1 ? (
        <box key="tab-bar" flexShrink={0} marginTop={1} flexDirection="row" flexWrap="wrap">
          <TabBar
            tabs={tabMgr.tabs}
            activeTabId={tabMgr.activeTabId}
            onSwitch={tabMgr.switchTab}
            getActivity={tabMgr.getTabActivity}
            getMode={(id) =>
              id === tabMgr.activeTabId ? forgeMode : (tabMgr.getChat(id)?.forgeMode ?? "default")
            }
            getModelLabel={(id) => {
              const model =
                id === tabMgr.activeTabId
                  ? activeModelForHeader
                  : (tabMgr.getChat(id)?.activeModel ?? null);
              if (!model || model === "none" || model === effectiveConfig.defaultModel) return null;
              return getShortModelLabel(model);
            }}
          />
          <CheckpointLegend tabId={tabMgr.activeTabId} />
        </box>
      ) : !editorVisible ? (
        <CheckpointLegend tabId={tabMgr.activeTabId} fallbackSpacer />
      ) : (
        <CheckpointLegend tabId={tabMgr.activeTabId} />
      )}

      <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
        <EditorPanel
          isOpen={editorOpen}
          ptyOnData={ptyOnData}
          nvimCols={nvimCols}
          nvimRows={nvimRows}
          focused={focusMode === "editor"}
          onClosed={handleEditorClosed}
          error={nvimError}
          split={editorSplit}
        />

        {tabMgr.tabs.map((tab) => (
          <TabInstance
            key={tab.id}
            tabId={tab.id}
            tabLabel={tab.label}
            visible={tab.id === tabMgr.activeTabId}
            effectiveConfig={effectiveConfig}
            sharedResources={sharedResources}
            sessionManager={sessionManager}
            cwd={cwd}
            openEditorWithFile={openEditorWithFile}
            openEditor={openEditor}
            onSuspend={handleSuspend}
            onCommand={handleTabCommand}
            onModeChange={setForgeModeHeader}
            onModelChange={(modelId) => {
              setActiveModelForHeader(modelId);
            }}
            onExit={handleExit}
            registerChat={tabMgr.registerChat}
            unregisterChat={tabMgr.unregisterChat}
            setTabActivity={tabMgr.setTabActivity}
            initialState={tabMgr.initialStates.current.get(tab.id)}
            editorVisible={editorVisible}
            focusMode={focusMode}
            anyModalOpen={anyModalOpen}
            bootProviders={providerStatuses}
            bootPrereqs={bootPrereqs}
            editorIntegration={effectiveConfig.editorIntegration}
            editorOpen={editorOpen}
            editorFile={editorFile}
            editorModeName={nvimMode}
            editorCursorLine={cursorLine}
            editorCursorCol={cursorCol}
            editorVisualSelection={visualSelection}
            clearEditorSelection={clearNvimSelection}
            onCycleTab={handleCycleTab}
          />
        ))}
      </box>

      <box flexShrink={0} width="100%">
        <Footer />
      </box>

      <LlmSelector
        visible={modalLlmSelector}
        activeModel={(() => {
          const slot = routerSlotPicking;
          const fb = useUIStore.getState().fallbackForModel;
          if (slot) {
            const v = effectiveConfig.taskRouter?.[slot];
            if (typeof v === "string" && v.trim()) return v;
          }
          if (fb) return fb;
          return activeModelForHeader;
        })()}
        onSelect={(modelId) => {
          const slot = useUIStore.getState().routerSlotPicking;
          const fallbackForModel = useUIStore.getState().fallbackForModel;
          if (fallbackForModel) {
            const current = { ...(effectiveConfig.modelFallback ?? {}) };
            const fallbacks = [...(current[fallbackForModel] ?? [])];
            fallbacks.push(modelId);
            current[fallbackForModel] = fallbacks;
            saveToScope({ modelFallback: current }, modelScope);
            closeLlmSelector();
            return;
          }
          if (slot) {
            const current = effectiveConfig.taskRouter ?? DEFAULT_TASK_ROUTER;
            const updated = { ...current, [slot]: modelId };
            saveToScope({ taskRouter: updated }, routerScope);
            closeLlmSelector();
          } else {
            activeChatRef.current?.setActiveModel(modelId);
            notifyProviderSwitch(modelId);
            setActiveModelForHeader(modelId);
            saveToScope({ defaultModel: modelId }, modelScope);
            closeLlmSelector();
          }
        }}
        onClose={closeLlmSelector}
      />

      <FloatingTerminal />

      <GitCommitModal
        visible={modalGitCommit}
        cwd={cwd}
        coAuthor={activeChatRef.current?.coAuthorCommits ?? true}
        onClose={getCloser("gitCommit")}
        onCommitted={(msg) => addSystemMessage(`Committed: ${msg}`)}
        onRefresh={refreshGit}
      />

      <GitMenu
        visible={modalGitMenu}
        cwd={cwd}
        onClose={getCloser("gitMenu")}
        onCommit={onGitMenuCommit}
        onSuspend={handleSuspend}
        onSystemMessage={addSystemMessage}
        onRefresh={refreshGit}
      />

      <SessionPicker
        visible={modalSessionPicker}
        cwd={cwd}
        onClose={getCloser("sessionPicker")}
        onRestore={async (sessionId) => {
          // 1. Snapshot the current session before swapping so we don't lose
          //    the user's in-progress work. Use per-tab saveTab so each tab's
          //    latest messages land in the right dir.
          try {
            const prevSid = getAppSessionId();
            if (prevSid !== sessionId) {
              const liveTabs = tabMgrRef.current?.tabs ?? [];
              const activeTabId = tabMgrRef.current?.activeTabId ?? "";
              const activeChat = tabMgrRef.current?.getActiveChat();
              const fallbackTitle =
                activeChat?.customTitle ?? SessionManager.deriveTitle(activeChat?.messages ?? []);
              const liveIds = new Set(liveTabs.map((t) => t.id));
              let savedAny = false;
              for (const tab of liveTabs) {
                const chat = tabMgrRef.current?.getChat(tab.id);
                if (!chat) continue;
                const filtered = chat.messages.filter(
                  (m: ChatMessage) => m.role !== "system" || m.showInChat,
                );
                const hasContent = filtered.some(
                  (m) => m.role === "user" || m.role === "assistant",
                );
                if (!hasContent) continue;
                savedAny = true;
                const { tabMeta } = buildTabMeta({
                  tabId: tab.id,
                  tabLabel: tab.label,
                  activeModel: chat.activeModel,
                  sessionId: prevSid,
                  planMode: chat.planMode,
                  planRequest: chat.planRequest,
                  coAuthorCommits: chat.coAuthorCommits,
                  forgeMode: chat.forgeMode,
                  tokenUsage: chat.tokenUsage,
                  messages: filtered,
                  coreMessages: chat.coreMessages,
                });
                await sessionManager.saveTab(prevSid, tabMeta, filtered, chat.coreMessages, {
                  title: fallbackTitle,
                  customTitle: activeChat?.customTitle ?? null,
                  cwd,
                  forgeMode: activeChat?.forgeMode ?? "default",
                  activeTabId,
                });
              }
              if (savedAny) {
                try {
                  await sessionManager.pruneTabsNotIn(prevSid, liveIds);
                } catch {}
              }
            }
          } catch (err) {
            logBackgroundError(
              "session-switch",
              `pre-switch save failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          const data = sessionManager.loadSession(sessionId);
          if (data) {
            // 2. Adopt the loaded session id BEFORE restoreFromMeta so freshly
            //    mounted TabInstances see the right app session id on first
            //    render. Avoids the multi-tab loop where each tab tries to
            //    claim its own initialState.sessionId during mount.
            setAppSessionId(data.meta.id);
            tabMgr.restoreFromMeta(
              data.meta.tabs,
              data.meta.activeTabId,
              data.tabMessages,
              data.tabCoreMessages,
            );
            setForgeModeHeader(data.meta.forgeMode);
            setExitSessionId(data.meta.id);
            // Restore checkpoint git tags from saved session (stashed as _pendingTags
            // so syncFromMessages picks them up when it rebuilds checkpoints)
            for (const tab of data.meta.tabs) {
              if (tab.checkpointTags?.length) {
                useCheckpointStore.getState().restoreTagsFromMeta(tab.id, tab.checkpointTags ?? []);
              }
            }
            // Restore custom title if user renamed this session
            if (data.meta.customTitle) {
              setTimeout(() => {
                tabMgr
                  .getChat(data.meta.activeTabId)
                  ?.setCustomTitle(data.meta.customTitle ?? null);
              }, 0);
            }
            // Defer image restore so chat UI renders first
            setTimeout(() => {
              const allMessages = [...data.tabMessages.values()].flat();
              restoreSessionImages(allMessages, cwd)
                .then((restored) => {
                  if (restored > 0) {
                    for (const tab of data.meta.tabs) {
                      tabMgr.getChat(tab.id)?.setMessages((prev) => [...prev]);
                    }
                  }
                })
                .catch(() => {});
            }, 100);
          }
        }}
        onSystemMessage={addSystemMessage}
      />

      <SkillSearch
        visible={modalSkillSearch}
        contextManager={tabMgr.getActiveChat()?.contextManager ?? contextManager}
        onClose={getCloser("skillSearch")}
        onSystemMessage={addSystemMessage}
      />

      <MemoryBrowser
        visible={modalMemoryBrowser}
        contextManager={tabMgr.getActiveChat()?.contextManager ?? contextManager}
        cwd={cwd}
        onClose={getCloser("memoryBrowser")}
        onSystemMessage={addSystemMessage}
      />

      <LspInstallSearch
        visible={modalLspInstall}
        cwd={cwd}
        onClose={getCloser("lspInstall")}
        onSystemMessage={addSystemMessage}
        saveToScope={saveToScope}
        detectScope={detectScope}
        disabledServers={effectiveConfig.disabledLspServers ?? []}
      />

      <EditorSettings
        visible={modalEditorSettings}
        settings={effectiveConfig.editorIntegration}
        initialScope={detectScope("editorIntegration")}
        onUpdate={(settings: EditorIntegration, toScope, fromScope) => {
          saveToScope({ editorIntegration: settings }, toScope, fromScope);
        }}
        onClose={getCloser("editorSettings")}
      />

      <ProviderSettings
        visible={modalProviderSettings}
        globalConfig={globalConfig}
        projectConfig={projConfig}
        onUpdate={(patch, toScope, fromScope) => saveToScope(patch, toScope, fromScope)}
        onClose={getCloser("providerSettings")}
      />

      <ToolsPopup
        visible={modalToolsPopup}
        disabledTools={toolsState.disabledTools}
        onToggleTool={toolsState.toggleTool}
        onClose={getCloser("toolsPopup")}
      />

      <MCPSettings
        visible={modalMCPSettings}
        mcpManager={mcpManager}
        globalServers={globalConfig.mcpServers ?? []}
        projectServers={projConfig?.mcpServers ?? []}
        onSave={(servers, scope) => saveToScope({ mcpServers: servers }, scope)}
        onClose={getCloser("mcpSettings")}
      />

      <HearthSettings visible={modalHearthSettings} onClose={getCloser("hearthSettings")} />

      <UiDemo visible={modalUiDemo} onClose={getCloser("uiDemo")} />

      <RouterSettings
        visible={modalRouterSettings && !routerSlotPicking}
        router={effectiveConfig.taskRouter}
        defaultModel={effectiveConfig.defaultModel}
        modelFallback={effectiveConfig.modelFallback}
        activeModel={activeModelForHeader}
        scope={routerScope}
        onScopeChange={(toScope, fromScope) => {
          setRouterScope(toScope);
          if (effectiveConfig.taskRouter) {
            saveToScope({ taskRouter: effectiveConfig.taskRouter }, toScope, fromScope);
          }
        }}
        onPickSlot={(slot) => {
          useUIStore.getState().setRouterSlotPicking(slot);
          useUIStore.getState().openModal("llmSelector");
        }}
        onClearSlot={(slot) => {
          const current = effectiveConfig.taskRouter ?? DEFAULT_TASK_ROUTER;
          const updated = { ...current, [slot]: null };
          saveToScope({ taskRouter: updated }, routerScope);
        }}
        onPickerChange={(key, value) => {
          const current = effectiveConfig.taskRouter ?? DEFAULT_TASK_ROUTER;
          const updated = { ...current, [key]: value };
          saveToScope({ taskRouter: updated }, routerScope);
        }}
        onAddFallback={(modelId) => {
          useUIStore.getState().setFallbackForModel(modelId);
          useUIStore.getState().openModal("llmSelector");
        }}
        onClearFallbacks={(modelId) => {
          const current = { ...(effectiveConfig.modelFallback ?? {}) };
          delete current[modelId];
          saveToScope({ modelFallback: current }, modelScope);
        }}
        onClose={getCloser("routerSettings")}
      />

      <CommandPalette
        visible={modalCommandPalette}
        onClose={getCloser("commandPalette")}
        onExecute={(cmd) => {
          const chat = activeChatRef.current;
          if (chat) handleTabCommand(cmd, chat);
        }}
      />

      <CommandPicker
        visible={modalCommandPicker}
        config={commandPickerConfig}
        onClose={getCloser("commandPicker")}
      />

      <InfoPopup visible={modalInfoPopup} config={infoPopupConfig} onClose={closeInfoPopup} />

      <StatusDashboard
        visible={modalStatusDashboard}
        initialTab={statusDashboardTab}
        onClose={getCloser("statusDashboard")}
        activeModel={activeModelForHeader}
        contextManager={contextManager}
        tabMgr={tabMgr}
        currentMode={activeChatRef.current?.forgeMode ?? "default"}
        currentModeLabel={getModeLabel(activeChatRef.current?.forgeMode ?? "default")}
      />

      <DiagnosePopup
        visible={modalDiagnose}
        onClose={getCloser("diagnosePopup")}
        runHealthCheck={runIntelligenceHealthCheck}
      />

      <ModelEventsPopup visible={modalModelEvents} onClose={getCloser("modelEvents")} />

      <RepoMapStatusPopup
        visible={modalRepoMapStatus}
        onClose={getCloser("repoMapStatus")}
        enabled={effectiveConfig.repoMap !== false}
        currentMode={
          effectiveConfig.semanticSummaries === true
            ? "synthetic"
            : effectiveConfig.semanticSummaries === false
              ? "off"
              : effectiveConfig.semanticSummaries === "on"
                ? "full"
                : (effectiveConfig.semanticSummaries ?? "synthetic")
        }
        currentLimit={effectiveConfig.semanticSummaryLimit ?? 500}
        currentAutoRegen={effectiveConfig.semanticAutoRegen ?? false}
        currentTokenBudget={effectiveConfig.repoMapTokenBudget}
        currentScope={detectScope("semanticSummaries")}
        onToggle={(enabled, scope) => {
          contextManager.setRepoMapEnabled(enabled);
          saveToScope({ repoMap: enabled }, scope);
        }}
        onRefresh={() => contextManager.refreshRepoMap().catch(() => {})}
        onClear={(scope) => {
          if (contextManager.isSemanticEnabled()) {
            contextManager.setSemanticSummaries("off");
            saveToScope({ semanticSummaries: "off" }, scope);
          }
          contextManager.clearRepoMap();
        }}
        onRegenerate={() => {
          contextManager.setActiveModel(activeModelForHeader);
          contextManager.clearFreeSummaries();
          const mode = contextManager.getSemanticMode();
          contextManager
            .setSemanticSummaries(mode === "off" ? "synthetic" : mode)
            .then(() =>
              contextManager.generateSemanticSummaries(
                contextManager.getSemanticModelId(activeModelForHeader),
              ),
            )
            .catch(() => {});
        }}
        onClearSummaries={() => {
          contextManager.clearFreeSummaries();
        }}
        onLspEnrich={() => {
          contextManager.enrichWithLsp().catch(() => {});
        }}
        onApply={(mode, limit, autoRegen, scope, tokenBudget) => {
          const typedMode = mode as "off" | "ast" | "synthetic" | "llm" | "full";
          contextManager.setActiveModel(activeModelForHeader);
          saveToScope(
            {
              semanticSummaries: typedMode,
              semanticSummaryLimit: limit,
              semanticAutoRegen: autoRegen,
              repoMapTokenBudget: tokenBudget,
            },
            scope,
          );
          contextManager.setSemanticSummaryLimit(limit);
          contextManager.setSemanticAutoRegen(autoRegen);
          contextManager.setRepoMapTokenBudget(tokenBudget);
          contextManager
            .setSemanticSummaries(typedMode)
            .then(() =>
              typedMode === "llm" || typedMode === "full"
                ? contextManager.generateSemanticSummaries(
                    contextManager.getSemanticModelId(activeModelForHeader),
                  )
                : undefined,
            )
            .catch(() => {});
        }}
      />

      <FirstRunWizard
        visible={modalFirstRunWizard}
        hasModel={activeModelForHeader !== "none"}
        activeModel={activeModelForHeader}
        onSelectModel={(modelId?: string) => {
          if (modelId) {
            notifyProviderSwitch(modelId);
            setActiveModelForHeader(modelId);
            saveToScope({ defaultModel: modelId }, modelScope);
          } else {
            wizardOpenedLlm.current = true;
            useUIStore.getState().closeModal("firstRunWizard");
            useUIStore.getState().openModal("llmSelector");
          }
        }}
        onClose={() => {
          useUIStore.getState().closeModal("firstRunWizard");
          saveToScope({ onboardingComplete: true }, "global");
        }}
      />

      <UpdateModal visible={modalUpdateModal} onClose={getCloser("updateModal")} />

      <TabNamePopup
        visible={modalTabNamePopup}
        placeholder={`TAB-${String(tabMgr.tabCount + 1)}`}
        onSubmit={(name) => {
          useUIStore.getState().closeModal("tabNamePopup");
          tabMgr.createTab(name || undefined);
        }}
        onClose={getCloser("tabNamePopup")}
      />

      <SimpleModalLayer
        messages={activeChatRef.current?.messages ?? []}
        onSystemMessage={addSystemMessage}
      />

      <DialogHost />
    </box>
  );
}
