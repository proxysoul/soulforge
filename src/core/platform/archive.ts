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

export function extractTarGz(archivePath: string, destDir: string): ExtractResult {
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    windowsHide: true,
    encoding: "utf-8",
  });
  if (result.status === 0) return { success: true };
  return { success: false, error: diagnose(result, "tar") };
}

export function extractTarXz(archivePath: string, destDir: string): ExtractResult {
  const result = spawnSync("tar", ["-xJf", archivePath, "-C", destDir], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    windowsHide: true,
    encoding: "utf-8",
  });
  if (result.status === 0) return { success: true };
  return { success: false, error: diagnose(result, "tar") };
}

export function extractZip(archivePath: string, destDir: string): ExtractResult {
  if (IS_WIN) {
    const result = spawnSync("tar", ["-xf", archivePath, "-C", destDir], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      windowsHide: true,
      encoding: "utf-8",
    });
    if (result.status === 0) return { success: true };
    return { success: false, error: diagnose(result, "tar.exe") };
  }
  const result = spawnSync("unzip", ["-o", archivePath, "-d", destDir], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    encoding: "utf-8",
  });
  if (result.status === 0) return { success: true };
  return { success: false, error: diagnose(result, "unzip") };
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
function diagnose(result: ReturnType<typeof spawnSync>, fallback: string): string {
  if (result.error) return result.error.message;
  const stderr = result.stderr?.toString().trim();
  if (stderr) return stderr;
  if (result.signal) return `${fallback} killed by ${result.signal}`;
  return `${fallback} exit ${result.status}`;
}
