import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatMessage, ToolCall } from "../../types/index.js";
import { copyToClipboard } from "../platform/clipboard.js";

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function escapeToolArg(val: unknown): string {
  if (typeof val === "string") {
    if (val.length > 200) return `${val.slice(0, 200)}…`;
    return val;
  }
  const s = JSON.stringify(val);
  if (s.length > 200) return `${s.slice(0, 200)}…`;
  return s;
}

function renderToolCall(tc: ToolCall): string {
  const argSummary = Object.entries(tc.args)
    .map(([k, v]) => `${k}=${escapeToolArg(v)}`)
    .join(", ");
  const header = `\`${tc.name}(${argSummary})\``;

  if (!tc.result) return `- ${header} _(no result)_\n`;

  const status = tc.result.success ? "✓" : "✗";
  const output = tc.result.output.trim();
  const error = tc.result.error?.trim();

  const lines: string[] = [];
  lines.push(`<details>`);
  lines.push(`<summary>${status} ${header}</summary>\n`);

  if (output) {
    const truncated = output.length > 2000 ? `${output.slice(0, 2000)}\n…truncated` : output;
    lines.push("```");
    lines.push(truncated);
    lines.push("```\n");
  }
  if (error) {
    lines.push(`**Error:** ${error}\n`);
  }

  lines.push("</details>\n");
  return lines.join("\n");
}

function renderMessage(msg: ChatMessage): string | null {
  if (msg.role === "system" && !msg.showInChat) return null;

  const parts: string[] = [];
  const roleLabel =
    msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "System";
  const ts = formatTimestamp(msg.timestamp);
  parts.push(`### ${roleLabel}`);
  parts.push(`<sub>${ts}</sub>\n`);

  if (msg.segments && msg.segments.length > 0) {
    const toolMap = new Map<string, ToolCall>();
    for (const tc of msg.toolCalls ?? []) toolMap.set(tc.id, tc);

    for (const seg of msg.segments) {
      switch (seg.type) {
        case "text": {
          const text = seg.content.trim();
          if (text) parts.push(`${text}\n`);
          break;
        }
        case "tools":
          for (const tcId of seg.toolCallIds) {
            const tc = toolMap.get(tcId);
            if (tc) parts.push(renderToolCall(tc));
          }
          break;
        case "reasoning":
          parts.push("<details>");
          parts.push("<summary>💭 Reasoning</summary>\n");
          parts.push(seg.content.trim());
          parts.push("\n</details>\n");
          break;
        case "plan":
          parts.push("**Plan:**\n");
          for (const step of seg.plan.steps) {
            const check = step.status === "done" ? "x" : " ";
            parts.push(`- [${check}] ${step.label}`);
          }
          parts.push("");
          break;
      }
    }
  } else {
    const text = msg.content.trim();
    if (text) parts.push(`${text}\n`);

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      parts.push("**Tool Calls:**\n");
      for (const tc of msg.toolCalls) {
        parts.push(renderToolCall(tc));
      }
    }
  }

  return parts.join("\n");
}

function exportToMarkdown(messages: ChatMessage[], title: string): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  if (messages.length > 0) {
    const first = messages[0];
    const last = messages[messages.length - 1];
    if (first && last) {
      lines.push(
        `\n> Exported from SoulForge — ${formatTimestamp(first.timestamp)} to ${formatTimestamp(last.timestamp)}`,
      );
    }
  }
  lines.push(`\n---\n`);

  for (const msg of messages) {
    const rendered = renderMessage(msg);
    if (rendered) {
      lines.push(rendered);
      lines.push("---\n");
    }
  }

  return lines.join("\n");
}

function exportToJson(messages: ChatMessage[]): string {
  return JSON.stringify(messages, null, 2);
}

interface ExportResult {
  path: string;
  messageCount: number;
  format: "markdown" | "json";
}

interface ClipboardResult {
  messageCount: number;
  format: "markdown";
  ok: boolean;
}

export function exportToClipboard(messages: ChatMessage[], title?: string): ClipboardResult {
  const label = title ?? "Chat Export";
  const content = exportToMarkdown(messages, label);
  const ok = copyToClipboard(content);
  const visible = messages.filter((m) => m.role !== "system" || m.showInChat).length;
  return { messageCount: visible, format: "markdown", ok };
}

export function exportChat(
  messages: ChatMessage[],
  opts: { format?: "markdown" | "json"; outPath?: string; title?: string; cwd: string },
): ExportResult {
  const format = opts.format ?? "markdown";
  const title = opts.title ?? "Chat Export";
  const ext = format === "json" ? ".json" : ".md";

  let outPath: string;
  if (opts.outPath) {
    outPath = opts.outPath.startsWith("/") ? opts.outPath : join(opts.cwd, opts.outPath);
  } else {
    const exportDir = join(opts.cwd, ".soulforge", "exports");
    mkdirSync(exportDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const slug = slugify(title);
    outPath = join(exportDir, `${slug}-${stamp}${ext}`);
  }

  const parentDir = dirname(outPath);
  mkdirSync(parentDir, { recursive: true });

  const content = format === "json" ? exportToJson(messages) : exportToMarkdown(messages, title);

  writeFileSync(outPath, content, "utf-8");

  const visible = messages.filter((m) => m.role !== "system" || m.showInChat).length;

  return { path: outPath, messageCount: visible, format };
}
