import { describe, expect, test } from "bun:test";
import type { LanguageModelV3Content, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { recoverLeakedToolCallsMiddleware } from "../src/core/llm/providers/recover-leaked-tool-calls.js";

function toolDefs(names: string[]) {
  return names.map((name) => ({ type: "function" as const, name, inputSchema: {} }));
}

function partsStream(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

const finish = (unified: string): LanguageModelV3StreamPart =>
  ({
    type: "finish",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: { unified, raw: unified },
  }) as unknown as LanguageModelV3StreamPart;

async function runStream(
  parts: LanguageModelV3StreamPart[],
  toolNames: string[],
): Promise<LanguageModelV3StreamPart[]> {
  const mw = recoverLeakedToolCallsMiddleware();
  const wrapStream = mw.wrapStream;
  if (!wrapStream) throw new Error("wrapStream missing");
  const res = await wrapStream({
    doStream: async () => ({ stream: partsStream(parts) }),
    doGenerate: async () => ({}),
    params: { tools: toolDefs(toolNames) },
    model: {},
  } as unknown as Parameters<typeof wrapStream>[0]);
  const out: LanguageModelV3StreamPart[] = [];
  const reader = res.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

async function runGenerate(content: LanguageModelV3Content[], toolNames: string[]) {
  const mw = recoverLeakedToolCallsMiddleware();
  const wrapGenerate = mw.wrapGenerate;
  if (!wrapGenerate) throw new Error("wrapGenerate missing");
  return wrapGenerate({
    doGenerate: async () => ({
      content,
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
    doStream: async () => ({}),
    params: { tools: toolDefs(toolNames) },
    model: {},
  } as unknown as Parameters<typeof wrapGenerate>[0]);
}

function toolCalls(parts: LanguageModelV3StreamPart[]) {
  return parts.filter((p): p is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> =>
    p.type === "tool-call",
  );
}

function streamedText(parts: LanguageModelV3StreamPart[]): string {
  return parts
    .filter((p): p is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> =>
      p.type === "text-delta",
    )
    .map((p) => p.delta)
    .join("");
}

function finishUnified(parts: LanguageModelV3StreamPart[]): string | undefined {
  const f = parts.find((p) => p.type === "finish");
  return f && f.type === "finish" ? f.finishReason.unified : undefined;
}

describe("recover leaked tool calls — streaming", () => {
  test("recovers a leaked invoke split across deltas; suppresses text; flips finishReason", async () => {
    const out = await runStream(
      [
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: "court\n<inv" },
        { type: "text-delta", id: "t0", delta: 'oke name="project">\n<parameter name="action">' },
        { type: "text-delta", id: "t0", delta: "typecheck</parameter>\n</invoke>" },
        { type: "text-end", id: "t0" },
        finish("stop"),
      ],
      ["project"],
    );

    const calls = toolCalls(out);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("project");
    expect(JSON.parse(calls[0]?.input ?? "{}")).toEqual({ action: "typecheck" });
    // leaked XML must not survive in the visible text
    expect(streamedText(out)).not.toContain("<invoke");
    expect(streamedText(out)).not.toContain("parameter");
    expect(finishUnified(out)).toBe("tool-calls");
  });

  test("coerces JSON param values (number, array) but keeps bare strings", async () => {
    const out = await runStream(
      [
        { type: "text-start", id: "t0" },
        {
          type: "text-delta",
          id: "t0",
          delta:
            '<invoke name="edit"><parameter name="line">42</parameter>' +
            '<parameter name="files">["a.ts","b.ts"]</parameter>' +
            '<parameter name="name">typecheck</parameter></invoke>',
        },
        { type: "text-end", id: "t0" },
        finish("stop"),
      ],
      ["edit"],
    );
    const input = JSON.parse(toolCalls(out)[0]?.input ?? "{}");
    expect(input).toEqual({ line: 42, files: ["a.ts", "b.ts"], name: "typecheck" });
  });

  test("unknown tool name is NOT converted — leaked block flushed as text, finish unchanged", async () => {
    const out = await runStream(
      [
        { type: "text-start", id: "t0" },
        {
          type: "text-delta",
          id: "t0",
          delta: '<invoke name="frobnicate"><parameter name="x">1</parameter></invoke>',
        },
        { type: "text-end", id: "t0" },
        finish("stop"),
      ],
      ["project"],
    );
    expect(toolCalls(out)).toHaveLength(0);
    expect(streamedText(out)).toContain("<invoke");
    expect(finishUnified(out)).toBe("stop");
  });

  test("clean text with stray '<' passes through untouched", async () => {
    const out = await runStream(
      [
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: "if a < b and c > d then" },
        { type: "text-delta", id: "t0", delta: " return <T>(x)" },
        { type: "text-end", id: "t0" },
        finish("stop"),
      ],
      ["project"],
    );
    expect(toolCalls(out)).toHaveLength(0);
    expect(streamedText(out)).toBe("if a < b and c > d then return <T>(x)");
    expect(finishUnified(out)).toBe("stop");
  });

  test("real provider tool call present → recovery stands down", async () => {
    const out = await runStream(
      [
        { type: "tool-input-start", id: "c1", toolName: "project" },
        { type: "tool-call", toolCallId: "c1", toolName: "project", input: '{"action":"test"}' },
        finish("tool-calls"),
      ],
      ["project"],
    );
    expect(toolCalls(out)).toHaveLength(1);
    expect(toolCalls(out)[0]?.toolCallId).toBe("c1");
    expect(finishUnified(out)).toBe("tool-calls");
  });

  test("no tools offered → middleware is inert (leak not recovered)", async () => {
    const out = await runStream(
      [
        { type: "text-start", id: "t0" },
        {
          type: "text-delta",
          id: "t0",
          delta: '<invoke name="project"><parameter name="action">x</parameter></invoke>',
        },
        { type: "text-end", id: "t0" },
        finish("stop"),
      ],
      [],
    );
    expect(toolCalls(out)).toHaveLength(0);
    expect(streamedText(out)).toContain("<invoke");
  });

  test("transparent on a normal turn: reasoning + text + real tool call pass through identically", async () => {
    const input: LanguageModelV3StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "reasoning-start", id: "r0" },
      { type: "reasoning-delta", id: "r0", delta: "Let me think about <think> tags." },
      { type: "reasoning-end", id: "r0" },
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: "I'll read it." },
      { type: "text-end", id: "t0" },
      { type: "tool-input-start", id: "c1", toolName: "read_file" },
      { type: "tool-input-delta", id: "c1", delta: '{"path":"a.ts"}' },
      { type: "tool-input-end", id: "c1" },
      { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: '{"path":"a.ts"}' },
      finish("tool-calls"),
    ];
    const out = await runStream(input, ["read_file", "project"]);
    // byte-for-byte identical part stream — nothing added, dropped, or reordered
    expect(out).toEqual(input);
  });

  test("content preserved if a real tool call follows a converted block (no silent drop)", async () => {
    const out = await runStream(
      [
        { type: "text-start", id: "t0" },
        {
          type: "text-delta",
          id: "t0",
          delta: '<invoke name="project"><parameter name="action">x</parameter></invoke>',
        },
        { type: "text-end", id: "t0" },
        { type: "tool-call", toolCallId: "c1", toolName: "project", input: '{"action":"test"}' },
        finish("tool-calls"),
      ],
      ["project"],
    );
    // recovery stood down → exactly the one real call, leaked text restored, nothing lost
    expect(toolCalls(out)).toHaveLength(1);
    expect(toolCalls(out)[0]?.toolCallId).toBe("c1");
    expect(streamedText(out)).toContain("<invoke");
    expect(finishUnified(out)).toBe("tool-calls");
  });

  test("function_calls wrapper with two invokes → two recovered calls", async () => {
    const out = await runStream(
      [
        { type: "text-start", id: "t0" },
        {
          type: "text-delta",
          id: "t0",
          delta:
            "<function_calls>" +
            '<invoke name="project"><parameter name="action">lint</parameter></invoke>' +
            '<invoke name="project"><parameter name="action">test</parameter></invoke>' +
            "</function_calls>",
        },
        { type: "text-end", id: "t0" },
        finish("stop"),
      ],
      ["project"],
    );
    const calls = toolCalls(out);
    expect(calls).toHaveLength(2);
    expect(streamedText(out)).not.toContain("function_calls");
    expect(finishUnified(out)).toBe("tool-calls");
  });
});

describe("recover leaked tool calls — non-streaming", () => {
  test("rewrites leaked invoke in text content into a tool-call", async () => {
    const res = await runGenerate(
      [
        {
          type: "text",
          text: 'done.\n<invoke name="project"><parameter name="action">typecheck</parameter></invoke>',
        },
      ],
      ["project"],
    );
    const calls = res.content.filter((c) => c.type === "tool-call");
    expect(calls).toHaveLength(1);
    expect(res.finishReason.unified).toBe("tool-calls");
    const text = res.content.find((c) => c.type === "text");
    expect(text && text.type === "text" ? text.text : "").not.toContain("<invoke");
  });

  test("inert when a real tool call is already present", async () => {
    const res = await runGenerate(
      [
        { type: "text", text: '<invoke name="project"><parameter name="action">x</parameter></invoke>' },
        { type: "tool-call", toolCallId: "c1", toolName: "project", input: "{}" },
      ],
      ["project"],
    );
    // unchanged: original two parts, no extra recovered call, finishReason stays stop
    expect(res.content.filter((c) => c.type === "tool-call")).toHaveLength(1);
    expect(res.finishReason.unified).toBe("stop");
  });
});
