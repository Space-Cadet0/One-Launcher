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

const DEFAULT_FALLBACK_LANGUAGES: SteamLanguageOption[] = [
  { name: 'English', hasInterface: true, hasAudio: false, hasSubtitles: false },
];

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

    if (effectiveSchema === 'audio_text') {
      const parsed = parseEpicLanguages(rawSupportedLanguagesHtml)?.languageOptions;
      return parsed && parsed.length > 0 ? parsed : DEFAULT_FALLBACK_LANGUAGES;
    }

    if (
      rawSupportedLanguagesHtml &&
      /game_language_options|<table/i.test(rawSupportedLanguagesHtml)
    ) {
      const parsedTable = parseSteamLanguageTableHtml(rawSupportedLanguagesHtml);
      if (parsedTable.length > 0) {
        return parsedTable;
      }
    }

    if (rawSupportedLanguagesHtml) {
      const parsedString = parseSteamSupportedLanguagesString(rawSupportedLanguagesHtml);
      if (parsedString.length > 0) {
        return parsedString;
      }
    }

    return DEFAULT_FALLBACK_LANGUAGES;
  }, [rawSupportedLanguagesHtml, languageOptions, effectiveSchema]);

  const displayedLanguages = isExpanded ? languages : languages.slice(0, 5);
  const hasAnyAudio = languages.some((l) => l.hasAudio);

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
                <th className="text-left font-normal"></th>
                <th className="checkcol">Audio</th>
                <th className="checkcol">Text</th>
              </tr>
            </thead>
            <tbody>
              {displayedLanguages.map((lang, idx) => (
                <tr key={idx}>
                  <td className="lang-name truncate max-w-[140px]" title={lang.name}>
                    {lang.name}
                  </td>
                  <td className="checkcol">
                    {lang.hasAudio ? <span className="check">✔</span> : null}
                  </td>
                  <td className="checkcol">
                    {lang.hasInterface ? <span className="check">✔</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {languages.length > 5 && (
          <a
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-[11px] text-[#67c1f5] hover:text-white hover:underline cursor-pointer inline-block mt-1 font-normal select-none"
          >
            {isExpanded
              ? 'Show fewer languages'
              : `See all ${languages.length} supported languages`}
          </a>
        )}
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
              <th className="text-left font-normal"></th>
              <th className="checkcol">Interface</th>
              <th className="checkcol">Full Audio</th>
              <th className="checkcol">Subtitles</th>
            </tr>
          </thead>
          <tbody>
            {displayedLanguages.map((lang, idx) => (
              <tr key={idx}>
                <td className="lang-name truncate max-w-[110px]" title={lang.name}>
                  {lang.name}
                </td>
                <td className="checkcol">
                  {lang.hasInterface ? <span className="check">✔</span> : null}
                </td>
                <td className="checkcol">
                  {lang.hasAudio ? <span className="check">✔</span> : null}
                </td>
                <td className="checkcol">
                  {lang.hasSubtitles ? <span className="check">✔</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {languages.length > 5 && (
        <a
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-[11px] text-[#67c1f5] hover:text-white hover:underline cursor-pointer inline-block mt-1 font-normal select-none"
        >
          {isExpanded
            ? 'Show fewer languages'
            : `See all ${languages.length} supported languages`}
        </a>
      )}

      {hasAnyAudio && (
        <div className="text-[10px] text-[#61686d] italic mt-1">
          *languages with full audio support
        </div>
      )}
    </div>
  );
};

