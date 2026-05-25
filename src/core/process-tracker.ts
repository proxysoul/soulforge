import type { ChildProcess } from "node:child_process";
import { IS_WIN, killTree } from "./platform/index.js";

const tracked = new Set<ChildProcess>();

/** Track a node child_process — auto-removed on exit. */
export function trackProcess(proc: ChildProcess): void {
  tracked.add(proc);
  proc.on("exit", () => tracked.delete(proc));
}

interface BunSubprocess {
  readonly pid: number;
  readonly exited: Promise<unknown>;
  /** Bun.Subprocess.kill accepts a signal name string OR numeric signal. */
  kill(signal?: NodeJS.Signals | number): void;
}

const trackedBun = new Set<BunSubprocess>();

/** Track a Bun.spawn subprocess — auto-removed on exit. */
export function trackBunProcess(proc: BunSubprocess): void {
  trackedBun.add(proc);
  proc.exited.then(() => trackedBun.delete(proc)).catch(() => trackedBun.delete(proc));
}

export function killAllTracked(): void {
  // SIGTERM all node child processes — kill process group when possible
  // to catch grandchildren (e.g. biome's spawnSync wrapper → native binary).
  // Windows: route through taskkill /F /T which handles the process tree.
  for (const proc of tracked) {
    try {
      if (proc.pid) {
        if (IS_WIN) {
          killTree(proc.pid, "SIGTERM");
        } else {
          process.kill(-proc.pid, "SIGTERM");
        }
      } else {
        proc.kill("SIGTERM");
      }
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {}
    }
  }
  // SIGTERM all Bun subprocesses. Bun.spawn accepts a signal name or number.
  // On Windows every signal funnels to TerminateProcess — the value is symbolic.
  for (const proc of trackedBun) {
    try {
      proc.kill("SIGTERM");
    } catch {
      try {
        proc.kill(2);
      } catch {}
    }
  }

  // Synchronous SIGKILL fallback — setTimeout won't fire during process.exit()
  // so we do it immediately after a brief spin-wait.
  for (const proc of tracked) {
    try {
      if (proc.pid) {
        if (IS_WIN) {
          killTree(proc.pid, "SIGKILL");
        } else {
          process.kill(-proc.pid, "SIGKILL");
        }
      } else {
        proc.kill("SIGKILL");
      }
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  }
  tracked.clear();

  for (const proc of trackedBun) {
    try {
      proc.kill(9); // SIGKILL
    } catch {}
  }
  trackedBun.clear();
}

export function killProcessGroup(): void {
  // POSIX: kill our own process group to catch any child that escaped tracking.
  // Windows: no process-group concept — Job Objects would be needed, but Bun.spawn
  // doesn't expose them. Children we tracked were already taskkill'd above; any
  // grandchildren that escaped are out of reach here. No-op on Windows.
  if (IS_WIN) return;
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {
    // ESRCH = no such process group (already dead), EPERM = not allowed — both fine
  }
}
