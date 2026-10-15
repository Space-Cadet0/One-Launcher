const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const GOG_CLIENT_ID = '46899977096215655';
const GOG_CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const GOG_REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';

const EPIC_CLIENT_AUTH = 'MzRhMDJjZjhmNDQxNGUyOWIxNTkyMTg3NmRhMzZmOWE6ZGFhZmJjY2M3Mzc3NDUwMzlkZmZlNTNkOTRmYzc2Y2Y=';

function getTokensFilePath() {
  try {
    const defaultDir = path.join(process.env.HOME || '.', '.one-launcher');
    const legacyDir = path.join(process.env.HOME || '.', '.universal-game-library');
    const userDataPath = app ? app.getPath('userData') : (fs.existsSync(legacyDir) && !fs.existsSync(defaultDir) ? legacyDir : defaultDir);
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }
    return path.join(userDataPath, 'tokens.json');
  } catch {
    return path.join(process.cwd(), 'tokens.json');
  }
}

function isSafeStorageAvailable() {
  try {
    return Boolean(
      typeof safeStorage !== 'undefined' &&
      safeStorage &&
      typeof safeStorage.isEncryptionAvailable === 'function' &&
      safeStorage.isEncryptionAvailable()
    );
  } catch {
    return false;
  }
}

function writeTokensFile(tokens) {
  const filePath = getTokensFilePath();
  const jsonStr = JSON.stringify(tokens, null, 2);

  if (isSafeStorageAvailable()) {
    try {
      const encryptedBuffer = safeStorage.encryptString(jsonStr);
      const encryptedPayload = {
        _encrypted: true,
        data: encryptedBuffer.toString('base64'),
      };
      fs.writeFileSync(filePath, JSON.stringify(encryptedPayload, null, 2), 'utf-8');
      return;
    } catch (encErr) {
      console.warn('Failed to encrypt tokens with safeStorage, falling back to plaintext:', encErr.message);
    }
  }

  // Graceful fallback if safeStorage is not available or encryption failed
  fs.writeFileSync(filePath, jsonStr, 'utf-8');
}

function loadSavedTokens() {
  try {
    const filePath = getTokensFilePath();
    if (!fs.existsSync(filePath)) {
      return {};
    }

    const rawContent = fs.readFileSync(filePath);
    if (!rawContent || rawContent.length === 0) {
      return {};
    }

    // Try parsing as JSON first
    let parsed;
    try {
      parsed = JSON.parse(rawContent.toString('utf-8'));
    } catch {
      // If not JSON, it might be a raw binary buffer encrypted by safeStorage
      if (isSafeStorageAvailable()) {
        try {
          const decrypted = safeStorage.decryptString(rawContent);
          return JSON.parse(decrypted);
        } catch (rawDecErr) {
          console.warn('Failed to decrypt raw binary tokens buffer:', rawDecErr.message);
        }
      }
      return {};
    }

    // Handle encrypted payload format: { _encrypted: true, data: "base64..." }
    if (parsed && parsed._encrypted === true && typeof parsed.data === 'string') {
      if (isSafeStorageAvailable()) {
        try {
          const buffer = Buffer.from(parsed.data, 'base64');
          const decrypted = safeStorage.decryptString(buffer);
          return JSON.parse(decrypted);
        } catch (decErr) {
          console.warn('Failed to decrypt tokens payload with safeStorage:', decErr.message);
          return {};
        }
      } else {
        console.warn('safeStorage is not available to decrypt tokens; unable to read encrypted tokens.');
        return {};
      }
    }

    // Handle per-token encrypted format if present: { gog: { _encrypted: true, data: "..." } }
    if (parsed && typeof parsed === 'object') {
      let containsPerTokenEncryption = false;
      const decryptedTokens = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value === 'object' && value._encrypted === true && typeof value.data === 'string') {
          containsPerTokenEncryption = true;
          if (isSafeStorageAvailable()) {
            try {
              const buffer = Buffer.from(value.data, 'base64');
              const decrypted = safeStorage.decryptString(buffer);
              decryptedTokens[key] = JSON.parse(decrypted);
            } catch (err) {
              console.warn(`Failed to decrypt token for ${key}:`, err.message);
            }
          }
        } else {
          decryptedTokens[key] = value;
        }
      }
      if (containsPerTokenEncryption) {
        return decryptedTokens;
      }

      // Legacy plaintext JSON backward compatibility:
      // Return parsed plaintext directly. Next time saveTokens is called,
      // it will be migrated to the encrypted format via writeTokensFile.
      return parsed;
    }

    return {};
  } catch (err) {
    console.warn('Failed to load saved tokens:', err.message);
    return {};
  }
}

function saveTokens(storefrontId, tokenData) {
  try {
    const existing = loadSavedTokens();
    existing[storefrontId] = {
      ...tokenData,
      updatedAt: new Date().toISOString(),
    };
    writeTokensFile(existing);
  } catch (err) {
    console.warn('Failed to save tokens:', err.message);
  }
}

function clearTokens(storefrontId) {
  try {
    const existing = loadSavedTokens();
    if (existing[storefrontId]) {
      delete existing[storefrontId];
      writeTokensFile(existing);
    }
  } catch (err) {
    console.warn('Failed to clear tokens:', err.message);
  }
}

const KNOWN_STEAM_MAPPINGS = {};

const KNOWN_EPIC_APP_NAMES = {};

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

const steamMatchCache = new Map();

/**
 * Intelligent Steam App ID matcher for titles across all storefronts
 */
async function matchSteamAppId(rawTitle) {
  if (!rawTitle) return undefined;
  const clean = rawTitle.trim();
  const lower = clean.toLowerCase();

  if (steamMatchCache.has(lower)) {
    return steamMatchCache.get(lower);
  }

  // 1. Curated dictionary check
  if (KNOWN_STEAM_MAPPINGS[lower]) {
    const id = KNOWN_STEAM_MAPPINGS[lower];
    steamMatchCache.set(lower, id);
    return id;
  }

  // 2. Normalized title check
  const normalized = lower
    .replace(/[™®©]/g, '')
    .replace(/ - (digital deluxe|deluxe|enhanced|game of the year|goty|definitive|director's cut|complete|remastered|drm-free|standard) edition/i, '')
    .replace(/ \((digital deluxe|deluxe|enhanced|game of the year|goty|definitive|director's cut|complete|remastered|drm-free|standard) edition\)/i, '')
    .trim();

  if (KNOWN_STEAM_MAPPINGS[normalized]) {
    const id = KNOWN_STEAM_MAPPINGS[normalized];
    steamMatchCache.set(lower, id);
    return id;
  }

  steamMatchCache.set(lower, undefined);
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
    return {
      username: 'GOG User',
      avatarUrl: undefined,
    };
  }

  const data = await res.json();
  return {
    username: data.username || 'GOG User',
    userId: data.userId,
    avatarUrl: data.avatar || undefined,
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

        const steamAppId = await matchSteamAppId(title);

        const enrichedEntry = gogEnriched[strId];
        const verticalGogCover = enrichedEntry?.coverVertical || null;

        const hasSteamVertical = Boolean(steamAppId);

        const headerImg = steamAppId
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/header.jpg`
          : coverUrl;

        const capsuleImg = hasSteamVertical
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/library_600x900_2x.jpg`
          : (verticalGogCover || '');

        games.push({
          id: steamAppId ? `steam-${steamAppId}` : `gog-${p.id}`,
          title,
          sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
          steamAppId,
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'gog',
              platformGameId: strId,
              installed: false,
              playtimeMinutes: stats.playtime || 0,
              lastPlayed: stats.lastSession || undefined,
              achievements: gameAch || undefined,
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

let EPIC_BASE_GAMES = [];
try {
  EPIC_BASE_GAMES = require('./epicBaseGames.json');
} catch (e) {
  // Ignore if not present
}

/**
 * Fetch Epic Games Player Achievements from official launcher GraphQL service
 */
async function fetchEpicAchievements(accessToken, accountId) {
  if (!accountId) return {};
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

    const res = await fetch('https://launcher.store.epicgames.com/graphql', {
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
      return {};
    }

    const json = await res.json();
    const dataList = json?.data?.PlayerProfile?.playerProfile?.achievementsSummaries?.data || [];
    const achievementsMap = {};

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
        syncedAt: new Date().toISOString(),
      };

      if (item.sandboxId) achievementsMap[item.sandboxId.toLowerCase()] = summary;
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
    return {};
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

  // 2. Fetch live achievements from Epic launcher GraphQL
  let achievementsMap = {};
  if (accountId) {
    achievementsMap = await fetchEpicAchievements(accessToken, accountId);
  }
  fetchEpicOwnedGames.lastAchievementsMap = achievementsMap;

  // 3. Initialize with authoritative base games catalog if available
  const gamesMap = new Map();
  const knownAppIds = new Set();
  const knownTitles = new Set();

  if (EPIC_BASE_GAMES && EPIC_BASE_GAMES.length > 0) {
    for (const baseGame of EPIC_BASE_GAMES) {
      const epicPlat = baseGame.platforms.find((p) => p.platformId === 'epic');
      const gameId = epicPlat?.platformGameId;
      const pt = (gameId ? (playtimeMap.get(gameId) || playtimeMap.get(gameId.toLowerCase())) : null) || {};

      const titleLower = baseGame.title.toLowerCase().trim();
      const normTitle = baseGame.title.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
      const gameAch =
        achievementsMap[titleLower] ||
        achievementsMap[normTitle] ||
        (gameId ? achievementsMap[gameId.toLowerCase()] : null) ||
        achievementsMap[baseGame.id.toLowerCase()];

      const gameObj = {
        ...baseGame,
        isVerifiedEntitlement: true,
        platforms: baseGame.platforms.map((p) =>
          p.platformId === 'epic'
            ? {
                ...p,
                playtimeMinutes: pt.totalTime !== undefined ? pt.totalTime : p.playtimeMinutes,
                lastPlayed: pt.lastPlayed || p.lastPlayed,
                achievements: gameAch || p.achievements,
              }
            : p
        ),
      };

      gamesMap.set(gameObj.id, gameObj);
      knownTitles.add(titleLower);
      knownTitles.add(normTitle);
      if (gameId) {
        knownAppIds.add(gameId.toLowerCase());
      }
    }
  }

  // 4. Fetch live items from Library Service with cursor pagination
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
      const hasRealMainGame = Boolean(
        (item.metadata?.mainGameItem && (item.metadata.mainGameItem.id || item.metadata.mainGameItem.namespace)) ||
        (item.mainGameItem && (item.mainGameItem.id || item.mainGameItem.namespace))
      );
      if (hasRealMainGame) continue;

      const itemType = (item.metadata?.itemType || '').toUpperCase();
      if (['ADD_ON', 'DLC', 'CONSUMABLE', 'WALLET', 'SUBSCRIPTION', 'PLUGIN', 'EXTRA', 'CURRENCY'].includes(itemType)) {
        continue;
      }

      const categories = item.metadata?.categories || [];
      const isAddonCategory = categories.some((c) =>
        ['addons', 'dlc', 'mods', 'digitalextras', 'consumable', 'vault'].some((sub) =>
          (c.path || '').toLowerCase().includes(sub)
        )
      );
      if (isAddonCategory) continue;
      if (item.appName?.startsWith('Fortnite_')) continue;

      const appNameLower = (item.appName || '').toLowerCase().trim();
      const catalogIdLower = (item.catalogItemId || '').toLowerCase().trim();
      if (knownAppIds.has(appNameLower) || knownAppIds.has(catalogIdLower)) continue;

      filteredItems.push(item);
    }

    const BATCH_SIZE = 15;
    for (let i = 0; i < filteredItems.length; i += BATCH_SIZE) {
      const batch = filteredItems.slice(i, i + BATCH_SIZE);
      const resolvedBatch = await Promise.all(
        batch.map(async (item) => {
          const appNameLower = (item.appName || '').toLowerCase().trim();
          const catalogIdLower = (item.catalogItemId || '').toLowerCase().trim();
          let rawTitle = (item.metadata?.title || '').trim();
          const titleLower = (rawTitle || item.sandboxName || '').toLowerCase().trim();

          const codename =
            KNOWN_EPIC_APP_NAMES[appNameLower] ||
            KNOWN_EPIC_APP_NAMES[catalogIdLower] ||
            KNOWN_EPIC_APP_NAMES[titleLower];

          let title = codename ? codename.title : rawTitle;
          let description = item.metadata?.description || '';
          let developer = item.metadata?.developer || '';
          let keyImages = item.metadata?.keyImages || [];

          if (!item.metadata?.title || title === 'Live' || !title || /^[0-9a-f]{20,}$/i.test(title)) {
            let resolvedFromCatalog = false;
            try {
              const catUrl = `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${item.namespace}/bulk/items?id=${item.catalogItemId}&includeDLCDetails=true&includeMainGameDetails=true`;
              const cRes = await fetch(catUrl, {
                headers: {
                  Authorization: `bearer ${accessToken}`,
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
                },
              });
              if (cRes.ok) {
                const cData = await cRes.json();
                const meta = cData[item.catalogItemId];
                if (meta) {
                  const isDlc = meta.categories?.some((c) => ['addons', 'dlc'].includes(c.path)) || Boolean(meta.mainGameItem);
                  if (isDlc) return null;
                  if (meta.title) {
                    title = meta.title;
                    resolvedFromCatalog = true;
                  }
                  description = meta.description || description;
                  developer = meta.developer || developer;
                  keyImages = meta.keyImages || keyImages;
                }
              }
            } catch {}
            if (!resolvedFromCatalog && !codename && !item.metadata?.title) {
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
            .replace(/\[\/?[a-z0-9_*=\s"'-]+\]/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (
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

          return {
            item,
            appNameLower,
            catalogIdLower,
            namespaceLower: (item.namespace || '').toLowerCase().trim(),
            codename,
            title,
            description: cleanDesc,
            developer,
            keyImages,
          };
        })
      );

      for (const entry of resolvedBatch) {
        if (!entry) continue;
        const { item, appNameLower, catalogIdLower, namespaceLower, codename, title, description, developer, keyImages } = entry;
        const lower = title.toLowerCase().trim();
        if (knownAppIds.has(appNameLower)) continue;

        const tallCover = keyImages.find((img) => img.type === 'DieselGameBoxTall')?.url;
        const wideBanner = keyImages.find((img) => img.type === 'DieselGameBox')?.url || tallCover;
        const pt = playtimeMap.get(item.appName) || playtimeMap.get(item.catalogItemId) || {};
        const steamAppId = (codename && codename.steamAppId) ? codename.steamAppId : await matchSteamAppId(title);

        const headerImg = steamAppId
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/header.jpg`
          : (codename && codename.headerImage) || wideBanner || 'https://cdn2.unrealengine.com/egs-badge.png';

        const capsuleImg = steamAppId
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/library_600x900_2x.jpg`
          : (codename && codename.capsuleImage) || tallCover || wideBanner || 'https://cdn2.unrealengine.com/egs-badge.png';

        const finalDev = (codename && codename.developer) ? codename.developer : developer;
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
              installed: false,
              playtimeMinutes: pt.totalTime || 0,
              lastPlayed: pt.lastPlayed || undefined,
              achievements: gameAch || undefined,
            },
          ],
          headerImage: headerImg,
          capsuleImage: capsuleImg,
          shortDescription: description || '',
          releaseDate: item.metadata?.releaseDate ? String(item.metadata.releaseDate).split('T')[0] : '',
          developers: finalDev ? [finalDev] : [],
          publishers: item.metadata?.publisher ? [item.metadata.publisher] : ['Epic Games Store'],
          genres: ['Action'],
          tags: ['Epic Games Store'],
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

module.exports = {
  exchangeGogCode,
  renewGogTokens,
  fetchGogAccount,
  fetchGogOwnedGames,
  fetchGogAchievements,
  exchangeEpicCode,
  renewEpicTokens,
  fetchEpicOwnedGames,
  fetchEpicAchievements,
  loadSavedTokens,
  saveTokens,
  clearTokens,
  fetchIgdbCover,
  computeTokenSimilarity,
};

