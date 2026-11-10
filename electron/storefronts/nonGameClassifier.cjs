// @ts-check
'use strict';

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
  title = '',
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

  // 1. Tools / Editors / Redistributables / Servers / SDKs / Standalone Storefront Launcher Utilities
  // Note: NEVER match `'applications'` — Epic attaches `{ path: 'applications' }` to base games!
  if (
    platIdLower === 'gog-redist' ||
    ['ENGINE', 'EDITOR', 'LEARNING', 'TOOL', 'APPLICATION', 'CONFIG'].includes(typeUpper) ||
    ['engines', 'editors', 'plugins', 'codeplugins', 'projects', 'assets'].some((seg) =>
      categorySegments.has(seg)
    ) ||
    /\b(pre-game\s+editor|resource\s+archiver|dedicated\s+server|authoring\s+tools|mod\s+kit|modkit|sdk|redistributables?|common\s+redistributables|benchmark\s+tool)\b/i.test(
      cleanTitle
    ) ||
    /^(?:minecraft\s+launcher|ea\s+app|ubisoft\s+connect|rockstar\s+games\s+launcher|battle\.net|riot\s+client|gog\s+galaxy|epic\s+games\s+launcher)$/i.test(
      cleanTitle
    )
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
    /\b\w+\s+content$/i.test(cleanTitle)
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
    /\b(multiplayer\s+only|dedicated\s+multiplayer|standalone\s+multiplayer|multiplayer\s+client)\b/i.test(
      cleanTitle
    ) ||
    /\S+\s+multiplayer$/i.test(cleanTitle)
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

  const isDlcType = [
    'ADD_ON',
    'ADDON',
    'ADD-ON',
    'DLC',
    'DURABLE',
    'CONSUMABLE',
    'WALLET',
    'SUBSCRIPTION',
    'PLUGIN',
    'EXTRA',
    'CURRENCY',
    'ENTITLEMENT',
    'OTHERS',
    'INVALID',
  ].includes(typeUpper);

  const cleanCatalogId = String(catalogItemId || '').trim();
  const mainGameObj =
    mainGameItem && typeof mainGameItem === 'object'
      ? /** @type {Record<string, unknown>} */ (mainGameItem)
      : null;
  const mainGameTargetId = mainGameObj && typeof mainGameObj.id === 'string' ? mainGameObj.id.trim() : '';
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
