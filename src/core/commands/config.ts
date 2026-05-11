import type { ConfigScope } from "../../components/layout/shared.js";
import { loadConfig } from "../../config/index.js";
import { useUIStore } from "../../stores/ui.js";
import type { AgentFeatures, AppConfig } from "../../types/index.js";
import { icon, setNerdFont } from "../icons.js";
import { applyTheme, getThemeTokens, listThemes, useThemeStore } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

type ToggleConfig = {
  configKey: string;
  title: string;
  iconName: string;
  onValue: string;
  offValue: string;
  onLabel: string;
  offLabel: string;
  onDescription: string;
  offDescription: string;
  messageTemplate: (value: string, scope: string) => string;
};

function createTogglePicker(config: ToggleConfig): CommandHandler {
  return (_input: string, ctx: CommandContext) => {
    const currentVal = ctx[config.configKey as keyof CommandContext];
    const patch = (v: string) => ({ [config.configKey]: v === config.onValue });
    ctx.openCommandPicker({
      title: config.title,
      icon: icon(config.iconName),
      currentValue: currentVal ? config.onValue : config.offValue,
      scopeEnabled: true,
      initialScope: ctx.detectScope(config.configKey),
      options: [
        { value: config.onValue, label: config.onLabel, description: config.onDescription },
        { value: config.offValue, label: config.offLabel, description: config.offDescription },
      ],
      onSelect: (value, scope) => {
        ctx.saveToScope(patch(value), scope ?? "project");
        sysMsg(ctx, config.messageTemplate(value, scope ?? "project"));
      },
      onScopeMove: (value, from, to) => ctx.saveToScope(patch(value), to, from),
    });
  };
}

async function handleFont(input: string, ctx: CommandContext): Promise<void> {
  const trimmed = input.trim();
  const { detectInstalledFonts, NERD_FONTS } = await import("../setup/install.js");
  const { detectTerminal, getCurrentFont, setTerminalFont } = await import(
    "../setup/terminal-font.js"
  );

  const fontArg = trimmed.replace(/^\/(fonts?)\s*/i, "").trim();
  const found = detectInstalledFonts();
  const term = detectTerminal();

  if (fontArg === "set" || fontArg.startsWith("set ")) {
    const fontName = fontArg.slice(4).trim().toLowerCase();

    const applyFont = (fontId: string) => {
      const match = NERD_FONTS.find(
        (f) =>
          f.id === fontId || f.name.toLowerCase() === fontId || f.family.toLowerCase() === fontId,
      );
      if (!match) {
        sysMsg(
          ctx,
          `Unknown font "${fontId}". Available:\n${NERD_FONTS.map((f) => `  ${f.id.padEnd(18)} ${f.family}`).join("\n")}`,
        );
      } else if (!term.canAutoSet) {
        sysMsg(ctx, `Can't auto-set font in ${term.name}.\n${term.instructions} → ${match.family}`);
      } else {
        const result = setTerminalFont(match.family);
        sysMsg(ctx, result.message + (result.configPath ? `\nConfig: ${result.configPath}` : ""));
      }
    };

    if (fontName) {
      applyFont(fontName);
    } else {
      const currentFont = getCurrentFont();
      ctx.openCommandPicker({
        title: "Set Terminal Font",
        icon: icon("memory_alt"),
        currentValue: found.find((f) => currentFont?.includes(f.family))?.id,
        options: NERD_FONTS.map((f) => {
          const installed = found.some((i) => i.id === f.id);
          return {
            value: f.id,
            label: `${installed ? "✓" : "○"} ${f.name}`,
            description: f.description,
          };
        }),
        onSelect: applyFont,
      });
    }
    return;
  }

  const currentFont = getCurrentFont();
  const fontLines: string[] = [
    "── Fonts ──",
    "",
    `Terminal: ${term.name}${term.canAutoSet ? " (auto-set ✓)" : ""}`,
    `Current:  ${currentFont ?? "unknown"}`,
    "",
    "Installed Nerd Fonts:",
  ];
  if (found.length > 0) {
    for (const f of found) fontLines.push(`  ✓ ${f.family}`);
  } else {
    fontLines.push("  ✗ None — run /setup → [2] Fonts to install");
  }
  fontLines.push("");
  fontLines.push("Available:");
  for (const f of NERD_FONTS) {
    const installed = found.some((i) => i.id === f.id);
    fontLines.push(`  ${installed ? "✓" : "○"} ${f.id.padEnd(18)} ${f.description}`);
  }
  fontLines.push("");
  if (term.canAutoSet) {
    fontLines.push("Set: /font set <name>    e.g. /font set fira-code");
  } else {
    fontLines.push(`Manual: ${term.instructions}`);
  }
  sysMsg(ctx, fontLines.join("\n"));
}

function handleChatStyle(input: string, ctx: CommandContext): void {
  const trimmed = input.trim();
  const arg = trimmed.slice(12).trim().toLowerCase();
  const patch = (v: string) => ({ chatStyle: v as "accent" | "bubble" });

  const applyChatStyle = (style: "accent" | "bubble", scope?: ConfigScope) => {
    ctx.setChatStyle(style);
    ctx.saveToScope(patch(style), scope ?? "project");
    sysMsg(ctx, `Chat style: ${style} (${scope ?? "project"})`);
  };

  if (arg === "accent" || arg === "bubble") {
    applyChatStyle(arg);
  } else {
    ctx.openCommandPicker({
      title: "Chat Style",
      icon: icon("chat_style"),
      currentValue: ctx.chatStyle,
      scopeEnabled: true,
      initialScope: ctx.detectScope("chatStyle"),
      options: [
        { value: "accent", label: "Accent", description: "colored left-border for messages" },
        { value: "bubble", label: "Bubble", description: "rounded bubble chat layout" },
      ],
      onSelect: (value, scope) => applyChatStyle(value as "accent" | "bubble", scope),
      onScopeMove: (value, from, to) => {
        ctx.setChatStyle(value as "accent" | "bubble");
        ctx.saveToScope(patch(value), to, from);
      },
    });
  }
}

function handleMode(input: string, ctx: CommandContext): void {
  const trimmed = input.trim();
  const modeName = trimmed.slice(5).trim().toLowerCase();
  const validModes = ["default", "architect", "socratic", "challenge", "plan", "auto"] as const;
  type Mode = (typeof validModes)[number];
  const patch = (v: string) => ({ defaultForgeMode: v as Mode });

  const applyMode = (mode: Mode, scope?: ConfigScope) => {
    ctx.setForgeMode(mode);
    ctx.saveToScope(patch(mode), scope ?? "project");
    sysMsg(ctx, `Forge mode set to: ${mode} (${scope ?? "project"})`);
  };

  const matched = validModes.find((m) => m === modeName);
  if (matched) {
    applyMode(matched);
  } else if (modeName && !matched) {
    sysMsg(
      ctx,
      `Unknown mode: ${modeName}. Available: default, architect, socratic, challenge, plan, auto`,
    );
  } else {
    ctx.openCommandPicker({
      title: "Forge Mode",
      icon: icon("ai"),
      currentValue: ctx.currentMode,
      scopeEnabled: true,
      initialScope: ctx.detectScope("defaultForgeMode"),
      options: [
        {
          value: "default",
          label: "Default",
          description: "standard assistant — implements directly",
          color: getThemeTokens().textSecondary,
        },
        {
          value: "architect",
          label: "Architect",
          description: "design only — outlines, tradeoffs, no code",
          color: getThemeTokens().brand,
        },
        {
          value: "socratic",
          label: "Socratic",
          description: "asks probing questions before implementing",
          color: getThemeTokens().warning,
        },
        {
          value: "challenge",
          label: "Challenge",
          description: "devil's advocate — challenges every assumption",
          color: getThemeTokens().brandSecondary,
        },
        {
          value: "plan",
          label: "Plan",
          description: "research & plan only — no file edits or shell",
          color: getThemeTokens().info,
        },
        {
          value: "auto",
          label: "Auto",
          description: "autonomous execution — minimal questions, action over planning",
          color: getThemeTokens().success,
        },
      ],
      onSelect: (value, scope) => applyMode(value as Mode, scope),
      onScopeMove: (value, from, to) => {
        ctx.setForgeMode(value as Mode);
        ctx.saveToScope(patch(value), to, from);
      },
    });
  }
}

function handleNvimConfig(input: string, ctx: CommandContext): void {
  const trimmed = input.trim();
  const arg = trimmed.slice(13).trim().toLowerCase();
  const validModes = ["default", "user", "none"] as const;
  const matched = validModes.find((m) => m === arg);

  const applyNvimConfig = (mode: (typeof validModes)[number], scope?: ConfigScope) => {
    ctx.saveToScope({ nvimConfig: mode }, scope ?? "project");
    sysMsg(
      ctx,
      `Neovim config set to: ${mode} (${scope ?? "project"})\nReopen the editor (Ctrl+E twice) for changes to take effect.`,
    );
  };

  if (matched) {
    applyNvimConfig(matched);
  } else {
    ctx.openCommandPicker({
      title: "Neovim Config",
      icon: icon("nvim"),
      currentValue: ctx.effectiveNvimConfig ?? "default",
      scopeEnabled: true,
      initialScope: ctx.detectScope("nvimConfig"),
      options: [
        {
          value: "default",
          label: "Default",
          description: "always use SoulForge's shipped init.lua",
        },
        { value: "user", label: "User", description: "always use your own nvim config" },
        { value: "none", label: "None", description: "bare neovim, no config at all" },
      ],
      onSelect: (value, scope) => applyNvimConfig(value as (typeof validModes)[number], scope),
      onScopeMove: (value, from, to) =>
        ctx.saveToScope({ nvimConfig: value as (typeof validModes)[number] }, to, from),
    });
  }
}

const handleVerbose = createTogglePicker({
  configKey: "verbose",
  title: "Verbose Mode",
  iconName: "verbose",
  onValue: "on",
  offValue: "off",
  onLabel: "On",
  offLabel: "Off",
  onDescription: "show full tool call output in chat",
  offDescription: "show compact tool call summaries",
  messageTemplate: (v, s) => `Verbose mode ${v === "on" ? "on" : "off"} (${s})`,
});

function handleTimeouts(_input: string, ctx: CommandContext): void {
  const cfg = loadConfig();
  const currentToolTimeout = cfg.toolTimeout ?? 2;
  const watchdogEnabled = cfg.watchdog ?? false;
  const wd = cfg.watchdogTimeouts ?? {};

  const currentTool = `tool:${currentToolTimeout}`;
  const wdFirstSec = (wd.firstChunkMs ?? 180_000) / 1000;
  const wdChunkSec = (wd.chunkMs ?? 120_000) / 1000;
  const wdToolSec = (wd.toolMaxMs ?? 900_000) / 1000;
  const wdForceSec = (wd.forceResolveMs ?? 5_000) / 1000;

  const wdFirst = `wd-first:${wdFirstSec}`;
  const wdChunk = `wd-chunk:${wdChunkSec}`;
  const wdTool = `wd-tool:${wdToolSec}`;
  const wdForce = `wd-force:${wdForceSec}`;

  // Lookup table: category → picker config
  const timeoutPickers: Record<string, CommandHandler> = {
    "tool-timeout": (_input: string, ctx: CommandContext) => {
      ctx.openCommandPicker({
        title: "Tool Timeout",
        icon: icon("clock"),
        currentValue: currentTool,
        scopeEnabled: false,
        options: [
          { value: "tool:1", label: "1 min" },
          { value: "tool:2", label: "2 min", description: "default" },
          { value: "tool:5", label: "5 min" },
          { value: "tool:10", label: "10 min" },
          { value: "tool:20", label: "20 min" },
          { value: "tool:0", label: "No timeout", description: "tools run until completion" },
        ],
        onSelect: (value) => {
          const timeout = Number(value.split(":")[1]);
          ctx.saveToScope({ toolTimeout: timeout }, "global");
          sysMsg(ctx, `Tool timeout → ${timeout === 0 ? "none" : `${timeout}m`} (global)`);
        },
      });
    },
    "watchdog-toggle": (_input: string, ctx: CommandContext) => {
      ctx.openCommandPicker({
        title: "Watchdog",
        icon: icon("clock"),
        currentValue: watchdogEnabled ? "watchdog:on" : "watchdog:off",
        scopeEnabled: false,
        options: [
          {
            value: "watchdog:on",
            label: "Watchdog: On",
            description: "enable auto-retry on stalls",
          },
          {
            value: "watchdog:off",
            label: "Watchdog: Off",
            description: "disable auto-retry on stalls",
          },
        ],
        onSelect: (value) => {
          const enabled = value === "watchdog:on";
          ctx.saveToScope({ watchdog: enabled }, "global");
          sysMsg(ctx, `Watchdog ${enabled ? "enabled" : "disabled"} (global)`);
        },
      });
    },
    "wd-first": (_input: string, ctx: CommandContext) => {
      ctx.openCommandPicker({
        title: "Watchdog — First Chunk Timeout",
        icon: icon("clock"),
        currentValue: wdFirst,
        scopeEnabled: false,
        options: [
          { value: "wd-first:5", label: "5s" },
          { value: "wd-first:15", label: "15s" },
          { value: "wd-first:30", label: "30s" },
          { value: "wd-first:60", label: "60s" },
          { value: "wd-first:120", label: "120s" },
          { value: "wd-first:180", label: "180s", description: "default" },
        ],
        onSelect: (value) => {
          const sec = Number(value.split(":")[1]);
          ctx.saveToScope({ watchdogTimeouts: { ...wd, firstChunkMs: sec * 1000 } }, "global");
          sysMsg(ctx, `Watchdog first-chunk timeout → ${sec}s (global)`);
        },
      });
    },
    "wd-chunk": (_input: string, ctx: CommandContext) => {
      ctx.openCommandPicker({
        title: "Watchdog — Chunk Timeout",
        icon: icon("clock"),
        currentValue: wdChunk,
        scopeEnabled: false,
        options: [
          { value: "wd-chunk:5", label: "5s" },
          { value: "wd-chunk:15", label: "15s" },
          { value: "wd-chunk:30", label: "30s" },
          { value: "wd-chunk:60", label: "60s" },
          { value: "wd-chunk:120", label: "120s", description: "default" },
          { value: "wd-chunk:180", label: "180s" },
        ],
        onSelect: (value) => {
          const sec = Number(value.split(":")[1]);
          ctx.saveToScope({ watchdogTimeouts: { ...wd, chunkMs: sec * 1000 } }, "global");
          sysMsg(ctx, `Watchdog chunk timeout → ${sec}s (global)`);
        },
      });
    },
    "wd-tool": (_input: string, ctx: CommandContext) => {
      ctx.openCommandPicker({
        title: "Watchdog — Tool Max Timeout",
        icon: icon("clock"),
        currentValue: wdTool,
        scopeEnabled: false,
        options: [
          { value: "wd-tool:60", label: "1 min" },
          { value: "wd-tool:300", label: "5 min" },
          { value: "wd-tool:600", label: "10 min" },
          { value: "wd-tool:900", label: "15 min", description: "default" },
          { value: "wd-tool:1800", label: "30 min" },
          { value: "wd-tool:3600", label: "60 min" },
        ],
        onSelect: (value) => {
          const sec = Number(value.split(":")[1]);
          ctx.saveToScope({ watchdogTimeouts: { ...wd, toolMaxMs: sec * 1000 } }, "global");
          sysMsg(ctx, `Watchdog tool-max timeout → ${sec}s (global)`);
        },
      });
    },
    "wd-force": (_input: string, ctx: CommandContext) => {
      ctx.openCommandPicker({
        title: "Watchdog — Force-Resolve Timeout",
        icon: icon("clock"),
        currentValue: wdForce,
        scopeEnabled: false,
        options: [
          { value: "wd-force:1", label: "1s" },
          { value: "wd-force:5", label: "5s", description: "default" },
          { value: "wd-force:10", label: "10s" },
          { value: "wd-force:30", label: "30s" },
        ],
        onSelect: (value) => {
          const sec = Number(value.split(":")[1]);
          ctx.saveToScope({ watchdogTimeouts: { ...wd, forceResolveMs: sec * 1000 } }, "global");
          sysMsg(ctx, `Watchdog force-resolve timeout → ${sec}s (global)`);
        },
      });
    },
  };

  // Top-level categories picker
  ctx.openCommandPicker({
    title: "Timeouts & Watchdog",
    icon: icon("clock"),
    currentValue: currentTool,
    scopeEnabled: false,
    options: [
      {
        value: "tool-timeout",
        label: "Tool Timeout",
        description: `${currentToolTimeout === 0 ? "none" : currentToolTimeout + "m"}`,
      },
      { value: "watchdog-toggle", label: "Watchdog", description: watchdogEnabled ? "On" : "Off" },
      { value: "wd-first", label: "First Chunk Timeout", description: `${wdFirstSec}s` },
      { value: "wd-chunk", label: "Chunk Timeout", description: `${wdChunkSec}s` },
      { value: "wd-tool", label: "Tool Max Timeout", description: `${wdToolSec}s` },
      { value: "wd-force", label: "Force-Resolve Timeout", description: `${wdForceSec}s` },
    ],
    onSelect: (value) => {
      const handler = timeoutPickers[value];
      if (handler) {
        handler("", ctx);
      }
    },
  });
}

function handleLockIn(_input: string, ctx: CommandContext): void {
  const next = !ctx.lockIn;
  ctx.setLockIn(next);
  ctx.saveToScope({ lockIn: next }, "project");
  sysMsg(
    ctx,
    next
      ? "🔒 Locked in — narration hidden, tools + final answer only"
      : "🔓 Lock-in off — full narration visible",
  );
}

function handleReasoning(_input: string, ctx: CommandContext): void {
  const patch = (v: string) => ({ showReasoning: v === "on" });
  ctx.openCommandPicker({
    title: "Reasoning Display",
    icon: icon("brain"),
    currentValue: ctx.showReasoning ? "on" : "off",
    scopeEnabled: true,
    initialScope: ctx.detectScope("showReasoning"),
    options: [
      { value: "on", label: "On", description: "show reasoning content in chat" },
      { value: "off", label: "Off", description: "show thinking status only" },
    ],
    onSelect: (value, scope) => {
      ctx.setShowReasoning(value === "on");
      ctx.saveToScope(patch(value), scope ?? "project");
      sysMsg(ctx, `Reasoning ${value === "on" ? "visible" : "hidden"} (${scope ?? "project"})`);
    },
    onScopeMove: (value, from, to) => {
      ctx.setShowReasoning(value === "on");
      ctx.saveToScope(patch(value), to, from);
    },
  });
}

function handleCompaction(_input: string, ctx: CommandContext): void {
  type Strategy = import("../compaction/types.js").CompactionStrategy;
  let localStrategy = ctx.compactionStrategy as Strategy;

  const buildOptions = () => [
    {
      value: "v1",
      label: `V1 — LLM Summarization${localStrategy === "v1" ? " ●" : ""}`,
      description: "batch summarize with LLM when context is full",
    },
    {
      value: "v2",
      label: `V2 — Incremental Extraction${localStrategy === "v2" ? " ●" : ""}`,
      description: "extract structured state as-you-go, cheap gap-fill on compact (default)",
    },
    {
      value: "disabled",
      label: `Disabled${localStrategy === "disabled" ? " ●" : ""}`,
      description: "no auto-compaction — context will fill until the model's limit",
    },
  ];

  ctx.openCommandPicker({
    title: "Compaction",
    icon: icon("compact"),
    keepOpen: true,
    currentValue: localStrategy,
    scopeEnabled: true,
    initialScope: ctx.detectScope("compaction"),
    options: buildOptions(),
    onSelect: (value, scope) => {
      localStrategy = value as Strategy;
      ctx.saveToScope({ compaction: { strategy: localStrategy } }, scope ?? "project");
      sysMsg(ctx, `Compaction strategy: ${value} (${scope ?? "project"})`);
      useUIStore.getState().updatePickerOptions(buildOptions());
    },
    onScopeMove: (_value, from, to) => {
      ctx.saveToScope({ compaction: { strategy: localStrategy } }, to, from);
    },
  });
}

function handleAgentFeatures(_input: string, ctx: CommandContext): void {
  const featureDesc: Record<string, string> = {
    desloppify: "cleanup pass after code agents (needs model in /router)",
    verifyEdits: "adversarial review after code agents (needs exploration model)",
    tierRouting: "auto-route trivial tasks to cheaper models",
    dispatchCache: "cache file reads across dispatch boundaries",
    targetFileValidation: "require file paths on dispatch tasks",
  };
  const featureLabel: Record<string, string> = {
    desloppify: "De-sloppify",
    verifyEdits: "Verify Edits",
    tierRouting: "Tier Routing",
    dispatchCache: "Dispatch Cache",
    targetFileValidation: "Target File Validation",
  };
  // Features that default to off when not explicitly set in config
  const defaultOff = new Set(["desloppify", "verifyEdits"]);
  const isOn = (key: string, state: Record<string, unknown>) =>
    defaultOff.has(key) ? state[key] === true : state[key] !== false;
  const localState = { ...ctx.agentFeatures };
  const buildOptions = () =>
    Object.entries(featureLabel).map(([key, label]) => ({
      value: key,
      label: `${label}: ${isOn(key, localState as Record<string, unknown>) ? "on" : "off"}`,
      description: featureDesc[key] ?? "",
    }));
  ctx.openCommandPicker({
    title: "Agent Features",
    icon: icon("system"),
    keepOpen: true,
    currentValue: "",
    options: buildOptions(),
    scopeEnabled: true,
    initialScope: ctx.detectScope("agentFeatures"),
    onSelect: (value, scope) => {
      const key = value as keyof AgentFeatures;
      const current = isOn(key, localState as Record<string, unknown>);
      (localState as Record<string, unknown>)[key] = !current;
      ctx.saveToScope({ agentFeatures: { [key]: !current } }, scope ?? "project");
      sysMsg(
        ctx,
        `Agent feature "${key}" ${!current ? "enabled" : "disabled"} (${scope ?? "project"})`,
      );
      useUIStore.getState().updatePickerOptions(buildOptions());
    },
    onScopeMove: (value, from, to) => {
      const key = value as keyof AgentFeatures;
      const current = isOn(key, localState as Record<string, unknown>);
      ctx.saveToScope({ agentFeatures: { [key]: current } }, to, from);
    },
  });
}

async function handleInstructions(_input: string, ctx: CommandContext): Promise<void> {
  const { INSTRUCTION_SOURCES, loadInstructions, buildInstructionPrompt } = await import(
    "../instructions.js"
  );
  const currentEnabled = new Set<string>(
    ctx.instructionFiles ??
      INSTRUCTION_SOURCES.filter((s: { defaultEnabled: boolean }) => s.defaultEnabled).map(
        (s: { id: string }) => s.id,
      ),
  );
  const loaded = loadInstructions(ctx.cwd, [...currentEnabled]);
  const loadedIds = new Set(loaded.map((l: { source: string }) => l.source));

  const buildOptions = () =>
    INSTRUCTION_SOURCES.map((s: { id: string; label: string; files: string[] }) => {
      const enabled = currentEnabled.has(s.id);
      const found = loadedIds.has(s.id);
      const suffix = enabled ? (found ? "" : " (not found)") : "";
      return {
        value: s.id,
        icon: enabled ? "✓" : " ",
        color: enabled
          ? found
            ? getThemeTokens().success
            : getThemeTokens().warning
          : getThemeTokens().textMuted,
        label: `${s.label}${suffix}`,
      };
    });

  ctx.openCommandPicker({
    title: "Instruction Files",
    icon: icon("system"),
    keepOpen: true,
    currentValue: "",
    options: buildOptions(),
    scopeEnabled: true,
    initialScope: ctx.detectScope("instructionFiles"),
    onSelect: (value, scope) => {
      if (currentEnabled.has(value)) {
        currentEnabled.delete(value);
      } else {
        currentEnabled.add(value);
      }
      const ids = [...currentEnabled];
      ctx.saveToScope({ instructionFiles: ids }, scope ?? "project");

      const freshLoaded = loadInstructions(ctx.cwd, ids);
      loadedIds.clear();
      for (const l of freshLoaded) loadedIds.add(l.source);

      ctx.contextManager.setProjectInstructions(buildInstructionPrompt(freshLoaded));

      sysMsg(
        ctx,
        `Instruction file "${value}" ${currentEnabled.has(value) ? "enabled" : "disabled"} (${scope ?? "project"})`,
      );
      useUIStore.getState().updatePickerOptions(buildOptions());
    },
    onScopeMove: (_value, from, to) => {
      ctx.saveToScope({ instructionFiles: [...currentEnabled] }, to, from);
    },
  });
}

function handleDiffStyle(_input: string, ctx: CommandContext): void {
  const patch = (v: string) => ({ diffStyle: v as "default" | "sidebyside" | "compact" });
  let collapse = ctx.collapseDiffs;
  ctx.openCommandPicker({
    title: "Diff Style",
    icon: icon("git"),
    scopeEnabled: true,
    initialScope: ctx.detectScope("diffStyle"),
    options: [
      {
        value: "default",
        label: "Default",
        description: "Full inline diff with syntax highlighting",
        icon: icon("file"),
      },
      {
        value: "sidebyside",
        label: "Side by Side",
        description: "Old and new shown in columns",
        icon: icon("panel"),
      },
      {
        value: "compact",
        label: "Compact",
        description: "File name + line count summary only",
        icon: icon("compact"),
      },
    ],
    currentValue: ctx.diffStyle,
    toggles: [
      {
        key: "tab",
        label: `Collapse diffs: ${collapse ? "on" : "off"}`,
        value: collapse,
        onToggle: () => {
          collapse = !collapse;
          ctx.saveToScope({ collapseDiffs: collapse }, ctx.detectScope("collapseDiffs"));
          return `Collapse diffs: ${collapse ? "on" : "off"}`;
        },
      },
    ],
    onSelect: (value, scope) => {
      ctx.saveToScope(patch(value), scope ?? "project");
      sysMsg(ctx, `Diff style: ${value} (${scope ?? "project"})`);
    },
    onScopeMove: (value, from, to) => ctx.saveToScope(patch(value), to, from),
  });
}

function handleSplit(_input: string, ctx: CommandContext): void {
  const { cycleEditorSplit } = useUIStore.getState();
  cycleEditorSplit();
  const newSplit = useUIStore.getState().editorSplit;
  ctx.saveToScope({ editorSplit: newSplit }, "global");
  sysMsg(ctx, `Editor split: ${String(newSplit)}/${String(100 - newSplit)}`);
}

const handleVimHints = createTogglePicker({
  configKey: "vimHints",
  title: "Vim Hints",
  iconName: "nvim",
  onValue: "visible",
  offValue: "hidden",
  onLabel: "Visible",
  offLabel: "Hidden",
  onDescription: "show vim keybinding hints in editor",
  offDescription: "hide vim keybinding hints",
  messageTemplate: (v, s) => `Vim hints ${v === "visible" ? "visible" : "hidden"} (${s})`,
});

function handleModelScope(_input: string, ctx: CommandContext): void {
  ctx.openCommandPicker({
    title: "Model Scope",
    icon: icon("settings"),
    currentValue: ctx.detectScope("defaultModel"),
    options: [
      { value: "global", label: "Global", description: "model choice applies to all projects" },
      {
        value: "project",
        label: "Project",
        description: "model choice is specific to this project",
      },
    ],
    onSelect: (value, _scope) => {
      const current = ctx.chat.activeModel;
      if (current !== "none") {
        const from = ctx.detectScope("defaultModel");
        const to = value as ConfigScope;
        if (from !== to) {
          ctx.saveToScope({ defaultModel: current }, to, from);
        }
      }
      sysMsg(ctx, `Model scope: ${value}`);
    },
  });
}

function handleNerdFont(_input: string, ctx: CommandContext): void {
  ctx.openCommandPicker({
    title: "Nerd Font",
    icon: icon("ghost"),
    options: [
      { value: "yes", label: "Yes", description: "Terminal uses a Nerd Font" },
      { value: "no", label: "No", description: "Use ASCII fallback icons" },
    ],
    onSelect: (value) => {
      setNerdFont(value === "yes");
      ctx.saveToScope({ nerdFont: value === "yes" }, "global");
      sysMsg(
        ctx,
        `Nerd Font ${value === "yes" ? "enabled" : "disabled"} (global). Restart for full effect.`,
      );
    },
  });
}

const settingsHandlers: Record<string, (input: string, ctx: CommandContext) => void> = {
  mode: handleMode,
  "chat-style": handleChatStyle,
  verbose: handleVerbose as CommandHandler,
  reasoning: handleReasoning,
  "lock-in": handleLockIn,
  compaction: handleCompaction,
  "diff-style": handleDiffStyle,
  "agent-features": handleAgentFeatures,
  instructions: handleInstructions as CommandHandler,
  "nvim-config": handleNvimConfig,
  "vim-hints": handleVimHints as CommandHandler,
  "font nerd": handleNerdFont,
  font: handleFont,
  split: handleSplit,
  "model-scope": handleModelScope,
  timeouts: handleTimeouts,
};

function handleSettingsHub(_input: string, ctx: CommandContext): void {
  const mode = ctx.currentModeLabel ?? ctx.currentMode;
  const chatStyle = ctx.chatStyle ?? "accent";
  const verbose = ctx.verbose ? "on" : "off";
  const reasoning = ctx.showReasoning ? "on" : "off";
  const lockInStatus = ctx.lockIn ? "on" : "off";
  const compaction = ctx.compactionStrategy ?? "v2";
  const diffStyle = ctx.diffStyle ?? "default";
  const nvimConfig = ctx.effectiveNvimConfig ?? "default";
  const vimHints = ctx.vimHints ? "visible" : "hidden";

  ctx.openCommandPicker({
    title: "Settings",
    icon: icon("cog"),
    options: [
      { value: "mode", label: `${icon("ai")} Mode`, description: mode },
      { value: "chat-style", label: `${icon("chat_style")} Chat Style`, description: chatStyle },
      { value: "verbose", label: `${icon("verbose")} Verbose`, description: verbose },
      { value: "reasoning", label: `${icon("brain")} Reasoning`, description: reasoning },
      { value: "lock-in", label: `${icon("ghost")} Lock-in`, description: lockInStatus },
      { value: "compaction", label: `${icon("compact")} Compaction`, description: compaction },
      { value: "diff-style", label: `${icon("git")} Diff Style`, description: diffStyle },
      { value: "agent-features", label: `${icon("system")} Agent Features`, description: "toggle" },
      {
        value: "instructions",
        label: `${icon("system")} Instructions`,
        description: "toggle files",
      },
      { value: "nvim-config", label: `${icon("nvim")} Nvim Config`, description: nvimConfig },
      { value: "vim-hints", label: `${icon("pencil")} Vim Hints`, description: vimHints },
      { value: "nerd-font", label: `${icon("ghost")} Nerd Font`, description: "toggle" },
      { value: "font", label: `${icon("pencil")} Terminal Font`, description: "show/set" },
      { value: "split", label: `${icon("pencil")} Editor Split`, description: "cycle layout" },
      { value: "model-scope", label: `${icon("cog")} Model Scope`, description: "project/global" },
      {
        value: "editor-settings",
        label: `${icon("cog")} Editor Settings`,
        description: "LSP integrations",
      },
      {
        value: "timeouts",
        label: `${icon("clock")} Tool Timeout`,
        description: `${String(loadConfig().toolTimeout ?? 2)}m`,
      },
    ],
    onSelect: (value) => {
      const handler = settingsHandlers[value];
      if (handler) {
        handler(`/${value}`, ctx);
      } else if (value === "editor-settings") {
        ctx.openEditorSettings();
      }
    },
  });
}

const OPACITY_LEVELS = [0, 30, 70, 100] as const;
const OPACITY_OPTIONS = ["Clear", "Dim", "Subtle", "Solid"];

function opacityToIndex(opacity: number): number {
  const idx = OPACITY_LEVELS.indexOf(opacity as (typeof OPACITY_LEVELS)[number]);
  return idx >= 0 ? idx : OPACITY_LEVELS.length - 1;
}

type BorderStrengthOption = "default" | "strong" | "op";
const BORDER_STRENGTH_OPTIONS: BorderStrengthOption[] = ["default", "strong", "op"];
const BORDER_STRENGTH_LABELS = ["Default", "Strong", "OP"];

function themePatch(
  name: string,
  transparent: boolean,
  userMsgOp: number,
  diffOp: number,
  borderStr: BorderStrengthOption,
): Partial<AppConfig> {
  return {
    theme: {
      name,
      transparent,
      userMessageOpacity: userMsgOp,
      diffOpacity: diffOp,
      borderStrength: borderStr,
    },
  };
}

const handleTheme: CommandHandler = (input: string, ctx: CommandContext) => {
  const arg = input.replace(/^\/theme\s*/, "").trim();
  const current = useThemeStore.getState().name;
  const isTransparent = useThemeStore.getState().tokens.bgApp === "transparent";

  // Read saved settings from config
  const cfg = loadConfig();
  const savedMsgOpacity =
    typeof cfg.theme?.userMessageOpacity === "number" ? cfg.theme.userMessageOpacity : 100;
  const savedDiffOpacity = typeof cfg.theme?.diffOpacity === "number" ? cfg.theme.diffOpacity : 100;
  const savedBorderStr: BorderStrengthOption = cfg.theme?.borderStrength ?? "default";

  const applyAll = (
    name: string,
    tp: boolean,
    msgOp: number,
    diffOp: number,
    bdrStr: BorderStrengthOption,
  ) =>
    applyTheme(name, tp, {
      userMessageOpacity: msgOp,
      diffOpacity: diffOp,
      borderStrength: bdrStr,
    });

  if (!arg || arg === "list") {
    const themes = listThemes();
    const originalTheme = current;
    let transparent = isTransparent;
    let userMsgOpacity = savedMsgOpacity;
    let diffOpacity = savedDiffOpacity;
    let borderStr = savedBorderStr;

    ctx.openCommandPicker({
      title: "Theme",
      icon: icon("palette"),
      currentValue: current,
      searchable: true,
      maxWidth: 60,
      options: themes.map((th) => ({
        value: th.id,
        label: `${th.variant === "light" ? "☀" : "☾"} ${th.label}`,
        icon: "■■",
        color: th.brand,
      })),
      toggles: [
        {
          key: "tab",
          label: "Transparent",
          value: transparent,
          onToggle: () => {
            transparent = !transparent;
            const name = useThemeStore.getState().name;
            applyAll(name, transparent, userMsgOpacity, diffOpacity, borderStr);
            ctx.saveToScope(
              themePatch(name, transparent, userMsgOpacity, diffOpacity, borderStr),
              "global",
            );
          },
        },
      ],
      selectors: [
        {
          key: "m",
          label: "Message BG",
          options: OPACITY_OPTIONS,
          value: opacityToIndex(savedMsgOpacity),
          onChange: (idx) => {
            userMsgOpacity = OPACITY_LEVELS[idx] ?? 100;
            const name = useThemeStore.getState().name;
            applyAll(name, transparent, userMsgOpacity, diffOpacity, borderStr);
            ctx.saveToScope(
              themePatch(name, transparent, userMsgOpacity, diffOpacity, borderStr),
              "global",
            );
          },
        },
        {
          key: "d",
          label: "Diff BG",
          options: OPACITY_OPTIONS,
          value: opacityToIndex(savedDiffOpacity),
          onChange: (idx) => {
            diffOpacity = OPACITY_LEVELS[idx] ?? 100;
            const name = useThemeStore.getState().name;
            applyAll(name, transparent, userMsgOpacity, diffOpacity, borderStr);
            ctx.saveToScope(
              themePatch(name, transparent, userMsgOpacity, diffOpacity, borderStr),
              "global",
            );
          },
        },
        {
          key: "b",
          label: "Borders",
          options: BORDER_STRENGTH_LABELS,
          value: BORDER_STRENGTH_OPTIONS.indexOf(savedBorderStr),
          onChange: (idx) => {
            borderStr = BORDER_STRENGTH_OPTIONS[idx] ?? "default";
            const name = useThemeStore.getState().name;
            applyAll(name, transparent, userMsgOpacity, diffOpacity, borderStr);
            ctx.saveToScope(
              themePatch(name, transparent, userMsgOpacity, diffOpacity, borderStr),
              "global",
            );
          },
        },
      ],
      onCursorChange: (value) => {
        applyAll(value, transparent, userMsgOpacity, diffOpacity, borderStr);
      },
      onCancel: () => {
        // Revert theme name preview but keep any toggle/selector changes the user made
        applyAll(originalTheme, transparent, userMsgOpacity, diffOpacity, borderStr);
        ctx.saveToScope(
          themePatch(originalTheme, transparent, userMsgOpacity, diffOpacity, borderStr),
          "global",
        );
      },
      onSelect: (value) => {
        applyAll(value, transparent, userMsgOpacity, diffOpacity, borderStr);
        ctx.saveToScope(
          themePatch(value, transparent, userMsgOpacity, diffOpacity, borderStr),
          "global",
        );
        sysMsg(ctx, `Theme → ${value}`);
      },
    });
    return;
  }

  applyAll(arg, isTransparent, savedMsgOpacity, savedDiffOpacity, savedBorderStr);
  ctx.saveToScope(
    themePatch(arg, isTransparent, savedMsgOpacity, savedDiffOpacity, savedBorderStr),
    "global",
  );
  sysMsg(ctx, `Theme → ${arg}`);
};

export function register(map: Map<string, CommandHandler>): void {
  map.set("/chat-style", handleChatStyle);
  map.set("/mode", handleMode);
  map.set("/nvim-config", handleNvimConfig);
  map.set("/verbose", handleVerbose);
  map.set("/reasoning", handleReasoning);
  map.set("/compact settings", handleCompaction);
  map.set("/compaction", handleCompaction); // legacy alias
  map.set("/agent-features", handleAgentFeatures);
  map.set("/instructions", handleInstructions);
  map.set("/diff-style", handleDiffStyle);
  map.set("/editor split", handleSplit);
  map.set("/split", handleSplit); // legacy alias
  map.set("/vim-hints", handleVimHints);
  map.set("/model-scope", handleModelScope);
  map.set("/font nerd", handleNerdFont);
  map.set("/font set", handleFont);
  map.set("/settings", handleSettingsHub);
  map.set("/lock-in", handleLockIn);
  map.set("/theme", handleTheme);
  map.set("/timeouts", handleTimeouts);
  map.set("/watchdog", handleTimeouts); // alias for /timeouts
}

export function matchConfigPrefix(cmd: string): CommandHandler | null {
  if (cmd === "/font nerd") return handleNerdFont;
  if (cmd === "/font" || cmd === "/fonts" || cmd.startsWith("/font ") || cmd.startsWith("/fonts "))
    return handleFont;
  if (cmd === "/chat-style" || cmd.startsWith("/chat-style ")) return handleChatStyle;
  if (cmd === "/mode" || cmd.startsWith("/mode ")) return handleMode;
  if (cmd === "/nvim-config" || cmd.startsWith("/nvim-config ")) return handleNvimConfig;
  if (cmd === "/theme" || cmd.startsWith("/theme ")) return handleTheme;
  return null;
}
