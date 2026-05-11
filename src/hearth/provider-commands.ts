/**
 * Provider-settings slash commands for Hearth surfaces (Telegram/Discord).
 *
 * Mirrors a useful subset of the TUI's /provider-settings UI as one-shot
 * remote commands. Writes go to the *global* config (~/.soulforge/config.json)
 * via saveGlobalConfig — same path the settings UI uses — so changes apply
 * to every new turn after the patch is written.
 *
 * The implementation is intentionally provider-agnostic: each setting is a
 * SettingDef with a cycle/toggle/budget shape, identical to the React UI in
 * ProviderSettings.tsx. The handler is invoked from both TuiHost and the
 * daemon-side surface command switch with a small adapter (`notify`).
 */

import { loadConfig, saveGlobalConfig } from "../config/index.js";
import type {
  AppConfig,
  ContextManagementConfig,
  EffortLevel,
  PerformanceConfig,
  ThinkingMode,
} from "../types/index.js";

type Notify = (text: string) => void | Promise<void>;

type SettingType = "cycle" | "toggle" | "budget";

interface SettingDef {
  /** Slash command (without leading "/"). */
  cmd: string;
  /** Human label for /help. */
  label: string;
  /** Allowed values for "cycle". Booleans use on/off. Budget uses ints. */
  type: SettingType;
  options?: readonly string[];
  /** Read current value out of an effective config. */
  read: (cfg: AppConfig) => string;
  /** Build a saveGlobalConfig patch for the parsed value. */
  patch: (raw: string) => Partial<AppConfig>;
}

const THINKING_MODES = ["off", "disabled", "auto", "adaptive", "enabled"] as const;
const EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
const SPEEDS = ["off", "standard", "fast"] as const;
const OAI_EFFORTS = ["off", "none", "minimal", "low", "medium", "high", "xhigh"] as const;
const SERVICE_TIERS = ["off", "auto", "default", "flex", "priority"] as const;
const PRUNING = ["none", "main", "subagents", "both"] as const;

function showBool(v: boolean | undefined, fallback = false): string {
  return (v ?? fallback) ? "on" : "off";
}

function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "1" || v === "yes") return true;
  if (v === "off" || v === "false" || v === "0" || v === "no") return false;
  return null;
}

/** All supported settings. Keep cmd names short — they're typed on a phone. */
export const SETTINGS: SettingDef[] = [
  {
    cmd: "thinking",
    label: "thinking mode",
    type: "cycle",
    options: THINKING_MODES,
    read: (c) => c.thinking?.mode ?? "off",
    patch: (raw) => ({ thinking: { mode: raw as ThinkingMode } }),
  },
  {
    cmd: "budget",
    label: "thinking budget tokens",
    type: "budget",
    read: (c) => String(c.thinking?.budgetTokens ?? 10000),
    patch: (raw) => ({
      thinking: { mode: "enabled", budgetTokens: Number.parseInt(raw, 10) },
    }),
  },
  {
    cmd: "effort",
    label: "reasoning effort",
    type: "cycle",
    options: EFFORT_LEVELS,
    read: (c) => c.performance?.effort ?? "off",
    patch: (raw) => ({
      performance: { effort: raw as EffortLevel | "off" } as PerformanceConfig,
    }),
  },
  {
    cmd: "speed",
    label: "speed (Opus 4.6)",
    type: "cycle",
    options: SPEEDS,
    read: (c) => c.performance?.speed ?? "off",
    patch: (raw) => ({
      performance: { speed: raw as "off" | "standard" | "fast" } as PerformanceConfig,
    }),
  },
  {
    cmd: "reasoning",
    label: "OpenAI reasoning effort",
    type: "cycle",
    options: OAI_EFFORTS,
    read: (c) => c.performance?.openaiReasoningEffort ?? "off",
    patch: (raw) => ({
      performance: { openaiReasoningEffort: raw } as PerformanceConfig,
    }),
  },
  {
    cmd: "tier",
    label: "OpenAI service tier",
    type: "cycle",
    options: SERVICE_TIERS,
    read: (c) => c.performance?.serviceTier ?? "off",
    patch: (raw) => ({
      performance: { serviceTier: raw } as PerformanceConfig,
    }),
  },
  {
    cmd: "sendreasoning",
    label: "send reasoning across turns",
    type: "toggle",
    read: (c) => showBool(c.performance?.sendReasoning),
    patch: (raw) => ({
      performance: { sendReasoning: parseBool(raw) ?? false } as PerformanceConfig,
    }),
  },
  {
    cmd: "toolstream",
    label: "tool arg streaming",
    type: "toggle",
    read: (c) => showBool(c.performance?.toolStreaming, true),
    patch: (raw) => ({
      performance: { toolStreaming: parseBool(raw) ?? true } as PerformanceConfig,
    }),
  },
  {
    cmd: "seqtools",
    label: "sequential tool use",
    type: "toggle",
    read: (c) => showBool(c.performance?.disableParallelToolUse),
    patch: (raw) => ({
      performance: { disableParallelToolUse: parseBool(raw) ?? false } as PerformanceConfig,
    }),
  },
  {
    cmd: "codeexec",
    label: "code execution tool",
    type: "toggle",
    read: (c) => showBool(c.codeExecution, true),
    patch: (raw) => ({ codeExecution: parseBool(raw) ?? true }),
  },
  {
    cmd: "websearch",
    label: "web search tool",
    type: "toggle",
    read: (c) => showBool(c.webSearch, true),
    patch: (raw) => ({ webSearch: parseBool(raw) ?? true }),
  },
  {
    cmd: "computeruse",
    label: "computer use tool",
    type: "toggle",
    read: (c) => showBool(c.computerUse),
    patch: (raw) => ({ computerUse: parseBool(raw) ?? false }),
  },
  {
    cmd: "compact",
    label: "server-side compaction",
    type: "toggle",
    read: (c) => showBool(c.contextManagement?.compact),
    patch: (raw) => ({
      contextManagement: { compact: parseBool(raw) ?? false } as ContextManagementConfig,
    }),
  },
  {
    cmd: "cleartools",
    label: "clear old tool results (server)",
    type: "toggle",
    read: (c) => showBool(c.contextManagement?.clearToolUses),
    patch: (raw) => ({
      contextManagement: { clearToolUses: parseBool(raw) ?? false } as ContextManagementConfig,
    }),
  },
  {
    cmd: "clearthinking",
    label: "preserve thinking blocks",
    type: "toggle",
    read: (c) => showBool(c.contextManagement?.clearThinking, true),
    patch: (raw) => ({
      contextManagement: { clearThinking: parseBool(raw) ?? true } as ContextManagementConfig,
    }),
  },
  {
    cmd: "pruning",
    label: "tool-result pruning target",
    type: "cycle",
    options: PRUNING,
    read: (c) => c.contextManagement?.pruningTarget ?? "none",
    patch: (raw) => ({
      contextManagement: {
        pruningTarget: raw as "none" | "main" | "subagents" | "both",
      } as ContextManagementConfig,
    }),
  },
];

/** Slash-command names this module handles, with the leading "/". */
export const SETTINGS_COMMAND_NAMES: readonly string[] = [
  ...SETTINGS.map((s) => `/${s.cmd}`),
  "/settings",
];

function findSetting(cmdName: string): SettingDef | undefined {
  const bare = cmdName.startsWith("/") ? cmdName.slice(1) : cmdName;
  return SETTINGS.find((s) => s.cmd === bare);
}

/** Validate an incoming raw value against a SettingDef. Returns the canonical
 *  string to pass to .patch(), or an error message. */
export function validateSettingValue(
  setting: SettingDef,
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const v = raw.trim();
  if (!v) return { ok: false, error: "missing value" };
  if (setting.type === "toggle") {
    const b = parseBool(v);
    if (b === null) return { ok: false, error: `expected on|off, got "${v}"` };
    return { ok: true, value: b ? "on" : "off" };
  }
  if (setting.type === "cycle") {
    const lower = v.toLowerCase();
    const match = setting.options?.find((o) => o.toLowerCase() === lower);
    if (!match) {
      return {
        ok: false,
        error: `expected ${setting.options?.join("|") ?? "(none)"} — got "${v}"`,
      };
    }
    return { ok: true, value: match };
  }
  // budget — integer
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1024) {
    return { ok: false, error: "expected integer ≥ 1024" };
  }
  return { ok: true, value: String(n) };
}

/** Render the /settings overview — current values for every setting. */
export function renderSettingsOverview(cfg: AppConfig): string {
  const lines = ["━━ Provider settings ━━"];
  for (const s of SETTINGS) {
    lines.push(`/${s.cmd.padEnd(15)} ${s.read(cfg).padEnd(10)} ${s.label}`);
  }
  lines.push("");
  lines.push("set:   /<cmd> <value>");
  lines.push("show:  /<cmd>");
  return lines.join("\n");
}

/** /<cmd> with no arg → show. With arg → validate, patch global config. */
export interface HandleSettingsOptions {
  /** Override config readers — used by tests. */
  load?: () => AppConfig;
  save?: (patch: Partial<AppConfig>) => void;
}

export async function handleSettingsCommand(
  cmdName: string,
  args: string[],
  notify: Notify,
  opts: HandleSettingsOptions = {},
): Promise<boolean> {
  const load = opts.load ?? loadConfig;
  const save = opts.save ?? saveGlobalConfig;

  if (cmdName === "/settings") {
    await notify(renderSettingsOverview(load()));
    return true;
  }

  const setting = findSetting(cmdName);
  if (!setting) return false;

  const raw = args.join(" ").trim();
  if (!raw) {
    const current = setting.read(load());
    const opts = setting.options?.join("|") ?? (setting.type === "toggle" ? "on|off" : "<int>");
    await notify(`/${setting.cmd}: ${current}\noptions: ${opts}`);
    return true;
  }

  const parsed = validateSettingValue(setting, raw);
  if (!parsed.ok) {
    await notify(`✗ ${parsed.error}`);
    return true;
  }

  try {
    save(setting.patch(parsed.value));
  } catch (err) {
    await notify(`✗ save failed: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
  await notify(`✓ ${setting.cmd} → ${parsed.value}`);
  return true;
}

/** Lines appended to the in-chat /help output. */
export function settingsHelpLines(): string[] {
  return [
    "━━ Provider settings ━━",
    "/settings              show all current values",
    "/thinking [mode]       off | auto | enabled | adaptive | disabled",
    "/budget [N]            thinking budget tokens (≥1024)",
    "/effort [level]        off | low | medium | high | xhigh | max",
    "/speed [mode]          off | standard | fast (Opus 4.6)",
    "/reasoning [level]     OpenAI reasoning effort",
    "/tier [tier]           OpenAI service tier (flex|priority|auto…)",
    "/sendreasoning on|off  send reasoning across turns",
    "/toolstream on|off     stream tool args incrementally",
    "/seqtools on|off       sequential tool use",
    "/codeexec on|off       code execution tool",
    "/websearch on|off      web search tool",
    "/computeruse on|off    computer use tool",
    "/compact on|off        server-side context compaction",
    "/cleartools on|off     clear old tool results (server)",
    "/clearthinking on|off  preserve thinking blocks",
    "/pruning [target]      none | main | subagents | both",
  ];
}
