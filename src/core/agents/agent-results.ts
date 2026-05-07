import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileReadRecord } from "./agent-bus.js";

export interface DoneToolResult {
  summary: string;
  archivePath?: string;
}

export interface DispatchOutput {
  reads: FileReadRecord[];
  filesEdited: string[];
  output: string;
}

type AgentResult = {
  text: string;
  output?: unknown;
  steps: Array<{
    text?: string;
    content?: Array<{ type: string; text?: string }>;
    toolCalls?: Array<{
      toolName: string;
      args?: Record<string, unknown>;
      input?: Record<string, unknown>;
    }>;
    toolResults?: Array<{
      toolName: string;
      input?: unknown;
      output?: unknown;
    }>;
  }>;
};

const TRUNCATE_THRESHOLD = 4000;
const HEAD_CHARS = 2000;
const TAIL_CHARS = 1000;

/**
 * Extract the agent's final text. AI SDK exposes text in two places:
 *   - step.text          (concatenated convenience string)
 *   - step.content[]     (structured parts; type === "text" carries the text)
 * Walk steps from last to first, gathering any text parts. Fall back to
 * result.text if no step text is found.
 */
export function extractFinalText(result: AgentResult): string {
  for (let i = result.steps.length - 1; i >= 0; i--) {
    const step = result.steps[i];
    if (!step) continue;
    const direct = step.text?.trim();
    if (direct && direct.length > 0) return direct;
    if (step.content && Array.isArray(step.content)) {
      const textParts = step.content
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => (p.text ?? "").trim())
        .filter((t) => t.length > 0);
      if (textParts.length > 0) return textParts.join("\n");
    }
  }
  return typeof result.text === "string" ? result.text.trim() : "";
}

/**
 * Pass agent text through verbatim. Truncate to head + tail with archive footer
 * only when oversized. Parent reads the archive file if it wants the full text.
 */
export function truncateAgentText(text: string, archivePath?: string): string {
  if (text.length <= TRUNCATE_THRESHOLD) return text;
  const head = text.slice(0, HEAD_CHARS);
  const tail = text.slice(-TAIL_CHARS);
  const footer = archivePath
    ? `\n… [truncated, full output: ${archivePath}]\n`
    : `\n… [truncated]\n`;
  return `${head}${footer}${tail}`;
}

/** Build a footer line listing files the agent read/edited via the bus. */
export function busFooter(filesExamined: string[], filesEdited: string[]): string {
  const lines: string[] = [];
  if (filesExamined.length > 0) lines.push(`Files examined: ${filesExamined.join(", ")}`);
  if (filesEdited.length > 0) lines.push(`Files edited: ${filesEdited.join(", ")}`);
  return lines.join("\n");
}

/**
 * Write agent context to disk for the parent agent to read on demand.
 * Deterministic extraction — zero LLM cost.
 * Returns the file path written.
 */
export async function writeAgentContext(
  dispatchId: string,
  agentId: string,
  task: { task: string; role: string },
  agentResult: AgentResult,
  findings: Array<{ label: string; content: string }>,
  agentText: string,
  cwd: string,
  tabId?: string,
): Promise<string> {
  const dir = tabId
    ? dispatchDir(cwd, tabId, dispatchId)
    : join(cwd, ".soulforge", "dispatch", dispatchId);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${agentId}.md`);

  const lines: string[] = [];
  lines.push(`# Agent: ${agentId} (${task.role})`);
  lines.push(`Task: ${task.task.slice(0, 300)}`);
  lines.push("");

  // Tool call stubs — what files/symbols were accessed
  const toolStubs: string[] = [];
  for (const step of agentResult.steps) {
    for (const tc of step.toolCalls ?? []) {
      const args = (tc.args ?? tc.input) as Record<string, unknown> | undefined;
      const name = tc.toolName;
      if (name === "read") {
        const path = args?.path ?? args?.file ?? "";
        const start = args?.startLine ? ` lines ${String(args.startLine)}` : "";
        const end = args?.endLine ? `-${String(args.endLine)}` : "";
        const target = args?.target ? ` (${String(args.target)}: ${String(args.name ?? "")})` : "";
        toolStubs.push(`[read] ${String(path)}${start}${end}${target}`);
      } else if (name === "edit_file" || name === "multi_edit") {
        toolStubs.push(`[${name}] ${String(args?.path ?? "")}`);
      } else if (name === "grep" || name === "soul_grep") {
        toolStubs.push(`[${name}] /${String(args?.pattern ?? "")}/`);
      } else if (name === "navigate") {
        toolStubs.push(`[navigate] ${String(args?.action ?? "")} ${String(args?.symbol ?? "")}`);
      } else if (name === "analyze") {
        toolStubs.push(
          `[analyze] ${String(args?.action ?? "")} ${String(args?.file ?? args?.symbol ?? "")}`,
        );
      } else if (name === "soul_find") {
        toolStubs.push(`[soul_find] ${String(args?.query ?? "")}`);
      } else if (name === "soul_impact" || name === "soul_analyze") {
        toolStubs.push(`[${name}] ${String(args?.action ?? "")} ${String(args?.file ?? "")}`);
      } else if (name !== "done" && name !== "report_finding" && name !== "check_findings") {
        toolStubs.push(`[${name}]`);
      }
    }
  }
  if (toolStubs.length > 0) {
    lines.push("## Tool Calls");
    lines.push(...toolStubs);
    lines.push("");
  }

  // Findings from report_finding
  if (findings.length > 0) {
    lines.push("## Findings");
    for (const f of findings) {
      lines.push(`**${f.label}:**`);
      lines.push(f.content.slice(0, 2000));
      lines.push("");
    }
  }

  // Agent's own text summary
  if (agentText.trim()) {
    lines.push("## Agent Summary");
    lines.push(agentText.trim());
    lines.push("");
  }

  await writeFile(filePath, lines.join("\n"), "utf-8");
  return filePath;
}

/**
 * Clean up dispatch context files from previous dispatches for a specific tab.
 * Tab-prefixed dirs (tab-<tabId>/) isolate dispatches across concurrent tabs.
 */
export async function cleanupDispatchDir(
  cwd: string,
  tabId: string,
  keepDispatchId?: string,
): Promise<void> {
  const tabDir = join(cwd, ".soulforge", "dispatch", `tab-${tabId}`);
  try {
    for (const entry of await readdir(tabDir)) {
      if (entry !== keepDispatchId) {
        try {
          await rm(join(tabDir, entry), { recursive: true });
        } catch {}
      }
    }
  } catch {}
}

/** Build the dispatch context dir path for a given tab + dispatch. */
function dispatchDir(cwd: string, tabId: string, dispatchId: string): string {
  return join(cwd, ".soulforge", "dispatch", `tab-${tabId}`, dispatchId);
}
