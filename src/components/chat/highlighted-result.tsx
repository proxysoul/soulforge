import type { ReactNode } from "react";
import { langFromPath } from "../../core/diff.js";
import { useTheme } from "../../core/theme/index.js";
import { getSyntaxStyle, getTSClient } from "../../core/utils/syntax.js";
import type { ToolCall } from "../../types/index.js";

/** Soft cap for tree-sitter — anything larger renders as plain text. */
const MAX_HIGHLIGHT_CHARS = 64_000;

/** A single file's source content extracted from a read tool result. */
export interface HighlightedSource {
  path: string;
  content: string;
  lang: string;
}

export function extractReadSources(tc: ToolCall): HighlightedSource[] | null {
  if (tc.name !== "read") return null;
  if (!tc.result?.success || !tc.result.output) return null;

  const args = tc.args as { files?: unknown };
  const filesArg = Array.isArray(args.files) ? (args.files as Array<{ path?: unknown }>) : null;
  if (!filesArg || filesArg.length === 0) return null;

  // Single-file read — the whole result is one file's content.
  if (filesArg.length === 1) {
    const path = typeof filesArg[0]?.path === "string" ? filesArg[0].path : null;
    if (!path) return null;
    const lang = langFromPath(path);
    if (!lang) return null;
    return [{ path, content: stripReadLineNumbers(tc.result.output), lang }];
  }

  // Multi-file read — the formatter prefixes each file with `── path ──`.
  // Split on those markers and pair with the args order. Unknown-lang files
  // still render (plain) so the surrounding code-file siblings stay highlighted
  // and the layout doesn't collapse to a single plain-text blob.
  const sources = splitMultiFileOutput(tc.result.output);
  if (!sources) return null;

  const result: HighlightedSource[] = [];
  for (const { path: outPath, body } of sources) {
    const argPath = filesArg.find(
      (f) => typeof f?.path === "string" && (f.path === outPath || outPath.endsWith(f.path)),
    );
    const path = typeof argPath?.path === "string" ? argPath.path : outPath;
    const lang = langFromPath(path);
    result.push({ path, content: stripReadLineNumbers(body), lang });
  }
  return result.length > 0 ? result : null;
}

/** Read formatter prefixes each line with ` N  ` — strip when ≥ half the lines match. */
export function stripReadLineNumbers(output: string): string {
  const lines = output.split("\n");
  const stripped: string[] = [];
  const re = /^\s*\d+\s{2}(.*)$/;
  let matched = 0;
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      stripped.push(m[1] ?? "");
      matched++;
    } else {
      stripped.push(line);
    }
  }
  return matched > lines.length / 2 ? stripped.join("\n") : output;
}

/**
 * Split a multi-file read output. Returns null if the output doesn't look
 * like the multi-file format (no `── path ──` markers).
 */
function splitMultiFileOutput(output: string): Array<{ path: string; body: string }> | null {
  const marker = /^── (.+?) ──\s*$/gm;
  const matches: Array<{ path: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null = marker.exec(output);
  while (m !== null) {
    matches.push({ path: m[1] ?? "", start: m.index, end: m.index + m[0].length });
    m = marker.exec(output);
  }
  if (matches.length === 0) return null;
  const out: Array<{ path: string; body: string }> = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    if (!cur) continue;
    const next = matches[i + 1];
    const body = output.slice(cur.end, next ? next.start : output.length).replace(/^\n+|\n+$/g, "");
    out.push({ path: cur.path, body });
  }
  return out;
}

/** A code block rendered with the project's tree-sitter highlighter. */
export function HighlightedCode({ content, lang }: { content: string; lang: string }) {
  const syntaxStyle = getSyntaxStyle();
  const tsClient = getTSClient();
  if (content.length === 0) return null;
  const fenced = `\`\`\`${lang}\n${content}\n\`\`\``;
  return (
    <markdown content={fenced} syntaxStyle={syntaxStyle} treeSitterClient={tsClient} conceal />
  );
}

/**
 * Render the result body of a tool call with syntax highlighting when possible.
 * Falls back to plain text on errors, oversize bodies, or unrecognized formats.
 */
export function HighlightedToolResult({
  tc,
  fullResult,
  isError,
}: {
  tc: ToolCall;
  fullResult: string;
  isError: boolean;
}): ReactNode {
  const t = useTheme();
  if (isError || fullResult.length === 0) {
    return <text fg={isError ? t.error : t.textSecondary}>{fullResult}</text>;
  }
  const sources = extractReadSources(tc);
  if (!sources || sources.length === 0) {
    return <text fg={t.textSecondary}>{fullResult}</text>;
  }
  const total = sources.reduce((sum, s) => sum + s.content.length, 0);
  if (total > MAX_HIGHLIGHT_CHARS) {
    return <text fg={t.textSecondary}>{fullResult}</text>;
  }
  if (sources.length === 1) {
    const s = sources[0];
    if (!s) return <text fg={t.textSecondary}>{fullResult}</text>;
    return <HighlightedCode content={s.content} lang={s.lang} />;
  }
  return (
    <box flexDirection="column">
      {sources.map((s, i) => (
        <box key={s.path} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
          <text fg={t.textFaint} truncate>
            ── {s.path} ──
          </text>
          <HighlightedCode content={s.content} lang={s.lang} />
        </box>
      ))}
    </box>
  );
}
