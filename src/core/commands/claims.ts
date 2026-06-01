import { relative } from "node:path";
import type { InfoPopupLine } from "../../components/modals/InfoPopup.js";
import { getWorkspaceCoordinator } from "../coordination/WorkspaceCoordinator.js";
import { getCwd } from "../cwd.js";
import { icon } from "../icons.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

function displayPath(absPath: string): string {
  const cwd = getCwd();
  return absPath.startsWith(cwd) ? relative(cwd, absPath) : absPath;
}

function handleClaims(_input: string, ctx: CommandContext): void {
  const coordinator = getWorkspaceCoordinator();
  const allClaims = coordinator.getAllClaims();

  if (allClaims.size === 0) {
    sysMsg(ctx, "No active file claims across tabs.");
    return;
  }

  // Group by tab
  const byTab = new Map<string, Array<{ path: string; editCount: number; lastEditAt: number }>>();
  for (const [path, claim] of allClaims) {
    const key = `${claim.tabLabel} (${claim.tabId.slice(0, 8)})`;
    const list = byTab.get(key) ?? [];
    list.push({ path, editCount: claim.editCount, lastEditAt: claim.lastEditAt });
    byTab.set(key, list);
  }

  const lines: InfoPopupLine[] = [];
  for (const [tabKey, files] of byTab) {
    if (lines.length > 0) lines.push({ type: "spacer" });
    lines.push({ type: "header", label: tabKey });
    lines.push({ type: "separator" });
    for (const f of files) {
      const ago = formatTimeAgo(f.lastEditAt);
      lines.push({
        type: "entry",
        label: displayPath(f.path),
        desc: `${String(f.editCount)} edits, ${ago}`,
        color: getThemeTokens().amber,
        descColor: getThemeTokens().textMuted,
      });
    }
  }
  lines.push({ type: "spacer" });
  lines.push({
    type: "text",
    label: `${String(allClaims.size)} file(s) claimed`,
    color: getThemeTokens().textMuted,
  });

  ctx.openInfoPopup({ title: "File Claims", icon: icon("lock"), lines, labelWidth: 40 });
}

function handleUnclaim(input: string, ctx: CommandContext): void {
  const path =
    input
      .trim()
      .replace(/^\/(claim\s+release|unclaim)\s*/i, "")
      .trim() || undefined;
  if (!path) {
    sysMsg(ctx, "Usage: /claim release <file-path>");
    return;
  }

  const tabId = ctx.tabMgr.activeTabId;
  const coordinator = getWorkspaceCoordinator();
  const claims = coordinator.getClaimsForTab(tabId);

  // Find the claim by matching the end of the path
  let matchedPath: string | null = null;
  for (const [claimPath] of claims) {
    if (claimPath.endsWith(path) || displayPath(claimPath) === path) {
      matchedPath = claimPath;
      break;
    }
  }

  if (!matchedPath) {
    sysMsg(ctx, `No claim found for "${path}" in current tab.`);
    return;
  }

  coordinator.releaseFiles(tabId, [matchedPath]);
  sysMsg(ctx, `Released claim on ${displayPath(matchedPath)}.`);
}

function handleUnclaimAll(_input: string, ctx: CommandContext): void {
  const tabId = ctx.tabMgr.activeTabId;
  const coordinator = getWorkspaceCoordinator();
  const claims = coordinator.getClaimsForTab(tabId);
  const count = claims.size;

  if (count === 0) {
    sysMsg(ctx, "No active claims in current tab.");
    return;
  }

  coordinator.releaseAll(tabId);
  sysMsg(ctx, `Released ${String(count)} file claim(s) from current tab.`);
}

function handleForceClaim(input: string, ctx: CommandContext): void {
  const path = input
    .trim()
    .replace(/^\/(claim\s+force|force-claim)\s*/i, "")
    .trim();
  if (!path) {
    sysMsg(ctx, "Usage: /claim force <file-path>");
    return;
  }

  const tabId = ctx.tabMgr.activeTabId;
  const tabLabel = ctx.tabMgr.activeTab.label;
  const coordinator = getWorkspaceCoordinator();

  const previousOwner = coordinator.forceClaim(tabId, tabLabel, path);
  if (previousOwner && previousOwner.tabId !== tabId) {
    sysMsg(ctx, `Force-claimed ${displayPath(path)} from Tab "${previousOwner.tabLabel}".`);
  } else {
    sysMsg(ctx, `Claimed ${displayPath(path)}.`);
  }
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ago`;
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/claim", handleClaims);
  map.set("/claim release-all", handleUnclaimAll);
  map.set("/claim force", handleForceClaim);
}

export function matchClaimsPrefix(cmd: string): CommandHandler | null {
  if (cmd.startsWith("/claim release ") || cmd === "/claim release") return handleUnclaim;
  if (cmd.startsWith("/claim force ") || cmd === "/claim force") return handleForceClaim;
  return null;
}
