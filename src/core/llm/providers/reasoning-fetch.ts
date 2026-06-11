import { getActiveSessionId } from "../../../stores/session.js";

/** Shared OpenAI-compatible body-injection helpers.
 *  Used by custom providers AND built-in OpenAI-compatible providers
 *  (deepseek/opencode-go/opencode-zen/groq/fireworks/lmstudio/ollama/
 *   copilot/github-models) whose SDK has no native providerOptions key. */

// Fetch function alias — avoids Bun's typeof fetch which includes preconnect
export type ReasoningFetchFn = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

/** Build OpenAI-compatible reasoning body params.
 *  Three styles emitted simultaneously — APIs ignore keys they don't recognise:
 *    OpenAI-style:    { reasoning_effort: "high" }      (groq, opencode, openai-compat)
 *    DashScope-style: { enable_thinking: true,
 *                       thinking_budget: 4096 }         (qwen, glm, kimi-thinking)
 *    Verbose-OpenAI:  { reasoning: { effort: "high" } } (older spec, some routers) */
export function buildOpenAICompatReasoningBody(
  effort: "off" | "low" | "medium" | "high" | "xhigh" | "none" | undefined,
  extras?: { enabled?: boolean; budget?: number; extraParams?: Record<string, unknown> },
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (effort && effort !== "off") {
    body.reasoning_effort = effort;
    body.reasoning = { effort };
  }

  if (extras?.enabled !== undefined) {
    body.enable_thinking = extras.enabled;
  }
  if (extras?.budget !== undefined) {
    body.thinking_budget = extras.budget;
  }
  if (extras?.extraParams) {
    Object.assign(body, extras.extraParams);
  }

  return body;
}

/** Create a fetch wrapper that injects reasoning params into every JSON request body.
 *  Returns undefined when there's nothing to inject — caller skips fetch override. */
export function createReasoningFetchWrapper(
  reasoningBody: Record<string, unknown>,
): ReasoningFetchFn | undefined {
  if (Object.keys(reasoningBody).length === 0) {
    return undefined;
  }

  return async (input, init): Promise<Response> => {
    if (!init?.body || typeof init.body !== "string") {
      return fetch(input, init);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      return fetch(input, init);
    }

    const merged = { ...parsed, ...reasoningBody };
    const patchedInit: RequestInit = { ...init, body: JSON.stringify(merged) };
    return fetch(input, patchedInit);
  };
}
/** Stamp the active chat's conversation id onto a request's headers as both
 *  `x-session-id` and `x-session-affinity` — the keys gateways/routers use for
 *  sticky provider routing (prompt-cache locality). No-op when no session is
 *  active or the headers are already set. Mutates a Headers clone, returns it. */
function applySessionHeaders(init: RequestInit | undefined): RequestInit | undefined {
  const sessionId = getActiveSessionId();
  if (!sessionId) return init;
  const headers = new Headers(init?.headers);
  if (!headers.has("x-session-id")) headers.set("x-session-id", sessionId);
  if (!headers.has("x-session-affinity")) headers.set("x-session-affinity", sessionId);
  return { ...init, headers };
}

/** Wrap a fetch so every request carries the active chat's session headers,
 *  optionally composing with reasoning-body injection so a provider needs a
 *  single fetch override. Always returns a wrapper — session stamping applies
 *  to every provider regardless of reasoning config. Pass a `baseFetch` to wrap
 *  a non-global fetch (defaults to the global `fetch`). */
export function createSessionFetchWrapper(
  reasoningBody: Record<string, unknown> = {},
  baseFetch: ReasoningFetchFn = fetch,
): ReasoningFetchFn {
  const hasReasoning = Object.keys(reasoningBody).length > 0;

  return async (input, init): Promise<Response> => {
    let nextInit = applySessionHeaders(init);

    if (hasReasoning && nextInit?.body && typeof nextInit.body === "string") {
      try {
        const parsed = JSON.parse(nextInit.body) as Record<string, unknown>;
        nextInit = { ...nextInit, body: JSON.stringify({ ...parsed, ...reasoningBody }) };
      } catch {}
    }

    return baseFetch(input, nextInit);
  };
}

/** Bare session-header fetch wrapper for providers using a native SDK with no
 *  reasoning-body injection (anthropic, openai, google, xai, mistral, etc.).
 *  Drop in as the SDK's `fetch` option. */
export function withSessionHeaders(baseFetch: ReasoningFetchFn = fetch): ReasoningFetchFn {
  return async (input, init): Promise<Response> => baseFetch(input, applySessionHeaders(init));
}
