/**
 * Windows console mode helpers (bun:ffi → kernel32.dll).
 *
 * On Windows, when `ENABLE_PROCESSED_INPUT` is set on the console stdin
 * handle, Ctrl+C is delivered as a `CTRL_C_EVENT` to the console control
 * handler instead of arriving on stdin. Most TUIs need Ctrl+C in stdin
 * (e.g. to gate a single press as "clear prompt", double press as "exit").
 *
 * This module exposes three operations:
 *   - `disableProcessedInput()`  — one-shot clear, returns void.
 *   - `flushInputBuffer()`       — drop queued console events.
 *   - `installCtrlCGuard()`      — periodic re-enforcement (some Bun versions
 *                                  re-apply ENABLE_PROCESSED_INPUT on raw-mode
 *                                  toggles); returns an `unhook` function.
 *
 * No-op on every non-Windows platform, and gracefully no-op on Windows if
 * `bun:ffi` is unavailable or `kernel32.dll` fails to load (e.g. test runner).
 */

import { IS_WIN } from "./index.js";

const STD_INPUT_HANDLE = -10;
const ENABLE_PROCESSED_INPUT = 0x0001;

type Kernel32 = {
  symbols: {
    GetStdHandle: (handle: number) => unknown;
    GetConsoleMode: (handle: unknown, modePtr: unknown) => number;
    SetConsoleMode: (handle: unknown, mode: number) => number;
    FlushConsoleInputBuffer: (handle: unknown) => number;
  };
};

type FfiModule = {
  dlopen: (name: string, bindings: Record<string, { args: string[]; returns: string }>) => Kernel32;
  ptr: (buf: unknown) => unknown;
};

let _k32: Kernel32 | null | undefined;
let _ffi: FfiModule | null | undefined;

function load(): Kernel32 | null {
  if (_k32 !== undefined) return _k32;
  _k32 = null;
  if (!IS_WIN) return null;
  try {
    _ffi = require("bun:ffi") as FfiModule;
    _k32 = _ffi.dlopen("kernel32.dll", {
      GetStdHandle: { args: ["i32"], returns: "ptr" },
      GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
      SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
      FlushConsoleInputBuffer: { args: ["ptr"], returns: "i32" },
    });
    return _k32;
  } catch {
    _k32 = null;
    return null;
  }
}

/** Clear `ENABLE_PROCESSED_INPUT` on the console stdin handle. No-op off-Windows. */
export function disableProcessedInput(): void {
  if (!IS_WIN) return;
  if (!process.stdin.isTTY) return;
  const k32 = load();
  if (!k32 || !_ffi) return;
  const handle = k32.symbols.GetStdHandle(STD_INPUT_HANDLE);
  const buf = new Uint32Array(1);
  if (k32.symbols.GetConsoleMode(handle, _ffi.ptr(buf)) === 0) return;
  const mode = buf[0] ?? 0;
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return;
  k32.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT);
}

/** Drop any queued console input events (mouse, keypress). No-op off-Windows. */
export function flushInputBuffer(): void {
  if (!IS_WIN) return;
  if (!process.stdin.isTTY) return;
  const k32 = load();
  if (!k32) return;
  const handle = k32.symbols.GetStdHandle(STD_INPUT_HANDLE);
  k32.symbols.FlushConsoleInputBuffer(handle);
}

let _unhook: (() => void) | undefined;

/**
 * Keep `ENABLE_PROCESSED_INPUT` cleared for the lifetime of the TUI.
 *
 * The flag is console-global (not per-process) and various runtimes re-apply
 * it on raw-mode toggles or on a later tick. We:
 *   1. Wrap `process.stdin.setRawMode` to re-clear on every toggle.
 *   2. Run a 100ms poll as a backstop for native/external mode changes.
 *
 * Returns an `unhook` function that restores the original console mode and
 * stdin.setRawMode. Calling `installCtrlCGuard()` again returns the same
 * unhook (idempotent). No-op off-Windows or in non-TTY contexts.
 */
export function installCtrlCGuard(): (() => void) | undefined {
  if (!IS_WIN) return undefined;
  if (!process.stdin.isTTY) return undefined;
  if (_unhook) return _unhook;
  const k32 = load();
  if (!k32 || !_ffi) return undefined;

  const handle = k32.symbols.GetStdHandle(STD_INPUT_HANDLE);
  const buf = new Uint32Array(1);
  if (k32.symbols.GetConsoleMode(handle, _ffi.ptr(buf)) === 0) return undefined;
  const initial = buf[0] ?? 0;

  const enforce = (): void => {
    if (!_ffi) return;
    if (k32.symbols.GetConsoleMode(handle, _ffi.ptr(buf)) === 0) return;
    const mode = buf[0] ?? 0;
    if ((mode & ENABLE_PROCESSED_INPUT) === 0) return;
    k32.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT);
  };

  // Some runtimes re-apply console modes on the next tick; enforce twice.
  const later = (): void => {
    enforce();
    setImmediate(enforce);
  };

  type RawModeFn = (mode: boolean) => NodeJS.ReadStream;
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode: RawModeFn };
  const original: RawModeFn = stdin.setRawMode;
  let wrapped: RawModeFn | undefined;
  if (typeof original === "function") {
    wrapped = (mode: boolean) => {
      const result = original.call(stdin, mode);
      later();
      return result;
    };
    stdin.setRawMode = wrapped;
  }

  // Cover any earlier mode changes.
  later();

  const interval = setInterval(enforce, 100);
  interval.unref();

  let done = false;
  _unhook = () => {
    if (done) return;
    done = true;
    clearInterval(interval);
    if (wrapped && stdin.setRawMode === wrapped) {
      stdin.setRawMode = original;
    }
    k32.symbols.SetConsoleMode(handle, initial);
    _unhook = undefined;
  };
  return _unhook;
}
