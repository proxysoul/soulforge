import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RegexBackend } from "../src/core/intelligence/backends/regex.js";
import { replaceInCode } from "../src/core/tools/rename-symbol.js";
import { findSymbolRange, findCommentStart } from "../src/core/tools/move-symbol.js";

/**
 * Cross-language edge case tests.
 *
 * Tests the regex backend, replaceInCode state machine, scope extraction,
 * comment detection, and definition patterns across all supported languages.
 * Priority: no hangs, no crashes, correct scope boundaries.
 */

const TMP = join(tmpdir(), `cross-lang-${Date.now()}`);
const backend = new RegexBackend();

function writeTemp(name: string, content: string): string {
  const path = join(TMP, name);
  writeFileSync(path, content);
  return path;
}

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// ══════════════════════════════════════════════════════════════
// replaceInCode — language-specific comment syntax (with filePath)
// ══════════════════════════════════════════════════════════════

describe("replaceInCode — language-specific comment syntax", () => {
  it("Lua: -- line comment is skipped", () => {
    const src = "-- foo is here\nfoo()";
    expect(replaceInCode(src, "foo", "bar", "/a/b.lua")).toBe("-- foo is here\nbar()");
  });

  it("Lua: --[[ block comment ]] is skipped", () => {
    const src = "--[[ foo ]] foo()";
    expect(replaceInCode(src, "foo", "bar", "/a/b.lua")).toBe("--[[ foo ]] bar()");
  });

  it("Haskell: -- line comment is skipped", () => {
    const src = "-- foo definition\nfoo = 42";
    expect(replaceInCode(src, "foo", "bar", "/a/b.hs")).toBe("-- foo definition\nbar = 42");
  });

  it("Haskell: {- block comment -} is skipped", () => {
    const src = "{- foo -} foo = 42";
    expect(replaceInCode(src, "foo", "bar", "/a/b.hs")).toBe("{- foo -} bar = 42");
  });

  it("SQL: -- line comment is skipped", () => {
    const src = "-- select foo\nSELECT foo FROM bar;";
    expect(replaceInCode(src, "foo", "bar", "/a/b.sql")).toBe(
      "-- select foo\nSELECT bar FROM bar;",
    );
  });

  it("HTML: <!-- comment --> is skipped", () => {
    const src = "<!-- foo --> <div>foo</div>";
    expect(replaceInCode(src, "foo", "bar", "/a/b.html")).toBe("<!-- foo --> <div>bar</div>");
  });

  it("Erlang: % line comment is skipped", () => {
    const src = "% foo module\nfoo() -> ok.";
    expect(replaceInCode(src, "foo", "bar", "/a/b.erl")).toBe("% foo module\nbar() -> ok.");
  });

  it("OCaml: (* block comment *) is skipped", () => {
    const src = "(* foo *) let foo = 42";
    expect(replaceInCode(src, "foo", "bar", "/a/b.ml")).toBe("(* foo *) let bar = 42");
  });

  it("Clojure: ; line comment is skipped", () => {
    const src = "; foo binding\n(def foo 42)";
    expect(replaceInCode(src, "foo", "bar", "/a/b.clj")).toBe("; foo binding\n(def bar 42)");
  });

  it("Scheme: ;; line comment is skipped", () => {
    const src = ";; foo procedure\n(define foo 42)";
    expect(replaceInCode(src, "foo", "bar", "/a/b.scm")).toBe(";; foo procedure\n(define bar 42)");
  });

  it("Ruby: # line comment is skipped", () => {
    const src = "# foo method\ndef foo; end";
    expect(replaceInCode(src, "foo", "bar", "/a/b.rb")).toBe("# foo method\ndef bar; end");
  });

  it("Shell: # line comment is skipped", () => {
    const src = "# call foo\nfoo --flag";
    expect(replaceInCode(src, "foo", "bar", "/a/b.sh")).toBe("# call foo\nbar --flag");
  });

  it("YAML: # line comment is skipped", () => {
    const src = "foo: value # foo is key\nbar: foo";
    expect(replaceInCode(src, "foo", "baz", "/a/b.yaml")).toBe("baz: value # foo is key\nbar: baz");
  });

  it("Ada: -- line comment is skipped", () => {
    const src = "-- foo declaration\nfoo : Integer;";
    expect(replaceInCode(src, "foo", "bar", "/a/b.ada")).toBe(
      "-- foo declaration\nbar : Integer;",
    );
  });

  it("-- is NOT treated as comment for JS files", () => {
    const src = "x--;\nfoo()";
    expect(replaceInCode(src, "foo", "bar", "/a/b.js")).toBe("x--;\nbar()");
  });

  it("; is NOT treated as comment for JS files", () => {
    const src = "foo; bar()";
    expect(replaceInCode(src, "foo", "bar", "/a/b.js")).toBe("bar; bar()");
  });

  it("# is NOT treated as comment for CSS files", () => {
    const src = ".foo { color: #fff; }";
    expect(replaceInCode(src, "foo", "bar", "/a/b.css")).toBe(".bar { color: #fff; }");
  });

  it("# is NOT treated as comment for C files (preprocessor)", () => {
    const src = '#include "foo.h"\nfoo();';
    expect(replaceInCode(src, "foo", "bar", "/a/b.c")).toBe('#include "foo.h"\nbar();');
  });

  it("without filePath, # comment still works (backward compat)", () => {
    const src = "# foo comment\nfoo()";
    expect(replaceInCode(src, "foo", "bar")).toBe("# foo comment\nbar()");
  });

  it("without filePath, // and /* comments still work", () => {
    const src = "// foo\n/* foo */\nfoo()";
    expect(replaceInCode(src, "foo", "bar")).toBe("// foo\n/* foo */\nbar()");
  });
});

// ══════════════════════════════════════════════════════════════
// replaceInCode — string syntax across languages
// ══════════════════════════════════════════════════════════════

describe("replaceInCode — language-specific string handling", () => {
  it("Python: triple-double-quoted string", () => {
    // Each " is handled as a separate string: "" is empty, then "foo" is a string, then "" is empty
    const src = '"""foo"""\nfoo()';
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });

  it("Python: triple-single-quoted string", () => {
    const src = "'''foo'''\nfoo()";
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });

  it("Python: f-string (NOT handled like template literals)", () => {
    // f'hello {foo}' — the f is just code, then 'hello {foo}' is a regular string
    const src = "x = f'hello {foo}'\nfoo()";
    const result = replaceInCode(src, "foo", "bar");
    // foo inside the f-string is NOT replaced (it's inside single quotes)
    expect(result).toBe("x = f'hello {foo}'\nbar()");
  });

  it("Rust: raw string r#\"...\"#", () => {
    // r#" is not a recognized string delimiter, so the content is treated as code
    const src = 'let s = r#"foo"#;\nfoo();';
    const result = replaceInCode(src, "foo", "bar");
    // The " inside r#"..." will be treated as a string start
    expect(result).toContain("bar()");
  });

  it("Rust: byte string b\"...\"", () => {
    const src = 'let s = b"foo";\nfoo();';
    const result = replaceInCode(src, "foo", "bar");
    // b" → "b" is code, then "foo" is a string (foo preserved), then code
    expect(result).toContain("bar()");
  });

  it("Go: raw string with backticks", () => {
    // Go uses backticks for raw strings, but our parser treats them as template literals
    const src = 'foo := `raw foo string`\nfoo()';
    const result = replaceInCode(src, "foo", "bar");
    // foo inside backtick is treated as template literal text (not replaced)
    expect(result).toContain("bar()");
  });

  it("C: char literal", () => {
    const src = "char c = 'f';\nfoo();";
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toBe("char c = 'f';\nbar();");
  });

  it("Java: text block (triple double-quotes)", () => {
    const src = 'String s = """\n    foo\n    """;\nfoo();';
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });

  it("Kotlin: raw string with dollar interpolation", () => {
    const src = 'val s = """$foo"""\nfoo()';
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });

  it("Swift: multiline string literal", () => {
    const src = 'let s = """\n    foo\n    """\nfoo()';
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });

  it("PHP: heredoc", () => {
    const src = "$foo = <<<EOT\nfoo text\nEOT;\nfoo();";
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });

  it("Ruby: heredoc", () => {
    const src = "foo = <<~HEREDOC\n  foo content\nHEREDOC\nfoo()";
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });

  it("Ruby: %w() word array", () => {
    const src = "arr = %w(foo bar)\nfoo()";
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });
});

// ══════════════════════════════════════════════════════════════
// replaceInCode — operator edge cases across languages
// ══════════════════════════════════════════════════════════════

describe("replaceInCode — operator edge cases", () => {
  it("C++: scope resolution operator ::", () => {
    expect(replaceInCode("std::foo::bar()", "bar", "baz")).toBe("std::foo::baz()");
  });

  it("Rust: path separator ::", () => {
    expect(replaceInCode("crate::foo::bar()", "bar", "baz")).toBe("crate::foo::baz()");
  });

  it("PHP: namespace separator \\", () => {
    const src = "App\\Models\\foo::query();";
    expect(replaceInCode(src, "foo", "bar")).toBe("App\\Models\\bar::query();");
  });

  it("Ruby: method call with ? suffix", () => {
    // foo? is a different symbol from foo
    expect(replaceInCode("foo.empty?", "foo", "bar")).toBe("bar.empty?");
  });

  it("Ruby: method call with ! suffix", () => {
    expect(replaceInCode("foo.save!", "foo", "bar")).toBe("bar.save!");
  });

  it("Elixir: pipe operator |>", () => {
    expect(replaceInCode("foo |> bar |> baz", "bar", "qux")).toBe("foo |> qux |> baz");
  });

  it("Rust: turbofish ::<>", () => {
    expect(replaceInCode("foo::<i32>()", "foo", "bar")).toBe("bar::<i32>()");
  });

  it("Go: short variable declaration :=", () => {
    expect(replaceInCode("foo := bar()", "foo", "baz")).toBe("baz := bar()");
  });

  it("Haskell: function composition .", () => {
    expect(replaceInCode("foo . bar . baz", "bar", "qux")).toBe("foo . qux . baz");
  });

  it("multiple consecutive slashes (path-like)", () => {
    expect(() => replaceInCode("foo // bar // baz", "foo", "x")).not.toThrow();
  });

  it("Zig: error union !", () => {
    expect(replaceInCode("fn foo() !void {}", "foo", "bar")).toBe("fn bar() !void {}");
  });
});

// ══════════════════════════════════════════════════════════════
// RegexBackend — language-specific symbol detection
// ══════════════════════════════════════════════════════════════

describe("RegexBackend — language-specific symbols", () => {
  // Java
  it("Java: public static method", async () => {
    const f = writeTemp("Main.java", "public class Main {\n    public static void main(String[] args) {}\n}");
    const symbols = await backend.findSymbols(f);
    // Falls back to TS_PATTERNS — "public" doesn't match TS function/class patterns
    expect(symbols).not.toBeNull();
  });

  it("Java: interface with generics", async () => {
    const f = writeTemp("Comparable.java", "public interface Comparable<T> {\n    int compareTo(T other);\n}");
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  // C
  it("C: function with pointer return", async () => {
    const f = writeTemp("main.c", "int* foo(void) {\n    return NULL;\n}");
    const symbols = await backend.findSymbols(f);
    // TS_PATTERNS won't match "int* foo" — no "function" keyword
    expect(symbols).not.toBeNull();
  });

  it("C: typedef struct", async () => {
    const f = writeTemp("types.c", "typedef struct {\n    int x;\n} Point;");
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("C: #define with continuation", async () => {
    const f = writeTemp("macros.c", "#define FOO \\\n    42\nint foo() { return FOO; }");
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  // C++
  it("C++: template class", async () => {
    const f = writeTemp("vec.cpp", "template<typename T>\nclass Vec {\npublic:\n    T* data;\n};");
    const symbols = await backend.findSymbols(f);
    const vec = symbols?.find((s) => s.name === "Vec");
    expect(vec).toBeDefined();
  });

  it("C++: namespace", async () => {
    const f = writeTemp("ns.cpp", "namespace mylib {\n    class Foo {};\n}");
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  // Ruby
  it("Ruby: class with modules", async () => {
    const f = writeTemp("model.rb", "module App\n  class User\n    def save\n      true\n    end\n  end\nend");
    const symbols = await backend.findSymbols(f);
    // TS_PATTERNS fallback — "module" and "def" won't match
    expect(symbols).not.toBeNull();
  });

  // PHP
  it("PHP: class with namespace", async () => {
    const f = writeTemp("User.php", "<?php\nnamespace App\\Models;\n\nclass User {\n    public function save() {}\n}");
    const symbols = await backend.findSymbols(f);
    const user = symbols?.find((s) => s.name === "User");
    // "class" matches TS class pattern
    expect(user).toBeDefined();
  });

  // Swift
  it("Swift: struct with protocol conformance", async () => {
    const f = writeTemp("Point.swift", "struct Point: Codable {\n    var x: Double\n    var y: Double\n}");
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  // Kotlin
  it("Kotlin: data class (GAP: 'data class' not matched by TS fallback)", async () => {
    const f = writeTemp("User.kt", "data class User(\n    val name: String,\n    val age: Int\n)");
    const symbols = await backend.findSymbols(f);
    // "data class" — TS_PATTERNS only match bare "class", not "data class"
    const user = symbols?.find((s) => s.name === "User");
    expect(user).toBeUndefined();
  });

  // Scala
  it("Scala: case class (GAP: 'case class' not matched by TS fallback)", async () => {
    const f = writeTemp("Model.scala", "case class Config(\n    host: String,\n    port: Int\n)");
    const symbols = await backend.findSymbols(f);
    // "case class" — TS_PATTERNS only match bare "class"
    const config = symbols?.find((s) => s.name === "Config");
    expect(config).toBeUndefined();
  });

  // Elixir
  it("Elixir: defmodule", async () => {
    const f = writeTemp("app.ex", "defmodule App do\n  def start do\n    :ok\n  end\nend");
    const symbols = await backend.findSymbols(f);
    // TS_PATTERNS fallback — won't match defmodule
    expect(symbols).not.toBeNull();
  });

  // Dart
  it("Dart: class with mixins", async () => {
    const f = writeTemp("widget.dart", "class MyWidget extends StatelessWidget {\n  Widget build(BuildContext context) => Container();\n}");
    const symbols = await backend.findSymbols(f);
    const widget = symbols?.find((s) => s.name === "MyWidget");
    expect(widget).toBeDefined();
  });

  // Zig
  it("Zig: pub fn", async () => {
    const f = writeTemp("main.zig", "pub fn main() !void {\n    std.debug.print(\"hello\", .{});\n}");
    const symbols = await backend.findSymbols(f);
    // TS_PATTERNS fallback — "pub fn" won't match "function"
    expect(symbols).not.toBeNull();
  });

  // Lua
  it("Lua: local function (GAP: trimStart doesn't expose 'function' keyword)", async () => {
    const f = writeTemp("init.lua", "local function setup(opts)\n    vim.g.loaded = true\nend");
    const symbols = await backend.findSymbols(f);
    // "local function setup" → trimStart → "local function setup"
    // TS_PATTERNS.function = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/
    // Doesn't match "local" prefix → not found
    const setup = symbols?.find((s) => s.name === "setup");
    expect(setup).toBeUndefined();
  });

  it("Lua: module function (M.foo)", async () => {
    const f = writeTemp("mod.lua", "local M = {}\nfunction M.setup(opts)\n    return opts\nend\nreturn M");
    const symbols = await backend.findSymbols(f);
    // "function M.setup" — TS pattern captures first word after "function" → "M"
    expect(symbols).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// Scope extraction — non-brace languages
// ══════════════════════════════════════════════════════════════

describe("scope extraction — keyword-delimited languages", () => {
  it("Ruby: def...end (GAP: regex backend can't find 'def' with TS patterns)", async () => {
    const src = "def foo\n  puts 'hello'\nend\ndef bar\n  puts 'world'\nend";
    const f = writeTemp("methods.rb", src);
    const block = await backend.readSymbol(f, "foo");
    // .rb is "unknown" → TS_PATTERNS fallback → "def" not recognized → symbol not found
    expect(block).toBeNull();
  });

  it("Elixir: do...end blocks (GAP: not recognized by TS fallback)", async () => {
    const f = writeTemp("app.ex", "def foo do\n  :ok\nend\n\ndef bar do\n  :error\nend");
    const block = await backend.readSymbol(f, "foo");
    // .ex is "unknown" → TS_PATTERNS → "def" not recognized
    expect(block).toBeNull();
  });

  it("Lua: function...end", async () => {
    const f = writeTemp("func.lua", "function foo()\n  print('hi')\nend\nfunction bar()\n  print('bye')\nend");
    const block = await backend.readSymbol(f, "foo");
    expect(block).not.toBeNull();
  });

  it("Python: deeply nested with mixed indentation (tabs + spaces)", async () => {
    const src = "def foo():\n\tif True:\n\t    return 1\n\treturn 2\n\ndef bar():\n    pass";
    const f = writeTemp("mixed.py", src);
    const block = await backend.readSymbol(f, "foo");
    expect(block).not.toBeNull();
    expect(block?.content).not.toContain("bar");
  });

  it("Python: decorator before function", async () => {
    const src = "@decorator\ndef foo():\n    pass\n\ndef bar():\n    pass";
    const f = writeTemp("deco.py", src);
    // findSymbols matches "def foo" at line 1, not the decorator at line 0
    const symbols = await backend.findSymbols(f, "foo");
    expect(symbols?.[0]?.location.line).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════
// findSymbolRange — cross-language keyword coverage
// ══════════════════════════════════════════════════════════════

describe("findSymbolRange — keyword coverage", () => {
  it("Rust: impl block", () => {
    const lines = ["impl Foo {", "    fn bar() {}", "}"];
    expect(findSymbolRange(lines, "Foo")).toEqual({ start: 0, end: 2 });
  });

  it("Rust: trait definition", () => {
    const lines = ["pub trait Handler {", "    fn handle(&self);", "}"];
    expect(findSymbolRange(lines, "Handler")).toEqual({ start: 0, end: 2 });
  });

  it("Rust: pub(crate) struct", () => {
    const lines = ["pub(crate) struct Config {", "    pub name: String,", "}"];
    expect(findSymbolRange(lines, "Config")).toEqual({ start: 0, end: 2 });
  });

  it("Go: func with receiver", () => {
    // "func (s *Server) Start" — the pattern matches "func" but expects symbol right after
    const lines = ["func Start() {", "    return", "}"];
    expect(findSymbolRange(lines, "Start")).toEqual({ start: 0, end: 2 });
  });

  it("Go: type struct", () => {
    // findSymbolRange doesn't have "type" in its pattern for Go-style declarations
    // Actually it does: the pattern includes all keywords across languages
    const lines = ["type Config struct {", "    Name string", "}"];
    // Regex expects "type Config" — but the keyword list has "type" so it should match
    // Wait: the pattern is (type)\s+Config → matches "type Config"
    const result = findSymbolRange(lines, "Config");
    expect(result).not.toBeNull();
  });

  it("Python: class", () => {
    const lines = ["class User:", "    name = ''", "    age = 0"];
    // Python class has no braces and no semicolons → doesn't break, end stays at start
    const result = findSymbolRange(lines, "User");
    expect(result).not.toBeNull();
  });

  it("C#: abstract class", () => {
    const lines = ["abstract class Base {", "    public abstract void Run();", "}"];
    expect(findSymbolRange(lines, "Base")).toEqual({ start: 0, end: 2 });
  });

  it("symbol not in keyword position (variable assignment)", () => {
    const lines = ["foo = bar();", "function baz() {}"];
    expect(findSymbolRange(lines, "foo")).toBeNull();
  });

  it("symbol in comment — regex has leading whitespace check", () => {
    const lines = ["// function foo() {}", "const x = 1;"];
    // "// function foo()" → trimStart but regex anchors on ^\\s* → matches
    // Wait: the line is "// function foo() {}" → "// function..." doesn't match
    // because the regex expects (interface|type|class|function|...) at pattern start,
    // but the line starts with "//"
    expect(findSymbolRange(lines, "foo")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// findCommentStart — cross-language doc comments
// ══════════════════════════════════════════════════════════════

describe("findCommentStart — cross-language", () => {
  it("Java: Javadoc", () => {
    const lines = ["/**", " * Description", " * @param x the value", " */", "public void foo() {}"];
    expect(findCommentStart(lines, 4)).toBe(0);
  });

  it("Rust: /// doc comment + #[derive] (GAP: interleaved comments and attrs)", () => {
    const lines = ["/// A config struct", "#[derive(Debug, Clone)]", "#[serde(rename_all = \"camelCase\")]", "pub struct Config {}"];
    // First pass (comments): starts at line 2, "///..." at line 0 found, but line 1 "#[derive...]"
    // breaks the comment scan. So only line 2 is reached? No:
    // i=2: "#[serde..." doesn't start with *, /**, ///, // → break. start stays at 3.
    // Second pass (attrs): i=2: starts with "#[" → start=2. i=1: starts with "#[" → start=1.
    // i=0: "///" doesn't start with "#[" → break. Result: 1
    // Known limitation: interleaving /// and #[] isn't handled
    expect(findCommentStart(lines, 3)).toBe(1);
  });

  it("Python: # comment (NOT recognized by findCommentStart)", () => {
    const lines = ["# This is a Python docstring alternative", "def foo():", "    pass"];
    // findCommentStart only recognizes //, /*, ///, #[
    // "#" does NOT match any of these patterns
    expect(findCommentStart(lines, 1)).toBe(1);
  });

  it("Lua: -- comment (NOT recognized)", () => {
    const lines = ["-- setup function", "function setup() end"];
    expect(findCommentStart(lines, 1)).toBe(1);
  });

  it("Go: // comment block", () => {
    const lines = ["// NewServer creates a new server.", "// It accepts options.", "func NewServer() {}"];
    expect(findCommentStart(lines, 2)).toBe(0);
  });

  it("C: /* block comment */ on one line above definition", () => {
    const lines = ["/* Initialize the module */", "void init() {}"];
    // "/* Initialize..." starts with "/*" which starts with "*"? No. "/" is first char.
    // Actually: trim gives "/* Initialize..." which doesn't start with "*", "/**", "///", "//" or equal "*/"
    // So findCommentStart does NOT include it! Known gap for C-style /* */ on a single line.
    expect(findCommentStart(lines, 1)).toBe(1);
  });

  it("C: multi-line /* ... */ block above definition", () => {
    const lines = ["/*", " * Initialize the module", " */", "void init() {}"];
    // Line 2: trim = "*/" → equals "*/" → included
    // Line 1: trim = "* Initialize..." → starts with "*" → included
    // Line 0: trim = "/*" → doesn't start with "*" (starts with "/") → NOT included
    // So it captures lines 1-2 but misses the opening "/*"
    expect(findCommentStart(lines, 3)).toBe(1); // misses "/*" line
  });

  it("Swift: /// doc comment", () => {
    const lines = ["/// A point in 2D space", "struct Point {}"];
    expect(findCommentStart(lines, 1)).toBe(0);
  });

  it("consecutive blank lines between comment and def", () => {
    const lines = ["// comment", "", "", "function foo() {}"];
    // Blank lines break the scan — comment not included
    expect(findCommentStart(lines, 3)).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════
// RegexBackend — file extension edge cases
// ══════════════════════════════════════════════════════════════

describe("RegexBackend — extension edge cases", () => {
  it(".mts file detected as typescript", async () => {
    const f = writeTemp("mod.mts", "export function foo() {}");
    const outline = await backend.getFileOutline(f);
    expect(outline?.language).toBe("typescript");
  });

  it(".cjs file detected as javascript", async () => {
    const f = writeTemp("config.cjs", "function setup() {}");
    const outline = await backend.getFileOutline(f);
    expect(outline?.language).toBe("javascript");
  });

  it(".jsx file detected as javascript", async () => {
    const f = writeTemp("App.jsx", "function App() { return null; }");
    const outline = await backend.getFileOutline(f);
    expect(outline?.language).toBe("javascript");
  });

  it("Makefile detected by bare filename", async () => {
    const f = writeTemp("Makefile", "function build() {}");
    const outline = await backend.getFileOutline(f);
    expect(outline?.language).toBe("makefile");
  });

  it(".vue file is detected as vue by regex backend", async () => {
    const f = writeTemp("App.vue", "<script>\nfunction setup() {}\n</script>");
    const outline = await backend.getFileOutline(f);
    // Now detected via centralized EXT_TO_LANGUAGE map
    expect(outline?.language).toBe("vue");
  });

  it(".luau file detected as lua", async () => {
    const f = writeTemp("Module.luau", "local function setup(opts)\n    return opts\nend");
    const outline = await backend.getFileOutline(f);
    expect(outline?.language).toBe("lua");
  });

  it("double extension .test.ts detected as typescript", async () => {
    const f = writeTemp("app.test.ts", "function test() {}");
    const outline = await backend.getFileOutline(f);
    expect(outline?.language).toBe("typescript");
  });

  it(".d.ts declaration file detected as typescript", async () => {
    const f = writeTemp("types.d.ts", "interface Foo { bar: string; }");
    const outline = await backend.getFileOutline(f);
    expect(outline?.language).toBe("typescript");
  });
});

// ══════════════════════════════════════════════════════════════
// Pathological inputs — multi-language
// ══════════════════════════════════════════════════════════════

describe("pathological inputs — no hangs", () => {
  it("file with 10000 hash comments (Python/Ruby)", async () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `# comment ${i}`);
    lines.push("def foo():\n    pass");
    const f = writeTemp("manycomments.py", lines.join("\n"));
    const symbols = await backend.findSymbols(f, "foo");
    expect(symbols).toHaveLength(1);
  });

  it("file with 1000 unclosed strings", async () => {
    const lines = Array.from({ length: 1000 }, () => '"unclosed');
    const f = writeTemp("broken.ts", lines.join("\n"));
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("file with only braces", async () => {
    const f = writeTemp("braces.ts", "function foo() " + "{".repeat(500) + "}".repeat(500));
    const block = await backend.readSymbol(f, "foo");
    expect(block).not.toBeNull();
  });

  it("replaceInCode on 100KB source", () => {
    const src = "foo; ".repeat(20000);
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar");
    expect(result).not.toContain("foo");
  });

  it("replaceInCode on source with every special char", () => {
    const src = 'foo / "foo" \'foo\' `foo` // foo\n/* foo */\n# foo\nfoo';
    const result = replaceInCode(src, "foo", "X");
    expect(result).toContain("X");
  });

  it("Rust: deeply nested generic types", async () => {
    const f = writeTemp("generic.rs", "pub fn foo(x: Vec<HashMap<String, Vec<Option<Box<dyn Trait>>>>>) {}");
    const symbols = await backend.findSymbols(f);
    expect(symbols?.find((s) => s.name === "foo")).toBeDefined();
  });

  it("C++: template metaprogramming", async () => {
    const f = writeTemp("tmpl.cpp", "template<typename... Args>\nclass Tuple {};");
    const symbols = await backend.findSymbols(f);
    expect(symbols?.find((s) => s.name === "Tuple")).toBeDefined();
  });

  it("file mixing multiple languages (e.g. embedded SQL in Python)", async () => {
    const src = 'def foo():\n    query = """SELECT * FROM foo WHERE id = 1"""\n    return query';
    const f = writeTemp("mixed.py", src);
    const symbols = await backend.findSymbols(f, "foo");
    expect(symbols).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════
// Mobile development languages — Swift, Kotlin, Objective-C, Dart
// ══════════════════════════════════════════════════════════════

describe("mobile dev — Swift", () => {
  it("SwiftUI view struct", async () => {
    const src = "struct ContentView: View {\n    var body: some View {\n        Text(\"Hello\")\n    }\n}";
    const f = writeTemp("ContentView.swift", src);
    const symbols = await backend.findSymbols(f);
    // .swift is "unknown" → TS fallback → no "struct" pattern
    expect(symbols).not.toBeNull();
  });

  it("Swift class with @objc attribute", async () => {
    const src = "@objc class AppDelegate: NSObject {\n    func applicationDidFinishLaunching() {}\n}";
    const f = writeTemp("AppDelegate.swift", src);
    const symbols = await backend.findSymbols(f);
    // "@objc class" → trimStart → "@objc class" → TS class pattern expects "class" at start
    expect(symbols).not.toBeNull();
  });

  it("Swift protocol with associated type", async () => {
    const src = "protocol Repository {\n    associatedtype Item\n    func fetch() -> [Item]\n}";
    const f = writeTemp("Repository.swift", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("Swift enum with raw values", async () => {
    const src = "enum Direction: String {\n    case north = \"N\"\n    case south = \"S\"\n}";
    const f = writeTemp("Direction.swift", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("replaceInCode on Swift with string interpolation \\()", () => {
    const src = 'let msg = "Hello \\(foo)"\nfoo()';
    const result = replaceInCode(src, "foo", "bar");
    // \\(foo) is inside a string → protected. But \\ is an escape → ( is next char → consumed
    expect(result).toContain("bar()");
  });

  it("Swift guard/if let pattern", () => {
    const src = "guard let foo = optional else { return }\nfoo.doSomething()";
    expect(replaceInCode(src, "foo", "bar")).toContain("bar.doSomething()");
  });
});

describe("mobile dev — Kotlin", () => {
  it("Kotlin companion object", async () => {
    const src = "class Factory {\n    companion object {\n        fun create(): Factory = Factory()\n    }\n}";
    const f = writeTemp("Factory.kt", src);
    const symbols = await backend.findSymbols(f);
    const factory = symbols?.find((s) => s.name === "Factory");
    expect(factory).toBeDefined();
  });

  it("Kotlin suspend function", async () => {
    const src = "suspend fun fetchData(): Result {\n    return api.get()\n}";
    const f = writeTemp("Network.kt", src);
    const symbols = await backend.findSymbols(f);
    // "suspend fun" — TS pattern doesn't match "suspend"
    expect(symbols).not.toBeNull();
  });

  it("Kotlin sealed class", async () => {
    const src = "sealed class Result {\n    data class Success(val data: String) : Result()\n    data class Error(val msg: String) : Result()\n}";
    const f = writeTemp("Result.kt", src);
    const symbols = await backend.findSymbols(f);
    // "sealed class" → TS patterns match "class Result"? No — "sealed" prefix blocks it
    expect(symbols).not.toBeNull();
  });

  it("Kotlin object declaration", async () => {
    const src = "object Singleton {\n    val instance = this\n}";
    const f = writeTemp("Singleton.kt", src);
    const symbols = await backend.findSymbols(f);
    // "object" is not in TS_PATTERNS
    expect(symbols).not.toBeNull();
  });

  it("Kotlin extension function", async () => {
    const src = "fun String.isEmail(): Boolean {\n    return this.contains(\"@\")\n}";
    const f = writeTemp("Extensions.kt", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("replaceInCode on Kotlin string template", () => {
    const src = 'val msg = "Hello $foo and ${foo.name}"\nfoo()';
    const result = replaceInCode(src, "foo", "bar");
    // $foo and ${foo.name} are inside double quotes → NOT replaced (correct)
    expect(result).toContain("bar()");
  });
});

describe("mobile dev — Objective-C", () => {
  it("ObjC @interface declaration", async () => {
    const src = "@interface AppDelegate : NSObject\n@property (strong) NSWindow *window;\n@end";
    const f = writeTemp("AppDelegate.m", src);
    const symbols = await backend.findSymbols(f);
    // .m → "unknown" → TS fallback. "@interface" doesn't match TS patterns
    expect(symbols).not.toBeNull();
  });

  it("ObjC method with type info", async () => {
    const src = "- (void)viewDidLoad {\n    [super viewDidLoad];\n}";
    const f = writeTemp("ViewController.m", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("replaceInCode on ObjC string literal @\"...\"", () => {
    const src = 'NSString *s = @"foo";\nfoo();';
    const result = replaceInCode(src, "foo", "bar");
    // @" → @ is code, "foo" is a string → foo inside string NOT replaced
    expect(result).toContain("bar()");
  });
});

describe("mobile dev — Dart / Flutter", () => {
  it("Dart StatelessWidget", async () => {
    const src = "class MyApp extends StatelessWidget {\n  Widget build(BuildContext context) {\n    return MaterialApp();\n  }\n}";
    const f = writeTemp("main.dart", src);
    const symbols = await backend.findSymbols(f);
    const app = symbols?.find((s) => s.name === "MyApp");
    expect(app).toBeDefined();
  });

  it("Dart factory constructor", async () => {
    const src = "class Config {\n  factory Config.fromJson(Map json) {\n    return Config();\n  }\n}";
    const f = writeTemp("config.dart", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols?.find((s) => s.name === "Config")).toBeDefined();
  });

  it("Dart mixin", async () => {
    const src = "mixin Validatable {\n  bool validate() => true;\n}";
    const f = writeTemp("mixin.dart", src);
    const symbols = await backend.findSymbols(f);
    // "mixin" not in TS_PATTERNS
    expect(symbols).not.toBeNull();
  });

  it("Dart extension", async () => {
    const src = "extension StringExt on String {\n  bool get isBlank => trim().isEmpty;\n}";
    const f = writeTemp("ext.dart", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("replaceInCode on Dart string interpolation $var", () => {
    const src = "var msg = 'Hello $foo';\nfoo();";
    const result = replaceInCode(src, "foo", "bar");
    // $foo is inside single quotes → NOT replaced
    expect(result).toContain("bar()");
  });

  it("replaceInCode on Dart string interpolation ${expr}", () => {
    const src = "var msg = 'Hello ${foo.name}';\nfoo();";
    const result = replaceInCode(src, "foo", "bar");
    // Inside single quotes → NOT replaced
    expect(result).toContain("bar()");
  });
});

describe("mobile dev — React Native (TSX/JSX)", () => {
  it("TSX component with JSX", async () => {
    const src = "function App(): JSX.Element {\n  return <View><Text>Hello</Text></View>;\n}";
    const f = writeTemp("App.tsx", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols?.find((s) => s.name === "App")).toBeDefined();
  });

  it("replaceInCode on JSX with string props", () => {
    const src = '<Component foo="test" />\nfoo();';
    const result = replaceInCode(src, "foo", "bar");
    // "test" is a string → "foo" attribute name is code
    expect(result).toContain("bar()");
  });

  it("replaceInCode on JSX expression container {}", () => {
    const src = "<Text>{foo}</Text>\nfoo();";
    const result = replaceInCode(src, "foo", "bar");
    // {} in JSX — not backtick templates, just regular code
    expect(result).toBe("<Text>{bar}</Text>\nbar();");
  });

  it("TSX with generics (angle brackets don't confuse parser)", () => {
    const src = "function useQuery<T>(foo: T): T { return foo; }";
    expect(replaceInCode(src, "foo", "bar")).toBe("function useQuery<T>(bar: T): T { return bar; }");
  });
});

// ══════════════════════════════════════════════════════════════
// Game development — C#/Unity, C++/Unreal, GDScript, Lua
// ══════════════════════════════════════════════════════════════

describe("game dev — C# / Unity", () => {
  it("C# MonoBehaviour class", async () => {
    const src = "public class PlayerController : MonoBehaviour {\n    void Update() {\n        transform.Translate(Vector3.forward);\n    }\n}";
    const f = writeTemp("PlayerController.cs", src);
    const symbols = await backend.findSymbols(f);
    // .cs is "unknown" → TS fallback. "public class" doesn't match TS "class" directly
    // (TS expects optional "export" prefix, not "public")
    expect(symbols).not.toBeNull();
  });

  it("C# interface", async () => {
    const src = "public interface IDamageable {\n    void TakeDamage(float amount);\n}";
    const f = writeTemp("IDamageable.cs", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("C# generic class", async () => {
    const src = "public class ObjectPool<T> where T : new() {\n    private List<T> pool;\n}";
    const f = writeTemp("ObjectPool.cs", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("C# attribute (similar to Rust #[derive])", () => {
    const lines = ["[SerializeField]", "[Header(\"Settings\")]", "public class Config {}"];
    // findCommentStart only recognizes #[ (Rust), not [ (C#/Unity)
    expect(findCommentStart(lines, 2)).toBe(2);
  });

  it("replaceInCode on C# verbatim string @\"\"", () => {
    const src = 'string path = @"C:\\foo\\bar";\nfoo();';
    const result = replaceInCode(src, "foo", "bar");
    // @" → @ is code, "C:\foo\bar" is a string
    expect(result).toContain("bar()");
  });

  it("replaceInCode on C# interpolated string $\"\"", () => {
    const src = 'string msg = $"Hello {foo}";\nfoo();';
    const result = replaceInCode(src, "foo", "bar");
    // $" → $ is code, "Hello {foo}" is a string (foo inside NOT replaced)
    expect(result).toContain("bar()");
  });
});

describe("game dev — C++ / Unreal Engine", () => {
  it("UE UCLASS macro", async () => {
    const src = "UCLASS()\nclass AMyActor : public AActor {\n    GENERATED_BODY()\npublic:\n    void BeginPlay() override;\n};";
    const f = writeTemp("MyActor.cpp", src);
    const symbols = await backend.findSymbols(f);
    const actor = symbols?.find((s) => s.name === "AMyActor");
    expect(actor).toBeDefined();
  });

  it("UE USTRUCT", async () => {
    const src = "USTRUCT(BlueprintType)\nstruct FHealthData {\n    GENERATED_BODY()\n    float Health;\n};";
    const f = writeTemp("Health.cpp", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("C++ virtual destructor", async () => {
    const src = "class Base {\npublic:\n    virtual ~Base() = default;\n};";
    const f = writeTemp("Base.cpp", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols?.find((s) => s.name === "Base")).toBeDefined();
  });

  it("C++ operator overload (won't match symbol patterns)", async () => {
    const f = writeTemp("ops.cpp", "bool operator==(const Vec& a, const Vec& b) {\n    return a.x == b.x;\n}");
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("replaceInCode on C++ raw string R\"(...)\"", () => {
    const src = 'auto s = R"(foo)";\nfoo();';
    // R"(foo)" → R is code, "(foo)" → " is string start containing (foo)
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });

  it("C++ header guard #ifndef", () => {
    const src = "#ifndef FOO_H\n#define FOO_H\nclass Foo {};\n#endif";
    // # at line start → hash comment handler → everything after # is skipped per line
    const result = replaceInCode(src, "Foo", "Bar");
    expect(result).toContain("class Bar {}");
  });
});

describe("game dev — GDScript (Godot)", () => {
  it("GDScript class", async () => {
    const src = "class_name Player\nextends CharacterBody2D\n\nfunc _ready():\n    pass\n\nfunc _process(delta):\n    move_and_slide()";
    const f = writeTemp("Player.gd", src);
    const symbols = await backend.findSymbols(f);
    // .gd is "unknown" → TS fallback
    expect(symbols).not.toBeNull();
  });

  it("replaceInCode on GDScript (# comments, no braces)", () => {
    const src = "# Player class\nvar foo = 10\nfunc use_foo():\n    print(foo)";
    const result = replaceInCode(src, "foo", "bar");
    // # comment is recognized. "foo" in code regions replaced.
    expect(result).toContain("var bar = 10");
    expect(result).toContain("print(bar)");
    expect(result).toContain("# Player class"); // comment preserved
  });
});

describe("game dev — Lua (love2d, Roblox, WoW)", () => {
  it("Lua module pattern", async () => {
    const src = "local M = {}\n\nfunction M.init()\n    print('init')\nend\n\nreturn M";
    const f = writeTemp("module.lua", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("Lua metatables (__index)", async () => {
    const src = "local Class = {}\nClass.__index = Class\n\nfunction Class.new()\n    return setmetatable({}, Class)\nend";
    const f = writeTemp("class.lua", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("replaceInCode on Lua (-- comments NOT handled)", () => {
    const src = "-- foo definition\nlocal foo = 42\nprint(foo)";
    const result = replaceInCode(src, "foo", "bar");
    // "--" is not recognized as comment → foo inside comment IS replaced
    expect(result).toContain("-- bar definition");
    expect(result).toContain("local bar = 42");
  });

  it("replaceInCode on Lua long string [=[...]=]", () => {
    const src = "local s = [=[\nfoo content\n]=]\nprint(foo)";
    const result = replaceInCode(src, "foo", "bar");
    // [=[ is not recognized as string → foo inside IS replaced (known gap)
    expect(result).toContain("print(bar)");
  });
});

// ══════════════════════════════════════════════════════════════
// Config / data files that tools might encounter
// ══════════════════════════════════════════════════════════════

describe("config/data files — no crashes", () => {
  it("JSON file", async () => {
    const f = writeTemp("config.json", '{"name": "foo", "version": "1.0"}');
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("YAML-like content in unknown extension", async () => {
    const f = writeTemp("config.yaml", "name: foo\nversion: 1.0\ndependencies:\n  - bar\n  - baz");
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("TOML file", async () => {
    const f = writeTemp("Cargo.toml", '[package]\nname = "foo"\nversion = "0.1.0"');
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("Dockerfile", async () => {
    const f = writeTemp("Dockerfile", "FROM node:18\nRUN npm install\nCOPY . .\nCMD [\"node\", \"index.js\"]");
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("Makefile", async () => {
    const f = writeTemp("Makefile", "build:\n\tgo build -o app\n\ntest:\n\tgo test ./...");
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it(".env file (should not crash even if forbidden blocks it)", async () => {
    const f = writeTemp("test.env.example", "FOO=bar\nBAZ=123");
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("SQL file", async () => {
    const f = writeTemp("schema.sql", "CREATE TABLE foo (\n    id INTEGER PRIMARY KEY,\n    name TEXT\n);");
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("protobuf file", async () => {
    const f = writeTemp("service.proto", 'syntax = "proto3";\nmessage Foo {\n    string name = 1;\n}');
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("GraphQL schema", async () => {
    const f = writeTemp("schema.graphql", "type Query {\n    user(id: ID!): User\n}\n\ntype User {\n    name: String!\n}");
    const symbols = await backend.findSymbols(f);
    // "type" matches TS_PATTERNS.type → finds "Query" and "User"
    expect(symbols).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// replaceInCode — language edge cases
// ══════════════════════════════════════════════════════════════

describe("replaceInCode — language edge cases", () => {
  it("Ruby heredoc (treated as code — known limitation)", () => {
    const src = "foo = <<~HEREDOC\n  foo content\nHEREDOC\nfoo()";
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });

  it("Python f-string (treated as regular string)", () => {
    const src = 'foo = f"hello {foo}"\nfoo()';
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });

  it("Lua long string [[...]] (treated as code — known limitation)", () => {
    const src = "local foo = [[foo content]]\nfoo()";
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });

  it("Rust raw string r#\"...\"# (r is code, # starts hash comment context)", () => {
    const src = 'let foo = r#"foo text"#;\nfoo();';
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar();");
  });

  it("SQL dollar-quoted string (treated as code)", () => {
    const src = "SELECT foo FROM $$foo text$$ WHERE foo = 1";
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar");
  });

  it("C# verbatim string @\"...\" (treated as regular string)", () => {
    const src = 'var foo = @"foo content";\nfoo();';
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar();");
  });

  it("Kotlin triple-quoted string (each quote handled individually)", () => {
    const src = 'val foo = """foo text"""\nfoo()';
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });
});

// ══════════════════════════════════════════════════════════════
// RegexBackend — additional language coverage
// ══════════════════════════════════════════════════════════════

describe("RegexBackend — additional language coverage", () => {
  it("C header: void return type not matched by TS fallback", async () => {
    const src = "#include <stdio.h>\n#define MAX 100\nvoid process(int x) {\n  return;\n}";
    const f = writeTemp("test.c", src);
    const symbols = await backend.findSymbols(f);
    // TS fallback requires `function` keyword — C's `void process(...)` doesn't match
    expect(symbols?.find(s => s.name === "process")).toBeUndefined();
  });

  it("C-like: function keyword matches via TS fallback", async () => {
    const src = "function helper() {\n  return;\n}";
    const f = writeTemp("test2.c", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols?.find(s => s.name === "helper")).toBeDefined();
  });

  it("Ruby: class keyword matched via TS fallback", async () => {
    const src = "class MyClass\n  def initialize\n    @x = 1\n  end\nend";
    const f = writeTemp("test.rb", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols?.find(s => s.name === "MyClass")).toBeDefined();
  });

  it("Java: public class not matched — TS pattern expects export|abstract prefix", async () => {
    const src = "public class Main {\n  public static void main(String[] args) {\n  }\n}";
    const f = writeTemp("Test.java", src);
    const symbols = await backend.findSymbols(f);
    // "public class" doesn't match TS fallback pattern — documents coverage gap
    expect(symbols?.find(s => s.name === "Main")).toBeUndefined();
  });

  it("Java: plain class keyword matches via TS fallback", async () => {
    const src = "class Main {\n  void run() {}\n}";
    const f = writeTemp("Test2.java", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols?.find(s => s.name === "Main")).toBeDefined();
  });

  it("PHP: function detection", async () => {
    const src = "<?php\nfunction processData($input) {\n  return $input;\n}";
    const f = writeTemp("test.php", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols?.find(s => s.name === "processData")).toBeDefined();
  });

  it("Swift: func and class", async () => {
    const src = "class ViewController {\n  func viewDidLoad() {\n  }\n}";
    const f = writeTemp("test.swift", src);
    const symbols = await backend.findSymbols(f);
    expect(symbols?.find(s => s.name === "ViewController")).toBeDefined();
  });
});
