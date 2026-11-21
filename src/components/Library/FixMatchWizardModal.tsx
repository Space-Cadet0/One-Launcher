import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { StorefrontId } from '../../contracts/platform';
import {
  UserGameOverride,
  SearchMatchCandidate,
  ScrapedMetadataBundle,
  ScrapedCoverOption,
  MetadataSourceOption,
  MetadataSourceRoute,
  ReviewScoreRoute,
} from '../../contracts/override';
import {
  metadataScraperService,
  isXboxStoreCandidateId,
} from '../../services/scraper/metadataScraperService';
import { ModalShell } from '../Common/ModalShell';
import {
  reviewCandidateService,
  ReviewCandidateOption,
} from '../../services/scraper/reviewCandidateService';
import { CriticScoreData, CriticSource } from '../../contracts/critic';
import { sanitizeAllowedStoreUri } from '../../services/common/htmlSanitizer';
import { syncJobManager } from '../../services/network/syncJobManager';
import { useSafeId } from '../../utils/useSafeId';
import {
  formatMatchPercentage,
  isGameSplittingFromMerged,
  resolveWizardMatchedStore,
  resolveWizardMetadataRouteSource,
  SourceFilterTab,
  WizardStep,
} from './FixMatch/fixMatchTypes';
import {
  buildCustomReviewState,
  filterAndDeduplicateCovers,
  mergeDeduplicatedMetadataSources,
  resolveDiscoveredReviewSelection,
  toReviewScoreDataFromOption,
} from './FixMatch/fixMatchWizardHelpers';
import {
  renderFixMatchWizardFooter,
  renderFixMatchWizardHeader,
  renderFixMatchWizardStepper,
} from './FixMatch/FixMatchWizardChrome';
import { renderFixMatchCandidateStep } from './FixMatch/FixMatchCandidateStep';
import { renderFixMatchCoverStep } from './FixMatch/FixMatchCoverStep';
import { renderFixMatchReviewStep } from './FixMatch/FixMatchReviewStep';
import { renderFixMatchMetadataStep } from './FixMatch/FixMatchMetadataStep';

export { formatMatchPercentage };
export type { WizardStep, SourceFilterTab };

export interface FixMatchWizardModalProps {
  isOpen: boolean;
  game: CanonicalGame | null;
  onClose: () => void;
  onApplyOverride: (override: UserGameOverride) => void;
  onResetOverride?: (
    gameId: string,
    context?: { game?: CanonicalGame | null; override?: UserGameOverride | null }
  ) => void;
  onHideGame?: (game: CanonicalGame, targetPlatformId?: StorefrontId) => void;
  existingOverride?: UserGameOverride;
  initialStep?: WizardStep;
  initialCandidate?: SearchMatchCandidate | null;
  initialScrapedBundle?: ScrapedMetadataBundle | null;
  initialReviewCandidates?: ReviewCandidateOption[];
  initialSelectedReviewOptionId?: string;
  initialSelectedReviewData?: CriticScoreData | null;
  initialCustomScoreValue?: number | string;
  initialCustomScoreSource?: CriticSource;
  initialCustomScoreUrl?: string;
  initialCustomScoreSummary?: string;
  initialCustomScoreNumReviews?: number | string;
}

export const FixMatchWizardModal: React.FC<FixMatchWizardModalProps> = ({
  isOpen,
  game,
  onClose,
  onApplyOverride,
  onResetOverride,
  onHideGame,
  existingOverride,
  initialStep,
  initialCandidate,
  initialScrapedBundle,
  initialReviewCandidates,
  initialSelectedReviewOptionId,
  initialSelectedReviewData,
  initialCustomScoreValue,
  initialCustomScoreSource,
  initialCustomScoreUrl,
  initialCustomScoreSummary,
  initialCustomScoreNumReviews,
}) => {
  const titleId = useSafeId('fix-match-wizard-title');

  const [step, setStep] = useState<WizardStep>(initialStep || 1);
  const [searchTerm, setSearchTerm] = useState('');
  const [sourceTab, setSourceTab] = useState<SourceFilterTab>('All');
  const [notOnSteamOnly, setNotOnSteamOnly] = useState(false);

  // Step 1: Candidate discovery state
  const [candidates, setCandidates] = useState<SearchMatchCandidate[]>([]);
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<SearchMatchCandidate | null>(
    initialCandidate || null
  );

  // Step 2: Cover art state & independent cover search
  const [isScrapingDetails, setIsScrapingDetails] = useState(false);
  const [scrapedBundle, setScrapedBundle] = useState<ScrapedMetadataBundle | null>(
    initialScrapedBundle || null
  );
  const [selectedCoverUrl, setSelectedCoverUrl] = useState<string>(
    initialScrapedBundle?.capsuleImage || ''
  );
  const [coverSearchTerm, setCoverSearchTerm] = useState<string>(
    initialScrapedBundle?.title || initialCandidate?.title || game?.title || ''
  );
  const [coverSourceTab, setCoverSourceTab] = useState<SourceFilterTab>('All');
  const [extraCovers, setExtraCovers] = useState<ScrapedCoverOption[]>([]);
  const [isSearchingCovers, setIsSearchingCovers] = useState<boolean>(false);

  // Step 4: Metadata switcher & active metadata fields
  const [selectedBlurb, setSelectedBlurb] = useState<string>(
    initialScrapedBundle?.shortDescription || ''
  );
  const [customTitle, setCustomTitle] = useState<string>(
    initialScrapedBundle?.title || game?.title || ''
  );
  const [metadataSources, setMetadataSources] = useState<MetadataSourceOption[]>(
    initialScrapedBundle?.availableMetadataSources || []
  );
  const [selectedMetadataSourceId, setSelectedMetadataSourceId] = useState<string>(
    initialScrapedBundle?.availableMetadataSources?.[0]?.id || ''
  );
  const [metadataSearchTerm, setMetadataSearchTerm] = useState<string>(
    initialScrapedBundle?.title || game?.title || ''
  );
  const [isSearchingMetadataSources, setIsSearchingMetadataSources] = useState<boolean>(false);
  const [activeReleaseDate, setActiveReleaseDate] = useState<string>(
    initialScrapedBundle?.releaseDate || ''
  );
  const [activeDevelopers, setActiveDevelopers] = useState<string[]>(
    initialScrapedBundle?.developers || []
  );
  const [activePublishers, setActivePublishers] = useState<string[]>(
    initialScrapedBundle?.publishers || []
  );
  const [activeGenres, setActiveGenres] = useState<string[]>(
    initialScrapedBundle?.genres || []
  );
  const [activeTags, setActiveTags] = useState<string[]>(initialScrapedBundle?.tags || []);
  const [activeHeaderImage, setActiveHeaderImage] = useState<string>(
    initialScrapedBundle?.headerImage || ''
  );
  const [activeAvailableDescriptions, setActiveAvailableDescriptions] = useState<
    { source: string; text: string }[]
  >(initialScrapedBundle?.availableDescriptions || []);

  // Step 3: Review score & source candidate discovery state
  const [reviewCandidates, setReviewCandidates] = useState<ReviewCandidateOption[]>(
    initialReviewCandidates || []
  );
  const [isLoadingReviews, setIsLoadingReviews] = useState(false);
  const [selectedReviewOptionId, setSelectedReviewOptionId] = useState<string>(
    initialSelectedReviewOptionId || ''
  );
  const [selectedReviewData, setSelectedReviewData] = useState<CriticScoreData | null>(
    initialSelectedReviewData || null
  );
  const [reviewSearchTerm, setReviewSearchTerm] = useState<string>(
    initialScrapedBundle?.title || initialCandidate?.title || game?.title || ''
  );
  const [selectedReviewRoute, setSelectedReviewRoute] = useState<ReviewScoreRoute | undefined>(
    undefined
  );

  // Custom score input state
  const [customScoreValue, setCustomScoreValue] = useState<number | string>(
    initialCustomScoreValue ?? ''
  );
  const [customScoreSource, setCustomScoreSource] = useState<CriticSource>(
    initialCustomScoreSource || 'custom'
  );
  const [customScoreUrl, setCustomScoreUrl] = useState<string>(initialCustomScoreUrl || '');
  const [customScoreSummary, setCustomScoreSummary] = useState<string>(
    initialCustomScoreSummary || ''
  );
  const [customScoreNumReviews, setCustomScoreNumReviews] = useState<number | string>(
    initialCustomScoreNumReviews ?? ''
  );

  const handleCloseWizard = useCallback(() => {
    syncJobManager.endAllPriorityScopes();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) {
      syncJobManager.endAllPriorityScopes();
    }
    return () => {
      syncJobManager.endAllPriorityScopes();
    };
  }, [isOpen]);

  const gameRef = useRef(game);
  gameRef.current = game;

  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const candidateReqIdRef = useRef(0);
  const scrapeReqIdRef = useRef(0);
  const reviewReqIdRef = useRef(0);
  const coverReqIdRef = useRef(0);
  const metaSourceReqIdRef = useRef(0);

  useEffect(() => {
    return () => {
      isOpenRef.current = false;
      candidateReqIdRef.current += 1;
      scrapeReqIdRef.current += 1;
      reviewReqIdRef.current += 1;
      coverReqIdRef.current += 1;
      metaSourceReqIdRef.current += 1;
    };
  }, []);

  const loadCandidates = useCallback(
    async (query: string, tab: SourceFilterTab, nonSteam: boolean) => {
      const currentGame = gameRef.current;
      if (!currentGame) return;
      const reqId = ++candidateReqIdRef.current;
      setIsLoadingCandidates(true);
      try {
        const matches = await syncJobManager.runPriorityAction(
          'Matching Game Metadata',
          currentGame.title,
          () => metadataScraperService.getSuggestedMatches(currentGame, query, tab, nonSteam)
        );
        if (!isOpenRef.current || reqId !== candidateReqIdRef.current) return;
        setCandidates(matches);
      } catch (err) {
        if (!isOpenRef.current || reqId !== candidateReqIdRef.current) return;
        console.error('Failed to load candidate matches:', err);
        setCandidates([]);
      } finally {
        if (isOpenRef.current && reqId === candidateReqIdRef.current) {
          setIsLoadingCandidates(false);
        }
      }
    },
    [game?.id, game?.title]
  );

  const loadReviews = useCallback(
    async (
      targetGame: CanonicalGame,
      targetCandidate: SearchMatchCandidate | null,
      targetBundle: ScrapedMetadataBundle | null,
      customQuery?: string
    ) => {
      const reqId = ++reviewReqIdRef.current;
      setIsLoadingReviews(true);
      try {
        const result = await syncJobManager.runPriorityAction(
          'Matching Review Scores',
          customQuery?.trim() || targetBundle?.title || targetGame.title,
          () =>
            reviewCandidateService.discoverReviews(
              targetGame,
              targetCandidate,
              targetBundle,
              customQuery
            )
        );
        if (!isOpenRef.current || reqId !== reviewReqIdRef.current) return;
        const discovered = result.candidates || [];
        setReviewCandidates(discovered);

        const resolved = resolveDiscoveredReviewSelection({
          discovered,
          recommendedCandidateId: result.recommendedCandidateId,
          customQuery,
          existingOverride,
          fallbackTargetTitle: targetBundle?.title || targetGame.title,
        });
        setSelectedReviewOptionId(resolved.optionId);
        setSelectedReviewData(resolved.reviewData);
        setSelectedReviewRoute(resolved.reviewRoute);
        if (resolved.customFields) {
          setCustomScoreValue(resolved.customFields.score);
          setCustomScoreSource(resolved.customFields.source);
          setCustomScoreUrl(resolved.customFields.url);
          setCustomScoreSummary(resolved.customFields.summary);
          setCustomScoreNumReviews(resolved.customFields.numReviews);
        }
      } catch (err) {
        if (!isOpenRef.current || reqId !== reviewReqIdRef.current) return;
        console.error('Failed to discover review candidates:', err);
        setReviewCandidates([]);
        setSelectedReviewOptionId('unrated');
        setSelectedReviewData(null);
        setSelectedReviewRoute({ mode: 'unrated' });
      } finally {
        if (isOpenRef.current && reqId === reviewReqIdRef.current) {
          setIsLoadingReviews(false);
        }
      }
    },
    [existingOverride]
  );

  useEffect(() => {
    candidateReqIdRef.current += 1;
    scrapeReqIdRef.current += 1;
    reviewReqIdRef.current += 1;
    coverReqIdRef.current += 1;
    metaSourceReqIdRef.current += 1;

    if (isOpen && game) {
      const baseTitle = initialScrapedBundle?.title || initialCandidate?.title || game.title || '';
      setStep(initialStep || 1);
      setSearchTerm(game.title);
      setSourceTab('All');
      setNotOnSteamOnly(false);
      setIsScrapingDetails(false);
      setSelectedCandidate(initialCandidate || null);
      setScrapedBundle(initialScrapedBundle || null);
      setSelectedCoverUrl(initialScrapedBundle?.capsuleImage || '');
      setCoverSearchTerm(baseTitle);
      setCoverSourceTab('All');
      setExtraCovers([]);
      setIsSearchingCovers(false);
      setSelectedBlurb(initialScrapedBundle?.shortDescription || '');
      setCustomTitle(initialScrapedBundle?.title || game.title);
      setMetadataSources(initialScrapedBundle?.availableMetadataSources || []);
      setSelectedMetadataSourceId(initialScrapedBundle?.availableMetadataSources?.[0]?.id || '');
      setMetadataSearchTerm(initialScrapedBundle?.title || game.title);
      setIsSearchingMetadataSources(false);
      setActiveReleaseDate(initialScrapedBundle?.releaseDate || '');
      setActiveDevelopers(initialScrapedBundle?.developers || []);
      setActivePublishers(initialScrapedBundle?.publishers || []);
      setActiveGenres(initialScrapedBundle?.genres || []);
      setActiveTags(initialScrapedBundle?.tags || []);
      setActiveHeaderImage(initialScrapedBundle?.headerImage || '');
      setActiveAvailableDescriptions(initialScrapedBundle?.availableDescriptions || []);
      setReviewCandidates(initialReviewCandidates || []);
      setIsLoadingReviews(false);
      setSelectedReviewOptionId(initialSelectedReviewOptionId || '');
      setSelectedReviewData(initialSelectedReviewData || null);
      setReviewSearchTerm(baseTitle);
      setSelectedReviewRoute(undefined);
      setCustomScoreValue(initialCustomScoreValue ?? '');
      setCustomScoreSource(initialCustomScoreSource || 'custom');
      setCustomScoreUrl(initialCustomScoreUrl || '');
      setCustomScoreSummary(initialCustomScoreSummary || '');
      setCustomScoreNumReviews(initialCustomScoreNumReviews ?? '');
      if (!initialCandidate) {
        void loadCandidates(game.title, 'All', false);
      }
    }
  }, [
    isOpen,
    game?.id,
    initialStep,
    initialCandidate,
    initialScrapedBundle,
    initialReviewCandidates,
    initialSelectedReviewOptionId,
    initialSelectedReviewData,
    initialCustomScoreValue,
    initialCustomScoreSource,
    initialCustomScoreUrl,
    initialCustomScoreSummary,
    initialCustomScoreNumReviews,
    loadCandidates,
  ]);

  const handleSearchSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    void loadCandidates(searchTerm, sourceTab, notOnSteamOnly);
  };

  const handleSourceTabChange = (tab: SourceFilterTab) => {
    setSourceTab(tab);
    void loadCandidates(searchTerm, tab, notOnSteamOnly);
  };

  const handleToggleNotOnSteam = () => {
    const nextVal = !notOnSteamOnly;
    setNotOnSteamOnly(nextVal);
    const nextTab = nextVal && sourceTab === 'Steam' ? 'All' : sourceTab;
    setSourceTab(nextTab);
    void loadCandidates(searchTerm, nextTab, nextVal);
  };

  const handleSelectCandidate = async (candidate: SearchMatchCandidate) => {
    const reqId = ++scrapeReqIdRef.current;
    reviewReqIdRef.current += 1;
    coverReqIdRef.current += 1;
    metaSourceReqIdRef.current += 1;
    setSelectedCandidate(candidate);
    setReviewCandidates([]);
    setSelectedReviewOptionId('');
    setSelectedReviewData(null);
    setSelectedReviewRoute(undefined);
    setExtraCovers([]);
    setCoverSourceTab('All');
    setCoverSearchTerm(candidate.title || game?.title || '');
    setReviewSearchTerm(candidate.title || game?.title || '');
    setStep(2);
    setIsScrapingDetails(true);
    let resolvedBundle: ScrapedMetadataBundle | null = null;
    try {
      const bundle = await syncJobManager.runPriorityAction(
        'Scraping Match Metadata',
        candidate.title || game?.title,
        () =>
          metadataScraperService.scrapeMatchDetails(candidate, game, {
            nonSteamOnly: notOnSteamOnly,
          })
      );
      if (!isOpenRef.current || reqId !== scrapeReqIdRef.current) return;
      resolvedBundle = bundle;
      setScrapedBundle(bundle);
      setSelectedCoverUrl(bundle.capsuleImage);
      setCoverSearchTerm(bundle.title || candidate.title || game?.title || '');
      setReviewSearchTerm(bundle.title || candidate.title || game?.title || '');
      setSelectedBlurb(bundle.shortDescription || '');
      setCustomTitle(bundle.title);
      setMetadataSources(bundle.availableMetadataSources || []);
      setSelectedMetadataSourceId(bundle.availableMetadataSources?.[0]?.id || '');
      setMetadataSearchTerm(bundle.title || game?.title || '');
      setActiveReleaseDate(bundle.releaseDate || '');
      setActiveDevelopers(bundle.developers || []);
      setActivePublishers(bundle.publishers || []);
      setActiveGenres(bundle.genres || []);
      setActiveTags(bundle.tags || []);
      setActiveHeaderImage(bundle.headerImage || '');
      setActiveAvailableDescriptions(bundle.availableDescriptions || []);
    } catch (err) {
      if (!isOpenRef.current || reqId !== scrapeReqIdRef.current) return;
      console.error('Failed to scrape candidate details:', err);
    } finally {
      if (isOpenRef.current && reqId === scrapeReqIdRef.current) {
        setIsScrapingDetails(false);
      }
    }

    if (isOpenRef.current && reqId === scrapeReqIdRef.current && game && resolvedBundle) {
      void loadReviews(game, candidate, resolvedBundle);
    }
  };

  const handleSearchCovers = async (e?: React.FormEvent, overrideTab?: SourceFilterTab) => {
    if (e) e.preventDefault();
    if (!game) return;
    const activeTab = overrideTab || coverSourceTab;
    const query = coverSearchTerm.trim() || game.title;
    if (typeof metadataScraperService.searchCoverOptions !== 'function') return;
    const reqId = ++coverReqIdRef.current;
    setIsSearchingCovers(true);
    try {
      const results = await syncJobManager.runPriorityAction('Searching Cover Art', query, () =>
        metadataScraperService.searchCoverOptions(query, activeTab, game)
      );
      if (!isOpenRef.current || reqId !== coverReqIdRef.current) return;
      setExtraCovers(results || []);
      setSelectedCoverUrl((prev) =>
        !prev && results && results.length > 0 ? results[0].url : prev
      );
    } catch (err) {
      if (!isOpenRef.current || reqId !== coverReqIdRef.current) return;
      console.error('Failed to search cover art:', err);
    } finally {
      if (isOpenRef.current && reqId === coverReqIdRef.current) {
        setIsSearchingCovers(false);
      }
    }
  };

  const combinedCovers = useMemo(
    () =>
      filterAndDeduplicateCovers(extraCovers, scrapedBundle, coverSourceTab, selectedCoverUrl),
    [extraCovers, scrapedBundle, coverSourceTab, selectedCoverUrl]
  );

  const handleGoToReviewStep = () => {
    setStep(3);
    if (game && reviewCandidates.length === 0 && !isLoadingReviews) {
      void loadReviews(game, selectedCandidate, scrapedBundle);
    }
  };

  const handleReviewSearchSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!game) return;
    void loadReviews(game, selectedCandidate, scrapedBundle, reviewSearchTerm);
  };

  const handleSelectCandidateOption = (cand: ReviewCandidateOption) => {
    setSelectedReviewOptionId(cand.id);
    setSelectedReviewData(toReviewScoreDataFromOption(cand));
    setSelectedReviewRoute(
      cand.reviewRoute || {
        mode: 'routed',
        source: cand.source,
        url: cand.url,
        targetTitle: reviewSearchTerm || scrapedBundle?.title || game?.title || '',
      }
    );
  };

  const handleSelectUnrated = () => {
    setSelectedReviewOptionId('unrated');
    setSelectedReviewData(null);
    setSelectedReviewRoute({ mode: 'unrated' });
  };

  const updateCustomReviewData = (
    val: string | number,
    src: CriticSource,
    url: string,
    summary: string,
    numReviews: string | number
  ) => {
    const { reviewData, reviewRoute } = buildCustomReviewState(val, src, url, summary, numReviews);
    setSelectedReviewData(reviewData);
    setSelectedReviewRoute(reviewRoute);
  };

  const handleSelectCustomCard = () => {
    setSelectedReviewOptionId('custom');
    setSelectedReviewRoute({ mode: 'static', source: customScoreSource, url: customScoreUrl });
    if (customScoreValue === '' && selectedReviewData) {
      setCustomScoreValue(selectedReviewData.score);
      setCustomScoreSource(selectedReviewData.source);
      setCustomScoreUrl(selectedReviewData.url || '');
      setCustomScoreSummary(selectedReviewData.summary || '');
      setCustomScoreNumReviews(selectedReviewData.numReviews ?? '');
      setSelectedReviewRoute({
        mode: 'static',
        source: selectedReviewData.source,
        url: selectedReviewData.url,
      });
    } else {
      updateCustomReviewData(
        customScoreValue,
        customScoreSource,
        customScoreUrl,
        customScoreSummary,
        customScoreNumReviews
      );
    }
  };

  const handleSelectMetadataSource = (srcOpt: MetadataSourceOption) => {
    setSelectedMetadataSourceId(srcOpt.id);
    setCustomTitle(srcOpt.title || customTitle);
    setSelectedBlurb(
      srcOpt.shortDescription || srcOpt.availableDescriptions?.[0]?.text || selectedBlurb
    );
    setActiveAvailableDescriptions(
      srcOpt.availableDescriptions?.length
        ? srcOpt.availableDescriptions
        : srcOpt.shortDescription
          ? [{ source: srcOpt.sourceLabel, text: srcOpt.shortDescription }]
          : activeAvailableDescriptions
    );
    setActiveReleaseDate(srcOpt.releaseDate || activeReleaseDate);
    setActiveDevelopers(srcOpt.developers?.length ? srcOpt.developers : activeDevelopers);
    setActivePublishers(srcOpt.publishers?.length ? srcOpt.publishers : activePublishers);
    setActiveGenres(srcOpt.genres?.length ? srcOpt.genres : activeGenres);
    setActiveTags(srcOpt.tags?.length ? srcOpt.tags : activeTags);
    setActiveHeaderImage(srcOpt.headerImage || activeHeaderImage);
  };

  const handleSearchMetadataSources = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!game) return;
    const query = metadataSearchTerm.trim() || game.title;
    if (typeof metadataScraperService.searchMetadataSources !== 'function') return;
    const reqId = ++metaSourceReqIdRef.current;
    setIsSearchingMetadataSources(true);
    try {
      const results = await syncJobManager.runPriorityAction(
        'Searching Storefront Metadata',
        query,
        () => metadataScraperService.searchMetadataSources(query, 'All', game)
      );
      if (!isOpenRef.current || reqId !== metaSourceReqIdRef.current) return;
      if (results && results.length > 0) {
        setMetadataSources((prev) => mergeDeduplicatedMetadataSources(results, prev));
        handleSelectMetadataSource(results[0]);
      }
    } catch (err) {
      if (!isOpenRef.current || reqId !== metaSourceReqIdRef.current) return;
      console.error('Failed to search storefront metadata sources:', err);
    } finally {
      if (isOpenRef.current && reqId === metaSourceReqIdRef.current) {
        setIsSearchingMetadataSources(false);
      }
    }
  };

  const handleApply = () => {
    if (!game || !scrapedBundle) return;

    const activeMetaOpt = metadataSources.find((s) => s.id === selectedMetadataSourceId);
    const isXboxSelectedCandidate = Boolean(
      selectedCandidate &&
        (selectedCandidate.source === 'xbox' ||
          isXboxStoreCandidateId(selectedCandidate.id, selectedCandidate.storeUrl))
    );
    const isXboxMatchedBundle =
      isXboxStoreCandidateId(scrapedBundle.matchedId) ||
      (isXboxSelectedCandidate && String(scrapedBundle.matchedId) === String(selectedCandidate?.id));
    const isXboxMetaOpt = activeMetaOpt
      ? isXboxStoreCandidateId(activeMetaOpt.id, activeMetaOpt.storeUrl)
      : isXboxMatchedBundle;
    const matchedStore = resolveWizardMatchedStore(scrapedBundle);
    const hasValidMetaSteamId =
      typeof activeMetaOpt?.steamAppId === 'number' && !notOnSteamOnly;
    const isExplicitNonSteam =
      notOnSteamOnly ||
      (matchedStore !== 'steam' &&
        !hasValidMetaSteamId &&
        typeof scrapedBundle.steamAppId !== 'number');

    const safeSelectedReviewData: CriticScoreData | null = selectedReviewData
      ? {
          ...selectedReviewData,
          url: selectedReviewData.url ? sanitizeAllowedStoreUri(selectedReviewData.url) : '',
        }
      : null;

    const rawReviewRoute: ReviewScoreRoute =
      !safeSelectedReviewData || selectedReviewOptionId === 'unrated'
        ? { mode: 'unrated' }
        : selectedReviewOptionId === 'custom' || safeSelectedReviewData.source === 'custom'
          ? {
              mode: 'static',
              source: safeSelectedReviewData.source,
              url: safeSelectedReviewData.url || undefined,
            }
          : selectedReviewRoute || {
              mode: 'routed',
              source: safeSelectedReviewData.source,
              url: safeSelectedReviewData.url || undefined,
              targetTitle: customTitle.trim() || scrapedBundle.title,
            };

    const reviewRoute: ReviewScoreRoute = rawReviewRoute.url
      ? {
          ...rawReviewRoute,
          url: sanitizeAllowedStoreUri(rawReviewRoute.url) || undefined,
        }
      : rawReviewRoute;

    const activeSource = activeMetaOpt?.source || scrapedBundle.matchedStore;
    const routeSource = resolveWizardMetadataRouteSource(activeMetaOpt, scrapedBundle);
    const availableDescs = activeAvailableDescriptions.length
      ? activeAvailableDescriptions
      : scrapedBundle.availableDescriptions || [];
    const isSynopsisFromStoreOption =
      availableDescs.some((d) => d.text.trim() === selectedBlurb.trim()) ||
      selectedBlurb.trim() ===
        (activeMetaOpt?.shortDescription || scrapedBundle.shortDescription || '').trim();

    const metadataRoute: MetadataSourceRoute = {
      mode: isXboxMetaOpt ? 'routed' : activeSource === 'original' ? 'custom' : 'routed',
      source: routeSource,
      matchedId: activeMetaOpt?.matchedId ?? scrapedBundle.matchedId,
      steamAppId:
        activeMetaOpt?.steamAppId ??
        (typeof scrapedBundle.steamAppId === 'number' ? scrapedBundle.steamAppId : undefined),
      gogId:
        activeMetaOpt?.gogId ??
        (activeSource === 'gog' && scrapedBundle.matchedId
          ? String(scrapedBundle.matchedId).replace(/^gog-/, '')
          : undefined),
      epicSlug:
        activeMetaOpt?.epicSlug ??
        (activeSource === 'epic' && scrapedBundle.matchedId
          ? String(scrapedBundle.matchedId).replace(/^epic-/, '')
          : undefined),
      igdbId: activeMetaOpt?.igdbId ?? scrapedBundle.igdbId,
      targetTitle: activeMetaOpt?.title || scrapedBundle.title,
      customTitleEdited: customTitle.trim() !== (activeMetaOpt?.title || scrapedBundle.title),
      customSynopsisEdited: !isSynopsisFromStoreOption && selectedBlurb.trim().length > 0,
    };

    const finalTitle = customTitle.trim() || scrapedBundle.title;

    const srcPlat =
      game.platforms?.find((p) => p.platformId === existingOverride?.originalSourcePlatformId) ||
      game.platforms?.find((p) => p.platformId === existingOverride?.platformId) ||
      game.platforms?.[0];

    const rawSrcTitle =
      existingOverride?.originalSourceTitle ||
      srcPlat?.originalTitle ||
      game.originalStoreTitle ||
      game.title;

    const isSplittingFromMerged = isGameSplittingFromMerged(game, existingOverride);

    const safeCapsuleImage =
      sanitizeAllowedStoreUri(selectedCoverUrl) ||
      sanitizeAllowedStoreUri(scrapedBundle.capsuleImage) ||
      undefined;
    const safeHeaderImage =
      sanitizeAllowedStoreUri(activeHeaderImage) ||
      sanitizeAllowedStoreUri(scrapedBundle.headerImage) ||
      undefined;
    const safeIconUrl =
      sanitizeAllowedStoreUri(selectedCoverUrl) ||
      sanitizeAllowedStoreUri(scrapedBundle.iconUrl) ||
      undefined;

    const override: UserGameOverride = {
      gameId: game.id,
      platformId: game.platforms?.[0]?.platformId,
      platformGameId: game.platforms?.[0]?.platformGameId,
      originalSourceTitle: rawSrcTitle,
      originalSourcePlatformId: srcPlat?.platformId,
      ...(isSplittingFromMerged ? { splitFromMerged: true } : {}),
      matchedStore,
      matchedId: scrapedBundle.matchedId,
      title: finalTitle,
      sortTitle: finalTitle.replace(/^(The|A|An)\s+/i, '').trim(),
      steamAppId: isExplicitNonSteam
        ? null
        : scrapedBundle.steamAppId ?? activeMetaOpt?.steamAppId ?? null,
      isExplicitNonSteam,
      igdbId: activeMetaOpt?.igdbId ?? scrapedBundle.igdbId,
      capsuleImage: safeCapsuleImage,
      headerImage: safeHeaderImage,
      iconUrl: safeIconUrl,
      shortDescription: selectedBlurb || scrapedBundle.shortDescription,
      detailedDescription:
        activeMetaOpt?.detailedDescription || scrapedBundle.detailedDescription,
      developers: activeDevelopers.length ? activeDevelopers : scrapedBundle.developers,
      publishers: activePublishers.length ? activePublishers : scrapedBundle.publishers,
      genres: activeGenres.length ? activeGenres : scrapedBundle.genres,
      tags: activeTags.length ? activeTags : scrapedBundle.tags,
      releaseDate: activeReleaseDate || scrapedBundle.releaseDate,
      storefrontAnchor: scrapedBundle.storefrontAnchor,
      reviewScoreOverride: safeSelectedReviewData,
      reviewRoute,
      metadataRoute,
      updatedAt: new Date().toISOString(),
    };

    onApplyOverride(override);
    handleCloseWizard();
  };

  if (!isOpen || !game) return null;

  const isSplittingFromMerged = isGameSplittingFromMerged(game, existingOverride);

  const sourcePlatform =
    game.platforms?.find((p) => p.platformId === existingOverride?.originalSourcePlatformId) ||
    game.platforms?.find((p) => p.platformId === existingOverride?.platformId) ||
    game.platforms?.[0];

  const rawSourceTitle =
    existingOverride?.originalSourceTitle ||
    sourcePlatform?.originalTitle ||
    game.originalStoreTitle ||
    game.title;

  const isTitleOverridden =
    Boolean(existingOverride?.title) &&
    rawSourceTitle.toLowerCase().trim() !== game.title.toLowerCase().trim();

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={handleCloseWizard}
      ariaLabelledBy={titleId}
      className="w-full max-w-4xl"
    >
      <div
        className="bg-[#16202d] border border-[#2a475e] rounded-lg shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden text-slate-200 select-none"
        onClick={(e) => e.stopPropagation()}
      >
        {renderFixMatchWizardHeader({
          titleId,
          game,
          existingOverride,
          isSplittingFromMerged,
          sourcePlatform,
          rawSourceTitle,
          isTitleOverridden,
          onClose: handleCloseWizard,
        })}

        {renderFixMatchWizardStepper({
          step,
          selectedCandidate,
          scrapedBundle,
          onSelectStep: setStep,
          onGoToReviewStep: handleGoToReviewStep,
        })}

        {/* Modal Main Body Content */}
        <div className="flex-1 overflow-y-auto p-6 bg-[#101721] ol-studio-scroll-body">
          {step === 1 &&
            renderFixMatchCandidateStep({
              idPrefix: titleId,
              game,
              sourcePlatform,
              rawSourceTitle,
              existingOverride,
              searchTerm,
              onSearchTermChange: setSearchTerm,
              onClearSearch: () => {
                setSearchTerm('');
                void loadCandidates('', sourceTab, notOnSteamOnly);
              },
              onSearchSubmit: handleSearchSubmit,
              sourceTab,
              onSourceTabChange: handleSourceTabChange,
              notOnSteamOnly,
              onToggleNotOnSteam: handleToggleNotOnSteam,
              candidates,
              isLoadingCandidates,
              selectedCandidate,
              onSelectCandidate: (cand) => {
                void handleSelectCandidate(cand);
              },
            })}

          {step === 2 &&
            renderFixMatchCoverStep({
              idPrefix: titleId,
              selectedCandidate,
              coverSearchTerm,
              onCoverSearchTermChange: setCoverSearchTerm,
              onSearchCovers: (e, overrideTab) => {
                void handleSearchCovers(e, overrideTab);
              },
              coverSourceTab,
              onCoverSourceTabChange: setCoverSourceTab,
              combinedCovers,
              selectedCoverUrl,
              onSelectCoverUrl: setSelectedCoverUrl,
              isScrapingDetails,
              isSearchingCovers,
              onBackToStep1: () => setStep(1),
            })}

          {step === 3 &&
            renderFixMatchReviewStep({
              idPrefix: titleId,
              selectedCandidate,
              reviewSearchTerm,
              onReviewSearchTermChange: setReviewSearchTerm,
              onReviewSearchSubmit: handleReviewSearchSubmit,
              isLoadingReviews,
              reviewCandidates,
              selectedReviewOptionId,
              onSelectCandidateOption: handleSelectCandidateOption,
              onSelectCustomCard: handleSelectCustomCard,
              onSelectUnrated: handleSelectUnrated,
              customScoreValue,
              onCustomScoreChange: (val) => {
                setCustomScoreValue(val);
                updateCustomReviewData(
                  val,
                  customScoreSource,
                  customScoreUrl,
                  customScoreSummary,
                  customScoreNumReviews
                );
              },
              customScoreSource,
              onCustomSourceChange: (src) => {
                setCustomScoreSource(src);
                updateCustomReviewData(
                  customScoreValue,
                  src,
                  customScoreUrl,
                  customScoreSummary,
                  customScoreNumReviews
                );
              },
              customScoreNumReviews,
              onCustomReviewsChange: (reviews) => {
                setCustomScoreNumReviews(reviews);
                updateCustomReviewData(
                  customScoreValue,
                  customScoreSource,
                  customScoreUrl,
                  customScoreSummary,
                  reviews
                );
              },
              customScoreUrl,
              onCustomUrlChange: (url) => {
                setCustomScoreUrl(url);
                updateCustomReviewData(
                  customScoreValue,
                  customScoreSource,
                  url,
                  customScoreSummary,
                  customScoreNumReviews
                );
              },
              customScoreSummary,
              onCustomSummaryChange: (summary) => {
                setCustomScoreSummary(summary);
                updateCustomReviewData(
                  customScoreValue,
                  customScoreSource,
                  customScoreUrl,
                  summary,
                  customScoreNumReviews
                );
              },
            })}

          {step === 4 &&
            scrapedBundle &&
            renderFixMatchMetadataStep({
              idPrefix: titleId,
              scrapedBundle,
              metadataSearchTerm,
              onMetadataSearchTermChange: setMetadataSearchTerm,
              onSearchMetadataSources: (e) => {
                void handleSearchMetadataSources(e);
              },
              isSearchingMetadataSources,
              metadataSources,
              selectedMetadataSourceId,
              onSelectMetadataSource: handleSelectMetadataSource,
              selectedCoverUrl,
              customTitle,
              onCustomTitleChange: setCustomTitle,
              selectedReviewData,
              selectedReviewOptionId,
              activeReleaseDate,
              activeDevelopers,
              activeGenres,
              activeAvailableDescriptions,
              selectedBlurb,
              onSelectedBlurbChange: setSelectedBlurb,
              onGoToStep2: () => setStep(2),
              onGoToStep3: () => setStep(3),
            })}
        </div>

        {renderFixMatchWizardFooter({
          step,
          game,
          existingOverride,
          isSplittingFromMerged,
          sourcePlatform,
          selectedCoverUrl,
          isScrapingDetails,
          onResetOverride,
          onHideGame,
          onBack: () => setStep((prev) => (prev - 1) as WizardStep),
          onClose: handleCloseWizard,
          onGoToReviewStep: handleGoToReviewStep,
          onGoToStep4: () => setStep(4),
          onApply: handleApply,
        })}
      </div>
    </ModalShell>
  );
};
