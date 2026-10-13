import { describe, it, expect } from 'vitest';
import {
  steamMatcher,
  getEffectiveSteamAppId,
  computeTitleSimilarity,
  extractSequelIdentifier,
  normalizeTitleKey,
  stripEditionSuffix,
  ROMAN_TO_ARABIC,
  EDITION_TOKENS,
  EDITION_WORDS,
  KNOWN_STORE_STEAM_MAPPINGS,
  CANONICAL_KNOWN_STORE_STEAM_MAPPINGS,
  KNOWN_NON_STEAM_TITLES,
} from '../src/services/steam/steamMatcher';

describe('SteamMatcherService & Shared Title Utilities Integration', () => {
  describe('getEffectiveSteamAppId', () => {
    it('returns undefined if isExplicitNonSteam is true', () => {
      expect(
        getEffectiveSteamAppId({
          title: 'Cyberpunk 2077',
          steamAppId: 1091500,
          isExplicitNonSteam: true,
        })
      ).toBeUndefined();

      expect(
        steamMatcher.getEffectiveSteamAppId({
          title: 'Cyberpunk 2077',
          isExplicitNonSteam: true,
        })
      ).toBeUndefined();
    });

    it('returns steamAppId directly if it is a positive number', () => {
      expect(
        getEffectiveSteamAppId({
          title: 'Some Custom Game',
          steamAppId: 487720,
        })
      ).toBe(487720);
    });

    it('returns undefined if steamAppId is explicitly null (manual unmatch)', () => {
      expect(
        getEffectiveSteamAppId({
          title: 'Cyberpunk 2077',
          steamAppId: null,
        })
      ).toBeUndefined();
    });

    it('resolves instant match when steamAppId is undefined and title is known', () => {
      expect(
        getEffectiveSteamAppId({
          title: 'Cyberpunk 2077',
        })
      ).toBe(1091500);

      expect(
        getEffectiveSteamAppId({
          title: "The Witcher 3: Wild Hunt - Complete Edition",
        })
      ).toBe(292030);

      expect(
        getEffectiveSteamAppId({
          title: "Baldur's Gate 3",
        })
      ).toBe(1086940);
    });

    it('returns undefined when title is unknown or not on Steam', () => {
      expect(
        getEffectiveSteamAppId({
          title: 'NonExistentGame12345XYZ',
        })
      ).toBeUndefined();

      expect(
        getEffectiveSteamAppId({
          title: 'Doom + Doom II', // Known non-steam bundle
        })
      ).toBeUndefined();

      expect(getEffectiveSteamAppId(null)).toBeUndefined();
      expect(getEffectiveSteamAppId(undefined)).toBeUndefined();
      expect(getEffectiveSteamAppId({})).toBeUndefined();
    });
  });

  describe('Shared Title Normalization Exports & Utilities', () => {
    it('exports all expected title and edition utilities', () => {
      expect(normalizeTitleKey).toBeDefined();
      expect(stripEditionSuffix).toBeDefined();
      expect(ROMAN_TO_ARABIC).toBeDefined();
      expect(EDITION_TOKENS).toBeDefined();
      expect(EDITION_WORDS).toBe(EDITION_TOKENS);
    });

    it('normalizes titles correctly', () => {
      expect(normalizeTitleKey('Deus Ex: Human Revolution™ - Director\'s Cut')).toBe('deus ex human revolution directors cut');
      expect(stripEditionSuffix('Deus Ex: Human Revolution - Director\'s Cut')).toBe('deus ex human revolution');
    });

    it('extractSequelIdentifier extracts Arabic and Roman numeral sequels', () => {
      expect(extractSequelIdentifier('The Witcher 2')).toBe('2');
      expect(extractSequelIdentifier('Doom II')).toBe('2');
      expect(extractSequelIdentifier('Final Fantasy VII')).toBe('7');
      expect(extractSequelIdentifier('Grand Theft Auto V')).toBe('5');
      expect(extractSequelIdentifier(['left', '4', 'dead'])).toBe('4');
      expect(extractSequelIdentifier('Cyberpunk 2077')).toBeNull();
      expect(extractSequelIdentifier('Doom')).toBeNull();
    });

    it('computeTitleSimilarity matches editions and rejects sequel conflicts', () => {
      // Edition match
      expect(computeTitleSimilarity('DARQ', 'DARQ: Complete Edition')).toBeGreaterThanOrEqual(0.9);
      expect(computeTitleSimilarity('Control', 'Control Ultimate Edition')).toBeGreaterThanOrEqual(0.9);

      // Sequel rejection
      expect(computeTitleSimilarity('Doom', 'Doom II')).toBe(0);
      expect(computeTitleSimilarity('The Witcher 2', 'The Witcher 3')).toBe(0);
      expect(computeTitleSimilarity('Left 4 Dead', 'Left 4 Dead 2')).toBe(0);
      expect(computeTitleSimilarity('Quake', 'Quake 2')).toBe(0);
    });

    it('preserves known store mappings and non-steam sets', () => {
      expect(KNOWN_STORE_STEAM_MAPPINGS['cyberpunk 2077']).toBe(1091500);
      expect(CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.has('cyberpunk 2077')).toBe(true);
      expect(KNOWN_NON_STEAM_TITLES.has('doom + doom ii')).toBe(true);
    });
  });
});
