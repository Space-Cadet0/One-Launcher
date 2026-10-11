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
  'the blood of dawnwalker': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co7mva.jpg',
  'dawnwalker': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co7mva.jpg',

  // Little Nightmares Enhanced Edition
  'little nightmares enhanced edition': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/424840/library_600x900_2x.jpg',

  // Wildgate
  'wildgate': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co9kqs.jpg',
};

function normalizeKey(str: string): string {
  return str
    .toLowerCase()
    .replace(/[™®©]/g, '')
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
