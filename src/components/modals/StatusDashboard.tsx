import type { ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContextManager } from "../../core/context/manager.js";
import { getNvimInstance } from "../../core/editor/instance.js";
import { icon } from "../../core/icons.js";
import { getIntelligenceStatus } from "../../core/intelligence/index.js";
import { getModelContextInfoSync, getShortModelLabel } from "../../core/llm/models.js";
import { isAnthropicNative } from "../../core/llm/provider-options.js";
import { getProxyPid } from "../../core/proxy/lifecycle.js";
import { getTerminalStats } from "../../core/terminal/manager.js";
import { useTheme } from "../../core/theme/index.js";
import type { UseTabsReturn } from "../../hooks/useTabs.js";
import { useRepoMapStore } from "../../stores/repomap.js";
import {
  computeModelCost,
  computeTotalCostFromBreakdown,
  isModelFree,
  isModelLocal,
  type LastDispatchSnapshot,
  type TokenUsage,
  useStatusBarStore,
  ZERO_USAGE,
} from "../../stores/statusbar.js";
import { useWorkerStore } from "../../stores/workers.js";
import {
  Field,
  PremiumPopup,
  ProgressBar,
  Section,
  SegmentedControl,
  Table,
  VSpacer,
} from "../ui/index.js";

const BOLD = TextAttributes.BOLD;
const SIDEBAR_W = 22;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${String(b)} B`;
}

function fmtMem(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${String(mb)} MB`;
}

// Sidebar tabs — six focused panels.
const TABS = ["Usage", "Prompt", "Cost", "Tabs", "Dispatch", "System"] as const;
type Tab = (typeof TABS)[number];

function fmtCost(c: number): string {
  if (c <= 0) return "—";
  return c < 0.01 ? `$${c.toFixed(3)}` : `$${c.toFixed(2)}`;
}

interface HearthStatusSummary {
  running: boolean;
  uptimeLabel: string;
  connectedSurfaces: number;
  totalSurfaces: number;
  totalChats: number;
  pendingApprovals: number;
  stats: {
    messagesIn: number;
    eventsOut: number;
    approvalsHandled: number;
    approvalsAllowed: number;
    approvalsDenied: number;
    pairingsIssued: number;
    tabsOpened: number;
    turnsCompleted: number;
    toolCalls: number;
    workspacesEver: number;
  };
  persistence: {
    installed: boolean;
    active?: boolean;
    platform: "darwin" | "linux" | "unsupported";
    unitLabel?: string;
  };
}

interface Props {
  visible: boolean;
  /** Accepts legacy "Context"/"System" for back-compat; routes to Usage/System. */
  initialTab?: Tab | "Context" | "System";
  onClose: () => void;
  activeModel: string;
  contextManager: ContextManager;
  tabMgr: UseTabsReturn;
  currentMode: string;
  currentModeLabel: string;
}

function resolveInitial(i: Props["initialTab"]): Tab {
  if (i === "Context") return "Usage";
  if (i === "System") return "System";
  if (i && (TABS as readonly string[]).includes(i)) return i as Tab;
  return "Usage";
}

export function StatusDashboard({
  visible,
  initialTab,
  onClose,
  activeModel: activeModelProp,
  contextManager,
  tabMgr,
  currentMode,
  currentModeLabel,
}: Props) {
  void useTheme();
  const { width: termCols, height: termRows } = useTerminalDimensions();

  // Wider popup — sidebar eats 22 cols + 3 chrome.
  const popupWidth = Math.min(120, Math.max(90, Math.floor(termCols * 0.9)));
  const popupH = Math.min(Math.max(22, Math.floor(termRows * 0.88)), termRows - 2);
  const contentW = popupWidth - SIDEBAR_W - 3;
  const scrollH = Math.max(8, popupH - 6);

  const [tab, setTab] = useState<Tab>(() => resolveInitial(initialTab));
  const [scrollOffset, setScrollOffset] = useState(0);
  const [scopeTabId, setScopeTabId] = useState<string | "all">(tabMgr.activeTabId);

  const sb = useStatusBarStore();
  const rm = useRepoMapStore();
  const wk = useWorkerStore();

  const [hearth, setHearth] = useState<HearthStatusSummary | null>(null);

  useEffect(() => {
    if (visible) {
      setTab(resolveInitial(initialTab));
      setScrollOffset(0);
      setScopeTabId(tabMgr.activeTabId);
    }
  }, [visible, initialTab, tabMgr.activeTabId]);

  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    const probe = async () => {
      try {
        const [
          { loadHearthConfig },
          { socketRequest },
          { HEARTH_PROTOCOL_VERSION },
          { getServiceStatus },
        ] = await Promise.all([
          import("../../hearth/config.js"),
          import("../../hearth/protocol.js"),
          import("../../hearth/types.js"),
          import("../../hearth/service.js"),
        ]);
        const cfg = loadHearthConfig();
        const { existsSync } = await import("node:fs");
        const svc = await getServiceStatus();
        const persistence = {
          installed: svc.installed,
          active: svc.active,
          platform: svc.platform,
          unitLabel: svc.unitLabel,
        };
        if (!existsSync(cfg.daemon.socketPath)) {
          if (!stopped)
            setHearth({
              running: false,
              uptimeLabel: "—",
              connectedSurfaces: 0,
              totalSurfaces: 0,
              totalChats: 0,
              pendingApprovals: 0,
              stats: {
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
              },
              persistence,
            });
          return;
        }
        const res = (await socketRequest(
          { op: "health", v: HEARTH_PROTOCOL_VERSION },
          { path: cfg.daemon.socketPath, timeoutMs: 1500 },
        )) as unknown as {
          ok: boolean;
          uptime: number;
          pendingApprovals: number;
          surfaces: { connected: boolean; chats: number }[];
          stats?: HearthStatusSummary["stats"];
        };
        if (stopped) return;
        const connected = res.surfaces.filter((s) => s.connected).length;
        const total = res.surfaces.length;
        const chats = res.surfaces.reduce((a, s) => a + s.chats, 0);
        const s = Math.floor(res.uptime / 1000);
        const uptimeLabel =
          s < 60
            ? `${String(s)}s`
            : s < 3600
              ? `${String(Math.floor(s / 60))}m ${String(s % 60)}s`
              : `${String(Math.floor(s / 3600))}h ${String(Math.floor(s / 60) % 60)}m`;
        setHearth({
          running: res.ok === true,
          uptimeLabel,
          connectedSurfaces: connected,
          totalSurfaces: total,
          totalChats: chats,
          pendingApprovals: res.pendingApprovals,
          stats: res.stats ?? {
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
          },
          persistence,
        });
      } catch {
        if (!stopped) setHearth(null);
      }
    };
    void probe();
    const iv = setInterval(() => void probe(), 4000);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [visible]);

  const pollWorkerMemory = useCallback(async () => {
    const store = useWorkerStore.getState();
    try {
      const intel = contextManager.getRepoMap();
      const res = await intel.queryMemory();
      store.setWorkerMemory(
        "intelligence",
        Math.round(res.heapUsed / 1024 / 1024),
        Math.round(res.rss / 1024 / 1024),
      );
    } catch {}
    try {
      const { getIOClient } = await import("../../core/workers/io-client.js");
      const res = await getIOClient().queryMemory();
      store.setWorkerMemory(
        "io",
        Math.round(res.heapUsed / 1024 / 1024),
        Math.round(res.rss / 1024 / 1024),
      );
    } catch {}
  }, [contextManager]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (visible && tab === "System") {
      pollWorkerMemory();
      pollRef.current = setInterval(pollWorkerMemory, 5_000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [visible, tab, pollWorkerMemory]);

  const modelId = activeModelProp;
  const tu = sb.tokenUsage;

  const allTabs = tabMgr.tabs;
  const isMultiTab = allTabs.length > 1;
  const isAllScope = scopeTabId === "all";

  const getTabUsage = useCallback(
    (tabId: string): TokenUsage => {
      if (tabId === tabMgr.activeTabId) return tu;
      return tabMgr.getChat(tabId)?.tokenUsage ?? ZERO_USAGE;
    },
    [tu, tabMgr],
  );

  const scopedUsage = useMemo((): TokenUsage => {
    if (!isAllScope) return getTabUsage(scopeTabId);
    const agg = { ...ZERO_USAGE, modelBreakdown: {} as TokenUsage["modelBreakdown"] };
    for (const tabEntry of allTabs) {
      const u = getTabUsage(tabEntry.id);
      agg.prompt += u.prompt;
      agg.completion += u.completion;
      agg.total += u.total;
      agg.cacheRead += u.cacheRead;
      agg.cacheWrite += u.cacheWrite;
      agg.subagentInput += u.subagentInput;
      agg.subagentOutput += u.subagentOutput;
      for (const [mid, usage] of Object.entries(u.modelBreakdown ?? {})) {
        const prev = agg.modelBreakdown[mid] ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
        agg.modelBreakdown[mid] = {
          input: prev.input + usage.input,
          output: prev.output + usage.output,
          cacheRead: prev.cacheRead + usage.cacheRead,
          cacheWrite: prev.cacheWrite + usage.cacheWrite,
        };
      }
    }
    return agg;
  }, [isAllScope, scopeTabId, getTabUsage, allTabs]);

  const [lspCount, setLspCount] = useState(0);
  useEffect(() => {
    getIntelligenceStatus().then((s) => setLspCount(s?.lspServers.length ?? 0));
  }, []);

  const scopeRelevant = tab === "Usage" || tab === "Prompt" || tab === "Cost" || tab === "Tabs";

  useKeyboard((evt) => {
    if (!visible) return;
    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "tab") {
      const idx = TABS.indexOf(tab);
      const dir = evt.shift ? -1 : 1;
      setTab(TABS[(idx + dir + TABS.length) % TABS.length] as Tab);
      setScrollOffset(0);
      return;
    }
    if (isMultiTab && scopeRelevant && (evt.name === "left" || evt.name === "right")) {
      const scopeIds = [...allTabs.map((tb) => tb.id), "all" as const];
      setScopeTabId((prev) => {
        const idx = scopeIds.indexOf(prev as string);
        const next =
          evt.name === "right"
            ? (idx + 1) % scopeIds.length
            : (idx - 1 + scopeIds.length) % scopeIds.length;
        return scopeIds[next] ?? prev;
      });
      setScrollOffset(0);
      return;
    }
    if (evt.name === "up") {
      setScrollOffset((p) => Math.max(0, p - 1));
      return;
    }
    if (evt.name === "down") {
      setScrollOffset((p) => p + 1);
      return;
    }
  });

  if (!visible) return null;

  const scopeLabel = isAllScope
    ? "All Tabs"
    : isMultiTab
      ? `Tab ${String(allTabs.findIndex((tb) => tb.id === scopeTabId) + 1)}`
      : "Session";

  const sidebarTabs = [
    { id: "Usage" as const, label: "Usage", icon: "context", blurb: "tokens · window" },
    { id: "Prompt" as const, label: "Prompt", icon: "note", blurb: "system sections" },
    { id: "Cost" as const, label: "Cost", icon: "sparkle", blurb: "per-model spend" },
    { id: "Tabs" as const, label: "Tabs", icon: "tabs", blurb: "per-tab summary" },
    {
      id: "Dispatch" as const,
      label: "Dispatch",
      icon: "dispatch",
      blurb: "last dispatch · cache",
    },
    { id: "System" as const, label: "System", icon: "system", blurb: "runtime · health" },
  ];

  const footerHints = [
    { key: "Tab", label: "panel" },
    ...(isMultiTab && scopeRelevant ? [{ key: "←→", label: "scope" }] : []),
    { key: "↑↓", label: "scroll" },
    { key: "Esc", label: "close" },
  ];

  const scopeOpts = [
    ...allTabs.map((tb, i) => ({ value: tb.id, label: `Tab ${String(i + 1)}` })),
    { value: "all" as const, label: "All" },
  ];

  return (
    <PremiumPopup
      visible={visible}
      width={popupWidth}
      height={popupH}
      title="Status"
      titleIcon="gauge"
      tabs={sidebarTabs}
      activeTab={tab}
      sidebarWidth={SIDEBAR_W}
      footerHints={footerHints}
    >
      {tab === "Usage" && (
        <UsagePane
          scopedUsage={scopedUsage}
          sb={sb}
          modelId={modelId}
          contextManager={contextManager}
          scopeLabel={scopeLabel}
          contentW={contentW}
          scrollOffset={scrollOffset}
          scrollH={scrollH}
          isMultiTab={isMultiTab}
          scopeTabId={scopeTabId}
          scopeOpts={scopeOpts}
        />
      )}
      {tab === "Prompt" && (
        <PromptPane
          contextManager={contextManager}
          contentW={contentW}
          scrollOffset={scrollOffset}
          scrollH={scrollH}
        />
      )}
      {tab === "Cost" && (
        <CostPane
          scopedUsage={scopedUsage}
          contentW={contentW}
          scopeLabel={scopeLabel}
          scrollOffset={scrollOffset}
          scrollH={scrollH}
          isMultiTab={isMultiTab}
          scopeTabId={scopeTabId}
          scopeOpts={scopeOpts}
        />
      )}
      {tab === "Tabs" && <TabsPane tabMgr={tabMgr} getTabUsage={getTabUsage} contentW={contentW} />}
      {tab === "Dispatch" && (
        <DispatchPane sb={sb} contentW={contentW} scrollOffset={scrollOffset} scrollH={scrollH} />
      )}
      {tab === "System" && (
        <SystemPane
          sb={sb}
          rm={rm}
          wk={wk}
          hearth={hearth}
          lspCount={lspCount}
          currentMode={currentMode}
          currentModeLabel={currentModeLabel}
          contentW={contentW}
          scrollOffset={scrollOffset}
          scrollH={scrollH}
        />
      )}
    </PremiumPopup>
  );
}

// ── Panes ────────────────────────────────────────────────────────────────

function UsagePane({
  scopedUsage,
  sb,
  modelId,
  contextManager,
  scopeLabel,
  contentW,
  scrollOffset,
  scrollH,
  isMultiTab,
  scopeTabId,
  scopeOpts,
}: {
  scopedUsage: TokenUsage;
  sb: ReturnType<typeof useStatusBarStore.getState>;
  modelId: string;
  contextManager: ContextManager;
  scopeLabel: string;
  contentW: number;
  scrollOffset: number;
  scrollH: number;
  isMultiTab: boolean;
  scopeTabId: string | "all";
  scopeOpts: { value: string | "all"; label: string }[];
}) {
  const t = useTheme();
  const su = scopedUsage;
  const uncachedInput = su.prompt + su.subagentInput;
  const allInput = uncachedInput + su.cacheRead + su.cacheWrite;
  const totalOutput = su.completion + su.subagentOutput;
  const hasSub = su.subagentInput > 0 || su.subagentOutput > 0;
  const cachePct = allInput > 0 ? Math.min(100, Math.round((su.cacheRead / allInput) * 100)) : 0;

  const breakdown = contextManager.getContextBreakdown();
  const systemChars = breakdown.reduce((sum, s) => sum + s.chars, 0);
  const ctxWindow =
    sb.contextWindow > 0 ? sb.contextWindow : getModelContextInfoSync(modelId).tokens;
  const isApi = sb.contextTokens > 0;
  const charEstimate = (systemChars + sb.chatChars + sb.subagentChars) / 4;
  const chatCharsDelta = Math.max(0, sb.chatChars - (sb.chatCharsAtSnapshot ?? 0));
  const usedTokens = Math.round(
    isApi ? sb.contextTokens + (chatCharsDelta + sb.subagentChars) / 4 : charEstimate,
  );
  const fillPct =
    usedTokens > 0 ? Math.min(100, Math.max(1, Math.round((usedTokens / ctxWindow) * 100))) : 0;
  const pctLabel = isApi ? `${String(fillPct)}%` : `~${String(fillPct)}%`;

  const isAnthropic = isAnthropicNative(modelId);
  const clientTriggerPct = 70;
  const clientTrigger = Math.floor(ctxWindow * (clientTriggerPct / 100));
  const clearPct = 30;
  const clearTrigger = Math.max(80_000, Math.floor(ctxWindow * (clearPct / 100)));
  const serverPct = 80;
  const serverTrigger = Math.max(160_000, Math.floor(ctxWindow * (serverPct / 100)));

  const ref = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    ref.current?.scrollTo(scrollOffset);
  }, [scrollOffset]);

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <Section title={`Context Window — ${scopeLabel}`}>
        <ProgressBar
          label="Used"
          labelWidth={10}
          pct={fillPct}
          width={contentW - 4}
          value={`${fmtTokens(usedTokens)} / ${fmtTokens(ctxWindow)}  (${pctLabel})`}
        />
        <VSpacer />
        <Field label="Model" labelWidth={10} value={getShortModelLabel(modelId)} />
      </Section>

      {isMultiTab && (
        <box paddingX={2} backgroundColor={t.bgPopup}>
          <SegmentedControl label="Scope" labelWidth={8} options={scopeOpts} value={scopeTabId} />
        </box>
      )}

      <scrollbox ref={ref} height={scrollH}>
        <Section title="Tokens">
          <Field
            label="Input"
            labelWidth={14}
            value={
              <text bg={t.bgPopup} fg={t.info}>
                {fmtTokens(uncachedInput)}
              </text>
            }
          />
          {hasSub && (
            <>
              <Field
                label="  main"
                labelWidth={14}
                value={
                  <text bg={t.bgPopup} fg={t.info}>
                    {fmtTokens(su.prompt)}
                  </text>
                }
              />
              <Field
                label="  dispatch"
                labelWidth={14}
                value={
                  <text bg={t.bgPopup} fg={t.brand}>
                    {fmtTokens(su.subagentInput)}
                  </text>
                }
              />
            </>
          )}
          <Field
            label="Output"
            labelWidth={14}
            value={
              <text bg={t.bgPopup} fg={t.warning}>
                {fmtTokens(totalOutput)}
              </text>
            }
          />
          {hasSub && (
            <>
              <Field
                label="  main"
                labelWidth={14}
                value={
                  <text bg={t.bgPopup} fg={t.warning}>
                    {fmtTokens(su.completion)}
                  </text>
                }
              />
              <Field
                label="  dispatch"
                labelWidth={14}
                value={
                  <text bg={t.bgPopup} fg={t.brand}>
                    {fmtTokens(su.subagentOutput)}
                  </text>
                }
              />
            </>
          )}
          <VSpacer />
          <ProgressBar
            label="Cache"
            labelWidth={10}
            pct={cachePct}
            width={contentW - 4}
            value={su.cacheRead > 0 ? `${fmtTokens(su.cacheRead)}  (${String(cachePct)}%)` : "—"}
            color={su.cacheRead > 0 ? t.success : t.textFaint}
          />
          {su.cacheWrite > 0 && (
            <Field
              label="Cache Write"
              labelWidth={14}
              value={
                <text bg={t.bgPopup} fg={t.warning}>
                  {fmtTokens(su.cacheWrite)}
                </text>
              }
            />
          )}
          <VSpacer />
          <Field
            label="Total"
            labelWidth={14}
            value={
              <text bg={t.bgPopup} fg={t.textPrimary} attributes={BOLD}>
                {fmtTokens(su.total)}
              </text>
            }
          />
        </Section>

        <Section title="Compaction">
          {isAnthropic && (
            <>
              <Field
                label="Tool clear"
                labelWidth={14}
                value={`${String(clearPct)}% — ${fmtTokens(clearTrigger)}`}
              />
              <Field
                label="Server pack"
                labelWidth={14}
                value={`${String(serverPct)}% — ${fmtTokens(serverTrigger)}`}
              />
            </>
          )}
          <Field
            label="Client pack"
            labelWidth={14}
            value={`${String(clientTriggerPct)}% — ${fmtTokens(clientTrigger)}`}
          />
        </Section>
      </scrollbox>
    </box>
  );
}

function PromptPane({
  contextManager,
  contentW,
  scrollOffset,
  scrollH,
}: {
  contextManager: ContextManager;
  contentW: number;
  scrollOffset: number;
  scrollH: number;
}) {
  const t = useTheme();
  const breakdown = contextManager.getContextBreakdown();
  const activeSections = breakdown.filter((s) => s.active && s.chars > 0);
  const totalSysChars = activeSections.reduce((sum, s) => sum + s.chars, 0);
  const ref = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    ref.current?.scrollTo(scrollOffset);
  }, [scrollOffset]);

  if (activeSections.length === 0) {
    return (
      <box flexDirection="column" paddingX={2} paddingY={2}>
        <text bg={t.bgPopup} fg={t.textMuted}>
          No active system prompt sections.
        </text>
      </box>
    );
  }

  return (
    <scrollbox ref={ref} height={scrollH}>
      <Section
        title="System Prompt"
        description={`${fmtTokens(Math.ceil(totalSysChars / 4))} tokens across ${String(activeSections.length)} sections`}
      >
        {activeSections.map((s) => {
          const sTokens = Math.ceil(s.chars / 4);
          const sPct = totalSysChars > 0 ? Math.round((s.chars / totalSysChars) * 100) : 0;
          return (
            <ProgressBar
              key={`sp-${s.section}`}
              label={s.section}
              labelWidth={22}
              pct={sPct}
              width={contentW - 4}
              value={`~${fmtTokens(sTokens)}  (${String(sPct)}%)`}
              color={sPct > 40 ? t.warning : t.textMuted}
            />
          );
        })}
      </Section>
    </scrollbox>
  );
}

function CostPane({
  scopedUsage,
  contentW,
  scopeLabel,
  scrollOffset,
  scrollH,
  isMultiTab,
  scopeTabId,
  scopeOpts,
}: {
  scopedUsage: TokenUsage;
  contentW: number;
  scopeLabel: string;
  scrollOffset: number;
  scrollH: number;
  isMultiTab: boolean;
  scopeTabId: string | "all";
  scopeOpts: { value: string | "all"; label: string }[];
}) {
  const t = useTheme();
  const su = scopedUsage;
  const sortedBd = Object.entries(su.modelBreakdown ?? {}).sort(
    ([, a], [, b]) => computeModelCost("", b) - computeModelCost("", a),
  );
  const allLocal = sortedBd.length > 0 && sortedBd.every(([mid]) => isModelLocal(mid));
  const allFree = !allLocal && sortedBd.length > 0 && sortedBd.every(([mid]) => isModelFree(mid));
  const totalCost =
    sortedBd.length > 0 ? computeTotalCostFromBreakdown(su.modelBreakdown ?? {}) : 0;

  interface CostRow {
    model: string;
    input: string;
    output: string;
    cost: string;
    pct: string;
  }
  const rows: CostRow[] = sortedBd.map(([mid, usage]) => {
    const local = isModelLocal(mid);
    const free = !local && isModelFree(mid);
    const c = computeModelCost(mid, usage);
    const pct = totalCost > 0 ? Math.round((c / totalCost) * 100) : 0;
    const shortId = mid.length > 28 ? `${mid.slice(0, 27)}…` : mid;
    return {
      model: shortId,
      input: fmtTokens(usage.input + usage.cacheRead),
      output: fmtTokens(usage.output),
      cost: local ? "Local" : free ? "FREE" : fmtCost(c),
      pct: c > 0 && totalCost > 0 ? `${String(pct)}%` : "—",
    };
  });

  const ref = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    ref.current?.scrollTo(scrollOffset);
  }, [scrollOffset]);

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      {isMultiTab && (
        <box paddingX={2} backgroundColor={t.bgPopup}>
          <SegmentedControl label="Scope" labelWidth={8} options={scopeOpts} value={scopeTabId} />
        </box>
      )}
      <Section
        title={`Cost — ${scopeLabel}`}
        description={
          allLocal
            ? "all local models"
            : allFree
              ? "all free tier"
              : totalCost > 0
                ? `total ${fmtCost(totalCost)}`
                : "no spend"
        }
      >
        {rows.length === 0 ? (
          <text bg={t.bgPopup} fg={t.textMuted}>
            No usage yet.
          </text>
        ) : (
          <scrollbox ref={ref} height={Math.max(4, scrollH - 4)}>
            <Table
              width={contentW - 4}
              maxRows={rows.length}
              columns={[
                { key: "model", align: "left" },
                { key: "input", align: "right", width: 10 },
                { key: "output", align: "right", width: 10 },
                { key: "cost", align: "right", width: 10 },
                { key: "pct", align: "right", width: 6 },
              ]}
              rows={rows}
            />
          </scrollbox>
        )}
      </Section>
    </box>
  );
}

function TabsPane({
  tabMgr,
  getTabUsage,
  contentW,
}: {
  tabMgr: UseTabsReturn;
  getTabUsage: (id: string) => TokenUsage;
  contentW: number;
}) {
  const t = useTheme();
  const allTabs = tabMgr.tabs;

  if (allTabs.length <= 1) {
    return (
      <box flexDirection="column" paddingX={2} paddingY={2}>
        <text bg={t.bgPopup} fg={t.textMuted}>
          Open more tabs to compare.
        </text>
      </box>
    );
  }

  interface TabRow {
    label: string;
    input: string;
    output: string;
    cachePct: string;
    cost: string;
  }

  const rows: TabRow[] = allTabs.map((tabEntry, i) => {
    const u = getTabUsage(tabEntry.id);
    const isActive = tabEntry.id === tabMgr.activeTabId;
    const uncached = u.prompt + u.subagentInput;
    const allIn = uncached + u.cacheRead + u.cacheWrite;
    const cachePct = allIn > 0 ? Math.round((u.cacheRead / allIn) * 100) : 0;
    const cost = computeTotalCostFromBreakdown(u.modelBreakdown ?? {});
    const totalOut = u.completion + u.subagentOutput;
    const mids = Object.keys(u.modelBreakdown ?? {});
    const allLocal = mids.length > 0 && mids.every(isModelLocal);
    const allFree = !allLocal && mids.length > 0 && mids.every(isModelFree);
    return {
      label: `${isActive ? "▸ " : "  "}Tab ${String(i + 1)}`,
      input: fmtTokens(uncached),
      output: fmtTokens(totalOut),
      cachePct: cachePct > 0 ? `${String(cachePct)}%` : "—",
      cost: allLocal ? "Local" : allFree ? "FREE" : fmtCost(cost),
    };
  });

  return (
    <Section title="Per Tab">
      <Table
        width={contentW - 4}
        maxRows={rows.length}
        columns={[
          { key: "label", align: "left" },
          { key: "input", align: "right", width: 10 },
          { key: "output", align: "right", width: 10 },
          { key: "cachePct", align: "right", width: 8 },
          { key: "cost", align: "right", width: 10 },
        ]}
        rows={rows}
      />
    </Section>
  );
}

function DispatchPane({
  sb,
  contentW,
  scrollOffset,
  scrollH,
}: {
  sb: ReturnType<typeof useStatusBarStore.getState>;
  contentW: number;
  scrollOffset: number;
  scrollH: number;
}) {
  const t = useTheme();
  const dispatch: LastDispatchSnapshot | null = sb.lastDispatch;
  const ref = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    ref.current?.scrollTo(scrollOffset);
  }, [scrollOffset]);

  if (!dispatch) {
    return (
      <box flexDirection="column" paddingX={2} paddingY={2}>
        <text bg={t.bgPopup} fg={t.textMuted}>
          No dispatch yet this session.
        </text>
      </box>
    );
  }

  const agents = Object.values(dispatch.agents);
  agents.sort((a, b) => a.agentId.localeCompare(b.agentId));

  let totalIn = 0;
  let totalOut = 0;
  let totalCache = 0;
  let totalCacheWrite = 0;
  let totalTools = 0;
  for (const a of agents) {
    totalIn += a.input ?? 0;
    totalOut += a.output ?? 0;
    totalCache += a.cacheRead ?? 0;
    totalCacheWrite += a.cacheWrite ?? 0;
    totalTools += a.toolUses ?? 0;
  }
  const allInput = totalIn;
  const overallCachePct =
    allInput > 0 ? Math.min(100, Math.round((totalCache / allInput) * 100)) : 0;

  const elapsed = (dispatch.finishedAt ?? Date.now()) - dispatch.startedAt;
  const elapsedLabel =
    elapsed < 1000
      ? `${String(elapsed)}ms`
      : elapsed < 60_000
        ? `${(elapsed / 1000).toFixed(1)}s`
        : `${String(Math.floor(elapsed / 60_000))}m ${String(Math.floor((elapsed % 60_000) / 1000))}s`;

  interface AgentRow {
    agent: string;
    tier: string;
    model: string;
    state: string;
    tools: string;
    input: string;
    output: string;
    cache: string;
    cachePct: string;
  }

  const compactModel = (raw: string): string => {
    let s = raw
      .replace(/^Claude\s+/i, "")
      .replace(/^GPT\s+/i, "GPT-")
      .replace(/^Gemini\s+/i, "");
    if (s.length > 14) s = `${s.slice(0, 13)}…`;
    return s;
  };

  const rows: AgentRow[] = agents.map((a) => {
    const cacheRead = a.cacheRead ?? 0;
    const input = a.input ?? 0;
    const pct = input > 0 ? Math.round((cacheRead / input) * 100) : 0;
    const stateLabel =
      a.state === "running"
        ? `${icon("spinner")} run`
        : a.state === "error"
          ? `${icon("error")} err`
          : a.succeeded === false
            ? `${icon("warning")} done`
            : `${icon("success")} done`;
    const model = a.modelId ? compactModel(getShortModelLabel(a.modelId)) : "—";
    const agentLabel = a.agentId.length > 18 ? `${a.agentId.slice(0, 17)}…` : a.agentId;
    const tier =
      a.tier === "spark"
        ? `${icon("spark")} spark`
        : a.tier === "ember"
          ? `${icon("ember")} ember`
          : "—";
    return {
      agent: agentLabel,
      tier,
      model,
      state: stateLabel,
      tools: String(a.toolUses ?? 0),
      input: fmtTokens(input),
      output: fmtTokens(a.output ?? 0),
      cache: cacheRead > 0 ? fmtTokens(cacheRead) : "—",
      cachePct: cacheRead > 0 ? `${String(pct)}%` : "—",
    };
  });

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <Section
        title="Last Dispatch"
        description={`${String(dispatch.completedAgents)}/${String(dispatch.totalAgents)} agents · ${elapsedLabel}`}
      >
        <ProgressBar
          label="Cache"
          labelWidth={10}
          pct={overallCachePct}
          width={contentW - 4}
          value={totalCache > 0 ? `${fmtTokens(totalCache)}  (${String(overallCachePct)}%)` : "—"}
          color={totalCache > 0 ? t.success : t.textFaint}
        />
        <VSpacer />
        <Field
          label="Input"
          labelWidth={14}
          value={
            <text bg={t.bgPopup} fg={t.info}>
              {fmtTokens(totalIn)}
            </text>
          }
        />
        <Field
          label="Output"
          labelWidth={14}
          value={
            <text bg={t.bgPopup} fg={t.warning}>
              {fmtTokens(totalOut)}
            </text>
          }
        />
        {totalCacheWrite > 0 && (
          <Field
            label="Cache Write"
            labelWidth={14}
            value={
              <text bg={t.bgPopup} fg={t.warning}>
                {fmtTokens(totalCacheWrite)}
              </text>
            }
          />
        )}
        <Field label="Tool calls" labelWidth={14} value={String(totalTools)} />
      </Section>

      <Section title="Per Agent">
        {rows.length === 0 ? (
          <text bg={t.bgPopup} fg={t.textMuted}>
            No agents recorded.
          </text>
        ) : (
          <scrollbox ref={ref} height={Math.max(4, scrollH - 8)}>
            <Table
              width={contentW - 4}
              maxRows={rows.length}
              columns={[
                { key: "agent", align: "left" },
                { key: "tier", align: "left", width: 9 },
                { key: "model", align: "left", width: 14 },
                { key: "state", align: "left", width: 7 },
                { key: "tools", align: "right", width: 5 },
                { key: "input", align: "right", width: 8 },
                { key: "output", align: "right", width: 8 },
                { key: "cache", align: "right", width: 8 },
                { key: "cachePct", align: "right", width: 6 },
              ]}
              rows={rows}
            />
          </scrollbox>
        )}
      </Section>
    </box>
  );
}

function SystemPane({
  sb,
  rm,
  wk,
  hearth,
  lspCount,
  currentMode,
  currentModeLabel,
  contentW: _contentW,
  scrollOffset,
  scrollH,
}: {
  sb: ReturnType<typeof useStatusBarStore.getState>;
  rm: ReturnType<typeof useRepoMapStore.getState>;
  wk: ReturnType<typeof useWorkerStore.getState>;
  hearth: HearthStatusSummary | null;
  lspCount: number;
  currentMode: string;
  currentModeLabel: string;
  contentW: number;
  scrollOffset: number;
  scrollH: number;
}) {
  const t = useTheme();
  const rssMB = sb.rssMB;
  const memColor = rssMB < 2048 ? t.success : rssMB < 4096 ? t.amber : t.error;
  const totalWorkerHeap = wk.intelligence.heapMB + wk.io.heapMB;
  const pr = sb.processRss;
  const hasNvim = getNvimInstance() != null;
  const hasProxy = getProxyPid() != null;

  const rmStatusColor =
    rm.status === "ready"
      ? t.success
      : rm.status === "scanning"
        ? t.amber
        : rm.status === "error"
          ? t.error
          : t.textMuted;
  const semLabel =
    rm.semanticStatus !== "off" ? ` · sem: ${rm.semanticStatus} (${String(rm.semanticCount)})` : "";

  const wkColor = (s: string) =>
    s === "ready" || s === "busy"
      ? t.success
      : s === "starting" || s === "restarting"
        ? t.amber
        : s === "crashed"
          ? t.error
          : t.textMuted;
  const wkIcon = (s: string) =>
    s === "busy"
      ? icon("worker_busy")
      : s === "crashed"
        ? icon("worker_crash")
        : s === "restarting"
          ? icon("worker_restart")
          : icon("worker");

  const termStats = getTerminalStats();

  const ref = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    ref.current?.scrollTo(scrollOffset);
  }, [scrollOffset]);

  return (
    <scrollbox ref={ref} height={scrollH}>
      <Section title="Soul Map">
        <box flexDirection="row" backgroundColor={t.bgPopup}>
          <text bg={t.bgPopup} fg={rmStatusColor}>
            ● {rm.status}
          </text>
          <text bg={t.bgPopup} fg={t.textMuted}>
            {` · ${String(rm.files)} files · ${String(rm.symbols)} symbols · ${String(rm.edges)} edges · ${fmtBytes(rm.dbSizeBytes)}${semLabel}`}
          </text>
        </box>
      </Section>

      <Section title="Process Tree">
        <box flexDirection="row" backgroundColor={t.bgPopup}>
          <text bg={t.bgPopup} fg={t.textSecondary}>
            {"main  "}
          </text>
          <text bg={t.bgPopup} fg={memColor}>
            {fmtMem(pr.mainMB)} rss
          </text>
        </box>
        <box flexDirection="row" backgroundColor={t.bgPopup}>
          <text bg={t.bgPopup} fg={t.textMuted}>
            {"  ├─ "}
          </text>
          <text bg={t.bgPopup} fg={wkColor(wk.intelligence.status)}>
            {`${wkIcon(wk.intelligence.status)} intelligence  ${wk.intelligence.status}`}
          </text>
          <text bg={t.bgPopup} fg={t.textMuted}>
            {wk.intelligence.heapMB > 0 ? `  ${fmtMem(wk.intelligence.heapMB)} heap` : ""}
          </text>
        </box>
        <box flexDirection="row" backgroundColor={t.bgPopup}>
          <text bg={t.bgPopup} fg={t.textMuted}>
            {"  └─ "}
          </text>
          <text bg={t.bgPopup} fg={wkColor(wk.io.status)}>
            {`${wkIcon(wk.io.status)} io  ${wk.io.status}`}
          </text>
          <text bg={t.bgPopup} fg={t.textMuted}>
            {wk.io.heapMB > 0 ? `  ${fmtMem(wk.io.heapMB)} heap` : ""}
          </text>
        </box>
        {hasNvim && (
          <box flexDirection="row" backgroundColor={t.bgPopup}>
            <text bg={t.bgPopup} fg={t.success}>
              {`${icon("worker")} neovim  active`}
            </text>
            <text bg={t.bgPopup} fg={t.textMuted}>
              {pr.nvimMB > 0 ? `  ${fmtMem(pr.nvimMB)} rss` : ""}
            </text>
          </box>
        )}
        {lspCount > 0 && (
          <box flexDirection="row" backgroundColor={t.bgPopup}>
            <text bg={t.bgPopup} fg={t.info}>
              {`${icon("worker")} lsp  ${String(lspCount)} server${lspCount > 1 ? "s" : ""}`}
            </text>
            <text bg={t.bgPopup} fg={t.textMuted}>
              {pr.lspMB > 0 ? `  ${fmtMem(pr.lspMB)} rss` : ""}
            </text>
          </box>
        )}
        {hasProxy && (
          <box flexDirection="row" backgroundColor={t.bgPopup}>
            <text bg={t.bgPopup} fg={t.brand}>
              {`${icon("worker")} proxy  active`}
            </text>
            <text bg={t.bgPopup} fg={t.textMuted}>
              {pr.proxyMB > 0 ? `  ${fmtMem(pr.proxyMB)} rss` : ""}
            </text>
          </box>
        )}
        {termStats.count > 0 && (
          <box flexDirection="row" backgroundColor={t.bgPopup}>
            <text bg={t.bgPopup} fg={termStats.activeCount > 0 ? t.success : t.textDim}>
              {`${icon("terminal")} terminals  ${String(termStats.activeCount)}/${String(termStats.count)} active`}
            </text>
          </box>
        )}
        <VSpacer />
        <Field
          label="Total"
          labelWidth={10}
          value={
            <text bg={t.bgPopup} fg={memColor}>
              {`${fmtMem(rssMB)} rss${totalWorkerHeap > 0 ? ` · ${fmtMem(totalWorkerHeap)} worker heap` : ""}`}
            </text>
          }
        />
      </Section>

      <Section title="Environment">
        <Field
          label="Mode"
          labelWidth={12}
          value={
            <text bg={t.bgPopup} fg={currentMode === "default" ? t.textMuted : t.warning}>
              {currentModeLabel}
            </text>
          }
        />
      </Section>

      {hearth && (
        <Section
          title="Hearth [experimental]"
          description={hearth.running ? "daemon online" : "daemon offline"}
        >
          <Field
            label="Status"
            labelWidth={18}
            value={
              <text bg={t.bgPopup} fg={hearth.running ? t.success : t.textMuted}>
                {hearth.running ? "running" : "offline"}
              </text>
            }
          />
          {(() => {
            const p = hearth.persistence;
            const v = p.installed
              ? p.active
                ? `active on boot · ${p.unitLabel ?? ""}`
                : `installed (inactive) · ${p.unitLabel ?? ""}`
              : p.platform === "unsupported"
                ? "not supported on this OS"
                : "not installed";
            return (
              <Field
                label="Persistence"
                labelWidth={18}
                value={
                  <text
                    bg={t.bgPopup}
                    fg={p.installed && p.active ? t.success : p.installed ? t.warning : t.textMuted}
                  >
                    {v}
                  </text>
                }
              />
            );
          })()}
          {hearth.running && (
            <>
              <Field label="Uptime" labelWidth={18} value={hearth.uptimeLabel} />
              <Field
                label="Surfaces"
                labelWidth={18}
                value={`${String(hearth.connectedSurfaces)}/${String(hearth.totalSurfaces)} connected · ${String(hearth.totalChats)} chats`}
              />
              <Field label="Messages in" labelWidth={18} value={String(hearth.stats.messagesIn)} />
              <Field label="Events out" labelWidth={18} value={String(hearth.stats.eventsOut)} />
              <Field
                label="Turns completed"
                labelWidth={18}
                value={String(hearth.stats.turnsCompleted)}
              />
              <Field label="Tool calls" labelWidth={18} value={String(hearth.stats.toolCalls)} />
              <Field
                label="Approvals"
                labelWidth={18}
                value={`${String(hearth.stats.approvalsHandled)} (${String(hearth.stats.approvalsAllowed)} allow · ${String(hearth.stats.approvalsDenied)} deny)`}
              />
              <Field
                label="Pending"
                labelWidth={18}
                value={
                  <text bg={t.bgPopup} fg={hearth.pendingApprovals > 0 ? t.warning : t.textPrimary}>
                    {String(hearth.pendingApprovals)}
                  </text>
                }
              />
              <Field
                label="Tabs opened"
                labelWidth={18}
                value={`${String(hearth.stats.tabsOpened)} (${String(hearth.stats.workspacesEver)} workspaces)`}
              />
              <Field
                label="Pairings issued"
                labelWidth={18}
                value={String(hearth.stats.pairingsIssued)}
              />
            </>
          )}
        </Section>
      )}
    </scrollbox>
  );
}
