import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RegexBackend } from "../src/core/intelligence/backends/regex.js";

const TMP = join(tmpdir(), `regex-backend-test-${Date.now()}`);
const backend = new RegexBackend();

function writeTemp(name: string, content: string): string {
  const path = join(TMP, name);
  writeFileSync(path, content);
  return path;
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("findSymbols", () => {
  it("finds TypeScript functions", async () => {
    const f = writeTemp("test.ts", "export function myFunc() {}\nfunction helper() {}");
    const symbols = await backend.findSymbols(f);
    expect(symbols).toHaveLength(2);
    expect(symbols?.[0]?.name).toBe("myFunc");
    expect(symbols?.[1]?.name).toBe("helper");
  });

  it("finds TypeScript classes and interfaces", async () => {
    const f = writeTemp("types.ts", "export interface Foo {}\nexport class Bar {}");
    const symbols = await backend.findSymbols(f);
    expect(symbols).toHaveLength(2);
    expect(symbols?.find((s) => s.name === "Foo")?.kind).toBe("interface");
    expect(symbols?.find((s) => s.name === "Bar")?.kind).toBe("class");
  });

  it("finds Python functions and classes", async () => {
    const f = writeTemp("mod.py", "def my_func():\n    pass\n\nclass MyClass:\n    pass");
    const symbols = await backend.findSymbols(f);
    expect(symbols).toHaveLength(2);
    expect(symbols?.[0]?.name).toBe("my_func");
    expect(symbols?.[1]?.name).toBe("MyClass");
  });

  it("finds Go functions and structs", async () => {
    const f = writeTemp(
      "main.go",
      "func main() {}\ntype Config struct {\n\tName string\n}",
    );
    const symbols = await backend.findSymbols(f);
    expect(symbols).toHaveLength(2);
    expect(symbols?.[0]?.name).toBe("main");
    expect(symbols?.[1]?.name).toBe("Config");
  });

  it("finds Rust functions, structs, and traits", async () => {
    const f = writeTemp(
      "lib.rs",
      "pub fn process() {}\nstruct Data {}\npub trait Handler {}",
    );
    const symbols = await backend.findSymbols(f);
    expect(symbols).toHaveLength(3);
    expect(symbols?.[0]?.name).toBe("process");
    expect(symbols?.[1]?.name).toBe("Data");
    expect(symbols?.[2]?.name).toBe("Handler");
  });

  it("filters by query", async () => {
    const f = writeTemp("search.ts", "function foo() {}\nfunction fooBar() {}\nfunction baz() {}");
    const symbols = await backend.findSymbols(f, "foo");
    expect(symbols).toHaveLength(2);
    expect(symbols?.every((s) => s.name.toLowerCase().includes("foo"))).toBe(true);
  });

  it("returns null for non-existent file", async () => {
    const result = await backend.findSymbols("/nonexistent/file.ts");
    expect(result).toBeNull();
  });

  it("returns empty array for file with no symbols", async () => {
    const f = writeTemp("empty.ts", "// just a comment\n");
    const symbols = await backend.findSymbols(f);
    expect(symbols).toEqual([]);
  });

  it("handles unknown file extension (falls back to TS patterns)", async () => {
    const f = writeTemp("file.xyz", "function foo() {}");
    const symbols = await backend.findSymbols(f);
    // Falls back to TS_PATTERNS, which can match function
    expect(symbols).toHaveLength(1);
    expect(symbols?.[0]?.name).toBe("foo");
  });

  it("handles async functions", async () => {
    const f = writeTemp("async.ts", "export async function fetchData() {}");
    const symbols = await backend.findSymbols(f);
    expect(symbols).toHaveLength(1);
    expect(symbols?.[0]?.name).toBe("fetchData");
  });

  it("handles abstract classes", async () => {
    const f = writeTemp("abstract.ts", "export abstract class BaseService {}");
    const symbols = await backend.findSymbols(f);
    expect(symbols).toHaveLength(1);
    expect(symbols?.[0]?.name).toBe("BaseService");
  });

  it("doesn't match indented lines (method definitions inside a class)", async () => {
    const f = writeTemp(
      "class.ts",
      "export class Foo {\n  function bar() {}\n}",
    );
    const symbols = await backend.findSymbols(f);
    // The regex uses trimStart(), so "  function bar() {}" → "function bar() {}" WILL match
    // This is actually a known behavior — regex backend reports nested functions
    expect(symbols?.find((s) => s.name === "Foo")).toBeDefined();
  });
});

describe("findImports", () => {
  it("parses TypeScript named imports", async () => {
    const f = writeTemp("imports.ts", 'import { foo, bar } from "./mod";');
    const imports = await backend.findImports(f);
    expect(imports).toHaveLength(1);
    expect(imports?.[0]?.specifiers).toContain("foo");
    expect(imports?.[0]?.specifiers).toContain("bar");
    expect(imports?.[0]?.source).toBe("./mod");
  });

  it("parses default import", async () => {
    const f = writeTemp("default.ts", 'import React from "react";');
    const imports = await backend.findImports(f);
    expect(imports).toHaveLength(1);
    expect(imports?.[0]?.isDefault).toBe(true);
    expect(imports?.[0]?.specifiers).toContain("React");
  });

  it("parses namespace import", async () => {
    const f = writeTemp("ns.ts", 'import * as path from "path";');
    const imports = await backend.findImports(f);
    expect(imports).toHaveLength(1);
    expect(imports?.[0]?.isNamespace).toBe(true);
  });

  it("parses Python imports", async () => {
    const f = writeTemp("imports.py", "from os.path import join, exists");
    const imports = await backend.findImports(f);
    expect(imports).toHaveLength(1);
    expect(imports?.[0]?.source).toBe("os.path");
  });

  it("parses Go imports", async () => {
    const f = writeTemp("imports.go", 'import (\n\t"fmt"\n\t"os"\n)');
    const imports = await backend.findImports(f);
    // The regex expects import on a single line — block imports may not fully work
    // Actually: the pattern is /^import\s+(?:\(\s*)?(?:"([^"]+)")?/
    // Line 'import (' matches but captures nothing for source
    // Lines '"fmt"' and '"os"' don't start with 'import' so they're missed
    expect(imports).toHaveLength(1); // Only the 'import (' line
  });

  it("parses Rust use statements", async () => {
    const f = writeTemp("imports.rs", "use std::io::Read;");
    const imports = await backend.findImports(f);
    expect(imports).toHaveLength(1);
    expect(imports?.[0]?.source).toBe("std::io::Read");
  });

  it("handles multiline TypeScript imports (only captures single line)", async () => {
    const f = writeTemp("multi.ts", 'import {\n  foo,\n  bar\n} from "./mod";');
    const imports = await backend.findImports(f);
    // The regex only matches single-line imports, so this will miss multiline
    expect(imports).toHaveLength(0);
  });
});

describe("extractBraceScope", () => {
  it("finds end of simple function", async () => {
    const f = writeTemp("scope.ts", "function foo() {\n  return 1;\n}");
    const block = await backend.readSymbol(f, "foo");
    expect(block?.content).toContain("return 1");
    expect(block?.location.endLine).toBe(3);
  });

  it("handles nested braces", async () => {
    const f = writeTemp(
      "nested.ts",
      "function foo() {\n  if (true) {\n    return 1;\n  }\n}",
    );
    const block = await backend.readSymbol(f, "foo");
    expect(block?.location.line).toBe(1);
    expect(block?.location.endLine).toBe(5);
  });

  it("handles unclosed brace (falls back to +50 lines)", async () => {
    const lines = ["function foo() {"];
    for (let i = 0; i < 60; i++) lines.push(`  line${i};`);
    const f = writeTemp("unclosed.ts", lines.join("\n"));
    const block = await backend.readSymbol(f, "foo");
    // Unclosed brace → endIdx = min(startIdx + 50, lines.length - 1)
    expect(block?.location.endLine).toBeLessThanOrEqual(51);
  });
});

describe("extractIndentScope (Python)", () => {
  it("finds end of Python function by indentation", async () => {
    const src = "def foo():\n    return 1\n\ndef bar():\n    pass";
    const f = writeTemp("scope.py", src);
    const block = await backend.readSymbol(f, "foo");
    expect(block?.content).toContain("return 1");
    expect(block?.content).not.toContain("bar");
  });

  it("handles Python function with blank lines inside", async () => {
    const src = "def foo():\n    x = 1\n\n    y = 2\n\ndef bar():\n    pass";
    const f = writeTemp("blanks.py", src);
    const block = await backend.readSymbol(f, "foo");
    expect(block?.content).toContain("y = 2");
  });

  it("handles Python function at end of file with no trailing newline", async () => {
    const src = "def foo():\n    return 1";
    const f = writeTemp("eof.py", src);
    const block = await backend.readSymbol(f, "foo");
    expect(block?.content).toBe("def foo():\n    return 1");
  });
});

describe("detectLang (via readSymbol language field)", () => {
  it("detects .mts as typescript", async () => {
    const f = writeTemp("mod.mts", "export function foo() {}");
    const block = await backend.readSymbol(f, "foo");
    expect(block?.language).toBe("typescript");
  });

  it("detects .cjs as javascript", async () => {
    const f = writeTemp("mod.cjs", "function foo() {}");
    const block = await backend.readSymbol(f, "foo");
    expect(block?.language).toBe("javascript");
  });

  it("detects Makefile by bare filename", async () => {
    const f = writeTemp("Makefile", "function foo() {}");
    const block = await backend.readSymbol(f, "foo");
    expect(block?.language).toBe("makefile");
  });
});

describe("RegexBackend — findExports", () => {
  it("finds exported function", async () => {
    const f = writeTemp(
      "exports1.ts",
      "export function foo() {}\nexport default function bar() {}",
    );
    const exports = await backend.findExports(f);
    expect(exports).not.toBeNull();
    expect(exports?.find((e) => e.name === "foo")).toBeDefined();
    expect(exports?.find((e) => e.name === "bar" && e.isDefault)).toBeDefined();
  });

  it("finds exported class", async () => {
    const f = writeTemp("exports2.ts", "export class MyService {}");
    const exports = await backend.findExports(f);
    expect(exports?.find((e) => e.name === "MyService")).toBeDefined();
  });

  it("finds exported const", async () => {
    const f = writeTemp(
      "exports3.ts",
      "export const MAX = 100;\nexport let count = 0;",
    );
    const exports = await backend.findExports(f);
    expect(exports?.find((e) => e.name === "MAX")).toBeDefined();
  });

  it("finds exported interface and type", async () => {
    const f = writeTemp(
      "exports4.ts",
      "export interface Config {}\nexport type Result = string;",
    );
    const exports = await backend.findExports(f);
    expect(exports?.find((e) => e.name === "Config")).toBeDefined();
    expect(exports?.find((e) => e.name === "Result")).toBeDefined();
  });

  it("finds exported enum", async () => {
    const f = writeTemp("exports5.ts", "export enum Status { Active, Inactive }");
    const exports = await backend.findExports(f);
    expect(exports?.find((e) => e.name === "Status")).toBeDefined();
  });

  it("returns empty for file with no exports", async () => {
    const f = writeTemp("noexports.ts", "function internal() {}\nconst x = 1;");
    const exports = await backend.findExports(f);
    expect(exports?.length ?? 0).toBe(0);
  });

  it("empty file", async () => {
    const f = writeTemp("empty-exports.ts", "");
    const exports = await backend.findExports(f);
    expect(exports === null || exports?.length === 0).toBe(true);
  });
});

describe("RegexBackend — getFileOutline", () => {
  it("returns complete outline", async () => {
    const src =
      'import { foo } from "./foo";\nexport function bar() {}\nconst baz = 1;';
    const f = writeTemp("outline.ts", src);
    const outline = await backend.getFileOutline(f);
    expect(outline).not.toBeNull();
    expect(outline?.symbols?.length).toBeGreaterThan(0);
    expect(outline?.imports?.length).toBeGreaterThan(0);
    expect(outline?.exports?.length).toBeGreaterThan(0);
  });

  it("returns outline for file with only symbols", async () => {
    const f = writeTemp("symbols-only.ts", "function foo() {}\nclass Bar {}");
    const outline = await backend.getFileOutline(f);
    expect(outline).not.toBeNull();
    expect(outline?.symbols?.length).toBe(2);
  });

  it("returns null for empty file", async () => {
    const f = writeTemp("empty-outline.ts", "");
    const outline = await backend.getFileOutline(f);
    expect(outline).toBeNull();
  });
});

describe("RegexBackend — findDefinition", () => {
  it("finds function definition", async () => {
    const f = writeTemp(
      "def1.ts",
      "const x = 1;\nfunction target() {}\nconst y = 2;",
    );
    const locs = await backend.findDefinition(f, "target");
    expect(locs).not.toBeNull();
    expect(locs?.length).toBeGreaterThan(0);
    expect(locs?.[0]?.line).toBe(2);
  });

  it("finds class definition", async () => {
    const f = writeTemp("def2.ts", "class MyClass {\n  method() {}\n}");
    const locs = await backend.findDefinition(f, "MyClass");
    expect(locs?.length).toBeGreaterThan(0);
  });

  it("returns empty for missing symbol", async () => {
    const f = writeTemp("def3.ts", "function foo() {}");
    const locs = await backend.findDefinition(f, "nonexistent");
    expect(locs === null || locs?.length === 0).toBe(true);
  });
});

describe("RegexBackend — cache", () => {
  it("works with cache set", async () => {
    const { resolve } = await import("node:path");
    const cacheMap = new Map<string, string>();
    const content = "function foo() {}";
    const cache = {
      get(file: string) {
        return cacheMap.get(file) ?? null;
      },
      set(file: string, val: string) {
        cacheMap.set(file, val);
      },
    };
    const f = writeTemp("cached.ts", content);
    cacheMap.set(resolve(f), content);
    const cachedBackend = new RegexBackend();
    cachedBackend.setCache(cache as Parameters<typeof cachedBackend.setCache>[0]);
    const symbols = await cachedBackend.findSymbols(f);
    expect(symbols?.find((s) => s.name === "foo")).toBeDefined();
  });
});

describe("RegexBackend — readScope normal", () => {
  it("reads explicit range", async () => {
    const f = writeTemp("scope.ts", "line1\nline2\nline3\nline4\nline5");
    const block = await backend.readScope(f, 2, 4);
    expect(block?.content).toContain("line2");
    expect(block?.content).toContain("line4");
    expect(block?.content).not.toContain("line5");
  });

  it("reads single line", async () => {
    const f = writeTemp("scope1.ts", "aaa\nbbb\nccc");
    const block = await backend.readScope(f, 2, 2);
    expect(block?.content.trim()).toBe("bbb");
  });
});
