import React from 'react';
import { ArrowDownAZ } from 'lucide-react';
import { SwitchControl } from '../Launcher/LaunchConfig/LaunchConfigControls';

export interface SettingsLibrarySectionProps {
  ignoreLeadingTheWhenSorting: boolean;
  labelId: string;
  hintId: string;
  onToggleIgnoreLeadingThe: () => void;
}

export const SettingsLibrarySection: React.FC<SettingsLibrarySectionProps> = ({
  ignoreLeadingTheWhenSorting,
  labelId,
  hintId,
  onToggleIgnoreLeadingThe,
}) => (
  <div
    data-testid="settings-section-library"
    className="rounded-lg bg-[#0e151f] border border-[#223447] p-4 space-y-3"
  >
    <div className="flex items-center gap-2">
      <ArrowDownAZ className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />
      <h3 className="text-xs font-bold uppercase tracking-wider text-white">Library Sorting</h3>
    </div>

    <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <span id={labelId} className="block text-xs font-semibold text-white">
          Ignore Leading &quot;The&quot; When Sorting Alphabetically
        </span>
        <p id={hintId} className="text-[10px] text-steam-subtext leading-snug">
          When on (default), titles starting with &quot;The&quot; are sorted by the next word (for
          example, &quot;The Witcher 3&quot; appears under W). Turn off to sort strictly from the
          first word (under T).
        </p>
      </div>
      <SwitchControl
        dataTestId="settings-toggle-ignore-leading-the"
        checked={ignoreLeadingTheWhenSorting}
        ariaLabelledBy={labelId}
        ariaDescribedBy={hintId}
        onChange={onToggleIgnoreLeadingThe}
        tone="sky"
      />
    </div>
  </div>
);
