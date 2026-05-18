import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetRetryWarnings,
  DEFAULT_AGENT_BASE_DELAY_MS,
  DEFAULT_CHAT_BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  MAX_BASE_DELAY_MS,
  MIN_BASE_DELAY_MS,
  MIN_MAX_ATTEMPTS,
  resolveRetrySettings,
} from "../src/core/retry/settings.js";
import { useErrorStore } from "../src/stores/errors.js";

beforeEach(() => {
  __resetRetryWarnings();
  useErrorStore.getState().clear();
});

/**
 * Hostile-input tests for retry config.
 *
 * Config is loaded from raw JSON (~/.soulforge/config.json) — no schema layer
 * validates it. resolveRetrySettings MUST defensively clamp/fallback so that
 * a malformed user config can never crash the chat loop or the agent runner.
 */

describe("resolveRetrySettings — missing/empty input falls back to defaults", () => {
  test("undefined → defaults (chat)", () => {
    expect(resolveRetrySettings(undefined)).toEqual({
      transient: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      stall: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      cycles: { maxRetries: 3, backoffMs: 0 },
    });
  });

  test("null → defaults (chat)", () => {
    expect(resolveRetrySettings(null)).toEqual({
      transient: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      stall: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      cycles: { maxRetries: 3, backoffMs: 0 },
    });
  });

  test("empty object → defaults (chat)", () => {
    expect(resolveRetrySettings({})).toEqual({
      transient: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      stall: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      cycles: { maxRetries: 3, backoffMs: 0 },
    });
  });

  test("agent preset uses 2000ms base delay", () => {
    expect(resolveRetrySettings(undefined, { agent: true })).toEqual({
      transient: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_AGENT_BASE_DELAY_MS },
      stall: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_AGENT_BASE_DELAY_MS },
      cycles: { maxRetries: 3, backoffMs: 0 },
    });
  });

  test("individual undefined fields fall back per-field", () => {
    expect(resolveRetrySettings({ maxAttempts: 7 })).toEqual({
      transient: { maxRetries: 7, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      stall: { maxRetries: 7, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      cycles: { maxRetries: 3, backoffMs: 0 },
    });
    expect(resolveRetrySettings({ baseDelayMs: 5000 })).toEqual({
      transient: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: 5000 },
      stall: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: 5000 },
      cycles: { maxRetries: 3, backoffMs: 0 },
    });
  });
});

describe("resolveRetrySettings — back-compat maxAttempts → both retries", () => {
  test("maxAttempts sets both transient + stall when neither override present", () => {
    const r = resolveRetrySettings({ maxAttempts: 5 });
    expect(r.transient.maxRetries).toBe(5);
    expect(r.stall.maxRetries).toBe(5);
  });

  test("maxTransientRetries overrides maxAttempts for transient only", () => {
    const r = resolveRetrySettings({ maxAttempts: 5, maxTransientRetries: 8 });
    expect(r.transient.maxRetries).toBe(8);
    expect(r.stall.maxRetries).toBe(5);
  });

  test("maxStallRetries overrides maxAttempts for stall only", () => {
    const r = resolveRetrySettings({ maxAttempts: 5, maxStallRetries: 2 });
    expect(r.transient.maxRetries).toBe(5);
    expect(r.stall.maxRetries).toBe(2);
  });

  test("both overrides set — maxAttempts ignored", () => {
    const r = resolveRetrySettings({
      maxAttempts: 5,
      maxTransientRetries: 8,
      maxStallRetries: 2,
    });
    expect(r.transient.maxRetries).toBe(8);
    expect(r.stall.maxRetries).toBe(2);
  });
});

describe("resolveRetrySettings — happy path within range", () => {
  test("exact valid values pass through", () => {
    expect(resolveRetrySettings({ maxAttempts: 5, baseDelayMs: 3000 })).toEqual({
      transient: { maxRetries: 5, backoffMs: 3000 },
      stall: { maxRetries: 5, backoffMs: 3000 },
      cycles: { maxRetries: 3, backoffMs: 0 },
    });
  });

  test("fractional numbers round to nearest int", () => {
    const r = resolveRetrySettings({ maxAttempts: 4.7, baseDelayMs: 1999.4 });
    expect(r.transient.maxRetries).toBe(5);
    expect(r.stall.maxRetries).toBe(5);
    expect(r.transient.backoffMs).toBe(1999);
    expect(r.stall.backoffMs).toBe(1999);
  });

  test("range minimums preserved", () => {
    expect(resolveRetrySettings({ maxAttempts: MIN_MAX_ATTEMPTS })).toMatchObject({
      transient: { maxRetries: MIN_MAX_ATTEMPTS },
      stall: { maxRetries: MIN_MAX_ATTEMPTS },
    });
    expect(resolveRetrySettings({ baseDelayMs: MIN_BASE_DELAY_MS })).toMatchObject({
      transient: { backoffMs: MIN_BASE_DELAY_MS },
      stall: { backoffMs: MIN_BASE_DELAY_MS },
    });
  });

  test("large maxAttempts passes through (no upper cap)", () => {
    expect(resolveRetrySettings({ maxAttempts: 99 }).transient.maxRetries).toBe(99);
    expect(resolveRetrySettings({ maxAttempts: 500 }).transient.maxRetries).toBe(500);
  });

  test("baseDelayMs range maximum preserved", () => {
    expect(resolveRetrySettings({ baseDelayMs: MAX_BASE_DELAY_MS })).toMatchObject({
      transient: { backoffMs: MAX_BASE_DELAY_MS },
      stall: { backoffMs: MAX_BASE_DELAY_MS },
    });
  });
});

describe("resolveRetrySettings — clamps out-of-range numbers", () => {
  test("maxAttempts below min clamps up", () => {
    expect(resolveRetrySettings({ maxAttempts: 0 }).transient.maxRetries).toBe(MIN_MAX_ATTEMPTS);
    expect(resolveRetrySettings({ maxAttempts: -1 }).transient.maxRetries).toBe(MIN_MAX_ATTEMPTS);
    expect(resolveRetrySettings({ maxAttempts: -9999 }).transient.maxRetries).toBe(MIN_MAX_ATTEMPTS);
  });

  test("baseDelayMs below min clamps up", () => {
    expect(resolveRetrySettings({ baseDelayMs: 0 }).transient.backoffMs).toBe(MIN_BASE_DELAY_MS);
    expect(resolveRetrySettings({ baseDelayMs: 10 }).transient.backoffMs).toBe(MIN_BASE_DELAY_MS);
    expect(resolveRetrySettings({ baseDelayMs: -5000 }).transient.backoffMs).toBe(MIN_BASE_DELAY_MS);
  });

  test("baseDelayMs above max clamps down", () => {
    expect(resolveRetrySettings({ baseDelayMs: 999_999 }).transient.backoffMs).toBe(MAX_BASE_DELAY_MS);
    expect(
      resolveRetrySettings({ baseDelayMs: Number.MAX_SAFE_INTEGER }).transient.backoffMs,
    ).toBe(MAX_BASE_DELAY_MS);
  });
});

describe("resolveRetrySettings — garbage inputs never throw and fall back", () => {
  test("NaN → default", () => {
    const r = resolveRetrySettings({ maxAttempts: NaN, baseDelayMs: NaN });
    expect(r.transient.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(r.stall.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(r.transient.backoffMs).toBe(DEFAULT_CHAT_BASE_DELAY_MS);
    expect(r.stall.backoffMs).toBe(DEFAULT_CHAT_BASE_DELAY_MS);
  });

  test("Infinity / -Infinity → default", () => {
    expect(
      resolveRetrySettings({ maxAttempts: Infinity, baseDelayMs: Infinity }),
    ).toEqual({
      transient: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      stall: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      cycles: { maxRetries: 3, backoffMs: 0 },
    });
    expect(
      resolveRetrySettings({ maxAttempts: -Infinity, baseDelayMs: -Infinity }),
    ).toEqual({
      transient: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      stall: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      cycles: { maxRetries: 3, backoffMs: 0 },
    });
  });

  test("string values → default (no coercion)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
    const r = resolveRetrySettings({ maxAttempts: "5", baseDelayMs: "3000" } as any);
    expect(r.transient.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(r.transient.backoffMs).toBe(DEFAULT_CHAT_BASE_DELAY_MS);
  });

  test("boolean values → default", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
    const r = resolveRetrySettings({ maxAttempts: true, baseDelayMs: false } as any);
    expect(r.transient.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(r.transient.backoffMs).toBe(DEFAULT_CHAT_BASE_DELAY_MS);
  });

  test("null fields → default (not 0)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
    const r = resolveRetrySettings({ maxAttempts: null, baseDelayMs: null } as any);
    expect(r.transient.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(r.transient.backoffMs).toBe(DEFAULT_CHAT_BASE_DELAY_MS);
  });

  test("nested object / array → default", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
    const r = resolveRetrySettings({ maxAttempts: { n: 5 }, baseDelayMs: [1000] } as any);
    expect(r.transient.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(r.transient.backoffMs).toBe(DEFAULT_CHAT_BASE_DELAY_MS);
  });

  test("whole raw input as non-object → defaults", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
    expect(resolveRetrySettings("broken" as any)).toEqual({
      transient: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      stall: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      cycles: { maxRetries: 3, backoffMs: 0 },
    });
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
    expect(resolveRetrySettings(42 as any)).toEqual({
      transient: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      stall: { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: DEFAULT_CHAT_BASE_DELAY_MS },
      cycles: { maxRetries: 3, backoffMs: 0 },
    });
  });

  test("extra unknown keys are ignored", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
    const r = resolveRetrySettings({ maxAttempts: 5, hacker: "value" } as any);
    expect(r.transient.maxRetries).toBe(5);
    expect(r.transient.backoffMs).toBe(DEFAULT_CHAT_BASE_DELAY_MS);
  });

  test("does not throw on any of the above", () => {
    const hostile: unknown[] = [
      undefined,
      null,
      {},
      { maxAttempts: NaN },
      { baseDelayMs: Infinity },
      { maxAttempts: -1 },
      { maxAttempts: 10 ** 9, baseDelayMs: 10 ** 12 },
      { maxAttempts: "bad", baseDelayMs: null },
      { maxAttempts: {}, baseDelayMs: [] },
      "not-an-object",
      42,
      true,
      [],
    ];
    for (const input of hostile) {
      expect(() => {
        // biome-ignore lint/suspicious/noExplicitAny: hostile input
        const r = resolveRetrySettings(input as any);
        expect(Number.isFinite(r.transient.maxRetries)).toBe(true);
        expect(Number.isFinite(r.stall.maxRetries)).toBe(true);
        expect(Number.isFinite(r.transient.backoffMs)).toBe(true);
        expect(r.transient.maxRetries).toBeGreaterThanOrEqual(MIN_MAX_ATTEMPTS);
        expect(r.stall.maxRetries).toBeGreaterThanOrEqual(MIN_MAX_ATTEMPTS);
        expect(r.transient.backoffMs).toBeGreaterThanOrEqual(MIN_BASE_DELAY_MS);
        expect(r.transient.backoffMs).toBeLessThanOrEqual(MAX_BASE_DELAY_MS);
      }).not.toThrow();
    }
  });
});

describe("resolveRetrySettings — backoff math stays bounded", () => {
  test("worst-case exponential delay at maxRetries never overflows", () => {
    const { transient } = resolveRetrySettings({
      maxAttempts: 100,
      baseDelayMs: 10 ** 9,
    });
    const worstCase = transient.backoffMs * 2 ** 99;
    expect(Number.isFinite(worstCase)).toBe(true);
    expect(worstCase).toBeGreaterThan(0);
  });
});

describe("resolveRetrySettings — warns on invalid user input", () => {
  test("string maxAttempts logs a config warning", () => {
    // biome-ignore lint/suspicious/noExplicitAny: hostile input
    resolveRetrySettings({ maxAttempts: "5" } as any);
    const errors = useErrorStore.getState().errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.source).toBe("config");
    expect(errors[0]?.message).toContain("retry.maxAttempts");
    expect(errors[0]?.message).toContain("string");
  });

  test("NaN baseDelayMs logs a config warning", () => {
    resolveRetrySettings({ baseDelayMs: NaN });
    const errors = useErrorStore.getState().errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("retry.baseDelayMs");
  });

  test("warns once per key across repeated calls", () => {
    // biome-ignore lint/suspicious/noExplicitAny: hostile input
    resolveRetrySettings({ maxAttempts: "5" } as any);
    // biome-ignore lint/suspicious/noExplicitAny: hostile input
    resolveRetrySettings({ maxAttempts: "7" } as any);
    // biome-ignore lint/suspicious/noExplicitAny: hostile input
    resolveRetrySettings({ maxAttempts: true } as any);
    expect(useErrorStore.getState().errors).toHaveLength(1);
  });

  test("does not warn on undefined / missing fields", () => {
    resolveRetrySettings(undefined);
    resolveRetrySettings(null);
    resolveRetrySettings({});
    resolveRetrySettings({ maxAttempts: 5 });
    expect(useErrorStore.getState().errors).toHaveLength(0);
  });

  test("does not warn on valid-but-out-of-range numbers (clamped silently)", () => {
    resolveRetrySettings({ maxAttempts: 999, baseDelayMs: 999_999 });
    resolveRetrySettings({ maxAttempts: -5, baseDelayMs: 10 });
    expect(useErrorStore.getState().errors).toHaveLength(0);
  });
});
