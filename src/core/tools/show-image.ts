import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, resolve } from "node:path";
import type { ChatMessage, ToolResult } from "../../types/index.js";
import { IS_DARWIN, IS_WIN } from "../platform/index.js";
import { buildSafeEnv, SAFE_SPAWN_OPTS } from "../spawn.js";
import {
  canRenderImages,
  isKittyGraphicsTerminal,
  type KittyAnimFrame,
  renderAnimatedImage,
  renderImageFromData,
  supportsKittyAnimation,
} from "../terminal/image.js";
import { emitToolProgress } from "./tool-progress.js";

/** Max width (px) for downscaled GIF animation frames — keeps total transmitted bytes
 *  comfortably under Kitty's 320MB image quota / 1.6GB animation quota. */
const GIF_FRAME_MAX_WIDTH = 360;
/** Hard cap on total raw frame bytes sent to Kitty — beyond this, fall back to static. */
const GIF_TOTAL_BYTES_BUDGET = 64 * 1024 * 1024; // 64 MB

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const TARGET_IMAGE_SIZE = 9 * 1024 * 1024; // 9 MB target after resize
const SUPPORTED_EXTENSIONS = /\.(png|jpg|jpeg|bmp|gif|webp|tiff|tif)$/i;
const URL_RE = /^https?:\/\//i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const GIF_SIGNATURE = Buffer.from("GIF8");

/** Best-effort sync file removal — no shell, no throw. */
function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

export interface SoulVisionArgs {
  path: string;
  cols?: number;
}

/**
 * Convert non-PNG image data to PNG (async).
 * Tries multiple tools in order of availability:
 *   1. ffmpeg (cross-platform, most commonly installed on dev machines)
 *   2. sips (macOS built-in)
 *   3. magick / convert (ImageMagick)
 * Returns the PNG buffer or null if no converter is available.
 */
async function convertToPng(
  data: Buffer,
  ext: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const id = `soul-vision-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const srcPath = resolve(tmpdir(), `${id}${ext}`);
  const dstPath = resolve(tmpdir(), `${id}.png`);

  try {
    writeFileSync(srcPath, data);

    const converters: [string, string[]][] = [
      ["ffmpeg", ["-y", "-i", srcPath, "-frames:v", "1", dstPath]],
      ["sips", ["-s", "format", "png", srcPath, "--out", dstPath]],
      ["magick", [srcPath, `png:${dstPath}`]],
      ["convert", [srcPath, `png:${dstPath}`]],
    ];

    for (const [cmd, cmdArgs] of converters) {
      try {
        const result = await spawnAsync(cmd, cmdArgs, { timeout: 10_000, signal });
        if (result.code === 0 && existsSync(dstPath)) return readFileSync(dstPath);
      } catch {
        // try next
      }
    }

    return null;
  } finally {
    safeUnlink(srcPath);
    safeUnlink(dstPath);
  }
}

/**
 * Fetch an image from a URL. Returns { data, name } or an error string.
 */
async function fetchImageUrl(
  url: string,
): Promise<{ data: Buffer; name: string } | { error: string }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "SoulForge/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { error: `HTTP ${String(res.status)}: ${res.statusText}` };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      return { error: `not_image:${contentType}` };
    }

    // Extract filename from URL path
    const urlPath = new URL(url).pathname;
    const name = basename(urlPath) || "image.png";

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { error: "Empty response" };
    if (buf.length > MAX_IMAGE_SIZE) {
      const resized = await resizeImageToTarget(buf, name, TARGET_IMAGE_SIZE);
      if (resized) return { data: resized, name };
      return {
        error: `Image too large (${String(Math.round(buf.length / 1024 / 1024))}MB) and auto-resize failed. Install ffmpeg to fix:\n  macOS:  brew install ffmpeg\n  Linux:  sudo apt install ffmpeg`,
      };
    }

    return { data: buf, name };
  } catch (e) {
    return { error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── External tool detection (cached) ──

const _toolCache: Record<string, boolean> = {};

function hasTool(name: string): boolean {
  if (name in _toolCache) return _toolCache[name] ?? false;
  try {
    const cmd = IS_WIN ? "where" : "which";
    const result = spawnSync(cmd, [name], {
      ...SAFE_SPAWN_OPTS,
      stdio: "pipe",
      timeout: 5000,
      env: buildSafeEnv(),
    });
    _toolCache[name] = result.status === 0;
  } catch {
    _toolCache[name] = false;
  }
  return _toolCache[name] ?? false;
}

export function hasYtDlp(): boolean {
  return hasTool("yt-dlp");
}
export function hasFfmpeg(): boolean {
  return hasTool("ffmpeg");
}
function hasSips(): boolean {
  return IS_DARWIN && hasTool("sips");
}

/**
 * Resize an image buffer to fit within targetBytes.
 * Tries ffmpeg first (best quality, lanczos), then sips on macOS as fallback.
 * Steps down scale until the result fits within targetBytes.
 */
async function resizeImageToTarget(
  data: Buffer,
  name: string,
  targetBytes: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const id = `soul-vision-resize-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const ext = extname(name).toLowerCase() || ".jpg";
  const srcPath = resolve(tmpdir(), `${id}${ext}`);
  const dstPath = resolve(tmpdir(), `${id}-resized${ext}`);

  try {
    writeFileSync(srcPath, data);

    const scales = [0.9, 0.8, 0.7, 0.6, 0.5];

    // Strategy 1: ffmpeg (cross-platform, best quality)
    if (hasFfmpeg()) {
      for (const scale of scales) {
        const result = await spawnAsync(
          "ffmpeg",
          [
            "-y",
            "-i",
            srcPath,
            "-vf",
            `scale=iw*${String(scale)}:ih*${String(scale)}:flags=lanczos`,
            "-q:v",
            "2",
            dstPath,
          ],
          { timeout: 30_000, signal },
        );
        if (result.code === 0 && existsSync(dstPath)) {
          const resized = readFileSync(dstPath);
          if (resized.length > 0 && resized.length <= targetBytes) return resized;
        }
      }
    }

    // Strategy 2: sips (macOS built-in) — get original width, then resample down
    if (hasSips()) {
      const probe = await spawnAsync("sips", ["--getProperty", "pixelWidth", srcPath], {
        timeout: 10_000,
        signal,
      });
      const widthMatch = probe.stdout.toString().match(/pixelWidth:\s*(\d+)/);
      const origWidth = widthMatch?.[1] ? parseInt(widthMatch[1], 10) : 4000;
      for (const scale of scales) {
        const targetWidth = Math.round(origWidth * scale);
        const result = await spawnAsync(
          "sips",
          ["--resampleWidth", String(targetWidth), srcPath, "--out", dstPath],
          { timeout: 30_000, signal },
        );
        if (result.code === 0 && existsSync(dstPath)) {
          const resized = readFileSync(dstPath);
          if (resized.length > 0 && resized.length <= targetBytes) return resized;
        }
      }
    }

    return null;
  } finally {
    safeUnlink(srcPath);
    safeUnlink(dstPath);
  }
}

const VIDEO_EXTENSIONS = /\.(mp4|mkv|webm|avi|mov|flv|wmv|m4v|ts|3gp)$/i;
const MAX_VIDEO_DOWNLOAD = 20 * 1024 * 1024; // 20 MB max download
const MAX_GIF_DURATION = 10; // seconds
const MAX_GIF_FPS = 8; // lower fps = much smaller GIF
const MAX_GIF_WIDTH = 320; // pixels

// ── Install instruction constants ──

const INSTALL_FFMPEG =
  "  macOS:  brew install ffmpeg\n" +
  "  Linux:  sudo apt install ffmpeg\n" +
  "  Windows: winget install Gyan.FFmpeg";

const INSTALL_YTDLP =
  "  macOS:  brew install yt-dlp\n" +
  "  Linux:  pip install yt-dlp\n" +
  "  Windows: winget install yt-dlp.yt-dlp";

const INSTALL_BOTH =
  "  macOS:  brew install yt-dlp ffmpeg\n" +
  "  Linux:  pip install yt-dlp && sudo apt install ffmpeg\n" +
  "  Windows: winget install yt-dlp.yt-dlp && winget install Gyan.FFmpeg";

// ── Fun progress messages matching SoulForge vibe ──

const YT_DL_MESSAGES = [
  "Summoning the pixels",
  "Negotiating with the internet",
  "Convincing the server",
  "Downloading forbidden knowledge",
  "Acquiring visual data",
  "Intercepting the signal",
  "Extracting the essence",
  "Pulling frames from the void",
];

const FFMPEG_MESSAGES = [
  "Forging the GIF",
  "Transmuting video to art",
  "Compressing spacetime",
  "Weaving pixel tapestry",
  "Distilling motion",
  "Crystallizing frames",
  "Bending light into loops",
  "Encoding the soul",
];

function randomMsg(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)] ?? pool[0] ?? "";
}

function progress(toolCallId: string | undefined, tag: string, msg: string): void {
  if (!toolCallId) return;
  emitToolProgress({ toolCallId, text: `[${tag}] ${msg}` });
}

// ── Async spawn helper ──

const MAX_STDERR = 10 * 1024; // 10 KB cap on stderr accumulation

function spawnAsync(
  cmd: string,
  args: string[],
  opts: {
    timeout?: number;
    signal?: AbortSignal;
    onStderr?: (line: string) => void;
  } = {},
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: opts.timeout ?? 120_000,
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (stderr.length < MAX_STDERR) stderr += text.slice(0, MAX_STDERR - stderr.length);
      if (opts.onStderr) {
        for (const line of text.split("\n")) {
          if (line.trim()) opts.onStderr(line);
        }
      }
    });
    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    proc.on("close", (code) => {
      if (!settled) {
        settled = true;
        resolve({ code: code ?? 1, stdout: Buffer.concat(stdoutChunks), stderr });
      }
    });

    // Kill process on abort signal
    if (opts.signal) {
      if (opts.signal.aborted) {
        proc.kill();
        if (!settled) {
          settled = true;
          reject(new Error("Aborted"));
        }
      } else {
        const onAbort = () => {
          proc.kill();
          if (!settled) {
            settled = true;
            reject(new Error("Aborted"));
          }
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        proc.on("close", () => opts.signal?.removeEventListener("abort", onAbort));
      }
    }
  });
}

/**
 * Convert a video file (local path) to GIF using ffmpeg (async).
 * Two-pass encoding: palette generation → dithered GIF.
 * Returns GIF buffer or null.
 */
async function videoToGif(
  videoPath: string,
  toolCallId?: string,
  maxDuration = MAX_GIF_DURATION,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  if (!hasFfmpeg()) return null;

  const id = `soul-vision-v2g-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const gifPath = resolve(tmpdir(), `${id}.gif`);
  const palettePath = resolve(tmpdir(), `${id}-palette.png`);

  try {
    const filters = `fps=${String(MAX_GIF_FPS)},scale=${String(MAX_GIF_WIDTH)}:-1:flags=lanczos`;
    const msg = randomMsg(FFMPEG_MESSAGES);
    progress(toolCallId, "FFMPEG", `${msg}… (palette)`);

    const pass1 = await spawnAsync(
      "ffmpeg",
      [
        "-y",
        "-t",
        String(maxDuration),
        "-i",
        videoPath,
        "-vf",
        `${filters},palettegen=stats_mode=diff`,
        "-update",
        "1",
        palettePath,
      ],
      { timeout: 60_000, signal },
    );
    if (pass1.code !== 0 || !existsSync(palettePath)) return null;

    progress(toolCallId, "FFMPEG", `${msg}… (encoding)`);

    const pass2 = await spawnAsync(
      "ffmpeg",
      [
        "-y",
        "-t",
        String(maxDuration),
        "-i",
        videoPath,
        "-i",
        palettePath,
        "-lavfi",
        `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`,
        "-loop",
        "0",
        gifPath,
      ],
      {
        timeout: 60_000,
        signal,
        onStderr: (line) => {
          const m = line.match(/time=(\d+:\d+:\d+\.\d+)/);
          if (m) progress(toolCallId, "FFMPEG", `${msg}… ${m[1]}`);
        },
      },
    );
    if (pass2.code !== 0) return null;

    if (existsSync(gifPath)) {
      const data = readFileSync(gifPath);
      if (data.length > 0 && data.length <= MAX_IMAGE_SIZE) return data;
    }
    return null;
  } catch {
    return null;
  } finally {
    safeUnlink(gifPath);
    safeUnlink(palettePath);
  }
}

/**
 * Extract a single frame from a video as PNG using ffmpeg (async).
 * Much faster than full GIF conversion — used for non-Kitty terminals.
 */
async function videoToFrame(
  videoPath: string,
  toolCallId?: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  if (!hasFfmpeg()) return null;

  const id = `soul-vision-frame-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const framePath = resolve(tmpdir(), `${id}.png`);

  try {
    progress(toolCallId, "FFMPEG", "Extracting frame…");
    const result = await spawnAsync(
      "ffmpeg",
      ["-y", "-i", videoPath, "-frames:v", "1", "-q:v", "2", framePath],
      { timeout: 15_000, signal },
    );
    if (result.code === 0 && existsSync(framePath)) {
      const data = readFileSync(framePath);
      if (data.length > 0 && data.length <= MAX_IMAGE_SIZE) return data;
    }
    return null;
  } catch {
    return null;
  } finally {
    safeUnlink(framePath);
  }
}

/**
 * Download a direct video URL (e.g. .mp4, .webm) and convert to GIF.
 * Unlike fetchVideoFromUrl, this doesn't need yt-dlp — it fetches directly.
 */
async function fetchDirectVideoUrl(
  url: string,
  toolCallId?: string,
  signal?: AbortSignal,
): Promise<{ data: Buffer; name: string; isGif: boolean } | { error: string }> {
  if (!hasFfmpeg()) {
    return { error: `Video files require ffmpeg to convert:\n${INSTALL_FFMPEG}` };
  }

  const urlName = (() => {
    try {
      return basename(new URL(url).pathname) || "video";
    } catch {
      return "video";
    }
  })();

  const id = `soul-vision-direct-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const ext = extname(urlName).toLowerCase() || ".mp4";
  const videoPath = resolve(tmpdir(), `${id}${ext}`);

  try {
    progress(toolCallId, "FETCH", `Downloading ${urlName}…`);
    const res = await fetch(url, {
      headers: { "User-Agent": "SoulForge/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      return { error: `HTTP ${String(res.status)}: ${res.statusText}` };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { error: "Empty response" };
    if (buf.length > MAX_VIDEO_DOWNLOAD) {
      return {
        error: `Video too large (${String(Math.round(buf.length / 1024 / 1024))}MB). Max: 20MB.`,
      };
    }

    writeFileSync(videoPath, buf);
    return await convertLocalVideo(videoPath, urlName, toolCallId, signal);
  } catch (e) {
    return { error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    safeUnlink(videoPath);
  }
}

async function fetchVideoFromUrl(
  url: string,
  toolCallId?: string,
  signal?: AbortSignal,
): Promise<{ data: Buffer; name: string; isGif: boolean } | { error: string }> {
  const urlName = (() => {
    try {
      return basename(new URL(url).pathname) || "video";
    } catch {
      return "video";
    }
  })();

  // Neither tool available
  if (!hasYtDlp() && !hasFfmpeg()) {
    return {
      error: `This URL points to a video page, not a direct image. Install yt-dlp and ffmpeg:\n${INSTALL_BOTH}`,
    };
  }

  // ffmpeg only — can't download video URLs
  if (!hasYtDlp()) {
    return {
      error: `This URL points to a video page. yt-dlp is needed to download videos:\n${INSTALL_YTDLP}`,
    };
  }

  const id = `soul-vision-video-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const videoPath = resolve(tmpdir(), `${id}.mp4`);
  const thumbDir = tmpdir();
  const thumbBase = resolve(thumbDir, id);
  const cleanupFiles: string[] = [videoPath];

  try {
    // yt-dlp + ffmpeg → download video → convert to GIF
    if (hasFfmpeg()) {
      try {
        const dlMsg = randomMsg(YT_DL_MESSAGES);
        progress(toolCallId, "YT-DL", `${dlMsg}…`);

        const onStderr = (line: string) => {
          const m = line.match(/(\d+\.\d+)%/);
          if (m) progress(toolCallId, "YT-DL", `${dlMsg}… ${m[1]}%`);
        };

        // First attempt: prefer small formats under 20MB
        let dlResult = await spawnAsync(
          "yt-dlp",
          [
            "-f",
            "best[height<=480][ext=mp4]/best[height<=480]/worst[ext=mp4]/worst",
            "--max-filesize",
            "20M",
            "-o",
            videoPath,
            url,
          ],
          { timeout: 120_000, signal, onStderr },
        );

        // Second attempt: no size cap, lowest quality — ffmpeg will handle the rest
        if (dlResult.code !== 0 || !existsSync(videoPath)) {
          safeUnlink(videoPath);
          progress(toolCallId, "YT-DL", `${dlMsg}… (retrying lowest quality)`);
          dlResult = await spawnAsync("yt-dlp", ["-f", "worst", "-o", videoPath, url], {
            timeout: 120_000,
            signal,
            onStderr,
          });
        }

        if (dlResult.code === 0 && existsSync(videoPath)) {
          // Kitty: full animated GIF (retry once — ffmpeg two-pass can be flaky)
          if (supportsKittyAnimation()) {
            for (let attempt = 0; attempt < 2; attempt++) {
              const gif = await videoToGif(videoPath, toolCallId, MAX_GIF_DURATION, signal);
              if (gif) {
                return { data: gif, name: `${urlName}.gif`, isGif: true };
              }
            }
          }
          // Others: single frame PNG (much faster)
          const frame = await videoToFrame(videoPath, toolCallId, signal);
          if (frame) {
            return { data: frame, name: `${urlName}-frame.png`, isGif: false };
          }
        }
      } catch {
        // download failed — fall through to thumbnail
      }
    }

    // Fallback: yt-dlp thumbnail only (no ffmpeg needed)
    try {
      progress(toolCallId, "YT-DL", "Grabbing thumbnail…");
      const thumbResult = await spawnAsync(
        "yt-dlp",
        [
          "--skip-download",
          "--write-thumbnail",
          "--convert-thumbnails",
          "png",
          "-o",
          thumbBase,
          url,
        ],
        { timeout: 30_000, signal },
      );
      const thumbFile = `${thumbBase}.png`;
      cleanupFiles.push(thumbFile);
      if (thumbResult.code === 0 && existsSync(thumbFile)) {
        const data = readFileSync(thumbFile);
        if (data.length > 0 && data.length <= MAX_IMAGE_SIZE) {
          const suffix = hasFfmpeg()
            ? " (video download failed, showing thumbnail)"
            : " (install ffmpeg for animated GIF)";
          return { data, name: `${urlName}-thumbnail.png${suffix}`, isGif: false };
        }
      }
    } catch {
      // thumbnail extraction failed
    }

    // yt-dlp available but no ffmpeg
    if (!hasFfmpeg()) {
      return {
        error: `yt-dlp is installed but ffmpeg is needed to convert video to GIF:\n${INSTALL_FFMPEG}`,
      };
    }

    return { error: "Failed to extract video content from URL." };
  } finally {
    for (const p of cleanupFiles) safeUnlink(p);
  }
}

/**
 * Handle a local video file: convert to GIF (Kitty) or extract frame (others).
 */
async function convertLocalVideo(
  filePath: string,
  displayName: string,
  toolCallId?: string,
  signal?: AbortSignal,
): Promise<{ data: Buffer; name: string; isGif: boolean } | { error: string }> {
  if (!hasFfmpeg()) {
    return { error: `Video files require ffmpeg to convert:\n${INSTALL_FFMPEG}` };
  }

  const baseName = basename(displayName, extname(displayName));

  // Kitty: full animated GIF (retry once on failure — ffmpeg two-pass can be flaky)
  if (supportsKittyAnimation()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const gif = await videoToGif(filePath, toolCallId, MAX_GIF_DURATION, signal);
      if (gif) {
        return { data: gif, name: `${baseName}.gif`, isGif: true };
      }
    }
  }

  // Others: single frame PNG (much faster)
  const frame = await videoToFrame(filePath, toolCallId, signal);
  if (frame) {
    return { data: frame, name: `${baseName}-frame.png`, isGif: false };
  }

  return { error: "Failed to convert video." };
}

/**
 * Ensure buffer is PNG — convert if needed (async).
 */
export async function ensurePng(
  data: Buffer,
  name: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  // Already PNG?
  if (data.length >= 4 && data.subarray(0, 4).equals(PNG_SIGNATURE)) {
    return data;
  }

  // Need conversion — determine source extension
  const ext = extname(name).toLowerCase() || ".jpg";
  return convertToPng(data, ext, signal);
}

/** Check if data is a GIF. */
function isGif(data: Buffer): boolean {
  return data.length >= 4 && data.subarray(0, 4).equals(GIF_SIGNATURE);
}

/**
 * Extract individual frames from a GIF (async).
 * Downscales frames to `maxWidth` pixels to keep total transmitted bytes under
 * Kitty's storage quota (~320MB base, ~1.6GB anim). Without downscaling, a
 * 50-frame 450×600 GIF can blow the quota and get evicted post-stream.
 *
 * Tries ffmpeg first (most common), then ImageMagick as fallback.
 * Returns array of { png: Buffer, delay: number (ms) } or null if no tool available.
 */
async function extractGifFrames(
  data: Buffer,
  signal?: AbortSignal,
  maxWidth = GIF_FRAME_MAX_WIDTH,
): Promise<KittyAnimFrame[] | null> {
  const id = `soul-vision-gif-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const srcPath = resolve(tmpdir(), `${id}.gif`);
  const outPattern = resolve(tmpdir(), `${id}-frame-%04d.png`);

  try {
    writeFileSync(srcPath, data);

    const delays = parseGifDelays(data);

    // Strategy 1: ffmpeg — scale to maxWidth, preserve aspect, only downscale (never upscale)
    let extracted = false;
    try {
      const r = await spawnAsync(
        "ffmpeg",
        [
          "-y",
          "-i",
          srcPath,
          "-vf",
          `scale='min(${String(maxWidth)},iw)':-1:flags=lanczos`,
          "-vsync",
          "0",
          outPattern,
        ],
        { timeout: 30_000, signal },
      );
      extracted = r.code === 0;
    } catch {
      // ffmpeg not available
    }

    // Strategy 2: ImageMagick — `>` in geometry means "only shrink"
    if (!extracted) {
      for (const cmd of ["magick", "convert"]) {
        try {
          const r = await spawnAsync(
            cmd,
            [srcPath, "-coalesce", "-resize", `${String(maxWidth)}x>`, outPattern],
            { timeout: 30_000, signal },
          );
          if (r.code === 0) {
            extracted = true;
            break;
          }
        } catch {
          // not available
        }
      }
    }

    if (!extracted) return null;

    // Read extracted frame PNGs using readdirSync (no shell)
    const dir = tmpdir();
    const prefix = `${id}-frame-`;
    const frameFiles = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".png"))
      .sort()
      .map((f) => resolve(dir, f));

    if (frameFiles.length === 0) return null;

    const frames: KittyAnimFrame[] = [];
    for (const file of frameFiles) {
      const png = readFileSync(file);
      frames.push({ png, delay: delays[frames.length] ?? 100 });
    }

    return frames.length > 0 ? frames : null;
  } finally {
    safeUnlink(srcPath);
    // Clean up frame files
    try {
      const dir = tmpdir();
      const prefix = `${id}-frame-`;
      for (const f of readdirSync(dir)) {
        if (f.startsWith(prefix) && f.endsWith(".png")) {
          safeUnlink(resolve(dir, f));
        }
      }
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Parse frame delays directly from GIF binary data.
 * GIF stores delays in Graphics Control Extension (GCE) blocks in centiseconds.
 * This avoids needing any external tool just to read delays.
 */
export function parseGifDelays(data: Buffer): number[] {
  const delays: number[] = [];
  let i = 0;

  // Skip GIF header (6 bytes) + Logical Screen Descriptor (7 bytes)
  i = 6;
  if (i + 7 > data.length) return delays;

  // Check for Global Color Table
  const packed = data[i + 4] ?? 0;
  const hasGCT = (packed & 0x80) !== 0;
  const gctSize = hasGCT ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
  i += 7 + gctSize;

  while (i < data.length) {
    const blockType = data[i];

    if (blockType === 0x21) {
      // Extension block
      const label = data[i + 1];
      if (label === 0xf9 && i + 6 <= data.length) {
        // Graphics Control Extension — delay is at bytes 3-4 (little-endian, centiseconds)
        const delayCentiseconds = (data[i + 4] ?? 0) | ((data[i + 5] ?? 0) << 8);
        // 0 centiseconds means "as fast as possible" → use 100ms default
        delays.push((delayCentiseconds <= 0 ? 10 : delayCentiseconds) * 10);
        i += 8; // GCE is always: 21 F9 04 <packed> <delay_lo> <delay_hi> 00
      } else {
        // Skip other extension blocks
        i += 2;
        while (i < data.length) {
          const blockSize = data[i] ?? 0;
          i += 1 + blockSize;
          if (blockSize === 0) break;
        }
      }
    } else if (blockType === 0x2c) {
      // Image descriptor — skip it + LCT + image data
      if (i + 10 > data.length) break;
      const imgPacked = data[i + 9] ?? 0;
      const hasLCT = (imgPacked & 0x80) !== 0;
      const lctSize = hasLCT ? 3 * (1 << ((imgPacked & 0x07) + 1)) : 0;
      i += 10 + lctSize;
      i += 1; // LZW minimum code size
      // Skip sub-blocks
      while (i < data.length) {
        const blockSize = data[i] ?? 0;
        i += 1 + blockSize;
        if (blockSize === 0) break;
      }
    } else if (blockType === 0x3b) {
      break; // Trailer
    } else {
      i++; // Unknown, skip
    }
  }

  return delays;
}

/**
 * soul_vision tool — displays images and videos inline in the chat.
 * Accepts local file paths or URLs. Converts non-PNG formats automatically.
 * Video URLs are downloaded via yt-dlp and converted to animated GIF via ffmpeg.
 * Local video files are converted to GIF via ffmpeg directly.
 */
export async function showImage(
  args: SoulVisionArgs,
  cwd: string,
  toolCallId?: string,
  signal?: AbortSignal,
): Promise<ToolResult & { _imageArt?: Array<{ name: string; lines: string[] }> }> {
  if (!canRenderImages()) {
    return {
      success: false,
      output: "Terminal does not support image rendering (no truecolor).",
    };
  }

  let data: Buffer;
  let name: string;

  if (URL_RE.test(args.path)) {
    // ── URL mode ──
    // Route direct video URLs straight to video handler (no yt-dlp needed for direct links)
    if (VIDEO_EXTENSIONS.test(new URL(args.path).pathname)) {
      const videoResult = await fetchDirectVideoUrl(args.path, toolCallId, signal);
      if ("error" in videoResult) {
        return { success: false, output: videoResult.error };
      }
      data = videoResult.data;
      name = videoResult.name;
    } else {
      const result = await fetchImageUrl(args.path);
      if ("error" in result) {
        // If the URL returned non-image content, try video extraction via yt-dlp
        if (result.error.startsWith("not_image:")) {
          const videoResult = await fetchVideoFromUrl(args.path, toolCallId, signal);
          if ("error" in videoResult) {
            return { success: false, output: videoResult.error };
          }
          data = videoResult.data;
          name = videoResult.name;
        } else {
          return { success: false, output: result.error };
        }
      } else {
        data = result.data;
        name = result.name;
      }
    }
  } else {
    // ── Local file mode ──
    const filePath = resolve(cwd, args.path);

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(filePath);
    } catch {
      return { success: false, output: `File not found: ${args.path}` };
    }

    if (!stat.isFile()) {
      return { success: false, output: `Not a file: ${args.path}` };
    }

    // Local video file → convert to GIF
    if (VIDEO_EXTENSIONS.test(filePath)) {
      if (stat.size > MAX_VIDEO_DOWNLOAD) {
        return {
          success: false,
          output: `Video too large (${String(Math.round(stat.size / 1024 / 1024))}MB). Max: 20MB.`,
        };
      }
      const videoResult = await convertLocalVideo(filePath, args.path, toolCallId, signal);
      if ("error" in videoResult) {
        return { success: false, output: videoResult.error };
      }
      data = videoResult.data;
      name = videoResult.name;
    } else {
      // Image file
      if (!SUPPORTED_EXTENSIONS.test(filePath)) {
        return {
          success: false,
          output:
            "Unsupported format. Supported: PNG, JPG, WebP, GIF, BMP, TIFF, MP4, MKV, WebM, AVI, MOV.",
        };
      }

      try {
        data = readFileSync(filePath);
        if (data.length > MAX_IMAGE_SIZE) {
          const resized = await resizeImageToTarget(data, args.path, TARGET_IMAGE_SIZE, signal);
          if (resized) {
            data = resized;
          } else {
            return {
              success: false,
              output: `Image too large (${String(Math.round(stat.size / 1024 / 1024))}MB) and auto-resize failed. Install ffmpeg for best results:\n  macOS:  brew install ffmpeg\n  Linux:  sudo apt install ffmpeg`,
            };
          }
        }
      } catch (e) {
        return { success: false, output: `Failed to read file: ${String(e)}` };
      }
      name = args.path;
    }
  }

  // GIF animation path — extract frames and animate in Kitty.
  // Quota-aware: if total frame bytes would blow Kitty's storage quota, the
  // image gets evicted post-stream and placeholders show as raw glyphs. Fall
  // back to static first frame in that case.
  if (isGif(data) && supportsKittyAnimation()) {
    const frames = await extractGifFrames(data, signal);
    if (frames && frames.length > 1) {
      const totalBytes = frames.reduce((sum, f) => sum + f.png.length, 0);
      if (totalBytes <= GIF_TOTAL_BYTES_BUDGET) {
        const art = renderAnimatedImage(frames, name, { cols: args.cols });
        if (art) {
          return {
            success: true,
            output: `Displayed animated image: ${name} (${String(frames.length)} frames, ${String(art.lines.length)} rows)`,
            _imageArt: [art],
          };
        }
      }
      // Over budget — render first frame as static instead of risking eviction.
      const firstFrame = frames[0];
      if (firstFrame) {
        const art = await renderImageFromData(firstFrame.png, name, { cols: args.cols });
        if (art) {
          return {
            success: true,
            output: `Displayed image: ${name} (${String(art.lines.length)} rows, animation skipped: ${String(Math.round(totalBytes / 1024 / 1024))}MB > ${String(Math.round(GIF_TOTAL_BYTES_BUDGET / 1024 / 1024))}MB budget)`,
            _imageArt: [art],
          };
        }
      }
    }
    // Fall through to static if frame extraction failed
  }

  // Convert to PNG if needed (Kitty only accepts PNG / raw pixels)
  const pngData = await ensurePng(data, name, signal);
  if (!pngData) {
    return {
      success: false,
      output: `Failed to convert image to PNG. Install ffmpeg for non-PNG format support:\n${INSTALL_FFMPEG}`,
    };
  }

  const art = await renderImageFromData(pngData, name, { cols: args.cols });
  if (!art) {
    return {
      success: false,
      output: "Failed to render image (corrupt or unsupported PNG variant).",
    };
  }

  return {
    success: true,
    output: `Displayed image: ${name} (${String(art.lines.length)} rows)`,
    _imageArt: [art],
  };
}

/**
 * Re-fetch and re-transmit images for a restored session.
 * Kitty image IDs are ephemeral — they're lost when the terminal session ends.
 * This scans messages for soul_vision tool calls with stale kittyImageId,
 * re-fetches the image from the original URL/path, and re-transmits to Kitty
 * so placeholders render correctly again.
 */
export async function restoreSessionImages(messages: ChatMessage[], cwd: string): Promise<number> {
  if (!canRenderImages() || !isKittyGraphicsTerminal()) return 0;

  const staleEntries: Array<{
    tc: ChatMessage["toolCalls"] extends (infer T)[] | undefined ? T : never;
    imgIdx: number;
  }> = [];

  for (const msg of messages) {
    if (!msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      if (tc.name !== "soul_vision" || !tc.imageArt) continue;
      for (let i = 0; i < tc.imageArt.length; i++) {
        const img = tc.imageArt[i];
        if (img?.kittyImageId) {
          staleEntries.push({ tc, imgIdx: i });
        }
      }
    }
  }

  if (staleEntries.length === 0) return 0;

  // Re-fetch and re-render each image concurrently (with a concurrency limit)
  const CONCURRENCY = 3;
  let idx = 0;
  let restored = 0;

  async function processNext(): Promise<void> {
    while (idx < staleEntries.length) {
      const current = idx++;
      const entry = staleEntries[current];
      if (!entry) continue;

      const { tc, imgIdx } = entry;
      const path = tc.args?.path as string | undefined;
      if (!path || typeof path !== "string") continue;

      try {
        let data: Buffer | null = null;
        let name: string;

        if (URL_RE.test(path)) {
          const result = await fetchImageUrl(path);
          if ("error" in result) continue;
          data = result.data;
          name = result.name;
        } else {
          const filePath = resolve(cwd, path);
          if (!existsSync(filePath)) continue;
          const stat = statSync(filePath);
          if (!stat.isFile() || stat.size > MAX_IMAGE_SIZE) continue;
          data = readFileSync(filePath);
          name = path;
        }

        if (!data) continue;

        // Re-render: GIF animation or static image
        let art: {
          kittyImageId?: number;
          kittyCols?: number;
          kittyRows?: number;
          lines: string[];
          name: string;
        } | null = null;

        if (isGif(data) && supportsKittyAnimation()) {
          const frames = await extractGifFrames(data);
          if (frames && frames.length > 1) {
            art = renderAnimatedImage(frames, name, { cols: tc.imageArt?.[imgIdx]?.kittyCols });
          }
        }

        if (!art) {
          const pngData = await ensurePng(data, name);
          if (!pngData) continue;
          art = await renderImageFromData(pngData, name, {
            cols: tc.imageArt?.[imgIdx]?.kittyCols,
          });
        }

        if (art && tc.imageArt) {
          // Update the stale entry in-place with the new Kitty image ID
          const prev = tc.imageArt[imgIdx];
          tc.imageArt[imgIdx] = {
            ...(prev ?? { name: art.name, lines: [] }),
            kittyImageId: art.kittyImageId,
            kittyCols: art.kittyCols,
            kittyRows: art.kittyRows,
            lines: art.lines,
          };
          restored++;
        }
      } catch {
        // Best-effort — skip failed images
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, staleEntries.length) }, () =>
    processNext(),
  );
  await Promise.all(workers);
  return restored;
}
