import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LanguageModel, ModelMessage } from "ai";
import { normalizePath } from "../core/agents/agent-bus.js";
import { createForgeAgent } from "../core/agents/index.js";
import type { SharedCacheRef } from "../core/agents/subagent-tools.js";
import { ContextManager } from "../core/context/manager.js";
import { getCwd } from "../core/cwd.js";
import { resolveModel } from "../core/llm/provider.js";
import { buildProviderOptions } from "../core/llm/provider-options.js";
import { disposeMCPManager } from "../core/mcp/index.js";
import { SessionManager } from "../core/sessions/manager.js";
import { onFileEdited } from "../core/tools/file-events.js";
import { logBackgroundError } from "../stores/errors.js";
import type { AppConfig, ChatMessage, ForgeMode, InteractiveCallbacks } from "../types/index.js";
import { DIM, EXIT_ABORT, EXIT_ERROR, EXIT_OK, EXIT_TIMEOUT, PURPLE, RST } from "./constants.js";
import {
  formatDuration,
  formatTokens,
  separator,
  stderrDim,
  stderrError,
  stderrLabel,
  stderrWarn,
  writeEvent,
  writeMarkdown,
} from "./output.js";
import type { HeadlessChatOptions, HeadlessEvent, HeadlessRunOptions } from "./types.js";

interface AgentEnv {
  cwd: string;
  modelId: string;
  mode: ForgeMode;
  model: LanguageModel;
  agent: ReturnType<typeof createForgeAgent>;
  contextManager: ContextManager;
  sessionManager: SessionManager;
  repoMap: ReturnType<ContextManager["getRepoMap"]> | undefined;
  providerOptions: Record<string, unknown>;
  headers: Record<string, string> | undefined;
  sharedCacheRef: SharedCacheRef;
}

/**
 * Re-raise SIGINT for signal-triggered exits so the parent shell sees a true
 * signal death (WIFSIGNALED) instead of a normal exit with code 130.
 * For non-signal exits, fall through to process.exit().
 */
function reraiseOrExit(code: number): never {
  if (code === EXIT_ABORT) {
    process.removeAllListeners("SIGINT");
    process.kill(process.pid, "SIGINT");
  }
  process.exit(code);
}

async function setupAgent(
  opts: {
    cwd?: string;
    modelId?: string;
    mode?: ForgeMode;
    noRepomap?: boolean;
    system?: string;
    quiet?: boolean;
    json?: boolean;
    events?: boolean;
    callbacks?: InteractiveCallbacks;
    onApproveOutsideCwd?: (toolName: string, path: string) => Promise<boolean>;
    onApproveDestructive?: (description: string) => Promise<boolean>;
  },
  merged: AppConfig,
): Promise<AgentEnv> {
  // getCwd() is authoritative — runHeadless/boot already applied --cwd.
  const cwd = getCwd();
  const mode = opts.mode ?? "default";
  const showProgress = !opts.json && !opts.events && !opts.quiet;

  const modelId = opts.modelId ?? merged.defaultModel;
  if (modelId === "none") {
    stderrError("No model configured. Pass --model provider/model or set defaultModel in config.");
    process.exit(EXIT_ERROR);
  }

  let model: LanguageModel;
  try {
    model = resolveModel(modelId);
  } catch (err) {
    stderrError(err instanceof Error ? err.message : String(err));
    process.exit(EXIT_ERROR);
  }
  const providerOpts = await buildProviderOptions(modelId, merged);

  const repoMapDisabled =
    merged.repoMap === false || opts.noRepomap || process.env.SOULFORGE_NO_REPOMAP === "1";
  const contextManager = await ContextManager.createAsync(
    cwd,
    (step) => {
      if (showProgress) stderrDim(step);
    },
    { repoMapEnabled: !repoMapDisabled },
  );
  // Set accurate context window from provider metadata (avoids 200k default for 1M+ models)
  contextManager.setContextWindow(providerOpts.contextWindow);
  if (!repoMapDisabled && !contextManager.isRepoMapReady()) {
    if (showProgress) stderrDim("Waiting for Soul Map…");
    const ready = await contextManager.waitForRepoMap(30_000);
    if (!ready && showProgress) {
      stderrDim("⚠ Soul Map not ready — proceeding without soul tools.");
    }
  }

  const repoMap =
    !repoMapDisabled && contextManager.isRepoMapReady() ? contextManager.getRepoMap() : undefined;

  const { loadInstructions, buildInstructionPrompt } = await import("../core/instructions.js");
  const instructions = loadInstructions(cwd, merged.instructionFiles);
  let instructionText = buildInstructionPrompt(instructions);
  if (opts.system) {
    instructionText = instructionText ? `${instructionText}\n\n${opts.system}` : opts.system;
  }
  contextManager.setProjectInstructions(instructionText);

  if (mode !== "default") contextManager.setForgeMode(mode);

  try {
    const { warmupIntelligence } = await import("../core/intelligence/index.js");
    warmupIntelligence(cwd, merged.codeIntelligence);
  } catch {}

  if (merged.mcpServers?.length) {
    const { getMCPManager } = await import("../core/mcp/index.js");
    await getMCPManager().connectAll(merged.mcpServers);
  }

  // Resolve subagent + web-search models from the task router (parity with TUI).
  const tr = merged.taskRouter;
  const sparkModelId = tr?.spark ?? tr?.exploration ?? tr?.trivial ?? undefined;
  const emberModelId = tr?.ember ?? tr?.coding ?? undefined;
  const webSearchModelId = tr?.webSearch ?? undefined;
  const desloppifyModelId = tr?.desloppify ?? undefined;
  const verifyModelId = tr?.verify ?? undefined;
  const tryResolve = (id: string | undefined): LanguageModel | undefined => {
    if (!id) return undefined;
    try {
      return resolveModel(id);
    } catch (err) {
      logBackgroundError(
        "headless:router-resolve",
        `model "${id}" failed to resolve: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  };
  const subagentModels =
    sparkModelId || emberModelId || desloppifyModelId || verifyModelId
      ? {
          spark: tryResolve(sparkModelId),
          ember: tryResolve(emberModelId),
          desloppify: tryResolve(desloppifyModelId),
          verify: tryResolve(verifyModelId),
        }
      : undefined;
  const webSearchEnabled = merged.webSearch !== false;
  const webSearchModel = webSearchEnabled ? tryResolve(webSearchModelId) : undefined;

  // Shared file cache so dispatch subagents and multi-turn chat see edits made
  // earlier in the session (parity with useChat's sharedCacheRef).
  const sharedCacheRef: SharedCacheRef = {
    current: undefined,
    updateFile(absPath: string, content: string) {
      if (!sharedCacheRef.current) return;
      const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
      const rel = absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
      const key = normalizePath(rel);
      sharedCacheRef.current.files.set(key, content);
      for (const k of sharedCacheRef.current.toolResults.keys()) {
        if (k.includes(key)) sharedCacheRef.current.toolResults.delete(k);
      }
    },
  };
  onFileEdited((absPath, content) => sharedCacheRef.updateFile(absPath, content));

  const callbacks = opts.callbacks;
  // Non-interactive default: deny destructive ops and out-of-cwd writes unless a
  // surface supplies a real approval hook. Auto mode bypasses these in createForgeAgent.
  const denyApproval = async (): Promise<boolean> => false;
  const onApproveOutsideCwd =
    opts.onApproveOutsideCwd ?? (mode === "auto" ? undefined : denyApproval);
  const onApproveDestructive =
    opts.onApproveDestructive ?? (mode === "auto" ? undefined : denyApproval);
  const agent = createForgeAgent({
    model,
    fullModelId: modelId,
    contextManager,
    forgeMode: mode,
    interactive: callbacks,
    editorIntegration: {
      diagnostics: false,
      symbols: false,
      hover: false,
      references: false,
      definition: false,
      codeActions: false,
      editorContext: false,
      rename: false,
      lspStatus: false,
      format: false,
    },
    subagentModels,
    webSearchModel,
    onApproveWebSearch: webSearchEnabled ? callbacks?.onWebSearchApproval : undefined,
    onApproveFetchPage: callbacks?.onFetchPageApproval,
    onApproveOutsideCwd,
    onApproveDestructive,
    providerOptions: providerOpts.providerOptions,
    headers: providerOpts.headers,
    agentFeatures: merged.agentFeatures,
    sharedCacheRef,
    cwd,
    disablePruning: !["subagents", "both"].includes(
      merged.contextManagement?.pruningTarget ?? "none",
    ),
  });

  return {
    cwd,
    modelId,
    mode,
    model,
    agent,
    contextManager,
    sessionManager: new SessionManager(cwd),
    repoMap,
    providerOptions: providerOpts.providerOptions,
    headers: providerOpts.headers,
    sharedCacheRef,
  };
}

interface TurnResult {
  output: string;
  steps: number;
  tokens: { input: number; output: number; cacheRead: number };
  toolCalls: string[];
  filesEdited: string[];
  error?: string;
  exitCode: number;
}

async function streamTurn(
  agent: ReturnType<typeof createForgeAgent>,
  messages: ModelMessage[],
  prompt: string,
  signal: AbortSignal,
  reporting: {
    json?: boolean;
    events?: boolean;
    quiet?: boolean;
    maxSteps?: number;
    showProgress: boolean;
    render?: boolean;
    emit?: (event: HeadlessEvent) => void;
  },
): Promise<TurnResult> {
  const emit =
    reporting.emit ?? ((e: HeadlessEvent) => writeEvent(e as unknown as Record<string, unknown>));
  let output = "";
  let steps = 0;
  const tokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    lastStepInput: 0,
    lastStepOutput: 0,
    lastStepCacheRead: 0,
  };
  const toolCalls: string[] = [];
  const filesEdited = new Set<string>();
  let error: string | undefined;
  let exitCode = EXIT_OK;

  try {
    const result = await agent.stream({
      messages,
      options: { userMessage: prompt },
      abortSignal: signal,
    });

    for await (const part of result.fullStream) {
      if (reporting.maxSteps && steps >= reporting.maxSteps) {
        error = `Max steps reached (${String(reporting.maxSteps)})`;
        exitCode = EXIT_ERROR;
        if (reporting.showProgress) stderrWarn(`\n${error}`);
        if (reporting.events) emit({ type: "error", error });
        break;
      }

      if (part.type === "start-step") {
        const warnings = (part as { warnings?: Array<{ type: string; message?: string }> })
          .warnings;
        if (warnings && warnings.length > 0) {
          for (const w of warnings) {
            const msg = `[${w.type}]${w.message ? ` ${w.message}` : ""}`;
            if (reporting.events) {
              emit({ type: "warning", message: msg });
            } else if (reporting.showProgress) {
              process.stderr.write(`${DIM}  ⚠ ${msg}${RST}\n`);
            }
          }
        }
      } else if (part.type === "text-delta") {
        output += part.text;
        if (reporting.events) {
          emit({ type: "text", content: part.text });
        } else if (!reporting.json && !reporting.render) {
          process.stdout.write(part.text);
        }
      } else if (part.type === "tool-call") {
        toolCalls.push(part.toolName);
        const partInput = part as { input?: Record<string, unknown>; toolCallId?: string };
        if (reporting.events) {
          emit({
            type: "tool-call",
            tool: part.toolName,
            toolCallId: partInput.toolCallId,
            input: partInput.input,
          });
        } else if (reporting.showProgress) {
          process.stderr.write(`${DIM}  ▸ ${part.toolName}${RST}\n`);
        }
        const input = (part as { input?: Record<string, unknown> }).input;
        if (
          input?.path &&
          typeof input.path === "string" &&
          (part.toolName === "edit_file" ||
            part.toolName === "write_file" ||
            part.toolName === "create_file" ||
            part.toolName === "multi_edit")
        ) {
          filesEdited.add(input.path);
        }
      } else if (part.type === "tool-result") {
        if (reporting.events) {
          const raw = part.output;
          let summary: string;
          if (raw && typeof raw === "object" && "output" in raw) {
            const out = String((raw as Record<string, unknown>).output);
            summary = out.length > 200 ? `${out.slice(0, 200)}…` : out;
          } else {
            summary = String(raw).slice(0, 200);
          }
          emit({
            type: "tool-result",
            tool: part.toolName,
            toolCallId: (part as { toolCallId?: string }).toolCallId,
            summary,
          });
        }
      } else if (part.type === "finish-step") {
        steps++;
        const usage = part.usage as {
          inputTokens?: number;
          outputTokens?: number;
          inputTokenDetails?: { cacheReadTokens?: number };
        };
        tokens.lastStepInput = usage.inputTokens ?? 0;
        tokens.lastStepOutput = usage.outputTokens ?? 0;
        tokens.lastStepCacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
        tokens.input += tokens.lastStepInput;
        tokens.output += tokens.lastStepOutput;
        tokens.cacheRead += tokens.lastStepCacheRead;
        if (reporting.events) {
          emit({ type: "step", step: steps, tokens: { ...tokens } });
        }
      }
    }
  } catch (err) {
    if (signal.aborted) {
      error = "Aborted";
      exitCode = EXIT_ABORT;
    } else {
      error = err instanceof Error ? err.message : String(err);
      exitCode = EXIT_ERROR;
    }
    if (reporting.showProgress) stderrError(error);
    if (reporting.events) emit({ type: "error", error });
  }

  return { output, steps, tokens, toolCalls, filesEdited: [...filesEdited], error, exitCode };
}

async function saveSession(
  env: AgentEnv,
  chatMessages: ChatMessage[],
  tokens: { input: number; output: number; cacheRead: number },
  showProgress: boolean,
  isEvents: boolean,
): Promise<string> {
  const sessionId = crypto.randomUUID();
  await env.sessionManager.saveSession(
    {
      id: sessionId,
      title: SessionManager.deriveTitle(chatMessages),
      cwd: env.cwd,
      startedAt: chatMessages[0]?.timestamp ?? Date.now(),
      updatedAt: Date.now(),
      activeTabId: "headless",
      forgeMode: env.mode,
      tabs: [
        {
          id: "headless",
          label: "Headless",
          activeModel: env.modelId,
          sessionId,
          planMode: false,
          planRequest: null,
          coAuthorCommits: false,
          tokenUsage: {
            prompt: tokens.input,
            completion: tokens.output,
            total: tokens.input + tokens.output,
            cacheRead: tokens.cacheRead,
          },
          messageRange: { startLine: 0, endLine: chatMessages.length },
        },
      ],
    },
    new Map([["headless", chatMessages]]),
  );
  if (showProgress) stderrDim(`Session saved: ${sessionId.slice(0, 8)}`);
  if (isEvents) writeEvent({ type: "session-saved", sessionId });
  return sessionId;
}

export async function runPrompt(opts: HeadlessRunOptions, merged: AppConfig): Promise<void> {
  const isQuiet = opts.quiet === true;
  const isEvents = opts.events === true;
  const showProgress = !opts.json && !isEvents && !isQuiet;

  const env = await setupAgent(opts, merged);
  const startTime = Date.now();

  // Session resume
  let priorMessages: ModelMessage[] = [];
  let priorChatMessages: ChatMessage[] = [];

  if (opts.sessionId) {
    const fullId = env.sessionManager.findByPrefix(opts.sessionId);
    if (!fullId) {
      stderrError(`Session "${opts.sessionId}" not found`);
      env.contextManager.dispose();
      await disposeMCPManager();
      process.exit(EXIT_ERROR);
    }
    const data = env.sessionManager.loadSessionMessages(fullId);
    if (data) {
      priorMessages = data.coreMessages;
      priorChatMessages = data.messages;
      if (showProgress) {
        stderrDim(
          `Resumed session ${fullId.slice(0, 8)} (${String(data.messages.length)} messages)`,
        );
      }
    }
  }

  // Include files
  let prompt = opts.prompt;
  if (opts.include && opts.include.length > 0) {
    const fileParts: string[] = [];
    for (const file of opts.include) {
      const fullPath = resolve(env.cwd, file);
      if (!existsSync(fullPath)) {
        stderrWarn(`--include file not found: ${file}`);
        continue;
      }
      try {
        fileParts.push(`[${file}]\n${readFileSync(fullPath, "utf-8")}`);
      } catch {}
    }
    if (fileParts.length > 0) {
      prompt = `${fileParts.join("\n\n")}\n\n${prompt}`;
    }
  }

  env.contextManager.updateConversationContext(prompt, 0);

  // Header
  if (isEvents) {
    writeEvent({
      type: "start",
      model: env.modelId,
      mode: env.mode,
      session: opts.sessionId ?? null,
      repoMap: env.repoMap
        ? {
            files: env.repoMap.getStatsCached().files,
            symbols: env.repoMap.getStatsCached().symbols,
          }
        : null,
      workers: getWorkerInfo(),
    });
  } else if (showProgress) {
    stderrLabel("Model", env.modelId);
    if (env.mode !== "default") stderrLabel("Mode", env.mode);
    if (env.repoMap) {
      const stats = env.repoMap.getStatsCached();
      stderrLabel("Repo", `${String(stats.files)} files, ${String(stats.symbols)} symbols`);
    }
    const wk = getWorkerInfo();
    if (wk) stderrDim(`Workers: intelligence=${wk.intelligence}, io=${wk.io}`);
    separator();
  }

  // Abort / timeout
  const abortController = new AbortController();
  let timedOut = false;

  process.on("SIGINT", () => abortController.abort());
  if (opts.timeout) {
    setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, opts.timeout);
  }

  const messages: ModelMessage[] = [...priorMessages, { role: "user" as const, content: prompt }];

  const turn = await streamTurn(env.agent, messages, prompt, abortController.signal, {
    json: opts.json,
    events: isEvents,
    quiet: isQuiet,
    maxSteps: opts.maxSteps,
    showProgress,
    render: opts.render,
  });

  // Override exit code for timeout
  let exitCode = turn.exitCode;
  if (timedOut && exitCode === EXIT_ABORT) {
    turn.error = `Timeout after ${String(Math.round((opts.timeout ?? 0) / 1000))}s`;
    exitCode = EXIT_TIMEOUT;
  }

  const duration = Date.now() - startTime;

  // Session save
  if (opts.saveSession) {
    const chatMessages: ChatMessage[] = [
      ...priorChatMessages,
      { id: crypto.randomUUID(), role: "user", content: prompt, timestamp: startTime },
      { id: crypto.randomUUID(), role: "assistant", content: turn.output, timestamp: Date.now() },
    ];
    const savedId = await saveSession(env, chatMessages, turn.tokens, showProgress, isEvents);
    if (showProgress) {
      const shortId = savedId.slice(0, 8);
      process.stderr.write(
        `${PURPLE()}Resume:${RST} soulforge --headless --session ${shortId} "your next prompt"\n`,
      );
    }
  }

  // Output
  if (isEvents) {
    writeEvent({
      type: "done",
      output: turn.output,
      steps: turn.steps,
      tokens: turn.tokens,
      toolCalls: turn.toolCalls,
      filesEdited: turn.filesEdited,
      duration,
      ...(turn.error ? { error: turn.error } : {}),
    });
  } else if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          model: env.modelId,
          mode: env.mode,
          prompt,
          output: turn.output,
          steps: turn.steps,
          tokens: turn.tokens,
          toolCalls: turn.toolCalls,
          filesEdited: turn.filesEdited,
          duration,
          ...(turn.error ? { error: turn.error } : {}),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    if (opts.render && turn.output.length > 0) {
      // Render accumulated markdown output with shiki syntax highlighting
      await writeMarkdown(turn.output);
    } else if (turn.output.length > 0 && !turn.output.endsWith("\n")) {
      process.stdout.write("\n");
    }
    if (!isQuiet) {
      if (turn.filesEdited.length > 0 && opts.diff) {
        separator();
        process.stderr.write(`${PURPLE()}Files changed:${RST}\n`);
        for (const f of turn.filesEdited) process.stderr.write(`  ${f}\n`);
      }
      separator();
      process.stderr.write(
        `${DIM}${String(turn.steps)} steps — ${formatTokens(turn.tokens)} — ${formatDuration(duration)}${RST}\n`,
      );
    }
  }

  env.contextManager.dispose();
  await disposeMCPManager();
  reraiseOrExit(exitCode);
}

/**
 * Read a prompt from stdin. Single newline submits.
 * Trailing backslash (\) continues to the next line (multiline support).
 */
let stdinBuf = "";
let stdinEnded = false;

function readPromptFromStdin(): Promise<string | null> {
  return new Promise((resolve) => {
    // Check buffered data from previous reads first
    while (stdinBuf.includes("\n")) {
      const idx = stdinBuf.indexOf("\n");
      const line = stdinBuf.slice(0, idx);
      stdinBuf = stdinBuf.slice(idx + 1);

      if (line.endsWith("\\")) {
        stdinBuf = `${line.slice(0, -1)}\n${stdinBuf}`;
        continue;
      }

      const prompt = line.trim();
      if (prompt.length > 0) {
        resolve(prompt);
        return;
      }
    }

    // If stdin already closed, drain remaining buffer
    if (stdinEnded) {
      const prompt = stdinBuf.trim();
      stdinBuf = "";
      resolve(prompt.length > 0 ? prompt : null);
      return;
    }

    if (process.stdin.isPaused()) process.stdin.resume();

    const onData = (chunk: Buffer) => {
      stdinBuf += chunk.toString("utf-8");

      while (stdinBuf.includes("\n")) {
        const idx = stdinBuf.indexOf("\n");
        const line = stdinBuf.slice(0, idx);
        stdinBuf = stdinBuf.slice(idx + 1);

        if (line.endsWith("\\")) {
          stdinBuf = `${line.slice(0, -1)}\n${stdinBuf}`;
          continue;
        }

        const prompt = line.trim();
        cleanup();
        process.stdin.pause();
        resolve(prompt.length > 0 ? prompt : null);
        return;
      }
    };

    const onEnd = () => {
      stdinEnded = true;
      cleanup();
      const prompt = stdinBuf.trim();
      stdinBuf = "";
      resolve(prompt.length > 0 ? prompt : null);
    };

    function cleanup() {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
    }

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}

export async function runChat(opts: HeadlessChatOptions, merged: AppConfig): Promise<void> {
  const isEmbedded = opts.embedded === true;
  const hasEventSink = typeof opts.onEvent === "function";
  const isEvents = opts.events === true || hasEventSink;
  const isQuiet = opts.quiet === true || isEmbedded;
  const showProgress = !opts.json && !isEvents && !isQuiet;
  const emit = (event: HeadlessEvent): void => {
    if (opts.onEvent) opts.onEvent(event);
    else if (opts.events === true) writeEvent(event as unknown as Record<string, unknown>);
  };

  const env = await setupAgent(opts, merged);

  // Session resume
  let history: ModelMessage[] = [];
  let chatHistory: ChatMessage[] = [];

  if (opts.sessionId) {
    const fullId = env.sessionManager.findByPrefix(opts.sessionId);
    if (fullId) {
      const data = env.sessionManager.loadSessionMessages(fullId);
      if (data) {
        history = data.coreMessages;
        chatHistory = data.messages;
        if (showProgress) {
          stderrDim(
            `Resumed session ${fullId.slice(0, 8)} (${String(data.messages.length)} messages)`,
          );
        }
      }
    }
  }

  // Header
  if (isEvents) {
    emit({
      type: "start",
      model: env.modelId,
      mode: env.mode,
      chat: true,
      repoMap: env.repoMap
        ? {
            files: env.repoMap.getStatsCached().files,
            symbols: env.repoMap.getStatsCached().symbols,
          }
        : null,
      workers: getWorkerInfo(),
    });
  } else if (showProgress) {
    stderrLabel("Model", env.modelId);
    if (env.mode !== "default") stderrLabel("Mode", env.mode);
    if (env.repoMap) {
      const stats = env.repoMap.getStatsCached();
      stderrLabel("Repo", `${String(stats.files)} files, ${String(stats.symbols)} symbols`);
    }
    const wk = getWorkerInfo();
    if (wk) stderrDim(`Workers: intelligence=${wk.intelligence}, io=${wk.io}`);
    stderrDim(
      "Chat mode — type a prompt and hit Enter (backslash \\ for multiline, Ctrl+C to exit)",
    );
    separator();
  }

  const totalTokens = { input: 0, output: 0, cacheRead: 0 };
  let turns = 0;
  let aborted = false;
  let turnAbort = new AbortController();

  async function cleanupAndExit(code: number): Promise<void> {
    let savedId: string | undefined;
    if (chatHistory.length > 0) {
      savedId = await saveSession(env, chatHistory, totalTokens, showProgress, isEvents);
    }

    if (isEvents) {
      emit({ type: "chat-done", turns, tokens: totalTokens, sessionId: savedId });
    } else if (showProgress) {
      separator();
      stderrDim(`${String(turns)} turns — ${formatTokens(totalTokens)} total`);
      if (savedId) {
        const shortId = savedId.slice(0, 8);
        process.stderr.write(
          `${PURPLE()}Resume:${RST} soulforge --headless --chat --session ${shortId}\n`,
        );
      }
    }

    env.contextManager.dispose();
    if (!isEmbedded) await disposeMCPManager();
    if (isEmbedded) return;
    reraiseOrExit(code);
  }

  // SIGINT: abort current turn, save, print resume, exit. Skipped in embedded mode
  // (daemon owns process-level signal handling and MCP lifetime).
  if (!isEmbedded) {
    process.on("SIGINT", () => {
      if (aborted) {
        env.contextManager.dispose();
        disposeMCPManager();
        reraiseOrExit(EXIT_ABORT);
      }
      aborted = true;
      turnAbort.abort();
    });
  }

  // External abort signal (Hearth tab abort, timeout, etc.)
  if (opts.signal) {
    if (opts.signal.aborted) {
      aborted = true;
      turnAbort.abort();
    } else {
      opts.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          turnAbort.abort();
        },
        { once: true },
      );
    }
  }

  if (isEvents) emit({ type: "ready" });
  if (showProgress) process.stderr.write(`${PURPLE()}▸${RST} `);

  const readPrompt = opts.readPrompt ?? readPromptFromStdin;

  while (!aborted) {
    const prompt = await readPrompt();
    if (prompt === null) break;

    turns++;
    const turnStart = Date.now();

    history.push({ role: "user" as const, content: prompt });
    chatHistory.push({
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      timestamp: turnStart,
    });

    env.contextManager.updateConversationContext(prompt, totalTokens.input);

    turnAbort = new AbortController();
    if (opts.timeout) {
      setTimeout(() => turnAbort.abort(), opts.timeout);
    }
    if (opts.signal && !opts.signal.aborted) {
      const fwd = () => turnAbort.abort();
      opts.signal.addEventListener("abort", fwd, { once: true });
    }

    const turn = await streamTurn(env.agent, history, prompt, turnAbort.signal, {
      json: opts.json,
      events: isEvents,
      quiet: isQuiet,
      maxSteps: opts.maxSteps,
      showProgress,
      emit,
    });

    // Even partial output is valuable — save it
    if (turn.output) {
      history.push({ role: "assistant" as const, content: turn.output });
      chatHistory.push({
        id: crypto.randomUUID(),
        role: "assistant",
        content: turn.output,
        timestamp: Date.now(),
      });
    }

    totalTokens.input += turn.tokens.input;
    totalTokens.output += turn.tokens.output;
    totalTokens.cacheRead += turn.tokens.cacheRead;

    if (isEvents) {
      emit({
        type: "turn-done",
        turn: turns,
        output: turn.output,
        steps: turn.steps,
        tokens: turn.tokens,
        toolCalls: turn.toolCalls,
        filesEdited: turn.filesEdited,
        duration: Date.now() - turnStart,
        ...(turn.error ? { error: turn.error } : {}),
      });
      if (!aborted) emit({ type: "ready" });
    } else if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({
          turn: turns,
          output: turn.output,
          steps: turn.steps,
          tokens: turn.tokens,
          toolCalls: turn.toolCalls,
          filesEdited: turn.filesEdited,
          duration: Date.now() - turnStart,
          ...(turn.error ? { error: turn.error } : {}),
        })}\n`,
      );
    } else {
      if (turn.output.length > 0 && !turn.output.endsWith("\n")) process.stdout.write("\n");
      if (showProgress) {
        separator();
        process.stderr.write(
          `${DIM}turn ${String(turns)} — ${String(turn.steps)} steps — ${formatTokens(turn.tokens)}${RST}\n`,
        );
        if (!aborted) process.stderr.write(`${PURPLE()}▸${RST} `);
      }
    }

    if (turn.error) break;
  }

  await cleanupAndExit(aborted ? EXIT_ABORT : EXIT_OK);
}
function getWorkerInfo(): { intelligence: string; io: string } | null {
  try {
    const { useWorkerStore } =
      require("../stores/workers.js") as typeof import("../stores/workers.js");
    const wk = useWorkerStore.getState();
    return {
      intelligence: wk.intelligence.status,
      io: wk.io.status,
    };
  } catch {
    return null;
  }
}
