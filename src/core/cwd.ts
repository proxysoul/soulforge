import { resolve } from "node:path";

/**
 * Single source of truth for the active workspace directory.
 *
 * Every consumer that means "the project we're working in" reads getCwd()
 * instead of process.cwd() directly. The holder is set once at boot (via
 * setCwd, called from resolve-cwd's applyCwd) and kept in lockstep with the
 * process cwd so spawned children and relative-path resolution agree.
 *
 * Defaults to the launch directory, so reads before boot's setCwd still work.
 */
let _cwd = process.cwd();

/** The active workspace directory (absolute). */
export function getCwd(): string {
  return _cwd;
}

/**
 * Set the active workspace directory. Resolves to absolute, chdir's the
 * process so children + relative paths follow, and stores the value.
 * Returns the resolved absolute path.
 */
export function setCwd(dir: string): string {
  const abs = resolve(dir);
  process.chdir(abs);
  _cwd = abs;
  return abs;
}
