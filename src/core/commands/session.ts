import { emitCacheReset } from "../tools/file-events.js";
import { clearTasks } from "../tools/task-list.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

async function handleExportAll(ctx: CommandContext): Promise<void> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const exportDir = join(ctx.cwd, ".soulforge", "exports");
  mkdirSync(exportDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const outPath = join(exportDir, `diagnostic-${stamp}.json`);

  const activeModel = ctx.chat.activeModel;
  const systemPrompt = ctx.contextManager.buildSystemPrompt(activeModel);
  const coreMessages = ctx.chat.coreMessages;
  const chatMessages = ctx.chat.messages;
  const tokenUsage = ctx.chat.tokenUsage;
  const forgeMode = ctx.chat.forgeMode;
  const repoMapReady = ctx.contextManager.isRepoMapReady();

  const soulMapBlock = ctx.contextManager.buildSoulMapSnapshot(false);
  const skillsMessages = ctx.contextManager.buildSkillsMessages();

  const payload = {
    exportedAt: new Date().toISOString(),
    model: activeModel,
    mode: forgeMode,
    repoMapReady,
    tokenUsage,
    lastStep: {
      input: tokenUsage.lastStepInput,
      output: tokenUsage.lastStepOutput,
      cacheRead: tokenUsage.lastStepCacheRead,
    },
    systemPrompt,
    injectedMessages: {
      soulMap: soulMapBlock ? { systemBlock: soulMapBlock } : null,
      skills: skillsMessages
        ? { user: skillsMessages[0].content, assistant: skillsMessages[1].content }
        : null,
    },
    coreMessages,
    chatMessages: chatMessages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      toolCalls: m.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
        result: tc.result
          ? {
              success: tc.result.success,
              output: tc.result.output.slice(0, 2000),
              error: tc.result.error,
            }
          : undefined,
      })),
      segments: m.segments,
    })),
    messageCount: chatMessages.length,
    coreMessageCount: coreMessages.length,
    systemPromptLength: systemPrompt.length,
  };

  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");

  const relPath = outPath.startsWith(ctx.cwd) ? outPath.slice(ctx.cwd.length + 1) : outPath;
  sysMsg(
    ctx,
    `Diagnostic export → \`${relPath}\` (system prompt: ${String(Math.round(systemPrompt.length / 4))} tokens, ${String(coreMessages.length)} core messages, ${String(chatMessages.length)} chat messages)`,
  );
  const { dirname } = await import("node:path");
  Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", dirname(outPath)]);
}

async function handleExport(input: string, ctx: CommandContext): Promise<void> {
  const trimmed = input.trim();
  const arg = trimmed.replace(/^\/(session\s+)?export\s*/i, "").trim();

  if (arg === "all" || arg === "diagnostic") {
    await handleExportAll(ctx);
    return;
  }

  if (arg === "api") {
    const { isApiExportEnabled, setApiExportEnabled } = await import("../agents/step-utils.js");
    const newState = !isApiExportEnabled();
    setApiExportEnabled(newState);
    if (newState) {
      sysMsg(
        ctx,
        "API export **ON** — each agent step will dump full request data (messages, tools, usage) to `.soulforge/api-export/`. Run `/export api` again to disable.",
      );
    } else {
      sysMsg(ctx, "API export **OFF**.");
    }
    return;
  }

  if (arg === "clipboard" || arg === "clip") {
    const visibleCount = ctx.chat.messages.filter(
      (m) => m.role !== "system" || m.showInChat,
    ).length;
    if (visibleCount === 0) {
      sysMsg(ctx, "Nothing to export — chat is empty");
      return;
    }
    const { exportToClipboard } = await import("../sessions/export.js");
    const tabLabel = ctx.tabMgr.activeTab?.label ?? "chat";
    const result = exportToClipboard(ctx.chat.messages, tabLabel);
    if (!result.ok) {
      const hint =
        process.platform === "linux"
          ? " — install `wl-clipboard` (Wayland) or `xclip`/`xsel` (X11)"
          : "";
      sysMsg(ctx, `Clipboard backend unavailable${hint}`);
      return;
    }
    sysMsg(ctx, `Copied ${String(result.messageCount)} messages to clipboard (${result.format})`);
    return;
  }

  const format = arg === "json" ? "json" : "markdown";
  const outPath = arg && arg !== "json" && arg !== "md" && arg !== "markdown" ? arg : undefined;
  const { exportChat } = await import("../sessions/export.js");
  const tabLabel = ctx.tabMgr.activeTab?.label ?? "chat";
  const result = exportChat(ctx.chat.messages, { format, outPath, title: tabLabel, cwd: ctx.cwd });
  const relPath = result.path.startsWith(ctx.cwd)
    ? result.path.slice(ctx.cwd.length + 1)
    : result.path;
  sysMsg(ctx, `Exported ${String(result.messageCount)} messages → \`${relPath}\``);
  const { dirname } = await import("node:path");
  const dir = dirname(result.path);
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  Bun.spawn([opener, dir]);
}

function handlePlan(input: string, ctx: CommandContext): void {
  const trimmed = input.trim();
  const arg = trimmed.replace(/^\/(session\s+)?plan\s*/i, "").trim();
  if (arg) {
    ctx.chat.setPlanMode(true);
    ctx.chat.setPlanRequest(arg);
    sysMsg(ctx, `Plan mode enabled. Task: ${arg}`);
  } else {
    const newState = !ctx.chat.planMode;
    ctx.chat.setPlanMode(newState);
    if (!newState) ctx.chat.setPlanRequest(null);
    sysMsg(ctx, `Plan mode ${newState ? "enabled" : "disabled"}.`);
  }
}

function handleContinue(_input: string, ctx: CommandContext): void {
  if (ctx.chat.isLoading) {
    sysMsg(ctx, "Generation already in progress.");
  } else {
    ctx.chat.handleSubmit("Continue from where you left off.");
  }
}

function handleClear(_input: string, ctx: CommandContext): void {
  ctx.chat.setMessages([]);
  ctx.chat.setCoreMessages([]);
  ctx.chat.setTokenUsage({
    prompt: 0,
    completion: 0,
    total: 0,
    cacheRead: 0,
    cacheWrite: 0,
    subagentInput: 0,
    subagentOutput: 0,
    lastStepInput: 0,
    lastStepOutput: 0,
    lastStepCacheRead: 0,
    modelBreakdown: {},
  });
  ctx.chat.setMessageQueue([]);
  clearTasks(ctx.tabMgr.activeTabId);
  emitCacheReset();
  ctx.tabMgr.resetTabLabel(ctx.tabMgr.activeTabId);
}

function handleCompact(_input: string, ctx: CommandContext): void {
  ctx.chat.summarizeConversation();
}

function handleSessions(_input: string, ctx: CommandContext): void {
  ctx.openSessions();
}

function handleNew(_input: string, ctx: CommandContext): void {
  ctx.newSession();
}

async function handleRename(input: string, ctx: CommandContext): Promise<void> {
  const arg = input
    .trim()
    .replace(/^\/(session\s+)?rename\s*/i, "")
    .trim();
  if (!arg) {
    sysMsg(ctx, "Usage: /session rename <new title>");
    return;
  }
  const { SessionManager } = await import("../sessions/manager.js");
  const mgr = new SessionManager(ctx.cwd);
  if (mgr.renameSession(ctx.chat.sessionId, arg)) {
    ctx.chat.setCustomTitle(arg);
    sysMsg(ctx, `Session renamed to: ${arg}`);
  } else {
    sysMsg(ctx, "Could not rename session (not saved yet?).");
  }
}

export function register(map: Map<string, CommandHandler>): void {
  // Grouped commands
  map.set("/session", handleSessions);
  map.set("/session clear", handleClear);
  map.set("/session compact", handleCompact);
  map.set("/session continue", handleContinue);
  map.set("/session history", handleSessions);
  map.set("/session new", handleNew);
  map.set("/session rename", handleRename);
  map.set("/session export", handleExport);

  // Legacy aliases (backward compat)
  map.set("/clear", handleClear);
  map.set("/compact", handleCompact);
  map.set("/sessions", handleSessions);
  map.set("/continue", handleContinue);
  map.set("/rename", handleRename);
}

export function matchSessionPrefix(cmd: string): CommandHandler | null {
  if (cmd === "/session rename" || cmd.startsWith("/session rename ")) return handleRename;
  if (cmd === "/session export" || cmd.startsWith("/session export ")) return handleExport;
  if (cmd === "/session plan" || cmd.startsWith("/session plan ")) return handlePlan;
  // Legacy aliases
  if (cmd === "/export" || cmd.startsWith("/export ")) return handleExport;
  if (cmd === "/plan" || cmd.startsWith("/plan ")) return handlePlan;
  return null;
}
