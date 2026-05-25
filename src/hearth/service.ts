/**
 * Persistent-daemon service management. Installs / removes the platform-native
 * auto-start unit so `hearth start` survives reboot without manual launchctl /
 * systemctl dance.
 *
 * macOS: LaunchAgent plist under ~/Library/LaunchAgents/dev.soulforge.hearth.plist.
 *   Loaded via `launchctl bootstrap gui/<uid>` (modern) with `launchctl load`
 *   fallback for older macOS.
 *
 * Linux: systemd --user unit under ~/.config/systemd/user/soulforge-hearth.service.
 *   Enabled + started via `systemctl --user`. Requires lingering for boot-time
 *   start (loginctl enable-linger), which we note but don't auto-toggle.
 *
 * Windows: Task Scheduler user-scoped task under \SoulForge\SoulForgeHearth.
 *   Registered via PowerShell Register-ScheduledTask with -RunLevel Limited
 *   so no admin elevation is required. Restart-on-failure via -RestartCount.
 *
 * No shell injection: we write a literal config file with escaped paths, and
 * invoke launchctl/systemctl with fixed argv arrays.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { configDir } from "../core/platform/index.js";

export type ServicePlatform = "darwin" | "linux" | "windows" | "unsupported";

export interface ServiceStatus {
  platform: ServicePlatform;
  installed: boolean;
  unitPath: string;
  unitLabel: string;
  /** Best-effort — whether the unit is currently loaded/active. */
  active?: boolean;
  /** Last error from install/uninstall/status, if any. */
  error?: string;
}

export interface InstallOptions {
  /** Absolute path to the `soulforge` (or `bun`) binary. */
  cmd: string;
  /** Args appended to cmd. E.g. ["hearth", "start"] or ["<checkout>/src/boot.tsx", "hearth", "start"]. */
  args: string[];
  /** Where to send stdout/stderr. */
  logPath?: string;
  /** Where to send errors separately (default: alongside logPath). */
  errPath?: string;
}

export const MACOS_LABEL = "dev.soulforge.hearth";
export const LINUX_UNIT_NAME = "soulforge-hearth.service";

function currentPlatform(): ServicePlatform {
  const p = platform();
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  if (p === "win32") return "windows";
  return "unsupported";
  // ^ keep "win32" detection — node's os.platform() returns "win32" even on 64-bit and ARM64.
}

function macosPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${MACOS_LABEL}.plist`);
}

function linuxUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", LINUX_UNIT_NAME);
}

function defaultLogPath(): string {
  return join(configDir(), "hearth.log");
}

function defaultErrPath(): string {
  return join(configDir(), "hearth.err");
}

/** XML-escape a string for inclusion in an Apple plist. */
function plistEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function systemdEscape(s: string): string {
  return s.replace(/\\/g, "\\\\");
}

/** M6: quote an ExecStart argv token for systemd. Systemd reads the line
 *  whitespace-split; any arg containing a space, quote, backslash, `;`, or
 *  newline must be wrapped. Double-quotes escape `\` and `"`. Throws on an
 *  argument containing a literal newline (no way to represent safely). */
function systemdArg(s: string): string {
  if (/\n/.test(s)) {
    throw new Error("systemd ExecStart argument contains newline");
  }
  const esc = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${esc}"`;
}

/** Run a command with argv array, no shell. Returns {code, stdout, stderr}. */
function runCmd(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    proc.on("error", (err) => resolve({ code: 1, stdout, stderr: err.message }));
  });
}

function buildMacosPlist(opts: InstallOptions): string {
  const logPath = opts.logPath ?? defaultLogPath();
  const errPath = opts.errPath ?? defaultErrPath();
  const programArgs = [opts.cmd, ...opts.args];
  const argsXml = programArgs.map((a) => `    <string>${plistEscape(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistEscape(MACOS_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${plistEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${plistEscape(errPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TERM</key>
    <string>dumb</string>
    <key>NO_COLOR</key>
    <string>1</string>
    <key>SOULFORGE_NO_TTY</key>
    <string>1</string>
  </dict>
</dict>
</plist>
`;
}

function buildLinuxUnit(opts: InstallOptions): string {
  const logPath = opts.logPath ?? defaultLogPath();
  const errPath = opts.errPath ?? defaultErrPath();
  // M6: each argv token is individually quoted so paths with spaces or
  // other unit-directive-hostile characters can't inject. Prior form was
  // plain concatenation with a backslash-only escape — broke on any path
  // containing a space and permitted injection via `;` or newline.
  const execStart = [opts.cmd, ...opts.args].map(systemdArg).join(" ");
  return `[Unit]
Description=SoulForge Hearth daemon (remote surface bridge)
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=10
StandardOutput=append:${systemdEscape(logPath)}
StandardError=append:${systemdEscape(errPath)}
Environment=TERM=dumb NO_COLOR=1 SOULFORGE_NO_TTY=1

[Install]
WantedBy=default.target
`;
}

/** Install and enable the persistent service. Returns the final status. */
export async function installService(opts: InstallOptions): Promise<ServiceStatus> {
  const plat = currentPlatform();

  if (plat === "darwin") {
    const plistPath = macosPlistPath();
    try {
      mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(plistPath, buildMacosPlist(opts), { mode: 0o600 });

      // Unload first (idempotent — ignore failure) then load/bootstrap.
      const uid = userInfo().uid;
      const domain = `gui/${String(uid)}`;
      await runCmd("launchctl", ["bootout", domain, plistPath]);
      const boot = await runCmd("launchctl", ["bootstrap", domain, plistPath]);
      if (boot.code !== 0) {
        // Old macOS — fall back to launchctl load.
        const load = await runCmd("launchctl", ["load", "-w", plistPath]);
        if (load.code !== 0) {
          return {
            platform: plat,
            installed: true,
            unitPath: plistPath,
            unitLabel: MACOS_LABEL,
            error: `bootstrap failed: ${boot.stderr || boot.stdout}; load fallback: ${load.stderr || load.stdout}`,
          };
        }
      }
      return {
        platform: plat,
        installed: true,
        unitPath: plistPath,
        unitLabel: MACOS_LABEL,
        active: true,
      };
    } catch (err) {
      return {
        platform: plat,
        installed: existsSync(plistPath),
        unitPath: plistPath,
        unitLabel: MACOS_LABEL,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (plat === "linux") {
    const unitPath = linuxUnitPath();
    try {
      mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
      writeFileSync(unitPath, buildLinuxUnit(opts), { mode: 0o600 });

      await runCmd("systemctl", ["--user", "daemon-reload"]);
      const enable = await runCmd("systemctl", ["--user", "enable", "--now", LINUX_UNIT_NAME]);
      if (enable.code !== 0) {
        return {
          platform: plat,
          installed: true,
          unitPath,
          unitLabel: LINUX_UNIT_NAME,
          error: `systemctl enable failed: ${enable.stderr || enable.stdout}`,
        };
      }
      return {
        platform: plat,
        installed: true,
        unitPath,
        unitLabel: LINUX_UNIT_NAME,
        active: true,
      };
    } catch (err) {
      return {
        platform: plat,
        installed: existsSync(unitPath),
        unitPath,
        unitLabel: LINUX_UNIT_NAME,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (plat === "windows") {
    const unitPath = `${WINDOWS_TASK_PATH}${WINDOWS_TASK_NAME}`;
    const script = buildWindowsRegisterScript(opts);
    const result = await runPwsh(script);
    if (result.code !== 0) {
      return {
        platform: plat,
        installed: false,
        unitPath,
        unitLabel: WINDOWS_TASK_NAME,
        error: `Register-ScheduledTask failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }
    return {
      platform: plat,
      installed: true,
      unitPath,
      unitLabel: WINDOWS_TASK_NAME,
      active: true,
    };
  }

  return {
    platform: plat,
    installed: false,
    unitPath: "",
    unitLabel: "",
    error: "persistent service not supported on this platform",
  };
}

/** Disable + remove the persistent service unit. Daemon itself is left alone. */
export async function uninstallService(): Promise<ServiceStatus> {
  const plat = currentPlatform();

  if (plat === "darwin") {
    const plistPath = macosPlistPath();
    try {
      const uid = userInfo().uid;
      const domain = `gui/${String(uid)}`;
      await runCmd("launchctl", ["bootout", domain, plistPath]);
      // Old macOS fallback
      await runCmd("launchctl", ["unload", "-w", plistPath]);
      if (existsSync(plistPath)) unlinkSync(plistPath);
      return {
        platform: plat,
        installed: false,
        unitPath: plistPath,
        unitLabel: MACOS_LABEL,
        active: false,
      };
    } catch (err) {
      return {
        platform: plat,
        installed: existsSync(plistPath),
        unitPath: plistPath,
        unitLabel: MACOS_LABEL,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (plat === "linux") {
    const unitPath = linuxUnitPath();
    try {
      await runCmd("systemctl", ["--user", "disable", "--now", LINUX_UNIT_NAME]);
      if (existsSync(unitPath)) unlinkSync(unitPath);
      await runCmd("systemctl", ["--user", "daemon-reload"]);
      return {
        platform: plat,
        installed: false,
        unitPath,
        unitLabel: LINUX_UNIT_NAME,
        active: false,
      };
    } catch (err) {
      return {
        platform: plat,
        installed: existsSync(unitPath),
        unitPath,
        unitLabel: LINUX_UNIT_NAME,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (plat === "windows") {
    const unitPath = `${WINDOWS_TASK_PATH}${WINDOWS_TASK_NAME}`;
    const result = await runPwsh(buildWindowsUnregisterScript());
    if (result.code !== 0) {
      return {
        platform: plat,
        installed: false,
        unitPath,
        unitLabel: WINDOWS_TASK_NAME,
        error: `Unregister-ScheduledTask failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }
    return {
      platform: plat,
      installed: false,
      unitPath,
      unitLabel: WINDOWS_TASK_NAME,
      active: false,
    };
  }

  return {
    platform: plat,
    installed: false,
    unitPath: "",
    unitLabel: "",
    error: "persistent service not supported on this platform",
  };
}

/** Read current state without mutation. */
export async function getServiceStatus(): Promise<ServiceStatus> {
  const plat = currentPlatform();

  if (plat === "darwin") {
    const plistPath = macosPlistPath();
    const installed = existsSync(plistPath);
    if (!installed) {
      return { platform: plat, installed: false, unitPath: plistPath, unitLabel: MACOS_LABEL };
    }
    const uid = userInfo().uid;
    const list = await runCmd("launchctl", ["print", `gui/${String(uid)}/${MACOS_LABEL}`]);
    const active = list.code === 0 && /state = running/i.test(list.stdout);
    return { platform: plat, installed, unitPath: plistPath, unitLabel: MACOS_LABEL, active };
  }

  if (plat === "linux") {
    const unitPath = linuxUnitPath();
    const installed = existsSync(unitPath);
    if (!installed) {
      return { platform: plat, installed: false, unitPath, unitLabel: LINUX_UNIT_NAME };
    }
    const check = await runCmd("systemctl", ["--user", "is-active", LINUX_UNIT_NAME]);
    const active = check.code === 0 && check.stdout.trim() === "active";
    return { platform: plat, installed, unitPath, unitLabel: LINUX_UNIT_NAME, active };
  }

  if (plat === "windows") {
    const unitPath = `${WINDOWS_TASK_PATH}${WINDOWS_TASK_NAME}`;
    const result = await runPwsh(buildWindowsStatusScript());
    if (result.code !== 0) {
      return {
        platform: plat,
        installed: false,
        unitPath,
        unitLabel: WINDOWS_TASK_NAME,
        error: result.stderr.trim() || result.stdout.trim() || "Get-ScheduledTask failed",
      };
    }
    const lines = result.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const installed = lines[0] === "INSTALLED";
    // Task Scheduler 'State' values: Unknown(0) Disabled(1) Queued(2) Ready(3) Running(4)
    const state = (lines[1] ?? "").trim();
    const active = installed && (state === "Running" || state === "4");
    return { platform: plat, installed, unitPath, unitLabel: WINDOWS_TASK_NAME, active };
  }

  return { platform: plat, installed: false, unitPath: "", unitLabel: "" };
}
export const WINDOWS_TASK_NAME = "SoulForgeHearth";
export const WINDOWS_TASK_PATH = "\\SoulForge\\";
/**
 * PS1 single-quote escape — PowerShell single-quoted strings escape `'` as `''`
 * and treat everything else (including `$`, `\`, `"`) literally. Safe for
 * untrusted paths and arguments. Backticks and `$()` are inert in single quotes.
 */
function psEscape(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
/**
 * Build the PowerShell script that registers the SoulForge Hearth scheduled
 * task. Exported for testing — generation is pure and platform-independent so
 * we can validate the output on any host.
 *
 * Why Task Scheduler over NSSM / sc.exe:
 *   - No admin required for user-scoped tasks (-RunLevel Limited)
 *   - Built into every supported Windows version, no bundled deps
 *   - Mirrors the macOS LaunchAgent / Linux systemd --user model
 *   - Restart-on-failure via -RestartCount + -RestartInterval
 *
 * Reference: https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/register-scheduledtask
 */
/** Quote a single argument for Windows command-line parsing (msvcrt rules):
 * wrap in double quotes when it contains whitespace or quotes, double up
 * trailing backslashes before the closing quote, and escape embedded quotes. */
function quoteWindowsCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let escaped = "";
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      escaped += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    escaped += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  escaped += "\\".repeat(backslashes * 2);
  return `"${escaped}"`;
}

export function buildWindowsRegisterScript(opts: InstallOptions): string {
  const exe = psEscape(opts.cmd);
  // Each argv element gets Windows-quoted to preserve argv boundaries when
  // ScheduledTaskAction passes -Argument as a single command-line string.
  const args = psEscape(opts.args.map(quoteWindowsCmdArg).join(" "));
  const wd = psEscape(dirname(opts.cmd));
  const taskName = psEscape(WINDOWS_TASK_NAME);
  const taskPath = psEscape(WINDOWS_TASK_PATH);

  return [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute ${exe} -Argument ${args} -WorkingDirectory ${wd}`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
    "$settings = New-ScheduledTaskSettingsSet " +
      "-AllowStartIfOnBatteries " +
      "-DontStopIfGoingOnBatteries " +
      "-StartWhenAvailable " +
      "-RestartCount 3 " +
      "-RestartInterval (New-TimeSpan -Minutes 1) " +
      "-ExecutionTimeLimit (New-TimeSpan -Hours 0)",
    "$principal = New-ScheduledTaskPrincipal " +
      "-UserId $env:USERNAME " +
      "-LogonType Interactive " +
      "-RunLevel Limited",
    `Register-ScheduledTask -TaskName ${taskName} -TaskPath ${taskPath} ` +
      "-Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null",
    `Start-ScheduledTask -TaskName ${taskName} -TaskPath ${taskPath}`,
  ].join("\n");
}
/** PS1 to unregister the scheduled task. Idempotent — succeeds even if absent. */
export function buildWindowsUnregisterScript(): string {
  const taskName = psEscape(WINDOWS_TASK_NAME);
  const taskPath = psEscape(WINDOWS_TASK_PATH);
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Stop-ScheduledTask -TaskName ${taskName} -TaskPath ${taskPath}`,
    `Unregister-ScheduledTask -TaskName ${taskName} -TaskPath ${taskPath} -Confirm:$false`,
    // Always exit 0 — uninstall is best-effort.
    "exit 0",
  ].join("\n");
}
/** PS1 to query the task; emits two lines: "INSTALLED|MISSING" then state name. */
export function buildWindowsStatusScript(): string {
  const taskName = psEscape(WINDOWS_TASK_NAME);
  const taskPath = psEscape(WINDOWS_TASK_PATH);
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$t = Get-ScheduledTask -TaskName ${taskName} -TaskPath ${taskPath}`,
    "if ($null -eq $t) { Write-Output 'MISSING'; Write-Output ''; exit 0 }",
    "Write-Output 'INSTALLED'",
    `$info = Get-ScheduledTaskInfo -TaskName ${taskName} -TaskPath ${taskPath}`,
    "Write-Output $t.State",
  ].join("\n");
}
/** Run a PS1 script with -Command — argv form, no shell interpolation. */
function runPwsh(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  // PowerShell 5.1 (`powershell`) ships on every supported Windows; PS 7
  // (`pwsh`) is optional. Prefer `powershell` for the widest compatibility.
  return runCmd("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
}
