import { decodePasteBytes, type PasteEvent, TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { fetchGroupedModels, fetchProviderModels } from "../../../../core/llm/models.js";
import { getAllProviders, getProvider } from "../../../../core/llm/providers/index.js";
import type { ProviderModelInfo } from "../../../../core/llm/providers/types.js";
import {
  getDefaultKeyPriority,
  getSecretSources,
  type SecretKey,
  setSecret,
} from "../../../../core/secrets.js";
import { useTheme } from "../../../../core/theme/index.js";
import { KeyCaps, Search, VirtualList, VSpacer } from "../../../ui/index.js";
import { StepHeader } from "../primitives.js";
import { BOLD } from "../theme.js";

// ── Data ──

interface ProviderEntry {
  id: SecretKey;
  providerId: string;
  label: string;
  envVar: string;
  url: string;
  desc: string;
  icon: string;
  autoDetect?: boolean;
}

const GATEWAY_REF = "https://llmgateway.io/dashboard?ref=6tjJR2H3X4E9RmVQiQwK";

/** URL overrides for specific providers (e.g. referral links). */
const URL_OVERRIDES: Record<string, string> = {
  llmgateway: GATEWAY_REF,
};

/** Derive wizard provider list from the provider registry — single source of truth. */
const PROVIDERS: ProviderEntry[] = getAllProviders()
  .filter((p) => p.envVar && p.secretKey)
  .map((p) => ({
    id: p.secretKey as SecretKey,
    providerId: p.id,
    label: p.name,
    envVar: p.envVar,
    url: URL_OVERRIDES[p.id] ?? (p.keyUrl ? `https://${p.keyUrl}` : ""),
    desc: p.description ?? "",
    icon: p.icon,
  }));

// ── Helpers ──

function hasKey(id: SecretKey): boolean {
  return getSecretSources(id, getDefaultKeyPriority()).active !== "none";
}

function getStatusTag(id: SecretKey): string {
  const s = getSecretSources(id, getDefaultKeyPriority());
  if (s.active === "none") return "";
  return s.active;
}

interface ModelEntry {
  id: string;
  name: string;
  group?: string;
}

function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

// ── Phases ──

type Phase = "provider" | "key" | "fetching" | "models" | "error";

// ── Sub-components ──

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Fixed chrome around the provider list (popup shell + header + intro + spacers +
// optional status lines + keycaps). Subtracted from popup height so the list
// scrolls instead of overflowing — see ThemeStep for the same pattern.
const PROVIDER_CHROME_ROWS = 13;

function ProviderRow({
  p,
  isSelected,
  autoAvailable,
  width,
}: {
  p: ProviderEntry;
  isSelected: boolean;
  autoAvailable?: boolean;
  width: number;
}) {
  const t = useTheme();
  const bg = isSelected ? t.bgPopupHighlight : t.bgPopup;
  const configured = hasKey(p.id);
  const tag = getStatusTag(p.id);

  // Keep each row to a single line so VirtualList's per-row height stays exact;
  // a wrapped description would desync the scroll viewport. The provider name
  // always wins, the description is truncated to whatever width is left.
  const tagText = configured ? `  ✓ ${tag}` : autoAvailable ? "  ✓ auto" : "";
  const fixed = 6 + p.label.length + 3 + tagText.length;
  const descBudget = width - 4 - fixed;
  const showDesc = descBudget > 1;
  const desc =
    showDesc && descBudget < p.desc.length
      ? `${p.desc.slice(0, Math.max(0, descBudget - 1))}…`
      : p.desc;

  return (
    <box flexDirection="row" paddingX={2} height={1} backgroundColor={bg}>
      <text bg={bg}>
        <span fg={isSelected ? t.brand : t.textFaint}>
          {isSelected ? "› " : "  "}
          {p.icon}
          {"  "}
        </span>
        <span fg={isSelected ? t.textPrimary : t.textSecondary} attributes={BOLD}>
          {p.label}
        </span>
        {showDesc ? (
          <span fg={t.textFaint}>
            {" — "}
            {desc}
          </span>
        ) : null}
        {configured ? (
          <span fg={t.success}>
            {"  ✓ "}
            {tag}
          </span>
        ) : null}
        {!configured && autoAvailable ? <span fg={t.success}>{"  ✓ auto"}</span> : null}
      </text>
    </box>
  );
}

function ModelRow({ m, isSelected }: { m: ModelEntry; isSelected: boolean }) {
  const t = useTheme();
  const bg = isSelected ? t.bgPopupHighlight : t.bgPopup;

  return (
    <box flexDirection="row" paddingX={2} backgroundColor={bg}>
      <text bg={bg}>
        <span fg={isSelected ? t.brand : t.textFaint}>{isSelected ? "› " : "  "}</span>
        {m.group ? (
          <span fg={t.textFaint}>
            {m.group}
            {" › "}
          </span>
        ) : null}
        <span fg={isSelected ? t.textPrimary : t.textSecondary}>{m.name}</span>
      </text>
    </box>
  );
}

// ── Main Component ──

interface SetupStepProps {
  iw: number;
  hasModel: boolean;
  activeModel: string;
  onSelectModel: (modelId?: string) => void;
  onForward: () => void;
  active: boolean;
  setActive: (v: boolean) => void;
}

export function SetupStep({
  iw,
  hasModel,
  activeModel,
  onSelectModel,
  onForward,
  setActive,
}: SetupStepProps) {
  {
    const t = useTheme();
    const renderer = useRenderer();
    const { height: termRows } = useTerminalDimensions();

    const [phase, setPhase] = useState<Phase>("provider");
    const [cursor, setCursor] = useState(0);
    const [selectedProvider, setSelectedProvider] = useState<ProviderEntry | null>(null);

    // Key input
    const [keyInput, setKeyInput] = useState("");

    // Model state
    const [allModels, setAllModels] = useState<ModelEntry[]>([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [modelCursor, setModelCursor] = useState(0);

    // Feedback
    const [flash, setFlash] = useState<string | null>(null);
    const [errorMsg, setErrorMsg] = useState("");
    const [spinnerFrame, setSpinnerFrame] = useState(0);

    const [tick, setTick] = useState(0);
    const [autoAvailMap, setAutoAvailMap] = useState<Record<string, boolean>>({});
    const spinnerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const inputWidth = Math.min(Math.floor(iw * 0.8), 60);
    const maxH = Math.max(24, Math.floor(termRows * 0.7));
    const maxVisibleProviders = Math.max(4, maxH - PROVIDER_CHROME_ROWS);
    const refresh = () => setTick((n) => n + 1);
    void tick;
    const anyKeySet =
      PROVIDERS.some((p) => hasKey(p.id)) || Object.values(autoAvailMap).some(Boolean);

    useEffect(() => {
      for (const p of PROVIDERS) {
        if (!p.autoDetect) continue;
        const prov = getProvider(p.providerId);
        if (prov?.checkAvailability) {
          prov.checkAvailability().then((ok) => {
            setAutoAvailMap((m) => ({ ...m, [p.id]: ok }));
          });
        }
      }
    }, []);

    const isInputPhase = phase !== "provider";
    useEffect(() => {
      setActive(isInputPhase);
    }, [isInputPhase, setActive]);

    useEffect(() => {
      if (phase !== "key") return;
      const handler = (event: PasteEvent) => {
        const cleaned = decodePasteBytes(event.bytes)
          .replace(/[\n\r]/g, "")
          .trim();
        if (cleaned) setKeyInput((v) => v + cleaned);
      };
      renderer.keyInput.on("paste", handler);
      return () => {
        renderer.keyInput.off("paste", handler);
      };
    }, [phase, renderer]);

    useEffect(() => {
      if (phase === "fetching") {
        spinnerRef.current = setInterval(
          () => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length),
          80,
        );
        return () => {
          if (spinnerRef.current) clearInterval(spinnerRef.current);
        };
      }
      if (spinnerRef.current) {
        clearInterval(spinnerRef.current);
        spinnerRef.current = null;
      }
      return undefined;
    }, [phase]);

    useEffect(() => {
      setPhase("provider");
      setCursor(0);
    }, []);

    const filteredModels = searchQuery
      ? allModels.filter(
          (m) => fuzzyMatch(searchQuery, m.name) || fuzzyMatch(searchQuery, m.group ?? ""),
        )
      : allModels;

    useEffect(() => {
      if (modelCursor >= filteredModels.length) {
        setModelCursor(Math.max(0, filteredModels.length - 1));
      }
    }, [filteredModels.length, modelCursor]);

    const fetchModels = async (provider: ProviderEntry) => {
      setPhase("fetching");
      setAllModels([]);
      setSearchQuery("");
      setModelCursor(0);

      try {
        const providerDef = getProvider(provider.providerId);
        let modelList: ModelEntry[] = [];

        if (providerDef?.grouped) {
          const result = await fetchGroupedModels(provider.providerId);
          if (result.error) {
            setErrorMsg(result.error);
            setPhase("error");
            return;
          }
          for (const sub of result.subProviders) {
            const subModels = result.modelsByProvider[sub.id] ?? [];
            for (const m of subModels) {
              modelList.push({ id: `${sub.id}/${m.id}`, name: m.name, group: sub.name });
            }
          }
        } else {
          const result = await fetchProviderModels(provider.providerId);
          if (result.error) {
            setErrorMsg(result.error);
            setPhase("error");
            return;
          }
          modelList = result.models.map((m: ProviderModelInfo) => ({
            id: `${provider.providerId}/${m.id}`,
            name: m.name,
          }));
        }

        if (modelList.length === 0) {
          setErrorMsg("No models returned. Check your API key.");
          setPhase("error");
          return;
        }

        setAllModels(modelList);
        setPhase("models");
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Failed to fetch models");
        setPhase("error");
      }
    };

    const handleKeyboard = (evt: import("@opentui/core").KeyEvent) => {
      if (phase === "models") {
        if (evt.name === "escape") {
          if (searchQuery) {
            setSearchQuery("");
            setModelCursor(0);
          } else {
            setPhase("provider");
          }
          evt.preventDefault();
          return;
        }
        if (evt.name === "up") {
          setModelCursor((c) => (c > 0 ? c - 1 : filteredModels.length - 1));
          evt.preventDefault();
          return;
        }
        if (evt.name === "down") {
          setModelCursor((c) => (c < filteredModels.length - 1 ? c + 1 : 0));
          evt.preventDefault();
          return;
        }
        if (evt.name === "return") {
          const selected = filteredModels[modelCursor];
          if (selected) {
            onSelectModel(selected.id);
            setFlash(`✓ ${selected.name}`);
            setPhase("provider");
            setTimeout(() => {
              setFlash(null);
              onForward();
            }, 600);
          }
          evt.preventDefault();
          return;
        }
        if (evt.name === "backspace") {
          setSearchQuery((q) => q.slice(0, -1));
          setModelCursor(0);
          evt.preventDefault();
          return;
        }
        if (evt.sequence && evt.sequence.length === 1 && !evt.ctrl && !evt.meta) {
          setSearchQuery((q) => q + evt.sequence);
          setModelCursor(0);
        }
        evt.preventDefault();
        return;
      }

      if (phase === "error") {
        if (evt.name === "return") {
          setPhase("key");
          setKeyInput("");
          evt.preventDefault();
          return;
        }
        if (evt.name === "escape") {
          setPhase("provider");
          evt.preventDefault();
          return;
        }
        evt.preventDefault();
        return;
      }

      if (phase === "fetching") {
        evt.preventDefault();
        return;
      }

      if (phase === "key") {
        if (evt.name === "escape") {
          setPhase("provider");
          setKeyInput("");
          evt.preventDefault();
          return;
        }
        if (evt.name === "return") {
          if (selectedProvider && keyInput.trim()) {
            const result = setSecret(selectedProvider.id, keyInput.trim());
            if (result.success) {
              refresh();
              fetchModels(selectedProvider);
            }
          }
          evt.preventDefault();
          return;
        }
        if (evt.name === "backspace") {
          setKeyInput((v) => v.slice(0, -1));
          evt.preventDefault();
          return;
        }
        if (evt.sequence && evt.sequence.length === 1 && !evt.ctrl && !evt.meta) {
          setKeyInput((v) => v + evt.sequence);
        }
        evt.preventDefault();
        return;
      }

      if (evt.name === "up") {
        setCursor((c) => (c > 0 ? c - 1 : PROVIDERS.length - 1));
        evt.preventDefault();
        return;
      }
      if (evt.name === "down") {
        setCursor((c) => (c < PROVIDERS.length - 1 ? c + 1 : 0));
        evt.preventDefault();
        return;
      }
      if (evt.name === "return") {
        const provider = PROVIDERS[cursor];
        if (!provider) {
          evt.preventDefault();
          return;
        }
        setSelectedProvider(provider);
        if (hasKey(provider.id) || (provider.autoDetect && autoAvailMap[provider.id])) {
          fetchModels(provider);
        } else {
          setPhase("key");
          setKeyInput("");
        }
        evt.preventDefault();
        return;
      }
      evt.preventDefault();
    };

    useKeyboard(handleKeyboard);

    // ── Render: Fetching ──
    if (phase === "fetching" && selectedProvider) {
      return (
        <box flexDirection="column" paddingX={2} backgroundColor={t.bgPopup}>
          <VSpacer />
          <StepHeader ic={selectedProvider.icon} title={selectedProvider.label} />
          <VSpacer />
          <text bg={t.bgPopup} fg={t.info}>
            {" "}
            {SPINNER_FRAMES[spinnerFrame]}
            {" Fetching models..."}
          </text>
        </box>
      );
    }

    // ── Render: Model picker with search ──
    if (phase === "models" && selectedProvider) {
      const maxVisible = Math.min(10, filteredModels.length);
      const half = Math.floor(maxVisible / 2);
      const scrollOffset = Math.max(
        0,
        Math.min(modelCursor - half, filteredModels.length - maxVisible),
      );
      const visible = filteredModels.slice(scrollOffset, scrollOffset + maxVisible);

      return (
        <box flexDirection="column" paddingX={2} backgroundColor={t.bgPopup}>
          <VSpacer />
          <StepHeader
            ic={selectedProvider.icon}
            title={`${selectedProvider.label} — Pick a Model`}
          />
          <VSpacer />
          <Search
            value={searchQuery}
            placeholder="type to filter..."
            focused
            count={
              filteredModels.length !== allModels.length
                ? `${String(filteredModels.length)}/${String(allModels.length)}`
                : undefined
            }
          />
          <VSpacer />
          {filteredModels.length === 0 ? (
            <text bg={t.bgPopup} fg={t.textFaint}>
              {"  No models match your search."}
            </text>
          ) : (
            <>
              {visible.map((m, i) => {
                const realIdx = scrollOffset + i;
                return <ModelRow key={m.id} m={m} isSelected={realIdx === modelCursor} />;
              })}
              {filteredModels.length > maxVisible ? (
                <text bg={t.bgPopup} fg={t.textFaint}>
                  {"  "}
                  {`${String(modelCursor + 1)} of ${String(filteredModels.length)}`}
                </text>
              ) : null}
            </>
          )}
          <VSpacer />
          <KeyCaps
            hints={[
              { key: "↑↓", label: "navigate" },
              { key: "⏎", label: "select" },
              { key: "Esc", label: searchQuery ? "clear search" : "back" },
            ]}
          />
        </box>
      );
    }

    // ── Render: Error ──
    if (phase === "error" && selectedProvider) {
      return (
        <box flexDirection="column" paddingX={2} backgroundColor={t.bgPopup}>
          <VSpacer />
          <StepHeader ic={selectedProvider.icon} title={selectedProvider.label} />
          <VSpacer />
          <text bg={t.bgPopup} fg={t.error}>
            {"  ✗ "}
            {errorMsg.length > iw - 10 ? `${errorMsg.slice(0, iw - 13)}...` : errorMsg}
          </text>
          <VSpacer />
          <KeyCaps
            hints={[
              { key: "⏎", label: "re-enter key" },
              { key: "Esc", label: "back" },
            ]}
          />
        </box>
      );
    }

    // ── Render: Key input ──
    if (phase === "key" && selectedProvider) {
      const masked =
        keyInput.length > 0
          ? `${"*".repeat(Math.max(0, keyInput.length - 4))}${keyInput.slice(-4)}`
          : "";
      const displayMask =
        masked.length > inputWidth ? `…${masked.slice(-(inputWidth - 1))}` : masked;

      return (
        <box flexDirection="column" paddingX={2} backgroundColor={t.bgPopup}>
          <VSpacer />
          <StepHeader ic="⚿" title={`Set ${selectedProvider.label} Key`} />
          <VSpacer />

          <text bg={t.bgPopup}>
            <span fg={t.textSecondary}>{"  Get your key at "}</span>
            <a href={selectedProvider.url}>
              <span fg={t.info} attributes={TextAttributes.UNDERLINE}>
                {selectedProvider.url.replace("https://", "").replace(/\?.*$/, "")}
              </span>
            </a>
          </text>

          <VSpacer />
          <Search value={displayMask} placeholder="paste or type your key" focused icon="key" />
          <VSpacer />

          <KeyCaps
            hints={[
              { key: "⏎", label: "save & fetch" },
              { key: "Esc", label: "cancel" },
            ]}
          />
        </box>
      );
    }

    // ── Render: Provider selection ──
    return (
      <box flexDirection="column" paddingX={2} backgroundColor={t.bgPopup}>
        <VSpacer />
        <StepHeader ic="◈" title="Choose a Provider" />
        <VSpacer />
        <text bg={t.bgPopup} fg={t.textSecondary}>
          {"  Select a provider and press ⏎ to set up."}
        </text>
        <VSpacer />

        <VirtualList
          items={PROVIDERS}
          selectedIndex={cursor}
          width={iw}
          maxRows={maxVisibleProviders}
          keyExtractor={(p) => p.id}
          renderItem={(p, { selected }) => (
            <ProviderRow
              p={p}
              isSelected={selected}
              autoAvailable={p.autoDetect ? autoAvailMap[p.id] : undefined}
              width={iw}
            />
          )}
        />

        {PROVIDERS[cursor]?.providerId === "copilot" ? (
          <>
            <VSpacer />
            <text bg={t.bgPopup} fg={t.textMuted}>
              {"  Unofficial. Use gh auth token or GITHUB_TOKEN."}
            </text>
          </>
        ) : null}

        {PROVIDERS[cursor]?.id === "llmgateway-api-key" && !hasKey("llmgateway-api-key") ? (
          <>
            <VSpacer />
            <text bg={t.bgPopup}>
              <span fg={t.textFaint}>{"  "}</span>
              <a href={GATEWAY_REF}>
                <span fg={t.info} attributes={TextAttributes.UNDERLINE}>
                  llmgateway.io
                </span>
              </a>
              <span fg={t.textFaint}>{" — one key for all models"}</span>
            </text>
          </>
        ) : null}

        {hasModel ? (
          <>
            <VSpacer />
            <text bg={t.bgPopup} attributes={BOLD}>
              <span fg={t.success}>{"  ✓ "}</span>
              <span fg={t.textPrimary}>{activeModel}</span>
            </text>
          </>
        ) : null}

        {flash ? (
          <>
            <VSpacer />
            <text bg={t.bgPopup} fg={t.success} attributes={BOLD}>
              {"  "}
              {flash}
            </text>
          </>
        ) : null}

        <VSpacer />
        <KeyCaps
          hints={[
            { key: "↑↓", label: "select" },
            { key: "⏎", label: "set up" },
            { key: anyKeySet ? "→" : "Esc", label: anyKeySet ? "next step" : "close" },
          ]}
        />
      </box>
    );
  }
}
