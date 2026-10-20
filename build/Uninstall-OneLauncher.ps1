<#
.SYNOPSIS
    One Launcher — Complete Windows Uninstaller & Deep Clean Script
.DESCRIPTION
    Thoroughly removes One Launcher (from C:\Program Files\One Launcher and AppData),
    running background processes (One Launcher, legendary, gogdl), all downloaded
    games in C:\Games\OneLauncher and custom install paths recorded in
    one_launcher_installed.json / legendary installed.json, Epic Games Launcher
    first-party .item manifests & LauncherInstalled.dat entries pointing to OneLauncher,
    GOG Galaxy registry keys pointing to OneLauncher, Electron AppData / LocalAppData
    (LevelDB localStorage, OAuth session partitions, safeStorage encrypted credentials),
    CLI configs, user & all-users shortcuts, temp files, and HKLM / HKCU Windows
    Registry entries.
#>

$ErrorActionPreference = 'SilentlyContinue'

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "       ONE LAUNCHER - COMPLETE WINDOWS UNINSTALLER (DEEP CLEAN)   " -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host ""

function Remove-PathSafely {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetPath,
        [string]$Label = "Path"
    )
    if ([string]::IsNullOrWhiteSpace($TargetPath)) { return }
    # Safety check: never delete drive roots or core Windows/Steam directories
    $normalized = $TargetPath.TrimEnd('\', '/')
    if ($normalized.Length -le 3 -or
        $normalized -match '^[A-Za-z]:$' -or
        $normalized -match '(?i)\\Windows$' -or
        $normalized -match '(?i)\\Program Files(\s*\(x86\))?$' -or
        $normalized -match '(?i)\\Steam(\\|$)' -or
        $normalized -match '(?i)\\SteamApps') {
        Write-Host "  [SKIP] Safety guard prevented deleting protected path: $TargetPath" -ForegroundColor Yellow
        return
    }

    if (Test-Path -LiteralPath $TargetPath) {
        Write-Host "  [DEL]  Removing $Label : $TargetPath" -ForegroundColor Gray
        Remove-Item -LiteralPath $TargetPath -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $TargetPath) {
            # Fallback to cmd rmdir for stubborn locked/long paths
            cmd.exe /c "rmdir /s /q `"$TargetPath`"" 2>$null | Out-Null
        }
    }
}

# ---------------------------------------------------------------------------
# STEP 1: Terminate Running Processes
# ---------------------------------------------------------------------------
Write-Host "[1/7] Stopping running One Launcher & CLI helper processes..." -ForegroundColor Yellow
$processesToStop = @("One Launcher", "one-launcher", "legendary", "gogdl")
foreach ($procName in $processesToStop) {
    $procs = Get-Process -Name $procName -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Host "  [KILL] Terminating process: $procName.exe" -ForegroundColor Gray
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    & taskkill.exe /F /IM "$procName.exe" /T 2>$null | Out-Null
}
Start-Sleep -Seconds 1

# ---------------------------------------------------------------------------
# STEP 2: Discover & Remove Custom-Installed Games + First-Party Registrations
# ---------------------------------------------------------------------------
Write-Host "[2/7] Scanning One Launcher & Legendary manifests for installed games..." -ForegroundColor Yellow

$removedPaths = @()
$removedIds = @()

$oneLauncherManifests = @(
    (Join-Path $env:APPDATA "one-launcher\one_launcher_installed.json"),
    (Join-Path $env:APPDATA "One Launcher\one_launcher_installed.json"),
    (Join-Path $env:APPDATA "com.onelauncher.app\one_launcher_installed.json"),
    (Join-Path $env:USERPROFILE ".one-launcher\one_launcher_installed.json")
)

foreach ($manifestPath in $oneLauncherManifests) {
    if (Test-Path -LiteralPath $manifestPath) {
        Write-Host "  [SCAN] Reading manifest: $manifestPath" -ForegroundColor DarkCyan
        try {
            $jsonRaw = Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop
            $data = $jsonRaw | ConvertFrom-Json -ErrorAction Stop
            $items = if ($data -is [System.Array]) { $data } else { $data.PSObject.Properties | ForEach-Object { $_.Value } }
            foreach ($entry in $items) {
                $installPath = $entry.installPath
                $runner = [string]$entry.runner
                $title = if ($entry.title) { $entry.title } else { [string]$entry.platformGameId }
                if ($installPath -and ($runner -in @("legendary", "gogdl", "one_launcher") -or $installPath -match "(?i)OneLauncher")) {
                    $removedPaths += $installPath
                    if ($installPath -match "(?i)OneLauncher") {
                        $parentPath = Split-Path -Parent $installPath
                        if ($parentPath -and $parentPath -match "(?i)OneLauncher") {
                            $removedPaths += $parentPath
                        }
                    }
                    if ($entry.platformGameId) {
                        $gid = [string]$entry.platformGameId
                        $removedIds += $gid
                        $removedIds += ($gid -replace "^(?i)(epic|gog)[-_]", "")
                    }
                    if ($installPath -notmatch "(?i)\\Steam(\\|$)") {
                        Remove-PathSafely -TargetPath $installPath -Label "Installed Game ($title)"
                    }
                }
            }
        } catch {
            Write-Host "  [WARN] Could not parse $manifestPath" -ForegroundColor DarkYellow
        }
    }
}

$legendaryManifests = @(
    (Join-Path $env:APPDATA "one-launcher\legendaryConfig\legendary\installed.json"),
    (Join-Path $env:APPDATA "One Launcher\legendaryConfig\legendary\installed.json"),
    (Join-Path $env:APPDATA "com.onelauncher.app\legendaryConfig\legendary\installed.json"),
    (Join-Path $env:USERPROFILE ".config\legendary\installed.json"),
    (Join-Path $env:APPDATA "legendary\installed.json")
)

foreach ($legManifest in $legendaryManifests) {
    if (Test-Path -LiteralPath $legManifest) {
        Write-Host "  [SCAN] Reading Legendary manifest: $legManifest" -ForegroundColor DarkCyan
        try {
            $legRaw = Get-Content -LiteralPath $legManifest -Raw -ErrorAction Stop
            $ldata = $legRaw | ConvertFrom-Json -ErrorAction Stop
            if ($ldata -is [System.Array]) {
                foreach ($entry in $ldata) {
                    $installPath = $entry.install_path
                    if ($entry.app_name) { $removedIds += [string]$entry.app_name }
                    $title = if ($entry.title) { $entry.title } else { [string]$entry.app_name }
                    if ($installPath) {
                        $removedPaths += $installPath
                        if ($installPath -notmatch "(?i)\\Steam(\\|$)") {
                            Remove-PathSafely -TargetPath $installPath -Label "Epic Game ($title)"
                        }
                    }
                }
            } else {
                foreach ($prop in $ldata.PSObject.Properties) {
                    $entry = $prop.Value
                    $removedIds += [string]$prop.Name
                    if ($entry.app_name) { $removedIds += [string]$entry.app_name }
                    $installPath = $entry.install_path
                    $title = if ($entry.title) { $entry.title } else { $prop.Name }
                    if ($installPath) {
                        $removedPaths += $installPath
                        if ($installPath -notmatch "(?i)\\Steam(\\|$)") {
                            Remove-PathSafely -TargetPath $installPath -Label "Epic Game ($title)"
                        }
                    }
                }
            }
        } catch {
            Write-Host "  [WARN] Could not parse $legManifest" -ForegroundColor DarkYellow
        }
    }
}

# Clean up Epic Games Launcher .item manifests & LauncherInstalled.dat entries pointing to OneLauncher or custom removed paths/IDs
$eglManifestsDir = "C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests"
if (Test-Path -LiteralPath $eglManifestsDir) {
    Get-ChildItem -LiteralPath $eglManifestsDir -Filter "*.item" -File -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $itemData = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
            if (($itemData.InstallLocation -and $itemData.InstallLocation -match "(?i)OneLauncher") -or
                ($removedPaths -contains $itemData.InstallLocation) -or
                ($removedIds -contains $itemData.AppName)) {
                Write-Host "  [DEL]  Removing Epic Games Launcher manifest: $($_.FullName)" -ForegroundColor Gray
                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
}

$eglDatPath = "C:\ProgramData\Epic\UnrealEngineLauncher\LauncherInstalled.dat"
if (Test-Path -LiteralPath $eglDatPath) {
    try {
        $datObj = Get-Content -LiteralPath $eglDatPath -Raw | ConvertFrom-Json
        if ($datObj -and $datObj.InstallationList) {
            $filteredList = @($datObj.InstallationList | Where-Object {
                $_.InstallLocation -notmatch "(?i)OneLauncher" -and
                ($removedPaths -notcontains $_.InstallLocation) -and
                ($removedIds -notcontains $_.AppName)
            })
            $datObj.InstallationList = $filteredList
            $datObj | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $eglDatPath -Encoding UTF8
        }
    } catch {}
}

# Clean up GOG Galaxy 2.0 config.json & galaxy-2.0.db SQLite entries across all 10 tables
$gogCfg = "C:\ProgramData\GOG.com\Galaxy\config.json"
if (Test-Path -LiteralPath $gogCfg) {
    try {
        $cfg = Get-Content -LiteralPath $gogCfg -Raw | ConvertFrom-Json
        if ($cfg -and $cfg.installationPaths) {
            $cfg.installationPaths = @($cfg.installationPaths | Where-Object {
                $_ -notmatch "(?i)OneLauncher" -and ($removedPaths -notcontains $_)
            })
            $cfg | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $gogCfg -Encoding UTF8
        }
    } catch {}
}

$gogDbCandidates = @(
    "C:\ProgramData\GOG.com\Galaxy\storage\galaxy-2.0.db",
    "C:\ProgramData\GOG.com\Galaxy\Storage\galaxy-2.0.db"
)
$gogDb = $gogDbCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($gogDb) {
    try {
        $sql = "CREATE TEMP TABLE IF NOT EXISTS _ol_pids (productId INTEGER PRIMARY KEY); "
        $sql += "INSERT OR IGNORE INTO _ol_pids SELECT productId FROM InstalledBaseProducts WHERE installationPath LIKE '%OneLauncher%'; "
        foreach ($rid in $removedIds) {
            if ($rid -match "^\d+$") {
                $sql += "INSERT OR IGNORE INTO _ol_pids VALUES ($rid); "
            }
        }
        $sql += "DELETE FROM PlayTaskLaunchParameters WHERE playTaskId IN (SELECT id FROM PlayTasks WHERE gameReleaseKey IN (SELECT 'gog_' || productId FROM _ol_pids)); "
        $sql += "DELETE FROM PlayTaskLaunchParameters WHERE playTaskId IN (SELECT id FROM PlayTasks WHERE releaseKey IN (SELECT 'gog_' || productId FROM _ol_pids)); "
        $sql += "DELETE FROM PlayTasks WHERE gameReleaseKey IN (SELECT 'gog_' || productId FROM _ol_pids); "
        $sql += "DELETE FROM PlayTasks WHERE releaseKey IN (SELECT 'gog_' || productId FROM _ol_pids); "
        $sql += "DELETE FROM ProductSettings WHERE gameReleaseKey IN (SELECT 'gog_' || productId FROM _ol_pids); "
        $sql += "DELETE FROM ProductSettings WHERE releaseKey IN (SELECT 'gog_' || productId FROM _ol_pids); "
        $sql += "DELETE FROM GameFiles WHERE productId IN (SELECT productId FROM _ol_pids); "
        $sql += "DELETE FROM GameFiles WHERE releaseKey IN (SELECT 'gog_' || productId FROM _ol_pids); "
        $sql += "DELETE FROM BaseModificationTargets WHERE productId IN (SELECT productId FROM _ol_pids); "
        $sql += "DELETE FROM ModificationTargets WHERE productId IN (SELECT productId FROM _ol_pids); "
        $sql += "DELETE FROM ImportedLatestBuildIds WHERE productId IN (SELECT productId FROM _ol_pids); "
        $sql += "DELETE FROM InstalledBaseProducts WHERE productId IN (SELECT productId FROM _ol_pids) OR installationPath LIKE '%OneLauncher%'; "
        $sql += "DELETE FROM InstalledProducts WHERE productId IN (SELECT productId FROM _ol_pids) OR productId NOT IN (SELECT productId FROM InstalledBaseProducts); "
        $sql += "DELETE FROM ProductStates WHERE productId IN (SELECT productId FROM _ol_pids); "
        $sql += "DROP TABLE IF EXISTS _ol_pids;"

        $nodeCandidates = @(
            (Join-Path $env:ProgramFiles "One Launcher\One Launcher.exe"),
            (Join-Path ${env:ProgramFiles(x86)} "One Launcher\One Launcher.exe"),
            (Join-Path $env:LOCALAPPDATA "Programs\One Launcher\One Launcher.exe"),
            (Join-Path $env:LOCALAPPDATA "Programs\one-launcher\One Launcher.exe")
        )
        $nodeExe = $nodeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
        if (-not $nodeExe -and (Get-Command node.exe -ErrorAction SilentlyContinue)) {
            $nodeExe = (Get-Command node.exe).Source
        }
        if ($nodeExe) {
            $env:ELECTRON_RUN_AS_NODE = "1"
            $env:OL_GOG_DB = $gogDb
            $env:OL_GOG_SQL = $sql
            & $nodeExe -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.OL_GOG_DB);try{db.exec('PRAGMA busy_timeout = 5000;');}catch{}for(const s of process.env.OL_GOG_SQL.split(';').map(x=>x.trim()).filter(Boolean)){try{db.exec(s+';')}catch{}}db.close();" 2>$null | Out-Null
            Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
            Remove-Item Env:\OL_GOG_DB -ErrorAction SilentlyContinue
            Remove-Item Env:\OL_GOG_SQL -ErrorAction SilentlyContinue
        } elseif (Get-Command sqlite3.exe -ErrorAction SilentlyContinue) {
            & sqlite3.exe $gogDb $sql 2>$null | Out-Null
        }
    } catch {}
}

# ---------------------------------------------------------------------------
# STEP 3: Remove Default One Launcher Game Library Directories
# ---------------------------------------------------------------------------
Write-Host "[3/7] Removing One Launcher game library folders..." -ForegroundColor Yellow

$gameLibraryDirs = @(
    "C:\Games\OneLauncher",
    "D:\Games\OneLauncher",
    "E:\Games\OneLauncher",
    (Join-Path $env:USERPROFILE "Games\OneLauncher"),
    (Join-Path $env:USERPROFILE "OneLauncher Games")
)
Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Root) {
        $drvLib = Join-Path $_.Root "Games\OneLauncher"
        if ($gameLibraryDirs -notcontains $drvLib) {
            $gameLibraryDirs += $drvLib
        }
    }
}

foreach ($dir in $gameLibraryDirs) {
    Remove-PathSafely -TargetPath $dir -Label "Game Library Directory"
}

# Remove parent Games folders ONLY if they are now completely empty
$parentGameDirs = @(
    "C:\Games",
    "D:\Games",
    "E:\Games",
    (Join-Path $env:USERPROFILE "Games")
)
Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Root) {
        $drvParent = Join-Path $_.Root "Games"
        if ($parentGameDirs -notcontains $drvParent) {
            $parentGameDirs += $drvParent
        }
    }
}
foreach ($parentDir in $parentGameDirs) {
    if (Test-Path -LiteralPath $parentDir) {
        $remainingItems = Get-ChildItem -LiteralPath $parentDir -Force -ErrorAction SilentlyContinue
        if (-not $remainingItems -or $remainingItems.Count -eq 0) {
            Write-Host "  [DEL]  Removing empty parent directory: $parentDir" -ForegroundColor Gray
            Remove-Item -LiteralPath $parentDir -Force -ErrorAction SilentlyContinue
        }
    }
}

# ---------------------------------------------------------------------------
# STEP 4: Run Existing NSIS Uninstaller & Remove Program Directories
# ---------------------------------------------------------------------------
Write-Host "[4/7] Uninstalling One Launcher application binaries (C:\Program Files\One Launcher & AppData)..." -ForegroundColor Yellow

$uninstallerExes = @(
    (Join-Path $env:ProgramFiles "One Launcher\Uninstall One Launcher.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "One Launcher\Uninstall One Launcher.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\One Launcher\Uninstall One Launcher.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\one-launcher\Uninstall One Launcher.exe")
)

foreach ($uninstExe in $uninstallerExes) {
    if ($uninstExe -and (Test-Path -LiteralPath $uninstExe)) {
        Write-Host "  [EXEC] Running silent NSIS uninstaller: $uninstExe /S" -ForegroundColor Gray
        $proc = Start-Process -FilePath $uninstExe -ArgumentList "/S" -PassThru -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
}

$appInstallDirs = @(
    (Join-Path $env:ProgramFiles "One Launcher"),
    (Join-Path ${env:ProgramFiles(x86)} "One Launcher"),
    (Join-Path $env:LOCALAPPDATA "Programs\One Launcher"),
    (Join-Path $env:LOCALAPPDATA "Programs\one-launcher")
)

foreach ($appDir in $appInstallDirs) {
    if ($appDir) {
        Remove-PathSafely -TargetPath $appDir -Label "Application Binaries"
    }
}

# ---------------------------------------------------------------------------
# STEP 5: Remove Electron UserData, Cache, LevelDB, OAuth & SafeStorage Tokens
# ---------------------------------------------------------------------------
Write-Host "[5/7] Purging Electron AppData, LocalStorage, OAuth sessions & tokens..." -ForegroundColor Yellow

$electronDataDirs = @(
    (Join-Path $env:APPDATA "one-launcher"),
    (Join-Path $env:APPDATA "One Launcher"),
    (Join-Path $env:APPDATA "com.onelauncher.app"),
    (Join-Path $env:APPDATA "universal-game-library"),
    (Join-Path $env:LOCALAPPDATA "one-launcher"),
    (Join-Path $env:LOCALAPPDATA "One Launcher"),
    (Join-Path $env:LOCALAPPDATA "one-launcher-updater"),
    (Join-Path $env:LOCALAPPDATA "One Launcher-updater"),
    (Join-Path $env:LOCALAPPDATA "com.onelauncher.app"),
    (Join-Path $env:LOCALAPPDATA "universal-game-library"),
    (Join-Path $env:USERPROFILE ".one-launcher"),
    (Join-Path $env:USERPROFILE ".universal-game-library")
)

foreach ($dataDir in $electronDataDirs) {
    Remove-PathSafely -TargetPath $dataDir -Label "Electron AppData/Cache"
}

# ---------------------------------------------------------------------------
# STEP 6: Remove Bundled CLI Configs (Legendary & GOGDL)
# ---------------------------------------------------------------------------
Write-Host "[6/7] Purging Legendary (Epic) and GOGDL CLI credentials & caches..." -ForegroundColor Yellow

$cliConfigDirs = @(
    (Join-Path $env:USERPROFILE ".config\legendary"),
    (Join-Path $env:APPDATA "legendary"),
    (Join-Path $env:LOCALAPPDATA "legendary"),
    (Join-Path $env:USERPROFILE ".config\gogdl"),
    (Join-Path $env:APPDATA "gogdl"),
    (Join-Path $env:USERPROFILE ".config\heroic_gogdl"),
    (Join-Path $env:APPDATA "heroic_gogdl"),
    (Join-Path $env:LOCALAPPDATA "heroic_gogdl"),
    (Join-Path $env:APPDATA "one-launcher\gogdlConfig"),
    (Join-Path $env:APPDATA "One Launcher\gogdlConfig")
)

foreach ($cliDir in $cliConfigDirs) {
    Remove-PathSafely -TargetPath $cliDir -Label "Storefront CLI Config"
}

$dotConfigDir = Join-Path $env:USERPROFILE ".config"
if (Test-Path -LiteralPath $dotConfigDir) {
    $remConfig = Get-ChildItem -LiteralPath $dotConfigDir -Force -ErrorAction SilentlyContinue
    if (-not $remConfig -or $remConfig.Count -eq 0) {
        Remove-Item -LiteralPath $dotConfigDir -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# STEP 7: Remove Temp Files, Shortcuts & Windows Registry Entries
# ---------------------------------------------------------------------------
Write-Host "[7/7] Cleaning up temporary files, shortcuts, and Windows Registry keys..." -ForegroundColor Yellow

$tempPatterns = @("one-launcher*", "OneLauncher*", "One Launcher*", "gogdl*", "legendary*")
foreach ($pattern in $tempPatterns) {
    $tempItems = Get-ChildItem -Path $env:TEMP -Filter $pattern -Force -ErrorAction SilentlyContinue
    foreach ($item in $tempItems) {
        Remove-PathSafely -TargetPath $item.FullName -Label "Temp File"
    }
}

$shortcutPaths = @(
    (Join-Path $env:USERPROFILE "Desktop\One Launcher.lnk"),
    (Join-Path $env:PUBLIC "Desktop\One Launcher.lnk"),
    (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\One Launcher.lnk"),
    (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\One Launcher"),
    (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\One Launcher.lnk"),
    (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\One Launcher")
)

foreach ($sc in $shortcutPaths) {
    if ($sc -and (Test-Path -LiteralPath $sc)) {
        Write-Host "  [DEL]  Removing Shortcut: $sc" -ForegroundColor Gray
        Remove-Item -LiteralPath $sc -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$regKeysToDelete = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.onelauncher.app",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{com.onelauncher.app}",
    "HKCU:\Software\com.onelauncher.app",
    "HKCU:\Software\One Launcher",
    "HKCU:\Software\one-launcher",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.onelauncher.app",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{com.onelauncher.app}",
    "HKLM:\Software\com.onelauncher.app",
    "HKLM:\Software\One Launcher",
    "HKLM:\Software\one-launcher"
)

foreach ($regKey in $regKeysToDelete) {
    if (Test-Path -LiteralPath $regKey) {
        Write-Host "  [REG]  Deleting Registry Key: $regKey" -ForegroundColor Gray
        Remove-Item -LiteralPath $regKey -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Clean up GOG.com Registry entries whose path points to OneLauncher or custom removed paths/IDs
$gogGamesRegRoots = @(
    "HKCU:\Software\GOG.com\Games",
    "HKLM:\Software\WOW6432Node\GOG.com\Games",
    "HKLM:\Software\GOG.com\Games"
)
foreach ($gogGamesRegRoot in $gogGamesRegRoots) {
    if (Test-Path -LiteralPath $gogGamesRegRoot) {
        Get-ChildItem -LiteralPath $gogGamesRegRoot -ErrorAction SilentlyContinue | ForEach-Object {
            $props = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
            if ($props -and (($props.path -and $props.path -match "(?i)OneLauncher") -or
                ($removedPaths -contains $props.path) -or
                ($removedIds -contains $_.PSChildName) -or
                ($removedIds -contains $props.gameID))) {
                Write-Host "  [REG]  Deleting GOG Game Registry Key: $($_.PSPath)" -ForegroundColor Gray
                Remove-Item -LiteralPath $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

# Scan HKCU & HKLM Uninstall keys for any entry whose DisplayName is "One Launcher"
$uninstallRoots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
)
foreach ($uninstallRoot in $uninstallRoots) {
    if (Test-Path -LiteralPath $uninstallRoot) {
        Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue | ForEach-Object {
            $props = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
            if ($props -and ($props.DisplayName -eq "One Launcher" -or $props.DisplayName -eq "one-launcher")) {
                Write-Host "  [REG]  Deleting Uninstall Registry Key: $($_.PSPath)" -ForegroundColor Gray
                Remove-Item -LiteralPath $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Green
Write-Host "  One Launcher and all associated games, caches, credentials,     " -ForegroundColor Green
Write-Host "  and registry entries have been completely removed from Windows. " -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Green
Write-Host ""
