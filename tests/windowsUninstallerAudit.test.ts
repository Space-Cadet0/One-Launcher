import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT_DIR = path.resolve(__dirname, '..');

const UNINSTALLER_FILES = {
  nsisHook: path.join(ROOT_DIR, 'build', 'installer.nsh'),
  standaloneNsi: path.join(ROOT_DIR, 'build', 'standalone-uninstaller.nsi'),
  powershellScript: path.join(ROOT_DIR, 'scripts', 'windows-uninstaller', 'Uninstall-OneLauncher.ps1'),
  batchWrapper: path.join(ROOT_DIR, 'scripts', 'windows-uninstaller', 'Uninstall One Launcher (Full Clean).bat'),
};

describe('Windows Uninstaller Deep Audit & Artifact Verification', () => {
  const contents = {
    nsisHook: fs.readFileSync(UNINSTALLER_FILES.nsisHook, 'utf8'),
    standaloneNsi: fs.readFileSync(UNINSTALLER_FILES.standaloneNsi, 'utf8'),
    powershellScript: fs.readFileSync(UNINSTALLER_FILES.powershellScript, 'utf8'),
    batchWrapper: fs.readFileSync(UNINSTALLER_FILES.batchWrapper, 'utf8'),
  };

  describe('1. heroic_gogdl Manifest & Config Cleanup', () => {
    it('purges heroic_gogdl and gogdlConfig directories across all 4 uninstaller files', () => {
      // NSIS files use $PROFILE, $APPDATA, $LOCALAPPDATA
      for (const [name, text] of [
        ['build/installer.nsh', contents.nsisHook],
        ['build/standalone-uninstaller.nsi', contents.standaloneNsi],
      ] as const) {
        expect(text, `${name} missing .config\\heroic_gogdl`).toContain('$PROFILE\\.config\\heroic_gogdl');
        expect(text, `${name} missing $APPDATA\\heroic_gogdl`).toContain('$APPDATA\\heroic_gogdl');
        expect(text, `${name} missing $LOCALAPPDATA\\heroic_gogdl`).toContain('$LOCALAPPDATA\\heroic_gogdl');
        expect(text, `${name} missing one-launcher\\gogdlConfig`).toContain('$APPDATA\\one-launcher\\gogdlConfig');
        expect(text, `${name} missing One Launcher\\gogdlConfig`).toContain('$APPDATA\\One Launcher\\gogdlConfig');
      }

      // PowerShell & Batch scripts use $env:USERPROFILE, $env:APPDATA, $env:LOCALAPPDATA
      for (const [name, text] of [
        ['Uninstall-OneLauncher.ps1', contents.powershellScript],
        ['Uninstall One Launcher (Full Clean).bat', contents.batchWrapper],
      ] as const) {
        expect(text, `${name} missing .config\\heroic_gogdl`).toContain('.config\\heroic_gogdl');
        expect(text, `${name} missing heroic_gogdl`).toContain('heroic_gogdl');
        expect(text, `${name} missing one-launcher\\gogdlConfig`).toContain('one-launcher\\gogdlConfig');
        expect(text, `${name} missing One Launcher\\gogdlConfig`).toContain('One Launcher\\gogdlConfig');
      }
    });
  });

  describe('2. Fallback UserData & Legacy Directories', () => {
    it('scans .one-launcher\\one_launcher_installed.json in Step 2 and purges .one-launcher / universal-game-library in Step 5', () => {
      for (const [name, text] of Object.entries(contents)) {
        // Step 2 manifest scanning
        expect(text, `${name} missing .one-launcher\\one_launcher_installed.json`).toContain(
          '.one-launcher\\one_launcher_installed.json'
        );

        // Step 5 UserData & legacy directories
        expect(text, `${name} missing universal-game-library`).toContain('universal-game-library');
        expect(text, `${name} missing .one-launcher`).toContain('.one-launcher');
        expect(text, `${name} missing .universal-game-library`).toContain('.universal-game-library');
      }
    });
  });

  describe('3. Full 10-Table GOG Galaxy 2.0 SQLite (galaxy-2.0.db) Cleanup', () => {
    const GOG_GALAXY_TABLES = [
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

    it('includes all 10 GOG Galaxy 2.0 SQLite tables plus ELECTRON_RUN_AS_NODE and sqlite3 fallback in all 4 files', () => {
      for (const [name, text] of Object.entries(contents)) {
        expect(text, `${name} missing galaxy-2.0.db`).toContain('galaxy-2.0.db');
        expect(text, `${name} missing ELECTRON_RUN_AS_NODE`).toContain('ELECTRON_RUN_AS_NODE');
        expect(text, `${name} missing node:sqlite DatabaseSync`).toContain("require('node:sqlite')");
        expect(text, `${name} missing sqlite3.exe fallback`).toContain('sqlite3.exe');

        for (const table of GOG_GALAXY_TABLES) {
          expect(text, `${name} missing DELETE FROM ${table}`).toContain(`DELETE FROM ${table}`);
        }
      }
    });

    it('executes the 10-table SQLite cleanup query cleanly against an in-memory galaxy-2.0.db schema', () => {
      const db = new DatabaseSync(':memory:');
      try {
        db.exec(`
          CREATE TABLE InstalledBaseProducts (productId INTEGER PRIMARY KEY, installationId INTEGER, generation INTEGER, buildId INTEGER, installationPath TEXT, installationDate TEXT);
          CREATE TABLE InstalledProducts (productId INTEGER PRIMARY KEY, installationId INTEGER, language TEXT);
          CREATE TABLE ProductStates (productId INTEGER PRIMARY KEY, isInstalled INTEGER, state INTEGER);
          CREATE TABLE ImportedLatestBuildIds (productId INTEGER PRIMARY KEY, buildId TEXT);
          CREATE TABLE ModificationTargets (productId INTEGER PRIMARY KEY, targetBranch TEXT);
          CREATE TABLE BaseModificationTargets (productId INTEGER PRIMARY KEY, buildId INTEGER);
          CREATE TABLE GameFiles (id INTEGER PRIMARY KEY AUTOINCREMENT, productId INTEGER, releaseKey TEXT, path TEXT);
          CREATE TABLE ProductSettings (gameReleaseKey TEXT, releaseKey TEXT, setting TEXT);
          CREATE TABLE PlayTasks (id INTEGER PRIMARY KEY AUTOINCREMENT, gameReleaseKey TEXT, releaseKey TEXT, isPrimary INTEGER);
          CREATE TABLE PlayTaskLaunchParameters (playTaskId INTEGER PRIMARY KEY, executablePath TEXT, commandLineArgs TEXT);

          -- Insert One Launcher installed GOG game (1207658924) and native GOG Galaxy game (999999999)
          INSERT INTO InstalledBaseProducts VALUES (1207658924, 1, 2, 100, 'C:\\Games\\OneLauncher\\GOG\\Cyberpunk', '2026-10-20');
          INSERT INTO InstalledBaseProducts VALUES (999999999, 2, 2, 200, 'C:\\Program Files (x86)\\GOG Galaxy\\Games\\Witcher3', '2026-10-20');

          INSERT INTO InstalledProducts VALUES (1207658924, 1, 'en-US'), (999999999, 2, 'en-US');
          INSERT INTO ProductStates VALUES (1207658924, 1, 5), (999999999, 1, 5);
          INSERT INTO ImportedLatestBuildIds VALUES (1207658924, '100'), (999999999, '200');
          INSERT INTO ModificationTargets VALUES (1207658924, ''), (999999999, '');
          INSERT INTO BaseModificationTargets VALUES (1207658924, 100), (999999999, 200);
          INSERT INTO GameFiles (productId, releaseKey, path) VALUES (1207658924, 'gog_1207658924', 'bin/game.exe'), (999999999, 'gog_999999999', 'bin/w3.exe');
          INSERT INTO ProductSettings VALUES ('gog_1207658924', 'gog_1207658924', '{}'), ('gog_999999999', 'gog_999999999', '{}');
          INSERT INTO PlayTasks (id, gameReleaseKey, releaseKey, isPrimary) VALUES (10, 'gog_1207658924', 'gog_1207658924', 1), (20, 'gog_999999999', 'gog_999999999', 1);
          INSERT INTO PlayTaskLaunchParameters VALUES (10, 'C:\\Games\\OneLauncher\\GOG\\Cyberpunk\\game.exe', ''), (20, 'C:\\Program Files (x86)\\GOG Galaxy\\Games\\Witcher3\\w3.exe', '');
        `);

        const cleanupSql = `
          CREATE TEMP TABLE IF NOT EXISTS _ol_pids (productId INTEGER PRIMARY KEY);
          INSERT OR IGNORE INTO _ol_pids SELECT productId FROM InstalledBaseProducts WHERE installationPath LIKE '%OneLauncher%';
          INSERT OR IGNORE INTO _ol_pids VALUES (1207658924);
          DELETE FROM PlayTaskLaunchParameters WHERE playTaskId IN (SELECT id FROM PlayTasks WHERE gameReleaseKey IN (SELECT 'gog_' || productId FROM _ol_pids));
          DELETE FROM PlayTaskLaunchParameters WHERE playTaskId IN (SELECT id FROM PlayTasks WHERE releaseKey IN (SELECT 'gog_' || productId FROM _ol_pids));
          DELETE FROM PlayTasks WHERE gameReleaseKey IN (SELECT 'gog_' || productId FROM _ol_pids);
          DELETE FROM PlayTasks WHERE releaseKey IN (SELECT 'gog_' || productId FROM _ol_pids);
          DELETE FROM ProductSettings WHERE gameReleaseKey IN (SELECT 'gog_' || productId FROM _ol_pids);
          DELETE FROM ProductSettings WHERE releaseKey IN (SELECT 'gog_' || productId FROM _ol_pids);
          DELETE FROM GameFiles WHERE productId IN (SELECT productId FROM _ol_pids);
          DELETE FROM GameFiles WHERE releaseKey IN (SELECT 'gog_' || productId FROM _ol_pids);
          DELETE FROM BaseModificationTargets WHERE productId IN (SELECT productId FROM _ol_pids);
          DELETE FROM ModificationTargets WHERE productId IN (SELECT productId FROM _ol_pids);
          DELETE FROM ImportedLatestBuildIds WHERE productId IN (SELECT productId FROM _ol_pids);
          DELETE FROM InstalledBaseProducts WHERE productId IN (SELECT productId FROM _ol_pids) OR installationPath LIKE '%OneLauncher%';
          DELETE FROM InstalledProducts WHERE productId IN (SELECT productId FROM _ol_pids) OR productId NOT IN (SELECT productId FROM InstalledBaseProducts);
          DELETE FROM ProductStates WHERE productId IN (SELECT productId FROM _ol_pids);
          DROP TABLE IF EXISTS _ol_pids;
        `;

        for (const stmt of cleanupSql.split(';').map((s) => s.trim()).filter(Boolean)) {
          db.exec(stmt + ';');
        }

        for (const table of GOG_GALAXY_TABLES) {
          const remaining = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
          expect(remaining.cnt, `Table ${table} should retain only the 1 native GOG game`).toBe(1);
        }
      } finally {
        db.close();
      }
    });
  });

  describe('4. Safety Guard Regex & Dynamic Multi-Drive Cleanup', () => {
    it('contains no corrupted dash typos in safety guards and enumerates drives via Get-PSDrive -PSProvider FileSystem', () => {
      const psNonCommentLines = contents.powershellScript
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
      expect(psNonCommentLines).not.toContain('-------------');
      expect(contents.batchWrapper).not.toContain('-------------');

      expect(contents.powershellScript).toContain('$normalized -match \'(?i)\\\\Steam(\\\\|$)\'');
      expect(contents.powershellScript).toContain('$normalized -match \'(?i)\\\\SteamApps\'');
      expect(contents.batchWrapper).toContain('$n -match \'(?i)\\\\Steam(\\\\|$)\'');
      expect(contents.batchWrapper).toContain('$n -match \'(?i)\\\\SteamApps\'');

      for (const [name, text] of Object.entries(contents)) {
        expect(text, `${name} missing Get-PSDrive -PSProvider FileSystem`).toContain(
          'Get-PSDrive -PSProvider FileSystem'
        );
      }
    });
  });

  describe('5. Built Windows Release Artifacts', () => {
    const requiredArtifacts = [
      path.join(ROOT_DIR, 'release', 'One Launcher Setup 0.1.0.exe'),
      path.join(ROOT_DIR, 'release', 'win-unpacked', 'One Launcher.exe'),
      path.join(ROOT_DIR, 'release', 'One Launcher Full Uninstaller.exe'),
      path.join(ROOT_DIR, 'release', 'Uninstall-OneLauncher.ps1'),
      path.join(ROOT_DIR, 'release', 'Uninstall One Launcher (Full Clean).bat'),
    ];

    it('verifies all 5 Windows installer, executable, and standalone uninstaller artifacts exist and are non-empty', () => {
      for (const artifactPath of requiredArtifacts) {
        expect(fs.existsSync(artifactPath), `Missing Windows artifact: ${artifactPath}`).toBe(true);
        const stat = fs.statSync(artifactPath);
        expect(stat.size, `Empty Windows artifact: ${artifactPath}`).toBeGreaterThan(0);
      }

      // Ensure release copies of .ps1 and .bat match the audited source scripts
      expect(fs.readFileSync(path.join(ROOT_DIR, 'release', 'Uninstall-OneLauncher.ps1'), 'utf8')).toBe(
        contents.powershellScript
      );
      expect(fs.readFileSync(path.join(ROOT_DIR, 'release', 'Uninstall One Launcher (Full Clean).bat'), 'utf8')).toBe(
        contents.batchWrapper
      );
    });
  });
});
