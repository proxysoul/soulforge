import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  addDefaultParsers,
  type FiletypeParserOptions,
  getTreeSitterClient,
  SyntaxStyle,
  type ThemeTokenStyle,
} from "@opentui/core";
import { dataDir, isCompiledBinary } from "../platform/index.js";

const IS_COMPILED = isCompiledBinary(import.meta.url);
const IS_DIST = !IS_COMPILED && import.meta.dir.includes("/dist");
const bundledAssets = join(dataDir(), "opentui-assets");
const distAssets = join(import.meta.dir, "opentui-assets");
let coreAssetsDir: string;
if (IS_COMPILED) {
  coreAssetsDir = bundledAssets;
} else if (IS_DIST) {
  coreAssetsDir = existsSync(distAssets) ? distAssets : bundledAssets;
} else {
  try {
    coreAssetsDir = resolve(dirname(require.resolve("@opentui/core")), "assets");
  } catch {
    coreAssetsDir = bundledAssets;
  }
  if (!existsSync(coreAssetsDir)) coreAssetsDir = bundledAssets;
}

// Build parser registrations from whatever languages exist in the assets directory.
// This covers JS, TS, markdown, markdown_inline, zig, and any future additions
// without hardcoding each one — critical for the bundled binary where OpenTUI's
// default `import ... with { type: "file" }` paths resolve to broken relative paths.
const MARKDOWN_INJECTION_MAP = {
  nodeTypes: { inline: "markdown_inline", pipe_table_cell: "markdown_inline" },
  infoStringMap: {
    javascript: "javascript",
    js: "javascript",
    jsx: "javascriptreact",
    javascriptreact: "javascriptreact",
    typescript: "typescript",
    ts: "typescript",
    tsx: "typescriptreact",
    typescriptreact: "typescriptreact",
    markdown: "markdown",
    md: "markdown",
  },
};

const TS_ALIASES: Record<string, string[]> = {
  typescript: ["typescriptreact"],
  javascript: ["javascriptreact"],
};

const EXTRA_FILETYPES: Record<string, FiletypeParserOptions[]> = {
  typescript: [
    { filetype: "ts", queries: { highlights: [] }, wasm: "" },
    { filetype: "tsx", queries: { highlights: [] }, wasm: "" },
  ],
  javascript: [
    { filetype: "js", queries: { highlights: [] }, wasm: "" },
    { filetype: "jsx", queries: { highlights: [] }, wasm: "" },
  ],
};

function discoverParsers(): FiletypeParserOptions[] {
  const parsers: FiletypeParserOptions[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(coreAssetsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return parsers;
  }

  for (const dir of dirs) {
    const langDir = resolve(coreAssetsDir, dir);
    const wasmFiles = readdirSync(langDir).filter((f) => f.endsWith(".wasm"));
    const wasmFile = wasmFiles[0];
    if (!wasmFile) continue;

    const highlights = resolve(langDir, "highlights.scm");
    const injections = resolve(langDir, "injections.scm");
    const hasHighlights = existsSync(highlights);
    const hasInjections = existsSync(injections);
    if (!hasHighlights) continue;

    const parser: FiletypeParserOptions = {
      filetype: dir,
      queries: {
        highlights: [highlights],
        ...(hasInjections ? { injections: [injections] } : {}),
      },
      wasm: resolve(langDir, wasmFile),
      ...(TS_ALIASES[dir] ? { aliases: TS_ALIASES[dir] } : {}),
      ...(dir === "markdown" ? { injectionMapping: MARKDOWN_INJECTION_MAP } : {}),
    };
    parsers.push(parser);

    // Add short aliases (ts, tsx, js, jsx) that point to the same wasm/highlights
    const extras = EXTRA_FILETYPES[dir];
    if (extras) {
      for (const extra of extras) {
        parsers.push({
          ...extra,
          queries: { highlights: [highlights] },
          wasm: resolve(langDir, wasmFile),
        });
      }
    }
  }

  return parsers;
}

addDefaultParsers(discoverParsers());

// OpenTUI's tree-sitter worker resolves tree-sitter.wasm relative to CWD which
// fails in bundled contexts. Point it to the original node_modules copy (npm) or
// our pre-bundled worker (compiled binary) via the env var override.
if (IS_COMPILED) {
  process.env.OTUI_TREE_SITTER_WORKER_PATH = join(dataDir(), "opentui-assets", "parser.worker.js");
} else if (IS_DIST) {
  try {
    const coreWorker = resolve(dirname(require.resolve("@opentui/core")), "parser.worker.js");
    if (existsSync(coreWorker)) {
      process.env.OTUI_TREE_SITTER_WORKER_PATH = coreWorker;
    }
  } catch {}
}

const theme: ThemeTokenStyle[] = [
  { scope: ["default"], style: { foreground: "#aaa" } },
  { scope: ["conceal"], style: { foreground: "#444" } },
  { scope: ["markup.strong"], style: { foreground: "#ccc", bold: true } },
  { scope: ["markup.italic"], style: { foreground: "#bbb", italic: true } },
  { scope: ["markup.strikethrough"], style: { foreground: "#666", dim: true } },
  { scope: ["markup.raw"], style: { foreground: "#c792ea" } },
  { scope: ["markup.heading"], style: { foreground: "#9B30FF", bold: true } },
  { scope: ["markup.heading.1"], style: { foreground: "#9B30FF", bold: true } },
  { scope: ["markup.heading.2"], style: { foreground: "#9B30FF", bold: true } },
  { scope: ["markup.heading.3"], style: { foreground: "#9B30FF", bold: true } },
  { scope: ["markup.link.label"], style: { foreground: "#7eb6ff" } },
  { scope: ["markup.link.url", "markup.link"], style: { foreground: "#555" } },
  { scope: ["markup.list"], style: { foreground: "#f0c674" } },
  { scope: ["markup.list.checked"], style: { foreground: "#2d5" } },
  { scope: ["markup.list.unchecked"], style: { foreground: "#555" } },
  { scope: ["markup.quote"], style: { foreground: "#888", italic: true } },
  { scope: ["keyword", "keyword.control"], style: { foreground: "#c792ea" } },
  { scope: ["keyword.operator", "operator"], style: { foreground: "#89ddff" } },
  { scope: ["string"], style: { foreground: "#c3e88d" } },
  { scope: ["string.escape"], style: { foreground: "#89ddff" } },
  { scope: ["comment"], style: { foreground: "#555" } },
  { scope: ["number", "constant", "constant.builtin"], style: { foreground: "#f78c6c" } },
  { scope: ["type", "type.builtin"], style: { foreground: "#ffcb6b" } },
  { scope: ["function", "function.method"], style: { foreground: "#82aaff" } },
  { scope: ["variable", "variable.builtin"], style: { foreground: "#f07178" } },
  { scope: ["property"], style: { foreground: "#bbb" } },
  {
    scope: ["punctuation", "punctuation.bracket", "punctuation.delimiter"],
    style: { foreground: "#888" },
  },
  { scope: ["punctuation.special"], style: { foreground: "#89ddff" } },
  { scope: ["tag"], style: { foreground: "#f07178" } },
  { scope: ["attribute"], style: { foreground: "#ffcb6b" } },
  { scope: ["label"], style: { foreground: "#82aaff" } },
  { scope: ["character.special"], style: { foreground: "#89ddff" } },
  { scope: ["markup.raw.block"], style: { foreground: "#aaa" } },
];

let _syntaxStyle: SyntaxStyle | null = null;
export function getSyntaxStyle(): SyntaxStyle {
  if (!_syntaxStyle) _syntaxStyle = SyntaxStyle.fromTheme(theme);
  return _syntaxStyle;
}

let _tsClient: ReturnType<typeof getTreeSitterClient> | null = null;
export function getTSClient() {
  if (!_tsClient) {
    _tsClient = getTreeSitterClient();
    _tsClient.initialize();
  }
  return _tsClient;
}
