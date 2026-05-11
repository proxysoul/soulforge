interface RouterRule {
  /** glob pattern or keyword to match against the user message */
  match?: string;
  /** model ID in "provider/model" format */
  modelId: string;
  /** priority — higher wins when multiple rules match */
  priority?: number;
}

export interface TaskRouter {
  /** Model for ⚡ spark agents — explore/investigate. */
  spark: string | null;
  /** Model for 🔥 ember agents — code edits. */
  ember: string | null;
  webSearch: string | null;
  desloppify: string | null;
  verify: string | null;
  compact: string | null;
  semantic: string | null;
  default: string | null;
  /** Max concurrent dispatch agents. Default: 3. Range: 2–8. */
  maxConcurrentAgents?: number;
  /** @config-compat Legacy fields — mapped to spark/ember on load. Hidden from /router UI. */
  coding?: string | null;
  exploration?: string | null;
  trivial?: string | null;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  /** Which intelligence backend handled this (ts-morph, lsp, tree-sitter, regex) */
  backend?: string;
  /** True when read returned only an outline (large file) — tracker should not cache this as a full read */
  outlineOnly?: boolean;
  /** Files edited by dispatch tool — used by /changes panel to track per-tab edits */
  filesEdited?: string[];
}

export type PlanStepStatus = "pending" | "active" | "done" | "skipped";

interface PlanStep {
  id: string;
  label: string;
  status: PlanStepStatus;
  startedAt?: number;
}

export type PlanDepth = "light" | "full";

export interface Plan {
  title: string;
  steps: PlanStep[];
  createdAt: number;
  depth: PlanDepth;
}

interface PlanSymbolChange {
  name: string;
  kind: string;
  action: "add" | "modify" | "remove" | "rename";
  details: string;
  line?: number;
}

interface PlanFileChange {
  path: string;
  action: "create" | "modify" | "delete";
  description: string;
  symbols?: PlanSymbolChange[];
}

export interface PlanOutput {
  title: string;
  context: string;
  files: PlanFileChange[];
  steps: Array<{ id: string; label: string; details?: string }>;
  verification: string[];
}

interface QuestionOption {
  label: string;
  value: string;
  description?: string;
}

export interface PendingQuestion {
  id: string;
  question: string;
  options: QuestionOption[];
  allowSkip: boolean;
  resolve: (answer: string) => void;
  /** Permission prompts (web access, outside-cwd, destructive) — answer shown in UI but not sent as steering. */
  isPermission?: boolean;
  /** Hide the "Other" free-text option — only show the listed options. */
  hideOther?: boolean;
}

export type PlanReviewAction = "execute" | "clear_execute" | "cancel" | string;

export interface PendingPlanReview {
  plan: Plan;
  planFile: string;
  planContent: string;
  resolve: (action: PlanReviewAction) => void;
}

export interface InteractiveCallbacks {
  onPlanCreate: (plan: Plan) => void;
  onPlanStepUpdate: (stepId: string, status: PlanStepStatus) => void;
  onPlanReview: (plan: Plan, planFile: string, planContent: string) => Promise<PlanReviewAction>;
  onAskUser: (question: string, options: QuestionOption[], allowSkip: boolean) => Promise<string>;
  onOpenEditor: (file?: string) => Promise<void>;
  onWebSearchApproval: (query: string) => Promise<boolean>;
  onFetchPageApproval: (url: string) => Promise<boolean>;
}

export interface QueuedMessage {
  content: string;
  queuedAt: number;
  images?: ImageAttachment[];
}

export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "tools"; toolCallIds: string[] }
  | { type: "reasoning"; content: string; id: string }
  | { type: "plan"; plan: Plan };

export interface ImageAttachment {
  /** Sequential label shown in chat, e.g. "image-1" */
  label: string;
  /** Base64-encoded image data */
  base64: string;
  /** IANA media type */
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  /** Ordered segments for interleaved text/tool rendering. */
  segments?: MessageSegment[];
  /** When true, system messages render inline in chat instead of the ephemeral banner. */
  showInChat?: boolean;
  /** Marks a user message injected via steering (sent while AI was working). */
  isSteering?: boolean;
  /** Origin of a user message — "local" (TUI), "telegram", "discord", etc. */
  origin?: "local" | "telegram" | "discord" | "fakechat";
  /** How long the assistant response took (ms). Set when the response completes. */
  durationMs?: number;
  /** Attached images (pasted from clipboard or referenced by path). */
  images?: ImageAttachment[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  /** Image art for inline display. Half-block ANSI art or Kitty graphics placeholders. */
  imageArt?: Array<{
    name: string;
    lines: string[];
    kittyImageId?: number;
    kittyCols?: number;
    kittyRows?: number;
  }>;
  /** Parent code_execution tool call ID — set when this tool was called from code execution. */
  parentId?: string;
}

export type NvimConfigMode = "default" | "user" | "none";

interface CodeIntelligenceConfig {
  backend?: "auto" | "ts-morph" | "tree-sitter" | "regex";
  language?: string;
}

export type ThinkingMode = "off" | "adaptive" | "enabled" | "disabled" | "auto";

interface ThinkingConfig {
  /** "auto" enables adaptive thinking for Anthropic models. Default: "auto" */
  mode: ThinkingMode;
  /** Budget tokens — only used when mode is "enabled". Min 1024. */
  budgetTokens?: number;
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ServiceTier = "auto" | "flex" | "priority" | "default";

export type GoogleThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";
export type XaiReasoningEffort = "off" | "low" | "medium" | "high";
export type DeepseekThinking = "off" | "enabled";
export type OpenRouterReasoningEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "none";
export type GroqReasoningEffort = "off" | "low" | "medium" | "high";
export type CompatReasoningEffort = "off" | "low" | "medium" | "high" | "xhigh";

export interface PerformanceConfig {
  /** Effort level for model reasoning. "off" = not sent to API. */
  effort?: EffortLevel | "off";
  /** Speed mode — "fast" enables 2.5x output for Opus 4.6. "off" = not sent to API. */
  speed?: "off" | "fast" | "standard";
  /** Disable parallel tool calls — model calls one tool at a time. */
  disableParallelToolUse?: boolean;
  /** Send reasoning content in requests. Default: true. */
  sendReasoning?: boolean;
  /** Stream tool call arguments incrementally. Default: true. Set false to receive complete tool calls. */
  toolStreaming?: boolean;
  /** OpenAI reasoning effort for o3/o4/gpt-5 models. "off" = not sent. */
  openaiReasoningEffort?: OpenAIReasoningEffort | "off";
  /** OpenAI service tier — "flex" saves 50% with latency trade-off. */
  serviceTier?: ServiceTier | "off";
  /** OpenAI reasoning summary level — "detailed" | "auto" | "off" */
  openaiReasoningSummary?: "off" | "auto" | "detailed";
  /** OpenAI gpt-5 verbosity — controls answer length. */
  openaiVerbosity?: "off" | "low" | "medium" | "high";
  /** Groq reasoning output format — "parsed" | "raw" | "hidden" */
  groqReasoningFormat?: "off" | "parsed" | "raw" | "hidden";
  /** Google Gemini 3+ thinkingLevel. "off" = not sent. */
  googleThinkingLevel?: GoogleThinkingLevel;
  /** Google Gemini 2.5 thinkingBudget in tokens. "off" = not sent. 0 disables. */
  googleThinkingBudget?: number | "off";
  /** Include thought summaries in Gemini responses. Default: false. */
  googleIncludeThoughts?: boolean;
  /** xAI Grok reasoning effort (chat: low/high; responses: low/medium/high). */
  xaiReasoningEffort?: XaiReasoningEffort;
  /** DeepSeek thinking — only applies to deepseek-chat (reasoner auto-thinks). */
  deepseekThinking?: DeepseekThinking;
  /** OpenRouter unified reasoning effort. */
  openrouterReasoningEffort?: OpenRouterReasoningEffort;
  /** OpenRouter max_tokens for reasoning. Anthropic-style budget. "off" = not sent. */
  openrouterReasoningMaxTokens?: number | "off";
  /** OpenRouter — exclude reasoning tokens from response (still computed). */
  openrouterExcludeReasoning?: boolean;
  /** Groq reasoning effort for qwen3/gpt-oss/deepseek-r1 SKUs. */
  groqReasoningEffort?: GroqReasoningEffort;
  /** OpenAI-compatible body-injection reasoning effort. Used by groq/fireworks/lmstudio/ollama/copilot/github-models/opencode-go/opencode-zen/deepseek-chat fallback when no native providerOptions key exists. */
  compatReasoningEffort?: CompatReasoningEffort;
}

type PruningTarget = "none" | "main" | "subagents" | "both";

export interface ContextManagementConfig {
  /** Enable server-side context compaction for 200K+ models */
  compact?: boolean;
  /** Clear old tool use results server-side (triggers at 65% context window, busts cache) */
  clearToolUses?: boolean;
  /** Preserve thinking blocks with keep:"all" for cache stability (default: on) */
  clearThinking?: boolean;
  /** @deprecated Use pruningTarget instead */
  disablePruning?: boolean;
  /** Which agents get tool result pruning: none | main | subagents | both. Default: subagents */
  pruningTarget?: PruningTarget;
}

interface CompactionConfig {
  /** "v1" = LLM batch summarization, "v2" = incremental structured extraction (default), "disabled" = no auto-compaction */
  strategy?: "v1" | "v2" | "disabled";
  /** Threshold (0-1) at which auto-compaction triggers. Default: 0.7 */
  triggerThreshold?: number;
  /** Hysteresis reset threshold. Default: 0.4 */
  resetThreshold?: number;
  /** Number of recent messages to keep verbatim. Default: 4 */
  keepRecent?: number;
  /** Max tool result slots to retain in working state (v2 only). Default: 30 */
  maxToolResults?: number;
  /** Use a cheap LLM gap-fill pass for fuzzy extraction (v2 only). Default: true */
  llmExtraction?: boolean;
  /** Disable semantic pruning of old tool results in subagents. Default: true (disabled). Pruning breaks prompt cache — Anthropic models use server-side context management instead. */
  disablePruning?: boolean;
}

export interface AgentFeatures {
  /** Run a cleanup agent after code agents to remove sloppy patterns. Default: false — enable via /agent-features or config */
  desloppify?: boolean;
  /** Auto-classify tasks as trivial and route to cheaper models. Default: true (when trivial model is set in /router) */
  tierRouting?: boolean;
  /** Cache file reads across dispatch boundaries so parent doesn't re-read. Default: true */
  dispatchCache?: boolean;
  /** Require targetFiles on dispatch tasks — reject vague instructions. Default: true */
  targetFileValidation?: boolean;
  /** Run a verification agent after code agents to adversarially review changes. Default: false — enable via /agent-features or config */
  verifyEdits?: boolean;
  /** Allow the agent to search, install, and load skills. Default: true */
  agentSkills?: boolean;
  /** Only expose core tools initially; deferred tools loaded via request_tools. Default: false — all tools active to avoid roundtrips. */
  onDemandTools?: boolean;
}

/** Doppelganger (spark) = inherits parent conversation, same model, cache hits. Diverge (ember) = fresh context, can use cheaper model. */
export type TaskTier = "spark" | "ember";

export interface AppConfig {
  defaultModel: string;
  routerRules: RouterRule[];
  taskRouter?: TaskRouter;
  editor: {
    command: string; // "nvim" by default
    args: string[];
  };
  theme: {
    name: string;
    transparent?: boolean;
    accentColor?: string;
    /** User message background opacity when transparent mode is on: 0=clear, 30=dim, 70=subtle, 100=solid */
    userMessageOpacity?: number;
    /** Diff background opacity when transparent mode is on: 0=clear, 30=dim, 70=subtle, 100=solid */
    diffOpacity?: number;
    /** Border visibility strength: default, strong, op */
    borderStrength?: "default" | "strong" | "op";
  };
  nvimPath?: string;
  nvimConfig?: NvimConfigMode;
  editorIntegration?: EditorIntegration;
  codeIntelligence?: CodeIntelligenceConfig;
  font?: string;
  thinking?: ThinkingConfig;
  performance?: PerformanceConfig;
  contextManagement?: ContextManagementConfig;
  compaction?: CompactionConfig;
  codeExecution?: boolean;
  /** Enable Anthropic's computer use tool (keyboard/mouse/screenshot). Claude-only. Default: false */
  computerUse?: boolean;
  /** Enable Anthropic's text editor tool (str_replace_based_edit_tool). Claude-only. Default: false */
  anthropicTextEditor?: boolean;
  /** Enable web search tool for all LLMs. Always prompts for approval before searching. Default: true */
  webSearch?: boolean;
  /** Show vim keybinding hints in the editor panel. Default: true */
  vimHints?: boolean;
  /** Editor/chat split percentage (editor width). Default: 60 */
  editorSplit?: number;
  /** Show verbose tool output (plan updates, etc.) in chat. Default: false */
  verbose?: boolean;
  /** Diff display style: "default" | "sidebyside" | "compact". Default: "default" */
  diffStyle?: "default" | "sidebyside" | "compact";
  /** Auto-compact diffs after streaming ends (Ctrl+O to expand). Default: false */
  collapseDiffs?: boolean;
  /** Whether the terminal uses a Nerd Font. null = auto-detect from installed fonts. */
  nerdFont?: boolean | null;
  /** Chat layout style. Default: "accent" */
  chatStyle?: ChatStyle;
  /** Lock-in mode — hide agent narration during work, show only tools + final answer. Default: false */
  lockIn?: boolean;
  /** Show reasoning/thinking content in chat. Default: true */
  showReasoning?: boolean;
  /** Add co-author trailer on AI-assisted commits. Default: true */
  coAuthorCommits?: boolean;
  /** Default forge mode for new sessions. Default: "default" */
  defaultForgeMode?: ForgeMode;
  /** Enable/disable soul map (AST index). Disabling saves ~4-8k prompt tokens. Default: true. Toggle via /repo-map → 'e'. */
  repoMap?: boolean;
  /** Semantic summary mode: "off", "ast" (docstrings only), "synthetic" (ast + name-derived, free), "llm" (ast + AI-generated), "full" (ast + llm + synthetic). Boolean compat: true → "synthetic", false → "off". "on" is legacy alias for "full". */
  semanticSummaries?: "off" | "ast" | "synthetic" | "llm" | "full" | "on" | boolean;
  /** Max symbols to summarize with LLM (default 300). Controls API cost for llm/full modes. PageRank-ranked — top N most connected symbols get LLM summaries. */
  semanticSummaryLimit?: number;
  /** Auto-regenerate LLM summaries when files change. Default: false (only ast/synthetic auto-regen). */
  semanticAutoRegen?: boolean;
  /** Token budget for soul map rendering. Undefined = auto (scales with conversation length). */
  repoMapTokenBudget?: number;
  /** LSP servers to disable (by Mason package name). Scoped: project overrides global. */
  disabledLspServers?: string[];
  agentFeatures?: AgentFeatures;
  /** Tools disabled by the user. Persisted across sessions. */
  disabledTools?: string[];
  /** Custom OpenAI-compatible providers. Merged: project overrides global by id. */
  providers?: import("../core/llm/providers/types.js").CustomProviderConfig[];
  /** Instruction files to load into system prompt. Default: ["forge"] (FORGE.md only). */
  instructionFiles?: string[];
  /** API key resolution priority: "env" = env vars first (default), "app" = keychain/file first. */
  keyPriority?: "env" | "app";
  /** Whether the first-run onboarding wizard has been completed. */
  onboardingComplete?: boolean;
  /** MCP servers to connect to. Each entry spawns a subprocess (stdio) or connects via HTTP+SSE. */
  mcpServers?: MCPServerConfig[];
  /** Auto-retry on stream stalls. Default: false (disabled). Toggle via /watchdog. */
  watchdog?: boolean;
  /** Watchdog timeouts for detecting stalled streams. */
  watchdogTimeouts?: WatchdogTimeouts;
  /** Tool call timeout in minutes. Applies to shell, project, and agent tools. Default: 2 */
  toolTimeout?: number;
  /** Retry behavior for transient provider errors (429, 529, 503, timeouts, overloaded). */
  retry?: RetryConfig;
  /** Memory subsystem config. embeddingModel: AI SDK model id (e.g. "openai/text-embedding-3-small"). null/undefined falls back to hashbag-v2. */
  memory?: { embeddingModel?: string | null };
}

export interface RetryConfig {
  /** Max retry attempts per request. Default: 3. Range: 1–10. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry. Doubles each attempt + jitter. Default: 2000 (agents), 1000 (chat). Range: 250–60000. */
  baseDelayMs?: number;
}

export interface WatchdogTimeouts {
  /** Timeout in ms before first content chunk. Default: 180000 (180s). Range: 30000-600000. */
  firstChunkMs?: number;
  /** Timeout in ms between subsequent chunks. Default: 120000 (120s). Range: 30000-600000. */
  chunkMs?: number;
  /** Max timeout in ms while tools are executing. Default: 900000 (15min). Range: 120000-1800000. */
  toolMaxMs?: number;
  /** Grace period in ms after abort before force-resolving. Default: 5000 (5s). Range: 1000-30000. */
  forceResolveMs?: number;
}

/** Clamp watchdog timeout values to their documented safe ranges. */
export function clampWatchdogTimeouts(
  raw: Partial<WatchdogTimeouts> | undefined,
): Required<WatchdogTimeouts> {
  const clamp = (value: number | undefined, min: number, max: number, fallback: number) => {
    if (value === undefined) return fallback;
    return Math.max(min, Math.min(max, value));
  };
  return {
    firstChunkMs: clamp(raw?.firstChunkMs, 30_000, 600_000, 180_000),
    chunkMs: clamp(raw?.chunkMs, 30_000, 600_000, 120_000),
    toolMaxMs: clamp(raw?.toolMaxMs, 120_000, 1_800_000, 900_000),
    forceResolveMs: clamp(raw?.forceResolveMs, 1_000, 30_000, 5_000),
  };
}

export interface MCPServerConfig {
  /** Display name and tool namespace prefix (e.g. "github" → tools namespaced as mcp__github__*) */
  name: string;
  /** Transport type. "stdio" for local subprocess, "http" for Streamable HTTP (recommended for remote), "sse" for legacy SSE. Default: "stdio" */
  transport?: "stdio" | "http" | "sse";
  /** Command to spawn (stdio transport). e.g. "npx" */
  command?: string;
  /** Arguments for the command. e.g. ["-y", "@modelcontextprotocol/server-github"] */
  args?: string[];
  /** Environment variables passed to the subprocess. */
  env?: Record<string, string>;
  /** URL for http/sse transports (remote servers). */
  url?: string;
  /** Per-tool-call timeout in ms. Default: 30000 */
  timeout?: number;
  /** Disable this server without removing config. */
  disabled?: boolean;
  /** HTTP headers for http/sse transports (e.g. Authorization). */
  headers?: Record<string, string>;
}

export type FocusMode = "chat" | "editor";

export type ForgeMode = "default" | "architect" | "socratic" | "challenge" | "plan" | "auto";

export type ChatStyle = "accent" | "bubble";

export type AgentEditorAccess = "on" | "off" | "when-open";

export interface EditorIntegration {
  diagnostics: boolean;
  symbols: boolean;
  hover: boolean;
  references: boolean;
  definition: boolean;
  codeActions: boolean;
  editorContext: boolean;
  rename: boolean;
  lspStatus: boolean;
  format: boolean;
  /** Whether the AI agent can use the editor tool. "on"=always, "off"=never, "when-open"=only when editor panel is open. Default: "on" */
  agentAccess?: AgentEditorAccess;
  /** Whether to sync (navigate) the editor to files after agent edits. Default: true */
  syncEditorOnEdit?: boolean;
}
