/** Languages with dedicated backend support */
export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "c"
  | "cpp"
  | "csharp"
  | "ruby"
  | "php"
  | "swift"
  | "kotlin"
  | "scala"
  | "lua"
  | "elixir"
  | "dart"
  | "zig"
  | "bash"
  | "ocaml"
  | "objc"
  | "css"
  | "html"
  | "json"
  | "toml"
  | "yaml"
  | "xml"
  | "markdown"
  | "mdx"
  | "sql"
  | "graphql"
  | "proto"
  | "properties"
  | "ini"
  | "env"
  | "dockerfile"
  | "makefile"
  | "nix"
  | "hcl"
  | "bazel"
  | "jsonnet"
  | "just"
  | "svg"
  | "csv"
  | "ignore"
  | "lockfile"
  | "vue"
  | "rescript"
  | "solidity"
  | "tlaplus"
  | "elisp"
  | "unknown";

// Single source of truth — all backends import from here.

export const EXT_TO_LANGUAGE: Record<string, Language> = {
  // TypeScript
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  // JavaScript
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  // Python
  ".py": "python",
  ".pyw": "python",
  // Go
  ".go": "go",
  // Rust
  ".rs": "rust",
  // Java
  ".java": "java",
  // C
  ".c": "c",
  ".h": "c",
  // C++
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  // C#
  ".cs": "csharp",
  // Ruby
  ".rb": "ruby",
  ".erb": "ruby",
  // PHP
  ".php": "php",
  // Swift
  ".swift": "swift",
  // Kotlin
  ".kt": "kotlin",
  ".kts": "kotlin",
  // Scala
  ".scala": "scala",
  ".sc": "scala",
  // Lua
  ".lua": "lua",
  // Elixir
  ".ex": "elixir",
  ".exs": "elixir",
  // Dart
  ".dart": "dart",
  // Zig
  ".zig": "zig",
  // Shell
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  // OCaml
  ".ml": "ocaml",
  ".mli": "ocaml",
  // Objective-C
  ".m": "objc",
  // CSS
  ".css": "css",
  ".scss": "css",
  ".less": "css",
  // HTML
  ".html": "html",
  ".htm": "html",
  // JSON
  ".json": "json",
  ".jsonc": "json",
  // TOML
  ".toml": "toml",
  // YAML
  ".yaml": "yaml",
  ".yml": "yaml",
  // XML
  ".xml": "xml",
  // Markdown
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "mdx",
  // Query / schema languages
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "proto",
  // Config / dotfiles
  ".env": "env",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".properties": "properties",
  // Dockerfile
  ".dockerfile": "dockerfile",
  // Make
  ".mk": "makefile",
  // Nix
  ".nix": "nix",
  // HCL / Terraform
  ".hcl": "hcl",
  ".tf": "hcl",
  ".tfvars": "hcl",
  // Bazel / Starlark
  ".bzl": "bazel",
  ".star": "bazel",
  ".bazel": "bazel",
  // Jsonnet
  ".jsonnet": "jsonnet",
  ".libsonnet": "jsonnet",
  // Data / assets
  ".svg": "svg",
  ".csv": "csv",
  ".tsv": "csv",
  // Lockfiles
  ".lock": "lockfile",
  ".lockb": "lockfile",
  // Vue
  ".vue": "vue",
  // ReScript
  ".res": "rescript",
  ".resi": "rescript",
  // Solidity
  ".sol": "solidity",
  // TLA+
  ".tla": "tlaplus",
  // Emacs Lisp
  ".el": "elisp",
};

/** Bare filenames (no extension) that map to a language. Lowercased lookup. */
export const BARE_FILENAME_TO_LANGUAGE: Record<string, Language> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  justfile: "just",
  ".justfile": "just",
  build: "bazel",
  "build.bazel": "bazel",
  workspace: "bazel",
  "workspace.bazel": "bazel",
  "module.bazel": "bazel",
  ".env": "env",
  ".gitignore": "ignore",
  ".dockerignore": "ignore",
  ".npmignore": "ignore",
  ".prettierignore": "ignore",
  ".eslintignore": "ignore",
  ".editorconfig": "ini",
  "bun.lock": "lockfile",
  "bun.lockb": "lockfile",
  "package-lock.json": "lockfile",
  "pnpm-lock.yaml": "lockfile",
  "yarn.lock": "lockfile",
  "cargo.lock": "lockfile",
  "poetry.lock": "lockfile",
  "composer.lock": "lockfile",
  "gemfile.lock": "lockfile",
  "go.sum": "lockfile",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
};

/** Detect language from a file path using the canonical maps. */
export function detectLanguageFromPath(file: string): Language {
  const slash = file.lastIndexOf("/");
  const base = (slash === -1 ? file : file.slice(slash + 1)).toLowerCase();

  // Bare-filename match first (Makefile, Dockerfile, .gitignore, BUILD, etc.).
  const bare = BARE_FILENAME_TO_LANGUAGE[base];
  if (bare) return bare;

  // Dockerfile.* / Makefile.* / Justfile.* variants.
  if (base.startsWith("dockerfile.")) return "dockerfile";
  if (base.startsWith("containerfile.")) return "dockerfile";
  if (base.startsWith("makefile.")) return "makefile";
  if (base.startsWith("justfile.")) return "just";

  const dot = base.lastIndexOf(".");
  if (dot === -1) return "unknown";
  return EXT_TO_LANGUAGE[base.slice(dot)] ?? "unknown";
}

/** A location in source code */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

/** Symbol kinds for classification */
export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "constant"
  | "enum"
  | "property"
  | "module"
  | "namespace"
  | "unknown";

/** A symbol found in source code */
export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  location: SourceLocation;
  containerName?: string;
}

/** A diagnostic (error/warning) from static analysis */
export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  code?: string | number;
  source?: string;
}

/** A block of code extracted from a file */
export interface CodeBlock {
  content: string;
  location: SourceLocation;
  symbolName?: string;
  symbolKind?: SymbolKind;
  language: Language;
}

/** Result of a refactoring operation */
export interface RefactorResult {
  edits: FileEdit[];
  description: string;
}

/** A single file edit from a refactoring */
export interface FileEdit {
  file: string;
  oldContent: string;
  newContent: string;
}

/** Import information */
export interface ImportInfo {
  source: string;
  specifiers: string[];
  isDefault: boolean;
  isNamespace: boolean;
  location: SourceLocation;
}

/** Export information */
export interface ExportInfo {
  name: string;
  isDefault: boolean;
  kind: SymbolKind;
  location: SourceLocation;
}

/** File outline — top-level structure */
export interface FileOutline {
  file: string;
  language: Language;
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  exports: ExportInfo[];
}

/** Type information for a symbol */
export interface TypeInfo {
  symbol: string;
  type: string;
  documentation?: string;
}

/** A code action (quick-fix or refactoring suggestion) */
export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
}

/** Result of a format operation */
export interface FormatEdit {
  file: string;
  edits: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
    newText: string;
  }[];
}

/** An item in a call hierarchy */
export interface CallHierarchyItem {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  column: number;
}

/** Result of a call hierarchy query */
export interface CallHierarchyResult {
  item: CallHierarchyItem;
  incoming: CallHierarchyItem[];
  outgoing: CallHierarchyItem[];
}

/** An item in a type hierarchy */
export interface TypeHierarchyItem {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
}

/** Result of a type hierarchy query */
export interface TypeHierarchyResult {
  item: TypeHierarchyItem;
  supertypes: TypeHierarchyItem[];
  subtypes: TypeHierarchyItem[];
}

/** An unused import or export */
export interface UnusedItem {
  name: string;
  kind: "import" | "export";
  file: string;
  line: number;
}

/**
 * All methods are optional — backends implement what they can.
 * The router calls the highest-tier backend that supports each operation.
 */
export interface IntelligenceBackend {
  readonly name: string;
  readonly tier: number;

  /** Initialize the backend (lazy — called on first use) */
  initialize?(cwd: string): Promise<void>;

  /** Dispose resources */
  dispose?(): void;

  /** Check if this backend supports a given language */
  supportsLanguage(language: Language): boolean;

  findDefinition?(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null>;

  findReferences?(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null>;

  findSymbols?(file: string, query?: string): Promise<SymbolInfo[] | null>;

  findImports?(file: string): Promise<ImportInfo[] | null>;
  findExports?(file: string): Promise<ExportInfo[] | null>;

  getDiagnostics?(file: string): Promise<Diagnostic[] | null>;
  getTypeInfo?(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<TypeInfo | null>;
  getFileOutline?(file: string): Promise<FileOutline | null>;

  readSymbol?(file: string, symbolName: string, symbolKind?: SymbolKind): Promise<CodeBlock | null>;

  readScope?(file: string, startLine: number, endLine?: number): Promise<CodeBlock | null>;

  rename?(
    file: string,
    symbol: string,
    newName: string,
    line?: number,
    column?: number,
  ): Promise<RefactorResult | null>;

  extractFunction?(
    file: string,
    startLine: number,
    endLine: number,
    functionName: string,
  ): Promise<RefactorResult | null>;

  extractVariable?(
    file: string,
    startLine: number,
    endLine: number,
    variableName: string,
  ): Promise<RefactorResult | null>;

  getCodeActions?(
    file: string,
    startLine: number,
    endLine: number,
    diagnosticCodes?: (string | number)[],
  ): Promise<CodeAction[] | null>;

  findWorkspaceSymbols?(query: string): Promise<SymbolInfo[] | null>;

  formatDocument?(file: string): Promise<FormatEdit | null>;

  formatRange?(file: string, startLine: number, endLine: number): Promise<FormatEdit | null>;

  organizeImports?(file: string): Promise<RefactorResult | null>;

  fixAll?(file: string): Promise<RefactorResult | null>;

  getCallHierarchy?(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<CallHierarchyResult | null>;

  findImplementation?(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null>;

  getTypeHierarchy?(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<TypeHierarchyResult | null>;

  findUnused?(file: string): Promise<UnusedItem[] | null>;

  getFileRenameEdits?(
    files: Array<{ oldPath: string; newPath: string }>,
  ): Promise<RefactorResult | null>;

  notifyFilesRenamed?(files: Array<{ oldPath: string; newPath: string }>): void;
}

export type BackendPreference = "auto" | "ts-morph" | "lsp" | "tree-sitter" | "regex";

export interface CodeIntelligenceConfig {
  /** Force a specific backend instead of auto-detecting */
  backend?: BackendPreference;
  /** Override auto-detected language */
  language?: string;
}
