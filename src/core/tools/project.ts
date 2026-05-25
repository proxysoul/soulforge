import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { bunShellArgs } from "../platform/index.js";
import { compressShellOutputFull } from "./shell-compress.js";
import { saveTee, truncateWithTee } from "./tee.js";
import { getToolTimeoutMs } from "./tool-timeout.js";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function readSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

type ProjectAction = "test" | "build" | "lint" | "format" | "typecheck" | "run" | "list" | "check";

interface ProjectArgs {
  action: ProjectAction;
  file?: string;
  fix?: boolean;
  script?: string;
  flags?: string;
  raw?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
}

interface ProjectProfile {
  test: string | null;
  build: string | null;
  lint: string | null;
  /** Combined format+lint fix command (e.g. biome check --write --unsafe). Covers both in one pass. */
  formatAndLint: string | null;
  typecheck: string | null;
  run: string | null;
  format: string | null;
}

export async function detectProfile(cwd: string): Promise<ProjectProfile> {
  const profile: ProjectProfile = {
    test: null,
    build: null,
    lint: null,
    formatAndLint: null,
    typecheck: null,
    run: null,
    format: null,
  };

  const has = async (f: string) => {
    try {
      await access(join(cwd, f));
      return true;
    } catch {
      return false;
    }
  };
  const hasExt = async (ext: string) => {
    try {
      const entries = await readdir(cwd);
      return entries.some((f) => f.endsWith(ext));
    } catch {
      return false;
    }
  };
  const scripts = await readPackageScripts(cwd);

  // JS/TS — Bun
  if ((await has("bun.lock")) || (await has("bun.lockb"))) {
    profile.test = scripts.test ?? "bun test";
    profile.build = scripts.build ? `bun run build` : null;
    profile.lint = scripts.lint ? "bun run lint" : await detectJsLinter(cwd, "bunx");
    profile.typecheck = scripts.typecheck
      ? "bun run typecheck"
      : (await has("tsconfig.json"))
        ? "bunx tsc --noEmit"
        : null;
    profile.run = scripts.dev ? "bun run dev" : scripts.start ? "bun run start" : null;
    profile.format = scripts.format ? "bun run format" : await detectJsFormatter(cwd, "bunx");
    profile.formatAndLint = await detectFormatAndLint(cwd, "bunx");
    return profile;
  }

  // JS/TS — Deno
  if ((await has("deno.json")) || (await has("deno.lock"))) {
    profile.test = "deno test";
    profile.build = null;
    profile.lint = "deno lint";
    profile.typecheck = "deno check .";
    profile.run = scripts.dev ? "deno task dev" : "deno run main.ts";
    profile.format = "deno fmt";
    return profile;
  }

  // JS/TS — pnpm/yarn/npm
  if (await has("package.json")) {
    const pm = await detectJsPm(cwd);
    const run = pm === "npm" ? "npm run" : pm;
    profile.test = scripts.test ? `${run} test` : null;
    profile.build = scripts.build ? `${run} build` : null;
    profile.lint = scripts.lint ? `${run} lint` : await detectJsLinter(cwd, "npx");
    profile.typecheck = scripts.typecheck
      ? `${run} typecheck`
      : (await has("tsconfig.json"))
        ? "npx tsc --noEmit"
        : null;
    profile.run = scripts.dev ? `${run} dev` : scripts.start ? `${run} start` : null;
    profile.format = scripts.format ? `${run} format` : await detectJsFormatter(cwd, "npx");
    profile.formatAndLint = await detectFormatAndLint(cwd, "npx");
    return profile;
  }

  // Rust
  if (await has("Cargo.toml")) {
    profile.test = "cargo test";
    profile.build = "cargo build";
    profile.lint = "cargo clippy";
    profile.typecheck = "cargo check";
    profile.run = "cargo run";
    profile.format = "rustfmt";
    return profile;
  }

  // Go
  if (await has("go.mod")) {
    profile.test = "go test ./...";
    profile.build = "go build ./...";
    profile.lint =
      (await has(".golangci.yml")) || (await has(".golangci.yaml"))
        ? "golangci-lint run"
        : "go vet ./...";
    profile.typecheck = "go build ./...";
    profile.run = "go run .";
    profile.format = "gofmt -w";
    return profile;
  }

  // Python
  if ((await has("pyproject.toml")) || (await has("setup.py")) || (await has("requirements.txt"))) {
    const pm = (await has("uv.lock"))
      ? "uv run"
      : (await has("poetry.lock"))
        ? "poetry run"
        : (await has("Pipfile.lock"))
          ? "pipenv run"
          : "";
    const prefix = pm ? `${pm} ` : "";
    profile.test = `${prefix}pytest`;
    profile.build = null;
    profile.lint =
      (await has("ruff.toml")) || (await has(".ruff.toml"))
        ? `${prefix}ruff check`
        : `${prefix}flake8`;
    profile.typecheck = (await has("pyrightconfig.json")) ? `${prefix}pyright` : `${prefix}mypy .`;
    profile.format =
      (await has("ruff.toml")) || (await has(".ruff.toml"))
        ? `${prefix}ruff format`
        : `${prefix}black`;
    // Framework-specific run commands
    if (await has("manage.py")) profile.run = `${prefix}python manage.py runserver`;
    else if ((await has("app.py")) || (await has("main.py")))
      profile.run = `${prefix}uvicorn main:app --reload`;
    return profile;
  }

  // .NET / C#
  if ((await has("global.json")) || (await hasExt(".csproj")) || (await hasExt(".sln"))) {
    profile.test = "dotnet test";
    profile.build = "dotnet build";
    profile.lint = "dotnet format --verify-no-changes";
    profile.typecheck = "dotnet build";
    profile.run = "dotnet run";
    profile.format = null;
    return profile;
  }

  // PHP
  if (await has("composer.json")) {
    profile.test = "vendor/bin/phpunit";
    profile.build = null;
    profile.lint = (await has("pint.json"))
      ? "vendor/bin/pint --test"
      : (await has(".php-cs-fixer.php")) || (await has(".php-cs-fixer.dist.php"))
        ? "vendor/bin/php-cs-fixer fix --dry-run"
        : null;
    profile.typecheck =
      (await has("phpstan.neon")) || (await has("phpstan.neon.dist"))
        ? "vendor/bin/phpstan analyse"
        : (await has("psalm.xml")) || (await has("psalm.xml.dist"))
          ? "vendor/bin/psalm"
          : null;
    profile.run = (await has("artisan")) ? "php artisan serve" : null;
    profile.format = (await has("pint.json"))
      ? "vendor/bin/pint"
      : (await has(".php-cs-fixer.php")) || (await has(".php-cs-fixer.dist.php"))
        ? "vendor/bin/php-cs-fixer fix"
        : null;
    return profile;
  }

  // Swift
  if (await has("Package.swift")) {
    profile.test = "swift test";
    profile.build = "swift build";
    profile.lint = (await has(".swiftlint.yml")) ? "swiftlint" : null;
    profile.typecheck = "swift build";
    profile.run = "swift run";
    profile.format = (await has(".swiftformat")) ? "swiftformat" : null;
    return profile;
  }

  // iOS / Xcode
  if ((await hasExt(".xcodeproj")) || (await hasExt(".xcworkspace"))) {
    profile.test =
      "xcodebuild test -scheme \"$(xcodebuild -list -json 2>/dev/null | python3 -c \"import json,sys;print(json.load(sys.stdin)['project']['schemes'][0])\")\" -destination 'platform=iOS Simulator,name=iPhone 16'";
    profile.build = "xcodebuild build";
    profile.lint = (await has(".swiftlint.yml")) ? "swiftlint" : null;
    profile.typecheck = "xcodebuild build";
    profile.run = null;
    return profile;
  }

  // Flutter / Dart
  if (await has("pubspec.yaml")) {
    profile.test = "flutter test";
    profile.build = "flutter build";
    profile.lint = "dart analyze";
    profile.typecheck = "dart analyze";
    profile.run = "flutter run";
    profile.format = "dart format";
    return profile;
  }

  // Elixir
  if (await has("mix.exs")) {
    profile.test = "mix test";
    profile.build = "mix compile";
    profile.lint = "mix credo";
    profile.typecheck = "mix dialyzer";
    profile.run = "mix phx.server";
    profile.format = "mix format";
    return profile;
  }

  // Ruby
  if (await has("Gemfile")) {
    profile.test = (await has("spec")) ? "bundle exec rspec" : "bundle exec rails test";
    profile.build = null;
    profile.lint = "bundle exec rubocop";
    profile.typecheck = null;
    profile.run = (await has("config.ru")) ? "bundle exec rails server" : null;
    profile.format = "bundle exec rubocop -a --fail-level error";
    return profile;
  }

  // Java/Kotlin — Gradle
  if ((await has("gradlew")) || (await has("build.gradle")) || (await has("build.gradle.kts"))) {
    const gw = (await has("gradlew")) ? "./gradlew" : "gradle";
    profile.test = `${gw} test`;
    profile.build = `${gw} build`;
    // Prefer spotless/ktlint if available, fallback to generic check
    const buildFile = (await has("build.gradle.kts"))
      ? await readSafe(join(cwd, "build.gradle.kts"))
      : await readSafe(join(cwd, "build.gradle"));
    if (buildFile.includes("spotless")) profile.lint = `${gw} spotlessCheck`;
    else if (buildFile.includes("ktlint")) profile.lint = `${gw} ktlintCheck`;
    else profile.lint = `${gw} check`;
    profile.typecheck = (await has("build.gradle.kts"))
      ? `${gw} compileKotlin`
      : `${gw} compileJava`;
    profile.run = `${gw} run`;
    profile.format = null; // spotless doesn't support single-file formatting
    return profile;
  }

  // Java — Maven
  if ((await has("pom.xml")) || (await has("mvnw"))) {
    const mvn = (await has("mvnw")) ? "./mvnw" : "mvn";
    profile.test = `${mvn} test`;
    profile.build = `${mvn} package`;
    profile.lint = `${mvn} checkstyle:check`;
    profile.typecheck = `${mvn} compile`;
    profile.run = `${mvn} exec:java`;
    return profile;
  }

  // C/C++ — CMake
  if (await has("CMakeLists.txt")) {
    profile.test = "ctest --test-dir build";
    profile.build = "cmake --build build";
    profile.lint = (await has(".clang-tidy")) ? "clang-tidy" : null;
    profile.typecheck = "cmake --build build";
    profile.run = null;
    return profile;
  }

  // C/C++ — Make
  if (await has("Makefile")) {
    profile.test = "make test";
    profile.build = "make";
    profile.lint = null;
    profile.typecheck = null;
    profile.run = "make run";
    return profile;
  }

  // Zig
  if ((await has("build.zig")) || (await has("build.zig.zon"))) {
    profile.test = "zig build test";
    profile.build = "zig build";
    profile.lint = "zig fmt --check src/";
    profile.typecheck = "zig build";
    profile.run = "zig build run";
    profile.format = "zig fmt";
    return profile;
  }

  // Haskell
  if (await has("stack.yaml")) {
    profile.test = "stack test";
    profile.build = "stack build";
    profile.lint = "hlint .";
    profile.typecheck = "stack build";
    profile.run = "stack run";
    profile.format = (await has(".ormolu"))
      ? "ormolu --mode inplace"
      : (await has(".fourmolu.yaml"))
        ? "fourmolu --mode inplace"
        : null;
    return profile;
  }

  // Scala
  if (await has("build.sbt")) {
    profile.test = "sbt test";
    profile.build = "sbt compile";
    profile.lint = (await has(".scalafmt.conf")) ? "scalafmt --check" : null;
    profile.typecheck = "sbt compile";
    profile.run = "sbt run";
    profile.format = (await has(".scalafmt.conf")) ? "scalafmt" : null;
    return profile;
  }

  // Clojure
  if ((await has("deps.edn")) || (await has("project.clj"))) {
    const tool = (await has("project.clj")) ? "lein" : "clj";
    profile.test = tool === "lein" ? "lein test" : "clj -M:test";
    profile.build = tool === "lein" ? "lein uberjar" : null;
    profile.lint = "clj-kondo --lint src";
    profile.typecheck = null;
    profile.run = tool === "lein" ? "lein run" : "clj -M -m core";
    return profile;
  }

  return profile;
}

/** Detect JS package manager by walking up to find a lockfile (handles monorepo sub-packages). */
async function detectJsPm(cwd: string): Promise<"pnpm" | "yarn" | "npm"> {
  const lockfiles: [string, "pnpm" | "yarn"][] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
  ];
  let dir = cwd;
  for (let i = 0; i < 5; i++) {
    for (const [file, pm] of lockfiles) {
      try {
        await access(join(dir, file));
        return pm;
      } catch {}
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "npm";
}

async function readPackageScripts(cwd: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"));
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

async function detectJsLinter(cwd: string, runner = ""): Promise<string | null> {
  const has = async (f: string) => {
    try {
      await access(join(cwd, f));
      return true;
    } catch {
      return false;
    }
  };
  const run = runner ? `${runner} ` : "";
  if ((await has("biome.json")) || (await has("biome.jsonc"))) return `${run}biome check .`;
  if ((await has("oxlintrc.json")) || (await has(".oxlintrc.json"))) return `${run}oxlint .`;
  if (
    (await has("eslint.config.js")) ||
    (await has("eslint.config.mjs")) ||
    (await has("eslint.config.ts")) ||
    (await has(".eslintrc")) ||
    (await has(".eslintrc.js")) ||
    (await has(".eslintrc.json")) ||
    (await has(".eslintrc.yml"))
  )
    return `${run}eslint .`;
  return null;
}

async function detectJsFormatter(cwd: string, runner = ""): Promise<string | null> {
  const has = async (f: string) => {
    try {
      await access(join(cwd, f));
      return true;
    } catch {
      return false;
    }
  };
  const run = runner ? `${runner} ` : "";
  if ((await has("biome.json")) || (await has("biome.jsonc"))) return `${run}biome format --write`;
  if ((await has("dprint.json")) || (await has("dprint.jsonc"))) return `${run}dprint fmt`;
  if (
    (await has(".prettierrc")) ||
    (await has(".prettierrc.js")) ||
    (await has(".prettierrc.json")) ||
    (await has(".prettierrc.yml")) ||
    (await has(".prettierrc.yaml")) ||
    (await has(".prettierrc.cjs")) ||
    (await has(".prettierrc.mjs")) ||
    (await has("prettier.config.js")) ||
    (await has("prettier.config.cjs")) ||
    (await has("prettier.config.mjs"))
  )
    return `${run}prettier --write`;
  return null;
}

/** Detect a combined format+lint fix command (biome check --write --unsafe chains both). */
async function detectFormatAndLint(cwd: string, runner = ""): Promise<string | null> {
  const has = async (f: string) => {
    try {
      await access(join(cwd, f));
      return true;
    } catch {
      return false;
    }
  };
  const run = runner ? `${runner} ` : "";
  if ((await has("biome.json")) || (await has("biome.jsonc"))) {
    // Chain: check --write --unsafe fixes format+lint, then lint --write --unsafe catches remaining lint autofixes
    return `${run}biome check --write --unsafe && ${run}biome lint --write --unsafe`;
  }
  return null;
}

async function detectJsTypecheck(cwd: string): Promise<string | null> {
  const has = async (f: string) => {
    try {
      await access(join(cwd, f));
      return true;
    } catch {
      return false;
    }
  };
  if (!(await has("tsconfig.json"))) return null;
  if ((await has("bun.lock")) || (await has("bun.lockb"))) return "bunx tsc --noEmit";
  if ((await has("deno.json")) || (await has("deno.lock"))) return "deno check .";
  const pm = await detectJsPm(cwd);
  return pm === "pnpm" ? "pnpm tsc --noEmit" : "npx tsc --noEmit";
}

/**
 * Detect the native lint + typecheck commands from config files, bypassing package.json scripts.
 * Used by pre-commit checks to run the actual tool, not arbitrary user scripts.
 * Returns commands joined with &&.
 */
export async function detectNativeChecks(cwd: string): Promise<string | null> {
  const has = async (f: string) => {
    try {
      await access(join(cwd, f));
      return true;
    } catch {
      return false;
    }
  };
  const cmds: string[] = [];

  // JS/TS — detect runner for local tool resolution
  const pm = await detectJsPm(cwd);
  const runner =
    (await has("bun.lock")) || (await has("bun.lockb"))
      ? "bunx"
      : pm === "pnpm"
        ? "pnpm exec"
        : (await has("package.json"))
          ? "npx"
          : "";
  const jsLint = await detectJsLinter(cwd, runner);
  if (jsLint) cmds.push(jsLint);
  const jsTc = await detectJsTypecheck(cwd);
  if (jsTc) cmds.push(jsTc);
  if (cmds.length > 0) return cmds.join(" && ");

  // Deno
  if ((await has("deno.json")) || (await has("deno.lock"))) return "deno lint && deno check .";

  // Rust
  if (await has("Cargo.toml")) return "cargo clippy && cargo check";

  // Go
  if (await has("go.mod")) {
    const lint =
      (await has(".golangci.yml")) || (await has(".golangci.yaml"))
        ? "golangci-lint run"
        : "go vet ./...";
    return `${lint} && go build ./...`;
  }

  // Python
  if ((await has("pyproject.toml")) || (await has("setup.py")) || (await has("requirements.txt"))) {
    const pm = (await has("uv.lock"))
      ? "uv run "
      : (await has("poetry.lock"))
        ? "poetry run "
        : (await has("Pipfile.lock"))
          ? "pipenv run "
          : "";
    const lint =
      (await has("ruff.toml")) || (await has(".ruff.toml")) ? `${pm}ruff check` : `${pm}flake8`;
    const tc = (await has("pyrightconfig.json")) ? `${pm}pyright` : `${pm}mypy .`;
    return `${lint} && ${tc}`;
  }

  // PHP
  if (await has("composer.json")) {
    if ((await has("phpstan.neon")) || (await has("phpstan.neon.dist")))
      return "vendor/bin/phpstan analyse";
    if ((await has("psalm.xml")) || (await has("psalm.xml.dist"))) return "vendor/bin/psalm";
    return null;
  }

  // Swift
  if ((await has("Package.swift")) && (await has(".swiftlint.yml"))) return "swiftlint";

  // Ruby
  if ((await has("Gemfile")) && (await has(".rubocop.yml"))) return "bundle exec rubocop";

  return null;
}

interface PackageInfo {
  name: string;
  path: string;
  toolchain: string | null;
  hasLint: boolean;
  hasTest: boolean;
  hasTypecheck: boolean;
}

async function discoverPackages(cwd: string): Promise<PackageInfo[]> {
  const has = async (f: string) => {
    try {
      await access(join(cwd, f));
      return true;
    } catch {
      return false;
    }
  };
  const packages: PackageInfo[] = [];

  // JS/TS workspaces (pnpm, yarn, npm)
  const workspaceGlobs = await getJsWorkspaceGlobs(cwd);
  if (workspaceGlobs.length > 0) {
    for (const glob of workspaceGlobs) {
      const base = glob.replace(/\/?\*.*$/, "");
      if (!base) continue;
      await scanDir(join(cwd, base), cwd, packages, "package.json");
    }
  }

  // Cargo workspaces
  if (await has("Cargo.toml")) {
    try {
      const cargo = await readFile(join(cwd, "Cargo.toml"), "utf-8");
      const membersMatch = cargo.match(/members\s*=\s*\[([\s\S]*?)\]/);
      if (membersMatch?.[1]) {
        const members =
          membersMatch[1].match(/["']([^"']+)["']/g)?.map((m) => m.replace(/["']/g, "")) ?? [];
        for (const member of members) {
          if (member.includes("*")) {
            await scanDir(join(cwd, member.replace(/\/?\*$/, "")), cwd, packages, "Cargo.toml");
          } else if (await has(join(member, "Cargo.toml"))) {
            await addPackage(packages, join(cwd, member), cwd);
          }
        }
      }
    } catch {}
  }

  // Go workspaces
  if (await has("go.work")) {
    try {
      const goWork = await readFile(join(cwd, "go.work"), "utf-8");
      const useMatch = goWork.match(/use\s*\(([\s\S]*?)\)/);
      const dirs = useMatch?.[1]
        ? (useMatch[1].match(/^\s*(\S+)/gm)?.map((d) => d.trim()) ?? [])
        : (goWork.match(/^use\s+(\S+)/gm)?.map((d) => d.replace(/^use\s+/, "").trim()) ?? []);
      for (const dir of dirs) {
        if (await has(join(dir, "go.mod"))) {
          await addPackage(packages, join(cwd, dir), cwd);
        }
      }
    } catch {}
  }

  return packages;
}

async function getJsWorkspaceGlobs(cwd: string): Promise<string[]> {
  const has = async (f: string) => {
    try {
      await access(join(cwd, f));
      return true;
    } catch {
      return false;
    }
  };
  if (await has("pnpm-workspace.yaml")) {
    try {
      const raw = await readFile(join(cwd, "pnpm-workspace.yaml"), "utf-8");
      const quoted = raw.match(/['"]([^'"]+)['"]/g)?.map((g) => g.replace(/['"]/g, "")) ?? [];
      if (quoted.length > 0) return quoted;
      const simple = raw.match(/^\s*-\s+(.+)$/gm);
      return simple?.map((line) => line.replace(/^\s*-\s+/, "").trim()).filter(Boolean) ?? [];
    } catch {}
  }
  if (await has("package.json")) {
    try {
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"));
      const w = pkg.workspaces;
      return Array.isArray(w) ? w : Array.isArray(w?.packages) ? w.packages : [];
    } catch {}
  }
  return [];
}

async function scanDir(
  dir: string,
  rootCwd: string,
  packages: PackageInfo[],
  marker: string,
): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgDir = join(dir, entry.name);
      try {
        await access(join(pkgDir, marker));
        await addPackage(packages, pkgDir, rootCwd);
      } catch {}
    }
  } catch {}
}

async function addPackage(packages: PackageInfo[], pkgDir: string, rootCwd: string): Promise<void> {
  const rel = pkgDir.replace(rootCwd, "").replace(/^\//, "");
  const profile = await detectProfile(pkgDir);
  let name = rel;
  try {
    try {
      await access(join(pkgDir, "package.json"));
      const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf-8"));
      if (pkg.name) name = pkg.name;
    } catch {
      try {
        await access(join(pkgDir, "Cargo.toml"));
        const cargo = await readFile(join(pkgDir, "Cargo.toml"), "utf-8");
        const nameMatch = cargo.match(/name\s*=\s*["']([^"']+)["']/);
        if (nameMatch?.[1]) name = nameMatch[1];
      } catch {}
    }
  } catch {}

  packages.push({
    name,
    path: rel,
    toolchain: profile.lint?.split(/\s/)[0] ?? profile.test?.split(/\s/)[0] ?? null,
    hasLint: !!profile.lint,
    hasTest: !!profile.test,
    hasTypecheck: !!profile.typecheck,
  });
}

function formatPackageList(packages: PackageInfo[]): string {
  if (packages.length === 0) return "No workspace packages found. This may not be a monorepo.";
  const lines = packages.map((p) => {
    const caps = [
      p.hasLint ? "lint" : null,
      p.hasTypecheck ? "typecheck" : null,
      p.hasTest ? "test" : null,
    ]
      .filter(Boolean)
      .join(", ");
    const toolLabel = p.toolchain ? ` (${p.toolchain})` : "";
    return `  ${p.name} — ${p.path}${toolLabel}${caps ? ` [${caps}]` : ""}`;
  });
  return `${String(packages.length)} packages:\n${lines.join("\n")}\n\nUse project(action: "lint", cwd: "<path>") to target a specific package.`;
}

// ─── Fix-flag rules for all supported linters/formatters ───
// Each entry: substring to match in command → transform to apply fix mode
const FIX_RULES: Array<{ match: string; apply: (cmd: string) => string }> = [
  // JS/TS
  {
    match: "biome",
    apply: (c) => {
      // biome check src/ → biome check --write src/  |  biome check . → biome check --write .
      const m = c.match(/(biome\s+\S+)(\s+)/);
      return m ? c.replace(m[0], `${m[1]} --write${m[2]}`) : `${c} --write`;
    },
  },
  { match: "eslint", apply: (c) => `${c} --fix` },
  { match: "oxlint", apply: (c) => `${c} --fix` },
  { match: "prettier", apply: (c) => c.replace("--check", "--write") },
  { match: "dprint check", apply: (c) => c.replace("dprint check", "dprint fmt") },
  { match: "rome", apply: (c) => c.replace(" .", " --apply .") },
  // Rust
  { match: "clippy", apply: (c) => `${c} --fix --allow-dirty` },
  { match: "cargo fmt", apply: (c) => c.replace("--check", "") },
  // Go
  { match: "golangci-lint", apply: (c) => `${c} --fix` },
  { match: "gofmt", apply: (c) => c.replace("gofmt", "gofmt -w") },
  { match: "goimports", apply: (c) => c.replace("goimports", "goimports -w") },
  // Python
  { match: "ruff check", apply: (c) => c.replace("ruff check", "ruff check --fix") },
  { match: "ruff format --check", apply: (c) => c.replace("--check", "") },
  { match: "black --check", apply: (c) => c.replace(" --check", "") },
  { match: "isort --check", apply: (c) => c.replace("--check", "").replace("--check-only", "") },
  { match: "autopep8", apply: (c) => `${c} --in-place --recursive` },
  // Ruby
  { match: "rubocop", apply: (c) => `${c} -a` },
  { match: "standardrb", apply: (c) => `${c} --fix` },
  // PHP
  { match: "php-cs-fixer", apply: (c) => c.replace("--dry-run", "").replace("fix --", "fix") },
  { match: "pint --test", apply: (c) => c.replace(" --test", "") },
  // JVM
  { match: "ktlint", apply: (c) => `${c} --format` },
  { match: "spotlessCheck", apply: (c) => c.replace("spotlessCheck", "spotlessApply") },
  // Swift
  { match: "swiftlint", apply: (c) => `${c} --fix` },
  { match: "swiftformat --lint", apply: (c) => c.replace(" --lint", "") },
  // Dart
  { match: "dart analyze", apply: (c) => c.replace("dart analyze", "dart fix --apply") },
  {
    match: "dart format --set-exit",
    apply: (c) => c.replace(/--set-exit\S*\s*/g, "").replace("--output=none", ""),
  },
  // C/C++
  { match: "clang-tidy", apply: (c) => c.replace("clang-tidy", "clang-tidy --fix") },
  { match: "clang-format --dry-run", apply: (c) => c.replace("--dry-run", "-i") },
  // Elixir
  { match: "mix format --check", apply: (c) => c.replace(" --check-formatted", "") },
  // Scala
  { match: "scalafmt --check", apply: (c) => c.replace(" --check", "") },
  { match: "scalafmtCheck", apply: (c) => c.replace("scalafmtCheck", "scalafmt") },
  { match: "scalafix --check", apply: (c) => c.replace(" --check", "") },
  // Zig
  { match: "zig fmt --check", apply: (c) => c.replace(" --check", "") },
  // Haskell
  { match: "hlint", apply: (c) => `${c} --refactor --refactor-options="--inplace"` },
  { match: "ormolu --mode check", apply: (c) => c.replace("--mode check", "--mode inplace") },
  { match: "fourmolu --mode check", apply: (c) => c.replace("--mode check", "--mode inplace") },
  // .NET
  { match: "dotnet format --verify", apply: (c) => c.replace(" --verify-no-changes", "") },
  // Lua
  { match: "stylua --check", apply: (c) => c.replace(" --check", "") },
  // Shell
  { match: "shfmt -d", apply: (c) => c.replace("shfmt -d", "shfmt -w") },
];

function applyFixFlag(command: string): string {
  for (const rule of FIX_RULES) {
    if (command.includes(rule.match)) return rule.apply(command);
  }
  return command;
}

export const projectTool = {
  name: "project",
  description:
    "[TIER-1] Verify after every edit — auto-detected toolchain. " +
    "Actions: check (typecheck+lint+test in parallel), test, build, lint, format, typecheck, run, list. " +
    "Use check after edits for full verification in one call. Fix only the failed step, then re-run just that action.",
  execute: async (args: ProjectArgs): Promise<ToolResult> => {
    const cwd = args.cwd ? join(process.cwd(), args.cwd) : process.cwd();

    if (args.action === "list") {
      const packages = await discoverPackages(cwd);
      return { success: true, output: formatPackageList(packages) };
    }

    const profile = await detectProfile(cwd);

    let command: string | null = null;
    let formatCoversLint = false;

    switch (args.action) {
      case "test": {
        command = profile.test;
        if (command && args.file) {
          command = `${command} ${shellQuote(args.file)}`;
        }
        break;
      }
      case "build":
        command = profile.build;
        break;
      case "format": {
        // Prefer formatAndLint (fixes both lint + format in one pass), then dedicated formatter, then lint --fix
        const isCombo = !!profile.formatAndLint;
        command = profile.formatAndLint ?? profile.format ?? profile.lint;
        if (command && !isCombo && !profile.format && !args.raw) {
          command = applyFixFlag(command);
        }
        if (command && args.file) {
          command = `${command} ${shellQuote(args.file)}`;
        }
        formatCoversLint = isCombo;
        break;
      }
      case "lint": {
        command = profile.lint;
        if (command && args.fix && !args.raw) {
          command = applyFixFlag(command);
        }
        if (command && args.file) {
          command = `${command} ${shellQuote(args.file)}`;
        }
        break;
      }
      case "typecheck":
        command = profile.typecheck;
        break;
      case "run":
        command = args.script ? await resolveRunScript(profile, args.script, cwd) : profile.run;
        break;
    }

    if (command && args.flags) {
      command = `${command} ${shellQuote(args.flags)}`;
    }

    const runCommand = async (cmd: string) => {
      const proc = Bun.spawn(bunShellArgs(cmd), {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...args.env },
      });
      const timeoutMs = args.timeout ?? getToolTimeoutMs();
      const timer = timeoutMs > 0 ? setTimeout(() => proc.kill(), timeoutMs) : null;
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      if (timer) clearTimeout(timer);
      return { stdout, stderr, exitCode };
    };

    // "check" runs typecheck + lint + test in parallel, reports all results
    if (args.action === "check") {
      const steps = [
        { name: "typecheck", cmd: profile.typecheck },
        { name: "lint", cmd: profile.lint },
        { name: "test", cmd: profile.test },
      ].filter((s): s is { name: string; cmd: string } => s.cmd != null);

      if (steps.length === 0) {
        return { success: false, output: "No typecheck, lint, or test commands detected." };
      }

      const results = await Promise.all(
        steps.map(async (step) => {
          const { stdout, stderr, exitCode } = await runCommand(step.cmd);
          const pass = exitCode === 0;
          const output = [stdout, stderr].filter(Boolean).join("\n").trim();
          return { name: step.name, pass, output };
        }),
      );

      const allPass = results.every((r) => r.pass);
      const lines = results.map((r) => {
        if (r.pass) return `✓ ${r.name}`;
        const preview = r.output.split("\n").slice(0, 10).join("\n");
        return `✗ ${r.name}\n${preview}`;
      });
      return { success: allPass, output: lines.join("\n\n") };
    }

    if (!command) {
      return {
        success: false,
        output: `No ${args.action} command detected for this project. Use shell to run manually.`,
        error: "no command",
      };
    }

    // Legacy fallback: if fix command fails with unknown-flag error, retry with older syntax
    const LEGACY_FIX: Record<string, string> = {
      "--write": "--apply", // biome pre-1.8
      "--apply": "--apply-unsafe", // biome/rome aggressive
      "--fix --allow-dirty": "--fix --allow-dirty --allow-staged", // cargo clippy
      " --fix": " autocorrect", // rubocop legacy
      "-a": "--auto-correct", // rubocop pre-1.30
      "--format": "-F", // ktlint pre-1.0
    };

    try {
      let { stdout, stderr, exitCode } = await runCommand(command);

      // Retry with legacy flag if the tool didn't recognize the modern flag
      if (exitCode !== 0 && args.fix) {
        const combined = [stdout, stderr].join("\n").toLowerCase();
        const isUnknownFlag =
          combined.includes("unknown") ||
          combined.includes("unrecognized") ||
          combined.includes("unexpected argument") ||
          combined.includes("invalid option");
        if (isUnknownFlag) {
          for (const [modern, legacy] of Object.entries(LEGACY_FIX)) {
            if (command.includes(modern)) {
              const fallback = command.replace(modern, legacy);
              const retry = await runCommand(fallback);
              stdout = retry.stdout;
              stderr = retry.stderr;
              exitCode = retry.exitCode;
              command = fallback;
              break;
            }
          }
        }
      }

      if (exitCode === null) {
        return {
          success: false,
          output: `${args.action} timed out after ${String((args.timeout ?? getToolTimeoutMs()) / 1000)}s`,
          error: "timeout",
        };
      }

      const compressed = compressShellOutputFull(
        [stdout, stderr].filter(Boolean).join("\n").trim(),
      );
      let output = compressed.text;
      if (compressed.original) {
        const teeFile = await saveTee(`project-${args.action}`, compressed.original);
        output += `\n[full output: ${teeFile}]`;
      }
      const MAX_OUTPUT = 10_000;
      const { text: truncated } = await truncateWithTee(
        output,
        MAX_OUTPUT,
        3000,
        5000,
        args.action,
      );

      const cmdLabel = `[${args.action}] ${command}`;
      if (exitCode === 0) {
        const warningMatch = output.match(/Found (\d+) warning/);
        const errorMatch = output.match(/Found (\d+) error/);
        const warnCount = warningMatch ? Number(warningMatch[1]) : 0;
        const errCount = errorMatch ? Number(errorMatch[1]) : 0;
        if (warnCount > 0 || errCount > 0) {
          const issues = [
            errCount > 0 ? `${String(errCount)} errors` : "",
            warnCount > 0 ? `${String(warnCount)} warnings` : "",
          ]
            .filter(Boolean)
            .join(", ");
          return {
            success: false,
            output: `${cmdLabel} — has ${issues}. Fix them or run with fix: true to auto-fix.\n${truncated}`,
            error: issues,
          };
        }
        const passMsg = formatCoversLint
          ? `${cmdLabel} — formatted & linted, all clean. No need to re-check.\n${truncated}`
          : `${cmdLabel} — passed.\n${truncated}`;
        return {
          success: true,
          output: passMsg,
        };
      }
      const flagHint =
        args.fix && !args.raw
          ? " If the fix flags are wrong for your tool version, retry with raw: true and provide your own flags."
          : "";
      return {
        success: false,
        output: `${cmdLabel} — failed (exit ${String(exitCode)}).${flagHint}\n${truncated}`,
        error: `exit ${String(exitCode)}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};

/**
 * Run the project's configured formatter on a single file.
 * Returns whether formatting was applied. Best-effort — failures return false.
 */
export async function formatFile(filePath: string, cwd?: string): Promise<boolean> {
  const effectiveCwd = cwd ?? process.cwd();
  const profile = await detectProfile(effectiveCwd);
  if (!profile.format) return false;

  const command = `${profile.format} ${shellQuote(filePath)}`;
  try {
    const proc = Bun.spawn(bunShellArgs(command), {
      cwd: effectiveCwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const timer = setTimeout(() => proc.kill(), 10_000);
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function resolveRunScript(
  profile: ProjectProfile,
  script: string,
  cwd: string,
): Promise<string | null> {
  const scripts = await readPackageScripts(cwd);
  if (scripts[script]) {
    const has = async (f: string) => {
      try {
        await access(join(cwd, f));
        return true;
      } catch {
        return false;
      }
    };
    if ((await has("bun.lock")) || (await has("bun.lockb"))) return `bun run ${script}`;
    if (await has("pnpm-lock.yaml")) return `pnpm ${script}`;
    if (await has("yarn.lock")) return `yarn ${script}`;
    return `npm run ${script}`;
  }
  return profile.run;
}
