import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { ToolLoopAgent } from "ai";
import { loadConfig } from "../../config/index.js";
import { logBackgroundError } from "../../stores/errors.js";
import { EPHEMERAL_CACHE, getModelId, supportsTemperature } from "../llm/provider-options.js";
import { CORE_RULES } from "../prompts/families/shared-rules.js";
import { resolveRetrySettings } from "../retry/settings.js";
import { buildSubagentCodeTools, wrapWithBusCache } from "../tools/index.js";
import type { AgentBus } from "./agent-bus.js";
import { buildBusTools } from "./bus-tools.js";
import { buildPrepareStep, buildSymbolLookup } from "./step-utils.js";
import {
  describeAbnormalFinish,
  isAbnormalFinish,
  MAX_OUTPUT_TOKENS,
  repairToolCall,
} from "./stream-options.js";

export function codeBase(): string {
  return `${CORE_RULES}

ROLE: code agent. Make specific edits to target files. Scope defined in the task — don't explore beyond it. Report under 300 words, naming files and what changed.

READING (surgical, not full files):
- Ranges when the task gives line numbers: \`read(files=[{path:'x.ts', ranges:[{start:45,end:80}]}])\`.
- Full file only for refactors or files under 200 lines.
- Batch all reads in ONE call.

EDITING (precise, anchored):
- \`multi_edit\` for multiple changes in the same file — ONE call per file.
- Pass \`lineStart\` from your read output on every edit.
- On failure: re-read the region once, retry with exact text.
- Compound tools (\`rename_symbol\`, \`move_symbol\`, \`refactor\`) do the job in one call.

WORKFLOW: read → edit → done. 3 steps typical, 5 max.
SKIP: re-reading to verify, unrelated files, greps when you have target paths.`;
}

// No structured output schema — agents return plain text summaries.
// The system tracks edits via bus and extracts tool results deterministically.

interface CodeAgentOptions {
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
  tabId?: string;
  forgeInstructions?: string;
  /** Forge tool definitions with role guards — use instead of buildSubagentCodeTools for spark cache prefix hits. */
  forgeTools?: Record<string, unknown>;
  /** Skip bus coordination tools — for solo agents like desloppify. */
  skipBusTools?: boolean;
}

export function createCodeAgent(model: LanguageModel, options?: CodeAgentOptions) {
  const bus = options?.bus;
  const agentId = options?.agentId;
  const hasBus = !!(bus && agentId);
  const busTools = hasBus && !options?.skipBusTools ? buildBusTools(bus, agentId, "code") : {};

  // Spark mode: use forge's tool definitions (with role guards) for cache prefix hits.
  // Regular mode: build code-specific tools.
  let allTools: Record<string, unknown>;
  if (options?.forgeTools) {
    allTools = { ...options.forgeTools, ...busTools };
  } else {
    let tools = buildSubagentCodeTools({
      webSearchModel: options?.webSearchModel,
      onApproveWebSearch: options?.onApproveWebSearch,
      onApproveFetchPage: options?.onApproveFetchPage,
      repoMap: options?.repoMap,
    });
    if (hasBus) {
      tools = wrapWithBusCache(tools, bus, agentId) as typeof tools;
    }
    allTools = { ...tools, ...busTools };
  }

  const { prepareStep, stopConditions } = buildPrepareStep({
    bus,
    agentId,
    parentToolCallId: options?.parentToolCallId,
    role: "code",
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
    id: options?.agentId ?? "code",
    model,
    maxRetries: retryMaxRetries,
    ...(supportsTemperature(getModelId(model)) ? { temperature: 0 } : {}),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    onStepFinish: (step) => {
      if (isAbnormalFinish(step.finishReason)) {
        logBackgroundError(
          "agent-error",
          `${options?.agentId ?? "code"}: ${describeAbnormalFinish(step.finishReason)}`,
        );
        // SDK swallows throws in onStepFinish; surfacing happens in prepareStep (step-utils.ts).
      }
    },
    // biome-ignore lint/suspicious/noExplicitAny: forgeTools come as Record<string, unknown> for cache sharing
    tools: allTools as any,
    instructions: {
      role: "system" as const,
      content: options?.forgeInstructions
        ? options.forgeInstructions
        : (() => {
            const base = codeBase();
            if (!hasBus || options?.skipBusTools) return base;
            return `${base}\nOwnership: you own files you edit first. check_edit_conflicts before touching another agent's file.\nIf another agent owns the file: report_finding with the exact edit instead.\nCoordination: report_finding after significant changes (paths, what changed, new exports). Peer findings appear in tool results.`;
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
        // See forge.ts: gateways strip SDK-level maxOutputTokens; mirror to wire.
        max_tokens: MAX_OUTPUT_TOKENS,
      },
    } as ProviderOptions,
    ...(options?.headers ? { headers: options.headers } : {}),
  });
}
