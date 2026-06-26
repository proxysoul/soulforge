import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider";
import type { LanguageModelMiddleware } from "ai";

/** Recovery shim for proxies that leak Claude's native tool-call syntax as plain
 *  text instead of structured tool_use blocks.
 *
 *  Seen with CLIProxyAPI serving Claude: an
 *    <invoke name="..."><parameter name="...">...</parameter></invoke>
 *  block arrives inside a TEXT part rather than a tool_use block. The AI SDK sees
 *  no tool call, so the agent loop treats the turn as a final answer and STOPS
 *  mid-task — the user sees the raw XML (often with a stray decoded token like
 *  "court" in front) and nothing runs.
 *
 *  This middleware detects a well-formed, fully-closed invoke block whose tool
 *  name the request actually offered, rewrites it into a real `tool-call` stream
 *  part, suppresses the leaked text, and flips finishReason to "tool-calls" so the
 *  loop continues.
 *
 *  Heavily gated — it is inert unless ALL hold:
 *    1. The request offered tools (otherwise nothing to match against).
 *    2. The provider did NOT already emit a structured tool call (no leak present).
 *    3. The leaked block is fully closed and parses to a tool whose name is in the
 *       request's tool set. Unknown / malformed / unterminated → flushed back as
 *       plain text, never fabricated into a call.
 *
 *  Scope: wired ONLY into the proxy provider's Claude branch (proxy.ts). Never
 *  applied to direct Anthropic or any other provider. */

// A leak always begins with one of these (optionally namespaced with `antml:`).
const SENTINEL = /<(?:antml:)?(?:invoke\b|function_calls\b)/;
const SENTINEL_LITERALS = ["<invoke", "<function_calls", "<invoke", "<function_calls"];

function invokeRe(): RegExp {
  return /<(?:antml:)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?invoke>/g;
}
function paramRe(): RegExp {
  return /<(?:antml:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?parameter>/g;
}

/** Scalars pass through as-is (model writes them bare); JSON values parse. Mirrors
 *  the harness convention: "scalars as-is, lists/objects as JSON". */
function coerce(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function buildArgs(body: string): string {
  const args: Record<string, unknown> = {};
  for (const m of body.matchAll(paramRe())) {
    const name = m[1];
    const raw = m[2];
    if (name === undefined || raw === undefined) continue;
    args[name] = coerce(raw);
  }
  return JSON.stringify(args);
}

function makeToolCall(name: string, body: string): LanguageModelV3ToolCall {
  return {
    type: "tool-call",
    toolCallId: `leak_${crypto.randomUUID()}`,
    toolName: name,
    input: buildArgs(body),
  };
}

/** Parse every recognized invoke in a closed block. Unknown tools are skipped so
 *  the caller can fall back to emitting the text verbatim. */
function parseInvokeBlock(block: string, valid: Set<string>): LanguageModelV3ToolCall[] {
  const calls: LanguageModelV3ToolCall[] = [];
  for (const m of block.matchAll(invokeRe())) {
    const name = m[1];
    const body = m[2];
    if (name === undefined || body === undefined || !valid.has(name)) continue;
    calls.push(makeToolCall(name, body));
  }
  return calls;
}

function validToolNames(params: LanguageModelV3CallOptions): Set<string> {
  const names = new Set<string>();
  for (const tool of params.tools ?? []) {
    if (tool.type === "function") names.add(tool.name);
  }
  return names;
}

type Controller = TransformStreamDefaultController<LanguageModelV3StreamPart>;

/** Streaming state machine: forwards clean text untouched, holds back only a
 *  trailing fragment that could grow into a sentinel, captures a confirmed leak
 *  until it closes, then converts or (fail-safe) re-emits it as text. */
function buildLeakTransform(
  valid: Set<string>,
): TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart> {
  let mode: "pass" | "capture" = "pass";
  let tail = ""; // potential sentinel prefix held back in pass mode
  let capture = ""; // confirmed leak being accumulated until it closes
  let textId: string | undefined;
  let textOpen = false;
  let sawRealToolCall = false;
  const recovered: LanguageModelV3ToolCall[] = [];
  const suppressed: string[] = []; // raw text of converted blocks, for non-lossy stand-down

  const emitText = (controller: Controller, text: string) => {
    if (!text) return;
    if (textOpen && textId) {
      controller.enqueue({ type: "text-delta", id: textId, delta: text });
    } else {
      const id = `leak_${crypto.randomUUID()}`;
      controller.enqueue({ type: "text-start", id });
      controller.enqueue({ type: "text-delta", id, delta: text });
      controller.enqueue({ type: "text-end", id });
    }
  };

  // Longest suffix of buf that is a strict prefix of a sentinel literal — held
  // back so a sentinel split across chunks ("<inv" | "oke ...") still matches.
  const holdLen = (buf: string): number => {
    const lt = buf.lastIndexOf("<");
    if (lt === -1) return 0;
    const suffix = buf.slice(lt);
    for (const lit of SENTINEL_LITERALS) {
      if (suffix.length < lit.length && lit.startsWith(suffix)) return suffix.length;
    }
    return 0;
  };

  // Try to close the active capture. Returns leftover text after the block, or
  // null while still accumulating.
  const tryClose = (controller: Controller): string | null => {
    const isWrapper = /^<(?:antml:)?function_calls\b/.test(capture);
    const closer = isWrapper ? /<\/(?:antml:)?function_calls>/ : /<\/(?:antml:)?invoke>/;
    const m = closer.exec(capture);
    if (!m) return null;
    const end = m.index + m[0].length;
    const block = capture.slice(0, end);
    const rest = capture.slice(end);
    const calls = parseInvokeBlock(block, valid);
    if (calls.length > 0) {
      recovered.push(...calls); // suppress the leaked text, convert to tool calls
      suppressed.push(block);
    } else {
      emitText(controller, block); // fail-safe: not a real tool call, keep as text
    }
    mode = "pass";
    capture = "";
    return rest;
  };

  const pass = (controller: Controller, text: string) => {
    let buf = tail + text;
    tail = "";
    while (true) {
      const m = SENTINEL.exec(buf);
      if (!m) {
        const hold = holdLen(buf);
        emitText(controller, buf.slice(0, buf.length - hold));
        tail = buf.slice(buf.length - hold);
        return;
      }
      emitText(controller, buf.slice(0, m.index));
      mode = "capture";
      capture = buf.slice(m.index);
      const rest = tryClose(controller);
      if (rest === null) return; // wait for more deltas
      buf = rest;
    }
  };

  const flushPending = (controller: Controller) => {
    if (mode === "capture") {
      emitText(controller, capture); // unterminated leak → fail-safe as text
      capture = "";
      mode = "pass";
    }
    if (tail) {
      emitText(controller, tail);
      tail = "";
    }
  };

  return new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
    transform(part, controller) {
      switch (part.type) {
        case "text-start":
          textId = part.id;
          textOpen = true;
          controller.enqueue(part);
          return;
        case "text-delta":
          if (mode === "capture") {
            capture += part.delta;
            const rest = tryClose(controller);
            if (rest !== null && rest) pass(controller, rest);
          } else {
            pass(controller, part.delta);
          }
          return;
        case "text-end":
          flushPending(controller);
          controller.enqueue(part);
          textOpen = false;
          return;
        case "tool-call":
        case "tool-input-start":
          // Provider emitted a real tool call — there is no leak. Stand down, and
          // restore any text we optimistically suppressed so nothing is lost.
          sawRealToolCall = true;
          flushPending(controller);
          if (recovered.length > 0) {
            emitText(controller, suppressed.join(""));
            recovered.length = 0;
            suppressed.length = 0;
          }
          controller.enqueue(part);
          return;
        case "finish":
          flushPending(controller);
          if (recovered.length > 0 && !sawRealToolCall) {
            for (const call of recovered) controller.enqueue(call);
            controller.enqueue({
              ...part,
              finishReason: { ...part.finishReason, unified: "tool-calls" },
            });
          } else {
            controller.enqueue(part);
          }
          return;
        default:
          controller.enqueue(part);
      }
    },
  });
}

/** Non-streaming recovery: rewrite leaked invoke blocks in text content into
 *  tool-call content. Inert if a real tool call is already present. */
function recoverGenerate(
  content: LanguageModelV3Content[],
  valid: Set<string>,
): { content: LanguageModelV3Content[]; recovered: boolean } {
  if (content.some((c) => c.type === "tool-call")) return { content, recovered: false };

  const out: LanguageModelV3Content[] = [];
  const calls: LanguageModelV3ToolCall[] = [];

  for (const part of content) {
    if (part.type !== "text") {
      out.push(part);
      continue;
    }
    let cleaned = "";
    let last = 0;
    let found = false;
    for (const m of part.text.matchAll(invokeRe())) {
      const name = m[1];
      const body = m[2];
      const whole = m[0];
      const idx = m.index;
      if (name === undefined || body === undefined || idx === undefined || !valid.has(name)) {
        continue;
      }
      found = true;
      calls.push(makeToolCall(name, body));
      cleaned += part.text.slice(last, idx);
      last = idx + whole.length;
    }
    if (!found) {
      out.push(part);
      continue;
    }
    cleaned += part.text.slice(last);
    cleaned = cleaned.replace(/<\/?(?:antml:)?function_calls>/g, "").trim();
    if (cleaned.length > 0) out.push({ ...part, text: cleaned });
  }

  if (calls.length === 0) return { content, recovered: false };
  out.push(...calls);
  return { content: out, recovered: true };
}

export function recoverLeakedToolCallsMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    async wrapStream({ doStream, params }) {
      const valid = validToolNames(params);
      const result = await doStream();
      if (valid.size === 0) return result;
      return { ...result, stream: result.stream.pipeThrough(buildLeakTransform(valid)) };
    },
    async wrapGenerate({ doGenerate, params }) {
      const valid = validToolNames(params);
      const result = await doGenerate();
      if (valid.size === 0) return result;
      const { content, recovered } = recoverGenerate(result.content, valid);
      if (!recovered) return result;
      return {
        ...result,
        content,
        finishReason: { ...result.finishReason, unified: "tool-calls" },
      };
    },
  };
}
