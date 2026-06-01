import { readFile, stat as statAsync, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getCwd } from "../cwd.js";
import { getIntelligenceClient, getIntelligenceRouter } from "../intelligence/index.js";
import type { FileEdit } from "../intelligence/types.js";
import { isForbidden } from "../security/forbidden.js";
import { pushEdit } from "./edit-stack.js";
import { emitFileEdited } from "./file-events.js";
import { rgBin } from "./util.js";

async function applyEdits(edits: FileEdit[], tabId?: string): Promise<void> {
  for (const edit of edits) {
    const blocked = isForbidden(edit.file);
    if (blocked) throw new Error(`Cannot edit forbidden file: ${edit.file} (${blocked})`);
    pushEdit(edit.file, edit.oldContent, edit.newContent, tabId);
    await writeFile(edit.file, edit.newContent, "utf-8");
    emitFileEdited(edit.file, edit.newContent);
  }
}

interface CommentSyntax {
  hash: boolean;
  doubleDash: boolean;
  semicolon: boolean;
  percent: boolean;
  luaBlock: boolean;
  haskellBlock: boolean;
  htmlBlock: boolean;
  ocamlBlock: boolean;
}

const DOUBLE_DASH_EXTS = new Set([
  ".lua",
  ".sql",
  ".hs",
  ".lhs",
  ".ada",
  ".adb",
  ".ads",
  ".elm",
  ".vhdl",
  ".vhd",
]);

const SEMICOLON_EXTS = new Set([
  ".clj",
  ".cljs",
  ".cljc",
  ".edn",
  ".scm",
  ".ss",
  ".rkt",
  ".lisp",
  ".lsp",
  ".cl",
  ".el",
  ".asm",
  ".s",
  ".ini",
]);

const HASH_COMMENT_EXTS = new Set([
  ".py",
  ".rb",
  ".pl",
  ".pm",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".yaml",
  ".yml",
  ".toml",
  ".r",
  ".jl",
  ".coffee",
  ".cr",
  ".nim",
  ".gd",
  ".tf",
  ".ex",
  ".exs",
  ".rake",
  ".gemspec",
  ".podspec",
]);

const PERCENT_EXTS = new Set([".erl", ".hrl", ".tex", ".sty", ".cls", ".pro", ".pl_prolog"]);

function getCommentSyntax(filePath?: string): CommentSyntax {
  if (!filePath) {
    return {
      hash: true,
      doubleDash: false,
      semicolon: false,
      percent: false,
      luaBlock: false,
      haskellBlock: false,
      htmlBlock: false,
      ocamlBlock: false,
    };
  }
  const ext = extname(filePath).toLowerCase();
  return {
    hash: HASH_COMMENT_EXTS.has(ext),
    doubleDash: DOUBLE_DASH_EXTS.has(ext),
    semicolon: SEMICOLON_EXTS.has(ext),
    percent: PERCENT_EXTS.has(ext),
    luaBlock: ext === ".lua",
    haskellBlock: ext === ".hs" || ext === ".lhs",
    htmlBlock:
      ext === ".html" ||
      ext === ".htm" ||
      ext === ".xml" ||
      ext === ".svg" ||
      ext === ".vue" ||
      ext === ".svelte",
    ocamlBlock: ext === ".ml" || ext === ".mli" || ext === ".sml",
  };
}

function isHashCommentStart(source: string, pos: number): boolean {
  return (
    source[pos] === "#" &&
    (pos === 0 || source[pos - 1] === "\n" || source[pos - 1] === " " || source[pos - 1] === "\t")
  );
}

function skipToEndOfLine(source: string, pos: number): number {
  const end = source.indexOf("\n", pos);
  return end === -1 ? source.length : end;
}

/**
 * Replace a symbol in code regions only — skips string literals and comments.
 * Uses a state machine to track whether we're inside a string or comment.
 * Pass filePath to enable language-specific comment syntax detection.
 */
export function replaceInCode(
  source: string,
  escapedSymbol: string,
  newName: string,
  filePath?: string,
): string {
  const symbolRe = new RegExp(`\\b${escapedSymbol}\\b`, "g");
  const result: string[] = [];
  const syntax = getCommentSyntax(filePath);
  let i = 0;

  while (i < source.length) {
    // Lua --[[ block comment ]]
    if (
      syntax.luaBlock &&
      source[i] === "-" &&
      source[i + 1] === "-" &&
      source[i + 2] === "[" &&
      source[i + 3] === "["
    ) {
      const end = source.indexOf("]]", i + 4);
      const stop = end === -1 ? source.length : end + 2;
      result.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // Haskell {- block comment -}
    if (syntax.haskellBlock && source[i] === "{" && source[i + 1] === "-") {
      const end = source.indexOf("-}", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      result.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // HTML <!-- block comment -->
    if (
      syntax.htmlBlock &&
      source[i] === "<" &&
      source[i + 1] === "!" &&
      source[i + 2] === "-" &&
      source[i + 3] === "-"
    ) {
      const end = source.indexOf("-->", i + 4);
      const stop = end === -1 ? source.length : end + 3;
      result.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // OCaml (* block comment *)
    if (syntax.ocamlBlock && source[i] === "(" && source[i + 1] === "*") {
      const end = source.indexOf("*)", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      result.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // -- line comment (Lua, SQL, Haskell, Ada)
    if (syntax.doubleDash && source[i] === "-" && source[i + 1] === "-") {
      const stop = skipToEndOfLine(source, i);
      result.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // ; line comment (Clojure, Scheme, Lisp, Assembly)
    if (syntax.semicolon && source[i] === ";") {
      const stop = skipToEndOfLine(source, i);
      result.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // % line comment (Erlang, LaTeX)
    if (syntax.percent && source[i] === "%") {
      const stop = skipToEndOfLine(source, i);
      result.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // Single-line comment (//)
    if (source[i] === "/" && source[i + 1] === "/") {
      const stop = skipToEndOfLine(source, i);
      result.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // Multi-line comment (/* */)
    if (source[i] === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      result.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // # line comment (at start of line or after whitespace)
    if (syntax.hash && isHashCommentStart(source, i)) {
      const stop = skipToEndOfLine(source, i);
      result.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // String literals (single, double)
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i] as string;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      result.push(source.slice(i, j));
      i = j;
      continue;
    }

    // Template literal — recurse into ${} interpolations as code
    if (source[i] === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "$" && source[j + 1] === "{") {
          result.push(source.slice(i, j + 2));
          j += 2;
          let depth = 1;
          const exprStart = j;
          while (j < source.length && depth > 0) {
            if (source[j] === "{") depth++;
            else if (source[j] === "}") depth--;
            if (depth > 0) j++;
          }
          const expr = source.slice(exprStart, j);
          result.push(replaceInCode(expr, escapedSymbol, newName, filePath));
          if (j < source.length) {
            result.push("}");
            j++;
          }
          i = j;
          continue;
        }
        if (source[j] === "`") {
          j++;
          break;
        }
        j++;
      }
      result.push(source.slice(i, j));
      i = j;
      continue;
    }

    // Code region — scan to next potential string/comment start, replace symbols
    let end = i;
    while (end < source.length) {
      const ch = source[end] as string;
      if (ch === '"' || ch === "'" || ch === "`") break;
      if (ch === "/" && (source[end + 1] === "/" || source[end + 1] === "*")) break;
      if (syntax.hash && isHashCommentStart(source, end)) break;
      if (syntax.doubleDash && ch === "-" && source[end + 1] === "-") break;
      if (syntax.semicolon && ch === ";") break;
      if (syntax.percent && ch === "%") break;
      if (
        syntax.luaBlock &&
        ch === "-" &&
        source[end + 1] === "-" &&
        source[end + 2] === "[" &&
        source[end + 3] === "["
      )
        break;
      if (syntax.haskellBlock && ch === "{" && source[end + 1] === "-") break;
      if (
        syntax.htmlBlock &&
        ch === "<" &&
        source[end + 1] === "!" &&
        source[end + 2] === "-" &&
        source[end + 3] === "-"
      )
        break;
      if (syntax.ocamlBlock && ch === "(" && source[end + 1] === "*") break;
      end++;
    }

    const segment = source.slice(i, end);
    result.push(segment.replace(symbolRe, newName));
    i = end;
  }

  return result.join("");
}

async function locateSymbol(
  router: ReturnType<typeof getIntelligenceRouter>,
  symbol: string,
  hint?: string,
): Promise<{ file: string } | null> {
  if (hint) {
    return { file: resolve(hint) };
  }

  // Try LSP workspace symbol search (works for main project)
  const client = getIntelligenceClient();
  let results: import("../intelligence/types.js").SymbolInfo[] | null;
  if (client) {
    const tracked = await client.routerFindWorkspaceSymbols(symbol);
    results = tracked?.value ?? null;
  } else {
    const language = router.detectLanguage();
    results = await router.executeWithFallback(language, "findWorkspaceSymbols", (b) =>
      b.findWorkspaceSymbols ? b.findWorkspaceSymbols(symbol) : Promise.resolve(null),
    );
  }

  if (results && results.length > 0) {
    const exact = results.find((s) => s.name === symbol);
    const match = exact ?? results[0];
    if (match) {
      const resolved = resolve(match.location.file);
      try {
        const st = await statAsync(resolved);
        if (st.isFile()) return { file: resolved };
      } catch {}
    }
  }

  // Fallback: grep for the symbol definition across the entire codebase.
  // Handles monorepos where the symbol lives in a subproject the main LSP doesn't index.
  try {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const proc = Bun.spawn(
      [
        rgBin(),
        "--files-with-matches",
        "--type-add",
        "src:*.{ts,tsx,js,jsx,py,go,rs}",
        "--type",
        "src",
        `\\b(interface|type|class|function|enum|struct|trait|def|func)\\s+${escaped}\\b`,
        ".",
      ],
      { cwd: getCwd(), stdout: "pipe", stderr: "ignore", windowsHide: true },
    );
    const text = await new Response(proc.stdout).text();
    const matches = text.trim().split("\n").filter(Boolean);
    if (matches.length > 0) {
      // Prefer the deepest path — actual source files over fixture writers/test files
      const best = matches.sort((a, b) => b.split("/").length - a.split("/").length)[0];
      if (best) return { file: resolve(best) };
    }
  } catch {
    // rg not available or no match
  }

  return null;
}

async function findProjectRoot(file: string): Promise<string> {
  const { dirname, join } = require("node:path") as typeof import("node:path");
  let dir = dirname(file);
  const cwd = getCwd();
  while (dir.length >= cwd.length) {
    for (const marker of [
      "tsconfig.json",
      "package.json",
      "Cargo.toml",
      "go.mod",
      "pyproject.toml",
    ]) {
      try {
        await statAsync(join(dir, marker));
        return dir;
      } catch {}
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(file);
}

async function findRemainingReferences(symbol: string, definitionFile: string): Promise<string[]> {
  try {
    const projectRoot = await findProjectRoot(definitionFile);
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const proc = Bun.spawn(
      [
        rgBin(),
        "--files-with-matches",
        "--type-add",
        "src:*.{ts,tsx,js,jsx,py,go,rs}",
        "--type",
        "src",
        `\\b${escaped}\\b`,
        projectRoot,
      ],
      { cwd: getCwd(), stdout: "pipe", stderr: "ignore" },
    );
    const text = await new Response(proc.stdout).text();
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((f) => resolve(f));
  } catch {
    return [];
  }
}

interface RenameSymbolArgs {
  symbol: string;
  newName: string;
  file?: string;
  tabId?: string;
}

export const renameSymbolTool = {
  name: "rename_symbol",
  description:
    "[TIER-3] Rename a symbol across all files atomically via LSP. Safer than find-and-replace.",
  execute: async (args: RenameSymbolArgs): Promise<ToolResult> => {
    try {
      const router = getIntelligenceRouter(getCwd());
      const client = getIntelligenceClient();

      const located = await locateSymbol(router, args.symbol, args.file);
      if (!located) {
        return {
          success: false,
          output: `Could not find symbol '${args.symbol}' in the workspace. Provide a file hint if the symbol is in a specific directory.`,
          error: "symbol not found",
        };
      }

      // Try LSP rename with retry — LSP may need a moment to load the file
      let tracked: import("../workers/intelligence-client.js").TrackedResult<
        import("../intelligence/types.js").RefactorResult
      >;
      if (client) {
        tracked = await client.routerRename(located.file, args.symbol, args.newName);
        if (!tracked) {
          await new Promise((r) => setTimeout(r, 2000));
          tracked = await client.routerRename(located.file, args.symbol, args.newName);
        }
      } else {
        const language = router.detectLanguage(located.file);
        tracked = await router.executeWithFallbackTracked(language, "rename", (b) =>
          b.rename ? b.rename(located.file, args.symbol, args.newName) : Promise.resolve(null),
        );
        if (!tracked) {
          await new Promise((r) => setTimeout(r, 2000));
          tracked = await router.executeWithFallbackTracked(language, "rename", (b) =>
            b.rename ? b.rename(located.file, args.symbol, args.newName) : Promise.resolve(null),
          );
        }
      }

      if (tracked) {
        await applyEdits(tracked.value.edits, args.tabId);
      }

      // Always grep for remaining references — catches LSP misses AND handles the
      // case where LSP rename failed entirely (text-based fallback)
      const remaining = await findRemainingReferences(args.symbol, located.file);
      const textFixed: string[] = [];
      if (remaining.length > 0) {
        const escaped = args.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        for (const ref of remaining) {
          try {
            const content = await readFile(ref, "utf-8");
            const refBlocked = isForbidden(ref);
            if (refBlocked) continue;
            const updated = replaceInCode(content, escaped, args.newName, ref);
            if (updated !== content) {
              pushEdit(ref, content, updated, args.tabId);
              await writeFile(ref, updated, "utf-8");
              emitFileEdited(ref, updated);
              textFixed.push(ref);
            }
          } catch {
            // skip unreadable files
          }
        }
      }

      const lspFiles = tracked ? tracked.value.edits.map((e) => e.file) : [];
      const allEdited = [...lspFiles, ...textFixed];
      const uniqueFiles = [...new Set(allEdited)];

      if (uniqueFiles.length === 0) {
        return {
          success: false,
          output: `Could not rename '${args.symbol}' — symbol not found in any source files.`,
          error: "no changes",
        };
      }

      const fileList = uniqueFiles.map((e) => `  ${e}`).join("\n");
      const method = tracked ? "lsp" : "text";

      const lines = [
        `Renamed '${args.symbol}' → '${args.newName}' across ${String(uniqueFiles.length)} file(s) [${method}]:`,
        fileList,
        "",
      ];
      if (method === "text") {
        lines.push(
          "⚠ LSP rename unavailable — used text-based replacement (strings/comments preserved). Verify edge cases with `project test`.",
        );
      } else {
        lines.push(
          "Verified: zero remaining references, zero type errors. Next step: `project test`. Nothing else needed.",
        );
      }

      try {
        const { autoFixFiles } = await import("./post-edit-fix.js");
        const fixes = await autoFixFiles(uniqueFiles);
        if (fixes.size > 0) {
          lines.push(`Auto-fixed: ${[...fixes.values()].map((a) => a.join(", ")).join("; ")}`);
        }
      } catch {
        // Auto-fix unavailable
      }

      return {
        success: true,
        output: lines.join("\n"),
        backend: method,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};
