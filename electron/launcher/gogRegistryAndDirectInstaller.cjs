const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const childProcess = require('node:child_process');
const { spawn, execFile, execFileSync } = childProcess;

const { diagLog } = require('../utils/diagnosticLogger.cjs');
const {
  toHostFilesystemPath,
  atomicWriteFileSync,
  atomicWriteSecureFileSync,
  isContainedWithinRoot,
  isStoreDisconnectedTombstoned,
} = require('./securityAndPathUtils.cjs');
const {
  discoverWindowsGogGalaxyRegistryPaths,
} = require('../utils/windowsRegistryDiscovery.cjs');
const {
  isHostGogGalaxyRunning,
  reapOrphanedGogOverlayProcesses,
  probeLocalTcpPort,
  resolveGogCommunicationLogPath,
  waitForGogCommunicationServiceReady,
} = require('./storefrontReadinessBarrier.cjs');
const {
  toWineWindowsPath,
  escapeWineRegString,
  upsertWineSystemRegKey,
  deleteWineSystemRegKey,
} = require('./firstPartyRegistration.cjs');
const {
  sanitizeGameInstallSizeBytes,
  inspectMacMachOHeader,
} = require('./binaryAndManifestInspectors.cjs');
const { GOG_GALAXY_LAUNCHER_CLIENT_ID } = require('./cloudSaveEngine.cjs');
const {
  getStoreSync,
  getUserDataDir,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  downloadQueueMap,
  downloadControllers,
  gogFirstPartySyncSignatureCache,
  executableDiscoveryCache,
  setBoundedMapEntry,
  toLocalFsPath,
  resolveHostLocaleInfo,
  findGogdlBinary,
  writeManagedInstallSentinel,
  loadManagedInstalledGames,
  saveManagedInstalledGames,
  upsertManagedInstallRecord,
} = require('./engineStateRegistry.cjs');
const {
  ensureMacExecutablePermissions,
  ensureMacAppCodeSignatureValid,
  resolveMacAppBundleBinary,
  flattenGogNestedInstallDir,
  findPrimaryExecutable,
  listAllInitializedBottlePaths,
  resolveTargetBottleForFirstPartySync,
} = require('./macNativeInstallerAndCodesign.cjs');
const {
  isMockOrCorruptedToken,
  isPoisonedStorefrontToken,
} = require('./epicLegendaryAndEosCoordinator.cjs');

/** @type {{ updateDownloadTask: Function | null, computeSmoothedDownloadSpeed: Function | null }} */
let gogDownloadTaskHooks = {
  updateDownloadTask: null,
  computeSmoothedDownloadSpeed: null,
};

function setGogDownloadTaskHooks(/** @type {any} */ hooks = {}) {
  gogDownloadTaskHooks = {
    updateDownloadTask:
      typeof hooks.updateDownloadTask === 'function' ? hooks.updateDownloadTask : null,
    computeSmoothedDownloadSpeed:
      typeof hooks.computeSmoothedDownloadSpeed === 'function'
        ? hooks.computeSmoothedDownloadSpeed
        : null,
  };
}

function sanitizeDirectoryName(/** @type {any} */ title) {
  return (
    String(title || 'Game')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Game'
  );
}

/**
 * Resolve GOG Galaxy 2.0 config.json and galaxy-2.0.db paths
 */
function resolveGogFirstPartyPaths(/** @type {any} */ options = {}) {
  const platform = options.platform || process.platform;
  const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';

  const gogConfigPath =
    options.gogGalaxyConfigPath ||
    (!options.homedir
      ? platform === 'win32'
        ? path.join(programData, 'GOG.com', 'Galaxy', 'config.json')
        : '/Users/Shared/GOG.com/Galaxy/config.json'
      : null);

  const gogDbPath =
    options.gogGalaxyDbPath ||
    (!options.homedir
      ? platform === 'win32'
        ? path.join(programData, 'GOG.com', 'Galaxy', 'storage', 'galaxy-2.0.db')
        : fs.existsSync('/Users/Shared/GOG.com/Galaxy/Storage/galaxy-2.0.db')
          ? '/Users/Shared/GOG.com/Galaxy/Storage/galaxy-2.0.db'
          : '/Users/Shared/GOG.com/Galaxy/storage/galaxy-2.0.db'
      : null);

  return { gogConfigPath, gogDbPath };
}

const GOG_LANGUAGE_METADATA_TABLE = [
  { id: 16, name: 'English', code: 'en-US', regLanguage: 'english', aliases: ['en', 'en-us', 'en-gb', 'english'] },
  { id: 17, name: 'Deutsch', code: 'de-DE', regLanguage: 'german', aliases: ['de', 'de-de', 'german', 'deutsch'] },
  { id: 18, name: 'Français', code: 'fr-FR', regLanguage: 'french', aliases: ['fr', 'fr-fr', 'french', 'francais', 'français'] },
  { id: 19, name: 'Polski', code: 'pl-PL', regLanguage: 'polish', aliases: ['pl', 'pl-pl', 'polish', 'polski'] },
  { id: 20, name: 'Русский', code: 'ru-RU', regLanguage: 'russian', aliases: ['ru', 'ru-ru', 'russian', 'русский'] },
  { id: 21, name: 'Español', code: 'es-ES', regLanguage: 'spanish', aliases: ['es', 'es-es', 'es-mx', 'spanish', 'espanol', 'español'] },
  { id: 22, name: 'Italiano', code: 'it-IT', regLanguage: 'italian', aliases: ['it', 'it-it', 'italian', 'italiano'] },
  { id: 23, name: 'Português do Brasil', code: 'pt-BR', regLanguage: 'brazilian-portuguese', aliases: ['pt-br', 'pt', 'pt-pt', 'portuguese', 'brazilian', 'português'] },
  { id: 24, name: '日本語', code: 'ja-JP', regLanguage: 'japanese', aliases: ['ja', 'ja-jp', 'jp', 'japanese', '日本語'] },
  { id: 25, name: '한국어', code: 'ko-KR', regLanguage: 'korean', aliases: ['ko', 'ko-kr', 'kr', 'korean', '한국어'] },
  { id: 26, name: '简体中文', code: 'zh-Hans', regLanguage: 'chinese', aliases: ['zh', 'zh-cn', 'zh-hans', 'chinese', '简体中文'] },
  { id: 27, name: '繁體中文', code: 'zh-Hant', regLanguage: 'traditional-chinese', aliases: ['zh-tw', 'zh-hk', 'zh-hant', '繁體中文'] },
  { id: 28, name: 'Čeština', code: 'cs-CZ', regLanguage: 'czech', aliases: ['cs', 'cs-cz', 'czech', 'čeština'] },
  { id: 29, name: 'Magyar', code: 'hu-HU', regLanguage: 'hungarian', aliases: ['hu', 'hu-hu', 'hungarian', 'magyar'] },
  { id: 30, name: 'Türkçe', code: 'tr-TR', regLanguage: 'turkish', aliases: ['tr', 'tr-tr', 'turkish', 'türkçe'] },
  { id: 31, name: 'Nederlands', code: 'nl-NL', regLanguage: 'dutch', aliases: ['nl', 'nl-nl', 'dutch', 'nederlands'] },
  { id: 32, name: 'Українська', code: 'uk-UA', regLanguage: 'ukrainian', aliases: ['uk', 'uk-ua', 'ukrainian', 'українська'] },
];

function resolveGogGalaxyLanguageMetadata(/** @type {any} */ info, /** @type {any} */ options = {}) {
  const candidates = [];
  if (info && Array.isArray(info.languages) && info.languages[0]) {
    candidates.push(String(info.languages[0]).trim());
  }
  if (info && typeof info.language === 'string' && info.language.trim()) {
    candidates.push(info.language.trim());
  }
  if (candidates.length === 0) {
    const hostLoc = resolveHostLocaleInfo(options);
    if (hostLoc.gogLocale) candidates.push(hostLoc.gogLocale);
    if (hostLoc.langCode) candidates.push(hostLoc.langCode);
  }
  for (const raw of candidates) {
    const norm = raw.toLowerCase().replace(/_/g, '-');
    const matched = GOG_LANGUAGE_METADATA_TABLE.find(
      (entry) => entry.aliases.includes(norm) || norm.startsWith(`${entry.code.toLowerCase()}`)
    );
    if (matched) return matched;
  }
  return GOG_LANGUAGE_METADATA_TABLE[0];
}

function upsertGogSqliteProduct(/** @type {string} */ targetDbPath, /** @type {any} */ params) {
  const {
    cleanId,
    productName,
    langMeta,
    realGeneration,
    realBuildId,
    installationPath,
    playTaskExe,
    isMacBundleInfo,
  } = params;
  if (!targetDbPath || !/^\d+$/.test(String(cleanId))) return false;
  const numericProductId = Number(cleanId);
  const sqlBuildId = /^\d+$/.test(String(realBuildId)) ? BigInt(realBuildId) : 0n;
  const installationId = Number(String(numericProductId).slice(0, 9)) || numericProductId;
  const releaseKey = `gog_${cleanId}`;

  /** @type {any} */
  let db = null;
  let inTx = false;
  try {
    const hostDbPath = toHostFilesystemPath(targetDbPath);
    fs.mkdirSync(path.dirname(hostDbPath), { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(hostDbPath, { readBigInts: true });
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('BEGIN IMMEDIATE;');
    inTx = true;

    db.exec(`
      CREATE TABLE IF NOT EXISTS ReleaseKeys (key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS ProductsToReleaseKeys (id INTEGER PRIMARY KEY, externalId INTEGER, gogId INTEGER, releaseKey TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS Products (id INTEGER PRIMARY KEY, name TEXT, parentId INTEGER);
      CREATE TABLE IF NOT EXISTS InstalledProducts (productId INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS Languages (id INTEGER PRIMARY KEY, name TEXT, code TEXT);
      CREATE TABLE IF NOT EXISTS AvailableLanguages (productId INTEGER, buildId INTEGER, languageId INTEGER, PRIMARY KEY (productId, buildId, languageId));
      CREATE TABLE IF NOT EXISTS InstalledBaseProducts (productId INTEGER PRIMARY KEY, generation INTEGER, languageId INTEGER, installationPath TEXT, installationId INTEGER, buildId INTEGER, branch TEXT, installationDate TEXT);
      CREATE TABLE IF NOT EXISTS ImportedLatestBuildIds (productId INTEGER PRIMARY KEY, buildId INTEGER);
      CREATE TABLE IF NOT EXISTS ProductStates (productId INTEGER PRIMARY KEY, installation INTEGER, operation INTEGER);
      CREATE TABLE IF NOT EXISTS ModificationTargets (productId INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS BaseModificationTargets (productId INTEGER PRIMARY KEY, languageId INTEGER, installationPath TEXT, buildId INTEGER, branch TEXT, areDlcsSelectedByUser INTEGER);
      CREATE TABLE IF NOT EXISTS ProductSettings (gameReleaseKey TEXT PRIMARY KEY, selectedBuildId INTEGER, branch TEXT, password TEXT, autoUpdate INTEGER, cloudStorage INTEGER, overlay INTEGER, desktopShortcut INTEGER, customLaunchParameters, selectedLaunchParameters INTEGER);
      CREATE TABLE IF NOT EXISTS PlayTaskTypes (id INTEGER PRIMARY KEY, type TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS PlayTasks (id INTEGER PRIMARY KEY, gameReleaseKey TEXT, userId INTEGER, "order" INTEGER, typeId INTEGER, isPrimary INTEGER);
      CREATE TABLE IF NOT EXISTS PlayTaskLaunchParameters (playTaskId INTEGER PRIMARY KEY, executablePath TEXT, commandLineArgs TEXT, label TEXT);
      CREATE TABLE IF NOT EXISTS GameFiles (id INTEGER PRIMARY KEY, installPath TEXT, productId INTEGER, hash TEXT, fileAttribute INTEGER);
    `);

    try {
      const staleSubquery = "SELECT id FROM Products WHERE name LIKE 'steam-%'";
      db.prepare(`DELETE FROM ProductsToReleaseKeys WHERE gogId IN (${staleSubquery})`).run();
      db.prepare(`DELETE FROM ImportedLatestBuildIds WHERE productId IN (${staleSubquery})`).run();
      db.prepare(`DELETE FROM BaseModificationTargets WHERE productId IN (${staleSubquery})`).run();
      db.prepare(`DELETE FROM ModificationTargets WHERE productId IN (${staleSubquery})`).run();
      db.prepare(`DELETE FROM ProductStates WHERE productId IN (${staleSubquery})`).run();
      db.prepare(`DELETE FROM GameFiles WHERE productId IN (${staleSubquery})`).run();
      db.prepare(`DELETE FROM InstalledBaseProducts WHERE productId IN (${staleSubquery})`).run();
      db.prepare(`DELETE FROM InstalledProducts WHERE productId IN (${staleSubquery})`).run();
      db.prepare(`DELETE FROM AvailableLanguages WHERE productId IN (${staleSubquery})`).run();
      db.prepare("DELETE FROM Products WHERE name LIKE 'steam-%'").run();
    } catch {}

    db.prepare('INSERT OR IGNORE INTO ReleaseKeys (key) VALUES (?)').run(releaseKey);
    try {
      db.prepare(
        'INSERT OR IGNORE INTO ProductsToReleaseKeys (externalId, gogId, releaseKey) VALUES (NULL, ?, ?)'
      ).run(numericProductId, releaseKey);
    } catch {}
    db.prepare(
      'INSERT INTO Products (id, name, parentId) VALUES (?, ?, NULL) ON CONFLICT(id) DO UPDATE SET name = COALESCE(Products.name, excluded.name)'
    ).run(numericProductId, productName);
    db.prepare('INSERT OR IGNORE INTO InstalledProducts (productId) VALUES (?)').run(
      numericProductId
    );
    db.prepare('INSERT OR IGNORE INTO Languages (id, name, code) VALUES (?, ?, ?)').run(
      langMeta.id,
      langMeta.name,
      langMeta.code
    );
    db.prepare(
      'INSERT OR IGNORE INTO AvailableLanguages (productId, buildId, languageId) VALUES (?, ?, ?)'
    ).run(numericProductId, sqlBuildId, langMeta.id);
    db.prepare(
      "INSERT OR REPLACE INTO InstalledBaseProducts (productId, generation, languageId, installationPath, installationId, buildId, branch, installationDate) VALUES (?, ?, ?, ?, ?, ?, NULL, datetime('now'))"
    ).run(
      numericProductId,
      realGeneration,
      langMeta.id,
      installationPath,
      installationId,
      sqlBuildId
    );
    db.prepare(
      'INSERT OR REPLACE INTO ImportedLatestBuildIds (productId, buildId) VALUES (?, ?)'
    ).run(numericProductId, sqlBuildId);
    db.prepare(
      'INSERT OR REPLACE INTO ProductStates (productId, installation, operation) VALUES (?, 3, 0)'
    ).run(numericProductId);
    db.prepare('INSERT OR IGNORE INTO ModificationTargets (productId) VALUES (?)').run(
      numericProductId
    );
    db.prepare(
      'INSERT OR REPLACE INTO BaseModificationTargets (productId, languageId, installationPath, buildId, branch, areDlcsSelectedByUser) VALUES (?, ?, ?, ?, NULL, 0)'
    ).run(numericProductId, langMeta.id, installationPath, sqlBuildId);

    try {
      db.prepare('DELETE FROM AvailableLanguages WHERE productId = ? AND buildId != ?').run(
        numericProductId,
        sqlBuildId
      );
    } catch {}

    db.prepare(
      'INSERT OR IGNORE INTO ProductSettings (gameReleaseKey, selectedBuildId, branch, password, autoUpdate, cloudStorage, overlay, desktopShortcut, customLaunchParameters, selectedLaunchParameters) VALUES (?, NULL, NULL, NULL, 1, 1, 1, 0, 0, NULL)'
    ).run(releaseKey);
    db.prepare(
      "INSERT OR IGNORE INTO PlayTaskTypes (id, type) VALUES (1, 'BuiltIn'), (2, 'BuiltInPrimary')"
    ).run();

    try {
      const existingPrimaryTask = db
        .prepare(
          'SELECT id, typeId FROM PlayTasks WHERE gameReleaseKey = ? ORDER BY isPrimary DESC, "order" ASC LIMIT 1'
        )
        .get(releaseKey);
      if (!existingPrimaryTask || !existingPrimaryTask.id) {
        const ptInfo = db
          .prepare(
            'INSERT INTO PlayTasks (gameReleaseKey, userId, "order", typeId, isPrimary) VALUES (?, NULL, 1, 2, 1)'
          )
          .run(releaseKey);
        db.prepare(
          'INSERT OR REPLACE INTO PlayTaskLaunchParameters (playTaskId, executablePath, commandLineArgs, label) VALUES (?, ?, ?, ?)'
        ).run(ptInfo.lastInsertRowid, playTaskExe, '', productName);
      } else if (
        Number(existingPrimaryTask.typeId) === 1 ||
        Number(existingPrimaryTask.typeId) === 2
      ) {
        db.prepare(
          'INSERT INTO PlayTaskLaunchParameters (playTaskId, executablePath, commandLineArgs, label) VALUES (?, ?, ?, ?) ON CONFLICT(playTaskId) DO UPDATE SET executablePath = excluded.executablePath, label = excluded.label'
        ).run(existingPrimaryTask.id, playTaskExe, '', productName);
      } else {
        db.prepare(
          'INSERT OR IGNORE INTO PlayTaskLaunchParameters (playTaskId, executablePath, commandLineArgs, label) VALUES (?, ?, ?, ?)'
        ).run(existingPrimaryTask.id, playTaskExe, '', productName);
      }
    } catch {}

    const gfCountRow = db
      .prepare('SELECT COUNT(*) AS cnt FROM GameFiles WHERE productId = ?')
      .get(numericProductId);
    if (Number(gfCountRow?.cnt || 0) === 0) {
      const gfRelPath = isMacBundleInfo
        ? `Contents/Resources/goggame-${cleanId}.info`
        : `goggame-${cleanId}.info`;
      db.prepare(
        'INSERT INTO GameFiles (installPath, productId, hash, fileAttribute) VALUES (?, ?, ?, 32)'
      ).run(gfRelPath, numericProductId, '');
    }
    db.exec('COMMIT;');
    inTx = false;
    return true;
  } catch {
    if (db && inTx) {
      try {
        db.exec('ROLLBACK;');
      } catch {}
    }
    return false;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}

function deleteGogSqliteProduct(/** @type {string} */ targetDbPath, /** @type {string} */ normId) {
  if (!targetDbPath || !fs.existsSync(targetDbPath) || !/^\d+$/.test(String(normId))) {
    return false;
  }
  const numericProductId = Number(normId);
  const releaseKey = `gog_${normId}`;
  /** @type {any} */
  let db = null;
  let inTx = false;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(targetDbPath, { readBigInts: true });
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('BEGIN IMMEDIATE;');
    inTx = true;
    try {
      db.prepare(
        'DELETE FROM PlayTaskLaunchParameters WHERE playTaskId IN (SELECT id FROM PlayTasks WHERE gameReleaseKey = ?)'
      ).run(releaseKey);
    } catch {}
    try {
      db.prepare('DELETE FROM PlayTasks WHERE gameReleaseKey = ?').run(releaseKey);
    } catch {}
    try {
      db.prepare('DELETE FROM ProductSettings WHERE gameReleaseKey = ?').run(releaseKey);
    } catch {}
    try {
      db.prepare('DELETE FROM ProductsToReleaseKeys WHERE releaseKey = ? OR gogId = ?').run(
        releaseKey,
        numericProductId
      );
    } catch {}
    try {
      db.prepare('DELETE FROM GameFiles WHERE productId = ?').run(numericProductId);
    } catch {}
    try {
      db.prepare('DELETE FROM BaseModificationTargets WHERE productId = ?').run(numericProductId);
    } catch {}
    try {
      db.prepare('DELETE FROM ModificationTargets WHERE productId = ?').run(numericProductId);
    } catch {}
    try {
      db.prepare('DELETE FROM ImportedLatestBuildIds WHERE productId = ?').run(numericProductId);
    } catch {}
    try {
      db.prepare('DELETE FROM InstalledBaseProducts WHERE productId = ?').run(numericProductId);
    } catch {}
    try {
      db.prepare('DELETE FROM InstalledProducts WHERE productId = ?').run(numericProductId);
    } catch {}
    try {
      db.prepare('DELETE FROM ProductStates WHERE productId = ?').run(numericProductId);
    } catch {}
    db.exec('COMMIT;');
    inTx = false;
    return true;
  } catch {
    if (db && inTx) {
      try {
        db.exec('ROLLBACK;');
      } catch {}
    }
    return false;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}

/**
 * Import all GOG game registry values into HKCU and HKCU VirtualStore in a SINGLE async
 * `reg.exe import <temp.reg>` subprocess (UTF-16LE with BOM, zero unprivileged HKLM calls).
 */
async function importWindowsGogRegistryAsync(
  /** @type {string} */ cleanId,
  /** @type {Array<[string, any]>} */ regEntries,
  /** @type {any} */ options = {}
) {
  if (!cleanId || !/^[A-Za-z0-9_-]+$/.test(cleanId)) return false;
  const execFileImpl =
    typeof options.execFileFn === 'function'
      ? options.execFileFn
      : typeof options.execFileImpl === 'function'
        ? options.execFileImpl
        : execFile;

  const formattedPairs = regEntries.map(
    ([valName, valData]) =>
      `"${escapeWineRegString(String(valName))}"="${escapeWineRegString(String(valData ?? ''))}"`
  );
  const regLines = [
    'Windows Registry Editor Version 5.00',
    '',
    `[HKEY_CURRENT_USER\\Software\\GOG.com\\Games\\${cleanId}]`,
    ...formattedPairs,
    '',
    `[HKEY_CURRENT_USER\\Software\\Classes\\VirtualStore\\Machine\\Software\\WOW6432Node\\GOG.com\\Games\\${cleanId}]`,
    ...formattedPairs,
    '',
  ];

  const tempRegPath = path.join(
    os.tmpdir(),
    `ol-gog-reg-${cleanId}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.reg`
  );

  try {
    const utf16Buffer = Buffer.from('\uFEFF' + regLines.join('\r\n'), 'utf16le');
    await fs.promises.writeFile(tempRegPath, utf16Buffer);
    return await new Promise((resolve) => {
      try {
        execFileImpl(
          'reg.exe',
          ['import', tempRegPath],
          { timeout: 5000, windowsHide: true },
          (/** @type {any} */ err) => {
            resolve(!err);
          }
        );
      } catch {
        resolve(false);
      }
    });
  } catch {
    return false;
  } finally {
    try {
      await fs.promises.unlink(tempRegPath);
    } catch {}
  }
}

/**
 * Delete HKCU GOG game registry keys asynchronously on Windows (zero sync calls, zero HKLM).
 */
async function deleteWindowsGogRegistryAsync(
  /** @type {string} */ normId,
  /** @type {any} */ options = {}
) {
  if (!normId || !/^[A-Za-z0-9_-]+$/.test(normId)) return false;
  const execFileImpl =
    typeof options.execFileFn === 'function'
      ? options.execFileFn
      : typeof options.execFileImpl === 'function'
        ? options.execFileImpl
        : execFile;

  const winRegKeys = [
    `HKCU\\Software\\GOG.com\\Games\\${normId}`,
    `HKCU\\Software\\Classes\\VirtualStore\\Machine\\Software\\WOW6432Node\\GOG.com\\Games\\${normId}`,
  ];
  await Promise.all(
    winRegKeys.map(
      (rk) =>
        new Promise((resolve) => {
          try {
            execFileImpl(
              'reg.exe',
              ['delete', rk, '/f'],
              { timeout: 4000, windowsHide: true },
              () => resolve(true)
            );
          } catch {
            resolve(false);
          }
        })
    )
  );
  return true;
}

function syncGogFirstPartyLauncher(/** @type {any} */ record, /** @type {any} */ options = {}) {
  try {
    if (!record || typeof record !== 'object') return { synced: false };
    if (options.fromAutoScan && record.runner === 'gog_galaxy') {
      return { synced: false, skippedNativeGalaxyInstall: true };
    }
    if (
      options.fromAutoScan &&
      options.homedir &&
      !options.syncFirstParty &&
      !options.gogGalaxyDbPath &&
      !options.gogGalaxyConfigPath &&
      !options.bottlePath &&
      !options.bottleGogGalaxyDbPath &&
      options.routeWindowsGogToBottle !== true
    ) {
      return { synced: false };
    }

    const platform = options.platform || process.platform;
    const cleanId = String(record.platformGameId || '')
      .replace(/^gog[-_]/i, '')
      .trim();
    const installPath = record.installPath ? toLocalFsPath(record.installPath) : null;
    if (!cleanId || !installPath || !fs.existsSync(installPath)) {
      return { synced: false };
    }

    const syncCacheKey = `${platform}:${cleanId}:${path.resolve(installPath)}:${options.gogGalaxyDbPath || ''}:${options.gogGalaxyConfigPath || ''}:${options.bottlePath || ''}`;
    let syncInputSig = '';
    try {
      const installStat = fs.statSync(installPath);
      syncInputSig = `${Math.trunc(installStat.mtimeMs)}:${record.executablePath || ''}:${record.version || ''}:${record.clientId || ''}`;
      if (
        options.fromAutoScan === true &&
        syncInputSig &&
        gogFirstPartySyncSignatureCache.get(syncCacheKey) === syncInputSig
      ) {
        return { synced: true, cached: true };
      }
    } catch {}

    flattenGogNestedInstallDir(installPath, cleanId);
    if (platform === 'darwin' && !record.isWindowsBinaryOnMac) {
      ensureMacExecutablePermissions(installPath);
    }

    let innerAppPath = null;
    if (platform === 'darwin' && !installPath.toLowerCase().endsWith('.app')) {
      try {
        const entries = fs.readdirSync(installPath, { withFileTypes: true });
        const appDir = entries.find(
          (d) => d.isDirectory() && d.name.toLowerCase().endsWith('.app')
        );
        if (appDir) {
          innerAppPath = path.join(installPath, appDir.name);
        }
      } catch {}
    }

    const infoFilePath = path.join(installPath, `goggame-${cleanId}.info`);
    const dotInfoFilePath = path.join(installPath, `.goggame-${cleanId}.info`);
    const installRootResDir = path.join(installPath, 'Contents', 'Resources');
    const installRootResInfoPath = path.join(installRootResDir, `goggame-${cleanId}.info`);
    const installRootResDotInfoPath = path.join(installRootResDir, `.goggame-${cleanId}.info`);

    const candidateInfoPaths = [
      installRootResDotInfoPath,
      installRootResInfoPath,
      ...(innerAppPath
        ? [
            path.join(innerAppPath, 'Contents', 'Resources', `.goggame-${cleanId}.info`),
            path.join(innerAppPath, 'Contents', 'Resources', `goggame-${cleanId}.info`),
          ]
        : []),
      dotInfoFilePath,
      infoFilePath,
    ];
    /** @type {any[]} */
    const parsedInfoCandidates = [];
    for (const candidateInfo of candidateInfoPaths) {
      if (fs.existsSync(candidateInfo)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(candidateInfo, 'utf8'));
          if (parsed && typeof parsed === 'object') {
            parsedInfoCandidates.push(parsed);
          }
        } catch {}
      }
    }

    const info =
      parsedInfoCandidates.find(
        (c) =>
          Array.isArray(c.playTasks) && c.playTasks.length > 0 && Boolean(c.playTasks[0]?.path)
      ) ||
      parsedInfoCandidates[0] ||
      {};

    let resolvedExe = record.executablePath ? toLocalFsPath(record.executablePath) : undefined;
    if (!resolvedExe || !fs.existsSync(resolvedExe) || /[\\/]GOGLauncher$/i.test(resolvedExe)) {
      const discovered = findPrimaryExecutable(installPath, {
        platform,
        hintName: record.title || info.name,
        preferWindowsExecutable: Boolean(record.isWindowsBinaryOnMac),
      });
      if (discovered.executablePath && fs.existsSync(discovered.executablePath)) {
        resolvedExe = discovered.executablePath;
      }
    }

    if (resolvedExe) {
      record.executablePath = resolvedExe;
      try {
        const existingManaged = loadManagedInstalledGames(options.userDataDir);
        const mIdx = existingManaged.findIndex(
          (r) =>
            r &&
            r.platformId === 'gog' &&
            (String(r.platformGameId) === cleanId ||
              String(r.platformGameId) === String(record.platformGameId))
        );
        if (mIdx >= 0 && existingManaged[mIdx].executablePath !== resolvedExe) {
          existingManaged[mIdx] = { ...existingManaged[mIdx], executablePath: resolvedExe };
          saveManagedInstalledGames(existingManaged, options.userDataDir);
        }
      } catch {}
    }

    const isWinBottleInstall =
      platform === 'darwin' &&
      (Boolean(record.isWindowsBinaryOnMac) ||
        Boolean(resolvedExe && /\.exe$/i.test(resolvedExe)) ||
        /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(installPath));

    const targetBottleForGog = isWinBottleInstall
      ? resolveTargetBottleForFirstPartySync(record, 'gog', options)
      : null;
    const honorExplicitHostDbInTest = Boolean(
      (options.gogGalaxyDbPath || options.gogGalaxyConfigPath) &&
        !options.bottlePath &&
        !options.bottleGogGalaxyDbPath &&
        options.routeWindowsGogToBottle !== true &&
        !targetBottleForGog
    );
    const isCell2B = Boolean(isWinBottleInstall && !honorExplicitHostDbInTest);

    const execFileSyncImpl =
      typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync;
    const isBundleCodeSigned = (/** @type {string} */ bundlePath) => {
      if (!bundlePath || !fs.existsSync(bundlePath)) return false;
      if (fs.existsSync(path.join(bundlePath, 'Contents', '_CodeSignature'))) {
        return true;
      }
      if (!isTestEnvironment(options) || options.allowCodesignInTest === true) {
        try {
          execFileSyncImpl('codesign', ['--verify', '--deep', '--strict', bundlePath], {
            stdio: 'ignore',
            timeout: 4000,
          });
          return true;
        } catch {}
      }
      return false;
    };

    let galaxyInstallPath = installPath;
    if (
      platform === 'darwin' &&
      !isWinBottleInstall &&
      !installPath.toLowerCase().endsWith('.app')
    ) {
      const hasRootResourcesInfo =
        fs.existsSync(installRootResInfoPath) || fs.existsSync(installRootResDotInfoPath);
      if (!hasRootResourcesInfo && innerAppPath) {
        const innerHasInfo =
          fs.existsSync(
            path.join(innerAppPath, 'Contents', 'Resources', `goggame-${cleanId}.info`)
          ) ||
          fs.existsSync(
            path.join(innerAppPath, 'Contents', 'Resources', `.goggame-${cleanId}.info`)
          );
        if (innerHasInfo || !isBundleCodeSigned(innerAppPath)) {
          galaxyInstallPath = innerAppPath;
        }
      }
    }

    const macResourcesDir = path.join(galaxyInstallPath, 'Contents', 'Resources');
    const macResourcesInfoPath = path.join(macResourcesDir, `goggame-${cleanId}.info`);
    const macResourcesDotInfoPath = path.join(macResourcesDir, `.goggame-${cleanId}.info`);

    const baseDirForPlayTask = isCell2B ? installPath : galaxyInstallPath;
    let relativeExePath = '';
    if (resolvedExe && resolvedExe.startsWith(baseDirForPlayTask)) {
      relativeExePath = path.relative(baseDirForPlayTask, resolvedExe);
    } else if (resolvedExe && resolvedExe.startsWith(installPath)) {
      relativeExePath = path.relative(installPath, resolvedExe);
    } else if (resolvedExe) {
      relativeExePath = path.basename(resolvedExe);
    }
    const useWinBackslashes = platform === 'win32' || isCell2B;
    const formattedRelativeExePath = useWinBackslashes
      ? relativeExePath.replace(/\//g, '\\')
      : relativeExePath.replace(/\\/g, '/');

    const { gogConfigPath, gogDbPath } = resolveGogFirstPartyPaths(options);
    const bottleGogDir = targetBottleForGog
      ? path.join(targetBottleForGog, 'drive_c', 'ProgramData', 'GOG.com', 'Galaxy')
      : null;
    const bottleGogDbPath =
      options.bottleGogGalaxyDbPath ||
      (bottleGogDir
        ? fs.existsSync(path.join(bottleGogDir, 'storage', 'galaxy-2.0.db'))
          ? path.join(bottleGogDir, 'storage', 'galaxy-2.0.db')
          : fs.existsSync(path.join(bottleGogDir, 'Storage', 'galaxy-2.0.db'))
            ? path.join(bottleGogDir, 'Storage', 'galaxy-2.0.db')
            : null
        : null);

    let realBuildId = String(
      info.buildId && /^\d+$/.test(String(info.buildId)) ? info.buildId : cleanId
    );
    let realGeneration = 2;
    const pickValidGogGameClientId = (/** @type {any} */ val) => {
      if (val === null || val === undefined) return '';
      const str = String(val).trim();
      if (!str || str === GOG_GALAXY_LAUNCHER_CLIENT_ID) return '';
      const lower = str.toLowerCase();
      if (lower === 'null' || lower === 'undefined' || lower === 'false' || lower === 'nan') {
        return '';
      }
      return /^[A-Za-z0-9_-]{3,128}$/.test(str) ? str : '';
    };
    let resolvedGameClientId =
      pickValidGogGameClientId(record.clientId) ||
      pickValidGogGameClientId(record.gogClientId) ||
      pickValidGogGameClientId(info.clientId) ||
      parsedInfoCandidates.map((c) => pickValidGogGameClientId(c?.clientId)).find(Boolean) ||
      '';

    const dbForBuildsLookup = isCell2B ? bottleGogDbPath || gogDbPath : gogDbPath;
    if (dbForBuildsLookup && fs.existsSync(dbForBuildsLookup) && /^\d+$/.test(cleanId)) {
      /** @type {any} */
      let dbLookup = null;
      try {
        dbLookup = new (require('node:sqlite').DatabaseSync)(dbForBuildsLookup, {
          readBigInts: true,
        });
        dbLookup.exec('PRAGMA busy_timeout = 3000;');
        const buildRow = dbLookup
          .prepare('SELECT manifest FROM Builds WHERE productId = ? LIMIT 1')
          .get(Number(cleanId));
        if (buildRow && buildRow.manifest) {
          const parsedManifest = JSON.parse(buildRow.manifest);
          const firstItem = parsedManifest?.items?.[0];
          if (firstItem?.generation) realGeneration = Number(firstItem.generation);
          if (realGeneration === 1 && firstItem?.legacy_build_id) {
            realBuildId = String(firstItem.legacy_build_id);
          } else if (firstItem?.build_id) {
            realBuildId = String(firstItem.build_id);
          }
          if (!resolvedGameClientId) {
            resolvedGameClientId =
              pickValidGogGameClientId(firstItem?.clientId) ||
              pickValidGogGameClientId(parsedManifest?.clientId) ||
              '';
          }
        }
      } catch {
      } finally {
        if (dbLookup) {
          try {
            dbLookup.close();
          } catch {}
        }
      }
    }

    if (!resolvedGameClientId) {
      try {
        const cfgCacheFile = path.join(
          getUserDataDir(options.userDataDir),
          'one_launcher_gog_cloud_configs.json'
        );
        if (fs.existsSync(cfgCacheFile)) {
          const parsedCfgCache = JSON.parse(fs.readFileSync(cfgCacheFile, 'utf8'));
          resolvedGameClientId = pickValidGogGameClientId(
            parsedCfgCache?.__productClientIds?.[cleanId]
          );
        }
      } catch {}
    }

    const rawExistingTaskPath =
      Array.isArray(info.playTasks) && info.playTasks[0]?.path
        ? String(info.playTasks[0].path)
        : '';
    const resolvedExistingTaskTarget = rawExistingTaskPath
      ? path.join(baseDirForPlayTask, rawExistingTaskPath.replace(/\\/g, path.sep))
      : '';
    const hasExistingValidPlayTasks = Boolean(
      rawExistingTaskPath &&
        resolvedExistingTaskTarget &&
        fs.existsSync(resolvedExistingTaskTarget) &&
        (!useWinBackslashes || !rawExistingTaskPath.includes('/'))
    );

    const fallbackLangMeta = resolveGogGalaxyLanguageMetadata(info, options);
    const sanitizedBaseInfo = { ...info };
    delete sanitizedBaseInfo.clientId;

    const synthesizedInfo = {
      ...sanitizedBaseInfo,
      buildId: realBuildId,
      ...(resolvedGameClientId ? { clientId: resolvedGameClientId } : {}),
      gameId: String(cleanId),
      rootGameId: String(info.rootGameId || cleanId),
      language: info.language || fallbackLangMeta.name,
      languages:
        Array.isArray(info.languages) && info.languages.length > 0
          ? info.languages
          : [fallbackLangMeta.code],
      name: info.name || record.title || `GOG Game ${cleanId}`,
      osBitness: Array.isArray(info.osBitness) ? info.osBitness : ['64'],
      version: typeof info.version === 'number' ? info.version : 1,
      playTasks: hasExistingValidPlayTasks
        ? info.playTasks
        : [
            {
              category: 'game',
              isPrimary: true,
              languages: [fallbackLangMeta.code],
              name: info.name || record.title || 'Play',
              path: formattedRelativeExePath || '',
              type: 'FileTask',
            },
          ],
    };

    const serializedInfo = JSON.stringify(synthesizedInfo, null, 2);
    let activeInfoFilePath = infoFilePath;
    const writeIfChanged = (/** @type {string} */ targetFilePath, /** @type {string} */ content) => {
      try {
        if (fs.existsSync(targetFilePath)) {
          const existingContent = fs.readFileSync(targetFilePath, 'utf8');
          if (existingContent === content) return false;
        }
        fs.writeFileSync(targetFilePath, content, 'utf8');
        return true;
      } catch {
        return false;
      }
    };

    try {
      const shouldUseMacResourcesLayout =
        platform === 'darwin' &&
        !isWinBottleInstall &&
        (galaxyInstallPath.toLowerCase().endsWith('.app') ||
          fs.existsSync(path.join(galaxyInstallPath, 'Contents')) ||
          Boolean(innerAppPath));

      if (shouldUseMacResourcesLayout) {
        const targetBundleSigned =
          galaxyInstallPath.toLowerCase().endsWith('.app') &&
          isBundleCodeSigned(galaxyInstallPath);
        if (!targetBundleSigned) {
          fs.mkdirSync(macResourcesDir, { recursive: true });
          writeIfChanged(macResourcesInfoPath, serializedInfo);
          writeIfChanged(macResourcesDotInfoPath, serializedInfo);
          activeInfoFilePath = macResourcesInfoPath;
          const rootHashDb = path.join(installPath, `goggame-${cleanId}.hashdb`);
          const resHashDb = path.join(macResourcesDir, `goggame-${cleanId}.hashdb`);
          if (fs.existsSync(rootHashDb) && !fs.existsSync(resHashDb)) {
            fs.copyFileSync(rootHashDb, resHashDb);
          }
        } else if (fs.existsSync(macResourcesInfoPath)) {
          activeInfoFilePath = macResourcesInfoPath;
        }

        if (fs.existsSync(macResourcesInfoPath)) {
          try {
            if (fs.existsSync(infoFilePath)) fs.unlinkSync(infoFilePath);
            if (fs.existsSync(dotInfoFilePath)) fs.unlinkSync(dotInfoFilePath);
          } catch {}
        }
      } else {
        writeIfChanged(infoFilePath, serializedInfo);
        writeIfChanged(dotInfoFilePath, serializedInfo);
        activeInfoFilePath = infoFilePath;
      }
    } catch {}

    const langMeta = resolveGogGalaxyLanguageMetadata(synthesizedInfo, options);
    /** @type {Promise<any> | null} */
    let pendingWinRegImportPromise = null;

    if (isCell2B) {
      const hostMacDbPath =
        options.hostMacGogDbPath ||
        (!options.homedir
          ? fs.existsSync('/Users/Shared/GOG.com/Galaxy/Storage/galaxy-2.0.db')
            ? '/Users/Shared/GOG.com/Galaxy/Storage/galaxy-2.0.db'
            : '/Users/Shared/GOG.com/Galaxy/storage/galaxy-2.0.db'
          : null);
      if (hostMacDbPath && fs.existsSync(hostMacDbPath) && /^\d+$/.test(cleanId)) {
        let shouldPruneHost = false;
        /** @type {any} */
        let checkDb = null;
        try {
          checkDb = new (require('node:sqlite').DatabaseSync)(hostMacDbPath, {
            readBigInts: true,
          });
          checkDb.exec('PRAGMA busy_timeout = 3000;');
          const ibpRow = checkDb
            .prepare('SELECT installationPath FROM InstalledBaseProducts WHERE productId = ?')
            .get(Number(cleanId));
          const ptRow = checkDb
            .prepare(
              'SELECT executablePath FROM PlayTaskLaunchParameters WHERE playTaskId IN (SELECT id FROM PlayTasks WHERE gameReleaseKey = ?)'
            )
            .get(`gog_${cleanId}`);
          if (
            (ibpRow?.installationPath &&
              path.resolve(String(ibpRow.installationPath)) === path.resolve(installPath)) ||
            (ptRow?.executablePath && /\.exe$/i.test(String(ptRow.executablePath)))
          ) {
            shouldPruneHost = true;
          }
        } catch {
        } finally {
          if (checkDb) {
            try {
              checkDb.close();
            } catch {}
          }
        }
        if (shouldPruneHost) {
          deleteGogSqliteProduct(hostMacDbPath, cleanId);
        }
      }

      if (targetBottleForGog && bottleGogDir) {
        const winInstallPath = toWineWindowsPath(installPath, targetBottleForGog);
        const winExePath = resolvedExe ? toWineWindowsPath(resolvedExe, targetBottleForGog) : '';
        const winParentDir = toWineWindowsPath(path.dirname(installPath), targetBottleForGog);

        const bottleCfgPath = path.join(bottleGogDir, 'config.json');
        if (fs.existsSync(bottleCfgPath) || fs.existsSync(bottleGogDir)) {
          try {
            const cfg = fs.existsSync(bottleCfgPath)
              ? JSON.parse(fs.readFileSync(bottleCfgPath, 'utf8')) || {}
              : {};
            if (!Array.isArray(cfg.installationPaths)) cfg.installationPaths = [];
            if (
              winParentDir &&
              winParentDir !== cfg.libraryPath &&
              !cfg.installationPaths.includes(winParentDir)
            ) {
              cfg.installationPaths.push(winParentDir);
              fs.mkdirSync(bottleGogDir, { recursive: true });
              atomicWriteFileSync(bottleCfgPath, JSON.stringify(cfg, null, 2));
            }
          } catch {}
        }

        if (bottleGogDbPath && (fs.existsSync(bottleGogDbPath) || options.bottleGogGalaxyDbPath)) {
          upsertGogSqliteProduct(bottleGogDbPath, {
            cleanId,
            productName: synthesizedInfo.name,
            langMeta,
            realGeneration,
            realBuildId,
            installationPath: winInstallPath,
            playTaskExe: winExePath,
            isMacBundleInfo: false,
          });
        }

        // Upsert Wine system.reg keys (Wow6432Node + 64-bit view) and sync live wineserver asynchronously
        if (!options.skipRegistry) {
          const bottleRegEntries = {
            path: winInstallPath,
            gameID: cleanId,
            gameName: synthesizedInfo.name,
            exe: winExePath,
            workingDir: winInstallPath,
            launchCommand: winExePath,
            launchParam: '',
            ver: String(record.version || '1.0'),
            language: langMeta.regLanguage,
            lang_code: langMeta.code,
            buildId: String(realBuildId),
          };
          upsertWineSystemRegKey(
            targetBottleForGog,
            `Software\\Wow6432Node\\GOG.com\\Games\\${cleanId}`,
            bottleRegEntries,
            options
          );
          upsertWineSystemRegKey(
            targetBottleForGog,
            `Software\\GOG.com\\Games\\${cleanId}`,
            bottleRegEntries,
            options
          );
        }
      }
    } else {
      if (gogConfigPath && fs.existsSync(gogConfigPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(gogConfigPath, 'utf8')) || {};
          if (!Array.isArray(cfg.installationPaths)) {
            cfg.installationPaths = [];
          }
          let cfgChanged = false;
          for (const dirCandidate of [
            path.dirname(galaxyInstallPath),
            path.dirname(installPath),
          ]) {
            if (
              dirCandidate &&
              dirCandidate !== cfg.libraryPath &&
              !cfg.installationPaths.includes(dirCandidate)
            ) {
              cfg.installationPaths.push(dirCandidate);
              cfgChanged = true;
            }
          }
          if (cfgChanged) {
            fs.writeFileSync(gogConfigPath, JSON.stringify(cfg, null, 2), 'utf8');
          }
        } catch {}
      }

      if (gogDbPath && (fs.existsSync(gogDbPath) || options.gogGalaxyDbPath)) {
        const galaxyPlayTaskExe =
          platform === 'darwin' && galaxyInstallPath.toLowerCase().endsWith('.app')
            ? resolveMacAppBundleBinary(galaxyInstallPath) || resolvedExe || ''
            : resolvedExe || '';
        upsertGogSqliteProduct(gogDbPath, {
          cleanId,
          productName: synthesizedInfo.name,
          langMeta,
          realGeneration,
          realBuildId,
          installationPath: galaxyInstallPath,
          playTaskExe: galaxyPlayTaskExe,
          isMacBundleInfo: activeInfoFilePath === macResourcesInfoPath,
        });
      }

      // Single async `reg.exe import <temp.reg>` into HKCU + HKCU VirtualStore in production
      // (zero sync main-thread blocking, zero unprivileged HKLM errors), while preserving
      // `options.execFileSyncFn` DI hook compatibility for synchronous unit test spies.
      if (
        platform === 'win32' &&
        (!options.homedir || typeof options.execFileSyncFn === 'function') &&
        !options.skipRegistry
      ) {
        /** @type {Array<[string, any]>} */
        const regEntries = [
          ['path', installPath],
          ['gameID', cleanId],
          ['gameName', synthesizedInfo.name],
          ['exe', resolvedExe || ''],
          ['workingDir', installPath],
          ['launchCommand', resolvedExe || ''],
          ['launchParam', ''],
          ['ver', String(record.version || '1.0')],
          ['language', langMeta.regLanguage],
          ['lang_code', langMeta.code],
          ['buildId', String(realBuildId)],
        ];
        if (
          typeof options.execFileSyncFn === 'function' ||
          (isTestEnvironment(options) && options.useAsyncRegImport !== true)
        ) {
          const syncRegRunner =
            typeof options.execFileSyncFn === 'function'
              ? options.execFileSyncFn
              : require('node:child_process').execFileSync;
          const diRegKeys = [
            `HKCU\\Software\\GOG.com\\Games\\${cleanId}`,
            `HKCU\\Software\\Classes\\VirtualStore\\MACHINE\\SOFTWARE\\Wow6432Node\\GOG.com\\Games\\${cleanId}`,
          ];
          for (const regKey of diRegKeys) {
            for (const [valName, valData] of regEntries) {
              try {
                syncRegRunner(
                  'reg.exe',
                  ['add', regKey, '/v', valName, '/t', 'REG_SZ', '/d', String(valData ?? ''), '/f'],
                  { stdio: 'ignore', timeout: 3000 }
                );
              } catch {}
            }
          }
        } else {
          pendingWinRegImportPromise = importWindowsGogRegistryAsync(
            cleanId,
            regEntries,
            options
          ).catch(() => false);
        }
      }

      if (
        (!isTestEnvironment(options) || options.notifyRunningGogGalaxy === true) &&
        !options.fromAutoScan
      ) {
        isHostGogGalaxyRunning(options)
          .then((running) => {
            if (!running) return;
            const execFileImpl =
              typeof options.execFileFn === 'function' ? options.execFileFn : execFile;
            if (platform === 'darwin') {
              const resolvedMacApp = !options.gogGalaxyClientBin
                ? resolveGogGalaxyClientBinaryPath({ ...options, platform: 'darwin' })
                : null;
              const macBin =
                options.gogGalaxyClientBin ||
                (resolvedMacApp && resolvedMacApp.endsWith('.app')
                  ? path.join(resolvedMacApp, 'Contents', 'MacOS', 'GOG Galaxy')
                  : resolvedMacApp) ||
                '/Applications/GOG Galaxy.app/Contents/MacOS/GOG Galaxy';
              if (options.gogGalaxyClientBin || fs.existsSync(macBin)) {
                execFileImpl(
                  macBin,
                  ['--command=importGame', `--path=${galaxyInstallPath}`],
                  { timeout: 8000 },
                  () => {}
                );
              }
            } else if (platform === 'win32') {
              const regGog = discoverWindowsGogGalaxyRegistryPaths(options);
              const winBin =
                options.gogGalaxyClientBin ||
                resolveGogGalaxyClientBinaryPath({ ...options, platform: 'win32' }) ||
                regGog.clientExe ||
                'C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe';
              if (options.gogGalaxyClientBin || fs.existsSync(winBin)) {
                execFileImpl(
                  winBin,
                  ['/command=importGame', `/path=${installPath}`],
                  { timeout: 8000 },
                  () => {}
                );
              }
            }
          })
          .catch(() => {});
      }
    }

    if (platform === 'darwin' && !isWinBottleInstall) {
      try {
        ensureMacAppCodeSignatureValid(galaxyInstallPath || installPath, options);
      } catch {}
    }

    if (syncInputSig) {
      try {
        const postStat = fs.statSync(installPath);
        const postSig = `${Math.trunc(postStat.mtimeMs)}:${record.executablePath || ''}:${record.version || ''}:${record.clientId || ''}`;
        setBoundedMapEntry(gogFirstPartySyncSignatureCache, syncCacheKey, postSig, 1000);
      } catch {}
    }

    const resultObj = {
      synced: true,
      infoFilePath: activeInfoFilePath,
      ...(isCell2B && targetBottleForGog
        ? { routedToBottle: true, bottlePath: targetBottleForGog }
        : {}),
    };
    if (pendingWinRegImportPromise) {
      Object.defineProperty(resultObj, '_regImportPromise', {
        value: pendingWinRegImportPromise,
        enumerable: false,
      });
    }
    return resultObj;
  } catch {
    return { synced: false };
  }
}

async function syncGogGameToGalaxy(/** @type {any} */ record, /** @type {any} */ options = {}) {
  const res = /** @type {any} */ (syncGogFirstPartyLauncher(record, options));
  if (res && res._regImportPromise) {
    try {
      await res._regImportPromise;
    } catch {}
  }
  return res;
}

/**
 * Unregister an uninstalled GOG game from GOG Galaxy 2.0 SQLite DB & Wine / Windows Registry
 */
function unregisterGogFirstPartyLauncher(
  /** @type {any} */ cleanId,
  /** @type {any} */ installPath,
  /** @type {any} */ options = {}
) {
  try {
    if (installPath && typeof installPath === 'object') {
      options = installPath;
      installPath = options.installPath || '';
    }
    const platform = options.platform || process.platform;
    const normId = String(cleanId || '')
      .replace(/^gog[-_]/i, '')
      .trim();
    if (!normId) return { removed: false };
    const { gogDbPath } = resolveGogFirstPartyPaths(options);
    const localInstall = installPath ? toLocalFsPath(installPath) : null;

    if (gogDbPath && fs.existsSync(gogDbPath) && /^\d+$/.test(normId)) {
      let skipHostDeleteForCoInstalledApp = false;
      if (platform === 'darwin' && localInstall && !options.gogGalaxyDbPath) {
        /** @type {any} */
        let checkDb = null;
        try {
          const { DatabaseSync } = require('node:sqlite');
          checkDb = new DatabaseSync(gogDbPath, { readBigInts: true });
          checkDb.exec('PRAGMA busy_timeout = 3000;');
          const row = checkDb
            .prepare('SELECT installationPath FROM InstalledBaseProducts WHERE productId = ?')
            .get(Number(normId));
          const hostRegisteredPath = row?.installationPath ? String(row.installationPath) : '';
          if (
            hostRegisteredPath &&
            fs.existsSync(hostRegisteredPath) &&
            path.resolve(hostRegisteredPath) !== path.resolve(localInstall) &&
            !path.resolve(hostRegisteredPath).startsWith(path.resolve(localInstall) + path.sep)
          ) {
            skipHostDeleteForCoInstalledApp = true;
          }
        } catch {
        } finally {
          if (checkDb) {
            try {
              checkDb.close();
            } catch {}
          }
        }
      }
      if (!skipHostDeleteForCoInstalledApp) {
        deleteGogSqliteProduct(gogDbPath, normId);
      }
    }

    if (platform === 'darwin') {
      const bottlePaths = listAllInitializedBottlePaths(options);
      if (options.bottleGogGalaxyDbPath && fs.existsSync(options.bottleGogGalaxyDbPath)) {
        deleteGogSqliteProduct(options.bottleGogGalaxyDbPath, normId);
      }
      for (const bPath of bottlePaths) {
        const bGalaxyDir = path.join(bPath, 'drive_c', 'ProgramData', 'GOG.com', 'Galaxy');
        for (const sub of ['storage', 'Storage']) {
          const bDbPath = path.join(bGalaxyDir, sub, 'galaxy-2.0.db');
          if (fs.existsSync(bDbPath)) {
            deleteGogSqliteProduct(bDbPath, normId);
          }
        }
        if (!options.skipRegistry) {
          deleteWineSystemRegKey(bPath, `Software\\Wow6432Node\\GOG.com\\Games\\${normId}`, options);
          deleteWineSystemRegKey(bPath, `Software\\GOG.com\\Games\\${normId}`, options);
        }
      }
    }

    if (platform === 'win32' && !options.skipRegistry && normId) {
      if (typeof options.execFileSyncFn === 'function') {
        const syncRegKeys = [
          `HKCU\\Software\\GOG.com\\Games\\${normId}`,
          `HKCU\\Software\\Classes\\VirtualStore\\MACHINE\\SOFTWARE\\Wow6432Node\\GOG.com\\Games\\${normId}`,
        ];
        for (const keyPath of syncRegKeys) {
          try {
            options.execFileSyncFn('reg', ['delete', keyPath, '/f'], {
              stdio: 'ignore',
              timeout: 3000,
              windowsHide: true,
            });
          } catch {}
        }
      } else if (!options.homedir) {
        deleteWindowsGogRegistryAsync(normId, options).catch(() => {});
      }
    }

    return { removed: true };
  } catch {
    return { removed: false };
  }
}

/**
 * Ensure gogdl auth.json is populated with GOG OAuth credentials
 */
async function ensureGogdlAuthConfig(/** @type {any} */ options = {}) {
  const { homedir, userDataDir } = resolveIsolatedHomedirAndUserData(options);
  const gogAuthPath = toHostFilesystemPath(
    options.gogAuthPath || path.join(userDataDir, 'gog_store', 'auth.json')
  );

  try {
    const dir = path.dirname(gogAuthPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {}

  const gogTombstoned =
    isStoreDisconnectedTombstoned('gog', options) &&
    !options.savedTokens?.gog &&
    !options.gogAccessToken;
  if (gogTombstoned) {
    try {
      if (fs.existsSync(gogAuthPath)) {
        fs.unlinkSync(gogAuthPath);
      }
    } catch {}
    return {
      gogAuthPath,
      configPath: gogAuthPath,
      authenticated: false,
      disconnectedByUser: true,
      accessToken: undefined,
      refreshToken: null,
      userId: null,
    };
  }

  const sanitizeGogEntry = (/** @type {any} */ rawEntry, isFromDiskOrUntrusted = false) => {
    if (!rawEntry || typeof rawEntry !== 'object') return null;
    const copy = { ...rawEntry };
    const rawUid = String(copy.user_id || copy.userId || '').trim();
    if (
      isFromDiskOrUntrusted &&
      (isMockOrCorruptedToken(copy.access_token) ||
        isMockOrCorruptedToken(copy.refresh_token) ||
        isPoisonedStorefrontToken(rawUid, options))
    ) {
      return null;
    }
    if (isPoisonedStorefrontToken(copy.access_token, options)) {
      delete copy.access_token;
    }
    if (isPoisonedStorefrontToken(copy.refresh_token, options)) {
      delete copy.refresh_token;
    }
    if (!copy.access_token && !copy.refresh_token) return null;
    return copy;
  };

  let existingClientAuth = null;
  if (fs.existsSync(gogAuthPath)) {
    try {
      const parsedAuth = JSON.parse(fs.readFileSync(gogAuthPath, 'utf8'));
      const rawClient = parsedAuth?.['46899977096215655'] || null;
      existingClientAuth = sanitizeGogEntry(rawClient, true);
      if (rawClient && !existingClientAuth) {
        try {
          fs.unlinkSync(gogAuthPath);
        } catch {}
      }
    } catch {}
  }

  const candidateHeroicGogAuthPaths = [
    path.join(homedir, 'Library/Application Support/heroic/gog_store/auth.json'),
    path.join(
      process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
      'heroic',
      'gog_store',
      'auth.json'
    ),
    path.join(homedir, 'AppData', 'Roaming', 'heroic', 'gog_store', 'auth.json'),
    path.join(homedir, '.config/heroic/gog_store/auth.json'),
  ];

  const externalHeroicGogCandidates = [];
  for (const hcPath of candidateHeroicGogAuthPaths) {
    if (!fs.existsSync(hcPath)) continue;
    try {
      const parsedHc = JSON.parse(fs.readFileSync(hcPath, 'utf8'));
      const cleanedHc = sanitizeGogEntry(parsedHc?.['46899977096215655'] || parsedHc, true);
      if (cleanedHc) {
        externalHeroicGogCandidates.push(cleanedHc);
      }
    } catch {}
  }

  const activeStoreSync = options.storeSync || getStoreSync();
  const hasExplicitSavedTokens = Boolean(options.savedTokens);
  const savedTokens =
    options.savedTokens ||
    (activeStoreSync && typeof activeStoreSync.loadSavedTokens === 'function'
      ? activeStoreSync.loadSavedTokens(options)
      : {});

  const sanitizedSavedGog = savedTokens?.gog
    ? sanitizeGogEntry(savedTokens.gog, !hasExplicitSavedTokens)
    : null;
  const sanitizedOptionGog =
    options.gogAccessToken && !isPoisonedStorefrontToken(options.gogAccessToken, options)
      ? { access_token: options.gogAccessToken }
      : null;

  /** @type {any} */
  let gogData = sanitizedSavedGog || sanitizedOptionGog || existingClientAuth || null;
  let loadedFromHeroicFallback = false;

  if (!gogData || (!gogData.access_token && !gogData.refresh_token)) {
    if (externalHeroicGogCandidates.length > 0) {
      gogData = { ...externalHeroicGogCandidates[0] };
      loadedFromHeroicFallback = true;
    }
  }

  if (
    !options.skipNetwork &&
    activeStoreSync &&
    typeof activeStoreSync.renewGogTokens === 'function'
  ) {
    const updatedAtMs = gogData?.updatedAt
      ? new Date(gogData.updatedAt).getTime()
      : gogData?.loginTime
        ? Number(gogData.loginTime) * 1000
        : 0;
    const maxAgeMs = ((gogData?.expires_in || 3600) - 600) * 1000;
    const isExplicitFreshTestToken = Boolean(
      (hasExplicitSavedTokens ||
        /^freshly-renewed/i.test(String(gogData?.access_token || '')) ||
        isMockOrCorruptedToken(gogData?.access_token)) &&
        gogData?.access_token &&
        !updatedAtMs &&
        !options.forceTokenRefresh &&
        !options.storeSync
    );
    const needsRefresh =
      !isExplicitFreshTestToken &&
      (Boolean(options.forceTokenRefresh) ||
        !gogData?.access_token ||
        !updatedAtMs ||
        Number.isNaN(updatedAtMs) ||
        Date.now() - updatedAtMs > maxAgeMs);

    if (needsRefresh) {
      /** @type {any[]} */
      const refreshQueue = [];
      if (gogData?.refresh_token) {
        refreshQueue.push({ cand: gogData, isExternal: loadedFromHeroicFallback });
      }
      for (const extCand of externalHeroicGogCandidates) {
        if (
          extCand.refresh_token &&
          !refreshQueue.some((item) => item.cand.refresh_token === extCand.refresh_token)
        ) {
          refreshQueue.push({ cand: extCand, isExternal: true });
        }
      }

      let renewedSuccess = false;
      for (const { cand, isExternal } of refreshQueue) {
        try {
          const renewed = await activeStoreSync.renewGogTokens(cand.refresh_token);
          if (
            renewed &&
            renewed.access_token &&
            !isPoisonedStorefrontToken(renewed.access_token, options)
          ) {
            gogData = {
              ...(gogData || {}),
              ...cand,
              ...renewed,
              updatedAt: renewed.updatedAt || new Date().toISOString(),
            };
            if (typeof activeStoreSync.saveTokens === 'function') {
              try {
                activeStoreSync.saveTokens(
                  'gog',
                  gogData,
                  isExternal ? { ...options, fromExternalFallback: true } : options
                );
              } catch {}
            }
            renewedSuccess = true;
            break;
          }
        } catch {}
      }

      if (!renewedSuccess && (!gogData || !gogData.access_token)) {
        const fallbackWithAccess = externalHeroicGogCandidates.find((c) => c.access_token);
        if (fallbackWithAccess) {
          gogData = { ...fallbackWithAccess };
          loadedFromHeroicFallback = true;
        }
      }
    }
  }

  if (
    loadedFromHeroicFallback &&
    gogData?.access_token &&
    activeStoreSync &&
    typeof activeStoreSync.saveTokens === 'function'
  ) {
    try {
      activeStoreSync.saveTokens('gog', gogData, { ...options, fromExternalFallback: true });
    } catch {}
  }

  if (gogData && gogData.access_token) {
    const updatedAtMs = gogData.updatedAt ? new Date(gogData.updatedAt).getTime() : 0;
    const loginTimeSec =
      updatedAtMs && !Number.isNaN(updatedAtMs)
        ? Math.floor(updatedAtMs / 1000)
        : gogData.loginTime || existingClientAuth?.loginTime || Math.floor(Date.now() / 1000);

    const authPayload = {
      '46899977096215655': {
        access_token: gogData.access_token,
        refresh_token: gogData.refresh_token || '',
        user_id: gogData.user_id || gogData.userId || '',
        expires_in: gogData.expires_in || 3600,
        loginTime: loginTimeSec,
      },
    };
    try {
      atomicWriteSecureFileSync(gogAuthPath, JSON.stringify(authPayload, null, 2), options);
    } catch (writeErr) {
      diagLog.warn('ensureGogdlAuthConfig.writeSecureAuthJson', writeErr, { gogAuthPath });
    }
  }

  return {
    gogAuthPath,
    configPath: gogAuthPath,
    authenticated: Boolean(gogData?.access_token),
    accessToken: gogData?.access_token,
    refreshToken: gogData?.refresh_token || null,
    userId: gogData?.user_id || gogData?.userId || existingClientAuth?.user_id || null,
  };
}

/**
 * Ensure GOG Galaxy background communication daemon is running when installed on the host OS
 * so GOG Galaxy SDK (`Galaxy64.dll` / `libGalaxy64.dylib`) unlocks achievements in real time.
 */
async function ensureGogGalaxyBackgroundService(/** @type {any} */ options = {}) {
  const targetPlatform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();

  if (
    !isTestEnvironment(options) ||
    options.allowOverlayReaperInTest === true ||
    typeof options.mockOverlayProcessList === 'string'
  ) {
    await reapOrphanedGogOverlayProcesses(options);
  }

  const clientPath = resolveGogGalaxyClientBinaryPath({
    ...options,
    platform: targetPlatform,
    ...(options.homedir ? { homedir } : {}),
  });
  if (!clientPath) {
    return {
      found: false,
      alreadyRunning: false,
      started: false,
      clientPath: null,
    };
  }

  const isRunning = await isHostGogGalaxyRunning({
    ...options,
    platform: targetPlatform,
  });

  if (isRunning) {
    await waitForGogCommunicationServiceReady({
      platform: targetPlatform,
      ...(options.homedir ? { homedir: options.homedir } : {}),
      alreadyRunning: true,
      timeoutMs: 6000,
      options,
    });
    return {
      found: true,
      alreadyRunning: true,
      started: false,
      clientPath,
    };
  }

  const isUnmockedVitestCall =
    Boolean(process.env.VITEST || process.env.NODE_ENV === 'test') &&
    !options.allowGogWakeInTest &&
    options.gogGalaxyClientPath === undefined &&
    typeof options.spawnFn !== 'function';

  if (
    options.disableGogGalaxyWake === true ||
    isUnmockedVitestCall ||
    (options.homedir && !options.allowGogWakeInTest && typeof options.spawnFn !== 'function')
  ) {
    return {
      found: true,
      alreadyRunning: false,
      started: false,
      skippedInTest: true,
      clientPath,
    };
  }

  if (
    targetPlatform === 'darwin' &&
    (!isTestEnvironment(options) || options.enableGogPortEviction === true)
  ) {
    const portBusy = await probeLocalTcpPort(9977, '127.0.0.1', 250, options);
    if (portBusy) {
      const execFileImpl =
        typeof options.execFileImpl === 'function'
          ? options.execFileImpl
          : typeof options.execFileFn === 'function'
            ? options.execFileFn
            : execFile;
      await new Promise((resolve) => {
        try {
          execFileImpl(
            '/usr/bin/pkill',
            ['-TERM', '-f', 'GalaxyCommunication\\.exe|GalaxyClient\\.exe|GalaxyCommunication'],
            { timeout: 2000 },
            () => resolve(undefined)
          );
        } catch {
          resolve(undefined);
        }
      });
      const evictDeadline = Date.now() + 1500;
      while (Date.now() < evictDeadline) {
        const stillBusy = await probeLocalTcpPort(9977, '127.0.0.1', 150, options);
        if (!stillBusy) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }

  let preBootLogOffset = 0;
  try {
    const commLogPath = resolveGogCommunicationLogPath({
      platform: targetPlatform,
      homedir,
      options,
    });
    if (commLogPath && fs.existsSync(commLogPath)) {
      preBootLogOffset = fs.statSync(commLogPath).size;
    }
  } catch {}

  const isDefaultClientMode = options.storefrontClientLifecycle === 'default_client';
  const spawnImpl = options.spawnFn || spawn;
  try {
    if (targetPlatform === 'win32') {
      const winArgs = isDefaultClientMode
        ? ['/runWithoutUpdating']
        : ['/launchViaAutoStart', '/runWithoutUpdating'];
      const child = spawnImpl(clientPath, winArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: !isDefaultClientMode,
      });
      if (child && typeof child.unref === 'function') {
        child.unref();
      }
    } else if (targetPlatform === 'darwin') {
      const macOpenArgs = isDefaultClientMode
        ? ['-a', clientPath, '--args', '--runWithoutUpdating']
        : [
            '-g',
            '-j',
            '-a',
            clientPath,
            '--args',
            '--launchViaAutoStart',
            '--runWithoutUpdating',
          ];
      const child = spawnImpl('/usr/bin/open', macOpenArgs, {
        detached: true,
        stdio: 'ignore',
      });
      if (child && typeof child.unref === 'function') {
        child.unref();
      }
    }

    await waitForGogCommunicationServiceReady({
      platform: targetPlatform,
      ...(options.homedir ? { homedir: options.homedir } : {}),
      preBootLogOffset,
      timeoutMs: 25000,
      options,
    });

    return {
      found: true,
      alreadyRunning: false,
      started: true,
      clientPath,
    };
  } catch {
    return {
      found: true,
      alreadyRunning: false,
      started: false,
      clientPath,
    };
  }
}

/**
 * Discover native host GOG Galaxy client (`GalaxyClient.exe` on Windows, `GOG Galaxy.app` on macOS)
 * while respecting isolated test overrides (`gogGalaxyClientPath`, `customApplicationsDir`, `homedir`).
 */
function resolveGogGalaxyClientBinaryPath(/** @type {any} */ options = {}) {
  const targetPlatform = options.platform || process.platform;
  const isTestEnv = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');

  if (options.gogGalaxyClientPath !== undefined) {
    if (options.gogGalaxyClientPath === null) return null;
    const explicitPath = String(options.gogGalaxyClientPath).trim();
    if (!explicitPath) return null;
    return fs.existsSync(explicitPath) ? explicitPath : null;
  }

  const allowSystem =
    options.allowSystemGogAppInTest === true ||
    options.allowSystemStorefrontClientsInTest === true;

  if (targetPlatform === 'win32') {
    const winCandidates = [];
    if (options.customApplicationsDir) {
      winCandidates.push(
        path.join(options.customApplicationsDir, 'GOG Galaxy', 'GalaxyClient.exe'),
        path.join(options.customApplicationsDir, 'GalaxyClient.exe')
      );
    }
    if (options.homedir) {
      winCandidates.push(
        path.join(options.homedir, 'Program Files (x86)', 'GOG Galaxy', 'GalaxyClient.exe'),
        path.join(options.homedir, 'Program Files', 'GOG Galaxy', 'GalaxyClient.exe'),
        path.join(options.homedir, 'GOG Galaxy', 'GalaxyClient.exe')
      );
    }
    if (
      !options.customApplicationsDir &&
      (!options.homedir || allowSystem) &&
      (!isTestEnv || allowSystem)
    ) {
      const regGog = discoverWindowsGogGalaxyRegistryPaths(options);
      if (regGog.clientExe) {
        winCandidates.push(regGog.clientExe);
      }
      if (process.env['ProgramFiles(x86)']) {
        winCandidates.push(
          path.join(process.env['ProgramFiles(x86)'], 'GOG Galaxy', 'GalaxyClient.exe')
        );
      }
      if (process.env.ProgramFiles) {
        winCandidates.push(
          path.join(process.env.ProgramFiles, 'GOG Galaxy', 'GalaxyClient.exe')
        );
      }
      winCandidates.push(
        'C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe',
        'C:\\Program Files\\GOG Galaxy\\GalaxyClient.exe'
      );
    }
    for (const c of winCandidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  if (targetPlatform === 'darwin') {
    const macCandidates = [];
    if (options.customApplicationsDir) {
      macCandidates.push(path.join(options.customApplicationsDir, 'GOG Galaxy.app'));
    }
    if (options.homedir) {
      macCandidates.push(path.join(options.homedir, 'Applications', 'GOG Galaxy.app'));
    }
    if (
      !options.customApplicationsDir &&
      (!options.homedir || allowSystem) &&
      (!isTestEnv || allowSystem)
    ) {
      macCandidates.push(
        path.join(os.homedir(), 'Applications', 'GOG Galaxy.app'),
        '/Applications/GOG Galaxy.app'
      );
    }
    for (const c of macCandidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  return null;
}

/**
 * Remove stale gogdl cached manifest for a game ID so fresh installs into empty directories
 * never skip downloading due to a leftover heroic_gogdl/manifests/<cleanId> cache file.
 */
function clearStaleGogdlManifestCache(/** @type {any} */ cleanId, /** @type {any} */ options = {}) {
  if (!cleanId) return;
  const homedir = options.homedir || os.homedir();
  const idStr = String(cleanId)
    .replace(/^gog[-_]/i, '')
    .trim();
  if (!idStr) return;

  const candidateManifestPaths = [
    path.join(homedir, 'Library/Application Support/heroic_gogdl/manifests', idStr),
    path.join(homedir, '.config/heroic_gogdl/manifests', idStr),
    path.join(
      process.env.APPDATA || path.join(homedir, 'AppData/Roaming'),
      'heroic_gogdl/manifests',
      idStr
    ),
  ];

  for (const manifestPath of candidateManifestPaths) {
    try {
      if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
        fs.unlinkSync(manifestPath);
      }
    } catch {}
  }
}

async function fetchGogV1Json(
  /** @type {string} */ url,
  /** @type {any} */ headers = {},
  timeoutMs = 8000,
  /** @type {any} */ fetchImpl = null
) {
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res || !res.ok) return null;
    if (typeof res.arrayBuffer !== 'function') {
      if (typeof res.json === 'function') {
        return await res.json();
      }
      if (typeof res.text === 'function') {
        return JSON.parse(await res.text());
      }
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    let text = '';
    try {
      text = buf.toString('utf8');
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        return JSON.parse(text);
      }
    } catch {}
    try {
      return JSON.parse(zlib.inflateSync(buf).toString('utf8'));
    } catch {}
    try {
      return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    } catch {}
    return JSON.parse(text);
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Native Node.js GOG Content System V1 Depot Downloader & Bundle Extractor
 */
async function downloadGogV1Depot(
  /** @type {any} */ {
    taskId,
    cleanId,
    platformGameId,
    title,
    gogPlatformFlag = 'osx',
    finalInstallPath,
    gogToken,
    gogdlBin,
    gogAuthPath,
    platform = process.platform,
    totalBytes = 0,
    includeDlcs = false,
  },
  /** @type {any} */ options = {}
) {
  const updateTask = (
    /** @type {string} */ id,
    /** @type {any} */ partial,
    /** @type {any} */ opts
  ) => {
    if (typeof gogDownloadTaskHooks.updateDownloadTask === 'function') {
      return gogDownloadTaskHooks.updateDownloadTask(id, partial, opts);
    }
    return null;
  };
  const smoothSpeed = (/** @type {string} */ id, /** @type {any} */ sample) => {
    if (typeof gogDownloadTaskHooks.computeSmoothedDownloadSpeed === 'function') {
      return gogDownloadTaskHooks.computeSmoothedDownloadSpeed(id, sample);
    }
    return Math.max(0, Math.round(Number(sample?.rawSpeedBytesPerSec || 0)));
  };

  const { gogLocale, langCode } = resolveHostLocaleInfo(options);
  const preferredLangMeta = resolveGogGalaxyLanguageMetadata(
    { languages: [gogLocale, langCode] },
    options
  );
  const preferredLangTokens = new Set([
    gogLocale.toLowerCase(),
    langCode.toLowerCase(),
    preferredLangMeta.code.toLowerCase(),
    preferredLangMeta.regLanguage.toLowerCase(),
  ]);

  const fetchFn = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const buildsUrl = `https://content-system.gog.com/products/${encodeURIComponent(cleanId)}/os/${encodeURIComponent(gogPlatformFlag)}/builds?generation=2`;
  const buildsJson = await fetchGogV1Json(buildsUrl, {}, 8000, fetchFn);
  const build =
    buildsJson?.items?.find((/** @type {any} */ b) => b && b.generation === 1) ||
    buildsJson?.items?.[0];
  if (!build || !build.link) {
    throw new Error(`No GOG depot build found for ${title}`);
  }

  const repo = await fetchGogV1Json(build.link, {}, 8000, fetchFn);
  const product = repo?.product || {};
  const installDirectory = product.installDirectory || sanitizeDirectoryName(title);
  const depots = Array.isArray(product.depots) ? product.depots : [];
  const matchesGameId = (/** @type {any} */ d) =>
    d &&
    d.manifest &&
    (String(d.gameID || '') === String(cleanId) ||
      (Array.isArray(d.gameIDs) && d.gameIDs.map(String).includes(String(cleanId))) ||
      (!d.gameID && !d.gameIDs));

  const depot =
    depots.find(
      (d) =>
        matchesGameId(d) &&
        Array.isArray(d.languages) &&
        d.languages.some((/** @type {any} */ l) =>
          preferredLangTokens.has(String(l || '').toLowerCase().replace(/_/g, '-'))
        )
    ) ||
    depots.find(
      (d) =>
        matchesGameId(d) &&
        (!Array.isArray(d.languages) ||
          d.languages.some((/** @type {any} */ l) =>
            /^(en(-us)?|english|\*|neutral)$/i.test(String(l))
          ))
    ) ||
    depots.find((d) => d && d.manifest);

  if (!depot || !depot.manifest) {
    throw new Error(`No GOG V1 depot manifest found for ${title}`);
  }

  const manifestBaseUrl = build.link.slice(0, build.link.lastIndexOf('/'));
  const manifestJson = await fetchGogV1Json(
    `${manifestBaseUrl}/${depot.manifest}`,
    {},
    8000,
    fetchFn
  );
  const manifestFiles = Array.isArray(manifestJson?.depot?.files) ? manifestJson.depot.files : [];

  let extractRoot = finalInstallPath;
  if (
    gogPlatformFlag === 'osx' &&
    manifestFiles.some((/** @type {any} */ f) => f && f.path && /^\/?Contents\//i.test(String(f.path)))
  ) {
    if (!finalInstallPath.toLowerCase().endsWith('.app')) {
      const appFolderName = installDirectory.toLowerCase().endsWith('.app')
        ? installDirectory
        : `${installDirectory}.app`;
      extractRoot = path.join(finalInstallPath, appFolderName);
    }
  }
  await fs.promises.mkdir(extractRoot, { recursive: true });

  const buildLegacyId = build.legacy_build_id || build.build_id;
  const secureUrl = `https://content-system.gog.com/products/${encodeURIComponent(cleanId)}/secure_link?_version=2&generation=1&type=depot&path=/${encodeURIComponent(gogPlatformFlag)}/${encodeURIComponent(buildLegacyId)}`;
  const secureJson = await fetchGogV1Json(
    secureUrl,
    {
      Authorization: `Bearer ${gogToken}`,
    },
    8000,
    fetchFn
  );

  const urlObj = secureJson?.urls?.[0];
  let mainBinUrl = '';
  if (urlObj && urlObj.url_format && urlObj.parameters) {
    let formatted = String(urlObj.url_format);
    for (const [k, v] of Object.entries(urlObj.parameters)) {
      formatted = formatted.replace(`{${k}}`, String(v));
    }
    mainBinUrl = `${formatted.replace(/\/+$/, '')}/main.bin`;
  } else if (typeof urlObj === 'string') {
    mainBinUrl = `${urlObj.replace(/\/+$/, '')}/main.bin`;
  } else if (urlObj && typeof urlObj.url === 'string') {
    mainBinUrl = `${urlObj.url.replace(/\/+$/, '')}/main.bin`;
  }

  if (!mainBinUrl) {
    throw new Error(`Failed to resolve GOG V1 secure CDN link for ${title}`);
  }

  const maxEnd = manifestFiles.reduce(
    (/** @type {number} */ acc, /** @type {any} */ f) =>
      f && f.size > 0 && typeof f.offset === 'number' ? Math.max(acc, f.offset + f.size) : acc,
    0
  );
  const extractedDiskBytes = manifestFiles.reduce(
    (/** @type {number} */ acc, /** @type {any} */ f) =>
      acc + (Number(f?.size) > 0 ? Number(f.size) : 0),
    0
  );
  const effectiveTotalBytes = maxEnd || totalBytes;

  const tempBinPath = path.join(finalInstallPath, `.gog_v1_${cleanId}_main.bin`);
  let existingBytes = 0;
  try {
    const st = await fs.promises.stat(tempBinPath);
    existingBytes = Math.max(0, Number(st.size) || 0);
  } catch {}

  if (taskId) {
    const initialPct =
      effectiveTotalBytes > 0 && existingBytes > 0
        ? Math.min(98, Math.round((existingBytes / effectiveTotalBytes) * 100))
        : 0;
    updateTask(
      taskId,
      {
        status: 'downloading',
        tempBinPath,
        ...(existingBytes > 0
          ? { bytesDownloaded: existingBytes, progressPercent: initialPct }
          : {}),
        totalBytes: effectiveTotalBytes,
        statusMessage:
          existingBytes > 0
            ? `Resuming GOG V1 depot archive (${initialPct}%)...`
            : 'Downloading GOG V1 depot archive...',
      },
      options
    );
  }

  const controller = new AbortController();
  const ctrl = {
    type: 'abort',
    controller,
    tempBinPath,
    pausedByUser: false,
    cancelRequested: false,
    exitedWhilePaused: false,
    resumeInstallFn: async () => {
      let freshToken = gogToken;
      try {
        if (typeof options.refreshGogTokenFn === 'function') {
          const refreshed = await options.refreshGogTokenFn(options);
          if (refreshed) freshToken = refreshed;
        } else {
          const refreshedAuth = await ensureGogdlAuthConfig(options);
          if (refreshedAuth && refreshedAuth.accessToken) {
            freshToken = refreshedAuth.accessToken;
          }
        }
      } catch (refreshErr) {
        diagLog.warn('downloadGogV1Depot.refreshTokenOnResume', refreshErr, { cleanId });
      }
      return downloadGogV1Depot(
        {
          taskId,
          cleanId,
          platformGameId,
          title,
          gogPlatformFlag,
          finalInstallPath,
          gogToken: freshToken,
          gogdlBin,
          gogAuthPath,
          platform,
          totalBytes: effectiveTotalBytes,
          includeDlcs,
        },
        options
      ).catch((v1Err) => {
        if (v1Err && (v1Err.isPausedByUser || v1Err.isCancelledByUser)) return;
        if (taskId) {
          const curTask = downloadQueueMap.get(taskId);
          if (curTask && curTask.status === 'cancelled') return;
          updateTask(
            taskId,
            {
              status: 'failed',
              speedBytesPerSec: 0,
              etaSeconds: undefined,
              error: v1Err.message,
              statusMessage: `V1 depot installation failed: ${v1Err.message}`,
            },
            options
          );
        }
      });
    },
  };
  if (taskId) {
    downloadControllers.set(taskId, ctrl);
  }

  try {
    let bytesDownloaded = existingBytes;
    const alreadyFullyDownloaded =
      existingBytes > 0 && effectiveTotalBytes > 0 && existingBytes >= effectiveTotalBytes;

    if (!alreadyFullyDownloaded) {
      const reqHeaders = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};
      const binRes = await fetchFn(mainBinUrl, {
        ...(Object.keys(reqHeaders).length > 0 ? { headers: reqHeaders } : {}),
        signal: controller.signal,
      });
      if (!binRes.ok || !binRes.body) {
        throw new Error(`GOG V1 CDN returned HTTP ${binRes.status}`);
      }

      const isPartialResume = existingBytes > 0 && binRes.status === 206;
      const outFh = await fs.promises.open(tempBinPath, isPartialResume ? 'a' : 'w');
      bytesDownloaded = isPartialResume ? existingBytes : 0;
      let lastEmitTime = Date.now();
      let lastEmitBytes = bytesDownloaded;

      try {
        for await (const chunk of binRes.body) {
          if (ctrl.cancelRequested) {
            /** @type {any} */
            const cancelErr = new Error('Download cancelled by user');
            cancelErr.name = 'AbortError';
            cancelErr.isCancelledByUser = true;
            throw cancelErr;
          }
          if (ctrl.pausedByUser || controller.signal.aborted) {
            /** @type {any} */
            const abortErr = new Error('Download paused by user');
            abortErr.name = 'AbortError';
            abortErr.isPausedByUser = true;
            throw abortErr;
          }
          const buf = Buffer.from(chunk);
          await outFh.write(buf);
          bytesDownloaded += buf.length;

          const now = Date.now();
          if (taskId && now - lastEmitTime >= 250) {
            const elapsedSec = Math.max(0.05, (now - lastEmitTime) / 1000);
            const rawInstantSpeed = Math.round((bytesDownloaded - lastEmitBytes) / elapsedSec);
            const speedBytesPerSec = smoothSpeed(taskId, {
              bytesDownloaded,
              rawSpeedBytesPerSec: rawInstantSpeed,
              nowMs: now,
            });
            const pct =
              effectiveTotalBytes > 0
                ? Math.min(98, Math.round((bytesDownloaded / effectiveTotalBytes) * 100))
                : 0;
            const etaSeconds =
              speedBytesPerSec > 0 && effectiveTotalBytes > bytesDownloaded
                ? Math.max(
                    1,
                    Math.round((effectiveTotalBytes - bytesDownloaded) / speedBytesPerSec)
                  )
                : undefined;

            updateTask(
              taskId,
              {
                status: 'downloading',
                progressPercent: pct,
                bytesDownloaded,
                totalBytes: effectiveTotalBytes,
                speedBytesPerSec,
                etaSeconds,
                statusMessage: `Downloading GOG V1 depot (${pct}%)...`,
              },
              options
            );
            lastEmitTime = now;
            lastEmitBytes = bytesDownloaded;
          }
        }
      } finally {
        try {
          await outFh.close();
        } catch {}
      }
    }

    if (ctrl.cancelRequested) {
      /** @type {any} */
      const cancelErr = new Error('Download cancelled by user');
      cancelErr.name = 'AbortError';
      cancelErr.isCancelledByUser = true;
      throw cancelErr;
    }

    if (ctrl.pausedByUser || controller.signal.aborted) {
      /** @type {any} */
      const abortErr = new Error('Download paused by user');
      abortErr.name = 'AbortError';
      abortErr.isPausedByUser = true;
      throw abortErr;
    }

    if (taskId) {
      updateTask(
        taskId,
        {
          status: 'extracting',
          progressPercent: 98,
          bytesDownloaded: effectiveTotalBytes || bytesDownloaded,
          totalBytes: effectiveTotalBytes || bytesDownloaded,
          speedBytesPerSec: 0,
          etaSeconds: 1,
          statusMessage: 'Extracting GOG V1 depot files & bundles...',
        },
        options
      );
    }

    const inFh = await fs.promises.open(tempBinPath, 'r');
    const copyBuf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let extractedBytes = 0;
    let lastExtractEmitMs = Date.now();
    try {
      for (const f of manifestFiles) {
        if (ctrl.cancelRequested) {
          /** @type {any} */
          const cancelErr = new Error('Download cancelled by user');
          cancelErr.name = 'AbortError';
          cancelErr.isCancelledByUser = true;
          throw cancelErr;
        }
        if (!f || !f.path) continue;
        const rawEntryPath = String(f.path);
        const relPath = rawEntryPath.replace(/^[\/\\]+/, '').replace(/\\/g, path.sep);
        if (!relPath) continue;
        const destPath = path.resolve(extractRoot, relPath);

        if (!isContainedWithinRoot(extractRoot, destPath, platform)) {
          diagLog.warn(
            'downloadGogV1Depot.pathTraversalBlocked',
            'Blocked depot entry escaping extractRoot',
            {
              extractRoot,
              entryPath: rawEntryPath,
            }
          );
          continue;
        }

        if (f.directory) {
          await fs.promises.mkdir(destPath, { recursive: true });
        } else if (f.symlinkType || (f.target && f.size === undefined)) {
          const targetStr = String(f.target || '');
          const resolvedLinkTarget = path.resolve(path.dirname(destPath), targetStr);
          if (!targetStr || !isContainedWithinRoot(extractRoot, resolvedLinkTarget, platform)) {
            diagLog.warn(
              'downloadGogV1Depot.symlinkEscapeBlocked',
              'Blocked depot symlink escaping extractRoot',
              {
                extractRoot,
                entryPath: rawEntryPath,
                target: targetStr,
              }
            );
            continue;
          }
          await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
          try {
            await fs.promises.unlink(destPath).catch(() => {});
            await fs.promises.symlink(targetStr, destPath);
          } catch (symErr) {
            diagLog.warn('downloadGogV1Depot.symlinkCreate', symErr, { destPath });
          }
        } else if (typeof f.size === 'number') {
          await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
          const mode = f.executable || /\/MacOS\//i.test(relPath) ? 0o755 : 0o644;
          const fileOutFh = await fs.promises.open(destPath, 'w', mode);
          try {
            let remaining = f.size;
            let readPos = Number(f.offset || 0);
            let writePos = 0;
            while (remaining > 0) {
              if (ctrl.cancelRequested) {
                /** @type {any} */
                const cancelErr = new Error('Download cancelled by user');
                cancelErr.name = 'AbortError';
                cancelErr.isCancelledByUser = true;
                throw cancelErr;
              }
              const toRead = Math.min(copyBuf.length, remaining);
              const { bytesRead } = await inFh.read(copyBuf, 0, toRead, readPos);
              if (bytesRead <= 0) break;
              await fileOutFh.write(copyBuf, 0, bytesRead, writePos);
              remaining -= bytesRead;
              readPos += bytesRead;
              writePos += bytesRead;
              extractedBytes += bytesRead;

              const nowMs = Date.now();
              if (taskId && nowMs - lastExtractEmitMs >= 250) {
                const extPct =
                  effectiveTotalBytes > 0
                    ? Math.min(99, 98 + Math.floor((extractedBytes / effectiveTotalBytes) * 1.9))
                    : 99;
                updateTask(
                  taskId,
                  {
                    status: 'extracting',
                    progressPercent: extPct,
                    speedBytesPerSec: 0,
                    statusMessage: `Extracting GOG V1 depot files (${Math.min(100, Math.round((extractedBytes / Math.max(1, effectiveTotalBytes)) * 100))}%)...`,
                  },
                  options
                );
                lastExtractEmitMs = nowMs;
              }
            }
          } finally {
            try {
              await fileOutFh.close();
            } catch {}
          }
        }
      }
    } finally {
      try {
        await inFh.close();
      } catch {}
      try {
        await fs.promises.unlink(tempBinPath);
      } catch (/** @type {any} */ unlinkErr) {
        if (unlinkErr && unlinkErr.code !== 'ENOENT') {
          diagLog.warn('downloadGogV1Depot.unlinkExtractedBin', unlinkErr, { tempBinPath });
        }
      }
    }

    if (taskId) {
      downloadControllers.delete(taskId);
    }

    if (platform === 'darwin') {
      ensureMacExecutablePermissions(finalInstallPath);
      executableDiscoveryCache.clear();
      const macExeDiscovery = findPrimaryExecutable(finalInstallPath, {
        platform: 'darwin',
        hintName: title,
      });

      if (macExeDiscovery.executablePath) {
        const machO = inspectMacMachOHeader(macExeDiscovery.executablePath);
        const resolvedAuthPath =
          gogAuthPath ||
          path.join(getUserDataDir(options.userDataDir), 'gog_store', 'auth.json');
        const resolvedGogdlBin = gogdlBin || findGogdlBinary(options);
        if (
          machO.is32BitOnly &&
          resolvedGogdlBin &&
          fs.existsSync(resolvedAuthPath) &&
          !options.disableGogdlSpawn
        ) {
          if (taskId) {
            updateTask(
              taskId,
              {
                status: 'downloading',
                statusMessage:
                  '32-bit macOS build detected; downloading Windows build for CrossOver/Wine...',
              },
              options
            );
          }
          await new Promise((resolve) => {
            const winChild = spawn(
              resolvedGogdlBin,
              [
                '--auth-config-path',
                resolvedAuthPath,
                'download',
                cleanId,
                '--platform',
                'windows',
                '--path',
                finalInstallPath,
                includeDlcs ? '--with-dlcs' : '--skip-dlcs',
                '--lang',
                gogLocale || 'en-US',
              ],
              { stdio: 'ignore' }
            );
            winChild.on('error', () => resolve(undefined));
            winChild.on('exit', () => resolve(undefined));
          });
        }
      }
    }

    executableDiscoveryCache.clear();
    const finalExeDiscovery = findPrimaryExecutable(finalInstallPath, {
      platform,
      hintName: title,
      preferWindowsExecutable: platform === 'darwin' && gogPlatformFlag === 'windows',
    });
    const isWindowsBinaryOnMac = Boolean(finalExeDiscovery.isWindowsBinaryOnMac);

    const resolvedDepotClientId =
      [
        product?.clientId,
        repo?.clientId,
        manifestJson?.clientId,
        build?.clientId,
        buildsJson?.items?.[0]?.clientId,
      ]
        .map((val) => (val === null || val === undefined ? '' : String(val).trim()))
        .find(
          (str) =>
            str &&
            str !== GOG_GALAXY_LAUNCHER_CLIENT_ID &&
            /^[A-Za-z0-9_-]{3,128}$/.test(str)
        ) || undefined;

    writeManagedInstallSentinel(finalInstallPath, {
      store: 'gog',
      gameId: String(platformGameId || cleanId),
      installKind: 'gog-direct',
    });

    const gogRecord = {
      platformId: 'gog',
      platformGameId: String(platformGameId || cleanId),
      title,
      installPath: finalInstallPath,
      executablePath: finalExeDiscovery.executablePath,
      installSize:
        sanitizeGameInstallSizeBytes(extractedDiskBytes) ||
        sanitizeGameInstallSizeBytes(effectiveTotalBytes),
      runner: 'gogdl',
      isWindowsBinaryOnMac,
      ...(resolvedDepotClientId ? { clientId: resolvedDepotClientId } : {}),
    };

    upsertManagedInstallRecord(gogRecord, options.userDataDir);
    try {
      syncGogFirstPartyLauncher(gogRecord, options);
    } catch {}

    if (taskId) {
      updateTask(
        taskId,
        {
          status: 'completed',
          progressPercent: 100,
          bytesDownloaded: effectiveTotalBytes,
          totalBytes: effectiveTotalBytes,
          speedBytesPerSec: 0,
          etaSeconds: 0,
          tempBinPath: undefined,
          finalInstallPath,
          executablePath: finalExeDiscovery.executablePath,
          runner: 'gogdl',
          isWindowsBinaryOnMac,
          statusMessage: 'Installed via GOG V1 depot extractor',
        },
        options
      );
    }

    return {
      success: true,
      installPath: finalInstallPath,
      extractRoot,
      executablePath: finalExeDiscovery.executablePath,
      isWindowsBinaryOnMac,
      totalBytes: effectiveTotalBytes,
    };
  } catch (/** @type {any} */ err) {
    const wasPaused = Boolean(
      !ctrl.cancelRequested &&
        !(err && err.isCancelledByUser) &&
        (ctrl.pausedByUser ||
          (err && err.isPausedByUser) ||
          (taskId && downloadQueueMap.get(taskId)?.status === 'paused'))
    );
    if (wasPaused) {
      ctrl.exitedWhilePaused = true;
      if (err && typeof err === 'object') {
        err.isPausedByUser = true;
      }
      throw err;
    }
    if (taskId) {
      downloadControllers.delete(taskId);
    }
    try {
      await fs.promises.unlink(tempBinPath);
    } catch (/** @type {any} */ unlinkErr) {
      if (unlinkErr && unlinkErr.code !== 'ENOENT') {
        diagLog.warn('downloadGogV1Depot.unlinkFailedBin', unlinkErr, { tempBinPath });
      }
    }
    throw err;
  }
}

module.exports = {
  setGogDownloadTaskHooks,
  sanitizeDirectoryName,
  resolveGogFirstPartyPaths,
  resolveGogGalaxyLanguageMetadata,
  upsertGogSqliteProduct,
  deleteGogSqliteProduct,
  importWindowsGogRegistryAsync,
  deleteWindowsGogRegistryAsync,
  syncGogFirstPartyLauncher,
  syncGogGameToGalaxy,
  unregisterGogFirstPartyLauncher,
  ensureGogdlAuthConfig,
  ensureGogGalaxyBackgroundService,
  resolveGogGalaxyClientBinaryPath,
  clearStaleGogdlManifestCache,
  fetchGogV1Json,
  downloadGogV1Depot,
};
