import { basename } from "node:path";
import { MAX_TERMINALS, useTerminalStore } from "../../stores/terminals.js";
import { useUIStore } from "../../stores/ui.js";
import { IS_WIN } from "../platform/index.js";
import { trackBunProcess } from "../process-tracker.js";

interface TerminalSpawnResult {
  success: boolean;
  id: number;
  error?: string;
}

interface PtyHandle {
  proc: ReturnType<typeof Bun.spawn>;
  chunks: Uint8Array[];
  totalBytes: number;
}

const handles = new Map<number, PtyHandle>();

type DataListener = (id: number) => void;
const dataListeners = new Set<DataListener>();
let notifyScheduled = false;
let pendingIds = new Set<number>();

export function onTerminalData(cb: DataListener): () => void {
  dataListeners.add(cb);
  return () => dataListeners.delete(cb);
}

function scheduleNotify(id: number): void {
  pendingIds.add(id);
  if (notifyScheduled) return;
  notifyScheduled = true;
  setTimeout(() => {
    notifyScheduled = false;
    const ids = pendingIds;
    pendingIds = new Set();
    for (const cb of dataListeners) {
      for (const tid of ids) cb(tid);
    }
  }, 16);
}

export function spawnTerminal(cwd?: string, cols = 80, rows = 24): TerminalSpawnResult {
  const store = useTerminalStore.getState();
  if (store.terminals.length >= MAX_TERMINALS) {
    return { success: false, id: -1, error: `Maximum ${String(MAX_TERMINALS)} terminals reached` };
  }

  const effectiveCwd = cwd ?? process.cwd();
  // Windows has no $SHELL; honour $COMSPEC then fall back to cmd.exe.
  // POSIX honours $SHELL then /bin/bash.
  const shell = IS_WIN ? (process.env.COMSPEC ?? "cmd.exe") : (process.env.SHELL ?? "/bin/bash");

  const handle: PtyHandle = {
    proc: null as unknown as PtyHandle["proc"],
    chunks: [],
    totalBytes: 0,
  };

  let termId = -1;

  const proc = Bun.spawn([shell], {
    cwd: effectiveCwd,
    terminal: {
      cols,
      rows,
      data(_term, data) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        handle.chunks.push(copy);
        handle.totalBytes += data.byteLength;
        // Keep only last ~16KB to prevent scrollback blowout.
        // The VT emulator re-parses from scratch each render, so
        // keeping a small window means it only sees recent output
        // (the active viewport). Programs using alternate screen
        // (less, vim, htop) reset the buffer on exit anyway.
        while (handle.totalBytes > 16_384 && handle.chunks.length > 1) {
          const dropped = handle.chunks.shift();
          if (dropped) handle.totalBytes -= dropped.byteLength;
        }
        scheduleNotify(termId);
      },
    },
  });

  handle.proc = proc;

  termId = store.addTerminal({
    label: basename(shell),
    cwd: effectiveCwd,
    active: true,
    pid: proc.pid ?? null,
  });

  handles.set(termId, handle);
  trackBunProcess(proc);

  proc.exited.then(() => {
    handles.delete(termId);
    const store = useTerminalStore.getState();
    const wasSelected = store.selectedId === termId;
    store.removeTerminal(termId);
    if (wasSelected || useTerminalStore.getState().terminals.length === 0) {
      useUIStore.getState().closeModal("floatingTerminal");
    }
    scheduleNotify(termId);
  });

  return { success: true, id: termId };
}

export function writeToTerminal(id: number, data: string): void {
  const handle = handles.get(id);
  if (!handle) return;
  handle.proc.terminal?.write(data);
}

export function resizeTerminal(id: number, cols: number, rows: number): void {
  const handle = handles.get(id);
  if (!handle) return;
  handle.proc.terminal?.resize(cols, rows);
}

export function getTerminalBuffer(id: number): Uint8Array {
  const handle = handles.get(id);
  if (!handle || handle.chunks.length === 0) return new Uint8Array(0);
  if (handle.chunks.length === 1) return handle.chunks[0] as Uint8Array;
  const combined = new Uint8Array(handle.totalBytes);
  let offset = 0;
  for (const chunk of handle.chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export function closeTerminal(id: number): void {
  const handle = handles.get(id);
  if (handle) {
    try {
      handle.proc.kill();
    } catch {
      // already dead
    }
    handles.delete(id);
  }
  useTerminalStore.getState().removeTerminal(id);
}

export function getTerminalStats(): {
  count: number;
  activeCount: number;
  totalBufferBytes: number;
} {
  let totalBufferBytes = 0;
  let activeCount = 0;
  for (const [, handle] of handles) {
    totalBufferBytes += handle.totalBytes;
    if (!handle.proc.killed) activeCount++;
  }
  return { count: handles.size, activeCount, totalBufferBytes };
}

export function closeAllTerminals(): void {
  for (const [, handle] of handles) {
    try {
      handle.proc.kill();
    } catch {
      // already dead
    }
  }
  handles.clear();
  const store = useTerminalStore.getState();
  for (const t of [...store.terminals]) {
    store.removeTerminal(t.id);
  }
}
