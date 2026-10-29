; =============================================================================
; One Launcher — Custom NSIS Install & Uninstall Hooks (electron-builder include)
;
; UPGRADE & PROCESS SAFETY:
; - customInit: Kept strictly non-destructive so cancelling the installer UI
;   (Welcome / Choose Install Location) never kills running processes or deletes
;   Control Panel UninstallString entries.
; - customHeader / Section "-prepareInPlaceUpgrade": Runs ONLY after the user
;   confirms installation and enters MUI_PAGE_INSTFILES. Attempts graceful window
;   close (`taskkill /IM`) before `taskkill /F /IM` WITHOUT `/T` (so active child
;   Steam/GOG/Epic/Xbox games are never tree-killed mid-save), copies any existing
;   upgrade-aware uninstaller to `$TEMP` and runs `ExecWait ... _?=$oldInstallDir`
;   synchronously until file locks release, and clears legacy `UninstallString`
;   prior to `Section "install"` writing updated files and registry entries.
; - customInstall: Logs confirmation that accounts, library data, and installed
;   games are preserved.
; - customUnInstall: Checks ${isUpdated} and /KEEP_APP_DATA. When upgrading in-place,
;   preserves all user accounts, library data, and installed games. Only executes
;   the deep purge of One Launcher-managed games, manifests, AppData, CLI configs,
;   shortcuts, and registry keys on an explicit standalone/Control Panel uninstallation.
; =============================================================================

!ifndef PROJECT_DIR
  !if /FileExists "..\build\Uninstall-OneLauncher.ps1"
    !define PROJECT_DIR ".."
  !else if /FileExists "build\Uninstall-OneLauncher.ps1"
    !define PROJECT_DIR "."
  !else
    !define PROJECT_DIR "${__FILEDIR__}\.."
  !endif
!endif

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Var oldInstallDir

    Section "-prepareInPlaceUpgrade" SecPrepareInPlaceUpgrade
      ${ifNot} ${isDeleteAppData}
        StrCpy $R0 ""
        StrCpy $oldInstallDir ""
        StrCpy $R4 ""
        ReadRegStr $R0 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
        ReadRegStr $oldInstallDir HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
        ReadRegStr $R4 HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
        ${if} $R0 == ""
          ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
          ReadRegStr $R4 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
        ${endIf}
        ${if} $oldInstallDir == ""
          ReadRegStr $oldInstallDir HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
        ${endIf}

        ${if} $R0 != ""
          ; 1. Request graceful window close first, then force-close ONLY One Launcher (NEVER /T, preserving active child games!)
          nsExec::ExecToLog 'taskkill /IM "One Launcher.exe"'
          nsExec::ExecToLog 'taskkill /IM "one-launcher.exe"'
          Sleep 1000
          nsExec::ExecToLog 'taskkill /F /IM "One Launcher.exe"'
          nsExec::ExecToLog 'taskkill /F /IM "one-launcher.exe"'

          ; 2. Extract quoted uninstaller path from UninstallString ($R0 -> $R1) and resolve $oldInstallDir
          StrCpy $R1 ""
          StrCpy $R2 $R0 1
          ${if} $R2 == '"'
            StrCpy $R3 1
            ${Do}
              StrCpy $R2 $R0 1 $R3
              ${If} $R2 == '"'
              ${OrIf} $R2 == ""
                ${ExitDo}
              ${EndIf}
              IntOp $R3 $R3 + 1
            ${Loop}
            IntOp $R3 $R3 - 1
            ${if} $R3 > 0
              StrCpy $R1 $R0 $R3 1
            ${endIf}
          ${endIf}

          ${if} $R1 == ""
          ${andIf} $oldInstallDir != ""
          ${andIf} ${FileExists} "$oldInstallDir\Uninstall One Launcher.exe"
            StrCpy $R1 "$oldInstallDir\Uninstall One Launcher.exe"
          ${endIf}

          ${if} $oldInstallDir == ""
          ${andIf} $R1 != ""
            ${GetParent} "$R1" $oldInstallDir
          ${endIf}

          ; 3. Copy previous uninstaller to $TEMP and synchronously wait with _?=$oldInstallDir until file locks release
          ${if} $R4 != "0.1.0"
          ${andIf} $R1 != ""
          ${andIf} ${FileExists} "$R1"
          ${andIf} $oldInstallDir != ""
            CopyFiles /SILENT "$R1" "$TEMP\one-launcher-upgrade-uninstaller.exe"
            ExecWait '"$TEMP\one-launcher-upgrade-uninstaller.exe" /S /KEEP_APP_DATA --updated _?=$oldInstallDir' $R3
            Delete "$TEMP\one-launcher-upgrade-uninstaller.exe"
          ${endIf}

          ; 4. Clear legacy UninstallString inside install Section (safe if user cancelled UI earlier)
          DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
          DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
          DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
          DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
          !ifdef UNINSTALL_REGISTRY_KEY_2
            DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
            DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY_2}" "QuietUninstallString"
            DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
            DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" "QuietUninstallString"
          !endif
        ${endIf}
      ${endIf}
    SectionEnd
  !endif
!macroend

!macro customInit
  ; Intentionally non-destructive: process shutdown, synchronous ExecWait _?=$oldInstallDir,
  ; and UninstallString cleanup run in Section "-prepareInPlaceUpgrade" only after UI confirmation.
!macroend

!macro customInstall
  DetailPrint "One Launcher installation complete — user accounts, library data, and installed games are preserved."
!macroend

!macro customUnInstall
  ; 1. Gracefully request One Launcher window close first, then force-close ONLY One Launcher (NEVER /T!)
  nsExec::ExecToLog 'taskkill /IM "One Launcher.exe"'
  nsExec::ExecToLog 'taskkill /IM "one-launcher.exe"'
  Sleep 500
  nsExec::ExecToLog 'taskkill /F /IM "One Launcher.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "one-launcher.exe"'

  ; Detect whether this uninstaller was invoked by an in-place installer upgrade (--updated or /KEEP_APP_DATA)
  StrCpy $R1 "0"
  ${if} ${isUpdated}
    StrCpy $R1 "1"
  ${endIf}
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R0
  ${ifNot} ${Errors}
    StrCpy $R1 "1"
  ${endIf}

  ${if} $R1 == "1"
    DetailPrint "Upgrading existing One Launcher installation — preserving user accounts, library data, and installed games..."
  ${else}
    nsExec::ExecToLog 'taskkill /IM "legendary.exe"'
    nsExec::ExecToLog 'taskkill /IM "gogdl.exe"'
    Sleep 500
    nsExec::ExecToLog 'taskkill /F /IM "legendary.exe"'
    nsExec::ExecToLog 'taskkill /F /IM "gogdl.exe"'
    Sleep 500

    ; 2. Extract and execute canonical Uninstall-OneLauncher.ps1 from $PLUGINSDIR (< 200 chars, immune to NSIS_MAX_STRLEN=8192)
    InitPluginsDir
    File "/oname=$PLUGINSDIR\Uninstall-OneLauncher.ps1" "${PROJECT_DIR}\build\Uninstall-OneLauncher.ps1"
    System::Call 'Kernel32::SetEnvironmentVariable(t "ONE_LAUNCHER_NSIS_UNINSTALL", t "1")'
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\Uninstall-OneLauncher.ps1"'

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
    RMDir /r "$APPDATA\universal-game-library"
    RMDir /r "$LOCALAPPDATA\one-launcher"
    RMDir /r "$LOCALAPPDATA\One Launcher"
    RMDir /r "$LOCALAPPDATA\one-launcher-updater"
    RMDir /r "$LOCALAPPDATA\One Launcher-updater"
    RMDir /r "$LOCALAPPDATA\com.onelauncher.app"
    RMDir /r "$LOCALAPPDATA\universal-game-library"
    RMDir /r "$PROFILE\.one-launcher"
    RMDir /r "$PROFILE\.universal-game-library"

    ; 5. Remove bundled CLI config & cache directories (legendary & gogdl)
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

    ; 8. Remove temp files & Registry keys (both HKCU and HKLM; < 1,500 chars)
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
  ${endIf}
!macroend
