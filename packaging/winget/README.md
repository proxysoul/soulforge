# WinGet manifests

Templates for publishing SoulForge to the [microsoft/winget-pkgs] repo so
users can install via:

```powershell
winget install ProxySoul.SoulForge
```

## Layout (in winget-pkgs)

```
manifests/p/ProxySoul/SoulForge/<version>/
  ProxySoul.SoulForge.yaml             # version manifest
  ProxySoul.SoulForge.installer.yaml   # installer URLs + switches
  ProxySoul.SoulForge.locale.en-US.yaml # description + license
```

## Release flow

1. Tag a release. GHA `release-windows.yml` uploads
   `soulforge-setup-<version>-x64.exe` + `.sha256`.
2. Bump `PackageVersion` in all three yaml files (sed -i).
3. Replace `InstallerSha256: REPLACE_WITH_SHA256` with the value from the
   `.sha256` artifact.
4. Replace `ReleaseDate` with today's date.
5. Copy the trio into a winget-pkgs fork under
   `manifests/p/ProxySoul/SoulForge/<version>/` and open a PR upstream.

Automation candidate: `winget-create submit` + GHA cron later (v1.2).
The templates here are what that workflow will template-substitute.

## Schema

These follow the [WinGet manifest schema 1.6.0]. Validate locally:

```powershell
winget validate manifests/p/ProxySoul/SoulForge/<version>/
```

[microsoft/winget-pkgs]: https://github.com/microsoft/winget-pkgs
[WinGet manifest schema 1.6.0]: https://learn.microsoft.com/windows/package-manager/package/manifest
