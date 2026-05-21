import { relative } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getWorkspaceCoordinator } from "../coordination/WorkspaceCoordinator.js";
import {
  getGitDiff,
  getGitLog,
  getGitStatus,
  gitAdd,
  gitBlame,
  gitCherryPick,
  gitCommit,
  gitCreateBranch,
  gitPull,
  gitPush,
  gitRebase,
  gitReset,
  gitRestore,
  gitShow,
  gitStash,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashShow,
  gitSwitchBranch,
  gitTag,
  gitUnstage,
  run,
} from "../git/status.js";
import { memoryHintComposite } from "../memory/hints.js";
import { truncateWithTee } from "./tee.js";

const cwd = process.cwd();
const MAX_GIT_OUTPUT = 32_000;

async function capGitOutput(output: string, label: string): Promise<string> {
  if (output.length <= MAX_GIT_OUTPUT) return output;
  const { text } = await truncateWithTee(output, MAX_GIT_OUTPUT, 10_000, 10_000, `git-${label}`);
  return text;
}

function getOtherTabClaimWarning(tabId?: string): string | null {
  if (!tabId) return null;
  const coordinator = getWorkspaceCoordinator();
  const editors = coordinator.getActiveEditors();
  const lines: string[] = [];
  for (const [tid] of editors) {
    if (tid === tabId) continue;
    const tabClaims = coordinator.getClaimsForTab(tid);
    if (tabClaims.size === 0) continue;
    let tabLabel = "Unknown";
    const paths: string[] = [];
    for (const [absPath, claim] of tabClaims) {
      tabLabel = claim.tabLabel;
      paths.push(relative(cwd, absPath) || absPath);
    }
    const shown = paths.slice(0, 5);
    const extra = paths.length > 5 ? ` (+${String(paths.length - 5)} more)` : "";
    lines.push(`  Tab "${tabLabel}": ${shown.join(", ")}${extra}`);
  }
  if (lines.length === 0) return null;
  return `⚠️ Other tabs have active file claims:\n${lines.join("\n")}`;
}

type GitAction =
  | "status"
  | "diff"
  | "log"
  | "commit"
  | "push"
  | "pull"
  | "stash"
  | "branch"
  | "show"
  | "unstage"
  | "restore"
  | "stage"
  | "tag"
  | "cherry_pick"
  | "rebase"
  | "reset"
  | "blame";

interface GitArgs {
  action: GitAction;
  staged?: boolean;
  count?: number;
  message?: string;
  body?: string;
  footer?: string;
  files?: string[];
  sub_action?: string;
  name?: string;
  index?: number;
  amend?: boolean;
  ref?: string;
  file?: string;
  mode?: string;
  startLine?: number;
  endLine?: number;
  flags?: string[];
}

export const gitTool = {
  name: "git" as const,
  description:
    "Git operations: status, diff, log, commit (with amend), push, pull, stash, branch, show (view commit), unstage, restore, stage, tag, cherry_pick, rebase, reset, blame. Use flags for extra git args (e.g. diff with ['main..HEAD', '--stat'], log with ['--graph', '--all']).",
  execute: async (args: GitArgs, tabId?: string): Promise<ToolResult> => {
    const destructive =
      args.action === "commit" ||
      args.action === "stash" ||
      args.action === "restore" ||
      args.action === "reset" ||
      args.action === "cherry_pick" ||
      args.action === "rebase" ||
      (args.action === "branch" && args.sub_action === "switch");

    if (destructive && tabId) {
      const coordinator = getWorkspaceCoordinator();
      const activeTabs = coordinator.getTabsWithActiveAgents(tabId);
      if (activeTabs.length > 0) {
        const tabNames = activeTabs.map((t) => `"${t}"`).join(", ");
        return {
          success: false,
          output: `BLOCKED: Tab ${tabNames} has dispatch agents actively editing files. Your edits are saved to disk. Inform the user the ${args.action} is pending — do not attempt again.`,
          error: "active dispatch",
        };
      }
    }

    const claimWarning = destructive ? getOtherTabClaimWarning(tabId) : null;

    let result: ToolResult;
    switch (args.action) {
      case "status":
        result = await execStatus();
        break;
      case "diff":
        result = await execDiff(args.staged, args.flags);
        break;
      case "log":
        result = await execLog(args.count, args.flags);
        break;
      case "commit": {
        let msg = args.message ?? "";
        if (args.body) msg += `\n\n${args.body}`;
        if (args.footer) msg += `\n\n${args.footer}`;
        result = await execCommit(msg, args.files, args.amend);
        break;
      }
      case "push":
        result = await execPush(args.flags);
        break;
      case "pull":
        result = await execPull(args.flags);
        break;
      case "stash":
        result = await execStash(args.sub_action, args.message, args.index);
        break;
      case "branch":
        result = await execBranch(args.sub_action, args.name, args.flags);
        break;
      case "show":
        result = await execShow(args.ref, args.flags);
        break;
      case "unstage":
        result = await execUnstage(args.files);
        break;
      case "restore":
        result = await execRestore(args.files);
        break;
      case "stage":
        result = await execStage(args.files);
        break;
      case "tag":
        result = await execTag(args.sub_action, args.name, args.message, args.ref);
        break;
      case "cherry_pick":
        result = await execCherryPick(args.ref, args.flags);
        break;
      case "rebase":
        result = await execRebase(args.sub_action, args.ref, args.flags);
        break;
      case "reset":
        result = await execReset(args.ref, args.mode, args.files);
        break;
      case "blame":
        result = await execBlame(args.file, args.startLine, args.endLine);
        break;
      default:
        result = {
          success: false,
          output: `Unknown action: ${String(args.action)}`,
          error: "bad action",
        };
    }

    // Reset diff cache after any action that changes the working tree
    if (
      result.success &&
      args.action !== "status" &&
      args.action !== "diff" &&
      args.action !== "log" &&
      args.action !== "show"
    ) {
      resetDiffCache();
    }

    if (claimWarning && result.success) {
      result = { ...result, output: `${claimWarning}\n\n${result.output}` };
    }

    // Memory hints — additive tail. Never throws, never blocks the result.
    if (result.success) {
      try {
        let hint = "";
        if (args.action === "diff" || args.action === "show") {
          const paths = extractDiffPaths(result.output);
          hint = memoryHintComposite({
            paths,
            topics: ["git", args.action],
            context: "git_diff",
            tabId,
          });
        } else if (args.action === "status") {
          hint = memoryHintComposite({
            topics: ["git", "commit", "status"],
            context: "git_status",
            tabId,
          });
        } else if (args.action === "commit") {
          hint = memoryHintComposite({
            topics: ["git", "commit", "conventional-commits"],
            context: "git_commit",
            tabId,
          });
        } else if (
          args.action === "log" ||
          args.action === "blame" ||
          args.action === "push" ||
          args.action === "pull" ||
          args.action === "rebase" ||
          args.action === "cherry_pick" ||
          args.action === "reset"
        ) {
          hint = memoryHintComposite({
            topics: ["git", args.action],
            context: "git_other",
            tabId,
          });
        }
        if (hint) result = { ...result, output: `${result.output}${hint}` };
      } catch {}
    }

    if (args.action === "commit" && result.success && tabId) {
      const coordinator = getWorkspaceCoordinator();
      const myClaims = coordinator.getClaimsForTab(tabId);
      if (myClaims.size > 0) {
        const paths = [...myClaims.keys()].map((p) => relative(cwd, p) || p);
        result = {
          ...result,
          output: `${result.output}\n\nFiles you edited this session: ${paths.join(", ")}`,
        };
      }
    }

    return result;
  },
};

async function execStatus(): Promise<ToolResult> {
  const s = await getGitStatus(cwd);
  if (!s.isRepo) return { success: false, output: "Not a git repository", error: "not a repo" };
  const lines = [`Branch: ${s.branch ?? "detached"}`];
  if (s.staged.length > 0)
    lines.push(`Staged (${String(s.staged.length)}): ${s.staged.join(", ")}`);
  if (s.modified.length > 0)
    lines.push(`Modified (${String(s.modified.length)}): ${s.modified.join(", ")}`);
  if (s.untracked.length > 0)
    lines.push(`Untracked (${String(s.untracked.length)}): ${s.untracked.join(", ")}`);
  if (s.conflicts.length > 0)
    lines.push(`Conflicts (${String(s.conflicts.length)}): ${s.conflicts.join(", ")}`);
  if (s.ahead > 0 || s.behind > 0)
    lines.push(`Ahead: ${String(s.ahead)} | Behind: ${String(s.behind)}`);
  lines.push(s.isDirty ? "Status: dirty" : "Status: clean");
  return { success: true, output: lines.join("\n") };
}

let lastDiffOutput: string | null = null;
let lastDiffStaged: boolean | undefined;

async function execDiff(staged?: boolean, flags?: string[]): Promise<ToolResult> {
  const args = staged ? ["diff", "--cached"] : ["diff"];
  if (flags) args.push(...flags);
  const { stdout } = await run(args, cwd);
  const output = stdout || "No changes.";
  // Skip dedup cache when custom flags are used
  if (!flags && output === lastDiffOutput && staged === lastDiffStaged) {
    return { success: true, output: "No changes since last diff." };
  }
  if (!flags) {
    lastDiffOutput = output;
    lastDiffStaged = staged;
  }
  return { success: true, output: await capGitOutput(output, "diff") };
}

export function resetDiffCache(): void {
  lastDiffOutput = null;
  lastDiffStaged = undefined;
}

async function execLog(count?: number, flags?: string[]): Promise<ToolResult> {
  if (flags) {
    // Custom flags bypass structured parsing — run raw
    const args = ["log", `-n`, String(count ?? 10), ...flags];
    const { ok, stdout } = await run(args, cwd);
    if (!ok) return { success: false, output: stdout || "Log failed", error: "log failed" };
    return { success: true, output: await capGitOutput(stdout || "No commits found.", "log") };
  }
  const entries = await getGitLog(cwd, count ?? 10);
  if (entries.length === 0) return { success: true, output: "No commits found." };
  return {
    success: true,
    output: entries.map((e) => `${e.hash} ${e.subject} (${e.date})`).join("\n"),
  };
}

async function execCommit(message: string, files?: string[], amend?: boolean): Promise<ToolResult> {
  if (files && files.length > 0) {
    const ok = await gitAdd(cwd, files);
    if (!ok) return { success: false, output: "Failed to stage files", error: "staging failed" };
  }
  if (!amend) {
    const diff = await getGitDiff(cwd, true);
    if (!diff) {
      return {
        success: false,
        output: "Nothing staged to commit. Stage files first.",
        error: "nothing staged",
      };
    }
  }
  const result = await gitCommit(cwd, message, amend);
  if (!result.ok) return { success: false, output: result.output, error: "commit failed" };
  const diff = await getGitDiff(cwd, true);
  const diffLines = (diff || "").split("\n");
  const statLines = diffLines.filter((l) => l.startsWith("+++") || l.startsWith("---")).length;
  const additions = diffLines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const deletions = diffLines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  const prefix = amend ? "Amended" : "Committed";
  return {
    success: true,
    output: `${prefix}: ${result.output}\n\nDiff summary: ~${String(statLines / 2)} files, +${String(additions)} -${String(deletions)} lines`,
  };
}

async function execPush(flags?: string[]): Promise<ToolResult> {
  const result = await gitPush(cwd, flags);
  return { success: result.ok, output: result.output };
}

async function execPull(flags?: string[]): Promise<ToolResult> {
  const result = await gitPull(cwd, flags);
  return { success: result.ok, output: result.output };
}

async function execStash(
  subAction?: string,
  message?: string,
  index?: number,
): Promise<ToolResult> {
  const action = subAction ?? "push";
  switch (action) {
    case "list": {
      const { ok, entries } = await gitStashList(cwd);
      if (!ok)
        return { success: false, output: "Failed to list stashes", error: "stash list failed" };
      return { success: true, output: entries.length > 0 ? entries.join("\n") : "No stashes." };
    }
    case "show": {
      const { ok, output } = await gitStashShow(cwd, index ?? 0);
      return { success: ok, output: await capGitOutput(output || "Empty stash.", "stash-show") };
    }
    case "drop": {
      const { ok, output } = await gitStashDrop(cwd, index ?? 0);
      return { success: ok, output };
    }
    case "pop": {
      const result = await gitStashPop(cwd);
      return { success: result.ok, output: result.output };
    }
    default: {
      const result = await gitStash(cwd, message);
      return { success: result.ok, output: result.output };
    }
  }
}

async function execBranch(
  subAction?: string,
  name?: string,
  flags?: string[],
): Promise<ToolResult> {
  const action = subAction ?? "list";
  switch (action) {
    case "list": {
      const args = ["branch", "-vv", ...(flags ?? [])];
      const { ok, stdout } = await run(args, cwd);
      return { success: ok, output: stdout || "No branches." };
    }
    case "create": {
      if (!name) return { success: false, output: "Branch name required", error: "missing name" };
      const { ok, output } = await gitCreateBranch(cwd, name);
      return { success: ok, output: output || `Created and switched to ${name}` };
    }
    case "switch": {
      if (!name) return { success: false, output: "Branch name required", error: "missing name" };
      const { ok, output } = await gitSwitchBranch(cwd, name);
      return { success: ok, output: output || `Switched to ${name}` };
    }
    case "delete": {
      if (!name) return { success: false, output: "Branch name required", error: "missing name" };
      const { ok, stdout } = await run(["branch", "-d", name], cwd);
      return { success: ok, output: stdout || `Deleted ${name}` };
    }
    default:
      return { success: false, output: `Unknown branch action: ${action}`, error: "bad action" };
  }
}

async function execShow(ref?: string, flags?: string[]): Promise<ToolResult> {
  if (flags) {
    const args = ["show", ...(flags ?? []), ref ?? "HEAD"];
    const { ok, stdout } = await run(args, cwd);
    return { success: ok, output: await capGitOutput(stdout, "show") };
  }
  const result = await gitShow(cwd, ref ?? "HEAD");
  return { success: result.ok, output: await capGitOutput(result.output, "show") };
}

async function execUnstage(files?: string[]): Promise<ToolResult> {
  if (!files || files.length === 0) {
    return { success: false, output: "Specify files to unstage", error: "missing files" };
  }
  const result = await gitUnstage(cwd, files);
  return { success: result.ok, output: result.output };
}

async function execRestore(files?: string[]): Promise<ToolResult> {
  if (!files || files.length === 0) {
    return { success: false, output: "Specify files to restore", error: "missing files" };
  }
  const result = await gitRestore(cwd, files);
  return { success: result.ok, output: result.output };
}

async function execStage(files?: string[]): Promise<ToolResult> {
  const targets = files && files.length > 0 ? files : ["-A"];
  const ok = await gitAdd(cwd, targets);
  if (!ok) return { success: false, output: "Failed to stage files", error: "staging failed" };
  const label = targets[0] === "-A" ? "all files" : `${String(files?.length ?? 0)} file(s)`;
  return { success: true, output: `Staged ${label}` };
}

async function execTag(
  subAction?: string,
  name?: string,
  message?: string,
  ref?: string,
): Promise<ToolResult> {
  const result = await gitTag(cwd, subAction, name, message, ref);
  return { success: result.ok, output: result.output, error: result.ok ? undefined : "tag failed" };
}

async function execCherryPick(ref?: string, flags?: string[]): Promise<ToolResult> {
  if (!ref) return { success: false, output: "Commit ref required", error: "missing ref" };
  const result = await gitCherryPick(cwd, ref, flags);
  return {
    success: result.ok,
    output: result.output,
    error: result.ok ? undefined : "cherry-pick failed",
  };
}

async function execRebase(subAction?: string, ref?: string, flags?: string[]): Promise<ToolResult> {
  const result = await gitRebase(cwd, subAction, ref, flags);
  return {
    success: result.ok,
    output: result.output,
    error: result.ok ? undefined : "rebase failed",
  };
}

async function execReset(ref?: string, mode?: string, files?: string[]): Promise<ToolResult> {
  const result = await gitReset(cwd, ref, mode, files);
  return {
    success: result.ok,
    output: result.output,
    error: result.ok ? undefined : "reset failed",
  };
}

async function execBlame(file?: string, startLine?: number, endLine?: number): Promise<ToolResult> {
  if (!file) return { success: false, output: "File path required", error: "missing file" };
  const result = await gitBlame(cwd, file, startLine, endLine);
  return {
    success: result.ok,
    output: await capGitOutput(result.output, "blame"),
    error: result.ok ? undefined : "blame failed",
  };
}
function extractDiffPaths(diff: string, max = 10): string[] {
  const paths = new Set<string>();
  const re = /^diff --git a\/(\S+) b\/(\S+)/gm;
  for (const m of diff.matchAll(re)) {
    if (m[2]) paths.add(m[2]);
    if (paths.size >= max) break;
  }
  return [...paths];
}
