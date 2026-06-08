import type { LanguageModel } from "ai";

export interface ProviderModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
}

/** Reasoning/thinking configuration for custom OpenAI-compatible providers.
 *  Covers three API styles:
 *  - OpenAI-style: `reasoning.effort` (low/medium/high/xhigh/none)
 *  - DashScope-style: `enable_thinking` + `thinking_budget`
 *  - Raw extra params: forwarded verbatim to the request body */
export interface CustomReasoningConfig {
  /** OpenAI-style reasoning effort level */
  effort?: "low" | "medium" | "high" | "xhigh" | "none";
  /** DashScope-style: enable/disable thinking */
  enabled?: boolean;
  /** DashScope-style: thinking budget in tokens */
  budget?: number;
  /** Raw extra params forwarded verbatim to the request body.
   *  Useful for APIs with non-standard thinking schemas, e.g.:
   *  `{ thinking: { type: "enabled", budget_tokens: 8192 } }` */
  extraParams?: Record<string, unknown>;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  envVar: string;
  icon: string;
  /** Kebab-case key for the secrets store (e.g. "anthropic-api-key"). Derived from envVar if omitted. */
  secretKey?: string;
  /** URL where users can create/manage their API key (shown in /keys UI). */
  keyUrl?: string;
  /** ASCII fallback icon for terminals without nerd fonts. */
  asciiIcon?: string;
  /** Short description for wizard/UI (e.g. "Claude models"). */
  description?: string;
  /** Inline badge for provider selectors (e.g. "unofficial", "non-streaming"). */
  badge?: string;
  /** Custom label shown when the provider is unavailable and needs auth. */
  noAuthLabel?: string;
  /** Custom label shown when model loading fails after the provider is available. */
  authErrorLabel?: string;
  createModel(modelId: string): LanguageModel;
  fetchModels(): Promise<ProviderModelInfo[] | null>;
  fallbackModels: ProviderModelInfo[];
  contextWindows: [pattern: string, tokens: number][];
  /** Overrides for known-incorrect upstream API context window values.
   *  Checked BEFORE API/cache data. Only add entries here when a provider
   *  API reports a wrong value (e.g. OpenRouter lists GLM-5 as 80k). */
  contextWindowOverrides?: [pattern: string, tokens: number][];
  grouped?: boolean;
  custom?: boolean;
  checkAvailability?(): Promise<boolean>;
  onRequestAuth?(): Promise<void>;
  onActivate?(): Promise<void>;
  onDeactivate?(): void;
  /** Reasoning/thinking config for custom providers.
   *  Injected into every request body as OpenAI-style, DashScope-style, or raw params. */
  customReasoning?: CustomReasoningConfig;
}

export interface CustomProviderConfig {
  id: string;
  name?: string;
  baseURL: string;
  /** Wire format. "openai" (default) uses an OpenAI-compatible client; "anthropic"
   *  uses an Anthropic-compatible client — for APIs that expose an Anthropic
   *  /v1/messages endpoint (e.g. z.ai's GLM Coding Plan at /api/anthropic). */
  format?: "openai" | "anthropic";
  envVar?: string;
  models?: (string | ProviderModelInfo)[];
  modelsAPI?: string | false;
  /** Reasoning/thinking configuration for this provider.
   *  Enables thinking control for models that support it via OpenAI-compatible APIs. */
  reasoning?: CustomReasoningConfig;
}
