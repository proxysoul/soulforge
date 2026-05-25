/**
 * Cross-platform archive extraction (tar.gz, tar.xz, zip).
 *
 * POSIX: shells out to `tar` (xz/gzip auto-detected via `-x`).
 * Win32: uses bundled `tar.exe` (Win10 1803+), which handles `.tar.gz`,
 *        `.tar.xz`, and `.zip` via libarchive backend.
 */

import { spawnSync } from "node:child_process";
import { IS_WIN } from "./index.js";

export interface ExtractResult {
  success: boolean;
  error?: string;
}

/** Extract a `.tar.gz` (or `.tgz`) archive to `destDir`. Returns success status. */
export function extractTarGz(archivePath: string, destDir: string): ExtractResult {
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    windowsHide: true,
    encoding: "utf-8",
  });
  if (result.status === 0) return { success: true };
  return { success: false, error: result.stderr?.toString().trim() || `exit ${result.status}` };
}

/** Extract a `.tar.xz` archive to `destDir`. */
export function extractTarXz(archivePath: string, destDir: string): ExtractResult {
  const result = spawnSync("tar", ["-xJf", archivePath, "-C", destDir], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    windowsHide: true,
    encoding: "utf-8",
  });
  if (result.status === 0) return { success: true };
  return { success: false, error: result.stderr?.toString().trim() || `exit ${result.status}` };
}

/**
 * Extract a `.zip` archive to `destDir`.
 *
 * POSIX: `unzip`. Win32: bundled `tar.exe` accepts `.zip` via libarchive
 * (Win10 1803+), so a single binary handles both formats.
 */
export function extractZip(archivePath: string, destDir: string): ExtractResult {
  if (IS_WIN) {
    const result = spawnSync("tar", ["-xf", archivePath, "-C", destDir], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      windowsHide: true,
      encoding: "utf-8",
    });
    if (result.status === 0) return { success: true };
    return {
      success: false,
      error: result.stderr?.toString().trim() || `tar.exe exit ${result.status}`,
    };
  }
  const result = spawnSync("unzip", ["-o", archivePath, "-d", destDir], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    encoding: "utf-8",
  });
  if (result.status === 0) return { success: true };
  return {
    success: false,
    error: result.stderr?.toString().trim() || `unzip exit ${result.status}`,
  };
}

/** Pick the right extractor based on filename suffix. */
export function extractArchive(archivePath: string, destDir: string): ExtractResult {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return extractTarGz(archivePath, destDir);
  }
  if (lower.endsWith(".tar.xz") || lower.endsWith(".txz")) {
    return extractTarXz(archivePath, destDir);
  }
  if (lower.endsWith(".zip")) {
    return extractZip(archivePath, destDir);
  }
  return { success: false, error: `Unsupported archive format: ${archivePath}` };
}
