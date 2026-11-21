import React from 'react';
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
import { CanonicalGame, PlatformOwnership } from '../../../contracts/game';
import {
  ScrapedMetadataBundle,
  SearchMatchCandidate,
  UserGameOverride,
} from '../../../contracts/override';
import { StorefrontId } from '../../../contracts/platform';
import { getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import { WizardStep } from './fixMatchTypes';

export interface RenderFixMatchHeaderArgs {
  titleId: string;
  game: CanonicalGame;
  existingOverride?: UserGameOverride;
  isSplittingFromMerged: boolean;
  sourcePlatform?: PlatformOwnership;
  rawSourceTitle: string;
  isTitleOverridden: boolean;
  onClose: () => void;
}

export function renderFixMatchWizardHeader({
  titleId,
  game,
  existingOverride,
  isSplittingFromMerged,
  sourcePlatform,
  rawSourceTitle,
  isTitleOverridden,
  onClose,
}: RenderFixMatchHeaderArgs): React.ReactElement {
  return (
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
              <strong className="text-slate-100 font-medium">&ldquo;{rawSourceTitle}&rdquo;</strong>
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
        onClick={onClose}
        className="min-w-6 min-h-6 p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-[#1b2838] transition-colors cursor-pointer"
        title="Close Wizard (Esc)"
      >
        <X aria-hidden="true" className="w-5 h-5" />
      </button>
    </div>
  );
}

export interface RenderFixMatchStepperArgs {
  step: WizardStep;
  selectedCandidate: SearchMatchCandidate | null;
  scrapedBundle: ScrapedMetadataBundle | null;
  onSelectStep: (step: WizardStep) => void;
  onGoToReviewStep: () => void;
}

export function renderFixMatchWizardStepper({
  step,
  selectedCandidate,
  scrapedBundle,
  onSelectStep,
  onGoToReviewStep,
}: RenderFixMatchStepperArgs): React.ReactElement {
  return (
    <div className="px-6 py-3 border-b border-[#2a475e]/50 bg-[#16202d] flex items-center justify-between text-xs">
      <nav aria-label="Wizard steps" className="flex items-center gap-2 flex-1 flex-wrap">
        <button
          type="button"
          aria-current={step === 1 ? 'step' : undefined}
          onClick={() => onSelectStep(1)}
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
          onClick={() => selectedCandidate && onSelectStep(2)}
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
          onClick={() => selectedCandidate && onGoToReviewStep()}
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
          onClick={() => scrapedBundle && onSelectStep(4)}
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
      </nav>

      <div className="text-[11px] text-slate-300 font-mono">{`Step ${step} of 4`}</div>
    </div>
  );
}

export interface RenderFixMatchFooterArgs {
  step: WizardStep;
  game: CanonicalGame;
  existingOverride?: UserGameOverride;
  isSplittingFromMerged: boolean;
  sourcePlatform?: PlatformOwnership;
  selectedCoverUrl: string;
  isScrapingDetails: boolean;
  onResetOverride?: (
    gameId: string,
    context?: { game?: CanonicalGame | null; override?: UserGameOverride | null }
  ) => void;
  onHideGame?: (game: CanonicalGame, targetPlatformId?: StorefrontId) => void;
  onBack: () => void;
  onClose: () => void;
  onGoToReviewStep: () => void;
  onGoToStep4: () => void;
  onApply: () => void;
}

export function renderFixMatchWizardFooter({
  step,
  game,
  existingOverride,
  isSplittingFromMerged,
  sourcePlatform,
  selectedCoverUrl,
  isScrapingDetails,
  onResetOverride,
  onHideGame,
  onBack,
  onClose,
  onGoToReviewStep,
  onGoToStep4,
  onApply,
}: RenderFixMatchFooterArgs): React.ReactElement {
  return (
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
              onClose();
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
              onClose();
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
            onClick={onBack}
            className="min-h-6 px-4 py-2 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-200 hover:text-white hover:border-slate-400 transition-colors text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
          >
            <ArrowLeft aria-hidden="true" className="w-3.5 h-3.5" />
            <span>Back</span>
          </button>
        )}

        <button
          type="button"
          onClick={onClose}
          className="min-h-6 px-4 py-2 rounded-md border border-transparent text-slate-300 hover:text-white hover:bg-[#1b2838] transition-colors text-xs font-semibold cursor-pointer"
        >
          Cancel
        </button>

        {step === 2 && (
          <button
            type="button"
            disabled={!selectedCoverUrl || isScrapingDetails}
            onClick={onGoToReviewStep}
            className="min-h-6 px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs flex items-center gap-1.5 shadow cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span>Next: Review Score &amp; Source</span>
            <ChevronRight aria-hidden="true" className="w-3.5 h-3.5" />
          </button>
        )}

        {step === 3 && (
          <button
            type="button"
            onClick={onGoToStep4}
            className="min-h-6 px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs flex items-center gap-1.5 shadow cursor-pointer"
          >
            <span>Next: Metadata &amp; Confirm</span>
            <ChevronRight aria-hidden="true" className="w-3.5 h-3.5" />
          </button>
        )}

        {step === 4 && (
          <button
            type="button"
            onClick={onApply}
            className="min-h-6 px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs flex items-center gap-2 shadow-lg shadow-[#66c0f4]/20 cursor-pointer"
          >
            <Sparkles aria-hidden="true" className="w-4 h-4 fill-slate-950" />
            <span>Apply Match &amp; Scrape Data</span>
          </button>
        )}
      </div>
    </div>
  );
}
