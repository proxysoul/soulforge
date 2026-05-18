import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useMemo, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import type { TaskRouter } from "../../types/index.js";
import type { ConfigScope } from "../layout/shared.js";
import { CONFIG_SCOPES } from "../layout/shared.js";
import {
  handleCursorNavKey,
  PremiumPopup,
  Section,
  SegmentedControl,
  VSpacer,
} from "../ui/index.js";

const BOLD = 1;

function getModelFallback(
  modelFallback: Record<string, string[]> | string[] | undefined,
  modelId: string,
): string[] {
  if (Array.isArray(modelFallback)) return modelFallback;
  return (
    (modelFallback?.[modelId] as string[] | undefined) ??
    (modelFallback?.["*"] as string[] | undefined) ??
    []
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return `${s.slice(0, max - 1)}…`;
}

interface SlotDef {
  kind: "slot";
  key: keyof TaskRouter;
  label: string;
  icon: string;
  hint: string;
}

interface PickerDef {
  kind: "picker";
  key: "maxConcurrentAgents";
  label: string;
  icon: string;
  hint: string;
  options: number[];
  defaultValue: number;
}

type Def = SlotDef | PickerDef;

interface SectionDef {
  id: string;
  title: string;
  subtitle?: string;
  defs: Def[];
}

const SECTIONS: SectionDef[] = [
  {
    id: "main",
    title: "Main",
    defs: [
      {
        kind: "slot",
        key: "default",
        label: "Default",
        icon: "model",
        hint: "Conversation & fallback",
      },
    ],
  },
  {
    id: "dispatch",
    title: "Dispatch",
    defs: [
      { kind: "slot", key: "spark", label: "Explore", icon: "read_only", hint: "Read-only agents" },
      { kind: "slot", key: "ember", label: "Code", icon: "edit", hint: "Edit agents" },
      {
        kind: "slot",
        key: "webSearch",
        label: "Web Search",
        icon: "web",
        hint: "Web search & fetch",
      },
      {
        kind: "picker",
        key: "maxConcurrentAgents",
        label: "Concurrency",
        icon: "dispatch",
        hint: "Max parallel agents",
        options: [2, 3, 4, 5, 6, 7, 8],
        defaultValue: 3,
      },
    ],
  },
  {
    id: "post",
    title: "Post-Dispatch",
    defs: [
      {
        kind: "slot",
        key: "desloppify",
        label: "Cleanup",
        icon: "cleanup",
        hint: "Polish & style fixes",
      },
      { kind: "slot", key: "verify", label: "Review", icon: "review", hint: "Adversarial review" },
    ],
  },
  {
    id: "bg",
    title: "Background",
    defs: [
      {
        kind: "slot",
        key: "compact",
        label: "Compaction",
        icon: "compact_task",
        hint: "Summarize old context",
      },
      {
        kind: "slot",
        key: "semantic",
        label: "Soul Map",
        icon: "repomap",
        hint: "Symbol summaries",
      },
    ],
  },
  {
    id: "fallback",
    title: "Model Fallback",
    subtitle: "Per-model fallback chains for transient errors",
    defs: [],
  },
];

const ALL_DEFS: Def[] = SECTIONS.flatMap((s) => s.defs);

interface Props {
  visible: boolean;
  router: TaskRouter | undefined;
  defaultModel: string;
  modelFallback: Record<string, string[]> | string[] | undefined;
  activeModel: string;
  scope: ConfigScope;
  onScopeChange: (toScope: ConfigScope, fromScope: ConfigScope) => void;
  onPickSlot: (slot: keyof TaskRouter) => void;
  onClearSlot: (slot: keyof TaskRouter) => void;
  onPickerChange: (key: "maxConcurrentAgents", value: number) => void;
  /** Add a fallback model to a specific model's fallback chain */
  onAddFallback: (modelId: string) => void;
  /** Clear all fallbacks for a model */
  onClearFallbacks: (modelId: string) => void;
  onClose: () => void;
}

export function RouterSettings({
  visible,
  router,
  defaultModel,
  modelFallback,
  activeModel,
  scope,
  onScopeChange,
  onPickSlot,
  onClearSlot,
  onPickerChange,
  onAddFallback,
  onClearFallbacks,
  onClose,
}: Props) {
  const t = useTheme();
  const { width: tw, height: th } = useTerminalDimensions();
  const [cursor, setCursor] = useState(0);

  const popupW = Math.min(100, Math.max(72, Math.floor(tw * 0.78)));
  const popupH = Math.min(40, Math.max(26, th - 4));
  const contentW = popupW - 4;

  // Models in use: default + every router slot model. Stable per-render.
  const modelsInUse = useMemo(() => {
    const set = new Set<string>();
    if (defaultModel) set.add(defaultModel);
    if (router) {
      const keys: (keyof TaskRouter)[] = [
        "default",
        "spark",
        "ember",
        "webSearch",
        "desloppify",
        "verify",
        "compact",
        "semantic",
      ];
      for (const k of keys) {
        const v = router[k];
        if (typeof v === "string" && v.trim()) set.add(v);
      }
    }
    return Array.from(set);
  }, [router, defaultModel]);

  // Flatten sections into navigable rows: [section header, slot, …, picker, …]
  type Row =
    | { kind: "header"; section: SectionDef }
    | { kind: "slot"; section: SectionDef; def: SlotDef }
    | { kind: "picker"; section: SectionDef; def: PickerDef }
    | { kind: "fallback"; section: SectionDef; modelId: string };
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const s of SECTIONS) {
      out.push({ kind: "header", section: s });
      if (s.id === "fallback") {
        for (const modelId of modelsInUse) {
          out.push({ kind: "fallback", section: s, modelId });
        }
        continue;
      }
      for (const d of s.defs) {
        if (d.kind === "slot") out.push({ kind: "slot", section: s, def: d });
        else out.push({ kind: "picker", section: s, def: d });
      }
    }
    return out;
  }, [modelsInUse]);

  // Find indices of selectable rows (slots + pickers + fallback rows) so cursor skips headers.
  const selectableIndices = useMemo(
    () => rows.map((r, i) => (r.kind === "header" ? -1 : i)).filter((i) => i >= 0),
    [rows],
  );

  const moveItem = (dir: 1 | -1) => {
    if (selectableIndices.length === 0) return;
    const cur = selectableIndices.indexOf(cursor);
    const base = cur < 0 ? 0 : cur;
    const nextPos = (base + dir + selectableIndices.length) % selectableIndices.length;
    setCursor(selectableIndices[nextPos] ?? selectableIndices[0] ?? 0);
  };

  // Initialize cursor on first selectable row
  useMemo(() => {
    if (cursor === 0 && selectableIndices.length > 0 && selectableIndices[0] !== 0) {
      setCursor(selectableIndices[0] ?? 0);
    }
  }, [cursor, selectableIndices]);

  const selectedRow = rows[cursor];
  const selectedSlot = selectedRow?.kind === "slot" ? selectedRow.def : null;
  const selectedPicker = selectedRow?.kind === "picker" ? selectedRow.def : null;
  const selectedFallbackModelId = selectedRow?.kind === "fallback" ? selectedRow.modelId : null;

  useKeyboard((evt) => {
    if (!visible) return;

    if (evt.name === "escape" || evt.name === "q") {
      onClose();
      return;
    }

    if (evt.name === "up" || evt.name === "k") {
      moveItem(-1);
      return;
    }
    if (evt.name === "down" || evt.name === "j") {
      moveItem(1);
      return;
    }
    if (evt.name === "return") {
      if (selectedFallbackModelId) onAddFallback(selectedFallbackModelId);
      else if (selectedSlot) onPickSlot(selectedSlot.key);
      return;
    }
    if (evt.name === "d" || evt.name === "delete" || evt.name === "backspace") {
      if (selectedFallbackModelId) onClearFallbacks(selectedFallbackModelId);
      else if (selectedSlot) onClearSlot(selectedSlot.key);
      return;
    }
    if (evt.name === "left" || evt.name === "right") {
      if (selectedPicker) {
        const cur = router?.[selectedPicker.key];
        const curVal = typeof cur === "number" ? cur : selectedPicker.defaultValue;
        const opts = selectedPicker.options;
        const i = opts.indexOf(curVal);
        const base = i < 0 ? 0 : i;
        const nextIdx =
          evt.name === "left" ? (base - 1 + opts.length) % opts.length : (base + 1) % opts.length;
        const next = opts[nextIdx];
        if (typeof next === "number" && next !== curVal) onPickerChange(selectedPicker.key, next);
        return;
      }
      const sIdx = CONFIG_SCOPES.indexOf(scope);
      const next =
        evt.name === "left"
          ? CONFIG_SCOPES[(sIdx - 1 + CONFIG_SCOPES.length) % CONFIG_SCOPES.length]
          : CONFIG_SCOPES[(sIdx + 1) % CONFIG_SCOPES.length];
      if (next && next !== scope) onScopeChange(next, scope);
      evt.preventDefault();
      return;
    }
    handleCursorNavKey(evt, setCursor, rows.length);
    evt.preventDefault();
  });

  if (!visible) return null;

  const customCount = ALL_DEFS.filter(
    (d) => d.kind === "slot" && typeof router?.[d.key] === "string",
  ).length;
  const slotCount = ALL_DEFS.filter((d) => d.kind === "slot").length;

  // Columns: marker(2) + label + description + model (right)
  const labelCol = 12;
  const modelCol = Math.min(30, Math.max(18, Math.floor(contentW * 0.32)));
  const descCol = Math.max(8, contentW - 4 - labelCol - modelCol - 2);

  // Strip well-known provider prefix to keep model column compact.
  const shortModel = (m: string): string => {
    const slash = m.indexOf("/");
    return slash > 0 ? m.slice(slash + 1) : m;
  };

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Task Router"
      titleIcon="router"
      blurb={`${customCount}/${slotCount} set · ${scope} · default: ${shortModel(activeModel)}`}
      footerHints={[
        { key: "↑↓", label: "nav" },
        { key: "Enter", label: "set" },
        { key: "d", label: "reset" },
        { key: "←→", label: selectedPicker ? "adjust" : "scope" },
        { key: "Esc", label: "close" },
      ]}
    >
      <Section>
        <box flexDirection="column" backgroundColor={t.bgPopup}>
          {rows.map((row, idx) => {
            if (row.kind === "header") {
              return (
                <box
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable row layout
                  key={`h-${idx}`}
                  flexDirection="column"
                  backgroundColor={t.bgPopup}
                >
                  {idx > 0 ? <box height={1} backgroundColor={t.bgPopup} /> : null}
                  <text bg={t.bgPopup} fg={t.brandAlt} attributes={BOLD}>
                    {row.section.title}
                  </text>
                </box>
              );
            }
            const isSelected = idx === cursor;
            if (row.kind === "fallback") {
              const rowBg = isSelected ? t.bgPopupHighlight : t.bgPopup;
              const fbs: string[] = getModelFallback(modelFallback, row.modelId);
              // Fallback rows reuse the slot layout: short model on left,
              // chain (or em-dash) on the right where the model col sits.
              const fallbackLabelCol = Math.min(28, Math.max(18, Math.floor(contentW * 0.32)));
              const label = truncate(shortModel(row.modelId), fallbackLabelCol)
                .padEnd(fallbackLabelCol)
                .slice(0, fallbackLabelCol);
              return (
                <box
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable row layout
                  key={`f-${idx}`}
                  flexDirection="row"
                  height={1}
                  backgroundColor={rowBg}
                >
                  <text
                    bg={rowBg}
                    fg={isSelected ? t.brandSecondary : t.textFaint}
                    attributes={BOLD}
                  >
                    {isSelected ? "▸ " : "  "}
                  </text>
                  <text bg={rowBg} fg={t.textPrimary} attributes={BOLD}>
                    {label}
                  </text>
                  <box flexGrow={1} backgroundColor={rowBg} />
                  {fbs.length > 0 ? (
                    <text bg={rowBg} fg={t.brandAlt} attributes={BOLD}>
                      {truncate(
                        `→ ${fbs.map((m) => shortModel(m)).join(", ")}`,
                        Math.max(8, contentW - 4 - fallbackLabelCol - 2),
                      )}
                    </text>
                  ) : (
                    <text bg={rowBg} fg={t.textDim}>
                      —
                    </text>
                  )}
                  <text bg={rowBg}>{"  "}</text>
                </box>
              );
            }
            if (row.kind === "picker") {
              const cur = router?.[row.def.key];
              const num = typeof cur === "number" ? cur : row.def.defaultValue;
              return (
                <SegmentedControl
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable row layout
                  key={`p-${idx}`}
                  label={row.def.label}
                  labelWidth={labelCol}
                  options={row.def.options.map((o) => ({ value: o, label: String(o) }))}
                  value={num}
                  focused={isSelected}
                />
              );
            }
            const rowBg = isSelected ? t.bgPopupHighlight : t.bgPopup;
            const raw = router?.[row.def.key] ?? null;
            const modelId = typeof raw === "string" ? raw : null;
            const descFg = isSelected ? t.textSecondary : t.textMuted;
            const label = row.def.label.padEnd(labelCol).slice(0, labelCol);
            const desc = truncate(row.def.hint, descCol).padEnd(descCol).slice(0, descCol);
            return (
              <box
                // biome-ignore lint/suspicious/noArrayIndexKey: stable row layout
                key={`s-${idx}`}
                flexDirection="row"
                height={1}
                backgroundColor={rowBg}
              >
                <text bg={rowBg} fg={isSelected ? t.brandSecondary : t.textFaint} attributes={BOLD}>
                  {isSelected ? "▸ " : "  "}
                </text>
                <text bg={rowBg} fg={t.textPrimary} attributes={BOLD}>
                  {label}
                </text>
                <text bg={rowBg} fg={descFg}>
                  {desc}
                </text>
                <box flexGrow={1} backgroundColor={rowBg} />
                {modelId ? (
                  <text bg={rowBg} fg={t.brandAlt} attributes={BOLD}>
                    {truncate(shortModel(modelId), modelCol)}
                  </text>
                ) : (
                  <text bg={rowBg} fg={t.textDim}>
                    —
                  </text>
                )}
                <text bg={rowBg}>{"  "}</text>
              </box>
            );
          })}
        </box>
        <VSpacer />
        <SegmentedControl
          label="Scope"
          labelWidth={14}
          options={CONFIG_SCOPES.map((s) => ({ value: s, label: s }))}
          value={scope}
        />
      </Section>
    </PremiumPopup>
  );
}
