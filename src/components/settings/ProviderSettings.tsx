import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import type {
  AppConfig,
  ContextManagementConfig,
  EffortLevel,
  PerformanceConfig,
  ThinkingMode,
} from "../../types/index.js";
import type { ConfigScope } from "../layout/shared.js";
import { CONFIG_SCOPES } from "../layout/shared.js";
import { Divider, Hint, PremiumPopup, SegmentedControl, VirtualList } from "../ui/index.js";

const MAX_POPUP_WIDTH = 110;
const CHROME_ROWS = 10;

type ItemType = "cycle" | "toggle" | "budget";

interface SettingRow {
  type: ItemType;
  key: string;
  label: string;
  desc: string;
  options?: string[];
}
interface SettingSection {
  type: "section";
  label: string;
}
type SettingItem = SettingRow | SettingSection;
function isSection(item: SettingItem): item is SettingSection {
  return item.type === "section";
}

type ProviderTab = "claude" | "openai" | "general";
const TABS: ProviderTab[] = ["claude", "openai", "general"];

const CLAUDE_ITEMS: SettingItem[] = [
  { type: "section", label: "Reasoning" },
  {
    key: "thinkingMode",
    label: "Thinking",
    desc: "Extended thinking mode. auto = adaptive · enabled = fixed budget",
    type: "cycle",
    options: ["off", "auto", "adaptive", "enabled"],
  },
  {
    key: "budgetTokens",
    label: "Budget",
    desc: "Token budget when thinking = enabled",
    type: "budget",
    options: ["1024", "2048", "5000", "10000", "20000"],
  },
  {
    key: "effort",
    label: "Effort",
    desc: "Reasoning depth across thinking, text, and tool calls",
    type: "cycle",
    options: ["off", "low", "medium", "high", "xhigh", "max"],
  },
  {
    key: "clearThinking",
    label: "Preserve thinking",
    desc: "Keep thinking blocks across turns for cache hits (requires thinking on)",
    type: "toggle",
  },
  { type: "section", label: "Performance" },
  {
    key: "speed",
    label: "Speed",
    desc: "Opus 4.6 only — 2.5× faster output",
    type: "cycle",
    options: ["off", "standard", "fast"],
  },
  {
    key: "toolStreaming",
    label: "Tool streaming",
    desc: "Stream tool call args incrementally",
    type: "toggle",
  },
  {
    key: "sendReasoning",
    label: "Send reasoning",
    desc: "Include reasoning content in multi-turn requests",
    type: "toggle",
  },
  { type: "section", label: "Beta tools" },
  {
    key: "codeExecution",
    label: "Code execution",
    desc: "Programmatic tool calling — batches reads in Python",
    type: "toggle",
  },
  {
    key: "computerUse",
    label: "Computer use",
    desc: "Keyboard / mouse / screenshot control",
    type: "toggle",
  },
  {
    key: "anthropicTextEditor",
    label: "Text editor",
    desc: "Anthropic str_replace editor tool",
    type: "toggle",
  },
  { type: "section", label: "Server context" },
  {
    key: "compact",
    label: "Server compaction",
    desc: "Anthropic server-side compaction (200K+ models)",
    type: "toggle",
  },
  {
    key: "clearToolUses",
    label: "Clear old tool uses",
    desc: "Drop old tool results at 65% ctx. Busts prompt cache when it fires",
    type: "toggle",
  },
];

const OPENAI_ITEMS: SettingItem[] = [
  { type: "section", label: "Reasoning" },
  {
    key: "openaiReasoningEffort",
    label: "Effort",
    desc: "o3 · o4 · gpt-5 — reasoning depth",
    type: "cycle",
    options: ["off", "none", "minimal", "low", "medium", "high", "xhigh"],
  },
  { type: "section", label: "Service" },
  {
    key: "serviceTier",
    label: "Service tier",
    desc: "flex = 50% cheaper · priority = fastest (Enterprise)",
    type: "cycle",
    options: ["off", "auto", "default", "flex", "priority"],
  },
];

const GENERAL_ITEMS: SettingItem[] = [
  { type: "section", label: "Tools" },
  {
    key: "disableParallelToolUse",
    label: "Sequential tools",
    desc: "Run tools one at a time instead of parallel (all providers)",
    type: "toggle",
  },
  {
    key: "webSearch",
    label: "Web search",
    desc: "Allow the web search tool",
    type: "toggle",
  },
  { type: "section", label: "Context" },
  {
    key: "pruning",
    label: "Tool result pruning",
    desc: "Client-side — compact old tool results",
    type: "cycle",
    options: ["none", "main", "subagents", "both"],
  },
];

const TAB_ITEMS: Record<ProviderTab, SettingItem[]> = {
  claude: CLAUDE_ITEMS,
  openai: OPENAI_ITEMS,
  general: GENERAL_ITEMS,
};

interface CurrentValues {
  thinkingMode: ThinkingMode;
  budgetTokens: number;
  effort: string;
  speed: "off" | "standard" | "fast";
  sendReasoning: boolean;
  toolStreaming: boolean;
  disableParallelToolUse: boolean;
  openaiReasoningEffort: string;
  serviceTier: string;
  codeExecution: boolean;
  computerUse: boolean;
  anthropicTextEditor: boolean;
  webSearch: boolean;
  compact: boolean;
  clearToolUses: boolean;
  clearThinking: boolean;
  pruning: string;
}

const DEFAULTS: CurrentValues = {
  thinkingMode: "off",
  budgetTokens: 10000,
  effort: "off",
  speed: "off",
  sendReasoning: false,
  toolStreaming: true,
  disableParallelToolUse: false,
  openaiReasoningEffort: "off",
  serviceTier: "off",
  codeExecution: true,
  computerUse: false,
  anthropicTextEditor: false,
  webSearch: true,
  compact: false,
  clearToolUses: false,
  clearThinking: true,
  pruning: "none",
};

function readValuesFromLayer(layer: Partial<AppConfig> | null): Partial<CurrentValues> {
  if (!layer) return {};
  const v: Partial<CurrentValues> = {};
  if (layer.thinking?.mode !== undefined) v.thinkingMode = layer.thinking.mode;
  if (layer.thinking?.budgetTokens !== undefined) v.budgetTokens = layer.thinking.budgetTokens;
  if (layer.performance?.effort !== undefined) v.effort = layer.performance.effort;
  if (layer.performance?.speed !== undefined) v.speed = layer.performance.speed;
  if (layer.performance?.sendReasoning !== undefined)
    v.sendReasoning = layer.performance.sendReasoning;
  if (layer.performance?.toolStreaming !== undefined)
    v.toolStreaming = layer.performance.toolStreaming;
  if (layer.performance?.disableParallelToolUse !== undefined)
    v.disableParallelToolUse = layer.performance.disableParallelToolUse;
  if (layer.performance?.openaiReasoningEffort !== undefined)
    v.openaiReasoningEffort = layer.performance.openaiReasoningEffort;
  if (layer.performance?.serviceTier !== undefined) v.serviceTier = layer.performance.serviceTier;
  if (layer.codeExecution !== undefined) v.codeExecution = layer.codeExecution;
  if (layer.computerUse !== undefined) v.computerUse = layer.computerUse;
  if (layer.anthropicTextEditor !== undefined) v.anthropicTextEditor = layer.anthropicTextEditor;
  if (layer.webSearch !== undefined) v.webSearch = layer.webSearch;
  if (layer.contextManagement?.compact !== undefined) v.compact = layer.contextManagement.compact;
  if (layer.contextManagement?.clearToolUses !== undefined)
    v.clearToolUses = layer.contextManagement.clearToolUses;
  if (layer.contextManagement?.clearThinking !== undefined)
    v.clearThinking = layer.contextManagement.clearThinking;
  if (layer.contextManagement?.pruningTarget !== undefined)
    v.pruning = layer.contextManagement.pruningTarget;
  else if (layer.contextManagement?.disablePruning !== undefined)
    v.pruning = layer.contextManagement.disablePruning ? "none" : "subagents";
  return v;
}

function effectiveValues(global: AppConfig, project: Partial<AppConfig> | null): CurrentValues {
  const g = { ...DEFAULTS, ...readValuesFromLayer(global) };
  const p = readValuesFromLayer(project);
  return { ...g, ...p };
}

function buildPatch(key: string, value: string | number | boolean): Partial<AppConfig> {
  switch (key) {
    case "thinkingMode":
      return { thinking: { mode: value as ThinkingMode } };
    case "budgetTokens":
      return { thinking: { mode: "enabled", budgetTokens: value as number } };
    case "effort":
      return { performance: { effort: value as EffortLevel | "off" } as PerformanceConfig };
    case "speed":
      return { performance: { speed: value as "off" | "standard" | "fast" } as PerformanceConfig };
    case "sendReasoning":
      return { performance: { sendReasoning: value as boolean } as PerformanceConfig };
    case "toolStreaming":
      return { performance: { toolStreaming: value as boolean } as PerformanceConfig };
    case "disableParallelToolUse":
      return { performance: { disableParallelToolUse: value as boolean } as PerformanceConfig };
    case "openaiReasoningEffort":
      return { performance: { openaiReasoningEffort: value as string } as PerformanceConfig };
    case "serviceTier":
      return { performance: { serviceTier: value as string } as PerformanceConfig };
    case "codeExecution":
      return { codeExecution: value as boolean };
    case "computerUse":
      return { computerUse: value as boolean };
    case "anthropicTextEditor":
      return { anthropicTextEditor: value as boolean };
    case "webSearch":
      return { webSearch: value as boolean };
    case "compact":
      return { contextManagement: { compact: value as boolean } as ContextManagementConfig };
    case "clearToolUses":
      return { contextManagement: { clearToolUses: value as boolean } as ContextManagementConfig };
    case "clearThinking":
      return { contextManagement: { clearThinking: value as boolean } as ContextManagementConfig };
    case "pruning":
      return {
        contextManagement: { pruningTarget: value as string } as ContextManagementConfig,
      };
    default:
      return {};
  }
}

function detectValueScope(key: string, project: Partial<AppConfig> | null): ConfigScope {
  const pv = readValuesFromLayer(project);
  if (key in pv) return "project";
  return "global";
}

function detectInitialScope(project: Partial<AppConfig> | null): ConfigScope {
  const pv = readValuesFromLayer(project);
  if (Object.keys(pv).length > 0) return "project";
  return "global";
}

interface Props {
  visible: boolean;
  globalConfig: AppConfig;
  projectConfig: Partial<AppConfig> | null;
  onUpdate: (patch: Partial<AppConfig>, toScope: ConfigScope, fromScope?: ConfigScope) => void;
  onClose: () => void;
}

export function ProviderSettings({
  visible,
  globalConfig,
  projectConfig,
  onUpdate,
  onClose,
}: Props) {
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const containerRows = termRows - 2;
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.85));
  const maxVisible = Math.max(6, Math.floor(containerRows * 0.85) - CHROME_ROWS);

  const t = useTheme();
  const [tab, setTab] = useState<ProviderTab>("claude");
  const [cursor, setCursor] = useState(0);
  const [scope, setScope] = useState<ConfigScope>(() => detectInitialScope(projectConfig));
  const vals = effectiveValues(globalConfig, projectConfig);

  const items = TAB_ITEMS[tab];
  const tabIdx = TABS.indexOf(tab);

  const firstRowIdx = items.findIndex((i) => !isSection(i));

  useEffect(() => {
    if (visible) setScope(detectInitialScope(projectConfig));
  }, [visible, projectConfig]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tab triggers scroll reset on tab change
  useEffect(() => {
    setCursor(Math.max(0, firstRowIdx));
  }, [tab]);

  const isBudgetDisabled = vals.thinkingMode !== "enabled";
  const isThinkingDisabled = vals.thinkingMode === "off" || vals.thinkingMode === "disabled";

  const isItemDisabled = (key: string): boolean => {
    if (key === "budgetTokens") return isBudgetDisabled;
    if (key === "clearThinking") return isThinkingDisabled;
    return false;
  };

  const stepCursor = (dir: 1 | -1) => {
    if (items.length === 0) return;
    let next = cursor;
    for (let i = 0; i < items.length; i++) {
      next = (next + dir + items.length) % items.length;
      const it = items[next];
      if (it && !isSection(it)) {
        setCursor(next);
        return;
      }
    }
  };

  const cycleValue = (item: SettingRow) => {
    if (item.type === "toggle") {
      if (isItemDisabled(item.key)) return;
      const current = vals[item.key as keyof CurrentValues] as boolean;
      onUpdate(buildPatch(item.key, !current), scope);
      return;
    }
    if (item.type === "budget") {
      if (isBudgetDisabled) return;
      const opts = item.options ?? [];
      const currentIdx = opts.indexOf(String(vals.budgetTokens));
      const nextIdx = (currentIdx + 1) % opts.length;
      onUpdate(buildPatch(item.key, Number(opts[nextIdx])), scope);
      return;
    }
    if (item.type === "cycle" && item.options) {
      const current = String(vals[item.key as keyof CurrentValues]);
      const currentIdx = item.options.indexOf(current);
      const nextIdx = (currentIdx + 1) % item.options.length;
      onUpdate(buildPatch(item.key, item.options[nextIdx] as string), scope);
    }
  };

  useKeyboard((evt) => {
    if (!visible) return;

    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "tab" || (evt.shift && evt.name === "tab")) {
      const dir = evt.shift ? -1 : 1;
      const next = (tabIdx + dir + TABS.length) % TABS.length;
      setTab(TABS[next] as ProviderTab);
      return;
    }
    if (evt.name === "up") {
      stepCursor(-1);
      return;
    }
    if (evt.name === "down") {
      stepCursor(1);
      return;
    }
    if (evt.name === "return" || evt.name === " ") {
      const item = items[cursor];
      if (item && !isSection(item)) cycleValue(item);
      return;
    }
    if (evt.name === "left" || evt.name === "right") {
      setScope((prev) => {
        const idx = CONFIG_SCOPES.indexOf(prev);
        const next =
          evt.name === "left"
            ? CONFIG_SCOPES[(idx - 1 + CONFIG_SCOPES.length) % CONFIG_SCOPES.length]
            : CONFIG_SCOPES[(idx + 1) % CONFIG_SCOPES.length];
        if (next && next !== prev) {
          const layer = prev === "project" ? projectConfig : globalConfig;
          const layerVals = readValuesFromLayer(layer);
          if (Object.keys(layerVals).length > 0) {
            const patch: Partial<AppConfig> = {};
            for (const [k, v] of Object.entries(layerVals)) {
              Object.assign(patch, buildPatch(k, v as string | number | boolean));
            }
            onUpdate(patch, next as ConfigScope, prev);
          }
        }
        return next ?? prev;
      });
      return;
    }
  });

  if (!visible) return null;

  const sidebarW = 22;
  const contentW = popupWidth - sidebarW - 3;
  const labelW = 22;

  const focusedItem = items[cursor];
  const focusedRow = focusedItem && !isSection(focusedItem) ? focusedItem : null;
  const focusedDisabled = focusedRow ? isItemDisabled(focusedRow.key) : false;

  return (
    <PremiumPopup
      visible={visible}
      width={popupWidth}
      height={Math.min(Math.max(20, Math.floor(termRows * 0.85)), termRows - 2)}
      title="Provider Options"
      titleIcon="system"
      tabs={[
        { id: "claude", label: "Claude", icon: "ai", blurb: "thinking · reasoning · beta" },
        { id: "openai", label: "OpenAI", icon: "ai", blurb: "reasoning · service tier" },
        { id: "general", label: "General", icon: "cloud", blurb: "shared options" },
      ]}
      activeTab={tab}
      footerHints={[
        { key: "Tab", label: "tab" },
        { key: "↑↓", label: "nav" },
        { key: "Enter", label: "cycle" },
        { key: "←→", label: "scope" },
        { key: "Esc", label: "close" },
      ]}
    >
      <box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        paddingX={2}
        paddingY={1}
        overflow="hidden"
      >
        {items.length === 0 ? (
          <Hint>No options for this provider yet.</Hint>
        ) : (
          <VirtualList
            items={items}
            selectedIndex={cursor}
            width={contentW}
            maxRows={maxVisible}
            rowHeight={1}
            keyExtractor={(item, idx) => (isSection(item) ? `sec-${idx}-${item.label}` : item.key)}
            renderItem={(item, { selected }) => {
              if (isSection(item)) {
                return (
                  <box flexDirection="row" backgroundColor={t.bgPopup} paddingX={1}>
                    <text bg={t.bgPopup} fg={t.textMuted} attributes={1}>
                      {item.label.toUpperCase()}
                    </text>
                    <text bg={t.bgPopup} fg={t.textFaint}>
                      {"  "}
                      {"─".repeat(Math.max(0, contentW - item.label.length - 6))}
                    </text>
                  </box>
                );
              }
              const disabled = isItemDisabled(item.key);
              const bg = selected ? t.bgPopupHighlight : t.bgPopup;
              const raw = vals[item.key as keyof CurrentValues];
              const srcScope = detectValueScope(item.key, projectConfig);
              const showScope = srcScope === "project";

              let body: React.ReactNode;
              if (item.type === "toggle") {
                const on = !!raw;
                body = (
                  <box flexDirection="row" backgroundColor={bg}>
                    <text bg={bg} fg={selected ? t.brand : t.textFaint}>
                      {selected ? "▸ " : "  "}
                    </text>
                    <text
                      bg={bg}
                      fg={disabled ? t.textDim : selected ? t.brand : t.textPrimary}
                      attributes={selected ? 1 : undefined}
                    >
                      {item.label.padEnd(labelW)}
                    </text>
                    <text bg={bg} fg={disabled ? t.textDim : on ? t.success : t.textDim}>
                      {on ? "● on " : "○ off"}
                    </text>
                    <box flexGrow={1} backgroundColor={bg} />
                    {showScope ? (
                      <text bg={bg} fg={t.info}>
                        proj
                      </text>
                    ) : null}
                  </box>
                );
              } else {
                const opts = item.options ?? [];
                const currentValue =
                  item.type === "budget" ? String(vals.budgetTokens) : String(raw);
                const valColor = disabled
                  ? t.textDim
                  : currentValue === "off"
                    ? t.textMuted
                    : t.brandAlt;
                body = (
                  <box flexDirection="row" backgroundColor={bg}>
                    <text bg={bg} fg={selected ? t.brand : t.textFaint}>
                      {selected ? "▸ " : "  "}
                    </text>
                    <text
                      bg={bg}
                      fg={disabled ? t.textDim : selected ? t.brand : t.textPrimary}
                      attributes={selected ? 1 : undefined}
                    >
                      {item.label.padEnd(labelW)}
                    </text>
                    <text bg={bg} fg={valColor} attributes={1}>
                      [{currentValue}]
                    </text>
                    <text bg={bg} fg={t.textFaint}>
                      {"  "}
                      {opts
                        .filter((o) => o !== currentValue)
                        .slice(0, 4)
                        .join(" · ")}
                    </text>
                    <box flexGrow={1} backgroundColor={bg} />
                    {showScope ? (
                      <text bg={bg} fg={t.info}>
                        proj
                      </text>
                    ) : null}
                  </box>
                );
              }

              return (
                <box
                  flexDirection="row"
                  flexShrink={0}
                  backgroundColor={bg}
                  paddingX={1}
                  height={1}
                >
                  {body}
                </box>
              );
            }}
          />
        )}
      </box>

      <Divider width={contentW} />
      <box flexDirection="column" paddingX={2} paddingY={1} backgroundColor={t.bgPopup}>
        {focusedRow ? (
          <box flexDirection="row" backgroundColor={t.bgPopup}>
            <text bg={t.bgPopup} fg={focusedDisabled ? t.textDim : t.textMuted}>
              {focusedRow.desc}
            </text>
          </box>
        ) : (
          <box flexDirection="row" backgroundColor={t.bgPopup}>
            <text bg={t.bgPopup} fg={t.textFaint}>
              {" "}
            </text>
          </box>
        )}
        <box flexDirection="row" backgroundColor={t.bgPopup}>
          <SegmentedControl
            label="Save to"
            labelWidth={8}
            options={CONFIG_SCOPES.map((s) => ({ value: s, label: s }))}
            value={scope}
          />
        </box>
      </box>
    </PremiumPopup>
  );
}
