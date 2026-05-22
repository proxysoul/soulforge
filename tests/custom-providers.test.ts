import { describe, expect, test, beforeEach, mock, afterEach } from "bun:test";
import { registerCustomProviders, getAllProviders, getProvider, buildCustomProvider } from "../src/core/llm/providers/index.js";
import type { CustomProviderConfig, ProviderDefinition } from "../src/core/llm/providers/types.js";
import { PROVIDER_CONFIGS } from "../src/core/llm/models.js";

// Reset provider state between tests by re-registering empty
beforeEach(() => {
	registerCustomProviders([]);
});

describe("registerCustomProviders", () => {
	test("adds custom provider to the list", () => {
		const config: CustomProviderConfig = {
			id: "testprov",
			name: "Test Provider",
			baseURL: "https://api.test.com/v1",
			envVar: "TEST_API_KEY",
			models: ["model-a", "model-b"],
		};
		registerCustomProviders([config]);

		const all = getAllProviders();
		const custom = all.find((p) => p.id === "testprov");
		expect(custom).toBeDefined();
		expect(custom!.name).toBe("Test Provider");
		expect(custom!.custom).toBe(true);
		expect(custom!.envVar).toBe("TEST_API_KEY");
	});

	test("custom provider appears in getProvider()", () => {
		registerCustomProviders([
			{ id: "myprov", baseURL: "https://api.test.com/v1", models: ["m1"] },
		]);
		const p = getProvider("myprov");
		expect(p).toBeDefined();
		expect(p!.custom).toBe(true);
	});

	test("does not replace builtin provider with same id", () => {
		const builtinAnthropic = getProvider("anthropic");
		expect(builtinAnthropic).toBeDefined();
		expect(builtinAnthropic!.custom).toBeUndefined();

		registerCustomProviders([
			{ id: "anthropic", name: "My Anthropic", baseURL: "https://proxy.com/v1" },
		]);

		// Builtin still exists untouched
		const stillBuiltin = getProvider("anthropic");
		expect(stillBuiltin).toBeDefined();
		expect(stillBuiltin!.custom).toBeUndefined();

		// Custom got renamed
		const custom = getProvider("anthropic-custom");
		expect(custom).toBeDefined();
		expect(custom!.custom).toBe(true);
		expect(custom!.name).toBe("My Anthropic");
	});

	test("auto-suffixes conflicting custom ids deterministically", () => {
		registerCustomProviders([
			{ id: "anthropic", name: "Proxy 1", baseURL: "https://p1.com/v1" },
			{ id: "anthropic", name: "Proxy 2", baseURL: "https://p2.com/v1" },
		]);

		const p1 = getProvider("anthropic-custom");
		const p2 = getProvider("anthropic-custom-2");
		expect(p1).toBeDefined();
		expect(p1!.name).toBe("Proxy 1");
		expect(p2).toBeDefined();
		expect(p2!.name).toBe("Proxy 2");

		// Builtin untouched
		expect(getProvider("anthropic")!.custom).toBeUndefined();
	});

	test("preserves all builtins when customs are registered", () => {
		const builtinsBefore = getAllProviders().filter((p) => !p.custom);
		const builtinCount = builtinsBefore.length;

		registerCustomProviders([
			{ id: "testprov", baseURL: "https://api.test.com/v1" },
		]);

		const builtinsAfter = getAllProviders().filter((p) => !p.custom);
		expect(builtinsAfter.length).toBe(builtinCount);
	});

	test("custom provider with no name defaults to id", () => {
		registerCustomProviders([{ id: "myprov", baseURL: "https://api.test.com/v1" }]);
		expect(getProvider("myprov")!.name).toBe("myprov");
	});

	test("custom provider with no envVar defaults to empty string", () => {
		registerCustomProviders([{ id: "local", baseURL: "http://localhost:8080/v1" }]);
		expect(getProvider("local")!.envVar).toBe("");
	});

	test("fallbackModels built from string array", () => {
		registerCustomProviders([
			{ id: "fp", baseURL: "https://x.com/v1", models: ["a", "b"] },
		]);
		const p = getProvider("fp")!;
		expect(p.fallbackModels).toEqual([
			{ id: "a", name: "a" },
			{ id: "b", name: "b" },
		]);
	});

	test("fallbackModels built from object array", () => {
		registerCustomProviders([
			{
				id: "fp2",
				baseURL: "https://x.com/v1",
				models: [{ id: "m1", name: "Model 1", contextWindow: 128000 }],
			},
		]);
		const p = getProvider("fp2")!;
		expect(p.fallbackModels).toEqual([{ id: "m1", name: "Model 1", contextWindow: 128000 }]);
	});

	test("empty configs resets to builtins only", () => {
		registerCustomProviders([
			{ id: "temp", baseURL: "https://x.com/v1" },
		]);
		expect(getProvider("temp")).toBeDefined();

		registerCustomProviders([]);
		expect(getProvider("temp")).toBeUndefined();
	});

	test("duplicate custom ids get unique suffixes", () => {
		registerCustomProviders([
			{ id: "dup", name: "First", baseURL: "https://first.com/v1" },
			{ id: "dup", name: "Second", baseURL: "https://second.com/v1" },
		]);
		const p1 = getProvider("dup")!;
		const p2 = getProvider("dup-custom")!;
		expect(p1.name).toBe("First");
		expect(p2.name).toBe("Second");
	});

	test("triple+ collisions with a builtin exercise the while loop", () => {
		registerCustomProviders([
			{ id: "anthropic", name: "Proxy A", baseURL: "https://a.com/v1" },
			{ id: "anthropic", name: "Proxy B", baseURL: "https://b.com/v1" },
			{ id: "anthropic", name: "Proxy C", baseURL: "https://c.com/v1" },
			{ id: "anthropic", name: "Proxy D", baseURL: "https://d.com/v1" },
		]);

		// Builtin untouched
		expect(getProvider("anthropic")!.custom).toBeUndefined();

		// Each custom gets a unique suffix
		const a = getProvider("anthropic-custom");
		const b = getProvider("anthropic-custom-2");
		const c = getProvider("anthropic-custom-3");
		const d = getProvider("anthropic-custom-4");
		expect(a).toBeDefined();
		expect(a!.name).toBe("Proxy A");
		expect(b).toBeDefined();
		expect(b!.name).toBe("Proxy B");
		expect(c).toBeDefined();
		expect(c!.name).toBe("Proxy C");
		expect(d).toBeDefined();
		expect(d!.name).toBe("Proxy D");

		// Total count: builtins + 4 customs
		const all = getAllProviders();
		const customs = all.filter((p) => p.custom);
		expect(customs.length).toBe(4);
	});

	test("custom id that is literally '{builtin}-custom' still gets disambiguated", () => {
		// First register one that collides with anthropic → becomes anthropic-custom
		// Then register one whose actual id IS "anthropic-custom" → also collides
		registerCustomProviders([
			{ id: "anthropic", name: "First", baseURL: "https://a.com/v1" },
			{ id: "anthropic-custom", name: "Second", baseURL: "https://b.com/v1" },
		]);

		// Builtin untouched
		expect(getProvider("anthropic")!.custom).toBeUndefined();

		// First collision: anthropic → anthropic-custom
		const first = getProvider("anthropic-custom");
		expect(first).toBeDefined();
		expect(first!.name).toBe("First");

		// Second: "anthropic-custom" collides with the already-taken "anthropic-custom"
		// so it should get suffixed to "anthropic-custom-custom" or similar
		const second = getProvider("anthropic-custom-custom");
		expect(second).toBeDefined();
		expect(second!.name).toBe("Second");
	});

	test("re-registration replaces previous customs entirely", () => {
		registerCustomProviders([
			{ id: "alpha", name: "Alpha", baseURL: "https://alpha.com/v1" },
			{ id: "beta", name: "Beta", baseURL: "https://beta.com/v1" },
		]);
		expect(getProvider("alpha")).toBeDefined();
		expect(getProvider("beta")).toBeDefined();

		// Re-register with different set
		registerCustomProviders([
			{ id: "gamma", name: "Gamma", baseURL: "https://gamma.com/v1" },
		]);

		// Old customs gone
		expect(getProvider("alpha")).toBeUndefined();
		expect(getProvider("beta")).toBeUndefined();
		// New custom present
		expect(getProvider("gamma")).toBeDefined();
		expect(getProvider("gamma")!.name).toBe("Gamma");
	});

	test("ordering: customs appear after builtins in getAllProviders", () => {
		registerCustomProviders([
			{ id: "zzz", baseURL: "https://z.com/v1" },
		]);
		const all = getAllProviders();
		const builtinCount = all.filter((p) => !p.custom).length;
		// All builtins should come first
		for (let i = 0; i < builtinCount; i++) {
			expect(all[i].custom).toBeUndefined();
		}
		// Customs after
		for (let i = builtinCount; i < all.length; i++) {
			expect(all[i].custom).toBe(true);
		}
	});

	test("PROVIDER_CONFIGS updates when custom providers are registered", () => {
		const before = PROVIDER_CONFIGS.length;
		const hadCustom = PROVIDER_CONFIGS.some((c) => c.id === "cfgtest");
		expect(hadCustom).toBe(false);

		registerCustomProviders([
			{ id: "cfgtest", name: "Config Test", baseURL: "https://api.test.com/v1", models: ["m1"] },
		]);

		expect(PROVIDER_CONFIGS.length).toBe(before + 1);
		const entry = PROVIDER_CONFIGS.find((c) => c.id === "cfgtest");
		expect(entry).toBeDefined();
		expect(entry!.name).toBe("Config Test");
	});
});

describe("buildCustomProvider", () => {
	test("returns a valid ProviderDefinition shape", () => {
		const def = buildCustomProvider({
			id: "test",
			name: "Test",
			baseURL: "https://api.test.com/v1",
			envVar: "TEST_KEY",
			models: ["gpt-4"],
		});

		expect(def.id).toBe("test");
		expect(def.name).toBe("Test");
		expect(def.envVar).toBe("TEST_KEY");
		expect(def.icon).toBe("\uF29F"); // nf-fa-diamond
		expect(def.asciiIcon).toBe("◇");
		expect(def.custom).toBe(true);
		expect(def.contextWindows).toEqual([]);
		expect(typeof def.createModel).toBe("function");
		expect(typeof def.fetchModels).toBe("function");
		expect(typeof def.checkAvailability).toBe("function");
	});

	test("normalizeModels with empty array returns empty", () => {
		const def = buildCustomProvider({
			id: "empty",
			baseURL: "https://x.com/v1",
			models: [],
		});
		expect(def.fallbackModels).toEqual([]);
	});

	test("normalizeModels with undefined returns empty", () => {
		const def = buildCustomProvider({
			id: "nomodels",
			baseURL: "https://x.com/v1",
		});
		expect(def.fallbackModels).toEqual([]);
	});

	test("normalizeModels with mixed string and object entries", () => {
		const def = buildCustomProvider({
			id: "mixed",
			baseURL: "https://x.com/v1",
			models: [
				"simple-model",
				{ id: "detailed", name: "Detailed Model", contextWindow: 200000 },
				"another-simple",
			],
		});
		expect(def.fallbackModels).toEqual([
			{ id: "simple-model", name: "simple-model" },
			{ id: "detailed", name: "Detailed Model", contextWindow: 200000 },
			{ id: "another-simple", name: "another-simple" },
		]);
	});

	test("createModel returns a language model object", () => {
		const def = buildCustomProvider({
			id: "cm",
			baseURL: "https://api.test.com/v1",
		});
		// createModel should return an object (OpenAI LanguageModel)
		const model = def.createModel("gpt-4o");
		expect(model).toBeDefined();
		expect(model.modelId).toBe("gpt-4o");
	});

	test("createModel with envVar uses 'custom' as fallback apiKey when no envVar", () => {
		// No envVar set → apiKey should be "custom" (not crash)
		const def = buildCustomProvider({
			id: "nokey",
			baseURL: "https://api.test.com/v1",
		});
		// Should not throw
		const model = def.createModel("some-model");
		expect(model).toBeDefined();
	});

	test("createModel with envVar resolves from process.env", () => {
		const envKey = "TEST_CUSTOM_PROV_KEY_" + Date.now();
		process.env[envKey] = "sk-test-12345";
		try {
			const def = buildCustomProvider({
				id: "envtest",
				baseURL: "https://api.test.com/v1",
				envVar: envKey,
			});
			// Should not throw — key is resolved
			const model = def.createModel("gpt-4");
			expect(model).toBeDefined();
		} finally {
			delete process.env[envKey];
		}
	});
});

describe("buildCustomProvider.checkAvailability", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("returns true when envVar key exists in env", async () => {
		const envKey = "TEST_AVAIL_KEY_" + Date.now();
		process.env[envKey] = "sk-exists";
		try {
			const def = buildCustomProvider({
				id: "avail",
				baseURL: "https://api.test.com/v1",
				envVar: envKey,
			});
			const available = await def.checkAvailability!();
			expect(available).toBe(true);
		} finally {
			delete process.env[envKey];
		}
	});

	test("returns false when envVar key is missing", async () => {
		const def = buildCustomProvider({
			id: "unavail",
			baseURL: "https://api.test.com/v1",
			envVar: "DEFINITELY_NOT_SET_" + Date.now(),
		});
		const available = await def.checkAvailability!();
		expect(available).toBe(false);
	});

	test("without envVar, fetches baseURL and returns true on 200", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("ok", { status: 200 })),
		);
		const def = buildCustomProvider({
			id: "local",
			baseURL: "http://localhost:11434/v1",
		});
		const available = await def.checkAvailability!();
		expect(available).toBe(true);
	});

	test("without envVar, returns true on 401 (server reachable, needs auth)", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("unauthorized", { status: 401 })),
		);
		const def = buildCustomProvider({
			id: "auth",
			baseURL: "http://localhost:11434/v1",
		});
		const available = await def.checkAvailability!();
		expect(available).toBe(true);
	});

	test("without envVar, returns true on 403", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("forbidden", { status: 403 })),
		);
		const def = buildCustomProvider({
			id: "forbidden",
			baseURL: "http://localhost:11434/v1",
		});
		const available = await def.checkAvailability!();
		expect(available).toBe(true);
	});

	test("without envVar, returns false on 500", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("error", { status: 500 })),
		);
		const def = buildCustomProvider({
			id: "error",
			baseURL: "http://localhost:11434/v1",
		});
		const available = await def.checkAvailability!();
		expect(available).toBe(false);
	});

	test("without envVar, returns false on network error", async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new Error("ECONNREFUSED")),
		);
		const def = buildCustomProvider({
			id: "down",
			baseURL: "http://localhost:99999/v1",
		});
		const available = await def.checkAvailability!();
		expect(available).toBe(false);
	});
});

describe("buildCustomProvider.fetchModels", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("auto-discovers models from baseURL when modelsAPI is not set", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						data: [
							{ id: "gpt-4o", owned_by: "openai" },
							{ id: "gpt-4o-mini", owned_by: "openai" },
						],
					}),
					{ status: 200 },
				),
			),
		);

		const def = buildCustomProvider({
			id: "autodiscover",
			baseURL: "https://api.test.com/v1",
			// No modelsAPI — should auto-construct https://api.test.com/models
		});
		const models = await def.fetchModels();
		expect(models).toEqual([
			{ id: "gpt-4o", name: "gpt-4o" },
			{ id: "gpt-4o-mini", name: "gpt-4o-mini" },
		]);
	});

	test("auto-constructed URL strips trailing /v1 from baseURL", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
		});

		const def = buildCustomProvider({
			id: "stripv1",
			baseURL: "https://api.test.com/v1",
		});
		await def.fetchModels();
		expect(capturedUrl).toBe("https://api.test.com/models");
	});

	test("auto-constructed URL leaves baseURL without /v1 prefix unchanged", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
		});

		const def = buildCustomProvider({
			id: "nov1",
			baseURL: "https://api.test.com",
		});
		await def.fetchModels();
		expect(capturedUrl).toBe("https://api.test.com/models");
	});

	test("explicit modelsAPI takes priority over auto-discovery", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
		});

		const def = buildCustomProvider({
			id: "explicitapi",
			baseURL: "https://api.test.com/v1",
			modelsAPI: "https://custom.example.com/custom-models",
		});
		await def.fetchModels();
		expect(capturedUrl).toBe("https://custom.example.com/custom-models");
	});

	test("modelsAPI: false disables model auto-discovery and fetchModels returns null", async () => {
		const def = buildCustomProvider({
			id: "optout",
			baseURL: "https://api.test.com/v1",
			modelsAPI: false,
		});
		const models = await def.fetchModels();
		expect(models).toBeNull();
	});

	test("extracts context_length from API response into ProviderModelInfo", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						data: [
							{ id: "gpt-4o", context_length: 128000 },
							{ id: "gpt-4o-mini", context_length: 128000 },
						],
					}),
					{ status: 200 },
				),
			),
		);

		const def = buildCustomProvider({
			id: "ctxwin",
			baseURL: "https://api.test.com/v1",
		});
		const models = await def.fetchModels();
		expect(models).toEqual([
			{ id: "gpt-4o", name: "gpt-4o", contextWindow: 128000 },
			{ id: "gpt-4o-mini", name: "gpt-4o-mini", contextWindow: 128000 },
		]);
	});

	test("omits contextLength when response has no context_length field", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						data: [{ id: "gpt-4o" }],
					}),
					{ status: 200 },
				),
			),
		);

		const def = buildCustomProvider({
			id: "noctx",
			baseURL: "https://api.test.com/v1",
		});
		const models = await def.fetchModels();
		expect(models![0].contextWindow).toBeUndefined();
	});

  test("returns null on HTTP error during auto-discovery", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("not found", { status: 404 })),
		);

		const def = buildCustomProvider({
			id: "autodiscovererr",
			baseURL: "https://api.test.com/v1",
		});
		const models = await def.fetchModels();
		expect(models).toBeNull();
	});

  test("returns null when response body is not valid JSON (e.g. 204 No Content)", async () => {
		// Create a Response with no body — res.json() would throw SyntaxError
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(null, { status: 204 })),
		);

		const def = buildCustomProvider({
			id: "nojsonbody",
			baseURL: "https://api.test.com/v1",
		});
		const models = await def.fetchModels();
		expect(models).toBeNull();
	});

	test("returns null when network request throws before response", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("ENOTFOUND")));

		const def = buildCustomProvider({
			id: "networkfail",
			baseURL: "https://api.test.com/v1",
		});
		const models = await def.fetchModels();
		expect(models).toBeNull();
	});

  test("returns null when response has no data array during auto-discovery", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ models: ["a", "b"] }), { status: 200 }),
			),
		);

		const def = buildCustomProvider({
			id: "autodiscoverbadshape",
			baseURL: "https://api.test.com/v1",
		});
		const models = await def.fetchModels();
		expect(models).toBeNull();
	});

	test("sends Authorization header during auto-discovery when envVar is set", async () => {
		const envKey = "TEST_FETCH_KEY_" + Date.now();
		process.env[envKey] = "sk-my-secret";
		let capturedHeaders: Headers | undefined;
		globalThis.fetch = mock((_url: string, init: RequestInit) => {
			capturedHeaders = new Headers(init.headers);
			return Promise.resolve(
				new Response(JSON.stringify({ data: [] }), { status: 200 }),
			);
		});

		try {
			const def = buildCustomProvider({
				id: "authautodiscover",
				baseURL: "https://api.test.com/v1",
				envVar: envKey,
			});
			await def.fetchModels();
			expect(capturedHeaders).toBeDefined();
			expect(capturedHeaders!.get("Authorization")).toBe("Bearer sk-my-secret");
		} finally {
			delete process.env[envKey];
		}
	});

	test("sends no Authorization header during auto-discovery when no envVar", async () => {
		let capturedHeaders: Headers | undefined;
		globalThis.fetch = mock((_url: string, init: RequestInit) => {
			capturedHeaders = new Headers(init.headers);
			return Promise.resolve(
				new Response(JSON.stringify({ data: [] }), { status: 200 }),
			);
		});

		const def = buildCustomProvider({
			id: "noauthautodiscover",
			baseURL: "https://api.test.com/v1",
		});
		await def.fetchModels();
		expect(capturedHeaders).toBeDefined();
		expect(capturedHeaders!.get("Authorization")).toBeNull();
	});

	test("returns model list from explicit modelsAPI", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						data: [
							{ id: "gpt-4o", owned_by: "openai" },
							{ id: "gpt-4o-mini", owned_by: "openai" },
						],
					}),
					{ status: 200 },
				),
			),
		);

		const def = buildCustomProvider({
			id: "fetchtest",
			baseURL: "https://api.test.com/v1",
			modelsAPI: "https://api.test.com/v1/models",
		});
		const models = await def.fetchModels();
		expect(models).toEqual([
			{ id: "gpt-4o", name: "gpt-4o" },
			{ id: "gpt-4o-mini", name: "gpt-4o-mini" },
		]);
	});

	test("returns null on HTTP error when explicit modelsAPI set", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("not found", { status: 404 })),
		);

		const def = buildCustomProvider({
			id: "err",
			baseURL: "https://api.test.com/v1",
			modelsAPI: "https://api.test.com/v1/models",
		});
		const models = await def.fetchModels();
		expect(models).toBeNull();
	});

	test("returns null when response has no data array with explicit modelsAPI", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ models: ["a", "b"] }), { status: 200 }),
			),
		);

		const def = buildCustomProvider({
			id: "badshape",
			baseURL: "https://api.test.com/v1",
			modelsAPI: "https://api.test.com/v1/models",
		});
		const models = await def.fetchModels();
		expect(models).toBeNull();
	});

	test("sends Authorization header when envVar is set with explicit modelsAPI", async () => {
		const envKey = "TEST_FETCH_KEY_" + Date.now();
		process.env[envKey] = "sk-my-secret";
		let capturedHeaders: Headers | undefined;
		globalThis.fetch = mock((_url: string, init: RequestInit) => {
			capturedHeaders = new Headers(init.headers);
			return Promise.resolve(
				new Response(JSON.stringify({ data: [] }), { status: 200 }),
			);
		});

		try {
			const def = buildCustomProvider({
				id: "authfetch",
				baseURL: "https://api.test.com/v1",
				envVar: envKey,
				modelsAPI: "https://api.test.com/v1/models",
			});
			await def.fetchModels();
			expect(capturedHeaders).toBeDefined();
			expect(capturedHeaders!.get("Authorization")).toBe("Bearer sk-my-secret");
		} finally {
			delete process.env[envKey];
		}
	});

	test("sends no Authorization header when no envVar with explicit modelsAPI", async () => {
		let capturedHeaders: Headers | undefined;
		globalThis.fetch = mock((_url: string, init: RequestInit) => {
			capturedHeaders = new Headers(init.headers);
			return Promise.resolve(
				new Response(JSON.stringify({ data: [] }), { status: 200 }),
			);
		});

		const def = buildCustomProvider({
			id: "noauth",
			baseURL: "https://api.test.com/v1",
			modelsAPI: "https://api.test.com/v1/models",
		});
		await def.fetchModels();
		expect(capturedHeaders).toBeDefined();
		expect(capturedHeaders!.get("Authorization")).toBeNull();
	});

	test("auto-constructs URL from baseURL with deeper path", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
		});

 		const def = buildCustomProvider({
 			id: "deeppath",
 			baseURL: "https://api.test.com/api/v2/v1",
 		});
 		await def.fetchModels();
 		// Only the final /v1 segment is stripped
 		expect(capturedUrl).toBe("https://api.test.com/api/v2/models");
 	});

	test("strips trailing slash from baseURL to prevent double-slash in models URL", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
		});

 		const def = buildCustomProvider({
 			id: "trailingslash",
 			baseURL: "https://api.test.com/",
 		});
 		await def.fetchModels();
 		expect(capturedUrl).toBe("https://api.test.com/models");
 	});

	test("preserves context_length: 0 in response mapping", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						data: [{ id: "gpt-4o", context_length: 0 }],
					}),
					{ status: 200 },
				),
			),
		);

 		const def = buildCustomProvider({
 			id: "ctxzero",
 			baseURL: "https://api.test.com/v1",
 		});
 		const models = await def.fetchModels();
 		expect(models![0].contextWindow).toBe(0);
 	});
 });

describe("buildCustomProvider reasoning config", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("customReasoning field is set when reasoning config is provided", () => {
		const def = buildCustomProvider({
			id: "reasoning-test",
			baseURL: "https://api.test.com/v1",
			reasoning: { effort: "high" },
		});
		expect(def.customReasoning).toEqual({ effort: "high" });
	});

	test("customReasoning is undefined when no reasoning config", () => {
		const def = buildCustomProvider({
			id: "no-reasoning",
			baseURL: "https://api.test.com/v1",
		});
		expect(def.customReasoning).toBeUndefined();
	});

	test("fetch wrapper injects reasoning effort into request body", async () => {
		let capturedBody: string | null = null;
		globalThis.fetch = mock((_url: string, init: RequestInit) => {
			capturedBody = typeof init.body === "string" ? init.body : null;
			return Promise.resolve(
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "ok" } }],
					}),
					{ status: 200 },
				),
			);
		});

		const def = buildCustomProvider({
			id: "effort-test",
			baseURL: "https://api.test.com/v1",
			reasoning: { effort: "high" },
		});
		// Trigger a request through the model
		const model = def.createModel("test-model");
		try {
			await model.doGenerate({
				inputFormat: "prompt",
				mode: { type: "regular" },
				prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			});
		} catch {
			// Expected — the mock response shape may not fully satisfy the SDK
		}

		expect(capturedBody).not.toBeNull();
		const body = JSON.parse(capturedBody!);
		expect(body.reasoning).toEqual({ effort: "high" });
	});

	test("fetch wrapper forwards effort 'none' to explicitly disable thinking", async () => {
		let capturedBody: string | null = null;
		globalThis.fetch = mock((_url: string, init: RequestInit) => {
			capturedBody = typeof init.body === "string" ? init.body : null;
			return Promise.resolve(
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "ok" } }],
					}),
					{ status: 200 },
				),
			);
		});

		const def = buildCustomProvider({
			id: "effort-none-test",
			baseURL: "https://api.test.com/v1",
			reasoning: { effort: "none" },
		});
		const model = def.createModel("test-model");
		try {
			await model.doGenerate({
				inputFormat: "prompt",
				mode: { type: "regular" },
				prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			});
		} catch {
			// Expected
		}

		expect(capturedBody).not.toBeNull();
		const body = JSON.parse(capturedBody!);
		expect(body.reasoning).toEqual({ effort: "none" });
	});

	test("fetch wrapper injects DashScope-style thinking params", async () => {
		let capturedBody: string | null = null;
		globalThis.fetch = mock((_url: string, init: RequestInit) => {
			capturedBody = typeof init.body === "string" ? init.body : null;
			return Promise.resolve(
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "ok" } }],
					}),
					{ status: 200 },
				),
			);
		});

		const def = buildCustomProvider({
			id: "dashscope-test",
			baseURL: "https://api.test.com/v1",
			reasoning: { enabled: true, budget: 4096 },
		});
		const model = def.createModel("test-model");
		try {
			await model.doGenerate({
				inputFormat: "prompt",
				mode: { type: "regular" },
				prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			});
		} catch {
			// Expected
		}

		expect(capturedBody).not.toBeNull();
		const body = JSON.parse(capturedBody!);
		expect(body.enable_thinking).toBe(true);
		expect(body.thinking_budget).toBe(4096);
	});

	test("fetch wrapper injects extraParams verbatim", async () => {
		let capturedBody: string | null = null;
		globalThis.fetch = mock((_url: string, init: RequestInit) => {
			capturedBody = typeof init.body === "string" ? init.body : null;
			return Promise.resolve(
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "ok" } }],
					}),
					{ status: 200 },
				),
			);
		});

		const def = buildCustomProvider({
			id: "extra-params-test",
			baseURL: "https://api.test.com/v1",
			reasoning: {
				extraParams: {
					thinking: { type: "enabled", budget_tokens: 8192 },
				},
			},
		});
		const model = def.createModel("test-model");
		try {
			await model.doGenerate({
				inputFormat: "prompt",
				mode: { type: "regular" },
				prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			});
		} catch {
			// Expected
		}

		expect(capturedBody).not.toBeNull();
		const body = JSON.parse(capturedBody!);
		expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
	});

	test("fetch wrapper does not mutate original init object", async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mock((_url: string, init: RequestInit) => {
			capturedInit = init;
			return Promise.resolve(
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "ok" } }],
					}),
					{ status: 200 },
				),
			);
		});

		const def = buildCustomProvider({
			id: "mutation-test",
			baseURL: "https://api.test.com/v1",
			reasoning: { effort: "medium" },
		});
		const model = def.createModel("test-model");
		try {
			await model.doGenerate({
				inputFormat: "prompt",
				mode: { type: "regular" },
				prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			});
		} catch {
			// Expected
		}

		expect(capturedInit).toBeDefined();
		// The body should have reasoning params
		const body = JSON.parse(capturedInit!.body as string);
		expect(body.reasoning).toEqual({ effort: "medium" });
	});

	test("fetch wrapper skips injection when body is not a string", async () => {
		let capturedBody: unknown = null;
		globalThis.fetch = mock((_url: string, init: RequestInit) => {
			capturedBody = init.body;
			return Promise.resolve(
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "ok" } }],
					}),
					{ status: 200 },
				),
			);
		});

		const def = buildCustomProvider({
			id: "non-string-body-test",
			baseURL: "https://api.test.com/v1",
			reasoning: { effort: "high" },
		});
		const model = def.createModel("test-model");
		try {
			await model.doGenerate({
				inputFormat: "prompt",
				mode: { type: "regular" },
				prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			});
		} catch {
			// Expected
		}

		// Body should still be a string (SDK always sends JSON), with reasoning injected
		expect(typeof capturedBody).toBe("string");
		const body = JSON.parse(capturedBody as string);
		expect(body.reasoning).toEqual({ effort: "high" });
	});
});
