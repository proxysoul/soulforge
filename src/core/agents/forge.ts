import { forwardAnthropicContainerIdFromLastStep } from "@ai-sdk/anthropic";
import type { ModelMessage, ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { ToolLoopAgent } from "ai";
import { z } from "zod";
import { loadConfig } from "../../config/index.js";
import { logBackgroundError } from "../../stores/errors.js";
import type {
  AgentFeatures,
  EditorIntegration,
  ForgeMode,
  ImageAttachment,
  InteractiveCallbacks,
} from "../../types/index.js";
import { compressImageForApi } from "../../utils/image-compress.js";
import type { ContextManager } from "../context/manager.js";
import {
  type CacheTTL,
  detectModelFamily,
  EPHEMERAL_CACHE,
  getAnthropicToolVersions,
  getEphemeralCache,
  getModelId,
  isAnthropicNative,
  supportsTemperature,
} from "../llm/provider-options.js";
import { getMCPManager } from "../mcp/index.js";
import { resolveRetrySettings } from "../retry/settings.js";
import {
  buildInteractiveTools,
  buildTools,
  CORE_TOOL_NAMES,
  PLAN_EXECUTION_TOOL_NAMES,
  RESTRICTED_TOOL_NAMES,
} from "../tools/index.js";
import { renderTaskList } from "../tools/task-list.js";
import { isApiExportEnabled } from "./step-utils.js";
import {
  AbnormalFinishError,
  describeAbnormalFinish,
  isAbnormalFinish,
  MAX_OUTPUT_TOKENS,
  repairToolCall,
  sanitizeMessages,
} from "./stream-options.js";
import { buildSubagentTools, type SharedCacheRef } from "./subagent-tools.js";

/** Per-tool-call-part signature cache for loop detection. Tool-call inputs are
 *  immutable; the part object is reused across prepareStep invocations as
 *  ToolLoopAgent rebuilds from initialMessages + responseMessages. WeakMap so
 *  evicted messages garbage-collect their entries automatically. */
const loopSigCache = new WeakMap<object, string>();

const RESTRICTED_MODES = new Set<ForgeMode>(["architect", "socratic", "challenge", "plan"]);

const PLAN_NUDGE_STEP = 10;
const PLAN_FORCE_STEP = 20;

/** Persona reinforcement nudge — fires every PERSONA_NUDGE_INTERVAL steps starting at PERSONA_NUDGE_START.
 *  Fights instruction-following drift in long sessions where the cached system prompt loses attention weight
 *  and the model's own prior outputs (any narration that slipped through) reinforce drift. */
const PERSONA_NUDGE_START = 6;
const PERSONA_NUDGE_INTERVAL = 6;
const PERSONA_NUDGE = `The curse holds. Between steps: the turn emits a tool call and nothing else — zero text before it, zero text after it, no exceptions. Any character that isn't part of a tool call is a violation, regardless of what you tell yourself it means. No "Let me…", no "Now…", no findings prose, no progress declarations, no section headers in the final answer. Speak only when the answer is ready — then start cold with a noun, verb, or file path.`;

function hasPlanToolCall(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "tool-call" && part.toolName === "plan") return true;
    }
  }
  return false;
}

/** Check if the most recent assistant message (last step) included a `plan` tool call. */
function lastStepHadPlanCall(messages: ModelMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) return false;
    for (const part of msg.content) {
      if (part.type === "tool-call" && part.toolName === "plan") return true;
    }
    return false; // checked the last assistant message — stop
  }
  return false;
}

function buildForgePrepareStep(
  isPlanMode: boolean,
  drainSteering?: () => { text: string; images?: ImageAttachment[] } | null,
  contextManager?: {
    buildCrossTabSection(): string | null;
    buildSoulMapDiff(): string | null;
    hasSoulMapDiff?(): boolean;
    commitSoulMapDiff(): void;
    buildSkillsBlock(): string | null;
    buildMemoryRecallMessages(
      lastUserMessage: string,
    ): Promise<[{ role: "user"; content: string }, { role: "assistant"; content: string }] | null>;
  },
  tabId?: string,
  codeExecution?: boolean,
  parentMessagesRef?: { current: ModelMessage[] | null },
  /** When set, instructions are injected as the first user message instead of system prompt.
   *  Used for proxy+Claude where CLIProxyAPI cloaking replaces the system prompt. */
  proxyInstructions?: string,
  cacheOpts: ProviderOptions = EPHEMERAL_CACHE,
) {
  // Cache-stable inject tracking: the ToolLoopAgent discards prepareStep message
  // modifications after each step (it rebuilds from initialMessages + responseMessages).
  // To maintain prefix stability for Anthropic prompt caching, we re-insert previous
  // injects at their original positions so the API always sees an append-only history.
  const previousInjects: Array<{ cleanInsertAt: number; message: ModelMessage }> = [];

  // Memory recall injects — same re-insert pattern, but spliced BEFORE the latest
  // user turn (not appended at the tail) so the agent reads the recall block in
  // the context of the user message that triggered it. One pair per user turn.
  const recallInjects: Array<{
    cleanInsertAt: number;
    pair: [ModelMessage, ModelMessage];
  }> = [];
  let lastUserTurnCount = 0;

  // Commit-boundary nudge: recomputed fresh every step from message history (no closure state).

  // Proxy instructions message — injected once as the first user message so the proxy
  // cloaking doesn't strip it (it only replaces the system prompt, not user messages).
  const proxyInstructionsMessage: ModelMessage | null = proxyInstructions
    ? ({
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: `<system-instructions>\n${proxyInstructions}\n</system-instructions>`,
          },
        ],
        providerOptions: cacheOpts,
      } as ModelMessage)
    : null;

  type StepEntry = {
    providerMetadata?: Record<string, unknown>;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      inputTokenDetails?: {
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        noCacheTokens?: number;
      };
    };
  };
  return async ({
    stepNumber,
    messages,
    steps,
  }: {
    stepNumber: number;
    messages: ModelMessage[];
    steps: StepEntry[];
    // biome-ignore lint/suspicious/noExplicitAny: PrepareStepFunction generic is invariant
  }): Promise<any> => {
    let steeringImages: ImageAttachment[] | undefined;
    // Doppelganger: snapshot the current conversation for spark mirror mode.
    // Sparks receive this prefix so the API sees an identical cache-hit prefix.
    if (parentMessagesRef) {
      parentMessagesRef.current = messages;
    }

    const sanitized = sanitizeMessages(messages);

    // Abnormal-finish detection: ToolLoopAgent calls `notify()` for `onStepFinish`
    // which silently swallows thrown errors (ai/dist/index.mjs:519). prepareStep,
    // by contrast, IS awaited inline and throws propagate. So we sniff the prior
    // step's finishReason here and surface the failure as a real stream rejection.
    // Without this, finishReason="length" silently exits the loop (vercel/ai #13075).
    const prevStep = steps[steps.length - 1] as { finishReason?: string } | undefined;
    if (prevStep && isAbnormalFinish(prevStep.finishReason)) {
      throw new AbnormalFinishError(prevStep.finishReason);
    }

    const result: {
      messages?: ModelMessage[];
      model?: LanguageModel;
      providerOptions?: ProviderOptions;
      toolChoice?: "required" | "auto" | "none";
    } = {};

    // Proxy+Claude: prepend instructions as first user message every step
    // (ToolLoopAgent rebuilds messages fresh each step, so we must re-prepend).
    if (proxyInstructionsMessage) {
      result.messages = [proxyInstructionsMessage, ...sanitized];
    }

    // Forward code execution container ID between steps so the sandbox persists.
    // This reuses the same container (filesystem, installed packages) across steps.
    if (codeExecution && steps.length > 0) {
      // biome-ignore lint/suspicious/noExplicitAny: step metadata types vary by provider
      const forwarded = forwardAnthropicContainerIdFromLastStep({ steps: steps as any });
      if (forwarded?.providerOptions) {
        result.providerOptions = forwarded.providerOptions as ProviderOptions;
      }
    }

    // Plan gate: after a `plan` call, stop the tool loop (text-only).
    // Plans always require user approval — the agent must not auto-execute.
    if (stepNumber > 0 && lastStepHadPlanCall(messages)) {
      result.toolChoice = "none";
    }

    // Soul Map snapshot + skills are in the system prompt (instructions).
    // prepareStep only handles diffs (file changes since last step) and hints.
    const hints: string[] = [];
    let soulMapDiff: string | null = null;

    if (contextManager?.hasSoulMapDiff?.()) {
      soulMapDiff = contextManager.buildSoulMapDiff();
    }

    // ── Memory recall injection ──────────────────────────────────────
    // On every fresh user turn, ask the context manager for a recall pair
    // (cached by lastUserMessage + edited-files snapshot + memory generation
    // — see ContextManager.buildMemoryRecallMessages). When the pair changes,
    // splice it in just before the new user message so the agent reads
    // memory in context.
    if (contextManager) {
      const userTurnCount = countUserTurns(sanitized);
      if (userTurnCount > lastUserTurnCount) {
        lastUserTurnCount = userTurnCount;
        const lastUserIdx = findLastUserIndex(sanitized);
        const lastUserText = lastUserIdx >= 0 ? extractText(sanitized[lastUserIdx]) : "";
        if (lastUserText) {
          try {
            const pair = await contextManager.buildMemoryRecallMessages(lastUserText);
            if (pair && lastUserIdx >= 0) {
              recallInjects.push({
                cleanInsertAt: lastUserIdx,
                pair: [
                  {
                    role: "user" as const,
                    content: pair[0].content,
                    providerOptions: cacheOpts,
                  } as ModelMessage,
                  {
                    role: "assistant" as const,
                    content: pair[1].content,
                    providerOptions: cacheOpts,
                  } as ModelMessage,
                ],
              });
            }
          } catch {
            // Recall failures are silent — never break the step.
          }
        }
      }
    }

    // [6] Plan mode nudges — hint only, no activeTools forcing
    if (isPlanMode && stepNumber >= PLAN_NUDGE_STEP && !hasPlanToolCall(messages)) {
      if (stepNumber >= PLAN_FORCE_STEP) {
        hints.push("Call plan NOW with everything you have. You have enough context.");
      } else {
        hints.push(
          "You have gathered substantial context. Start assembling the plan — call plan when ready.",
        );
      }
    }

    // [4] Read nudges disabled — conversational hints cause "You're right" responses.
    // Read steering handled by system prompt ("max 3 exploration rounds").
    // [5] Loop detection — hint only, no activeTools blocking.
    // Memoization: JSON.stringify(part.input) cached per-part via WeakMap since
    // tool-call inputs are immutable. Slides a 16-message window — old entries
    // age out naturally, no manual eviction needed.
    if (!isPlanMode && stepNumber >= 3) {
      const LOOP_THRESHOLD = 3;
      const LOOP_WINDOW = 16;
      const callCounts = new Map<string, { toolName: string; count: number }>();
      const startIdx = Math.max(0, messages.length - LOOP_WINDOW);
      outer: for (let i = startIdx; i < messages.length; i++) {
        const m = messages[i];
        if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
        for (const part of m.content) {
          if (typeof part !== "object" || part === null || !("type" in part)) continue;
          const p = part as { type: string; toolName?: string; input?: unknown };
          if (p.type !== "tool-call" || !p.toolName) continue;
          let sig = loopSigCache.get(part as object);
          if (sig === undefined) {
            let argStr: string;
            try {
              argStr = JSON.stringify(p.input ?? {});
            } catch {
              argStr = "{}";
            }
            sig = `${p.toolName}::${argStr}`;
            loopSigCache.set(part as object, sig);
          }
          const entry = callCounts.get(sig);
          if (entry) {
            entry.count++;
            if (entry.count >= LOOP_THRESHOLD) {
              hints.push(
                `🔁 ${entry.toolName} called ${String(entry.count)}× with identical arguments — same result each time. Use the result you already have, or try a different tool/approach.`,
              );
              break outer;
            }
          } else {
            callCounts.set(sig, { toolName: p.toolName, count: 1 });
          }
        }
      }
    }

    // [8] Task list injection
    const taskBlock = renderTaskList(tabId);
    if (taskBlock) hints.push(taskBlock);

    // [7] Cross-tab claims
    if (contextManager) {
      const crossTab = contextManager.buildCrossTabSection();
      if (crossTab) hints.push(crossTab);
    }

    // [7.6] Commit-boundary reminder. Tool work renders as a collapsed rail;
    // set_lockin({on:false}) marks the boundary so the final answer streams visibly.
    // Server never inspects or mutates display state — the renderer reads the call directly.
    //
    // Recompute fresh every step from the full message history of THIS user turn —
    // catches parallel tool blocks in a single step (which prev.toolCalls misses
    // when text + tools share one assistant message). Re-fires every step the
    // constraint is violated — no latch.
    {
      // Walk back to the most recent user message; tally tool calls + lockin commit after it.
      let toolCallsThisTurn = 0;
      let committedThisTurn = false;
      for (let i = sanitized.length - 1; i >= 0; i--) {
        const m = sanitized[i];
        if (!m) continue;
        if (m.role === "user") break;
        if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
        for (const part of m.content) {
          if (typeof part !== "object" || part === null || !("type" in part)) continue;
          const p = part as { type: string; toolName?: string; input?: { on?: boolean } };
          if (p.type !== "tool-call") continue;
          toolCallsThisTurn++;
          if (p.toolName === "set_lockin" && p.input?.on === false) {
            committedThisTurn = true;
          }
        }
      }
      if (!committedThisTurn && toolCallsThisTurn >= 2) {
        hints.push(
          "Multiple tool calls this turn without a commit boundary. Call set_lockin({on:false}) as your LAST tool before your final answer so prior tool work collapses into the rail and your text streams visibly.",
        );
      }
    }

    // [7.5] Persona reinforcement — fights drift in long sessions.
    // Cached system prompt loses attention weight as messages accumulate; the model's own
    // prior outputs (any narration that slipped through) reinforce drift via few-shot effect.
    // A small nudge every PERSONA_NUDGE_INTERVAL steps re-anchors the voice without
    // invalidating prompt cache (appended as user message, same as other hints).
    if (
      stepNumber >= PERSONA_NUDGE_START &&
      (stepNumber - PERSONA_NUDGE_START) % PERSONA_NUDGE_INTERVAL === 0
    ) {
      hints.push(PERSONA_NUDGE);
    }

    // Assemble tail content: diffs + hints + steering.
    // System prompt has the snapshot; prepareStep only adds ephemeral updates.
    const tailParts: string[] = [];

    if (soulMapDiff) tailParts.push(soulMapDiff);

    if (hints.length > 0) {
      tailParts.push(...hints.map((h) => `<system-reminder>\n${h}\n</system-reminder>`));
    }
    if (stepNumber > 0 && drainSteering) {
      const steering = drainSteering();
      if (steering) {
        tailParts.push(
          `<steering>\nThe user just sent a new message while you were working:\n\n${steering.text}\n\nFinish any in-progress tool call, then switch entirely to this message in your next response.\n</steering>`,
        );
        // Thread steering images into the inject message
        if (steering.images && steering.images.length > 0) {
          steeringImages = steering.images;
        }
      }
    }

    // Re-insert previous injects + append new one for cache-stable prefix.
    // The ToolLoopAgent rebuilds messages fresh each step (initialMessages + responseMessages),
    // discarding our injected user messages. We re-insert them at their original positions
    // so Anthropic sees a byte-identical, append-only prefix → auto-cache hits.
    //
    // Position tracking uses cleanInsertAt — the index in the CLEAN message array
    // (before any re-insertions). This ensures correct placement across steps:
    //   Step N:   [...clean_17, INJECT_9]
    //   Step N+1: [...clean_17, INJECT_9, asst, tool, INJECT_10]
    //   Step N+2: [...clean_17, INJECT_9, asst, tool, INJECT_10, asst, tool, INJECT_11]
    if (tailParts.length > 0 || previousInjects.length > 0 || recallInjects.length > 0) {
      const msgs = result.messages ?? [...sanitized];
      const cleanMsgCount = msgs.length;

      // Combine prior injects (tail user-msgs + recall pairs) sorted by their
      // CLEAN insert index, then splice them in left-to-right with a running
      // offset. Tail injects use cleanInsertAt = clean tail; recall pairs use
      // cleanInsertAt = the user-message index they were attached to.
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

      // Append the new inject (if any content this step)
      if (tailParts.length > 0) {
        const contentParts: Array<
          { type: "text"; text: string } | { type: "image"; image: Buffer; mediaType?: string }
        > = [{ type: "text" as const, text: tailParts.join("\n\n") }];
        if (steeringImages) {
          for (const img of steeringImages) {
            const raw = Buffer.from(img.base64, "base64");
            const { data, mediaType } = await compressImageForApi(raw, img.mediaType);
            contentParts.push({
              type: "image" as const,
              image: data,
              mediaType,
            });
          }
        }
        const injectMessage: ModelMessage = {
          role: "user" as const,
          content: contentParts,
        };
        previousInjects.push({ cleanInsertAt: cleanMsgCount, message: injectMessage });
        msgs.push(injectMessage);
      }

      result.messages = msgs;
    }

    // [9] Debug API logging
    if (process.env.SOULFORGE_DEBUG_API) {
      const msgs = result.messages ?? sanitized;
      const dump = msgs
        .map((m, i) => {
          const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          const preview = raw.slice(0, 300);
          return `[${String(i)}] ${m.role} (${String(raw.length)} chars): ${preview}${raw.length > 300 ? "..." : ""}`;
        })
        .join("\n---\n");
      import("../tools/tee.js").then(({ saveTee }) => {
        saveTee(
          `forge-step-${String(stepNumber)}`,
          `Forge Step ${String(stepNumber)} — ${String(msgs.length)} messages\n\n=== MESSAGES ===\n${dump}`,
        );
      });
    }

    // [10] API export logging
    if (isApiExportEnabled()) {
      const msgs = result.messages ?? sanitized;
      const serializeContent = (content: unknown): unknown => {
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return String(content);
        return (content as Record<string, unknown>[]).map((p) => {
          if (p.type === "tool-call") {
            return {
              type: "tool-call",
              toolCallId: p.toolCallId,
              toolName: p.toolName,
              input: typeof p.input === "string" ? p.input : JSON.stringify(p.input),
            };
          }
          if (p.type === "tool-result") {
            const out = p.output as Record<string, unknown> | undefined;
            const text =
              out?.type === "text"
                ? String(out.value ?? "")
                : out?.type === "json"
                  ? JSON.stringify(out.value)
                  : JSON.stringify(out);
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
      const lastStep = steps.length > 0 ? steps[steps.length - 1] : undefined;
      const prevUsage = lastStep?.usage;
      const previousStepUsage = prevUsage
        ? (() => {
            const d = prevUsage.inputTokenDetails;
            const cacheRead = d?.cacheReadTokens ?? 0;
            const cacheWrite = d?.cacheWriteTokens ?? 0;
            const noCache = d?.noCacheTokens ?? 0;
            const inputTokens = prevUsage.inputTokens ?? 0;
            const cacheableInput = cacheRead + cacheWrite + noCache;
            const hitRatio = cacheableInput > 0 ? cacheRead / cacheableInput : 0;
            return {
              inputTokens,
              outputTokens: prevUsage.outputTokens ?? 0,
              cacheReadTokens: cacheRead,
              cacheWriteTokens: cacheWrite,
              noCacheTokens: noCache,
              cacheHitRatio: Number(hitRatio.toFixed(3)),
            };
          })()
        : null;

      const exportData = {
        agent: "forge",
        step: stepNumber,
        timestamp: new Date().toISOString(),
        messageCount: msgs.length,
        previousStepUsage,
        messages: msgs.map((m, i) => {
          const content = serializeContent(m.content);
          const charCount =
            typeof content === "string"
              ? content.length
              : Array.isArray(content)
                ? (content as Record<string, unknown>[]).reduce(
                    (s: number, p) =>
                      s +
                      (typeof p.content === "string" ? p.content.length : 0) +
                      (typeof p.text === "string" ? p.text.length : 0) +
                      (typeof p.input === "string" ? p.input.length : 0),
                    0,
                  )
                : 0;
          return {
            index: i,
            role: m.role,
            charCount,
            estimatedTokens: Math.ceil(charCount / 4),
            content,
          };
        }),
      };
      import("node:fs").then(({ mkdirSync, writeFileSync }) => {
        const dir = `${process.cwd()}/.soulforge/api-export`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          `${dir}/forge-step-${String(stepNumber).padStart(2, "0")}.json`,
          JSON.stringify(exportData, null, 2),
          "utf-8",
        );
      });
    }

    if (sanitized !== messages && !result.messages) {
      result.messages = sanitized;
    }

    // Commit diff after building result — if API call fails and retries,
    // buildSoulMapDiff returns the same pending diff instead of losing it
    if (soulMapDiff && contextManager) contextManager.commitSoulMapDiff();

    return Object.keys(result).length > 0 ? result : undefined;
  };
}

const instructionsCache = new WeakMap<
  ContextManager,
  { text: string; key: string; size?: number }
>();

function buildInstructions(cm: ContextManager, modelId: string): string {
  const key = cm.getInstructionsCacheKey(modelId);
  const cached = instructionsCache.get(cm);
  if (cached && cached.key === key) return cached.text;
  const parts = [cm.buildSystemPrompt(modelId)];
  const snapshot = cm.buildSoulMapSnapshot(false);
  if (snapshot) parts.push(snapshot);
  const skills = cm.buildSkillsBlock();
  if (skills) parts.push(skills);
  const text = parts.join("\n\n");
  if (snapshot) instructionsCache.set(cm, { text, key, size: text.length });
  return text;
}

/** Returns the cached size (in chars) of the last built instructions for this context manager.
 *  Returns undefined when no cached entry exists (e.g. no Soul Map snapshot yet at time of build). */
export function getCachedInstructionsSize(cm: ContextManager): number | undefined {
  return instructionsCache.get(cm)?.size;
}

interface ForgeAgentOptions {
  model: LanguageModel;
  /** Full model ID with provider prefix, e.g. "proxy/claude-sonnet-4-6" */
  fullModelId?: string;
  contextManager: ContextManager;
  forgeMode?: ForgeMode;
  interactive?: InteractiveCallbacks;
  editorIntegration?: EditorIntegration;
  subagentModels?: {
    /** Model for ⚡ spark agents — explore/investigate. */
    spark?: LanguageModel;
    /** Model for 🔥 ember agents — code edits. */
    ember?: LanguageModel;
    desloppify?: LanguageModel;
    verify?: LanguageModel;
  };
  webSearchModel?: LanguageModel;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  onApproveFetchPage?: (url: string) => Promise<boolean>;
  onApproveOutsideCwd?: (toolName: string, path: string) => Promise<boolean>;
  onApproveDestructive?: (description: string) => Promise<boolean>;
  providerOptions?: ProviderOptions;
  headers?: Record<string, string>;
  codeExecution?: boolean;
  computerUse?: boolean;
  anthropicTextEditor?: boolean;
  cwd?: string;
  sessionId?: string;
  sharedCacheRef?: SharedCacheRef;
  agentFeatures?: AgentFeatures;
  planExecution?: boolean;
  drainSteering?: () => { text: string; images?: ImageAttachment[] } | null;
  disablePruning?: boolean;
  disabledTools?: Set<string>;
  tabId?: string;
  tabLabel?: string;
}

/** Creates the main Forge ToolLoopAgent — model can change between turns (Ctrl+L). */
export function createForgeAgent({
  model,
  fullModelId,
  contextManager,
  forgeMode = "default",
  interactive,
  editorIntegration,
  subagentModels,
  webSearchModel,
  onApproveWebSearch,
  onApproveFetchPage,
  onApproveOutsideCwd,
  onApproveDestructive,
  providerOptions,
  headers,
  codeExecution,
  computerUse,
  anthropicTextEditor,
  cwd,
  sessionId,
  sharedCacheRef,
  agentFeatures,
  planExecution,
  drainSteering,
  disablePruning,
  disabledTools,
  tabId,
  tabLabel,
}: ForgeAgentOptions) {
  const isRestricted = RESTRICTED_MODES.has(forgeMode);
  const repoMap = contextManager.isRepoMapReady() ? contextManager.getRepoMap() : undefined;
  const skills = contextManager.getActiveSkillEntries();

  // Auto mode: bypass all permission prompts — fully autonomous execution.
  const autoApprove = () => Promise.resolve(true);
  const effectiveApproveWebSearch = forgeMode === "auto" ? autoApprove : onApproveWebSearch;
  const effectiveApproveFetchPage = forgeMode === "auto" ? autoApprove : onApproveFetchPage;
  const effectiveApproveOutsideCwd =
    forgeMode === "auto" ? (autoApprove as typeof onApproveOutsideCwd) : onApproveOutsideCwd;
  const effectiveApproveDestructive = forgeMode === "auto" ? autoApprove : onApproveDestructive;

  const modelId =
    typeof model === "object" && model !== null && "modelId" in model
      ? String((model as { modelId: string }).modelId)
      : "";
  // Ensure ContextManager knows the model before building the system prompt
  // (family-specific prompt selection depends on this)
  if (modelId) contextManager.setActiveModel(modelId);
  const isAnthropic = isAnthropicNative(modelId);

  // CLIProxyAPI cloaking: when using proxy + Claude, the proxy replaces the system
  // prompt with Claude Code's system prompt and demotes ours to a user message (where
  // it gets lost). Bypass this by sending our instructions as the first user message
  // instead of as a system prompt — the proxy won't touch user messages.
  const isProxyClaude =
    fullModelId?.startsWith("proxy/") && detectModelFamily(fullModelId) === "claude";
  const toolVersions = getAnthropicToolVersions(modelId);
  // Code execution (20260120) requires programmatic tool calling — skip entirely for models
  // that don't support it (e.g. Haiku). Basic code execution (20250825) isn't useful here
  // since SoulForge's value comes from programmatic tool batching, and mixing tool versions
  // causes auto-injection conflicts with the API.
  const canUseCodeExecution = codeExecution && isAnthropic && toolVersions.programmaticToolCalling;

  const onDemandEnabled = !disabledTools?.has("request_tools") && !isRestricted && !planExecution;
  const activeDeferredTools = onDemandEnabled ? new Set<string>() : undefined;

  const directTools = buildTools(undefined, editorIntegration, effectiveApproveWebSearch, {
    codeExecution: canUseCodeExecution,
    computerUse: computerUse && isAnthropic && toolVersions.computerUse != null,
    anthropicTextEditor: anthropicTextEditor && isAnthropic && toolVersions.textEditor != null,
    toolVersions: {
      computerUse: toolVersions.computerUse ?? undefined,
      textEditor: toolVersions.textEditor ?? undefined,
      programmaticToolCalling: toolVersions.programmaticToolCalling,
    },
    contextManager,
    agentSkills: !disabledTools?.has("skills"),
    webSearchModel,
    repoMap,
    onApproveFetchPage: effectiveApproveFetchPage,
    onApproveOutsideCwd: effectiveApproveOutsideCwd,
    onApproveDestructive: effectiveApproveDestructive,
    tabId: tabId ?? contextManager.getTabId() ?? undefined,
    tabLabel: tabLabel ?? contextManager.getTabLabel() ?? undefined,
    activeDeferredTools,
  });

  // Reorder tools: soul tools → LSP → core. Models prefer tools earlier in the list,
  // and soul tools are TIER-1 (cheapest, most informative). This ordering reinforces
  // the decision flow in the system prompt without adding tokens.
  const STABLE_ORDER = [
    // Lock-in control (auto mode only) — first so model sees it immediately
    "set_lockin",
    // TIER-1: Soul tools (cheapest, graph-backed)
    "soul_grep",
    "soul_find",
    "soul_analyze",
    "soul_impact",
    // TIER-1: LSP tools
    "navigate",
    "analyze",
    // TIER-1: Core read/edit
    "read",
    "edit_file",
    "multi_edit",
    "project",
    // TIER-2: Search fallbacks
    "grep",
    "glob",
    "list_dir",
    // TIER-2: Shell & git
    "shell",
    "git",
    // TIER-3: Compound operations
    "refactor",
    "rename_symbol",
    "move_symbol",
    "rename_file",
    // Discovery
    "discover_pattern",
    // Web
    "web_search",
    "fetch_page",
    // Agent & interactive
    "dispatch",
    "plan",
    "update_plan_step",
    "ask_user",
    // Editor & session
    "editor",
    "task_list",
    "undo_edit",
    // Memory & skills
    "memory",
    "skills",
    // Tool management
    "request_tools",
    "release_tools",
    // Anthropic optional
    "code_execution",
    "web_fetch",
    "computer",
    "str_replace_based_edit_tool",
  ];
  const orderedTools: Record<string, unknown> = {};
  for (const name of STABLE_ORDER) {
    if (name in directTools) orderedTools[name] = (directTools as Record<string, unknown>)[name];
  }
  for (const [name, def] of Object.entries(directTools)) {
    if (!(name in orderedTools)) orderedTools[name] = def;
  }

  {
    const mcpTools = getMCPManager().getTools();
    for (const [name, def] of Object.entries(mcpTools)) {
      orderedTools[name] = def;
    }
  }

  // Spark mode: share the forge system prompt + tool definitions with subagents for prefix cache hits.
  // The Anthropic cache prefix is tools → system → messages. Sharing both tools AND instructions
  // means the entire [tools + system] prefix is a cache HIT on every spark's first step.
  // buildInstructions is WeakMap-cached, so this call is effectively free.
  const forgeInstructions = buildInstructions(contextManager, modelId);
  const forgeTools = orderedTools;

  // Doppelganger ref: mutable container updated by prepareStep on every forge step.
  // Spark mirror agents clone from this snapshot — they inherit the full conversation prefix
  // so the API sees an identical cache-hit prefix (tools + system + messages).
  const parentMessagesRef: { current: ModelMessage[] | null } = { current: null };

  // OpenAI prompt cache routing: session-level key co-locates requests sharing
  // the same prefix on the same backend, improving hit rates (~60% → ~87%).
  const subagentHeaders =
    detectModelFamily(modelId) === "openai" && sessionId
      ? { ...headers, "x-prompt-cache-key": sessionId }
      : headers;

  const subagentTools = isRestricted
    ? {
        dispatch: buildSubagentTools({
          defaultModel: model,
          sparkModel: subagentModels?.spark,
          webSearchModel,
          providerOptions,
          headers: subagentHeaders,
          onApproveWebSearch: effectiveApproveWebSearch,
          onApproveFetchPage: effectiveApproveFetchPage,
          readOnly: true,
          repoMap,
          sharedCacheRef,
          agentFeatures,
          skills,
          disablePruning,
          tabId: tabId ?? contextManager.getTabId() ?? undefined,
          forgeInstructions,
          forgeTools,
          parentMessagesRef,
        }).dispatch,
      }
    : buildSubagentTools({
        defaultModel: model,
        sparkModel: subagentModels?.spark,
        emberModel: subagentModels?.ember,
        desloppifyModel: subagentModels?.desloppify,
        verifyModel: subagentModels?.verify,
        webSearchModel,
        providerOptions,
        headers: subagentHeaders,
        onApproveWebSearch: effectiveApproveWebSearch,
        onApproveFetchPage: effectiveApproveFetchPage,
        repoMap,
        sharedCacheRef,
        agentFeatures,
        skills,
        disablePruning,
        tabId: tabId ?? contextManager.getTabId() ?? undefined,
        forgeInstructions,
        forgeTools,
        parentMessagesRef,
      });

  // Plan mode requires `plan`/`update_plan_step` tools; `ask_user` is broadly useful too.
  // When no `interactive` callbacks are provided (headless, edge cases on session resume),
  // build the interactive tools with safe no-op fallbacks so the model can still call them.
  // The `plan` tool persists its result to .soulforge/plans/ regardless, so the plan is
  // recoverable even when no UI approval flow is wired.
  const interactiveCallbacks: InteractiveCallbacks = interactive ?? {
    onPlanCreate: () => {},
    onPlanStepUpdate: () => {},
    onPlanReview: async () => "execute" as const,
    onAskUser: async (_q, options, allowSkip) =>
      allowSkip ? "__skipped__" : (options[0]?.value ?? ""),
    onOpenEditor: async () => {},
    onWebSearchApproval: async () => true,
    onFetchPageApproval: async () => true,
  };

  const allTools = {
    ...orderedTools,
    ...subagentTools,
    ...buildInteractiveTools(interactiveCallbacks, { cwd, sessionId, forgeMode }),
  };

  // Cache breakpoints: system prompt (via instructions) + first 2 messages.
  // Total: 3 breakpoints. The system+tools prefix is the biggest stable cache.

  const allToolNames = Object.keys(allTools) as (keyof typeof allTools)[];
  const restrictedSet = new Set(RESTRICTED_TOOL_NAMES);
  const planExecSet = new Set(PLAN_EXECUTION_TOOL_NAMES);

  const coreSet = activeDeferredTools ? new Set(CORE_TOOL_NAMES) : undefined;

  const computeActiveTools = (): (keyof typeof allTools)[] | undefined => {
    if (isRestricted) return allToolNames.filter((name) => restrictedSet.has(name));
    if (planExecution) return allToolNames.filter((name) => planExecSet.has(name));

    let names = allToolNames;

    // Agent-managed mode: only expose core tools + explicitly requested deferred tools
    if (activeDeferredTools && coreSet) {
      names = names.filter((name) => coreSet.has(name) || activeDeferredTools.has(name));
    }

    // User-disabled tools via /tools popup
    if (disabledTools && disabledTools.size > 0) {
      names = names.filter((name) => !disabledTools.has(name));
    }

    return names.length < allToolNames.length ? names : undefined;
  };

  const cacheTtl: CacheTTL = loadConfig().cache?.ttl ?? "5m";
  const cacheOpts = getEphemeralCache(cacheTtl);

  const wrappedProviderOptions = {
    ...providerOptions,
    anthropic: {
      ...(((providerOptions as Record<string, unknown>)?.anthropic as Record<string, unknown>) ??
        {}),
      cacheControl: { type: "ephemeral", ttl: cacheTtl },
      // Mirror SDK-level maxOutputTokens onto the Anthropic request body so gateways/proxies
      // that strip non-native fields still see a real cap. Without this, llmgateway and
      // similar OpenAI-compatible proxies fall back to Anthropic's 1024-token default,
      // truncating mid-tool-call → silent agent stop (vercel/ai #13075, opencode #18108).
      max_tokens: MAX_OUTPUT_TOKENS,
    },
  } as ProviderOptions;

  const { maxTransientRetries: retryMaxRetries } = resolveRetrySettings(loadConfig().retry);

  return new ToolLoopAgent({
    id: "forge",
    model,
    maxRetries: retryMaxRetries,
    ...(supportsTemperature(fullModelId ?? getModelId(model)) ? { temperature: 0 } : {}),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    tools: allTools,
    stopWhen: () => false,
    onStepFinish: (step) => {
      if (isAbnormalFinish(step.finishReason)) {
        logBackgroundError("agent-error", `forge: ${describeAbnormalFinish(step.finishReason)}`);
        // NOTE: throwing here is swallowed by the SDK's notify() (ai/dist/index.mjs:519).
        // Actual surfacing happens in prepareStep — see buildForgePrepareStep above.
      }
    },
    instructions: isProxyClaude
      ? undefined
      : {
          role: "system" as const,
          content: buildInstructions(contextManager, modelId),
          providerOptions: cacheOpts,
        },
    callOptionsSchema: z.object({
      userMessage: z.string().nullable(),
    }),
    prepareCall: ({ options: _options, ...settings }) => {
      const activeTools = computeActiveTools();
      return {
        ...settings,
        ...(activeTools ? { activeTools } : {}),
      };
    },
    prepareStep: buildForgePrepareStep(
      forgeMode === "plan",
      drainSteering,
      contextManager,
      tabId,
      canUseCodeExecution,
      parentMessagesRef,
      isProxyClaude ? buildInstructions(contextManager, modelId) : undefined,
      cacheOpts,
    ),
    experimental_repairToolCall: repairToolCall,
    providerOptions: wrappedProviderOptions,
    ...(subagentHeaders ? { headers: subagentHeaders } : {}),
  });
}

function countUserTurns(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === "user") n++;
  }
  return n;
}

function findLastUserIndex(messages: ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

function extractText(message: ModelMessage | undefined): string {
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
