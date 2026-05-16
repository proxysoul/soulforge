/**
 * CommandPalette — search-first command picker.
 *
 * Behavior:
 *  - Typing always filters (no `/` toggle — palette IS a search UI).
 *  - Empty query: commands grouped by category, headers visible.
 *  - With query: single flat group (hideHeader), score-sorted matches.
 *  - Fuzzy-match char indices highlighted per item using the category accent.
 *  - Tab jumps to the next category header (nav aid when browsing).
 */

import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CATEGORIES,
  type CommandDef,
  getCommandDefs,
  getSuggestedCommandDefs,
} from "../../core/commands/registry.js";
import { fuzzyMatch } from "../../core/history/fuzzy.js";
import { useTheme } from "../../core/theme/index.js";
import {
  buildGroupedRows,
  type GroupedItem,
  GroupedList,
  type GroupedListGroup,
  PremiumPopup,
  Search,
  Section,
  VSpacer,
} from "../ui/index.js";

const CATEGORY_ICONS: Record<string, string> = {
  Git: "git",
  Session: "clock_alt",
  Models: "system",
  Settings: "cog",
  Editor: "pencil",
  Intelligence: "brain",
  Tabs: "tabs",
  System: "ghost",
};

interface CommandRow extends GroupedItem {
  def: CommandDef;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onExecute: (cmd: string) => void;
}

export function CommandPalette({ visible, onClose, onExecute }: Props) {
  const t = useTheme();
  const { width: tw, height: th } = useTerminalDimensions();

  const popupW = Math.min(84, Math.max(72, Math.floor(tw * 0.7)));
  const popupH = Math.min(32, Math.max(18, th - 4));
  const contentW = popupW - 4;

  const categoryColors: Record<string, string> = useMemo(
    () => ({
      Git: t.warning,
      Session: t.info,
      Models: t.brandAlt,
      Settings: t.brand,
      Editor: t.success,
      Intelligence: t.brandSecondary,
      Tabs: t.warning,
      System: t.textMuted,
    }),
    [t],
  );

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  cursorRef.current = cursor;

  const allDefs = useMemo(() => getCommandDefs().filter((d) => !d.hidden), []);

  // Reset on open
  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setCursor(0);
  }, [visible]);

  // Suggested commands surface at the top of the empty-query view. The
  // registry tags a handful of high-value commands; we de-dupe them from
  // their category groups below so they don't render twice.
  const suggestedDefs = useMemo(() => {
    return getSuggestedCommandDefs().filter((d) => !d.hidden);
  }, []);
  const suggestedSet = useMemo(() => new Set(suggestedDefs.map((d) => d.cmd)), [suggestedDefs]);

  // Build groups — two shapes depending on whether filter is active
  const groups = useMemo<GroupedListGroup<CommandRow>[]>(() => {
    if (query.trim().length === 0) {
      const suggestedGroup: GroupedListGroup<CommandRow> | null =
        suggestedDefs.length > 0
          ? {
              id: "__suggested",
              label: "Suggested",
              icon: "sparkle",
              accent: t.brand,
              items: suggestedDefs.map<CommandRow>((def) => ({
                id: `sug-${def.cmd}`,
                label: def.cmd,
                meta: def.desc,
                def,
              })),
            }
          : null;
      const categoryGroups = CATEGORIES.flatMap((cat) => {
        const cmds = allDefs.filter((d) => d.category === cat && !suggestedSet.has(d.cmd));
        if (cmds.length === 0) return [];
        return [
          {
            id: cat,
            label: cat,
            icon: CATEGORY_ICONS[cat],
            accent: categoryColors[cat] ?? t.brand,
            items: cmds.map<CommandRow>((def) => ({
              id: def.cmd,
              label: def.cmd,
              meta: def.desc,
              def,
            })),
          },
        ];
      });
      return suggestedGroup ? [suggestedGroup, ...categoryGroups] : categoryGroups;
    }

    // Search: collect matches with scores, sort desc, render as one flat group
    const results: { def: CommandDef; score: number; indices: number[] }[] = [];
    for (const def of allDefs) {
      const target = `${def.cmd} ${def.desc} ${def.tags?.join(" ") ?? ""}`;
      const m = fuzzyMatch(query, target);
      if (m) results.push({ def, score: m.score, indices: m.indices });
    }
    results.sort((a, b) => b.score - a.score);
    return [
      {
        id: "__results",
        label: "Results",
        hideHeader: true,
        items: results.map<CommandRow>(({ def, indices }) => {
          // highlightIndices are into the full target string. Trim to just cmd.
          const cmdLen = def.cmd.length;
          const cmdIndices = indices.filter((i) => i < cmdLen);
          return {
            id: def.cmd,
            label: def.cmd,
            meta: def.desc,
            prefix: def.category?.slice(0, 3).toLowerCase(),
            highlightIndices: cmdIndices,
            def,
          };
        }),
      },
    ];
  }, [
    query,
    allDefs,
    categoryColors,
    t,
    suggestedSet.has,
    suggestedDefs.map,
    suggestedDefs.length,
  ]);

  const rows = useMemo(() => {
    // All groups are expanded (either natural-expanded for categories, or hideHeader)
    const expanded = new Set(groups.map((g) => g.id));
    return buildGroupedRows(groups, expanded);
  }, [groups]);

  // Clamp cursor to a selectable (item) row
  const firstItemIdx = useMemo(() => rows.findIndex((r) => r.kind === "item"), [rows]);

  useEffect(() => {
    if (rows.length === 0) return;
    const cur = rows[cursorRef.current];
    if (!cur || cur.kind !== "item") {
      setCursor(firstItemIdx >= 0 ? firstItemIdx : 0);
    } else if (cursorRef.current >= rows.length) {
      setCursor(Math.max(0, rows.length - 1));
    }
  }, [rows, firstItemIdx]);

  const commandCount = useMemo(() => rows.filter((r) => r.kind === "item").length, [rows]);

  const nextItemIdx = (from: number, dir: 1 | -1): number => {
    if (rows.length === 0) return from;
    let i = from + dir;
    for (let n = 0; n < rows.length; n++) {
      if (i < 0) i = rows.length - 1;
      else if (i >= rows.length) i = 0;
      if (rows[i]?.kind === "item") return i;
      i += dir;
    }
    return from;
  };

  const nextCategoryIdx = (from: number): number => {
    // Find next header, then land on its first item
    for (let i = from + 1; i < rows.length; i++) {
      if (rows[i]?.kind === "group") {
        if (rows[i + 1]?.kind === "item") return i + 1;
      }
    }
    for (let i = 0; i < from; i++) {
      if (rows[i]?.kind === "group") {
        if (rows[i + 1]?.kind === "item") return i + 1;
      }
    }
    return from;
  };

  useKeyboard((evt) => {
    if (!visible) return;

    if (evt.name === "escape") {
      if (query.length > 0) {
        setQuery("");
        setCursor(firstItemIdx >= 0 ? firstItemIdx : 0);
      } else {
        onClose();
      }
      return;
    }

    if (evt.name === "return") {
      const cur = rows[cursorRef.current];
      if (cur?.kind === "item" && cur.item) {
        const r = cur.item as CommandRow;
        onClose();
        onExecute(r.def.cmd);
      }
      return;
    }

    if (evt.name === "up" || (evt.ctrl && evt.name === "k")) {
      setCursor((c) => nextItemIdx(c, -1));
      return;
    }
    if (evt.name === "down" || (evt.ctrl && evt.name === "j")) {
      setCursor((c) => nextItemIdx(c, 1));
      return;
    }
    if (evt.name === "tab" && !query) {
      setCursor((c) => nextCategoryIdx(c));
      return;
    }

    if (evt.name === "backspace" || evt.name === "delete") {
      setQuery((q) => q.slice(0, -1));
      return;
    }
    if (evt.ctrl && evt.name === "u") {
      setQuery("");
      return;
    }

    // Printable char → append to query
    const ch = evt.sequence;
    if (
      typeof ch === "string" &&
      ch.length === 1 &&
      ch >= " " &&
      ch !== "\x7f" &&
      !evt.ctrl &&
      !evt.meta
    ) {
      setQuery((q) => q + ch);
    }
  });

  if (!visible) return null;

  const totalCommands = allDefs.length;
  const blurb = query.trim()
    ? `${commandCount} matches`
    : `${totalCommands} commands · ${CATEGORIES.length} categories`;

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Command Palette"
      titleIcon="lightning"
      blurb={blurb}
      footerHints={
        query
          ? [
              { key: "↑↓", label: "nav" },
              { key: "Enter", label: "run" },
              { key: "Backspace", label: "del" },
              { key: "Esc", label: "clear" },
            ]
          : [
              { key: "↑↓", label: "nav" },
              { key: "Tab", label: "next category" },
              { key: "Enter", label: "run" },
              { key: "Esc", label: "close" },
            ]
      }
    >
      <Section>
        <Search
          value={query}
          focused={true}
          placeholder="Type to filter commands…"
          count={query ? `${commandCount} / ${totalCommands}` : undefined}
        />
        <VSpacer />
        <GroupedList
          groups={groups}
          expanded={new Set(groups.map((g) => g.id))}
          selectedIndex={cursor}
          width={contentW}
          maxRows={Math.max(8, popupH - 12)}
          emptyMessage="No commands match — try a different query"
        />
      </Section>
    </PremiumPopup>
  );
}
