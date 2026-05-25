import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandExists, IS_WIN } from "../platform/index.js";

interface TerminalInfo {
  id: string;
  name: string;
  /** Manual fallback instructions */
  instructions: string;
  /** Whether setTerminalFont() can auto-configure this terminal */
  canAutoSet: boolean;
}

interface SetFontResult {
  success: boolean;
  message: string;
  /** Config file that was modified, if any */
  configPath?: string;
}

/**
 * Detect which terminal emulator is running.
 */
export function detectTerminal(): TerminalInfo {
  const env = process.env;

  if (env.KITTY_WINDOW_ID) {
    return {
      id: "kitty",
      name: "Kitty",
      instructions: "Edit ~/.config/kitty/kitty.conf → font_family",
      canAutoSet: true,
    };
  }

  if (env.ALACRITTY_WINDOW_ID) {
    return {
      id: "alacritty",
      name: "Alacritty",
      instructions: "Edit ~/.config/alacritty/alacritty.toml → [font.normal] family",
      canAutoSet: true,
    };
  }

  if (env.ITERM_SESSION_ID) {
    return {
      id: "iterm2",
      name: "iTerm2",
      instructions: "Preferences → Profiles → Text → Font",
      canAutoSet: true,
    };
  }

  const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";

  if (termProgram === "apple_terminal") {
    return {
      id: "terminal.app",
      name: "Terminal.app",
      instructions: "Preferences → Profiles → Font → Change",
      canAutoSet: true,
    };
  }

  if (termProgram === "ghostty") {
    return {
      id: "ghostty",
      name: "Ghostty",
      instructions: "Edit ~/.config/ghostty/config → font-family",
      canAutoSet: true,
    };
  }

  if (env.WEZTERM_PANE !== undefined) {
    return {
      id: "wezterm",
      name: "WezTerm",
      instructions: "Edit ~/.wezterm.lua → config.font = wezterm.font('...')",
      canAutoSet: false,
    };
  }

  if (termProgram === "vscode") {
    return {
      id: "vscode",
      name: "VS Code Terminal",
      instructions: "Settings → terminal.integrated.fontFamily",
      canAutoSet: false,
    };
  }

  if (env.TERM?.includes("foot")) {
    return {
      id: "foot",
      name: "Foot",
      instructions: "Edit ~/.config/foot/foot.ini → [main] font=",
      canAutoSet: true,
    };
  }

  if (termProgram === "hyper") {
    return {
      id: "hyper",
      name: "Hyper",
      instructions: "Edit ~/.hyper.js → fontFamily",
      canAutoSet: false,
    };
  }

  // Linux: try to detect GNOME Terminal / other VTE terminals.
  // Skip on Windows — gsettings/VTE doesn't exist there.
  if (!IS_WIN && (env.VTE_VERSION || env.COLORTERM === "truecolor")) {
    // Check if gsettings is available (GNOME Terminal)
    try {
      if (!commandExists("gsettings")) throw new Error("no gsettings");
      const profileList = execSync(
        "gsettings get org.gnome.Terminal.ProfilesList default 2>/dev/null",
        { encoding: "utf-8" },
      ).trim();
      if (profileList) {
        return {
          id: "gnome-terminal",
          name: "GNOME Terminal",
          instructions: "Preferences → Profiles → Text → Custom font",
          canAutoSet: true,
        };
      }
    } catch {
      // not GNOME Terminal
    }
  }

  return {
    id: "unknown",
    name: env.TERM_PROGRAM ?? env.TERM ?? "Unknown",
    instructions: "Check your terminal's preferences/settings to change the font",
    canAutoSet: false,
  };
}

/**
 * Read current font from terminal config, if detectable.
 */
export function getCurrentFont(): string | null {
  const term = detectTerminal();

  switch (term.id) {
    case "kitty": {
      const conf = join(homedir(), ".config", "kitty", "kitty.conf");
      if (!existsSync(conf)) return null;
      const content = readFileSync(conf, "utf-8");
      const match = content.match(/^font_family\s+(.+)$/m);
      return match?.[1]?.trim() ?? null;
    }
    case "alacritty": {
      const conf = findAlacrittyConfig();
      if (!conf) return null;
      const content = readFileSync(conf, "utf-8");
      // TOML: family = "FontName"
      const match = content.match(/family\s*=\s*"([^"]+)"/);
      return match?.[1] ?? null;
    }
    case "ghostty": {
      const conf = join(homedir(), ".config", "ghostty", "config");
      if (!existsSync(conf)) return null;
      const content = readFileSync(conf, "utf-8");
      const match = content.match(/^font-family\s*=\s*(.+)$/m);
      return match?.[1]?.trim() ?? null;
    }
    case "foot": {
      const conf = join(homedir(), ".config", "foot", "foot.ini");
      if (!existsSync(conf)) return null;
      const content = readFileSync(conf, "utf-8");
      const match = content.match(/^font\s*=\s*([^:]+)/m);
      return match?.[1]?.trim() ?? null;
    }
    case "gnome-terminal": {
      try {
        const profileId = execSync("gsettings get org.gnome.Terminal.ProfilesList default", {
          encoding: "utf-8",
        })
          .trim()
          .replace(/'/g, "");
        const font = execSync(
          `gsettings get org.gnome.Terminal.Legacy.Profile:/org/gnome/terminal/legacy/profiles:/:${profileId}/ font`,
          { encoding: "utf-8" },
        )
          .trim()
          .replace(/'/g, "");
        return font || null;
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

/**
 * Set the terminal font. Returns result with success status and message.
 */
export function setTerminalFont(fontFamily: string, fontSize?: number): SetFontResult {
  const term = detectTerminal();
  const size = fontSize ?? 13;

  if (IS_WIN) {
    return {
      success: false,
      message:
        "[Unavailable on Windows] Set the terminal font in your terminal's settings " +
        "(Windows Terminal: Settings → Profiles → Appearance → Font face).",
    };
  }

  switch (term.id) {
    case "kitty":
      return setKittyFont(fontFamily, size);
    case "alacritty":
      return setAlacrittyFont(fontFamily, size);
    case "iterm2":
      return setITerm2Font(fontFamily, size);
    case "terminal.app":
      return setTerminalAppFont(fontFamily, size);
    case "ghostty":
      return setGhosttyFont(fontFamily, size);
    case "foot":
      return setFootFont(fontFamily, size);
    case "gnome-terminal":
      return setGnomeTerminalFont(fontFamily, size);
    default:
      return {
        success: false,
        message: `Auto-set not supported for ${term.name}. ${term.instructions}`,
      };
  }
}

function setKittyFont(family: string, size: number): SetFontResult {
  const confDir = join(homedir(), ".config", "kitty");
  const conf = join(confDir, "kitty.conf");
  mkdirSync(confDir, { recursive: true });

  let content = existsSync(conf) ? readFileSync(conf, "utf-8") : "";

  // Update or append font_family
  if (/^font_family\s/m.test(content)) {
    content = content.replace(/^font_family\s+.+$/m, `font_family ${family}`);
  } else {
    content = `font_family ${family}\n${content}`;
  }

  // Update or append font_size
  if (/^font_size\s/m.test(content)) {
    content = content.replace(/^font_size\s+.+$/m, `font_size ${String(size)}`);
  } else {
    content = `font_size ${String(size)}\n${content}`;
  }

  writeFileSync(conf, content);

  // Live-reload kitty (SIGUSR1 triggers config reload)
  try {
    const pid = process.env.KITTY_PID;
    if (pid) {
      execSync(`kill -SIGUSR1 ${pid}`, { stdio: "ignore" });
    }
  } catch {
    // non-fatal
  }

  return {
    success: true,
    message: `Set ${family} ${String(size)}pt in Kitty. Config reloaded.`,
    configPath: conf,
  };
}

function findAlacrittyConfig(): string | null {
  const paths = [
    join(homedir(), ".config", "alacritty", "alacritty.toml"),
    join(homedir(), ".config", "alacritty", "alacritty.yml"),
    join(homedir(), ".alacritty.toml"),
    join(homedir(), ".alacritty.yml"),
  ];
  return paths.find((p) => existsSync(p)) ?? null;
}

function setAlacrittyFont(family: string, size: number): SetFontResult {
  const confDir = join(homedir(), ".config", "alacritty");
  let conf = findAlacrittyConfig();

  if (!conf) {
    // Create new TOML config
    conf = join(confDir, "alacritty.toml");
    mkdirSync(confDir, { recursive: true });
    writeFileSync(conf, `[font]\nsize = ${String(size)}\n\n[font.normal]\nfamily = "${family}"\n`);
    return {
      success: true,
      message: `Created Alacritty config with ${family} ${String(size)}pt. Alacritty auto-reloads.`,
      configPath: conf,
    };
  }

  let content = readFileSync(conf, "utf-8");

  if (conf.endsWith(".toml")) {
    // Update family in TOML
    if (/family\s*=\s*"[^"]*"/.test(content)) {
      content = content.replace(/family\s*=\s*"[^"]*"/, `family = "${family}"`);
    } else if (/\[font\.normal\]/.test(content)) {
      content = content.replace(/\[font\.normal\]/, `[font.normal]\nfamily = "${family}"`);
    } else if (/\[font\]/.test(content)) {
      content = content.replace(
        /\[font\]/,
        `[font]\nsize = ${String(size)}\n\n[font.normal]\nfamily = "${family}"`,
      );
    } else {
      content += `\n[font]\nsize = ${String(size)}\n\n[font.normal]\nfamily = "${family}"\n`;
    }

    // Update size
    if (/^size\s*=\s*\d+/m.test(content)) {
      content = content.replace(/^size\s*=\s*\d+/m, `size = ${String(size)}`);
    }
  } else {
    // YAML (legacy)
    if (/family:\s*.+/.test(content)) {
      content = content.replace(/family:\s*.+/, `family: "${family}"`);
    } else {
      content += `\nfont:\n  normal:\n    family: "${family}"\n  size: ${String(size)}\n`;
    }
  }

  writeFileSync(conf, content);

  return {
    success: true,
    message: `Set ${family} ${String(size)}pt in Alacritty. Auto-reloads on save.`,
    configPath: conf,
  };
}

function setITerm2Font(family: string, size: number): SetFontResult {
  try {
    const profileFont = `${family} ${String(size)}`;

    // Use osascript to set the font on the current profile
    execSync(
      `osascript -e 'tell application "iTerm2" to tell current session of current window to set font to "${profileFont}"' 2>/dev/null || true`,
      { stdio: "ignore", timeout: 5000 },
    );

    return {
      success: true,
      message: `Set ${family} ${String(size)}pt in iTerm2. Restart iTerm2 if not applied.`,
    };
  } catch {
    return {
      success: false,
      message: `Could not auto-set iTerm2 font. Go to: Preferences → Profiles → Text → Font → ${family}`,
    };
  }
}

function setTerminalAppFont(family: string, size: number): SetFontResult {
  try {
    execSync(
      `osascript -e 'tell application "Terminal" to set the font name of settings set "Basic" to "${family}"' 2>/dev/null`,
      { stdio: "ignore", timeout: 5000 },
    );
    execSync(
      `osascript -e 'tell application "Terminal" to set the font size of settings set "Basic" to ${String(size)}' 2>/dev/null`,
      { stdio: "ignore", timeout: 5000 },
    );
    // Also set on the default profile
    execSync(
      `osascript -e 'tell application "Terminal" to set the font name of default settings to "${family}"' 2>/dev/null`,
      { stdio: "ignore", timeout: 5000 },
    );
    execSync(
      `osascript -e 'tell application "Terminal" to set the font size of default settings to ${String(size)}' 2>/dev/null`,
      { stdio: "ignore", timeout: 5000 },
    );
    return {
      success: true,
      message: `Set ${family} ${String(size)}pt in Terminal.app.`,
    };
  } catch {
    return {
      success: false,
      message: `Could not auto-set Terminal.app font. Go to: Preferences → Profiles → Font → ${family}`,
    };
  }
}

function setGhosttyFont(family: string, size: number): SetFontResult {
  const confDir = join(homedir(), ".config", "ghostty");
  const conf = join(confDir, "config");
  mkdirSync(confDir, { recursive: true });

  let content = existsSync(conf) ? readFileSync(conf, "utf-8") : "";

  if (/^font-family\s*=/m.test(content)) {
    content = content.replace(/^font-family\s*=\s*.+$/m, `font-family = ${family}`);
  } else {
    content = `font-family = ${family}\n${content}`;
  }

  if (/^font-size\s*=/m.test(content)) {
    content = content.replace(/^font-size\s*=\s*.+$/m, `font-size = ${String(size)}`);
  } else {
    content = `font-size = ${String(size)}\n${content}`;
  }

  writeFileSync(conf, content);

  return {
    success: true,
    message: `Set ${family} ${String(size)}pt in Ghostty. Restart Ghostty to apply.`,
    configPath: conf,
  };
}

function setFootFont(family: string, size: number): SetFontResult {
  const confDir = join(homedir(), ".config", "foot");
  const conf = join(confDir, "foot.ini");
  mkdirSync(confDir, { recursive: true });

  let content = existsSync(conf) ? readFileSync(conf, "utf-8") : "[main]\n";

  const fontLine = `font=${family}:size=${String(size)}`;

  if (/^font\s*=/m.test(content)) {
    content = content.replace(/^font\s*=.+$/m, fontLine);
  } else if (/^\[main\]/m.test(content)) {
    content = content.replace(/^\[main\]/m, `[main]\n${fontLine}`);
  } else {
    content = `[main]\n${fontLine}\n${content}`;
  }

  writeFileSync(conf, content);

  // Foot reloads on SIGUSR2 if running
  try {
    execSync("pkill -SIGUSR2 foot 2>/dev/null || true", { stdio: "ignore" });
  } catch {
    // non-fatal
  }

  return {
    success: true,
    message: `Set ${family} ${String(size)}pt in Foot.`,
    configPath: conf,
  };
}

function setGnomeTerminalFont(family: string, size: number): SetFontResult {
  try {
    const profileId = execSync("gsettings get org.gnome.Terminal.ProfilesList default", {
      encoding: "utf-8",
    })
      .trim()
      .replace(/'/g, "");

    const schemaPath = `/org/gnome/terminal/legacy/profiles:/:${profileId}/`;

    // Enable custom font
    execSync(
      `gsettings set org.gnome.Terminal.Legacy.Profile:${schemaPath} use-system-font false`,
      { stdio: "ignore" },
    );

    // Set the font
    execSync(
      `gsettings set org.gnome.Terminal.Legacy.Profile:${schemaPath} font '${family} ${String(size)}'`,
      { stdio: "ignore" },
    );

    return {
      success: true,
      message: `Set ${family} ${String(size)}pt in GNOME Terminal. Applied immediately.`,
    };
  } catch {
    return {
      success: false,
      message: `Could not set GNOME Terminal font. Open Preferences → Profile → Text → Custom font → ${family}`,
    };
  }
}
