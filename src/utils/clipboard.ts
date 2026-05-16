import { exec, type SpawnOptions, spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";

function trySpawn(cmd: string, args: string[], text: string): boolean {
  try {
    const opts: SpawnOptions = { stdio: ["pipe", "ignore", "ignore"] };
    const proc = spawn(cmd, args, opts);
    proc.on("error", () => {});
    if (!proc.stdin) return false;
    proc.stdin.on("error", () => {});
    proc.stdin.write(text);
    proc.stdin.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * Write text to the Linux clipboard. Tries wl-copy first when running under
 * Wayland, then xclip, then xsel. Returns true if a backend was spawned.
 */
export function writeLinuxClipboard(text: string): boolean {
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

export function copyToClipboard(text: string): void {
  if (process.platform === "darwin") {
    trySpawn("pbcopy", [], text);
    return;
  }
  if (process.platform === "win32") {
    trySpawn("clip", [], text);
    return;
  }
  writeLinuxClipboard(text);
}

// ── Clipboard image reading ──

export interface ClipboardImage {
  data: Buffer;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

/**
 * Read image data from the system clipboard (async).
 * Returns null if no image is present.
 *
 * macOS: single osascript call that checks + extracts PNG to temp file.
 * Linux: xclip or wl-paste to read image/png target.
 */
export function readClipboardImageAsync(): Promise<ClipboardImage | null> {
  if (process.platform === "darwin") {
    return readClipboardImageDarwinAsync();
  }
  return readClipboardImageLinuxAsync();
}

function readClipboardImageDarwinAsync(): Promise<ClipboardImage | null> {
  const tmpFile = `/tmp/soulforge-clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  return new Promise((resolve) => {
    // Single osascript call: try to extract PNG, fail gracefully if no image
    exec(
      `osascript -e '
try
  set pngData to the clipboard as «class PNGf»
  set filePath to POSIX file "${tmpFile}"
  set fileRef to open for access filePath with write permission
  set eof fileRef to 0
  write pngData to fileRef
  close access fileRef
  return "ok"
on error
  return "no-image"
end try
' 2>/dev/null`,
      { timeout: 3000 },
      (err, stdout) => {
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
      },
    );
  });
}

function readClipboardImageLinuxAsync(): Promise<ClipboardImage | null> {
  return new Promise((resolve) => {
    // Try xclip first
    exec(
      "xclip -selection clipboard -t image/png -o 2>/dev/null",
      { timeout: 3000, maxBuffer: 20 * 1024 * 1024, encoding: "buffer" },
      (err, stdout) => {
        if (!err && stdout && stdout.length > 0) {
          resolve({ data: stdout, mediaType: "image/png" });
          return;
        }
        // Fallback: wl-paste for Wayland
        exec(
          "wl-paste --type image/png 2>/dev/null",
          { timeout: 3000, maxBuffer: 20 * 1024 * 1024, encoding: "buffer" },
          (err2, stdout2) => {
            if (!err2 && stdout2 && stdout2.length > 0) {
              resolve({ data: stdout2, mediaType: "image/png" });
              return;
            }
            resolve(null);
          },
        );
      },
    );
  });
}

function cleanup(tmpFile: string): void {
  try {
    unlinkSync(tmpFile);
  } catch {}
}
/**
 * Build an OSC-52 clipboard escape sequence. Works over SSH, inside tmux/screen.
 *
 * `clipboard` selects which buffer (`"c"` = system, `"p"` = primary).
 * Returns the raw escape string — the caller writes it to a TTY-bound stdout.
 * For tmux/screen, the sequence is automatically wrapped in passthrough markers.
 */
export function buildOsc52(text: string, clipboard: "c" | "p" = "c"): string {
  const payload = Buffer.from(text, "utf-8").toString("base64");
  const inner = `\x1b]52;${clipboard};${payload}\x07`;
  if (process.env.TMUX) return `\x1bPtmux;\x1b${inner}\x1b\\`;
  if ((process.env.TERM ?? "").startsWith("screen")) return `\x1bP${inner}\x1b\\`;
  return inner;
}

/**
 * Write text to the system clipboard via OSC-52. Returns false when no TTY
 * is attached. Useful for SSH sessions where pbcopy/xclip can't reach the
 * user's local clipboard.
 */
export function copyOsc52(text: string): boolean {
  if (!process.stdout.isTTY) return false;
  try {
    process.stdout.write(buildOsc52(text));
    return true;
  } catch {
    return false;
  }
}
