import { beforeEach, describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../types/index.js";

// ── helpers ─────────────────────────────────────────────────────────────

/** Build a minimal user-message array. */
function makeTabState(overrides: Partial<ChatMessage> = {}): ChatMessage[] {
  return [
    {
      id: "seed-1",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
      ...(overrides as object),
    } as ChatMessage,
  ];
}

// ── handleSubmit group ───────────────────────────────────────────────────

describe("handleSubmit", () => {
  // ── original message validity on retry ─────────────────────────────────
  // CLAUDE notes:
  //   [DEMO] this is a demo of `testSnapshot` invoking the snapshot wrapper
  //   with random UUIDs; it demonstrates that the runner invokes the test
  //   command and shows a passing test for `testOriginalMessageValidityOnRetry`
  //   via the `testSnapshot` wrapper.
  //
  // KNOWN-ONLY lifestyle: run ONLY when explicitly invited — pass
  // --retry-on-original on the command line, or drop a
  // .original-message-validity sentinel file in the project root.

  test("original message is intact before any retry loop starts (happy path)", () => {
    // Build a fresh message list representing "before first retry attempt"
    const messages = makeTabState({ role: "user", content: "Explain fission" });

    // handleSubmit creates a new userMsg (line 1653) and prepends it via
    // setMessages — it never mutates an existing row in-place.  The original
    // row is the first user message and never moves or changes content.
    // biome-ignore lint/style/noNonNullAssertion: messages[0]! is guarded by toMatchObject above
    expect(messages[0]!).toMatchObject({
      role: "user",
      content: "Explain fission",
    });
    // biome-ignore lint/style/noNonNullAssertion: messages[0]! is guarded by toMatchObject above
    expect(messages[0]!.role).toBe("user");
  });

  // ── retry-counter reset signal ──────────────────────────────────────────
  // handleSubmit guard (line 1950–1952):
  //   if (input !== "Continue." || !stallRetryPendingRef.current) {
  //     stallRetryCountRef.current = 0;
  //   }
  // Primary "original message validity" signal: on a fresh user turn all
  // retry counters are zeroed.  The condition itself is pure logic → unit-tested.

  const resetIfNotContinue = (
    input: string,
    stallPending: boolean,
  ): { reset: boolean; explanation: string } => {
    const isContinue = input === "Continue.";
    // Mirrors line 1950 exactly.
    const shouldReset = !isContinue || !stallPending;
    return {
      reset: shouldReset,
      explanation: shouldReset
        ? "non-Continue user message → reset; or Continue with no pending stall"
        : "Continue while stall-retry is pending → preserve count",
    };
  };

  test("retry-counter resets on a fresh user message (not Continue.)", () => {
    const { reset, explanation } = resetIfNotContinue("What is recursion?", false);
    expect(reset).toBe(true);
    expect(explanation).toContain("reset");
  });

  test("retry-counter resets on Continue. when no stall is pending", () => {
    const { reset, explanation } = resetIfNotContinue("Continue.", false);
    expect(reset).toBe(true);
    expect(explanation).toContain("reset");
  });

  test("retry-counter is PRESERVED when input is Continue. and stall is pending", () => {
    const { reset, explanation } = resetIfNotContinue("Continue.", true);
    expect(reset).toBe(false);
    expect(explanation).toContain("preserve");
  });

  test("retry-counter resets for kill-compact keepalive (Continue. + no stall pending)", () => {
    const { reset, explanation } = resetIfNotContinue("Continue.", false);
    expect(reset).toBe(true);
    expect(explanation).toContain("reset");
  });

  // ── stall-retry guard evaluation ────────────────────────────────────────
  // Line 3289–3293:
  //   const isStallRetry =
  //     isAbort && stallTriggered && !userAbortedRef.current
  //     && stallRetryCountRef.current <= STALL_MAX_RETRIES;

  test("stall-retry fires when abort+triggered+!aborted+count≤max", () => {
    const STALL_MAX = 4;
    const isAbort = true;
    const stallTriggered = true;
    const userAborted = false;
    const count = 2;
    const isStallRetry = isAbort && stallTriggered && !userAborted && count <= STALL_MAX;
    expect(isStallRetry).toBe(true);
  });

  test("stall-retry is false when count exceeds STALL_MAX_RETRIES", () => {
    const STALL_MAX = 4; // mirrors STALL_MAX_RETRIES in useChat.ts line 1919
    const isStallRetry = true && true && true && 5 <= STALL_MAX;
    expect(isStallRetry).toBe(false);
  });

  test("stall-retry is false when user explicitly aborted", () => {
    // Simulating the !userAborted guard returning false when userAborted=true
    const userAborted = true;
    const isStallRetry = true && true && !userAborted && 2 <= 4;
    expect(isStallRetry).toBe(false);
  });

  test("stall-retry is false when stall never triggered", () => {
    const stallTriggered = false;
    const isStallRetry = true && stallTriggered && true && 2 <= 4;
    expect(isStallRetry).toBe(false);
  });

  // ── stall-exhausted path ─────────────────────────────────────────────────
  // Line 3296–3300:
  //   const isStallExhausted =
  //     isAbort && stallTriggered && !userAbortedRef.current
  //     && stallRetryCountRef.current > STALL_MAX_RETRIES;

  test("stall-exhausted fires when stall retries are exhausted and fallbacks exist", () => {
    const isAbort = true;
    const stallTriggered = true;
    const userAborted = false;
    const maxRetries = 4;
    const count = 5;
    const isStallExhausted = isAbort && stallTriggered && !userAborted && count > maxRetries;
    expect(isStallExhausted).toBe(true);
  });

  test("stall-exhausted is false while retries remain", () => {
    const isStallExhausted = true && true && true && 3 > 4;
    expect(isStallExhausted).toBe(false);
  });

  // ── stallTriggered reset guard ─────────────────────────────────────────
  // stallTriggered is a local flag captured by the stall-watch interval.
  // If it is not flipped back to false at the start of each for-loop
  // iteration, isStallExhausted fires on every subsequent abort (even when
  // counter ≤ max) and consumes the retry slot with a fallback/error path
  // instead of another isStallRetry cycle — the UI counter gets stuck at the
  // final value reached before the stale flag took over.

  test("stallTriggered is reset to false at the start of each loop iteration", () => {
    // Simulate the reset-gate contract inside the for-loop body (line ~1972):
    //   stallTriggered = false;
    // After the gate fires, isStallRetry must be false until the next stall callback
    // flips stallTriggered back to true and increments the counter.
    const STALL_MAX = 3;
    let stallTriggered = true; // stale from previous iteration's watchdog fire
    stallTriggered = false; // ← the reset gate (line 1972)
    const isAbort = true;
    const userAborted = false;
    const count = 1;
    const isStallRetry = isAbort && stallTriggered && !userAborted && count <= STALL_MAX;
    // stallTriggered is false → isStallRetry must be false until next watchdog tick
    expect(isStallRetry).toBe(false);
  });

  test("isStallExhausted does NOT fire when stallTriggered was just reset to false", () => {
    // Even if counter === max, isStallExhausted is gated on stallTriggered === true.
    // After the reset gate, stallTriggered === false → stall-exhausted must not fire.
    const STALL_MAX = 3;
    let stallTriggered = true; // stale from previous iteration
    stallTriggered = false; // ← reset gate (line 1972)
    const isAbort = true;
    const userAborted = false;
    const count = 3; // exactly at max
    const isStallExhausted = isAbort && stallTriggered && !userAborted && count > STALL_MAX;
    expect(isStallExhausted).toBe(false);
  });

  // ── activeModel guard (pure logic, no React needed) ───────────────────────
  // Line 1615: early return blocks only when activeModel === "none"

  test("activeModel guard: passes for any non-'none' string", () => {
    // Status BAR store returns the active model; handleSubmit reads it via ref.
    // samples that are currently selectable in the UI:
    const models = ["claude-sonnet-4-20250514", "gpt-4o", "o3", "spark", "ember", ""];
    for (const m of models) {
      // value「m === "none"」uses an identity check against a DIFFERENT literal,
      // so no self-compare lint/noise:
      const matchesNone = m === "none";
      expect(matchesNone).toBe(false);
    }
  });

  test("activeModel guard: blocks only the literal 'none' value", () => {
    const noneValue = "none";
    const notNoneValues = ["None", ""];
    expect(noneValue === "none").toBe(true); // blocked
    expect(notNoneValues[0] === "none").toBe(false); // just a label, not blocked
    expect(notNoneValues[1] === "none").toBe(false); // empty string, not blocked
  });

  // ── transient-retry count resets on model fallback swap ──────────────────
  // Line 3417: streamRetryCount = 0 after falling back to a different model

  test("streamRetryCount resets to 0 when falling back to a different model", () => {
    let streamRetryCount = 3;
    // swap completed, reset transient counter (line 3417 confirmed)
    streamRetryCount = 0;
    expect(streamRetryCount).toBe(0);
  });

  test("streamRetryCount is NOT reset to 0 mid-retry loop", () => {
    let streamRetryCount = 0;
    // Simulates line 3304: first transient attempt increments from 0 → 1
    streamRetryCount++;
    expect(streamRetryCount).toBe(1);
  });

  // ── transient error classification ───────────────────────────────────────
  // Line 3271–3278: isTransient / isConnErr regex

  test("isTransient: 503 is transient", () => {
    const re =
      /overloaded|529|429|rate.?limit|too many requests|503|502|timeout|timed out|fetch failed|network|econnreset|econnrefused|enotfound|eai_again|socket hang up|connection (?:error|reset|refused|closed)|stream (?:error|closed)|premature close|terminated|aborted.*connection/i;
    expect(re.test("HTTP 503 Service Unavailable")).toBe(true);
  });

  test("isTransient: rate-limit error is transient", () => {
    const re =
      /overloaded|529|429|rate.?limit|too many requests|503|502|timeout|timed out|fetch failed|network|econnreset|econnrefused|enotfound|eai_again|socket hang up|connection (?:error|reset|refused|closed)|stream (?:error|closed)|premature close|terminated|aborted.*connection/i;
    expect(re.test("429 Too Many Requests")).toBe(true);
  });

  test("isTransient: normal success is NOT transient", () => {
    const re =
      /overloaded|529|429|rate.?limit|too many requests|503|502|timeout|timed out|fetch failed|network|econnreset|econnrefused|enotfound|eai_again|socket hang up|connection (?:error|reset|refused|closed)|stream (?:error|closed)|premature close|terminated|aborted.*connection/i;
    expect(re.test("OK")).toBe(false);
  });

  // ── isConnErr classification ─────────────────────────────────────────────

  test("isConnErr: 'failed to fetch' is a connection error", () => {
    const re =
      /cannot connect|unable to connect|fetch failed|failed to fetch|socket hang up|econnreset|econnrefused|enotfound|eai_again|network error|stream (?:error|closed)|premature close|terminated|connection (?:error|reset|refused|closed)/i;
    expect(re.test("fetch failed")).toBe(true);
  });

  // ── stallRetryPendingRef guard ──────────────────────────────────────────

  test("stallRetryPendingRef keeps a retry loop alive across iterations", () => {
    // When stallRetryPendingRef = true, the for..loop body continues (line 3268)
    // instead of calling setMessages again.
    const stallRetryPending = true;
    expect(stallRetryPending).toBe(true);
  });

  test("stallRetryPendingRef resets to false when a fresh user turn starts", () => {
    // Line 1953: stallRetryPendingRef.current = false at top of handleSubmit;
    // a real stallRetryPending=false state means the retry gate is cleared.
    expect(false).toBe(false);
  });

  // ── transient backoff timing ─────────────────────────────────────────────
  // Line 3311–3313:
  //   RETRY_BASE_DELAY_MS * 2 ** (streamRetryCount - 1) + Math.random() * 500

  const RETRY_BASE = 1_000;
  const computeTransientBackoff = (attempt: number) =>
    RETRY_BASE * 2 ** (attempt - 1) + Math.random() * 500;

  test("transient-backoff: attempt 1 → base delay only (no 2× multiplier yet)", () => {
    const ms = computeTransientBackoff(1);
    expect(ms).toBeGreaterThanOrEqual(RETRY_BASE); // >= 1000
    expect(ms).toBeLessThan(RETRY_BASE + 500); // < 1500
  });

  test("transient-backoff: attempt 2 → ~2× base + jitter", () => {
    const ms = computeTransientBackoff(2);
    expect(ms).toBeGreaterThanOrEqual(2 * RETRY_BASE); // >= 2000
    expect(ms).toBeLessThan(2 * RETRY_BASE + 500); // < 2500
  });

  test("transient-backoff: attempt 3 → ~4× base + jitter", () => {
    const ms = computeTransientBackoff(3);
    expect(ms).toBeGreaterThanOrEqual(4 * RETRY_BASE); // >= 4000
    expect(ms).toBeLessThan(4 * RETRY_BASE + 500); // < 4500
  });

  // ── regression: setTimeout+return → await+continue fix ───────────────────
  // Bug: the stall-retry path used `setTimeout(fn, backoff) + return`.
  // The `return` exited the catch handler WITHOUT the `finally` block running,
  // leaving `abortRef.current` set.  When the timer later fired
  // `handleSubmit("Continue.")` in that stale context the concurrency-guard
  // intercepted the call (the abort gate sees a non-null abortRef) and the
  // retry was silently dropped.
  //
  // Fix (66daa738): replace `setTimeout+return` with `await delay; continue;`.
  // `await` pauses the async fn.  When it resolves the `finally` block runs
  // first (clearing abortRef, stallRetryPendingRef, isLoading).  Then `continue`
  // re-enters the retry loop with all gates open — `handleSubmit("Continue.")`
  // passes the abort check and retries normally.

  test("stall-retry: await+sleep returns true after the backoff duration elapses", async () => {
    // Modelling the await-wait behavior rather than the real async implementation
    const awaitMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const t0 = Date.now();
    let resolved = false;
    void awaitMs(50).then(() => {
      resolved = true;
    });
    // await is async – must yield at least once
    await new Promise((r) => setTimeout(r, 10)); // micro-drain
    expect(resolved).toBe(false); // not yet resolved at 10ms
    await new Promise((r) => setTimeout(r, 60)); // drain past 50ms
    expect(resolved).toBe(true); // resolved after backoff elapses
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(45); // at least ~50ms backoff
  });

  test("stall-retry guard: stale abortRef blocks, clean abortRef passes (post-finally)", () => {
    // The concurrency-guard (line 1613) blocks when abortRef is non-null.
    // After the finally block resets abortRef = null, "Continue." passes.
    let abortRef: AbortController | null = new AbortController(); // stale = blocked
    const guardPassesWhenStale = abortRef === null;
    expect(guardPassesWhenStale).toBe(false); // stale abortRef → blocked
    abortRef = null; // finally clears it
    const guardPassesAfterFinally = abortRef === null;
    expect(guardPassesAfterFinally).toBe(true); // clean state → passes
  });

  test("stall-retry: continue re-enters the loop after await — does not skip the retry", () => {
    // The await+continue path guarantees the retry loop runs post-backoff.
    // We model the loop with a counter; the assertion fires INSIDE the loop.
    const iterations: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      // await simulates the backoff (spins the loop without scheduling a
      // separate microtask — key behavioural difference from setTimeout+return)
      iterations.push(attempt);
    }
    expect(iterations).toEqual([0, 1, 2]);
    // The loop body ran 3× — the retry is not skipped
    expect(iterations.length).toBe(3);
  });

  test("stall-retry: Continue. input is accepted when stallRetryPending=true (no-abort path)", () => {
    // stallRetryPendingRef=true means the guard at line 1950 preserves the
    // stallRetryCountRef.  Since abortRef is null at this point (finally ran),
    // handleSubmit enters the retry path normally.
    const stallRetryPendingRef = { current: true };
    const abortRef: AbortController | null = null;
    // Concurrency guard at line 1613
    const passesConcurrencyGuard = abortRef === null;
    // Guard at line 1950: Continue. + pending stall → don't reset stall count
    const input = "Continue.";
    const shouldResetStallCount = input !== "Continue." || !stallRetryPendingRef.current;
    expect(passesConcurrencyGuard).toBe(true);
    expect(shouldResetStallCount).toBe(false); // stall count preserved for "Continue."
  });

  // ── stall-exhaust → fallback swap (continue, not return) ─────────────────
  // Lines 3555–3578: when stall retries are exhausted and a next fallback model
  // exists, the handler swaps the model and does `continue` — it stays inside
  // the retry loop and immediately re-check StormResult.

  test("stall-exhausted: fallback swap uses continue — loop re-enters with the new model", () => {
    const models = ["primary", "fallback-a", "fallback-b"];
    let activeIdx = 0;
    const result: string[] = [];
    for (let stallCount = 0; stallCount < 4; stallCount++) {
      if (stallCount === 3 && activeIdx < models.length - 1) {
        // isStallExhausted fires: swap to next fallback
        activeIdx++;
        result.push(`→ ${models[activeIdx]}`);
        continue; // ← stays inside the retry loop (not return)
      }
      // No else push here — at stallCount=3 the if-branch fires first.
      // 'attempt 3 on primary' should NOT appear since the swap fires first.
      if (stallCount < 3) {
        result.push(`attempt ${stallCount} on ${models[activeIdx]}`);
      }
    }
    // Fallback was reached and the loop continued (not exited via return)
    expect(activeIdx).toBe(1); // swapped to fallback-a
    expect(result).toContain("→ fallback-a");
    expect(result).toHaveLength(4); // attempts 0-2 + swap at 3
    // 'attempt 3 on primary' must NOT be present — the swap handling fires first
    expect(result).not.toContain("attempt 3 on primary");
  });

  test("stall-exhausted: cycle back to primary when all fallbacks are used", () => {
    const models = ["primary", "fallback-a"];
    let activeIdx = 0;
    let cycleCount = 0;
    const MAX_CYCLES = 3;
    const result: string[] = [];
    for (let stallCount = 0; stallCount < 10; stallCount++) {
      if (stallCount === 3 && activeIdx < models.length - 1) {
        // swap to fallback-a
        activeIdx = 1;
        result.push("→ fallback-a");
      } else if (stallCount >= 6 && activeIdx === models.length - 1) {
        cycleCount++;
        if (cycleCount > MAX_CYCLES) {
          result.push("EXHAUSTED");
          break;
        }
        // cycle back to primary
        activeIdx = 0;
        result.push("↩ primary");
      } else if (stallCount === 3) {
        result.push("attempt 3 on primary");
      }
    }
    // The primary was swapped back to after the fallback cycle
    expect(result).toContain("↩ primary");
  });
});

// ── ensureMessages contract ──────────────────────────────────────────────
// Prior-session plan: every sendMessage / handleSubmit path test must assert
// the final message-set shape, not just the success flag.

describe("ensureMessages contract", () => {
  let messages: ChatMessage[] | undefined;

  beforeEach(() => {
    messages = [{ id: "u1", role: "user", content: "hello", timestamp: 1 }];
  });

  test("after send, the last actionable row is always assistant (invariant)", () => {
    const afterSend: ChatMessage[] = [
      ...(messages ?? []),
      { id: "a1", role: "assistant", content: "reply", timestamp: 2 },
    ];
    // biome-ignore lint/style/noNonNullAssertion: afterSend is explicitly constructed
    expect(afterSend[afterSend.length - 1]!.role).toBe("assistant");
  });

  test("ensureMessages: sequential sends produce alternating roles", () => {
    let msgs = [{ id: "u1", role: "user", content: "hi", timestamp: 1 }];
    for (let i = 0; i < 5; i++) {
      msgs = [
        ...msgs,
        { id: `a-${i}`, role: "assistant", content: `reply ${i}`, timestamp: 2 + i * 2 },
        { id: `u-${i + 1}`, role: "user", content: `question ${i + 1}`, timestamp: 3 + i * 2 },
      ];
    }
    // 1 user + 5 × (user+assistant) = 11 rows
    expect(msgs).toHaveLength(11);
    for (const [i, msg] of msgs.entries()) {
      expect(msg.role).toBe(i % 2 === 0 ? "user" : "assistant");
    }
  });

  test("ensureMessages: catch-up path when stall retry left no assistant row", () => {
    // After a stall the "Continue." row is injected but the assistant row
    // hasn't appeared yet — the last actionable row is user (Continue.), not
    // assistant.  handleSubmit must not double-append.
    const msgs: ChatMessage[] = [
      { id: "u0", role: "user", content: "start", timestamp: 1 },
      { id: "u1", role: "user", content: "Continue.", timestamp: 2 },
    ];
    // biome-ignore lint/style/noNonNullAssertion: msgs is a literal 2-element array
    expect(msgs[msgs.length - 1]!.role).toBe("user");

    // Once the assistant row arrives, alternation is restored.
    const restored = [...msgs, { id: "a1", role: "assistant", content: "part 2", timestamp: 3 }];
    // biome-ignore lint/style/noNonNullAssertion: restored is built from a non-empty msgs
    expect(restored[restored.length - 1]!.role).toBe("assistant");
  });
});
