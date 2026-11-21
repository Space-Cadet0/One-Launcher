import type { CanonicalGame, GamePlatformOwnership } from '../../../contracts/game';
import type {
  DownloadTaskState,
  GameLaunchConfig,
  InstalledGameRecord,
  StorefrontLaunchProfile,
} from '../../../contracts/launcher';
import type { StorefrontId } from '../../../contracts/platform';
import { sanitizeGameInstallSizeBytes } from '../../../utils/formatBytes';
import { normalizeTitleKey } from '../../common/titleUtils';
import {
  loadSelectedStorefrontsFromStorage,
  reconcileLaunchConfigsWithDisk,
} from '../launchConfigStore';
import {
  buildGameInstalledEventDetailFromRecord,
  dispatchGameInstalledEvent,
  isBottleFilesystemPath,
  isWindowsExecutablePath,
} from './launcherEventHelpers';

const INIT_CONFIG_FRESH_WINDOW_MS = 10_000;

interface InstalledLookupIndex {
  byPlatGameKey: Map<string, InstalledGameRecord>;
  bySteamAppId: Map<number, InstalledGameRecord>;
  byPlatInstallPath: Map<string, InstalledGameRecord>;
  byPlatExePath: Map<string, InstalledGameRecord>;
  byPlatNormTitle: Map<string, InstalledGameRecord>;
}

function normalizeTitleForMatch(title?: string): string {
  if (!title) return '';
  return normalizeTitleKey(title);
}

function normalizeLookupPlatGameId(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/^(?:gog[_-]|epic[_-]|steam[_-]|xbox[_-]|custom[_-])/i, '')
    .toLowerCase();
}

function normalizeLookupPath(raw: string): string {
  return raw.trim().replace(/[\\/]+$/, '');
}

function mergePlatformWithInstalledRecord(
  platform: GamePlatformOwnership,
  rec: InstalledGameRecord,
  isWindowsHost: boolean
): GamePlatformOwnership {
  return {
    ...platform,
    installed: true,
    installPath: rec.installPath || platform.installPath,
    executablePath: rec.executablePath || platform.executablePath,
    launchArguments: rec.launchArguments || platform.launchArguments,
    xboxProductId: platform.xboxProductId,
    packageFamilyName: rec.packageFamilyName || platform.packageFamilyName,
    appUserModelId: rec.appUserModelId || platform.appUserModelId,
    xboxTitleId: rec.xboxTitleId || platform.xboxTitleId,
    scid: rec.scid || platform.scid,
    msaAppId: rec.msaAppId || platform.msaAppId,
    ...(rec.isCrossPlatformLauncherRuntime !== undefined ||
    platform.isCrossPlatformLauncherRuntime !== undefined
      ? {
          isCrossPlatformLauncherRuntime:
            rec.isCrossPlatformLauncherRuntime ?? platform.isCrossPlatformLauncherRuntime,
        }
      : {}),
    ...(rec.externalStorefrontHandoff || platform.externalStorefrontHandoff
      ? {
          externalStorefrontHandoff: (rec.externalStorefrontHandoff ||
            platform.externalStorefrontHandoff) as GamePlatformOwnership['externalStorefrontHandoff'],
        }
      : {}),
    ...(rec.chainedLauncherHandoff || platform.chainedLauncherHandoff
      ? {
          chainedLauncherHandoff: rec.chainedLauncherHandoff || platform.chainedLauncherHandoff,
        }
      : {}),
    ...(rec.chainedExternalInstallId || platform.chainedExternalInstallId
      ? {
          chainedExternalInstallId:
            rec.chainedExternalInstallId || platform.chainedExternalInstallId,
        }
      : {}),
    isWindowsBinaryOnMac: isWindowsHost
      ? false
      : (rec.isWindowsBinaryOnMac ?? platform.isWindowsBinaryOnMac),
  };
}

function buildCustomExecutableRecord(
  game: CanonicalGame,
  resolvedPlatId: StorefrontId,
  targetPlat: GamePlatformOwnership | undefined,
  platforms: GamePlatformOwnership[],
  profile: Pick<
    StorefrontLaunchProfile,
    'customExecutablePath' | 'workingDirectory' | 'launchArguments'
  >,
  isWindowsHost: boolean
): InstalledGameRecord {
  const customExe = profile.customExecutablePath!;
  return {
    platformId: resolvedPlatId,
    platformGameId: String(
      targetPlat?.platformGameId ||
        targetPlat?.storefrontAppId ||
        platforms[0]?.platformGameId ||
        game.id
    ),
    packageFamilyName: targetPlat?.packageFamilyName,
    appUserModelId: targetPlat?.appUserModelId,
    xboxTitleId: targetPlat?.xboxTitleId,
    title: game.title,
    installPath: profile.workingDirectory || customExe,
    executablePath: customExe,
    launchArguments: profile.launchArguments || targetPlat?.launchArguments,
    runner: 'custom',
    isWindowsBinaryOnMac: !isWindowsHost && isWindowsExecutablePath(customExe),
  };
}

export interface InstalledGamesRegistryContext {
  isWindowsHost: () => boolean;
  isInitialized: () => boolean;
  getLaunchConfigsMap: () => Record<string, GameLaunchConfig>;
  setLaunchConfigsMap: (next: Record<string, GameLaunchConfig>) => void;
  persistLocalConfigs: () => void;
  getLastConfigsFetchedAt: () => number;
  setLastConfigsFetchedAt: (ts: number) => void;
  getLaunchConfig: (gameId: string, platformId?: StorefrontId) => GameLaunchConfig | undefined;
  saveLaunchConfig: (config: GameLaunchConfig, platformId?: StorefrontId) => Promise<void>;
  getInstalledRecordForGame: (
    game: CanonicalGame,
    preferredPlatformId?: StorefrontId
  ) => InstalledGameRecord | undefined;
  getEffectivePlatformForGame: (
    game: CanonicalGame,
    preferredPlatformId?: StorefrontId
  ) => GamePlatformOwnership | undefined;
  getDownloadQueue: () => DownloadTaskState[];
  setDownloadQueue: (queue: DownloadTaskState[]) => void;
  getActiveDownload: (gameId: string, platformId?: StorefrontId) => DownloadTaskState | undefined;
  reconcileActiveDownloads: (records: InstalledGameRecord[]) => void;
  deleteCachedInstallInfoEntry: (key: string) => void;
  ensureActiveDownloadPolling: () => void;
  notifyStateChanged: () => void;
}

export class InstalledGamesRegistry {
  private installedRecords: InstalledGameRecord[] = [];
  private installedIndexMutationSeq = 0;
  private installedIndexBuiltSeq = -1;
  private installedIndexRecordsRef: InstalledGameRecord[] | null = null;
  private installedIndexRecordsLen = -1;
  private installedLookupIndex: InstalledLookupIndex = {
    byPlatGameKey: new Map(),
    bySteamAppId: new Map(),
    byPlatInstallPath: new Map(),
    byPlatExePath: new Map(),
    byPlatNormTitle: new Map(),
  };
  private epicPlatformSupportMap: Record<string, { windows: boolean; mac: boolean }> = {};
  private inFlightScanPromise: Promise<InstalledGameRecord[]> | null = null;
  private lastScanTimestamp = 0;
  private lastScanSucceeded = false;

  public getRecords(): InstalledGameRecord[] {
    return this.installedRecords;
  }

  public setRecords(records: InstalledGameRecord[]): void {
    this.installedRecords = records;
    this.installedIndexMutationSeq++;
  }

  public getEpicPlatformSupport(): Record<string, { windows: boolean; mac: boolean }> {
    return { ...this.epicPlatformSupportMap };
  }

  public hasAuthoritativeInstallScan(): boolean {
    return this.lastScanSucceeded;
  }

  public getInFlightScanPromise(): Promise<InstalledGameRecord[]> | null {
    return this.inFlightScanPromise;
  }

  public getLastScanTimestamp(): number {
    return this.lastScanTimestamp;
  }

  public setLastScanTimestamp(ts: number): void {
    this.lastScanTimestamp = ts;
  }

  public resetScanState(): void {
    this.inFlightScanPromise = null;
    this.lastScanTimestamp = 0;
    this.lastScanSucceeded = false;
  }

  public attachEpicPlatformSupportMetadata(
    records: InstalledGameRecord[]
  ): InstalledGameRecord[] {
    if (Object.keys(this.epicPlatformSupportMap).length > 0) {
      Object.defineProperty(records, 'epicPlatformSupport', {
        value: this.epicPlatformSupportMap,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    return records;
  }

  public upsertInstalledRecord(
    newRecord: InstalledGameRecord,
    matchHint?: {
      rawPlatformGameId?: string;
      packageFamilyName?: string;
      normalizedSteamAppId?: number;
    }
  ): void {
    const existingIdx = this.installedRecords.findIndex(
      (r) =>
        r.platformId === newRecord.platformId &&
        (String(r.platformGameId).toLowerCase() ===
          String(newRecord.platformGameId).toLowerCase() ||
          Boolean(
            matchHint?.rawPlatformGameId &&
              String(r.platformGameId).toLowerCase() ===
                String(matchHint.rawPlatformGameId).toLowerCase()
          ) ||
          Boolean(
            matchHint?.packageFamilyName &&
              r.packageFamilyName &&
              r.packageFamilyName.toLowerCase() === matchHint.packageFamilyName.toLowerCase()
          ) ||
          (matchHint?.normalizedSteamAppId !== undefined &&
            Number(r.appId) === matchHint.normalizedSteamAppId))
    );
    if (existingIdx >= 0) {
      this.installedRecords[existingIdx] = { ...this.installedRecords[existingIdx], ...newRecord };
    } else {
      this.installedRecords.push(newRecord);
    }
    this.installedIndexMutationSeq++;
  }

  public removeInstalledRecords(predicate: (rec: InstalledGameRecord) => boolean): void {
    this.installedRecords = this.attachEpicPlatformSupportMetadata(
      this.installedRecords.filter((r) => !predicate(r))
    );
    this.installedIndexMutationSeq++;
  }

  private ensureInstalledLookupIndex(): InstalledLookupIndex {
    if (
      this.installedIndexRecordsRef === this.installedRecords &&
      this.installedIndexRecordsLen === this.installedRecords.length &&
      this.installedIndexBuiltSeq === this.installedIndexMutationSeq
    ) {
      return this.installedLookupIndex;
    }

    const byPlatGameKey = new Map<string, InstalledGameRecord>();
    const bySteamAppId = new Map<number, InstalledGameRecord>();
    const byPlatInstallPath = new Map<string, InstalledGameRecord>();
    const byPlatExePath = new Map<string, InstalledGameRecord>();
    const byPlatNormTitle = new Map<string, InstalledGameRecord>();

    for (const r of this.installedRecords) {
      if (!r) continue;
      if (r.platformGameId !== undefined && r.platformGameId !== null && r.platformGameId !== '') {
        const key = `${r.platformId}:${String(r.platformGameId)}`;
        if (!byPlatGameKey.has(key)) byPlatGameKey.set(key, r);
        const normId = normalizeLookupPlatGameId(r.platformGameId);
        if (normId) {
          const normKey = `${r.platformId}:${normId}`;
          if (!byPlatGameKey.has(normKey)) byPlatGameKey.set(normKey, r);
        }
      }
      if (r.packageFamilyName) {
        const pfnKey = `${r.platformId}:${String(r.packageFamilyName)}`;
        if (!byPlatGameKey.has(pfnKey)) byPlatGameKey.set(pfnKey, r);
        const normPfn = String(r.packageFamilyName).trim().toLowerCase();
        if (normPfn && !byPlatGameKey.has(`${r.platformId}:${normPfn}`)) {
          byPlatGameKey.set(`${r.platformId}:${normPfn}`, r);
        }
      }
      if (r.xboxProductId) {
        const prodKey = `${r.platformId}:${String(r.xboxProductId)}`;
        if (!byPlatGameKey.has(prodKey)) byPlatGameKey.set(prodKey, r);
        const normProd = normalizeLookupPlatGameId(r.xboxProductId);
        if (normProd && !byPlatGameKey.has(`${r.platformId}:${normProd}`)) {
          byPlatGameKey.set(`${r.platformId}:${normProd}`, r);
        }
      }
      if (r.xboxTitleId) {
        const titleIdKey = `${r.platformId}:${String(r.xboxTitleId).trim().toLowerCase()}`;
        if (!byPlatGameKey.has(titleIdKey)) byPlatGameKey.set(titleIdKey, r);
      }
      if (r.platformId === 'steam') {
        const appIdNum = Number(r.appId || normalizeLookupPlatGameId(r.platformGameId));
        if (Number.isFinite(appIdNum) && appIdNum > 0 && !bySteamAppId.has(appIdNum)) {
          bySteamAppId.set(appIdNum, r);
        }
      }
      if (r.installPath) {
        const key = `${r.platformId}:${r.installPath}`;
        if (!byPlatInstallPath.has(key)) byPlatInstallPath.set(key, r);
        const trimmedKey = `${r.platformId}:${normalizeLookupPath(r.installPath)}`;
        if (!byPlatInstallPath.has(trimmedKey)) byPlatInstallPath.set(trimmedKey, r);
      }
      if (r.executablePath) {
        const key = `${r.platformId}:${r.executablePath}`;
        if (!byPlatExePath.has(key)) byPlatExePath.set(key, r);
      }
      if (r.title) {
        const norm = normalizeTitleForMatch(r.title);
        if (norm) {
          const key = `${r.platformId}:${norm}`;
          if (!byPlatNormTitle.has(key)) byPlatNormTitle.set(key, r);
        }
      }
    }

    this.installedLookupIndex = {
      byPlatGameKey,
      bySteamAppId,
      byPlatInstallPath,
      byPlatExePath,
      byPlatNormTitle,
    };
    this.installedIndexRecordsRef = this.installedRecords;
    this.installedIndexRecordsLen = this.installedRecords.length;
    this.installedIndexBuiltSeq = this.installedIndexMutationSeq;
    return this.installedLookupIndex;
  }

  public async scanAllInstalledGames(
    forceRefresh: boolean,
    options: { silentInitialBoot?: boolean } | undefined,
    ctx: InstalledGamesRegistryContext
  ): Promise<InstalledGameRecord[]> {
    if (this.inFlightScanPromise) {
      return this.inFlightScanPromise;
    }

    if (
      !forceRefresh &&
      this.lastScanTimestamp > 0 &&
      Date.now() - this.lastScanTimestamp < 1500 &&
      this.installedRecords.length > 0
    ) {
      return this.installedRecords;
    }

    if (typeof window !== 'undefined' && window.electronAPI?.scanAllInstalledGames) {
      this.inFlightScanPromise = (async () => {
        try {
          const prevRecords = [...this.installedRecords];
          const res = await window.electronAPI!.scanAllInstalledGames();
          if (res && res.success !== false && Array.isArray(res.installedGames)) {
            this.lastScanSucceeded = true;
            const isWin = ctx.isWindowsHost();
            if (res.epicPlatformSupport && typeof res.epicPlatformSupport === 'object') {
              this.epicPlatformSupportMap = { ...res.epicPlatformSupport };
            }
            this.installedRecords = this.attachEpicPlatformSupportMetadata(
              res.installedGames.map((r) => {
                const sanitizedInstallSize = sanitizeGameInstallSizeBytes(r.installSize);
                const nextRec: InstalledGameRecord = {
                  ...r,
                  ...(isWin ? { isWindowsBinaryOnMac: false } : {}),
                };
                if (sanitizedInstallSize !== undefined) {
                  nextRec.installSize = sanitizedInstallSize;
                } else {
                  delete nextRec.installSize;
                }
                return nextRec;
              })
            );
            this.installedIndexMutationSeq++;
            this.lastScanTimestamp = Date.now();

            const currentConfigs = ctx.getLaunchConfigsMap();
            const hasAnyCustomExe = Object.values(currentConfigs).some(
              (c) =>
                Boolean(c?.customExecutablePath) ||
                (c?.platformConfigs &&
                  Object.values(c.platformConfigs).some((p) => Boolean(p?.customExecutablePath)))
            );
            const lastFetched = ctx.getLastConfigsFetchedAt();
            const configsFreshFromInit =
              Boolean(options?.silentInitialBoot) ||
              (lastFetched > 0 && Date.now() - lastFetched < INIT_CONFIG_FRESH_WINDOW_MS);
            if (
              !configsFreshFromInit &&
              typeof window !== 'undefined' &&
              typeof window.electronAPI?.getGameLaunchConfigs === 'function' &&
              hasAnyCustomExe
            ) {
              try {
                const freshConfigs = (await window.electronAPI.getGameLaunchConfigs()) as Record<
                  string,
                  GameLaunchConfig
                >;
                ctx.setLastConfigsFetchedAt(Date.now());
                if (freshConfigs && typeof freshConfigs === 'object') {
                  const reconciled = reconcileLaunchConfigsWithDisk(
                    ctx.getLaunchConfigsMap(),
                    freshConfigs,
                    false
                  );
                  if (reconciled.changed) {
                    ctx.setLaunchConfigsMap(reconciled.configs);
                    ctx.persistLocalConfigs();
                  }
                }
              } catch {}
            }

            // 1. Reconcile any active downloads whose game is now detected as installed on disk
            ctx.reconcileActiveDownloads(this.installedRecords);

            // 2. Dispatch antigravity:game-installed for any newly discovered installation
            // (Skip individual cold-boot event storm when App.tsx batch-reconciles initial scan)
            if (!options?.silentInitialBoot) {
              const queue = ctx.getDownloadQueue();
              for (const rec of this.installedRecords) {
                const prevRec = prevRecords.find(
                  (p) =>
                    p.platformId === rec.platformId &&
                    String(p.platformGameId).toLowerCase() ===
                      String(rec.platformGameId).toLowerCase()
                );
                const gainedXboxIdentityOrExe =
                  rec.platformId === 'xbox' &&
                  Boolean(
                    prevRec &&
                      ((rec.executablePath && rec.executablePath !== prevRec.executablePath) ||
                        (rec.packageFamilyName &&
                          rec.packageFamilyName !== prevRec.packageFamilyName) ||
                        (rec.appUserModelId && rec.appUserModelId !== prevRec.appUserModelId) ||
                        (rec.xboxTitleId && rec.xboxTitleId !== prevRec.xboxTitleId) ||
                        (rec.scid && rec.scid !== prevRec.scid) ||
                        (rec.msaAppId && rec.msaAppId !== prevRec.msaAppId) ||
                        (rec.xboxProductId && rec.xboxProductId !== prevRec.xboxProductId))
                  );
                if (!prevRec || gainedXboxIdentityOrExe) {
                  const matchingTask = queue.find(
                    (t) =>
                      t.platformId === rec.platformId &&
                      (String(t.platformGameId).toLowerCase() ===
                        String(rec.platformGameId).toLowerCase() ||
                        Boolean(
                          rec.xboxProductId &&
                            String(t.platformGameId).toLowerCase() ===
                              String(rec.xboxProductId).toLowerCase()
                        ))
                  );
                  dispatchGameInstalledEvent(
                    buildGameInstalledEventDetailFromRecord(
                      matchingTask?.gameId || `${rec.platformId}-${rec.platformGameId}`,
                      rec,
                      true
                    )
                  );
                }
              }
            }

            ctx.ensureActiveDownloadPolling();
            ctx.notifyStateChanged();
            return this.installedRecords;
          }
        } catch (err) {
          console.warn('[LauncherService] scanAllInstalledGames failed:', err);
        } finally {
          this.inFlightScanPromise = null;
        }
        return this.installedRecords;
      })();
      return this.inFlightScanPromise;
    }
    return this.installedRecords;
  }

  public getInstalledRecordForGame(
    game: CanonicalGame,
    preferredPlatformId: StorefrontId | undefined,
    ctx: InstalledGamesRegistryContext
  ): InstalledGameRecord | undefined {
    if (!game) return undefined;
    const platforms = Array.isArray(game.platforms)
      ? game.platforms.filter((p): p is GamePlatformOwnership =>
          Boolean(p && typeof p === 'object' && p.platformId)
        )
      : [];

    const idx = this.ensureInstalledLookupIndex();
    const cfg = ctx.getLaunchConfig(game.id);
    const normGameTitle = game.title ? normalizeTitleForMatch(game.title) : '';
    const isWin = ctx.isWindowsHost();

    // 1. O(1) indexed helper to check matching platform records in installedRecords
    const matchPlatformRecord = (p: GamePlatformOwnership): InstalledGameRecord | undefined => {
      const pGameId = String(p.platformGameId || p.storefrontAppId || '');
      if (pGameId) {
        const byPlatKey =
          idx.byPlatGameKey.get(`${p.platformId}:${pGameId}`) ||
          idx.byPlatGameKey.get(`${p.platformId}:${normalizeLookupPlatGameId(pGameId)}`);
        if (byPlatKey) return byPlatKey;
      }
      if (p.xboxProductId) {
        const byProdKey =
          idx.byPlatGameKey.get(`${p.platformId}:${p.xboxProductId}`) ||
          idx.byPlatGameKey.get(`${p.platformId}:${normalizeLookupPlatGameId(p.xboxProductId)}`);
        if (byProdKey) return byProdKey;
      }
      if (p.packageFamilyName) {
        const byPfnKey =
          idx.byPlatGameKey.get(`${p.platformId}:${p.packageFamilyName}`) ||
          idx.byPlatGameKey.get(`${p.platformId}:${p.packageFamilyName.trim().toLowerCase()}`);
        if (byPfnKey) return byPfnKey;
      }
      if (p.storefrontAppId) {
        const normStoreId = normalizeLookupPlatGameId(p.storefrontAppId);
        if (normStoreId) {
          const byStoreKey = idx.byPlatGameKey.get(`${p.platformId}:${normStoreId}`);
          if (byStoreKey) return byStoreKey;
        }
      }
      if (p.platformId === 'steam' && game.steamAppId) {
        const bySteamApp = idx.bySteamAppId.get(Number(game.steamAppId));
        if (bySteamApp) return bySteamApp;
      }

      if (p.installPath) {
        const trimmedPath = normalizeLookupPath(p.installPath);
        const byInstall =
          idx.byPlatInstallPath.get(`${p.platformId}:${p.installPath}`) ||
          idx.byPlatInstallPath.get(`${p.platformId}:${trimmedPath}`);
        if (byInstall) return byInstall;
      }
      if (p.executablePath) {
        const byExe = idx.byPlatExePath.get(`${p.platformId}:${p.executablePath}`);
        if (byExe) return byExe;
      }
      if (normGameTitle) {
        const byTitle = idx.byPlatNormTitle.get(`${p.platformId}:${normGameTitle}`);
        if (byTitle) return byTitle;
      }

      if (
        !ctx.isInitialized() &&
        !this.lastScanSucceeded &&
        p.installed &&
        (p.installPath || p.executablePath)
      ) {
        const isWinPath = Boolean(
          isWindowsExecutablePath(p.executablePath) ||
            isBottleFilesystemPath(p.executablePath || p.installPath)
        );
        const isMacPath = Boolean(
          (p.executablePath && !isWindowsExecutablePath(p.executablePath)) ||
            (p.installPath && /\.app(\/|$)/i.test(p.installPath))
        );
        const inferredWinOnMac = isWin
          ? false
          : p.isWindowsBinaryOnMac !== undefined
            ? p.isWindowsBinaryOnMac
            : isWinPath
              ? true
              : isMacPath
                ? false
                : undefined;
        return {
          platformId: p.platformId,
          platformGameId: p.platformGameId,
          appId: p.platformId === 'steam' ? game.steamAppId || Number(p.platformGameId) : undefined,
          packageFamilyName: p.packageFamilyName,
          appUserModelId: p.appUserModelId,
          xboxTitleId: p.xboxTitleId,
          title: game.title,
          installPath: p.installPath || '',
          executablePath: p.executablePath,
          launchArguments: p.launchArguments,
          installSize: sanitizeGameInstallSizeBytes(p.installSize),
          version: p.version,
          isWindowsBinaryOnMac: inferredWinOnMac,
        };
      }
      return undefined;
    };

    // When preferredPlatformId is explicitly provided, strictly scope to that storefront
    if (preferredPlatformId) {
      const targetPlat = platforms.find((p) => p.platformId === preferredPlatformId);
      if (targetPlat) {
        const matched = matchPlatformRecord(targetPlat);
        if (matched) return matched;
      }

      if (preferredPlatformId === 'steam' && game.steamAppId) {
        const bySteamId = idx.bySteamAppId.get(Number(game.steamAppId));
        if (bySteamId) return bySteamId;
      }

      const platCfg = ctx.getLaunchConfig(game.id, preferredPlatformId);
      if (platCfg?.customExecutablePath) {
        return buildCustomExecutableRecord(
          game,
          preferredPlatformId,
          targetPlat,
          platforms,
          platCfg,
          isWin
        );
      }

      return undefined;
    }

    const targetPlatformId = cfg?.preferredPlatformId;
    if (targetPlatformId) {
      const targetPlat = platforms.find((p) => p.platformId === targetPlatformId);
      if (targetPlat) {
        const matched = matchPlatformRecord(targetPlat);
        if (matched) return matched;
      }
    }

    for (const p of platforms) {
      const matched = matchPlatformRecord(p);
      if (matched) return matched;
    }

    // 2. Fallback check by steamAppId
    if (game.steamAppId) {
      const bySteamId = idx.bySteamAppId.get(Number(game.steamAppId));
      if (bySteamId) return bySteamId;
    }

    // 3. Fallback check by customExecutablePath in LaunchConfig or platformConfigs
    if (cfg?.customExecutablePath) {
      const resolvedPlatId = targetPlatformId || platforms[0]?.platformId || 'custom';
      const targetPlat = platforms.find((p) => p.platformId === resolvedPlatId);
      return buildCustomExecutableRecord(
        game,
        resolvedPlatId,
        targetPlat,
        platforms,
        cfg,
        isWin
      );
    }

    if (cfg?.platformConfigs) {
      for (const [platId, platProfile] of Object.entries(cfg.platformConfigs)) {
        if (platProfile?.customExecutablePath) {
          const resolvedPlatId = platId as StorefrontId;
          const targetPlat = platforms.find((p) => p.platformId === resolvedPlatId);
          return buildCustomExecutableRecord(
            game,
            resolvedPlatId,
            targetPlat,
            platforms,
            platProfile,
            isWin
          );
        }
      }
    }

    return undefined;
  }

  public getEffectivePlatformForGame(
    game: CanonicalGame,
    preferredPlatformId: StorefrontId | undefined,
    ctx: InstalledGamesRegistryContext
  ): GamePlatformOwnership | undefined {
    if (!game || !Array.isArray(game.platforms) || game.platforms.length === 0) {
      return undefined;
    }

    const cfg = ctx.getLaunchConfig(game.id);
    const rememberedId = !preferredPlatformId
      ? loadSelectedStorefrontsFromStorage()[game.id]
      : undefined;
    const validRememberedId =
      rememberedId && game.platforms.some((p) => p.platformId === rememberedId)
        ? rememberedId
        : undefined;
    const explicitOrRememberedId = preferredPlatformId || validRememberedId;
    const targetId = explicitOrRememberedId || cfg?.preferredPlatformId;
    const isWin = ctx.isWindowsHost();
    let fallbackPreferredUninstalled: GamePlatformOwnership | undefined;

    if (targetId) {
      const found = game.platforms.find((p) => p.platformId === targetId);
      if (found) {
        const rec = ctx.getInstalledRecordForGame(game, targetId);
        if (rec) {
          return mergePlatformWithInstalledRecord(found, rec, isWin);
        }
        const targetPlatCfg = ctx.getLaunchConfig(game.id, targetId);
        const isTargetInstalled = Boolean(found.installed || targetPlatCfg?.customExecutablePath);
        if (explicitOrRememberedId || isTargetInstalled) {
          return found;
        }
        fallbackPreferredUninstalled = found;
      }
    }

    // Prefer an installed platform
    const installedRecord = ctx.getInstalledRecordForGame(game);
    if (installedRecord) {
      const matchingPlat = game.platforms.find(
        (p) => p.platformId === installedRecord.platformId
      );
      if (matchingPlat) {
        return mergePlatformWithInstalledRecord(matchingPlat, installedRecord, isWin);
      }
    }

    const installedPlat = game.platforms.find((p) => p.installed);
    if (installedPlat) return installedPlat;

    if (fallbackPreferredUninstalled) return fallbackPreferredUninstalled;

    return game.platforms[0];
  }

  public isGameInstalled(
    game: CanonicalGame,
    platformId: StorefrontId | undefined,
    ctx: InstalledGamesRegistryContext
  ): boolean {
    if (!game) return false;
    const platforms = Array.isArray(game.platforms)
      ? game.platforms.filter((p): p is GamePlatformOwnership =>
          Boolean(p && typeof p === 'object' && p.platformId)
        )
      : [];

    if (platformId) {
      const platCfg = ctx.getLaunchConfig(game.id, platformId);
      if (platCfg?.customExecutablePath) {
        return true;
      }
      if (ctx.getInstalledRecordForGame(game, platformId)) return true;
      const plat = platforms.find((p) => p.platformId === platformId);
      return Boolean(plat?.installed);
    }

    const cfg = ctx.getLaunchConfig(game.id);
    if (cfg?.customExecutablePath) return true;
    if (
      cfg?.platformConfigs &&
      Object.values(cfg.platformConfigs).some((p) => Boolean(p?.customExecutablePath))
    ) {
      return true;
    }
    if (platforms.some((p) => p.installed)) return true;
    return Boolean(ctx.getInstalledRecordForGame(game));
  }

  public setManualInstallStatus(
    game: CanonicalGame,
    installed: boolean,
    platformId: StorefrontId | undefined,
    ctx: InstalledGamesRegistryContext
  ): void {
    if (!game) return;

    const effPlatform = ctx.getEffectivePlatformForGame(game, platformId);
    const resolvedPlatformId: StorefrontId =
      platformId || effPlatform?.platformId || (game.steamAppId ? 'steam' : 'custom');
    const resolvedPlatformGameId =
      effPlatform?.platformGameId || (game.steamAppId ? String(game.steamAppId) : game.id);

    if (installed) {
      const activeTask = ctx.getActiveDownload(game.id, resolvedPlatformId);
      if (activeTask) {
        if (typeof window !== 'undefined' && window.electronAPI?.cancelDownload) {
          window.electronAPI.cancelDownload(activeTask.taskId).catch(() => {});
        }
        ctx.setDownloadQueue(
          ctx.getDownloadQueue().map((t) =>
            t.gameId === game.id &&
            (!t.platformId || t.platformId === resolvedPlatformId) &&
            (t.status === 'queued' ||
              t.status === 'downloading' ||
              t.status === 'extracting' ||
              t.status === 'verifying' ||
              t.status === 'paused')
              ? {
                  ...t,
                  status: 'completed',
                  progressPercent: 100,
                  bytesDownloaded: t.totalBytes,
                  speedBytesPerSec: 0,
                  etaSeconds: 0,
                  completedAt: new Date().toISOString(),
                  statusMessage: 'Marked as installed',
                }
              : t
          )
        );
      }

      const existingIdx = this.installedRecords.findIndex(
        (r) =>
          r.platformId === resolvedPlatformId &&
          String(r.platformGameId) === String(resolvedPlatformGameId)
      );
      const sanitizedManualSize = sanitizeGameInstallSizeBytes(
        effPlatform?.installSize ??
          (existingIdx >= 0 ? this.installedRecords[existingIdx]?.installSize : undefined)
      );
      const record: InstalledGameRecord = {
        platformId: resolvedPlatformId,
        platformGameId: String(resolvedPlatformGameId),
        appId:
          resolvedPlatformId === 'steam'
            ? game.steamAppId || Number(resolvedPlatformGameId) || undefined
            : undefined,
        packageFamilyName: effPlatform?.packageFamilyName,
        appUserModelId: effPlatform?.appUserModelId,
        xboxTitleId: effPlatform?.xboxTitleId,
        scid: effPlatform?.scid,
        msaAppId: effPlatform?.msaAppId,
        title: game.title,
        installPath: effPlatform?.installPath || '',
        executablePath: effPlatform?.executablePath,
        ...(sanitizedManualSize !== undefined ? { installSize: sanitizedManualSize } : {}),
        runner: 'custom',
      };
      if (existingIdx >= 0) {
        const mergedRecord: InstalledGameRecord = {
          ...this.installedRecords[existingIdx],
          ...record,
        };
        if (sanitizedManualSize === undefined) {
          delete mergedRecord.installSize;
        }
        this.installedRecords[existingIdx] = mergedRecord;
      } else {
        this.installedRecords.push(record);
      }
      this.installedIndexMutationSeq++;
    } else {
      ctx.deleteCachedInstallInfoEntry(`${game.id}:${resolvedPlatformId}`);
      const cfg = ctx.getLaunchConfig(game.id, resolvedPlatformId);
      if (cfg?.customExecutablePath) {
        const { customExecutablePath: _ce, workingDirectory: _wd, ...rest } = cfg;
        void ctx.saveLaunchConfig(
          {
            ...rest,
            gameId: game.id,
            preferredPlatformId: resolvedPlatformId,
            launchMethod: rest.launchMethod || 'auto',
          },
          resolvedPlatformId
        );
      }
      this.removeInstalledRecords(
        (r) =>
          (r.platformId === resolvedPlatformId &&
            (String(r.platformGameId) === String(resolvedPlatformGameId) ||
              Boolean(
                effPlatform?.xboxProductId &&
                  String(r.platformGameId) === String(effPlatform.xboxProductId)
              ) ||
              Boolean(
                effPlatform?.packageFamilyName &&
                  r.packageFamilyName === effPlatform.packageFamilyName
              ))) ||
          Boolean(
            resolvedPlatformId === 'steam' &&
              game.steamAppId &&
              Number(r.appId || r.platformGameId) === Number(game.steamAppId)
          )
      );
    }

    dispatchGameInstalledEvent({
      gameId: game.id,
      platformId: resolvedPlatformId,
      platformGameId: resolvedPlatformGameId,
      installed,
    });

    ctx.ensureActiveDownloadPolling();
    ctx.notifyStateChanged();
  }
}
