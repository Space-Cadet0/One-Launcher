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

  if (/-\d+$/.test(base)) candidates.push(base.replace(/-(\d+)$/, '$1'));
  if (/-\d+-/.test(base)) candidates.push(base.replace(/-(\d+)-/g, '$1-'));

  if (base.startsWith('the-')) candidates.push(base.replace(/^the-/, ''));
  else candidates.push(`the-${base}`);

  if (title.includes(':') || title.includes(' - ')) {
    const mainTitle = title.split(/[:\-]/)[0].trim();
    if (mainTitle.length >= 3) {
      const mainSlug = toCanonicalMetacriticSlug(mainTitle);
      if (mainSlug && mainSlug !== base) candidates.push(mainSlug);
    }
  }

  const stripped = base.replace(
    /-(definitive|enhanced|anniversary|directors-cut|goty|game-of-the-year|remastered|remake)(-edition)?$/i,
    ''
  );
  if (stripped && stripped !== base) {
    candidates.push(stripped);
    if (/-\d+$/.test(stripped)) candidates.push(stripped.replace(/-(\d+)$/, '$1'));
  }

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

  return Array.from(new Set(candidates));
}

function calculateTier(score) {
  if (score >= 84) return 'Mighty';
  if (score >= 74) return 'Strong';
  if (score >= 66) return 'Fair';
  return 'Weak';
}

function isSequelMismatch(query, candidateName) {
  const norm = (str) => str.toLowerCase().replace(/([a-z])(\d)/g, '$1 $2').replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);
  const qTokens = norm(query);
  const cTokens = norm(candidateName);

  const numerals = new Set(['2', '3', '4', '5', '6', '7', '8', '9', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii']);
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
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    let criticData = null;
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try {
        const jsonLd = JSON.parse(jsonLdMatch[1]);
        const canonicalName = jsonLd.name || '';
        if (!canonicalName || !isSequelMismatch(originalTitle, canonicalName)) {
          const rating = jsonLd.aggregateRating;
          if (rating && typeof rating.ratingValue === 'number' && rating.ratingValue > 0 && typeof rating.reviewCount === 'number' && rating.reviewCount >= 4) {
            const score = Math.round(rating.ratingValue);
            criticData = {
              id: `mc-${slug}`,
              source: 'metacritic',
              score,
              tier: calculateTier(score),
              numReviews: rating.reviewCount,
              url: `https://www.metacritic.com/game/${slug}/critic-reviews/`,
              summary: jsonLd.description || `Metacritic consensus score based on ${rating.reviewCount} critic reviews.`,
              isVerified: true,
              isSynthetic: false,
            };
          }
        }
      } catch {}
    }

    let userData = null;
    const userScoreMatch =
      html.match(/(?:title|aria-label)=["']User score ([0-9.]+) out of 10["']/i) ||
      html.match(/c-siteReviewScore_user[^\"]*\"[^>]*><span>([0-9.]+)<\/span>/i);
    const userCountMatch =
      html.match(/(?:Based on|based on)\s+([0-9,]+)\s+(?:User Reviews|Ratings)/i) ||
      html.match(/([0-9,]+)\s+User Reviews/i);

    if (userScoreMatch && userScoreMatch[1]) {
      const rawScore = parseFloat(userScoreMatch[1]);
      const rawCount = userCountMatch && userCountMatch[1] ? parseInt(userCountMatch[1].replace(/,/g, ''), 10) : 0;
      if (!isNaN(rawScore) && rawScore > 0 && rawScore <= 10 && rawCount >= 4) {
        const normalizedScore = Math.round(rawScore * 10);
        userData = {
          id: `mc-user-${slug}`,
          source: 'metacritic_user',
          score: normalizedScore,
          userScoreRaw: rawScore,
          tier: calculateTier(normalizedScore),
          numReviews: rawCount,
          url: `https://www.metacritic.com/game/${slug}/`,
          summary: `Metacritic user score (${rawScore}/10 based on ${rawCount} user reviews).`,
          isVerified: false,
          isSynthetic: false,
        };
      }
    }

    return { critic: criticData, user: userData };
  } catch {
    return null;
  }
}

async function resolveMetacriticForTitle(title) {
  const slugs = generateMetacriticSlugCandidates(title);
  let fallbackUser = null;
  for (const slug of slugs) {
    const res = await fetchMetacritic(slug, title);
    if (res?.critic) return res.critic;
    if (res?.user && !fallbackUser) fallbackUser = res.user;
  }
  return fallbackUser;
}

async function main() {
  const knownCriticPath = path.join(__dirname, '../src/services/critic/knownCriticScores.ts');
  const content = fs.readFileSync(knownCriticPath, 'utf8');
  const jsonMatch = content.match(/export const KNOWN_CRITIC_SCORES:[^=]*=\s*({[\s\S]*});\s*$/);
  const unratedMatch = content.match(/export const KNOWN_UNRATED_TITLES = new Set<string>\(\[([\s\S]*?)\]\);/);

  const entries = JSON.parse(jsonMatch[1]);

  // Group by OpenCritic URL
  const ocUrlToKeys = new Map();
  const ocUrlToTitle = new Map();

  for (const [k, v] of Object.entries(entries)) {
    if (v.source === 'opencritic' && v.url) {
      if (!ocUrlToKeys.has(v.url)) {
        ocUrlToKeys.set(v.url, []);
      }
      ocUrlToKeys.get(v.url).push(k);

      if (typeof k === 'string' && isNaN(Number(k)) && !ocUrlToTitle.has(v.url)) {
        ocUrlToTitle.set(v.url, k);
      }
    }
  }

  console.log(`Found ${ocUrlToKeys.size} unique OpenCritic games to evaluate for Metacritic.`);

  let upgradedCritic = 0;
  let upgradedUser = 0;
  let retainedOc = 0;
  const urls = Array.from(ocUrlToKeys.keys());
  const batchSize = 6;

  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (url) => {
        let title = ocUrlToTitle.get(url);
        if (!title) {
          const parts = url.split('/');
          const slugPart = parts[parts.length - 1] || parts[parts.length - 2];
          title = slugPart.replace(/-/g, ' ');
        }

        const match = await resolveMetacriticForTitle(title);
        const keys = ocUrlToKeys.get(url);
        if (match && match.source === 'metacritic') {
          upgradedCritic++;
          for (const k of keys) entries[k] = match;
        } else if (match && match.source === 'metacritic_user') {
          // If OpenCritic was available with verified critic reviews, OpenCritic (Tier 2) beats Metacritic User (Tier 3)!
          // But if OpenCritic was < 4 reviews, Metacritic user can be used. Usually Tier 2 critic > Tier 3 user.
          // Keep OpenCritic critic consensus if OpenCritic has verified reviews
          const currentEntry = entries[keys[0]];
          if (currentEntry && currentEntry.numReviews >= 4) {
            retainedOc++;
          } else {
            upgradedUser++;
            for (const k of keys) entries[k] = match;
          }
        } else {
          retainedOc++;
        }
      })
    );
    console.log(`Processed ${Math.min(i + batchSize, urls.length)}/${urls.length}. Upgraded to MC Critic: ${upgradedCritic}, MC User: ${upgradedUser}, Retained OC: ${retainedOc}`);
  }

  console.log('\n--- UPGRADE COMPLETE ---');
  console.log(`Upgraded to Tier 1 Metacritic: ${upgradedCritic}`);
  console.log(`Upgraded to Tier 3 Metacritic User: ${upgradedUser}`);
  console.log(`Retained Tier 2 OpenCritic: ${retainedOc}`);

  const sortedKeys = Object.keys(entries).sort((a, b) => {
    const numA = Number(a);
    const numB = Number(b);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    if (!isNaN(numA)) return -1;
    if (!isNaN(numB)) return 1;
    return a.localeCompare(b);
  });

  const sortedDb = {};
  for (const k of sortedKeys) {
    sortedDb[k] = entries[k];
  }

  const newCode = `import { CriticScoreData } from '../../contracts/critic';

/**
 * Titles explicitly verified to have NO critic consensus on Metacritic or OpenCritic.
 * These strictly return null (zero fabrication).
 */
export const KNOWN_UNRATED_TITLES = new Set<string>([${unratedMatch[1]}]);

/**
 * Clean Unpoisoned Master Dataset of Critic and User Scores.
 * 5-Tier Hierarchy:
 * Tier 1: Metacritic Metascore (Critic consensus, >= 4 reviews)
 * Tier 2: OpenCritic Top Critic Average (Critic consensus, >= 4 reviews)
 * Tier 3: Metacritic User Score (Player consensus, >= 4 user reviews)
 * Tier 4: Steam Community Sentiment (Calibrated synthetic score)
 * Tier 5: Null / Unrated
 */
export const KNOWN_CRITIC_SCORES: Record<string | number, CriticScoreData> = ${JSON.stringify(sortedDb, null, 2)};
`;

  fs.writeFileSync(knownCriticPath, newCode, 'utf8');
  console.log(`Saved pristine master database to ${knownCriticPath}`);
}

main().catch(console.error);
