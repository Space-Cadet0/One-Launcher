#!/usr/bin/env node
'use strict';

/**
 * Single-Source Windows Uninstaller Verifier & Release Sync Helper
 *
 * Canonical sources of truth:
 *   - build/Uninstall-OneLauncher.ps1
 *   - build/Uninstall One Launcher (Full Clean).bat
 *
 * Enforces injection-safety and process-tree safety invariants:
 *   1. No `cmd.exe /c "rmdir ..."` (%VAR% command-injection vector).
 *   2. Explicit `[IO.FileAttributes]::ReparsePoint` check prior to recursive
 *      `Remove-Item -LiteralPath` so NTFS junctions never traverse into user folders.
 *   3. No `taskkill ... /T` tree-kills that would terminate active child games mid-save.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const CANONICAL_PS1 = path.join(ROOT_DIR, 'build', 'Uninstall-OneLauncher.ps1');
const CANONICAL_BAT = path.join(ROOT_DIR, 'build', 'Uninstall One Launcher (Full Clean).bat');
const NSIS_HOOK = path.join(ROOT_DIR, 'build', 'installer.nsh');
const STANDALONE_NSI = path.join(ROOT_DIR, 'build', 'standalone-uninstaller.nsi');

const REQUIRED_GOG_GALAXY_TABLES = [
  'PlayTaskLaunchParameters',
  'PlayTasks',
  'ProductSettings',
  'GameFiles',
  'BaseModificationTargets',
  'ModificationTargets',
  'ImportedLatestBuildIds',
  'InstalledBaseProducts',
  'InstalledProducts',
  'ProductStates',
];

function verifyFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[verify-uninstaller] Missing canonical file (${label}): ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (/cmd\.exe\s+\/c\s+["']?rmdir/i.test(content)) {
    throw new Error(
      `[verify-uninstaller] Forbidden cmd.exe rmdir command-injection pattern found in ${label}`
    );
  }
  if (/taskkill(?:\.exe)?[^\r\n]*\s\/T\b/i.test(content)) {
    throw new Error(
      `[verify-uninstaller] Forbidden taskkill /T child-game tree-kill found in ${label}`
    );
  }
  if (!content.includes('[IO.FileAttributes]::ReparsePoint')) {
    throw new Error(
      `[verify-uninstaller] Missing [IO.FileAttributes]::ReparsePoint NTFS junction guard in ${label}`
    );
  }
  if (!content.includes('Remove-Item -LiteralPath')) {
    throw new Error(
      `[verify-uninstaller] Missing Remove-Item -LiteralPath in ${label}`
    );
  }
  if (!content.includes('ProfileList') || !content.includes('HKEY_USERS')) {
    throw new Error(
      `[verify-uninstaller] Missing split-token UAC interactive user profile/registry resolution in ${label}`
    );
  }
  if (!content.includes('.one-launcher-bak')) {
    throw new Error(
      `[verify-uninstaller] Missing galaxy-2.0.db pre-mutation backup (.one-launcher-bak) in ${label}`
    );
  }
  if (
    !content.includes('busy_timeout = 3000') ||
    !content.includes('BEGIN IMMEDIATE') ||
    !content.includes('.timeout 3000')
  ) {
    throw new Error(
      `[verify-uninstaller] Missing transactional SQLite busy_timeout / BEGIN IMMEDIATE / .timeout 3000 guard in ${label}`
    );
  }
  for (const table of REQUIRED_GOG_GALAXY_TABLES) {
    if (!content.includes(`DELETE FROM ${table}`)) {
      throw new Error(
        `[verify-uninstaller] Missing GOG Galaxy SQLite cleanup statement DELETE FROM ${table} in ${label}`
      );
    }
  }
  if (
    !content.includes('\\\\Steam(\\\\|$)') ||
    !content.includes('\\\\SteamApps') ||
    !content.includes('Get-PSDrive -PSProvider FileSystem')
  ) {
    throw new Error(
      `[verify-uninstaller] Missing Steam protection guard or Get-PSDrive enumeration in ${label}`
    );
  }
  const nonCommentLines = content
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  if (nonCommentLines.includes('-------------')) {
    throw new Error(`[verify-uninstaller] Corrupted dash typo found in ${label}`);
  }
  return content;
}

function verifyNsisFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[verify-uninstaller] Missing NSIS file (${label}): ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (/taskkill(?:\.exe)?[^\r\n]*\s\/T\b/i.test(content)) {
    throw new Error(
      `[verify-uninstaller] Forbidden taskkill /T child-game tree-kill found in ${label}`
    );
  }
  if (
    !content.includes('File "/oname=$PLUGINSDIR\\Uninstall-OneLauncher.ps1"') ||
    !content.includes('-File "$PLUGINSDIR\\Uninstall-OneLauncher.ps1"')
  ) {
    throw new Error(
      `[verify-uninstaller] Missing canonical $PLUGINSDIR\\Uninstall-OneLauncher.ps1 extraction/invocation in ${label}`
    );
  }
  if (!content.includes('[IO.FileAttributes]::ReparsePoint')) {
    throw new Error(
      `[verify-uninstaller] Missing [IO.FileAttributes]::ReparsePoint NTFS junction guard in ${label}`
    );
  }
  const nsExecLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('nsExec::'));
  for (const line of nsExecLines) {
    if (Buffer.byteLength(line, 'utf8') >= 2048) {
      throw new Error(
        `[verify-uninstaller] nsExec line exceeds safe 2048-byte NSIS_MAX_STRLEN budget in ${label}`
      );
    }
  }
  return content;
}

function main() {
  verifyFile(CANONICAL_PS1, 'build/Uninstall-OneLauncher.ps1');
  verifyFile(CANONICAL_BAT, 'build/Uninstall One Launcher (Full Clean).bat');
  verifyNsisFile(NSIS_HOOK, 'build/installer.nsh');
  verifyNsisFile(STANDALONE_NSI, 'build/standalone-uninstaller.nsi');

  if (process.argv.includes('--sync-release')) {
    const releaseDir = path.join(ROOT_DIR, 'release');
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.copyFileSync(CANONICAL_PS1, path.join(releaseDir, 'Uninstall-OneLauncher.ps1'));
    fs.copyFileSync(
      CANONICAL_BAT,
      path.join(releaseDir, 'Uninstall One Launcher (Full Clean).bat')
    );
    console.log('[verify-uninstaller] Synced canonical Windows uninstallers to release/');
  } else {
    console.log(
      '[verify-uninstaller] Verified single-source Windows uninstaller safety invariants in build/'
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CANONICAL_PS1,
  CANONICAL_BAT,
  NSIS_HOOK,
  STANDALONE_NSI,
  verifyFile,
  verifyNsisFile,
};
