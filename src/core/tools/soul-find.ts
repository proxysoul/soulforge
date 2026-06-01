import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import type { ToolResult } from "../../types";
import { getCwd } from "../cwd.js";
import { isForbidden } from "../security/forbidden.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";

interface SoulFindArgs {
  query: string;
  type?: string;
  limit?: number;
}

export const soulFindTool = {
  name: "soul_find",
  description:
    "[TIER-1] Fuzzy file and symbol search ranked by PageRank importance. Use when you don't know the exact name or file path. Supports multi-word queries.",

  createExecute: (repoMap?: IntelligenceClient) => {
    return async (args: SoulFindArgs): Promise<ToolResult> => {
      const { query } = args;
      const limit = args.limit ?? 20;
      const cwd = getCwd();

      const repoMapResults = repoMap?.isReady
        ? await searchIntelligenceClient(repoMap, query, cwd, limit)
        : null;

      if (repoMapResults && repoMapResults.length > 0) {
        const symbolDetails = await buildSymbolDetails(repoMap, repoMapResults);
        return { success: true, output: symbolDetails };
      }

      const fileResults = await fuzzyFileSearch(query, args.type, limit);
      if (!fileResults.length) {
        return { success: true, output: `No files matching "${query}".` };
      }

      const enriched = repoMap?.isReady
        ? await enrichWithSymbols(repoMap, fileResults, cwd)
        : fileResults.map((f: string) => `  ${relative(cwd, resolve(f))}`).join("\n");

      return {
        success: true,
        output: `${String(fileResults.length)} files matching "${query}":\n\n${enriched}`,
      };
    };
  },
};

interface RankedFile {
  path: string;
  relPath: string;
  score: number;
  matchType: "symbol" | "file" | "both";
  symbols: Array<{ name: string; kind: string }>;
}

async function searchIntelligenceClient(
  repoMap: IntelligenceClient,
  query: string,
  cwd: string,
  limit: number,
): Promise<RankedFile[]> {
  const fileMap = new Map<string, RankedFile>();
  const words = query.split(/\s+/).filter((w: string) => w.length >= 2);
  const primaryWord = words[0] ?? query;

  const exactSymbols = await repoMap.findSymbols(primaryWord);
  for (const sym of exactSymbols) {
    const rel = relative(cwd, sym.path);
    upsertFile(fileMap, rel, sym.path, sym.pagerank + 10, { name: primaryWord, kind: sym.kind });
  }

  const substringSymbols = await repoMap.searchSymbolsSubstring(primaryWord, 30);
  for (const sym of substringSymbols) {
    const rel = relative(cwd, sym.path);
    upsertFile(fileMap, rel, sym.path, sym.pagerank + 3, { name: sym.name, kind: sym.kind });
  }

  for (const word of words.slice(1)) {
    const extra = await repoMap.searchSymbolsSubstring(word, 15);
    for (const sym of extra) {
      const rel = relative(cwd, sym.path);
      const existing = fileMap.get(rel);
      if (existing) {
        existing.score += sym.pagerank + 5;
        if (!existing.symbols.some((s) => s.name === sym.name)) {
          existing.symbols.push({ name: sym.name, kind: sym.kind });
        }
      }
    }
  }

  const safeQuery = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
  const fileMatches = await repoMap.matchFiles(`%${safeQuery}%`, 30);
  for (const absPath of fileMatches) {
    const rel = relative(cwd, absPath);
    const nameScore = fuzzyScoreMultiWord(words, rel);
    const existing = fileMap.get(rel);
    if (existing) {
      existing.score += nameScore;
      existing.matchType = "both";
    } else {
      fileMap.set(rel, {
        path: absPath,
        relPath: rel,
        score: nameScore,
        matchType: "file",
        symbols: [],
      });
    }
  }

  if (words.length > 1) {
    for (const word of words) {
      const wordSafe = word.replace(/%/g, "\\%").replace(/_/g, "\\_");
      const wordFiles = await repoMap.matchFiles(`%${wordSafe}%`, 15);
      for (const absPath of wordFiles) {
        const rel = relative(cwd, absPath);
        if (!fileMap.has(rel)) {
          fileMap.set(rel, {
            path: absPath,
            relPath: rel,
            score: fuzzyScore(word, rel),
            matchType: "file",
            symbols: [],
          });
        }
      }
    }
  }

  const topFiles = [...fileMap.values()]
    .filter((f: RankedFile) => f.score > 0)
    .sort((a: RankedFile, b: RankedFile) => b.score - a.score)
    .slice(0, 5);

  for (const top of topFiles) {
    const cochanges = await repoMap.getFileCoChanges(top.relPath);
    for (const co of cochanges) {
      if (isForbidden(co.path) !== null) continue;
      const existing = fileMap.get(co.path);
      if (existing) {
        existing.score += Math.min(co.count, 5);
      } else {
        fileMap.set(co.path, {
          path: resolve(cwd, co.path),
          relPath: co.path,
          score: Math.min(co.count, 3),
          matchType: "file",
          symbols: [],
        });
      }
    }
  }

  const results = [...fileMap.values()].filter(
    (f: RankedFile) => isForbidden(f.relPath) === null && isForbidden(f.path) === null,
  );

  for (const f of results) {
    f.score *= fileTypePenalty(f.relPath);
  }

  return results.sort((a: RankedFile, b: RankedFile) => b.score - a.score).slice(0, limit);
}

const TEST_RE = new RegExp(
  [
    // Test directories (all languages)
    /(?:^|\/)(?:tests?|__tests__|specs?|__mocks__|__snapshots__|__fixtures__|fixtures|test_helpers?|test_support)\//
      .source,
    // JS/TS/Python/Ruby/Rust/Java/Kotlin/Scala/C#/Lua: .test.ext, .spec.ext
    /\.(test|spec|cy|stories)\.(ts|tsx|js|jsx|mjs|cjs|py|rb|rs|java|kt|scala|cs|lua)$/.source,
    // Go/Python/Ruby/Elixir/Erlang/C/C++/Dart/Clojure/Haskell/ML/Gleam/V/Zig/Nim: _test.ext
    /[_-](test|spec|tests|SUITE)\.(go|py|rb|exs|erl|cpp|c|dart|clj|hs|ml|gleam|v|zig|nim)$/.source,
    // Python: test_*.py, conftest.py; C/C++: test_*.c; Lua/Nim/ML/Zig: test_*.ext
    /(?:^|\/)(?:test_[^/]+\.(py|cpp|c|lua|nim|ml|zig)|conftest\.py)$/.source,
    // Java/Kotlin/Scala/C#/Swift/PHP: ClassTest.java, ClassSpec.scala
    /(?:Test|Tests|IT|Spec|Suite)\.(java|kt|scala|cs|swift|php)$/.source,
    // E2E & integration: cypress, playwright, e2e
    /(?:^|\/)(?:cypress|playwright|e2e)\//.source,
    // Android: src/androidTest/, src/test/java/
    /(?:^|\/)src\/(?:androidTest|test\/java)\//.source,
    // iOS/Swift: *Tests/, *UITests/ directories
    /(?:^\/|\/)[A-Z][^/]*(?:UI)?Tests\//.source,
    // Flutter/Dart: test_driver/, integration_test/
    /(?:^|\/)(?:test_driver|integration_test)\//.source,
    // Go benchmarks
    /_bench_test\.go$/.source,
  ].join("|"),
  "i",
);

const DOCS_RE = new RegExp(
  [
    /\.(?:md|mdx|txt|rst|adoc)$/.source,
    /(?:^|\/)(?:docs?|documentation|javadoc|man|examples?|demos?|samples?)\//.source,
    /(?:^|\/)(?:README|CHANGELOG|CHANGES|CONTRIBUTING|COPYING|INSTALL|LICEN[CS]E|CITATION|CODE_OF_CONDUCT|SECURITY)(?:\.|$)/
      .source,
  ].join("|"),
  "i",
);

const CONFIG_RE = /\.(?:json|ya?ml|toml|ini|cfg|conf|properties|xml)$|(?:^|\/)\.(?!\.)/i;

const JUNK_RE = new RegExp(
  [
    // OS metadata
    /(?:^|\/)(?:\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]+)$/.source,
    // AI tool config (tracked but not source code)
    /(?:^|\/)(?:\.claude|\.copilot|\.cursor|\.windsurf|\.aider|\.cline|\.codeium|\.tabnine|\.codex)\//
      .source,
    // Git internals & hooks
    /(?:^|\/)\.git\//.source,
    /(?:^|\/)(?:\.husky|\.changeset)\//.source,
    // Editor state (sometimes tracked)
    /(?:^|\/)\.vscode\/(?!extensions\.json|settings\.json|tasks\.json|launch\.json)/.source,
  ].join("|"),
  "i",
);

const GENERATED_RE = new RegExp(
  [
    // Build output (universal)
    /(?:^|\/)(?:dist|build|out|target|obj|_build|ebin|coverage|htmlcov|\.nyc_output|TestResults)\//
      .source,
    // JS/TS frameworks & compilers
    /(?:^|\/)(?:\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.output|\.parcel-cache|\.vite|\.bun|\.swc)\//
      .source,
    // TS build info
    /\.tsbuildinfo$/.source,
    // Mobile: Expo, iOS, Android, Flutter
    /(?:^|\/)(?:\.expo|DerivedData|Pods|Carthage\/Build|xcuserdata|\.dart_tool)\//.source,
    /(?:^|\/)(?:android\/build|ios\/build|\.flutter-plugins)/.source,
    // Python
    /(?:^|\/)(?:__pycache__|\.mypy_cache|\.pytest_cache|\.ruff_cache|\.tox|\.eggs?)\//.source,
    // PHP: Laravel, Symfony cache dirs
    /(?:^|\/)(?:storage\/framework\/cache|var\/cache|bootstrap\/cache)\//.source,
    // Java/Kotlin: Gradle, Eclipse, IntelliJ
    /(?:^|\/)(?:\.gradle|\.kotlin|\.settings|\.vs|\.idea)\//.source,
    // C/C++/Zig
    /(?:^|\/)(?:cmake-build-[^/]+|CMakeFiles|zig-cache|zig-out)\//.source,
    // Haskell/Elixir
    /(?:^|\/)(?:\.stack-work|dist-newstyle)\//.source,
    // Minified files & sourcemaps
    /[.-]min\.(js|css)$|\.(?:js|css)\.map$/.source,
  ].join("|"),
  "i",
);

const LOCK_RE =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.ya?ml|bun\.lockb?|bun\.lock|yarn\.lock|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|pdm\.lock|uv\.lock|Gopkg\.lock|Package\.resolved|deno\.lock|gradle\.lockfile|npm-shrinkwrap\.json|flake\.lock|pixi\.lock|\.terraform\.lock\.hcl)$/;

export function fileTypePenalty(relPath: string): number {
  if (GENERATED_RE.test(relPath)) return 0.05;
  if (LOCK_RE.test(relPath)) return 0.05;
  if (JUNK_RE.test(relPath)) return 0.1;
  if (DOCS_RE.test(relPath)) return 0.15;
  if (TEST_RE.test(relPath)) return 0.3;
  if (CONFIG_RE.test(relPath)) return 0.4;
  return 1;
}

function upsertFile(
  map: Map<string, RankedFile>,
  rel: string,
  absPath: string,
  scoreDelta: number,
  sym: { name: string; kind: string },
): void {
  const existing = map.get(rel);
  if (existing) {
    existing.score += scoreDelta;
    if (!existing.symbols.some((s) => s.name === sym.name)) {
      existing.symbols.push(sym);
    }
    existing.matchType = "both";
  } else {
    map.set(rel, {
      path: absPath,
      relPath: rel,
      score: scoreDelta,
      matchType: "symbol",
      symbols: [sym],
    });
  }
}

async function buildSymbolDetails(
  repoMap: IntelligenceClient | undefined,
  results: RankedFile[],
): Promise<string> {
  const lines: string[] = [`${String(results.length)} results:\n`];

  for (const r of results) {
    lines.push(`  ${r.relPath}`);

    if (repoMap) {
      const matchedNames = new Set(r.symbols.map((s: { name: string; kind: string }) => s.name));
      for (const sym of r.symbols.slice(0, 4)) {
        const sigs = await repoMap.getSymbolSignature(sym.name);
        const sig = sigs.find(
          (s: { path: string; signature: string | null }) =>
            s.path === r.relPath || s.path.endsWith(`/${r.relPath}`),
        );
        lines.push(`    ${sig?.signature ?? `${sym.kind} ${sym.name}`}`);
      }
      const allFileSymbols = await repoMap.getFileSymbols(r.relPath);
      const extra = allFileSymbols.filter((fs) => !matchedNames.has(fs.name)).slice(0, 3);
      if (extra.length > 0) {
        lines.push(
          `    also: ${extra.map((s) => `${s.name} :${String(s.line)}-${String(s.endLine)}`).join(", ")}`,
        );
      }
    } else {
      for (const sym of r.symbols.slice(0, 4)) {
        lines.push(`    ${sym.kind} ${sym.name}`);
      }
    }
  }

  lines.push("\nUse read(files=[{path, target, name}]) for precise symbol extraction.");
  return lines.join("\n");
}

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let lastMatch = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 1;
      if (ti === lastMatch + 1) {
        consecutive++;
        score += consecutive;
      } else {
        consecutive = 0;
      }
      const prev = t[ti - 1];
      if (ti === 0 || prev === "/" || prev === "-" || prev === "_" || prev === ".") {
        score += 5;
      }
      lastMatch = ti;
      qi++;
    }
  }

  return qi === q.length ? score : 0;
}

function fuzzyScoreMultiWord(words: string[], target: string): number {
  if (words.length <= 1) return fuzzyScore(words[0] ?? "", target);
  let total = 0;
  let matchedAll = true;
  for (const word of words) {
    const s = fuzzyScore(word, target);
    if (s === 0) matchedAll = false;
    total += s;
  }
  if (matchedAll) total *= 1.5;
  return total;
}

const TYPE_GLOBS: Record<string, string[]> = {
  test: ["*.test.*", "*.spec.*", "*_test.*", "*_spec.*", "*_tests.*"],
  component: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro"],
  config: ["*.config.*", "*.json", "*.yaml", "*.yml", "*.toml", "*.ini", "*.env*"],
  types: ["*.d.ts", "types.*", "types/*", "*.pyi", "*.rbi"],
  style: ["*.css", "*.scss", "*.less", "*.sass", "*.styled.*"],
};

const EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "target",
  "vendor",
  ".turbo",
  "coverage",
];

async function fuzzyFileSearch(
  query: string,
  typeFilter: string | undefined,
  limit: number,
): Promise<string[]> {
  const files = await listFiles(typeFilter);
  if (files.length === 0) return [];

  const words = query.split(/\s+/).filter((w) => w.length >= 2);
  const scored = files
    .filter((f) => isForbidden(f) === null)
    .map((f) => ({ file: f, score: fuzzyScoreMultiWord(words, f) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((s) => s.file);
}

function listFiles(typeFilter: string | undefined): Promise<string[]> {
  return new Promise((res) => {
    const args = ["--type", "f", "--max-depth", "8"];

    if (typeFilter && TYPE_GLOBS[typeFilter]) {
      for (const g of TYPE_GLOBS[typeFilter]) {
        args.push("--glob", g);
      }
    }

    args.push("--max-results", "500");
    args.push(".");

    const proc = spawn("fd", args, { cwd: getCwd(), timeout: 10_000 });
    const chunks: string[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));

    proc.on("close", (code: number | null) => {
      if (code === 0) {
        res(chunks.join("").split("\n").filter(Boolean));
      } else {
        fallbackFind(typeFilter).then(res);
      }
    });

    proc.on("error", () => {
      fallbackFind(typeFilter).then(res);
    });
  });
}

function fallbackFind(typeFilter: string | undefined): Promise<string[]> {
  return new Promise((res) => {
    const excludes = EXCLUDED_DIRS.flatMap((d) => ["-not", "-path", `*/${d}/*`]);
    const args = [".", "-type", "f", "-maxdepth", "5", ...excludes];

    if (typeFilter && TYPE_GLOBS[typeFilter]) {
      const globs = TYPE_GLOBS[typeFilter];
      const nameArgs = globs.flatMap((g, i) => (i === 0 ? ["-name", g] : ["-o", "-name", g]));
      args.push("(", ...nameArgs, ")");
    }

    const proc = spawn("find", args, { cwd: getCwd(), timeout: 10_000 });
    const chunks: string[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));

    proc.on("close", () => {
      res(chunks.join("").split("\n").filter(Boolean).slice(0, 500));
    });

    proc.on("error", () => res([]));
  });
}

async function enrichWithSymbols(
  repoMap: IntelligenceClient,
  files: string[],
  cwd: string,
): Promise<string> {
  const results: string[] = [];
  for (const f of files) {
    const rel = relative(cwd, resolve(f));
    const syms = await repoMap.getFileSymbols(rel);
    const symStr =
      syms.length > 0
        ? `\n    ${syms
            .slice(0, 5)
            .map((s: { kind: string; name: string }) => `${s.kind} ${s.name}`)
            .join(", ")}`
        : "";
    results.push(`  ${rel}${symStr}`);
  }
  return results.join("\n");
}
