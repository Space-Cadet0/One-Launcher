; =============================================================================
; One Launcher — Custom NSIS Uninstall Hook (electron-builder include)
; Thoroughly purges all application data, caches, OAuth/LevelDB tokens,
; bundled CLI configs (legendary / gogdl), first-party Epic/GOG registrations,
; and downloaded game directories across both per-user (current) and
; machine-wide (all / C:\Program Files\One Launcher) contexts.
; =============================================================================

!macro customUnInstall
  ; 1. Terminate any running One Launcher or bundled CLI processes
  nsExec::ExecToLog 'taskkill /F /IM "One Launcher.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "one-launcher.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "legendary.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "gogdl.exe" /T'
  Sleep 1000

  ; 2. Dynamically discover and purge custom-path installed games & first-party Epic/GOG entries via PowerShell
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$$ErrorActionPreference = 'SilentlyContinue'; $$removedPaths = @(); $$removedIds = @(); $$jsonFiles = @(\"$$env:APPDATA\one-launcher\one_launcher_installed.json\", \"$$env:APPDATA\One Launcher\one_launcher_installed.json\", \"$$env:APPDATA\com.onelauncher.app\one_launcher_installed.json\"); foreach ($$jf in $$jsonFiles) { if (Test-Path -LiteralPath $$jf) { $$data = Get-Content -LiteralPath $$jf -Raw | ConvertFrom-Json; $$items = if ($$data -is [System.Array]) { $$data } else { $$data.PSObject.Properties | ForEach-Object { $$_.Value } }; foreach ($$entry in $$items) { $$p = $$entry.installPath; $$r = [string]$$entry.runner; if ($$p -and ($$r -in @('legendary','gogdl','one_launcher') -or $$p -match '(?i)OneLauncher')) { $$removedPaths += $$p; if ($$p -match '(?i)OneLauncher') { $$parent = Split-Path -Parent $$p; if ($$parent -and $$parent -match '(?i)OneLauncher') { $$removedPaths += $$parent } }; if ($$entry.platformGameId) { $$gid = [string]$$entry.platformGameId; $$removedIds += $$gid; $$removedIds += ($$gid -replace '^(?i)(epic|gog)[-_]','') }; if ($$p.Length -gt 6 -and $$p -notmatch '^[A-Za-z]:\\$$' -and $$p -notmatch 'Steam') { if (Test-Path -LiteralPath $$p) { Remove-Item -LiteralPath $$p -Recurse -Force } } } } } }; $$legFiles = @(\"$$env:APPDATA\one-launcher\legendaryConfig\legendary\installed.json\", \"$$env:APPDATA\One Launcher\legendaryConfig\legendary\installed.json\", \"$$env:USERPROFILE\.config\legendary\installed.json\", \"$$env:APPDATA\legendary\installed.json\"); foreach ($$lf in $$legFiles) { if (Test-Path -LiteralPath $$lf) { $$ldata = Get-Content -LiteralPath $$lf -Raw | ConvertFrom-Json; if ($$ldata -is [System.Array]) { foreach ($$entry in $$ldata) { $$lp = $$entry.install_path; if ($$entry.app_name) { $$removedIds += [string]$$entry.app_name }; if ($$lp) { $$removedPaths += $$lp; if ($$lp.Length -gt 6 -and $$lp -notmatch '^[A-Za-z]:\\$$' -and $$lp -notmatch 'Steam' -and (Test-Path -LiteralPath $$lp)) { Remove-Item -LiteralPath $$lp -Recurse -Force } } } } else { foreach ($$prop in $$ldata.PSObject.Properties) { $$removedIds += [string]$$prop.Name; if ($$prop.Value.app_name) { $$removedIds += [string]$$prop.Value.app_name }; $$lp = $$prop.Value.install_path; if ($$lp) { $$removedPaths += $$lp; if ($$lp.Length -gt 6 -and $$lp -notmatch '^[A-Za-z]:\\$$' -and $$lp -notmatch 'Steam' -and (Test-Path -LiteralPath $$lp)) { Remove-Item -LiteralPath $$lp -Recurse -Force } } } } } }; $$eglDir = 'C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests'; if (Test-Path -LiteralPath $$eglDir) { Get-ChildItem -LiteralPath $$eglDir -Filter '*.item' -File | ForEach-Object { try { $$it = Get-Content -LiteralPath $$_.FullName -Raw | ConvertFrom-Json; if ($$it.InstallLocation -match '(?i)OneLauncher' -or ($$removedPaths -contains $$it.InstallLocation) -or ($$removedIds -contains $$it.AppName)) { Remove-Item -LiteralPath $$_.FullName -Force } } catch {} } }; $$eglDat = 'C:\ProgramData\Epic\UnrealEngineLauncher\LauncherInstalled.dat'; if (Test-Path -LiteralPath $$eglDat) { try { $$dat = Get-Content -LiteralPath $$eglDat -Raw | ConvertFrom-Json; if ($$dat.InstallationList) { $$dat.InstallationList = @($$dat.InstallationList | Where-Object { $$_.InstallLocation -notmatch '(?i)OneLauncher' -and ($$removedPaths -notcontains $$_.InstallLocation) -and ($$removedIds -notcontains $$_.AppName) }); $$dat | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $$eglDat -Encoding UTF8 } } catch {} }; $$gogCfg = 'C:\ProgramData\GOG.com\Galaxy\config.json'; if (Test-Path -LiteralPath $$gogCfg) { try { $$cfg = Get-Content -LiteralPath $$gogCfg -Raw | ConvertFrom-Json; if ($$cfg -and $$cfg.installationPaths) { $$cfg.installationPaths = @($$cfg.installationPaths | Where-Object { $$_ -notmatch '(?i)OneLauncher' -and ($$removedPaths -notcontains $$_) }); $$cfg | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $$gogCfg -Encoding UTF8 } } catch {} }; $$gogDb = 'C:\ProgramData\GOG.com\Galaxy\Storage\galaxy-2.0.db'; if ((Test-Path -LiteralPath $$gogDb) -and (Get-Command sqlite3.exe -ErrorAction SilentlyContinue)) { try { $$sql = \"DELETE FROM InstalledBaseProducts WHERE installationPath LIKE '%OneLauncher%'; \"; foreach ($$rid in $$removedIds) { if ($$rid -match '^\d+$$') { $$sql += \"DELETE FROM InstalledBaseProducts WHERE productId = $$rid; \" } }; $$sql += \"DELETE FROM InstalledProducts WHERE productId NOT IN (SELECT productId FROM InstalledBaseProducts);\"; & sqlite3.exe $$gogDb $$sql 2>$$null | Out-Null } catch {} }; @('HKCU:\Software\GOG.com\Games', 'HKLM:\Software\WOW6432Node\GOG.com\Games', 'HKLM:\Software\GOG.com\Games') | ForEach-Object { if (Test-Path -LiteralPath $$_) { Get-ChildItem -LiteralPath $$_ | ForEach-Object { $$gp = Get-ItemProperty -LiteralPath $$_.PSPath; if ($$gp -and ($$gp.path -match '(?i)OneLauncher' -or ($$removedPaths -contains $$gp.path) -or ($$removedIds -contains $$_.PSChildName) -or ($$removedIds -contains $$gp.gameID))) { Remove-Item -LiteralPath $$_.PSPath -Recurse -Force } } } }"`

  ; Switch to current user context for per-user AppData, LocalAppData, Profile, and User Shortcuts
  SetShellVarContext current

  ; 3. Remove default One Launcher Game Library directories
  RMDir /r "C:\Games\OneLauncher"
  RMDir /r "D:\Games\OneLauncher"
  RMDir /r "E:\Games\OneLauncher"
  RMDir /r "$PROFILE\Games\OneLauncher"
  RMDir /r "$PROFILE\OneLauncher Games"

  ; Remove parent Games directories only if completely empty (RMDir without /r)
  RMDir "C:\Games"
  RMDir "D:\Games"
  RMDir "E:\Games"
  RMDir "$PROFILE\Games"

  ; 4. Remove Electron UserData, Cache, LocalStorage (LevelDB), OAuth Partitions & SafeStorage
  RMDir /r "$APPDATA\one-launcher"
  RMDir /r "$APPDATA\One Launcher"
  RMDir /r "$APPDATA\com.onelauncher.app"
  RMDir /r "$LOCALAPPDATA\one-launcher"
  RMDir /r "$LOCALAPPDATA\One Launcher"
  RMDir /r "$LOCALAPPDATA\one-launcher-updater"
  RMDir /r "$LOCALAPPDATA\One Launcher-updater"
  RMDir /r "$LOCALAPPDATA\com.onelauncher.app"

  ; 5. Remove bundled CLI config & cache directories (legendary & gogdl)
  RMDir /r "$PROFILE\.config\legendary"
  RMDir /r "$APPDATA\legendary"
  RMDir /r "$LOCALAPPDATA\legendary"
  RMDir /r "$PROFILE\.config\gogdl"
  RMDir /r "$APPDATA\gogdl"
  RMDir "$PROFILE\.config"

  ; 6. Remove per-user application install directories & user shortcuts
  RMDir /r "$LOCALAPPDATA\Programs\One Launcher"
  RMDir /r "$LOCALAPPDATA\Programs\one-launcher"
  Delete "$DESKTOP\One Launcher.lnk"
  Delete "$SMPROGRAMS\One Launcher.lnk"
  RMDir /r "$SMPROGRAMS\One Launcher"

  ; Switch back to all-users context (required for perMachine: true NSIS uninstaller)
  SetShellVarContext all

  ; 7. Remove machine-wide Program Files directories & All-Users shortcuts
  RMDir /r "$PROGRAMFILES64\One Launcher"
  RMDir /r "$PROGRAMFILES\One Launcher"
  Delete "$DESKTOP\One Launcher.lnk"
  Delete "$SMPROGRAMS\One Launcher.lnk"
  RMDir /r "$SMPROGRAMS\One Launcher"

  ; 8. Remove temp files & Registry keys (both HKCU and HKLM)
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$$ErrorActionPreference = 'SilentlyContinue'; @('one-launcher*','OneLauncher*','One Launcher*','gogdl*','legendary*') | ForEach-Object { Get-ChildItem -Path $$env:TEMP -Filter $$_ -Force | Remove-Item -Recurse -Force }; @('HKCU:\Software\GOG.com\Games', 'HKLM:\Software\WOW6432Node\GOG.com\Games', 'HKLM:\Software\GOG.com\Games') | ForEach-Object { if (Test-Path -LiteralPath $$_) { Get-ChildItem -LiteralPath $$_ | ForEach-Object { $$gp = Get-ItemProperty -LiteralPath $$_.PSPath; if ($$gp -and $$gp.path -match '(?i)OneLauncher') { Remove-Item -LiteralPath $$_.PSPath -Recurse -Force } } } }"`

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
!macroend
