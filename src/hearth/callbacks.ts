/**
 * Build the InteractiveCallbacks object that the Forge agent consumes.
 * Each callback serialises the prompt through the surface and awaits the
 * user's reply. No callback ever throws — failure defaults to safe (deny/skip).
 */

import type {
  InteractiveCallbacks,
  Plan,
  PlanReviewAction,
  PlanStepStatus,
} from "../types/index.js";
import { askRemote } from "./bridge.js";
import type { ExternalChatId, Surface } from "./types.js";

export interface CallbacksCtx {
  surface: Surface;
  externalId: ExternalChatId;
  tabId: string;
  /** Optional logger for daemon telemetry. */
  log?: (line: string) => void;
}

function safeNotify(ctx: CallbacksCtx, msg: string): void {
  ctx.surface.notify(ctx.externalId, msg).catch((err) => {
    ctx.log?.(`notify failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export function buildHearthCallbacks(ctx: CallbacksCtx): InteractiveCallbacks {
  return {
    onPlanCreate(plan: Plan): void {
      safeNotify(ctx, `📋 Plan: ${plan.title} (${plan.steps.length} step(s))`);
    },
    onPlanStepUpdate(stepId: string, status: PlanStepStatus): void {
      safeNotify(ctx, `• ${stepId} → ${status}`);
    },
    async onPlanReview(
      plan: Plan,
      _planFile: string,
      _planContent: string,
    ): Promise<PlanReviewAction> {
      // Route through the bridge: emit a plan-review event the surface renders as
      // Approve/Cancel/Edit buttons, and park the promise until the user taps one.
      // Falls back to "cancel" when the surface is offline (askRemote short-circuits).
      return askRemote<PlanReviewAction>(
        ctx.tabId,
        (callbackId) => ({
          type: "plan-review",
          callbackId,
          title: plan.title,
          summary: `${String(plan.steps.length)} steps`,
        }),
        "cancel",
      );
    },
    async onAskUser(question: string, options, allowSkip): Promise<string> {
      // Emit an ask-user event (inline keyboard) and await the user's choice.
      // Fallback: skip token when allowed, else the first option (never hang).
      return askRemote<string>(
        ctx.tabId,
        (callbackId) => ({
          type: "ask-user",
          callbackId,
          question,
          options: [...options],
          allowSkip,
        }),
        allowSkip ? "__skipped__" : (options[0]?.value ?? ""),
      );
    },
    async onOpenEditor(_file?: string): Promise<void> {
      safeNotify(ctx, "Editor is not available on remote surfaces.");
    },
    async onWebSearchApproval(query: string): Promise<boolean> {
      try {
        const { decision } = await ctx.surface.requestApproval(ctx.externalId, {
          approvalId: `web:${Date.now().toString(36)}`,
          toolName: "web_search",
          summary: `Web search: ${query.slice(0, 100)}`,
          cwd: "",
          tabId: ctx.tabId,
        });
        return decision === "allow";
      } catch {
        return false;
      }
    },
    async onFetchPageApproval(url: string): Promise<boolean> {
      try {
        const { decision } = await ctx.surface.requestApproval(ctx.externalId, {
          approvalId: `fetch:${Date.now().toString(36)}`,
          toolName: "fetch_page",
          summary: `Fetch page: ${url.slice(0, 120)}`,
          cwd: "",
          tabId: ctx.tabId,
        });
        return decision === "allow";
      } catch {
        return false;
      }
    },
  };
}
/**
 * Approval hooks for destructive ops and out-of-cwd writes. These route to
 * createForgeAgent directly (not via InteractiveCallbacks), so the daemon
 * passes them through HeadlessChatOptions. Both await a surface Allow/Deny;
 * surface offline or error → deny (safe default).
 */
export function buildHearthApprovals(ctx: CallbacksCtx): {
  onApproveDestructive: (description: string) => Promise<boolean>;
  onApproveOutsideCwd: (toolName: string, path: string) => Promise<boolean>;
} {
  const ask = async (toolName: string, summary: string): Promise<boolean> => {
    try {
      const { decision } = await ctx.surface.requestApproval(ctx.externalId, {
        approvalId: `${toolName}:${Date.now().toString(36)}`,
        toolName,
        summary,
        cwd: "",
        tabId: ctx.tabId,
      });
      return decision === "allow";
    } catch {
      return false;
    }
  };
  return {
    onApproveDestructive: (description: string) => ask("destructive", description),
    onApproveOutsideCwd: (toolName: string, path: string) =>
      ask(toolName, `Write outside workspace: ${path}`),
  };
}
