export interface SubagentStep {
  parentToolCallId: string;
  toolName: string;
  args?: string;
  state: "running" | "done" | "error";
  /** Agent ID within a multi-agent group (e.g. "researcher-1") */
  agentId?: string;
  /** Cache event type */
  cacheState?: "hit" | "wait" | "store" | "invalidate";
  /** Agent that originally cached this file (for cache hits/waits) */
  sourceAgentId?: string;
  /** Intelligence backend that handled this call (ts-morph, lsp, tree-sitter, regex) */
  backend?: string;
}

/** Emitted when a multi_agent dispatch starts/progresses/completes */
export interface MultiAgentEvent {
  parentToolCallId: string;
  type:
    | "dispatch-start"
    | "agent-start"
    | "agent-done"
    | "agent-error"
    | "agent-retry"
    | "agent-warning"
    | "dispatch-done";
  agentId?: string;
  role?: import("./agent-bus.js").AgentRole;
  task?: string;
  /** Total agents in the group */
  totalAgents?: number;
  /** Number completed so far */
  completedAgents?: number;
  /** Number of findings shared on the bus */
  findingCount?: number;
  error?: string;
  /** Model ID the agent was routed to */
  modelId?: string;
  /** Execution tier: spark (mirror), ember (diverge), desloppify */
  tier?: string;
  /** Per-agent stats (emitted on agent-done/agent-error) */
  toolUses?: number;
  tokenUsage?: { input: number; output: number; total: number };
  cacheHits?: number;
  /** Actual chars in the agent's result text (emitted on agent-done) */
  resultChars?: number;
  /** Whether the agent called the done tool (vs hitting step/token limit) */
  succeeded?: boolean;
  /** Warning message for complexity or verification issues */
  warning?: string;
}

export interface AgentStatsEvent {
  parentToolCallId: string;
  agentId: string;
  modelId?: string;
  toolUses: number;
  stepCount: number;
  tokenUsage: { input: number; output: number; total: number };
  cacheHits: number;
  cacheWrite: number;
}

type StepListener = (step: SubagentStep) => void;
type MultiAgentListener = (event: MultiAgentEvent) => void;
type AgentStatsListener = (event: AgentStatsEvent) => void;

const stepListeners = new Set<StepListener>();
const multiAgentListeners = new Set<MultiAgentListener>();
const agentStatsListeners = new Set<AgentStatsListener>();

export function emitSubagentStep(step: SubagentStep): void {
  for (const fn of stepListeners) fn(step);
}

export function onSubagentStep(fn: StepListener): () => void {
  stepListeners.add(fn);
  return () => {
    stepListeners.delete(fn);
  };
}

export function emitMultiAgentEvent(event: MultiAgentEvent): void {
  for (const fn of multiAgentListeners) fn(event);
}

export function onMultiAgentEvent(fn: MultiAgentListener): () => void {
  multiAgentListeners.add(fn);
  return () => {
    multiAgentListeners.delete(fn);
  };
}

export function emitAgentStats(event: AgentStatsEvent): void {
  for (const fn of agentStatsListeners) fn(event);
}

export function onAgentStats(fn: AgentStatsListener): () => void {
  agentStatsListeners.add(fn);
  return () => {
    agentStatsListeners.delete(fn);
  };
}
