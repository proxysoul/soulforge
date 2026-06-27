/**
 * Built-in theme palettes — color values derived from the following projects:
 *
 * Solarized        — Ethan Schoonover        MIT     github.com/altercation/solarized
 * Catppuccin        — Catppuccin Org           MIT     github.com/catppuccin/catppuccin
 * Gruvbox           — Pavel Pertsev            MIT     github.com/morhetz/gruvbox
 * Tokyo Night       — Folke Lemaitre           Apache  github.com/folke/tokyonight.nvim
 * Dracula           — Dracula Theme            MIT     github.com/dracula/dracula-theme
 * Nord              — Arctic Ice Studio        MIT     github.com/nordtheme/nord
 * One Dark / Light  — Atom (GitHub)            MIT     github.com/atom/one-dark-syntax
 * Rosé Pine         — Rosé Pine               MIT     github.com/rose-pine/rose-pine-theme
 * Kanagawa          — Tommaso Laureati         MIT     github.com/rebelot/kanagawa.nvim
 * GitHub Dark/Light — GitHub Primer            MIT     github.com/primer/primitives
 * Everforest        — Sainnhe Park             MIT     github.com/sainnhe/everforest
 * Ayu               — Ayu Theme               MIT     github.com/ayu-theme/ayu-colors
 * Nightfox          — EdenEast                 MIT     github.com/EdenEast/nightfox.nvim
 */

export interface ThemeTokens {
  // Brand
  brand: string;
  brandSecondary: string;
  brandDim: string;
  brandAlt: string;

  // Semantic status
  error: string;
  success: string;
  warning: string;
  info: string;
  amber: string;

  // Text hierarchy
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textDim: string;
  textFaint: string;
  textSubtle: string;

  // Backgrounds
  bgApp: string;
  bgPopup: string;
  bgPopupHighlight: string;
  bgOverlay: string;
  bgPrimary: string;
  bgSecondary: string;
  bgElevated: string;
  bgInput: string;
  bgBanner: string;
  bgBannerError: string;
  bgUser: string;

  // Borders
  border: string;
  borderFocused: string;
  borderActive: string;
  borderSlash: string;

  // Diff
  diffAddedBg: string;
  diffRemovedBg: string;
  diffAddedSign: string;
  diffRemovedSign: string;

  // Accents
  accentUser: string;
  accentAssistant: string;
  accentSystem: string;
}

export const DARK_THEME: ThemeTokens = {
  brand: "#9B30FF",
  brandSecondary: "#FF0040",
  brandDim: "#4a1a6b",
  brandAlt: "#8B5CF6",

  error: "#f44",
  success: "#4a7",
  warning: "#FF8C00",
  info: "#00BFFF",
  amber: "#b87333",

  textPrimary: "#ccc",
  textSecondary: "#888",
  textMuted: "#555",
  textDim: "#444",
  textFaint: "#333",
  textSubtle: "#222",

  bgApp: "#000",
  bgPopup: "#111122",
  bgPopupHighlight: "#1a1a3e",
  bgOverlay: "#0a0812",
  bgPrimary: "#000",
  bgSecondary: "#111",
  bgElevated: "#1a1a1a",
  bgInput: "#0d1520",
  bgBanner: "#1a1028",
  bgBannerError: "#3a1010",
  bgUser: "#0a1218",

  border: "#333",
  borderFocused: "#FF0040",
  borderActive: "#9B30FF",
  borderSlash: "#3a7bd5",

  diffAddedBg: "#0a1a0f",
  diffRemovedBg: "#1a0a0a",
  diffAddedSign: "#4a7",
  diffRemovedSign: "#a55",

  accentUser: "#00BFFF",
  accentAssistant: "#9B30FF",
  accentSystem: "#555",
};

export const LIGHT_THEME: ThemeTokens = {
  brand: "#7B20CF",
  brandSecondary: "#CC0030",
  brandDim: "#c4a0e8",
  brandAlt: "#6B4ACF",

  error: "#c00",
  success: "#080",
  warning: "#c60",
  info: "#0088CC",
  amber: "#8a5500",

  textPrimary: "#222",
  textSecondary: "#555",
  textMuted: "#888",
  textDim: "#aaa",
  textFaint: "#ccc",
  textSubtle: "#e5e5e5",

  bgApp: "#fff",
  bgPopup: "#f0f0f8",
  bgPopupHighlight: "#dde0f0",
  bgOverlay: "#e8e8f0",
  bgPrimary: "#fff",
  bgSecondary: "#f5f5f5",
  bgElevated: "#eee",
  bgInput: "#f0f4f8",
  bgBanner: "#ece0f5",
  bgBannerError: "#fde8e8",
  bgUser: "#e8f0f5",

  border: "#c0c0c0",
  borderFocused: "#CC0030",
  borderActive: "#7B20CF",
  borderSlash: "#3a7bd5",

  diffAddedBg: "#e6f4ea",
  diffRemovedBg: "#fce8e6",
  diffAddedSign: "#080",
  diffRemovedSign: "#a44",

  accentUser: "#0077BB",
  accentAssistant: "#7B20CF",
  accentSystem: "#888",
};

const SOLARIZED_DARK: ThemeTokens = {
  ...DARK_THEME,
  brand: "#268bd2",
  brandSecondary: "#dc322f",
  brandDim: "#073642",
  brandAlt: "#6c71c4",

  error: "#dc322f",
  success: "#859900",
  warning: "#b58900",
  info: "#2aa198",
  amber: "#cb4b16",

  textPrimary: "#93a1a1",
  textSecondary: "#839496",
  textMuted: "#657b83",
  textDim: "#586e75",
  textFaint: "#2b4f5a",
  textSubtle: "#073642",

  bgApp: "#002b36",
  bgPopup: "#002b36",
  bgPopupHighlight: "#073642",
  bgOverlay: "#001e26",
  bgPrimary: "#002b36",
  bgSecondary: "#073642",
  bgElevated: "#073642",
  bgInput: "#002b36",
  bgBanner: "#073642",
  bgBannerError: "#3a1010",
  bgUser: "#073642",

  border: "#586e75",
  borderFocused: "#dc322f",
  borderActive: "#268bd2",
  borderSlash: "#2aa198",

  accentUser: "#2aa198",
  accentAssistant: "#268bd2",
  accentSystem: "#586e75",
};

const CATPPUCCIN: ThemeTokens = {
  ...DARK_THEME,
  brand: "#cba6f7",
  brandSecondary: "#f38ba8",
  brandDim: "#45475a",
  brandAlt: "#b4befe",

  error: "#f38ba8",
  success: "#a6e3a1",
  warning: "#fab387",
  info: "#89dceb",
  amber: "#f9e2af",

  textPrimary: "#cdd6f4",
  textSecondary: "#a6adc8",
  textMuted: "#6c7086",
  textDim: "#585b70",
  textFaint: "#45475a",
  textSubtle: "#313244",

  bgApp: "#1e1e2e",
  bgPopup: "#1e1e2e",
  bgPopupHighlight: "#313244",
  bgOverlay: "#11111b",
  bgPrimary: "#1e1e2e",
  bgSecondary: "#181825",
  bgElevated: "#313244",
  bgInput: "#1e1e2e",
  bgBanner: "#313244",
  bgBannerError: "#45475a",
  bgUser: "#181825",

  border: "#45475a",
  borderFocused: "#f38ba8",
  borderActive: "#cba6f7",
  borderSlash: "#89b4fa",

  accentUser: "#89dceb",
  accentAssistant: "#cba6f7",
  accentSystem: "#6c7086",
};

const GRUVBOX_DARK: ThemeTokens = {
  ...DARK_THEME,
  brand: "#d79921",
  brandSecondary: "#cc241d",
  brandDim: "#504945",
  brandAlt: "#b16286",

  error: "#fb4934",
  success: "#b8bb26",
  warning: "#fabd2f",
  info: "#83a598",
  amber: "#fe8019",

  textPrimary: "#ebdbb2",
  textSecondary: "#a89984",
  textMuted: "#7c6f64",
  textDim: "#665c54",
  textFaint: "#45403d",
  textSubtle: "#282828",

  bgApp: "#282828",
  bgPopup: "#282828",
  bgPopupHighlight: "#3c3836",
  bgOverlay: "#1d2021",
  bgPrimary: "#282828",
  bgSecondary: "#1d2021",
  bgElevated: "#3c3836",
  bgInput: "#282828",
  bgBanner: "#3c3836",
  bgBannerError: "#3c3836",
  bgUser: "#1d2021",

  diffAddedBg: "#1a2e1a",
  diffRemovedBg: "#2e1a1a",
  diffAddedSign: "#98971a",
  diffRemovedSign: "#cc241d",

  border: "#504945",
  borderFocused: "#cc241d",
  borderActive: "#d79921",
  borderSlash: "#458588",

  accentUser: "#458588",
  accentAssistant: "#d79921",
  accentSystem: "#7c6f64",
};

const TOKYO_NIGHT: ThemeTokens = {
  ...DARK_THEME,
  brand: "#7aa2f7",
  brandSecondary: "#f7768e",
  brandDim: "#292e42",
  brandAlt: "#bb9af7",

  error: "#f7768e",
  success: "#9ece6a",
  warning: "#e0af68",
  info: "#7dcfff",
  amber: "#ff9e64",

  textPrimary: "#c0caf5",
  textSecondary: "#a9b1d6",
  textMuted: "#565f89",
  textDim: "#444b6a",
  textFaint: "#343b58",
  textSubtle: "#1f2335",

  bgApp: "#1a1b26",
  bgPopup: "#1a1b26",
  bgPopupHighlight: "#292e42",
  bgOverlay: "#16161e",
  bgPrimary: "#1a1b26",
  bgSecondary: "#16161e",
  bgElevated: "#292e42",
  bgInput: "#1a1b26",
  bgBanner: "#292e42",
  bgBannerError: "#3b2042",
  bgUser: "#16161e",

  diffAddedBg: "#1a2e20",
  diffRemovedBg: "#2e1a22",
  diffAddedSign: "#9ece6a",
  diffRemovedSign: "#914c54",

  border: "#3b4261",
  borderFocused: "#f7768e",
  borderActive: "#7aa2f7",
  borderSlash: "#7dcfff",

  accentUser: "#7dcfff",
  accentAssistant: "#7aa2f7",
  accentSystem: "#565f89",
};

const DRACULA: ThemeTokens = {
  ...DARK_THEME,
  brand: "#bd93f9",
  brandSecondary: "#ff5555",
  brandDim: "#44475a",
  brandAlt: "#ff79c6",

  error: "#ff5555",
  success: "#50fa7b",
  warning: "#ffb86c",
  info: "#8be9fd",
  amber: "#f1fa8c",

  textPrimary: "#f8f8f2",
  textSecondary: "#bfbfbf",
  textMuted: "#6272a4",
  textDim: "#535780",
  textFaint: "#44476a",
  textSubtle: "#282a36",

  bgApp: "#282a36",
  bgPopup: "#282a36",
  bgPopupHighlight: "#44475a",
  bgOverlay: "#21222c",
  bgPrimary: "#282a36",
  bgSecondary: "#21222c",
  bgElevated: "#44475a",
  bgInput: "#282a36",
  bgBanner: "#44475a",
  bgBannerError: "#44475a",
  bgUser: "#21222c",

  diffAddedBg: "#1a2e1a",
  diffRemovedBg: "#2e1a1a",
  diffAddedSign: "#50fa7b",
  diffRemovedSign: "#ff5555",

  border: "#44475a",
  borderFocused: "#ff5555",
  borderActive: "#bd93f9",
  borderSlash: "#8be9fd",

  accentUser: "#8be9fd",
  accentAssistant: "#bd93f9",
  accentSystem: "#6272a4",
};

const NORD: ThemeTokens = {
  ...DARK_THEME,
  brand: "#88c0d0",
  brandSecondary: "#bf616a",
  brandDim: "#3b4252",
  brandAlt: "#b48ead",

  error: "#bf616a",
  success: "#a3be8c",
  warning: "#ebcb8b",
  info: "#81a1c1",
  amber: "#d08770",

  textPrimary: "#eceff4",
  textSecondary: "#d8dee9",
  textMuted: "#6d7a96",
  textDim: "#576279",
  textFaint: "#434c5e",
  textSubtle: "#242933",

  bgApp: "#2e3440",
  bgPopup: "#2e3440",
  bgPopupHighlight: "#3b4252",
  bgOverlay: "#242933",
  bgPrimary: "#2e3440",
  bgSecondary: "#242933",
  bgElevated: "#3b4252",
  bgInput: "#2e3440",
  bgBanner: "#3b4252",
  bgBannerError: "#3b4252",
  bgUser: "#242933",

  diffAddedBg: "#1a2e1e",
  diffRemovedBg: "#2e1a1e",
  diffAddedSign: "#a3be8c",
  diffRemovedSign: "#bf616a",

  border: "#4c566a",
  borderFocused: "#bf616a",
  borderActive: "#88c0d0",
  borderSlash: "#81a1c1",

  accentUser: "#81a1c1",
  accentAssistant: "#88c0d0",
  accentSystem: "#4c566a",
};

const ONE_DARK: ThemeTokens = {
  ...DARK_THEME,
  brand: "#61afef",
  brandSecondary: "#e06c75",
  brandDim: "#3e4451",
  brandAlt: "#c678dd",

  error: "#e06c75",
  success: "#98c379",
  warning: "#e5c07b",
  info: "#56b6c2",
  amber: "#d19a66",

  textPrimary: "#abb2bf",
  textSecondary: "#9da5b4",
  textMuted: "#6b727f",
  textDim: "#4e5569",
  textFaint: "#3e4451",
  textSubtle: "#21252b",

  bgApp: "#282c34",
  bgPopup: "#21252b",
  bgPopupHighlight: "#2c313a",
  bgOverlay: "#1b1f23",
  bgPrimary: "#282c34",
  bgSecondary: "#21252b",
  bgElevated: "#2c313a",
  bgInput: "#282c34",
  bgBanner: "#2c313a",
  bgBannerError: "#3e2832",
  bgUser: "#21252b",

  diffAddedBg: "#1a2e1a",
  diffRemovedBg: "#2e1a1a",
  diffAddedSign: "#98c379",
  diffRemovedSign: "#e06c75",

  border: "#4b5263",
  borderFocused: "#e06c75",
  borderActive: "#61afef",
  borderSlash: "#56b6c2",

  accentUser: "#56b6c2",
  accentAssistant: "#61afef",
  accentSystem: "#5c6370",
};

const ROSE_PINE: ThemeTokens = {
  ...DARK_THEME,
  brand: "#c4a7e7",
  brandSecondary: "#eb6f92",
  brandDim: "#26233a",
  brandAlt: "#f6c177",

  error: "#eb6f92",
  success: "#31748f",
  warning: "#f6c177",
  info: "#9ccfd8",
  amber: "#ebbcba",

  textPrimary: "#e0def4",
  textSecondary: "#908caa",
  textMuted: "#6e6a86",
  textDim: "#524f67",
  textFaint: "#393552",
  textSubtle: "#1f1d2e",

  bgApp: "#191724",
  bgPopup: "#191724",
  bgPopupHighlight: "#26233a",
  bgOverlay: "#1f1d2e",
  bgPrimary: "#191724",
  bgSecondary: "#1f1d2e",
  bgElevated: "#26233a",
  bgInput: "#191724",
  bgBanner: "#26233a",
  bgBannerError: "#3a2333",
  bgUser: "#1f1d2e",

  diffAddedBg: "#1a2528",
  diffRemovedBg: "#2e1a22",
  diffAddedSign: "#31748f",
  diffRemovedSign: "#eb6f92",

  border: "#403d52",
  borderFocused: "#eb6f92",
  borderActive: "#c4a7e7",
  borderSlash: "#9ccfd8",

  accentUser: "#9ccfd8",
  accentAssistant: "#c4a7e7",
  accentSystem: "#6e6a86",
};

const KANAGAWA: ThemeTokens = {
  ...DARK_THEME,
  brand: "#7e9cd8",
  brandSecondary: "#c34043",
  brandDim: "#2a2a37",
  brandAlt: "#957fb8",

  error: "#c34043",
  success: "#76946a",
  warning: "#dca561",
  info: "#7fb4ca",
  amber: "#ffa066",

  textPrimary: "#dcd7ba",
  textSecondary: "#c8c093",
  textMuted: "#727169",
  textDim: "#54546d",
  textFaint: "#363646",
  textSubtle: "#1f1f28",

  bgApp: "#1f1f28",
  bgPopup: "#1f1f28",
  bgPopupHighlight: "#2a2a37",
  bgOverlay: "#16161d",
  bgPrimary: "#1f1f28",
  bgSecondary: "#16161d",
  bgElevated: "#2a2a37",
  bgInput: "#1f1f28",
  bgBanner: "#2a2a37",
  bgBannerError: "#2a2037",
  bgUser: "#16161d",

  diffAddedBg: "#1a2a1a",
  diffRemovedBg: "#2a1a1a",
  diffAddedSign: "#76946a",
  diffRemovedSign: "#c34043",

  border: "#54546d",
  borderFocused: "#c34043",
  borderActive: "#7e9cd8",
  borderSlash: "#7fb4ca",

  accentUser: "#7fb4ca",
  accentAssistant: "#7e9cd8",
  accentSystem: "#727169",
};

const CATPPUCCIN_LATTE: ThemeTokens = {
  ...LIGHT_THEME,
  brand: "#8839ef",
  brandSecondary: "#d20f39",
  brandDim: "#bcc0cc",
  brandAlt: "#7287fd",

  error: "#d20f39",
  success: "#389323",
  warning: "#c6790b",
  info: "#0284b8",
  amber: "#fe640b",

  textPrimary: "#4c4f69",
  textSecondary: "#5c5f77",
  textMuted: "#6c6f85",
  textDim: "#8c8fa1",
  textFaint: "#9ca0b0",
  textSubtle: "#bcc0cc",

  bgApp: "#eff1f5",
  bgPopup: "#e6e9ef",
  bgPopupHighlight: "#ccd0da",
  bgOverlay: "#dce0e8",
  bgPrimary: "#eff1f5",
  bgSecondary: "#e6e9ef",
  bgElevated: "#ccd0da",
  bgInput: "#e6e9ef",
  bgBanner: "#dce0e8",
  bgBannerError: "#f5d0d6",
  bgUser: "#dce0e8",

  diffAddedBg: "#d5f0d5",
  diffRemovedBg: "#f5d0d6",
  diffAddedSign: "#40a02b",
  diffRemovedSign: "#d20f39",

  border: "#bcc0cc",
  borderFocused: "#d20f39",
  borderActive: "#8839ef",
  borderSlash: "#04a5e5",

  accentUser: "#0284b8",
  accentAssistant: "#8839ef",
  accentSystem: "#6c6f85",
};

const CATPPUCCIN_FRAPPE: ThemeTokens = {
  ...DARK_THEME,
  brand: "#ca9ee6",
  brandSecondary: "#e78284",
  brandDim: "#414559",
  brandAlt: "#babbf1",

  error: "#e78284",
  success: "#a6d189",
  warning: "#ef9f76",
  info: "#85c1dc",
  amber: "#e5c890",

  textPrimary: "#c6d0f5",
  textSecondary: "#a5adce",
  textMuted: "#737994",
  textDim: "#626880",
  textFaint: "#51576d",
  textSubtle: "#303446",

  bgApp: "#303446",
  bgPopup: "#303446",
  bgPopupHighlight: "#414559",
  bgOverlay: "#292c3c",
  bgPrimary: "#303446",
  bgSecondary: "#292c3c",
  bgElevated: "#414559",
  bgInput: "#303446",
  bgBanner: "#414559",
  bgBannerError: "#51384a",
  bgUser: "#292c3c",

  diffAddedBg: "#2a3a2a",
  diffRemovedBg: "#3a2a2a",
  diffAddedSign: "#a6d189",
  diffRemovedSign: "#e78284",

  border: "#51576d",
  borderFocused: "#e78284",
  borderActive: "#ca9ee6",
  borderSlash: "#85c1dc",

  accentUser: "#85c1dc",
  accentAssistant: "#ca9ee6",
  accentSystem: "#626880",
};

const CATPPUCCIN_MACCHIATO: ThemeTokens = {
  ...DARK_THEME,
  brand: "#c6a0f6",
  brandSecondary: "#ed8796",
  brandDim: "#363a4f",
  brandAlt: "#b7bdf8",

  error: "#ed8796",
  success: "#a6da95",
  warning: "#f5a97f",
  info: "#8bd5ca",
  amber: "#eed49f",

  textPrimary: "#cad3f5",
  textSecondary: "#a5adcb",
  textMuted: "#6e738d",
  textDim: "#5b6078",
  textFaint: "#494d64",
  textSubtle: "#24273a",

  bgApp: "#24273a",
  bgPopup: "#24273a",
  bgPopupHighlight: "#363a4f",
  bgOverlay: "#1e2030",
  bgPrimary: "#24273a",
  bgSecondary: "#1e2030",
  bgElevated: "#363a4f",
  bgInput: "#24273a",
  bgBanner: "#363a4f",
  bgBannerError: "#4a3048",
  bgUser: "#1e2030",

  diffAddedBg: "#253528",
  diffRemovedBg: "#352528",
  diffAddedSign: "#a6da95",
  diffRemovedSign: "#ed8796",

  border: "#494d64",
  borderFocused: "#ed8796",
  borderActive: "#c6a0f6",
  borderSlash: "#8bd5ca",

  accentUser: "#8bd5ca",
  accentAssistant: "#c6a0f6",
  accentSystem: "#5b6078",
};

const GITHUB_DARK: ThemeTokens = {
  ...DARK_THEME,
  brand: "#58a6ff",
  brandSecondary: "#f85149",
  brandDim: "#161b22",
  brandAlt: "#bc8cff",

  error: "#f85149",
  success: "#3fb950",
  warning: "#d29922",
  info: "#58a6ff",
  amber: "#e3b341",

  textPrimary: "#e6edf3",
  textSecondary: "#8b949e",
  textMuted: "#6e7681",
  textDim: "#484f58",
  textFaint: "#30363d",
  textSubtle: "#161b22",

  bgApp: "#0d1117",
  bgPopup: "#161b22",
  bgPopupHighlight: "#21262d",
  bgOverlay: "#010409",
  bgPrimary: "#0d1117",
  bgSecondary: "#010409",
  bgElevated: "#161b22",
  bgInput: "#0d1117",
  bgBanner: "#161b22",
  bgBannerError: "#3d1418",
  bgUser: "#010409",

  diffAddedBg: "#0d2818",
  diffRemovedBg: "#3d1418",
  diffAddedSign: "#3fb950",
  diffRemovedSign: "#f85149",

  border: "#30363d",
  borderFocused: "#f85149",
  borderActive: "#58a6ff",
  borderSlash: "#58a6ff",

  accentUser: "#58a6ff",
  accentAssistant: "#58a6ff",
  accentSystem: "#484f58",
};

const GITHUB_LIGHT: ThemeTokens = {
  ...LIGHT_THEME,
  brand: "#0969da",
  brandSecondary: "#cf222e",
  brandDim: "#afb8c1",
  brandAlt: "#8250df",

  error: "#cf222e",
  success: "#1a7f37",
  warning: "#9a6700",
  info: "#0969da",
  amber: "#bf8700",

  textPrimary: "#1f2328",
  textSecondary: "#59636e",
  textMuted: "#6e7781",
  textDim: "#8c959f",
  textFaint: "#afb8c1",
  textSubtle: "#d0d7de",

  bgApp: "#ffffff",
  bgPopup: "#f6f8fa",
  bgPopupHighlight: "#eaeef2",
  bgOverlay: "#eaeef2",
  bgPrimary: "#ffffff",
  bgSecondary: "#f6f8fa",
  bgElevated: "#eaeef2",
  bgInput: "#f6f8fa",
  bgBanner: "#ddf4ff",
  bgBannerError: "#ffebe9",
  bgUser: "#f6f8fa",

  diffAddedBg: "#dafbe1",
  diffRemovedBg: "#ffebe9",
  diffAddedSign: "#1a7f37",
  diffRemovedSign: "#cf222e",

  border: "#c8cfd6",
  borderFocused: "#cf222e",
  borderActive: "#0969da",
  borderSlash: "#0969da",

  accentUser: "#0969da",
  accentAssistant: "#0969da",
  accentSystem: "#6e7781",
};

const EVERFOREST_DARK: ThemeTokens = {
  ...DARK_THEME,
  brand: "#7fbbb3",
  brandSecondary: "#e67e80",
  brandDim: "#374247",
  brandAlt: "#d699b6",

  error: "#e67e80",
  success: "#a7c080",
  warning: "#dbbc7f",
  info: "#83c092",
  amber: "#e69875",

  textPrimary: "#d3c6aa",
  textSecondary: "#9da9a0",
  textMuted: "#7a8478",
  textDim: "#56635f",
  textFaint: "#4a555b",
  textSubtle: "#2d353b",

  bgApp: "#2d353b",
  bgPopup: "#2d353b",
  bgPopupHighlight: "#374247",
  bgOverlay: "#232a2e",
  bgPrimary: "#2d353b",
  bgSecondary: "#232a2e",
  bgElevated: "#374247",
  bgInput: "#2d353b",
  bgBanner: "#374247",
  bgBannerError: "#4c3743",
  bgUser: "#232a2e",

  diffAddedBg: "#283a28",
  diffRemovedBg: "#3a2828",
  diffAddedSign: "#a7c080",
  diffRemovedSign: "#e67e80",

  border: "#4a555b",
  borderFocused: "#e67e80",
  borderActive: "#7fbbb3",
  borderSlash: "#7fbbb3",

  accentUser: "#83c092",
  accentAssistant: "#7fbbb3",
  accentSystem: "#7a8478",
};

const AYU_DARK: ThemeTokens = {
  ...DARK_THEME,
  brand: "#e6b450",
  brandSecondary: "#f07178",
  brandDim: "#11151c",
  brandAlt: "#d2a6ff",

  error: "#f07178",
  success: "#aad94c",
  warning: "#e6b450",
  info: "#73b8ff",
  amber: "#ff8f40",

  textPrimary: "#bfbdb6",
  textSecondary: "#acb6bf",
  textMuted: "#636a72",
  textDim: "#464b50",
  textFaint: "#272d38",
  textSubtle: "#0f131a",

  bgApp: "#0b0e14",
  bgPopup: "#0f131a",
  bgPopupHighlight: "#1c2029",
  bgOverlay: "#070a0f",
  bgPrimary: "#0b0e14",
  bgSecondary: "#070a0f",
  bgElevated: "#0f131a",
  bgInput: "#0b0e14",
  bgBanner: "#11151c",
  bgBannerError: "#3a1520",
  bgUser: "#070a0f",

  diffAddedBg: "#1a2a14",
  diffRemovedBg: "#2a1418",
  diffAddedSign: "#aad94c",
  diffRemovedSign: "#f07178",

  border: "#2d3440",
  borderFocused: "#f07178",
  borderActive: "#e6b450",
  borderSlash: "#73b8ff",

  accentUser: "#73b8ff",
  accentAssistant: "#e6b450",
  accentSystem: "#636a72",
};

const NIGHTFOX: ThemeTokens = {
  ...DARK_THEME,
  brand: "#719cd6",
  brandSecondary: "#c94f6d",
  brandDim: "#29394f",
  brandAlt: "#9d79d6",

  error: "#c94f6d",
  success: "#81b29a",
  warning: "#dbc074",
  info: "#63cdcf",
  amber: "#f4a261",

  textPrimary: "#cdcecf",
  textSecondary: "#aeafb0",
  textMuted: "#71839b",
  textDim: "#39506d",
  textFaint: "#29394f",
  textSubtle: "#192330",

  bgApp: "#192330",
  bgPopup: "#192330",
  bgPopupHighlight: "#29394f",
  bgOverlay: "#131a24",
  bgPrimary: "#192330",
  bgSecondary: "#131a24",
  bgElevated: "#29394f",
  bgInput: "#192330",
  bgBanner: "#29394f",
  bgBannerError: "#3d2030",
  bgUser: "#131a24",

  diffAddedBg: "#1a2e28",
  diffRemovedBg: "#2e1a22",
  diffAddedSign: "#81b29a",
  diffRemovedSign: "#c94f6d",

  border: "#39506d",
  borderFocused: "#c94f6d",
  borderActive: "#719cd6",
  borderSlash: "#63cdcf",

  accentUser: "#63cdcf",
  accentAssistant: "#719cd6",
  accentSystem: "#71839b",
};

const TOKYONIGHT_STORM: ThemeTokens = {
  ...DARK_THEME,
  brand: "#7aa2f7",
  brandSecondary: "#f7768e",
  brandDim: "#2f334d",
  brandAlt: "#bb9af7",

  error: "#f7768e",
  success: "#9ece6a",
  warning: "#e0af68",
  info: "#7dcfff",
  amber: "#ff9e64",

  textPrimary: "#c0caf5",
  textSecondary: "#a9b1d6",
  textMuted: "#636da6",
  textDim: "#4a5282",
  textFaint: "#3b4261",
  textSubtle: "#24283b",

  bgApp: "#24283b",
  bgPopup: "#24283b",
  bgPopupHighlight: "#2f334d",
  bgOverlay: "#1f2335",
  bgPrimary: "#24283b",
  bgSecondary: "#1f2335",
  bgElevated: "#2f334d",
  bgInput: "#24283b",
  bgBanner: "#2f334d",
  bgBannerError: "#3b2042",
  bgUser: "#1f2335",

  diffAddedBg: "#1a2e20",
  diffRemovedBg: "#2e1a22",
  diffAddedSign: "#9ece6a",
  diffRemovedSign: "#914c54",

  border: "#414868",
  borderFocused: "#f7768e",
  borderActive: "#7aa2f7",
  borderSlash: "#7dcfff",

  accentUser: "#7dcfff",
  accentAssistant: "#7aa2f7",
  accentSystem: "#636da6",
};

const ONE_LIGHT: ThemeTokens = {
  ...LIGHT_THEME,
  brand: "#4078f2",
  brandSecondary: "#e45649",
  brandDim: "#c8ccd4",
  brandAlt: "#a626a4",

  error: "#e45649",
  success: "#50a14f",
  warning: "#c18401",
  info: "#0184bc",
  amber: "#986801",

  textPrimary: "#383a42",
  textSecondary: "#4b4e55",
  textMuted: "#696c77",
  textDim: "#a0a1a7",
  textFaint: "#c8ccd4",
  textSubtle: "#e5e5e6",

  bgApp: "#fafafa",
  bgPopup: "#f0f0f0",
  bgPopupHighlight: "#e5e5e6",
  bgOverlay: "#e8e8e8",
  bgPrimary: "#fafafa",
  bgSecondary: "#f0f0f0",
  bgElevated: "#e5e5e6",
  bgInput: "#f0f0f0",
  bgBanner: "#e5e5e6",
  bgBannerError: "#fce4e4",
  bgUser: "#eaeaeb",

  diffAddedBg: "#e0f4e0",
  diffRemovedBg: "#fce4e4",
  diffAddedSign: "#50a14f",
  diffRemovedSign: "#e45649",

  border: "#c0c0c5",
  borderFocused: "#e45649",
  borderActive: "#4078f2",
  borderSlash: "#0184bc",

  accentUser: "#0184bc",
  accentAssistant: "#4078f2",
  accentSystem: "#696c77",
};

/**
 * Additional built-in themes — color values derived from the following projects:
 *
 * Cyberdream       — Scott McKendry            MIT     github.com/scottmckendry/cyberdream.nvim
 * Oxocarbon        — Nyoom Engineering          MIT     github.com/nyoom-engineering/oxocarbon.nvim
 * Sonokai          — Sainnhe Park               MIT     github.com/sainnhe/sonokai
 * Moonfly          — bluz71                     MIT     github.com/bluz71/vim-moonfly-colors
 * Melange          — savq                       MIT     github.com/savq/melange-nvim
 * Solarized Osaka  — Takuya Matsuyama           Apache  github.com/craftzdog/solarized-osaka.nvim
 * Bamboo           — ribru17                    MIT     github.com/ribru17/bamboo.nvim
 * Nordic           — AlexvZyl                   MIT     github.com/AlexvZyl/nordic.nvim
 */

const CYBERDREAM: ThemeTokens = {
  ...DARK_THEME,
  brand: "#5ef1ff",
  brandSecondary: "#ff6e5e",
  brandDim: "#1e2124",
  brandAlt: "#bd5eff",

  error: "#ff6e5e",
  success: "#5eff6c",
  warning: "#f1ff5e",
  info: "#5ef1ff",
  amber: "#ffbd5e",

  textPrimary: "#ffffff",
  textSecondary: "#b0b0b0",
  textMuted: "#7b8496",
  textDim: "#545a68",
  textFaint: "#3c4048",
  textSubtle: "#1e2124",

  bgApp: "#16181a",
  bgPopup: "#16181a",
  bgPopupHighlight: "#1e2124",
  bgOverlay: "#0e1012",
  bgPrimary: "#16181a",
  bgSecondary: "#0e1012",
  bgElevated: "#1e2124",
  bgInput: "#16181a",
  bgBanner: "#1e2124",
  bgBannerError: "#3a1818",
  bgUser: "#0e1012",

  diffAddedBg: "#0e2a14",
  diffRemovedBg: "#2a0e12",
  diffAddedSign: "#5eff6c",
  diffRemovedSign: "#ff6e5e",

  border: "#3c4048",
  borderFocused: "#ff6e5e",
  borderActive: "#5ef1ff",
  borderSlash: "#bd5eff",

  accentUser: "#5ef1ff",
  accentAssistant: "#bd5eff",
  accentSystem: "#7b8496",
};

const OXOCARBON: ThemeTokens = {
  ...DARK_THEME,
  brand: "#78a9ff",
  brandSecondary: "#ee5396",
  brandDim: "#2a2a2e",
  brandAlt: "#be95ff",

  error: "#ee5396",
  success: "#42be65",
  warning: "#ffe97b",
  info: "#33b1ff",
  amber: "#ff832b",

  textPrimary: "#f2f4f8",
  textSecondary: "#dde1e6",
  textMuted: "#697077",
  textDim: "#525252",
  textFaint: "#393939",
  textSubtle: "#262626",

  bgApp: "#161616",
  bgPopup: "#161616",
  bgPopupHighlight: "#262626",
  bgOverlay: "#0e0e0e",
  bgPrimary: "#161616",
  bgSecondary: "#0e0e0e",
  bgElevated: "#262626",
  bgInput: "#161616",
  bgBanner: "#262626",
  bgBannerError: "#3a1428",
  bgUser: "#0e0e0e",

  diffAddedBg: "#0e2818",
  diffRemovedBg: "#2e0e1a",
  diffAddedSign: "#42be65",
  diffRemovedSign: "#ee5396",

  border: "#393939",
  borderFocused: "#ee5396",
  borderActive: "#78a9ff",
  borderSlash: "#33b1ff",

  accentUser: "#33b1ff",
  accentAssistant: "#78a9ff",
  accentSystem: "#525252",
};

const SONOKAI: ThemeTokens = {
  ...DARK_THEME,
  brand: "#76cce0",
  brandSecondary: "#fc5d7c",
  brandDim: "#33353f",
  brandAlt: "#b39df3",

  error: "#fc5d7c",
  success: "#9ed072",
  warning: "#e7c664",
  info: "#76cce0",
  amber: "#f39660",

  textPrimary: "#e2e2e3",
  textSecondary: "#b9b9ba",
  textMuted: "#7f8490",
  textDim: "#595f6f",
  textFaint: "#414550",
  textSubtle: "#2c2e34",

  bgApp: "#2c2e34",
  bgPopup: "#2c2e34",
  bgPopupHighlight: "#33353f",
  bgOverlay: "#22242a",
  bgPrimary: "#2c2e34",
  bgSecondary: "#22242a",
  bgElevated: "#33353f",
  bgInput: "#2c2e34",
  bgBanner: "#33353f",
  bgBannerError: "#4a2030",
  bgUser: "#22242a",

  diffAddedBg: "#1a2e1a",
  diffRemovedBg: "#2e1a20",
  diffAddedSign: "#9ed072",
  diffRemovedSign: "#fc5d7c",

  border: "#414550",
  borderFocused: "#fc5d7c",
  borderActive: "#76cce0",
  borderSlash: "#b39df3",

  accentUser: "#76cce0",
  accentAssistant: "#b39df3",
  accentSystem: "#7f8490",
};

const MOONFLY: ThemeTokens = {
  ...DARK_THEME,
  brand: "#80a0ff",
  brandSecondary: "#ff5454",
  brandDim: "#1c1c1c",
  brandAlt: "#cf87e8",

  error: "#ff5454",
  success: "#8cc85f",
  warning: "#e3c78a",
  info: "#79dac8",
  amber: "#de935f",

  textPrimary: "#bdbdbd",
  textSecondary: "#9e9e9e",
  textMuted: "#6e6e6e",
  textDim: "#4e4e4e",
  textFaint: "#323437",
  textSubtle: "#1c1c1c",

  bgApp: "#080808",
  bgPopup: "#080808",
  bgPopupHighlight: "#1c1c1c",
  bgOverlay: "#040404",
  bgPrimary: "#080808",
  bgSecondary: "#040404",
  bgElevated: "#1c1c1c",
  bgInput: "#080808",
  bgBanner: "#1c1c1c",
  bgBannerError: "#3a1010",
  bgUser: "#040404",

  diffAddedBg: "#0a1e0a",
  diffRemovedBg: "#1e0a0a",
  diffAddedSign: "#8cc85f",
  diffRemovedSign: "#ff5454",

  border: "#323437",
  borderFocused: "#ff5454",
  borderActive: "#80a0ff",
  borderSlash: "#79dac8",

  accentUser: "#79dac8",
  accentAssistant: "#80a0ff",
  accentSystem: "#6e6e6e",
};

const MELANGE: ThemeTokens = {
  ...DARK_THEME,
  brand: "#86a3a3",
  brandSecondary: "#b65c60",
  brandDim: "#34302c",
  brandAlt: "#cf9bc2",

  error: "#b65c60",
  success: "#78997a",
  warning: "#ebc06d",
  info: "#86a3a3",
  amber: "#e49b5d",

  textPrimary: "#ece1d7",
  textSecondary: "#c1a78e",
  textMuted: "#867462",
  textDim: "#6b5c4d",
  textFaint: "#4a4340",
  textSubtle: "#34302c",

  bgApp: "#292522",
  bgPopup: "#292522",
  bgPopupHighlight: "#34302c",
  bgOverlay: "#211e1b",
  bgPrimary: "#292522",
  bgSecondary: "#211e1b",
  bgElevated: "#34302c",
  bgInput: "#292522",
  bgBanner: "#34302c",
  bgBannerError: "#3a2020",
  bgUser: "#211e1b",

  diffAddedBg: "#1a2a1e",
  diffRemovedBg: "#2a1a1a",
  diffAddedSign: "#78997a",
  diffRemovedSign: "#b65c60",

  border: "#4a4340",
  borderFocused: "#b65c60",
  borderActive: "#86a3a3",
  borderSlash: "#cf9bc2",

  accentUser: "#86a3a3",
  accentAssistant: "#cf9bc2",
  accentSystem: "#867462",
};

const SOLARIZED_OSAKA: ThemeTokens = {
  ...DARK_THEME,
  brand: "#268bd2",
  brandSecondary: "#db4b4b",
  brandDim: "#001e26",
  brandAlt: "#7aa2f7",

  error: "#db4b4b",
  success: "#859900",
  warning: "#b58900",
  info: "#2ac3de",
  amber: "#cb4b16",

  textPrimary: "#839496",
  textSecondary: "#657b83",
  textMuted: "#586e75",
  textDim: "#405b67",
  textFaint: "#1a3a45",
  textSubtle: "#001e26",

  bgApp: "#002b36",
  bgPopup: "#001e26",
  bgPopupHighlight: "#003847",
  bgOverlay: "#00141c",
  bgPrimary: "#002b36",
  bgSecondary: "#00141c",
  bgElevated: "#003847",
  bgInput: "#002b36",
  bgBanner: "#003847",
  bgBannerError: "#3a1010",
  bgUser: "#00141c",

  diffAddedBg: "#002e1a",
  diffRemovedBg: "#2e0014",
  diffAddedSign: "#859900",
  diffRemovedSign: "#db4b4b",

  border: "#1a3a45",
  borderFocused: "#db4b4b",
  borderActive: "#268bd2",
  borderSlash: "#2ac3de",

  accentUser: "#2ac3de",
  accentAssistant: "#268bd2",
  accentSystem: "#586e75",
};

const BAMBOO: ThemeTokens = {
  ...DARK_THEME,
  brand: "#8fb573",
  brandSecondary: "#e75a7c",
  brandDim: "#2f3331",
  brandAlt: "#aab386",

  error: "#e75a7c",
  success: "#8fb573",
  warning: "#e5a84b",
  info: "#78b892",
  amber: "#d89b65",

  textPrimary: "#e0dcc7",
  textSecondary: "#b3af98",
  textMuted: "#7d7e6e",
  textDim: "#5c5e52",
  textFaint: "#3e4238",
  textSubtle: "#252623",

  bgApp: "#252623",
  bgPopup: "#252623",
  bgPopupHighlight: "#2f3331",
  bgOverlay: "#1c1d1a",
  bgPrimary: "#252623",
  bgSecondary: "#1c1d1a",
  bgElevated: "#2f3331",
  bgInput: "#252623",
  bgBanner: "#2f3331",
  bgBannerError: "#3a2028",
  bgUser: "#1c1d1a",

  diffAddedBg: "#1a2e1a",
  diffRemovedBg: "#2e1a20",
  diffAddedSign: "#8fb573",
  diffRemovedSign: "#e75a7c",

  border: "#3e4238",
  borderFocused: "#e75a7c",
  borderActive: "#8fb573",
  borderSlash: "#78b892",

  accentUser: "#78b892",
  accentAssistant: "#8fb573",
  accentSystem: "#7d7e6e",
};

const NORDIC: ThemeTokens = {
  ...DARK_THEME,
  brand: "#81a1c1",
  brandSecondary: "#bf616a",
  brandDim: "#2e3440",
  brandAlt: "#b48ead",

  error: "#bf616a",
  success: "#a3be8c",
  warning: "#ebcb8b",
  info: "#88c0d0",
  amber: "#d08770",

  textPrimary: "#d8dee9",
  textSecondary: "#c0c8d8",
  textMuted: "#60728a",
  textDim: "#4c566a",
  textFaint: "#3b4252",
  textSubtle: "#242933",

  bgApp: "#1e222a",
  bgPopup: "#1e222a",
  bgPopupHighlight: "#2e3440",
  bgOverlay: "#191c24",
  bgPrimary: "#1e222a",
  bgSecondary: "#191c24",
  bgElevated: "#2e3440",
  bgInput: "#1e222a",
  bgBanner: "#2e3440",
  bgBannerError: "#3a2028",
  bgUser: "#191c24",

  diffAddedBg: "#1a2e1e",
  diffRemovedBg: "#2e1a1e",
  diffAddedSign: "#a3be8c",
  diffRemovedSign: "#bf616a",

  border: "#3b4252",
  borderFocused: "#bf616a",
  borderActive: "#81a1c1",
  borderSlash: "#88c0d0",

  accentUser: "#88c0d0",
  accentAssistant: "#81a1c1",
  accentSystem: "#60728a",
};

// ── Original SoulForge themes ──

const SYNTHWAVE: ThemeTokens = {
  ...DARK_THEME,
  brand: "#f97e72",
  brandSecondary: "#ff7edb",
  brandDim: "#2a1a3e",
  brandAlt: "#fede5d",

  error: "#fe4450",
  success: "#72f1b8",
  warning: "#fede5d",
  info: "#36f9f6",
  amber: "#f97e72",

  textPrimary: "#f0e8d6",
  textSecondary: "#b6a0c8",
  textMuted: "#6e5a8a",
  textDim: "#4a3a62",
  textFaint: "#342850",
  textSubtle: "#1a1028",

  bgApp: "#0e0a1a",
  bgPopup: "#140e24",
  bgPopupHighlight: "#241a38",
  bgOverlay: "#080612",
  bgPrimary: "#0e0a1a",
  bgSecondary: "#080612",
  bgElevated: "#241a38",
  bgInput: "#140e24",
  bgBanner: "#241a38",
  bgBannerError: "#3a0a1a",
  bgUser: "#080612",

  diffAddedBg: "#0a2a1a",
  diffRemovedBg: "#2a0a14",
  diffAddedSign: "#72f1b8",
  diffRemovedSign: "#fe4450",

  border: "#342850",
  borderFocused: "#ff7edb",
  borderActive: "#f97e72",
  borderSlash: "#36f9f6",

  accentUser: "#36f9f6",
  accentAssistant: "#ff7edb",
  accentSystem: "#6e5a8a",
};

const ICEBERG: ThemeTokens = {
  ...DARK_THEME,
  brand: "#84a0c6",
  brandSecondary: "#e27878",
  brandDim: "#1e2132",
  brandAlt: "#a093c7",

  error: "#e27878",
  success: "#b4be82",
  warning: "#e2a478",
  info: "#89b8c2",
  amber: "#e2a478",

  textPrimary: "#c6c8d1",
  textSecondary: "#9a9ca5",
  textMuted: "#6b7089",
  textDim: "#535768",
  textFaint: "#3e4155",
  textSubtle: "#1e2132",

  bgApp: "#161821",
  bgPopup: "#161821",
  bgPopupHighlight: "#1e2132",
  bgOverlay: "#0f1117",
  bgPrimary: "#161821",
  bgSecondary: "#0f1117",
  bgElevated: "#1e2132",
  bgInput: "#161821",
  bgBanner: "#1e2132",
  bgBannerError: "#3a1828",
  bgUser: "#0f1117",

  diffAddedBg: "#1a2a1e",
  diffRemovedBg: "#2a1a1e",
  diffAddedSign: "#b4be82",
  diffRemovedSign: "#e27878",

  border: "#3e4155",
  borderFocused: "#e27878",
  borderActive: "#84a0c6",
  borderSlash: "#89b8c2",

  accentUser: "#89b8c2",
  accentAssistant: "#84a0c6",
  accentSystem: "#6b7089",
};

const EMBER: ThemeTokens = {
  ...DARK_THEME,
  brand: "#ff6d3f",
  brandSecondary: "#ff3a5c",
  brandDim: "#2a1810",
  brandAlt: "#ffaa44",

  error: "#ff3a5c",
  success: "#7dba5a",
  warning: "#ffaa44",
  info: "#5aafba",
  amber: "#ff8c42",

  textPrimary: "#e8d5c4",
  textSecondary: "#b09882",
  textMuted: "#7a6252",
  textDim: "#5a4838",
  textFaint: "#3a3028",
  textSubtle: "#1e1610",

  bgApp: "#120e0a",
  bgPopup: "#1a1410",
  bgPopupHighlight: "#2a2018",
  bgOverlay: "#0a0806",
  bgPrimary: "#120e0a",
  bgSecondary: "#0a0806",
  bgElevated: "#2a2018",
  bgInput: "#1a1410",
  bgBanner: "#2a2018",
  bgBannerError: "#3a1010",
  bgUser: "#0a0806",

  diffAddedBg: "#142a14",
  diffRemovedBg: "#2a1414",
  diffAddedSign: "#7dba5a",
  diffRemovedSign: "#ff3a5c",

  border: "#3a3028",
  borderFocused: "#ff3a5c",
  borderActive: "#ff6d3f",
  borderSlash: "#ffaa44",

  accentUser: "#5aafba",
  accentAssistant: "#ff6d3f",
  accentSystem: "#7a6252",
};

const VESPER: ThemeTokens = {
  ...DARK_THEME,
  brand: "#ffc799",
  brandSecondary: "#de6e7c",
  brandDim: "#232220",
  brandAlt: "#d4976c",

  error: "#de6e7c",
  success: "#819b69",
  warning: "#b77e64",
  info: "#6099c0",
  amber: "#d4976c",

  textPrimary: "#d2cfc9",
  textSecondary: "#a09d98",
  textMuted: "#706d68",
  textDim: "#555350",
  textFaint: "#3a3938",
  textSubtle: "#232220",

  bgApp: "#101010",
  bgPopup: "#101010",
  bgPopupHighlight: "#232220",
  bgOverlay: "#0a0a0a",
  bgPrimary: "#101010",
  bgSecondary: "#0a0a0a",
  bgElevated: "#232220",
  bgInput: "#101010",
  bgBanner: "#232220",
  bgBannerError: "#3a1820",
  bgUser: "#0a0a0a",

  diffAddedBg: "#142214",
  diffRemovedBg: "#221418",
  diffAddedSign: "#819b69",
  diffRemovedSign: "#de6e7c",

  border: "#3a3938",
  borderFocused: "#de6e7c",
  borderActive: "#ffc799",
  borderSlash: "#6099c0",

  accentUser: "#6099c0",
  accentAssistant: "#ffc799",
  accentSystem: "#706d68",
};

const PROXYSOUL_MAIN: ThemeTokens = {
  ...DARK_THEME,
  brand: "#7844f0",
  brandSecondary: "#ff0059",
  brandDim: "#211e33",
  brandAlt: "#9b6af5",

  error: "#ee0b2a",
  success: "#0b8b00",
  warning: "#de7c00",
  info: "#00a2ce",
  amber: "#e65f2a",

  textPrimary: "#e7e7ee",
  textSecondary: "#8e8ca1",
  textMuted: "#5c5a6e",
  textDim: "#3d3b50",
  textFaint: "#2a2840",
  textSubtle: "#1a1830",

  bgApp: "#020204",
  bgPopup: "#07060d",
  bgPopupHighlight: "#120e22",
  bgOverlay: "#020204",
  bgPrimary: "#020204",
  bgSecondary: "#07060d",
  bgElevated: "#120e22",
  bgInput: "#0a0818",
  bgBanner: "#120e22",
  bgBannerError: "#3a0a12",
  bgUser: "#0a0818",

  border: "#211e33",
  borderFocused: "#ff0059",
  borderActive: "#7844f0",
  borderSlash: "#9b6af5",

  diffAddedBg: "#061a08",
  diffRemovedBg: "#1a0608",
  diffAddedSign: "#0b8b00",
  diffRemovedSign: "#ee0b2a",

  accentUser: "#00a2ce",
  accentAssistant: "#7844f0",
  accentSystem: "#5c5a6e",
};

const PROXYSOUL_COFFEE: ThemeTokens = {
  ...PROXYSOUL_MAIN,
  brand: "#de7c00",
  brandSecondary: "#e65f2a",
  brandDim: "#2e2010",
  brandAlt: "#c8944a",

  warning: "#e65f2a",
  amber: "#de7c00",

  bgPopupHighlight: "#1a1510",
  bgElevated: "#1a1510",
  bgInput: "#0d0a06",
  bgBanner: "#1a1510",
  bgUser: "#0d0a06",

  border: "#2e2010",
  borderFocused: "#e65f2a",
  borderActive: "#de7c00",
  borderSlash: "#c8944a",

  accentAssistant: "#de7c00",
};

const PROXYSOUL_WATER: ThemeTokens = {
  ...PROXYSOUL_MAIN,
  brand: "#00a2ce",
  brandSecondary: "#009a8b",
  brandDim: "#0e2030",
  brandAlt: "#3bb8d8",

  info: "#3bb8d8",

  bgPopupHighlight: "#0e1a22",
  bgElevated: "#0e1a22",
  bgInput: "#060d14",
  bgBanner: "#0e1a22",
  bgUser: "#060d14",

  border: "#0e2030",
  borderFocused: "#009a8b",
  borderActive: "#00a2ce",
  borderSlash: "#3bb8d8",

  accentUser: "#009a8b",
  accentAssistant: "#00a2ce",
};

export const LATE_NIGHT: ThemeTokens = {
  ...DARK_THEME,
  brand: "#7C6FD4",
  brandSecondary: "#A89EE8",
  brandDim: "#2D2850",
  brandAlt: "#C4BCEF",
  error: "#E05C6A",
  success: "#5DBB8A",
  warning: "#E2C08D",
  info: "#5B9BD4",
  amber: "#C9894A",
  textPrimary: "#EEEAE3",
  textSecondary: "#B8B3AA",
  textMuted: "#847F78",
  textDim: "#5C5852",
  textFaint: "#3A3833",
  textSubtle: "#6B6762",
  bgApp: "#0A0A0C",
  bgPrimary: "#0F0F12",
  bgSecondary: "#141417",
  bgElevated: "#1A1A1F",
  bgPopup: "#1C1C22",
  bgPopupHighlight: "#25252D",
  bgOverlay: "#0A0A0C",
  bgInput: "#16161B",
  bgBanner: "#1A1A1F",
  bgBannerError: "#1F1218",
  bgUser: "#141420",
  border: "#222228",
  borderFocused: "#7C6FD4",
  borderActive: "#A89EE8",
  borderSlash: "#2E2E38",
  diffAddedBg: "#0E1F16",
  diffRemovedBg: "#1F0E12",
  diffAddedSign: "#5DBB8A",
  diffRemovedSign: "#E05C6A",
  accentUser: "#3a79e2",
  accentAssistant: "#d061fc",
  accentSystem: "#3A3845",
};

/** Theme metadata for the picker UI */
export interface ThemeMeta {
  label: string;
  description: string;
  variant: "dark" | "light";
}

export const THEME_META: Record<string, ThemeMeta> = {
  dark: { label: "Dark", description: "SoulForge default dark", variant: "dark" },
  light: { label: "Light", description: "Clean light theme", variant: "light" },
  "solarized-dark": {
    label: "Solarized Dark",
    description: "Ethan Schoonover's classic",
    variant: "dark",
  },
  catppuccin: { label: "Catppuccin Mocha", description: "Warm pastel dark theme", variant: "dark" },
  "gruvbox-dark": {
    label: "Gruvbox Dark",
    description: "Retro groove color scheme",
    variant: "dark",
  },
  "tokyo-night": {
    label: "Tokyo Night",
    description: "Clean dark with vivid accents",
    variant: "dark",
  },
  dracula: { label: "Dracula", description: "Dark theme for dark souls", variant: "dark" },
  nord: { label: "Nord", description: "Arctic, north-bluish palette", variant: "dark" },
  "one-dark": { label: "One Dark", description: "Atom's iconic dark theme", variant: "dark" },
  "rose-pine": { label: "Rosé Pine", description: "Soho vibes for the terminal", variant: "dark" },
  kanagawa: { label: "Kanagawa", description: "Inspired by Katsushika Hokusai", variant: "dark" },
  "catppuccin-latte": {
    label: "Catppuccin Latte",
    description: "Catppuccin's light variant",
    variant: "light",
  },
  "catppuccin-frappe": {
    label: "Catppuccin Frappé",
    description: "Catppuccin's mid-tone dark variant",
    variant: "dark",
  },
  "catppuccin-macchiato": {
    label: "Catppuccin Macchiato",
    description: "Catppuccin's cool dark variant",
    variant: "dark",
  },
  "github-dark": {
    label: "GitHub Dark",
    description: "GitHub's default dark theme",
    variant: "dark",
  },
  "github-light": {
    label: "GitHub Light",
    description: "GitHub's default light theme",
    variant: "light",
  },
  "everforest-dark": {
    label: "Everforest Dark",
    description: "Comfortable green-tinted dark theme",
    variant: "dark",
  },
  "ayu-dark": {
    label: "Ayu Dark",
    description: "Simple dark with warm accents",
    variant: "dark",
  },
  nightfox: {
    label: "Nightfox",
    description: "Soft navy blue dark theme",
    variant: "dark",
  },
  "tokyonight-storm": {
    label: "Tokyo Night Storm",
    description: "Tokyo Night's storm variant",
    variant: "dark",
  },
  "one-light": {
    label: "One Light",
    description: "Atom's iconic light theme",
    variant: "light",
  },
  "proxysoul-main": {
    label: "proxySoul",
    description: "Deep purple with hot pink accents",
    variant: "dark",
  },
  "proxysoul-coffee": {
    label: "proxySoul Coffee",
    description: "Warm amber & burnt orange",
    variant: "dark",
  },
  "proxysoul-water": {
    label: "proxySoul Water",
    description: "Ocean blue & teal",
    variant: "dark",
  },
  cyberdream: {
    label: "Cyberdream",
    description: "High-contrast futuristic & vibrant",
    variant: "dark",
  },
  oxocarbon: {
    label: "Oxocarbon",
    description: "IBM Carbon-inspired minimal dark",
    variant: "dark",
  },
  sonokai: {
    label: "Sonokai",
    description: "Vivid colors based on Monokai Pro",
    variant: "dark",
  },
  moonfly: {
    label: "Moonfly",
    description: "Dark charcoal with neon accents",
    variant: "dark",
  },
  melange: {
    label: "Melange",
    description: "Warm earthy tones, cozy & readable",
    variant: "dark",
  },
  "solarized-osaka": {
    label: "Solarized Osaka",
    description: "Solarized reimagined by craftzdog",
    variant: "dark",
  },
  bamboo: {
    label: "Bamboo",
    description: "Warm green nature-inspired theme",
    variant: "dark",
  },
  nordic: {
    label: "Nordic",
    description: "Nord but warmer and darker",
    variant: "dark",
  },
  synthwave: {
    label: "Synthwave",
    description: "Retro neon 80s vibes",
    variant: "dark",
  },
  iceberg: {
    label: "Iceberg",
    description: "Cool blue-gray minimal dark",
    variant: "dark",
  },
  ember: {
    label: "Ember",
    description: "Volcanic dark with fire accents",
    variant: "dark",
  },
  vesper: {
    label: "Vesper",
    description: "Midnight amber & golden warmth",
    variant: "dark",
  },
  "late-night": {
    label: "Late Night",
    description: "Premium near-black with cyan and indigo — built for long sessions",
    variant: "dark",
  },
};

export const BUILTIN_THEMES: Record<string, ThemeTokens> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
  "solarized-dark": SOLARIZED_DARK,
  catppuccin: CATPPUCCIN,
  "gruvbox-dark": GRUVBOX_DARK,
  "tokyo-night": TOKYO_NIGHT,
  dracula: DRACULA,
  nord: NORD,
  "one-dark": ONE_DARK,
  "rose-pine": ROSE_PINE,
  kanagawa: KANAGAWA,
  "catppuccin-latte": CATPPUCCIN_LATTE,
  "catppuccin-frappe": CATPPUCCIN_FRAPPE,
  "catppuccin-macchiato": CATPPUCCIN_MACCHIATO,
  "github-dark": GITHUB_DARK,
  "github-light": GITHUB_LIGHT,
  "everforest-dark": EVERFOREST_DARK,
  "ayu-dark": AYU_DARK,
  nightfox: NIGHTFOX,
  "tokyonight-storm": TOKYONIGHT_STORM,
  "one-light": ONE_LIGHT,
  "proxysoul-main": PROXYSOUL_MAIN,
  "proxysoul-coffee": PROXYSOUL_COFFEE,
  "proxysoul-water": PROXYSOUL_WATER,
  cyberdream: CYBERDREAM,
  oxocarbon: OXOCARBON,
  sonokai: SONOKAI,
  moonfly: MOONFLY,
  melange: MELANGE,
  "solarized-osaka": SOLARIZED_OSAKA,
  bamboo: BAMBOO,
  nordic: NORDIC,
  synthwave: SYNTHWAVE,
  iceberg: ICEBERG,
  ember: EMBER,
  vesper: VESPER,
  "late-night": LATE_NIGHT,
};

/** Convert kebab-case token key to camelCase (e.g. "bg-primary" → "bgPrimary") */
export function normalizeTokenKey(key: string): string {
  return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
