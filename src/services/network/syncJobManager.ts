import { CanonicalGame } from '../../contracts/game';
import { MediaSyncOutcome } from '../../contracts/steam';
import { steamMatcher } from '../steam/steamMatcher';
import { steamApi } from '../steam/steamApi';
import {
  fallbackMetadataProvider,
  isGenericPlaceholderSynopsis,
} from '../steam/fallbackMetadataProvider';
import { getOpenCriticData, criticScoreService } from '../critic/criticScoreService';
import { requestScheduler, RequestPriority } from './requestScheduler';
import {
  getUserOverrideForGame,
  inferMetadataRouteFromOverride,
  updateRoutedMetadataSnapshot,
} from '../storage/userOverrideStorage';
import {
  loadStagedCache,
  hasFreshMediaSyncAttempt,
  recordMediaSyncAttempt,
  whenStagedCacheHydrated,
} from '../storage/stagedCacheService';
import { flushPendingCatalogSave } from '../integrations/integrationStorage';
import {
  pickBestEnrichedMetadata,
  pickPreferredCapsuleImage,
  pickPreferredDetailedDescription,
  pickPreferredHeaderImage,
  pickPreferredReleaseDate,
} from '../storage/librarySync';
import { isUserActivelyScrolling, waitUntilScrollIdle } from '../../utils/scrollActivityTracker';
import { onlineLifecycleManager } from './onlineLifecycleManager';
import { unwrapOlMediaUrl } from '../../contracts/network';
import { fetchAndCacheHltb, hasAttemptedHltbLookup } from '../hltb/howLongToBeat';

export function evaluateGameNeedsStoreMediaSync(
  g: CanonicalGame,
  forceRefresh: boolean
): { eligible: boolean; alreadyEnriched: boolean } {
  const ov = getUserOverrideForGame(g);
  const route = inferMetadataRouteFromOverride(ov);
  const effectiveSteamId = steamMatcher.getEffectiveSteamAppId(g);
  const gameExtended = g as CanonicalGame & {
    platform?: string;
    xboxProductId?: string;
  };
  const hasXboxPlat =
    gameExtended.platform === 'xbox' ||
    Boolean(gameExtended.xboxProductId) ||
    Boolean(
      g.platforms?.some((p) =>
        typeof p === 'string'
          ? p === 'xbox'
          : p?.platformId === 'xbox' || Boolean(p?.xboxProductId)
      )
    );

  let hasMediaRoute = false;
  if (effectiveSteamId) {
    hasMediaRoute = true;
  } else if (
    hasXboxPlat ||
    g.platforms?.some((p) =>
      typeof p === 'string'
        ? p === 'gog' || p === 'epic'
        : p?.platformId === 'gog' || p?.platformId === 'epic'
    )
  ) {
    hasMediaRoute = true;
  } else {
    hasMediaRoute = Boolean(
      route &&
        route.mode === 'routed' &&
        (route.source === 'steam' ||
          route.source === 'gog' ||
          route.source === 'epic' ||
          (route.source === 'custom' && String(route.matchedId || '').startsWith('xbox-')))
    );
  }

  if (!hasMediaRoute) {
    return { eligible: false, alreadyEnriched: false };
  }

  if (forceRefresh) {
    return { eligible: true, alreadyEnriched: false };
  }

  const meta = g.enrichedMetadata;
  const ovUpdatedAtMs = ov?.updatedAt ? Date.parse(ov.updatedAt) || 0 : 0;
  if (hasFreshMediaSyncAttempt(g.id, meta, ovUpdatedAtMs)) {
    return {
      eligible: false,
      alreadyEnriched: Boolean(meta && meta.metadataQuality !== 'skeleton_fallback'),
    };
  }

  const hasScreenshots =
    (meta?.screenshots?.length || 0) > 0 ||
    (meta?.__quotaSlimmed === true && (meta?.hasScreenshotsCount || 0) > 0);
  const metaAlreadyFromSteam = Boolean(
    meta &&
      Number(meta.appId) > 0 &&
      meta.enrichedSource !== 'xbox' &&
      meta.metadataQuality !== 'skeleton_fallback'
  );
  const canStillMatchSteam =
    !g.isExplicitNonSteam &&
    g.steamAppId !== null &&
    ov?.steamAppId !== null &&
    !metaAlreadyFromSteam &&
    (Boolean(effectiveSteamId) || !steamMatcher.hasAttemptedMatch(g.title));
  const isStorefrontNativeMeta = Boolean(
    meta &&
      (meta.metadataQuality === 'storefront_native' ||
        meta.metadataQuality === 'local_federated' ||
        meta.enrichedSource === 'xbox' ||
        (!g.steamAppId &&
          meta.metadataQuality !== 'scraped' &&
          hasXboxPlat &&
          (!meta.appId || Number(meta.appId) <= 0)))
  );
  const needsRichSteamUpgrade = isStorefrontNativeMeta && canStillMatchSteam;

  if (meta && meta.metadataQuality !== 'skeleton_fallback' && hasScreenshots && !needsRichSteamUpgrade) {
    return { eligible: false, alreadyEnriched: true };
  }

  if (
    meta &&
    meta.metadataQuality !== 'skeleton_fallback' &&
    !hasScreenshots &&
    !needsRichSteamUpgrade &&
    typeof meta.enrichedAt === 'number' &&
    Date.now() - meta.enrichedAt < 30 * 24 * 60 * 60 * 1000
  ) {
    return { eligible: false, alreadyEnriched: true };
  }

  return { eligible: true, alreadyEnriched: false };
}

function normalizeStaticHydrationAssetUrl(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const clean = unwrapOlMediaUrl(raw).trim();
  if (!clean || !/^https?:\/\//i.test(clean)) return null;
  if (/\.(?:mp4|webm|m3u8|mpd|mov|avi|mkv|ogv)(?:[?#]|$)/i.test(clean)) return null;
  if (
    /steamstatic\.com\/store_trailers\/.*\/movie/i.test(clean) &&
    !/\.(?:jpg|jpeg|png|webp|gif|avif)(?:[?#]|$)/i.test(clean)
  ) {
    return null;
  }
  return clean;
}

export function extractStaticHydrationAssets(
  game: CanonicalGame,
  meta?: CanonicalGame['enrichedMetadata']
): Array<{ role: string; ordinal?: number; url: string }> {
  const assets: Array<{ role: string; ordinal?: number; url: string }> = [];
  const seen = new Set<string>();

  const addAsset = (role: string, rawUrl?: string | null, ordinal?: number) => {
    const url = normalizeStaticHydrationAssetUrl(rawUrl);
    if (!url) return;
    const dedupeKey = `${role}:${url}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    assets.push(ordinal !== undefined ? { role, ordinal, url } : { role, url });
  };

  addAsset('cover', game.capsuleImage || meta?.capsuleImage, 0);
  addAsset('header', meta?.headerImage || game.headerImage, 0);
  addAsset('icon', game.iconUrl, 0);

  const topScreenshots = (meta?.screenshots || []).slice(0, 5);
  for (let idx = 0; idx < topScreenshots.length; idx++) {
    const shot = topScreenshots[idx];
    addAsset('screenshot_thumb', shot?.pathThumbnail || shot?.pathFull, idx);
  }

  const htmlSource = meta?.detailedDescription || meta?.aboutTheGame || '';
  if (htmlSource.trim()) {
    const imgRegex = /<img\b[^>]*?\bsrc=["']([^"']+)["']/gi;
    let imgMatch: RegExpExecArray | null;
    let imgOrd = 0;
    while ((imgMatch = imgRegex.exec(htmlSource)) !== null && imgOrd < 12) {
      addAsset('inline_img', imgMatch[1], imgOrd);
      imgOrd++;
    }

    const posterRegex = /<video\b[^>]*?\bposter=["']([^"']+)["']/gi;
    let posterMatch: RegExpExecArray | null;
    let posterOrd = 0;
    while ((posterMatch = posterRegex.exec(htmlSource)) !== null && posterOrd < 6) {
      addAsset('inline_poster', posterMatch[1], posterOrd);
      posterOrd++;
    }
  }

  return assets;
}

interface GlobalSchedulerHost {
  scheduler?: {
    yield?: () => Promise<void>;
  };
}

type FavoritableGame = CanonicalGame & {
  isFavorite?: boolean;
  favorited?: boolean;
};

interface MediaSyncRateError {
  isRateLimited?: boolean;
  status?: number;
  cooldownRemaining?: number;
  message?: string;
  response?: {
    status?: number;
  };
}

const MEDIA_SYNC_DOMAINS = [
  'store.steampowered.com',
  'api.steampowered.com',
  'catalog.gog.com',
  'launcher.store.epicgames.com',
  'api.igdb.com',
] as const;

const MAX_RATE_LIMIT_RETRIES = 3;

async function yieldToMainThread(): Promise<void> {
  const host = globalThis as unknown as GlobalSchedulerHost;
  if (typeof globalThis !== 'undefined' && typeof host.scheduler?.yield === 'function') {
    await host.scheduler.yield();
  } else {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export type SyncCategory =
  | 'storefront_libraries'
  | 'cover_art'
  | 'critic_scores'
  | 'store_media'
  | 'achievements';

export interface SyncJobState {
  id: string;
  type: 'store_media' | 'critic_scores' | 'achievements' | 'cover_art' | 'storefront_libraries' | 'multi';
  title: string;
  headline?: string;
  activeCategories?: string[];
  total: number;
  current: number;
  currentItemName?: string;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'rate_limited';
  isPreempted?: boolean;
  priorityHeadline?: string;
  priorityItemName?: string;
  cooldownSecondsRemaining?: number;
  startedAt?: number;
  error?: string;
}

interface TrackedCategoryStats {
  total: number;
  completed: number;
  inFlight: number;
  lastItemName?: string;
}

interface PriorityScopeEntry {
  id: string;
  headline: string;
  itemName?: string;
}

const CATEGORY_SHORT_LABELS: Record<SyncCategory, string> = {
  storefront_libraries: 'Storefronts',
  cover_art: 'Cover Art',
  critic_scores: 'Review Scores',
  store_media: 'Store Media',
  achievements: 'Achievements',
};

const CATEGORY_SINGLE_HEADLINES: Record<SyncCategory, string> = {
  storefront_libraries: 'Syncing Storefront Libraries',
  cover_art: 'Syncing Cover Art',
  critic_scores: 'Syncing Review Scores',
  store_media: 'Syncing Official Store Media',
  achievements: 'Syncing Achievements',
};

export class SyncJobManager {
  private state: SyncJobState | null = null;
  private listeners = new Set<(state: SyncJobState | null) => void>();
  private isCancelled = false;
  private pausePromiseResolve: (() => void) | null = null;

  // Multi-category background activity tracking (e.g. Cover Art + Review Scores + Achievements)
  private categoryStats = new Map<SyncCategory, TrackedCategoryStats>();
  private categoryClearTimer: ReturnType<typeof setTimeout> | null = null;

  // On-demand priority preemption scopes (e.g. Fix & Match Wizard, Sync Store Media for single game)
  private priorityScopes = new Map<string, PriorityScopeEntry>();
  private preemptionResolvers: Array<() => void> = [];
  private priorityCompleteTimer: ReturnType<typeof setTimeout> | null = null;

  // Active background critic score loop cancellation token
  private criticLoopToken = 0;

  public getState(): SyncJobState | null {
    return this.state ? { ...this.state } : null;
  }

  public subscribe(listener: (state: SyncJobState | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const current = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(current);
      } catch (err) {
        console.error('[SyncJobManager] Error in listener callback:', err);
      }
    }
  }

  private updateState(partial: Partial<SyncJobState>): void {
    if (!this.state) return;
    this.state = {
      ...this.state,
      ...partial,
    };
    this.syncHeadlineAndPriorityFields();
    this.notify();
  }

  private getActiveCategories(): SyncCategory[] {
    const active: SyncCategory[] = [];
    for (const [cat, stats] of this.categoryStats.entries()) {
      if (stats.inFlight > 0 || stats.completed < stats.total) {
        active.push(cat);
      }
    }
    if (
      this.state &&
      !this.state.id.startsWith('priority-') &&
      (this.state.status === 'running' || this.state.status === 'paused' || this.state.status === 'rate_limited')
    ) {
      const primaryType = this.state.type;
      if (
        primaryType !== 'multi' &&
        !active.includes(primaryType as SyncCategory)
      ) {
        active.unshift(primaryType as SyncCategory);
      }
    }
    return active;
  }

  private buildHeadline(activeCats: SyncCategory[], fallbackTitle: string): string {
    if (activeCats.length === 0) return fallbackTitle;
    if (activeCats.length === 1) {
      if (activeCats[0] === 'store_media' && fallbackTitle) {
        return fallbackTitle;
      }
      return CATEGORY_SINGLE_HEADLINES[activeCats[0]] || fallbackTitle;
    }
    const labels = activeCats.map((c) => CATEGORY_SHORT_LABELS[c]);
    if (labels.length === 2) {
      return `Syncing ${labels[0]} & ${labels[1]}`;
    }
    return `Syncing ${labels.slice(0, -1).join(', ')} & ${labels[labels.length - 1]}`;
  }

  private syncHeadlineAndPriorityFields(): void {
    if (!this.state) return;
    const activeCats = this.getActiveCategories();
    const activeLabels = activeCats.map((c) => CATEGORY_SHORT_LABELS[c]);
    const latestPriority = Array.from(this.priorityScopes.values()).pop();

    this.state.activeCategories = activeLabels;
    this.state.isPreempted = Boolean(latestPriority);
    this.state.priorityHeadline = latestPriority?.headline;
    this.state.priorityItemName = latestPriority?.itemName;

    if (this.state.id.startsWith('priority-') && latestPriority) {
      this.state.id = `priority-${latestPriority.id}`;
      this.state.title = latestPriority.headline;
      this.state.headline = latestPriority.headline;
      this.state.currentItemName = latestPriority.itemName;
    } else if (activeCats.length > 1) {
      this.state.headline = this.buildHeadline(activeCats, this.state.title);
    } else if (activeCats.length === 1 && this.state.id.startsWith('auto-')) {
      const single = this.buildHeadline(activeCats, this.state.title);
      this.state.title = single;
      this.state.headline = single;
    } else {
      this.state.headline = this.state.title;
    }
  }

  /**
   * Begins an on-demand user priority scope (e.g. "Sync Store Media (this game)" or "Fix & Match Metadata").
   * Automatically pauses running background syncs and prioritizes P0_INTERACTIVE network requests.
   * When endPriorityScope is called, background syncs automatically resume where they left off.
   */
  public beginPriorityScope(headline: string, itemName?: string): string {
    if (this.priorityCompleteTimer) {
      clearTimeout(this.priorityCompleteTimer);
      this.priorityCompleteTimer = null;
    }

    const scopeId = requestScheduler.beginInteractiveScope();
    this.priorityScopes.set(scopeId, { id: scopeId, headline, itemName });

    if (!this.state || this.state.status === 'idle' || this.state.status === 'completed' || this.state.status === 'cancelled') {
      this.state = {
        id: `priority-${scopeId}`,
        type: 'store_media',
        title: headline,
        headline,
        total: 1,
        current: 0,
        currentItemName: itemName,
        status: 'running',
        isPreempted: true,
        priorityHeadline: headline,
        priorityItemName: itemName,
        startedAt: Date.now(),
      };
    } else {
      this.syncHeadlineAndPriorityFields();
    }
    this.notify();
    return scopeId;
  }

  /**
   * Ends an on-demand priority scope and automatically resumes any preempted background syncs.
   */
  public endPriorityScope(scopeId: string): void {
    if (!this.priorityScopes.has(scopeId)) return;
    this.priorityScopes.delete(scopeId);
    requestScheduler.endInteractiveScope(scopeId);

    if (this.priorityScopes.size === 0) {
      const resolvers = [...this.preemptionResolvers];
      this.preemptionResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }

    if (this.state) {
      if (this.state.id.startsWith('priority-') && this.priorityScopes.size === 0) {
        // Standalone priority action finished; check if background categories are still active
        const activeCats = this.getActiveCategories();
        if (activeCats.length > 0) {
          this.recomputeAggregateStateFromCategories();
        } else {
          this.state = {
            ...this.state,
            current: 1,
            total: 1,
            status: 'completed',
            isPreempted: false,
            priorityHeadline: undefined,
            priorityItemName: undefined,
          };
          this.notify();
          if (this.priorityCompleteTimer) {
            clearTimeout(this.priorityCompleteTimer);
          }
          this.priorityCompleteTimer = setTimeout(() => {
            this.priorityCompleteTimer = null;
            if (
              this.state &&
              this.state.id.startsWith('priority-') &&
              this.state.status === 'completed' &&
              this.priorityScopes.size === 0
            ) {
              this.state = null;
              this.notify();
            }
          }, 1500);
        }
      } else {
        this.syncHeadlineAndPriorityFields();
        this.notify();
      }
    }
  }

  /**
   * Ends all active priority scopes immediately and resumes any preempted background syncs.
   */
  public endAllPriorityScopes(): void {
    if (this.priorityCompleteTimer) {
      clearTimeout(this.priorityCompleteTimer);
      this.priorityCompleteTimer = null;
    }

    for (const scopeId of this.priorityScopes.keys()) {
      requestScheduler.endInteractiveScope(scopeId);
    }
    this.priorityScopes.clear();

    const resolvers = [...this.preemptionResolvers];
    this.preemptionResolvers = [];
    for (const r of resolvers) {
      r();
    }

    if (this.state) {
      if (this.state.id.startsWith('priority-')) {
        const activeCats = this.getActiveCategories();
        if (activeCats.length > 0) {
          this.recomputeAggregateStateFromCategories();
        } else {
          this.state = null;
          this.notify();
        }
      } else {
        this.syncHeadlineAndPriorityFields();
        this.notify();
      }
    }
  }

  /**
   * Convenience wrapper to run an async on-demand user action with automatic background preemption & resume.
   */
  public async runPriorityAction<T>(
    headline: string,
    itemName: string | undefined,
    fn: () => Promise<T>,
    timeoutMs = 12000
  ): Promise<T> {
    const scopeId = this.beginPriorityScope(headline, itemName);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      if (timeoutMs > 0) {
        return await Promise.race([
          fn(),
          new Promise<T>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Priority action "${headline}" timed out after ${timeoutMs}ms`)),
              timeoutMs
            );
          }),
        ]);
      }
      return await fn();
    } finally {
      if (timer) clearTimeout(timer);
      this.endPriorityScope(scopeId);
    }
  }

  public isPriorityPreempted(): boolean {
    return this.priorityScopes.size > 0;
  }

  /**
   * Waits while the job is manually paused by the user OR preempted by an on-demand priority action.
   */
  private async waitWhilePausedOrPreempted(): Promise<void> {
    while (
      (this.state?.status === 'paused' || this.priorityScopes.size > 0) &&
      !this.isCancelled
    ) {
      if (this.state?.status === 'paused') {
        await new Promise<void>((resolve) => {
          this.pausePromiseResolve = resolve;
        });
      } else if (this.priorityScopes.size > 0) {
        await new Promise<void>((resolve) => {
          this.preemptionResolvers.push(resolve);
        });
      }
    }
  }

  /**
   * Tracks an individual background task (such as a Cover Art lookup, Storefront Library sync, or Achievement sync)
   * so the persistent progress bar reflects all active background work and headlines across page navigation.
   */
  public async trackTask<T>(
    category: SyncCategory,
    itemName: string | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    if (this.categoryClearTimer) {
      clearTimeout(this.categoryClearTimer);
      this.categoryClearTimer = null;
    }

    const existing = this.categoryStats.get(category) || {
      total: 0,
      completed: 0,
      inFlight: 0,
    };
    existing.total += 1;
    existing.inFlight += 1;
    if (itemName) existing.lastItemName = itemName;
    this.categoryStats.set(category, existing);

    this.recomputeAggregateStateFromCategories(category, itemName);

    try {
      return await fn();
    } finally {
      const stat = this.categoryStats.get(category);
      if (stat) {
        stat.inFlight = Math.max(0, stat.inFlight - 1);
        stat.completed = Math.min(stat.total, stat.completed + 1);
      }
      this.recomputeAggregateStateFromCategories(category, itemName);
    }
  }

  private recomputeAggregateStateFromCategories(
    latestCategory?: SyncCategory,
    latestItemName?: string
  ): void {
    // If a primary manual job (like startStoreMediaSync) is actively running, just update its headline/categories
    if (
      this.state &&
      !this.state.id.startsWith('auto-') &&
      !this.state.id.startsWith('priority-') &&
      (this.state.status === 'running' ||
        this.state.status === 'paused' ||
        this.state.status === 'rate_limited')
    ) {
      this.syncHeadlineAndPriorityFields();
      this.notify();
      return;
    }

    let total = 0;
    let completed = 0;
    let inFlight = 0;
    let currentItemName = latestItemName;

    for (const stat of this.categoryStats.values()) {
      total += stat.total;
      completed += stat.completed;
      inFlight += stat.inFlight;
      if (
        !currentItemName &&
        stat.lastItemName &&
        (stat.inFlight > 0 || stat.completed < stat.total)
      ) {
        currentItemName = stat.lastItemName;
      }
    }

    if (total === 0) return;

    const activeCats = this.getActiveCategories();
    const primaryCat = activeCats[0] || latestCategory || 'cover_art';
    const headline = this.buildHeadline(
      activeCats.length > 0 ? activeCats : [primaryCat],
      CATEGORY_SINGLE_HEADLINES[primaryCat]
    );

    if (inFlight > 0 || completed < total) {
      this.state = {
        id: this.state?.id.startsWith('auto-') ? this.state.id : `auto-sync-${Date.now()}`,
        type: activeCats.length > 1 ? 'multi' : primaryCat,
        title: headline,
        headline,
        activeCategories: activeCats.map((c) => CATEGORY_SHORT_LABELS[c]),
        total,
        current: completed,
        currentItemName,
        status: this.state?.status === 'paused' ? 'paused' : 'running',
        startedAt: this.state?.startedAt || Date.now(),
      };
      this.syncHeadlineAndPriorityFields();
      this.notify();
    } else {
      if (this.state && this.state.id.startsWith('auto-')) {
        this.state = {
          ...this.state,
          current: total,
          total,
          currentItemName: undefined,
          status: 'completed',
        };
        this.syncHeadlineAndPriorityFields();
        this.notify();
      }
      this.categoryClearTimer = setTimeout(() => {
        this.categoryStats.clear();
      }, 4500);
    }
  }

  public pauseJob(id: string): void {
    if (!this.state || this.state.id !== id) return;
    if (this.state.status === 'running') {
      this.updateState({ status: 'paused' });
    }
  }

  public resumeJob(id: string): void {
    if (!this.state || this.state.id !== id) return;
    if (this.state.status === 'paused') {
      this.updateState({ status: 'running' });
      if (this.pausePromiseResolve) {
        this.pausePromiseResolve();
        this.pausePromiseResolve = null;
      }
    }
  }

  public cancelJob(id: string): void {
    if (id.startsWith('priority-') || this.priorityScopes.size > 0) {
      this.endAllPriorityScopes();
      if (id.startsWith('priority-')) return;
    }
    if (!this.state || this.state.id !== id) return;
    this.isCancelled = true;
    this.criticLoopToken++;
    this.categoryStats.clear();
    this.updateState({
      status: 'cancelled',
      currentItemName: undefined,
    });
    if (this.pausePromiseResolve) {
      this.pausePromiseResolve();
      this.pausePromiseResolve = null;
    }
    const resolvers = [...this.preemptionResolvers];
    this.preemptionResolvers = [];
    for (const r of resolvers) r();
  }

  /**
   * Resets active job state (useful for cleanup and testing).
   */
  public reset(): void {
    this.isCancelled = true;
    this.criticLoopToken++;
    if (this.categoryClearTimer) {
      clearTimeout(this.categoryClearTimer);
      this.categoryClearTimer = null;
    }
    if (this.priorityCompleteTimer) {
      clearTimeout(this.priorityCompleteTimer);
      this.priorityCompleteTimer = null;
    }
    this.categoryStats.clear();
    for (const scopeId of this.priorityScopes.keys()) {
      requestScheduler.endInteractiveScope(scopeId);
    }
    this.priorityScopes.clear();
    if (this.pausePromiseResolve) {
      this.pausePromiseResolve();
      this.pausePromiseResolve = null;
    }
    const resolvers = [...this.preemptionResolvers];
    this.preemptionResolvers = [];
    for (const r of resolvers) r();
    this.state = null;
    this.notify();
  }

  /**
   * Starts a background or user-triggered Critic & Community Review Score sync job.
   * Persists across page navigation, reports headline progress to GlobalSyncProgressBar,
   * and automatically pauses/resumes when preempted by on-demand user actions.
   */
  public async startCriticScoreSync(
    games: CanonicalGame[],
    options?: { forceRefresh?: boolean; isBackgroundWarmup?: boolean; isBackground?: boolean }
  ): Promise<void> {
    const isBackground = Boolean(options?.isBackgroundWarmup || options?.isBackground);

    if (isBackground && !onlineLifecycleManager.isOnline()) {
      return;
    }

    if (isBackground && this.state?.type === 'critic_scores' && this.state?.status === 'running') {
      return;
    }

    // If a manual batch job is already running and this is just a passive background warmup, don't overwrite it
    if (
      isBackground &&
      this.state &&
      !this.state.id.startsWith('auto-') &&
      (this.state.status === 'running' ||
        this.state.status === 'paused' ||
        this.state.status === 'rate_limited')
    ) {
      return;
    }

    if (isBackground) {
      await whenStagedCacheHydrated();
      if (!onlineLifecycleManager.isOnline()) {
        return;
      }
      if (this.state?.type === 'critic_scores' && this.state?.status === 'running') {
        return;
      }
      if (
        this.state &&
        !this.state.id.startsWith('auto-') &&
        (this.state.status === 'running' ||
          this.state.status === 'paused' ||
          this.state.status === 'rate_limited')
      ) {
        return;
      }
    }

    if (options?.forceRefresh) {
      criticScoreService.clearCache();
    }
    criticScoreService.purgeStaleNullScores();

    // Pass skipBackgroundTrigger = true so filtering does NOT fire 393 simultaneous background requests!
    const targetGames = options?.forceRefresh
      ? games
      : games.filter((g) => {
          const targetSteamId = steamMatcher.getEffectiveSteamAppId(g);
          const ov = getUserOverrideForGame(g) as
            | (ReturnType<typeof getUserOverrideForGame> & {
                reviewRoute?: { mode?: 'routed' | 'static' };
              })
            | undefined;
          if (
            ov &&
            (ov.reviewRoute?.mode === 'routed' ||
              (ov.reviewScoreOverride &&
                ov.reviewScoreOverride.source !== 'custom' &&
                ov.reviewRoute?.mode !== 'static'))
          ) {
            const cacheKey = targetSteamId
              ? `id:${targetSteamId}`
              : `title:${g.title.toLowerCase().trim()}`;
            const staged = loadStagedCache(`antigravity_critic_v8_${cacheKey}`, false);
            if (!staged.valid) return true;
          }
          if (isBackground && criticScoreService.hasValidCachedResolution(targetSteamId, g.title)) {
            return false;
          }
          const score = getOpenCriticData(
            targetSteamId || undefined,
            g.title,
            g.reviewSummary?.positivePercent ?? g.enrichedMetadata?.reviewSummary?.positivePercent,
            g.releaseDate,
            undefined,
            false,
            true
          );
          if (isBackground && criticScoreService.hasValidCachedResolution(targetSteamId, g.title)) {
            return false;
          }
          if (criticScoreService.hasAttemptedDynamicResolution(targetSteamId, g.title)) {
            return false;
          }
          if (score && score.score > 0) {
            if (!criticScoreService.hasValidCachedResolution(targetSteamId, g.title)) {
              const cacheKey = targetSteamId
                ? `id:${targetSteamId}`
                : `title:${g.title.toLowerCase().trim()}`;
              const staged = loadStagedCache(`antigravity_critic_v8_${cacheKey}`, false);
              if (staged.stale) {
                return true;
              }
            }
            if (
              score.isSynthetic &&
              (!isBackground || !criticScoreService.hasValidCachedResolution(targetSteamId, g.title))
            ) {
              return true;
            }
            return false;
          }
          return true;
        });

    if (targetGames.length === 0) {
      if (!isBackground) {
        this.state = {
          id: `sync-critic-scores-${Date.now()}`,
          type: 'critic_scores',
          title: 'Syncing Review Scores',
          headline: 'Syncing Review Scores',
          total: 0,
          current: 0,
          status: 'completed',
          startedAt: Date.now(),
        };
        this.notify();
      }
      return;
    }

    const myToken = ++this.criticLoopToken;
    this.isCancelled = false;

    const jobId = isBackground
      ? `auto-critic-scores-${Date.now()}`
      : `sync-critic-scores-${Date.now()}`;

    // Prune any already-finished single-shot categories (e.g. startup achievement check)
    // so they don't pollute the count or currentItemName of this batch sync
    for (const [cat, stat] of this.categoryStats.entries()) {
      if (stat.inFlight === 0 && stat.completed >= stat.total) {
        this.categoryStats.delete(cat);
      }
    }

    this.categoryStats.set('critic_scores', {
      total: targetGames.length,
      completed: 0,
      inFlight: 1,
      lastItemName: targetGames[0]?.title,
    });

    this.state = {
      id: jobId,
      type: 'critic_scores',
      title: 'Syncing Review Scores',
      headline: 'Syncing Review Scores',
      total: targetGames.length,
      current: 0,
      currentItemName: targetGames[0]?.title,
      status: 'running',
      startedAt: Date.now(),
    };
    this.syncHeadlineAndPriorityFields();
    this.notify();

    const chunkSize = isBackground ? 2 : 3;
    let completedCount = 0;

    try {
      for (let i = 0; i < targetGames.length; i += chunkSize) {
        if (this.isCancelled || this.criticLoopToken !== myToken || this.state?.status === 'cancelled') {
          break;
        }

        await this.waitWhilePausedOrPreempted();
        if (
          isBackground &&
          isUserActivelyScrolling() &&
          !(typeof process !== 'undefined' && process.env.VITEST)
        ) {
          await waitUntilScrollIdle(1500);
        }
        if (this.isCancelled || this.criticLoopToken !== myToken) break;

        const chunk = targetGames.slice(i, i + chunkSize);
        const activeTitles = new Set<string>();
        const firstTitle = chunk[0]?.title;

        const stat = this.categoryStats.get('critic_scores');
        if (stat) {
          stat.completed = completedCount;
          if (firstTitle) stat.lastItemName = firstTitle;
        }

        if (this.state && (this.state.id === jobId || this.state.id.startsWith('auto-'))) {
          const activeCats = this.getActiveCategories();
          if (activeCats.length > 1) {
            this.recomputeAggregateStateFromCategories('critic_scores', firstTitle);
          } else {
            this.updateState({
              current: completedCount,
              total: targetGames.length,
              currentItemName: firstTitle,
            });
          }
        }

        await Promise.all(
          chunk.map(async (game) => {
            if (this.isCancelled || this.criticLoopToken !== myToken) return;
            await this.waitWhilePausedOrPreempted();
            if (this.isCancelled || this.criticLoopToken !== myToken) return;
            if (game.title) {
              activeTitles.add(game.title);
            }
            try {
              let targetSteamId = steamMatcher.getEffectiveSteamAppId(game);
              if (!targetSteamId && !game.isExplicitNonSteam) {
                try {
                  const matchedId = await steamMatcher.matchGameToSteam(game.title, {
                    releaseYear: game.releaseDate,
                    developers: game.developers,
                  });
                  if (matchedId) targetSteamId = matchedId;
                } catch {}
              }
              const resolvedScore = await criticScoreService.resolveDynamicScore(
                game.title,
                targetSteamId,
                game.releaseDate,
                undefined,
                {
                  bypassAttempted: Boolean(options?.forceRefresh),
                  platforms: game.platforms,
                  gameId: game.id,
                  genres: game.genres,
                  steamPositivePercent:
                    game.reviewSummary?.positivePercent ??
                    game.enrichedMetadata?.reviewSummary?.positivePercent,
                }
              );
              if (
                resolvedScore &&
                typeof window !== 'undefined' &&
                window.electronAPI?.offlineVault?.saveGameDetail
              ) {
                try {
                  void window.electronAPI.offlineVault
                    .saveGameDetail({
                      gameId: game.id,
                      steamAppId: targetSteamId ?? game.steamAppId ?? null,
                      canonicalTitle: game.title,
                      criticScore: { ...resolvedScore } as Record<string, unknown>,
                    })
                    ?.catch?.(() => {});
                } catch {}
              }
            } catch {} finally {
              activeTitles.delete(game.title);
              if (!this.isCancelled && this.criticLoopToken === myToken) {
                completedCount = Math.min(targetGames.length, completedCount + 1);
                const nextActiveTitle = activeTitles.values().next().value as string | undefined;
                const nextItemName = nextActiveTitle ?? (stat?.lastItemName || this.state?.currentItemName);
                if (stat) {
                  stat.completed = completedCount;
                  if (nextItemName) stat.lastItemName = nextItemName;
                }
                if (this.state && (this.state.id === jobId || this.state.id.startsWith('auto-'))) {
                  const activeCats = this.getActiveCategories();
                  if (activeCats.length > 1) {
                    this.recomputeAggregateStateFromCategories('critic_scores', nextItemName);
                  } else {
                    this.updateState({
                      current: completedCount,
                      total: targetGames.length,
                      currentItemName: nextItemName,
                    });
                  }
                }
              }
            }
          })
        );

        await yieldToMainThread();

        if (
          isBackground &&
          completedCount < targetGames.length &&
          !this.isCancelled &&
          this.criticLoopToken === myToken &&
          !(typeof process !== 'undefined' && process.env.VITEST)
        ) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      if (this.criticLoopToken !== myToken) return;

      const stat = this.categoryStats.get('critic_scores');
      if (stat) {
        stat.inFlight = 0;
        stat.completed = stat.total;
      }

      if (this.isCancelled || this.state?.status === 'cancelled') {
        this.categoryStats.delete('critic_scores');
        this.updateState({
          status: 'cancelled',
          currentItemName: undefined,
        });
      } else {
        const remainingCats = this.getActiveCategories().filter((c) => c !== 'critic_scores');
        if (remainingCats.length > 0) {
          this.categoryStats.delete('critic_scores');
          this.recomputeAggregateStateFromCategories(remainingCats[0]);
        } else {
          this.categoryStats.delete('critic_scores');
          this.updateState({
            status: 'completed',
            current: targetGames.length,
            total: targetGames.length,
            currentItemName: undefined,
          });
        }
      }
    } finally {
      try {
        flushPendingCatalogSave();
        if (typeof window !== 'undefined') {
          window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
        }
      } catch {}
    }
  }

  /**
   * Starts a background store media synchronization job.
   * Runs independently of React component lifecycle so page navigation does not cancel it.
   */
  public async startStoreMediaSync(
    games: CanonicalGame[],
    onGameUpdated: (updated: CanonicalGame) => void,
    options?: { forceRefresh?: boolean; incremental?: boolean; isBackgroundWarmup?: boolean }
  ): Promise<void> {
    const isBackgroundWarmup = Boolean(options?.isBackgroundWarmup);
    const forceRefresh = Boolean(options?.forceRefresh);
    const shouldWarmHltb = Boolean(options?.isBackgroundWarmup || options?.incremental);

    if (isBackgroundWarmup && !onlineLifecycleManager.isOnline()) {
      return;
    }

    if (
      isBackgroundWarmup &&
      this.state &&
      !this.state.id.startsWith('auto-') &&
      (this.state.status === 'running' ||
        this.state.status === 'paused' ||
        this.state.status === 'rate_limited')
    ) {
      return;
    }

    if (isBackgroundWarmup) {
      await whenStagedCacheHydrated();
      if (!onlineLifecycleManager.isOnline()) {
        return;
      }
      if (
        this.state &&
        !this.state.id.startsWith('auto-') &&
        (this.state.status === 'running' ||
          this.state.status === 'paused' ||
          this.state.status === 'rate_limited')
      ) {
        return;
      }
    }

    // If a job is already running, cancel the old one first
    if (
      this.state &&
      (this.state.status === 'running' ||
        this.state.status === 'paused' ||
        this.state.status === 'rate_limited')
    ) {
      this.cancelJob(this.state.id);
      // Brief yield to allow clean loop termination
      await new Promise((r) => setTimeout(r, 10));
    }

    const alreadyEnrichedForHydration: CanonicalGame[] = [];

    const eligibleGames = games.filter((g) => {
      const evalResult = evaluateGameNeedsStoreMediaSync(g, forceRefresh);
      if (evalResult.alreadyEnriched) {
        alreadyEnrichedForHydration.push(g);
      }
      return evalResult.eligible;
    });

    if (
      alreadyEnrichedForHydration.length > 0 &&
      typeof window !== 'undefined' &&
      window.electronAPI?.offlineVault?.queueHydration
    ) {
      try {
        const hydrationBatch = alreadyEnrichedForHydration.map((g) => {
          const gogPlat = g.platforms?.find((p) => p.platformId === 'gog');
          const epicPlat = g.platforms?.find((p) => p.platformId === 'epic');
          const xboxPlat = g.platforms?.find((p) => p.platformId === 'xbox');
          const isInstalled = Boolean(g.platforms?.some((p) => p.installed));
          return {
            gameId: g.id,
            title: g.title,
            steamAppId: g.steamAppId ?? null,
            gogId: gogPlat?.platformGameId ?? null,
            epicAppName: epicPlat?.platformGameId ?? null,
            xboxProductId: xboxPlat?.xboxProductId ?? xboxPlat?.platformGameId ?? null,
            packageFamilyName: xboxPlat?.packageFamilyName ?? null,
            isInstalled,
            isFavorited: Boolean(
              (g as FavoritableGame).isFavorite || (g as FavoritableGame).favorited
            ),
            assets: extractStaticHydrationAssets(g, g.enrichedMetadata),
          };
        });
        void window.electronAPI.offlineVault.queueHydration({ games: hydrationBatch })?.catch?.(() => {});
      } catch {}
    }

    const jobId = isBackgroundWarmup
      ? `auto-store-media-${Date.now()}`
      : `sync-store-media-${Date.now()}`;
    this.isCancelled = false;
    this.pausePromiseResolve = null;

    if (eligibleGames.length === 0) {
      if (!isBackgroundWarmup) {
        this.state = {
          id: jobId,
          type: 'store_media',
          title: 'Sync Official Store Media',
          headline: 'Sync Official Store Media',
          total: 0,
          current: 0,
          status: 'completed',
          startedAt: Date.now(),
        };
        this.notify();
      }
      return;
    }

    this.state = {
      id: jobId,
      type: 'store_media',
      title: 'Syncing Official Store Media',
      headline: 'Syncing Official Store Media',
      total: eligibleGames.length,
      current: 0,
      currentItemName: eligibleGames[0]?.title,
      status: 'running',
      startedAt: Date.now(),
    };
    this.syncHeadlineAndPriorityFields();
    this.notify();

    try {
      if (onlineLifecycleManager.isOnline()) {
        const knownBatchAppIds: number[] = [];
        for (const eg of eligibleGames) {
          const effId = steamMatcher.getEffectiveSteamAppId(eg);
          if (effId && effId > 0) {
            knownBatchAppIds.push(effId);
          }
        }
        if (knownBatchAppIds.length > 0) {
          await steamApi
            .fetchStoreBrowseAssetsBatch(knownBatchAppIds, RequestPriority.P2_BACKGROUND)
            .catch(() => new Map());
        }
      }

      const retryCounts = new Map<string, number>();

      for (let i = 0; i < eligibleGames.length; i++) {
        if (this.isCancelled || this.state.status === 'cancelled') {
          break;
        }
        if (isBackgroundWarmup && !onlineLifecycleManager.isOnline()) {
          break;
        }

        const game = eligibleGames[i];
        this.updateState({
          current: i,
          currentItemName: game.title,
        });

        // 1. Pause & Priority Preemption handling
        await this.waitWhilePausedOrPreempted();
        if (
          isBackgroundWarmup &&
          isUserActivelyScrolling() &&
          !(typeof process !== 'undefined' && process.env.VITEST)
        ) {
          await waitUntilScrollIdle(1500);
        }
        if (this.isCancelled) break;

        // 2. Multi-domain CDN / edge rate-limit cooldown handling
        const activeCooldownSec = requestScheduler.getMaxCooldownRemaining(MEDIA_SYNC_DOMAINS);
        if (activeCooldownSec > 0) {
          this.updateState({
            status: 'rate_limited',
            cooldownSecondsRemaining: activeCooldownSec,
          });

          while (
            requestScheduler.getMaxCooldownRemaining(MEDIA_SYNC_DOMAINS) > 0 &&
            !this.isCancelled
          ) {
            await new Promise((r) => setTimeout(r, 1000));
            if (this.state && this.state.status === 'rate_limited') {
              this.updateState({
                cooldownSecondsRemaining:
                  requestScheduler.getMaxCooldownRemaining(MEDIA_SYNC_DOMAINS),
              });
            }
          }

          if (this.isCancelled) break;

          this.updateState({
            status: 'running',
            cooldownSecondsRemaining: undefined,
          });
        }

        // 3. Perform fetch (respecting Step 4 MetadataSourceRoute)
        const ov = getUserOverrideForGame(game);
        const route = inferMetadataRouteFromOverride(ov);
        const isNonSteamRouted =
          route?.mode === 'routed' &&
          (route.source === 'gog' ||
            route.source === 'epic' ||
            (route.source === 'custom' && String(route.matchedId || '').startsWith('xbox-')));
        let targetAppId =
          route?.source === 'steam' && route.steamAppId
            ? route.steamAppId
            : steamMatcher.getEffectiveSteamAppId(game);
        if (
          !isNonSteamRouted &&
          !targetAppId &&
          !game.isExplicitNonSteam &&
          game.steamAppId !== null &&
          ov?.steamAppId !== null &&
          onlineLifecycleManager.isOnline()
        ) {
          const dynamicallyMatchedId = await steamMatcher.matchGameToSteam(game.title, {
            releaseYear: game.releaseDate,
            developers: game.developers,
            priority: RequestPriority.P2_BACKGROUND,
          });
          if (dynamicallyMatchedId && dynamicallyMatchedId > 0) {
            targetAppId = dynamicallyMatchedId;
          }
        }
        const hasNonSteamPlatform = Boolean(
          game.platforms?.some(
            (p) => p.platformId === 'gog' || p.platformId === 'epic' || p.platformId === 'xbox'
          )
        );

        if (isNonSteamRouted || targetAppId || hasNonSteamPlatform) {
          try {
            const refreshed =
              isNonSteamRouted || !targetAppId
                ? await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(game, ov)
                : await steamApi.fetchGameMetadata(targetAppId!, RequestPriority.P2_BACKGROUND, {
                    forceRefresh,
                  });

            const isSkeletonRefreshed = refreshed?.metadataQuality === 'skeleton_fallback';
            const hasRichExisting = Boolean(
              game.enrichedMetadata &&
                game.enrichedMetadata.metadataQuality !== 'skeleton_fallback'
            );
            const attemptNow = Date.now();
            const outcome: MediaSyncOutcome =
              !refreshed || isSkeletonRefreshed
                ? onlineLifecycleManager.isOnline()
                  ? 'unavailable_404'
                  : 'transient_error'
                : (refreshed.screenshots?.length || 0) === 0
                ? 'partial_no_screenshots'
                : (refreshed.movies?.length || 0) === 0
                ? 'partial_no_trailers'
                : 'complete';

            if (onlineLifecycleManager.isOnline()) {
              recordMediaSyncAttempt(game.id, outcome);
            }

            if (refreshed && !(isSkeletonRefreshed && (hasRichExisting || isBackgroundWarmup))) {
              if (!isNonSteamRouted && targetAppId && ov && route?.mode === 'routed') {
                updateRoutedMetadataSnapshot(game.id, {
                  title: refreshed.name,
                  shortDescription: refreshed.shortDescription,
                  detailedDescription: refreshed.detailedDescription || refreshed.aboutTheGame,
                  headerImage: refreshed.headerImage,
                  developers: refreshed.developers,
                  publishers: refreshed.publishers,
                  genres: refreshed.genres,
                  tags: refreshed.tags,
                  releaseDate: refreshed.releaseDate,
                });
              }

              const preservePinnedSynopsis = Boolean(ov && (route?.customSynopsisEdited || route?.mode === 'custom'));
              const preservePinnedCover = Boolean(ov?.capsuleImage);
              const preservePinnedHeader = Boolean(ov?.headerImage);
              const validRefreshedShort =
                refreshed.shortDescription &&
                !isGenericPlaceholderSynopsis(refreshed.shortDescription, game.title)
                  ? refreshed.shortDescription
                  : undefined;
              const validRefreshedDevs =
                refreshed.developers?.filter((d) => d && d !== 'Unknown Developer') || [];
              const validRefreshedPubs =
                refreshed.publishers?.filter((p) => p && p !== 'Unknown Publisher') || [];

              const cachedBrowse =
                !isNonSteamRouted && targetAppId
                  ? steamApi.peekCachedBrowseAssets(targetAppId)
                  : null;
              const rawCandidateCapsule = refreshed.capsuleImage || cachedBrowse?.capsuleImage;
              const validRefreshedCapsule =
                rawCandidateCapsule &&
                !rawCandidateCapsule.includes('184x69') &&
                !rawCandidateCapsule.includes('231x87') &&
                !rawCandidateCapsule.includes('capsule_sm_120') &&
                !rawCandidateCapsule.includes('_glx_vertical_cover') &&
                !rawCandidateCapsule.includes('header.jpg')
                  ? rawCandidateCapsule
                  : undefined;

              const rawMergedEnriched =
                pickBestEnrichedMetadata(game.enrichedMetadata, refreshed) ||
                refreshed ||
                game.enrichedMetadata;
              const mergedEnriched = rawMergedEnriched
                ? {
                    ...rawMergedEnriched,
                    enrichedAt: rawMergedEnriched.enrichedAt || attemptNow,
                    lastMediaSyncAttemptAt: attemptNow,
                    mediaSyncOutcome: outcome,
                  }
                : rawMergedEnriched;

              const updatedGame: CanonicalGame = {
                ...game,
                steamAppId: isNonSteamRouted ? game.steamAppId : (targetAppId || game.steamAppId),
                enrichedMetadata: mergedEnriched,
                headerImage: preservePinnedHeader
                  ? ov!.headerImage!
                  : pickPreferredHeaderImage(
                      game.headerImage,
                      refreshed.headerImage || cachedBrowse?.headerImage
                    ) ||
                    refreshed.headerImage ||
                    game.headerImage,
                capsuleImage: preservePinnedCover
                  ? ov!.capsuleImage!
                  : pickPreferredCapsuleImage(game.capsuleImage, validRefreshedCapsule) ||
                    validRefreshedCapsule ||
                    game.capsuleImage,
                shortDescription: preservePinnedSynopsis
                  ? ov!.shortDescription || game.shortDescription
                  : validRefreshedShort || game.shortDescription,
                detailedDescription:
                  pickPreferredDetailedDescription(
                    game.detailedDescription,
                    refreshed.detailedDescription || refreshed.aboutTheGame
                  ) ||
                  refreshed.detailedDescription ||
                  refreshed.aboutTheGame ||
                  game.detailedDescription,
                developers: validRefreshedDevs.length ? validRefreshedDevs : game.developers,
                publishers: validRefreshedPubs.length ? validRefreshedPubs : game.publishers,
                genres: refreshed.genres?.length ? refreshed.genres : game.genres,
                tags: refreshed.tags?.length ? refreshed.tags : game.tags,
                releaseDate:
                  pickPreferredReleaseDate(game.releaseDate, refreshed.releaseDate) ||
                  game.releaseDate,
                reviewSummary: refreshed.reviewSummary || game.reviewSummary,
              };

              if (!isSkeletonRefreshed && typeof window !== 'undefined') {
                if (
                  (isNonSteamRouted ||
                    !targetAppId ||
                    updatedGame.id !== `steam-${targetAppId}`) &&
                  window.electronAPI?.offlineVault?.saveGameDetail
                ) {
                  try {
                    void window.electronAPI.offlineVault
                      .saveGameDetail({
                        gameId: updatedGame.id,
                        steamAppId: updatedGame.steamAppId ?? null,
                        canonicalTitle: updatedGame.title,
                        enrichedMetadata: mergedEnriched || refreshed,
                        metadataQuality:
                          mergedEnriched?.metadataQuality ||
                          refreshed.metadataQuality ||
                          (targetAppId && !isNonSteamRouted ? 'authoritative' : 'scraped'),
                        enrichedAt: mergedEnriched?.enrichedAt || attemptNow,
                      })
                      ?.catch?.(() => {});
                  } catch {}
                }

                if (window.electronAPI?.offlineVault?.queueHydration) {
                  try {
                    const gogPlat = updatedGame.platforms?.find((p) => p.platformId === 'gog');
                    const epicPlat = updatedGame.platforms?.find((p) => p.platformId === 'epic');
                    const xboxPlat = updatedGame.platforms?.find((p) => p.platformId === 'xbox');
                    const isInstalled = Boolean(updatedGame.platforms?.some((p) => p.installed));
                    const assets = extractStaticHydrationAssets(updatedGame, refreshed);
                    if (assets.length > 0) {
                      void window.electronAPI.offlineVault
                        .queueHydration({
                          games: [
                            {
                              gameId: updatedGame.id,
                              title: updatedGame.title,
                              steamAppId: updatedGame.steamAppId ?? null,
                              gogId: gogPlat?.platformGameId ?? null,
                              epicAppName: epicPlat?.platformGameId ?? null,
                              xboxProductId:
                                xboxPlat?.xboxProductId ?? xboxPlat?.platformGameId ?? null,
                              packageFamilyName: xboxPlat?.packageFamilyName ?? null,
                              isInstalled,
                              isFavorited: Boolean(
                                (updatedGame as FavoritableGame).isFavorite ||
                                  (updatedGame as FavoritableGame).favorited
                              ),
                              assets,
                            },
                          ],
                        })
                        ?.catch?.(() => {});
                    }
                  } catch {}
                }
              }

              onGameUpdated(updatedGame);
            } else if (onlineLifecycleManager.isOnline() && game.enrichedMetadata) {
              const stampedExistingMeta = {
                ...game.enrichedMetadata,
                enrichedAt: game.enrichedMetadata.enrichedAt || attemptNow,
                lastMediaSyncAttemptAt: attemptNow,
                mediaSyncOutcome: outcome,
              };
              const stampedGame: CanonicalGame = {
                ...game,
                enrichedMetadata: stampedExistingMeta,
              };
              if (
                stampedExistingMeta.metadataQuality !== 'skeleton_fallback' &&
                typeof window !== 'undefined' &&
                window.electronAPI?.offlineVault?.saveGameDetail
              ) {
                try {
                  void window.electronAPI.offlineVault
                    .saveGameDetail({
                      gameId: stampedGame.id,
                      steamAppId: stampedGame.steamAppId ?? null,
                      canonicalTitle: stampedGame.title,
                      enrichedMetadata: stampedExistingMeta,
                      metadataQuality: stampedExistingMeta.metadataQuality || 'storefront_native',
                      enrichedAt: stampedExistingMeta.enrichedAt,
                    })
                    ?.catch?.(() => {});
                } catch {}
              }
              onGameUpdated(stampedGame);
            }

            if (shouldWarmHltb && onlineLifecycleManager.isOnline()) {
              try {
                const effectiveHltbAppId = targetAppId || game.steamAppId;
                if (!hasAttemptedHltbLookup(game.title, effectiveHltbAppId)) {
                  const liveHltb = await fetchAndCacheHltb(game.title, effectiveHltbAppId).catch(
                    () => null
                  );
                  if (
                    liveHltb &&
                    typeof window !== 'undefined' &&
                    window.electronAPI?.offlineVault?.saveGameDetail
                  ) {
                    void window.electronAPI.offlineVault
                      .saveGameDetail({
                        gameId: game.id,
                        steamAppId: effectiveHltbAppId ?? null,
                        canonicalTitle: game.title,
                        hltb: { ...liveHltb } as Record<string, unknown>,
                      })
                      ?.catch?.(() => {});
                  }
                }
              } catch {}
            }
          } catch (err: unknown) {
            const rateErr = (err && typeof err === 'object' ? err : {}) as MediaSyncRateError;
            const is429 =
              Boolean(rateErr.isRateLimited) ||
              rateErr.status === 429 ||
              rateErr.response?.status === 429;
            if (is429) {
              const attempt = (retryCounts.get(game.id) ?? 0) + 1;
              retryCounts.set(game.id, attempt);
              if (attempt <= MAX_RATE_LIMIT_RETRIES) {
                const cooldownSec = Math.max(
                  requestScheduler.getMaxCooldownRemaining(MEDIA_SYNC_DOMAINS),
                  typeof rateErr.cooldownRemaining === 'number' ? rateErr.cooldownRemaining : 0
                );
                const waitMs = Math.max(
                  cooldownSec * 1000,
                  1000 * Math.pow(2, attempt - 1)
                );
                this.updateState({
                  status: 'rate_limited',
                  cooldownSecondsRemaining: Math.ceil(waitMs / 1000),
                });
                let remainingMs = waitMs;
                while (remainingMs > 0 && !this.isCancelled) {
                  const sliceMs = Math.min(1000, remainingMs);
                  await new Promise((r) => setTimeout(r, sliceMs));
                  remainingMs -= sliceMs;
                  if (!this.isCancelled && this.state?.status === 'rate_limited') {
                    const nextSec = Math.max(
                      Math.ceil(Math.max(0, remainingMs) / 1000),
                      requestScheduler.getMaxCooldownRemaining(MEDIA_SYNC_DOMAINS)
                    );
                    this.updateState({
                      cooldownSecondsRemaining: nextSec,
                    });
                  }
                }
                if (this.isCancelled) break;
                this.updateState({
                  status: 'running',
                  cooldownSecondsRemaining: undefined,
                });
                i--;
                await yieldToMainThread();
                continue;
              }
              console.warn(
                `[SyncJobManager] Rate-limit retries exhausted (${MAX_RATE_LIMIT_RETRIES}) for ${game.title}; advancing.`
              );
            } else {
              console.warn(
                `[SyncJobManager] Media sync error for ${game.title}:`,
                rateErr.message || err
              );
            }
            if (!this.isCancelled && onlineLifecycleManager.isOnline()) {
              recordMediaSyncAttempt(game.id, 'transient_error');
            }
          }
        }

        this.updateState({
          current: i + 1,
        });
        await yieldToMainThread();
      }

      if (this.isCancelled || this.state?.status === 'cancelled') {
        this.updateState({
          status: 'cancelled',
          currentItemName: undefined,
        });
      } else {
        this.updateState({
          status: 'completed',
          current: eligibleGames.length,
          currentItemName: undefined,
        });
      }
    } finally {
      try {
        flushPendingCatalogSave();
        steamApi.trimMemoryCache(30);
        if (typeof window !== 'undefined') {
          window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
        }
      } catch {}
    }
  }

  /**
   * Starts a dedicated cross-storefront Trophy & Achievement synchronization job
   * with live progress reporting in GlobalSyncProgressBar.
   */
  public async startTrophySync(
    totalSteps: number,
    runner: (
      updateProgress: (current: number, total: number, currentItemName?: string) => void,
      checkCancelled: () => boolean
    ) => Promise<void>
  ): Promise<void> {
    this.isCancelled = false;
    const jobId = `trophy-sync-${Date.now()}`;
    const safeTotal = Math.max(1, totalSteps);

    this.state = {
      id: jobId,
      type: 'achievements',
      title: 'Syncing Storefront Trophies',
      headline: 'Syncing Storefront Trophies',
      activeCategories: [CATEGORY_SHORT_LABELS.achievements],
      total: safeTotal,
      current: 0,
      status: 'running',
      startedAt: Date.now(),
    };
    this.notify();

    try {
      await runner(
        (current, total, currentItemName) => {
          if (this.isCancelled || !this.state || this.state.id !== jobId) return;
          this.updateState({
            current: Math.min(Math.max(0, current), Math.max(1, total)),
            total: Math.max(1, total),
            currentItemName,
          });
        },
        () => this.isCancelled || this.state?.status === 'cancelled'
      );

      if (this.state && this.state.id === jobId) {
        if (this.isCancelled || this.state.status === 'cancelled') {
          this.updateState({
            status: 'cancelled',
            currentItemName: undefined,
          });
        } else {
          this.updateState({
            status: 'completed',
            current: this.state.total,
            currentItemName: undefined,
          });
          if (this.priorityCompleteTimer) clearTimeout(this.priorityCompleteTimer);
          this.priorityCompleteTimer = setTimeout(() => {
            if (this.state && this.state.id === jobId && this.state.status === 'completed') {
              this.state = null;
              this.notify();
            }
          }, 3000);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : undefined;
      if (this.state && this.state.id === jobId) {
        this.updateState({
          status: 'completed',
          current: this.state.total,
          currentItemName: undefined,
          error: errMsg,
        });
      }
      throw err;
    }
  }
}

export const syncJobManager = new SyncJobManager();
