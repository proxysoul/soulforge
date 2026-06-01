import { resolve } from "node:path";
import { getCwd } from "../../core/cwd.js";
import { classifyPath, type OutsideKind } from "../../core/security/outside-cwd.js";
import { getThemeTokens } from "../../core/theme/index.js";
import { canonicalizePath, isInsideCwd } from "../../core/utils/path-display.js";
import { SUBAGENT_NAMES } from "./ToolCallDisplay.js";

const ABS_PATH_RE = /(?:^|\s)(\/[\w./-]+)/g;

/** Type guard: narrows `unknown` to `Record<string, unknown>` without `as` cast */
function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Shorten absolute paths under the current working directory to relative form for display. */
function relPath(p: string): string {
  const cwd = getCwd();
  if (p === cwd) return ".";
  if (p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
  return p;
}

/** Format a read-tool file detail (ranges/full/symbol) for display. */
function formatReadDetail(f: { ranges?: unknown; target?: unknown; name?: unknown }): string {
  if (f.target && f.name) return `(${String(f.target)}:${String(f.name)})`;
  if (Array.isArray(f.ranges) && f.ranges.length > 0) {
    const rangeCount = f.ranges.length;
    const parts: string[] = [];
    let lineCount = 0;
    for (const r of f.ranges) {
      if (isObj(r) && typeof r.start === "number" && typeof r.end === "number") {
        parts.push(`L${String(r.start)}-${String(r.end)}`);
        lineCount += r.end - r.start + 1;
      }
    }
    if (rangeCount === 1 && parts[0]) return `(${parts[0]})`;
    const joined = parts.join(", ");
    // If listing each range fits, show them; otherwise summarize
    if (joined.length <= 30) return `(${String(rangeCount)} ranges: ${joined})`;
    return lineCount > 0
      ? `(${String(rangeCount)} ranges, ${String(lineCount)} lines)`
      : `(${String(rangeCount)} ranges)`;
  }
  return "(full)";
}

export function formatArgs(toolName: string, args?: string): string {
  if (!args) return "";
  try {
    const parsed: Record<string, unknown> = JSON.parse(args);
    if (toolName === "read") {
      const files = Array.isArray(parsed.files) ? parsed.files : parsed.files ? [parsed.files] : [];
      if (files.length === 0 && parsed.path) return relPath(String(parsed.path)); // legacy
      if (files.length === 1) {
        const f = files[0];
        const rel = relPath(String(f.path));
        const detail = formatReadDetail(f);
        // For symbol target, label already includes the name
        const baseLabel = f.target && f.name ? `${String(f.name)} in ${rel}` : rel;
        const trimmedBase = baseLabel.length > 50 ? `${baseLabel.slice(0, 47)}...` : baseLabel;
        // Symbol detail is already in the label — don't repeat it
        const suffix = f.target && f.name ? "" : ` ${detail}`;
        return `${trimmedBase}${suffix}`;
      }
      if (files.length > 1) {
        return `${String(files.length)} files`;
      }
      return "";
    }
    if (toolName === "edit_file" && parsed.path) return relPath(String(parsed.path));
    if (toolName === "multi_edit" && parsed.path) return relPath(String(parsed.path));
    if (toolName === "undo_edit" && parsed.path) return relPath(String(parsed.path));
    if (toolName === "ast_edit" && parsed.path) return relPath(String(parsed.path));
    if (toolName === "structural_edit" && parsed.file) return relPath(String(parsed.file));
    if (toolName === "list_dir" && parsed.path) {
      if (Array.isArray(parsed.path)) {
        const paths = parsed.path.map(String);
        const label = paths.join(", ");
        return label.length > 60 ? `${String(paths.length)} dirs` : label;
      }
      return String(parsed.path);
    }
    if (toolName === "rename_file") {
      if (parsed.from && parsed.to) {
        const label = `${String(parsed.from)} → ${String(parsed.to)}`;
        return label.length > 60 ? `${label.slice(0, 57)}...` : label;
      }
      if (parsed.from) return String(parsed.from);
    }
    if (toolName === "shell" && parsed.command) {
      const cmd = String(parsed.command);
      const codeExec = detectCodeExecution(cmd);
      if (codeExec) return codeExec.preview;
      return cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd;
    }
    if (toolName === "grep" && parsed.pattern) {
      const p = String(parsed.pattern);
      return p.length > 55 ? `${p.slice(0, 52)}...` : p;
    }
    if (toolName === "glob" && parsed.pattern) return String(parsed.pattern);
    if (toolName === "web_search" && parsed.query) {
      const q = String(parsed.query);
      return q.length > 50 ? `${q.slice(0, 47)}...` : q;
    }
    if (toolName === "memory" && parsed.action) {
      const action = String(parsed.action);
      if (action === "write" && parsed.summary) {
        const s = String(parsed.summary);
        const cat = parsed.category ? `[${String(parsed.category)}] ` : "";
        const label = `write: ${cat}${s}`;
        return label.length > 60 ? `${label.slice(0, 57)}...` : label;
      }
      if (action === "search" && parsed.query) {
        const q = String(parsed.query);
        return q.length > 50 ? `search: ${q.slice(0, 42)}...` : `search: ${q}`;
      }
      if (action === "list") {
        const filters: string[] = [];
        if (parsed.category) filters.push(String(parsed.category));
        if (parsed.topic) filters.push(`#${String(parsed.topic)}`);
        if (parsed.pinned) filters.push("pinned");
        return filters.length > 0 ? `list: ${filters.join(" ")}` : "list";
      }
      if (
        (action === "get" ||
          action === "delete" ||
          action === "restore" ||
          action === "pin" ||
          action === "unpin") &&
        parsed.id
      ) {
        const id = String(parsed.id);
        return `${action}: ${id.length > 8 ? id.slice(0, 8) : id}`;
      }
      return action;
    }
    if (toolName === "dispatch" && Array.isArray(parsed.tasks)) {
      const tasks: unknown[] = parsed.tasks;
      const roles = new Set(
        tasks.map((t) => {
          if (isObj(t)) return String(t.role ?? "explore");
          return "explore";
        }),
      );
      const roleTags = [...roles].map((r) => `[${r}]`).join("");
      if (tasks.length === 1 && tasks[0]) {
        const task0 = tasks[0];
        const taskStr = isObj(task0) ? String(task0.task ?? "") : "";
        const trimmed = taskStr.length > 45 ? `${taskStr.slice(0, 42)}...` : taskStr;
        return `${roleTags} ${trimmed}`;
      }
      const obj = parsed.objective ? String(parsed.objective) : `${String(tasks.length)} agents`;
      const label = parsed.objective ? `${String(tasks.length)} agents — ${obj}` : obj;
      const trimmed = label.length > 55 ? `${label.slice(0, 52)}...` : label;
      return `${roleTags} ${trimmed}`;
    }
    if (toolName === "editor" && parsed.action) {
      if (parsed.action === "read" && parsed.startLine)
        return `read lines ${String(parsed.startLine)}-${String(parsed.endLine ?? "end")}`;
      if (parsed.action === "edit" && parsed.startLine)
        return `edit lines ${String(parsed.startLine)}-${String(parsed.endLine)}`;
      if (parsed.action === "navigate") {
        if (parsed.file) return String(parsed.file);
        if (parsed.search) return `/${String(parsed.search)}/`;
        if (parsed.line) return `line ${String(parsed.line)}`;
      }
      if (parsed.action === "rename" && parsed.newName) return `rename → ${String(parsed.newName)}`;
      return String(parsed.action);
    }
    if (toolName === "update_plan_step" && parsed.stepId) {
      return `${String(parsed.stepId)} → ${String(parsed.status ?? "")}`;
    }
    if (toolName === "ask_user" && parsed.question) {
      const q = String(parsed.question);
      return q.length > 50 ? `${q.slice(0, 47)}...` : q;
    }
    // read target/path handled above in the files array handler
    if (toolName === "navigate") {
      const parts = [parsed.action, parsed.symbol, parsed.file].filter(Boolean).map(String);
      const label = parts.join(" ");
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "analyze") {
      const parts = [parsed.action, parsed.symbol ?? parsed.file].filter(Boolean).map(String);
      const label = parts.join(" ");
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "rename_symbol") {
      const label = `${String(parsed.symbol ?? "")} → ${String(parsed.newName ?? "")}`;
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "refactor") {
      const parts = [parsed.action, parsed.symbol].filter(Boolean).map(String);
      const label = parts.join(" ");
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "project") {
      const parts = [parsed.action, parsed.file].filter(Boolean).map(String);
      const label = parts.join(" ");
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "move_symbol") {
      const label = `${String(parsed.symbol ?? "")} → ${String(parsed.to ?? "")}`;
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "discover_pattern" && parsed.query) {
      return String(parsed.query);
    }
    if (toolName === "write_plan" || toolName === "plan") {
      if (parsed.title) return String(parsed.title);
      return "plan";
    }
    if (toolName === "git" && parsed.action) {
      if (parsed.action === "commit" && parsed.message) {
        const m = String(parsed.message);
        return m.length > 50 ? `${m.slice(0, 47)}...` : m;
      }
      if (parsed.action === "log" && parsed.count) return `log last ${String(parsed.count)}`;
      if (parsed.action === "diff") return parsed.staged ? "diff staged" : "diff";
      if (parsed.action === "stash") return `stash ${String(parsed.sub_action ?? "push")}`;
      if (parsed.action === "branch") return `branch ${String(parsed.sub_action ?? "list")}`;
      return String(parsed.action);
    }
    if (toolName === "skills" && parsed.action) {
      if (parsed.action === "search" && parsed.query) return `search: ${String(parsed.query)}`;
      if (parsed.action === "load" && parsed.name) return `load: ${String(parsed.name)}`;
      if (parsed.action === "unload" && parsed.name) return `unload: ${String(parsed.name)}`;
      if (parsed.action === "install" && parsed.id) {
        const id = String(parsed.id);
        return id.length > 50 ? `install: ${id.slice(0, 47)}...` : `install: ${id}`;
      }
      return String(parsed.action);
    }
    if (toolName === "soul_grep" && parsed.pattern) {
      const p = String(parsed.pattern);
      return p.length > 55 ? `${p.slice(0, 52)}...` : p;
    }
    if (toolName === "soul_find" && parsed.query) {
      const q = String(parsed.query);
      return q.length > 50 ? `${q.slice(0, 47)}...` : q;
    }
    if (
      (toolName === "soul_impact" || toolName === "soul_analyze") &&
      (parsed.action || parsed.file)
    ) {
      const parts = [parsed.action, parsed.file ?? parsed.symbol].filter(Boolean).map(String);
      const label = parts.join(" ");
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "code_execution") {
      if (parsed.code) {
        const code = String(parsed.code);
        const awaitCount = (code.match(/\bawait\s+/g) ?? []).length;
        if (awaitCount > 0) return `${String(awaitCount)} tools in the furnace`;
        return code.length > 50 ? `${code.slice(0, 47)}...` : code;
      }
      if (parsed.command) {
        const cmd = String(parsed.command);
        return cmd.length > 50 ? `${cmd.slice(0, 47)}...` : cmd;
      }
    }
  } catch {
    // Partial JSON during streaming — extract path/pattern/query eagerly
    const pathMatch = args.match(/"(?:path|file|from)"\s*:\s*"([^"]+)"/);
    if (pathMatch?.[1]) return pathMatch[1];
    const patternMatch = args.match(/"(?:pattern|query|command)"\s*:\s*"([^"]+)"/);
    if (patternMatch?.[1]) {
      const v = patternMatch[1];
      return v.length > 50 ? `${v.slice(0, 47)}...` : v;
    }
  }
  return "";
}

export interface MultiReadFile {
  path: string;
  /** e.g. "(2 ranges)" or "(full)" or "(fn:foo)" */
  detail: string;
}

/**
 * Extract file info from a multi-file read tool call's args.
 * Returns per-file path + detail (ranges/full/target) when 2+ files.
 * Works with both parsed args (Record) and raw JSON string.
 */
export function extractMultiReadFiles(
  toolName: string,
  args?: Record<string, unknown> | string,
): MultiReadFile[] | null {
  if (toolName !== "read") return null;
  try {
    const parsed: Record<string, unknown> =
      typeof args === "string" ? JSON.parse(args) : (args ?? {});
    const files = Array.isArray(parsed.files) ? parsed.files : parsed.files ? [parsed.files] : [];
    if (files.length < 2) return null;
    const result: MultiReadFile[] = [];
    for (const f of files) {
      if (!isObj(f) || typeof f.path !== "string") continue;
      result.push({ path: f.path, detail: formatReadDetail(f) });
    }
    return result.length >= 2 ? result : null;
  } catch {
    return null;
  }
}

export function formatResult(toolName: string, result?: string): string {
  if (!result) return "";
  try {
    const p: Record<string, unknown> = JSON.parse(result);
    if (p.repoMapHit && p.output) {
      const out = String(p.output);
      const match = out.match(/indexed at ([^\s]+)/);
      return match?.[1] ? match[1] : out.slice(0, 40);
    }
    if (p.output && typeof p.output === "string" && p.output.startsWith("[from dispatch cache]")) {
      const lines = p.output.split("\n").length - 1;
      return `${String(lines)} lines [cached]`;
    }
  } catch {}
  // Read tool — show line count, not file content
  if (toolName === "read") {
    try {
      const p = JSON.parse(result);
      if (p.success && p.output) {
        const lines = String(p.output).split("\n").filter(Boolean).length;
        return `${String(lines)} lines`;
      }
      if (p.error) {
        const msg = String(p.error);
        return msg.length > 30 ? `${msg.slice(0, 27)}...` : msg;
      }
    } catch {}
  }
  // Soul tools — extract structured counts from output text
  if (toolName === "soul_impact" || toolName === "soul_analyze") {
    try {
      const p = JSON.parse(result);
      if (p.success && p.output) {
        const out = String(p.output);
        const parts: string[] = [];
        // soul_impact: extract dependency/blast counts
        const depMatch = out.match(/Dependents \((\d+)\)/);
        const depsMatch = out.match(/Dependencies \((\d+)\)/);
        const coMatch = out.match(/Co-changes \((\d+)\)/);
        const blastMatch = out.match(/Blast radius: (\d+)/);
        if (depMatch) parts.push(`${depMatch[1]} dependents`);
        if (depsMatch) parts.push(`${depsMatch[1]} deps`);
        if (coMatch) parts.push(`${coMatch[1]} cochanges`);
        if (blastMatch) parts.push(`blast: ${blastMatch[1]}`);
        // soul_analyze: extract action-specific counts
        const deadMatch = out.match(/Dead files? \((\d+)\)/i);
        const unusedMatch = out.match(/(\d+) unused/i);
        const dupMatch = out.match(/(\d+) (?:exact |near-)?duplicat/i);
        const topMatch = out.match(/Top (\d+) files/);
        const pkgMatch = out.match(/(\d+) packages?/i);
        if (deadMatch) parts.push(`${deadMatch[1]} dead`);
        if (unusedMatch) parts.push(`${unusedMatch[1]} unused`);
        if (dupMatch) parts.push(`${dupMatch[1]} duplicates`);
        if (topMatch) parts.push(`top ${topMatch[1]}`);
        if (pkgMatch) parts.push(`${pkgMatch[1]} packages`);
        if (parts.length > 0) return parts.slice(0, 3).join(", ");
        // Fallback: first line
        const first = out.split("\n")[0] ?? "";
        return first.length > 50 ? `${first.slice(0, 47)}...` : first;
      }
    } catch {}
  }
  if (toolName === "soul_grep" || toolName === "grep") {
    try {
      const p = JSON.parse(result);
      if (p.success && p.output) {
        const out = String(p.output);
        if (out === "No matches found." || out === "0 matches.") return "0 hits";
        // Count mode: "N matches across M files"
        const countMatch = out.match(/^(\d+) matches? across (\d+) files?/);
        if (countMatch) {
          const hits = countMatch[1];
          const files = countMatch[2];
          return `${hits} hit${hits === "1" ? "" : "s"} in ${files} file${files === "1" ? "" : "s"}`;
        }
        // Search mode: count `path:line:content` lines
        const hitLines = out.split("\n").filter((line) => /^[^\s].*:\d+:/.test(line)).length;
        if (hitLines > 0) return `${String(hitLines)} hit${hitLines === 1 ? "" : "s"}`;
        // Fallback
        return "0 hits";
      }
    } catch {}
  }
  if (toolName === "glob") {
    try {
      const p = JSON.parse(result);
      if (p.success && p.output) {
        const out = String(p.output).trim();
        if (!out) return "0 hits";
        const fileCount = out.split("\n").filter(Boolean).length;
        return `${String(fileCount)} file${fileCount === 1 ? "" : "s"}`;
      }
    } catch {}
  }
  if (toolName === "soul_find") {
    try {
      const p = JSON.parse(result);
      if (p.success && p.output) {
        const out = String(p.output);
        const countMatch = out.match(/(\d+) results?/);
        if (countMatch) return `${countMatch[1]} result${countMatch[1] === "1" ? "" : "s"}`;
      }
    } catch {}
  }
  if (toolName === "navigate") {
    try {
      const p = JSON.parse(result);
      if (p.success && p.output) {
        const out = String(p.output);
        // Call hierarchy
        const inMatch = out.match(/Incoming calls \((\d+)\)/);
        const outMatch = out.match(/Outgoing calls \((\d+)\)/);
        if (inMatch || outMatch) {
          const parts: string[] = [];
          if (inMatch) parts.push(`${inMatch[1]} callers`);
          if (outMatch) parts.push(`${outMatch[1]} callees`);
          return parts.join(", ");
        }
        // References
        const refMatch = out.match(/(\d+) references?/);
        if (refMatch) return `${refMatch[1]} references`;
        // Definition
        const defMatch = out.match(/defined at (.+)/);
        if (defMatch?.[1]) return defMatch[1].slice(0, 40);
      }
      if (p.repoMapHit) {
        const out = String(p.output ?? "");
        const match = out.match(/indexed at ([^\s]+)/);
        return match ? String(match[1]) : "repo map";
      }
    } catch {}
  }
  if (toolName === "skills") {
    try {
      const p = JSON.parse(result);
      if (p.success && p.output) {
        const out = String(p.output);
        const skillMatch = out.match(/Skills matching "[^"]*" \((\d+) total/);
        if (skillMatch) return `${skillMatch[1]} skills found`;
        const first = out.split("\n")[0] ?? "";
        return first.length > 50 ? `${first.slice(0, 47)}...` : first;
      }
    } catch {}
  }
  if (SUBAGENT_NAMES.has(toolName)) {
    try {
      const p: Record<string, unknown> = JSON.parse(result);
      if (p.success === false && p.error) return String(p.error).slice(0, 50);
      if (Array.isArray(p.reads) || Array.isArray(p.filesEdited)) {
        const parts: string[] = [];
        if (Array.isArray(p.reads)) {
          const reads: unknown[] = p.reads;
          const paths = new Set(reads.map((r) => (isObj(r) ? String(r.path) : "")));
          if (paths.size > 0) parts.push(`${String(paths.size)} files read`);
        }
        if (Array.isArray(p.filesEdited) && p.filesEdited.length > 0)
          parts.push(`${String(p.filesEdited.length)} edited`);
        return parts.join(", ") || "";
      }
    } catch {}
    return "";
  }
  if (toolName === "code_execution") {
    try {
      let obj = JSON.parse(result);
      // Unwrap {success, output} wrapper from TEXT_OUTPUT
      if (obj.output && typeof obj.output === "string") {
        try {
          obj = JSON.parse(obj.output);
        } catch {}
      }
      if (obj.type === "code_execution_result" || obj.type === "bash_code_execution_result") {
        if (obj.return_code !== 0) return "the metal cracked";
        const out = String(obj.stdout ?? "");
        const lines = out.split("\n").filter(Boolean).length;
        return lines > 0 ? `${String(lines)} lines forged` : "cooled";
      }
    } catch {}
    const lines = result.split("\n").length;
    if (lines > 1) return `${String(lines)} lines forged`;
    return result.length > 40 ? `${result.slice(0, 37)}...` : result;
  }
  try {
    const parsed: Record<string, unknown> = JSON.parse(result);
    if (parsed.output) {
      const out = String(parsed.output);
      // Use first line for multi-line output (e.g. edit results with post-edit diagnostics)
      const firstLine = out.split("\n")[0] ?? out;
      return firstLine.length > 40 ? `${firstLine.slice(0, 37)}...` : firstLine;
    }
    if (parsed.error) return String(parsed.error).slice(0, 50);
    if (parsed.branch !== undefined) {
      const parts = [String(parsed.branch)];
      const counts: string[] = [];
      if (Array.isArray(parsed.staged) && parsed.staged.length > 0)
        counts.push(`${String(parsed.staged.length)} staged`);
      if (Array.isArray(parsed.modified) && parsed.modified.length > 0)
        counts.push(`${String(parsed.modified.length)} modified`);
      if (Array.isArray(parsed.untracked) && parsed.untracked.length > 0)
        counts.push(`${String(parsed.untracked.length)} untracked`);
      if (counts.length > 0) parts.push(counts.join(", "));
      else if (parsed.isDirty === false) parts.push("clean");
      return parts.join(" · ");
    }
    if (parsed.ok !== undefined) {
      const label = parsed.ok ? "ok" : "failed";
      if (parsed.output) {
        const firstLine = String(parsed.output).split("\n")[0] ?? "";
        const out = firstLine.length > 30 ? `${firstLine.slice(0, 27)}...` : firstLine;
        return out ? `${label} · ${out}` : label;
      }
      return label;
    }
  } catch {
    // fallback
  }
  // Don't show raw JSON like {"success": true} — the ✓/✗ icon + file path is enough
  try {
    const p: Record<string, unknown> = JSON.parse(result);
    if (p.success !== undefined && !p.output && !p.error) return "";
  } catch {}
  const lines = result.split("\n").length;
  if (lines > 3) return `${String(lines)} lines`;
  return result.length > 40 ? `${result.slice(0, 37)}...` : result;
}

/**
 * Path-bearing arg keys per tool. Only these values are scanned for
 * out-of-cwd classification — scanning every string value causes false
 * positives when tools carry code/regex/URL content (e.g. ast_edit.newCode,
 * edit_file.oldString/newString) that happens to start with "/".
 */
const PATH_ARG_KEYS: Record<string, readonly string[]> = {
  read: ["path"],
  edit_file: ["path"],
  multi_edit: ["path"],
  undo_edit: ["path"],
  list_dir: ["path"],
  rename_file: ["from", "to"],
  rename_symbol: ["file"],
  move_symbol: ["from", "to"],
  ast_edit: ["path"],
  structural_edit: ["file"],
  navigate: ["file"],
  analyze: ["file"],
  refactor: ["file"],
  project: ["file"],
  discover_pattern: ["file"],
  soul_grep: ["path"],
  soul_find: ["path"],
  soul_impact: ["file"],
  soul_analyze: ["file"],
  grep: ["path"],
  glob: ["path"],
};

function checkPath(p: string): OutsideKind | null {
  if (!p) return null;
  if (!p.startsWith("/") && !p.startsWith("~")) return null;
  const resolved = resolve(p);
  if (isInsideCwd(resolved, getCwd())) return null;
  return classifyPath(canonicalizePath(resolved), getCwd());
}

export function detectOutsideCwd(toolName: string, args?: string): OutsideKind | null {
  if (!args) return null;
  try {
    const parsed: Record<string, unknown> = JSON.parse(args);

    // read tool: files[].path
    if (toolName === "read") {
      const files = Array.isArray(parsed.files) ? parsed.files : parsed.files ? [parsed.files] : [];
      for (const f of files) {
        if (isObj(f) && typeof f.path === "string") {
          const kind = checkPath(f.path);
          if (kind) return kind;
        }
      }
      if (typeof parsed.path === "string") {
        const kind = checkPath(parsed.path);
        if (kind) return kind;
      }
      return null;
    }

    // Tool-specific path keys
    const keys = PATH_ARG_KEYS[toolName];
    if (keys) {
      for (const key of keys) {
        const val = parsed[key];
        if (typeof val === "string") {
          const kind = checkPath(val);
          if (kind) return kind;
        } else if (Array.isArray(val)) {
          for (const v of val) {
            if (typeof v === "string") {
              const kind = checkPath(v);
              if (kind) return kind;
            }
          }
        }
      }
    }

    // shell: extract absolute paths from the command string
    if (toolName === "shell" && typeof parsed.command === "string") {
      for (const match of parsed.command.matchAll(ABS_PATH_RE)) {
        const p = match[1];
        if (p) {
          const kind = checkPath(p);
          if (kind) return kind;
        }
      }
    }
  } catch {}
  return null;
}

export const OUTSIDE_BADGE: Record<OutsideKind, { label: string; color: string }> = {
  get outside() {
    return { label: "outside", color: getThemeTokens().warning };
  },
  get config() {
    return { label: "config", color: getThemeTokens().textSecondary };
  },
  get tmp() {
    return { label: "tmp", color: getThemeTokens().textSecondary };
  },
};

// Language-agnostic code execution detection for shell commands.
// Matches: node -e, bun -e, deno eval, python -c, python3 -c, ruby -e, perl -e, etc.
const CODE_EXEC_RE =
  /^(?:node|bun|deno|tsx|ts-node|python3?|ruby|perl|lua|php|swift)\s+(?:-[ec]|eval)\s+/;

const RUNTIME_LABELS: Record<string, string> = {
  node: "node",
  bun: "bun",
  deno: "deno",
  tsx: "tsx",
  "ts-node": "ts-node",
  python: "python",
  python3: "python",
  ruby: "ruby",
  perl: "perl",
  lua: "lua",
  php: "php",
  swift: "swift",
};

interface CodeExecInfo {
  runtime: string;
  code: string;
  preview: string;
}

export function detectCodeExecution(command: string): CodeExecInfo | null {
  const trimmed = command.trim();
  if (!CODE_EXEC_RE.test(trimmed)) return null;

  const runtime = trimmed.split(/\s/)[0] ?? "";
  const label = RUNTIME_LABELS[runtime] ?? runtime;

  // Extract code from -e "..." / -c '...' / eval "..."
  const codeMatch = trimmed.match(/\s-[ec]\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/);
  const evalMatch = !codeMatch ? trimmed.match(/\seval\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/) : null;
  const code = codeMatch?.[1] ?? codeMatch?.[2] ?? evalMatch?.[1] ?? evalMatch?.[2] ?? "";

  const firstLine = code.split("\\n")[0] ?? code;
  const preview =
    firstLine.length > 50 ? `${label}: ${firstLine.slice(0, 47)}...` : `${label}: ${firstLine}`;

  return { runtime: label, code, preview };
}
