import type { JSONObject } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { generateText } from "ai";
import { logBackgroundError } from "../../stores/errors.js";
import { recordModelCall, useModelEventsStore } from "../../stores/model-events.js";
import { getModelId, supportsTemperature } from "../llm/provider-options.js";
import type { IOClient } from "../workers/io-client.js";
import type { WorkingStateManager } from "./working-state.js";

interface V2SummaryResult {
  summary: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export async function buildV2Summary(opts: {
  wsm: WorkingStateManager;
  olderMessages: ModelMessage[];
  model?: Parameters<typeof generateText>[0]["model"];
  providerOptions?: Record<string, JSONObject>;
  headers?: Record<string, string>;
  skipLlm?: boolean;
  abortSignal?: AbortSignal;
  ioClient?: IOClient;
}): Promise<V2SummaryResult> {
  const { wsm, olderMessages, model, providerOptions, headers, skipLlm, abortSignal, ioClient } =
    opts;

  let structuredState: string;
  if (ioClient) {
    try {
      structuredState = await ioClient.serializeWorkingState(wsm.getState());
    } catch {
      structuredState = wsm.serialize();
    }
  } else {
    structuredState = wsm.serialize();
  }

  // Skip gap-fill when structured state is rich enough — the incremental
  // extraction already captured the important context. Saves ~2k tokens.
  const RICH_STATE_THRESHOLD = 15;
  if (skipLlm || !model || wsm.slotCount() >= RICH_STATE_THRESHOLD) {
    return { summary: structuredState };
  }

  let convoText: string;
  if (ioClient) {
    try {
      convoText = await ioClient.buildConvoText(olderMessages, 12000);
    } catch {
      convoText = buildFullConvoText(olderMessages, 12000);
    }
  } else {
    convoText = buildFullConvoText(olderMessages, 12000);
  }

  let gapFill: string | undefined;
  let llmUsage:
    | {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      }
    | undefined;
  const v2StartedAt = Date.now();
  const v2ModelId = getModelId(model);
  try {
    const genResult = await generateText({
      model,
      ...(supportsTemperature(getModelId(model)) ? { temperature: 0 } : {}),
      maxOutputTokens: 2048,
      maxRetries: 0,
      ...(abortSignal ? { abortSignal } : {}),
      ...(providerOptions && Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
      ...(headers ? { headers } : {}),
      prompt: [
        "You are reviewing a structured summary of a coding conversation to find MISSING information.",
        "",
        "EXISTING STRUCTURED STATE (already extracted):",
        structuredState,
        "",
        "FULL CONVERSATION (older messages being compacted):",
        convoText,
        "",
        "Your job: output ONLY information that is genuinely MISSING from the structured state above.",
        "Focus on:",
        "- User requirements or constraints not captured",
        "- Important decisions or reasoning not reflected",
        "- Error details or test results that matter for ongoing work",
        "- Context that would be needed to continue the task",
        "",
        "Format as bullet points under these headers (skip empty sections):",
        "",
        "## Missing Requirements",
        "## Missing Decisions",
        "## Missing Context",
        "",
        "If the structured state already covers everything important, output exactly: COMPLETE",
        "Be concise but thorough. Include specific details (file names, error messages, code snippets) not vague summaries.",
      ].join("\n"),
    });
    gapFill = genResult.text;
    const gu = genResult.usage;
    if (gu) {
      const details = (
        gu as { inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } }
      ).inputTokenDetails;
      llmUsage = {
        inputTokens: gu.inputTokens ?? 0,
        outputTokens: gu.outputTokens ?? 0,
        cacheReadTokens: details?.cacheReadTokens ?? 0,
        cacheWriteTokens: details?.cacheWriteTokens ?? 0,
      };
    }
    if (useModelEventsStore.getState().enabled) {
      recordModelCall({
        modelId: v2ModelId,
        source: "compaction",
        startedAt: v2StartedAt,
        durationMs: Math.max(0, Date.now() - v2StartedAt),
        state: "ok",
        input: llmUsage?.inputTokens ?? 0,
        output: llmUsage?.outputTokens ?? 0,
        cacheRead: llmUsage?.cacheReadTokens ?? 0,
        cacheWrite: llmUsage?.cacheWriteTokens ?? 0,
      });
    }
  } catch (err: unknown) {
    logBackgroundError("compaction-summarize", err instanceof Error ? err.message : String(err));
    if (useModelEventsStore.getState().enabled) {
      recordModelCall({
        modelId: v2ModelId,
        source: "compaction",
        startedAt: v2StartedAt,
        durationMs: Math.max(0, Date.now() - v2StartedAt),
        state: "error",
        errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      });
    }
    return { summary: structuredState };
  }

  if (!gapFill || gapFill.trim() === "COMPLETE" || gapFill.trim().length < 20) {
    return { summary: structuredState, usage: llmUsage };
  }

  return {
    summary: `${structuredState}\n\n## Additional Details\n${gapFill.trim()}`,
    usage: llmUsage,
  };
}

export function buildFullConvoText(messages: ModelMessage[], charBudget: number): string {
  const parts: string[] = [];
  let chars = 0;

  for (const msg of messages) {
    if (chars >= charBudget) break;
    const text = messageTextFull(msg);
    if (!text) continue;
    const chunk = `${msg.role}: ${text}`;
    const limited = chunk.length > 2000 ? `${chunk.slice(0, 2000)}...` : chunk;
    parts.push(limited);
    chars += limited.length;
  }

  return parts.join("\n\n");
}

function messageTextFull(msg: ModelMessage): string | undefined {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const texts: string[] = [];
    for (const part of msg.content) {
      if (typeof part === "object" && part !== null) {
        if ("text" in part) {
          texts.push(String((part as { text: string }).text));
        } else if ("type" in part) {
          const typed = part as { type: string; toolName?: string; result?: unknown };
          if (typed.type === "tool-result") {
            const resultStr = typed.result != null ? JSON.stringify(typed.result) : "null";
            texts.push(
              `[tool-result: ${typed.toolName ?? "unknown"} → ${resultStr.slice(0, 1500)}]`,
            );
          } else if (typed.type === "tool-call") {
            texts.push(`[tool-call: ${typed.toolName ?? "unknown"}]`);
          }
        }
      }
    }
    return texts.join("\n") || undefined;
  }
  return undefined;
}
