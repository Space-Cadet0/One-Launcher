import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ArrowLeft,
  Award,
  CheckCircle2,
  ChevronRight,
  EyeOff,
  Image as ImageIcon,
  RotateCcw,
  Search,
  Sparkles,
  Wand,
  X,
} from 'lucide-react';
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
import { getStorefrontDisplayName } from '../Common/StorefrontIcon';
import { ModalShell } from '../Common/ModalShell';
import {
  reviewCandidateService,
  ReviewCandidateOption,
} from '../../services/scraper/reviewCandidateService';
import { CriticScoreData, CriticSource } from '../../contracts/critic';
import { calculateTier } from '../../services/critic/criticUtils';
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

        if (
          !customQuery &&
          existingOverride &&
          existingOverride.reviewScoreOverride !== undefined
        ) {
          if (existingOverride.reviewScoreOverride === null) {
            setSelectedReviewOptionId('unrated');
            setSelectedReviewData(null);
            setSelectedReviewRoute({ mode: 'unrated' });
            return;
          }
          const activeOpt = discovered.find((c) => c.id === 'active-override');
          if (activeOpt) {
            setSelectedReviewOptionId(activeOpt.id);
            setSelectedReviewData({
              id: activeOpt.id,
              source: activeOpt.source,
              score: activeOpt.score,
              tier: activeOpt.tier,
              url: activeOpt.url || '',
              summary: activeOpt.summary,
              numReviews: activeOpt.numReviews,
              userScoreRaw: activeOpt.userScoreRaw,
              starRatingRaw: activeOpt.starRatingRaw,
              percentRecommended: activeOpt.percentRecommended,
              isVerified: activeOpt.isVerified,
              isSynthetic: activeOpt.isSynthetic,
            });
            setSelectedReviewRoute(
              activeOpt.reviewRoute || {
                mode: 'routed',
                source: activeOpt.source,
                url: activeOpt.url,
                targetTitle: targetBundle?.title || targetGame.title,
              }
            );
            return;
          } else {
            const ex = existingOverride.reviewScoreOverride;
            setSelectedReviewOptionId('custom');
            setCustomScoreValue(ex.score);
            setCustomScoreSource(ex.source);
            setCustomScoreUrl(ex.url || '');
            setCustomScoreSummary(ex.summary || '');
            setCustomScoreNumReviews(ex.numReviews ?? '');
            setSelectedReviewData(ex);
            setSelectedReviewRoute(
              existingOverride.reviewRoute || {
                mode: 'static',
                source: ex.source,
                url: ex.url,
              }
            );
            return;
          }
        }

        if (!customQuery) {
          const activeCand = discovered.find((c) => c.id === 'active-override');
          if (activeCand) {
            setSelectedReviewOptionId(activeCand.id);
            setSelectedReviewData({
              id: activeCand.id,
              source: activeCand.source,
              score: activeCand.score,
              tier: activeCand.tier,
              url: activeCand.url || '',
              summary: activeCand.summary,
              numReviews: activeCand.numReviews,
              userScoreRaw: activeCand.userScoreRaw,
              starRatingRaw: activeCand.starRatingRaw,
              percentRecommended: activeCand.percentRecommended,
              isVerified: activeCand.isVerified,
              isSynthetic: activeCand.isSynthetic,
            });
            setSelectedReviewRoute(
              activeCand.reviewRoute || {
                mode: 'routed',
                source: activeCand.source,
                url: activeCand.url,
                targetTitle: targetBundle?.title || targetGame.title,
              }
            );
            return;
          }
        }

        const recommendedId = result.recommendedCandidateId;
        const recommended =
          (recommendedId ? discovered.find((c) => c.id === recommendedId) : null) ||
          discovered.find((c) => c.isRecommended) ||
          discovered[0];

        if (recommended) {
          setSelectedReviewOptionId(recommended.id);
          setSelectedReviewData({
            id: recommended.id,
            source: recommended.source,
            score: recommended.score,
            tier: recommended.tier,
            url: recommended.url || '',
            summary: recommended.summary,
            numReviews: recommended.numReviews,
            userScoreRaw: recommended.userScoreRaw,
            starRatingRaw: recommended.starRatingRaw,
            percentRecommended: recommended.percentRecommended,
            isVerified: recommended.isVerified,
            isSynthetic: recommended.isSynthetic,
          });
          setSelectedReviewRoute(
            recommended.reviewRoute || {
              mode: 'routed',
              source: recommended.source,
              url: recommended.url,
              targetTitle: customQuery?.trim() || targetBundle?.title || targetGame.title,
            }
          );
        } else {
          setSelectedReviewOptionId('unrated');
          setSelectedReviewData(null);
          setSelectedReviewRoute({ mode: 'unrated' });
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

  const combinedCovers = useMemo(() => {
    const raw = [...extraCovers, ...(scrapedBundle?.availableCovers || [])];
    const seen = new Set<string>();
    const deduped: ScrapedCoverOption[] = [];
    for (const cov of raw) {
      if (!cov || !cov.url || seen.has(cov.url)) continue;
      seen.add(cov.url);
      deduped.push(cov);
    }
    if (coverSourceTab === 'All') return deduped;
    if (coverSourceTab === 'Xbox') {
      return deduped.filter(
        (c) =>
          c.label.toLowerCase().startsWith('xbox') ||
          c.url.toLowerCase().includes('s-microsoft.com') ||
          c.url === selectedCoverUrl
      );
    }
    const targetSource = coverSourceTab.toLowerCase();
    return deduped.filter(
      (c) => c.source.toLowerCase() === targetSource || c.url === selectedCoverUrl
    );
  }, [extraCovers, scrapedBundle, coverSourceTab, selectedCoverUrl]);

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
    setSelectedReviewData({
      id: cand.id,
      source: cand.source,
      score: cand.score,
      tier: cand.tier,
      url: cand.url || '',
      summary: cand.summary,
      numReviews: cand.numReviews,
      userScoreRaw: cand.userScoreRaw,
      starRatingRaw: cand.starRatingRaw,
      percentRecommended: cand.percentRecommended,
      isVerified: cand.isVerified,
      isSynthetic: cand.isSynthetic,
    });
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
    const rawVal = typeof val === 'string' ? val.trim() : String(val);
    const parsedScore = parseInt(rawVal, 10);
    if (!isNaN(parsedScore) && parsedScore >= 0 && parsedScore <= 100) {
      const tier = calculateTier(parsedScore);
      const parsedReviews =
        typeof numReviews === 'string' ? parseInt(numReviews.trim(), 10) : numReviews;
      const count = !isNaN(parsedReviews) && parsedReviews > 0 ? parsedReviews : undefined;
      setSelectedReviewData({
        source: src,
        score: parsedScore,
        tier,
        url: url.trim(),
        summary: summary.trim() || undefined,
        numReviews: count,
        isVerified: src === 'metacritic' || src === 'opencritic',
        isSynthetic: src === 'steam',
      });
    } else {
      setSelectedReviewData(null);
    }
    setSelectedReviewRoute({ mode: 'static', source: src, url: url.trim() });
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
        setMetadataSources((prev) => {
          const combined = [...results, ...prev];
          const seen = new Set<string>();
          return combined.filter((item) => {
            if (!item || seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          });
        });
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
    const isXboxMatchedBundle = isXboxStoreCandidateId(scrapedBundle.matchedId);
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

    const reviewRoute: ReviewScoreRoute =
      !selectedReviewData || selectedReviewOptionId === 'unrated'
        ? { mode: 'unrated' }
        : selectedReviewOptionId === 'custom' || selectedReviewData.source === 'custom'
          ? {
              mode: 'static',
              source: selectedReviewData.source,
              url: selectedReviewData.url,
            }
          : selectedReviewRoute || {
              mode: 'routed',
              source: selectedReviewData.source,
              url: selectedReviewData.url,
              targetTitle: customTitle.trim() || scrapedBundle.title,
            };

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
      capsuleImage: selectedCoverUrl || scrapedBundle.capsuleImage,
      headerImage: activeHeaderImage || scrapedBundle.headerImage,
      iconUrl: selectedCoverUrl || scrapedBundle.iconUrl,
      shortDescription: selectedBlurb || scrapedBundle.shortDescription,
      detailedDescription:
        activeMetaOpt?.detailedDescription || scrapedBundle.detailedDescription,
      developers: activeDevelopers.length ? activeDevelopers : scrapedBundle.developers,
      publishers: activePublishers.length ? activePublishers : scrapedBundle.publishers,
      genres: activeGenres.length ? activeGenres : scrapedBundle.genres,
      tags: activeTags.length ? activeTags : scrapedBundle.tags,
      releaseDate: activeReleaseDate || scrapedBundle.releaseDate,
      storefrontAnchor: scrapedBundle.storefrontAnchor,
      reviewScoreOverride: selectedReviewData,
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
        className="bg-[#16202d] border border-[#2a475e] rounded-lg shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden text-slate-200 animate-in fade-in duration-150 select-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Top Header */}
        <div className="px-6 py-4 border-b border-[#2a475e]/70 flex items-center justify-between bg-[#131c27]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#1b2838] border border-[#2a475e] flex items-center justify-center text-[#66c0f4] shadow-inner">
              <Wand aria-hidden="true" className="w-5 h-5" />
            </div>
            <div>
              <h2
                id={titleId}
                className="text-base font-bold text-white tracking-wide flex items-center gap-2 flex-wrap"
              >
                <span>Fix Match &amp; Metadata</span>
                {existingOverride && (
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-amber-500/20 text-amber-200 border border-amber-500/40">
                    Custom Match Active
                  </span>
                )}
                {isSplittingFromMerged && (
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-amber-500/20 text-amber-200 border border-amber-500/40">
                    Splitting &amp; Matching Individual{' '}
                    {getStorefrontDisplayName(sourcePlatform?.platformId || 'steam')} Entry
                  </span>
                )}
              </h2>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-300 mt-0.5">
                {sourcePlatform && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-[#1b2838] border border-[#2a475e] text-[10px] font-semibold text-sky-300">
                    {getStorefrontDisplayName(sourcePlatform.platformId)}
                  </span>
                )}
                <span>
                  Source Scrape Title:{' '}
                  <strong className="text-slate-100 font-medium">
                    &ldquo;{rawSourceTitle}&rdquo;
                  </strong>
                </span>
                {isTitleOverridden && (
                  <>
                    <ChevronRight aria-hidden="true" className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                    <span>
                      Active Display Title:{' '}
                      <strong className="text-amber-200 font-semibold">
                        &ldquo;{game.title}&rdquo;
                      </strong>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            aria-label="Close Wizard"
            onClick={handleCloseWizard}
            className="min-w-6 min-h-6 p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-[#1b2838] transition-colors cursor-pointer"
            title="Close Wizard (Esc)"
          >
            <X aria-hidden="true" className="w-5 h-5" />
          </button>
        </div>

        {/* 4-Step Wizard Navigation Stepper */}
        <div className="px-6 py-3 border-b border-[#2a475e]/50 bg-[#16202d] flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 flex-1 flex-wrap">
            <button
              type="button"
              aria-current={step === 1 ? 'step' : undefined}
              onClick={() => setStep(1)}
              className={`min-h-6 flex items-center gap-2 px-3 py-1.5 rounded-md font-semibold transition-all cursor-pointer ${
                step === 1
                  ? 'bg-[#66c0f4] text-slate-950 shadow'
                  : 'text-slate-300 hover:text-white hover:bg-[#1b2838]'
              }`}
            >
              <Search aria-hidden="true" className="w-3.5 h-3.5" />
              <span>1. Match Discovery</span>
            </button>

            <ChevronRight aria-hidden="true" className="w-4 h-4 text-slate-500 shrink-0" />

            <button
              type="button"
              aria-current={step === 2 ? 'step' : undefined}
              onClick={() => selectedCandidate && setStep(2)}
              disabled={!selectedCandidate}
              className={`min-h-6 flex items-center gap-2 px-3 py-1.5 rounded-md font-semibold transition-all ${
                step === 2
                  ? 'bg-[#66c0f4] text-slate-950 shadow cursor-pointer'
                  : selectedCandidate
                    ? 'text-slate-300 hover:text-white hover:bg-[#1b2838] cursor-pointer'
                    : 'text-slate-600 cursor-not-allowed opacity-50'
              }`}
            >
              <ImageIcon aria-hidden="true" className="w-3.5 h-3.5" />
              <span>2. Cover Art</span>
            </button>

            <ChevronRight aria-hidden="true" className="w-4 h-4 text-slate-500 shrink-0" />

            <button
              type="button"
              aria-current={step === 3 ? 'step' : undefined}
              onClick={() => selectedCandidate && handleGoToReviewStep()}
              disabled={!selectedCandidate}
              className={`min-h-6 flex items-center gap-2 px-3 py-1.5 rounded-md font-semibold transition-all ${
                step === 3
                  ? 'bg-[#66c0f4] text-slate-950 shadow cursor-pointer'
                  : selectedCandidate
                    ? 'text-slate-300 hover:text-white hover:bg-[#1b2838] cursor-pointer'
                    : 'text-slate-600 cursor-not-allowed opacity-50'
              }`}
            >
              <Award aria-hidden="true" className="w-3.5 h-3.5" />
              <span>3. Review Score &amp; Source</span>
            </button>

            <ChevronRight aria-hidden="true" className="w-4 h-4 text-slate-500 shrink-0" />

            <button
              type="button"
              aria-current={step === 4 ? 'step' : undefined}
              onClick={() => scrapedBundle && setStep(4)}
              disabled={!scrapedBundle}
              className={`min-h-6 flex items-center gap-2 px-3 py-1.5 rounded-md font-semibold transition-all ${
                step === 4
                  ? 'bg-[#66c0f4] text-slate-950 shadow cursor-pointer'
                  : scrapedBundle
                    ? 'text-slate-300 hover:text-white hover:bg-[#1b2838] cursor-pointer'
                    : 'text-slate-600 cursor-not-allowed opacity-50'
              }`}
            >
              <CheckCircle2 aria-hidden="true" className="w-3.5 h-3.5" />
              <span>4. Metadata &amp; Confirm</span>
            </button>
          </div>

          <div className="text-[11px] text-slate-300 font-mono">{`Step ${step} of 4`}</div>
        </div>

        {/* Modal Main Body Content */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar bg-[#101721] ol-studio-scroll-body">
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

        {/* Modal Bottom Action Footer Bar */}
        <div className="px-6 py-4 border-t border-[#2a475e]/70 bg-[#131c27] flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {existingOverride && onResetOverride && (
              <button
                type="button"
                onClick={() => {
                  onResetOverride(game.id, {
                    game,
                    override: existingOverride ?? null,
                  });
                  handleCloseWizard();
                }}
                className="min-h-6 px-3.5 py-2 rounded-md border border-rose-500/50 bg-rose-950/40 text-rose-200 hover:bg-rose-900/60 hover:text-white transition-colors text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-sm"
                title="Discard user match overrides and revert to original catalog metadata"
              >
                <RotateCcw aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Reset to Default</span>
              </button>
            )}
            {onHideGame && (
              <button
                type="button"
                onClick={() => {
                  onHideGame(
                    game,
                    isSplittingFromMerged || game.platforms?.length === 1
                      ? sourcePlatform?.platformId
                      : undefined
                  );
                  handleCloseWizard();
                }}
                className="min-h-6 px-3.5 py-2 rounded-md border border-rose-500/40 bg-rose-950/50 text-rose-200 hover:bg-rose-900/70 hover:text-white transition-colors text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-sm"
                title="Hide / suppress this entry from your active library (can be restored anytime in Library Match & Overrides Studio)"
              >
                <EyeOff aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Hide / Suppress Entry</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep((prev) => (prev - 1) as WizardStep)}
                className="min-h-6 px-4 py-2 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-200 hover:text-white hover:border-slate-400 transition-colors text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <ArrowLeft aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleCloseWizard}
              className="min-h-6 px-4 py-2 rounded-md border border-transparent text-slate-300 hover:text-white hover:bg-[#1b2838] transition-colors text-xs font-semibold cursor-pointer"
            >
              Cancel
            </button>

            {step === 2 && (
              <button
                type="button"
                disabled={!selectedCoverUrl || isScrapingDetails}
                onClick={handleGoToReviewStep}
                className="min-h-6 px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs flex items-center gap-1.5 shadow cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span>Next: Review Score &amp; Source</span>
                <ChevronRight aria-hidden="true" className="w-3.5 h-3.5" />
              </button>
            )}

            {step === 3 && (
              <button
                type="button"
                onClick={() => setStep(4)}
                className="min-h-6 px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs flex items-center gap-1.5 shadow cursor-pointer"
              >
                <span>Next: Metadata &amp; Confirm</span>
                <ChevronRight aria-hidden="true" className="w-3.5 h-3.5" />
              </button>
            )}

            {step === 4 && (
              <button
                type="button"
                onClick={handleApply}
                className="min-h-6 px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs flex items-center gap-2 shadow-lg shadow-[#66c0f4]/20 cursor-pointer"
              >
                <Sparkles aria-hidden="true" className="w-4 h-4 fill-slate-950" />
                <span>Apply Match &amp; Scrape Data</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
};
