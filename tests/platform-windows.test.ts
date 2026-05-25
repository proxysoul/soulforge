/**
 * Cross-platform shim sanity tests for src/core/platform/.
 *
 * These tests run on every platform — POSIX hosts validate the POSIX branches,
 * Windows hosts validate the win32 branches. The DPAPI roundtrip is gated
 * behind process.platform === "win32" because crypt32.dll is Windows-only.
 */

import { describe, expect, test } from "bun:test";
import {
  CMD_EXT,
  commandExists,
  configDir,
  dataDir,
  EXE,
  findOnPath,
  ghosttyDisabled,
  IS_DARWIN,
  IS_LINUX,
  IS_WIN,
  masonBinDir,
  shellInvocation,
  tmpDir,
  userDataDir,
} from "../src/core/platform/index.js";
import { makeIpcSocketPath, shouldCleanupSocketFile } from "../src/core/platform/socket.js";
import {
  extractArchive,
  extractTarGz,
  extractZip,
} from "../src/core/platform/archive.js";

describe("platform shim: identity", () => {
  test("exactly one platform flag is true", () => {
    const flags = [IS_WIN, IS_DARWIN, IS_LINUX].filter(Boolean);
    expect(flags.length).toBe(1);
  });

  test("EXE suffix matches platform", () => {
    expect(EXE).toBe(IS_WIN ? ".exe" : "");
  });

  test("CMD_EXT suffix matches platform", () => {
    expect(CMD_EXT).toBe(IS_WIN ? ".cmd" : "");
  });
});

describe("platform shim: paths", () => {
  test("tmpDir returns a non-empty string", () => {
    expect(tmpDir().length).toBeGreaterThan(0);
  });

  test("configDir is platform-appropriate", () => {
    const dir = configDir();
    if (IS_WIN) {
      // %APPDATA%\SoulForge
      expect(dir.toLowerCase()).toContain("appdata");
      expect(dir).toContain("SoulForge");
    } else {
      expect(dir.endsWith(".soulforge")).toBe(true);
    }
  });

  test("dataDir is platform-appropriate", () => {
    const dir = dataDir();
    if (IS_WIN) {
      // %LOCALAPPDATA%\SoulForge
      expect(dir.toLowerCase()).toMatch(/local|appdata/);
      expect(dir).toContain("SoulForge");
    } else {
      expect(dir.endsWith(".soulforge")).toBe(true);
    }
  });

  test("masonBinDir is platform-appropriate", () => {
    const dir = masonBinDir();
    if (IS_WIN) {
      expect(dir).toContain("nvim-data");
      expect(dir).toContain("mason");
    } else {
      expect(dir).toContain(".local/share/nvim/mason/bin");
    }
  });
});

describe("platform shim: shell", () => {
  test("shellInvocation returns the right shell", () => {
    const { cmd, flag } = shellInvocation();
    if (IS_WIN) {
      expect(cmd.toLowerCase()).toContain("cmd");
      expect(flag).toContain("/c");
    } else {
      expect(cmd).toBe("sh");
      expect(flag).toBe("-c");
    }
  });
});

describe("platform shim: socket paths", () => {
  test("makeIpcSocketPath produces a named pipe on Windows", () => {
    const p = makeIpcSocketPath("sf-test-12345");
    if (IS_WIN) {
      expect(p.startsWith("\\\\.\\pipe\\")).toBe(true);
      expect(p).toContain("sf-test-12345");
    } else {
      expect(p.endsWith(".sock")).toBe(true);
      expect(p).toContain("sf-test-12345");
    }
  });

  test("makeIpcSocketPath sanitises label", () => {
    const p = makeIpcSocketPath("sf/dangerous\\label");
    // Path separators must not survive — they'd let an attacker escape the
    // pipe/UDS namespace.
    if (IS_WIN) {
      const labelPart = p.slice("\\\\.\\pipe\\".length);
      expect(labelPart.includes("/")).toBe(false);
      expect(labelPart.includes("\\")).toBe(false);
    } else {
      // POSIX: only the tail (after tmpdir) should be sanitised.
      const tail = p.split("/").pop() ?? "";
      expect(tail.includes("\\")).toBe(false);
    }
  });

  test("shouldCleanupSocketFile matches platform", () => {
    expect(shouldCleanupSocketFile()).toBe(!IS_WIN);
  });
});

describe("platform shim: ghosttyDisabled", () => {
  test("false on non-Windows", () => {
    if (IS_WIN) return;
    expect(ghosttyDisabled()).toBe(false);
  });

  test("true on Windows ARM64 regardless of env opt-in", () => {
    if (!IS_WIN || process.arch !== "arm64") return;
    const orig = process.env.SOULFORGE_ENABLE_GHOSTTY;
    process.env.SOULFORGE_ENABLE_GHOSTTY = "1";
    try {
      expect(ghosttyDisabled()).toBe(true);
    } finally {
      if (orig !== undefined) process.env.SOULFORGE_ENABLE_GHOSTTY = orig;
      else delete process.env.SOULFORGE_ENABLE_GHOSTTY;
    }
  });
});

describe("platform shim: PATH probes", () => {
  test("commandExists returns true for a baseline tool", () => {
    const probe = IS_WIN ? ["cmd", "where"] : ["sh", "ls"];
    const found = probe.some((c) => commandExists(c));
    expect(found).toBe(true);
  });

  test("findOnPath returns null for an impossible binary", () => {
    expect(findOnPath("definitely-not-a-real-binary-xyzzy-123")).toBeNull();
  });
});

describe("platform shim: HOME-honouring paths", () => {
  test("configDir respects process.env.HOME on POSIX", () => {
    if (IS_WIN) return;
    const orig = process.env.HOME;
    process.env.HOME = "/tmp/sf-test-home-config";
    try {
      expect(configDir()).toBe("/tmp/sf-test-home-config/.soulforge");
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
      else delete process.env.HOME;
    }
  });

  test("dataDir respects process.env.HOME on POSIX", () => {
    if (IS_WIN) return;
    const orig = process.env.HOME;
    process.env.HOME = "/tmp/sf-test-home-data";
    try {
      expect(dataDir()).toBe("/tmp/sf-test-home-data/.soulforge");
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
      else delete process.env.HOME;
    }
  });

  test("userDataDir respects process.env.HOME on POSIX", () => {
    if (IS_WIN) return;
    const orig = process.env.HOME;
    process.env.HOME = "/tmp/sf-test-home-userdata";
    try {
      expect(userDataDir()).toBe("/tmp/sf-test-home-userdata/.local/share/soulforge");
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
      else delete process.env.HOME;
    }
  });
});

describe("platform shim: archive dispatcher", () => {
  test("extractArchive rejects unknown extensions", () => {
    const r = extractArchive("/tmp/foo.weirdformat", "/tmp");
    expect(r.success).toBe(false);
    expect(r.error ?? "").toMatch(/unsupported/i);
  });

  test("extractTarGz / extractZip exist and are callable", () => {
    // Smoke — just ensure the functions are wired. Real extraction runs on
    // platforms that have tar.exe / tar / unzip available.
    expect(typeof extractTarGz).toBe("function");
    expect(typeof extractZip).toBe("function");
  });
});

describe("platform shim: keychain (Windows only)", () => {
  test.if(IS_WIN)("DPAPI roundtrip via crypt32.dll", async () => {
    const { windowsKeychainSet, windowsKeychainGet, windowsKeychainDelete } = await import(
      "../src/core/platform/keychain.js"
    );
    const key = `test-key-${Date.now()}`;
    const value = `secret-${Math.random().toString(36).slice(2)}`;
    const ok = windowsKeychainSet(key, value);
    expect(ok).toBe(true);
    const read = windowsKeychainGet(key);
    expect(read).toBe(value);
    const deleted = windowsKeychainDelete(key);
    expect(deleted).toBe(true);
    expect(windowsKeychainGet(key)).toBeNull();
  });

  test.if(!IS_WIN)("windowsKeychainGet returns null on non-Windows", async () => {
    const { windowsKeychainGet, windowsKeychainAvailable } = await import(
      "../src/core/platform/keychain.js"
    );
    expect(windowsKeychainAvailable()).toBe(false);
    expect(windowsKeychainGet("anything")).toBeNull();
  });
});

describe("platform shim: cross-OS parity helpers", () => {
  test("localAppData returns the raw LOCALAPPDATA on win32, null elsewhere", async () => {
    const { localAppData } = await import("../src/core/platform/index.js");
    const r = localAppData();
    if (IS_WIN) {
      // Redirected/customised profiles can point anywhere — assert against env, not a substring.
      expect(r).toBe(process.env.LOCALAPPDATA ?? null);
    } else {
      expect(r).toBeNull();
    }
  });

  test("expandHome expands ~/ on every platform", async () => {
    const { expandHome } = await import("../src/core/platform/index.js");
    const r = expandHome("~/foo");
    expect(r.endsWith("foo") || r.endsWith("foo".replace("/", "\\"))).toBe(true);
    expect(r.includes("~")).toBe(false);
  });

  test("expandHome leaves unrelated paths unchanged", async () => {
    const { expandHome } = await import("../src/core/platform/index.js");
    expect(expandHome("/etc/passwd")).toBe("/etc/passwd");
    expect(expandHome("relative/path")).toBe("relative/path");
    expect(expandHome("")).toBe("");
  });

  test("expandHome on win32 also expands ~\\\\", async () => {
    if (!IS_WIN) return;
    const { expandHome } = await import("../src/core/platform/index.js");
    const r = expandHome("~\\foo");
    expect(r.includes("~")).toBe(false);
    expect(r.endsWith("foo")).toBe(true);
  });

  test("xdgConfigHome routes per platform", async () => {
    const { xdgConfigHome } = await import("../src/core/platform/index.js");
    const r = xdgConfigHome();
    if (IS_WIN) {
      // APPDATA may be redirected; honor the env value verbatim.
      expect(r).toBe(process.env.APPDATA ?? r);
    } else {
      expect(r.length).toBeGreaterThan(0);
    }
  });

  test("userFontDir is per-user, never empty", async () => {
    const { userFontDir } = await import("../src/core/platform/index.js");
    expect(userFontDir().length).toBeGreaterThan(0);
  });

  test("systemFontDirs starts with the per-user dir", async () => {
    const { userFontDir, systemFontDirs } = await import("../src/core/platform/index.js");
    const dirs = systemFontDirs();
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs[0]).toBe(userFontDir());
  });
});
