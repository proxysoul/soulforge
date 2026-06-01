import { relative, resolve } from "node:path";
import type { ToolResult } from "../../types";
import { getCwd } from "../cwd.js";
import { isForbidden } from "../security/forbidden.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";
import { readFileTool } from "./read-file.js";

/**
 * soul_query — composable code-exploration pipeline in ONE round-trip.
 *
 * Replaces the most common multi-step loop (grep → filter → deps → outline →
 * read) with a single tool call. Each stage operates on a working set of
 * repo-relative file paths and passes the (possibly narrowed) set to the next.
 *
 * All stages route through the Soul Map (trigram index, dep graph, symbol
 * ranges) — zero file I/O until an explicit `read` stage. Pure pipeline; no
 * subagents, no model calls. Designed so a weak model that won't author
 * parallel tool calls still gets the benefit of composed exploration.
 */

export type QueryOp =
  | { op: "search"; pattern: string }
  | { op: "find"; query: string }
  | { op: "filter"; ext?: string; pathContains?: string }
  | { op: "deps"; direction?: "imports" | "imported_by" }
  | { op: "outline" }
  | { op: "read"; ranges?: { start: number; end: number } }
  | { op: "limit"; n: number };

interface QueryArgs {
  pipeline: QueryOp[];
}

/** Working state threaded through stages. */
interface PipeState {
  /** Current working set of repo-relative paths (POSIX). */
  files: string[];
  /** Accumulated human-readable output blocks from terminal stages. */
  blocks: string[];
}

const MAX_FILES = 200;
const MAX_PIPELINE_OPS = 12;

function toRel(cwd: string, p: string): string {
  const abs = p.startsWith("/") ? p : resolve(cwd, p);
  return relative(cwd, abs).replace(/\\/g, "/");
}

export const soulQueryTool = {
  name: "soul_query",
  description:
    "[TIER-1] Composable code-exploration pipeline — one call replaces the grep→filter→deps→outline→read loop. " +
    "Each stage narrows a working set of files and feeds the next. Routes through the Soul Map (trigram index, " +
    "dep graph, symbol ranges) — zero file I/O until a `read` stage. " +
    "Ops: " +
    "{op:'search', pattern} literal substring → candidate files; " +
    "{op:'find', query} fuzzy symbol/file search; " +
    "{op:'filter', ext?, pathContains?} keep files by extension or path substring; " +
    "{op:'deps', direction:'imports'|'imported_by'} expand to dependencies/dependents; " +
    "{op:'outline'} symbol outline per file (terminal); " +
    "{op:'read', ranges?} read file contents (terminal); " +
    "{op:'limit', n} cap the working set. " +
    "Example: pipeline:[{op:'search',pattern:'useChat'},{op:'filter',ext:'.ts'},{op:'deps',direction:'imported_by'},{op:'outline'},{op:'limit',n:10}].",

  createExecute: (repoMap?: IntelligenceClient) => {
    return async (args: QueryArgs): Promise<ToolResult> => {
      const cwd = getCwd();
      const pipeline = args.pipeline ?? [];
      if (pipeline.length === 0) {
        return {
          success: false,
          output: "Empty pipeline. Provide pipeline:[{op:...}].",
          error: "empty",
        };
      }
      if (pipeline.length > MAX_PIPELINE_OPS) {
        return {
          success: false,
          output: `Pipeline too long (${String(pipeline.length)} ops, max ${String(MAX_PIPELINE_OPS)}).`,
          error: "too_long",
        };
      }
      if (!repoMap?.isReady) {
        return {
          success: true,
          output:
            "Soul map not indexed — soul_query needs the repo index. Run /repo-map, or use soul_grep/read directly.",
        };
      }

      const state: PipeState = { files: [], blocks: [] };
      const trace: string[] = [];

      for (let i = 0; i < pipeline.length; i++) {
        const stage = pipeline[i];
        if (!stage) continue;
        try {
          await runStage(stage, state, repoMap, cwd);
          trace.push(
            `${String(i + 1)}. ${describeStage(stage)} → ${String(state.files.length)} files`,
          );
        } catch (err) {
          return {
            success: false,
            output: `Stage ${String(i + 1)} (${stage.op}) failed: ${err instanceof Error ? err.message : String(err)}`,
            error: "stage_failed",
          };
        }
      }

      const parts: string[] = [
        `Pipeline (${pipeline.length} stages):`,
        ...trace.map((t) => `  ${t}`),
      ];
      if (state.blocks.length > 0) {
        parts.push("", ...state.blocks);
      } else if (state.files.length > 0) {
        parts.push("", "Files:", ...state.files.slice(0, MAX_FILES).map((f) => `  ${f}`));
      } else {
        parts.push("", "(no files matched)");
      }
      return { success: true, output: parts.join("\n") };
    };
  },
};

function describeStage(stage: QueryOp): string {
  switch (stage.op) {
    case "search":
      return `search "${stage.pattern}"`;
    case "find":
      return `find "${stage.query}"`;
    case "filter":
      return `filter ${stage.ext ?? ""}${stage.pathContains ? ` ~${stage.pathContains}` : ""}`.trim();
    case "deps":
      return `deps ${stage.direction ?? "imports"}`;
    case "outline":
      return "outline";
    case "read":
      return "read";
    case "limit":
      return `limit ${String(stage.n)}`;
  }
}

async function runStage(
  stage: QueryOp,
  state: PipeState,
  repoMap: IntelligenceClient,
  cwd: string,
): Promise<void> {
  switch (stage.op) {
    case "search": {
      const candidates = await safe(
        repoMap.searchTrigramCandidates(stage.pattern, MAX_FILES),
        null,
      );
      state.files = dedupeAllowed(candidates ?? [], cwd);
      return;
    }
    case "find": {
      const matches = await safe(repoMap.findSymbols(stage.query), [] as Array<{ path: string }>);
      state.files = dedupeAllowed(
        matches.map((m) => toRel(cwd, m.path)),
        cwd,
      );
      return;
    }
    case "filter": {
      state.files = state.files.filter((f) => {
        if (stage.ext && !f.endsWith(stage.ext)) return false;
        if (stage.pathContains && !f.includes(stage.pathContains)) return false;
        return true;
      });
      return;
    }
    case "deps": {
      const next = new Set<string>();
      const dir = stage.direction ?? "imports";
      for (const f of state.files.slice(0, MAX_FILES)) {
        const rows = await safe(
          dir === "imported_by" ? repoMap.getFileDependents(f) : repoMap.getFileDependencies(f),
          [] as Array<{ path: string; weight: number }>,
        );
        for (const r of rows) next.add(toRel(cwd, r.path));
      }
      state.files = dedupeAllowed([...next], cwd);
      return;
    }
    case "outline": {
      for (const f of state.files.slice(0, 40)) {
        const ranges = await safe(
          repoMap.getEnclosingSymbols(f),
          [] as Array<{ name: string; kind: string; line: number; endLine: number }>,
        );
        if (ranges.length === 0) continue;
        const lines = ranges
          .slice(0, 60)
          .map((s) => `  ${String(s.line)}-${String(s.endLine)} ${s.kind} ${s.name}`);
        state.blocks.push(`${f}:\n${lines.join("\n")}`);
      }
      return;
    }
    case "read": {
      for (const f of state.files.slice(0, 10)) {
        const res = await readFileTool.execute({
          path: resolve(cwd, f),
          ...(stage.ranges ? { startLine: stage.ranges.start, endLine: stage.ranges.end } : {}),
        });
        state.blocks.push(`── ${f} ──\n${res.output}`);
      }
      return;
    }
    case "limit": {
      state.files = state.files.slice(0, Math.max(0, stage.n));
      return;
    }
  }
}

/** Dedupe + drop forbidden paths, preserving order. */
function dedupeAllowed(paths: string[], cwd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const rel = toRel(cwd, p);
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (isForbidden(resolve(cwd, rel)) !== null) continue;
    out.push(rel);
  }
  return out.slice(0, MAX_FILES);
}
/**
 * Normalize a repoMap method result that may be sync (RepoMap instance) or a
 * Promise (IntelligenceClient worker proxy), swallowing errors to a fallback.
 */
async function safe<T>(value: T | Promise<T>, fallback: T): Promise<T> {
  try {
    return await value;
  } catch {
    return fallback;
  }
}
