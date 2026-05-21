import type { ModelMessage, ProviderOptions } from "@ai-sdk/provider-utils";
import { type LanguageModel, RetryError } from "ai";
import { logBackgroundError } from "../../stores/errors.js";
import type { TaskTier } from "../../types/index.js";
import { getActiveProviderId } from "../llm/provider.js";
import { getSurfacedHintIds, runInSubagentScope } from "../memory/hints.js";
import { bounceProxy, proxyHealthProbe } from "../proxy/lifecycle.js";
import { taskListTool } from "../tools/task-list.js";
import {
  type AgentBus,
  type AgentTask,
  type AgentResult as BusAgentResult,
  DependencyFailedError,
  normalizePath,
} from "./agent-bus.js";
import {
  busFooter,
  type DoneToolResult,
  extractFinalText,
  truncateAgentText,
  writeAgentContext,
} from "./agent-results.js";
import { codeBase } from "./code.js";
import { exploreBase } from "./explore.js";
import { emitMultiAgentEvent } from "./subagent-events.js";
import { buildStepCallbacks, createAgent, type SubagentModels } from "./subagent-tools.js";

const MAX_NO_EDIT_RETRIES = 1;

import { loadConfig } from "../../config/index.js";
import { resolveRetrySettings } from "../retry/settings.js";

const DEFAULT_MAX_CONCURRENT_AGENTS = 3;

export function getMaxConcurrentAgents(): number {
  const v = loadConfig().taskRouter?.maxConcurrentAgents;
  if (v == null || !Number.isFinite(v)) return DEFAULT_MAX_CONCURRENT_AGENTS;
  return Math.min(8, Math.max(2, Math.round(v)));
}

import { recordModelCall } from "../../stores/model-events.js";
import { getToolTimeoutMs } from "../tools/tool-timeout.js";

/** 0 = no timeout (for generate calls). For waitForAgent, use getAgentWaitMs(). */
export function getAgentTimeoutMs(): number {
  const toolMs = getToolTimeoutMs();
  if (toolMs === 0) return 0;
  return Math.max(300_000, toolMs * 2.5);
}

/** Timeout for waiting on dependency agents. Never 0 (uses 24h ceiling). */
export function getAgentWaitMs(): number {
  const ms = getAgentTimeoutMs();
  return ms === 0 ? 86_400_000 : ms;
}
const RETRY_JITTER_MS = 1000;

const RETURN_FORMAT_INSTRUCTIONS: Record<import("./agent-bus.js").ReturnFormat, string> = {
  summary:
    "Return concise findings and reasoning. No code blocks or raw file content. " +
    "Focus on what you found, what it means, and what the implications are. " +
    "Anchor every claim with file:line so the parent can surgically read more.",
  code:
    "Return pasteable code snippets with file paths and line numbers. " +
    "Every finding MUST include the actual code. The parent agent is BLIND to your tool results. " +
    "Skip structure the parent already has (exports, signatures). Show internals: logic, values, wiring.",
  files:
    "Return file paths only, each with a one-line description of what was found or changed. " +
    "No code blocks, no detailed analysis. Just the list.",
  full:
    "Return complete analysis with file:line anchors on every claim. " +
    "The parent already has the Soul Map (file paths, exported symbols, signatures, dependency edges). " +
    "Don't repeat structure — report internals: function body logic, concrete values, lookup tables, " +
    "store selectors, data transformations, call chains with args. Paste key code snippets inline.",
  verdict:
    "Return a clear yes/no answer with a brief justification (1-3 sentences). " +
    "No code blocks unless they directly support the verdict.",
};

function isRetryable(error: unknown, abortSignal?: AbortSignal): boolean {
  if (error instanceof DependencyFailedError) return false;
  // User-initiated abort (parent dispatch cancelled) — don't retry
  if (abortSignal?.aborted) return false;
  // AI SDK wraps retried failures in RetryError — always retry at our level too
  if (RetryError.isInstance(error)) return true;
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("overloaded") ||
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("529") ||
    lower.includes("503") ||
    lower.includes("too many requests") ||
    lower.includes("capacity") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("fetch failed") ||
    lower.includes("failed to fetch") ||
    lower.includes("cannot connect") ||
    lower.includes("network") ||
    lower.includes("socket hang up") ||
    lower.includes("aborted")
  );
}

const CONNECTION_ERROR_RE =
  /cannot connect|unable to connect|fetch failed|failed to fetch|socket hang up|econnreset|econnrefused|enotfound|eai_again|network error|stream (?:error|closed)|premature close|terminated|connection (?:error|reset|refused|closed)/i;

function isConnectionError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return CONNECTION_ERROR_RE.test(msg);
}

const PROXY_BOUNCE_TIMEOUT_MS = 8000;

/**
 * Self-heal the proxy after a connection failure. Bounces at most once per
 * call and is hard-capped by a timeout so a wedged child process can never
 * block the retry loop. Returns true if a bounce was performed.
 */
async function selfHealProxyIfNeeded(error: unknown): Promise<boolean> {
  if (getActiveProviderId() !== "proxy") return false;
  if (!isConnectionError(error)) return false;
  // Don't bounce a healthy child process. If /v1/models answers, the proxy
  // is fine and the error is genuinely upstream (Claude subscription flake,
  // rate limit, session refresh) — bouncing wastes the retry budget.
  if (await proxyHealthProbe()) return false;
  try {
    await Promise.race([
      bounceProxy(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PROXY_BOUNCE_TIMEOUT_MS)),
    ]);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Extract model ID string from a LanguageModel object. */
function getModelId(model: LanguageModel): string {
  return typeof model === "object" && "modelId" in model ? String(model.modelId) : "unknown";
}

/** Classify a task into spark (same model, cache sharing) or ember (different model, lean tools). */
export function classifyTask(task: AgentTask, models?: SubagentModels): TaskTier {
  // Explicit tier from dispatch schema takes priority
  if (task.tier) return task.tier;

  // Code agents are always embers — they need their own coding model and tools
  if (task.role === "code") return "ember";

  // Explore — spark only if the explore model matches the parent (cache sharing).
  // Different model = different cache namespace = no benefit from spark overhead.
  if (models?.sparkModel) {
    const sparkId = getModelId(models.sparkModel);
    const parentId = getModelId(models.defaultModel);
    if (sparkId !== parentId) return "ember";
  }

  return "spark";
}

export function selectModel(task: AgentTask, models: SubagentModels): { model: LanguageModel } {
  const tier = classifyTask(task, models);

  // Spark: same model as parent for cache sharing
  if (tier === "spark") {
    return { model: models.sparkModel ?? models.defaultModel };
  }

  // Ember: explore uses sparkModel (cheaper), code uses emberModel
  if (task.role !== "code" && models.sparkModel) {
    return { model: models.sparkModel };
  }
  return { model: models.emberModel ?? models.defaultModel };
}

export function stripContextManagement(opts?: ProviderOptions): ProviderOptions | undefined {
  if (!opts) return opts;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [provider, val] of Object.entries(opts)) {
    if (val && typeof val === "object" && "contextManagement" in val) {
      const { contextManagement: _, ...rest } = val as Record<string, unknown>;
      out[provider] = rest;
      changed = true;
    } else {
      out[provider] = val;
    }
  }
  return changed ? (out as ProviderOptions) : opts;
}

export async function runAgentTask(
  task: AgentTask,
  models: SubagentModels,
  bus: AgentBus,
  parentToolCallId: string,
  totalAgents: number,
  abortSignal?: AbortSignal,
): Promise<{
  doneResult: DoneToolResult | null;
  resultText: string;
  callbacks: ReturnType<typeof buildStepCallbacks>;
  result: BusAgentResult;
}> {
  if (task.dependsOn && task.dependsOn.length > 0) {
    try {
      await Promise.all(
        task.dependsOn.map((dep) => bus.waitForAgent(dep, task.timeoutMs ?? getAgentWaitMs())),
      );
    } catch (err) {
      if (err instanceof DependencyFailedError) {
        const errMsg = `Skipped: dependency "${err.depAgentId}" failed`;
        const agentResult = {
          agentId: task.agentId,
          role: task.role,
          task: task.task,
          result: errMsg,
          success: false,
          error: errMsg,
        } satisfies BusAgentResult;
        bus.setResult(agentResult);
        emitMultiAgentEvent({
          parentToolCallId,
          type: "agent-error",
          agentId: task.agentId,
          role: task.role,
          task: task.task,
          totalAgents,
          error: errMsg,
        });
        return {
          doneResult: null,
          resultText: errMsg,
          callbacks: buildStepCallbacks(parentToolCallId, task.agentId),
          result: agentResult,
        };
      }
      throw err;
    }
  }

  const taskTier = classifyTask(task, models);
  const { model: selectedModel } = selectModel(task, models);
  const selectedModelId =
    typeof selectedModel === "object" && "modelId" in selectedModel
      ? String(selectedModel.modelId)
      : "unknown";
  emitMultiAgentEvent({
    parentToolCallId,
    type: "agent-start",
    agentId: task.agentId,
    role: task.role,
    task: task.task,
    totalAgents,
    modelId: selectedModelId,
    tier: taskTier,
  });
  if (task.taskId != null) {
    taskListTool.execute({
      action: "update",
      id: task.taskId,
      status: "in-progress",
      tabId: task.tabId,
    });
  }

  const peerFindings = bus.summarizeFindings(task.agentId);
  const depResults = task.dependsOn
    ?.map((dep) => {
      const r = bus.getResult(dep);
      return r ? `[${dep}] completed:\n${r.result}` : null;
    })
    .filter(Boolean)
    .join("\n\n");

  const peerObjectives = bus.getPeerObjectives(task.agentId);

  const failedDeps =
    task.dependsOn?.filter((dep) => {
      const r = bus.getResult(dep);
      return r && !r.success;
    }) ?? [];

  let enrichedPrompt = task.task;

  const taskTargetFiles = new Set<string>((task.targetFiles ?? []).map((f) => normalizePath(f)));

  if (taskTargetFiles.size > 0) {
    const peerTasks = bus.tasks.filter((t) => t.agentId !== task.agentId);
    const overlaps: string[] = [];
    for (const peer of peerTasks) {
      if (!peer.targetFiles) continue;
      const peerFiles = new Set(peer.targetFiles.map((f) => normalizePath(f)));
      for (const file of taskTargetFiles) {
        if (peerFiles.has(file)) {
          overlaps.push(`${peer.agentId} also targets ${file}`);
        }
      }
    }
    if (overlaps.length > 0) {
      enrichedPrompt += `\n\nShared files: ${overlaps.join("; ")}. Check their findings before reading.`;
    }
  }

  if (peerObjectives) {
    enrichedPrompt += `\n\n--- Peer agents ---\n${peerObjectives}`;
  }
  if (depResults) {
    enrichedPrompt += `\n\n--- Dependency results ---\n${depResults}`;
    if (failedDeps.length > 0) {
      enrichedPrompt += `\n\nWARNING: ${failedDeps.join(", ")} failed. Adapt your approach.`;
    }
  }
  if (peerFindings !== "No findings from peer agents yet.") {
    enrichedPrompt += `\n\n--- Peer findings so far ---\n${peerFindings}`;
  }

  if (task.returnFormat) {
    enrichedPrompt += `\n\n--- Return format: ${task.returnFormat} ---\n${RETURN_FORMAT_INSTRUCTIONS[task.returnFormat]}`;
  }

  // Doppelganger: sparks inherit the parent forge's full conversation —
  // same system prompt, same tools, same messages. No role preamble needed.
  const isDoppelganger =
    taskTier === "spark" &&
    models.parentMessagesRef?.current != null &&
    models.parentMessagesRef.current.length > 0;

  // Non-doppelganger sparks: inject role instructions into the user message.
  // Works across all providers — automatic caching (OpenAI, Gemini, DeepSeek) benefits from shared prefix.
  const useSpark = models.forgeInstructions != null && taskTier === "spark";
  if (useSpark && !isDoppelganger) {
    let rolePreamble: string;
    if (task.role === "code") {
      rolePreamble = codeBase();
      rolePreamble +=
        "\nOwnership: you own files you edit first. check_edit_conflicts before touching another agent's file.\nIf another agent owns the file: report_finding with the exact edit instead.\nCoordination: report_finding after significant changes (paths, what changed, new exports). Peer findings appear in tool results.";
    } else {
      rolePreamble = exploreBase();
      rolePreamble +=
        "\nCoordination: report_finding after discoveries — especially shared symbols/configs with peer targets. check_findings for peer detail.";
    }

    enrichedPrompt = `[Role: ${task.role} agent]\n${rolePreamble}\n\n[Task]\n${enrichedPrompt}`;
  }

  let lastError: unknown;
  let attemptsMade = 0;
  let proxyBounced = false;
  let lastAttemptStartedAt = Date.now();
  const { maxTransientRetries: MAX_RETRIES, baseDelayMs: BASE_DELAY_MS } = resolveRetrySettings(
    loadConfig().retry,
    { agent: true },
  );
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (abortSignal?.aborted) break;

    if (attempt > 0) {
      const jitter = Math.random() * RETRY_JITTER_MS;
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1) + jitter, abortSignal);
      if (abortSignal?.aborted) break;
    }

    try {
      attemptsMade = attempt + 1;
      const { agent } = await createAgent(task, models, bus, parentToolCallId);
      const callbacks = buildStepCallbacks(parentToolCallId, task.agentId, selectedModelId);
      const attemptStartedAt = Date.now();
      lastAttemptStartedAt = attemptStartedAt;

      // biome-ignore lint/suspicious/noExplicitAny: agent.generate result type varies with Output generic
      let result: any;
      try {
        const generateArgs = isDoppelganger
          ? {
              messages: [
                ...(models.parentMessagesRef?.current ?? []),
                {
                  role: "user" as const,
                  content: [{ type: "text" as const, text: enrichedPrompt }],
                } satisfies ModelMessage,
              ],
              abortSignal,
              ...(getAgentTimeoutMs() > 0 ? { timeout: { stepMs: getAgentTimeoutMs() } } : {}),
              ...callbacks,
            }
          : {
              prompt: enrichedPrompt,
              abortSignal,
              ...(getAgentTimeoutMs() > 0 ? { timeout: { stepMs: getAgentTimeoutMs() } } : {}),
              ...callbacks,
            };

        // Subagent-scoped memory hints — budget is per-agent, parent's
        // surfaced IDs seed dedup. Tab inherited so subagent sees the same
        // recently-surfaced set as its parent on first probe.
        const parentTabId = models.tabId;
        const parentSurfaced = getSurfacedHintIds(parentTabId);
        result = await runInSubagentScope(
          parentSurfaced,
          () => agent.generate(generateArgs),
          parentTabId,
        );
      } catch (genErr: unknown) {
        // Recover steps from error or callback accumulator so we can
        // synthesize results even when the agent errors mid-run.
        const errWithSteps = genErr as { steps?: unknown[]; text?: string; totalUsage?: unknown };
        const recoveredSteps =
          errWithSteps.steps && Array.isArray(errWithSteps.steps)
            ? errWithSteps.steps
            : callbacks._steps.length > 0
              ? callbacks._steps
              : [];

        if (recoveredSteps.length > 0 || errWithSteps.text) {
          const errObj = genErr as {
            text?: string;
            usage?: { inputTokens?: number; outputTokens?: number };
          };
          result = {
            text: errObj.text ?? "",
            steps: recoveredSteps,
            totalUsage: {
              inputTokens: errObj.usage?.inputTokens ?? callbacks._acc.input,
              outputTokens: errObj.usage?.outputTokens ?? callbacks._acc.output,
            },
          };
          logBackgroundError(
            task.agentId,
            `Agent error (${String(recoveredSteps.length)} steps recovered): ${genErr instanceof Error ? genErr.message : String(genErr)}`,
          );
        } else {
          throw genErr;
        }
      }

      let toolUses =
        callbacks._acc.toolUses ||
        result.steps.reduce(
          (sum: number, s: { toolCalls?: unknown[] }) => sum + (s.toolCalls?.length ?? 0),
          0,
        );
      let input = callbacks._acc.input || (result.totalUsage.inputTokens ?? 0);
      let output = callbacks._acc.output || (result.totalUsage.outputTokens ?? 0);
      let cacheRead =
        callbacks._acc.cacheRead || (result.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0);

      const agentFindings = bus.getFindings().filter((f) => f.agentId === task.agentId);
      let doneResult: DoneToolResult | null = null;

      // Pass agent text through verbatim — no synthesis. If empty, fall back
      // to a flat list of files touched via the bus.
      const agentText = extractFinalText(result);
      if (agentText.length > 0) {
        doneResult = { summary: agentText };
      } else {
        const busReads = bus.getFileReadRecords(task.agentId);
        const readPaths = [...new Set(busReads.map((r) => r.path))];
        const editPaths = [...bus.getEditedFiles(task.agentId).keys()];
        const fallback = busFooter(readPaths, editPaths);
        doneResult = {
          summary: fallback || `No output from agent for: ${task.task.slice(0, 200)}`,
        };
      }

      // succeeded = agent produced a result.
      // For code agents: must have actually edited files (read-only runs are failures).
      // For desloppify: no-edit is valid (clean code needs no fixes).
      const hasResult = !!doneResult && (doneResult.summary?.length ?? 0) > 0;
      const codeEdited =
        task.role !== "code" ||
        task.agentId === "desloppify" ||
        bus.getEditedFiles(task.agentId).size > 0;
      let succeeded = hasResult && codeEdited;

      // Auto-retry: code agent read files but made zero edits → focused retry
      if (!succeeded && task.role === "code" && attempt === 0 && task.agentId !== "desloppify") {
        const agentEdits = bus.getEditedFiles(task.agentId);
        const agentReads = bus.getFileReadRecords(task.agentId);
        if (agentEdits.size === 0 && agentReads.length > 0 && !abortSignal?.aborted) {
          const readPaths = [...new Set(agentReads.map((r) => r.path))];

          emitMultiAgentEvent({
            parentToolCallId,
            type: "agent-retry",
            agentId: task.agentId,
            role: task.role,
            task: task.task,
            totalAgents,
            warning: `Code agent read ${String(readPaths.length)} file(s) but made 0 edits — retrying with focused prompt`,
          });

          // Build a focused retry prompt referencing what was already read
          const retryPrompt =
            `RETRY: You already read these files but made ZERO edits:\n` +
            readPaths.map((p) => `  - ${p}`).join("\n") +
            `\n\nThe files are already cached — do NOT re-read them. Apply ALL the requested edits NOW using multi_edit.` +
            `\nOriginal task:\n${task.task}`;

          for (let retryAttempt = 0; retryAttempt < MAX_NO_EDIT_RETRIES; retryAttempt++) {
            try {
              const { agent: retryAgent } = await createAgent(task, models, bus, parentToolCallId);
              const retryCallbacks = buildStepCallbacks(
                parentToolCallId,
                task.agentId,
                selectedModelId,
              );

              // biome-ignore lint/suspicious/noExplicitAny: agent.generate result type varies with Output generic
              let retryResult: any;
              try {
                retryResult = await retryAgent.generate({
                  prompt: retryPrompt,
                  abortSignal,
                  ...(getAgentTimeoutMs() > 0 ? { timeout: { stepMs: getAgentTimeoutMs() } } : {}),
                  ...retryCallbacks,
                });
              } catch (retryGenErr: unknown) {
                const errWithSteps = retryGenErr as {
                  steps?: unknown[];
                  text?: string;
                };
                const recoveredSteps =
                  errWithSteps.steps && Array.isArray(errWithSteps.steps)
                    ? errWithSteps.steps
                    : retryCallbacks._steps.length > 0
                      ? retryCallbacks._steps
                      : [];

                if (recoveredSteps.length > 0 || errWithSteps.text) {
                  retryResult = {
                    text: errWithSteps.text ?? "",
                    steps: recoveredSteps,
                    totalUsage: {
                      inputTokens: retryCallbacks._acc.input,
                      outputTokens: retryCallbacks._acc.output,
                    },
                  };
                } else {
                  throw retryGenErr;
                }
              }

              // Check if retry produced edits
              const retryEdits = bus.getEditedFiles(task.agentId);
              if (retryEdits.size > 0) {
                // Retry succeeded — rebuild result from retry text verbatim
                const retryText = extractFinalText(retryResult);
                if (retryText.length > 0) {
                  doneResult = { summary: retryText };
                } else {
                  const editPaths = [...retryEdits.keys()];
                  doneResult = {
                    summary:
                      busFooter([], editPaths) ||
                      `Retry edited ${String(editPaths.length)} file(s)`,
                  };
                }
                succeeded = true;

                // Accumulate token usage from retry
                input += retryCallbacks._acc.input || (retryResult.totalUsage?.inputTokens ?? 0);
                output += retryCallbacks._acc.output || (retryResult.totalUsage?.outputTokens ?? 0);
                cacheRead +=
                  retryCallbacks._acc.cacheRead ||
                  (retryResult.totalUsage?.inputTokenDetails?.cacheReadTokens ?? 0);
                toolUses +=
                  retryCallbacks._acc.toolUses ||
                  retryResult.steps.reduce(
                    (sum: number, s: { toolCalls?: unknown[] }) => sum + (s.toolCalls?.length ?? 0),
                    0,
                  );
                break;
              }
            } catch {
              // Retry failed — fall through to original result
              break;
            }
          }
        }
      }

      // Build the agent's result text: agent's summary verbatim + bus footer.
      // Write the full text to disk; truncate the inline copy if oversized.
      const busReadPaths = [...new Set(bus.getFileReadRecords(task.agentId).map((r) => r.path))];
      const busEditPaths = [...bus.getEditedFiles(task.agentId).keys()];
      const footer = busFooter(busReadPaths, busEditPaths);
      const fullText = footer ? `${doneResult.summary}\n\n${footer}` : doneResult.summary;

      let archivePath: string | undefined;
      try {
        archivePath = await writeAgentContext(
          parentToolCallId,
          task.agentId,
          task,
          result,
          agentFindings,
          doneResult.summary,
          process.cwd(),
          task.tabId,
        );
      } catch {}

      const resultText = truncateAgentText(fullText, archivePath);
      doneResult.archivePath = archivePath;

      // Post-edit diff verification: confirm code agent edits actually changed files
      let editVerificationWarning: string | undefined;
      if (task.role === "code" && succeeded) {
        const editedFiles = bus.getEditedFiles(task.agentId);
        if (editedFiles.size > 0) {
          const noopEdits: string[] = [];
          const { readFile } = await import("node:fs/promises");
          const { resolve: resolvePath, isAbsolute } = await import("node:path");
          await Promise.all(
            [...editedFiles.keys()].map(async (editedPath) => {
              const cachedContent = bus.getFileContent(editedPath);
              if (cachedContent == null) return;
              try {
                const abs = isAbsolute(editedPath)
                  ? editedPath
                  : resolvePath(process.cwd(), editedPath);
                const diskContent = await readFile(abs, "utf-8");
                if (cachedContent === diskContent) {
                  noopEdits.push(editedPath);
                }
              } catch {}
            }),
          );
          if (noopEdits.length > 0) {
            editVerificationWarning = `Post-edit verification: ${String(noopEdits.length)} file(s) marked as edited but content unchanged: ${noopEdits.join(", ")}`;
          }
        }
      }

      const agentResult: BusAgentResult = {
        agentId: task.agentId,
        role: task.role,
        task: task.task,
        result: succeeded ? `[done] ${resultText}` : `[no-done] ${resultText}`,
        success: true,
      };
      bus.setResult(agentResult);

      emitMultiAgentEvent({
        parentToolCallId,
        type: "agent-done",
        agentId: task.agentId,
        role: task.role,
        task: task.task,
        totalAgents,
        completedAgents: bus.completedAgentIds.length,
        findingCount: bus.findingCount,
        toolUses,
        tokenUsage: { input, output, total: input + output },
        cacheHits: cacheRead > 0 ? cacheRead : undefined,
        resultChars: resultText.length,
        modelId: selectedModelId,
        tier: taskTier,
        succeeded,
        warning: editVerificationWarning,
      });
      if (editVerificationWarning) {
        emitMultiAgentEvent({
          parentToolCallId,
          type: "agent-warning",
          agentId: task.agentId,
          role: task.role,
          totalAgents,
          warning: editVerificationWarning,
        });
      }
      if (task.taskId != null) {
        taskListTool.execute({
          action: "update",
          id: task.taskId,
          status: "done",
          tabId: task.tabId,
        });
      }

      recordModelCall({
        modelId: selectedModelId,
        source: "subagent",
        startedAt: attemptStartedAt,
        durationMs: Math.max(0, Date.now() - attemptStartedAt),
        state: "ok",
        tabId: task.tabId,
        agentId: task.agentId,
        input,
        output,
        cacheRead,
      });

      return { doneResult, resultText, callbacks, result: agentResult };
    } catch (error) {
      lastError = error;
      if (isRetryable(error, abortSignal)) {
        const tripped = bus.recordProviderFailure();
        if (tripped || attempt === MAX_RETRIES) break;
        if (!proxyBounced && !abortSignal?.aborted) {
          proxyBounced = await selfHealProxyIfNeeded(error);
        }
      } else {
        break;
      }
    }
  }

  const errMsg =
    `Failed after ${String(attemptsMade)} attempt${attemptsMade === 1 ? "" : "s"}. ` +
    `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
  logBackgroundError(task.agentId, errMsg);

  const agentFindings = bus.getFindings().filter((f) => f.agentId === task.agentId);
  const agentReads = bus.getFileReadRecords(task.agentId);
  const agentEdits = [...bus.getEditedFiles().entries()]
    .filter(([_, editors]) => editors.includes(task.agentId))
    .map(([path]) => path);

  let salvaged = "";
  if (agentFindings.length > 0 || agentReads.length > 0 || agentEdits.length > 0) {
    const parts = [`Agent failed but produced partial results:`];
    if (agentReads.length > 0) {
      parts.push(`Files read: ${agentReads.map((r) => r.path).join(", ")}`);
    }
    if (agentEdits.length > 0) {
      parts.push(`Files edited: ${agentEdits.join(", ")}`);
    }
    for (const f of agentFindings) {
      parts.push(`Finding [${f.label}]: ${f.content}`);
    }
    salvaged = parts.join("\n");
  }

  const errorResultText = salvaged || errMsg;

  const agentResult: BusAgentResult = {
    agentId: task.agentId,
    role: task.role,
    task: task.task,
    result: errorResultText,
    success: salvaged.length > 0,
    error: errMsg,
  };
  bus.setResult(agentResult);

  emitMultiAgentEvent({
    parentToolCallId,
    type: salvaged ? "agent-done" : "agent-error",
    agentId: task.agentId,
    role: task.role,
    task: task.task,
    totalAgents,
    completedAgents: bus.completedAgentIds.length,
    findingCount: bus.findingCount,
    ...(salvaged ? {} : { error: errMsg }),
  });
  if (task.taskId != null) {
    taskListTool.execute({
      action: "update",
      id: task.taskId,
      status: salvaged ? "done" : "blocked",
      tabId: task.tabId,
    });
  }

  const doneResult: DoneToolResult | null = salvaged ? { summary: errorResultText } : null;

  recordModelCall({
    modelId: selectedModelId,
    source: "subagent",
    startedAt: lastAttemptStartedAt,
    durationMs: Math.max(0, Date.now() - lastAttemptStartedAt),
    state: "error",
    tabId: task.tabId,
    agentId: task.agentId,
    errorMessage: errMsg.slice(0, 500),
  });

  return {
    doneResult,
    resultText: errorResultText,
    callbacks: buildStepCallbacks(parentToolCallId, task.agentId),
    result: agentResult,
  };
}
