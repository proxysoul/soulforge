import { describe, expect, test } from "bun:test";
import {
  buildProviderOptions,
  clampEffort,
  degradeProviderOptions,
  detectModelFamily,
  getSupportedClaudeEfforts,
  getSupportedEfforts,
  telemetryModelInfo,
} from "../src/core/llm/provider-options.js";
import { registerCustomProviders } from "../src/core/llm/providers/index.js";
import type { AppConfig } from "../src/types/index.js";
import { getCompatReasoningBody } from "../src/core/llm/compat-reasoning.js";

function baseConfig(perf: Partial<AppConfig["performance"]> = {}): AppConfig {
  return {
    defaultModel: "",
    routerRules: [],
    editor: { command: "nvim", args: [] },
    theme: { name: "default" },
    performance: perf,
  } as unknown as AppConfig;
}

describe("Bedrock", () => {
      test("emits providerOptions.bedrock.reasoningConfig (not anthropic)", async () => {
        const cfg = baseConfig({ effort: "high" });
        (cfg as { thinking?: unknown }).thinking = { mode: "enabled", budgetTokens: 8192 };
        const { providerOptions } = await buildProviderOptions(
          "bedrock/anthropic.claude-sonnet-4-6-v1",
          cfg,
        );
        expect(providerOptions.bedrock).toMatchObject({
          reasoningConfig: { type: "enabled", budgetTokens: 8192 },
        });
        expect(providerOptions.anthropic).toBeUndefined();
      });

      test("adaptive thinking → reasoningConfig.type=adaptive", async () => {
        const cfg = baseConfig() as AppConfig;
        (cfg as { thinking?: unknown }).thinking = { mode: "adaptive" };
        const { providerOptions } = await buildProviderOptions(
          "bedrock/anthropic.claude-opus-4-7",
          cfg,
        );
        expect((providerOptions.bedrock as Record<string, unknown>).reasoningConfig).toMatchObject({
          type: "adaptive",
        });
      });
    });

    describe("Claude on opencode-zen — body injection", () => {
      test("emits Anthropic-shape thinking body via compat-reasoning", () => {
        const cfg = baseConfig({ effort: "high" }) as AppConfig;
        (cfg as { thinking?: unknown }).thinking = { mode: "enabled", budgetTokens: 12000 };
        const body = getCompatReasoningBody("opencode-zen/claude-sonnet-4.6", cfg);
        expect(body).toEqual({
          thinking: { type: "enabled", budget_tokens: 12000 },
        });
      });

      test("budget falls back to effort heuristic when thinking budget unset", () => {
        const cfg = baseConfig({ effort: "low" });
        const body = getCompatReasoningBody("opencode-zen/claude-opus-4.6", cfg);
        expect(body).toEqual({
          thinking: { type: "enabled", budget_tokens: 2048 },
        });
      });
    });

    describe("OpenRouter — Claude budget inheritance", () => {
      test("inherits config.thinking.budgetTokens as max_tokens", async () => {
        const cfg = baseConfig() as AppConfig;
        (cfg as { thinking?: unknown }).thinking = { mode: "enabled", budgetTokens: 8192 };
        const { providerOptions } = await buildProviderOptions(
          "openrouter/anthropic/claude-sonnet-4.6",
          cfg,
        );
        expect(providerOptions.openrouter).toEqual({ reasoning: { max_tokens: 8192 } });
      });

      test("explicit openrouterReasoningMaxTokens wins over thinking budget", async () => {
        const cfg = baseConfig({ openrouterReasoningMaxTokens: 4096 }) as AppConfig;
        (cfg as { thinking?: unknown }).thinking = { mode: "enabled", budgetTokens: 8192 };
        const { providerOptions } = await buildProviderOptions(
          "openrouter/anthropic/claude-sonnet-4.6",
          cfg,
        );
        expect(providerOptions.openrouter).toEqual({ reasoning: { max_tokens: 4096 } });
      });
    });

    describe("OpenAI additional knobs", () => {
      test("reasoningSummary + verbosity propagate", async () => {
        const cfg = baseConfig({
          openaiReasoningEffort: "high",
          openaiReasoningSummary: "detailed",
          openaiVerbosity: "low",
        });
        const { providerOptions } = await buildProviderOptions("openai/gpt-5", cfg);
        expect(providerOptions.openai).toMatchObject({
          reasoningEffort: "high",
          reasoningSummary: "detailed",
          verbosity: "low",
        });
      });
    });

    describe("degradeProviderOptions — multi-family", () => {
      test("anthropic still degrades to minimal thinking", () => {
        const { providerOptions } = degradeProviderOptions("anthropic/claude-opus-4-6", 1);
        expect(providerOptions.anthropic).toMatchObject({
          thinking: { type: "enabled", budgetTokens: 5000 },
        });
      });

      test("openai degrades to low effort", () => {
        const { providerOptions } = degradeProviderOptions("openai/gpt-5", 1);
        expect(providerOptions.openai).toEqual({ reasoningEffort: "low" });
      });

      test("xai degrades to low effort", () => {
        const { providerOptions } = degradeProviderOptions("xai/grok-4-fast", 1);
        expect(providerOptions.xai).toEqual({ reasoningEffort: "low" });
      });

      test("google degrades to thinkingLevel low (Gemini 3)", () => {
        const { providerOptions } = degradeProviderOptions("google/gemini-3.1-pro-preview", 1);
        expect(providerOptions.google).toEqual({ thinkingConfig: { thinkingLevel: "low" } });
      });

      test("google degrades to small thinkingBudget (Gemini 2.5)", () => {
        const { providerOptions } = degradeProviderOptions("google/gemini-2.5-flash", 1);
        expect(providerOptions.google).toEqual({ thinkingConfig: { thinkingBudget: 1024 } });
      });

  test("level 2 wipes all options", () => {
    const { providerOptions } = degradeProviderOptions("anthropic/claude-opus-4-6", 2);
    expect(providerOptions).toEqual({});
  });
});

describe("xAI clamping (chat API: low|high only)", () => {
  test("medium explicit clamps to high", async () => {
    const cfg = baseConfig({ xaiReasoningEffort: "medium" });
    const { providerOptions } = await buildProviderOptions("xai/grok-4-fast", cfg);
    expect(providerOptions.xai).toEqual({ reasoningEffort: "high" });
  });

  test("unified effort medium maps to high (chat-safe)", async () => {
    const cfg = baseConfig({ effort: "medium" });
    const { providerOptions } = await buildProviderOptions("xai/grok-4-fast", cfg);
    expect(providerOptions.xai).toEqual({ reasoningEffort: "high" });
  });
});

describe("Groq Qwen3 quirk", () => {
  test("qwen3 emits reasoning_effort=default (not low/medium/high)", () => {
    const cfg = baseConfig({ groqReasoningEffort: "high" });
    const body = getCompatReasoningBody("groq/qwen/qwen3-32b", cfg);
    expect(body).toEqual({ reasoning_effort: "default" });
  });

  test("gpt-oss on Groq keeps high", () => {
    const cfg = baseConfig({ groqReasoningEffort: "high" });
    const body = getCompatReasoningBody("groq/openai/gpt-oss-120b", cfg);
    expect(body.reasoning_effort).toBe("high");
  });
});

describe("detectModelFamily", () => {
  test("openrouter anthropic prefix → claude", () => {
    expect(detectModelFamily("openrouter/anthropic/claude-sonnet-4.6")).toBe("claude");
  });

  test("openrouter google prefix → google", () => {
    expect(detectModelFamily("openrouter/google/gemini-2.5-pro")).toBe("google");
  });

  test("openrouter x-ai prefix → xai", () => {
    expect(detectModelFamily("openrouter/x-ai/grok-4")).toBe("xai");
  });

  test("direct xai → xai", () => {
    expect(detectModelFamily("xai/grok-4-fast")).toBe("xai");
  });

  test("direct deepseek → deepseek", () => {
    expect(detectModelFamily("deepseek/deepseek-chat")).toBe("deepseek");
  });
});

describe("buildProviderOptions — xAI", () => {
  test("grok-4 emits providerOptions.xai.reasoningEffort (not openai)", async () => {
    const cfg = baseConfig({ effort: "high" });
    const { providerOptions } = await buildProviderOptions("xai/grok-4-fast", cfg);
    expect(providerOptions.xai).toEqual({ reasoningEffort: "high" });
    expect(providerOptions.openai).toBeUndefined();
  });

  test("explicit xaiReasoningEffort overrides unified effort", async () => {
    const cfg = baseConfig({ effort: "high", xaiReasoningEffort: "low" });
    const { providerOptions } = await buildProviderOptions("xai/grok-4-fast", cfg);
    expect(providerOptions.xai).toEqual({ reasoningEffort: "low" });
  });
});

describe("buildProviderOptions — Google", () => {
  test("gemini-3.1-pro emits thinkingConfig.thinkingLevel", async () => {
    const cfg = baseConfig({ effort: "high" });
    const { providerOptions } = await buildProviderOptions("google/gemini-3.1-pro-preview", cfg);
    expect(providerOptions.google).toMatchObject({
      thinkingConfig: { thinkingLevel: "high" },
    });
  });

  test("gemini-2.5-flash emits thinkingConfig.thinkingBudget", async () => {
    const cfg = baseConfig({ effort: "high" });
    const { providerOptions } = await buildProviderOptions("google/gemini-2.5-flash", cfg);
    expect((providerOptions.google as Record<string, unknown>).thinkingConfig).toMatchObject({
      thinkingBudget: 8192,
    });
  });

  test("explicit googleThinkingLevel wins on gemini-3", async () => {
    const cfg = baseConfig({ googleThinkingLevel: "minimal" });
    const { providerOptions } = await buildProviderOptions("google/gemini-3-flash-preview", cfg);
    expect((providerOptions.google as Record<string, unknown>).thinkingConfig).toEqual({
      thinkingLevel: "minimal",
    });
  });
});

describe("buildProviderOptions — DeepSeek", () => {
  test("deepseek-chat emits providerOptions.deepseek.thinking", async () => {
    const cfg = baseConfig({ effort: "high" });
    const { providerOptions } = await buildProviderOptions("deepseek/deepseek-chat", cfg);
    expect(providerOptions.deepseek).toEqual({ thinking: { type: "enabled" } });
  });

  test("explicit off disables thinking", async () => {
    const cfg = baseConfig({ effort: "high", deepseekThinking: "off" });
    const { providerOptions } = await buildProviderOptions("deepseek/deepseek-chat", cfg);
    expect(providerOptions.deepseek).toBeUndefined();
  });
});

describe("buildProviderOptions — OpenRouter", () => {
  test("openrouter emits unified reasoning.effort", async () => {
    const cfg = baseConfig({ effort: "high" });
    const { providerOptions } = await buildProviderOptions(
      "openrouter/anthropic/claude-sonnet-4.6",
      cfg,
    );
    expect(providerOptions.openrouter).toEqual({ reasoning: { effort: "high" } });
  });

  test("openrouter max_tokens takes priority over effort", async () => {
    const cfg = baseConfig({
      effort: "high",
      openrouterReasoningMaxTokens: 4096,
    });
    const { providerOptions } = await buildProviderOptions(
      "openrouter/anthropic/claude-sonnet-4.6",
      cfg,
    );
    expect(providerOptions.openrouter).toEqual({ reasoning: { max_tokens: 4096 } });
  });

  test("openrouter exclude flag", async () => {
    const cfg = baseConfig({ effort: "low", openrouterExcludeReasoning: true });
    const { providerOptions } = await buildProviderOptions("openrouter/openai/gpt-5", cfg);
    expect(providerOptions.openrouter).toEqual({
      reasoning: { effort: "low", exclude: true },
    });
  });
});

describe("buildProviderOptions — regression: existing behaviour preserved", () => {
  test("anthropic/claude-opus-4-6 still emits adaptive thinking", async () => {
    const cfg = baseConfig() as AppConfig;
    (cfg as { thinking?: unknown }).thinking = { mode: "adaptive" };
    const { providerOptions } = await buildProviderOptions("anthropic/claude-opus-4-6", cfg);
    expect(providerOptions.anthropic).toMatchObject({ thinking: { type: "adaptive" } });
  });

  test("openai/gpt-5 still emits reasoningEffort", async () => {
    const cfg = baseConfig({ openaiReasoningEffort: "high" });
    const { providerOptions } = await buildProviderOptions("openai/gpt-5", cfg);
    expect(providerOptions.openai).toMatchObject({ reasoningEffort: "high" });
  });
});

describe("getSupportedClaudeEfforts", () => {
  test("opus 4.7 supports full ladder incl. xhigh + max", () => {
    expect(getSupportedClaudeEfforts("anthropic/claude-opus-4-7")).toEqual([
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
  });

  test("opus 4.6 + sonnet 4.6 support max but NOT xhigh", () => {
    expect(getSupportedClaudeEfforts("anthropic/claude-opus-4-6")).toEqual([
      "max",
      "high",
      "medium",
      "low",
    ]);
    expect(getSupportedClaudeEfforts("anthropic/claude-sonnet-4-6")).toEqual([
      "max",
      "high",
      "medium",
      "low",
    ]);
  });

  test("opus 4.5 supports max (not xhigh)", () => {
    const e = getSupportedClaudeEfforts("anthropic/claude-opus-4-5");
    expect(e).toContain("max");
    expect(e).not.toContain("xhigh");
  });

  test("haiku has no effort support", () => {
    expect(getSupportedClaudeEfforts("anthropic/claude-haiku-4-5")).toBeNull();
  });

  test("clampEffort folds unsupported xhigh down to high on opus 4.6", () => {
    expect(clampEffort("anthropic/claude-opus-4-6", "xhigh")).toBe("high");
  });

  test("clampEffort keeps max on opus 4.6", () => {
    expect(clampEffort("anthropic/claude-opus-4-6", "max")).toBe("max");
  });
});

describe("getSupportedEfforts (route-agnostic, family-dispatched)", () => {
  test("claude through any route resolves the same per-model set", () => {
    const expected = ["off", "max", "high", "medium", "low"];
    expect(getSupportedEfforts("anthropic/claude-opus-4-6")).toEqual(expected);
    expect(getSupportedEfforts("proxy/claude-opus-4-6")).toEqual(expected);
    expect(getSupportedEfforts("llmgateway/claude-opus-4-6")).toEqual(expected);
    expect(getSupportedEfforts("openrouter/anthropic/claude-opus-4-6")).toEqual(expected);
  });

  test("opus 4.7 exposes xhigh; 4.6 does not", () => {
    expect(getSupportedEfforts("proxy/claude-opus-4-7")).toContain("xhigh");
    expect(getSupportedEfforts("proxy/claude-opus-4-6")).not.toContain("xhigh");
  });

  test("deepseek caps at high|max", () => {
    expect(getSupportedEfforts("deepseek/deepseek-v4-pro")).toEqual(["off", "high", "max"]);
  });

  test("openai reasoning has no xhigh; non-reasoning is null", () => {
    expect(getSupportedEfforts("openai/gpt-5")).toEqual([
      "off",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(getSupportedEfforts("openai/gpt-4o")).toBeNull();
  });

  test("non-effort families return null (keep static list)", () => {
    expect(getSupportedEfforts("anthropic/claude-haiku-4-5")).toBeNull();
  });
});

describe("getCompatReasoningBody", () => {
  test("deepseek/deepseek-chat returns reasoning_effort body", () => {
    const cfg = baseConfig({ effort: "high" });
    const body = getCompatReasoningBody("deepseek/deepseek-chat", cfg);
    expect(body.reasoning_effort).toBe("high");
  });

  test("deepseek dedicated effort=max emits real max (not xhigh)", () => {
    const cfg = baseConfig({ deepseekReasoningEffort: "max" });
    const body = getCompatReasoningBody("deepseek/deepseek-v4-pro", cfg);
    expect(body.reasoning_effort).toBe("max");
    expect(body.reasoning).toBeUndefined();
  });

  test("deepseek dedicated effort overrides global effort", () => {
    const cfg = baseConfig({ effort: "low", deepseekReasoningEffort: "high" });
    expect(getCompatReasoningBody("deepseek/deepseek-v4-pro", cfg).reasoning_effort).toBe("high");
  });

  test("deepseek folds global effort=max to max (no xhigh detour)", () => {
    const cfg = baseConfig({ effort: "max" });
    expect(getCompatReasoningBody("deepseek/deepseek-v4-pro", cfg).reasoning_effort).toBe("max");
  });

  test("deepseek folds generic low/medium down to high", () => {
    const cfg = baseConfig({ deepseekReasoningEffort: "off", compatReasoningEffort: "medium" });
    expect(getCompatReasoningBody("deepseek/deepseek-chat", cfg).reasoning_effort).toBe("high");
  });

  test("groq with groqReasoningEffort populates body (gpt-oss → medium)", () => {
    const cfg = baseConfig({ groqReasoningEffort: "medium" });
    const body = getCompatReasoningBody("groq/openai/gpt-oss-120b", cfg);
    expect(body.reasoning_effort).toBe("medium");
  });

  test("opencode-go GLM picks up dashscope enable_thinking", () => {
    const cfg = baseConfig({ compatReasoningEffort: "high" });
    const body = getCompatReasoningBody("opencode-go/glm-5.1", cfg);
    expect(body.reasoning_effort).toBe("high");
    expect(body.enable_thinking).toBe(true);
  });

  test("llmgateway/deepseek picks up unified effort", () => {
    const cfg = baseConfig({ effort: "high" });
    const body = getCompatReasoningBody("llmgateway/deepseek-v4-pro", cfg);
    expect(body.reasoning_effort).toBe("high");
    // LLM Gateway rejects both keys — only reasoning_effort, never reasoning.effort.
    expect(body.reasoning).toBeUndefined();
  });

  test("llmgateway dedicated effort overrides shared compat knob", () => {
    const cfg = baseConfig({ compatReasoningEffort: "low", llmgatewayReasoningEffort: "high" });
    const body = getCompatReasoningBody("llmgateway/deepseek-v4-pro", cfg);
    expect(body.reasoning_effort).toBe("high");
    expect(body.reasoning).toBeUndefined();
  });

  test("llmgateway off effort falls through to shared/global knobs", () => {
    const cfg = baseConfig({ llmgatewayReasoningEffort: "off", effort: "medium" });
    const body = getCompatReasoningBody("llmgateway/deepseek-v4-pro", cfg);
    expect(body.reasoning_effort).toBe("medium");
  });

  test("llmgateway Claude is guarded (no reasoning_effort body)", () => {
    const cfg = baseConfig({ effort: "high" });
    expect(getCompatReasoningBody("llmgateway/claude-sonnet-4-6", cfg)).toEqual({});
  });

  test("returns empty when no effort set", () => {
    const cfg = baseConfig();
    expect(getCompatReasoningBody("groq/qwen3-32b", cfg)).toEqual({});
  });
});

describe("telemetryModelInfo (privacy-safe provider/model)", () => {
  test("built-in provider + known model → exact names", () => {
    expect(telemetryModelInfo("anthropic/claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(telemetryModelInfo("openai/gpt-5")).toEqual({ provider: "openai", model: "gpt-5" });
    expect(telemetryModelInfo("google/gemini-2.5-pro")).toEqual({
      provider: "google",
      model: "gemini-2.5-pro",
    });
  });

  test("gateway provider keeps gateway id, model name preserved", () => {
    // llmgateway routing nested anthropic model — provider stays the gateway.
    expect(telemetryModelInfo("llmgateway/claude-sonnet-4-6")).toEqual({
      provider: "llmgateway",
      model: "claude-sonnet-4-6",
    });
  });

  test("custom provider buckets to 'custom' and model to 'other' — no leak", () => {
    registerCustomProviders([
      {
        id: "mycorp",
        name: "MyCorp Internal",
        baseURL: "https://llm.mycorp.internal/v1",
        models: [{ id: "mycorp-secret-model-v3" }],
      },
    ] as never);
    // Custom providers are suffixed "-custom" by the registry.
    const info = telemetryModelInfo("mycorp-custom/mycorp-secret-model-v3");
    expect(info.provider).toBe("custom");
    expect(info.model).toBe("other");
    // The private model/provider name must NOT appear anywhere.
    expect(JSON.stringify(info)).not.toContain("mycorp");
    expect(JSON.stringify(info)).not.toContain("secret");
  });

  test("unknown bare provider → custom, unknown model → other", () => {
    const info = telemetryModelInfo("weirdprovider/some-private-thing");
    expect(info.provider).toBe("custom");
    expect(info.model).toBe("other");
  });

  test("model name is sanitized to safe charset + length", () => {
    const info = telemetryModelInfo("openai/gpt-5");
    expect(info.model).toMatch(/^[a-z0-9.\-]{1,40}$/);
  });

  test("built-in provider + malformed model → 'other' (shape gate)", () => {
    // The shape gate blocks anything that isn't a low-cardinality model slug:
    // spaces, query chars, path traversal, over-length, too many tokens.
    const adversarial = [
      "anthropic/claude AAA-bbbbb-ccccc-12345", // spaces fail the shape
      "anthropic/claude-../../etc/passwd", // path traversal fails the shape
      "openai/gpt-5?token=abc&user=alice", // query chars fail the shape
      `proxy/${"x".repeat(200)}`, // over length cap
      `proxy/${"a-".repeat(20)}`, // too many tokens (>5 segments)
    ];
    for (const id of adversarial) {
      const info = telemetryModelInfo(id);
      expect(info.model).toBe("other");
    }
  });

  test("recognized public models survive the allow-list", () => {
    const known: Array<[string, string]> = [
      ["anthropic/claude-opus-4-7", "claude-opus-4-7"],
      ["anthropic/claude-opus-4.7", "claude-opus-4.7"],
      ["openai/gpt-4o", "gpt-4o"],
      ["openai/o3-mini", "o3-mini"],
      ["xai/grok-4", "grok-4"],
      ["deepseek/deepseek-reasoner", "deepseek-reasoner"],
      // Shape gate (not a per-family allow-list) → previously-dropped models
      // now surface with their real names.
      ["google/gemini-3.1-pro-preview", "gemini-3.1-pro-preview"],
      ["google/gemini-3.1-pro-low", "gemini-3.1-pro-low"],
      ["openai/gpt-5.3-codex", "gpt-5.3-codex"],
      ["openai/gpt-5.4-mini", "gpt-5.4-mini"],
      ["anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"],
    ];
    for (const [id, expected] of known) {
      expect(telemetryModelInfo(id).model).toBe(expected);
    }
  });
});
