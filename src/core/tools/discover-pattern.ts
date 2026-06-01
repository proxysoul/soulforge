import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getCwd } from "../cwd.js";
import { getIntelligenceClient, getIntelligenceRouter } from "../intelligence/index.js";
import { isForbidden } from "../security/forbidden.js";

async function lineCount(file: string): Promise<number | null> {
  try {
    return (await readFile(resolve(file), "utf-8")).split("\n").length;
  } catch {
    return null;
  }
}

interface DiscoverPatternArgs {
  query: string;
  file?: string;
}

export const discoverPatternTool = {
  name: "discover_pattern",
  description: "Find implementation patterns for a concept in the codebase.",
  execute: async (args: DiscoverPatternArgs): Promise<ToolResult> => {
    try {
      const client = getIntelligenceClient();
      const router = getIntelligenceRouter(getCwd());
      const file = args.file ? resolve(args.file) : undefined;
      const language = router.detectLanguage(file);

      let symbols: import("../intelligence/types.js").SymbolInfo[] | null;
      if (client) {
        const tracked = await client.routerFindWorkspaceSymbols(args.query);
        symbols = tracked?.value ?? null;
      } else {
        symbols = await router.executeWithFallback(language, "findWorkspaceSymbols", (b) =>
          b.findWorkspaceSymbols ? b.findWorkspaceSymbols(args.query) : Promise.resolve(null),
        );
      }

      if (!symbols || symbols.length === 0) {
        return {
          success: false,
          output: `No symbols found matching '${args.query}'`,
          error: "not found",
        };
      }

      const safeSymbols = symbols.filter((s) => isForbidden(s.location.file) === null);
      const interfaces = safeSymbols.filter((s) => s.kind === "interface" || s.kind === "type");
      const classes = safeSymbols.filter((s) => s.kind === "class");
      const functions = safeSymbols.filter((s) => s.kind === "function");
      const others = safeSymbols.filter(
        (s) => !["interface", "type", "class", "function"].includes(s.kind),
      );

      const parts: string[] = [
        `Pattern discovery for "${args.query}" — ${String(symbols.length)} symbols found`,
      ];

      if (interfaces.length > 0) {
        parts.push(`\n## Interfaces & Types (${String(interfaces.length)})`);
        const blocks = await Promise.all(
          interfaces.slice(0, 3).map(async (iface) => {
            // No routerReadSymbol on client — use router directly
            const block = await router.executeWithFallback(language, "readSymbol", (b) =>
              b.readSymbol
                ? b.readSymbol(iface.location.file, iface.name, iface.kind)
                : Promise.resolve(null),
            );
            return { iface, block };
          }),
        );
        for (const { iface, block } of blocks) {
          if (block) {
            parts.push(
              `\n### ${iface.kind} ${iface.name} — ${iface.location.file}:${String(iface.location.line)}`,
            );
            parts.push(`\`\`\`\n${block.content}\n\`\`\``);
          } else {
            parts.push(
              `  ${iface.kind} ${iface.name} — ${iface.location.file}:${String(iface.location.line)}`,
            );
          }
        }
        if (interfaces.length > 3) {
          parts.push(`  ... and ${String(interfaces.length - 3)} more`);
        }
      }

      if (classes.length > 0) {
        parts.push(`\n## Classes (${String(classes.length)})`);
        for (const cls of classes.slice(0, 5)) {
          parts.push(`  class ${cls.name} — ${cls.location.file}:${String(cls.location.line)}`);
        }
        if (classes.length > 5) {
          parts.push(`  ... and ${String(classes.length - 5)} more`);
        }
      }

      if (functions.length > 0) {
        parts.push(`\n## Functions (${String(functions.length)})`);
        for (const fn of functions.slice(0, 5)) {
          parts.push(`  function ${fn.name} — ${fn.location.file}:${String(fn.location.line)}`);
        }
        if (functions.length > 5) {
          parts.push(`  ... and ${String(functions.length - 5)} more`);
        }
      }

      if (others.length > 0) {
        parts.push(`\n## Other (${String(others.length)})`);
        for (const o of others.slice(0, 5)) {
          parts.push(`  ${o.kind} ${o.name} — ${o.location.file}:${String(o.location.line)}`);
        }
      }

      const uniqueFiles = [...new Set(safeSymbols.map((s) => s.location.file))].slice(0, 5);
      parts.push(`\n## Related files (${String(uniqueFiles.length)})`);
      const fileExports = await Promise.all(
        uniqueFiles.map(async (f) => {
          let exports: import("../intelligence/types.js").ExportInfo[] | null;
          if (client) {
            const tracked = await client.routerFindExports(f);
            exports = tracked?.value ?? null;
          } else {
            exports = await router.executeWithFallback(language, "findExports", (b) =>
              b.findExports ? b.findExports(f) : Promise.resolve(null),
            );
          }
          const lines = await lineCount(f);
          return { file: f, exports, lines };
        }),
      );
      for (const { file: f, exports, lines } of fileExports) {
        const sizeHint = lines
          ? ` (${String(lines)} lines${lines > 100 ? " — use read with target + name for specific symbols" : ""})`
          : "";
        if (exports && exports.length > 0) {
          parts.push(`  ${f}${sizeHint}:`);
          for (const exp of exports.slice(0, 8)) {
            parts.push(`    ${exp.kind} ${exp.name}`);
          }
        } else {
          parts.push(`  ${f}${sizeHint}`);
        }
      }

      return { success: true, output: parts.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};
