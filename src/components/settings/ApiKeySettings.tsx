import { decodePasteBytes, type PasteEvent } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { saveGlobalConfig } from "../../config/index.js";
import { providerIcon } from "../../core/icons.js";
import { getAllProviders } from "../../core/llm/providers/index.js";
import {
  addPooledKey,
  deleteSecret,
  getDefaultKeyPriority,
  getPooledKeys,
  getSecretSources,
  getStorageBackend,
  type KeyPriority,
  type SecretKey,
  type SecretSources,
  setDefaultKeyPriority,
  setSecret,
} from "../../core/secrets.js";
import {
  buildGroupedRows,
  type GroupedItem,
  GroupedList,
  type GroupedListGroup,
  Hint,
  handleCursorNavKey,
  PremiumPopup,
  Search,
  Section,
  VSpacer,
} from "../ui/index.js";

interface KeyItem {
  id: SecretKey;
  label: string;
  envVar: string;
  url?: string;
  providerId: string;
  grouped: boolean;
}

function buildKeyItems(): KeyItem[] {
  return getAllProviders()
    .filter((p): p is typeof p & { secretKey: string } => !!(p.envVar && p.secretKey))
    .map((p) => ({
      id: p.secretKey as SecretKey,
      label: p.name,
      envVar: p.envVar,
      url: p.keyUrl,
      providerId: p.id,
      grouped: !!p.grouped,
    }));
}

interface ApiKeyState {
  keys: Record<string, SecretSources>;
  priority: KeyPriority;
  refresh: (items: KeyItem[]) => void;
}

function buildKeys(items: KeyItem[], priority: KeyPriority): Record<string, SecretSources> {
  return Object.fromEntries(items.map((k) => [k.id, getSecretSources(k.id, priority)]));
}

const useApiKeyStore = create<ApiKeyState>()((set, get) => ({
  keys: {},
  priority: getDefaultKeyPriority(),
  refresh: (items: KeyItem[]) => set({ keys: buildKeys(items, get().priority) }),
}));

interface MenuRow extends GroupedItem {
  kind: "set" | "remove" | "priority";
  targetKey?: SecretKey;
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

function formatBadges(sources: SecretSources): string {
  const parts: string[] = [];
  const tag = (label: string, isActive: boolean) => (isActive ? `[${label}]` : `(${label})`);
  if (sources.env) parts.push(tag("env", sources.active === "env"));
  if (sources.keychain) parts.push(tag("keychain", sources.active === "keychain"));
  if (sources.file) parts.push(tag("file", sources.active === "file"));
  return parts.length > 0 ? parts.join(" ") : "not set";
}

export function ApiKeySettings({ visible, onClose }: Props) {
  const renderer = useRenderer();
  const { width: tw, height: th } = useTerminalDimensions();
  const keyItems = useMemo(() => buildKeyItems(), []);
  const keys = useApiKeyStore((s) => s.keys);
  const priority = useApiKeyStore((s) => s.priority);
  const refresh = useApiKeyStore((s) => s.refresh);

  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<"menu" | "input">("menu");
  const [inputValue, setInputValue] = useState("");
  const [inputTarget, setInputTarget] = useState<SecretKey | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "err" | "info"; message: string } | null>(null);

  useEffect(() => {
    if (!visible) return;
    useApiKeyStore.setState({ priority: getDefaultKeyPriority() });
    refresh(keyItems);
    setCursor(0);
    setMode("menu");
    setFlash(null);
  }, [visible, refresh, keyItems]);

  useEffect(() => {
    if (!visible || mode !== "input") return;
    const handler = (event: PasteEvent) => {
      const cleaned = decodePasteBytes(event.bytes)
        .replace(/[\n\r]/g, "")
        .trim();
      if (cleaned) setInputValue((v) => v + cleaned);
    };
    renderer.keyInput.on("paste", handler);
    return () => {
      renderer.keyInput.off("paste", handler);
    };
  }, [visible, mode, renderer]);

  const popupW = Math.min(100, Math.max(72, Math.floor(tw * 0.8)));
  const popupH = Math.min(36, Math.max(20, th - 4));
  const contentW = popupW - 4;

  const groups = useMemo<GroupedListGroup<MenuRow>[]>(() => {
    const direct = keyItems.filter((k) => !k.grouped);
    const gateways = keyItems.filter((k) => k.grouped);

    const mapKey = (k: KeyItem): MenuRow[] => {
      const sources = keys[k.id];
      if (!sources) return [];
      const allKeys = getPooledKeys(k.id);
      const metaExtra = allKeys.length > 1 ? ` [${allKeys.length} keys]` : "";
      const out: MenuRow[] = [
        {
          id: k.id,
          kind: "set",
          targetKey: k.id,
          label: `${providerIcon(k.providerId)}  ${k.label}`,
          meta: formatBadges(sources) + metaExtra,
          active: sources.active !== "none",
          status: sources.active !== "none" ? "online" : "offline",
        },
        {
          id: `${k.id}-add`,
          kind: "set",
          targetKey: `add:${k.id}`,
          label: `Add another key for ${k.label}`,
          status: "online",
          meta: "pool additional keys",
        },
      ];
      if (sources.keychain || sources.file) {
        out.push({
          id: `${k.id}-remove`,
          kind: "remove",
          targetKey: k.id,
          label: `Remove ${k.label}`,
          status: "error",
          meta: "delete stored key",
        });
      }
      return out;
    };

    const gs: GroupedListGroup<MenuRow>[] = [];
    if (direct.length > 0) {
      gs.push({ id: "providers", label: "Providers", items: direct.flatMap(mapKey) });
    }
    if (gateways.length > 0) {
      gs.push({ id: "gateways", label: "Gateways", items: gateways.flatMap(mapKey) });
    }
    gs.push({
      id: "settings",
      label: "Settings",
      items: [
        {
          id: "priority",
          kind: "priority",
          label: "Resolution",
          meta: priority === "env" ? "env vars first" : "app keys first",
        },
      ],
    });
    return gs;
  }, [keyItems, keys, priority]);

  const expanded = useMemo(() => new Set(groups.map((g) => g.id)), [groups]);
  const rows = useMemo(() => buildGroupedRows(groups, expanded), [groups, expanded]);

  const popFlash = (kind: "ok" | "err" | "info", message: string) => {
    setFlash({ kind, message });
    setTimeout(() => setFlash(null), 2500);
  };

  const moveItem = (dir: 1 | -1) => {
    if (rows.length === 0) return;
    let i = cursor + dir;
    for (let n = 0; n < rows.length; n++) {
      if (i < 0) i = rows.length - 1;
      else if (i >= rows.length) i = 0;
      if (rows[i]?.kind === "item") {
        setCursor(i);
        return;
      }
      i += dir;
    }
  };

  const togglePriority = () => {
    const next: KeyPriority = priority === "env" ? "app" : "env";
    setDefaultKeyPriority(next);
    useApiKeyStore.setState({ priority: next });
    refresh(keyItems);
    saveGlobalConfig({ keyPriority: next });
    popFlash("ok", `Priority: ${next === "env" ? "env first" : "app first"}`);
  };

  const confirmInput = () => {
    if (!inputTarget || !inputValue.trim()) {
      setMode("menu");
      return;
    }
    // Check if this is an additional key (if input starts with "add:")
    const isAddMode = inputTarget.startsWith("add:");
    const targetKey = isAddMode ? inputTarget.slice(4) as SecretKey : inputTarget;
    const keyValue = inputValue.trim();

    if (isAddMode) {
      // Add to pool of keys
      const keys = addPooledKey(targetKey, keyValue);
      popFlash("ok", `Added key (total: ${keys.length} keys in pool)`);
    } else {
      const result = setSecret(targetKey, keyValue);
      if (result.success) {
        const where = result.storage === "keychain" ? "OS keychain" : (result.path ?? "secrets.json");
        popFlash("ok", `Saved to ${where}`);
      } else {
        popFlash("err", "Failed to save key");
      }
    }
    refresh(keyItems);
    setMode("menu");
    setInputValue("");
    setInputTarget(null);
  };

  const removeKey = (keyId: SecretKey) => {
    const result = deleteSecret(keyId);
    if (result.success) popFlash("ok", `Removed from ${result.storage}`);
    else popFlash("err", "Key not found");
    refresh(keyItems);
  };

  useKeyboard((evt) => {
    if (!visible) return;

    if (mode === "input") {
      if (evt.name === "escape") {
        setMode("menu");
        setInputValue("");
        setInputTarget(null);
        return;
      }
      if (evt.name === "return") {
        confirmInput();
        return;
      }
      if (evt.name === "backspace") {
        setInputValue((v) => v.slice(0, -1));
        return;
      }
      const ch = evt.sequence;
      if (typeof ch === "string" && ch.length === 1 && ch >= " " && !evt.ctrl && !evt.meta) {
        setInputValue((v) => v + ch);
      }
      return;
    }

    if (evt.name === "escape") {
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
    if (evt.name === "return" || evt.name === "space") {
      const r = rows[cursor];
      if (r?.kind === "item" && r.item) {
        const row = r.item as MenuRow;
        if (row.kind === "priority") togglePriority();
        else if (row.kind === "set" && row.targetKey) {
          setInputTarget(row.targetKey);
          setInputValue("");
          setMode("input");
        } else if (row.kind === "remove" && row.targetKey) removeKey(row.targetKey);
      }
      return;
    }
    handleCursorNavKey(evt, setCursor, rows.length);
  });

  if (!visible) return null;

  const backend = getStorageBackend();
  const backendLabel = backend === "keychain" ? "OS Keychain" : "~/.soulforge/secrets.json";
  const configured = keyItems.filter((k) => keys[k.id]?.active !== "none").length;

  if (mode === "input") {
    const target = keyItems.find((k) => k.id === inputTarget);
    const masked =
      inputValue.length > 0
        ? `${"*".repeat(Math.max(0, inputValue.length - 4))}${inputValue.slice(-4)}`
        : "";
    return (
      <PremiumPopup
        visible={visible}
        width={popupW}
        height={12}
        title={target?.label ?? "API Key"}
        titleIcon="key"
        blurb={target?.url ?? "Paste your key"}
        footerHints={[
          { key: "Enter", label: "save" },
          { key: "Esc", label: "cancel" },
        ]}
      >
        <Section>
          <Search value={masked} focused placeholder="Paste your key" icon="key" />
          <VSpacer />
          <Hint>
            Storage: {backendLabel}
            {target?.envVar ? ` · env var: ${target.envVar}` : ""}
          </Hint>
        </Section>
      </PremiumPopup>
    );
  }

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="API Keys"
      titleIcon="key"
      blurb={`${configured} / ${keyItems.length} configured · ${backendLabel}`}
      footerHints={[
        { key: "↑↓", label: "nav" },
        { key: "Enter", label: "set / toggle" },
        { key: "Esc", label: "close" },
      ]}
      flash={flash}
    >
      <Section>
        <GroupedList
          groups={groups}
          expanded={expanded}
          selectedIndex={cursor}
          width={contentW}
          maxRows={Math.max(8, popupH - 10)}
        />
      </Section>
    </PremiumPopup>
  );
}
