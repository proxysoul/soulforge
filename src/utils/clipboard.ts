/**
 * Thin facade — clipboard logic lives in `src/core/platform/clipboard.ts`.
 * This module is kept as a stable import path for existing call sites.
 */
import {
  type ClipboardImage as PlatformClipboardImage,
  copyToClipboard as platformCopyToClipboard,
  readClipboardImage as platformReadImage,
} from "../core/platform/clipboard.js";

export type ClipboardImage = PlatformClipboardImage;

export function copyToClipboard(text: string): void {
  platformCopyToClipboard(text);
}

export function readClipboardImageAsync(): Promise<ClipboardImage | null> {
  return platformReadImage();
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
