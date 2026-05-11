import { matchCheckpointPrefix, register as registerCheckpoint } from "./checkpoint.js";
import { matchClaimsPrefix, register as registerClaims } from "./claims.js";
import { register as registerCodex } from "./codex.js";
import { matchConfigPrefix, register as registerConfig } from "./config.js";
import { matchContextPrefix, register as registerContext } from "./context.js";
import { register as registerDebug } from "./debug.js";
import { matchGitPrefix, register as registerGit } from "./git.js";
import { register as registerHearth } from "./hearth.js";
import { register as registerHooks } from "./hooks.js";
import { matchNavPrefix, register as registerNavigation } from "./navigation.js";
import { register as registerProxy } from "./proxy.js";
import { matchSecurityPrefix, register as registerSecurity } from "./security.js";
import { matchSessionPrefix, register as registerSession } from "./session.js";
import { register as registerStorage } from "./storage.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { register as registerUiDemo } from "./ui-demo.js";
import { sysMsg } from "./utils.js";

const commandMap = new Map<string, CommandHandler>();

registerGit(commandMap);
registerConfig(commandMap);
registerSession(commandMap);
registerContext(commandMap);
registerDebug(commandMap);
registerNavigation(commandMap);
registerProxy(commandMap);
registerStorage(commandMap);
registerSecurity(commandMap);
registerClaims(commandMap);
registerCodex(commandMap);
registerHearth(commandMap);
registerHooks(commandMap);
registerCheckpoint(commandMap);
registerUiDemo(commandMap);

const prefixMatchers = [
  matchContextPrefix,
  matchGitPrefix,
  matchConfigPrefix,
  matchSessionPrefix,
  matchNavPrefix,
  matchSecurityPrefix,
  matchClaimsPrefix,
  matchCheckpointPrefix,
];

function resolveHandler(cmd: string): CommandHandler | null {
  const exact = commandMap.get(cmd);
  if (exact) return exact;

  for (const matcher of prefixMatchers) {
    const handler = matcher(cmd);
    if (handler) return handler;
  }

  return null;
}

export async function handleCommand(input: string, ctx: CommandContext): Promise<void> {
  const trimmed = input.trim();
  const cmd = trimmed.split(" ")[0]?.toLowerCase() ?? "";

  // Multi-word exact matches (e.g. "/proxy status", "/git stash pop")
  const twoWord = trimmed.toLowerCase().split(" ").slice(0, 2).join(" ");
  const threeWord = trimmed.toLowerCase().split(" ").slice(0, 3).join(" ");

  const handler =
    resolveHandler(threeWord) ??
    resolveHandler(twoWord) ??
    resolveHandler(trimmed.toLowerCase()) ??
    resolveHandler(cmd);

  if (handler) {
    try {
      await handler(input, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sysMsg(ctx, `Command error: ${msg}`);
    }
    return;
  }

  sysMsg(ctx, `Unknown command: ${cmd}. Type /help for available commands.`);
}

/** Command definitions for autocomplete — single source of truth */
export interface CommandDef {
  cmd: string;
  ic: string;
  desc: string;
  category: string;
  tags?: string[];
  hidden?: boolean;
}

export const CATEGORIES = [
  "Session",
  "Git",
  "Models",
  "Intelligence",
  "Settings",
  "Editor",
  "Tabs",
  "System",
] as const;

const COMMAND_DEFS: CommandDef[] = [
  // ── Session ──
  {
    cmd: "/compact",
    ic: "compress",
    desc: "Compact — run, settings, logs",
    category: "Session",
    tags: ["context", "summarize", "compaction"],
  },
  {
    cmd: "/compact logs",
    ic: "plan",
    desc: "View compaction events",
    category: "Session",
    tags: ["debug", "logs"],
  },
  {
    cmd: "/compact settings",
    ic: "compress",
    desc: "Compaction strategy & pruning settings",
    category: "Session",
    tags: ["v1", "v2", "pruning"],
  },
  {
    cmd: "/session",
    ic: "clock_alt",
    desc: "Session — history, clear, export, compact",
    category: "Session",
    tags: ["history", "restore", "manage"],
  },
  {
    cmd: "/session clear",
    ic: "clear",
    desc: "Clear chat history",
    category: "Session",
    tags: ["reset"],
  },
  {
    cmd: "/session compact",
    ic: "compress",
    desc: "Compact conversation context",
    category: "Session",
    tags: ["context", "summarize"],
    hidden: true,
  },
  {
    cmd: "/session continue",
    ic: "play",
    desc: "Continue interrupted generation",
    category: "Session",
    tags: ["resume"],
  },
  {
    cmd: "/session export",
    ic: "changes",
    desc: "Export chat — markdown, json, clipboard, all",
    category: "Session",
    tags: ["save", "markdown", "json", "clipboard", "diagnostic"],
  },
  {
    cmd: "/session export all",
    ic: "search",
    desc: "Full diagnostic export (system prompt, messages, tools)",
    category: "Session",
    tags: ["debug"],
  },
  {
    cmd: "/session export api",
    ic: "search",
    desc: "Toggle per-step API request dump",
    category: "Session",
    tags: ["debug", "tokens", "cost"],
  },
  {
    cmd: "/session export clipboard",
    ic: "changes",
    desc: "Copy chat to clipboard (markdown)",
    category: "Session",
    tags: ["copy"],
  },
  {
    cmd: "/session export json",
    ic: "changes",
    desc: "Export chat as JSON",
    category: "Session",
    tags: ["save"],
  },
  {
    cmd: "/session history",
    ic: "clock_alt",
    desc: "Browse & restore sessions",
    category: "Session",
    tags: ["history", "restore"],
  },
  {
    cmd: "/session new",
    ic: "add",
    desc: "Start a new session (saves current)",
    category: "Session",
    tags: ["new", "fresh", "reset"],
  },
  {
    cmd: "/session rename",
    ic: "edit",
    desc: "Rename current session",
    category: "Session",
    tags: ["rename", "title", "name"],
  },
  {
    cmd: "/session plan",
    ic: "plan",
    desc: "Toggle plan mode (research & plan only)",
    category: "Session",
    tags: ["architect", "research"],
  },

  // ── Git ──
  { cmd: "/git", ic: "git", desc: "Git menu", category: "Git", tags: ["menu"] },
  {
    cmd: "/git branch",
    ic: "git",
    desc: "Show/create branch",
    category: "Git",
    tags: ["checkout"],
  },
  {
    cmd: "/git co-author",
    ic: "git",
    desc: "Toggle co-author trailer",
    category: "Git",
    tags: ["commit"],
  },
  {
    cmd: "/git commit",
    ic: "git",
    desc: "Git commit with message",
    category: "Git",
    tags: ["save"],
  },
  { cmd: "/git diff", ic: "git", desc: "Open diff in editor", category: "Git", tags: ["changes"] },
  {
    cmd: "/git init",
    ic: "git",
    desc: "Initialize git repo",
    category: "Git",
    tags: ["create"],
  },
  { cmd: "/git lazygit", ic: "git", desc: "Launch lazygit", category: "Git", tags: ["tui"] },
  { cmd: "/git log", ic: "git", desc: "Show recent commits", category: "Git", tags: ["history"] },
  {
    cmd: "/git pull",
    ic: "git",
    desc: "Pull from remote",
    category: "Git",
    tags: ["fetch", "sync"],
  },
  {
    cmd: "/git push",
    ic: "git",
    desc: "Push to remote",
    category: "Git",
    tags: ["sync", "upload"],
  },
  {
    cmd: "/git stash",
    ic: "git",
    desc: "Stash changes — pop to restore",
    category: "Git",
    tags: ["save", "pop", "restore"],
  },
  {
    cmd: "/git stash pop",
    ic: "git",
    desc: "Pop latest stash",
    category: "Git",
    tags: ["restore"],
  },
  { cmd: "/git status", ic: "git", desc: "Git status", category: "Git", tags: ["info"] },

  // ── Models ──
  {
    cmd: "/keys",
    ic: "cog",
    desc: "Manage LLM provider API keys",
    category: "Models",
    tags: ["api", "auth"],
  },
  {
    cmd: "/codex",
    ic: "model",
    desc: "Show Codex login status",
    category: "Models",
    tags: ["codex", "auth", "status", "account"],
  },
  {
    cmd: "/codex login",
    ic: "model",
    desc: "Log in to Codex with your ChatGPT subscription",
    category: "Models",
    tags: ["codex", "auth", "oauth", "browser", "chatgpt"],
  },
  {
    cmd: "/codex logout",
    ic: "model",
    desc: "Log out of the current Codex account",
    category: "Models",
    tags: ["codex", "auth", "logout", "account"],
  },
  {
    cmd: "/codex switch",
    ic: "model",
    desc: "Switch to a different Codex account",
    category: "Models",
    tags: ["codex", "auth", "switch", "account"],
  },
  {
    cmd: "/codex status",
    ic: "model",
    desc: "Show Codex login status",
    category: "Models",
    tags: ["codex", "auth", "status", "account"],
  },
  {
    cmd: "/model-scope",
    ic: "cog",
    desc: "Set model scope (project/global)",
    category: "Models",
    tags: ["config"],
  },
  {
    cmd: "/models",
    ic: "system",
    desc: "Switch LLM model (Ctrl+L)",
    category: "Models",
    tags: ["provider", "llm", "switch"],
  },
  {
    cmd: "/provider-settings",
    ic: "system",
    desc: "Provider options — thinking, effort, speed, context",
    category: "Models",
    tags: ["thinking", "effort", "speed", "config"],
  },
  {
    cmd: "/providers",
    ic: "system",
    desc: "Provider & Models",
    category: "Models",
    tags: ["llm", "switch"],
    hidden: true,
  },
  {
    cmd: "/proxy",
    ic: "proxy",
    desc: "Proxy — status, install, start, stop, restart, login, upgrade",
    category: "Models",
    tags: ["account", "login", "logout", "install", "upgrade", "start", "stop", "restart"],
  },
  {
    cmd: "/proxy install",
    ic: "proxy",
    desc: "Reinstall CLIProxyAPI",
    category: "Models",
    tags: ["setup"],
  },
  {
    cmd: "/proxy login",
    ic: "proxy",
    desc: "Add a provider account",
    category: "Models",
    tags: ["auth", "oauth"],
  },
  {
    cmd: "/proxy logout",
    ic: "proxy",
    desc: "Remove a provider account",
    category: "Models",
    tags: ["auth"],
  },
  {
    cmd: "/proxy restart",
    ic: "proxy",
    desc: "Restart the proxy",
    category: "Models",
    tags: ["reboot"],
  },
  {
    cmd: "/proxy start",
    ic: "proxy",
    desc: "Start the proxy",
    category: "Models",
    tags: ["launch"],
  },
  {
    cmd: "/proxy status",
    ic: "proxy",
    desc: "Proxy status & accounts",
    category: "Models",
    tags: ["info"],
  },
  {
    cmd: "/proxy stop",
    ic: "proxy",
    desc: "Stop the proxy",
    category: "Models",
    tags: ["kill"],
  },
  {
    cmd: "/proxy upgrade",
    ic: "proxy",
    desc: "Upgrade to latest version",
    category: "Models",
    tags: ["update"],
  },
  {
    cmd: "/router",
    ic: "router",
    desc: "Route models per task (code, explore, plan, verify)",
    category: "Models",
    tags: ["dispatch", "routing"],
  },
  {
    cmd: "/web-search",
    ic: "cog",
    desc: "Web search keys & settings",
    category: "Models",
    tags: ["search", "api"],
  },
  {
    cmd: "/mcp",
    ic: "mcp",
    desc: "MCP servers — status, tools, reconnect",
    category: "Models",
    tags: ["mcp", "servers", "tools", "protocol"],
  },

  // ── Intelligence ──
  {
    cmd: "/context",
    ic: "context",
    desc: "Context & system dashboard",
    category: "Intelligence",
    tags: ["tokens", "budget", "status"],
  },
  {
    cmd: "/context clear",
    ic: "context",
    desc: "Clear injected context (memory, skills)",
    category: "Intelligence",
    tags: ["reset"],
    hidden: true,
  },
  {
    cmd: "/diagnose",
    ic: "brain",
    desc: "Health check — LSP, tree-sitter, semantic indexing",
    category: "Intelligence",
    tags: ["health", "debug", "probe"],
  },
  {
    cmd: "/lsp",
    ic: "brain",
    desc: "Manage LSP servers — install, disable, enable",
    category: "Intelligence",
    tags: ["language", "server", "mason", "disable"],
  },
  {
    cmd: "/lsp install",
    ic: "brain",
    desc: "Install & manage LSP servers (Mason registry)",
    category: "Intelligence",
    tags: ["mason", "install", "search"],
  },
  {
    cmd: "/lsp restart",
    ic: "brain",
    desc: "Restart LSP servers (all or specific)",
    category: "Intelligence",
    tags: ["restart"],
  },
  {
    cmd: "/lsp status",
    ic: "brain",
    desc: "LSP status dashboard",
    category: "Intelligence",
    tags: ["language", "server"],
  },
  {
    cmd: "/memory",
    ic: "memory",
    desc: "Manage memory scopes, view & clear",
    category: "Intelligence",
    tags: ["recall", "knowledge"],
  },
  {
    cmd: "/repo-map",
    ic: "tree",
    desc: "Soul map settings (AST index)",
    category: "Intelligence",
    tags: ["semantic", "treesitter"],
  },
  {
    cmd: "/skills",
    ic: "skills",
    desc: "Browse & install skills",
    category: "Intelligence",
    tags: ["plugins", "extensions"],
  },
  {
    cmd: "/tools",
    ic: "search",
    desc: "Enable/disable tools for the agent",
    category: "Intelligence",
    tags: ["tools", "enable", "disable", "toggle"],
  },

  // ── Settings ──
  {
    cmd: "/agent-features",
    ic: "cog",
    desc: "Toggle agent features (de-sloppify, tier routing)",
    category: "Settings",
    tags: ["config", "desloppify", "routing", "verify"],
  },
  {
    cmd: "/chat-style",
    ic: "chat",
    desc: "Toggle chat layout style",
    category: "Settings",
    tags: ["accent", "bubble", "ui"],
  },
  {
    cmd: "/diff-style",
    ic: "git",
    desc: "Change diff display style",
    category: "Settings",
    tags: ["sidebyside", "compact"],
  },
  {
    cmd: "/font",
    ic: "pencil",
    desc: "Terminal font — show, set, nerd",
    category: "Settings",
    tags: ["nerd", "terminal"],
  },
  {
    cmd: "/font nerd",
    ic: "ghost",
    desc: "Toggle Nerd Font icons",
    category: "Settings",
    tags: ["icons", "terminal"],
  },
  {
    cmd: "/font set",
    ic: "pencil",
    desc: "Set terminal font",
    category: "Settings",
    tags: ["nerd", "terminal"],
  },
  {
    cmd: "/instructions",
    ic: "system",
    desc: "Toggle instruction files (SOULFORGE.md, CLAUDE.md, etc.)",
    category: "Settings",
    tags: ["prompt", "config"],
  },
  {
    cmd: "/mode",
    ic: "cog",
    desc: "Switch forge mode",
    category: "Settings",
    tags: ["architect", "socratic", "challenge", "plan", "auto"],
  },
  {
    cmd: "/nvim-config",
    ic: "pencil",
    desc: "Switch neovim config mode",
    category: "Settings",
    tags: ["editor", "neovim"],
  },
  {
    cmd: "/reasoning",
    ic: "brain",
    desc: "Show or hide reasoning content",
    category: "Settings",
    tags: ["thinking", "display"],
  },
  {
    cmd: "/settings",
    ic: "cog",
    desc: "Settings hub — all options in one place",
    category: "Settings",
    tags: ["config", "preferences", "hub"],
  },
  {
    cmd: "/theme",
    ic: "palette",
    desc: "Switch color theme (live preview)",
    category: "Settings",
    tags: ["color", "dark", "light", "catppuccin", "dracula", "nord", "gruvbox", "solarized"],
  },
  {
    cmd: "/verbose",
    ic: "cog",
    desc: "Toggle verbose tool output",
    category: "Settings",
    tags: ["debug", "output"],
  },
  {
    cmd: "/lock-in",
    ic: "ghost",
    desc: "Toggle lock-in mode — hide narration, show tools + final answer",
    category: "Settings",
    tags: ["focus", "quiet", "narration", "shush"],
  },
  {
    cmd: "/vim-hints",
    ic: "pencil",
    desc: "Toggle vim keybinding hints",
    category: "Settings",
    tags: ["editor", "keybindings"],
  },

  // ── Editor ──
  {
    cmd: "/editor",
    ic: "pencil",
    desc: "Editor — toggle, open, settings, split",
    category: "Editor",
    tags: ["neovim", "toggle"],
  },
  {
    cmd: "/editor open",
    ic: "changes",
    desc: "Open file in editor",
    category: "Editor",
    tags: ["file"],
  },
  {
    cmd: "/editor settings",
    ic: "cog",
    desc: "Toggle editor/LSP integrations",
    category: "Editor",
    tags: ["config", "lsp"],
  },
  {
    cmd: "/editor split",
    ic: "pencil",
    desc: "Cycle editor/chat split (40/50/60/70)",
    category: "Editor",
    tags: ["layout", "resize"],
  },

  // ── Tabs ──
  {
    cmd: "/changes",
    ic: "changes",
    desc: "Toggle files changed this session",
    category: "Tabs",
    tags: ["files", "diff", "modified"],
  },
  {
    cmd: "/claim",
    ic: "lock",
    desc: "Show active file claims across tabs",
    category: "Tabs",
    tags: ["lock"],
  },
  {
    cmd: "/claim force",
    ic: "lock",
    desc: "Steal a file claim from another tab",
    category: "Tabs",
    tags: ["lock"],
  },
  {
    cmd: "/claim release",
    ic: "lock",
    desc: "Release a file claim from current tab",
    category: "Tabs",
    tags: ["lock"],
  },
  {
    cmd: "/claim release-all",
    ic: "lock",
    desc: "Release all claims from current tab",
    category: "Tabs",
    tags: ["lock"],
  },
  {
    cmd: "/tab",
    ic: "tabs",
    desc: "Tabs — switch, new, close, rename",
    category: "Tabs",
    tags: ["switch", "list"],
  },
  {
    cmd: "/tab close",
    ic: "tabs",
    desc: "Close current tab (Ctrl+W)",
    category: "Tabs",
    tags: ["remove"],
  },
  {
    cmd: "/tab new",
    ic: "tabs",
    desc: "Open new tab (Ctrl+T)",
    category: "Tabs",
    tags: ["create"],
  },
  {
    cmd: "/tab rename",
    ic: "pencil",
    desc: "Rename current tab",
    category: "Tabs",
    tags: ["label"],
  },
  {
    cmd: "/terminals",
    ic: "terminal",
    desc: "Terminal manager — new, close, show, hide, rename",
    category: "Tabs",
    tags: ["shell", "term", "pty", "terminal"],
  },
  {
    cmd: "/terminals close",
    ic: "terminal",
    desc: "Close a terminal",
    category: "Tabs",
    tags: ["kill"],
  },
  {
    cmd: "/terminals hide",
    ic: "terminal",
    desc: "Hide terminal panel",
    category: "Tabs",
    tags: ["close"],
  },
  {
    cmd: "/terminals new",
    ic: "terminal",
    desc: "Spawn a new terminal",
    category: "Tabs",
    tags: ["create", "shell"],
  },
  {
    cmd: "/terminals rename",
    ic: "terminal",
    desc: "Rename a terminal",
    category: "Tabs",
    tags: ["label"],
  },
  {
    cmd: "/terminals show",
    ic: "terminal",
    desc: "Show terminal panel",
    category: "Tabs",
    tags: ["open"],
  },

  // ── System ──
  {
    cmd: "/errors",
    ic: "error",
    desc: "Browse error log",
    category: "System",
    tags: ["debug", "log"],
  },
  {
    cmd: "/help",
    ic: "help",
    desc: "Command palette (Ctrl+K)",
    category: "System",
    tags: ["commands", "search"],
  },
  {
    cmd: "/privacy",
    ic: "lock",
    desc: "Manage forbidden file patterns",
    category: "System",
    tags: ["security", "forbidden"],
  },
  {
    cmd: "/hooks",
    ic: "cog",
    desc: "View active hooks (PreToolUse, PostToolUse, etc.)",
    category: "System",
    tags: ["hooks", "claude", "lifecycle"],
  },
  { cmd: "/quit", ic: "quit", desc: "Exit SoulForge", category: "System", tags: ["exit", "close"] },
  { cmd: "/exit", ic: "quit", desc: "Exit SoulForge", category: "System", tags: ["quit", "close"] },
  { cmd: "/restart", ic: "ghost", desc: "Full restart", category: "System", tags: ["reboot"] },
  {
    cmd: "/setup",
    ic: "ghost",
    desc: "Check & install prerequisites",
    category: "System",
    tags: ["install", "check"],
  },
  {
    cmd: "/status",
    ic: "info",
    desc: "System status dashboard",
    category: "System",
    tags: ["info", "health", "context", "tokens"],
  },
  {
    cmd: "/storage",
    ic: "system",
    desc: "View & manage storage usage",
    category: "System",
    tags: ["disk", "cleanup"],
  },
  {
    cmd: "/update",
    ic: "ghost",
    desc: "Check for SoulForge updates",
    category: "System",
    tags: ["upgrade", "version"],
  },
  {
    cmd: "/wizard",
    ic: "ghost",
    desc: "Re-run the first-run setup wizard",
    category: "System",
    tags: ["onboarding", "setup", "welcome"],
  },
  {
    cmd: "/timeouts",
    ic: "clock",
    desc: "Configure tool and watchdog timeouts",
    category: "System",
    tags: ["timeout", "shell", "agent", "watchdog", "stall"],
  },

  // ── Session (Checkpoints) ──
  {
    cmd: "/checkpoint",
    ic: "bookmark",
    desc: "Browse checkpoints — undo, redo, save",
    category: "Session",
    tags: ["undo", "redo", "history", "revert"],
  },
  {
    cmd: "/checkpoint undo",
    ic: "bookmark",
    desc: "Undo last checkpoint (revert files)",
    category: "Session",
    tags: ["revert", "rollback"],
  },
  {
    cmd: "/checkpoint redo",
    ic: "bookmark",
    desc: "Redo last undone checkpoint",
    category: "Session",
    tags: ["restore"],
  },
  {
    cmd: "/checkpoint save",
    ic: "bookmark",
    desc: "Force save current state as git tag",
    category: "Session",
    tags: ["git", "tag", "snapshot"],
  },
  {
    cmd: "/checkpoint live",
    ic: "bookmark",
    desc: "Back to live view",
    category: "Session",
    tags: ["browse"],
  },
];

const HEARTH_COMMAND_DEFS: CommandDef[] = [
  {
    cmd: "/hearth",
    ic: "network",
    desc: "[experimental] Hearth — open settings (surfaces, daemon, pairings, logs)",
    category: "System",
    tags: ["remote", "telegram", "discord", "settings"],
  },
  {
    cmd: "/hearth settings",
    ic: "network",
    desc: "[experimental] Open the Hearth settings dashboard",
    category: "System",
    tags: ["remote", "ui", "panel"],
  },
  {
    cmd: "/hearth status",
    ic: "network",
    desc: "[experimental] Hearth daemon + surface health",
    category: "System",
    tags: ["remote", "status"],
  },
  {
    cmd: "/hearth login",
    ic: "key",
    desc: "[experimental] Store a Hearth bot token in keychain",
    category: "System",
    tags: ["telegram", "discord", "auth"],
  },
  {
    cmd: "/hearth pair",
    ic: "key",
    desc: "[experimental] Mint a Hearth pairing code for a surface",
    category: "System",
    tags: ["pair", "code"],
  },
  {
    cmd: "/hearth bind",
    ic: "link",
    desc: "[experimental] Bind the active tab to a Hearth chat (Telegram/Discord)",
    category: "System",
    tags: ["bind", "telegram", "mirror"],
  },
  {
    cmd: "/hearth unbind",
    ic: "link",
    desc: "[experimental] Clear all active Hearth tab ↔ chat bindings",
    category: "System",
    tags: ["unbind"],
  },
  {
    cmd: "/hearth docs",
    ic: "book",
    desc: "[experimental] Open Hearth documentation",
    category: "System",
    tags: ["help", "docs"],
  },
];

const DEV_COMMAND_DEFS: CommandDef[] = [
  {
    cmd: "/ui-demo",
    ic: "gear",
    desc: "Preview UI primitives (dev only — SOULFORGE_DEV_UI=1)",
    category: "System",
    tags: ["dev", "ui", "preview"],
    hidden: true,
  },
];

export function getCommandDefs(): CommandDef[] {
  const defs = [...COMMAND_DEFS, ...HEARTH_COMMAND_DEFS];
  if (process.env.SOULFORGE_DEV_UI === "1") defs.push(...DEV_COMMAND_DEFS);
  return defs;
}

export type { CommandContext, CommandHandler };
