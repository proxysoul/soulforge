/**
 * Tests for the /thinking, /effort, /websearch, etc. settings commands that
 * Hearth surfaces (Telegram/Discord) expose remotely. We mock loadConfig +
 * saveGlobalConfig so the tests never touch ~/.soulforge.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  handleSettingsCommand,
  renderSettingsOverview,
  SETTINGS,
  SETTINGS_COMMAND_NAMES,
  settingsHelpLines,
  validateSettingValue,
} from "../src/hearth/provider-commands.js";
import type { AppConfig } from "../src/types/index.js";

const EMPTY_CFG: AppConfig = {
  defaultModel: "none",
  routerRules: [],
  editor: { command: "nvim", args: [] },
  theme: { name: "dark", transparent: true },
  nvimConfig: "default",
  editorIntegration: {
    diagnostics: true,
    symbols: true,
    hover: true,
    references: true,
    definition: true,
    codeActions: true,
    editorContext: true,
    rename: true,
    lspStatus: true,
    format: true,
    syncEditorOnEdit: false,
  },
  codeExecution: true,
  webSearch: true,
};

interface Captured {
  patches: Partial<AppConfig>[];
  notes: string[];
}

function makeHarness(initial: AppConfig = EMPTY_CFG): {
  notify: (text: string) => void;
  load: () => AppConfig;
  save: (patch: Partial<AppConfig>) => void;
  captured: Captured;
} {
  const captured: Captured = { patches: [], notes: [] };
  return {
    notify: (text) => captured.notes.push(text),
    load: () => initial,
    save: (patch) => captured.patches.push(patch),
    captured,
  };
}

describe("provider-commands — registry", () => {
  test("every setting has a /<cmd> entry in SETTINGS_COMMAND_NAMES", () => {
    for (const s of SETTINGS) {
      expect(SETTINGS_COMMAND_NAMES).toContain(`/${s.cmd}`);
    }
    expect(SETTINGS_COMMAND_NAMES).toContain("/settings");
  });

  test("settingsHelpLines has a line per setting", () => {
    const help = settingsHelpLines().join("\n");
    for (const s of SETTINGS) {
      expect(help).toContain(`/${s.cmd}`);
    }
  });

  test("no duplicate cmd names", () => {
    const names = SETTINGS.map((s) => s.cmd);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("provider-commands — validateSettingValue", () => {
  const thinking = SETTINGS.find((s) => s.cmd === "thinking");
  const budget = SETTINGS.find((s) => s.cmd === "budget");
  const codeexec = SETTINGS.find((s) => s.cmd === "codeexec");

  test("cycle accepts known option (case-insensitive)", () => {
    expect(thinking).toBeDefined();
    if (!thinking) return;
    const r = validateSettingValue(thinking, "ENABLED");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("enabled");
  });

  test("cycle rejects unknown option", () => {
    if (!thinking) return;
    const r = validateSettingValue(thinking, "nope");
    expect(r.ok).toBe(false);
  });

  test("toggle accepts on/off/true/false/1/0", () => {
    if (!codeexec) return;
    for (const v of ["on", "true", "1", "yes"]) {
      const r = validateSettingValue(codeexec, v);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe("on");
    }
    for (const v of ["off", "false", "0", "no"]) {
      const r = validateSettingValue(codeexec, v);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe("off");
    }
  });

  test("toggle rejects nonsense", () => {
    if (!codeexec) return;
    const r = validateSettingValue(codeexec, "maybe");
    expect(r.ok).toBe(false);
  });

  test("budget requires integer ≥ 1024", () => {
    if (!budget) return;
    expect(validateSettingValue(budget, "2048").ok).toBe(true);
    expect(validateSettingValue(budget, "500").ok).toBe(false);
    expect(validateSettingValue(budget, "abc").ok).toBe(false);
  });

  test("empty raw fails", () => {
    if (!thinking) return;
    expect(validateSettingValue(thinking, "   ").ok).toBe(false);
  });
});

describe("provider-commands — handleSettingsCommand", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  test("unknown command returns false (not handled)", async () => {
    const handled = await handleSettingsCommand("/bogus", [], h.notify, {
      load: h.load,
      save: h.save,
    });
    expect(handled).toBe(false);
    expect(h.captured.patches).toEqual([]);
  });

  test("/settings prints overview", async () => {
    const handled = await handleSettingsCommand("/settings", [], h.notify, {
      load: h.load,
      save: h.save,
    });
    expect(handled).toBe(true);
    expect(h.captured.notes[0]).toContain("Provider settings");
    expect(h.captured.patches).toEqual([]);
  });

  test("/thinking with no args shows current + options", async () => {
    await handleSettingsCommand("/thinking", [], h.notify, { load: h.load, save: h.save });
    expect(h.captured.notes[0]).toContain("/thinking");
    expect(h.captured.notes[0]).toContain("off"); // default
    expect(h.captured.notes[0]).toContain("enabled"); // option in help
    expect(h.captured.patches).toEqual([]);
  });

  test("/thinking enabled writes thinking.mode patch", async () => {
    await handleSettingsCommand("/thinking", ["enabled"], h.notify, {
      load: h.load,
      save: h.save,
    });
    expect(h.captured.patches.length).toBe(1);
    expect(h.captured.patches[0]).toEqual({ thinking: { mode: "enabled" } });
    expect(h.captured.notes[0]).toContain("✓");
  });

  test("/effort high writes performance.effort patch", async () => {
    await handleSettingsCommand("/effort", ["high"], h.notify, { load: h.load, save: h.save });
    expect(h.captured.patches[0]).toEqual({ performance: { effort: "high" } });
  });

  test("/budget 4096 writes thinking patch with mode=enabled", async () => {
    await handleSettingsCommand("/budget", ["4096"], h.notify, { load: h.load, save: h.save });
    expect(h.captured.patches[0]).toEqual({
      thinking: { mode: "enabled", budgetTokens: 4096 },
    });
  });

  test("/codeexec off writes top-level codeExecution=false", async () => {
    await handleSettingsCommand("/codeexec", ["off"], h.notify, { load: h.load, save: h.save });
    expect(h.captured.patches[0]).toEqual({ codeExecution: false });
  });

  test("/websearch on writes top-level webSearch=true", async () => {
    await handleSettingsCommand("/websearch", ["on"], h.notify, { load: h.load, save: h.save });
    expect(h.captured.patches[0]).toEqual({ webSearch: true });
  });

  test("/compact on writes contextManagement.compact=true", async () => {
    await handleSettingsCommand("/compact", ["on"], h.notify, { load: h.load, save: h.save });
    expect(h.captured.patches[0]).toEqual({ contextManagement: { compact: true } });
  });

  test("/pruning subagents writes contextManagement.pruningTarget", async () => {
    await handleSettingsCommand("/pruning", ["subagents"], h.notify, {
      load: h.load,
      save: h.save,
    });
    expect(h.captured.patches[0]).toEqual({ contextManagement: { pruningTarget: "subagents" } });
  });

  test("invalid value reports error, no save", async () => {
    await handleSettingsCommand("/thinking", ["nope"], h.notify, { load: h.load, save: h.save });
    expect(h.captured.patches).toEqual([]);
    expect(h.captured.notes[0]).toContain("✗");
  });

  test("save throwing is reported, not propagated", async () => {
    const throwSave = () => {
      throw new Error("disk full");
    };
    await handleSettingsCommand("/effort", ["low"], h.notify, {
      load: h.load,
      save: throwSave,
    });
    expect(h.captured.notes[0]).toContain("✗");
    expect(h.captured.notes[0]).toContain("disk full");
  });
});

describe("provider-commands — renderSettingsOverview", () => {
  test("includes every cmd and reads current values", () => {
    const cfg: AppConfig = {
      ...EMPTY_CFG,
      thinking: { mode: "enabled", budgetTokens: 8192 },
      performance: { effort: "high", speed: "fast" },
      webSearch: false,
    };
    const out = renderSettingsOverview(cfg);
    for (const s of SETTINGS) expect(out).toContain(`/${s.cmd}`);
    expect(out).toContain("enabled"); // thinking.mode
    expect(out).toContain("8192"); // budgetTokens
    expect(out).toContain("high"); // effort
    expect(out).toContain("fast"); // speed
  });
});
