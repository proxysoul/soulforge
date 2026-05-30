import { describe, expect, test, afterEach, mock } from "bun:test";
import { groq } from "../src/core/llm/providers/groq.js";
import { deepseek } from "../src/core/llm/providers/deepseek.js";
import { mistral } from "../src/core/llm/providers/mistral.js";
import { fireworks } from "../src/core/llm/providers/fireworks.js";
import { bedrock } from "../src/core/llm/providers/bedrock.js";
import { getProvider, getAllProviders } from "../src/core/llm/providers/index.js";
import { computeModelCost, isModelFree } from "../src/stores/statusbar.js";

// ── Registration ──────────────────────────────────────────────────

describe("new providers registration", () => {
	test("all 5 new providers are registered", () => {
		expect(getProvider("groq")).toBeDefined();
		expect(getProvider("deepseek")).toBeDefined();
		expect(getProvider("mistral")).toBeDefined();
		expect(getProvider("bedrock")).toBeDefined();
		expect(getProvider("fireworks")).toBeDefined();
	});

	test("all 5 have required fields", () => {
		for (const id of ["groq", "deepseek", "mistral", "bedrock", "fireworks"]) {
			const p = getProvider(id)!;
			expect(p.id).toBe(id);
			expect(p.name).toBeTruthy();
			expect(p.envVar).toBeTruthy();
			expect(p.icon).toBeTruthy();
			expect(p.asciiIcon).toBeTruthy();
			expect(typeof p.createModel).toBe("function");
			expect(typeof p.fetchModels).toBe("function");
			expect(Array.isArray(p.fallbackModels)).toBe(true);
			expect(p.fallbackModels!.length).toBeGreaterThan(0);
			expect(Array.isArray(p.contextWindows)).toBe(true);
			expect(p.contextWindows!.length).toBeGreaterThan(0);
		}
	});

	test("total builtin count increased by 5", () => {
		const builtins = getAllProviders().filter((p) => !p.custom);
		// Was 13, then 18 after the previous provider batch, now 22 with Codex + OpenCode + NIM.
		expect(builtins.length).toBe(22);
	});
});

// ── fetchModels parsing (mocked fetch) ────────────────────────────

describe("fetchModels parsing", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("groq: parses official API response, filters whisper/guard/tts", async () => {
		// Exact shape from https://console.groq.com/docs/api-reference#models-list
		const envKey = "GROQ_API_KEY";
		process.env[envKey] = "test-key";
		try {
			globalThis.fetch = mock(() =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							object: "list",
							data: [
								{ id: "llama-3.3-70b-versatile", object: "model", created: 1693721698, owned_by: "Meta", active: true, context_window: 131072 },
								{ id: "llama-3.1-8b-instant", object: "model", created: 1693721698, owned_by: "Meta", active: true, context_window: 131072 },
								{ id: "whisper-large-v3", object: "model", created: 1693721698, owned_by: "OpenAI", active: true, context_window: 448 },
								{ id: "llama-guard-3-8b", object: "model", created: 1693721698, owned_by: "Meta", active: true, context_window: 8192 },
								{ id: "playai-tts", object: "model", created: 1693721698, owned_by: "PlayAI", active: true, context_window: 0 },
								{ id: "canopylabs/orpheus-v1-english", object: "model", created: 1693721698, owned_by: "Canopy", active: true, context_window: 0 },
								{ id: "gemma2-9b-it", object: "model", created: 1693721698, owned_by: "Google", active: true, context_window: 8192 },
							],
						}),
						{ status: 200 },
					),
				),
			) as any;

			const models = await groq.fetchModels();
			expect(models).not.toBeNull();
			expect(models!.length).toBe(3); // llama-3.3, llama-3.1, gemma2
			expect(models!.find((m) => m.id === "llama-3.3-70b-versatile")).toBeDefined();
			expect(models!.find((m) => m.id === "llama-3.1-8b-instant")).toBeDefined();
			expect(models!.find((m) => m.id === "gemma2-9b-it")).toBeDefined();
			// Filtered out
			expect(models!.find((m) => m.id === "whisper-large-v3")).toBeUndefined();
			expect(models!.find((m) => m.id === "llama-guard-3-8b")).toBeUndefined();
			expect(models!.find((m) => m.id === "playai-tts")).toBeUndefined();
			expect(models!.find((m) => m.id === "canopylabs/orpheus-v1-english")).toBeUndefined();
			// context_window is passed through
			expect(models!.find((m) => m.id === "llama-3.3-70b-versatile")!.contextWindow).toBe(131072);
		} finally {
			delete process.env[envKey];
		}
	});

	test("deepseek: parses official API response", async () => {
		// Exact shape from https://api-docs.deepseek.com/api/list-models
		const envKey = "DEEPSEEK_API_KEY";
		process.env[envKey] = "test-key";
		try {
			globalThis.fetch = mock(() =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							object: "list",
							data: [
								{ id: "deepseek-chat", object: "model", owned_by: "deepseek" },
								{ id: "deepseek-reasoner", object: "model", owned_by: "deepseek" },
							],
						}),
						{ status: 200 },
					),
				),
			) as any;

			const models = await deepseek.fetchModels();
			expect(models).not.toBeNull();
			expect(models!.length).toBe(2);
			expect(models![0].id).toBe("deepseek-chat");
			expect(models![0].name).toBe("deepseek-chat");
			expect(models![1].id).toBe("deepseek-reasoner");
		} finally {
			delete process.env[envKey];
		}
	});

	test("mistral: parses official API response with max_context_length", async () => {
		// Mistral uses max_context_length and name fields
		const envKey = "MISTRAL_API_KEY";
		process.env[envKey] = "test-key";
		try {
			globalThis.fetch = mock(() =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							data: [
								{ id: "mistral-large-2512", name: "Mistral Large 3", max_context_length: 256000 },
								{ id: "mistral-small-2506", name: "Mistral Small 3.2", max_context_length: 131072 },
								{ id: "codestral-2508", name: null, max_context_length: 256000 },
							],
						}),
						{ status: 200 },
					),
				),
			) as any;

			const models = await mistral.fetchModels();
			expect(models).not.toBeNull();
			expect(models!.length).toBe(3);
			// name field used when present
			expect(models![0].name).toBe("Mistral Large 3");
			// Falls back to id when name is null
			expect(models![2].name).toBe("codestral-2508");
			// contextWindow from max_context_length
			expect(models![0].contextWindow).toBe(256000);
			expect(models![1].contextWindow).toBe(131072);
		} finally {
			delete process.env[envKey];
		}
	});

	test("fireworks: parses OpenAI-compatible response", async () => {
		const envKey = "FIREWORKS_API_KEY";
		process.env[envKey] = "test-key";
		try {
			globalThis.fetch = mock(() =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							data: [
								{ id: "accounts/fireworks/models/llama-v3p3-70b-instruct", owned_by: "fireworks" },
								{ id: "accounts/fireworks/models/deepseek-v3", owned_by: "fireworks" },
							],
						}),
						{ status: 200 },
					),
				),
			) as any;

			const models = await fireworks.fetchModels();
			expect(models).not.toBeNull();
			expect(models!.length).toBe(2);
			expect(models![0].id).toBe("accounts/fireworks/models/llama-v3p3-70b-instruct");
			expect(models![1].id).toBe("accounts/fireworks/models/deepseek-v3");
		} finally {
			delete process.env[envKey];
		}
	});

	test("bedrock: fetchModels returns null (no simple listing API)", async () => {
		const models = await bedrock.fetchModels();
		expect(models).toBeNull();
	});

	test("all providers return null when no API key", async () => {
		// Ensure env vars are not set
		const keys = ["GROQ_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "FIREWORKS_API_KEY"];
		const saved: Record<string, string | undefined> = {};
		for (const k of keys) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		try {
			expect(await groq.fetchModels()).toBeNull();
			expect(await deepseek.fetchModels()).toBeNull();
			expect(await mistral.fetchModels()).toBeNull();
			expect(await fireworks.fetchModels()).toBeNull();
		} finally {
			for (const k of keys) {
				if (saved[k]) process.env[k] = saved[k];
			}
		}
	});

	test("providers throw on HTTP error", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("Internal Server Error", { status: 500 })),
		) as any;

		for (const [provider, envKey] of [
			[groq, "GROQ_API_KEY"],
			[deepseek, "DEEPSEEK_API_KEY"],
			[mistral, "MISTRAL_API_KEY"],
			[fireworks, "FIREWORKS_API_KEY"],
		] as const) {
			process.env[envKey] = "test-key";
			try {
				await expect(provider.fetchModels()).rejects.toThrow("500");
			} finally {
				delete process.env[envKey];
			}
		}
	});
});

// ── Bedrock special cases ─────────────────────────────────────────

describe("bedrock special cases", () => {
	test("checkAvailability returns false without AWS credentials", async () => {
		const saved = {
			key: process.env.AWS_ACCESS_KEY_ID,
			secret: process.env.AWS_SECRET_ACCESS_KEY,
		};
		delete process.env.AWS_ACCESS_KEY_ID;
		delete process.env.AWS_SECRET_ACCESS_KEY;
		try {
			const available = await bedrock.checkAvailability!();
			expect(available).toBe(false);
		} finally {
			if (saved.key) process.env.AWS_ACCESS_KEY_ID = saved.key;
			if (saved.secret) process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
		}
	});

	test("checkAvailability returns true with both AWS credentials", async () => {
		process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
		process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
		try {
			const available = await bedrock.checkAvailability!();
			expect(available).toBe(true);
		} finally {
			delete process.env.AWS_ACCESS_KEY_ID;
			delete process.env.AWS_SECRET_ACCESS_KEY;
		}
	});

	test("createModel throws without AWS credentials", () => {
		delete process.env.AWS_ACCESS_KEY_ID;
		delete process.env.AWS_SECRET_ACCESS_KEY;
		expect(() => bedrock.createModel("anthropic.claude-sonnet-4-20250514-v1:0")).toThrow(
			"AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set",
		);
	});
});

// ── Cost counting (matchPricing end-to-end) ───────────────────────

describe("cost counting — matchPricing", () => {
	// Helper: 1M input, 0 cache, 1M output → cost = input_price + output_price
	const usage1M = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
	// Helper: 1M cache read only
	const cache1M = { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 };

	// ── Groq ──
	test("groq/llama-3.3-70b-versatile → $0.59 in + $0.79 out", () => {
		const cost = computeModelCost("groq/llama-3.3-70b-versatile", usage1M);
		expect(cost).toBeCloseTo(0.59 + 0.79, 4);
	});

	test("groq/llama-3.1-8b-instant → $0.05 in + $0.08 out", () => {
		const cost = computeModelCost("groq/llama-3.1-8b-instant", usage1M);
		expect(cost).toBeCloseTo(0.05 + 0.08, 4);
	});

	test("groq cache read → 50% of input", () => {
		const cost = computeModelCost("groq/llama-3.3-70b-versatile", cache1M);
		expect(cost).toBeCloseTo(0.295, 4);
	});

	// ── DeepSeek ── (V4-flash pricing as of 2026-04-30; chat/reasoner are V4-flash aliases)
	test("deepseek/deepseek-chat → $0.14 in + $0.28 out", () => {
		const cost = computeModelCost("deepseek/deepseek-chat", usage1M);
		expect(cost).toBeCloseTo(0.14 + 0.28, 4);
	});

	test("deepseek/deepseek-reasoner → same pricing (V4-flash)", () => {
		const cost = computeModelCost("deepseek/deepseek-reasoner", usage1M);
		expect(cost).toBeCloseTo(0.14 + 0.28, 4);
	});

	test("deepseek cache read → 10% of input ($0.014)", () => {
		const cost = computeModelCost("deepseek/deepseek-chat", cache1M);
		expect(cost).toBeCloseTo(0.014, 4);
	});

	// ── Mistral ──
	test("mistral/mistral-large-2512 → $0.50 in + $1.50 out", () => {
		const cost = computeModelCost("mistral/mistral-large-2512", usage1M);
		expect(cost).toBeCloseTo(0.5 + 1.5, 4);
	});

	test("mistral/mistral-small-2506 → $0.10 in + $0.30 out", () => {
		const cost = computeModelCost("mistral/mistral-small-2506", usage1M);
		expect(cost).toBeCloseTo(0.1 + 0.3, 4);
	});

	test("mistral/codestral-2508 → $0.30 in + $0.90 out", () => {
		const cost = computeModelCost("mistral/codestral-2508", usage1M);
		expect(cost).toBeCloseTo(0.3 + 0.9, 4);
	});

	test("mistral/mistral-medium-2508 → $0.40 in + $2.00 out", () => {
		const cost = computeModelCost("mistral/mistral-medium-2508", usage1M);
		expect(cost).toBeCloseTo(0.4 + 2.0, 4);
	});

	// ── Fireworks (provider-specific pricing) ──
	test("fireworks deepseek-v3 → $0.56 in + $1.68 out (NOT DeepSeek direct price)", () => {
		const cost = computeModelCost("fireworks/accounts/fireworks/models/deepseek-v3", usage1M);
		expect(cost).toBeCloseTo(0.56 + 1.68, 4);
	});

	test("fireworks llama-v3p3-70b → $0.90 tier", () => {
		const cost = computeModelCost("fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct", usage1M);
		expect(cost).toBeCloseTo(0.9 + 0.9, 4);
	});

	test("fireworks mixtral-8x22b → $1.20 MoE tier", () => {
		const cost = computeModelCost("fireworks/accounts/fireworks/models/mixtral-8x22b-instruct", usage1M);
		expect(cost).toBeCloseTo(1.2 + 1.2, 4);
	});

	test("fireworks cache read → 50% of input", () => {
		const cost = computeModelCost("fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct", cache1M);
		expect(cost).toBeCloseTo(0.45, 4);
	});

	// ── Bedrock (uses underlying model pricing) ──
	test("bedrock claude-sonnet-4 → matches Anthropic pricing ($3/$15)", () => {
		const cost = computeModelCost("bedrock/anthropic.claude-sonnet-4-20250514-v1:0", usage1M);
		expect(cost).toBeCloseTo(3 + 15, 4);
	});

	// ── Cross-provider isolation ──
	test("deepseek-v3 on Fireworks gets Fireworks pricing, not DeepSeek pricing", () => {
		const fireworksCost = computeModelCost("fireworks/accounts/fireworks/models/deepseek-v3", usage1M);
		const directCost = computeModelCost("deepseek/deepseek-chat", usage1M);
		// Fireworks: $0.56 + $1.68 = $2.24
		// Direct (V4-flash): $0.14 + $0.28 = $0.42
		expect(fireworksCost).toBeGreaterThan(directCost);
		expect(fireworksCost).toBeCloseTo(2.24, 4);
		expect(directCost).toBeCloseTo(0.42, 4);
	});
});

// ── Free model detection ─────────────────────────────────────────

describe("isModelFree", () => {
	test("model ending with :free is free", () => {
		expect(isModelFree("openrouter/qwen/qwen3.6-plus:free")).toBe(true);
	});

	test("model ending with -free is free", () => {
		expect(isModelFree("openrouter/google/gemma-3-1b-it-free")).toBe(true);
	});

	test("case-insensitive :free detection", () => {
		expect(isModelFree("openrouter/meta-llama/llama-4-scout:FREE")).toBe(true);
	});

	test("non-free model is not free", () => {
		expect(isModelFree("openrouter/anthropic/claude-sonnet-4.6")).toBe(false);
	});

	test("direct provider model is not free", () => {
		expect(isModelFree("anthropic/claude-sonnet-4-6")).toBe(false);
	});

	test("free model has zero cost", () => {
		const usage1M = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
		const cost = computeModelCost("openrouter/qwen/qwen3.6-plus:free", usage1M);
		expect(cost).toBe(0);
	});

	test("free model with cache tokens still zero cost", () => {
		const usage = { input: 500_000, output: 500_000, cacheRead: 1_000_000, cacheWrite: 200_000 };
		const cost = computeModelCost("openrouter/meta-llama/llama-4-scout:free", usage);
		expect(cost).toBe(0);
	});
});
