import { TextAttributes } from "@opentui/core";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { AgentStatsEvent, SubagentStep } from "../../core/agents/subagent-events.js";
import { getCwd } from "../../core/cwd.js";
import { icon as getIcon, icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import {
  CATEGORY_COLORS,
  getBackendLabel,
  resolveToolDisplay,
  TOOL_ICONS,
  type ToolCategory,
} from "../../core/tool-display.js";
import { parsePlanOutput } from "../../types/plan-schema.js";
import { buildPrefix, buildTree, flattenTree } from "../layout/ChangedFiles.js";
import { Spinner } from "../layout/shared.js";
import { StructuredPlanView } from "../plan/StructuredPlanView.js";
import { DiffView } from "./DiffView.js";
import { useDispatchDisplay } from "./dispatch-display.js";
import { ImageDisplay } from "./ImageDisplay.js";
import {
  type AgentInfo,
  CACHE_ICONS,
  humanizeTokens,
  shortModelId,
} from "./multi-agent-display.js";
import { buildLiveToolRowProps, StaticToolRow } from "./StaticToolRow.js";
import { extractMultiReadFiles } from "./tool-formatters.js";

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

export interface LiveToolCall {
  id: string;
  toolName: string;
  state: "running" | "done" | "error";
  args?: string;
  result?: string;
  error?: string;
  /** Set at tool-call start when the backend is known upfront (e.g. routed web search agent). */
  backend?: string;
  /** Parent code_execution tool call ID — set when called from code execution sandbox. */
  parentId?: string;
  /** Live progress text from long-running tools (e.g. "[YT-DL] Summoning the pixels… 42%"). */
  progressText?: string;
  /** Image art for inline display (half-block ANSI or Kitty placeholders). */
  imageArt?: Array<{
    name: string;
    lines: string[];
    kittyImageId?: number;
    kittyCols?: number;
    kittyRows?: number;
  }>;
}

export const SUBAGENT_NAMES = new Set(["dispatch", "web_search"]);

export const RENDER_DEBOUNCE = 80;

function useElapsedTimers(calls: LiveToolCall[]) {
  const startTimes = useRef(new Map<string, number>());
  const callsRef = useRef(calls);
  callsRef.current = calls;
  const [elapsed, setElapsed] = useState(new Map<string, number>());

  useEffect(() => {
    const activeIds = new Set<string>();
    for (const call of calls) {
      activeIds.add(call.id);
      if (call.state === "running" && !startTimes.current.has(call.id)) {
        startTimes.current.set(call.id, Date.now());
      }
    }
    for (const id of startTimes.current.keys()) {
      if (!activeIds.has(id)) startTimes.current.delete(id);
    }
  }, [calls]);

  const hasRunning = calls.some((c) => c.state === "running");

  useEffect(() => {
    if (!hasRunning) return;

    const interval = setInterval(() => {
      const now = Date.now();
      setElapsed((prev) => {
        let changed = false;
        const next = new Map<string, number>();
        for (const call of callsRef.current) {
          const start = startTimes.current.get(call.id);
          if (start) {
            const secs = Math.floor((now - start) / 1000);
            next.set(call.id, secs);
            if (prev.get(call.id) !== secs) changed = true;
          }
        }
        if (!changed && prev.size === next.size) return prev;
        return next;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [hasRunning]);

  return elapsed;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return secs > 0 ? `${String(mins)}m ${String(secs)}s` : `${String(mins)}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${String(hrs)}h ${String(remMins)}m` : `${String(hrs)}h`;
}

const ChildStepRow = memo(
  function ChildStepRow({ step, isLast }: { step: SubagentStep; isLast?: boolean }) {
    const t = useTheme();
    const {
      icon,
      iconColor,
      label,
      category: staticCategory,
    } = resolveToolDisplay(step.toolName, t.textMuted);
    const hasSplit = !!(step.backend && staticCategory && step.backend !== staticCategory);
    const category = hasSplit ? staticCategory : (step.backend ?? staticCategory);
    const backendTag = hasSplit ? step.backend : null;
    const categoryColor =
      (staticCategory ? CATEGORY_COLORS[staticCategory as ToolCategory] : null) ??
      (step.backend
        ? (CATEGORY_COLORS[step.backend as ToolCategory] ?? t.textSecondary)
        : undefined) ??
      t.textSecondary;
    const backendColor = backendTag
      ? (CATEGORY_COLORS[backendTag as ToolCategory] ?? t.textSecondary)
      : undefined;
    const isDone = step.state !== "running";

    const cacheIcon = step.cacheState ? (CACHE_ICONS[step.cacheState] ?? "") : "";
    const _cc = getCacheColors(t);
    const cacheColor = step.cacheState ? (_cc[step.cacheState] ?? t.textSecondary) : "";
    const cacheLabel = getCacheLabel(step);

    return (
      <box height={1} flexShrink={0} marginLeft={3}>
        <text truncate>
          <span fg={t.textFaint}>{isLast ? "└ " : "├ "}</span>
          {step.cacheState === "wait" ? (
            <Spinner inline color={_cc.wait} />
          ) : step.state === "running" ? (
            <Spinner inline color={t.textMuted} />
          ) : step.state === "done" ? (
            <span fg={t.success}>✓</span>
          ) : (
            <span fg={t.error}>✗</span>
          )}
          <span fg={isDone ? t.textDim : iconColor}> {icon} </span>
          {category ? <span fg={isDone ? t.textFaint : categoryColor}>[{category}]</span> : null}
          {backendTag ? (
            <span fg={isDone ? t.textFaint : backendColor}>[{getBackendLabel(backendTag)}] </span>
          ) : category ? (
            <span> </span>
          ) : null}
          <span fg={isDone ? t.textDim : t.textSecondary}>{label}</span>
          {step.agentId ? <span fg={isDone ? t.textFaint : t.brand}> [{step.agentId}]</span> : null}
          {step.args ? <span fg={isDone ? t.textFaint : t.textMuted}> {step.args}</span> : null}
          {cacheIcon ? (
            <span fg={cacheColor}>
              {" "}
              {cacheIcon} {cacheLabel}
            </span>
          ) : null}
        </text>
      </box>
    );
  },
  (prev, next) =>
    prev.isLast === next.isLast &&
    prev.step.toolName === next.step.toolName &&
    prev.step.args === next.step.args &&
    prev.step.state === next.step.state &&
    prev.step.cacheState === next.step.cacheState &&
    prev.step.sourceAgentId === next.step.sourceAgentId &&
    prev.step.backend === next.step.backend &&
    prev.step.agentId === next.step.agentId,
);

function getCacheColors(t: {
  success: string;
  warning: string;
  info: string;
}): Record<string, string> {
  return {
    hit: t.success,
    wait: t.warning,
    store: t.info,
    invalidate: t.warning,
  };
}

function getCacheLabel(step: SubagentStep): string {
  switch (step.cacheState) {
    case "hit":
      return step.sourceAgentId ? `from ${step.sourceAgentId}` : "from cache";
    case "wait":
      return step.sourceAgentId ? `waiting on ${step.sourceAgentId}` : "waiting";
    case "store":
      return "cached";
    case "invalidate":
      return "updated cache";
    default:
      return "";
  }
}

const MultiAgentChildRow = memo(
  function MultiAgentChildRow({
    agentId,
    info,
    isFirst,
    isLast,
    childSteps,
    liveStats,
  }: {
    agentId: string;
    info: AgentInfo;
    isFirst: boolean;
    isLast: boolean;
    childSteps: SubagentStep[];
    liveStats?: AgentStatsEvent;
  }) {
    const t = useTheme();
    const roleIcon =
      info.role === "investigate"
        ? icon("investigate")
        : info.role === "explore"
          ? icon("explore")
          : icon("code");
    const roleColor =
      info.role === "investigate" ? t.info : info.role === "code" ? t.warning : t.brand;
    const isDone = info.state === "done" || info.state === "error";
    const isPending = info.state === "pending";
    const isPostProcess = agentId === "desloppify" || agentId === "verifier";
    const taskStr = isPostProcess
      ? ""
      : info.task.length > 40
        ? `${info.task.slice(0, 37)}...`
        : info.task;
    const connector = isLast ? "└ " : isFirst ? "┌ " : "├ ";
    const continuation = isLast ? "  " : "│ ";

    const toolUses = isDone ? info.toolUses : liveStats?.toolUses;
    const stepCount = liveStats?.stepCount;
    const tokenUsage = isDone ? info.tokenUsage : liveStats?.tokenUsage;
    const cacheHits = isDone ? info.cacheHits : liveStats?.cacheHits;

    const modelLabel = info.modelId ? shortModelId(info.modelId) : null;
    const isSpark = info.tier === "spark";
    const isEmber = info.tier === "ember";
    const isDesloppify = agentId === "desloppify";
    const isVerifier = agentId === "verifier";
    const hasTier = isSpark || isEmber;
    const tierIcon = isDesloppify
      ? icon("cleanup")
      : isVerifier
        ? icon("search")
        : info.role === "code"
          ? icon("edit")
          : icon("read_only");
    const tierName = isDesloppify
      ? "cleanup"
      : isVerifier
        ? "verify"
        : info.role === "code"
          ? "code"
          : "explore";
    const tierColor =
      isDesloppify || isVerifier ? t.info : info.role === "code" ? t.amber : t.brand;
    const showTierTag = hasTier || isDesloppify || isVerifier;

    return (
      <>
        <box height={1} flexShrink={0} marginLeft={3}>
          <text truncate>
            <span fg={t.textFaint}>{connector}</span>
            {info.state === "running" ? (
              <Spinner inline color={roleColor} />
            ) : info.state === "done" ? (
              info.succeeded ? (
                <span fg={t.success}>✓</span>
              ) : (
                <span fg={t.amber}>!</span>
              )
            ) : info.state === "error" ? (
              <span fg={t.error}>✗</span>
            ) : (
              <span fg={t.textMuted}>○</span>
            )}
            <span fg={isDone ? t.textDim : roleColor}> {roleIcon} </span>
            <span
              fg={isDone ? t.textDim : t.textPrimary}
              attributes={!isDone ? TextAttributes.BOLD : undefined}
            >
              {agentId}
            </span>
            {showTierTag ? (
              <span fg={isDone ? t.textDim : tierColor}>
                [{tierIcon} {tierName}]
              </span>
            ) : null}
            {modelLabel ? (
              <span fg={isDone ? t.textDim : t.success}>
                [{icon("model")} {modelLabel}]
              </span>
            ) : null}
            {stepCount != null && stepCount > 0 && !isDone ? (
              <span fg={t.success}>
                [{icon("gear")} {String(stepCount)}]
              </span>
            ) : toolUses != null && toolUses > 0 ? (
              <span fg={isDone ? t.textDim : t.success}>
                [{icon("gear")} {String(toolUses)}]
              </span>
            ) : null}
            {tokenUsage && tokenUsage.total > 0 ? (
              <span fg={isDone ? t.textDim : t.success}>
                [{icon("gauge")}{" "}
                {isDone && tokenUsage.input > 0
                  ? `${humanizeTokens(tokenUsage.input)}↓ ${humanizeTokens(tokenUsage.output)}↑`
                  : humanizeTokens(tokenUsage.total)}
                ]
              </span>
            ) : null}
            {cacheHits && cacheHits > 0 ? (
              <span fg={isDone ? t.textDim : t.amber}>
                [{icon("cache")} {humanizeTokens(cacheHits)}]
              </span>
            ) : null}
            {isPending && info.dependsOn && info.dependsOn.length > 0 ? (
              <span fg={t.textMuted}> waiting on {info.dependsOn.join(", ")}</span>
            ) : (
              <span fg={isDone ? t.textFaint : t.textMuted}> {taskStr}</span>
            )}
          </text>
        </box>
        {(() => {
          const agentDone = info.state === "done" || info.state === "error";
          // Collapse finished agents — show no child steps
          if (agentDone) return null;
          const filtered = childSteps.filter((s) => !QUIET_TOOLS.has(s.toolName));
          const running = filtered.filter((s) => s.state === "running");
          const doneCount = filtered.length - running.length;
          const agentRunning = info.state === "running";
          const showThinking = agentRunning && running.length === 0;
          const lastRunning = running.length > 0 ? running[running.length - 1] : null;

          return (
            <>
              {doneCount > 0 && (
                <box height={1} flexShrink={0} marginLeft={3}>
                  <text truncate>
                    <span fg={t.textFaint}>
                      {continuation}
                      {"  "}
                      {lastRunning || showThinking ? "├ " : "└ "}
                    </span>
                    <span fg={t.textDim}>+{String(doneCount)} completed</span>
                  </text>
                </box>
              )}
              {lastRunning &&
                (() => {
                  const {
                    icon: stepIcon,
                    iconColor: stepColor,
                    label: stepLabel,
                    category: stepStaticCategory,
                  } = resolveToolDisplay(lastRunning.toolName, t.textMuted);
                  const stepHasSplit = !!(
                    lastRunning.backend &&
                    stepStaticCategory &&
                    lastRunning.backend !== stepStaticCategory
                  );
                  const stepCategory = stepHasSplit
                    ? stepStaticCategory
                    : (lastRunning.backend ?? stepStaticCategory);
                  const stepBackendTag = stepHasSplit ? lastRunning.backend : null;
                  const stepCatColor =
                    (stepStaticCategory
                      ? CATEGORY_COLORS[stepStaticCategory as ToolCategory]
                      : null) ??
                    (lastRunning.backend
                      ? (CATEGORY_COLORS[lastRunning.backend as ToolCategory] ?? t.textSecondary)
                      : undefined) ??
                    t.textSecondary;
                  const stepBackendColor = stepBackendTag
                    ? (CATEGORY_COLORS[stepBackendTag as ToolCategory] ?? t.textSecondary)
                    : undefined;

                  const stepCacheColors = getCacheColors(t);
                  const cacheIcon = lastRunning.cacheState
                    ? (CACHE_ICONS[lastRunning.cacheState] ?? "")
                    : "";
                  const cacheColor = lastRunning.cacheState
                    ? (stepCacheColors[lastRunning.cacheState] ?? t.textSecondary)
                    : "";
                  const cacheLabel = getCacheLabel(lastRunning);

                  return (
                    <box height={1} flexShrink={0} marginLeft={3}>
                      <text truncate>
                        <span fg={t.textFaint}>
                          {continuation}
                          {"  "}└{" "}
                        </span>
                        {lastRunning.cacheState === "wait" ? (
                          <Spinner inline color={stepCacheColors.wait} />
                        ) : (
                          <Spinner inline color={t.textMuted} />
                        )}
                        <span fg={stepColor}> {stepIcon} </span>
                        {stepCategory ? <span fg={stepCatColor}>[{stepCategory}]</span> : null}
                        {stepBackendTag ? (
                          <span fg={stepBackendColor}>[{getBackendLabel(stepBackendTag)}] </span>
                        ) : stepCategory ? (
                          <span> </span>
                        ) : null}
                        <span fg={t.textSecondary}>{stepLabel}</span>
                        {lastRunning.args ? (
                          <span fg={t.textMuted}> {lastRunning.args}</span>
                        ) : null}
                        {cacheIcon ? (
                          <span fg={cacheColor}>
                            {" "}
                            {cacheIcon} {cacheLabel}
                          </span>
                        ) : null}
                      </text>
                    </box>
                  );
                })()}
              {showThinking && (
                <box height={1} flexShrink={0} marginLeft={3}>
                  <text truncate>
                    <span fg={t.textFaint}>
                      {continuation}
                      {"  "}└{" "}
                    </span>
                    <Spinner inline color={t.textMuted} />
                    <span fg={t.textMuted}> thinking...</span>
                  </text>
                </box>
              )}
            </>
          );
        })()}
      </>
    );
  },
  (prev, next) =>
    prev.agentId === next.agentId &&
    prev.isFirst === next.isFirst &&
    prev.isLast === next.isLast &&
    prev.info.state === next.info.state &&
    prev.info.role === next.info.role &&
    prev.info.toolUses === next.info.toolUses &&
    prev.info.cacheHits === next.info.cacheHits &&
    prev.info.tokenUsage?.total === next.info.tokenUsage?.total &&
    prev.childSteps.length === next.childSteps.length &&
    prev.childSteps.every((s, i) => {
      const n = next.childSteps[i];
      return (
        n &&
        s.toolName === n.toolName &&
        s.state === n.state &&
        s.args === n.args &&
        s.cacheState === n.cacheState
      );
    }) &&
    prev.liveStats?.toolUses === next.liveStats?.toolUses &&
    prev.liveStats?.tokenUsage?.total === next.liveStats?.tokenUsage?.total &&
    prev.liveStats?.cacheHits === next.liveStats?.cacheHits,
);

// Tree continuation border chars — pipe for non-last items, space for last
export const TREE_PIPE = {
  vertical: "│",
  horizontal: " ",
  topLeft: " ",
  topRight: " ",
  bottomLeft: " ",
  bottomRight: " ",
  topT: " ",
  bottomT: " ",
  leftT: " ",
  rightT: " ",
  cross: " ",
};
export const TREE_SPACE = {
  vertical: " ",
  horizontal: " ",
  topLeft: " ",
  topRight: " ",
  bottomLeft: " ",
  bottomRight: " ",
  topT: " ",
  bottomT: " ",
  leftT: " ",
  rightT: " ",
  cross: " ",
};

export type TreePosition = { isFirst: boolean; isLast: boolean };

const ToolRow = memo(
  function ToolRow({
    tc,
    seconds,
    diffStyle = "default",
    treePosition,
  }: {
    tc: LiveToolCall;
    seconds?: number;
    diffStyle?: "default" | "sidebyside" | "compact";
    treePosition?: TreePosition;
  }) {
    const t = useTheme();
    const isSubagent = SUBAGENT_NAMES.has(tc.toolName);
    const multiAgentInfo = useMemo(() => {
      if (tc.toolName !== "dispatch" || !tc.args) return null;
      try {
        const parsed: Record<string, unknown> = JSON.parse(tc.args);
        if (Array.isArray(parsed.tasks) && parsed.tasks.length >= 1) {
          const rawTasks: unknown[] = parsed.tasks;
          const tasks = rawTasks.map((entry, i) => {
            const e = isObj(entry) ? entry : {};
            return {
              agentId: String(e.id ?? e.agentId ?? `agent-${String(i + 1)}`),
              role: typeof e.role === "string" ? e.role : undefined,
              task: typeof e.task === "string" ? e.task : undefined,
              dependsOn: Array.isArray(e.dependsOn) ? e.dependsOn.map(String) : undefined,
            };
          });
          return { totalAgents: rawTasks.length, tasks };
        }
      } catch {}
      return null;
    }, [tc.toolName, tc.args]);
    const isMultiAgent = multiAgentInfo !== null;

    const dispatchId = isSubagent ? tc.id : null;
    const {
      steps: allChildSteps,
      progress: multiProgress,
      stats: liveStats,
    } = useDispatchDisplay(
      dispatchId,
      (multiAgentInfo?.totalAgents ?? 1) * 15,
      multiAgentInfo?.totalAgents ?? 0,
      multiAgentInfo?.tasks,
    );

    const isRepoMapHit = useMemo(() => {
      if (!tc.result) return false;
      try {
        const parsed = JSON.parse(tc.result);
        return parsed.repoMapHit === true;
      } catch {
        return false;
      }
    }, [tc.result]);

    const dispatchRejection = useMemo(() => {
      if (tc.toolName !== "dispatch" || tc.state !== "done" || !tc.result) return null;
      try {
        const p = JSON.parse(tc.result);
        if (p.reads) return null;
      } catch {}
      const match = tc.result.match(/(?:⛔|⚠️)\s*dispatch\s*\[rejected\s*→\s*(.+?)\]/);
      return match?.[1] ?? null;
    }, [tc.toolName, tc.state, tc.result]);

    // Build suffix (dispatch/elapsed/result — streaming-specific logic)
    let suffix = "";
    let suffixColor: string | undefined;
    if (isMultiAgent) {
      const total = multiProgress?.totalAgents ?? multiAgentInfo?.totalAgents ?? 0;
      const done = multiProgress
        ? [...multiProgress.agents.values()].filter(
            (a) => a.state === "done" || a.state === "error",
          ).length
        : 0;
      if (tc.state === "done" && dispatchRejection) {
        suffix = ` → rejected — ${dispatchRejection}`;
        suffixColor = t.warning;
      } else if (tc.state === "running") {
        const parts: string[] = [];
        if (seconds != null && seconds > 0) parts.push(formatDuration(seconds));
        if (total > 0) parts.push(`${String(done)}/${String(total)} agents`);
        if (multiProgress && multiProgress.findingCount > 0)
          parts.push(`${String(multiProgress.findingCount)} findings`);
        suffix = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
      } else if (tc.state === "done") {
        suffix = ` → ${String(done)}/${String(total)} agents`;
      }
    } else if (tc.state === "running" && tc.progressText) {
      suffix = ` · ${tc.progressText}`;
      if (seconds != null && seconds > 0) suffix += ` · ${formatDuration(seconds)}`;
    } else if (tc.state === "running" && seconds != null && seconds > 0) {
      suffix = ` ${formatDuration(seconds)}`;
    } else if (tc.state === "error" && tc.error) {
      suffix = ` → ${tc.error.slice(0, 50)}`;
      suffixColor = t.error;
    }
    // For non-dispatch done calls, suffix comes from buildLiveToolRowProps via formatResult

    const repoMapIcon = TOOL_ICONS._repomap ?? "◈";
    const staticProps = buildLiveToolRowProps(tc, {
      isRepoMapHit,
      repoMapIcon,
      suffix: suffix || undefined,
      suffixColor,
      dispatchRejection,
      diffStyle,
    });

    // Status content: Spinner for running, static icon for done/error
    const statusIcon =
      tc.state === "running" ? (
        <Spinner inline />
      ) : tc.state === "error" ? (
        <span fg={t.error}>✗</span>
      ) : (
        (() => {
          if (tc.result) {
            try {
              const parsed = JSON.parse(tc.result);
              if (parsed.success === false) return <span fg={t.warning}>!</span>;
            } catch {}
          }
          return <span fg={t.success}>✓</span>;
        })()
      );
    const connectorChar = treePosition
      ? treePosition.isLast
        ? "└ "
        : treePosition.isFirst
          ? "┌ "
          : "├ "
      : undefined;
    const statusContent = connectorChar ? (
      <>
        <span fg={t.textFaint}>{connectorChar}</span>
        {statusIcon}
      </>
    ) : (
      statusIcon
    );

    const inTree = !!treePosition;
    // Multi-file read tree (2+ files in a single read call)
    const multiReadFiles = useMemo(() => {
      if (tc.toolName !== "read" || !tc.args) return null;
      return extractMultiReadFiles(tc.toolName, tc.args);
    }, [tc.toolName, tc.args]);
    const hasExpanded =
      inTree &&
      (!!staticProps.diff ||
        (staticProps.imageArt && staticProps.imageArt.length > 0) ||
        (multiReadFiles && multiReadFiles.length >= 2) ||
        (isMultiAgent &&
          multiProgress !== null &&
          multiProgress.agents.size > 0 &&
          !dispatchRejection) ||
        (isSubagent && !isMultiAgent && allChildSteps.length > 0));

    // Expanded content elements (rendered inside continuation box when in tree, or inline otherwise)
    const multiAgentContent =
      isMultiAgent &&
      multiProgress !== null &&
      multiProgress.agents.size > 0 &&
      !dispatchRejection ? (
        <box flexDirection="column" marginLeft={2}>
          {[...multiProgress.agents.entries()].map(([agentId, info], idx, arr) => {
            const agentSteps = allChildSteps.filter((s) => s.agentId === agentId);
            const isLastVisible = idx === arr.length - 1;
            const allAccountedFor = arr.length >= (multiProgress.totalAgents ?? arr.length);
            return (
              <MultiAgentChildRow
                key={agentId}
                agentId={agentId}
                info={info}
                isFirst={idx === 0}
                isLast={isLastVisible && allAccountedFor}
                childSteps={agentSteps}
                liveStats={liveStats.get(agentId)}
              />
            );
          })}
        </box>
      ) : null;

    const singleAgentContent =
      isSubagent && !isMultiAgent && allChildSteps.length > 0 ? (
        <box flexDirection="column">
          {(() => {
            const filtered = allChildSteps.filter((s) => !QUIET_TOOLS.has(s.toolName));
            const running = filtered.filter((s) => s.state === "running");
            const doneCount = filtered.length - running.length;
            const agentRunning = tc.state === "running";
            const showThinking = agentRunning && running.length === 0;
            const lastRunning = running.length > 0 ? running[running.length - 1] : null;

            return (
              <>
                {doneCount > 0 && (
                  <box height={1} flexShrink={0} marginLeft={3}>
                    <text truncate>
                      <span fg={t.textFaint}>{lastRunning || showThinking ? "├ " : "└ "}</span>
                      <span fg={t.textDim}>+{String(doneCount)} completed</span>
                    </text>
                  </box>
                )}
                {lastRunning && (
                  <ChildStepRow
                    key={`${lastRunning.toolName}-${String(allChildSteps.indexOf(lastRunning))}`}
                    step={lastRunning}
                    isLast={!showThinking}
                  />
                )}
                {showThinking && (
                  <box height={1} flexShrink={0} marginLeft={3}>
                    <text truncate>
                      <span fg={t.textFaint}>└ </span>
                      <Spinner inline color={t.textMuted} />
                      <span fg={t.textMuted}> thinking...</span>
                    </text>
                  </box>
                )}
              </>
            );
          })()}
        </box>
      ) : null;

    const diffContent = staticProps.diff ? (
      <box flexDirection="column">
        <DiffView
          filePath={staticProps.diff.path}
          oldString={staticProps.diff.oldString}
          newString={staticProps.diff.newString}
          success={staticProps.diff.success}
          errorMessage={staticProps.diff.errorMessage}
          mode={diffStyle}
        />
        {staticProps.diff.impact ? (
          <text fg={t.textMuted}>
            {"  "}
            <span fg={t.amber}>{getIcon("impact")}</span>
            <span fg={t.textSecondary}> {staticProps.diff.impact}</span>
          </text>
        ) : null}
      </box>
    ) : null;

    const imageContent =
      staticProps.imageArt && staticProps.imageArt.length > 0
        ? staticProps.imageArt.map((img) => (
            <box key={img.name} flexDirection="column">
              <ImageDisplay img={img} />
            </box>
          ))
        : null;
    const multiReadContent =
      multiReadFiles && multiReadFiles.length >= 2
        ? (() => {
            const cwd = getCwd();
            const detailMap = new Map(multiReadFiles.map((f) => [f.path, f.detail]));

            // Standalone (not in tree): flat file list, no tree connectors
            if (!inTree) {
              const { icon: readIcon, iconColor: readIconColor } = resolveToolDisplay("read");
              return (
                <box flexDirection="column">
                  {multiReadFiles.map((f, fi) => {
                    const rel = f.path.startsWith(cwd)
                      ? f.path.slice(cwd.length + 1)
                      : f.path.split("/").slice(-2).join("/");
                    const detail = detailMap.get(f.path);
                    return (
                      <box key={`mr-${String(fi)}`} height={1}>
                        <text truncate>
                          <span fg={readIconColor}>{readIcon} </span>
                          <span fg={t.textSecondary}>{rel}</span>
                          {detail ? <span fg={t.textDim}> {detail}</span> : null}
                        </text>
                      </box>
                    );
                  })}
                </box>
              );
            }

            const entries = multiReadFiles.map((f) => ({
              path: f.path,
              editCount: 1,
              created: false,
            }));
            const treeRoot = buildTree(entries, cwd);
            const rows = flattenTree(treeRoot, 0, []);
            const { icon: readIcon, iconColor: readIconColor } = resolveToolDisplay("read");
            return (
              <box flexDirection="column">
                {rows.map((row, ri) => {
                  const prefix = buildPrefix(row);
                  const fileDetail = row.file ? detailMap.get(row.file.path) : undefined;
                  return (
                    <box key={`mr-${row.name}-${String(ri)}`} height={1}>
                      <text truncate>
                        <span fg={t.textFaint}>{prefix}</span>
                        {!row.isDir ? <span fg={readIconColor}>{readIcon} </span> : null}
                        <span fg={row.isDir ? t.textMuted : t.textSecondary}>
                          {row.name}
                          {row.isDir ? "/" : ""}
                        </span>
                        {fileDetail ? <span fg={t.textDim}> {fileDetail}</span> : null}
                      </text>
                    </box>
                  );
                })}
              </box>
            );
          })()
        : null;

    return (
      <box flexDirection="column">
        <StaticToolRow {...staticProps} statusContent={statusContent} suppressExpanded={inTree} />
        {hasExpanded ? (
          <box
            border={["left"]}
            customBorderChars={treePosition?.isLast ? TREE_SPACE : TREE_PIPE}
            borderColor={t.textFaint}
            paddingLeft={1}
          >
            <box flexDirection="column">
              {diffContent}
              {imageContent}
              {multiReadContent}
              {multiAgentContent}
              {singleAgentContent}
            </box>
          </box>
        ) : (
          <>
            {multiReadContent ? <box paddingLeft={3}>{multiReadContent}</box> : null}
            {multiAgentContent}
            {singleAgentContent}
          </>
        )}
      </box>
    );
  },
  (prev, next) =>
    prev.tc.id === next.tc.id &&
    prev.tc.state === next.tc.state &&
    prev.tc.args === next.tc.args &&
    prev.tc.result === next.tc.result &&
    prev.tc.error === next.tc.error &&
    prev.tc.backend === next.tc.backend &&
    prev.tc.progressText === next.tc.progressText &&
    prev.seconds === next.seconds &&
    prev.diffStyle === next.diffStyle &&
    prev.treePosition?.isFirst === next.treePosition?.isFirst &&
    prev.treePosition?.isLast === next.treePosition?.isLast,
);

const QUIET_TOOLS = new Set(["update_plan_step", "ask_user", "task_list", "final_response"]);

const EDIT_TOOL_NAMES = new Set(["edit_file", "multi_edit"]);

function isEditTool(name: string): boolean {
  return EDIT_TOOL_NAMES.has(name);
}

function isFailedEdit(tc: LiveToolCall): boolean {
  if (!isEditTool(tc.toolName) || tc.state !== "done") return false;
  try {
    const parsed = JSON.parse(tc.result ?? "");
    return parsed.success === false;
  } catch {
    return false;
  }
}

function extractPath(args?: string): string | null {
  if (!args) return null;
  try {
    const parsed = JSON.parse(args);
    return typeof parsed.path === "string" ? parsed.path : null;
  } catch {
    const m = args.match(/"path"\s*:\s*"([^"]+)"/);
    return m?.[1] ?? null;
  }
}

interface Props {
  calls: LiveToolCall[];
  /** Full tool call list for finding code_execution children (optional — defaults to calls). */
  allCalls?: LiveToolCall[];
  verbose?: boolean;
  diffStyle?: "default" | "sidebyside" | "compact";
}

/** Render a single tool call row with optional tree connector prefix. */
function renderToolCall(
  tc: LiveToolCall,
  seconds: number | undefined,
  diffStyle: "default" | "sidebyside" | "compact",
  t: { textMuted: string; amber: string; textFaint: string },
  connector?: TreePosition,
) {
  if ((tc.toolName === "write_plan" || tc.toolName === "plan") && tc.args) {
    try {
      const plan = parsePlanOutput(JSON.parse(tc.args));
      if (plan) {
        const planContent = (
          <>
            <StructuredPlanView plan={plan} result={tc.result} />
            {tc.state === "running" && (
              <box height={1} flexShrink={0} marginTop={1}>
                <text>
                  <span fg={t.textMuted}>◎ </span>
                  <span fg={t.amber}> Awaiting review</span>
                  <span fg={t.textMuted}> — select below</span>
                </text>
              </box>
            )}
          </>
        );
        if (connector) {
          const char = connector.isLast ? "└ " : connector.isFirst ? "┌ " : "├ ";
          return (
            <box key={tc.id} flexDirection="column">
              <box height={1} flexShrink={0}>
                <text>
                  <span fg={t.textFaint}>{char}</span>
                </text>
              </box>
              <box
                border={["left"]}
                customBorderChars={connector.isLast ? TREE_SPACE : TREE_PIPE}
                borderColor={t.textFaint}
                paddingLeft={1}
              >
                <box flexDirection="column">{planContent}</box>
              </box>
            </box>
          );
        }
        return (
          <box key={tc.id} flexDirection="column">
            {planContent}
          </box>
        );
      }
    } catch {}
  }
  if (connector) {
    return (
      <ToolRow
        key={tc.id}
        tc={tc}
        seconds={seconds}
        diffStyle={diffStyle}
        treePosition={connector}
      />
    );
  }
  return <ToolRow key={tc.id} tc={tc} seconds={seconds} diffStyle={diffStyle} />;
}

/** Render child tool calls nested under a code_execution parent with indented rail. */
function renderCodeExecChildren(
  children: LiveToolCall[] | undefined,
  elapsed: Map<string, number>,
  diffStyle: "default" | "sidebyside" | "compact",
  t: { textMuted: string; amber: string; textFaint: string },
  isLastInTree?: boolean,
) {
  if (!children || children.length === 0) return null;
  return (
    <box
      border={["left"]}
      customBorderChars={isLastInTree ? TREE_SPACE : TREE_PIPE}
      borderColor={t.textFaint}
      paddingLeft={1}
      flexDirection="column"
    >
      <box
        border={["left"]}
        customBorderChars={TREE_PIPE}
        borderColor={t.textFaint}
        paddingLeft={1}
        flexDirection="column"
      >
        {children.map((tc) => renderToolCall(tc, elapsed.get(tc.id), diffStyle, t))}
      </box>
    </box>
  );
}

export const ToolCallDisplay = memo(function ToolCallDisplay({
  calls,
  allCalls,
  verbose = false,
  diffStyle = "default",
}: Props) {
  const t = useTheme();
  const source = allCalls ?? calls;
  const elapsed = useElapsedTimers(source);

  if (calls.length === 0) return null;

  // Separate child calls (from code_execution) from top-level calls
  // Use allCalls (full list) to find children that aren't in the segment-filtered calls
  const childMap = new Map<string, LiveToolCall[]>();
  const topLevel: LiveToolCall[] = [];
  // Build child map from the full list (source) so children excluded from segments are found
  for (const tc of source) {
    if (tc.parentId) {
      const children = childMap.get(tc.parentId) ?? [];
      children.push(tc);
      childMap.set(tc.parentId, children);
    }
  }
  // Top-level comes from the segment-filtered calls only
  for (const tc of calls) {
    if (!tc.parentId) {
      topLevel.push(tc);
    }
  }

  const visible = topLevel.filter((tc, idx) => {
    if (QUIET_TOOLS.has(tc.toolName) && !(verbose && tc.toolName === "ask_user")) return false;
    if (isFailedEdit(tc)) {
      const path = extractPath(tc.args);
      if (path) {
        for (let j = idx + 1; j < topLevel.length; j++) {
          const later = topLevel[j];
          if (later && isEditTool(later.toolName) && extractPath(later.args) === path) return false;
        }
      }
    }
    return true;
  });

  // Single call — no tree needed
  if (visible.length <= 1) {
    return (
      <box flexDirection="column">
        {visible.map((tc) => (
          <box key={tc.id} flexDirection="column">
            {renderToolCall(tc, elapsed.get(tc.id), diffStyle, t)}
            {renderCodeExecChildren(childMap.get(tc.id), elapsed, diffStyle, t, true)}
          </box>
        ))}
      </box>
    );
  }

  // Multiple parallel calls — render with tree grouping
  return (
    <box flexDirection="column">
      {visible.map((tc, i) => {
        const isLast = i === visible.length - 1;
        return (
          <box key={tc.id} flexDirection="column">
            {renderToolCall(tc, elapsed.get(tc.id), diffStyle, t, {
              isFirst: i === 0,
              isLast,
            })}
            {renderCodeExecChildren(childMap.get(tc.id), elapsed, diffStyle, t, isLast)}
          </box>
        );
      })}
    </box>
  );
});
export function DispatchSubtree({ call }: { call: LiveToolCall }) {
  const t = useTheme();
  const isSubagent = SUBAGENT_NAMES.has(call.toolName);
  const multiAgentInfo = useMemo(() => {
    if (call.toolName !== "dispatch" || !call.args) return null;
    try {
      const parsed: Record<string, unknown> = JSON.parse(call.args);
      if (Array.isArray(parsed.tasks) && parsed.tasks.length >= 1) {
        const rawTasks: unknown[] = parsed.tasks;
        const tasks = rawTasks.map((entry, i) => {
          const e = isObj(entry) ? entry : {};
          return {
            agentId: String(e.id ?? e.agentId ?? `agent-${String(i + 1)}`),
            role: typeof e.role === "string" ? e.role : undefined,
            task: typeof e.task === "string" ? e.task : undefined,
            dependsOn: Array.isArray(e.dependsOn) ? e.dependsOn.map(String) : undefined,
          };
        });
        return { totalAgents: rawTasks.length, tasks };
      }
    } catch {}
    return null;
  }, [call.toolName, call.args]);
  const isMultiAgent = multiAgentInfo !== null;

  const dispatchRejection = useMemo(() => {
    if (call.toolName !== "dispatch" || call.state !== "done" || !call.result) return null;
    try {
      const p = JSON.parse(call.result);
      if (p.reads) return null;
    } catch {}
    const match = call.result.match(/(?:⛔|⚠️)\s*dispatch\s*\[rejected\s*→\s*(.+?)\]/);
    return match?.[1] ?? null;
  }, [call.toolName, call.state, call.result]);

  const {
    steps: allChildSteps,
    progress: multiProgress,
    stats: liveStats,
  } = useDispatchDisplay(
    isSubagent ? call.id : null,
    (multiAgentInfo?.totalAgents ?? 1) * 15,
    multiAgentInfo?.totalAgents ?? 0,
    multiAgentInfo?.tasks,
  );

  if (!isSubagent) return null;

  if (
    isMultiAgent &&
    multiProgress !== null &&
    multiProgress.agents.size > 0 &&
    !dispatchRejection
  ) {
    return (
      <box flexDirection="column" marginLeft={2}>
        {[...multiProgress.agents.entries()].map(([agentId, info], idx, arr) => {
          const agentSteps = allChildSteps.filter((s) => s.agentId === agentId);
          const isLastVisible = idx === arr.length - 1;
          const allAccountedFor = arr.length >= (multiProgress.totalAgents ?? arr.length);
          return (
            <MultiAgentChildRow
              key={agentId}
              agentId={agentId}
              info={info}
              isFirst={idx === 0}
              isLast={isLastVisible && allAccountedFor}
              childSteps={agentSteps}
              liveStats={liveStats.get(agentId)}
            />
          );
        })}
      </box>
    );
  }

  if (!isMultiAgent && allChildSteps.length > 0) {
    const filtered = allChildSteps.filter((s) => !QUIET_TOOLS.has(s.toolName));
    const running = filtered.filter((s) => s.state === "running");
    const doneCount = filtered.length - running.length;
    const agentRunning = call.state === "running";
    const showThinking = agentRunning && running.length === 0;
    const lastRunning = running.length > 0 ? running[running.length - 1] : null;
    return (
      <box flexDirection="column">
        {doneCount > 0 ? (
          <box height={1} flexShrink={0} marginLeft={3}>
            <text truncate>
              <span fg={t.textFaint}>{lastRunning || showThinking ? "├ " : "└ "}</span>
              <span fg={t.textDim}>+{String(doneCount)} completed</span>
            </text>
          </box>
        ) : null}
        {lastRunning ? (
          <ChildStepRow
            key={`${lastRunning.toolName}-${String(allChildSteps.indexOf(lastRunning))}`}
            step={lastRunning}
            isLast={!showThinking}
          />
        ) : null}
        {showThinking ? (
          <box height={1} flexShrink={0} marginLeft={3}>
            <text truncate>
              <span fg={t.textFaint}>└ </span>
              <Spinner inline color={t.textMuted} />
              <span fg={t.textMuted}> thinking...</span>
            </text>
          </box>
        ) : null}
      </box>
    );
  }

  return null;
}
