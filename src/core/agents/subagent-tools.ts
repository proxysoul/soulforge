import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { loadConfig } from "../../config/index.js";
import { logBackgroundError } from "../../stores/errors.js";
import type { AgentFeatures } from "../../types/index.js";
import { getWorkspaceCoordinator } from "../coordination/WorkspaceCoordinator.js";
import { getModelContextWindow } from "../llm/models.js";
import { buildProviderOptions, supportsProgrammaticToolCalling } from "../llm/provider-options.js";
import { wrapWithBusCache } from "../tools/bus-cache.js";
import { getActiveTaskTab } from "../tools/task-list.js";
import { deriveTool } from "../tools/tool-utils.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";
import { AgentBus, type AgentTask, normalizePath, type SharedCache } from "./agent-bus.js";
import { cleanupDispatchDir, type DispatchOutput, type DoneToolResult } from "./agent-results.js";
import {
  classifyTask,
  getAgentWaitMs,
  getMaxConcurrentAgents,
  runAgentTask,
  selectModel,
  sleep,
  stripContextManagement,
} from "./agent-runner.js";
import { runDesloppify, runVerifier } from "./agent-verification.js";
import { createCodeAgent } from "./code.js";
import { createExploreAgent } from "./explore.js";
import { isApiExportEnabled } from "./step-utils.js";
import { describeAbnormalFinish, isAbnormalFinish } from "./stream-options.js";
import { emitAgentStats, emitMultiAgentEvent, emitSubagentStep } from "./subagent-events.js";

export interface SharedCacheRef {
  current: SharedCache | undefined;
  updateFile(path: string, content: string): void;
}

export interface SubagentModels {
  defaultModel: LanguageModel;
  /** Model for ⚡ spark agents — explore/investigate. */
  sparkModel?: LanguageModel;
  /** Model for 🔥 ember agents — code edits. */
  emberModel?: LanguageModel;
  webSearchModel?: LanguageModel;
  desloppifyModel?: LanguageModel;
  verifyModel?: LanguageModel;
  providerOptions?: ProviderOptions;
  headers?: Record<string, string>;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  onApproveFetchPage?: (url: string) => Promise<boolean>;
  readOnly?: boolean;
  repoMap?: IntelligenceClient;
  sharedCacheRef?: SharedCacheRef;
  agentFeatures?: AgentFeatures;
  skills?: Array<{ name: string; content: string }>;
  disablePruning?: boolean;
  tabId?: string;
  forgeInstructions?: string;
  /** Forge tool definitions — shared with sparks for cache prefix hits. */
  forgeTools?: Record<string, unknown>;
  /** Mutable ref to the parent forge's conversation messages — used for doppelganger mode. */
  parentMessagesRef?: { current: import("@ai-sdk/provider-utils").ModelMessage[] | null };
}

// Tools that explore/investigate sparks must not execute.
// Definitions are still sent (same as forge) for cache prefix hits.
const EXPLORE_BLOCKED = new Set([
  "edit_file",
  "multi_edit",
  "write_file",
  "create_file",
  "rename_symbol",
  "move_symbol",
  "refactor",
  "dispatch",
  "shell",
]);

// Tools that code sparks must not execute (prevent nested dispatch).
const CODE_BLOCKED = new Set(["dispatch"]);

/** Wrap forge tools with role-based execute guards for sparks.
 *  Tool definitions (description + schema) stay byte-identical → same cache prefix.
 *  Blocked/unsupported tools keep their schema but execute rejects at runtime.
 *  When stripProgrammatic is true, programmatic-only tools (web_fetch, code_execution)
 *  are also execute-blocked — models like Haiku don't support them. */
const PROGRAMMATIC_ONLY_TOOLS = new Set([
  "web_fetch",
  "code_execution",
  "computer",
  "str_replace_based_edit_tool",
]);

function guardForgeTools(
  forgeTools: Record<string, unknown>,
  role: "explore" | "code",
  stripProgrammatic?: boolean,
): Record<string, unknown> {
  const blocked = role === "code" ? CODE_BLOCKED : EXPLORE_BLOCKED;
  const guarded: Record<string, unknown> = {};
  const rejectMsg = (name: string) =>
    `${name} is not available in ${role} mode. Use report_finding to suggest changes instead.`;

  for (const [name, t] of Object.entries(forgeTools)) {
    if (blocked.has(name) || (stripProgrammatic && PROGRAMMATIC_ONLY_TOOLS.has(name))) {
      guarded[name] = deriveTool(t as object, {
        execute: async () => ({ success: false, error: rejectMsg(name) }),
      });
    } else if (stripProgrammatic && (t as Record<string, unknown>).providerOptions) {
      guarded[name] = deriveTool(t as object, { providerOptions: undefined });
    } else {
      guarded[name] = t;
    }
  }
  return guarded;
}

function formatToolArgs(toolCall: { toolName: string; input?: unknown }): string {
  const a = (toolCall.input ?? {}) as Record<string, unknown>;
  if (toolCall.toolName === "read" && a.path) return String(a.path);
  if (toolCall.toolName === "grep" && a.pattern) return `/${String(a.pattern)}/`;
  if (toolCall.toolName === "glob" && a.pattern) return String(a.pattern);
  if (toolCall.toolName === "shell" && a.command) {
    const cmd = String(a.command);
    return cmd.length > 50 ? `${cmd.slice(0, 47)}...` : cmd;
  }
  if (toolCall.toolName === "edit_file" && a.path) return String(a.path);
  if (toolCall.toolName === "project" && a.action) {
    const parts = [a.action, a.file].filter(Boolean).map(String);
    return parts.join(" ");
  }
  if (toolCall.toolName === "rename_symbol" && a.symbol) {
    return `${String(a.symbol)} → ${String(a.newName ?? "")}`;
  }
  if (toolCall.toolName === "move_symbol" && a.symbol) {
    return `${String(a.symbol)} → ${String(a.to ?? "")}`;
  }
  return "";
}

export function buildStepCallbacks(parentToolCallId: string, agentId?: string, modelId?: string) {
  const acc = { toolUses: 0, stepCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // Accumulate steps so they survive NoObjectGeneratedError (AI SDK doesn't attach steps to that error)
  // biome-ignore lint/suspicious/noExplicitAny: step shape varies across SDK versions
  const steps: any[] = [];

  return {
    experimental_onToolCallStart: (event: { toolCall?: { toolName: string; input?: unknown } }) => {
      const tc = event.toolCall;
      if (!tc) return;
      emitSubagentStep({
        parentToolCallId,
        toolName: tc.toolName,
        args: formatToolArgs(tc),
        state: "running",
        agentId,
      });
    },
    experimental_onToolCallFinish: (event: {
      toolCall?: { toolName: string; input?: unknown };
      output?: unknown;
      result?: unknown;
      success?: boolean;
    }) => {
      const tc = event.toolCall;
      if (!tc) return;
      let backend: string | undefined;
      const res = event.output ?? event.result;
      if (res && typeof res === "object") {
        const b = (res as Record<string, unknown>).backend;
        if (typeof b === "string") backend = b;
      }
      emitSubagentStep({
        parentToolCallId,
        toolName: tc.toolName,
        args: formatToolArgs(tc),
        state: event.success ? "done" : "error",
        agentId,
        backend,
      });
    },
    onStepFinish: (step: {
      toolCalls?: unknown[];
      toolResults?: unknown[];
      finishReason?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        inputTokenDetails?: {
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        };
      };
    }) => {
      steps.push(step);
      if (isAbnormalFinish(step.finishReason)) {
        logBackgroundError(
          "agent-error",
          `${agentId ?? "subagent"}: ${describeAbnormalFinish(step.finishReason)}`,
        );
      }
      acc.stepCount++;
      acc.toolUses += step.toolCalls?.length ?? 0;
      acc.input += step.usage?.inputTokens ?? 0;
      acc.output += step.usage?.outputTokens ?? 0;
      acc.cacheRead += step.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
      acc.cacheWrite += step.usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
      if (agentId) {
        emitAgentStats({
          parentToolCallId,
          agentId,
          modelId,
          toolUses: acc.toolUses,
          stepCount: acc.stepCount,
          tokenUsage: { input: acc.input, output: acc.output, total: acc.input + acc.output },
          cacheHits: acc.cacheRead,
          cacheWrite: acc.cacheWrite,
        });
      }
    },
    _acc: acc,
    _steps: steps,
  };
}

export async function createAgent(
  task: AgentTask,
  models: SubagentModels,
  bus: AgentBus,
  parentToolCallId?: string,
  // biome-ignore lint/suspicious/noExplicitAny: explore/code agents have different tool generics
): Promise<{ agent: any; modelId: string; tier: string }> {
  const useExplore =
    task.role === "explore" || task.role === "investigate" || models.readOnly === true;
  const { model } = selectModel(task, models);
  const tier = classifyTask(task, models);
  const modelId =
    typeof model === "object" && "modelId" in model ? String(model.modelId) : "unknown";

  // Spark: same model as parent → share forge system prompt + tools for cache prefix hits.
  // Ember: different model or code role → lean tools, lean prompt, no cache sharing overhead.
  const useSpark = models.forgeInstructions != null && tier === "spark";

  // Rebuild provider options from scratch for the subagent's model — same path
  // the main forge uses (buildProviderOptions). This guarantees per-model
  // capability gating (no effort on Haiku, no thinking on GPT, etc.) instead of
  // ad-hoc patching the parent's options.
  const subagentConfig = loadConfig();
  const explorePerfOverride =
    useExplore && subagentConfig.performance?.effort && subagentConfig.performance.effort !== "off"
      ? {
          ...subagentConfig,
          performance: { ...subagentConfig.performance, effort: "low" as const },
        }
      : subagentConfig;
  const built = await buildProviderOptions(modelId, explorePerfOverride);
  const subagentProviderOptions = stripContextManagement(built.providerOptions);

  const contextWindow = await getModelContextWindow(modelId);
  const forgeInstructions = useSpark ? models.forgeInstructions : undefined;

  // Spark mode: use forge's tool definitions (guarded by role) for cache prefix hits.
  // Tool definitions (description + schema) are byte-identical to the main forge →
  // the [tools + system] prefix is a cache HIT on every spark's first step.
  const agentRole = useExplore ? ("explore" as const) : ("code" as const);
  // Strip programmatic tool calling (allowedCallers) for models that don't support it (e.g. Haiku)
  const stripProgrammatic = !supportsProgrammaticToolCalling(modelId);
  // Wrap with bus cache so spark file reads/edits register with bus tracking
  // (recordFileRead / recordFileEdit). deriveTool preserves description, schema,
  // toModelOutput → cache prefix stays byte-identical.
  let forgeToolsGuarded: Record<string, unknown> | undefined;
  if (useSpark && models.forgeTools) {
    const guarded = guardForgeTools(
      models.forgeTools as Record<string, unknown>,
      agentRole,
      stripProgrammatic,
    );
    forgeToolsGuarded = wrapWithBusCache(
      guarded as Record<string, { execute?: (a: never, o: never) => unknown }>,
      bus,
      task.agentId,
    ) as Record<string, unknown>;
  }

  const isSoloAgent = task.agentId === "desloppify" || task.agentId === "verifier";
  const opts = {
    bus,
    agentId: task.agentId,
    parentToolCallId,
    providerOptions: subagentProviderOptions,
    headers: models.headers,
    webSearchModel: models.webSearchModel,
    onApproveWebSearch: models.onApproveWebSearch,
    onApproveFetchPage: models.onApproveFetchPage,
    repoMap: models.repoMap,
    contextWindow,
    // Sparks share the parent's [tools + system + messages] cache prefix.
    // Pruning their tool results mutates that shared prefix and destroys the cache hit
    // on every step ≥ 2. Force pruning off for sparks regardless of config.
    // Embers run on a different model (separate cache namespace) — honor user's setting.
    disablePruning: useSpark ? true : models.disablePruning,
    tabId: models.tabId,
    forgeInstructions,
    forgeTools: forgeToolsGuarded,
    skipBusTools: isSoloAgent,
  };
  const agent = useExplore ? createExploreAgent(model, opts) : createCodeAgent(model, opts);

  if (isApiExportEnabled() && task.agentId) {
    const toolNames = forgeToolsGuarded
      ? Object.keys(forgeToolsGuarded)
      : useExplore
        ? ["(explore defaults)"]
        : ["(code defaults)"];
    const configData = {
      agent: task.agentId,
      role: agentRole,
      tier,
      model: modelId,
      spark: useSpark,
      contextWindow,
      task: task.task,
      targetFiles: task.targetFiles,
      toolCount: toolNames.length,
      tools: toolNames,
      systemPromptChars: forgeInstructions?.length ?? 0,
      systemPromptTokens: forgeInstructions ? Math.ceil(forgeInstructions.length / 4) : 0,
      providerOptions: subagentProviderOptions
        ? Object.fromEntries(
            Object.entries(subagentProviderOptions).map(([k, v]) => [
              k,
              v && typeof v === "object" ? Object.keys(v as Record<string, unknown>) : v,
            ]),
          )
        : null,
    };
    import("node:fs").then(({ mkdirSync, writeFileSync }) => {
      const dir = `${process.cwd()}/.soulforge/api-export/subagents/${task.agentId}`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/config.json`, JSON.stringify(configData, null, 2), "utf-8");
    });
  }

  return { agent, modelId, tier };
}

const SKILL_TOKEN_RE = /[a-z0-9]+/gi;
const SKILL_MATCH_THRESHOLD = 2;
const SKILL_NAME_WEIGHT = 3;
const SKILL_PREVIEW_CHARS = 200;
const SKILL_MAX_INJECT_CHARS = 2000;

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.matchAll(SKILL_TOKEN_RE)) {
    const t = m[0].toLowerCase();
    if (t.length >= 2) tokens.add(t);
  }
  return tokens;
}

function matchSkillsToTask(
  skills: Array<{ name: string; content: string }>,
  taskDescription: string,
): Array<{ name: string; content: string }> {
  if (skills.length === 0) return [];
  const taskTokens = tokenize(taskDescription);
  if (taskTokens.size === 0) return [];

  const scored: Array<{ name: string; content: string; score: number }> = [];
  for (const skill of skills) {
    const nameTokens = tokenize(skill.name);
    const contentTokens = tokenize(skill.content.slice(0, SKILL_PREVIEW_CHARS));
    let score = 0;
    for (const t of taskTokens) {
      if (nameTokens.has(t)) score += SKILL_NAME_WEIGHT;
      if (contentTokens.has(t)) score += 1;
    }
    if (score >= SKILL_MATCH_THRESHOLD) {
      scored.push({ name: skill.name, content: skill.content, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ name, content }) => ({ name, content }));
}

/** @internal — exported for testing */
function parseTargetFileRange(f: string): {
  path: string;
  startLine?: number;
  endLine?: number;
} {
  const match = f.match(/^(.+\.\w+):(\d+)(?:-(\d+))?$/);
  if (match?.[1]) {
    return {
      path: match[1],
      startLine: Number(match[2]),
      endLine: match[3] ? Number(match[3]) : undefined,
    };
  }

  return { path: f };
}

/** @internal — exported for testing */
function normalizeTargetPath(f: string): string {
  return normalizePath(parseTargetFileRange(f).path);
}

export function buildSubagentTools(models: SubagentModels) {
  const cacheRef: SharedCacheRef = models.sharedCacheRef ?? {
    current: undefined,
    updateFile() {},
  };

  return {
    dispatch: tool({
      description:
        "Dispatch parallel agents for multi-file tasks that benefit from parallelism. " +
        "YOU pre-digest tasks — look up files and symbols in the Soul Map first, then give agents exact paths, line ranges, and what to do. " +
        "Agents are cheap but have limited context — write surgical directives, not research briefs. " +
        "Don't dispatch single-topic questions you can answer with 1-2 reads yourself.",
      inputSchema: z.object({
        tasks: z
          .array(
            z.object({
              task: z
                .string()
                .describe(
                  "Surgical directive — include exact file paths, line ranges, symbol names from the Soul Map. " +
                    "The agent can't see your conversation — everything it needs must be here.",
                ),
              files: z
                .array(z.string())
                .optional()
                .describe(
                  "Target file paths with line ranges from the Soul Map (e.g. 'src/foo.ts:100-200'). " +
                    "Agents read these first. Web search tasks use ['web'].",
                ),
              role: z
                .enum(["explore", "code", "investigate"])
                .optional()
                .describe(
                  "Default: explore. " +
                    "explore = read-only research (investigate is an alias). " +
                    "code = makes edits.",
                ),
              returnFormat: z
                .enum(["summary", "code", "files", "full", "verdict"])
                .optional()
                .describe(
                  "What you need back. Default: summary. " +
                    "summary: concise findings. code: pasteable snippets with line numbers. " +
                    "files: paths only. full: complete analysis. verdict: yes/no with justification.",
                ),
              id: z.string().optional().describe("Unique ID (auto-generated if omitted)"),
              taskId: z
                .number()
                .optional()
                .describe("Link to a task_list task ID — auto-marks done/failed on completion"),
              dependsOn: z
                .array(z.string())
                .optional()
                .describe("IDs of tasks that must complete first"),
            }),
          )
          .min(1)
          .max(8)
          .describe("Spark/ember tasks (max 8, 3 concurrent)"),
      }),
      execute: async (rawArgs, { abortSignal, toolCallId }) => {
        const bus = new AgentBus(cacheRef.current);
        const activeTabId = getActiveTaskTab();
        const dispatchTabId = activeTabId ?? "default";
        await cleanupDispatchDir(process.cwd(), dispatchTabId, toolCallId);
        if (activeTabId) getWorkspaceCoordinator().agentStarted(activeTabId);
        let editingDone = false;
        let dependentWarning = "";
        try {
          const WEB_MARKER = "web";
          const warnings: string[] = [];
          const repoMap = models.repoMap;
          const cwd = process.cwd();

          // ── Normalize: map new schema (files) to internal (targetFiles) ──
          let args = {
            ...rawArgs,
            tasks: rawArgs.tasks.map((t) => ({
              ...t,
              targetFiles: t.files ?? [],
            })),
          };

          // ── File validation: verify against Soul Map, auto-correct, warn ──
          for (const t of args.tasks) {
            const isWebTask =
              t.targetFiles.length === 1 && t.targetFiles[0]?.toLowerCase() === WEB_MARKER;
            if (isWebTask) continue;

            const corrected: string[] = [];
            for (const f of t.targetFiles) {
              const norm = normalizeTargetPath(f);
              if (!norm.includes(".")) {
                corrected.push(f);
                continue;
              }

              // Check Soul Map first, then disk
              let exists = false;
              if (repoMap) {
                const symbols = await repoMap.getFileSymbolRanges(norm);
                if (symbols.length > 0) exists = true;
              }
              if (!exists) {
                const { existsSync } = require("node:fs") as typeof import("node:fs");
                const { resolve: resolvePath, isAbsolute } =
                  require("node:path") as typeof import("node:path");
                const abs = isAbsolute(norm) ? norm : resolvePath(cwd, norm);
                if (existsSync(abs)) exists = true;
              }

              if (exists) {
                corrected.push(f);
              } else {
                warnings.push(
                  `⚠️ Dropped hallucinated file: \`${norm}\` — not in repo map or on disk`,
                );
              }
            }
            t.targetFiles = corrected;
          }

          // ── Dependent warning: check if code targets have importers not in the dispatch ──
          if (repoMap) {
            const allCodeFiles = args.tasks
              .filter((t) => t.role === "code")
              .flatMap((t) => t.targetFiles.map(normalizeTargetPath));
            const allTargetSet = new Set(
              args.tasks.flatMap((t) => t.targetFiles.map(normalizeTargetPath)),
            );
            if (allCodeFiles.length > 0) {
              const missingDeps: string[] = [];
              for (const f of allCodeFiles) {
                const importers = await repoMap.getFileDependents(f);
                for (const imp of importers.slice(0, 5)) {
                  if (!allTargetSet.has(imp.path)) {
                    missingDeps.push(`\`${imp.path}\` imports \`${f}\``);
                  }
                }
              }
              if (missingDeps.length > 0) {
                const depList = [...new Set(missingDeps)].slice(0, 5).join("\n  ");
                dependentWarning = `\n\n⚠️ Files that import your targets (may need updates if exports/signatures changed):\n  ${depList}`;
              }
            }
          }

          // ── Cross-tab awareness: warn about conflicts, don't block ──
          const currentTabId = getActiveTaskTab();
          if (currentTabId) {
            const wc = getWorkspaceCoordinator();
            for (const t of args.tasks) {
              if (t.role !== "code") continue;
              for (const f of t.targetFiles) {
                const norm = normalizeTargetPath(f);
                if (!norm.includes(".")) continue;
                const conflicts = wc.getConflicts(currentTabId, [norm]);
                for (const c of conflicts) {
                  warnings.push(`⚠️ \`${f}\` is being edited by Tab "${c.ownerTabLabel}"`);
                }
              }
            }
          }

          // ── Auto-merge: if >8 tasks, merge explore tasks to fit ──
          const MAX_TASKS = 8;
          if (args.tasks.length > MAX_TASKS) {
            const mergeable = args.tasks.filter(
              (t) => (t.role === "explore" || t.role === "investigate") && !t.dependsOn?.length,
            );
            const pinned = args.tasks.filter(
              (t) =>
                (t.role !== "explore" && t.role !== "investigate") ||
                (t.dependsOn?.length ?? 0) > 0,
            );
            const slots = Math.max(1, MAX_TASKS - pinned.length);
            mergeable.sort((a, b) => b.targetFiles.length - a.targetFiles.length);
            while (mergeable.length > slots) {
              const removed = mergeable.pop();
              if (!removed || !mergeable[0]) break;
              mergeable[0].task = `${mergeable[0].task}\n\nAlso: ${removed.task}`;
              for (const f of removed.targetFiles) {
                if (!mergeable[0].targetFiles.includes(f)) mergeable[0].targetFiles.push(f);
              }
            }
            args = { ...args, tasks: [...pinned, ...mergeable] };
            warnings.push(
              `Merged ${String(rawArgs.tasks.length)} tasks → ${String(args.tasks.length)} to fit concurrency limit`,
            );
          }

          // ── Auto-split: code tasks with many numbered items targeting 1 file get split
          // into 2 serial sub-tasks to improve reliability (agents choke on 10+ edits)
          const TASK_ITEM_SPLIT_THRESHOLD = 8;
          const countTaskItems = (taskText: string): number => {
            const matches = taskText.match(/^\d+\./gm);
            return matches ? matches.length : 0;
          };

          const expandedTasks: typeof args.tasks = [];
          for (const t of args.tasks) {
            const itemCount = countTaskItems(t.task);
            const isSingleFileCode =
              t.role === "code" &&
              t.targetFiles.length === 1 &&
              t.targetFiles[0]?.toLowerCase() !== WEB_MARKER;

            if (itemCount > TASK_ITEM_SPLIT_THRESHOLD && isSingleFileCode) {
              // Split numbered items into two halves
              const lines = t.task.split("\n");
              const numberedLineIndices: number[] = [];
              for (let li = 0; li < lines.length; li++) {
                if (/^\d+\./.test(lines[li] ?? "")) {
                  numberedLineIndices.push(li);
                }
              }
              const midpoint = Math.ceil(numberedLineIndices.length / 2);
              const splitLineIdx = numberedLineIndices[midpoint] ?? Math.ceil(lines.length / 2);

              // Extract preamble (text before first numbered item)
              const firstItemIdx = numberedLineIndices[0] ?? 0;
              const preamble = lines.slice(0, firstItemIdx).join("\n");

              const firstHalf = lines.slice(0, splitLineIdx).join("\n");
              const secondHalf =
                (preamble ? `${preamble}\n` : "") +
                `Continue from where part 1 left off. Read the file first (it was modified by part 1).\n` +
                lines.slice(splitLineIdx).join("\n");

              const baseId = t.id ?? `agent-${String(expandedTasks.length + 1)}`;
              const firstId = `${baseId}-part1`;
              const secondId = `${baseId}-part2`;

              expandedTasks.push({
                ...t,
                id: firstId,
                task: firstHalf,
                dependsOn: t.dependsOn,
              });
              expandedTasks.push({
                ...t,
                id: secondId,
                task: secondHalf,
                dependsOn: [...(t.dependsOn ?? []), firstId],
              });
            } else {
              expandedTasks.push(t);
            }
          }
          args = { ...args, tasks: expandedTasks };

          const tasks: AgentTask[] = await Promise.all(
            args.tasks.map(async (t, i) => {
              const isWebTask =
                t.targetFiles.length === 1 && t.targetFiles[0]?.toLowerCase() === WEB_MARKER;
              let fileHint = "";
              if (!isWebTask) {
                const enriched = await Promise.all(
                  t.targetFiles.map(async (f: string) => {
                    const fPath = parseTargetFileRange(f).path;
                    if (!models.repoMap) return fPath;
                    const ranges = await models.repoMap.getFileSymbolRanges(fPath);
                    if (ranges.length === 0) return f;
                    const rangeStr = ranges
                      .map(
                        (r: {
                          name: string;
                          kind: string;
                          line: number;
                          endLine: number | null;
                        }) => {
                          const end = r.endLine ? `-${String(r.endLine)}` : "";
                          return `  ${r.name} (${r.kind}, lines ${String(r.line)}${end})`;
                        },
                      )
                      .join("\n");
                    return `${f}\n${rangeStr}`;
                  }),
                );
                fileHint = `\nTarget files:\n${enriched.join("\n")}`;
              }
              let skillHint = "";
              if (models.skills && models.skills.length > 0) {
                const matched = matchSkillsToTask(models.skills, t.task);
                for (const s of matched) {
                  const truncated =
                    s.content.length > SKILL_MAX_INJECT_CHARS
                      ? `${s.content.slice(0, SKILL_MAX_INJECT_CHARS)}\n[...]`
                      : s.content;
                  skillHint += `\n\n--- Relevant skill: ${s.name} ---\n${truncated}`;
                }
              }

              // Inject cross-tab claims so subagents know about other tabs' edits
              let crossTabHint = "";
              if (!isWebTask && t.role === "code") {
                const tabId = getActiveTaskTab();
                if (tabId) {
                  const wc = getWorkspaceCoordinator();
                  const editors = wc.getActiveEditors();
                  const otherEdits: string[] = [];
                  for (const [tid] of editors) {
                    if (tid === tabId) continue;
                    const tc = wc.getClaimsForTab(tid);
                    if (tc.size === 0) continue;
                    let label = "Unknown";
                    const paths: string[] = [];
                    for (const [p, c] of tc) {
                      label = c.tabLabel;
                      paths.push(p);
                    }
                    otherEdits.push(
                      `Tab "${label}": ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` (+${String(paths.length - 5)} more)` : ""}`,
                    );
                  }
                  if (otherEdits.length > 0) {
                    crossTabHint = `\n\nOther tabs editing files:\n${otherEdits.join("\n")}\nAvoid these files. If you must edit one, your edit will still apply but may conflict.`;
                  }
                }
              }

              // Normalize target files — strip line range suffixes for bus tracking
              const normalizedTargetFiles = isWebTask
                ? []
                : t.targetFiles.map((f) => normalizeTargetPath(f));

              return {
                agentId: t.id ?? `agent-${String(i + 1)}`,
                role: t.role ?? "explore",
                task: `${t.task}${fileHint}${skillHint}${crossTabHint}`,
                returnFormat: t.returnFormat,
                dependsOn: t.dependsOn,
                taskId: t.taskId,
                tabId: getActiveTaskTab() ?? undefined,
                targetFileCount: isWebTask ? 0 : t.targetFiles.length,
                targetFiles: normalizedTargetFiles,
              };
            }),
          );

          // Auto-serialize code agents that target the same file —
          // concurrent edits to the same file cause old_string mismatch failures.
          // Build a LINEAR chain per file: A→B→C so each agent edits after
          // the previous one finishes (prevents concurrent edit conflicts).
          if (tasks.length > 1) {
            const lastEditor = new Map<string, string>(); // file → most recent agent's id
            for (let i = 0; i < args.tasks.length; i++) {
              const t = args.tasks[i];
              const task = tasks[i];
              if (!t || !task || task.role !== "code") continue;
              for (const f of t.targetFiles) {
                const fp = normalizeTargetPath(f);
                const prev = lastEditor.get(fp);
                if (prev && prev !== task.agentId) {
                  if (!task.dependsOn) task.dependsOn = [];
                  if (!task.dependsOn.includes(prev)) {
                    task.dependsOn.push(prev);
                  }
                }
                lastEditor.set(fp, task.agentId);
              }
            }
          }

          // Emit warnings for complex tasks that weren't auto-split
          // (e.g. multi-file tasks with many items — can't split those safely)
          for (const t of args.tasks) {
            const itemCount = countTaskItems(t.task);
            if (itemCount > TASK_ITEM_SPLIT_THRESHOLD && t.role === "code") {
              const wasSplit = tasks.some((tk) => tk.agentId.endsWith("-part1"));
              if (!wasSplit) {
                emitMultiAgentEvent({
                  parentToolCallId: toolCallId,
                  type: "agent-warning",
                  agentId: t.id ?? "unknown",
                  role: t.role,
                  task: t.task.slice(0, 200),
                  warning: `High complexity: ${String(itemCount)} numbered items in a single task. Consider breaking this into smaller tasks.`,
                  totalAgents: tasks.length,
                });
              }
            }
          }

          bus.registerTasks(tasks);

          bus.onCacheEvent = (agentId, type, path, sourceAgentId) => {
            emitSubagentStep({
              parentToolCallId: toolCallId,
              toolName: type === "invalidate" ? "edit_file" : "read",
              args: path,
              state: type === "wait" ? "running" : "done",
              agentId,
              cacheState: type,
              sourceAgentId,
            });
          };

          bus.onToolCacheEvent = (agentId, toolName, key, type) => {
            let displayArgs = "";
            try {
              const parts = JSON.parse(key) as string[];
              displayArgs = parts.slice(1).join(" ");
            } catch {
              const colonIdx = key.indexOf(":");
              displayArgs = colonIdx >= 0 ? key.slice(colonIdx + 1) : "";
            }
            emitSubagentStep({
              parentToolCallId: toolCallId,
              toolName,
              args: displayArgs,
              state: "done",
              agentId,
              cacheState: type,
            });
          };

          const isSingle = tasks.length === 1;

          if (isSingle) {
            const task = tasks[0] as AgentTask;
            const { doneResult, resultText } = await runAgentTask(
              task,
              models,
              bus,
              toolCallId,
              1,
              abortSignal,
            );
            if (!doneResult && !bus.getResult(task.agentId)?.success) {
              throw new Error(resultText);
            }
            const editedMap = bus.getEditedFiles(task.agentId);

            const desloppifyResult = await runDesloppify(
              bus,
              [task],
              models,
              toolCallId,
              abortSignal,
            );

            const verifyResult = await runVerifier(bus, [task], models, toolCallId, abortSignal);

            const edited = [...editedMap.keys()];

            const postParts = [desloppifyResult, verifyResult].filter(Boolean);
            const reads = bus.getFileReadRecords(task.agentId);
            const warningBlock = warnings.length > 0 ? `\n${warnings.join("\n")}` : "";
            const singleOutput =
              postParts.length > 0 ? `${resultText}\n${postParts.join("\n")}` : resultText;
            return {
              reads,
              filesEdited: edited,
              output: singleOutput + dependentWarning + warningBlock,
            } satisfies DispatchOutput;
          }

          emitMultiAgentEvent({
            parentToolCallId: toolCallId,
            type: "dispatch-start",
            totalAgents: tasks.length,
          });

          const taskIds = new Set(tasks.map((t) => t.agentId));
          for (const task of tasks) {
            if (task.dependsOn) {
              for (const dep of task.dependsOn) {
                if (!taskIds.has(dep)) {
                  return `Error: task "${task.agentId}" depends on unknown task "${dep}"`;
                }
              }
            }
          }

          const hasCycle = (() => {
            const visited = new Set<string>();
            const stack = new Set<string>();
            const depMap = new Map(tasks.map((t) => [t.agentId, t.dependsOn ?? []]));
            const dfs = (id: string): boolean => {
              if (stack.has(id)) return true;
              if (visited.has(id)) return false;
              visited.add(id);
              stack.add(id);
              for (const dep of depMap.get(id) ?? []) {
                if (dfs(dep)) return true;
              }
              stack.delete(id);
              return false;
            };
            return tasks.some((t) => dfs(t.agentId));
          })();
          if (hasCycle) return "Error: dependency cycle detected among tasks";

          const combinedAbort = AbortSignal.any(
            [abortSignal, bus.abortSignal].filter(Boolean) as AbortSignal[],
          );

          const STAGGER_MS = 100;
          let inflightCount = 0;
          const inflightWaiters: Array<() => void> = [];

          const acquireConcurrencySlot = async (): Promise<void> => {
            const maxConcurrent = getMaxConcurrentAgents();
            while (inflightCount >= maxConcurrent) {
              await new Promise<void>((resolve) => inflightWaiters.push(resolve));
            }
            inflightCount++;
          };

          const releaseConcurrencySlot = (): void => {
            inflightCount--;
            const waiter = inflightWaiters.shift();
            if (waiter) waiter();
          };

          const doneResults = new Map<string, DoneToolResult | null>();
          const promises = tasks.map((task, idx) => {
            const hasDeps = task.dependsOn && task.dependsOn.length > 0;
            const jitter = Math.random() * STAGGER_MS;
            const delay = hasDeps ? 0 : idx * STAGGER_MS + jitter;

            const run = async () => {
              // Wait for dependencies BEFORE acquiring a concurrency slot.
              // Otherwise dependent agents hold slots while waiting, deadlocking
              // the agents they depend on from ever starting.
              // DependencyFailedError is caught so runAgentTask can handle it
              // gracefully (emit events, set bus result) instead of crashing Promise.all.
              if (hasDeps && task.dependsOn) {
                try {
                  await Promise.all(
                    task.dependsOn.map((dep) =>
                      bus.waitForAgent(dep, task.timeoutMs ?? getAgentWaitMs()),
                    ),
                  );
                } catch {
                  // Dep failed or timed out — fall through to runAgentTask which
                  // will detect the same condition and handle it with proper eventing
                }
              }
              await acquireConcurrencySlot();
              try {
                const { doneResult } = await runAgentTask(
                  task,
                  models,
                  bus,
                  toolCallId,
                  tasks.length,
                  combinedAbort,
                );
                doneResults.set(task.agentId, doneResult);
              } finally {
                releaseConcurrencySlot();
              }
            };

            return delay > 0 ? sleep(delay, combinedAbort).then(run) : run();
          });
          await Promise.all(promises);

          emitMultiAgentEvent({
            parentToolCallId: toolCallId,
            type: "dispatch-done",
            totalAgents: tasks.length,
            completedAgents: bus.completedAgentIds.length,
            findingCount: bus.findingCount,
          });

          const results = bus.getAllResults();
          const successful = results.filter((r) => r.success);
          const failed = results.filter((r) => !r.success);

          const sections: string[] = [];
          sections.push(`## Dispatch`);
          sections.push(
            `**${String(successful.length)}/${String(tasks.length)}** agents completed successfully.`,
          );

          if (warnings.length > 0) {
            sections.push(`### Warnings\n${warnings.join("\n")}`);
          }

          if (bus.findingCount > 0) {
            const findings = bus.getFindings();
            sections.push(
              `### Coordination Findings (${String(findings.length)})`,
              ...findings.map((f) => `**[${f.agentId}] ${f.label}:**\n${f.content}`),
            );
          }

          for (const r of results) {
            const done = r.result.startsWith("[done]");
            const status = r.success ? (done ? "✓" : "⚠") : "✗";
            const taskSummary = r.task.split("\n")[0]?.slice(0, 200) ?? r.task.slice(0, 200);
            const body = done ? r.result.replace(/^\[done\]\s*/, "") : r.result;
            sections.push(
              `\n### ${status} Agent: ${r.agentId} (${r.role})\nTask: ${taskSummary}\n${body}\n\n---`,
            );
          }

          const archivePaths: string[] = [];
          for (const [agentId, done] of doneResults) {
            if (done?.archivePath) archivePaths.push(`- [${agentId}] ${done.archivePath}`);
          }
          if (archivePaths.length > 0) {
            sections.push(
              `\n### Full agent outputs\n${archivePaths.join("\n")}\n(Read these files for the complete agent text when truncated.)`,
            );
          }

          if (failed.length > 0) {
            sections.push(
              `\n### Errors\n${failed.map((r) => `- ${r.agentId}: ${r.error}`).join("\n")}`,
            );
          }

          const allEdited = bus.getEditedFiles();
          if (allEdited.size > 0) {
            const lines: string[] = [];
            const conflicts: string[] = [];
            for (const [path, agents] of allEdited) {
              lines.push(`- \`${path}\` — ${agents.join(", ")}`);
              if (agents.length > 1) conflicts.push(path);
            }
            sections.push(`\n### Files Edited\n${lines.join("\n")}`);
            if (conflicts.length > 0) {
              sections.push(
                `\n⚠ **Edit conflicts detected** — multiple agents edited: ${conflicts.map((p) => `\`${p}\``).join(", ")}. Review these files carefully.`,
              );
            }
          }

          const desloppifyResult = await runDesloppify(
            bus,
            tasks,
            models,
            toolCallId,
            combinedAbort,
          );
          if (desloppifyResult) sections.push(desloppifyResult);

          // Release git lock: code agents + desloppify are done editing.
          // Verifier is read-only (role: "explore", no edit tools) — safe to unlock.
          editingDone = true;
          if (activeTabId) getWorkspaceCoordinator().agentFinished(activeTabId);

          const verifyResult = await runVerifier(bus, tasks, models, toolCallId, combinedAbort);
          if (verifyResult) sections.push(verifyResult);

          const m = bus.metrics;
          const cacheStats = [m.fileHits, m.fileWaits, m.toolHits].some((v) => v > 0)
            ? `\n### Cache\nFiles: ${String(m.fileHits)} hits, ${String(m.fileWaits)} waits, ${String(m.fileMisses)} misses | Tools: ${String(m.toolHits)} hits, ${String(m.toolWaits)} waits, ${String(m.toolMisses)} misses, ${String(m.toolEvictions)} evictions, ${String(m.toolInvalidations)} invalidations`
            : "";
          if (cacheStats) sections.push(cacheStats);

          const editedPaths = [...allEdited.keys()];

          const allReads = bus.getFileReadRecords();
          return {
            reads: allReads,
            filesEdited: editedPaths,
            output: sections.join("\n") + dependentWarning,
          } satisfies DispatchOutput;
        } finally {
          if (activeTabId && !editingDone) getWorkspaceCoordinator().agentFinished(activeTabId);
          try {
            cacheRef.current = bus.exportCaches();
          } catch (err) {
            logBackgroundError("cache-export", err instanceof Error ? err.message : String(err));
          }
          bus.dispose();
        }
      },
      toModelOutput({ output }: { toolCallId: string; input: unknown; output: unknown }) {
        const dispatch = output as DispatchOutput | string;
        const value = typeof dispatch === "string" ? dispatch : dispatch.output;
        return {
          type: "text" as const,
          value: `<dispatch_result>\n${value}\n</dispatch_result>`,
        };
      },
    }),
  };
}
