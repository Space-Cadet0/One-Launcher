'use strict';

const { isRejectedVideoUrl } = require('./offlineVaultService.cjs');
const { diagLog } = require('../utils/diagnosticLogger.cjs');

const MAX_P1_HYDRATION_LRU_GAMES = 40;
const RECENTLY_PLAYED_P0_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function parseLastPlayedEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Handle both epoch seconds and epoch milliseconds transparently
    return value < 1e11 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const asNum = Number(trimmed);
      if (Number.isFinite(asNum) && asNum > 0) {
        return asNum < 1e11 ? Math.floor(asNum * 1000) : Math.floor(asNum);
      }
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function isAssetAllowedForTier(role, ordinal, tier) {
  const cleanRole = String(role || 'cover').trim().toLowerCase();
  const cleanOrd = Math.max(0, Math.floor(Number(ordinal) || 0));
  const cleanTier = typeof tier === 'number' ? Math.max(0, Math.min(2, Math.floor(tier))) : 2;

  if (cleanTier >= 2) {
    // P2 (Uninstalled Library): Cover + Icon ONLY during background sync
    return (cleanRole === 'cover' || cleanRole === 'capsule' || cleanRole === 'icon') && cleanOrd === 0;
  }

  if (cleanTier === 1) {
    // P1 (Detail-Viewed / Favorited 40-game LRU): Cover + Hero/Header + Logo + Icon + Screenshots (max 4), 0 inline
    if (
      cleanRole === 'cover' ||
      cleanRole === 'capsule' ||
      cleanRole === 'header' ||
      cleanRole === 'hero' ||
      cleanRole === 'logo' ||
      cleanRole === 'icon'
    ) {
      return cleanOrd === 0;
    }
    if (
      cleanRole === 'screenshot' ||
      cleanRole === 'screenshot_thumb' ||
      cleanRole === 'screenshot_full'
    ) {
      return cleanOrd < 4;
    }
    return false;
  }

  // P0 (Installed / Pinned / Played <= 30d): Cover + Hero/Header + Logo + Icon + Screenshots (max 6) + Inline (max 8 img / max 4 poster)
  if (
    cleanRole === 'cover' ||
    cleanRole === 'capsule' ||
    cleanRole === 'header' ||
    cleanRole === 'hero' ||
    cleanRole === 'logo' ||
    cleanRole === 'icon'
  ) {
    return cleanOrd === 0;
  }
  if (
    cleanRole === 'screenshot' ||
    cleanRole === 'screenshot_thumb' ||
    cleanRole === 'screenshot_full'
  ) {
    return cleanOrd < 6;
  }
  if (cleanRole === 'inline_img') {
    return cleanOrd < 8;
  }
  if (cleanRole === 'inline_poster') {
    return cleanOrd < 4;
  }
  return false;
}

/**
 * Extracts static image URLs from enriched/HTML descriptions (`<img src="...">` and
 * `<video poster="...">` static poster frames ONLY — strictly ZERO `.mp4`/`.webm`/`.m3u8`/`.ts` videos!).
 *
 * @param {string} html
 * @returns {{ inlineImages: string[], inlinePosters: string[] }}
 */
function extractInlineStaticImagesAndPosters(html) {
  if (!html || typeof html !== 'string') {
    return { inlineImages: [], inlinePosters: [] };
  }

  const inlineImagesSet = new Set();
  const inlinePostersSet = new Set();

  const imgRegex = /<img\b[^>]*?\bsrc=["'](https?:\/\/[^"'\s>]+)["'][^>]*>/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const url = match[1].trim();
    if (url && !isRejectedVideoUrl(url)) {
      inlineImagesSet.add(url);
      if (inlineImagesSet.size >= 8) break;
    }
  }

  const videoPosterRegex = /<video\b[^>]*?\bposter=["'](https?:\/\/[^"'\s>]+)["'][^>]*>/gi;
  while ((match = videoPosterRegex.exec(html)) !== null) {
    const posterUrl = match[1].trim();
    if (posterUrl && !isRejectedVideoUrl(posterUrl)) {
      inlinePostersSet.add(posterUrl);
      if (inlinePostersSet.size >= 4) break;
    }
  }

  return {
    inlineImages: Array.from(inlineImagesSet),
    inlinePosters: Array.from(inlinePostersSet),
  };
}

class MediaHydrationEngine {
  /**
   * @param {{
   *   offlineVaultService: any,
   *   launcherEngine?: any,
   *   itemDelayMs?: number,
   *   maxConcurrency?: number,
   *   warmStartDurationMs?: number,
   *   postGameCooldownMs?: number,
   *   nowFn?: () => number,
   * }} deps
   */
  constructor(deps) {
    this.vault = deps.offlineVaultService;
    this.launcherEngine = deps.launcherEngine || null;
    this.itemDelayMs = typeof deps.itemDelayMs === 'number' ? Math.max(0, deps.itemDelayMs) : 150;
    this.maxConcurrency =
      typeof deps.maxConcurrency === 'number' ? Math.max(1, deps.maxConcurrency) : 2;
    this.warmStartDurationMs =
      typeof deps.warmStartDurationMs === 'number' ? Math.max(0, deps.warmStartDurationMs) : 60000;
    this.postGameCooldownMs =
      typeof deps.postGameCooldownMs === 'number' ? Math.max(0, deps.postGameCooldownMs) : 3000;
    this.nowFn = typeof deps.nowFn === 'function' ? deps.nowFn : () => Date.now();

    /** @type {Map<string, any>} */
    this.queuedGames = new Map();
    /** @type {Set<string>} */
    this.inFlightGameIds = new Set();
    /** @type {Set<AbortController>} */
    this.activeAbortControllers = new Set();
    /** @type {Map<string, number>} Bounded 40-game LRU of P1 detail-viewed / favorited games */
    this.p1DetailLru = new Map();

    this.activeAssetFetches = 0;
    this.completedGames = 0;
    this.totalQueuedGames = 0;
    this.activeGameId = undefined;

    this.isSuspendedInGame = false;
    this.isPausedForDownloads = false;
    this.isPausedForModal = false;
    this.isDisposed = false;
    this.warmStartUntil = this.now() + this.warmStartDurationMs;

    this.pumpTimer = null;
    this.postGameCooldownTimer = null;

    /** @type {Set<(payload: any) => void>} */
    this.progressListeners = new Set();
    /** @type {Set<(payload: any) => void>} */
    this.gameHydratedListeners = new Set();

    this.unsubSession = null;
    this.unsubDownload = null;

    if (this.vault && typeof this.vault.setHydrationEngine === 'function') {
      this.vault.setHydrationEngine(this);
    }

    this.bindLauncherEngineLifecycle();
  }

  now() {
    return Number(this.nowFn());
  }

  onHydrationProgress(listener) {
    if (typeof listener !== 'function') return () => {};
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  onGameHydrated(listener) {
    if (typeof listener !== 'function') return () => {};
    this.gameHydratedListeners.add(listener);
    return () => {
      this.gameHydratedListeners.delete(listener);
    };
  }

  emitProgress() {
    const snap = this.getProgressSnapshot();
    for (const listener of this.progressListeners) {
      try {
        listener(snap);
      } catch {}
    }
  }

  emitGameHydrated(payload) {
    for (const listener of this.gameHydratedListeners) {
      try {
        listener(payload);
      } catch {}
    }
  }

  countPendingAssets() {
    let total = 0;
    for (const entry of this.queuedGames.values()) {
      total += Array.isArray(entry.assets) ? entry.assets.length : 0;
    }
    return total + this.activeAssetFetches;
  }

  getProgressSnapshot() {
    const isHydrating =
      !this.isSuspendedInGame &&
      !this.isPausedForDownloads &&
      !this.isPausedForModal &&
      (this.activeAssetFetches > 0 || this.queuedGames.size > 0);
    return {
      isHydrating,
      isSuspendedInGame: this.isSuspendedInGame,
      completedGames: this.completedGames,
      totalGames: this.totalQueuedGames,
      pendingAssets: this.countPendingAssets(),
      ...(this.activeGameId ? { activeGameId: this.activeGameId } : {}),
    };
  }

  /**
   * Pauses background hydration pumping while interactive modals (e.g., Fix Match / Customize Media)
   * are open so modal search/thumbnail fetches get priority without aborting already in-flight items.
   *
   * @param {boolean} isBusy
   */
  setModalBusy(isBusy) {
    const nextBusy = Boolean(isBusy);
    if (nextBusy === this.isPausedForModal) {
      return { success: true, isPausedForModal: this.isPausedForModal };
    }
    this.isPausedForModal = nextBusy;
    if (nextBusy) {
      if (this.pumpTimer) {
        try {
          clearTimeout(this.pumpTimer);
        } catch {}
        this.pumpTimer = null;
      }
      this.emitProgress();
    } else if (!this.isDisposed) {
      this.emitProgress();
      if (!this.isSuspendedInGame && !this.isPausedForDownloads && this.queuedGames.size > 0) {
        this.schedulePump(200);
      }
    }
    return { success: true, isPausedForModal: this.isPausedForModal };
  }

  shouldPauseBackgroundSyncInGame() {
    if (!this.launcherEngine) return true;
    try {
      if (typeof this.launcherEngine.getLauncherPerformanceSettings === 'function') {
        const settings = this.launcherEngine.getLauncherPerformanceSettings();
        if (settings && settings.pauseBackgroundSyncInGame === false) {
          return false;
        }
      }
    } catch {}
    return true;
  }

  hasRunningGames() {
    if (!this.launcherEngine || typeof this.launcherEngine.getRunningGames !== 'function') {
      return false;
    }
    try {
      const running = this.launcherEngine.getRunningGames();
      return Array.isArray(running) && running.length > 0;
    } catch {
      return false;
    }
  }

  hasPostSessionWork() {
    if (!this.launcherEngine || typeof this.launcherEngine.hasActivePostSessionWork !== 'function') {
      return false;
    }
    try {
      return Boolean(this.launcherEngine.hasActivePostSessionWork());
    } catch {
      return false;
    }
  }

  hasActiveDownloadContention() {
    if (!this.launcherEngine || typeof this.launcherEngine.getDownloadQueue !== 'function') {
      return false;
    }
    try {
      const queue = this.launcherEngine.getDownloadQueue();
      return (
        Array.isArray(queue) &&
        queue.some(
          (t) => t && ['downloading', 'extracting', 'verifying'].includes(String(t.status || ''))
        )
      );
    } catch {
      return false;
    }
  }

  abortAllActiveFetches(reason = 'Hydration preempted') {
    for (const ctrl of this.activeAbortControllers) {
      try {
        ctrl.abort(new Error(reason));
      } catch {}
    }
    this.activeAbortControllers.clear();
  }

  clearTimers() {
    if (this.pumpTimer) {
      try {
        clearTimeout(this.pumpTimer);
      } catch {}
      this.pumpTimer = null;
    }
    if (this.postGameCooldownTimer) {
      try {
        clearTimeout(this.postGameCooldownTimer);
      } catch {}
      this.postGameCooldownTimer = null;
    }
  }

  /**
   * Synchronous `<5ms` hard preemption when a game session transitions to `'starting'` or `'started'`.
   */
  suspendImmediatelyForInGame() {
    this.clearTimers();
    this.isSuspendedInGame = true;
    this.abortAllActiveFetches('Preempted by active game launch');
    this.emitProgress();
  }

  schedulePostGameResumeCheck() {
    if (this.isDisposed) return;
    if (this.postGameCooldownTimer) {
      try {
        clearTimeout(this.postGameCooldownTimer);
      } catch {}
      this.postGameCooldownTimer = null;
    }

    if (this.hasRunningGames()) {
      this.isSuspendedInGame = true;
      this.emitProgress();
      return;
    }

    // Stay suspended while post-session cloud-save uploads / Wine prefix shutdown are running
    if (this.hasPostSessionWork()) {
      this.isSuspendedInGame = true;
      const pollMs = Math.max(25, Math.min(250, this.postGameCooldownMs || 100));
      this.postGameCooldownTimer = setTimeout(() => {
        this.postGameCooldownTimer = null;
        this.schedulePostGameResumeCheck();
      }, pollMs);
      if (this.postGameCooldownTimer && typeof this.postGameCooldownTimer.unref === 'function') {
        this.postGameCooldownTimer.unref();
      }
      return;
    }

    const waitMs = this.postGameCooldownMs;
    const finalizeResume = () => {
      this.postGameCooldownTimer = null;
      if (this.isDisposed) return;
      if (this.hasRunningGames() || this.hasPostSessionWork()) {
        this.schedulePostGameResumeCheck();
        return;
      }
      this.isSuspendedInGame = false;
      this.warmStartUntil = this.now() + this.warmStartDurationMs;
      this.emitProgress();
      this.schedulePump(0);
    };

    if (waitMs <= 0) {
      finalizeResume();
      return;
    }

    this.postGameCooldownTimer = setTimeout(finalizeResume, waitMs);
    if (this.postGameCooldownTimer && typeof this.postGameCooldownTimer.unref === 'function') {
      this.postGameCooldownTimer.unref();
    }
  }

  bindLauncherEngineLifecycle() {
    if (!this.launcherEngine) return;

    // Initial state check
    if (this.shouldPauseBackgroundSyncInGame() && (this.hasRunningGames() || this.hasPostSessionWork())) {
      this.isSuspendedInGame = true;
    }
    this.isPausedForDownloads = this.hasActiveDownloadContention();

    if (typeof this.launcherEngine.onSessionUpdated === 'function') {
      this.unsubSession = this.launcherEngine.onSessionUpdated((payload) => {
        const ev = String(
          payload?.event || payload?.status || payload?.session?.status || ''
        ).toLowerCase();

        if (ev === 'starting' || ev === 'started' || ev === 'running') {
          if (this.shouldPauseBackgroundSyncInGame()) {
            this.suspendImmediatelyForInGame();
          }
        } else if (ev === 'stopped') {
          if (this.isSuspendedInGame) {
            this.schedulePostGameResumeCheck();
          }
        }
      });
    }

    if (typeof this.launcherEngine.onDownloadUpdated === 'function') {
      this.unsubDownload = this.launcherEngine.onDownloadUpdated(() => {
        const activeDl = this.hasActiveDownloadContention();
        if (activeDl && !this.isPausedForDownloads) {
          this.isPausedForDownloads = true;
          if (this.pumpTimer) {
            try {
              clearTimeout(this.pumpTimer);
            } catch {}
            this.pumpTimer = null;
          }
          this.abortAllActiveFetches('Paused for active game download');
          this.emitProgress();
        } else if (!activeDl && this.isPausedForDownloads) {
          this.isPausedForDownloads = false;
          this.emitProgress();
          this.schedulePump(this.itemDelayMs);
        }
      });
    }
  }

  recordP1DetailView(gameId, ts = this.now()) {
    const clean = String(gameId || '').trim();
    if (!clean) return false;
    if (this.p1DetailLru.has(clean)) {
      this.p1DetailLru.delete(clean);
    }
    this.p1DetailLru.set(clean, Number(ts) || this.now());
    while (this.p1DetailLru.size > MAX_P1_HYDRATION_LRU_GAMES) {
      const oldestKey = this.p1DetailLru.keys().next().value;
      if (oldestKey === undefined) break;
      this.p1DetailLru.delete(oldestKey);
    }
    return true;
  }

  isP1DetailGame(gameId) {
    const clean = String(gameId || '').trim();
    if (!clean) return false;
    if (this.p1DetailLru.has(clean)) return true;
    if (this.vault && typeof this.vault.isP1DetailGame === 'function') {
      return Boolean(this.vault.isP1DetailGame(clean));
    }
    return false;
  }

  /**
   * Computes strict P0 / P1 / P2 background media hydration tier:
   * - P0 (0): Installed, Pinned, or Played within the last 30 days.
   * - P1 (1): Detail-viewed or Favorited within the bounded 40-game LRU budget.
   * - P2 (2): Remaining uninstalled library (Cover + Icon ONLY in background sync).
   *
   * @param {Record<string, any>} [rawGame]
   * @param {Record<string, any> | null} [existingDetail]
   */
  computeGameHydrationTier(rawGame = {}, existingDetail = null) {
    if (!rawGame || typeof rawGame !== 'object') return 2;
    if (typeof rawGame.priority === 'number' && Number.isFinite(rawGame.priority)) {
      return Math.max(0, Math.min(2, Math.floor(rawGame.priority)));
    }

    const gameId = String(rawGame.gameId || '').trim();
    const platformInstalled =
      Array.isArray(rawGame.platforms) &&
      rawGame.platforms.some((p) => p && p.installed === true);
    const isInstalled =
      rawGame.isInstalled === true ||
      platformInstalled ||
      (rawGame.isInstalled === undefined && Boolean(existingDetail?.isInstalled));

    if (isInstalled || rawGame.isPinned === true) {
      return 0;
    }

    const lastPlayedMs = parseLastPlayedEpochMs(rawGame.lastPlayedAt ?? rawGame.lastPlayed);
    if (lastPlayedMs > 0) {
      const ageMs = this.now() - lastPlayedMs;
      if (ageMs <= RECENTLY_PLAYED_P0_WINDOW_MS) {
        return 0;
      }
    }

    if (gameId && this.isP1DetailGame(gameId)) {
      return 1;
    }

    const isFavorited =
      rawGame.isFavorited === true ||
      (rawGame.isFavorited === undefined && Boolean(existingDetail?.isFavorited));
    if (isFavorited && gameId && this.p1DetailLru.size < MAX_P1_HYDRATION_LRU_GAMES) {
      this.recordP1DetailView(gameId);
      if (this.vault && typeof this.vault.recordP1DetailGame === 'function') {
        this.vault.recordP1DetailGame(gameId);
      }
      return 1;
    }

    return 2;
  }

  /**
   * Promotes an uninstalled P2 library game into the bounded 40-game P1 LRU when
   * its detail view is opened, immediately queueing Hero/Header + Logo + up to 4 Screenshots.
   */
  promoteGame(gameIdOrPayload, options = {}) {
    if (this.isDisposed) {
      return { success: false, promoted: false, queued: 0 };
    }
    const rawObj =
      typeof gameIdOrPayload === 'string'
        ? { gameId: gameIdOrPayload }
        : gameIdOrPayload && typeof gameIdOrPayload === 'object'
          ? { ...gameIdOrPayload }
          : null;
    const gameId = String(rawObj?.gameId || '').trim();
    if (!gameId) {
      return { success: false, promoted: false, queued: 0 };
    }

    this.recordP1DetailView(gameId);
    if (!options?.fromVault && this.vault && typeof this.vault.recordP1DetailGame === 'function') {
      this.vault.recordP1DetailGame(gameId);
    }

    const existingDetail =
      this.vault && typeof this.vault.getGameDetail === 'function'
        ? this.vault.getGameDetail(gameId)
        : null;

    const candidateAssetsFromVault = [];
    if (this.vault && this.vault.isAvailable && this.vault.db) {
      try {
        const rows = this.vault.db
          .prepare(
            `SELECT asset_role, ordinal, source_url FROM game_media_assets
             WHERE game_id = ? AND source_url IS NOT NULL AND source_url != ''
             ORDER BY asset_role ASC, ordinal ASC`
          )
          .all(gameId);
        for (const r of rows) {
          candidateAssetsFromVault.push({
            role: String(r.asset_role),
            ordinal: Number(r.ordinal) || 0,
            url: String(r.source_url),
          });
        }
      } catch {}
    }

    const mergedAssets = [
      ...candidateAssetsFromVault,
      ...(Array.isArray(rawObj.assets) ? rawObj.assets : []),
    ];

    const computedTier = this.computeGameHydrationTier(rawObj, existingDetail);
    const effectivePriority = Math.min(1, computedTier);

    const res = this.queueHydration({
      games: [
        {
          ...rawObj,
          gameId,
          title: rawObj.title || existingDetail?.canonicalTitle || '',
          steamAppId: rawObj.steamAppId ?? existingDetail?.steamAppId ?? null,
          isInstalled: Boolean(rawObj.isInstalled ?? existingDetail?.isInstalled),
          isFavorited: Boolean(rawObj.isFavorited ?? existingDetail?.isFavorited),
          priority: effectivePriority,
          ...(mergedAssets.length > 0 ? { assets: mergedAssets } : {}),
        },
      ],
    });

    return {
      success: true,
      promoted: true,
      gameId,
      priority: effectivePriority,
      queued: res.queued,
    };
  }

  buildAssetDescriptorsForGame(gameInput, existingDetail, priority) {
    /** @type {Map<string, { role: string, ordinal: number, url: string }>} */
    const byRoleOrd = new Map();
    const tier =
      typeof priority === 'number' && Number.isFinite(priority)
        ? Math.max(0, Math.min(2, Math.floor(priority)))
        : this.computeGameHydrationTier(gameInput, existingDetail);

    const addAsset = (role, ordinal, url) => {
      const cleanRole = String(role || 'cover').trim();
      const cleanOrd = Math.max(0, Math.floor(Number(ordinal) || 0));
      if (!isAssetAllowedForTier(cleanRole, cleanOrd, tier)) return;
      const cleanUrl = typeof url === 'string' ? url.trim() : '';
      if (cleanUrl && isRejectedVideoUrl(cleanUrl)) return;
      if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) return;
      const key = `${cleanRole}::${cleanOrd}`;
      if (!byRoleOrd.has(key)) {
        byRoleOrd.set(key, { role: cleanRole, ordinal: cleanOrd, url: cleanUrl });
      }
    };

    // Always allow zero-copy local federation check for cover/header/icon if storefront IDs exist
    const xboxPlat = Array.isArray(gameInput.platforms)
      ? gameInput.platforms.find((p) => p && String(p.platformId || '').toLowerCase() === 'xbox')
      : null;
    const hasLocalId = Boolean(
      gameInput.steamAppId ||
        gameInput.gogId ||
        gameInput.epicAppName ||
        gameInput.xboxProductId ||
        gameInput.packageFamilyName ||
        gameInput.pfn ||
        gameInput.xboxTitleId ||
        xboxPlat?.xboxProductId ||
        xboxPlat?.packageFamilyName ||
        xboxPlat?.xboxTitleId ||
        /^(?:steam|gog|epic|xbox)[-_]/i.test(String(gameInput.gameId || ''))
    );

    if (Array.isArray(gameInput.assets)) {
      for (const a of gameInput.assets) {
        if (!a || typeof a !== 'object') continue;
        if (a.url || hasLocalId) {
          addAsset(a.role || 'cover', a.ordinal ?? 0, a.url || '');
        }
      }
    }

    const enriched = existingDetail?.enrichedMetadata || gameInput.enrichedMetadata || null;
    const coverUrl = gameInput.capsuleImage || gameInput.coverUrl || enriched?.capsuleImage || '';
    const headerUrl = gameInput.headerImage || enriched?.headerImage || '';
    const heroUrl =
      gameInput.heroImage || enriched?.heroImage || enriched?.background || '';
    const logoUrl =
      gameInput.logoImage || gameInput.logoUrl || enriched?.logoImage || enriched?.logoUrl || '';
    const iconUrl = gameInput.iconUrl || enriched?.iconUrl || '';

    // P2 + P1 + P0: Cover + Icon
    if (coverUrl || hasLocalId) addAsset('cover', 0, coverUrl);
    if (iconUrl || hasLocalId) addAsset('icon', 0, iconUrl);

    // P1 + P0 ONLY: Hero/Header + Logo + Screenshots (P1 max 4, P0 max 6)
    if (tier <= 1) {
      if (headerUrl || hasLocalId) addAsset('header', 0, headerUrl);
      if (heroUrl) addAsset('hero', 0, heroUrl);
      if (logoUrl) addAsset('logo', 0, logoUrl);

      const maxScreenshots = tier === 0 ? 6 : 4;
      const screenshotsList = Array.isArray(enriched?.screenshots)
        ? enriched.screenshots
        : Array.isArray(gameInput.screenshots)
          ? gameInput.screenshots
          : [];
      screenshotsList.slice(0, maxScreenshots).forEach((shot, idx) => {
        const u = typeof shot === 'string' ? shot : shot?.pathThumbnail || shot?.pathFull || '';
        if (u) addAsset('screenshot_thumb', idx, u);
      });
    }

    // P0 ONLY: Inline static description images (max 8; <=1.5MB GIF cap enforced by OfflineVaultService) & video posters (max 4)
    if (tier === 0) {
      const htmlBody =
        enriched?.detailedDescription ||
        enriched?.aboutTheGame ||
        gameInput.detailedDescription ||
        '';
      if (htmlBody) {
        const { inlineImages, inlinePosters } = extractInlineStaticImagesAndPosters(htmlBody);
        inlineImages.forEach((u, idx) => addAsset('inline_img', idx, u));
        inlinePosters.forEach((u, idx) => addAsset('inline_poster', idx, u));
      }
    }

    return Array.from(byRoleOrd.values());
  }

  /**
   * Queues games for background static image & local-federated metadata hydration.
   * Priority tiers:
   * - P0 (0): Installed / Pinned / Played <= 30d (Cover + Hero/Header + Logo + Icon + <=6 Screenshots + Inline)
   * - P1 (1): Detail-viewed / Favorited 40-game LRU (Cover + Hero/Header + Logo + Icon + <=4 Screenshots)
   * - P2 (2): Remaining Uninstalled Library (Cover + Icon ONLY)
   */
  queueHydration(payload = {}) {
    if (this.isDisposed || !payload || !Array.isArray(payload.games)) {
      return { success: false, queued: 0 };
    }

    let newlyQueued = 0;
    for (const rawGame of payload.games) {
      if (!rawGame || typeof rawGame !== 'object' || !rawGame.gameId) continue;
      const gameId = String(rawGame.gameId).trim();
      if (!gameId) continue;

      const existingDetail = this.vault ? this.vault.getGameDetail(gameId) : null;
      const computedPriority = this.computeGameHydrationTier(rawGame, existingDetail);
      if (computedPriority === 1) {
        this.recordP1DetailView(gameId);
      }

      const allDescriptors = this.buildAssetDescriptorsForGame(
        rawGame,
        existingDetail,
        computedPriority
      );
      const candidateAssets = allDescriptors.filter(
        (asset) =>
          !this.vault?.isAssetAlreadyHydratedOrBackedOff?.({
            gameId,
            role: asset.role,
            ordinal: asset.ordinal,
            url: asset.url,
          })
      );
      const hasBackedOffFailure = allDescriptors.some(
        (asset) =>
          Boolean(asset.url) &&
          Boolean(
            this.vault?.isAssetBackedOffFailure?.({
              gameId,
              role: asset.role,
              ordinal: asset.ordinal,
              url: asset.url,
            })
          )
      );

      const needsLocalMetaAttempt =
        !existingDetail ||
        !existingDetail.enrichedMetadata ||
        existingDetail.metadataQuality === 'skeleton_fallback';

      if (candidateAssets.length === 0 && !needsLocalMetaAttempt) {
        if (!hasBackedOffFailure && !(Number(existingDetail?.mediaHydratedAt) > 0)) {
          this.vault?.markGameMediaHydrated?.(gameId, this.now());
        }
        continue;
      }

      const xboxPlat = Array.isArray(rawGame.platforms)
        ? rawGame.platforms.find((p) => p && String(p.platformId || '').toLowerCase() === 'xbox')
        : null;
      const derivedXboxBigId =
        /^xbox[-_:]([A-Z0-9]{12})$/i.exec(gameId)?.[1]?.toUpperCase() || null;
      const resolvedXboxProductId =
        rawGame.xboxProductId ||
        xboxPlat?.xboxProductId ||
        (/^[A-Z0-9]{12}$/i.test(String(xboxPlat?.platformGameId || ''))
          ? String(xboxPlat.platformGameId).toUpperCase()
          : null) ||
        derivedXboxBigId ||
        null;
      const resolvedPfn =
        rawGame.packageFamilyName || rawGame.pfn || xboxPlat?.packageFamilyName || null;
      const resolvedXboxTitleId =
        rawGame.xboxTitleId || xboxPlat?.xboxTitleId || null;

      const prevQueued = this.queuedGames.get(gameId);
      if (prevQueued) {
        prevQueued.priority = Math.min(prevQueued.priority, computedPriority);
        prevQueued.hasPendingAssetFailure = Boolean(
          prevQueued.hasPendingAssetFailure || hasBackedOffFailure
        );
        if (!prevQueued.xboxProductId && resolvedXboxProductId) {
          prevQueued.xboxProductId = resolvedXboxProductId;
        }
        if (!prevQueued.packageFamilyName && resolvedPfn) {
          prevQueued.packageFamilyName = resolvedPfn;
          prevQueued.pfn = resolvedPfn;
        }
        if (!prevQueued.xboxTitleId && resolvedXboxTitleId) {
          prevQueued.xboxTitleId = resolvedXboxTitleId;
        }
        const mergedMap = new Map();
        for (const a of prevQueued.assets) mergedMap.set(`${a.role}::${a.ordinal}`, a);
        for (const a of candidateAssets) mergedMap.set(`${a.role}::${a.ordinal}`, a);
        prevQueued.assets = Array.from(mergedMap.values());
      } else {
        this.queuedGames.set(gameId, {
          gameId,
          title: rawGame.title || '',
          steamAppId: rawGame.steamAppId ?? null,
          gogId: rawGame.gogId ?? null,
          epicAppName: rawGame.epicAppName ?? null,
          xboxProductId: resolvedXboxProductId,
          packageFamilyName: resolvedPfn,
          pfn: resolvedPfn,
          xboxTitleId: resolvedXboxTitleId,
          isInstalled: Boolean(rawGame.isInstalled),
          isFavorited: Boolean(rawGame.isFavorited),
          priority: computedPriority,
          needsLocalMetaAttempt,
          hasPendingAssetFailure: hasBackedOffFailure,
          assets: candidateAssets,
          enqueuedAt: this.now(),
        });
        this.totalQueuedGames++;
        newlyQueued++;
      }
    }

    // Re-check live suspension conditions before pumping
    if (this.shouldPauseBackgroundSyncInGame() && (this.hasRunningGames() || this.hasPostSessionWork())) {
      this.isSuspendedInGame = true;
    }
    this.isPausedForDownloads = this.hasActiveDownloadContention();

    this.emitProgress();
    if (
      !this.isSuspendedInGame &&
      !this.isPausedForDownloads &&
      !this.isPausedForModal &&
      this.queuedGames.size > 0
    ) {
      this.schedulePump(0);
    }

    return { success: true, queued: newlyQueued };
  }

  getEffectiveMaxConcurrency() {
    if (this.now() < this.warmStartUntil) {
      return 1;
    }
    return this.maxConcurrency;
  }

  pickNextQueuedGame() {
    let best = null;
    for (const item of this.queuedGames.values()) {
      if (this.inFlightGameIds.has(item.gameId)) continue;
      if (
        !best ||
        item.priority < best.priority ||
        (item.priority === best.priority && item.enqueuedAt < best.enqueuedAt)
      ) {
        best = item;
      }
    }
    return best;
  }

  schedulePump(delayMs = this.itemDelayMs) {
    if (
      this.isDisposed ||
      this.isSuspendedInGame ||
      this.isPausedForDownloads ||
      this.isPausedForModal
    ) {
      return;
    }
    if (this.pumpTimer) return;
    if (this.queuedGames.size === 0) return;

    const wait = Math.max(0, Number(delayMs) || 0);
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, wait);
    if (this.pumpTimer && typeof this.pumpTimer.unref === 'function') {
      this.pumpTimer.unref();
    }
  }

  pump() {
    if (this.isDisposed) return;

    if (this.shouldPauseBackgroundSyncInGame() && (this.hasRunningGames() || this.hasPostSessionWork())) {
      this.suspendImmediatelyForInGame();
      return;
    }
    if (this.hasActiveDownloadContention()) {
      this.isPausedForDownloads = true;
      this.emitProgress();
      return;
    }
    if (this.isSuspendedInGame || this.isPausedForDownloads || this.isPausedForModal) {
      return;
    }

    const maxConc = this.getEffectiveMaxConcurrency();
    while (this.activeAssetFetches < maxConc && this.queuedGames.size > 0) {
      const nextGame = this.pickNextQueuedGame();
      if (!nextGame) break;
      this.hydrateSingleAssetStep(nextGame);
    }
  }

  async hydrateSingleAssetStep(gameTask) {
    const gameId = gameTask.gameId;
    this.inFlightGameIds.add(gameId);
    this.activeAssetFetches++;
    this.activeGameId = gameId;

    const abortCtrl = new AbortController();
    this.activeAbortControllers.add(abortCtrl);
    this.emitProgress();

    let aborted = false;
    let nextAsset = null;
    let requeuedAsset = false;
    try {
      // Step A: Attempt zero-network local storefront metadata resolution if needed
      if (gameTask.needsLocalMetaAttempt && this.vault?.federator) {
        gameTask.needsLocalMetaAttempt = false;
        const localMeta = this.vault.federator.resolveLocalMetadata({
          gameId,
          title: gameTask.title,
          steamAppId: gameTask.steamAppId,
          gogId: gameTask.gogId,
          epicAppName: gameTask.epicAppName,
          xboxProductId: gameTask.xboxProductId,
          packageFamilyName: gameTask.packageFamilyName,
          pfn: gameTask.pfn || gameTask.packageFamilyName,
          xboxTitleId: gameTask.xboxTitleId,
        });
        if (localMeta && !abortCtrl.signal.aborted) {
          this.vault.saveGameDetail({
            gameId,
            canonicalTitle: gameTask.title || localMeta.name || '',
            steamAppId: typeof gameTask.steamAppId === 'number' ? gameTask.steamAppId : null,
            isInstalled: gameTask.isInstalled,
            isFavorited: gameTask.isFavorited,
            enrichedMetadata: localMeta,
            metadataQuality: 'local_federated',
          });
          // Merge any newly discovered tier-eligible URLs from local metadata
          const extraAssets = this.buildAssetDescriptorsForGame(
            gameTask,
            { enrichedMetadata: localMeta },
            gameTask.priority
          ).filter(
            (a) =>
              !this.vault.isAssetAlreadyHydratedOrBackedOff({
                gameId,
                role: a.role,
                ordinal: a.ordinal,
                url: a.url,
              })
          );
          const merged = new Map();
          for (const a of gameTask.assets) merged.set(`${a.role}::${a.ordinal}`, a);
          for (const a of extraAssets) merged.set(`${a.role}::${a.ordinal}`, a);
          gameTask.assets = Array.from(merged.values());
        }
      }

      // Step B: Hydrate next static image asset in gameTask.assets
      nextAsset = gameTask.assets.shift() || null;
      if (nextAsset && !abortCtrl.signal.aborted) {
        const res = await this.vault.resolveMediaRequest(
          {
            gameId,
            role: nextAsset.role,
            ordinal: nextAsset.ordinal,
            url: nextAsset.url,
            steamAppId: gameTask.steamAppId,
            gogId: gameTask.gogId,
            epicAppName: gameTask.epicAppName,
            epicApp: gameTask.epicAppName,
            xboxProductId: gameTask.xboxProductId,
            packageFamilyName: gameTask.packageFamilyName,
            pfn: gameTask.pfn || gameTask.packageFamilyName,
            xboxTitleId: gameTask.xboxTitleId,
          },
          {
            signal: abortCtrl.signal,
            backgroundHydration: true,
            hydrationTier: gameTask.priority,
          }
        );
        if (res?.reason === 'aborted' || abortCtrl.signal.aborted) {
          aborted = true;
          requeuedAsset = true;
          // Re-prepend aborted asset so it resumes cleanly after game exit!
          gameTask.assets.unshift(nextAsset);
        } else if (
          (!res || res.kind === 'error') &&
          nextAsset.url &&
          res?.reason !== 'video_caching_prohibited'
        ) {
          gameTask.hasPendingAssetFailure = true;
        }
      } else if (nextAsset && abortCtrl.signal.aborted) {
        aborted = true;
        requeuedAsset = true;
        gameTask.assets.unshift(nextAsset);
      }
    } catch (err) {
      if (abortCtrl.signal.aborted) {
        aborted = true;
        if (nextAsset && !requeuedAsset) {
          requeuedAsset = true;
          gameTask.assets.unshift(nextAsset);
        }
      } else {
        if (nextAsset && nextAsset.url) {
          gameTask.hasPendingAssetFailure = true;
        }
        diagLog.debug('hydrationEngine.step', err, { gameId });
      }
    } finally {
      this.activeAbortControllers.delete(abortCtrl);
      this.inFlightGameIds.delete(gameId);
      this.activeAssetFetches = Math.max(0, this.activeAssetFetches - 1);

      if (!aborted && gameTask.assets.length === 0 && !gameTask.needsLocalMetaAttempt) {
        this.queuedGames.delete(gameId);
        this.completedGames++;
        if (!this.isDisposed && !gameTask.hasPendingAssetFailure) {
          this.vault?.markGameMediaHydrated?.(gameId, this.now());
        }
        const detail = this.vault ? this.vault.getGameDetail(gameId) : undefined;
        this.emitGameHydrated({ gameId, ...(detail ? { detail } : {}) });
      }

      if (this.queuedGames.size === 0 && this.activeAssetFetches === 0) {
        this.activeGameId = undefined;
      }

      this.emitProgress();

      if (
        !this.isDisposed &&
        !this.isSuspendedInGame &&
        !this.isPausedForDownloads &&
        !this.isPausedForModal
      ) {
        if (this.queuedGames.size > 0) {
          this.schedulePump(this.itemDelayMs);
        }
      }
    }
  }

  shutdown() {
    this.isDisposed = true;
    this.clearTimers();
    this.abortAllActiveFetches('Launcher shutting down');
    this.queuedGames.clear();
    if (typeof this.unsubSession === 'function') {
      try {
        this.unsubSession();
      } catch {}
      this.unsubSession = null;
    }
    if (typeof this.unsubDownload === 'function') {
      try {
        this.unsubDownload();
      } catch {}
      this.unsubDownload = null;
    }
  }
}

function createMediaHydrationEngine(deps) {
  return new MediaHydrationEngine(deps);
}

module.exports = {
  MediaHydrationEngine,
  createMediaHydrationEngine,
  extractInlineStaticImagesAndPosters,
  isAssetAllowedForTier,
  MAX_P1_HYDRATION_LRU_GAMES,
};
