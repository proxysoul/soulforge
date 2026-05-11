import { describe, expect, test } from "bun:test";
import { resolveEmbeddingModel } from "../src/core/memory/embedder-resolver.js";
import type { AppConfig } from "../src/types/index.js";

const baseConfig = (overrides: Partial<AppConfig> = {}): AppConfig =>
  ({
    defaultModel: "anthropic/claude-sonnet-4-6",
    ...overrides,
  }) as AppConfig;

describe("resolveEmbeddingModel — precedence", () => {
  test("explicit override wins over everything", () => {
    const cfg = baseConfig({
      memory: { embeddingModel: "openai/text-embedding-3-large" },
      taskRouter: { semantic: "google/text-embedding-004" } as AppConfig["taskRouter"],
    });
    const r = resolveEmbeddingModel(cfg, "anthropic/claude-sonnet-4-6");
    expect(r.modelId).toBe("openai/text-embedding-3-large");
    expect(r.source).toBe("explicit");
  });

  test("explicit null disables — never falls back to heuristic", () => {
    const cfg = baseConfig({ memory: { embeddingModel: null } });
    const r = resolveEmbeddingModel(cfg, "openai/gpt-5");
    expect(r.modelId).toBeNull();
    expect(r.source).toBe("none");
  });

  test("explicit empty string falls through to next layer", () => {
    const cfg = baseConfig({ memory: { embeddingModel: "" } });
    const r = resolveEmbeddingModel(cfg, "openai/gpt-5");
    expect(r.modelId).toBe("openai/text-embedding-3-small");
    expect(r.source).toBe("heuristic");
  });

  test("taskRouter.semantic used when no explicit override", () => {
    const cfg = baseConfig({
      taskRouter: { semantic: "google/text-embedding-004" } as AppConfig["taskRouter"],
    });
    const r = resolveEmbeddingModel(cfg, "anthropic/claude-sonnet-4-6");
    expect(r.modelId).toBe("google/text-embedding-004");
    expect(r.source).toBe("task-router");
  });

  test("heuristic from active model's provider", () => {
    const r = resolveEmbeddingModel(baseConfig(), "openai/gpt-5");
    expect(r.modelId).toBe("openai/text-embedding-3-small");
    expect(r.source).toBe("heuristic");
  });
});

describe("resolveEmbeddingModel — provider heuristics", () => {
  test.each([
    ["openai/gpt-5", "openai/text-embedding-3-small"],
    ["google/gemini-2.5-pro", "google/text-embedding-004"],
    ["vercel_gateway/anthropic/claude-sonnet", "vercel_gateway/openai/text-embedding-3-small"],
    ["llmgateway/openai/gpt-5", "llmgateway/openai/text-embedding-3-small"],
    ["openrouter/anthropic/claude", "openrouter/openai/text-embedding-3-small"],
  ])("%s → %s", (active, expected) => {
    const r = resolveEmbeddingModel(baseConfig(), active);
    expect(r.modelId).toBe(expected);
    expect(r.source).toBe("heuristic");
  });

  test.each([
    "anthropic/claude-sonnet-4-6",
    "proxy/claude-haiku",
    "xai/grok-4",
    "codex/gpt-5",
    "copilot/gpt-4",
    "groq/llama-3.3-70b",
    "deepseek/chat",
    "mistral/large",
    "ollama/llama3.2",
    "lmstudio/local",
  ])("%s → null (no embedding API)", (active) => {
    const r = resolveEmbeddingModel(baseConfig(), active);
    expect(r.modelId).toBeNull();
    expect(r.source).toBe("none");
  });
});

describe("resolveEmbeddingModel — degenerate inputs", () => {
  test("null config → safe fallback", () => {
    const r = resolveEmbeddingModel(null, "openai/gpt-5");
    expect(r.modelId).toBe("openai/text-embedding-3-small");
    expect(r.source).toBe("heuristic");
  });

  test("undefined config → safe fallback", () => {
    const r = resolveEmbeddingModel(undefined, "openai/gpt-5");
    expect(r.source).toBe("heuristic");
  });

  test("empty active model → none", () => {
    const r = resolveEmbeddingModel(baseConfig(), "");
    expect(r.modelId).toBeNull();
    expect(r.source).toBe("none");
  });

  test("'none' active model → none", () => {
    const r = resolveEmbeddingModel(baseConfig(), "none");
    expect(r.modelId).toBeNull();
    expect(r.source).toBe("none");
  });

  test("null active model → none", () => {
    const r = resolveEmbeddingModel(baseConfig(), null);
    expect(r.modelId).toBeNull();
  });

  test("active model with no slash → unknown provider", () => {
    const r = resolveEmbeddingModel(baseConfig(), "gpt-5");
    expect(r.modelId).toBeNull();
  });

  test("unknown custom provider → null, advises explicit config", () => {
    const r = resolveEmbeddingModel(baseConfig(), "mycustom/my-model");
    expect(r.modelId).toBeNull();
    expect(r.source).toBe("none");
    expect(r.reason).toContain("mycustom");
  });

  test("whitespace-only explicit override falls through", () => {
    const cfg = baseConfig({ memory: { embeddingModel: "   " } });
    const r = resolveEmbeddingModel(cfg, "openai/gpt-5");
    expect(r.source).toBe("heuristic");
  });

  test("whitespace-only taskRouter.semantic falls through", () => {
    const cfg = baseConfig({
      taskRouter: { semantic: "   " } as AppConfig["taskRouter"],
    });
    const r = resolveEmbeddingModel(cfg, "openai/gpt-5");
    expect(r.source).toBe("heuristic");
  });

  test("explicit override is trimmed", () => {
    const cfg = baseConfig({
      memory: { embeddingModel: "  openai/text-embedding-3-small  " },
    });
    const r = resolveEmbeddingModel(cfg, "anthropic/claude");
    expect(r.modelId).toBe("openai/text-embedding-3-small");
  });
});
