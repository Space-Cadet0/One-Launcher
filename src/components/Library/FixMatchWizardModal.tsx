import React, { useState, useEffect, useCallback } from 'react';
import { CanonicalGame } from '../../contracts/game';
import {
  UserGameOverride,
  SearchMatchCandidate,
  ScrapedMetadataBundle,
} from '../../contracts/override';
import { metadataScraperService } from '../../services/scraper/metadataScraperService';
import {
  reviewCandidateService,
  ReviewCandidateOption,
} from '../../services/scraper/reviewCandidateService';
import { CriticScoreData, CriticSource } from '../../contracts/critic';
import { calculateTier, getTierColor } from '../../services/critic/criticUtils';
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

  // Step 2 & 4: Scraped metadata bundle state
  const [isScrapingDetails, setIsScrapingDetails] = useState(false);
  const [scrapedBundle, setScrapedBundle] = useState<ScrapedMetadataBundle | null>(
    initialScrapedBundle || null
  );
  const [selectedCoverUrl, setSelectedCoverUrl] = useState<string>(
    initialScrapedBundle?.capsuleImage || ''
  );
  const [selectedBlurb, setSelectedBlurb] = useState<string>(
    initialScrapedBundle?.shortDescription || ''
  );
  const [customTitle, setCustomTitle] = useState<string>(
    initialScrapedBundle?.title || game?.title || ''
  );

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

  // Load candidate matches from metadata scraper service
  const loadCandidates = useCallback(
    async (query: string, tab: SourceFilterTab, nonSteam: boolean) => {
      if (!game) return;
      setIsLoadingCandidates(true);
      try {
        const matches = await metadataScraperService.getSuggestedMatches(
          game,
          query,
          tab,
          nonSteam
        );
        setCandidates(matches);
      } catch (err) {
        console.error('Failed to load candidate matches:', err);
        setCandidates([]);
      } finally {
        setIsLoadingCandidates(false);
      }
    },
    [game]
  );

  // Load review score candidates from reviewCandidateService
  const loadReviews = useCallback(
    async (
      targetGame: CanonicalGame,
      targetCandidate: SearchMatchCandidate | null,
      targetBundle: ScrapedMetadataBundle | null
    ) => {
      setIsLoadingReviews(true);
      try {
        const result = await reviewCandidateService.discoverReviews(
          targetGame,
          targetCandidate,
          targetBundle
        );
        const discovered = result.candidates || [];
        setReviewCandidates(discovered);

        // Check if existing override has reviewScoreOverride
        if (existingOverride && existingOverride.reviewScoreOverride !== undefined) {
          if (existingOverride.reviewScoreOverride === null) {
            setSelectedReviewOptionId('unrated');
            setSelectedReviewData(null);
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
            return;
          }
        }

        // Active override from candidates if game already had one
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
          return;
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
        } else {
          setSelectedReviewOptionId('unrated');
          setSelectedReviewData(null);
        }
      } catch (err) {
        console.error('Failed to discover review candidates:', err);
        setReviewCandidates([]);
        setSelectedReviewOptionId('unrated');
        setSelectedReviewData(null);
      } finally {
        setIsLoadingReviews(false);
      }
    },
    [existingOverride]
  );

  // Reset wizard state whenever modal is opened with a new or existing game
  useEffect(() => {
    if (isOpen && game) {
      setStep(initialStep || 1);
      setSearchTerm(game.title);
      setSourceTab('All');
      setNotOnSteamOnly(false);
      setSelectedCandidate(initialCandidate || null);
      setScrapedBundle(initialScrapedBundle || null);
      setSelectedCoverUrl(initialScrapedBundle?.capsuleImage || '');
      setSelectedBlurb(initialScrapedBundle?.shortDescription || '');
      setCustomTitle(initialScrapedBundle?.title || game.title);
      setReviewCandidates(initialReviewCandidates || []);
      setIsLoadingReviews(false);
      setSelectedReviewOptionId(initialSelectedReviewOptionId || '');
      setSelectedReviewData(initialSelectedReviewData || null);
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
    game,
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

  // Trigger search on query change or tab switch
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

  // Select candidate -> proceed to Step 2 & scrape details
  const handleSelectCandidate = async (candidate: SearchMatchCandidate) => {
    setSelectedCandidate(candidate);
    setReviewCandidates([]);
    setSelectedReviewOptionId('');
    setSelectedReviewData(null);
    setStep(2);
    setIsScrapingDetails(true);
    try {
      const bundle = await metadataScraperService.scrapeMatchDetails(candidate, game);
      setScrapedBundle(bundle);
      setSelectedCoverUrl(bundle.capsuleImage);
      setSelectedBlurb(bundle.shortDescription || '');
      setCustomTitle(bundle.title);
      // Pre-warm reviews in background so Step 3 is ready immediately
      if (game) {
        loadReviews(game, candidate, bundle);
      }
    } catch (err) {
      console.error('Failed to scrape candidate details:', err);
    } finally {
      setIsScrapingDetails(false);
    }
  };

  // Proceed to Step 3 and trigger discovery if not yet loaded
  const handleGoToReviewStep = () => {
    setStep(3);
    if (game && reviewCandidates.length === 0 && !isLoadingReviews) {
      loadReviews(game, selectedCandidate, scrapedBundle);
    }
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
  };

  const handleSelectUnrated = () => {
    setSelectedReviewOptionId('unrated');
    setSelectedReviewData(null);
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
  };

  const handleSelectCustomCard = () => {
    setSelectedReviewOptionId('custom');
    if (customScoreValue === '' && selectedReviewData) {
      setCustomScoreValue(selectedReviewData.score);
      setCustomScoreSource(selectedReviewData.source);
      setCustomScoreUrl(selectedReviewData.url || '');
      setCustomScoreSummary(selectedReviewData.summary || '');
      setCustomScoreNumReviews(selectedReviewData.numReviews ?? '');
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
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Step 4: Handle final apply override
  const handleApply = () => {
    if (!game || !scrapedBundle) return;

    const matchedStore = scrapedBundle.matchedStore;
    const isExplicitNonSteam = notOnSteamOnly || matchedStore !== 'steam';

    const override: UserGameOverride = {
      gameId: game.id,
      platformId: game.platforms?.[0]?.platformId,
      platformGameId: game.platforms?.[0]?.platformGameId,
      matchedStore,
      matchedId: scrapedBundle.matchedId,
      title: customTitle.trim() || scrapedBundle.title,
      sortTitle: (customTitle.trim() || scrapedBundle.title).replace(/^(The|A|An)\s+/i, '').trim(),
      steamAppId: isExplicitNonSteam ? null : scrapedBundle.steamAppId ?? null,
      isExplicitNonSteam,
      igdbId: scrapedBundle.igdbId,
      capsuleImage: selectedCoverUrl || scrapedBundle.capsuleImage,
      headerImage: scrapedBundle.headerImage,
      iconUrl: selectedCoverUrl || scrapedBundle.iconUrl,
      shortDescription: selectedBlurb || scrapedBundle.shortDescription,
      detailedDescription: scrapedBundle.detailedDescription,
      developers: scrapedBundle.developers,
      publishers: scrapedBundle.publishers,
      genres: scrapedBundle.genres,
      tags: scrapedBundle.tags,
      releaseDate: scrapedBundle.releaseDate,
      storefrontAnchor: scrapedBundle.storefrontAnchor,
      reviewScoreOverride: selectedReviewData,
      updatedAt: new Date().toISOString(),
    };

    onApplyOverride(override);
    onClose();
  };

  if (!isOpen || !game) return null;

  const sourceTabs: SourceFilterTab[] = ['All', 'Steam', 'IGDB', 'GOG', 'Epic'];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-150"
      onClick={onClose}
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
              <h2 id="fix-match-wizard-title" className="text-base font-bold text-white tracking-wide flex items-center gap-2">
                Fix Match & Metadata
                {existingOverride && (
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                    Custom Match Active
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-400 truncate max-w-md">
                Resolving canonical identity for: <span className="text-slate-200 font-medium">{game.title}</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
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

                            {isCurrentOverride && (
                              <div className="mt-2 inline-flex items-center gap-1 text-[10px] text-amber-300 font-medium">
                                <Check className="w-3 h-3 text-amber-400" />
                                <span>Current Override</span>
                              </div>
                            )}
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
                    Choose from official high-resolution storefront posters or verified portrait box art
                  </p>
                </div>

                {selectedCandidate && (
                  <div className="flex items-center gap-2 bg-[#16202d] px-3 py-1 rounded-md border border-[#2a475e]">
                    <span className="text-[10px] uppercase font-bold text-slate-400">Selected Candidate:</span>
                    <span className="text-xs font-semibold text-white">{selectedCandidate.title}</span>
                  </div>
                )}
              </div>

              {isScrapingDetails ? (
                <div className="py-20 flex flex-col items-center justify-center gap-3 text-slate-400">
                  <Loader2 className="w-8 h-8 animate-spin text-[#66c0f4]" />
                  <span className="text-xs font-medium">
                    Scraping high-resolution storefront box art, screenshots & blurbs...
                  </span>
                </div>
              ) : !scrapedBundle || scrapedBundle.availableCovers.length === 0 ? (
                <div className="py-16 text-center text-slate-500 border border-dashed border-[#2a475e] rounded-lg">
                  <p className="text-sm font-medium text-slate-400">No cover art options available</p>
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="mt-3 px-3 py-1.5 rounded bg-[#1b2838] text-xs text-[#66c0f4] hover:brightness-110"
                  >
                    Back to Candidate Selection
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 max-h-[52vh] overflow-y-auto pr-1 custom-scrollbar">
                  {scrapedBundle.availableCovers.map((cover, idx) => {
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

              {isLoadingReviews ? (
                <div className="py-20 flex flex-col items-center justify-center gap-3 text-slate-400">
                  <Loader2 className="w-8 h-8 animate-spin text-[#66c0f4]" />
                  <span className="text-xs font-medium">
                    Discovering reviews from Metacritic, OpenCritic, Steam &amp; storefront anchors...
                  </span>
                </div>
              ) : (
                <div className="space-y-3 max-h-[52vh] overflow-y-auto pr-1 custom-scrollbar">
                  {/* Notice if no candidates discovered */}
                  {reviewCandidates.length === 0 && (
                    <div className="p-3 rounded-lg bg-[#16202d] border border-dashed border-[#2a475e] text-center text-xs text-slate-400">
                      No external review scores were discovered automatically for this title. You can specify a manual score or keep it unrated below.
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
                    Review scraped metadata, review score override, select your preferred blurb synopsis, and apply to catalog
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-sky-950/70 border border-sky-500/50 text-sky-300">
                    Target: {scrapedBundle.matchedStore}
                  </span>
                  {scrapedBundle.steamAppId ? (
                    <span className="text-[10px] font-mono text-slate-400">
                      Steam ID: {scrapedBundle.steamAppId}
                    </span>
                  ) : null}
                </div>
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
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    {scrapedBundle.releaseDate && (
                      <div className="p-2 rounded bg-[#16202d] border border-[#2a475e]/70">
                        <span className="text-[10px] text-slate-400 flex items-center gap-1 mb-0.5">
                          <Calendar className="w-3 h-3" /> Release Date
                        </span>
                        <span className="font-semibold text-slate-200">{scrapedBundle.releaseDate}</span>
                      </div>
                    )}

                    {scrapedBundle.developers && scrapedBundle.developers.length > 0 && (
                      <div className="p-2 rounded bg-[#16202d] border border-[#2a475e]/70">
                        <span className="text-[10px] text-slate-400 flex items-center gap-1 mb-0.5">
                          <Building className="w-3 h-3" /> Developer
                        </span>
                        <span className="font-semibold text-slate-200 truncate block">
                          {scrapedBundle.developers.join(', ')}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Genres & Tags */}
                  {scrapedBundle.genres && scrapedBundle.genres.length > 0 && (
                    <div>
                      <span className="text-xs font-semibold text-slate-400 mb-1 flex items-center gap-1">
                        <Tag className="w-3 h-3" /> Genres & Categories
                      </span>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {scrapedBundle.genres.map((g) => (
                          <span
                            key={g}
                            className="px-2 py-0.5 rounded bg-[#16202d] border border-[#2a475e] text-[10px] text-slate-300"
                          >
                            {g}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Blurb Synopsis Selector */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Storefront Synopsis / Blurb
                    </label>

                    {scrapedBundle.availableDescriptions && scrapedBundle.availableDescriptions.length > 1 ? (
                      <div className="space-y-2 mb-2">
                        {scrapedBundle.availableDescriptions.map((desc, i) => {
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
                    ) : null}

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
        <div className="px-6 py-4 border-t border-[#2a475e]/70 bg-[#131c27] flex items-center justify-between">
          <div>
            {existingOverride && onResetOverride && (
              <button
                type="button"
                onClick={() => {
                  onResetOverride(game.id);
                  onClose();
                }}
                className="px-3.5 py-2 rounded-md border border-rose-500/50 bg-rose-950/30 text-rose-300 hover:bg-rose-900/50 hover:text-white transition-colors text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-sm"
                title="Discard user match overrides and revert to original catalog metadata"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset to Default</span>
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
              onClick={onClose}
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
