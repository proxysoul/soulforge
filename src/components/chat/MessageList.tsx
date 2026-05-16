import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TextAttributes } from "@opentui/core";
import {
  createContext,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { icon as getIcon, icon } from "../../core/icons.js";
import type { ImageArt } from "../../core/terminal/image.js";
import { renderImageFromData } from "../../core/terminal/image.js";
import { getThemeTokens, type ThemeTokens, useTheme } from "../../core/theme/index.js";
import { resolveToolDisplay, TOOL_ICONS, TOOL_LABELS } from "../../core/tool-display.js";
import { formatElapsed } from "../../hooks/useElapsed.js";
import type {
  ChatMessage,
  ChatStyle,
  ImageAttachment,
  MessageSegment,
  ToolCall,
} from "../../types/index.js";
import { parsePlanOutput } from "../../types/plan-schema.js";
import { buildPrefix, buildTree, flattenTree } from "../layout/ChangedFiles.js";
import { Spinner } from "../layout/shared.js";
import { StructuredPlanView } from "../plan/StructuredPlanView.js";
import { DiffView } from "./DiffView.js";
import { ImageDisplay } from "./ImageDisplay.js";
import { filterQuietTools, LOCKIN_EDIT_TOOLS, LockInWrapper } from "./LockInStreamView.js";
import { Markdown, useCodeExpanded } from "./Markdown.js";
import { ReasoningBlock } from "./ReasoningBlock.js";
import { buildFinalToolRowProps, StaticToolRow } from "./StaticToolRow.js";
import { SUBAGENT_NAMES, TREE_PIPE, TREE_SPACE, type TreePosition } from "./ToolCallDisplay.js";
import { extractMultiReadFiles, formatArgs } from "./tool-formatters.js";

const ReasoningExpandedContext = createContext(false);
export const ReasoningExpandedProvider = ReasoningExpandedContext.Provider;
function useReasoningExpanded(): boolean {
  return useContext(ReasoningExpandedContext);
}

const REVEAL_INTERVAL = 45;
const MAX_REVEAL_STEPS = 8;
const CURSOR_CHAR = "\u2588"; // █

export const RAIL_BORDER = {
  topLeft: "▌",
  topRight: "▌",
  bottomLeft: "▌",
  bottomRight: "▌",
  horizontal: "▌",
  vertical: "▌",
  topT: "▌",
  bottomT: "▌",
  leftT: "▌",
  rightT: "▌",
  cross: "▌",
};
interface Props {
  messages: ChatMessage[];
  chatStyle: ChatStyle;
  diffStyle?: "default" | "sidebyside" | "compact";
  collapseDiffs?: boolean;
  showReasoning?: boolean;
  reasoningExpanded?: boolean;
  lockIn?: boolean;
  verbose?: boolean;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", {
    hour12: true,
    hour: "numeric",
    minute: "2-digit",
  });
}

function cleanErrorDetail(msg: string): string {
  let cleaned = msg.replace(/\[([^\]]+)\]\([^)]+\)/g, "");
  cleaned = cleaned.replace(/https?:\/\/\S+/g, "");
  cleaned = cleaned.replace(/For details,?\s*refer to:?\s*/gi, "");
  cleaned = cleaned.replace(/You can see the response headers[^.]*\.\s*/g, "");
  cleaned = cleaned.replace(/You may also contact sales[^.]*\.\s*/g, "");
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  cleaned = cleaned.replace(/[\s.]+$/, "");
  return cleaned;
}

function extractErrorCode(raw: string): string | null {
  const statusMatch = raw.match(/\b(4\d{2}|5\d{2})\b/);
  if (statusMatch?.[1]) return statusMatch[1];
  const typeMatch = raw.match(/"type"\s*:\s*"([^"]+)"/);
  if (typeMatch?.[1]) return typeMatch[1];
  const codeMatch = raw.match(/\b(ECONNREFUSED|ETIMEDOUT|INTERNAL_ERROR)\b/);
  if (codeMatch?.[1]) return codeMatch[1];
  return null;
}

function categorizeError(msg: string): {
  category: string;
  flavor: string;
  code: string | null;
  detail: string;
} {
  const raw = msg
    .replace(/^Error:\s*/, "")
    .replace(/^Request failed:\s*/, "")
    .replace(/^Failed[^:]*:\s*/, "");
  const code = extractErrorCode(raw);
  if (/rate.?limit|too many requests|429|529/i.test(raw))
    return {
      category: "Rate Limited",
      flavor: "The furnace is too hot — cooling down",
      code,
      detail: cleanErrorDetail(raw),
    };
  if (/overloaded|503|capacity/i.test(raw))
    return {
      category: "Overloaded",
      flavor: "The anvil cracked under pressure",
      code,
      detail: cleanErrorDetail(raw),
    };
  if (/unauthorized|401|403|api.?key|invalid.*key/i.test(raw))
    return {
      category: "Auth Error",
      flavor: "The guild rejected our credentials",
      code,
      detail: cleanErrorDetail(raw),
    };
  if (/not permitted|not supported|invalid parameter|unknown parameter/i.test(raw))
    return {
      category: "Config Error",
      flavor: "Wrong rune inscribed on the blade",
      code,
      detail: cleanErrorDetail(raw),
    };
  if (/network|ECONNREFUSED|ETIMEDOUT|fetch failed|502/i.test(raw))
    return {
      category: "Network Error",
      flavor: "The courier pigeon never arrived",
      code,
      detail: cleanErrorDetail(raw),
    };
  if (/stream error|INTERNAL_ERROR|api_error/i.test(raw))
    return {
      category: "Stream Error",
      flavor: "The forge bellows burst mid-swing",
      code,
      detail: cleanErrorDetail(raw),
    };
  return {
    category: "Error",
    flavor: "Something broke in the workshop",
    code,
    detail: cleanErrorDetail(raw),
  };
}

function parseRetry(text: string): { attempt: string; reason: string; delay: string } | null {
  const match = text.match(/^Retry (\d+\/\d+): (.+?) \[delay:(\d+)s\]$/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { attempt: match[1], reason: match[2], delay: match[3] };
}

function SystemMessage({ msg, animate = true }: { msg: ChatMessage; animate?: boolean }) {
  const t = useTheme();
  const time = formatTime(msg.timestamp);
  const text = msg.content;
  const isError =
    text.startsWith("Error:") || text.startsWith("Request failed:") || text.startsWith("Failed");
  const retry = parseRetry(text);
  const isInterrupt = text === "Generation interrupted.";

  const errorInfo = isError ? categorizeError(text) : null;
  const retryInfo = retry ? categorizeError(retry.reason) : null;

  const displayText = isError
    ? (errorInfo?.detail ?? text)
    : retry
      ? `${retryInfo?.category.toLowerCase() ?? "error"} — waiting ~${retry.delay}s`
      : text;

  const railColor = isError ? t.error : retry ? t.warning : t.textMuted;
  const textColor = isError ? t.textSecondary : t.textSecondary;

  const chunkSize = Math.max(1, Math.ceil(displayText.length / MAX_REVEAL_STEPS));
  const totalSteps = Math.ceil(displayText.length / chunkSize);
  const [step, setStep] = useState(animate ? 0 : totalSteps);
  const [done, setDone] = useState(!animate);

  useEffect(() => {
    if (done) return;
    if (step >= totalSteps) {
      setDone(true);
      return;
    }
    const timer = setTimeout(() => setStep((s) => s + 1), REVEAL_INTERVAL);
    return () => clearTimeout(timer);
  }, [step, totalSteps, done]);

  const visibleText = done ? displayText : displayText.slice(0, step * chunkSize);
  const lines = visibleText.split("\n");

  const headerLabel = isError
    ? (errorInfo?.category ?? "Error")
    : retry
      ? `Retry ${retry.attempt}`
      : isInterrupt
        ? "Interrupted"
        : "System";
  const flavorText = isError
    ? (errorInfo?.flavor ?? null)
    : retry
      ? (retryInfo?.flavor ?? null)
      : null;
  const headerIcon = isError ? "✗" : retry ? "↻" : isInterrupt ? "⊘" : "›";

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      border={["left"]}
      borderColor={railColor}
      customBorderChars={RAIL_BORDER}
      paddingLeft={2}
      paddingRight={1}
      paddingY={1}
    >
      <box flexDirection="row">
        {isError ? (
          <text fg={t.error} attributes={TextAttributes.BOLD}>
            {headerIcon} {headerLabel}
          </text>
        ) : retry ? (
          <text fg={t.warning} attributes={TextAttributes.BOLD}>
            {headerIcon} {headerLabel}
          </text>
        ) : (
          <text fg={t.textMuted}>
            {headerIcon ? `${headerIcon} ` : ""}
            {headerLabel}
          </text>
        )}
        {errorInfo?.code ? <text fg={t.textDim}> [{errorInfo.code}]</text> : null}
        {flavorText ? <text fg={t.textMuted}> — {flavorText}</text> : null}
        <text fg={t.textDim}> · {time}</text>
      </box>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable line order
        <text key={i} fg={textColor}>
          {line}
        </text>
      ))}
      {!done && <text fg={railColor}>{CURSOR_CHAR}</text>}
    </box>
  );
}

import { EDIT_NAMES, groupToolCalls } from "./tool-grouping.js";

function isFailedEditCall(tc: ToolCall): boolean {
  return EDIT_NAMES.has(tc.name) && !!tc.result && !tc.result.success;
}

function extractPathFromArgs(args?: Record<string, unknown>): string | null {
  if (!args || typeof args.path !== "string") return null;
  return args.path;
}

function isDenied(error?: string): boolean {
  return !!error && /denied|rejected|cancelled/i.test(error);
}

function ToolCallRow({
  tc,
  diffStyle,
  collapseDiffs = false,
  connectorChar,
  treePosition,
}: {
  tc: ToolCall;
  diffStyle?: "default" | "sidebyside" | "compact";
  collapseDiffs?: boolean;
  connectorChar?: string;
  treePosition?: TreePosition;
}) {
  const t = useTheme();
  const expanded = useCodeExpanded();
  const errorsExpanded = useReasoningExpanded();
  const props = buildFinalToolRowProps(tc);

  // For edit tools, collapse to compact by default, expanded on Ctrl+O
  const effectiveDiffStyle = props.diff
    ? expanded || !collapseDiffs
      ? diffStyle
      : "compact"
    : diffStyle;
  if (props.diff) {
    props.diffStyle = effectiveDiffStyle;
  }

  // Prepend tree connector to status content
  if (connectorChar) {
    const origStatus = props.statusContent;
    props.statusContent = (
      <>
        <span fg={t.textFaint}>{connectorChar}</span>
        {origStatus}
      </>
    );
  }

  const inTree = !!treePosition;
  const hasExpandedContent =
    inTree && (!!props.diff || (props.imageArt && props.imageArt.length > 0));

  // Expanded error detail (2-line view)
  const fullError = tc.result?.error ?? "";
  const isError = !!tc.result && !tc.result.success && !isDenied(tc.result?.error);
  const showErrorDetail = isError && errorsExpanded && fullError.length > 0;

  const errorContent = showErrorDetail
    ? (() => {
        const errorPreview = fullError.length > 120 ? `${fullError.slice(0, 117)}…` : fullError;
        const hasMore = fullError.length > 120;
        return (
          <box paddingLeft={3} height={1} flexShrink={0}>
            <text truncate fg={t.error}>
              {errorPreview}
              {hasMore ? <span fg={t.textMuted}> /errors for full</span> : null}
            </text>
          </box>
        );
      })()
    : null;

  // Build expanded content for tree continuation
  const diffContent =
    hasExpandedContent && props.diff ? (
      <box marginTop={1} flexDirection="column">
        <DiffView
          filePath={props.diff.path}
          oldString={props.diff.oldString}
          newString={props.diff.newString}
          success={props.diff.success}
          errorMessage={props.diff.errorMessage}
          mode={effectiveDiffStyle}
        />
        {props.diff.impact ? (
          <text fg={t.textMuted}>
            {"  "}
            <span fg={t.amber}>{getIcon("impact")}</span>
            <span fg={t.textSecondary}> {props.diff.impact}</span>
          </text>
        ) : null}
      </box>
    ) : null;

  const imageContent =
    hasExpandedContent && props.imageArt && props.imageArt.length > 0
      ? props.imageArt.map((img) => (
          <box key={img.name} flexDirection="column">
            <ImageDisplay img={img} />
          </box>
        ))
      : null;

  // Multi-file read tree (2+ files in a single read call)
  const multiReadFiles = extractMultiReadFiles(tc.name, tc.args);
  const multiReadContent =
    multiReadFiles && multiReadFiles.length >= 2
      ? (() => {
          const cwd = process.cwd();
          const detailMap = new Map(multiReadFiles.map((f) => [f.path, f.detail]));
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

  const needsContinuation =
    diffContent || imageContent || multiReadContent || (inTree && errorContent);

  if (needsContinuation) {
    return (
      <box flexDirection="column" flexShrink={0}>
        <StaticToolRow {...props} suppressExpanded />
        <box
          border={["left"]}
          customBorderChars={!inTree || treePosition?.isLast ? TREE_SPACE : TREE_PIPE}
          borderColor={t.textFaint}
          paddingLeft={1}
        >
          <box flexDirection="column">
            {diffContent}
            {imageContent}
            {multiReadContent}
            {errorContent}
          </box>
        </box>
      </box>
    );
  }

  if (showErrorDetail) {
    return (
      <box flexDirection="column" flexShrink={0}>
        <StaticToolRow {...props} />
        {errorContent}
      </box>
    );
  }

  if (multiReadContent) {
    return (
      <box flexDirection="column" flexShrink={0}>
        <StaticToolRow {...props} />
        <box paddingLeft={3}>{multiReadContent}</box>
      </box>
    );
  }

  return <StaticToolRow {...props} />;
}

function CollapsedToolGroup({
  calls,
  connectorChar,
}: {
  calls: ToolCall[];
  connectorChar?: string;
}) {
  const t = useTheme();
  const count = calls.length;
  const allOk = calls.every((tc) => tc.result?.success);
  return (
    <box height={1} flexShrink={0}>
      <text truncate>
        {connectorChar ? <span fg={t.textFaint}>{connectorChar}</span> : null}
        <span fg={allOk ? t.success : t.error}>{allOk ? "✓" : "✗"} </span>
        <span fg={t.textSecondary}>
          {String(count)} tool call{count > 1 ? "s" : ""} (
          {calls.map((tc) => TOOL_LABELS[tc.name] ?? tc.name).join(", ")})
        </span>
      </text>
    </box>
  );
}

function parsePlanFromArgs(tc: ToolCall) {
  if (tc.name !== "write_plan" && tc.name !== "plan") return null;
  return parsePlanOutput(tc.args);
}

function parsePlanResult(tc: ToolCall): { file?: string; resultStr?: string } {
  if (!tc.result?.output) return {};
  try {
    const parsed: Record<string, unknown> = JSON.parse(tc.result.output);
    return {
      file: typeof parsed.file === "string" ? parsed.file : undefined,
      resultStr: typeof parsed.output === "string" ? parsed.output : tc.result.output,
    };
  } catch {
    return { resultStr: tc.result.output };
  }
}

function WritePlanCall({
  tc,
  connectorChar,
  treePosition,
}: {
  tc: ToolCall;
  connectorChar?: string;
  treePosition?: TreePosition;
}) {
  const t = useTheme();
  const plan = parsePlanFromArgs(tc);
  const expanded = useCodeExpanded();
  const { file: planFile, resultStr } = parsePlanResult(tc);
  const [markdown, setMarkdown] = useState<string | null>(null);
  useEffect(() => {
    if (!planFile) return;
    readFile(join(process.cwd(), planFile), "utf-8")
      .then(setMarkdown)
      .catch(() => setMarkdown(null));
  }, [planFile]);
  if (!plan)
    return <ToolCallRow tc={tc} connectorChar={connectorChar} treePosition={treePosition} />;

  // Collapse accepted plans by default — Ctrl+O toggles expanded
  const hasResult = !!resultStr;
  const collapsed = hasResult && !expanded;

  const planContent = (
    <>
      <StructuredPlanView
        plan={plan}
        result={resultStr}
        planFile={planFile}
        collapsed={collapsed}
      />
      {!collapsed && markdown && !resultStr?.includes("cancelled") && (
        <box
          flexDirection="column"
          flexShrink={0}
          border
          borderStyle="rounded"
          borderColor={t.border}
          marginTop={1}
          paddingX={1}
        >
          <Markdown text={markdown} />
        </box>
      )}
    </>
  );

  if (connectorChar && treePosition) {
    return (
      <box flexDirection="column">
        <box height={1} flexShrink={0}>
          <text>
            <span fg={t.textFaint}>{connectorChar}</span>
          </text>
        </box>
        <box
          border={["left"]}
          customBorderChars={treePosition.isLast ? TREE_SPACE : TREE_PIPE}
          borderColor={t.textFaint}
          paddingLeft={1}
        >
          <box flexDirection="column">{planContent}</box>
        </box>
      </box>
    );
  }

  return planContent;
}

const TRUNCATE_THRESHOLD = 10;
const TRUNCATE_HEAD = 4;
const TRUNCATE_TAIL = 4;

function truncateUserContent(content: string, expanded: boolean, t: ThemeTokens): ReactNode {
  const lines = content.split("\n");
  if (expanded || lines.length <= TRUNCATE_THRESHOLD) {
    return <text>{content}</text>;
  }
  const head = lines.slice(0, TRUNCATE_HEAD).join("\n");
  const tail = lines.slice(-TRUNCATE_TAIL).join("\n");
  const hidden = lines.length - TRUNCATE_HEAD - TRUNCATE_TAIL;
  return (
    <box flexDirection="column">
      <text>{head}</text>
      <text fg={t.textMuted}>
        {"// <+"}
        {String(hidden)}
        {" lines> //"}
      </text>
      <text>{tail}</text>
    </box>
  );
}

function isPlanExecution(content: string): boolean {
  return content.startsWith("Execute this plan.");
}

function parsePlanTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1] ?? "Plan";
}

/** Renders pasted image attachments inline using soul_vision's rendering pipeline. */
function UserImageAttachments({ images }: { images: ImageAttachment[] }) {
  const [arts, setArts] = useState<ImageArt[]>([]);

  useEffect(() => {
    let cancelled = false;
    const render = async () => {
      const results: ImageArt[] = [];
      for (const img of images) {
        const buf = Buffer.from(img.base64, "base64");
        const art = await renderImageFromData(buf, img.label, { cols: 60 });
        if (cancelled) return;
        if (art) results.push(art);
      }
      if (!cancelled) setArts(results);
    };
    render();
    return () => {
      cancelled = true;
    };
  }, [images]);

  if (arts.length === 0) return null;
  return (
    <box flexDirection="column">
      {arts.map((art) => (
        <box key={art.name} flexDirection="column">
          <ImageDisplay img={art} />
        </box>
      ))}
    </box>
  );
}

const UserMessageAccent = memo(function UserMessageAccent({ msg }: { msg: ChatMessage }) {
  const t = useTheme();
  const time = formatTime(msg.timestamp);
  const expanded = useReasoningExpanded();
  const isPlan = isPlanExecution(msg.content);
  const borderColor = t.accentUser;

  if (isPlan && !expanded) {
    const title = parsePlanTitle(msg.content);
    const lineCount = msg.content.split("\n").length;
    return (
      <box
        flexDirection="column"
        marginBottom={1}
        border={["left"]}
        borderColor={borderColor}
        customBorderChars={RAIL_BORDER}
        paddingLeft={2}
        paddingRight={1}
        paddingY={1}
        backgroundColor={t.bgUser}
      >
        <box flexDirection="row">
          <text fg={borderColor} attributes={TextAttributes.BOLD}>
            You
          </text>
          <text fg={t.textDim}> · {time}</text>
        </box>
        <box height={1}>
          <text truncate>
            <span fg={t.info}>{TOOL_ICONS.plan} </span>
            <span fg={t.textPrimary}>Execute plan: {title}</span>
            <span fg={t.textMuted}> ({String(lineCount)} lines)</span>
            <span fg={t.textFaint}> ^O</span>
          </text>
        </box>
      </box>
    );
  }

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      border={["left"]}
      borderColor={borderColor}
      customBorderChars={RAIL_BORDER}
      paddingLeft={2}
      paddingRight={1}
      paddingY={1}
      backgroundColor={t.bgUser}
    >
      <box flexDirection="row">
        <text fg={borderColor} attributes={TextAttributes.BOLD}>
          You
        </text>
        <text fg={t.textDim}> · {time}</text>
        {msg.isSteering && <text fg={t.warning}> · steering</text>}
        {msg.origin && msg.origin !== "local" && <text fg={t.info}> · {msg.origin}</text>}
        {msg.images && msg.images.length > 0 && (
          <text fg={t.info}>
            {" "}
            · {icon("image")} {String(msg.images.length)} image{msg.images.length > 1 ? "s" : ""}
          </text>
        )}
      </box>
      {truncateUserContent(
        msg.images ? msg.content.replace(/\[image-\d+\]\s*/g, "").trim() : msg.content,
        expanded,
        t,
      )}
      {msg.images && msg.images.length > 0 && <UserImageAttachments images={msg.images} />}
    </box>
  );
});

const UserMessageBubble = memo(function UserMessageBubble({ msg }: { msg: ChatMessage }) {
  const t = useTheme();
  const time = formatTime(msg.timestamp);
  const expanded = useReasoningExpanded();

  return (
    <box flexDirection="column" alignItems="flex-end" marginBottom={1}>
      <box
        borderStyle="rounded"
        border={true}
        borderColor={t.accentUser}
        paddingX={2}
        paddingY={1}
        backgroundColor={t.bgUser}
      >
        {truncateUserContent(
          msg.images ? msg.content.replace(/\[image-\d+\]\s*/g, "").trim() : msg.content,
          expanded,
          t,
        )}
        {msg.images && msg.images.length > 0 && <UserImageAttachments images={msg.images} />}
      </box>
      <text fg={t.textMuted}>
        {" "}
        You · {time}
        {msg.images && msg.images.length > 0 && (
          <span fg={t.info}>
            {" "}
            · {icon("image")} {String(msg.images.length)} image{msg.images.length > 1 ? "s" : ""}
          </span>
        )}
      </text>
    </box>
  );
});

function renderSegments(
  segments: MessageSegment[],
  toolCallMap: Map<string, ToolCall>,
  diffStyle: "default" | "sidebyside" | "compact" = "default",
  collapseDiffs = false,
  showReasoning = true,
  reasoningExpanded = false,
  t: ThemeTokens = getThemeTokens(),
  lockIn = false,
  verbose = false,
) {
  // Merge consecutive tool segments (skip empty text between) so they share one tree
  const merged: MessageSegment[] = [];
  for (const seg of segments) {
    if (seg.type === "text" && seg.content.trim() === "") continue;
    const prev = merged[merged.length - 1];
    if (seg.type === "tools" && prev?.type === "tools") {
      prev.toolCallIds.push(...seg.toolCallIds);
    } else {
      merged.push(seg.type === "tools" ? { ...seg, toolCallIds: [...seg.toolCallIds] } : seg);
    }
  }

  let firstToolsIdx = -1;
  for (let k = 0; k < merged.length; k++) {
    if (merged[k]?.type === "tools") {
      firstToolsIdx = k;
      break;
    }
  }

  let lastVisibleType: string | null = null;
  return merged.map((seg, i) => {
    if (seg.type === "reasoning" && !showReasoning) return null;

    const needsGap = lastVisibleType !== null && lastVisibleType !== seg.type;

    if (seg.type === "text") {
      const isLastSegment = i === merged.length - 1;
      const hasToolsBefore = firstToolsIdx >= 0 && firstToolsIdx < i;
      const isFinalAnswer = isLastSegment && hasToolsBefore && seg.content.trim().length > 20;
      // Lock-in mode: hide ALL text (tools-only view). Final answer rendered separately by caller.
      // Don't suppress text-only messages (no tools = normal conversation)
      if (lockIn && firstToolsIdx >= 0) return null;
      lastVisibleType = seg.type;
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable segment order
        <box key={`text-${i}`} flexDirection="column" marginTop={needsGap ? 1 : 0}>
          {isFinalAnswer && (
            <box height={1} flexShrink={0} marginBottom={1}>
              <text fg={t.textFaint} truncate>
                {"─".repeat(60)}
              </text>
            </box>
          )}
          <Markdown text={seg.content} />
        </box>
      );
    }
    if (seg.type === "reasoning") {
      lastVisibleType = seg.type;
      const rkey = `${seg.id}-${reasoningExpanded ? "exp" : "col"}`;
      return (
        <box key={rkey} flexDirection="column" marginTop={needsGap ? 1 : 0}>
          <ReasoningBlock content={seg.content} expanded={reasoningExpanded} id={seg.id} />
        </box>
      );
    }
    if (seg.type === "plan") {
      lastVisibleType = seg.type;
      const doneSteps = seg.plan.steps.filter((s) => s.status === "done").length;
      const totalSteps = seg.plan.steps.length;
      const allDone = doneSteps === totalSteps;
      const planKey = `plan-${seg.plan.title.slice(0, 20)}-${String(seg.plan.createdAt)}`;
      return (
        <box
          key={planKey}
          flexDirection="column"
          flexShrink={0}
          marginTop={needsGap ? 1 : 0}
          border={["left"]}
          borderStyle="heavy"
          borderColor={allDone ? t.success : t.info}
          paddingLeft={1}
        >
          <text truncate>
            <span fg={allDone ? t.success : t.info}>{TOOL_ICONS.plan} </span>
            <span fg={t.textPrimary} attributes={TextAttributes.BOLD}>
              {seg.plan.title}{" "}
            </span>
            <span fg={t.textMuted}>
              {String(doneSteps)}/{String(totalSteps)}
            </span>
          </text>
          {seg.plan.steps.map((step) => {
            const isDone = step.status === "done";
            const isActive = step.status === "active";
            const isSkipped = step.status === "skipped";
            const stepColor = isDone
              ? t.success
              : isActive
                ? t.brand
                : isSkipped
                  ? t.textDim
                  : t.textMuted;
            const stepTextColor = isDone ? t.textSecondary : isActive ? t.textPrimary : t.textMuted;
            return (
              <box key={step.id} height={1} flexShrink={0}>
                <text truncate>
                  {isActive ? (
                    <>
                      <Spinner inline />
                      <span> </span>
                    </>
                  ) : (
                    <span fg={stepColor}>{isDone ? "✓" : isSkipped ? "⊘" : "○"} </span>
                  )}
                  <span fg={stepTextColor} attributes={isActive ? TextAttributes.BOLD : undefined}>
                    {step.label}
                  </span>
                </text>
              </box>
            );
          })}
        </box>
      );
    }
    const allCalls = seg.toolCallIds
      .map((id: string) => toolCallMap.get(id))
      .filter(Boolean) as ToolCall[];
    if (allCalls.length === 0) return null;

    // Separate code_execution children from top-level calls
    const childMap = new Map<string, ToolCall[]>();
    const topLevel: ToolCall[] = [];
    for (const tc of allCalls) {
      if (tc.parentId) {
        const children = childMap.get(tc.parentId) ?? [];
        children.push(tc);
        childMap.set(tc.parentId, children);
      } else {
        topLevel.push(tc);
      }
    }
    // Also collect children not in this segment (they may have been excluded from segments)
    for (const [, tc] of toolCallMap) {
      if (tc.parentId && !childMap.get(tc.parentId)?.includes(tc)) {
        const parentInSegment = topLevel.some((t) => t.id === tc.parentId);
        if (parentInSegment) {
          const children = childMap.get(tc.parentId) ?? [];
          children.push(tc);
          childMap.set(tc.parentId, children);
        }
      }
    }

    // Hide failed edits that were retried on the same file
    const calls = topLevel.filter((tc, idx) => {
      if (tc.name === "update_plan_step") return false;
      if (tc.name === "task_list" && !verbose) return false;
      if (!isFailedEditCall(tc)) return true;
      const path = extractPathFromArgs(tc.args);
      if (!path) return true;
      for (let j = idx + 1; j < topLevel.length; j++) {
        const later = topLevel[j];
        if (later && EDIT_NAMES.has(later.name) && extractPathFromArgs(later.args) === path)
          return false;
      }
      return true;
    });
    if (calls.length === 0) return null;
    lastVisibleType = seg.type;

    const groups = groupToolCalls(calls);

    // Count total visible group items for tree connector logic
    const totalItems = groups.length;
    const useTree = totalItems >= 2;

    const toolsKey = `tools-${seg.toolCallIds[0] ?? String(i)}`;
    return (
      <box key={toolsKey} flexDirection="column" marginTop={needsGap ? 1 : 0}>
        {groups.map((g, gi) => {
          const treePos: TreePosition | undefined = useTree
            ? { isFirst: gi === 0, isLast: gi === totalItems - 1 }
            : undefined;
          const connChar = treePos
            ? treePos.isLast
              ? "└ "
              : treePos.isFirst
                ? "┌ "
                : "├ "
            : undefined;

          if (g.type === "meta") {
            return (
              <CollapsedToolGroup
                key={`meta-${String(gi)}`}
                calls={g.calls}
                connectorChar={connChar}
              />
            );
          }
          if (g.type === "batch") {
            const cwd = process.cwd();
            // Extract all paths from batch calls (edits use args.path, reads use args.files)
            interface BatchFile {
              path: string;
              success: boolean | null;
            }
            const batchFiles: BatchFile[] = [];
            for (const tc of g.calls) {
              const directPath = extractPathFromArgs(tc.args);
              if (directPath) {
                batchFiles.push({
                  path: directPath,
                  success: tc.result ? tc.result.success : null,
                });
              } else if (tc.args && Array.isArray(tc.args.files)) {
                // read tool: args.files is array of {path, ...}
                for (const f of tc.args.files as Array<{ path?: string }>) {
                  if (typeof f.path === "string") {
                    batchFiles.push({
                      path: f.path,
                      success: tc.result ? tc.result.success : null,
                    });
                  }
                }
                // Also handle single-object form: args.files = {path: ...}
                if (
                  !Array.isArray(tc.args.files) &&
                  typeof (tc.args.files as Record<string, unknown>)?.path === "string"
                ) {
                  batchFiles.push({
                    path: String((tc.args.files as Record<string, unknown>).path),
                    success: tc.result ? tc.result.success : null,
                  });
                }
              }
            }

            const ok = batchFiles.filter((f) => f.success === true).length;
            const fail = batchFiles.filter((f) => f.success === false).length;
            const pending = batchFiles.filter((f) => f.success === null).length;
            const allDone = pending === 0;
            const statusIcon = allDone
              ? fail === 0
                ? "✓"
                : fail === g.calls.length
                  ? "✗"
                  : "⚠"
              : "●";
            const statusColor = allDone
              ? fail === 0
                ? t.success
                : fail === g.calls.length
                  ? t.error
                  : t.warning
              : t.textMuted;
            const kindLabel =
              g.kind === "edits" ? "edit_file" : g.kind === "reads" ? "read" : "soul_grep";
            const { icon: batchIcon, iconColor } = resolveToolDisplay(kindLabel);

            // Search batches: no file tree, just the summary line
            if (g.kind === "search") {
              return (
                <box key={`batch-${String(gi)}`} height={1} flexShrink={0}>
                  <text truncate>
                    {connChar ? <span fg={t.textFaint}>{connChar}</span> : null}
                    <span fg={statusColor}>{statusIcon} </span>
                    <span fg={iconColor}>{batchIcon} </span>
                    <span fg={t.textSecondary}>{String(g.calls.length)} searches</span>
                  </text>
                </box>
              );
            }

            // Build nested tree from paths (reads/edits only)
            const treeEntries = batchFiles.map((f) => ({
              path: f.path,
              editCount: 1,
              created: false,
            }));
            const treeRoot = buildTree(treeEntries, cwd);
            const rows = flattenTree(treeRoot, 0, []);

            // Standalone batch (no chaining): flat file list without tree connectors
            if (!useTree) {
              const fileNames = batchFiles.map((f) => {
                const rel = f.path.startsWith(cwd)
                  ? f.path.slice(cwd.length + 1)
                  : f.path.split("/").slice(-2).join("/");
                return rel;
              });
              return (
                <box key={`batch-${String(gi)}`} height={1} flexShrink={0}>
                  <text truncate>
                    <span fg={statusColor}>{statusIcon} </span>
                    <span fg={iconColor}>{batchIcon} </span>
                    <span fg={t.textSecondary}>{fileNames.join(", ")}</span>
                    {fail > 0 && ok > 0 ? (
                      <span fg={t.textMuted}>
                        {" "}
                        ({String(ok)} ok, {String(fail)} failed)
                      </span>
                    ) : null}
                  </text>
                </box>
              );
            }

            return (
              <box key={`batch-${String(gi)}`} flexDirection="column" flexShrink={0}>
                <box height={1} flexShrink={0}>
                  <text truncate>
                    {connChar ? <span fg={t.textFaint}>{connChar}</span> : null}
                    <span fg={statusColor}>{statusIcon} </span>
                    <span fg={iconColor}>{batchIcon} </span>
                    <span fg={t.textSecondary}>{String(batchFiles.length)} files</span>
                    {fail > 0 && ok > 0 ? (
                      <span fg={t.textMuted}>
                        {" "}
                        ({String(ok)} ok, {String(fail)} failed)
                      </span>
                    ) : null}
                  </text>
                </box>
                <box
                  border={["left"]}
                  customBorderChars={treePos?.isLast ? TREE_SPACE : TREE_PIPE}
                  borderColor={t.textFaint}
                  flexDirection="column"
                >
                  {rows.map((row, ri) => {
                    const prefix = buildPrefix(row);
                    if (row.isDir) {
                      return (
                        <box key={`d-${row.name}-${String(ri)}`} paddingLeft={2} height={1}>
                          <text truncate>
                            <span fg={t.textFaint}>{prefix}</span>
                            <span fg={t.textMuted}>{row.name}/</span>
                          </text>
                        </box>
                      );
                    }
                    return (
                      <box key={`f-${row.name}-${String(ri)}`} paddingLeft={2} height={1}>
                        <text truncate>
                          <span fg={t.textFaint}>{prefix}</span>
                          <span fg={t.textSecondary}>{row.name}</span>
                        </text>
                      </box>
                    );
                  })}
                </box>
              </box>
            );
          }
          if (g.type !== "normal") return null;
          const children = childMap.get(g.tc.id);
          return (
            <box key={g.tc.id} flexDirection="column">
              {g.tc.name === "write_plan" || g.tc.name === "plan" ? (
                <WritePlanCall tc={g.tc} connectorChar={connChar} treePosition={treePos} />
              ) : (
                <ToolCallRow
                  tc={g.tc}
                  diffStyle={diffStyle}
                  collapseDiffs={collapseDiffs}
                  connectorChar={connChar}
                  treePosition={treePos}
                />
              )}
              {children && children.length > 0 ? (
                <box
                  border={["left"]}
                  customBorderChars={treePos?.isLast ? TREE_SPACE : TREE_PIPE}
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
                    {children.map((child) => (
                      <ToolCallRow
                        key={child.id}
                        tc={child}
                        diffStyle={diffStyle}
                        collapseDiffs={collapseDiffs}
                      />
                    ))}
                  </box>
                </box>
              ) : null}
            </box>
          );
        })}
      </box>
    );
  });
}

const AssistantMessage = memo(function AssistantMessage({
  msg,
  diffStyle = "default",
  collapseDiffs = false,
  showReasoning = true,
  reasoningExpanded = false,
  lockIn = false,
  verbose = false,
}: {
  msg: ChatMessage;
  diffStyle?: "default" | "sidebyside" | "compact";
  collapseDiffs?: boolean;
  showReasoning?: boolean;
  reasoningExpanded?: boolean;
  lockIn?: boolean;
  verbose?: boolean;
}) {
  const t = useTheme();
  const time = formatTime(msg.timestamp);

  const toolCallMap = useMemo(() => {
    const map = new Map<string, ToolCall>();
    for (const tc of msg.toolCalls ?? []) {
      map.set(tc.id, tc);
    }
    return map;
  }, [msg.toolCalls]);

  const hasSegments = msg.segments && msg.segments.length > 0;
  const hasContent = msg.content.trim().length > 0;
  const hasTools = msg.toolCalls && msg.toolCalls.length > 0;
  const isEmpty = !hasSegments && !hasContent && !hasTools;

  // Lock-in: extract final answer (last text after tools, >20 chars) for separate rendering
  const lockInFinalAnswer = useMemo(() => {
    if (!lockIn || !msg.segments) return null;
    const segs = msg.segments;
    let toolsIdx = -1;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i]?.type === "tools") {
        toolsIdx = i;
        break;
      }
    }
    if (toolsIdx < 0) return null;
    // Walk backwards past trailing reasoning segments — some providers
    // (DeepSeek reasoner, etc.) emit a final reasoning block after the last
    // text. The "final answer" is the last text segment that follows tools.
    for (let i = segs.length - 1; i > toolsIdx; i--) {
      const seg = segs[i];
      if (seg?.type === "text" && seg.content.trim().length > 20) return seg.content;
    }
    return null;
  }, [lockIn, msg.segments]);

  const lockInHasEdits = useMemo(
    () =>
      lockIn && hasTools ? msg.toolCalls?.some((tc) => LOCKIN_EDIT_TOOLS.has(tc.name)) : false,
    [lockIn, hasTools, msg.toolCalls],
  );

  // Stable seed from message id for deterministic silly-message selection
  const lockInSeed = useMemo(() => {
    let h = 0;
    for (let i = 0; i < msg.id.length; i++) h = (h * 31 + msg.id.charCodeAt(i)) | 0;
    return h;
  }, [msg.id]);

  const lockInTools = useMemo(() => {
    if (!lockIn || !hasTools) return [];
    return (msg.toolCalls ?? [])
      .filter((tc) => filterQuietTools(tc.name) && !SUBAGENT_NAMES.has(tc.name))
      .map((tc) => ({
        id: tc.id,
        name: tc.name,
        done: true,
        error: !!tc.result && !tc.result.success,
        argStr: formatArgs(tc.name, JSON.stringify(tc.args)),
      }));
  }, [lockIn, hasTools, msg.toolCalls]);

  const lockInDispatchCalls = useMemo(() => {
    if (!lockIn || !hasTools) return [];
    return (msg.toolCalls ?? []).filter((tc) => SUBAGENT_NAMES.has(tc.name));
  }, [lockIn, hasTools, msg.toolCalls]);

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      border={["left"]}
      borderColor={t.brand}
      customBorderChars={RAIL_BORDER}
      paddingLeft={2}
      paddingY={1}
    >
      <box flexDirection="row">
        <text fg={t.accentAssistant}>
          {icon("ai")} Forge
          {lockIn ? <span fg={t.textMuted}> (locked in)</span> : null}
        </text>
        <text fg={t.textDim}> {time}</text>
      </box>

      {isEmpty ? (
        <text fg={t.textMuted} attributes={TextAttributes.ITALIC}>
          Empty response — model returned no content.
        </text>
      ) : lockIn && hasTools ? (
        <>
          <LockInWrapper
            hasEdits={!!lockInHasEdits}
            hasDispatch={lockInDispatchCalls.length > 0}
            done
            seed={lockInSeed}
            tools={lockInTools}
          >
            {lockInDispatchCalls.length > 0
              ? lockInDispatchCalls.map((tc) => (
                  <ToolCallRow key={tc.id} tc={tc} diffStyle="compact" collapseDiffs />
                ))
              : null}
          </LockInWrapper>
          {lockInFinalAnswer ? (
            <box flexDirection="column" marginTop={1}>
              <box height={1} flexShrink={0} marginBottom={1}>
                <text fg={t.textFaint} truncate>
                  {"─".repeat(60)}
                </text>
              </box>
              <Markdown text={lockInFinalAnswer} />
            </box>
          ) : null}
        </>
      ) : hasSegments ? (
        renderSegments(
          msg.segments as MessageSegment[],
          toolCallMap,
          diffStyle,
          collapseDiffs,
          showReasoning,
          reasoningExpanded,
          t,
          lockIn,
          verbose,
        )
      ) : (
        <>
          {hasContent ? <Markdown text={msg.content} /> : null}
          {hasTools ? (
            <box flexDirection="column">
              {msg.toolCalls
                ?.filter(
                  (tc) => tc.name !== "update_plan_step" && (verbose || tc.name !== "task_list"),
                )
                .map((tc) => (
                  <box key={tc.id} flexDirection="column">
                    <ToolCallRow tc={tc} diffStyle={diffStyle} collapseDiffs={collapseDiffs} />
                  </box>
                ))}
            </box>
          ) : null}
        </>
      )}
      {msg.durationMs != null ? (
        <box height={1} marginTop={1}>
          <text fg={t.textFaint}>
            {"✓ Completed in "}
            {formatElapsed(Math.floor(msg.durationMs / 1000))}
          </text>
        </box>
      ) : null}
    </box>
  );
});

/**
 * Custom equality so historical messages short-circuit completely.
 *
 * Finalized messages have a stable object reference (zustand replaces the
 * array but not individual settled entries). Comparing primitives + the msg
 * pointer skips the entire subtree on parent rerenders. The tool-call count
 * is checked as a defensive fallback for streaming messages whose ref stays
 * stable while toolCalls mutate.
 */
function staticMessagePropsEqual(prev: StaticMessageProps, next: StaticMessageProps): boolean {
  if (prev.msg !== next.msg) return false;
  if (prev.chatStyle !== next.chatStyle) return false;
  if (prev.diffStyle !== next.diffStyle) return false;
  if (prev.collapseDiffs !== next.collapseDiffs) return false;
  if (prev.showReasoning !== next.showReasoning) return false;
  if (prev.reasoningExpanded !== next.reasoningExpanded) return false;
  if (prev.animate !== next.animate) return false;
  if (prev.lockIn !== next.lockIn) return false;
  if (prev.dimmed !== next.dimmed) return false;
  if (prev.verbose !== next.verbose) return false;
  // Defensive: same ref but tool list mutated
  const prevTc = prev.msg.toolCalls?.length ?? 0;
  const nextTc = next.msg.toolCalls?.length ?? 0;
  if (prevTc !== nextTc) return false;
  return true;
}

interface StaticMessageProps {
  msg: ChatMessage;
  chatStyle: ChatStyle;
  diffStyle?: "default" | "sidebyside" | "compact";
  collapseDiffs?: boolean;
  showReasoning?: boolean;
  reasoningExpanded?: boolean;
  animate?: boolean;
  lockIn?: boolean;
  dimmed?: boolean;
  verbose?: boolean;
}

export const StaticMessage = memo(function StaticMessage({
  msg,
  chatStyle,
  diffStyle = "default",
  collapseDiffs = false,
  showReasoning = true,
  reasoningExpanded = false,
  animate = false,
  lockIn = false,
  dimmed = false,
  verbose = false,
}: StaticMessageProps) {
  if (msg.role === "system") {
    return (
      <box flexDirection="column" paddingX={1} width="100%" style={{ opacity: dimmed ? 0.4 : 1 }}>
        <SystemMessage msg={msg} animate={animate} />
      </box>
    );
  }
  if (msg.role === "user") {
    return (
      <box flexDirection="column" paddingX={1} width="100%" style={{ opacity: dimmed ? 0.4 : 1 }}>
        {chatStyle === "bubble" ? <UserMessageBubble msg={msg} /> : <UserMessageAccent msg={msg} />}
      </box>
    );
  }
  return (
    <box flexDirection="column" paddingX={1} width="100%" style={{ opacity: dimmed ? 0.4 : 1 }}>
      <AssistantMessage
        msg={msg}
        diffStyle={diffStyle}
        collapseDiffs={collapseDiffs}
        showReasoning={showReasoning}
        reasoningExpanded={reasoningExpanded}
        lockIn={lockIn}
        verbose={verbose}
      />
    </box>
  );
}, staticMessagePropsEqual);

export const MessageList = memo(function MessageList({
  messages,
  chatStyle,
  diffStyle = "default",
  collapseDiffs = false,
  showReasoning = true,
  lockIn = false,
  verbose = false,
}: Props) {
  const t = useTheme();
  const lastSystemIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "system") return i;
    }
    return -1;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <box flexDirection="column" paddingX={1} width="100%">
        <box marginTop={1}>
          <text fg={t.textMuted} attributes={TextAttributes.ITALIC}>
            No messages yet. Type below to start.
          </text>
        </box>
      </box>
    );
  }

  return (
    <box flexDirection="column" paddingX={1} width="100%">
      {messages.map((msg, idx) => {
        if (msg.role === "system") {
          return <SystemMessage key={msg.id} msg={msg} animate={idx === lastSystemIdx} />;
        }

        if (msg.role === "user") {
          return chatStyle === "bubble" ? (
            <UserMessageBubble key={msg.id} msg={msg} />
          ) : (
            <UserMessageAccent key={msg.id} msg={msg} />
          );
        }

        return (
          <AssistantMessage
            key={msg.id}
            msg={msg}
            diffStyle={diffStyle}
            collapseDiffs={collapseDiffs}
            showReasoning={showReasoning}
            lockIn={lockIn}
            verbose={verbose}
          />
        );
      })}
    </box>
  );
});
