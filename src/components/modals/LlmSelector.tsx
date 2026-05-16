/**
 * LlmSelector — model picker.
 *
 * Performance characteristics:
 *  - Opens instantly from cache (no defer) — whatever prewarmAllModels fetched
 *    at boot is shown immediately.
 *  - Per-provider loading spinners in the group header — users see individual
 *    providers settle as their fetches complete. No batch freeze.
 *  - Only the active provider is expanded on open; scrollbox windows the rest.
 *  - Fuzzy search auto-expands matching groups.
 */

import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { frecencyScore, getFrecencyDB } from "../../core/history/index.js";
import { providerIcon } from "../../core/icons.js";
import { PROVIDER_CONFIGS, type ProviderModelInfo } from "../../core/llm/models.js";
import { getProvider } from "../../core/llm/providers/index.js";
import { useAllProviderModels } from "../../hooks/useAllProviderModels.js";
import { isModelFree } from "../../stores/statusbar.js";
import { useUIStore } from "../../stores/ui.js";
import {
  buildGroupedRows,
  fuzzyFilterGroups,
  type GroupedItem,
  GroupedList,
  type GroupedListGroup,
  PremiumPopup,
  Search,
  Section,
  VSpacer,
} from "../ui/index.js";

interface Props {
  visible: boolean;
  activeModel: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

interface ModelRow extends GroupedItem {
  fullId: string;
}

function formatCtx(n: number | undefined): string | null {
  if (!n) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function buildMeta(m: ProviderModelInfo, free: boolean): string | undefined {
  const parts: string[] = [];
  const ctx = formatCtx(m.contextWindow);
  if (ctx) parts.push(ctx);
  if (free) parts.push("FREE");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function LlmSelector({ visible, activeModel, onSelect, onClose }: Props) {
  const { width: tw, height: th } = useTerminalDimensions();
  const { providerData, availability } = useAllProviderModels(visible);

  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const cursorRef = useRef(0);
  cursorRef.current = cursor;

  // Reset on open — NEVER on providerData changes (would wipe user navigation).
  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setSearchMode(false);
    setCursor(0);
    const activeProvider = activeModel.split("/")[0] ?? "";
    setExpanded(activeProvider ? new Set([activeProvider]) : new Set());
  }, [visible, activeModel]);

  // Dimensions — wide enough for provider labels + ctx + FREE badge, capped
  // so it never fills tiny terminals.
  const popupW = Math.min(92, Math.max(82, Math.floor(tw * 0.75)));
  const popupH = Math.min(32, Math.max(18, th - 4));
  const contentW = popupW - 4; // outer border(2) + Section paddingX(2)

  // Build groups from provider data. Within each provider, models you've
  // picked recently float to the top — frecency score = freq * 1/(1+days).
  const frecencyByModel = useMemo(() => {
    if (!visible) return new Map<string, number>();
    const allIds: string[] = [];
    for (const cfg of PROVIDER_CONFIGS) {
      const items = providerData[cfg.id]?.items ?? [];
      for (const m of items) allIds.push(`${cfg.id}/${m.id}`);
    }
    if (allIds.length === 0) return new Map<string, number>();
    const rows = getFrecencyDB().byKeys("model", allIds);
    const now = Date.now();
    const out = new Map<string, number>();
    for (const [k, r] of rows) {
      out.set(k, frecencyScore(r.frequency, r.lastUsedAt, now));
    }
    return out;
  }, [visible, providerData]);

  const groups = useMemo<GroupedListGroup<ModelRow>[]>(() => {
    return PROVIDER_CONFIGS.map((cfg) => {
      const pd = providerData[cfg.id];
      const avail = availability.get(cfg.id) ?? false;
      const loading = pd?.loading ?? true;
      const items = pd?.items ?? [];
      const hasError = Boolean(pd?.error) && items.length === 0 && !loading;
      const noKey = !avail && !loading;

      const rows: ModelRow[] = noKey
        ? []
        : items
            .map((m) => {
              const fullId = `${cfg.id}/${m.id}`;
              return {
                id: m.id,
                fullId,
                label: m.name || m.id,
                meta: buildMeta(m, isModelFree(fullId)),
                active: fullId === activeModel,
                _score: frecencyByModel.get(fullId) ?? 0,
              };
            })
            .sort((a, b) => {
              if (b._score !== a._score) return b._score - a._score;
              return 0;
            });

      const meta = noKey
        ? (cfg.noAuthLabel ?? "no key — press [Enter] to add")
        : hasError
          ? (cfg.authErrorLabel ?? pd?.error ?? "error")
          : cfg.badge;

      const status = noKey
        ? "warning"
        : hasError
          ? "error"
          : loading
            ? undefined
            : ("online" as const);

      return {
        id: cfg.id,
        label: cfg.name,
        iconGlyph: providerIcon(cfg.id),
        items: rows,
        loading,
        meta,
        status,
      };
    });
  }, [providerData, availability, activeModel, frecencyByModel.get]);

  const filteredGroups = useMemo(() => fuzzyFilterGroups(groups, query), [groups, query]);

  // Auto-expand matching groups while a filter is active.
  const effectiveExpanded = useMemo(
    () => (query.trim().length > 0 ? new Set(filteredGroups.map((g) => g.id)) : expanded),
    [query, filteredGroups, expanded],
  );

  const rows = useMemo(
    () => buildGroupedRows(filteredGroups, effectiveExpanded),
    [filteredGroups, effectiveExpanded],
  );

  // Clamp cursor when rows shrink.
  useEffect(() => {
    if (cursor >= rows.length && rows.length > 0) setCursor(rows.length - 1);
  }, [rows.length, cursor]);

  const totalModels = groups.reduce((a, g) => a + g.items.length, 0);
  const loadedProviders = groups.filter((g) => !g.loading).length;

  useKeyboard((evt) => {
    if (!visible) return;

    // Search-mode text entry
    if (searchMode) {
      if (evt.name === "escape") {
        if (query.length > 0) setQuery("");
        else setSearchMode(false);
        setCursor(0);
        return;
      }
      if (evt.name === "return") {
        setSearchMode(false);
        setCursor(0);
        return;
      }
      if (evt.name === "backspace") {
        setQuery((q) => q.slice(0, -1));
        setCursor(0);
        return;
      }
      const ch = evt.sequence;
      if (typeof ch === "string" && ch.length === 1 && ch >= " " && ch !== "\x7f") {
        setQuery((q) => q + ch);
        setCursor(0);
      }
      return;
    }

    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "/") {
      setSearchMode(true);
      return;
    }

    const cur = rows[cursorRef.current];
    if (evt.name === "down" || evt.name === "j") {
      if (rows.length > 0) setCursor((c) => (c + 1) % rows.length);
      return;
    }
    if (evt.name === "up" || evt.name === "k") {
      if (rows.length > 0) setCursor((c) => (c - 1 + rows.length) % rows.length);
      return;
    }
    if (evt.name === "left" || evt.name === "h") {
      if (cur?.kind === "group" && cur.expanded) {
        setExpanded((s) => {
          const n = new Set(s);
          n.delete(cur.groupId);
          return n;
        });
      } else if (cur?.kind === "item") {
        const parentIdx = rows.findIndex((r) => r.kind === "group" && r.groupId === cur.groupId);
        if (parentIdx >= 0) setCursor(parentIdx);
      }
      return;
    }
    if (evt.name === "right" || evt.name === "l") {
      if (cur?.kind === "group" && !cur.expanded) {
        setExpanded((s) => new Set([...s, cur.groupId]));
      } else if (cur?.kind === "group" && cur.expanded) {
        const firstItem = rows.findIndex(
          (r, i) => i > cursorRef.current && r.kind === "item" && r.groupId === cur.groupId,
        );
        if (firstItem >= 0) setCursor(firstItem);
      }
      return;
    }
    if (evt.name === "tab") {
      // Jump to next group header
      const next = rows.findIndex((r, i) => i > cursorRef.current && r.kind === "group");
      if (next >= 0) setCursor(next);
      else {
        const first = rows.findIndex((r) => r.kind === "group");
        if (first >= 0) setCursor(first);
      }
      return;
    }
    if (evt.name === "return" || evt.name === "space") {
      if (!cur) return;
      if (cur.kind === "group") {
        const g = filteredGroups.find((x) => x.id === cur.groupId);
        // No-key or errored providers: route to auth install flow.
        if (g && (g.status === "warning" || g.status === "error")) {
          onClose();
          const provider = getProvider(cur.groupId);
          if (provider?.onRequestAuth) {
            void provider.onRequestAuth();
          } else {
            useUIStore.getState().openModal("apiKeySettings");
          }
          return;
        }
        setExpanded((s) => {
          const n = new Set(s);
          if (n.has(cur.groupId)) n.delete(cur.groupId);
          else n.add(cur.groupId);
          return n;
        });
      } else if (cur.kind === "item" && cur.item) {
        const r = cur.item as ModelRow;
        try {
          getFrecencyDB().bump("model", r.fullId);
        } catch {}
        onSelect(r.fullId);
        onClose();
      }
    }
  });

  if (!visible) return null;

  const blurb = query.trim()
    ? `${rows.filter((r) => r.kind === "item").length} of ${totalModels} models`
    : `${totalModels} models · ${loadedProviders}/${PROVIDER_CONFIGS.length} providers ready`;

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Select Model"
      titleIcon="model"
      blurb={blurb}
      footerHints={
        searchMode
          ? [
              { key: "type", label: "filter" },
              { key: "Backspace", label: "del" },
              { key: "Enter", label: "done" },
              { key: "Esc", label: "clear" },
            ]
          : [
              { key: "↑↓", label: "nav" },
              { key: "←→", label: "drill" },
              { key: "/", label: "search" },
              { key: "Enter", label: "select" },
              { key: "Esc", label: "close" },
            ]
      }
    >
      <Section>
        <Search
          value={query}
          focused={searchMode}
          placeholder="Try anthr/sonn · gpt · claude · gateway/opus"
        />
        <VSpacer />
        <GroupedList
          groups={filteredGroups}
          expanded={effectiveExpanded}
          selectedIndex={searchMode ? -1 : cursor}
          width={contentW}
          maxRows={Math.max(8, popupH - 12)}
          focused={!searchMode}
          emptyMessage="No matches — try a shorter query"
        />
      </Section>
    </PremiumPopup>
  );
}
