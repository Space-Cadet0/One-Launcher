// @ts-check
'use strict';

const PRERELEASE_STAGE_ORDER = new Map([
  ['dev', 0],
  ['alpha', 1],
  ['a', 1],
  ['beta', 2],
  ['b', 2],
  ['pre', 3],
  ['preview', 4],
  ['rc', 5],
]);

/**
 * Parse a SemVer 2.0 version string into numeric core parts and pre-release identifiers.
 * Strips leading `v`/`V`, supports `-`, `_`, or whitespace pre-release separators
 * (e.g. `26.0-preview`, `26.0.0-rc1`, `26.0 preview`), and ignores `+build` metadata per SemVer 2.0 §10.
 *
 * @param {unknown} rawVersion
 * @returns {{ core: number[], prerelease: Array<number | string> } | null}
 */
function parseSemver(rawVersion) {
  const cleaned = String(rawVersion ?? '')
    .trim()
    .replace(/^v/i, '');
  if (!cleaned) return null;

  const plusIdx = cleaned.indexOf('+');
  const withoutBuild = (plusIdx >= 0 ? cleaned.slice(0, plusIdx) : cleaned).trim();
  if (!withoutBuild) return null;

  const sepMatch = withoutBuild.match(/^([0-9]+(?:\.[0-9]+)*)(?:[-_\s]+(.+))?$/);
  const dashIdx = withoutBuild.indexOf('-');
  const corePart = sepMatch
    ? sepMatch[1]
    : dashIdx >= 0
      ? withoutBuild.slice(0, dashIdx)
      : withoutBuild;
  const prePart = sepMatch
    ? sepMatch[2] || ''
    : dashIdx >= 0
      ? withoutBuild.slice(dashIdx + 1)
      : '';

  if (!corePart) return null;
  const coreTokens = corePart.split('.');
  /** @type {number[]} */
  const core = [];
  for (const tok of coreTokens) {
    if (!/^\d+$/.test(tok)) {
      const leadingDigits = tok.match(/^(\d+)(?:[-._]?([A-Za-z0-9.-]+))?$/);
      if (!leadingDigits) return null;
      core.push(Number(leadingDigits[1]));
      if (leadingDigits[2] && !prePart) {
        return {
          core,
          prerelease: splitPrereleaseIdentifiers(leadingDigits[2]),
        };
      }
    } else {
      core.push(Number(tok));
    }
  }

  return {
    core,
    prerelease: prePart ? splitPrereleaseIdentifiers(prePart) : [],
  };
}

/**
 * @param {string} rawPre
 * @returns {Array<number | string>}
 */
function splitPrereleaseIdentifiers(rawPre) {
  /** @type {Array<number | string>} */
  const tokens = [];
  for (const rawPart of rawPre.split(/[.\s_-]+/)) {
    if (!rawPart) continue;
    if (/^\d+$/.test(rawPart)) {
      tokens.push(Number(rawPart));
      continue;
    }
    const alphaNumMatch = rawPart.match(/^([A-Za-z]+)(\d+)$/);
    if (alphaNumMatch) {
      tokens.push(alphaNumMatch[1].toLowerCase(), Number(alphaNumMatch[2]));
    } else {
      tokens.push(rawPart);
    }
  }
  return tokens;
}

/**
 * Compare two SemVer 2.0 strings (`verA` vs `verB`).
 * Returns:
 *  - `1` if `verA > verB`
 *  - `-1` if `verA < verB`
 *  - `0` if equal
 *
 * Correctly orders pre-releases before normal releases of the same core version
 * (`26.0-preview < 26.0`, `0.2.0-alpha.1 < 0.2.0-alpha.2 < 0.2.0-beta.1 < 0.2.0-rc1 < 0.2.0`).
 *
 * @param {unknown} verA
 * @param {unknown} verB
 * @returns {-1 | 0 | 1}
 */
function compareSemver(verA, verB) {
  const parsedA = parseSemver(verA);
  const parsedB = parseSemver(verB);

  if (!parsedA && !parsedB) return 0;
  if (!parsedA) return -1;
  if (!parsedB) return 1;

  const maxCoreLen = Math.max(3, parsedA.core.length, parsedB.core.length);
  for (let i = 0; i < maxCoreLen; i++) {
    const numA = parsedA.core[i] ?? 0;
    const numB = parsedB.core[i] ?? 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }

  const preA = parsedA.prerelease;
  const preB = parsedB.prerelease;
  if (preA.length === 0 && preB.length === 0) return 0;
  // Normal version has higher precedence than a pre-release version (SemVer 2.0 §11.3)
  if (preA.length === 0 && preB.length > 0) return 1;
  if (preA.length > 0 && preB.length === 0) return -1;

  const minPreLen = Math.min(preA.length, preB.length);
  for (let i = 0; i < minPreLen; i++) {
    const idA = preA[i];
    const idB = preB[i];
    if (idA === idB) continue;

    const aIsNum = typeof idA === 'number';
    const bIsNum = typeof idB === 'number';
    if (aIsNum && bIsNum) {
      return idA > idB ? 1 : -1;
    }
    // Numeric identifiers always have lower precedence than non-numeric identifiers (SemVer 2.0 §11.4.1)
    if (aIsNum && !bIsNum) return -1;
    if (!aIsNum && bIsNum) return 1;

    const lowerA = String(idA).toLowerCase();
    const lowerB = String(idB).toLowerCase();
    if (lowerA === lowerB) continue;

    const stageA = PRERELEASE_STAGE_ORDER.get(lowerA);
    const stageB = PRERELEASE_STAGE_ORDER.get(lowerB);
    if (stageA !== undefined && stageB !== undefined && stageA !== stageB) {
      return stageA > stageB ? 1 : -1;
    }

    return String(idA) > String(idB) ? 1 : -1;
  }

  if (preA.length > preB.length) return 1;
  if (preA.length < preB.length) return -1;
  return 0;
}

module.exports = {
  parseSemver,
  compareSemver,
};
