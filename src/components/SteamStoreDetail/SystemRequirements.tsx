import React from 'react';
import DOMPurify from 'dompurify';
import { SteamSystemRequirements } from '../../contracts/steam';
import { Cpu } from 'lucide-react';

interface SystemRequirementsProps {
  requirements?: SteamSystemRequirements;
}

export const SystemRequirements: React.FC<SystemRequirementsProps> = ({ requirements }) => {
  if (!requirements || (!requirements.minimum && !requirements.recommended)) {
    return (
      <div className="p-4 bg-steam-card rounded border border-steam-border text-sm text-steam-subtext">
        System specifications not provided by developer.
      </div>
    );
  }

  // Clean raw Steam HTML if necessary (remove nested tables or clean up line breaks)
  const renderCleanHtml = (htmlContent: string) => {
    return (
      <div
        className="text-xs leading-relaxed text-[#acb2b8] space-y-1 [&_strong]:text-white [&_ul]:space-y-1 [&_li]:list-none [&_li]:pl-0 [&_h2]:text-sm [&_h2]:text-steam-accent [&_h2]:font-bold [&_h2]:mb-2"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(htmlContent) }}
      />
    );
  };

  return (
    <div className="w-full bg-[#16202d] rounded border border-steam-border p-5 space-y-4">
      <div className="flex items-center gap-2 border-b border-steam-border/60 pb-3">
        <Cpu className="w-4 h-4 text-steam-accent" />
        <h3 className="text-sm font-bold tracking-wider text-steam-accent uppercase">
          System Requirements (PC)
        </h3>
      </div>

      <div className={`grid grid-cols-1 ${requirements.minimum && requirements.recommended ? 'md:grid-cols-2' : ''} gap-6`}>
        {/* Minimum Specs */}
        {requirements.minimum && (
          <div className="bg-[#101720]/80 p-4 rounded border border-steam-border/40">
            {renderCleanHtml(requirements.minimum)}
          </div>
        )}

        {/* Recommended Specs */}
        {requirements.recommended && (
          <div className="bg-[#101720]/80 p-4 rounded border border-steam-border/40">
            {renderCleanHtml(requirements.recommended)}
          </div>
        )}
      </div>
    </div>
  );
};
