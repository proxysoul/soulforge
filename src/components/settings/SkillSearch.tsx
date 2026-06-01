import { existsSync } from "node:fs";
import { join } from "node:path";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextManager } from "../../core/context/manager.js";
import { getCwd } from "../../core/cwd.js";
import {
  type InstalledSkill,
  installSkill,
  listInstalledSkills,
  listPopularSkills,
  loadSkill,
  removeInstalledSkill,
  type SkillSearchResult,
  searchSkills,
} from "../../core/skills/manager.js";
import { useTheme } from "../../core/theme/index.js";
import { PremiumPopup, Radio, VirtualList } from "../ui/index.js";

const MAX_POPUP_WIDTH = 120;
const CHROME_ROWS = 9;

type Tab = "search" | "installed" | "active";
const TABS: Tab[] = ["search", "installed", "active"];

interface Props {
  visible: boolean;
  contextManager: ContextManager;
  onClose: () => void;
  onSystemMessage: (msg: string) => void;
}

function SearchSkillRow({
  skill,
  isSelected,
  isInstalled,
  isLoaded,
  innerW: _innerW,
}: {
  skill: SkillSearchResult;
  isSelected: boolean;
  isInstalled: boolean;
  isLoaded: boolean;
  innerW: number;
}) {
  const t = useTheme();
  const bg = isSelected ? t.bgPopupHighlight : t.bgPopup;
  return (
    <box flexDirection="row" backgroundColor={bg}>
      <text bg={bg} fg={isSelected ? t.brand : t.textMuted}>
        {isSelected ? "› " : "  "}
      </text>
      {isLoaded ? (
        <text bg={bg} fg={t.info} attributes={TextAttributes.BOLD}>
          {"● "}
        </text>
      ) : isInstalled ? (
        <text bg={bg} fg={t.success} attributes={TextAttributes.BOLD}>
          {"✓ "}
        </text>
      ) : null}
      <text
        bg={bg}
        fg={isSelected ? t.brand : t.textSecondary}
        attributes={isSelected ? TextAttributes.BOLD : undefined}
      >
        {skill.skillId}
      </text>
      <text bg={bg} fg={t.textMuted}>
        {" "}
        {skill.source}
      </text>
      <text bg={bg} fg={t.textDim}>
        {" "}
        {skill.installs.toLocaleString()}↓
      </text>
    </box>
  );
}

function InstalledSkillRow({
  skill,
  isSelected,
  isLoaded,
  innerW: _innerW,
}: {
  skill: InstalledSkill;
  isSelected: boolean;
  isLoaded: boolean;
  innerW: number;
}) {
  const t = useTheme();
  const bg = isSelected ? t.bgPopupHighlight : t.bgPopup;
  return (
    <box flexDirection="row" backgroundColor={bg}>
      <text bg={bg} fg={isSelected ? t.brand : t.textMuted}>
        {isSelected ? "› " : "  "}
      </text>
      <text
        bg={bg}
        fg={isSelected ? t.brand : t.textSecondary}
        attributes={isSelected ? TextAttributes.BOLD : undefined}
      >
        {skill.name}
      </text>
      <text bg={bg} fg={t.textMuted}>
        {" "}
        {skill.scope === "project" ? "(project)" : "(global)"}
      </text>
      {isLoaded && (
        <text bg={bg} fg={t.info} attributes={TextAttributes.BOLD}>
          {" "}
          ●
        </text>
      )}
    </box>
  );
}

function ActiveSkillRow({
  name,
  isSelected,
  innerW: _innerW,
}: {
  name: string;
  isSelected: boolean;
  innerW: number;
}) {
  const t = useTheme();
  const bg = isSelected ? t.bgPopupHighlight : t.bgPopup;
  return (
    <box flexDirection="row" backgroundColor={bg}>
      <text bg={bg} fg={isSelected ? t.brand : t.textMuted}>
        {isSelected ? "› " : "  "}
      </text>
      <text bg={bg} fg={t.info} attributes={TextAttributes.BOLD}>
        {"● "}
      </text>
      <text
        bg={bg}
        fg={isSelected ? t.brand : t.textPrimary}
        attributes={isSelected ? TextAttributes.BOLD : undefined}
      >
        {name}
      </text>
    </box>
  );
}

export function SkillSearch({ visible, contextManager, onClose, onSystemMessage }: Props) {
  const t = useTheme();
  const popupBg = t.bgPopup;
  const popupHl = t.bgPopupHighlight;
  const [tab, setTab] = useState<Tab>("search");
  const [query, setQuery] = useState("");
  const [popular, setPopular] = useState<SkillSearchResult[]>([]);
  const [results, setResults] = useState<SkillSearchResult[]>([]);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [pendingInstall, setPendingInstall] = useState<SkillSearchResult | null>(null);
  const [scopeCursor, setScopeCursor] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isInProject = existsSync(join(getCwd(), ".git"));
  const { width: termCols, height: termRows } = useTerminalDimensions();

  const containerRows = termRows - 2;
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.88));
  const maxVisible = Math.max(4, Math.floor(containerRows * 0.85) - CHROME_ROWS);
  const contentW = popupWidth - 22 - 3;
  const [cursor, setCursor] = useState(0);
  const resetScroll = useCallback(() => setCursor(0), []);

  const filterQuery = query.toLowerCase().trim();

  const installedNames = new Set(installed.map((s) => s.name));

  const filteredInstalled = filterQuery
    ? installed.filter((s) => s.name.toLowerCase().includes(filterQuery))
    : installed;

  const filteredActive = filterQuery
    ? activeSkills.filter((s) => s.toLowerCase().includes(filterQuery))
    : activeSkills;

  const displayResults = query.trim() ? results : popular;

  const currentListLen = (() => {
    if (tab === "search") return displayResults.length;
    if (tab === "installed") return filteredInstalled.length;
    return filteredActive.length;
  })();

  const refreshInstalled = useCallback(() => {
    setInstalled(listInstalledSkills());
  }, []);

  const refreshActive = useCallback(() => {
    setActiveSkills(contextManager.getActiveSkills());
  }, [contextManager]);

  useEffect(() => {
    if (visible) {
      setTab("search");
      setQuery("");
      setResults([]);
      setCursor(0);
      refreshInstalled();
      refreshActive();
      listPopularSkills()
        .then((r) => setPopular(r))
        .catch(() => {});
    }
  }, [visible, refreshActive, refreshInstalled]);

  useEffect(() => {
    if (!visible || tab !== "search") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }

    if (popular.length > 0) setPopular([]);

    setSearching(true);
    debounceRef.current = setTimeout(() => {
      searchSkills(query.trim())
        .then((r) => {
          setResults(r);
          setCursor(0);
        })
        .catch(() => {
          setResults([]);
        })
        .finally(() => setSearching(false));
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, visible, tab, popular.length]);

  useEffect(() => {
    setQuery("");
    setResults([]);
    resetScroll();
    if (tab === "installed") refreshInstalled();
    if (tab === "active") refreshActive();
  }, [tab, resetScroll, refreshInstalled, refreshActive]);

  const doInstall = (skill: SkillSearchResult, global: boolean) => {
    setInstalling(true);
    installSkill(skill.source, skill.skillId, global)
      .then((result) => {
        if (result.installed) {
          onSystemMessage(
            `Skill "${result.name ?? skill.name}" installed ${global ? "globally" : "to project"}.`,
          );
        } else {
          onSystemMessage(`Failed to install "${skill.name}": ${result.error ?? "unknown error"}`);
        }
        refreshInstalled();
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        onSystemMessage(`Failed to install "${skill.name}": ${msg}`);
      })
      .finally(() => setInstalling(false));
  };

  const handleAction = () => {
    if (tab === "search") {
      const skill = displayResults[cursor];
      if (!skill || installing) return;
      if (isInProject) {
        setPendingInstall(skill);
        setScopeCursor(0);
      } else {
        doInstall(skill, true);
      }
    } else if (tab === "installed") {
      const skill = filteredInstalled[cursor];
      if (!skill) return;
      const content = loadSkill(skill.path);
      contextManager.addSkill(skill.name, content);
      onSystemMessage(`Skill "${skill.name}" loaded into AI context.`);
      refreshActive();
    } else {
      const name = filteredActive[cursor];
      if (!name) return;
      contextManager.removeSkill(name);
      onSystemMessage(`Skill "${name}" unloaded from AI context.`);
      refreshActive();
    }
  };

  const handleKeyboard = (evt: import("@opentui/core").KeyEvent) => {
    if (!visible) return;

    if (pendingInstall) {
      if (evt.name === "escape") {
        setPendingInstall(null);
        return;
      }
      if (evt.name === "up" || evt.name === "down") {
        setScopeCursor((prev) => (prev === 0 ? 1 : 0));
        return;
      }
      if (evt.name === "return") {
        const isGlobal = isInProject ? scopeCursor === 1 : true;
        doInstall(pendingInstall, isGlobal);
        setPendingInstall(null);
        return;
      }
      return;
    }

    if (evt.name === "escape") {
      onClose();
      return;
    }

    if (evt.name === "tab") {
      const idx = TABS.indexOf(tab);
      const next = TABS[(idx + 1) % TABS.length] as Tab;
      setTab(next);
      return;
    }

    if (evt.name === "up") {
      const len = currentListLen;
      setCursor((prev) => (prev > 0 ? prev - 1 : Math.max(0, len - 1)));
      return;
    }
    if (evt.name === "down") {
      const len = currentListLen;
      setCursor((prev) => (prev < len - 1 ? prev + 1 : 0));
      return;
    }

    if (evt.name === "return") {
      handleAction();
      return;
    }

    if (evt.ctrl && evt.name === "d") {
      if (tab === "installed") {
        const skill = filteredInstalled[cursor];
        if (skill) {
          if (activeSkills.includes(skill.name)) {
            contextManager.removeSkill(skill.name);
          }
          if (removeInstalledSkill(skill)) {
            onSystemMessage(`Skill "${skill.name}" removed.`);
          } else {
            onSystemMessage(`Failed to remove "${skill.name}".`);
          }
          refreshInstalled();
          refreshActive();
          resetScroll();
        }
      } else if (tab === "active") {
        const name = filteredActive[cursor];
        if (name) {
          contextManager.removeSkill(name);
          onSystemMessage(`Skill "${name}" unloaded.`);
          refreshActive();
          resetScroll();
        }
      }
      return;
    }

    if (evt.name === "backspace" || evt.name === "delete") {
      setQuery((prev) => prev.slice(0, -1));
      resetScroll();
      return;
    }

    if (evt.name === "space") {
      setQuery((prev) => `${prev} `);
      resetScroll();
      return;
    }

    if (evt.name && evt.name.length === 1 && !evt.ctrl && !evt.meta) {
      setQuery((prev) => prev + evt.name);
      resetScroll();
    }
  };

  useKeyboard(handleKeyboard);

  if (!visible) return null;

  const resultCountLabel =
    tab === "search"
      ? `${displayResults.length}`
      : tab === "installed"
        ? `${filteredInstalled.length}`
        : `${filteredActive.length}`;

  const footerHints = [
    { key: "\u2191\u2193", label: "nav" },
    {
      key: "\u23CE",
      label: tab === "search" ? "install" : tab === "installed" ? "load" : "unload",
    },
    ...(tab === "installed"
      ? [{ key: "^D", label: "remove" }]
      : tab === "active"
        ? [{ key: "^D", label: "unload" }]
        : []),
    { key: "tab", label: "tab" },
    { key: "esc", label: "close" },
  ];

  return (
    <PremiumPopup
      visible={visible}
      width={popupWidth}
      height={Math.min(Math.max(18, Math.floor(termRows * 0.85)), termRows - 2)}
      title="Skills"
      titleIcon="skills"
      tabs={[
        { id: "search", label: "Search", icon: "search", blurb: "find & install skills" },
        { id: "installed", label: "Installed", icon: "folder", blurb: "manage your skills" },
        { id: "active", label: "Active", icon: "sparkle", blurb: "loaded in context" },
      ]}
      activeTab={tab}
      footerHints={footerHints.map((h) => ({
        key: h.key.replace("\u2191\u2193", "↑↓").replace("\u23CE", "Enter"),
        label: h.label,
      }))}
    >
      <box flexDirection="row" backgroundColor={popupHl}>
        <text fg={t.textMuted} bg={popupHl}>
          {"\uD83D\uDD0D "}
        </text>
        {query ? (
          <>
            <text fg={t.textPrimary} bg={popupHl}>
              {query}
            </text>
            <text fg={t.brand} bg={popupHl}>
              {"█"}
            </text>
          </>
        ) : (
          <>
            <text fg={t.brand} bg={popupHl}>
              {"█"}
            </text>
            <text fg={t.textMuted} bg={popupHl}>
              {tab === "search"
                ? "type to filter / search skills.sh..."
                : tab === "installed"
                  ? "type to filter installed..."
                  : "type to filter active..."}
            </text>
          </>
        )}
        <text fg={t.textDim} bg={popupHl}>
          {` (${resultCountLabel})`}
        </text>
      </box>
      <box height={1} backgroundColor={popupBg} />

      {tab === "search" && (
        <>
          {searching ? (
            <box flexDirection="row" backgroundColor={popupBg}>
              <text fg={t.brand} bg={popupBg}>
                searching...
              </text>
            </box>
          ) : (
            <VirtualList
              items={displayResults}
              selectedIndex={cursor}
              width={contentW}
              maxRows={maxVisible}
              keyExtractor={(s) => s.id}
              emptyMessage={query ? "no results" : "loading popular skills..."}
              renderItem={(skill, { selected }) => (
                <SearchSkillRow
                  skill={skill}
                  isSelected={selected}
                  isInstalled={installedNames.has(skill.skillId) || installedNames.has(skill.name)}
                  isLoaded={
                    activeSkills.includes(skill.skillId) || activeSkills.includes(skill.name)
                  }
                  innerW={contentW}
                />
              )}
            />
          )}

          {pendingInstall && (
            <>
              <box height={1} backgroundColor={popupBg} />
              <box flexDirection="row" backgroundColor={popupBg}>
                <text fg={t.textPrimary} attributes={TextAttributes.BOLD} bg={popupBg}>
                  Install "{pendingInstall.skillId}" to:
                </text>
              </box>
              <Radio
                label="Project"
                description=".agents/skills/ (this repo)"
                selected={scopeCursor === 0}
                focused={scopeCursor === 0}
              />
              <Radio
                label="Global"
                description="~/.agents/skills/ (all projects)"
                selected={scopeCursor === 1}
                focused={scopeCursor === 1}
              />
            </>
          )}

          {installing && (
            <box flexDirection="row" backgroundColor={popupBg}>
              <text fg={t.brand} bg={popupBg}>
                installing...
              </text>
            </box>
          )}
        </>
      )}

      {tab === "installed" && (
        <VirtualList
          items={filteredInstalled}
          selectedIndex={cursor}
          width={contentW}
          maxRows={maxVisible}
          keyExtractor={(s) => s.path}
          emptyMessage={query ? "no matching skills" : "no installed skills found"}
          renderItem={(skill, { selected }) => (
            <InstalledSkillRow
              skill={skill}
              isSelected={selected}
              isLoaded={activeSkills.includes(skill.name)}
              innerW={contentW}
            />
          )}
        />
      )}

      {tab === "active" && (
        <VirtualList
          items={filteredActive}
          selectedIndex={cursor}
          width={contentW}
          maxRows={maxVisible}
          keyExtractor={(name) => name}
          emptyMessage={query ? "no matching skills" : "no active skills — load from Installed tab"}
          renderItem={(name, { selected }) => (
            <ActiveSkillRow name={name} isSelected={selected} innerW={contentW} />
          )}
        />
      )}
    </PremiumPopup>
  );
}
