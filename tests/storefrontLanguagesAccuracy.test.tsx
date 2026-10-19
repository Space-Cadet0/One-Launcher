import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import axios from 'axios';
import {
  parseSteamLanguageTableHtml,
  parseSteamSupportedLanguagesString,
  steamApi,
} from '../src/services/steam/steamApi';
import {
  parseGogLocalizations,
  parseEpicLanguages,
  fallbackMetadataProvider,
} from '../src/services/steam/fallbackMetadataProvider';
import { SteamLanguagesTable } from '../src/components/SteamStoreDetail/SteamLanguagesTable';
import { requestScheduler } from '../src/services/network/requestScheduler';

// ---------------------------------------------------------------------------
// Stateful React 19 Component Test Harness
// ---------------------------------------------------------------------------
function findElements(node: any, predicate: (el: any) => boolean, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  if (node.props && node.props.children) {
    findElements(node.props.children, predicate, acc);
  }
  return acc;
}

function getTextContent(node: any): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getTextContent).join('');
  if (node && typeof node === 'object' && node.props) {
    return getTextContent(node.props.children);
  }
  return '';
}

function createComponentHarness<P extends object>(Component: React.FC<P>, initialProps: P) {
  const states: any[] = [];
  const refs: Array<{ current: any }> = [];
  const prevDeps: Array<any[] | undefined> = [];
  const cleanups: Array<(() => void) | undefined> = [];
  let currentProps = initialProps;

  const render = (nextProps?: Partial<P>) => {
    if (nextProps) {
      currentProps = { ...currentProps, ...nextProps };
    }
    let stateIdx = 0;
    let refIdx = 0;
    let effectIdx = 0;
    const pendingEffects: Array<{ idx: number; fn: () => any }> = [];

    const internals = (React as any)
      .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;

    const runEffectHook = (fn: () => any, deps?: any[]) => {
      const idx = effectIdx++;
      const oldDeps = prevDeps[idx];
      const changed =
        !oldDeps ||
        !deps ||
        oldDeps.length !== deps.length ||
        deps.some((d, i) => !Object.is(d, oldDeps[i]));
      if (changed) {
        prevDeps[idx] = deps;
        pendingEffects.push({ idx, fn });
      }
    };

    internals.H = {
      useState(initial: any) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? initial() : initial);
        }
        const setState = (updater: any) => {
          states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
        };
        return [states[idx], setState];
      },
      useRef(initial: any) {
        const idx = refIdx++;
        if (idx >= refs.length) {
          refs.push({ current: initial });
        }
        return refs[idx];
      },
      useEffect: runEffectHook,
      useLayoutEffect: runEffectHook,
      useMemo(fn: () => any) {
        return fn();
      },
      useCallback(fn: any) {
        return fn;
      },
    };

    let tree: any;
    try {
      tree = Component(currentProps);
    } finally {
      internals.H = prevH;
    }

    for (const eff of pendingEffects) {
      if (typeof cleanups[eff.idx] === 'function') {
        cleanups[eff.idx]!();
      }
      const cleanup = eff.fn();
      cleanups[eff.idx] = typeof cleanup === 'function' ? cleanup : undefined;
    }

    return tree;
  };

  const unmount = () => {
    for (const c of cleanups) {
      if (typeof c === 'function') c();
    }
  };

  return { render, unmount, states, refs };
}

describe('Storefront Language Parsing & SteamLanguagesTable Accuracy (Steam, GOG, Epic)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (steamApi as any).cache?.clear?.();
    requestScheduler.clearAllCooldowns?.();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. STEAM: Alien Breed 2: Assault (appId: 22650)
  // =========================================================================
  describe('Steam: Alien Breed 2: Assault (appId: 22650)', () => {
    const ALIEN_BREED_2_LANG_NAMES = [
      'English',
      'French',
      'German',
      'Italian',
      'Japanese',
      'Spanish - Spain',
    ];

    const ALIEN_BREED_2_SUPPORTED_LANGUAGES_STRING =
      'English, French, German, Italian, Japanese, Spanish - Spain';

    const ALIEN_BREED_2_STORE_TABLE_HTML = `
      <div class="block responsive_apppage_details_right">
        <div class="block_title">Languages:</div>
        <table class="game_language_options" cellpadding="0" cellspacing="0">
          <tr>
            <th style="width: 94px;"></th>
            <th class="checkcol">Interface</th>
            <th class="checkcol">Full Audio</th>
            <th class="checkcol">Subtitles</th>
          </tr>
          <tr style="" class="">
            <td style="width: 94px; text-align: left" class="ellipsis">English</td>
            <td class="checkcol"><span>&#10004;</span></td>
            <td class="checkcol"></td>
            <td class="checkcol"></td>
          </tr>
          <tr style="" class="">
            <td style="width: 94px; text-align: left" class="ellipsis">French</td>
            <td class="checkcol"><span>&#10004;</span></td>
            <td class="checkcol"></td>
            <td class="checkcol"></td>
          </tr>
          <tr style="" class="">
            <td style="width: 94px; text-align: left" class="ellipsis">German</td>
            <td class="checkcol"><span>&#10004;</span></td>
            <td class="checkcol"></td>
            <td class="checkcol"></td>
          </tr>
          <tr style="" class="">
            <td style="width: 94px; text-align: left" class="ellipsis">Italian</td>
            <td class="checkcol"><span>&#10004;</span></td>
            <td class="checkcol"></td>
            <td class="checkcol"></td>
          </tr>
          <tr style="" class="">
            <td style="width: 94px; text-align: left" class="ellipsis">Japanese</td>
            <td class="checkcol"><span>&#10004;</span></td>
            <td class="checkcol"></td>
            <td class="checkcol"></td>
          </tr>
          <tr style="" class="">
            <td style="width: 94px; text-align: left" class="ellipsis">Spanish - Spain</td>
            <td class="checkcol"><span>&#10004;</span></td>
            <td class="checkcol"></td>
            <td class="checkcol"></td>
          </tr>
        </table>
      </div>
    `;

    it('parseSteamLanguageTableHtml and parseSteamSupportedLanguagesString produce hasInterface: true, hasAudio: false, hasSubtitles: false for all 6 languages', () => {
      const fromTable = parseSteamLanguageTableHtml(ALIEN_BREED_2_STORE_TABLE_HTML);
      expect(fromTable).toHaveLength(6);
      expect(fromTable.map((l) => l.name)).toEqual(ALIEN_BREED_2_LANG_NAMES);
      for (const lang of fromTable) {
        expect(lang).toEqual({
          name: lang.name,
          hasInterface: true,
          hasAudio: false,
          hasSubtitles: false,
        });
      }

      const fromString = parseSteamSupportedLanguagesString(ALIEN_BREED_2_SUPPORTED_LANGUAGES_STRING);
      expect(fromString).toHaveLength(6);
      expect(fromString.map((l) => l.name)).toEqual(ALIEN_BREED_2_LANG_NAMES);
      for (const lang of fromString) {
        expect(lang).toEqual({
          name: lang.name,
          hasInterface: true,
          hasAudio: false,
          hasSubtitles: false,
        });
      }
    });

    it('steamApi.fetchGameMetadata(22650) resolves 6 Interface-only languages with steam schema', async () => {
      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.includes('/api/appdetails')) {
          return {
            data: {
              '22650': {
                success: true,
                data: {
                  name: 'Alien Breed 2: Assault',
                  steam_appid: 22650,
                  short_description: 'Alien Breed 2: Assault is an explosive science fiction arcade-shooter.',
                  supported_languages: ALIEN_BREED_2_SUPPORTED_LANGUAGES_STRING,
                },
              },
            },
          } as any;
        }
        if (url.includes('/app/22650/')) {
          return { data: ALIEN_BREED_2_STORE_TABLE_HTML } as any;
        }
        return { data: {} } as any;
      });

      const metadata = await steamApi.fetchGameMetadata(22650);
      expect(metadata).not.toBeNull();
      expect(metadata?.languageTableSchema).toBe('steam');
      expect(metadata?.languageOptions).toHaveLength(6);
      for (const opt of metadata?.languageOptions || []) {
        expect(opt.hasInterface).toBe(true);
        expect(opt.hasAudio).toBe(false);
        expect(opt.hasSubtitles).toBe(false);
      }
    });

    it('SteamLanguagesTable renders Interface ticks and zero ticks in Full Audio or Subtitles', () => {
      const parsedOptions = parseSteamLanguageTableHtml(ALIEN_BREED_2_STORE_TABLE_HTML);
      const harness = createComponentHarness(SteamLanguagesTable, {
        rawSupportedLanguagesHtml: ALIEN_BREED_2_SUPPORTED_LANGUAGES_STRING,
        languageOptions: parsedOptions,
        languageTableSchema: 'steam',
      });

      // Initial render (5 rows visible before expansion)
      let tree = harness.render();
      expect(tree.props['data-language-schema']).toBe('steam');

      // Expand to all 6 rows
      const toggleLinks = findElements(
        tree,
        (el) => el.type === 'a' && getTextContent(el).includes('See all 6 supported languages')
      );
      expect(toggleLinks).toHaveLength(1);
      toggleLinks[0].props.onClick();

      tree = harness.render();

      const headerCells = findElements(tree, (el) => el.type === 'th');
      expect(headerCells.map(getTextContent)).toEqual(['', 'Interface', 'Full Audio', 'Subtitles']);

      const bodyRows = findElements(
        tree,
        (el) => el.type === 'tr' && findElements(el, (c) => c.type === 'td').length > 0
      );
      expect(bodyRows).toHaveLength(6);

      for (let i = 0; i < bodyRows.length; i++) {
        const tds = findElements(bodyRows[i], (el) => el.type === 'td');
        expect(tds).toHaveLength(4);
        expect(getTextContent(tds[0])).toBe(ALIEN_BREED_2_LANG_NAMES[i]);
        // Interface column has ✔
        expect(getTextContent(tds[1])).toBe('✔');
        // Full Audio column has zero ticks
        expect(getTextContent(tds[2])).toBe('');
        // Subtitles column has zero ticks
        expect(getTextContent(tds[3])).toBe('');
      }

      harness.unmount();
    });
  });

  // =========================================================================
  // 2. GOG-ONLY: The Lords of Midnight (gogId: "1207659333")
  // =========================================================================
  describe('GOG-only: The Lords of Midnight (gogId: "1207659333")', () => {
    const LORDS_OF_MIDNIGHT_V2_LOCALIZATIONS = [
      {
        _embedded: {
          language: { code: 'en', name: 'English' },
          localizationScope: { type: 'audio' },
        },
      },
      {
        _embedded: {
          language: { code: 'en', name: 'English' },
          localizationScope: { type: 'text' },
        },
      },
    ];

    it('parseGogLocalizations and fallbackMetadataProvider.fetchGogProductMetadata extract English Audio and English Text with audio_text schema and hasSubtitles: false', async () => {
      const directParsed = parseGogLocalizations(LORDS_OF_MIDNIGHT_V2_LOCALIZATIONS);
      expect(directParsed.languageTableSchema).toBe('audio_text');
      expect(directParsed.supportedLanguages).toBe('AUDIO: English | TEXT: English');
      expect(directParsed.languageOptions).toEqual([
        {
          name: 'English',
          hasInterface: true,
          hasAudio: true,
          hasSubtitles: false,
        },
      ]);

      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.includes('/v2/games/1207659333')) {
          return {
            data: {
              _embedded: {
                product: {
                  title: 'The Lords of Midnight',
                  globalReleaseDate: '1984-01-01T00:00:00+00:00',
                },
                developers: [{ name: 'Mike Singleton' }],
                publishers: [{ name: 'Beyond Software' }],
                localizations: LORDS_OF_MIDNIGHT_V2_LOCALIZATIONS,
              },
              description:
                '<p>The Lords of Midnight is an epic strategy-adventure game across the frozen lands of Midnight.</p>',
            },
          } as any;
        }
        if (url.includes('/products/1207659333')) {
          return {
            data: {
              id: 1207659333,
              title: 'The Lords of Midnight',
              languages: { en: 'English' },
              description: {
                lead: 'The Lords of Midnight is an epic strategy-adventure game across the frozen lands of Midnight.',
                full: '<p>The Lords of Midnight is an epic strategy-adventure game across the frozen lands of Midnight.</p>',
              },
            },
          } as any;
        }
        return { data: {} } as any;
      });

      const gogMeta = await fallbackMetadataProvider.fetchGogProductMetadata(
        '1207659333',
        'The Lords of Midnight'
      );
      expect(gogMeta).not.toBeNull();
      expect(gogMeta?.languageTableSchema).toBe('audio_text');
      expect(gogMeta?.supportedLanguages).toBe('AUDIO: English | TEXT: English');
      expect(gogMeta?.languageOptions).toEqual([
        {
          name: 'English',
          hasInterface: true,
          hasAudio: true,
          hasSubtitles: false,
        },
      ]);
    });

    it('SteamLanguagesTable renders Audio and Text (with English ticked for Audio and Text) and does NOT render a Subtitles column or fake extra languages', () => {
      const parsed = parseGogLocalizations(LORDS_OF_MIDNIGHT_V2_LOCALIZATIONS);
      const html = renderToString(
        React.createElement(SteamLanguagesTable, {
          rawSupportedLanguagesHtml: parsed.supportedLanguages,
          languageOptions: parsed.languageOptions,
          languageTableSchema: parsed.languageTableSchema,
        })
      );

      expect(html).toContain('data-language-schema="audio_text"');
      expect(html).toContain('data-testid="audio-text-language-table"');
      expect(html).not.toContain('Subtitles');
      expect(html).not.toContain('Interface');

      const harness = createComponentHarness(SteamLanguagesTable, {
        rawSupportedLanguagesHtml: parsed.supportedLanguages,
        languageOptions: parsed.languageOptions,
        languageTableSchema: parsed.languageTableSchema,
      });

      const tree = harness.render();
      const headerCells = findElements(tree, (el) => el.type === 'th');
      expect(headerCells.map(getTextContent)).toEqual(['', 'Audio', 'Text']);

      const bodyRows = findElements(
        tree,
        (el) => el.type === 'tr' && findElements(el, (c) => c.type === 'td').length > 0
      );
      // Only English — no fake extra languages
      expect(bodyRows).toHaveLength(1);

      const tds = findElements(bodyRows[0], (el) => el.type === 'td');
      expect(tds).toHaveLength(3);
      expect(getTextContent(tds[0])).toBe('English');
      expect(getTextContent(tds[1])).toBe('✔');
      expect(getTextContent(tds[2])).toBe('✔');

      harness.unmount();
    });
  });

  // =========================================================================
  // 3. EPIC-ONLY: Alan Wake 2
  // =========================================================================
  describe('Epic-only: Alan Wake 2', () => {
    const ALAN_WAKE_2_RAW_EPIC_LANGUAGES = [
      'AUDIO: German, English, Spanish (Spain), French, Japanese',
      'TEXT: English, German, Spanish (Spain), Spanish (Latin America), French, Italian, Japanese, Korean, Polish, Português (Brasil), Russian, Ukrainian, Chinese (Simplified), Chinese (Traditional)',
    ];

    const EXPECTED_AUDIO_LANGUAGES = [
      'English',
      'French',
      'German',
      'Japanese',
      'Spanish (Spain)',
    ];

    const EXPECTED_TEXT_LANGUAGES = [
      'Chinese (Simplified)',
      'Chinese (Traditional)',
      'English',
      'French',
      'German',
      'Italian',
      'Japanese',
      'Korean',
      'Polish',
      'Portuguese (Brazil)',
      'Russian',
      'Spanish (Latin America)',
      'Spanish (Spain)',
      'Ukrainian',
    ];

    it('parseEpicLanguages and fallbackMetadataProvider.fetchEpicProductMetadata extract exact 5 Audio and 14 Text languages with audio_text schema', async () => {
      const parsed = parseEpicLanguages(ALAN_WAKE_2_RAW_EPIC_LANGUAGES);
      expect(parsed.languageTableSchema).toBe('audio_text');
      expect(parsed.languageOptions).toHaveLength(14);

      const audioNames = (parsed.languageOptions || []).filter((l) => l.hasAudio).map((l) => l.name);
      const textNames = (parsed.languageOptions || []).filter((l) => l.hasInterface).map((l) => l.name);
      expect(audioNames).toEqual(EXPECTED_AUDIO_LANGUAGES);
      expect(textNames).toEqual(EXPECTED_TEXT_LANGUAGES);

      for (const opt of parsed.languageOptions || []) {
        expect(opt.hasSubtitles).toBe(false);
        expect(opt.hasInterface).toBe(true);
        expect(opt.hasAudio).toBe(EXPECTED_AUDIO_LANGUAGES.includes(opt.name));
      }

      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.includes('/content/products/alan-wake-2')) {
          return {
            data: {
              pages: [
                {
                  type: 'productHome',
                  data: {
                    about: {
                      shortDescription:
                        'Saga Anderson arrives to investigate ritualistic murders in a small town.',
                      description:
                        'Alan Wake 2 is a psychological survival horror game developed by Remedy Entertainment.',
                      developerAttribution: 'Remedy Entertainment',
                      publisherAttribution: 'Epic Games Publishing',
                    },
                    requirements: {
                      languages: ALAN_WAKE_2_RAW_EPIC_LANGUAGES,
                      systems: [],
                    },
                  },
                },
              ],
            },
          } as any;
        }
        return { data: {} } as any;
      });

      const epicMeta = await fallbackMetadataProvider.fetchEpicProductMetadata('alan-wake-2', {
        title: 'Alan Wake 2',
      });
      expect(epicMeta).not.toBeNull();
      expect(epicMeta?.languageTableSchema).toBe('audio_text');
      expect(epicMeta?.languageOptions).toHaveLength(14);
      expect(
        (epicMeta?.languageOptions || []).filter((l) => l.hasAudio).map((l) => l.name)
      ).toEqual(EXPECTED_AUDIO_LANGUAGES);
      expect(
        (epicMeta?.languageOptions || []).filter((l) => l.hasInterface).map((l) => l.name)
      ).toEqual(EXPECTED_TEXT_LANGUAGES);
      expect(epicMeta?.supportedLanguages).toBe(
        `AUDIO: ${EXPECTED_AUDIO_LANGUAGES.join(', ')} | TEXT: ${EXPECTED_TEXT_LANGUAGES.join(', ')}`
      );
    });

    it('SteamLanguagesTable renders exact Audio and Text summary lists and 2-column Audio | Text table with no Subtitles column', () => {
      const parsed = parseEpicLanguages(ALAN_WAKE_2_RAW_EPIC_LANGUAGES);
      const harness = createComponentHarness(SteamLanguagesTable, {
        rawSupportedLanguagesHtml: parsed.supportedLanguages,
        languageOptions: parsed.languageOptions,
        languageTableSchema: parsed.languageTableSchema,
      });

      let tree = harness.render();
      expect(tree.props['data-language-schema']).toBe('audio_text');

      // Check Audio & Text summary block
      const summaryNodes = findElements(
        tree,
        (el) => el.props?.['data-testid'] === 'audio-text-language-summary'
      );
      expect(summaryNodes).toHaveLength(1);
      const summaryText = getTextContent(summaryNodes[0]);
      expect(summaryText).toContain(
        `Audio: ${EXPECTED_AUDIO_LANGUAGES.join(', ')}`
      );
      expect(summaryText).toContain(
        `Text: ${EXPECTED_TEXT_LANGUAGES.join(', ')}`
      );

      // Expand to all 14 languages
      const toggleLinks = findElements(
        tree,
        (el) => el.type === 'a' && getTextContent(el).includes('See all 14 supported languages')
      );
      expect(toggleLinks).toHaveLength(1);
      toggleLinks[0].props.onClick();

      tree = harness.render();

      // Verify 2-column Audio | Text headers and no Subtitles column
      const headerCells = findElements(tree, (el) => el.type === 'th');
      expect(headerCells.map(getTextContent)).toEqual(['', 'Audio', 'Text']);
      expect(headerCells.map(getTextContent)).not.toContain('Subtitles');

      const bodyRows = findElements(
        tree,
        (el) => el.type === 'tr' && findElements(el, (c) => c.type === 'td').length > 0
      );
      expect(bodyRows).toHaveLength(14);

      for (let i = 0; i < bodyRows.length; i++) {
        const tds = findElements(bodyRows[i], (el) => el.type === 'td');
        expect(tds).toHaveLength(3);
        const langName = getTextContent(tds[0]);
        expect(langName).toBe(EXPECTED_TEXT_LANGUAGES[i]);
        const expectedAudioTick = EXPECTED_AUDIO_LANGUAGES.includes(langName) ? '✔' : '';
        expect(getTextContent(tds[1])).toBe(expectedAudioTick);
        expect(getTextContent(tds[2])).toBe('✔');
      }

      harness.unmount();
    });
  });
});
