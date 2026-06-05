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

  test("windowsPath is a no-op on POSIX", async () => {
    if (IS_WIN) return;
    const { windowsPath } = await import("../src/core/platform/index.js");
    expect(windowsPath("/home/user/file")).toBe("/home/user/file");
    expect(windowsPath("")).toBe("");
  });

  test("windowsPath translates Git Bash / Cygwin / WSL prefixes on win32", async () => {
    if (!IS_WIN) return;
    const { windowsPath } = await import("../src/core/platform/index.js");
    expect(windowsPath("/c/Users/me")).toBe("C:/Users/me");
    expect(windowsPath("/cygdrive/c/Users/me")).toBe("C:/Users/me");
    expect(windowsPath("/mnt/c/Users/me")).toBe("C:/Users/me");
    expect(windowsPath("C:/Users/me")).toBe("C:/Users/me");
  });

  test("matchGlob handles separator differences", async () => {
    const { matchGlob } = await import("../src/core/platform/index.js");
    expect(matchGlob("a/b/c.env", "**/*.env")).toBe(true);
    expect(matchGlob("a\\b\\c.env", "**/*.env")).toBe(true);
    expect(matchGlob("a/b/c.txt", "**/*.env")).toBe(false);
    expect(matchGlob("", "**/*.env")).toBe(false);
  });

  test("matchGlob is case-insensitive on win32, exact on POSIX", async () => {
    const { matchGlob } = await import("../src/core/platform/index.js");
    if (IS_WIN) {
      expect(matchGlob("C:/Users/Me/.ENV", "**/.env")).toBe(true);
    } else {
      expect(matchGlob("a/b/.ENV", "**/.env")).toBe(false);
      expect(matchGlob("a/b/.env", "**/.env")).toBe(true);
    }
  });

  test("canonicalPath is a no-op on POSIX", async () => {
    if (IS_WIN) return;
    const { canonicalPath } = await import("../src/core/platform/index.js");
    expect(canonicalPath("/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("platform shim: console (Windows TTY only)", () => {
  test("console helpers are callable + no-op on non-Windows / non-TTY", async () => {
    const m = await import("../src/core/platform/console-win32.js");
    expect(typeof m.disableProcessedInput).toBe("function");
    expect(typeof m.flushInputBuffer).toBe("function");
    expect(typeof m.installCtrlCGuard).toBe("function");
    m.disableProcessedInput();
    m.flushInputBuffer();
    const unhook = m.installCtrlCGuard();
    if (!IS_WIN) expect(unhook).toBeUndefined();
    if (unhook) unhook();
  });
});

describe("clipboard image read on Windows", () => {
  // Source-level guard: keep this contract even though the implementation
  // moved from per-paste `execFile` to a persistent `spawn` daemon. If a
  // future refactor reverts to `-OutFile <path>` argv tricks, the test
  // surfaces the regression on POSIX hosts without needing a Windows runner.
  if (!IS_WIN) {
    test("contract: no -OutFile/WriteAllBytes path in source (uses daemon)", async () => {
      const src = await Bun.file(
        new URL("../src/core/platform/clipboard.ts", import.meta.url),
      ).text();
      // The old (broken) pattern: param([Parameter(Mandatory)][string]$OutFile)
      // followed by argv `..., "-OutFile", tmpFile`. Either side is suspect
      // on its own; both together is the bug.
      expect(src).not.toMatch(/param\(\[Parameter\(Mandatory\)\]\[string\]\$OutFile\)/);
      expect(src).not.toMatch(/"-OutFile",\s*tmpFile/);
      // The persistent daemon writes base64 to stdout instead of a temp file.
      expect(src).toMatch(/WindowsClipboardDaemon|startClipboardDaemon/);
    });
    return;
  }

  test("regression: in-flight reuse — concurrent calls share one read", async () => {
    // Windows Terminal fires BOTH a keydown and a bracketed-paste event for
    // the same Ctrl+V. The InputBox keydown handler and paste-event listener
    // both call readClipboardImage(). Without a module-level in-flight cache,
    // both callers would each send `READ` to the daemon — the daemon
    // serialises one-at-a-time, so the second blocks until the first
    // completes (~100-200ms). Sharing the in-flight promise collapses both
    // into a single round-trip.
    const { mock } = await import("bun:test");
    const cp = await import("node:child_process");
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");

    const fakePng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);

    // Per-test state — every fakeSpawn invocation gets fresh streams, so
    // each call to readClipboardImage() that needs a respawn starts from
    // READY again. The first test call uses a delayed response to expose
    // the in-flight cache.
    let readCount = 0;
    const makeFakeProc = () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const emitter = new EventEmitter();
      // Pretend PS is already past the Add-Type JIT and emit READY on the
      // next tick. The daemon's onStdout handler resolves start() on the
      // first line — so without this the test hangs.
      queueMicrotask(() => stdout.write("READY\n"));
      // On every READ\n on stdin, write back an OK response one tick later.
      // (one-tick delay is the compressed analogue of the real ~100-200ms
      // PowerShell round-trip; enough to keep p1's in-flight pending while
      // p2 is queued.)
      stdin.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.includes("READ")) {
          readCount++;
          queueMicrotask(() => {
            stdout.write(`OK ${fakePng.toString("base64")}\nEND\n`);
          });
        }
      });
      const proc = Object.assign(emitter, {
        stdin,
        stdout,
        stderr,
        pid: 0,
        kill: () => {
          queueMicrotask(() => emitter.emit("exit", null, "SIGTERM"));
          return true;
        },
      });
      return proc;
    };

    // Track every spawn() call so we can assert how many daemons were started.
    let spawnCount = 0;
    const fakeSpawn = (..._args: unknown[]) => {
      spawnCount++;
      return makeFakeProc();
    };

    mock.module("node:child_process", () => ({
      ...cp,
      spawn: fakeSpawn,
    }));

    try {
      const { readClipboardImage } = await import(
        `../src/core/platform/clipboard.ts?t=${Date.now()}`
      );
      // Fire two concurrent reads. The dispatcher must collapse the second
      // into the first's in-flight promise — only one READ reaches the
      // daemon's stdin.
      const p1 = readClipboardImage();
      // Yield so p1's async dispatcher reaches `await this.start()` and
      // sends READ before p2 runs. Without this, both run synchronously
      // and p2 sees `inFlightImage` still undefined.
      await Promise.resolve();
      const p2 = readClipboardImage();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(spawnCount).toBe(1);
      expect(readCount).toBe(1);
      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      // Both promises resolve to the same result object — same in-flight ref.
      expect(r1).toBe(r2);

      // After the in-flight settles, the cache must be cleared so the next
      // genuine paste can re-run (a fresh READ to the same daemon).
      const p3 = readClipboardImage();
      const r3 = await p3;
      expect(readCount).toBe(2);
      expect(r3).not.toBeNull();
      // p3 should be a new result object (not the in-flight cache).
      expect(r3).not.toBe(r1);
    } finally {
      mock.restore();
    }
  });

  test("regression: daemon waits for READY before serving reads", async () => {
    // Without the READY sentinel, the first read would race with PS's
    // Add-Type JIT. If the daemon resolved start() on spawn() return, the
    // caller would write `READ` to a PS that hasn't loaded the clipboard
    // assembly yet — GetImage() throws, the daemon returns NO, and the
    // image appears to be missing.
    const { mock } = await import("bun:test");
    const cp = await import("node:child_process");
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");

    const fakePng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const emitter = new EventEmitter();

    // Deliberately delay READY by 50ms — long enough that the read() call
    // would block on start() if start() correctly waits for the sentinel.
    // If start() were to resolve eagerly, the test would record READ
    // arriving before READY, surfacing the race.
    setTimeout(() => stdout.write("READY\n"), 50);

    let readSeen = false;
    stdin.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("READ")) {
        readSeen = true;
        queueMicrotask(() => {
          stdout.write(`OK ${fakePng.toString("base64")}\nEND\n`);
        });
      }
    });

    const fakeSpawn = () =>
      Object.assign(emitter, {
        stdin,
        stdout,
        stderr,
        pid: 0,
        kill: () => true,
      });

    mock.module("node:child_process", () => ({ ...cp, spawn: fakeSpawn }));

    try {
      const { readClipboardImage } = await import(
        `../src/core/platform/clipboard.ts?t=${Date.now()}`
      );
      const t0 = Date.now();
      const result = await readClipboardImage();
      const elapsed = Date.now() - t0;

      expect(result).not.toBeNull();
      expect(result?.mediaType).toBe("image/png");
      // READ must arrive only AFTER READY was emitted, so it must take
      // >= ~45ms (the READY delay minus timing jitter).
      expect(readSeen).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(40);
    } finally {
      mock.restore();
    }
  });

  test("regression: daemon respawns after process exit", async () => {
    // If the PowerShell process dies mid-session (e.g. user kills it,
    // machine goes to sleep, the PS host crashes), the next read should
    // transparently respawn — not hang on a dead pipe.
    //
    // Test tactic: fake spawn() emits `exit` on its emitter 50ms after
    // the fake proc starts. The first read's start() resolves on READY,
    // the proc stays alive long enough to respond, then exits. The
    // second read respawns to recover from the dead pipe.
    const { mock } = await import("bun:test");
    const cp = await import("node:child_process");
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");

    const fakePng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);

    let spawnCount = 0;
    const fakeSpawn = () => {
      spawnCount++;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const emitter = new EventEmitter();
      queueMicrotask(() => stdout.write("READY\n"));
      stdin.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("READ")) {
          queueMicrotask(() => {
            stdout.write(`OK ${fakePng.toString("base64")}\nEND\n`);
          });
        }
      });
      // Let the first read complete, THEN kill the proc. The next read
      // must respawn to recover from the dead pipe.
      setTimeout(() => {
        emitter.emit("exit", null, null);
      }, 50);
      return Object.assign(emitter, {
        stdin,
        stdout,
        stderr: new PassThrough(),
        pid: 0,
        kill: () => true,
      });
    };

    mock.module("node:child_process", () => ({ ...cp, spawn: fakeSpawn }));

    try {
      const { readClipboardImage } = await import(
        `../src/core/platform/clipboard.ts?t=${Date.now()}`
      );
      // First read — spawns, READY fires, READ gets a response, r1
      // resolves. The fake proc is still alive at this point.
      const r1 = await readClipboardImage();
      expect(r1).not.toBeNull();
      expect(spawnCount).toBe(1);

      // Wait for the fake proc's setTimeout(50ms) to fire and emit exit.
      // Until then the daemon is still "alive" and the next read would
      // happily reuse it.
      await new Promise((r) => setTimeout(r, 80));

      // Second read — the daemon is dead, so a new spawn must happen.
      const r2 = await readClipboardImage();
      expect(r2).not.toBeNull();
      expect(spawnCount).toBe(2);
    } finally {
      mock.restore();
    }
  });
});
