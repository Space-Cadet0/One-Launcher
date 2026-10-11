import { CanonicalGame } from '../../contracts/game';
import { KNOWN_EPIC_APP_NAMES } from './epicCodenames';
import { GOG_USER_LIBRARY } from '../storage/gogUserLibrary';
import { EPIC_USER_LIBRARY } from '../storage/epicUserLibrary';
import { FULL_USER_STEAM_GAMES } from '../storage/fullUserSteamGames';
import { igdbCoverService, isKnownDeadSteamCover, isUnsuitableCoverUrl } from '../igdb/igdbCoverService';

/**
 * Checks if a string is a 20+ hex hash or UUID
 */
export function isHexOrGuidString(str: string): boolean {
  if (!str) return false;
  const trimmed = str.trim();
  // 24+ character hexadecimal hash (e.g. c5109bdceb3a453bb38c2fdc964ddee8)
  if (/^[0-9a-f]{20,}$/i.test(trimmed)) return true;
  // Standard UUID format
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return true;
  return false;
}

export function isPlaceholderDesc(desc?: string, title?: string): boolean {
  if (!desc) return true;
  const trimmed = desc.trim();
  if (trimmed.length <= 3) return true;
  const lower = trimmed.toLowerCase();
  if (title && lower === title.trim().toLowerCase()) return true;
  if (lower.includes('on gog.com')) return true;
  if (lower.includes('drm-free')) return true;
  if (lower.includes('epic games store')) return true;
  if (/^[a-z\s-]+ on gog\.com/i.test(trimmed)) return true;
  return false;
}

/**
 * Detects whether an item is a non-game item (Fortnite microtransactions, DLC packs, add-on assets)
 */
export function isEpicNonGameEntry(game: CanonicalGame): boolean {
  const title = (game.title || '').trim().toLowerCase();
  const id = (game.id || '').toLowerCase();

  // Pure hex or UUID titles
  if (isHexOrGuidString(game.title)) {
    if (id.includes('c5109bdceb3a453bb38c2fdc964ddee8')) {
      return false;
    }
    return true;
  }

  // Fortnite DLC, microtransactions, battle passes, cosmetics
  if (title.includes('fortnite')) {
    const isFortniteDlc =
      title.includes('pack') ||
      title.includes('bundle') ||
      title.includes('v-bucks') ||
      title.includes('vbucks') ||
      title.includes('skin') ||
      title.includes('battle pass') ||
      title.includes('outfit') ||
      title.includes('chapter') ||
      title.includes('season') ||
      title.includes('starter') ||
      title.includes('crew') ||
      title.includes('drop') ||
      title.includes('quest') ||
      title.includes('emotes');

    // Only allow the base game "Fortnite"
    if (isFortniteDlc && title !== 'fortnite') {
      return true;
    }
  }

  // Unreal Engine Marketplace assets & plugins
  if (
    title.includes('starter content') ||
    title.includes('unreal engine') ||
    title.includes('megascans') ||
    id.includes('ue-') ||
    id.includes('unreal')
  ) {
    return true;
  }

  // Standalone DLC tags or descriptions that slipped in as separate games
  const hasDlcOnlyTag = game.tags?.some((t) => t.toLowerCase() === 'dlc' || t.toLowerCase() === 'add-on');
  const isSoundtrackOrArtbook =
    title.endsWith(' soundtrack') ||
    title.endsWith(' ost') ||
    title.endsWith(' artbook') ||
    title.includes(' - soundtrack') ||
    title.includes(' bonus content');

  if (hasDlcOnlyTag && isSoundtrackOrArtbook) {
    return true;
  }

  return false;
}

/**
 * Normalizes title for robust cross-storefront game deduplication
 */
export function normalizeCanonicalTitle(title: string): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/\s*\((?:19|20)\d{2}\)/g, '')
    .replace(/\biii\b/g, '3')
    .replace(/\bii\b/g, '2')
    .replace(/\biv\b/g, '4')
    .replace(/[:\-–—]/g, ' ')
    .replace(/\s+(complete|definitive|enhanced|game of the year|goty|remastered|deluxe|gold|standard)\s+edition/g, '')
    .replace(/\s+edition$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const validGogProductIds = new Set<string>();
const validGogTitles = new Set<string>();
for (const g of GOG_USER_LIBRARY) {
  validGogTitles.add(normalizeCanonicalTitle(g.title));
  for (const p of g.platforms) {
    if (p.platformId === 'gog' && p.platformGameId) {
      validGogProductIds.add(p.platformGameId.trim());
    }
  }
}

const validEpicBaseGameByCatalogId = new Map<string, CanonicalGame>();
const validEpicCatalogIds = new Set<string>();
const validEpicTitles = new Set<string>();
const validEpicSteamAppIds = new Set<number>();
for (const g of EPIC_USER_LIBRARY) {
  validEpicTitles.add(normalizeCanonicalTitle(g.title));
  if (g.steamAppId) validEpicSteamAppIds.add(g.steamAppId);
  for (const p of g.platforms) {
    if (p.platformId === 'epic' && p.platformGameId) {
      const cleanId = p.platformGameId.trim().toLowerCase();
      validEpicCatalogIds.add(cleanId);
      validEpicBaseGameByCatalogId.set(cleanId, g);
    }
  }
}

const validSteamAppIds = new Set<number>();
const validSteamTitles = new Set<string>();
for (const g of FULL_USER_STEAM_GAMES) {
  if (g.steamAppId) validSteamAppIds.add(g.steamAppId);
  validSteamTitles.add(normalizeCanonicalTitle(g.title));
}

/**
 * Blacklist of unowned promotional artwork, free trials, and EA Play marketing AppIDs
 * that bleed into local Steam client librarycache but are not owned entitlements.
 */
export const UNOWNED_STEAM_PROMO_APP_IDS = new Set<number>([
  1222680, // Need for Speed™ Heat
  1222700, // A Way Out
  1385510, // Back 4 Blood Beta
  1238820, // Battlefield 3™
  1238860, // Battlefield 4™
  1238840, // Battlefield™ 1
  1238880, // Battlefield™ Hardline
  368900,  // Brilliant Bob
  2398450, // Classic Marathon
  1213210, // Command & Conquer™ Remastered Collection
  17300,   // Crysis (2007)
  108800,  // Crysis 2 Maximum Edition
  1282690, // Crysis® 3
  17470,   // Dead Space (2008)
  47780,   // Dead Space 2
  1238060, // Dead Space™ 3
  1872550, // Destroy All Humans! – Clone Carnage
  570,     // Dota 2
  1238040, // Dragon Age II: Ultimate Edition
  47810,   // Dragon Age: Origins - Ultimate Edition
  1222690, // Dragon Age™ Inquisition
  1225580, // Fe
  397620,  // GooCubelets
  2477290, // Half-Life 2 RTX
  7110,    // Jade Empire: Special Edition
  17460,   // Mass Effect (2007)
  24980,   // Mass Effect 2 (2010)
  2362420, // Mass Effect 2 (2010) Edition
  1238020, // Mass Effect 3 (2012)
  1238000, // Mass Effect™: Andromeda
  17410,   // Mirror's Edge (2008)
  1233570, // Mirror's Edge™ Catalyst
  2215490, // Project Borealis: Prologue
  1225590, // Sea of Solitude
  480,     // Spacewar
  17390,   // Spore
  1172380, // STAR WARS Jedi: Fallen Order™
  1237980, // STAR WARS™ Battlefront™
  440,     // Team Fortress 2
  298180,  // The Desolate Hope
  1237970, // Titanfall® 2
  1454890, // Titanfall™
  1225560, // Unravel
  1225570, // Unravel Two
  331710,  // Why So Evil
  354850,  // Why So Evil 2: Dystopia
]);

/**
 * Sanitizes the catalog:
 * 1. Renames known Epic codenames (Boga, Blobfish, Barbet, Basil, Batfish, etc.) to their official game titles and covers
 * 2. Corrects the false match where "Path of the Bogatyr" was assigned to Epic's "Boga" (Death Stranding)
 * 3. Purges raw GUIDs, Fortnite microtransaction items, invalid DLC entries, and unmapped codenames
 * 4. Deduplicates games by normalized title and Steam App ID, merging multi-storefront ownership cleanly
 */
export function sanitizeGameCatalog(catalog: CanonicalGame[]): CanonicalGame[] {
  if (!Array.isArray(catalog)) return [];

  const cleaned: CanonicalGame[] = [];
  const titleToIndex = new Map<string, number>();
  const steamIdToIndex = new Map<number, number>();

  for (const rawGame of catalog) {
    if (!rawGame || !rawGame.title) continue;

    let game = { ...rawGame };
    const lowerTitle = game.title.toLowerCase().trim();
    const hasEpicPlatform = game.platforms.some((p) => p.platformId === 'epic');

    // 1. Correct false match: "Path of the Bogatyr" matched from Epic codename "Boga"
    const isFalseBogaMatch =
      hasEpicPlatform &&
      (lowerTitle === 'path of the bogatyr' ||
        game.platforms.some(
          (p) =>
            p.platformId === 'epic' &&
            ((p.platformGameId || '').toLowerCase() === 'boga' ||
              p.platformGameId === '761fe09295aa422e8199cebaacf51675')
        ));

    if (isFalseBogaMatch || lowerTitle === 'boga') {
      game = {
        ...game,
        id: 'steam-1190460',
        title: 'Death Stranding',
        sortTitle: 'Death Stranding',
        steamAppId: 1190460,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1190460/header.jpg',
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1190460/library_600x900_2x.jpg',
        shortDescription: 'From legendary game creator Hideo Kojima comes an all-new, genre-defying experience. Sam Bridges must brave a world utterly transformed by the Death Stranding.',
        releaseDate: '14 Jul, 2020',
        developers: ['KOJIMA PRODUCTIONS'],
        publishers: ['505 Games'],
        genres: ['Action', 'Adventure'],
        tags: ['Open World', 'Story Rich', 'Atmospheric', 'Sci-fi', 'Post-apocalyptic'],
        platforms: game.platforms.map((p) =>
          p.platformId === 'epic' ? { ...p, platformGameId: '761fe09295aa422e8199cebaacf51675' } : p
        ),
      };
    }

    // 2. Resolve known Epic codenames to their official game entities
    const epicPlatform = game.platforms.find((p) => p.platformId === 'epic');
    const epicPlatformId = (epicPlatform?.platformGameId || '').toLowerCase().trim();
    const gameIdClean = game.id.replace(/^epic-/, '').toLowerCase().trim();

    const epicMapping =
      KNOWN_EPIC_APP_NAMES[lowerTitle] ||
      (epicPlatformId ? KNOWN_EPIC_APP_NAMES[epicPlatformId] : undefined) ||
      (gameIdClean ? KNOWN_EPIC_APP_NAMES[gameIdClean] : undefined);

    if (epicMapping) {
      const steamId = epicMapping.steamAppId;
      game = {
        ...game,
        id: steamId ? `steam-${steamId}` : game.id,
        title: epicMapping.title,
        sortTitle: epicMapping.title.replace(/^(The|A|An)\s+/i, ''),
        steamAppId: steamId || game.steamAppId,
        headerImage: steamId
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamId}/header.jpg`
          : game.headerImage,
        capsuleImage: steamId
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamId}/library_600x900_2x.jpg`
          : game.capsuleImage,
        shortDescription: epicMapping.description || game.shortDescription,
        developers: epicMapping.developer ? [epicMapping.developer] : game.developers,
      };
    }

    // 3. Resolve raw Doki Doki Literature Club Plus! if present as hex ID
    if (
      game.id.includes('c5109bdceb3a453bb38c2fdc964ddee8') ||
      game.title === 'c5109bdceb3a453bb38c2fdc964ddee8'
    ) {
      game = {
        ...game,
        id: 'steam-1388880',
        title: 'Doki Doki Literature Club Plus!',
        sortTitle: 'Doki Doki Literature Club Plus!',
        steamAppId: 1388880,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1388880/header.jpg',
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1388880/library_600x900_2x.jpg',
        shortDescription: 'Welcome to a terrifying world of poetry and romance! Write poems for your crush and erase any mistakes along the way to ensure your perfect ending.',
        releaseDate: '30 Jun, 2021',
        developers: ['Team Salvato'],
        publishers: ['Serenity Forge'],
        genres: ['Psychological Horror', 'Visual Novel', 'Anime'],
        tags: ['Psychological Horror', 'Visual Novel', 'Anime', 'Story Rich', 'Singleplayer'],
        platforms: game.platforms.map((p) =>
          p.platformId === 'epic' ? { ...p, platformGameId: 'c5109bdceb3a453bb38c2fdc964ddee8' } : p
        ),
      };
    }

    // 4. Filter out junk, pure hex hashes, Fortnite DLC, and unmapped codenames
    if (isEpicNonGameEntry(game)) {
      continue;
    }

    const currentTitleLower = game.title.toLowerCase().trim();
    let normTitle = normalizeCanonicalTitle(game.title);
    if ([
      'bobcat', 'boxfish', 'calluna', 'catnip', 'cormorant',
      'hazelnut', 'hazlenut', 'herring', 'boga', 'barbet', 'basil', 'batfish', 'batfishs2', 'blobfish',
      'speedwell', 'wombat'
    ].includes(currentTitleLower)) {
      continue;
    }

    // Disambiguate Blood Omen: Legacy of Kain (1996 original) from Blood Omen 2
    if (
      (normTitle === 'blood omen legacy of kain' || currentTitleLower.includes('blood omen')) &&
      !currentTitleLower.includes('2') &&
      !currentTitleLower.includes('ii')
    ) {
      game = {
        ...game,
        id: 'gog-1837805079',
        steamAppId: undefined,
        headerImage: 'https://images-2.gog-statics.com/5374e38e8d5ca1aaf331ab33ae048b9a6212f8c278003d5cad1ba9efde543639_product_card_v2_mobile_slider_639.jpg',
        capsuleImage: 'https://images-2.gog-statics.com/5374e38e8d5ca1aaf331ab33ae048b9a6212f8c278003d5cad1ba9efde543639_glx_vertical_cover.jpg',
        platforms: game.platforms.map((p) => p.platformId === 'gog' ? { ...p, platformGameId: '1837805079' } : p),
      };
    }

    // Disambiguate DOOM + DOOM II (not on Steam)
    if (
      currentTitleLower === 'doom + doom ii' ||
      currentTitleLower === 'doom + doom 2' ||
      normTitle === 'doom + doom 2' ||
      normTitle === 'doom doom 2'
    ) {
      game = {
        ...game,
        id: 'gog-1413291984',
        steamAppId: undefined,
        platforms: game.platforms.map((p) => p.platformId === 'gog' ? { ...p, platformGameId: '1413291984' } : p),
      };
    }

    // Disambiguate / normalize Alan Wake 2 (Epic exclusive)
    if (
      currentTitleLower === 'alan wake 2' ||
      normTitle === 'alan wake 2'
    ) {
      game = {
        ...game,
        id: 'epic-93f2a8c3547846eda966cb3c152a026e',
        headerImage: 'https://cdn2.unrealengine.com/egs-alanwake2-remedyentertainment-s1-2560x1440-309c7412b7bc.jpg',
        capsuleImage: 'https://cdn2.unrealengine.com/egs-alanwake2-remedyentertainment-s2-1200x1600-0ebb9a566b72.jpg',
        iconUrl: 'https://cdn2.unrealengine.com/egs-alanwake2-remedyentertainment-ic1-400x400-5366b10d0f67.png',
      };
    }

    // Disambiguate / normalize Fortnite (Epic exclusive)
    if (
      currentTitleLower === 'fortnite' ||
      normTitle === 'fortnite' ||
      game.id === 'epic-4fe75bbc5a674f4f9b356b5c90567da5'
    ) {
      game = {
        ...game,
        id: 'epic-4fe75bbc5a674f4f9b356b5c90567da5',
        headerImage: 'https://cdn2.unrealengine.com/fnbr-42-00-c7s4-hacking-logo-egs-launcher-blade-2560x1440-2560x1440-00f5395fc1e7.jpg',
        capsuleImage: 'https://cdn2.unrealengine.com/fnbr-42-00-c7s4-hacking-egs-launcher-blade-1200x1600-1200x1600-0138e7df7bb0.jpg',
        iconUrl: 'https://cdn2.unrealengine.com/fnbr-42-00-c7s4-hacking-egs-launcher-blade-1200x1600-1200x1600-0138e7df7bb0.jpg',
      };
    }

    // Disambiguate / normalize Ghostrunner (fix wrong steamAppId 1225270 -> 1139900)
    if (
      currentTitleLower === 'ghostrunner' ||
      normTitle === 'ghostrunner' ||
      game.steamAppId === 1225270 ||
      game.id === 'steam-1225270'
    ) {
      game = {
        ...game,
        id: 'steam-1139900',
        steamAppId: 1139900,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1139900/header.jpg',
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1139900/library_600x900_2x.jpg',
        iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1139900/library_600x900_2x.jpg',
      };
    }

    // Disambiguate / normalize Prey (fix wrong steamAppId 474960 -> 480490)
    if (
      currentTitleLower === 'prey' ||
      normTitle === 'prey' ||
      game.steamAppId === 474960 ||
      game.id === 'steam-474960'
    ) {
      game = {
        ...game,
        id: 'steam-480490',
        steamAppId: 480490,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/480490/header.jpg',
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/480490/library_600x900_2x.jpg',
        iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/480490/library_600x900_2x.jpg',
      };
    }

    // Disambiguate / normalize Cyberpunk 2077 (Steam base game, 100% Mastered) vs Cyberpunk 2077 Digital Goodies (GOG promo pack)
    if (
      currentTitleLower === 'cyberpunk 2077' ||
      normTitle === 'cyberpunk 2077' ||
      game.steamAppId === 1091500
    ) {
      game = {
        ...game,
        platforms: game.platforms.filter((p) => p.platformId !== 'gog'),
      };
    }

    // Disambiguate / normalize Heretic + Hexen (newer hashed Steam assets)
    if (
      currentTitleLower === 'heretic + hexen' ||
      normTitle === 'heretic hexen' ||
      game.steamAppId === 3286930
    ) {
      game = {
        ...game,
        id: 'steam-3286930',
        steamAppId: 3286930,
        headerImage: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3286930/af11a57f074bf3f1b901bb96f9ea519a0928c80c/header.jpg?t=1756918167',
        capsuleImage: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3286930/dbdad6a66e6a076d138b9ce8bd81dbdf159bccb2/library_capsule.jpg',
        iconUrl: 'https://shared.fastly.steamstatic.com/community_assets/images/apps/3286930/3392b11331bc4855f803ca939720fa94e3a01bdd.jpg',
      };
    }

    // Disambiguate / normalize Second Extinction (delisted, fix trailing quote typo, add Steam ID 1024380)
    if (
      currentTitleLower.startsWith('second extinction') ||
      normTitle === 'second extinction' ||
      game.id === 'epic-9c48bdf0c65b45cc9e64aa43e7e740b0' ||
      game.steamAppId === 1024380
    ) {
      game = {
        ...game,
        id: 'steam-1024380',
        title: 'Second Extinction',
        sortTitle: 'Second Extinction',
        steamAppId: 1024380,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1024380/header.jpg',
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1024380/library_600x900_2x.jpg',
        iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1024380/library_600x900_2x.jpg',
        shortDescription: 'Second Extinction is a relentless 3-player cooperative FPS where you wipe out mutated dinosaurs that have taken over the Earth.',
      };
    }

    // Disambiguate / normalize 60 Minutes to Extinction: Escape Room (hashed Steam assets -> IGDB portrait)
    if (
      currentTitleLower.includes('60 minutes to extinction') ||
      normTitle.includes('60 minutes to extinction') ||
      game.steamAppId === 3783210
    ) {
      game = {
        ...game,
        id: 'steam-3783210',
        steamAppId: 3783210,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3783210/1055e2e14c7eadb6b7f444db978c8c85b3a84eab/header.jpg?t=1759856432',
        capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/coak2y.jpg',
        iconUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/coak2y.jpg',
      };
    }

    // Disambiguate / normalize Champions of Krynn (Steam 600x900 404s, GOG lacks vertical -> IGDB portrait)
    if (
      currentTitleLower.includes('champions of krynn') ||
      normTitle.includes('champions of krynn') ||
      game.steamAppId === 1904620
    ) {
      game = {
        ...game,
        capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co5xot.webp',
        iconUrl: game.iconUrl || 'https://images.igdb.com/igdb/image/upload/t_cover_big/co5xot.webp',
      };
    }

    // Disambiguate / normalize Castlevania Anniversary Collection (Steam 600x900 404s -> IGDB portrait)
    if (
      currentTitleLower.includes('castlevania anniversary collection') ||
      normTitle.includes('castlevania anniversary collection') ||
      game.steamAppId === 1018010
    ) {
      game = {
        ...game,
        capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co24a1.jpg',
        iconUrl: game.iconUrl || 'https://images.igdb.com/igdb/image/upload/t_cover_big/co24a1.jpg',
      };
    }

    // Disambiguate / normalize Akalabeth: World of Doom (authentic portrait box art)
    if (
      currentTitleLower.includes('akalabeth') ||
      normTitle.includes('akalabeth')
    ) {
      game = {
        ...game,
        capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co26ea.jpg',
        iconUrl: game.iconUrl || 'https://images.igdb.com/igdb/image/upload/t_cover_big/co26ea.jpg',
      };
    }

    // Disambiguate / normalize Broken Sword: Director's Cut (authentic portrait box art)
    if (
      currentTitleLower.includes('broken sword') &&
      (currentTitleLower.includes('director') || currentTitleLower.includes('templar') || currentTitleLower.includes('shadow'))
    ) {
      game = {
        ...game,
        capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',
        iconUrl: game.iconUrl || 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',
      };
    }

    // Disambiguate / normalize Citadel Remonstered / Cytadela (authentic portrait box art)
    if (
      currentTitleLower.includes('citadel remonstered') ||
      currentTitleLower.includes('cytadela') ||
      normTitle.includes('citadel remonstered') ||
      normTitle.includes('cytadela')
    ) {
      game = {
        ...game,
        capsuleImage: 'https://upload.wikimedia.org/wikipedia/en/6/63/Cytadela_cover.jpg',
        iconUrl: game.iconUrl || 'https://upload.wikimedia.org/wikipedia/en/6/63/Cytadela_cover.jpg',
      };
    }

    // Disambiguate / normalize DEATH STRANDING 2: ON THE BEACH (hashed Steam assets)
    if (
      currentTitleLower.includes('death stranding 2') ||
      normTitle.includes('death stranding 2') ||
      game.steamAppId === 3280350
    ) {
      game = {
        ...game,
        id: 'steam-3280350',
        steamAppId: 3280350,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3280350/6270c77b0729e2df0a17d660286eeddfd9169386/header.jpg?t=1774022345',
        capsuleImage: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3280350/9b523fd411eeaefe80f238489745325a1cd2317f/library_capsule.jpg',
        iconUrl: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3280350/9b523fd411eeaefe80f238489745325a1cd2317f/library_capsule.jpg',
      };
    }

    // Disambiguate / normalize Little Nightmares Enhanced Edition (hashed Steam assets)
    if (
      currentTitleLower.includes('little nightmares enhanced') ||
      normTitle.includes('little nightmares enhanced') ||
      game.steamAppId === 2149010
    ) {
      game = {
        ...game,
        id: 'steam-2149010',
        steamAppId: 2149010,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2149010/8f1da102713653906647c5024843479395be3394/header.jpg?t=1760951366',
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/424840/library_600x900_2x.jpg',
        iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/424840/library_600x900_2x.jpg',
      };
    }

    // Disambiguate / normalize The Blood of Dawnwalker (hashed Steam assets)
    if (
      currentTitleLower.includes('blood of dawnwalker') ||
      normTitle.includes('blood of dawnwalker') ||
      game.steamAppId === 3751260
    ) {
      game = {
        ...game,
        id: 'steam-3751260',
        steamAppId: 3751260,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3751260/a7062f3b59d491c2678e3fd7ce2672858e480641/header.jpg?t=1791298326',
        capsuleImage: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3751260/82769ab631e6e68b4a38bbba9fb5b74eb0d7db8d/library_capsule.jpg',
        iconUrl: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3751260/82769ab631e6e68b4a38bbba9fb5b74eb0d7db8d/library_capsule.jpg',
      };
    }

    // Disambiguate / normalize Resident Evil Requiem (hashed Steam assets)
    if (
      currentTitleLower.includes('resident evil requiem') ||
      normTitle.includes('resident evil requiem') ||
      game.steamAppId === 3764200
    ) {
      game = {
        ...game,
        id: 'steam-3764200',
        steamAppId: 3764200,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3764200/ce5437442768e38eb575f205ab9397d0264017b0/header.jpg?t=1779840172',
        capsuleImage: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3764200/ed3b2cae7d15f598f41006f5f1e605ec5517b5e4/library_capsule.jpg',
        iconUrl: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3764200/ed3b2cae7d15f598f41006f5f1e605ec5517b5e4/library_capsule.jpg',
      };
    }

    // Disambiguate / normalize RollerCoaster Tycoon 3: Complete Edition
    if (
      currentTitleLower.includes('rollercoaster tycoon') &&
      (currentTitleLower.includes('3') || currentTitleLower.includes('complete'))
    ) {
      game = {
        ...game,
        id: 'steam-1368820',
        title: 'RollerCoaster Tycoon 3: Complete Edition',
        sortTitle: 'RollerCoaster Tycoon 3: Complete Edition',
        steamAppId: 1368820,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1368820/header.jpg',
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1368820/library_600x900_2x.jpg',
        iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1368820/library_600x900_2x.jpg',
      };
    }

    // Disambiguate / normalize Higurashi When They Cry Hou - Ch.1 Onikakushi
    if (
      currentTitleLower.includes('higurashi') &&
      (currentTitleLower.includes('onikakushi') || currentTitleLower.includes('ch.1') || currentTitleLower.includes('ch 1'))
    ) {
      game = {
        ...game,
        id: 'steam-310360',
        title: 'Higurashi When They Cry Hou - Ch.1 Onikakushi',
        sortTitle: 'Higurashi When They Cry Hou - Ch.1 Onikakushi',
        steamAppId: 310360,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/310360/header.jpg',
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/310360/library_600x900_2x.jpg',
        iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/310360/library_600x900_2x.jpg',
      };
    }

    // Disambiguate / normalize Lure of the Temptress (1992)
    if (
      currentTitleLower.includes('lure of the temptress') ||
      normTitle.includes('lure of the temptress')
    ) {
      game = {
        ...game,
        capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1npy.jpg',
        iconUrl: game.iconUrl || 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1npy.jpg',
      };
    }

    // Disambiguate / normalize RPG Maker XP
    if (
      currentTitleLower === 'rpg maker xp' ||
      normTitle === 'rpg maker xp' ||
      game.steamAppId === 235900
    ) {
      game = {
        ...game,
        capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2r75.jpg',
        iconUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2r75.jpg',
      };
    }

    // Disambiguate / normalize Wildgate (hashed Steam assets)
    if (
      currentTitleLower === 'wildgate' ||
      normTitle === 'wildgate' ||
      game.steamAppId === 3504780
    ) {
      game = {
        ...game,
        id: 'steam-3504780',
        steamAppId: 3504780,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3504780/95f1381dac57ce601d5260de3c792f8a2ee2bc93/header.jpg?t=1787942042',
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3504780/22488e2f7358b27d1ccff845bc5bd02e72a1494e/capsule_231x87.jpg?t=1787942042',
        iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3504780/22488e2f7358b27d1ccff845bc5bd02e72a1494e/capsule_231x87.jpg?t=1787942042',
      };
    }

    // Disambiguate / normalize Spacewar (archival assets)
    if (
      currentTitleLower === 'spacewar' ||
      normTitle === 'spacewar' ||
      game.steamAppId === 480
    ) {
      game = {
        ...game,
        id: 'steam-480',
        steamAppId: 480,
        headerImage: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/23/Spacewar%21-PDP-1-20070512.jpg/960px-Spacewar%21-PDP-1-20070512.jpg',
        capsuleImage: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/23/Spacewar%21-PDP-1-20070512.jpg/960px-Spacewar%21-PDP-1-20070512.jpg',
        iconUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/23/Spacewar%21-PDP-1-20070512.jpg/960px-Spacewar%21-PDP-1-20070512.jpg',
      };
    }

    // 5. Remove erroneous 'epic' platform presence from non-Epic titles
    if (currentTitleLower.includes('gwent') || currentTitleLower.includes('heroes of might and magic')) {
      game = {
        ...game,
        platforms: game.platforms.filter((p) => p.platformId !== 'epic'),
      };
      if (game.platforms.length === 0) continue;
    }

    // 6. Purge false GOG platform presence from unowned GOG titles (e.g. old bestselling catalog items like Anno 1404)
    if (game.platforms.some((p) => p.platformId === 'gog')) {
      const gogPlatform = game.platforms.find((p) => p.platformId === 'gog');
      const isRealGogGame =
        (gogPlatform?.platformGameId && validGogProductIds.has(gogPlatform.platformGameId.trim())) ||
        validGogTitles.has(normTitle);

      if (!isRealGogGame) {
        game = {
          ...game,
          platforms: game.platforms.filter((p) => p.platformId !== 'gog'),
        };
        if (game.platforms.length === 0) continue;
      }
    }

    // 7. Purge false Epic platform presence from unowned Epic titles, DLCs, codenames, and non-games
    if (game.platforms.some((p) => p.platformId === 'epic')) {
      const epicPlatform = game.platforms.find((p) => p.platformId === 'epic');
      const epicGameId = (epicPlatform?.platformGameId || '').trim().toLowerCase();

      // If title is not recognized, but catalog ID matches a verified base game, re-assign to real base game
      if (!validEpicTitles.has(normTitle) && validEpicBaseGameByCatalogId.has(epicGameId)) {
        const baseGame = validEpicBaseGameByCatalogId.get(epicGameId)!;
        game = {
          ...baseGame,
          platforms: game.platforms.map((p) =>
            p.platformId === 'epic' ? { ...p, platformGameId: epicGameId } : p
          ),
        };
      }

      const updatedNormTitle = normalizeCanonicalTitle(game.title);
      // Whitelist: every authentic Epic game must match one of the 402 verified titles
      const isRealEpicGame = validEpicTitles.has(updatedNormTitle);

      if (!isRealEpicGame) {
        game = {
          ...game,
          platforms: game.platforms.filter((p) => p.platformId !== 'epic'),
        };
        if (game.platforms.length === 0) continue;
      }
    }

    // 8. Purge false Steam platform presence from unowned Steam titles, demos, and promo cache
    if (game.platforms.some((p) => p.platformId === 'steam')) {
      const steamPlatform = game.platforms.find((p) => p.platformId === 'steam');
      const appId =
        game.steamAppId ||
        (steamPlatform?.platformGameId && !isNaN(Number(steamPlatform.platformGameId))
          ? Number(steamPlatform.platformGameId)
          : undefined);

      const isUnownedPromo = appId ? UNOWNED_STEAM_PROMO_APP_IDS.has(appId) : false;
      const isRealSteamGame = appId ? validSteamAppIds.has(appId) : validSteamTitles.has(normTitle);

      if (isUnownedPromo || !isRealSteamGame) {
        game = {
          ...game,
          steamAppId: undefined,
          platforms: game.platforms.filter((p) => p.platformId !== 'steam'),
        };
        if (game.platforms.length === 0) continue;
      }
    }

    normTitle = normalizeCanonicalTitle(game.title);

    if (isPlaceholderDesc(game.shortDescription, game.title)) {
      game = { ...game, shortDescription: '' };
    }

    // Normalize GOG image covers to official high-quality vertical cover format
    if (game.capsuleImage && game.capsuleImage.includes('gog-statics.com') && !game.capsuleImage.includes('glx_vertical_cover')) {
      const gogMatch = game.capsuleImage.match(/^(https?:\/\/images-\d+\.gog-statics\.com\/[a-f0-9]+)/i);
      if (gogMatch) {
        game = {
          ...game,
          capsuleImage: `${gogMatch[1]}_glx_vertical_cover.jpg`,
        };
      }
    }

    // Attach verified IGDB portrait cover if game lacks vertical art, has unsuitable/cropped covers, or known dead Steam art
    const instantIgdbCover = igdbCoverService.getIgdbCoverInstant(game.title, game.steamAppId, game.id);
    if (instantIgdbCover) {
      if (
        !game.capsuleImage ||
        isKnownDeadSteamCover(game.steamAppId) ||
        isUnsuitableCoverUrl(game.capsuleImage) ||
        game.capsuleImage.includes('231x87') ||
        game.capsuleImage.includes('616x353') ||
        game.capsuleImage.includes('gog-statics.com')
      ) {
        game = {
          ...game,
          capsuleImage: instantIgdbCover,
          iconUrl: game.iconUrl || instantIgdbCover,
        };
      }
    }

    // 9. Intelligent cross-store deduplication by Steam App ID and Normalized Title
    const existingIndex =
      (game.steamAppId && steamIdToIndex.has(game.steamAppId)
        ? steamIdToIndex.get(game.steamAppId)
        : undefined) ??
      (normTitle && titleToIndex.has(normTitle)
        ? (() => {
            const idx = titleToIndex.get(normTitle)!;
            const existing = cleaned[idx];
            if (existing && existing.steamAppId && game.steamAppId && existing.steamAppId !== game.steamAppId) {
              return undefined;
            }
            return idx;
          })()
        : undefined);

    if (existingIndex !== undefined && cleaned[existingIndex]) {
      // Merge platforms across duplicates
      const existing = cleaned[existingIndex];
      const mergedPlatforms = [...existing.platforms];
      for (const p of game.platforms) {
        const found = mergedPlatforms.some((ep) => ep.platformId === p.platformId);
        if (!found) {
          mergedPlatforms.push(p);
        }
      }

      cleaned[existingIndex] = {
        ...existing,
        steamAppId: existing.steamAppId || game.steamAppId,
        id: existing.steamAppId
          ? `steam-${existing.steamAppId}`
          : game.steamAppId
          ? `steam-${game.steamAppId}`
          : existing.id,
        platforms: mergedPlatforms,
        headerImage: (game.headerImage && (!existing.headerImage || existing.headerImage.includes('egs-badge.png') || existing.headerImage.includes('1225270') || existing.headerImage.endsWith('/3286930/header.jpg') || existing.headerImage.endsWith('/3783210/header.jpg') || existing.headerImage.endsWith('/3280350/header.jpg') || existing.headerImage.endsWith('/2149010/header.jpg') || existing.headerImage.endsWith('/3751260/header.jpg') || existing.headerImage.endsWith('/3504780/header.jpg') || existing.headerImage.endsWith('/480/header.jpg'))) ? game.headerImage : (existing.headerImage || game.headerImage),
        capsuleImage: (() => {
          const igdb = igdbCoverService.getIgdbCoverInstant(game.title, game.steamAppId || existing.steamAppId, game.id || existing.id);
          if (igdb && (isKnownDeadSteamCover(existing.steamAppId) || isKnownDeadSteamCover(game.steamAppId))) {
            return igdb;
          }
          if (
            game.capsuleImage &&
            (!existing.capsuleImage ||
              existing.capsuleImage.includes('egs-badge.png') ||
              existing.capsuleImage.includes('1225270') ||
              existing.capsuleImage.includes('231x87') ||
              isKnownDeadSteamCover(existing.steamAppId) ||
              existing.capsuleImage.includes('/3783210/library_') ||
              existing.capsuleImage.includes('/3280350/library_') ||
              existing.capsuleImage.includes('/2149010/library_') ||
              existing.capsuleImage.includes('/3751260/library_') ||
              existing.capsuleImage.includes('/3504780/library_') ||
              existing.capsuleImage.includes('/1904620/library_') ||
              existing.capsuleImage.includes('/1904621/library_') ||
              existing.capsuleImage.includes('/1904622/library_') ||
              existing.capsuleImage.includes('/1018010/library_') ||
              existing.capsuleImage.includes('/480/'))
          ) {
            return game.capsuleImage;
          }
          return existing.capsuleImage || game.capsuleImage;
        })(),
        iconUrl: (game.iconUrl && (!existing.iconUrl || existing.iconUrl.includes('egs-badge.png') || existing.iconUrl.includes('1225270'))) ? game.iconUrl : (existing.iconUrl || game.iconUrl || game.capsuleImage),
        shortDescription: (!isPlaceholderDesc(existing.shortDescription, existing.title))
          ? existing.shortDescription
          : (!isPlaceholderDesc(game.shortDescription, game.title))
          ? game.shortDescription
          : '',
        developers: existing.developers && existing.developers.length > 0 ? existing.developers : game.developers,
        publishers: existing.publishers && existing.publishers.length > 0 ? existing.publishers : game.publishers,
      };

      if (cleaned[existingIndex].steamAppId) {
        steamIdToIndex.set(cleaned[existingIndex].steamAppId!, existingIndex);
      }
    } else {
      const newIndex = cleaned.length;
      cleaned.push(game);
      if (normTitle) titleToIndex.set(normTitle, newIndex);
      if (game.steamAppId) steamIdToIndex.set(game.steamAppId, newIndex);
    }
  }

  return cleaned.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}
