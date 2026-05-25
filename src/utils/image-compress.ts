import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { IS_DARWIN } from "../core/platform/index.js";

/**
 * Anthropic (and most providers) reject base64 images > 5 MB.
 * Base64 inflates ~33%, so we target 3.5 MB raw to stay safely under 5 MB encoded.
 */
const MAX_RAW_BYTES = 3.5 * 1024 * 1024;

/**
 * Compress an image buffer if it exceeds the API size limit.
 * Uses native tools (sips on macOS, ffmpeg/magick on Linux) to convert to JPEG
 * with progressive quality reduction until the image fits.
 *
 * Returns { data, mediaType } — the original if already small enough,
 * or a compressed JPEG otherwise. Returns the original on compression failure.
 */
export async function compressImageForApi(
  data: Buffer,
  mediaType: string,
): Promise<{ data: Buffer; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" }> {
  type MediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  const original = { data, mediaType: mediaType as MediaType };

  // Already under limit — no compression needed
  if (data.length <= MAX_RAW_BYTES) return original;

  const id = `sf-compress-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const srcPath = resolve(tmpdir(), `${id}-src.png`);
  const dstPath = resolve(tmpdir(), `${id}-dst.jpg`);

  try {
    writeFileSync(srcPath, data);

    // Try progressively lower quality until we fit.
    // Backends per platform:
    //   macOS:  sips (built-in)
    //   Linux:  ffmpeg, then ImageMagick (`magick`/`convert`)
    //   Win32:  ImageMagick (`magick`/`convert`), then ffmpeg — both optional;
    //          users without either get the original buffer back (caller surfaces).
    const qualities = [85, 70, 50, 30];

    for (const q of qualities) {
      safeUnlink(dstPath);

      const ok = IS_DARWIN
        ? await trySips(srcPath, dstPath, q)
        : await tryFfmpegOrMagick(srcPath, dstPath, q);

      if (ok && existsSync(dstPath)) {
        const compressed = readFileSync(dstPath);
        if (compressed.length <= MAX_RAW_BYTES) {
          return { data: compressed, mediaType: "image/jpeg" };
        }
        // Still too big — try lower quality
      }
    }

    // Last resort: resize to 50% + low quality
    safeUnlink(dstPath);
    const ok = IS_DARWIN
      ? await trySipsResize(srcPath, dstPath, 50, 30)
      : await tryFfmpegOrMagickResize(srcPath, dstPath, 50, 30);

    if (ok && existsSync(dstPath)) {
      const compressed = readFileSync(dstPath);
      if (compressed.length <= MAX_RAW_BYTES) {
        return { data: compressed, mediaType: "image/jpeg" };
      }
    }

    // All attempts failed — return original and let the API error
    return original;
  } finally {
    safeUnlink(srcPath);
    safeUnlink(dstPath);
  }
}

// ── Native tool wrappers ──

async function trySips(src: string, dst: string, quality: number): Promise<boolean> {
  try {
    // sips: convert to JPEG with quality
    const r = await spawnQuiet("sips", [
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      String(quality),
      src,
      "--out",
      dst,
    ]);
    return r === 0;
  } catch {
    return false;
  }
}

async function trySipsResize(
  src: string,
  dst: string,
  scalePercent: number,
  quality: number,
): Promise<boolean> {
  // sips needs pixel dimensions, so we first get the current size
  try {
    const info = await spawnStdout("sips", ["-g", "pixelWidth", src]);
    const match = /pixelWidth:\s*(\d+)/.exec(info);
    if (!match) return false;
    const newWidth = Math.round((Number(match[1]) * scalePercent) / 100);
    const r = await spawnQuiet("sips", [
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      String(quality),
      "--resampleWidth",
      String(newWidth),
      src,
      "--out",
      dst,
    ]);
    return r === 0;
  } catch {
    return false;
  }
}

async function tryFfmpegOrMagick(src: string, dst: string, quality: number): Promise<boolean> {
  // Try ffmpeg first
  try {
    const r = await spawnQuiet("ffmpeg", [
      "-y",
      "-i",
      src,
      "-q:v",
      String(Math.round(((100 - quality) * 31) / 100)), // ffmpeg JPEG quality: 2=best, 31=worst
      dst,
    ]);
    if (r === 0) return true;
  } catch {
    /* not available */
  }

  // Try ImageMagick
  for (const cmd of ["magick", "convert"]) {
    try {
      const r = await spawnQuiet(cmd, [src, "-quality", String(quality), dst]);
      if (r === 0) return true;
    } catch {
      /* not available */
    }
  }
  return false;
}

async function tryFfmpegOrMagickResize(
  src: string,
  dst: string,
  scalePercent: number,
  quality: number,
): Promise<boolean> {
  const scale = `iw*${scalePercent}/100:ih*${scalePercent}/100`;
  try {
    const r = await spawnQuiet("ffmpeg", [
      "-y",
      "-i",
      src,
      "-vf",
      `scale=${scale}`,
      "-q:v",
      String(Math.round(((100 - quality) * 31) / 100)),
      dst,
    ]);
    if (r === 0) return true;
  } catch {
    /* not available */
  }

  for (const cmd of ["magick", "convert"]) {
    try {
      const r = await spawnQuiet(cmd, [
        src,
        "-resize",
        `${String(scalePercent)}%`,
        "-quality",
        String(quality),
        dst,
      ]);
      if (r === 0) return true;
    } catch {
      /* not available */
    }
  }
  return false;
}

// ── Helpers ──

function spawnQuiet(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15_000,
      windowsHide: true,
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });
}

function spawnStdout(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      windowsHide: true,
    });
    let out = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", () => resolve(out));
  });
}

function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort */
  }
}
