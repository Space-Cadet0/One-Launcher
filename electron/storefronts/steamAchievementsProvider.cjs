// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveLocalSteamUserdataDirs } = require('./steamLocalScanner.cjs');

const STEAM_ACH_HTTP_TIMEOUT_MS = 12_000;
const MAX_VDF_FILE_BYTES = 16 * 1024 * 1024; // 16 MB hard cap (C2)
const MAX_VDF_RECURSION_DEPTH = 16; // Recursion depth hard cap (C2)
const STEAM_ID64_BASE = BigInt('76561197960265728');
const STEAM_ACH_ICON_BASE = 'https://shared.fastly.steamstatic.com/community_assets/images/apps';

/**
 * @param {number | null | undefined} percentage
 * @returns {'ultra_rare' | 'rare' | 'uncommon' | 'common'}
 */
function classifyRarityTier(percentage) {
  if (typeof percentage !== 'number' || !Number.isFinite(percentage)) return 'common';
  if (percentage < 10) return 'ultra_rare';
  if (percentage < 25) return 'rare';
  if (percentage < 50) return 'uncommon';
  return 'common';
}

/**
 * @param {AbortSignal | undefined} callerSignal
 * @param {number} [timeoutMs]
 * @returns {AbortSignal | undefined}
 */
function buildFetchSignal(callerSignal, timeoutMs = STEAM_ACH_HTTP_TIMEOUT_MS) {
  const timeoutSignal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  if (callerSignal && timeoutSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  return callerSignal || timeoutSignal;
}

/**
 * Convert a 17-digit SteamID64 string to 32-bit account ID string.
 * @param {string | number | undefined | null} steamId64
 * @returns {string}
 */
function steamId64ToAccountId32(steamId64) {
  const clean = String(steamId64 || '').trim();
  if (!/^\d{17}$/.test(clean)) return '';
  try {
    const val = BigInt(clean);
    if (val <= STEAM_ID64_BASE) return '';
    return String(val - STEAM_ID64_BASE);
  } catch {
    return '';
  }
}

/**
 * @param {number} appId
 * @param {string | undefined | null} rawIcon
 * @returns {string}
 */
function buildSteamAchievementIconUrl(appId, rawIcon) {
  const clean = String(rawIcon || '').trim();
  if (!clean) return '';
  if (/^https?:\/\//i.test(clean)) {
    return clean.startsWith('http://') ? `https://${clean.slice(7)}` : clean;
  }
  if (clean.startsWith('//')) return `https:${clean}`;
  return `${STEAM_ACH_ICON_BASE}/${appId}/${clean.replace(/^\/+/, '')}`;
}

/**
 * Pick localized string from a VDF `display.name` / `display.desc` field (either plain string or language map).
 * @param {unknown} value
 * @returns {string}
 */
function pickVdfLocalizedString(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const rec = /** @type {Record<string, unknown>} */ (value);
    for (const key of ['english', 'English', 'en', 'en-US']) {
      if (typeof rec[key] === 'string' && rec[key].trim()) {
        return rec[key].trim();
      }
    }
    for (const val of Object.values(rec)) {
      if (typeof val === 'string' && val.trim()) {
        return val.trim();
      }
    }
  }
  return '';
}

/**
 * Pure-JS bounded parser for Steam Binary KeyValues (`.bin` files in `appcache/stats/`).
 * Enforces `<= 16 MB` buffer size and `<= 16` recursion depth (`C2`).
 *
 * @param {Buffer | Uint8Array} input
 * @param {{ maxBytes?: number, maxDepth?: number }} [options]
 * @returns {Record<string, any>}
 */
function parseBinaryVdf(input, options = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const maxBytes =
    typeof options.maxBytes === 'number' && options.maxBytes > 0
      ? options.maxBytes
      : MAX_VDF_FILE_BYTES;
  const maxDepth =
    typeof options.maxDepth === 'number' && options.maxDepth > 0
      ? options.maxDepth
      : MAX_VDF_RECURSION_DEPTH;

  if (buf.length > maxBytes) {
    throw new Error(`Binary VDF exceeds safety cap (${buf.length} > ${maxBytes} bytes)`);
  }

  let offset = 0;

  const readCString = () => {
    const start = offset;
    while (offset < buf.length && buf[offset] !== 0) {
      offset++;
    }
    const str = buf.toString('utf8', start, offset);
    if (offset < buf.length && buf[offset] === 0) {
      offset++;
    }
    return str;
  };

  const readWideCString = () => {
    const start = offset;
    while (offset + 1 < buf.length && !(buf[offset] === 0 && buf[offset + 1] === 0)) {
      offset += 2;
    }
    const str = buf.toString('utf16le', start, offset);
    if (offset + 1 < buf.length && buf[offset] === 0 && buf[offset + 1] === 0) {
      offset += 2;
    }
    return str;
  };

  /**
   * @param {number} depth
   * @returns {Record<string, any>}
   */
  const parseMap = (depth) => {
    if (depth > maxDepth) {
      throw new Error(`Binary VDF nesting depth exceeds limit (${maxDepth})`);
    }
    /** @type {Record<string, any>} */
    const out = Object.create(null);

    while (offset < buf.length) {
      const type = buf[offset++];
      if (type === 0x08 || type === 0x0b) {
        break;
      }
      if (offset >= buf.length) break;
      const key = readCString();

      if (type === 0x00) {
        out[key] = parseMap(depth + 1);
      } else if (type === 0x01) {
        out[key] = readCString();
      } else if (type === 0x02) {
        if (offset + 4 > buf.length) break;
        out[key] = buf.readInt32LE(offset);
        offset += 4;
      } else if (type === 0x03) {
        if (offset + 4 > buf.length) break;
        out[key] = buf.readFloatLE(offset);
        offset += 4;
      } else if (type === 0x04 || type === 0x06) {
        if (offset + 4 > buf.length) break;
        out[key] = buf.readUInt32LE(offset);
        offset += 4;
      } else if (type === 0x05) {
        out[key] = readWideCString();
      } else if (type === 0x07) {
        if (offset + 8 > buf.length) break;
        const big = buf.readBigUInt64LE(offset);
        offset += 8;
        out[key] = big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString();
      } else {
        // Unknown binary VDF type marker: halt cleanly to prevent desync loop
        break;
      }
    }

    return out;
  };

  return parseMap(0);
}

/**
 * Derive all candidate Steam `appcache/stats/` directories across macOS native Steam,
 * CrossOver / CrossOver Preview / OneLauncher bottles, Windows Registry Steam, and Linux (`C12`).
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<string[]>}
 */
async function resolveLocalSteamAppcacheStatsDirs(options = {}) {
  if (Array.isArray(options.statsDirs) && options.statsDirs.length > 0) {
    return Array.from(new Set(options.statsDirs.filter(Boolean)));
  }
  const userdataDirs = await resolveLocalSteamUserdataDirs(options);
  /** @type {Set<string>} */
  const statsDirs = new Set();
  for (const ud of userdataDirs) {
    if (!ud || typeof ud !== 'string') continue;
    const steamRoot = path.dirname(ud);
    if (steamRoot) {
      statsDirs.add(path.join(steamRoot, 'appcache', 'stats'));
    }
  }
  return Array.from(statsDirs);
}

/**
 * Find the newest existing file matching `predicate` across all `dirs` (`mtimeMs` descending).
 *
 * @param {string[]} dirs
 * @param {(fileName: string) => boolean} predicate
 * @returns {Promise<{ filePath: string, mtimeMs: number, size: number } | null>}
 */
async function findNewestStatsFile(dirs, predicate) {
  /** @type {{ filePath: string, mtimeMs: number, size: number } | null} */
  let newest = null;
  for (const dir of dirs) {
    /** @type {string[]} */
    let files = [];
    try {
      files = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const fileName of files) {
      if (!predicate(fileName)) continue;
      const fullPath = path.join(dir, fileName);
      try {
        const st = await fs.promises.stat(fullPath);
        if (!st.isFile() || st.size <= 0 || st.size > MAX_VDF_FILE_BYTES) continue;
        if (!newest || st.mtimeMs > newest.mtimeMs) {
          newest = { filePath: fullPath, mtimeMs: st.mtimeMs, size: st.size };
        }
      } catch {}
    }
  }
  return newest;
}

/**
 * Read and join local Steam binary VDF `UserGameStatsSchema_<appId>.bin` +
 * `UserGameStats_<accountId32>_<appId>.bin` across all native + bottle Steam roots.
 *
 * @param {number} appId
 * @param {Record<string, any>} [options]
 * @returns {Promise<{
 *   achievements: Array<Record<string, any>>,
 *   statMappings: Map<string, { statName: string, minVal: number, maxVal: number }>,
 *   hasUserStatsFile: boolean,
 *   schemaFound: boolean,
 *   unlockedCount: number,
 *   totalCount: number,
 *   userFilePath?: string,
 *   schemaFilePath?: string,
 * } | null>}
 */
async function readLocalSteamBinaryVdfAchievements(appId, options = {}) {
  const cleanAppId = Number(appId);
  if (!Number.isFinite(cleanAppId) || cleanAppId <= 0) return null;

  const statsDirs = await resolveLocalSteamAppcacheStatsDirs(options);
  if (statsDirs.length === 0) return null;

  const schemaFileNameLower = `usergamestatsschema_${cleanAppId}.bin`;
  const accountId32 =
    String(options.accountId32 || '').trim() ||
    steamId64ToAccountId32(options.steamId || options.activeSteamId64);

  const [schemaHit, userHit] = await Promise.all([
    findNewestStatsFile(statsDirs, (f) => f.toLowerCase() === schemaFileNameLower),
    findNewestStatsFile(statsDirs, (f) => {
      const lower = f.toLowerCase();
      if (accountId32) {
        return lower === `usergamestats_${accountId32}_${cleanAppId}.bin`;
      }
      return new RegExp(`^usergamestats_\\d+_${cleanAppId}\\.bin$`, 'i').test(lower);
    }),
  ]);

  if (!schemaHit) return null;

  let schemaRoot;
  try {
    const rawSchema = await fs.promises.readFile(schemaHit.filePath);
    schemaRoot = parseBinaryVdf(rawSchema);
  } catch {
    return null;
  }

  const appNode =
    schemaRoot[String(cleanAppId)] ||
    Object.values(schemaRoot).find((v) => v && typeof v === 'object' && v.stats);
  if (!appNode || typeof appNode !== 'object' || !appNode.stats || typeof appNode.stats !== 'object') {
    return null;
  }

  let userCache = null;
  let hasUserStatsFile = false;
  if (userHit) {
    try {
      const rawUser = await fs.promises.readFile(userHit.filePath);
      const parsedUser = parseBinaryVdf(rawUser);
      const userRoot =
        parsedUser[String(cleanAppId)] ||
        parsedUser.cache ||
        parsedUser.UserGameStats ||
        parsedUser;
      if (userRoot && typeof userRoot === 'object') {
        userCache =
          userRoot.cache && typeof userRoot.cache === 'object' ? userRoot.cache : userRoot;
        hasUserStatsFile = true;
      }
    } catch {}
  }

  /** @type {Map<string, string>} statNameLower -> statId */
  const statIdByName = new Map();
  /** @type {Map<string, number>} statId -> numeric value */
  const statValuesById = new Map();
  /** @type {Array<{ statId: string, bitIdx: number, def: Record<string, any> }>} */
  const achievementDefs = [];

  for (const [statIdKey, statEntry] of Object.entries(appNode.stats)) {
    if (!statEntry || typeof statEntry !== 'object') continue;
    const statType = Number(statEntry.type ?? 0);
    const statBits = statEntry.bits && typeof statEntry.bits === 'object' ? statEntry.bits : null;

    if (statType === 4 || statBits) {
      if (statBits) {
        const sortedBitKeys = Object.keys(statBits).sort((a, b) => Number(a) - Number(b));
        for (const bitKey of sortedBitKeys) {
          const bitIdx = Number(bitKey);
          const bitDef = statBits[bitKey];
          if (!Number.isFinite(bitIdx) || bitIdx < 0 || bitIdx > 31 || !bitDef || typeof bitDef !== 'object') {
            continue;
          }
          achievementDefs.push({ statId: String(statIdKey), bitIdx, def: bitDef });
        }
      }
    } else {
      const sName = String(statEntry.name || '').trim();
      if (sName) {
        statIdByName.set(sName.toLowerCase(), String(statIdKey));
      }
      if (userCache && userCache[statIdKey] && typeof userCache[statIdKey] === 'object') {
        const rawVal = Number(userCache[statIdKey].data);
        if (Number.isFinite(rawVal)) {
          statValuesById.set(String(statIdKey), rawVal);
        }
      }
    }
  }

  /** @type {Map<string, { statName: string, minVal: number, maxVal: number }>} */
  const statMappings = new Map();
  /** @type {Array<Record<string, any>>} */
  const achievements = [];

  for (const { statId, bitIdx, def } of achievementDefs) {
    const apiName = String(def.name || `ACH_${statId}_${bitIdx}`).trim();
    const display = def.display && typeof def.display === 'object' ? def.display : {};
    const name = pickVdfLocalizedString(display.name) || apiName;
    const description = pickVdfLocalizedString(display.desc) || undefined;
    const hiddenRaw = display.hidden;
    const isSecret = hiddenRaw === 1 || hiddenRaw === '1' || hiddenRaw === true;
    const iconUnlockedUrl = buildSteamAchievementIconUrl(cleanAppId, display.icon);
    const iconLockedUrl =
      buildSteamAchievementIconUrl(cleanAppId, display.icon_gray) || iconUnlockedUrl;

    let unlocked = false;
    /** @type {number | undefined} */
    let unlockedAt = undefined;

    if (hasUserStatsFile && userCache && userCache[statId] && typeof userCache[statId] === 'object') {
      const bucket = userCache[statId];
      const bitmask = Number(bucket.data ?? 0);
      // Unsigned right shift avoids JS signed 32-bit `1 << 31` sign-bit overflow (`C12`)
      unlocked = ((bitmask >>> bitIdx) & 1) === 1;
      const timesMap =
        bucket.AchievementTimes && typeof bucket.AchievementTimes === 'object'
          ? bucket.AchievementTimes
          : null;
      if (unlocked && timesMap) {
        const rawTs = Number(timesMap[String(bitIdx)] ?? 0);
        if (Number.isFinite(rawTs) && rawTs > 0) {
          unlockedAt = rawTs * 1000;
        }
      }
    }

    /** @type {{ current: number, max: number, percentage: number } | undefined} */
    let progress = undefined;
    const progSpec = def.progress && typeof def.progress === 'object' ? def.progress : null;
    if (progSpec) {
      const minVal = Number(progSpec.min_val ?? 0);
      const maxVal = Number(progSpec.max_val ?? 0);
      const operand1 = String(progSpec.value?.operand1 || '').trim();
      if (operand1 && Number.isFinite(maxVal) && maxVal > minVal) {
        statMappings.set(apiName.toLowerCase(), {
          statName: operand1,
          minVal: Number.isFinite(minVal) ? minVal : 0,
          maxVal,
        });
        if (!unlocked && hasUserStatsFile) {
          const linkedStatId = statIdByName.get(operand1.toLowerCase());
          const rawStatVal = linkedStatId !== undefined ? statValuesById.get(linkedStatId) : undefined;
          if (typeof rawStatVal === 'number' && Number.isFinite(rawStatVal) && rawStatVal > minVal) {
            const safeMin = Number.isFinite(minVal) ? minVal : 0;
            const span = maxVal - safeMin;
            const clamped = Math.min(maxVal, Math.max(safeMin, rawStatVal));
            if (span > 0 && clamped > safeMin) {
              const current = Number.isInteger(clamped)
                ? clamped
                : Number(clamped.toFixed(1));
              const percentage = Math.min(99, Math.max(1, Math.round(((clamped - safeMin) / span) * 100)));
              progress = { current, max: maxVal, percentage };
            }
          }
        }
      }
    }

    achievements.push({
      id: `steam:${cleanAppId}:${apiName}`,
      apiName,
      name,
      description,
      unlocked,
      ...(unlockedAt ? { unlockedAt } : {}),
      iconUnlockedUrl,
      iconLockedUrl,
      ...(progress ? { progress } : {}),
      isSecret,
      isBaseGame: true,
      storefrontId: 'steam',
    });
  }

  const unlockedCount = achievements.filter((a) => a.unlocked).length;
  return {
    achievements,
    statMappings,
    hasUserStatsFile,
    schemaFound: true,
    unlockedCount,
    totalCount: achievements.length,
    schemaFilePath: schemaHit.filePath,
    ...(userHit ? { userFilePath: userHit.filePath } : {}),
  };
}

/**
 * Extract a balanced JSON string literal starting at `quoteStartIndex` (pointing at `"`).
 * @param {string} text
 * @param {number} quoteStartIndex
 * @returns {{ rawLiteral: string, endIndex: number } | null}
 */
function extractJsonStringLiteral(text, quoteStartIndex) {
  if (text[quoteStartIndex] !== '"') return null;
  let i = quoteStartIndex + 1;
  let escaped = false;
  while (i < text.length) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '"') {
      return { rawLiteral: text.slice(quoteStartIndex, i + 1), endIndex: i + 1 };
    }
    i++;
  }
  return null;
}

/**
 * Extract a balanced JSON object literal `{ ... }` starting at `braceStartIndex` (pointing at `{`).
 * @param {string} text
 * @param {number} braceStartIndex
 * @returns {{ rawObject: string, endIndex: number } | null}
 */
function extractBalancedJsonObject(text, braceStartIndex) {
  if (text[braceStartIndex] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceStartIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return { rawObject: text.slice(braceStartIndex, i + 1), endIndex: i + 1 };
      }
    }
  }
  return null;
}

/**
 * Extract dehydrated React Query `renderContext.queryData` from Steam Community SSR HTML
 * using balanced JSON string/object scanning (`C12`) rather than a greedy regex.
 *
 * @param {string} html
 * @returns {{ queries: Array<any> } | null}
 */
function extractSteamSsrQueryData(html) {
  if (typeof html !== 'string' || !html) return null;

  let searchFrom = 0;
  while (searchFrom < html.length) {
    const keyIdx = html.indexOf('"queryData"', searchFrom);
    if (keyIdx === -1) break;
    searchFrom = keyIdx + 11;

    let colonIdx = keyIdx + 11;
    while (colonIdx < html.length && /\s/.test(html[colonIdx])) colonIdx++;
    if (html[colonIdx] !== ':') continue;

    let valIdx = colonIdx + 1;
    while (valIdx < html.length && /\s/.test(html[valIdx])) valIdx++;

    if (html[valIdx] === '"') {
      const lit = extractJsonStringLiteral(html, valIdx);
      if (!lit) continue;
      try {
        const unescaped = JSON.parse(lit.rawLiteral);
        if (typeof unescaped === 'string') {
          const parsed = JSON.parse(unescaped);
          if (parsed && Array.isArray(parsed.queries)) {
            return parsed;
          }
        }
      } catch {}
    } else if (html[valIdx] === '{') {
      const obj = extractBalancedJsonObject(html, valIdx);
      if (!obj) continue;
      try {
        const parsed = JSON.parse(obj.rawObject);
        if (parsed && Array.isArray(parsed.queries)) {
          return parsed;
        }
      } catch {}
    }
  }

  return null;
}

/**
 * Parse Steam Community `/profiles/<id>/achievements/<appId>` or `/id/<vanity>/achievements/<appId>` SSR HTML
 * using structural matching (`C12`) across schema groups, user unlocks/progress, and global percentages.
 *
 * @param {string} html
 * @param {number} appId
 * @returns {{
 *   achievements: Array<Record<string, any>>,
 *   hasSchemaQuery: boolean,
 *   hasUserQuery: boolean,
 *   isPrivateProfile: boolean,
 *   unlockedCount: number,
 *   totalCount: number,
 *   percentagesByKey: Map<string, number>,
 * } | null}
 */
function parseSteamAchievementsSsrHtml(html, appId) {
  if (typeof html !== 'string' || !html) return null;
  const cleanAppId = Number(appId);
  const isPrivateMarker =
    /profile_private_info|This profile is private|The specified profile could not be found/i.test(
      html
    );

  const queryData = extractSteamSsrQueryData(html);
  if (!queryData || !Array.isArray(queryData.queries)) {
    return isPrivateMarker
      ? {
          achievements: [],
          hasSchemaQuery: false,
          hasUserQuery: false,
          isPrivateProfile: true,
          unlockedCount: 0,
          totalCount: 0,
          percentagesByKey: new Map(),
        }
      : null;
  }

  /** @type {Array<Record<string, any>> | null} */
  let schemaGroups = null;
  /** @type {Record<string, any> | null} */
  let userAchievementsMap = null;
  let userQueryErrored = false;
  /** @type {Record<string, any> | null} */
  let globalPercentagesObj = null;

  for (const q of queryData.queries) {
    if (!q || typeof q !== 'object') continue;
    const state = q.state && typeof q.state === 'object' ? q.state : null;
    const data = state?.data && typeof state.data === 'object' ? state.data : null;

    if (data && Array.isArray(data.groups)) {
      schemaGroups = data.groups;
      continue;
    }

    if (
      data &&
      data.percentages &&
      typeof data.percentages === 'object' &&
      !Array.isArray(data.percentages)
    ) {
      globalPercentagesObj = data.percentages;
      continue;
    }

    if (
      data &&
      data.achievements &&
      typeof data.achievements === 'object' &&
      !Array.isArray(data.achievements)
    ) {
      if (state?.status === 'error') {
        userQueryErrored = true;
      } else {
        userAchievementsMap = data.achievements;
      }
      continue;
    }

    const qk = Array.isArray(q.queryKey) ? q.queryKey.map((x) => String(x).toLowerCase()) : [];
    if (qk.some((k) => k.includes('user_achievements')) && state?.status === 'error') {
      userQueryErrored = true;
    }
  }

  /** @type {Map<string, number>} */
  const percentagesByKey = new Map();
  if (globalPercentagesObj) {
    for (const [k, rawPct] of Object.entries(globalPercentagesObj)) {
      const pctNum = Number(rawPct);
      if (Number.isFinite(pctNum)) {
        percentagesByKey.set(String(k), Number(pctNum.toFixed(1)));
      }
    }
  }

  if (!schemaGroups) {
    return {
      achievements: [],
      hasSchemaQuery: false,
      hasUserQuery: Boolean(userAchievementsMap) && !userQueryErrored,
      isPrivateProfile: isPrivateMarker || userQueryErrored,
      unlockedCount: 0,
      totalCount: 0,
      percentagesByKey,
    };
  }

  // Secondary lookup by api_name in case user_achievements keys are api_names rather than internal_key
  /** @type {Map<string, any>} */
  const userByApiName = new Map();
  if (userAchievementsMap) {
    for (const [k, entry] of Object.entries(userAchievementsMap)) {
      if (entry && typeof entry === 'object') {
        if (entry.api_name) {
          userByApiName.set(String(entry.api_name).toLowerCase(), entry);
        }
        userByApiName.set(String(k).toLowerCase(), entry);
      }
    }
  }

  /** @type {Array<Record<string, any>>} */
  const achievements = [];

  for (const group of schemaGroups) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.achievements)) continue;
    const dlcAppId = Number(group.dlcappid || group.dlc_appid || 0);
    const isBaseGame = !(Number.isFinite(dlcAppId) && dlcAppId > 0);
    const groupIdStr =
      group.groupid !== undefined && group.groupid !== null ? String(group.groupid) : undefined;

    for (const item of group.achievements) {
      if (!item || typeof item !== 'object') continue;
      const internalKey =
        item.internal_key !== undefined && item.internal_key !== null
          ? String(item.internal_key)
          : '';
      const apiName = String(item.api_name || item.internal_name || internalKey || '').trim();
      const userEntry =
        (internalKey && userAchievementsMap ? userAchievementsMap[internalKey] : undefined) ||
        (apiName ? userByApiName.get(apiName.toLowerCase()) : undefined);

      const unlocked = Boolean(userEntry?.unlocked);
      const rawUnlockTime = Number(userEntry?.unlock_time ?? 0);
      const unlockedAt =
        unlocked && Number.isFinite(rawUnlockTime) && rawUnlockTime > 0
          ? rawUnlockTime * 1000
          : undefined;

      const minProgress = Number(item.min_progress ?? item.min_progress_int ?? 0);
      const maxProgress = Number(item.max_progress ?? item.max_progress_int ?? 0);
      const userProgressVal =
        userEntry && typeof userEntry.progress === 'number' && Number.isFinite(userEntry.progress)
          ? userEntry.progress
          : undefined;

      /** @type {{ current: number, max: number, percentage: number } | undefined} */
      let progress = undefined;
      if (
        !unlocked &&
        userProgressVal !== undefined &&
        Number.isFinite(maxProgress) &&
        maxProgress > minProgress &&
        userProgressVal > minProgress
      ) {
        const safeMin = Number.isFinite(minProgress) ? minProgress : 0;
        const span = maxProgress - safeMin;
        const clamped = Math.min(maxProgress, Math.max(safeMin, userProgressVal));
        if (span > 0 && clamped > safeMin) {
          const percentage = Math.min(
            99,
            Math.max(1, Math.round(((clamped - safeMin) / span) * 100))
          );
          progress = {
            current: Number.isInteger(clamped) ? clamped : Number(clamped.toFixed(1)),
            max: maxProgress,
            percentage,
          };
        }
      }

      const globalPercentage =
        (internalKey ? percentagesByKey.get(internalKey) : undefined) ??
        (apiName ? percentagesByKey.get(apiName) : undefined);

      const iconUnlockedUrl = buildSteamAchievementIconUrl(
        cleanAppId,
        item.icon_achieved || item.icon
      );
      const iconLockedUrl =
        buildSteamAchievementIconUrl(cleanAppId, item.icon_unachieved || item.icon_gray) ||
        iconUnlockedUrl;

      achievements.push({
        id: `steam:${cleanAppId}:${apiName || internalKey || achievements.length}`,
        apiName: apiName || internalKey || `ACH_${achievements.length + 1}`,
        name: String(item.name || item.localized_name || apiName || `Achievement #${achievements.length + 1}`),
        description: String(item.description || item.localized_desc || '').trim() || undefined,
        unlocked,
        ...(unlockedAt ? { unlockedAt } : {}),
        iconUnlockedUrl,
        iconLockedUrl,
        ...(globalPercentage !== undefined
          ? { globalPercentage, rarityTier: classifyRarityTier(globalPercentage) }
          : {}),
        ...(progress ? { progress } : {}),
        isSecret: Boolean(item.hidden),
        isBaseGame,
        ...(groupIdStr ? { achievementSetId: groupIdStr } : {}),
        storefrontId: 'steam',
      });
    }
  }

  const unlockedCount = achievements.filter((a) => a.unlocked).length;
  return {
    achievements,
    hasSchemaQuery: true,
    hasUserQuery: Boolean(userAchievementsMap) && !userQueryErrored,
    isPrivateProfile: isPrivateMarker || userQueryErrored || !userAchievementsMap,
    unlockedCount,
    totalCount: achievements.length,
    percentagesByKey,
  };
}

/**
 * Official zero-auth REST JSON schema: `IPlayerService/GetGameAchievements/v1`.
 *
 * @param {number} appId
 * @param {{ fetchFn?: typeof fetch, signal?: AbortSignal, language?: string }} [options]
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function fetchSteamGameAchievementsSchema(appId, options = {}) {
  const cleanAppId = Number(appId);
  if (!Number.isFinite(cleanAppId) || cleanAppId <= 0) return [];
  const fetchImpl = typeof options.fetchFn === 'function' ? options.fetchFn : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return [];

  const language = String(options.language || 'english').trim() || 'english';
  const url = `https://api.steampowered.com/IPlayerService/GetGameAchievements/v1/?appid=${encodeURIComponent(
    String(cleanAppId)
  )}&language=${encodeURIComponent(language)}`;

  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: buildFetchSignal(options.signal),
    });
    if (!res.ok) return [];
    const json = /** @type {any} */ (await res.json());
    const rawList = json?.response?.achievements;
    if (!Array.isArray(rawList) || rawList.length === 0) return [];

    return rawList.map((item, idx) => {
      const apiName = String(item?.internal_name || item?.name || `ACH_${idx + 1}`).trim();
      const rawPct = parseFloat(String(item?.player_percent_unlocked ?? ''));
      const globalPercentage = Number.isFinite(rawPct)
        ? Number(rawPct.toFixed(1))
        : undefined;
      const iconUnlockedUrl = buildSteamAchievementIconUrl(cleanAppId, item?.icon);
      const iconLockedUrl =
        buildSteamAchievementIconUrl(cleanAppId, item?.icon_gray) || iconUnlockedUrl;
      return {
        id: `steam:${cleanAppId}:${apiName}`,
        apiName,
        name: String(item?.localized_name || apiName),
        description: String(item?.localized_desc || '').trim() || undefined,
        unlocked: false,
        iconUnlockedUrl,
        iconLockedUrl,
        ...(globalPercentage !== undefined
          ? { globalPercentage, rarityTier: classifyRarityTier(globalPercentage) }
          : {}),
        isSecret: Boolean(item?.hidden),
        isBaseGame: true,
        minProgress: Number(item?.min_progress_int ?? 0) || 0,
        maxProgress: Number(item?.max_progress_int ?? 0) || 0,
        storefrontId: 'steam',
      };
    });
  } catch {
    return [];
  }
}

/**
 * Helper to fetch Steam Web API player achievements + user stats (for private profiles when API key / webapi_token is present).
 *
 * @param {number} appId
 * @param {string} steamId64
 * @param {{ apiKey?: string, webapiToken?: string, fetchFn?: typeof fetch, signal?: AbortSignal }} options
 */
async function fetchSteamWebApiPlayerProgress(appId, steamId64, options = {}) {
  const fetchImpl = typeof options.fetchFn === 'function' ? options.fetchFn : globalThis.fetch;
  if (typeof fetchImpl !== 'function' || !/^\d{17}$/.test(steamId64)) return null;

  const authParam = options.webapiToken
    ? `access_token=${encodeURIComponent(options.webapiToken)}`
    : options.apiKey
      ? `key=${encodeURIComponent(options.apiKey)}`
      : '';
  if (!authParam) return null;

  const achUrl = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?${authParam}&steamid=${encodeURIComponent(
    steamId64
  )}&appid=${appId}&l=english`;
  const statsUrl = `https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?${authParam}&steamid=${encodeURIComponent(
    steamId64
  )}&appid=${appId}`;

  const [achRes, statsRes] = await Promise.all([
    fetchImpl(achUrl, { signal: buildFetchSignal(options.signal) }).catch(() => null),
    fetchImpl(statsUrl, { signal: buildFetchSignal(options.signal) }).catch(() => null),
  ]);

  if (!achRes || !achRes.ok) return null;
  let achJson;
  try {
    achJson = /** @type {any} */ (await achRes.json());
  } catch {
    return null;
  }

  const playerAchs = achJson?.playerstats?.achievements;
  if (!achJson?.playerstats?.success || !Array.isArray(playerAchs)) {
    return null;
  }

  /** @type {Map<string, number>} */
  const userStatsMap = new Map();
  if (statsRes && statsRes.ok) {
    try {
      const statsJson = /** @type {any} */ (await statsRes.json());
      const statsArr = statsJson?.playerstats?.stats;
      if (Array.isArray(statsArr)) {
        for (const s of statsArr) {
          if (s?.name && typeof s.value === 'number' && Number.isFinite(s.value)) {
            userStatsMap.set(String(s.name).toLowerCase(), s.value);
          }
        }
      }
    } catch {}
  }

  return { playerAchs, userStatsMap };
}

/**
 * Enrich achievements list with global percentages and rarity tiers from a schema lookup map.
 * @param {Array<Record<string, any>>} achievements
 * @param {Array<Record<string, any>>} schemaList
 */
function enrichAchievementsFromSchema(achievements, schemaList) {
  if (!Array.isArray(schemaList) || schemaList.length === 0) return achievements;
  /** @type {Map<string, Record<string, any>>} */
  const byApi = new Map();
  for (const s of schemaList) {
    if (s?.apiName) byApi.set(String(s.apiName).toLowerCase(), s);
  }
  return achievements.map((ach) => {
    const match = byApi.get(String(ach.apiName || '').toLowerCase());
    if (!match) return ach;
    const globalPercentage =
      ach.globalPercentage !== undefined ? ach.globalPercentage : match.globalPercentage;
    return {
      ...ach,
      name: ach.name || match.name,
      description: ach.description || match.description,
      iconUnlockedUrl: ach.iconUnlockedUrl || match.iconUnlockedUrl,
      iconLockedUrl: ach.iconLockedUrl || match.iconLockedUrl,
      isSecret: ach.isSecret || Boolean(match.isSecret),
      ...(globalPercentage !== undefined
        ? { globalPercentage, rarityTier: classifyRarityTier(globalPercentage) }
        : {}),
    };
  });
}

/**
 * Unified Electron main-process Steam detailed achievements provider (`Task 10b`):
 * 1. Zero-auth SSR JSON (`steamcommunity.com/{profiles|id}/.../achievements/<appId>`)
 * 2. Private-profile / offline cascade:
 *    - Steam Web API (`GetPlayerAchievements` + `GetUserStatsForGame` + `IPlayerService/GetGameAchievements`)
 *    - Pure-JS bounded binary VDF (`UserGameStatsSchema_<appId>.bin` + `UserGameStats_<acct>_<appId>.bin`)
 *      across native Steam + CrossOver/OneLauncher bottles + Windows Registry + Linux (`C12`)
 *    - `IPlayerService/GetGameAchievements/v1` canonical schema fallback (never reporting 0 as `exact`
 *      on a private profile or when `existingSummary.unlocked > 0`!).
 *
 * @param {Record<string, any>} [payload]
 * @param {Record<string, any>} [options]
 */
async function fetchSteamDetailedGameAchievements(payload = {}, options = {}) {
  const rawAppId =
    payload.steamAppId ??
    payload.appId ??
    String(payload.platformGameId || payload.gameId || '').replace(/^steam[-_]/i, '');
  const appId = Number(rawAppId);
  if (!Number.isFinite(appId) || appId <= 0) return null;

  const fetchImpl = typeof options.fetchFn === 'function' ? options.fetchFn : globalThis.fetch;
  const steamId = String(options.steamId || payload.steamId || '').trim();
  const existingUnlocked = Number(
    payload.existingSummary?.unlocked ?? options.existingSummary?.unlocked ?? 0
  );
  const syncedAt = new Date().toISOString();

  /** @type {ReturnType<typeof parseSteamAchievementsSsrHtml>} */
  let ssrResult = null;
  let networkSucceeded = false;

  // 1. Primary Remote Zero-Auth SSR JSON (`steamcommunity.com/{profiles|id}/.../achievements/<appId>`)
  if (!options.skipNetwork && steamId && typeof fetchImpl === 'function') {
    const isNumeric64 = /^\d{17}$/.test(steamId);
    const pathSegment = isNumeric64
      ? `profiles/${steamId}`
      : `id/${encodeURIComponent(steamId)}`;
    const ssrUrl = `https://steamcommunity.com/${pathSegment}/achievements/${appId}?l=english`;
    try {
      const res = await fetchImpl(ssrUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: buildFetchSignal(options.signal),
      });
      if (res.ok) {
        networkSucceeded = true;
        const html = await res.text();
        ssrResult = parseSteamAchievementsSsrHtml(html, appId);
      }
    } catch {}
  }

  const ssrUserTrustworthy = Boolean(
    ssrResult &&
      ssrResult.hasSchemaQuery &&
      ssrResult.hasUserQuery &&
      !ssrResult.isPrivateProfile &&
      ssrResult.achievements.length > 0 &&
      (ssrResult.unlockedCount > 0 || existingUnlocked === 0)
  );

  if (ssrUserTrustworthy && ssrResult) {
    const total = ssrResult.totalCount;
    const unlocked = ssrResult.unlockedCount;
    const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
    return {
      storefrontId: 'steam',
      storefrontName: 'Steam',
      total,
      unlocked,
      percentage,
      isMastered: total > 0 && unlocked >= total,
      achievements: ssrResult.achievements,
      syncedAt,
      source: 'live_cloud',
      unlockPrecision: 'exact',
      supportsAchievements: total > 0,
      cacheVersion: 2,
    };
  }

  // 2. Private-profile / offline cascade: read local binary VDF + optionally Web API & IPlayerService schema
  const [localVdf, apiSchema] = await Promise.all([
    readLocalSteamBinaryVdfAchievements(appId, {
      ...options,
      steamId,
    }).catch(() => null),
    !options.skipNetwork && !(ssrResult && ssrResult.achievements.length > 0)
      ? fetchSteamGameAchievementsSchema(appId, { ...options, fetchFn: fetchImpl }).catch(() => [])
      : Promise.resolve([]),
  ]);

  const referenceSchema =
    ssrResult && ssrResult.achievements.length > 0 ? ssrResult.achievements : apiSchema;

  // 2a. Steam Web API (`GetPlayerAchievements` + `GetUserStatsForGame`) when `apiKey` or `webapiToken` exists
  if (
    !options.skipNetwork &&
    /^\d{17}$/.test(steamId) &&
    (options.apiKey || options.webapiToken)
  ) {
    const webApi = await fetchSteamWebApiPlayerProgress(appId, steamId, {
      apiKey: options.apiKey,
      webapiToken: options.webapiToken,
      fetchFn: fetchImpl,
      signal: options.signal,
    }).catch(() => null);

    if (webApi && webApi.playerAchs.length > 0) {
      /** @type {Map<string, any>} */
      const schemaByApi = new Map();
      for (const s of referenceSchema) {
        if (s?.apiName) schemaByApi.set(String(s.apiName).toLowerCase(), s);
      }

      const achievements = webApi.playerAchs.map((pAch, idx) => {
        const apiName = String(pAch?.apiname || `ACH_${idx + 1}`).trim();
        const sMatch = schemaByApi.get(apiName.toLowerCase());
        const unlocked = Boolean(pAch?.achieved === 1 || pAch?.achieved === true);
        const rawTs = Number(pAch?.unlocktime ?? 0);
        const unlockedAt = unlocked && rawTs > 0 ? rawTs * 1000 : undefined;

        let progress = undefined;
        if (!unlocked && localVdf?.statMappings?.has(apiName.toLowerCase())) {
          const mapping = localVdf.statMappings.get(apiName.toLowerCase());
          const statVal = mapping
            ? webApi.userStatsMap.get(mapping.statName.toLowerCase())
            : undefined;
          if (
            mapping &&
            typeof statVal === 'number' &&
            Number.isFinite(statVal) &&
            mapping.maxVal > mapping.minVal &&
            statVal > mapping.minVal
          ) {
            const clamped = Math.min(mapping.maxVal, Math.max(mapping.minVal, statVal));
            const percentage = Math.min(
              99,
              Math.max(
                1,
                Math.round(((clamped - mapping.minVal) / (mapping.maxVal - mapping.minVal)) * 100)
              )
            );
            progress = {
              current: Number.isInteger(clamped) ? clamped : Number(clamped.toFixed(1)),
              max: mapping.maxVal,
              percentage,
            };
          }
        }

        const globalPercentage = sMatch?.globalPercentage;
        return {
          id: `steam:${appId}:${apiName}`,
          apiName,
          name: String(pAch?.name || sMatch?.name || apiName),
          description: String(pAch?.description || sMatch?.description || '').trim() || undefined,
          unlocked,
          ...(unlockedAt ? { unlockedAt } : {}),
          iconUnlockedUrl: sMatch?.iconUnlockedUrl || '',
          iconLockedUrl: sMatch?.iconLockedUrl || sMatch?.iconUnlockedUrl || '',
          ...(globalPercentage !== undefined
            ? { globalPercentage, rarityTier: classifyRarityTier(globalPercentage) }
            : {}),
          ...(progress ? { progress } : {}),
          isSecret: Boolean(sMatch?.isSecret),
          isBaseGame: sMatch?.isBaseGame !== false,
          storefrontId: 'steam',
        };
      });

      const total = achievements.length;
      const unlocked = achievements.filter((a) => a.unlocked).length;
      if (unlocked > 0 || existingUnlocked === 0) {
        const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
        return {
          storefrontId: 'steam',
          storefrontName: 'Steam',
          total,
          unlocked,
          percentage,
          isMastered: total > 0 && unlocked >= total,
          achievements,
          syncedAt,
          source: 'live_cloud',
          unlockPrecision: 'exact',
          supportsAchievements: total > 0,
          cacheVersion: 2,
        };
      }
    }
  }

  // 2b. Local / CrossOver-bottle Binary VDF (`UserGameStatsSchema_<appId>.bin` + `UserGameStats_<acct>_<appId>.bin`)
  if (localVdf && localVdf.hasUserStatsFile && localVdf.achievements.length > 0) {
    const enriched = enrichAchievementsFromSchema(localVdf.achievements, referenceSchema);
    const total = enriched.length;
    const unlocked = enriched.filter((a) => a.unlocked).length;
    const isTrustworthyLocal = unlocked > 0 || existingUnlocked === 0;
    const effectiveUnlocked = isTrustworthyLocal ? unlocked : existingUnlocked;
    const percentage = total > 0 ? Math.round((effectiveUnlocked / total) * 100) : 0;
    return {
      storefrontId: 'steam',
      storefrontName: 'Steam',
      total,
      unlocked: effectiveUnlocked,
      percentage,
      isMastered: total > 0 && effectiveUnlocked >= total,
      achievements: enriched,
      syncedAt,
      source: 'local_cache',
      unlockPrecision: isTrustworthyLocal ? 'exact' : 'summary_count_only',
      supportsAchievements: true,
      cacheVersion: 2,
    };
  }

  // 2c. Schema-only fallback (never claim 0 unlocked as `exact` on private profile or when existingUnlocked > 0!)
  const bestSchema =
    referenceSchema.length > 0
      ? referenceSchema
      : localVdf && localVdf.achievements.length > 0
        ? localVdf.achievements
        : [];

  if (bestSchema.length > 0) {
    const cleanSchema = bestSchema.map((a) => ({
      ...a,
      unlocked: false,
      unlockedAt: undefined,
    }));
    const total = cleanSchema.length;
    const unlocked = existingUnlocked > 0 ? existingUnlocked : 0;
    const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
    const unlockPrecision =
      unlocked > 0 || Boolean(ssrResult?.isPrivateProfile) ? 'summary_count_only' : 'exact';
    return {
      storefrontId: 'steam',
      storefrontName: 'Steam',
      total,
      unlocked,
      percentage,
      isMastered: total > 0 && unlocked >= total,
      achievements: cleanSchema,
      syncedAt,
      source: 'schema_fallback',
      unlockPrecision,
      supportsAchievements: true,
      cacheVersion: 2,
    };
  }

  if (networkSucceeded && existingUnlocked === 0) {
    return null;
  }

  return null;
}

module.exports = {
  MAX_VDF_FILE_BYTES,
  MAX_VDF_RECURSION_DEPTH,
  classifyRarityTier,
  steamId64ToAccountId32,
  parseBinaryVdf,
  resolveLocalSteamAppcacheStatsDirs,
  readLocalSteamBinaryVdfAchievements,
  extractSteamSsrQueryData,
  parseSteamAchievementsSsrHtml,
  fetchSteamGameAchievementsSchema,
  fetchSteamDetailedGameAchievements,
};
