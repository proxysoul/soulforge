/**
 * Cross-platform clipboard text + image I/O.
 *
 * This module is the new home for clipboard logic. `src/utils/clipboard.ts`
 * is kept as a thin re-exporting facade so existing import sites work.
 *
 * Text:
 *   macOS  → pbcopy / pbpaste
 *   Linux  → wl-copy / xclip / xsel
 *   Win32  → clip.exe (write only, fast path); PowerShell Set-Clipboard /
 *            Get-Clipboard (read + write fallback)
 *
 * Image (PNG read):
 *   macOS  → osascript extracting «class PNGf» to a temp file
 *   Linux  → xclip / wl-paste image/png target
 *   Win32  → persistent powershell.exe daemon (stdin/stdout request loop)
 */

import { execFile, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { findOnPath, IS_DARWIN, IS_WIN, tmpDir } from "./index.js";

export type ClipboardMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ClipboardImage {
  data: Buffer;
  mediaType: ClipboardMediaType;
}

/**
 * Spawn a backend synchronously, write `text` via stdin, return success.
 * Uses spawnSync so we observe ENOENT (binary missing) instead of the previous
 * fire-and-forget spawn which always returned true — masking missing backends
 * and short-circuiting the fallback chain in writeWindowsText/writeLinuxText.
 */
function trySpawn(cmd: string, args: string[], text: string): boolean {
  try {
    const opts: SpawnOptions & { input: string } = {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      input: text,
    };
    const result = spawnSync(cmd, args, opts);
    if (result.error) return false;
    return result.status === 0;
  } catch {
    return false;
  }
}

// ── Text write ──────────────────────────────────────────────

function writeWindowsText(text: string): boolean {
  // clip.exe is always present on Win10+ and is ~6x faster than PowerShell.
  if (trySpawn("clip", [], text)) return true;
  // Fallback to PowerShell Set-Clipboard if clip.exe is unavailable.
  return trySpawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", "$input | Set-Clipboard"],
    text,
  );
}

function writeLinuxText(text: string): boolean {
  const wayland = !!process.env.WAYLAND_DISPLAY;
  const backends: [string, string[]][] = wayland
    ? [
        ["wl-copy", []],
        ["xclip", ["-selection", "clipboard"]],
        ["xsel", ["-b", "-i"]],
      ]
    : [
        ["xclip", ["-selection", "clipboard"]],
        ["wl-copy", []],
        ["xsel", ["-b", "-i"]],
      ];
  for (const [cmd, args] of backends) {
    if (trySpawn(cmd, args, text)) return true;
  }
  return false;
}

/** Write `text` to the system clipboard. Returns true if a backend was spawned. */
export function copyToClipboard(text: string): boolean {
  if (IS_DARWIN) return trySpawn("pbcopy", [], text);
  if (IS_WIN) return writeWindowsText(text);
  return writeLinuxText(text);
}

// ── Image read ──────────────────────────────────────────────

function cleanup(tmpFile: string): void {
  try {
    unlinkSync(tmpFile);
  } catch {}
}

function readImageDarwin(): Promise<ClipboardImage | null> {
  const tmpFile = join(
    tmpDir(),
    `soulforge-clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
  );
  // osascript receives the temp path as a -e literal: AppleScript single
  // quotes don't escape, so embed via a `set filePath to POSIX file ...` that
  // takes the path through string concat, not via shell interpolation.
  const script = [
    "try",
    "  set pngData to the clipboard as «class PNGf»",
    `  set filePath to POSIX file "${tmpFile.replace(/"/g, '\\"').replace(/\\/g, "\\\\")}"`,
    "  set fileRef to open for access filePath with write permission",
    "  set eof fileRef to 0",
    "  write pngData to fileRef",
    "  close access fileRef",
    '  return "ok"',
    "on error",
    '  return "no-image"',
    "end try",
  ].join("\n");
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout.toString().trim().startsWith("ok")) {
        cleanup(tmpFile);
        resolve(null);
        return;
      }
      try {
        const data = readFileSync(tmpFile);
        unlinkSync(tmpFile);
        if (data.length > 0) {
          resolve({ data, mediaType: "image/png" });
          return;
        }
      } catch {
      } finally {
        cleanup(tmpFile);
      }
      resolve(null);
    });
  });
}

function readImageLinux(): Promise<ClipboardImage | null> {
  return new Promise((resolve) => {
    execFile(
      "xclip",
      ["-selection", "clipboard", "-t", "image/png", "-o"],
      { timeout: 3000, maxBuffer: 20 * 1024 * 1024, encoding: "buffer" },
      (err, stdout) => {
        if (!err && stdout && (stdout as Buffer).length > 0) {
          resolve({ data: stdout as Buffer, mediaType: "image/png" });
          return;
        }
        execFile(
          "wl-paste",
          ["--type", "image/png"],
          { timeout: 3000, maxBuffer: 20 * 1024 * 1024, encoding: "buffer" },
          (err2, stdout2) => {
            if (!err2 && stdout2 && (stdout2 as Buffer).length > 0) {
              resolve({ data: stdout2 as Buffer, mediaType: "image/png" });
              return;
            }
            resolve(null);
          },
        );
      },
    );
  });
}

/**
 * Resolve a usable PowerShell binary on Windows. `execFile` does NOT walk
 * PATHEXT or apply shell resolution, so a bare "powershell" throws ENOENT on
 * machines where only PowerShell 7 (`pwsh`) is installed, or where the child
 * process PATH omits System32. Probe, in order:
 *   1. `powershell` on PATH (Windows PowerShell 5.1, present on most installs)
 *   2. the canonical full path (PATH-independent — survives a stripped PATH)
 *   3. `pwsh` on PATH (PowerShell 7+, the only shell on minimal/Server boxes)
 */
function resolveWindowsPowerShell(): string | null {
  const onPath = findOnPath("powershell");
  if (onPath) return onPath;
  const fullPath = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (existsSync(fullPath)) return fullPath;
  return findOnPath("pwsh");
}

/**
 * Long-lived PowerShell daemon for Windows clipboard image reads.
 *
 * Spawning powershell.exe per paste pays a 2-3s cold-start on first call
 * (PowerShell runtime init + .NET Framework JIT for `Add-Type`). NGen
 * pre-warm amortises the JIT across processes, but the PowerShell host
 * startup itself can't be pre-paid by a different process — every
 * `powershell.exe` invocation re-pays it.
 *
 * The daemon keeps one powershell.exe alive, blocking on `ReadLine()` for
 * a command, and serves clipboard reads over stdin/stdout. After the
 * one-time startup (~500-1500ms depending on disk), each READ is just the
 * GetImage() + PNG encode — typically 50-200ms even on slow boxes.
 *
 * Protocol:
 *   - On startup the script emits `READY` once, then loops.
 *   - Caller writes `READ\n` on stdin, daemon responds with one of:
 *       `OK <base64-png>\nEND\n`  (image present, ~kB-MB base64 follows)
 *       `NO\nEND\n`               (no bitmap on clipboard)
 *     The `END` sentinel is on its own line; base64 alphabet is
 *     `[A-Za-z0-9+/=]` so `END` cannot appear in payload bytes.
 *   - On read timeout, on process exit, or on stdin write error, the
 *     pending reader is resolved with `null` and the daemon is reset so
 *     the next call respawns.
 */
class WindowsClipboardDaemon {
  private proc: ReturnType<typeof spawn> | null = null;
  private starting: Promise<void> | null = null;
  private startupLineHandler: ((line: string) => void) | null = null;
  private pendingResponse: string | null = null;
  private stdoutBuf = "";
  private waitingFor: ((result: ClipboardImage | null) => void) | null = null;
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private exited = false;

  /**
   * Start the daemon. Idempotent — concurrent callers share the same
   * `starting` promise. Resolves when the script prints `READY` to stdout
   * (i.e. assemblies are loaded and the read loop is running).
   */
  start(): Promise<void> {
    if (this.proc && !this.exited) return Promise.resolve();
    if (this.starting) return this.starting;
    const exe = resolveWindowsPowerShell();
    if (!exe) return Promise.reject(new Error("PowerShell not found"));
    this.exited = false;
    this.stdoutBuf = "";
    this.pendingResponse = null;
    this.starting = new Promise<void>((resolve, reject) => {
      // `Add-Type` is one-time JIT per process. The read loop hangs on
      // [Console]::In.ReadLine() until we send "READ\n" or "QUIT\n".
      // `[Console]::Out.WriteLine` (not Write-Output) bypasses the
      // PowerShell output pipeline and writes directly to stdout — keeps
      // base64 bytes verbatim with no formatting interference.
      const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        "[Console]::Out.WriteLine('READY')",
        "[Console]::Out.Flush()",
        "while ($true) {",
        "  $line = [Console]::In.ReadLine()",
        "  if ($line -eq 'QUIT') { break }",
        "  if ($line -eq 'READ') {",
        "    $img = [System.Windows.Forms.Clipboard]::GetImage()",
        "    if ($img) {",
        "      $ms = New-Object System.IO.MemoryStream",
        "      $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
        "      $b64 = [Convert]::ToBase64String($ms.ToArray())",
        "      [Console]::Out.WriteLine(('OK ' + $b64))",
        "    } else {",
        "      [Console]::Out.WriteLine('NO')",
        "    }",
        "    [Console]::Out.WriteLine('END')",
        "    [Console]::Out.Flush()",
        "  }",
        "}",
      ].join("\n");
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(exe, ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        this.starting = null;
        reject(err);
        return;
      }
      this.proc = proc;
      this.startupLineHandler = (line: string) => {
        if (line === "READY") {
          resolve();
        } else {
          // First line was not READY — startup failed. Kill and reject.
          this.proc?.kill();
          this.proc = null;
          this.starting = null;
          reject(new Error(`PowerShell startup produced: ${line}`));
        }
      };
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
      // stderr is silently drained — PS occasionally emits a harmless
      // "Couldn't find type [System.Windows.Forms.Clipboard] until the
      // assembly is loaded" warning we don't need to surface.
      proc.stderr?.on("data", () => {});
      proc.on("exit", (code) => this.onExit(code));
      proc.on("error", (err) => {
        if (this.waitingFor) {
          this.waitingFor(null);
          this.waitingFor = null;
        }
        this.proc = null;
        this.starting = null;
        this.exited = true;
        reject(err);
      });
    });
    return this.starting;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nlIdx = this.stdoutBuf.indexOf("\n");
    while (nlIdx !== -1) {
      const line = this.stdoutBuf.slice(0, nlIdx).replace(/\r$/, "");
      this.stdoutBuf = this.stdoutBuf.slice(nlIdx + 1);
      if (this.startupLineHandler) {
        const handler = this.startupLineHandler;
        this.startupLineHandler = null;
        handler(line);
        nlIdx = this.stdoutBuf.indexOf("\n");
        continue;
      }
      if (line === "END") {
        const response = this.pendingResponse ?? "";
        this.pendingResponse = null;
        this.handleResponse(response);
      } else if (line.length > 0) {
        this.pendingResponse = line;
      }
      nlIdx = this.stdoutBuf.indexOf("\n");
    }
  }

  private handleResponse(line: string): void {
    const cb = this.waitingFor;
    this.waitingFor = null;
    if (this.readTimer) {
      clearTimeout(this.readTimer);
      this.readTimer = null;
    }
    if (!cb) return;
    if (line === "NO" || !line.startsWith("OK ")) {
      cb(null);
      return;
    }
    try {
      const data = Buffer.from(line.slice(3), "base64");
      if (data.length === 0) {
        cb(null);
        return;
      }
      cb({ data, mediaType: "image/png" });
    } catch {
      cb(null);
    }
  }

  private onExit(_code: number | null): void {
    this.exited = true;
    this.proc = null;
    this.starting = null;
    if (this.readTimer) {
      clearTimeout(this.readTimer);
      this.readTimer = null;
    }
    if (this.waitingFor) {
      const cb = this.waitingFor;
      this.waitingFor = null;
      cb(null);
    }
  }

  /**
   * Read the clipboard image. If the daemon is down, start it (or fall
   * through to `null` on PS-not-found). Serialised — concurrent callers
   * must use the module-level `inFlightImage` cache in `readClipboardImage`
   * to dedupe, because the daemon processes one request at a time.
   */
  async read(): Promise<ClipboardImage | null> {
    try {
      await this.start();
    } catch {
      return null;
    }
    const proc = this.proc;
    if (!proc?.stdin) return null;
    return new Promise((resolve) => {
      this.waitingFor = resolve;
      this.readTimer = setTimeout(() => {
        if (this.waitingFor === resolve) {
          this.waitingFor = null;
          this.readTimer = null;
          // Eagerly mark dead so the next read() respawns immediately,
          // even if onExit hasn't fired yet (kill() schedules exit
          // asynchronously via the event loop).
          this.proc = null;
          this.exited = true;
          proc.kill();
          resolve(null);
        }
      }, 5000);
      try {
        proc.stdin?.write("READ\n");
      } catch {
        if (this.readTimer) {
          clearTimeout(this.readTimer);
          this.readTimer = null;
        }
        this.waitingFor = null;
        resolve(null);
      }
    });
  }
}

const winClipboardDaemon = new WindowsClipboardDaemon();

/**
 * Eagerly start the Windows clipboard daemon on boot.
 *
 * Called from `boot.tsx` after `prewarmAllModels()`. Idempotent and
 * non-blocking — the actual PS startup happens in the background and the
 * boot splash continues. By the time the user reaches the prompt, the
 * daemon is usually already past its `READY` line.
 *
 * On non-Windows this is a no-op.
 */
export function startClipboardDaemon(): void {
  if (!IS_WIN) return;
  winClipboardDaemon.start().catch(() => {
    // PowerShell missing or refused to start. readClipboardImage will
    // simply return null until the user pastes again — no crash, no
    // error overlay. macOS/Linux paths are unaffected.
  });
}

/**
 * Module-level single-flight cache for image reads.
 *
 * Windows Terminal fires BOTH a keydown event AND a bracketed-paste event
 * for the same Ctrl+V paste. The OpenTUI keydown handler and the paste
 * event listener both call `readClipboardImage`. The daemon serialises
 * commands on a single PS process — so two near-simultaneous callers
 * would each send `READ` and the second would block waiting for the
 * first to complete (~100-200ms each). Sharing the in-flight promise
 * collapses both into a single round-trip.
 */
let inFlightImage: Promise<ClipboardImage | null> | undefined;

/** Read a PNG image from the clipboard. Returns null if none present. */
export function readClipboardImage(): Promise<ClipboardImage | null> {
  if (inFlightImage) return inFlightImage;
  const promise = (async () => {
    if (IS_DARWIN) return readImageDarwin();
    if (IS_WIN) return winClipboardDaemon.read();
    return readImageLinux();
  })();
  inFlightImage = promise;
  return promise.finally(() => {
    inFlightImage = undefined;
  });
}
