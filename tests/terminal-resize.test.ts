import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setupTerminalResize, type ResizeAwareRenderer } from "../src/core/terminal/resize-handler.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockRenderer(initialW = 80, initialH = 24): ResizeAwareRenderer {
  return {
    terminalWidth: initialW,
    terminalHeight: initialH,
    resize: mock(),
    addInputHandler: mock(),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test-only stubs
let mockStdout: any;
// biome-ignore lint/suspicious/noExplicitAny: test-only stubs
let mockProcess: any;
// biome-ignore lint/suspicious/noExplicitAny: saved globals
let origProcess: any;
// biome-ignore lint/suspicious/noExplicitAny: saved globals
let origSetTimeout: any;
// biome-ignore lint/suspicious/noExplicitAny: saved globals
let origSetInterval: any;

// Captured timer callbacks — fired directly so tests stay deterministic
// without fake timers (which bun:test does not support).
let timeoutCb: (() => void) | null;
let intervalCb: (() => void) | null;

describe("setupTerminalResize", () => {
  beforeEach(() => {
    mockStdout = {
      isTTY: true,
      columns: 80,
      rows: 24,
      write: mock(),
      on: mock(),
      removeListener: mock(),
    };
    mockProcess = {
      ...process,
      stdout: mockStdout,
      on: mock(),
      removeListener: mock(),
    };

    origProcess = globalThis.process;
    // biome-ignore lint/suspicious/noExplicitAny: test-only process stub
    (globalThis as any).process = mockProcess;

    timeoutCb = null;
    intervalCb = null;
    origSetTimeout = globalThis.setTimeout;
    origSetInterval = globalThis.setInterval;
    // biome-ignore lint/suspicious/noExplicitAny: capture-only timer stubs
    (globalThis as any).setTimeout = (cb: () => void) => {
      timeoutCb = cb;
      return 0;
    };
    // biome-ignore lint/suspicious/noExplicitAny: capture-only timer stubs
    (globalThis as any).setInterval = (cb: () => void) => {
      intervalCb = cb;
      return { unref: () => {} };
    };
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restore globals
    (globalThis as any).process = origProcess;
    // biome-ignore lint/suspicious/noExplicitAny: restore globals
    (globalThis as any).setTimeout = origSetTimeout;
    // biome-ignore lint/suspicious/noExplicitAny: restore globals
    (globalThis as any).setInterval = origSetInterval;
  });

  test("enables DEC mode 2048 when stdout is a TTY", () => {
    const r = createMockRenderer();
    setupTerminalResize(r);
    expect(mockStdout.write).toHaveBeenCalledWith("\x1b[?2048h");
  });

  test("registers an input handler for CSI 48 resize reports", () => {
    const r = createMockRenderer();
    setupTerminalResize(r);
    expect(r.addInputHandler).toHaveBeenCalledTimes(1);
  });

  test("input handler parses CSI 48;rows;cols;t and calls resize", () => {
    const r = createMockRenderer();
    setupTerminalResize(r);

    // biome-ignore lint/suspicious/noExplicitAny: mock call introspection
    const handler = (r.addInputHandler as any).mock.calls[0][0];
    const consumed = handler("\x1b[48;50;120t");

    expect(consumed).toBe(true);
    expect(r.resize).toHaveBeenCalledWith(120, 50);
  });

  test("input handler ignores non-matching sequences", () => {
    const r = createMockRenderer();
    setupTerminalResize(r);

    // biome-ignore lint/suspicious/noExplicitAny: mock call introspection
    const handler = (r.addInputHandler as any).mock.calls[0][0];
    const consumed = handler("\x1b[1;2R");

    expect(consumed).toBe(false);
    expect(r.resize).not.toHaveBeenCalled();
  });

  test("resize event listener calls resize when dimensions changed", () => {
    const r = createMockRenderer(80, 24);
    setupTerminalResize(r);

    const onResize = mockStdout.on.mock.calls.find(
      (call: [string, () => void]) => call[0] === "resize",
    )?.[1];
    expect(onResize).toBeDefined();

    mockStdout.columns = 120;
    mockStdout.rows = 50;
    onResize?.();

    expect(r.resize).toHaveBeenCalledWith(120, 50);
  });

  test("resize event listener no-ops when dimensions unchanged", () => {
    const r = createMockRenderer(80, 24);
    setupTerminalResize(r);

    const onResize = mockStdout.on.mock.calls.find(
      (call: [string, () => void]) => call[0] === "resize",
    )?.[1];
    onResize?.();

    expect(r.resize).not.toHaveBeenCalled();
  });

  test("SIGWINCH handler calls resize after the delay when dims changed", () => {
    const r = createMockRenderer(80, 24);
    setupTerminalResize(r);

    const onSigwinch = mockProcess.on.mock.calls.find(
      (call: [string, () => void]) => call[0] === "SIGWINCH",
    )?.[1];
    expect(onSigwinch).toBeDefined();

    mockStdout.columns = 100;
    mockStdout.rows = 30;
    onSigwinch?.();

    // The handler defers via setTimeout — resize fires only once it runs.
    expect(r.resize).not.toHaveBeenCalled();
    timeoutCb?.();
    expect(r.resize).toHaveBeenCalledWith(100, 30);
  });

  test("poll fallback calls resize when dimensions changed", () => {
    const r = createMockRenderer(80, 24);
    setupTerminalResize(r);

    mockStdout.columns = 120;
    mockStdout.rows = 50;
    intervalCb?.();

    expect(r.resize).toHaveBeenCalledWith(120, 50);
  });

  test("poll fallback no-ops when dimensions unchanged", () => {
    const r = createMockRenderer(80, 24);
    setupTerminalResize(r);

    intervalCb?.();

    expect(r.resize).not.toHaveBeenCalled();
  });

  test("cleanup removes listeners and disables DEC mode 2048", () => {
    const r = createMockRenderer();
    const cleanup = setupTerminalResize(r);

    cleanup();

    expect(mockStdout.removeListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(mockProcess.removeListener).toHaveBeenCalledWith("SIGWINCH", expect.any(Function));
    expect(mockStdout.write).toHaveBeenCalledWith("\x1b[?2048l");
  });
});
