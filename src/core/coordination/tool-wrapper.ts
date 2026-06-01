import { resolve } from "node:path";
import { getCwd } from "../cwd.js";
import type { ConflictInfo } from "./types.js";
import { getWorkspaceCoordinator } from "./WorkspaceCoordinator.js";

/**
 * Format a conflict warning for tool output.
 * Returns null if no conflicts.
 */
export function formatConflictWarning(conflicts: ConflictInfo[]): string | null {
  if (conflicts.length === 0) return null;

  const lines = conflicts.map((c) => {
    const ago = formatTimeAgo(c.lastEditAt);
    const cwd = getCwd();
    const displayPath = c.path.startsWith(cwd) ? c.path.slice(cwd.length + 1) : c.path;
    return `⚠️ File ${displayPath} is being edited by Tab "${c.ownerTabLabel}" (${String(c.editCount)} edit${c.editCount !== 1 ? "s" : ""}, last ${ago}).`;
  });

  return lines.join("\n");
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ago`;
}

/**
 * Check for conflicts and claim a file after edit.
 * Returns a warning string to prepend to tool output, or null.
 */
export function checkAndClaim(
  tabId: string | undefined,
  tabLabel: string | undefined,
  filePath: string,
): string | null {
  if (!tabId || !tabLabel) return null;

  const coordinator = getWorkspaceCoordinator();
  const absPath = resolve(filePath);

  // Check for conflicts
  const conflicts = coordinator.getConflicts(tabId, [absPath]);
  const warning = formatConflictWarning(conflicts);

  // Claim the file (implicit claiming on edit)
  coordinator.claimFiles(tabId, tabLabel, [absPath]);

  return warning;
}

/**
 * Prepend a warning to a tool result (string or ToolResult object).
 */
export function prependWarning<T>(result: T, warning: string | null): T {
  if (!warning) return result;
  const prefix = `${warning}\nProceeding anyway. Consider coordinating with the other tab.\n\n`;
  if (typeof result === "string") return `${prefix}${result}` as T;
  if (result && typeof result === "object" && "output" in result) {
    return { ...result, output: `${prefix}${(result as { output: string }).output}` } as T;
  }
  return result;
}

/**
 * Post-hoc claim files after a compound tool (rename_symbol, move_symbol, etc.) succeeds.
 * These tools modify files but don't go through edit_file/multi_edit, so they need
 * explicit claiming to keep other tabs informed.
 */
export function claimAfterCompoundEdit(
  tabId: string | undefined,
  tabLabel: string | undefined,
  paths: string[],
): void {
  if (!tabId || !tabLabel || paths.length === 0) return;
  const coordinator = getWorkspaceCoordinator();
  const absPaths = paths.filter(Boolean).map((p) => resolve(p));
  coordinator.claimFiles(tabId, tabLabel, absPaths);
}
