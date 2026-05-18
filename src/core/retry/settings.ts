import { logBackgroundError } from "../../stores/errors.js";
import type { RetryConfig } from "../../types/index.js";

/** Shared strategy shape: bounded retries with exponential backoff.
 *  Extracted so transient, stall, and cycles/full-chain-overflow all
 *  share the same `maxRetries + backoffMs` fields instead of repeating them. */
export interface RetryStrategy {
  /** Hard cap on retry attempts. 0 = no retries. */
  maxRetries: number;
  /** Base backoff delay in ms before the first retry. */
  backoffMs: number;
}

export const DEFAULT_AGENT_BASE_DELAY_MS = 2000;
export const DEFAULT_CHAT_BASE_DELAY_MS = 1000;
export const DEFAULT_MAX_RETRIES = 3;
export const MAX_FALLBACK_CYCLES_DEFAULT = 3;

export const MIN_MAX_ATTEMPTS = 1;
export const MIN_BASE_DELAY_MS = 250;
export const MAX_BASE_DELAY_MS = 60_000;

export interface ResolvedRetrySettings {
  transient: RetryStrategy;
  stall: RetryStrategy;
  cycles: RetryStrategy;
}

/**
 * Pure, defensive resolver for user-supplied retry config.
 * - Accepts `undefined`, `null`, or garbage inputs (strings, NaN, Infinity, negatives) without throwing.
 * - Clamps valid numbers into safe ranges; falls back to defaults for anything else.
 * - `maxAttempts` is kept as a back-compat default for both `maxTransientRetries`
 *   and `maxStallRetries` — the per-purpose fields take precedence when set.
 */
export function resolveRetrySettings(
  raw: RetryConfig | undefined | null,
  opts: { agent?: boolean } = {},
): ResolvedRetrySettings {
  const defaultBase = opts.agent ? DEFAULT_AGENT_BASE_DELAY_MS : DEFAULT_CHAT_BASE_DELAY_MS;
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;

  const legacyMaxAttempts = clampIntMin(
    obj?.maxAttempts,
    MIN_MAX_ATTEMPTS,
    DEFAULT_MAX_RETRIES,
    "retry.maxAttempts",
  );

  const maxTransientRetries = clampIntMin(
    obj?.maxTransientRetries,
    MIN_MAX_ATTEMPTS,
    legacyMaxAttempts,
    "retry.maxTransientRetries",
  );

  const maxStallRetries = clampIntMin(
    obj?.maxStallRetries,
    MIN_MAX_ATTEMPTS,
    legacyMaxAttempts,
    "retry.maxStallRetries",
  );

  const baseDelayMs = clampInt(
    obj?.baseDelayMs,
    MIN_BASE_DELAY_MS,
    MAX_BASE_DELAY_MS,
    defaultBase,
    "retry.baseDelayMs",
  );

  const maxFallbackCycles = clampIntMin(
    obj?.maxFallbackCycles,
    0,
    MAX_FALLBACK_CYCLES_DEFAULT,
    "retry.maxFallbackCycles",
  );

  return {
    transient: { maxRetries: maxTransientRetries, backoffMs: baseDelayMs },
    stall: { maxRetries: maxStallRetries, backoffMs: baseDelayMs },
    cycles: { maxRetries: maxFallbackCycles, backoffMs: 0 },
  };
}

const warnedKeys = new Set<string>();

function clampIntMin(value: unknown, min: number, fallback: number, key?: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (key && !warnedKeys.has(key)) {
      warnedKeys.add(key);
      logBackgroundError(
        "config",
        `${key}: expected a finite number, got ${typeof value === "object" ? JSON.stringify(value) : String(value)} (${typeof value}). Using default ${String(fallback)}.`,
      );
    }
    return fallback;
  }
  return Math.max(min, Math.round(value));
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  key?: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (key && !warnedKeys.has(key)) {
      warnedKeys.add(key);
      logBackgroundError(
        "config",
        `${key}: expected a finite number, got ${typeof value === "object" ? JSON.stringify(value) : String(value)} (${typeof value}). Using default ${String(fallback)}.`,
      );
    }
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Test-only: reset the once-per-process warning state. */
export function __resetRetryWarnings(): void {
  warnedKeys.clear();
}
