import type { ModelMessage } from "ai";
import type { WorkingStateManager } from "./working-state.js";

/**
 * Rule-based extractor that processes tool calls and messages to update
 * the working state incrementally. Sees FULL data at extraction time
 * (before pruning truncates it), which is v2's structural advantage.
 */

const READ_TOOLS = new Set([
  "read",
  "navigate",
  "grep",
  "glob",
  "analyze",
  "soul_grep",
  "soul_find",
  "soul_analyze",
  "soul_impact",
]);
const EDIT_TOOLS = new Set(["edit_file", "replace_file", "write_file", "create_file"]);
const SHELL_TOOL = "shell";
const PROJECT_TOOL = "project";

export function extractFromToolCall(
  wsm: WorkingStateManager,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const filePath = extractFilePath(args);

  if (READ_TOOLS.has(toolName) && filePath) {
    wsm.trackFile(filePath, {
      type: "read",
      summary: buildReadSummary(toolName, args),
    });
  }

  if (EDIT_TOOLS.has(toolName) && filePath) {
    const detail = buildEditDetail(toolName, args);
    wsm.trackFile(filePath, {
      type: toolName === "write_file" || toolName === "create_file" ? "create" : "edit",
      detail,
    });
  }

  if (toolName === SHELL_TOOL) {
    const cmd = truncate(String(args.command ?? ""), 200);
    wsm.addToolResult("shell", `ran: ${cmd}`);
  }

  if (toolName === PROJECT_TOOL) {
    const action = String(args.action ?? "");
    wsm.addToolResult(
      "project",
      `${action}${args.command ? `: ${truncate(String(args.command), 120)}` : ""}`,
    );
  }
}

export function extractFromToolResult(
  wsm: WorkingStateManager,
  toolName: string,
  result: unknown,
  _args?: Record<string, unknown>,
): void {
  const resultStr = typeof result === "string" ? result : JSON.stringify(result);

  if (isErrorResult(resultStr)) {
    const errorSummary = extractErrorSummary(resultStr);
    wsm.addFailure(`${toolName}: ${errorSummary}`);
  }

  if (toolName === "shell" || toolName === "project") {
    const isError = isErrorResult(resultStr);
    const limit = isError ? 1500 : 800;
    const summary = truncate(resultStr, limit);
    const existing = wsm.getState().toolResults;
    const last = existing[existing.length - 1];
    if (last && last.tool === toolName) {
      last.summary += ` → ${summary}`;
    } else {
      wsm.addToolResult(toolName, summary);
    }
  }

  if (toolName === "grep" || toolName === "soul_grep") {
    const lines = resultStr.split("\n").filter((l) => l.trim());
    const matchCount = lines.length;
    const preview = lines.slice(0, 10).join("\n");
    wsm.addToolResult(
      toolName,
      `${matchCount} matches${matchCount > 0 ? `:\n${truncate(preview, 600)}` : ""}`,
    );
  }

  if (toolName === "read") {
    const lineCount = resultStr.split("\n").length;
    const outline = extractFileOutline(resultStr);
    if (outline) {
      const filePath = _args ? extractFilePath(_args) : undefined;
      if (filePath) {
        const existing = wsm.getState().files.get(filePath);
        const lastAction = existing?.actions[existing.actions.length - 1];
        if (lastAction?.type === "read") {
          lastAction.summary = `${lineCount} lines — ${outline}`;
        }
      }
    }
  }

  if (toolName === "navigate") {
    wsm.addToolResult("navigate", truncate(resultStr, 600));
  }

  if (toolName === "soul_find") {
    const lines = resultStr.split("\n").filter((l) => l.trim());
    wsm.addToolResult("soul_find", `${lines.length} results: ${truncate(resultStr, 400)}`);
  }

  if (toolName === "soul_analyze" || toolName === "soul_impact" || toolName === "analyze") {
    wsm.addToolResult(toolName, truncate(resultStr, 600));
  }
}

export function extractFromUserMessage(wsm: WorkingStateManager, message: ModelMessage): void {
  const text = messageText(message);
  if (!text) return;
  // Skip the synthetic memory recall pair — it's not user input. Letting it
  // through pollutes userRequirements with memory bodies that look like
  // requests, and the recalled memories themselves are accessible from the DB
  // any time recall surfaces them again post-compaction.
  if (text.includes("<recalled_memories>")) return;

  if (!wsm.getState().task) {
    wsm.setTask(truncate(text, 400));
  } else {
    wsm.addUserRequirement(truncate(text, 300));
  }
}

/**
 * Extract key points from assistant text. Keeps a condensed summary of
 * each assistant turn to preserve reasoning and context.
 */
export function extractFromAssistantMessage(wsm: WorkingStateManager, message: ModelMessage): void {
  const text = messageText(message);
  if (!text || text.length < 20) return;
  // Skip the recall-pair acknowledgement ("Acknowledged — N relevant memor…")
  // — it's a synthetic ack, not assistant reasoning worth preserving.
  if (/^Acknowledged — \d+ relevant memor(?:y|ies) surfaced\.$/.test(text.trim())) return;

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.length > 10)
    .map((s) => s.trim());

  if (sentences.length === 0) return;

  if (sentences.length <= 3) {
    wsm.addAssistantNote(truncate(text, 300));
    return;
  }

  const kept: string[] = [];
  const maxSentences = 5;
  const budget = 500;
  let chars = 0;

  for (const s of sentences) {
    if (kept.length >= maxSentences || chars >= budget) break;
    if (isSubstantive(s)) {
      kept.push(s);
      chars += s.length;
    }
  }

  if (kept.length > 0) {
    wsm.addAssistantNote(truncate(kept.join(" "), budget));
  }
}

function isSubstantive(sentence: string): boolean {
  const filler = /^(ok|sure|let me|i'll now|here's|looking at|alright|got it|understood)/i;
  if (filler.test(sentence)) return false;
  if (sentence.length < 15) return false;
  return true;
}

function extractFilePath(args: Record<string, unknown>): string | undefined {
  const keys = ["file", "path", "filePath", "file_path", "target_file", "source_file", "target"];
  for (const key of keys) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return undefined;
}

function buildReadSummary(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "grep":
    case "soul_grep":
      return `grep for "${truncate(String(args.pattern ?? ""), 120)}"`;
    case "glob":
      return `glob "${truncate(String(args.pattern ?? ""), 120)}"`;
    case "analyze":
    case "soul_analyze":
      return `analyzed${args.symbols ? ` symbols: ${truncate(String(args.symbols), 150)}` : ""}`;
    case "soul_find":
      return `find "${truncate(String(args.query ?? ""), 120)}"`;
    case "soul_impact":
      return `impact analysis`;
    case "navigate":
      return `navigate to ${truncate(String(args.symbol ?? args.query ?? ""), 100)}`;
    default:
      return "read";
  }
}

function buildEditDetail(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "edit_file") {
    const old = truncate(String(args.old_string ?? args.search ?? ""), 300);
    const new_ = truncate(String(args.new_string ?? args.replace ?? ""), 300);
    if (old && new_) return `"${old}" → "${new_}"`;
    if (args.lineStart != null) return `edit at line ${args.lineStart}`;
    return "edited";
  }
  if (toolName === "write_file" || toolName === "create_file") {
    const content = String(args.content ?? "");
    const lineCount = content.split("\n").length;
    return `full write (${lineCount} lines)`;
  }
  return "replaced";
}

function extractFileOutline(content: string): string | undefined {
  const lines = content.split("\n");
  const exports: string[] = [];
  const definitions: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const exportMatch = trimmed.match(
      /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|type|interface|enum)\s+(\w+)/,
    );
    if (exportMatch?.[1]) {
      exports.push(exportMatch[1]);
      continue;
    }
    const defMatch = trimmed.match(/^(?:async\s+)?(?:function|class)\s+(\w+)/);
    if (defMatch?.[1]) {
      definitions.push(defMatch[1]);
      continue;
    }
    const pyDefMatch = trimmed.match(/^(?:def|class)\s+(\w+)/);
    if (pyDefMatch?.[1]) {
      definitions.push(pyDefMatch[1]);
    }
  }

  const symbols = exports.length > 0 ? exports : definitions;
  if (symbols.length === 0) return undefined;

  const label = exports.length > 0 ? "exports" : "defines";
  const display =
    symbols.length > 8
      ? `${symbols.slice(0, 8).join(", ")}... +${symbols.length - 8} more`
      : symbols.join(", ");
  return `${label}: ${display}`;
}

function isErrorResult(result: string): boolean {
  return /(?:error|Error|ERROR|failed|FAILED|exception|EXCEPTION|not found|ENOENT|EACCES|panic)/i.test(
    result.slice(0, 500),
  );
}

function extractErrorSummary(result: string): string {
  const lines = result.split("\n").filter((l) => l.trim().length > 0);
  const errorLine = lines.find((l) => /(?:error|Error|failed|exception|not found)/i.test(l));
  return truncate(errorLine || lines[0] || "unknown error", 300);
}

function messageText(msg: ModelMessage): string | undefined {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const texts: string[] = [];
    for (const part of msg.content) {
      if (typeof part === "object" && part !== null && "text" in part) {
        texts.push(String((part as { text: string }).text));
      }
    }
    return texts.join("\n") || undefined;
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}
