import React from 'react';
import {
  ArrowRight,
  ExternalLink,
  Eye,
  EyeOff,
  Image as ImageIcon,
  RotateCcw,
  Wand,
} from 'lucide-react';
import { CanonicalGame } from '../../../contracts/game';
import { StorefrontId } from '../../../contracts/platform';
import { sanitizeAllowedStoreUri } from '../../../services/common/htmlSanitizer';
import { launcherService } from '../../../services/launcher/launcherService';
import { StorefrontIcon, getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import { resolveOverrideTargetStoreDetails } from './matchManagerDiagnostics';
import { MatchManagerFlatRow } from './matchManagerTypes';
import {
  getValidPlatforms,
  MatchManagerRowRenderContext,
  resolveEntitlementOsBadge,
  resolveStudioRowThumbnailSrc,
} from './matchManagerRowHelpers';

export function renderUnmatchedRow(
  row: Extract<MatchManagerFlatRow, { kind: 'unmatched-row' }>,
  ctx: MatchManagerRowRenderContext
): React.ReactElement {
  const { game, reasons, isLastInSection } = row;
  const thumbSrc = resolveStudioRowThumbnailSrc(game);
  return (
    <div
      key={row.key}
      className={`ol-studio-row-card px-4 py-3 border-x border-x-[#2a475e]/80 bg-[#131c27]/70 ${
        isLastInSection
          ? 'border-b border-b-[#2a475e]/80 rounded-b-lg pb-4'
          : 'border-b border-b-[#2a475e]/40'
      } flex flex-col sm:flex-row sm:items-center justify-between gap-3`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 aspect-[2/3] rounded bg-black/60 border border-[#2a475e] overflow-hidden shrink-0 flex items-center justify-center">
          {thumbSrc ? (
            <img
              src={thumbSrc}
              alt={game.title}
              width={40}
              height={60}
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover"
            />
          ) : (
            <ImageIcon aria-hidden="true" className="w-4 h-4 text-slate-400" />
          )}
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-bold text-white truncate mr-0.5">{game.title}</span>
            {reasons.map((reason) => (
              <span
                key={reason.code}
                title={reason.tooltip}
                className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${reason.colorClass}`}
              >
                {reason.label}
              </span>
            ))}
          </div>

          <div className="flex items-center gap-2 flex-wrap mt-1">
            {getValidPlatforms(game).map((p) => (
              <span
                key={`${p.platformId}-${p.platformGameId}`}
                className="inline-flex items-center gap-1 text-[11px] text-slate-300 bg-[#16202d] border border-[#2a475e] px-2 py-0.5 rounded"
              >
                <StorefrontIcon
                  storefrontId={p.platformId as StorefrontId}
                  className="w-3 h-3"
                />
                <span>{getStorefrontDisplayName(p.platformId)}</span>
                {p.originalTitle && p.originalTitle !== game.title && (
                  <span className="text-slate-300">• &ldquo;{p.originalTitle}&rdquo;</span>
                )}
                <span className="text-[10px] font-mono text-slate-300">
                  (ID: {p.platformGameId})
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {ctx.handleInspect && (
          <button
            type="button"
            onClick={() => {
              ctx.handleInspect!(game);
              ctx.onClose();
            }}
            className="min-h-6 px-2.5 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-xs font-semibold text-slate-200 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Eye aria-hidden="true" className="w-3.5 h-3.5" />
            <span>Inspect</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => ctx.onFixMatchForGame(game)}
          className="min-h-6 px-3 py-1.5 rounded bg-[#66c0f4] hover:bg-[#4da6db] text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
        >
          <Wand aria-hidden="true" className="w-3.5 h-3.5" />
          <span>Fix Match</span>
        </button>
        {ctx.onHideGame && (
          <button
            type="button"
            onClick={() => ctx.onHideGame!(game)}
            className="min-h-6 px-2.5 py-1.5 rounded bg-rose-950/60 hover:bg-rose-900/80 border border-rose-500/40 text-xs font-semibold text-rose-300 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
            title="Hide / suppress this game from your active library"
          >
            <EyeOff aria-hidden="true" className="w-3.5 h-3.5" />
            <span>Hide</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function renderLowConfidenceRow(
  row: Extract<MatchManagerFlatRow, { kind: 'low-confidence-row' }>,
  ctx: MatchManagerRowRenderContext
): React.ReactElement {
  const { game, isLastInSection } = row;
  const thumbSrc = resolveStudioRowThumbnailSrc(game);
  const rawConf =
    typeof game.matchConfidence === 'number'
      ? Math.round(game.matchConfidence <= 1 ? game.matchConfidence * 100 : game.matchConfidence)
      : undefined;
  const platforms = getValidPlatforms(game);
  const sourceTitle = game.originalStoreTitle || platforms[0]?.originalTitle || game.title;

  return (
    <div
      key={row.key}
      className={`ol-studio-row-card px-4 py-3 border-x border-x-[#2a475e]/80 bg-[#131c27]/70 ${
        isLastInSection
          ? 'border-b border-b-[#2a475e]/80 rounded-b-lg pb-4'
          : 'border-b border-b-[#2a475e]/40'
      } flex flex-col sm:flex-row sm:items-center justify-between gap-3`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 aspect-[2/3] rounded bg-black/60 border border-[#2a475e] overflow-hidden shrink-0 flex items-center justify-center">
          {thumbSrc ? (
            <img
              src={thumbSrc}
              alt={game.title}
              width={40}
              height={60}
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover"
            />
          ) : (
            <ImageIcon aria-hidden="true" className="w-4 h-4 text-slate-400" />
          )}
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">{game.title}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-950/70 border border-orange-500/40 text-orange-300">
              {typeof rawConf === 'number' && rawConf > 0
                ? `${rawConf}% Confidence`
                : 'Heuristic Title Match'}
            </span>
          </div>

          <div className="text-xs text-slate-300 mt-1 flex items-center gap-1.5 flex-wrap">
            <span className="text-slate-300">Store Scrape:</span>
            <span className="font-medium text-white">&ldquo;{sourceTitle}&rdquo;</span>
            <ArrowRight aria-hidden="true" className="w-3 h-3 text-orange-400 shrink-0" />
            <span className="text-slate-300">Matched As:</span>
            <span className="font-semibold text-orange-200">&ldquo;{game.title}&rdquo;</span>
          </div>

          <div className="flex items-center gap-2 flex-wrap mt-1">
            {platforms.map((p) => (
              <span
                key={`${p.platformId}-${p.platformGameId}`}
                className="inline-flex items-center gap-1 text-[11px] text-slate-300 bg-[#16202d] border border-[#2a475e] px-2 py-0.5 rounded"
              >
                <StorefrontIcon
                  storefrontId={p.platformId as StorefrontId}
                  className="w-3 h-3"
                />
                <span>{getStorefrontDisplayName(p.platformId)}</span>
                <span className="text-[10px] font-mono text-slate-300">
                  (ID: {p.platformGameId})
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {ctx.handleInspect && (
          <button
            type="button"
            onClick={() => {
              ctx.handleInspect!(game);
              ctx.onClose();
            }}
            className="min-h-6 px-2.5 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-xs font-semibold text-slate-200 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Eye aria-hidden="true" className="w-3.5 h-3.5" />
            <span>Inspect</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => ctx.onFixMatchForGame(game)}
          className="min-h-6 px-3 py-1.5 rounded bg-[#66c0f4] hover:bg-[#4da6db] text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
        >
          <Wand aria-hidden="true" className="w-3.5 h-3.5" />
          <span>Verify / Fix Match</span>
        </button>
        {ctx.onHideGame && (
          <button
            type="button"
            onClick={() => ctx.onHideGame!(game)}
            className="min-h-6 px-2.5 py-1.5 rounded bg-rose-950/60 hover:bg-rose-900/80 border border-rose-500/40 text-xs font-semibold text-rose-300 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
            title="Hide / suppress this game from your active library"
          >
            <EyeOff aria-hidden="true" className="w-3.5 h-3.5" />
            <span>Hide</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function renderOverrideRow(
  row: Extract<MatchManagerFlatRow, { kind: 'override-row' }>,
  ctx: MatchManagerRowRenderContext
): React.ReactElement {
  const { override, matchedGame, isLastInSection } = row;
  const platforms = getValidPlatforms(matchedGame);
  const sourcePlat =
    platforms.find(
      (p) => p.platformId === (override.originalSourcePlatformId || override.platformId)
    ) || platforms[0];

  const sourcePlatformId =
    override.originalSourcePlatformId ||
    override.platformId ||
    sourcePlat?.platformId ||
    'steam';

  const sourceRawTitle =
    override.originalSourceTitle ||
    sourcePlat?.originalTitle ||
    matchedGame?.originalStoreTitle ||
    matchedGame?.title ||
    override.title;

  const sourcePlatformGameId = override.platformGameId || sourcePlat?.platformGameId;

  const { targetUrl, targetStoreLabel } = resolveOverrideTargetStoreDetails(
    override,
    sourceRawTitle || ''
  );
  const safeTargetUrl = targetUrl ? sanitizeAllowedStoreUri(targetUrl) : '';

  return (
    <div
      key={row.key}
      className={`ol-studio-row-card px-4 py-3.5 border-x border-x-[#2a475e]/80 bg-[#131c27]/70 ${
        isLastInSection
          ? 'border-b border-b-[#2a475e]/80 rounded-b-lg pb-4'
          : 'border-b border-b-[#2a475e]/40'
      } flex flex-col lg:flex-row lg:items-center justify-between gap-3`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 min-w-0 flex-1">
        {/* Left: Original Source Entitlement */}
        <div className="p-2.5 rounded-lg bg-[#16202d] border border-[#2a475e] flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wider text-slate-300 font-semibold">
              Original Storefront Entitlement
            </span>
            {override.splitFromMerged && (
              <span className="px-1.5 py-0.5 rounded bg-purple-950/80 border border-purple-500/40 text-[9px] font-bold uppercase text-purple-300">
                Split Entry
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#1b2838] border border-[#2a475e] text-[10px] font-bold text-sky-300">
              <StorefrontIcon
                storefrontId={sourcePlatformId as StorefrontId}
                className="w-3 h-3"
              />
              <span>{getStorefrontDisplayName(sourcePlatformId)}</span>
            </span>
            <span className="text-xs font-bold text-white truncate">
              &ldquo;{sourceRawTitle}&rdquo;
            </span>
          </div>
          {sourcePlatformGameId && (
            <div className="text-[10px] font-mono text-slate-300 mt-1">
              Platform ID: {sourcePlatformGameId}
            </div>
          )}
        </div>

        <ArrowRight
          aria-hidden="true"
          className="w-4 h-4 text-amber-400 shrink-0 self-center hidden sm:block"
        />

        {/* Right: Active Target Override */}
        <div className="p-2.5 rounded-lg bg-[#1b2838]/80 border border-amber-500/40 flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wider text-amber-300 font-semibold">
              Routed Target Metadata
            </span>
            {safeTargetUrl && (
              <a
                href={safeTargetUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  ctx.handleOpenExternalUrl(safeTargetUrl);
                }}
                className="min-h-6 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#131c27] hover:bg-[#2a475e] border border-[#2a475e] text-[10px] font-semibold text-[#66c0f4] hover:text-white transition-colors cursor-pointer"
                title={`Open ${targetStoreLabel.toUpperCase()} store page in browser`}
              >
                <ExternalLink aria-hidden="true" className="w-2.5 h-2.5" />
                <span>Store Page</span>
              </a>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-1.5 py-0.5 rounded bg-amber-950/80 border border-amber-500/40 text-[10px] font-bold uppercase text-amber-300">
              {targetStoreLabel}
            </span>
            <span className="text-xs font-bold text-amber-100 truncate">
              &ldquo;{override.title}&rdquo;
            </span>
          </div>
          <div className="text-[10px] font-mono text-slate-300 mt-1">
            Target ID: {override.matchedId}
            {override.steamAppId ? ` • Steam AppID: ${override.steamAppId}` : ''}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 shrink-0">
        {matchedGame && (
          <button
            type="button"
            onClick={() => ctx.onFixMatchForGame(matchedGame)}
            className="min-h-6 px-2.5 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-xs font-semibold text-[#66c0f4] hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Wand aria-hidden="true" className="w-3.5 h-3.5" />
            <span>Edit Match</span>
          </button>
        )}
        {ctx.handleReset && (
          <button
            type="button"
            onClick={() =>
              ctx.handleReset!(matchedGame?.id || override.gameId, {
                game: matchedGame ?? null,
                override,
              })
            }
            className="min-h-6 px-2.5 py-1.5 rounded bg-rose-950/60 hover:bg-rose-900/80 border border-rose-500/40 text-xs font-semibold text-rose-300 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
            title="Remove manual override and revert to automatic storefront matching"
          >
            <RotateCcw aria-hidden="true" className="w-3.5 h-3.5" />
            <span>Reset</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function renderMergedRow(
  row: Extract<MatchManagerFlatRow, { kind: 'merged-row' }>,
  ctx: MatchManagerRowRenderContext
): React.ReactElement {
  const { game, isFirstItem, isLastInSection } = row;
  const thumbSrc = resolveStudioRowThumbnailSrc(game);
  const platforms = getValidPlatforms(game);
  return (
    <div
      key={row.key}
      className={`ol-studio-row-card px-3.5 ${isFirstItem ? 'pt-3.5 ' : 'pt-2 '}${
        isLastInSection ? 'border-b border-b-[#2a475e]/80 rounded-b-lg pb-3.5' : 'pb-0'
      } border-x border-x-[#2a475e]/80 bg-[#131c27]/70`}
    >
      <div className="px-3 py-2.5 rounded-lg bg-[#16202d]/90 border border-[#2a475e]/40 hover:border-emerald-500/30 transition-colors flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
        {/* Left / Center section: Cover, Title, Storefronts Badge, and Inline Storefront Entitlement Chips */}
        <div className="flex items-center gap-3 min-w-0 flex-1 flex-wrap">
          <div className="w-8 h-11 rounded bg-black/60 border border-[#2a475e] overflow-hidden shrink-0 flex items-center justify-center">
            {thumbSrc ? (
              <img
                src={thumbSrc}
                alt={game.title}
                width={32}
                height={44}
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover"
              />
            ) : (
              <ImageIcon aria-hidden="true" className="w-3.5 h-3.5 text-slate-400" />
            )}
          </div>

          <div className="flex items-center gap-2 min-w-0 flex-wrap flex-1">
            <span className="text-sm font-semibold text-white truncate">{game.title}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-950/70 border border-emerald-500/40 text-emerald-300 shrink-0">
              {platforms.length} Storefronts
            </span>

            {/* Inline Compact Storefront Entitlement Chips */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {platforms.map((p) => {
                const installedRec = launcherService.getInstalledRecordForGame(game, p.platformId);
                const isPlatInstalled = Boolean(
                  installedRec ||
                    launcherService.isGameInstalled(game, p.platformId) ||
                    p.installed
                );
                const osBadge = resolveEntitlementOsBadge(game, p, installedRec, isPlatInstalled);
                const rawPlatTitle = p.originalTitle || game.originalStoreTitle || game.title;

                return (
                  <div
                    key={`${p.platformId}-${p.platformGameId}`}
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-[#0e141b]/90 border border-[#2a475e]/60 text-[11px]"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        isPlatInstalled ? 'bg-emerald-400' : 'bg-slate-400'
                      }`}
                      title={isPlatInstalled ? 'Installed' : 'Not Installed'}
                    />
                    <span className="sr-only">
                      {isPlatInstalled ? 'Installed' : 'Not Installed'}
                    </span>

                    <StorefrontIcon
                      storefrontId={p.platformId as StorefrontId}
                      className="w-3 h-3 text-sky-400 shrink-0"
                    />
                    <span className="font-semibold text-white">
                      {getStorefrontDisplayName(p.platformId)}
                    </span>

                    {osBadge && (
                      <span
                        title={osBadge.title}
                        className={`px-1.5 py-0.2 rounded border text-[10px] font-semibold shrink-0 ${osBadge.className}`}
                      >
                        {osBadge.label}
                      </span>
                    )}

                    {rawPlatTitle && rawPlatTitle !== game.title && (
                      <span className="text-slate-300 truncate max-w-[160px]">
                        • &ldquo;{rawPlatTitle}&rdquo;
                      </span>
                    )}

                    <span className="text-[10px] font-mono text-slate-300">
                      #{p.platformGameId}
                    </span>

                    <span className="h-3 w-px bg-[#2a475e]/70 mx-0.5 shrink-0" />

                    <button
                      type="button"
                      onClick={() => {
                        const singleStoreGame: CanonicalGame & {
                          isSplittingFromMerged?: boolean;
                        } = {
                          ...game,
                          id: `${p.platformId}-${p.platformGameId}`,
                          title: rawPlatTitle,
                          sortTitle: rawPlatTitle,
                          originalStoreTitle: rawPlatTitle,
                          steamAppId:
                            p.platformId === 'steam' && !isNaN(Number(p.platformGameId))
                              ? Number(p.platformGameId)
                              : undefined,
                          platforms: [{ ...p, originalTitle: rawPlatTitle }],
                          isSplittingFromMerged: true,
                        };
                        ctx.onFixMatchForGame(singleStoreGame);
                      }}
                      className="min-h-6 px-2 py-0.5 rounded text-[10px] font-semibold text-[#66c0f4] hover:bg-[#66c0f4] hover:text-slate-950 transition-colors flex items-center gap-1 cursor-pointer"
                      title={`Split this ${getStorefrontDisplayName(p.platformId)} entry from "${game.title}" and match it to its own game`}
                    >
                      <Wand aria-hidden="true" className="w-2.5 h-2.5" />
                      <span>Fix / Split Entry</span>
                    </button>

                    {ctx.onHideGame && (
                      <button
                        type="button"
                        onClick={() => ctx.onHideGame!(game, p.platformId)}
                        className="min-h-6 px-2 py-0.5 rounded text-[10px] font-medium text-rose-300 hover:bg-rose-900/80 hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
                        title={`Hide / suppress only the ${getStorefrontDisplayName(p.platformId)} entry from this merged listing`}
                      >
                        <EyeOff aria-hidden="true" className="w-2.5 h-2.5" />
                        <span>Hide Entry</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right section: Compact Inspect and Edit Merged Match buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
          {ctx.handleInspect && (
            <button
              type="button"
              onClick={() => {
                ctx.handleInspect!(game);
                ctx.onClose();
              }}
              className="min-h-6 px-2.5 py-1 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-[11px] font-semibold text-slate-200 hover:text-white flex items-center gap-1 transition-colors cursor-pointer"
            >
              <Eye aria-hidden="true" className="w-3 h-3" />
              <span>Inspect</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => ctx.onFixMatchForGame(game)}
            className="min-h-6 px-2.5 py-1 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-[11px] font-semibold text-[#66c0f4] hover:text-white flex items-center gap-1 transition-colors cursor-pointer"
          >
            <Wand aria-hidden="true" className="w-3 h-3" />
            <span>Edit Merged Match</span>
          </button>
        </div>
      </div>
    </div>
  );
}
