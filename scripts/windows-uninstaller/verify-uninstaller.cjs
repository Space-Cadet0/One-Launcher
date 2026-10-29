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
  return content;
}

function main() {
  verifyFile(CANONICAL_PS1, 'build/Uninstall-OneLauncher.ps1');
  verifyFile(CANONICAL_BAT, 'build/Uninstall One Launcher (Full Clean).bat');

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

module.exports = { CANONICAL_PS1, CANONICAL_BAT, verifyFile };
