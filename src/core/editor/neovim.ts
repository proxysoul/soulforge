import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { attach } from "neovim";
import type { NvimConfigMode } from "../../types/index.js";
import { configDir, isCompiledBinary, userDataDir } from "../platform/index.js";
import { makeIpcSocketPath, shouldCleanupSocketFile } from "../platform/socket.js";
import { trackBunProcess, trackProcess } from "../process-tracker.js";

export interface NvimInstance {
  api: ReturnType<typeof attach>;
  pty: {
    proc: ReturnType<typeof Bun.spawn>;
    write: (data: string) => void;
    onData: (cb: (data: Uint8Array) => void) => () => void;
    resize: (cols: number, rows: number) => void;
  };
  socketPath: string;
}

// Track active nvim PTY processes for emergency cleanup on app exit
const _activePtyProcs = new Set<ReturnType<typeof Bun.spawn>>();
const _activeSocketPaths = new Set<string>();

/** Kill all tracked nvim PTY processes and clean up socket files. Called on app exit. */
export function killAllNvimProcesses(): void {
  for (const proc of _activePtyProcs) {
    try {
      proc.kill();
    } catch {}
  }
  _activePtyProcs.clear();
  if (shouldCleanupSocketFile()) {
    for (const socketPath of _activeSocketPaths) {
      try {
        rmSync(socketPath, { force: true });
      } catch {}
    }
  }
  _activeSocketPaths.clear();
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const _onFileWrittenHandlers = new Set<(absPath: string) => void>();

export function setNeovimFileWrittenHandler(handler: (absPath: string) => void): () => void {
  _onFileWrittenHandlers.add(handler);
  return () => {
    _onFileWrittenHandlers.delete(handler);
  };
}

export async function launchNeovim(
  nvimPath: string,
  cols: number = DEFAULT_COLS,
  rows: number = DEFAULT_ROWS,
  configMode: NvimConfigMode = "default",
): Promise<NvimInstance> {
  killBootstrap();

  let effectivePath = nvimPath;
  const socketPath = makeIpcSocketPath(`sf-nvim-${process.pid}-${Date.now()}`);
  const args = ["-i", "NONE", "--listen", socketPath];

  const isBundled = isCompiledBinary(import.meta.url);
  const bundledInit = join(configDir(), "init.lua");
  const devInit = join(import.meta.dir, "init.lua");
  const shippedInit = isBundled ? bundledInit : existsSync(devInit) ? devInit : bundledInit;

  switch (configMode) {
    case "none":
      args.push("-u", "NONE");
      break;
    case "default":
      if (existsSync(shippedInit)) {
        args.push("-u", shippedInit);
      }
      break;
    case "user": {
      const { findNvim } = await import("neovim");
      const systemResult = findNvim({ orderBy: "desc", minVersion: "0.11.0" });
      const systemNvim = systemResult.matches.find((m) => m.path && !m.path.includes(".soulforge"));
      if (systemNvim?.path) {
        effectivePath = systemNvim.path;
      }
      break;
    }
  }

  const env = configMode === "user" ? process.env : { ...process.env, NVIM_APPNAME: "soulforge" };

  // Buffer PTY output so late subscribers (React components mounting after
  // neovim has already drawn its initial screen) can replay the full history.
  const dataListeners = new Set<(data: Uint8Array) => void>();
  const bufferedChunks: Uint8Array[] = [];
  let bufferedBytes = 0;
  const BUFFER_MAX = 64_000; // ~64KB — enough for a full screen redraw

  const proc = Bun.spawn([effectivePath, ...args], {
    cwd: process.cwd(),
    env,
    terminal: {
      cols,
      rows,
      data(_term, data) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        // Buffer for late subscribers
        bufferedChunks.push(copy);
        bufferedBytes += data.byteLength;
        while (bufferedBytes > BUFFER_MAX && bufferedChunks.length > 1) {
          const dropped = bufferedChunks.shift();
          if (dropped) bufferedBytes -= dropped.byteLength;
        }
        for (const cb of dataListeners) cb(copy);
      },
    },
  });

  const pty = {
    proc,
    write(data: string) {
      proc.terminal?.write(data);
    },
    onData(cb: (data: Uint8Array) => void): () => void {
      // Replay buffered data so the subscriber sees the current screen state
      for (const chunk of bufferedChunks) cb(chunk);
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    resize(c: number, r: number) {
      proc.terminal?.resize(c, r);
    },
  };

  // Wait for socket to appear (neovim creates it after startup)
  const deadline = Date.now() + 3000;
  while (!existsSync(socketPath)) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for neovim socket");
    await new Promise((r) => setTimeout(r, 50));
  }

  const api = attach({ socket: socketPath });

  // Listen for file-written notifications on the RPC channel
  api.on("notification", (method: string, args: unknown[]) => {
    if (method === "soulforge:file_written" && _onFileWrittenHandlers.size > 0) {
      const path = Array.isArray(args) ? args[0] : undefined;
      if (typeof path === "string" && path) {
        for (const h of _onFileWrittenHandlers) {
          try {
            h(path);
          } catch {}
        }
      }
    }
  });

  // Track for emergency cleanup
  _activePtyProcs.add(proc);
  _activeSocketPaths.add(socketPath);
  trackBunProcess(proc);
  proc.exited.then(() => {
    _activePtyProcs.delete(proc);
    _activeSocketPaths.delete(socketPath);
  });

  return { api, pty, socketPath };
}

/**
 * Open a file in the embedded neovim instance.
 */
export async function openFile(nvim: NvimInstance, filePath: string): Promise<void> {
  await nvim.api.executeLua(
    "vim.cmd({cmd='edit', args={vim.fn.fnameescape(...)}, mods={silent=true}})",
    [filePath],
  );
}

/**
 * Get cursor position from neovim.
 */
export async function getCursorPosition(
  nvim: NvimInstance,
): Promise<{ line: number; col: number }> {
  const window = await nvim.api.window;
  const [line, col] = await window.cursor;
  return { line, col };
}

/**
 * Get current buffer name from neovim.
 */
export async function getBufferName(nvim: NvimInstance): Promise<string> {
  const result = await nvim.api.request("nvim_buf_get_name", [0]);
  return typeof result === "string" ? result : "";
}

/**
 * Get visual selection text from neovim.
 * Uses getpos('v') + getpos('.') which work during live visual mode,
 * unlike '< '> marks which only set after leaving visual.
 * Returns selected text or null if not in visual mode.
 */
export async function getVisualSelection(nvim: NvimInstance): Promise<string | null> {
  const lua = `
    local mode = vim.fn.mode()
    if mode ~= 'v' and mode ~= 'V' and mode ~= '\\22' then
      return nil
    end
    local vstart = vim.fn.getpos('v')
    local vend = vim.fn.getpos('.')
    local srow, scol = vstart[2], vstart[3]
    local erow, ecol = vend[2], vend[3]
    if srow > erow or (srow == erow and scol > ecol) then
      srow, scol, erow, ecol = erow, ecol, srow, scol
    end
    local lines = vim.api.nvim_buf_get_lines(0, srow - 1, erow, false)
    if #lines == 0 then return nil end
    if mode == 'V' then
      return table.concat(lines, '\\n')
    end
    if #lines == 1 then
      return lines[1]:sub(scol, ecol)
    end
    lines[1] = lines[1]:sub(scol)
    lines[#lines] = lines[#lines]:sub(1, ecol)
    return table.concat(lines, '\\n')
  `;
  try {
    const result = await nvim.api.executeLua(lua, []);
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}

let _bootstrapProc: ChildProcess | null = null;

/**
 * Kill the headless bootstrap if it's still running.
 * Called before launching the embedded editor to prevent concurrent lazy.nvim installs.
 * Removes partially-cloned plugin dirs so the embedded neovim gets a clean install.
 */
function killBootstrap(): void {
  if (_bootstrapProc) {
    try {
      _bootstrapProc.kill();
    } catch {}
    _bootstrapProc = null;
    const lazyDir = join(userDataDir(), "lazy");
    try {
      rmSync(lazyDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Bootstrap lazy.nvim plugins + mason LSP servers in a headless neovim.
 * Fire-and-forget — runs in background so editor is ready when user opens it.
 * Skips if lazy.nvim data dir already exists (plugins already installed).
 * If user opens the editor before this finishes, it's killed (launchNeovim calls killBootstrap).
 */
export function bootstrapNeovimPlugins(nvimPath: string): void {
  const isBundled = isCompiledBinary(import.meta.url);
  const bundledInit = join(configDir(), "init.lua");
  const devInit = join(import.meta.dir, "init.lua");
  const shippedInit = isBundled ? bundledInit : existsSync(devInit) ? devInit : bundledInit;

  if (!existsSync(shippedInit)) return;

  const lazyDir = join(userDataDir(), "lazy");
  if (existsSync(lazyDir)) return;

  const proc = spawn(
    nvimPath,
    [
      "--headless",
      "-i",
      "NONE",
      "-u",
      shippedInit,
      "+Lazy! install",
      "+MasonToolsInstallSync",
      "+qa",
    ],
    {
      cwd: process.cwd(),
      stdio: "ignore",
      env: { ...process.env, NVIM_APPNAME: "soulforge" },
    },
  );
  trackProcess(proc);
  _bootstrapProc = proc;
  proc.on("exit", () => {
    _bootstrapProc = null;
  });
}

/**
 * Shut down the embedded neovim instance.
 */
export async function shutdownNeovim(nvim: NvimInstance): Promise<void> {
  try {
    await nvim.api.command("qall!");
  } catch {
    // May already be closed
  }
  nvim.pty.proc.kill();
  _activePtyProcs.delete(nvim.pty.proc);
  _activeSocketPaths.delete(nvim.socketPath);
  try {
    rmSync(nvim.socketPath, { force: true });
  } catch {}
}
