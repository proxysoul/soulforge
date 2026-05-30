import { describe, expect, test, afterEach, mock } from "bun:test";
import { ollama } from "../src/core/llm/providers/ollama.js";
import { lmstudio } from "../src/core/llm/providers/lmstudio.js";
import { getProvider, getAllProviders } from "../src/core/llm/providers/index.js";
import { computeModelCost, isModelFree, isModelLocal } from "../src/stores/statusbar.js";

// ── Registration ──────────────────────────────────────────────────

describe("local providers registration", () => {
	test("ollama and lmstudio are registered as builtins", () => {
		expect(getProvider("ollama")).toBeDefined();
		expect(getProvider("lmstudio")).toBeDefined();
		expect(getProvider("ollama")!.custom).toBeUndefined();
		expect(getProvider("lmstudio")!.custom).toBeUndefined();
	});

	test("total builtin count is 22", () => {
		const builtins = getAllProviders().filter((p) => !p.custom);
		expect(builtins.length).toBe(22);
	});

	test("ollama has required fields", () => {
		const p = ollama;
		expect(p.id).toBe("ollama");
		expect(p.name).toBe("Ollama");
		expect(p.envVar).toBe("");
		expect(p.icon).toBeTruthy();
		expect(typeof p.createModel).toBe("function");
		expect(typeof p.fetchModels).toBe("function");
		expect(typeof p.checkAvailability).toBe("function");
		expect(p.fallbackModels.length).toBeGreaterThan(0);
		expect(p.contextWindows.length).toBeGreaterThan(0);
	});

	test("lmstudio has required fields", () => {
		const p = lmstudio;
		expect(p.id).toBe("lmstudio");
		expect(p.name).toBe("LM Studio");
		expect(p.envVar).toBe("LM_API_TOKEN");
		expect(p.secretKey).toBe("lm-api-token");
		expect(p.icon).toBeTruthy();
		expect(typeof p.createModel).toBe("function");
		expect(typeof p.fetchModels).toBe("function");
		expect(typeof p.checkAvailability).toBe("function");
		// LM Studio has no fallback models (dynamic only)
		expect(p.fallbackModels).toEqual([]);
		// No hardcoded context windows (fetched from REST API)
		expect(p.contextWindows).toEqual([]);
	});
});

// ── Env var overrides ─────────────────────────────────────────────

describe("ollama OLLAMA_HOST env override", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.OLLAMA_HOST;
	});

	test("default: fetches from localhost:11434", async () => {
		let capturedUrl = "";
		globalThis.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(
				new Response(JSON.stringify({ models: [{ name: "llama3.3:latest" }] }), { status: 200 }),
			);
		}) as any;

		await ollama.fetchModels();
		expect(capturedUrl).toBe("http://localhost:11434/api/tags");
	});

	test("OLLAMA_HOST overrides the base URL", async () => {
		process.env.OLLAMA_HOST = "http://192.168.1.100:9999";
		let capturedUrl = "";
		globalThis.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(
				new Response(JSON.stringify({ models: [{ name: "llama3.3:latest" }] }), { status: 200 }),
			);
		}) as any;

		await ollama.fetchModels();
		expect(capturedUrl).toBe("http://192.168.1.100:9999/api/tags");
	});

	test("OLLAMA_HOST strips trailing slashes", async () => {
		process.env.OLLAMA_HOST = "http://myhost:11434///";
		let capturedUrl = "";
		globalThis.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(
				new Response(JSON.stringify({ models: [{ name: "llama3.3:latest" }] }), { status: 200 }),
			);
		}) as any;

		await ollama.fetchModels();
		expect(capturedUrl).toBe("http://myhost:11434/api/tags");
	});

	test("OLLAMA_HOST is used in checkAvailability", async () => {
		process.env.OLLAMA_HOST = "http://remote:5555";
		let capturedUrl = "";
		globalThis.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(new Response("ok", { status: 200 }));
		}) as any;

		await ollama.checkAvailability!();
		expect(capturedUrl).toBe("http://remote:5555/api/tags");
	});
});

describe("lmstudio LM_STUDIO_URL env override", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.LM_STUDIO_URL;
		delete process.env.LM_API_TOKEN;
	});

	test("default: fetches from localhost:1234 REST API v0", async () => {
		let capturedUrl = "";
		globalThis.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(
				new Response(
					JSON.stringify({
						data: [{ id: "qwen3", type: "llm", max_context_length: 131072 }],
					}),
					{ status: 200 },
				),
			);
		}) as any;

		await lmstudio.fetchModels();
		expect(capturedUrl).toBe("http://localhost:1234/api/v0/models");
	});

	test("LM_STUDIO_URL overrides the base URL", async () => {
		process.env.LM_STUDIO_URL = "http://10.0.0.5:8080";
		let capturedUrl = "";
		globalThis.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(
				new Response(
					JSON.stringify({ data: [{ id: "llama3", type: "llm" }] }),
					{ status: 200 },
				),
			);
		}) as any;

		await lmstudio.fetchModels();
		expect(capturedUrl).toBe("http://10.0.0.5:8080/api/v0/models");
	});

	test("LM_STUDIO_URL strips trailing slashes", async () => {
		process.env.LM_STUDIO_URL = "http://myhost:1234///";
		let capturedUrl = "";
		globalThis.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(
				new Response(
					JSON.stringify({ data: [{ id: "test", type: "llm" }] }),
					{ status: 200 },
				),
			);
		}) as any;

		await lmstudio.fetchModels();
		expect(capturedUrl).toBe("http://myhost:1234/api/v0/models");
	});

	test("LM_STUDIO_URL is used in checkAvailability", async () => {
		process.env.LM_STUDIO_URL = "http://remote:9999";
		let capturedUrl = "";
		globalThis.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(new Response("ok", { status: 200 }));
		}) as any;

		await lmstudio.checkAvailability!();
		expect(capturedUrl).toBe("http://remote:9999/api/v0/models");
	});
});

// ── LM Studio fetchModels parsing ─────────────────────────────────

describe("lmstudio fetchModels", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.LM_API_TOKEN;
	});

	test("filters out embeddings models, keeps llm and vlm", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						data: [
							{ id: "qwen3-8b", type: "llm", max_context_length: 131072 },
							{ id: "qwen2-vl-7b", type: "vlm", max_context_length: 32768 },
							{ id: "nomic-embed-text", type: "embeddings", max_context_length: 2048 },
							{ id: "llama3.1-8b", type: "llm", max_context_length: 128000 },
						],
					}),
					{ status: 200 },
				),
			),
		) as any;

		const models = await lmstudio.fetchModels();
		expect(models).not.toBeNull();
		expect(models!.length).toBe(3);
		expect(models!.map((m) => m.id)).toEqual(["qwen3-8b", "qwen2-vl-7b", "llama3.1-8b"]);
		// Embeddings filtered out
		expect(models!.find((m) => m.id === "nomic-embed-text")).toBeUndefined();
	});

	test("populates contextWindow from max_context_length", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						data: [
							{ id: "qwen3-8b", type: "llm", max_context_length: 131072 },
							{ id: "llama3.1-8b", type: "llm", max_context_length: 128000 },
							{ id: "small-model", type: "llm" }, // no max_context_length
						],
					}),
					{ status: 200 },
				),
			),
		) as any;

		const models = await lmstudio.fetchModels();
		expect(models![0].contextWindow).toBe(131072);
		expect(models![1].contextWindow).toBe(128000);
		expect(models![2].contextWindow).toBeUndefined();
	});

	test("throws on HTTP error", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("Internal Server Error", { status: 500 })),
		) as any;

		await expect(lmstudio.fetchModels()).rejects.toThrow("500");
	});

	test("returns null when response has no data array", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ models: ["a", "b"] }), { status: 200 }),
			),
		) as any;

		const models = await lmstudio.fetchModels();
		expect(models).toBeNull();
	});
});

// ── LM Studio auth ────────────────────────────────────────────────

describe("lmstudio LM_API_TOKEN auth", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.LM_API_TOKEN;
	});

	test("sends no Authorization header when LM_API_TOKEN is not set", async () => {
		let capturedHeaders: Record<string, string> = {};
		globalThis.fetch = mock((_url: string, init: RequestInit) => {
			capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
			return Promise.resolve(
				new Response(JSON.stringify({ data: [] }), { status: 200 }),
			);
		}) as any;

		await lmstudio.fetchModels();
		expect(capturedHeaders.authorization).toBeUndefined();
	});

	test("sends Bearer token when LM_API_TOKEN is set", async () => {
		process.env.LM_API_TOKEN = "lmstudio-sk-test-secret-123";
		let capturedHeaders: Record<string, string> = {};
		globalThis.fetch = mock((_url: string, init: RequestInit) => {
			capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
			return Promise.resolve(
				new Response(JSON.stringify({ data: [] }), { status: 200 }),
			);
		}) as any;

		await lmstudio.fetchModels();
		expect(capturedHeaders.authorization).toBe("Bearer lmstudio-sk-test-secret-123");
	});

	test("auth header is also sent in checkAvailability", async () => {
		process.env.LM_API_TOKEN = "my-token";
		let capturedHeaders: Record<string, string> = {};
		globalThis.fetch = mock((_url: string, init: RequestInit) => {
			capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
			return Promise.resolve(new Response("ok", { status: 200 }));
		}) as any;

		await lmstudio.checkAvailability!();
		expect(capturedHeaders.authorization).toBe("Bearer my-token");
	});
});

// ── Ollama fetchModels parsing ────────────────────────────────────

describe("ollama fetchModels", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("strips :latest suffix from model names", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						models: [
							{ name: "llama3.3:latest" },
							{ name: "qwen3:latest" },
							{ name: "mistral:7b-instruct" },
						],
					}),
					{ status: 200 },
				),
			),
		) as any;

		const models = await ollama.fetchModels();
		expect(models).not.toBeNull();
		expect(models!.length).toBe(3);
		expect(models![0]).toEqual({ id: "llama3.3", name: "llama3.3" });
		expect(models![1]).toEqual({ id: "qwen3", name: "qwen3" });
		expect(models![2]).toEqual({ id: "mistral:7b-instruct", name: "mistral:7b-instruct" });
	});

	test("throws on HTTP error", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("error", { status: 500 })),
		) as any;

		await expect(ollama.fetchModels()).rejects.toThrow("500");
	});
});

// ── checkAvailability ─────────────────────────────────────────────

describe("checkAvailability", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("ollama returns false on network error", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED"))) as any;
		expect(await ollama.checkAvailability!()).toBe(false);
	});

	test("lmstudio returns false on network error", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED"))) as any;
		expect(await lmstudio.checkAvailability!()).toBe(false);
	});

	test("ollama returns true on 200", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify({ models: [] }), { status: 200 })),
		) as any;
		expect(await ollama.checkAvailability!()).toBe(true);
	});

	test("lmstudio returns true on 200", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })),
		) as any;
		expect(await lmstudio.checkAvailability!()).toBe(true);
	});

	test("ollama returns false on 500", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("error", { status: 500 })),
		) as any;
		expect(await ollama.checkAvailability!()).toBe(false);
	});

	test("lmstudio returns false on 500", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("error", { status: 500 })),
		) as any;
		expect(await lmstudio.checkAvailability!()).toBe(false);
	});
});

// ── isModelLocal + pricing ────────────────────────────────────────

describe("isModelLocal", () => {
	test("ollama models are local", () => {
		expect(isModelLocal("ollama/llama3.3")).toBe(true);
		expect(isModelLocal("ollama/qwen3")).toBe(true);
		expect(isModelLocal("ollama/deepseek-coder-v2")).toBe(true);
	});

	test("lmstudio models are local", () => {
		expect(isModelLocal("lmstudio/qwen3-8b")).toBe(true);
		expect(isModelLocal("lmstudio/llama3.1-8b")).toBe(true);
	});

	test("cloud providers are not local", () => {
		expect(isModelLocal("anthropic/claude-sonnet-4")).toBe(false);
		expect(isModelLocal("openai/gpt-4o")).toBe(false);
		expect(isModelLocal("groq/llama-3.3-70b")).toBe(false);
		expect(isModelLocal("openrouter/meta-llama/llama-4-scout")).toBe(false);
	});

	test("bare model id without provider is not local", () => {
		expect(isModelLocal("llama3.3")).toBe(false);
		expect(isModelLocal("gpt-4o")).toBe(false);
	});
});

describe("local model pricing", () => {
	const usage1M = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
	const fullUsage = { input: 500_000, output: 500_000, cacheRead: 1_000_000, cacheWrite: 200_000 };

	test("ollama models have zero cost", () => {
		expect(computeModelCost("ollama/llama3.3", usage1M)).toBe(0);
		expect(computeModelCost("ollama/qwen3", usage1M)).toBe(0);
		expect(computeModelCost("ollama/mistral", usage1M)).toBe(0);
	});

	test("lmstudio models have zero cost", () => {
		expect(computeModelCost("lmstudio/qwen3-8b", usage1M)).toBe(0);
		expect(computeModelCost("lmstudio/llama3.1-8b", usage1M)).toBe(0);
	});

	test("local models with cache tokens still zero cost", () => {
		expect(computeModelCost("ollama/llama3.3", fullUsage)).toBe(0);
		expect(computeModelCost("lmstudio/qwen3-8b", fullUsage)).toBe(0);
	});

	test("local models are not detected as isModelFree", () => {
		// isModelFree is for :free suffix / OpenRouter free models, not local
		expect(isModelFree("ollama/llama3.3")).toBe(false);
		expect(isModelFree("lmstudio/qwen3-8b")).toBe(false);
	});

	test("cloud provider with same model name is NOT free", () => {
		// A model named "llama3.3" on a cloud provider should cost money
		const cloudCost = computeModelCost("groq/llama-3.3-70b-versatile", usage1M);
		const localCost = computeModelCost("ollama/llama3.3", usage1M);
		expect(cloudCost).toBeGreaterThan(0);
		expect(localCost).toBe(0);
	});
});
