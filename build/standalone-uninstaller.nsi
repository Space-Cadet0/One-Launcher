; =============================================================================
; One Launcher — Standalone Full Windows Uninstaller (.exe)
; Compiles via makensis into release/One Launcher Full Uninstaller.exe
; Supports interactive GUI mode with confirmation and silent mode (/S)
; =============================================================================

Unicode true
Name "One Launcher Full Uninstaller"
OutFile "..\release\One Launcher Full Uninstaller.exe"
RequestExecutionLevel admin
ShowInstDetails show
CRCCheck on
XPStyle on

!ifndef PROJECT_DIR
  !if /FileExists "..\build\Uninstall-OneLauncher.ps1"
    !define PROJECT_DIR ".."
  !else if /FileExists "build\Uninstall-OneLauncher.ps1"
    !define PROJECT_DIR "."
  !else
    !define PROJECT_DIR "${__FILEDIR__}\.."
  !endif
!endif

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "One Launcher — Complete Uninstaller"
!define MUI_WELCOMEPAGE_TEXT "This standalone utility will completely remove One Launcher from your Windows system, including:$\r$\n$\r$\n• Running One Launcher, Legendary, and GOGDL processes$\r$\n• Application binaries in C:\Program Files\One Launcher and AppData$\r$\n• All games installed by One Launcher (C:\Games\OneLauncher and managed install locations)$\r$\n• All Electron AppData, LocalStorage, OAuth sessions, and encrypted credentials$\r$\n• Bundled Epic (Legendary) and GOG (gogdl) CLI configurations$\r$\n• Desktop & Start Menu shortcuts, temporary files, and Windows Registry entries$\r$\n$\r$\nTIP: If you are updating One Launcher to a newer version, click Cancel and run the new One Launcher Setup.exe directly — all your games, accounts, and library settings will be preserved.$\r$\n$\r$\nClick Next to begin the complete cleanup."
!define MUI_FINISHPAGE_TITLE "Uninstallation Complete"
!define MUI_FINISHPAGE_TEXT "One Launcher and all associated games, caches, credentials, and registry entries have been completely removed from your computer."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

Function .onInit
  IfSilent done_confirm
  MessageBox MB_YESNO|MB_ICONEXCLAMATION \
    "Are you sure you want to completely remove One Launcher, all saved account sessions, caches, and all games downloaded through One Launcher?$\r$\n$\r$\nTIP: If you are updating One Launcher to a newer version, click No and run the new One Launcher Setup.exe directly — all your games, accounts, and library settings will be preserved." \
    /SD IDYES IDYES done_confirm
  Abort
  done_confirm:
FunctionEnd

Section "Complete Uninstall" SecUninstall
  SetDetailsPrint both

  DetailPrint "[1/7] Terminating running One Launcher & CLI helper processes..."
  nsExec::ExecToLog 'taskkill /IM "One Launcher.exe"'
  nsExec::ExecToLog 'taskkill /IM "one-launcher.exe"'
  nsExec::ExecToLog 'taskkill /IM "legendary.exe"'
  nsExec::ExecToLog 'taskkill /IM "gogdl.exe"'
  Sleep 1000
  nsExec::ExecToLog 'taskkill /F /IM "One Launcher.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "one-launcher.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "legendary.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "gogdl.exe"'
  Sleep 500

  DetailPrint "[2/7] Running canonical PowerShell uninstaller for One Launcher managed games & registrations..."
  InitPluginsDir
  File "/oname=$PLUGINSDIR\Uninstall-OneLauncher.ps1" "${PROJECT_DIR}\build\Uninstall-OneLauncher.ps1"
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\Uninstall-OneLauncher.ps1"'

  SetShellVarContext current

  DetailPrint "[3/7] Removing default One Launcher game libraries..."
  RMDir /r "C:\Games\OneLauncher"
  RMDir /r "D:\Games\OneLauncher"
  RMDir /r "E:\Games\OneLauncher"
  RMDir /r "$PROFILE\Games\OneLauncher"
  RMDir /r "$PROFILE\OneLauncher Games"

  ; Remove parent Games directories only if completely empty
  RMDir "C:\Games"
  RMDir "D:\Games"
  RMDir "E:\Games"
  RMDir "$PROFILE\Games"

  DetailPrint "[4/7] Running existing NSIS uninstaller & removing application binaries..."
  ${If} ${FileExists} "$PROGRAMFILES64\One Launcher\Uninstall One Launcher.exe"
    CopyFiles /SILENT "$PROGRAMFILES64\One Launcher\Uninstall One Launcher.exe" "$TEMP\one-launcher-standalone-uninst.exe"
    ExecWait '"$TEMP\one-launcher-standalone-uninst.exe" /S /KEEP_APP_DATA _?=$PROGRAMFILES64\One Launcher'
    Delete "$TEMP\one-launcher-standalone-uninst.exe"
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES\One Launcher\Uninstall One Launcher.exe"
    CopyFiles /SILENT "$PROGRAMFILES\One Launcher\Uninstall One Launcher.exe" "$TEMP\one-launcher-standalone-uninst.exe"
    ExecWait '"$TEMP\one-launcher-standalone-uninst.exe" /S /KEEP_APP_DATA _?=$PROGRAMFILES\One Launcher'
    Delete "$TEMP\one-launcher-standalone-uninst.exe"
  ${EndIf}
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\One Launcher\Uninstall One Launcher.exe"
    CopyFiles /SILENT "$LOCALAPPDATA\Programs\One Launcher\Uninstall One Launcher.exe" "$TEMP\one-launcher-standalone-uninst.exe"
    ExecWait '"$TEMP\one-launcher-standalone-uninst.exe" /S /KEEP_APP_DATA _?=$LOCALAPPDATA\Programs\One Launcher'
    Delete "$TEMP\one-launcher-standalone-uninst.exe"
  ${EndIf}
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\one-launcher\Uninstall One Launcher.exe"
    CopyFiles /SILENT "$LOCALAPPDATA\Programs\one-launcher\Uninstall One Launcher.exe" "$TEMP\one-launcher-standalone-uninst.exe"
    ExecWait '"$TEMP\one-launcher-standalone-uninst.exe" /S /KEEP_APP_DATA _?=$LOCALAPPDATA\Programs\one-launcher'
    Delete "$TEMP\one-launcher-standalone-uninst.exe"
  ${EndIf}

  RMDir /r "$PROGRAMFILES64\One Launcher"
  RMDir /r "$PROGRAMFILES\One Launcher"
  RMDir /r "$LOCALAPPDATA\Programs\One Launcher"
  RMDir /r "$LOCALAPPDATA\Programs\one-launcher"

  DetailPrint "[5/7] Purging Electron AppData, LocalStorage, OAuth sessions & SafeStorage..."
  RMDir /r "$APPDATA\one-launcher"
  RMDir /r "$APPDATA\One Launcher"
  RMDir /r "$APPDATA\com.onelauncher.app"
  RMDir /r "$APPDATA\universal-game-library"
  RMDir /r "$LOCALAPPDATA\one-launcher"
  RMDir /r "$LOCALAPPDATA\One Launcher"
  RMDir /r "$LOCALAPPDATA\one-launcher-updater"
  RMDir /r "$LOCALAPPDATA\One Launcher-updater"
  RMDir /r "$LOCALAPPDATA\com.onelauncher.app"
  RMDir /r "$LOCALAPPDATA\universal-game-library"
  RMDir /r "$PROFILE\.one-launcher"
  RMDir /r "$PROFILE\.universal-game-library"

  DetailPrint "[6/7] Purging Legendary & GOGDL CLI configs and caches..."
  RMDir /r "$PROFILE\.config\legendary"
  RMDir /r "$APPDATA\legendary"
  RMDir /r "$LOCALAPPDATA\legendary"
  RMDir /r "$PROFILE\.config\gogdl"
  RMDir /r "$APPDATA\gogdl"
  RMDir /r "$PROFILE\.config\heroic_gogdl"
  RMDir /r "$APPDATA\heroic_gogdl"
  RMDir /r "$LOCALAPPDATA\heroic_gogdl"
  RMDir /r "$APPDATA\one-launcher\gogdlConfig"
  RMDir /r "$APPDATA\One Launcher\gogdlConfig"
  RMDir /r "$APPDATA\com.onelauncher.app\gogdlConfig"
  RMDir /r "$APPDATA\one-launcher\legendaryConfig"
  RMDir /r "$APPDATA\One Launcher\legendaryConfig"
  RMDir /r "$APPDATA\com.onelauncher.app\legendaryConfig"
  RMDir "$PROFILE\.config"

  DetailPrint "[7/7] Cleaning up temporary files, shortcuts, and Windows Registry..."
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$$ErrorActionPreference = 'SilentlyContinue'; @('one-launcher*','OneLauncher*','One Launcher*','gogdl*','legendary*') | ForEach-Object { Get-ChildItem -Path $$env:TEMP -Filter $$_ -Force | Remove-Item -Recurse -Force }; @('HKCU:\Software\GOG.com\Games', 'HKLM:\Software\WOW6432Node\GOG.com\Games', 'HKLM:\Software\GOG.com\Games') | ForEach-Object { if (Test-Path -LiteralPath $$_) { Get-ChildItem -LiteralPath $$_ | ForEach-Object { $$gp = Get-ItemProperty -LiteralPath $$_.PSPath; if ($$gp -and $$gp.path -match '(?i)OneLauncher') { Remove-Item -LiteralPath $$_.PSPath -Recurse -Force } } } }; @( 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' ) | ForEach-Object { if (Test-Path -LiteralPath $$_) { Get-ChildItem -LiteralPath $$_ | ForEach-Object { $$p = Get-ItemProperty -LiteralPath $$_.PSPath; if ($$p -and ($$p.DisplayName -eq 'One Launcher' -or $$p.DisplayName -eq 'one-launcher')) { Remove-Item -LiteralPath $$_.PSPath -Recurse -Force } } } }"`

  ; Clean current user shortcuts
  Delete "$DESKTOP\One Launcher.lnk"
  Delete "$SMPROGRAMS\One Launcher.lnk"
  RMDir /r "$SMPROGRAMS\One Launcher"

  ; Clean All-Users shortcuts
  SetShellVarContext all
  Delete "$DESKTOP\One Launcher.lnk"
  Delete "$SMPROGRAMS\One Launcher.lnk"
  RMDir /r "$SMPROGRAMS\One Launcher"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.onelauncher.app"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{com.onelauncher.app}"
  DeleteRegKey HKCU "Software\com.onelauncher.app"
  DeleteRegKey HKCU "Software\One Launcher"
  DeleteRegKey HKCU "Software\one-launcher"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.onelauncher.app"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{com.onelauncher.app}"
  DeleteRegKey HKLM "Software\com.onelauncher.app"
  DeleteRegKey HKLM "Software\One Launcher"
  DeleteRegKey HKLM "Software\one-launcher"

  DetailPrint "Complete! All One Launcher files, games, caches, and registry entries have been removed."
SectionEnd
