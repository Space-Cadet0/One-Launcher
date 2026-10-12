import { CanonicalGame } from '../../contracts/game';
import { KNOWN_EPIC_APP_NAMES } from './epicCodenames';
import { GOG_USER_LIBRARY } from '../storage/gogUserLibrary';
import { EPIC_USER_LIBRARY } from '../storage/epicUserLibrary';
import { FULL_USER_STEAM_GAMES } from '../storage/fullUserSteamGames';
import { igdbCoverService, isKnownDeadSteamCover, isUnsuitableCoverUrl, KNOWN_IGDB_COVERS } from '../igdb/igdbCoverService';
import { steamMatcher } from '../steam/steamMatcher';
import steamBlurbCache from '../storage/steamBlurbCache.json';
import gogEnrichedCache from '../storage/gogEnrichedCache.json';
import { GOG_SPECIAL_DESCRIPTIONS } from '../steam/fallbackMetadataProvider';
import {
  loadUserOverrides,
  getUserOverrideForGame,
  applyUserOverrideToGame,
  applyUserOverridesToCatalog,
} from '../storage/userOverrideStorage';

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
  if (lower.includes('store exclusive')) return true;
  if (lower.endsWith(' experience') && trimmed.split(' ').length <= 4) return true;
  if (/^(action|role-playing|adventure|shooter|strategy|simulation|racing|sports|indie)\s+experience$/i.test(trimmed)) return true;
  if (lower === 'classic title') return true;
  if (/^[a-z\s-]+ on gog\.com/i.test(trimmed)) return true;
  if (/^dlcs?\s+(included|available)/i.test(trimmed)) return true;
  if (/^includes\s+(the\s+following\s+)?dlc/i.test(trimmed)) return true;
  if (/^bonus\s+content/i.test(trimmed)) return true;
  if (/^this\s+package\s+includes/i.test(trimmed)) return true;
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

export interface CatalogGamePatch {
  targetId?: string;
  title?: string;
  sortTitle?: string;
  steamAppId?: number | null;
  headerImage?: string;
  capsuleImage?: string;
  iconUrl?: string;
  preserveExistingIcon?: boolean;
  shortDescription?: string;
  releaseDate?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  tags?: string[];
  platformFilters?: {
    excludePlatformId?: string;
    setPlatformGameId?: { platformId: string; gameId: string };
  };
}

/**
 * Curated declarative game overrides and asset patches.
 * Replaces dozens of sequential hardcoded if-statements with an O(1) table.
 */
export const KNOWN_GAME_PATCHES: Record<string, CatalogGamePatch> = {
  'death stranding': {
    targetId: 'steam-1190460',
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
    platformFilters: {
      setPlatformGameId: { platformId: 'epic', gameId: '761fe09295aa422e8199cebaacf51675' },
    },
  },
  'doki doki literature club plus!': {
    targetId: 'steam-1388880',
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
    platformFilters: {
      setPlatformGameId: { platformId: 'epic', gameId: 'c5109bdceb3a453bb38c2fdc964ddee8' },
    },
  },
  'blood omen: legacy of kain': {
    targetId: 'gog-1837805079',
    steamAppId: null,
    headerImage: 'https://images-2.gog-statics.com/5374e38e8d5ca1aaf331ab33ae048b9a6212f8c278003d5cad1ba9efde543639_product_card_v2_mobile_slider_639.jpg',
    capsuleImage: 'https://images-2.gog-statics.com/5374e38e8d5ca1aaf331ab33ae048b9a6212f8c278003d5cad1ba9efde543639_glx_vertical_cover.jpg',
    platformFilters: {
      setPlatformGameId: { platformId: 'gog', gameId: '1837805079' },
    },
  },
  'doom + doom ii': {
    targetId: 'gog-1413291984',
    steamAppId: null,
    platformFilters: {
      setPlatformGameId: { platformId: 'gog', gameId: '1413291984' },
    },
  },
  'alan wake 2': {
    targetId: 'epic-93f2a8c3547846eda966cb3c152a026e',
    headerImage: 'https://cdn2.unrealengine.com/egs-alanwake2-remedyentertainment-s1-2560x1440-309c7412b7bc.jpg',
    capsuleImage: 'https://cdn2.unrealengine.com/egs-alanwake2-remedyentertainment-s2-1200x1600-0ebb9a566b72.jpg',
    iconUrl: 'https://cdn2.unrealengine.com/egs-alanwake2-remedyentertainment-ic1-400x400-5366b10d0f67.png',
  },
  'fortnite': {
    targetId: 'epic-4fe75bbc5a674f4f9b356b5c90567da5',
    headerImage: 'https://cdn2.unrealengine.com/fnbr-42-00-c7s4-hacking-logo-egs-launcher-blade-2560x1440-2560x1440-00f5395fc1e7.jpg',
    capsuleImage: 'https://cdn2.unrealengine.com/fnbr-42-00-c7s4-hacking-egs-launcher-blade-1200x1600-1200x1600-0138e7df7bb0.jpg',
    iconUrl: 'https://cdn2.unrealengine.com/fnbr-42-00-c7s4-hacking-egs-launcher-blade-1200x1600-1200x1600-0138e7df7bb0.jpg',
  },
  'ghostrunner': {
    targetId: 'steam-1139900',
    steamAppId: 1139900,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1139900/header.jpg',
    capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1139900/library_600x900_2x.jpg',
    iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1139900/library_600x900_2x.jpg',
  },
  'prey': {
    targetId: 'steam-480490',
    steamAppId: 480490,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/480490/header.jpg',
    capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/480490/library_600x900_2x.jpg',
    iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/480490/library_600x900_2x.jpg',
  },
  'cyberpunk 2077': {
    platformFilters: {
      excludePlatformId: 'gog',
    },
  },
  'agony': {
    targetId: 'steam-487720',
    title: 'Agony',
    sortTitle: 'Agony',
    steamAppId: 487720,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/487720/header.jpg',
    capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/487720/library_600x900_2x.jpg',
    iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/487720/library_600x900_2x.jpg',
    shortDescription:
      'Agony is a first-person, survival horror set in hell. You will begin your journey as a tormented soul within the depths of hell without any memories about your past. The special ability to control people on your path, and possess demons, gives you the measures to survive.',
  },
  'agony unrated': {
    targetId: 'steam-879420',
    title: 'Agony UNRATED',
    sortTitle: 'Agony UNRATED',
    steamAppId: 879420,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/879420/header.jpg',
    capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/879420/library_600x900_2x.jpg',
    iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/879420/library_600x900_2x.jpg',
    shortDescription:
      'Agony UNRATED is a first-person, survival horror set in hell. You will begin your journey as a tormented soul within the depths of hell without any memories about your past. The special ability to control people on your path, and possess demons, gives you the measures to survive.',
  },
  'heretic + hexen': {
    targetId: 'steam-3286930',
    steamAppId: 3286930,
    headerImage: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3286930/af11a57f074bf3f1b901bb96f9ea519a0928c80c/header.jpg?t=1756918167',
    capsuleImage: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3286930/dbdad6a66e6a076d138b9ce8bd81dbdf159bccb2/library_capsule.jpg',
    iconUrl: 'https://shared.fastly.steamstatic.com/community_assets/images/apps/3286930/3392b11331bc4855f803ca939720fa94e3a01bdd.jpg',
  },
  'second extinction': {
    targetId: 'steam-1024380',
    title: 'Second Extinction',
    sortTitle: 'Second Extinction',
    steamAppId: 1024380,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1024380/header.jpg',
    capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1024380/library_600x900_2x.jpg',
    iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1024380/library_600x900_2x.jpg',
    shortDescription:
      'Second Extinction is a relentless 3-player cooperative FPS where you wipe out mutated dinosaurs that have taken over the Earth.',
  },
  '60 minutes to extinction': {
    targetId: 'steam-3783210',
    steamAppId: 3783210,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3783210/1055e2e14c7eadb6b7f444db978c8c85b3a84eab/header.jpg?t=1759856432',
    capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/coak2y.jpg',
    iconUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/coak2y.jpg',
  },
  'champions of krynn': {
    capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co5xot.webp',
    iconUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co5xot.webp',
    preserveExistingIcon: true,
  },
  'castlevania anniversary collection': {
    capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co24a1.jpg',
    iconUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co24a1.jpg',
    preserveExistingIcon: true,
  },
  'akalabeth': {
    capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co26ea.jpg',
    iconUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co26ea.jpg',
    preserveExistingIcon: true,
  },
  'broken sword': {
    capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',
    iconUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',
    preserveExistingIcon: true,
  },
  'citadel remonstered': {
    capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/coc0q5.webp',
    iconUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/coc0q5.webp',
    preserveExistingIcon: true,
  },
  'death stranding 2': {
    targetId: 'steam-3280350',
    steamAppId: 3280350,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3280350/6270c77b0729e2df0a17d660286eeddfd9169386/header.jpg?t=1774022345',
    capsuleImage: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3280350/9b523fd411eeaefe80f238489745325a1cd2317f/library_capsule.jpg',
    iconUrl: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3280350/9b523fd411eeaefe80f238489745325a1cd2317f/library_capsule.jpg',
  },
  'little nightmares enhanced': {
    targetId: 'steam-2149010',
    steamAppId: 2149010,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2149010/8f1da102713653906647c5024843479395be3394/header.jpg?t=1760951366',
    capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/424840/library_600x900_2x.jpg',
    iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/424840/library_600x900_2x.jpg',
  },
  'blood of dawnwalker': {
    targetId: 'steam-3751260',
    steamAppId: 3751260,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3751260/a7062f3b59d491c2678e3fd7ce2672858e480641/header.jpg?t=1791298326',
    capsuleImage: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3751260/82769ab631e6e68b4a38bbba9fb5b74eb0d7db8d/library_capsule.jpg',
    iconUrl: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3751260/82769ab631e6e68b4a38bbba9fb5b74eb0d7db8d/library_capsule.jpg',
  },
  'resident evil requiem': {
    targetId: 'steam-3764200',
    steamAppId: 3764200,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3764200/ce5437442768e38eb575f205ab9397d0264017b0/header.jpg?t=1779840172',
    capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/cobmj0.jpg',
    iconUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/cobmj0.jpg',
  },
  'grip': {
    targetId: 'steam-396900',
    steamAppId: 396900,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/396900/header.jpg',
    capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/396900/library_600x900_2x.jpg',
    iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/396900/library_600x900_2x.jpg',
    shortDescription:
      'GRIP is a high octane, hardcore combat racer, packing ferocious speed and an arsenal of heavy weapons. Harness the laws of gravity as you race up walls and ceilings across exotic worlds.',
  },
  'fallout: london': {
    capsuleImage: 'https://images.gog-statics.com/b9a00e7d9a9d8cb5d17ec67aa41dc8d392358e0340d679f855fa113c444c11ee.jpg',
    iconUrl: 'https://images.gog-statics.com/b9a00e7d9a9d8cb5d17ec67aa41dc8d392358e0340d679f855fa113c444c11ee.jpg',
  },
  'eschalon: book i': {
    capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co214q.webp',
    iconUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co214q.webp',
  },
  'deus ex': {
    targetId: 'steam-6910',
    steamAppId: 6910,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/6910/header.jpg',
    capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/6910/library_600x900_2x.jpg',
    iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/6910/library_600x900_2x.jpg',
  },
  'tomb raider goty': {
    capsuleImage: 'https://images.gog-statics.com/754dd55607aecdc8a2989a9e4a280d0caa3875fe88c1974ba6e10dd1b9a3b1d6.jpg',
    iconUrl: 'https://images.gog-statics.com/754dd55607aecdc8a2989a9e4a280d0caa3875fe88c1974ba6e10dd1b9a3b1d6.jpg',
  },
  'summers gone season 1': {
    capsuleImage: 'https://images.gog-statics.com/754d59c26ea2a81d688ef36948f9a53aa036154f42c21ea3aa3a2bcc71e1b097.jpg',
    iconUrl: 'https://images.gog-statics.com/754d59c26ea2a81d688ef36948f9a53aa036154f42c21ea3aa3a2bcc71e1b097.jpg',
  },
  'rollercoaster tycoon 3': {
    targetId: 'steam-1368820',
    title: 'RollerCoaster Tycoon 3: Complete Edition',
    sortTitle: 'RollerCoaster Tycoon 3: Complete Edition',
    steamAppId: 1368820,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1368820/header.jpg',
    capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1368820/library_600x900_2x.jpg',
    iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1368820/library_600x900_2x.jpg',
  },
  'higurashi': {
    targetId: 'steam-310360',
    title: 'Higurashi When They Cry Hou - Ch.1 Onikakushi',
    sortTitle: 'Higurashi When They Cry Hou - Ch.1 Onikakushi',
    steamAppId: 310360,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/310360/header.jpg',
    capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/310360/library_600x900_2x.jpg',
    iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/310360/library_600x900_2x.jpg',
  },
  'lure of the temptress': {
    capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1npy.jpg',
    iconUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1npy.jpg',
    preserveExistingIcon: true,
  },
  'rpg maker xp': {
    capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2r75.jpg',
    iconUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2r75.jpg',
  },
  'wildgate': {
    targetId: 'steam-3504780',
    steamAppId: 3504780,
    headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3504780/95f1381dac57ce601d5260de3c792f8a2ee2bc93/header.jpg?t=1787942042',
    capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co9kqs.jpg',
    iconUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co9kqs.jpg',
  },
  'spacewar': {
    targetId: 'steam-480',
    steamAppId: 480,
    headerImage: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/23/Spacewar%21-PDP-1-20070512.jpg/960px-Spacewar%21-PDP-1-20070512.jpg',
    capsuleImage: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/23/Spacewar%21-PDP-1-20070512.jpg/960px-Spacewar%21-PDP-1-20070512.jpg',
    iconUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/23/Spacewar%21-PDP-1-20070512.jpg/960px-Spacewar%21-PDP-1-20070512.jpg',
  },
  'darq': {
    targetId: 'steam-433550',
    title: 'DARQ: Complete Edition',
    sortTitle: 'DARQ: Complete Edition',
    steamAppId: 433550,
    headerImage: 'https://cdn1.epicgames.com/salesEvent/salesEvent/EGS_DARQCompleteEdition_UnfoldGames_S1_2560x1440_2560x1440-15e5dda133bae02a6b9cdf6086ec03f3',
    capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/433550/library_600x900_2x.jpg',
    iconUrl: 'https://cdn1.epicgames.com/salesEvent/salesEvent/EGS_DARQCompleteEdition_UnfoldGames_S2_1200x1600_1200x1600-d53e44ba5b0dc0e019ee698f02b6d300',
    shortDescription:
      'DARQ tells the story of Lloyd, a boy who finds himself in the middle of a lucid nightmare. Unable to wake up, Lloyd has to face his fears and decipher the meaning of the dream.',
    releaseDate: '2020-12-04',
    developers: ['Unfold Games'],
    publishers: ['Unfold Games', 'Feardemic'],
    genres: ['Action', 'Adventure', 'Indie', 'Puzzle'],
    tags: ['Atmospheric', 'Psychological Horror', 'Puzzle', 'Dark', 'Horror', 'Surreal', 'Singleplayer'],
  },
};

// Aliases for O(1) direct matching across various key formats
KNOWN_GAME_PATCHES['darq: complete edition'] = KNOWN_GAME_PATCHES['darq'];
KNOWN_GAME_PATCHES['darq complete edition'] = KNOWN_GAME_PATCHES['darq'];
KNOWN_GAME_PATCHES['boga'] = KNOWN_GAME_PATCHES['death stranding'];
KNOWN_GAME_PATCHES['path of the bogatyr'] = KNOWN_GAME_PATCHES['death stranding'];
KNOWN_GAME_PATCHES['c5109bdceb3a453bb38c2fdc964ddee8'] = KNOWN_GAME_PATCHES['doki doki literature club plus!'];
KNOWN_GAME_PATCHES['blood omen legacy of kain'] = KNOWN_GAME_PATCHES['blood omen: legacy of kain'];
KNOWN_GAME_PATCHES['doom + doom 2'] = KNOWN_GAME_PATCHES['doom + doom ii'];
KNOWN_GAME_PATCHES['doom doom 2'] = KNOWN_GAME_PATCHES['doom + doom ii'];
KNOWN_GAME_PATCHES['heretic hexen'] = KNOWN_GAME_PATCHES['heretic + hexen'];
KNOWN_GAME_PATCHES['cytadela'] = KNOWN_GAME_PATCHES['citadel remonstered'];
KNOWN_GAME_PATCHES['rollercoaster tycoon 3: complete edition'] = KNOWN_GAME_PATCHES['rollercoaster tycoon 3'];
KNOWN_GAME_PATCHES['higurashi when they cry hou - ch.1 onikakushi'] = KNOWN_GAME_PATCHES['higurashi'];
KNOWN_GAME_PATCHES['grip: combat racing'] = KNOWN_GAME_PATCHES['grip'];
KNOWN_GAME_PATCHES['grip combat racing'] = KNOWN_GAME_PATCHES['grip'];
KNOWN_GAME_PATCHES['fallout london'] = KNOWN_GAME_PATCHES['fallout: london'];
KNOWN_GAME_PATCHES['eschalon book i'] = KNOWN_GAME_PATCHES['eschalon: book i'];
KNOWN_GAME_PATCHES['eschalon: book 1'] = KNOWN_GAME_PATCHES['eschalon: book i'];
KNOWN_GAME_PATCHES['eschalon book 1'] = KNOWN_GAME_PATCHES['eschalon: book i'];
KNOWN_GAME_PATCHES['deus ex goty edition'] = KNOWN_GAME_PATCHES['deus ex'];
KNOWN_GAME_PATCHES['deus ex: goty edition'] = KNOWN_GAME_PATCHES['deus ex'];
KNOWN_GAME_PATCHES['deus ex: game of the year edition'] = KNOWN_GAME_PATCHES['deus ex'];
KNOWN_GAME_PATCHES['deus ex game of the year edition'] = KNOWN_GAME_PATCHES['deus ex'];
KNOWN_GAME_PATCHES['deus ex goty'] = KNOWN_GAME_PATCHES['deus ex'];
KNOWN_GAME_PATCHES['deus ex™ goty edition'] = KNOWN_GAME_PATCHES['deus ex'];
KNOWN_GAME_PATCHES['tomb raider: goty'] = KNOWN_GAME_PATCHES['tomb raider goty'];
KNOWN_GAME_PATCHES['tomb raider: game of the year edition'] = KNOWN_GAME_PATCHES['tomb raider goty'];
KNOWN_GAME_PATCHES['tomb raider game of the year edition'] = KNOWN_GAME_PATCHES['tomb raider goty'];
KNOWN_GAME_PATCHES['tomb raider goty edition'] = KNOWN_GAME_PATCHES['tomb raider goty'];
KNOWN_GAME_PATCHES["summer's gone - season 1"] = KNOWN_GAME_PATCHES['summers gone season 1'];
KNOWN_GAME_PATCHES["summer's gone: season 1"] = KNOWN_GAME_PATCHES['summers gone season 1'];
KNOWN_GAME_PATCHES['summers gone - season 1'] = KNOWN_GAME_PATCHES['summers gone season 1'];

// ID and AppID aliases
KNOWN_GAME_PATCHES['epic-4fe75bbc5a674f4f9b356b5c90567da5'] = KNOWN_GAME_PATCHES['fortnite'];
KNOWN_GAME_PATCHES['steam-1225270'] = KNOWN_GAME_PATCHES['ghostrunner'];
KNOWN_GAME_PATCHES['app-1225270'] = KNOWN_GAME_PATCHES['ghostrunner'];
KNOWN_GAME_PATCHES['steam-474960'] = KNOWN_GAME_PATCHES['prey'];
KNOWN_GAME_PATCHES['app-474960'] = KNOWN_GAME_PATCHES['prey'];
KNOWN_GAME_PATCHES['app-1091500'] = KNOWN_GAME_PATCHES['cyberpunk 2077'];
KNOWN_GAME_PATCHES['gog-2028023186'] = KNOWN_GAME_PATCHES['agony'];
KNOWN_GAME_PATCHES['steam-487720'] = KNOWN_GAME_PATCHES['agony'];
KNOWN_GAME_PATCHES['app-487720'] = KNOWN_GAME_PATCHES['agony'];
KNOWN_GAME_PATCHES['steam-879420'] = KNOWN_GAME_PATCHES['agony unrated'];
KNOWN_GAME_PATCHES['app-879420'] = KNOWN_GAME_PATCHES['agony unrated'];
KNOWN_GAME_PATCHES['app-3286930'] = KNOWN_GAME_PATCHES['heretic + hexen'];
KNOWN_GAME_PATCHES['epic-9c48bdf0c65b45cc9e64aa43e7e740b0'] = KNOWN_GAME_PATCHES['second extinction'];
KNOWN_GAME_PATCHES['app-1024380'] = KNOWN_GAME_PATCHES['second extinction'];
KNOWN_GAME_PATCHES['app-3783210'] = KNOWN_GAME_PATCHES['60 minutes to extinction'];
KNOWN_GAME_PATCHES['app-1904620'] = KNOWN_GAME_PATCHES['champions of krynn'];
KNOWN_GAME_PATCHES['app-1018010'] = KNOWN_GAME_PATCHES['castlevania anniversary collection'];
KNOWN_GAME_PATCHES['app-3280350'] = KNOWN_GAME_PATCHES['death stranding 2'];
KNOWN_GAME_PATCHES['app-2149010'] = KNOWN_GAME_PATCHES['little nightmares enhanced'];
KNOWN_GAME_PATCHES['app-3751260'] = KNOWN_GAME_PATCHES['blood of dawnwalker'];
KNOWN_GAME_PATCHES['app-3764200'] = KNOWN_GAME_PATCHES['resident evil requiem'];
KNOWN_GAME_PATCHES['steam-3764200'] = KNOWN_GAME_PATCHES['resident evil requiem'];
KNOWN_GAME_PATCHES['app-1368820'] = KNOWN_GAME_PATCHES['rollercoaster tycoon 3'];
KNOWN_GAME_PATCHES['app-310360'] = KNOWN_GAME_PATCHES['higurashi'];
KNOWN_GAME_PATCHES['app-235900'] = KNOWN_GAME_PATCHES['rpg maker xp'];
KNOWN_GAME_PATCHES['app-3504780'] = KNOWN_GAME_PATCHES['wildgate'];
KNOWN_GAME_PATCHES['app-480'] = KNOWN_GAME_PATCHES['spacewar'];
KNOWN_GAME_PATCHES['app-396900'] = KNOWN_GAME_PATCHES['grip'];
KNOWN_GAME_PATCHES['steam-396900'] = KNOWN_GAME_PATCHES['grip'];
KNOWN_GAME_PATCHES['gog-1342466874'] = KNOWN_GAME_PATCHES['grip'];
KNOWN_GAME_PATCHES['gog-1491728574'] = KNOWN_GAME_PATCHES['fallout: london'];
KNOWN_GAME_PATCHES['app-25600'] = KNOWN_GAME_PATCHES['eschalon: book i'];
KNOWN_GAME_PATCHES['steam-25600'] = KNOWN_GAME_PATCHES['eschalon: book i'];
KNOWN_GAME_PATCHES['app-6910'] = KNOWN_GAME_PATCHES['deus ex'];
KNOWN_GAME_PATCHES['steam-6910'] = KNOWN_GAME_PATCHES['deus ex'];
KNOWN_GAME_PATCHES['gog-1207658995'] = KNOWN_GAME_PATCHES['deus ex'];
KNOWN_GAME_PATCHES['app-203160'] = KNOWN_GAME_PATCHES['tomb raider goty'];
KNOWN_GAME_PATCHES['steam-203160'] = KNOWN_GAME_PATCHES['tomb raider goty'];
KNOWN_GAME_PATCHES['gog-1384091612'] = KNOWN_GAME_PATCHES['summers gone season 1'];
KNOWN_GAME_PATCHES['app-433550'] = KNOWN_GAME_PATCHES['darq'];
KNOWN_GAME_PATCHES['steam-433550'] = KNOWN_GAME_PATCHES['darq'];
KNOWN_GAME_PATCHES['epic-015cbe4368dc449b961988c7434d9195'] = KNOWN_GAME_PATCHES['darq'];
KNOWN_GAME_PATCHES['epic-ee96375fac2f47de978170a24398e581'] = KNOWN_GAME_PATCHES['darq'];

export function applyCatalogPatch(game: CanonicalGame, patch: CatalogGamePatch): CanonicalGame {
  const updated: CanonicalGame = { ...game };

  if (patch.targetId) updated.id = patch.targetId;
  if (patch.title) updated.title = patch.title;
  if (patch.sortTitle) updated.sortTitle = patch.sortTitle;

  if (patch.steamAppId === null) {
    updated.steamAppId = undefined;
  } else if (patch.steamAppId !== undefined) {
    updated.steamAppId = patch.steamAppId;
  }

  if (patch.headerImage) updated.headerImage = patch.headerImage;
  if (patch.capsuleImage) updated.capsuleImage = patch.capsuleImage;

  if (patch.iconUrl) {
    updated.iconUrl = patch.preserveExistingIcon && updated.iconUrl ? updated.iconUrl : patch.iconUrl;
  }

  if (patch.shortDescription) {
    if (!updated.shortDescription || isPlaceholderDesc(updated.shortDescription, updated.title)) {
      updated.shortDescription = patch.shortDescription;
    }
  }

  if (patch.releaseDate) updated.releaseDate = patch.releaseDate;
  if (patch.developers) updated.developers = patch.developers;
  if (patch.publishers) updated.publishers = patch.publishers;
  if (patch.genres) updated.genres = patch.genres;
  if (patch.tags) updated.tags = patch.tags;

  if (patch.platformFilters) {
    if (patch.platformFilters.excludePlatformId) {
      updated.platforms = updated.platforms.filter(
        (p) => p.platformId !== patch.platformFilters!.excludePlatformId
      );
    }
    if (patch.platformFilters.setPlatformGameId) {
      const { platformId, gameId } = patch.platformFilters.setPlatformGameId;
      updated.platforms = updated.platforms.map((p) =>
        p.platformId === platformId ? { ...p, platformGameId: gameId } : p
      );
    }
  }

  return updated;
}

export function findGamePatch(
  game: CanonicalGame,
  lowerTitle?: string,
  normTitle?: string
): CatalogGamePatch | undefined {
  const currentTitleLower = lowerTitle ?? (game.title || '').toLowerCase().trim();
  const currentNorm = normTitle ?? normalizeCanonicalTitle(game.title);

  // 1. Direct key lookups
  if (KNOWN_GAME_PATCHES[currentTitleLower]) return KNOWN_GAME_PATCHES[currentTitleLower];
  if (KNOWN_GAME_PATCHES[currentNorm]) return KNOWN_GAME_PATCHES[currentNorm];
  if (game.id && KNOWN_GAME_PATCHES[game.id.toLowerCase()]) return KNOWN_GAME_PATCHES[game.id.toLowerCase()];
  if (game.steamAppId && KNOWN_GAME_PATCHES[`app-${game.steamAppId}`]) {
    return KNOWN_GAME_PATCHES[`app-${game.steamAppId}`];
  }

  // 2. Curated pattern checks
  if (
    (currentNorm === 'blood omen legacy of kain' || currentTitleLower.includes('blood omen')) &&
    !currentTitleLower.includes('2') &&
    !currentTitleLower.includes('ii')
  ) {
    return KNOWN_GAME_PATCHES['blood omen: legacy of kain'];
  }

  if (currentTitleLower.includes('60 minutes to extinction') || currentNorm.includes('60 minutes to extinction')) {
    return KNOWN_GAME_PATCHES['60 minutes to extinction'];
  }

  if (currentTitleLower.includes('champions of krynn') || currentNorm.includes('champions of krynn')) {
    return KNOWN_GAME_PATCHES['champions of krynn'];
  }

  if (currentTitleLower.includes('castlevania anniversary collection') || currentNorm.includes('castlevania anniversary collection')) {
    return KNOWN_GAME_PATCHES['castlevania anniversary collection'];
  }

  if (currentTitleLower.includes('akalabeth') || currentNorm.includes('akalabeth')) {
    return KNOWN_GAME_PATCHES['akalabeth'];
  }

  if (
    currentTitleLower.includes('broken sword') &&
    (currentTitleLower.includes('director') || currentTitleLower.includes('templar') || currentTitleLower.includes('shadow'))
  ) {
    return KNOWN_GAME_PATCHES['broken sword'];
  }

  if (
    currentTitleLower.includes('citadel remonstered') ||
    currentTitleLower.includes('cytadela') ||
    currentNorm.includes('citadel remonstered') ||
    currentNorm.includes('cytadela')
  ) {
    return KNOWN_GAME_PATCHES['citadel remonstered'];
  }

  if (currentTitleLower.includes('death stranding 2') || currentNorm.includes('death stranding 2')) {
    return KNOWN_GAME_PATCHES['death stranding 2'];
  }

  if (currentTitleLower.includes('little nightmares enhanced') || currentNorm.includes('little nightmares enhanced')) {
    return KNOWN_GAME_PATCHES['little nightmares enhanced'];
  }

  if (currentTitleLower.includes('blood of dawnwalker') || currentNorm.includes('blood of dawnwalker')) {
    return KNOWN_GAME_PATCHES['blood of dawnwalker'];
  }

  if (currentTitleLower.includes('resident evil requiem') || currentNorm.includes('resident evil requiem')) {
    return KNOWN_GAME_PATCHES['resident evil requiem'];
  }

  if (
    currentTitleLower.includes('rollercoaster tycoon') &&
    (currentTitleLower.includes('3') || currentTitleLower.includes('complete'))
  ) {
    return KNOWN_GAME_PATCHES['rollercoaster tycoon 3'];
  }

  if (
    currentTitleLower.includes('higurashi') &&
    (currentTitleLower.includes('onikakushi') || currentTitleLower.includes('ch.1') || currentTitleLower.includes('ch 1'))
  ) {
    return KNOWN_GAME_PATCHES['higurashi'];
  }

  if (currentTitleLower.includes('lure of the temptress') || currentNorm.includes('lure of the temptress')) {
    return KNOWN_GAME_PATCHES['lure of the temptress'];
  }

  if (currentTitleLower.startsWith('second extinction') || currentNorm === 'second extinction') {
    return KNOWN_GAME_PATCHES['second extinction'];
  }

  return undefined;
}

/**
 * Sanitizes the catalog:
 * 1. Renames known Epic codenames (Boga, Blobfish, Barbet, Basil, Batfish, etc.) to their official game titles and covers
 * 2. Corrects the false match where "Path of the Bogatyr" was assigned to Epic's "Boga" (Death Stranding)
 * 3. Purges raw GUIDs, Fortnite microtransaction items, invalid DLC entries, and unmapped codenames
 * 4. Deduplicates games by normalized title and Steam App ID, merging multi-storefront ownership cleanly
 */
export function sanitizeGameCatalog(catalog: CanonicalGame[]): CanonicalGame[] {
  if (!Array.isArray(catalog)) return [];

  const userOverrides = loadUserOverrides();
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
      game = applyCatalogPatch(game, KNOWN_GAME_PATCHES['death stranding']);
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
      game = applyCatalogPatch(game, KNOWN_GAME_PATCHES['doki doki literature club plus!']);
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

    // Curated game patches declarative lookup
    const patch = findGamePatch(game, currentTitleLower, normTitle);
    if (patch) {
      game = applyCatalogPatch(game, patch);
      if (game.platforms.length === 0) continue;
      normTitle = normalizeCanonicalTitle(game.title);
    }

    // Curated user override lookup (explicit user intent takes highest priority)
    const userOverride = getUserOverrideForGame(game, userOverrides);
    if (userOverride) {
      game = applyUserOverrideToGame(game, userOverride);
      normTitle = normalizeCanonicalTitle(game.title);
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
        userOverride !== undefined ||
        (gogPlatform?.platformGameId && validGogProductIds.has(gogPlatform.platformGameId.trim())) ||
        validGogTitles.has(normTitle) ||
        validGogTitles.has(normalizeCanonicalTitle(rawGame.title));

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
      const isRealEpicGame =
        userOverride !== undefined ||
        validEpicTitles.has(updatedNormTitle) ||
        validEpicTitles.has(normalizeCanonicalTitle(rawGame.title));

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
      const isRealSteamGame =
        userOverride !== undefined ||
        (appId
          ? validSteamAppIds.has(appId)
          : validSteamTitles.has(normTitle) || validSteamTitles.has(normalizeCanonicalTitle(rawGame.title)));

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

    // Look up Steam App ID for blurb / cover enrichment without altering game's canonical identity
    const matchedAppIdForBlurb =
      userOverride?.steamAppId === null
        ? undefined
        : (game.steamAppId || steamMatcher.matchGameToSteamInstant(game.title));

    if (!userOverride?.shortDescription && isPlaceholderDesc(game.shortDescription, game.title)) {
      const blurb = matchedAppIdForBlurb ? (steamBlurbCache as Record<string, string>)[String(matchedAppIdForBlurb)] : null;
      const gogPlat = game.platforms.find((p) => p.platformId === 'gog');
      const gogSpecial = gogPlat?.platformGameId ? GOG_SPECIAL_DESCRIPTIONS[gogPlat.platformGameId]?.lead : null;

      if (blurb && !isPlaceholderDesc(blurb, game.title)) {
        game = { ...game, shortDescription: blurb };
      } else if (gogSpecial && !isPlaceholderDesc(gogSpecial, game.title)) {
        game = { ...game, shortDescription: gogSpecial };
      } else {
        game = { ...game, shortDescription: '' };
      }
    }

    // Systemic resolution of GOG official vertical covers from verified enriched cache
    const gogPlat = game.platforms.find((p) => p.platformId === 'gog');
    if (!userOverride?.capsuleImage && gogPlat && gogPlat.platformGameId) {
      const enrichedGog = (gogEnrichedCache as Record<string, any>)[gogPlat.platformGameId];
      if (enrichedGog?.coverVertical) {
        const hHash = enrichedGog.coverHorizontal ? enrichedGog.coverHorizontal.match(/\/([a-f0-9]{64})/i)?.[1] : null;
        if (
          !game.capsuleImage ||
          (hHash && game.capsuleImage.includes(hHash)) ||
          game.capsuleImage.includes('_glx_vertical_cover') ||
          isUnsuitableCoverUrl(game.capsuleImage)
        ) {
          game = {
            ...game,
            capsuleImage: enrichedGog.coverVertical,
            iconUrl: game.iconUrl || enrichedGog.coverVertical,
          };
        }
      }
    }

    // Attach verified IGDB portrait cover if game is curated in KNOWN_IGDB_COVERS, lacks vertical art, has unsuitable/cropped covers, or known dead Steam art
    const instantIgdbCover = igdbCoverService.getIgdbCoverInstant(game.title, game.steamAppId || matchedAppIdForBlurb || undefined, game.id);
    if (!userOverride?.capsuleImage && instantIgdbCover) {
      const isCuratedIgdb = Boolean(
        KNOWN_IGDB_COVERS[game.title.toLowerCase().trim()] ||
        KNOWN_IGDB_COVERS[normalizeCanonicalTitle(game.title)] ||
        (game.id && KNOWN_IGDB_COVERS[game.id.toLowerCase().trim()])
      );
      if (
        isCuratedIgdb ||
        !game.capsuleImage ||
        isKnownDeadSteamCover(game.steamAppId) ||
        isUnsuitableCoverUrl(game.capsuleImage) ||
        game.capsuleImage.includes('231x87') ||
        game.capsuleImage.includes('616x353')
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
          if (igdb && (isKnownDeadSteamCover(existing.steamAppId) || isKnownDeadSteamCover(game.steamAppId) || isUnsuitableCoverUrl(existing.capsuleImage) || isUnsuitableCoverUrl(game.capsuleImage))) {
            return igdb;
          }
          if (
            game.capsuleImage &&
            (!existing.capsuleImage ||
              existing.capsuleImage.includes('egs-badge.png') ||
              existing.capsuleImage.includes('1225270') ||
              existing.capsuleImage.includes('231x87') ||
              isKnownDeadSteamCover(existing.steamAppId) ||
              isUnsuitableCoverUrl(existing.capsuleImage))
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

      const existingOv = getUserOverrideForGame(existing, userOverrides);
      const effectiveOv = userOverride || existingOv;
      if (effectiveOv) {
        cleaned[existingIndex] = applyUserOverrideToGame(cleaned[existingIndex], effectiveOv);
      }

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

  const finalCatalog = applyUserOverridesToCatalog(cleaned, userOverrides);
  return finalCatalog.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}
