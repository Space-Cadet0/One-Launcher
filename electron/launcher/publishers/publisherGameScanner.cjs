// @ts-check
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDriveCPathCaseInsensitive } = require('../wineAndCrossOverManager.cjs');
const {
  enumerateWindowsRegistrySubkeys,
  discoverWindowsPublisherLauncherPaths,
} = require('../../utils/windowsRegistryDiscovery.cjs');
const {
  EXCLUDED_GAME_DIR_NAMES,
  STEAMAPPS_COMMON_PATH_RE,
  normalizeChainedHandoffId,
  normalizeBattleNetLaunchProductCode,
  isExcludedPublisherOrRedistExe,
  isForbiddenBroadPublisherContainerDir,
} = require('./publisherCatalogData.cjs');
const {
  getRegistryPropCaseInsensitive,
  getBottleSystemRegSections,
  resolveWineReparseTargetReadOnly,
  resolveBottleWindowsPathReadOnly,
  listBottleUserDirectories,
} = require('./wineRegistryParserAndMutator.cjs');
const { discoverBottlePublisherLauncher } = require('./publisherClientDiscoveryAndProbes.cjs');

/**
 * @typedef {import('./publisherCatalogData.cjs').ChainedHandoffId} ChainedHandoffId
 * @typedef {import('./publisherCatalogData.cjs').ScannedPublisherInstalledGame} ScannedPublisherInstalledGame
 * @typedef {import('./publisherCatalogData.cjs').BattleNetProductDbInstallEntry} BattleNetProductDbInstallEntry
 */

const MAX_BATTLE_NET_PRODUCT_DB_BYTES = 16 * 1024 * 1024;

// ============================================================================
// Battle.net `product.db` Protobuf Wire Parser & Metadata Helpers
// ============================================================================

/**
 * Bounds-safe protobuf varint reader (max 10 continuation bytes / 64-bit integer).
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} end
 * @returns {{ value: bigint, nextOffset: number } | null}
 */
function readProtobufVarintBounded(buf, offset, end) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  for (let count = 0; count < 10; count += 1) {
    if (pos >= end) return null;
    const byte = buf[pos];
    pos += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
  }
  return null;
}

/**
 * Advance past an unknown protobuf field value with strict bounds validation.
 *
 * @param {Buffer} buf
 * @param {number} wireType
 * @param {number} offset
 * @param {number} end
 * @returns {number} New offset, or `-1` on malformed wire data.
 */
function skipProtobufFieldBounded(buf, wireType, offset, end) {
  if (wireType === 0) {
    const v = readProtobufVarintBounded(buf, offset, end);
    return v ? v.nextOffset : -1;
  }
  if (wireType === 1) {
    return offset + 8 <= end ? offset + 8 : -1;
  }
  if (wireType === 2) {
    const lenVar = readProtobufVarintBounded(buf, offset, end);
    if (!lenVar || lenVar.value < 0n || lenVar.value > BigInt(end - lenVar.nextOffset)) {
      return -1;
    }
    return lenVar.nextOffset + Number(lenVar.value);
  }
  if (wireType === 5) {
    return offset + 4 <= end ? offset + 4 : -1;
  }
  return -1;
}

/**
 * Iterate wire-format protobuf fields in `buf[start..end)` with strict bounds safety.
 *
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @param {(fieldNum: number, wireType: number, valStart: number, valEnd: number, varintVal: bigint) => void} onField
 */
function forEachProtobufField(buf, start, end, onField) {
  let pos = start;
  while (pos < end) {
    const tagVar = readProtobufVarintBounded(buf, pos, end);
    if (!tagVar || tagVar.value <= 0n) break;
    pos = tagVar.nextOffset;
    const fieldNum = Number(tagVar.value >> 3n);
    const wireType = Number(tagVar.value & 7n);
    if (wireType === 0) {
      const valVar = readProtobufVarintBounded(buf, pos, end);
      if (!valVar) break;
      onField(fieldNum, 0, pos, valVar.nextOffset, valVar.value);
      pos = valVar.nextOffset;
    } else if (wireType === 2) {
      const lenVar = readProtobufVarintBounded(buf, pos, end);
      if (!lenVar || lenVar.value < 0n || lenVar.value > BigInt(end - lenVar.nextOffset)) break;
      const subStart = lenVar.nextOffset;
      const subEnd = subStart + Number(lenVar.value);
      onField(fieldNum, 2, subStart, subEnd, 0n);
      pos = subEnd;
    } else {
      const nextPos = skipProtobufFieldBounded(buf, wireType, pos, end);
      if (nextPos < 0 || nextPos <= pos) break;
      pos = nextPos;
    }
  }
}

/**
 * Zero-dependency binary protobuf wire parser for Battle.net Agent's `product.db`.
 * Enforces `<= 16 MiB` size ceiling, strict varint/submessage bounds, and excludes
 * internal non-game UIDs (`bna`, `agent`).
 *
 * @param {Buffer | Uint8Array | null | undefined} rawBuf
 * @returns {BattleNetProductDbInstallEntry[]}
 */
function parseBattleNetProductDbBuffer(rawBuf) {
  if (!rawBuf || (!(rawBuf instanceof Uint8Array) && !Buffer.isBuffer(rawBuf))) {
    return [];
  }
  if (rawBuf.byteLength === 0 || rawBuf.byteLength > MAX_BATTLE_NET_PRODUCT_DB_BYTES) {
    return [];
  }
  const buf = Buffer.isBuffer(rawBuf)
    ? rawBuf
    : Buffer.from(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);

  /**
   * @param {number} start
   * @param {number} end
   * @returns {BattleNetProductDbInstallEntry | null}
   */
  const parseProductInstall = (start, end) => {
    let uid = '';
    let productCode = '';
    let installPath = '';
    let playRegion = '';
    let installed = false;
    let playable = false;
    let currentVersionStr = '';
    let hasCachedState = false;

    forEachProtobufField(buf, start, end, (fieldNum, wireType, subStart, subEnd) => {
      if (wireType !== 2) return;
      if (fieldNum === 1) {
        uid = buf.toString('utf8', subStart, subEnd).trim();
      } else if (fieldNum === 2) {
        productCode = buf.toString('utf8', subStart, subEnd).trim();
      } else if (fieldNum === 3) {
        forEachProtobufField(buf, subStart, subEnd, (fNum, wType, s, e) => {
          if (wType !== 2) return;
          const text = buf.toString('utf8', s, e).trim();
          if (fNum === 1 && text) installPath = text;
          else if (fNum === 2 && text) playRegion = text;
        });
      } else if (fieldNum === 4) {
        hasCachedState = true;
        forEachProtobufField(buf, subStart, subEnd, (fNum, wType, bs, be) => {
          if (wType !== 2 || fNum !== 1) return;
          forEachProtobufField(buf, bs, be, (bfNum, bwType, vs, ve, vInt) => {
            if (bwType === 0 && bfNum === 1) installed = vInt !== 0n;
            else if (bwType === 0 && bfNum === 2) playable = vInt !== 0n;
            else if (bwType === 2 && bfNum === 7) {
              const ver = buf.toString('utf8', vs, ve).trim();
              if (ver) currentVersionStr = ver;
            }
          });
        });
      }
    });

    const effectiveId = uid || productCode;
    if (!effectiveId) return null;
    const uidLower = uid.toLowerCase();
    const codeLower = productCode.toLowerCase();
    if (
      uidLower === 'bna' ||
      uidLower === 'agent' ||
      uidLower === 'battle.net' ||
      codeLower === 'bna' ||
      codeLower === 'agent' ||
      codeLower === 'battle.net'
    ) {
      return null;
    }

    return {
      uid: uid || productCode,
      productCode: productCode || uid,
      launchProductCode: normalizeBattleNetLaunchProductCode(productCode || uid),
      installPath,
      playRegion,
      installed,
      playable,
      currentVersionStr,
      hasCachedState,
    };
  };

  /** @type {BattleNetProductDbInstallEntry[]} */
  const installs = [];
  forEachProtobufField(buf, 0, buf.length, (fieldNum, wireType, msgStart, msgEnd) => {
    if (wireType === 2 && fieldNum === 1) {
      const parsed = parseProductInstall(msgStart, msgEnd);
      if (parsed) installs.push(parsed);
    }
  });

  return installs;
}

/**
 * Read and parse Battle.net Agent `product.db` strictly read-only (`<= 16 MiB`).
 *
 * @param {string} productDbPath
 * @returns {BattleNetProductDbInstallEntry[]}
 */
function readBattleNetProductDbFileReadOnly(productDbPath) {
  if (!productDbPath) return [];
  try {
    if (!fs.existsSync(productDbPath)) return [];
    const st = fs.statSync(productDbPath);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_BATTLE_NET_PRODUCT_DB_BYTES) {
      return [];
    }
    return parseBattleNetProductDbBuffer(fs.readFileSync(productDbPath));
  } catch {
    return [];
  }
}

/**
 * Extract Battle.net NGDP TACT product UID from `.build.info` or `UninstallString` if available.
 *
 * @param {string} installDir
 * @param {string} [uninstallString]
 * @returns {string}
 */
function extractBattleNetProductId(installDir, uninstallString = '') {
  if (uninstallString) {
    const uidMatch = uninstallString.match(/--uid=([A-Za-z0-9_.-]+)/i);
    if (uidMatch && uidMatch[1]) {
      return uidMatch[1].trim();
    }
  }
  if (!installDir) return '';
  const buildInfoPath = path.join(installDir, '.build.info');
  try {
    if (fs.existsSync(buildInfoPath)) {
      const lines = fs.readFileSync(buildInfoPath, 'utf8').split(/\r?\n/).filter(Boolean);
      if (lines.length >= 2) {
        const headers = lines[0].split('|').map((h) => h.split('!')[0].trim().toLowerCase());
        const prodIdx = headers.indexOf('product');
        if (prodIdx >= 0) {
          const cols = lines[1].split('|');
          if (cols[prodIdx] && cols[prodIdx].trim()) {
            return cols[prodIdx].trim();
          }
        }
      }
    }
  } catch {}
  return '';
}

/**
 * Extract `Client.Install.DefaultInstallPath` from a Battle.net `Battle.net.config` JSON file.
 *
 * @param {string} configFilePath
 * @returns {string}
 */
function readBattleNetDefaultInstallPathFromConfig(configFilePath) {
  if (!configFilePath) return '';
  try {
    if (!fs.existsSync(configFilePath)) return '';
    const parsed = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    const raw =
      parsed?.Client?.Install?.DefaultInstallPath ??
      parsed?.Client?.Install?.defaultInstallPath ??
      '';
    if (typeof raw === 'string') {
      const clean = raw.trim().replace(/^["']+|["']+$/g, '');
      if (clean && clean.toLowerCase() !== 'null') {
        return clean;
      }
    }
  } catch {}
  return '';
}

// ============================================================================
// Playable Game Executable Discovery & EA XML / Config Parsers
// ============================================================================

/**
 * Locate the primary playable game executable inside `installPath` (bounded depth scan),
 * strictly excluding publisher launcher, redistributable, crash-handler, and stub binaries.
 *
 * @param {string} installPath
 * @param {string} [preferredExeHint]
 * @param {{ allowMacAppBundles?: boolean }} [opts]
 * @returns {{ executablePath: string | null, approxSizeBytes: number }}
 */
function findPrimaryPublisherGameExecutable(installPath, preferredExeHint = '', opts = {}) {
  if (!installPath) return { executablePath: null, approxSizeBytes: 0 };
  try {
    const rootStat = fs.statSync(installPath);
    if (!rootStat.isDirectory()) return { executablePath: null, approxSizeBytes: 0 };
  } catch {
    return { executablePath: null, approxSizeBytes: 0 };
  }

  if (preferredExeHint) {
    const cleanedHint = preferredExeHint
      .trim()
      .replace(/^"+|"+$/g, '')
      .replace(/,\s*-?\d+\s*$/, '')
      .replace(/^(?:\[[^\]]+\][\\/]*)+/, '');
    if (cleanedHint) {
      const candidatePaths = [];
      if (path.isAbsolute(cleanedHint) && fs.existsSync(cleanedHint)) {
        candidatePaths.push(cleanedHint);
      } else {
        const relParts = cleanedHint.replace(/\\/g, '/').split('/').filter(Boolean);
        if (relParts.length > 0) {
          candidatePaths.push(resolveDriveCPathCaseInsensitive(installPath, relParts));
        }
      }
      for (const cand of candidatePaths) {
        const base = path.basename(cand);
        if (isExcludedPublisherOrRedistExe(base)) continue;
        try {
          const st = fs.statSync(cand);
          if (st.isFile() && st.size > 0) {
            return { executablePath: cand, approxSizeBytes: st.size };
          }
        } catch {}
      }
    }
  }

  /** @type {Array<{ fullPath: string, size: number, depth: number }>} */
  const candidates = [];
  let totalSeenBytes = 0;
  let visitedEntries = 0;
  const maxVisitedEntries = 250;

  /**
   * @param {string} dir
   * @param {number} depth
   */
  const walk = (dir, depth) => {
    if (depth > 4 || visitedEntries >= maxVisitedEntries) return;
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visitedEntries >= maxVisitedEntries) break;
      if (entry.name.startsWith('.')) continue;
      visitedEntries += 1;
      const lowerName = entry.name.toLowerCase();
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (
          opts.allowMacAppBundles &&
          lowerName.endsWith('.app') &&
          lowerName !== 'battle.net.app' &&
          lowerName !== 'riot client.app' &&
          lowerName !== 'ea app.app'
        ) {
          const macOsDir = path.join(fullPath, 'Contents', 'MacOS');
          try {
            if (fs.existsSync(macOsDir)) {
              for (const bin of fs.readdirSync(macOsDir, { withFileTypes: true })) {
                if (!bin.isFile()) continue;
                const binPath = path.join(macOsDir, bin.name);
                const st = fs.statSync(binPath);
                if (st.size > 0) {
                  candidates.push({ fullPath: binPath, size: st.size, depth });
                }
              }
            }
          } catch {}
          continue;
        }
        if (EXCLUDED_GAME_DIR_NAMES.has(lowerName)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(fullPath);
          totalSeenBytes += st.size;
          if (!isExcludedPublisherOrRedistExe(entry.name) && st.size > 0) {
            if (lowerName === 'launcher.exe' && depth === 0) {
              const siblingPatcher = path.join(dir, 'LauncherPatcher.exe');
              if (fs.existsSync(siblingPatcher)) continue;
            }
            candidates.push({ fullPath, size: st.size, depth });
          }
        } catch {}
      }
    }
  };

  walk(installPath, 0);
  if (candidates.length === 0) {
    return { executablePath: null, approxSizeBytes: 0 };
  }

  candidates.sort((a, b) => {
    const aIsPlayWrapper = /^play[a-z0-9_.-]*\.exe$/i.test(path.basename(a.fullPath));
    const bIsPlayWrapper = /^play[a-z0-9_.-]*\.exe$/i.test(path.basename(b.fullPath));
    if (b.size !== a.size) return b.size - a.size;
    if (aIsPlayWrapper !== bIsPlayWrapper) return aIsPlayWrapper ? 1 : -1;
    return a.depth - b.depth;
  });

  return {
    executablePath: candidates[0].fullPath,
    approxSizeBytes: totalSeenBytes || candidates[0].size,
  };
}

/**
 * Decode common XML character entities (`&amp;`, `&apos;`, `&#39;`, `&quot;`, `&lt;`, `&gt;`).
 *
 * @param {string} raw
 * @returns {string}
 */
function decodeXmlEntities(raw) {
  if (!raw || typeof raw !== 'string' || !raw.includes('&')) return raw || '';
  return raw
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : _m;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : _m;
    })
    .replace(/&amp;/gi, '&');
}

/**
 * Bounded case-insensitive basename search under `installRoot` (max depth 4, excluding redist dirs).
 *
 * @param {string} installRoot
 * @param {string} targetBaseName
 * @returns {string | null}
 */
function findRelativeExeByBasenameUnderRoot(installRoot, targetBaseName) {
  if (!installRoot || !targetBaseName) return null;
  const targetLower = targetBaseName.toLowerCase();
  /** @type {string | null} */
  let foundRel = null;

  /**
   * @param {string} dir
   * @param {number} depth
   */
  const walk = (dir, depth) => {
    if (foundRel || depth > 4) return;
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const lower = entry.name.toLowerCase();
      const full = path.join(dir, entry.name);
      if (entry.isFile() && lower === targetLower) {
        try {
          if (fs.statSync(full).size > 0) {
            foundRel = path.relative(installRoot, full);
            return;
          }
        } catch {}
      }
    }
    for (const entry of entries) {
      if (foundRel) return;
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const lower = entry.name.toLowerCase();
      if (EXCLUDED_GAME_DIR_NAMES.has(lower)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };

  walk(installRoot, 0);
  return foundRel;
}

/**
 * Parse EA `__Installer/installerdata.xml` metadata without external XML dependencies.
 *
 * @param {string} xmlText
 * @param {string} [installRoot]
 * @returns {{ contentId: string, contentIds: string[], title: string, launcherRelExe: string, executablePath?: string }}
 */
function parseEaInstallerDataXml(xmlText, installRoot = '') {
  if (!xmlText || typeof xmlText !== 'string') {
    return { contentId: '', contentIds: [], title: '', launcherRelExe: '' };
  }

  /** @type {string[]} */
  const contentIds = [];
  for (const m of xmlText.matchAll(/<contentID>\s*([^<]+?)\s*<\/contentID>/gi)) {
    const cid = decodeXmlEntities(String(m[1] || '').trim()).trim();
    if (cid && !contentIds.includes(cid)) contentIds.push(cid);
  }
  if (contentIds.length === 0) {
    for (const m of xmlText.matchAll(/<productId>\s*([^<]+?)\s*<\/productId>/gi)) {
      const pid = decodeXmlEntities(String(m[1] || '').trim()).trim();
      if (pid && !contentIds.includes(pid)) contentIds.push(pid);
    }
  }

  const preferredOfferId = contentIds.find((id) => /^(?:Origin\.OFR\.|EA\.)/i.test(id));
  const contentId = preferredOfferId || contentIds[0] || '';

  let title = '';
  const enUsTitleMatch =
    xmlText.match(/<gameTitle[^>]*locale\s*=\s*["']en[-_]US["'][^>]*>([^<]+)<\/gameTitle>/i) ||
    xmlText.match(/<title[^>]*locale\s*=\s*["']en[-_]US["'][^>]*>([^<]+)<\/title>/i);
  if (enUsTitleMatch && enUsTitleMatch[1]) {
    title = decodeXmlEntities(enUsTitleMatch[1].trim()).trim();
  } else {
    const anyTitleMatch =
      xmlText.match(/<gameTitle[^>]*>([^<]+)<\/gameTitle>/i) ||
      xmlText.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (anyTitleMatch && anyTitleMatch[1]) {
      title = decodeXmlEntities(anyTitleMatch[1].trim()).trim();
    }
  }

  const hasValidInstallRoot = (() => {
    if (!installRoot) return false;
    try {
      return fs.existsSync(installRoot) && fs.statSync(installRoot).isDirectory();
    } catch {
      return false;
    }
  })();

  /**
   * @param {string} rawPathText
   * @returns {{ cleanedRel: string, existsOnDisk: boolean } | null}
   */
  const cleanAndResolveLauncherFilePath = (rawPathText) => {
    const decoded = decodeXmlEntities(String(rawPathText || '').trim())
      .trim()
      .replace(/^"+|"+$/g, '')
      .replace(/^(?:\[[^\]]+\][\\/]*)+/, '')
      .replace(/^[\\/]+/, '');
    if (!decoded) return null;
    const baseName = decoded.replace(/\\/g, '/').split('/').pop() || '';
    if (!baseName || isExcludedPublisherOrRedistExe(baseName)) return null;

    if (hasValidInstallRoot) {
      const relParts = decoded.replace(/\\/g, '/').split('/').filter(Boolean);
      if (relParts.length > 0) {
        const directCand = resolveDriveCPathCaseInsensitive(installRoot, relParts);
        try {
          if (fs.existsSync(directCand) && fs.statSync(directCand).isFile()) {
            return { cleanedRel: decoded, existsOnDisk: true };
          }
        } catch {}
      }
      const fallbackRel = findRelativeExeByBasenameUnderRoot(installRoot, baseName);
      if (fallbackRel) {
        return { cleanedRel: fallbackRel, existsOnDisk: true };
      }
    }

    return { cleanedRel: decoded, existsOnDisk: false };
  };

  let launcherRelExe = '';
  const runtimeBlockMatch = xmlText.match(/<runtime\b[\s\S]*?<\/runtime>/i);
  const searchArea = runtimeBlockMatch ? runtimeBlockMatch[0] : xmlText;

  /** @type {Array<{ cleanedRel: string, score: number, index: number }>} */
  const scoredLaunchers = [];
  let blockIdx = 0;

  for (const lm of searchArea.matchAll(/<launcher\b([^>]*)>([\s\S]*?)<\/launcher>/gi)) {
    const attrs = String(lm[1] || '');
    const inner = String(lm[2] || '');
    const idx = blockIdx++;

    const fpMatch = inner.match(/<filePath>\s*([\s\S]*?)\s*<\/filePath>/i);
    if (!fpMatch || !fpMatch[1]) continue;

    const resolvedFp = cleanAndResolveLauncherFilePath(fpMatch[1]);
    if (!resolvedFp) continue;

    let score = 0;
    const trialAttr = attrs.match(/\btrial\s*=\s*["']?([^"'\s>]+)["']?/i);
    const trialTag = inner.match(/<trial>\s*([^<\s]+)\s*<\/trial>/i);
    const trialVal = String(trialAttr?.[1] ?? trialTag?.[1] ?? '')
      .trim()
      .toLowerCase();
    score += trialVal === '1' || trialVal === 'true' ? -100 : 50;

    const hiddenAttr = attrs.match(/\bhidden\s*=\s*["']?([^"'\s>]+)["']?/i);
    const hiddenTag = inner.match(/<hidden>\s*([^<\s]+)\s*<\/hidden>/i);
    const hiddenVal = String(hiddenAttr?.[1] ?? hiddenTag?.[1] ?? '')
      .trim()
      .toLowerCase();
    if (hiddenVal === '1' || hiddenVal === 'true') score -= 50;

    const req64Attr = attrs.match(/\brequires64BitOS\s*=\s*["']?([^"'\s>]+)["']?/i);
    const req64Tag = inner.match(/<requires64BitOS>\s*([^<\s]+)\s*<\/requires64BitOS>/i);
    const req64Val = String(req64Attr?.[1] ?? req64Tag?.[1] ?? '')
      .trim()
      .toLowerCase();
    if (req64Val === '1' || req64Val === 'true') score += 20;

    if (resolvedFp.existsOnDisk) score += 30;

    scoredLaunchers.push({ cleanedRel: resolvedFp.cleanedRel, score, index: idx });
  }

  if (scoredLaunchers.length > 0) {
    scoredLaunchers.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
    launcherRelExe = scoredLaunchers[0].cleanedRel;
  } else {
    for (const m of searchArea.matchAll(/<filePath>\s*([^<]+?)\s*<\/filePath>/gi)) {
      const resolvedFp = cleanAndResolveLauncherFilePath(m[1]);
      if (resolvedFp) {
        launcherRelExe = resolvedFp.cleanedRel;
        break;
      }
    }
  }

  /** @type {string | undefined} */
  let executablePath;
  if (launcherRelExe && installRoot) {
    const relParts = launcherRelExe.replace(/\\/g, '/').split('/').filter(Boolean);
    if (relParts.length > 0) {
      executablePath = hasValidInstallRoot
        ? resolveDriveCPathCaseInsensitive(installRoot, relParts)
        : path.join(installRoot, ...relParts);
    }
  }

  return {
    contentId,
    contentIds,
    title,
    launcherRelExe,
    ...(executablePath ? { executablePath } : {}),
  };
}

/**
 * Locate and parse EA `__Installer/installerdata.xml` (and optionally macOS `Contents/__Installer/...`)
 * inside `gameDir`.
 *
 * @param {string} gameDir
 * @param {{ caseInsensitive?: boolean, includeMacContents?: boolean }} [opts]
 * @returns {{ found: boolean, contentId: string, title: string, launcherRelExe: string }}
 */
function readEaXmlMetadataInDir(gameDir, opts = {}) {
  const candidates = [];
  if (opts.caseInsensitive) {
    candidates.push(resolveDriveCPathCaseInsensitive(gameDir, ['__Installer', 'installerdata.xml']));
  } else {
    candidates.push(path.join(gameDir, '__Installer', 'installerdata.xml'));
  }
  if (opts.includeMacContents) {
    candidates.push(path.join(gameDir, 'Contents', '__Installer', 'installerdata.xml'));
  }
  const xmlPath = candidates.find((p) => {
    try {
      return Boolean(p && fs.existsSync(p));
    } catch {
      return false;
    }
  });
  if (!xmlPath) {
    return { found: false, contentId: '', title: '', launcherRelExe: '' };
  }
  try {
    const parsed = parseEaInstallerDataXml(fs.readFileSync(xmlPath, 'utf8'), gameDir);
    return {
      found: true,
      contentId: parsed.contentId,
      title: parsed.title,
      launcherRelExe: parsed.launcherRelExe,
    };
  } catch {
    return { found: true, contentId: '', title: '', launcherRelExe: '' };
  }
}

/**
 * Extract `machine.downloadinplacedir` or `user.downloadinplacedir` from an EA Desktop `.ini` file.
 *
 * @param {string} iniFilePath
 * @returns {string}
 */
function extractEaIniDownloadInPlaceDir(iniFilePath) {
  if (!iniFilePath) return '';
  try {
    if (!fs.existsSync(iniFilePath)) return '';
    const text = fs.readFileSync(iniFilePath, 'utf8');
    const m = text.match(/^\s*(?:(?:machine|user)\.)?downloadinplacedir\s*=\s*(.+)$/im);
    if (m && m[1]) {
      const val = m[1]
        .trim()
        .replace(/^["']+|["']+$/g, '')
        .replace(/\\\\/g, '\\')
        .trim();
      if (val && val.toLowerCase() !== 'null' && !/^@invalid\(\)$/i.test(val)) {
        return val.replace(/([^:])[\\/]+$/, '$1');
      }
    }
  } catch {}
  return '';
}

/**
 * Extract `DownloadInPlaceDir` from a legacy Origin `local_*.xml` or `local.xml` file.
 *
 * @param {string} xmlFilePath
 * @returns {string}
 */
function extractOriginXmlDownloadInPlaceDir(xmlFilePath) {
  if (!xmlFilePath) return '';
  try {
    if (!fs.existsSync(xmlFilePath)) return '';
    const xml = fs.readFileSync(xmlFilePath, 'utf8');
    const m =
      xml.match(
        /<Setting\b[^>]*\bkey\s*=\s*["']DownloadInPlaceDir["'][^>]*\bvalue\s*=\s*["']([^"']+)["']/i
      ) ||
      xml.match(
        /<Setting\b[^>]*\bvalue\s*=\s*["']([^"']+)["'][^>]*\bkey\s*=\s*["']DownloadInPlaceDir["']/i
      );
    if (m && m[1]) {
      const val = decodeXmlEntities(m[1].trim()).trim();
      if (val && val.toLowerCase() !== 'null') {
        return val.replace(/([^:])[\\/]+$/, '$1');
      }
    }
  } catch {}
  return '';
}

/**
 * Enumerate `user_*.ini` (excluding `user_unknown.ini`) under `eaDesktopDir` and optionally
 * `local*.xml` under `originRoamingDir`, invoking `onDir` for every configured library root.
 *
 * @param {string} eaDesktopDir
 * @param {string} originRoamingDir
 * @param {(dirPath: string) => void} onDir
 */
function collectConfiguredEaDirsFromProfile(eaDesktopDir, originRoamingDir, onDir) {
  try {
    if (eaDesktopDir && fs.existsSync(eaDesktopDir)) {
      const userInis = fs
        .readdirSync(eaDesktopDir, { withFileTypes: true })
        .filter(
          (d) =>
            d.isFile() &&
            /^user_.+\.ini$/i.test(d.name) &&
            d.name.toLowerCase() !== 'user_unknown.ini'
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const f of userInis) {
        const customDir = extractEaIniDownloadInPlaceDir(path.join(eaDesktopDir, f.name));
        if (customDir) onDir(customDir);
      }
    }
  } catch {}

  try {
    if (originRoamingDir && fs.existsSync(originRoamingDir)) {
      const originXmls = fs
        .readdirSync(originRoamingDir, { withFileTypes: true })
        .filter((d) => d.isFile() && /^local(?:_.*)?\.xml$/i.test(d.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const f of originXmls) {
        const originDir = extractOriginXmlDownloadInPlaceDir(path.join(originRoamingDir, f.name));
        if (originDir) onDir(originDir);
      }
    }
  } catch {}
}

/**
 * Shared sandbox-aware Windows host directory resolver (eliminates 3x duplication across
 * `readEaConfiguredLibraryRoots`, `scanHostPublisherInstalledGames`, and `resolvePublisherStagingDirs`).
 *
 * @param {Record<string, any>} [opts]
 */
function resolveWin32HostEnvDirs(opts = {}) {
  const sandboxHome =
    typeof opts.homedir === 'string' && opts.homedir.trim() ? opts.homedir.trim() : '';
  const home = sandboxHome || os.homedir();
  const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env;

  const programFiles = sandboxHome
    ? String(
        opts.programFilesDir ||
          env.ProgramFiles ||
          env.PROGRAMFILES ||
          path.join(sandboxHome, 'Program Files')
      )
    : String(env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files');
  const programFilesX86 = sandboxHome
    ? String(
        opts.programFilesX86Dir ||
          env['ProgramFiles(x86)'] ||
          env['PROGRAMFILES(X86)'] ||
          path.join(sandboxHome, 'Program Files (x86)')
      )
    : String(env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)');
  const programData = sandboxHome
    ? String(
        opts.programDataDir ||
          env.ProgramData ||
          env.PROGRAMDATA ||
          path.join(sandboxHome, 'ProgramData')
      )
    : String(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData');
  const localAppData = sandboxHome
    ? String(opts.localAppDataDir || env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
    : String(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'));
  const roamingAppData = sandboxHome
    ? String(opts.appDataDir || env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : String(env.APPDATA || path.join(home, 'AppData', 'Roaming'));
  const explicitSysDrive = String(opts.systemDrive || env.SystemDrive || env.SYSTEMDRIVE || '').trim();

  return {
    sandboxHome,
    home,
    env,
    programFiles,
    programFilesX86,
    programData,
    localAppData,
    roamingAppData,
    explicitSysDrive,
  };
}

/**
 * Shared sandbox-aware macOS host directory resolver.
 *
 * @param {Record<string, any>} [opts]
 */
function resolveDarwinHostEnvDirs(opts = {}) {
  const sandboxHome =
    typeof opts.homedir === 'string' && opts.homedir.trim() ? opts.homedir.trim() : '';
  const customAppsDir =
    typeof opts.customApplicationsDir === 'string' && opts.customApplicationsDir.trim()
      ? opts.customApplicationsDir.trim()
      : '';
  const isIsolatedSandbox = Boolean(sandboxHome || customAppsDir);
  const home = sandboxHome || os.homedir();
  const baseAppRoots = isIsolatedSandbox
    ? [customAppsDir, sandboxHome ? path.join(sandboxHome, 'Applications') : ''].filter(Boolean)
    : ['/Applications', path.join(home, 'Applications')];
  const macBnetAgentDir = isIsolatedSandbox
    ? sandboxHome
      ? path.join(sandboxHome, 'Users', 'Shared', 'Battle.net', 'Agent')
      : ''
    : '/Users/Shared/Battle.net/Agent';
  const macRiotSharedDir = isIsolatedSandbox
    ? sandboxHome
      ? path.join(sandboxHome, 'Users', 'Shared', 'Riot Games')
      : ''
    : '/Users/Shared/Riot Games';

  return {
    sandboxHome,
    customAppsDir,
    isIsolatedSandbox,
    home,
    baseAppRoots,
    macBnetAgentDir,
    macBnetProductDbPath: macBnetAgentDir ? path.join(macBnetAgentDir, 'product.db') : '',
    macRiotSharedDir,
    macRiotMetaDir: macRiotSharedDir ? path.join(macRiotSharedDir, 'Metadata') : '',
  };
}

/**
 * Discover all configured and default EA App / Origin game library root directories
 * either inside a macOS Wine/CrossOver bottle (`bottlePath` string or `{ bottlePath }`)
 * or on the host OS (`win32` or `darwin` options object). Strictly read-only.
 *
 * @param {string | Record<string, any>} [optionsOrBottle]
 * @returns {string[]}
 */
function readEaConfiguredLibraryRoots(optionsOrBottle = {}) {
  /** @type {string[]} */
  const roots = [];
  /** @type {Set<string>} */
  const seenLower = new Set();

  const pushRoot = (/** @type {string | null | undefined} */ rawDir) => {
    const clean = String(rawDir || '')
      .trim()
      .replace(/^["']+|["']+$/g, '')
      .replace(/([^:])[\\/]+$/, '$1');
    if (!clean) return;
    if (STEAMAPPS_COMMON_PATH_RE.test(clean)) return;
    const key = clean.toLowerCase();
    if (!seenLower.has(key)) {
      seenLower.add(key);
      roots.push(clean);
    }
  };

  let bottlePath = '';
  /** @type {Record<string, any>} */
  let opts = {};

  if (typeof optionsOrBottle === 'string') {
    const trimmed = optionsOrBottle.trim();
    if (trimmed) {
      bottlePath =
        path.basename(trimmed).toLowerCase() === 'drive_c' ? path.dirname(trimmed) : trimmed;
    }
  } else if (optionsOrBottle && typeof optionsOrBottle === 'object') {
    opts = optionsOrBottle;
    if (typeof opts.bottlePath === 'string' && opts.bottlePath.trim()) {
      bottlePath = opts.bottlePath.trim();
    } else if (typeof opts.driveCRoot === 'string' && opts.driveCRoot.trim()) {
      const dc = opts.driveCRoot.trim();
      bottlePath = path.basename(dc).toLowerCase() === 'drive_c' ? path.dirname(dc) : dc;
    }
  }

  if (bottlePath) {
    const driveCRoot = path.join(bottlePath, 'drive_c');
    const pushBottleWinOrPosix = (/** @type {string} */ candidatePath) => {
      if (!candidatePath) return;
      const resolved = candidatePath.startsWith('/')
        ? resolveWineReparseTargetReadOnly(candidatePath, driveCRoot, opts)
        : resolveBottleWindowsPathReadOnly(candidatePath, bottlePath, opts);
      pushRoot(resolved);
    };

    const machineIni = resolveDriveCPathCaseInsensitive(driveCRoot, [
      'ProgramData',
      'EA Desktop',
      'machine.ini',
    ]);
    const machineDir = extractEaIniDownloadInPlaceDir(machineIni);
    if (machineDir) pushBottleWinOrPosix(machineDir);

    for (const userDir of listBottleUserDirectories(bottlePath)) {
      const eaDesktopLocal = resolveDriveCPathCaseInsensitive(userDir, [
        'AppData',
        'Local',
        'Electronic Arts',
        'EA Desktop',
      ]);
      const originRoaming = resolveDriveCPathCaseInsensitive(userDir, [
        'AppData',
        'Roaming',
        'Origin',
      ]);
      collectConfiguredEaDirsFromProfile(eaDesktopLocal, originRoaming, pushBottleWinOrPosix);
    }

    for (const relSegs of [
      ['Program Files', 'EA Games'],
      ['Program Files (x86)', 'EA Games'],
      ['Program Files (x86)', 'Origin Games'],
      ['Program Files', 'Origin Games'],
    ]) {
      pushBottleWinOrPosix(resolveDriveCPathCaseInsensitive(driveCRoot, relSegs));
    }

    return roots;
  }

  const platform = String(opts.platform || process.platform).toLowerCase();

  if (platform === 'win32') {
    const winDirs = resolveWin32HostEnvDirs(opts);
    const machineDir = extractEaIniDownloadInPlaceDir(
      path.join(winDirs.programData, 'EA Desktop', 'machine.ini')
    );
    if (machineDir) pushRoot(machineDir);

    collectConfiguredEaDirsFromProfile(
      path.join(winDirs.localAppData, 'Electronic Arts', 'EA Desktop'),
      path.join(winDirs.roamingAppData, 'Origin'),
      pushRoot
    );

    pushRoot(path.join(winDirs.programFiles, 'EA Games'));
    pushRoot(path.join(winDirs.programFilesX86, 'EA Games'));
    pushRoot(path.join(winDirs.programFilesX86, 'Origin Games'));
    pushRoot(path.join(winDirs.programFiles, 'Origin Games'));

    if (Array.isArray(opts.mountedDrives)) {
      for (const drv of opts.mountedDrives) {
        const cleanDrv = String(drv || '').trim();
        if (!cleanDrv) continue;
        pushRoot(path.join(cleanDrv, 'EA Games'));
        pushRoot(path.join(cleanDrv, 'Origin Games'));
      }
    }

    if (Array.isArray(opts.customRoots)) {
      for (const cr of opts.customRoots) {
        const cleanCr = String(cr || '').trim();
        if (!cleanCr) continue;
        const baseLower = path.basename(cleanCr).toLowerCase();
        if (baseLower === 'ea games' || baseLower === 'origin games') {
          pushRoot(cleanCr);
        } else {
          pushRoot(path.join(cleanCr, 'EA Games'));
          pushRoot(path.join(cleanCr, 'Origin Games'));
        }
      }
    }

    if (winDirs.explicitSysDrive && !/^[a-zA-Z]:[\\/]?$/.test(winDirs.explicitSysDrive)) {
      pushRoot(path.join(winDirs.explicitSysDrive, 'EA Games'));
      pushRoot(path.join(winDirs.explicitSysDrive, 'Origin Games'));
    } else if (!winDirs.sandboxHome && process.platform === 'win32') {
      for (let code = 67 /* 'C' */; code <= 90 /* 'Z' */; code += 1) {
        const driveRoot = `${String.fromCharCode(code)}:\\`;
        try {
          if (fs.existsSync(driveRoot)) {
            pushRoot(`${driveRoot}EA Games`);
            pushRoot(`${driveRoot}Origin Games`);
          }
        } catch {}
      }
    } else if (winDirs.sandboxHome) {
      pushRoot(path.join(winDirs.sandboxHome, 'EA Games'));
      pushRoot(path.join(winDirs.sandboxHome, 'Origin Games'));
    }

    return roots;
  }

  if (platform === 'darwin') {
    const macDirs = resolveDarwinHostEnvDirs(opts);
    const macMachineIni = macDirs.isIsolatedSandbox
      ? macDirs.sandboxHome
        ? path.join(
            macDirs.sandboxHome,
            'Library',
            'Application Support',
            'Electronic Arts',
            'EA app',
            'machine.ini'
          )
        : ''
      : '/Library/Application Support/Electronic Arts/EA app/machine.ini';
    const macMachineDir = extractEaIniDownloadInPlaceDir(macMachineIni);
    if (macMachineDir) pushRoot(macMachineDir);

    collectConfiguredEaDirsFromProfile(
      path.join(macDirs.home, 'Library', 'Application Support', 'Electronic Arts', 'EA app'),
      '',
      pushRoot
    );

    pushRoot(path.join(macDirs.home, 'Applications', 'EA Games'));
    if (!macDirs.isIsolatedSandbox) {
      pushRoot('/Applications/EA Games');
      pushRoot('/Users/Shared/EA Games');
    } else if (macDirs.customAppsDir) {
      pushRoot(path.join(macDirs.customAppsDir, 'EA Games'));
    }
  }

  return roots;
}

/**
 * Extract `misc.game_installation_path` / `game_installation_path` from Ubisoft Connect
 * `settings.yaml` (`175.x` `%LOCALAPPDATA%`) or legacy `settings.yml`.
 *
 * @param {string} ubiDir
 * @returns {string}
 */
function readUbisoftCustomGamesDirSetting(ubiDir) {
  if (!ubiDir) return '';
  for (const name of ['settings.yaml', 'settings.yml']) {
    const p = resolveDriveCPathCaseInsensitive(ubiDir, [name]);
    try {
      if (!p || !fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      const m = text.match(/^\s*(?:misc\.)?game_installation_path\s*:\s*(.+)$/im);
      if (m && m[1]) {
        const val = m[1]
          .replace(/\s+#.*$/, '')
          .trim()
          .replace(/^["']+|["']+$/g, '');
        if (val && val.toLowerCase() !== 'null' && val !== '~') {
          return val;
        }
      }
    } catch {}
  }
  return '';
}

/**
 * Extract `product_install_full_path` from Riot `*.product_settings.yaml`.
 *
 * @param {string} yamlText
 * @returns {string}
 */
function parseRiotProductInstallFullPath(yamlText) {
  if (!yamlText || typeof yamlText !== 'string') return '';
  const match = yamlText.match(/^\s*product_install_full_path\s*:\s*(.+)$/im);
  if (!match || !match[1]) return '';
  return match[1].trim().replace(/^["']+|["']+$/g, '');
}

/**
 * Scan `Riot Games/Metadata/*.live/*.product_settings.yaml` for installed Riot games.
 *
 * @param {string} metadataRoot
 * @param {(productId: string, installFullPath: string) => void} onEntry
 */
function scanRiotMetadataDirectory(metadataRoot, onEntry) {
  if (!metadataRoot) return;
  try {
    if (!fs.existsSync(metadataRoot)) return;
    for (const dirEntry of fs.readdirSync(metadataRoot, { withFileTypes: true })) {
      if (!dirEntry.isDirectory() || !dirEntry.name.toLowerCase().endsWith('.live')) continue;
      const productId = dirEntry.name.slice(0, -'.live'.length);
      if (!productId || productId.toLowerCase() === 'riot_client') continue;
      const subDir = path.join(metadataRoot, dirEntry.name);
      for (const f of fs.readdirSync(subDir, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.toLowerCase().endsWith('.product_settings.yaml')) continue;
        try {
          const installPath = parseRiotProductInstallFullPath(
            fs.readFileSync(path.join(subDir, f.name), 'utf8')
          );
          if (installPath) onEntry(productId, installPath);
        } catch {}
      }
    }
  } catch {}
}

/**
 * Walk 0–3 parent directories upward from `gameExecutablePath` (and optional `installPath`)
 * to auto-resolve EA `contentId` from `<dir>/__Installer/installerdata.xml`.
 *
 * @param {string} gameExePath
 * @param {string} [installPathHint]
 * @returns {string}
 */
function resolveEaContentIdNearExecutable(gameExePath, installPathHint = '') {
  /** @type {string[]} */
  const candidateDirs = [];
  if (installPathHint) candidateDirs.push(installPathHint);
  if (gameExePath) {
    let cur = path.dirname(gameExePath);
    for (let hop = 0; hop <= 3; hop += 1) {
      if (!cur || cur === '.' || cur === '/' || /^[a-zA-Z]:[\\/]?$/.test(cur)) break;
      if (!candidateDirs.includes(cur)) candidateDirs.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  for (const dir of candidateDirs) {
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      const xmlMeta = readEaXmlMetadataInDir(dir, { caseInsensitive: true });
      if (xmlMeta.contentId) return xmlMeta.contentId;
    } catch {}
  }
  return '';
}

// ============================================================================
// Unified Publisher Game Scanning Engine (Bottle + Win32 Host + Darwin Host)
// ============================================================================

/**
 * Create a unified deduplicating collector for discovered publisher games across bottle or host roots.
 *
 * @param {{
 *   resolveInstallPath: (rawInstallPath: string) => string,
 *   resolveExeHint?: (rawExeHint: string) => string,
 *   bottlePath?: string,
 *   bottleName?: string,
 * }} config
 */
function createPublisherGameCollector(config) {
  /** @type {ScannedPublisherInstalledGame[]} */
  const discovered = [];
  /** @type {Set<string>} */
  const seenKeys = new Set();

  /**
   * @param {ChainedHandoffId} handoffId
   * @param {string} rawInstallPath
   * @param {{
   *   externalInstallId?: string,
   *   tactUid?: string,
   *   launchProductCode?: string,
   *   title?: string,
   *   exeHint?: string,
   *   allowMacAppBundles?: boolean,
   * }} [meta]
   */
  const tryAddGame = (handoffId, rawInstallPath, meta = {}) => {
    const cleanedInput = String(rawInstallPath || '')
      .trim()
      .replace(/^"+|"+$/g, '');
    if (!cleanedInput || STEAMAPPS_COMMON_PATH_RE.test(cleanedInput)) return;

    const hostInstallPath = config.resolveInstallPath(cleanedInput);
    if (!hostInstallPath || STEAMAPPS_COMMON_PATH_RE.test(hostInstallPath)) return;

    let resolvedInstallPath = hostInstallPath;
    try {
      if (!fs.existsSync(hostInstallPath)) return;
      if (!fs.statSync(hostInstallPath).isDirectory()) return;
      resolvedInstallPath = path.resolve(hostInstallPath);
    } catch {
      return;
    }
    if (STEAMAPPS_COMMON_PATH_RE.test(resolvedInstallPath)) return;

    const dedupeKey = `${handoffId}::${resolvedInstallPath.toLowerCase()}`;
    if (seenKeys.has(dedupeKey)) return;

    const exeHint = meta.exeHint
      ? config.resolveExeHint
        ? config.resolveExeHint(meta.exeHint)
        : meta.exeHint
      : '';
    const { executablePath, approxSizeBytes } = findPrimaryPublisherGameExecutable(
      hostInstallPath,
      exeHint,
      { allowMacAppBundles: Boolean(meta.allowMacAppBundles) }
    );
    if (!executablePath) return;

    seenKeys.add(dedupeKey);
    const title = (meta.title || '').trim() || path.basename(hostInstallPath);
    const cleanExternal = meta.externalInstallId ? String(meta.externalInstallId).trim() : '';
    const cleanTactUid = meta.tactUid
      ? String(meta.tactUid).trim()
      : handoffId === 'bnet' && cleanExternal
        ? cleanExternal
        : '';
    const cleanLaunchCode = meta.launchProductCode
      ? String(meta.launchProductCode).trim()
      : handoffId === 'bnet' && (cleanExternal || cleanTactUid)
        ? normalizeBattleNetLaunchProductCode(cleanExternal || cleanTactUid)
        : '';

    discovered.push({
      handoffId,
      ...(cleanExternal ? { externalInstallId: cleanExternal } : {}),
      ...(cleanTactUid ? { tactUid: cleanTactUid } : {}),
      ...(cleanLaunchCode ? { launchProductCode: cleanLaunchCode } : {}),
      title,
      installPath: hostInstallPath,
      executablePath,
      ...(approxSizeBytes > 0 ? { installSizeBytes: approxSizeBytes } : {}),
      ...(config.bottlePath ? { bottlePath: config.bottlePath } : {}),
      ...(config.bottleName ? { bottleName: config.bottleName } : {}),
    });
  };

  return { discovered, tryAddGame };
}

/**
 * Index Battle.net `product.db` installed entries by resolved lowercase path.
 *
 * @param {BattleNetProductDbInstallEntry[]} entries
 * @param {(rawPath: string) => string} resolvePath
 * @returns {Map<string, BattleNetProductDbInstallEntry>}
 */
function indexBattleNetProductDbByPath(entries, resolvePath) {
  /** @type {Map<string, BattleNetProductDbInstallEntry>} */
  const map = new Map();
  for (const dbEntry of entries) {
    if (dbEntry.hasCachedState && !dbEntry.installed && !dbEntry.playable) continue;
    if (!dbEntry.installPath) continue;
    const hostDir = resolvePath(dbEntry.installPath);
    if (hostDir) {
      map.set(path.resolve(hostDir).toLowerCase(), dbEntry);
    }
  }
  return map;
}

/**
 * Register all active Battle.net `product.db` entries into `tryAddGame`.
 *
 * @param {BattleNetProductDbInstallEntry[]} entries
 * @param {ReturnType<typeof createPublisherGameCollector>['tryAddGame']} tryAddGame
 * @param {{ allowMacAppBundles?: boolean }} [opts]
 */
function addBattleNetProductDbEntries(entries, tryAddGame, opts = {}) {
  for (const dbEntry of entries) {
    if (dbEntry.hasCachedState && !dbEntry.installed && !dbEntry.playable) continue;
    if (!dbEntry.installPath) continue;
    const rawUid = dbEntry.uid || dbEntry.productCode;
    tryAddGame('bnet', dbEntry.installPath, {
      externalInstallId: rawUid || undefined,
      tactUid: dbEntry.uid || rawUid || undefined,
      launchProductCode:
        dbEntry.launchProductCode ||
        (rawUid ? normalizeBattleNetLaunchProductCode(rawUid) : undefined),
      ...(opts.allowMacAppBundles ? { allowMacAppBundles: true } : {}),
    });
  }
}

/**
 * Unified classification of a Windows/Wine `CurrentVersion\Uninstall\<subKey>` entry across
 * EA (`installerdata.xml`), Battle.net (`.build.info` / `product.db` / Blizzard), and Rockstar.
 *
 * @param {string} subKeyName
 * @param {Record<string, string>} props
 * @param {{
 *   resolvePath: (rawPath: string) => string,
 *   bnetDbByPath: Map<string, BattleNetProductDbInstallEntry>,
 *   tryAddGame: ReturnType<typeof createPublisherGameCollector>['tryAddGame'],
 *   caseInsensitiveXml?: boolean,
 * }} ctx
 */
function classifyUninstallRegistryGameEntry(subKeyName, props, ctx) {
  const keyLower = subKeyName.toLowerCase();
  if (keyLower === 'battle.net' || keyLower.startsWith('uplay install ')) return;

  const installLoc = getRegistryPropCaseInsensitive(props, 'InstallLocation');
  if (!installLoc) return;
  const dispName = getRegistryPropCaseInsensitive(props, 'DisplayName');
  const publisher = getRegistryPropCaseInsensitive(props, 'Publisher');
  const uninstStr = getRegistryPropCaseInsensitive(props, 'UninstallString');
  const dispIcon = getRegistryPropCaseInsensitive(props, 'DisplayIcon');

  const hostLoc = ctx.resolvePath(installLoc);
  if (!hostLoc || !fs.existsSync(hostLoc)) return;

  // 1. EA game with `__Installer/installerdata.xml` (excluding EA App client itself)
  if (!/^ea\s+(?:app|desktop)$/i.test(dispName)) {
    const xmlMeta = readEaXmlMetadataInDir(hostLoc, {
      caseInsensitive: Boolean(ctx.caseInsensitiveXml),
    });
    if (xmlMeta.found) {
      ctx.tryAddGame('ea', hostLoc, {
        externalInstallId: xmlMeta.contentId || undefined,
        title: dispName || xmlMeta.title,
        exeHint: xmlMeta.launcherRelExe || dispIcon,
      });
      return;
    }
  }

  // 2. Battle.net / Blizzard Uninstall entry
  const matchedDbEntry = ctx.bnetDbByPath.get(path.resolve(hostLoc).toLowerCase());
  if (
    matchedDbEntry ||
    /blizzard|battle\.net/i.test(publisher) ||
    /battle\.net|blizzard/i.test(uninstStr) ||
    fs.existsSync(path.join(hostLoc, '.build.info'))
  ) {
    if (/^battle\.net$/i.test(dispName)) return;
    const bnetId =
      extractBattleNetProductId(hostLoc, uninstStr) ||
      matchedDbEntry?.uid ||
      matchedDbEntry?.productCode ||
      '';
    ctx.tryAddGame('bnet', hostLoc, {
      externalInstallId: bnetId || undefined,
      tactUid: matchedDbEntry?.uid || bnetId || undefined,
      launchProductCode:
        matchedDbEntry?.launchProductCode ||
        (bnetId ? normalizeBattleNetLaunchProductCode(bnetId) : undefined),
      title: dispName,
      exeHint: dispIcon,
    });
    return;
  }

  // 3. Rockstar Games Uninstall entry (excluding Launcher & Social Club)
  if (/rockstar games/i.test(publisher) || /^rockstar games\s+/i.test(keyLower)) {
    if (
      /^(?:rockstar games\s+)?(?:launcher|social club)$/i.test(dispName) ||
      /^rockstar games\s+(?:launcher|social club)$/i.test(keyLower)
    ) {
      return;
    }
    ctx.tryAddGame('rockstar', hostLoc, {
      title: dispName || subKeyName.replace(/^rockstar games\s+/i, ''),
      exeHint: dispIcon,
    });
  }
}

/**
 * Scan candidate library directories with optional Wine reparse resolution and invoke `onGameDir`
 * for every direct child game directory.
 *
 * @param {string[]} rootDirs
 * @param {(gameDir: string, cleanDirName: string) => void} onGameDir
 * @param {{ resolveDir?: (rawDir: string) => string, stripTrailingQuestion?: boolean, skipLowerNames?: Set<string> }} [opts]
 */
function scanPublisherLibraryRootSubdirs(rootDirs, onGameDir, opts = {}) {
  const resolveDir = opts.resolveDir || ((p) => p);
  for (const rawRoot of rootDirs) {
    if (!rawRoot) continue;
    try {
      const resolvedRoot = resolveDir(rawRoot);
      if (!resolvedRoot || !fs.existsSync(resolvedRoot)) continue;
      for (const sub of fs.readdirSync(resolvedRoot, { withFileTypes: true })) {
        if (!sub.name || sub.name.startsWith('.')) continue;
        const rawChild = path.join(resolvedRoot, sub.name);
        const resolvedChild = resolveDir(rawChild);
        if (!sub.isDirectory() && resolvedChild === rawChild) continue;
        const cleanName = opts.stripTrailingQuestion ? sub.name.replace(/\?$/, '') : sub.name;
        if (opts.skipLowerNames && opts.skipLowerNames.has(cleanName.toLowerCase())) continue;
        onGameDir(resolvedChild, cleanName);
      }
    } catch {}
  }
}

/**
 * Scan Battle.net parent directories (`Program Files`, `DefaultInstallPath`, etc.) for `.build.info`.
 *
 * @param {string[]} parentRoots
 * @param {ReturnType<typeof createPublisherGameCollector>['tryAddGame']} tryAddGame
 * @param {{ resolveDir?: (rawDir: string) => string, stripTrailingQuestion?: boolean }} [opts]
 */
function scanBattleNetParentRoots(parentRoots, tryAddGame, opts = {}) {
  const resolveDir = opts.resolveDir || ((p) => p);
  for (const progDir of parentRoots) {
    if (!progDir) continue;
    try {
      if (!fs.existsSync(progDir)) continue;
      if (
        fs.existsSync(path.join(progDir, '.build.info')) &&
        path.basename(progDir).toLowerCase() !== 'battle.net'
      ) {
        const directBnetId = extractBattleNetProductId(progDir);
        tryAddGame('bnet', progDir, {
          externalInstallId: directBnetId || undefined,
          tactUid: directBnetId || undefined,
          launchProductCode: directBnetId
            ? normalizeBattleNetLaunchProductCode(directBnetId)
            : undefined,
          title: path.basename(progDir),
        });
      }
      for (const sub of fs.readdirSync(progDir, { withFileTypes: true })) {
        if (!sub.name || sub.name.startsWith('.')) continue;
        if (sub.name.toLowerCase() === 'battle.net') continue;
        const rawCandidateDir = path.join(progDir, sub.name);
        const candidateDir = resolveDir(rawCandidateDir);
        if (!sub.isDirectory() && candidateDir === rawCandidateDir) continue;
        if (fs.existsSync(path.join(candidateDir, '.build.info'))) {
          const bnetId = extractBattleNetProductId(candidateDir);
          tryAddGame('bnet', candidateDir, {
            externalInstallId: bnetId || undefined,
            tactUid: bnetId || undefined,
            launchProductCode: bnetId ? normalizeBattleNetLaunchProductCode(bnetId) : undefined,
            title: opts.stripTrailingQuestion ? sub.name.replace(/\?$/, '') : sub.name,
          });
        }
      }
    } catch {}
  }
}

/**
 * Collect Ubisoft custom `settings.yaml/yml` directories and default launcher `games` roots
 * for a Wine/CrossOver bottle (shared by bottle game scanner & staging-dir resolver).
 *
 * @param {string} bottlePath
 * @param {string} driveCRoot
 * @param {Map<string, Record<string, string>>} sections
 * @param {string[]} userDirs
 * @returns {{ customWinDirs: string[], launcherGamesDir: string, legacyX86GamesDir: string, legacyX64GamesDir: string }}
 */
function collectBottleUbisoftPaths(bottlePath, driveCRoot, sections, userDirs) {
  const ubiLegacyX86 = resolveDriveCPathCaseInsensitive(driveCRoot, [
    'Program Files (x86)',
    'Ubisoft',
    'Ubisoft Game Launcher',
  ]);
  const ubiLegacyX64 = resolveDriveCPathCaseInsensitive(driveCRoot, [
    'Program Files',
    'Ubisoft',
    'Ubisoft Game Launcher',
  ]);
  const ubiLauncherInfo = discoverBottlePublisherLauncher(bottlePath, 'ubisoft', {
    parsedSystemReg: sections,
  });
  /** @type {string[]} */
  const customWinDirs = [];
  for (const cfgDir of [
    ...userDirs.map((u) =>
      resolveDriveCPathCaseInsensitive(u, ['AppData', 'Local', 'Ubisoft Game Launcher'])
    ),
    ubiLauncherInfo.installDir || '',
    ubiLegacyX86,
    ubiLegacyX64,
  ]) {
    if (!cfgDir) continue;
    const custom = readUbisoftCustomGamesDirSetting(cfgDir);
    if (custom) customWinDirs.push(custom);
  }
  return {
    customWinDirs,
    launcherGamesDir: ubiLauncherInfo.installDir
      ? resolveDriveCPathCaseInsensitive(ubiLauncherInfo.installDir, ['games'])
      : '',
    legacyX86GamesDir: resolveDriveCPathCaseInsensitive(ubiLegacyX86, ['games']),
    legacyX64GamesDir: resolveDriveCPathCaseInsensitive(ubiLegacyX64, ['games']),
  };
}

/**
 * Collect Battle.net `DefaultInstallPath` settings across all bottle user profiles.
 *
 * @param {string[]} userDirs
 * @returns {string[]}
 */
function collectBottleBattleNetDefaultDirs(userDirs) {
  /** @type {string[]} */
  const dirs = [];
  for (const userDir of userDirs) {
    const bnetCfg = resolveDriveCPathCaseInsensitive(userDir, [
      'AppData',
      'Roaming',
      'Battle.net',
      'Battle.net.config',
    ]);
    const defDir = readBattleNetDefaultInstallPathFromConfig(bnetCfg);
    if (defDir) dirs.push(defDir);
  }
  return dirs;
}

const ROCKSTAR_SKIP_DIR_NAMES = new Set(['launcher', 'social club']);
const MAC_EA_SKIP_DIR_NAMES = new Set(['ea app.app']);

/**
 * Scan a macOS Wine/CrossOver bottle for installed games managed by chained publisher launchers
 * (`ubisoft`, `ea`, `bnet`, `rockstar`). Strictly read-only (`0` disk writes).
 *
 * @param {string} bottlePath
 * @param {Record<string, any>} [options]
 * @returns {ScannedPublisherInstalledGame[]}
 */
function scanBottlePublisherInstalledGames(bottlePath, options = {}) {
  if (!bottlePath) return [];
  const driveCRoot = path.join(bottlePath, 'drive_c');
  try {
    if (!fs.existsSync(driveCRoot)) return [];
  } catch {
    return [];
  }

  const bottleName =
    typeof options.bottleName === 'string' && options.bottleName.trim()
      ? options.bottleName.trim()
      : path.basename(bottlePath);

  const sections = getBottleSystemRegSections(bottlePath, options);
  const bottleUserDirs = listBottleUserDirectories(bottlePath);

  const resolveBottlePath = (/** @type {string} */ rawPath) =>
    rawPath.startsWith('/')
      ? resolveWineReparseTargetReadOnly(rawPath, driveCRoot, options)
      : resolveBottleWindowsPathReadOnly(rawPath, bottlePath, options);
  const resolveReparse = (/** @type {string} */ rawPath) =>
    resolveWineReparseTargetReadOnly(rawPath, driveCRoot, options);

  const { discovered, tryAddGame } = createPublisherGameCollector({
    resolveInstallPath: resolveBottlePath,
    resolveExeHint: (hint) =>
      !hint.startsWith('/') && /^[a-zA-Z]:[\\/]/.test(hint)
        ? resolveBottleWindowsPathReadOnly(hint, bottlePath, options)
        : hint,
    bottlePath,
    bottleName,
  });

  // Pre-parse Battle.net Agent `product.db` inside bottle
  const bottleProductDbEntries = readBattleNetProductDbFileReadOnly(
    resolveDriveCPathCaseInsensitive(driveCRoot, ['ProgramData', 'Battle.net', 'Agent', 'product.db'])
  );
  const bnetDbByResolvedPath = indexBattleNetProductDbByPath(
    bottleProductDbEntries,
    resolveBottlePath
  );

  // 1. Registry sections: Ubisoft Installs/Uninstall, EA Games, Rockstar Games, and general Uninstall
  /** @type {Map<string, { installDir?: string, title?: string, iconExe?: string }>} */
  const ubiById = new Map();

  for (const [secKey, props] of sections.entries()) {
    const ubiInstallMatch = secKey.match(
      /^software\\(?:wow6432node\\)?ubisoft\\launcher\\installs\\([^\\]+)$/i
    );
    if (ubiInstallMatch && ubiInstallMatch[1]) {
      const uplayId = ubiInstallMatch[1].trim();
      const entry = ubiById.get(uplayId) || {};
      const dir = getRegistryPropCaseInsensitive(props, 'InstallDir');
      if (dir) entry.installDir = dir;
      ubiById.set(uplayId, entry);
      continue;
    }

    const ubiUninstMatch = secKey.match(
      /^software\\(?:wow6432node\\)?microsoft\\windows\\currentversion\\uninstall\\uplay install\s+(.+)$/i
    );
    if (ubiUninstMatch && ubiUninstMatch[1]) {
      const uplayId = ubiUninstMatch[1].trim();
      const entry = ubiById.get(uplayId) || {};
      const loc = getRegistryPropCaseInsensitive(props, 'InstallLocation');
      const dispName = getRegistryPropCaseInsensitive(props, 'DisplayName');
      const dispIcon = getRegistryPropCaseInsensitive(props, 'DisplayIcon');
      if (loc && !entry.installDir) entry.installDir = loc;
      if (dispName) entry.title = dispName;
      if (dispIcon) entry.iconExe = dispIcon;
      ubiById.set(uplayId, entry);
      continue;
    }

    const eaRegMatch = secKey.match(
      /^software\\(?:wow6432node\\)?(?:ea games|origin games)\\([^\\]+)$/i
    );
    if (eaRegMatch && eaRegMatch[1]) {
      const rawEaDir =
        getRegistryPropCaseInsensitive(props, 'Install Dir') ||
        getRegistryPropCaseInsensitive(props, 'InstallLocation');
      if (rawEaDir) {
        const hostEaDir = resolveBottleWindowsPathReadOnly(rawEaDir, bottlePath, options);
        if (hostEaDir && fs.existsSync(hostEaDir)) {
          const xmlMeta = readEaXmlMetadataInDir(hostEaDir, { caseInsensitive: true });
          const dispName = getRegistryPropCaseInsensitive(props, 'DisplayName');
          tryAddGame('ea', hostEaDir, {
            externalInstallId: xmlMeta.contentId || undefined,
            title: dispName || xmlMeta.title || eaRegMatch[1].trim(),
            exeHint: xmlMeta.launcherRelExe,
          });
        }
      }
      continue;
    }

    if (/^software\\(?:wow6432node\\)?microsoft\\windows\\currentversion\\uninstall\\[^\\]+$/i.test(secKey)) {
      const subKeyName = secKey.split('\\').pop() || '';
      classifyUninstallRegistryGameEntry(subKeyName, props, {
        resolvePath: (p) => resolveBottleWindowsPathReadOnly(p, bottlePath, options),
        bnetDbByPath: bnetDbByResolvedPath,
        tryAddGame,
        caseInsensitiveXml: true,
      });
      continue;
    }

    const rockstarMatch = secKey.match(/^software\\(?:wow6432node\\)?rockstar games\\([^\\]+)$/i);
    if (rockstarMatch && rockstarMatch[1]) {
      const subKey = rockstarMatch[1].trim();
      if (!ROCKSTAR_SKIP_DIR_NAMES.has(subKey.toLowerCase())) {
        const installFolder =
          getRegistryPropCaseInsensitive(props, 'InstallFolder') ||
          getRegistryPropCaseInsensitive(props, 'InstallLocation');
        if (installFolder) {
          tryAddGame('rockstar', installFolder, {
            title: getRegistryPropCaseInsensitive(props, 'Title') || subKey,
          });
        }
      }
    }
  }

  for (const [uplayId, info] of ubiById.entries()) {
    if (info.installDir) {
      tryAddGame('ubisoft', info.installDir, {
        externalInstallId: uplayId,
        title: info.title,
        exeHint: info.iconExe,
      });
    }
  }

  // 2. Ubisoft games/* directories & settings.yaml/yml
  const ubiPaths = collectBottleUbisoftPaths(bottlePath, driveCRoot, sections, bottleUserDirs);
  /** @type {string[]} */
  const ubiGamesRoots = [
    ubiPaths.legacyX86GamesDir,
    ubiPaths.legacyX64GamesDir,
    ...(ubiPaths.launcherGamesDir ? [ubiPaths.launcherGamesDir] : []),
    ...ubiPaths.customWinDirs.map(resolveBottlePath).filter(Boolean),
  ];
  scanPublisherLibraryRootSubdirs(
    ubiGamesRoots,
    (gameDir, cleanName) => {
      tryAddGame('ubisoft', gameDir, { title: cleanName });
    },
    { resolveDir: resolveReparse, stripTrailingQuestion: true }
  );

  // 3. EA configured library roots
  scanPublisherLibraryRootSubdirs(
    readEaConfiguredLibraryRoots({ ...options, bottlePath }),
    (gameDir, cleanName) => {
      const xmlMeta = readEaXmlMetadataInDir(gameDir, { caseInsensitive: true });
      tryAddGame('ea', gameDir, {
        externalInstallId: xmlMeta.contentId || undefined,
        title: xmlMeta.title || cleanName,
        exeHint: xmlMeta.launcherRelExe,
      });
    },
    { resolveDir: resolveReparse, stripTrailingQuestion: true }
  );

  // 4. Battle.net `product.db` + `DefaultInstallPath` + Program Files `.build.info`
  addBattleNetProductDbEntries(bottleProductDbEntries, tryAddGame);

  /** @type {string[]} */
  const bnetParentScanRoots = [
    resolveDriveCPathCaseInsensitive(driveCRoot, ['Program Files (x86)']),
    resolveDriveCPathCaseInsensitive(driveCRoot, ['Program Files']),
    ...collectBottleBattleNetDefaultDirs(bottleUserDirs).map(resolveBottlePath).filter(Boolean),
  ];
  scanBattleNetParentRoots(bnetParentScanRoots, tryAddGame, {
    resolveDir: resolveReparse,
    stripTrailingQuestion: true,
  });

  // 5. Rockstar Program Files fallback
  scanPublisherLibraryRootSubdirs(
    [
      resolveDriveCPathCaseInsensitive(driveCRoot, ['Program Files', 'Rockstar Games']),
      resolveDriveCPathCaseInsensitive(driveCRoot, ['Program Files (x86)', 'Rockstar Games']),
    ],
    (gameDir, cleanName) => {
      tryAddGame('rockstar', gameDir, { title: cleanName });
    },
    { skipLowerNames: ROCKSTAR_SKIP_DIR_NAMES }
  );

  return discovered;
}

/**
 * Scan the host OS (`win32` or `darwin`) for installed games managed by chained publisher launchers
 * (`ubisoft`, `ea`, `bnet`, `rockstar`, `riot`). Strictly read-only (`0` disk writes).
 *
 * @param {Record<string, any>} [options]
 * @returns {ScannedPublisherInstalledGame[]}
 */
function scanHostPublisherInstalledGames(options = {}) {
  const platform = String(options.platform || process.platform).toLowerCase();
  const { discovered, tryAddGame } = createPublisherGameCollector({
    resolveInstallPath: (p) => p,
  });

  if (platform === 'win32') {
    const winDirs = resolveWin32HostEnvDirs(options);
    const hostProductDbEntries = readBattleNetProductDbFileReadOnly(
      path.join(winDirs.programData, 'Battle.net', 'Agent', 'product.db')
    );
    const hostBnetDbByPath = indexBattleNetProductDbByPath(hostProductDbEntries, (p) => p);

    const subkeys = enumerateWindowsRegistrySubkeys(
      [
        'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs',
        'HKLM\\SOFTWARE\\Ubisoft\\Launcher\\Installs',
        'HKLM\\SOFTWARE\\WOW6432Node\\EA Games',
        'HKLM\\SOFTWARE\\EA Games',
        'HKLM\\SOFTWARE\\WOW6432Node\\Origin Games',
        'HKLM\\SOFTWARE\\Origin Games',
        'HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games',
        'HKLM\\SOFTWARE\\Rockstar Games',
        'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      ],
      options
    );

    /** @type {Map<string, { installDir?: string, title?: string, iconExe?: string }>} */
    const ubiById = new Map();

    for (const item of subkeys) {
      const fullLower = item.fullKeyPath.toLowerCase();
      const keyLower = item.keyName.toLowerCase();

      if (fullLower.includes('\\ubisoft\\launcher\\installs\\')) {
        const uplayId = item.keyName.trim();
        const entry = ubiById.get(uplayId) || {};
        const dir = getRegistryPropCaseInsensitive(item.properties, 'InstallDir');
        if (dir) entry.installDir = dir;
        ubiById.set(uplayId, entry);
        continue;
      }

      if (
        (fullLower.includes('\\ea games\\') || fullLower.includes('\\origin games\\')) &&
        !fullLower.includes('\\currentversion\\uninstall\\')
      ) {
        const eaDir =
          getRegistryPropCaseInsensitive(item.properties, 'Install Dir') ||
          getRegistryPropCaseInsensitive(item.properties, 'InstallLocation');
        if (eaDir) {
          const xmlMeta = readEaXmlMetadataInDir(eaDir);
          const dispName = getRegistryPropCaseInsensitive(item.properties, 'DisplayName');
          tryAddGame('ea', eaDir, {
            externalInstallId: xmlMeta.contentId || undefined,
            title: dispName || xmlMeta.title || item.keyName,
            exeHint: xmlMeta.launcherRelExe,
          });
        }
        continue;
      }

      if (
        fullLower.includes('\\rockstar games\\') &&
        !fullLower.includes('\\currentversion\\uninstall\\')
      ) {
        if (!ROCKSTAR_SKIP_DIR_NAMES.has(keyLower)) {
          const installFolder =
            getRegistryPropCaseInsensitive(item.properties, 'InstallFolder') ||
            getRegistryPropCaseInsensitive(item.properties, 'InstallLocation');
          if (installFolder) {
            tryAddGame('rockstar', installFolder, {
              title: getRegistryPropCaseInsensitive(item.properties, 'Title') || item.keyName,
            });
          }
        }
        continue;
      }

      if (fullLower.includes('\\currentversion\\uninstall\\')) {
        if (keyLower.startsWith('uplay install ')) {
          const uplayId = item.keyName.slice('uplay install '.length).trim();
          const entry = ubiById.get(uplayId) || {};
          const loc = getRegistryPropCaseInsensitive(item.properties, 'InstallLocation');
          const dispName = getRegistryPropCaseInsensitive(item.properties, 'DisplayName');
          const dispIcon = getRegistryPropCaseInsensitive(item.properties, 'DisplayIcon');
          if (loc && !entry.installDir) entry.installDir = loc;
          if (dispName) entry.title = dispName;
          if (dispIcon) entry.iconExe = dispIcon;
          ubiById.set(uplayId, entry);
          continue;
        }
        classifyUninstallRegistryGameEntry(item.keyName, item.properties, {
          resolvePath: (p) => p,
          bnetDbByPath: hostBnetDbByPath,
          tryAddGame,
        });
      }
    }

    for (const [uplayId, info] of ubiById.entries()) {
      if (info.installDir) {
        tryAddGame('ubisoft', info.installDir, {
          externalInstallId: uplayId,
          title: info.title,
          exeHint: info.iconExe,
        });
      }
    }

    // Ubisoft filesystem fallback
    const ubiHostInfo = discoverWindowsPublisherLauncherPaths('ubisoft', options);
    const ubiGamesDirs = [
      ubiHostInfo.installDir ? path.join(ubiHostInfo.installDir, 'games') : '',
      path.join(winDirs.programFilesX86, 'Ubisoft', 'Ubisoft Game Launcher', 'games'),
      path.join(winDirs.programFiles, 'Ubisoft', 'Ubisoft Game Launcher', 'games'),
      readUbisoftCustomGamesDirSetting(path.join(winDirs.localAppData, 'Ubisoft Game Launcher')),
      ubiHostInfo.installDir ? readUbisoftCustomGamesDirSetting(ubiHostInfo.installDir) : '',
      readUbisoftCustomGamesDirSetting(
        path.join(winDirs.programFilesX86, 'Ubisoft', 'Ubisoft Game Launcher')
      ),
      readUbisoftCustomGamesDirSetting(
        path.join(winDirs.programFiles, 'Ubisoft', 'Ubisoft Game Launcher')
      ),
    ].filter(Boolean);
    scanPublisherLibraryRootSubdirs(ubiGamesDirs, (gameDir, cleanName) => {
      tryAddGame('ubisoft', gameDir, { title: cleanName });
    });

    // EA filesystem fallback
    scanPublisherLibraryRootSubdirs(
      readEaConfiguredLibraryRoots({ ...options, platform: 'win32' }),
      (gameDir, cleanName) => {
        const xmlMeta = readEaXmlMetadataInDir(gameDir);
        tryAddGame('ea', gameDir, {
          externalInstallId: xmlMeta.contentId || undefined,
          title: xmlMeta.title || cleanName,
          exeHint: xmlMeta.launcherRelExe,
        });
      }
    );

    // Battle.net `product.db` + `DefaultInstallPath` + Program Files `.build.info`
    addBattleNetProductDbEntries(hostProductDbEntries, tryAddGame);
    const bnetHostDefaultDir = readBattleNetDefaultInstallPathFromConfig(
      path.join(winDirs.roamingAppData, 'Battle.net', 'Battle.net.config')
    );
    scanBattleNetParentRoots(
      [bnetHostDefaultDir, winDirs.programFilesX86, winDirs.programFiles].filter(Boolean),
      tryAddGame
    );

    // Rockstar filesystem fallback
    scanPublisherLibraryRootSubdirs(
      [
        path.join(winDirs.programFiles, 'Rockstar Games'),
        path.join(winDirs.programFilesX86, 'Rockstar Games'),
      ],
      (gameDir, cleanName) => {
        tryAddGame('rockstar', gameDir, { title: cleanName });
      },
      { skipLowerNames: ROCKSTAR_SKIP_DIR_NAMES }
    );

    // Riot Metadata/*.live/*.product_settings.yaml
    scanRiotMetadataDirectory(path.join(winDirs.programData, 'Riot Games', 'Metadata'), (prodId, installDir) => {
      tryAddGame('riot', installDir, {
        externalInstallId: prodId,
        title: path.basename(installDir),
      });
    });

    return discovered;
  }

  if (platform === 'darwin') {
    const macDirs = resolveDarwinHostEnvDirs(options);
    const macBnetDefaultDir = readBattleNetDefaultInstallPathFromConfig(
      path.join(macDirs.home, 'Library', 'Application Support', 'Battle.net', 'Battle.net.config')
    );
    const appRoots = [...macDirs.baseAppRoots, macBnetDefaultDir].filter(Boolean);

    addBattleNetProductDbEntries(
      readBattleNetProductDbFileReadOnly(macDirs.macBnetProductDbPath),
      tryAddGame,
      { allowMacAppBundles: true }
    );

    const macAppSkip = new Set(['battle.net.app', 'ea app.app', 'riot client.app']);
    scanPublisherLibraryRootSubdirs(
      appRoots,
      (dir, cleanName) => {
        if (fs.existsSync(path.join(dir, '.build.info'))) {
          const bnetId = extractBattleNetProductId(dir);
          tryAddGame('bnet', dir, {
            externalInstallId: bnetId || undefined,
            tactUid: bnetId || undefined,
            launchProductCode: bnetId ? normalizeBattleNetLaunchProductCode(bnetId) : undefined,
            title: cleanName,
            allowMacAppBundles: true,
          });
          return;
        }
        const xmlMeta = readEaXmlMetadataInDir(dir, { includeMacContents: true });
        if (xmlMeta.found) {
          tryAddGame('ea', dir, {
            externalInstallId: xmlMeta.contentId || undefined,
            title: xmlMeta.title || cleanName.replace(/\.app$/i, ''),
            exeHint: xmlMeta.launcherRelExe,
            allowMacAppBundles: true,
          });
        }
      },
      { skipLowerNames: macAppSkip }
    );

    scanPublisherLibraryRootSubdirs(
      readEaConfiguredLibraryRoots({ ...options, platform: 'darwin' }),
      (gameDir, cleanName) => {
        const xmlMeta = readEaXmlMetadataInDir(gameDir, { includeMacContents: true });
        tryAddGame('ea', gameDir, {
          externalInstallId: xmlMeta.contentId || undefined,
          title: xmlMeta.title || cleanName.replace(/\.app$/i, ''),
          exeHint: xmlMeta.launcherRelExe,
          allowMacAppBundles: true,
        });
      },
      { skipLowerNames: MAC_EA_SKIP_DIR_NAMES }
    );

    if (macDirs.macRiotMetaDir) {
      scanRiotMetadataDirectory(macDirs.macRiotMetaDir, (prodId, installDir) => {
        tryAddGame('riot', installDir, {
          externalInstallId: prodId,
          title: path.basename(installDir).replace(/\.app$/i, ''),
          allowMacAppBundles: true,
        });
      });
    }
  }

  return discovered;
}

/**
 * Resolve configured and existing game install / staging root directories for a chained publisher
 * launcher (`ea`, `ubisoft`, `bnet`, `rockstar`, `riot`) inside a macOS bottle or on the host OS.
 * Strictly refuses to return `drive_c/Program Files (x86)` or `Program Files` itself.
 *
 * @param {string} handoffId
 * @param {string | Record<string, any>} [optionsOrBottle]
 * @returns {string[]}
 */
function resolvePublisherStagingDirs(handoffId, optionsOrBottle = {}) {
  const canonical = normalizeChainedHandoffId(handoffId);
  if (!canonical) return [];

  /** @type {Record<string, any>} */
  const opts =
    typeof optionsOrBottle === 'string'
      ? { bottlePath: optionsOrBottle }
      : optionsOrBottle && typeof optionsOrBottle === 'object'
        ? optionsOrBottle
        : {};
  const bottlePath = typeof opts.bottlePath === 'string' ? opts.bottlePath.trim() : '';
  const platform = String(opts.platform || opts.hostPlatform || process.platform).toLowerCase();

  /** @type {string[]} */
  const results = [];
  /** @type {Set<string>} */
  const seenLower = new Set();

  const pushDir = (
    /** @type {string | null | undefined} */ rawDir,
    /** @type {{ requireExists?: boolean }} */ pushOpts = {}
  ) => {
    if (!rawDir) return;
    let candidate = String(rawDir)
      .trim()
      .replace(/^["']+|["']+$/g, '')
      .replace(/([^:])[\\/]+$/, '$1');
    if (!candidate) return;
    if (bottlePath) {
      const driveCRoot = path.join(bottlePath, 'drive_c');
      candidate = candidate.startsWith('/')
        ? resolveWineReparseTargetReadOnly(candidate, driveCRoot, opts)
        : resolveBottleWindowsPathReadOnly(candidate, bottlePath, opts);
    }
    if (!candidate || STEAMAPPS_COMMON_PATH_RE.test(candidate)) return;
    if (isForbiddenBroadPublisherContainerDir(candidate, bottlePath)) return;
    if (pushOpts.requireExists) {
      try {
        if (!fs.existsSync(candidate)) return;
      } catch {
        return;
      }
    }
    const key = candidate.toLowerCase();
    if (!seenLower.has(key)) {
      seenLower.add(key);
      results.push(candidate);
    }
  };

  if (bottlePath) {
    if (canonical === 'riot') return [];
    const driveCRoot = path.join(bottlePath, 'drive_c');
    const sections = getBottleSystemRegSections(bottlePath, opts);
    const userDirs = listBottleUserDirectories(bottlePath);

    if (canonical === 'ea') {
      for (const root of readEaConfiguredLibraryRoots({ ...opts, bottlePath })) pushDir(root);
      return results;
    }

    if (canonical === 'ubisoft') {
      const ubiPaths = collectBottleUbisoftPaths(bottlePath, driveCRoot, sections, userDirs);
      for (const custom of ubiPaths.customWinDirs) pushDir(custom);
      for (const [secKey, props] of sections.entries()) {
        if (/^software\\(?:wow6432node\\)?ubisoft\\launcher\\installs\\[^\\]+$/i.test(secKey)) {
          pushDir(getRegistryPropCaseInsensitive(props, 'InstallDir'));
        }
      }
      if (ubiPaths.launcherGamesDir) pushDir(ubiPaths.launcherGamesDir);
      pushDir(ubiPaths.legacyX86GamesDir);
      pushDir(ubiPaths.legacyX64GamesDir, { requireExists: true });
      return results;
    }

    if (canonical === 'bnet') {
      for (const defDir of collectBottleBattleNetDefaultDirs(userDirs)) pushDir(defDir);
      const productDbPath = resolveDriveCPathCaseInsensitive(driveCRoot, [
        'ProgramData',
        'Battle.net',
        'Agent',
        'product.db',
      ]);
      for (const entry of readBattleNetProductDbFileReadOnly(productDbPath)) {
        if (entry.hasCachedState && !entry.installed && !entry.playable) continue;
        if (entry.installPath) pushDir(entry.installPath);
      }
      for (const progFolder of ['Program Files (x86)', 'Program Files']) {
        const progDir = resolveDriveCPathCaseInsensitive(driveCRoot, [progFolder]);
        try {
          if (!progDir || !fs.existsSync(progDir)) continue;
          for (const sub of fs.readdirSync(progDir, { withFileTypes: true })) {
            if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
            if (sub.name.toLowerCase() === 'battle.net') continue;
            const cand = path.join(progDir, sub.name);
            if (fs.existsSync(path.join(cand, '.build.info'))) pushDir(cand);
          }
        } catch {}
      }
      pushDir(resolveDriveCPathCaseInsensitive(driveCRoot, ['ProgramData', 'Battle.net', 'Agent']));
      return results;
    }

    if (canonical === 'rockstar') {
      for (const [secKey, props] of sections.entries()) {
        const m = secKey.match(/^software\\(?:wow6432node\\)?rockstar games\\([^\\]+)$/i);
        if (!m || !m[1]) continue;
        if (ROCKSTAR_SKIP_DIR_NAMES.has(m[1].trim().toLowerCase())) continue;
        pushDir(
          getRegistryPropCaseInsensitive(props, 'InstallFolder') ||
            getRegistryPropCaseInsensitive(props, 'InstallLocation')
        );
      }
      pushDir(resolveDriveCPathCaseInsensitive(driveCRoot, ['Program Files', 'Rockstar Games']));
      pushDir(
        resolveDriveCPathCaseInsensitive(driveCRoot, ['Program Files (x86)', 'Rockstar Games']),
        { requireExists: true }
      );
      return results;
    }
  }

  if (platform === 'win32') {
    const winDirs = resolveWin32HostEnvDirs(opts);

    if (canonical === 'ea') {
      for (const root of readEaConfiguredLibraryRoots({ ...opts, platform: 'win32' })) pushDir(root);
      return results;
    }
    if (canonical === 'ubisoft') {
      const ubiHost = discoverWindowsPublisherLauncherPaths('ubisoft', opts);
      pushDir(readUbisoftCustomGamesDirSetting(path.join(winDirs.localAppData, 'Ubisoft Game Launcher')));
      if (ubiHost.installDir) {
        pushDir(readUbisoftCustomGamesDirSetting(ubiHost.installDir));
        pushDir(path.join(ubiHost.installDir, 'games'));
      }
      pushDir(
        readUbisoftCustomGamesDirSetting(
          path.join(winDirs.programFilesX86, 'Ubisoft', 'Ubisoft Game Launcher')
        )
      );
      pushDir(path.join(winDirs.programFilesX86, 'Ubisoft', 'Ubisoft Game Launcher', 'games'));
      pushDir(path.join(winDirs.programFiles, 'Ubisoft', 'Ubisoft Game Launcher', 'games'), {
        requireExists: true,
      });
      return results;
    }
    if (canonical === 'bnet') {
      pushDir(
        readBattleNetDefaultInstallPathFromConfig(
          path.join(winDirs.roamingAppData, 'Battle.net', 'Battle.net.config')
        )
      );
      for (const entry of readBattleNetProductDbFileReadOnly(
        path.join(winDirs.programData, 'Battle.net', 'Agent', 'product.db')
      )) {
        if (entry.hasCachedState && !entry.installed && !entry.playable) continue;
        if (entry.installPath) pushDir(entry.installPath);
      }
      pushDir(path.join(winDirs.programData, 'Battle.net', 'Agent'));
      return results;
    }
    if (canonical === 'rockstar') {
      pushDir(path.join(winDirs.programFiles, 'Rockstar Games'));
      pushDir(path.join(winDirs.programFilesX86, 'Rockstar Games'), { requireExists: true });
      return results;
    }
    if (canonical === 'riot') {
      scanRiotMetadataDirectory(path.join(winDirs.programData, 'Riot Games', 'Metadata'), (_prodId, installDir) => {
        pushDir(installDir);
      });
      const sysDrive = winDirs.explicitSysDrive || 'C:';
      pushDir(winDirs.sandboxHome ? path.join(winDirs.sandboxHome, 'Riot Games') : `${sysDrive}\\Riot Games`);
      return results;
    }
  }

  if (platform === 'darwin') {
    const macDirs = resolveDarwinHostEnvDirs(opts);

    if (canonical === 'ea') {
      for (const root of readEaConfiguredLibraryRoots({ ...opts, platform: 'darwin' })) pushDir(root);
      return results;
    }
    if (canonical === 'bnet') {
      pushDir(
        readBattleNetDefaultInstallPathFromConfig(
          path.join(macDirs.home, 'Library', 'Application Support', 'Battle.net', 'Battle.net.config')
        )
      );
      for (const entry of readBattleNetProductDbFileReadOnly(macDirs.macBnetProductDbPath)) {
        if (entry.hasCachedState && !entry.installed && !entry.playable) continue;
        if (entry.installPath) pushDir(entry.installPath);
      }
      pushDir(macDirs.macBnetAgentDir);
      return results;
    }
    if (canonical === 'riot') {
      if (macDirs.macRiotSharedDir) {
        scanRiotMetadataDirectory(macDirs.macRiotMetaDir, (_prodId, installDir) => {
          pushDir(installDir);
        });
        pushDir(macDirs.macRiotSharedDir);
      }
      return results;
    }
  }

  return results;
}

module.exports = {
  parseBattleNetProductDbBuffer,
  readBattleNetProductDbFileReadOnly,
  extractBattleNetProductId,
  readBattleNetDefaultInstallPathFromConfig,
  findPrimaryPublisherGameExecutable,
  decodeXmlEntities,
  parseEaInstallerDataXml,
  readEaConfiguredLibraryRoots,
  resolveEaContentIdNearExecutable,
  readUbisoftCustomGamesDirSetting,
  parseRiotProductInstallFullPath,
  scanRiotMetadataDirectory,
  scanBottlePublisherInstalledGames,
  scanHostPublisherInstalledGames,
  resolvePublisherStagingDirs,
};
