import { getCwd, setCwd } from "../cwd.js";

/**
 * Extract a `--cwd <dir>` / `--cwd=<dir>` value from an argv slice.
 * Returns the raw (unresolved) directory string, or null if absent.
 */
export function parseCwdArg(argv: readonly string[]): string | null {
  const i = argv.findIndex((a) => a === "--cwd" || a.startsWith("--cwd="));
  if (i === -1) return null;
  const arg = argv[i];
  if (arg?.startsWith("--cwd=")) return arg.slice("--cwd=".length) || null;
  return argv[i + 1] ?? null;
}

export function applyCwd(dir: string | null | undefined): string {
  if (!dir) return getCwd();
  try {
    return setCwd(dir);
  } catch (err) {
    process.stderr.write(
      `Error: --cwd ${dir} is not a valid directory (${err instanceof Error ? err.message : String(err)})\n`,
    );
    process.exit(1);
  }
}

/**
 * Convenience: parse `--cwd` from argv and apply it in one step.
 * Returns the resolved cwd (unchanged launch cwd when the flag is absent).
 */
export function resolveCwdFromArgv(argv: readonly string[]): string {
  return applyCwd(parseCwdArg(argv));
}
