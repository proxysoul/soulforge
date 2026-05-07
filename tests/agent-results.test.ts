import { describe, expect, it } from "bun:test";
import {
  busFooter,
  extractFinalText,
  truncateAgentText,
} from "../src/core/agents/agent-results.js";

// ─── extractFinalText ───

describe("extractFinalText", () => {
  it("returns the last step's text when present", () => {
    const result = {
      text: "ignored",
      steps: [{ text: "earlier" }, { text: "final answer of the agent run" }],
    };
    expect(extractFinalText(result)).toBe("final answer of the agent run");
  });

  it("falls back to result.text when last step has no text", () => {
    const result = {
      text: "fallback summary text",
      steps: [{ toolCalls: [{ toolName: "read" }] }],
    };
    expect(extractFinalText(result)).toBe("fallback summary text");
  });

  it("returns empty string when nothing usable", () => {
    expect(extractFinalText({ text: "", steps: [] })).toBe("");
  });

  it("extracts text from step.content[] parts when step.text is empty", () => {
    const result = {
      text: "",
      steps: [
        {
          text: "",
          content: [
            { type: "tool-call" },
            { type: "text", text: "structured part text from agent" },
          ],
        },
      ],
    };
    expect(extractFinalText(result)).toBe("structured part text from agent");
  });

  it("walks back from last step to find any text", () => {
    const result = {
      text: "",
      steps: [
        { text: "early step text from a prior turn" },
        { toolCalls: [{ toolName: "check_peers" }] },
      ],
    };
    expect(extractFinalText(result)).toBe("early step text from a prior turn");
  });
});

// ─── truncateAgentText ───

describe("truncateAgentText", () => {
  it("returns text verbatim when under threshold", () => {
    const text = "short report from agent";
    expect(truncateAgentText(text)).toBe(text);
  });

  it("returns text verbatim at exactly the threshold", () => {
    const text = "x".repeat(4000);
    expect(truncateAgentText(text)).toBe(text);
  });

  it("truncates oversized text with head + tail + footer", () => {
    const head = "H".repeat(2000);
    const middle = "M".repeat(5000);
    const tail = "T".repeat(1000);
    const text = head + middle + tail;
    const out = truncateAgentText(text);
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
    expect(out).toContain("[truncated]");
    expect(out.length).toBeLessThan(text.length);
  });

  it("includes archivePath in footer when provided", () => {
    const text = "x".repeat(10_000);
    const out = truncateAgentText(text, ".soulforge/dispatch/abc/agent-1.md");
    expect(out).toContain(".soulforge/dispatch/abc/agent-1.md");
    expect(out).toContain("[truncated, full output:");
  });
});

// ─── busFooter ───

describe("busFooter", () => {
  it("returns empty string when both lists empty", () => {
    expect(busFooter([], [])).toBe("");
  });

  it("emits Files examined when only reads present", () => {
    expect(busFooter(["a.ts", "b.ts"], [])).toBe("Files examined: a.ts, b.ts");
  });

  it("emits Files edited when only edits present", () => {
    expect(busFooter([], ["c.ts"])).toBe("Files edited: c.ts");
  });

  it("emits both lines when reads and edits both present", () => {
    const out = busFooter(["a.ts"], ["b.ts"]);
    expect(out).toBe("Files examined: a.ts\nFiles edited: b.ts");
  });
});
