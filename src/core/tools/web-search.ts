import type { LanguageModel } from "ai";
import { tool } from "ai";
import LinkifyIt from "linkify-it";
import { z } from "zod";
import { recordModelCall, useModelEventsStore } from "../../stores/model-events.js";
import { emitSubagentStep } from "../agents/subagent-events.js";
import { createWebSearchAgent } from "../agents/web-search.js";
import { getShortModelLabel } from "../llm/models.js";
import { webSearchScraper } from "./web-search-scraper.js";

export { webSearchScraper as webSearchTool };

const agentSearchCache = new Map<string, { output: string; ts: number }>();
const AGENT_CACHE_TTL = 5 * 60_000;

const linkify = new LinkifyIt();

function extractUrlHint(query: string): string | null {
  const matches = linkify.match(query);
  if (!matches || matches.length === 0) return null;
  return matches[0]?.url ?? null;
}

function normalizeQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, " ");
}

function formatSearchArgs(tc: { toolName: string; input?: unknown }): string {
  const a = (tc.input ?? {}) as Record<string, unknown>;
  if (tc.toolName === "web_search" && a.query) {
    const q = String(a.query);
    return q.length > 50 ? `${q.slice(0, 47)}...` : q;
  }
  if (tc.toolName === "fetch_page" && a.url) {
    const u = String(a.url);
    return u.length > 50 ? `${u.slice(0, 47)}...` : u;
  }
  return "";
}

/**
 * Build a web_search AI SDK tool.
 * When `webSearchModel` is provided, the tool spawns a dedicated search agent
 * that can run multiple queries and follow links. Otherwise falls back to direct scraping.
 */
export function buildWebSearchTool(opts?: {
  webSearchModel?: LanguageModel;
  onApprove?: (query: string) => Promise<boolean>;
  onApproveFetchPage?: (url: string) => Promise<boolean>;
}) {
  const { webSearchModel, onApprove } = opts ?? {};

  return tool({
    description: webSearchModel
      ? "Search the web when codebase and user-provided docs lack the answer. Before searching: check conversation for previous results, check codebase for existing patterns, fetch_page any URLs the user shared. Only search for specific gaps."
      : webSearchScraper.description,
    inputSchema: z.object({
      query: z.string().describe("Search query or research question"),
      count: z
        .number()
        .nullable()
        .optional()
        .describe("Number of results (default 5, ignored when agent is used)"),
    }),
    execute: async (args, { toolCallId, abortSignal }) => {
      if (!onApprove) {
        return {
          success: false,
          output: "Web search is disabled. Enable it in settings to use this tool.",
          error: "Web search disabled.",
        };
      }
      let approved: boolean;
      try {
        approved = await onApprove(args.query);
      } catch (err) {
        // Approval races an abort (Ctrl+X, unmount, stall). Surface a clean
        // denied-shape result instead of propagating AbortError — the tool
        // loop has no handling for it and would surface as "Request interrupted".
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: `Web search approval cancelled: ${msg}`,
          error: "Approval cancelled.",
        };
      }
      if (!approved) {
        return {
          success: false,
          output: "Web search was denied by the user.",
          error: "Web search denied.",
        };
      }

      if (webSearchModel) {
        const cacheKey = normalizeQuery(args.query);
        const cached = agentSearchCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < AGENT_CACHE_TTL) {
          return {
            success: true,
            output: `This query was already searched — the result is in your conversation above. Use that instead of re-searching.`,
            backend: "dedup",
          };
        }

        const runningSteps = new Set<string>();
        const mid = typeof webSearchModel === "string" ? webSearchModel : webSearchModel.modelId;
        const backendLabel = getShortModelLabel(mid);

        const markRunningStepsError = () => {
          for (const key of runningSteps) {
            const [name, ...rest] = key.split(":::");
            emitSubagentStep({
              parentToolCallId: toolCallId,
              toolName: name ?? "web_search",
              args: rest.join(":::"),
              state: "error",
            });
          }
          runningSteps.clear();
        };

        const webSearchStartedAt = Date.now();
        try {
          const agent = createWebSearchAgent(webSearchModel, {
            onApproveFetchPage: opts?.onApproveFetchPage,
          });
          const combinedSignal = abortSignal
            ? AbortSignal.any([abortSignal, AbortSignal.timeout(120_000)])
            : AbortSignal.timeout(120_000);
          // The agent's generate() forwards extra options to generateText() via
          // spread, but AgentCallParameters doesn't type the experimental callbacks.
          const result = await agent.generate({
            prompt: args.query,
            abortSignal: combinedSignal,
            experimental_onToolCallStart: (event: {
              toolCall?: { toolName: string; args: unknown };
            }) => {
              const tc = event.toolCall;
              if (!tc) return;
              const stepArgs = formatSearchArgs(tc);
              runningSteps.add(`${tc.toolName}:::${stepArgs}`);
              emitSubagentStep({
                parentToolCallId: toolCallId,
                toolName: tc.toolName,
                args: stepArgs,
                state: "running",
              });
            },
            experimental_onToolCallFinish: (event: {
              toolCall?: { toolName: string; args: unknown };
              success?: boolean;
              output?: unknown;
              result?: unknown;
            }) => {
              const tc = event.toolCall;
              if (!tc) return;
              const stepArgs = formatSearchArgs(tc);
              runningSteps.delete(`${tc.toolName}:::${stepArgs}`);
              const ev = event as Record<string, unknown>;
              const ok = ev.success !== false;
              const raw = ev.output ?? ev.result;
              const toolResult =
                raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
              const stepBackend =
                typeof toolResult?.backend === "string" ? toolResult.backend : undefined;
              emitSubagentStep({
                parentToolCallId: toolCallId,
                toolName: tc.toolName,
                args: stepArgs,
                state: ok ? "done" : "error",
                backend: stepBackend,
              });
            },
          } as Parameters<typeof agent.generate>[0]);
          agentSearchCache.set(cacheKey, { output: result.text, ts: Date.now() });
          if (useModelEventsStore.getState().enabled) {
            recordModelCall({
              modelId: mid,
              source: "other",
              startedAt: webSearchStartedAt,
              durationMs: Math.max(0, Date.now() - webSearchStartedAt),
              state: "ok",
            });
          }
          return { success: true, output: result.text, backend: backendLabel };
        } catch (err: unknown) {
          markRunningStepsError();
          const msg = err instanceof Error ? err.message : String(err);
          if (useModelEventsStore.getState().enabled) {
            recordModelCall({
              modelId: mid,
              source: "other",
              startedAt: webSearchStartedAt,
              durationMs: Math.max(0, Date.now() - webSearchStartedAt),
              state: "error",
              errorMessage: msg.slice(0, 500),
            });
          }
          const urlHint = extractUrlHint(args.query);
          const fallback = urlHint
            ? ` Try fetch_page("${urlHint}") to access the resource directly.`
            : " If you know a specific URL (docs page, npm package, GitHub repo), use fetch_page on that URL directly instead of searching.";
          return {
            success: false,
            output: `Search failed: ${msg}.${fallback}`,
            error: msg,
            backend: backendLabel,
          };
        }
      }

      return webSearchScraper.execute({ ...args, count: args.count ?? undefined });
    },
  });
}
