# Build the NSIS installer for Windows.
#
# Wraps scripts/bundle-windows.ps1 + makensis. Runs on Windows (where makensis
# lives on PATH after `choco install nsis` / `winget install NSIS.NSIS`).
#
# Auto-installs the EnVar plugin into the user-local NSIS plugin dir on first
# run — the .nsi uses EnVar::AddValue / DeleteValue for PATH editing.
#
# Usage:
#   pwsh scripts/build-installer.ps1                         # x64, builds zip first
#   pwsh scripts/build-installer.ps1 -Arch arm64
#   pwsh scripts/build-installer.ps1 -SkipBundle             # reuse existing dist/bundle/
#
# Output:
#   dist/bundle/soulforge-setup-<version>-<arch>.exe

param(
    [ValidateSet("x64", "arm64")]
    [string]$Arch = "x64",
    [switch]$SkipBundle
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $repoRoot
try {
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $bundleName = "soulforge-$version-windows-$Arch"
    $bundleDir = Join-Path $repoRoot "dist/bundle/$bundleName"
    $output = Join-Path $repoRoot "dist/bundle/soulforge-setup-$version-$Arch.exe"

    if (-not $SkipBundle) {
        Write-Host "==> Bundling first (re-uses cached .exe if present)..."
        & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "bundle-windows.ps1") -Arch $Arch
        if ($LASTEXITCODE -ne 0) { throw "bundle-windows.ps1 failed (exit $LASTEXITCODE)" }
    }

    if (-not (Test-Path $bundleDir)) {
        throw "Bundle dir not found: $bundleDir (run without -SkipBundle to produce it)"
    }

    # ── makensis ───────────────────────────────────────────────────────
    $makensis = Get-Command makensis -ErrorAction SilentlyContinue
    if (-not $makensis) {
        throw @"
makensis not found on PATH. Install NSIS:
    winget install NSIS.NSIS        # preferred
    choco install nsis              # alternative
    brew install makensis           # macOS / cross-bundle from a mac
"@
    }

    # ── EnVar plugin (download into a writable temp dir, pass via /X !addplugindir) ──
    # We avoid writing into the NSIS install dir (needs sudo on Ubuntu, admin
    # on Windows) by passing a temp plugin dir to makensis at invoke time via
    # the `!addplugindir` script directive. NSIS resolves plugins from this
    # dir first, then falls back to its built-in Plugins\ path.
    # NSIS resolves plugins from <plugindir>/<arch>-unicode/ for `Unicode true`
    # scripts. Our .nsi is Unicode, so we must populate BOTH x86-unicode/ and
    # amd64-unicode/ subdirs (makensis picks based on the script's bitness, not
    # the host OS). EnVar v0.3.1 ships both — preserve the subdir layout.
    $pluginTmp = Join-Path ([System.IO.Path]::GetTempPath()) "soulforge-nsis-plugins"
    $markerDll = Join-Path $pluginTmp "x86-unicode/EnVar.dll"
    if (-not (Test-Path $markerDll)) {
        Write-Host "==> Downloading EnVar NSIS plugin..."
        if (Test-Path $pluginTmp) { Remove-Item $pluginTmp -Recurse -Force }
        New-Item -ItemType Directory -Path $pluginTmp -Force | Out-Null
        $envarZip = Join-Path $pluginTmp "EnVar-Plugin.zip"
        $envarUrl = "https://github.com/GsNSIS/EnVar/releases/download/v0.3.1/EnVar-Plugin.zip"
        # SHA256 pin — refuse to extract if upstream asset is swapped.
        $envarSha256 = "e5b337fcad68252d18282f7259a0306053626e41b9480fa09df3fab012b85e00"
        Invoke-WebRequest -Uri $envarUrl -OutFile $envarZip
        $actualSha = (Get-FileHash -Algorithm SHA256 $envarZip).Hash.ToLower()
        if ($actualSha -ne $envarSha256) {
            throw "EnVar-Plugin.zip SHA256 mismatch — expected $envarSha256, got $actualSha. Refusing to extract."
        }
        $extractTmp = Join-Path $pluginTmp "_extract"
        New-Item -ItemType Directory -Path $extractTmp -Force | Out-Null
        Expand-Archive -Path $envarZip -DestinationPath $extractTmp -Force

        # Copy the arch-unicode subdirs to the plugin root so makensis's
        # `!addplugindir "${PLUGIN_DIR}"` lookup finds <PLUGIN_DIR>/x86-unicode/EnVar.dll
        # (NSIS searches <plugindir>/<arch>-unicode/ when the script declares `Unicode true`).
        foreach ($variant in @("x86-unicode", "amd64-unicode")) {
            $srcDir = Get-ChildItem -Path $extractTmp -Recurse -Directory -Filter $variant -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($srcDir) {
                $destDir = Join-Path $pluginTmp $variant
                New-Item -ItemType Directory -Path $destDir -Force | Out-Null
                Copy-Item (Join-Path $srcDir.FullName "*") $destDir -Recurse -Force
            }
        }
        if (-not (Test-Path $markerDll)) {
            throw "EnVar.dll not found at $markerDll after extracting plugin zip"
        }
        Remove-Item $envarZip -Force -ErrorAction SilentlyContinue
        Remove-Item $extractTmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    # ── makensis invocation ───────────────────────────────────────────
    Write-Host "==> makensis: building soulforge-setup-$version-$Arch.exe"
    $nsi = Join-Path $repoRoot "packaging/windows/soulforge.nsi"
    # Pass the plugin dir as a -D define instead of -X "!addplugindir ..." —
    # PowerShell's argv splitter on Linux joins quoted -X args into a single
    # token (makensis then complains "Can't open script ..."). The NSI script
    # honours PLUGIN_DIR with `!addplugindir "${PLUGIN_DIR}"`.
    # makensis flag prefix is `/` on Windows, `-` on Linux/macOS.
    $flagPrefix = if ($IsWindows) { "/" } else { "-" }
    & makensis `
        "${flagPrefix}DPLUGIN_DIR=$pluginTmp" `
        "${flagPrefix}DVERSION=$version" `
        "${flagPrefix}DBUNDLE_DIR=$bundleDir" `
        "${flagPrefix}DOUTPUT=$output" `
        "${flagPrefix}DARCH=$Arch" `
        $nsi
    if ($LASTEXITCODE -ne 0) { throw "makensis failed (exit $LASTEXITCODE)" }

    $size = "{0:N1} MB" -f ((Get-Item $output).Length / 1MB)
    Write-Host ""
    Write-Host "Installer ready: $output ($size)" -ForegroundColor Green
} finally {
    Pop-Location
}
