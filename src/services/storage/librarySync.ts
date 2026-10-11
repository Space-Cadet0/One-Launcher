import { CanonicalGame } from '../../contracts/game';
import { FULL_USER_STEAM_GAMES } from './fullUserSteamGames';
import { USER_SCANNED_STEAM_GAMES } from './userScannedLibrary';
import { reconcileAchievementSummaries } from './achievementReconciliation';

export function mergeScannedSteamGames(existingGames: CanonicalGame[]): CanonicalGame[] {
  const merged = [...existingGames];

  // Merge full local Steam library of 251 games
  const allSteamGames = [...USER_SCANNED_STEAM_GAMES, ...FULL_USER_STEAM_GAMES];

  for (const scanned of allSteamGames) {
    const existingIndex = merged.findIndex(
      (g) =>
        (g.steamAppId && scanned.steamAppId && g.steamAppId === scanned.steamAppId) ||
        g.title.toLowerCase().trim() === scanned.title.toLowerCase().trim()
    );

    const scannedSteam = scanned.platforms.find((p) => p.platformId === 'steam');

    if (existingIndex >= 0) {
      const existing = merged[existingIndex];
      let hasSteam = false;

      const updatedPlatforms = existing.platforms.map((p) => {
        if (p.platformId === 'steam') {
          hasSteam = true;
          if (scannedSteam) {
            return {
              ...p,
              playtimeMinutes: Math.max(p.playtimeMinutes || 0, scannedSteam.playtimeMinutes || 0),
              lastPlayed: scannedSteam.lastPlayed || p.lastPlayed,
              installed: p.installed || scannedSteam.installed,
              achievements: reconcileAchievementSummaries(
                p.achievements,
                scannedSteam.achievements,
                { title: scanned.title, appId: scanned.steamAppId, store: 'steam' }
              ),
            };
          }
        }
        return p;
      });

      if (!hasSteam && scannedSteam) {
        updatedPlatforms.push(scannedSteam);
      }

      merged[existingIndex] = {
        ...existing,
        steamAppId: existing.steamAppId || scanned.steamAppId,
        platforms: updatedPlatforms,
        headerImage: (existing.headerImage && !existing.headerImage.includes('egs-badge.png')) ? existing.headerImage : scanned.headerImage,
        capsuleImage: (existing.capsuleImage && !existing.capsuleImage.includes('egs-badge.png')) ? existing.capsuleImage : scanned.capsuleImage,
        iconUrl: (existing.iconUrl && !existing.iconUrl.includes('egs-badge.png')) ? existing.iconUrl : (scanned.iconUrl || scanned.capsuleImage || scanned.headerImage),
        shortDescription: existing.shortDescription || scanned.shortDescription,
        reviewSummary: existing.reviewSummary || scanned.reviewSummary,
        tags: existing.tags && existing.tags.length > 0 ? existing.tags : scanned.tags,
      };
    } else {
      merged.push(scanned);
    }
  }

  // Sort alphabetically by canonical title
  return merged.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}
