// @ts-check
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverWindowsSteamRegistryPaths } = require('../utils/windowsRegistryDiscovery.cjs');

const STEAM_LOCAL_SCAN_TTL_MS = 15000;
const STEAM_ID64_BASE = 76561197960265728n;
const STEAM_HTTP_TIMEOUT_MS = 20_000;

/**
 * Per-account/scope TTL caches so switching active Steam accounts never leaks stale playtimes
 * or achievements from a previously active `userdata/<accountId32>` directory.
 *
 * @type {Map<string, { at: number, data: Record<number, { playtimeMinutes: number, lastPlayedEpoch: number }> }>}
 */
const cachedLocalSteamPlaytimesByScope = new Map();

/** @type {Map<string, { at: number, data: Record<number, { unlocked: number, total: number, percentage: number, isMastered: boolean }> }>} */
const cachedLocalSteamAchievementsByScope = new Map();

/** @type {Map<string, { mtimeMs: number, size: number, playtimes: Record<number, { playtimeMinutes: number, lastPlayedEpoch: number }> }>} */
const steamLocalVdfMtimeCache = new Map();
/** @type {Map<string, { mtimeMs: number, size: number, data: any }>} */
const steamLocalAchFileMtimeCache = new Map();

function trimSteamLocalScannerMemory() {
  cachedLocalSteamPlaytimesByScope.clear();
  cachedLocalSteamAchievementsByScope.clear();
  steamLocalVdfMtimeCache.clear();
  steamLocalAchFileMtimeCache.clear();
}

/**
 * @param {AbortSignal | undefined} callerSignal
 * @param {number} [timeoutMs]
 * @returns {AbortSignal}
 */
function buildSteamFetchSignal(callerSignal, timeoutMs = STEAM_HTTP_TIMEOUT_MS) {
  const timeoutSig = AbortSignal.timeout(timeoutMs);
  if (callerSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([callerSignal, timeoutSig]);
  }
  return callerSignal || timeoutSig;
}

/**
 * Converts a 17-digit 64-bit `SteamID64` (`>= 76561197960265729`) into its 32-bit Steam
 * `userdata/<accountId32>` folder identifier (`String(BigInt(steamId64) - 76561197960265728n)`).
 *
 * @param {string | number | bigint | undefined | null} rawSteamId64
 * @returns {string | null}
 */
function steamId64ToAccountId32(rawSteamId64) {
  if (rawSteamId64 === null || rawSteamId64 === undefined) return null;
  const clean = String(rawSteamId64).trim();
  if (!/^\d{17}$/.test(clean)) return null;
  try {
    const id64 = BigInt(clean);
    if (id64 <= STEAM_ID64_BASE) return null;
    const accountId32 = id64 - STEAM_ID64_BASE;
    if (accountId32 <= 0n || accountId32 > 0xffffffffn) return null;
    return String(accountId32);
  } catch {
    return null;
  }
}

/**
 * Parses `Steam/config/loginusers.vdf` to extract the active Steam user (`MostRecent "1"`,
 * breaking ties via `Timestamp`) and converts their `SteamID64` to `<accountId32>`.
 *
 * @param {string} vdfText
 * @returns {string | null}
 */
function parseActiveAccountIdFromLoginUsersVdf(vdfText) {
  if (!vdfText || typeof vdfText !== 'string') return null;

  const userBlockRegex = /"(\d{17})"\s*\{([^{}]*)\}/g;
  /** @type {{ accountId32: string, mostRecent: boolean, timestamp: number } | null} */
  let bestMostRecent = null;
  /** @type {{ accountId32: string, timestamp: number } | null} */
  let bestByTimestamp = null;

  let m;
  while ((m = userBlockRegex.exec(vdfText)) !== null) {
    const steamId64 = m[1];
    const body = m[2] || '';
    const accountId32 = steamId64ToAccountId32(steamId64);
    if (!accountId32) continue;

    const mrMatch = body.match(/"MostRecent"\s+"(\d+)"/i);
    const tsMatch = body.match(/"Timestamp"\s+"(\d+)"/i);
    const isMostRecent = Boolean(mrMatch && mrMatch[1] === '1');
    const timestamp = tsMatch ? Number(tsMatch[1]) || 0 : 0;

    if (isMostRecent) {
      if (!bestMostRecent || timestamp >= bestMostRecent.timestamp) {
        bestMostRecent = { accountId32, mostRecent: true, timestamp };
      }
    }
    if (!bestByTimestamp || timestamp > bestByTimestamp.timestamp) {
      bestByTimestamp = { accountId32, timestamp };
    }
  }

  if (bestMostRecent) {
    return bestMostRecent.accountId32;
  }
  if (bestByTimestamp && bestByTimestamp.timestamp > 0) {
    return bestByTimestamp.accountId32;
  }
  return null;
}

/**
 * Resolves ONLY the active Steam account's `<accountId32>` directory inside a `userdata` root:
 * 1. Explicit `options.activeAccountId32` or `options.activeSteamId64` / `options.steamId`
 * 2. Sibling `../config/loginusers.vdf` (`MostRecent "1"`)
 * 3. Fallback (ONLY when `loginusers.vdf` is absent/indeterminable): single `mtime`-newest `<accountId32>` dir
 *
 * @param {string} userdataBaseDir
 * @param {Record<string, any>} [options]
 * @returns {Promise<string[]>}
 */
async function resolveActiveSteamAccountDirs(userdataBaseDir, options = {}) {
  /** @type {string[]} */
  let entries = [];
  try {
    entries = await fs.promises.readdir(userdataBaseDir);
  } catch {
    return [];
  }

  const numericFolders = entries.filter((u) => /^[1-9]\d*$/.test(u));
  if (numericFolders.length === 0) return [];

  const explicitAccount32 =
    (typeof options.activeAccountId32 === 'string' || typeof options.activeAccountId32 === 'number'
      ? String(options.activeAccountId32).trim()
      : '') ||
    steamId64ToAccountId32(options.activeSteamId64 || options.steamId) ||
    '';

  if (explicitAccount32 && /^[1-9]\d*$/.test(explicitAccount32)) {
    return numericFolders.includes(explicitAccount32) ? [explicitAccount32] : [];
  }

  // Check sibling `config/loginusers.vdf`
  const loginUsersPath = path.join(path.dirname(userdataBaseDir), 'config', 'loginusers.vdf');
  let loginUsersPresent = false;
  try {
    const loginUsersContent = await fs.promises.readFile(loginUsersPath, 'utf8');
    loginUsersPresent = true;
    const activeFromVdf = parseActiveAccountIdFromLoginUsersVdf(loginUsersContent);
    if (activeFromVdf) {
      return numericFolders.includes(activeFromVdf) ? [activeFromVdf] : [];
    }
  } catch {
    loginUsersPresent = false;
  }

  if (loginUsersPresent) {
    // `loginusers.vdf` existed without any recognizable active user: pick newest single folder
    if (numericFolders.length === 1) return numericFolders;
  }

  if (numericFolders.length === 1) {
    return numericFolders;
  }

  // Fallback when `loginusers.vdf` is absent: select ONLY the single mtime-newest `userdata/<id>` dir
  /** @type {{ folder: string, mtimeMs: number } | null} */
  let newest = null;
  for (const folder of numericFolders) {
    let mtimeMs = 0;
    try {
      const cfgStat = await fs.promises.stat(
        path.join(userdataBaseDir, folder, 'config', 'localconfig.vdf')
      );
      mtimeMs = cfgStat.mtimeMs;
    } catch {
      try {
        const dirStat = await fs.promises.stat(path.join(userdataBaseDir, folder));
        mtimeMs = dirStat.mtimeMs;
      } catch {}
    }
    if (!newest || mtimeMs > newest.mtimeMs) {
      newest = { folder, mtimeMs };
    }
  }

  return newest ? [newest.folder] : [];
}

/**
 * Resolve all candidate Steam `userdata` directories across macOS (native + CrossOver/Wine bottles),
 * Windows (default + custom drive via `HKCU\Software\Valve\Steam`), and Linux.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<string[]>}
 */
async function resolveLocalSteamUserdataDirs(options = {}) {
  if (Array.isArray(options.userdataDirs) && options.userdataDirs.length > 0) {
    return Array.from(new Set(options.userdataDirs.filter(Boolean)));
  }
  const hasExplicitHome = Boolean(options.homedir);
  const home = options.homedir || os.homedir();
  /** @type {Set<string>} */
  const candidates = new Set([
    path.join(home, 'Library/Application Support/Steam/userdata'),
    path.join(home, '.local/share/Steam/userdata'),
    path.join(home, '.steam/steam/userdata'),
  ]);

  if (!hasExplicitHome) {
    candidates.add('C:\\Program Files (x86)\\Steam\\userdata');
    candidates.add('C:\\Program Files\\Steam\\userdata');
  } else {
    candidates.add(path.join(home, 'Steam', 'userdata'));
  }

  if ((options.platform || process.platform) === 'win32' && !hasExplicitHome) {
    const regPaths = discoverWindowsSteamRegistryPaths(options);
    if (regPaths.steamRoot) {
      candidates.add(path.win32.join(regPaths.steamRoot, 'userdata'));
    }
  } else if ((options.platform || process.platform) === 'darwin') {
    const bottleParents = [
      path.join(home, 'Library/Application Support/CrossOver/Bottles'),
      path.join(home, 'Library/Application Support/CrossOver Preview/Bottles'),
      path.join(home, 'Games/OneLauncher/Bottles'),
    ];
    for (const parent of bottleParents) {
      try {
        const entries = await fs.promises.readdir(parent);
        for (const entry of entries) {
          candidates.add(
            path.join(parent, entry, 'drive_c/Program Files (x86)/Steam/userdata')
          );
        }
      } catch {}
    }
  }

  return Array.from(candidates);
}

/**
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function buildScannerScopeKey(options = {}) {
  const homeKey = String(options.homedir || '');
  const customDirs = Array.isArray(options.userdataDirs) ? options.userdataDirs.join(';') : '';
  const acctKey = String(
    options.activeAccountId32 || options.activeSteamId64 || options.steamId || 'auto'
  );
  return `${homeKey}|${customDirs}|${acctKey}`;
}

/**
 * Asynchronously read local Steam playtimes (`Playtime` + `PlaytimeDisconnected`) from `localconfig.vdf`
 * scoped strictly to the active Steam user (`loginusers.vdf` `MostRecent "1"` or `activeSteamId64`).
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<number, { playtimeMinutes: number, lastPlayedEpoch: number }>>}
 */
async function readLocalSteamPlaytimes(options = {}) {
  const scopeKey = buildScannerScopeKey(options);
  const cached = cachedLocalSteamPlaytimesByScope.get(scopeKey);
  if (
    !options?.force &&
    cached &&
    Date.now() - cached.at < STEAM_LOCAL_SCAN_TTL_MS
  ) {
    return { ...cached.data };
  }

  /** @type {Record<number, { playtimeMinutes: number, lastPlayedEpoch: number }>} */
  const playtimes = {};
  try {
    const steamUserDirs = await resolveLocalSteamUserdataDirs(options);
    for (const base of steamUserDirs) {
      const userFolders = await resolveActiveSteamAccountDirs(base, options);
      for (const u of userFolders) {
        const vdfPath = path.join(base, u, 'config/localconfig.vdf');
        try {
          const st = await fs.promises.stat(vdfPath);
          const prev = steamLocalVdfMtimeCache.get(vdfPath);
          /** @type {Record<number, { playtimeMinutes: number, lastPlayedEpoch: number }>} */
          let filePlaytimes;
          if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
            filePlaytimes = prev.playtimes;
          } else {
            filePlaytimes = {};
            const vdf = await fs.promises.readFile(vdfPath, 'utf8');
            const regex = /"(\d+)"\s*\{([^{}]+)\}/g;
            let m;
            while ((m = regex.exec(vdf)) !== null) {
              const appId = Number(m[1]);
              const body = m[2];
              if (!appId || (!body.includes('"Playtime"') && !body.includes('"LastPlayed"'))) {
                continue;
              }
              const ptMatch = body.match(/"Playtime"\s+"(\d+)"/i);
              const ptDiscMatch = body.match(/"PlaytimeDisconnected"\s+"(\d+)"/i);
              const lpMatch = body.match(/"LastPlayed"\s+"(\d+)"/i);
              const totalMin =
                (ptMatch ? Number(ptMatch[1]) : 0) + (ptDiscMatch ? Number(ptDiscMatch[1]) : 0);
              const lpEpoch = lpMatch ? Number(lpMatch[1]) : 0;
              if (!filePlaytimes[appId] || totalMin >= filePlaytimes[appId].playtimeMinutes) {
                filePlaytimes[appId] = { playtimeMinutes: totalMin, lastPlayedEpoch: lpEpoch };
              }
            }
            steamLocalVdfMtimeCache.set(vdfPath, {
              mtimeMs: st.mtimeMs,
              size: st.size,
              playtimes: filePlaytimes,
            });
          }
          for (const [appIdKey, ptObj] of Object.entries(filePlaytimes)) {
            const appIdNum = Number(appIdKey);
            if (
              !playtimes[appIdNum] ||
              ptObj.playtimeMinutes >= playtimes[appIdNum].playtimeMinutes
            ) {
              playtimes[appIdNum] = ptObj;
            }
          }
        } catch {}
      }
    }
  } catch {}

  cachedLocalSteamPlaytimesByScope.set(scopeKey, { at: Date.now(), data: playtimes });
  return { ...playtimes };
}

/**
 * Reads binary `userdata/<accountId32>/config/shortcuts.vdf` paths strictly scoped to the
 * active Steam user (`loginusers.vdf` `MostRecent "1"` or `activeSteamId64`).
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<Array<{ appName: string, exe: string, startDir: string, accountId32: string }>>}
 */
async function readLocalSteamShortcuts(options = {}) {
  /** @type {Array<{ appName: string, exe: string, startDir: string, accountId32: string }>} */
  const shortcuts = [];
  try {
    const steamUserDirs = await resolveLocalSteamUserdataDirs(options);
    for (const base of steamUserDirs) {
      const userFolders = await resolveActiveSteamAccountDirs(base, options);
      for (const u of userFolders) {
        const shortcutsPath = path.join(base, u, 'config', 'shortcuts.vdf');
        try {
          const buf = await fs.promises.readFile(shortcutsPath);
          const rawStr = buf.toString('utf8');
          const entryRegex = /\x01AppName\x00([^\x00]*)\x00[\s\S]*?\x01Exe\x00([^\x00]*)\x00(?:\x01StartDir\x00([^\x00]*)\x00)?/gi;
          let m;
          while ((m = entryRegex.exec(rawStr)) !== null) {
            const appName = String(m[1] || '').trim();
            const exe = String(m[2] || '').replace(/^"+|"+$/g, '').trim();
            const startDir = String(m[3] || '').replace(/^"+|"+$/g, '').trim();
            if (appName && exe) {
              shortcuts.push({ appName, exe, startDir, accountId32: u });
            }
          }
        } catch {}
      }
    }
  } catch {}
  return shortcuts;
}

/**
 * Asynchronously scan local Steam client `userdata/<id>/config/librarycache` for achievement counts
 * scoped strictly to the active Steam user.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<number, { unlocked: number, total: number, percentage: number, isMastered: boolean }>>}
 */
async function scanLocalSteamAchievements(options = {}) {
  const scopeKey = buildScannerScopeKey(options);
  const cached = cachedLocalSteamAchievementsByScope.get(scopeKey);
  if (
    !options?.force &&
    cached &&
    Date.now() - cached.at < STEAM_LOCAL_SCAN_TTL_MS
  ) {
    return { ...cached.data };
  }

  /** @type {Record<number, { unlocked: number, total: number, percentage: number, isMastered: boolean }>} */
  const achievements = {};
  try {
    const steamUserDirs = await resolveLocalSteamUserdataDirs(options);
    for (const base of steamUserDirs) {
      const userFolders = await resolveActiveSteamAccountDirs(base, options);
      for (const u of userFolders) {
        const lcDir = path.join(base, u, 'config/librarycache');
        /** @type {string[]} */
        let files = [];
        try {
          files = await fs.promises.readdir(lcDir);
        } catch {
          continue;
        }

        const progressFile = path.join(lcDir, 'achievement_progress.json');
        if (files.includes('achievement_progress.json')) {
          try {
            const st = await fs.promises.stat(progressFile);
            const prevProg = steamLocalAchFileMtimeCache.get(progressFile);
            let progMap;
            if (prevProg && prevProg.mtimeMs === st.mtimeMs && prevProg.size === st.size) {
              progMap = prevProg.data;
            } else {
              progMap = {};
              const raw = JSON.parse(await fs.promises.readFile(progressFile, 'utf8'));
              if (Array.isArray(raw?.mapCache)) {
                for (const [appId, data] of raw.mapCache) {
                  if (
                    data &&
                    typeof data.unlocked === 'number' &&
                    typeof data.total === 'number' &&
                    data.total > 0
                  ) {
                    const pct = Math.round((data.unlocked / data.total) * 100);
                    progMap[appId] = {
                      unlocked: data.unlocked,
                      total: data.total,
                      percentage: pct,
                      isMastered: pct === 100,
                    };
                  }
                }
              }
              steamLocalAchFileMtimeCache.set(progressFile, {
                mtimeMs: st.mtimeMs,
                size: st.size,
                data: progMap,
              });
            }
            Object.assign(achievements, progMap);
          } catch {}
        }

        for (const file of files) {
          const m = file.match(/^(\d+)\.json$/);
          if (!m) continue;
          const appId = parseInt(m[1], 10);
          const fullAchPath = path.join(lcDir, file);
          try {
            const st = await fs.promises.stat(fullAchPath);
            const prevAch = steamLocalAchFileMtimeCache.get(fullAchPath);
            let parsedCounts = null;
            if (prevAch && prevAch.mtimeMs === st.mtimeMs && prevAch.size === st.size) {
              parsedCounts = prevAch.data;
            } else {
              const content = await fs.promises.readFile(fullAchPath, 'utf8');
              const mTotal = content.match(/"nTotal"\s*:\s*(\d+)/);
              const mAchieved = content.match(/"nAchieved"\s*:\s*(\d+)/);
              if (mTotal || mAchieved) {
                parsedCounts = {
                  total: mTotal ? parseInt(mTotal[1], 10) : 0,
                  unlocked: mAchieved ? parseInt(mAchieved[1], 10) : 0,
                };
              }
              if (steamLocalAchFileMtimeCache.size > 5000) {
                const oldestKey = steamLocalAchFileMtimeCache.keys().next().value;
                if (oldestKey !== undefined) steamLocalAchFileMtimeCache.delete(oldestKey);
              }
              steamLocalAchFileMtimeCache.set(fullAchPath, {
                mtimeMs: st.mtimeMs,
                size: st.size,
                data: parsedCounts,
              });
            }
            if (parsedCounts && (parsedCounts.total > 0 || parsedCounts.unlocked > 0)) {
              const { total, unlocked } = parsedCounts;
              if (!achievements[appId] || unlocked >= achievements[appId].unlocked) {
                const finalTotal = total > 0 ? total : achievements[appId]?.total || unlocked;
                const pct = finalTotal > 0 ? Math.round((unlocked / finalTotal) * 100) : 0;
                achievements[appId] = {
                  unlocked,
                  total: finalTotal,
                  percentage: pct,
                  isMastered: finalTotal > 0 && pct === 100,
                };
              }
            }
          } catch {}
        }
      }
    }
  } catch {}

  cachedLocalSteamAchievementsByScope.set(scopeKey, { at: Date.now(), data: achievements });
  return { ...achievements };
}

/**
 * Fetch batch Steam achievement progress using `IPlayerService/GetAchievementsProgress/v1` + local Steam cache.
 *
 * @param {string | undefined} webapiToken
 * @param {string | undefined} steamId
 * @param {Array<number | string>} [appIds]
 * @param {Record<string, any>} [options]
 */
async function fetchSteamBatchAchievements(webapiToken, steamId, appIds = [], options = {}) {
  const achievements = await scanLocalSteamAchievements({
    ...options,
    activeSteamId64: steamId || options.activeSteamId64,
  });
  if (!webapiToken || !steamId || !Array.isArray(appIds) || appIds.length === 0) {
    return achievements;
  }

  const fetchImpl = options.customFetch || options.fetchImpl || globalThis.fetch;
  const cleanIds = Array.from(new Set(appIds.map((id) => Number(id)).filter((id) => id > 0)));
  const CHUNK_SIZE = 100;
  for (let i = 0; i < cleanIds.length; i += CHUNK_SIZE) {
    const chunk = cleanIds.slice(i, i + CHUNK_SIZE);
    const appIdParams = chunk
      .map((id, idx) => `appids[${idx}]=${encodeURIComponent(String(id))}`)
      .join('&');
    const url = `https://api.steampowered.com/IPlayerService/GetAchievementsProgress/v1/?access_token=${encodeURIComponent(
      webapiToken
    )}&steamid=${encodeURIComponent(steamId)}&language=english&${appIdParams}`;
    try {
      const res = await fetchImpl(url, { signal: buildSteamFetchSignal(options.signal) });
      if (res.ok) {
        /** @type {{ response?: { achievement_progress?: Array<any> } } | null} */
        const json = /** @type {any} */ (await res.json());
        const list = json?.response?.achievement_progress;
        if (Array.isArray(list)) {
          for (const item of list) {
            const appId = Number(item.appid);
            const total = Number(item.total || 0);
            const unlocked = Number(item.unlocked || 0);
            if (appId > 0 && total > 0) {
              const prev = achievements[appId];
              const bestUnlocked = prev ? Math.max(unlocked, Number(prev.unlocked || 0)) : unlocked;
              const bestTotal = prev ? Math.max(total, Number(prev.total || 0)) : total;
              const pct = bestTotal > 0 ? Math.round((bestUnlocked / bestTotal) * 100) : 0;
              achievements[appId] = {
                unlocked: bestUnlocked,
                total: bestTotal,
                percentage: pct,
                isMastered:
                  Boolean(item.all_unlocked) || (bestTotal > 0 && bestUnlocked >= bestTotal),
              };
            }
          }
        }
      }
    } catch {}
  }

  return achievements;
}

/**
 * Fetch batch Steam store asset hashes using public `IStoreBrowseService/GetItems/v1`.
 *
 * @param {Array<number | string>} [appIds]
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function fetchSteamStoreBrowseItemsMap(appIds = [], options = {}) {
  /** @type {Record<string, any>} */
  const storeItems = {};
  if (!Array.isArray(appIds) || appIds.length === 0) return storeItems;
  const fetchImpl = options.customFetch || options.fetchImpl || globalThis.fetch;
  const cleanIds = Array.from(new Set(appIds.map((id) => Number(id)).filter((id) => id > 0)));
  const CHUNK_SIZE = 100;
  for (let i = 0; i < cleanIds.length; i += CHUNK_SIZE) {
    const chunk = cleanIds.slice(i, i + CHUNK_SIZE);
    const inputJson = JSON.stringify({
      ids: chunk.map((appid) => ({ appid })),
      context: { language: 'english', country_code: 'US' },
      data_request: { include_assets: true },
    });
    const url = `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(
      inputJson
    )}`;
    try {
      const res = await fetchImpl(url, { signal: buildSteamFetchSignal(options.signal) });
      if (res.ok) {
        /** @type {{ response?: { store_items?: Array<any> } } | null} */
        const json = /** @type {any} */ (await res.json());
        const items = json?.response?.store_items;
        if (Array.isArray(items)) {
          for (const item of items) {
            if (item?.appid && item?.assets) {
              storeItems[String(item.appid)] = item.assets;
            }
          }
        }
      }
    } catch {}
  }
  return storeItems;
}

/**
 * Convert Steam web gameslist JSON into CanonicalGame objects.
 *
 * @param {any} rawJsonStr
 * @param {string | undefined} steamId
 * @param {string | undefined} personaName
 * @param {string | undefined} avatarUrl
 * @param {any[]} [existingGames]
 * @param {any} [storeSync]
 * @param {Record<string, any>} [options]
 */
async function parseSteamGamesListJson(
  rawJsonStr,
  steamId,
  personaName,
  avatarUrl,
  existingGames = [],
  storeSync = null,
  options = {}
) {
  const parsed = typeof rawJsonStr === 'string' ? JSON.parse(rawJsonStr) : rawJsonStr;
  const rgGames = Array.isArray(parsed?.rgGames)
    ? parsed.rgGames
    : Array.isArray(parsed?.games)
      ? parsed.games
      : Array.isArray(parsed)
        ? parsed
        : [];
  const storeItems = (parsed && typeof parsed.storeItems === 'object' && parsed.storeItems) || {};
  const existingByAppId = new Map();
  if (Array.isArray(existingGames)) {
    for (const eg of existingGames) {
      if (eg && eg.steamAppId) {
        existingByAppId.set(Number(eg.steamAppId), eg);
      }
    }
  }
  const resolvedName = parsed?.strProfileName || personaName || 'Steam User';
  const scanOpts = { ...options, activeSteamId64: steamId || options.activeSteamId64 };
  const [localPlaytimes, localAchievements] = await Promise.all([
    readLocalSteamPlaytimes(scanOpts),
    scanLocalSteamAchievements(scanOpts),
  ]);
  const games = [];
  const suppressedItems = [];

  for (const g of rgGames) {
    const appId = Number(g.appid);
    const title = (g.name || '').trim();
    if (!appId || !title) continue;

    const cloudPlaytime = Number(g.playtime_forever || 0) + Number(g.playtime_disconnected || 0);
    const localPt = localPlaytimes[appId];
    const playtimeMinutes = Math.max(cloudPlaytime, localPt ? localPt.playtimeMinutes : 0);
    const lastPlayedEpoch = Number(
      g.rtime_last_played || (localPt ? localPt.lastPlayedEpoch : 0) || 0
    );
    const lastPlayed =
      lastPlayedEpoch > 0 ? new Date(lastPlayedEpoch * 1000).toISOString() : undefined;
    const ach = localAchievements[appId];

    const si = storeItems[String(appId)];
    const existingGame = existingByAppId.get(appId);
    const assetFormat = (si && si.asset_url_format) || `steam/apps/${appId}/\${FILENAME}`;
    /** @param {string} filename */
    const buildAssetUrl = (filename) =>
      `https://shared.akamai.steamstatic.com/store_item_assets/${assetFormat.replace('${FILENAME}', filename)}`;

    const headerFile = (si && si.header) || 'header.jpg';
    const capsuleFile =
      (si && (si.library_capsule || si.library_capsule_2x)) ||
      (typeof g.capsule_filename === 'string' && g.capsule_filename.includes('/')
        ? g.capsule_filename
        : 'library_600x900.jpg');

    const rawIconHash =
      (si && si.community_icon) ||
      (typeof g.img_icon_url === 'string' && g.img_icon_url.trim()) ||
      '';
    const resolvedIconUrl = rawIconHash
      ? rawIconHash.startsWith('http')
        ? rawIconHash
        : `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/${appId}/${
            rawIconHash.endsWith('.jpg') ? rawIconHash : `${rawIconHash}.jpg`
          }`
      : existingGame?.iconUrl;

    const builtHeader = buildAssetUrl(headerFile);
    const builtCapsule = buildAssetUrl(capsuleFile);
    const finalHeader =
      !si &&
      existingGame?.headerImage &&
      /\/apps\/\d+\/[a-f0-9]{40}\//i.test(existingGame.headerImage)
        ? existingGame.headerImage
        : builtHeader;
    const finalCapsule =
      !si &&
      existingGame?.capsuleImage &&
      /\/apps\/\d+\/[a-f0-9]{40}\//i.test(existingGame.capsuleImage) &&
      !existingGame.capsuleImage.includes('184x69')
        ? existingGame.capsuleImage
        : builtCapsule;

    const gameObj = {
      id: `steam-${appId}`,
      title,
      originalStoreTitle: title,
      sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
      steamAppId: appId,
      isVerifiedEntitlement: true,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: String(appId),
          originalTitle: title,
          installed: false,
          playtimeMinutes,
          lastPlayed,
          achievements: ach
            ? {
                unlocked: ach.unlocked,
                total: ach.total,
                percentage: ach.percentage,
                isMastered: ach.isMastered,
              }
            : undefined,
        },
      ],
      headerImage: finalHeader,
      capsuleImage: finalCapsule,
      iconUrl: resolvedIconUrl,
      shortDescription: '',
      releaseDate: 'Released',
      developers: [],
      publishers: [],
      genres: [],
      tags: ['Steam'],
    };

    const nonGameReason =
      storeSync && typeof storeSync.classifyNonGameStorefrontItem === 'function'
        ? storeSync.classifyNonGameStorefrontItem({
            title,
            platformId: 'steam',
            platformGameId: String(appId),
            isDlc: false,
          })
        : null;

    if (nonGameReason) {
      suppressedItems.push({
        id: `steam-${appId}`,
        rawTitle: title,
        platformId: 'steam',
        platformGameId: String(appId),
        reason: nonGameReason,
        reasonCategory: 'non_game_filter',
        rawGame: gameObj,
      });
      continue;
    }

    games.push(gameObj);
  }

  return {
    accountName: resolvedName,
    accountId: steamId,
    avatarUrl,
    games,
    suppressedItems,
  };
}

module.exports = {
  steamId64ToAccountId32,
  parseActiveAccountIdFromLoginUsersVdf,
  resolveActiveSteamAccountDirs,
  resolveLocalSteamUserdataDirs,
  readLocalSteamPlaytimes,
  readLocalSteamShortcuts,
  scanLocalSteamAchievements,
  fetchSteamBatchAchievements,
  fetchSteamStoreBrowseItemsMap,
  parseSteamGamesListJson,
  trimSteamLocalScannerMemory,
};
