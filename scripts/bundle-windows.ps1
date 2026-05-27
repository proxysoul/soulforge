# SoulForge Windows bundle script
#
# Produces dist/bundle/soulforge-<version>-windows-<arch>.zip containing:
#   soulforge.exe
#   deps/
#     native/win32-<arch>/opentui.dll
#     native/win32-<arch>/ghostty-opentui.node       (optional)
#     workers/intelligence.worker.js
#     workers/io.worker.js
#     wasm/tree-sitter.wasm + grammars
#     opentui-assets/...
#     init.lua
#
# The runtime resolver (scripts/build.ts patches the bundle at compile time)
# looks first in %LOCALAPPDATA%\SoulForge\native\<triplet>\, then beside the
# .exe in deps/native/<triplet>\. install.ps1 (or a manual unzip) drops
# the deps/ tree next to soulforge.exe and the binary self-heals on first
# run by copying everything into %LOCALAPPDATA%.
#
# Usage (from repo root, on any OS with PowerShell 5.1+ or pwsh):
#   pwsh scripts/bundle-windows.ps1            # defaults to x64
#   pwsh scripts/bundle-windows.ps1 -Arch arm64
#
# Cross-bundles from macOS/Linux fine because Bun's --compile target is
# fully cross-platform. The only Windows-specific step is unzipping, which
# Compress-Archive handles natively.

param(
    [ValidateSet("x64", "arm64")]
    [string]$Arch = "x64",
    [switch]$NoExe
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $repoRoot
try {
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $triplet = "win32-$Arch"
    $bundleName = "soulforge-$version-windows-$Arch"
    $stageDir = Join-Path $repoRoot "dist/bundle/$bundleName"
    $depsDir = Join-Path $stageDir "deps"
    $nativeDir = Join-Path $depsDir "native/$triplet"

    Write-Host "==> Bundling SoulForge $version for windows/$Arch"

    if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
    New-Item -ItemType Directory -Path $nativeDir -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $depsDir "workers") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $depsDir "wasm") -Force | Out-Null

    if (-not $NoExe) {
        Write-Host "==> Compiling soulforge-windows-$Arch.exe"
        $bunTarget = if ($Arch -eq "arm64") { "bun-windows-arm64" } else { "bun-windows-x64" }
        $exeOut = Join-Path $stageDir "soulforge.exe"
        & bun scripts/build.ts --compile --target=$bunTarget --outfile=$exeOut
        if ($LASTEXITCODE -ne 0) { throw "bun build failed (exit $LASTEXITCODE)" }
    } else {
        $existing = Join-Path $repoRoot "bin/soulforge-windows-$Arch.exe"
        if (-not (Test-Path $existing)) { throw "Pre-built exe not found: $existing" }
        Copy-Item $existing (Join-Path $stageDir "soulforge.exe") -Force
    }
    Write-Host "    OK soulforge.exe"

    # OpenTUI native DLL. Bun on non-win32 hosts skips win32 optionals even
    # with --include=optional, so when cross-bundling from macOS/Linux we
    # fetch the tarball directly from the npm registry (no npm CLI — Bun-only
    # toolchain rule) and stage opentui.dll into node_modules so the runtime
    # resolver layout matches a real install.
    $opentuiPkg = Join-Path $repoRoot "node_modules/@opentui/core-$triplet"
    $opentuiDll = Join-Path $opentuiPkg "opentui.dll"
    if (-not (Test-Path $opentuiDll)) {
        Write-Host "    fetching @opentui/core-$triplet from npm registry..."
        $coreVersion = (Get-Content (Join-Path $repoRoot "node_modules/@opentui/core/package.json") -Raw | ConvertFrom-Json).version
        $tmpPull = Join-Path ([System.IO.Path]::GetTempPath()) "soulforge-otui-$triplet"
        if (Test-Path $tmpPull) { Remove-Item $tmpPull -Recurse -Force }
        New-Item -ItemType Directory -Path $tmpPull -Force | Out-Null
        Push-Location $tmpPull
        try {
            $pkgPath = "@opentui%2fcore-$triplet"
            $tarballUrl = "https://registry.npmjs.org/$pkgPath/-/core-$triplet-$coreVersion.tgz"
            $tgzPath = Join-Path $tmpPull "core-$triplet-$coreVersion.tgz"
            Invoke-WebRequest -Uri $tarballUrl -OutFile $tgzPath
            if (-not (Test-Path $tgzPath)) { throw "tarball fetch failed: $tarballUrl" }
            & tar -xzf $tgzPath
            if (-not (Test-Path "package/opentui.dll")) { throw "extracted tarball is missing opentui.dll" }
            New-Item -ItemType Directory -Path $opentuiPkg -Force | Out-Null
            Copy-Item "package/opentui.dll" $opentuiPkg -Force
            Copy-Item "package/package.json" $opentuiPkg -Force
            if (Test-Path "package/index.ts") { Copy-Item "package/index.ts" $opentuiPkg -Force }
        } finally {
            Pop-Location
            Remove-Item $tmpPull -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if (-not (Test-Path $opentuiDll)) {
        throw "opentui.dll still missing after fetch attempt: $opentuiDll"
    }
    Copy-Item $opentuiDll $nativeDir -Force
    Write-Host "    OK opentui.dll"

    $ghostty = Join-Path $repoRoot "node_modules/ghostty-opentui/dist/$triplet/ghostty-opentui.node"
    if (Test-Path $ghostty) {
        Copy-Item $ghostty $nativeDir -Force
        Write-Host "    OK ghostty-opentui.node"
    } else {
        Write-Host "    WARN ghostty-opentui.node not present for $triplet (floating terminal disabled)"
    }

    # Use --outdir + --entry-naming because Bun may emit multiple chunks for
    # the intelligence worker (code-splitting via dynamic imports of ts-morph,
    # tree-sitter, etc.). --outfile only accepts a single output file.
    # --external keeps native + binary assets out of the bundle (see
    # bundle.sh for rationale — same hash-named .node + .scm + .wasm fan-out).
    $workersDir = Join-Path $depsDir "workers"
    $workerExternals = @(
        "--external", "ghostty-opentui",
        "--external", "ghostty-opentui/*",
        "--external", "@opentui/core",
        "--external", "@opentui/core/*",
        "--external", "tree-sitter-wasms",
        "--external", "tree-sitter-wasms/*",
        "--external", "*.node",
        "--external", "*.wasm",
        "--external", "*.scm"
    )
    & bun build src/core/workers/intelligence.worker.ts `
        --outdir $workersDir `
        --entry-naming "[name].[ext]" `
        --target=bun `
        @workerExternals
    if ($LASTEXITCODE -ne 0) { throw "intelligence worker bundle failed" }
    & bun build src/core/workers/io.worker.ts `
        --outdir $workersDir `
        --entry-naming "[name].[ext]" `
        --target=bun `
        @workerExternals
    if ($LASTEXITCODE -ne 0) { throw "io worker bundle failed" }
    Write-Host "    OK workers"

    $wts = Join-Path $repoRoot "node_modules/web-tree-sitter"
    $wasmTargets = @((Join-Path $wts "tree-sitter.wasm"), (Join-Path $wts "web-tree-sitter.wasm"))
    $wasmSrc = $wasmTargets | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $wasmSrc) { throw "tree-sitter.wasm not found in node_modules/web-tree-sitter" }
    Copy-Item $wasmSrc (Join-Path $depsDir "wasm/tree-sitter.wasm") -Force
    $grammars = Join-Path $repoRoot "node_modules/tree-sitter-wasms/out"
    if (Test-Path $grammars) {
        Get-ChildItem $grammars -Filter *.wasm | Copy-Item -Destination (Join-Path $depsDir "wasm") -Force
    }
    Write-Host "    OK wasm"

    $opentuiAssets = Join-Path $repoRoot "node_modules/@opentui/core/assets"
    if (Test-Path $opentuiAssets) {
        Copy-Item $opentuiAssets (Join-Path $depsDir "opentui-assets") -Recurse -Force
    }
    $parserWorker = Join-Path $repoRoot "node_modules/@opentui/core/parser.worker.js"
    if (Test-Path $parserWorker) {
        & bun build $parserWorker --outdir (Join-Path $depsDir "opentui-assets") --target=bun --asset-naming="[name].[ext]"
        $workerJs = Join-Path $depsDir "opentui-assets/parser.worker.js"
        if (Test-Path $workerJs) {
            $content = Get-Content $workerJs -Raw
            $content = $content -replace 'module2.exports = "./tree-sitter.wasm"', 'module2.exports = ((process.env.LOCALAPPDATA || __require("os").homedir() + "/AppData/Local") + "/SoulForge/wasm/tree-sitter.wasm")'
            $content = $content -replace 'var fs = require\("fs"\)', 'var fs = __require("fs")'
            $content = $content -replace 'var nodePath = require\("path"\)', 'var nodePath = __require("path")'
            $content = $content -replace 'require\("url"\)', '__require("url")'
            Set-Content $workerJs -Value $content -NoNewline
        }
    }
    Write-Host "    OK opentui-assets"

    $initLua = Join-Path $repoRoot "src/core/editor/init.lua"
    if (Test-Path $initLua) { Copy-Item $initLua (Join-Path $depsDir "init.lua") -Force }

    # LICENSE alongside the .exe so NSIS + zip ship it (BUSL-1.1 needs the
    # license file available next to the binary; not a click-through).
    $license = Join-Path $repoRoot "LICENSE"
    if (Test-Path $license) { Copy-Item $license (Join-Path $stageDir "LICENSE") -Force }

    @"
SoulForge $version - Windows $Arch bundle

To run:
  .\soulforge.exe --version

The deps\ directory must remain next to soulforge.exe. On first run the
binary copies these files into %LOCALAPPDATA%\SoulForge\ so the bundle
location no longer matters after that.

Distributed under BUSL-1.1. See https://github.com/proxysoul/soulforge.
"@ | Set-Content (Join-Path $stageDir "README.txt")

    $zipPath = Join-Path $repoRoot "dist/bundle/$bundleName.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Write-Host "==> Compressing $bundleName.zip"
    Compress-Archive -Path "$stageDir/*" -DestinationPath $zipPath -CompressionLevel Optimal

    $zipSize = "{0:N1} MB" -f ((Get-Item $zipPath).Length / 1MB)
    Write-Host ""
    Write-Host "Bundle ready: $zipPath ($zipSize)" -ForegroundColor Green
} finally {
    Pop-Location
}
