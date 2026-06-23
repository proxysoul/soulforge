#!/usr/bin/env bun
/**
 * Build script that uses Bun.build() JS API to enable the React Compiler
 * plugin during production builds. The CLI `bun build` does NOT support
 * plugins — only the JS API does.
 *
 * For --compile builds, this runs two phases:
 *   1. Bun.build() with React Compiler plugin → .build-tmp/soulforge.js
 *   2. Bun.build() compile on the pre-built JS → native binary
 * This works around Bun.build()'s compile mode ignoring the outfile option
 * and not supporting plugins.
 *
 * Usage:
 *   bun scripts/build.ts                                          — build to dist/
 *   bun scripts/build.ts --compile                                — build standalone binary
 *   bun scripts/build.ts --compile --outfile=path --target=bun-darwin-aarch64
 */
import { type BunPlugin, spawnSync } from "bun";
import { chmodSync, copyFileSync, cpSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pkgJson from "../package.json";

// Inlined into every native-lookup plugin so the runtime resolution honours
// %LOCALAPPDATA% on Windows and ~/.soulforge on POSIX. Single source of truth
// — mirrors src/core/platform/index.ts:configDir() at runtime. Update both
// together if the canonical path moves.
// Inlined into every native-lookup plugin so the runtime resolution honours
// %LOCALAPPDATA% on Windows and ~/.soulforge on POSIX. Single source of truth
// — mirrors src/core/platform/index.ts:configDir() exactly. Update both
// together if the canonical path moves.
const APPDATA_DIR_JS = `
function appDataDir() {
  const { homedir } = require("os");
  const { join } = require("path");
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(local, "SoulForge");
  }
  // process.env.HOME honoured first so sandboxed test runs don't escape to the real profile.
  return join(process.env.HOME || homedir(), ".soulforge");
}
`;

// ── Stub plugin for react-devtools-core (optional peer dep of @opentui/react) ──
// In compiled binaries there's no node_modules, so we replace the import with a no-op.
const devtoolsStubPlugin: BunPlugin = {
  name: "devtools-stub",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "devtools-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "devtools-stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} };",
      loader: "js",
    }));
  },
};

// ── Native addon loader for ghostty-opentui ──
// The .node native addon can't be embedded in compiled binaries.
// Replace the CJS loader with one that loads from ~/.soulforge/ at runtime.
const nativeAddonPlugin: BunPlugin = {
  name: "native-addon-loader",
  setup(build) {
    build.onLoad({ filter: /ghostty-opentui.*native-lib\.cjs$/ }, () => ({
      contents: `
const { platform, arch } = require("os");
const { join } = require("path");
${APPDATA_DIR_JS}
function loadNativeModule() {
  const p = platform();
  const a = arch();
  const name = "ghostty-opentui.node";
  const base = appDataDir();
  const paths = [
    join(base, "native", p + "-" + a, name),
    join(base, "bin", name),
  ];
  for (const path of paths) {
    try { return require(path); } catch {}
  }
  return null;
}
const native = loadNativeModule();
module.exports = { native };
`,
      loader: "js",
    }));
  },
};

// ── OpenTUI native lib resolver ──
// @opentui/core uses `import(`@opentui/core-${platform}-${arch}/index.ts`)`
// which fails in cross-compile because only the host platform's package is installed.
// Replace the platform index.ts with a runtime resolver that loads from ~/.soulforge/native/.
const opentuiNativePlugin: BunPlugin = {
  name: "opentui-native",
  setup(build) {
    // Match every platform package shape:
    //   @opentui/core-darwin-arm64            (older + current bare specifier)
    //   @opentui/core-linux-x64-musl          (0.4.x added libc-suffixed variants)
      //   @opentui/core-linux-arm64/index.ts    (legacy /index.ts form)
      // The trailing segment may itself contain hyphens (x64-musl), so match any
    // non-slash run after the `core-` prefix.
    build.onResolve({ filter: /^@opentui\/core-[a-z0-9-]+(\/index\.ts)?$/ }, (args) => ({
      path: args.path,
      namespace: "opentui-native",
    }));
    build.onLoad({ filter: /.*/, namespace: "opentui-native" }, () => ({
      contents: `
import { platform, arch } from "process";
import { join } from "path";
${APPDATA_DIR_JS}
const ext = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
const prefix = platform === "win32" ? "" : "lib";
const libPath = join(appDataDir(), "native", platform + "-" + arch, prefix + "opentui." + ext);
export default libPath;
`,
      loader: "js",
    }));
  },
};

// ── React Compiler Plugin ────────────────────────────────────────────
const reactCompilerPlugin: BunPlugin = {
  name: "react-compiler",
  setup(build) {
    build.onLoad({ filter: /src\/.*\.tsx?$/ }, async ({ path, loader }) => {
      const { transformSync } = await import("@babel/core");
      const source = await Bun.file(path).text();
      const result = transformSync(source, {
        filename: path,
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
        parserOpts: {
          plugins: path.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
        },
      });
      return { contents: result?.code ?? source, loader };
    });
  },
};

// ── Strip absolute filesystem paths from the bundle ────────────────────
// Bun's bundler may inline absolute paths (cwd, $HOME) into the bundle as
// __dirname / __filename strings or comment markers. Replace them so the
// dev machine's filesystem doesn't ship with the binary.
const stripAbsPathsPlugin: BunPlugin = {
  name: "strip-abs-paths",
  setup(build) {
    const cwd = process.cwd();
    // POSIX uses $HOME; Windows uses $USERPROFILE. Strip whichever is set.
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    build.onLoad({ filter: /\.(ts|tsx|js|jsx)$/ }, async ({ path, loader }) => {
      let src = await Bun.file(path).text();
      if (cwd && src.includes(cwd)) src = src.split(cwd).join("");
      if (home && src.includes(home)) src = src.split(home).join("~");
      return { contents: src, loader };
    });
  },
};

// ── Parse args ───────────────────────────────────────────────────────
const isCompile = process.argv.includes("--compile");

const getFlag = (name: string) => {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
};

const outfile = getFlag("outfile");
const compileTarget = getFlag("target");

// ── Build ────────────────────────────────────────────────────────────
const start = performance.now();

if (isCompile) {
  const tmpDir = ".build-tmp";

  // Phase 1: Build with React Compiler plugin → .build-tmp/soulforge.js
  // Using "soulforge" as the naming so Bun's compile derives "soulforge" as the binary name.
  const phase1 = await Bun.build({
    entrypoints: ["src/boot.tsx"],
    outdir: tmpDir,
    target: "bun",
    external: ["react-devtools-core"],
    naming: "soulforge.[ext]",
    plugins: [reactCompilerPlugin, nativeAddonPlugin, opentuiNativePlugin],
  });

  if (!phase1.success) {
    console.error("Phase 1 (React Compiler) failed:");
    for (const log of phase1.logs) console.error(log);
    process.exit(1);
  }

  // Patch: replace dynamic platform import that Bun can't statically resolve.
  // The template literal `import(`@opentui/core-${process.platform}-${process.arch}/index.ts`)`
  // passes through the bundler verbatim, then Phase 2 compile fails trying to resolve it.
  //
  // Self-heal: if libopentui.{so,dylib} is missing in ~/.soulforge/native/, attempt to
  // recover from the cellar/sibling deps/native/ tree before failing. If recovery fails,
  // throw a precise error pointing at the missing path + remediation, instead of the
  // misleading upstream "opentui is not supported on the current platform" message
  // (issue #66).
  {
    const bundlePath = `${tmpDir}/soulforge.js`;
    let src = await Bun.file(bundlePath).text();
    // OpenTUI's compiled bundle uses either:
    //   `await import(\`@opentui/core-${process.platform}-${process.arch}\`)`           (current)
    //   `await import(\`@opentui/core-${process.platform}-${process.arch}/index.ts\`)`  (older)
    // Match both forms — followed by an optional `<var> = <var>.default;` extract.
    src = src.replace(
      /(?:var |let |const )?\w+\s*=\s*await import\(`@opentui\/core-\$\{process\.platform\}-\$\{process\.arch\}(?:\/index\.ts)?`\);?\s*(?:\w+\s*=\s*\w+\.default;?)?/,
      `targetLibPath = (() => {
  const path = require("path");
  const fs = require("fs");
  ${APPDATA_DIR_JS}
  const ext = process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so";
  const prefix = process.platform === "win32" ? "" : "lib";
  const triplet = process.platform + "-" + process.arch;
  const file = prefix + "opentui." + ext;
  const home = path.join(appDataDir(), "native", triplet, file);
  if (fs.existsSync(home)) return home;
  const candidates = [];
  try { candidates.push(path.resolve(path.dirname(process.execPath), "..", "deps", "native", triplet, file)); } catch {}
  try { candidates.push(path.resolve(path.dirname(process.execPath), "deps", "native", triplet, file)); } catch {}
  for (const src of candidates) {
    try {
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(home), { recursive: true });
        fs.copyFileSync(src, home);
        try { if (process.platform !== "win32") fs.chmodSync(home, 0o755); } catch {}
        return home;
      }
    } catch {}
  }
  const msg = "SoulForge native runtime missing: " + home + "\\n" +
    "  platform: " + triplet + "\\n" +
    "  fix: reinstall SoulForge or rerun the installer from the release tarball.\\n" +
    "  if the problem persists, file an issue at https://github.com/proxysoul/soulforge/issues with this output.";
  throw new Error(msg);
})();`,
    );
    await Bun.write(bundlePath, src);
  }

  // Phase 2: Compile the pre-built JS into a native binary.
  // Bun.build() compile mode ignores outfile — it derives the binary name from
  // the entrypoint basename ("soulforge.js" → "./soulforge") and places it in cwd.
  //
  // `__SOULFORGE_COMPILED__` is the single source of truth for "are we the
  // standalone .exe?" — every isCompiledBinary() call collapses to a literal
  // `true` after Bun's tree-shake. Survives any future change to
  // import.meta.url or process.execPath formatting on any platform.
  // Object-form compile lets us pin runtime flags into the bun-bootstrap argv:
  //   --use-system-ca  → respect corporate proxies / custom CA bundles, no env var
  //   --user-agent=…   → identifiable UA on every outbound fetch (no per-call override)
  // autoloadDotenv: false stops the binary from picking up stray .env files in
  // the user's cwd — SoulForge has no opinion about user env files and silently
  // inheriting one breaks reproducibility.
  // Bun's compile object form requires `target` — when no --target flag was
  // passed, fall back to the host triplet so the host build still works.
  const hostCompileArch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x64" : process.arch;
  const hostCompileTarget = `bun-${
    process.platform === "win32" ? "windows" : process.platform
  }-${hostCompileArch}`;
  const phase2 = await Bun.build({
    entrypoints: [`${tmpDir}/soulforge.js`],
    target: "bun",
    // opentuiNativePlugin MUST run here too: @opentui/core@0.4.x emits 8
    // hardcoded static `import("@opentui/core-<platform>")` specifiers
    // (not the old ${process.platform} template literal the regex patch
    // targets). Without the resolver, Phase 2 compile tries to statically
    // resolve cross-platform packages that aren't installed → build fails.
    plugins: [devtoolsStubPlugin, opentuiNativePlugin],
    compile: {
      target: (compileTarget ?? hostCompileTarget) as never,
      execArgv: [
        `--user-agent=soulforge/${pkgJson.version}`,
        "--use-system-ca",
        "--",
      ],
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
    } as never,
    define: {
      __SOULFORGE_COMPILED__: "true",
    },
  });

  if (!phase2.success) {
    console.error("Phase 2 (compile) failed:");
    for (const log of phase2.logs) console.error(log);
    process.exit(1);
  }

  rmSync(tmpDir, { recursive: true, force: true });

  // Binary lands at ./soulforge in cwd. Bun compile auto-appends .exe when
  // --target=bun-windows-*; detect that and rebase the source path so the
  // rename below works.
  const isWindowsTarget = (compileTarget ?? "").startsWith("bun-windows");
  const defaultBinary = resolve(isWindowsTarget ? "soulforge.exe" : "soulforge");
  if (outfile) {
    let dest = resolve(outfile);
    if (isWindowsTarget && !dest.toLowerCase().endsWith(".exe")) {
      dest = `${dest}.exe`;
    }
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(defaultBinary, dest);
  }

  const elapsed = (performance.now() - start).toFixed(0);
  const finalPath = outfile
    ? isWindowsTarget && !outfile.toLowerCase().endsWith(".exe")
      ? resolve(`${outfile}.exe`)
      : resolve(outfile)
    : defaultBinary;

  // Smoke test: only when the target arch matches the host. Catches "binary
  // builds clean but immediately crashes" regressions before the artifact
  // ships. Cross-compiled builds (e.g. building windows-x64 on darwin-arm64)
  // can't be exercised here — they're verified in release CI on the matching
  // runner. SOULFORGE_SKIP_SMOKE=1 escape hatch for sandboxed/CI environments
  // where exec is restricted.
  const hostArch = process.arch === "arm64" ? "aarch64" : process.arch;
  const hostTarget = `bun-${process.platform === "win32" ? "windows" : process.platform}-${hostArch}`;
  const canSmoke =
    !process.env.SOULFORGE_SKIP_SMOKE &&
    (!compileTarget || compileTarget === hostTarget);
  if (canSmoke) {
    const smoke = spawnSync({
      cmd: [finalPath, "--version"],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    if (smoke.exitCode !== 0) {
      const stderr = smoke.stderr ? new TextDecoder().decode(smoke.stderr) : "";
      console.error(`✗ Smoke test failed (exit ${smoke.exitCode}) for ${finalPath}`);
      if (stderr.trim()) console.error(stderr.trim());
      process.exit(1);
    }
  }

  console.log(`✓ Compiled binary with React Compiler in ${elapsed}ms → ${finalPath}`);
} else {
  // Production hardening: when NODE_ENV=production or --prod is passed, the
  // npm `dist/` build is minified, sourcemap-free, identifier-mangled.
  // This is what protects the published binary from `strings`-based source
  // recovery and casual reverse-engineering.
  const isProd = process.env.NODE_ENV === "production" || process.argv.includes("--prod");
  const minify = isProd ? { whitespace: true, identifiers: true, syntax: true } : false;

  // Same --external rationale as the worker build below: keep native + asset
  // packages out of dist/index.js's chunk fan-out. Resolved at runtime from
  // node_modules (npm install) or from the hydrated ~/.soulforge/native dir
  // (compiled binary install).
  const result = await Bun.build({
    entrypoints: ["src/boot.tsx"],
    outdir: "dist",
    target: "bun",
    naming: "[dir]/index.[ext]",
    external: [
      "ghostty-opentui",
      "ghostty-opentui/*",
      "@opentui/core",
      "@opentui/core/*",
      "tree-sitter-wasms",
      "tree-sitter-wasms/*",
      "*.node",
      "*.wasm",
      "*.scm",
    ],
    plugins: [
      stripAbsPathsPlugin,
      reactCompilerPlugin,
      devtoolsStubPlugin,
    ],
    minify,
    sourcemap: "none",
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  // Build workers separately — npm installs need them as standalone files.
  //
  // --external only the binary asset packages (.node, .wasm, .scm). The TUI
  // packages (@opentui/core, ghostty-opentui, tree-sitter-wasms) USED to be
  // externalised here too — that was a fix-on-top-of-fix for 2.18.x, where
  // io.worker.ts transitively pulled the entire TUI tree via
  // summarize.ts → provider-options.ts → providers/index.ts → src/index.tsx.
  // Externalising the natives made the bundle smaller but left literal
  // `require("@opentui/core")` calls in the worker JS that exploded at
  // runtime with "Worker has been terminated" (issue surfaced as the
  // LLM Gateway crash in 2.18.0/2.18.1).
  //
  // The proper fix lives in the source: worker handlers now import from
  // leaf-only modules (convo-text.ts, model-id.ts) and never reach into
  // the TUI graph. The leak canary below enforces that invariant on every
  // build — drop a TUI import into a worker handler chain and the build
  // fails before it ships.
  const workerResult = await Bun.build({
    entrypoints: [
      "src/core/workers/intelligence.worker.ts",
      "src/core/workers/io.worker.ts",
    ],
    outdir: "dist/workers",
    target: "bun",
    naming: "[name].[ext]",
    external: [
      "*.node",
      "*.wasm",
      "*.scm",
    ],
    plugins: [reactCompilerPlugin],
    minify,
    sourcemap: "none",
  });

  if (!workerResult.success) {
    console.error("Worker build failed:");
    for (const log of workerResult.logs) console.error(log);
    process.exit(1);
  }

  // ── Worker bundle leak canary ─────────────────────────────────────
  // Drop a TUI import into a worker handler chain and this fails. The
  // io worker MUST stay TUI-free — its dynamic-import handlers must only
  // reach leaf modules. The intelligence worker legitimately pulls shiki
  // + tree-sitter, so it's allowed a larger surface, but still no TUI.
  const IO_FORBIDDEN = [
    "src/index.tsx",
    "@opentui/core",
    "ghostty-opentui",
    "src/components/",
    "react/cjs/react.development",
  ];
  const INTEL_FORBIDDEN = [
    "src/index.tsx",
    "@opentui/core",
    "ghostty-opentui",
    "src/components/",
  ];
  const ioBundle = await Bun.file("dist/workers/io.worker.js").text();
  const intelBundle = await Bun.file("dist/workers/intelligence.worker.js").text();
  const ioLeaks = IO_FORBIDDEN.filter((n) => ioBundle.includes(n));
  const intelLeaks = INTEL_FORBIDDEN.filter((n) => intelBundle.includes(n));
  if (ioLeaks.length > 0 || intelLeaks.length > 0) {
    if (ioLeaks.length > 0) console.error(`✗ io.worker.js leaks: ${ioLeaks.join(", ")}`);
    if (intelLeaks.length > 0)
      console.error(`✗ intelligence.worker.js leaks: ${intelLeaks.join(", ")}`);
    console.error(
      "  worker handlers must only import leaf modules — see scripts/build.ts canary comment.",
    );
    process.exit(1);
  }

  // Copy runtime resources that can't be bundled inline.
  // opentui-assets: tree-sitter grammar WASMs + query files for markdown rendering.
  // init.lua: neovim configuration shipped with soulforge.
  // Parser worker is NOT pre-bundled — npm installs use the original from
  // @opentui/core in node_modules (set via OTUI_TREE_SITTER_WORKER_PATH in syntax.ts).
  copyFileSync("src/core/editor/init.lua", "dist/init.lua");
  cpSync("node_modules/@opentui/core/assets", "dist/opentui-assets", { recursive: true });

  // Shell wrapper that checks for bun before exec — gives a clear error to
  // npm/pnpm users who don't have bun installed.
  await Bun.write(
    "dist/bin.sh",
    '#!/bin/sh\n'
    + 'if ! command -v bun >/dev/null 2>&1; then\n'
    + '  echo "SoulForge requires Bun (https://bun.sh)" >&2\n'
    + '  echo "" >&2\n'
    + '  echo "Install Bun:" >&2\n'
    + '  echo "  curl -fsSL https://bun.sh/install | bash" >&2\n'
    + '  echo "" >&2\n'
    + '  echo "Then run: soulforge" >&2\n'
    + '  exit 1\n'
    + 'fi\n'
    + '# Resolve symlinks — follow chain (pnpm/bun can nest multiple levels)\n'
    + 'SELF="$0"\n'
    + 'while [ -L "$SELF" ]; do\n'
    + '  DIR="$(cd "$(dirname "$SELF")" && pwd)"\n'
    + '  SELF="$(readlink "$SELF")"\n'
    + '  case "$SELF" in /*) ;; *) SELF="$DIR/$SELF" ;; esac\n'
    + 'done\n'
    + 'exec bun "$(cd "$(dirname "$SELF")" && pwd)/index.js" "$@"\n',
  );
  chmodSync("dist/bin.sh", 0o755);

  // Windows batch wrapper — npm's cmd-shim picks .cmd over .sh on win32.
  // CRLF line endings; cmd.exe is line-ending sensitive.
  await Bun.write(
    "dist/bin.cmd",
    "@echo off\r\n" +
      "where bun >NUL 2>NUL\r\n" +
      "if errorlevel 1 (\r\n" +
      '  echo SoulForge requires Bun ^(https://bun.sh^) 1>&2\r\n' +
      "  echo. 1>&2\r\n" +
      "  echo Install Bun: 1>&2\r\n" +
      '  echo   powershell -c "irm bun.sh/install.ps1 ^| iex" 1>&2\r\n' +
      "  echo. 1>&2\r\n" +
      "  echo Then run: soulforge 1>&2\r\n" +
      "  exit /b 1\r\n" +
      ")\r\n" +
      'bun "%~dp0index.js" %*\r\n',
  );

  // Production guards: assert no inline sourcemaps and no source-form sentinel
  // class declarations leak into the bundle. Bun preserves export NAMES even
  // with identifier mangling — the *class body* is what we protect.
  if (isProd) {
    const bundle = await Bun.file("dist/index.js").text();
    const sentinels = [
      /\bclass\s+ContextManager\b/,
      /\bclass\s+AgentBus\b/,
      /\bclass\s+RepoMap\b/,
      /\bclass\s+WorkspaceCoordinator\b/,
      /\bfunction\s+createForgeAgent\b/,
    ];
    const leaks = sentinels.filter((re) => re.test(bundle)).map((re) => re.source);
    if (leaks.length > 0) {
      console.error(`✗ unmangled class/function declarations leaked: ${leaks.join(", ")}`);
      process.exit(1);
    }
    if (bundle.includes("sourceMappingURL=data:")) {
      console.error("✗ inline sourcemap detected in bundle");
      process.exit(1);
    }
    // Post-build path scrub. The onLoad strip-paths plugin only sees our
    // source; pre-bundled CJS deps inline absolute __dirname/__filename paths
    // that survive into dist/index.js. Replace them.
    const cwd = process.cwd();
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    let raw = bundle;
    for (const needle of [cwd, home].filter(Boolean)) {
      if (raw.includes(needle)) raw = raw.split(needle).join("");
    }
    if (raw !== bundle) {
      await Bun.write("dist/index.js", raw);
    }
    console.log("✓ verified: sentinels absent, no inline sourcemap, paths stripped");
  }

  const elapsed = (performance.now() - start).toFixed(0);
  const count = result.outputs.length + workerResult.outputs.length;
  console.log(
    `✓ Built ${count} artifact${count === 1 ? "" : "s"} with React Compiler in ${elapsed}ms (minified=${!!minify})`,
  );
}
