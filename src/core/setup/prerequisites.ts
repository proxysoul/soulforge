import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { getVendoredPath, hasAnyNerdFont } from "./install.js";

interface Prerequisite {
  name: string;
  description: string;
  required: boolean;
  check: () => boolean;
  install: Record<string, string[]>;
  /** If set, only show this prerequisite on these platforms */
  platforms?: string[];
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function fontInstalled(): boolean {
  if (platform() === "win32") return true;
  return hasAnyNerdFont();
}

const MASON_BIN = join(homedir(), ".local", "share", "nvim", "mason", "bin");

function lspExists(...cmds: string[]): boolean {
  for (const cmd of cmds) {
    if (commandExists(cmd)) return true;
    if (existsSync(join(MASON_BIN, cmd))) return true;
  }
  return false;
}

const PREREQUISITES: Prerequisite[] = [
  {
    name: "Neovim",
    description: "Embedded editor (optional, v0.11+)",
    required: false,
    check: () => getVendoredPath("nvim") !== null || commandExists("nvim"),
    install: {
      darwin: ["brew install neovim"],
      linux: [
        "# Auto-installed by /setup, or manually:",
        "# Ubuntu (apt version is often outdated, use AppImage):",
        "curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim.appimage",
        "chmod u+x nvim.appimage && sudo mv nvim.appimage /usr/local/bin/nvim",
        "# or Arch: sudo pacman -S neovim",
        "# or Fedora: sudo dnf install neovim",
      ],
      win32: ["scoop install neovim", "# or: winget install Neovim.Neovim"],
    },
  },
  {
    name: "Git",
    description: "Version control (required)",
    required: true,
    check: () => commandExists("git"),
    install: {
      darwin: ["brew install git"],
      linux: ["sudo apt install git"],
      win32: ["winget install Git.Git"],
    },
  },
  {
    name: "Nerd Font",
    description: "Icons & ligatures (use /setup to pick one)",
    required: false,
    check: fontInstalled,
    install: {
      darwin: [
        "brew install --cask font-jetbrains-mono-nerd-font",
        "# Or use /setup to auto-install from 5 font choices",
      ],
      linux: [
        "# Use /setup to auto-install, or manually:",
        "curl -fsSL https://raw.githubusercontent.com/ryanoasis/nerd-fonts/HEAD/install.sh | bash -s -- JetBrainsMono",
      ],
      win32: ["scoop bucket add nerd-fonts && scoop install JetBrainsMono-NF"],
    },
  },
  {
    name: "lazygit",
    description: "Terminal git UI (optional, for /git lazygit)",
    required: false,
    check: () => getVendoredPath("lazygit") !== null || commandExists("lazygit"),
    install: {
      darwin: ["brew install lazygit"],
      linux: [
        "# Ubuntu (via PPA):",
        "sudo add-apt-repository ppa:lazygit-team/release",
        "sudo apt update && sudo apt install lazygit",
        "# or Arch:",
        "sudo pacman -S lazygit",
        "# or via Go:",
        "go install github.com/jesseduffield/lazygit@latest",
      ],
      win32: ["scoop install lazygit", "# or: winget install lazygit"],
    },
  },
  {
    name: "ripgrep",
    description: "Fast code search (used by /grep)",
    required: false,
    check: () => getVendoredPath("rg") !== null || commandExists("rg"),
    install: {
      darwin: ["brew install ripgrep"],
      linux: ["sudo apt install ripgrep"],
      win32: ["scoop install ripgrep"],
    },
  },
  {
    name: "fd",
    description: "Fast file finder (used by /glob, fallback: find)",
    required: false,
    check: () => getVendoredPath("fd") !== null || commandExists("fd") || commandExists("fdfind"),
    install: {
      darwin: ["brew install fd"],
      linux: [
        "sudo apt install fd-find && sudo ln -sf $(which fdfind) /usr/local/bin/fd",
        "# or Arch: sudo pacman -S fd",
      ],
      win32: ["scoop install fd"],
    },
  },
  {
    name: "clipboard",
    description: "Clipboard support (wl-clipboard for Wayland, xclip/xsel for X11)",
    required: false,
    platforms: ["linux"],
    check: () => commandExists("wl-copy") || commandExists("xclip") || commandExists("xsel"),
    install: {
      linux: [
        "# Wayland (KDE/GNOME):",
        "sudo apt install wl-clipboard",
        "# or Arch: sudo pacman -S wl-clipboard",
        "# or Fedora: sudo dnf install wl-clipboard",
        "# X11 fallback:",
        "sudo apt install xclip",
      ],
    },
  },
  {
    name: "secret-tool",
    description: "Secure API key storage (keychain)",
    required: false,
    platforms: ["linux"],
    check: () => commandExists("secret-tool"),
    install: {
      linux: [
        "sudo apt install libsecret-tools",
        "# or Arch: sudo pacman -S libsecret",
        "# or Fedora: sudo dnf install libsecret",
      ],
    },
  },
  {
    name: "CLIProxyAPI",
    description: "Proxy for Claude Max (optional, auto-installed)",
    required: false,
    check: () =>
      getVendoredPath("cli-proxy-api") !== null ||
      commandExists("cli-proxy-api") ||
      commandExists("cliproxyapi"),
    install: {
      darwin: ["Auto-installed when selecting Proxy provider"],
      linux: ["Auto-installed when selecting Proxy provider"],
    },
  },
  {
    name: "typescript-language-server",
    description: "LSP for TypeScript/JavaScript",
    required: false,
    check: () => lspExists("typescript-language-server"),
    install: {
      darwin: [
        "bun add -g typescript-language-server typescript",
        "# or: nvim → :MasonInstall typescript-language-server",
      ],
      linux: [
        "bun add -g typescript-language-server typescript",
        "# or: nvim → :MasonInstall typescript-language-server",
      ],
      win32: ["bun add -g typescript-language-server typescript"],
    },
  },
  {
    name: "pyright",
    description: "LSP for Python",
    required: false,
    check: () => lspExists("pyright-langserver", "pylsp"),
    install: {
      darwin: ["bun add -g pyright", "# or: nvim → :MasonInstall pyright"],
      linux: ["bun add -g pyright", "# or: nvim → :MasonInstall pyright"],
      win32: ["bun add -g pyright"],
    },
  },
  {
    name: "gopls",
    description: "LSP for Go",
    required: false,
    check: () => lspExists("gopls"),
    install: {
      darwin: ["go install golang.org/x/tools/gopls@latest", "# or: nvim → :MasonInstall gopls"],
      linux: ["go install golang.org/x/tools/gopls@latest", "# or: nvim → :MasonInstall gopls"],
      win32: ["go install golang.org/x/tools/gopls@latest"],
    },
  },
  {
    name: "rust-analyzer",
    description: "LSP for Rust",
    required: false,
    check: () => lspExists("rust-analyzer"),
    install: {
      darwin: ["rustup component add rust-analyzer", "# or: nvim → :MasonInstall rust-analyzer"],
      linux: ["rustup component add rust-analyzer", "# or: nvim → :MasonInstall rust-analyzer"],
      win32: ["rustup component add rust-analyzer"],
    },
  },
];

export interface PrerequisiteStatus {
  prerequisite: Prerequisite;
  installed: boolean;
}

export function checkPrerequisites(): PrerequisiteStatus[] {
  const os = platform();
  return PREREQUISITES.filter((p) => !p.platforms || p.platforms.includes(os)).map((p) => ({
    prerequisite: p,
    installed: p.check(),
  }));
}

export function getInstallCommands(name: string): string[] {
  const os = platform();
  const prereq = PREREQUISITES.find((p) => p.name === name);
  if (!prereq) return [];
  return prereq.install[os] ?? prereq.install.linux ?? [];
}

export function getMissingRequired(): PrerequisiteStatus[] {
  return checkPrerequisites().filter((s) => !s.installed && s.prerequisite.required);
}
