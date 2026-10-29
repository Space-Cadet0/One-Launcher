import React, { useState, useMemo } from 'react';
import { LanguageTableSchema, SteamLanguageOption } from '../../contracts/steam';
import {
  parseSteamLanguageTableHtml,
  parseSteamSupportedLanguagesString,
} from '../../services/steam/steamApi';
import { parseEpicLanguages } from '../../services/steam/fallbackMetadataProvider';

interface SteamLanguagesTableProps {
  rawSupportedLanguagesHtml?: string;
  languageOptions?: SteamLanguageOption[];
  languageTableSchema?: LanguageTableSchema;
}

export const SteamLanguagesTable: React.FC<SteamLanguagesTableProps> = ({
  rawSupportedLanguagesHtml,
  languageOptions,
  languageTableSchema,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const effectiveSchema: LanguageTableSchema = useMemo(() => {
    if (
      languageTableSchema === 'audio_text' ||
      (typeof rawSupportedLanguagesHtml === 'string' &&
        /\b(?:AUDIO|VOICE)\s*:|\bTEXT\s*:/i.test(rawSupportedLanguagesHtml))
    ) {
      return 'audio_text';
    }
    return 'steam';
  }, [languageTableSchema, rawSupportedLanguagesHtml]);

  const languages: SteamLanguageOption[] = useMemo(() => {
    if (Array.isArray(languageOptions) && languageOptions.length > 0) {
      return languageOptions;
    }

    const trimmedHtml =
      typeof rawSupportedLanguagesHtml === 'string' ? rawSupportedLanguagesHtml.trim() : '';
    if (!trimmedHtml) {
      return [];
    }

    if (effectiveSchema === 'audio_text') {
      const parsed = parseEpicLanguages(trimmedHtml)?.languageOptions;
      return parsed && parsed.length > 0 ? parsed : [];
    }

    if (/game_language_options|<table/i.test(trimmedHtml)) {
      const parsedTable = parseSteamLanguageTableHtml(trimmedHtml);
      if (parsedTable.length > 0) {
        return parsedTable;
      }
    }

    const parsedString = parseSteamSupportedLanguagesString(trimmedHtml);
    if (parsedString.length > 0) {
      return parsedString;
    }

    return [];
  }, [rawSupportedLanguagesHtml, languageOptions, effectiveSchema]);

  if (languages.length === 0) {
    return (
      <div className="mb-4" data-language-schema={effectiveSchema}>
        <div className="steam-block-title">Languages</div>
        <div className="px-2.5 py-2 bg-black/20 border border-[#2a475e]/30 rounded-sm text-xs text-[#94a3b8] italic">
          Language details pending online sync
        </div>
      </div>
    );
  }

  const displayedLanguages = isExpanded ? languages : languages.slice(0, 5);
  const hasAnyAudio = languages.some((l) => l.hasAudio);

  const renderSupportCell = (supported?: boolean) => (
    <td className="checkcol" aria-label={supported ? 'Supported' : 'Not supported'}>
      {supported ? (
        <span aria-hidden="true" className="check">
          ✔
        </span>
      ) : null}
    </td>
  );

  const renderExpandToggle = () =>
    languages.length > 5 ? (
      <a
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded(!isExpanded);
          }
        }}
        className="min-h-6 text-[11px] text-[#67c1f5] hover:text-white hover:underline cursor-pointer inline-flex items-center mt-1 font-normal select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#67c1f5] rounded"
      >
        {isExpanded ? 'Show fewer languages' : `See all ${languages.length} supported languages`}
      </a>
    ) : null;

  if (effectiveSchema === 'audio_text') {
    const audioLanguages = languages.filter((l) => l.hasAudio).map((l) => l.name);
    const textLanguages = languages.filter((l) => l.hasInterface).map((l) => l.name);

    return (
      <div className="mb-4" data-language-schema="audio_text">
        <div className="steam-block-title">Languages</div>

        {(audioLanguages.length > 0 || textLanguages.length > 0) && (
          <div
            data-testid="audio-text-language-summary"
            className="mb-2.5 px-2.5 py-2 rounded bg-[#101822]/90 border border-[#2a475e]/40 text-[11px] leading-relaxed text-[#acb2b8] space-y-1"
          >
            {audioLanguages.length > 0 && (
              <div>
                <span className="font-semibold text-[#67c1f5]">Audio:</span>{' '}
                <span className="text-[#c6d4df]">{audioLanguages.join(', ')}</span>
              </div>
            )}
            {textLanguages.length > 0 && (
              <div>
                <span className="font-semibold text-[#67c1f5]">Text:</span>{' '}
                <span className="text-[#c6d4df]">{textLanguages.join(', ')}</span>
              </div>
            )}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="steam-lang-table" data-testid="audio-text-language-table">
            <thead>
              <tr>
                <th scope="col" aria-label="Language" className="text-left font-normal" />
                <th scope="col" className="checkcol">
                  Audio
                </th>
                <th scope="col" className="checkcol">
                  Text
                </th>
              </tr>
            </thead>
            <tbody>
              {displayedLanguages.map((lang, idx) => (
                <tr key={idx}>
                  <td
                    className="lang-name text-left font-normal truncate max-w-[140px]"
                    title={lang.name}
                  >
                    {lang.name}
                  </td>
                  {renderSupportCell(lang.hasAudio)}
                  {renderSupportCell(lang.hasInterface)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {renderExpandToggle()}
      </div>
    );
  }

  return (
    <div className="mb-4" data-language-schema="steam">
      <div className="steam-block-title">Languages</div>

      <div className="overflow-x-auto">
        <table className="steam-lang-table" data-testid="steam-language-table">
          <thead>
            <tr>
              <th scope="col" aria-label="Language" className="text-left font-normal" />
              <th scope="col" className="checkcol">
                Interface
              </th>
              <th scope="col" className="checkcol">
                Full Audio
              </th>
              <th scope="col" className="checkcol">
                Subtitles
              </th>
            </tr>
          </thead>
          <tbody>
            {displayedLanguages.map((lang, idx) => (
              <tr key={idx}>
                <td
                  className="lang-name text-left font-normal truncate max-w-[110px]"
                  title={lang.name}
                >
                  {lang.name}
                </td>
                {renderSupportCell(lang.hasInterface)}
                {renderSupportCell(lang.hasAudio)}
                {renderSupportCell(lang.hasSubtitles)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {renderExpandToggle()}

      {hasAnyAudio && (
        <div className="text-[10px] text-[#94a3b8] italic mt-1">
          *languages with full audio support
        </div>
      )}
    </div>
  );
};
