/**
 * Cached auto-format for post-edit formatting.
 * Avoids re-detecting the project profile on every edit.
 */

import { bunShellArgs, IS_WIN } from "../platform/index.js";

let cachedFormatCmd: string | null | undefined; // undefined = not yet detected

function shellQuote(s: string): string {
  // POSIX: single-quote wrap; Windows cmd.exe: double-quote wrap (no special chars allowed in path-only args).
  if (IS_WIN) return `"${s.replace(/"/g, '\\"')}"`;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function getFormatCommand(cwd: string): Promise<string | null> {
  if (cachedFormatCmd !== undefined) return cachedFormatCmd;
  const { detectProfile } = await import("./project.js");
  const profile = await detectProfile(cwd);
  cachedFormatCmd = profile.format;
  return cachedFormatCmd;
}

/** Override cached format command (e.g. set to null in tests to skip formatting). */
export function setFormatCache(cmd: string | null): void {
  cachedFormatCmd = cmd;
}

/**
 * Auto-format a file after edit. Returns true if formatted, false if skipped/failed.
 * Uses cached format command to avoid re-detecting project profile on every edit.
 */
export async function autoFormatAfterEdit(filePath: string, cwd?: string): Promise<boolean> {
  const effectiveCwd = cwd ?? process.cwd();
  const cmd = await getFormatCommand(effectiveCwd);
  if (!cmd) return false;

  const command = `${cmd} ${shellQuote(filePath)}`;
  try {
    const proc = Bun.spawn(bunShellArgs(command), {
      cwd: effectiveCwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const timer = setTimeout(() => proc.kill(), 5_000);
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return exitCode === 0;
  } catch {
    return false;
  }
}
