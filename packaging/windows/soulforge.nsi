; SoulForge NSIS installer
;
; Per-user, no-admin installer following the Bun / Deno / OpenCode pattern:
;   - Installs to %LOCALAPPDATA%\Programs\SoulForge
;   - Adds the install dir to the User PATH (idempotent, EnVar plugin)
;   - Registers under HKCU\…\Uninstall (visible in Settings → Apps)
;   - Start Menu shortcut for "SoulForge" and "Uninstall"
;   - Kills any running soulforge.exe before overwriting (Windows file lock)
;
; Inputs (passed via /D defines from scripts/build-installer.ps1):
;   /DVERSION=<x.y.z>             — embedded in installer metadata
;   /DBUNDLE_DIR=<path>           — staged bundle (soulforge.exe + deps\)
;   /DOUTPUT=<path\setup.exe>     — output installer path
;   /DARCH=<x64|arm64>            — informational, recorded in registry
;
; Build:
;   makensis -DVERSION=2.15.3 -DBUNDLE_DIR=dist\bundle\soulforge-2.15.3-windows-x64 ^
;            -DOUTPUT=dist\bundle\soulforge-setup-2.15.3-x64.exe -DARCH=x64 ^
;            packaging\windows\soulforge.nsi
;
; Dependencies (bundled with NSIS 3.10+; auto-install via build script):
;   EnVar — clean PATH editing with WM_SETTINGCHANGE broadcast.
;           https://nsis.sourceforge.io/EnVar_plug-in

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef BUNDLE_DIR
  !error "BUNDLE_DIR must be defined (path to the staged bundle directory)"
!endif
!ifndef OUTPUT
  !define OUTPUT "soulforge-setup.exe"
!endif
!ifndef ARCH
  !define ARCH "x64"
!endif

; PLUGIN_DIR optional — supplied by scripts/build-installer.ps1 so the
; EnVar plugin DLL can live in a writable temp dir (CI runners can't write
; into /usr/share/nsis/Plugins without sudo). When set, prepend it to the
; plugin search path BEFORE any directives that need EnVar.
;
; NSIS 3 separates plugin archives into /x86-ansi and /x86-unicode subdirs.
; Because this script declares `Unicode true` (see below), we must point
; !addplugindir at the *unicode* subdir explicitly with the /x86-unicode
; flag — otherwise makensis silently ignores it and reports "Plugin not
; found, cannot call EnVar::*". The plugin zip from GsNSIS/EnVar v0.3.1
; ships <root>/Plugins/x86-unicode/EnVar.dll which build-installer.ps1
; lifts to <PLUGIN_DIR>/x86-unicode/EnVar.dll.
!ifdef PLUGIN_DIR
  !addplugindir /x86-unicode "${PLUGIN_DIR}\x86-unicode"
  !addplugindir /amd64-unicode "${PLUGIN_DIR}\amd64-unicode"
!endif

!define APP_NAME      "SoulForge"
!define APP_PUBLISHER "proxySoul"
!define APP_URL       "https://github.com/proxysoul/soulforge"
!define APP_EXE       "soulforge.exe"
!define UNINST_KEY    "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

Name "${APP_NAME} ${VERSION}"
OutFile "${OUTPUT}"
Unicode true
SetCompressor /SOLID lzma

; Per-user install — no admin elevation. Mirrors Bun/Deno install pattern.
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"

; Embed version metadata in the PE header so SmartScreen / right-click →
; Properties shows correct identity.
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName"     "${APP_NAME}"
VIAddVersionKey "CompanyName"     "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "ProductVersion"  "${VERSION}"
VIAddVersionKey "LegalCopyright"  "© ${APP_PUBLISHER}"

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING
; MUI_ICON / MUI_UNICON intentionally omitted — NSIS expects a standalone
; .ico file, not a PE binary. Bun-compiled soulforge.exe has its icon
; resource embedded, which `Error while loading icon ... invalid icon file`
; on parse. NSIS falls back to its default installer icon. Add/Remove
; Programs still gets our exe's icon via DisplayIcon below.

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"

  ; Kill any running soulforge.exe — Windows holds an exclusive lock and
  ; the file copy would fail mid-install otherwise.
  nsExec::Exec 'taskkill /F /IM ${APP_EXE} /T'
  Pop $0  ; discard exit code

  ; Stage the bundle. BUNDLE_DIR has soulforge.exe at root + deps\ alongside.
  File "${BUNDLE_DIR}\${APP_EXE}"
  File /r "${BUNDLE_DIR}\deps"
  File /nonfatal "${BUNDLE_DIR}\README.txt"
  File /nonfatal "${BUNDLE_DIR}\LICENSE"

  ; "sf" PATH alias — copy of soulforge.exe so users get both `soulforge`
  ; and `sf` from any shell. Same binary, same runtime self-heal path,
  ; argv[0]-based detection elsewhere keeps logs consistent.
  CopyFiles /SILENT "$INSTDIR\${APP_EXE}" "$INSTDIR\sf.exe"

  ; Persist install dir + arch for the uninstaller / upgrade path.
  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\${APP_NAME}" "Version"    "${VERSION}"
  WriteRegStr HKCU "Software\${APP_NAME}" "Arch"       "${ARCH}"

  ; Add install dir to User PATH via EnVar plugin (idempotent — refuses to
  ; double-insert, preserves REG_EXPAND_SZ, broadcasts WM_SETTINGCHANGE so
  ; freshly-opened shells see the new PATH without a logoff).
  EnVar::SetHKCU
  EnVar::AddValue "Path" "$INSTDIR"
  Pop $0
  ${If} $0 != 0
    DetailPrint "warning: EnVar::AddValue returned $0 (PATH not updated)"
  ${EndIf}

  ; Add uninstaller entry in Settings → Apps.
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayName"     "${APP_NAME}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayVersion"  "${VERSION}"
  WriteRegStr   HKCU "${UNINST_KEY}" "Publisher"       "${APP_PUBLISHER}"
  WriteRegStr   HKCU "${UNINST_KEY}" "URLInfoAbout"    "${APP_URL}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayIcon"     "$INSTDIR\${APP_EXE}"
  WriteRegStr   HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify"        1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair"        1

  ; Start Menu shortcut (per-user — no admin needed).
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut  "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut  "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk"   "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  ; Kill any running instance before deleting files (Windows holds an
  ; exclusive lock while the .exe is mapped).
  nsExec::Exec 'taskkill /F /IM ${APP_EXE} /T'
  Pop $0

  ; Strip install dir from User PATH (no-op if already absent).
  EnVar::SetHKCU
  EnVar::DeleteValue "Path" "$INSTDIR"
  Pop $0

  RMDir /r "$INSTDIR\deps"
  Delete   "$INSTDIR\${APP_EXE}"
  Delete   "$INSTDIR\sf.exe"
  Delete   "$INSTDIR\README.txt"
  Delete   "$INSTDIR\LICENSE"
  Delete   "$INSTDIR\uninstall.exe"
  RMDir    "$INSTDIR"

  Delete   "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete   "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk"
  RMDir    "$SMPROGRAMS\${APP_NAME}"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${APP_NAME}"
SectionEnd
