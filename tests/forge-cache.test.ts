import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { sanitizeMessages } from "../src/core/agents/stream-options.js";
import { computeCost, type TokenUsage } from "../src/stores/statusbar.js";

function mkUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
	return {
		prompt: 0,
		completion: 0,
		total: 0,
		cacheRead: 0,
		cacheWrite: 0,
		subagentInput: 0,
		subagentOutput: 0,
		lastStepInput: 0,
		lastStepOutput: 0,
		lastStepCacheRead: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// 1. computeCost correctness
// ---------------------------------------------------------------------------

describe("computeCost correctness", () => {
	const M = 1_000_000;

	test("Opus 4.6 pricing: $5 input, $6.25 cacheWrite, $0.50 cacheRead, $25 output", () => {
		const usage = mkUsage({
			prompt: M,
			cacheWrite: M,
			cacheRead: M,
			completion: M,
		});
		const cost = computeCost(usage, "claude-opus-4-6-20250514");
		expect(cost).toBeCloseTo(5 + 6.25 + 0.5 + 25, 6);
	});

	test("Opus 4 pricing: $15 input, $18.75 cacheWrite, $1.50 cacheRead, $75 output", () => {
		const usage = mkUsage({
			prompt: M,
			cacheWrite: M,
			cacheRead: M,
			completion: M,
		});
		const cost = computeCost(usage, "claude-opus-4-20250514");
		expect(cost).toBeCloseTo(15 + 18.75 + 1.5 + 75, 6);
	});

	test("Sonnet 4.6 pricing: $3 input, $3.75 cacheWrite, $0.30 cacheRead, $15 output", () => {
		const usage = mkUsage({
			prompt: M,
			cacheWrite: M,
			cacheRead: M,
			completion: M,
		});
		const cost = computeCost(usage, "claude-sonnet-4-6-20250514");
		expect(cost).toBeCloseTo(3 + 3.75 + 0.3 + 15, 6);
	});

	test("Haiku 4.5 pricing: $1 input, $1.25 cacheWrite, $0.10 cacheRead, $5 output", () => {
		const usage = mkUsage({
			prompt: M,
			cacheWrite: M,
			cacheRead: M,
			completion: M,
		});
		const cost = computeCost(usage, "claude-haiku-4-5-20250514");
		expect(cost).toBeCloseTo(1 + 1.25 + 0.1 + 5, 6);
	});

	test("subagentInput adds to uncached input cost", () => {
		const usage = mkUsage({ prompt: M, subagentInput: M, completion: 0 });
		const cost = computeCost(usage, "claude-opus-4-6-20250514");
		expect(cost).toBeCloseTo(5 * 2, 6);
	});

	test("subagentOutput adds to output cost", () => {
		const usage = mkUsage({ completion: M, subagentOutput: M });
		const cost = computeCost(usage, "claude-opus-4-6-20250514");
		expect(cost).toBeCloseTo(25 * 2, 6);
	});

	test("zero usage returns zero cost", () => {
		expect(computeCost(mkUsage(), "claude-opus-4-6-20250514")).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 2. matchPricing model matching (tested indirectly through computeCost)
// ---------------------------------------------------------------------------

describe("matchPricing model matching", () => {
	const M = 1_000_000;

	function inputCostPer1M(modelId: string): number {
		const usage = mkUsage({ prompt: M });
		return computeCost(usage, modelId);
	}

	test("claude-opus-4-6-20250514 matches Opus 4.6 ($5/M input)", () => {
		expect(inputCostPer1M("claude-opus-4-6-20250514")).toBeCloseTo(5, 6);
	});

	test("claude-opus-4-20250514 matches Opus 4 ($15/M input), NOT Opus 4.6", () => {
		expect(inputCostPer1M("claude-opus-4-20250514")).toBeCloseTo(15, 6);
	});

	test("claude-sonnet-4-6-20250514 matches Sonnet 4.6 ($3/M input)", () => {
		expect(inputCostPer1M("claude-sonnet-4-6-20250514")).toBeCloseTo(3, 6);
	});

	test("anthropic/claude-opus-4-6 matches Opus 4.6 via includes ($5/M input)", () => {
		expect(inputCostPer1M("anthropic/claude-opus-4-6")).toBeCloseTo(5, 6);
	});

	test("some-unknown-model falls back to default Sonnet pricing ($3/M input)", () => {
		expect(inputCostPer1M("some-unknown-model")).toBeCloseTo(3, 6);
	});

	test("case insensitive: CLAUDE-OPUS-4-6 matches Opus 4.6", () => {
		expect(inputCostPer1M("CLAUDE-OPUS-4-6")).toBeCloseTo(5, 6);
	});

	test("opus fallback: unknown-opus-model uses Opus 4.6 pricing", () => {
		expect(inputCostPer1M("my-custom-opus-finetune")).toBeCloseTo(5, 6);
	});

	test("haiku fallback: unknown-haiku-model uses Haiku 4.5 pricing", () => {
		expect(inputCostPer1M("my-custom-haiku-endpoint")).toBeCloseTo(1, 6);
	});
});

// ---------------------------------------------------------------------------
// 3. sanitizeMessages cache safety
// ---------------------------------------------------------------------------

function assistantWithToolCall(
	id: string,
	name: string,
	input: unknown,
): ModelMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "tool-call" as const,
				toolCallId: id,
				toolName: name,
				input: input as Record<string, unknown>,
			},
		],
	};
}

function toolResultMsg(id: string, name: string, output: string): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result" as const,
				toolCallId: id,
				toolName: name,
				output: { type: "text" as const, value: output } as never,
			},
		],
	};
}

describe("sanitizeMessages cache safety", () => {
	test("clean messages return the SAME array reference (=== identity)", () => {
		const messages: ModelMessage[] = [
			assistantWithToolCall("1", "read", { path: "/a.ts" }),
			toolResultMsg("1", "read", "file contents"),
		];
		const result = sanitizeMessages(messages);
		expect(result).toBe(messages);
	});

	test("orphan tool-result with no matching assistant tool-call is dropped", () => {
		// Anthropic rejects with "unexpected tool_use_id found in tool_result blocks"
		// when a tool message references a tool-call that doesn't exist in any
		// preceding assistant message — sanitizeMessages drops the orphan to keep
		// the next request valid.
		const messages: ModelMessage[] = [
			{ role: "user", content: [{ type: "text" as const, text: "hello" }] },
			toolResultMsg("1", "read", "output"),
		];
		const result = sanitizeMessages(messages);
		expect(result).not.toBe(messages);
		expect(result).toHaveLength(1);
		expect(result[0]?.role).toBe("user");
	});

	test("broken tool-call input (string) gets fixed to empty object", () => {
		const messages: ModelMessage[] = [
			assistantWithToolCall("1", "read", "not an object"),
			toolResultMsg("1", "read", "output"),
		];
		const result = sanitizeMessages(messages);
		expect(result).not.toBe(messages);
		const assistantMsg = result[0];
		expect(assistantMsg?.role).toBe("assistant");
		const parts = assistantMsg?.content as Array<{ type: string; input: unknown }>;
		expect(parts[0]?.input).toEqual({});
	});

	test("broken tool-call input (array) gets fixed to empty object", () => {
		const messages: ModelMessage[] = [
			assistantWithToolCall("1", "read", ["bad", "input"]),
			toolResultMsg("1", "read", "output"),
		];
		const result = sanitizeMessages(messages);
		expect(result).not.toBe(messages);
		const parts = result[0]?.content as Array<{ type: string; input: unknown }>;
		expect(parts[0]?.input).toEqual({});
	});

	test("broken tool-call input (null) gets fixed to empty object", () => {
		const messages: ModelMessage[] = [
			assistantWithToolCall("1", "read", null),
			toolResultMsg("1", "read", "output"),
		];
		const result = sanitizeMessages(messages);
		expect(result).not.toBe(messages);
		const parts = result[0]?.content as Array<{ type: string; input: unknown }>;
		expect(parts[0]?.input).toEqual({});
	});

	test("only dirty messages get new objects, clean ones keep identity", () => {
		const cleanMsg = assistantWithToolCall("1", "read", { path: "/a.ts" });
		const dirtyMsg = assistantWithToolCall("2", "grep", "bad string input");
		const toolMsg = toolResultMsg("1", "read", "output");
		const messages: ModelMessage[] = [cleanMsg, dirtyMsg, toolMsg];

		const result = sanitizeMessages(messages);
		expect(result).not.toBe(messages);
		expect(result[0]).toBe(cleanMsg);
		expect(result[1]).not.toBe(dirtyMsg);
		expect(result[2]).toBe(toolMsg);
	});

	test("mixed valid and invalid parts in same assistant message", () => {
		const msg: ModelMessage = {
			role: "assistant",
			content: [
				{
					type: "tool-call" as const,
					toolCallId: "1",
					toolName: "read",
					input: { path: "/a.ts" },
				},
				{
					type: "tool-call" as const,
					toolCallId: "2",
					toolName: "grep",
					input: "bad" as unknown as Record<string, unknown>,
				},
			],
		};
		const messages: ModelMessage[] = [msg];
		const result = sanitizeMessages(messages);
		expect(result).not.toBe(messages);
		const parts = result[0]?.content as Array<{ type: string; input: unknown }>;
		expect(parts[0]?.input).toEqual({ path: "/a.ts" });
		expect(parts[1]?.input).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// 4. TokenUsage cacheWrite separation
// ---------------------------------------------------------------------------

describe("TokenUsage cacheWrite separation", () => {
	test("prompt field only contains noCache tokens (separate from cacheWrite)", () => {
		const usage = mkUsage({
			prompt: 50_000,
			cacheWrite: 100_000,
			cacheRead: 30_000,
			completion: 10_000,
		});
		const costWithCacheWrite = computeCost(usage, "claude-opus-4-6-20250514");

		const usageNoCacheWrite = mkUsage({
			prompt: 50_000,
			cacheWrite: 0,
			cacheRead: 30_000,
			completion: 10_000,
		});
		const costNoCacheWrite = computeCost(usageNoCacheWrite, "claude-opus-4-6-20250514");

		const cacheWriteCostDelta = costWithCacheWrite - costNoCacheWrite;
		const expectedDelta = (100_000 / 1e6) * 6.25;
		expect(cacheWriteCostDelta).toBeCloseTo(expectedDelta, 6);
	});

	test("cacheWrite rate differs from input rate", () => {
		const M = 1_000_000;
		const promptOnly = computeCost(mkUsage({ prompt: M }), "claude-opus-4-6-20250514");
		const cacheWriteOnly = computeCost(mkUsage({ cacheWrite: M }), "claude-opus-4-6-20250514");
		expect(promptOnly).toBeCloseTo(5, 6);
		expect(cacheWriteOnly).toBeCloseTo(6.25, 6);
		expect(promptOnly).not.toBe(cacheWriteOnly);
	});

	test("cacheRead + cacheWrite + prompt covers all input-side tokens", () => {
		const usage = mkUsage({
			prompt: 100_000,
			cacheWrite: 50_000,
			cacheRead: 30_000,
			completion: 20_000,
			total: 200_000,
		});
		const inputSideTokens = usage.prompt + usage.cacheWrite + usage.cacheRead;
		expect(inputSideTokens).toBeLessThanOrEqual(usage.total - usage.completion);
	});

	test("each cache bucket is charged independently", () => {
		const M = 1_000_000;
		const model = "claude-opus-4-6-20250514";
		const all = computeCost(
			mkUsage({ prompt: M, cacheWrite: M, cacheRead: M, completion: M }),
			model,
		);
		const sum =
			computeCost(mkUsage({ prompt: M }), model) +
			computeCost(mkUsage({ cacheWrite: M }), model) +
			computeCost(mkUsage({ cacheRead: M }), model) +
			computeCost(mkUsage({ completion: M }), model);
		expect(all).toBeCloseTo(sum, 6);
	});
});

// ---------------------------------------------------------------------------
// 5. pruningTarget cycle
// ---------------------------------------------------------------------------

describe("pruningTarget cycle", () => {
	function shouldPruneMain(target: string): boolean {
		return ["main", "both"].includes(target);
	}

	function shouldPruneSubagent(target: string): boolean {
		const disablePruning = !["subagents", "both"].includes(target);
		return !disablePruning;
	}

	test('"none" → main: no prune, subagent: no prune', () => {
		expect(shouldPruneMain("none")).toBe(false);
		expect(shouldPruneSubagent("none")).toBe(false);
	});

	test('"main" → main: prune, subagent: no prune', () => {
		expect(shouldPruneMain("main")).toBe(true);
		expect(shouldPruneSubagent("main")).toBe(false);
	});

	test('"subagents" → main: no prune, subagent: prune', () => {
		expect(shouldPruneMain("subagents")).toBe(false);
		expect(shouldPruneSubagent("subagents")).toBe(true);
	});

	test('"both" → main: prune, subagent: prune', () => {
		expect(shouldPruneMain("both")).toBe(true);
		expect(shouldPruneSubagent("both")).toBe(true);
	});

	test("default (undefined → subagents) → main: no prune, subagent: prune", () => {
		const target = undefined ?? "subagents";
		expect(shouldPruneMain(target)).toBe(false);
		expect(shouldPruneSubagent(target)).toBe(true);
	});
});
