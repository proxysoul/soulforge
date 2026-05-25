#!/usr/bin/env bun
/**
 * Postinstall: hydrate native libs into the per-user data dir.
 *
 * Runs after `bun install` of `@proxysoul/soulforge`. Plain ESM so it works
 * under Bun's lifecycle hook runner.
 *
 * Locates whichever platform-specific optional deps the package manager
 * installed (`@opentui/core-<plat>-<arch>`, `ghostty-opentui/dist/<plat>-<arch>`)
 * and copies their native binaries into:
 *
 *   Windows:  %LOCALAPPDATA%\SoulForge\native\<plat>-<arch>\
 *   POSIX:    ~/.soulforge/native/<plat>-<arch>/
 *
 * The runtime resolver in scripts/build.ts (and the OpenTUI native plugin)
 * looks in exactly those paths, so once postinstall runs the bundle has
 * everything it needs to start.
 *
 * Idempotent. Soft-fails: any copy error is logged but does not abort
 * install. The runtime prints a clear error if something genuinely went
 * wrong, and `soulforge --doctor` (TODO) will rerun this.
 *
 * Skipped when SOULFORGE_SKIP_POSTINSTALL=1.
 */
import { existsSync, copyFileSync, mkdirSync, readdirSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const QUIET = process.env.SOULFORGE_POSTINSTALL_QUIET === "1";
const SKIP = process.env.SOULFORGE_SKIP_POSTINSTALL === "1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function log(msg) {
  if (!QUIET) console.log(`[soulforge postinstall] ${msg}`);
}
function warn(msg) {
  console.warn(`[soulforge postinstall] ${msg}`);
}

function appDataDir() {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(local, "SoulForge");
  }
  return join(process.env.HOME ?? homedir(), ".soulforge");
}

function nativeDir() {
  return join(appDataDir(), "native", `${process.platform}-${process.arch}`);
}

function opentuiLibName() {
  if (process.platform === "win32") return "opentui.dll";
  if (process.platform === "darwin") return "libopentui.dylib";
  return "libopentui.so";
}

/** Walk up from this script to find the platform-specific @opentui/core-<plat>-<arch> dir. */
function findOpentuiNativePackage() {
  const triplet = `${process.platform}-${process.arch}`;
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const p = join(dir, "node_modules", "@opentui", `core-${triplet}`);
    if (existsSync(join(p, opentuiLibName()))) return p;
    dir = resolve(dir, "..");
  }
  return null;
}

function findGhosttyNativeFile() {
  const triplet = `${process.platform}-${process.arch}`;
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const p = join(dir, "node_modules", "ghostty-opentui", "dist", triplet, "ghostty-opentui.node");
    if (existsSync(p)) return p;
    dir = resolve(dir, "..");
  }
  return null;
}

function findPackageRoot(name) {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const p = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(p, "package.json"))) return p;
    dir = resolve(dir, "..");
  }
  return null;
}

function copyFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  if (process.platform !== "win32") {
    try {
      chmodSync(dest, 0o755);
    } catch {}
  }
}

function copyTree(src, dest) {
  const stat = statSync(src);
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      copyTree(join(src, name), join(dest, name));
    }
  } else {
    copyFile(src, dest);
  }
}

async function main() {
  if (SKIP) {
    log("skipped (SOULFORGE_SKIP_POSTINSTALL=1)");
    return;
  }

  log(`hydrating native runtime for ${process.platform}-${process.arch}`);
  log(`target: ${nativeDir()}`);
  mkdirSync(nativeDir(), { recursive: true });

  // ── OpenTUI native lib (required) ──
  const opentuiPkg = findOpentuiNativePackage();
  if (opentuiPkg) {
    try {
      copyFile(join(opentuiPkg, opentuiLibName()), join(nativeDir(), opentuiLibName()));
      log(`✓ ${opentuiLibName()}`);
    } catch (err) {
      warn(`failed to copy ${opentuiLibName()}: ${err.message}`);
    }
  } else {
    warn(
      `@opentui/core-${process.platform}-${process.arch} not found in node_modules — ` +
        "your package manager may have skipped the os-specific optional dep. " +
        "Reinstall with `bun install` so optional platform deps are included.",
    );
  }

  // ── ghostty-opentui native addon (optional, floating terminal) ──
  const ghostty = findGhosttyNativeFile();
  if (ghostty) {
    try {
      copyFile(ghostty, join(nativeDir(), "ghostty-opentui.node"));
      log("✓ ghostty-opentui.node");
    } catch (err) {
      warn(`failed to copy ghostty-opentui.node: ${err.message} (floating terminal disabled)`);
    }
  } else {
    log("ghostty-opentui.node not available for this platform (floating terminal disabled)");
  }

  // ── tree-sitter WASM (required for repo map / syntax) ──
  const wasmDir = join(appDataDir(), "wasm");
  mkdirSync(wasmDir, { recursive: true });
  const wts = findPackageRoot("web-tree-sitter");
  if (wts) {
    for (const c of [join(wts, "tree-sitter.wasm"), join(wts, "web-tree-sitter.wasm")]) {
      if (existsSync(c)) {
        try {
          copyFile(c, join(wasmDir, "tree-sitter.wasm"));
          log("✓ tree-sitter.wasm");
        } catch (err) {
          warn(`failed to copy tree-sitter.wasm: ${err.message}`);
        }
        break;
      }
    }
  }
  const tsWasms = findPackageRoot("tree-sitter-wasms");
  if (tsWasms && existsSync(join(tsWasms, "out"))) {
    try {
      let count = 0;
      for (const name of readdirSync(join(tsWasms, "out"))) {
        if (name.endsWith(".wasm")) {
          copyFile(join(tsWasms, "out", name), join(wasmDir, name));
          count += 1;
        }
      }
      log(`✓ tree-sitter grammars (${count})`);
    } catch (err) {
      warn(`failed to copy tree-sitter grammars: ${err.message}`);
    }
  }

  // ── OpenTUI assets (glyphs, parser.worker) ──
  const opentuiCore = findPackageRoot("@opentui/core");
  if (opentuiCore && existsSync(join(opentuiCore, "assets"))) {
    try {
      copyTree(join(opentuiCore, "assets"), join(appDataDir(), "opentui-assets"));
      log("✓ opentui-assets");
    } catch (err) {
      warn(`failed to copy opentui-assets: ${err.message}`);
    }
  }

  log("done");
}

main().catch((err) => {
  warn(`unexpected error: ${err.stack ?? err}`);
  // Never fail install.
  process.exit(0);
});
