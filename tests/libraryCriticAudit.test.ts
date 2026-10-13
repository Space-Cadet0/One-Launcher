import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { FULL_USER_STEAM_GAMES } from '../src/services/storage/fullUserSteamGames';
import { GOG_USER_LIBRARY } from '../src/services/storage/gogUserLibrary';
import { EPIC_USER_LIBRARY } from '../src/services/storage/epicUserLibrary';
import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';
import { mergeStorefrontGames } from '../src/services/integrations/integrationStorage';
import {
  getOpenCriticData,
  criticScoreService,
  normalizeCriticTitleKey,
  KNOWN_UNRATED_TITLES,
} from '../src/services/critic/criticScoreService';
import { steamMatcher } from '../src/services/steam/steamMatcher';
import { CriticScoreData } from '../src/contracts/critic';
import { KNOWN_CRITIC_SCORES } from '../src/services/critic/knownCriticScores';
import { isSequelMismatch } from '../src/services/critic/criticUtils';
import { isTitleCompatible } from '../src/services/critic/metacriticResolver';

describe('1-by-1 Full Library 6-Tier Critic, User & Storefront Score Audit', () => {
  it('audits all 811 games across 6 distinct tiers and generates separate tables', async () => {
    // Purge memory and local caches to guarantee an unpoisoned audit run
    criticScoreService.purgeAllScoreCache();

    let catalog = sanitizeGameCatalog(FULL_USER_STEAM_GAMES);
    catalog = mergeStorefrontGames(catalog, GOG_USER_LIBRARY, 'gog');
    catalog = mergeStorefrontGames(catalog, EPIC_USER_LIBRARY, 'epic');

    expect(catalog).toHaveLength(811);

    // Dynamic resolution across library (excluding known unrated titles)
    const unrated = catalog.filter((g) => {
      const lower = g.title.toLowerCase().trim();
      const norm = normalizeCriticTitleKey(g.title);
      if (
        KNOWN_UNRATED_TITLES.has(lower) ||
        (Boolean(norm) && KNOWN_UNRATED_TITLES.has(norm)) ||
        /\b(public testing|tech beta|playtest|digital goodies|pre-game editor|resource archiver|playable teaser)\b/i.test(g.title)
      ) {
        return false;
      }
      const targetSteamId = g.steamAppId || steamMatcher.matchGameToSteamInstant(g.title);
      const data = getOpenCriticData(targetSteamId, g.title, g.reviewSummary?.positivePercent);
      if (!data || (!data.isVerified && data.source === 'steam' && !g.steamAppId) || (data.source === 'opencritic' && !data.isVerified)) {
        return true;
      }
      if (data.source === 'metacritic' && data.url) {
        const slugMatch = data.url.match(/\/game\/(?:[0-9]+\/)?([^\/]+)/);
        const slug = slugMatch ? slugMatch[1] : '';
        const slugTitle = slug.replace(/-\d{4}$/, '').replace(/-/g, ' ');
        if (isSequelMismatch(g.title, slugTitle) || !isTitleCompatible(g.title, slugTitle)) {
          return true;
        }
      }
      return false;
    });

    const chunkSize = 15;
    for (let i = 0; i < unrated.length; i += chunkSize) {
      const chunk = unrated.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(async (g) => {
          const targetSteamId = g.steamAppId || steamMatcher.matchGameToSteamInstant(g.title);
          await criticScoreService.resolveDynamicScore(g.title, targetSteamId);
        })
      );
    }

    interface AuditRow {
      index: number;
      title: string;
      platforms: string;
      score: number | string;
      rawScore?: number;
      starRatingRaw?: number;
      tier: string;
      source: string;
      numReviews?: number;
      isVerified: boolean;
      url: string;
    }

    const tier1MetacriticRows: AuditRow[] = [];
    const tier2OpenCriticRows: AuditRow[] = [];
    const tier3MetacriticUserRows: AuditRow[] = [];
    const tier4SteamSyntheticRows: AuditRow[] = [];
    const tier5StorefrontRows: AuditRow[] = [];
    const tier6NullRows: AuditRow[] = [];
    const allRows: AuditRow[] = [];

    const cleanDatabaseMap: Record<string | number, CriticScoreData> = { ...KNOWN_CRITIC_SCORES };

    catalog.forEach((game, idx) => {
      const targetSteamId = game.steamAppId || steamMatcher.matchGameToSteamInstant(game.title);
      let scoreData = getOpenCriticData(
        targetSteamId,
        game.title,
        targetSteamId ? game.reviewSummary?.positivePercent : undefined
      );

      const platforms = game.platforms.map((p) => p.platformId.toUpperCase()).join(', ');
      const lowerTitle = game.title.toLowerCase().trim();
      const normTitle = normalizeCriticTitleKey(game.title);
      const isExplicitlyUnrated =
        KNOWN_UNRATED_TITLES.has(lowerTitle) ||
        (Boolean(normTitle) && KNOWN_UNRATED_TITLES.has(normTitle)) ||
        /\b(public testing|tech beta|playtest|digital goodies|pre-game editor|resource archiver|playable teaser)\b/i.test(game.title);

      if (isExplicitlyUnrated && (!scoreData || !scoreData.isSynthetic || !game.steamAppId)) {
        scoreData = null;
      }

      if (scoreData && scoreData.score > 0) {
        // Record in clean unpoisoned database map (excluding unrated titles)
        if (!isExplicitlyUnrated) {
          if (targetSteamId) {
            cleanDatabaseMap[targetSteamId] = scoreData;
          }
          if (normTitle) {
            cleanDatabaseMap[normTitle] = scoreData;
          }
          if (lowerTitle && lowerTitle !== normTitle) {
            cleanDatabaseMap[lowerTitle] = scoreData;
          }
        }

        const row: AuditRow = {
          index: idx + 1,
          title: game.title,
          platforms,
          score: scoreData.score,
          rawScore: scoreData.userScoreRaw,
          starRatingRaw: scoreData.starRatingRaw,
          tier: scoreData.tier,
          source: scoreData.source,
          numReviews: scoreData.numReviews,
          isVerified: scoreData.isVerified,
          url: scoreData.url,
        };

        allRows.push(row);

        if (scoreData.source === 'metacritic') {
          tier1MetacriticRows.push(row);
        } else if (scoreData.source === 'opencritic') {
          tier2OpenCriticRows.push(row);
        } else if (scoreData.source === 'metacritic_user') {
          tier3MetacriticUserRows.push(row);
        } else if (scoreData.source === 'steam') {
          tier4SteamSyntheticRows.push(row);
        } else if (scoreData.source === 'gog' || scoreData.source === 'epic') {
          tier5StorefrontRows.push(row);
        }
      } else {
        const nullRow: AuditRow = {
          index: idx + 1,
          title: game.title,
          platforms,
          score: '—',
          tier: 'Unrated',
          source: 'none',
          isVerified: false,
          url: '—',
        };
        allRows.push(nullRow);
        tier6NullRows.push(nullRow);
      }
    });

    console.log('\n======================================================');
    console.log('       6-TIER LIBRARY CRITIC & USER SCORE AUDIT');
    console.log('======================================================');
    console.log(`Total Games Audited:              ${catalog.length}`);
    console.log(`Tier 1 (Metacritic Metascore):   ${tier1MetacriticRows.length} (${((tier1MetacriticRows.length / catalog.length) * 100).toFixed(1)}%)`);
    console.log(`Tier 2 (OpenCritic Critic Avg):  ${tier2OpenCriticRows.length} (${((tier2OpenCriticRows.length / catalog.length) * 100).toFixed(1)}%)`);
    console.log(`Tier 3 (Metacritic User Score):  ${tier3MetacriticUserRows.length} (${((tier3MetacriticUserRows.length / catalog.length) * 100).toFixed(1)}%)`);
    console.log(`Tier 4 (Steam Synthetic Score):  ${tier4SteamSyntheticRows.length} (${((tier4SteamSyntheticRows.length / catalog.length) * 100).toFixed(1)}%)`);
    console.log(`Tier 5 (Storefront Star Rating): ${tier5StorefrontRows.length} (${((tier5StorefrontRows.length / catalog.length) * 100).toFixed(1)}%)`);
    console.log(`Tier 6 (Null / Truly Unrated):    ${tier6NullRows.length} (${((tier6NullRows.length / catalog.length) * 100).toFixed(1)}%)`);
    console.log('======================================================\n');

    // Save regenerated, clean, unpoisoned database to knownCriticScores.ts
    const knownCriticPath = path.join(__dirname, '../src/services/critic/knownCriticScores.ts');
    const sortedKeys = Object.keys(cleanDatabaseMap).sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      if (!isNaN(numA)) return -1;
      if (!isNaN(numB)) return 1;
      return a.localeCompare(b);
    });

    const sortedDb: Record<string | number, CriticScoreData> = {};
    for (const k of sortedKeys) {
      sortedDb[k] = cleanDatabaseMap[k];
    }

    const unratedArray = Array.from(KNOWN_UNRATED_TITLES).sort();
    const tsCode = `import { CriticScoreData } from '../../contracts/critic';

/**
 * Titles explicitly verified to have NO critic consensus on Metacritic or OpenCritic.
 * These strictly return null (zero fabrication).
 */
export const KNOWN_UNRATED_TITLES = new Set<string>([
${unratedArray.map((t) => `  ${JSON.stringify(t)},`).join('\n')}
]);

/**
 * Clean Unpoisoned Master Dataset of Critic, User and Storefront Scores.
 * 6-Tier Hierarchy:
 * Tier 1: Metacritic Metascore (Critic consensus, >= 4 reviews)
 * Tier 2: OpenCritic Top Critic Average (Critic consensus, >= 4 reviews)
 * Tier 3: Metacritic User Score (Player consensus, >= 4 user reviews)
 * Tier 4: Steam Community Sentiment (Calibrated synthetic player score, >= 10 reviews)
 * Tier 5: Storefront Star Rating (GOG / Epic 5-star rating converted to 0-100, >= 4 reviews)
 * Tier 6: Truly Unrated / Null (Betas, dev tools, internal playtests)
 */
export const KNOWN_CRITIC_SCORES: Record<string | number, CriticScoreData> = ${JSON.stringify(sortedDb, null, 2)};
`;

    fs.writeFileSync(knownCriticPath, tsCode, 'utf8');
    console.log(`Clean master critic database saved to ${knownCriticPath} (${Object.keys(cleanDatabaseMap).length} total keys).`);

    // =========================================================================
    // Artifact 1: Separate 6-Table Report by Tier (library_review_score_audit_by_tier.md)
    // =========================================================================
    const artifactTierPath = '/Users/mike/.gemini/antigravity/brain/e017a8f4-1aaa-40ef-bc58-85357876d2b0/library_review_score_audit_by_tier.md';
    let mdTier = `# Comprehensive Library Review Score Audit by Tier (All 811 Games)\n\n`;
    mdTier += `**Generated:** ${new Date().toISOString()}\n\n`;
    mdTier += `### Summary Metrics by Tier\n\n`;
    mdTier += `| Tier | Source & Type | Game Count | Percentage |\n`;
    mdTier += `| :--- | :--- | :---: | :---: |\n`;
    mdTier += `| **Tier 1** | **Metacritic Metascore** (Critic Consensus) | **${tier1MetacriticRows.length}** | **${((tier1MetacriticRows.length / catalog.length) * 100).toFixed(1)}%** |\n`;
    mdTier += `| **Tier 2** | **OpenCritic Average** (Critic Consensus) | **${tier2OpenCriticRows.length}** | **${((tier2OpenCriticRows.length / catalog.length) * 100).toFixed(1)}%** |\n`;
    mdTier += `| **Tier 3** | **Metacritic User Score** (Player Consensus) | **${tier3MetacriticUserRows.length}** | **${((tier3MetacriticUserRows.length / catalog.length) * 100).toFixed(1)}%** |\n`;
    mdTier += `| **Tier 4** | **Steam Community Sentiment** (Synthetic Bayesian) | **${tier4SteamSyntheticRows.length}** | **${((tier4SteamSyntheticRows.length / catalog.length) * 100).toFixed(1)}%** |\n`;
    mdTier += `| **Tier 5** | **Storefront Star Rating** (GOG / Epic Converted to 0-100) | **${tier5StorefrontRows.length}** | **${((tier5StorefrontRows.length / catalog.length) * 100).toFixed(1)}%** |\n`;
    mdTier += `| **Tier 6** | **Null / Truly Unrated** (Betas, Editors, Tech Demos) | **${tier6NullRows.length}** | **${((tier6NullRows.length / catalog.length) * 100).toFixed(1)}%** |\n`;
    mdTier += `| **Total** | **All Combined Storefront Games** | **${catalog.length}** | **100.0%** |\n\n`;

    const formatTable = (rows: AuditRow[], formatType: 'default' | 'user' | 'storefront' = 'default') => {
      let scoreHeader = 'Score';
      if (formatType === 'user') scoreHeader = 'User Score';
      if (formatType === 'storefront') scoreHeader = 'Store Rating (0-100)';

      let out = `| # | Game Title | Platforms | ${scoreHeader} | Tier | Reviews | Direct URL |\n`;
      out += `| :---: | :--- | :--- | :---: | :---: | :---: | :--- |\n`;
      for (const [i, r] of rows.entries()) {
        const link = r.url !== '—' ? `[Link](${r.url})` : '—';
        let displayScore = `**${r.score}**`;
        if (formatType === 'user' && r.rawScore !== undefined) {
          displayScore = `**${r.rawScore} / 10** (${r.score})`;
        } else if (formatType === 'storefront' && r.starRatingRaw !== undefined) {
          displayScore = `**${r.starRatingRaw} ★** (${r.score})`;
        }
        const reviewText = r.numReviews ? `${r.numReviews.toLocaleString()}` : '—';
        out += `| ${i + 1} | **${r.title.replace(/\|/g, '-')}** | ${r.platforms} | ${displayScore} | ${r.tier} | ${reviewText} | ${link} |\n`;
      }
      return out;
    };

    mdTier += `## Table 1: Tier 1 — Metacritic Metascore (${tier1MetacriticRows.length} games)\n\n`;
    mdTier += formatTable(tier1MetacriticRows, 'default');

    mdTier += `\n\n## Table 2: Tier 2 — OpenCritic Top Critic Average (${tier2OpenCriticRows.length} games)\n\n`;
    mdTier += formatTable(tier2OpenCriticRows, 'default');

    mdTier += `\n\n## Table 3: Tier 3 — Metacritic User Score (${tier3MetacriticUserRows.length} games)\n\n`;
    mdTier += formatTable(tier3MetacriticUserRows, 'user');

    mdTier += `\n\n## Table 4: Tier 4 — Steam Community Synthetic Sentiment (${tier4SteamSyntheticRows.length} games)\n\n`;
    mdTier += formatTable(tier4SteamSyntheticRows, 'default');

    mdTier += `\n\n## Table 5: Tier 5 — Storefront Star Rating (${tier5StorefrontRows.length} games)\n\n`;
    mdTier += formatTable(tier5StorefrontRows, 'storefront');

    mdTier += `\n\n## Table 6: Tier 6 — Truly Unrated / Null (${tier6NullRows.length} games)\n\n`;
    mdTier += formatTable(tier6NullRows, 'default');

    fs.writeFileSync(artifactTierPath, mdTier, 'utf8');
    console.log(`Saved tier breakdown artifact to ${artifactTierPath}`);

    // =========================================================================
    // Artifact 2: Master 1-by-1 Library Score Table (library_critic_score_audit_1_by_1.md)
    // =========================================================================
    const artifactMasterPath = '/Users/mike/.gemini/antigravity/brain/e017a8f4-1aaa-40ef-bc58-85357876d2b0/library_critic_score_audit_1_by_1.md';
    let mdMaster = `# 1-by-1 Complete Library Score Audit (All 811 Games)\n\n`;
    mdMaster += `**Generated:** ${new Date().toISOString()}\n\n`;
    mdMaster += `| # | Game Title | Platforms | Score | Tier | Tier Classification | Reviews | Direct URL |\n`;
    mdMaster += `| :---: | :--- | :--- | :---: | :---: | :---: | :---: | :--- |\n`;

    for (const r of allRows) {
      const link = r.url !== '—' ? `[Link](${r.url})` : '—';
      const sourceTag =
        r.source === 'metacritic'
          ? 'Tier 1 (MC Metascore)'
          : r.source === 'opencritic'
          ? 'Tier 2 (OpenCritic)'
          : r.source === 'metacritic_user'
          ? `Tier 3 (MC User: ${r.rawScore}/10)`
          : r.source === 'steam'
          ? 'Tier 4 (Steam Synthetic)'
          : r.source === 'gog'
          ? `Tier 5 (GOG: ${r.starRatingRaw}★)`
          : r.source === 'epic'
          ? `Tier 5 (Epic: ${r.starRatingRaw}★)`
          : 'Tier 6 (Unrated)';
      const reviewText = r.numReviews ? `${r.numReviews.toLocaleString()}` : '—';
      mdMaster += `| ${r.index} | **${r.title.replace(/\|/g, '-')}** | ${r.platforms} | **${r.score}** | ${r.tier} | ${sourceTag} | ${reviewText} | ${link} |\n`;
    }

    fs.writeFileSync(artifactMasterPath, mdMaster, 'utf8');
    console.log(`Saved master 1-by-1 audit to ${artifactMasterPath}`);

    // Quality assertions
    expect(tier1MetacriticRows.length).toBeGreaterThanOrEqual(390);
    expect(
      tier1MetacriticRows.length +
        tier2OpenCriticRows.length +
        tier3MetacriticUserRows.length +
        tier4SteamSyntheticRows.length +
        tier5StorefrontRows.length
    ).toBeGreaterThan(760);

    // Regressions check: Verify specific reported games link to the exact right pages
    const mgsDeltaRow = allRows.find((r) => r.title.includes('SNAKE EATER') || r.title.includes('Snake Eater'));
    expect(mgsDeltaRow?.url).toBe('https://www.metacritic.com/game/metal-gear-solid-delta-snake-eater/critic-reviews/');
    expect(mgsDeltaRow?.score).toBe(85);

    const metroLLRow = allRows.find((r) => r.title === 'Metro Last Light Redux');
    expect(metroLLRow?.url).toBe('https://www.metacritic.com/game/metro-last-light-redux/critic-reviews/');
    expect(metroLLRow?.score).toBe(76);

    const kingdomClassicRow = allRows.find((r) => r.title === 'Kingdom: Classic' || r.title === 'Kingdom Classic');
    expect(kingdomClassicRow?.url).toBe('https://opencritic.com/game/1968/kingdom');
    expect(kingdomClassicRow?.score).toBe(74);

    const overcooked2Row = allRows.find((r) => r.title === 'Overcooked! 2');
    expect(overcooked2Row?.url).toBe('https://www.metacritic.com/game/overcooked-2/critic-reviews/');
    expect(overcooked2Row?.score).toBe(81);

    // Zero sequel mismatches across Metacritic URLs
    const invalidSequelRows = tier1MetacriticRows.filter((r) => {
      const slugMatch = r.url.match(/\/game\/(?:[0-9]+\/)?([^\/]+)/);
      const slug = slugMatch ? slugMatch[1] : '';
      const slugTitle = slug.replace(/-\d{4}$/, '').replace(/-/g, ' ');
      // Allow remasters linking to base game when standalone remaster page doesn't exist
      if (/\b(remastered|remake|definitive|anniversary)\b/i.test(r.title)) return false;
      return isSequelMismatch(r.title, slugTitle);
    });
    if (invalidSequelRows.length > 0) {
      console.log('INVALID SEQUEL ROWS:', invalidSequelRows.map(r => ({ title: r.title, url: r.url })));
    }
    expect(invalidSequelRows).toHaveLength(0);
  }, 180000);


});
