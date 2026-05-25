# SoulForge Windows Installer
#
# Usage:
#   powershell -c "irm https://soulforge.dev/install.ps1 | iex"
#
# Or with options:
#   $env:SOULFORGE_VERSION = "2.16.0"; irm https://soulforge.dev/install.ps1 | iex
#   $env:SOULFORGE_INSTALL_DIR = "C:\Tools\SoulForge\bin"; irm https://soulforge.dev/install.ps1 | iex
#   $env:SOULFORGE_NO_PATH = "1"; irm https://soulforge.dev/install.ps1 | iex
#
# Pattern follows Bun's install.ps1 (https://bun.sh/install.ps1) and
# Deno's install.ps1 (https://deno.land/install.ps1):
#   - User-scoped install to %LOCALAPPDATA%\SoulForge\bin (no admin required)
#   - Architecture-aware download from GitHub Releases
#   - PATH update at User scope via [Environment]::SetEnvironmentVariable
#   - Idempotent: rerun = upgrade
#   - TLS 1.2 forced for older Windows 10 builds
#
# `irm | iex` cannot pass named parameters to the script — we read env vars
# instead. `iex` evaluates the script body, not a function call.

$ErrorActionPreference = "Stop"

# ── Read configuration from environment ─────────────────────────────
$Version       = $env:SOULFORGE_VERSION
$InstallDir    = $env:SOULFORGE_INSTALL_DIR
$NoPathUpdate  = $env:SOULFORGE_NO_PATH -eq "1"

# ── PowerShell version check ────────────────────────────────────────
# 5.1 is the floor — it ships with Windows 10 1607+ and is required for the
# Invoke-RestMethod features we use. PowerShell 7 (`pwsh`) is fine but not
# required.
if ($PSVersionTable.PSVersion.Major -lt 5 -or `
   ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -lt 1)) {
    Write-Error @"
SoulForge installer requires PowerShell 5.1 or newer.
You have $($PSVersionTable.PSVersion).
Upgrade Windows PowerShell: https://aka.ms/powershell
"@
    exit 1
}

# ── TLS 1.2 ─────────────────────────────────────────────────────────
# Older Windows 10 builds default to TLS 1.0; GitHub API rejects that.
try {
    [System.Net.ServicePointManager]::SecurityProtocol =
        [System.Net.ServicePointManager]::SecurityProtocol -bor
        [System.Net.SecurityProtocolType]::Tls12
} catch {
    Write-Warning "Could not enforce TLS 1.2 — your PowerShell may be too old."
}

# ── Architecture detection ──────────────────────────────────────────
# PROCESSOR_ARCHITECTURE is what the running shell sees; on ARM64 Windows it
# may report "AMD64" if running in an x64 emulation host, so we also probe
# PROCESSOR_ARCHITEW6432 (the wow64 redirect tells us the real host CPU).
$arch = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }

switch ($arch) {
    "AMD64" { $assetArch = "x64" }
    "ARM64" {
        Write-Error @"
SoulForge v1 ships Windows x64 only.
Windows ARM64 support is tracked at https://github.com/proxysoul/soulforge — your
ghostty-opentui native dep needs an ARM64 build before we can ship.
Workaround: use the x64 build under Windows-on-ARM emulation (set
`$env:PROCESSOR_ARCHITEW6432='AMD64' before rerunning this installer).
"@
        exit 1
    }
    default {
        Write-Error "Unsupported architecture: $arch (need AMD64)"
        exit 1
    }
}

# Raw .exe name (legacy fallback, pre-v1.1).
$rawExeName = "soulforge-windows-$assetArch.exe"

# ── Defaults ────────────────────────────────────────────────────────
if (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA "SoulForge\bin"
}
$exePath = Join-Path $InstallDir "soulforge.exe"

Write-Host ""
Write-Host "  SoulForge installer" -ForegroundColor Cyan
Write-Host "  ───────────────────"
Write-Host "  arch       : $assetArch"
Write-Host "  install to : $InstallDir"

# ── Resolve version ─────────────────────────────────────────────────
$repo = "proxysoul/soulforge"

if (-not $Version) {
    Write-Host "  version    : (resolving latest)"
    try {
        $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" `
            -Headers @{ "User-Agent" = "soulforge-installer" } `
            -TimeoutSec 30
        $Version = $latest.tag_name -replace '^v', ''
    } catch {
        Write-Error "Failed to query latest release: $_"
        exit 1
    }
}

# Strip a leading "v" — env override accepts both `2.16.0` and `v2.16.0`.
$Version = $Version -replace '^v', ''

Write-Host "  version    : $Version"
Write-Host ""

# Asset is a zip bundle: soulforge.exe + deps/ tree (native dll, workers, wasm).
# A raw .exe would launch and immediately fail with "native runtime missing"
# because bun --compile cannot embed .dll / .node addons.
# Built AFTER $Version resolves — otherwise unset SOULFORGE_VERSION → stale name.
$assetName = "soulforge-$Version-windows-$assetArch.zip"
$downloadUrl = "https://github.com/$repo/releases/download/v$Version/$assetName"

# ── Download ────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "soulforge-$Version-$assetArch"
$tmpZip = "$tmpDir.zip"
if (Test-Path $tmpZip) { Remove-Item $tmpZip -Force }
if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }

Write-Host "  downloading $assetName..." -ForegroundColor Gray
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpZip -UseBasicParsing -TimeoutSec 600
} catch {
    # Fallback: older releases ship raw .exe (pre-v1.1). Try that pattern once.
    $legacyUrl = "https://github.com/$repo/releases/download/v$Version/$rawExeName"
    Write-Host "  zip not found, trying legacy .exe asset..." -ForegroundColor Yellow
    try {
        $legacyFile = Join-Path ([System.IO.Path]::GetTempPath()) "soulforge-$Version-$assetArch.exe"
        Invoke-WebRequest -Uri $legacyUrl -OutFile $legacyFile -UseBasicParsing -TimeoutSec 600
        Write-Warning "Downloaded raw .exe without bundled native runtime — the binary will fail with 'native runtime missing' on first launch. Upgrade to a release that ships $assetName."
        Move-Item $legacyFile $exePath -Force
        Unblock-File -Path $exePath -ErrorAction SilentlyContinue
        Write-Host "  installed legacy .exe (incomplete runtime) at $exePath" -ForegroundColor Yellow
        exit 0
    } catch {
        Write-Error "Download failed for both $assetName and $rawExeName at $downloadUrl"
        exit 1
    }
}

# ── Verify (size sanity check) ──────────────────────────────────────
# Real signature verification lands when we add Azure Trusted Signing in v1.1.
# Until then a size check catches truncated downloads / proxy failures.
$size = (Get-Item $tmpZip).Length
if ($size -lt 1048576) {
    Write-Error "Downloaded file is suspiciously small ($size bytes). Aborting."
    Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
    exit 1
}

# ── Extract ─────────────────────────────────────────────────────────
Write-Host "  extracting..." -ForegroundColor Gray
Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force

# Layout inside the zip: soulforge.exe at root, deps/ alongside.
$bundleExe = Join-Path $tmpDir "soulforge.exe"
$bundleDeps = Join-Path $tmpDir "deps"
if (-not (Test-Path $bundleExe)) {
    Write-Error "Zip is missing soulforge.exe. Aborting."
    exit 1
}

# ── Install (idempotent overwrite) ──────────────────────────────────
# Stop a running SoulForge process if present, otherwise the move fails with
# "The process cannot access the file because it is being used by another
# process" — Windows holds an exclusive lock on the .exe while it's running.
$running = Get-Process -Name "soulforge" -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "  stopping running soulforge.exe (pid $($running.Id))..." -ForegroundColor Gray
    Stop-Process -Id $running.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

# Move .exe into install dir, deps/ alongside (runtime resolves either next
# to exe OR from %LOCALAPPDATA%\SoulForge\native — the build.ts patch
# self-heals into %LOCALAPPDATA% on first run).
Move-Item -Path $bundleExe -Destination $exePath -Force
$installDeps = Join-Path $InstallDir "deps"
if (Test-Path $installDeps) { Remove-Item $installDeps -Recurse -Force }
if (Test-Path $bundleDeps) {
    Move-Item -Path $bundleDeps -Destination $installDeps -Force
}

# Cleanup
Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue

# ── Unblock (clears Zone.Identifier alternate data stream) ──────────
# Files downloaded from the internet carry a Mark-of-the-Web that triggers
# SmartScreen warnings on first run. Unblock-File removes the ADS so the
# user doesn't have to right-click → Properties → Unblock manually.
Unblock-File -Path $exePath -ErrorAction SilentlyContinue

# ── PATH update (User scope, no admin) ──────────────────────────────
if (-not $NoPathUpdate) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($null -eq $userPath) { $userPath = "" }

    # Split on `;`, trim empties, dedupe, then check membership.
    $pathParts = $userPath -split ';' | Where-Object { $_ -and $_.Trim() -ne "" }
    $alreadyPresent = $pathParts | Where-Object {
        $_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\')
    }

    if (-not $alreadyPresent) {
        $newPath = if ($userPath) { "$InstallDir;$userPath" } else { $InstallDir }
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        Write-Host "  added to PATH (User scope)" -ForegroundColor Green
        Write-Host "  open a NEW terminal for PATH changes to take effect." -ForegroundColor Yellow
    } else {
        Write-Host "  PATH already contains $InstallDir" -ForegroundColor Gray
    }
} else {
    Write-Host "  (skipped PATH update — \$env:SOULFORGE_NO_PATH=1)" -ForegroundColor Gray
}

# ── Bun detection ───────────────────────────────────────────────────
# The compiled .exe bundles its own Bun runtime, so this is informational
# only — but if the user wants to run `bun` directly or contribute to
# SoulForge, the warning saves a confused issue later.
$bunOnPath = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunOnPath) {
    Write-Host ""
    Write-Host "  Bun is not on PATH. The compiled soulforge.exe bundles its own" -ForegroundColor Yellow
    Write-Host "  Bun runtime, so the CLI will work fine." -ForegroundColor Yellow
    Write-Host "  If you want Bun globally (e.g. for development):" -ForegroundColor Yellow
    Write-Host "    powershell -c `"irm bun.sh/install.ps1 | iex`"" -ForegroundColor Yellow
}

# ── Done ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Installed: $exePath" -ForegroundColor Green
Write-Host ""
Write-Host "  Try it:" -ForegroundColor Cyan
Write-Host "    soulforge --version"
Write-Host ""
Write-Host "  SmartScreen warning?"
Write-Host "    Click 'More info' → 'Run anyway'."
Write-Host "    See https://github.com/$repo#windows-smartscreen for details."
Write-Host ""
