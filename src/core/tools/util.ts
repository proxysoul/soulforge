import { execFile } from "node:child_process";
import { EXE } from "../platform/index.js";
import { getVendoredPath } from "../setup/install.js";
import { buildSafeEnv } from "../spawn.js";

/**
 * Resolve the ripgrep binary name for spawn. Prefers the vendored binary
 * (which has the correct .exe suffix on Windows) and falls back to bare
 * `rg` / `rg.exe`. Returning the full path when vendored avoids relying on
 * PATHEXT lookup and bypasses the console-window flash on Windows.
 */
export function rgBin(): string {
  const vendored = getVendoredPath("rg");
  if (vendored) return vendored;
  return `rg${EXE}`;
}

/** Shared execFile → Promise<stdout> wrapper used by soul tools. */
export function execFileAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; maxBuffer: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { ...opts, encoding: "utf-8", windowsHide: true, env: buildSafeEnv() },
      (err, stdout) => {
        if (err) reject(err);
        else resolve((stdout as string).trim());
      },
    );
  });
}
