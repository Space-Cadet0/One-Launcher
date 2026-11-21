// @ts-check
'use strict';

/**
 * Canonical release-stage ordering for recognized pre-release tokens.
 * Combined with total-order class bucketing (`numeric < custom_ident < known_stage`),
 * this guarantees strict weak ordering (irreflexive, asymmetric, transitive, transitive equivalence)
 * across arbitrary combinations of numeric, mixed-case, custom, and staged pre-release identifiers.
 */
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
 * @typedef {{
 *   kind: 'num',
 *   big: bigint,
 *   raw: string,
 * } | {
 *   kind: 'str',
 *   bucket: 1 | 2,
 *   stage: number,
 *   lower: string,
 *   raw: string,
 * }} CanonicalPrereleaseToken
 */

/**
 * @typedef {{
 *   core: number[],
 *   coreBig: bigint[],
 *   prerelease: Array<number | string>,
 *   prereleaseCanonical: CanonicalPrereleaseToken[],
 * }} ParsedSemverInternal
 */

/**
 * @param {string} digits
 * @returns {CanonicalPrereleaseToken}
 */
function makeNumericPrereleaseToken(digits) {
  return {
    kind: 'num',
    big: BigInt(digits),
    raw: digits,
  };
}

/**
 * @param {string} raw
 * @returns {CanonicalPrereleaseToken}
 */
function makeStringPrereleaseToken(raw) {
  const lower = raw.toLowerCase();
  const stage = PRERELEASE_STAGE_ORDER.get(lower);
  if (stage !== undefined) {
    return { kind: 'str', bucket: 2, stage, lower, raw };
  }
  return { kind: 'str', bucket: 1, stage: 0, lower, raw };
}

/**
 * @param {string} rawPre
 * @returns {{ publicTokens: Array<number | string>, canonicalTokens: CanonicalPrereleaseToken[] }}
 */
function splitPrereleaseIdentifiersInternal(rawPre) {
  /** @type {Array<number | string>} */
  const publicTokens = [];
  /** @type {CanonicalPrereleaseToken[]} */
  const canonicalTokens = [];
  for (const rawPart of rawPre.split(/[.\s_-]+/)) {
    if (!rawPart) continue;
    if (/^\d+$/.test(rawPart)) {
      publicTokens.push(Number(rawPart));
      canonicalTokens.push(makeNumericPrereleaseToken(rawPart));
      continue;
    }
    const alphaNumMatch = rawPart.match(/^([A-Za-z]+)(\d+)$/);
    if (alphaNumMatch) {
      const alphaLower = alphaNumMatch[1].toLowerCase();
      publicTokens.push(alphaLower, Number(alphaNumMatch[2]));
      canonicalTokens.push(
        makeStringPrereleaseToken(alphaLower),
        makeNumericPrereleaseToken(alphaNumMatch[2])
      );
    } else {
      publicTokens.push(rawPart);
      canonicalTokens.push(makeStringPrereleaseToken(rawPart));
    }
  }
  return { publicTokens, canonicalTokens };
}

/**
 * @param {unknown} rawVersion
 * @returns {ParsedSemverInternal | null}
 */
function parseSemverInternal(rawVersion) {
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
  /** @type {bigint[]} */
  const coreBig = [];

  for (const tok of coreTokens) {
    if (!/^\d+$/.test(tok)) {
      const leadingDigits = tok.match(/^(\d+)(?:[-._]?([A-Za-z0-9.-]+))?$/);
      if (!leadingDigits) return null;
      core.push(Number(leadingDigits[1]));
      coreBig.push(BigInt(leadingDigits[1]));
      if (leadingDigits[2] && !prePart) {
        const pre = splitPrereleaseIdentifiersInternal(leadingDigits[2]);
        return {
          core,
          coreBig,
          prerelease: pre.publicTokens,
          prereleaseCanonical: pre.canonicalTokens,
        };
      }
    } else {
      core.push(Number(tok));
      coreBig.push(BigInt(tok));
    }
  }

  const pre = prePart
    ? splitPrereleaseIdentifiersInternal(prePart)
    : { publicTokens: [], canonicalTokens: [] };

  return {
    core,
    coreBig,
    prerelease: pre.publicTokens,
    prereleaseCanonical: pre.canonicalTokens,
  };
}

/**
 * Parse a SemVer 2.0 version string into numeric core parts and pre-release identifiers.
 * Strips leading `v`/`V`, supports `-`, `_`, or whitespace pre-release separators
 * (e.g. `26.0-preview`, `26.0.0-rc1`, `26.0 preview`), and ignores `+build` metadata per SemVer 2.0 §10.
 *
 * @param {unknown} rawVersion
 * @returns {{ core: number[], prerelease: Array<number | string> } | null}
 */
function parseSemver(rawVersion) {
  const parsed = parseSemverInternal(rawVersion);
  if (!parsed) return null;
  return {
    core: parsed.core,
    prerelease: parsed.prerelease,
  };
}

/**
 * Strict total-order comparator for two canonical pre-release tokens.
 * Order: numeric (`BigInt`) < custom non-numeric (`lower`) < known release stages (`stage`, `lower`).
 *
 * @param {CanonicalPrereleaseToken} tokA
 * @param {CanonicalPrereleaseToken} tokB
 * @returns {-1 | 0 | 1}
 */
function compareCanonicalPrereleaseTokens(tokA, tokB) {
  if (tokA.kind === 'num' && tokB.kind === 'num') {
    if (tokA.big > tokB.big) return 1;
    if (tokA.big < tokB.big) return -1;
    return 0;
  }
  // Numeric identifiers always have lower precedence than non-numeric identifiers (SemVer 2.0 §11.4.4)
  if (tokA.kind === 'num' && tokB.kind === 'str') return -1;
  if (tokA.kind === 'str' && tokB.kind === 'num') return 1;

  if (tokA.kind === 'str' && tokB.kind === 'str') {
    if (tokA.bucket !== tokB.bucket) {
      return tokA.bucket > tokB.bucket ? 1 : -1;
    }
    if (tokA.stage !== tokB.stage) {
      return tokA.stage > tokB.stage ? 1 : -1;
    }
    if (tokA.lower === tokB.lower) return 0;
    return tokA.lower > tokB.lower ? 1 : -1;
  }
  return 0;
}

/**
 * Compare two SemVer 2.0 strings (`verA` vs `verB`).
 * Returns:
 *  - `1` if `verA > verB`
 *  - `-1` if `verA < verB`
 *  - `0` if equal
 *
 * Satisfies strict weak ordering (safe for `.sort(compareSemver)`) and uses `BigInt`
 * comparison for arbitrarily large numeric core and pre-release identifiers.
 *
 * @param {unknown} verA
 * @param {unknown} verB
 * @returns {-1 | 0 | 1}
 */
function compareSemver(verA, verB) {
  const parsedA = parseSemverInternal(verA);
  const parsedB = parseSemverInternal(verB);

  if (!parsedA && !parsedB) return 0;
  if (!parsedA) return -1;
  if (!parsedB) return 1;

  const maxCoreLen = Math.max(3, parsedA.coreBig.length, parsedB.coreBig.length);
  for (let i = 0; i < maxCoreLen; i++) {
    const numA = parsedA.coreBig[i] ?? 0n;
    const numB = parsedB.coreBig[i] ?? 0n;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }

  const preA = parsedA.prereleaseCanonical;
  const preB = parsedB.prereleaseCanonical;
  if (preA.length === 0 && preB.length === 0) return 0;
  // Normal version has higher precedence than a pre-release version (SemVer 2.0 §11.3)
  if (preA.length === 0 && preB.length > 0) return 1;
  if (preA.length > 0 && preB.length === 0) return -1;

  const minPreLen = Math.min(preA.length, preB.length);
  for (let i = 0; i < minPreLen; i++) {
    const cmp = compareCanonicalPrereleaseTokens(preA[i], preB[i]);
    if (cmp !== 0) return cmp;
  }

  if (preA.length > preB.length) return 1;
  if (preA.length < preB.length) return -1;
  return 0;
}

module.exports = {
  parseSemver,
  compareSemver,
};
