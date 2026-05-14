import { useUIStore } from "../../stores/ui.js";
import { useVersionStore } from "../../stores/version.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

function handleStatus(_input: string, _ctx: CommandContext): void {
  useUIStore.setState({ statusDashboardTab: "System" });
  useUIStore.getState().openModal("statusDashboard");
}

function handleModelEvents(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("modelEvents");
}

function handleDiagnose(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("diagnosePopup");
}

function handleUpdate(_input: string, _ctx: CommandContext): void {
  // Force fresh check then open modal
  useVersionStore.getState().check(true);
  useUIStore.getState().openModal("updateModal");
}

function handleSetup(_input: string, ctx: CommandContext): void {
  ctx.openSetup();
}

function handleLsp(_input: string, ctx: CommandContext): void {
  ctx.openLspInstall();
}

function handleLspStatus(_input: string, ctx: CommandContext): void {
  ctx.openLspStatus();
}

function handleLspInstall(_input: string, ctx: CommandContext): void {
  ctx.openLspInstall();
}

async function handleLspRestart(input: string, ctx: CommandContext): Promise<void> {
  const filter = input.replace(/^\/lsp[\s-]restart\s*/, "").trim() || undefined;
  const { restartLspServers } = await import("../intelligence/index.js");
  const label = filter ?? "all";
  sysMsg(ctx, `Restarting LSP servers (${label})…`);
  const restarted = await restartLspServers(filter);
  if (restarted.length === 0) {
    sysMsg(ctx, "No matching LSP servers to restart.");
  } else {
    sysMsg(ctx, `Restarted ${restarted.length} server(s): ${restarted.join(", ")}. Re-warming…`);
  }
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/status", handleStatus);
  map.set("/model-events", handleModelEvents);
  map.set("/model events", handleModelEvents);
  map.set("/diagnose", handleDiagnose);
  map.set("/setup", handleSetup);
  map.set("/lsp", handleLsp);
  map.set("/lsp-status", handleLspStatus);
  map.set("/lsp status", handleLspStatus);
  map.set("/lsp-install", handleLspInstall);
  map.set("/lsp install", handleLspInstall);
  map.set("/lsp-restart", handleLspRestart);
  map.set("/lsp restart", handleLspRestart);
  map.set("/update", handleUpdate);
}
