// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { isContainedWithinRoot } = require('../../../launcher/securityAndPathUtils.cjs');
const { hostPathToWindowsPath } = require('./loopbackValidationAndPaths.cjs');

const MAX_DLC_PACKAGES = 32;
const CROCKFORD_BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * @param {string} publisher
 * @returns {string}
 */
function computePublisherHash(publisher) {
  const clean = String(publisher || '').trim();
  if (!clean) return '8wekyb3d8bbwe';
  const utf16le = Buffer.from(clean, 'utf16le');
  const digest = crypto.createHash('sha256').update(utf16le).digest();
  let bits = 0n;
  for (let i = 0; i < 8; i++) {
    bits = (bits << 8n) | BigInt(digest[i]);
  }
  // Pad 64 bits -> 65 bits (13 * 5) with 1 trailing zero bit per MSIX PublisherId spec
  bits <<= 1n;
  let out = '';
  for (let i = 12; i >= 0; i--) {
    const idx = Number((bits >> BigInt(i * 5)) & 0x1fn);
    out += CROCKFORD_BASE32[idx];
  }
  return out;
}

/**
 * @param {string} str
 * @returns {string}
 */
function decodeBasicXmlEntities(str) {
  return String(str || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * @param {string} tagText
 * @param {string} attrName
 * @returns {string}
 */
function extractXmlAttr(tagText, attrName) {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = re.exec(tagText);
  return m ? decodeBasicXmlEntities(m[1]).trim() : '';
}

/**
 * @param {string} xml
 * @param {string} tagName
 * @returns {string}
 */
function extractXmlElementText(xml, tagName) {
  const re = new RegExp(
    `<(?:\\w+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`,
    'i'
  );
  const m = re.exec(xml);
  return m ? decodeBasicXmlEntities(m[1]).trim() : '';
}

/**
 * @param {unknown} rawId
 * @param {unknown} storeId
 * @param {unknown} fallbackSeed
 * @returns {string}
 */
function formatGdkPackageIdentifier(rawId, storeId, fallbackSeed) {
  const cleanRaw = String(rawId || '').trim();
  if (cleanRaw && cleanRaw.length <= 32) {
    return cleanRaw;
  }
  const cleanStoreId = String(storeId || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
  const digest = crypto
    .createHash('sha256')
    .update(String(fallbackSeed || cleanRaw || cleanStoreId || 'dlc'))
    .digest('hex');
  if (cleanStoreId) {
    return `${cleanStoreId}_dlc_${digest.slice(0, 12)}`;
  }
  return `dlc_${digest.slice(0, 24)}`;
}

/**
 * Pure parser transforming discovered DLC XML + optional `.onelauncher-dlc.json` metadata
 * into the canonical `XPackageKind_Content` descriptor.
 *
 * @param {string} dirName
 * @param {string} mountHost
 * @param {string} xmlContent
 * @param {Record<string, any> | null} metaJson
 */
function buildDiscoveredDlcPackageEntry(dirName, mountHost, xmlContent, metaJson) {
  // Strip <DevelopmentOnly> blocks before parsing Identity/StoreId
  const cleanXml = String(xmlContent || '').replace(
    /<DevelopmentOnly\b[^>]*>[\s\S]*?<\/DevelopmentOnly>/gi,
    ''
  );
  const idTagMatch = /<(?:(?:\w+):)?Identity\b([^>]*)>/i.exec(cleanXml);
  const idAttrs = idTagMatch ? idTagMatch[1] : '';

  const identityName =
    String(metaJson?.identityName || '').trim() ||
    extractXmlAttr(idAttrs, 'Name') ||
    `DLC.${dirName.replace(/[^A-Za-z0-9._-]/g, '') || 'Content'}`;
  const publisher =
    String(metaJson?.publisher || '').trim() ||
    extractXmlAttr(idAttrs, 'Publisher') ||
    'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
  const version =
    String(metaJson?.version || '').trim() ||
    extractXmlAttr(idAttrs, 'Version') ||
    '1.0.0.0';
  const arch =
    String(metaJson?.processorArchitecture || '').trim() ||
    extractXmlAttr(idAttrs, 'ProcessorArchitecture') ||
    'x64';

  const shellMatch = /<(?:(?:\w+):)?ShellVisuals\b([^>]*)>/i.exec(cleanXml);
  const shellDisplayName = shellMatch
    ? extractXmlAttr(shellMatch[1], 'DefaultDisplayName')
    : '';
  const rawDisplayName =
    String(metaJson?.displayName || '').trim() ||
    shellDisplayName ||
    extractXmlElementText(cleanXml, 'DisplayName') ||
    identityName;
  const displayName = rawDisplayName.startsWith('ms-resource:')
    ? identityName
    : rawDisplayName;

  const xmlStoreId = extractXmlElementText(cleanXml, 'StoreId').toUpperCase();
  const fallbackStoreId = /^[A-Z0-9]{12}$/i.test(dirName) ? dirName.toUpperCase() : '';
  const storeId =
    String(metaJson?.storeId || '').trim().toUpperCase() || xmlStoreId || fallbackStoreId;

  const pubHash = computePublisherHash(publisher);
  const packageFullName =
    String(metaJson?.packageFullName || '').trim() ||
    `${identityName}_${version}_${arch}__${pubHash}`;
  const packageIdentifier = formatGdkPackageIdentifier(
    metaJson?.packageIdentifier,
    storeId,
    packageFullName
  );

  const mountPathWin = hostPathToWindowsPath(mountHost);
  return {
    packageIdentifier,
    packageFullName,
    storeId,
    displayName,
    version,
    mountPathHost: mountHost,
    mountPathWin,
  };
}

/**
 * Asynchronously discovers installed Xbox DLC (`XPackageKind_Content`) packages under
 * `<gameRootDir>/.onelauncher-dlc/*` using non-blocking `fs.promises` I/O.
 *
 * @param {string} gameRootDir
 * @returns {Promise<Array<{
 *   packageIdentifier: string,
 *   packageFullName: string,
 *   storeId: string,
 *   displayName: string,
 *   version: string,
 *   mountPathHost: string,
 *   mountPathWin: string,
 * }>>}
 */
async function discoverInstalledDlcPackagesAsync(gameRootDir) {
  if (!gameRootDir || typeof gameRootDir !== 'string') return [];
  const dlcRoot = path.resolve(gameRootDir, '.onelauncher-dlc');
  let entries;
  try {
    entries = await fs.promises.readdir(dlcRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const subdirs = entries
    .filter((e) => e && e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_DLC_PACKAGES);

  const discovered = [];
  for (const dirName of subdirs) {
    const baseDir = path.resolve(dlcRoot, dirName);
    if (baseDir === dlcRoot || !isContainedWithinRoot(dlcRoot, baseDir)) continue;
    const candidateRoots = [baseDir, path.join(baseDir, 'Content')];

    let mountHost = baseDir;
    let xmlContent = '';
    for (const cand of candidateRoots) {
      const mgcPath = path.join(cand, 'MicrosoftGame.config');
      const appxPath = path.join(cand, 'AppxManifest.xml');
      const mgcText = await fs.promises.readFile(mgcPath, 'utf8').catch(() => null);
      if (mgcText !== null) {
        xmlContent = mgcText;
        mountHost = cand;
        break;
      }
      const appxText = await fs.promises.readFile(appxPath, 'utf8').catch(() => null);
      if (appxText !== null) {
        xmlContent = appxText;
        mountHost = cand;
        break;
      }
    }

    let metaJson = null;
    try {
      const metaRaw = await fs.promises.readFile(
        path.join(baseDir, '.onelauncher-dlc.json'),
        'utf8'
      );
      metaJson = JSON.parse(metaRaw);
    } catch {
      metaJson = null;
    }

    discovered.push(buildDiscoveredDlcPackageEntry(dirName, mountHost, xmlContent, metaJson));
  }

  return discovered;
}

/**
 * Synchronously discovers installed Xbox DLC (`XPackageKind_Content`) packages under
 * `<gameRootDir>/.onelauncher-dlc/*` (retained for backward compatibility with sync callers;
 * async startup paths should prefer `discoverInstalledDlcPackagesAsync`).
 *
 * @param {string} gameRootDir
 */
function discoverInstalledDlcPackages(gameRootDir) {
  if (!gameRootDir || typeof gameRootDir !== 'string') return [];
  const dlcRoot = path.resolve(gameRootDir, '.onelauncher-dlc');
  let entries;
  try {
    if (!fs.existsSync(dlcRoot)) return [];
    entries = fs.readdirSync(dlcRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const subdirs = entries
    .filter((e) => e && e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_DLC_PACKAGES);

  const discovered = [];
  for (const dirName of subdirs) {
    const baseDir = path.resolve(dlcRoot, dirName);
    if (baseDir === dlcRoot || !isContainedWithinRoot(dlcRoot, baseDir)) continue;
    const candidateRoots = [baseDir, path.join(baseDir, 'Content')];

    let mountHost = baseDir;
    let xmlContent = '';
    for (const cand of candidateRoots) {
      const mgcPath = path.join(cand, 'MicrosoftGame.config');
      const appxPath = path.join(cand, 'AppxManifest.xml');
      try {
        if (fs.existsSync(mgcPath)) {
          xmlContent = fs.readFileSync(mgcPath, 'utf8');
          mountHost = cand;
          break;
        }
        if (fs.existsSync(appxPath)) {
          xmlContent = fs.readFileSync(appxPath, 'utf8');
          mountHost = cand;
          break;
        }
      } catch {
        // Continue probing next manifest candidate
      }
    }

    let metaJson = null;
    try {
      const metaPath = path.join(baseDir, '.onelauncher-dlc.json');
      if (fs.existsSync(metaPath)) {
        metaJson = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      }
    } catch {
      metaJson = null;
    }

    discovered.push(buildDiscoveredDlcPackageEntry(dirName, mountHost, xmlContent, metaJson));
  }

  return discovered;
}

module.exports = {
  MAX_DLC_PACKAGES,
  computePublisherHash,
  decodeBasicXmlEntities,
  extractXmlAttr,
  extractXmlElementText,
  formatGdkPackageIdentifier,
  buildDiscoveredDlcPackageEntry,
  discoverInstalledDlcPackagesAsync,
  discoverInstalledDlcPackages,
};
