// @ts-check
'use strict';

const KNOWN_NON_GAME_CLIENT_RE =
  /^(?:ea\s+app|ubisoft\s+connect|battle\.net|riot\s+client|gog\s+galaxy)$/i;

const NON_LAUNCHER_GAME_NOUNS = new Set([
  'rocket',
  'grenade',
  'missile',
  'bomb',
  'pumpkin',
  'catapult',
  'ball',
  'sheep',
  'cannon',
  'torpedo',
]);

const EXPLICIT_CONTENT_MODIFIERS = new Set([
  'bonus',
  'digital',
  'companion',
  'additional',
  'downloadable',
  'dlc',
  'extra',
  'extras',
  'preorder',
  'pre-order',
  'deluxe',
  'collectors',
  "collector's",
  'season',
  'pack',
  'bundle',
  'expansion',
  'cosmetic',
]);

const NATURAL_CONTENT_PREDECESSORS = new Set([
  'of',
  'to',
  'be',
  'the',
  'a',
  'an',
  'in',
  'on',
  'for',
  'with',
  'and',
  'or',
  'your',
  'my',
  'our',
  'their',
  'his',
  'her',
  'its',
  "heart's",
  'hearts',
  'no',
  'more',
  'new',
  'pure',
  'true',
  'full',
]);

const GENERIC_MULTIPLAYER_PREDECESSORS = new Set([
  'local',
  'couch',
  'online',
  'coop',
  'co-op',
  'cooperative',
  'competitive',
  'arcade',
  'casual',
  'classic',
  'retro',
  'party',
  'free',
  'vr',
  '3d',
  '2d',
  'massive',
  'massively',
  'crossplay',
  'cross-platform',
  'splitscreen',
  'split-screen',
  'tactical',
  'arena',
  'action',
  'racing',
  'sports',
  'puzzle',
  'sandbox',
  'survival',
  'open-world',
  'turn-based',
  'real-time',
  'asymmetric',
  'social',
  'mini',
  'micro',
  'mega',
  'super',
  'ultra',
  'hyper',
  'pixel',
  'voxel',
  'tabletop',
  'board',
  'card',
  'chess',
  'trivia',
  'word',
  'battle',
  'multiplayer',
  'of',
  'the',
  'a',
  'an',
  'for',
  'with',
  'and',
  'or',
  'in',
  'on',
  'to',
]);

/**
 * Splits only the trailing segment of a title into lowercase words in O(1) bounded time so
 * adversarial multi-kilobyte inputs cannot trigger super-linear scanning.
 *
 * @param {string} cleanTitle
 * @returns {string[]}
 */
function extractTailWordsLower(cleanTitle) {
  const tail = cleanTitle.length > 256 ? cleanTitle.slice(-256) : cleanTitle;
  return tail
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''))
    .filter(Boolean);
}

/**
 * Generic detector for standalone publisher/storefront launcher utilities (e.g.
 * `<Publisher/Brand> Launcher`, `<Brand> Games Launcher`, `EA App`, `Ubisoft Connect`,
 * `Battle.net`, `Riot Client`, `GOG Galaxy`) without hardcoding individual game franchise names.
 *
 * @param {string} cleanTitle
 * @returns {boolean}
 */
function isStandaloneLauncherUtilityTitle(cleanTitle) {
  if (!cleanTitle || cleanTitle.length > 96) return false;
  if (KNOWN_NON_GAME_CLIENT_RE.test(cleanTitle)) {
    return true;
  }
  if (cleanTitle.includes(':') || !/\s+launcher$/i.test(cleanTitle)) {
    return false;
  }
  const words = extractTailWordsLower(cleanTitle);
  if (words.length < 2 || words.length > 4 || words[words.length - 1] !== 'launcher') {
    return false;
  }
  const prevWord = words[words.length - 2];
  if (NON_LAUNCHER_GAME_NOUNS.has(prevWord)) {
    return false;
  }
  return true;
}

/**
 * Tightened detector for trailing `<Game Title> Content` companion/sub-package entries that avoids
 * false-flagging natural English phrases like `"Heart's Content"` or `"Be Content"`.
 *
 * @param {string} cleanTitle
 * @returns {boolean}
 */
function isTrailingCompanionContentTitle(cleanTitle) {
  if (!cleanTitle || !/\s+content$/i.test(cleanTitle)) {
    return false;
  }
  const words = extractTailWordsLower(cleanTitle);
  if (words.length < 2 || words[words.length - 1] !== 'content') {
    return false;
  }
  const prevWord = words[words.length - 2];
  if (EXPLICIT_CONTENT_MODIFIERS.has(prevWord)) {
    return true;
  }
  if (NATURAL_CONTENT_PREDECESSORS.has(prevWord)) {
    return false;
  }
  // Require a multi-word franchise prefix (`>= 3` total words, e.g. `Death Stranding Content`,
  // `LEGO Fortnite Content`) so short 2-word game titles aren't false-flagged.
  return words.length >= 3;
}

/**
 * Tightened detector for uninstalled `<Base Game> Multiplayer` sub-client entries that avoids
 * false-flagging standalone multiplayer games (e.g. `"Couch Multiplayer"`, `"Survival Multiplayer"`,
 * `"Ultimate Arena Multiplayer"`).
 *
 * @param {string} cleanTitle
 * @returns {boolean}
 */
function isTrailingMultiplayerSubClientTitle(cleanTitle) {
  if (!cleanTitle) return false;
  const tail = cleanTitle.length > 256 ? cleanTitle.slice(-256) : cleanTitle;
  if (/[:\-–—]\s*multiplayer$/i.test(tail) || /\(\s*multiplayer\s*\)$/i.test(tail)) {
    return true;
  }
  if (!/\s+multiplayer$/i.test(tail)) {
    return false;
  }
  const words = extractTailWordsLower(tail);
  if (words.length < 3 || words[words.length - 1] !== 'multiplayer') {
    return false;
  }
  const prevWord = words[words.length - 2];
  if (GENERIC_MULTIPLAYER_PREDECESSORS.has(prevWord)) {
    return false;
  }
  return true;
}

/**
 * Classifies whether a storefront item is a non-game (beta, test branch, prologue,
 * tool/SDK/redistributable, soundtrack/artbook/bonus content, standalone multiplayer sub-client,
 * or DLC/add-on) using purely structural and generic heuristics (zero per-game hardcoding).
 * Returns a descriptive suppression reason string, or `null` if it is a standalone base game.
 *
 * @param {{
 *   store?: string,
 *   title?: string,
 *   platformId?: string,
 *   platformGameId?: string,
 *   catalogItemId?: string,
 *   namespace?: string,
 *   sandboxType?: string,
 *   isInstalled?: boolean,
 *   installed?: boolean,
 *   isDlc?: boolean,
 *   mainGameItem?: unknown,
 *   type?: string,
 *   itemType?: string,
 *   productType?: string,
 *   productKind?: string,
 *   categories?: Array<{ path?: string } | string>
 * }} [params]
 * @returns {string | null}
 */
function classifyNonGameStorefrontItem({
  store = '',
  title = '',
  platformId = '',
  platformGameId = '',
  catalogItemId = '',
  namespace = '',
  sandboxType = '',
  isInstalled = false,
  installed = false,
  isDlc = false,
  mainGameItem = null,
  type = '',
  itemType = '',
  productType = '',
  productKind = '',
  categories = [],
} = {}) {
  // Never suppress an entry the user explicitly installed locally (e.g. installed Demo/Prologue/Playtest).
  if (isInstalled === true || installed === true) {
    return null;
  }

  if (String(sandboxType || '').trim().toUpperCase() === 'PRIVATE') {
    return 'Filtered: Beta / Test Branch / Legacy Client';
  }
  if (String(namespace || '').trim().toLowerCase() === 'ue') {
    return 'Filtered: Tool / Editor / Redistributable / Server';
  }

  const cleanTitle = String(title || '').trim();
  const lower = cleanTitle.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  const platIdLower = String(platformGameId || '').toLowerCase().trim();
  const storeLower = String(store || platformId || '').toLowerCase().trim();
  const rawType = String(type || itemType || productType || productKind || '').trim();
  const normType = rawType.toLowerCase();
  const typeUpper = rawType.toUpperCase();
  const isStandaloneGameType = normType === 'game' || normType === 'base_game';

  const categorySegments = new Set();
  if (Array.isArray(categories)) {
    for (const c of categories) {
      const rawPath = String(typeof c === 'string' ? c : c?.path || '').toLowerCase();
      for (const seg of rawPath.split('/')) {
        const trimmedSeg = seg.trim();
        if (trimmedSeg) {
          categorySegments.add(trimmedSeg);
        }
      }
    }
  }
  const hasGamesCategorySegment = categorySegments.has('games');
  const hasBaseGameIndicators = hasGamesCategorySegment || isStandaloneGameType;

  // 1. Tools / Editors / Redistributables / Servers / SDKs / Standalone Storefront Launcher Utilities
  // Note: If an item possesses `hasGamesCategorySegment: true` (e.g. `{ path: 'games' }`), 'APPLICATION' is a
  // game packaging format (used by Epic Games Store) and MUST NOT trigger tool/editor filtering.
  const isToolType =
    ['ENGINE', 'EDITOR', 'LEARNING', 'TOOL', 'CONFIG'].includes(typeUpper) ||
    (!hasGamesCategorySegment && typeUpper === 'APPLICATION');

  if (
    platIdLower === 'gog-redist' ||
    isToolType ||
    ['engines', 'editors', 'plugins', 'codeplugins', 'projects', 'assets'].some((seg) =>
      categorySegments.has(seg)
    ) ||
    /\b(pre-game\s+editor|resource\s+archiver|dedicated\s+server|authoring\s+tools|mod\s+kit|modkit|sdk|redistributables?|common\s+redistributables|benchmark\s+tool)\b/i.test(
      cleanTitle
    ) ||
    isStandaloneLauncherUtilityTitle(cleanTitle)
  ) {
    return 'Filtered: Tool / Editor / Redistributable / Server';
  }

  // 2. Soundtracks / Artbooks / Digital Goodies / Bonus & Companion Content
  if (
    ['MUSIC', 'VIDEO', 'SERIES'].includes(typeUpper) ||
    categorySegments.has('soundtrack') ||
    categorySegments.has('digitalextras') ||
    /\b(digital\s+soundtrack|original\s+soundtrack|official\s+soundtrack|soundtrack|ost|art\s*book|artbook|digital\s+goodies|goodies\s+pack|wallpaper|hd\s+wallpaper|hd\s+sound|hd\s+texture|voice\s+pack|bonus\s+content|digital\s+extras?|companion\s+content|additional\s+content)\b/i.test(
      cleanTitle
    ) ||
    isTrailingCompanionContentTitle(cleanTitle)
  ) {
    return 'Filtered: Digital Soundtrack / Artbook / Bonus Content';
  }

  // 3. Betas / Test Branches / Legacy Clients / Unclassified Multiplayer Sub-Clients
  if (
    /\b(beta|public\s+test|public\s+testing|tech\s+beta|closed\s+beta|open\s+beta|test\s+branch|test\s+server|legacy\s+mode|experimental\s+branch|playtest|stress\s+test|staging|technical\s+test)\b/i.test(
      cleanTitle
    ) ||
    /(?:tech|closed|open)?beta$/i.test(compact)
  ) {
    return 'Filtered: Beta / Test Branch / Legacy Client';
  }

  // Uninstalled `* Multiplayer` sub-clients (e.g. `'<Title> Multiplayer'`) are suppressed by default
  // while installed `* Multiplayer` entries remain visible via the `isInstalled || installed` check above.
  if (
    /\b(multiplayer\s+only|dedicated\s+multiplayer|standalone\s+multiplayer|multiplayer\s+client|multiplayer\s+pack|multiplayer\s+component|multiplayer\s+module)\b/i.test(
      cleanTitle
    ) ||
    isTrailingMultiplayerSubClientTitle(cleanTitle)
  ) {
    return 'Filtered: Beta / Test Branch / Legacy Client';
  }

  // 4. Prologues / Playable Teasers / Demos / Alphas / Trials
  if (
    typeUpper === 'DEMO' ||
    /\b(prologue|playable\s+teaser|demo|free\s+trial|trial\s+version|alpha\s+version|teaser)\b/i.test(
      cleanTitle
    )
  ) {
    return 'Filtered: Prologue / Playable Teaser / Demo / Alpha';
  }

  // 5. Explicit DLC / Add-On / Expansion / Audience / Pack flags or `/`-delimited category segments
  const catHasHardDlc = ['addons', 'add-on', 'addon', 'dlc', 'consumable', 'audience'].some((seg) =>
    categorySegments.has(seg)
  );
  const catHasSoftModOrVault =
    !hasGamesCategorySegment && (categorySegments.has('mods') || categorySegments.has('vault'));
  const catHasDlc = catHasHardDlc || catHasSoftModOrVault;

  // In Microsoft Store / Xbox catalog, ProductKind: "Durable" represents add-on DLCs.
  // In Epic Games Store, itemType: "DURABLE" represents a permanent license for all base games and DLCs alike.
  // Therefore, 'DURABLE' only triggers DLC filtering if store === 'xbox' or if hasGamesCategorySegment is false AND it lacks base game indicators.
  const isDlcType =
    [
      'ADD_ON',
      'ADDON',
      'ADD-ON',
      'DLC',
      'CONSUMABLE',
      'WALLET',
      'SUBSCRIPTION',
      'PLUGIN',
      'EXTRA',
      'CURRENCY',
      'OTHERS',
      'INVALID',
    ].includes(typeUpper) ||
    (typeUpper === 'DURABLE' && (storeLower === 'xbox' || !hasBaseGameIndicators));

  const cleanCatalogId = String(catalogItemId || '').trim();
  const mainGameObj =
    mainGameItem && typeof mainGameItem === 'object'
      ? /** @type {Record<string, unknown>} */ (mainGameItem)
      : null;
  const mainGameTargetId =
    mainGameObj && typeof mainGameObj.id === 'string' ? mainGameObj.id.trim() : '';
  const hasParentMainGame = Boolean(
    mainGameObj &&
      Object.keys(mainGameObj).length > 0 &&
      (!cleanCatalogId || !mainGameTargetId || mainGameTargetId !== cleanCatalogId)
  );

  if (
    isDlc ||
    hasParentMainGame ||
    catHasDlc ||
    isDlcType ||
    /\b(dlc|season\s+pass|expansion\s+pass|add-on|addon|upgrade\s+pack|supporter\s+pack|cosmetic\s+pack|weapon\s+pack|skin\s+pack)\b/i.test(
      cleanTitle
    )
  ) {
    return 'Filtered: DLC / Add-On / Expansion Content';
  }

  if (
    /\bstarter\s+pack\b/i.test(cleanTitle) &&
    !(isStandaloneGameType === true && !isDlc && !hasParentMainGame && !catHasDlc && !isDlcType)
  ) {
    return 'Filtered: DLC / Add-On / Expansion Content';
  }

  return null;
}

module.exports = {
  classifyNonGameStorefrontItem,
};
