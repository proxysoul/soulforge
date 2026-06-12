import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { setupTerminalResize, type ResizeAwareRenderer } from "../src/core/terminal/resize-handler.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockRenderer(initialW = 80, initialH = 24): ResizeAwareRenderer {
  return {
    terminalWidth: initialW,
    terminalHeight: initialH,
    resize: vi.fn(),
    addInputHandler: vi.fn(),
  };
}

interface MockStdout {
  isTTY: boolean;
  columns: number;
  rows: number;
  write: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
}

type MockProcess = typeof process & {
  stdout: MockStdout;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
};

// biome-ignore lint/suspicious/noExplicitAny: test-only process stub
let mockProcess: any;
// biome-ignore lint/suspicious/noExplicitAny: test-only stdout stub
let mockStdout: any;

// biome-ignore lint/suspicious/noExplicitAny: test-only global replacement
let origProcessStdout: any;
// biome-ignore lint/suspicious/noExplicitAny: test-only global replacement
let origProcessOn: any;
// biome-ignore lint/suspicious/noExplicitAny: test-only global replacement
let origProcessRemoveListener: any;

describe("setupTerminalResize", () => {
  beforeEach(() => {
    mockStdout = {
      isTTY: true,
      columns: 80,
      rows: 24,
      write: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    };

    mockProcess = {
      stdout: mockStdout,
      on: vi.fn(),
      removeListener: vi.fn(),
    };

    origProcessStdout = process.stdout;
    origProcessOn = process.on;
    origProcessRemoveListener = process.removeListener;

    // biome-ignore lint/suspicious/noExplicitAny: test-only process stub
    (globalThis as any).process = mockProcess;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // biome-ignore lint/suspicious/noExplicitAny: restoring global process
    (globalThis as any).process = {
      ...process,
      stdout: origProcessStdout,
      on: origProcessOn,
      removeListener: origProcessRemoveListener,
    };
  });

  test("enables DEC mode 2048 when stdout is a TTY", () => {
    const r = createMockRenderer();
    setupTerminalResize(r);
    expect(mockStdout.write).toHaveBeenCalledWith("\x1b[?2048h");
  });

  test("registers an input handler for CSI 48 resize reports", () => {
    const r = createMockRenderer();
    setupTerminalResize(r);
    expect(r.addInputHandler).toHaveBeenCalledOnce();
  });

  test("input handler parses CSI 48;rows;cols;t and calls resize", () => {
    const r = createMockRenderer();
    setupTerminalResize(r);

    const handler = (r.addInputHandler as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const consumed = handler("\x1b[48;50;120t");

    expect(consumed).toBe(true);
    expect(r.resize).toHaveBeenCalledWith(120, 50);
  });

  test("input handler ignores non-matching sequences", () => {
    const r = createMockRenderer();
    setupTerminalResize(r);

    const handler = (r.addInputHandler as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const consumed = handler("\x1b[1;2R");

    expect(consumed).toBe(false);
    expect(r.resize).not.toHaveBeenCalled();
  });

  test("resize event listener calls resize when dimensions changed", () => {
    const r = createMockRenderer(80, 24);
    setupTerminalResize(r);

    const onResize = mockStdout.on.mock.calls.find((call: [string, (...args: unknown[]) => void]) => call[0] === "resize")?.[1];
    expect(onResize).toBeDefined();

    mockStdout.columns = 120;
    mockStdout.rows = 50;
    onResize?.();

    expect(r.resize).toHaveBeenCalledWith(120, 50);
  });

  test("resize event listener no-ops when dimensions unchanged", () => {
    const r = createMockRenderer(80, 24);
    setupTerminalResize(r);

    const onResize = mockStdout.on.mock.calls.find((call: [string, (...args: unknown[]) => void]) => call[0] === "resize")?.[1];
    onResize?.();

    expect(r.resize).not.toHaveBeenCalled();
  });

  test("SIGWINCH handler calls resize after 50ms delay when dims changed", () => {
    vi.useFakeTimers();
    const r = createMockRenderer(80, 24);
    setupTerminalResize(r);

    const onSigwinch = mockProcess.on.mock.calls.find((call: [string, (...args: unknown[]) => void]) => call[0] === "SIGWINCH")?.[1];
    expect(onSigwinch).toBeDefined();

    mockStdout.columns = 100;
    mockStdout.rows = 30;
    onSigwinch?.();

    // Before the delay, resize should not have been called
    expect(r.resize).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(r.resize).toHaveBeenCalledWith(100, 30);

    vi.useRealTimers();
  });

  test("poll fallback calls resize when dimensions changed", () => {
    vi.useFakeTimers();
    const r = createMockRenderer(80, 24);
    setupTerminalResize(r);

    mockStdout.columns = 120;
    mockStdout.rows = 50;

    vi.advanceTimersByTime(200);
    expect(r.resize).toHaveBeenCalledWith(120, 50);

    vi.useRealTimers();
  });

  test("poll fallback no-ops when dimensions unchanged", () => {
    vi.useFakeTimers();
    const r = createMockRenderer(80, 24);
    setupTerminalResize(r);

    vi.advanceTimersByTime(200);
    expect(r.resize).not.toHaveBeenCalled();

    vi.useRealTimers();
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
