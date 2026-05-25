import type { CommandPickerOption } from "../../components/modals/CommandPicker.js";
import { confirm, openSelect } from "../../components/ui/dialogs/index.js";
import { useTerminalStore } from "../../stores/terminals.js";
import { useUIStore } from "../../stores/ui.js";
import { emitDraftRestore, getStashDB } from "../history/index.js";
import { icon } from "../icons.js";
import { ghosttyDisabled, IS_WIN } from "../platform/index.js";
import { closeTerminal, spawnTerminal } from "../terminal/manager.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

function handleEditor(_input: string, ctx: CommandContext): void {
  ctx.toggleFocus();
}

function handleHelp(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("commandPalette");
}

function handleOpen(input: string, ctx: CommandContext): void {
  const filePath = input
    .trim()
    .replace(/^\/(editor\s+)?open\s*/i, "")
    .trim();
  if (!filePath) {
    sysMsg(ctx, "Usage: /editor open <file-path>");
    return;
  }
  ctx.openEditorWithFile(filePath);
  sysMsg(ctx, `Opening ${filePath} in editor...`);
}

function handleEditorSettings(_input: string, ctx: CommandContext): void {
  ctx.openEditorSettings();
}

function handleRouter(_input: string, ctx: CommandContext): void {
  ctx.openRouterSettings();
}

function handleProviderSettings(_input: string, ctx: CommandContext): void {
  ctx.openProviderSettings();
}

function handleModels(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("llmSelector");
}

function handleWebSearch(_input: string, ctx: CommandContext): void {
  ctx.openWebSearchSettings();
}

function handleApiKeys(_input: string, ctx: CommandContext): void {
  ctx.openApiKeySettings();
}

function handleChanges(_input: string, ctx: CommandContext): void {
  ctx.toggleChanges();
}

function handleErrors(_input: string, ctx: CommandContext): void {
  ctx.openErrorLog();
}

function handleCompactionLogs(_input: string, ctx: CommandContext): void {
  ctx.openCompactionLog();
}

function handleSkills(_input: string, ctx: CommandContext): void {
  ctx.openSkills();
}

function handleTabs(_input: string, ctx: CommandContext): void {
  const tabOptions: CommandPickerOption[] = ctx.tabMgr.tabs.map((tab, i) => ({
    value: tab.id,
    label: `${String(i + 1)}. ${tab.label}`,
    icon: tab.id === ctx.tabMgr.activeTabId ? "▸" : " ",
    color: tab.id === ctx.tabMgr.activeTabId ? getThemeTokens().brand : undefined,
  }));
  ctx.openCommandPicker({
    title: "Switch Tab",
    icon: icon("tabs"),
    options: tabOptions,
    currentValue: ctx.tabMgr.activeTabId,
    onSelect: (tabId) => ctx.tabMgr.switchTab(tabId),
  });
}

function handleNewTab(_input: string, ctx: CommandContext): void {
  if (!ctx.tabMgr.canCreateTab) return;
  useUIStore.getState().openModal("tabNamePopup");
}

function handleCloseTab(_input: string, ctx: CommandContext): void {
  if (ctx.tabMgr.tabCount <= 1) {
    sysMsg(ctx, "Can't close the last tab.");
    return;
  }
  if (ctx.tabMgr.isTabLoading(ctx.tabMgr.activeTabId)) {
    const closingId = ctx.tabMgr.activeTabId;
    ctx.openCommandPicker({
      title: "Tab is busy — close anyway?",
      icon: "⚠",
      options: [
        { value: "yes", label: "Yes, close it", icon: "✓" },
        { value: "no", label: "Cancel", icon: "✕" },
      ],
      onSelect: (val) => {
        if (val === "yes") ctx.tabMgr.closeTab(closingId);
      },
    });
  } else {
    ctx.tabMgr.closeTab(ctx.tabMgr.activeTabId);
  }
}

function handleRename(input: string, ctx: CommandContext): void {
  const newName = input
    .trim()
    .replace(/^\/(tab\s+rename|rename)\s*/i, "")
    .trim();
  if (newName) {
    ctx.tabMgr.renameTab(ctx.tabMgr.activeTabId, newName);
    sysMsg(ctx, `Tab renamed to: ${newName}`);
  } else {
    sysMsg(ctx, "Usage: /tab rename <name>");
  }
}

function resolveTerminalByPosition(posStr: string): number | null {
  const pos = Number(posStr);
  if (!Number.isInteger(pos) || pos < 1) return null;
  const terminals = useTerminalStore.getState().terminals;
  const entry = terminals[pos - 1];
  return entry?.id ?? null;
}

function handleTerminals(input: string, ctx: CommandContext): void {
  // Floating terminal renders via ghostty-opentui native addon, which is
  // skipped on Windows (dlopen segfault on bun 1.3.x). Disable the whole
  // /terminals command surface there until upstream ships a compatible build.
  if (ghosttyDisabled()) {
    const msg = IS_WIN
      ? "Floating terminal not supported on Windows yet (native addon pending). Use a separate PowerShell/cmd window."
      : "Floating terminal is disabled in this build. Use an external terminal window.";
    sysMsg(ctx, msg);
    return;
  }

  const firstSpace = input.indexOf(" ");
  const rest = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();
  const parts = rest.split(/\s+/);
  const sub = parts[0]?.toLowerCase() ?? "";
  const arg = parts.slice(1).join(" ");

  if (!sub || sub === "list") {
    useUIStore.getState().toggleTerminalsExpanded();
    return;
  }

  if (sub === "new") {
    const cwd = arg || ctx.cwd;
    const result = spawnTerminal(cwd);
    if (!result.success) {
      sysMsg(ctx, result.error ?? "Failed to spawn terminal.");
      return;
    }
    useUIStore.getState().setTerminalsExpanded(true);
    useUIStore.getState().openModal("floatingTerminal");
    return;
  }

  if (sub === "close" || sub === "kill") {
    const store = useTerminalStore.getState();
    const id = arg ? resolveTerminalByPosition(arg) : store.selectedId;
    if (!id) {
      sysMsg(ctx, "Usage: /terminals close <number>");
      return;
    }
    const entry = store.terminals.find((t) => t.id === id);
    if (!entry) {
      sysMsg(ctx, `No terminal at position ${arg}.`);
      return;
    }
    closeTerminal(id);
    sysMsg(ctx, `Terminal ${entry.label} closed.`);
    return;
  }

  if (sub === "show" || sub === "open") {
    if (arg) {
      const id = resolveTerminalByPosition(arg);
      if (!id) {
        sysMsg(ctx, `No terminal at position ${arg}.`);
        return;
      }
      useTerminalStore.getState().selectTerminal(id);
    }
    const store = useTerminalStore.getState();
    if (!store.selectedId || !store.terminals.some((t) => t.id === store.selectedId)) {
      sysMsg(ctx, "No terminals. Use /terminals new to create one.");
      return;
    }
    useUIStore.getState().openModal("floatingTerminal");
    return;
  }

  if (sub === "hide") {
    useUIStore.getState().closeModal("floatingTerminal");
    return;
  }

  if (sub === "rename") {
    const store = useTerminalStore.getState();
    if (!store.selectedId) {
      sysMsg(ctx, "No terminal selected.");
      return;
    }
    if (!arg) {
      sysMsg(ctx, "Usage: /terminals rename <name>");
      return;
    }
    store.renameTerminal(store.selectedId, arg);
    return;
  }

  sysMsg(ctx, `Unknown subcommand: ${sub}. Available: new, close, show, hide, list, rename`);
}

function handleQuit(_input: string, ctx: CommandContext): void {
  ctx.exit();
}

function handleRestart(_input: string, ctx: CommandContext): void {
  ctx.chat.abort();
  import("../../index.js").then(({ restart }) => restart());
}

function handleWizard(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("firstRunWizard");
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/quit", handleQuit);
  map.set("/exit", handleQuit);
  map.set("/restart", handleRestart);
  map.set("/editor", handleEditor);
  map.set("/edit", handleEditor);
  map.set("/help", handleHelp);

  // Editor subcommands
  map.set("/editor settings", handleEditorSettings);
  map.set("/editor open", handleOpen);
  map.set("/editor-settings", handleEditorSettings); // legacy alias
  map.set("/open", handleOpen); // legacy alias

  map.set("/router", handleRouter);
  map.set("/mcp", (_input: string) => {
    useUIStore.getState().openModal("mcpSettings");
  });
  map.set("/provider-settings", handleProviderSettings);
  map.set("/perf", handleProviderSettings);
  map.set("/providers", handleModels);
  map.set("/provider", handleModels);
  map.set("/models", handleModels);
  map.set("/model", handleModels);
  map.set("/web-search", handleWebSearch);
  map.set("/keys", handleApiKeys);
  map.set("/api-keys", handleApiKeys);
  map.set("/changes", handleChanges);
  map.set("/files", handleChanges);
  map.set("/errors", handleErrors);
  map.set("/compact logs", handleCompactionLogs);
  map.set("/compact-v2-logs", handleCompactionLogs); // legacy alias
  map.set("/skills", handleSkills);
  map.set("/terminals", handleTerminals);
  map.set("/terminal", handleTerminals);
  map.set("/tab", handleTabs);
  map.set("/tab new", handleNewTab);
  map.set("/tab close", handleCloseTab);
  map.set("/tab rename", handleRename);
  map.set("/wizard", handleWizard);
  map.set("/stash", handleStash);
  map.set("/drafts", handleStash);
}

export function matchNavPrefix(cmd: string): CommandHandler | null {
  if (cmd.startsWith("/editor open ")) return handleOpen;
  if (cmd.startsWith("/open ")) return handleOpen;
  if (cmd.startsWith("/tab rename ")) return handleRename;
  if (cmd.startsWith("/terminals ")) return handleTerminals;
  if (cmd.startsWith("/terminal ")) return handleTerminals;
  return null;
}
async function handleStash(_input: string, ctx: CommandContext): Promise<void> {
  const cwd = process.cwd();
  let entries = getStashDB().list(cwd);
  if (entries.length === 0) {
    sysMsg(ctx, "No stashed drafts. Press Alt+S in the input to stash one.");
    return;
  }

  const fmtCreated = (iso: string): string => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const diff = Date.now() - t;
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${String(s)}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${String(m)}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${String(h)}h ago`;
    return `${String(Math.floor(h / 24))}d ago`;
  };

  const buildOptions = () =>
    entries.map((e) => {
      const firstLine = (e.content.split("\n")[0] ?? "").trim();
      const preview = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
      const lineCount = e.content.split("\n").length;
      return {
        value: e.id,
        label: preview || "(empty)",
        description: lineCount > 1 ? `${String(lineCount)} lines` : undefined,
        meta: fmtCreated(e.createdAt),
      };
    });

  const opts = buildOptions().map((o) => ({
    value: o.value,
    label: o.label,
    description: o.description,
    meta: o.meta,
  }));
  const picked = await openSelect<number>({
    title: "Stashed Drafts",
    titleIcon: "archive",
    placeholder: `${String(entries.length)} drafts · fuzzy filter…`,
    options: opts,
    actions: [
      {
        key: "d",
        label: "delete",
        side: "right",
        onTrigger: (opt) => {
          if (!opt) return;
          try {
            getStashDB().remove(opt.value as number);
          } catch {}
          entries = entries.filter((e) => e.id !== (opt.value as number));
          sysMsg(ctx, `Removed stash entry #${String(opt.value)}.`);
        },
      },
      {
        key: "X",
        label: "clear all",
        side: "right",
        onTrigger: async () => {
          const ok = await confirm({
            title: "Clear all stashed drafts?",
            message: `${String(entries.length)} drafts will be deleted from this project.`,
            danger: true,
          });
          if (!ok) return;
          try {
            getStashDB().clear(cwd);
          } catch {}
          entries = [];
          sysMsg(ctx, "All drafts cleared.");
        },
      },
    ],
    footerHints: [
      { key: "Enter", label: "restore" },
      { key: "d", label: "delete" },
      { key: "X", label: "clear all" },
    ],
  });
  if (picked) {
    const entry = entries.find((e) => e.id === (picked.value as number));
    if (entry) {
      try {
        getStashDB().remove(entry.id);
      } catch {}
      emitDraftRestore(entry.content);
      sysMsg(ctx, "Draft restored to input.");
    }
  }
}
