/**
 * Cross-platform IPC socket path builder.
 *
 * POSIX: Unix domain socket under os.tmpdir() — e.g. `/tmp/sf-nvim-12345.sock`.
 * Windows: named pipe — e.g. `\\.\pipe\sf-nvim-12345`.
 *
 * Named pipes are reclaimed by the kernel when the last handle closes, so
 * callers MUST skip the rmSync cleanup that POSIX UDS files require.
 */

import { join } from "node:path";
import { IS_WIN, tmpDir } from "./index.js";

/**
 * Build an IPC socket path for a given label.
 *
 * @param label  unique-per-process identifier (e.g. `sf-nvim-${pid}-${ts}`)
 *               Must not contain path separators or `\\`. Letters, digits,
 *               and `-_.` only — anything else is replaced with `_`.
 *
 * Examples:
 *   makeIpcSocketPath("sf-nvim-12345-1234567890") →
 *     win32 : "\\\\.\\pipe\\sf-nvim-12345-1234567890"
 *     posix : "/tmp/sf-nvim-12345-1234567890.sock"
 */
export function makeIpcSocketPath(label: string): string {
  const safe = label.replace(/[^A-Za-z0-9._-]/g, "_");
  if (IS_WIN) {
    return `\\\\.\\pipe\\${safe}`;
  }
  return join(tmpDir(), `${safe}.sock`);
}

/**
 * On POSIX, the UDS file must be unlinked when the listener shuts down.
 * On Windows, named pipes are kernel objects with no filesystem residue —
 * cleanup is a no-op.
 */
export function shouldCleanupSocketFile(): boolean {
  return !IS_WIN;
}
