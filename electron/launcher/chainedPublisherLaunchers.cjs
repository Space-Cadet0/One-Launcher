// @ts-check
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fromWineWindowsPath } = require('./firstPartyRegistration.cjs');
const { resolveDriveCPathCaseInsensitive } = require('./wineAndCrossOverManager.cjs');
const {
  enumerateWindowsRegistrySubkeys,
  discoverWindowsPublisherLauncherPaths,
  normalizePublisherLauncherId,
} = require('../utils/windowsRegistryDiscovery.cjs');

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
 *   discoveredBottleNames?: Array<string | { name?: string, hasSteam?: boolean }> | null,
 *   runnerType?: string | null,
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
  } = params || {};

  /** @type {string[]} */
  const validDiscovered = [];
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
  if (cleanWizardPref) return alignWithDiscovered(cleanWizardPref);

  if (validDiscovered.length > 0) {
    const oneLauncherMatch = validDiscovered.find((d) => d.toLowerCase() === 'onelauncher');
    if (oneLauncherMatch) return oneLauncherMatch;
    if (steamBottleCandidate) return steamBottleCandidate;
    return validDiscovered[0];
  }

  const normRunner = String(runnerType || '').trim().toLowerCase();
  if (normRunner === 'wine' || normRunner === 'gptk') {
    return 'default';
  }
  return 'OneLauncher';
}

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

/**
 * Normalize a Battle.net NGDP TACT UID / `.build.info` product / `product.db` `uid` or `productCode`
 * to Battle.net's exact case-sensitive `--exec="launch <ProductId>"` protocol identifier.
 *
 * @param {unknown} rawCode
 * @returns {string}
 */
function normalizeBattleNetLaunchProductCode(rawCode) {
  if (typeof rawCode !== 'string') return '';
  const trimmed = rawCode.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(BATTLE_NET_LAUNCH_PRODUCT_CODE_MAP, lower)) {
    return BATTLE_NET_LAUNCH_PRODUCT_CODE_MAP[lower];
  }
  if (/[A-Z]/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.length <= 6) {
    return trimmed.toUpperCase();
  }
  return trimmed;
}

const MAX_BATTLE_NET_PRODUCT_DB_BYTES = 16 * 1024 * 1024;

/**
 * Bounds-safe protobuf varint reader (max 10 continuation bytes / 64-bit integer).
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} end
 * @returns {{ value: bigint, nextOffset: number } | null}
 */
function readProtobufVarintBounded(buf, offset, end) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  for (let count = 0; count < 10; count += 1) {
    if (pos >= end) return null;
    const byte = buf[pos];
    pos += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
  }
  return null;
}

/**
 * Advance past an unknown protobuf field value with strict bounds validation.
 *
 * @param {Buffer} buf
 * @param {number} wireType
 * @param {number} offset
 * @param {number} end
 * @returns {number} New offset, or `-1` on malformed wire data.
 */
function skipProtobufFieldBounded(buf, wireType, offset, end) {
  if (wireType === 0) {
    const v = readProtobufVarintBounded(buf, offset, end);
    return v ? v.nextOffset : -1;
  }
  if (wireType === 1) {
    return offset + 8 <= end ? offset + 8 : -1;
  }
  if (wireType === 2) {
    const lenVar = readProtobufVarintBounded(buf, offset, end);
    if (!lenVar || lenVar.value < 0n || lenVar.value > BigInt(end - lenVar.nextOffset)) {
      return -1;
    }
    return lenVar.nextOffset + Number(lenVar.value);
  }
  if (wireType === 5) {
    return offset + 4 <= end ? offset + 4 : -1;
  }
  return -1;
}

/**
 * Zero-dependency binary protobuf wire parser for Battle.net Agent's `product.db`.
 * Enforces `<= 16 MiB` size ceiling, strict varint/submessage bounds, and excludes
 * internal non-game UIDs (`bna`, `agent`).
 *
 * @param {Buffer | Uint8Array | null | undefined} rawBuf
 * @returns {BattleNetProductDbInstallEntry[]}
 */
function parseBattleNetProductDbBuffer(rawBuf) {
  if (!rawBuf || (!(rawBuf instanceof Uint8Array) && !Buffer.isBuffer(rawBuf))) {
    return [];
  }
  if (rawBuf.byteLength === 0 || rawBuf.byteLength > MAX_BATTLE_NET_PRODUCT_DB_BYTES) {
    return [];
  }
  const buf = Buffer.isBuffer(rawBuf)
    ? rawBuf
    : Buffer.from(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);

  /**
   * @param {number} start
   * @param {number} end
   */
  const parseUserSettings = (start, end) => {
    let installPath = '';
    let playRegion = '';
    let pos = start;
    while (pos < end) {
      const tagVar = readProtobufVarintBounded(buf, pos, end);
      if (!tagVar || tagVar.value <= 0n) break;
      pos = tagVar.nextOffset;
      const fieldNum = Number(tagVar.value >> 3n);
      const wireType = Number(tagVar.value & 7n);
      if (wireType === 2 && (fieldNum === 1 || fieldNum === 2)) {
        const lenVar = readProtobufVarintBounded(buf, pos, end);
        if (!lenVar || lenVar.value < 0n || lenVar.value > BigInt(end - lenVar.nextOffset)) break;
        const strStart = lenVar.nextOffset;
        const strEnd = strStart + Number(lenVar.value);
        const text = buf.toString('utf8', strStart, strEnd).trim();
        if (fieldNum === 1) installPath = text;
        else playRegion = text;
        pos = strEnd;
      } else {
        const nextPos = skipProtobufFieldBounded(buf, wireType, pos, end);
        if (nextPos < 0 || nextPos <= pos) break;
        pos = nextPos;
      }
    }
    return { installPath, playRegion };
  };

  /**
   * @param {number} start
   * @param {number} end
   */
  const parseBaseProductState = (start, end) => {
    let installed = false;
    let playable = false;
    let currentVersionStr = '';
    let pos = start;
    while (pos < end) {
      const tagVar = readProtobufVarintBounded(buf, pos, end);
      if (!tagVar || tagVar.value <= 0n) break;
      pos = tagVar.nextOffset;
      const fieldNum = Number(tagVar.value >> 3n);
      const wireType = Number(tagVar.value & 7n);
      if (wireType === 0 && (fieldNum === 1 || fieldNum === 2)) {
        const valVar = readProtobufVarintBounded(buf, pos, end);
        if (!valVar) break;
        if (fieldNum === 1) installed = valVar.value !== 0n;
        else playable = valVar.value !== 0n;
        pos = valVar.nextOffset;
      } else if (wireType === 2 && fieldNum === 7) {
        const lenVar = readProtobufVarintBounded(buf, pos, end);
        if (!lenVar || lenVar.value < 0n || lenVar.value > BigInt(end - lenVar.nextOffset)) break;
        const strStart = lenVar.nextOffset;
        const strEnd = strStart + Number(lenVar.value);
        currentVersionStr = buf.toString('utf8', strStart, strEnd).trim();
        pos = strEnd;
      } else {
        const nextPos = skipProtobufFieldBounded(buf, wireType, pos, end);
        if (nextPos < 0 || nextPos <= pos) break;
        pos = nextPos;
      }
    }
    return { installed, playable, currentVersionStr };
  };

  /**
   * @param {number} start
   * @param {number} end
   */
  const parseCachedProductState = (start, end) => {
    let installed = false;
    let playable = false;
    let currentVersionStr = '';
    let sawBaseState = false;
    let pos = start;
    while (pos < end) {
      const tagVar = readProtobufVarintBounded(buf, pos, end);
      if (!tagVar || tagVar.value <= 0n) break;
      pos = tagVar.nextOffset;
      const fieldNum = Number(tagVar.value >> 3n);
      const wireType = Number(tagVar.value & 7n);
      if (wireType === 2 && fieldNum === 1) {
        const lenVar = readProtobufVarintBounded(buf, pos, end);
        if (!lenVar || lenVar.value < 0n || lenVar.value > BigInt(end - lenVar.nextOffset)) break;
        const subStart = lenVar.nextOffset;
        const subEnd = subStart + Number(lenVar.value);
        const base = parseBaseProductState(subStart, subEnd);
        sawBaseState = true;
        installed = base.installed;
        playable = base.playable;
        if (base.currentVersionStr) currentVersionStr = base.currentVersionStr;
        pos = subEnd;
      } else {
        const nextPos = skipProtobufFieldBounded(buf, wireType, pos, end);
        if (nextPos < 0 || nextPos <= pos) break;
        pos = nextPos;
      }
    }
    return { installed, playable, currentVersionStr, sawBaseState };
  };

  /**
   * @param {number} start
   * @param {number} end
   * @returns {BattleNetProductDbInstallEntry | null}
   */
  const parseProductInstall = (start, end) => {
    let uid = '';
    let productCode = '';
    let installPath = '';
    let playRegion = '';
    let installed = false;
    let playable = false;
    let currentVersionStr = '';
    let hasCachedState = false;

    let pos = start;
    while (pos < end) {
      const tagVar = readProtobufVarintBounded(buf, pos, end);
      if (!tagVar || tagVar.value <= 0n) break;
      pos = tagVar.nextOffset;
      const fieldNum = Number(tagVar.value >> 3n);
      const wireType = Number(tagVar.value & 7n);

      if (wireType === 2 && (fieldNum === 1 || fieldNum === 2 || fieldNum === 3 || fieldNum === 4)) {
        const lenVar = readProtobufVarintBounded(buf, pos, end);
        if (!lenVar || lenVar.value < 0n || lenVar.value > BigInt(end - lenVar.nextOffset)) break;
        const subStart = lenVar.nextOffset;
        const subEnd = subStart + Number(lenVar.value);
        if (fieldNum === 1) {
          uid = buf.toString('utf8', subStart, subEnd).trim();
        } else if (fieldNum === 2) {
          productCode = buf.toString('utf8', subStart, subEnd).trim();
        } else if (fieldNum === 3) {
          const settings = parseUserSettings(subStart, subEnd);
          if (settings.installPath) installPath = settings.installPath;
          if (settings.playRegion) playRegion = settings.playRegion;
        } else if (fieldNum === 4) {
          const cached = parseCachedProductState(subStart, subEnd);
          hasCachedState = cached.sawBaseState || true;
          installed = cached.installed;
          playable = cached.playable;
          if (cached.currentVersionStr) currentVersionStr = cached.currentVersionStr;
        }
        pos = subEnd;
      } else {
        const nextPos = skipProtobufFieldBounded(buf, wireType, pos, end);
        if (nextPos < 0 || nextPos <= pos) break;
        pos = nextPos;
      }
    }

    const effectiveId = uid || productCode;
    if (!effectiveId) return null;
    const uidLower = uid.toLowerCase();
    const codeLower = productCode.toLowerCase();
    if (
      uidLower === 'bna' ||
      uidLower === 'agent' ||
      uidLower === 'battle.net' ||
      codeLower === 'bna' ||
      codeLower === 'agent' ||
      codeLower === 'battle.net'
    ) {
      return null;
    }

    return {
      uid: uid || productCode,
      productCode: productCode || uid,
      launchProductCode: normalizeBattleNetLaunchProductCode(productCode || uid),
      installPath,
      playRegion,
      installed,
      playable,
      currentVersionStr,
      hasCachedState,
    };
  };

  /** @type {BattleNetProductDbInstallEntry[]} */
  const installs = [];
  let offset = 0;
  const totalLen = buf.length;
  while (offset < totalLen) {
    const tagVar = readProtobufVarintBounded(buf, offset, totalLen);
    if (!tagVar || tagVar.value <= 0n) break;
    offset = tagVar.nextOffset;
    const fieldNum = Number(tagVar.value >> 3n);
    const wireType = Number(tagVar.value & 7n);
    if (wireType === 2 && fieldNum === 1) {
      const lenVar = readProtobufVarintBounded(buf, offset, totalLen);
      if (!lenVar || lenVar.value < 0n || lenVar.value > BigInt(totalLen - lenVar.nextOffset)) {
        break;
      }
      const msgStart = lenVar.nextOffset;
      const msgEnd = msgStart + Number(lenVar.value);
      const parsed = parseProductInstall(msgStart, msgEnd);
      if (parsed) {
        installs.push(parsed);
      }
      offset = msgEnd;
    } else {
      const nextOffset = skipProtobufFieldBounded(buf, wireType, offset, totalLen);
      if (nextOffset < 0 || nextOffset <= offset) break;
      offset = nextOffset;
    }
  }

  return installs;
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
 * Unescape a Wine `.reg` string literal (`\\\\` -> `\`, `\"` -> `"`, `\x..`, `\u....`).
 *
 * @param {string} raw
 * @returns {string}
 */
function unescapeWineRegValue(raw) {
  if (!raw || !raw.includes('\\')) return raw;
  let out = '';
  const len = raw.length;
  for (let i = 0; i < len; i += 1) {
    const ch = raw[i];
    if (ch !== '\\' || i + 1 >= len) {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === '\\') {
      out += '\\';
      i += 1;
    } else if (next === '"') {
      out += '"';
      i += 1;
    } else if (next === 'n') {
      out += '\n';
      i += 1;
    } else if (next === 'r') {
      out += '\r';
      i += 1;
    } else if (next === 't') {
      out += '\t';
      i += 1;
    } else if (next === '0') {
      i += 1;
    } else if (next === 'x' && i + 3 < len) {
      const hex2 = raw.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex2)) {
        const code = parseInt(hex2, 16);
        if (code !== 0) out += String.fromCharCode(code);
        i += 3;
      } else {
        out += next;
        i += 1;
      }
    } else if (next === 'u' && i + 5 < len) {
      const hex4 = raw.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex4)) {
        const code = parseInt(hex4, 16);
        if (code !== 0) out += String.fromCharCode(code);
        i += 5;
      } else {
        out += next;
        i += 1;
      }
    } else {
      out += next;
      i += 1;
    }
  }
  return out;
}

/**
 * Normalize a Wine registry section path to lowercase single-backslash form
 * (e.g. `[Software\\Wow6432Node\\Ubisoft\\Launcher]` -> `'software\\wow6432node\\ubisoft\\launcher'`).
 *
 * @param {string} rawSection
 * @returns {string}
 */
function normalizeWineRegistrySectionKey(rawSection) {
  if (!rawSection || typeof rawSection !== 'string') return '';
  const trimmed = rawSection.trim();
  const unescaped =
    trimmed.includes('\\\\') || trimmed.includes('\\"')
      ? unescapeWineRegValue(trimmed)
      : trimmed;
  return unescaped
    .replace(/\//g, '\\')
    .replace(/\\+/g, '\\')
    .replace(/^\\+|\\+$/g, '')
    .replace(/^(?:hkey_local_machine|hklm|hkey_current_user|hkcu)\\/i, '')
    .toLowerCase();
}

/**
 * Case- and slash-insensitive `Map` subclass for Wine registry sections.
 *
 * @extends {Map<string, Record<string, string>>}
 */
class WineRegistrySectionMap extends Map {
  /**
   * @param {string} key
   * @returns {Record<string, string> | undefined}
   */
  get(key) {
    return super.get(normalizeWineRegistrySectionKey(key));
  }

  /**
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return super.has(normalizeWineRegistrySectionKey(key));
  }
}

/**
 * Fast (`< 5ms`) pure-Node Wine `.reg` parser with zero child processes.
 * Parses `[Section\\Path]` headers and `"Key"="Value"` / `@="Value"` / `"Key"=dword:...` entries.
 *
 * @param {string} regText
 * @returns {Map<string, Record<string, string>>}
 */
function parseWineRegistrySections(regText) {
  /** @type {WineRegistrySectionMap} */
  const sections = new WineRegistrySectionMap();
  if (!regText || typeof regText !== 'string') {
    return sections;
  }

  /** @type {Record<string, string> | null} */
  let currentProps = null;
  const len = regText.length;
  let lineStart = 0;

  while (lineStart < len) {
    let lineEnd = regText.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = len;

    let endTrim = lineEnd;
    if (endTrim > lineStart && regText.charCodeAt(endTrim - 1) === 13 /* \r */) {
      endTrim -= 1;
    }

    // Handle trailing backslash line continuations in Wine .reg files
    let line = regText.slice(lineStart, endTrim);
    lineStart = lineEnd + 1;

    while (line.endsWith('\\') && !line.endsWith('\\\\') && lineStart < len) {
      let nextEnd = regText.indexOf('\n', lineStart);
      if (nextEnd === -1) nextEnd = len;
      let nextTrim = nextEnd;
      if (nextTrim > lineStart && regText.charCodeAt(nextTrim - 1) === 13) {
        nextTrim -= 1;
      }
      const continuation = regText.slice(lineStart, nextTrim).trimStart();
      line = line.slice(0, -1) + continuation;
      lineStart = nextEnd + 1;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;
    const firstCode = trimmed.charCodeAt(0);
    // ';' (59) or '#' (35) comment/directive lines
    if (firstCode === 59 || firstCode === 35) continue;

    if (firstCode === 91 /* '[' */) {
      const closeBracket = trimmed.indexOf(']');
      if (closeBracket > 1) {
        const secKey = normalizeWineRegistrySectionKey(trimmed.slice(1, closeBracket));
        if (secKey) {
          let existing = sections.get(secKey);
          if (!existing) {
            existing = {};
            sections.set(secKey, existing);
          }
          currentProps = existing;
        } else {
          currentProps = null;
        }
      }
      continue;
    }

    if (!currentProps) continue;

    if (firstCode === 64 /* '@' */) {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const rhs = trimmed.slice(eqIdx + 1).trim();
        if (rhs.length >= 2 && rhs.startsWith('"') && rhs.endsWith('"')) {
          currentProps['@'] = unescapeWineRegValue(rhs.slice(1, -1));
        }
      }
      continue;
    }

    if (firstCode === 34 /* '"' */) {
      // Scan closing quote of key name while honoring escaped quotes
      let keyEnd = -1;
      for (let i = 1; i < trimmed.length; i += 1) {
        const c = trimmed.charCodeAt(i);
        if (c === 92 /* '\\' */) {
          i += 1;
          continue;
        }
        if (c === 34 /* '"' */) {
          keyEnd = i;
          break;
        }
      }
      if (keyEnd <= 0) continue;

      const eqIdx = trimmed.indexOf('=', keyEnd + 1);
      if (eqIdx < 0) continue;

      const keyName = unescapeWineRegValue(trimmed.slice(1, keyEnd));
      if (!keyName) continue;

      const rhs = trimmed.slice(eqIdx + 1).trim();
      if (rhs.length >= 2 && rhs.startsWith('"') && rhs.endsWith('"')) {
        currentProps[keyName] = unescapeWineRegValue(rhs.slice(1, -1));
      } else if (rhs.toLowerCase().startsWith('dword:')) {
        currentProps[keyName] = rhs.slice(6).trim();
      } else if (rhs.toLowerCase().startsWith('str(2):"') && rhs.endsWith('"')) {
        currentProps[keyName] = unescapeWineRegValue(rhs.slice(8, -1));
      }
    }
  }

  return sections;
}

/**
 * Look up a property case-insensitively inside a parsed registry property bag.
 *
 * @param {Record<string, string> | undefined | null} props
 * @param {string} propName
 * @returns {string}
 */
function getRegistryPropCaseInsensitive(props, propName) {
  if (!props || typeof props !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(props, propName)) {
    return String(props[propName] || '').trim();
  }
  const target = propName.toLowerCase();
  for (const [k, v] of Object.entries(props)) {
    if (k.toLowerCase() === target) {
      return String(v || '').trim();
    }
  }
  return '';
}

/**
 * Load or reuse a parsed `system.reg` section map for `bottlePath`.
 *
 * @param {string} bottlePath
 * @param {Record<string, any>} [options]
 * @returns {Map<string, Record<string, string>>}
 */
function getBottleSystemRegSections(bottlePath, options = {}) {
  if (options.parsedSystemReg instanceof Map) {
    return options.parsedSystemReg;
  }
  const sysRegPath = path.join(bottlePath, 'system.reg');
  try {
    if (fs.existsSync(sysRegPath)) {
      return parseWineRegistrySections(fs.readFileSync(sysRegPath, 'utf8'));
    }
  } catch {}
  return new WineRegistrySectionMap();
}

const IO_REPARSE_TAG_MOUNT_POINT = 0xa0000003;
const IO_REPARSE_TAG_SYMLINK = 0xa000000c;
const WINE_REPARSE_XATTR_NAME = 'user.WINEREPARSE';
const WINE_REPARSE_XATTR_CACHE_MAX = 256;
/** @type {Map<string, { mtimeMs: number, buffer: Buffer | null }>} */
const wineReparseXattrCache = new Map();

/**
 * Decode a Microsoft `REPARSE_DATA_BUFFER` (`IO_REPARSE_TAG_MOUNT_POINT` or `IO_REPARSE_TAG_SYMLINK`)
 * from a Wine `user.WINEREPARSE` extended attribute payload.
 *
 * @param {Buffer | null | undefined} rawBuf
 * @returns {{ tag: number, target: string, isRelative: boolean } | null}
 */
function decodeWineReparseDataBuffer(rawBuf) {
  /**
   * @param {Buffer} buf
   * @returns {{ tag: number, target: string, isRelative: boolean } | null}
   */
  const tryDecode = (buf) => {
    if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
    const maxScan = Math.min(32, buf.length - 16);
    for (let base = 0; base <= maxScan; base += 4) {
      const tag = buf.readUInt32LE(base);
      if (tag !== IO_REPARSE_TAG_MOUNT_POINT && tag !== IO_REPARSE_TAG_SYMLINK) continue;
      const isSymlink = tag === IO_REPARSE_TAG_SYMLINK;
      const pathBufOffset = base + (isSymlink ? 20 : 16);
      if (pathBufOffset > buf.length) continue;

      const subOffset = buf.readUInt16LE(base + 8);
      const subLen = buf.readUInt16LE(base + 10);
      const printOffset = buf.readUInt16LE(base + 12);
      const printLen = buf.readUInt16LE(base + 14);
      const flags = isSymlink ? buf.readUInt32LE(base + 16) : 0;

      let subName = '';
      if (subLen > 0 && pathBufOffset + subOffset + subLen <= buf.length) {
        subName = buf
          .subarray(pathBufOffset + subOffset, pathBufOffset + subOffset + subLen)
          .toString('utf16le')
          .replace(/\0+$/g, '');
      }
      let printName = '';
      if (printLen > 0 && pathBufOffset + printOffset + printLen <= buf.length) {
        printName = buf
          .subarray(pathBufOffset + printOffset, pathBufOffset + printOffset + printLen)
          .toString('utf16le')
          .replace(/\0+$/g, '');
      }

      const stripNtPrefix = (/** @type {string} */ s) =>
        s
          .trim()
          .replace(/^\\\?\?\\UNC\\/i, '\\\\')
          .replace(/^\\\?\?\\/, '')
          .replace(/^\\\\\?\\UNC\\/i, '\\\\')
          .replace(/^\\\\\?\\/, '');

      let target = stripNtPrefix(subName);
      const cleanPrint = stripNtPrefix(printName);
      if ((!target || /^Volume\{/i.test(target)) && cleanPrint) {
        target = cleanPrint;
      }
      if (target) {
        return {
          tag,
          target,
          isRelative: isSymlink && (flags & 0x00000001) !== 0,
        };
      }
    }
    return null;
  };

  if (!Buffer.isBuffer(rawBuf) || rawBuf.length < 16) return null;
  const direct = tryDecode(rawBuf);
  if (direct) return direct;
  if (rawBuf.length >= 20 && rawBuf.length <= 4096) {
    const ascii = rawBuf.toString('utf8').trim();
    if (/^[A-Za-z0-9+/=\s]+$/.test(ascii)) {
      try {
        return tryDecode(Buffer.from(ascii.replace(/\s+/g, ''), 'base64'));
      } catch {}
    }
  }
  return null;
}

/**
 * Read `user.WINEREPARSE` extended attribute bytes without mutating disk state.
 *
 * @param {string} targetPath
 * @param {number} mtimeMs
 * @param {{ getXattrBuffer?: (targetPath: string, attrName: string) => Buffer | null | undefined, platform?: string }} [options]
 * @returns {Buffer | null}
 */
function readWineReparseXattrCached(targetPath, mtimeMs, options = {}) {
  if (typeof options.getXattrBuffer === 'function') {
    try {
      const injected = options.getXattrBuffer(targetPath, WINE_REPARSE_XATTR_NAME);
      return Buffer.isBuffer(injected) ? injected : null;
    } catch {
      return null;
    }
  }
  const platform = String(options.platform || process.platform).toLowerCase();
  if (platform !== 'darwin') return null;

  const cached = wineReparseXattrCache.get(targetPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    wineReparseXattrCache.delete(targetPath);
    wineReparseXattrCache.set(targetPath, cached);
    return cached.buffer;
  }

  /** @type {Buffer | null} */
  let resolvedBuf = null;
  try {
    const hexOut = execFileSync('/usr/bin/xattr', ['-px', WINE_REPARSE_XATTR_NAME, targetPath], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const cleanHex = String(hexOut || '').replace(/[^0-9a-fA-F]/g, '');
    if (cleanHex.length >= 32 && cleanHex.length % 2 === 0) {
      resolvedBuf = Buffer.from(cleanHex, 'hex');
    }
  } catch {
    resolvedBuf = null;
  }

  if (wineReparseXattrCache.size >= WINE_REPARSE_XATTR_CACHE_MAX) {
    const oldestKey = wineReparseXattrCache.keys().next().value;
    if (oldestKey !== undefined) wineReparseXattrCache.delete(oldestKey);
  }
  wineReparseXattrCache.set(targetPath, { mtimeMs, buffer: resolvedBuf });
  return resolvedBuf;
}

/**
 * Strictly read-only (`0` disk writes / `0` symlinks) resolver for Wine NTFS junctions and
 * symlinks stored via the `user.WINEREPARSE` extended attribute inside `<bottlePath>/drive_c`.
 *
 * @param {string} hostPath
 * @param {string} [driveCRoot]
 * @param {{ getXattrBuffer?: (targetPath: string, attrName: string) => Buffer | null | undefined, platform?: string, maxHops?: number }} [options]
 * @returns {string}
 */
function resolveWineReparseTargetReadOnly(hostPath, driveCRoot = '', options = {}) {
  if (!hostPath || typeof hostPath !== 'string') return hostPath || '';
  const hasCustomGetter = typeof options.getXattrBuffer === 'function';
  const platform = String(options.platform || process.platform).toLowerCase();
  if (!hasCustomGetter && platform !== 'darwin') {
    return hostPath;
  }

  let effectiveDriveC = driveCRoot ? path.resolve(driveCRoot) : '';
  if (!effectiveDriveC) {
    const dcMatch = hostPath.match(/^(.*\/drive_c)(?:\/|$)/i);
    if (dcMatch && dcMatch[1]) effectiveDriveC = path.resolve(dcMatch[1]);
  }
  if (!effectiveDriveC) return hostPath;

  const bottlePath = path.dirname(effectiveDriveC);
  const maxHops = Number.isInteger(options.maxHops) && Number(options.maxHops) > 0 ? Number(options.maxHops) : 6;
  /** @type {Set<string>} */
  const visited = new Set();
  let currentPath = hostPath;

  for (let hop = 0; hop < maxHops; hop += 1) {
    const normCurrent = path.resolve(currentPath);
    if (visited.has(normCurrent)) break;
    visited.add(normCurrent);

    if (!hasCustomGetter) {
      try {
        if (fs.existsSync(normCurrent)) {
          const st = fs.statSync(normCurrent);
          if ((st.isFile() && st.size > 0) || (st.isDirectory() && fs.readdirSync(normCurrent).length > 0)) {
            return currentPath;
          }
        }
      } catch {}
    }

    const driveCPrefix = effectiveDriveC.endsWith(path.sep) ? effectiveDriveC : `${effectiveDriveC}${path.sep}`;
    if (normCurrent !== effectiveDriveC && !normCurrent.startsWith(driveCPrefix)) {
      return currentPath;
    }

    const relFromDriveC = normCurrent === effectiveDriveC ? '' : normCurrent.slice(driveCPrefix.length);
    const segments = relFromDriveC.split(path.sep).filter(Boolean);
    if (segments.length === 0) return currentPath;

    let curDir = effectiveDriveC;
    let hopped = false;

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const segLower = seg.toLowerCase();
      const segQ = `${segLower}?`;
      /** @type {fs.Dirent[]} */
      let entries = [];
      try {
        entries = fs.readdirSync(curDir, { withFileTypes: true });
      } catch {
        break;
      }

      const exactOrCi = entries.find((e) => e.name === seg) || entries.find((e) => e.name.toLowerCase() === segLower);
      const qStub = entries.find((e) => e.name.toLowerCase() === segQ);
      /** @type {fs.Dirent[]} */
      const stubDirents = [];
      if (qStub) stubDirents.push(qStub);
      if (exactOrCi && exactOrCi !== qStub) stubDirents.push(exactOrCi);

      for (const dirent of stubDirents) {
        const candPath = path.join(curDir, dirent.name);
        let mtimeMs = 0;
        let shouldCheckXattr = hasCustomGetter || dirent.name.endsWith('?');
        try {
          const lst = fs.lstatSync(candPath);
          mtimeMs = lst.mtimeMs;
          if (!shouldCheckXattr) {
            if (lst.isSymbolicLink() || (lst.isFile() && lst.size === 0)) {
              shouldCheckXattr = true;
            } else if (lst.isDirectory() && fs.readdirSync(candPath).length === 0) {
              shouldCheckXattr = true;
            }
          }
        } catch {
          continue;
        }
        if (!shouldCheckXattr) continue;

        const xattrBuf = readWineReparseXattrCached(candPath, mtimeMs, options);
        const decoded = decodeWineReparseDataBuffer(xattrBuf);
        if (!decoded || !decoded.target) continue;

        let mappedBase = '';
        if (
          decoded.isRelative ||
          (!/^[a-zA-Z]:(?:[\\/]|$)/.test(decoded.target) && !decoded.target.startsWith('/'))
        ) {
          const relParts = decoded.target.replace(/\\/g, '/').split('/').filter(Boolean);
          mappedBase = resolveDriveCPathCaseInsensitive(curDir, relParts);
        } else {
          mappedBase = fromWineWindowsPath(decoded.target, bottlePath);
        }
        if (!mappedBase) continue;

        const remaining = segments.slice(i + 1);
        currentPath =
          remaining.length > 0
            ? resolveDriveCPathCaseInsensitive(mappedBase, remaining)
            : mappedBase;
        hopped = true;
        break;
      }

      if (hopped) break;
      if (!exactOrCi) break;
      curDir = path.join(curDir, exactOrCi.name);
    }

    if (!hopped) break;
  }

  return currentPath;
}

/**
 * Convert a Wine Windows path to a host POSIX path and resolve any `user.WINEREPARSE`
 * junction/symlink hops inside `<bottlePath>/drive_c` strictly read-only.
 *
 * @param {string} winPath
 * @param {string} bottlePath
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolveBottleWindowsPathReadOnly(winPath, bottlePath, options = {}) {
  const hostPath = fromWineWindowsPath(winPath, bottlePath);
  if (!hostPath || !bottlePath) return hostPath;
  return resolveWineReparseTargetReadOnly(hostPath, path.join(bottlePath, 'drive_c'), options);
}

/**
 * Enumerate per-user profile directories inside `<bottlePath>/drive_c/users`,
 * prioritizing real user profiles (`crossover`, etc.) ahead of `Public`/`Default`.
 *
 * @param {string} bottlePath
 * @returns {string[]}
 */
function listBottleUserDirectories(bottlePath) {
  if (!bottlePath) return [];
  const driveCRoot = path.join(bottlePath, 'drive_c');
  const usersDir = resolveDriveCPathCaseInsensitive(driveCRoot, ['users']);
  try {
    if (!fs.existsSync(usersDir)) return [];
    const deprioritized = new Set(['public', 'all users', 'default', 'default user']);
    return fs
      .readdirSync(usersDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .sort((a, b) => {
        const aLower = a.name.toLowerCase();
        const bLower = b.name.toLowerCase();
        if (aLower === 'crossover' && bLower !== 'crossover') return -1;
        if (bLower === 'crossover' && aLower !== 'crossover') return 1;
        const aDep = deprioritized.has(aLower);
        const bDep = deprioritized.has(bLower);
        if (aDep !== bDep) return aDep ? 1 : -1;
        return a.name.localeCompare(b.name);
      })
      .map((d) => path.join(usersDir, d.name));
  } catch {
    return [];
  }
}

/**
 * Read-only, non-PII check for whether a local Ubisoft Connect (`175.x` or legacy) authenticated
 * session exists under a Windows/Wine `AppData/Local/Ubisoft Game Launcher` directory.
 *
 * Ground-truth rules:
 * 1. If `settings.yaml` or `settings.yml` explicitly sets `remember_me: false` or `auto_login: false`,
 *    returns `false` immediately (even if legacy `users.dat` remains on disk).
 * 2. Checks Ubisoft `175.x` session artifacts (`user.vdat`, `ConnectSecureStorage.dat`,
 *    `cache/ownership/*.vdat` > 16 B). If modern credential storage exists on disk but was
 *    truncated/cleared (`<= 16` B) on sign-out, returns `false`.
 * 3. Falls back to legacy `users.dat` / `user.dat` (> 16 B) when `remember_me` is not `false`.
 * 4. Never returns `true` from `remember_me: true` alone without a real credential/session file.
 *
 * @param {string} ubiLocalDir
 * @param {string} [legacyInstallDir]
 * @returns {boolean}
 */
function hasUbisoftLocalSessionInDir(ubiLocalDir, legacyInstallDir = '') {
  if (!ubiLocalDir) return false;
  try {
    if (!fs.existsSync(ubiLocalDir)) return false;

    const settingsDirs = [ubiLocalDir, legacyInstallDir].filter(Boolean);
    for (const dir of settingsDirs) {
      for (const settingsName of ['settings.yaml', 'settings.yml']) {
        const settingsPath = resolveDriveCPathCaseInsensitive(dir, [settingsName]);
        try {
          if (settingsPath && fs.existsSync(settingsPath)) {
            const raw = fs.readFileSync(settingsPath, 'utf8');
            if (
              /^\s*(?:remember_me|auto_login|autologin)\s*:\s*["']?(?:false|0|no)["']?\s*(?:#.*)?$/im.test(
                raw
              )
            ) {
              return false;
            }
          }
        } catch {}
      }
    }

    let hasModernSessionFile = false;
    let sawClearedModernStorage = false;
    for (const modernFile of ['user.vdat', 'ConnectSecureStorage.dat']) {
      const modernPath = resolveDriveCPathCaseInsensitive(ubiLocalDir, [modernFile]);
      try {
        if (modernPath && fs.existsSync(modernPath)) {
          const st = fs.statSync(modernPath);
          if (st.isFile()) {
            if (st.size > 16) {
              hasModernSessionFile = true;
            } else {
              sawClearedModernStorage = true;
            }
          }
        }
      } catch {}
    }

    const ownershipDir = resolveDriveCPathCaseInsensitive(ubiLocalDir, ['cache', 'ownership']);
    try {
      if (ownershipDir && fs.existsSync(ownershipDir) && fs.statSync(ownershipDir).isDirectory()) {
        const entries = fs.readdirSync(ownershipDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !/\.vdat$/i.test(entry.name)) continue;
          const st = fs.statSync(path.join(ownershipDir, entry.name));
          if (st.size > 16) {
            hasModernSessionFile = true;
            break;
          }
        }
      }
    } catch {}

    if (hasModernSessionFile) {
      return true;
    }
    if (sawClearedModernStorage) {
      return false;
    }

    for (const userDatName of ['users.dat', 'user.dat']) {
      const usersDat = resolveDriveCPathCaseInsensitive(ubiLocalDir, [userDatName]);
      if (usersDat && fs.existsSync(usersDat)) {
        const st = fs.statSync(usersDat);
        if (st.isFile() && st.size > 16) return true;
      }
    }
  } catch {}
  return false;
}

/**
 * Read-only, non-PII check for whether a local EA App authenticated session exists
 * under a Windows/Wine `AppData/Local/Electronic Arts/EA Desktop` or macOS
 * `~/Library/Application Support/Electronic Arts/EA app` directory.
 *
 * Ground-truth rules (zero false positives on unauthenticated bottles):
 * 1. Inspect `user_*.ini` files (excluding `user_unknown.ini`): if any `user_<id>.ini`
 *    explicitly sets `user.ignoreRememberMe=true` or `1`, remember-me is treated as disabled
 *    unless overridden by a newer active cookie (`cookie.ini` mtime > ignored `user_<id>.ini` mtime).
 * 2. Inspect `cookie.ini` (case-insensitive): must exist and contain a non-empty value after `=`
 *    for `browser.rememberMeCookie=...` or `browser.sessionPersistentCookies=...`; if `Expires=<date>`
 *    attributes exist, at least one valid `Date.parse(exp)` must be `> Date.now()`.
 * 3. Fallback: CEF cookie DB (`CEF/BrowserCache/Network/Cookies` or `CEF/BrowserCache/Cookies` > 4096 B)
 *    alongside at least one authenticated `user_<id>.ini` (not `user_unknown.ini`) that does NOT set
 *    `user.ignoreRememberMe=true`/`1` AND `cookie.ini` was not cleared to empty or expired.
 * 4. Never returns `true` solely from `OfflineCache`, `IGStorage`, `user_unknown.ini`, or bare `user_<id>.ini`.
 *
 * @param {string} eaLocalDir
 * @returns {boolean}
 */
function hasEaLocalSessionInDir(eaLocalDir) {
  if (!eaLocalDir) return false;
  try {
    if (!fs.existsSync(eaLocalDir)) return false;
    const entries = fs.readdirSync(eaLocalDir, { withFileTypes: true });

    /** @type {string | null} */
    let cookieIniPath = null;
    let cookieIniMtimeMs = 0;
    let hasExplicitIgnoreRememberMe = false;
    let maxIgnoreRememberMeMtimeMs = 0;
    let hasActiveRememberMeUserIni = false;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower === 'cookie.ini') {
        cookieIniPath = path.join(eaLocalDir, entry.name);
        try {
          cookieIniMtimeMs = fs.statSync(cookieIniPath).mtimeMs || 0;
        } catch {}
        continue;
      }
      if (/^user_.+\.ini$/.test(lower) && lower !== 'user_unknown.ini') {
        const userIniPath = path.join(eaLocalDir, entry.name);
        try {
          const st = fs.statSync(userIniPath);
          if (!st.isFile() || st.size === 0) continue;
          const iniText = fs.readFileSync(userIniPath, 'utf8');
          const ignoreMatch = iniText.match(/^\s*user\.ignoreRememberMe\s*=\s*([^\r\n#;]*)/im);
          const ignoreVal = ignoreMatch
            ? String(ignoreMatch[1] || '')
                .trim()
                .replace(/^["']+|["']+$/g, '')
                .toLowerCase()
            : '';
          if (ignoreVal === 'true' || ignoreVal === '1') {
            hasExplicitIgnoreRememberMe = true;
            maxIgnoreRememberMeMtimeMs = Math.max(maxIgnoreRememberMeMtimeMs, st.mtimeMs || 0);
          } else {
            hasActiveRememberMeUserIni = true;
          }
        } catch {}
      }
    }

    let cookieIniClearedOrEmpty = false;
    let hasExpiredCookieOnly = false;
    let hasValidNonExpiredCookie = false;

    if (cookieIniPath) {
      try {
        const st = fs.statSync(cookieIniPath);
        if (st.size === 0) {
          cookieIniClearedOrEmpty = true;
        } else {
          const cookieText = fs.readFileSync(cookieIniPath, 'utf8');
          const cookieLines = Array.from(
            cookieText.matchAll(
              /^\s*browser\.(?:rememberMeCookie|sessionPersistentCookies)\s*=\s*(.*)$/gim
            )
          );
          if (cookieLines.length === 0) {
            if (!cookieText.trim()) {
              cookieIniClearedOrEmpty = true;
            }
          } else {
            let sawClearedLine = false;
            let sawExpiredLine = false;
            const nowMs = Date.now();

            for (const m of cookieLines) {
              let rhs = String(m[1] || '').trim();
              if (
                !rhs ||
                rhs === '""' ||
                rhs === "''" ||
                /^@invalid\(\)$/i.test(rhs)
              ) {
                sawClearedLine = true;
                continue;
              }
              if (
                (rhs.startsWith('"') && rhs.endsWith('"')) ||
                (rhs.startsWith("'") && rhs.endsWith("'"))
              ) {
                rhs = rhs.slice(1, -1).trim();
              }
              rhs = rhs.replace(/\\"/g, '"').replace(/\\x3b/gi, ';');
              if (!rhs || /^@invalid\(\)$/i.test(rhs)) {
                sawClearedLine = true;
                continue;
              }

              const expMatches = Array.from(rhs.matchAll(/\bexpires\s*=\s*([^;\r\n"|]+)/gi));
              /** @type {number[]} */
              const parsedExpiries = [];
              for (const expMatch of expMatches) {
                const rawExp = String(expMatch[1] || '').trim();
                if (!rawExp) continue;
                const parsedMs = Date.parse(rawExp);
                if (!Number.isNaN(parsedMs)) {
                  parsedExpiries.push(parsedMs);
                }
              }

              if (parsedExpiries.length > 0) {
                if (parsedExpiries.some((ms) => ms > nowMs)) {
                  hasValidNonExpiredCookie = true;
                } else {
                  sawExpiredLine = true;
                }
              } else {
                hasValidNonExpiredCookie = true;
              }
            }

            if (!hasValidNonExpiredCookie) {
              if (sawExpiredLine) hasExpiredCookieOnly = true;
              if (sawClearedLine) cookieIniClearedOrEmpty = true;
            }
          }
        }
      } catch {}
    }

    if (hasValidNonExpiredCookie) {
      if (!hasExplicitIgnoreRememberMe || cookieIniMtimeMs > maxIgnoreRememberMeMtimeMs) {
        return true;
      }
      return false;
    }

    if (
      hasActiveRememberMeUserIni &&
      !hasExplicitIgnoreRememberMe &&
      !cookieIniClearedOrEmpty &&
      !hasExpiredCookieOnly
    ) {
      /** @type {string[]} */
      const cefCandidates = [
        resolveDriveCPathCaseInsensitive(eaLocalDir, ['CEF', 'BrowserCache', 'Network', 'Cookies']),
        resolveDriveCPathCaseInsensitive(eaLocalDir, ['CEF', 'BrowserCache', 'Cookies']),
      ];
      // EA Desktop 13.813+ nests its Chromium profile under `CEF/<schemaVer>/EADesktop/BrowserCache/Network/Cookies`
      const cefRoot = resolveDriveCPathCaseInsensitive(eaLocalDir, ['CEF']);
      try {
        if (cefRoot && fs.existsSync(cefRoot) && fs.statSync(cefRoot).isDirectory()) {
          const cefSubdirs = fs.readdirSync(cefRoot, { withFileTypes: true });
          for (const d of cefSubdirs) {
            if (!d.isDirectory()) continue;
            cefCandidates.push(
              resolveDriveCPathCaseInsensitive(path.join(cefRoot, d.name), [
                'EADesktop',
                'BrowserCache',
                'Network',
                'Cookies',
              ]),
              resolveDriveCPathCaseInsensitive(path.join(cefRoot, d.name), [
                'EADesktop',
                'BrowserCache',
                'Cookies',
              ])
            );
          }
        }
      } catch {}
      for (const cefPath of cefCandidates) {
        try {
          if (cefPath && fs.existsSync(cefPath)) {
            const st = fs.statSync(cefPath);
            if (st.isFile() && st.size > 4096) {
              return true;
            }
          }
        } catch {}
      }
    }
  } catch {}
  return false;
}

/**
 * Extract the first non-empty version string from an EA `version.properties` file.
 *
 * @param {string | undefined | null} versionFilePath
 * @returns {string | undefined}
 */
function readEaVersionFromPropertiesFile(versionFilePath) {
  if (!versionFilePath) return undefined;
  try {
    if (!fs.existsSync(versionFilePath)) return undefined;
    const raw = fs.readFileSync(versionFilePath, 'utf8');
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      if (line.includes('=')) {
        const rhs = line.split('=').slice(1).join('=').trim();
        if (rhs) return rhs;
      } else {
        return line;
      }
    }
  } catch {}
  return undefined;
}

/**
 * Read `CFBundleShortVersionString` (or `CFBundleVersion`) from a macOS `.app` bundle `Info.plist`.
 *
 * @param {string} appBundlePath
 * @returns {string | undefined}
 */
function readMacAppBundleVersionReadOnly(appBundlePath) {
  if (!appBundlePath) return undefined;
  const plistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
  try {
    if (fs.existsSync(plistPath)) {
      const buf = fs.readFileSync(plistPath);
      if (buf.length > 0 && !(buf.length >= 6 && buf.subarray(0, 6).toString('ascii') === 'bplist')) {
        const xml = buf.toString('utf8');
        const shortMatch = xml.match(
          /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i
        );
        if (shortMatch && shortMatch[1]?.trim()) {
          return shortMatch[1].trim();
        }
        const bundleVerMatch = xml.match(
          /<key>\s*CFBundleVersion\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i
        );
        if (bundleVerMatch && bundleVerMatch[1]?.trim()) {
          return bundleVerMatch[1].trim();
        }
      } else if (process.platform === 'darwin' && fs.existsSync('/usr/libexec/PlistBuddy')) {
        for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
          try {
            const out = execFileSync(
              '/usr/libexec/PlistBuddy',
              ['-c', `Print :${key}`, plistPath],
              { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }
            ).trim();
            if (out) return out;
          } catch {}
        }
      }
    }
  } catch {}
  return (
    readEaVersionFromPropertiesFile(
      path.join(appBundlePath, 'Contents', 'Resources', 'version.properties')
    ) ||
    readEaVersionFromPropertiesFile(
      path.join(appBundlePath, 'Contents', 'MacOS', 'version.properties')
    )
  );
}

/**
 * Read-only, non-PII check for whether a Battle.net `Battle.net.config` file has an active
 * `SavedAccountNames` session where `Client.AutoLogin` is NOT `"false"` / `false`.
 * (When Battle.net signs out, it sets `"AutoLogin": "false"` while leaving `SavedAccountNames` populated.)
 *
 * @param {string} configFilePath
 * @returns {boolean}
 */
function hasBattleNetLocalSessionInConfigFile(configFilePath) {
  if (!configFilePath) return false;
  try {
    if (!fs.existsSync(configFilePath)) return false;
    const parsed = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    const saved = parsed?.Client?.SavedAccountNames;
    if (typeof saved !== 'string' || saved.trim().length === 0) return false;
    const autoLogin = parsed?.Client?.AutoLogin;
    if (
      autoLogin === false ||
      autoLogin === 0 ||
      (typeof autoLogin === 'string' && /^(?:false|0|no)$/i.test(autoLogin.trim()))
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect whether a Rockstar `settings_user.dat` or `autosignin.dat` file contains an explicit sign-out flag.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function hasRockstarExplicitSignOutMarker(filePath) {
  if (!filePath) return false;
  try {
    if (!fs.existsSync(filePath)) return false;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size === 0 || st.size > 256 * 1024) return false;
    const text = fs.readFileSync(filePath, 'utf8');
    if (
      /\b(?:auto_?sign_?in|remember_?me)\s*[:=]\s*["']?(?:false|0)["']?/i.test(text) ||
      /\bsigned_?out\s*[:=]\s*["']?(?:true|1)["']?/i.test(text)
    ) {
      return true;
    }
  } catch {}
  return false;
}

/**
 * Read-only, non-PII check for whether Rockstar Games Launcher has an authenticated local profile
 * under `%LOCALAPPDATA%/Rockstar Games/Launcher` (`profiles/<hex>/{settings_account.dat,profiletitles.dat}`).
 * Never marks signed-in from an empty `Documents/Rockstar Games/Social Club/Profiles/<hex>` directory alone.
 *
 * @param {string} launcherLocalOrProfilesDir
 * @param {string} [socialClubProfilesDir]
 * @returns {boolean}
 */
function hasRockstarLocalSessionInDir(launcherLocalOrProfilesDir, socialClubProfilesDir = '') {
  const checkLauncherProfilesContainer = (/** @type {string} */ profilesRoot) => {
    try {
      if (!profilesRoot || !fs.existsSync(profilesRoot)) return false;
      const entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[0-9a-f]{6,}$/i.test(entry.name)) continue;
        const profDir = path.join(profilesRoot, entry.name);
        const signOutMarker = resolveDriveCPathCaseInsensitive(profDir, ['signout']);
        if (signOutMarker && fs.existsSync(signOutMarker)) continue;
        const autoSignInPath = resolveDriveCPathCaseInsensitive(profDir, ['autosignin.dat']);
        if (hasRockstarExplicitSignOutMarker(autoSignInPath)) continue;

        for (const credName of ['settings_account.dat', 'profiletitles.dat', 'autosignin.dat']) {
          const credPath = resolveDriveCPathCaseInsensitive(profDir, [credName]);
          try {
            if (credPath && fs.existsSync(credPath)) {
              const st = fs.statSync(credPath);
              if (st.isFile() && st.size > 0) {
                return true;
              }
            }
          } catch {}
        }
      }
    } catch {}
    return false;
  };

  let sawLauncherLocalDir = false;
  if (launcherLocalOrProfilesDir) {
    try {
      if (fs.existsSync(launcherLocalOrProfilesDir)) {
        const settingsUserPath = resolveDriveCPathCaseInsensitive(launcherLocalOrProfilesDir, [
          'settings_user.dat',
        ]);
        if (hasRockstarExplicitSignOutMarker(settingsUserPath)) {
          return false;
        }
        const nestedProfiles = resolveDriveCPathCaseInsensitive(launcherLocalOrProfilesDir, [
          'profiles',
        ]);
        if (nestedProfiles && fs.existsSync(nestedProfiles)) {
          sawLauncherLocalDir = true;
          if (checkLauncherProfilesContainer(nestedProfiles)) {
            return true;
          }
        } else if (path.basename(launcherLocalOrProfilesDir).toLowerCase() === 'profiles') {
          if (checkLauncherProfilesContainer(launcherLocalOrProfilesDir)) {
            return true;
          }
        }
      }
    } catch {}
  }

  // Secondary fallback for legacy Social Club `autosignin.dat` (never empty `<hex>` folder alone!)
  const scCandidate =
    socialClubProfilesDir ||
    (!sawLauncherLocalDir &&
    launcherLocalOrProfilesDir &&
    /social club[\\/]profiles$/i.test(launcherLocalOrProfilesDir)
      ? launcherLocalOrProfilesDir
      : '');
  if (scCandidate && !sawLauncherLocalDir) {
    try {
      if (fs.existsSync(scCandidate)) {
        const entries = fs.readdirSync(scCandidate, { withFileTypes: true });
        for (const entry of entries) {
          if (
            entry.isFile() &&
            entry.name.toLowerCase() === 'autosignin.dat' &&
            !hasRockstarExplicitSignOutMarker(path.join(scCandidate, entry.name)) &&
            fs.statSync(path.join(scCandidate, entry.name)).size > 0
          ) {
            return true;
          }
          if (entry.isDirectory() && /^[0-9a-f]{6,}$/i.test(entry.name)) {
            const hexAuto = resolveDriveCPathCaseInsensitive(path.join(scCandidate, entry.name), [
              'autosignin.dat',
            ]);
            if (
              hexAuto &&
              fs.existsSync(hexAuto) &&
              !hasRockstarExplicitSignOutMarker(hexAuto) &&
              fs.statSync(hexAuto).size > 0
            ) {
              return true;
            }
          }
        }
      }
    } catch {}
  }

  return false;
}

/**
 * Backwards-compatible two-directory Rockstar session probe (`(profilesDir, launcherLocalDir)`).
 *
 * @param {string} profilesDir
 * @param {string} launcherLocalDir
 * @returns {boolean}
 */
function hasRockstarLocalSessionInDirs(profilesDir, launcherLocalDir) {
  if (launcherLocalDir) {
    return hasRockstarLocalSessionInDir(launcherLocalDir, profilesDir);
  }
  return hasRockstarLocalSessionInDir(profilesDir, '');
}

/**
 * Read-only, non-PII parser for Riot Client's `RiotGamesPrivateSettings.yaml` checking specifically
 * `riot-login` -> `persist` -> `session` -> `cookies` for an authenticated session cookie
 * (`ssid`, `sub`, or `csid` with a non-empty `value`), strictly ignoring pre-login telemetry `tdid`.
 *
 * @param {string} yamlFilePath
 * @returns {boolean}
 */
function hasRiotLocalSessionInFile(yamlFilePath) {
  if (!yamlFilePath) return false;
  try {
    if (!fs.existsSync(yamlFilePath)) return false;
    const st = fs.statSync(yamlFilePath);
    if (!st.isFile() || st.size === 0 || st.size > 4 * 1024 * 1024) return false;
    const raw = fs.readFileSync(yamlFilePath, 'utf8');
    const lines = raw.split(/\r?\n/);

    /** @type {Array<{ indent: number, key: string }>} */
    const pathStack = [];
    let inSessionCookiesList = false;
    let cookiesBlockIndent = -1;
    let currentCookieName = '';
    let currentCookieValue = '';

    const checkCurrentCookie = () => {
      const n = currentCookieName.trim().toLowerCase();
      const v = currentCookieValue.trim();
      if (
        (n === 'ssid' || n === 'sub' || n === 'csid') &&
        v.length > 0 &&
        v.toLowerCase() !== 'null' &&
        v !== '~'
      ) {
        return true;
      }
      return false;
    };

    const stripYamlScalarQuotes = (/** @type {string} */ s) => {
      const t = s.trim();
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1).trim();
      }
      return t.replace(/\s+#.*$/, '').trim();
    };

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indentMatch = rawLine.match(/^[ \t]*/);
      const indent = indentMatch ? indentMatch[0].replace(/\t/g, '  ').length : 0;

      if (inSessionCookiesList) {
        if (indent <= cookiesBlockIndent) {
          if (checkCurrentCookie()) return true;
          currentCookieName = '';
          currentCookieValue = '';
          inSessionCookiesList = false;
          cookiesBlockIndent = -1;
        } else {
          if (trimmed === '-' || trimmed.startsWith('- ')) {
            if (checkCurrentCookie()) return true;
            currentCookieName = '';
            currentCookieValue = '';
            const afterDash = trimmed.slice(1).trim();
            if (afterDash) {
              const kv = afterDash.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
              if (kv) {
                const k = kv[1].toLowerCase();
                const val = stripYamlScalarQuotes(kv[2] || '');
                if (k === 'name') currentCookieName = val;
                else if (k === 'value') currentCookieValue = val;
              }
            }
            continue;
          }
          const propMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
          if (propMatch) {
            const k = propMatch[1].toLowerCase();
            const val = stripYamlScalarQuotes(propMatch[2] || '');
            if (k === 'name') currentCookieName = val;
            else if (k === 'value') currentCookieValue = val;
          }
          continue;
        }
      }

      while (pathStack.length > 0 && pathStack[pathStack.length - 1].indent >= indent) {
        pathStack.pop();
      }

      const keyHeaderMatch = trimmed.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*:\s*(.*)$/);
      if (keyHeaderMatch) {
        const keyLower = keyHeaderMatch[1].toLowerCase();
        const rhs = keyHeaderMatch[2].trim();
        if (!rhs || rhs.startsWith('#')) {
          pathStack.push({ indent, key: keyLower });
          if (
            pathStack.length >= 4 &&
            pathStack[pathStack.length - 4].key === 'riot-login' &&
            pathStack[pathStack.length - 3].key === 'persist' &&
            pathStack[pathStack.length - 2].key === 'session' &&
            keyLower === 'cookies'
          ) {
            inSessionCookiesList = true;
            cookiesBlockIndent = indent;
            currentCookieName = '';
            currentCookieValue = '';
          }
        }
      }
    }

    if (inSessionCookiesList && checkCurrentCookie()) {
      return true;
    }
  } catch {}
  return false;
}

/**
 * Check read-only session presence inside a Wine/CrossOver bottle for `handoffId`.
 *
 * @param {string} bottlePath
 * @param {ChainedHandoffId} handoffId
 * @returns {boolean}
 */
function probeBottlePublisherSessionReadOnly(bottlePath, handoffId) {
  const driveCRoot = bottlePath ? path.join(bottlePath, 'drive_c') : '';
  const ubiLegacyDir = driveCRoot
    ? resolveDriveCPathCaseInsensitive(driveCRoot, [
        'Program Files (x86)',
        'Ubisoft',
        'Ubisoft Game Launcher',
      ])
    : '';
  const userDirs = listBottleUserDirectories(bottlePath);
  for (const userDir of userDirs) {
    if (handoffId === 'ubisoft') {
      const ubiDir = resolveDriveCPathCaseInsensitive(userDir, [
        'AppData',
        'Local',
        'Ubisoft Game Launcher',
      ]);
      if (hasUbisoftLocalSessionInDir(ubiDir, ubiLegacyDir)) return true;
    } else if (handoffId === 'ea') {
      const eaDir = resolveDriveCPathCaseInsensitive(userDir, [
        'AppData',
        'Local',
        'Electronic Arts',
        'EA Desktop',
      ]);
      if (hasEaLocalSessionInDir(eaDir)) return true;
    } else if (handoffId === 'bnet') {
      const bnetCfg = resolveDriveCPathCaseInsensitive(userDir, [
        'AppData',
        'Roaming',
        'Battle.net',
        'Battle.net.config',
      ]);
      if (hasBattleNetLocalSessionInConfigFile(bnetCfg)) return true;
    } else if (handoffId === 'rockstar') {
      const profilesDir = resolveDriveCPathCaseInsensitive(userDir, [
        'Documents',
        'Rockstar Games',
        'Social Club',
        'Profiles',
      ]);
      const altProfilesDir = resolveDriveCPathCaseInsensitive(userDir, [
        'My Documents',
        'Rockstar Games',
        'Social Club',
        'Profiles',
      ]);
      const launcherLocalDir = resolveDriveCPathCaseInsensitive(userDir, [
        'AppData',
        'Local',
        'Rockstar Games',
        'Launcher',
      ]);
      if (
        hasRockstarLocalSessionInDir(launcherLocalDir, profilesDir) ||
        hasRockstarLocalSessionInDir(launcherLocalDir, altProfilesDir)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Discover whether a chained publisher launcher (`'ubisoft' | 'ea' | 'bnet' | 'rockstar'`)
 * is installed inside a macOS Wine/CrossOver bottle, using `system.reg` + case-insensitive
 * `drive_c` lookup and read-only session presence checks.
 *
 * @param {string} bottlePath
 * @param {string} handoffId
 * @param {Record<string, any>} [options]
 * @returns {DiscoveredPublisherLauncherInfo}
 */
function discoverBottlePublisherLauncher(bottlePath, handoffId, options = {}) {
  const canonical = normalizeChainedHandoffId(handoffId);
  if (canonical === 'riot') {
    return {
      installed: false,
      hasLocalSession: false,
      unsupportedBottleReason: CHAINED_PUBLISHER_ECOSYSTEMS.riot.unsupportedBottleReason,
    };
  }
  if (!bottlePath || !canonical) {
    return { installed: false, hasLocalSession: false };
  }
  const driveCRoot = path.join(bottlePath, 'drive_c');
  try {
    if (!fs.existsSync(driveCRoot)) {
      return { installed: false, hasLocalSession: false };
    }
  } catch {
    return { installed: false, hasLocalSession: false };
  }

  const sections = getBottleSystemRegSections(bottlePath, options);
  /** @type {string[]} */
  const winExeCandidates = [];
  /** @type {string[]} */
  const winLauncherAppCandidates = [];
  /** @type {string[]} */
  const winBgServiceCandidates = [];
  /** @type {string | undefined} */
  let version;
  /** @type {string | undefined} */
  let regInstallDirPosix;

  const pushWinCandidate = (/** @type {string} */ winPath) => {
    const clean = String(winPath || '').trim();
    if (clean && !winExeCandidates.includes(clean)) {
      winExeCandidates.push(clean);
    }
  };

  if (canonical === 'ubisoft') {
    const sec32 = sections.get('Software\\Wow6432Node\\Ubisoft\\Launcher');
    const sec64 = sections.get('Software\\Ubisoft\\Launcher');
    const regInstallDir =
      getRegistryPropCaseInsensitive(sec32, 'InstallDir') ||
      getRegistryPropCaseInsensitive(sec64, 'InstallDir');
    version =
      getRegistryPropCaseInsensitive(sec32, 'Version') ||
      getRegistryPropCaseInsensitive(sec64, 'Version') ||
      undefined;
    if (regInstallDir) {
      const trimmedDir = regInstallDir.replace(/[\\/]+$/, '');
      regInstallDirPosix = resolveBottleWindowsPathReadOnly(trimmedDir, bottlePath, options);
      pushWinCandidate(`${trimmedDir}\\upc.exe`);
      pushWinCandidate(`${trimmedDir}\\UbisoftConnect.exe`);
    }
    pushWinCandidate('C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\upc.exe');
    pushWinCandidate(
      'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\UbisoftConnect.exe'
    );
    pushWinCandidate('C:\\Program Files\\Ubisoft\\Ubisoft Game Launcher\\upc.exe');
  } else if (canonical === 'ea') {
    const sec64 = sections.get('Software\\Electronic Arts\\EA Desktop');
    const sec32 = sections.get('Software\\Wow6432Node\\Electronic Arts\\EA Desktop');
    const clientPath =
      getRegistryPropCaseInsensitive(sec64, 'ClientPath') ||
      getRegistryPropCaseInsensitive(sec32, 'ClientPath');
    const launcherAppReg =
      getRegistryPropCaseInsensitive(sec64, 'LauncherAppPath') ||
      getRegistryPropCaseInsensitive(sec32, 'LauncherAppPath');
    const installLoc =
      getRegistryPropCaseInsensitive(sec64, 'InstallLocation') ||
      getRegistryPropCaseInsensitive(sec32, 'InstallLocation');
    version =
      getRegistryPropCaseInsensitive(sec64, 'ClientVersion') ||
      getRegistryPropCaseInsensitive(sec32, 'ClientVersion') ||
      undefined;
    if (clientPath) {
      pushWinCandidate(clientPath);
    }
    if (launcherAppReg) {
      winLauncherAppCandidates.push(launcherAppReg);
    }
    if (installLoc) {
      const trimmedDir = installLoc.replace(/[\\/]+$/, '');
      regInstallDirPosix = resolveBottleWindowsPathReadOnly(trimmedDir, bottlePath, options);
      pushWinCandidate(`${trimmedDir}\\EA Desktop\\EADesktop.exe`);
      pushWinCandidate(`${trimmedDir}\\EA Desktop\\EALauncher.exe`);
      pushWinCandidate(`${trimmedDir}\\EADesktop.exe`);
      pushWinCandidate(`${trimmedDir}\\EALauncher.exe`);
      winLauncherAppCandidates.push(`${trimmedDir}\\EA Desktop\\EALauncher.exe`);
      winLauncherAppCandidates.push(`${trimmedDir}\\EALauncher.exe`);
      winBgServiceCandidates.push(`${trimmedDir}\\EA Desktop\\EABackgroundService.exe`);
      winBgServiceCandidates.push(`${trimmedDir}\\EABackgroundService.exe`);
    }
    if (launcherAppReg) {
      pushWinCandidate(launcherAppReg);
    }
    pushWinCandidate(
      'C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe'
    );
    pushWinCandidate(
      'C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EALauncher.exe'
    );
    pushWinCandidate(
      'C:\\Program Files (x86)\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe'
    );
    pushWinCandidate(
      'C:\\Program Files (x86)\\Electronic Arts\\EA Desktop\\EA Desktop\\EALauncher.exe'
    );
    winLauncherAppCandidates.push(
      'C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EALauncher.exe',
      'C:\\Program Files (x86)\\Electronic Arts\\EA Desktop\\EA Desktop\\EALauncher.exe'
    );
    winBgServiceCandidates.push(
      'C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EABackgroundService.exe',
      'C:\\Program Files (x86)\\Electronic Arts\\EA Desktop\\EA Desktop\\EABackgroundService.exe'
    );
  } else if (canonical === 'bnet') {
    const sec32 = sections.get(
      'Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net'
    );
    const sec64 = sections.get(
      'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net'
    );
    const installLoc =
      getRegistryPropCaseInsensitive(sec32, 'InstallLocation') ||
      getRegistryPropCaseInsensitive(sec64, 'InstallLocation');
    version =
      getRegistryPropCaseInsensitive(sec32, 'DisplayVersion') ||
      getRegistryPropCaseInsensitive(sec64, 'DisplayVersion') ||
      undefined;
    if (installLoc) {
      const trimmedDir = installLoc.replace(/[\\/]+$/, '');
      regInstallDirPosix = resolveBottleWindowsPathReadOnly(trimmedDir, bottlePath, options);
      pushWinCandidate(`${trimmedDir}\\Battle.net.exe`);
      pushWinCandidate(`${trimmedDir}\\Battle.net Launcher.exe`);
    }
    pushWinCandidate('C:\\Program Files (x86)\\Battle.net\\Battle.net.exe');
    pushWinCandidate('C:\\Program Files\\Battle.net\\Battle.net.exe');
  } else if (canonical === 'rockstar') {
    const sec32 = sections.get('Software\\Wow6432Node\\Rockstar Games\\Launcher');
    const sec64 = sections.get('Software\\Rockstar Games\\Launcher');
    const installFolder =
      getRegistryPropCaseInsensitive(sec32, 'InstallFolder') ||
      getRegistryPropCaseInsensitive(sec64, 'InstallFolder');
    version =
      getRegistryPropCaseInsensitive(sec32, 'Version') ||
      getRegistryPropCaseInsensitive(sec64, 'Version') ||
      undefined;
    if (installFolder) {
      const trimmedDir = installFolder.replace(/[\\/]+$/, '');
      regInstallDirPosix = resolveBottleWindowsPathReadOnly(trimmedDir, bottlePath, options);
      pushWinCandidate(`${trimmedDir}\\Launcher.exe`);
      pushWinCandidate(`${trimmedDir}\\LauncherPatcher.exe`);
    }
    pushWinCandidate('C:\\Program Files\\Rockstar Games\\Launcher\\Launcher.exe');
    pushWinCandidate('C:\\Program Files\\Rockstar Games\\Launcher\\LauncherPatcher.exe');
    pushWinCandidate('C:\\Program Files (x86)\\Rockstar Games\\Launcher\\Launcher.exe');
    pushWinCandidate('C:\\Program Files (x86)\\Rockstar Games\\Launcher\\LauncherPatcher.exe');
  }

  /** @type {string | undefined} */
  let foundBinaryPath;
  for (const winCand of winExeCandidates) {
    const hostCand = resolveBottleWindowsPathReadOnly(winCand, bottlePath, options);
    if (!hostCand) continue;
    try {
      const st = fs.statSync(hostCand);
      if (st.isFile() && st.size > 0) {
        foundBinaryPath = hostCand;
        break;
      }
    } catch {}
  }

  const hasLocalSession = probeBottlePublisherSessionReadOnly(bottlePath, canonical);
  if (!foundBinaryPath) {
    return { installed: false, hasLocalSession };
  }

  const installDir =
    regInstallDirPosix && fs.existsSync(regInstallDirPosix)
      ? regInstallDirPosix
      : path.dirname(foundBinaryPath);

  /** @type {string | undefined} */
  let launcherAppPath;
  /** @type {string | undefined} */
  let backgroundServicePath;

  if (canonical === 'ea') {
    const clientDir = path.dirname(foundBinaryPath);
    const siblingLauncher = resolveDriveCPathCaseInsensitive(clientDir, ['EALauncher.exe']);
    const launcherHostCandidates = [
      siblingLauncher,
      ...winLauncherAppCandidates.map((w) => resolveBottleWindowsPathReadOnly(w, bottlePath, options)),
    ].filter(Boolean);
    for (const cand of launcherHostCandidates) {
      try {
        const st = fs.statSync(cand);
        if (st.isFile() && st.size > 0) {
          launcherAppPath = cand;
          break;
        }
      } catch {}
    }

    const siblingBg = resolveDriveCPathCaseInsensitive(clientDir, ['EABackgroundService.exe']);
    const bgHostCandidates = [
      siblingBg,
      ...winBgServiceCandidates.map((w) => resolveBottleWindowsPathReadOnly(w, bottlePath, options)),
    ].filter(Boolean);
    for (const cand of bgHostCandidates) {
      try {
        const st = fs.statSync(cand);
        if (st.isFile() && st.size > 0) {
          backgroundServicePath = cand;
          break;
        }
      } catch {}
    }

    if (!version) {
      const parentClientDir = path.dirname(clientDir);
      version =
        readEaVersionFromPropertiesFile(
          resolveDriveCPathCaseInsensitive(clientDir, ['version.properties'])
        ) ||
        (/ea desktop$/i.test(path.basename(parentClientDir))
          ? readEaVersionFromPropertiesFile(
              resolveDriveCPathCaseInsensitive(parentClientDir, ['version.properties'])
            )
          : undefined) ||
        readEaVersionFromPropertiesFile(
          resolveDriveCPathCaseInsensitive(installDir, ['EA Desktop', 'version.properties'])
        ) ||
        readEaVersionFromPropertiesFile(
          resolveDriveCPathCaseInsensitive(installDir, ['version.properties'])
        );
    }

    if (!version) {
      for (const [secKey, props] of sections.entries()) {
        if (
          !/^software\\(?:wow6432node\\)?microsoft\\windows\\currentversion\\uninstall\\[^\\]+$/i.test(
            secKey
          )
        ) {
          continue;
        }
        const upgradeCode = getRegistryPropCaseInsensitive(props, 'UpgradeCode').toUpperCase();
        const dispName = getRegistryPropCaseInsensitive(props, 'DisplayName').toLowerCase();
        if (
          upgradeCode === '{ADF2591E-00D2-4FFF-9BF4-9CCDAE6BDC67}' ||
          dispName === 'ea app' ||
          dispName === 'ea desktop'
        ) {
          const dispVer =
            getRegistryPropCaseInsensitive(props, 'DisplayVersion') ||
            getRegistryPropCaseInsensitive(props, 'BundleVersion');
          if (dispVer) {
            version = dispVer;
            break;
          }
        }
      }
    }
  }

  return {
    installed: true,
    binaryPath: foundBinaryPath,
    ...(launcherAppPath ? { launcherAppPath } : {}),
    ...(backgroundServicePath ? { backgroundServicePath } : {}),
    installDir,
    ...(version ? { version } : {}),
    hasLocalSession,
  };
}

/**
 * Check read-only session presence on the host OS (`win32` or `darwin`).
 *
 * @param {ChainedHandoffId} canonical
 * @param {string} platform
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function probeHostPublisherSessionReadOnly(canonical, platform, options = {}) {
  const sandboxHome =
    typeof options.homedir === 'string' && options.homedir.trim() ? options.homedir.trim() : '';
  const home = sandboxHome || os.homedir();
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;

  if (platform === 'win32') {
    const localAppData = sandboxHome
      ? String(options.localAppDataDir || env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
      : String(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'));
    const roamingAppData = sandboxHome
      ? String(options.appDataDir || env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : String(env.APPDATA || path.join(home, 'AppData', 'Roaming'));
    const documentsDir = path.join(home, 'Documents');

    if (canonical === 'ubisoft') {
      return hasUbisoftLocalSessionInDir(path.join(localAppData, 'Ubisoft Game Launcher'));
    }
    if (canonical === 'ea') {
      return hasEaLocalSessionInDir(path.join(localAppData, 'Electronic Arts', 'EA Desktop'));
    }
    if (canonical === 'bnet') {
      return hasBattleNetLocalSessionInConfigFile(
        path.join(roamingAppData, 'Battle.net', 'Battle.net.config')
      );
    }
    if (canonical === 'rockstar') {
      return hasRockstarLocalSessionInDirs(
        path.join(documentsDir, 'Rockstar Games', 'Social Club', 'Profiles'),
        path.join(localAppData, 'Rockstar Games', 'Launcher')
      );
    }
    if (canonical === 'riot') {
      const riotPrivateSettings = path.join(
        localAppData,
        'Riot Games',
        'Riot Client',
        'Data',
        'RiotGamesPrivateSettings.yaml'
      );
      return hasRiotLocalSessionInFile(riotPrivateSettings);
    }
    return false;
  }

  if (platform === 'darwin') {
    if (canonical === 'ea') {
      return hasEaLocalSessionInDir(
        path.join(home, 'Library', 'Application Support', 'Electronic Arts', 'EA app')
      );
    }
    if (canonical === 'bnet') {
      return hasBattleNetLocalSessionInConfigFile(
        path.join(home, 'Library', 'Application Support', 'Battle.net', 'Battle.net.config')
      );
    }
    if (canonical === 'riot') {
      const riotPrivateSettings = path.join(
        home,
        'Library',
        'Application Support',
        'Riot Games',
        'Riot Client',
        'Data',
        'RiotGamesPrivateSettings.yaml'
      );
      return hasRiotLocalSessionInFile(riotPrivateSettings);
    }
  }
  return false;
}

/**
 * Detect native macOS `.app` publisher launcher bundles on `darwin` for `'ea'` (`EA app.app`),
 * `'bnet'` (`Battle.net.app`), and `'riot'` (`/Users/Shared/Riot Games/Riot Client.app` and
 * `/Applications/Riot Client.app`). Returns `{ installed: false, ... }` for Windows-only clients.
 *
 * @param {string} handoffId
 * @param {Record<string, any>} [options]
 * @returns {{
 *   installed: boolean,
 *   handoffId: ChainedHandoffId | null,
 *   appBundlePath: string | null,
 *   binaryPath: string | null,
 *   installDir?: string,
 *   launcherAppPath?: string,
 *   backgroundServicePath?: string,
 *   version?: string,
 * }}
 */
function detectMacNativePublisherBundle(handoffId, options = {}) {
  const canonical = normalizeChainedHandoffId(handoffId);
  if (!canonical || canonical === 'ubisoft' || canonical === 'rockstar') {
    return {
      installed: false,
      handoffId: canonical,
      appBundlePath: null,
      binaryPath: null,
    };
  }

  const sandboxHome =
    typeof options.homedir === 'string' && options.homedir.trim() ? options.homedir.trim() : '';
  const customAppsDir =
    typeof options.customApplicationsDir === 'string' && options.customApplicationsDir.trim()
      ? options.customApplicationsDir.trim()
      : '';
  const isIsolatedSandbox = Boolean(sandboxHome || customAppsDir);
  const home = sandboxHome || os.homedir();

  const appRoots = isIsolatedSandbox
    ? [customAppsDir, sandboxHome ? path.join(sandboxHome, 'Applications') : ''].filter(Boolean)
    : ['/Applications', path.join(home, 'Applications')];

  if (canonical === 'ea') {
    for (const appRoot of appRoots) {
      const appBundle = path.join(appRoot, 'EA app.app');
      const eaDesktopBin = path.join(appBundle, 'Contents', 'MacOS', 'EADesktop');
      const eaAppBin = path.join(appBundle, 'Contents', 'MacOS', 'EA app');
      try {
        const macBin = fs.existsSync(eaDesktopBin)
          ? eaDesktopBin
          : fs.existsSync(eaAppBin)
            ? eaAppBin
            : '';
        if (macBin) {
          const version = readMacAppBundleVersionReadOnly(appBundle);
          const helperLauncher = path.join(
            appBundle,
            'Contents',
            'Applications',
            'EALauncher.app',
            'Contents',
            'MacOS',
            'EALauncher'
          );
          const helperBg = path.join(
            appBundle,
            'Contents',
            'Applications',
            'EABackgroundService.app',
            'Contents',
            'MacOS',
            'EABackgroundService'
          );
          return {
            installed: true,
            handoffId: 'ea',
            appBundlePath: appBundle,
            binaryPath: macBin,
            ...(fs.existsSync(helperLauncher) ? { launcherAppPath: helperLauncher } : {}),
            ...(fs.existsSync(helperBg) ? { backgroundServicePath: helperBg } : {}),
            installDir: appBundle,
            ...(version ? { version } : {}),
          };
        }
      } catch {}
    }
    return { installed: false, handoffId: 'ea', appBundlePath: null, binaryPath: null };
  }

  if (canonical === 'bnet') {
    for (const appRoot of appRoots) {
      const appBundle = path.join(appRoot, 'Battle.net.app');
      const macBin = path.join(appBundle, 'Contents', 'MacOS', 'Battle.net');
      try {
        if (fs.existsSync(macBin)) {
          const version = readMacAppBundleVersionReadOnly(appBundle);
          return {
            installed: true,
            handoffId: 'bnet',
            appBundlePath: appBundle,
            binaryPath: macBin,
            installDir: appBundle,
            ...(version ? { version } : {}),
          };
        }
      } catch {}
    }
    return { installed: false, handoffId: 'bnet', appBundlePath: null, binaryPath: null };
  }

  if (canonical === 'riot') {
    const explicitSharedRiotDir =
      typeof options.sharedRiotDir === 'string' && options.sharedRiotDir.trim()
        ? options.sharedRiotDir.trim()
        : '';
    const sharedRiotDir =
      explicitSharedRiotDir ||
      (isIsolatedSandbox
        ? sandboxHome
          ? path.join(sandboxHome, 'Users', 'Shared', 'Riot Games')
          : ''
        : '/Users/Shared/Riot Games');
    /** @type {string[]} */
    const bundleCandidates = [];
    if (sharedRiotDir) {
      const installsJson = path.join(sharedRiotDir, 'RiotClientInstalls.json');
      try {
        if (fs.existsSync(installsJson)) {
          const parsed = JSON.parse(fs.readFileSync(installsJson, 'utf8'));
          for (const k of ['rc_default', 'rc_live', 'rc_beta']) {
            if (typeof parsed?.[k] === 'string' && parsed[k].trim()) {
              bundleCandidates.push(parsed[k].trim());
            }
          }
        }
      } catch {}
      bundleCandidates.push(path.join(sharedRiotDir, 'Riot Client.app'));
    }
    for (const appRoot of appRoots) {
      bundleCandidates.push(path.join(appRoot, 'Riot Client.app'));
    }
    for (const cand of bundleCandidates) {
      if (!cand) continue;
      try {
        if (!fs.existsSync(cand)) continue;
        const st = fs.statSync(cand);
        if (st.isFile()) {
          const inferredBundle = /\.app\/Contents\/MacOS\/[^/]+$/i.test(cand)
            ? path.resolve(cand, '..', '..', '..')
            : null;
          const version = inferredBundle
            ? readMacAppBundleVersionReadOnly(inferredBundle)
            : undefined;
          return {
            installed: true,
            handoffId: 'riot',
            appBundlePath: inferredBundle || path.dirname(cand),
            binaryPath: cand,
            installDir: inferredBundle || path.dirname(cand),
            ...(version ? { version } : {}),
          };
        }
        if (st.isDirectory()) {
          const macServicesBin = path.join(cand, 'Contents', 'MacOS', 'RiotClientServices');
          const macRiotBin = path.join(cand, 'Contents', 'MacOS', 'Riot Client');
          const resolvedBin = fs.existsSync(macServicesBin)
            ? macServicesBin
            : fs.existsSync(macRiotBin)
              ? macRiotBin
              : '';
          if (resolvedBin) {
            const version = readMacAppBundleVersionReadOnly(cand);
            return {
              installed: true,
              handoffId: 'riot',
              appBundlePath: cand,
              binaryPath: resolvedBin,
              installDir: cand,
              ...(version ? { version } : {}),
            };
          }
        }
      } catch {}
    }
    return { installed: false, handoffId: 'riot', appBundlePath: null, binaryPath: null };
  }

  return { installed: false, handoffId: canonical, appBundlePath: null, binaryPath: null };
}

/**
 * Discover whether a publisher launcher (`'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot'`)
 * is installed natively on the host OS (`win32` or `darwin`).
 * On `darwin`, returns `{ installed: false }` for Windows-only clients (`ubisoft`, `rockstar`).
 *
 * @param {string} handoffId
 * @param {Record<string, any>} [options]
 * @returns {DiscoveredPublisherLauncherInfo}
 */
function discoverHostPublisherLauncher(handoffId, options = {}) {
  const canonical = normalizeChainedHandoffId(handoffId);
  const platform = String(options.platform || process.platform).toLowerCase();
  if (!canonical) {
    return { installed: false, hasLocalSession: false };
  }

  if (platform === 'win32') {
    const winFound = discoverWindowsPublisherLauncherPaths(canonical, options);
    const hasLocalSession = probeHostPublisherSessionReadOnly(canonical, 'win32', options);
    if (!winFound.binaryPath) {
      return { installed: false, hasLocalSession };
    }
    return {
      installed: true,
      binaryPath: winFound.binaryPath,
      ...(winFound.launcherAppPath ? { launcherAppPath: winFound.launcherAppPath } : {}),
      ...(winFound.backgroundServicePath
        ? { backgroundServicePath: winFound.backgroundServicePath }
        : {}),
      ...(winFound.installDir ? { installDir: winFound.installDir } : {}),
      ...(winFound.version ? { version: winFound.version } : {}),
      hasLocalSession,
    };
  }

  if (platform === 'darwin') {
    if (canonical === 'ubisoft' || canonical === 'rockstar') {
      return { installed: false, hasLocalSession: false };
    }
    const hasLocalSession = probeHostPublisherSessionReadOnly(canonical, 'darwin', options);
    const macBundle = detectMacNativePublisherBundle(canonical, options);
    if (!macBundle.installed || !macBundle.binaryPath) {
      return { installed: false, hasLocalSession };
    }
    return {
      installed: true,
      binaryPath: macBundle.binaryPath,
      ...(macBundle.launcherAppPath ? { launcherAppPath: macBundle.launcherAppPath } : {}),
      ...(macBundle.backgroundServicePath
        ? { backgroundServicePath: macBundle.backgroundServicePath }
        : {}),
      ...(macBundle.installDir ? { installDir: macBundle.installDir } : {}),
      ...(macBundle.version ? { version: macBundle.version } : {}),
      hasLocalSession,
    };
  }

  return { installed: false, hasLocalSession: false };
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

  if (
    lower === 'upc.exe' ||
    lower === 'ubisoftconnect.exe' ||
    lower === 'ubisoftextension.exe' ||
    lower === 'eadesktop.exe' ||
    lower === 'ealauncher.exe' ||
    lower === 'eabackgroundservice.exe' ||
    lower === 'eacefsubprocess.exe' ||
    lower === 'ealocalhostsvc.exe' ||
    lower === 'ealaunchhelper.exe' ||
    lower === 'eaupdater.exe' ||
    lower === 'eacrashreporter.exe' ||
    lower === 'errorreporter.exe' ||
    lower === 'eagep.exe' ||
    lower === 'eaconnect_microsoft.exe' ||
    lower === 'easteamproxy.exe' ||
    lower === 'easteamlauncher.exe' ||
    lower === 'easteamauthhelper.exe' ||
    lower === 'eaegsproxy.exe' ||
    lower === 'eaegslauncher.exe' ||
    lower === 'eadestager.exe' ||
    lower === 'apprecovery.exe' ||
    lower === 'getgametoken32.exe' ||
    lower === 'getgametoken64.exe' ||
    lower === 'igoproxy32.exe' ||
    lower === 'igoproxy64.exe' ||
    lower === 'eaanticheat.installer.exe' ||
    lower === 'eaanticheat.installer.tool.exe' ||
    lower === 'eacoreserver.exe' ||
    lower === 'eaproxyinstaller.exe' ||
    lower === 'originlegacycli.exe' ||
    lower === 'patchprogress.exe' ||
    lower === 'activationui.exe' ||
    lower === 'link2ea.exe' ||
    lower === 'cleanup.exe' ||
    lower === 'touchup.exe' ||
    lower === 'agent.exe' ||
    lower === 'blizzarderror.exe' ||
    lower === 'systemsurvey.exe' ||
    lower === 'launcherpatcher.exe' ||
    lower === 'socialclubhelper.exe' ||
    lower === 'rockstarservice.exe' ||
    lower === 'rockstarerrorhandler.exe' ||
    lower === 'riotclientservices.exe' ||
    lower === 'riotclientcrashhandler.exe' ||
    lower === 'gdkstubgame.exe' ||
    lower === 'dxsetup.exe' ||
    lower === 'crashpad_handler.exe' ||
    lower === 'crs-handler.exe' ||
    lower === 'vgc.exe' ||
    lower === 'vgtray.exe'
  ) {
    return true;
  }

  if (
    lower.startsWith('ubisoftgamelauncher') ||
    lower.startsWith('uplay') ||
    lower.startsWith('battle.net') ||
    lower.startsWith('riotclient') ||
    lower.startsWith('eaanticheat') ||
    lower.startsWith('unins') ||
    lower.startsWith('uninstall') ||
    lower.startsWith('vc_redist') ||
    lower.startsWith('vcredist') ||
    lower.startsWith('unitycrashhandler') ||
    lower.startsWith('crashreportclient') ||
    lower.startsWith('ue4prereqsetup') ||
    lower.startsWith('ueprereqsetup') ||
    lower.startsWith('easyanticheat') ||
    lower.startsWith('beservice')
  ) {
    return true;
  }

  return false;
}

/**
 * Locate the primary playable game executable inside `installPath` (bounded depth scan),
 * strictly excluding publisher launcher, redistributable, crash-handler, and stub binaries.
 * Prefers `preferredRelativeOrAbsExe` when valid, otherwise picks the largest top-level or
 * shallow `.exe` binary (or macOS `.app` bundle binary on `darwin` host directories).
 *
 * @param {string} installPath
 * @param {string} [preferredExeHint]
 * @param {{ allowMacAppBundles?: boolean }} [opts]
 * @returns {{ executablePath: string | null, approxSizeBytes: number }}
 */
function findPrimaryPublisherGameExecutable(installPath, preferredExeHint = '', opts = {}) {
  if (!installPath) return { executablePath: null, approxSizeBytes: 0 };
  try {
    const rootStat = fs.statSync(installPath);
    if (!rootStat.isDirectory()) return { executablePath: null, approxSizeBytes: 0 };
  } catch {
    return { executablePath: null, approxSizeBytes: 0 };
  }

  if (preferredExeHint) {
    const cleanedHint = preferredExeHint
      .trim()
      .replace(/^"+|"+$/g, '')
      .replace(/,\s*-?\d+\s*$/, '')
      .replace(/^(?:\[[^\]]+\][\\/]*)+/, '');
    if (cleanedHint) {
      const candidatePaths = [];
      if (path.isAbsolute(cleanedHint) && fs.existsSync(cleanedHint)) {
        candidatePaths.push(cleanedHint);
      } else {
        const relParts = cleanedHint.replace(/\\/g, '/').split('/').filter(Boolean);
        if (relParts.length > 0) {
          candidatePaths.push(resolveDriveCPathCaseInsensitive(installPath, relParts));
        }
      }
      for (const cand of candidatePaths) {
        const base = path.basename(cand);
        if (isExcludedPublisherOrRedistExe(base)) continue;
        try {
          const st = fs.statSync(cand);
          if (st.isFile() && st.size > 0) {
            return { executablePath: cand, approxSizeBytes: st.size };
          }
        } catch {}
      }
    }
  }

  /** @type {Array<{ fullPath: string, size: number, depth: number }>} */
  const candidates = [];
  let totalSeenBytes = 0;
  let visitedEntries = 0;
  const maxVisitedEntries = 250;

  /**
   * @param {string} dir
   * @param {number} depth
   */
  const walk = (dir, depth) => {
    if (depth > 4 || visitedEntries >= maxVisitedEntries) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visitedEntries >= maxVisitedEntries) break;
      if (entry.name.startsWith('.')) continue;
      visitedEntries += 1;
      const lowerName = entry.name.toLowerCase();
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (
          opts.allowMacAppBundles &&
          lowerName.endsWith('.app') &&
          lowerName !== 'battle.net.app' &&
          lowerName !== 'riot client.app' &&
          lowerName !== 'ea app.app'
        ) {
          const macOsDir = path.join(fullPath, 'Contents', 'MacOS');
          try {
            if (fs.existsSync(macOsDir)) {
              const macBins = fs.readdirSync(macOsDir, { withFileTypes: true });
              for (const bin of macBins) {
                if (!bin.isFile()) continue;
                const binPath = path.join(macOsDir, bin.name);
                const st = fs.statSync(binPath);
                if (st.size > 0) {
                  candidates.push({ fullPath: binPath, size: st.size, depth });
                }
              }
            }
          } catch {}
          continue;
        }
        if (EXCLUDED_GAME_DIR_NAMES.has(lowerName)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(fullPath);
          totalSeenBytes += st.size;
          if (!isExcludedPublisherOrRedistExe(entry.name) && st.size > 0) {
            // Avoid mistaking Rockstar's own Launcher.exe inside a launcher dir for a game
            if (lowerName === 'launcher.exe' && depth === 0) {
              const siblingPatcher = path.join(dir, 'LauncherPatcher.exe');
              if (fs.existsSync(siblingPatcher)) continue;
            }
            candidates.push({ fullPath, size: st.size, depth });
          }
        } catch {}
      }
    }
  };

  walk(installPath, 0);
  if (candidates.length === 0) {
    return { executablePath: null, approxSizeBytes: 0 };
  }

  candidates.sort((a, b) => {
    const aIsPlayWrapper = /^play[a-z0-9_.-]*\.exe$/i.test(path.basename(a.fullPath));
    const bIsPlayWrapper = /^play[a-z0-9_.-]*\.exe$/i.test(path.basename(b.fullPath));
    if (b.size !== a.size) return b.size - a.size;
    if (aIsPlayWrapper !== bIsPlayWrapper) return aIsPlayWrapper ? 1 : -1;
    return a.depth - b.depth;
  });

  return {
    executablePath: candidates[0].fullPath,
    approxSizeBytes: totalSeenBytes || candidates[0].size,
  };
}

const STEAMAPPS_COMMON_PATH_RE = /[\\/]steamapps[\\/]common(?:[\\/]|$)/i;

/**
 * Decode common XML character entities (`&amp;`, `&apos;`, `&#39;`, `&quot;`, `&lt;`, `&gt;`).
 *
 * @param {string} raw
 * @returns {string}
 */
function decodeXmlEntities(raw) {
  if (!raw || typeof raw !== 'string' || !raw.includes('&')) return raw || '';
  return raw
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : _m;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : _m;
    })
    .replace(/&amp;/gi, '&');
}

/**
 * Bounded case-insensitive basename search under `installRoot` (max depth 4, excluding redist dirs).
 *
 * @param {string} installRoot
 * @param {string} targetBaseName
 * @returns {string | null}
 */
function findRelativeExeByBasenameUnderRoot(installRoot, targetBaseName) {
  if (!installRoot || !targetBaseName) return null;
  const targetLower = targetBaseName.toLowerCase();
  /** @type {string | null} */
  let foundRel = null;

  /**
   * @param {string} dir
   * @param {number} depth
   */
  const walk = (dir, depth) => {
    if (foundRel || depth > 4) return;
    /** @type {import('node:fs').Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const lower = entry.name.toLowerCase();
      const full = path.join(dir, entry.name);
      if (entry.isFile() && lower === targetLower) {
        try {
          if (fs.statSync(full).size > 0) {
            foundRel = path.relative(installRoot, full);
            return;
          }
        } catch {}
      }
    }
    for (const entry of entries) {
      if (foundRel) return;
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const lower = entry.name.toLowerCase();
      if (EXCLUDED_GAME_DIR_NAMES.has(lower)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };

  walk(installRoot, 0);
  return foundRel;
}

/**
 * Parse EA `__Installer/installerdata.xml` metadata without external XML dependencies.
 * Extracts all `<contentID>` values, decodes XML entities, scores `<launcher>` blocks inside `<runtime>`
 * (penalizing `trial` / `hidden` launchers and preferring non-trial 64-bit launchers), and strips
 * `[HKEY_...]` / `[Install Dir]` prefixes cleanly.
 *
 * @param {string} xmlText
 * @param {string} [installRoot]
 * @returns {{ contentId: string, contentIds: string[], title: string, launcherRelExe: string, executablePath?: string }}
 */
function parseEaInstallerDataXml(xmlText, installRoot = '') {
  if (!xmlText || typeof xmlText !== 'string') {
    return { contentId: '', contentIds: [], title: '', launcherRelExe: '' };
  }

  /** @type {string[]} */
  const contentIds = [];
  for (const m of xmlText.matchAll(/<contentID>\s*([^<]+?)\s*<\/contentID>/gi)) {
    const cid = decodeXmlEntities(String(m[1] || '').trim()).trim();
    if (cid && !contentIds.includes(cid)) {
      contentIds.push(cid);
    }
  }
  if (contentIds.length === 0) {
    for (const m of xmlText.matchAll(/<productId>\s*([^<]+?)\s*<\/productId>/gi)) {
      const pid = decodeXmlEntities(String(m[1] || '').trim()).trim();
      if (pid && !contentIds.includes(pid)) {
        contentIds.push(pid);
      }
    }
  }

  const preferredOfferId = contentIds.find((id) => /^(?:Origin\.OFR\.|EA\.)/i.test(id));
  const contentId = preferredOfferId || contentIds[0] || '';

  let title = '';
  const enUsTitleMatch =
    xmlText.match(/<gameTitle[^>]*locale\s*=\s*["']en[-_]US["'][^>]*>([^<]+)<\/gameTitle>/i) ||
    xmlText.match(/<title[^>]*locale\s*=\s*["']en[-_]US["'][^>]*>([^<]+)<\/title>/i);
  if (enUsTitleMatch && enUsTitleMatch[1]) {
    title = decodeXmlEntities(enUsTitleMatch[1].trim()).trim();
  } else {
    const anyTitleMatch =
      xmlText.match(/<gameTitle[^>]*>([^<]+)<\/gameTitle>/i) ||
      xmlText.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (anyTitleMatch && anyTitleMatch[1]) {
      title = decodeXmlEntities(anyTitleMatch[1].trim()).trim();
    }
  }

  const hasValidInstallRoot = (() => {
    if (!installRoot) return false;
    try {
      return fs.existsSync(installRoot) && fs.statSync(installRoot).isDirectory();
    } catch {
      return false;
    }
  })();

  /**
   * @param {string} rawPathText
   * @returns {{ cleanedRel: string, existsOnDisk: boolean } | null}
   */
  const cleanAndResolveLauncherFilePath = (rawPathText) => {
    const decoded = decodeXmlEntities(String(rawPathText || '').trim())
      .trim()
      .replace(/^"+|"+$/g, '')
      .replace(/^(?:\[[^\]]+\][\\/]*)+/, '')
      .replace(/^[\\/]+/, '');
    if (!decoded) return null;
    const baseName = decoded.replace(/\\/g, '/').split('/').pop() || '';
    if (!baseName || isExcludedPublisherOrRedistExe(baseName)) return null;

    if (hasValidInstallRoot) {
      const relParts = decoded.replace(/\\/g, '/').split('/').filter(Boolean);
      if (relParts.length > 0) {
        const directCand = resolveDriveCPathCaseInsensitive(installRoot, relParts);
        try {
          if (fs.existsSync(directCand) && fs.statSync(directCand).isFile()) {
            return { cleanedRel: decoded, existsOnDisk: true };
          }
        } catch {}
      }
      const fallbackRel = findRelativeExeByBasenameUnderRoot(installRoot, baseName);
      if (fallbackRel) {
        return { cleanedRel: fallbackRel, existsOnDisk: true };
      }
    }

    return { cleanedRel: decoded, existsOnDisk: false };
  };

  let launcherRelExe = '';
  const runtimeBlockMatch = xmlText.match(/<runtime\b[\s\S]*?<\/runtime>/i);
  const searchArea = runtimeBlockMatch ? runtimeBlockMatch[0] : xmlText;

  /** @type {Array<{ cleanedRel: string, score: number, index: number }>} */
  const scoredLaunchers = [];
  let blockIdx = 0;

  for (const lm of searchArea.matchAll(/<launcher\b([^>]*)>([\s\S]*?)<\/launcher>/gi)) {
    const attrs = String(lm[1] || '');
    const inner = String(lm[2] || '');
    const idx = blockIdx++;

    const fpMatch = inner.match(/<filePath>\s*([\s\S]*?)\s*<\/filePath>/i);
    if (!fpMatch || !fpMatch[1]) continue;

    const resolvedFp = cleanAndResolveLauncherFilePath(fpMatch[1]);
    if (!resolvedFp) continue;

    let score = 0;
    const trialAttr = attrs.match(/\btrial\s*=\s*["']?([^"'\s>]+)["']?/i);
    const trialTag = inner.match(/<trial>\s*([^<\s]+)\s*<\/trial>/i);
    const trialVal = String(trialAttr?.[1] ?? trialTag?.[1] ?? '')
      .trim()
      .toLowerCase();
    if (trialVal === '1' || trialVal === 'true') {
      score -= 100;
    } else {
      score += 50;
    }

    const hiddenAttr = attrs.match(/\bhidden\s*=\s*["']?([^"'\s>]+)["']?/i);
    const hiddenTag = inner.match(/<hidden>\s*([^<\s]+)\s*<\/hidden>/i);
    const hiddenVal = String(hiddenAttr?.[1] ?? hiddenTag?.[1] ?? '')
      .trim()
      .toLowerCase();
    if (hiddenVal === '1' || hiddenVal === 'true') {
      score -= 50;
    }

    const req64Attr = attrs.match(/\brequires64BitOS\s*=\s*["']?([^"'\s>]+)["']?/i);
    const req64Tag = inner.match(/<requires64BitOS>\s*([^<\s]+)\s*<\/requires64BitOS>/i);
    const req64Val = String(req64Attr?.[1] ?? req64Tag?.[1] ?? '')
      .trim()
      .toLowerCase();
    if (req64Val === '1' || req64Val === 'true') {
      score += 20;
    }

    if (resolvedFp.existsOnDisk) {
      score += 30;
    }

    scoredLaunchers.push({ cleanedRel: resolvedFp.cleanedRel, score, index: idx });
  }

  if (scoredLaunchers.length > 0) {
    scoredLaunchers.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
    launcherRelExe = scoredLaunchers[0].cleanedRel;
  } else {
    const filePathMatches = searchArea.matchAll(/<filePath>\s*([^<]+?)\s*<\/filePath>/gi);
    for (const m of filePathMatches) {
      const resolvedFp = cleanAndResolveLauncherFilePath(m[1]);
      if (resolvedFp) {
        launcherRelExe = resolvedFp.cleanedRel;
        break;
      }
    }
  }

  /** @type {string | undefined} */
  let executablePath = undefined;
  if (launcherRelExe && installRoot) {
    const relParts = launcherRelExe.replace(/\\/g, '/').split('/').filter(Boolean);
    if (relParts.length > 0) {
      executablePath = hasValidInstallRoot
        ? resolveDriveCPathCaseInsensitive(installRoot, relParts)
        : path.join(installRoot, ...relParts);
    }
  }

  return {
    contentId,
    contentIds,
    title,
    launcherRelExe,
    ...(executablePath ? { executablePath } : {}),
  };
}

/**
 * Extract `machine.downloadinplacedir` or `user.downloadinplacedir` from an EA Desktop `.ini` file.
 *
 * @param {string} iniFilePath
 * @returns {string}
 */
function extractEaIniDownloadInPlaceDir(iniFilePath) {
  if (!iniFilePath) return '';
  try {
    if (!fs.existsSync(iniFilePath)) return '';
    const text = fs.readFileSync(iniFilePath, 'utf8');
    const m = text.match(/^\s*(?:(?:machine|user)\.)?downloadinplacedir\s*=\s*(.+)$/im);
    if (m && m[1]) {
      const val = m[1]
        .trim()
        .replace(/^["']+|["']+$/g, '')
        .replace(/\\\\/g, '\\')
        .trim();
      if (val && val.toLowerCase() !== 'null' && !/^@invalid\(\)$/i.test(val)) {
        return val.replace(/([^:])[\\/]+$/, '$1');
      }
    }
  } catch {}
  return '';
}

/**
 * Extract `DownloadInPlaceDir` from a legacy Origin `local_*.xml` or `local.xml` file.
 *
 * @param {string} xmlFilePath
 * @returns {string}
 */
function extractOriginXmlDownloadInPlaceDir(xmlFilePath) {
  if (!xmlFilePath) return '';
  try {
    if (!fs.existsSync(xmlFilePath)) return '';
    const xml = fs.readFileSync(xmlFilePath, 'utf8');
    const m =
      xml.match(
        /<Setting\b[^>]*\bkey\s*=\s*["']DownloadInPlaceDir["'][^>]*\bvalue\s*=\s*["']([^"']+)["']/i
      ) ||
      xml.match(
        /<Setting\b[^>]*\bvalue\s*=\s*["']([^"']+)["'][^>]*\bkey\s*=\s*["']DownloadInPlaceDir["']/i
      );
    if (m && m[1]) {
      const val = decodeXmlEntities(m[1].trim()).trim();
      if (val && val.toLowerCase() !== 'null') {
        return val.replace(/([^:])[\\/]+$/, '$1');
      }
    }
  } catch {}
  return '';
}

/**
 * Discover all configured and default EA App / Origin game library root directories
 * either inside a macOS Wine/CrossOver bottle (`bottlePath` string or `{ bottlePath }`)
 * or on the host OS (`win32` or `darwin` options object). Strictly read-only.
 *
 * @param {string | Record<string, any>} [optionsOrBottle]
 * @returns {string[]}
 */
function readEaConfiguredLibraryRoots(optionsOrBottle = {}) {
  /** @type {string[]} */
  const roots = [];
  /** @type {Set<string>} */
  const seenLower = new Set();

  const pushRoot = (/** @type {string | null | undefined} */ rawDir) => {
    const clean = String(rawDir || '')
      .trim()
      .replace(/^["']+|["']+$/g, '')
      .replace(/([^:])[\\/]+$/, '$1');
    if (!clean) return;
    if (STEAMAPPS_COMMON_PATH_RE.test(clean)) return;
    const key = clean.toLowerCase();
    if (!seenLower.has(key)) {
      seenLower.add(key);
      roots.push(clean);
    }
  };

  let bottlePath = '';
  /** @type {Record<string, any>} */
  let opts = {};

  if (typeof optionsOrBottle === 'string') {
    const trimmed = optionsOrBottle.trim();
    if (trimmed) {
      bottlePath =
        path.basename(trimmed).toLowerCase() === 'drive_c' ? path.dirname(trimmed) : trimmed;
    }
  } else if (optionsOrBottle && typeof optionsOrBottle === 'object') {
    opts = optionsOrBottle;
    if (typeof opts.bottlePath === 'string' && opts.bottlePath.trim()) {
      bottlePath = opts.bottlePath.trim();
    } else if (typeof opts.driveCRoot === 'string' && opts.driveCRoot.trim()) {
      const dc = opts.driveCRoot.trim();
      bottlePath = path.basename(dc).toLowerCase() === 'drive_c' ? path.dirname(dc) : dc;
    }
  }

  if (bottlePath) {
    const driveCRoot = path.join(bottlePath, 'drive_c');
    const pushBottleWinOrPosix = (/** @type {string} */ candidatePath) => {
      if (!candidatePath) return;
      const resolved = candidatePath.startsWith('/')
        ? resolveWineReparseTargetReadOnly(candidatePath, driveCRoot, opts)
        : resolveBottleWindowsPathReadOnly(candidatePath, bottlePath, opts);
      pushRoot(resolved);
    };

    const machineIni = resolveDriveCPathCaseInsensitive(driveCRoot, [
      'ProgramData',
      'EA Desktop',
      'machine.ini',
    ]);
    const machineDir = extractEaIniDownloadInPlaceDir(machineIni);
    if (machineDir) pushBottleWinOrPosix(machineDir);

    for (const userDir of listBottleUserDirectories(bottlePath)) {
      const eaDesktopLocal = resolveDriveCPathCaseInsensitive(userDir, [
        'AppData',
        'Local',
        'Electronic Arts',
        'EA Desktop',
      ]);
      try {
        if (eaDesktopLocal && fs.existsSync(eaDesktopLocal)) {
          const userInis = fs
            .readdirSync(eaDesktopLocal, { withFileTypes: true })
            .filter(
              (d) =>
                d.isFile() &&
                /^user_.+\.ini$/i.test(d.name) &&
                d.name.toLowerCase() !== 'user_unknown.ini'
            )
            .sort((a, b) => a.name.localeCompare(b.name));
          for (const f of userInis) {
            const customDir = extractEaIniDownloadInPlaceDir(path.join(eaDesktopLocal, f.name));
            if (customDir) pushBottleWinOrPosix(customDir);
          }
        }
      } catch {}

      const originRoaming = resolveDriveCPathCaseInsensitive(userDir, [
        'AppData',
        'Roaming',
        'Origin',
      ]);
      try {
        if (originRoaming && fs.existsSync(originRoaming)) {
          const originXmls = fs
            .readdirSync(originRoaming, { withFileTypes: true })
            .filter((d) => d.isFile() && /^local(?:_.*)?\.xml$/i.test(d.name))
            .sort((a, b) => a.name.localeCompare(b.name));
          for (const f of originXmls) {
            const originDir = extractOriginXmlDownloadInPlaceDir(path.join(originRoaming, f.name));
            if (originDir) pushBottleWinOrPosix(originDir);
          }
        }
      } catch {}
    }

    for (const relSegs of [
      ['Program Files', 'EA Games'],
      ['Program Files (x86)', 'EA Games'],
      ['Program Files (x86)', 'Origin Games'],
      ['Program Files', 'Origin Games'],
    ]) {
      pushBottleWinOrPosix(resolveDriveCPathCaseInsensitive(driveCRoot, relSegs));
    }

    return roots;
  }

  const platform = String(opts.platform || process.platform).toLowerCase();
  const sandboxHome =
    typeof opts.homedir === 'string' && opts.homedir.trim() ? opts.homedir.trim() : '';
  const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env;

  if (platform === 'win32') {
    const home = sandboxHome || os.homedir();
    const programFiles = sandboxHome
      ? String(
          opts.programFilesDir ||
            env.ProgramFiles ||
            env.PROGRAMFILES ||
            path.join(sandboxHome, 'Program Files')
        )
      : String(env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files');
    const programFilesX86 = sandboxHome
      ? String(
          opts.programFilesX86Dir ||
            env['ProgramFiles(x86)'] ||
            env['PROGRAMFILES(X86)'] ||
            path.join(sandboxHome, 'Program Files (x86)')
        )
      : String(env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)');
    const programData = sandboxHome
      ? String(
          opts.programDataDir ||
            env.ProgramData ||
            env.PROGRAMDATA ||
            path.join(sandboxHome, 'ProgramData')
        )
      : String(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData');
    const localAppData = sandboxHome
      ? String(opts.localAppDataDir || env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
      : String(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'));
    const roamingAppData = sandboxHome
      ? String(opts.appDataDir || env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : String(env.APPDATA || path.join(home, 'AppData', 'Roaming'));
    const explicitSysDrive = String(
      opts.systemDrive || env.SystemDrive || env.SYSTEMDRIVE || ''
    ).trim();

    const machineDir = extractEaIniDownloadInPlaceDir(
      path.join(programData, 'EA Desktop', 'machine.ini')
    );
    if (machineDir) pushRoot(machineDir);

    const eaDesktopLocal = path.join(localAppData, 'Electronic Arts', 'EA Desktop');
    try {
      if (fs.existsSync(eaDesktopLocal)) {
        const userInis = fs
          .readdirSync(eaDesktopLocal, { withFileTypes: true })
          .filter(
            (d) =>
              d.isFile() &&
              /^user_.+\.ini$/i.test(d.name) &&
              d.name.toLowerCase() !== 'user_unknown.ini'
          )
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const f of userInis) {
          const customDir = extractEaIniDownloadInPlaceDir(path.join(eaDesktopLocal, f.name));
          if (customDir) pushRoot(customDir);
        }
      }
    } catch {}

    const originRoaming = path.join(roamingAppData, 'Origin');
    try {
      if (fs.existsSync(originRoaming)) {
        const originXmls = fs
          .readdirSync(originRoaming, { withFileTypes: true })
          .filter((d) => d.isFile() && /^local(?:_.*)?\.xml$/i.test(d.name))
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const f of originXmls) {
          const originDir = extractOriginXmlDownloadInPlaceDir(path.join(originRoaming, f.name));
          if (originDir) pushRoot(originDir);
        }
      }
    } catch {}

    pushRoot(path.join(programFiles, 'EA Games'));
    pushRoot(path.join(programFilesX86, 'EA Games'));
    pushRoot(path.join(programFilesX86, 'Origin Games'));
    pushRoot(path.join(programFiles, 'Origin Games'));

    if (Array.isArray(opts.mountedDrives)) {
      for (const drv of opts.mountedDrives) {
        const cleanDrv = String(drv || '').trim();
        if (!cleanDrv) continue;
        pushRoot(path.join(cleanDrv, 'EA Games'));
        pushRoot(path.join(cleanDrv, 'Origin Games'));
      }
    }

    if (Array.isArray(opts.customRoots)) {
      for (const cr of opts.customRoots) {
        const cleanCr = String(cr || '').trim();
        if (!cleanCr) continue;
        const baseLower = path.basename(cleanCr).toLowerCase();
        if (baseLower === 'ea games' || baseLower === 'origin games') {
          pushRoot(cleanCr);
        } else {
          pushRoot(path.join(cleanCr, 'EA Games'));
          pushRoot(path.join(cleanCr, 'Origin Games'));
        }
      }
    }

    if (explicitSysDrive && !/^[a-zA-Z]:[\\/]?$/.test(explicitSysDrive)) {
      pushRoot(path.join(explicitSysDrive, 'EA Games'));
      pushRoot(path.join(explicitSysDrive, 'Origin Games'));
    } else if (!sandboxHome && process.platform === 'win32') {
      for (let code = 67 /* 'C' */; code <= 90 /* 'Z' */; code += 1) {
        const driveRoot = `${String.fromCharCode(code)}:\\`;
        try {
          if (fs.existsSync(driveRoot)) {
            pushRoot(`${driveRoot}EA Games`);
            pushRoot(`${driveRoot}Origin Games`);
          }
        } catch {}
      }
    } else if (sandboxHome) {
      pushRoot(path.join(sandboxHome, 'EA Games'));
      pushRoot(path.join(sandboxHome, 'Origin Games'));
    }

    return roots;
  }

  if (platform === 'darwin') {
    const customAppsDir =
      typeof opts.customApplicationsDir === 'string' && opts.customApplicationsDir.trim()
        ? opts.customApplicationsDir.trim()
        : '';
    const isIsolatedSandbox = Boolean(sandboxHome || customAppsDir);
    const home = sandboxHome || os.homedir();

    const macMachineIni = isIsolatedSandbox
      ? sandboxHome
        ? path.join(
            sandboxHome,
            'Library',
            'Application Support',
            'Electronic Arts',
            'EA app',
            'machine.ini'
          )
        : ''
      : '/Library/Application Support/Electronic Arts/EA app/machine.ini';
    const macMachineDir = extractEaIniDownloadInPlaceDir(macMachineIni);
    if (macMachineDir) pushRoot(macMachineDir);

    const macEaAppDir = path.join(home, 'Library', 'Application Support', 'Electronic Arts', 'EA app');
    try {
      if (fs.existsSync(macEaAppDir)) {
        const userInis = fs
          .readdirSync(macEaAppDir, { withFileTypes: true })
          .filter(
            (d) =>
              d.isFile() &&
              /^user_.+\.ini$/i.test(d.name) &&
              d.name.toLowerCase() !== 'user_unknown.ini'
          )
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const f of userInis) {
          const customDir = extractEaIniDownloadInPlaceDir(path.join(macEaAppDir, f.name));
          if (customDir) pushRoot(customDir);
        }
      }
    } catch {}

    pushRoot(path.join(home, 'Applications', 'EA Games'));
    if (!isIsolatedSandbox) {
      pushRoot('/Applications/EA Games');
      pushRoot('/Users/Shared/EA Games');
    } else if (customAppsDir) {
      pushRoot(path.join(customAppsDir, 'EA Games'));
    }
  }

  return roots;
}

/**
 * Extract `misc.game_installation_path` / `game_installation_path` from Ubisoft Connect
 * `settings.yaml` (`175.x` `%LOCALAPPDATA%`) or legacy `settings.yml` (`Program Files (x86)`).
 *
 * @param {string} ubiDir
 * @returns {string}
 */
function readUbisoftCustomGamesDirSetting(ubiDir) {
  if (!ubiDir) return '';
  for (const name of ['settings.yaml', 'settings.yml']) {
    const p = resolveDriveCPathCaseInsensitive(ubiDir, [name]);
    try {
      if (!p || !fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      const m = text.match(/^\s*(?:misc\.)?game_installation_path\s*:\s*(.+)$/im);
      if (m && m[1]) {
        const val = m[1]
          .replace(/\s+#.*$/, '')
          .trim()
          .replace(/^["']+|["']+$/g, '');
        if (val && val.toLowerCase() !== 'null' && val !== '~') {
          return val;
        }
      }
    } catch {}
  }
  return '';
}

/**
 * Extract `Client.Install.DefaultInstallPath` from a Battle.net `Battle.net.config` JSON file.
 *
 * @param {string} configFilePath
 * @returns {string}
 */
function readBattleNetDefaultInstallPathFromConfig(configFilePath) {
  if (!configFilePath) return '';
  try {
    if (!fs.existsSync(configFilePath)) return '';
    const parsed = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    const raw =
      parsed?.Client?.Install?.DefaultInstallPath ??
      parsed?.Client?.Install?.defaultInstallPath ??
      '';
    if (typeof raw === 'string') {
      const clean = raw.trim().replace(/^["']+|["']+$/g, '');
      if (clean && clean.toLowerCase() !== 'null') {
        return clean;
      }
    }
  } catch {}
  return '';
}

/**
 * Read and parse Battle.net Agent `product.db` strictly read-only (`<= 16 MiB`).
 *
 * @param {string} productDbPath
 * @returns {BattleNetProductDbInstallEntry[]}
 */
function readBattleNetProductDbFileReadOnly(productDbPath) {
  if (!productDbPath) return [];
  try {
    if (!fs.existsSync(productDbPath)) return [];
    const st = fs.statSync(productDbPath);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_BATTLE_NET_PRODUCT_DB_BYTES) {
      return [];
    }
    const buf = fs.readFileSync(productDbPath);
    return parseBattleNetProductDbBuffer(buf);
  } catch {
    return [];
  }
}

/**
 * Extract Battle.net NGDP TACT product UID from `.build.info` or `UninstallString` if available.
 *
 * @param {string} installDir
 * @param {string} [uninstallString]
 * @returns {string}
 */
function extractBattleNetProductId(installDir, uninstallString = '') {
  if (uninstallString) {
    const uidMatch = uninstallString.match(/--uid=([A-Za-z0-9_.-]+)/i);
    if (uidMatch && uidMatch[1]) {
      return uidMatch[1].trim();
    }
  }
  if (!installDir) return '';
  const buildInfoPath = path.join(installDir, '.build.info');
  try {
    if (fs.existsSync(buildInfoPath)) {
      const lines = fs.readFileSync(buildInfoPath, 'utf8').split(/\r?\n/).filter(Boolean);
      if (lines.length >= 2) {
        const headers = lines[0].split('|').map((h) => h.split('!')[0].trim().toLowerCase());
        const prodIdx = headers.indexOf('product');
        if (prodIdx >= 0) {
          const cols = lines[1].split('|');
          if (cols[prodIdx] && cols[prodIdx].trim()) {
            return cols[prodIdx].trim();
          }
        }
      }
    }
  } catch {}
  return '';
}

/**
 * Extract `product_install_full_path` from Riot `*.product_settings.yaml`.
 *
 * @param {string} yamlText
 * @returns {string}
 */
function parseRiotProductInstallFullPath(yamlText) {
  if (!yamlText || typeof yamlText !== 'string') return '';
  const match = yamlText.match(/^\s*product_install_full_path\s*:\s*(.+)$/im);
  if (!match || !match[1]) return '';
  return match[1].trim().replace(/^["']+|["']+$/g, '');
}

/**
 * Scan a macOS Wine/CrossOver bottle for installed games managed by chained publisher launchers
 * (`ubisoft`, `ea`, `bnet`, `rockstar`). Strictly read-only (`0` disk writes).
 *
 * @param {string} bottlePath
 * @param {Record<string, any>} [options]
 * @returns {ScannedPublisherInstalledGame[]}
 */
function scanBottlePublisherInstalledGames(bottlePath, options = {}) {
  if (!bottlePath) return [];
  const driveCRoot = path.join(bottlePath, 'drive_c');
  try {
    if (!fs.existsSync(driveCRoot)) return [];
  } catch {
    return [];
  }

  const bottleName =
    typeof options.bottleName === 'string' && options.bottleName.trim()
      ? options.bottleName.trim()
      : path.basename(bottlePath);

  const sections = getBottleSystemRegSections(bottlePath, options);
  const bottleUserDirs = listBottleUserDirectories(bottlePath);
  /** @type {ScannedPublisherInstalledGame[]} */
  const discovered = [];
  /** @type {Set<string>} */
  const seenKeys = new Set();

  /**
   * @param {ChainedHandoffId} handoffId
   * @param {string} rawInstallPath
   * @param {{ externalInstallId?: string, tactUid?: string, launchProductCode?: string, title?: string, exeHint?: string }} [meta]
   */
  const tryAddBottleGame = (handoffId, rawInstallPath, meta = {}) => {
    if (!rawInstallPath || STEAMAPPS_COMMON_PATH_RE.test(rawInstallPath)) return;
    const hostInstallPath = rawInstallPath.startsWith('/')
      ? resolveWineReparseTargetReadOnly(rawInstallPath, driveCRoot, options)
      : resolveBottleWindowsPathReadOnly(rawInstallPath, bottlePath, options);
    if (!hostInstallPath || STEAMAPPS_COMMON_PATH_RE.test(hostInstallPath)) return;
    let resolvedInstallPath = hostInstallPath;
    try {
      if (!fs.existsSync(hostInstallPath)) return;
      if (!fs.statSync(hostInstallPath).isDirectory()) return;
      resolvedInstallPath = path.resolve(hostInstallPath);
    } catch {
      return;
    }
    if (STEAMAPPS_COMMON_PATH_RE.test(resolvedInstallPath)) return;

    const dedupeKey = `${handoffId}::${resolvedInstallPath.toLowerCase()}`;
    if (seenKeys.has(dedupeKey)) return;

    const exeHintHost =
      meta.exeHint && !meta.exeHint.startsWith('/') && /^[a-zA-Z]:[\\/]/.test(meta.exeHint)
        ? resolveBottleWindowsPathReadOnly(meta.exeHint, bottlePath, options)
        : meta.exeHint || '';
    const { executablePath, approxSizeBytes } = findPrimaryPublisherGameExecutable(
      hostInstallPath,
      exeHintHost
    );
    if (!executablePath) return;

    seenKeys.add(dedupeKey);
    const title = (meta.title || '').trim() || path.basename(hostInstallPath);
    const cleanExternal = meta.externalInstallId ? String(meta.externalInstallId).trim() : '';
    const cleanTactUid = meta.tactUid
      ? String(meta.tactUid).trim()
      : handoffId === 'bnet' && cleanExternal
        ? cleanExternal
        : '';
    const cleanLaunchCode = meta.launchProductCode
      ? String(meta.launchProductCode).trim()
      : handoffId === 'bnet' && (cleanExternal || cleanTactUid)
        ? normalizeBattleNetLaunchProductCode(cleanExternal || cleanTactUid)
        : '';

    discovered.push({
      handoffId,
      ...(cleanExternal ? { externalInstallId: cleanExternal } : {}),
      ...(cleanTactUid ? { tactUid: cleanTactUid } : {}),
      ...(cleanLaunchCode ? { launchProductCode: cleanLaunchCode } : {}),
      title,
      installPath: hostInstallPath,
      executablePath,
      ...(approxSizeBytes > 0 ? { installSizeBytes: approxSizeBytes } : {}),
      bottlePath,
      bottleName,
    });
  };

  // Pre-parse Battle.net Agent `product.db` inside bottle so custom install paths & UIDs are indexed
  const bottleProductDbPath = resolveDriveCPathCaseInsensitive(driveCRoot, [
    'ProgramData',
    'Battle.net',
    'Agent',
    'product.db',
  ]);
  const bottleProductDbEntries = readBattleNetProductDbFileReadOnly(bottleProductDbPath);
  /** @type {Map<string, BattleNetProductDbInstallEntry>} */
  const bnetDbByResolvedPath = new Map();
  for (const dbEntry of bottleProductDbEntries) {
    if (dbEntry.hasCachedState && !dbEntry.installed && !dbEntry.playable) continue;
    if (!dbEntry.installPath) continue;
    const hostDbDir = dbEntry.installPath.startsWith('/')
      ? resolveWineReparseTargetReadOnly(dbEntry.installPath, driveCRoot, options)
      : resolveBottleWindowsPathReadOnly(dbEntry.installPath, bottlePath, options);
    if (hostDbDir) {
      bnetDbByResolvedPath.set(path.resolve(hostDbDir).toLowerCase(), dbEntry);
    }
  }

  // 1. Ubisoft Connect: registry Installs + Uninstall + settings.yaml/settings.yml + games/* directories
  /** @type {Map<string, { installDir?: string, title?: string, iconExe?: string }>} */
  const ubiById = new Map();
  for (const [secKey, props] of sections.entries()) {
    const installMatch = secKey.match(
      /^software\\(?:wow6432node\\)?ubisoft\\launcher\\installs\\([^\\]+)$/i
    );
    if (installMatch && installMatch[1]) {
      const uplayId = installMatch[1].trim();
      const entry = ubiById.get(uplayId) || {};
      const dir = getRegistryPropCaseInsensitive(props, 'InstallDir');
      if (dir) entry.installDir = dir;
      ubiById.set(uplayId, entry);
      continue;
    }
    const uninstMatch = secKey.match(
      /^software\\(?:wow6432node\\)?microsoft\\windows\\currentversion\\uninstall\\uplay install\s+(.+)$/i
    );
    if (uninstMatch && uninstMatch[1]) {
      const uplayId = uninstMatch[1].trim();
      const entry = ubiById.get(uplayId) || {};
      const loc = getRegistryPropCaseInsensitive(props, 'InstallLocation');
      const dispName = getRegistryPropCaseInsensitive(props, 'DisplayName');
      const dispIcon = getRegistryPropCaseInsensitive(props, 'DisplayIcon');
      if (loc && !entry.installDir) entry.installDir = loc;
      if (dispName) entry.title = dispName;
      if (dispIcon) entry.iconExe = dispIcon;
      ubiById.set(uplayId, entry);
    }
  }
  for (const [uplayId, info] of ubiById.entries()) {
    if (info.installDir) {
      tryAddBottleGame('ubisoft', info.installDir, {
        externalInstallId: uplayId,
        title: info.title,
        exeHint: info.iconExe,
      });
    }
  }

  const ubiLegacyDirX86 = resolveDriveCPathCaseInsensitive(driveCRoot, [
    'Program Files (x86)',
    'Ubisoft',
    'Ubisoft Game Launcher',
  ]);
  const ubiLegacyDirX64 = resolveDriveCPathCaseInsensitive(driveCRoot, [
    'Program Files',
    'Ubisoft',
    'Ubisoft Game Launcher',
  ]);
  /** @type {string[]} */
  const ubiGamesRoots = [
    resolveDriveCPathCaseInsensitive(ubiLegacyDirX86, ['games']),
    resolveDriveCPathCaseInsensitive(ubiLegacyDirX64, ['games']),
  ];
  const ubiLauncherInfo = discoverBottlePublisherLauncher(bottlePath, 'ubisoft', {
    parsedSystemReg: sections,
  });
  if (ubiLauncherInfo.installDir) {
    ubiGamesRoots.push(resolveDriveCPathCaseInsensitive(ubiLauncherInfo.installDir, ['games']));
  }
  for (const ubiConfigDir of [
    ...bottleUserDirs.map((u) =>
      resolveDriveCPathCaseInsensitive(u, ['AppData', 'Local', 'Ubisoft Game Launcher'])
    ),
    ubiLauncherInfo.installDir || '',
    ubiLegacyDirX86,
    ubiLegacyDirX64,
  ]) {
    if (!ubiConfigDir) continue;
    const customWinDir = readUbisoftCustomGamesDirSetting(ubiConfigDir);
    if (customWinDir) {
      const hostCustomDir = customWinDir.startsWith('/')
        ? resolveWineReparseTargetReadOnly(customWinDir, driveCRoot, options)
        : resolveBottleWindowsPathReadOnly(customWinDir, bottlePath, options);
      if (hostCustomDir) ubiGamesRoots.push(hostCustomDir);
    }
  }
  for (const rawGamesRoot of ubiGamesRoots) {
    try {
      const gamesRoot = resolveWineReparseTargetReadOnly(rawGamesRoot, driveCRoot, options);
      if (!gamesRoot || !fs.existsSync(gamesRoot)) continue;
      const subdirs = fs.readdirSync(gamesRoot, { withFileTypes: true });
      for (const sub of subdirs) {
        const rawGameDir = path.join(gamesRoot, sub.name);
        const gameDir = resolveWineReparseTargetReadOnly(rawGameDir, driveCRoot, options);
        if (!sub.name || sub.name.startsWith('.')) continue;
        if (!sub.isDirectory() && gameDir === rawGameDir) continue;
        tryAddBottleGame('ubisoft', gameDir, { title: sub.name.replace(/\?$/, '') });
      }
    } catch {}
  }

  // 2. EA App: configured EA/Origin library roots (`machine.ini` + `user_*.ini`) + EA/Origin registry + Uninstall sections
  const eaRoots = readEaConfiguredLibraryRoots({ ...options, bottlePath });
  for (const rawEaRoot of eaRoots) {
    try {
      const eaRoot = resolveWineReparseTargetReadOnly(rawEaRoot, driveCRoot, options);
      if (!eaRoot || !fs.existsSync(eaRoot)) continue;
      for (const sub of fs.readdirSync(eaRoot, { withFileTypes: true })) {
        const rawGameDir = path.join(eaRoot, sub.name);
        const gameDir = resolveWineReparseTargetReadOnly(rawGameDir, driveCRoot, options);
        if (!sub.name || sub.name.startsWith('.')) continue;
        if (!sub.isDirectory() && gameDir === rawGameDir) continue;
        const cleanTitle = sub.name.replace(/\?$/, '');
        const xmlPath = resolveDriveCPathCaseInsensitive(gameDir, [
          '__Installer',
          'installerdata.xml',
        ]);
        let contentId = '';
        let xmlTitle = '';
        let launcherRelExe = '';
        if (fs.existsSync(xmlPath)) {
          try {
            const parsedXml = parseEaInstallerDataXml(fs.readFileSync(xmlPath, 'utf8'), gameDir);
            contentId = parsedXml.contentId;
            xmlTitle = parsedXml.title;
            launcherRelExe = parsedXml.launcherRelExe;
          } catch {}
        }
        tryAddBottleGame('ea', gameDir, {
          externalInstallId: contentId || undefined,
          title: xmlTitle || cleanTitle,
          exeHint: launcherRelExe,
        });
      }
    } catch {}
  }

  // EA Games / Origin Games registry subkeys (`[Software\Wow6432Node\EA Games\*]` -> `Install Dir`)
  for (const [secKey, props] of sections.entries()) {
    const eaRegMatch = secKey.match(
      /^software\\(?:wow6432node\\)?(?:ea games|origin games)\\([^\\]+)$/i
    );
    if (!eaRegMatch || !eaRegMatch[1]) continue;
    const rawEaDir =
      getRegistryPropCaseInsensitive(props, 'Install Dir') ||
      getRegistryPropCaseInsensitive(props, 'InstallLocation');
    if (!rawEaDir) continue;
    const hostEaDir = resolveBottleWindowsPathReadOnly(rawEaDir, bottlePath, options);
    if (!hostEaDir || !fs.existsSync(hostEaDir)) continue;
    const xmlPath = resolveDriveCPathCaseInsensitive(hostEaDir, [
      '__Installer',
      'installerdata.xml',
    ]);
    let parsedXml = { contentId: '', title: '', launcherRelExe: '' };
    if (fs.existsSync(xmlPath)) {
      try {
        parsedXml = parseEaInstallerDataXml(fs.readFileSync(xmlPath, 'utf8'), hostEaDir);
      } catch {}
    }
    const dispName = getRegistryPropCaseInsensitive(props, 'DisplayName');
    tryAddBottleGame('ea', hostEaDir, {
      externalInstallId: parsedXml.contentId || undefined,
      title: dispName || parsedXml.title || eaRegMatch[1].trim(),
      exeHint: parsedXml.launcherRelExe,
    });
  }

  // Also check Uninstall registry entries in bottle for custom-path EA, Battle.net, & Rockstar installs
  for (const [secKey, props] of sections.entries()) {
    if (
      !/^software\\(?:wow6432node\\)?microsoft\\windows\\currentversion\\uninstall\\[^\\]+$/i.test(
        secKey
      )
    ) {
      continue;
    }
    const subKeyName = secKey.split('\\').pop() || '';
    if (subKeyName === 'battle.net' || subKeyName.startsWith('uplay install ')) continue;

    const installLoc = getRegistryPropCaseInsensitive(props, 'InstallLocation');
    if (!installLoc) continue;
    const dispName = getRegistryPropCaseInsensitive(props, 'DisplayName');
    const publisher = getRegistryPropCaseInsensitive(props, 'Publisher');
    const uninstStr = getRegistryPropCaseInsensitive(props, 'UninstallString');
    const dispIcon = getRegistryPropCaseInsensitive(props, 'DisplayIcon');

    const hostLoc = resolveBottleWindowsPathReadOnly(installLoc, bottlePath, options);
    if (!hostLoc || !fs.existsSync(hostLoc)) continue;

    // Check EA installerdata.xml (excluding EA App client itself)
    if (!/^ea\s+(?:app|desktop)$/i.test(dispName)) {
      const eaXml = resolveDriveCPathCaseInsensitive(hostLoc, ['__Installer', 'installerdata.xml']);
      if (fs.existsSync(eaXml)) {
        let parsedXml = { contentId: '', title: '', launcherRelExe: '' };
        try {
          parsedXml = parseEaInstallerDataXml(fs.readFileSync(eaXml, 'utf8'), hostLoc);
        } catch {}
        tryAddBottleGame('ea', hostLoc, {
          externalInstallId: parsedXml.contentId || undefined,
          title: dispName || parsedXml.title,
          exeHint: parsedXml.launcherRelExe || dispIcon,
        });
        continue;
      }
    }

    // Check Battle.net / Blizzard Uninstall entry
    const matchedDbEntry = bnetDbByResolvedPath.get(path.resolve(hostLoc).toLowerCase());
    if (
      matchedDbEntry ||
      /blizzard|battle\.net/i.test(publisher) ||
      /battle\.net|blizzard/i.test(uninstStr) ||
      fs.existsSync(path.join(hostLoc, '.build.info'))
    ) {
      if (/^battle\.net$/i.test(dispName)) continue;
      const bnetId =
        extractBattleNetProductId(hostLoc, uninstStr) ||
        matchedDbEntry?.uid ||
        matchedDbEntry?.productCode ||
        '';
      tryAddBottleGame('bnet', hostLoc, {
        externalInstallId: bnetId || undefined,
        tactUid: matchedDbEntry?.uid || bnetId || undefined,
        launchProductCode:
          matchedDbEntry?.launchProductCode ||
          (bnetId ? normalizeBattleNetLaunchProductCode(bnetId) : undefined),
        title: dispName,
        exeHint: dispIcon,
      });
      continue;
    }

    // Check Rockstar Games Uninstall entry (excluding Launcher & Social Club)
    if (/rockstar games/i.test(publisher) || /^rockstar games\s+/i.test(subKeyName)) {
      if (
        /^(?:rockstar games\s+)?(?:launcher|social club)$/i.test(dispName) ||
        /^rockstar games\s+(?:launcher|social club)$/i.test(subKeyName)
      ) {
        continue;
      }
      tryAddBottleGame('rockstar', hostLoc, {
        title: dispName || subKeyName.replace(/^rockstar games\s+/i, ''),
        exeHint: dispIcon,
      });
    }
  }

  // 3. Battle.net `product.db` + `Battle.net.config` (`DefaultInstallPath`) + Program Files `.build.info`
  for (const dbEntry of bottleProductDbEntries) {
    if (dbEntry.hasCachedState && !dbEntry.installed && !dbEntry.playable) continue;
    if (!dbEntry.installPath) continue;
    const rawUid = dbEntry.uid || dbEntry.productCode;
    tryAddBottleGame('bnet', dbEntry.installPath, {
      externalInstallId: rawUid || undefined,
      tactUid: dbEntry.uid || rawUid || undefined,
      launchProductCode:
        dbEntry.launchProductCode ||
        (rawUid ? normalizeBattleNetLaunchProductCode(rawUid) : undefined),
    });
  }

  /** @type {string[]} */
  const bnetParentScanRoots = [
    resolveDriveCPathCaseInsensitive(driveCRoot, ['Program Files (x86)']),
    resolveDriveCPathCaseInsensitive(driveCRoot, ['Program Files']),
  ];
  for (const userDir of bottleUserDirs) {
    const bnetCfgPath = resolveDriveCPathCaseInsensitive(userDir, [
      'AppData',
      'Roaming',
      'Battle.net',
      'Battle.net.config',
    ]);
    const defaultInstallWin = readBattleNetDefaultInstallPathFromConfig(bnetCfgPath);
    if (defaultInstallWin) {
      const hostDefDir = defaultInstallWin.startsWith('/')
        ? resolveWineReparseTargetReadOnly(defaultInstallWin, driveCRoot, options)
        : resolveBottleWindowsPathReadOnly(defaultInstallWin, bottlePath, options);
      if (hostDefDir) bnetParentScanRoots.push(hostDefDir);
    }
  }

  for (const progDir of bnetParentScanRoots) {
    try {
      if (!progDir || !fs.existsSync(progDir)) continue;
      if (
        fs.existsSync(path.join(progDir, '.build.info')) &&
        path.basename(progDir).toLowerCase() !== 'battle.net'
      ) {
        const directBnetId = extractBattleNetProductId(progDir);
        tryAddBottleGame('bnet', progDir, {
          externalInstallId: directBnetId || undefined,
          tactUid: directBnetId || undefined,
          launchProductCode: directBnetId
            ? normalizeBattleNetLaunchProductCode(directBnetId)
            : undefined,
          title: path.basename(progDir),
        });
      }
      for (const sub of fs.readdirSync(progDir, { withFileTypes: true })) {
        if (!sub.name || sub.name.startsWith('.')) continue;
        if (sub.name.toLowerCase() === 'battle.net') continue;
        const rawCandidateDir = path.join(progDir, sub.name);
        const candidateDir = resolveWineReparseTargetReadOnly(rawCandidateDir, driveCRoot, options);
        if (!sub.isDirectory() && candidateDir === rawCandidateDir) continue;
        if (fs.existsSync(path.join(candidateDir, '.build.info'))) {
          const bnetId = extractBattleNetProductId(candidateDir);
          tryAddBottleGame('bnet', candidateDir, {
            externalInstallId: bnetId || undefined,
            tactUid: bnetId || undefined,
            launchProductCode: bnetId ? normalizeBattleNetLaunchProductCode(bnetId) : undefined,
            title: sub.name.replace(/\?$/, ''),
          });
        }
      }
    } catch {}
  }

  // 4. Rockstar Games: [Software\Wow6432Node\Rockstar Games\*] (`InstallFolder`) + Program Files fallback
  for (const [secKey, props] of sections.entries()) {
    const rockstarMatch = secKey.match(
      /^software\\(?:wow6432node\\)?rockstar games\\([^\\]+)$/i
    );
    if (!rockstarMatch || !rockstarMatch[1]) continue;
    const subKey = rockstarMatch[1].trim();
    const subLower = subKey.toLowerCase();
    if (subLower === 'launcher' || subLower === 'social club') continue;
    const installFolder =
      getRegistryPropCaseInsensitive(props, 'InstallFolder') ||
      getRegistryPropCaseInsensitive(props, 'InstallLocation');
    if (!installFolder) continue;
    tryAddBottleGame('rockstar', installFolder, {
      title: getRegistryPropCaseInsensitive(props, 'Title') || subKey,
    });
  }
  for (const progFolder of ['Program Files', 'Program Files (x86)']) {
    const rockstarRoot = resolveDriveCPathCaseInsensitive(driveCRoot, [
      progFolder,
      'Rockstar Games',
    ]);
    try {
      if (!rockstarRoot || !fs.existsSync(rockstarRoot)) continue;
      for (const sub of fs.readdirSync(rockstarRoot, { withFileTypes: true })) {
        if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
        const lower = sub.name.toLowerCase();
        if (lower === 'launcher' || lower === 'social club') continue;
        tryAddBottleGame('rockstar', path.join(rockstarRoot, sub.name), { title: sub.name });
      }
    } catch {}
  }

  return discovered;
}

/**
 * Scan the host OS (`win32` or `darwin`) for installed games managed by chained publisher launchers
 * (`ubisoft`, `ea`, `bnet`, `rockstar`, `riot`). Strictly read-only (`0` disk writes).
 *
 * @param {Record<string, any>} [options]
 * @returns {ScannedPublisherInstalledGame[]}
 */
function scanHostPublisherInstalledGames(options = {}) {
  const platform = String(options.platform || process.platform).toLowerCase();
  /** @type {ScannedPublisherInstalledGame[]} */
  const discovered = [];
  /** @type {Set<string>} */
  const seenKeys = new Set();

  const sandboxHome =
    typeof options.homedir === 'string' && options.homedir.trim() ? options.homedir.trim() : '';
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;

  /**
   * @param {ChainedHandoffId} handoffId
   * @param {string} rawInstallPath
   * @param {{ externalInstallId?: string, tactUid?: string, launchProductCode?: string, title?: string, exeHint?: string, allowMacAppBundles?: boolean }} [meta]
   */
  const tryAddHostGame = (handoffId, rawInstallPath, meta = {}) => {
    const cleanPath = String(rawInstallPath || '')
      .trim()
      .replace(/^"+|"+$/g, '');
    if (!cleanPath || STEAMAPPS_COMMON_PATH_RE.test(cleanPath)) return;
    let resolvedPath = cleanPath;
    try {
      if (!fs.existsSync(cleanPath)) return;
      if (!fs.statSync(cleanPath).isDirectory()) return;
      resolvedPath = path.resolve(cleanPath);
    } catch {
      return;
    }
    if (STEAMAPPS_COMMON_PATH_RE.test(resolvedPath)) return;

    const dedupeKey = `${handoffId}::${resolvedPath.toLowerCase()}`;
    if (seenKeys.has(dedupeKey)) return;

    const { executablePath, approxSizeBytes } = findPrimaryPublisherGameExecutable(
      cleanPath,
      meta.exeHint || '',
      { allowMacAppBundles: Boolean(meta.allowMacAppBundles) }
    );
    if (!executablePath) return;

    seenKeys.add(dedupeKey);
    const title = (meta.title || '').trim() || path.basename(cleanPath);
    const cleanExternal = meta.externalInstallId ? String(meta.externalInstallId).trim() : '';
    const cleanTactUid = meta.tactUid
      ? String(meta.tactUid).trim()
      : handoffId === 'bnet' && cleanExternal
        ? cleanExternal
        : '';
    const cleanLaunchCode = meta.launchProductCode
      ? String(meta.launchProductCode).trim()
      : handoffId === 'bnet' && (cleanExternal || cleanTactUid)
        ? normalizeBattleNetLaunchProductCode(cleanExternal || cleanTactUid)
        : '';

    discovered.push({
      handoffId,
      ...(cleanExternal ? { externalInstallId: cleanExternal } : {}),
      ...(cleanTactUid ? { tactUid: cleanTactUid } : {}),
      ...(cleanLaunchCode ? { launchProductCode: cleanLaunchCode } : {}),
      title,
      installPath: cleanPath,
      executablePath,
      ...(approxSizeBytes > 0 ? { installSizeBytes: approxSizeBytes } : {}),
    });
  };

  if (platform === 'win32') {
    const programFiles = sandboxHome
      ? String(
          options.programFilesDir ||
            env.ProgramFiles ||
            env.PROGRAMFILES ||
            path.join(sandboxHome, 'Program Files')
        )
      : String(env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files');
    const programFilesX86 = sandboxHome
      ? String(
          options.programFilesX86Dir ||
            env['ProgramFiles(x86)'] ||
            env['PROGRAMFILES(X86)'] ||
            path.join(sandboxHome, 'Program Files (x86)')
        )
      : String(env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)');
    const programData = sandboxHome
      ? String(
          options.programDataDir ||
            env.ProgramData ||
            env.PROGRAMDATA ||
            path.join(sandboxHome, 'ProgramData')
        )
      : String(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData');
    const localAppData = sandboxHome
      ? String(options.localAppDataDir || env.LOCALAPPDATA || path.join(sandboxHome, 'AppData', 'Local'))
      : String(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));
    const roamingAppData = sandboxHome
      ? String(options.appDataDir || env.APPDATA || path.join(sandboxHome, 'AppData', 'Roaming'))
      : String(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'));

    const hostProductDbEntries = readBattleNetProductDbFileReadOnly(
      path.join(programData, 'Battle.net', 'Agent', 'product.db')
    );
    /** @type {Map<string, BattleNetProductDbInstallEntry>} */
    const hostBnetDbByPath = new Map();
    for (const dbEntry of hostProductDbEntries) {
      if (dbEntry.hasCachedState && !dbEntry.installed && !dbEntry.playable) continue;
      if (dbEntry.installPath) {
        hostBnetDbByPath.set(path.resolve(dbEntry.installPath).toLowerCase(), dbEntry);
      }
    }

    // Single batched registry subkey enumeration across Ubisoft, EA/Origin, Rockstar, and Uninstall keys
    const subkeys = enumerateWindowsRegistrySubkeys(
      [
        'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs',
        'HKLM\\SOFTWARE\\Ubisoft\\Launcher\\Installs',
        'HKLM\\SOFTWARE\\WOW6432Node\\EA Games',
        'HKLM\\SOFTWARE\\EA Games',
        'HKLM\\SOFTWARE\\WOW6432Node\\Origin Games',
        'HKLM\\SOFTWARE\\Origin Games',
        'HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games',
        'HKLM\\SOFTWARE\\Rockstar Games',
        'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      ],
      options
    );

    /** @type {Map<string, { installDir?: string, title?: string, iconExe?: string }>} */
    const ubiById = new Map();

    for (const item of subkeys) {
      const fullLower = item.fullKeyPath.toLowerCase();
      const keyLower = item.keyName.toLowerCase();

      if (fullLower.includes('\\ubisoft\\launcher\\installs\\')) {
        const uplayId = item.keyName.trim();
        const entry = ubiById.get(uplayId) || {};
        const dir = getRegistryPropCaseInsensitive(item.properties, 'InstallDir');
        if (dir) entry.installDir = dir;
        ubiById.set(uplayId, entry);
        continue;
      }

      if (
        (fullLower.includes('\\ea games\\') || fullLower.includes('\\origin games\\')) &&
        !fullLower.includes('\\currentversion\\uninstall\\')
      ) {
        const eaDir =
          getRegistryPropCaseInsensitive(item.properties, 'Install Dir') ||
          getRegistryPropCaseInsensitive(item.properties, 'InstallLocation');
        if (eaDir) {
          const eaXml = path.join(eaDir, '__Installer', 'installerdata.xml');
          let parsedXml = { contentId: '', title: '', launcherRelExe: '' };
          if (fs.existsSync(eaXml)) {
            try {
              parsedXml = parseEaInstallerDataXml(fs.readFileSync(eaXml, 'utf8'), eaDir);
            } catch {}
          }
          const dispName = getRegistryPropCaseInsensitive(item.properties, 'DisplayName');
          tryAddHostGame('ea', eaDir, {
            externalInstallId: parsedXml.contentId || undefined,
            title: dispName || parsedXml.title || item.keyName,
            exeHint: parsedXml.launcherRelExe,
          });
        }
        continue;
      }

      if (
        fullLower.includes('\\rockstar games\\') &&
        !fullLower.includes('\\currentversion\\uninstall\\')
      ) {
        if (keyLower === 'launcher' || keyLower === 'social club') continue;
        const installFolder =
          getRegistryPropCaseInsensitive(item.properties, 'InstallFolder') ||
          getRegistryPropCaseInsensitive(item.properties, 'InstallLocation');
        if (installFolder) {
          tryAddHostGame('rockstar', installFolder, {
            title: getRegistryPropCaseInsensitive(item.properties, 'Title') || item.keyName,
          });
        }
        continue;
      }

      if (fullLower.includes('\\currentversion\\uninstall\\')) {
        if (keyLower.startsWith('uplay install ')) {
          const uplayId = item.keyName.slice('uplay install '.length).trim();
          const entry = ubiById.get(uplayId) || {};
          const loc = getRegistryPropCaseInsensitive(item.properties, 'InstallLocation');
          const dispName = getRegistryPropCaseInsensitive(item.properties, 'DisplayName');
          const dispIcon = getRegistryPropCaseInsensitive(item.properties, 'DisplayIcon');
          if (loc && !entry.installDir) entry.installDir = loc;
          if (dispName) entry.title = dispName;
          if (dispIcon) entry.iconExe = dispIcon;
          ubiById.set(uplayId, entry);
          continue;
        }

        if (keyLower === 'battle.net') continue;
        const installLoc = getRegistryPropCaseInsensitive(item.properties, 'InstallLocation');
        if (!installLoc) continue;
        const dispName = getRegistryPropCaseInsensitive(item.properties, 'DisplayName');
        const publisher = getRegistryPropCaseInsensitive(item.properties, 'Publisher');
        const uninstStr = getRegistryPropCaseInsensitive(item.properties, 'UninstallString');
        const dispIcon = getRegistryPropCaseInsensitive(item.properties, 'DisplayIcon');

        if (!/^ea\s+(?:app|desktop)$/i.test(dispName)) {
          const eaXml = path.join(installLoc, '__Installer', 'installerdata.xml');
          if (fs.existsSync(eaXml)) {
            let parsedXml = { contentId: '', title: '', launcherRelExe: '' };
            try {
              parsedXml = parseEaInstallerDataXml(fs.readFileSync(eaXml, 'utf8'), installLoc);
            } catch {}
            tryAddHostGame('ea', installLoc, {
              externalInstallId: parsedXml.contentId || undefined,
              title: dispName || parsedXml.title,
              exeHint: parsedXml.launcherRelExe || dispIcon,
            });
            continue;
          }
        }

        const matchedHostDb = hostBnetDbByPath.get(path.resolve(installLoc).toLowerCase());
        if (
          matchedHostDb ||
          /blizzard|battle\.net/i.test(publisher) ||
          /battle\.net|blizzard/i.test(uninstStr) ||
          fs.existsSync(path.join(installLoc, '.build.info'))
        ) {
          if (/^battle\.net$/i.test(dispName)) continue;
          const bnetId =
            extractBattleNetProductId(installLoc, uninstStr) ||
            matchedHostDb?.uid ||
            matchedHostDb?.productCode ||
            '';
          tryAddHostGame('bnet', installLoc, {
            externalInstallId: bnetId || undefined,
            tactUid: matchedHostDb?.uid || bnetId || undefined,
            launchProductCode:
              matchedHostDb?.launchProductCode ||
              (bnetId ? normalizeBattleNetLaunchProductCode(bnetId) : undefined),
            title: dispName,
            exeHint: dispIcon,
          });
          continue;
        }

        if (/rockstar games/i.test(publisher) || /^rockstar games\s+/i.test(keyLower)) {
          if (
            /^(?:rockstar games\s+)?(?:launcher|social club)$/i.test(dispName) ||
            /^rockstar games\s+(?:launcher|social club)$/i.test(keyLower)
          ) {
            continue;
          }
          tryAddHostGame('rockstar', installLoc, {
            title: dispName || item.keyName.replace(/^rockstar games\s+/i, ''),
            exeHint: dispIcon,
          });
        }
      }
    }

    for (const [uplayId, info] of ubiById.entries()) {
      if (info.installDir) {
        tryAddHostGame('ubisoft', info.installDir, {
          externalInstallId: uplayId,
          title: info.title,
          exeHint: info.iconExe,
        });
      }
    }

    // Ubisoft filesystem fallback: games/ directory + settings.yaml (`175.x`) + legacy settings.yml
    const ubiHostInfo = discoverWindowsPublisherLauncherPaths('ubisoft', options);
    const ubiGamesDirs = [
      ubiHostInfo.installDir ? path.join(ubiHostInfo.installDir, 'games') : '',
      path.join(programFilesX86, 'Ubisoft', 'Ubisoft Game Launcher', 'games'),
      path.join(programFiles, 'Ubisoft', 'Ubisoft Game Launcher', 'games'),
      readUbisoftCustomGamesDirSetting(path.join(localAppData, 'Ubisoft Game Launcher')),
      ubiHostInfo.installDir ? readUbisoftCustomGamesDirSetting(ubiHostInfo.installDir) : '',
      readUbisoftCustomGamesDirSetting(
        path.join(programFilesX86, 'Ubisoft', 'Ubisoft Game Launcher')
      ),
      readUbisoftCustomGamesDirSetting(path.join(programFiles, 'Ubisoft', 'Ubisoft Game Launcher')),
    ].filter(Boolean);

    for (const gamesDir of ubiGamesDirs) {
      try {
        if (!fs.existsSync(gamesDir)) continue;
        for (const sub of fs.readdirSync(gamesDir, { withFileTypes: true })) {
          if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
          tryAddHostGame('ubisoft', path.join(gamesDir, sub.name), { title: sub.name });
        }
      } catch {}
    }

    // EA filesystem fallback across configured roots (`machine.ini` + `user_*.ini`), Origin Games, and multi-drive EA Games
    for (const eaRoot of readEaConfiguredLibraryRoots({ ...options, platform: 'win32' })) {
      try {
        if (!fs.existsSync(eaRoot)) continue;
        for (const sub of fs.readdirSync(eaRoot, { withFileTypes: true })) {
          if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
          const gameDir = path.join(eaRoot, sub.name);
          const xmlPath = path.join(gameDir, '__Installer', 'installerdata.xml');
          let parsedXml = { contentId: '', title: '', launcherRelExe: '' };
          if (fs.existsSync(xmlPath)) {
            try {
              parsedXml = parseEaInstallerDataXml(fs.readFileSync(xmlPath, 'utf8'), gameDir);
            } catch {}
          }
          tryAddHostGame('ea', gameDir, {
            externalInstallId: parsedXml.contentId || undefined,
            title: parsedXml.title || sub.name,
            exeHint: parsedXml.launcherRelExe,
          });
        }
      } catch {}
    }

    // Battle.net `product.db` + `Battle.net.config` (`DefaultInstallPath`) + `.build.info` inside Program Files
    for (const dbEntry of hostProductDbEntries) {
      if (dbEntry.hasCachedState && !dbEntry.installed && !dbEntry.playable) continue;
      if (!dbEntry.installPath) continue;
      const rawUid = dbEntry.uid || dbEntry.productCode;
      tryAddHostGame('bnet', dbEntry.installPath, {
        externalInstallId: rawUid || undefined,
        tactUid: dbEntry.uid || rawUid || undefined,
        launchProductCode:
          dbEntry.launchProductCode ||
          (rawUid ? normalizeBattleNetLaunchProductCode(rawUid) : undefined),
      });
    }

    const bnetHostDefaultDir = readBattleNetDefaultInstallPathFromConfig(
      path.join(roamingAppData, 'Battle.net', 'Battle.net.config')
    );
    for (const progRoot of [bnetHostDefaultDir, programFilesX86, programFiles].filter(Boolean)) {
      try {
        if (!fs.existsSync(progRoot)) continue;
        if (
          fs.existsSync(path.join(progRoot, '.build.info')) &&
          path.basename(progRoot).toLowerCase() !== 'battle.net'
        ) {
          const directBnetId = extractBattleNetProductId(progRoot);
          tryAddHostGame('bnet', progRoot, {
            externalInstallId: directBnetId || undefined,
            tactUid: directBnetId || undefined,
            launchProductCode: directBnetId
              ? normalizeBattleNetLaunchProductCode(directBnetId)
              : undefined,
            title: path.basename(progRoot),
          });
        }
        for (const sub of fs.readdirSync(progRoot, { withFileTypes: true })) {
          if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
          if (sub.name.toLowerCase() === 'battle.net') continue;
          const dir = path.join(progRoot, sub.name);
          if (fs.existsSync(path.join(dir, '.build.info'))) {
            const bnetId = extractBattleNetProductId(dir);
            tryAddHostGame('bnet', dir, {
              externalInstallId: bnetId || undefined,
              tactUid: bnetId || undefined,
              launchProductCode: bnetId ? normalizeBattleNetLaunchProductCode(bnetId) : undefined,
              title: sub.name,
            });
          }
        }
      } catch {}
    }

    // Rockstar filesystem fallback
    for (const rockstarRoot of [
      path.join(programFiles, 'Rockstar Games'),
      path.join(programFilesX86, 'Rockstar Games'),
    ]) {
      try {
        if (!fs.existsSync(rockstarRoot)) continue;
        for (const sub of fs.readdirSync(rockstarRoot, { withFileTypes: true })) {
          if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
          const lower = sub.name.toLowerCase();
          if (lower === 'launcher' || lower === 'social club') continue;
          tryAddHostGame('rockstar', path.join(rockstarRoot, sub.name), { title: sub.name });
        }
      } catch {}
    }

    // Riot Metadata/*.live/*.product_settings.yaml
    const riotMetadataDir = path.join(programData, 'Riot Games', 'Metadata');
    scanRiotMetadataDirectory(riotMetadataDir, (prodId, installDir) => {
      tryAddHostGame('riot', installDir, {
        externalInstallId: prodId,
        title: path.basename(installDir),
      });
    });

    return discovered;
  }

  if (platform === 'darwin') {
    const customAppsDir =
      typeof options.customApplicationsDir === 'string' && options.customApplicationsDir.trim()
        ? options.customApplicationsDir.trim()
        : '';
    const isIsolatedSandbox = Boolean(sandboxHome || customAppsDir);
    const home = sandboxHome || os.homedir();
    const macBnetDefaultDir = readBattleNetDefaultInstallPathFromConfig(
      path.join(home, 'Library', 'Application Support', 'Battle.net', 'Battle.net.config')
    );
    const appRoots = [
      ...(isIsolatedSandbox
        ? [customAppsDir, sandboxHome ? path.join(sandboxHome, 'Applications') : '']
        : ['/Applications', path.join(home, 'Applications')]),
      macBnetDefaultDir,
    ].filter(Boolean);

    const macProductDbPath = isIsolatedSandbox
      ? sandboxHome
        ? path.join(sandboxHome, 'Users', 'Shared', 'Battle.net', 'Agent', 'product.db')
        : ''
      : '/Users/Shared/Battle.net/Agent/product.db';
    for (const dbEntry of readBattleNetProductDbFileReadOnly(macProductDbPath)) {
      if (dbEntry.hasCachedState && !dbEntry.installed && !dbEntry.playable) continue;
      if (!dbEntry.installPath) continue;
      const rawUid = dbEntry.uid || dbEntry.productCode;
      tryAddHostGame('bnet', dbEntry.installPath, {
        externalInstallId: rawUid || undefined,
        tactUid: dbEntry.uid || rawUid || undefined,
        launchProductCode:
          dbEntry.launchProductCode ||
          (rawUid ? normalizeBattleNetLaunchProductCode(rawUid) : undefined),
        allowMacAppBundles: true,
      });
    }

    for (const appRoot of appRoots) {
      try {
        if (!fs.existsSync(appRoot)) continue;
        for (const sub of fs.readdirSync(appRoot, { withFileTypes: true })) {
          if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
          const subLower = sub.name.toLowerCase();
          if (
            subLower === 'battle.net.app' ||
            subLower === 'ea app.app' ||
            subLower === 'riot client.app'
          ) {
            continue;
          }
          const dir = path.join(appRoot, sub.name);
          if (fs.existsSync(path.join(dir, '.build.info'))) {
            const bnetId = extractBattleNetProductId(dir);
            tryAddHostGame('bnet', dir, {
              externalInstallId: bnetId || undefined,
              tactUid: bnetId || undefined,
              launchProductCode: bnetId ? normalizeBattleNetLaunchProductCode(bnetId) : undefined,
              title: sub.name,
              allowMacAppBundles: true,
            });
            continue;
          }
          const eaMacXml = [
            path.join(dir, '__Installer', 'installerdata.xml'),
            path.join(dir, 'Contents', '__Installer', 'installerdata.xml'),
          ].find((p) => fs.existsSync(p));
          if (eaMacXml) {
            let parsedXml = { contentId: '', title: '', launcherRelExe: '' };
            try {
              parsedXml = parseEaInstallerDataXml(fs.readFileSync(eaMacXml, 'utf8'), dir);
            } catch {}
            tryAddHostGame('ea', dir, {
              externalInstallId: parsedXml.contentId || undefined,
              title: parsedXml.title || sub.name.replace(/\.app$/i, ''),
              exeHint: parsedXml.launcherRelExe,
              allowMacAppBundles: true,
            });
          }
        }
      } catch {}
    }

    for (const eaMacRoot of readEaConfiguredLibraryRoots({ ...options, platform: 'darwin' })) {
      try {
        if (!fs.existsSync(eaMacRoot)) continue;
        for (const sub of fs.readdirSync(eaMacRoot, { withFileTypes: true })) {
          if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
          if (sub.name.toLowerCase() === 'ea app.app') continue;
          const gameDir = path.join(eaMacRoot, sub.name);
          const xmlPath = [
            path.join(gameDir, '__Installer', 'installerdata.xml'),
            path.join(gameDir, 'Contents', '__Installer', 'installerdata.xml'),
          ].find((p) => fs.existsSync(p));
          let parsedXml = { contentId: '', title: '', launcherRelExe: '' };
          if (xmlPath) {
            try {
              parsedXml = parseEaInstallerDataXml(fs.readFileSync(xmlPath, 'utf8'), gameDir);
            } catch {}
          }
          tryAddHostGame('ea', gameDir, {
            externalInstallId: parsedXml.contentId || undefined,
            title: parsedXml.title || sub.name.replace(/\.app$/i, ''),
            exeHint: parsedXml.launcherRelExe,
            allowMacAppBundles: true,
          });
        }
      } catch {}
    }

    const riotMetaDir = isIsolatedSandbox
      ? sandboxHome
        ? path.join(sandboxHome, 'Users', 'Shared', 'Riot Games', 'Metadata')
        : ''
      : '/Users/Shared/Riot Games/Metadata';
    if (riotMetaDir) {
      scanRiotMetadataDirectory(riotMetaDir, (prodId, installDir) => {
        tryAddHostGame('riot', installDir, {
          externalInstallId: prodId,
          title: path.basename(installDir).replace(/\.app$/i, ''),
          allowMacAppBundles: true,
        });
      });
    }
  }

  return discovered;
}

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
  if (
    baseLower === 'drive_c' ||
    baseLower === 'program files' ||
    baseLower === 'program files (x86)' ||
    baseLower === 'programdata' ||
    baseLower === 'windows' ||
    baseLower === 'system32' ||
    baseLower === 'syswow64' ||
    baseLower === 'users' ||
    baseLower === 'appdata' ||
    baseLower === 'local' ||
    baseLower === 'roaming' ||
    baseLower === 'applications'
  ) {
    return true;
  }
  return false;
}

/**
 * Resolve configured and existing game install / staging root directories for a chained publisher
 * launcher (`ea`, `ubisoft`, `bnet`, `rockstar`, `riot`) inside a macOS bottle or on the host OS.
 * Strictly refuses to return `drive_c/Program Files (x86)` or `Program Files` itself.
 *
 * @param {string} handoffId
 * @param {string | Record<string, any>} [optionsOrBottle]
 * @returns {string[]}
 */
function resolvePublisherStagingDirs(handoffId, optionsOrBottle = {}) {
  const canonical = normalizeChainedHandoffId(handoffId);
  if (!canonical) return [];

  /** @type {Record<string, any>} */
  const opts =
    typeof optionsOrBottle === 'string'
      ? { bottlePath: optionsOrBottle }
      : optionsOrBottle && typeof optionsOrBottle === 'object'
        ? optionsOrBottle
        : {};
  const bottlePath = typeof opts.bottlePath === 'string' ? opts.bottlePath.trim() : '';
  const platform = String(opts.platform || opts.hostPlatform || process.platform).toLowerCase();

  /** @type {string[]} */
  const results = [];
  /** @type {Set<string>} */
  const seenLower = new Set();

  const pushDir = (
    /** @type {string | null | undefined} */ rawDir,
    /** @type {{ requireExists?: boolean }} */ pushOpts = {}
  ) => {
    if (!rawDir) return;
    let candidate = String(rawDir)
      .trim()
      .replace(/^["']+|["']+$/g, '')
      .replace(/([^:])[\\/]+$/, '$1');
    if (!candidate) return;
    if (bottlePath) {
      const driveCRoot = path.join(bottlePath, 'drive_c');
      candidate = candidate.startsWith('/')
        ? resolveWineReparseTargetReadOnly(candidate, driveCRoot, opts)
        : resolveBottleWindowsPathReadOnly(candidate, bottlePath, opts);
    }
    if (!candidate || STEAMAPPS_COMMON_PATH_RE.test(candidate)) return;
    if (isForbiddenBroadPublisherContainerDir(candidate, bottlePath)) return;
    if (pushOpts.requireExists) {
      try {
        if (!fs.existsSync(candidate)) return;
      } catch {
        return;
      }
    }
    const key = candidate.toLowerCase();
    if (!seenLower.has(key)) {
      seenLower.add(key);
      results.push(candidate);
    }
  };

  if (bottlePath) {
    if (canonical === 'riot') return [];
    const driveCRoot = path.join(bottlePath, 'drive_c');
    const sections = getBottleSystemRegSections(bottlePath, opts);
    const userDirs = listBottleUserDirectories(bottlePath);

    if (canonical === 'ea') {
      for (const root of readEaConfiguredLibraryRoots({ ...opts, bottlePath })) {
        pushDir(root);
      }
      return results;
    }

    if (canonical === 'ubisoft') {
      const ubiLauncherInfo = discoverBottlePublisherLauncher(bottlePath, 'ubisoft', {
        parsedSystemReg: sections,
      });
      const ubiLegacyX86 = resolveDriveCPathCaseInsensitive(driveCRoot, [
        'Program Files (x86)',
        'Ubisoft',
        'Ubisoft Game Launcher',
      ]);
      const ubiLegacyX64 = resolveDriveCPathCaseInsensitive(driveCRoot, [
        'Program Files',
        'Ubisoft',
        'Ubisoft Game Launcher',
      ]);
      for (const cfgDir of [
        ...userDirs.map((u) =>
          resolveDriveCPathCaseInsensitive(u, ['AppData', 'Local', 'Ubisoft Game Launcher'])
        ),
        ubiLauncherInfo.installDir || '',
        ubiLegacyX86,
        ubiLegacyX64,
      ]) {
        const custom = readUbisoftCustomGamesDirSetting(cfgDir);
        if (custom) pushDir(custom);
      }
      for (const [secKey, props] of sections.entries()) {
        if (/^software\\(?:wow6432node\\)?ubisoft\\launcher\\installs\\[^\\]+$/i.test(secKey)) {
          pushDir(getRegistryPropCaseInsensitive(props, 'InstallDir'));
        }
      }
      if (ubiLauncherInfo.installDir) {
        pushDir(resolveDriveCPathCaseInsensitive(ubiLauncherInfo.installDir, ['games']));
      }
      pushDir(resolveDriveCPathCaseInsensitive(ubiLegacyX86, ['games']));
      pushDir(resolveDriveCPathCaseInsensitive(ubiLegacyX64, ['games']), { requireExists: true });
      return results;
    }

    if (canonical === 'bnet') {
      for (const userDir of userDirs) {
        const bnetCfg = resolveDriveCPathCaseInsensitive(userDir, [
          'AppData',
          'Roaming',
          'Battle.net',
          'Battle.net.config',
        ]);
        const defDir = readBattleNetDefaultInstallPathFromConfig(bnetCfg);
        if (defDir) pushDir(defDir);
      }
      const productDbPath = resolveDriveCPathCaseInsensitive(driveCRoot, [
        'ProgramData',
        'Battle.net',
        'Agent',
        'product.db',
      ]);
      for (const entry of readBattleNetProductDbFileReadOnly(productDbPath)) {
        if (entry.hasCachedState && !entry.installed && !entry.playable) continue;
        if (entry.installPath) pushDir(entry.installPath);
      }
      for (const progFolder of ['Program Files (x86)', 'Program Files']) {
        const progDir = resolveDriveCPathCaseInsensitive(driveCRoot, [progFolder]);
        try {
          if (!progDir || !fs.existsSync(progDir)) continue;
          for (const sub of fs.readdirSync(progDir, { withFileTypes: true })) {
            if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
            if (sub.name.toLowerCase() === 'battle.net') continue;
            const cand = path.join(progDir, sub.name);
            if (fs.existsSync(path.join(cand, '.build.info'))) {
              pushDir(cand);
            }
          }
        } catch {}
      }
      pushDir(resolveDriveCPathCaseInsensitive(driveCRoot, ['ProgramData', 'Battle.net', 'Agent']));
      return results;
    }

    if (canonical === 'rockstar') {
      for (const [secKey, props] of sections.entries()) {
        const m = secKey.match(/^software\\(?:wow6432node\\)?rockstar games\\([^\\]+)$/i);
        if (!m || !m[1]) continue;
        const sub = m[1].trim().toLowerCase();
        if (sub === 'launcher' || sub === 'social club') continue;
        pushDir(
          getRegistryPropCaseInsensitive(props, 'InstallFolder') ||
            getRegistryPropCaseInsensitive(props, 'InstallLocation')
        );
      }
      pushDir(resolveDriveCPathCaseInsensitive(driveCRoot, ['Program Files', 'Rockstar Games']));
      pushDir(
        resolveDriveCPathCaseInsensitive(driveCRoot, ['Program Files (x86)', 'Rockstar Games']),
        { requireExists: true }
      );
      return results;
    }
  }

  const sandboxHome =
    typeof opts.homedir === 'string' && opts.homedir.trim() ? opts.homedir.trim() : '';
  const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env;

  if (platform === 'win32') {
    const home = sandboxHome || os.homedir();
    const programFiles = sandboxHome
      ? String(
          opts.programFilesDir ||
            env.ProgramFiles ||
            env.PROGRAMFILES ||
            path.join(sandboxHome, 'Program Files')
        )
      : String(env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files');
    const programFilesX86 = sandboxHome
      ? String(
          opts.programFilesX86Dir ||
            env['ProgramFiles(x86)'] ||
            env['PROGRAMFILES(X86)'] ||
            path.join(sandboxHome, 'Program Files (x86)')
        )
      : String(env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)');
    const programData = sandboxHome
      ? String(
          opts.programDataDir ||
            env.ProgramData ||
            env.PROGRAMDATA ||
            path.join(sandboxHome, 'ProgramData')
        )
      : String(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData');
    const localAppData = sandboxHome
      ? String(opts.localAppDataDir || env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
      : String(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'));
    const roamingAppData = sandboxHome
      ? String(opts.appDataDir || env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : String(env.APPDATA || path.join(home, 'AppData', 'Roaming'));

    if (canonical === 'ea') {
      for (const root of readEaConfiguredLibraryRoots({ ...opts, platform: 'win32' })) {
        pushDir(root);
      }
      return results;
    }
    if (canonical === 'ubisoft') {
      const ubiHost = discoverWindowsPublisherLauncherPaths('ubisoft', opts);
      pushDir(readUbisoftCustomGamesDirSetting(path.join(localAppData, 'Ubisoft Game Launcher')));
      if (ubiHost.installDir) {
        pushDir(readUbisoftCustomGamesDirSetting(ubiHost.installDir));
        pushDir(path.join(ubiHost.installDir, 'games'));
      }
      pushDir(
        readUbisoftCustomGamesDirSetting(
          path.join(programFilesX86, 'Ubisoft', 'Ubisoft Game Launcher')
        )
      );
      pushDir(path.join(programFilesX86, 'Ubisoft', 'Ubisoft Game Launcher', 'games'));
      pushDir(path.join(programFiles, 'Ubisoft', 'Ubisoft Game Launcher', 'games'), {
        requireExists: true,
      });
      return results;
    }
    if (canonical === 'bnet') {
      pushDir(
        readBattleNetDefaultInstallPathFromConfig(
          path.join(roamingAppData, 'Battle.net', 'Battle.net.config')
        )
      );
      for (const entry of readBattleNetProductDbFileReadOnly(
        path.join(programData, 'Battle.net', 'Agent', 'product.db')
      )) {
        if (entry.hasCachedState && !entry.installed && !entry.playable) continue;
        if (entry.installPath) pushDir(entry.installPath);
      }
      pushDir(path.join(programData, 'Battle.net', 'Agent'));
      return results;
    }
    if (canonical === 'rockstar') {
      pushDir(path.join(programFiles, 'Rockstar Games'));
      pushDir(path.join(programFilesX86, 'Rockstar Games'), { requireExists: true });
      return results;
    }
    if (canonical === 'riot') {
      const riotMetaDir = path.join(programData, 'Riot Games', 'Metadata');
      scanRiotMetadataDirectory(riotMetaDir, (_prodId, installDir) => {
        pushDir(installDir);
      });
      const sysDrive = String(opts.systemDrive || env.SystemDrive || env.SYSTEMDRIVE || 'C:').trim();
      pushDir(sandboxHome ? path.join(sandboxHome, 'Riot Games') : `${sysDrive}\\Riot Games`);
      return results;
    }
  }

  if (platform === 'darwin') {
    const home = sandboxHome || os.homedir();
    const isIsolatedSandbox = Boolean(sandboxHome || opts.customApplicationsDir);
    if (canonical === 'ea') {
      for (const root of readEaConfiguredLibraryRoots({ ...opts, platform: 'darwin' })) {
        pushDir(root);
      }
      return results;
    }
    if (canonical === 'bnet') {
      pushDir(
        readBattleNetDefaultInstallPathFromConfig(
          path.join(home, 'Library', 'Application Support', 'Battle.net', 'Battle.net.config')
        )
      );
      const macDb = isIsolatedSandbox
        ? sandboxHome
          ? path.join(sandboxHome, 'Users', 'Shared', 'Battle.net', 'Agent', 'product.db')
          : ''
        : '/Users/Shared/Battle.net/Agent/product.db';
      for (const entry of readBattleNetProductDbFileReadOnly(macDb)) {
        if (entry.hasCachedState && !entry.installed && !entry.playable) continue;
        if (entry.installPath) pushDir(entry.installPath);
      }
      pushDir(
        isIsolatedSandbox
          ? sandboxHome
            ? path.join(sandboxHome, 'Users', 'Shared', 'Battle.net', 'Agent')
            : ''
          : '/Users/Shared/Battle.net/Agent'
      );
      return results;
    }
    if (canonical === 'riot') {
      const riotShared = isIsolatedSandbox
        ? sandboxHome
          ? path.join(sandboxHome, 'Users', 'Shared', 'Riot Games')
          : ''
        : '/Users/Shared/Riot Games';
      if (riotShared) {
        scanRiotMetadataDirectory(path.join(riotShared, 'Metadata'), (_prodId, installDir) => {
          pushDir(installDir);
        });
        pushDir(riotShared);
      }
      return results;
    }
  }

  return results;
}

/**
 * Scan `Riot Games/Metadata/*.live/*.product_settings.yaml` for installed Riot games.
 *
 * @param {string} metadataRoot
 * @param {(productId: string, installFullPath: string) => void} onEntry
 */
function scanRiotMetadataDirectory(metadataRoot, onEntry) {
  if (!metadataRoot) return;
  try {
    if (!fs.existsSync(metadataRoot)) return;
    for (const dirEntry of fs.readdirSync(metadataRoot, { withFileTypes: true })) {
      if (!dirEntry.isDirectory() || !dirEntry.name.toLowerCase().endsWith('.live')) continue;
      const productId = dirEntry.name.slice(0, -'.live'.length);
      if (!productId || productId.toLowerCase() === 'riot_client') continue;
      const subDir = path.join(metadataRoot, dirEntry.name);
      const files = fs.readdirSync(subDir, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile() || !f.name.toLowerCase().endsWith('.product_settings.yaml')) continue;
        try {
          const yamlText = fs.readFileSync(path.join(subDir, f.name), 'utf8');
          const installPath = parseRiotProductInstallFullPath(yamlText);
          if (installPath) {
            onEntry(productId, installPath);
          }
        } catch {}
      }
    }
  } catch {}
}

/**
 * Return `true` when a Wine `.reg` value assignment line inside a `CurrentVersion\\Run` section
 * launches one of our managed chained publisher launchers (`EA`, `Ubisoft`, `Battle.net`, `Rockstar`).
 *
 * @param {string} line
 * @returns {boolean}
 */
function isChainedPublisherAutostartRunLine(line) {
  const kvMatch = line.match(/^\s*"([^"]+)"\s*=\s*(.*)$/);
  if (!kvMatch) return false;
  const keyName = unescapeWineRegValue(kvMatch[1]).trim();
  const rhsRaw = kvMatch[2].trim();
  if (
    /^(?:eadm|ea\s*(?:desktop|app|background\s*service)|origin|uplay(?:launch)?|ubisoft(?:\s*connect|\s*game\s*launcher)?|battle\.?net(?:\s*launcher|\s*helper)?|blizzard(?:\s*battle\.?net)?|rockstar(?:\s*games(?:\s*launcher)?)?|social\s*club)$/i.test(
      keyName
    )
  ) {
    return true;
  }
  const unescapedRhs = unescapeWineRegValue(rhsRaw.replace(/^"|"$/g, ''));
  if (
    /(?:EADesktop|EALauncher|EABackgroundService|Origin|upc|UbisoftConnect|UbisoftGameLauncher|Battle\.net(?:\s+Launcher)?|Rockstar-Games-Launcher|RockstarService|LauncherPatcher)\.exe\b/i.test(
      unescapedRhs
    ) ||
    (/\\Rockstar Games\\Launcher\\Launcher\.exe\b/i.test(unescapedRhs))
  ) {
    return true;
  }
  return false;
}

/**
 * Sanitize a single Wine `.reg` file (`user.reg` or `system.reg`), stripping `CurrentVersion\\Run`
 * and `Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Run` autostart entries for EA, Ubisoft,
 * Battle.net, and Rockstar, and enforcing `"startOnBootFlag"=dword:00000000` in `user.reg`.
 *
 * @param {string} regFilePath
 * @param {{ enforceEaStartOnBootFlag?: boolean }} [opts]
 * @returns {boolean}
 */
function sanitizePublisherAutostartInSingleRegFile(regFilePath, opts = {}) {
  if (!regFilePath) return false;
  try {
    if (!fs.existsSync(regFilePath)) return false;
    const raw = fs.readFileSync(regFilePath, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    const enforceEaFlag = Boolean(opts.enforceEaStartOnBootFlag);

    let currentSec = '';
    let modified = false;
    let sawEaDesktopSection = false;
    let sawStartOnBootInCurrentSection = false;
    let skipContinuation = false;
    /** @type {string[]} */
    const outLines = [];

    const flushEaDesktopSectionIfNeeded = () => {
      if (
        enforceEaFlag &&
        currentSec === 'software\\electronic arts\\ea desktop' &&
        !sawStartOnBootInCurrentSection
      ) {
        let insertIdx = outLines.length;
        while (insertIdx > 0 && outLines[insertIdx - 1].trim() === '') {
          insertIdx -= 1;
        }
        outLines.splice(insertIdx, 0, '"startOnBootFlag"=dword:00000000');
        sawStartOnBootInCurrentSection = true;
        modified = true;
      }
    };

    for (const line of lines) {
      if (skipContinuation) {
        if (!line.endsWith('\\') || line.endsWith('\\\\')) {
          skipContinuation = false;
        }
        continue;
      }

      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        const closeBracket = trimmed.indexOf(']');
        if (closeBracket > 1) {
          flushEaDesktopSectionIfNeeded();
          currentSec = normalizeWineRegistrySectionKey(trimmed.slice(1, closeBracket));
          if (currentSec === 'software\\electronic arts\\ea desktop') {
            sawEaDesktopSection = true;
            sawStartOnBootInCurrentSection = false;
          }
        }
        outLines.push(line);
        continue;
      }

      if (
        (currentSec === 'software\\microsoft\\windows\\currentversion\\run' ||
          currentSec === 'software\\microsoft\\windows\\currentversion\\runonce' ||
          currentSec === 'software\\wow6432node\\microsoft\\windows\\currentversion\\run' ||
          currentSec === 'software\\wow6432node\\microsoft\\windows\\currentversion\\runonce') &&
        isChainedPublisherAutostartRunLine(line)
      ) {
        modified = true;
        if (line.endsWith('\\') && !line.endsWith('\\\\')) {
          skipContinuation = true;
        }
        continue;
      }

      if (
        enforceEaFlag &&
        currentSec === 'software\\electronic arts\\ea desktop' &&
        /^\s*"startonbootflag"\s*=/i.test(line)
      ) {
        sawStartOnBootInCurrentSection = true;
        if (trimmed !== '"startOnBootFlag"=dword:00000000') {
          outLines.push('"startOnBootFlag"=dword:00000000');
          modified = true;
        } else {
          outLines.push(line);
        }
        continue;
      }

      outLines.push(line);
    }

    flushEaDesktopSectionIfNeeded();

    if (enforceEaFlag && !sawEaDesktopSection) {
      if (outLines.length > 0 && outLines[outLines.length - 1].trim() !== '') {
        outLines.push('');
      }
      outLines.push('[Software\\\\Electronic Arts\\\\EA Desktop]');
      outLines.push('"startOnBootFlag"=dword:00000000');
      outLines.push('');
      modified = true;
    }

    if (!modified) return false;

    const tmpPath = `${regFilePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, outLines.join(eol), 'utf8');
      fs.renameSync(tmpPath, regFilePath);
      return true;
    } catch (writeErr) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
      throw writeErr;
    }
  } catch {
    return false;
  }
}

/**
 * Strip `CurrentVersion\\Run` and `Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Run` autostart
 * entries for EA, Ubisoft, Battle.net, and Rockstar across BOTH `<bottlePath>/user.reg` and
 * `<bottlePath>/system.reg` (plus `"startOnBootFlag"=dword:00000000` for EA Desktop) so background
 * publisher clients never auto-boot on unrelated bottle launches.
 *
 * @param {string} bottlePath
 * @returns {boolean} `true` if either `user.reg` or `system.reg` was modified on disk.
 */
function sanitizeChainedPublisherAutostartInBottleRegs(bottlePath) {
  if (!bottlePath || typeof bottlePath !== 'string') return false;
  const userModified = sanitizePublisherAutostartInSingleRegFile(
    path.join(bottlePath, 'user.reg'),
    { enforceEaStartOnBootFlag: true }
  );
  const sysModified = sanitizePublisherAutostartInSingleRegFile(
    path.join(bottlePath, 'system.reg'),
    { enforceEaStartOnBootFlag: false }
  );
  return userModified || sysModified;
}

/**
 * Backwards-compatible alias delegating to `sanitizeChainedPublisherAutostartInBottleRegs(bottlePath)`.
 *
 * @param {string} bottlePath
 * @returns {boolean}
 */
function sanitizeEaBottleAutostartInUserReg(bottlePath) {
  return sanitizeChainedPublisherAutostartInBottleRegs(bottlePath);
}

/**
 * Safely remove uninstalled game `Uninstall` and publisher-install registry sections matching
 * `installDir` inside `<bottlePath>/system.reg` for `ubisoft`, `ea`, `bnet`, and `rockstar`
 * without ever touching the publisher launcher's own registration keys.
 *
 * @param {string} bottlePath
 * @param {string} installDir
 * @param {string} [handoffId]
 * @returns {{ modified: boolean, removedSections: string[] }}
 */
function stripPublisherUninstallKeysFromSystemReg(bottlePath, installDir, handoffId = '') {
  /** @type {string[]} */
  const removedSections = [];
  if (
    !bottlePath ||
    typeof bottlePath !== 'string' ||
    !installDir ||
    typeof installDir !== 'string'
  ) {
    return { modified: false, removedSections };
  }
  const canonical = handoffId ? normalizeChainedHandoffId(handoffId) : null;
  if (canonical === 'riot') {
    return { modified: false, removedSections };
  }

  const driveCRoot = path.join(bottlePath, 'drive_c');
  const targetHostDir = installDir.startsWith('/')
    ? resolveWineReparseTargetReadOnly(installDir, driveCRoot)
    : resolveBottleWindowsPathReadOnly(installDir, bottlePath);
  if (!targetHostDir || isForbiddenBroadPublisherContainerDir(targetHostDir, bottlePath)) {
    return { modified: false, removedSections };
  }
  const targetNormLower = path.resolve(targetHostDir).replace(/[\\/]+$/, '').toLowerCase();

  // Never strip a launcher client's own install directory
  for (const launcherHid of /** @type {const} */ (['ubisoft', 'ea', 'bnet', 'rockstar'])) {
    const disc = discoverBottlePublisherLauncher(bottlePath, launcherHid);
    if (disc.installDir) {
      const launcherNorm = path.resolve(disc.installDir).replace(/[\\/]+$/, '').toLowerCase();
      if (launcherNorm === targetNormLower) {
        return { modified: false, removedSections };
      }
    }
  }

  const sysRegPath = path.join(bottlePath, 'system.reg');
  try {
    if (!fs.existsSync(sysRegPath)) {
      return { modified: false, removedSections };
    }
    const raw = fs.readFileSync(sysRegPath, 'utf8');
    const parsedSections = parseWineRegistrySections(raw);
    /** @type {Set<string>} */
    const sectionsToStrip = new Set();

    const matchesTargetDir = (/** @type {string} */ rawRegPath) => {
      if (!rawRegPath) return false;
      const trimmed = rawRegPath.trim().replace(/^"+|"+$/g, '');
      if (!trimmed) return false;
      const resolved = trimmed.startsWith('/')
        ? resolveWineReparseTargetReadOnly(trimmed, driveCRoot)
        : resolveBottleWindowsPathReadOnly(trimmed, bottlePath);
      if (!resolved) return false;
      return path.resolve(resolved).replace(/[\\/]+$/, '').toLowerCase() === targetNormLower;
    };

    for (const [secKey, props] of parsedSections.entries()) {
      const uninstMatch = secKey.match(
        /^software\\(?:wow6432node\\)?microsoft\\windows\\currentversion\\uninstall\\([^\\]+)$/i
      );
      if (uninstMatch && uninstMatch[1]) {
        const subKeyLower = uninstMatch[1].trim().toLowerCase();
        const dispName = getRegistryPropCaseInsensitive(props, 'DisplayName');
        const upgradeCode = getRegistryPropCaseInsensitive(props, 'UpgradeCode').toUpperCase();
        // Protect launcher clients' own Uninstall keys
        if (
          subKeyLower === 'battle.net' ||
          subKeyLower === 'uplay' ||
          subKeyLower === 'ubisoft connect' ||
          upgradeCode === '{ADF2591E-00D2-4FFF-9BF4-9CCDAE6BDC67}' ||
          /^(?:ea\s+(?:app|desktop)|battle\.net|ubisoft\s+connect|uplay|(?:rockstar\s+games\s+)?(?:launcher|social\s+club))$/i.test(
            dispName
          )
        ) {
          continue;
        }
        const loc =
          getRegistryPropCaseInsensitive(props, 'InstallLocation') ||
          getRegistryPropCaseInsensitive(props, 'InstallDir') ||
          getRegistryPropCaseInsensitive(props, 'InstallFolder');
        if (matchesTargetDir(loc)) {
          sectionsToStrip.add(secKey);
        }
        continue;
      }

      if (
        (!canonical || canonical === 'ubisoft') &&
        /^software\\(?:wow6432node\\)?ubisoft\\launcher\\installs\\[^\\]+$/i.test(secKey)
      ) {
        if (matchesTargetDir(getRegistryPropCaseInsensitive(props, 'InstallDir'))) {
          sectionsToStrip.add(secKey);
        }
        continue;
      }

      if (
        (!canonical || canonical === 'ea') &&
        /^software\\(?:wow6432node\\)?(?:ea games|origin games)\\[^\\]+$/i.test(secKey)
      ) {
        const loc =
          getRegistryPropCaseInsensitive(props, 'Install Dir') ||
          getRegistryPropCaseInsensitive(props, 'InstallLocation');
        if (matchesTargetDir(loc)) {
          sectionsToStrip.add(secKey);
        }
        continue;
      }

      if ((!canonical || canonical === 'rockstar')) {
        const rMatch = secKey.match(/^software\\(?:wow6432node\\)?rockstar games\\([^\\]+)$/i);
        if (rMatch && rMatch[1]) {
          const rSub = rMatch[1].trim().toLowerCase();
          if (rSub !== 'launcher' && rSub !== 'social club') {
            const loc =
              getRegistryPropCaseInsensitive(props, 'InstallFolder') ||
              getRegistryPropCaseInsensitive(props, 'InstallLocation');
            if (matchesTargetDir(loc)) {
              sectionsToStrip.add(secKey);
            }
          }
        }
      }
    }

    if (sectionsToStrip.size === 0) {
      return { modified: false, removedSections };
    }

    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    /** @type {string[]} */
    const outLines = [];
    let droppingCurrentSection = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        const closeBracket = trimmed.indexOf(']');
        if (closeBracket > 1) {
          const secKey = normalizeWineRegistrySectionKey(trimmed.slice(1, closeBracket));
          if (sectionsToStrip.has(secKey)) {
            droppingCurrentSection = true;
            removedSections.push(secKey);
            continue;
          }
          droppingCurrentSection = false;
        }
      }
      if (!droppingCurrentSection) {
        outLines.push(line);
      }
    }

    const tmpPath = `${sysRegPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, outLines.join(eol), 'utf8');
      fs.renameSync(tmpPath, sysRegPath);
      return { modified: true, removedSections };
    } catch (writeErr) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
      throw writeErr;
    }
  } catch {
    return { modified: false, removedSections };
  }
}

/**
 * Walk 0–3 parent directories upward from `gameExecutablePath` (and optional `installPath`)
 * to auto-resolve EA `contentId` from `<dir>/__Installer/installerdata.xml`.
 *
 * @param {string} gameExePath
 * @param {string} [installPathHint]
 * @returns {string}
 */
function resolveEaContentIdNearExecutable(gameExePath, installPathHint = '') {
  /** @type {string[]} */
  const candidateDirs = [];
  if (installPathHint) {
    candidateDirs.push(installPathHint);
  }
  if (gameExePath) {
    let cur = path.dirname(gameExePath);
    for (let hop = 0; hop <= 3; hop += 1) {
      if (!cur || cur === '.' || cur === '/' || /^[a-zA-Z]:[\\/]?$/.test(cur)) break;
      if (!candidateDirs.includes(cur)) {
        candidateDirs.push(cur);
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  for (const dir of candidateDirs) {
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      const xmlPath = resolveDriveCPathCaseInsensitive(dir, ['__Installer', 'installerdata.xml']);
      if (xmlPath && fs.existsSync(xmlPath)) {
        const parsed = parseEaInstallerDataXml(fs.readFileSync(xmlPath, 'utf8'), dir);
        if (parsed.contentId) return parsed.contentId;
      }
    } catch {}
  }
  return '';
}

/**
 * Convert a host or bottle game installation directory to a Windows path (`C:\...` or `Z:\...`)
 * suitable for Rockstar Games Launcher's `-launchTitleInFolder <WindowsPath>` CLI argument.
 *
 * @param {string} rawInstallDir
 * @param {string} [bottlePath]
 * @param {boolean} [isWineBottleExecution]
 * @returns {string}
 */
function toRockstarWindowsInstallDir(rawInstallDir, bottlePath = '', isWineBottleExecution = false) {
  const clean = String(rawInstallDir || '')
    .trim()
    .replace(/^["']+|["']+$/g, '');
  if (!clean) return '';

  const slashNorm = clean.replace(/\\/g, '/').replace(/\/+$/, '');
  if (bottlePath) {
    const cleanBottleDriveC = `${bottlePath.replace(/\\/g, '/').replace(/\/+$/, '')}/drive_c`;
    if (slashNorm.toLowerCase() === cleanBottleDriveC.toLowerCase()) {
      return 'C:\\';
    }
    if (slashNorm.toLowerCase().startsWith(`${cleanBottleDriveC.toLowerCase()}/`)) {
      const rel = slashNorm.slice(cleanBottleDriveC.length + 1).replace(/\//g, '\\');
      return `C:\\${rel}`;
    }
  }

  const driveCMatch = slashNorm.match(/\/drive_c(?:\/(.*))?$/i);
  if (driveCMatch) {
    const rel = String(driveCMatch[1] || '').replace(/\//g, '\\');
    return rel ? `C:\\${rel}` : 'C:\\';
  }

  if (/^[A-Za-z]:[\\/]/.test(clean)) {
    const winNorm = clean.replace(/\//g, '\\');
    return /^[A-Za-z]:\\$/.test(winNorm) ? winNorm : winNorm.replace(/\\+$/, '');
  }

  if (slashNorm.startsWith('/') && isWineBottleExecution) {
    return `Z:\\${slashNorm.replace(/^\/+/, '').replace(/\//g, '\\')}`;
  }

  return '';
}

/**
 * Return `true` when `dirPath` on disk is an Xbox GDK stub wrapper folder (`GDKStubGame.exe`
 * with no real playable game `.exe`), so Rockstar `-launchTitleInFolder` never targets a stub.
 *
 * @param {string} dirPath
 * @returns {boolean}
 */
function isGdkStubOnlyDirectory(dirPath) {
  if (!dirPath || /^[A-Za-z]:[\\/]/.test(dirPath)) return false;
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return false;
    const entries = fs.readdirSync(dirPath);
    const hasStub = entries.some((n) => n.toLowerCase() === 'gdkstubgame.exe');
    if (!hasStub) return false;
    const { executablePath } = findPrimaryPublisherGameExecutable(dirPath);
    return !executablePath;
  } catch {
    return false;
  }
}

/**
 * Build a deterministic launch specification for a game or installer delegated through
 * a chained publisher launcher (`ubisoft`, `ea`, `bnet`, `rockstar`, `riot`).
 *
 * @param {{
 *   handoffId: string,
 *   externalInstallId?: string | null,
 *   chainedExternalInstallId?: string | null,
 *   launcherBinaryPath?: string | null,
 *   clientBinaryPath?: string | null,
 *   launcherAppPath?: string | null,
 *   gameExecutablePath?: string | null,
 *   executablePath?: string | null,
 *   installDir?: string | null,
 *   installPath?: string | null,
 *   windowsInstallDir?: string | null,
 *   bottlePath?: string | null,
 *   epicPartnerRegistryPath?: string | null,
 *   storefrontId?: string | null,
 *   platform?: string,
 *   compatibilityLayerType?: string | null,
 *   inBottle?: boolean,
 *   crossoverInjectsNoBattlEye?: boolean,
 * }} params
 * @returns {ChainedLauncherLaunchSpec}
 */
function buildChainedLauncherLaunchSpec(params) {
  const {
    handoffId,
    externalInstallId,
    chainedExternalInstallId,
    launcherBinaryPath,
    clientBinaryPath,
    launcherAppPath,
    gameExecutablePath,
    executablePath,
    installDir,
    installPath,
    windowsInstallDir,
    bottlePath,
    platform = process.platform,
    compatibilityLayerType,
    inBottle,
    crossoverInjectsNoBattlEye,
  } = params || {};

  const canonical = normalizeChainedHandoffId(handoffId);
  const normPlatform = String(platform || process.platform).toLowerCase();
  const normLayer = String(compatibilityLayerType || '').toLowerCase();
  const isWineBottleExecution =
    inBottle === true ||
    Boolean(bottlePath && String(bottlePath).trim()) ||
    (normPlatform === 'darwin' && normLayer !== 'native');

  const cleanExternalId = String(externalInstallId ?? chainedExternalInstallId ?? '').trim();
  const cleanLauncherBin = String(launcherBinaryPath ?? clientBinaryPath ?? '').trim();
  const cleanLauncherApp = String(launcherAppPath || '').trim();
  const cleanGameExe = String(gameExecutablePath ?? executablePath ?? '').trim();
  const cleanInstallDir = String(installDir ?? installPath ?? '').trim();
  const cleanWindowsInstallDir = String(windowsInstallDir || '').trim();
  const cleanBottlePath = String(bottlePath || '').trim();

  if (canonical === 'ubisoft') {
    const descriptor = CHAINED_PUBLISHER_ECOSYSTEMS.ubisoft;
    /** @type {string[]} */
    const args = isWineBottleExecution ? [...(descriptor.wineClientArgs || [])] : [];
    /** @type {string | undefined} */
    let uri;
    if (cleanExternalId) {
      uri = `uplay://launch/${cleanExternalId}/0`;
      args.push(uri);
    }
    /** @type {Record<string, string>} */
    const envOverrides = isWineBottleExecution ? { ...(descriptor.wineEnvOverrides || {}) } : {};
    return {
      launcherExe: cleanLauncherBin || cleanGameExe,
      args,
      envOverrides,
      ...(uri ? { uri } : {}),
      targetExecutablePath: cleanGameExe || null,
    };
  }

  if (canonical === 'ea') {
    const descriptor = CHAINED_PUBLISHER_ECOSYSTEMS.ea;
    /** @type {Record<string, string>} */
    const envOverrides = isWineBottleExecution ? { ...(descriptor.wineEnvOverrides || {}) } : {};

    const resolvedCleanId =
      cleanExternalId ||
      (cleanGameExe || cleanInstallDir
        ? resolveEaContentIdNearExecutable(cleanGameExe, cleanInstallDir)
        : '');

    let eaRunnerExe = '';
    if (cleanLauncherApp) {
      let appExists = false;
      let binExists = false;
      try {
        appExists = fs.existsSync(cleanLauncherApp) && fs.statSync(cleanLauncherApp).isFile();
      } catch {}
      try {
        binExists = Boolean(cleanLauncherBin && fs.existsSync(cleanLauncherBin));
      } catch {}
      if (appExists || !binExists) {
        eaRunnerExe = cleanLauncherApp;
      }
    }
    if (!eaRunnerExe && cleanLauncherBin) {
      eaRunnerExe = cleanLauncherBin;
      try {
        const binDir = path.dirname(cleanLauncherBin);
        if (binDir && fs.existsSync(binDir)) {
          const siblingLauncher = resolveDriveCPathCaseInsensitive(binDir, ['EALauncher.exe']);
          if (
            siblingLauncher &&
            fs.existsSync(siblingLauncher) &&
            fs.statSync(siblingLauncher).isFile()
          ) {
            eaRunnerExe = siblingLauncher;
          }
        }
      } catch {}
    }

    /** @type {string | undefined} */
    const uri = resolvedCleanId
      ? `origin2://game/launch?offerIds=${encodeURIComponent(resolvedCleanId)}&autoDownload=1`
      : undefined;

    const isDirectEaDesktopOnWine =
      isWineBottleExecution &&
      Boolean(eaRunnerExe) &&
      /(?:^|[\\/])eadesktop\.exe$/i.test(eaRunnerExe);

    /** @type {string[]} */
    const args = isDirectEaDesktopOnWine ? [...(descriptor.wineClientArgs || [])] : [];
    if (uri && eaRunnerExe) {
      args.push(uri);
    }

    return {
      launcherExe: eaRunnerExe || cleanGameExe,
      args,
      envOverrides,
      ...(uri ? { uri } : {}),
      protocolUri: uri || null,
      targetExecutablePath: cleanGameExe || null,
    };
  }

  if (canonical === 'bnet') {
    const descriptor = CHAINED_PUBLISHER_ECOSYSTEMS.bnet;
    /** @type {Record<string, string>} */
    const envOverrides = isWineBottleExecution ? { ...(descriptor.wineEnvOverrides || {}) } : {};
    const inferredDir = cleanInstallDir || (cleanGameExe ? path.dirname(cleanGameExe) : '');
    const rawBnetId = cleanExternalId || (inferredDir ? extractBattleNetProductId(inferredDir) : '');
    const launchCode = rawBnetId ? normalizeBattleNetLaunchProductCode(rawBnetId) : '';
    const protocolUri = launchCode ? `battlenet://${launchCode}` : null;
    /** @type {string[]} */
    const args = launchCode ? [`--exec=launch ${launchCode}`] : [];
    return {
      launcherExe: cleanLauncherBin || cleanGameExe,
      args,
      envOverrides,
      ...(protocolUri ? { uri: protocolUri } : {}),
      protocolUri,
      targetExecutablePath: cleanGameExe || null,
      ...(rawBnetId ? { tactUid: rawBnetId } : {}),
      ...(launchCode ? { launchProductCode: launchCode } : {}),
    };
  }

  if (canonical === 'rockstar') {
    const descriptor = CHAINED_PUBLISHER_ECOSYSTEMS.rockstar;
    /** @type {Record<string, string>} */
    const envOverrides = isWineBottleExecution ? { ...(descriptor.wineEnvOverrides || {}) } : {};

    let rockstarLauncherExe = cleanLauncherBin;
    if (rockstarLauncherExe && /(?:^|[\\/])launcherpatcher\.exe$/i.test(rockstarLauncherExe)) {
      try {
        const siblingLauncher = resolveDriveCPathCaseInsensitive(
          path.dirname(rockstarLauncherExe),
          ['Launcher.exe']
        );
        if (
          siblingLauncher &&
          fs.existsSync(siblingLauncher) &&
          fs.statSync(siblingLauncher).isFile()
        ) {
          rockstarLauncherExe = siblingLauncher;
        }
      } catch {}
    }

    let candidateHostInstallDir = cleanInstallDir;
    if (candidateHostInstallDir && isGdkStubOnlyDirectory(candidateHostInstallDir)) {
      candidateHostInstallDir = '';
    }
    if (!candidateHostInstallDir && cleanGameExe) {
      const exeDir = /^[A-Za-z]:[\\/]/.test(cleanGameExe)
        ? cleanGameExe.replace(/[\\/][^\\/]+$/, '')
        : path.dirname(cleanGameExe);
      if (!isGdkStubOnlyDirectory(exeDir)) {
        candidateHostInstallDir = exeDir;
      }
    }

    const resolvedWinInstallDir = cleanWindowsInstallDir
      ? toRockstarWindowsInstallDir(
          cleanWindowsInstallDir,
          cleanBottlePath,
          isWineBottleExecution
        ) || cleanWindowsInstallDir.replace(/\//g, '\\').replace(/([^:])\\+$/, '$1')
      : toRockstarWindowsInstallDir(
          candidateHostInstallDir,
          cleanBottlePath,
          isWineBottleExecution
        );

    if (rockstarLauncherExe && resolvedWinInstallDir) {
      return {
        launcherExe: rockstarLauncherExe,
        args: ['-launchTitleInFolder', resolvedWinInstallDir],
        envOverrides,
        expectedGameExe: cleanGameExe || '',
        targetExecutablePath: cleanGameExe || null,
      };
    }

    if (rockstarLauncherExe) {
      return {
        launcherExe: rockstarLauncherExe,
        args: [],
        envOverrides,
        expectedGameExe: cleanGameExe || '',
        targetExecutablePath: cleanGameExe || null,
      };
    }

    // Fallback when Rockstar's `Launcher.exe` is unavailable: look for a `Play*.exe` bootstrapper
    let playBootstrapperPath = '';
    let localScanDir = candidateHostInstallDir;
    if (
      localScanDir &&
      !/^[A-Za-z]:[\\/]/.test(localScanDir) &&
      fs.existsSync(localScanDir)
    ) {
      // Already a valid host path
    } else if (localScanDir && cleanBottlePath && /^[A-Za-z]:[\\/]/.test(localScanDir)) {
      localScanDir = resolveBottleWindowsPathReadOnly(localScanDir, cleanBottlePath);
    }

    if (cleanGameExe && /(?:^|[\\/])play[a-z0-9_.-]*\.exe$/i.test(cleanGameExe)) {
      playBootstrapperPath = cleanGameExe;
    } else if (localScanDir) {
      try {
        if (fs.existsSync(localScanDir) && fs.statSync(localScanDir).isDirectory()) {
          const entries = fs
            .readdirSync(localScanDir, { withFileTypes: true })
            .filter((d) => d.isFile() && /^play[a-z0-9_.-]*\.exe$/i.test(d.name))
            .sort((a, b) => a.name.localeCompare(b.name));
          if (entries.length > 0) {
            playBootstrapperPath = path.join(localScanDir, entries[0].name);
          }
        }
      } catch {}
    }

    if (playBootstrapperPath) {
      /** @type {string[]} */
      const fallbackArgs = [];
      if (isWineBottleExecution && crossoverInjectsNoBattlEye !== true) {
        const playDir = /^[A-Za-z]:[\\/]/.test(playBootstrapperPath)
          ? localScanDir
          : path.dirname(playBootstrapperPath);
        let hasBattlEyeCompanion = false;
        try {
          if (playDir && fs.existsSync(playDir) && fs.statSync(playDir).isDirectory()) {
            const dirFiles = fs.readdirSync(playDir);
            hasBattlEyeCompanion = dirFiles.some((name) =>
              /(?:_be\.exe|^beservice.*\.exe|^bedaisy\.sys|^battleye)$/i.test(name)
            );
          }
        } catch {}
        if (hasBattlEyeCompanion && !fallbackArgs.includes('-nobattleye')) {
          fallbackArgs.push('-nobattleye');
        }
      }
      return {
        launcherExe: playBootstrapperPath,
        args: fallbackArgs,
        envOverrides,
        expectedGameExe: cleanGameExe || '',
        targetExecutablePath: cleanGameExe || null,
      };
    }

    // Never spawn raw DRM-gated Rockstar engine executables directly with `args: []`
    return {
      launcherExe: '',
      args: resolvedWinInstallDir ? ['-launchTitleInFolder', resolvedWinInstallDir] : [],
      envOverrides,
      expectedGameExe: cleanGameExe || '',
      targetExecutablePath: cleanGameExe || null,
    };
  }

  if (canonical === 'riot') {
    /** @type {string[]} */
    const args = cleanExternalId
      ? [`--launch-product=${cleanExternalId}`, '--launch-patchline=live']
      : [];
    return {
      launcherExe: cleanLauncherBin || cleanGameExe,
      args,
      envOverrides: {},
    };
  }

  return {
    launcherExe: cleanGameExe || cleanLauncherBin,
    args: [],
    envOverrides: {},
  };
}

module.exports = {
  CHAINED_PUBLISHER_ECOSYSTEMS,
  PUBLISHER_LAUNCHER_SPECS,
  normalizeChainedHandoffId,
  resolveDefaultChainedBottleName,
  normalizeBattleNetLaunchProductCode,
  parseBattleNetProductDbBuffer,
  extractBattleNetProductId,
  parseWineRegistrySections,
  resolveWineReparseTargetReadOnly,
  hasUbisoftLocalSessionInDir,
  hasEaLocalSessionInDir,
  hasBattleNetLocalSessionInConfigFile,
  hasRockstarLocalSessionInDir,
  hasRockstarLocalSessionInDirs,
  hasRiotLocalSessionInFile,
  detectMacNativePublisherBundle,
  parseEaInstallerDataXml,
  readEaConfiguredLibraryRoots,
  resolvePublisherStagingDirs,
  isExcludedPublisherOrRedistExe,
  sanitizeChainedPublisherAutostartInBottleRegs,
  sanitizeEaBottleAutostartInUserReg,
  stripPublisherUninstallKeysFromSystemReg,
  discoverBottlePublisherLauncher,
  discoverHostPublisherLauncher,
  scanBottlePublisherInstalledGames,
  scanHostPublisherInstalledGames,
  buildChainedLauncherLaunchSpec,
};
