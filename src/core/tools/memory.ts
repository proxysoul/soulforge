import { tool } from "ai";
import { z } from "zod";
import type { MemoryManager } from "../memory/manager.js";
import { MemoryRecall } from "../memory/recall.js";
import type { MemoryCategory, MemoryRecord, MemoryScope } from "../memory/types.js";
import { MEMORY_CATEGORIES } from "../memory/types.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";

const SUMMARY_MAX = 200;
const DETAILS_MAX = 2000;
const TOPICS_MAX = 8;
const TOPIC_LEN_MAX = 32;
const FILE_REFS_MAX = 16;

const categorySchema = z
  .enum(MEMORY_CATEGORIES as [MemoryCategory, ...MemoryCategory[]])
  .describe("pref | decision | gotcha | context");

interface CreateMemoryToolDeps {
  manager: MemoryManager;
  intelligence?: IntelligenceClient | null;
}

export function createMemoryTool(deps: MemoryManager | CreateMemoryToolDeps) {
  const manager = "manager" in deps ? deps.manager : deps;
  const intelligence = "manager" in deps ? (deps.intelligence ?? null) : null;
  const recall = new MemoryRecall(
    {
      searchUnicode: (q, l) => manager.getDbForScope("project").searchUnicode(q, l),
      searchTrigram: (q, l) => manager.getDbForScope("project").searchTrigram(q, l),
      searchTrigramWithBigram: (q, l) =>
        manager.getDbForScope("project").searchTrigramWithBigram(q, l),
      findByFileIds: (ids, l) => manager.getDbForScope("project").findByFileIds(ids, l),
      findByPaths: (paths, l) => manager.getDbForScope("project").findByPaths(paths, l),
      topByUsage: (l) => manager.getDbForScope("project").topByUsage(l),
      readMany: (ids) => manager.getDbForScope("project").readMany(ids),
    },
    intelligence,
  );

  return tool({
    description:
      "Persistent memory across sessions. Memory surfaces relevant entries automatically when you edit or mention related files — explicit search is only for targeted lookup. Write durable, non-code knowledge: user preferences, decisions with rationale, gotchas, project history. Don't store anything the codebase already shows (Soul Map covers that).",
    inputSchema: z.object({
      action: z.enum(["write", "get", "list", "search", "delete", "restore", "pin", "unpin"]),
      scope: z
        .enum(["global", "project", "both", "all"])
        .nullable()
        .optional()
        .describe("write/delete/pin: project|global. list/search: project|global|both|all"),
      summary: z
        .string()
        .nullable()
        .optional()
        .describe(`write: one-line headline (≤${String(SUMMARY_MAX)}ch)`),
      details: z
        .string()
        .nullable()
        .optional()
        .describe(`write: rationale / context (≤${String(DETAILS_MAX)}ch)`),
      category: categorySchema.nullable().optional().describe("write/list: category"),
      topics: z
        .array(z.string())
        .nullable()
        .optional()
        .describe(`write: free-form tags (≤${String(TOPICS_MAX)})`),
      file_paths: z
        .array(z.string())
        .nullable()
        .optional()
        .describe("write: relative paths this memory is about; resolved to Soul Map IDs"),
      query: z.string().nullable().optional().describe("search: query"),
      topic: z.string().nullable().optional().describe("list: filter by topic"),
      pinned: z.boolean().nullable().optional().describe("list: filter by pinned"),
      include_hidden: z
        .boolean()
        .nullable()
        .optional()
        .describe("list: include soft-deleted entries"),
      limit: z.number().nullable().optional().describe("search/list: max results"),
      id: z.string().nullable().optional().describe("get/delete/restore/pin/unpin: memory id"),
      merge_topics: z
        .boolean()
        .nullable()
        .optional()
        .describe("write: when dedup hits and topics differ, union new topics into the stored set"),
    }),
    execute: async (args) => {
      try {
        switch (args.action) {
          case "write":
            return await handleWrite();
          case "get":
            return handleGet();
          case "list":
            return handleList();
          case "search":
            return await handleSearch();
          case "delete":
            return handleDelete();
          case "restore":
            return handleRestore();
          case "pin":
            return handlePin(true);
          case "unpin":
            return handlePin(false);
          default:
            return {
              success: false,
              output: `Unknown action: ${String(args.action)}`,
              error: "bad_action",
            };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: msg, error: msg };
      }

      async function handleWrite() {
        const summary = (args.summary ?? "").trim();
        if (!summary) {
          return { success: false, output: "summary required for write", error: "missing_summary" };
        }
        const details = (args.details ?? "").trim();

        const scope = resolveWriteScope(args.scope);
        if (scope === "disabled") {
          return {
            success: false,
            output: "Memory writes are disabled (scope: none)",
            error: "disabled",
          };
        }
        if (scope === "invalid") {
          return {
            success: false,
            output: "scope must be 'project' or 'global' for write",
            error: "bad_scope",
          };
        }

        const cleanSummary =
          summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 3)}...` : summary;
        const cleanDetails =
          details.length > DETAILS_MAX ? `${details.slice(0, DETAILS_MAX - 3)}...` : details;
        const topics = normalizeTopics(args.topics ?? []);
        const filePaths = (args.file_paths ?? []).slice(0, FILE_REFS_MAX);

        const result = manager.write(scope, {
          summary: cleanSummary,
          details: cleanDetails,
          topics,
          source: "agent",
          category: (args.category as MemoryCategory | null | undefined) ?? null,
          mergeTopics: args.merge_topics ?? false,
          ...(args.id ? { id: args.id } : {}),
        });

        await attachFileRefs(scope, result.record.id, filePaths);

        let output: string;
        if (result.deduped) {
          const base = `Already remembered (use_count++): "${result.record.summary}" (${result.record.id.slice(0, 8)}, ${scope})`;
          if (result.topicDiff && !args.merge_topics) {
            output = `${base}\nNote: topics differ — pass merge_topics:true to merge them into the stored entry.`;
          } else if (result.topicDiff && args.merge_topics) {
            output = `${base} (topics merged)`;
          } else {
            output = base;
          }
        } else {
          output = `Saved: "${result.record.summary}" (${result.record.id.slice(0, 8)}, ${scope})`;
        }

        return {
          success: true,
          output,
          data: {
            id: result.record.id,
            deduped: result.deduped,
            topic_diff: result.topicDiff ?? false,
            scope,
            category: result.record.category,
          },
        };
      }

      function handleGet() {
        if (!args.id) {
          return { success: false, output: "id required for get", error: "missing_id" };
        }
        const readScope = resolveReadScope(args.scope);
        const found = manager.findById(readScope, args.id);
        if (!found) {
          return { success: false, output: `Memory not found: ${args.id}`, error: "not_found" };
        }
        return { success: true, output: formatRecordFull(found) };
      }

      function handleList() {
        const readScope = resolveReadScope(args.scope);
        const results = manager.list(readScope, {
          category: (args.category as MemoryCategory | undefined) ?? undefined,
          topic: args.topic ?? undefined,
          pinned: args.pinned ?? undefined,
          includeHidden: args.include_hidden ?? false,
        });
        if (results.length === 0) return { success: true, output: "No memories found." };
        const limit = args.limit ?? results.length;
        return {
          success: true,
          output: results.slice(0, limit).map(formatRecordLine).join("\n"),
        };
      }

      async function handleSearch() {
        if (!args.query) {
          return { success: false, output: "query required for search", error: "missing_query" };
        }
        const hits = await recall.recall({
          query: args.query,
          limit: args.limit ?? 10,
        });
        if (hits.length === 0) return { success: true, output: "No matching memories found." };
        return {
          success: true,
          output: hits
            .map(
              ({ record, normalized_score }) =>
                `${formatRecordLine({ ...record, scope: "project" })}  score=${normalized_score.toFixed(2)}`,
            )
            .join("\n"),
        };
      }

      function handleDelete() {
        if (!args.id) {
          return { success: false, output: "id required for delete", error: "missing_id" };
        }
        const scope = resolveWriteScope(args.scope);
        if (scope === "disabled" || scope === "invalid") {
          return {
            success: false,
            output: "scope must be 'project' or 'global' for delete",
            error: "bad_scope",
          };
        }
        const ok = manager.softDelete(scope, args.id);
        if (!ok) return { success: false, output: `Not found: ${args.id}`, error: "not_found" };
        return { success: true, output: `Soft-deleted ${args.id.slice(0, 8)} (restorable)` };
      }

      function handleRestore() {
        if (!args.id) {
          return { success: false, output: "id required for restore", error: "missing_id" };
        }
        const scope = resolveWriteScope(args.scope);
        if (scope === "disabled" || scope === "invalid") {
          return {
            success: false,
            output: "scope must be 'project' or 'global' for restore",
            error: "bad_scope",
          };
        }
        const ok = manager.restore(scope, args.id);
        if (!ok) return { success: false, output: `Not found: ${args.id}`, error: "not_found" };
        return { success: true, output: `Restored ${args.id.slice(0, 8)}` };
      }

      function handlePin(pin: boolean) {
        if (!args.id) {
          return { success: false, output: "id required", error: "missing_id" };
        }
        const scope = resolveWriteScope(args.scope);
        if (scope === "disabled" || scope === "invalid") {
          return {
            success: false,
            output: "scope must be 'project' or 'global'",
            error: "bad_scope",
          };
        }
        const ok = pin ? manager.pin(scope, args.id) : manager.unpin(scope, args.id);
        if (!ok) return { success: false, output: `Not found: ${args.id}`, error: "not_found" };
        return { success: true, output: `${pin ? "Pinned" : "Unpinned"} ${args.id.slice(0, 8)}` };
      }
    },
  });

  function resolveWriteScope(
    requested: string | null | undefined,
  ): MemoryScope | "disabled" | "invalid" {
    const raw = requested ?? manager.scopeConfig.writeScope;
    if (raw === "none") return "disabled";
    if (raw !== "project" && raw !== "global") return "invalid";
    return raw;
  }

  function resolveReadScope(requested: string | null | undefined): MemoryScope | "both" | "all" {
    const raw = requested ?? manager.scopeConfig.readScope;
    if (raw === "none") return "all"; // tool callers expect a non-empty result set
    if (raw === "both" || raw === "all") return raw;
    if (raw === "project" || raw === "global") return raw;
    return "all";
  }

  async function attachFileRefs(
    scope: MemoryScope,
    memoryId: string,
    paths: string[],
  ): Promise<void> {
    if (paths.length === 0) return;
    if (intelligence) {
      const lookups = paths.map((p) =>
        intelligence
          .getFileIdByPath(p)
          .catch(() => null)
          .then((id) => ({ path: p, id })),
      );
      const resolved = await Promise.all(lookups);
      for (const { path, id } of resolved) {
        manager.addFileRef(scope, memoryId, path, id);
      }
    } else {
      for (const path of paths) manager.addFileRef(scope, memoryId, path, null);
    }
  }
}

function normalizeTopics(topics: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of topics) {
    const trimmed = t.trim().slice(0, TOPIC_LEN_MAX);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= TOPICS_MAX) break;
  }
  return out;
}

function formatRecordLine(m: MemoryRecord & { scope: MemoryScope }): string {
  const cat = m.category ?? "—";
  const pin = m.pinned ? "★ " : "";
  const used = m.use_count > 0 ? ` (×${String(m.use_count)})` : "";
  return `[${m.scope}] ${m.id.slice(0, 8)} | ${cat} | ${pin}${m.summary}${used}`;
}

function formatRecordFull(m: MemoryRecord & { scope: MemoryScope }): string {
  const lines = [
    `id: ${m.id}`,
    `scope: ${m.scope}`,
    `category: ${m.category ?? "—"}`,
    `summary: ${m.summary}`,
  ];
  if (m.details) lines.push(`details: ${m.details}`);
  if (m.topics.length > 0) lines.push(`topics: ${m.topics.join(", ")}`);
  lines.push(`source: ${m.source}`);
  lines.push(`created: ${m.created_at}`);
  lines.push(`last_used: ${m.last_used_at} (×${String(m.use_count)})`);
  if (m.pinned) lines.push("pinned: true");
  if (m.hidden) lines.push("hidden: true");
  if (m.superseded_by) lines.push(`superseded_by: ${m.superseded_by}`);
  return lines.join("\n");
}
