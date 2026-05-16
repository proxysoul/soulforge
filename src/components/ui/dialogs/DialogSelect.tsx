import { useKeyboard } from "@opentui/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../../../core/theme/index.js";
import { useDialogStore } from "../../../stores/dialog.js";
import { fuzzyFilterGroups, tokenMatches } from "../fuzzy.js";
import { GroupedList, type GroupedListGroup } from "../GroupedList.js";
import { PremiumPopup } from "../PremiumPopup.js";
import { Search } from "../Search.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface DialogSelectAction {
  /** Keybind hint shown on the right of the footer. */
  key: string;
  label: string;
  /** Side this action is shown on. Default: "right". */
  side?: "left" | "right";
  /** Disable visually + skip when fired. */
  disabled?: boolean;
  /** Predicate to gate against current selection. */
  enabledFor?: (option: DialogSelectOption<unknown>) => boolean;
  onTrigger: (option: DialogSelectOption<unknown> | null) => void;
}

export interface DialogSelectOption<T = unknown> {
  /** Stable id for keying + comparison with `current`. */
  value: T;
  /** Display label (used for fuzzy match). */
  label: string;
  /** Optional second line shown under the label. */
  description?: string;
  /** Right-aligned secondary text. e.g. "12.4k tokens", "claude-sonnet". */
  meta?: string;
  /** Group/category. Items without a category go under "" (no header). */
  category?: string;
  /** Nerd-font icon name. */
  icon?: string;
  /** Disable selection (rendered dim, not focusable). */
  disabled?: boolean;
  /** Mark this option as the currently-active one (shown with ✓). */
  active?: boolean;
  /** Background/foreground overrides. */
  accent?: string;
  /** Trailing slot — e.g. spinner, quick-switch number, status dot. */
  status?: "online" | "offline" | "warning" | "error" | "idle";
  /** Disable filter-out — keeps the item even when query doesn't match. */
  pinned?: boolean;
  /** Click handler override (default: fires onSelect). */
  onSelect?: () => void;
}

export interface DialogSelectProps<T = unknown> {
  title: string;
  titleIcon?: string;
  placeholder?: string;
  options: DialogSelectOption<T>[];
  /** Currently-selected value — rendered as active in the list. */
  current?: T;
  /** Compare two values. Default: `Object.is`. */
  equals?: (a: T, b: T) => boolean;
  /** Hide the search box (no fuzzy filter). */
  skipFilter?: boolean;
  /** Flatten categories when filtering. Default: true. */
  flatOnFilter?: boolean;
  /** Per-row keybindings. Hooked into footer + key handler. */
  actions?: DialogSelectAction[];
  /** Static footer hints (rendered alongside the standard ↑↓ Enter Esc). */
  footerHints?: { key: string; label: string }[];
  /** Fired when an item is selected (Enter or click). */
  onSelect: (option: DialogSelectOption<T>) => void;
  /** Fired as the cursor moves over an item — useful for previews (themes). */
  onMove?: (option: DialogSelectOption<T>) => void;
  /** Fired when query changes. */
  onFilter?: (query: string) => void;
  /** Fired on Escape — defaults to dialog.pop(). */
  onCancel?: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function groupOptions<T>(
  options: DialogSelectOption<T>[],
  current: T | undefined,
  equals: (a: T, b: T) => boolean,
): GroupedListGroup[] {
  const byCategory = new Map<string, DialogSelectOption<T>[]>();
  for (const o of options) {
    const k = o.category ?? "";
    let arr = byCategory.get(k);
    if (!arr) {
      arr = [];
      byCategory.set(k, arr);
    }
    arr.push(o);
  }

  const out: GroupedListGroup[] = [];
  for (const [cat, items] of byCategory) {
    out.push({
      id: cat || "__default",
      label: cat || "",
      items: items.map((o) => ({
        id: String(o.value),
        label: o.label,
        meta: o.meta,
        active: current !== undefined && equals(o.value, current),
        disabled: o.disabled,
        status: o.status,
      })),
    });
  }
  return out;
}

// ── Component ─────────────────────────────────────────────────────────────

/**
 * DialogSelect — unified select primitive.
 *
 * Replaces ad-hoc CommandPicker/LlmSelector/SessionPicker. Fuzzy match on
 * label + category, grouped rendering by category, per-row actions, footer
 * hints, optional cancel/preview callbacks.
 *
 * Pair with `openSelect()` (below) to push it onto the dialog stack.
 */
export function DialogSelect<T>(props: DialogSelectProps<T>) {
  const {
    title,
    titleIcon,
    placeholder = "Search…",
    options,
    current,
    equals = (a: T, b: T) => Object.is(a, b),
    skipFilter = false,
    flatOnFilter = true,
    actions = [],
    footerHints = [],
    onSelect,
    onMove,
    onFilter,
    onCancel,
  } = props;

  useTheme();
  const pop = useDialogStore((s) => s.pop);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const enabledOptions = useMemo(() => options.filter((o) => !o.disabled), [options]);

  // Filter then group. Pinned items survive non-matching queries.
  const filtered = useMemo(() => {
    if (!query.trim()) return enabledOptions;
    return enabledOptions.filter(
      (o) =>
        o.pinned ||
        tokenMatches(o.label, query) ||
        (o.category ? tokenMatches(o.category, query) : false),
    );
  }, [enabledOptions, query]);

  const groups = useMemo(() => {
    const g = groupOptions(filtered, current, equals);
    if (query.trim() && flatOnFilter) {
      const items = g.flatMap((x) => x.items);
      return [{ id: "__flat", label: "", items, hideHeader: true } as GroupedListGroup];
    }
    return g.map((x) => ({ ...x, hideHeader: !x.label }));
  }, [filtered, current, equals, query, flatOnFilter]);

  // All groups expanded by default — we want results inline, not collapsed.
  const expandedGroupIds = useMemo(() => new Set(groups.map((g) => g.id)), [groups]);

  // GroupedList expects selectedIndex into FLAT row list (headers + items).
  // We track cursor as item-index in `filtered`; translate before render.
  const selectedRowIndex = useMemo(() => {
    let rowIdx = 0;
    let itemCount = 0;
    for (const g of groups) {
      if (!g.hideHeader) rowIdx++;
      for (let i = 0; i < g.items.length; i++) {
        if (itemCount === cursor) return rowIdx;
        rowIdx++;
        itemCount++;
      }
    }
    return rowIdx;
  }, [groups, cursor]);

  // Clamp cursor when the list shrinks.
  useEffect(() => {
    if (cursor >= filtered.length && filtered.length > 0) setCursor(filtered.length - 1);
  }, [cursor, filtered.length]);

  // Notify parent of cursor moves for previews.
  const lastMovedRef = useRef<T | null>(null);
  useEffect(() => {
    const target = filtered[cursor];
    if (!target) return;
    if (lastMovedRef.current === target.value) return;
    lastMovedRef.current = target.value;
    onMove?.(target);
  }, [cursor, filtered, onMove]);

  const dispatchSelect = useCallback(() => {
    const target = filtered[cursor];
    if (!target || target.disabled) return;
    (target.onSelect ?? (() => onSelect(target)))();
  }, [cursor, filtered, onSelect]);

  const dispatchCancel = useCallback(() => {
    if (onCancel) onCancel();
    else pop();
  }, [onCancel, pop]);

  useKeyboard((evt) => {
    // Action keys take priority over text input.
    for (const a of actions) {
      if (a.disabled) continue;
      if (evt.name === a.key) {
        const target = filtered[cursor] as DialogSelectOption<unknown> | undefined;
        if (a.enabledFor && target && !a.enabledFor(target)) {
          evt.preventDefault();
          return;
        }
        a.onTrigger(target ?? null);
        evt.preventDefault();
        return;
      }
    }

    if (evt.name === "up") {
      setCursor((c) => Math.max(0, c - 1));
    } else if (evt.name === "down") {
      setCursor((c) => Math.min(Math.max(0, filtered.length - 1), c + 1));
    } else if (evt.name === "pageup") {
      setCursor((c) => Math.max(0, c - 10));
    } else if (evt.name === "pagedown") {
      setCursor((c) => Math.min(Math.max(0, filtered.length - 1), c + 10));
    } else if (evt.name === "home") {
      setCursor(0);
    } else if (evt.name === "end") {
      setCursor(Math.max(0, filtered.length - 1));
    } else if (evt.name === "return") {
      dispatchSelect();
    } else if (evt.name === "escape") {
      dispatchCancel();
    } else if (!skipFilter) {
      if (evt.name === "backspace") {
        setQuery((q) => {
          const next = q.slice(0, -1);
          onFilter?.(next);
          return next;
        });
      } else if (evt.sequence && evt.sequence.length === 1 && !evt.ctrl && !evt.meta) {
        const ch = evt.sequence;
        if (ch >= " " && ch !== "\x7f") {
          setQuery((q) => {
            const next = q + ch;
            onFilter?.(next);
            return next;
          });
        }
      }
    }
    // Swallow the event so host pickers (SessionPicker, GitMenu, etc.) never
    // see Enter/letters that DialogSelect already routed.
    evt.preventDefault();
  });

  const hints = useMemo(() => {
    const base: { key: string; label: string }[] = [
      { key: "↑↓", label: "move" },
      { key: "↵", label: "select" },
      { key: "Esc", label: "close" },
    ];
    for (const a of actions) {
      if (a.disabled) continue;
      base.push({ key: a.key, label: a.label });
    }
    return [...base, ...footerHints];
  }, [actions, footerHints]);

  const counter =
    filtered.length === enabledOptions.length
      ? String(enabledOptions.length)
      : `${filtered.length} / ${enabledOptions.length}`;

  // Find absolute viewport — outer popup sizing.
  const popupWidth = 80;
  const popupHeight = 24;
  const listWidth = popupWidth - 6;
  const listMaxRows = popupHeight - 10;

  const body: ReactNode = (
    <box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
      {!skipFilter ? (
        <Search value={query} placeholder={placeholder} focused count={counter} />
      ) : null}
      <GroupedList
        groups={groups}
        selectedIndex={selectedRowIndex}
        width={listWidth}
        maxRows={listMaxRows}
        expanded={expandedGroupIds}
        focused
      />
    </box>
  );

  return (
    <PremiumPopup
      visible
      width={popupWidth}
      height={popupHeight}
      title={title}
      titleIcon={titleIcon}
      footerHints={hints}
    >
      {body}
    </PremiumPopup>
  );
}

// ── Imperative helper ─────────────────────────────────────────────────────

/**
 * Imperative open helper. Pushes a DialogSelect onto the stack and resolves
 * with the picked value, or `null` on cancel.
 *
 *   const picked = await openSelect({ title, options });
 */
export function openSelect<T>(
  opts: Omit<DialogSelectProps<T>, "onSelect" | "onCancel">,
): Promise<DialogSelectOption<T> | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: DialogSelectOption<T> | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const store = useDialogStore.getState();
    const id = store.push({
      size: "large",
      payload: {
        kind: "custom",
        render: () =>
          (
            <DialogSelect
              {...opts}
              onSelect={(option) => {
                settle(option);
                useDialogStore.getState().popById(id);
              }}
              onCancel={() => {
                settle(null);
                useDialogStore.getState().popById(id);
              }}
            />
          ) as unknown,
      },
      onClose: () => settle(null),
    });
  });
}

/** Used in `fuzzyFilterGroups` re-export — kept here so dialog consumers don't import deep paths. */
export { fuzzyFilterGroups };
