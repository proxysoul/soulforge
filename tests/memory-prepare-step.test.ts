import type { ModelMessage } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "bun:test";
import { buildPrepareStep } from "../src/core/agents/step-utils.js";

function userMsg(text: string): ModelMessage {
  return { role: "user", content: text };
}

function assistantMsg(text: string): ModelMessage {
  return { role: "assistant", content: text };
}

function makeContextManager(
  pair: [{ role: "user"; content: string }, { role: "assistant"; content: string }] | null,
  callTracker?: { count: number },
) {
  return {
    buildMemoryRecallMessages: async (q: string) => {
      if (callTracker) callTracker.count++;
      void q;
      return pair;
    },
  };
}

describe("buildPrepareStep — memory recall inject", () => {
  it("injects recall pair before the latest user turn on step 0", async () => {
    const recallPair: [
      { role: "user"; content: string },
      { role: "assistant"; content: string },
    ] = [
      { role: "user", content: "<recalled_memories>\nm1\n</recalled_memories>" },
      { role: "assistant", content: "Acknowledged — 1 relevant memory surfaced." },
    ];
    const { prepareStep } = buildPrepareStep({
      role: "code",
      allTools: {},
      contextManager: makeContextManager(recallPair),
    });

    const messages: ModelMessage[] = [userMsg("How do I auth?")];
    const out = await prepareStep({ stepNumber: 0, steps: [], messages } as never);
    expect(out).toBeDefined();
    const msgs = (out as { messages: ModelMessage[] }).messages;
    // Order: recall-user, recall-assistant, original user
    const last3 = msgs.slice(-3);
    expect(last3[0].role).toBe("user");
    expect(typeof last3[0].content === "string" && last3[0].content.includes("recalled_memories"))
      .toBe(true);
    expect(last3[1].role).toBe("assistant");
    expect(last3[2].role).toBe("user");
    expect(last3[2].content).toBe("How do I auth?");
  });

  it("omits recall when context manager returns null", async () => {
    const { prepareStep } = buildPrepareStep({
      role: "code",
      allTools: {},
      contextManager: makeContextManager(null),
    });

    const messages: ModelMessage[] = [userMsg("Hello")];
    const out = await prepareStep({ stepNumber: 0, steps: [], messages } as never);
    // No recall pair, no hints → step 0 may still set toolChoice but messages
    // should equal original (or undefined).
    if (out && (out as { messages?: ModelMessage[] }).messages) {
      const msgs = (out as { messages: ModelMessage[] }).messages;
      // No <recalled_memories> anywhere
      for (const m of msgs) {
        if (typeof m.content === "string") {
          expect(m.content.includes("recalled_memories")).toBe(false);
        }
      }
    }
  });

  it("only calls recall once per user turn (not on every step)", async () => {
    const tracker = { count: 0 };
    const recallPair: [
      { role: "user"; content: string },
      { role: "assistant"; content: string },
    ] = [
      { role: "user", content: "<recalled_memories>\nx\n</recalled_memories>" },
      { role: "assistant", content: "ack" },
    ];
    const { prepareStep } = buildPrepareStep({
      role: "code",
      allTools: {},
      contextManager: makeContextManager(recallPair, tracker),
    });

    const messages: ModelMessage[] = [userMsg("first turn")];
    await prepareStep({ stepNumber: 0, steps: [], messages } as never);
    expect(tracker.count).toBe(1);

    // Same user turn (just an assistant added) → no new recall call
    const sameTurn = [...messages, assistantMsg("working...")];
    await prepareStep({ stepNumber: 1, steps: [], messages: sameTurn } as never);
    expect(tracker.count).toBe(1);

    // New user turn → another recall call
    const newTurn = [...sameTurn, userMsg("second turn")];
    await prepareStep({ stepNumber: 2, steps: [], messages: newTurn } as never);
    expect(tracker.count).toBe(2);
  });
});
