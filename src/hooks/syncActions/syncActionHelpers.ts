import type { CanonicalGame } from '../../contracts/game';
import {
  loadIntegrations,
  loadXboxProfileState,
  saveIntegrations,
  formatXboxIntegrationStatusMessage,
} from '../../services/integrations/integrationStorage';
import type { StorefrontIntegration } from '../../contracts/integration';

export function isVitestRuntime(): boolean {
  if (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'test') {
    return true;
  }
  return typeof process !== 'undefined' && Boolean(process.env?.VITEST);
}

export function getSyncErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
  }
  return fallback;
}

export interface CatalogDiffIds {
  dirtyGameIds: Set<string>;
  removedGameIds: Set<string>;
}

/**
 * Computes incremental dirty & removed game IDs between two catalog snapshots
 * so `saveCurrentCatalog` avoids rewriting unchanged SQLite vault rows.
 */
export function computeCatalogDiffIds(
  previousCatalog: readonly CanonicalGame[],
  nextCatalog: readonly CanonicalGame[]
): CatalogDiffIds {
  const prevById = new Map<string, CanonicalGame>();
  for (const game of previousCatalog) {
    if (game?.id) prevById.set(game.id, game);
  }

  const nextIds = new Set<string>();
  const dirtyGameIds = new Set<string>();
  for (const game of nextCatalog) {
    if (!game?.id) continue;
    nextIds.add(game.id);
    const prev = prevById.get(game.id);
    if (!prev || prev !== game) {
      dirtyGameIds.add(game.id);
    }
  }

  const removedGameIds = new Set<string>();
  for (const prevId of prevById.keys()) {
    if (!nextIds.has(prevId)) {
      removedGameIds.add(prevId);
    }
  }

  return { dirtyGameIds, removedGameIds };
}

export interface StorefrontCatalogCounts {
  steamCount: number;
  gogCount: number;
  epicCount: number;
  xboxCount: number;
  updatedIntegrations: StorefrontIntegration[];
}

export function refreshConnectedIntegrationCounts(
  finalCatalog: readonly CanonicalGame[]
): StorefrontCatalogCounts {
  let steamCount = 0;
  let gogCount = 0;
  let epicCount = 0;
  let xboxCount = 0;

  for (const game of finalCatalog) {
    const platforms = game.platforms;
    if (!platforms) continue;
    let hasSteam = false;
    let hasGog = false;
    let hasEpic = false;
    let hasXbox = false;
    for (const p of platforms) {
      if (p.platformId === 'steam') hasSteam = true;
      else if (p.platformId === 'gog') hasGog = true;
      else if (p.platformId === 'epic') hasEpic = true;
      else if (p.platformId === 'xbox') hasXbox = true;
    }
    if (hasSteam) steamCount++;
    if (hasGog) gogCount++;
    if (hasEpic) epicCount++;
    if (hasXbox) xboxCount++;
  }

  const refreshedXboxProfile = loadXboxProfileState();
  const nowIso = new Date().toISOString();
  const latestIntegrations = loadIntegrations();
  const updatedIntegrations = latestIntegrations.map((item) => {
    if (!item.isConnected) return item;
    if (item.storefrontId === 'xbox') {
      const resolvedXboxName =
        refreshedXboxProfile?.modernGamertag ||
        refreshedXboxProfile?.gamertag ||
        item.accountName ||
        'Xbox Live User';
      return {
        ...item,
        accountName: resolvedXboxName,
        avatarUrl: refreshedXboxProfile?.avatarUrl || item.avatarUrl,
        gamesCount: xboxCount,
        lastSyncedAt: nowIso,
        statusMessage: formatXboxIntegrationStatusMessage(
          resolvedXboxName,
          xboxCount,
          refreshedXboxProfile?.subscription
        ),
      };
    }
    let count = item.gamesCount;
    if (item.storefrontId === 'steam') count = steamCount;
    else if (item.storefrontId === 'gog') count = gogCount;
    else if (item.storefrontId === 'epic') count = epicCount;
    return {
      ...item,
      gamesCount: count,
      lastSyncedAt: nowIso,
      statusMessage: `Connected as ${item.accountName || 'User'} (${count} ${item.name} titles synced)`,
    };
  });

  saveIntegrations(updatedIntegrations);

  return { steamCount, gogCount, epicCount, xboxCount, updatedIntegrations };
}
