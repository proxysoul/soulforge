import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import type {
  JSONSchema7,
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";
import { getCwd } from "../../../cwd.js";
import { trackProcess } from "../../../process-tracker.js";

export interface CodexRunnerCall {
  modelId: string;
  prompt: string;
  schema: JSONSchema7;
  abortSignal?: AbortSignal;
}

export interface CodexRunnerResult {
  text: string;
  usage: LanguageModelV2Usage;
}

export interface CodexRunner {
  run(call: CodexRunnerCall): Promise<CodexRunnerResult>;
}

interface ParsedCodexResponse {
  finishReason: LanguageModelV2FinishReason;
  content: LanguageModelV2Content[];
}

interface SerializedTool {
  name: string;
  description?: string;
  inputSchema: JSONSchema7;
}

type PromptArrayContent = Exclude<LanguageModelV2CallOptions["prompt"][number]["content"], string>;
type PromptPart = PromptArrayContent[number];
type ToolResultPromptPart = Extract<PromptPart, { type: "tool-result" }>;

function getFunctionTools(options: LanguageModelV2CallOptions): SerializedTool[] {
  return (options.tools ?? []).flatMap((tool) => {
    if (tool.type !== "function") return [];
    return [
      {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
    ];
  });
}

function renderDataValue(data: unknown): string {
  if (typeof data === "string") return data.startsWith("data:") ? "inline-data-url" : data;
  if (data instanceof URL) return data.toString();
  if (data instanceof Uint8Array) return `binary:${data.byteLength} bytes`;
  return String(data);
}

function renderToolResult(output: ToolResultPromptPart): string {
  switch (output.output.type) {
    case "text":
    case "error-text":
      return output.output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.output.value, null, 2);
    case "content":
      return output.output.value
        .map((part: (typeof output.output.value)[number]) =>
          part.type === "text"
            ? part.text
            : `[media ${part.mediaType} ${Math.ceil(part.data.length / 4) * 3} bytes]`,
        )
        .join("\n");
    default:
      return JSON.stringify(output.output);
  }
}

function renderMessageContent(content: PromptArrayContent): string {
  return content
    .map((part: PromptPart) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "reasoning":
          return `[reasoning]\n${part.text}`;
        case "file":
          return `[file mediaType=${part.mediaType}${part.filename ? ` filename=${part.filename}` : ""} data=${renderDataValue(part.data)}]`;
        case "tool-call":
          return `[assistant tool call ${part.toolName} id=${part.toolCallId}]\n${JSON.stringify(part.input, null, 2)}`;
        case "tool-result":
          return `[tool result ${part.toolName} id=${part.toolCallId}]\n${renderToolResult(part)}`;
        default:
          return JSON.stringify(part);
      }
    })
    .join("\n\n");
}

function describeToolChoice(options: LanguageModelV2CallOptions): string {
  const choice = options.toolChoice;
  if (!choice || choice.type === "auto") {
    return "Client tools are available for this step. If a tool helps you answer correctly, return finishReason=tool-calls and request it.";
  }
  if (choice.type === "none") return "Do not call any tools. Answer directly.";
  if (choice.type === "required") return "You must call one or more tools before responding.";
  return `You must call the tool named ${choice.toolName} before responding.`;
}

export function serializeCodexPrompt(options: LanguageModelV2CallOptions): string {
  const tools = getFunctionTools(options);
  const transcript = options.prompt
    .map((message, index) => {
      const role = message.role.toUpperCase();
      const content =
        typeof message.content === "string"
          ? message.content
          : renderMessageContent(message.content);
      return `${index + 1}. ${role}\n${content}`;
    })
    .join("\n\n");

  const toolBlock =
    tools.length === 0
      ? "No tools are available for this step."
      : tools
          .map(
            (tool, index) =>
              `${index + 1}. ${tool.name}${tool.description ? ` — ${tool.description}` : ""}\nInput schema:\n${JSON.stringify(tool.inputSchema, null, 2)}`,
          )
          .join("\n\n");

  const jsonInstruction =
    options.responseFormat?.type === "json"
      ? `If you choose finishReason=stop, the text field must contain raw JSON matching this schema exactly:\n${JSON.stringify(options.responseFormat.schema ?? {}, null, 2)}`
      : "If you choose finishReason=stop, the text field must contain the assistant reply as plain text with no markdown wrapper.";

  return [
    "You are Codex running as the language-model backend for SoulForge.",
    "Operate only as a model adapter.",
    "Do not execute shell commands, edit files, browse the web, or use Codex internal tools.",
    "The tools listed below are external client tools. You ARE allowed to request them by returning toolCalls in your JSON response.",
    "Decide the next assistant step for the conversation transcript below.",
    "Return ONLY valid JSON that matches the provided output schema.",
    "When finishReason is tool-calls, leave text empty and fill toolCalls with the exact tool names and an inputJson string that is valid JSON for that tool.",
    jsonInstruction,
    describeToolChoice(options),
    "",
    "AVAILABLE TOOLS",
    toolBlock,
    "",
    "CONVERSATION TRANSCRIPT",
    transcript,
  ].join("\n");
}

export function buildCodexSchema(options: LanguageModelV2CallOptions): JSONSchema7 {
  const tools = getFunctionTools(options);
  const toolChoice = options.toolChoice;
  const finishReasons: string[] = [];

  if (!tools.length || toolChoice?.type === "none") finishReasons.push("stop");
  else if (toolChoice?.type === "required" || toolChoice?.type === "tool")
    finishReasons.push("tool-calls");
  else finishReasons.push("stop", "tool-calls");

  const allowedNames =
    toolChoice?.type === "tool" ? [toolChoice.toolName] : tools.map((tool) => tool.name);

  const toolCallItems: JSONSchema7 = tools.length
    ? {
        type: "object",
        additionalProperties: false,
        properties: {
          toolName: { type: "string", enum: allowedNames },
          inputJson: { type: "string" },
        },
        required: ["toolName", "inputJson"],
      }
    : {
        type: "object",
        additionalProperties: false,
        properties: {},
      };

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      finishReason: { type: "string", enum: finishReasons },
      reasoning: { type: "string" },
      text: { type: "string" },
      toolCalls: {
        type: "array",
        minItems:
          tools.length && (toolChoice?.type === "required" || toolChoice?.type === "tool") ? 1 : 0,
        maxItems: tools.length ? undefined : 0,
        items: toolCallItems,
      },
    },
    required: ["finishReason", "reasoning", "text", "toolCalls"],
  };
}

export function parseCodexResponse(text: string): ParsedCodexResponse {
  let parsed: {
    finishReason?: string;
    reasoning?: string;
    text?: string;
    toolCalls?: Array<{
      toolName?: string;
      input?: Record<string, unknown>;
      inputJson?: string;
    }>;
  };

  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { content: [{ type: "text", text }], finishReason: "stop" };
  }

  const content: LanguageModelV2Content[] = [];
  if (parsed.reasoning?.trim()) {
    content.push({ type: "reasoning", text: parsed.reasoning.trim() });
  }

  if (parsed.finishReason === "tool-calls") {
    const toolCalls = Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [];
    for (const toolCall of toolCalls) {
      if (!toolCall?.toolName) continue;
      const inputJson =
        typeof toolCall.inputJson === "string"
          ? toolCall.inputJson
          : JSON.stringify(toolCall.input ?? {});
      content.push({
        type: "tool-call",
        toolCallId: randomUUID(),
        toolName: toolCall.toolName,
        input: inputJson,
      });
    }
    if (content.length === 0 || content.every((part) => part.type === "reasoning")) {
      throw new Error("Codex returned finishReason=tool-calls without any tool calls");
    }
    return { content, finishReason: "tool-calls" };
  }

  if (parsed.text) {
    content.push({ type: "text", text: parsed.text });
  }

  return { content, finishReason: "stop" };
}

function collectWarnings(options: LanguageModelV2CallOptions): LanguageModelV2CallWarning[] {
  const warnings: LanguageModelV2CallWarning[] = [];
  for (const setting of [
    "maxOutputTokens",
    "temperature",
    "stopSequences",
    "topP",
    "topK",
    "presencePenalty",
    "frequencyPenalty",
    "seed",
  ] as const) {
    if (options[setting] !== undefined) {
      warnings.push({
        type: "unsupported-setting",
        setting,
        details: "Codex CLI ignores this setting",
      });
    }
  }
  return warnings;
}

class CodexCliRunner implements CodexRunner {
  async run(call: CodexRunnerCall): Promise<CodexRunnerResult> {
    const dir = await mkdtemp(join(tmpdir(), "soulforge-codex-"));
    const schemaPath = join(dir, "schema.json");
    await writeFile(schemaPath, JSON.stringify(call.schema, null, 2), "utf8");

    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--config",
      'approval_policy="never"',
      "--cd",
      getCwd(),
      "--output-schema",
      schemaPath,
      "--model",
      call.modelId,
    ];

    try {
      return await runCodexProcess(args, call.prompt, call.abortSignal);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

async function runCodexProcess(
  args: string[],
  prompt: string,
  abortSignal?: AbortSignal,
): Promise<CodexRunnerResult> {
  const child = spawn("codex", args, { signal: abortSignal });
  trackProcess(child);
  let spawnError: unknown | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });

  if (!child.stdin || !child.stdout) {
    child.kill();
    throw new Error("Failed to start Codex CLI");
  }

  child.stdin.write(prompt);
  child.stdin.end();

  const stderrChunks: Buffer[] = [];
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
  }

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let finalText = "";
  let usage: LanguageModelV2Usage = {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  };
  let turnFailure: string | null = null;
  let streamFailure: string | null = null;

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (event.type === "item.completed") {
        const item = event.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          finalText = item.text;
        }
      } else if (event.type === "turn.completed") {
        const rawUsage = event.usage as
          | { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
          | undefined;
        if (rawUsage) {
          usage = {
            inputTokens: rawUsage.input_tokens,
            outputTokens: rawUsage.output_tokens,
            totalTokens:
              rawUsage.input_tokens != null && rawUsage.output_tokens != null
                ? rawUsage.input_tokens + rawUsage.output_tokens
                : undefined,
            cachedInputTokens: rawUsage.cached_input_tokens,
          };
        }
      } else if (event.type === "turn.failed") {
        const error = event.error as { message?: string } | undefined;
        turnFailure = error?.message ?? "Codex turn failed";
      } else if (event.type === "error") {
        streamFailure = typeof event.message === "string" ? event.message : "Codex stream failed";
      }
    }

    if (spawnError) throw spawnError;
    const exit = await exitPromise;
    if (turnFailure) throw new Error(turnFailure);
    if (streamFailure) throw new Error(streamFailure);
    if (exit.code !== 0 || exit.signal) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const detail = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 1}`;
      throw new Error(`Codex exec exited with ${detail}${stderr ? `: ${stderr}` : ""}`);
    }
    if (!finalText) {
      throw new Error("Codex exec returned no final agent message");
    }
    return { text: finalText, usage };
  } finally {
    rl.close();
    child.removeAllListeners();
    try {
      if (!child.killed) child.kill();
    } catch {}
  }
}

export function createCodexLanguageModel(
  modelId: string,
  runner: CodexRunner = new CodexCliRunner(),
): LanguageModelV2 {
  const warningsFor = (options: LanguageModelV2CallOptions) => collectWarnings(options);

  return {
    specificationVersion: "v2",
    provider: "codex",
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const warnings = warningsFor(options);
      const result = await runner.run({
        modelId,
        prompt: serializeCodexPrompt(options),
        schema: buildCodexSchema(options),
        abortSignal: options.abortSignal,
      });

      const parsed = parseCodexResponse(result.text);
      return {
        content: parsed.content,
        finishReason: parsed.finishReason,
        usage: result.usage,
        warnings,
      };
    },
    async doStream(options) {
      const generated = await this.doGenerate(options);
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: warningsFor(options) });
          for (const part of generated.content) {
            if (part.type === "reasoning") {
              const id = `${modelId}-reasoning-${randomUUID()}`;
              controller.enqueue({ type: "reasoning-start", id });
              controller.enqueue({ type: "reasoning-delta", id, delta: part.text });
              controller.enqueue({ type: "reasoning-end", id });
            } else if (part.type === "text") {
              const id = `${modelId}-text-${randomUUID()}`;
              controller.enqueue({ type: "text-start", id });
              controller.enqueue({ type: "text-delta", id, delta: part.text });
              controller.enqueue({ type: "text-end", id });
            } else if (part.type === "tool-call") {
              controller.enqueue(part);
            }
          }
          controller.enqueue({
            type: "finish",
            finishReason: generated.finishReason,
            usage: generated.usage,
          });
          controller.close();
        },
      });

      return { stream };
    },
  };
}
