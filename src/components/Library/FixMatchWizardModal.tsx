import React, { useState, useEffect, useCallback } from 'react';
import { CanonicalGame } from '../../contracts/game';
import {
  UserGameOverride,
  SearchMatchCandidate,
  ScrapedMetadataBundle,
} from '../../contracts/override';
import { metadataScraperService } from '../../services/scraper/metadataScraperService';
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
} from 'lucide-react';

export interface FixMatchWizardModalProps {
  isOpen: boolean;
  game: CanonicalGame | null;
  onClose: () => void;
  onApplyOverride: (override: UserGameOverride) => void;
  onResetOverride?: (gameId: string) => void;
  existingOverride?: UserGameOverride;
}

type WizardStep = 1 | 2 | 3;
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
}) => {
  const [step, setStep] = useState<WizardStep>(1);
  const [searchTerm, setSearchTerm] = useState('');
  const [sourceTab, setSourceTab] = useState<SourceFilterTab>('All');
  const [notOnSteamOnly, setNotOnSteamOnly] = useState(false);

  // Step 1: Candidate discovery state
  const [candidates, setCandidates] = useState<SearchMatchCandidate[]>([]);
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<SearchMatchCandidate | null>(null);

  // Step 2 & 3: Scraped metadata bundle state
  const [isScrapingDetails, setIsScrapingDetails] = useState(false);
  const [scrapedBundle, setScrapedBundle] = useState<ScrapedMetadataBundle | null>(null);
  const [selectedCoverUrl, setSelectedCoverUrl] = useState<string>('');
  const [selectedBlurb, setSelectedBlurb] = useState<string>('');
  const [customTitle, setCustomTitle] = useState<string>('');

  // Reset wizard state whenever modal is opened with a new or existing game
  useEffect(() => {
    if (isOpen && game) {
      setStep(1);
      setSearchTerm(game.title);
      setSourceTab('All');
      setNotOnSteamOnly(false);
      setSelectedCandidate(null);
      setScrapedBundle(null);
      setSelectedCoverUrl('');
      setSelectedBlurb('');
      setCustomTitle(game.title);
      loadCandidates(game.title, 'All', false);
    }
  }, [isOpen, game]);

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
    setStep(2);
    setIsScrapingDetails(true);
    try {
      const bundle = await metadataScraperService.scrapeMatchDetails(candidate, game);
      setScrapedBundle(bundle);
      setSelectedCoverUrl(bundle.capsuleImage);
      setSelectedBlurb(bundle.shortDescription || '');
      setCustomTitle(bundle.title);
    } catch (err) {
      console.error('Failed to scrape candidate details:', err);
    } finally {
      setIsScrapingDetails(false);
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

  // Step 3: Handle final apply override
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

        {/* 3-Step Wizard Navigation Stepper */}
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
              onClick={() => scrapedBundle && setStep(3)}
              disabled={!scrapedBundle}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md font-semibold transition-all ${
                step === 3
                  ? 'bg-[#66c0f4] text-slate-950 shadow'
                  : scrapedBundle
                  ? 'text-slate-400 hover:text-white hover:bg-[#1b2838]'
                  : 'text-slate-600 cursor-not-allowed opacity-50'
              }`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>3. Review & Apply</span>
            </button>
          </div>

          <div className="text-[11px] text-slate-400 font-mono">
            Step {step} of 3
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

          {/* ================= STEP 3: REVIEW & CONFIRM ================= */}
          {step === 3 && scrapedBundle && (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-[#2a475e]/60 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span>Review & Confirm Game Metadata Override</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Review scraped metadata, select your preferred blurb synopsis, and apply to catalog
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
                disabled={!selectedCoverUrl}
                onClick={() => setStep(3)}
                className="px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs flex items-center gap-1.5 shadow cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span>Next: Review Metadata</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}

            {step === 3 && (
              <button
                type="button"
                onClick={handleApply}
                className="px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs flex items-center gap-2 shadow-lg shadow-[#66c0f4]/20 cursor-pointer"
              >
                <Sparkles className="w-4 h-4 fill-slate-950" />
                <span>Apply Match & Scrape Data</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
