import { execSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { inflateSync } from "node:zlib";

// ── Terminal capability detection ──

/** Cached kitty version — parsed once on first access. null = not kitty or can't detect. */
let _kittyVersion: [number, number, number] | null | undefined;

/** Reset cached kitty version — for testing only. */
export function _resetKittyVersionCache(override?: [number, number, number] | null): void {
  _kittyVersion = override === undefined ? undefined : override;
}

/** Get the kitty version as [major, minor, patch], or null if not kitty / can't detect. */
function getKittyVersion(): [number, number, number] | null {
  if (_kittyVersion !== undefined) return _kittyVersion;
  _kittyVersion = null;
  if (!process.env.KITTY_WINDOW_ID && process.env.TERM_PROGRAM?.toLowerCase() !== "kitty") {
    return null;
  }
  try {
    // `kitty --version` outputs: "kitty 0.37.0 created by Kovid Goyal"
    const out = execSync("kitty --version", { timeout: 2000, stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .trim();
    const m = /kitty\s+(\d+)\.(\d+)\.(\d+)/.exec(out);
    if (m) {
      _kittyVersion = [Number(m[1]), Number(m[2]), Number(m[3])];
    }
  } catch {
    // Can't detect — assume incompatible
  }
  return _kittyVersion;
}

/** Compare kitty version: true if running kitty <= the given version. */
function isKittyVersionAtMost(major: number, minor: number): boolean {
  const v = getKittyVersion();
  if (!v) return false;
  return v[0] < major || (v[0] === major && v[1] <= minor);
}

/** Check if the terminal supports truecolor (24-bit) — needed for image art. */
export function canRenderImages(): boolean {
  const colorterm = process.env.COLORTERM?.toLowerCase() ?? "";
  if (colorterm === "truecolor" || colorterm === "24bit") return true;
  const term = process.env.TERM_PROGRAM?.toLowerCase() ?? "";
  // Known truecolor terminals
  return !!(
    process.env.KITTY_WINDOW_ID ||
    term === "kitty" ||
    term === "ghostty" ||
    process.env.WEZTERM_PANE !== undefined ||
    term === "wezterm" ||
    process.env.ITERM_SESSION_ID ||
    term === "iterm.app" ||
    term === "iterm2" ||
    term === "hyper" ||
    term === "alacritty"
  );
}

/**
 * Check if the terminal supports the Kitty graphics protocol WITH Unicode placeholders.
 * Unicode placeholders (U=1) are essential — they let the image integrate with the TUI
 * by embedding U+10EEEE chars in the cell buffer. Without them, images paint behind the TUI.
 *
 * Confirmed Unicode placeholder support:
 *   Kitty ≤ 0.37, Ghostty
 *
 * Broken (kitty 0.42+ Unicode 16 grapheme segmentation clusters U+10EEEE + diacritics
 * into one cell, opentui's Zig renderer can't emit them as separate cells):
 *   Kitty ≥ 0.38 — falls through to chafa/half-block art
 *
 * NO Unicode placeholder support (images break TUI):
 *   Konsole — has Kitty protocol but no Unicode placeholders
 *   WezTerm — only in community fork
 *   iTerm2, Warp
 *
 * Tracking: https://github.com/anomalyco/opentui/issues/92 (native image support PR #633)
 * Workaround: downgrade Kitty to 0.37 (https://github.com/kovidgoyal/kitty/releases/tag/v0.37.0)
 *             or use Ghostty.
 */
export function isKittyGraphicsTerminal(): boolean {
  const term = process.env.TERM_PROGRAM?.toLowerCase() ?? "";

  // Explicitly excluded — no Unicode placeholder support
  if (process.env.ITERM_SESSION_ID || term === "iterm.app" || term === "iterm2") return false;
  if (term === "warp" || term === "wezterm") return false;
  if (process.env.WEZTERM_PANE !== undefined) return false;

  // Kitty: only ≤ 0.37 supports Unicode placeholders correctly through opentui's renderer.
  // 0.38+ changed grapheme segmentation (text sizing protocol, finalised in 0.42 with full
  // Unicode 16 segmentation) so U+10EEEE + combining diacritics cluster into one grapheme.
  if (process.env.KITTY_WINDOW_ID || term === "kitty") {
    return isKittyVersionAtMost(0, 37);
  }

  if (term === "ghostty") return true;

  // Konsole: has Kitty graphics protocol but does NOT support Unicode placeholders (U+10EEEE).
  return false;
}

/**
 * Check if the terminal supports Kitty graphics ANIMATION (a=f frames, a=a control).
 * Currently only Kitty ≤ 0.37 supports animation (same placeholder constraint).
 * Ghostty, WezTerm, Konsole support static images but NOT animation.
 */
export function supportsKittyAnimation(): boolean {
  if (!(process.env.KITTY_WINDOW_ID || process.env.TERM_PROGRAM?.toLowerCase() === "kitty")) {
    return false;
  }
  return isKittyVersionAtMost(0, 37);
}

// ── Image file validation ──

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".bmp"]);
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

function isRenderableImage(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return false;
  try {
    const stat = statSync(filePath);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_IMAGE_SIZE;
  } catch {
    return false;
  }
}

// ── PNG decoder (pure JS, no dependencies) ──

export interface PngData {
  width: number;
  height: number;
  pixels: Buffer; // RGB, 3 bytes per pixel
}

export function decodePng(data: Buffer): PngData | null {
  // Verify PNG signature
  if (data.length < 24) return null;
  if (data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47) return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < data.length) {
    const len = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const chunkData = data.subarray(offset + 8, offset + 8 + len);

    if (type === "IHDR") {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8] ?? 8;
      colorType = chunkData[9] ?? 2;
    } else if (type === "IDAT") {
      idatChunks.push(Buffer.from(chunkData));
    } else if (type === "IEND") {
      break;
    }

    offset += 12 + len;
  }

  if (width === 0 || height === 0 || bitDepth !== 8) return null;
  if (colorType !== 2 && colorType !== 6) return null; // Only RGB and RGBA

  const bpp = colorType === 2 ? 3 : 4;
  const rowBytes = width * bpp;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idatChunks));
  } catch {
    return null;
  }

  // Unfilter rows (PNG filter types 0-4)
  const pixels = Buffer.alloc(width * height * 3);

  // Working buffer for current and previous row (unfiltered)
  const curRow = Buffer.alloc(rowBytes);
  const prevRow = Buffer.alloc(rowBytes);

  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (rowBytes + 1)] ?? 0;
    const srcStart = y * (rowBytes + 1) + 1;

    // Copy raw scanline into curRow
    raw.copy(curRow, 0, srcStart, srcStart + rowBytes);

    // Apply filter
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? (curRow[x - bpp] ?? 0) : 0; // left
      const b = prevRow[x] ?? 0; // above
      const c = x >= bpp ? (prevRow[x - bpp] ?? 0) : 0; // upper-left
      const raw_x = curRow[x] ?? 0;

      switch (filterType) {
        case 0: // None
          break;
        case 1: // Sub
          curRow[x] = (raw_x + a) & 0xff;
          break;
        case 2: // Up
          curRow[x] = (raw_x + b) & 0xff;
          break;
        case 3: // Average
          curRow[x] = (raw_x + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4: {
          // Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          curRow[x] = (raw_x + pr) & 0xff;
          break;
        }
      }
    }

    // Extract RGB from unfiltered row
    for (let x = 0; x < width; x++) {
      const si = x * bpp;
      const di = (y * width + x) * 3;
      pixels[di] = curRow[si] ?? 0;
      pixels[di + 1] = curRow[si + 1] ?? 0;
      pixels[di + 2] = curRow[si + 2] ?? 0;
    }

    // Save current row as previous for next iteration
    curRow.copy(prevRow);
  }

  return { width, height, pixels };
}

// ── Half-block art generator ──

/** Max display width in terminal columns. */
const MAX_COLS = 200;
/** Max display height in terminal rows — prevents tall images from overwhelming the chat. */
const MAX_ROWS = 40;
const IMAGE_WIDTH_RATIO = 0.6;
const MIN_IMAGE_COLS = 40;

/** Get responsive image width — 60% of terminal, clamped to [40, MAX_COLS]. */
function getDefaultCols(): number {
  const termCols = process.stdout.columns ?? 120;
  return Math.max(MIN_IMAGE_COLS, Math.min(Math.floor(termCols * IMAGE_WIDTH_RATIO), MAX_COLS));
}

/** Clamp targetCols so the rendered height stays within MAX_ROWS. */
function clampColsToMaxRows(targetCols: number, imageWidth: number, imageHeight: number): number {
  const cellAspect = 2;
  const imageAspect = imageHeight / imageWidth;
  const estimatedRows = Math.round((targetCols * imageAspect) / cellAspect);
  if (estimatedRows > MAX_ROWS) {
    return Math.max(MIN_IMAGE_COLS, Math.floor((MAX_ROWS * cellAspect) / imageAspect));
  }
  return targetCols;
}

/**
 * Sample a rectangular region of the image using area averaging.
 * Returns [r, g, b] averaged over all pixels in the region.
 */
export function sampleArea(
  pixels: Buffer,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number, number] {
  const sx0 = Math.max(0, Math.floor(x0));
  const sy0 = Math.max(0, Math.floor(y0));
  const sx1 = Math.min(width, Math.ceil(x1));
  const sy1 = Math.min(height, Math.ceil(y1));

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;

  for (let y = sy0; y < sy1; y++) {
    for (let x = sx0; x < sx1; x++) {
      const i = (y * width + x) * 3;
      rSum += pixels[i] ?? 0;
      gSum += pixels[i + 1] ?? 0;
      bSum += pixels[i + 2] ?? 0;
      count++;
    }
  }

  if (count === 0) return [0, 0, 0];
  return [Math.round(rSum / count), Math.round(gSum / count), Math.round(bSum / count)];
}

/**
 * Convert a PNG image to half-block ANSI art.
 * Uses ▀ (upper half block) with fg = top pixel, bg = bottom pixel
 * for 2x vertical resolution. Uses area-average downsampling for
 * much better quality than nearest-neighbor.
 *
 * Returns an array of ANSI-colored strings, one per display row.
 */
export function imageToHalfBlockArt(filePath: string, opts?: { cols?: number }): string[] | null {
  if (!isRenderableImage(filePath)) return null;

  let png: PngData | null;
  try {
    const data = readFileSync(filePath);
    png = decodePng(data);
  } catch {
    return null;
  }
  if (!png) return null;

  const targetCols = clampColsToMaxRows(
    Math.min(opts?.cols ?? getDefaultCols(), MAX_COLS),
    png.width,
    png.height,
  );
  return halfBlockArtFromPng(png, targetCols);
}

/** Result from rendering images. */
export interface ImageArtResult {
  rendered: string[];
  arts: Array<{ name: string; lines: string[] }>;
}

/**
 * Render images as half-block ANSI art.
 * Called by the shell tool when `outputImages` is provided.
 *
 * Returns rendered filenames and ANSI art lines for each image.
 * The React component renders the art as <text> elements in the chat.
 */
export function renderImages(paths: string[], cwd?: string): ImageArtResult {
  if (!canRenderImages()) return { rendered: [], arts: [] };
  if (paths.length === 0) return { rendered: [], arts: [] };

  const rendered: string[] = [];
  const arts: ImageArtResult["arts"] = [];

  for (const p of paths) {
    const resolved = resolve(cwd ?? process.cwd(), p);
    const lines = imageToHalfBlockArt(resolved);
    if (lines) {
      const name = basename(p);
      rendered.push(name);
      arts.push({ name, lines });
    }
  }

  return { rendered, arts };
}

// ── Kitty graphics protocol ──

/**
 * Allocate a Kitty image ID with high-entropy RGB encoding.
 * Sequential IDs (1,2,3) map to nearly-identical fg colors (#000001, #000002, ...)
 * which TUI renderers may conflate. We hash the counter so each image has a
 * visually distinct fg color, ensuring opentui always emits the color change.
 */
let _kittyCounter = 0;
function allocateKittyImageId(): number {
  _kittyCounter++;
  const n = _kittyCounter;
  const r = (n * 37) & 0xff;
  const g = (n * 97) & 0xff;
  const b = (n * 163) & 0xff;
  return (r << 16) | (g << 8) | b || 1;
}

/**
 * Write a chunked base64 payload to the terminal via the Kitty graphics protocol.
 * `firstCtrl` is the control string for the first chunk (e.g. `a=t,f=100,i=1,q=2`).
 * For animation frames, continuation chunks must also include `a=f`.
 */
function writeChunkedPayload(
  fd: number,
  base64Data: string,
  firstCtrl: string,
  isAnimFrame = false,
): void {
  const CHUNK_SIZE = 4096;
  const chunks: string[] = [];
  for (let i = 0; i < base64Data.length; i += CHUNK_SIZE) {
    chunks.push(base64Data.slice(i, i + CHUNK_SIZE));
  }

  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    const m = isLast ? 0 : 1;

    let ctrl: string;
    if (isFirst) {
      ctrl = `${firstCtrl},m=${String(m)}`;
    } else {
      // Animation frame continuation chunks must include a=f per the protocol spec
      ctrl = isAnimFrame ? `a=f,m=${String(m)}` : `m=${String(m)}`;
    }

    writeSync(fd, `\x1b_G${ctrl};${chunks[i]}\x1b\\`);
  }
}

/** Open /dev/tty for writing. Returns fd or -1 if unavailable. */
function openTty(): number {
  try {
    return openSync("/dev/tty", "w");
  } catch {
    return -1;
  }
}

/**
 * Transmit a static image to Kitty via the graphics protocol.
 * Writes directly to /dev/tty to bypass TUI renderer stdout interception.
 * Uses `a=t` (transmit only) + virtual placement `U=1` for Unicode placeholders.
 */
function transmitKittyImage(base64Data: string, imageId: number, cols: number, rows: number): void {
  const fd = openTty();
  if (fd < 0) return;

  try {
    writeChunkedPayload(fd, base64Data, `a=t,f=100,i=${String(imageId)},q=2`);
    writeSync(
      fd,
      `\x1b_Ga=p,i=${String(imageId)},U=1,c=${String(cols)},r=${String(rows)},q=2\x1b\\`,
    );
  } finally {
    closeSync(fd);
  }
}

/** Animation frame: PNG data + delay in milliseconds. */
export interface KittyAnimFrame {
  png: Buffer;
  delay: number;
}

/**
 * Transmit an animated image (multiple frames) to Kitty.
 *
 * 1. First frame: `a=t` (standard transmit) + virtual placement
 * 2. Subsequent frames: `a=f` (animation frame) with `z=<delay_ms>`
 * 3. Set root frame gap: `a=a,r=1,z=<delay_ms>`
 * 4. Start animation: `a=a,s=3,v=1` (loop infinitely)
 */
function transmitKittyAnimation(
  frames: KittyAnimFrame[],
  imageId: number,
  cols: number,
  rows: number,
): void {
  if (frames.length === 0) return;
  const fd = openTty();
  if (fd < 0) return;

  try {
    // 1. Transmit base frame (first frame)
    const first = frames[0];
    if (!first) return;
    const firstBase64 = first.png.toString("base64");
    writeChunkedPayload(fd, firstBase64, `a=t,f=100,i=${String(imageId)},q=2`);

    // 2. Create virtual placement
    writeSync(
      fd,
      `\x1b_Ga=p,i=${String(imageId)},U=1,c=${String(cols)},r=${String(rows)},q=2\x1b\\`,
    );

    // 3. Transmit subsequent frames
    for (let i = 1; i < frames.length; i++) {
      const frame = frames[i];
      if (!frame) continue;
      const delay = Math.max(frame.delay, 20); // min 20ms to avoid 0-gap issues
      const frameBase64 = frame.png.toString("base64");
      writeChunkedPayload(
        fd,
        frameBase64,
        `a=f,i=${String(imageId)},z=${String(delay)},f=100,q=2`,
        true, // animation frame continuation chunks need a=f
      );
    }

    // 4. Set the gap for the root frame (frame 1)
    const rootDelay = Math.max(first.delay, 20);
    writeSync(fd, `\x1b_Ga=a,i=${String(imageId)},r=1,z=${String(rootDelay)},q=2\x1b\\`);

    // 5. Start looping animation (s=3 = run normally, v=1 = loop infinitely)
    writeSync(fd, `\x1b_Ga=a,i=${String(imageId)},s=3,v=1,q=2\x1b\\`);
  } finally {
    closeSync(fd);
  }
}

/** Delete a Kitty image by ID. */
export function deleteKittyImage(imageId: number): void {
  const fd = openTty();
  if (fd < 0) return;
  try {
    writeSync(fd, `\x1b_Ga=d,d=i,i=${String(imageId)},q=2\x1b\\`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Get PNG dimensions from raw data without full decode.
 */
export function getPngDimensions(
  data: Buffer | Uint8Array,
): { width: number; height: number } | null {
  if (data.length < 24) return null;
  if (data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47) return null;

  // IHDR is always the first chunk after the 8-byte signature
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const type = buf.toString("ascii", 12, 16);
  if (type !== "IHDR") return null;

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

// ── Render image from raw data (base64 / Buffer) ──

/**
 * Render an image from raw data for inline display in chat.
 *
 * For Kitty terminals: transmits real image via graphics protocol and returns
 * Unicode placeholder ANSI lines that Kitty renders as actual pixels.
 *
 * For other truecolor terminals: decodes PNG and generates half-block ANSI art.
 *
 * Returns null if the image can't be rendered (unsupported format, no truecolor, etc.)
 */
/** Result from renderImageFromData — includes optional Kitty metadata for direct rendering. */
export interface ImageArt {
  name: string;
  lines: string[];
  /** Original image width in pixels */
  width?: number;
  /** Original image height in pixels */
  height?: number;
  /** Kitty graphics: image ID (non-zero = Kitty placeholder mode) */
  kittyImageId?: number;
  /** Kitty graphics: number of columns */
  kittyCols?: number;
  /** Kitty graphics: number of rows */
  kittyRows?: number;
}

// ── chafa fallback for non-Kitty terminals ──

let _chafaAvailable: boolean | null = null;

/** Best-effort sync file removal. */
function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

/**
 * Render an image using chafa (if installed). Async to avoid blocking the main thread.
 * chafa produces much higher quality terminal art than our built-in half-block renderer,
 * using optimal symbol selection, dithering, and color quantization.
 */
async function renderWithChafa(data: Buffer, cols: number): Promise<string[] | null> {
  // Cache chafa availability check
  if (_chafaAvailable === false) return null;
  if (_chafaAvailable === null) {
    _chafaAvailable = await checkToolAvailable("chafa");
    if (!_chafaAvailable) return null;
  }

  const id = `soul-vision-chafa-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  // Use .png extension always — chafa auto-detects format from content, not extension.
  // This avoids shell injection from user-provided filenames.
  const tmpPath = resolve(tmpdir(), `${id}.png`);

  try {
    const fd = openSync(tmpPath, "w");
    writeSync(fd, data);
    closeSync(fd);

    const output = await spawnForOutput(
      "chafa",
      ["-f", "symbols", "-c", "full", "-s", String(cols), "--animate", "off", tmpPath],
      15_000,
    );
    if (!output) return null;

    const lines = output.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  } finally {
    safeUnlink(tmpPath);
  }
}

/** Async check if a CLI tool is available. */
function checkToolAvailable(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(name, ["--version"], { stdio: "pipe", timeout: 3000 });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/** Run a command and return stdout as string, or null on failure. */
function spawnForOutput(cmd: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], timeout });
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BUF = 10 * 1024 * 1024;
    proc.stdout.on("data", (chunk: Buffer) => {
      if (size < MAX_BUF) {
        chunks.push(chunk);
        size += chunk.length;
      }
    });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      resolve(code === 0 ? Buffer.concat(chunks).toString("utf-8") : null);
    });
  });
}

export async function renderImageFromData(
  data: Buffer | Uint8Array,
  name: string,
  opts?: { cols?: number },
): Promise<ImageArt | null> {
  if (!canRenderImages()) return null;

  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const dims = getPngDimensions(buf);
  if (!dims) return null;

  const targetCols = clampColsToMaxRows(
    Math.min(opts?.cols ?? getDefaultCols(), MAX_COLS),
    dims.width,
    dims.height,
  );

  if (isKittyGraphicsTerminal()) {
    const imageId = allocateKittyImageId();
    const base64 = buf.toString("base64");
    const imageAspect = dims.height / dims.width;
    const targetRows = Math.max(1, Math.round((targetCols * imageAspect) / 2));

    transmitKittyImage(base64, imageId, targetCols, targetRows);

    const lines = Array.from({ length: targetRows }, () => " ".repeat(targetCols));
    return {
      name,
      lines,
      width: dims.width,
      height: dims.height,
      kittyImageId: imageId,
      kittyCols: targetCols,
      kittyRows: targetRows,
    };
  }

  // Non-Kitty: try chafa first (much better quality), then built-in half-block art
  const chafaLines = await renderWithChafa(buf, targetCols);
  if (chafaLines) {
    return { name, lines: chafaLines, width: dims.width, height: dims.height };
  }

  const png = decodePng(buf);
  if (!png) return null;

  const lines = halfBlockArtFromPng(png, targetCols);
  return { name, lines, width: png.width, height: png.height };
}

/**
 * Render an animated image (GIF) for inline display in chat.
 *
 * For Kitty: transmits all frames via the animation protocol, starts looping.
 * For non-Kitty: renders just the first frame as half-block art (static).
 *
 * @param frames Array of { png: Buffer, delay: number (ms) } for each GIF frame
 * @param name Display name
 * @param opts.cols Target column width
 */
export function renderAnimatedImage(
  frames: KittyAnimFrame[],
  name: string,
  opts?: { cols?: number },
): ImageArt | null {
  if (!canRenderImages() || frames.length === 0) return null;

  const first = frames[0];
  if (!first) return null;
  const firstDims = getPngDimensions(first.png);
  if (!firstDims) return null;

  const targetCols = clampColsToMaxRows(
    Math.min(opts?.cols ?? getDefaultCols(), MAX_COLS),
    firstDims.width,
    firstDims.height,
  );

  if (supportsKittyAnimation()) {
    const imageId = allocateKittyImageId();
    const imageAspect = firstDims.height / firstDims.width;
    const targetRows = Math.max(1, Math.round((targetCols * imageAspect) / 2));

    transmitKittyAnimation(frames, imageId, targetCols, targetRows);

    const lines = Array.from({ length: targetRows }, () => " ".repeat(targetCols));
    return {
      name,
      lines,
      width: firstDims.width,
      height: firstDims.height,
      kittyImageId: imageId,
      kittyCols: targetCols,
      kittyRows: targetRows,
    };
  }

  // Non-Kitty: static first frame only
  const png = decodePng(first.png);
  if (!png) return null;

  const lines = halfBlockArtFromPng(png, targetCols);
  return { name, lines, width: png.width, height: png.height };
}

/**
 * Core half-block art renderer that works on already-decoded PngData.
 * Extracted from imageToHalfBlockArt so it can be shared with buffer-based rendering.
 */
function halfBlockArtFromPng(png: PngData, targetCols: number): string[] {
  const scaleX = png.width / targetCols;
  const scaleY = scaleX;
  const scaledHeight = Math.ceil(png.height / scaleY);
  const targetRows = scaledHeight + (scaledHeight % 2);

  const lines: string[] = [];

  for (let cy = 0; cy < targetRows; cy += 2) {
    let line = "";
    for (let cx = 0; cx < targetCols; cx++) {
      const srcX0 = cx * scaleX;
      const srcX1 = (cx + 1) * scaleX;

      const [r1, g1, b1] = sampleArea(
        png.pixels,
        png.width,
        png.height,
        srcX0,
        cy * scaleY,
        srcX1,
        (cy + 1) * scaleY,
      );
      const [r2, g2, b2] = sampleArea(
        png.pixels,
        png.width,
        png.height,
        srcX0,
        (cy + 1) * scaleY,
        srcX1,
        (cy + 2) * scaleY,
      );

      line += `\x1b[38;2;${r1};${g1};${b1}m\x1b[48;2;${r2};${g2};${b2}m▀`;
    }
    line += "\x1b[0m";
    lines.push(line);
  }

  return lines;
}
/**
 * Re-issue the virtual placement for an already-transmitted Kitty image.
 * Used after stream finalize / repaint: opentui may damage the cell region
 * containing placeholder chars, and re-arming the placement nudges Kitty to
 * re-render pixels for those cells.
 *
 * If Kitty has evicted the image (quota), this is a no-op on its side and
 * placeholders will still show as raw glyphs — that's handled by quota-aware
 * frame budgeting at transmit time, not here.
 */
export function rearmKittyPlacement(imageId: number, cols: number, rows: number): void {
  const fd = openTty();
  if (fd < 0) return;
  try {
    writeSync(
      fd,
      `\x1b_Ga=p,i=${String(imageId)},U=1,c=${String(cols)},r=${String(rows)},q=2\x1b\\`,
    );
  } finally {
    closeSync(fd);
  }
}
