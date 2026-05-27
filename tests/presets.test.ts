import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePreset, resolvePresets } from "../src/core/presets/loader.js";
import { mergePresetsIntoConfig } from "../src/core/presets/merge.js";
import { appendPresets, listPresets, removePresets } from "../src/core/presets/persist.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import type { AppConfig } from "../src/types/index.js";
import type { Preset } from "../src/core/presets/loader.js";

let workDir: string;
let originalHome: string | undefined;
let originalSoulforgePresets: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sf-presets-"));
  originalHome = process.env.HOME;
  originalSoulforgePresets = process.env.SOULFORGE_PRESETS;
  process.env.HOME = workDir;
  delete process.env.SOULFORGE_PRESETS;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalSoulforgePresets !== undefined)
    process.env.SOULFORGE_PRESETS = originalSoulforgePresets;
  else delete process.env.SOULFORGE_PRESETS;
  rmSync(workDir, { recursive: true, force: true });
});

function writePreset(name: string, body: Record<string, unknown>): string {
  const file = join(workDir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ name, version: "1.0.0", ...body }));
  return file;
}

describe("loader.resolvePreset", () => {
  test("resolves a local path", async () => {
    const file = writePreset("local-pref", { description: "x" });
    const r = await resolvePreset(file);
    expect(r.source).toBe("path");
    expect(r.preset.name).toBe("local-pref");
    expect(r.preset.version).toBe("1.0.0");
  });

  test("rejects missing file", async () => {
    await expect(resolvePreset(join(workDir, "nope.json"))).rejects.toThrow(/not found/);
  });

  test("rejects symlinks", async () => {
    const target = writePreset("target-pref", {});
    const link = join(workDir, "link.json");
    symlinkSync(target, link);
    await expect(resolvePreset(link)).rejects.toThrow(/symlink/);
  });

  test("rejects invalid name", async () => {
    const file = join(workDir, "bad.json");
    writeFileSync(file, JSON.stringify({ name: "BadName", version: "1.0.0" }));
    await expect(resolvePreset(file)).rejects.toThrow(/name/);
  });

  test("rejects invalid version", async () => {
    const file = join(workDir, "bad.json");
    writeFileSync(file, JSON.stringify({ name: "ok", version: "1" }));
    await expect(resolvePreset(file)).rejects.toThrow(/version/);
  });

  test("expands ${VAR} placeholders", async () => {
    process.env.MY_TEST_VAR = "expanded";
    const file = writePreset("env-pref", {
      providers: { foo: { key: "${MY_TEST_VAR}" } },
    });
    const r = await resolvePreset(file);
    const providers = r.preset.providers as { foo: { key: string } };
    expect(providers.foo.key).toBe("expanded");
    delete process.env.MY_TEST_VAR;
  });

  test("rejects http:// urls", async () => {
    await expect(resolvePreset("http://example.com/preset.json")).rejects.toThrow(/https/);
  });
});

describe("loader.resolvePresets", () => {
  test("returns partial success with failures separated", async () => {
    const good = writePreset("good", {});
    const r = await resolvePresets([good, join(workDir, "missing.json")]);
    expect(r.resolved).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
    expect(r.resolved[0]?.preset.name).toBe("good");
    expect(r.failures[0]?.spec).toContain("missing.json");
  });

  test("calls onProgress for each spec", async () => {
    const good = writePreset("g1", {});
    const events: Array<{ spec: string; status: string }> = [];
    await resolvePresets([good, join(workDir, "missing.json")], {
      onProgress: (spec, status) => events.push({ spec, status }),
    });
    expect(events).toHaveLength(2);
    expect(events.some((e) => e.status === "ok")).toBe(true);
    expect(events.some((e) => e.status === "failed")).toBe(true);
  });
});

describe("merge.mergePresetsIntoConfig", () => {
  test("later preset overrides earlier", () => {
    const p1: Preset = { name: "a", version: "1.0.0", defaultModel: "model-a" };
    const p2: Preset = { name: "b", version: "1.0.0", defaultModel: "model-b" };
    const merged = mergePresetsIntoConfig({ ...DEFAULT_CONFIG }, [p1, p2]);
    expect(merged.defaultModel).toBe("model-b");
  });

  test("config block is folded as raw patch", () => {
    const preset: Preset = {
      name: "c",
      version: "1.0.0",
      config: { defaultModel: "from-config-block" },
    };
    const merged = mergePresetsIntoConfig({ ...DEFAULT_CONFIG }, [preset]);
    expect(merged.defaultModel).toBe("from-config-block");
  });

  test("preserves untouched fields", () => {
    const preset: Preset = { name: "d", version: "1.0.0", defaultModel: "x" };
    const merged = mergePresetsIntoConfig({ ...DEFAULT_CONFIG }, [preset]);
    expect(merged.codeExecution).toBe(DEFAULT_CONFIG.codeExecution);
    expect(merged.webSearch).toBe(DEFAULT_CONFIG.webSearch);
  });

  test("nested editorIntegration merges shallow", () => {
    const preset: Preset = {
      name: "e",
      version: "1.0.0",
      editorIntegration: { diagnostics: false } as AppConfig["editorIntegration"],
    };
    const merged = mergePresetsIntoConfig({ ...DEFAULT_CONFIG }, [preset]);
    expect(merged.editorIntegration?.diagnostics).toBe(false);
    expect(merged.editorIntegration?.symbols).toBe(true);
  });
});

describe("persist", () => {
  test("appendPresets creates global file with deduped list", () => {
    const r = appendPresets("global", ["a", "b", "a"]);
    expect(r.after).toEqual(["a", "b"]);
    expect(listPresets("global")).toEqual(["a", "b"]);
  });

  test("appendPresets preserves other config keys", () => {
    const globalFile = join(workDir, ".soulforge", "config.json");
    mkdirSync(join(workDir, ".soulforge"), { recursive: true });
    writeFileSync(globalFile, JSON.stringify({ defaultModel: "keep-me", presets: ["x"] }));
    appendPresets("global", ["y"]);
    const after = JSON.parse(require("node:fs").readFileSync(globalFile, "utf-8"));
    expect(after.defaultModel).toBe("keep-me");
    expect(after.presets).toEqual(["x", "y"]);
  });

  test("appendPresets dedupes against existing", () => {
    appendPresets("global", ["a", "b"]);
    const r = appendPresets("global", ["b", "c"]);
    expect(r.after).toEqual(["a", "b", "c"]);
  });

  test("removePresets drops named entries", () => {
    appendPresets("global", ["a", "b", "c"]);
    const r = removePresets("global", ["b"]);
    expect(r.after).toEqual(["a", "c"]);
  });

  test("removePresets removes presets key entirely when empty", () => {
    appendPresets("global", ["a"]);
    removePresets("global", ["a"]);
    const globalFile = join(workDir, ".soulforge", "config.json");
    const after = JSON.parse(require("node:fs").readFileSync(globalFile, "utf-8"));
    expect(after.presets).toBeUndefined();
  });

  test("project scope writes to <cwd>/.soulforge/config.json", () => {
    const projectCwd = mkdtempSync(join(tmpdir(), "sf-proj-"));
    try {
      const r = appendPresets("project", ["proj-only"], projectCwd);
      expect(r.file).toBe(join(projectCwd, ".soulforge", "config.json"));
      expect(listPresets("project", projectCwd)).toEqual(["proj-only"]);
      expect(listPresets("global")).toEqual([]);
    } finally {
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });
});

describe("init.initPresetsFromEnv", () => {
  test("layers global → project → CLI", async () => {
    const { initPresetsFromEnv } = await import("../src/core/presets/init.js");
    const { setPresetOverlay, getPresetOverlay } = await import("../src/config/index.js");
    setPresetOverlay(null);

    const globalPreset = writePreset("g", { defaultModel: "global-model" });
    const projectPreset = writePreset("p", { defaultModel: "project-model" });
    const cliPreset = writePreset("c", { defaultModel: "cli-model" });

    mkdirSync(join(workDir, ".soulforge"), { recursive: true });
    writeFileSync(
      join(workDir, ".soulforge", "config.json"),
      JSON.stringify({ presets: [globalPreset] }),
    );

    const projectCwd = mkdtempSync(join(tmpdir(), "sf-proj-"));
    try {
      mkdirSync(join(projectCwd, ".soulforge"), { recursive: true });
      writeFileSync(
        join(projectCwd, ".soulforge", "config.json"),
        JSON.stringify({ presets: [projectPreset] }),
      );

      process.env.SOULFORGE_PRESETS = cliPreset;

      const report = await initPresetsFromEnv({ cwd: projectCwd });
      expect(report.fromGlobal).toBe(1);
      expect(report.fromProject).toBe(1);
      expect(report.fromCli).toBe(1);
      expect(report.failed).toEqual([]);

      const overlay = getPresetOverlay();
      expect(overlay).not.toBeNull();
      expect((overlay as AppConfig).defaultModel).toBe("cli-model");
    } finally {
      setPresetOverlay(null);
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });

  test("missing presets do not abort boot", async () => {
    const { initPresetsFromEnv } = await import("../src/core/presets/init.js");
    const { setPresetOverlay } = await import("../src/config/index.js");
    setPresetOverlay(null);

    const good = writePreset("ok-one", { defaultModel: "from-good" });
    process.env.SOULFORGE_PRESETS = `${good},${join(workDir, "missing.json")}`;
    const report = await initPresetsFromEnv();
    expect(report.ok).toContain("ok-one");
    expect(report.failed).toHaveLength(1);
    setPresetOverlay(null);
  });

  test("returns empty report when no specs configured", async () => {
    const { initPresetsFromEnv } = await import("../src/core/presets/init.js");
    const { setPresetOverlay } = await import("../src/config/index.js");
    setPresetOverlay(null);
    const report = await initPresetsFromEnv();
    expect(report.specs).toEqual([]);
    expect(report.ok).toEqual([]);
    expect(report.failed).toEqual([]);
  });
});

describe("config layering with preset overlay", () => {
  test("user config still wins over preset overlay", async () => {
    const { setPresetOverlay, loadConfig } = await import("../src/config/index.js");

    mkdirSync(join(workDir, ".soulforge"), { recursive: true });
    writeFileSync(
      join(workDir, ".soulforge", "config.json"),
      JSON.stringify({ defaultModel: "user-wins" }),
    );

    setPresetOverlay({ defaultModel: "preset-loses" });
    try {
      const cfg = loadConfig();
      expect(cfg.defaultModel).toBe("user-wins");
    } finally {
      setPresetOverlay(null);
    }
  });

  test("no overlay = identical to original behavior", async () => {
    const { setPresetOverlay, loadConfig } = await import("../src/config/index.js");
    setPresetOverlay(null);

    mkdirSync(join(workDir, ".soulforge"), { recursive: true });
    writeFileSync(
      join(workDir, ".soulforge", "config.json"),
      JSON.stringify({ defaultModel: "set-by-user" }),
    );

    const cfg = loadConfig();
    expect(cfg.defaultModel).toBe("set-by-user");
    expect(cfg.codeExecution).toBe(DEFAULT_CONFIG.codeExecution);
  });

  test("preset overrides seeded defaults when user did not customize the key", async () => {
    const { setPresetOverlay, loadConfig } = await import("../src/config/index.js");

    // Simulate a freshly seeded config (== DEFAULT_CONFIG verbatim).
    mkdirSync(join(workDir, ".soulforge"), { recursive: true });
    writeFileSync(
      join(workDir, ".soulforge", "config.json"),
      JSON.stringify(DEFAULT_CONFIG),
    );

    setPresetOverlay({ defaultModel: "preset-wins-when-user-untouched" });
    try {
      const cfg = loadConfig();
      expect(cfg.defaultModel).toBe("preset-wins-when-user-untouched");
    } finally {
      setPresetOverlay(null);
    }
  });

  test("preset overlay applies on first run (no existing config file)", async () => {
    const { setPresetOverlay, loadConfig } = await import("../src/config/index.js");

    setPresetOverlay({ defaultModel: "preset-on-first-run" });
    try {
      const cfg = loadConfig();
      expect(cfg.defaultModel).toBe("preset-on-first-run");
    } finally {
      setPresetOverlay(null);
    }
  });

  test("nested keys merge — preset theme.name preserved when user only sets theme.transparent", async () => {
    const { setPresetOverlay, loadConfig } = await import("../src/config/index.js");

    mkdirSync(join(workDir, ".soulforge"), { recursive: true });
    writeFileSync(
      join(workDir, ".soulforge", "config.json"),
      JSON.stringify({ theme: { ...DEFAULT_CONFIG.theme, transparent: false } }),
    );

    setPresetOverlay({ theme: { name: "preset-theme", transparent: DEFAULT_CONFIG.theme.transparent } });
    try {
      const cfg = loadConfig();
      expect(cfg.theme.name).toBe("preset-theme");
      expect(cfg.theme.transparent).toBe(false);
    } finally {
      setPresetOverlay(null);
    }
  });
});
