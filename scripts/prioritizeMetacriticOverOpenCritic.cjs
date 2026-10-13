const fs = require('fs');
const path = require('path');

function toCanonicalMetacriticSlug(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/['’]/g, '')
    .replace(/\s*\(\d{4}\)|\s*\b\d{4}\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function generateMetacriticSlugCandidates(title) {
  const base = toCanonicalMetacriticSlug(title);
  if (!base) return [];

  const candidates = [base];

  if (base.includes('-ii-')) candidates.push(base.replace(/-ii-/g, '-2-'));
  if (base.endsWith('-ii')) candidates.push(base.replace(/-ii$/, '-2'));
  if (base.includes('-iii-')) candidates.push(base.replace(/-iii-/g, '-3-'));
  if (base.endsWith('-iii')) candidates.push(base.replace(/-iii$/, '-3'));
  if (base.includes('-iv-')) candidates.push(base.replace(/-iv-/g, '-4-'));
  if (base.endsWith('-iv')) candidates.push(base.replace(/-iv$/, '-4'));

  if (base.includes('-2-')) candidates.push(base.replace(/-2-/g, '-ii-'));
  if (base.endsWith('-2')) candidates.push(base.replace(/-2$/, '-ii'));
  if (base.includes('-3-')) candidates.push(base.replace(/-3-/g, '-iii-'));
  if (base.endsWith('-3')) candidates.push(base.replace(/-3$/, '-iii'));

  const yearMatch = title.match(/\b(19\d\d|20\d\d)\b/);
  if (yearMatch && !base.endsWith(yearMatch[1])) {
    candidates.push(`${base}-${yearMatch[1]}`);
  }

  const strippedEdition = base
    .replace(/-(definitive-edition|enhanced-edition|remastered|goty|game-of-the-year-edition|complete-edition|deluxe-edition|director-s-cut)$/i, '')
    .trim();
  if (strippedEdition && strippedEdition !== base) {
    candidates.push(strippedEdition);
    if (strippedEdition.includes('-2-')) candidates.push(strippedEdition.replace(/-2-/g, '-ii-'));
    if (strippedEdition.endsWith('-2')) candidates.push(strippedEdition.replace(/-2$/, '-ii'));
  }

  if (title.includes(':') || title.includes(' - ')) {
    const mainTitle = title.split(/[:\-]/)[0].trim();
    const mainSlug = toCanonicalMetacriticSlug(mainTitle);
    if (mainSlug && mainSlug !== base && mainSlug.length > 2) {
      candidates.push(mainSlug);
      if (mainSlug.includes('-2-')) candidates.push(mainSlug.replace(/-2-/g, '-ii-'));
      if (mainSlug.endsWith('-2')) candidates.push(mainSlug.replace(/-2$/, '-ii'));
    }
  }

  return Array.from(new Set(candidates));
}

function calculateTier(score) {
  if (score >= 84) return 'Mighty';
  if (score >= 74) return 'Strong';
  if (score >= 66) return 'Fair';
  return 'Weak';
}

function isSequelMismatch(query, candidateName) {
  const qTokens = query.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);
  const cTokens = candidateName.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);

  const numerals = new Set(['2', '3', '4', '5', '6', '7', '8', '9', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'new', 'vr']);

  for (const num of numerals) {
    const qHas = qTokens.includes(num);
    const cHas = cTokens.includes(num);
    if (!qHas && cHas) return true;
    if (qHas && !cHas) return true;
  }
  return false;
}

async function fetchMetacritic(slug, originalTitle) {
  const url = `https://www.metacritic.com/game/${slug}/`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (!jsonLdMatch) return null;

    const jsonLd = JSON.parse(jsonLdMatch[1]);
    const canonicalName = jsonLd.name || '';
    if (canonicalName && isSequelMismatch(originalTitle, canonicalName)) {
      return null;
    }

    const rating = jsonLd.aggregateRating;
    if (
      rating &&
      typeof rating.ratingValue === 'number' &&
      rating.ratingValue > 0 &&
      typeof rating.reviewCount === 'number' &&
      rating.reviewCount >= 4
    ) {
      const score = Math.round(rating.ratingValue);
      return {
        id: `mc-${slug}`,
        source: 'metacritic',
        score,
        tier: calculateTier(score),
        numReviews: rating.reviewCount,
        url: `https://www.metacritic.com/game/${slug}/critic-reviews/`,
        summary: jsonLd.description || `Metacritic consensus score based on ${rating.reviewCount} critic reviews.`,
        isVerified: true,
      };
    }
  } catch (e) {
    // ignore
  }
  return null;
}

async function resolveMetacriticForTitle(title) {
  const slugs = generateMetacriticSlugCandidates(title);
  for (const slug of slugs) {
    const res = await fetchMetacritic(slug, title);
    if (res) return res;
  }
  return null;
}

async function main() {
  const knownCriticPath = path.join(__dirname, '../src/services/critic/knownCriticScores.ts');
  const content = fs.readFileSync(knownCriticPath, 'utf8');
  const jsonMatch = content.match(/export const KNOWN_CRITIC_SCORES:[^=]*=\s*({[\s\S]*});\s*$/);
  const unratedMatch = content.match(/export const KNOWN_UNRATED_TITLES = new Set<string>\(\[([\s\S]*?)\]\);/);

  const entries = JSON.parse(jsonMatch[1]);

  // Group keys by unique OpenCritic URL
  const ocUrlToKeys = new Map();
  const ocUrlToTitle = new Map();

  for (const [k, v] of Object.entries(entries)) {
    if (v.source === 'opencritic' && v.url) {
      if (!ocUrlToKeys.has(v.url)) {
        ocUrlToKeys.set(v.url, []);
      }
      ocUrlToKeys.get(v.url).push(k);

      // Guess representative title from string key
      if (typeof k === 'string' && isNaN(Number(k)) && !ocUrlToTitle.has(v.url)) {
        ocUrlToTitle.set(v.url, k);
      }
    }
  }

  console.log(`Found ${ocUrlToKeys.size} unique OpenCritic games to evaluate for Metacritic priority.`);

  let upgradedCount = 0;
  let remainingOpenCriticCount = 0;
  const urls = Array.from(ocUrlToKeys.keys());
  const batchSize = 10;

  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (url) => {
        const title = ocUrlToTitle.get(url) || url.split('/').pop().replace(/-/g, ' ');
        const mc = await resolveMetacriticForTitle(title);
        if (mc) {
          upgradedCount++;
          // Update all keys pointing to this game
          const keys = ocUrlToKeys.get(url);
          for (const k of keys) {
            entries[k] = mc;
          }
        } else {
          remainingOpenCriticCount++;
        }
      })
    );
    if ((i + batchSize) % 50 === 0 || i + batchSize >= urls.length) {
      console.log(`Progress: ${Math.min(i + batchSize, urls.length)}/${urls.length} games processed. Upgraded to Metacritic: ${upgradedCount}, Retained OpenCritic: ${remainingOpenCriticCount}`);
    }
  }

  console.log(`\n--- METACRITIC PRIORITY RECONCILIATION COMPLETE ---`);
  console.log(`Total Upgraded to Metacritic: ${upgradedCount}`);
  console.log(`Retained OpenCritic Fallback: ${remainingOpenCriticCount}`);

  // Re-write knownCriticScores.ts
  const newCode = `import { CriticScoreData } from '../../contracts/critic';

/**
 * Titles explicitly verified to have NO critic consensus on either Metacritic or OpenCritic.
 * These strictly return null (zero fabrication).
 */
export const KNOWN_UNRATED_TITLES = new Set<string>([${unratedMatch[1]}]);

/**
 * Master catalog of verified Metacritic (primary) and OpenCritic (secondary fallback) scores.
 * Keyed by Steam AppID (number) and normalized title keys (string).
 */
export const KNOWN_CRITIC_SCORES: Record<string | number, CriticScoreData> = ${JSON.stringify(
    entries,
    null,
    2
  )};
`;

  fs.writeFileSync(knownCriticPath, newCode, 'utf8');
  console.log(`Successfully updated knownCriticScores.ts with Metacritic as Priority 1.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
