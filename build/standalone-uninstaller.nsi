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

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "One Launcher — Complete Uninstaller"
!define MUI_WELCOMEPAGE_TEXT "This standalone utility will completely remove One Launcher from your Windows system, including:$\r$\n$\r$\n• Running One Launcher, Legendary, and GOGDL processes$\r$\n• Application binaries in C:\Program Files\One Launcher and AppData$\r$\n• All games installed by One Launcher (C:\Games\OneLauncher and custom install locations)$\r$\n• All Electron AppData, LocalStorage, OAuth sessions, and encrypted credentials$\r$\n• Bundled Epic (Legendary) and GOG (gogdl) CLI configurations$\r$\n• Desktop & Start Menu shortcuts, temporary files, and Windows Registry entries$\r$\n$\r$\nClick Next to begin the complete cleanup."
!define MUI_FINISHPAGE_TITLE "Uninstallation Complete"
!define MUI_FINISHPAGE_TEXT "One Launcher and all associated games, caches, credentials, and registry entries have been completely removed from your computer."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

Function .onInit
  IfSilent done_confirm
  MessageBox MB_YESNO|MB_ICONEXCLAMATION \
    "Are you sure you want to completely remove One Launcher, all saved account sessions, caches, and all games downloaded through One Launcher?" \
    /SD IDYES IDYES done_confirm
  Abort
  done_confirm:
FunctionEnd

Section "Complete Uninstall" SecUninstall
  SetDetailsPrint both

  DetailPrint "[1/7] Terminating running One Launcher & CLI helper processes..."
  nsExec::ExecToLog 'taskkill /F /IM "One Launcher.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "one-launcher.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "legendary.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "gogdl.exe" /T'
  Sleep 1000

  DetailPrint "[2/7] Scanning manifests for custom-path installed games & first-party registrations..."
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$$ErrorActionPreference = 'SilentlyContinue'; $$removedPaths = @(); $$removedIds = @(); $$jsonFiles = @(\"$$env:APPDATA\one-launcher\one_launcher_installed.json\", \"$$env:APPDATA\One Launcher\one_launcher_installed.json\", \"$$env:APPDATA\com.onelauncher.app\one_launcher_installed.json\"); foreach ($$jf in $$jsonFiles) { if (Test-Path -LiteralPath $$jf) { $$data = Get-Content -LiteralPath $$jf -Raw | ConvertFrom-Json; $$items = if ($$data -is [System.Array]) { $$data } else { $$data.PSObject.Properties | ForEach-Object { $$_.Value } }; foreach ($$entry in $$items) { $$p = $$entry.installPath; $$r = [string]$$entry.runner; if ($$p -and ($$r -in @('legendary','gogdl','one_launcher') -or $$p -match '(?i)OneLauncher')) { $$removedPaths += $$p; if ($$p -match '(?i)OneLauncher') { $$parent = Split-Path -Parent $$p; if ($$parent -and $$parent -match '(?i)OneLauncher') { $$removedPaths += $$parent } }; if ($$entry.platformGameId) { $$gid = [string]$$entry.platformGameId; $$removedIds += $$gid; $$removedIds += ($$gid -replace '^(?i)(epic|gog)[-_]','') }; if ($$p.Length -gt 6 -and $$p -notmatch '^[A-Za-z]:\\$$' -and $$p -notmatch 'Steam') { if (Test-Path -LiteralPath $$p) { Remove-Item -LiteralPath $$p -Recurse -Force } } } } } }; $$legFiles = @(\"$$env:APPDATA\one-launcher\legendaryConfig\legendary\installed.json\", \"$$env:APPDATA\One Launcher\legendaryConfig\legendary\installed.json\", \"$$env:USERPROFILE\.config\legendary\installed.json\", \"$$env:APPDATA\legendary\installed.json\"); foreach ($$lf in $$legFiles) { if (Test-Path -LiteralPath $$lf) { $$ldata = Get-Content -LiteralPath $$lf -Raw | ConvertFrom-Json; if ($$ldata -is [System.Array]) { foreach ($$entry in $$ldata) { $$lp = $$entry.install_path; if ($$entry.app_name) { $$removedIds += [string]$$entry.app_name }; if ($$lp) { $$removedPaths += $$lp; if ($$lp.Length -gt 6 -and $$lp -notmatch '^[A-Za-z]:\\$$' -and $$lp -notmatch 'Steam' -and (Test-Path -LiteralPath $$lp)) { Remove-Item -LiteralPath $$lp -Recurse -Force } } } } else { foreach ($$prop in $$ldata.PSObject.Properties) { $$removedIds += [string]$$prop.Name; if ($$prop.Value.app_name) { $$removedIds += [string]$$prop.Value.app_name }; $$lp = $$prop.Value.install_path; if ($$lp) { $$removedPaths += $$lp; if ($$lp.Length -gt 6 -and $$lp -notmatch '^[A-Za-z]:\\$$' -and $$lp -notmatch 'Steam' -and (Test-Path -LiteralPath $$lp)) { Remove-Item -LiteralPath $$lp -Recurse -Force } } } } } }; $$eglDir = 'C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests'; if (Test-Path -LiteralPath $$eglDir) { Get-ChildItem -LiteralPath $$eglDir -Filter '*.item' -File | ForEach-Object { try { $$it = Get-Content -LiteralPath $$_.FullName -Raw | ConvertFrom-Json; if ($$it.InstallLocation -match '(?i)OneLauncher' -or ($$removedPaths -contains $$it.InstallLocation) -or ($$removedIds -contains $$it.AppName)) { Remove-Item -LiteralPath $$_.FullName -Force } } catch {} } }; $$eglDat = 'C:\ProgramData\Epic\UnrealEngineLauncher\LauncherInstalled.dat'; if (Test-Path -LiteralPath $$eglDat) { try { $$dat = Get-Content -LiteralPath $$eglDat -Raw | ConvertFrom-Json; if ($$dat.InstallationList) { $$dat.InstallationList = @($$dat.InstallationList | Where-Object { $$_.InstallLocation -notmatch '(?i)OneLauncher' -and ($$removedPaths -notcontains $$_.InstallLocation) -and ($$removedIds -notcontains $$_.AppName) }); $$dat | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $$eglDat -Encoding UTF8 } } catch {} }; $$gogCfg = 'C:\ProgramData\GOG.com\Galaxy\config.json'; if (Test-Path -LiteralPath $$gogCfg) { try { $$cfg = Get-Content -LiteralPath $$gogCfg -Raw | ConvertFrom-Json; if ($$cfg -and $$cfg.installationPaths) { $$cfg.installationPaths = @($$cfg.installationPaths | Where-Object { $$_ -notmatch '(?i)OneLauncher' -and ($$removedPaths -notcontains $$_) }); $$cfg | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $$gogCfg -Encoding UTF8 } } catch {} }; $$gogDb = 'C:\ProgramData\GOG.com\Galaxy\Storage\galaxy-2.0.db'; if ((Test-Path -LiteralPath $$gogDb) -and (Get-Command sqlite3.exe -ErrorAction SilentlyContinue)) { try { $$sql = \"DELETE FROM InstalledBaseProducts WHERE installationPath LIKE '%OneLauncher%'; \"; foreach ($$rid in $$removedIds) { if ($$rid -match '^\d+$$') { $$sql += \"DELETE FROM InstalledBaseProducts WHERE productId = $$rid; \" } }; $$sql += \"DELETE FROM InstalledProducts WHERE productId NOT IN (SELECT productId FROM InstalledBaseProducts);\"; & sqlite3.exe $$gogDb $$sql 2>$$null | Out-Null } catch {} }; @('HKCU:\Software\GOG.com\Games', 'HKLM:\Software\WOW6432Node\GOG.com\Games', 'HKLM:\Software\GOG.com\Games') | ForEach-Object { if (Test-Path -LiteralPath $$_) { Get-ChildItem -LiteralPath $$_ | ForEach-Object { $$gp = Get-ItemProperty -LiteralPath $$_.PSPath; if ($$gp -and ($$gp.path -match '(?i)OneLauncher' -or ($$removedPaths -contains $$gp.path) -or ($$removedIds -contains $$_.PSChildName) -or ($$removedIds -contains $$gp.gameID))) { Remove-Item -LiteralPath $$_.PSPath -Recurse -Force } } } }"`

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
    ExecWait '"$PROGRAMFILES64\One Launcher\Uninstall One Launcher.exe" /S _?=$PROGRAMFILES64\One Launcher'
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES\One Launcher\Uninstall One Launcher.exe"
    ExecWait '"$PROGRAMFILES\One Launcher\Uninstall One Launcher.exe" /S _?=$PROGRAMFILES\One Launcher'
  ${EndIf}
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\One Launcher\Uninstall One Launcher.exe"
    ExecWait '"$LOCALAPPDATA\Programs\One Launcher\Uninstall One Launcher.exe" /S _?=$LOCALAPPDATA\Programs\One Launcher'
  ${EndIf}
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\one-launcher\Uninstall One Launcher.exe"
    ExecWait '"$LOCALAPPDATA\Programs\one-launcher\Uninstall One Launcher.exe" /S _?=$LOCALAPPDATA\Programs\one-launcher'
  ${EndIf}

  RMDir /r "$PROGRAMFILES64\One Launcher"
  RMDir /r "$PROGRAMFILES\One Launcher"
  RMDir /r "$LOCALAPPDATA\Programs\One Launcher"
  RMDir /r "$LOCALAPPDATA\Programs\one-launcher"

  DetailPrint "[5/7] Purging Electron AppData, LocalStorage, OAuth sessions & SafeStorage..."
  RMDir /r "$APPDATA\one-launcher"
  RMDir /r "$APPDATA\One Launcher"
  RMDir /r "$APPDATA\com.onelauncher.app"
  RMDir /r "$LOCALAPPDATA\one-launcher"
  RMDir /r "$LOCALAPPDATA\One Launcher"
  RMDir /r "$LOCALAPPDATA\one-launcher-updater"
  RMDir /r "$LOCALAPPDATA\One Launcher-updater"
  RMDir /r "$LOCALAPPDATA\com.onelauncher.app"

  DetailPrint "[6/7] Purging Legendary & GOGDL CLI configs and caches..."
  RMDir /r "$PROFILE\.config\legendary"
  RMDir /r "$APPDATA\legendary"
  RMDir /r "$LOCALAPPDATA\legendary"
  RMDir /r "$PROFILE\.config\gogdl"
  RMDir /r "$APPDATA\gogdl"
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
