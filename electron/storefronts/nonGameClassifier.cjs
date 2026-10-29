// @ts-check
'use strict';

/**
 * Classifies whether a storefront item is a non-game (beta, test branch, prologue,
 * tool/SDK/redistributable, soundtrack/artbook/bonus content, standalone multiplayer sub-client,
 * or DLC/add-on) using purely structural and generic heuristics (zero per-game hardcoding).
 * Returns a descriptive suppression reason string, or `null` if it is a standalone base game.
 *
 * @param {{
 *   title?: string,
 *   platformId?: string,
 *   platformGameId?: string,
 *   isInstalled?: boolean,
 *   installed?: boolean,
 *   isDlc?: boolean,
 *   mainGameItem?: unknown,
 *   type?: string,
 *   itemType?: string,
 *   categories?: Array<{ path?: string }>
 * }} [params]
 * @returns {string | null}
 */
function classifyNonGameStorefrontItem({
  title = '',
  platformGameId = '',
  isInstalled = false,
  installed = false,
  isDlc = false,
  mainGameItem = null,
  type = '',
  itemType = '',
  categories = [],
} = {}) {
  // Never suppress an entry the user explicitly installed locally (e.g. installed Demo/Prologue/Playtest).
  if (isInstalled === true || installed === true) {
    return null;
  }

  const cleanTitle = String(title || '').trim();
  const lower = cleanTitle.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  const platIdLower = String(platformGameId || '').toLowerCase().trim();
  const isStandaloneGameType =
    String(type || itemType || '').trim().toLowerCase() === 'game';

  // 1. Tools / Editors / Redistributables / Servers / SDKs
  if (
    platIdLower === 'gog-redist' ||
    /\b(pre-game\s+editor|resource\s+archiver|dedicated\s+server|authoring\s+tools|mod\s+kit|modkit|sdk|redistributables?|common\s+redistributables|benchmark\s+tool)\b/i.test(
      cleanTitle
    )
  ) {
    return 'Filtered: Tool / Editor / Redistributable / Server';
  }

  // 2. Soundtracks / Artbooks / Digital Goodies / Bonus & Companion Content
  if (
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

  // Uninstalled `* Multiplayer` sub-clients (e.g. `'SiN Multiplayer'`) are suppressed by default
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

  const hasParentMainGame = Boolean(
    mainGameItem && typeof mainGameItem === 'object' && Object.keys(mainGameItem).length > 0
  );

  if (
    isDlc ||
    hasParentMainGame ||
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

module.exports = {
  classifyNonGameStorefrontItem,
};
