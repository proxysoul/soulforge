import type { SpawnOptions } from "node:child_process";
import { IS_WIN } from "./platform/index.js";

const SECRET_ENV_PATTERN = /_API_KEY$|_SECRET$|_TOKEN$|_PASSWORD$|_CREDENTIAL$|_PRIVATE_KEY$/;

const ENV_ALLOWLIST = new Set([
  // POSIX
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TERM_PROGRAM",
  "EDITOR",
  "VISUAL",
  "TMPDIR",
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "NVM_DIR",
  "BUN_INSTALL",
  "NODE_PATH",
  "PYTHONPATH",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "SSH_AUTH_SOCK",
  "GPG_TTY",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "SOULFORGE_NO_REPOMAP",
  "NVIM_APPNAME",
  "KITTY_WINDOW_ID",
  "WEZTERM_PANE",
  "OTUI_TREE_SITTER_WORKER_PATH",
  // Windows essentials — subprocesses (git, bun, nvim, LSPs) misbehave without these
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "SYSTEMDRIVE",
]);

export function buildSafeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (ENV_ALLOWLIST.has(key) || key.startsWith("LC_") || key.startsWith("XDG_")) {
      env[key] = value;
    } else if (!SECRET_ENV_PATTERN.test(key)) {
      env[key] = value;
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  // Silence Git Credential Manager prompts on Windows (no interactive UI in headless/TUI flows).
  if (IS_WIN) {
    env.GCM_INTERACTIVE = "Never";
    env.GIT_ASK_YESNO = "false";
  }
  return env;
}

export const SAFE_STDIO: SpawnOptions["stdio"] = ["ignore", "pipe", "pipe"];

/**
 * Spawn options that fully isolate a child from the TUI:
 * - stdin ignored (no inherited fd)
 * - detached: true → child becomes its own process group / session leader on POSIX,
 *   so it has no controlling terminal and cannot read /dev/tty.
 *   Prevents tools like `security`, `ssh`, `sudo`, `gpg`, `pass`, etc.
 *   from prompting the user (and hanging) when stdin is closed.
 */
export const SAFE_SPAWN_OPTS: Pick<SpawnOptions, "stdio" | "detached"> = {
  stdio: SAFE_STDIO,
  detached: true,
};
