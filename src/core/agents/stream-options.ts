import type { LanguageModelV3ToolCall } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { jsonrepair } from "jsonrepair";

export function sanitizeMessages(messages: ModelMessage[]): ModelMessage[] {
  let dirty = false;
  const cleaned = messages.map((msg) => {
    if (msg.role !== "assistant" || typeof msg.content === "string") return msg;
    if (!Array.isArray(msg.content)) return msg;

    // Pass 1: collect provider-executed tool-call IDs and tool-result IDs in this
    // assistant message. Anthropic's server tools (bash_code_execution, code_execution,
    // web_fetch, web_search) emit BOTH the tool_use and the tool_result inline on the
    // same assistant message. If the stream was cancelled / errored before the result
    // streamed in, we end up with an orphan tool_use → Anthropic rejects the next
    // request with "tool_use without corresponding tool_result block".
    const providerToolCallIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const part of msg.content) {
      // biome-ignore lint/suspicious/noExplicitAny: SDK part union is narrow but providerExecuted is structural
      const p = part as any;
      if (
        p?.type === "tool-call" &&
        p.providerExecuted === true &&
        typeof p.toolCallId === "string"
      ) {
        providerToolCallIds.add(p.toolCallId);
      } else if (p?.type === "tool-result" && typeof p.toolCallId === "string") {
        toolResultIds.add(p.toolCallId);
      }
    }
    const hasOrphans =
      [...providerToolCallIds].some((id) => !toolResultIds.has(id)) ||
      [...toolResultIds].some((id) => !providerToolCallIds.has(id));

    let contentDirty = false;
    let content = msg.content.map((part) => {
      if (part.type !== "tool-call") return part;
      const input = part.input;
      if (typeof input === "object" && input !== null && !Array.isArray(input)) return part;
      contentDirty = true;
      return { ...part, input: {} };
    });

    if (hasOrphans) {
      const before = content.length;
      content = content.filter((part) => {
        // biome-ignore lint/suspicious/noExplicitAny: structural check
        const p = part as any;
        if (p?.type === "tool-call" && p.providerExecuted === true) {
          return toolResultIds.has(p.toolCallId);
        }
        if (p?.type === "tool-result") {
          return providerToolCallIds.has(p.toolCallId);
        }
        return true;
      });
      if (content.length !== before) contentDirty = true;
    }

    if (!contentDirty) return msg;
    dirty = true;
    return { ...msg, content };
  });

  // Pass 2: cross-message pairing — drop tool-result blocks in "tool" messages
  // whose toolCallId has no matching tool-call anywhere in the preceding
  // assistant messages. This prevents "unexpected tool_use_id found in
  // tool_result blocks" after compaction or session restore drops the
  // assistant that owned them.
  const result = dirty ? cleaned : [...messages];
  // Collect all valid (non-providerExecuted) tool-call IDs across the
  // conversation up front — Anthropic only cares that SOME prior assistant
  // owns the tool_use, not that it's the immediately preceding one.
  const allValidCallIds = new Set<string>();
  for (const msg of result) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const p of msg.content) {
      // biome-ignore lint/suspicious/noExplicitAny: structural check
      const part = p as any;
      if (
        part?.type === "tool-call" &&
        typeof part.toolCallId === "string" &&
        !part.providerExecuted
      ) {
        allValidCallIds.add(part.toolCallId);
      }
    }
  }
  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (!msg || msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    const filtered = msg.content.filter((p) => {
      // biome-ignore lint/suspicious/noExplicitAny: structural check
      const part = p as any;
      if (part?.type !== "tool-result") return true;
      return allValidCallIds.has(part.toolCallId);
    });
    if (filtered.length === 0) {
      result.splice(i, 1);
      dirty = true;
    } else if (filtered.length !== msg.content.length) {
      result[i] = { ...msg, content: filtered };
      dirty = true;
    }
  }

  return dirty ? result : messages;
}

/** prepareStep hook that sanitizes tool-call inputs and surfaces abnormal finishes
 *  from the previous step. ToolLoopAgent's `onStepFinish` callback swallows thrown
 *  errors (ai/dist/index.mjs:519 — `notify()` has a bare catch), so prepareStep is
 *  the only safe place to convert a length-truncation into a real stream rejection.
 */
export function sanitizeToolInputsStep({
  messages,
  steps,
}: {
  messages: ModelMessage[];
  steps?: ReadonlyArray<{ finishReason?: string }>;
}): { messages: ModelMessage[] } | undefined {
  const prevStep = steps && steps.length > 0 ? steps[steps.length - 1] : undefined;
  if (prevStep && isAbnormalFinish(prevStep.finishReason)) {
    throw new AbnormalFinishError(prevStep.finishReason);
  }
  const cleaned = sanitizeMessages(messages);
  return cleaned !== messages ? { messages: cleaned } : undefined;
}

export async function repairToolCall({
  toolCall,
  tools,
  error,
}: {
  toolCall: LanguageModelV3ToolCall;
  tools?: Record<string, unknown>;
  error?: { name?: string } | unknown;
}): Promise<LanguageModelV3ToolCall | null> {
  const trimmed = toolCall.input.trim();
  if (!trimmed) return null;

  // Truncation detection: tool name is registered AND we got InvalidToolInputError
  // → the model emitted a real tool call whose JSON args got cut off mid-stream.
  // Signal this to the model instead of routing to a generic "invalid tool" path.
  const errName =
    typeof error === "object" && error !== null && "name" in error
      ? (error as { name?: string }).name
      : undefined;
  const isTruncationCandidate =
    errName === "AI_InvalidToolInputError" && tools != null && toolCall.toolName in tools;

  let repaired: string;
  try {
    repaired = jsonrepair(trimmed);
  } catch {
    if (isTruncationCandidate) {
      return {
        ...toolCall,
        input: JSON.stringify({
          __soulforge_truncated__: true,
          message: `Tool call '${toolCall.toolName}' was truncated at ${MAX_OUTPUT_TOKENS} output tokens — arguments did not finish streaming. Retry with smaller inputs (split write/edit into chunks, narrower ranges) or raise SOULFORGE_MAX_OUTPUT_TOKENS.`,
        }),
      };
    }
    return null;
  }

  // Verify the result is a valid JSON object (not array, string, number, etc.)
  try {
    const parsed = JSON.parse(repaired);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }

  // Nothing changed — no repair was needed
  if (repaired === trimmed) return null;

  return { ...toolCall, input: repaired };
}
/**
 * Max output tokens per step for all ToolLoopAgents.
 *
 * Without this cap, providers/gateways apply their own (often tiny) defaults —
 * e.g. some return finish_reason="length" at 1024 tokens. The SDK's ToolLoopAgent
 * treats any non-"tool-calls" finish reason as end-of-turn, so a length-truncated
 * step terminates the agent silently mid-thought.
 *
 * Override via SOULFORGE_MAX_OUTPUT_TOKENS. Mirrors opencode's pattern.
 */
export const MAX_OUTPUT_TOKENS = Number(process.env.SOULFORGE_MAX_OUTPUT_TOKENS) || 64_000;

/**
 * Finish reasons that mean "the model did not voluntarily stop and did not
 * request a tool" — the agent loop will exit after these but the turn is
 * incomplete. Surface them as errors instead of treating partial output
 * as the final answer.
 */
export type AbnormalFinishReason = "length" | "content-filter" | "error";

export function isAbnormalFinish(
  reason: string | undefined | null,
): reason is AbnormalFinishReason {
  return reason === "length" || reason === "content-filter" || reason === "error";
}

export function describeAbnormalFinish(reason: AbnormalFinishReason): string {
  if (reason === "length")
    return `Model output truncated at ${MAX_OUTPUT_TOKENS} tokens (finish_reason=length). Set SOULFORGE_MAX_OUTPUT_TOKENS to raise the cap.`;
  if (reason === "content-filter")
    return "Model response blocked by content filter (finish_reason=content-filter).";
  return "Model returned finish_reason=error.";
}

/**
 * Thrown from `onStepFinish` when a step finishes with an abnormal reason
 * (length / content-filter / error). Surfaces as a stream rejection so the
 * UI can render it and useChat can decide whether to auto-continue.
 */
export class AbnormalFinishError extends Error {
  readonly reason: AbnormalFinishReason;
  constructor(reason: AbnormalFinishReason) {
    super(describeAbnormalFinish(reason));
    this.name = "AbnormalFinishError";
    this.reason = reason;
  }
}
