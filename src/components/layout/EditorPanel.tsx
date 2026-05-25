import { TextAttributes } from "@opentui/core";
import type { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";
import { memo, useEffect, useRef, useState } from "react";
import { UI_ICONS } from "../../core/icons.js";
import { ghosttyDisabled } from "../../core/platform/index.js";
import { useTheme } from "../../core/theme/index.js";

interface Props {
  isOpen: boolean;
  ptyOnData: (cb: (data: Uint8Array) => void) => () => void;
  nvimCols: number;
  nvimRows: number;
  focused?: boolean;
  onClosed?: () => void;
  error?: string | null;
  split?: number;
}

type Direction = "opening" | "idle";
const ANIMATION_FRAMES = ["  ░", " ░▒", "░▒▓", "▒▓█", "▓██", "███"];

/** Renders neovim PTY output via ghostty-terminal in persistent mode. */
const NvimTerminal = memo(function NvimTerminal({
  ptyOnData,
  cols,
  rows,
}: {
  ptyOnData: (cb: (data: Uint8Array) => void) => () => void;
  cols: number;
  rows: number;
}) {
  const termRef = useRef<GhosttyTerminalRenderable | null>(null);

  useEffect(() => {
    // Feed PTY data directly — ghostty's requestRender() is coalesced
    // by opentui's render loop so multiple feeds per frame are fine.
    return ptyOnData((data) => {
      const term = termRef.current;
      if (term) term.feed(data);
    });
  }, [ptyOnData]);

  useEffect(() => {
    const term = termRef.current;
    if (term) {
      term.cols = cols;
      term.rows = rows;
    }
  }, [cols, rows]);

  return <ghostty-terminal ref={termRef} persistent showCursor cols={cols} rows={rows} />;
});

export const EditorPanel = memo(function EditorPanel({
  isOpen,
  ptyOnData,
  nvimCols,
  nvimRows,
  focused = false,
  onClosed,
  error,
  split = 60,
}: Props) {
  const t = useTheme();
  const [animFrame, setAnimFrame] = useState(0);
  const [direction, setDirection] = useState<Direction>("idle");
  const prevOpen = useRef(isOpen);

  useEffect(() => {
    if (isOpen && !prevOpen.current) {
      prevOpen.current = true;
      setDirection("opening");
      setAnimFrame(0);
    } else if (!isOpen && prevOpen.current) {
      prevOpen.current = false;
      onClosed?.();
    }
  }, [isOpen, onClosed]);

  useEffect(() => {
    if (direction !== "opening") return;
    const interval = setInterval(() => {
      setAnimFrame((prev) => {
        if (prev >= ANIMATION_FRAMES.length - 1) {
          clearInterval(interval);
          setDirection("idle");
          return prev;
        }
        return prev + 1;
      });
    }, 60);
    return () => clearInterval(interval);
  }, [direction]);

  if (!isOpen && direction === "idle") {
    return null;
  }

  const borderColor = focused ? t.borderFocused : t.border;

  // Windows: embedded neovim renders through ghostty-opentui native addon,
  // which is currently skipped on win32. Show an explanatory splash so users
  // know to use external $EDITOR / nvim in a separate window instead.
  if (ghosttyDisabled()) {
    return (
      <box
        flexDirection="column"
        width={`${split}%` as `${number}%`}
        borderStyle="rounded"
        border={true}
        borderColor={borderColor}
        alignItems="center"
        justifyContent="center"
        paddingX={2}
      >
        <text fg={t.textSecondary} attributes={TextAttributes.BOLD}>
          Embedded editor not supported on Windows
        </text>
        <text> </text>
        <text fg={t.textDim}>The neovim panel requires the ghostty-opentui native addon,</text>
        <text fg={t.textDim}>which doesn&apos;t have a Windows build yet.</text>
        <text> </text>
        <text fg={t.textFaint}>
          Open files in an external editor (nvim, VS Code, etc.) instead.
        </text>
      </box>
    );
  }

  if (direction === "opening") {
    return (
      <box
        flexDirection="column"
        width={`${split}%` as `${number}%`}
        borderStyle="rounded"
        border={true}
        borderColor={borderColor}
        alignItems="center"
        justifyContent="center"
      >
        <text fg={t.brand}>{ANIMATION_FRAMES[animFrame]}</text>
        <text fg={t.textDim} attributes={TextAttributes.DIM}>
          loading forge...
        </text>
      </box>
    );
  }

  if (error) {
    return (
      <box
        flexDirection="column"
        width={`${split}%` as `${number}%`}
        borderStyle="rounded"
        border={true}
        borderColor={borderColor}
      >
        <box flexDirection="row" paddingX={1} flexShrink={0} height={1}>
          <text bg={t.brand} fg="white" attributes={TextAttributes.BOLD}>
            {` ${UI_ICONS.editor} `}
          </text>
          <text fg={t.textSecondary}> editor</text>
        </box>
        <box paddingX={1} flexShrink={0} height={1}>
          <text fg={t.textFaint} truncate>
            {"─".repeat(200)}
          </text>
        </box>
        {error === "neovim-not-found" ? (
          <NvimNotFoundSplash />
        ) : (
          <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
            <text fg={t.error} attributes={TextAttributes.BOLD}>
              Editor Failed to Start
            </text>
            <text> </text>
            <text fg={t.textSecondary}>{error}</text>
          </box>
        )}
        <box paddingX={1} flexShrink={0} height={1}>
          <text fg={t.textFaint} truncate>
            {"─".repeat(200)}
          </text>
        </box>
      </box>
    );
  }

  return (
    <box
      flexDirection="column"
      width={`${split}%` as `${number}%`}
      borderStyle="rounded"
      border={true}
      borderColor={borderColor}
    >
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <NvimTerminal ptyOnData={ptyOnData} cols={nvimCols} rows={nvimRows} />
      </box>
    </box>
  );
});

const INSTALL_CMDS: Record<string, { cmd: string; label: string }[]> = {
  darwin: [
    { cmd: "brew install neovim", label: "Homebrew" },
    { cmd: "sudo port install neovim", label: "MacPorts" },
    {
      cmd: "curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim-macos-arm64.tar.gz",
      label: "Direct (Apple Silicon)",
    },
    {
      cmd: "curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim-macos-x86_64.tar.gz",
      label: "Direct (Intel)",
    },
  ],
  win32: [
    { cmd: "winget install Neovim.Neovim", label: "winget" },
    { cmd: "scoop install neovim", label: "Scoop" },
    { cmd: "choco install neovim", label: "Chocolatey" },
  ],
  linux: [
    {
      cmd: "curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim-linux-x86_64.appimage",
      label: "AppImage (recommended)",
    },
    { cmd: "sudo snap install nvim --classic", label: "Snap" },
    { cmd: "sudo dnf install -y neovim", label: "Fedora" },
    { cmd: "sudo pacman -S neovim", label: "Arch" },
    { cmd: "sudo apt install neovim", label: "Debian / Ubuntu (may be outdated)" },
  ],
};

function NvimNotFoundSplash() {
  const t = useTheme();
  const cmds = INSTALL_CMDS[process.platform] ?? INSTALL_CMDS.linux ?? [];
  const longest = cmds.reduce((max, c) => Math.max(max, c.cmd.length), 0);

  return (
    <box flexDirection="column" flexGrow={1} justifyContent="center" paddingX={4}>
      <text fg={t.error} attributes={TextAttributes.BOLD}>
        Neovim Not Found
      </text>
      <text> </text>
      <text fg={t.textSecondary}>The editor requires Neovim (v0.11+)</text>
      <text> </text>
      <text fg={t.brand} attributes={TextAttributes.BOLD}>
        Install:
      </text>
      {cmds.map(({ cmd, label }) => (
        <text key={cmd}>
          <span fg={t.textMuted}>{"  $ "}</span>
          <span fg={t.success}>{cmd}</span>
          <span fg={t.textFaint}>
            {" ".repeat(Math.max(2, longest - cmd.length + 2))}
            {label}
          </span>
        </text>
      ))}
      <text> </text>
      <text fg={t.textMuted}>https://github.com/neovim/neovim/releases</text>
      <text> </text>
      <text fg={t.textDim} attributes={TextAttributes.DIM}>
        Restart SoulForge after installing.
      </text>
    </box>
  );
}
