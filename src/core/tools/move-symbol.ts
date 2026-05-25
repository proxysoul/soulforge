import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getIntelligenceClient, getIntelligenceRouter } from "../intelligence/index.js";
import type { Language } from "../intelligence/types.js";
import { isForbidden } from "../security/forbidden.js";
import { pushEdit } from "./edit-stack.js";
import { emitFileEdited } from "./file-events.js";
import { rgBin } from "./util.js";

interface PendingWrite {
  path: string;
  content: string;
  original: string | null; // null = new file
}

class WriteTransaction {
  private writes: PendingWrite[] = [];
  private committed = false;
  private tabId?: string;

  constructor(tabId?: string) {
    this.tabId = tabId;
  }

  async stage(path: string, content: string): Promise<void> {
    let original: string | null = null;
    try {
      original = await readFile(path, "utf-8");
    } catch {
      // File does not exist
    }
    this.writes.push({ path, content, original });
  }

  async commit(): Promise<void> {
    for (const w of this.writes) {
      const blocked = isForbidden(w.path);
      if (blocked) throw new Error(`Cannot write forbidden file: ${w.path} (${blocked})`);
    }
    for (const w of this.writes) {
      const dir = dirname(w.path);
      await mkdir(dir, { recursive: true });
      if (w.original !== null) pushEdit(w.path, w.original, w.content, this.tabId);
      await writeFile(w.path, w.content, "utf-8");
      emitFileEdited(w.path, w.content);
    }
    this.committed = true;
  }

  async rollback(): Promise<void> {
    if (!this.committed) return;
    for (const w of [...this.writes].reverse()) {
      try {
        if (w.original === null) {
          // File was newly created — remove it
          await unlink(w.path);
        } else {
          await writeFile(w.path, w.original, "utf-8");
        }
      } catch {
        // Best-effort rollback
      }
    }
  }

  get paths(): string[] {
    return this.writes.map((w) => w.path);
  }
}

interface MoveSymbolArgs {
  symbol: string;
  from: string;
  to: string;
  tabId?: string;
}

interface ImportStatement {
  full: string;
  startLine: number;
  endLine: number;
  specifiers: string[];
  source: string;
  isType: boolean;
  isReExport: boolean;
}

interface LangImports {
  canAutoUpdate: boolean;
  parse(content: string): ImportStatement[];
  resolveSource(source: string, contextFile: string): string | null | Promise<string | null>;
  computePath(fromFile: string, toFile: string): string;
  generate(specs: string[], path: string, isType?: boolean): string;
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function line(lines: string[], i: number): string {
  return lines[i] ?? "";
}

export const tsJsHandler: LangImports = {
  canAutoUpdate: true,

  parse(content: string): ImportStatement[] {
    const result: ImportStatement[] = [];
    const lines = content.split("\n");
    let i = 0;
    while (i < lines.length) {
      const cur = lines[i] ?? "";
      const trimmed = cur.trim();
      const isImport = trimmed.startsWith("import ");
      const isReExport = trimmed.startsWith("export ") && trimmed.includes(" from ");
      const maybeMultilineReExport =
        !isImport && !isReExport && /^export\s+(type\s+)?\{/.test(trimmed);
      if (!isImport && !isReExport && !maybeMultilineReExport) {
        i++;
        continue;
      }

      let full = cur;
      let endIdx = i;
      if (full.includes("{") && !full.includes("}")) {
        for (let j = i + 1; j < lines.length; j++) {
          full += `\n${lines[j] ?? ""}`;
          endIdx = j;
          if ((lines[j] ?? "").includes("}")) break;
        }
      }

      const specMatch = full.match(/\{([^}]+)\}/);
      const srcMatch = full.match(/from\s+["']([^"']+)["']/);
      if (specMatch && srcMatch) {
        const specs = (specMatch[1] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const src = srcMatch[1] ?? "";
        result.push({
          full,
          startLine: i,
          endLine: endIdx,
          specifiers: specs,
          source: src,
          isType: /\btype\s+\{/.test(full),
          isReExport: !isImport,
        });
      }
      i = endIdx + 1;
    }
    return result;
  },

  async resolveSource(source: string, contextFile: string): Promise<string | null> {
    if (!source.startsWith(".")) return null;
    const dir = dirname(contextFile);
    const base = source.replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, "");
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      const p = resolve(dir, base + ext);
      try {
        await access(p);
        return p;
      } catch {
        // not found, try next
      }
    }
    return null;
  },

  computePath(fromFile: string, toFile: string): string {
    let rel = relative(dirname(fromFile), toFile).replace(/\.tsx?$/, ".js");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return rel;
  },

  generate(specs: string[], path: string, isType?: boolean): string {
    const tp = isType ? "type " : "";
    return `import ${tp}{ ${specs.join(", ")} } from "${path}";`;
  },
};

export const pythonHandler: LangImports = {
  canAutoUpdate: true,

  parse(content: string): ImportStatement[] {
    const result: ImportStatement[] = [];
    for (const [i, raw] of content.split("\n").entries()) {
      const m = (raw ?? "").match(/^from\s+(\S+)\s+import\s+(.+)$/);
      if (m) {
        const specs = (m[2] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        result.push({
          full: raw ?? "",
          startLine: i,
          endLine: i,
          specifiers: specs,
          source: m[1] ?? "",
          isType: false,
          isReExport: false,
        });
      }
    }
    return result;
  },

  async resolveSource(source: string, contextFile: string): Promise<string | null> {
    const fileExists = async (p: string): Promise<boolean> => {
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    };
    if (source.startsWith(".")) {
      const dots = source.match(/^(\.+)/);
      const dotStr = dots?.[1] ?? ".";
      const levels = dotStr.length - 1;
      let dir = dirname(contextFile);
      for (let i = 0; i < levels; i++) dir = dirname(dir);
      const parts = source.slice(dotStr.length).split(".");
      const modPath = resolve(dir, ...parts);
      if (await fileExists(`${modPath}.py`)) return `${modPath}.py`;
      if (await fileExists(resolve(modPath, "__init__.py"))) return resolve(modPath, "__init__.py");
      return null;
    }
    // Bare module name — check same directory (e.g. "from models import X")
    const parts = source.split(".");
    const modPath = resolve(dirname(contextFile), ...parts);
    if (await fileExists(`${modPath}.py`)) return `${modPath}.py`;
    if (await fileExists(resolve(modPath, "__init__.py"))) return resolve(modPath, "__init__.py");
    return null;
  },

  computePath(fromFile: string, toFile: string): string {
    const rel = relative(dirname(fromFile), toFile).replace(/\.py$/, "");
    const parts = rel.split("/");
    const upCount = parts.filter((p) => p === "..").length;
    const downParts = parts.filter((p) => p !== "..");
    if (upCount === 0) return downParts.join(".");
    return ".".repeat(upCount + 1) + downParts.join(".");
  },

  generate(specs: string[], path: string): string {
    return `from ${path} import ${specs.join(", ")}`;
  },
};

export const rustHandler: LangImports = {
  canAutoUpdate: true,

  parse(content: string): ImportStatement[] {
    const result: ImportStatement[] = [];
    for (const [i, raw] of content.split("\n").entries()) {
      const m = (raw ?? "").match(/^use\s+(.+);$/);
      if (!m) continue;
      const path = m[1] ?? "";
      const braceMatch = path.match(/^(.+)::\{(.+)\}$/);
      if (braceMatch) {
        result.push({
          full: raw ?? "",
          startLine: i,
          endLine: i,
          specifiers: (braceMatch[2] ?? "").split(",").map((s) => s.trim()),
          source: braceMatch[1] ?? "",
          isType: false,
          isReExport: false,
        });
      } else {
        const parts = path.split("::");
        const sym = parts.pop() ?? "";
        result.push({
          full: raw ?? "",
          startLine: i,
          endLine: i,
          specifiers: [sym],
          source: parts.join("::"),
          isType: false,
          isReExport: false,
        });
      }
    }
    return result;
  },

  resolveSource(): string | null {
    return null;
  },

  computePath(_fromFile: string, toFile: string): string {
    return relative(process.cwd(), toFile)
      .replace(/^src\//, "crate::")
      .replace(/\/mod\.rs$/, "")
      .replace(/\.rs$/, "")
      .replace(/\//g, "::");
  },

  generate(specs: string[], path: string): string {
    if (specs.length === 1) return `use ${path}::${specs[0]};`;
    return `use ${path}::{${specs.join(", ")}};`;
  },
};

const goHandler: LangImports = {
  canAutoUpdate: false,

  parse(content: string): ImportStatement[] {
    const result: ImportStatement[] = [];
    const lines = content.split("\n");
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = (lines[i] ?? "").trim();
      if (trimmed === "import (") {
        inBlock = true;
        continue;
      }
      if (inBlock && trimmed === ")") {
        inBlock = false;
        continue;
      }
      if (inBlock) {
        const m = trimmed.match(/^"([^"]+)"$/);
        if (m) {
          result.push({
            full: lines[i] ?? "",
            startLine: i,
            endLine: i,
            specifiers: [],
            source: m[1] ?? "",
            isType: false,
            isReExport: false,
          });
        }
        continue;
      }
      const single = trimmed.match(/^import\s+"([^"]+)"$/);
      if (single) {
        result.push({
          full: lines[i] ?? "",
          startLine: i,
          endLine: i,
          specifiers: [],
          source: single[1] ?? "",
          isType: false,
          isReExport: false,
        });
      }
    }
    return result;
  },

  resolveSource(): string | null {
    return null;
  },
  computePath(): string {
    return "";
  },
  generate(_s: string[], path: string): string {
    return `import "${path}"`;
  },
};

const cppHandler: LangImports = {
  canAutoUpdate: false,

  parse(content: string): ImportStatement[] {
    const result: ImportStatement[] = [];
    for (const [i, raw] of content.split("\n").entries()) {
      const m = (raw ?? "").match(/^#include\s+["<]([^">]+)[">]/);
      if (m) {
        result.push({
          full: raw ?? "",
          startLine: i,
          endLine: i,
          specifiers: [],
          source: m[1] ?? "",
          isType: false,
          isReExport: false,
        });
      }
    }
    return result;
  },

  async resolveSource(source: string, contextFile: string): Promise<string | null> {
    const p = resolve(dirname(contextFile), source);
    try {
      await access(p);
      return p;
    } catch {
      return null;
    }
  },

  computePath(fromFile: string, toFile: string): string {
    return relative(dirname(fromFile), toFile);
  },

  generate(_s: string[], path: string): string {
    return `#include "${path}"`;
  },
};

function getLangHandler(lang: Language): LangImports | null {
  switch (lang) {
    case "typescript":
    case "javascript":
      return tsJsHandler;
    case "python":
      return pythonHandler;
    case "rust":
      return rustHandler;
    case "go":
      return goHandler;
    case "c":
    case "cpp":
      return cppHandler;
    default:
      return null;
  }
}

export function findSymbolRange(
  lines: string[],
  symbol: string,
): { start: number; end: number } | null {
  const pat = new RegExp(
    `^\\s*(export\\s+)?(default\\s+)?(pub(\\(crate\\))?\\s+)?(interface|type|class|function|enum|const|let|var|struct|trait|impl|fn|def|func|abstract\\s+class)\\s+${esc(symbol)}\\b`,
  );

  for (let i = 0; i < lines.length; i++) {
    if (!pat.test(line(lines, i))) continue;
    let end = i;
    let depth = 0;
    let opened = false;
    for (let j = i; j < lines.length; j++) {
      for (const ch of line(lines, j)) {
        if (ch === "{") {
          depth++;
          opened = true;
        }
        if (ch === "}") depth--;
      }
      if (!opened && line(lines, j).trimEnd().endsWith(";")) {
        end = j;
        break;
      }
      if (opened && depth === 0) {
        end = j;
        break;
      }
    }
    return { start: i, end };
  }
  return null;
}

export function findCommentStart(lines: string[], defStart: number): number {
  let start = defStart;
  for (let i = defStart - 1; i >= 0; i--) {
    const t = line(lines, i).trim();
    if (
      t.startsWith("*") ||
      t.startsWith("/**") ||
      t.startsWith("///") ||
      t.startsWith("//") ||
      t === "*/"
    ) {
      start = i;
    } else {
      break;
    }
  }
  // Rust attributes (#[derive(...)])
  for (let i = start - 1; i >= 0; i--) {
    if (line(lines, i).trim().startsWith("#[")) {
      start = i;
    } else {
      break;
    }
  }
  return start;
}

async function findProjectRoot(file: string): Promise<string> {
  let dir = dirname(resolve(file));
  for (let depth = 0; depth < 20; depth++) {
    for (const m of [
      "tsconfig.json",
      "package.json",
      "Cargo.toml",
      "go.mod",
      "pyproject.toml",
      "Makefile",
    ]) {
      try {
        await access(resolve(dir, m));
        return dir;
      } catch {
        // not found, try next
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(file);
}

async function grepSymbol(symbol: string, root: string): Promise<string[]> {
  try {
    const proc = Bun.spawn(
      [
        rgBin(),
        "--files-with-matches",
        "--glob",
        "!node_modules",
        "--type-add",
        "src:*.{ts,tsx,js,jsx,py,go,rs,c,cpp,cc,h,hpp,java,kt,cs,rb,swift}",
        "--type",
        "src",
        `\\b${esc(symbol)}\\b`,
        root,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "ignore", windowsHide: true },
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

function findLastImportLine(lines: string[], language: Language): number {
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = line(lines, i).trim();
    const isImp =
      ((language === "typescript" || language === "javascript") && t.startsWith("import ")) ||
      (language === "python" && (t.startsWith("from ") || t.startsWith("import "))) ||
      (language === "rust" && t.startsWith("use ")) ||
      (language === "go" && t.startsWith("import ")) ||
      ((language === "c" || language === "cpp") && t.startsWith("#include "));
    if (isImp) last = i;
  }
  return last;
}

export const moveSymbolTool = {
  name: "move_symbol",
  description:
    "[TIER-3] Move a symbol between files with automatic import updates across the codebase.",
  execute: async (args: MoveSymbolArgs): Promise<ToolResult> => {
    try {
      const from = resolve(args.from);
      const to = resolve(args.to);

      try {
        await access(from);
      } catch {
        return {
          success: false,
          output: `Source file not found: ${from}`,
          error: "file not found",
        };
      }
      if (from === to) {
        return {
          success: false,
          output: "Source and target are the same file",
          error: "same file",
        };
      }

      const sourceContent = await readFile(from, "utf-8");
      const sourceLines = sourceContent.split("\n");
      const router = getIntelligenceRouter(process.cwd());
      const client = getIntelligenceClient();
      const language = router.detectLanguage(from);
      const handler = getLangHandler(language);

      // Priority: LSP readSymbol → LSP findSymbols (DocumentSymbol range) → regex fallback
      // LSP ranges handle JSX correctly; the regex brace-counter does not.
      let defStart: number;
      let defEnd: number;

      const block = await router.executeWithFallback(language, "readSymbol", (b) =>
        b.readSymbol ? b.readSymbol(from, args.symbol) : Promise.resolve(null),
      );

      if (block) {
        defStart = block.location.line - 1;
        defEnd = (block.location.endLine ?? block.location.line) - 1;
      } else {
        // Try LSP DocumentSymbol for accurate range (handles JSX, arrow functions, etc.)
        let symbols: import("../intelligence/types.js").SymbolInfo[] | null;
        if (client) {
          const tracked = await client.routerFindSymbols(from);
          symbols = tracked?.value ?? null;
        } else {
          symbols = await router.executeWithFallback(language, "findSymbols", (b) =>
            b.findSymbols ? b.findSymbols(from) : Promise.resolve(null),
          );
        }
        const match = symbols?.find((s) => s.name === args.symbol);
        if (match?.location.endLine) {
          defStart = match.location.line - 1;
          defEnd = match.location.endLine - 1;
        } else {
          // Last resort: regex brace-counting (unreliable for JSX)
          const found = findSymbolRange(sourceLines, args.symbol);
          if (!found) {
            return {
              success: false,
              output: `Symbol '${args.symbol}' not found in ${from}`,
              error: "symbol not found",
            };
          }
          defStart = found.start;
          defEnd = found.end;
        }
      }

      // Expand to include export/pub keyword (tree-sitter may start after it)
      if (defStart > 0) {
        const prev = line(sourceLines, defStart - 1).trim();
        if (prev === "export" || prev === "pub" || prev === "pub(crate)") defStart--;
      }

      const cmtStart = findCommentStart(sourceLines, defStart);
      const defText = sourceLines.slice(cmtStart, defEnd + 1).join("\n");
      const isExported = /^\s*(export|pub)\b/.test(line(sourceLines, defStart));

      const neededImportLines: string[] = [];

      if (handler) {
        const sourceImports = handler.parse(sourceContent);

        for (const imp of sourceImports) {
          if (imp.isReExport) continue;
          const used = imp.specifiers.filter((spec) => {
            const name = spec.includes(" as ")
              ? (spec.split(" as ").pop() ?? spec).trim()
              : spec.trim();
            return new RegExp(`\\b${esc(name)}\\b`).test(defText);
          });
          if (used.length > 0) {
            const resolved = await handler.resolveSource(imp.source, from);
            const path = resolved ? handler.computePath(to, resolved) : imp.source;
            neededImportLines.push(handler.generate(used, path, imp.isType));
          }
        }

        // References to other symbols defined in the same source file
        let allSymbols: import("../intelligence/types.js").SymbolInfo[] | null;
        if (client) {
          const tracked = await client.routerFindSymbols(from);
          allSymbols = tracked?.value ?? null;
        } else {
          allSymbols = await router.executeWithFallback(language, "findSymbols", (b) =>
            b.findSymbols ? b.findSymbols(from) : Promise.resolve(null),
          );
        }
        const TOP_LEVEL_KINDS = new Set([
          "function",
          "class",
          "interface",
          "type",
          "constant",
          "enum",
          "variable",
          "module",
          "namespace",
        ]);
        const internalDeps: string[] = [];
        if (allSymbols) {
          for (const sym of allSymbols) {
            if (
              sym.name !== args.symbol &&
              (!sym.containerName || sym.containerName === "") &&
              TOP_LEVEL_KINDS.has(sym.kind) &&
              new RegExp(`\\b${esc(sym.name)}\\b`).test(defText)
            ) {
              internalDeps.push(sym.name);
            }
          }
        }
        if (internalDeps.length > 0) {
          const fromPath = handler.computePath(to, from);
          neededImportLines.push(handler.generate(internalDeps, fromPath, true));
        }
      }

      let symbolForTarget = defText;
      if (!isExported && (language === "typescript" || language === "javascript")) {
        const tLines = symbolForTarget.split("\n");
        for (let i = 0; i < tLines.length; i++) {
          const t = (tLines[i] ?? "").trim();
          if (!t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/**") && t !== "*/") {
            tLines[i] = `export ${tLines[i] ?? ""}`;
            break;
          }
        }
        symbolForTarget = tLines.join("\n");
      }

      let targetContent: string;
      let existingContent: string | null = null;
      try {
        existingContent = await readFile(to, "utf-8");
      } catch {
        // File does not exist
      }
      if (existingContent !== null) {
        const existing = existingContent;
        targetContent = appendSymbolToFile(existing, neededImportLines, symbolForTarget, handler);
      } else {
        const parts: string[] = [];
        if (neededImportLines.length > 0) parts.push(neededImportLines.join("\n"), "");
        parts.push(symbolForTarget, "");
        targetContent = parts.join("\n");
      }

      const newSourceLines = [...sourceLines.slice(0, cmtStart), ...sourceLines.slice(defEnd + 1)];

      const idx = cmtStart;
      while (
        idx < newSourceLines.length &&
        idx > 0 &&
        (newSourceLines[idx] ?? "").trim() === "" &&
        (newSourceLines[idx - 1] ?? "").trim() === ""
      ) {
        newSourceLines.splice(idx, 1);
      }

      let newSource = newSourceLines.join("\n");

      if (language === "typescript" || language === "javascript") {
        const exportListRe = new RegExp(
          `(export\\s*\\{)([^}]*?)\\b${esc(args.symbol)}\\b,?\\s*([^}]*?)(\\})`,
          "g",
        );
        newSource = newSource.replace(
          exportListRe,
          (_m, open: string, before: string, after: string, close: string) => {
            const combined = `${before}${after}`
              .replace(/,\s*,/g, ",")
              .replace(/^\s*,|,\s*$/g, "")
              .trim();
            if (!combined) return "";
            return `${open} ${combined} ${close}`;
          },
        );
        newSource = newSource.replace(/export\s*\{\s*\}\s*;?\s*\n?/g, "");
      }

      if (handler) {
        const stripped = newSource.replace(/^\s*(import|use|from|#include)\b.*$/gm, "");
        if (new RegExp(`\\b${esc(args.symbol)}\\b`).test(stripped)) {
          const impPath = handler.computePath(from, to);
          const isTypeDef = /^\s*(export\s+)?(interface|type)\s/.test(line(sourceLines, defStart));
          const impLine = handler.generate([args.symbol], impPath, isTypeDef);
          const sLines = newSource.split("\n");
          const lastImp = findLastImportLine(sLines, language);
          sLines.splice(lastImp + 1, 0, impLine);
          newSource = sLines.join("\n");
        }
      }

      const tx = new WriteTransaction(args.tabId);
      await tx.stage(to, targetContent);
      await tx.stage(from, newSource);

      const projectRoot = await findProjectRoot(from);
      const candidates = await grepSymbol(args.symbol, projectRoot);
      const updatedFiles: string[] = [];
      const affectedFiles: string[] = [];

      for (const file of candidates) {
        if (file === from || file === to) continue;

        if (handler?.canAutoUpdate) {
          try {
            const content = await readFile(file, "utf-8");
            const imports = handler.parse(content);
            let modified = content;
            let changed = false;

            for (const imp of imports) {
              const hasSymbol = imp.specifiers.some((s) => {
                const name = s.includes(" as ") ? (s.split(" as ")[0]?.trim() ?? s) : s.trim();
                return name === args.symbol;
              });
              if (!hasSymbol) continue;

              const resolved = await handler.resolveSource(imp.source, file);
              if (resolved !== from) continue;

              const newPath = handler.computePath(file, to);

              if (imp.specifiers.length === 1) {
                const updated = imp.full.replace(
                  new RegExp(`(from\\s+)["']${esc(imp.source)}["']`),
                  `$1"${newPath}"`,
                );
                modified = modified.replace(imp.full, updated);
              } else {
                const specToMove = imp.specifiers.find((s) => {
                  const name = s.includes(" as ") ? (s.split(" as ")[0]?.trim() ?? s) : s.trim();
                  return name === args.symbol;
                });
                if (!specToMove) continue;

                const remaining = imp.specifiers.filter((s) => s !== specToMove);
                const prefix = imp.isReExport ? "export " : "import ";
                const tp = imp.isType ? "type " : "";
                const kept = `${prefix}${tp}{ ${remaining.join(", ")} } from "${imp.source}";`;
                const added = `${prefix}${tp}{ ${specToMove} } from "${newPath}";`;
                modified = modified.replace(imp.full, `${kept}\n${added}`);
              }
              changed = true;
            }

            if (changed) {
              await tx.stage(file, modified);
              updatedFiles.push(file);
            }
          } catch {
            affectedFiles.push(file);
          }
        } else {
          affectedFiles.push(file);
        }
      }

      try {
        await tx.commit();
      } catch (commitErr: unknown) {
        await tx.rollback();
        const msg = commitErr instanceof Error ? commitErr.message : String(commitErr);
        return {
          success: false,
          output: `Move failed during write — all changes rolled back: ${msg}`,
          error: "write failed",
        };
      }

      const cwd = process.cwd();
      const allModified = [...new Set([to, from, ...updatedFiles])];
      const output: string[] = [
        `Moved '${args.symbol}' from ${relative(cwd, from)} → ${relative(cwd, to)}`,
        `Updated ${String(allModified.length)} file(s):`,
        ...allModified.map((f) => `  ${relative(cwd, f)}`),
      ];

      if (affectedFiles.length > 0) {
        output.push(
          "",
          `${String(affectedFiles.length)} file(s) reference '${args.symbol}' — may need manual import updates:`,
          ...affectedFiles.map((f) => `  ${relative(cwd, f)}`),
        );
      } else {
        output.push("", "All imports updated atomically. Zero errors.");
      }

      // Auto-fix all affected files (organize imports, fix unused vars)
      try {
        const { autoFixFiles } = await import("./post-edit-fix.js");
        const fixes = await autoFixFiles(allModified);
        if (fixes.size > 0) {
          const fixed = [...fixes.entries()]
            .map(([f, actions]) => `  ${relative(cwd, f)}: ${actions.join(", ")}`)
            .join("\n");
          output.push("", `Auto-fixed:\n${fixed}`);
        }
      } catch {
        // Auto-fix unavailable
      }

      return { success: true, output: output.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};

function appendSymbolToFile(
  existing: string,
  imports: string[],
  definition: string,
  handler: LangImports | null,
): string {
  if (imports.length === 0) {
    return `${existing.trimEnd()}\n\n${definition}\n`;
  }

  if (!handler) {
    return `${imports.join("\n")}\n\n${existing.trimEnd()}\n\n${definition}\n`;
  }

  const existingImports = handler.parse(existing);
  const lines = existing.split("\n");
  const toInsert: string[] = [];

  for (const newImp of imports) {
    const srcMatch =
      newImp.match(/from\s+["']([^"']+)["']/) ??
      newImp.match(/use\s+(.+)::/) ??
      newImp.match(/from\s+(\S+)\s+import/);
    const newSource = srcMatch?.[1] ?? "";

    const match = existingImports.find((e) => e.source === newSource && !e.isReExport);
    if (match) {
      const specMatch = newImp.match(/\{([^}]+)\}/) ?? newImp.match(/import\s+(.+)$/);
      if (specMatch) {
        const newSpecs = (specMatch[1] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const merged = [...new Set([...match.specifiers, ...newSpecs])];
        const tp = match.isType ? "type " : "";
        lines[match.startLine] = `import ${tp}{ ${merged.join(", ")} } from "${match.source}";`;
        for (let k = match.startLine + 1; k <= match.endLine; k++) {
          lines[k] = "";
        }
      }
    } else {
      toInsert.push(newImp);
    }
  }

  if (toInsert.length > 0) {
    let lastIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(import |from |use |#include )/.test(lines[i] ?? "")) lastIdx = i;
    }
    if (lastIdx >= 0) {
      lines.splice(lastIdx + 1, 0, ...toInsert);
    } else {
      lines.unshift(...toInsert, "");
    }
  }

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n\n${definition}\n`;
}
