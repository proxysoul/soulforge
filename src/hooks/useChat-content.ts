import type { ChatMessage, MessageSegment, ToolCall } from "../types/index.js";

interface RenderableAssistantContentOptions {
  fullText: string;
  toolCallCount: number;
  segments: MessageSegment[];
}

export function hasRenderableAssistantContent({
  fullText,
  toolCallCount,
  segments,
}: RenderableAssistantContentOptions): boolean {
  if (fullText.trim().length > 0) return true;
  if (toolCallCount > 0) return true;

  for (const segment of segments) {
    if (segment.type === "plan") return true;
    if (segment.type === "reasoning") return true;
    if (segment.type === "text" && segment.content.trim().length > 0) return true;
  }

  return false;
}

interface BuildAssistantMessageOptions {
  fullText: string;
  completedCalls: ToolCall[];
  segments: MessageSegment[];
  responseStartedAt: number;
  now: number;
  finalResponseCalled?: boolean;
}

export function buildAssistantMessage({
  fullText,
  completedCalls,
  segments,
  responseStartedAt,
  now,
  finalResponseCalled,
}: BuildAssistantMessageOptions): ChatMessage | null {
  if (
    !hasRenderableAssistantContent({
      fullText,
      toolCallCount: completedCalls.length,
      segments,
    })
  ) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: fullText,
    timestamp: now,
    toolCalls: completedCalls.length > 0 ? completedCalls : undefined,
    segments: segments.length > 0 ? segments : undefined,
    durationMs: now - responseStartedAt,
    ...(finalResponseCalled ? { finalResponseCalled: true } : {}),
  };
}
