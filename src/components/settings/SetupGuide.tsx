import { platform } from "node:os";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useState } from "react";
import { spawnShell } from "../../core/platform/index.js";
import {
  detectInstalledFonts,
  installFont,
  NERD_FONTS,
  type NerdFont,
} from "../../core/setup/install.js";
import {
  checkPrerequisites,
  getInstallCommands,
  type PrerequisiteStatus,
} from "../../core/setup/prerequisites.js";
import {
  buildGroupedRows,
  type GroupedItem,
  GroupedList,
  type GroupedListGroup,
  Hint,
  PremiumPopup,
  Section,
  VSpacer,
} from "../ui/index.js";

const MAX_POPUP_WIDTH = 100;
const CHROME_ROWS = 10;

type Tab = "tools" | "fonts";

interface Props {
  visible: boolean;
  onClose: () => void;
  onSystemMessage: (msg: string) => void;
}

export function SetupGuide({ visible, onClose, onSystemMessage }: Props) {
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const containerRows = termRows - 2;
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.85));
  const contentW = popupWidth - 22 - 3;
  const maxVisible = Math.max(4, Math.floor(containerRows * 0.85) - CHROME_ROWS);
  const [statuses, setStatuses] = useState<PrerequisiteStatus[]>(() => checkPrerequisites());
  const [cursor, setCursor] = useState(0);
  const [installing, setInstalling] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tools");
  const [fontCursor, setFontCursor] = useState(0);
  const [installedFonts, setInstalledFonts] = useState<NerdFont[]>(() => detectInstalledFonts());

  const adjustScroll = (_next: number) => {};
  const adjustFontScroll = (_next: number) => {};

  const os = platform();
  const osLabel = os === "darwin" ? "macOS" : os === "win32" ? "Windows" : "Linux";

  const refresh = useCallback(() => {
    setStatuses(checkPrerequisites());
    setInstalledFonts(detectInstalledFonts());
  }, []);

  const installSelected = useCallback(() => {
    const item = statuses[cursor];
    if (!item || item.installed) return;

    const cmds = getInstallCommands(item.prerequisite.name);
    const cmd = cmds.find((c) => !c.startsWith("#") && c.trim().length > 0);
    if (!cmd) {
      onSystemMessage(
        `No auto-install command for ${item.prerequisite.name}. Manual steps:\n${cmds.join("\n")}`,
      );
      return;
    }

    setInstalling(item.prerequisite.name);
    onSystemMessage(`Installing ${item.prerequisite.name}...`);

    const proc = spawnShell(cmd, { stdio: "pipe" });
    const chunks: string[] = [];
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d.toString()));
    proc.stderr?.on("data", (d: Buffer) => chunks.push(d.toString()));
    proc.on("close", (code) => {
      setInstalling(null);
      if (code === 0) {
        onSystemMessage(`${item.prerequisite.name} installed successfully.`);
      } else {
        onSystemMessage(
          `Failed to install ${item.prerequisite.name}:\n${chunks.join("").slice(0, 200)}`,
        );
      }
      refresh();
    });
    proc.on("error", () => {
      setInstalling(null);
      onSystemMessage(`Failed to run install command. Try manually:\n${cmd}`);
    });
  }, [statuses, cursor, onSystemMessage, refresh]);

  const installSelectedFont = useCallback(() => {
    const font = NERD_FONTS[fontCursor];
    if (!font) return;
    const isInstalled = installedFonts.some((f) => f.id === font.id);
    if (isInstalled) return;

    setInstalling(font.name);
    onSystemMessage(`Installing ${font.name} Nerd Font...`);

    installFont(font.id)
      .then((family) => {
        setInstalling(null);
        onSystemMessage(`${font.name} installed! Set terminal font to "${family}"`);
        refresh();
      })
      .catch((err: unknown) => {
        setInstalling(null);
        const msg = err instanceof Error ? err.message : String(err);
        onSystemMessage(`Failed to install ${font.name}: ${msg}`);
      });
  }, [fontCursor, installedFonts, onSystemMessage, refresh]);

  useKeyboard((evt) => {
    if (!visible) return;
    if (installing) {
      evt.preventDefault();
      return;
    }

    if (evt.name === "escape") {
      onClose();
      evt.preventDefault();
      return;
    }

    if (evt.name === "tab" || evt.name === "1" || evt.name === "2") {
      if (evt.name === "tab") {
        setTab((t) => (t === "tools" ? "fonts" : "tools"));
      } else if (evt.name === "1") {
        setTab("tools");
      } else {
        setTab("fonts");
      }
      evt.preventDefault();
      return;
    }

    if (tab === "tools") {
      if (evt.name === "up" || evt.name === "k") {
        setCursor((p) => {
          const next = p > 0 ? p - 1 : statuses.length - 1;
          adjustScroll(next);
          return next;
        });
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        setCursor((p) => {
          const next = p < statuses.length - 1 ? p + 1 : 0;
          adjustScroll(next);
          return next;
        });
        return;
      }
      if (evt.name === "return" || evt.name === "i") {
        installSelected();
        return;
      }
      if (evt.name === "r") {
        refresh();
        return;
      }
      if (evt.name === "a") {
        const missing = statuses.filter((s) => !s.installed);
        if (missing.length === 0) return;
        const cmds: string[] = [];
        for (const s of missing) {
          const c = getInstallCommands(s.prerequisite.name).find(
            (l) => !l.startsWith("#") && l.trim().length > 0,
          );
          if (c) cmds.push(c);
        }
        if (cmds.length === 0) return;
        setInstalling("all");
        onSystemMessage(`Installing ${String(cmds.length)} prerequisites...`);
        const fullCmd = cmds.join(" && ");
        const proc = spawnShell(fullCmd, { stdio: "pipe" });
        proc.on("close", (code) => {
          setInstalling(null);
          onSystemMessage(
            code === 0
              ? "All prerequisites installed!"
              : "Some installs may have failed. Run /setup to check.",
          );
          refresh();
        });
        proc.on("error", () => {
          setInstalling(null);
          onSystemMessage("Failed to run install commands.");
        });
      }
    } else {
      if (evt.name === "up" || evt.name === "k") {
        setFontCursor((p) => {
          const next = p > 0 ? p - 1 : NERD_FONTS.length - 1;
          adjustFontScroll(next);
          return next;
        });
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        setFontCursor((p) => {
          const next = p < NERD_FONTS.length - 1 ? p + 1 : 0;
          adjustFontScroll(next);
          return next;
        });
        return;
      }
      if (evt.name === "return" || evt.name === "i") {
        installSelectedFont();
        return;
      }
      if (evt.name === "r") {
        refresh();
      }
    }
  });

  if (!visible) return null;

  const allInstalled = statuses.every((s) => s.installed);
  const missingCount = statuses.filter((s) => !s.installed).length;

  const footerHints = [
    { key: "⏎", label: "install" },
    ...(tab === "tools" ? [{ key: "a", label: "install all" }] : []),
    { key: "r", label: "refresh" },
    { key: "tab", label: "switch" },
    { key: "esc", label: "close" },
  ];

  return (
    <PremiumPopup
      visible={visible}
      width={popupWidth}
      height={Math.min(Math.max(18, Math.floor(termRows * 0.85)), termRows - 2)}
      title="SoulForge Setup"
      titleIcon="ghost"
      tabs={[
        { id: "tools", label: "Tools", icon: "tools", blurb: osLabel ?? "runtime dependencies" },
        { id: "fonts", label: "Fonts", icon: "pencil", blurb: "nerd-font support" },
      ]}
      activeTab={tab}
      footerHints={footerHints}
    >
      {tab === "tools" ? (
        <Section>
          <Hint kind={allInstalled ? "tip" : "warn"}>
            {allInstalled
              ? "All prerequisites are installed"
              : `${String(missingCount)} missing — select to install`}
          </Hint>
          <VSpacer />
          {(() => {
            const toolGroups: GroupedListGroup<GroupedItem>[] = [
              {
                id: "tools",
                label: "Tools",
                hideHeader: true,
                items: statuses.map((s) => ({
                  id: s.prerequisite.name,
                  label: s.prerequisite.name,
                  meta: s.installed
                    ? "installed"
                    : s.prerequisite.required
                      ? "required"
                      : "optional",
                  keyHint: s.installed ? "✓" : s.prerequisite.required ? "✗" : "○",
                  disabled: s.installed,
                })),
              },
            ];
            const rows = buildGroupedRows(toolGroups, new Set(["tools"]));
            const selIdx = rows.findIndex((r) => r.kind === "item" && r.itemIndex === cursor);
            return (
              <GroupedList
                groups={toolGroups}
                expanded={new Set(["tools"])}
                selectedIndex={selIdx}
                width={contentW}
                maxRows={maxVisible}
              />
            );
          })()}
        </Section>
      ) : (
        <Section>
          <Hint>Select a Nerd Font to install</Hint>
          <VSpacer />
          {(() => {
            const fontGroups: GroupedListGroup<GroupedItem>[] = [
              {
                id: "fonts",
                label: "Fonts",
                hideHeader: true,
                items: NERD_FONTS.map((font) => {
                  const isInstalled = installedFonts.some((f) => f.id === font.id);
                  return {
                    id: font.id,
                    label: font.name,
                    meta: isInstalled ? "installed" : font.description.slice(0, 26),
                    keyHint: isInstalled ? "✓" : "○",
                    disabled: isInstalled,
                  };
                }),
              },
            ];
            const rows = buildGroupedRows(fontGroups, new Set(["fonts"]));
            const selIdx = rows.findIndex((r) => r.kind === "item" && r.itemIndex === fontCursor);
            return (
              <GroupedList
                groups={fontGroups}
                expanded={new Set(["fonts"])}
                selectedIndex={selIdx}
                width={contentW}
                maxRows={maxVisible}
              />
            );
          })()}
          <VSpacer />
          <Hint>After install, set terminal font to the name shown</Hint>
        </Section>
      )}

      {installing && <Hint>⠹ Installing {installing}...</Hint>}
    </PremiumPopup>
  );
}
