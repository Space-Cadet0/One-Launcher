// @ts-check
'use strict';

/**
 * Xbox Ticket Normalization & P0-01 Fail-Closed NSAL URL->Relying-Party Router
 * (`xboxTicketAndNsalRouter.cjs`):
 * - 5-segment Compact JWE detection and Store / XBL RPS ticket normalization
 * - Strict fail-closed NSAL URL validation (`https:` only, default port 443 only, no credentials,
 *   no raw IP literals, no catch-all `*` wildcards, ZERO default `http://xboxlive.com` fallback
 *   on arbitrary or unrecognized hosts!)
 */

const net = require('node:net');
const { XSTS_RELYING_PARTIES } = require('./xboxAuthConstantsAndUrl.cjs');

// ============================================================================
// 1. Ticket Normalization (`d=` / `t=` / 5-Segment Compact JWE)
// ============================================================================

/**
 * @param {string} seg
 * @returns {boolean}
 */
function isValidBase64UrlSegment(seg) {
  if (typeof seg !== 'string' || seg.length % 4 === 1) return false;
  return /^[A-Za-z0-9_-]*$/.test(seg);
}

/**
 * Empirically verified 5-segment Compact JWE detector (`header.encryptedKey.iv.ciphertext.tag`).
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isCompactJwe(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const parts = candidate.split('.');
  if (parts.length !== 5) return false;
  const [headerB64, encKeyB64, ivB64, cipherB64, tagB64] = parts;
  if (!headerB64 || headerB64.length > 8192 || !ivB64 || !cipherB64 || !tagB64) {
    return false;
  }
  if (
    !isValidBase64UrlSegment(headerB64) ||
    !isValidBase64UrlSegment(encKeyB64) ||
    !isValidBase64UrlSegment(ivB64) ||
    !isValidBase64UrlSegment(cipherB64) ||
    !isValidBase64UrlSegment(tagB64)
  ) {
    return false;
  }
  try {
    const decoded = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    return Boolean(
      decoded &&
        typeof decoded === 'object' &&
        !Array.isArray(decoded) &&
        typeof decoded.alg === 'string' &&
        decoded.alg.length > 0 &&
        typeof decoded.enc === 'string' &&
        decoded.enc.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Normalizes a Microsoft Store MSA ticket across `licensing.mp.microsoft.com`, `PCGAFD`, and `collections.mp.microsoft.com`.
 *
 * @param {string} rawTicket
 * @param {{ target?: 'licensing' | 'pcgafd' | 'store' | 'collections' | 'collections_bare' } | string} [options]
 * @returns {string}
 */
function normalizeStoreMsaTicket(rawTicket, options = {}) {
  const trimmed = String(rawTicket || '').trim();
  if (!trimmed) return '';
  const target = typeof options === 'string' ? options : options?.target || 'licensing';

  // Preserve `XBL3.0 x=<uhs>;<jwt>` verbatim for PCGAFD/Store queries, and never forward XBL3.0/Bearer to MSA-only endpoints
  if (/^(?:xbl3\.0|bearer)\s+/i.test(trimmed)) {
    return target === 'pcgafd' || target === 'store' ? trimmed : '';
  }

  const unwrapped = trimmed
    .replace(/^WLID1\.0=/i, '')
    .replace(/^["']+|["']+$/g, '')
    .trim();
  const bare = unwrapped.replace(/^[td]=/i, '').trim();
  if (!bare) return '';

  if (target === 'collections') {
    return `WLID1.0="${bare}"`;
  }
  if (target === 'collections_bare') {
    return bare;
  }
  if (target === 'pcgafd' || target === 'store') {
    return `t=${bare}`;
  }
  if (isCompactJwe(bare)) {
    return bare;
  }
  return `t=${bare}`;
}

/**
 * Normalizes an Xbox Live RPS ticket for `POST https://user.auth.xboxlive.com/user/authenticate`.
 *
 * @param {string} rawTicket
 * @param {{ defaultPrefix?: 't=' | 'd=' }} [options]
 * @returns {string}
 */
function normalizeXblRpsTicket(rawTicket, options = {}) {
  const trimmed = String(rawTicket || '').trim();
  if (!trimmed) return '';
  const bare = trimmed.replace(/^[td]=/i, '').trim();
  if (!bare) return '';
  if (isCompactJwe(bare)) {
    return `t=${bare}`;
  }
  if (/^[td]=/i.test(trimmed)) {
    return `${trimmed[0].toLowerCase()}=${bare}`;
  }
  const prefix = options.defaultPrefix || 't=';
  return `${prefix}${bare}`;
}

/**
 * @param {string} rawTicket
 */
function formatStoreAuthTickets(rawTicket) {
  return {
    pcgafdTicket: normalizeStoreMsaTicket(rawTicket, { target: 'pcgafd' }),
    licensingTicket: normalizeStoreMsaTicket(rawTicket, { target: 'licensing' }),
    collectionsTicket: normalizeStoreMsaTicket(rawTicket, { target: 'collections' }),
    collectionsBareTicket: normalizeStoreMsaTicket(rawTicket, { target: 'collections_bare' }),
  };
}

// ============================================================================
// 2. P0-01 Fail-Closed NSAL URL -> Relying Party Matcher
// ============================================================================

/**
 * Strictly parses an outbound target URL eligible for Xbox XSTS + ECDSA signature minting.
 * Enforces:
 * - `https:` protocol ONLY (rejects plaintext `http:`, `rp:`, `file:`, etc.)
 * - Default HTTPS port 443 ONLY (rejects any explicit non-default port)
 * - No URL userinfo (`username`/`password`)
 * - Valid non-empty DNS hostname (rejects raw IPv4/IPv6 literals and localhost)
 *
 * @param {string} targetUrl
 * @returns {URL | null}
 */
function parseStrictNsalHttpsUrl(targetUrl) {
  if (typeof targetUrl !== 'string') return null;
  const trimmed = targetUrl.trim();
  if (!trimmed) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  if (parsed.port && parsed.port !== '443') {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    return null;
  }
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (net.isIP(bareHost) !== 0) {
    return null;
  }
  return parsed;
}

/**
 * @param {URL | null} parsedUrl
 * @returns {boolean}
 */
function isTitleStorageHostname(parsedUrl) {
  if (!parsedUrl) return false;
  const host = parsedUrl.hostname.toLowerCase();
  return host === 'titlestorage.xboxlive.com' || host.endsWith('.titlestorage.xboxlive.com');
}

/**
 * Matches a concrete DNS hostname against an NSAL host pattern (`fqdn` or `*.domain.tld`).
 * Fails closed against catch-all `*` wildcards, single-label wildcards (`*.com`), and embedded wildcards.
 *
 * @param {string} patternHost
 * @param {string} actualHost
 * @returns {boolean}
 */
function matchWildcardHost(patternHost, actualHost) {
  const p = String(patternHost || '').toLowerCase().trim();
  const h = String(actualHost || '').toLowerCase().trim();
  if (!p || !h || p === '*') return false;
  if (p.startsWith('*.')) {
    const baseDomain = p.slice(2);
    // Require at least two labels in the wildcard base domain (e.g. `xboxlive.com`, `publisher-services.example`)
    // and disallow extra wildcard chars or leading/trailing dots.
    if (
      !baseDomain ||
      baseDomain.includes('*') ||
      baseDomain.startsWith('.') ||
      baseDomain.endsWith('.') ||
      !baseDomain.includes('.')
    ) {
      return false;
    }
    const suffix = `.${baseDomain}`;
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  if (p.includes('*')) {
    return false;
  }
  return p === h;
}

/**
 * Exact first-party Xbox infrastructure hosts whose Relying Party never varies by title NSAL.
 * Fails closed (`null`) on any non-`https:`, non-default-port, or unrecognized URL.
 *
 * @param {string} targetUrl
 * @returns {string | null}
 */
function resolvePreNsalBuiltInRelyingPartyForUrl(targetUrl) {
  const parsed = parseStrictNsalHttpsUrl(targetUrl);
  if (!parsed) return null;

  const host = parsed.hostname.toLowerCase();
  if (host === 'packagespc.xboxlive.com' || host === 'update.xboxlive.com') {
    return XSTS_RELYING_PARTIES.UPDATE_XBL;
  }
  if (host === 'licensing.xboxlive.com') {
    return XSTS_RELYING_PARTIES.LICENSING_XBL;
  }
  if (host === 'licensing.mp.microsoft.com') {
    return XSTS_RELYING_PARTIES.LICENSING_MP;
  }
  if (isTitleStorageHostname(parsed)) {
    return XSTS_RELYING_PARTIES.XBOX_LIVE;
  }
  return null;
}

/**
 * Post-NSAL built-in SDK Relying Party rules (applied ONLY when neither per-title NSAL nor
 * system default NSAL matched a specific Relying Party).
 * Fails closed (`null`) on any non-`https:`, non-default-port, or unrecognized host.
 *
 * @param {string} targetUrl
 * @returns {string | null}
 */
function resolvePostNsalFallbackRelyingPartyForUrl(targetUrl) {
  const parsed = parseStrictNsalHttpsUrl(targetUrl);
  if (!parsed) return null;

  const host = parsed.hostname.toLowerCase();
  if (host === 'playfabapi.com' || host.endsWith('.playfabapi.com')) {
    return XSTS_RELYING_PARTIES.PLAYFAB;
  }
  if (host === 'api.minecraftservices.com' || host.endsWith('.minecraftservices.com')) {
    return XSTS_RELYING_PARTIES.MINECRAFT;
  }
  if (host === 'mp.microsoft.com' || host.endsWith('.mp.microsoft.com')) {
    return XSTS_RELYING_PARTIES.MS_STORE;
  }
  if (
    host === 'xboxlive.com' ||
    host.endsWith('.xboxlive.com') ||
    host === 'xboxservices.com' ||
    host.endsWith('.xboxservices.com')
  ) {
    return XSTS_RELYING_PARTIES.XBOX_LIVE;
  }
  return null;
}

/**
 * Resolves built-in Xbox/Microsoft/PlayFab/TitleStorage relying-party mappings for `targetUrl`.
 * Returns `null` for non-`https:`, non-default port, or unrecognized hosts (fail-closed).
 *
 * @param {string} targetUrl
 * @returns {string | null}
 */
function resolveBuiltInRelyingPartyForUrl(targetUrl) {
  return (
    resolvePreNsalBuiltInRelyingPartyForUrl(targetUrl) ||
    resolvePostNsalFallbackRelyingPartyForUrl(targetUrl)
  );
}

/**
 * Matches an `https:` default-port `targetUrl` against signed NSAL endpoint rules from
 * `title.mgt.xboxlive.com`. Rejects non-`https:` URLs, non-default ports, `http` downgrade rules,
 * and wildcard `*` catch-all rules.
 *
 * @param {string} targetUrl
 * @param {Array<Record<string, any>>} [endPoints]
 * @returns {string | null}
 */
function matchDynamicTitleEndpointRelyingParty(targetUrl, endPoints = []) {
  if (!Array.isArray(endPoints) || endPoints.length === 0) return null;
  const parsed = parseStrictNsalHttpsUrl(targetUrl);
  if (!parsed) return null;

  const host = parsed.hostname.toLowerCase();
  const pathStr = parsed.pathname || '/';

  for (const ep of endPoints) {
    if (!ep || typeof ep.RelyingParty !== 'string') continue;
    const rp = ep.RelyingParty.trim();
    if (!rp || !/^(?:https?|rp):\/\//i.test(rp)) continue;
    if (ep.Protocol && String(ep.Protocol).toLowerCase() !== 'https') continue;
    if (ep.Port !== undefined && ep.Port !== null && Number(ep.Port) > 0 && Number(ep.Port) !== 443) {
      continue;
    }
    if (!matchWildcardHost(ep.Host, host)) continue;
    if (ep.Path && !pathStr.toLowerCase().startsWith(String(ep.Path).toLowerCase())) {
      continue;
    }
    return rp;
  }
  return null;
}

module.exports = {
  isValidBase64UrlSegment,
  isCompactJwe,
  normalizeStoreMsaTicket,
  normalizeXblRpsTicket,
  formatStoreAuthTickets,
  parseStrictNsalHttpsUrl,
  isTitleStorageHostname,
  matchWildcardHost,
  resolvePreNsalBuiltInRelyingPartyForUrl,
  resolvePostNsalFallbackRelyingPartyForUrl,
  resolveBuiltInRelyingPartyForUrl,
  matchDynamicTitleEndpointRelyingParty,
};
