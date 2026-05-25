import { execFileSync } from "node:child_process";
import { findNvim } from "neovim";
import { getVendoredPath } from "../setup/install.js";

interface DetectedNvim {
  path: string;
  version: string;
}

/**
 * Detect a usable neovim (0.11+) binary.
 * Checks vendored ~/.soulforge/bin/nvim first, then system PATH.
 * Returns null if not found — caller handles install.
 */
export function detectNeovim(): DetectedNvim | null {
  // 1. Check vendored binary first
  const vendored = getVendoredPath("nvim");
  if (vendored) {
    try {
      // execFileSync (argv form) — no shell, safe with spaces in vendored path.
      const output = execFileSync(vendored, ["--version"], {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 5_000,
      });
      const match = output.match(/NVIM v(\d+\.\d+\.\d+)/);
      if (match?.[1]) {
        return { path: vendored, version: match[1] };
      }
    } catch {
      // vendored binary broken, fall through
    }
  }

  // 2. Check system PATH
  const result = findNvim({ orderBy: "desc", minVersion: "0.11.0" });
  if (result.matches.length > 0) {
    const best = result.matches[0];
    if (best?.path && best.nvimVersion) {
      return { path: best.path, version: best.nvimVersion };
    }
  }

  // 3. Not found — caller will auto-install
  return null;
}
