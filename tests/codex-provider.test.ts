import type { LanguageModelV2CallOptions } from "@ai-sdk/provider";
import { describe, expect, test } from "bun:test";
import { getAllProviders, getProvider } from "../src/core/llm/providers/index.js";
import { performCodexBrowserLogin } from "../src/core/llm/providers/codex/auth.js";
import {
  buildCodexSchema,
  codex,
  createCodexLanguageModel,
  parseCodexLoginStatus,
  parseCodexModelListResult,
  parseCodexResponse,
  serializeCodexPrompt,
} from "../src/core/llm/providers/codex.js";

const BASE_OPTIONS: LanguageModelV2CallOptions = {
  prompt: [
    { role: "system", content: "You are SoulForge." },
    { role: "user", content: [{ type: "text", text: "Read package.json" }] },
  ],
  responseFormat: { type: "text" },
};

describe("codex provider", () => {
  test("is registered as a builtin provider", () => {
    expect(getProvider("codex")).toBeDefined();
    expect(getAllProviders().filter((provider) => !provider.custom)).toHaveLength(22);
  });

  test("has provider metadata, fallback models, and shared auth hook", () => {
    expect(codex.id).toBe("codex");
    expect(codex.name).toBe("Codex");
    expect(codex.envVar).toBe("");
    expect(codex.description).toContain("Codex");
    expect(codex.description).toContain("turn finishes");
    expect(codex.noAuthLabel).toBe("login required — Enter to authenticate");
    expect(codex.authErrorLabel).toBe("login/session error");
    expect(codex.badge).toBe("non-streaming");
    expect(codex.onRequestAuth).toBeDefined();
    expect(codex.fallbackModels).toEqual([
      { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 272_000 },
      { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 1_050_000 },
      { id: "gpt-5.2-codex", name: "GPT-5.2-Codex", contextWindow: 400_000 },
    ]);
    expect(codex.contextWindows).toEqual([
      ["gpt-5.5", 272_000],
      ["gpt-5.4", 1_050_000],
      ["gpt-5.2-codex", 400_000],
    ]);
  });

  test("parses official codex login status output", () => {
    expect(parseCodexLoginStatus(0, "Logged in using ChatGPT")).toEqual({
      installed: true,
      loggedIn: true,
      authMode: "chatgpt",
      message: "Logged in using ChatGPT",
    });

    expect(parseCodexLoginStatus(0, "Logged in using an API key - sk-proj-***ABCDE")).toEqual({
      installed: true,
      loggedIn: true,
      authMode: "api-key",
      message: "Logged in using an API key - sk-proj-***ABCDE",
    });

    expect(parseCodexLoginStatus(1, "Not logged in")).toEqual({
      installed: true,
      loggedIn: false,
      authMode: null,
      message: "Not logged in",
    });
  });

  test("parses official model/list output and drops hidden models", () => {
    const models = parseCodexModelListResult({
      data: [
        { id: "gpt-5.4", displayName: "gpt-5.4", hidden: false },
        { id: "gpt-5.2-codex", displayName: "gpt-5.2-codex", hidden: false },
        { id: "internal-test-model", displayName: "Internal", hidden: true },
      ],
      nextCursor: null,
    });

    expect(models).toEqual([
      { id: "gpt-5.4", name: "gpt-5.4" },
      { id: "gpt-5.2-codex", name: "gpt-5.2-codex" },
    ]);
  });

  test("performs browser login via official app-server auth flow", async () => {
    const calls: string[] = [];
    const events: string[] = [];
    let openedUrl = "";

    await performCodexBrowserLogin(
      {
        request: async (method) => {
          calls.push(method);
          if (method === "account/login/start") {
            return {
              type: "chatgpt",
              loginId: "login-123",
              authUrl: "https://chatgpt.com/auth/callback",
            };
          }
          throw new Error(`Unexpected request ${method}`);
        },
        waitForNotification: async (method, predicate) => {
          calls.push(method);
          const payload = { loginId: "login-123", success: true, error: null };
          expect(predicate(payload)).toBe(true);
          return payload;
        },
      },
      async (url) => {
        openedUrl = url;
        return true;
      },
      (event) => events.push(event),
    );

    expect(calls).toEqual(["account/login/start", "account/login/completed"]);
    expect(openedUrl).toBe("https://chatgpt.com/auth/callback");
    expect(events).toEqual([
      "Starting Codex browser login...",
      "Opening browser for Codex login...",
      "Browser opened. Complete the login in ChatGPT.",
      "Codex authentication complete.",
    ]);
  });

  test("surfaces app-server login failures", async () => {
    await expect(
      performCodexBrowserLogin(
        {
          request: async () => ({
            type: "chatgpt",
            loginId: "login-123",
            authUrl: "https://chatgpt.com/auth/callback",
          }),
          waitForNotification: async () => ({
            loginId: "login-123",
            success: false,
            error: "Access denied",
          }),
        },
        async () => true,
      ),
    ).rejects.toThrow("Access denied");
  });

  test("serializes prompt transcript and available tools for Codex", () => {
    const prompt = serializeCodexPrompt({
      ...BASE_OPTIONS,
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file from disk",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      toolChoice: { type: "auto" },
    });

    expect(prompt).toContain("You are Codex running as the language-model backend for SoulForge");
    expect(prompt).toContain("SYSTEM");
    expect(prompt).toContain("Read package.json");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("Read a file from disk");
  });

  test("builds a schema that allows tool calls when tools are available", () => {
    const schema = buildCodexSchema({
      ...BASE_OPTIONS,
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file from disk",
          inputSchema: { type: "object" },
        },
      ],
      toolChoice: { type: "auto" },
    });

    expect(schema.type).toBe("object");
    expect(JSON.stringify(schema)).toContain("tool-calls");
    expect(JSON.stringify(schema)).toContain("read_file");
  });

  test("parses stop responses into reasoning and text content", () => {
    const parsed = parseCodexResponse(
      JSON.stringify({
        finishReason: "stop",
        reasoning: "Need no tools.",
        text: "Done.",
        toolCalls: [],
      }),
    );

    expect(parsed.finishReason).toBe("stop");
    expect(parsed.content).toEqual([
      { type: "reasoning", text: "Need no tools." },
      { type: "text", text: "Done." },
    ]);
  });

  test("parses tool-call responses into AI SDK tool call parts", () => {
    const parsed = parseCodexResponse(
      JSON.stringify({
        finishReason: "tool-calls",
        reasoning: "Need file contents.",
        text: "",
        toolCalls: [{ toolName: "read_file", inputJson: JSON.stringify({ path: "package.json" }) }],
      }),
    );

    expect(parsed.finishReason).toBe("tool-calls");
    expect(parsed.content[0]).toEqual({ type: "reasoning", text: "Need file contents." });
    expect(parsed.content[1]).toMatchObject({
      type: "tool-call",
      toolName: "read_file",
      input: JSON.stringify({ path: "package.json" }),
    });
  });

  test("language model forwards prompt and schema to the runner", async () => {
    const calls: Array<{ modelId: string; prompt: string; schema: unknown }> = [];
    const model = createCodexLanguageModel("gpt-5.2-codex", {
      async run(call) {
        calls.push({ modelId: call.modelId, prompt: call.prompt, schema: call.schema });
        return {
          text: JSON.stringify({
            finishReason: "stop",
            reasoning: "",
            text: "PONG",
            toolCalls: [],
          }),
          usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        };
      },
    });

    const result = await model.doGenerate(BASE_OPTIONS);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.modelId).toBe("gpt-5.2-codex");
    expect(calls[0]?.prompt).toContain("Read package.json");
    expect(result.content).toEqual([{ type: "text", text: "PONG" }]);
    expect(result.usage.totalTokens).toBe(16);
  });

  test("streaming emits final text and finish events", async () => {
    const model = createCodexLanguageModel("gpt-5.2-codex", {
      async run() {
        return {
          text: JSON.stringify({
            finishReason: "stop",
            reasoning: "",
            text: "Hello from Codex",
            toolCalls: [],
          }),
          usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
        };
      },
    });

    const { stream } = await model.doStream(BASE_OPTIONS);
    const reader = stream.getReader();
    const parts: string[] = [];

    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value.type);
    }

    expect(parts).toEqual(["stream-start", "text-start", "text-delta", "text-end", "finish"]);
  });
});
