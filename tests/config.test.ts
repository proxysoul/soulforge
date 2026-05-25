import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  loadConfig,
  mergeConfigs,
  saveGlobalConfig,
  saveProjectConfig,
} from "../src/config/index.js";
import { AppConfig } from "../src/types/index.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("config retry deep-merge", () => {
  describe("mergeConfigs", () => {
    test("merges retry settings from layer", () => {
      const base: AppConfig = {
        ...DEFAULT_CONFIG,
        retry: { maxRetries: 3, baseDelayMs: 1000 },
      };
      const layer = { retry: { maxRetries: 5 } };
      const result = mergeConfigs(base, layer);
      expect(result.retry).toEqual({ maxRetries: 5, baseDelayMs: 1000 });
    });

    test("keeps base retry when layer has no retry", () => {
      const base: AppConfig = {
        ...DEFAULT_CONFIG,
        retry: { maxRetries: 3, baseDelayMs: 1000 },
      };
      const layer = {};
      const result = mergeConfigs(base, layer);
      expect(result.retry).toEqual({ maxRetries: 3, baseDelayMs: 1000 });
    });

    test("layer overrides all retry fields", () => {
      const base: AppConfig = {
        ...DEFAULT_CONFIG,
        retry: { maxRetries: 3, baseDelayMs: 1000 },
      };
      const layer = { retry: { maxRetries: 10, baseDelayMs: 2000 } };
      const result = mergeConfigs(base, layer);
      expect(result.retry).toEqual({ maxRetries: 10, baseDelayMs: 2000 });
    });

    test("multiple layers merge correctly", () => {
      const base: AppConfig = {
        ...DEFAULT_CONFIG,
        retry: { maxRetries: 3, baseDelayMs: 1000 },
      };
      const layer1 = { retry: { maxRetries: 5 } };
      const layer2 = { retry: { baseDelayMs: 3000 } };
      const result = mergeConfigs(mergeConfigs(base, layer1), layer2);
      expect(result.retry).toEqual({ maxRetries: 5, baseDelayMs: 3000 });
    });
  });

  describe("saveProjectConfig", () => {
    const testDir = join(tmpdir(), "soulforge-config-test");

    test("deep-merges retry into project config", () => {
      // Create test project directory
      mkdirSync(join(testDir, ".soulforge"), { recursive: true });
      const configFile = join(testDir, ".soulforge", "config.json");

      // Write initial config with retry
      const initial = { retry: { maxRetries: 3, baseDelayMs: 1000 } };
      writeFileSync(configFile, JSON.stringify(initial));

      // Patch with new retry settings
      saveProjectConfig(testDir, { retry: { maxRetries: 5 } });

      const saved = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(saved.retry).toEqual({ maxRetries: 5, baseDelayMs: 1000 });

      // Cleanup
      rmSync(testDir, { recursive: true, force: true });
    });
  });

  describe("saveGlobalConfig", () => {
    // saveGlobalConfig resolves $HOME/.soulforge/config.json on POSIX and
    // %LOCALAPPDATA%/SoulForge/config.json on Windows. Override both to a
    // throwaway dir so the real user config can't be touched.
    test("deep-merges retry into global config", () => {
      const sandbox = join(tmpdir(), `sf-global-${process.pid}-${Date.now()}`);
      const origHome = process.env.HOME;
      const origLocal = process.env.LOCALAPPDATA;
      process.env.HOME = sandbox;
      process.env.LOCALAPPDATA = sandbox;
      try {
        const cfgDir = process.platform === "win32"
          ? join(sandbox, "SoulForge")
          : join(sandbox, ".soulforge");
        const cfgFile = join(cfgDir, "config.json");
        mkdirSync(cfgDir, { recursive: true });
        writeFileSync(
          cfgFile,
          JSON.stringify({ retry: { maxRetries: 3, baseDelayMs: 1000 } }),
        );

        saveGlobalConfig({ retry: { maxRetries: 5 } });

        const saved = JSON.parse(readFileSync(cfgFile, "utf-8"));
        expect(saved.retry).toEqual({ maxRetries: 5, baseDelayMs: 1000 });
      } finally {
        if (origHome !== undefined) process.env.HOME = origHome;
        else delete process.env.HOME;
        if (origLocal !== undefined) process.env.LOCALAPPDATA = origLocal;
        else delete process.env.LOCALAPPDATA;
        rmSync(sandbox, { recursive: true, force: true });
      }
    });

    test("loadConfig round-trips through configDir() routing", () => {
      const sandbox = join(tmpdir(), `sf-global-rt-${process.pid}-${Date.now()}`);
      const origHome = process.env.HOME;
      const origLocal = process.env.LOCALAPPDATA;
      process.env.HOME = sandbox;
      process.env.LOCALAPPDATA = sandbox;
      try {
        // saveGlobalConfig → loadConfig must route to the same configDir().
        saveGlobalConfig({ retry: { maxRetries: 7, baseDelayMs: 1234 } });
        const loaded = loadConfig();
        expect(loaded.retry?.maxRetries).toBe(7);
        expect(loaded.retry?.baseDelayMs).toBe(1234);
      } finally {
        if (origHome !== undefined) process.env.HOME = origHome;
        else delete process.env.HOME;
        if (origLocal !== undefined) process.env.LOCALAPPDATA = origLocal;
        else delete process.env.LOCALAPPDATA;
        rmSync(sandbox, { recursive: true, force: true });
      }
    });

    test("creates new global config when none exists", () => {
      const sandbox = join(tmpdir(), `sf-global-new-${process.pid}-${Date.now()}`);
      const origHome = process.env.HOME;
      const origLocal = process.env.LOCALAPPDATA;
      process.env.HOME = sandbox;
      process.env.LOCALAPPDATA = sandbox;
      try {
        saveGlobalConfig({ retry: { maxRetries: 9 } });
        const cfgFile = process.platform === "win32"
          ? join(sandbox, "SoulForge", "config.json")
          : join(sandbox, ".soulforge", "config.json");
        const saved = JSON.parse(readFileSync(cfgFile, "utf-8"));
        expect(saved.retry?.maxRetries).toBe(9);
      } finally {
        if (origHome !== undefined) process.env.HOME = origHome;
        else delete process.env.HOME;
        if (origLocal !== undefined) process.env.LOCALAPPDATA = origLocal;
        else delete process.env.LOCALAPPDATA;
        rmSync(sandbox, { recursive: true, force: true });
      }
    });
  });
});
