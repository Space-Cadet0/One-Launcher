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
  buildCandidateStoreUrl,
} from '../../services/scraper/metadataScraperService';
import { getStorefrontDisplayName } from '../Common/StorefrontIcon';
import {
  reviewCandidateService,
  ReviewCandidateOption,
} from '../../services/scraper/reviewCandidateService';
import { CriticScoreData, CriticSource } from '../../contracts/critic';
import { calculateTier, getTierColor } from '../../services/critic/criticUtils';
import { syncJobManager } from '../../services/network/syncJobManager';
import {
  X,
  Search,
  Wand,
  Image as ImageIcon,
  CheckCircle2,
  Check,
  ChevronRight,
  ArrowLeft,
  RotateCcw,
  Sparkles,
  Loader2,
  Info,
  Calendar,
  Tag,
  Building,
  Award,
  ExternalLink,
  EyeOff,
  Edit3,
  ShieldCheck,
} from 'lucide-react';

export interface FixMatchWizardModalProps {
  isOpen: boolean;
  game: CanonicalGame | null;
  onClose: () => void;
  onApplyOverride: (override: UserGameOverride) => void;
  onResetOverride?: (gameId: string) => void;
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

type WizardStep = 1 | 2 | 3 | 4;
type SourceFilterTab = 'All' | 'Steam' | 'IGDB' | 'GOG' | 'Epic';

/**
 * Formats a match confidence score into a clean percentage string (0% - 100%).
 * Safely handles both normalized 0..1 floating point scores and 0..100 integer scores.
 */
export function formatMatchPercentage(score?: number): string | null {
  if (score === undefined || score === null || isNaN(score) || score <= 0) return null;
  const raw = score <= 1.0 ? score * 100 : score;
  const clamped = Math.min(100, Math.max(0, Math.round(raw)));
  return `${clamped}% Match`;
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
  const [activeTags, setActiveTags] = useState<string[]>(
    initialScrapedBundle?.tags || []
  );
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

  // Ensure priority scopes are always ended on close or unmount
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

  // Load candidate matches from metadata scraper service (On-Demand Priority)
  const loadCandidates = useCallback(
    async (query: string, tab: SourceFilterTab, nonSteam: boolean) => {
      const currentGame = gameRef.current;
      if (!currentGame) return;
      setIsLoadingCandidates(true);
      try {
        const matches = await syncJobManager.runPriorityAction(
          'Matching Game Metadata',
          currentGame.title,
          () => metadataScraperService.getSuggestedMatches(currentGame, query, tab, nonSteam)
        );
        setCandidates(matches);
      } catch (err) {
        console.error('Failed to load candidate matches:', err);
        setCandidates([]);
      } finally {
        setIsLoadingCandidates(false);
      }
    },
    [game?.id, game?.title]
  );

  // Load review score candidates from reviewCandidateService (On-Demand Priority)
  const loadReviews = useCallback(
    async (
      targetGame: CanonicalGame,
      targetCandidate: SearchMatchCandidate | null,
      targetBundle: ScrapedMetadataBundle | null,
      customQuery?: string
    ) => {
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
        const discovered = result.candidates || [];
        setReviewCandidates(discovered);

        // If user triggered an explicit custom search query, prioritize discovered results from that search
        if (!customQuery && existingOverride && existingOverride.reviewScoreOverride !== undefined) {
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

        // Active override from candidates if game already had one (and not custom searching)
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

        // Auto-select recommended candidate
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
        console.error('Failed to discover review candidates:', err);
        setReviewCandidates([]);
        setSelectedReviewOptionId('unrated');
        setSelectedReviewData(null);
        setSelectedReviewRoute({ mode: 'unrated' });
      } finally {
        setIsLoadingReviews(false);
      }
    },
    [existingOverride]
  );

  // Reset wizard state whenever modal is opened with a new or existing game
  useEffect(() => {
    if (isOpen && game) {
      const baseTitle = initialScrapedBundle?.title || initialCandidate?.title || game.title || '';
      setStep(initialStep || 1);
      setSearchTerm(game.title);
      setSourceTab('All');
      setNotOnSteamOnly(false);
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
        loadCandidates(game.title, 'All', false);
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

  // Trigger search on query change or tab switch in Stage 1
  const handleSearchSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    loadCandidates(searchTerm, sourceTab, notOnSteamOnly);
  };

  const handleSourceTabChange = (tab: SourceFilterTab) => {
    setSourceTab(tab);
    loadCandidates(searchTerm, tab, notOnSteamOnly);
  };

  const handleToggleNotOnSteam = () => {
    const nextVal = !notOnSteamOnly;
    setNotOnSteamOnly(nextVal);
    const nextTab = nextVal && sourceTab === 'Steam' ? 'All' : sourceTab;
    setSourceTab(nextTab);
    loadCandidates(searchTerm, nextTab, nextVal);
  };

  // Select candidate -> proceed to Step 2 & scrape details (Non-overlapping priority scopes)
  const handleSelectCandidate = async (candidate: SearchMatchCandidate) => {
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
      console.error('Failed to scrape candidate details:', err);
    } finally {
      setIsScrapingDetails(false);
    }

    // Pre-warm reviews AFTER 'Scraping Match Metadata' priority scope has closed
    if (game && resolvedBundle) {
      loadReviews(game, candidate, resolvedBundle);
    }
  };

  // Stage 2: Search cover options across storefronts independently
  const handleSearchCovers = async (e?: React.FormEvent, overrideTab?: SourceFilterTab) => {
    if (e) e.preventDefault();
    if (!game) return;
    const activeTab = overrideTab || coverSourceTab;
    const query = coverSearchTerm.trim() || game.title;
    if (typeof metadataScraperService.searchCoverOptions !== 'function') return;
    setIsSearchingCovers(true);
    try {
      const results = await syncJobManager.runPriorityAction(
        'Searching Cover Art',
        query,
        () => metadataScraperService.searchCoverOptions(query, activeTab, game)
      );
      setExtraCovers(results || []);
      if (!selectedCoverUrl && results && results.length > 0) {
        setSelectedCoverUrl(results[0].url);
      }
    } catch (err) {
      console.error('Failed to search cover art:', err);
    } finally {
      setIsSearchingCovers(false);
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
    const targetSource = coverSourceTab.toLowerCase();
    return deduped.filter(
      (c) => c.source.toLowerCase() === targetSource || c.url === selectedCoverUrl
    );
  }, [extraCovers, scrapedBundle, coverSourceTab, selectedCoverUrl]);

  // Proceed to Step 3 and trigger discovery if not yet loaded
  const handleGoToReviewStep = () => {
    setStep(3);
    if (game && reviewCandidates.length === 0 && !isLoadingReviews) {
      loadReviews(game, selectedCandidate, scrapedBundle);
    }
  };

  const handleReviewSearchSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!game) return;
    loadReviews(game, selectedCandidate, scrapedBundle, reviewSearchTerm);
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

  const handleCustomScoreChange = (val: string) => {
    setCustomScoreValue(val);
    updateCustomReviewData(val, customScoreSource, customScoreUrl, customScoreSummary, customScoreNumReviews);
  };

  const handleCustomSourceChange = (src: CriticSource) => {
    setCustomScoreSource(src);
    updateCustomReviewData(customScoreValue, src, customScoreUrl, customScoreSummary, customScoreNumReviews);
  };

  const handleCustomUrlChange = (url: string) => {
    setCustomScoreUrl(url);
    updateCustomReviewData(customScoreValue, customScoreSource, url, customScoreSummary, customScoreNumReviews);
  };

  const handleCustomSummaryChange = (summary: string) => {
    setCustomScoreSummary(summary);
    updateCustomReviewData(customScoreValue, customScoreSource, customScoreUrl, summary, customScoreNumReviews);
  };

  const handleCustomReviewsChange = (reviews: string) => {
    setCustomScoreNumReviews(reviews);
    updateCustomReviewData(customScoreValue, customScoreSource, customScoreUrl, customScoreSummary, reviews);
  };

  // Stage 4: Multi-Source Metadata Switcher & Independent Search
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
    setIsSearchingMetadataSources(true);
    try {
      const results = await syncJobManager.runPriorityAction(
        'Searching Storefront Metadata',
        query,
        () => metadataScraperService.searchMetadataSources(query, 'All', game)
      );
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
      console.error('Failed to search storefront metadata sources:', err);
    } finally {
      setIsSearchingMetadataSources(false);
    }
  };

  const handleOpenExternal = (url?: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (!url) return;
    if (typeof window !== 'undefined' && (window as any).electronAPI?.openExternal) {
      (window as any).electronAPI.openExternal(url);
    } else if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  // Keyboard navigation & escape listener
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        handleCloseWizard();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleCloseWizard]);

  // Step 4: Handle final apply override
  const handleApply = () => {
    if (!game || !scrapedBundle) return;

    const activeMetaOpt = metadataSources.find((s) => s.id === selectedMetadataSourceId);
    const matchedStore = scrapedBundle.matchedStore;
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
    const availableDescs = activeAvailableDescriptions.length
      ? activeAvailableDescriptions
      : scrapedBundle.availableDescriptions || [];
    const isSynopsisFromStoreOption =
      availableDescs.some((d) => d.text.trim() === selectedBlurb.trim()) ||
      selectedBlurb.trim() ===
        (activeMetaOpt?.shortDescription || scrapedBundle.shortDescription || '').trim();

    const metadataRoute: MetadataSourceRoute = {
      mode: activeSource === 'original' ? 'custom' : 'routed',
      source: activeSource,
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

    const isSplittingFromMerged = Boolean(
      (game as any)?.isSplittingFromMerged || existingOverride?.splitFromMerged
    );

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
      detailedDescription: activeMetaOpt?.detailedDescription || scrapedBundle.detailedDescription,
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

  const isSplittingFromMerged = Boolean(
    (game as any)?.isSplittingFromMerged || existingOverride?.splitFromMerged
  );

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

  const sourceTabs: SourceFilterTab[] = ['All', 'Steam', 'IGDB', 'GOG', 'Epic'];

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-150"
      onClick={handleCloseWizard}
    >
      <div
        className="bg-[#16202d] border border-[#2a475e] rounded-lg shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden text-slate-200 animate-in zoom-in-95 duration-150 select-none"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fix-match-wizard-title"
      >
        {/* Modal Top Header */}
        <div className="px-6 py-4 border-b border-[#2a475e]/70 flex items-center justify-between bg-[#131c27]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#1b2838] border border-[#2a475e] flex items-center justify-center text-[#66c0f4] shadow-inner">
              <Wand className="w-5 h-5" />
            </div>
            <div>
              <h2 id="fix-match-wizard-title" className="text-base font-bold text-white tracking-wide flex items-center gap-2 flex-wrap">
                <span>Fix Match &amp; Metadata</span>
                {existingOverride && (
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                    Custom Match Active
                  </span>
                )}
                {isSplittingFromMerged && (
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                    Splitting &amp; Matching Individual {getStorefrontDisplayName(sourcePlatform?.platformId || 'steam')} Entry
                  </span>
                )}
              </h2>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400 mt-0.5">
                {sourcePlatform && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-[#1b2838] border border-[#2a475e] text-[10px] font-semibold text-sky-300">
                    {getStorefrontDisplayName(sourcePlatform.platformId)}
                  </span>
                )}
                <span>
                  Source Scrape Title:{' '}
                  <strong className="text-slate-200 font-medium">&ldquo;{rawSourceTitle}&rdquo;</strong>
                </span>
                {isTitleOverridden && (
                  <>
                    <ChevronRight className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span>
                      Active Display Title:{' '}
                      <strong className="text-amber-300 font-semibold">&ldquo;{game.title}&rdquo;</strong>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={handleCloseWizard}
            className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-[#1b2838] transition-colors"
            title="Close Wizard (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 4-Step Wizard Navigation Stepper */}
        <div className="px-6 py-3 border-b border-[#2a475e]/50 bg-[#16202d] flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 flex-1">
            {/* Step 1 Pill */}
            <button
              type="button"
              onClick={() => setStep(1)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md font-semibold transition-all ${
                step === 1
                  ? 'bg-[#66c0f4] text-slate-950 shadow'
                  : 'text-slate-400 hover:text-white hover:bg-[#1b2838]'
              }`}
            >
              <Search className="w-3.5 h-3.5" />
              <span>1. Match Discovery</span>
            </button>

            <ChevronRight className="w-4 h-4 text-slate-600 shrink-0" />

            {/* Step 2 Pill */}
            <button
              type="button"
              onClick={() => selectedCandidate && setStep(2)}
              disabled={!selectedCandidate}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md font-semibold transition-all ${
                step === 2
                  ? 'bg-[#66c0f4] text-slate-950 shadow'
                  : selectedCandidate
                  ? 'text-slate-400 hover:text-white hover:bg-[#1b2838]'
                  : 'text-slate-600 cursor-not-allowed opacity-50'
              }`}
            >
              <ImageIcon className="w-3.5 h-3.5" />
              <span>2. Cover Art</span>
            </button>

            <ChevronRight className="w-4 h-4 text-slate-600 shrink-0" />

            {/* Step 3 Pill */}
            <button
              type="button"
              onClick={() => selectedCandidate && handleGoToReviewStep()}
              disabled={!selectedCandidate}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md font-semibold transition-all ${
                step === 3
                  ? 'bg-[#66c0f4] text-slate-950 shadow'
                  : selectedCandidate
                  ? 'text-slate-400 hover:text-white hover:bg-[#1b2838]'
                  : 'text-slate-600 cursor-not-allowed opacity-50'
              }`}
            >
              <Award className="w-3.5 h-3.5" />
              <span>3. Review Score &amp; Source</span>
            </button>

            <ChevronRight className="w-4 h-4 text-slate-600 shrink-0" />

            {/* Step 4 Pill */}
            <button
              type="button"
              onClick={() => scrapedBundle && setStep(4)}
              disabled={!scrapedBundle}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md font-semibold transition-all ${
                step === 4
                  ? 'bg-[#66c0f4] text-slate-950 shadow'
                  : scrapedBundle
                  ? 'text-slate-400 hover:text-white hover:bg-[#1b2838]'
                  : 'text-slate-600 cursor-not-allowed opacity-50'
              }`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>4. Metadata &amp; Confirm</span>
            </button>
          </div>

          <div className="text-[11px] text-slate-400 font-mono">
            {`Step ${step} of 4`}
          </div>
        </div>

        {/* Modal Main Body Content */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar bg-[#101721]">
          {/* ================= STEP 1: CANDIDATE DISCOVERY ================= */}
          {step === 1 && (
            <div className="space-y-4">
              {/* Search Bar & Options */}
              <form onSubmit={handleSearchSubmit} className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search candidate game by title or keywords..."
                    className="w-full pl-10 pr-10 py-2 rounded-md bg-[#16202d] border border-[#2a475e] text-white placeholder-slate-500 text-sm focus:outline-none focus:border-[#66c0f4] transition-colors"
                  />
                  {searchTerm && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchTerm('');
                        loadCandidates('', sourceTab, notOnSteamOnly);
                      }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={isLoadingCandidates}
                  className="px-4 py-2 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-200 hover:text-white hover:border-[#66c0f4] transition-colors font-semibold text-xs flex items-center justify-center gap-2 cursor-pointer shadow"
                >
                  {isLoadingCandidates ? (
                    <Loader2 className="w-4 h-4 animate-spin text-[#66c0f4]" />
                  ) : (
                    <Search className="w-4 h-4 text-[#66c0f4]" />
                  )}
                  <span>Search</span>
                </button>
              </form>

              {/* Source Tabs & Non-Steam Toggle */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                {/* Storefront Source Tabs */}
                <div className="flex items-center gap-1.5 p-1 rounded-md bg-[#16202d] border border-[#2a475e]/70">
                  {sourceTabs.map((tab) => {
                    const isTabDisabled = notOnSteamOnly && tab === 'Steam';
                    const isTabActive = sourceTab === tab;
                    return (
                      <button
                        key={tab}
                        type="button"
                        disabled={isTabDisabled}
                        onClick={() => handleSourceTabChange(tab)}
                        className={`px-3 py-1 rounded text-xs font-semibold transition-all ${
                          isTabActive
                            ? 'bg-[#66c0f4] text-slate-950 shadow-sm'
                            : isTabDisabled
                            ? 'text-slate-600 cursor-not-allowed opacity-40'
                            : 'text-slate-400 hover:text-white hover:bg-[#1b2838]'
                        }`}
                      >
                        {tab}
                      </button>
                    );
                  })}
                </div>

                {/* Not on Steam Toggle Switch Button */}
                <button
                  type="button"
                  onClick={handleToggleNotOnSteam}
                  className={`flex items-center gap-2.5 px-3 py-1.5 rounded-md border text-xs font-semibold transition-all cursor-pointer ${
                    notOnSteamOnly
                      ? 'bg-amber-950/40 border-amber-500/60 text-amber-300'
                      : 'bg-[#16202d] border-[#2a475e] text-slate-400 hover:text-slate-200 hover:border-slate-500'
                  }`}
                  title="Force search to ignore Steam store candidates (ideal for GOG/Epic/IGDB-exclusive titles)"
                >
                  <div
                    className={`w-3.5 h-3.5 rounded-full border transition-all flex items-center justify-center ${
                      notOnSteamOnly
                        ? 'border-amber-400 bg-amber-400'
                        : 'border-slate-500 bg-transparent'
                    }`}
                  >
                    {notOnSteamOnly && <Check className="w-2.5 h-2.5 text-black font-bold" />}
                  </div>
                  <span>Game is not on Steam (IGDB/GOG only)</span>
                </button>
              </div>

              {/* Source Entitlement vs Active Match Comparison Banner */}
              <div className="mt-3 p-3 rounded-lg bg-[#131c27] border border-[#2a475e]/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <span className="text-slate-400 font-medium">Original Storefront Entitlement:</span>
                  <span className="px-1.5 py-0.5 rounded bg-[#1b2838] border border-[#2a475e] text-[10px] font-bold text-sky-300">
                    {getStorefrontDisplayName(sourcePlatform?.platformId || 'steam')}
                  </span>
                  <span className="text-white font-semibold truncate">
                    &ldquo;{rawSourceTitle}&rdquo;
                  </span>
                  {sourcePlatform?.platformGameId && (
                    <span className="text-[10px] font-mono text-slate-400">
                      (Platform ID: {sourcePlatform.platformGameId})
                    </span>
                  )}
                </div>

                {existingOverride && (
                  <div className="flex flex-wrap items-center gap-1.5 min-w-0 sm:border-l sm:border-[#2a475e] sm:pl-3">
                    <span className="text-amber-300/90 font-medium">Currently Routed To:</span>
                    <span className="px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-500/40 text-[10px] font-bold text-amber-300 uppercase">
                      {existingOverride.matchedStore}
                    </span>
                    <span className="text-amber-200 font-semibold truncate">
                      &ldquo;{existingOverride.title || game.title}&rdquo;
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">
                      (ID: {existingOverride.matchedId})
                    </span>
                  </div>
                )}
              </div>

              {/* Candidate Results Grid */}
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Suggested Matches ({candidates.length})
                  </span>
                  <span className="text-[11px] text-slate-500">
                    Click any candidate to scrape official high-res posters & store metadata
                  </span>
                </div>

                {isLoadingCandidates ? (
                  <div className="py-16 flex flex-col items-center justify-center gap-3 text-slate-400">
                    <Loader2 className="w-8 h-8 animate-spin text-[#66c0f4]" />
                    <span className="text-xs font-medium">Scanning Steam, GOG, Epic & IGDB databases...</span>
                  </div>
                ) : candidates.length === 0 ? (
                  <div className="py-16 text-center text-slate-500 border border-dashed border-[#2a475e] rounded-lg">
                    <Info className="w-8 h-8 mx-auto mb-2 text-slate-600" />
                    <p className="text-sm font-medium text-slate-400">No match candidates found</p>
                    <p className="text-xs mt-1">Try modifying the search query above or switching source tabs.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[50vh] overflow-y-auto pr-1 custom-scrollbar">
                    {candidates.map((cand) => {
                      const isSelected = selectedCandidate?.id === cand.id;
                      const isCurrentOverride = existingOverride?.matchedId === cand.id;
                      const storeUrl =
                        cand.storeUrl ||
                        buildCandidateStoreUrl({
                          source: cand.source,
                          title: cand.title,
                          steamAppId: cand.steamAppId,
                          gogId: cand.source === 'gog' ? cand.id : undefined,
                          epicSlug: cand.source === 'epic' ? String(cand.id) : undefined,
                          igdbId: cand.igdbId ?? (cand.source === 'igdb' ? cand.id : undefined),
                        });

                      let sourceColor = 'bg-sky-950/70 border-sky-600/50 text-sky-300';
                      if (cand.source === 'gog') {
                        sourceColor = 'bg-purple-950/70 border-purple-600/50 text-purple-300';
                      } else if (cand.source === 'epic') {
                        sourceColor = 'bg-zinc-800 border-zinc-600 text-zinc-200';
                      } else if (cand.source === 'igdb') {
                        sourceColor = 'bg-emerald-950/70 border-emerald-600/50 text-emerald-300';
                      }

                      return (
                        <div
                          key={`${cand.source}-${cand.id}`}
                          onClick={() => handleSelectCandidate(cand)}
                          className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all duration-150 group relative ${
                            isSelected
                              ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/10'
                              : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/70 hover:bg-[#1b2838]/80'
                          }`}
                        >
                          {/* Candidate Poster / Thumbnail Preview */}
                          <div className="relative w-14 aspect-[2/3] rounded bg-black/60 overflow-hidden shrink-0 border border-black/40">
                            {cand.capsuleImage ? (
                              <img
                                src={cand.capsuleImage}
                                alt={cand.title}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                                onError={(e) => {
                                  // Fallback to header or placeholder
                                  if (cand.headerImage && e.currentTarget.src !== cand.headerImage) {
                                    e.currentTarget.src = cand.headerImage;
                                  }
                                }}
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-slate-600">
                                <ImageIcon className="w-5 h-5" />
                              </div>
                            )}
                          </div>

                          {/* Candidate Meta Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap mb-1">
                              {/* Source badge */}
                              <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border ${sourceColor}`}>
                                {cand.source}
                              </span>

                              {cand.year && (
                                <span className="text-[10px] text-slate-400 font-mono">
                                  ({cand.year})
                                </span>
                              )}

                              {cand.confidenceScore != null && cand.confidenceScore > 0 && (
                                <span className={`text-[10px] font-semibold ml-auto px-1.5 py-0.5 rounded border ${
                                  (cand.confidenceScore <= 1 ? cand.confidenceScore * 100 : cand.confidenceScore) >= 90
                                    ? 'text-emerald-300 bg-emerald-950/60 border-emerald-500/40'
                                    : (cand.confidenceScore <= 1 ? cand.confidenceScore * 100 : cand.confidenceScore) >= 70
                                    ? 'text-sky-300 bg-sky-950/60 border-sky-500/40'
                                    : 'text-amber-300 bg-amber-950/60 border-amber-500/40'
                                }`}>
                                  {formatMatchPercentage(cand.confidenceScore)}
                                </span>
                              )}
                            </div>

                            <h4 className="text-xs font-semibold text-white group-hover:text-[#66c0f4] transition-colors line-clamp-1 leading-tight" title={cand.title}>
                              {cand.title}
                            </h4>

                            {cand.description && (
                              <p className="text-[11px] text-slate-400 line-clamp-2 mt-1 leading-relaxed">
                                {cand.description}
                              </p>
                            )}

                            <div className="mt-2 flex items-center gap-2 flex-wrap">
                              {storeUrl && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    handleOpenExternal(storeUrl, e);
                                  }}
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#131c27] hover:bg-[#2a475e] border border-[#2a475e] text-[10px] font-semibold text-[#66c0f4] hover:text-white transition-colors cursor-pointer"
                                  title={`Open ${cand.source.toUpperCase()} store page for ${cand.title} in browser`}
                                >
                                  <ExternalLink className="w-2.5 h-2.5" />
                                  <span>Store Page</span>
                                </button>
                              )}

                              {isCurrentOverride && (
                                <div className="inline-flex items-center gap-1 text-[10px] text-amber-300 font-medium">
                                  <Check className="w-3 h-3 text-amber-400" />
                                  <span>Current Override</span>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Right Arrow indicator */}
                          <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-[#66c0f4] group-hover:translate-x-0.5 transition-all self-center shrink-0" />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ================= STEP 2: COVER ART PICKER ================= */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-[#2a475e]/60 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <ImageIcon className="w-4 h-4 text-[#66c0f4]" />
                    <span>Select 2:3 Vertical Cover Art</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Choose from official high-resolution storefront posters or search across all stores
                  </p>
                </div>

                {selectedCandidate && (
                  <div className="flex items-center gap-2 bg-[#16202d] px-3 py-1 rounded-md border border-[#2a475e]">
                    <span className="text-[10px] uppercase font-bold text-slate-400">Selected Candidate:</span>
                    <span className="text-xs font-semibold text-white">{selectedCandidate.title}</span>
                  </div>
                )}
              </div>

              {/* Independent Cover Art Search Bar & Source Filter Pills */}
              <div className="space-y-2.5 bg-[#131c27] p-3 rounded-lg border border-[#2a475e]/70">
                <form onSubmit={(e) => handleSearchCovers(e)} className="flex flex-col sm:flex-row gap-2.5">
                  <div className="relative flex-1">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                    <input
                      type="text"
                      value={coverSearchTerm}
                      onChange={(e) => setCoverSearchTerm(e.target.value)}
                      placeholder="Search cover art by game title across Steam, IGDB, GOG, Epic..."
                      className="w-full pl-9 pr-8 py-1.5 rounded-md bg-[#16202d] border border-[#2a475e] text-white placeholder-slate-500 text-xs focus:outline-none focus:border-[#66c0f4] transition-colors"
                    />
                    {coverSearchTerm && (
                      <button
                        type="button"
                        onClick={() => setCoverSearchTerm('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <button
                    type="submit"
                    disabled={isSearchingCovers || isScrapingDetails}
                    className="px-3.5 py-1.5 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-200 hover:text-white hover:border-[#66c0f4] transition-colors font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow shrink-0"
                  >
                    {isSearchingCovers ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[#66c0f4]" />
                    ) : (
                      <Search className="w-3.5 h-3.5 text-[#66c0f4]" />
                    )}
                    <span>Search Covers</span>
                  </button>
                </form>

                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-1 p-1 rounded-md bg-[#16202d] border border-[#2a475e]/70">
                    {sourceTabs.map((tab) => {
                      const isTabActive = coverSourceTab === tab;
                      return (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => {
                            setCoverSourceTab(tab);
                            handleSearchCovers(undefined, tab);
                          }}
                          className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-all cursor-pointer ${
                            isTabActive
                              ? 'bg-[#66c0f4] text-slate-950 shadow-sm'
                              : 'text-slate-400 hover:text-white hover:bg-[#1b2838]'
                          }`}
                        >
                          {tab}
                        </button>
                      );
                    })}
                  </div>
                  <span className="text-[11px] text-slate-400">
                    {`${combinedCovers.length} cover option${combinedCovers.length === 1 ? '' : 's'} shown`}
                  </span>
                </div>
              </div>

              {isScrapingDetails || (isSearchingCovers && combinedCovers.length === 0) ? (
                <div className="py-20 flex flex-col items-center justify-center gap-3 text-slate-400">
                  <Loader2 className="w-8 h-8 animate-spin text-[#66c0f4]" />
                  <span className="text-xs font-medium">
                    {isSearchingCovers
                      ? 'Searching cover art across storefronts...'
                      : 'Scraping high-resolution storefront box art, screenshots & blurbs...'}
                  </span>
                </div>
              ) : combinedCovers.length === 0 ? (
                <div className="py-16 text-center text-slate-500 border border-dashed border-[#2a475e] rounded-lg">
                  <p className="text-sm font-medium text-slate-400">No cover art options available</p>
                  <p className="text-xs mt-1">
                    Use the cover search bar above to find vertical box art from Steam, IGDB, GOG, or Epic.
                  </p>
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="mt-3 px-3 py-1.5 rounded bg-[#1b2838] text-xs text-[#66c0f4] hover:brightness-110"
                  >
                    Back to Candidate Selection
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 max-h-[44vh] overflow-y-auto pr-1 custom-scrollbar">
                  {combinedCovers.map((cover, idx) => {
                    const isSelected = selectedCoverUrl === cover.url;

                    let sourceBadgeColor = 'bg-sky-950/80 text-sky-300 border-sky-500/50';
                    if (cover.source === 'gog') sourceBadgeColor = 'bg-purple-950/80 text-purple-300 border-purple-500/50';
                    else if (cover.source === 'epic') sourceBadgeColor = 'bg-zinc-800 text-zinc-200 border-zinc-600';
                    else if (cover.source === 'igdb') sourceBadgeColor = 'bg-emerald-950/80 text-emerald-300 border-emerald-500/50';

                    return (
                      <div
                        key={`${cover.url}-${idx}`}
                        onClick={() => setSelectedCoverUrl(cover.url)}
                        className={`relative rounded-lg overflow-hidden border cursor-pointer transition-all duration-200 flex flex-col group ${
                          isSelected
                            ? 'border-[#66c0f4] ring-2 ring-[#66c0f4]/50 shadow-xl shadow-[#66c0f4]/20 scale-[1.02]'
                            : 'border-[#2a475e] hover:border-slate-400 bg-[#16202d]'
                        }`}
                      >
                        {/* 2:3 Aspect Ratio Container */}
                        <div className="relative aspect-[2/3] w-full bg-black/60 overflow-hidden flex items-center justify-center">
                          <img
                            src={cover.url}
                            alt={cover.label}
                            loading="lazy"
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                            onError={(e) => {
                              // If image fails, mark container
                              e.currentTarget.style.display = 'none';
                            }}
                          />

                          {/* Selected Checkmark Badge */}
                          {isSelected && (
                            <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-[#66c0f4] text-slate-950 flex items-center justify-center shadow-lg font-bold">
                              <Check className="w-4 h-4 stroke-[3]" />
                            </div>
                          )}

                          {/* Source Pill */}
                          <div className="absolute bottom-2 left-2">
                            <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border backdrop-blur-sm ${sourceBadgeColor}`}>
                              {cover.source}
                            </span>
                          </div>

                          {/* Dimensions Pill */}
                          {cover.dimensions && (
                            <div className="absolute bottom-2 right-2 bg-black/80 text-slate-300 text-[9px] font-mono px-1.5 py-0.5 rounded border border-white/20">
                              {cover.dimensions}
                            </div>
                          )}
                        </div>

                        {/* Label info */}
                        <div className="p-2 bg-[#16202d] border-t border-[#2a475e]/60">
                          <p className="text-[11px] font-medium text-slate-200 truncate" title={cover.label}>
                            {cover.label}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ================= STEP 3: REVIEW SCORE & SOURCE ================= */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-[#2a475e]/60 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Award className="w-4 h-4 text-[#66c0f4]" />
                    <span>Select Review Score &amp; Source</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Select verified press review consensus, player community rating, or enter a custom score
                  </p>
                </div>

                {selectedCandidate && (
                  <div className="flex items-center gap-2 bg-[#16202d] px-3 py-1 rounded-md border border-[#2a475e]">
                    <span className="text-[10px] uppercase font-bold text-slate-400">Selected Candidate:</span>
                    <span className="text-xs font-semibold text-white truncate max-w-[200px]">{selectedCandidate.title}</span>
                  </div>
                )}
              </div>

              {/* Independent Review Score Search Bar */}
              <form
                onSubmit={handleReviewSearchSubmit}
                className="flex flex-col sm:flex-row gap-2.5 bg-[#131c27] p-3 rounded-lg border border-[#2a475e]/70"
              >
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  <input
                    type="text"
                    value={reviewSearchTerm}
                    onChange={(e) => setReviewSearchTerm(e.target.value)}
                    placeholder="Search review scores by title across Metacritic, OpenCritic, Steam & GOG..."
                    className="w-full pl-9 pr-8 py-1.5 rounded-md bg-[#16202d] border border-[#2a475e] text-white placeholder-slate-500 text-xs focus:outline-none focus:border-[#66c0f4] transition-colors"
                  />
                  {reviewSearchTerm && (
                    <button
                      type="button"
                      onClick={() => setReviewSearchTerm('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={isLoadingReviews}
                  className="px-3.5 py-1.5 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-200 hover:text-white hover:border-[#66c0f4] transition-colors font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow shrink-0"
                >
                  {isLoadingReviews ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-[#66c0f4]" />
                  ) : (
                    <Search className="w-3.5 h-3.5 text-[#66c0f4]" />
                  )}
                  <span>Search Reviews</span>
                </button>
              </form>

              {isLoadingReviews ? (
                <div className="py-20 flex flex-col items-center justify-center gap-3 text-slate-400">
                  <Loader2 className="w-8 h-8 animate-spin text-[#66c0f4]" />
                  <span className="text-xs font-medium">
                    Discovering reviews from Metacritic, OpenCritic, Steam &amp; storefront anchors...
                  </span>
                </div>
              ) : (
                <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1 custom-scrollbar">
                  {/* Notice if no candidates discovered */}
                  {reviewCandidates.length === 0 && (
                    <div className="p-3 rounded-lg bg-[#16202d] border border-dashed border-[#2a475e] text-center text-xs text-slate-400">
                      No external review scores were discovered automatically for this title. You can search another title above, specify a manual score, or keep it unrated below.
                    </div>
                  )}

                  {/* Discovered Candidates */}
                  {reviewCandidates.map((cand) => {
                    const isSelected = selectedReviewOptionId === cand.id;
                    const colors = getTierColor(cand.tier);

                    let sourceBadgeColor = 'bg-yellow-950/80 text-yellow-300 border-yellow-500/50';
                    if (cand.source === 'opencritic') {
                      sourceBadgeColor = 'bg-purple-950/80 text-purple-300 border-purple-500/50';
                    } else if (cand.source === 'steam') {
                      sourceBadgeColor = 'bg-sky-950/80 text-sky-300 border-sky-500/50';
                    } else if (cand.source === 'gog') {
                      sourceBadgeColor = 'bg-indigo-950/80 text-indigo-300 border-indigo-500/50';
                    } else if (cand.source === 'epic') {
                      sourceBadgeColor = 'bg-zinc-800 text-zinc-200 border-zinc-600';
                    }

                    return (
                      <div
                        key={cand.id}
                        onClick={() => handleSelectCandidateOption(cand)}
                        className={`p-3.5 rounded-lg border cursor-pointer transition-all duration-150 flex items-start gap-3.5 relative ${
                          isSelected
                            ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/15 ring-1 ring-[#66c0f4]/50'
                            : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/60 hover:bg-[#1b2838]/80'
                        }`}
                      >
                        {/* Radio selection ring */}
                        <div
                          className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 mt-1 transition-all ${
                            isSelected
                              ? 'border-[#66c0f4] bg-[#66c0f4]'
                              : 'border-slate-500 bg-transparent'
                          }`}
                        >
                          {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-slate-950" />}
                        </div>

                        {/* Tier Score Pill */}
                        <div
                          className={`flex items-center justify-center px-3 py-1.5 rounded font-black text-sm text-white ${colors.scoreBg} shadow-sm shrink-0 min-w-[42px] mt-0.5`}
                        >
                          {cand.score}
                        </div>

                        {/* Details */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            {/* Source Pill */}
                            <span
                              className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border ${sourceBadgeColor}`}
                            >
                              {cand.source.replace('_', ' ')}
                            </span>

                            {/* Source Label */}
                            <span className="text-xs font-bold text-white">
                              {cand.sourceLabel}
                            </span>

                            {/* Tier Badge */}
                            <span className={`text-[11px] font-bold ${colors.accentText}`}>
                              {cand.tier}
                            </span>

                            {/* Live Route Badge for storefront/critic sources */}
                            {cand.source !== 'custom' && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-sky-300 bg-sky-950/70 border border-sky-500/40 px-2 py-0.5 rounded">
                                <span>Live Route • Auto-updates on sync</span>
                              </span>
                            )}

                            {/* Recommended / Ground Truth Badge */}
                            {(cand.isRecommended || cand.groundTruthSource) && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-300 bg-emerald-950/70 border border-emerald-500/40 px-2 py-0.5 rounded shadow-sm">
                                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                                <span>{cand.groundTruthSource || 'Recommended'}</span>
                              </span>
                            )}

                            {/* Badge text (if distinct) */}
                            {cand.badgeText && !cand.isRecommended && !cand.groundTruthSource && (
                              <span className="text-[10px] text-slate-400 bg-[#131c27] px-1.5 py-0.5 rounded border border-[#2a475e]/60">
                                {cand.badgeText}
                              </span>
                            )}
                          </div>

                          {/* Extra info row: review count, percent recommended, user score */}
                          <div className="flex items-center gap-3 text-[11px] text-slate-400 flex-wrap">
                            {cand.numReviews != null && (
                              <span>{`${cand.numReviews.toLocaleString()} reviews`}</span>
                            )}
                            {cand.percentRecommended != null && (
                              <span>{`• ${cand.percentRecommended}% recommended`}</span>
                            )}
                            {cand.userScoreRaw != null && (
                              <span>{`• User Score: ${cand.userScoreRaw}/10`}</span>
                            )}
                            {cand.starRatingRaw != null && (
                              <span>{`• Rating: ${cand.starRatingRaw}/5`}</span>
                            )}
                            {cand.url && (
                              <button
                                type="button"
                                onClick={(e) => handleOpenExternal(cand.url, e)}
                                className="inline-flex items-center gap-1 text-[11px] text-[#66c0f4] hover:text-white hover:underline transition-colors ml-auto"
                                title="Open review page in browser"
                              >
                                <span>Source</span>
                                <ExternalLink className="w-3 h-3" />
                              </button>
                            )}
                          </div>

                          {/* Summary blurb */}
                          {cand.summary && (
                            <p className="text-xs text-slate-300/90 mt-1.5 line-clamp-2 leading-relaxed italic">
                              "{cand.summary}"
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Manual / Custom Score Card */}
                  {(() => {
                    const isCustomSelected = selectedReviewOptionId === 'custom';
                    const parsedScore = parseInt(String(customScoreValue), 10);
                    const isValidScore = !isNaN(parsedScore) && parsedScore >= 0 && parsedScore <= 100;
                    const liveTier = isValidScore ? calculateTier(parsedScore) : null;
                    const liveColors = liveTier ? getTierColor(liveTier) : null;

                    return (
                      <div
                        onClick={handleSelectCustomCard}
                        className={`p-3.5 rounded-lg border transition-all duration-150 flex flex-col gap-3 cursor-pointer ${
                          isCustomSelected
                            ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/15 ring-1 ring-[#66c0f4]/50'
                            : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/60 hover:bg-[#1b2838]/80'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <div
                              className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition-all ${
                                isCustomSelected
                                  ? 'border-[#66c0f4] bg-[#66c0f4]'
                                  : 'border-slate-500 bg-transparent'
                              }`}
                            >
                              {isCustomSelected && <div className="w-1.5 h-1.5 rounded-full bg-slate-950" />}
                            </div>

                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-bold text-white">Manual / Custom Score</span>
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-950/70 border border-amber-500/40 text-amber-300">
                                  Custom
                                </span>
                              </div>
                              <p className="text-[11px] text-slate-400 mt-0.5">
                                Specify your own custom score, rating source, review count, and blurb
                              </p>
                            </div>
                          </div>

                          {/* Live Tier Preview in Header if valid */}
                          {isValidScore && liveTier && liveColors && (
                            <div className="flex items-center gap-2 shrink-0">
                              <div
                                className={`flex items-center justify-center px-2.5 py-1 rounded font-black text-xs text-white ${liveColors.scoreBg} shadow-sm`}
                              >
                                {parsedScore}
                              </div>
                              <span className={`text-xs font-bold ${liveColors.accentText}`}>
                                {liveTier}
                              </span>
                            </div>
                          )}
                        </div>

                        {/* Inline Form - visible when selected */}
                        {isCustomSelected && (
                          <div
                            className="mt-2 pt-3 border-t border-[#2a475e]/70 space-y-3 cursor-default"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              {/* Score Input with Live Tier Badge */}
                              <div>
                                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                                  Score (0 - 100) <span className="text-rose-400">*</span>
                                </label>
                                <div className="flex items-center gap-2">
                                  <input
                                    type="number"
                                    min="0"
                                    max="100"
                                    value={customScoreValue}
                                    onChange={(e) => handleCustomScoreChange(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') e.preventDefault();
                                    }}
                                    placeholder="e.g. 88"
                                    className="w-24 px-3 py-1.5 rounded bg-[#131c27] border border-[#2a475e] text-sm text-white font-mono focus:outline-none focus:border-[#66c0f4]"
                                  />
                                  {isValidScore && liveTier && liveColors ? (
                                    <div
                                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-bold text-white ${liveColors.scoreBg} shadow-sm`}
                                    >
                                      <span>{liveTier}</span>
                                    </div>
                                  ) : (
                                    <span className="text-[11px] text-slate-500 font-mono">
                                      Enter 0-100
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Source Selector Dropdown */}
                              <div>
                                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                                  Rating Source
                                </label>
                                <select
                                  value={customScoreSource}
                                  onChange={(e) =>
                                    handleCustomSourceChange(e.target.value as CriticSource)
                                  }
                                  className="w-full px-3 py-1.5 rounded bg-[#131c27] border border-[#2a475e] text-xs text-white focus:outline-none focus:border-[#66c0f4]"
                                >
                                  <option value="metacritic">Metacritic</option>
                                  <option value="opencritic">OpenCritic</option>
                                  <option value="steam">Steam</option>
                                  <option value="gog">GOG</option>
                                  <option value="epic">Epic Games</option>
                                  <option value="custom">Custom / Other</option>
                                </select>
                              </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              {/* Optional Number of Reviews */}
                              <div>
                                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                                  Number of Reviews (Optional)
                                </label>
                                <input
                                  type="number"
                                  min="0"
                                  value={customScoreNumReviews}
                                  onChange={(e) => handleCustomReviewsChange(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') e.preventDefault();
                                  }}
                                  placeholder="e.g. 120"
                                  className="w-full px-3 py-1.5 rounded bg-[#131c27] border border-[#2a475e] text-xs text-white font-mono focus:outline-none focus:border-[#66c0f4]"
                                />
                              </div>

                              {/* Optional Canonical URL */}
                              <div>
                                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                                  Canonical URL (Optional)
                                </label>
                                <input
                                  type="url"
                                  value={customScoreUrl}
                                  onChange={(e) => handleCustomUrlChange(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') e.preventDefault();
                                  }}
                                  placeholder="https://..."
                                  className="w-full px-3 py-1.5 rounded bg-[#131c27] border border-[#2a475e] text-xs text-white focus:outline-none focus:border-[#66c0f4]"
                                />
                              </div>
                            </div>

                            {/* Optional Summary Blurb */}
                            <div>
                              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                                Summary Consensus / Blurb (Optional)
                              </label>
                              <input
                                type="text"
                                value={customScoreSummary}
                                onChange={(e) => handleCustomSummaryChange(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') e.preventDefault();
                                }}
                                placeholder="e.g. Universal acclaim based on critic reviews."
                                className="w-full px-3 py-1.5 rounded bg-[#131c27] border border-[#2a475e] text-xs text-white focus:outline-none focus:border-[#66c0f4]"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Unrated / Hide Review Score Card */}
                  {(() => {
                    const isUnratedSelected = selectedReviewOptionId === 'unrated';
                    return (
                      <div
                        onClick={handleSelectUnrated}
                        className={`p-3.5 rounded-lg border transition-all duration-150 flex items-center justify-between gap-3 cursor-pointer ${
                          isUnratedSelected
                            ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/15 ring-1 ring-[#66c0f4]/50'
                            : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/60 hover:bg-[#1b2838]/80'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition-all ${
                              isUnratedSelected
                                ? 'border-[#66c0f4] bg-[#66c0f4]'
                                : 'border-slate-500 bg-transparent'
                            }`}
                          >
                            {isUnratedSelected && <div className="w-1.5 h-1.5 rounded-full bg-slate-950" />}
                          </div>

                          <div className="flex items-center gap-2">
                            <EyeOff className="w-4 h-4 text-slate-400" />
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-bold text-white">Unrated / Hide Review Score</span>
                              </div>
                              <p className="text-[11px] text-slate-400 mt-0.5">
                                Suppress review score pill and critic badge for this game in your library
                              </p>
                            </div>
                          </div>
                        </div>

                        <span className="text-[10px] text-slate-500 uppercase font-mono px-2 py-0.5 rounded border border-[#2a475e]">
                          No Score
                        </span>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* ================= STEP 4: REVIEW & CONFIRM ================= */}
          {step === 4 && scrapedBundle && (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-[#2a475e]/60 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span>Review &amp; Confirm Game Metadata Override</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Review scraped metadata, switch storefront metadata sources, select your preferred blurb synopsis, and apply to catalog
                  </p>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-sky-950/70 border border-sky-500/50 text-sky-300">
                    Target: {scrapedBundle.matchedStore}
                  </span>
                  {scrapedBundle.steamAppId ? (
                    <span className="text-[10px] font-mono text-slate-400">
                      Steam ID: {scrapedBundle.steamAppId}
                    </span>
                  ) : null}
                  {(() => {
                    const targetStoreUrl = buildCandidateStoreUrl({
                      source: scrapedBundle.matchedStore,
                      title: scrapedBundle.title,
                      steamAppId: scrapedBundle.steamAppId ?? undefined,
                      gogId:
                        scrapedBundle.matchedStore === 'gog'
                          ? scrapedBundle.matchedId
                          : undefined,
                      epicSlug:
                        scrapedBundle.matchedStore === 'epic'
                          ? String(scrapedBundle.matchedId)
                          : undefined,
                      igdbId: scrapedBundle.igdbId,
                    });
                    if (!targetStoreUrl) return null;
                    return (
                      <button
                        type="button"
                        onClick={(e) => handleOpenExternal(targetStoreUrl, e)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#131c27] hover:bg-[#2a475e] border border-[#2a475e] text-[10px] font-semibold text-[#66c0f4] hover:text-white transition-colors cursor-pointer"
                        title={`Open ${scrapedBundle.matchedStore.toUpperCase()} store page in browser`}
                      >
                        <ExternalLink className="w-3 h-3" />
                        <span>Store Page</span>
                      </button>
                    );
                  })()}
                </div>
              </div>

              {/* Metadata Source & Storefront Search Section */}
              <div className="p-3.5 rounded-lg bg-[#131c27] border border-[#2a475e]/80 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="text-xs font-bold text-white">
                        Metadata Source &amp; Storefront Search
                      </h4>
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-sky-300 bg-sky-950/70 border border-sky-500/40 px-2 py-0.5 rounded">
                        <span>Live Route • Auto-updates main page &amp; media on sync</span>
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Routes &ldquo;About This Game&rdquo;, screenshots, trailers, system requirements, developer &amp; synopsis to the selected storefront (custom text edits stay pinned)
                    </p>
                  </div>
                </div>

                <form
                  onSubmit={(e) => handleSearchMetadataSources(e)}
                  className="flex flex-col sm:flex-row gap-2.5"
                >
                  <div className="relative flex-1">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                    <input
                      type="text"
                      value={metadataSearchTerm}
                      onChange={(e) => setMetadataSearchTerm(e.target.value)}
                      placeholder="Search game metadata across Steam, GOG, Epic & IGDB..."
                      className="w-full pl-9 pr-8 py-1.5 rounded-md bg-[#16202d] border border-[#2a475e] text-white placeholder-slate-500 text-xs focus:outline-none focus:border-[#66c0f4] transition-colors"
                    />
                    {metadataSearchTerm && (
                      <button
                        type="button"
                        onClick={() => setMetadataSearchTerm('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <button
                    type="submit"
                    disabled={isSearchingMetadataSources}
                    className="px-3.5 py-1.5 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-200 hover:text-white hover:border-[#66c0f4] transition-colors font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow shrink-0"
                  >
                    {isSearchingMetadataSources ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[#66c0f4]" />
                    ) : (
                      <Search className="w-3.5 h-3.5 text-[#66c0f4]" />
                    )}
                    <span>Search Metadata</span>
                  </button>
                </form>

                {metadataSources.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {metadataSources.map((srcOpt) => {
                      const isActive = selectedMetadataSourceId === srcOpt.id;
                      const srcStoreUrl =
                        srcOpt.storeUrl ||
                        buildCandidateStoreUrl({
                          source: srcOpt.source,
                          title: srcOpt.title,
                          steamAppId: srcOpt.steamAppId ?? undefined,
                          gogId: srcOpt.gogId,
                          epicSlug: srcOpt.epicSlug,
                          igdbId: srcOpt.igdbId,
                        });
                      return (
                        <div
                          key={srcOpt.id}
                          className={`rounded-md border text-xs font-semibold transition-all flex items-center overflow-hidden ${
                            isActive
                              ? 'bg-[#66c0f4] text-slate-950 border-[#66c0f4] shadow-md'
                              : 'bg-[#16202d] border-[#2a475e] text-slate-300 hover:text-white hover:border-[#66c0f4]/60'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => handleSelectMetadataSource(srcOpt)}
                            className="px-3 py-1.5 flex items-center gap-2 cursor-pointer"
                          >
                            <span className="uppercase text-[10px] font-bold opacity-80">
                              {srcOpt.source}
                            </span>
                            <span>•</span>
                            <span>{srcOpt.sourceLabel}</span>
                          </button>
                          {srcStoreUrl && (
                            <button
                              type="button"
                              onClick={(e) => {
                                handleOpenExternal(srcStoreUrl, e);
                              }}
                              className={`px-2 py-1.5 border-l flex items-center gap-1 cursor-pointer transition-colors ${
                                isActive
                                  ? 'border-slate-950/20 hover:bg-black/15 text-slate-950'
                                  : 'border-[#2a475e] hover:bg-[#2a475e] text-[#66c0f4] hover:text-white'
                              }`}
                              title={`Open ${srcOpt.source.toUpperCase()} store page for ${srcOpt.title} in browser`}
                            >
                              <ExternalLink className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Left 1/3: Chosen Cover Poster Preview */}
                <div className="flex flex-col items-center">
                  <div className="relative aspect-[2/3] w-48 rounded-lg overflow-hidden border-2 border-[#66c0f4] shadow-2xl bg-black/60">
                    <img
                      src={selectedCoverUrl || scrapedBundle.capsuleImage}
                      alt={customTitle || scrapedBundle.title}
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute top-2 left-2 bg-black/80 text-emerald-400 text-[10px] font-bold px-2 py-0.5 rounded border border-emerald-500/40">
                      Selected 2:3 Cover
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setStep(2)}
                    className="mt-3 text-xs text-[#66c0f4] hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    <ImageIcon className="w-3 h-3" />
                    <span>Change Cover Poster</span>
                  </button>
                </div>

                {/* Right 2/3: Metadata Fields Review & Blurb Selector */}
                <div className="md:col-span-2 space-y-4">
                  {/* Title Input */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Game Title
                    </label>
                    <input
                      type="text"
                      value={customTitle}
                      onChange={(e) => setCustomTitle(e.target.value)}
                      className="w-full px-3 py-1.5 rounded bg-[#16202d] border border-[#2a475e] text-sm text-white font-medium focus:outline-none focus:border-[#66c0f4]"
                    />
                  </div>

                  {/* Dedicated Review Score Badge Preview */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Review Score &amp; Source Override
                    </label>
                    <div className="p-3 rounded-lg bg-[#16202d] border border-[#2a475e]/80 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {selectedReviewData ? (
                          <>
                            {(() => {
                              const colors = getTierColor(selectedReviewData.tier);
                              return (
                                <div
                                  className={`flex items-center justify-center px-2.5 py-1 rounded font-black text-sm text-white ${colors.scoreBg} shadow-sm shrink-0 min-w-[36px]`}
                                >
                                  {selectedReviewData.score}
                                </div>
                              );
                            })()}
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-bold text-white">
                                  {selectedReviewData.tier}
                                </span>
                                <span className="text-[11px] text-slate-300 capitalize font-medium">
                                  {`• ${selectedReviewData.source.replace('_', ' ')}`}
                                </span>
                                {selectedReviewData.numReviews ? (
                                  <span className="text-[11px] text-slate-400">
                                    {`(${selectedReviewData.numReviews.toLocaleString()} reviews)`}
                                  </span>
                                ) : null}
                                {selectedReviewOptionId !== 'custom' &&
                                  selectedReviewOptionId !== 'unrated' &&
                                  selectedReviewData.source !== 'custom' && (
                                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-sky-300 bg-sky-950/70 border border-sky-500/40 px-2 py-0.5 rounded">
                                      <span>Live Route • Auto-updates on sync</span>
                                    </span>
                                  )}
                              </div>
                              {selectedReviewData.summary && (
                                <p className="text-[11px] text-slate-400 truncate max-w-md mt-0.5">
                                  {selectedReviewData.summary}
                                </p>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="flex items-center gap-2 text-slate-400 text-xs py-1">
                            <EyeOff className="w-4 h-4 text-slate-500 shrink-0" />
                            <span className="font-medium text-slate-300">
                              Unrated (Review badge hidden)
                            </span>
                          </div>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => setStep(3)}
                        className="px-2.5 py-1.5 rounded bg-[#1b2838] border border-[#2a475e] text-xs text-[#66c0f4] hover:text-white hover:border-[#66c0f4] transition-colors flex items-center gap-1.5 shrink-0 font-medium cursor-pointer"
                        title="Navigate to Step 3 to change review score"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>Edit</span>
                      </button>
                    </div>
                  </div>

                  {/* Badges / Meta row */}
                  {(() => {
                    const displayReleaseDate = activeReleaseDate || scrapedBundle.releaseDate;
                    const displayDevelopers = activeDevelopers.length
                      ? activeDevelopers
                      : scrapedBundle.developers || [];
                    return (
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        {displayReleaseDate && (
                          <div className="p-2 rounded bg-[#16202d] border border-[#2a475e]/70">
                            <span className="text-[10px] text-slate-400 flex items-center gap-1 mb-0.5">
                              <Calendar className="w-3 h-3" /> Release Date
                            </span>
                            <span className="font-semibold text-slate-200">{displayReleaseDate}</span>
                          </div>
                        )}

                        {displayDevelopers.length > 0 && (
                          <div className="p-2 rounded bg-[#16202d] border border-[#2a475e]/70">
                            <span className="text-[10px] text-slate-400 flex items-center gap-1 mb-0.5">
                              <Building className="w-3 h-3" /> Developer
                            </span>
                            <span className="font-semibold text-slate-200 truncate block">
                              {displayDevelopers.join(', ')}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Genres & Tags */}
                  {(() => {
                    const displayGenres = activeGenres.length
                      ? activeGenres
                      : scrapedBundle.genres || [];
                    if (displayGenres.length === 0) return null;
                    return (
                      <div>
                        <span className="text-xs font-semibold text-slate-400 mb-1 flex items-center gap-1">
                          <Tag className="w-3 h-3" /> Genres &amp; Categories
                        </span>
                        <div className="flex flex-wrap gap-1.5 mt-1">
                          {displayGenres.map((g) => (
                            <span
                              key={g}
                              className="px-2 py-0.5 rounded bg-[#16202d] border border-[#2a475e] text-[10px] text-slate-300"
                            >
                              {g}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Blurb Synopsis Selector */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Storefront Synopsis / Blurb
                    </label>

                    {(() => {
                      const displayDescriptions = activeAvailableDescriptions.length
                        ? activeAvailableDescriptions
                        : scrapedBundle.availableDescriptions || [];
                      if (displayDescriptions.length <= 1) return null;
                      return (
                        <div className="space-y-2 mb-2">
                          {displayDescriptions.map((desc, i) => {
                            const isBlurbSelected = selectedBlurb === desc.text;
                            return (
                              <div
                                key={i}
                                onClick={() => setSelectedBlurb(desc.text)}
                                className={`p-2 rounded-md border text-xs cursor-pointer transition-colors ${
                                  isBlurbSelected
                                    ? 'bg-[#1b2838] border-[#66c0f4] text-white'
                                    : 'bg-[#16202d] border-[#2a475e]/60 text-slate-400 hover:border-slate-500'
                                }`}
                              >
                                <div className="flex items-center gap-2 font-semibold text-[11px] mb-1">
                                  <div
                                    className={`w-3 h-3 rounded-full border flex items-center justify-center ${
                                      isBlurbSelected
                                        ? 'border-[#66c0f4] bg-[#66c0f4]'
                                        : 'border-slate-500'
                                    }`}
                                  >
                                    {isBlurbSelected && (
                                      <div className="w-1.5 h-1.5 rounded-full bg-slate-950" />
                                    )}
                                  </div>
                                  <span className={isBlurbSelected ? 'text-[#66c0f4]' : 'text-slate-300'}>
                                    {desc.source}
                                  </span>
                                </div>
                                <p className="line-clamp-2 text-[11px] leading-relaxed pl-5">
                                  {desc.text}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}

                    <textarea
                      value={selectedBlurb}
                      onChange={(e) => setSelectedBlurb(e.target.value)}
                      rows={3}
                      className="w-full p-2.5 rounded bg-[#16202d] border border-[#2a475e] text-xs text-slate-200 focus:outline-none focus:border-[#66c0f4] leading-relaxed"
                      placeholder="Enter synopsis blurb..."
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Bottom Action Footer Bar */}
        <div className="px-6 py-4 border-t border-[#2a475e]/70 bg-[#131c27] flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {existingOverride && onResetOverride && (
              <button
                type="button"
                onClick={() => {
                  onResetOverride(game.id);
                  handleCloseWizard();
                }}
                className="px-3.5 py-2 rounded-md border border-rose-500/50 bg-rose-950/30 text-rose-300 hover:bg-rose-900/50 hover:text-white transition-colors text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-sm"
                title="Discard user match overrides and revert to original catalog metadata"
              >
                <RotateCcw className="w-3.5 h-3.5" />
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
                className="px-3.5 py-2 rounded-md border border-rose-500/40 bg-rose-950/40 text-rose-300 hover:bg-rose-900/60 hover:text-white transition-colors text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-sm"
                title="Hide / suppress this entry from your active library (can be restored anytime in Library Match & Overrides Studio)"
              >
                <EyeOff className="w-3.5 h-3.5" />
                <span>Hide / Suppress Entry</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep((prev) => (prev - 1) as WizardStep)}
                className="px-4 py-2 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-300 hover:text-white hover:border-slate-500 transition-colors text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleCloseWizard}
              className="px-4 py-2 rounded-md border border-transparent text-slate-400 hover:text-white hover:bg-[#1b2838] transition-colors text-xs font-semibold cursor-pointer"
            >
              Cancel
            </button>

            {step === 2 && (
              <button
                type="button"
                disabled={!selectedCoverUrl || isScrapingDetails}
                onClick={handleGoToReviewStep}
                className="px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs flex items-center gap-1.5 shadow cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span>Next: Review Score &amp; Source</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}

            {step === 3 && (
              <button
                type="button"
                onClick={() => setStep(4)}
                className="px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs flex items-center gap-1.5 shadow cursor-pointer"
              >
                <span>Next: Metadata &amp; Confirm</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}

            {step === 4 && (
              <button
                type="button"
                onClick={handleApply}
                className="px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs flex items-center gap-2 shadow-lg shadow-[#66c0f4]/20 cursor-pointer"
              >
                <Sparkles className="w-4 h-4 fill-slate-950" />
                <span>Apply Match &amp; Scrape Data</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
