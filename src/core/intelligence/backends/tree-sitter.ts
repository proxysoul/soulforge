import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const BUNDLED_WASM_DIR = join(configDir(), "wasm");

import { configDir, isCompiledBinary } from "../../platform/index.js";
import type { FileCache } from "../cache.js";
import {
  type CodeBlock,
  detectLanguageFromPath,
  type ExportInfo,
  type FileOutline,
  type ImportInfo,
  type IntelligenceBackend,
  type Language,
  type SymbolInfo,
  type SymbolKind,
} from "../types.js";

// Tree-sitter query patterns per language
const QUERIES: Record<string, string> = {
  typescript: `
    (function_declaration name: (identifier) @name) @func
    (export_statement (function_declaration name: (identifier) @name)) @func
    (class_declaration name: (type_identifier) @name) @class
    (method_definition name: (property_identifier) @name) @method
    (interface_declaration name: (type_identifier) @name) @iface
    (type_alias_declaration name: (type_identifier) @name) @type
    (lexical_declaration (variable_declarator name: (identifier) @name)) @var
    (import_statement source: (string) @source) @import
    (export_statement) @export
  `,
  javascript: `
    (function_declaration name: (identifier) @name) @func
    (class_declaration name: (identifier) @name) @class
    (method_definition name: (property_identifier) @name) @method
    (lexical_declaration (variable_declarator name: (identifier) @name)) @var
    (import_statement source: (string) @source) @import
    (export_statement) @export
  `,
  python: `
    (function_definition name: (identifier) @name) @func
    (class_definition name: (identifier) @name) @class
    (class_definition body: (block (function_definition name: (identifier) @name) @method))
    (import_statement) @import
    (import_from_statement) @import
  `,
  go: `
    (function_declaration name: (identifier) @name) @func
    (method_declaration name: (field_identifier) @name) @func
    (type_declaration (type_spec name: (type_identifier) @name)) @type
    (import_declaration) @import
  `,
  rust: `
    (function_item name: (identifier) @name) @func
    (struct_item name: (type_identifier) @name) @struct
    (trait_item name: (type_identifier) @name) @trait
    (type_item name: (type_identifier) @name) @type
    (impl_item (declaration_list (function_item name: (identifier) @name) @method))
    (use_declaration) @import
    (impl_item) @impl
  `,
  java: `
    (method_declaration name: (identifier) @name) @func
    (class_declaration name: (identifier) @name) @class
    (interface_declaration name: (identifier) @name) @iface
    (enum_declaration name: (identifier) @name) @type
    (import_declaration) @import
  `,
  c: `
    (function_definition declarator: (function_declarator declarator: (identifier) @name)) @func
    (struct_specifier name: (type_identifier) @name) @struct
    (enum_specifier name: (type_identifier) @name) @type
    (type_definition declarator: (type_identifier) @name) @type
    (preproc_include) @import
  `,
  cpp: `
    (function_definition declarator: (function_declarator declarator: (identifier) @name)) @func
    (class_specifier name: (type_identifier) @name) @class
    (struct_specifier name: (type_identifier) @name) @struct
    (enum_specifier name: (type_identifier) @name) @type
    (namespace_definition name: (namespace_identifier) @name) @type
    (preproc_include) @import
  `,
  csharp: `
    (method_declaration name: (identifier) @name) @func
    (class_declaration name: (identifier) @name) @class
    (interface_declaration name: (identifier) @name) @iface
    (struct_declaration name: (identifier) @name) @struct
    (enum_declaration name: (identifier) @name) @type
    (namespace_declaration name: (identifier) @name) @type
    (using_directive) @import
  `,
  ruby: `
    (method name: (identifier) @name) @func
    (class name: (constant) @name) @class
    (module name: (constant) @name) @type
    (call method: (identifier) @name) @import
  `,
  php: `
    (function_definition name: (name) @name) @func
    (method_declaration name: (name) @name) @func
    (class_declaration name: (name) @name) @class
    (interface_declaration name: (name) @name) @iface
    (trait_declaration name: (name) @name) @trait
    (namespace_use_declaration) @import
  `,
  swift: `
    (function_declaration (simple_identifier) @name) @func
    (class_declaration name: (type_identifier) @name) @class
    (protocol_declaration name: (type_identifier) @name) @iface
    (import_declaration) @import
  `,
  kotlin: `
    (function_declaration (simple_identifier) @name) @func
    (class_declaration (type_identifier) @name) @class
    (object_declaration (type_identifier) @name) @class
    (import_header) @import
  `,
  scala: `
    (function_definition name: (identifier) @name) @func
    (class_definition name: (identifier) @name) @class
    (trait_definition name: (identifier) @name) @trait
    (object_definition name: (identifier) @name) @class
    (import_declaration) @import
  `,
  lua: `
    (function_definition_statement name: (identifier) @name) @func
    (local_function_definition_statement name: (identifier) @name) @func
  `,
  elixir: `
    (call target: (identifier) @name) @func
  `,
  dart: `
    (function_signature (identifier) @name) @func
    (class_definition name: (identifier) @name) @class
    (enum_declaration name: (identifier) @name) @type
    (mixin_declaration name: (identifier) @name) @class
    (import_or_export) @import
  `,
  zig: `
    (function_declaration name: (identifier) @name) @func
    (variable_declaration name: (identifier) @name) @var
  `,
  bash: `
    (function_definition name: (word) @name) @func
  `,
  ocaml: `
    (value_definition (let_binding pattern: (value_name) @name)) @func
    (type_definition (type_binding name: (type_constructor) @name)) @type
    (module_definition (module_binding name: (module_name) @name)) @type
    (open_module) @import
  `,
  objc: `
    (function_definition declarator: (function_declarator declarator: (identifier) @name)) @func
    (class_interface . (identifier) @name) @class
    (protocol_declaration . (identifier) @name) @iface
    (preproc_include) @import
  `,
  css: `
    (rule_set (selectors) @name) @var
    (keyframes_statement (keyframes_name) @name) @type
  `,
  html: `
    (element (start_tag (tag_name) @name)) @var
  `,
  vue: `
    (element (start_tag (tag_name) @name)) @var
  `,
  rescript: `
    (let_declaration (let_binding pattern: (value_identifier) @name)) @func
    (type_declaration (type_binding name: (type_identifier) @name)) @type
    (module_declaration (module_binding name: (module_identifier) @name)) @type
  `,
  solidity: `
    (contract_declaration name: (identifier) @name) @class
    (function_definition name: (identifier) @name) @func
    (event_definition name: (identifier) @name) @type
    (struct_declaration name: (identifier) @name) @struct
    (enum_declaration name: (identifier) @name) @type
    (import_directive) @import
  `,
  tlaplus: `
    (operator_definition name: (identifier) @name) @func
    (function_definition name: (identifier) @name) @func
  `,
  elisp: `
    (function_definition name: (symbol) @name) @func
    (special_form . (symbol) @name) @var
  `,
};

const GRAMMAR_FILES: Record<string, string> = {
  // NOTE: tree-sitter-typescript.wasm doesn't exist in tree-sitter-wasms.
  // The tsx grammar is a superset that handles both .ts and .tsx files.
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  php: "tree-sitter-php.wasm",
  swift: "tree-sitter-swift.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  scala: "tree-sitter-scala.wasm",
  lua: "tree-sitter-lua.wasm",
  elixir: "tree-sitter-elixir.wasm",
  dart: "tree-sitter-dart.wasm",
  zig: "tree-sitter-zig.wasm",
  bash: "tree-sitter-bash.wasm",
  ocaml: "tree-sitter-ocaml.wasm",
  objc: "tree-sitter-objc.wasm",
  css: "tree-sitter-css.wasm",
  html: "tree-sitter-html.wasm",
  json: "tree-sitter-json.wasm",
  toml: "tree-sitter-toml.wasm",
  vue: "tree-sitter-vue.wasm",
  rescript: "tree-sitter-rescript.wasm",
  solidity: "tree-sitter-solidity.wasm",
  tlaplus: "tree-sitter-tlaplus.wasm",
  elisp: "tree-sitter-elisp.wasm",
};

// Dynamically import web-tree-sitter types
type TSParser = import("web-tree-sitter").Parser;
type TSLanguage = import("web-tree-sitter").Language;
type TSTree = import("web-tree-sitter").Tree;
type TSQuery = import("web-tree-sitter").Query;
type TSQueryCapture = import("web-tree-sitter").QueryCapture;
type TSNode = import("web-tree-sitter").Node;

function extractImportSpecifiers(node: TSNode, language: Language): string[] {
  const specifiers: string[] = [];
  collectSpecifiers(node, language, specifiers);
  return specifiers;
}

function collectSpecifiers(node: TSNode, language: Language, out: string[]): void {
  const type = node.type;

  if (language === "typescript" || language === "javascript") {
    if (type === "import_specifier") {
      // Always use the original exported name (not the local alias).
      // `import { register as registerDebug }` → push "register"
      // so refs match symbols by their exported name.
      const name = node.childForFieldName("name");
      if (name) out.push(name.text);
      return;
    }
    if (type === "identifier" && node.parent?.type === "import_clause") {
      out.push(node.text);
      return;
    }
    if (type === "namespace_import") {
      const name = node.namedChildren.find(
        (c: TSNode | null) => c != null && c.type === "identifier",
      );
      if (name) out.push(name.text);
      return;
    }
  } else if (language === "python") {
    if (type === "aliased_import") {
      // Use the original name, not the alias, so refs match the source module's symbols
      const name = node.childForFieldName("name");
      if (name) {
        const text = name.text;
        const last = text.split(".").pop();
        if (last) out.push(last);
      }
      return;
    }
    if (type === "dotted_name" && node.parent?.type === "import_from_statement") {
      const field = node.parent.childForFieldName("module_name");
      if (node !== field) {
        const last = node.text.split(".").pop();
        if (last) out.push(last);
        return;
      }
    }
    if (type === "dotted_name" && node.parent?.type === "import_statement") {
      const last = node.text.split(".").pop();
      if (last) out.push(last);
      return;
    }
  } else if (language === "rust") {
    if (type === "use_as_clause") {
      // Use the original path name, not the alias, so refs match the source module's symbols
      // `use foo::Bar as Baz` → push "Bar"
      const path = node.childForFieldName("path");
      if (path) {
        const name = path.childForFieldName("name");
        out.push(name ? name.text : path.text);
        return;
      }
    }
    if (
      type === "identifier" &&
      (node.parent?.type === "use_list" ||
        node.parent?.type === "scoped_use_list" ||
        node.parent?.type === "use_declaration")
    ) {
      out.push(node.text);
      return;
    }
    if (type === "scoped_identifier" && !node.parent?.type?.includes("use_list")) {
      const name = node.childForFieldName("name");
      if (name) out.push(name.text);
      return;
    }
  } else if (language === "java" || language === "kotlin" || language === "scala") {
    if (type === "identifier" || type === "type_identifier" || type === "simple_identifier") {
      if (node.nextSibling === null || node.nextSibling?.type === ";") {
        out.push(node.text);
        return;
      }
    }
    if (type === "scoped_identifier" || type === "scoped_type_identifier") {
      const name = node.childForFieldName("name");
      if (name) out.push(name.text);
      return;
    }
  } else if (language === "csharp") {
    if (type === "qualified_name" || type === "identifier_name") {
      const last = node.text.split(".").pop();
      if (last) out.push(last);
      return;
    }
  } else if (language === "go") {
    // import "fmt" → package name is last path segment
    // import alias "pkg/path" → alias is the specifier
    if (type === "import_spec") {
      const name = node.childForFieldName("name");
      const path = node.childForFieldName("path");
      if (name && name.text !== ".") {
        out.push(name.text);
      } else if (path) {
        const raw = path.text.replace(/['"]/g, "");
        const last = raw.split("/").pop();
        if (last) out.push(last);
      }
      return;
    }
    if (type === "interpreted_string_literal") {
      const raw = node.text.replace(/['"]/g, "");
      const last = raw.split("/").pop();
      if (last) out.push(last);
      return;
    }
  } else if (language === "ruby") {
    // require "foo" / require_relative "foo" → last path segment
    if (type === "string" || type === "string_content") {
      const raw = node.text.replace(/['"]/g, "");
      const last = raw.split("/").pop()?.replace(/\.rb$/, "");
      if (last) out.push(last);
      return;
    }
    if (type === "constant") {
      out.push(node.text);
      return;
    }
  } else if (language === "php") {
    // use Foo\Bar\Baz → Baz
    // use Foo\Bar\{Baz, Qux} → Baz, Qux
    if (type === "namespace_use_clause") {
      const name = node.namedChildren.at(-1);
      if (name && (name.type === "name" || name.type === "qualified_name")) {
        const last = name.text.split("\\").pop();
        if (last) out.push(last);
      }
      return;
    }
    if (type === "qualified_name" && node.parent?.type === "namespace_use_declaration") {
      const last = node.text.split("\\").pop();
      if (last) out.push(last);
      return;
    }
  } else if (language === "swift") {
    // import Foundation → Foundation
    // import struct Module.Struct → Struct
    if (type === "identifier") {
      out.push(node.text);
      return;
    }
  } else if (language === "dart") {
    // import "package:foo/bar.dart" show Baz, Qux
    if (
      type === "identifier" &&
      (node.parent?.type === "combinator" ||
        node.parent?.type === "show_combinator" ||
        node.parent?.type === "hide_combinator")
    ) {
      out.push(node.text);
      return;
    }
    // Fallback: grab the filename from the import URI
    if (type === "string_literal" || type === "uri") {
      const raw = node.text.replace(/['"]/g, "");
      const last = raw
        .split("/")
        .pop()
        ?.replace(/\.dart$/, "");
      if (last) out.push(last);
      return;
    }
  } else if (language === "elixir") {
    // alias Foo.Bar → Bar
    // import Foo.Bar → Bar
    if (type === "alias") {
      const last = node.text.split(".").pop();
      if (last) out.push(last);
      return;
    }
  } else if (language === "ocaml") {
    // open Foo → Foo
    if (type === "module_name" || type === "module_path") {
      const last = node.text.split(".").pop();
      if (last) out.push(last);
      return;
    }
  } else if (language === "solidity") {
    // import {Foo, Bar} from "file.sol"
    if (type === "import_declaration" && node.text.includes("{")) {
      const braceMatch = node.text.match(/\{([^}]+)\}/);
      if (braceMatch) {
        for (const item of braceMatch[1]?.split(",") ?? []) {
          const parts = item.trim().split(/\s+as\s+/);
          const name = (parts[1] || parts[0] || "").trim();
          if (name) out.push(name);
        }
        return;
      }
    }
  }

  // C, C++, Zig, Objective-C: #include / @import — no named specifiers, refs come from identifier regex
  // Generic fallback: recurse into children
  const childCount = node.namedChildCount;
  for (let i = 0; i < childCount; i++) {
    const child = node.namedChild(i);
    if (child) collectSpecifiers(child, language, out);
  }
}

const HEADER_EXTS = new Set([".h", ".hpp", ".hh", ".hxx"]);

function isPublicSymbol(
  name: string,
  sourceLine: string,
  language: Language,
  filePath: string,
): boolean {
  const trimmed = sourceLine.trimStart();
  switch (language) {
    case "go":
      return /^[A-Z]/.test(name);
    case "rust":
    case "zig":
      return trimmed.startsWith("pub ");
    case "python":
    case "dart":
      return !name.startsWith("_");
    case "java":
    case "kotlin":
    case "scala":
    case "swift":
    case "csharp":
      return !/\bprivate\b/.test(trimmed);
    case "php":
      return !/\b(?:private|protected)\b/.test(trimmed);
    case "ruby":
    case "lua":
    case "bash":
    case "tlaplus":
    case "rescript":
    case "ocaml":
      return true;
    case "elixir":
      return !trimmed.startsWith("defp ");
    case "elisp":
      return !name.startsWith("--");
    case "c":
    case "cpp":
    case "objc":
      return HEADER_EXTS.has(filePath.slice(filePath.lastIndexOf(".")));
    case "solidity":
      return (
        /\b(?:public|external)\b/.test(trimmed) ||
        /\b(?:contract|event|struct|enum)\b/.test(trimmed)
      );
    default:
      return true;
  }
}

// Use canonical map — tree-sitter also needs .hh and .sc which may not be in EXT_TO_LANGUAGE
// Those extras are added to the canonical map in types.ts

// Store the module reference for Query construction
let TSQueryClass: (new (lang: TSLanguage, source: string) => TSQuery) | null = null;

function createQuery(lang: TSLanguage, source: string): TSQuery {
  if (!TSQueryClass) throw new Error("tree-sitter not initialized");
  return new TSQueryClass(lang, source);
}

/**
 * Tree-sitter based backend (Tier 3).
 * Provides universal AST parsing with lazy grammar loading.
 */
interface TreeCacheEntry {
  tree: TSTree;
  content: string; // content used to parse — invalidate if changed
}

export class TreeSitterBackend implements IntelligenceBackend {
  readonly name = "tree-sitter";
  readonly tier = 3;
  private parser: TSParser | null = null;
  private languages = new Map<string, TSLanguage>();
  private failedLanguages = new Set<string>();
  private initPromise: Promise<void> | null = null;
  private cache: FileCache | null = null;
  /** Parse tree cache: absPath → { tree, content } */
  private treeCache = new Map<string, TreeCacheEntry>();
  private readonly treeCacheMaxSize = 50;

  supportsLanguage(language: Language): boolean {
    // typescript uses the tsx grammar (no separate typescript wasm)
    const key = language === "typescript" ? "tsx" : language;
    return key in GRAMMAR_FILES;
  }

  setCache(cache: FileCache): void {
    this.cache = cache;
  }

  async initialize(_cwd: string): Promise<void> {
    if (this.parser) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit();
    return this.initPromise;
  }

  dispose(): void {
    for (const entry of this.treeCache.values()) {
      entry.tree.delete();
    }
    this.treeCache.clear();
    this.parser?.delete();
    this.parser = null;
    this.languages.clear();
    this.initPromise = null;
  }

  async findSymbols(file: string, query?: string): Promise<SymbolInfo[] | null> {
    const parsed = await this.parseWithQuery(file);
    if (!parsed) return null;
    const { tree, tsQuery } = parsed;

    const symbols: SymbolInfo[] = [];

    try {
      const matches = tsQuery.matches(tree.rootNode);

      for (const match of matches) {
        const nameCapture = match.captures.find((c: TSQueryCapture) => c.name === "name");
        if (!nameCapture) continue;

        const name = nameCapture.node.text;
        if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;

        const patternCapture = match.captures.find(
          (c: TSQueryCapture) => c.name !== "name" && c.name !== "source",
        );
        const kind = this.captureToKind(patternCapture?.name ?? "unknown");

        // Use the declaration node (pattern capture) for endLine, not the name node
        const declNode = patternCapture?.node ?? nameCapture.node.parent ?? nameCapture.node;
        symbols.push({
          name,
          kind,
          location: {
            file: resolve(file),
            line: nameCapture.node.startPosition.row + 1,
            column: nameCapture.node.startPosition.column + 1,
            endLine: declNode.endPosition.row + 1,
          },
        });
      }
    } finally {
      tsQuery.delete();
      tree.delete();
    }

    return symbols;
  }

  async findImports(file: string): Promise<ImportInfo[] | null> {
    const tree = await this.parseFile(file);
    if (!tree) return null;

    const language = this.detectLang(file);
    const tsLang = this.languages.get(this.grammarKeyForFile(file));
    if (!tsLang) {
      tree.delete();
      return null;
    }

    const importQueryStr =
      language === "typescript" || language === "javascript"
        ? `(import_statement source: (string) @source) @import`
        : language === "python"
          ? `(import_statement) @import (import_from_statement module_name: (dotted_name) @source) @import`
          : language === "go"
            ? `(import_declaration) @import`
            : language === "rust"
              ? `(use_declaration) @import`
              : null;

    if (!importQueryStr) {
      tree.delete();
      return null;
    }

    const imports: ImportInfo[] = [];
    const tsQuery = createQuery(tsLang, importQueryStr);

    try {
      const matches = tsQuery.matches(tree.rootNode);

      for (const match of matches) {
        const importNode = match.captures.find((c: TSQueryCapture) => c.name === "import");
        const sourceNode = match.captures.find((c: TSQueryCapture) => c.name === "source");

        if (!importNode) continue;

        const node = importNode.node;
        const source = sourceNode ? sourceNode.node.text.replace(/['"]/g, "") : node.text;
        const specifiers = extractImportSpecifiers(node, language);

        imports.push({
          source,
          specifiers,
          isDefault:
            specifiers.length > 0 &&
            node.text.includes("import ") &&
            !node.text.includes("{") &&
            !node.text.includes("*"),
          isNamespace: node.text.includes("* as "),
          location: {
            file: resolve(file),
            line: node.startPosition.row + 1,
            column: node.startPosition.column + 1,
            endLine: node.endPosition.row + 1,
          },
        });
      }
    } finally {
      tsQuery.delete();
    }

    // Also capture re-exports: export { X } from './y'
    if (language === "typescript" || language === "javascript") {
      const reExportQuery = createQuery(tsLang, `(export_statement) @export`);
      try {
        for (const match of reExportQuery.matches(tree.rootNode)) {
          const cap = match.captures.find((c: TSQueryCapture) => c.name === "export");
          if (!cap) continue;
          const node = cap.node;
          const source = node.childForFieldName("source");
          if (!source) continue;
          const clause = node.namedChildren.find(
            (c: TSNode | null) => c != null && c.type === "export_clause",
          );
          if (!clause) continue;
          const specifiers: string[] = [];
          for (let ci = 0; ci < clause.namedChildCount; ci++) {
            const spec = clause.namedChild(ci);
            if (spec?.type === "export_specifier") {
              const name = spec.childForFieldName("name");
              if (name) specifiers.push(name.text);
            }
          }
          if (specifiers.length > 0) {
            imports.push({
              source: source.text.replace(/['"]/g, ""),
              specifiers,
              isDefault: false,
              isNamespace: false,
              location: {
                file: resolve(file),
                line: node.startPosition.row + 1,
                column: node.startPosition.column + 1,
                endLine: node.endPosition.row + 1,
              },
            });
          }
        }
      } finally {
        reExportQuery.delete();
      }
    }

    tree.delete();
    return imports;
  }

  async findExports(file: string): Promise<ExportInfo[] | null> {
    const tree = await this.parseFile(file);
    if (!tree) return null;

    const language = this.detectLang(file);
    if (language !== "typescript" && language !== "javascript") {
      tree.delete();
      const outline = await this.getFileOutline(file);
      return outline?.exports ?? null;
    }

    const tsLang = this.languages.get(this.grammarKeyForFile(file));
    if (!tsLang) {
      tree.delete();
      return null;
    }

    const exports: ExportInfo[] = [];
    const tsQuery = createQuery(tsLang, `(export_statement) @export`);

    try {
      const matches = tsQuery.matches(tree.rootNode);

      for (const match of matches) {
        const exportCapture = match.captures.find((c: TSQueryCapture) => c.name === "export");
        if (!exportCapture) continue;

        const node = exportCapture.node;
        const isDefault = node.text.includes("export default");

        // Try to find the exported name
        const decl = node.namedChildren.find(
          (c: TSNode | null) =>
            c != null &&
            (c.type === "function_declaration" ||
              c.type === "class_declaration" ||
              c.type === "interface_declaration" ||
              c.type === "type_alias_declaration" ||
              c.type === "lexical_declaration"),
        );

        if (decl) {
          const nameNode =
            decl.childForFieldName("name") ??
            decl.namedChildren
              .find((c: TSNode | null) => c != null && c.type === "variable_declarator")
              ?.childForFieldName("name");

          if (nameNode) {
            let kind: SymbolKind = "variable";
            if (decl.type.includes("function")) kind = "function";
            else if (decl.type.includes("class")) kind = "class";
            else if (decl.type.includes("interface")) kind = "interface";
            else if (decl.type.includes("type")) kind = "type";

            exports.push({
              name: nameNode.text,
              isDefault,
              kind,
              location: {
                file: resolve(file),
                line: node.startPosition.row + 1,
                column: node.startPosition.column + 1,
                endLine: node.endPosition.row + 1,
              },
            });
          }
        } else {
          // Handle re-exports: export { X, Y } or export { X } from './y'
          const clause = node.namedChildren.find(
            (c: TSNode | null) => c != null && c.type === "export_clause",
          );
          if (clause) {
            for (let ci = 0; ci < clause.namedChildCount; ci++) {
              const spec = clause.namedChild(ci);
              if (spec?.type === "export_specifier") {
                const alias = spec.childForFieldName("alias");
                const name = alias ?? spec.childForFieldName("name");
                if (name) {
                  exports.push({
                    name: name.text,
                    isDefault: false,
                    kind: "variable",
                    location: {
                      file: resolve(file),
                      line: node.startPosition.row + 1,
                      column: node.startPosition.column + 1,
                      endLine: node.endPosition.row + 1,
                    },
                  });
                }
              }
            }
          }
        }
      }
    } finally {
      tsQuery.delete();
      tree.delete();
    }

    return exports;
  }

  async getFileOutline(file: string): Promise<FileOutline | null> {
    // Single parse, extract all data from one tree
    const tree = await this.parseFile(file);
    if (!tree) return null;

    const language = this.detectLang(file);
    const tsLang = this.languages.get(this.grammarKeyForFile(file));
    if (!tsLang) {
      tree.delete();
      return null;
    }

    const symbols: SymbolInfo[] = [];
    const imports: ImportInfo[] = [];
    const exports: ExportInfo[] = [];
    const absFile = resolve(file);

    // Extract symbols using the main query
    const mainQueryStr = QUERIES[language];
    if (mainQueryStr) {
      const mainQuery = createQuery(tsLang, mainQueryStr);
      try {
        const matches = mainQuery.matches(tree.rootNode);
        for (const match of matches) {
          const nameCapture = match.captures.find((c: TSQueryCapture) => c.name === "name");
          const sourceCapture = match.captures.find((c: TSQueryCapture) => c.name === "source");
          const patternCapture = match.captures.find(
            (c: TSQueryCapture) => c.name !== "name" && c.name !== "source",
          );

          // Handle imports
          if (patternCapture?.name === "import") {
            const node = patternCapture.node;
            const source = sourceCapture ? sourceCapture.node.text.replace(/['"]/g, "") : node.text;
            const specifiers = extractImportSpecifiers(node, language);
            const isDefault =
              specifiers.length > 0 &&
              node.text.includes("import ") &&
              !node.text.includes("{") &&
              !node.text.includes("*");
            const isNamespace = node.text.includes("* as ");
            imports.push({
              source,
              specifiers,
              isDefault,
              isNamespace,
              location: {
                file: absFile,
                line: node.startPosition.row + 1,
                column: node.startPosition.column + 1,
                endLine: node.endPosition.row + 1,
              },
            });
            continue;
          }

          // Handle exports
          if (patternCapture?.name === "export") {
            const node = patternCapture.node;
            const isDefault = node.text.includes("export default");
            const decl = node.namedChildren.find(
              (c: TSNode | null) =>
                c != null &&
                (c.type === "function_declaration" ||
                  c.type === "class_declaration" ||
                  c.type === "interface_declaration" ||
                  c.type === "type_alias_declaration" ||
                  c.type === "lexical_declaration"),
            );
            if (decl) {
              const expNameNode =
                decl.childForFieldName("name") ??
                decl.namedChildren
                  .find((c: TSNode | null) => c != null && c.type === "variable_declarator")
                  ?.childForFieldName("name");
              if (expNameNode) {
                let kind: SymbolKind = "variable";
                if (decl.type.includes("function")) kind = "function";
                else if (decl.type.includes("class")) kind = "class";
                else if (decl.type.includes("interface")) kind = "interface";
                else if (decl.type.includes("type")) kind = "type";
                exports.push({
                  name: expNameNode.text,
                  isDefault,
                  kind,
                  location: {
                    file: absFile,
                    line: node.startPosition.row + 1,
                    column: node.startPosition.column + 1,
                    endLine: node.endPosition.row + 1,
                  },
                });
              }
            } else {
              // Handle re-exports: export { X, Y } or export { X } from './y'
              const clause = node.namedChildren.find(
                (c: TSNode | null) => c != null && c.type === "export_clause",
              );
              if (clause) {
                const reExportSource = node.childForFieldName("source");
                const source = reExportSource
                  ? reExportSource.text.replace(/['"]/g, "")
                  : undefined;
                const specNames: string[] = [];
                const origNames: string[] = [];
                for (let ci = 0; ci < clause.namedChildCount; ci++) {
                  const spec = clause.namedChild(ci);
                  if (spec?.type === "export_specifier") {
                    const alias = spec.childForFieldName("alias");
                    const name = spec.childForFieldName("name");
                    // Export name is the alias (public-facing) or the original name
                    const exportName = alias ?? name;
                    if (exportName) {
                      specNames.push(exportName.text);
                      exports.push({
                        name: exportName.text,
                        isDefault: false,
                        kind: "variable",
                        location: {
                          file: absFile,
                          line: node.startPosition.row + 1,
                          column: node.startPosition.column + 1,
                          endLine: node.endPosition.row + 1,
                        },
                      });
                    }
                    // Track original name for import refs back to the source module
                    if (name) origNames.push(name.text);
                  }
                }
                // Re-exports with a source are cross-file references (treat as imports)
                // Use original names (not aliases) so refs match the source module's symbols
                if (source && origNames.length > 0) {
                  imports.push({
                    source,
                    specifiers: origNames,
                    isDefault: false,
                    isNamespace: false,
                    location: {
                      file: absFile,
                      line: node.startPosition.row + 1,
                      column: node.startPosition.column + 1,
                      endLine: node.endPosition.row + 1,
                    },
                  });
                }
              } else {
                // Handle export * from './module' (wildcard re-exports)
                const hasStar =
                  node.namedChildren.some(
                    (c: TSNode | null) => c != null && c.type === "namespace_export",
                  ) || node.text.includes("export *");
                const reExportSource = node.childForFieldName("source");
                if (hasStar && reExportSource) {
                  const source = reExportSource.text.replace(/['"]/g, "");
                  imports.push({
                    source,
                    specifiers: ["*"],
                    isDefault: false,
                    isNamespace: true,
                    location: {
                      file: absFile,
                      line: node.startPosition.row + 1,
                      column: node.startPosition.column + 1,
                      endLine: node.endPosition.row + 1,
                    },
                  });
                }
              }
            }
            continue;
          }

          // Handle symbols
          if (nameCapture) {
            const kind = this.captureToKind(patternCapture?.name ?? "unknown");
            // Use the declaration node (pattern capture) for endLine, not the name node
            const declNode = patternCapture?.node ?? nameCapture.node.parent ?? nameCapture.node;
            symbols.push({
              name: nameCapture.node.text,
              kind,
              location: {
                file: absFile,
                line: nameCapture.node.startPosition.row + 1,
                column: nameCapture.node.startPosition.column + 1,
                endLine: declNode.endPosition.row + 1,
              },
            });
          }
        }
      } finally {
        mainQuery.delete();
      }
    }

    // Capture dynamic import() expressions for TS/JS
    // e.g. `const { start } = await import("./index.js")`
    if (language === "typescript" || language === "javascript") {
      const dynamicImportQuery = createQuery(
        tsLang,
        `(call_expression function: (import) arguments: (arguments (string) @source)) @dynamic_import`,
      );
      try {
        for (const match of dynamicImportQuery.matches(tree.rootNode)) {
          const sourceCapture = match.captures.find((c: TSQueryCapture) => c.name === "source");
          if (!sourceCapture) continue;
          const source = sourceCapture.node.text.replace(/['"`]/g, "");
          if (!source) continue;

          // Extract destructured names from the variable declaration context
          // e.g. `const { start } = await import("./index.js")`
          const importNode = match.captures.find(
            (c: TSQueryCapture) => c.name === "dynamic_import",
          );
          const specifiers: string[] = [];
          if (importNode) {
            // Walk up to find destructuring pattern
            let current: TSNode | null = importNode.node.parent;
            // Walk up through await_expression, assignment, etc.
            while (
              current &&
              current.type !== "variable_declarator" &&
              current.type !== "assignment_expression"
            ) {
              current = current.parent;
            }
            if (current) {
              const pattern =
                current.childForFieldName("name") ?? current.childForFieldName("left");
              if (pattern?.type === "object_pattern") {
                for (let ci = 0; ci < pattern.namedChildCount; ci++) {
                  const child = pattern.namedChild(ci);
                  if (child?.type === "shorthand_property_identifier_pattern") {
                    specifiers.push(child.text);
                  } else if (child?.type === "pair_pattern") {
                    const key = child.childForFieldName("key");
                    if (key) specifiers.push(key.text);
                  }
                }
              }
            }
          }

          // If we couldn't extract specifiers, use wildcard
          if (specifiers.length === 0) specifiers.push("*");

          imports.push({
            source,
            specifiers,
            isDefault: false,
            isNamespace: specifiers.length === 1 && specifiers[0] === "*",
            location: {
              file: absFile,
              line: sourceCapture.node.startPosition.row + 1,
              column: sourceCapture.node.startPosition.column + 1,
              endLine: sourceCapture.node.endPosition.row + 1,
            },
          });
        }
      } finally {
        dynamicImportQuery.delete();
      }
    }

    tree.delete();

    // CommonJS: extract exports from module.exports = { ... } for JS files
    if ((language === "javascript" || language === "typescript") && exports.length === 0) {
      const content = await this.readFileContent(file);
      if (content) {
        const cjsMatch = content.match(/module\.exports\s*=\s*\{([^}]+)\}/);
        if (cjsMatch?.[1]) {
          for (const item of cjsMatch[1].split(",")) {
            const name = item
              .trim()
              .split(/\s*[:=]/)[0]
              ?.trim();
            if (name && /^\w+$/.test(name)) {
              const sym = symbols.find((s) => s.name === name);
              exports.push({
                name,
                isDefault: false,
                kind: sym?.kind ?? "variable",
                location: sym?.location ?? {
                  file: absFile,
                  line: 1,
                  column: 1,
                },
              });
            }
          }
        }
      }
    }

    // Infer exports from visibility conventions for non-TS/JS languages
    if (exports.length === 0 && language !== "typescript" && language !== "javascript") {
      const content = await this.readFileContent(file);
      if (content) {
        const lines = content.split("\n");
        for (const sym of symbols) {
          const line = lines[sym.location.line - 1] ?? "";
          if (isPublicSymbol(sym.name, line, language, file)) {
            exports.push({
              name: sym.name,
              isDefault: false,
              kind: sym.kind,
              location: sym.location,
            });
          }
        }
      }
    }

    return {
      file: absFile,
      language,
      symbols,
      imports,
      exports,
    };
  }

  async readSymbol(
    file: string,
    symbolName: string,
    symbolKind?: SymbolKind,
  ): Promise<CodeBlock | null> {
    const parsed = await this.parseWithQuery(file);
    if (!parsed) return null;
    const { tree, tsQuery } = parsed;

    try {
      const matches = tsQuery.matches(tree.rootNode);

      for (const match of matches) {
        const nameCapture = match.captures.find((c: TSQueryCapture) => c.name === "name");
        if (!nameCapture || nameCapture.node.text !== symbolName) continue;

        const patternCapture = match.captures.find(
          (c: TSQueryCapture) => c.name !== "name" && c.name !== "source",
        );
        const kind = this.captureToKind(patternCapture?.name ?? "unknown");

        if (symbolKind && kind !== symbolKind) continue;

        // Get the full node (not just the name)
        const node = patternCapture?.node ?? nameCapture.node.parent;
        if (!node) continue;

        const language = this.detectLang(file);
        return {
          content: node.text,
          location: {
            file: resolve(file),
            line: node.startPosition.row + 1,
            column: node.startPosition.column + 1,
            endLine: node.endPosition.row + 1,
          },
          symbolName,
          symbolKind: kind,
          language,
        };
      }
    } finally {
      tsQuery.delete();
      tree.delete();
    }

    return null;
  }

  async readScope(file: string, startLine: number, endLine?: number): Promise<CodeBlock | null> {
    const content = await this.readFileContent(file);
    if (!content) return null;

    const language = this.detectLang(file);
    const lines = content.split("\n");
    const startIdx = Math.max(0, startLine - 1);
    const endIdx = endLine
      ? Math.min(endLine - 1, lines.length - 1)
      : Math.min(startIdx + 50, lines.length - 1);

    const blockContent = lines.slice(startIdx, endIdx + 1).join("\n");

    return {
      content: blockContent,
      location: {
        file: resolve(file),
        line: startLine,
        column: 1,
        endLine: endIdx + 1,
      },
      language,
    };
  }

  private static readonly MIN_HASH_LINES = 12;

  private static readonly HASHABLE_KEYWORDS = [
    "function",
    "method",
    "class",
    "impl",
    "struct",
    "trait",
    "module",
    "constructor",
  ];

  private static isHashableType(nodeType: string): boolean {
    return TreeSitterBackend.HASHABLE_KEYWORDS.some((kw) => nodeType.includes(kw));
  }

  private serializeShape(node: TSNode, depth: number): string {
    if (depth > 40) return node.type;
    const childCount = node.namedChildCount;
    if (childCount === 0) return node.type;
    const children: string[] = [];
    for (let i = 0; i < childCount; i++) {
      const child = node.namedChild(i);
      if (child) children.push(this.serializeShape(child, depth + 1));
    }
    return `${node.type}(${children.join(",")})`;
  }

  private countNodes(node: TSNode, depth: number): number {
    if (depth > 40) return 1;
    let count = 1;
    const childCount = node.namedChildCount;
    for (let i = 0; i < childCount; i++) {
      const child = node.namedChild(i);
      if (child) count += this.countNodes(child, depth + 1);
    }
    return count;
  }

  private extractNodeName(node: TSNode): string {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return nameNode.text;

    if (node.type === "arrow_function" || node.type === "function_expression") {
      const parent = node.parent;
      if (parent?.type === "variable_declarator") {
        const varName = parent.childForFieldName("name");
        if (varName) return varName.text;
      }
      if (parent?.type === "pair" || parent?.type === "property") {
        const key = parent.childForFieldName("key");
        if (key) return key.text;
      }
    }

    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      const declarator = node.namedChildren.find(
        (c: TSNode | null) => c != null && c.type === "variable_declarator",
      );
      if (declarator) {
        const varName = declarator.childForFieldName("name");
        if (varName) return varName.text;
      }
    }

    return "(anonymous)";
  }

  private collectHashableNodes(
    node: TSNode,
    results: Array<{ node: TSNode; name: string; kind: string }>,
    depth: number,
  ): void {
    if (depth > 10) return;

    if (TreeSitterBackend.isHashableType(node.type)) {
      const lines = node.endPosition.row - node.startPosition.row + 1;
      if (lines >= TreeSitterBackend.MIN_HASH_LINES) {
        const name = this.extractNodeName(node);
        const kind = node.type
          .replace(/_declaration|_definition|_item|_statement|_specifier/, "")
          .replace(/^local_/, "");
        results.push({ node, name, kind });
      }
    }

    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      const lines = node.endPosition.row - node.startPosition.row + 1;
      if (lines >= TreeSitterBackend.MIN_HASH_LINES) {
        const hasArrow = node.namedChildren.some((c: TSNode | null) => {
          if (!c || c.type !== "variable_declarator") return false;
          return c.namedChildren.some(
            (gc: TSNode | null) =>
              gc != null && (gc.type === "arrow_function" || gc.type === "function_expression"),
          );
        });
        if (hasArrow) {
          const name = this.extractNodeName(node);
          results.push({ node, name, kind: "function" });
        }
      }
    }

    const childCount = node.namedChildCount;
    for (let i = 0; i < childCount; i++) {
      const child = node.namedChild(i);
      if (child) this.collectHashableNodes(child, results, depth + 1);
    }
  }

  async getShapeHashes(file: string): Promise<Array<{
    name: string;
    kind: string;
    line: number;
    endLine: number;
    shapeHash: string;
    nodeCount: number;
  }> | null> {
    const tree = await this.parseFile(file);
    if (!tree) return null;

    try {
      const nodes: Array<{ node: TSNode; name: string; kind: string }> = [];
      this.collectHashableNodes(tree.rootNode, nodes, 0);

      if (nodes.length === 0) return [];

      const results: Array<{
        name: string;
        kind: string;
        line: number;
        endLine: number;
        shapeHash: string;
        nodeCount: number;
      }> = [];

      for (const { node, name, kind } of nodes) {
        const serialized = this.serializeShape(node, 0);
        const hash = Bun.hash(serialized).toString(16);
        const nodeCount = this.countNodes(node, 0);
        results.push({
          name,
          kind,
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          shapeHash: hash,
          nodeCount,
        });
      }

      return results;
    } finally {
      tree.delete();
    }
  }

  private static readonly IS_BUNDLED = isCompiledBinary(import.meta.url);

  private resolveWasm(filename: string): string {
    // Handle both POSIX `/` and Windows `\\` separators — filename may arrive
    // from readdir which returns native separators.
    const basename = filename.split(/[/\\]/).pop() ?? filename;
    if (TreeSitterBackend.IS_BUNDLED) {
      return join(BUNDLED_WASM_DIR, basename);
    }
    // Walk up from the bundle/source dir to find node_modules.
    // Covers npm global installs (cwd ≠ package root) and dev mode alike.
    let dir = import.meta.dir;
    for (let i = 0; i < 5; i++) {
      for (const sub of ["node_modules/web-tree-sitter", "node_modules/tree-sitter-wasms/out"]) {
        const p = join(dir, sub, basename);
        if (existsSync(p)) return p;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return join(BUNDLED_WASM_DIR, basename);
  }

  private async doInit(): Promise<void> {
    // web-tree-sitter ≤0.25.x ships tree-sitter.wasm; ≥0.26.x renamed to web-tree-sitter.wasm.
    // Try both so bundled installs work regardless of which version built the wasm dir.
    let wasmPath = this.resolveWasm("tree-sitter.wasm");
    if (!existsSync(wasmPath)) {
      wasmPath = this.resolveWasm("web-tree-sitter.wasm");
    }
    if (!existsSync(wasmPath)) {
      throw new Error(`tree-sitter.wasm not found in ${BUNDLED_WASM_DIR} or node_modules`);
    }
    const mod = await import("web-tree-sitter");
    TSQueryClass = mod.Query;
    await mod.Parser.init({
      locateFile: () => wasmPath,
    });
    this.parser = new mod.Parser();
  }

  private async loadLanguage(language: string): Promise<TSLanguage | null> {
    const cached = this.languages.get(language);
    if (cached) return cached;
    if (this.failedLanguages.has(language)) return null;

    const wasmFile = GRAMMAR_FILES[language];
    if (!wasmFile) return null;

    try {
      const mod = await import("web-tree-sitter");
      const wasmPath = this.resolveWasm(`tree-sitter-wasms/out/${wasmFile}`);
      const lang = await mod.Language.load(wasmPath);
      // Validate the grammar actually works — WASM dynamic linker errors
      // (e.g. "resolved is not a function") are deferred until first use,
      // so Language.load() can succeed with a broken grammar. Parse real
      // content to force all lazy WASM stubs to resolve.
      if (this.parser) {
        this.parser.setLanguage(lang);
        const tree = this.parser.parse("# validate");
        tree?.delete();
      }
      this.languages.set(language, lang);
      return lang;
    } catch {
      this.failedLanguages.add(language);
      return null;
    }
  }

  private async parseFile(file: string): Promise<TSTree | null> {
    if (!this.parser) return null;

    const absPath = resolve(file);
    const content = await this.readFileContent(absPath);
    if (!content) return null;

    // Check tree cache — reuse if content hasn't changed
    const cached = this.treeCache.get(absPath);
    if (cached && cached.content === content) {
      // Return a copy since callers delete the tree
      return cached.tree.copy();
    }

    const grammarKey = this.grammarKeyForFile(file);
    const lang = await this.loadLanguage(grammarKey);
    if (!lang) return null;

    this.parser.setLanguage(lang);
    let tree: TSTree | null;
    try {
      tree = this.parser.parse(content);
    } catch {
      // WASM grammar broken at runtime (e.g. ABI mismatch) — blacklist it
      this.failedLanguages.add(grammarKey);
      this.languages.delete(grammarKey);
      return null;
    }
    if (!tree) return null;

    // Cache the tree (evict oldest if full)
    if (cached) cached.tree.delete();
    if (this.treeCache.size >= this.treeCacheMaxSize) {
      const firstKey = this.treeCache.keys().next().value;
      if (firstKey) {
        this.treeCache.get(firstKey)?.tree.delete();
        this.treeCache.delete(firstKey);
      }
    }
    this.treeCache.set(absPath, { tree: tree.copy(), content });

    return tree;
  }

  /**
   * Parse file and create the main language query in one step.
   * Returns both tree and query, or null if either fails.
   * Caller is responsible for deleting both in a finally block.
   */
  private async parseWithQuery(file: string): Promise<{ tree: TSTree; tsQuery: TSQuery } | null> {
    const tree = await this.parseFile(file);
    if (!tree) return null;

    const language = this.detectLang(file);
    // Use grammarKey for the language object (tsx grammar loaded under "tsx" key)
    const grammarKey = this.grammarKeyForFile(file);
    const tsLang = this.languages.get(grammarKey);
    const queryStr = QUERIES[language];
    if (!tsLang || !queryStr) {
      tree.delete();
      return null;
    }

    try {
      const tsQuery = createQuery(tsLang, queryStr);
      return { tree, tsQuery };
    } catch {
      tree.delete();
      return null;
    }
  }

  private async readFileContent(file: string): Promise<string | null> {
    const absPath = resolve(file);
    if (this.cache) {
      return this.cache.get(absPath);
    }
    try {
      return await readFile(absPath, "utf-8");
    } catch {
      return null;
    }
  }

  private detectLang(file: string): Language {
    return detectLanguageFromPath(file);
  }

  /** Map a file to its grammar key — handles tsx/typescript split.
   *  tree-sitter-typescript.wasm doesn't exist in the package;
   *  the tsx grammar is a superset that handles both .ts and .tsx. */
  private grammarKeyForFile(file: string): string {
    const language = this.detectLang(file);
    if (language === "typescript") return "tsx";
    return language;
  }

  private captureToKind(captureName: string): SymbolKind {
    switch (captureName) {
      case "func":
        return "function";
      case "method":
        return "method";
      case "class":
      case "struct":
        return "class";
      case "iface":
      case "trait":
        return "interface";
      case "type":
        return "type";
      case "var":
        return "variable";
      case "impl":
        return "class";
      default:
        return "unknown";
    }
  }
}
