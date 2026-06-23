/**
 * MemoryBrowser — interactive memory list + cleanup popup.
 *
 * Tabs:
 *   - All       : every active memory across project + global
 *   - Hidden    : soft-deleted (restorable)
 *   - Cleanup   : Quick (dupes + dead refs) and Stale candidates
 *
 * Per-row actions: Pin/Unpin, Soft-delete / Restore.
 * Cleanup tab: bulk review with Soft-delete / Pin / Skip per candidate.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContextManager } from "../../core/context/manager.js";
import type { ScopedMemory } from "../../core/memory/manager.js";
import type { MemoryRecord, MemoryScope } from "../../core/memory/types.js";
import { useTheme } from "../../core/theme/index.js";
import {
  buildGroupedRows,
  GroupedList,
  type GroupedListGroup,
  Hint,
  PremiumPopup,
  Search,
  Section,
  type SidebarTab,
  Table,
  type TableColumn,
  VSpacer,
} from "../ui/index.js";

type Tab = "All" | "Hidden" | "Cleanup" | "Settings";

type SettingsModalKind = "write" | "read" | "settings-storage";
type SettingsModal = { kind: SettingsModalKind; current: string } | null;

interface SettingsRow {
  id: string;
  label: string;
  meta?: string;
  active?: boolean;
  status?: "online" | "offline" | "warning" | "error" | "idle";
  kind: "write" | "read" | "settings-storage" | "embedding";
}

const SETTINGS_MODAL_TITLE: Record<SettingsModalKind, string> = {
  write: "Write Scope",
  read: "Read Scope",
  "settings-storage": "Save Settings To",
};

const SETTINGS_MODAL_OPTIONS: Record<
  SettingsModalKind,
  { value: string; label: string; description: string }[]
> = {
  write: [
    { value: "global", label: "Global", description: "shared across all projects" },
    { value: "project", label: "Project", description: "scoped to this project" },
    { value: "none", label: "None", description: "Forge won't save new memories" },
  ],
  read: [
    { value: "all", label: "All", description: "search project + global" },
    { value: "global", label: "Global", description: "only global memories" },
    { value: "project", label: "Project", description: "only this project" },
    { value: "none", label: "None", description: "no recall, no auto-surface" },
  ],
  "settings-storage": [
    { value: "project", label: "Project", description: "preferences saved here" },
    { value: "global", label: "Global", description: "preferences saved everywhere" },
  ],
};

interface Props {
  visible: boolean;
  contextManager: ContextManager;
  cwd: string;
  onClose: () => void;
  onSystemMessage: (msg: string) => void;
}

interface MemoryRow {
  id: string;
  scope: MemoryScope;
  category: string;
  pin: string;
  summary: string;
  use: string;
  age: string;
  // Underlying record kept for action handlers.
  record: MemoryRecord;
}

interface CleanupRow {
  id: string;
  scope: MemoryScope;
  kind: "dupe" | "dead" | "stale" | "sim";
  kindLabel: string;
  summary: string;
  detail: string;
  record: MemoryRecord;
  /** For "sim" rows: the cluster's preferred keeper id. */
  clusterKeeperId?: string;
}

const TABS: Tab[] = ["All", "Hidden", "Cleanup", "Settings"];

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}

function toRow(m: ScopedMemory): MemoryRow {
  return {
    id: m.id,
    scope: m.scope,
    category: m.category ?? "—",
    pin: m.pinned ? "★" : " ",
    summary: m.summary.replace(/[\n\r]+/g, " "),
    use: `×${String(m.use_count)}`,
    age: timeAgo(m.last_used_at),
    record: m,
  };
}

const COLUMNS: TableColumn<MemoryRow>[] = [
  { key: "scope", width: 4, render: (r) => (r.scope === "project" ? "proj" : "glob") },
  { key: "cat", width: 7, render: (r) => r.category.slice(0, 7) },
  { key: "★", width: 1, render: (r) => r.pin },
  { key: "summary" },
  { key: "use", width: 5, align: "right" },
  { key: "age", width: 4, align: "right" },
];

interface CleanupRowDisplay extends CleanupRow {
  action?: string;
}

const CLEANUP_COLUMNS: TableColumn<CleanupRowDisplay>[] = [
  { key: "kind", width: 5, render: (r) => r.kindLabel },
  { key: "scope", width: 4, render: (r) => (r.scope === "project" ? "proj" : "glob") },
  { key: "summary" },
  { key: "detail", width: 22 },
  { key: "action", width: 7, render: (r) => r.action ?? "·" },
];

export function MemoryBrowser({ visible, contextManager, cwd, onClose, onSystemMessage }: Props) {
  const t = useTheme();
  const { width: tw, height: th } = useTerminalDimensions();
  const memMgr = contextManager.getMemoryManager();

  const popupW = Math.min(120, Math.max(86, Math.floor(tw * 0.85)));
  const popupH = Math.min(36, Math.max(20, th - 4));
  const SIDEBAR_W = 22;
  const contentW = popupW - SIDEBAR_W - 9;

  const [tab, setTab] = useState<Tab>("All");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [flash, setFlash] = useState<{
    kind: "ok" | "err" | "info";
    message: string;
  } | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);

  // Cleanup mode: all candidates loaded once when entering tab; user marks
  // each row's intended action. Apply all on Enter on "✓ Apply" row.
  const [cleanupRows, setCleanupRows] = useState<CleanupRow[]>([]);
  const [cleanupSelected, setCleanupSelected] = useState<Map<string, "delete" | "pin" | "skip">>(
    new Map(),
  );

  // Settings tab — sub-modal state for picking a value.
  const [settingsModal, setSettingsModal] = useState<SettingsModal>(null);

  const cursorRef = useRef(0);
  cursorRef.current = cursor;

  const popFlash = useCallback((kind: "ok" | "err" | "info", message: string) => {
    setFlash({ kind, message });
    setTimeout(() => setFlash(null), 1800);
  }, []);

  const fileExists = useCallback(
    (p: string) => {
      try {
        return existsSync(join(cwd, p));
      } catch {
        return false;
      }
    },
    [cwd],
  );

  const refreshCleanup = useCallback(() => {
    const dupes = memMgr.findDuplicates("all");
    const dead = memMgr.findDeadFileRefs("all", fileExists);
    const stale = memMgr.staleCandidates("all", 25);
    const rows: CleanupRow[] = [];
    for (const g of dupes) {
      for (const d of g.dupes) {
        rows.push({
          id: d.id,
          scope: g.scope,
          kind: "dupe",
          kindLabel: "DUPE",
          summary: d.summary.replace(/[\n\r]+/g, " "),
          detail: `dup of ${g.kept.id.slice(0, 8)}`,
          record: d,
        });
      }
    }
    for (const d of dead) {
      rows.push({
        id: d.record.id,
        scope: d.scope,
        kind: "dead",
        kindLabel: "DEAD",
        summary: d.record.summary.replace(/[\n\r]+/g, " "),
        detail: d.deadPaths.slice(0, 2).join(", ") + (d.deadPaths.length > 2 ? "…" : ""),
        record: d.record,
      });
    }
    for (const s of stale) {
      // Skip already covered by dupe/dead to avoid double-listing.
      if (rows.some((r) => r.id === s.record.id && r.scope === s.scope)) continue;
      rows.push({
        id: s.record.id,
        scope: s.scope,
        kind: "stale",
        kindLabel: "STALE",
        summary: s.record.summary.replace(/[\n\r]+/g, " "),
        detail: `${s.ageDays.toFixed(0)}d unused, ×${String(s.record.use_count)}`,
        record: s.record,
      });
    }

    // Deep: similarity clusters from memory_edges. Keep the most-pinned /
    // most-used / newest as cluster keeper; surface the rest as candidates
    // for soft-delete (or supersede via the agent later).
    const clusters = memMgr.similarClusters("all", 0.7);
    for (const c of clusters) {
      if (c.members.length < 2) continue;
      const sortedMembers = [...c.members].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (a.use_count !== b.use_count) return b.use_count - a.use_count;
        return Date.parse(b.last_used_at) - Date.parse(a.last_used_at);
      });
      const keeper = sortedMembers[0];
      if (!keeper) continue;
      for (const m of sortedMembers.slice(1)) {
        // Don't double-list rows already flagged by Quick/Stale.
        if (rows.some((r) => r.id === m.id && r.scope === c.scope)) continue;
        rows.push({
          id: m.id,
          scope: c.scope,
          kind: "sim",
          kindLabel: "SIM",
          summary: m.summary.replace(/[\n\r]+/g, " "),
          detail: `~${keeper.id.slice(0, 8)} (${(c.avgWeight * 100).toFixed(0)}%)`,
          record: m,
          clusterKeeperId: keeper.id,
        });
      }
    }
    setCleanupRows(rows);
    setCleanupSelected(new Map());
  }, [memMgr, fileExists]);

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setCursor(0);
    setConfirmPurge(false);
    setFlash(null);
    setSettingsModal(null);
    if (tab === "Cleanup") refreshCleanup();
  }, [visible, tab, refreshCleanup]);

  // Live data depends on `generation` so action handlers can re-render.
  const allRows = useMemo<MemoryRow[]>(() => {
    void generation;
    return memMgr.list("all", { includeHidden: false }).map(toRow);
  }, [memMgr, generation]);

  const hiddenRows = useMemo<MemoryRow[]>(() => {
    void generation;
    return memMgr
      .list("all", { includeHidden: true })
      .filter((m) => m.hidden)
      .map(toRow);
  }, [memMgr, generation]);

  const filteredRows = useMemo<MemoryRow[]>(() => {
    const source = tab === "Hidden" ? hiddenRows : allRows;
    const fq = query.toLowerCase().trim();
    if (!fq) return source;
    return source.filter((r) => {
      const hay = `${r.summary} ${r.category} ${r.scope} ${r.record.topics.join(" ")}`;
      return hay.toLowerCase().includes(fq);
    });
  }, [allRows, hiddenRows, tab, query]);

  // Settings groups: scope rules.
  const settingsGroups = useMemo<GroupedListGroup<SettingsRow>[]>(() => {
    const scopeCfg = memMgr.scopeConfig;
    const resolution = contextManager.getEmbedderResolution();
    const embedderMeta = resolution?.modelId
      ? `${resolution.modelId} (${resolution.source})`
      : "offline (hashbag-v2)";
    return [
      {
        id: "scopes",
        label: "Scopes",
        hideHeader: true,
        items: [
          {
            id: "write",
            label: "Write Scope",
            meta: scopeCfg.writeScope,
            kind: "write" as const,
          },
          {
            id: "read",
            label: "Read Scope",
            meta: scopeCfg.readScope,
            kind: "read" as const,
          },
          {
            id: "settings-storage",
            label: "Save settings to",
            meta: memMgr.settingsScope,
            kind: "settings-storage" as const,
          },
          {
            id: "embedding",
            label: "Embedding",
            meta: embedderMeta,
            status: resolution?.modelId ? ("online" as const) : ("offline" as const),
            kind: "embedding" as const,
          },
        ],
      },
    ];
  }, [memMgr, contextManager]);

  const settingsRows = useMemo(
    () => buildGroupedRows(settingsGroups, new Set(["scopes"])),
    [settingsGroups],
  );

  // Clamp cursor when list narrows
  useEffect(() => {
    let len: number;
    if (tab === "Cleanup") len = cleanupRows.length + 1;
    else if (tab === "Settings") len = settingsRows.length;
    else len = filteredRows.length;
    if (cursor >= len && len > 0) setCursor(len - 1);
    if (len === 0) setCursor(0);
  }, [filteredRows.length, cleanupRows.length, settingsRows.length, cursor, tab]);

  const bumpGen = () => setGeneration((g) => g + 1);

  const togglePin = (row: MemoryRow) => {
    if (row.record.pinned) {
      memMgr.unpin(row.scope, row.id);
      popFlash("ok", `Unpinned ${row.id.slice(0, 8)}`);
    } else {
      memMgr.pin(row.scope, row.id);
      popFlash("ok", `Pinned ${row.id.slice(0, 8)}`);
    }
    bumpGen();
  };

  const softDelete = (row: MemoryRow) => {
    memMgr.softDelete(row.scope, row.id);
    popFlash("ok", `Hidden ${row.id.slice(0, 8)}`);
    bumpGen();
  };

  const restore = (row: MemoryRow) => {
    memMgr.restore(row.scope, row.id);
    popFlash("ok", `Restored ${row.id.slice(0, 8)}`);
    bumpGen();
  };

  const cycleCleanupAction = (id: string) => {
    setCleanupSelected((prev) => {
      const next = new Map(prev);
      const current = next.get(id);
      const order: Array<"delete" | "pin" | "skip"> = ["delete", "pin", "skip"];
      const idx = current ? order.indexOf(current) : -1;
      const nextAction = order[(idx + 1) % order.length];
      if (nextAction) next.set(id, nextAction);
      return next;
    });
  };

  const applyCleanup = () => {
    let deleted = 0;
    let pinned = 0;
    for (const row of cleanupRows) {
      const action = cleanupSelected.get(row.id);
      if (action === "delete") {
        memMgr.softDelete(row.scope, row.id);
        deleted++;
      } else if (action === "pin") {
        memMgr.pin(row.scope, row.id);
        pinned++;
      }
    }
    memMgr.noteCleanupCompleted();
    const summary = `Cleanup: ${String(deleted)} hidden, ${String(pinned)} pinned`;
    onSystemMessage(summary);
    popFlash("ok", summary);
    bumpGen();
    refreshCleanup();
  };

  const onSettingsSelect = (row: SettingsRow) => {
    if (row.kind === "write") {
      setSettingsModal({ kind: "write", current: memMgr.scopeConfig.writeScope });
    } else if (row.kind === "read") {
      setSettingsModal({ kind: "read", current: memMgr.scopeConfig.readScope });
    } else if (row.kind === "settings-storage") {
      setSettingsModal({ kind: "settings-storage", current: memMgr.settingsScope });
    }
  };

  const applySettingsModal = (value: string) => {
    if (!settingsModal) return;
    if (settingsModal.kind === "write") {
      memMgr.scopeConfig = {
        ...memMgr.scopeConfig,
        writeScope: value as "global" | "project" | "none",
      };
      popFlash("ok", `Write scope: ${value}`);
    } else if (settingsModal.kind === "read") {
      memMgr.scopeConfig = {
        ...memMgr.scopeConfig,
        readScope: value as "global" | "project" | "all" | "none",
      };
      popFlash("ok", `Read scope: ${value}`);
    } else if (settingsModal.kind === "settings-storage") {
      memMgr.setSettingsScope(value as "project" | "global");
      popFlash("ok", `Settings saved to: ${value}`);
    }
    setSettingsModal(null);
    bumpGen();
  };

  useKeyboard((evt) => {
    if (!visible) return;

    if (settingsModal) {
      const opts = SETTINGS_MODAL_OPTIONS[settingsModal.kind];
      if (evt.name === "escape") {
        setSettingsModal(null);
        return;
      }
      if (evt.name === "up") {
        setCursor((c) => (c > 0 ? c - 1 : opts.length - 1));
        return;
      }
      if (evt.name === "down") {
        setCursor((c) => (c < opts.length - 1 ? c + 1 : 0));
        return;
      }
      if (evt.name === "return") {
        const opt = opts[cursorRef.current];
        if (opt) applySettingsModal(opt.value);
        return;
      }
      return;
    }

    if (confirmPurge) {
      if (evt.name === "y") {
        const cleared = memMgr.clearScope("all");
        onSystemMessage(`Cleared ${String(cleared)} memories`);
        popFlash("ok", `Cleared ${String(cleared)}`);
        setConfirmPurge(false);
        bumpGen();
      } else {
        setConfirmPurge(false);
      }
      return;
    }

    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "tab") {
      const idx = TABS.indexOf(tab);
      const dir = evt.shift ? -1 : 1;
      const next = TABS[(idx + dir + TABS.length) % TABS.length];
      if (next) setTab(next);
      setCursor(0);
      setQuery("");
      return;
    }

    let len: number;
    if (tab === "Cleanup") len = cleanupRows.length + 1;
    else if (tab === "Settings") len = settingsRows.length;
    else len = filteredRows.length;
    if (evt.name === "up") {
      setCursor((c) => (c > 0 ? c - 1 : Math.max(0, len - 1)));
      return;
    }
    if (evt.name === "down") {
      setCursor((c) => (c < len - 1 ? c + 1 : 0));
      return;
    }

    if (tab === "Settings") {
      if (evt.name === "return" || evt.name === "space") {
        const r = settingsRows[cursorRef.current];
        if (r?.kind === "item" && r.item) onSettingsSelect(r.item as SettingsRow);
      }
      return;
    }

    if (tab === "Cleanup") {
      const onApplyRow = cursorRef.current === cleanupRows.length;
      if (evt.name === "return") {
        if (onApplyRow) applyCleanup();
        else {
          const row = cleanupRows[cursorRef.current];
          if (row) cycleCleanupAction(row.id);
        }
        return;
      }
      if (evt.name === "d") {
        const row = cleanupRows[cursorRef.current];
        if (row) {
          setCleanupSelected((prev) => new Map(prev).set(row.id, "delete"));
        }
        return;
      }
      if (evt.name === "p") {
        const row = cleanupRows[cursorRef.current];
        if (row) {
          setCleanupSelected((prev) => new Map(prev).set(row.id, "pin"));
        }
        return;
      }
      if (evt.name === "s") {
        const row = cleanupRows[cursorRef.current];
        if (row) {
          setCleanupSelected((prev) => new Map(prev).set(row.id, "skip"));
        }
        return;
      }
      if (evt.name === "r") {
        refreshCleanup();
        popFlash("info", "Refreshed");
        return;
      }
      return;
    }

    // All / Hidden tabs — actions are CTRL-modified so the search field
    // captures plain letters cleanly (matches SessionPicker convention).
    const row = filteredRows[cursorRef.current];

    if (evt.name === "return" && row) {
      togglePin(row);
      return;
    }
    if (evt.ctrl && evt.name === "p") {
      if (row) togglePin(row);
      return;
    }
    if (evt.ctrl && evt.name === "d") {
      if (row) softDelete(row);
      return;
    }
    if (evt.ctrl && evt.name === "r" && tab === "Hidden") {
      if (row) restore(row);
      return;
    }
    if (evt.ctrl && evt.name === "x") {
      if (allRows.length > 0 || hiddenRows.length > 0) setConfirmPurge(true);
      return;
    }
    if (evt.name === "backspace" || evt.name === "delete") {
      setQuery((p) => p.slice(0, -1));
      return;
    }
    if (evt.ctrl && evt.name === "u") {
      setQuery("");
      return;
    }
    const ch = evt.sequence;
    if (typeof ch === "string" && ch.length === 1 && ch >= " " && !evt.ctrl && !evt.meta) {
      setQuery((p) => p + ch);
    }
  });

  if (!visible) return null;

  const projIdx = memMgr.getDbForScope("project").getIndex();
  const globIdx = memMgr.getDbForScope("global").getIndex();
  const totalCount = projIdx.total + globIdx.total;
  const pinnedCount = projIdx.pinned + globIdx.pinned;
  const hint = memMgr.cleanupHint();

  const sidebarTabs: SidebarTab<Tab>[] = [
    {
      id: "All",
      label: "All",
      icon: "memory",
      blurb: `${String(totalCount)} active · ${String(pinnedCount)} pinned`,
    },
    {
      id: "Hidden",
      label: "Hidden",
      icon: "trash_alt",
      blurb: `${String(hiddenRows.length)} soft-deleted`,
      status: hiddenRows.length > 0 ? "idle" : undefined,
    },
    {
      id: "Cleanup",
      label: "Cleanup",
      icon: "cleanup",
      blurb: hint ? `${String(hint.stale)} stale · review now` : "duplicates · dead refs · stale",
      status: hint ? "warning" : undefined,
    },
    {
      id: "Settings",
      label: "Settings",
      icon: "gear",
      blurb: `${memMgr.scopeConfig.writeScope}/${memMgr.scopeConfig.readScope}`,
    },
  ];

  const cleanupAction = (id: string) => {
    const a = cleanupSelected.get(id);
    if (a === "delete") return "✗ del";
    if (a === "pin") return "★ pin";
    if (a === "skip") return "↷ skip";
    return "·";
  };

  let baseHints: { key: string; label: string }[];
  if (tab === "Cleanup") {
    baseHints = [
      { key: "↑↓", label: "nav" },
      { key: "Enter", label: "cycle" },
      { key: "d/p/s", label: "set" },
      { key: "^R", label: "refresh" },
      { key: "Tab", label: "panel" },
      { key: "Esc", label: "close" },
    ];
  } else if (tab === "Settings") {
    baseHints = [
      { key: "↑↓", label: "nav" },
      { key: "Enter", label: "edit" },
      { key: "Tab", label: "panel" },
      { key: "Esc", label: "close" },
    ];
  } else {
    baseHints = [
      { key: "↑↓", label: "nav" },
      { key: "Enter", label: "pin" },
      ...(tab === "Hidden" ? [{ key: "^R", label: "restore" }] : [{ key: "^D", label: "hide" }]),
      { key: "^X", label: "purge all" },
      { key: "Tab", label: "panel" },
      { key: "Esc", label: "close" },
    ];
  }

  // Settings sub-modal — small inline overlay.
  if (settingsModal) {
    const opts = SETTINGS_MODAL_OPTIONS[settingsModal.kind];
    return (
      <PremiumPopup
        visible={visible}
        width={Math.min(60, popupW)}
        height={Math.min(opts.length + 8, popupH)}
        title={SETTINGS_MODAL_TITLE[settingsModal.kind]}
        titleIcon="gear"
        footerHints={[
          { key: "↑↓", label: "nav" },
          { key: "Enter", label: "select" },
          { key: "Esc", label: "back" },
        ]}
      >
        <Section>
          {opts.map((o, i) => {
            const isCurrent = o.value === settingsModal.current;
            const isSelected = i === cursor;
            const bg = isSelected ? t.bgPopupHighlight : t.bgPopup;
            return (
              <box key={o.value} flexDirection="row" paddingX={2} backgroundColor={bg}>
                <text bg={bg} fg={isSelected ? t.brand : t.textFaint}>
                  {isSelected ? "▸ " : "  "}
                </text>
                <text bg={bg} fg={t.textPrimary} attributes={isSelected ? 1 : undefined}>
                  {o.label}
                </text>
                {isCurrent ? (
                  <text bg={bg} fg={t.success}>
                    {" "}
                    ✓
                  </text>
                ) : null}
                <box flexGrow={1} backgroundColor={bg} />
                <text bg={bg} fg={t.textFaint}>
                  {o.description}
                </text>
              </box>
            );
          })}
        </Section>
      </PremiumPopup>
    );
  }

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Memory"
      titleIcon="memory"
      tabs={sidebarTabs}
      activeTab={tab}
      sidebarWidth={SIDEBAR_W}
      footerHints={
        confirmPurge
          ? [
              { key: "y", label: "confirm" },
              { key: "any", label: "cancel" },
            ]
          : baseHints
      }
      flash={flash}
    >
      <Section>
        {tab === "Settings" ? (
          <GroupedList
            groups={settingsGroups}
            expanded={new Set(["scopes", "auto"])}
            selectedIndex={cursor}
            width={contentW}
            maxRows={Math.max(4, popupH - 10)}
          />
        ) : tab === "Cleanup" ? (
          <>
            <box flexDirection="row" paddingX={2} backgroundColor={t.bgPopup}>
              <text bg={t.bgPopup} fg={t.textMuted}>
                {cleanupRows.length === 0
                  ? "Nothing to clean up — all checks came up clean."
                  : `${String(cleanupRows.length)} candidates · pick action per row · Enter ✓ Apply`}
              </text>
            </box>
            <VSpacer />
            <Table
              columns={CLEANUP_COLUMNS}
              rows={cleanupRows.map((r) => ({
                ...r,
                action: cleanupAction(r.id),
              }))}
              width={contentW}
              selectedIndex={cursor < cleanupRows.length ? cursor : -1}
              focused
              maxRows={Math.max(5, popupH - 14)}
              emptyMessage="No cleanup candidates"
            />
            {cleanupRows.length > 0 ? (
              <box flexDirection="row" paddingX={2} backgroundColor={t.bgPopup}>
                <text
                  bg={t.bgPopup}
                  fg={cursor === cleanupRows.length ? t.brand : t.textMuted}
                  attributes={cursor === cleanupRows.length ? 1 : undefined}
                >
                  {cursor === cleanupRows.length ? "▸ " : "  "}✓ Apply selected actions
                </text>
              </box>
            ) : null}
          </>
        ) : (
          <>
            <Search
              value={query}
              focused={!confirmPurge}
              placeholder={tab === "Hidden" ? "Filter hidden…" : "Filter by summary, topic, scope…"}
              count={
                query
                  ? `${String(filteredRows.length)} / ${String(tab === "Hidden" ? hiddenRows.length : allRows.length)}`
                  : undefined
              }
            />
            <VSpacer />
            <Table
              columns={COLUMNS}
              rows={filteredRows}
              width={contentW}
              selectedIndex={confirmPurge ? -1 : cursor}
              focused={!confirmPurge}
              maxRows={Math.max(5, popupH - 14)}
              emptyMessage={
                query
                  ? "No matches"
                  : tab === "Hidden"
                    ? "No soft-deleted memories"
                    : "No memories yet — write some via the memory tool"
              }
            />
          </>
        )}
        {confirmPurge ? (
          <>
            <VSpacer />
            <Hint kind="warn">
              Permanently clear all {String(allRows.length + hiddenRows.length)} memories from
              project + global? Press [y] to confirm, any other key to cancel.
            </Hint>
          </>
        ) : null}
      </Section>
    </PremiumPopup>
  );
}
