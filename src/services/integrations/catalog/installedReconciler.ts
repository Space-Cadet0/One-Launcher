import { CanonicalGame, GamePlatformOwnership } from '../../../contracts/game';
import type { InstalledGameRecord } from '../../../contracts/launcher';
import { StorefrontId } from '../../../contracts/platform';
import { sanitizeGameInstallSizeBytes } from '../../../utils/formatBytes';

export function normalizePlatformGameIdForLookup(raw?: string | number | null): string {
  if (raw === undefined || raw === null) return '';
  return String(raw)
    .trim()
    .replace(/^(?:gog[_-]|epic[_-]|steam[_-]|xbox[_-]|custom[_-])/i, '')
    .toLowerCase();
}

export function normalizeInstallPathForLookup(raw?: string | null): string {
  if (!raw) return '';
  return String(raw).trim().replace(/[\\/]+$/, '').toLowerCase();
}

export function hasLocalInstallMetadata(p: GamePlatformOwnership): boolean {
  return Boolean(
    p.installed ||
      (typeof p.installPath === 'string' && p.installPath.trim().length > 0) ||
      (typeof p.executablePath === 'string' && p.executablePath.trim().length > 0)
  );
}

export function deleteOrphanedGamesFromOfflineVault(gameIds: string[]): void {
  if (!Array.isArray(gameIds) || gameIds.length === 0) return;
  if (typeof window !== 'undefined' && window.electronAPI?.offlineVault?.deleteGames) {
    try {
      void window.electronAPI.offlineVault.deleteGames(gameIds)?.catch?.(() => {});
    } catch {
      // Ignore offlineVault IPC bridge errors
    }
  }
}

export function collectXboxOrphanVaultIdVariants(
  p: GamePlatformOwnership,
  survivingIdSet: ReadonlySet<string>,
  targetSet: Set<string>
): void {
  const rawPid = String(p.platformGameId || '').trim();
  const normPid = normalizePlatformGameIdForLookup(p.platformGameId);
  const rawXboxProductId = String(p.xboxProductId || '').trim();
  const normXboxProductId = normalizePlatformGameIdForLookup(p.xboxProductId);
  const candidates: string[] = [];
  if (rawPid) candidates.push(`xbox-${rawPid}`);
  if (normPid) {
    candidates.push(`xbox-${normPid}`, `xbox-${normPid.toUpperCase()}`);
  }
  if (rawXboxProductId) candidates.push(`xbox-${rawXboxProductId}`);
  if (normXboxProductId) {
    candidates.push(`xbox-${normXboxProductId}`, `xbox-${normXboxProductId.toUpperCase()}`);
  }
  for (const cand of candidates) {
    if (cand && !survivingIdSet.has(cand)) {
      targetSet.add(cand);
    }
  }
}

export function collectDroppedAndSelfHealedCatalogDelta(
  sourceGames: CanonicalGame[],
  survivingGames: CanonicalGame[],
  extraVaultIds?: Iterable<string> | null
): { droppedVaultIds: string[]; platformOrVersionHealed: boolean } {
  const survivingById = new Map<string, CanonicalGame>();
  const survivingIdSet = new Set<string>();
  for (const mg of survivingGames) {
    if (mg?.id) {
      survivingById.set(mg.id, mg);
      survivingIdSet.add(mg.id);
    }
  }

  const droppedSet = new Set<string>();
  let platformOrVersionHealed = survivingGames.length !== sourceGames.length;

  for (const sg of sourceGames) {
    if (!sg) continue;
    const survivingGame = sg.id ? survivingById.get(sg.id) : undefined;
    if (!survivingGame) {
      if (sg.id && !survivingIdSet.has(sg.id)) {
        droppedSet.add(sg.id);
      }
      for (const p of sg.platforms || []) {
        if (!p) continue;
        if (p.platformId === 'xbox') {
          collectXboxOrphanVaultIdVariants(p, survivingIdSet, droppedSet);
        } else if (p.platformId && p.platformGameId) {
          const fallbackStoreRowId = `${p.platformId}-${String(p.platformGameId).trim()}`;
          if (!survivingIdSet.has(fallbackStoreRowId)) {
            droppedSet.add(fallbackStoreRowId);
          }
        }
      }
    } else if (Array.isArray(sg.platforms)) {
      const survivingPlats = Array.isArray(survivingGame.platforms) ? survivingGame.platforms : [];
      if (survivingPlats.length !== sg.platforms.length) {
        platformOrVersionHealed = true;
      }
      for (const p of sg.platforms) {
        if (!p) continue;
        const matchedSurviving = survivingPlats.find((sp) => sp.platformId === p.platformId);
        if (!matchedSurviving) {
          platformOrVersionHealed = true;
          if (p.platformId === 'xbox') {
            collectXboxOrphanVaultIdVariants(p, survivingIdSet, droppedSet);
          }
        } else if (
          !hasLocalInstallMetadata(p) &&
          p.version !== undefined &&
          matchedSurviving.version === undefined
        ) {
          platformOrVersionHealed = true;
        }
      }
    }
  }

  if (extraVaultIds) {
    for (const snapId of extraVaultIds) {
      if (snapId && !survivingIdSet.has(snapId)) {
        droppedSet.add(snapId);
      }
    }
  }

  return {
    droppedVaultIds: Array.from(droppedSet),
    platformOrVersionHealed,
  };
}

export function preserveLocalInstallFieldsAcrossSanitize(
  sourceGames: CanonicalGame[],
  sanitizedGames: CanonicalGame[]
): CanonicalGame[] {
  const hasInvalidSanitizedSize = Array.isArray(sanitizedGames)
    ? sanitizedGames.some((g) =>
        g?.platforms?.some(
          (p) =>
            p?.installSize !== undefined &&
            sanitizeGameInstallSizeBytes(p.installSize) === undefined
        )
      )
    : false;

  if (!Array.isArray(sourceGames) || sourceGames.length === 0) {
    if (!hasInvalidSanitizedSize) return sanitizedGames;
  }

  let anySourceHasLocal = false;
  if (Array.isArray(sourceGames)) {
    for (let i = 0; i < sourceGames.length && !anySourceHasLocal; i++) {
      const plats = sourceGames[i]?.platforms;
      if (Array.isArray(plats)) {
        for (let j = 0; j < plats.length; j++) {
          if (plats[j] && hasLocalInstallMetadata(plats[j])) {
            anySourceHasLocal = true;
            break;
          }
        }
      }
    }
  }
  if (!anySourceHasLocal && !hasInvalidSanitizedSize) return sanitizedGames;

  const byKey = new Map<string, GamePlatformOwnership>();
  const registerPlat = (key: string, p: GamePlatformOwnership) => {
    if (!key) return;
    const sanitizedPSize = p.installed ? sanitizeGameInstallSizeBytes(p.installSize) : undefined;
    const normalizedP: GamePlatformOwnership = { ...p };
    if (sanitizedPSize !== undefined) {
      normalizedP.installSize = sanitizedPSize;
    } else {
      delete normalizedP.installSize;
    }
    const prev = byKey.get(key);
    if (!prev || (!prev.installed && normalizedP.installed)) {
      byKey.set(key, normalizedP);
    } else if (prev) {
      const mergedInstalled = Boolean(prev.installed || normalizedP.installed);
      const mergedSize = mergedInstalled
        ? ((prev.installed ? sanitizeGameInstallSizeBytes(prev.installSize) : undefined) ??
          sanitizedPSize)
        : undefined;
      const mergedEntry: GamePlatformOwnership = {
        ...prev,
        installed: mergedInstalled,
        installPath: prev.installPath || normalizedP.installPath,
        executablePath: prev.executablePath || normalizedP.executablePath,
        version: prev.version || normalizedP.version,
        launchArguments: prev.launchArguments || normalizedP.launchArguments,
        isWindowsBinaryOnMac: prev.isWindowsBinaryOnMac ?? normalizedP.isWindowsBinaryOnMac,
      };
      if (mergedSize !== undefined) {
        mergedEntry.installSize = mergedSize;
      } else {
        delete mergedEntry.installSize;
      }
      byKey.set(key, mergedEntry);
    }
  };

  if (anySourceHasLocal) {
    for (const g of sourceGames) {
      if (!g || !Array.isArray(g.platforms)) continue;
      for (const p of g.platforms) {
        if (!p || !hasLocalInstallMetadata(p)) continue;
        const normId = normalizePlatformGameIdForLookup(p.platformGameId);
        const normStoreId = normalizePlatformGameIdForLookup(p.storefrontAppId);
        if (normId) registerPlat(`${p.platformId}:${normId}`, p);
        if (normStoreId && normStoreId !== normId) {
          registerPlat(`${p.platformId}:${normStoreId}`, p);
        }
        if (p.platformId === 'xbox') {
          const normXboxId = normalizePlatformGameIdForLookup(p.xboxProductId);
          const normPfn = String(p.packageFamilyName || '').trim().toLowerCase();
          if (normXboxId) registerPlat(`xbox:${normXboxId}`, p);
          if (normPfn) registerPlat(`xbox:${normPfn}`, p);
        }
        if (p.platformId === 'steam' && g.steamAppId) {
          registerPlat(`steam:${g.steamAppId}`, p);
        }
      }
    }
  }

  let catalogChanged = false;
  const restored = sanitizedGames.map((g) => {
    if (!g || !Array.isArray(g.platforms)) return g;
    let gameChanged = false;
    const nextPlatforms = g.platforms.map((p) => {
      const normId = normalizePlatformGameIdForLookup(p.platformGameId);
      const normStoreId = normalizePlatformGameIdForLookup(p.storefrontAppId);
      const normXboxId =
        p.platformId === 'xbox' ? normalizePlatformGameIdForLookup(p.xboxProductId) : '';
      const normPfn =
        p.platformId === 'xbox' ? String(p.packageFamilyName || '').trim().toLowerCase() : '';
      const saved =
        (normId ? byKey.get(`${p.platformId}:${normId}`) : undefined) ||
        (normStoreId ? byKey.get(`${p.platformId}:${normStoreId}`) : undefined) ||
        (normXboxId ? byKey.get(`xbox:${normXboxId}`) : undefined) ||
        (normPfn ? byKey.get(`xbox:${normPfn}`) : undefined) ||
        (p.platformId === 'steam' && g.steamAppId ? byKey.get(`steam:${g.steamAppId}`) : undefined);

      const sanitizedCurrentSize = p.installed
        ? sanitizeGameInstallSizeBytes(p.installSize)
        : undefined;

      if (!saved) {
        if (p.installSize === sanitizedCurrentSize) {
          return p;
        }
        gameChanged = true;
        const cleanedPlat: GamePlatformOwnership = { ...p };
        if (sanitizedCurrentSize !== undefined) {
          cleanedPlat.installSize = sanitizedCurrentSize;
        } else {
          delete cleanedPlat.installSize;
        }
        return cleanedPlat;
      }

      const nextInstalled = Boolean(p.installed || saved.installed);
      const nextInstallPath = p.installPath || saved.installPath;
      const nextExePath = p.executablePath || saved.executablePath;
      const hasNextPhysicalInstall = Boolean(
        nextInstalled ||
          (typeof nextInstallPath === 'string' && nextInstallPath.trim().length > 0) ||
          (typeof nextExePath === 'string' && nextExePath.trim().length > 0)
      );
      const nextInstallSize = nextInstalled
        ? (sanitizeGameInstallSizeBytes(p.installSize) ??
          (saved.installed ? sanitizeGameInstallSizeBytes(saved.installSize) : undefined))
        : undefined;
      const nextVersion = hasNextPhysicalInstall ? p.version || saved.version : undefined;
      const nextLaunchArgs = p.launchArguments || saved.launchArguments;
      const nextWinOnMac = hasNextPhysicalInstall
        ? (p.isWindowsBinaryOnMac ?? saved.isWindowsBinaryOnMac)
        : undefined;

      if (
        Boolean(p.installed) === nextInstalled &&
        p.installPath === nextInstallPath &&
        p.executablePath === nextExePath &&
        p.installSize === nextInstallSize &&
        p.version === nextVersion &&
        p.launchArguments === nextLaunchArgs &&
        p.isWindowsBinaryOnMac === nextWinOnMac
      ) {
        return p;
      }

      gameChanged = true;
      const restoredPlat: GamePlatformOwnership = {
        ...p,
        installed: nextInstalled,
        ...(nextInstallPath !== undefined ? { installPath: nextInstallPath } : {}),
        ...(nextExePath !== undefined ? { executablePath: nextExePath } : {}),
        ...(nextVersion !== undefined ? { version: nextVersion } : {}),
        ...(nextLaunchArgs !== undefined ? { launchArguments: nextLaunchArgs } : {}),
        ...(nextWinOnMac !== undefined ? { isWindowsBinaryOnMac: nextWinOnMac } : {}),
      };
      if (nextInstallSize !== undefined) {
        restoredPlat.installSize = nextInstallSize;
      } else {
        delete restoredPlat.installSize;
      }
      return restoredPlat;
    });

    if (!gameChanged) return g;
    catalogChanged = true;
    return { ...g, platforms: nextPlatforms };
  });

  return catalogChanged ? restored : sanitizedGames;
}

export interface ReconcileCatalogInstalledOptions {
  authoritativeRemoval?: boolean;
  installedSteamAppIds?: Set<number> | null;
  getHasCustomExe?: (gameId: string, platformId: StorefrontId) => boolean;
}

export function reconcileCatalogGamesWithInstalledRecords(
  games: CanonicalGame[],
  installedRecords: InstalledGameRecord[],
  options?: ReconcileCatalogInstalledOptions
): CanonicalGame[] {
  if (!Array.isArray(games) || games.length === 0) return games;

  const authoritativeRemoval = Boolean(options?.authoritativeRemoval);
  const installedSteamAppIds = options?.installedSteamAppIds ?? null;
  const getHasCustomExe = options?.getHasCustomExe;

  const byPlatNormId = new Map<string, InstalledGameRecord>();
  const bySteamAppId = new Map<number, InstalledGameRecord>();
  const byPlatInstallPath = new Map<string, InstalledGameRecord>();

  if (Array.isArray(installedRecords)) {
    for (const r of installedRecords) {
      if (!r || !r.platformId) continue;
      const rawId = String(r.platformGameId ?? '').trim().toLowerCase();
      const normId = normalizePlatformGameIdForLookup(r.platformGameId);
      if (rawId) {
        const rawKey = `${r.platformId}:${rawId}`;
        if (!byPlatNormId.has(rawKey)) byPlatNormId.set(rawKey, r);
      }
      if (normId) {
        const normKey = `${r.platformId}:${normId}`;
        if (!byPlatNormId.has(normKey)) byPlatNormId.set(normKey, r);
      }
      if (r.platformId === 'xbox') {
        const rXboxBigId = normalizePlatformGameIdForLookup(
          (r as InstalledGameRecord & { xboxProductId?: string }).xboxProductId
        );
        const rPfn = String(r.packageFamilyName || '').trim().toLowerCase();
        const rTitleId = normalizePlatformGameIdForLookup(r.xboxTitleId);
        if (rXboxBigId && !byPlatNormId.has(`xbox:${rXboxBigId}`)) {
          byPlatNormId.set(`xbox:${rXboxBigId}`, r);
        }
        if (rPfn && !byPlatNormId.has(`xbox:${rPfn}`)) {
          byPlatNormId.set(`xbox:${rPfn}`, r);
        }
        if (rTitleId && !byPlatNormId.has(`xbox:${rTitleId}`)) {
          byPlatNormId.set(`xbox:${rTitleId}`, r);
        }
      }
      if (r.platformId === 'steam') {
        const appIdNum = Number(r.appId || normId);
        if (Number.isFinite(appIdNum) && appIdNum > 0 && !bySteamAppId.has(appIdNum)) {
          bySteamAppId.set(appIdNum, r);
        }
      }
      const normPath = normalizeInstallPathForLookup(r.installPath);
      if (normPath) {
        const pathKey = `${r.platformId}:${normPath}`;
        if (!byPlatInstallPath.has(pathKey)) byPlatInstallPath.set(pathKey, r);
      }
    }
  }

  let anyCatalogChanged = false;
  const nextGames = games.map((game) => {
    if (!game || !Array.isArray(game.platforms) || game.platforms.length === 0) return game;
    const targetAppId = game.steamAppId;
    let gameChanged = false;

    const nextPlatforms = game.platforms.map((p) => {
      const rawPId = String(p.platformGameId ?? '').trim().toLowerCase();
      const normPId = normalizePlatformGameIdForLookup(p.platformGameId);
      const normStoreAppId = normalizePlatformGameIdForLookup(p.storefrontAppId);
      const normXboxBigId =
        p.platformId === 'xbox' ? normalizePlatformGameIdForLookup(p.xboxProductId) : '';
      const normXboxPfn =
        p.platformId === 'xbox' ? String(p.packageFamilyName || '').trim().toLowerCase() : '';
      const normXboxTitleId =
        p.platformId === 'xbox' ? normalizePlatformGameIdForLookup(p.xboxTitleId) : '';
      const normInstallPath = normalizeInstallPathForLookup(p.installPath);

      const matchedRecord =
        (rawPId ? byPlatNormId.get(`${p.platformId}:${rawPId}`) : undefined) ||
        (normPId ? byPlatNormId.get(`${p.platformId}:${normPId}`) : undefined) ||
        (normStoreAppId ? byPlatNormId.get(`${p.platformId}:${normStoreAppId}`) : undefined) ||
        (normXboxBigId ? byPlatNormId.get(`xbox:${normXboxBigId}`) : undefined) ||
        (normXboxPfn ? byPlatNormId.get(`xbox:${normXboxPfn}`) : undefined) ||
        (normXboxTitleId ? byPlatNormId.get(`xbox:${normXboxTitleId}`) : undefined) ||
        (p.platformId === 'steam' && targetAppId ? bySteamAppId.get(Number(targetAppId)) : undefined) ||
        (normInstallPath ? byPlatInstallPath.get(`${p.platformId}:${normInstallPath}`) : undefined);

      if (matchedRecord) {
        const nextInstallPath = matchedRecord.installPath || p.installPath;
        const nextExePath = matchedRecord.executablePath || p.executablePath;
        const nextLaunchArgs = matchedRecord.launchArguments || p.launchArguments;
        const scannedInstallSize = sanitizeGameInstallSizeBytes(matchedRecord.installSize);
        const catalogInstallSize = sanitizeGameInstallSizeBytes(p.installSize);
        const isSuspiciousTinyScannedSize =
          scannedInstallSize !== undefined &&
          catalogInstallSize !== undefined &&
          catalogInstallSize >= 50 * 1024 * 1024 &&
          scannedInstallSize < Math.min(10 * 1024 * 1024, catalogInstallSize * 0.05);
        const nextInstallSize = isSuspiciousTinyScannedSize
          ? catalogInstallSize
          : (scannedInstallSize ?? catalogInstallSize);
        const nextVersion = matchedRecord.version || p.version;
        const nextWinOnMac = matchedRecord.isWindowsBinaryOnMac ?? p.isWindowsBinaryOnMac;
        const nextPfn = matchedRecord.packageFamilyName || p.packageFamilyName;
        const nextAumid = matchedRecord.appUserModelId || p.appUserModelId;
        const nextXboxTitleId = matchedRecord.xboxTitleId || p.xboxTitleId;
        const nextScid = matchedRecord.scid || p.scid;
        const nextMsaAppId = matchedRecord.msaAppId || p.msaAppId;

        if (
          p.installed === true &&
          p.installPath === nextInstallPath &&
          p.executablePath === nextExePath &&
          p.launchArguments === nextLaunchArgs &&
          p.installSize === nextInstallSize &&
          p.version === nextVersion &&
          p.isWindowsBinaryOnMac === nextWinOnMac &&
          p.packageFamilyName === nextPfn &&
          p.appUserModelId === nextAumid &&
          p.xboxTitleId === nextXboxTitleId &&
          p.scid === nextScid &&
          p.msaAppId === nextMsaAppId
        ) {
          return p;
        }

        gameChanged = true;
        const updatedP: GamePlatformOwnership = {
          ...p,
          installed: true,
          installPath: nextInstallPath,
          executablePath: nextExePath,
          version: nextVersion,
          isWindowsBinaryOnMac: nextWinOnMac,
          ...(nextPfn !== undefined ? { packageFamilyName: nextPfn } : {}),
          ...(nextAumid !== undefined ? { appUserModelId: nextAumid } : {}),
          ...(nextXboxTitleId !== undefined ? { xboxTitleId: nextXboxTitleId } : {}),
          ...(nextScid !== undefined ? { scid: nextScid } : {}),
          ...(nextMsaAppId !== undefined ? { msaAppId: nextMsaAppId } : {}),
        };
        if (nextInstallSize !== undefined) {
          updatedP.installSize = nextInstallSize;
        } else {
          delete updatedP.installSize;
        }
        if (nextLaunchArgs !== undefined) {
          updatedP.launchArguments = nextLaunchArgs;
        }
        return updatedP;
      }

      if (!authoritativeRemoval) {
        return p;
      }

      const hasCustomExe = Boolean(getHasCustomExe?.(game.id, p.platformId));
      const shouldBeInstalled =
        p.platformId === 'steam' && installedSteamAppIds
          ? Boolean(targetAppId && installedSteamAppIds.has(Number(targetAppId))) || hasCustomExe
          : hasCustomExe;

      const runtimeDriveDisconnected = (
        p as GamePlatformOwnership & { driveDisconnected?: boolean }
      ).driveDisconnected;

      if (
        Boolean(p.installed) === shouldBeInstalled &&
        (shouldBeInstalled ||
          (!p.installPath &&
            !p.executablePath &&
            !p.launchArguments &&
            !p.version &&
            runtimeDriveDisconnected === undefined &&
            p.isWindowsBinaryOnMac === undefined &&
            p.installSize === undefined))
      ) {
        return p;
      }

      gameChanged = true;
      const updatedP: GamePlatformOwnership = {
        ...p,
        installed: shouldBeInstalled,
      };
      if (!shouldBeInstalled) {
        delete updatedP.installPath;
        delete updatedP.executablePath;
        delete updatedP.launchArguments;
        delete updatedP.version;
        delete (updatedP as GamePlatformOwnership & { driveDisconnected?: boolean })
          .driveDisconnected;
        delete updatedP.isWindowsBinaryOnMac;
        delete updatedP.installSize;
      }
      return updatedP;
    });

    if (!gameChanged) return game;
    anyCatalogChanged = true;
    return { ...game, platforms: nextPlatforms };
  });

  return anyCatalogChanged ? nextGames : games;
}
