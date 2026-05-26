/* ── Step definitions ──────────────────────────────────────────── */

export const STEPS = [
  "welcome",
  "setup",
  "intelligence",
  "editing",
  "modes",
  "workflow",
  "automation",
  "remote",
  "shortcuts",
  "theme",
  "ready",
] as const;
export type Step = (typeof STEPS)[number];

export const STEP_LABELS: Record<Step, string> = {
  welcome: "Welcome",
  setup: "Provider",
  intelligence: "Code Intel",
  editing: "Editing",
  modes: "Modes",
  workflow: "Tabs & Git",
  automation: "Automation",
  remote: "Remote",
  shortcuts: "Shortcuts",
  theme: "Theme",
  ready: "Ready",
};

export const STEP_ICONS: Record<Step, string> = {
  welcome: "ghost",
  setup: "key",
  intelligence: "brain",
  editing: "morph",
  modes: "plan",
  workflow: "tabs",
  automation: "dispatch",
  remote: "globe",
  shortcuts: "sparkle",
  theme: "gear",
  ready: "success",
};

export const STEP_BLURBS: Record<Step, string> = {
  welcome: "meet the forge",
  setup: "pick a provider",
  intelligence: "how Forge reads code",
  editing: "AST surgery & LSP",
  modes: "auto, plan, architect",
  workflow: "tabs · sessions · git",
  automation: "agents & compaction",
  remote: "MCP · skills · hearth",
  shortcuts: "keys & commands",
  theme: "make it yours",
  ready: "start forging",
};

/* ── Shortcut data ────────────────────────────────────────────── */

export const SHORTCUTS = [
  {
    section: "Most Used",
    items: [
      { keys: "Ctrl+K", desc: "Command palette — search all commands", slash: false },
      { keys: "Ctrl+L", desc: "Switch model", slash: false },
      { keys: "Ctrl+E", desc: "Toggle editor panel (Neovim)", slash: false },
      { keys: "Ctrl+G", desc: "Git menu", slash: false },
      { keys: "Ctrl+P", desc: "Browse sessions", slash: false },
      { keys: "Ctrl+S", desc: "Skills browser", slash: false },
      { keys: "Ctrl+T / W", desc: "New / close tab", slash: false },
      { keys: "Ctrl+D", desc: "Cycle mode", slash: false },
      { keys: "Ctrl+X", desc: "Abort generation", slash: false },
      { keys: "Ctrl+B / F", desc: "Browse prev / next checkpoint", slash: false },
    ],
  },
  {
    section: "Quick Commands",
    items: [
      { keys: "/help", desc: "All commands & shortcuts", slash: true },
      { keys: "/settings", desc: "Settings hub — all options in one place", slash: true },
      { keys: "/status", desc: "Live system dashboard", slash: true },
      { keys: "/keys", desc: "Manage API keys", slash: true },
      { keys: "/router", desc: "Route models per task slot", slash: true },
      { keys: "/wizard", desc: "Re-run this wizard", slash: true },
    ],
  },
] as const;

/* ── Intelligence step data ───────────────────────────────────── */

export const INTELLIGENCE_ITEMS = [
  {
    ic: "repomap",
    title: "Soul Map",
    cmd: "/repo-map",
    desc: "Live AST index — every file, symbol, import, with blast-radius ranking",
    bullets: [
      "Tree-sitter parses on launch, updates as you edit",
      "PageRank + git co-change surface the files that matter most",
      "33-language coverage — TS, Py, Rust, Go, Java, Swift, C/C++, and more",
    ],
  },
  {
    ic: "brain",
    title: "LSP Intelligence",
    cmd: "/lsp",
    desc: "Workspace rename, diagnostics, references, hover — compiler-verified",
    bullets: [
      "Mason installer inside the TUI — 576+ servers via /lsp install",
      "Call hierarchy, type hierarchy, code actions, format — all in-terminal",
    ],
  },
  {
    ic: "file",
    title: "Symbol Reads",
    cmd: "—",
    desc: "Forge reads one function by name, not the whole file",
    bullets: [
      "500-line file → 20 lines in the prompt",
      "Jumps via LSP go-to-definition instead of grep",
    ],
  },
] as const;

/* ── Editing step data ────────────────────────────────────────── */

export const EDITING_ITEMS = [
  {
    ic: "morph",
    title: "AST Edit",
    cmd: "ast_edit",
    desc: "Symbol-addressed edits for TypeScript & JavaScript via ts-morph",
    bullets: [
      "Toggle async, change a return type, add a method — a handful of tokens",
      "65+ ops: rename, set_type, add_statement, add_method, replace_in_body",
      "Atomic multi-op batches with all-or-nothing rollback",
    ],
  },
  {
    ic: "rename",
    title: "LSP Rename & Refactor",
    cmd: "rename_symbol · move_symbol",
    desc: "Workspace-wide renames, move symbol, extract function, organize imports",
    bullets: [
      "One tool call updates every import across every file",
      "Compiler-verified — if it typechecks, the rename is safe",
    ],
  },
  {
    ic: "edit",
    title: "Text Edits",
    cmd: "edit_file · multi_edit",
    desc: "Line-anchored edits for non-TS files (JSON, YAML, MD, Py, Rust, Go…)",
    bullets: [
      "multi_edit applies batched changes atomically with line-offset tracking",
      "Forge auto-picks the right tool for each file",
    ],
  },
] as const;

/* ── Modes step data ──────────────────────────────────────────── */

export const MODE_ITEMS = [
  {
    ic: "lightning",
    title: "Auto (default)",
    cmd: "/mode · Ctrl+D",
    desc: "Hands-free execution — Forge runs to completion without confirmations",
    bullets: [
      "Cycle with Ctrl+D or pick with /mode",
      "Destructive actions (rm, force push, reset) still prompt",
    ],
  },
  {
    ic: "plan",
    title: "Plan",
    cmd: "/session plan",
    desc: "Research-only — Forge investigates and drafts a plan, no edits",
    bullets: [
      "Review the plan, then flip back to auto to execute",
      "Ideal for large refactors before you commit",
    ],
  },
  {
    ic: "investigate",
    title: "Architect · Socratic · Challenge",
    cmd: "/mode",
    desc: "Read-only variants — design analysis, guided Q&A, adversarial review",
    bullets: [
      "architect: boundaries, tradeoffs, critical-files list",
      "socratic: tool-first investigation + concrete options",
      "challenge: evidence-based pushback on proposed approaches",
    ],
  },
] as const;

/* ── Workflow step data ───────────────────────────────────────── */

export const WORKFLOW_ITEMS = [
  {
    ic: "tabs",
    title: "Tabs",
    cmd: "Ctrl+T / Ctrl+W · /tab",
    desc: "Up to 5 tabs per project — each its own model, mode, session, checkpoints",
    bullets: [
      "Cross-tab file claims: edits never collide",
      "Git hard-blocks during cross-tab dispatch — no partial commits",
    ],
  },
  {
    ic: "checkpoint",
    title: "Sessions & Checkpoints",
    cmd: "Ctrl+P · Ctrl+B/F",
    desc: "Every turn is a checkpoint — resume, rewind, replay anytime",
    bullets: [
      "Sessions auto-save as JSONL under ~/.soulforge/sessions/",
      "Ctrl+B / Ctrl+F browse prev / next checkpoint (files + chat)",
    ],
  },
  {
    ic: "git",
    title: "Git Workflow",
    cmd: "Ctrl+G · /git",
    desc: "Full git from chat — commits, diffs, branches, stashes",
    bullets: [
      "Forge writes the commit message and runs lint + typecheck first",
      "Optional co-author trailer via /git co-author",
    ],
  },
  {
    ic: "memory",
    title: "Memory",
    cmd: "/memory",
    desc: "Persistent knowledge across sessions — project or global scope",
    bullets: ["Decisions, conventions, preferences Forge remembers and applies"],
  },
] as const;

/* ── Automation step data ─────────────────────────────────────── */

export const AUTOMATION_ITEMS = [
  {
    ic: "dispatch",
    title: "Parallel Agents",
    cmd: "dispatch tool",
    desc: "Forge fans out explore/code/web-search agents with a shared cache",
    bullets: [
      "One agent's file read is cached for the others",
      "Discoveries propagate across agents within a step",
    ],
  },
  {
    ic: "router",
    title: "Task Router",
    cmd: "/router",
    desc: "Different model per slot — spark, ember, compact, verify",
    bullets: [
      "Cheap model for exploration, strong model for code",
      "Mix providers freely — Haiku for search, Sonnet for edits",
    ],
  },
  {
    ic: "compress",
    title: "Compaction",
    cmd: "/compact",
    desc: "V2 extracts structured state live — serialization is instant",
    bullets: [
      "Usually no LLM pass — free compaction",
      "Auto-triggers on context pressure (configurable)",
    ],
  },
  {
    ic: "gear",
    title: "Agent Tuning",
    cmd: "/agent-features",
    desc: "De-sloppify, tier routing, auto-compact, auto-verify — toggle per project",
    bullets: ["/provider-settings — thinking budget, effort, speed, context window"],
  },
] as const;

/* ── Remote / extensions step data ────────────────────────────── */

export const REMOTE_ITEMS = [
  {
    ic: "mcp",
    title: "MCP Servers",
    cmd: "/mcp",
    desc: "Plug any Model Context Protocol server — GitHub, Sentry, databases",
    bullets: [
      "Add stdio / SSE / HTTP servers from the TUI",
      "Tools appear to Forge like built-ins",
    ],
  },
  {
    ic: "skills",
    title: "Skills",
    cmd: "Ctrl+S · /skills",
    desc: "Community plugins — domain expertise injected into the agent prompt",
    bullets: [
      "Browse & install from skills.sh — React, testing, SEO, and more",
      "Project-scoped or global; conditional loading for large packs",
    ],
  },
  {
    ic: "globe",
    title: "Hearth — Remote Control",
    cmd: "/hearth",
    desc: "Drive Forge from Telegram or Discord — your code never leaves your host",
    bullets: [
      "Approval prompts arrive as inline buttons on your phone",
      "Read-only mode available for safe browsing",
    ],
  },
  {
    ic: "web",
    title: "Web Search",
    cmd: "/web-search",
    desc: "Brave for results, Jina for page reads — both have generous free tiers",
    bullets: [
      "Brave Search API — 2k queries/mo free",
      "Jina Reader — 10M tokens/mo free for page content",
    ],
  },
] as const;

/* ── Welcome & ready content ──────────────────────────────────── */

export const WELCOME_BULLETS = [
  "Treats code as code, not text — AST edits, LSP rename, symbol reads",
  "Live Soul Map of your repo — every file, symbol, dependency, ranked",
  "Parallel agents with a shared cache for multi-file work",
  "Up to 5 tabs per project with cross-tab file claims",
  "36 themes · Neovim editor panel · Kitty inline images",
] as const;

export const QUICK_START = [
  '"rename AgentBus to CoordinationBus across the project"',
  '"move parseConfig from utils.ts to config/parser.ts"',
  '"add tests for the auth middleware"',
  '"run tests, fix lint, commit"',
  '"explain how the payment flow works"',
] as const;

/* ── Animation constants ──────────────────────────────────────── */

export const WELCOME_TITLE = "Welcome to SoulForge";
export const TYPEWRITER_MS = 45;
export const BLINK_COUNT = 4;
export const BLINK_MS = 300;
export const BLINK_INITIAL_MS = 400;

/* ── Layout constants ─────────────────────────────────────────── */

export const MAX_W = 120;
export const SIDEBAR_W = 22;
