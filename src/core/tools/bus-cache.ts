import { readFile as readFileAsync } from "node:fs/promises";
import { resolve } from "node:path";
import { type AgentBus, normalizePath } from "../agents/agent-bus.js";
import { deriveTool } from "./tool-utils.js";

interface WrappableTool {
  description?: string;
  inputSchema?: unknown;
  execute?: (args: never, opts: never) => unknown;
}

export function wrapWithBusCache(
  tools: Record<string, WrappableTool>,
  bus: AgentBus,
  agentId: string,
): Record<string, WrappableTool> {
  const wrapped = { ...tools };

  function makeCachedExecute(
    origExecute: (args: Record<string, unknown>, opts?: unknown) => Promise<unknown>,
    keyFn: (args: Record<string, unknown>) => string | null,
  ): WrappableTool["execute"] {
    return (async (args: Record<string, unknown>, opts: unknown) => {
      const key = keyFn(args);
      if (key) {
        const acquired = bus.acquireToolResult(agentId, key);
        if (acquired.hit === true) return acquired.result;
        if (acquired.hit === "waiting") {
          const waited = await acquired.result;
          if (waited != null) return waited;
        }
      }
      const result = await origExecute(args, opts);
      if (key) {
        const content =
          typeof result === "string"
            ? result
            : typeof (result as Record<string, unknown>)?.output === "string"
              ? String((result as Record<string, unknown>).output)
              : JSON.stringify(result);
        bus.cacheToolResult(agentId, key, content);
      }
      return result;
    }) as WrappableTool["execute"];
  }

  const readFile = tools.read;
  if (readFile?.execute) {
    type ReadFileSpec = {
      path: string;
      ranges?: Array<{ start: number; end: number }>;
      target?: string;
      name?: string;
    };
    type LegacyArgs = { path?: string; startLine?: number; endLine?: number };
    type BatchArgs = { files?: ReadFileSpec[] | ReadFileSpec; fresh?: boolean };

    const origExecute = readFile.execute as (args: unknown, opts?: unknown) => Promise<unknown>;

    const collectPaths = (args: BatchArgs & LegacyArgs): ReadFileSpec[] => {
      // Forge batched read: { files: [{path, ranges?}] }
      if (Array.isArray(args.files)) return args.files;
      if (args.files && typeof args.files === "object") return [args.files as ReadFileSpec];
      // Legacy per-call: { path, startLine?, endLine? }
      if (typeof args.path === "string") {
        return [
          {
            path: args.path,
            ...(args.startLine != null || args.endLine != null
              ? { ranges: [{ start: args.startLine ?? 1, end: args.endLine ?? 0 }] }
              : {}),
          },
        ];
      }
      return [];
    };

    wrapped.read = deriveTool(readFile, {
      execute: (async (args: BatchArgs & LegacyArgs, opts: unknown) => {
        const result = await origExecute(args, opts);
        // Record every path the read tool touched, regardless of input shape.
        for (const spec of collectPaths(args)) {
          if (!spec?.path) continue;
          const normalized = normalizePath(spec.path);
          if (!normalized) continue;
          if (spec.ranges && spec.ranges.length > 0) {
            for (const r of spec.ranges) {
              bus.recordFileRead(agentId, normalized, {
                tool: "read",
                startLine: r.start,
                endLine: r.end,
                cached: false,
              });
            }
          } else {
            bus.recordFileRead(agentId, normalized, {
              tool: "read",
              ...(spec.target ? { target: spec.target, name: spec.name } : {}),
              cached: false,
            });
          }
        }
        return result;
      }) as WrappableTool["execute"],
    });
  }

  const editFile = tools.edit_file;
  if (editFile?.execute) {
    const origEdit = editFile.execute as (
      args: { path: string; oldString: string; newString: string },
      opts?: unknown,
    ) => Promise<unknown>;

    wrapped.edit_file = deriveTool(editFile, {
      execute: (async (
        args: { path: string; oldString: string; newString: string },
        opts: unknown,
      ) => {
        const normalized = normalizePath(args.path);
        const { release, owner } = await bus.acquireEditLock(agentId, normalized);
        try {
          const result = await origEdit(args, opts);
          const isOk =
            result &&
            typeof result === "object" &&
            (result as Record<string, unknown>).success === true;
          if (isOk) {
            readFileAsync(resolve(normalized), "utf-8").then(
              (fresh) => bus.updateFile(normalized, fresh, agentId),
              () => bus.invalidateFile(normalized),
            );
          } else {
            bus.invalidateFile(normalized);
          }
          bus.recordFileEdit(agentId, normalized);

          if (owner && owner !== agentId && isOk) {
            const text = typeof result === "string" ? result : JSON.stringify(result);
            return `⚠ Note: ${owner} also edited ${normalized}. Your edit succeeded (different region). Verify with read if needed.\n\n${text}`;
          }
          if (owner && owner !== agentId && !isOk) {
            const text = typeof result === "string" ? result : JSON.stringify(result);
            return `⚠ Edit failed — ${owner} modified ${normalized} before you. Re-read the file to see current content and adapt your edit.\n\n${text}`;
          }
          return result;
        } finally {
          release();
        }
      }) as WrappableTool["execute"],
    });
  }

  const multiEdit = tools.multi_edit;
  if (multiEdit?.execute) {
    const origMultiEdit = multiEdit.execute as (
      args: {
        path: string;
        edits: Array<{ oldString: string; newString: string; lineStart?: number }>;
      },
      opts?: unknown,
    ) => Promise<unknown>;

    wrapped.multi_edit = deriveTool(multiEdit, {
      execute: (async (
        args: {
          path: string;
          edits: Array<{ oldString: string; newString: string; lineStart?: number }>;
        },
        opts: unknown,
      ) => {
        const normalized = normalizePath(args.path);
        const { release, owner } = await bus.acquireEditLock(agentId, normalized);
        try {
          const result = await origMultiEdit(args, opts);
          const isOk =
            result &&
            typeof result === "object" &&
            (result as Record<string, unknown>).success === true;
          if (isOk) {
            readFileAsync(resolve(normalized), "utf-8").then(
              (fresh) => bus.updateFile(normalized, fresh, agentId),
              () => bus.invalidateFile(normalized),
            );
          } else {
            bus.invalidateFile(normalized);
          }
          bus.recordFileEdit(agentId, normalized);

          if (owner && owner !== agentId && isOk) {
            const text = typeof result === "string" ? result : JSON.stringify(result);
            return `⚠ Note: ${owner} also edited ${normalized}. Your multi_edit succeeded (different region). Verify with read if needed.\n\n${text}`;
          }
          if (owner && owner !== agentId && !isOk) {
            const text = typeof result === "string" ? result : JSON.stringify(result);
            return `⚠ Multi-edit failed — ${owner} modified ${normalized} before you. Re-read the file to see current content and adapt your edits.\n\n${text}`;
          }
          return result;
        } finally {
          release();
        }
      }) as WrappableTool["execute"],
    });
  }

  const NAVIGATE_CACHEABLE = new Set([
    "definition",
    "references",
    "symbols",
    "imports",
    "exports",
    "workspace_symbols",
    "call_hierarchy",
    "implementation",
    "type_hierarchy",
    "search_symbols",
  ]);
  const ANALYZE_CACHEABLE = new Set(["diagnostics", "outline", "type_info"]);

  const cacheSpecs: Array<{
    name: string;
    keyFn: (args: Record<string, unknown>) => string | null;
  }> = [
    {
      name: "grep",
      keyFn: (a) =>
        JSON.stringify([
          "grep",
          String(a.pattern ?? ""),
          normalizePath(String(a.path ?? ".")),
          String(a.glob ?? ""),
        ]),
    },
    {
      name: "glob",
      keyFn: (a) =>
        JSON.stringify(["glob", String(a.pattern ?? ""), normalizePath(String(a.path ?? "."))]),
    },
    {
      name: "navigate",
      keyFn: (a) => {
        if (!NAVIGATE_CACHEABLE.has(String(a.action ?? ""))) return null;
        return JSON.stringify([
          "navigate",
          String(a.action),
          normalizePath(String(a.file ?? "")),
          String(a.symbol ?? ""),
        ]);
      },
    },
    {
      name: "analyze",
      keyFn: (a) => {
        const action = String(a.action ?? "");
        if (!ANALYZE_CACHEABLE.has(action) || !a.file) return null;
        return JSON.stringify(["analyze", action, normalizePath(String(a.file))]);
      },
    },
    {
      name: "web_search",
      keyFn: (a) => JSON.stringify(["web_search", String(a.query ?? "")]),
    },
    {
      name: "list_dir",
      keyFn: (a) => JSON.stringify(["list_dir", normalizePath(String(a.path ?? "."))]),
    },
    {
      name: "soul_grep",
      keyFn: (a) =>
        JSON.stringify([
          "soul_grep",
          String(a.pattern ?? ""),
          String(a.path ?? "."),
          String(a.count ?? ""),
          String(a.wordBoundary ?? ""),
        ]),
    },
    {
      name: "soul_find",
      keyFn: (a) => JSON.stringify(["soul_find", String(a.query ?? ""), String(a.type ?? "")]),
    },
    {
      name: "soul_analyze",
      keyFn: (a) =>
        JSON.stringify([
          "soul_analyze",
          String(a.action ?? ""),
          normalizePath(String(a.file ?? "")),
        ]),
    },
    {
      name: "soul_impact",
      keyFn: (a) =>
        JSON.stringify([
          "soul_impact",
          String(a.action ?? ""),
          normalizePath(String(a.file ?? "")),
        ]),
    },
  ];

  for (const spec of cacheSpecs) {
    const t = tools[spec.name];
    if (t?.execute) {
      wrapped[spec.name] = deriveTool(t, {
        execute: makeCachedExecute(
          t.execute as (args: Record<string, unknown>, opts?: unknown) => Promise<unknown>,
          spec.keyFn,
        ),
      });
    }
  }

  return wrapped;
}
