/**
 * IGDB Cover Art Service
 * Provides instantaneous resolution and dynamic fallback to high-resolution
 * portrait covers hosted on images.igdb.com.
 */

const STORAGE_KEY_IGDB_COVERS = 'antigravity_igdb_covers';

// Steam App IDs verified to not host standard unhashed library_600x900 assets on Steam CDN
export const KNOWN_DEAD_STEAM_COVER_APP_IDS = new Set<number>([
  1904620, // Champions of Krynn
  1904621, // Death Knights of Krynn
  1904622, // The Dark Queen of Krynn
  1018010, // Castlevania Anniversary Collection
  3783210, // 60 Minutes to Extinction: Escape Room
  3751260, // The Blood of Dawnwalker
  2149010, // Little Nightmares Enhanced Edition
  2700,    // RollerCoaster Tycoon 3: Platinum (delisted, active is 1368820)
  3286930, // Heretic + Hexen (uses hashed library_capsule.jpg)
  3764200, // Resident Evil Requiem (uses hashed library_capsule.jpg)
  3280350, // Death Stranding 2: On The Beach (uses hashed library_capsule.jpg)
  235900,  // RPG Maker XP (no unhashed library_600x900)
]);

export function isKnownDeadSteamCover(appId?: number | null): boolean {
  if (!appId) return false;
  return KNOWN_DEAD_STEAM_COVER_APP_IDS.has(appId);
}

// Curated dictionary of verified official IGDB portrait covers (2:3 / 3:4 aspect ratio)
export const KNOWN_IGDB_COVERS: Record<string, string> = {
  // Champions of Krynn & Krynn series
  'champions of krynn': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co5xot.webp',
  'death knights of krynn': 'https://images.igdb.com/igdb/image/upload/t_cover_big/jwamgwjf5mei3uyxazwc.jpg',
  'the dark queen of krynn': 'https://images.igdb.com/igdb/image/upload/t_cover_big/hvbou7fij6enuysl0zyp.jpg',

  // Castlevania Anniversary Collection
  'castlevania anniversary collection': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co24a1.jpg',

  // 60 Minutes to Extinction
  '60 minutes to extinction escape room': 'https://images.igdb.com/igdb/image/upload/t_cover_big/coak2y.jpg',
  '60 minutes to extinction: escape room': 'https://images.igdb.com/igdb/image/upload/t_cover_big/coak2y.jpg',

  // Another World
  'another world 20th anniversary edition': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1x7k.jpg',
  'another world: 20th anniversary edition': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1x7k.jpg',
  'another world': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1x7k.jpg',

  // Ascendant
  'ascendant': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2kdv.jpg',

  // Betrayer
  'betrayer': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2h9l.jpg',

  // Bio Menace
  'bio menace': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1og1.jpg',
  'biomenace': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1og1.jpg',

  // Blood Omen: Legacy of Kain
  'blood omen legacy of kain': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2jds.jpg',
  'blood omen: legacy of kain': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2jds.jpg',

  // The Blood of Dawnwalker / Dawnwalker
  'the blood of dawnwalker': 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3751260/82769ab631e6e68b4a38bbba9fb5b74eb0d7db8d/library_capsule.jpg',
  'dawnwalker': 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3751260/82769ab631e6e68b4a38bbba9fb5b74eb0d7db8d/library_capsule.jpg',

  // Little Nightmares Enhanced Edition
  'little nightmares enhanced edition': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/424840/library_600x900_2x.jpg',

  // Akalabeth: World of Doom
  'akalabeth world of doom': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co26ea.jpg',
  'akalabeth: world of doom': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co26ea.jpg',
  'akalabeth': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co26ea.jpg',

  // Broken Sword: Director's Cut
  'broken sword directors cut': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',
  'broken sword: directors cut': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',
  'broken sword: director\'s cut': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',
  'broken sword the shadow of the templars the directors cut': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',
  'broken sword: the shadow of the templars – the director\'s cut': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',
  'broken sword shadow of the templars': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',

  // Citadel Remonstered / Cytadela
  'citadel remonstered': 'https://upload.wikimedia.org/wikipedia/en/6/63/Cytadela_cover.jpg',
  'citadel: remonstered': 'https://upload.wikimedia.org/wikipedia/en/6/63/Cytadela_cover.jpg',
  'cytadela': 'https://upload.wikimedia.org/wikipedia/en/6/63/Cytadela_cover.jpg',

  // DOOM + DOOM II
  'doom + doom ii': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2280/library_600x900_2x.jpg',
  'doom + doom 2': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2280/library_600x900_2x.jpg',

  // Retro & GOG Classics
  'daggerfall unity - gog cut': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1vup.jpg',
  'daggerfall unity': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1vup.jpg',
  'syndicate plus': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2fz3.jpg',
  'syndicate wars': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2kt9.jpg',
  'tyrian 2000': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2zg1.jpg',
  'flight of the amazon queen': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2i9b.jpg',
  'lure of the temptress': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1npy.jpg',
  'doomdark\'s revenge': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co6q0g.jpg',
  'doomdarks revenge': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co6q0g.jpg',
  'd&d stronghold: kingdom simulator': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co3cr6.jpg',
  'fate': 'https://images.igdb.com/igdb/image/upload/t_cover_big/cob5w5.jpg',
  'shadow warrior classic complete': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1pqn.jpg',
  'shadow warrior classic': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1pqn.jpg',

  // Wildgate
  'wildgate': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co9kqs.jpg',

  // Heretic + Hexen
  'heretic + hexen': 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3286930/dbdad6a66e6a076d138b9ce8bd81dbdf159bccb2/library_capsule.jpg',
  'heretic hexen': 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3286930/dbdad6a66e6a076d138b9ce8bd81dbdf159bccb2/library_capsule.jpg',

  // RollerCoaster Tycoon 3: Complete Edition
  'rollercoaster tycoon 3 complete edition': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1368820/library_600x900_2x.jpg',
  'rollercoaster tycoon 3: complete edition': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1368820/library_600x900_2x.jpg',
  'rollercoaster tycoon 3': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1368820/library_600x900_2x.jpg',

  // Higurashi When They Cry Hou - Ch.1 Onikakushi
  'higurashi when they cry hou ch 1 onikakushi': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/310360/library_600x900_2x.jpg',
  'higurashi when they cry hou - ch.1 onikakushi': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/310360/library_600x900_2x.jpg',
  'higurashi when they cry hou ch.1 onikakushi': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/310360/library_600x900_2x.jpg',

  // Lure of the Temptress (1992)
  'lure of the temptress (1992)': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1npy.jpg',
  'lure of the temptress 1992': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1npy.jpg',

  // Resident Evil Requiem
  'resident evil requiem': 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3764200/ed3b2cae7d15f598f41006f5f1e605ec5517b5e4/library_capsule.jpg',

  // Death Stranding 2: On The Beach
  'death stranding 2 on the beach': 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3280350/9b523fd411eeaefe80f238489745325a1cd2317f/library_capsule.jpg',
  'death stranding 2': 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3280350/9b523fd411eeaefe80f238489745325a1cd2317f/library_capsule.jpg',

  // RPG Maker XP
  'rpg maker xp': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2r75.jpg',
};

/**
 * Checks whether an image URL represents an unsuitable horizontal banner,
 * wide capsule, or broken asset that should not be displayed in a 2:3 portrait card.
 */
export function isUnsuitableCoverUrl(url?: string | null): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();

  // 1. Known horizontal banner URL dimensions / names
  if (
    lower.includes('231x87') ||
    lower.includes('467x181') ||
    lower.includes('616x353') ||
    lower.includes('header.jpg') ||
    lower.includes('mobile_slider') ||
    lower.includes('sbicon') ||
    lower.includes('avatars/default.png') ||
    lower.includes('egs-badge') ||
    lower.includes('wide') ||
    lower.includes('landscape')
  ) {
    return true;
  }

  // 2. Dead Steam App IDs returning 404
  for (const deadId of KNOWN_DEAD_STEAM_COVER_APP_IDS) {
    if (lower.includes(`apps/${deadId}/library_600x900`)) return true;
  }

  return false;
}

export function normalizeKey(str: string): string {
  return str
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/\s*\((?:19|20)\d{2}\)/g, '')
    .replace(/[:\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function computeTokenSimilarity(t1: string, t2: string): number {
  const words1 = new Set(t1.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const words2 = new Set(t2.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (words1.size === 0 || words2.size === 0) return 0;
  let intersection = 0;
  for (const w of words1) {
    if (words2.has(w)) intersection++;
  }
  return intersection / Math.max(words1.size, words2.size);
}

export class IgdbCoverService {
  private cache = new Map<string, string | null>();
  private pendingFetches = new Map<string, Promise<string | null>>();

  constructor() {
    this.loadPersistentCache();
  }

  private loadPersistentCache() {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY_IGDB_COVERS);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') {
            this.cache.set(normalizeKey(k), v);
          }
        }
      }
    } catch {
      // Ignore storage read error
    }
  }

  private savePersistentCache() {
    if (typeof window === 'undefined') return;
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.cache.entries()) {
        if (v) obj[k] = v;
      }
      localStorage.setItem(STORAGE_KEY_IGDB_COVERS, JSON.stringify(obj));
    } catch {
      // Ignore storage write error
    }
  }

  /**
   * Fast synchronous lookup against curated mappings and local storage cache.
   * Returns instant image URL or null.
   */
  getIgdbCoverInstant(title?: string, steamAppId?: number, gameId?: string): string | null {
    if (!title && !steamAppId && !gameId) return null;

    if (title) {
      const norm = normalizeKey(title);
      if (this.cache.has(norm)) {
        return this.cache.get(norm) || null;
      }
      if (KNOWN_IGDB_COVERS[norm]) {
        return KNOWN_IGDB_COVERS[norm];
      }

      // Check stripped subtitles
      const baseTitle = norm.split(' ')[0];
      if (baseTitle && KNOWN_IGDB_COVERS[baseTitle]) {
        return KNOWN_IGDB_COVERS[baseTitle];
      }
    }

    if (gameId) {
      const normId = normalizeKey(gameId);
      if (this.cache.has(normId)) {
        return this.cache.get(normId) || null;
      }
      if (KNOWN_IGDB_COVERS[normId]) {
        return KNOWN_IGDB_COVERS[normId];
      }
    }

    return null;
  }

  /**
   * Asynchronous dynamic lookup against IGDB/Lutris metadata.
   * Caches results persistently and dispatches an update event for reactive UI re-renders.
   */
  async fetchIgdbCover(title: string): Promise<string | null> {
    if (!title || !title.trim()) return null;
    const cleanRaw = title.trim();
    const norm = normalizeKey(cleanRaw);

    // Check instant cache
    const instant = this.getIgdbCoverInstant(cleanRaw);
    if (instant) return instant;

    // Deduplicate in-flight requests
    if (this.pendingFetches.has(norm)) {
      return this.pendingFetches.get(norm)!;
    }

    const fetchPromise = (async (): Promise<string | null> => {
      // 1. Try Electron native IPC if in desktop app
      if (typeof window !== 'undefined' && (window as any).electronAPI?.fetchIgdbCover) {
        try {
          const cover = await (window as any).electronAPI.fetchIgdbCover(cleanRaw);
          if (cover && typeof cover === 'string') {
            this.cache.set(norm, cover);
            this.savePersistentCache();
            this.notifyCoverUpdated(cleanRaw, cover);
            return cover;
          }
        } catch {
          // Fallback to fetch
        }
      }

      // 2. Query search endpoint via Vite proxy or direct HTTPS
      try {
        const query = cleanRaw.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
        const searchUrl =
          typeof window !== 'undefined' && window.location.hostname === 'localhost'
            ? `/api/lutris/api/games?search=${encodeURIComponent(query)}`
            : `https://lutris.net/api/games?search=${encodeURIComponent(query)}`;

        const res = await fetch(searchUrl, {
          headers: { 'User-Agent': 'OneLauncher/1.0' },
        });

        if (res.ok) {
          const data = await res.json();
          const items: any[] = data.results || [];
          if (items.length > 0) {
            let bestCover: string | null = null;
            let bestScore = -1;

            for (const item of items) {
              if (!item.coverart) continue;
              const candNorm = normalizeKey(item.name || '');
              let score = computeTokenSimilarity(norm, candNorm) * 100;
              if (candNorm === norm) score += 50;

              if (score > bestScore && score >= 50) {
                bestScore = score;
                const m = item.coverart.match(/\/([a-zA-Z0-9_-]+)\.(?:jpg|png|webp)/i);
                if (m) {
                  bestCover = `https://images.igdb.com/igdb/image/upload/t_cover_big/${m[1]}.jpg`;
                } else {
                  bestCover = item.coverart;
                }
              }
            }

            if (bestCover) {
              this.cache.set(norm, bestCover);
              this.savePersistentCache();
              this.notifyCoverUpdated(cleanRaw, bestCover);
              return bestCover;
            }
          }
        }
      } catch (err: any) {
        console.warn('Dynamic IGDB cover fetch error for', cleanRaw, err?.message);
      }

      // Mark negative cache to avoid infinite retries
      this.cache.set(norm, null);
      return null;
    })();

    this.pendingFetches.set(norm, fetchPromise);
    try {
      const res = await fetchPromise;
      return res;
    } finally {
      this.pendingFetches.delete(norm);
    }
  }

  private notifyCoverUpdated(title: string, coverUrl: string) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('antigravity:igdb-cover-updated', {
          detail: { title, coverUrl },
        })
      );
    }
  }
}

export const igdbCoverService = new IgdbCoverService();
