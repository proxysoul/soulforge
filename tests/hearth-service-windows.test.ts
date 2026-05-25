/**
 * Task Scheduler PS1 generation tests. Pure-function tests — run on every host.
 * The actual install/uninstall round-trip is gated on a real Windows VM.
 */

import { describe, expect, test } from "bun:test";
import {
  buildWindowsRegisterScript,
  buildWindowsStatusScript,
  buildWindowsUnregisterScript,
  WINDOWS_TASK_NAME,
  WINDOWS_TASK_PATH,
} from "../src/hearth/service.js";

describe("hearth windows: register script", () => {
  test("happy path: builds a Register-ScheduledTask invocation", () => {
    const ps = buildWindowsRegisterScript({
      cmd: "C:\\Users\\dev\\AppData\\Local\\SoulForge\\bin\\soulforge.exe",
      args: ["hearth", "start"],
    });
    expect(ps).toContain("Register-ScheduledTask");
    expect(ps).toContain("New-ScheduledTaskAction");
    expect(ps).toContain("New-ScheduledTaskTrigger -AtLogOn");
    expect(ps).toContain("New-ScheduledTaskSettingsSet");
    expect(ps).toContain("-RestartCount 3");
    expect(ps).toContain("-RunLevel Limited");
    // Args joined as a single string per New-ScheduledTaskAction's contract.
    expect(ps).toContain("'hearth start'");
    // Task lives under the SoulForge subfolder so user-scope cleanup is scoped.
    expect(ps).toContain(`'${WINDOWS_TASK_PATH}'`);
    expect(ps).toContain(`'${WINDOWS_TASK_NAME}'`);
    // Always starts after register so the user doesn't need to log out first.
    expect(ps).toContain("Start-ScheduledTask");
  });

  test("escapes single quotes in paths to prevent PowerShell injection", () => {
    const ps = buildWindowsRegisterScript({
      cmd: "C:\\Users\\Dave's PC\\soulforge.exe",
      args: ["hearth", "start"],
    });
    // PowerShell single-quoted strings escape ' as ''. The backslashes
    // and quotes the attacker might try to slip in are inert.
    expect(ps).toContain("'C:\\Users\\Dave''s PC\\soulforge.exe'");
    expect(ps).not.toContain("$(");
    expect(ps).not.toContain("`;");
  });

  test("treats $ in paths as literal (single-quoted)", () => {
    const ps = buildWindowsRegisterScript({
      cmd: "C:\\$env:windir\\soulforge.exe",
      args: [],
    });
    // The literal $env appears in a single-quoted string so PowerShell will
    // NOT expand it. Verify by asserting that the literal char sequence is
    // present inside a quote pair.
    expect(ps).toContain("'C:\\$env:windir\\soulforge.exe'");
  });

  test("empty args produces a valid Argument (empty string)", () => {
    const ps = buildWindowsRegisterScript({
      cmd: "C:\\soulforge.exe",
      args: [],
    });
    expect(ps).toContain("-Argument ''");
  });
});

describe("hearth windows: unregister script", () => {
  test("targets the right task and is idempotent", () => {
    const ps = buildWindowsUnregisterScript();
    expect(ps).toContain("Unregister-ScheduledTask");
    expect(ps).toContain("-Confirm:$false");
    expect(ps).toContain(`'${WINDOWS_TASK_NAME}'`);
    expect(ps).toContain(`'${WINDOWS_TASK_PATH}'`);
    // SilentlyContinue + exit 0 → best-effort, never bubbles a failure.
    expect(ps).toContain("$ErrorActionPreference = 'SilentlyContinue'");
    expect(ps).toContain("exit 0");
  });
});

describe("hearth windows: status script", () => {
  test("emits INSTALLED/MISSING marker then state", () => {
    const ps = buildWindowsStatusScript();
    expect(ps).toContain("Get-ScheduledTask");
    expect(ps).toContain("Write-Output 'INSTALLED'");
    expect(ps).toContain("Write-Output 'MISSING'");
    expect(ps).toContain("$t.State");
    expect(ps).toContain(`'${WINDOWS_TASK_NAME}'`);
    expect(ps).toContain(`'${WINDOWS_TASK_PATH}'`);
  });
});

describe("hearth windows: task identity", () => {
  test("name and path are stable across the codebase", () => {
    // These are the strings users see in `schtasks /query` output and in
    // the Task Scheduler MMC. Changing them silently would orphan installed
    // tasks from older releases — bump explicitly if you must.
    expect(WINDOWS_TASK_NAME).toBe("SoulForgeHearth");
    expect(WINDOWS_TASK_PATH).toBe("\\SoulForge\\");
  });
});
