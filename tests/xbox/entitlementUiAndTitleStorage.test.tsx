import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import axios from 'axios';

import {
  saveIntegrations,
  saveXboxProfileState,
  loadXboxProfileState,
  mergeStorefrontGames,
  mergeUpdatedGamePreservingLivePlatformState,
  loadCurrentCatalog,
  compactGameForStorage,
  reconcileCatalogGamesWithInstalledRecords,
} from '../../src/services/integrations/integrationStorage';
import { sanitizeGameCatalog } from '../../src/services/integrations/catalogSanitizer';
import {
  stripStorefrontPlatformDisambiguators,
  stripYearEditionPhrases,
  normalizeTitleKey,
  splitCamelCaseTitle,
  alignCompoundWordTokens,
  extractSequelIdentifier,
  isSequelMismatch,
  sanitizeStoreReleaseDate,
} from '../../src/services/common/titleUtils';
import {
  computeEntityMatchConfidence,
  parseReleaseYear,
} from '../../src/services/common/entityResolver';
import {
  SteamMatcherService,
  computeTitleSimilarity,
} from '../../src/services/steam/steamMatcher';
import {
  SteamApiService,
  steamApi,
  truncateHtmlSafely,
} from '../../src/services/steam/steamApi';
import { steamAchievementsService } from '../../src/services/steam/steamAchievementsService';
import { fallbackMetadataProvider } from '../../src/services/steam/fallbackMetadataProvider';
import { requestScheduler } from '../../src/services/network/requestScheduler';
import { onlineLifecycleManager } from '../../src/services/network/onlineLifecycleManager';
import {
  pickBestEnrichedMetadata,
  pickPreferredCapsuleImage,
  pickPreferredDetailedDescription,
} from '../../src/services/storage/librarySync';
import * as indexedDbVault from '../../src/services/storage/indexedDbVault';
import { getStorefrontNativeOsFlags } from '../../src/services/platform/nativeOsService';
import { reconcileCatalogTrophiesRecords } from '../../src/utils/catalogMergeUtils';
import { resolveEffectiveLaunchPolicy as resolveTsLaunchPolicy } from '../../src/contracts/launchPolicyResolver';
import { LauncherService, launcherService } from '../../src/services/launcher/launcherService';
import { achievementDetailService } from '../../src/services/achievements/achievementDetailService';
import { StorefrontIcon } from '../../src/components/Common/StorefrontIcon';
import { DownloadManagerDrawer } from '../../src/components/Launcher/DownloadManagerDrawer';
import { IntegrationsModal } from '../../src/components/Navigation/IntegrationsModal';
import { GameAchievementsModal } from '../../src/components/Achievements/GameAchievementsModal';
import { GameInstallModal } from '../../src/components/Launcher/GameInstallModal';
import { LibraryGridView } from '../../src/components/Library/LibraryGridView';
import { LibrarySidebar } from '../../src/components/Library/LibrarySidebar';
import { PlatformBadges } from '../../src/components/SteamStoreDetail/PlatformBadges';
import { SteamLibraryActionBar } from '../../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { SteamStorePage } from '../../src/components/SteamStoreDetail/SteamStorePage';
import { buildLibraryFilterIndex } from '../../src/services/filter/libraryFilterIndex';
import { criticScoreService } from '../../src/services/critic/criticScoreService';
import {
  saveStagedCache,
  loadStagedCache,
  STAGED_CACHE_VERSION,
} from '../../src/services/storage/stagedCacheService';
import type { CanonicalGame } from '../../src/contracts/game';
import type { StorefrontIntegration } from '../../src/contracts/integration';
import type { SteamEnrichedMetadata } from '../../src/contracts/steam';

import {
  nodeRequire,
  xboxAuthManager,
  xboxBoringSslCrypto,
  xboxDeviceClep,
  xboxCatalogAndGamePass,
  xboxAchievementsAndStats,
  msixvcXvdParser,
  msixvcStreamExtractor,
  xboxRuntimeLoopbackServer,
  xboxTitleStorageSync,
  tokenVault,
  binaryAndManifestInspectors,
  cjsLaunchPolicyResolver,
  uninstallSafety,
  cloudSaveEngine,
  wineAndCrossOverManager,
  offlineVaultMod,
  federatorMod,
  launcherEngine,
  buildXboxBridge,
  setDomPurifyFragmentBuilder,
  getDomPurifyFragmentBuilder,
  sanitizeHtmlStringViaDomParser,
  createMemoryStorage,
  makeCanonicalGameFixture,
  buildValidMinimalPe64Buffer,
  buildSyntheticSpLicenseBlockBase64,
  buildSyntheticSegmentMetadata,
  buildSyntheticUserData,
  buildSyntheticMsixvcImage,
  buildDisplayCatalogGameFixture,
  findElements,
  getTextContent,
  expandFunctionVNodes,
  createComponentHarness,
  flushMicrotasks,
  sendLoopbackRpc,
  Domain12TextNode,
  Domain12DocumentFragment,
  Domain12HTMLElement,
  buildDomain12FragmentFromHtml,
  createDomain12DeepRenderer,
  buildValidJpegBuffer,
  buildSyntheticAnimatedGif89aBuffer,
  makeMockFetchBinaryResponse,
  type SyntheticSegmentFile,
  type SyntheticMsixvcOptions,
} from '../helpers/xboxTestHarness';

vi.mock('dompurify', () => ({
  default: {
    sanitize: (html: string, cfg?: { RETURN_DOM_FRAGMENT?: boolean }) => {
      const builder = getDomPurifyFragmentBuilder();
      if (cfg?.RETURN_DOM_FRAGMENT && builder) {
        return builder(String(html || ''));
      }
      return sanitizeHtmlStringViaDomParser(String(html || ''));
    },
  },
}));

// 13. Tasks 1–3 End-to-End UI & Entitlement Regressions (Clean Ready to Play, ActionBar Cleanup & Strict GP Badge Parity)
// ===========================================================================

describe('13. Tasks 1–3 End-to-End UI & Entitlement Regressions (Clean Ready to Play, ActionBar Cleanup & Strict GP Badge Parity)', () => {
  let prevWindow: any;
  let prevDocument: any;
  let prevNavigatorDesc: PropertyDescriptor | undefined;
  let prevLocalStorage: any;

  beforeEach(() => {
    prevWindow = (globalThis as any).window;
    prevDocument = (globalThis as any).document;
    prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    prevLocalStorage = (globalThis as any).localStorage;

    const memStorage = createMemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: memStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true, userAgent: 'OneLauncherTest/1.0' },
      configurable: true,
    });
    (globalThis as any).document = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      elementFromPoint: () => null,
      createElement: (tag: string) => new Domain12HTMLElement(tag),
      createDocumentFragment: () => new Domain12DocumentFragment(),
    };
    (globalThis as any).window = {
      innerWidth: 1440,
      innerHeight: 900,
      localStorage: memStorage,
      location: { hostname: 'one-launcher.local', port: '', protocol: 'app:' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      electronAPI: {
        platform: 'darwin',
        openExternal: vi.fn(),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
    if (prevDocument === undefined) {
      delete (globalThis as any).document;
    } else {
      (globalThis as any).document = prevDocument;
    }
    if (prevNavigatorDesc) {
      Object.defineProperty(globalThis, 'navigator', prevNavigatorDesc);
    }
    if (prevLocalStorage === undefined) {
      delete (globalThis as any).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        value: prevLocalStorage,
        configurable: true,
        writable: true,
      });
    }
  });

  it('Task 1: renders clean "Ready to Play" (and "Active Session" when running) in SteamStorePage header without CrossOver/Wine or storefront list suffix while keeping Owned on badges', () => {
    vi.spyOn(steamApi, 'fetchStoreBrowseAssets').mockResolvedValue(null as any);
    vi.spyOn(steamApi, 'getStoreBrowseAssetsInstant').mockReturnValue(null);
    vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue(null);
    vi.spyOn(steamAchievementsService, 'fetchPlayerGameAchievements').mockResolvedValue(null);
    vi.spyOn(fallbackMetadataProvider, 'getEnrichedMetadataForNonSteamGame').mockResolvedValue(
      null as any
    );
    vi.spyOn(launcherService, 'isInGameHibernating').mockReturnValue(false);
    vi.spyOn(launcherService, 'getRunningGames').mockReturnValue([]);
    vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(true);
    const isRunningSpy = vi.spyOn(launcherService, 'isGameRunning').mockReturnValue(false);

    const multiStoreInstalledGame = makeCanonicalGameFixture({
      id: 'steam-442200',
      steamAppId: 442200,
      title: 'Synthetic Citadel Odyssey',
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '442200',
          installed: true,
          installPath: '/Users/testuser/Games/Steam/SyntheticCitadel',
          executablePath: '/Users/testuser/Games/Steam/SyntheticCitadel/Citadel.exe',
          isWindowsBinaryOnMac: true,
        },
        {
          platformId: 'epic',
          platformGameId: 'citadel-epic-01',
          installed: true,
          installPath: '/Users/testuser/Games/Epic/SyntheticCitadel',
          executablePath: '/Users/testuser/Games/Epic/SyntheticCitadel/Citadel.exe',
          isWindowsBinaryOnMac: true,
        },
        {
          platformId: 'xbox',
          platformGameId: '9NCITADELX01',
          xboxProductId: '9NCITADELX01',
          ownershipType: 'owned',
          installed: true,
          installPath: '/Users/testuser/Games/OneLauncher/SyntheticCitadel',
          executablePath: '/Users/testuser/Games/OneLauncher/SyntheticCitadel/Citadel.exe',
          isWindowsBinaryOnMac: true,
        },
      ],
    });

    const page = createDomain12DeepRenderer(SteamStorePage, {
      game: multiStoreInstalledGame,
      collections: [],
      connectedStorefronts: ['steam', 'epic', 'xbox'],
      onBackToLibrary: () => {},
      onManageCollections: () => {},
      onToggleInstallStatus: () => {},
    });

    const idleTree = page.render();
    const idleText = getTextContent(idleTree);
    expect(idleText).toContain('Ready to Play');
    expect(idleText).not.toContain('Active Session');
    expect(idleText).not.toContain('CrossOver / Wine');
    expect(idleText).not.toContain('• Steam, Epic Games, Xbox');
    expect(idleText).toContain('Owned on:');
    expect(idleText).toContain('Steam');
    expect(idleText).toContain('Epic Games');
    expect(idleText).toContain('Xbox');

    // Isolate the header status pill specifically to verify its exact text is strictly "Ready to Play"
    const readyPill = findElements(
      idleTree,
      (el) =>
        el.type === 'span' &&
        typeof el.props?.className === 'string' &&
        el.props.className.includes('bg-emerald-950/40') &&
        getTextContent(el).includes('Ready to Play')
    )[0];
    expect(readyPill).toBeDefined();
    expect(getTextContent(readyPill).trim()).toBe('Ready to Play');

    // Switch session to running -> renders "Active Session" cleanly without CrossOver / Wine suffix
    isRunningSpy.mockReturnValue(true);
    const runningTree = page.render({ game: { ...multiStoreInstalledGame } });
    const runningText = getTextContent(runningTree);
    expect(runningText).toContain('Active Session');
    expect(runningText).not.toContain('Ready to Play');
    expect(runningText).not.toContain('CrossOver / Wine');
    expect(runningText).toContain('Owned on:');

    page.unmount();
  });

  it('Task 2: omits GAME PASS badge next to Play/Install in SteamLibraryActionBar for subscription and owned_and_subscription games while keeping storefront selector', () => {
    vi.spyOn(launcherService, 'isGameRunning').mockReturnValue(false);
    vi.spyOn(launcherService, 'getRunningGames').mockReturnValue([]);
    vi.spyOn(launcherService, 'getActiveDownload').mockReturnValue(undefined);
    const isInstalledSpy = vi.spyOn(launcherService, 'isGameInstalled');

    for (const ownershipType of ['subscription', 'owned_and_subscription'] as const) {
      for (const installed of [true, false]) {
        isInstalledSpy.mockReturnValue(installed);
        const game = makeCanonicalGameFixture({
          id: `xbox_9NACTION_${ownershipType}_${installed}`,
          title: 'Synthetic Starlight Protocol',
          platforms: [
            {
              platformId: 'xbox',
              platformGameId: '9NSTARPROT01',
              xboxProductId: '9NSTARPROT01',
              ownershipType,
              gamePassTier: 'PC Game Pass',
              isLeavingSoon: false,
              subscriptionExpired: false,
              installed,
              ...(installed
                ? { installPath: '/Users/testuser/Games/OneLauncher/StarlightProtocol' }
                : {}),
            },
            {
              platformId: 'steam',
              platformGameId: '551100',
              installed: false,
            },
          ],
        });

        const bar = createDomain12DeepRenderer(SteamLibraryActionBar, {
          game,
          connectedStorefronts: ['xbox', 'steam'],
        });
        const tree = bar.render();
        const fullText = getTextContent(tree);

        expect(fullText).toContain(installed ? 'Play' : 'Install');
        const gpActionPill = findElements(
          tree,
          (el) => el.props?.['data-testid'] === 'actionbar-xbox-gamepass-pill'
        )[0];
        expect(gpActionPill).toBeUndefined();
        expect(fullText.toUpperCase()).not.toContain('GAME PASS');

        const switcherPill = findElements(
          tree,
          (el) =>
            typeof el.props?.title === 'string' &&
            el.props.title.startsWith('Active Storefront:')
        )[0];
        expect(switcherPill).toBeDefined();

        bar.unmount();
      }
    }
  });

  it('Task 3a: enforces strict Game-Pass-library-only "GP" badge across LibraryGridView (cover + hover pill), LibrarySidebar, and PlatformBadges ("Owned on:")', () => {
    vi.useFakeTimers();
    vi.spyOn(launcherService, 'isGameRunning').mockReturnValue(false);
    vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(false);
    vi.spyOn(launcherService, 'getRunningGames').mockReturnValue([]);

    const cases: Array<{
      label: string;
      ownershipType: 'owned' | 'subscription' | 'owned_and_subscription';
      subscriptionExpired?: boolean;
      expectGp: boolean;
      expectExpired: boolean;
    }> = [
      {
        label: 'owned-only (purchased in Microsoft account, NOT in Game Pass library)',
        ownershipType: 'owned',
        subscriptionExpired: false,
        expectGp: false,
        expectExpired: false,
      },
      {
        label: 'active subscription (in Game Pass library)',
        ownershipType: 'subscription',
        subscriptionExpired: false,
        expectGp: true,
        expectExpired: false,
      },
      {
        label: 'owned_and_subscription active (owned + currently in Game Pass library)',
        ownershipType: 'owned_and_subscription',
        subscriptionExpired: false,
        expectGp: true,
        expectExpired: false,
      },
      {
        label: 'owned_and_subscription lapsed (owned + subscriptionExpired: true)',
        ownershipType: 'owned_and_subscription',
        subscriptionExpired: true,
        expectGp: false,
        expectExpired: false,
      },
    ];

    for (const scenario of cases) {
      const game = makeCanonicalGameFixture({
        id: `xbox_gp_matrix_${scenario.ownershipType}_${String(scenario.subscriptionExpired)}`,
        title: 'Synthetic Nebula Drift',
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NNEBULADRF1',
            xboxProductId: '9NNEBULADRF1',
            ownershipType: scenario.ownershipType,
            subscriptionExpired: scenario.subscriptionExpired,
            installed: false,
          },
        ],
      });

      // 1. LibraryGridView: cover art top-left badge + hover popout storefront pill
      const grid = createDomain12DeepRenderer(LibraryGridView, {
        games: [game],
        onSelectGame: () => {},
        connectedStorefronts: ['xbox'],
      });
      const cardTree = grid.render();
      const cardNode = findElements(
        cardTree,
        (el) => el.props?.['data-game-id'] === game.id
      )[0];
      expect(cardNode, scenario.label).toBeDefined();

      const coverGpBadges = findElements(
        cardNode,
        (el) => el.type === 'div' && getTextContent(el).trim() === 'GP'
      );
      const coverExpiredBadges = findElements(
        cardNode,
        (el) => el.type === 'div' && getTextContent(el).trim() === 'Expired'
      );
      expect(coverGpBadges.length > 0, `${scenario.label} cover GP`).toBe(scenario.expectGp);
      expect(coverExpiredBadges.length > 0, `${scenario.label} cover Expired`).toBe(
        scenario.expectExpired
      );

      // Trigger hover popout for this card and advance HOVER_DELAY_MS
      cardNode.props.onMouseEnter({
        currentTarget: {
          getBoundingClientRect: () => ({
            left: 120,
            right: 320,
            top: 120,
            bottom: 420,
            width: 200,
            height: 300,
          }),
          contains: () => false,
        },
      });
      vi.advanceTimersByTime(600);
      const hoveredTree = grid.render();
      const hoverGpSpans = findElements(
        hoveredTree,
        (el) => el.type === 'span' && getTextContent(el).trim() === 'GP'
      );
      const hoverExpiredSpans = findElements(
        hoveredTree,
        (el) => el.type === 'span' && getTextContent(el).trim() === 'Expired'
      );
      expect(hoverGpSpans.length > 0, `${scenario.label} hover pill GP`).toBe(scenario.expectGp);
      expect(hoverExpiredSpans.length > 0, `${scenario.label} hover pill Expired`).toBe(
        scenario.expectExpired
      );
      grid.unmount();

      // 2. LibrarySidebar row
      const sidebar = createDomain12DeepRenderer(LibrarySidebar, {
        games: [game],
        selectedGameId: null,
        onSelectGame: () => {},
        searchQuery: '',
        onSearchChange: () => {},
        selectedPlatform: 'all',
        onSelectPlatform: () => {},
        installedOnly: false,
        onToggleInstalledOnly: () => {},
        collections: [],
        onOpenManageCollectionsModal: () => {},
        onToggleGameInCollection: () => {},
        connectedStorefronts: ['xbox'],
      });
      const sidebarTree = sidebar.render();
      const sidebarGpSpans = findElements(
        sidebarTree,
        (el) => el.type === 'span' && getTextContent(el).trim() === 'GP'
      );
      const sidebarExpiredSpans = findElements(
        sidebarTree,
        (el) => el.type === 'span' && getTextContent(el).trim() === 'Expired'
      );
      expect(sidebarGpSpans.length > 0, `${scenario.label} sidebar GP`).toBe(scenario.expectGp);
      expect(sidebarExpiredSpans.length > 0, `${scenario.label} sidebar Expired`).toBe(
        scenario.expectExpired
      );
      sidebar.unmount();

      // 3. PlatformBadges ("Owned on:" Xbox badge on SteamStorePage, horizontal + vertical-stacked)
      const badgesHoriz = createDomain12DeepRenderer(PlatformBadges, {
        platforms: game.platforms,
        game,
        size: 'md',
        layout: 'horizontal',
        connectedStorefronts: ['xbox'],
      });
      const horizTree = badgesHoriz.render();
      const horizGpSpans = findElements(
        horizTree,
        (el) => el.type === 'span' && getTextContent(el).trim() === 'GP'
      );
      const horizExpiredSpans = findElements(
        horizTree,
        (el) => el.type === 'span' && getTextContent(el).trim() === 'Expired'
      );
      expect(getTextContent(horizTree)).toContain('Xbox');
      expect(horizGpSpans.length > 0, `${scenario.label} PlatformBadges GP`).toBe(
        scenario.expectGp
      );
      expect(horizExpiredSpans.length > 0, `${scenario.label} PlatformBadges Expired`).toBe(
        scenario.expectExpired
      );
      badgesHoriz.unmount();

      const badgesStacked = createDomain12DeepRenderer(PlatformBadges, {
        platforms: game.platforms,
        game,
        layout: 'vertical-stacked',
        connectedStorefronts: ['xbox'],
      });
      const stackedTree = badgesStacked.render();
      const stackedGpSpans = findElements(
        stackedTree,
        (el) => el.type === 'span' && getTextContent(el).trim() === 'Game Pass'
      );
      expect(stackedGpSpans.length > 0, `${scenario.label} stacked Game Pass`).toBe(
        scenario.expectGp
      );
      badgesStacked.unmount();
    }
  });

  it('Task 3b: downgrades rotated-out owned_and_subscription titles cleanly to owned and clears stale Game Pass metadata across mergeStorefrontGames, mergeUpdatedGamePreservingLivePlatformState, and sanitizeGameCatalog', () => {
    const existingOwnedAndSub = makeCanonicalGameFixture({
      id: 'xbox-9NROTATEGAME',
      title: 'Synthetic Chrono Tactics',
      isVerifiedEntitlement: true,
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9NROTATEGAME',
          xboxProductId: '9NROTATEGAME',
          packageFamilyName: 'ChronoStudio.SyntheticChronoTactics_8wekyb3d8bbwe',
          ownershipType: 'owned_and_subscription',
          gamePassTier: 'PC Game Pass',
          isLeavingSoon: true,
          isRecentlyAddedToGamePass: true,
          subscriptionExpired: false,
          installed: true,
          installPath: '/Users/testuser/Games/OneLauncher/ChronoTactics',
          playtimeMinutes: 185,
        },
      ],
    });

    const incomingOwnedAfterRotation = makeCanonicalGameFixture({
      id: 'xbox-9NROTATEGAME',
      title: 'Synthetic Chrono Tactics',
      isVerifiedEntitlement: true,
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9NROTATEGAME',
          xboxProductId: '9NROTATEGAME',
          packageFamilyName: 'ChronoStudio.SyntheticChronoTactics_8wekyb3d8bbwe',
          ownershipType: 'owned',
          installed: false,
          playtimeMinutes: 185,
        },
      ],
    });

    // 1. mergeStorefrontGames: non-sticky downgrade from 'owned_and_subscription' -> 'owned'
    const mergedCatalog = mergeStorefrontGames(
      [existingOwnedAndSub],
      [incomingOwnedAfterRotation],
      'xbox'
    );
    expect(mergedCatalog).toHaveLength(1);
    const downgradedXboxPlat = mergedCatalog[0].platforms.find((p) => p.platformId === 'xbox')!;
    expect(downgradedXboxPlat.ownershipType).toBe('owned');
    expect(downgradedXboxPlat.gamePassTier).toBeUndefined();
    expect(downgradedXboxPlat.isLeavingSoon).toBeUndefined();
    expect(downgradedXboxPlat.isRecentlyAddedToGamePass).toBeUndefined();
    expect(downgradedXboxPlat.subscriptionExpired).toBe(false);
    expect(downgradedXboxPlat.installed).toBe(true);

    // 2. mergeUpdatedGamePreservingLivePlatformState: live authoritative 'owned' never regresses to stale 'owned_and_subscription'
    const reconciledLive = mergeUpdatedGamePreservingLivePlatformState(
      mergedCatalog[0],
      existingOwnedAndSub
    );
    const reconciledXboxPlat = reconciledLive.platforms.find((p) => p.platformId === 'xbox')!;
    expect(reconciledXboxPlat.ownershipType).toBe('owned');
    expect(reconciledXboxPlat.gamePassTier).toBeUndefined();
    expect(reconciledXboxPlat.isLeavingSoon).toBeUndefined();
    expect(reconciledXboxPlat.isRecentlyAddedToGamePass).toBeUndefined();
    expect(reconciledXboxPlat.subscriptionExpired).toBe(false);

    // 3. sanitizeGameCatalog: strips any leftover Game Pass fields from an 'owned' entry
    const dirtyOwnedGame = makeCanonicalGameFixture({
      id: 'xbox-9NDIRTYOWNED',
      title: 'Synthetic Aether Forge',
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9NDIRTYOWNED',
          xboxProductId: '9NDIRTYOWNED',
          ownershipType: 'owned',
          gamePassTier: 'Ultimate',
          isLeavingSoon: true,
          isRecentlyAddedToGamePass: true,
          subscriptionExpired: true,
          installed: false,
        },
      ],
    });
    const sanitized = sanitizeGameCatalog([dirtyOwnedGame]);
    expect(sanitized).toHaveLength(1);
    const cleanOwnedPlat = sanitized[0].platforms[0];
    expect(cleanOwnedPlat.ownershipType).toBe('owned');
    expect(cleanOwnedPlat.gamePassTier).toBeUndefined();
    expect(cleanOwnedPlat.isLeavingSoon).toBeUndefined();
    expect(cleanOwnedPlat.isRecentlyAddedToGamePass).toBeUndefined();
    expect(cleanOwnedPlat.subscriptionExpired).toBe(false);

    // 4. Confirm downgraded game no longer renders "GP" on PlatformBadges
    const badges = createDomain12DeepRenderer(PlatformBadges, {
      platforms: mergedCatalog[0].platforms,
      game: mergedCatalog[0],
      size: 'md',
      connectedStorefronts: ['xbox'],
    });
    const badgesTree = badges.render();
    const gpSpans = findElements(
      badgesTree,
      (el) => el.type === 'span' && getTextContent(el).trim() === 'GP'
    );
    expect(gpSpans).toHaveLength(0);
    badges.unmount();
  });

  it('Task 3c: classifies plural Collections v6 satisfiedByProductIds / satisfiedEntitlements arrays and preserves permanent "owned" over expired trial / subscription rows across multi-SKU entitlements', async () => {
    const fixedNowMs = Date.parse('2026-06-15T00:00:00Z');

    // Direct classifyXboxEntitlement checks for plural Collections v6 arrays
    const gpPluralIds = xboxCatalogAndGamePass.classifyXboxEntitlement(
      {
        productId: '9NPLURALGP01',
        status: 'Active',
        acquisitionType: 'Recurring',
        satisfiedByProductIds: ['CFQ7TTC0KGQ8'],
        skuId: '0010',
      },
      fixedNowMs
    );
    expect(gpPluralIds.include).toBe(true);
    expect(gpPluralIds.ownershipType).toBe('subscription');
    expect(gpPluralIds.satisfiedByPassIds).toContain('CFQ7TTC0KGQ8');

    const gpPluralEnts = xboxCatalogAndGamePass.classifyXboxEntitlement(
      {
        productId: '9NPLURALGP02',
        status: 'Active',
        satisfiedEntitlements: [{ productId: 'BIG:CFQ7TTC0KHS0:0001' }],
        skuId: '0010',
      },
      fixedNowMs
    );
    expect(gpPluralEnts.include).toBe(true);
    expect(gpPluralEnts.ownershipType).toBe('subscription');
    expect(gpPluralEnts.satisfiedByPassIds).toContain('CFQ7TTC0KHS0');

    const bundleChildPlural = xboxCatalogAndGamePass.classifyXboxEntitlement(
      {
        productId: '9NPLURALCHLD',
        status: 'Active',
        acquisitionType: 'Single',
        satisfiedByProductIds: ['9NPLURALBNDL'],
        skuId: '0010',
      },
      fixedNowMs
    );
    expect(bundleChildPlural.include).toBe(true);
    expect(bundleChildPlural.ownershipType).toBe('owned');
    expect(bundleChildPlural.parentIds).toEqual(['9NPLURALBNDL']);

    // Full fetchXboxOwnedEntitlements via Collections v6 fallback with multi-SKU rows & plural arrays
    const mockFetch = vi.fn(async (urlInput: string | URL) => {
      const url = String(urlInput);
      if (url.includes('/PCGAFD/entitlements')) {
        // Trigger Collections v6 fallback
        return new Response(JSON.stringify({ entitlements: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('collections.mp.microsoft.com/v6.0/collections/query')) {
        return new Response(
          JSON.stringify({
            items: [
              // Multi-SKU Row 1: expired trial for 9NMULTISKU01
              {
                productId: '9NMULTISKU01',
                skuId: '0077',
                status: 'Active',
                isTrial: true,
                acquisitionType: 'Trial',
                endDate: '2024-01-01T00:00:00Z',
              },
              // Multi-SKU Row 2: active purchased 'Single' row for 9NMULTISKU01
              {
                productId: '9NMULTISKU01',
                skuId: '0010',
                status: 'Active',
                isTrial: false,
                acquisitionType: 'Single',
                productKind: 'Game',
              },
              // Multi-SKU Row 3: trailing Game Pass subscription row for 9NMULTISKU01 (must NOT clobber 'owned'!)
              {
                productId: '9NMULTISKU01',
                skuId: '0020',
                status: 'Active',
                isTrial: false,
                satisfiedByProductIds: ['CFQ7TTC0KGQ8'],
                productKind: 'Game',
              },
              // Subscription-only game via plural satisfiedEntitlements (CFQ7TTC0KGQ8)
              {
                productId: '9NCOLSUBGP01',
                skuId: '0010',
                status: 'Active',
                isTrial: false,
                satisfiedEntitlements: [{ productId: 'CFQ7TTC0KGQ8' }],
                productKind: 'Game',
              },
              // Owned root bundle + child game satisfied via plural satisfiedByProductIds
              {
                productId: '9NCOLBNDL001',
                skuId: '0010',
                status: 'Active',
                isTrial: false,
                acquisitionType: 'Single',
                productKind: 'Game',
              },
              {
                productId: '9NCOLCHLD001',
                skuId: '0010',
                status: 'Active',
                isTrial: false,
                satisfiedByProductIds: ['9NCOLBNDL001'],
                productKind: 'Game',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected URL in Collections v6 multi-SKU test: ${url}`);
    });

    const result = await xboxCatalogAndGamePass.fetchXboxOwnedEntitlements({
      storeToken: 'XBL3.0 x=99887766;mp-xsts-synthetic',
      fetchImpl: mockFetch,
      nowMs: fixedNowMs,
    });

    // Multi-SKU product: active purchased 'Single' row (0010) wins over both expired trial & subscription row!
    expect(result.ownedProductIds.has('9NMULTISKU01')).toBe(true);
    expect(result.ownedSkuByProduct.get('9NMULTISKU01')).toBe('0010');
    expect(result.subscriptionSatisfiedIds.has('9NMULTISKU01')).toBe(false);

    // Plural satisfiedEntitlements with CFQ7TTC0KGQ8 -> strictly subscription, NOT owned!
    expect(result.ownedProductIds.has('9NCOLSUBGP01')).toBe(false);
    expect(result.subscriptionSatisfiedIds.has('9NCOLSUBGP01')).toBe(true);
    expect(Array.from(result.subscriptionSatisfiedIds.get('9NCOLSUBGP01') || [])).toContain(
      'CFQ7TTC0KGQ8'
    );

    // Plural satisfiedByProductIds pointing to owned bundle parent -> inherits permanent ownership!
    expect(result.ownedProductIds.has('9NCOLBNDL001')).toBe(true);
    expect(result.ownedProductIds.has('9NCOLCHLD001')).toBe(true);
    expect(result.subscriptionSatisfiedIds.has('9NCOLCHLD001')).toBe(false);
  });
});

// ===========================================================================
// 14. Xbox Connected Storage xgsUserDir Self-Healing, Universal GDK TitleToken/NSAL Auth & Sub-50ms Rating Sort
// ===========================================================================

describe('14. Xbox Connected Storage xgsUserDir Self-Healing, Universal GDK TitleToken/NSAL Auth & Sub-50ms Rating Sort', () => {
  let tmpDir: string;
  let prevWindow: any;
  let prevDocument: any;
  let prevNavigatorDesc: PropertyDescriptor | undefined;
  let prevLocalStorage: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-domain14-test-'));
    prevWindow = (globalThis as any).window;
    prevDocument = (globalThis as any).document;
    prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    prevLocalStorage = (globalThis as any).localStorage;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
    if (prevDocument === undefined) {
      delete (globalThis as any).document;
    } else {
      (globalThis as any).document = prevDocument;
    }
    if (prevNavigatorDesc) {
      Object.defineProperty(globalThis, 'navigator', prevNavigatorDesc);
    }
    if (prevLocalStorage === undefined) {
      delete (globalThis as any).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        value: prevLocalStorage,
        configurable: true,
        writable: true,
      });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Issue 1a: validates TitleStorage container grammar, resolves user-scoped xgsUserDir, self-heals poisoned <HexXuid>_<Scid> containers.index entries, and cleans root xgs duplicates', async () => {
    const xuid = '2535432506000001';
    const scid = '00000000-0000-0000-0000-00006de3bc2f';
    const userScidFolder = xboxTitleStorageSync.formatWgsUserScidFolderName(xuid, scid);
    expect(userScidFolder).toBe('000901F661DF4281_00000000-0000-0000-0000-00006de3bc2f');

    // Grammar validation matches Microsoft TitleStorage v107 rules:
    // directory segments before `/` must be `[A-Za-z0-9_]+` (no hyphens in directory prefixes!)
    expect(xboxTitleStorageSync.isValidTitleStorageContainerName('addons.json')).toBe(true);
    expect(xboxTitleStorageSync.isValidTitleStorageContainerName('kexengine.cfg')).toBe(true);
    expect(xboxTitleStorageSync.isValidTitleStorageContainerName('slot_1/save-01.sav')).toBe(true);
    expect(
      xboxTitleStorageSync.isValidTitleStorageContainerName(`${userScidFolder}/addons.json`)
    ).toBe(false);
    expect(
      xboxTitleStorageSync.isValidTitleStorageContainerName('bad-dir-prefix/save.dat')
    ).toBe(false);
    expect(xboxTitleStorageSync.isValidTitleStorageContainerName('../escape.sav')).toBe(false);

    // Verify resolveXboxSaveLocations returns both wgsUserDir AND user-scoped xgsUserDir
    const prefixPath = path.join(tmpDir, 'Prefixes', 'default');
    const localAppData = path.join(prefixPath, 'drive_c', 'users', 'testuser', 'AppData', 'Local');
    fs.mkdirSync(localAppData, { recursive: true });
    const pfn = 'Publisher.SampleTitle_8wekyb3d8bbwe';
    const locs = cloudSaveEngine.resolveXboxSaveLocations(
      {
        packageFamilyName: pfn,
        xuid,
        scid,
      },
      {
        platform: 'darwin',
        useCompatLayer: true,
        winePrefix: prefixPath,
        localAppData,
      }
    );
    expect(locs).toBeTruthy();
    expect(locs.wgsUserDir).toBe(
      path.join(
        prefixPath,
        'drive_c',
        'users',
        'testuser',
        'AppData',
        'Local',
        'Packages',
        pfn,
        'SystemAppData',
        'wgs',
        userScidFolder
      )
    );
    expect(locs.xgsUserDir).toBe(
      path.join(
        prefixPath,
        'drive_c',
        'users',
        'testuser',
        'AppData',
        'Local',
        'Packages',
        pfn,
        'SystemAppData',
        'xgs',
        userScidFolder
      )
    );

    // Even if a legacy caller passes xgsRootDir (`.../SystemAppData/xgs`), resolveEffectiveXgsUserDir normalizes it!
    expect(
      xboxTitleStorageSync.resolveEffectiveXgsUserDir(locs.xgsRootDir, locs.wgsUserDir)
    ).toBe(locs.xgsUserDir);

    // Seed a poisoned local WGS workspace on disk (exact pre-fix regression state):
    // - `addons.json` clean + poisoned `<HexXuid>_<Scid>/addons.json` duplicate
    // - `<HexXuid>_<Scid>/unique_slot.sav` poisoned-only container that should migrate cleanly to `unique_slot.sav`
    // - stale root `SystemAppData/xgs/addons.json` duplicate directory from pre-fix export
    const addonsPayload = Buffer.from('{"addons":["dop_v1"]}', 'utf8');
    const uniqueSlotPayload = Buffer.from('SAVEDATA_SLOT_UNIQUE', 'utf8');
    await xboxTitleStorageSync.writeLocalWgsWorkspace(locs.wgsUserDir, {
      containers: [
        {
          name: 'addons.json',
          displayName: 'addons.json',
          containerNum: 1,
          dirty: false,
          modifiedIso: '2026-10-27T10:00:00.000Z',
          blobs: [{ name: 'data', data: addonsPayload }],
        },
        {
          name: `${userScidFolder}/addons.json`,
          displayName: `${userScidFolder}/addons.json`,
          containerNum: 2,
          dirty: true,
          modifiedIso: '2026-10-27T11:00:00.000Z',
          blobs: [{ name: 'data', data: addonsPayload }],
        },
        {
          name: `${userScidFolder}/unique_slot.sav`,
          displayName: `${userScidFolder}/unique_slot.sav`,
          containerNum: 3,
          dirty: true,
          modifiedIso: '2026-10-27T11:05:00.000Z',
          blobs: [{ name: 'slot', data: uniqueSlotPayload }],
        },
      ],
    });

    const staleRootDuplicateDir = path.join(locs.xgsRootDir, 'addons.json');
    fs.mkdirSync(staleRootDuplicateDir, { recursive: true });
    fs.writeFileSync(path.join(staleRootDuplicateDir, 'data'), addonsPayload);

    // Stand up a strict TitleStorage v107 HTTP mock server that returns HTTP 400 code 2000
    // if ANY container manifest path contains a hyphenated directory prefix!
    const uploadedManifestNames: string[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const reqUrl = decodeURIComponent(req.url || '/');
        if (reqUrl.includes('/lock') && req.method === 'PUT') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ quotaBytes: 268435456 }));
          return;
        }
        if (reqUrl.includes('/lock') && req.method === 'DELETE') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (reqUrl.includes('/scids/') && req.method === 'GET' && !reqUrl.includes(',savedgame') && !reqUrl.includes(',binary')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ blobs: [] }));
          return;
        }
        if (reqUrl.includes(',binary') && req.method === 'PUT') {
          res.writeHead(201);
          res.end();
          return;
        }
        if (reqUrl.includes(',savedgame') && req.method === 'PUT') {
          const match = reqUrl.match(/\/scids\/[^/]+\/(.+),savedgame/);
          const containerName = match ? match[1] : '';
          if (!xboxTitleStorageSync.isValidTitleStorageContainerName(containerName)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 2000, description: 'File name is not valid.' }));
            return;
          }
          uploadedManifestNames.push(containerName);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    const serverOrigin = `http://127.0.0.1:${port}`;

    try {
      const syncRes = await cloudSaveEngine.syncXboxCloudSaves(
        {
          gameId: 'xbox-9N9999SYNTH1',
          packageFamilyName: pfn,
          scid,
        },
        'post_exit',
        {
          platform: 'darwin',
          useCompatLayer: true,
          winePrefix: prefixPath,
          localAppData,
          userDataDir: path.join(tmpDir, 'userData'),
          xboxSession: {
            xuid,
            authorizationHeader: `XBL3.0 x=${xuid};mock_xsts`,
          },
          titleStorageOrigin: serverOrigin,
        }
      );

      expect(syncRes.synced).toBe(true);
      expect(uploadedManifestNames).toEqual(['unique_slot.sav']);

      // Verify poisoned containers are purged from containers.index and unique_slot.sav migrated cleanly!
      const healedWs = await xboxTitleStorageSync.readLocalWgsWorkspace(locs.wgsUserDir);
      expect(Array.from(healedWs.containers.keys()).sort()).toEqual([
        'addons.json',
        'unique_slot.sav',
      ]);
      expect(healedWs.containers.get('unique_slot.sav')?.dirty).toBe(false);
      expect(
        healedWs.containers.get('unique_slot.sav')?.blobs.get('slot')?.data.equals(uniqueSlotPayload)
      ).toBe(true);

      // Verify stale root duplicate `SystemAppData/xgs/addons.json` was cleaned on post_exit,
      // and pre_launch exports cleanly into user-scoped `xgs/<HexXuid>_<Scid>/`!
      expect(fs.existsSync(staleRootDuplicateDir)).toBe(false);
      await xboxTitleStorageSync.exportWgsToXgsFolder(locs.wgsUserDir, locs.xgsRootDir);
      expect(fs.existsSync(staleRootDuplicateDir)).toBe(false);
      expect(fs.existsSync(path.join(locs.xgsUserDir, 'addons.json', 'data'))).toBe(true);
      expect(fs.existsSync(path.join(locs.xgsUserDir, 'unique_slot.sav', 'slot'))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('Issue 1b: fault-isolates per-container upload failures so valid dirty containers still upload and post_exit rolling backup is preserved on error', async () => {
    const xuid = '2535432506000002';
    const scid = '00000000-0000-0000-0000-00006de3bc2f';
    const prefixPath = path.join(tmpDir, 'Prefixes', 'fault');
    const localAppData = path.join(prefixPath, 'drive_c', 'users', 'testuser', 'AppData', 'Local');
    fs.mkdirSync(localAppData, { recursive: true });
    const userDataDir = path.join(tmpDir, 'userDataFault');
    const pfn = 'Publisher.FaultIsolation_8wekyb3d8bbwe';
    const locs = cloudSaveEngine.resolveXboxSaveLocations(
      {
        packageFamilyName: pfn,
        xuid,
        scid,
      },
      {
        platform: 'darwin',
        useCompatLayer: true,
        winePrefix: prefixPath,
        localAppData,
      }
    );

    await xboxTitleStorageSync.writeLocalWgsWorkspace(locs.wgsUserDir, {
      containers: [
        {
          name: 'good_slot.sav',
          displayName: 'good_slot.sav',
          containerNum: 1,
          dirty: true,
          modifiedIso: '2026-10-27T12:00:00.000Z',
          blobs: [{ name: 'save', data: Buffer.from('GOOD_SAVE_BYTES', 'utf8') }],
        },
        {
          name: 'transient_fail_slot.sav',
          displayName: 'transient_fail_slot.sav',
          containerNum: 2,
          dirty: true,
          modifiedIso: '2026-10-27T12:01:00.000Z',
          blobs: [{ name: 'save', data: Buffer.from('RETRY_LATER_BYTES', 'utf8') }],
        },
      ],
    });

    const uploadedContainers: string[] = [];
    const server = http.createServer((req, res) => {
      const reqUrl = decodeURIComponent(req.url || '/');
      req.resume();
      req.on('end', () => {
        if (reqUrl.includes('/lock') && req.method === 'PUT') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ quotaBytes: 268435456 }));
          return;
        }
        if (reqUrl.includes('/lock') && req.method === 'DELETE') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (reqUrl.includes('/scids/') && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ blobs: [] }));
          return;
        }
        if (reqUrl.includes(',binary') && req.method === 'PUT') {
          res.writeHead(201);
          res.end();
          return;
        }
        if (reqUrl.includes(',savedgame') && req.method === 'PUT') {
          if (reqUrl.includes('transient_fail_slot.sav')) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 5003, description: 'Backend busy' }));
            return;
          }
          uploadedContainers.push('good_slot.sav');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const syncRes = await cloudSaveEngine.syncXboxCloudSaves(
        {
          gameId: 'xbox-fault-isolation',
          packageFamilyName: pfn,
          scid,
        },
        'post_exit',
        {
          platform: 'darwin',
          useCompatLayer: true,
          winePrefix: prefixPath,
          localAppData,
          userDataDir,
          xboxSession: {
            xuid,
            authorizationHeader: `XBL3.0 x=${xuid};mock_xsts`,
          },
          titleStorageOrigin: `http://127.0.0.1:${port}`,
        }
      );

      expect(syncRes.synced).toBe(false);
      expect(uploadedContainers).toEqual(['good_slot.sav']);
      // Post-exit local rolling backup MUST still be created even when cloud upload throws!
      expect(typeof syncRes.backupPath).toBe('string');
      expect(fs.existsSync(syncRes.backupPath)).toBe(true);

      // `good_slot.sav` was persisted as dirty=false while `transient_fail_slot.sav` stays dirty=true for next retry
      const wsAfter = await xboxTitleStorageSync.readLocalWgsWorkspace(locs.wgsUserDir);
      expect(wsAfter.containers.get('good_slot.sav')?.dirty).toBe(false);
      expect(wsAfter.containers.get('transient_fail_slot.sav')?.dirty).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('Issue 2: mints hardware-bound TitleToken via RST2 TOKEN_BROKER + title.auth.xboxlive.com, signs NSAL endpoint discovery without caching HTTP 500s, resolves wildcard/default/PlayFab relying parties, and normalizes 8-hex loopback TitleIds', async () => {
    const futureIso = new Date(Date.now() + 6 * 3600_000).toISOString();
    const { privateKeyPem, publicKeyPem, proofKeyJwk } = xboxAuthManager.generateXboxProofKeyPair();
    const { privateKey: rsaPrivPem } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const syntheticClepBinarySecretB64 = Buffer.alloc(284, 0x42).toString('base64');

    const vaultMap = new Map<string, any>();
    vaultMap.set('xbox', {
      xblAccessToken: 'delegated_user_access_ticket',
      xblRefreshToken: 'refresh_token_1',
      xblExpiresAt: futureIso,
      xblUserToken: 'user_jwt_token',
      xblUserNotAfter: futureIso,
      xstsXboxLiveToken: 'base_livesdk_xsts_jwt',
      xstsXboxLiveNotAfter: futureIso,
      uhs: '777888999000',
      xuid: '2535432506000099',
      gamertag: 'VaultTester',
      gamerpicUrl: 'https://images-eds-ssl.xboxlive.com/image?url=synthetic',
      proofPrivateKeyPem: privateKeyPem,
      proofPublicKeyPem: publicKeyPem,
      proofKeyJwk,
      deviceContext: {
        deviceMembername: '0299887766554433@device.auth.xboxlive.com',
        devicePassword: 'synthetic_device_pwd',
        deviceToken: 't=device_xbl_rps_ticket',
        deviceDat: 't=device_ms_store_ticket',
        deviceMsToken: 't=device_ms_store_ticket',
        deviceDatExpiresAt: futureIso,
        deviceLegacyTokenXml:
          '<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#" Id="Assertion0"><CipherData><CipherValue>U1lOVEhFVElD</CipherValue></CipherData></EncryptedData>',
        deviceBinarySecretB64: syntheticClepBinarySecretB64,
        deviceLegacyExpiresAt: futureIso,
        deviceKeyHex: '00112233445566778899aabbccddeeff',
        clepRsaKeyPem: rsaPrivPem,
      },
    });

    const memVault = {
      loadSavedTokens: () => Object.fromEntries(vaultMap.entries()),
      saveTokens: (k: string, v: any) => {
        vaultMap.set(k, v);
        return true;
      },
      loadTokenRecord: (k: string) => vaultMap.get(k) ?? null,
      saveTokenRecord: (k: string, v: any) => {
        vaultMap.set(k, v);
        return true;
      },
      clearTokenRecord: (k: string) => vaultMap.delete(k),
      getHardwareFingerprint: () => Buffer.alloc(32, 0x55),
    };

    const capturedRst2Scopes: string[] = [];
    const capturedTitleAuthBodies: any[] = [];
    const capturedXstsRequests: any[] = [];
    let currentEndpointsAttempt = 0;

    const authFetch = vi.fn(async (reqUrl: string, init: any) => {
      const bodyText = String(init?.body || '');

      if (reqUrl.includes('login.live.com/RST2.srf')) {
        const matchScope = bodyText.match(/<wsa:Address>([^<]+)<\/wsa:Address>/);
        const scopeStr = (matchScope ? matchScope[1] : '').replace(/&amp;/g, '&');
        capturedRst2Scopes.push(scopeStr);
        const rstrXml =
          `<S:Envelope xmlns:S="http://www.w3.org/2003/05/soap-envelope" xmlns:wst="http://schemas.xmlsoap.org/ws/2005/02/trust" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">` +
          `<S:Body><wst:RequestSecurityTokenResponseCollection><wst:RequestSecurityTokenResponse>` +
          `<wst:Lifetime><wsu:Expires>${futureIso}</wsu:Expires></wst:Lifetime>` +
          `<wst:RequestedSecurityToken><wsse:BinarySecurityToken Id="Compact0">d=broker_ticket_for_${encodeURIComponent(scopeStr)}&amp;p=</wsse:BinarySecurityToken></wst:RequestedSecurityToken>` +
          `</wst:RequestSecurityTokenResponse></wst:RequestSecurityTokenResponseCollection></S:Body></S:Envelope>`;
        return new Response(rstrXml, {
          status: 200,
          headers: { 'Content-Type': 'application/soap+xml' },
        });
      }

      if (reqUrl === 'https://device.auth.xboxlive.com/device/authenticate') {
        return new Response(
          JSON.stringify({
            Token: 'rps_device_jwt_token',
            NotAfter: futureIso,
            DisplayClaims: { xdi: { did: 'F700112233445566' } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (reqUrl === 'https://title.auth.xboxlive.com/title/authenticate') {
        const parsed = JSON.parse(bodyText);
        capturedTitleAuthBodies.push(parsed);
        expect(typeof init?.headers?.Signature).toBe('string');
        expect(
          xboxAuthManager.verifyXboxRequestSignature({
            signatureBase64: init.headers.Signature,
            method: 'POST',
            url: reqUrl,
            authorizationHeader: '',
            body: bodyText,
            ecPublicKey: publicKeyPem,
          })
        ).toBe(true);

        const isUuidApp = String(parsed?.Properties?.RpsTicket || '').includes(
          '11111111-2222-3333-4444-555555555555'
        );
        return new Response(
          JSON.stringify({
            Token: isUuidApp ? 'uuid_title_jwt_token' : 'hex_title_jwt_token',
            NotAfter: futureIso,
            DisplayClaims: {
              xti: { tid: isUuidApp ? '2099887766' : '1843641391' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (reqUrl === 'https://title.mgt.xboxlive.com/titles/current/endpoints') {
        currentEndpointsAttempt += 1;
        // Verify mandatory IEEE P1363 Signature + title-bound XBL3.0 Authorization header!
        expect(typeof init?.headers?.Signature).toBe('string');
        expect(String(init?.headers?.Authorization || '')).toContain('title_bound_xbl_xsts');
        expect(
          xboxAuthManager.verifyXboxRequestSignature({
            signatureBase64: init.headers.Signature,
            method: 'GET',
            url: reqUrl,
            authorizationHeader: init.headers.Authorization,
            body: Buffer.alloc(0),
            ecPublicKey: publicKeyPem,
          })
        ).toBe(true);

        // First call returns transient HTTP 500 to verify failed NSAL lookups are NEVER cached!
        if (currentEndpointsAttempt === 1) {
          return new Response('Internal Server Error', { status: 500 });
        }

        return new Response(
          JSON.stringify({
            EndPoints: [
              {
                Protocol: 'https',
                Host: '*.publisher-services.example',
                HostType: 'wildcard',
                RelyingParty: 'http://partner-rp.publisher.example/',
                TokenType: 'JWT',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (reqUrl.startsWith('https://title.mgt.xboxlive.com/titles/1843641391/endpoints')) {
        return new Response('Forbidden without current', { status: 403 });
      }

      if (reqUrl.startsWith('https://title.mgt.xboxlive.com/titles/default/endpoints')) {
        expect(typeof init?.headers?.Signature).toBe('string');
        return new Response(
          JSON.stringify({
            EndPoints: [
              {
                Protocol: 'https',
                Host: 'inventory.xboxlive.com',
                HostType: 'fqdn',
                RelyingParty: 'http://licensing.xboxlive.com',
                TokenType: 'JWT',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (reqUrl === 'https://xsts.auth.xboxlive.com/xsts/authorize') {
        const parsed = JSON.parse(bodyText);
        capturedXstsRequests.push(parsed);
        const rp = parsed.RelyingParty;
        const tokLabel =
          rp === 'http://xboxlive.com' && parsed.Properties?.TitleToken
            ? 'title_bound_xbl_xsts'
            : `xsts_for_${encodeURIComponent(rp)}`;
        return new Response(
          JSON.stringify({
            Token: tokLabel,
            NotAfter: futureIso,
            DisplayClaims: {
              xui: [{ uhs: '777888999000', xid: '2535432506000099', gtg: 'VaultTester' }],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL in Domain 14 Issue 2 test: ${reqUrl}`);
    });

    const provider = xboxAuthManager.createXboxAuthProvider({
      tokenVault: memVault,
      userDataDir: tmpDir,
      fetchImpl: authFetch,
    });

    // 1. Test Loopback Server `session.init` 8-hex-to-decimal TitleId normalization (`6DE3BC2F` -> `1843641391`)
    // and full RPC roundtrip (`xuser.getTokenAndSignature`).
    const loopback = await xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
      authProvider: provider,
      userProfile: { xuid: '2535432506000099', gamertag: 'VaultTester' },
    });

    const sendRpc = (method: string, params: Record<string, any>) =>
      new Promise<any>((resolve, reject) => {
        const sock = net.createConnection({ host: '127.0.0.1', port: loopback.port }, () => {
          sock.write(
            xboxRuntimeLoopbackServer.encodeRpcFrame({
              id: 1,
              key: loopback.sessionKey,
              method,
              params,
            })
          );
        });
        let buf = Buffer.alloc(0);
        sock.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          if (buf.length >= 4) {
            const len = buf.readUInt32LE(0);
            if (buf.length >= 4 + len) {
              const resp = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
              sock.end();
              resolve(resp);
            }
          }
        });
        sock.on('error', reject);
      });

    try {
      const initResp = await sendRpc('session.init', {
        titleId: '6DE3BC2F',
        scid: '00000000-0000-0000-0000-000012345678',
        msaAppId: '0000000012345678',
        packageFamilyName: 'Publisher.Title_8wekyb3d8bbwe',
      });
      expect(initResp.ok).toBe(true);
      expect(initResp.result.titleId).toBe('6DE3BC2F');
      expect(initResp.result.titleIdDecimal).toBe('1843641391');

      // Attempt 1 hits transient 500 on `titles/current/endpoints` -> does NOT poison NSAL cache!
      await sendRpc('xuser.getTokenAndSignature', {
        method: 'POST',
        url: 'https://api.publisher-services.example/beam/external-login',
      });
      expect(currentEndpointsAttempt).toBe(1);

      // Attempt 2 retries `titles/current/endpoints`, succeeds, matches `*.publisher-services.example`
      // -> mints XSTS with RelyingParty = `http://partner-rp.publisher.example/` + `TitleToken`!
      const secondTokenResp = await sendRpc('xuser.getTokenAndSignature', {
        method: 'POST',
        url: 'https://api.publisher-services.example/beam/external-login',
      });
      expect(currentEndpointsAttempt).toBe(2);
      expect(secondTokenResp.ok).toBe(true);
      expect(secondTokenResp.result.token).toBe(
        `XBL3.0 x=777888999000;xsts_for_${encodeURIComponent('http://partner-rp.publisher.example/')}`
      );

      // Verify RST2 TOKEN_BROKER used the game's 16-hex MSAAppId and title.auth received RpsTicket + DeviceToken
      expect(
        capturedRst2Scopes.some((s) =>
          s.includes(
            'scope=service::user.auth.xboxlive.com::MBI_SSL&clientid=0000000012345678&api-version=2.0'
          )
        )
      ).toBe(true);
      expect(capturedTitleAuthBodies[0]?.Properties?.DeviceToken).toBe('rps_device_jwt_token');
      expect(capturedTitleAuthBodies[0]?.Properties?.RpsTicket).toMatch(/^d=broker_ticket_for_/);

      const partnerXstsReq = capturedXstsRequests.find(
        (r) => r.RelyingParty === 'http://partner-rp.publisher.example/'
      );
      expect(partnerXstsReq?.Properties?.TitleToken).toBe('hex_title_jwt_token');
      expect(partnerXstsReq?.Properties?.DeviceToken).toBe('rps_device_jwt_token');

      // 2. Verify modern UUID MSAAppId works identically on `getTitleAuthSession`
      const uuidTitleSession = await provider.getTitleAuthSession({
        msaAppId: '11111111-2222-3333-4444-555555555555',
        titleId: '2099887766',
      });
      expect(uuidTitleSession.titleId).toBe('2099887766');
      expect(uuidTitleSession.titleToken).toBe('uuid_title_jwt_token');

      // 3. Verify System Default NSAL (`inventory.xboxlive.com` -> `http://licensing.xboxlive.com`)
      // runs BEFORE generic `*.xboxlive.com` fallback!
      const invRes = await provider.getTokenAndSignatureForUrl({
        url: 'https://inventory.xboxlive.com/users/me/consumables',
        msaAppId: '0000000012345678',
        titleId: '6DE3BC2F',
      });
      expect(invRes.relyingParty).toBe('http://licensing.xboxlive.com');

      // 4. Verify PlayFab fallback (`https://6de3bc2f.playfabapi.com/Client/LoginWithXbox` -> `https://playfabapi.com/`)
      const pfRes = await provider.getTokenAndSignatureForUrl({
        url: 'https://12345678.playfabapi.com/Client/LoginWithXbox',
        msaAppId: '0000000012345678',
        titleId: '6DE3BC2F',
      });
      expect(pfRes.relyingParty).toBe('https://playfabapi.com/');
    } finally {
      await loopback.close();
    }
  });

  it('Issue 2b: rejects SISU fallback TitleToken when SISU returns LiveSDK tid (1794566092) instead of the game TitleId', async () => {
    const futureIso = new Date(Date.now() + 4 * 3600_000).toISOString();
    const { privateKeyPem, publicKeyPem, proofKeyJwk } = xboxAuthManager.generateXboxProofKeyPair();
    const vaultMap = new Map<string, any>([
      [
        'xbox',
        {
          xblAccessToken: 'livesdk_access_token',
          xblExpiresAt: futureIso,
          userToken: 'user_jwt',
          userTokenNotAfter: futureIso,
          xstsToken: 'base_xsts',
          xstsNotAfter: futureIso,
          uhs: '111222333',
          xuid: '2535432506000088',
          gamertag: 'SisuGuardTester',
          proofPrivateKeyPem: privateKeyPem,
          proofPublicKeyPem: publicKeyPem,
          proofKeyJwk,
        },
      ],
    ]);
    const memVault = {
      loadSavedTokens: () => Object.fromEntries(vaultMap.entries()),
      saveTokens: (k: string, v: any) => {
        vaultMap.set(k, v);
        return true;
      },
      loadTokenRecord: (k: string) => vaultMap.get(k) ?? null,
      saveTokenRecord: (k: string, v: any) => {
        vaultMap.set(k, v);
        return true;
      },
      clearTokenRecord: (k: string) => vaultMap.delete(k),
      getHardwareFingerprint: () => Buffer.alloc(32, 0x33),
    };

    const mockFetch = vi.fn(async (reqUrl: string) => {
      if (reqUrl.includes('device.auth.xboxlive.com')) {
        return new Response(
          JSON.stringify({
            Token: 'pop_device_jwt',
            NotAfter: futureIso,
            DisplayClaims: { xdi: { did: 'F70099' } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (reqUrl.includes('sisu.xboxlive.com/authorize')) {
        // Simulates Microsoft SISU returning LiveSDK's tid (1794566092) when AccessToken belongs to LiveSDK!
        return new Response(
          JSON.stringify({
            DeviceToken: 'pop_device_jwt',
            TitleToken: {
              Token: 'wrong_livesdk_title_token',
              NotAfter: futureIso,
              DisplayClaims: { xti: { tid: '1794566092' } },
            },
            UserToken: { Token: 'user_jwt', NotAfter: futureIso },
            AuthorizationToken: {
              Token: 'wrong_livesdk_xsts',
              NotAfter: futureIso,
              DisplayClaims: { xui: [{ uhs: '111222333', xid: '2535432506000088', gtg: 'SisuGuardTester' }] },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Force primary device provisioning to fail so guarded SISU fallback is evaluated
      return new Response('Offline device add', { status: 503 });
    });

    const provider = xboxAuthManager.createXboxAuthProvider({
      tokenVault: memVault,
      userDataDir: tmpDir,
      fetchImpl: mockFetch,
    });

    await expect(
      provider.getTitleAuthSession({
        msaAppId: '0000000012345678',
        titleId: '6DE3BC2F', // decimal 1843641391 !== 1794566092
      })
    ).rejects.toThrow();
  });

  it('Issue 3: sorts 1,320 games by Rating in LibraryGridView in < 50ms with zero repeat JSON.parse calls, exact tie-breaker parity, and live update reactivity', () => {
    const memStorage = createMemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: memStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true, userAgent: 'OneLauncherTest/1.0' },
      configurable: true,
    });
    (globalThis as any).document = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      elementFromPoint: () => null,
      createElement: (tag: string) => new Domain12HTMLElement(tag),
      createDocumentFragment: () => new Domain12DocumentFragment(),
    };
    const windowListeners = new Map<string, Set<(ev?: any) => void>>();
    (globalThis as any).window = {
      innerWidth: 1440,
      innerHeight: 900,
      localStorage: memStorage,
      location: { hostname: 'one-launcher.local', port: '', protocol: 'app:' },
      addEventListener: (type: string, fn: (ev?: any) => void) => {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: (ev?: any) => void) => {
        windowListeners.get(type)?.delete(fn);
      },
      dispatchEvent: (ev: any) => {
        const set = windowListeners.get(ev?.type);
        if (set) for (const fn of set) fn(ev);
        return true;
      },
      electronAPI: { platform: 'darwin', openExternal: vi.fn() },
    };

    vi.spyOn(launcherService, 'isGameRunning').mockReturnValue(false);
    vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(false);
    vi.spyOn(launcherService, 'getRunningGames').mockReturnValue([]);

    // Populate 1,320 games (> 1,200 in-memory LRU cap, exercising stagedCacheService + filterIndex)
    const totalGames = 1320;
    const games: CanonicalGame[] = [];
    for (let i = 0; i < totalGames; i++) {
      const appId = 700000 + i;
      const title =
        i === 0
          ? 'TieBreaker Beta'
          : i === 1
            ? 'tiebreaker alpha'
            : i === 2
              ? 'TieBreaker HigherRec'
              : `Synthetic Catalog Entry ${String(i).padStart(4, '0')}`;
      const score = i < 3 ? 91 : (i * 17) % 90; // Top 3 all share score=91!
      const pctRec = i === 2 ? 98 : i < 2 ? 85 : (i * 13) % 100;

      saveStagedCache(
        `antigravity_critic_v8_id:${appId}`,
        {
          score,
          percentRecommended: pctRec,
          tier: score >= 84 ? 'Mighty' : 'Strong',
          numReviews: 42,
          source: 'opencritic',
          matchedTitle: title,
          isVerified: true,
          lastUpdated: Date.now(),
        },
        'immutable'
      );

      games.push(
        makeCanonicalGameFixture({
          id: `game_${i}`,
          title,
          steamAppId: appId,
          platforms: [
            {
              platformId: i % 2 === 0 ? 'xbox' : 'steam',
              platformGameId: String(appId),
              installed: false,
            },
          ],
        })
      );
    }

    // Build shared filter index once (just like App.tsx does on library state)
    const filterIndex = buildLibraryFilterIndex(games);

    // Temporarily unset VITEST so LibraryGridView uses the real Electron browser viewport slice
    // while `sortedGames` sorts all 1,320 catalog items!
    const prevVitestEnv = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const jsonParseSpy = vi.spyOn(JSON, 'parse');
      const grid = createDomain12DeepRenderer(LibraryGridView, {
        games,
        libraryFilterIndex: filterIndex,
        sortBy: 'alphabetical',
        onSelectGame: () => {},
        connectedStorefronts: ['xbox', 'steam'],
      });
      grid.render();
      jsonParseSpy.mockClear();

      // Switch sort from 'alphabetical' -> 'rating' (exact user interaction in cover art grid view!)
      const t0 = performance.now();
      const rendered = grid.render({ sortBy: 'rating' });
      const sortRenderMs = performance.now() - t0;

      expect(jsonParseSpy).toHaveBeenCalledTimes(0);
      expect(sortRenderMs).toBeLessThan(50);

      // Verify exact tie-breaker order at the top of the grid:
      // 1. `game_2` (score 91, percentRecommended 98)
      // 2. `game_1` (`tiebreaker alpha`, score 91, percentRecommended 85)
      // 3. `game_0` (`TieBreaker Beta`, score 91, percentRecommended 85)
      const cardNodes = findElements(
        rendered,
        (el) => typeof el.props?.['data-game-id'] === 'string'
      );
      expect(cardNodes.slice(0, 3).map((el) => el.props['data-game-id'])).toEqual([
        'game_2',
        'game_1',
        'game_0',
      ]);

      // Verify direct localStorage mutation coherence on `loadStagedCache` + live `antigravity_critic_updated` reactivity!
      const promotedAppId = 700000 + 500;
      memStorage.setItem(
        `antigravity_critic_v8_id:${promotedAppId}`,
        JSON.stringify({
          version: STAGED_CACHE_VERSION,
          cachedAt: Date.now(),
          ttlMs: 180 * 24 * 60 * 60 * 1000,
          tier: 'immutable',
          data: {
            score: 99,
            percentRecommended: 100,
            tier: 'Mighty',
            numReviews: 120,
            source: 'opencritic',
            matchedTitle: 'Synthetic Catalog Entry 0500',
            isVerified: true,
            lastUpdated: Date.now(),
          },
        })
      );
      expect(
        loadStagedCache<any>(`antigravity_critic_v8_id:${promotedAppId}`)?.data?.score
      ).toBe(99);
      criticScoreService.clearCache();
      (globalThis as any).window.dispatchEvent({
        type: 'antigravity_critic_updated',
        detail: { immediate: true },
      });

      const rerendered = grid.render();
      const updatedCardNodes = findElements(
        rerendered,
        (el) => typeof el.props?.['data-game-id'] === 'string'
      );
      expect(updatedCardNodes[0].props['data-game-id']).toBe('game_500');

      grid.unmount();
    } finally {
      if (prevVitestEnv !== undefined) {
        process.env.VITEST = prevVitestEnv;
      }
    }
  });
});

