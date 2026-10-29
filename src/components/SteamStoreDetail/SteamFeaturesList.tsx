import React, { useState } from 'react';
import { SteamCategory } from '../../contracts/steam';
import { getEffectiveCategories } from '../../services/steam/steamFeatureNormalizer';
import { ActiveGameFilter } from '../../contracts/filter';
import { StoreFeatureIcon } from './StoreFeatureIcon';
import { ChevronDown, Sliders, CheckCircle2, Gamepad } from 'lucide-react';

interface SteamFeaturesListProps {
  categories?: SteamCategory[];
  title?: string;
  hasAntiCheat?: boolean;
  antiCheatName?: string;
  hasEula?: boolean;
  isOwnedOnSteam?: boolean;
  onApplyFilter?: (filter: ActiveGameFilter) => void;
}

// Category taxonomies according to Steam's official storefront specifications
const CONTROLLER_INTERNAL_IDS = new Set([55, 56, 57, 58, 59, 60]);
const ACCESSIBILITY_IDS = new Set([
  64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80,
]);

export const SteamFeaturesList: React.FC<SteamFeaturesListProps> = ({
  categories = [],
  title = 'Game',
  hasAntiCheat = false,
  antiCheatName = 'Easy Anti-Cheat',
  hasEula = false,
  isOwnedOnSteam = true,
  onApplyFilter,
}) => {
  const [showAccessibility, setShowAccessibility] = useState(false);

  // Non-destructive dynamic projection based on actual Steam ownership (never fabricate fake features)
  const rawCategories = getEffectiveCategories(categories, isOwnedOnSteam);
  const rawIds = new Set(rawCategories.map((c) => c.id));

  // Determine specific multiplayer / co-op / pvp presence for suppression of generic parent categories
  const hasSpecificCoop = rawIds.has(38) || rawIds.has(39) || rawIds.has(48);
  const hasSpecificPvP = rawIds.has(36) || rawIds.has(37) || rawIds.has(47);
  const hasSpecificMulti =
    hasSpecificCoop || hasSpecificPvP || rawIds.has(27) || rawIds.has(24) || rawIds.has(49);

  // 1. Sanitize and filter primary specs matching Steam's .game_area_details_specs_ctn 1:1
  const filteredSpecs = rawCategories.filter((c) => {
    // Exclude internal controller configuration flags (e.g. DualSense/DualShock USB/BT modes)
    if (CONTROLLER_INTERNAL_IDS.has(c.id)) return false;
    // Exclude accessibility items (rendered in Steam's accessibility section)
    if (ACCESSIBILITY_IDS.has(c.id)) return false;

    // Suppress generic umbrella categories when specific sub-categories exist
    if (c.id === 1 && hasSpecificMulti) return false; // Generic 'Multi-player'
    if (c.id === 9 && hasSpecificCoop) return false; // Generic 'Co-op'
    if (c.id === 49 && hasSpecificPvP) return false; // Generic 'PvP'

    return true;
  });

  // Deduplicate specs by normalized description
  const seenSpecs = new Set<string>();
  const specs: SteamCategory[] = [];
  for (const cat of filteredSpecs) {
    const norm = cat.description.trim().toLowerCase();
    if (!seenSpecs.has(norm)) {
      seenSpecs.add(norm);
      specs.push(cat);
    }
  }

  // 2. Extract accessibility categories
  const rawAccessibility = rawCategories.filter((c) => ACCESSIBILITY_IDS.has(c.id));
  const seenAccess = new Set<string>();
  const accessibilityList: SteamCategory[] = [];
  for (const cat of rawAccessibility) {
    const norm = cat.description.trim().toLowerCase();
    if (!seenAccess.has(norm)) {
      seenAccess.add(norm);
      accessibilityList.push(cat);
    }
  }

  // 3. Extract controller support metadata
  const hasFullController = rawIds.has(28);
  const hasPartialController = rawIds.has(18);
  const hasDualSense = rawIds.has(57) || rawIds.has(58);
  const hasDualShock = rawIds.has(55) || rawIds.has(56);
  const hasControllerSupport =
    hasFullController || hasPartialController || hasDualSense || hasDualShock;

  const hasAnyFeatureRows =
    specs.length > 0 || accessibilityList.length > 0 || hasControllerSupport;

  return (
    <div className="mb-4 space-y-3">
      {/* 1:1 Steam Features List Specs Container */}
      {specs.length > 0 ? (
        <div className="space-y-[2px]">
          {specs.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className="steam-spec-row group w-full text-left cursor-pointer border-none"
              title={`Filter library by ${cat.description}`}
              onClick={() =>
                onApplyFilter?.({ type: 'feature', label: 'Feature', value: cat.description })
              }
            >
              <div className="spec-icon">
                <StoreFeatureIcon categoryId={cat.id} description={cat.description} />
              </div>
              <div className="spec-label">
                <span className="group-hover:text-white transition-colors">{cat.description}</span>
              </div>
            </button>
          ))}
        </div>
      ) : !hasAnyFeatureRows ? (
        <div className="px-2.5 py-2 bg-black/20 border border-[#2a475e]/30 rounded-sm text-xs text-[#94a3b8] italic">
          Store features pending online sync
        </div>
      ) : null}

      {/* Steam Accessibility Section (Collapsible drawer matching modern Steam UI) */}
      {accessibilityList.length > 0 && (
        <div className="pt-1">
          <button
            type="button"
            aria-expanded={showAccessibility}
            onClick={() => setShowAccessibility(!showAccessibility)}
            className="flex items-center justify-between w-full min-h-6 px-2.5 py-1.5 text-xs text-[#94a3b8] hover:text-white bg-[#1a2b3c]/40 hover:bg-[#1a2b3c]/80 border border-[#2a475e]/40 rounded-sm transition-colors group cursor-pointer"
          >
            <span className="flex items-center gap-1.5 font-medium">
              <Sliders className="w-3.5 h-3.5 text-[#67c1f5]" />
              Accessibility Features ({accessibilityList.length})
            </span>
            <ChevronDown
              className={`w-3.5 h-3.5 text-[#94a3b8] group-hover:text-white transition-transform duration-200 ${
                showAccessibility ? 'rotate-180' : ''
              }`}
            />
          </button>

          {showAccessibility && (
            <div className="mt-1.5 bg-[#121a24] border border-[#2a475e]/40 rounded-sm p-2 space-y-1">
              <div className="text-[10px] text-[#67c1f5] font-semibold uppercase tracking-wider mb-1">
                Supported Accessibility
              </div>
              <div className="grid grid-cols-1 gap-1">
                {accessibilityList.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() =>
                      onApplyFilter?.({
                        type: 'feature',
                        label: 'Accessibility',
                        value: item.description,
                      })
                    }
                    className="flex items-center gap-2 min-h-6 text-[11px] text-[#c6d4df] hover:text-white py-0.5 px-1 rounded hover:bg-white/5 w-full text-left cursor-pointer transition-colors"
                    title={`Filter library by accessibility feature "${item.description}"`}
                  >
                    <CheckCircle2 className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                    <span>{item.description}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Controller Support Block (Steam's dedicated store-sidebar-controller-support-info) */}
      {hasControllerSupport && (
        <div className="p-2.5 bg-[#171a21] border border-[#2a475e]/60 rounded-sm">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2">
              <Gamepad className="w-4 h-4 text-[#67c1f5]" />
              <span className="text-xs text-white font-semibold">
                {hasFullController ? 'Full Controller Support' : 'Partial Controller Support'}
              </span>
            </div>
            <span className="text-[10px] font-bold text-[#67c1f5] bg-[#1a2b3c] border border-[#67c1f5]/30 px-1.5 py-0.5 rounded-sm">
              {hasFullController ? 'FULL' : 'PARTIAL'}
            </span>
          </div>
          <div className="text-[11px] text-[#94a3b8] space-y-0.5 pl-6">
            <div className="flex items-center gap-1.5 text-[#acb2b8]">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              Xbox Controllers
            </div>
            {(hasDualSense || hasDualShock) && (
              <div className="flex items-center gap-1.5 text-[#acb2b8]">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                PlayStation Controllers{' '}
                {hasDualSense && hasDualShock
                  ? '(DualSense, DualShock)'
                  : hasDualSense
                  ? '(DualSense)'
                  : '(DualShock)'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Uses Anti-Cheat Software Notice (Only if metadata or prop explicitly specifies it) */}
      {hasAntiCheat && (
        <div className="steam-anticheat-box">
          <div className="anticheat-title">Uses Anti-Cheat Software</div>
          <div className="anticheat-name">{antiCheatName}</div>
        </div>
      )}

      {/* Requires agreement to a 3rd-party EULA (Only if metadata or prop explicitly specifies it) */}
      {hasEula && (
        <div className="steam-drm-box">
          <div>Requires agreement to a 3rd-party EULA</div>
          <div>
            <span className="text-[#fde68a] font-medium">{title} EULA</span>
          </div>
        </div>
      )}
    </div>
  );
};
