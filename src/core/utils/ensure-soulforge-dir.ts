import { execFileSync, type SpawnSyncReturns } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ENTRY = ".soulforge";

/** Track which cwds we've already patched this process to avoid repeated I/O. */
const patched = new Set<string>();

/**
 * Ensure `<cwd>/.soulforge/` exists and is listed in `.gitignore`.
 *
 * - Uses `git check-ignore` to respect all gitignore semantics (parent files, globs, negations).
 * - If `.soulforge` is not ignored and the project is a git repo, appends it to `.gitignore`
 *   (creating the file if needed).
 * - Non-git directories are left alone — no `.gitignore` is created.
 * - Runs at most once per cwd per process.
 */
export function ensureSoulforgeDir(cwd: string): string {
  const dir = join(cwd, ENTRY);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (!patched.has(cwd)) {
    patched.add(cwd);
    try {
      ensureGitignore(cwd);
    } catch {
      // Never let gitignore housekeeping break the app
    }
  }

  return dir;
}

function ensureGitignore(cwd: string): void {
  // Single git call — exit 0 = already ignored, exit 1 = not ignored,
  // exit 128 = not a git repo (or git not installed).
  const status = gitCheckIgnoreStatus(cwd);
  if (status !== 1) return; // 0 = ignored, 128+ = not a repo / no git

  const gitignorePath = join(cwd, ".gitignore");

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    // Match the file's existing line ending style
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const prefix = content.length > 0 && !content.endsWith("\n") ? eol : "";
    appendFileSync(gitignorePath, `${prefix}.soulforge${eol}`);
  } else {
    writeFileSync(gitignorePath, ".soulforge\n");
  }
}

/**
 * Run `git check-ignore -q .soulforge` and return the exit code.
 *   0   = .soulforge is already ignored
 *   1   = .soulforge is NOT ignored (git repo exists, needs patching)
 *   128 = not a git repo, or git not on PATH
 */
function gitCheckIgnoreStatus(cwd: string): number {
  try {
    execFileSync("git", ["check-ignore", "-q", ".soulforge"], {
      cwd,
      stdio: "pipe",
      timeout: 3000,
      windowsHide: true,
    });
    return 0;
  } catch (err) {
    return (err as SpawnSyncReturns<Buffer>).status ?? 128;
  }
}
