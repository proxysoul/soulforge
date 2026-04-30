/** Core tools — always exposed to the model (schemas sent on every API call).
 *  Keep this minimal — every extra schema adds ~300 tokens per API roundtrip. */
export const CORE_TOOL_NAMES: string[] = [
  "read",
  "edit_file",
  "multi_edit",
  "grep",
  "glob",
  "shell",
  "project",
  "memory",
];

/** Tool catalog — name + one-liner for all tools. Used by /tools popup and request_tools listing. */
export const TOOL_CATALOG: Record<string, string> = {
  request_tools: "Let the agent load tools on demand (saves ~300 tokens/tool/call)",
  release_tools: "Let the agent unload tools it no longer needs",
  skills: "Let the agent search, install, and load skills from skills.sh",
  read: "Read file contents with optional line range or symbol target",
  edit_file: "Edit, create, or write files with line-anchored matching",
  multi_edit: "Apply multiple edits to one or more files atomically",
  undo_edit: "Undo recent edits to a file",
  grep: "Search file contents with regex patterns",
  glob: "Find files by glob pattern",
  shell: "Execute shell commands",
  project: "Auto-detected lint, format, test, build, typecheck across 23 ecosystems",
  dispatch: "Spawn parallel subagents for multi-file tasks",
  plan: "Create an implementation plan for large changes (7+ files)",
  update_plan_step: "Update a plan step's status during execution",
  ask_user: "Ask the user a question and wait for their response",
  navigate: "LSP symbol lookup: definitions, references, callers, type hierarchies",
  soul_find: "Fuzzy file and symbol search ranked by importance",
  soul_grep: "Token-efficient search with count mode and word-boundary matching",
  soul_analyze: "Codebase analysis: file profiles, dead code, packages, symbol queries",
  soul_impact: "Dependency graph: dependents, dependencies, cochanges, blast radius",
  soul_vision: "Display images and videos inline in chat (PNG, JPG, GIF, video files/URLs)",
  analyze: "LSP diagnostics, type info, outline, code actions on a file",
  discover_pattern: "Discover recurring patterns/conventions in the codebase",
  web_search: "Search the web for documentation, APIs, error messages",
  fetch_page: "Fetch and extract content from a URL",
  git: "Git operations: status, diff, log, commit, push, pull, stash, branch",
  list_dir: "List directory contents (supports multiple paths + recursive depth in one call)",
  rename_symbol: "Rename a symbol across all files (LSP-powered)",
  move_symbol: "Move a symbol between files with import updates",
  rename_file: "Rename/move a file with import path updates",
  refactor: "LSP code transforms: extract function/variable, format, organize imports",
  memory: "Read/write persistent memories across sessions",
  editor: "Open file in embedded Neovim editor",
  task_list: "Create and track tasks for the current session",
  ast_edit: "Surgical AST editing for TS/JS — prefer over edit_file/multi_edit",
};

/** Tool names allowed in restricted modes (architect, socratic, challenge).
 *  Read/analysis + memory + editor read — NO edit/shell/git/refactor.
 *  Used with activeTools to restrict without rebuilding the tool set. */
export const RESTRICTED_TOOL_NAMES: string[] = [
  "read",
  "grep",
  "glob",
  "soul_grep",
  "soul_find",
  "soul_analyze",
  "soul_impact",
  "list_dir",
  "web_search",
  "editor",
  "navigate",
  "analyze",
  "discover_pattern",
  "memory",
  "skills",
  "fetch_page",
  "ask_user",
  "plan",
  "update_plan_step",
];

/** Tools available during plan execution.
 *  Executor gets edit/shell/project + read (fallback if edit fails) + update_plan_step.
 *  No dispatch, explore, discover_pattern, web_search — the plan already contains everything. */
export const PLAN_EXECUTION_TOOL_NAMES: string[] = [
  "read",
  "edit_file",
  "undo_edit",
  "multi_edit",
  "task_list",
  "list_dir",
  "shell",
  "project",
  "grep",
  "glob",
  "navigate",
  "analyze",
  "git",
  "editor",
  "rename_symbol",
  "move_symbol",
  "rename_file",
  "refactor",
  "update_plan_step",
  "memory",
  "skills",
  "soul_grep",
  "soul_find",
  "soul_analyze",
  "soul_impact",
];

const SUBAGENT_MAX_LINES = 750;
const SUBAGENT_MAX_OUTPUT_BYTES = 8192;

export function truncateLines(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= SUBAGENT_MAX_LINES) return output;
  return `${lines.slice(0, SUBAGENT_MAX_LINES).join("\n")}\n\n... [${String(lines.length)} lines total — use startLine/endLine for specific sections]`;
}

export function truncateBytes(output: string): string {
  if (output.length <= SUBAGENT_MAX_OUTPUT_BYTES) return output;
  return `${output.slice(0, SUBAGENT_MAX_OUTPUT_BYTES)}\n\n... [output capped — narrow with glob or path params]`;
}

export function planFileName(sessionId?: string): string {
  return sessionId ? `plan-${sessionId}.md` : "plan.md";
}
