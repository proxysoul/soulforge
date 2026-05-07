import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { ToolLoopAgent } from "ai";
import { loadConfig } from "../../config/index.js";
import { EPHEMERAL_CACHE, getModelId, supportsTemperature } from "../llm/provider-options.js";
import { CORE_RULES } from "../prompts/families/shared-rules.js";
import { resolveRetrySettings } from "../retry/settings.js";
import { buildEmberExploreTools, wrapWithBusCache } from "../tools/index.js";
import type { AgentBus } from "./agent-bus.js";
import { buildBusTools } from "./bus-tools.js";
import { buildPrepareStep, buildSymbolLookup } from "./step-utils.js";
import { repairToolCall } from "./stream-options.js";

export function exploreBase(): string {
  return `${CORE_RULES}

ROLE: explore agent. Read-only research. No file edits. Scope strictly to the task — note related systems outside scope in at most one sentence. Report under 500 words.

REPORT (parent is BLIND to your tool results):
The parent already has the Soul Map: file paths, exported symbol names, signatures, line numbers, dependency edges. Don't repeat it. Report what's INSIDE the code:
- Function bodies: logic, control flow, formulas, algorithms
- Concrete values: config entries, magic numbers, lookup tables, enum members
- Internal wiring: store selectors used, re-render triggers, data transforms between layers
- Call chains: A calls B with args X, B returns Y, A passes Y to C
Every claim anchored with \`file:line\`.

TOOLS:
- soul_find — files/symbols by name. Start here with a keyword.
- soul_grep — code patterns. count for frequency, wordBoundary for exact.
- soul_impact — dependents, dependencies, cochanges. For blast radius / data flow.
- soul_analyze — file_profile, unused_exports, symbols_by_kind, call_graph. For architecture.
- navigate — definitions, references, call hierarchies across files.
- read — file content with ranges. Batch multiple files in ONE call.

WORKFLOW:
- Paths given → batch read with ranges in ONE call.
- Keywords only → soul_find first, then read hits.
- "What depends on X?" → soul_impact(dependents).
- "How is X used?" → navigate(references).
- "What does this file do?" → soul_analyze(file_profile).`;
}

/** @deprecated Use exploreBase() — investigate and explore are merged. */
export function investigateBase(): string {
  return exploreBase();
}

// No structured output schema — agents return plain text summaries.
// The system extracts tool results deterministically and writes context files to disk.

interface ExploreAgentOptions {
  bus?: AgentBus;
  agentId?: string;
  parentToolCallId?: string;
  providerOptions?: ProviderOptions;
  headers?: Record<string, string>;
  webSearchModel?: LanguageModel;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  onApproveFetchPage?: (url: string) => Promise<boolean>;
  repoMap?: import("../workers/intelligence-client.js").IntelligenceClient;
  contextWindow?: number;
  disablePruning?: boolean;
  role?: "explore" | "investigate";
  tabId?: string;
  forgeInstructions?: string;
  /** Forge tool definitions with role guards — spark cache prefix hits. */
  forgeTools?: Record<string, unknown>;
  /** Skip bus coordination tools (report_finding, check_findings) — for solo agents like verifier. */
  skipBusTools?: boolean;
}

export function createExploreAgent(model: LanguageModel, options?: ExploreAgentOptions) {
  const bus = options?.bus;
  const agentId = options?.agentId;
  const hasBus = !!(bus && agentId);
  const busTools = hasBus && !options?.skipBusTools ? buildBusTools(bus, agentId, "explore") : {};

  // Spark: forge's tool definitions (with role guards) for cache prefix hits.
  // Ember: 7 read-only intelligence tools (different model, no cache sharing).
  let allTools: Record<string, unknown>;
  if (options?.forgeTools) {
    allTools = { ...options.forgeTools, ...busTools };
  } else {
    let tools = buildEmberExploreTools({ repoMap: options?.repoMap, tabId: options?.tabId });
    if (hasBus) {
      tools = wrapWithBusCache(tools, bus, agentId) as typeof tools;
    }
    allTools = { ...tools, ...busTools };
  }

  const { prepareStep, stopConditions } = buildPrepareStep({
    bus,
    agentId,
    parentToolCallId: options?.parentToolCallId,
    role: "explore",
    allTools,
    symbolLookup: buildSymbolLookup(options?.repoMap),
    contextWindow: options?.contextWindow,
    disablePruning: options?.disablePruning,
    tabId: options?.tabId,
  });

  const { maxRetries: retryMaxRetries } = resolveRetrySettings(loadConfig().retry, {
    agent: true,
  });

  return new ToolLoopAgent({
    id: options?.agentId ?? "explore",
    model,
    maxRetries: retryMaxRetries,
    ...(supportsTemperature(getModelId(model)) ? { temperature: 0 } : {}),
    // biome-ignore lint/suspicious/noExplicitAny: forgeTools come as Record<string, unknown> for cache sharing
    tools: allTools as any,
    instructions: {
      role: "system" as const,
      content: options?.forgeInstructions
        ? options.forgeInstructions
        : (() => {
            const base = exploreBase();
            if (!hasBus || options?.skipBusTools) return base;
            return `${base}\nCoordination: report_finding after discoveries — especially shared symbols/configs with peer targets. check_findings for peer detail.`;
          })(),
      providerOptions: EPHEMERAL_CACHE,
    },
    stopWhen: stopConditions,
    prepareStep,
    experimental_repairToolCall: repairToolCall,
    providerOptions: {
      ...options?.providerOptions,
      anthropic: {
        ...(((options?.providerOptions as Record<string, unknown>)?.anthropic as Record<
          string,
          unknown
        >) ?? {}),
        cacheControl: { type: "ephemeral" },
      },
    } as ProviderOptions,
    ...(options?.headers ? { headers: options.headers } : {}),
  });
}
