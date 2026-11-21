// @ts-check
'use strict';

const path = require('node:path');
const { normalizePublisherLauncherId } = require('../../utils/windowsRegistryDiscovery.cjs');

/**
 * @typedef {'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot'} ChainedHandoffId
 * @typedef {'ubisoft' | 'ea' | 'bnet' | 'rockstar'} ProvisionableChainedHandoffId
 */

/**
 * @typedef {Object} ChainedPublisherEcosystemDescriptor
 * @property {ChainedHandoffId} handoffId
 * @property {string} displayName
 * @property {string} [installerUrl]
 * @property {string} [installerFileName]
 * @property {number} [estimatedDownloadMB]
 * @property {readonly string[]} [silentArgs]
 * @property {boolean} [requiresDotNetMscoreeForInstall]
 * @property {boolean} supportedInWineBottle
 * @property {readonly string[]} [wineClientArgs]
 * @property {Readonly<Record<string, string>>} [wineEnvOverrides]
 * @property {'host_ubisoft' | 'host_ea' | 'host_bnet' | 'host_rockstar' | 'host_riot'} [hostComponentId]
 * @property {'bottle_ubisoft' | 'bottle_ea' | 'bottle_bnet' | 'bottle_rockstar'} [bottleComponentId]
 * @property {string} [unsupportedBottleReason]
 */

/**
 * @typedef {Object} DiscoveredPublisherLauncherInfo
 * @property {boolean} installed
 * @property {string} [binaryPath]
 * @property {string} [launcherAppPath]
 * @property {string} [backgroundServicePath]
 * @property {string} [installDir]
 * @property {string} [version]
 * @property {boolean} [hasLocalSession]
 * @property {string} [unsupportedBottleReason]
 */

/**
 * @typedef {Object} ScannedPublisherInstalledGame
 * @property {ChainedHandoffId} handoffId
 * @property {string} [externalInstallId]
 * @property {string} [tactUid]
 * @property {string} [launchProductCode]
 * @property {string} title
 * @property {string} installPath
 * @property {string} [executablePath]
 * @property {number} [installSizeBytes]
 * @property {string} [bottlePath]
 * @property {string} [bottleName]
 */

/**
 * @typedef {Object} ChainedLauncherLaunchSpec
 * @property {string} launcherExe
 * @property {string[]} args
 * @property {Record<string, string>} envOverrides
 * @property {string} [uri]
 * @property {string | null} [protocolUri]
 * @property {string | null} [targetExecutablePath]
 * @property {string} [expectedGameExe]
 * @property {string} [tactUid]
 * @property {string} [launchProductCode]
 */

/**
 * @typedef {Object} BattleNetProductDbInstallEntry
 * @property {string} uid
 * @property {string} productCode
 * @property {string} launchProductCode
 * @property {string} installPath
 * @property {string} playRegion
 * @property {boolean} installed
 * @property {boolean} playable
 * @property {string} currentVersionStr
 * @property {boolean} [hasCachedState]
 */

const EA_DESKTOP_MSI_UPGRADE_CODE = '{ADF2591E-00D2-4FFF-9BF4-9CCDAE6BDC67}';

/** @type {Readonly<Record<ChainedHandoffId, Readonly<ChainedPublisherEcosystemDescriptor>>>} */
const CHAINED_PUBLISHER_ECOSYSTEMS = Object.freeze({
  ubisoft: Object.freeze({
    handoffId: 'ubisoft',
    displayName: 'Ubisoft Connect',
    installerUrl:
      'https://static3.cdn.ubi.com/orbit/launcher_installer/UbisoftConnectInstaller.exe',
    installerFileName: 'UbisoftConnectInstaller.exe',
    estimatedDownloadMB: 255,
    silentArgs: Object.freeze(['/S']),
    supportedInWineBottle: true,
    wineClientArgs: Object.freeze([
      '--no-sandbox',
      '--in-process-gpu',
      '--disable-gpu',
      '--force-device-scale-factor=1',
    ]),
    wineEnvOverrides: Object.freeze({
      WINEDLLOVERRIDES: 'winemenubuilder.exe=d',
      WINE_SIMULATE_WRITECOPY: '1',
      DXMT_ALLOW_CROSS_PROCESS_SWAPCHAIN: '1',
    }),
    hostComponentId: 'host_ubisoft',
    bottleComponentId: 'bottle_ubisoft',
  }),
  ea: Object.freeze({
    handoffId: 'ea',
    displayName: 'EA App',
    installerUrl:
      'https://origin-a.akamaihd.net/EA-Desktop-Client-Download/installer-releases/EAappOfflineInstaller.exe',
    installerFileName: 'EAappOfflineInstaller.exe',
    estimatedDownloadMB: 255,
    silentArgs: Object.freeze([
      '/quiet',
      '/norestart',
      'EAX_LAUNCH_CLIENT=0',
      'CreateDesktopShortcut=0',
    ]),
    requiresDotNetMscoreeForInstall: true,
    supportedInWineBottle: true,
    wineClientArgs: Object.freeze(['--in-process-gpu', '--use-gl=angle']),
    wineEnvOverrides: Object.freeze({
      WINEDLLOVERRIDES: 'msxml2,msxml3=n,b;winemenubuilder.exe=d',
      WINE_SIMULATE_WRITECOPY: '1',
      DXMT_ALLOW_CROSS_PROCESS_SWAPCHAIN: '1',
    }),
    hostComponentId: 'host_ea',
    bottleComponentId: 'bottle_ea',
  }),
  bnet: Object.freeze({
    handoffId: 'bnet',
    displayName: 'Battle.net',
    installerUrl:
      'https://downloader.battle.net/download/getInstaller?os=win&installer=Battle.net-Setup.exe',
    installerFileName: 'Battle.net-Setup.exe',
    estimatedDownloadMB: 180,
    silentArgs: Object.freeze(['--lang=enUS', '--installpath=C:\\Program Files (x86)\\Battle.net']),
    supportedInWineBottle: true,
    wineClientArgs: Object.freeze([]),
    wineEnvOverrides: Object.freeze({
      WINE_WAIT_CHILD_PIPE_IGNORE: 'Agent.exe',
      WINEDLLOVERRIDES: 'systemsurvey.exe=d;winemenubuilder.exe=d',
      WINE_SIMULATE_WRITECOPY: '1',
      DXMT_ALLOW_CROSS_PROCESS_SWAPCHAIN: '1',
    }),
    hostComponentId: 'host_bnet',
    bottleComponentId: 'bottle_bnet',
  }),
  rockstar: Object.freeze({
    handoffId: 'rockstar',
    displayName: 'Rockstar Games Launcher',
    installerUrl:
      'https://gamedownloads.rockstargames.com/public/installer/Rockstar-Games-Launcher.exe',
    installerFileName: 'Rockstar-Games-Launcher.exe',
    estimatedDownloadMB: 115,
    silentArgs: Object.freeze(['/s', '/f']),
    supportedInWineBottle: true,
    wineClientArgs: Object.freeze([]),
    wineEnvOverrides: Object.freeze({
      WINE_WAIT_CHILD_PIPE_IGNORE: 'Launcher.exe',
      WINEDLLOVERRIDES: 'winemenubuilder.exe=d',
      WINE_SIMULATE_WRITECOPY: '1',
      DXMT_ALLOW_CROSS_PROCESS_SWAPCHAIN: '1',
    }),
    hostComponentId: 'host_rockstar',
    bottleComponentId: 'bottle_rockstar',
  }),
  riot: Object.freeze({
    handoffId: 'riot',
    displayName: 'Riot Client',
    installerUrl:
      'https://lol.secure.dyn.riotcdn.net/channels/public/x/installer/current/live.na.exe',
    installerFileName: 'Install Riot Client.exe',
    estimatedDownloadMB: 75,
    silentArgs: Object.freeze(['--skip-to-install']),
    hostComponentId: 'host_riot',
    supportedInWineBottle: false,
    unsupportedBottleReason:
      'Requires Riot Vanguard Windows kernel anti-cheat driver (vgk.sys), which cannot run inside macOS Wine/CrossOver bottles.',
  }),
});

const PUBLISHER_LAUNCHER_SPECS = CHAINED_PUBLISHER_ECOSYSTEMS;

/**
 * Finite Battle.net NGDP TACT / `product.db` UID -> case-sensitive `--exec="launch <ProductId>"`
 * and `battlenet://<ProductId>` wire-protocol product code table.
 * @type {Readonly<Record<string, string>>}
 */
const BATTLE_NET_LAUNCH_PRODUCT_CODE_MAP = Object.freeze({
  fenris: 'Fen',
  fen: 'Fen',
  prometheus: 'Pro',
  pro: 'Pro',
  hs_beta: 'WTCG',
  hsb: 'WTCG',
  wtcg: 'WTCG',
  osi: 'OSI',
  d3: 'D3',
  diablo3: 'D3',
  d3cn: 'D3',
  anbs: 'ANBS',
  d1: 'D1',
  wow: 'WoW',
  wow_classic: 'WoW_wow_classic',
  wow_classic_era: 'WoW_wow_classic_era',
  heroes: 'Hero',
  hero: 'Hero',
  s1: 'S1',
  s2: 'S2',
  w3: 'W3',
  w1r: 'W1R',
  w2r: 'W2R',
  w1: 'W1',
  w2: 'W2',
  w2bn: 'W2',
  rtro: 'RTRO',
  gryphon: 'GRY',
  gry: 'GRY',
  wlby: 'WLBY',
  libra: 'LBRA',
  lbra: 'LBRA',
  aqua: 'AQUA',
  aris: 'ARIS',
  scorpio: 'SCOR',
  scor: 'SCOR',
  arkansas: 'ARK',
  ark: 'ARK',
  codhq: 'CODHQ',
  auks: 'AUKS',
  pinta: 'PNTA',
  pnta: 'PNTA',
  viper: 'VIPR',
  vipr: 'VIPR',
  odin: 'ODIN',
  lazarus: 'LAZR',
  lazr: 'LAZR',
  zeus: 'ZEUS',
  fore: 'FORE',
});

const SAFE_EXTERNAL_LAUNCH_ID_RE = /^[A-Za-z0-9._:-]+$/;
const MAX_EXTERNAL_LAUNCH_ID_LEN = 128;

/**
 * Strictly validate an external publisher game ID or launch code against `/^[A-Za-z0-9._:-]+$/`
 * (rejecting whitespace, quotes, URI delimiters `? # / \ &`, control characters, `..` traversal,
 * and leading `-` flag injection) before interpolating into launcher URIs or CLI arguments.
 *
 * @param {unknown} raw
 * @returns {string} Validated trimmed ID, or `''` if invalid.
 */
function sanitizeExternalLaunchId(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_EXTERNAL_LAUNCH_ID_LEN) return '';
  if (trimmed.startsWith('-')) return '';
  if (trimmed.includes('..')) return '';
  if (!SAFE_EXTERNAL_LAUNCH_ID_RE.test(trimmed)) return '';
  return trimmed;
}

/**
 * Return `true` when `raw` passes strict external publisher launch-ID validation.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
function isValidExternalLaunchId(raw) {
  return sanitizeExternalLaunchId(raw).length > 0;
}

/**
 * Normalize publisher ecosystem identifier or alias to canonical `ChainedHandoffId`.
 *
 * @param {unknown} raw
 * @returns {ChainedHandoffId | null}
 */
function normalizeChainedHandoffId(raw) {
  if (typeof raw !== 'string') return null;
  return normalizePublisherLauncherId(raw);
}

/**
 * Normalize a Battle.net NGDP TACT UID / `.build.info` product / `product.db` `uid` or `productCode`
 * to Battle.net's exact case-sensitive `--exec="launch <ProductId>"` protocol identifier.
 * Rejects any identifier containing invalid characters or leading hyphens.
 *
 * @param {unknown} rawCode
 * @returns {string}
 */
function normalizeBattleNetLaunchProductCode(rawCode) {
  const safe = sanitizeExternalLaunchId(rawCode);
  if (!safe) return '';
  const lower = safe.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(BATTLE_NET_LAUNCH_PRODUCT_CODE_MAP, lower)) {
    return BATTLE_NET_LAUNCH_PRODUCT_CODE_MAP[lower];
  }
  if (/[A-Z]/.test(safe)) {
    return safe;
  }
  if (safe.length <= 6) {
    return safe.toUpperCase();
  }
  return safe;
}

/**
 * Validate a bottle/prefix folder slug (rejecting traversal, slashes, NULs, and overlong names).
 *
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizeBottleNameSlug(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return '';
  if (
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.startsWith('-') ||
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0')
  ) {
    return '';
  }
  return trimmed;
}

/**
 * Centralized bottle name resolver across probers, provisioners, download coordinators,
 * and session supervisors so chained publisher launchers and games always target the same bottle.
 *
 * @param {{
 *   explicitBottleName?: string | null,
 *   gameConfigBottleName?: string | null,
 *   wizardPreferredBottleName?: string | null,
 *   discoveredBottleNames?: Array<string | { name?: string, hasSteam?: boolean, wineArch?: string, bottleArch?: string }> | null,
 *   runnerType?: string | null,
 *   layerType?: string | null,
 * }} [params]
 * @returns {string}
 */
function resolveDefaultChainedBottleName(params = {}) {
  const {
    explicitBottleName,
    gameConfigBottleName,
    wizardPreferredBottleName,
    discoveredBottleNames,
    runnerType,
    layerType,
  } = params || {};

  const normRunner = String(runnerType || layerType || '').trim().toLowerCase();
  const isArm64Runner = normRunner === 'crossover_preview_arm64';
  const isIntelCrossOverRunner =
    normRunner === 'crossover' || normRunner === 'crossover_preview';

  /** @type {string[]} */
  const validDiscovered = [];
  /** @type {Set<string>} */
  const excludedByArchLower = new Set();
  let steamBottleCandidate = '';
  if (Array.isArray(discoveredBottleNames)) {
    for (const entry of discoveredBottleNames) {
      if (typeof entry === 'string') {
        const clean = sanitizeBottleNameSlug(entry);
        if (clean) {
          validDiscovered.push(clean);
          if (!steamBottleCandidate && clean.toLowerCase() === 'steam') {
            steamBottleCandidate = clean;
          }
        }
      } else if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
        const entryArch = String(entry.wineArch || entry.bottleArch || '')
          .trim()
          .toLowerCase();
        if (isArm64Runner && entryArch && entryArch !== 'arm64') {
          const skipSlug = sanitizeBottleNameSlug(entry.name);
          if (skipSlug) excludedByArchLower.add(skipSlug.toLowerCase());
          continue;
        }
        if (isIntelCrossOverRunner && entryArch === 'arm64') {
          const skipSlug = sanitizeBottleNameSlug(entry.name);
          if (skipSlug) excludedByArchLower.add(skipSlug.toLowerCase());
          continue;
        }
        const clean = sanitizeBottleNameSlug(entry.name);
        if (clean) {
          validDiscovered.push(clean);
          if (!steamBottleCandidate && (entry.hasSteam === true || clean.toLowerCase() === 'steam')) {
            steamBottleCandidate = clean;
          }
        }
      }
    }
  }

  const alignWithDiscovered = (/** @type {string} */ slug) => {
    const lower = slug.toLowerCase();
    const match = validDiscovered.find((d) => d.toLowerCase() === lower);
    return match || slug;
  };

  const cleanExplicit = sanitizeBottleNameSlug(explicitBottleName);
  if (cleanExplicit) return alignWithDiscovered(cleanExplicit);

  const cleanGameCfg = sanitizeBottleNameSlug(gameConfigBottleName);
  if (cleanGameCfg) return alignWithDiscovered(cleanGameCfg);

  const cleanWizardPref = sanitizeBottleNameSlug(wizardPreferredBottleName);
  if (cleanWizardPref && !excludedByArchLower.has(cleanWizardPref.toLowerCase())) {
    return alignWithDiscovered(cleanWizardPref);
  }

  if (validDiscovered.length > 0) {
    if (isArm64Runner) {
      const armMatch = validDiscovered.find((d) => d.toLowerCase() === 'onelauncher-arm64');
      if (armMatch) return armMatch;
      return validDiscovered[0];
    }
    const oneLauncherMatch = validDiscovered.find((d) => d.toLowerCase() === 'onelauncher');
    if (oneLauncherMatch) return oneLauncherMatch;
    if (steamBottleCandidate) return steamBottleCandidate;
    return validDiscovered[0];
  }

  if (normRunner === 'wine' || normRunner === 'gptk') {
    return 'default';
  }
  if (isArm64Runner) {
    return 'OneLauncher-arm64';
  }
  return 'OneLauncher';
}

const EXCLUDED_GAME_DIR_NAMES = new Set([
  '__installer',
  'redist',
  '_commonredist',
  'directx',
  'vcredist',
  'support',
  'uninstall',
  'crashpad',
  'easyanticheat',
  'battleye',
  'eaanticheat',
]);

const STEAMAPPS_COMMON_PATH_RE = /[\\/]steamapps[\\/]common(?:[\\/]|$)/i;

const EXCLUDED_PUBLISHER_OR_REDIST_EXES = new Set([
  'upc.exe',
  'ubisoftconnect.exe',
  'ubisoftextension.exe',
  'eadesktop.exe',
  'ealauncher.exe',
  'eabackgroundservice.exe',
  'eacefsubprocess.exe',
  'ealocalhostsvc.exe',
  'ealaunchhelper.exe',
  'eaupdater.exe',
  'eacrashreporter.exe',
  'errorreporter.exe',
  'eagep.exe',
  'eaconnect_microsoft.exe',
  'easteamproxy.exe',
  'easteamlauncher.exe',
  'easteamauthhelper.exe',
  'eaegsproxy.exe',
  'eaegslauncher.exe',
  'eadestager.exe',
  'apprecovery.exe',
  'getgametoken32.exe',
  'getgametoken64.exe',
  'igoproxy32.exe',
  'igoproxy64.exe',
  'eaanticheat.installer.exe',
  'eaanticheat.installer.tool.exe',
  'eacoreserver.exe',
  'eaproxyinstaller.exe',
  'originlegacycli.exe',
  'patchprogress.exe',
  'activationui.exe',
  'link2ea.exe',
  'cleanup.exe',
  'touchup.exe',
  'agent.exe',
  'blizzarderror.exe',
  'systemsurvey.exe',
  'launcherpatcher.exe',
  'socialclubhelper.exe',
  'rockstarservice.exe',
  'rockstarerrorhandler.exe',
  'riotclientservices.exe',
  'riotclientcrashhandler.exe',
  'gdkstubgame.exe',
  'dxsetup.exe',
  'crashpad_handler.exe',
  'crs-handler.exe',
  'vgc.exe',
  'vgtray.exe',
]);

const EXCLUDED_PUBLISHER_OR_REDIST_PREFIXES = Object.freeze([
  'ubisoftgamelauncher',
  'uplay',
  'battle.net',
  'riotclient',
  'eaanticheat',
  'unins',
  'uninstall',
  'vc_redist',
  'vcredist',
  'unitycrashhandler',
  'crashreportclient',
  'ue4prereqsetup',
  'ueprereqsetup',
  'easyanticheat',
  'beservice',
]);

/**
 * Return `true` when an `.exe` filename is a known publisher launcher, updater, redistributable,
 * crash reporter, or stub binary rather than an actual playable game binary.
 *
 * @param {string} fileName
 * @returns {boolean}
 */
function isExcludedPublisherOrRedistExe(fileName) {
  const lower = String(fileName || '')
    .trim()
    .toLowerCase();
  if (!lower.endsWith('.exe')) return true;
  if (EXCLUDED_PUBLISHER_OR_REDIST_EXES.has(lower)) return true;
  for (const prefix of EXCLUDED_PUBLISHER_OR_REDIST_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

const FORBIDDEN_BROAD_CONTAINER_BASENAMES = new Set([
  'drive_c',
  'program files',
  'program files (x86)',
  'programdata',
  'windows',
  'system32',
  'syswow64',
  'users',
  'appdata',
  'local',
  'roaming',
  'applications',
]);

/**
 * Check whether a candidate path is a forbidden broad OS or bottle container root
 * (`drive_c`, `Program Files`, `Program Files (x86)`, `ProgramData`, `Windows`, `/Applications`, etc.)
 * that must never be returned as a publisher staging directory.
 *
 * @param {string} dirPath
 * @param {string} [bottlePath]
 * @returns {boolean}
 */
function isForbiddenBroadPublisherContainerDir(dirPath, bottlePath = '') {
  const clean = String(dirPath || '')
    .trim()
    .replace(/([^:])[\\/]+$/, '$1');
  if (!clean || clean === '/' || /^[A-Za-z]:[\\/]?$/.test(clean)) {
    return true;
  }
  if (bottlePath) {
    const cleanBottle = path.resolve(bottlePath);
    const resolvedCand = path.resolve(clean);
    if (
      resolvedCand.toLowerCase() === cleanBottle.toLowerCase() ||
      resolvedCand.toLowerCase() === path.join(cleanBottle, 'drive_c').toLowerCase()
    ) {
      return true;
    }
  }
  const baseLower = path.basename(clean.replace(/\\/g, '/')).toLowerCase();
  return FORBIDDEN_BROAD_CONTAINER_BASENAMES.has(baseLower);
}

module.exports = {
  EA_DESKTOP_MSI_UPGRADE_CODE,
  CHAINED_PUBLISHER_ECOSYSTEMS,
  PUBLISHER_LAUNCHER_SPECS,
  BATTLE_NET_LAUNCH_PRODUCT_CODE_MAP,
  SAFE_EXTERNAL_LAUNCH_ID_RE,
  sanitizeExternalLaunchId,
  isValidExternalLaunchId,
  normalizeChainedHandoffId,
  normalizeBattleNetLaunchProductCode,
  sanitizeBottleNameSlug,
  resolveDefaultChainedBottleName,
  EXCLUDED_GAME_DIR_NAMES,
  STEAMAPPS_COMMON_PATH_RE,
  isExcludedPublisherOrRedistExe,
  isForbiddenBroadPublisherContainerDir,
};
