import { TextAttributes } from "@opentui/core";
import { memo, type ReactNode } from "react";
import { icon as getIcon } from "../../core/icons.js";
import { getThemeTokens, useTheme } from "../../core/theme/index.js";
import {
  CATEGORY_COLORS,
  getBackendLabel,
  resolveToolDisplay,
  TOOL_LABELS_DONE,
  type ToolCategory,
} from "../../core/tool-display.js";
import { DiffView } from "./DiffView.js";
import { ImageDisplay } from "./ImageDisplay.js";
import {
  detectCodeExecution,
  detectOutsideCwd,
  formatArgs,
  formatResult,
  OUTSIDE_BADGE,
} from "./tool-formatters.js";

interface StaticToolRowProps {
  statusContent: ReactNode;
  isDone: boolean;
  icon: string;
  iconColor: string;
  label: string;
  category?: string;
  categoryColor?: string;
  backendTag?: string;
  backendColor?: string;
  outsideBadge?: { label: string; color: string } | null;
  argStr?: string;
  /** When set, replaces label+args with this text (e.g. edit result summary) */
  editResultText?: string;
  suffix?: string;
  suffixColor?: string;
  /** Render a diff view below the main row */
  diff?: {
    path: string;
    oldString: string;
    newString: string;
    success: boolean;
    errorMessage?: string;
    impact?: string;
  } | null;
  diffStyle?: "default" | "sidebyside" | "compact";
  /** Image art for inline display (half-block ANSI or Kitty placeholders). */
  imageArt?: Array<{
    name: string;
    lines: string[];
    kittyImageId?: number;
    kittyCols?: number;
    kittyRows?: number;
  }>;
  /** When true, skip rendering diff and imageArt — caller handles them in a tree continuation box. */
  suppressExpanded?: boolean;
}

/**
 * Pure render component for a single tool call row.
 * No hooks — shared between streaming (ToolCallDisplay) and final (MessageList) views.
 */
function StaticToolRowImpl({
  statusContent,
  isDone,
  icon,
  iconColor,
  label,
  category,
  categoryColor,
  backendTag,
  backendColor,
  outsideBadge,
  argStr,
  editResultText,
  suffix,
  suffixColor,
  diff,
  diffStyle = "default",
  imageArt,
  suppressExpanded = false,
}: StaticToolRowProps) {
  const t = useTheme();
  const rc = {
    textDone: t.textMuted,
    toolNameActive: t.brand,
    argsActive: t.textSecondary,
    checkDone: t.success,
    error: t.error,
  };
  return (
    <box flexDirection="column">
      <box height={1} flexShrink={0}>
        <text truncate>
          {statusContent}
          <span fg={isDone ? rc.textDone : iconColor}> {icon} </span>
          {category ? <span fg={isDone ? t.textDim : categoryColor}>[{category}]</span> : null}
          {backendTag ? (
            <span fg={isDone ? t.textDim : backendColor}>[{getBackendLabel(backendTag)}] </span>
          ) : category ? (
            <span> </span>
          ) : null}
          {outsideBadge ? (
            <span fg={isDone ? t.textDim : outsideBadge.color}>[{outsideBadge.label}] </span>
          ) : null}
          {editResultText ? (
            <span fg={rc.textDone}>{editResultText}</span>
          ) : (
            <>
              <span
                fg={isDone ? rc.textDone : rc.toolNameActive}
                attributes={!isDone ? TextAttributes.BOLD : undefined}
              >
                {label}
              </span>
              {argStr ? <span fg={isDone ? rc.textDone : rc.argsActive}> {argStr}</span> : null}
            </>
          )}
          {suffix ? <span fg={suffixColor ?? rc.textDone}>{suffix}</span> : null}
        </text>
      </box>
      {!suppressExpanded && diff ? (
        <box marginTop={1} flexDirection="column">
          <DiffView
            filePath={diff.path}
            oldString={diff.oldString}
            newString={diff.newString}
            success={diff.success}
            errorMessage={diff.errorMessage}
            mode={diffStyle}
          />
          {diff.impact ? (
            <text fg={t.textMuted}>
              {"  "}
              <span fg={t.amber}>{getIcon("impact")}</span>
              <span fg={t.textSecondary}> {diff.impact}</span>
            </text>
          ) : null}
        </box>
      ) : null}
      {!suppressExpanded && imageArt && imageArt.length > 0
        ? imageArt.map((img) => (
            <box key={img.name} flexDirection="column">
              <ImageDisplay img={img} />
            </box>
          ))
        : null}
    </box>
  );
}

function toolRowPropsEqual(prev: StaticToolRowProps, next: StaticToolRowProps): boolean {
  if (prev.isDone !== next.isDone) return false;
  if (prev.icon !== next.icon) return false;
  if (prev.iconColor !== next.iconColor) return false;
  if (prev.label !== next.label) return false;
  if (prev.category !== next.category) return false;
  if (prev.categoryColor !== next.categoryColor) return false;
  if (prev.backendTag !== next.backendTag) return false;
  if (prev.backendColor !== next.backendColor) return false;
  if (prev.argStr !== next.argStr) return false;
  if (prev.editResultText !== next.editResultText) return false;
  if (prev.suffix !== next.suffix) return false;
  if (prev.suffixColor !== next.suffixColor) return false;
  if (prev.diffStyle !== next.diffStyle) return false;
  if (prev.suppressExpanded !== next.suppressExpanded) return false;
  if (prev.statusContent !== next.statusContent) return false;
  // outsideBadge — shape stable, compare fields
  const pob = prev.outsideBadge;
  const nob = next.outsideBadge;
  if (!!pob !== !!nob) return false;
  if (pob && nob && (pob.label !== nob.label || pob.color !== nob.color)) return false;
  // diff — same shape
  const pd = prev.diff;
  const nd = next.diff;
  if (!!pd !== !!nd) return false;
  if (pd && nd) {
    if (
      pd.path !== nd.path ||
      pd.oldString !== nd.oldString ||
      pd.newString !== nd.newString ||
      pd.success !== nd.success ||
      pd.errorMessage !== nd.errorMessage ||
      pd.impact !== nd.impact
    )
      return false;
  }
  // imageArt — ref check is enough; builders return a stable array per call
  if (prev.imageArt !== next.imageArt) return false;
  return true;
}

export const StaticToolRow = memo(StaticToolRowImpl, toolRowPropsEqual);

// ── Shared helpers (used by both streaming and static builders) ──

const EDIT_TOOL_NAMES = new Set(["edit_file", "multi_edit"]);

/** Resolve backend/category split display from tool name + backend string. */
function resolveBackendCategory(
  toolCategory: ToolCategory | undefined,
  backend: string | null,
): {
  category: string | undefined;
  categoryColor: string;
  backendTag: string | undefined;
  backendColor: string | undefined;
} {
  const hasSplit = !!(backend && toolCategory && backend !== toolCategory);
  const category = hasSplit ? toolCategory : (backend ?? toolCategory);
  const backendTag = hasSplit ? backend : null;
  const categoryColor =
    (toolCategory ? CATEGORY_COLORS[toolCategory as ToolCategory] : null) ??
    (backend
      ? (CATEGORY_COLORS[backend as ToolCategory] ?? getThemeTokens().textSecondary)
      : undefined) ??
    getThemeTokens().textSecondary;
  const backendColor = backendTag
    ? (CATEGORY_COLORS[backendTag as ToolCategory] ?? getThemeTokens().textSecondary)
    : undefined;
  return {
    category: category ?? undefined,
    categoryColor,
    backendTag: backendTag ?? undefined,
    backendColor,
  };
}

/** Extract edit diff from parsed args + result. */
function extractEditDiff(
  toolName: string,
  args: { path?: unknown; oldString?: unknown; newString?: unknown; edits?: unknown },
  result: { success: boolean; output?: string; error?: string } | null,
): StaticToolRowProps["diff"] {
  if (toolName !== "edit_file" && toolName !== "multi_edit") return null;

  let impact: string | undefined;
  if (result?.success && result.output) {
    const m = result.output.match(/\[impact: (.+)\]/);
    if (m?.[1]) impact = m[1];
  }

  // multi_edit: combine all edits into a single before/after
  if (toolName === "multi_edit") {
    if (typeof args.path !== "string" || !Array.isArray(args.edits)) return null;
    const edits = args.edits as Array<{ oldString?: unknown; newString?: unknown }>;
    const oldParts: string[] = [];
    const newParts: string[] = [];
    for (const e of edits) {
      if (typeof e.oldString === "string" && typeof e.newString === "string") {
        oldParts.push(e.oldString);
        newParts.push(e.newString);
      }
    }
    if (oldParts.length === 0) return null;
    return {
      path: args.path,
      oldString: oldParts.join("\n…\n"),
      newString: newParts.join("\n…\n"),
      success: result?.success ?? false,
      errorMessage: result?.error,
      impact,
    };
  }

  // edit_file
  if (
    typeof args.path !== "string" ||
    typeof args.oldString !== "string" ||
    typeof args.newString !== "string"
  )
    return null;

  return {
    path: args.path,
    oldString: args.oldString,
    newString: args.newString,
    success: result?.success ?? false,
    errorMessage: result?.error,
    impact,
  };
}

/** Compute suffix for a completed tool call. */
function computeSuffix(
  toolName: string,
  resultJson: string | undefined,
  result: { success: boolean; error?: string } | null,
  isEdit: boolean,
  hasEditResultText: boolean,
): { suffix?: string; suffixColor?: string } {
  if (hasEditResultText || !result) return {};

  const denied =
    !result.success && !!(result.error && /denied|rejected|cancelled/i.test(result.error));
  const isError = !result.success && !denied;

  if (isError) {
    const fullError = result.error ?? "";
    const clean = fullError.length > 60 ? `${fullError.slice(0, 57)}…` : fullError;
    const st = getThemeTokens();
    return { suffix: ` → ${clean}`, suffixColor: st.error };
  }
  if (denied) return { suffix: " → denied", suffixColor: getThemeTokens().textSecondary };
  if (!isEdit && resultJson) {
    const r = formatResult(toolName, resultJson);
    if (r) return { suffix: ` → ${r}` };
  }
  return {};
}

// ── Prop builders ──

/** Build props from a LiveToolCall (streaming path) — call this from ToolRow */
export function buildLiveToolRowProps(
  tc: {
    toolName: string;
    state: "running" | "done" | "error";
    args?: string;
    result?: string;
    error?: string;
    backend?: string;
    imageArt?: Array<{
      name: string;
      lines: string[];
      kittyImageId?: number;
      kittyCols?: number;
      kittyRows?: number;
    }>;
  },
  extra?: {
    isRepoMapHit?: boolean;
    repoMapIcon?: string;
    suffix?: string;
    suffixColor?: string;
    dispatchRejection?: string | null;
    diffStyle?: "default" | "sidebyside" | "compact";
  },
): Omit<StaticToolRowProps, "statusContent"> {
  const isRepoMapHit = extra?.isRepoMapHit ?? false;
  const toolDisplay = resolveToolDisplay(tc.toolName);

  // Detect code execution (node -e, bun -e, python -c, etc.) for distinct UI
  let codeExec: ReturnType<typeof detectCodeExecution> = null;
  if (tc.toolName === "shell" && tc.args) {
    try {
      const parsed = JSON.parse(tc.args);
      if (parsed.command) codeExec = detectCodeExecution(String(parsed.command));
    } catch {}
  }

  const codeExecDisplay = codeExec ? resolveToolDisplay("code_execution") : null;
  const iconVal = isRepoMapHit
    ? (extra?.repoMapIcon ?? "◈")
    : codeExecDisplay
      ? codeExecDisplay.icon
      : toolDisplay.icon;
  const labelVal = isRepoMapHit
    ? "Soul Map"
    : codeExec
      ? codeExec.runtime
      : tc.state !== "running"
        ? (TOOL_LABELS_DONE[tc.toolName] ?? toolDisplay.label)
        : toolDisplay.label;
  const iconColorVal = isRepoMapHit
    ? getThemeTokens().info
    : codeExecDisplay
      ? codeExecDisplay.iconColor
      : toolDisplay.iconColor;
  const toolCategory = isRepoMapHit
    ? ("soul-map" as ToolCategory)
    : codeExecDisplay
      ? (codeExecDisplay.category as ToolCategory)
      : toolDisplay.category;

  // Backend from result or prop
  let backend: string | null = null;
  if (!isRepoMapHit) {
    if (tc.result) {
      try {
        const parsed = JSON.parse(tc.result);
        if (typeof parsed.backend === "string") backend = parsed.backend;
      } catch {}
    }
    if (!backend) backend = tc.backend ?? null;
  }

  let { category, categoryColor, backendTag, backendColor } = resolveBackendCategory(
    toolCategory,
    backend,
  );

  const isDone = tc.state !== "running";

  // ast_edit: fold label into category bracket ([morphing]/[morphed] <path>)
  let labelOverride: string | null = null;
  if (tc.toolName === "ast_edit") {
    category = isDone ? "morphed" : "morphing";
    labelOverride = "";
  }
  const argStr = formatArgs(tc.toolName, tc.args);
  const outsideKind = detectOutsideCwd(tc.toolName, tc.args);
  const isEdit = EDIT_TOOL_NAMES.has(tc.toolName);

  const editResultText =
    isDone && isEdit && tc.result ? formatResult(tc.toolName, tc.result) : undefined;

  // Diff extraction
  let diff: StaticToolRowProps["diff"] = null;
  if (tc.toolName === "edit_file" && isDone && tc.args) {
    try {
      const parsedArgs = JSON.parse(tc.args);
      let parsedResult: { success: boolean; output?: string; error?: string } | null = null;
      if (tc.result) {
        try {
          parsedResult = JSON.parse(tc.result);
        } catch {}
      }
      diff = extractEditDiff(tc.toolName, parsedArgs, parsedResult);
    } catch {}
  }

  // Suffix
  let suffix = extra?.suffix;
  let suffixColor = extra?.suffixColor;
  if (!suffix && isDone && !isEdit && !diff) {
    const computed = computeSuffix(tc.toolName, tc.result, null, isEdit, !!editResultText);
    suffix = computed.suffix;
    suffixColor = suffixColor ?? computed.suffixColor;
    if (!suffix && tc.result) {
      const r = formatResult(tc.toolName, tc.result);
      if (r) suffix = ` → ${r}`;
    }
  }

  return {
    isDone,
    icon: iconVal,
    iconColor: iconColorVal,
    label: labelOverride ?? labelVal,
    category,
    categoryColor,
    backendTag,
    backendColor,
    outsideBadge: outsideKind ? OUTSIDE_BADGE[outsideKind] : null,
    argStr: argStr || undefined,
    editResultText,
    suffix,
    suffixColor,
    diff,
    diffStyle: extra?.diffStyle,
    imageArt: tc.imageArt,
  };
}

/** Build props from a completed ToolCall (final/MessageList path) */
export function buildFinalToolRowProps(tc: {
  name: string;
  args: Record<string, unknown>;
  result?: {
    success: boolean;
    output: string;
    error?: string;
    backend?: string;
  };
  imageArt?: Array<{
    name: string;
    lines: string[];
    kittyImageId?: number;
    kittyCols?: number;
    kittyRows?: number;
  }>;
}): StaticToolRowProps {
  const toolDisplay = resolveToolDisplay(tc.name);
  const argsJson = JSON.stringify(tc.args);
  const resultJson = tc.result ? JSON.stringify(tc.result) : undefined;

  // Detect code execution for completed shell calls
  let finalCodeExec: ReturnType<typeof detectCodeExecution> = null;
  if (tc.name === "shell" && typeof tc.args.command === "string") {
    finalCodeExec = detectCodeExecution(tc.args.command);
  }
  const finalCodeDisplay = finalCodeExec ? resolveToolDisplay("code_execution") : null;
  if (finalCodeDisplay && finalCodeExec) {
    toolDisplay.icon = finalCodeDisplay.icon;
    toolDisplay.iconColor = finalCodeDisplay.iconColor;
    toolDisplay.label = finalCodeExec.runtime;
    toolDisplay.category = finalCodeDisplay.category;
  }

  const argStr = formatArgs(tc.name, argsJson);
  const outsideKind = detectOutsideCwd(tc.name, argsJson);
  const isEdit = EDIT_TOOL_NAMES.has(tc.name);

  let { category, categoryColor, backendTag, backendColor } = resolveBackendCategory(
    toolDisplay.category,
    tc.result?.backend ?? null,
  );

  // ast_edit: fold label into category bracket ([morphed] <path>)
  let labelOverride: string | null = null;
  if (tc.name === "ast_edit") {
    category = "morphed";
    labelOverride = "";
  }

  // Status
  const denied =
    !tc.result?.success &&
    !!(tc.result?.error && /denied|rejected|cancelled/i.test(tc.result.error));
  const statusIcon = tc.result
    ? tc.result.success
      ? getIcon("success")
      : denied
        ? getIcon("skip")
        : getIcon("fail")
    : "●";
  const _t = getThemeTokens();
  const statusColor = tc.result
    ? tc.result.success
      ? _t.success
      : denied
        ? _t.textSecondary
        : _t.error
    : _t.textSecondary;

  // Edit result text
  const editResultText =
    isEdit && tc.result?.success && resultJson ? formatResult(tc.name, resultJson) : undefined;

  // Suffix
  const { suffix, suffixColor } = computeSuffix(
    tc.name,
    resultJson,
    tc.result ?? null,
    isEdit,
    !!editResultText,
  );

  // Diff
  const diff = tc.result ? extractEditDiff(tc.name, tc.args, tc.result) : null;

  return {
    statusContent: <span fg={statusColor}>{statusIcon} </span>,
    isDone: true,
    icon: toolDisplay.icon,
    iconColor: toolDisplay.iconColor,
    label: labelOverride ?? TOOL_LABELS_DONE[tc.name] ?? toolDisplay.label,
    category,
    categoryColor,
    backendTag,
    backendColor,
    outsideBadge: outsideKind ? OUTSIDE_BADGE[outsideKind] : null,
    argStr: argStr || undefined,
    editResultText,
    suffix,
    suffixColor,
    diff,
    imageArt: tc.imageArt,
  };
}
