import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { PrepareStepFunction, StopCondition } from "ai";
import { stepCountIs } from "ai";
import { getCwd } from "../cwd.js";
import { renderTaskList } from "../tools/task-list.js";
import type { AgentBus } from "./agent-bus.js";
import { AbnormalFinishError, isAbnormalFinish } from "./stream-options.js";
import { emitSubagentStep } from "./subagent-events.js";

type SymbolLookup = (absPath: string) => Array<{ name: string; kind: string; isExported: boolean }>;

/** Global flag — set by /export api command. When true, each step dumps full request/response data. */
let apiExportEnabled = false;
export function setApiExportEnabled(v: boolean): void {
  apiExportEnabled = v;
}
export function isApiExportEnabled(): boolean {
  return apiExportEnabled;
}

export interface PrepareStepOptions {
  bus?: AgentBus;
  agentId?: string;
  parentToolCallId?: string;
  role: import("./agent-bus.js").AgentRole;
  allTools: Record<string, unknown>;
  symbolLookup?: SymbolLookup;
  contextWindow?: number;
  disablePruning?: boolean;
  tabId?: string;
  /** When set, recall a memory pair on each fresh user turn and splice in
   *  before the user message (cache-stable). */
  contextManager?: {
    buildMemoryRecallMessages(
      lastUserMessage: string,
    ): Promise<[{ role: "user"; content: string }, { role: "assistant"; content: string }] | null>;
  };
}

// Context-proportional thresholds (fraction of model's context window).
// Agents run until done naturally; these are guardrails as context fills up.
const OUTPUT_NUDGE_PCT = 0.8;
const HARD_STOP_PCT = 0.9;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const MAX_SUBAGENT_CONTEXT = 200_000;

const KEEP_RECENT_MESSAGES = 4;

// Step-count limits — tight caps that match the prompt discipline.
// Explore: search → read → report (3-5 steps typical, 12 max).
// Code: read → edit → verify (3-5 steps typical, 18 max).
const EXPLORE_MAX_STEPS = 12;
const CODE_MAX_STEPS = 18;
// Step at which we inject a "wrap up" nudge (before hard stop)
const STEP_NUDGE_EXPLORE = 8;
const STEP_NUDGE_CODE = 12;
// Consecutive read-only steps before hinting to act.
// Set high enough that legitimate investigation (reading 4-5 files) doesn't trigger.
const CONSECUTIVE_READ_LIMIT = 5;
// Identical tool call repetitions before injecting a loop-break hint
const REPEAT_CALL_THRESHOLD = 3;
const REPEAT_CALL_WINDOW = 8;

const READ_TOOL_NAMES = new Set(["read", "navigate", "soul_find", "list_dir"]);

/**
 * Detect degenerate tool-call loops: same tool + same args repeated across recent steps.
 * Returns the worst offender (highest repeat count) or null.
 */
export function detectRepeatedCalls(
  steps: ReadonlyArray<{
    toolCalls: ReadonlyArray<{ toolName: string; input?: unknown }>;
  }>,
  window = REPEAT_CALL_WINDOW,
  threshold = REPEAT_CALL_THRESHOLD,
): { toolName: string; count: number; signature: string } | null {
  const counts = new Map<string, { toolName: string; count: number }>();
  const start = Math.max(0, steps.length - window);
  for (let i = start; i < steps.length; i++) {
    const calls = steps[i]?.toolCalls;
    if (!calls) continue;
    for (const tc of calls) {
      let argStr: string;
      try {
        argStr = JSON.stringify(tc.input ?? {});
      } catch {
        argStr = "{}";
      }
      const sig = `${tc.toolName}::${argStr}`;
      const entry = counts.get(sig);
      if (entry) entry.count++;
      else counts.set(sig, { toolName: tc.toolName, count: 1 });
    }
  }
  let worst: { toolName: string; count: number; signature: string } | null = null;
  for (const [sig, entry] of counts) {
    if (entry.count >= threshold && (!worst || entry.count > worst.count)) {
      worst = { toolName: entry.toolName, count: entry.count, signature: sig };
    }
  }
  return worst;
}

const SUMMARIZABLE_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "analyze",
  "web_search",
  "fetch_page",
  "shell",
  "dispatch",
  "list_dir",
  "soul_grep",
  "soul_analyze",
  "soul_impact",
  "memory",
  "skills",
  "plan",
  "update_plan_step",
  "ask_user",
  "git",
]);

const EDIT_TOOLS = new Set(["edit_file", "multi_edit", "write_file", "create_file"]);

function extractText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (typeof obj.value === "string") return obj.value;
    if (typeof obj.output === "string") return obj.output;
    return JSON.stringify(output);
  }
  return String(output);
}

interface SummaryContext {
  symbolHint?: string;
  args?: Record<string, unknown>;
}

function buildSummary(toolName: string, text: string, ctx?: SummaryContext): string | null {
  const lineCount = text.split("\n").length;
  const charCount = text.length;

  if (charCount <= 200) return null;

  const args = ctx?.args;
  const tag = "←";

  if (toolName === "read") {
    const parts = [`${tag} ${String(lineCount)} lines`];
    if (ctx?.symbolHint) parts.push(ctx.symbolHint);
    return parts.join(" — ");
  }
  if (toolName === "grep" || toolName === "soul_grep") {
    const matchCount = (text.match(/\n/g) || []).length;
    const pattern = typeof args?.pattern === "string" ? ` for "${args.pattern.slice(0, 40)}"` : "";
    return `${tag} ${String(matchCount)} matches${pattern}`;
  }
  if (toolName === "glob") {
    const fileCount = text.trim().split("\n").length;
    const pattern = typeof args?.pattern === "string" ? ` for ${args.pattern}` : "";
    return `${tag} ${String(fileCount)} files${pattern}`;
  }
  if (toolName === "shell") {
    const cmd = typeof args?.command === "string" ? args.command.slice(0, 60) : "";
    const lastLine = text.trim().split("\n").pop() ?? "";
    const exitHint = /exit code[: ]+(\d+)/i.test(lastLine)
      ? ` — ${lastLine.slice(0, 40)}`
      : text.includes("error") || text.includes("Error")
        ? " — had errors"
        : " — ok";
    return `${tag} \`${cmd}\` → ${String(lineCount)} lines${exitHint}`;
  }
  if (toolName === "dispatch") {
    const parts: string[] = [`${tag} dispatch completed`];
    const headingMatch = text.match(/^## (.+)/m);
    if (headingMatch?.[1]) parts.push(headingMatch[1].trim());
    const agentMatch = text.match(/\*\*(\d+\/\d+)\*\* agents/);
    if (agentMatch) parts.push(`${agentMatch[1]} agents`);
    const filesMatch = text.match(/### Files Edited\n([\s\S]*?)(?:\n###|$)/);
    if (filesMatch?.[1]) parts.push(`edited: ${filesMatch[1].trim()}`);
    const agentSections = text.match(/### [✓✗] Agent: .+/g);
    if (agentSections) {
      const agents = agentSections.slice(0, 5).map((s) => s.replace(/^### [✓✗] Agent: /, ""));
      parts.push(`agents: ${agents.join(", ")}`);
    }
    const verifyMatch = text.match(/VERDICT: (PASS|FAIL|PARTIAL)(?:\s*—\s*(.+))?/);
    if (verifyMatch)
      parts.push(
        `verification: ${verifyMatch[1]}${verifyMatch[2] ? ` — ${verifyMatch[2].slice(0, 60)}` : ""}`,
      );
    return parts.join(" — ");
  }
  if (toolName === "list_dir") {
    const entryMatch = text.match(/(\d+) entries/);
    return `${tag} ${entryMatch ? entryMatch[1] : String(lineCount)} entries`;
  }
  if (toolName === "fetch_page" || toolName === "web_search") {
    const truncated = text.includes("page truncated");
    const url = typeof args?.url === "string" ? ` ${args.url.slice(0, 80)}` : "";
    return `${tag} ${String(lineCount)} lines${url}${truncated ? " (truncated — cached, try a sub-page URL)" : ""}`;
  }
  // soul_find: NOT summarized — results are small (file paths) and compacting them
  // causes the agent to think it hasn't found anything, triggering loops
  if (toolName === "soul_analyze" || toolName === "soul_impact") {
    const action = typeof args?.action === "string" ? `${args.action}: ` : "";
    const firstLine = text.split("\n")[0] ?? "";
    return `${tag} ${action}${firstLine.slice(0, 120)}`;
  }
  if (toolName === "memory") {
    const count = text.trim().split("\n").length;
    return `${tag} ${String(count)} memories`;
  }
  if (toolName === "plan") {
    const titleMatch = text.match(/^# (.+)/m);
    const stepCount = (text.match(/^### /gm) || []).length;
    const title = titleMatch ? titleMatch[1]?.slice(0, 60) : "plan";
    return `${tag} plan "${title}" — ${String(stepCount)} steps`;
  }
  if (toolName === "update_plan_step") {
    const firstLine = text.split("\n")[0] ?? "";
    return `${tag} ${firstLine.slice(0, 80)}`;
  }
  if (toolName === "ask_user") {
    const firstLine = text.split("\n")[0] ?? "";
    return `${tag} user: ${firstLine.slice(0, 80)}`;
  }
  if (toolName === "git") {
    const firstLine = text.split("\n")[0] ?? "";
    return `${tag} ${firstLine.slice(0, 100)}`;
  }
  if (toolName === "skills") {
    const firstLine = text.split("\n")[0] ?? "";
    return `${tag} ${firstLine.slice(0, 100)}`;
  }
  return `${tag} ${String(lineCount)} lines, ${String(charCount)} chars`;
}

function buildToolCallPathMap(messages: ModelMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type !== "tool-call") continue;
      if (part.toolName !== "read") continue;
      const input = part.input as Record<string, unknown>;
      const path = input.path ?? input.file ?? input.filePath;
      if (typeof path === "string") {
        map.set(part.toolCallId, path);
      }
    }
  }
  return map;
}

function formatSymbolHint(
  symbols: Array<{ name: string; kind: string; line?: number; endLine?: number }>,
): string | undefined {
  if (symbols.length === 0) return undefined;
  const display = symbols.slice(0, 8).map((s) => {
    if (s.line && s.endLine) return `${s.name} :${String(s.line)}-${String(s.endLine)}`;
    return s.name;
  });
  if (symbols.length > 8) display.push(`+${String(symbols.length - 8)}`);
  return `exports: ${display.join(", ")}`;
}

/** Compact old tool results beyond KEEP_RECENT_MESSAGES into one-line summaries.
 *  Keeps edit tool results intact (needed for conversation coherence). */
function compactOldToolResults(
  messages: ModelMessage[],
  symbolLookup?: SymbolLookup,
  pathMap?: Map<string, string>,
): ModelMessage[] {
  if (messages.length <= KEEP_RECENT_MESSAGES) return messages;

  const cutoff = messages.length - KEEP_RECENT_MESSAGES;
  const resolvedPathMap = pathMap ?? (symbolLookup ? buildToolCallPathMap(messages) : undefined);

  const argsMap = new Map<string, Record<string, unknown>>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as { type: string }).type === "tool-call" &&
        "toolCallId" in part &&
        "input" in part
      ) {
        const tc = part as { toolCallId: string; input: unknown };
        if (typeof tc.input === "object" && tc.input !== null) {
          argsMap.set(tc.toolCallId, tc.input as Record<string, unknown>);
        }
      }
    }
  }

  const result: ModelMessage[] = [];
  for (const [idx, msg] of messages.entries()) {
    if (idx >= cutoff) {
      result.push(msg);
      continue;
    }
    if (msg.role !== "tool" || typeof msg.content === "string") {
      result.push(msg);
      continue;
    }
    if (!Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }

    let changed = false;
    const newContent = [];
    for (const part of msg.content) {
      if (
        part.type !== "tool-result" ||
        EDIT_TOOLS.has(part.toolName) ||
        !SUMMARIZABLE_TOOLS.has(part.toolName)
      ) {
        newContent.push(part);
        continue;
      }
      const text = extractText(part.output);

      let symbolHint: string | undefined;
      if (symbolLookup && resolvedPathMap && part.toolName === "read") {
        const absPath = resolvedPathMap.get(part.toolCallId);
        if (absPath) {
          try {
            symbolHint = formatSymbolHint(symbolLookup(absPath));
          } catch {}
        }
      }

      const summary = buildSummary(part.toolName, text, {
        symbolHint,
        args: argsMap.get(part.toolCallId),
      });
      if (!summary) {
        newContent.push(part);
        continue;
      }
      changed = true;
      newContent.push({ ...part, output: { type: "text" as const, value: summary } });
    }

    result.push(changed ? { ...msg, content: newContent } : msg);
  }
  return result as ModelMessage[];
}

// TODO: pruneByTokenBudget removed — it replaced old tool result content with placeholders,
// which mutated the message prefix and broke Anthropic auto-caching.
// Server-side clear_tool_uses (enabled by default) handles this now.
// If client-side pruning is needed again, it must use the cache-stable re-insertion pattern.
//
// function pruneByTokenBudget(messages: ModelMessage[]): ModelMessage[] {
//   ... see git history for implementation ...
// }

interface PrepareStepResult {
  // biome-ignore lint/suspicious/noExplicitAny: TOOLS generic is invariant — tool-agnostic functions use <any> (same as SDK's stepCountIs/hasToolCall)
  prepareStep: PrepareStepFunction<any>;
  // biome-ignore lint/suspicious/noExplicitAny: TOOLS generic is invariant
  stopConditions: StopCondition<any>[];
}

export function buildPrepareStep({
  bus,
  agentId,
  parentToolCallId,
  role,
  allTools: _allTools,
  symbolLookup,
  contextWindow: ctxWindow,
  disablePruning,
  tabId,
  contextManager,
}: PrepareStepOptions): PrepareStepResult {
  const cw = Math.min(ctxWindow ?? DEFAULT_CONTEXT_WINDOW, MAX_SUBAGENT_CONTEXT);
  const nudgeThreshold = Math.floor(cw * OUTPUT_NUDGE_PCT);
  const hardStop = Math.floor(cw * HARD_STOP_PCT);
  let nudgeFired = false;
  const isExplore = role === "explore" || role === "investigate";
  const stepNudgeAt = isExplore ? STEP_NUDGE_EXPLORE : STEP_NUDGE_CODE;
  const maxSteps = isExplore ? EXPLORE_MAX_STEPS : CODE_MAX_STEPS;

  // Cache-stable inject tracking (same pattern as forge.ts).
  // All dynamic hints go into user message injects instead of result.system
  // to keep the system prompt stable for prefix caching.
  const previousInjects: Array<{ cleanInsertAt: number; message: ModelMessage }> = [];

  // Memory recall injects — spliced before the user turn that triggered them.
  const recallInjects: Array<{
    cleanInsertAt: number;
    pair: [ModelMessage, ModelMessage];
  }> = [];
  let lastUserTurnCount = 0;

  // biome-ignore lint/suspicious/noExplicitAny: TOOLS generic is invariant — tool-agnostic functions use <any> (same as SDK's stepCountIs/hasToolCall)
  const prepareStep: PrepareStepFunction<any> = async ({ stepNumber, steps, messages }) => {
    const result: {
      toolChoice?: "required" | "auto" | "none";
      activeTools?: string[];
      system?: string;
      messages?: ModelMessage[];
    } = {};

    // Abnormal-finish detection: ToolLoopAgent's `notify()` swallows errors thrown
    // from `onStepFinish` (ai/dist/index.mjs:519). prepareStep is awaited inline so
    // throws propagate. Sniff the prior step's finishReason and surface as a real
    // stream rejection — fixes silent stop on finishReason=length (vercel/ai #13075).
    const prevStep = steps[steps.length - 1] as { finishReason?: string } | undefined;
    if (prevStep && isAbnormalFinish(prevStep.finishReason)) {
      throw new AbnormalFinishError(prevStep.finishReason);
    }

    // Sanitize non-dict tool-call inputs to prevent Anthropic API rejections
    let sanitizedMessages: ModelMessage[] | undefined;
    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];
      if (!msg) continue;
      if (msg.role !== "assistant" || typeof msg.content === "string") continue;
      if (!Array.isArray(msg.content)) continue;
      let clonedContent: typeof msg.content | undefined;
      for (let i = 0; i < msg.content.length; i++) {
        const part = msg.content[i] as (typeof msg.content)[number];
        if (part.type !== "tool-call") continue;
        const input = (part as { input: unknown }).input;
        if (typeof input === "object" && input !== null && !Array.isArray(input)) continue;
        if (!clonedContent) clonedContent = [...msg.content];
        (clonedContent as unknown[])[i] = { ...part, input: {} };
      }
      if (clonedContent) {
        if (!sanitizedMessages) sanitizedMessages = [...messages];
        sanitizedMessages[mi] = { ...msg, content: clonedContent } as ModelMessage;
      }
    }
    if (sanitizedMessages) result.messages = sanitizedMessages;

    // Step 0: leave toolChoice unset. The model decides if tools are needed.
    // Forcing required-tool on step 0 made tiny tasks call a no-op tool then stop
    // with zero text, leaking the task description as the fallback summary.

    // Tool result compaction: summarize old results to save tokens.
    // Only runs when pruning is enabled via /provider-settings toggle.
    // TODO: pruneByTokenBudget was removed — it modified earlier message content which broke
    // Anthropic prefix caching. Server-side clear_tool_uses handles this now.
    // If we need client-side pruning back, it must use the re-insertion pattern to stay cache-stable.
    if (!disablePruning && stepNumber >= 2) {
      const src = result.messages ?? messages;
      const compacted = compactOldToolResults(src, symbolLookup);
      if (compacted !== src) {
        result.messages = compacted;
      }
    }

    // Use the last step's input tokens as actual context size (not cumulative sum).
    // Each step re-sends the full message history, so inputTokens reflects real context window usage.
    const lastStep = steps.length > 0 ? steps[steps.length - 1] : undefined;

    // API export: dump full request data per step
    // Enable via /export api command or SOULFORGE_DEBUG_API=1 env var
    if (apiExportEnabled || process.env.SOULFORGE_DEBUG_API) {
      const msgs = result.messages ?? messages;
      const prevUsage = lastStep?.usage;

      // Serialize each message content into readable form — no [object Object]
      const serializeContent = (content: unknown): unknown => {
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return String(content);
        return (content as Record<string, unknown>[]).map((part) => {
          const p = part as Record<string, unknown>;
          if (p.type === "tool-call") {
            return {
              type: "tool-call",
              toolCallId: p.toolCallId,
              toolName: p.toolName,
              input: typeof p.input === "string" ? p.input : JSON.stringify(p.input),
            };
          }
          if (p.type === "tool-result") {
            const output = p.output as Record<string, unknown> | undefined;
            let text: string;
            if (output?.type === "text") text = String(output.value ?? "");
            else if (output?.type === "json") text = JSON.stringify(output.value);
            else text = JSON.stringify(output);
            return {
              type: "tool-result",
              toolCallId: p.toolCallId,
              toolName: p.toolName,
              contentLength: text.length,
              content: text,
            };
          }
          if (p.type === "text") return { type: "text", text: String(p.text ?? "") };
          return p;
        });
      };

      const exportData = {
        agent: agentId ?? "subagent",
        step: stepNumber,
        timestamp: new Date().toISOString(),
        messageCount: msgs.length,
        activeTools: result.activeTools ?? "all",
        previousStepUsage: prevUsage
          ? (() => {
              const details = (prevUsage as Record<string, unknown>).inputTokenDetails as
                | { cacheReadTokens?: number; cacheWriteTokens?: number; noCacheTokens?: number }
                | undefined;
              const cacheRead = details?.cacheReadTokens ?? 0;
              const cacheWrite = details?.cacheWriteTokens ?? 0;
              return {
                inputTokens: prevUsage.inputTokens,
                outputTokens: prevUsage.outputTokens,
                cacheReadTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
                noCacheTokens: details?.noCacheTokens ?? 0,
                totalTokens: (prevUsage.inputTokens ?? 0) + (prevUsage.outputTokens ?? 0),
              };
            })()
          : null,
        messages: msgs.map((m, i) => {
          const content = serializeContent(m.content);
          const charCount =
            typeof content === "string"
              ? content.length
              : Array.isArray(content)
                ? content.reduce(
                    (sum: number, p: Record<string, unknown>) =>
                      sum +
                      (typeof p.content === "string" ? p.content.length : 0) +
                      (typeof p.text === "string" ? p.text.length : 0) +
                      (typeof p.input === "string" ? p.input.length : 0),
                    0,
                  )
                : 0;
          return {
            index: i,
            role: m.role,
            cacheControl: m.providerOptions?.anthropic ? "ephemeral" : undefined,
            charCount,
            estimatedTokens: Math.ceil(charCount / 4),
            content,
          };
        }),
      };

      const json = JSON.stringify(exportData, null, 2);
      import("node:fs").then(({ mkdirSync, writeFileSync }) => {
        const dir = `${getCwd()}/.soulforge/api-export`;
        mkdirSync(dir, { recursive: true });
        const subDir = agentId ? `${dir}/subagents/${agentId}` : dir;
        mkdirSync(subDir, { recursive: true });
        const file = `${subDir}/step-${String(stepNumber).padStart(2, "0")}.json`;
        writeFileSync(file, json, "utf-8");
      });
    }

    const contextSize = lastStep?.usage.inputTokens ?? 0;

    // Collect all hints as user message injects (not result.system) for cache stability.
    // System prompt stays byte-identical across steps → prefix caching works.
    const hints: string[] = [];

    if (bus && agentId) {
      const unseen = bus.drainUnseenFindings(agentId);
      if (unseen) {
        hints.push(`--- Peer findings (new) ---\n${unseen}`);
      }
    }

    const taskBlock = renderTaskList(tabId);
    if (taskBlock) hints.push(taskBlock);

    // Consecutive read detection: count trailing read-only tool calls
    if (stepNumber >= CONSECUTIVE_READ_LIMIT && !nudgeFired) {
      let consecutiveReads = 0;
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        const calls = step?.toolCalls;
        if (!calls || calls.length === 0) break;
        const allReads = calls.every((tc: { toolName: string }) =>
          READ_TOOL_NAMES.has(tc.toolName),
        );
        if (allReads) consecutiveReads++;
        else break;
      }
      if (consecutiveReads >= CONSECUTIVE_READ_LIMIT) {
        const hint = isExplore
          ? `[status: ${String(consecutiveReads)} read-only steps — summarize findings or use a search tool for remaining questions]`
          : `[status: ${String(consecutiveReads)} read-only steps — apply edits with multi_edit]`;
        hints.push(hint);
      }
    }

    // Degenerate loop detection: identical tool calls repeated across recent steps
    if (stepNumber >= REPEAT_CALL_THRESHOLD) {
      const repeated = detectRepeatedCalls(steps);
      if (repeated) {
        hints.push(
          `🔁 ${repeated.toolName} called ${String(repeated.count)}× with identical arguments — same result each time. Use the result you already have, or try a different tool/approach.`,
        );
      }
    }

    // Step-count nudge: progressively stronger as agent approaches step limit
    if (stepNumber >= stepNudgeAt) {
      const remaining = maxSteps - stepNumber;
      if (remaining <= 1) {
        hints.push(
          isExplore
            ? "🛑 FINAL STEP. Stop all tool calls. Write your report NOW."
            : "🛑 FINAL STEP. Apply remaining edits NOW, then report what changed.",
        );
        result.toolChoice = "none";
        result.activeTools = [];
      } else if (remaining <= 2) {
        hints.push(
          isExplore
            ? "🛑 Stop searching. Write your report NOW."
            : "🛑 Apply your remaining edits NOW with multi_edit.",
        );
        if (!isExplore) {
          result.activeTools = ["edit_file", "multi_edit", "report_finding"];
        }
      } else {
        hints.push(
          isExplore
            ? "⚠ You have enough information. Wrap up and write your report."
            : "⚠ Finish your edits soon.",
        );
      }
    }

    // Token budget nudge: force text-only response before context overflows.
    if (contextSize > nudgeThreshold) {
      nudgeFired = true;
      if (parentToolCallId) {
        emitSubagentStep({
          parentToolCallId,
          toolName: "_nudge",
          args: "token limit",
          state: "done",
          agentId,
        });
      }
      hints.push(
        "Stop calling tools. Write a concise text summary now: what you found or changed, which files, key details.",
      );
      result.toolChoice = "none";
      result.activeTools = [];
    }

    // ── Memory recall injection (subagent) ────────────────────────
    if (contextManager) {
      const baseMsgs = sanitizedMessages ?? messages;
      const userTurnCount = countUserTurnsLocal(baseMsgs);
      if (userTurnCount > lastUserTurnCount) {
        lastUserTurnCount = userTurnCount;
        const lastUserIdx = findLastUserIndexLocal(baseMsgs);
        const lastUserText = lastUserIdx >= 0 ? extractTextLocal(baseMsgs[lastUserIdx]) : "";
        if (lastUserText) {
          try {
            const pair = await contextManager.buildMemoryRecallMessages(lastUserText);
            if (pair && lastUserIdx >= 0) {
              recallInjects.push({
                cleanInsertAt: lastUserIdx,
                pair: [
                  { role: "user" as const, content: pair[0].content } as ModelMessage,
                  { role: "assistant" as const, content: pair[1].content } as ModelMessage,
                ],
              });
            }
          } catch {
            // silent
          }
        }
      }
    }

    // Re-insert previous injects + append new one for cache-stable prefix.
    if (hints.length > 0 || previousInjects.length > 0 || recallInjects.length > 0) {
      const msgs = result.messages ?? [...(sanitizedMessages ?? messages)];
      const cleanMsgCount = msgs.length;

      type Splice = { at: number; messages: ModelMessage[] };
      const splices: Splice[] = [
        ...previousInjects.map((p) => ({ at: p.cleanInsertAt, messages: [p.message] })),
        ...recallInjects.map((r) => ({ at: r.cleanInsertAt, messages: [...r.pair] })),
      ];
      splices.sort((a, b) => a.at - b.at);

      let offset = 0;
      for (const sp of splices) {
        const insertAt = sp.at + offset;
        if (insertAt <= msgs.length) {
          msgs.splice(insertAt, 0, ...sp.messages);
          offset += sp.messages.length;
        }
      }

      if (hints.length > 0) {
        const injectMessage: ModelMessage = {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: hints.map((h) => `<system-reminder>\n${h}\n</system-reminder>`).join("\n\n"),
            },
          ],
        };
        previousInjects.push({ cleanInsertAt: cleanMsgCount, message: injectMessage });
        msgs.push(injectMessage);
      }

      result.messages = msgs;
    }

    return Object.keys(result).length > 0 ? result : undefined;
  };

  // Nudge-aware token stop: uses last step's input tokens (actual context window size).
  // If over budget but nudge hasn't fired yet, allow one more step for graceful output.
  // biome-ignore lint/suspicious/noExplicitAny: TOOLS generic is invariant
  const tokenStop: StopCondition<any> = ({ steps }) => {
    const last = steps.length > 0 ? steps[steps.length - 1] : undefined;
    const ctx = last?.usage.inputTokens ?? 0;
    if (ctx >= hardStop && !nudgeFired) return false;
    return ctx >= hardStop;
  };

  return { prepareStep, stopConditions: [tokenStop, stepCountIs(maxSteps)] };
}

export function buildSymbolLookup(repoMap?: {
  isReady: boolean;
  getCwd(): string;
  getFileSymbolsCached(
    relPath: string,
  ): Array<{ name: string; kind: string; isExported: boolean; line: number; endLine: number }>;
}): SymbolLookup | undefined {
  if (!repoMap) return undefined;
  return (absPath: string) => {
    if (!repoMap.isReady) return [];
    const cwd = repoMap.getCwd();
    let rel: string;
    if (absPath.startsWith(`${cwd}/`)) {
      rel = absPath.slice(cwd.length + 1);
    } else if (absPath.startsWith("./")) {
      rel = absPath.slice(2);
    } else {
      rel = absPath;
    }
    return repoMap.getFileSymbolsCached(rel);
  };
}

export { compactOldToolResults, KEEP_RECENT_MESSAGES };

function countUserTurnsLocal(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === "user") n++;
  }
  return n;
}

function findLastUserIndexLocal(messages: ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

function extractTextLocal(message: ModelMessage | undefined): string {
  if (!message) return "";
  const c = message.content as unknown;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const p of c) {
      if (p && typeof p === "object" && "type" in p && (p as { type: string }).type === "text") {
        const t = (p as { text?: unknown }).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}
