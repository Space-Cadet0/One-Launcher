@echo off
setlocal EnableExtensions DisableDelayedExpansion
title One Launcher - Complete Windows Uninstaller (Full Clean)
color 0B

echo ======================================================================
echo        ONE LAUNCHER - COMPLETE WINDOWS UNINSTALLER (FULL CLEAN)
echo ======================================================================
echo.
echo This utility will completely remove:
echo   1. One Launcher application binaries (C:\Program Files\One Launcher ^& AppData)
echo   2. All games installed via One Launcher (C:\Games\OneLauncher ^& custom paths)
echo   3. All Electron AppData, caches, LevelDB LocalStorage, and OAuth tokens
echo   4. Bundled Epic (Legendary) and GOG (gogdl) CLI configs and credentials
echo   5. Desktop/Start Menu shortcuts, temp files, and HKLM/HKCU Registry entries
echo.

if /I not "%~1"=="/Y" if /I not "%~1"=="-y" if /I not "%~1"=="/S" (
    set /P "CONFIRM=Are you sure you want to completely uninstall One Launcher and all its data? [Y/N]: "
    if /I not "%CONFIRM%"=="Y" if /I not "%CONFIRM%"=="YES" (
        echo.
        echo Uninstallation cancelled by user.
        pause
        exit /b 0
    )
)

echo.
echo Executing deep cleanup via PowerShell...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'SilentlyContinue'; " ^
  "function Remove-Safe([string]$p, [string]$lbl) { " ^
  "  if ([string]::IsNullOrWhiteSpace($p)) { return }; " ^
  "  $n = $p.TrimEnd('\','/'); " ^
  "  if ($n.Length -le 3 -or $n -match '^[A-Za-z]:$' -or $n -match '(?i)\\Windows$' -or $n -match '(?i)\\Program Files(\s*\(x86\))?$' -or $n -match '(?i)\\Steam(\\|$)' -or $n -match '(?i)\\SteamApps') { return }; " ^
  "  if (Test-Path -LiteralPath $p) { " ^
  "    Write-Host ('  [DEL]  ' + $lbl + ': ' + $p) -ForegroundColor Gray; " ^
  "    Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue; " ^
  "    if (Test-Path -LiteralPath $p) { cmd.exe /c \"rmdir /s /q `\"$p`\"\" 2>$null | Out-Null } " ^
  "  } " ^
  "}; " ^
  "Write-Host '[1/7] Terminating running One Launcher & CLI processes...' -ForegroundColor Yellow; " ^
  "@('One Launcher','one-launcher','legendary','gogdl') | ForEach-Object { " ^
  "  Get-Process -Name $_ -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; " ^
  "  & taskkill.exe /F /IM \"$_.exe\" /T 2>$null | Out-Null " ^
  "}; " ^
  "Start-Sleep -Seconds 1; " ^
  "Write-Host '[2/7] Discovering & removing installed games from manifests...' -ForegroundColor Yellow; " ^
  "$removedPaths = @(); $removedIds = @(); " ^
  "@(\"$env:APPDATA\one-launcher\one_launcher_installed.json\", \"$env:APPDATA\One Launcher\one_launcher_installed.json\", \"$env:APPDATA\com.onelauncher.app\one_launcher_installed.json\", \"$env:USERPROFILE\.one-launcher\one_launcher_installed.json\") | ForEach-Object { " ^
  "  if (Test-Path -LiteralPath $_) { " ^
  "    try { " ^
  "      $data = Get-Content -LiteralPath $_ -Raw | ConvertFrom-Json; " ^
  "      $items = if ($data -is [System.Array]) { $data } else { $data.PSObject.Properties | ForEach-Object { $_.Value } }; " ^
  "      foreach ($entry in $items) { " ^
  "        $ip = $entry.installPath; $r = [string]$entry.runner; " ^
  "        if ($ip -and ($r -in @('legendary','gogdl','one_launcher') -or $ip -match '(?i)OneLauncher')) { " ^
  "          $removedPaths += $ip; " ^
  "          if ($ip -match '(?i)OneLauncher') { $parent = Split-Path -Parent $ip; if ($parent -and $parent -match '(?i)OneLauncher') { $removedPaths += $parent } }; " ^
  "          if ($entry.platformGameId) { $gid = [string]$entry.platformGameId; $removedIds += $gid; $removedIds += ($gid -replace '^(?i)(epic|gog)[-_]','') }; " ^
  "          if ($ip -notmatch '(?i)\\Steam(\\|$)') { Remove-Safe $ip ('Installed Game (' + $entry.title + ')') } " ^
  "        } " ^
  "      } " ^
  "    } catch {} " ^
  "  } " ^
  "}; " ^
  "@(\"$env:APPDATA\one-launcher\legendaryConfig\legendary\installed.json\", \"$env:APPDATA\One Launcher\legendaryConfig\legendary\installed.json\", \"$env:APPDATA\com.onelauncher.app\legendaryConfig\legendary\installed.json\", \"$env:USERPROFILE\.config\legendary\installed.json\", \"$env:APPDATA\legendary\installed.json\") | ForEach-Object { " ^
  "  if (Test-Path -LiteralPath $_) { " ^
  "    try { " ^
  "      $ldata = Get-Content -LiteralPath $_ -Raw | ConvertFrom-Json; " ^
  "      if ($ldata -is [System.Array]) { " ^
  "        foreach ($entry in $ldata) { " ^
  "          $lp = $entry.install_path; if ($entry.app_name) { $removedIds += [string]$entry.app_name }; " ^
  "          if ($lp) { $removedPaths += $lp; if ($lp -notmatch '(?i)\\Steam(\\|$)') { Remove-Safe $lp ('Epic Game (' + $entry.app_name + ')') } } " ^
  "        } " ^
  "      } else { " ^
  "        foreach ($prop in $ldata.PSObject.Properties) { " ^
  "          $removedIds += [string]$prop.Name; if ($prop.Value.app_name) { $removedIds += [string]$prop.Value.app_name }; " ^
  "          $lp = $prop.Value.install_path; " ^
  "          if ($lp) { $removedPaths += $lp; if ($lp -notmatch '(?i)\\Steam(\\|$)') { Remove-Safe $lp ('Epic Game (' + $prop.Name + ')') } } " ^
  "        } " ^
  "      } " ^
  "    } catch {} " ^
  "  } " ^
  "}; " ^
  "$eglDir = 'C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests'; " ^
  "if (Test-Path -LiteralPath $eglDir) { " ^
  "  Get-ChildItem -LiteralPath $eglDir -Filter '*.item' -File | ForEach-Object { " ^
  "    try { $it = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json; if ($it.InstallLocation -match '(?i)OneLauncher' -or ($removedPaths -contains $it.InstallLocation) -or ($removedIds -contains $it.AppName)) { Remove-Item -LiteralPath $_.FullName -Force } } catch {} " ^
  "  } " ^
  "}; " ^
  "$eglDat = 'C:\ProgramData\Epic\UnrealEngineLauncher\LauncherInstalled.dat'; " ^
  "if (Test-Path -LiteralPath $eglDat) { " ^
  "  try { $dat = Get-Content -LiteralPath $eglDat -Raw | ConvertFrom-Json; if ($dat.InstallationList) { $dat.InstallationList = @($dat.InstallationList | Where-Object { $_.InstallLocation -notmatch '(?i)OneLauncher' -and ($removedPaths -notcontains $_.InstallLocation) -and ($removedIds -notcontains $_.AppName) }); $dat | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $eglDat -Encoding UTF8 } } catch {} " ^
  "}; " ^
  "$gogCfg = 'C:\ProgramData\GOG.com\Galaxy\config.json'; " ^
  "if (Test-Path -LiteralPath $gogCfg) { " ^
  "  try { $cfg = Get-Content -LiteralPath $gogCfg -Raw | ConvertFrom-Json; if ($cfg -and $cfg.installationPaths) { $cfg.installationPaths = @($cfg.installationPaths | Where-Object { $_ -notmatch '(?i)OneLauncher' -and ($removedPaths -notcontains $_) }); $cfg | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $gogCfg -Encoding UTF8 } } catch {} " ^
  "}; " ^
  "$gogDb = @('C:\ProgramData\GOG.com\Galaxy\storage\galaxy-2.0.db','C:\ProgramData\GOG.com\Galaxy\Storage\galaxy-2.0.db') | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1; " ^
  "if ($gogDb) { " ^
  "  try { " ^
  "    $sql = \"CREATE TEMP TABLE IF NOT EXISTS _ol_pids (productId INTEGER PRIMARY KEY); INSERT OR IGNORE INTO _ol_pids SELECT productId FROM InstalledBaseProducts WHERE installationPath LIKE '%OneLauncher%'; \"; " ^
  "    foreach ($rid in $removedIds) { if ($rid -match '^\d+$') { $sql += \"INSERT OR IGNORE INTO _ol_pids VALUES ($rid); \" } }; " ^
  "    $sql += \"DELETE FROM PlayTaskLaunchParameters WHERE playTaskId IN (SELECT id FROM PlayTasks WHERE gameReleaseKey IN (SELECT 'gog_' || productId FROM _ol_pids)); DELETE FROM PlayTaskLaunchParameters WHERE playTaskId IN (SELECT id FROM PlayTasks WHERE releaseKey IN (SELECT 'gog_' || productId FROM _ol_pids)); DELETE FROM PlayTasks WHERE gameReleaseKey IN (SELECT 'gog_' || productId FROM _ol_pids); DELETE FROM PlayTasks WHERE releaseKey IN (SELECT 'gog_' || productId FROM _ol_pids); DELETE FROM ProductSettings WHERE gameReleaseKey IN (SELECT 'gog_' || productId FROM _ol_pids); DELETE FROM ProductSettings WHERE releaseKey IN (SELECT 'gog_' || productId FROM _ol_pids); DELETE FROM GameFiles WHERE productId IN (SELECT productId FROM _ol_pids); DELETE FROM GameFiles WHERE releaseKey IN (SELECT 'gog_' || productId FROM _ol_pids); DELETE FROM BaseModificationTargets WHERE productId IN (SELECT productId FROM _ol_pids); DELETE FROM ModificationTargets WHERE productId IN (SELECT productId FROM _ol_pids); DELETE FROM ImportedLatestBuildIds WHERE productId IN (SELECT productId FROM _ol_pids); DELETE FROM InstalledBaseProducts WHERE productId IN (SELECT productId FROM _ol_pids) OR installationPath LIKE '%OneLauncher%'; DELETE FROM InstalledProducts WHERE productId IN (SELECT productId FROM _ol_pids) OR productId NOT IN (SELECT productId FROM InstalledBaseProducts); DELETE FROM ProductStates WHERE productId IN (SELECT productId FROM _ol_pids); DROP TABLE IF EXISTS _ol_pids;\"; " ^
  "    $nodeExe = @(\"$env:ProgramFiles\One Launcher\One Launcher.exe\",\"${env:ProgramFiles(x86)}\One Launcher\One Launcher.exe\",\"$env:LOCALAPPDATA\Programs\One Launcher\One Launcher.exe\",\"$env:LOCALAPPDATA\Programs\one-launcher\One Launcher.exe\") | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1; " ^
  "    if (-not $nodeExe -and (Get-Command node.exe -ErrorAction SilentlyContinue)) { $nodeExe = (Get-Command node.exe).Source }; " ^
  "    if ($nodeExe) { $env:ELECTRON_RUN_AS_NODE = '1'; $env:OL_GOG_DB = $gogDb; $env:OL_GOG_SQL = $sql; & $nodeExe -e \"const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.OL_GOG_DB);try{db.exec('PRAGMA busy_timeout = 5000;');}catch{}for(const s of process.env.OL_GOG_SQL.split(';').map(x=>x.trim()).filter(Boolean)){try{db.exec(s+';')}catch{}}db.close();\" 2>$null | Out-Null; Remove-Item Env:\ELECTRON_RUN_AS_NODE,Env:\OL_GOG_DB,Env:\OL_GOG_SQL -ErrorAction SilentlyContinue } elseif (Get-Command sqlite3.exe -ErrorAction SilentlyContinue) { & sqlite3.exe $gogDb $sql 2>$null | Out-Null } " ^
  "  } catch {} " ^
  "}; " ^
  "Write-Host '[3/7] Removing One Launcher game library folders...' -ForegroundColor Yellow; " ^
  "$libDirs = @('C:\Games\OneLauncher','D:\Games\OneLauncher','E:\Games\OneLauncher',\"$env:USERPROFILE\Games\OneLauncher\",\"$env:USERPROFILE\OneLauncher Games\"); " ^
  "Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Root) { $dl = Join-Path $_.Root 'Games\OneLauncher'; if ($libDirs -notcontains $dl) { $libDirs += $dl } } }; " ^
  "$libDirs | ForEach-Object { Remove-Safe $_ 'Game Library' }; " ^
  "$parentDirs = @('C:\Games','D:\Games','E:\Games',\"$env:USERPROFILE\Games\"); " ^
  "Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Root) { $dp = Join-Path $_.Root 'Games'; if ($parentDirs -notcontains $dp) { $parentDirs += $dp } } }; " ^
  "$parentDirs | ForEach-Object { " ^
  "  if (Test-Path -LiteralPath $_) { " ^
  "    $items = Get-ChildItem -LiteralPath $_ -Force -ErrorAction SilentlyContinue; " ^
  "    if (-not $items -or $items.Count -eq 0) { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue } " ^
  "  } " ^
  "}; " ^
  "Write-Host '[4/7] Running existing NSIS uninstaller & removing binaries...' -ForegroundColor Yellow; " ^
  "@(\"$env:ProgramFiles\One Launcher\Uninstall One Launcher.exe\",\"${env:ProgramFiles(x86)}\One Launcher\Uninstall One Launcher.exe\",\"$env:LOCALAPPDATA\Programs\One Launcher\Uninstall One Launcher.exe\",\"$env:LOCALAPPDATA\Programs\one-launcher\Uninstall One Launcher.exe\") | ForEach-Object { " ^
  "  if ($_ -and (Test-Path -LiteralPath $_)) { Start-Process -FilePath $_ -ArgumentList '/S' -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue } " ^
  "}; " ^
  "@(\"$env:ProgramFiles\One Launcher\",\"${env:ProgramFiles(x86)}\One Launcher\",\"$env:LOCALAPPDATA\Programs\One Launcher\",\"$env:LOCALAPPDATA\Programs\one-launcher\") | ForEach-Object { if ($_) { Remove-Safe $_ 'Application Folder' } }; " ^
  "Write-Host '[5/7] Purging Electron AppData, LocalStorage, OAuth & SafeStorage...' -ForegroundColor Yellow; " ^
  "@(\"$env:APPDATA\one-launcher\",\"$env:APPDATA\One Launcher\",\"$env:APPDATA\com.onelauncher.app\",\"$env:APPDATA\universal-game-library\",\"$env:LOCALAPPDATA\one-launcher\",\"$env:LOCALAPPDATA\One Launcher\",\"$env:LOCALAPPDATA\one-launcher-updater\",\"$env:LOCALAPPDATA\One Launcher-updater\",\"$env:LOCALAPPDATA\com.onelauncher.app\",\"$env:LOCALAPPDATA\universal-game-library\",\"$env:USERPROFILE\.one-launcher\",\"$env:USERPROFILE\.universal-game-library\") | ForEach-Object { Remove-Safe $_ 'Electron Data' }; " ^
  "Write-Host '[6/7] Purging Legendary & GOGDL CLI configs and caches...' -ForegroundColor Yellow; " ^
  "@(\"$env:USERPROFILE\.config\legendary\",\"$env:APPDATA\legendary\",\"$env:LOCALAPPDATA\legendary\",\"$env:USERPROFILE\.config\gogdl\",\"$env:APPDATA\gogdl\",\"$env:USERPROFILE\.config\heroic_gogdl\",\"$env:APPDATA\heroic_gogdl\",\"$env:LOCALAPPDATA\heroic_gogdl\",\"$env:APPDATA\one-launcher\gogdlConfig\",\"$env:APPDATA\One Launcher\gogdlConfig\") | ForEach-Object { Remove-Safe $_ 'CLI Config' }; " ^
  "if (Test-Path -LiteralPath \"$env:USERPROFILE\.config\") { " ^
  "  $rem = Get-ChildItem -LiteralPath \"$env:USERPROFILE\.config\" -Force -ErrorAction SilentlyContinue; " ^
  "  if (-not $rem -or $rem.Count -eq 0) { Remove-Item -LiteralPath \"$env:USERPROFILE\.config\" -Force -ErrorAction SilentlyContinue } " ^
  "}; " ^
  "Write-Host '[7/7] Cleaning up temp files, shortcuts, and Windows Registry...' -ForegroundColor Yellow; " ^
  "@('one-launcher*','OneLauncher*','One Launcher*','gogdl*','legendary*') | ForEach-Object { " ^
  "  Get-ChildItem -Path $env:TEMP -Filter $_ -Force -ErrorAction SilentlyContinue | ForEach-Object { Remove-Safe $_.FullName 'Temp Item' } " ^
  "}; " ^
  "@(\"$env:USERPROFILE\Desktop\One Launcher.lnk\",\"$env:PUBLIC\Desktop\One Launcher.lnk\",\"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\One Launcher.lnk\",\"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\One Launcher\",\"$env:ProgramData\Microsoft\Windows\Start Menu\Programs\One Launcher.lnk\",\"$env:ProgramData\Microsoft\Windows\Start Menu\Programs\One Launcher\") | ForEach-Object { " ^
  "  if ($_ -and (Test-Path -LiteralPath $_)) { Remove-Item -LiteralPath $_ -Recurse -Force -ErrorAction SilentlyContinue } " ^
  "}; " ^
  "@('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.onelauncher.app','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{com.onelauncher.app}','HKCU:\Software\com.onelauncher.app','HKCU:\Software\One Launcher','HKCU:\Software\one-launcher','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.onelauncher.app','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{com.onelauncher.app}','HKLM:\Software\com.onelauncher.app','HKLM:\Software\One Launcher','HKLM:\Software\one-launcher') | ForEach-Object { " ^
  "  if (Test-Path -LiteralPath $_) { Remove-Item -LiteralPath $_ -Recurse -Force -ErrorAction SilentlyContinue } " ^
  "}; " ^
  "@('HKCU:\Software\GOG.com\Games', 'HKLM:\Software\WOW6432Node\GOG.com\Games', 'HKLM:\Software\GOG.com\Games') | ForEach-Object { " ^
  "  if (Test-Path -LiteralPath $_) { " ^
  "    Get-ChildItem -LiteralPath $_ -ErrorAction SilentlyContinue | ForEach-Object { " ^
  "      $gp = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue; " ^
  "      if ($gp -and ($gp.path -match '(?i)OneLauncher' -or ($removedPaths -contains $gp.path) -or ($removedIds -contains $_.PSChildName) -or ($removedIds -contains $gp.gameID))) { Remove-Item -LiteralPath $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue } " ^
  "    } " ^
  "  } " ^
  "}; " ^
  "@('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall') | ForEach-Object { " ^
  "  if (Test-Path -LiteralPath $_) { " ^
  "    Get-ChildItem -LiteralPath $_ -ErrorAction SilentlyContinue | ForEach-Object { " ^
  "      $p = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue; " ^
  "      if ($p -and ($p.DisplayName -eq 'One Launcher' -or $p.DisplayName -eq 'one-launcher')) { Remove-Item -LiteralPath $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue } " ^
  "    } " ^
  "  } " ^
  "}; " ^
  "Write-Host ''; Write-Host 'Complete! One Launcher and all related files have been removed.' -ForegroundColor Green"

echo.
if /I not "%~1"=="/S" (
    pause
)
endlocal
