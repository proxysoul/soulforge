import type { InfoPopupLine } from "../../components/modals/InfoPopup.js";
import {
  getGitDiff,
  getGitLog,
  getGitStatus,
  gitInit,
  gitPull,
  gitPush,
  gitStash,
  gitStashPop,
} from "../git/status.js";
import { icon } from "../icons.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

function handleGitInit(_input: string, ctx: CommandContext): void {
  gitInit(ctx.cwd).then((ok) => {
    ctx.refreshGit();
    sysMsg(ctx, ok ? "Initialized git repository." : "Failed to initialize git repository.");
  });
}

async function handleBranchCreate(input: string, ctx: CommandContext): Promise<void> {
  const branchName = input
    .trim()
    .replace(/^\/git\s+branch\s+/i, "")
    .trim();
  if (!branchName) return;
  const { spawn } = await import("node:child_process");
  const { SAFE_STDIO, buildSafeEnv } = await import("../spawn.js");
  const proc = spawn("git", ["checkout", "-b", branchName], {
    cwd: ctx.cwd,
    env: buildSafeEnv(),
    stdio: SAFE_STDIO,
  });
  const chunks: string[] = [];
  proc.stdout?.on("data", (d: Buffer) => chunks.push(d.toString()));
  proc.stderr?.on("data", (d: Buffer) => chunks.push(d.toString()));
  proc.on("close", (code) => {
    ctx.refreshGit();
    sysMsg(ctx, code === 0 ? `Switched to new branch '${branchName}'` : chunks.join("").trim());
  });
}

function handleCoAuthorCommits(input: string, ctx: CommandContext): void {
  const trimmed = input.trim();
  const arg = trimmed
    .replace(/^\/git\s+co-author\s*/i, "")
    .trim()
    .toLowerCase();
  const patch = (v: string) => ({ coAuthorCommits: v === "enable" });

  const applyCoAuthor = (enabled: boolean, scope?: string) => {
    ctx.chat.setCoAuthorCommits(enabled);
    ctx.saveToScope(
      patch(enabled ? "enable" : "disable"),
      (scope as "project" | "global") ?? "project",
    );
    sysMsg(ctx, `Co-author commits ${enabled ? "enabled" : "disabled"} (${scope ?? "project"}).`);
  };

  if (arg === "enable" || arg === "on") {
    applyCoAuthor(true);
  } else if (arg === "disable" || arg === "off") {
    applyCoAuthor(false);
  } else {
    ctx.openCommandPicker({
      title: "Co-Author Commits",
      icon: icon("git"),
      currentValue: ctx.chat.coAuthorCommits ? "enable" : "disable",
      scopeEnabled: true,
      initialScope: ctx.detectScope("coAuthorCommits"),
      options: [
        {
          value: "enable",
          label: "Enable",
          description: "add co-author trailer on AI-assisted commits",
        },
        { value: "disable", label: "Disable", description: "no co-author trailer on commits" },
      ],
      onSelect: (value, scope) => applyCoAuthor(value === "enable", scope),
      onScopeMove: (value, from, to) => {
        ctx.chat.setCoAuthorCommits(value === "enable");
        ctx.saveToScope(patch(value), to, from);
      },
    });
  }
}

function handleCommit(_input: string, ctx: CommandContext): void {
  ctx.openGitCommit();
}

function handleDiff(_input: string, ctx: CommandContext): void {
  getGitDiff(ctx.cwd).then(async (diff) => {
    if (!diff) {
      sysMsg(ctx, "No unstaged changes.");
      return;
    }
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpPath = join(tmpdir(), `soulforge-diff-${Date.now()}.diff`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(tmpPath, diff);
    ctx.openEditorWithFile(tmpPath);
    sysMsg(ctx, "Diff opened in editor.");
  });
}

function handleGitStatus(_input: string, ctx: CommandContext): void {
  getGitStatus(ctx.cwd).then((status) => {
    if (!status.isRepo) {
      sysMsg(ctx, "Not a git repository. Use /git init to initialize.");
      return;
    }
    const lines: InfoPopupLine[] = [
      {
        type: "entry",
        label: "Branch",
        desc: status.branch ?? "(detached)",
        descColor: getThemeTokens().brandAlt,
      },
      { type: "spacer" },
      {
        type: "entry",
        label: "Staged",
        desc: String(status.staged.length),
        descColor: status.staged.length > 0 ? getThemeTokens().success : getThemeTokens().textMuted,
      },
      {
        type: "entry",
        label: "Modified",
        desc: String(status.modified.length),
        descColor:
          status.modified.length > 0 ? getThemeTokens().warning : getThemeTokens().textMuted,
      },
      {
        type: "entry",
        label: "Untracked",
        desc: String(status.untracked.length),
        descColor:
          status.untracked.length > 0
            ? getThemeTokens().brandSecondary
            : getThemeTokens().textMuted,
      },
    ];
    if (status.ahead > 0)
      lines.push({
        type: "entry",
        label: "Ahead",
        desc: String(status.ahead),
        descColor: getThemeTokens().success,
      });
    if (status.behind > 0)
      lines.push({
        type: "entry",
        label: "Behind",
        desc: String(status.behind),
        descColor: getThemeTokens().warning,
      });
    if (status.staged.length > 0) {
      lines.push({ type: "spacer" }, { type: "header", label: "Staged Files" });
      for (const f of status.staged)
        lines.push({ type: "text", label: `  ${f}`, color: getThemeTokens().success });
    }
    if (status.modified.length > 0) {
      lines.push({ type: "spacer" }, { type: "header", label: "Modified Files" });
      for (const f of status.modified)
        lines.push({ type: "text", label: `  ${f}`, color: getThemeTokens().warning });
    }
    if (status.untracked.length > 0) {
      lines.push({ type: "spacer" }, { type: "header", label: "Untracked Files" });
      for (const f of status.untracked)
        lines.push({ type: "text", label: `  ${f}`, color: getThemeTokens().brandSecondary });
    }
    ctx.openInfoPopup({ title: "Git Status", icon: icon("git"), lines });
  });
}

function handleBranch(_input: string, ctx: CommandContext): void {
  getGitStatus(ctx.cwd).then((status) => {
    sysMsg(
      ctx,
      status.branch ? `Current branch: ${status.branch}` : "Not on a branch (detached HEAD)",
    );
  });
}

function handleGitMenu(_input: string, ctx: CommandContext): void {
  ctx.openGitMenu();
}

function handleLazygit(_input: string, ctx: CommandContext): void {
  ctx.handleSuspend({ command: "lazygit" });
}

function runGitOp(
  ctx: CommandContext,
  fn: (cwd: string) => Promise<{ ok: boolean; output: string }>,
  loading: string,
  success: string,
  failPrefix: string,
): void {
  sysMsg(ctx, loading);
  fn(ctx.cwd).then((result) => {
    sysMsg(ctx, result.ok ? success : `${failPrefix}: ${result.output}`);
    ctx.refreshGit();
  });
}

function handlePush(_input: string, ctx: CommandContext): void {
  runGitOp(ctx, gitPush, "Pushing...", "Push complete.", "Push failed");
}

function handlePull(_input: string, ctx: CommandContext): void {
  runGitOp(ctx, gitPull, "Pulling...", "Pull complete.", "Pull failed");
}

function handleStash(_input: string, ctx: CommandContext): void {
  runGitOp(ctx, gitStash, "", "Changes stashed.", "Stash failed");
}

function handleStashPop(_input: string, ctx: CommandContext): void {
  runGitOp(ctx, gitStashPop, "", "Stash popped.", "Stash pop failed");
}

function handleLog(_input: string, ctx: CommandContext): void {
  getGitLog(ctx.cwd, 20).then((entries) => {
    if (entries.length === 0) {
      sysMsg(ctx, "No commits found.");
    } else {
      const popupLines: InfoPopupLine[] = entries.map((e) => ({
        type: "entry" as const,
        label: e.hash,
        desc: `${e.subject} (${e.date})`,
        color: getThemeTokens().warning,
      }));
      ctx.openInfoPopup({
        title: "Git Log",
        icon: icon("git"),
        lines: popupLines,
        width: 78,
        labelWidth: 10,
      });
    }
  });
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/git", handleGitMenu);
  map.set("/git init", handleGitInit);
  map.set("/git commit", handleCommit);
  map.set("/git diff", handleDiff);
  map.set("/git status", handleGitStatus);
  map.set("/git branch", handleBranch);
  map.set("/git lazygit", handleLazygit);
  map.set("/git push", handlePush);
  map.set("/git pull", handlePull);
  map.set("/git stash", handleStash);
  map.set("/git stash pop", handleStashPop);
  map.set("/git log", handleLog);
}

export function matchGitPrefix(cmd: string): CommandHandler | null {
  if (cmd.startsWith("/git branch ")) return handleBranchCreate;
  if (cmd === "/git co-author" || cmd.startsWith("/git co-author ")) return handleCoAuthorCommits;
  return null;
}
