#!/usr/bin/env node
/**
 * Cross-platform launcher for the npm-published @proxysoul/soulforge package.
 *
 * npm auto-generates the correct OS shim from the `bin` field:
 *   - On POSIX: a symlink invoking `node` with this file's shebang.
 *   - On Windows: a `.cmd` wrapper that calls `node launcher.mjs %*`.
 *
 * We then locate `bun` (PATH or well-known install locations) and spawn the
 * real entrypoint `dist/index.js` under it. If bun isn't found we print a
 * clear, OS-aware install instruction and exit 1.
 *
 * Why not just exec bun directly from bin.sh / bin.cmd?
 *   - bin.sh works on posix but Windows shells can't run shell scripts.
 *   - bin.cmd works on Windows but breaks under msys/cygwin shells.
 *   - A node launcher works everywhere npm-style shims work.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isWindows = process.platform === "win32";

function findBun() {
  // 1. PATH lookup (honour PATHEXT on Windows).
  const exe = isWindows ? "bun.exe" : "bun";
  const pathDirs = (process.env.PATH ?? "").split(isWindows ? ";" : ":").filter(Boolean);
  for (const d of pathDirs) {
    const p = join(d, exe);
    if (existsSync(p)) return p;
  }
  // 2. Well-known install dirs (mirrors bun.sh/install.ps1 + curl|bash).
  const candidates = isWindows
    ? [
        join(process.env.USERPROFILE ?? homedir(), ".bun", "bin", "bun.exe"),
        join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "bun", "bin", "bun.exe"),
      ]
    : [join(homedir(), ".bun", "bin", "bun"), "/usr/local/bin/bun", "/opt/homebrew/bin/bun"];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function bunMissing() {
  const cmd = isWindows
    ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
    : "curl -fsSL https://bun.sh/install | bash";
  process.stderr.write(
    [
      "SoulForge requires Bun (https://bun.sh)",
      "",
      "Install Bun:",
      `  ${cmd}`,
      "",
      "Then re-run: soulforge",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const bun = findBun();
if (!bun) bunMissing();

// dist/index.js is one level up from scripts/launcher.mjs.
// Layout in the published package:
//   scripts/launcher.mjs    <- bin entry (this file)
//   dist/index.js           <- bun runtime entrypoint
const entry = resolve(__dirname, "..", "dist", "index.js");
if (!existsSync(entry)) {
  process.stderr.write(`SoulForge runtime missing: ${entry}\nReinstall the package.\n`);
  process.exit(1);
}

const child = spawn(bun, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: false,
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
child.on("error", (err) => {
  process.stderr.write(`failed to spawn bun: ${err.message}\n`);
  process.exit(1);
});
