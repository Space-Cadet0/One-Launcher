const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { app } = require('electron');

const GOG_CLIENT_ID = '46899977096215655';
const GOG_CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const GOG_REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';

const EPIC_CLIENT_AUTH = 'MzRhMDJjZjhmNDQxNGUyOWIxNTkyMTg3NmRhMzZmOWE6ZGFhZmJjY2M3Mzc3NDUwMzlkZmZlNTNkOTRmYzc2Y2Y=';

let cachedMachineIdentity = null;

/**
 * Derives deterministic, hardware-bound key material for the local workstation
 * without touching or prompting the macOS Keychain or Windows Credential UI.
 */
function getMachineIdentityKeyMaterial(options = {}) {
  if (options && typeof options.machineIdOverride === 'string' && options.machineIdOverride) {
    return `one-launcher-vault-v2:${options.machineIdOverride}`;
  }
  if (cachedMachineIdentity) {
    return cachedMachineIdentity;
  }

  let hwId = '';
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = out && out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match && match[1]) {
        hwId = match[1].trim();
      }
    } else if (process.platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        }
      );
      const match = out && out.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
      if (match && match[1]) {
        hwId = match[1].trim();
      }
    } else {
      for (const idPath of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (fs.existsSync(idPath)) {
          hwId = fs.readFileSync(idPath, 'utf8').trim();
          if (hwId) break;
        }
      }
    }
  } catch {
    // Fallback to OS/host identity if hardware UUID query fails in restricted environments
  }

  if (!hwId) {
    hwId = `${os.hostname()}:${os.platform()}:${os.arch()}`;
  }

  let username = 'user';
  try {
    username = os.userInfo().username || 'user';
  } catch {}

  cachedMachineIdentity = `one-launcher-vault-v2:${hwId}:${username}`;
  return cachedMachineIdentity;
}

function encryptTokensPayload(jsonStr, options = {}) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(getMachineIdentityKeyMaterial(options), salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    _encrypted_v2: true,
    alg: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptTokensPayload(payload, options = {}) {
  if (
    !payload ||
    payload._encrypted_v2 !== true ||
    typeof payload.salt !== 'string' ||
    typeof payload.iv !== 'string' ||
    typeof payload.tag !== 'string' ||
    typeof payload.data !== 'string'
  ) {
    throw new Error('Invalid v2 encrypted token payload');
  }
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  const key = crypto.scryptSync(getMachineIdentityKeyMaterial(options), salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted);
}

function isMockOrCorruptedToken(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') return false;
  return /^(epic-rotated|gog-rotated|freshly-renewed|mock-|test-|fake-)/i.test(tokenStr.trim());
}

function sanitizeStorefrontTokensObject(tokensObj, options = {}) {
  if (!tokensObj || typeof tokensObj !== 'object') {
    return { cleaned: {}, modified: false };
  }
  const shouldSanitize =
    options?.sanitizeMockTokens === true ||
    !(process.env.VITEST || process.env.NODE_ENV === 'test');
  if (!shouldSanitize) {
    return { cleaned: tokensObj, modified: false };
  }

  let modified = false;
  const cleaned = { ...tokensObj };

  for (const [storeKey, storeVal] of Object.entries(cleaned)) {
    if (!storeVal || typeof storeVal !== 'object') continue;
    const copy = { ...storeVal };
    let entryModified = false;

    if (isMockOrCorruptedToken(copy.access_token)) {
      delete copy.access_token;
      entryModified = true;
    }
    if (isMockOrCorruptedToken(copy.refresh_token)) {
      delete copy.refresh_token;
      entryModified = true;
    }
    if (
      storeKey === 'epic' &&
      (copy.account_id === 'epic-user-1' || isMockOrCorruptedToken(copy.account_id)) &&
      typeof copy.in_app_id === 'string' &&
      /^[0-9a-f]{32}$/i.test(copy.in_app_id.trim())
    ) {
      copy.account_id = copy.in_app_id.trim();
      entryModified = true;
    }
    if (
      storeKey === 'gog' &&
      (copy.user_id === 'gog-user-1' || copy.user_id === 'gog-user-777')
    ) {
      delete copy.user_id;
      entryModified = true;
    }

    if (entryModified) {
      cleaned[storeKey] = copy;
      modified = true;
    }
  }

  return { cleaned, modified };
}

function getTokensFilePath(options = {}) {
  if (options && typeof options === 'object') {
    const explicitFile = options.filePath || options.tokensFilePath;
    if (typeof explicitFile === 'string' && explicitFile.trim()) {
      return explicitFile.trim();
    }
    if (typeof options.userDataDir === 'string' && options.userDataDir.trim()) {
      const dir = options.userDataDir.trim();
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        } catch {}
      }
      return path.join(dir, 'tokens.json');
    }
  }

  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    const testDir = path.join(os.tmpdir(), `one-launcher-test-vault-${process.pid}`);
    try {
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true, mode: 0o700 });
      }
    } catch {}
    return path.join(testDir, `one-launcher-test-tokens-${process.pid}.json`);
  }

  try {
    const defaultDir = path.join(process.env.HOME || '.', '.one-launcher');
    const legacyDir = path.join(process.env.HOME || '.', '.universal-game-library');
    const userDataPath = app ? app.getPath('userData') : (fs.existsSync(legacyDir) && !fs.existsSync(defaultDir) ? legacyDir : defaultDir);
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    }
    return path.join(userDataPath, 'tokens.json');
  } catch {
    return path.join(process.cwd(), 'tokens.json');
  }
}

function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {}
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {}
    fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {}
    }
  }
}

function destroyScraperWindowCleanly(win) {
  if (!win) return;
  try {
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return;
    if (win.webContents) {
      try {
        if (typeof win.webContents.removeAllListeners === 'function') {
          win.webContents.removeAllListeners();
        }
      } catch {}
      try {
        if (win.webContents.session && typeof win.webContents.session.clearCache === 'function') {
          const res = win.webContents.session.clearCache();
          if (res && typeof res.catch === 'function') {
            res.catch(() => {});
          }
        }
      } catch {}
    }
    try {
      if (typeof win.destroy === 'function') {
        win.destroy();
      } else if (typeof win.close === 'function') {
        win.close();
      }
    } catch {
      try {
        if (typeof win.close === 'function') win.close();
      } catch {}
    }
  } catch {}
}

const inFlightTokenRenewals = new Map();

function writeTokensFile(tokens, options = {}) {
  const filePath = getTokensFilePath(options);
  const jsonStr = JSON.stringify(tokens, null, 2);

  try {
    const encryptedPayload = encryptTokensPayload(jsonStr, options);
    atomicWriteFileSync(filePath, JSON.stringify(encryptedPayload, null, 2));
    return;
  } catch (encErr) {
    console.warn('Failed to encrypt tokens with AES-256-GCM, falling back to protected file:', encErr.message);
  }

  atomicWriteFileSync(filePath, jsonStr);
}

function loadSavedTokens(options = {}) {
  try {
    const filePath = getTokensFilePath(options);
    if (!fs.existsSync(filePath)) {
      return {};
    }

    const rawContent = fs.readFileSync(filePath);
    if (!rawContent || rawContent.length === 0) {
      return {};
    }

    let parsed;
    try {
      parsed = JSON.parse(rawContent.toString('utf-8'));
    } catch {
      return {};
    }

    // 1. Hardware-bound AES-256-GCM encrypted payload format (_encrypted_v2: true)
    if (parsed && parsed._encrypted_v2 === true) {
      try {
        const decrypted = decryptTokensPayload(parsed, options);
        const { cleaned, modified } = sanitizeStorefrontTokensObject(decrypted, options);
        if (modified) {
          try {
            writeTokensFile(cleaned, options);
          } catch {}
        }
        return cleaned;
      } catch (decErr) {
        console.warn('Failed to decrypt v2 tokens payload:', decErr.message);
        return {};
      }
    }

    // 2. Legacy safeStorage format (_encrypted: true): ignore without invoking Keychain
    if (parsed && parsed._encrypted === true) {
      return {};
    }

    // 3. Plaintext JSON backward compatibility: migrate on disk to _encrypted_v2 automatically
    if (parsed && typeof parsed === 'object') {
      const cleanedTokens = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value === 'object' && value._encrypted === true) {
          continue;
        }
        cleanedTokens[key] = value;
      }
      const { cleaned } = sanitizeStorefrontTokensObject(cleanedTokens, options);
      if (Object.keys(cleaned).length > 0) {
        try {
          writeTokensFile(cleaned, options);
        } catch {}
      }
      return cleaned;
    }

    return {};
  } catch (err) {
    console.warn('Failed to load saved tokens:', err.message);
    return {};
  }
}

function saveTokens(storefrontId, tokenData, options = {}) {
  try {
    const existing = loadSavedTokens(options);
    const mergedEntry = {
      ...(existing[storefrontId] || {}),
      ...tokenData,
      updatedAt: new Date().toISOString(),
    };
    const nextAll = {
      ...existing,
      [storefrontId]: mergedEntry,
    };
    const { cleaned } = sanitizeStorefrontTokensObject(nextAll, options);
    writeTokensFile(cleaned, options);
    if (!options?.fromExternalFallback && storefrontId) {
      try {
        const { clearStoreDisconnectedTombstone } = require('./launcher/securityAndPathUtils.cjs');
        clearStoreDisconnectedTombstone(storefrontId, options);
      } catch {}
    }
  } catch (err) {
    console.warn('Failed to save tokens:', err.message);
  }
}

function clearTokens(storefrontId, options = {}) {
  try {
    const existing = loadSavedTokens(options);
    if (existing[storefrontId]) {
      delete existing[storefrontId];
      writeTokensFile(existing, options);
    }
  } catch (err) {
    console.warn('Failed to clear tokens:', err.message);
  }
}

const EDITION_WORDS = new Set([
  'complete',
  'definitive',
  'enhanced',
  'goty',
  'deluxe',
  'gold',
  'standard',
  'remastered',
  'remaster',
  'directors',
  'director',
  'cut',
  'edition',
  'collectors',
  'collector',
  'anniversary',
  'special',
  'ultimate',
  'extended',
  'game',
  'year',
  'final',
  'royal',
  'emperor',
  'classics',
  'classic',
  'plus',
  'bundle',
  'pack',
  'package',
  'collection',
  'upgrade',
  'vr',
  'hd',
]);

const ROMAN_TO_ARABIC = {
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
  xi: '11',
  xii: '12',
  xiii: '13',
  xiv: '14',
  xv: '15',
  xvi: '16',
  xvii: '17',
  xviii: '18',
  xix: '19',
  xx: '20',
};

const NUMERIC_SEQUELS = new Set([
  '2', '3', '4', '5', '6', '7', '8', '9', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
]);

function extractSequelIdentifier(words) {
  if (!Array.isArray(words)) return null;
  for (const word of words) {
    if (NUMERIC_SEQUELS.has(word) || /^[2-9]$|^1[0-9]$|^20$/.test(word)) {
      return word;
    }
    if (ROMAN_TO_ARABIC[word]) {
      return ROMAN_TO_ARABIC[word];
    }
  }
  return null;
}

function computeTokenSimilarity(source, candidate) {
  const s1 = source.toLowerCase().replace(/[™®©]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const s2 = candidate.toLowerCase().replace(/[™®©]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;

  const words1 = s1.split(' ').filter(Boolean);
  const words2 = s2.split(' ').filter(Boolean);

  // Strict sequel verification: prevent "Game 2" from matching "Game" or "Game 3"
  const seq1 = extractSequelIdentifier(words1);
  const seq2 = extractSequelIdentifier(words2);
  if (seq1 !== seq2) {
    return 0;
  }

  const tokens1 = new Set(words1);
  const tokens2 = new Set(words2);

  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }

  const union = new Set([...tokens1, ...tokens2]).size;
  if (union === 0) return 0;
  const jaccard = intersection / union;

  // Single word checks: must match an exact word token in candidate!
  // e.g. "boga" does NOT match "path of the bogatyr"!
  if (words1.length === 1 && !tokens2.has(words1[0])) {
    return 0;
  }
  if (words2.length === 1 && !tokens1.has(words2[0])) {
    return 0;
  }

  // Intelligent Edition Variant Matching (e.g. "DARQ" <-> "DARQ: Complete Edition")
  const [shorterWords, longerWords] = words1.length <= words2.length ? [words1, words2] : [words2, words1];
  const shorterSet = new Set(shorterWords);
  const longerSet = new Set(longerWords);

  let allShorterInLonger = true;
  for (const w of shorterWords) {
    if (!longerSet.has(w)) {
      allShorterInLonger = false;
      break;
    }
  }

  if (allShorterInLonger) {
    let onlyEditionTokensRemaining = true;
    for (const w of longerWords) {
      if (!shorterSet.has(w) && !EDITION_WORDS.has(w) && w !== 'the' && w !== 'of' && w !== 'a' && w !== 'an') {
        onlyEditionTokensRemaining = false;
        break;
      }
    }
    if (onlyEditionTokensRemaining) {
      return 0.92;
    }
  }

  // Exact multi-word phrase containment
  if (words1.length >= 2 && (s1.includes(s2) || s2.includes(s1))) {
    const minWords = Math.min(words1.length, words2.length);
    const maxWords = Math.max(words1.length, words2.length);
    if (minWords / maxWords >= 0.5 && intersection >= minWords) {
      return 0.88;
    }
  }

  return jaccard;
}

const MAX_STORE_SYNC_CACHE_ENTRIES = 500;
const steamMatchCache = new Map();

function setBoundedCacheEntry(map, key, value, maxEntries = MAX_STORE_SYNC_CACHE_ENTRIES) {
  if (!map.has(key) && map.size >= maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}

/**
 * Intelligent Steam App ID matcher for titles across all storefronts
 */
async function matchSteamAppId(rawTitle) {
  if (!rawTitle) return undefined;
  const lower = rawTitle.trim().toLowerCase();

  if (steamMatchCache.has(lower)) {
    return steamMatchCache.get(lower);
  }

  setBoundedCacheEntry(steamMatchCache, lower, undefined, MAX_STORE_SYNC_CACHE_ENTRIES);
  return undefined;
}

/**
 * Exchange GOG Authorization Code for Access & Refresh Tokens
 */
async function exchangeGogCode(code) {
  const cleanCode = code.trim();
  const tokenUrl = `https://auth.gog.com/token?client_id=${GOG_CLIENT_ID}&client_secret=${GOG_CLIENT_SECRET}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(GOG_REDIRECT_URI)}&code=${encodeURIComponent(cleanCode)}`;

  const res = await fetch(tokenUrl, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GOGGalaxy/2.0',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GOG token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('GOG token response missing access_token');
  }

  saveTokens('gog', data);
  return data;
}

/**
 * Automatically renew GOG access token using refresh_token (matching Playnite / Heroic)
 */
async function renewGogTokens(refreshToken) {
  const inflightKey = `gog:${String(refreshToken || '')}`;
  if (inFlightTokenRenewals.has(inflightKey)) {
    return inFlightTokenRenewals.get(inflightKey);
  }

  const renewalPromise = (async () => {
    const tokenUrl = `https://auth.gog.com/token?client_id=${GOG_CLIENT_ID}&client_secret=${GOG_CLIENT_SECRET}&grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
    const res = await fetch(tokenUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GOGGalaxy/2.0',
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to renew GOG token (${res.status})`);
    }

    const data = await res.json();
    if (!data.access_token) {
      throw new Error('GOG refresh response missing access_token');
    }

    saveTokens('gog', data);
    return data;
  })().finally(() => {
    inFlightTokenRenewals.delete(inflightKey);
  });

  inFlightTokenRenewals.set(inflightKey, renewalPromise);
  return renewalPromise;
}

/**
 * Normalize GOG avatar URLs (handling protocol-relative //images.gog-statics.com/<hash>
 * which returns 404 without a size suffix + .jpg extension, as well as avatars maps).
 */
function normalizeGogAvatarUrl(rawAvatar, avatarsObj) {
  const candidates = [];
  if (avatarsObj && typeof avatarsObj === 'object') {
    candidates.push(
      avatarsObj.menu_user_av_big2,
      avatarsObj.menu_user_av_big,
      avatarsObj.large_2x,
      avatarsObj.large,
      avatarsObj.sdk_img_184,
      avatarsObj.medium_2x,
      avatarsObj.medium,
      avatarsObj.menu_big_2,
      avatarsObj.menu_big,
      avatarsObj.menu_user_av_small2,
      avatarsObj.menu_user_av_small,
      avatarsObj.small_2x,
      avatarsObj.small
    );
  }
  if (rawAvatar && typeof rawAvatar === 'object') {
    candidates.push(
      rawAvatar.large_2x,
      rawAvatar.large,
      rawAvatar.sdk_img_184,
      rawAvatar.medium_2x,
      rawAvatar.medium,
      rawAvatar.menu_big_2,
      rawAvatar.menu_big,
      rawAvatar.menu_user_av_big2,
      rawAvatar.menu_user_av_big,
      rawAvatar.small_2x,
      rawAvatar.small
    );
  } else if (typeof rawAvatar === 'string' && rawAvatar.trim()) {
    candidates.push(rawAvatar.trim());
  }

  for (const cand of candidates) {
    if (typeof cand !== 'string' || !cand.trim()) continue;
    let url = cand.trim();
    if (url.startsWith('//')) {
      url = `https:${url}`;
    } else if (url.startsWith('http://')) {
      url = `https://${url.slice(7)}`;
    }
    // Bare GOG CDN hash without size suffix or file extension returns 404 unless suffixed
    if (/^https:\/\/images\.gog(-statics)?\.com\/[0-9a-f]{32,64}$/i.test(url)) {
      url = `${url}_menu_user_av_big2.jpg`;
    }
    return url;
  }
  return undefined;
}

/**
 * Fetch GOG Account Details
 */
async function fetchGogAccount(accessToken) {
  const res = await fetch('https://menu.gog.com/v1/account/basic', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GOGGalaxy/2.0',
    },
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`GOG account token expired (${res.status})`);
    }
    return {
      username: 'GOG User',
      avatarUrl: undefined,
    };
  }

  const data = await res.json();
  let username = data.username || 'GOG User';
  let userId = data.userId;
  let avatarUrl = normalizeGogAvatarUrl(data.avatar, data.avatars);

  if ((!avatarUrl || username === 'GOG User') && userId) {
    try {
      const userRes = await fetch(`https://users.gog.com/users/${encodeURIComponent(userId)}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GOGGalaxy/2.0',
        },
      });
      if (userRes.ok) {
        const userJson = await userRes.json();
        if (userJson?.username && username === 'GOG User') {
          username = userJson.username;
        }
        const fallbackAvatar = normalizeGogAvatarUrl(userJson?.avatar, userJson?.avatars);
        if (fallbackAvatar) {
          avatarUrl = fallbackAvatar;
        }
      }
    } catch {}
  }

  try {
    const existing = loadSavedTokens();
    if (existing?.gog && typeof existing.gog === 'object') {
      saveTokens('gog', {
        ...existing.gog,
        user_id: userId || existing.gog.user_id,
        username: username !== 'GOG User' ? username : existing.gog.username,
        avatarUrl: avatarUrl || existing.gog.avatarUrl,
      });
    }
  } catch {}

  return {
    username,
    userId,
    avatarUrl,
  };
}

/**
 * Fetch exact achievements for a single GOG game using Galaxy gameplay API or user profile page
 */
async function fetchGogGameAchievementDetail(accessToken, username, userId, gameId, gameTitle, fallbackPercentage) {
  const cleanId = String(gameId).replace(/^gog-/, '');
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GOGGalaxy/2.0',
  };
  if (accessToken) {
    headers['Authorization'] = accessToken.startsWith('Bearer ') ? accessToken : `Bearer ${accessToken}`;
  }

  // 1. Try GOG Galaxy official gameplay achievements API if userId & accessToken are available
  if (userId && accessToken) {
    try {
      const gpUrl = `https://gameplay.gog.com/clients/${encodeURIComponent(cleanId)}/users/${encodeURIComponent(userId)}/achievements`;
      const gpRes = await fetch(gpUrl, {
        headers: {
          ...headers,
          'X-GOG-Lc': 'en-US',
        },
      });
      if (gpRes.ok) {
        const gpData = await gpRes.json();
        const items = Array.isArray(gpData?.items) ? gpData.items : [];
        const total = items.length || Number(gpData?.total_count || 0);
        if (total > 0) {
          const unlocked = items.filter((a) => Boolean(a.date_unlocked)).length;
          const percentage = Math.round((unlocked / total) * 100);
          return {
            unlocked,
            total,
            percentage,
            isMastered: unlocked >= total,
            source: 'live_cloud_api',
            syncedAt: new Date().toISOString(),
          };
        }
      }
    } catch {}
  }

  // 2. Try GOG profile game page (window.profilesData.achievements)
  if (username) {
    try {
      const pageUrl = `https://www.gog.com/u/${encodeURIComponent(username)}/game/${encodeURIComponent(cleanId)}`;
      const pageRes = await fetch(pageUrl, { headers });
      if (pageRes.ok) {
        const html = await pageRes.text();
        const match = html.match(
          /window\.profilesData\.achievements\s*=\s*(\[[\s\S]*?\]);\s*window\.profilesData\.matchedGame/
        );
        if (match) {
          const list = JSON.parse(match[1]);
          if (Array.isArray(list) && list.length > 0) {
            const total = list.length;
            const unlocked = list.filter((a) => {
              if (!a.stats) return false;
              return Object.values(a.stats).some((s) => s && s.isUnlocked);
            }).length;
            const percentage = Math.round((unlocked / total) * 100);
            return {
              unlocked,
              total,
              percentage,
              isMastered: unlocked >= total,
              source: 'live_cloud_xml',
              syncedAt: new Date().toISOString(),
            };
          }
        }
      }
    } catch {}
  }

  // 3. Fallback using percentage if > 0
  if (typeof fallbackPercentage === 'number' && fallbackPercentage > 0) {
    let knownTotal = 0;
    try {
      const knownPath = path.join(__dirname, '../src/services/storage/knownGameAchievements.json');
      if (fs.existsSync(knownPath)) {
        const knownMap = JSON.parse(fs.readFileSync(knownPath, 'utf8'));
        const matchedSteamId = await matchSteamAppId(gameTitle || '');
        if (matchedSteamId && knownMap[String(matchedSteamId)] > 0) {
          knownTotal = knownMap[String(matchedSteamId)];
        }
      }
    } catch {}
    const total = knownTotal > 0 ? knownTotal : 35;
    const unlocked = Math.max(1, Math.round((total * fallbackPercentage) / 100));
    return {
      unlocked,
      total,
      percentage: Math.round(fallbackPercentage),
      isMastered: fallbackPercentage >= 100 || unlocked >= total,
      source: 'live_cloud_xml',
      syncedAt: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * Fetch GOG User Achievements and Playtime Stats across paginated profile stats
 */
async function fetchGogAchievements(accessToken, username, userId) {
  const achievementsMap = {};
  const statsMap = new Map();

  let resolvedUsername = username;
  let resolvedUserId = userId;
  if ((!resolvedUsername || resolvedUsername === 'GOG User' || !resolvedUserId) && accessToken) {
    try {
      const acc = await fetchGogAccount(accessToken);
      if (acc.username && acc.username !== 'GOG User') resolvedUsername = acc.username;
      if (acc.userId) resolvedUserId = acc.userId;
    } catch {}
  }

  if (!resolvedUsername) {
    return { achievements: achievementsMap, stats: statsMap };
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GOGGalaxy/2.0',
  };
  if (accessToken) {
    headers['Authorization'] = accessToken.startsWith('Bearer ') ? accessToken : `Bearer ${accessToken}`;
  }

  const extractUserStat = (statsObj) => {
    if (!statsObj || Array.isArray(statsObj)) return undefined;
    if (typeof statsObj.playtime === 'number' || typeof statsObj.achievementsPercentage === 'number') {
      return statsObj;
    }
    return Object.values(statsObj)[0];
  };

  // 1. Paginate by percent_of_unlocked_achievements descending to harvest all unlocked trophies
  try {
    let currentPage = 1;
    let totalPages = 1;
    let keepPaging = true;

    while (currentPage <= totalPages && keepPaging && currentPage <= 10) {
      const url = `https://www.gog.com/u/${encodeURIComponent(resolvedUsername)}/games/stats?sort=percent_of_unlocked_achievements&order=desc&page=${currentPage}`;
      const res = await fetch(url, { headers });
      if (!res.ok) break;

      const data = await res.json();
      totalPages = data?.pages || 1;
      const items = data?._embedded?.items || [];
      if (items.length === 0) break;

      for (const item of items) {
        const game = item.game;
        if (!game?.id) continue;
        const strId = String(game.id);
        const userStat = extractUserStat(item.stats);

        if (userStat) {
          statsMap.set(strId, {
            playtime: userStat.playtime || 0,
            lastSession: userStat.lastSession || null,
            achievementsPercentage: userStat.achievementsPercentage,
          });
        }

        const pct = userStat?.achievementsPercentage;
        if (typeof pct === 'number' && pct > 0) {
          const detail = await fetchGogGameAchievementDetail(
            accessToken,
            resolvedUsername,
            resolvedUserId,
            strId,
            game.title,
            pct
          );
          if (detail) {
            achievementsMap[strId] = detail;
            achievementsMap[`gog-${strId}`] = detail;
            if (game.title) {
              const lowerTitle = game.title.toLowerCase().trim();
              const normTitle = lowerTitle.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
              achievementsMap[lowerTitle] = detail;
              achievementsMap[normTitle] = detail;
            }
          }
        } else if (pct === 0 || !userStat) {
          keepPaging = false;
        }
      }

      currentPage++;
    }
  } catch (err) {
    console.warn('GOG achievement stats fetch warning:', err.message);
  }

  // 2. Also fetch recent_playtime page 1 so played games with 0% achievements still get accurate playtime
  try {
    const ptUrl = `https://www.gog.com/u/${encodeURIComponent(resolvedUsername)}/games/stats?sort=recent_playtime&order=desc&page=1`;
    const ptRes = await fetch(ptUrl, { headers });
    if (ptRes.ok) {
      const ptData = await ptRes.json();
      const items = ptData?._embedded?.items || [];
      for (const item of items) {
        if (!item.game?.id) continue;
        const strId = String(item.game.id);
        const userStat = extractUserStat(item.stats);
        if (userStat && !statsMap.has(strId)) {
          statsMap.set(strId, {
            playtime: userStat.playtime || 0,
            lastSession: userStat.lastSession || null,
            achievementsPercentage: userStat.achievementsPercentage,
          });
        }
      }
    }
  } catch {}

  return { achievements: achievementsMap, stats: statsMap };
}

/**
 * Fetch GOG Library using Playnite / Heroic endpoints
 */
async function fetchGogOwnedGames(accessToken, username, userId) {
  const games = [];
  const suppressedItems = [];
  fetchGogOwnedGames.lastSuppressedItems = suppressedItems;

  // 1. Fetch playtime & achievement stats
  const { achievements: achievementsMap, stats: playtimeMap } = await fetchGogAchievements(
    accessToken,
    username,
    userId
  );
  fetchGogOwnedGames.lastAchievementsMap = achievementsMap;

  // 2. Fetch paginated products from getFilteredProducts
  try {
    let gogEnriched = {};
    try {
      const enrichedPath = path.join(__dirname, '../src/services/storage/gogEnrichedCache.json');
      if (fs.existsSync(enrichedPath)) {
        gogEnriched = JSON.parse(fs.readFileSync(enrichedPath, 'utf8'));
      }
    } catch {
      // Optional cache
    }

    let currentPage = 1;
    let totalPages = 1;

    while (currentPage <= totalPages && currentPage <= 35) {
      const url = `https://embed.gog.com/account/getFilteredProducts?hasHiddenProducts=false&isDefault=true&mediaType=1&page=${currentPage}&limit=100`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GOGGalaxy/2.0',
        },
      });

      if (!res.ok) {
        console.warn(`GOG getFilteredProducts page ${currentPage} returned status ${res.status}`);
        break;
      }

      const data = await res.json();
      totalPages = data.totalPages || 1;
      const products = data.products || [];

      for (const p of products) {
        const title = (p.title || '').trim();
        if (!title) continue;

        const coverUrl = p.image
          ? p.image.startsWith('http')
            ? p.image
            : `https:${p.image}.jpg`
          : 'https://images.gog-statics.com/avatars/default.png';

        const strId = String(p.id);
        const stats = playtimeMap.get(strId) || {};
        const lowerTitle = title.toLowerCase().trim();
        const normTitle = lowerTitle.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
        const gameAch =
          achievementsMap[strId] ||
          achievementsMap[`gog-${strId}`] ||
          achievementsMap[lowerTitle] ||
          achievementsMap[normTitle];

        const nonGameReason = classifyNonGameStorefrontItem({
          title,
          platformId: 'gog',
          platformGameId: strId,
          isDlc: false,
        });
        if (nonGameReason) {
          const rawGame = {
            id: `gog-${p.id}`,
            title,
            originalStoreTitle: title,
            sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
            isVerifiedEntitlement: true,
            platforms: [
              {
                platformId: 'gog',
                platformGameId: strId,
                originalTitle: title,
                installed: false,
                playtimeMinutes: stats.playtime || 0,
                lastPlayed: stats.lastSession || undefined,
              },
            ],
            headerImage: coverUrl,
            capsuleImage: gogEnriched[strId]?.coverVertical || '',
            shortDescription: '',
            releaseDate: '',
            developers: [],
            publishers: [],
            genres: p.category ? [p.category] : ['Action'],
            tags: ['GOG', 'DRM-Free'],
          };
          suppressedItems.push({
            id: `gog-${p.id}`,
            rawTitle: title,
            platformId: 'gog',
            platformGameId: strId,
            reason: nonGameReason,
            reasonCategory: 'non_game_filter',
            rawGame,
          });
          continue;
        }

        const steamAppId = await matchSteamAppId(title);

        const enrichedEntry = gogEnriched[strId];
        const verticalGogCover = enrichedEntry?.coverVertical || null;

        const rawWorksOn = p.worksOn || p.os || enrichedEntry?.worksOn || enrichedEntry?.platforms;
        const resolvedOsPlatforms =
          rawWorksOn && typeof rawWorksOn === 'object'
            ? {
                windows: Boolean(rawWorksOn.Windows ?? rawWorksOn.windows ?? true),
                mac: Boolean(rawWorksOn.Mac ?? rawWorksOn.mac ?? false),
                linux: Boolean(rawWorksOn.Linux ?? rawWorksOn.linux ?? false),
              }
            : undefined;
        const resolvedNativePlatforms = resolvedOsPlatforms
          ? [
              ...(resolvedOsPlatforms.windows ? ['windows'] : []),
              ...(resolvedOsPlatforms.mac ? ['mac'] : []),
            ]
          : undefined;

        const hasSteamVertical = Boolean(steamAppId);

        const headerImg = steamAppId
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/header.jpg`
          : coverUrl;

        const capsuleImg = hasSteamVertical
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/library_600x900.jpg`
          : (verticalGogCover || '');

        games.push({
          id: steamAppId ? `steam-${steamAppId}` : `gog-${p.id}`,
          title,
          sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
          steamAppId,
          isVerifiedEntitlement: true,
          ...(resolvedNativePlatforms && resolvedNativePlatforms.length > 0
            ? { nativePlatforms: resolvedNativePlatforms }
            : {}),
          ...(resolvedOsPlatforms ? { worksOn: resolvedOsPlatforms } : {}),
          platforms: [
            {
              platformId: 'gog',
              platformGameId: strId,
              installed: false,
              playtimeMinutes: stats.playtime || 0,
              lastPlayed: stats.lastSession || undefined,
              achievements: gameAch || undefined,
              ...(resolvedOsPlatforms ? { platforms: resolvedOsPlatforms } : {}),
            },
          ],
          headerImage: headerImg,
          capsuleImage: capsuleImg,
          shortDescription: '',
          releaseDate: '',
          developers: [],
          publishers: [],
          genres: p.category ? [p.category] : ['Action'],
          tags: ['GOG', 'DRM-Free'],
          rating: p.rating ? p.rating * 20 : undefined,
        });
      }

      currentPage++;
    }
  } catch (err) {
    console.error('Error fetching GOG products:', err.message);
  }

  return games;
}

/**
 * Exchange Epic Authorization Code for Access & Refresh Tokens
 */
async function exchangeEpicCode(code) {
  const cleanCode = code.trim();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: cleanCode,
    token_type: 'eg1',
  });

  const res = await fetch('https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `basic ${EPIC_CLIENT_AUTH}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Epic token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Epic token response missing access_token');
  }

  saveTokens('epic', data);
  return data;
}

/**
 * Fetch Epic Games Player Achievements from official launcher GraphQL service
 * and reconcile with local Legendary metadata/*.json achievement schemas.
 */
async function fetchEpicAchievements(accessToken, accountId, options = {}) {
  const achievementsMap = {};
  const sandboxMetaLookup = new Map();
  const syncedAt = new Date().toISOString();

  // 1. Scan local Legendary metadata/*.json to seed known Epic achievement totals/XP
  //    and build a sandboxId (namespace) -> { appName, catalogItemId, title } lookup.
  try {
    const baseDirs = getLocalLegendaryBaseDirs(options);
    for (const baseDir of baseDirs) {
      if (!baseDir) continue;
      const metaDir = path.join(baseDir, 'metadata');
      if (!fs.existsSync(metaDir)) continue;
      let files = [];
      try {
        files = fs.readdirSync(metaDir).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const json = JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf-8'));
          if (!json || typeof json !== 'object') continue;
          const appName = String(json.app_name || f.replace(/\.json$/i, '')).trim();
          const appNameLower = appName.toLowerCase();
          const sandboxIdLower = String(json.namespace || json.metadata?.namespace || '')
            .toLowerCase()
            .trim();
          const catalogIdLower = String(
            json.catalog_item_id || json.id || json.metadata?.id || ''
          )
            .toLowerCase()
            .trim();
          const title = String(json.app_title || json.metadata?.title || '').trim();
          const titleLower = title.toLowerCase();
          const normTitle = titleLower
            .replace(/[:\-–—]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

          if (sandboxIdLower) {
            const existingList = sandboxMetaLookup.get(sandboxIdLower) || [];
            existingList.push({
              appNameLower,
              catalogIdLower,
              titleLower,
              normTitle,
            });
            sandboxMetaLookup.set(sandboxIdLower, existingList);
          }

          const achBlock = json.achievements;
          const achArray = Array.isArray(achBlock?.achievements) ? achBlock.achievements : [];
          const total =
            Number(achBlock?.total_achievements || 0) ||
            (achArray.length > 0 ? achArray.length : 0);

          if (total > 0) {
            const totalXP =
              Number(achBlock?.total_product_xp || 0) ||
              achArray.reduce((sum, rawItem) => {
                const a =
                  rawItem?.achievement && typeof rawItem.achievement === 'object'
                    ? rawItem.achievement
                    : rawItem;
                return sum + (Number(a?.xp ?? a?.XP ?? 0) || 0);
              }, 0);
            const seededSummary = {
              unlocked: 0,
              total,
              percentage: 0,
              xp: { earned: 0, total: totalXP },
              isMastered: false,
              source: 'local_client_cache',
              syncedAt,
            };
            if (appNameLower && !achievementsMap[appNameLower]) {
              achievementsMap[appNameLower] = seededSummary;
              achievementsMap[`epic-${appNameLower}`] = seededSummary;
            }
            if (sandboxIdLower && !achievementsMap[sandboxIdLower]) {
              achievementsMap[sandboxIdLower] = seededSummary;
            }
            if (catalogIdLower && !achievementsMap[catalogIdLower]) {
              achievementsMap[catalogIdLower] = seededSummary;
            }
            if (titleLower && !achievementsMap[titleLower]) {
              achievementsMap[titleLower] = seededSummary;
            }
            if (normTitle && !achievementsMap[normTitle]) {
              achievementsMap[normTitle] = seededSummary;
            }
          }
        } catch {}
      }
    }
  } catch {}

  if (!accountId || options.skipNetwork) {
    return achievementsMap;
  }

  try {
    const query = `query playerProfile($epicAccountId: String!, $locale: String!) {
      PlayerProfile {
        playerProfile(epicAccountId: $epicAccountId) {
          epicAccountId
          displayName
          achievementsSummaries {
            ... on PlayerAchievementResponseSuccess {
              data {
                totalUnlocked
                totalXP
                sandboxId
                product(locale: $locale) {
                  name
                  slug
                }
                productAchievements(locale: $locale) {
                  totalAchievements
                  totalProductXP
                }
              }
            }
          }
        }
      }
    }`;

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
    };
    if (accessToken) {
      headers['Authorization'] = accessToken.startsWith('bearer ') ? accessToken : `bearer ${accessToken}`;
    }

    const fetchImpl = options.fetchFn || fetch;
    const res = await fetchImpl('https://launcher.store.epicgames.com/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        variables: {
          epicAccountId: accountId,
          locale: 'en-US',
        },
      }),
    });

    if (!res.ok) {
      console.warn(`Epic achievements query returned status ${res.status}`);
      return achievementsMap;
    }

    const json = await res.json();
    const dataList = json?.data?.PlayerProfile?.playerProfile?.achievementsSummaries?.data || [];

    for (const item of dataList) {
      const total = item.productAchievements?.totalAchievements || 0;
      const unlocked = item.totalUnlocked || 0;
      const totalXP = item.productAchievements?.totalProductXP || 0;
      const earnedXP = item.totalXP || 0;
      const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
      const isMastered = total > 0 && unlocked >= total;

      const summary = {
        unlocked,
        total,
        percentage,
        xp: { earned: earnedXP, total: totalXP },
        isMastered,
        source: 'live_cloud_graphql',
        syncedAt,
      };

      const sbLower = item.sandboxId ? String(item.sandboxId).toLowerCase().trim() : '';
      if (sbLower) {
        achievementsMap[sbLower] = summary;
        const localMatches = sandboxMetaLookup.get(sbLower) || [];
        for (const m of localMatches) {
          if (m.appNameLower) {
            achievementsMap[m.appNameLower] = summary;
            achievementsMap[`epic-${m.appNameLower}`] = summary;
          }
          if (m.catalogIdLower) {
            achievementsMap[m.catalogIdLower] = summary;
          }
          if (m.titleLower) {
            achievementsMap[m.titleLower] = summary;
          }
          if (m.normTitle) {
            achievementsMap[m.normTitle] = summary;
          }
        }
      }
      if (item.product?.slug) achievementsMap[item.product.slug.toLowerCase()] = summary;
      if (item.product?.name) {
        achievementsMap[item.product.name.toLowerCase().trim()] = summary;
        const norm = item.product.name.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
        achievementsMap[norm] = summary;
      }
    }

    return achievementsMap;
  } catch (err) {
    console.warn('Epic achievements fetch warning:', err.message);
    return achievementsMap;
  }
}

/**
 * Fetch Epic Games Owned Library & Playtime
 */
async function fetchEpicOwnedGames(accessToken, accountId) {
  const playtimeMap = new Map();

  // 1. Fetch playtime if accountId is available
  if (accountId) {
    try {
      const playtimeUrl = `https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/${accountId}/all`;
      const ptRes = await fetch(playtimeUrl, {
        headers: {
          Authorization: `bearer ${accessToken}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
        },
      });

      if (ptRes.ok) {
        const ptData = await ptRes.json();
        if (Array.isArray(ptData)) {
          for (const item of ptData) {
            if (item.artifactId) {
              playtimeMap.set(item.artifactId, {
                totalTime: Math.round((item.totalTime || 0) / 60),
                lastPlayed: item.lastPlayed || null,
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn('Epic playtime fetch warning:', err.message);
    }
  }

  // 2. Fetch live achievements from Epic launcher GraphQL (seeded with local Legendary metadata)
  const achievementsMap = await fetchEpicAchievements(accessToken, accountId);
  fetchEpicOwnedGames.lastAchievementsMap = achievementsMap;

  const gamesMap = new Map();
  const knownAppIds = new Set();
  const knownTitles = new Set();
  const suppressedItems = [];
  fetchEpicOwnedGames.lastSuppressedItems = suppressedItems;

  const pushEpicSuppressedItem = (item, title, reason, description = '', developer = '', keyImages = []) => {
    if (!title || title === 'Live' || /^[0-9a-f]{20,}$/i.test(title)) return;
    const appName = item.appName || item.catalogItemId || title;
    const tallCover =
      (Array.isArray(keyImages) &&
        keyImages.find((img) => img.type === 'DieselGameBoxTall' || img.type === 'OfferImageTall')?.url) ||
      '';
    const wideBanner =
      (Array.isArray(keyImages) &&
        keyImages.find((img) => img.type === 'DieselGameBox' || img.type === 'OfferImageWide')?.url) ||
      tallCover ||
      '';
    const rawGame = {
      id: `epic-${appName}`,
      title,
      originalStoreTitle: title,
      sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
      isVerifiedEntitlement: true,
      platforms: [
        {
          platformId: 'epic',
          platformGameId: String(appName),
          originalTitle: title,
          namespace: item.namespace || undefined,
          catalogItemId: item.catalogItemId || undefined,
          installed: false,
        },
      ],
      headerImage: wideBanner,
      capsuleImage: tallCover || wideBanner,
      shortDescription: description || '',
      releaseDate: '',
      developers: developer ? [developer] : [],
      publishers: ['Epic Games Store'],
      genres: ['Action'],
      tags: ['Epic Games Store'],
    };
    suppressedItems.push({
      id: `epic-${appName}`,
      rawTitle: title,
      platformId: 'epic',
      platformGameId: String(appName),
      reason,
      reasonCategory: 'non_game_filter',
      rawGame,
    });
  };

  // 3. Fetch live items from Library Service with cursor pagination
  try {
    let cursor = undefined;
    let hasMore = true;
    let pageCount = 0;
    const candidateRecords = [];

    while (hasMore && pageCount < 30) {
      const fetchUrl = cursor
        ? `https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true&cursor=${cursor}`
        : 'https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true';

      const res = await fetch(fetchUrl, {
        headers: {
          Authorization: `bearer ${accessToken}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
        },
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error(`Epic library fetch unauthorized (${res.status})`);
        }
        console.warn(`Epic library fetch returned status ${res.status}`);
        break;
      }

      const data = await res.json();
      const records = data.records || [];
      candidateRecords.push(...records);

      cursor = data.responseMetadata?.nextCursor;
      hasMore = Boolean(cursor);
      pageCount++;
    }

    // Filter candidate records and resolve catalog metadata in parallel batches of 15
    const filteredItems = [];
    for (const item of candidateRecords) {
      if (!item.appName || item.appName === '1' || item.sandboxType === 'PRIVATE') continue;
      if (
        item.namespace === 'ue' ||
        item.namespace === '89efe5924d3d467c839449ab6ab52e7f' ||
        item.namespace?.startsWith('ue-')
      ) {
        continue;
      }
      if (item.appName?.startsWith('Fortnite_')) continue;

      const hasRealMainGame = Boolean(
        (item.metadata?.mainGameItem && (item.metadata.mainGameItem.id || item.metadata.mainGameItem.namespace)) ||
        (item.mainGameItem && (item.mainGameItem.id || item.mainGameItem.namespace))
      );
      const itemType = (item.metadata?.itemType || '').toUpperCase();
      const isNonGameType = ['ADD_ON', 'DLC', 'CONSUMABLE', 'WALLET', 'SUBSCRIPTION', 'PLUGIN', 'EXTRA', 'CURRENCY'].includes(itemType);
      const categories = item.metadata?.categories || [];
      const isAddonCategory = categories.some((c) =>
        ['addons', 'dlc', 'mods', 'digitalextras', 'consumable', 'vault'].some((sub) =>
          (c.path || '').toLowerCase().includes(sub)
        )
      );

      if (hasRealMainGame || isNonGameType || isAddonCategory) {
        const metaTitle = (item.metadata?.title || '').trim();
        if (metaTitle) {
          const reason =
            classifyNonGameStorefrontItem({
              title: metaTitle,
              platformId: 'epic',
              platformGameId: item.appName,
              isDlc: true,
              itemType,
              categories,
            }) || 'Filtered: DLC / Add-On / Expansion Content';
          pushEpicSuppressedItem(
            item,
            metaTitle,
            reason,
            item.metadata?.description || '',
            item.metadata?.developer || '',
            item.metadata?.keyImages || []
          );
        }
        continue;
      }

      const appNameLower = (item.appName || '').toLowerCase().trim();
      const catalogIdLower = (item.catalogItemId || '').toLowerCase().trim();
      if (knownAppIds.has(appNameLower) || knownAppIds.has(catalogIdLower)) continue;

      filteredItems.push(item);
    }

    const macEpicAppIds = extractEpicMacSupportFromLegendaryDirs(getLocalLegendaryBaseDirs());

    if (accessToken) {
      const macAbort = new AbortController();
      const macTimeout = setTimeout(() => macAbort.abort(), 4000);
      try {
        const macRes = await fetch(
          'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/Mac?label=Live',
          {
            signal: macAbort.signal,
            headers: {
              Authorization: `bearer ${accessToken}`,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
            },
          }
        );
        if (macRes.ok) {
          const macAssets = await macRes.json();
          if (Array.isArray(macAssets)) {
            for (const a of macAssets) {
              const an = String(a?.appName || a?.app_name || '').toLowerCase().trim();
              const cid = String(a?.catalogItemId || a?.catalog_item_id || '').toLowerCase().trim();
              const aid = String(a?.assetId || a?.asset_id || '').toLowerCase().trim();
              if (an) macEpicAppIds.add(an);
              if (cid) macEpicAppIds.add(cid);
              if (aid) macEpicAppIds.add(aid);
            }
          }
        }
      } catch {}
      clearTimeout(macTimeout);
    }

    const hasReleaseInfoPlatformMac = (relList) =>
      Array.isArray(relList) &&
      relList.some(
        (r) =>
          r &&
          Array.isArray(r.platform) &&
          r.platform.some((p) => /^mac$/i.test(String(p)))
      );

    const BATCH_SIZE = 6;
    for (let i = 0; i < filteredItems.length; i += BATCH_SIZE) {
      const batch = filteredItems.slice(i, i + BATCH_SIZE);
      const resolvedBatch = await Promise.all(
        batch.map(async (item) => {
          const appNameLower = (item.appName || '').toLowerCase().trim();
          const catalogIdLower = (item.catalogItemId || '').toLowerCase().trim();
          let title = (item.metadata?.title || '').trim();
          let description = item.metadata?.description || '';
          let developer = item.metadata?.developer || '';
          let keyImages = item.metadata?.keyImages || [];
          let hasReleaseInfoMac = hasReleaseInfoPlatformMac(item.metadata?.releaseInfo);

          if (!item.metadata?.title || title === 'Live' || !title || /^[0-9a-f]{20,}$/i.test(title)) {
            let resolvedFromCatalog = false;
            const catAbort = new AbortController();
            const catTimer = setTimeout(() => catAbort.abort(), 6000);
            try {
              const catUrl = `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${item.namespace}/bulk/items?id=${item.catalogItemId}&includeDLCDetails=true&includeMainGameDetails=true`;
              const cRes = await fetch(catUrl, {
                signal: catAbort.signal,
                headers: {
                  Authorization: `bearer ${accessToken}`,
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
                },
              });
              if (cRes.ok) {
                const cData = await cRes.json();
                const meta = cData[item.catalogItemId];
                if (meta) {
                  if (hasReleaseInfoPlatformMac(meta.releaseInfo)) {
                    hasReleaseInfoMac = true;
                  }
                  const isDlc = meta.categories?.some((c) => ['addons', 'dlc'].includes(c.path)) || Boolean(meta.mainGameItem);
                  if (isDlc) {
                    if (meta.title) {
                      const reason =
                        classifyNonGameStorefrontItem({
                          title: meta.title,
                          platformId: 'epic',
                          platformGameId: item.appName,
                          isDlc: true,
                          categories: meta.categories,
                        }) || 'Filtered: DLC / Add-On / Expansion Content';
                      pushEpicSuppressedItem(
                        item,
                        meta.title,
                        reason,
                        meta.description || '',
                        meta.developer || '',
                        meta.keyImages || []
                      );
                    }
                    return null;
                  }
                  if (meta.title) {
                    title = meta.title;
                    resolvedFromCatalog = true;
                  }
                  description = meta.description || description;
                  developer = meta.developer || developer;
                  keyImages = meta.keyImages || keyImages;
                }
              }
            } catch {
              // Ignore individual catalog failure
            } finally {
              clearTimeout(catTimer);
            }
            if (!resolvedFromCatalog && !item.metadata?.title) {
              return null;
            }
          }

          if (
            !title ||
            title === 'Live' ||
            /^[0-9a-f]{20,}$/i.test(title) ||
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(title)
          ) {
            return null;
          }

          let cleanDesc = String(description || '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/\[\/?[a-z0-9_*=\s"'-]+\]/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (
            cleanDesc.toLowerCase() === title.toLowerCase().trim() ||
            /^description is not set\.?$/i.test(cleanDesc) ||
            (!/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(title) &&
              /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(cleanDesc))
          ) {
            cleanDesc = '';
          } else {
            const bleedMatch = cleanDesc.match(/,\s+([A-Z][A-Z0-9]{3,})\s+is\s+(?:a|an|the)\b/);
            if (bleedMatch && bleedMatch[1] && !title.toUpperCase().includes(bleedMatch[1])) {
              cleanDesc = '';
            }
          }

          const nonGameReason = classifyNonGameStorefrontItem({
            title,
            platformId: 'epic',
            platformGameId: item.appName,
            isDlc: false,
            categories: item.metadata?.categories,
          });
          if (nonGameReason) {
            pushEpicSuppressedItem(item, title, nonGameReason, cleanDesc, developer, keyImages);
            return null;
          }

          registerEpicNamespaceMapping({
            appName: item.appName,
            namespace: item.namespace,
            catalogItemId: item.catalogItemId,
            title,
          });

          let offerMeta = null;
          if (!cleanDesc && item.namespace) {
            try {
              offerMeta = await fetchEpicProductOfferMetadata({
                appName: item.appName,
                namespace: item.namespace,
                catalogItemId: item.catalogItemId,
                title,
              });
              if (offerMeta?.shortDescription) {
                cleanDesc = offerMeta.shortDescription;
              }
              if (!developer && offerMeta?.developers?.[0]) {
                developer = offerMeta.developers[0];
              }
            } catch {}
          }

          return {
            item,
            appNameLower,
            catalogIdLower,
            namespaceLower: (item.namespace || '').toLowerCase().trim(),
            title,
            description: cleanDesc,
            developer,
            keyImages,
            offerMeta,
            hasReleaseInfoMac,
          };
        })
      );

      for (const entry of resolvedBatch) {
        if (!entry) continue;
        const {
          item,
          appNameLower,
          catalogIdLower,
          namespaceLower,
          title,
          description,
          developer,
          keyImages,
          offerMeta,
          hasReleaseInfoMac,
        } = entry;
        const lower = title.toLowerCase().trim();
        if (knownAppIds.has(appNameLower)) continue;

        const hasEpicMac =
          macEpicAppIds.has(appNameLower) ||
          Boolean(catalogIdLower && macEpicAppIds.has(catalogIdLower)) ||
          Boolean(hasReleaseInfoMac);

        const tallCover =
          keyImages.find((img) => img.type === 'DieselGameBoxTall' || img.type === 'OfferImageTall')?.url ||
          offerMeta?.capsuleImage;
        const wideBanner =
          keyImages.find((img) => img.type === 'DieselGameBox' || img.type === 'OfferImageWide')?.url ||
          offerMeta?.headerImage ||
          tallCover;
        const pt = playtimeMap.get(item.appName) || playtimeMap.get(item.catalogItemId) || {};
        const steamAppId = await matchSteamAppId(title);

        const headerImg = steamAppId
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/header.jpg`
          : wideBanner || 'https://cdn2.unrealengine.com/egs-badge.png';

        const capsuleImg = steamAppId
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/library_600x900.jpg`
          : tallCover || wideBanner || 'https://cdn2.unrealengine.com/egs-badge.png';

        const finalDev = developer || offerMeta?.developers?.[0] || '';
        const baseGameId = steamAppId ? `steam-${steamAppId}` : `epic-${item.appName}`;
        const gameId = gamesMap.has(baseGameId) ? `epic-${item.appName}` : baseGameId;
        const normTitle = lower.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
        const gameAch =
          (namespaceLower ? achievementsMap[namespaceLower] : null) ||
          achievementsMap[lower] ||
          achievementsMap[normTitle] ||
          achievementsMap[appNameLower] ||
          (catalogIdLower ? achievementsMap[catalogIdLower] : null);

        if (gameAch) {
          achievementsMap[appNameLower] = gameAch;
          achievementsMap[`epic-${appNameLower}`] = gameAch;
          achievementsMap[gameId.toLowerCase()] = gameAch;
          achievementsMap[lower] = gameAch;
          achievementsMap[normTitle] = gameAch;
        }

        const resolvedReleaseDate =
          offerMeta?.releaseDate ||
          (item.metadata?.releaseDate && !String(item.metadata.releaseDate).startsWith('2099')
            ? String(item.metadata.releaseDate).split('T')[0]
            : '');
        const resolvedDevs = finalDev ? [finalDev] : offerMeta?.developers || [];
        const resolvedPubs = item.metadata?.publisher
          ? [item.metadata.publisher]
          : offerMeta?.publishers || ['Epic Games Store'];

        const newGame = {
          id: gameId,
          title,
          sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
          steamAppId,
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'epic',
              platformGameId: item.appName,
              namespace: item.namespace || offerMeta?.namespace || undefined,
              catalogItemId: item.catalogItemId || offerMeta?.catalogItemId || undefined,
              installed: false,
              playtimeMinutes: pt.totalTime || 0,
              lastPlayed: pt.lastPlayed || undefined,
              achievements: gameAch || undefined,
              platforms: { windows: true, mac: hasEpicMac, linux: false },
            },
          ],
          headerImage: headerImg,
          capsuleImage: capsuleImg,
          shortDescription: description || offerMeta?.shortDescription || '',
          detailedDescription: offerMeta?.detailedDescription || undefined,
          releaseDate: resolvedReleaseDate,
          developers: resolvedDevs,
          publishers: resolvedPubs,
          genres: ['Action'],
          tags: ['Epic Games Store'],
          enrichedMetadata: offerMeta
            ? {
                appId: steamAppId || 0,
                name: title,
                shortDescription: description || offerMeta.shortDescription || '',
                detailedDescription: offerMeta.detailedDescription || description || '',
                aboutTheGame: offerMeta.aboutTheGame || offerMeta.detailedDescription || description || '',
                headerImage: offerMeta.headerImage || headerImg,
                capsuleImage: offerMeta.capsuleImage || capsuleImg,
                developers: resolvedDevs,
                publishers: resolvedPubs,
                genres: ['Action'],
                tags: ['Epic Games Store'],
                categories: [],
                screenshots: Array.isArray(offerMeta.screenshots)
                  ? offerMeta.screenshots.map((url, idx) => ({
                      id: idx,
                      pathThumbnail: url,
                      pathFull: url,
                    }))
                  : [],
                movies: [],
                releaseDate: resolvedReleaseDate || 'Available Now',
                platforms: { windows: true, mac: hasEpicMac, linux: false },
              }
            : undefined,
        };

        gamesMap.set(gameId, newGame);
        knownTitles.add(lower);
        knownAppIds.add(appNameLower);
        if (catalogIdLower) knownAppIds.add(catalogIdLower);
      }
    }
  } catch (err) {
    console.error('Error fetching Epic library items:', err.message);
    if (String(err && err.message).includes('unauthorized')) {
      throw err;
    }
  }

  return Array.from(gamesMap.values());
}

/**
 * Automatically renew Epic Games access token using refresh_token
 */
async function renewEpicTokens(refreshToken) {
  const inflightKey = `epic:${String(refreshToken || '')}`;
  if (inFlightTokenRenewals.has(inflightKey)) {
    return inFlightTokenRenewals.get(inflightKey);
  }

  const renewalPromise = (async () => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      token_type: 'eg1',
    });

    const res = await fetch('https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `basic ${EPIC_CLIENT_AUTH}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error(`Failed to renew Epic token (${res.status})`);
    }

    const data = await res.json();
    if (!data.access_token) {
      throw new Error('Epic refresh response missing access_token');
    }

    saveTokens('epic', data);
    return data;
  })().finally(() => {
    inFlightTokenRenewals.delete(inflightKey);
  });

  inFlightTokenRenewals.set(inflightKey, renewalPromise);
  return renewalPromise;
}

const epicAppNamespaceCache = new Map();
const epicOfferMetadataCache = new Map();
let cachedEpicClientToken = null;
let cachedEpicClientTokenExpiry = 0;
let hasScannedLocalEpicMetadata = false;
let hasFetchedEpicCloudAssets = false;

function registerEpicNamespaceMapping({ appName, namespace, catalogItemId, title } = {}) {
  if (!namespace) return;
  const entry = {
    appName: appName ? String(appName).trim() : undefined,
    namespace: String(namespace).trim(),
    catalogItemId: catalogItemId ? String(catalogItemId).trim() : undefined,
    title: title ? String(title).trim() : undefined,
  };
  if (entry.appName) {
    setBoundedCacheEntry(epicAppNamespaceCache, 'app:' + entry.appName.toLowerCase(), entry, MAX_STORE_SYNC_CACHE_ENTRIES);
  }
  if (entry.catalogItemId) {
    setBoundedCacheEntry(epicAppNamespaceCache, 'cat:' + entry.catalogItemId.toLowerCase(), entry, MAX_STORE_SYNC_CACHE_ENTRIES);
  }
  if (entry.title) {
    const norm = entry.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm) {
      setBoundedCacheEntry(epicAppNamespaceCache, 'title:' + norm, entry, MAX_STORE_SYNC_CACHE_ENTRIES);
    }
  }
}

async function getEpicCatalogAccessToken(forceClientCredentials = false) {
  if (!forceClientCredentials) {
    try {
      const saved = loadSavedTokens()?.epic;
      if (saved?.access_token) {
        const expiresAtMs = saved.expires_at ? new Date(saved.expires_at).getTime() : 0;
        if (expiresAtMs && expiresAtMs - Date.now() < 60000 && saved.refresh_token) {
          try {
            const renewed = await renewEpicTokens(saved.refresh_token);
            if (renewed?.access_token) return renewed.access_token;
          } catch {}
        } else if (!expiresAtMs || expiresAtMs > Date.now()) {
          return saved.access_token;
        }
      }
    } catch {}
  }

  if (cachedEpicClientToken && Date.now() < cachedEpicClientTokenExpiry) {
    return cachedEpicClientToken;
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      token_type: 'eg1',
    });
    const res = await fetch('https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `basic ${EPIC_CLIENT_AUTH}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
      },
      body: body.toString(),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.access_token) {
        cachedEpicClientToken = data.access_token;
        cachedEpicClientTokenExpiry = Date.now() + ((data.expires_in || 3600) - 120) * 1000;
        return data.access_token;
      }
    }
  } catch (err) {
    console.warn('Failed to obtain Epic client_credentials token:', err.message);
  }

  return null;
}

function getLocalLegendaryBaseDirs(options = {}) {
  if (Array.isArray(options?.legendaryBaseDirs)) {
    return options.legendaryBaseDirs;
  }
  const hasExplicitIsolation = Boolean(options?.homedir || options?.userDataDir);
  const homeDir = options?.homedir || process.env.HOME || process.env.USERPROFILE || '';
  const userDataDir =
    options?.userDataDir ||
    (() => {
      if (hasExplicitIsolation) return '';
      try {
        return app ? app.getPath('userData') : '';
      } catch {
        return '';
      }
    })();

  const candidates = [
    homeDir ? path.join(homeDir, '.config/legendary') : '',
    homeDir ? path.join(homeDir, 'Library/Application Support/heroic/legendaryConfig/legendary') : '',
    userDataDir ? path.join(userDataDir, 'legendaryConfig/legendary') : '',
    !hasExplicitIsolation && homeDir
      ? path.join(homeDir, 'Library/Application Support/one-launcher/legendaryConfig/legendary')
      : '',
    !hasExplicitIsolation && homeDir
      ? path.join(homeDir, 'Library/Application Support/One Launcher/legendaryConfig/legendary')
      : '',
    !hasExplicitIsolation && process.env.APPDATA
      ? path.join(process.env.APPDATA, 'one-launcher/legendaryConfig/legendary')
      : '',
    !hasExplicitIsolation && process.env.APPDATA
      ? path.join(process.env.APPDATA, 'heroic/legendaryConfig/legendary')
      : '',
    homeDir ? path.join(homeDir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary') : '',
  ].filter(Boolean);

  return Array.from(new Set(candidates));
}

function extractEpicMacSupportFromLegendaryDirs(baseDirs = getLocalLegendaryBaseDirs()) {
  const macEpicAppIds = new Set();
  const dirs = Array.isArray(baseDirs) ? baseDirs : getLocalLegendaryBaseDirs();
  for (const baseDir of dirs) {
    if (!baseDir || !fs.existsSync(baseDir)) continue;
    const assetsFile = path.join(baseDir, 'assets.json');
    if (fs.existsSync(assetsFile)) {
      try {
        const assetsJson = JSON.parse(fs.readFileSync(assetsFile, 'utf-8'));
        const macList = Array.isArray(assetsJson?.Mac)
          ? assetsJson.Mac
          : Array.isArray(assetsJson)
            ? assetsJson.filter(
                (it) =>
                  String(it?.platform || '').toLowerCase() === 'mac' ||
                  Boolean(it?.asset_infos?.Mac && Object.keys(it.asset_infos.Mac).length > 0)
              )
            : [];
        for (const a of macList) {
          const an = String(a?.app_name || a?.appName || '').toLowerCase().trim();
          const cid = String(a?.catalog_item_id || a?.catalogItemId || '').toLowerCase().trim();
          const aid = String(a?.asset_id || a?.assetId || '').toLowerCase().trim();
          if (an) macEpicAppIds.add(an);
          if (cid) macEpicAppIds.add(cid);
          if (aid) macEpicAppIds.add(aid);
        }
      } catch {}
    }

    const metaDir = path.join(baseDir, 'metadata');
    if (fs.existsSync(metaDir)) {
      try {
        const files = fs.readdirSync(metaDir).filter((f) => f.endsWith('.json'));
        for (const f of files) {
          try {
            const json = JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf-8'));
            const hasMacAssetInfo = Boolean(
              json?.asset_infos?.Mac && Object.keys(json.asset_infos.Mac).length > 0
            );
            const releaseInfo = json?.metadata?.releaseInfo || json?.releaseInfo;
            const hasMacRelease =
              Array.isArray(releaseInfo) &&
              releaseInfo.some(
                (r) =>
                  r &&
                  Array.isArray(r.platform) &&
                  r.platform.some((p) => /^mac$/i.test(String(p)))
              );
            if (hasMacAssetInfo || hasMacRelease) {
              const an = String(json?.app_name || f.replace(/\.json$/i, ''))
                .toLowerCase()
                .trim();
              const cid = String(json?.metadata?.id || json?.catalog_item_id || json?.id || '')
                .toLowerCase()
                .trim();
              if (an) macEpicAppIds.add(an);
              if (cid) macEpicAppIds.add(cid);
            }
          } catch {}
        }
      } catch {}
    }
  }
  return macEpicAppIds;
}

async function resolveEpicNamespaceAndIds(payload = {}) {
  const rawAppName = String(payload.appName || payload.slug || '')
    .replace(/^epic-/i, '')
    .trim();
  const normTitle = String(payload.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  if (payload.namespace && String(payload.namespace).trim()) {
    return {
      namespace: String(payload.namespace).trim(),
      catalogItemId: payload.catalogItemId ? String(payload.catalogItemId).trim() : null,
      appName: rawAppName || null,
    };
  }

  const lookupInCache = () => {
    if (rawAppName && epicAppNamespaceCache.has('app:' + rawAppName.toLowerCase())) {
      return epicAppNamespaceCache.get('app:' + rawAppName.toLowerCase());
    }
    if (payload.catalogItemId && epicAppNamespaceCache.has('cat:' + String(payload.catalogItemId).toLowerCase())) {
      return epicAppNamespaceCache.get('cat:' + String(payload.catalogItemId).toLowerCase());
    }
    if (normTitle && epicAppNamespaceCache.has('title:' + normTitle)) {
      return epicAppNamespaceCache.get('title:' + normTitle);
    }
    return null;
  };

  let cached = lookupInCache();
  if (cached?.namespace) return cached;

  // 2. Check local Legendary / Heroic metadata files
  const legendaryBaseDirs = getLocalLegendaryBaseDirs();
  if (rawAppName) {
    for (const baseDir of legendaryBaseDirs) {
      const metaFile = path.join(baseDir, 'metadata', `${rawAppName}.json`);
      if (fs.existsSync(metaFile)) {
        try {
          const json = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
          const ns = json?.metadata?.namespace || json?.namespace;
          const catId = json?.metadata?.id || json?.catalog_item_id;
          const t = json?.app_title || json?.metadata?.title;
          if (ns) {
            registerEpicNamespaceMapping({
              appName: json?.app_name || rawAppName,
              namespace: ns,
              catalogItemId: catId,
              title: t,
            });
            cached = lookupInCache();
            if (cached?.namespace) return cached;
          }
        } catch {}
      }
    }
  }

  if (!hasScannedLocalEpicMetadata) {
    hasScannedLocalEpicMetadata = true;
    for (const baseDir of legendaryBaseDirs) {
      const assetsFile = path.join(baseDir, 'assets.json');
      if (fs.existsSync(assetsFile)) {
        try {
          const assetsJson = JSON.parse(fs.readFileSync(assetsFile, 'utf-8'));
          for (const list of Object.values(assetsJson || {})) {
            if (Array.isArray(list)) {
              for (const item of list) {
                registerEpicNamespaceMapping({
                  appName: item?.app_name || item?.appName,
                  namespace: item?.namespace,
                  catalogItemId: item?.catalog_item_id || item?.catalogItemId,
                  title: item?.app_title || item?.title,
                });
              }
            }
          }
        } catch {}
      }

      const installedFile = path.join(baseDir, 'installed.json');
      if (fs.existsSync(installedFile)) {
        try {
          const instJson = JSON.parse(fs.readFileSync(installedFile, 'utf-8'));
          for (const item of Object.values(instJson || {})) {
            if (item && typeof item === 'object') {
              registerEpicNamespaceMapping({
                appName: item.app_name || item.appName,
                namespace: item.namespace,
                catalogItemId: item.catalog_item_id || item.catalogItemId,
                title: item.title || item.app_title,
              });
            }
          }
        } catch {}
      }

      const metaDir = path.join(baseDir, 'metadata');
      if (fs.existsSync(metaDir)) {
        try {
          const files = fs.readdirSync(metaDir).filter((f) => f.endsWith('.json'));
          for (const f of files) {
            try {
              const json = JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf-8'));
              registerEpicNamespaceMapping({
                appName: json?.app_name || f.replace(/\.json$/i, ''),
                namespace: json?.metadata?.namespace || json?.namespace,
                catalogItemId: json?.metadata?.id || json?.catalog_item_id,
                title: json?.app_title || json?.metadata?.title,
              });
            } catch {}
          }
        } catch {}
      }
    }

    // 3. Check local Epic Games Launcher Manifests/*.item
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const manifestDirs = [
      homeDir ? path.join(homeDir, 'Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests') : '',
      'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests',
    ].filter(Boolean);

    for (const mDir of manifestDirs) {
      if (fs.existsSync(mDir)) {
        try {
          const itemFiles = fs.readdirSync(mDir).filter((f) => f.endsWith('.item'));
          for (const f of itemFiles) {
            try {
              const json = JSON.parse(fs.readFileSync(path.join(mDir, f), 'utf-8'));
              registerEpicNamespaceMapping({
                appName: json?.AppName,
                namespace: json?.CatalogNamespace,
                catalogItemId: json?.CatalogItemId,
                title: json?.DisplayName,
              });
            } catch {}
          }
        } catch {}
      }
    }
  }

  cached = lookupInCache();
  if (cached?.namespace) return cached;

  // 4. If still unresolved and user has a saved Epic token, query public assets list once
  if (!hasFetchedEpicCloudAssets) {
    const savedEpic = loadSavedTokens()?.epic;
    if (savedEpic?.access_token) {
      hasFetchedEpicCloudAssets = true;
      try {
        let token = await getEpicCatalogAccessToken(false);
        if (token) {
          let assetsRes = await fetch(
            'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/Windows?label=Live',
            {
              headers: {
                Authorization: `bearer ${token}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
              },
            }
          );
          if ((assetsRes.status === 401 || assetsRes.status === 403) && savedEpic.refresh_token) {
            try {
              const renewed = await renewEpicTokens(savedEpic.refresh_token);
              token = renewed.access_token;
              assetsRes = await fetch(
                'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/Windows?label=Live',
                {
                  headers: {
                    Authorization: `bearer ${token}`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
                  },
                }
              );
            } catch {}
          }
          if (assetsRes.ok) {
            const assetsList = await assetsRes.json();
            if (Array.isArray(assetsList)) {
              for (const asset of assetsList) {
                registerEpicNamespaceMapping({
                  appName: asset?.appName,
                  namespace: asset?.namespace,
                  catalogItemId: asset?.catalogItemId,
                });
              }
            }
          }
        }
      } catch {}
    }
  }

  cached = lookupInCache();
  if (cached?.namespace) return cached;

  return {
    namespace: payload.namespace || null,
    catalogItemId: payload.catalogItemId || null,
    appName: rawAppName || null,
  };
}

function extractFirstOfferParagraph(rawLong) {
  if (!rawLong) return '';
  const cleaned = String(rawLong)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();

  if (!cleaned) return '';
  const paragraphs = cleaned
    .split(/\r?\n+/)
    .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 25 && !/^(about|overview|description|features|story)$/i.test(line));

  if (paragraphs.length === 0) return '';
  let first = paragraphs[0];
  if (first.length > 280) {
    const sub = first.substring(0, 280);
    const lastSpace = sub.lastIndexOf(' ');
    first = (lastSpace > 180 ? sub.substring(0, lastSpace) : sub).trim() + '...';
  }
  return first;
}

async function fetchEpicProductOfferMetadata(payload = {}) {
  try {
    const resolved = await resolveEpicNamespaceAndIds(payload);
    const namespace = resolved?.namespace;
    const catalogItemId = resolved?.catalogItemId || payload.catalogItemId;
    if (!namespace) return null;

    const cacheKey = `${namespace}:${String(catalogItemId || resolved?.appName || payload.title || '').toLowerCase()}`;
    if (epicOfferMetadataCache.has(cacheKey)) {
      return epicOfferMetadataCache.get(cacheKey);
    }

    let token = await getEpicCatalogAccessToken(false);
    if (!token) {
      token = await getEpicCatalogAccessToken(true);
    }
    if (!token) return null;

    const offersUrl = `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${encodeURIComponent(namespace)}/offers?count=20&locale=en-US&country=US`;
    let res = await fetch(offersUrl, {
      headers: {
        Authorization: `bearer ${token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
      },
    });

    if (res.status === 401 || res.status === 403) {
      token = await getEpicCatalogAccessToken(true);
      if (token) {
        res = await fetch(offersUrl, {
          headers: {
            Authorization: `bearer ${token}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
          },
        });
      }
    }

    if (!res.ok) return null;
    const data = await res.json();
    const elements = Array.isArray(data?.elements) ? data.elements : [];
    if (elements.length === 0) return null;

    const normTarget = String(payload.title || resolved?.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

    const baseGameOffers = elements.filter((el) => el && el.offerType === 'BASE_GAME');
    let offer = null;
    if (baseGameOffers.length > 0) {
      offer =
        (normTarget
          ? baseGameOffers.find(
              (el) =>
                String(el.title || '')
                  .toLowerCase()
                  .replace(/[^a-z0-9]/g, '') === normTarget
            )
          : null) || baseGameOffers[0];
    }
    if (!offer && normTarget) {
      offer = elements.find(
        (el) =>
          el &&
          String(el.title || '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '') === normTarget
      );
    }
    if (!offer) {
      offer =
        elements.find(
          (el) =>
            el &&
            el.offerType !== 'ADD_ON' &&
            el.offerType !== 'DLC' &&
            el.offerType !== 'CONSUMABLE'
        ) || elements[0];
    }
    if (!offer) return null;

    const offerTitle = String(offer.title || payload.title || resolved?.title || '').trim();
    let rawShort = String(offer.description || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (
      rawShort.toLowerCase() === offerTitle.toLowerCase() ||
      /^description is not set\.?$/i.test(rawShort)
    ) {
      rawShort = '';
    }

    const rawLong = String(offer.longDescription || offer.technicalDetails || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();

    if (!rawShort && rawLong) {
      rawShort = extractFirstOfferParagraph(rawLong);
    }

    const keyImages = Array.isArray(offer.keyImages) ? offer.keyImages : [];
    const screenshotSet = new Set();
    for (const img of keyImages) {
      if (!img || typeof img.url !== 'string') continue;
      if (
        (img.type === 'featuredMedia' || img.type === 'GalleryImage' || img.type === 'Screenshot') &&
        img.url.startsWith('http')
      ) {
        screenshotSet.add(img.url);
      }
    }
    for (const img of keyImages) {
      if (!img || typeof img.url !== 'string') continue;
      if (img.type === 'heroCarouselVideo' && img.url.includes('cover=')) {
        try {
          const coverParam = decodeURIComponent(img.url.split('cover=')[1].split('&')[0]);
          if (coverParam.startsWith('http')) {
            screenshotSet.add(coverParam);
          }
        } catch {}
      }
    }

    const headerImage =
      keyImages.find((img) => img?.type === 'OfferImageWide')?.url ||
      keyImages.find((img) => img?.type === 'DieselGameBox')?.url ||
      keyImages.find((img) => img?.type === 'Thumbnail')?.url ||
      undefined;
    const capsuleImage =
      keyImages.find((img) => img?.type === 'OfferImageTall')?.url ||
      keyImages.find((img) => img?.type === 'DieselGameBoxTall')?.url ||
      undefined;

    const movies = [];
    let systemRequirements = undefined;
    let languages = undefined;

    // Resolve candidate product slugs from offer mappings, attributes, and title to fetch video trailers from Epic Content API
    const rawSlugCandidates = [
      ...(Array.isArray(offer.catalogNs?.mappings)
        ? offer.catalogNs.mappings.map((m) => m?.pageSlug)
        : []),
      typeof offer.productSlug === 'string' ? offer.productSlug.split('/')[0] : '',
      typeof offer.urlSlug === 'string' ? offer.urlSlug : '',
      ...(Array.isArray(offer.customAttributes)
        ? offer.customAttributes
            .filter((a) => a && /slug/i.test(String(a.key || '')))
            .map((a) => String(a.value || '').replace(/\/home$/i, ''))
        : offer.customAttributes && typeof offer.customAttributes === 'object'
        ? [
            offer.customAttributes['com.epicgames.app.productSlug']?.value?.replace(/\/home$/i, ''),
            ...Object.entries(offer.customAttributes)
              .filter(([k]) => /slug/i.test(k))
              .map(([, v]) => String(v?.value || v || '').replace(/\/home$/i, '')),
          ]
        : []),
      offerTitle
        ? offerTitle
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
        : '',
      payload.slug
        ? String(payload.slug)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
        : '',
    ];

    const candidateSlugs = Array.from(
      new Set(
        rawSlugCandidates
          .map((s) => String(s || '').trim().toLowerCase())
          .filter((s) => s.length > 1 && !/^[0-9a-f]{20,}$/i.test(s))
      )
    );

    for (const cSlug of candidateSlugs) {
      try {
        const contentUrl = `https://store-content.ak.epicgames.com/api/en-US/content/products/${encodeURIComponent(cSlug)}`;
        const contentRes = await fetch(contentUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
            Accept: 'application/json',
          },
        });
        if (!contentRes.ok) continue;
        const contentData = await contentRes.json();
        const home =
          (Array.isArray(contentData?.pages) &&
            contentData.pages.find((p) => p && p.type === 'productHome')) ||
          contentData?.pages?.[0];
        if (!home?.data) continue;

        const d = home.data;
        const carouselItems = Array.isArray(d.carousel?.items) ? d.carousel.items : [];
        carouselItems.forEach((item, idx) => {
          if (!item) return;
          const rawImg =
            item.image?.src ||
            item.image?.url ||
            (typeof item.image === 'string' ? item.image : null) ||
            item.src ||
            item.url;
          if (typeof rawImg === 'string' && rawImg.startsWith('http')) {
            screenshotSet.add(rawImg);
          }

          if (item.video?.recipes) {
            try {
              const recipes =
                typeof item.video.recipes === 'string'
                  ? JSON.parse(item.video.recipes)
                  : item.video.recipes;
              const langObj =
                recipes?.['en-US'] ||
                recipes?.['en'] ||
                (recipes && typeof recipes === 'object' ? Object.values(recipes)[0] : null);
              if (Array.isArray(langObj)) {
                const hlsOutput = langObj
                  .find((r) => r && r.recipe === 'video-hls')
                  ?.outputs?.find((o) => o && o.key === 'manifest');
                const mp4Output = langObj
                  .find((r) => r && (r.recipe === 'video-fmp4' || r.recipe === 'video-webm'))
                  ?.outputs?.find((o) => o && o.key === 'manifest');
                const thumbOutput = langObj
                  .find((r) => Array.isArray(r?.outputs) && r.outputs.some((o) => o?.key === 'thumbnail'))
                  ?.outputs?.find((o) => o?.key === 'thumbnail');

                const videoUrl = hlsOutput?.url || mp4Output?.url;
                const thumbUrl = thumbOutput?.url || '';
                if (videoUrl) {
                  movies.push({
                    id: idx,
                    name: `Trailer ${movies.length + 1}`,
                    thumbnail: thumbUrl,
                    webm: { '480': videoUrl, max: videoUrl },
                    mp4: { '480': videoUrl, max: videoUrl },
                    hls: hlsOutput?.url,
                  });
                }
                if (thumbUrl && thumbUrl.startsWith('http')) {
                  screenshotSet.add(thumbUrl);
                }
              }
            } catch {}
          }
        });

        const galleryImages = Array.isArray(d.gallery?.galleryImages) ? d.gallery.galleryImages : [];
        for (const g of galleryImages) {
          const gUrl = g?.src || g?.url || (typeof g === 'string' ? g : null);
          if (typeof gUrl === 'string' && gUrl.startsWith('http')) {
            screenshotSet.add(gUrl);
          }
        }

        const reqs = Array.isArray(d.requirements?.systems?.[0]?.details)
          ? d.requirements.systems[0].details
          : [];
        if (reqs.length > 0) {
          const minReq = reqs
            .map((r) => (r?.title && r?.minimum ? `<strong>${r.title}:</strong> ${r.minimum}` : ''))
            .filter(Boolean)
            .join('<br>');
          const recReq = reqs
            .map((r) =>
              r?.title && r?.recommended ? `<strong>${r.title}:</strong> ${r.recommended}` : ''
            )
            .filter(Boolean)
            .join('<br>');
          if (minReq || recReq) {
            systemRequirements = { minimum: minReq, recommended: recReq };
          }
        }

        if (Array.isArray(d.requirements?.languages) && d.requirements.languages.length > 0) {
          languages = d.requirements.languages.filter(
            (l) => typeof l === 'string' && l.trim().length > 0
          );
        } else if (typeof d.requirements?.languages === 'string' && d.requirements.languages.trim()) {
          languages = [d.requirements.languages.trim()];
        }

        if (!rawLong) {
          const contentDesc = String(
            d.about?.description || d.about?.about || d.markdown?.markdown || ''
          )
            .replace(/<!--[\s\S]*?-->/g, '')
            .trim();
          if (contentDesc) {
            rawShort = rawShort || extractFirstOfferParagraph(contentDesc);
          }
        }

        break;
      } catch {}
    }

    let screenshots = Array.from(screenshotSet);
    if (screenshots.length === 0 && headerImage) {
      screenshots = [headerImage];
    }

    const rawDate =
      offer.pcReleaseDate || offer.releaseDate || offer.effectiveDate || offer.viewableDate || '';
    const releaseDate =
      rawDate && !String(rawDate).startsWith('2099')
        ? String(rawDate).substring(0, 10)
        : undefined;

    const devName = String(offer.developerDisplayName || offer.seller?.name || '').trim();
    const pubName = String(offer.publisherDisplayName || offer.seller?.name || '').trim();

    const result = {
      title: offerTitle || undefined,
      shortDescription: rawShort || undefined,
      detailedDescription: rawLong || rawShort || undefined,
      aboutTheGame: rawLong || rawShort || undefined,
      screenshots,
      movies: movies.length > 0 ? movies : undefined,
      systemRequirements,
      languages,
      supportedLanguages:
        Array.isArray(languages) && languages.length > 0 ? languages.join(' | ') : undefined,
      headerImage,
      capsuleImage,
      releaseDate,
      developers: devName ? [devName] : undefined,
      publishers: pubName ? [pubName] : undefined,
      namespace,
      catalogItemId: catalogItemId || offer.id || undefined,
    };

    setBoundedCacheEntry(epicOfferMetadataCache, cacheKey, result, MAX_STORE_SYNC_CACHE_ENTRIES);
    return result;
  } catch (err) {
    console.warn('fetchEpicProductOfferMetadata warning:', err.message);
    return null;
  }
}

async function fetchIgdbCover(gameTitle) {
  if (!gameTitle) return null;
  const cleanTitle = gameTitle.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  try {
    const url = `https://lutris.net/api/games?search=${encodeURIComponent(cleanTitle)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.results || [];
    if (items.length === 0) return null;

    const normTarget = cleanTitle.toLowerCase();
    let bestCover = null;
    let bestScore = -1;

    for (const item of items) {
      if (!item.coverart) continue;
      const candNorm = (item.name || '').toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
      let score = computeTokenSimilarity(normTarget, candNorm) * 100;
      if (candNorm === normTarget) score += 100;

      if (score > bestScore && score >= 50) {
        bestScore = score;
        const m = item.coverart.match(/\/([a-zA-Z0-9_-]+)\.(?:jpg|png|webp)/i);
        if (m && !m[1].startsWith('library_capsule_') && !m[1].startsWith('banner_')) {
          bestCover = `https://images.igdb.com/igdb/image/upload/t_cover_big/${m[1]}.jpg`;
        } else if (!item.coverart.includes('default') && !item.coverart.includes('placeholder')) {
          bestCover = item.coverart;
        }
      }
    }
    return bestCover;
  } catch (err) {
    console.warn('IGDB cover fetch warning:', err.message);
  }
  return null;
}

/**
 * Classifies whether a storefront item is a non-game (beta, test branch, prologue, tool/SDK/redistributable, soundtrack/artbook, or DLC/add-on)
 * and returns a descriptive suppression reason string, or null if it is a standalone base game.
 */
function classifyNonGameStorefrontItem({
  title = '',
  platformId = '',
  platformGameId = '',
  isDlc = false,
  itemType = '',
  categories = [],
} = {}) {
  const cleanTitle = String(title || '').trim();
  const lower = cleanTitle.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  const platIdLower = String(platformGameId || '').toLowerCase().trim();

  // 1. Tools / Editors / Redistributables / Servers / SDKs
  if (
    platIdLower === 'gog-redist' ||
    /\b(pre-game\s+editor|resource\s+archiver|dedicated\s+server|authoring\s+tools|mod\s+kit|modkit|sdk|redistributables?|common\s+redistributables|benchmark\s+tool)\b/i.test(
      cleanTitle
    )
  ) {
    return 'Filtered: Tool / Editor / Redistributable / Server';
  }

  // 2. Soundtracks / Artbooks / Digital Goodies / Bonus Content
  if (
    /\b(digital\s+soundtrack|original\s+soundtrack|official\s+soundtrack|soundtrack|ost|art\s*book|artbook|digital\s+goodies|goodies\s+pack|wallpaper|hd\s+wallpaper|hd\s+sound|hd\s+texture|voice\s+pack|bonus\s+content)\b/i.test(
      cleanTitle
    ) ||
    lower === 'death stranding content'
  ) {
    return 'Filtered: Digital Soundtrack / Artbook / Bonus Content';
  }

  // 3. Betas / Test Branches / Legacy Clients / Multiplayer-Only Clients
  if (
    /\b(beta|public\s+test|public\s+testing|tech\s+beta|closed\s+beta|open\s+beta|test\s+branch|test\s+server|legacy\s+mode|experimental\s+branch|playtest|stress\s+test|staging| technical\s+test)\b/i.test(
      cleanTitle
    ) ||
    /(?:tech|closed|open)?beta$/i.test(compact) ||
    lower === 'sin multiplayer'
  ) {
    return 'Filtered: Beta / Test Branch / Legacy Client';
  }

  // 4. Prologues / Playable Teasers / Demos / Alphas / Trials
  if (
    /\b(prologue|playable\s+teaser|demo|free\s+trial|trial\s+version|alpha\s+version|teaser)\b/i.test(
      cleanTitle
    )
  ) {
    return 'Filtered: Prologue / Playable Teaser / Demo / Alpha';
  }

  // 5. Explicit DLC / Add-On / Expansion / Pack flags or title patterns
  const catHasDlc =
    Array.isArray(categories) &&
    categories.some((c) =>
      ['addons', 'dlc', 'mods', 'digitalextras', 'consumable', 'vault'].some((sub) =>
        String(c?.path || '').toLowerCase().includes(sub)
      )
    );
  const typeUpper = String(itemType || '').toUpperCase();
  const isDlcType = [
    'ADD_ON',
    'DLC',
    'CONSUMABLE',
    'WALLET',
    'SUBSCRIPTION',
    'PLUGIN',
    'EXTRA',
    'CURRENCY',
  ].includes(typeUpper);

  if (
    isDlc ||
    catHasDlc ||
    isDlcType ||
    /\b(dlc|season\s+pass|expansion\s+pass|add-on|addon|starter\s+pack|upgrade\s+pack|supporter\s+pack|cosmetic\s+pack|weapon\s+pack|skin\s+pack)\b/i.test(
      cleanTitle
    )
  ) {
    return 'Filtered: DLC / Add-On / Expansion Content';
  }

  return null;
}

/**
 * Scans local storefront metadata caches (Legendary/Heroic Epic metadata, Heroic GOG library cache, saved tokens)
 * to discover all owned non-game items (betas, test branches, prologues, tools/editors, soundtracks/artbooks, DLCs)
 * so they appear in the Library Match & Overrides Studio while remaining suppressed from the main game library.
 */
const suppressedEpicMetaFileCache = new Map();
const suppressedGogCacheFileCache = new Map();
const epicSchemaFileCache = new Map();

function scanLocalSuppressedStorefrontItems(customOptions = {}) {
  const resultsMap = new Map();
  const homeDir = customOptions.homedir || process.env.HOME || process.env.USERPROFILE || '';

  const addSuppressedEntry = (entry) => {
    if (!entry || !entry.platformId || !entry.platformGameId || !entry.rawTitle) return;
    const key = `${entry.platformId}:${entry.platformGameId}`;
    if (!resultsMap.has(key)) {
      resultsMap.set(key, entry);
    }
  };

  // 1. Scan Legendary / Heroic Epic metadata directories (mtimeMs-cached per JSON file)
  const legendaryDirs = customOptions.legendaryDirs || getLocalLegendaryBaseDirs();
  for (const baseDir of legendaryDirs) {
    const metaDir = path.join(baseDir, 'metadata');
    if (!fs.existsSync(metaDir)) continue;
    try {
      const files = fs.readdirSync(metaDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const fullMetaPath = path.join(metaDir, file);
        try {
          const st = fs.statSync(fullMetaPath);
          const cached = suppressedEpicMetaFileCache.get(fullMetaPath);
          if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
            if (cached.entry) {
              addSuppressedEntry(cached.entry);
            }
            continue;
          }

          const json = JSON.parse(fs.readFileSync(fullMetaPath, 'utf-8'));
          const appName = String(json?.app_name || file.replace(/\.json$/i, '')).trim();
          const title = String(json?.app_title || json?.metadata?.title || '').trim();
          if (
            !appName ||
            !title ||
            title === '1' ||
            title === 'Live' ||
            /^[0-9a-f]{20,}$/i.test(title) ||
            appName.startsWith('Fortnite_')
          ) {
            suppressedEpicMetaFileCache.set(fullMetaPath, {
              mtimeMs: st.mtimeMs,
              size: st.size,
              entry: null,
            });
            continue;
          }
          const ns = json?.metadata?.namespace || json?.namespace || '';
          if (ns === 'ue' || ns === '89efe5924d3d467c839449ab6ab52e7f' || String(ns).startsWith('ue-')) {
            suppressedEpicMetaFileCache.set(fullMetaPath, {
              mtimeMs: st.mtimeMs,
              size: st.size,
              entry: null,
            });
            continue;
          }

          const categories = json?.metadata?.categories || [];
          const hasMainGame = Boolean(
            json?.metadata?.mainGameItem &&
              (json.metadata.mainGameItem.id || json.metadata.mainGameItem.namespace)
          );
          const itemType = json?.metadata?.itemType || '';
          const reason = classifyNonGameStorefrontItem({
            title,
            platformId: 'epic',
            platformGameId: appName,
            isDlc: hasMainGame,
            itemType,
            categories,
          });

          let entry = null;
          if (reason) {
            const keyImages = json?.metadata?.keyImages || [];
            const tallCover =
              (Array.isArray(keyImages) &&
                keyImages.find((img) => img.type === 'DieselGameBoxTall' || img.type === 'OfferImageTall')?.url) ||
              '';
            const wideBanner =
              (Array.isArray(keyImages) &&
                keyImages.find((img) => img.type === 'DieselGameBox' || img.type === 'OfferImageWide')?.url) ||
              tallCover ||
              '';
            const developer = json?.metadata?.developer || '';
            const description = json?.metadata?.description || '';
            const catId = json?.metadata?.id || json?.catalog_item_id || undefined;

            const rawGame = {
              id: `epic-${appName}`,
              title,
              originalStoreTitle: title,
              sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
              isVerifiedEntitlement: true,
              platforms: [
                {
                  platformId: 'epic',
                  platformGameId: appName,
                  originalTitle: title,
                  namespace: ns || undefined,
                  catalogItemId: catId,
                  installed: false,
                },
              ],
              headerImage: wideBanner,
              capsuleImage: tallCover || wideBanner,
              shortDescription: description,
              releaseDate: '',
              developers: developer ? [developer] : [],
              publishers: ['Epic Games Store'],
              genres: ['Action'],
              tags: ['Epic Games Store'],
            };

            entry = {
              id: `epic-${appName}`,
              rawTitle: title,
              platformId: 'epic',
              platformGameId: appName,
              reason,
              reasonCategory: 'non_game_filter',
              rawGame,
            };
            addSuppressedEntry(entry);
          }

          if (suppressedEpicMetaFileCache.size > 4000) {
            const firstKey = suppressedEpicMetaFileCache.keys().next().value;
            if (firstKey !== undefined) suppressedEpicMetaFileCache.delete(firstKey);
          }
          suppressedEpicMetaFileCache.set(fullMetaPath, {
            mtimeMs: st.mtimeMs,
            size: st.size,
            entry,
          });
        } catch {}
      }
    } catch {}
  }

  // 2. Scan Heroic GOG library cache (gog_library.json, mtimeMs-cached)
  const gogCacheFiles = customOptions.gogCacheFiles || [
    homeDir ? path.join(homeDir, 'Library/Application Support/heroic/store_cache/gog_library.json') : '',
    homeDir ? path.join(homeDir, '.config/heroic/store_cache/gog_library.json') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'heroic/store_cache/gog_library.json') : '',
  ].filter(Boolean);

  for (const gogFile of gogCacheFiles) {
    if (!fs.existsSync(gogFile)) continue;
    try {
      const st = fs.statSync(gogFile);
      const cachedGog = suppressedGogCacheFileCache.get(gogFile);
      if (cachedGog && cachedGog.mtimeMs === st.mtimeMs && cachedGog.size === st.size) {
        for (const ent of cachedGog.entries) {
          addSuppressedEntry(ent);
        }
        continue;
      }

      const fileEntries = [];
      const json = JSON.parse(fs.readFileSync(gogFile, 'utf-8'));
      const gamesList = Array.isArray(json?.games) ? json.games : [];
      for (const item of gamesList) {
        const appName = String(item?.app_name || '').trim();
        const title = String(item?.title || '').trim();
        if (!appName || !title) continue;
        const isDlc = Boolean(item?.install?.is_dlc);
        const reason = classifyNonGameStorefrontItem({
          title,
          platformId: 'gog',
          platformGameId: appName,
          isDlc,
        });
        if (reason) {
          const headerImg = item?.art_cover || item?.art_square || '';
          const capsuleImg = item?.art_square || item?.art_cover || '';
          const rawGame = {
            id: `gog-${appName}`,
            title,
            originalStoreTitle: title,
            sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
            isVerifiedEntitlement: true,
            platforms: [
              {
                platformId: 'gog',
                platformGameId: appName,
                originalTitle: title,
                installed: false,
              },
            ],
            headerImage: headerImg,
            capsuleImage: capsuleImg,
            shortDescription: item?.extra?.about?.description || '',
            releaseDate: '',
            developers: item?.developer ? [item.developer] : [],
            publishers: [],
            genres: Array.isArray(item?.extra?.genres) ? item.extra.genres : ['Action'],
            tags: ['GOG', 'DRM-Free'],
          };
          const ent = {
            id: `gog-${appName}`,
            rawTitle: title,
            platformId: 'gog',
            platformGameId: appName,
            reason,
            reasonCategory: 'non_game_filter',
            rawGame,
          };
          fileEntries.push(ent);
          addSuppressedEntry(ent);
        }
      }
      suppressedGogCacheFileCache.set(gogFile, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        entries: fileEntries,
      });
    } catch {}
  }

  // 3. Also check saved Steam tokens games list for any non-game entries
  try {
    const savedTokens = loadSavedTokens();
    const steamGames = Array.isArray(savedTokens?.steam?.games) ? savedTokens.steam.games : [];
    for (const g of steamGames) {
      const title = String(g?.title || '').trim();
      const appId = String(g?.steamAppId || g?.platforms?.[0]?.platformGameId || g?.id || '').replace(/^steam-/, '');
      if (!title || !appId) continue;
      const reason = classifyNonGameStorefrontItem({
        title,
        platformId: 'steam',
        platformGameId: appId,
        isDlc: false,
      });
      if (reason) {
        addSuppressedEntry({
          id: `steam-${appId}`,
          rawTitle: title,
          platformId: 'steam',
          platformGameId: appId,
          reason,
          reasonCategory: 'non_game_filter',
          rawGame: {
            ...g,
            id: `steam-${appId}`,
            originalStoreTitle: g.originalStoreTitle || title,
            isVerifiedEntitlement: true,
          },
        });
      }
    }
  } catch {}

  return Array.from(resultsMap.values());
}

function trimStoreSyncMemory() {
  fetchGogOwnedGames.lastAchievementsMap = null;
  fetchGogOwnedGames.lastSuppressedItems = null;
  fetchEpicOwnedGames.lastAchievementsMap = null;
  fetchEpicOwnedGames.lastSuppressedItems = null;
  suppressedEpicMetaFileCache.clear();
  suppressedGogCacheFileCache.clear();
  epicSchemaFileCache.clear();
  while (epicOfferMetadataCache.size > 100) {
    const oldestKey = epicOfferMetadataCache.keys().next().value;
    if (oldestKey === undefined) break;
    epicOfferMetadataCache.delete(oldestKey);
  }
  while (epicAppNamespaceCache.size > MAX_STORE_SYNC_CACHE_ENTRIES) {
    const oldestKey = epicAppNamespaceCache.keys().next().value;
    if (oldestKey === undefined) break;
    epicAppNamespaceCache.delete(oldestKey);
  }
  while (steamMatchCache.size > MAX_STORE_SYNC_CACHE_ENTRIES) {
    const oldestKey = steamMatchCache.keys().next().value;
    if (oldestKey === undefined) break;
    steamMatchCache.delete(oldestKey);
  }
}

/**
 * Retrieve per-achievement schema definitions (names, descriptions, icons, XP, global rarity)
 * for an Epic Games Store title from local Legendary metadata/*.json via non-blocking async I/O.
 */
async function getEpicGameAchievementSchema(payload = {}, options = {}) {
  const rawAppName = String(
    payload.appName || payload.platformGameId || payload.gameId || ''
  )
    .replace(/^epic[-_]/i, '')
    .trim();
  const rawNamespace = String(payload.namespace || payload.sandboxId || '').trim();
  const rawCatalogId = String(payload.catalogItemId || '').trim();
  const rawTitle = String(payload.title || '').trim();
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const normTitle = norm(rawTitle);

  const mapRawEpicAchievement = (rawItem, idx) => {
    const ach =
      rawItem?.achievement && typeof rawItem.achievement === 'object'
        ? rawItem.achievement
        : rawItem;
    const xpVal = Number(ach?.xp ?? ach?.XP ?? 0) || 0;
    const rawPct =
      typeof ach?.completed_percent === 'number'
        ? ach.completed_percent
        : typeof ach?.rarity?.percent === 'number'
          ? ach.rarity.percent
          : undefined;
    return {
      id: String(ach?.achievement_id || ach?.name || `epic_ach_${idx + 1}`),
      apiName: String(ach?.achievement_id || ach?.name || `epic_ach_${idx + 1}`),
      name: String(
        ach?.unlocked_display_name ||
          ach?.unlockedDisplayName ||
          ach?.locked_display_name ||
          ach?.lockedDisplayName ||
          ach?.achievement_id ||
          ach?.name ||
          `Achievement ${idx + 1}`
      ),
      description: String(
        ach?.unlocked_description ||
          ach?.unlockedDescription ||
          ach?.locked_description ||
          ach?.lockedDescription ||
          ach?.flavorText ||
          ''
      ),
      hidden: Boolean(ach?.hidden),
      xp: xpVal,
      tierName: ach?.tier?.name ? String(ach.tier.name) : undefined,
      globalPercentage: rawPct !== undefined ? Number(rawPct) : undefined,
      iconUnlockedUrl: ach?.unlocked_icon_url || ach?.unlockedIconLink || undefined,
      iconLockedUrl: ach?.locked_icon_url || ach?.lockedIconLink || undefined,
    };
  };

  const readParsedEpicSchemaMetaAsync = async (filePath, fallbackFileName = '') => {
    const st = await fs.promises.stat(filePath);
    const cached = epicSchemaFileCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.summary;
    }
    const rawText = await fs.promises.readFile(filePath, 'utf-8');
    const json = JSON.parse(rawText);
    if (!json || typeof json !== 'object') return null;
    const achList = json?.achievements?.achievements;
    const summary = {
      appName: String(json.app_name || fallbackFileName.replace(/\.json$/i, '')).trim(),
      namespace: String(json.namespace || json.metadata?.namespace || '').trim(),
      catalogItemId: String(
        json.catalog_item_id || json.id || json.metadata?.id || ''
      ).trim(),
      title: String(json.app_title || json.metadata?.title || '').trim(),
      mappedAchievements:
        Array.isArray(achList) && achList.length > 0
          ? achList.map(mapRawEpicAchievement)
          : [],
    };
    if (epicSchemaFileCache.size > 2000) {
      const firstKey = epicSchemaFileCache.keys().next().value;
      if (firstKey !== undefined) epicSchemaFileCache.delete(firstKey);
    }
    epicSchemaFileCache.set(filePath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      summary,
    });
    return summary;
  };

  try {
    const baseDirs = getLocalLegendaryBaseDirs(options);
    for (const baseDir of baseDirs) {
      if (!baseDir) continue;
      const metaDir = path.join(baseDir, 'metadata');
      try {
        const dirSt = await fs.promises.stat(metaDir);
        if (!dirSt.isDirectory()) continue;
      } catch {
        continue;
      }

      if (rawAppName) {
        const directFile = path.join(metaDir, `${rawAppName}.json`);
        try {
          const directSummary = await readParsedEpicSchemaMetaAsync(
            directFile,
            `${rawAppName}.json`
          );
          if (directSummary && directSummary.mappedAchievements.length > 0) {
            return directSummary.mappedAchievements;
          }
        } catch {}
      }

      let files = [];
      try {
        const dirEntries = await fs.promises.readdir(metaDir);
        files = dirEntries.filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const f of files) {
        try {
          const summary = await readParsedEpicSchemaMetaAsync(path.join(metaDir, f), f);
          if (!summary) continue;

          const isMatch =
            (rawAppName && summary.appName.toLowerCase() === rawAppName.toLowerCase()) ||
            (rawNamespace &&
              summary.namespace &&
              summary.namespace.toLowerCase() === rawNamespace.toLowerCase()) ||
            (rawCatalogId &&
              summary.catalogItemId &&
              summary.catalogItemId.toLowerCase() === rawCatalogId.toLowerCase()) ||
            (normTitle && summary.title && norm(summary.title) === normTitle);

          if (isMatch && summary.mappedAchievements.length > 0) {
            return summary.mappedAchievements;
          }
        } catch {}
      }
    }
  } catch {}

  return [];
}

module.exports = {
  atomicWriteFileSync,
  getMachineIdentityKeyMaterial,
  encryptTokensPayload,
  decryptTokensPayload,
  isMockOrCorruptedToken,
  sanitizeStorefrontTokensObject,
  getTokensFilePath,
  writeTokensFile,
  destroyScraperWindowCleanly,
  trimStoreSyncMemory,
  epicOfferMetadataCache,
  exchangeGogCode,
  renewGogTokens,
  normalizeGogAvatarUrl,
  fetchGogAccount,
  fetchGogOwnedGames,
  fetchGogAchievements,
  exchangeEpicCode,
  renewEpicTokens,
  fetchEpicOwnedGames,
  fetchEpicAchievements,
  getEpicGameAchievementSchema,
  fetchEpicProductOfferMetadata,
  resolveEpicNamespaceAndIds,
  extractEpicMacSupportFromLegendaryDirs,
  loadSavedTokens,
  saveTokens,
  clearTokens,
  fetchIgdbCover,
  computeTokenSimilarity,
  classifyNonGameStorefrontItem,
  scanLocalSuppressedStorefrontItems,
};

