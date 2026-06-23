/**
 * Terminal resize handling for the CLI renderer.
 *
 * Sets up multiple redundant mechanisms to detect terminal size changes:
 * 1. DEC mode 2048 in-band resize notifications (primary)
 * 2. process.stdout "resize" event (catches runtime-updated dims)
 * 3. Delayed SIGWINCH handler (catches stale-dim races)
 * 4. 1s polling fallback (for terminals without mode 2048)
 */

export interface ResizeAwareRenderer {
  terminalWidth: number;
  terminalHeight: number;
  resize(cols: number, rows: number): void;
  addInputHandler(handler: (sequence: string) => boolean): void;
}

export function setupTerminalResize(r: ResizeAwareRenderer): () => void {
  // Primary: DEC mode 2048 in-band resize notifications
  r.addInputHandler((sequence: string) => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC required to match the CSI resize report
    const m = sequence.match(/^\x1b\[48;(\d+);(\d+)(?:;\d+;\d+)?t$/);
    if (!m?.[1] || !m[2]) return false;
    const rows = Number.parseInt(m[1], 10);
    const cols = Number.parseInt(m[2], 10);
    if (rows > 0 && cols > 0) r.resize(cols, rows);
    return true;
  });

  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?2048h");
  }

  // Secondary: process.stdout "resize" event fires after dims are refreshed
  const onResize = () => {
    const cols = process.stdout.columns;
    const rows = process.stdout.rows;
    if (!cols || !rows) return;
    if (cols !== r.terminalWidth || rows !== r.terminalHeight) {
      r.resize(cols, rows);
    }
  };
  process.stdout.on("resize", onResize);

  // Belt-and-suspenders: SIGWINCH can race with the runtime's TTY dimension
  // update. Give Bun/Node a few ms to refresh process.stdout.columns/rows
  // before driving the renderer.
  const onSigwinch = () => {
    setTimeout(() => {
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      if (!cols || !rows) return;
      if (cols !== r.terminalWidth || rows !== r.terminalHeight) {
        r.resize(cols, rows);
      }
    }, 50);
  };
  process.on("SIGWINCH", onSigwinch);

  // Fallback: 1s watchdog for terminals without mode 2048. A last resort behind
  // three event-driven mechanisms, so a relaxed interval keeps wakeups cheap.
  const resizePoll = setInterval(() => {
    try {
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      if (!cols || !rows) return;
      if (cols !== r.terminalWidth || rows !== r.terminalHeight) {
        r.resize(cols, rows);
      }
    } catch {}
  }, 1000);
  resizePoll.unref?.();

  // Cleanup
  return () => {
    process.stdout.removeListener("resize", onResize);
    process.removeListener("SIGWINCH", onSigwinch);
    clearInterval(resizePoll);
    if (process.stdout.isTTY) {
      try {
        process.stdout.write("\x1b[?2048l");
      } catch {}
    }
  };
}
