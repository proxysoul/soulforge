import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { IGNORED_DIRS } from "../context/file-tree.js";
import { isForbidden } from "../security/forbidden.js";
import type { Language, SymbolKind } from "./types.js";
import { BARE_FILENAME_TO_LANGUAGE, detectLanguageFromPath, EXT_TO_LANGUAGE } from "./types.js";

/**
 * Indexable extension set — derived from the canonical EXT_TO_LANGUAGE map.
 * Single source of truth: edit src/core/intelligence/types.ts.
 */
export const INDEXABLE_EXTENSIONS: Readonly<Record<string, Language>> = EXT_TO_LANGUAGE;

/**
 * Languages tracked in the file list but excluded from identifier-ref extraction,
 * PageRank, and dead-code analysis. Their text content (JSON keys, YAML fields,
 * markdown prose, config values) would pollute the cross-file reference graph
 * with false edges. Derived: everything that isn't a real programming language.
 */
export const NON_CODE_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  "unknown",
  "css",
  "html",
  "json",
  "jsonnet",
  "toml",
  "yaml",
  "xml",
  "markdown",
  "mdx",
  "sql",
  "graphql",
  "proto",
  "properties",
  "ini",
  "env",
  "dockerfile",
  "makefile",
  "nix",
  "hcl",
  "bazel",
  "just",
  "svg",
  "csv",
  "ignore",
  "lockfile",
]);

/**
 * True when a file path is indexable — covers both extension-based languages
 * (.ts, .py, .nix, .hcl, …) and bare-filename languages (Dockerfile, Makefile,
 * Justfile, BUILD, .gitignore, package-lock.json, …). Prefer over manual
 * `ext in INDEXABLE_EXTENSIONS` checks so dotfiles + extensionless config files
 * don't slip out of the index.
 */
export function isIndexablePath(file: string): boolean {
  return detectLanguageFromPath(file) !== "unknown" || isBareIndexable(file);
}

function isBareIndexable(file: string): boolean {
  const slash = file.lastIndexOf("/");
  const base = (slash === -1 ? file : file.slice(slash + 1)).toLowerCase();
  if (BARE_FILENAME_TO_LANGUAGE[base]) return true;
  return (
    base.startsWith("dockerfile.") ||
    base.startsWith("containerfile.") ||
    base.startsWith("makefile.") ||
    base.startsWith("justfile.")
  );
}

/**
 * Languages where we can reliably track cross-file imports via tree-sitter queries.
 * Files in other languages should not be classified as "dead" because we can't
 * determine their usage via import graph analysis alone — they may be loaded
 * via filesystem, process spawn, runtime include, or other non-import mechanisms.
 */
export const IMPORT_TRACKABLE_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "scala",
  "dart",
  "ocaml",
  "objc",
  "solidity",
]);

const BARREL_RE = /\/(index\.(ts|js|tsx|mts|mjs)|__init__\.py|mod\.rs)$/;

export function barrelToDir(barrelPath: string): string {
  return barrelPath.replace(BARREL_RE, "");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function extractSignature(lines: string[], lineIdx: number, kind: string): string | null {
  const line = lines[lineIdx];
  if (!line) return null;

  let sig = line.trimStart();

  // For functions/methods, capture up to the opening brace or end of params
  if (kind === "function" || kind === "method") {
    // If the signature spans multiple lines (params not closed), grab up to 2 more
    if (!sig.includes(")") && !sig.includes("{") && !sig.includes("=>")) {
      for (let i = 1; i <= 2; i++) {
        const next = lines[lineIdx + i];
        if (!next) break;
        sig += ` ${next.trim()}`;
        if (next.includes(")") || next.includes("{")) break;
      }
    }
  }

  // Strip body: remove everything after opening brace
  const braceIdx = sig.indexOf("{");
  if (braceIdx > 0) sig = sig.slice(0, braceIdx).trimEnd();

  // Strip trailing body markers
  sig = sig.replace(/\s*[{:]\s*$/, "").trimEnd();

  // Cap length for token budget
  if (sig.length > 120) sig = `${sig.slice(0, 117)}...`;

  return sig || null;
}

export function kindTag(kind: SymbolKind): string {
  switch (kind) {
    case "function":
    case "method":
      return "f:";
    case "class":
      return "c:";
    case "interface":
      return "i:";
    case "type":
      return "t:";
    case "variable":
    case "constant":
      return "v:";
    case "enum":
      return "e:";
    default:
      return "";
  }
}

/**
 * Extract a doc comment immediately above the symbol line and return
 * a one-line summary (max 80 chars). Handles:
 * - JSDoc/Javadoc: /** ... * /
 * - Rust/Go/C#: /// or // comment block
 * - Python: docstring (first """...""" or '''...''' inside function body)
 * - Hash comments: # comment block (Ruby, Python standalone)
 */
export function extractDocComment(lines: string[], symbolLineIdx: number): string | null {
  // --- Python docstring: first line inside the body ---
  const symbolLine = lines[symbolLineIdx];
  if (symbolLine && /^\s*(def |class |async def )/.test(symbolLine)) {
    for (let k = symbolLineIdx + 1; k < Math.min(symbolLineIdx + 3, lines.length); k++) {
      const trimmed = lines[k]?.trim() ?? "";
      const tripleMatch = /^("""|''')(.*)/.exec(trimmed);
      if (tripleMatch) {
        const quote = tripleMatch[1] as string;
        const rest = tripleMatch[2] ?? "";
        if (rest.includes(quote)) {
          return trimDocLine(rest.slice(0, rest.indexOf(quote)));
        }
        const docLines = [rest];
        for (let j = k + 1; j < Math.min(k + 10, lines.length); j++) {
          const dl = lines[j]?.trim() ?? "";
          if (dl.includes(quote)) {
            docLines.push(dl.slice(0, dl.indexOf(quote)));
            break;
          }
          docLines.push(dl);
        }
        return trimDocLine(docLines.filter(Boolean).join(" "));
      }
      if (trimmed) break;
    }
  }

  // --- JSDoc / Javadoc: /** ... */ above symbol ---
  for (let k = symbolLineIdx - 1; k >= Math.max(0, symbolLineIdx - 2); k--) {
    const trimmed = lines[k]?.trim() ?? "";
    if (trimmed === "" || trimmed === "*/" || trimmed.startsWith("*/")) continue;
    if (trimmed.startsWith("*/")) continue;
    if (trimmed.endsWith("*/")) {
      // Single-line /** summary */
      const m = /^\/\*\*?\s*(.*?)\s*\*\/$/.exec(trimmed);
      if (m?.[1]) return trimDocLine(m[1]);
    }
    if (trimmed.startsWith("/**") || trimmed.startsWith("/*")) {
      // Find closing */
      const collected: string[] = [];
      const firstContent = trimmed
        .replace(/^\/\*\*?\s*/, "")
        .replace(/\*\/\s*$/, "")
        .trim();
      if (firstContent) collected.push(firstContent);
      for (let j = k + 1; j < symbolLineIdx; j++) {
        const cl = (lines[j]?.trim() ?? "")
          .replace(/^\*\s?/, "")
          .replace(/\*\/\s*$/, "")
          .trim();
        if (cl.startsWith("@")) break;
        if (cl) collected.push(cl);
      }
      if (collected.length > 0) return trimDocLine(collected.join(" "));
    }
    break;
  }

  // --- /// doc comments (Rust) or // comment block (Go, TS) ---
  let commentEnd = symbolLineIdx - 1;
  if (commentEnd >= 0 && (lines[commentEnd]?.trim() ?? "") === "") commentEnd--;
  if (commentEnd >= 0) {
    const first = lines[commentEnd]?.trim() ?? "";
    if (first.startsWith("///") || first.startsWith("//")) {
      const isTriple = first.startsWith("///");
      const prefix = isTriple ? "///" : "//";
      const collected: string[] = [];
      let k = commentEnd;
      while (k >= 0 && (lines[k]?.trim() ?? "").startsWith(prefix)) {
        collected.unshift((lines[k]?.trim() ?? "").slice(prefix.length).trim());
        k--;
      }
      if (collected.length > 0) return trimDocLine(collected.join(" "));
    }

    // --- # comment block (Ruby, Python) ---
    if (first.startsWith("#") && !first.startsWith("#!")) {
      const collected: string[] = [];
      let k = commentEnd;
      while (k >= 0 && (lines[k]?.trim() ?? "").startsWith("#")) {
        collected.unshift((lines[k]?.trim() ?? "").slice(1).trim());
        k--;
      }
      if (collected.length > 0) return trimDocLine(collected.join(" "));
    }
  }

  return null;
}

function trimDocLine(text: string): string | null {
  let s = text.replace(/\s+/g, " ").trim();
  if (!s || s.length < 5) return null;
  if (s.length > 80) s = `${s.slice(0, 77)}...`;
  return s;
}

function splitIdentifier(name: string): string[] {
  if (name.includes("_"))
    return name
      .split("_")
      .filter(Boolean)
      .map((w) => w.toLowerCase());
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(" ")
    .map((w) => w.toLowerCase());
}

export function generateSyntheticSummary(name: string, kind: string, filePath: string): string {
  const words = splitIdentifier(name);
  const parts = filePath.split("/");
  const dir = parts.length >= 2 ? parts[parts.length - 2] : "";
  const kindLabel = kind === "function" || kind === "method" ? kind : kind;
  const summary = `${dir ? `[${dir}] ` : ""}${kindLabel}: ${words.join(" ")}`;
  return summary.length > 80 ? `${summary.slice(0, 77)}...` : summary;
}

export function getDirGroup(filePath: string): string | null {
  const parts = filePath.split("/");
  if (parts.length < 2) return null;
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? null);
}

// Directories that are never valid project roots — scanning them would
// crawl millions of files. Git repos at these paths are fine (git ls-files
// scopes the listing), so this only blocks the non-git fallback walk.
const DANGEROUS_ROOTS = new Set([
  resolve(homedir()),
  "/",
  "/tmp",
  "/var",
  "/usr",
  "/opt",
  "/home",
  "/Users",
]);

export function isDangerousRoot(dir: string): boolean {
  return DANGEROUS_ROOTS.has(resolve(dir));
}

export interface CollectResult {
  files: CollectedFile[];
  warning?: string;
}

export async function collectFiles(dir: string, depth = 0): Promise<CollectResult> {
  // Try git ls-files first — respects .gitignore automatically
  if (depth === 0) {
    const gitFiles = await collectFilesViaGit(dir);
    if (gitFiles) return { files: gitFiles };
    // Non-git dangerous roots (home dir, /, /tmp, etc.) — don't walk
    if (isDangerousRoot(dir))
      return {
        files: [],
        warning:
          "Opened in home directory or system root — no files indexed. Open a project directory instead.",
      };
  }
  // Fallback walk — shared accumulator so the 60s timeout returns partial results
  const collected: CollectedFile[] = [];
  let hitCap = false;
  const walkDone = collectFilesWalk(dir, depth, undefined, collected).then(() => {
    hitCap = collected.length >= WALK_FILE_CAP;
  });
  const timedOut = await Promise.race([
    walkDone.then(() => false),
    new Promise<true>((r) => setTimeout(() => r(true), 60_000)),
  ]);
  const warning = timedOut
    ? `Walk timeout — indexed ${String(collected.length)} of possibly more files (60s limit)`
    : hitCap
      ? `Large directory — capped file walk at ${String(WALK_FILE_CAP)} files`
      : undefined;
  return { files: collected, warning };
}

/**
 * Use `git ls-files` to collect tracked + untracked (but not ignored) files.
 * Returns null if not a git repo or git is unavailable.
 */
async function collectFilesViaGit(dir: string): Promise<CollectedFile[] | null> {
  try {
    const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "ignore",
    });
    const code = await Promise.race([
      proc.exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 30_000)),
    ]);
    if (code === "timeout") {
      proc.kill();
      return null;
    }
    const text = await new Response(proc.stdout).text();
    if (code !== 0) return null;

    const files: CollectedFile[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      if (!isIndexablePath(line)) continue;
      const fullPath = join(dir, line);
      if (isForbidden(fullPath)) continue;
      try {
        const s = await stat(fullPath);
        if (s.size < MAX_FILE_SIZE) files.push({ path: fullPath, mtimeMs: s.mtimeMs });
      } catch {}
      if (files.length % 50 === 0) await new Promise<void>((r) => setTimeout(r, 0));
    }
    return files;
  } catch {
    return null;
  }
}

// Hard cap during walk — stop collecting once we have enough candidates.
// Prevents scanning millions of files when opened in $HOME or a monorepo root.
const WALK_FILE_CAP = 50_000;

/** Fallback: manual directory walk for non-git repos. */
async function collectFilesWalk(
  dir: string,
  depth: number,
  counter?: { n: number },
  out?: CollectedFile[],
): Promise<CollectedFile[]> {
  if (depth > MAX_DEPTH) return [];
  const ctx = counter ?? { n: 0 };
  const files = out ?? [];
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (ctx.n >= WALK_FILE_CAP) break;
      // Skip hidden dirs/files except known dot-prefixed config files (.gitignore,
      // .env, .editorconfig, .dockerignore, …) that detectLanguageFromPath knows.
      if (entry.name.startsWith(".") && entry.name !== ".") {
        if (!entry.isFile() || !isIndexablePath(entry.name)) continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await collectFilesWalk(fullPath, depth + 1, ctx, files);
        }
      } else if (entry.isFile()) {
        if (isForbidden(fullPath)) continue;
        if (isIndexablePath(entry.name)) {
          try {
            const s = await stat(fullPath);
            if (s.size < MAX_FILE_SIZE) {
              files.push({ path: fullPath, mtimeMs: s.mtimeMs });
              ctx.n++;
            }
          } catch {}
        }
      }
      if (ctx.n % 50 === 0) await new Promise<void>((r) => setTimeout(r, 0));
    }
  } catch {}
  return files;
}

interface CollectedFile {
  path: string;
  mtimeMs: number;
}

const MAX_FILE_SIZE = 500_000;

const MAX_DEPTH = 10;

export const MAX_REFS_PER_FILE = 5000;

export const PAGERANK_ITERATIONS = 20;

export const PAGERANK_DAMPING = 0.85;

export const DEFAULT_TOKEN_BUDGET = 2500;

export const MIN_TOKEN_BUDGET = 1500;

export const MAX_TOKEN_BUDGET = 4000;

export const DIRTY_DEBOUNCE_MS = 500;

export const GIT_LOG_COMMITS = 300;

export const MAX_COCHANGE_FILES_PER_COMMIT = 20;

export const MAX_INDEXED_FILES = 10_000;
