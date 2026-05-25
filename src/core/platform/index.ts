/**
 * Cross-platform shim — single source of truth for every `process.platform === "win32"` branch.
 *
 * Any file in src/ that needs to do something platform-specific imports from here.
 * Keep the surface small and pure; do not import from outside src/core/platform/.
 */

import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

declare const __SOULFORGE_COMPILED__: boolean | undefined;

export const IS_WIN = process.platform === "win32";
export const IS_DARWIN = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

/** Executable suffix — ".exe" on win32, "" elsewhere. */
export const EXE = IS_WIN ? ".exe" : "";

/** Script-shim suffix — Mason and npm install ".cmd" wrappers on Windows. */
export const CMD_EXT = IS_WIN ? ".cmd" : "";

/** OS temp dir. Re-exported so callers don't import node:os for a one-liner. */
export function tmpDir(): string {
  return tmpdir();
}

export function configDir(): string {
  const local = localAppData();
  if (local) return join(local, "SoulForge");
  return join(process.env.HOME ?? homedir(), ".soulforge");
}

export function dataDir(): string {
  const local = localAppData();
  if (local) return join(local, "SoulForge");
  return join(process.env.HOME ?? homedir(), ".soulforge");
}

export function masonBinDir(): string {
  const local = localAppData();
  if (local) return join(local, "nvim-data", "mason", "bin");
  return join(process.env.HOME ?? homedir(), ".local", "share", "nvim", "mason", "bin");
}

// ── Shell execution ──────────────────────────────────────────────

/** Args for spawning a shell that runs an arbitrary command string. */
export function shellInvocation(): { cmd: string; flag: string } {
  if (IS_WIN) {
    // /d  — skip AutoRun reg keys
    // /s  — strip first+last quote (preserves embedded quoting)
    // /c  — run command then exit
    return { cmd: process.env.COMSPEC ?? "cmd.exe", flag: "/d /s /c" };
  }
  return { cmd: "sh", flag: "-c" };
}

export function spawnShell(commandLine: string, options?: SpawnOptions): ReturnType<typeof spawn> {
  const opts: SpawnOptions = options ?? {};
  if (IS_WIN) {
    const cmd = process.env.COMSPEC ?? "cmd.exe";
    return spawn(cmd, ["/d", "/s", "/c", commandLine], { ...opts, windowsHide: true });
  }
  return spawn("sh", ["-c", commandLine], opts);
}

// ── Process management ──────────────────────────────────────────

/**
 * Kill a process and ALL descendants. POSIX: kill the process group via
 * negative PID. Windows: `taskkill /F /T /PID`.
 *
 * Returns true on best-effort success; swallows ESRCH / EPERM because callers
 * typically run this during shutdown where the target may already be gone.
 */
export function killTree(pid: number, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): boolean {
  if (!pid) return false;
  try {
    if (IS_WIN) {
      const args = ["/T", "/PID", String(pid)];
      if (signal === "SIGKILL") args.unshift("/F");
      const result = spawnSync("taskkill", args, {
        timeout: 5000,
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      return result.status === 0;
    }
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      // Fall back to single-pid kill if group-kill failed (e.g. not detached)
      if (!IS_WIN) process.kill(pid, signal);
    } catch {}
    return false;
  }
}

// ── Command detection ──────────────────────────────────────────

/**
 * Does `bin` exist on PATH? POSIX: `command -v`. Windows: `where`.
 * Synchronous so it can run during boot prereq checks.
 */
export function commandExists(bin: string): boolean {
  if (IS_WIN) {
    // `where` on Windows. Try bare name + PATHEXT-extended via shell so we
    // catch .cmd / .bat / .ps1 wrappers in addition to .exe.
    const result = spawnSync("where", [bin], {
      timeout: 2000,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    return result.status === 0;
  }
  try {
    const result = spawnSync("sh", ["-c", `command -v ${bin}`], {
      timeout: 2000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
/**
 * Ghostty native addon (ghostty-opentui) is currently x64-only on Windows AND
 * segfaults during dlopen on bun 1.3.x — a known native-addon ABI mismatch.
 * Surface every consumer (boot wiring, EditorPanel, ImageDisplay, /terminals)
 * skips Ghostty when this returns true. Opt-out: `SOULFORGE_ENABLE_GHOSTTY=1`
 * for users testing an upstream build, but ARM64 is hard-disabled regardless.
 */
export function ghosttyDisabled(): boolean {
  if (!IS_WIN) return false;
  if (process.arch === "arm64") return true;
  return process.env.SOULFORGE_ENABLE_GHOSTTY !== "1";
}
/**
 * Canonical short label for Windows-unsupported features. UI surfaces show it
 * verbatim so users get the same wording everywhere.
 */
export const UNSUPPORTED_ON_WINDOWS = "[Unavailable on Windows]";

/** Same label as a sentence-terminated hint with a one-line reason. */
export function unsupportedOnWindows(reason: string): string {
  return `${UNSUPPORTED_ON_WINDOWS} ${reason}`;
}

/**
 * Cross-platform atomic-replace.
 *
 * POSIX `rename(2)` atomically overwrites an existing target file. Windows
 * `MoveFile` returns ERROR_ALREADY_EXISTS unless the target is removed first
 * (or `MoveFileEx` with MOVEFILE_REPLACE_EXISTING is used — Node's
 * fs.renameSync does NOT pass that flag). Every atomic-write idiom
 * (`writeFile(tmp); renameSync(tmp, real)`) silently corrupts state on
 * Windows because the second renameSync throws EPERM/EEXIST and the
 * caller's catch block hides it.
 *
 * This helper:
 *   POSIX:  fs.renameSync (atomic)
 *   Win32:  best-effort atomic — try rename; on EEXIST/EPERM unlink target
 *           and retry. NOT truly atomic on Windows (a reader between unlink
 *           and rename sees nothing) but matches what every cross-platform
 *           tool does. The window is microseconds.
 */
import { renameSync as _renameSync, unlinkSync as _unlinkSync } from "node:fs";
export function safeRename(tmpPath: string, targetPath: string): void {
  if (!IS_WIN) {
    _renameSync(tmpPath, targetPath);
    return;
  }
  try {
    _renameSync(tmpPath, targetPath);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") throw err;
  }
  try {
    _unlinkSync(targetPath);
  } catch {}
  _renameSync(tmpPath, targetPath);
}
/**
 * Argv prefix for `Bun.spawn` to run an arbitrary shell command line.
 * POSIX: `["sh", "-c", cmd]`. Win32: `["cmd.exe", "/d", "/s", "/c", cmd]`.
 * Mirrors `shellInvocation()` but returns the full argv ready for spawn.
 */
export function bunShellArgs(commandLine: string): string[] {
  if (IS_WIN) {
    return [process.env.COMSPEC ?? "cmd.exe", "/d", "/s", "/c", commandLine];
  }
  return ["sh", "-c", commandLine];
}

/**
 * Resolve a binary on PATH, trying common Windows shim suffixes (.cmd, .exe,
 * .bat) when bare lookup fails. Returns the resolved absolute path or null.
 */
export function findOnPath(bin: string): string | null {
  if (IS_WIN) {
    const result = spawnSync("where", [bin], {
      encoding: "utf-8",
      timeout: 2000,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout) {
      const first = result.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
      return first ? first.trim() : null;
    }
    // Fall back: walk PATH manually with PATHEXT
    const path = process.env.Path ?? process.env.PATH ?? "";
    const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1").split(";");
    for (const dir of path.split(delimiter)) {
      for (const ext of ["", ...exts]) {
        const candidate = join(dir, bin + ext);
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  }
  try {
    const result = spawnSync("sh", ["-c", `command -v ${bin}`], {
      encoding: "utf-8",
      timeout: 2000,
    });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
    return null;
  } catch {
    return null;
  }
}
/**
 * True when the current process is a Bun-compiled single-file executable.
 *
 * Implementation: a build-time constant injected by `scripts/build.ts` via
 * `Bun.build({ define: { __SOULFORGE_COMPILED__: "true" } })`. The compiled
 * .exe sees the literal `true`; dev mode and `bun run dist/index.js` see
 * `undefined` → `false`. Zero runtime detection, zero ambiguity, survives
 * any future change to `import.meta.url` or `process.execPath` formatting.
 *
 * The `_moduleUrl` parameter is kept for backwards compatibility with the
 * eight call sites that pass `import.meta.url`; it is intentionally
 * unused. New callers should pass an empty string.
 */
export function isCompiledBinary(_moduleUrl?: string): boolean {
  return typeof __SOULFORGE_COMPILED__ !== "undefined" && __SOULFORGE_COMPILED__ === true;
}
/**
 * Per-user data dir for SoulForge runtime state (LSP cache, mason installs,
 * tee logs, plugin data). Mirrors XDG_DATA_HOME on POSIX; on Windows it
 * collapses onto %LOCALAPPDATA%\SoulForge so users have a single trust root.
 *
 * Distinct from `dataDir()` only on Linux/macOS: `~/.local/share/soulforge`
 * vs `~/.soulforge`. Several call sites historically wrote XDG state files
 * here and need the same path post-Windows-port.
 */
export function userDataDir(): string {
  if (IS_WIN) return dataDir();
  return join(process.env.HOME ?? homedir(), ".local", "share", "soulforge");
}
/**
 * Windows %LOCALAPPDATA% with a homedir fallback. On non-Windows returns `null`.
 * Centralises the 8 sites that all wrote the same `process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")`.
 */
export function localAppData(): string | null {
  if (!IS_WIN) return null;
  return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
}
/**
 * Cross-platform `~/` (and on Windows `~\\`) prefix expansion to the home dir.
 * Returns the path unchanged when no leading tilde is present.
 */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || (IS_WIN && p.startsWith("~\\"))) {
    return join(homedir(), p.slice(2));
  }
  return p;
}
/**
 * XDG-style per-user config dir for third-party apps (kitty, ghostty, foot,
 * alacritty, systemd). POSIX: `~/.config`. Windows: `%APPDATA%` (Roaming).
 * Distinct from `configDir()` which is SoulForge's own root.
 */
export function xdgConfigHome(): string {
  if (IS_WIN) {
    return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? homedir(), ".config");
}
/**
 * Per-user font directory. Drop new fonts here without admin/sudo.
 *   macOS:   ~/Library/Fonts
 *   Windows: %LOCALAPPDATA%/Microsoft/Windows/Fonts  (Win10 1809+)
 *   Linux:   ~/.local/share/fonts
 */
export function userFontDir(): string {
  if (IS_DARWIN) return join(homedir(), "Library", "Fonts");
  if (IS_WIN) {
    const local = localAppData() ?? join(homedir(), "AppData", "Local");
    return join(local, "Microsoft", "Windows", "Fonts");
  }
  return join(homedir(), ".local", "share", "fonts");
}
/**
 * All directories worth scanning for installed fonts (per-user first,
 * then system-wide). Includes the per-user dir from `userFontDir()`.
 */
export function systemFontDirs(): string[] {
  if (IS_DARWIN) {
    return [userFontDir(), "/Library/Fonts", "/System/Library/Fonts"];
  }
  if (IS_WIN) {
    const windir = process.env.WINDIR ?? "C:\\Windows";
    return [userFontDir(), join(windir, "Fonts")];
  }
  return [userFontDir(), "/usr/share/fonts", "/usr/local/share/fonts"];
}
