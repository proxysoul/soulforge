import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import type { ConfigScope } from "../layout/shared.js";
import { CONFIG_SCOPES } from "../layout/shared.js";
import { KeyCap, PremiumPopup, SegmentedControl, Toggle } from "../ui/index.js";

// CommandPicker owns its own cursor/scroll because list rows have variable
// height (some options include a description line) which `VirtualList` does
// not model. Keeping this inline keeps the variable-row math here.
function useListScroll(maxVisible: number) {
  const [cursor, setCursor] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const adjustScroll = useCallback(
    (nextCursor: number) => {
      setScrollOffset((prev) => {
        let next = prev;
        if (nextCursor < prev) next = nextCursor;
        else if (nextCursor >= prev + maxVisible) next = nextCursor - maxVisible + 1;
        return Math.max(0, next);
      });
    },
    [maxVisible],
  );
  return { cursor, setCursor, scrollOffset, setScrollOffset, adjustScroll };
}

const MAX_POPUP_WIDTH = 60;
const CHROME_ROWS = 7;

export interface CommandPickerOption {
  value: string;
  label: string;
  description?: string;
  icon?: string;
  color?: string;
  disabled?: boolean;
  kind?: "separator";
}

interface PickerToggle {
  key: string;
  label: string;
  value: boolean;
  /** Return a new label string to update the toggle label dynamically */
  onToggle: () => string | undefined;
}

interface PickerSelector {
  key: string;
  label: string;
  options: string[];
  value: number;
  onChange: (index: number) => void;
}

export interface CommandPickerConfig {
  title: string;
  icon?: string;
  options: CommandPickerOption[];
  currentValue?: string | string[];
  scopeEnabled?: boolean;
  initialScope?: ConfigScope;
  maxWidth?: number;
  keepOpen?: boolean;
  searchable?: boolean;
  toggles?: PickerToggle[];
  selectors?: PickerSelector[];
  onSelect: (value: string, scope?: ConfigScope) => void;
  onScopeMove?: (value: string, fromScope: ConfigScope, toScope: ConfigScope) => void;
  onCursorChange?: (value: string) => void;
  onCancel?: () => void;
}

interface Props {
  visible: boolean;
  config: CommandPickerConfig | null;
  onClose: () => void;
}

/** Simple fuzzy match — returns score and matched indices, or null if no match */
function fuzzyScore(query: string, target: string): { score: number; indices: number[] } | null {
  if (query.length === 0) return { score: 0, indices: [] };
  const lower = target.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  const indices: number[] = [];
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      indices.push(i);
      qi++;
    }
  }
  if (qi < q.length) return null;
  let score = 0;
  for (let k = 0; k < indices.length; k++) {
    if (indices[k] === 0) score += 10;
    if (k > 0 && (indices[k] as number) === (indices[k - 1] as number) + 1) score += 5;
  }
  score -= indices.length > 0 ? (indices[0] as number) : 0;
  return { score, indices };
}

/** Focus zone: -1 = options list, 0+ = index into combined toggles+selectors */
const ZONE_LIST = -1;

interface OptionRowProps {
  option: CommandPickerOption;
  isActive: boolean;
  isCurrent: boolean;
  innerW: number;
  popupBg: string;
  popupHl: string;
  brandSecondary: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textDim: string;
  textFaint: string;
  successColor: string;
}

function OptionRow({
  option,
  isActive,
  isCurrent,
  innerW,
  popupBg,
  popupHl,
  brandSecondary,
  textPrimary,
  textSecondary,
  textMuted,
  textDim,
  textFaint,
  successColor,
}: OptionRowProps) {
  if (option.kind === "separator") {
    return (
      <box flexDirection="row" backgroundColor={popupBg} paddingX={1}>
        <text fg={textFaint} bg={popupBg}>
          {"─".repeat(innerW - 4)}
        </text>
      </box>
    );
  }

  const isDisabled = option.disabled === true;
  const bg = isActive && !isDisabled ? popupHl : popupBg;
  const activeColor = option.color ?? brandSecondary;
  const labelFg = isDisabled
    ? textDim
    : isActive
      ? activeColor
      : isCurrent
        ? successColor
        : textPrimary;

  return (
    <box flexDirection="column">
      <box flexDirection="row" backgroundColor={bg}>
        <text bg={bg} fg={isActive && !isDisabled ? activeColor : textMuted}>
          {isActive && !isDisabled ? "› " : "  "}
        </text>
        {option.icon && (
          <text bg={bg} fg={isDisabled ? textFaint : isActive ? activeColor : textSecondary}>
            {option.icon}{" "}
          </text>
        )}
        <text
          bg={bg}
          fg={labelFg}
          attributes={isActive && !isDisabled ? TextAttributes.BOLD : undefined}
        >
          {option.label}
        </text>
        {isCurrent && !isDisabled && (
          <text bg={bg} fg={successColor}>
            {" "}
            ✓
          </text>
        )}
      </box>
      {option.description && (
        <box flexDirection="row" backgroundColor={bg}>
          <text bg={bg} fg={isDisabled ? textFaint : isActive ? textSecondary : textMuted} truncate>
            {"    "}
            {option.icon ? "  " : ""}
            {option.description.length > innerW - 10
              ? `${option.description.slice(0, innerW - 13)}…`
              : option.description}
          </text>
        </box>
      )}
    </box>
  );
}

export function CommandPicker({ visible, config, onClose }: Props) {
  const t = useTheme();
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const containerRows = termRows - 2;
  const maxW = config?.maxWidth ?? MAX_POPUP_WIDTH;
  const popupWidth = Math.min(maxW, Math.floor(termCols * 0.8));
  const innerW = popupWidth - 2;
  const controlRows = (config?.toggles?.length ?? 0) + (config?.selectors?.length ?? 0);
  const extraChrome = controlRows > 0 ? controlRows + 1 : 0; // +1 for separator
  const maxVisible = Math.max(4, Math.floor(containerRows * 0.8) - CHROME_ROWS - extraChrome);
  const { cursor, setCursor, scrollOffset, setScrollOffset, adjustScroll } =
    useListScroll(maxVisible);
  const [scope, setScope] = useState<ConfigScope>("project");
  const [search, setSearch] = useState("");
  const [toggleState, setToggleState] = useState<Record<string, boolean>>({});
  const [toggleLabels, setToggleLabels] = useState<Record<string, string>>({});
  const [selectorState, setSelectorState] = useState<Record<string, number>>({});
  const [focusZone, setFocusZone] = useState(ZONE_LIST);

  const controls = (() => {
    const list: Array<{ type: "toggle"; key: string } | { type: "selector"; key: string }> = [];
    if (config?.toggles)
      for (const tg of config.toggles) list.push({ type: "toggle", key: tg.key });
    if (config?.selectors)
      for (const sel of config.selectors) list.push({ type: "selector", key: sel.key });
    return list;
  })();

  const hasControls = controls.length > 0;

  const filteredOptions = (() => {
    if (!config?.searchable || search.length === 0) return config?.options ?? [];
    const scored: Array<{ option: CommandPickerOption; score: number }> = [];
    for (const option of config.options) {
      const hit =
        fuzzyScore(search, option.label) ??
        fuzzyScore(search, option.value) ??
        (option.description ? fuzzyScore(search, option.description) : null);
      if (hit) scored.push({ option, score: hit.score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.option);
  })();

  const prevVisibleRef = useRef(false);
  const prevOptionsRef = useRef<CommandPickerOption[] | null>(null);
  useEffect(() => {
    if (!visible || !config) {
      prevVisibleRef.current = visible;
      prevOptionsRef.current = null;
      setSearch("");
      return;
    }
    const justOpened = !prevVisibleRef.current;
    prevVisibleRef.current = true;
    if (justOpened) {
      setSearch("");
      if (config.toggles) {
        const initial: Record<string, boolean> = {};
        const initialLabels: Record<string, string> = {};
        for (const tg of config.toggles) {
          initial[tg.key] = tg.value;
          initialLabels[tg.key] = tg.label;
        }
        setToggleState(initial);
        setToggleLabels(initialLabels);
      }
      if (config.selectors) {
        const initial: Record<string, number> = {};
        for (const sel of config.selectors) initial[sel.key] = sel.value;
        setSelectorState(initial);
      }
      const curVal = config.currentValue;
      let idx = curVal
        ? Array.isArray(curVal)
          ? filteredOptions.findIndex((o) => curVal.includes(o.value))
          : filteredOptions.findIndex((o) => o.value === curVal)
        : -1;
      if (idx < 0) {
        idx = filteredOptions.findIndex((o) => !o.disabled && o.kind !== "separator");
      }
      const startIdx = idx >= 0 ? idx : 0;
      setCursor(startIdx);
      setScrollOffset(Math.max(0, startIdx - Math.floor(maxVisible / 2)));
      if (config.scopeEnabled) setScope(config.initialScope ?? "project");
      setFocusZone(ZONE_LIST);
    } else if (prevOptionsRef.current && prevOptionsRef.current !== filteredOptions) {
      setCursor((prev) => {
        const prevValue = prevOptionsRef.current?.[prev]?.value;
        if (prevValue) {
          const newIdx = filteredOptions.findIndex((o) => o.value === prevValue);
          if (newIdx >= 0) return newIdx;
        }
        return Math.min(prev, Math.max(0, filteredOptions.length - 1));
      });
    }
    prevOptionsRef.current = filteredOptions;
  }, [visible, config, filteredOptions, setCursor, setScrollOffset, maxVisible]);

  // Reset cursor when search text changes (not on initial open)
  const prevSearch = useRef("");
  useEffect(() => {
    if (!config?.searchable) return;
    if (search !== prevSearch.current) {
      prevSearch.current = search;
      if (search.length > 0) {
        setCursor(0);
        setScrollOffset(0);
      }
    }
  }, [search, config?.searchable, setCursor, setScrollOffset]);

  // Fire onCursorChange for live preview
  const prevCursorValue = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !config?.onCursorChange) return;
    const val = filteredOptions[cursor]?.value;
    if (val && val !== prevCursorValue.current) {
      prevCursorValue.current = val;
      config.onCursorChange(val);
    }
  }, [cursor, visible, config, filteredOptions]);

  const handleKeyboard = (evt: import("@opentui/core").KeyEvent) => {
    if (!visible || !config) return;

    if (evt.name === "escape") {
      config.onCancel?.();
      onClose();
      return;
    }

    // Shortcut keys for toggles/selectors still work from anywhere
    if (config.toggles) {
      for (const toggle of config.toggles) {
        if (evt.name === toggle.key) {
          const newLabel = toggle.onToggle();
          if (typeof newLabel === "string") {
            setToggleLabels((prev) => ({ ...prev, [toggle.key]: newLabel }));
          } else {
            setToggleState((prev) => ({ ...prev, [toggle.key]: !prev[toggle.key] }));
          }
          return;
        }
      }
    }
    if (config.selectors) {
      for (const sel of config.selectors) {
        if (evt.name === sel.key) {
          setSelectorState((prev) => {
            const cur = prev[sel.key] ?? sel.value;
            const next = (cur + 1) % sel.options.length;
            sel.onChange(next);
            return { ...prev, [sel.key]: next };
          });
          return;
        }
      }
    }

    // Search input handling
    if (config.searchable && focusZone === ZONE_LIST) {
      if (evt.name === "backspace" || evt.name === "delete") {
        setSearch((prev) => prev.slice(0, -1));
        return;
      }
      if (
        evt.name &&
        evt.name.length === 1 &&
        !evt.ctrl &&
        !evt.meta &&
        evt.name !== "j" &&
        evt.name !== "k"
      ) {
        setSearch((prev) => prev + evt.name);
        return;
      }
    }

    // Up/down navigation — moves between list items and control zones
    if (evt.name === "up" || evt.name === "k") {
      if (focusZone > 0) {
        // Move up within controls
        setFocusZone(focusZone - 1);
      } else if (focusZone === 0) {
        // Move from first control back to list (last item)
        setFocusZone(ZONE_LIST);
        const lastIdx = filteredOptions.length - 1;
        setCursor(lastIdx);
        adjustScroll(lastIdx);
      } else {
        // In list — move up, or wrap to last control
        setCursor((prev) => {
          if (prev > 0) {
            let next = prev - 1;
            const start = next;
            while (filteredOptions[next]?.kind === "separator" || filteredOptions[next]?.disabled) {
              next = next > 0 ? next - 1 : filteredOptions.length - 1;
              if (next === start) break;
            }
            adjustScroll(next);
            return next;
          }
          // At top of list — wrap to last control if available
          if (hasControls) {
            setFocusZone(controls.length - 1);
          }
          return prev;
        });
      }
      return;
    }

    if (evt.name === "down" || evt.name === "j") {
      if (focusZone === ZONE_LIST) {
        // In list — move down, or enter controls
        setCursor((prev) => {
          if (prev < filteredOptions.length - 1) {
            let next = prev + 1;
            const start = next;
            while (filteredOptions[next]?.kind === "separator" || filteredOptions[next]?.disabled) {
              next = next < filteredOptions.length - 1 ? next + 1 : 0;
              if (next === start) break;
            }
            adjustScroll(next);
            return next;
          }
          // At bottom of list — enter first control
          if (hasControls) {
            setFocusZone(0);
          }
          return prev;
        });
      } else if (focusZone < controls.length - 1) {
        // Move down within controls
        setFocusZone(focusZone + 1);
      } else {
        // At last control — wrap to top of list
        setFocusZone(ZONE_LIST);
        setCursor(0);
        adjustScroll(0);
      }
      return;
    }

    // Left/right in control zones changes values
    if ((evt.name === "left" || evt.name === "right") && focusZone >= 0) {
      const ctrl = controls[focusZone];
      if (ctrl?.type === "toggle") {
        const toggle = config.toggles?.find((tg) => tg.key === ctrl.key);
        if (toggle) {
          const newLabel = toggle.onToggle();
          if (typeof newLabel === "string") {
            setToggleLabels((prev) => ({ ...prev, [toggle.key]: newLabel }));
          } else {
            setToggleState((prev) => ({ ...prev, [toggle.key]: !prev[toggle.key] }));
          }
        }
      } else if (ctrl?.type === "selector") {
        const sel = config.selectors?.find((s) => s.key === ctrl.key);
        if (sel) {
          const dir = evt.name === "right" ? 1 : -1;
          setSelectorState((prev) => {
            const cur = prev[sel.key] ?? sel.value;
            const next = (cur + dir + sel.options.length) % sel.options.length;
            sel.onChange(next);
            return { ...prev, [sel.key]: next };
          });
        }
      }
      return;
    }

    // Enter in control zone activates the control
    if (evt.name === "return" && focusZone >= 0) {
      const ctrl = controls[focusZone];
      if (ctrl?.type === "toggle") {
        const toggle = config.toggles?.find((tg) => tg.key === ctrl.key);
        if (toggle) {
          const newLabel = toggle.onToggle();
          if (typeof newLabel === "string") {
            setToggleLabels((prev) => ({ ...prev, [toggle.key]: newLabel }));
          } else {
            setToggleState((prev) => ({ ...prev, [toggle.key]: !prev[toggle.key] }));
          }
        }
      } else if (ctrl?.type === "selector") {
        // Enter on selector cycles forward
        const sel = config.selectors?.find((s) => s.key === ctrl.key);
        if (sel) {
          setSelectorState((prev) => {
            const cur = prev[sel.key] ?? sel.value;
            const next = (cur + 1) % sel.options.length;
            sel.onChange(next);
            return { ...prev, [sel.key]: next };
          });
        }
      }
      return;
    }

    // Enter in list zone selects the option
    if (evt.name === "return" && focusZone === ZONE_LIST) {
      const option = filteredOptions[cursor];
      if (option && !option.disabled && option.kind !== "separator") {
        const cb = config.onSelect;
        const val = option.value;
        const s = config.scopeEnabled ? scope : undefined;
        if (!config.keepOpen) onClose();
        cb(val, s);
      }
      return;
    }

    // Left/right in list zone changes scope
    if (config.scopeEnabled && focusZone === ZONE_LIST) {
      if (evt.name === "left" || evt.name === "right") {
        setScope((prev) => {
          const idx = CONFIG_SCOPES.indexOf(prev);
          const next =
            evt.name === "left"
              ? CONFIG_SCOPES[(idx - 1 + CONFIG_SCOPES.length) % CONFIG_SCOPES.length]
              : CONFIG_SCOPES[(idx + 1) % CONFIG_SCOPES.length];
          const val = filteredOptions[cursor]?.value;
          if (next !== prev && val && config.onScopeMove) {
            config.onScopeMove(val, prev, next as ConfigScope);
          }
          return next as ConfigScope;
        });
        return;
      }
    }
  };

  useKeyboard(handleKeyboard);

  if (!visible || !config) return null;

  // Clamp scrollOffset so the visible window is always full
  const maxOffset = Math.max(0, filteredOptions.length - maxVisible);
  const clampedOffset = Math.min(scrollOffset, maxOffset);

  const POPUP_BG = t.bgPopup;
  const POPUP_HL = t.bgPopupHighlight;

  return (
    <PremiumPopup
      visible={visible}
      width={popupWidth}
      height={Math.min(Math.max(14, Math.floor(termRows * 0.8)), termRows - 2)}
      title={config.title}
      titleIcon={config.icon}
      blurb={config.searchable && search ? `${filteredOptions.length} matches` : undefined}
      footerHints={[
        { key: "↑↓", label: "nav" },
        ...(hasControls ? [{ key: "←→", label: "adjust" }] : []),
        { key: "Enter", label: "select" },
        ...(config.searchable ? [{ key: "type", label: "filter" }] : []),
        ...(config.scopeEnabled && !hasControls ? [{ key: "←→", label: "scope" }] : []),
        { key: "Esc", label: "close" },
      ]}
    >
      {config.searchable && (
        <box flexDirection="row" backgroundColor={POPUP_BG}>
          <text fg={t.textMuted} bg={POPUP_BG}>
            {"🔍 "}
          </text>
          <text fg={t.textPrimary} bg={POPUP_BG}>
            {search || ""}
          </text>
          <text fg={t.brand} bg={POPUP_BG}>
            {"▌"}
          </text>
          {search.length === 0 && (
            <text fg={t.textDim} bg={POPUP_BG}>
              {" type to filter..."}
            </text>
          )}
        </box>
      )}

      <box flexDirection="row" backgroundColor={POPUP_BG}>
        <text fg={t.textFaint} bg={POPUP_BG}>
          {"─".repeat(innerW - 4)}
        </text>
      </box>

      <box
        flexDirection="column"
        height={Math.min(
          filteredOptions.reduce((sum, o) => sum + 1 + (o.description ? 1 : 0), 0) || 1,
          maxVisible,
        )}
        overflow="hidden"
      >
        {filteredOptions.length === 0 ? (
          <box flexDirection="row" backgroundColor={POPUP_BG}>
            <text fg={t.textMuted} bg={POPUP_BG}>
              {"  No matches"}
            </text>
          </box>
        ) : (
          filteredOptions
            .slice(clampedOffset, clampedOffset + maxVisible)
            .map((option, vi) => (
              <OptionRow
                key={option.value}
                option={option}
                isActive={vi + clampedOffset === cursor}
                isCurrent={
                  config.currentValue
                    ? Array.isArray(config.currentValue)
                      ? config.currentValue.includes(option.value)
                      : option.value === config.currentValue
                    : false
                }
                innerW={innerW}
                popupBg={POPUP_BG}
                popupHl={POPUP_HL}
                brandSecondary={t.brandSecondary}
                textPrimary={t.textPrimary}
                textSecondary={t.textSecondary}
                textMuted={t.textMuted}
                textDim={t.textDim}
                textFaint={t.textFaint}
                successColor={t.success}
              />
            ))
        )}
      </box>
      {filteredOptions.length > maxVisible && (
        <box flexDirection="row" backgroundColor={POPUP_BG}>
          <text fg={t.textSecondary} bg={POPUP_BG}>
            {clampedOffset > 0 ? "↑ " : "  "}
            {String(cursor + 1)}/{String(filteredOptions.length)}
            {clampedOffset + maxVisible < filteredOptions.length ? " ↓" : ""}
          </text>
        </box>
      )}

      <box height={1} backgroundColor={POPUP_BG} />

      {hasControls && (
        <>
          <box flexDirection="row" backgroundColor={POPUP_BG} paddingX={1}>
            <text fg={t.textFaint} bg={POPUP_BG}>
              {"─".repeat(Math.max(0, innerW - 4))}
            </text>
          </box>
          {controls.map((ctrl, ci) => {
            const focused = focusZone === ci;
            const bg = focused ? POPUP_HL : POPUP_BG;
            if (ctrl.type === "toggle") {
              const toggle = config.toggles?.find((tg) => tg.key === ctrl.key);
              if (!toggle) return null;
              const on = toggleState[toggle.key] ?? toggle.value;
              const keyLabel = toggle.key === "tab" ? "TAB" : toggle.key;
              return (
                <box
                  key={ctrl.key}
                  flexDirection="row"
                  backgroundColor={bg}
                  paddingX={1}
                  flexShrink={0}
                >
                  <Toggle
                    label={toggleLabels[toggle.key] ?? toggle.label}
                    on={on}
                    focused={focused}
                    bg={bg}
                  />
                  <box flexGrow={1} backgroundColor={bg} />
                  <KeyCap keyName={keyLabel} bg={bg} />
                </box>
              );
            }
            // selector
            const sel = config.selectors?.find((s) => s.key === ctrl.key);
            if (!sel) return null;
            const cur = selectorState[sel.key] ?? sel.value;
            return (
              <box
                key={ctrl.key}
                flexDirection="row"
                backgroundColor={bg}
                paddingX={1}
                flexShrink={0}
              >
                <SegmentedControl
                  label={sel.label}
                  options={sel.options.map((opt, i) => ({ value: i, label: opt }))}
                  value={cur}
                  focused={focused}
                  bg={bg}
                />
                <box flexGrow={1} backgroundColor={bg} />
                {!focused ? (
                  <KeyCap keyName={sel.key.toUpperCase()} bg={bg} accent={t.textFaint} />
                ) : (
                  <text bg={bg} fg={t.textDim}>
                    {"← →"}
                  </text>
                )}
              </box>
            );
          })}
        </>
      )}

      {config.scopeEnabled && (
        <box flexDirection="row" backgroundColor={POPUP_BG} paddingX={1} flexShrink={0}>
          <SegmentedControl
            label="Save to"
            options={CONFIG_SCOPES.map((s) => ({ value: s, label: s }))}
            value={scope}
            bg={POPUP_BG}
          />
        </box>
      )}
    </PremiumPopup>
  );
}
