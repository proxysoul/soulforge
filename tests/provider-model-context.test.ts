import { describe, expect, test } from "bun:test";
import {
  applyProviderContextOverride,
  getModelContextInfoSync,
  matchesContextOverride,
} from "../src/core/llm/models.js";
import { codex } from "../src/core/llm/providers/codex.js";

const GPT_55_INPUT_CONTEXT = 272_000;

describe("provider model context normalization", () => {
  test("matches exact and provider-prefixed override IDs", () => {
    expect(matchesContextOverride("gpt-5.5", "gpt-5.5")).toBe(true);
    expect(matchesContextOverride("openai/gpt-5.5", "gpt-5.5")).toBe(true);
    expect(matchesContextOverride("gpt-5.5-pro", "gpt-5.5")).toBe(false);
  });

  test("resolves bare gpt-5.5 sync context as an override", () => {
    expect(getModelContextInfoSync("gpt-5.5")).toEqual({
      tokens: GPT_55_INPUT_CONTEXT,
      source: "override",
    });
  });

  test("normalizes proxy gpt-5.5 context from upstream metadata", () => {
    expect(
      applyProviderContextOverride("proxy", {
        id: "gpt-5.5",
        name: "gpt-5.5",
        contextWindow: 1_000_000,
      }).contextWindow,
    ).toBe(GPT_55_INPUT_CONTEXT);

    expect(
      applyProviderContextOverride("proxy", {
        id: "openai/gpt-5.5",
        name: "openai/gpt-5.5",
        contextWindow: 1_000_000,
      }).contextWindow,
    ).toBe(GPT_55_INPUT_CONTEXT);
  });

  test("does not apply gpt-5.5 override to gpt-5.5-pro", () => {
    expect(
      applyProviderContextOverride("proxy", {
        id: "gpt-5.5-pro",
        name: "gpt-5.5-pro",
        contextWindow: 1_000_000,
      }).contextWindow,
    ).toBe(1_000_000);
  });

  test("normalizes codex gpt-5.5 when fetched model omits context", () => {
    expect(
      applyProviderContextOverride("codex", {
        id: "gpt-5.5",
        name: "gpt-5.5",
      }).contextWindow,
    ).toBe(GPT_55_INPUT_CONTEXT);

    expect(codex.fallbackModels.find((m) => m.id === "gpt-5.5")?.contextWindow).toBe(
      GPT_55_INPUT_CONTEXT,
    );
  });
});
