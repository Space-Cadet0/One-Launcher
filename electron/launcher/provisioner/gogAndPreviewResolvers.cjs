// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { getElectron, getMainWindow } = require('../engineStateRegistry.cjs');
const { getDiskSpace } = require('../diskAndVolumeInspector.cjs');
const macNativeInstallerAndCodesign = /** @type {any} */ (
  require('../macNativeInstallerAndCodesign.cjs')
);
const {
  parsePlistStringValues,
  compareRunnerVersions,
  extractRunnerPreviewDate,
  extractCandidateLinksFromText,
  setCachedAuthenticatedPreviewUrl,
} = macNativeInstallerAndCodesign;
const {
  MAX_INSTALLER_DOWNLOAD_BYTES,
  normalizeRequestedRunnerType,
  emitEnvironmentSetupProgress,
  throwBlockedUrlError,
  isFatalSecurityOrAbortError,
  validateInstallerUrl,
  fetchValidatedText,
  streamVerifiedDownloadToFile,
} = require('./installerNetworkAndGuardrails.cjs');

/**
 * Default non-zero interactive sign-in timeout (10 minutes) preventing indefinite hangs
 * when a hidden or stalled CodeWeavers Preview auth BrowserWindow fails to settle.
 */
const DEFAULT_PREVIEW_AUTH_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Tier 1: Query GOG's official remote-config webinstaller JSON API (`component_version=2.0.0`).
 *
 * @param {'osx' | 'windows'} targetOs
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ url: string, isStubWebInstaller?: boolean }>>}
 */
async function resolveGogTier1Candidates(targetOs, options = {}, signal = undefined) {
  try {
    const rawJson = await fetchValidatedText(
      'https://remote-config.gog.com/components/webinstaller?component_version=2.0.0',
      { ...options, maxTextBytes: Number(options.maxTextBytes || 256 * 1024) },
      signal
    );
    const parsed = JSON.parse(rawJson);
    const osNode = parsed?.content?.[targetOs] || parsed?.[targetOs] || null;
    const candidate = String(
      osNode?.downloadLink ||
        osNode?.full_installer_url ||
        osNode?.installer_url ||
        osNode?.url ||
        ''
    ).trim();
    if (candidate) {
      return [{ url: validateInstallerUrl(candidate, options) }];
    }
  } catch (err) {
    if (isFatalSecurityOrAbortError(err, signal)) {
      throw err;
    }
  }
  return [];
}

/**
 * Tier 2: Extract live GOG Galaxy `.pkg` / `.exe` CDN download links from `https://www.gog.com/en/galaxy`.
 *
 * @param {'osx' | 'windows'} targetOs
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ url: string, isStubWebInstaller?: boolean }>>}
 */
async function resolveGogTier2WebpageCandidates(targetOs, options = {}, signal = undefined) {
  /** @type {Array<{ url: string, isStubWebInstaller?: boolean }>} */
  const out = [];
  const seen = new Set();
  const pushValid = (/** @type {string} */ rawUrl) => {
    const validated = validateInstallerUrl(rawUrl, options);
    if (!seen.has(validated)) {
      seen.add(validated);
      out.push({ url: validated });
    }
  };

  for (const pageUrl of ['https://www.gog.com/en/galaxy', 'https://www.gog.com/galaxy']) {
    try {
      const rawHtml = await fetchValidatedText(
        pageUrl,
        { ...options, maxTextBytes: Number(options.maxTextBytes || 4 * 1024 * 1024) },
        signal
      );
      const normalizedHtml = String(rawHtml || '')
        .replace(/\\\//g, '/')
        .replace(/&amp;/gi, '&');

      const directLinks =
        normalizedHtml.match(
          /https:\/\/content-system\.gog\.com\/open_link\/download\?path=\/open\/galaxy\/client\/[^"'\s<>\\]+/gi
        ) || [];
      const pkgVerMatches = [
        ...normalizedHtml.matchAll(/galaxy_client_([0-9]+(?:\.[0-9]+)+)\.pkg/gi),
      ];

      if (targetOs === 'osx') {
        for (const link of directLinks) {
          if (/\.pkg(?:$|[?#])/i.test(link)) {
            pushValid(link);
          }
        }
        for (const pm of pkgVerMatches) {
          const ver = pm[1];
          if (ver) {
            pushValid(
              `https://content-system.gog.com/open_link/download?path=/open/galaxy/client/galaxy_client_${ver}.pkg`
            );
          }
        }
      } else {
        for (const link of directLinks) {
          if (/\.exe(?:$|[?#])/i.test(link)) {
            pushValid(link);
          }
        }
        for (const pm of pkgVerMatches) {
          const ver = pm[1];
          if (ver) {
            pushValid(
              `https://content-system.gog.com/open_link/download?path=/open/galaxy/client/setup_galaxy_${ver}.exe`
            );
          }
        }
      }
      if (out.length > 0) {
        break;
      }
    } catch (err) {
      if (isFatalSecurityOrAbortError(err, signal)) {
        throw err;
      }
    }
  }
  return out;
}

/**
 * Resolve ordered, zero-hardcoded-version GOG Galaxy installer candidates across Tier 1, Tier 2,
 * and Tier 3 (evergreen versionless Windows stub).
 *
 * @param {'osx' | 'windows'} targetOs
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ url: string, isStubWebInstaller?: boolean }>>}
 */
async function resolveGogGalaxyInstallerCandidates(targetOs, options = {}, signal = undefined) {
  const osKey = targetOs === 'osx' ? 'osx' : 'windows';
  /** @type {Array<{ url: string, isStubWebInstaller?: boolean }>} */
  const candidates = [];
  const seen = new Set();
  const addCandidate = (/** @type {{ url: string, isStubWebInstaller?: boolean }} */ item) => {
    if (item && item.url && !seen.has(item.url)) {
      seen.add(item.url);
      candidates.push(item);
    }
  };

  const tier1 = await resolveGogTier1Candidates(osKey, options, signal);
  tier1.forEach(addCandidate);

  if (candidates.length === 0 || options.includeAllGogTiers === true) {
    const tier2 = await resolveGogTier2WebpageCandidates(osKey, options, signal);
    tier2.forEach(addCandidate);
  }

  if (osKey === 'windows') {
    addCandidate({
      url: validateInstallerUrl(
        'https://webinstallers.gog-statics.com/download/GOG_Galaxy_2.0.exe',
        options
      ),
      isStubWebInstaller: true,
    });
  }

  return candidates;
}

/**
 * Resolve the primary GOG Galaxy macOS `.pkg` or Windows `.exe` installer URL with zero hardcoded
 * version numbers.
 *
 * @param {'osx' | 'windows'} targetOs
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function resolveGogGalaxyInstallerUrl(targetOs, options = {}, signal = undefined) {
  const candidates = await resolveGogGalaxyInstallerCandidates(targetOs, options, signal);
  if (candidates.length > 0) {
    return candidates[0].url;
  }
  throw new Error(
    targetOs === 'osx'
      ? 'Could not resolve current GOG Galaxy macOS installer URL from GOG servers.'
      : 'Could not resolve current GOG Galaxy Windows installer URL from GOG servers.'
  );
}

/**
 * Download the GOG Galaxy installer to `destFilePath` with multi-tier fallback resilience.
 *
 * @param {'osx' | 'windows'} targetOs
 * @param {string} destFilePath
 * @param {{ runId: string, componentId: any, stepIndex?: number, totalSteps?: number, label: string, minFreeBytes?: number }} progressCtx
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ url: string, isStubWebInstaller: boolean }>}
 */
async function downloadGogGalaxyInstallerToFile(
  targetOs,
  destFilePath,
  progressCtx,
  options = {},
  signal = undefined
) {
  const osKey = targetOs === 'osx' ? 'osx' : 'windows';
  const normalizedProgressCtx = {
    stepIndex: 1,
    totalSteps: 1,
    ...progressCtx,
  };
  /** @type {Set<string>} */
  const triedUrls = new Set();
  /** @type {any} */
  let lastDownloadError = null;

  const tryCandidateList = async (
    /** @type {Array<{ url: string, isStubWebInstaller?: boolean }>} */ list
  ) => {
    for (const cand of list) {
      if (!cand?.url || triedUrls.has(cand.url)) continue;
      triedUrls.add(cand.url);
      try {
        await streamVerifiedDownloadToFile(
          cand.url,
          destFilePath,
          normalizedProgressCtx,
          options,
          signal
        );
        return { url: cand.url, isStubWebInstaller: Boolean(cand.isStubWebInstaller) };
      } catch (err) {
        try {
          await fs.promises.rm(destFilePath, { force: true });
        } catch {}
        if (isFatalSecurityOrAbortError(err, signal)) {
          throw err;
        }
        lastDownloadError = err;
      }
    }
    return null;
  };

  const tier1 = await resolveGogTier1Candidates(osKey, options, signal);
  const tier1Result = await tryCandidateList(tier1);
  if (tier1Result) return tier1Result;

  /** @type {Array<{ url: string, isStubWebInstaller?: boolean }>} */
  const fallbackCandidates = [];
  const tier2 = await resolveGogTier2WebpageCandidates(osKey, options, signal);
  fallbackCandidates.push(...tier2);
  if (osKey === 'windows') {
    fallbackCandidates.push({
      url: validateInstallerUrl(
        'https://webinstallers.gog-statics.com/download/GOG_Galaxy_2.0.exe',
        options
      ),
      isStubWebInstaller: true,
    });
  }

  const fallbackResult = await tryCandidateList(fallbackCandidates);
  if (fallbackResult) return fallbackResult;

  if (lastDownloadError) {
    throw lastDownloadError instanceof Error
      ? lastDownloadError
      : new Error(String(lastDownloadError));
  }
  throw new Error(
    osKey === 'osx'
      ? 'Could not resolve current GOG Galaxy macOS installer URL from GOG servers.'
      : 'Could not resolve current GOG Galaxy Windows installer URL from GOG servers.'
  );
}

/**
 * Validate whether a navigation/SSO URL is permitted inside the sandboxed CodeWeavers Preview
 * sign-in `BrowserWindow`.
 *
 * @param {string} rawUrl
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isAllowedCodeWeaversAuthNavigationUrl(rawUrl, options = {}) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    if (
      options.allowLoopbackInstallerUrls === true &&
      (host === '127.0.0.1' || host === 'localhost')
    ) {
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    }
    if (parsed.protocol !== 'https:') return false;
    return (
      host === 'codeweavers.com' ||
      host.endsWith('.codeweavers.com') ||
      host === 'google.com' ||
      host.endsWith('.google.com') ||
      host === 'apple.com' ||
      host.endsWith('.apple.com') ||
      host === 'github.com' ||
      host.endsWith('.github.com') ||
      host === 'microsoft.com' ||
      host.endsWith('.microsoft.com') ||
      host === 'live.com' ||
      host.endsWith('.live.com') ||
      host === 'microsoftonline.com' ||
      host.endsWith('.microsoftonline.com') ||
      host === 'cloudflare.com' ||
      host.endsWith('.cloudflare.com') ||
      host === 'cf-challenges.com' ||
      host.endsWith('.cf-challenges.com')
    );
  } catch {
    return false;
  }
}

/**
 * Validate whether every redirect hop of a `will-download` item originates from an official
 * CodeWeavers download host (`codeweavers.com` or `*.codeweavers.com` over HTTPS).
 *
 * @param {string} rawUrl
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isAllowedCodeWeaversDownloadUrl(rawUrl, options = {}) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    if (
      options.allowLoopbackInstallerUrls === true &&
      (host === '127.0.0.1' || host === 'localhost')
    ) {
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    }
    if (parsed.protocol !== 'https:') return false;
    return host === 'codeweavers.com' || host.endsWith('.codeweavers.com');
  } catch {
    return false;
  }
}

/**
 * Parse a strict 8-digit preview build date (`YYYYMMDD`) into a finite number,
 * returning `null` for semver or malformed strings so `NaN` never leaks into comparisons.
 *
 * @param {unknown} val
 * @returns {number | null}
 */
function parseNumericPreviewDate(val) {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (!/^\d{8}$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

/**
 * Extract an optional version or preview build date hint from a CodeWeavers Preview filename.
 *
 * @param {string} filename
 * @returns {string | null}
 */
function extractPreviewFilenameVersionHint(filename) {
  const stripped = String(filename || '').trim().split(/[?#]/)[0];
  const base = path.basename(stripped).replace(/\.(?:zip|dmg)$/i, '');
  if (!base) return null;
  const extractDateFn =
    typeof macNativeInstallerAndCodesign?.extractRunnerPreviewDate === 'function'
      ? macNativeInstallerAndCodesign.extractRunnerPreviewDate
      : null;
  const dateMatch = extractDateFn
    ? extractDateFn(base)
    : base.match(/(?:preview\s*|[-_.]|^)(20\d{6})(?=[^0-9]|$)/i)?.[1];
  if (dateMatch) return dateMatch;
  const semverMatch = base.match(/(\d+\.\d+(?:\.\d+)?)/);
  if (semverMatch) return semverMatch[1];
  return null;
}

/**
 * Classify a CodeWeavers CrossOver Preview download target into `'arm64'`, `'standard'`, or `null`.
 *
 * @param {string} rawTarget
 * @returns {'arm64' | 'standard' | null}
 */
function classifyCrossOverPreviewArchiveBranch(rawTarget) {
  const raw = String(rawTarget || '').trim();
  if (!raw) return null;
  let candidate = raw.split(/[?#]/)[0];
  try {
    const parsed = new URL(raw, 'https://www.codeweavers.com/preview/download');
    candidate = decodeURIComponent(parsed.pathname || raw);
  } catch {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {}
  }
  const lowerPath = candidate.toLowerCase();
  const base = path.basename(candidate).toLowerCase();
  if (
    !base ||
    /\.(?:deb|rpm|bin|tar\.gz|tar\.bz2|tgz)$/i.test(base) ||
    /(?:^|[-_.])(source|src|linux|debian|ubuntu|rpm)(?:[-_.]|\.(?:zip|dmg)$)/i.test(base)
  ) {
    return null;
  }
  const hasExplicitPreviewToken = /preview/i.test(base);
  const isNonPreviewStableFilename =
    !hasExplicitPreviewToken &&
    (/crossover/i.test(base) || /\/preview\/download\//i.test(lowerPath)) &&
    (/\d+\.\d+/.test(base) ||
      /(?:^|[-_.])(stable|demo|trial|release)(?:[-_.]|\.(?:zip|dmg)$)/i.test(base) ||
      !/20\d{6}/.test(base));
  if (isNonPreviewStableFilename) {
    return null;
  }
  if (
    /(?:^|[\s/_.-])(arm64|aarch64|apple[-_.]?silicon)(?:[\s/_.-]|\.(?:zip|dmg)$|$)/i.test(
      lowerPath
    )
  ) {
    return 'arm64';
  }
  if (
    /crossover[-_.]?preview/i.test(base) ||
    /\/preview\/download\/(?:.+\/)?[^/?#]+\.(?:zip|dmg)$/i.test(candidate)
  ) {
    return 'standard';
  }
  return null;
}

/**
 * Resolve `'standard' | 'arm64'` preview branch from options (`previewBranch`, `runnerType`, `componentId`).
 *
 * @param {Record<string, any>} [options]
 * @param {string} [fallbackRunnerType]
 * @returns {'standard' | 'arm64'}
 */
function resolvePreviewBranch(options = {}, fallbackRunnerType = undefined) {
  const explicitBranch = String(options?.previewBranch || options?.branch || '')
    .trim()
    .toLowerCase();
  if (explicitBranch === 'arm64') return 'arm64';
  if (explicitBranch === 'standard') return 'standard';
  const normalizedRunner = normalizeRequestedRunnerType(
    options?.runnerType || options?.componentId || fallbackRunnerType || ''
  );
  if (normalizedRunner === 'crossover_preview_arm64') {
    return 'arm64';
  }
  return 'standard';
}

/**
 * Deterministically select the newest macOS CrossOver Preview `.zip` / `.dmg` download URL for the
 * requested branch (`'standard'` by default, or `'arm64'` when `options.previewBranch === 'arm64'`).
 *
 * @param {unknown[]} candidateUrls
 * @param {string} [baseUrl]
 * @param {Record<string, any>} [options]
 * @returns {string | null}
 */
function selectPreferredCrossOverPreviewDownloadUrl(
  candidateUrls,
  baseUrl = 'https://www.codeweavers.com/preview/download',
  options = {}
) {
  if (!Array.isArray(candidateUrls) || candidateUrls.length === 0) {
    return null;
  }

  const requestedBranch = resolvePreviewBranch(options);

  /**
   * @type {Array<{
   *   url: string,
   *   hasExplicitPreviewName: boolean,
   *   buildDateNum: number,
   *   versionHint: string | null,
   *   isZip: boolean,
   * }>}
   */
  const ranked = [];
  const seen = new Set();

  for (const rawItem of candidateUrls) {
    const rawHref = String(rawItem || '').trim();
    if (
      !rawHref ||
      rawHref.startsWith('#') ||
      /^javascript:/i.test(rawHref) ||
      /^mailto:/i.test(rawHref)
    ) {
      continue;
    }

    let resolvedUrl = '';
    /** @type {URL | null} */
    let parsed = null;
    try {
      parsed = new URL(rawHref, baseUrl);
      resolvedUrl = parsed.toString();
    } catch {
      continue;
    }

    if (seen.has(resolvedUrl)) continue;
    seen.add(resolvedUrl);

    if (!isAllowedCodeWeaversDownloadUrl(resolvedUrl, options)) {
      continue;
    }

    let decodedPath = parsed.pathname || '';
    try {
      decodedPath = decodeURIComponent(decodedPath);
    } catch {}
    const filename = path.basename(decodedPath);
    if (!filename || !/\.(?:zip|dmg)$/i.test(filename)) {
      continue;
    }

    if (!/crossover/i.test(filename)) {
      continue;
    }
    if (
      /(?:^|[-_.])(source|src|linux|debian|ubuntu|rpm)(?:[-_.]|\.(?:zip|dmg)$)/i.test(filename)
    ) {
      continue;
    }

    const hasExplicitPreviewName = /crossover[-_.]?preview/i.test(filename);
    const isUnderPreviewDownloadPath =
      /\/preview\/download\/(?:.+\/)?[^/?#]+\.(?:zip|dmg)$/i.test(decodedPath);
    if (!hasExplicitPreviewName && !isUnderPreviewDownloadPath) {
      continue;
    }

    const classifiedBranch = classifyCrossOverPreviewArchiveBranch(resolvedUrl);
    if (classifiedBranch !== requestedBranch) {
      continue;
    }

    const extractDateFn =
      typeof macNativeInstallerAndCodesign?.extractRunnerPreviewDate === 'function'
        ? macNativeInstallerAndCodesign.extractRunnerPreviewDate
        : null;
    const previewDateStr = extractDateFn
      ? extractDateFn(filename) || extractDateFn(resolvedUrl)
      : filename.match(/(?:preview\s*|[-_.]|^)(20\d{6})(?=[^0-9]|$)/i)?.[1] || null;
    const buildDateNum = parseNumericPreviewDate(previewDateStr) ?? 0;
    const versionHint = extractPreviewFilenameVersionHint(filename);
    const isZip = /\.zip$/i.test(filename);

    ranked.push({
      url: resolvedUrl,
      hasExplicitPreviewName,
      buildDateNum,
      versionHint,
      isZip,
    });
  }

  if (ranked.length === 0) {
    return null;
  }

  ranked.sort((a, b) => {
    if (a.hasExplicitPreviewName !== b.hasExplicitPreviewName) {
      return a.hasExplicitPreviewName ? -1 : 1;
    }
    if (a.buildDateNum !== b.buildDateNum) {
      return b.buildDateNum - a.buildDateNum;
    }
    if (a.versionHint && b.versionHint && a.versionHint !== b.versionHint) {
      const cmp =
        typeof compareRunnerVersions === 'function'
          ? compareRunnerVersions(a.versionHint, b.versionHint)
          : a.versionHint.localeCompare(b.versionHint, undefined, { numeric: true });
      if (cmp !== 0) return -cmp;
    } else if (a.versionHint && !b.versionHint) {
      return -1;
    } else if (!a.versionHint && b.versionHint) {
      return 1;
    }
    if (a.isZip !== b.isZip) {
      return a.isZip ? -1 : 1;
    }
    return 0;
  });

  return ranked[0].url;
}

/**
 * Discover both `'standard'` and `'arm64'` CrossOver Preview download URLs from a single portal
 * candidate list.
 *
 * @param {unknown[]} candidateUrls
 * @param {string} [baseUrl]
 * @param {Record<string, any>} [options]
 * @returns {{ standard: string | null, arm64: string | null }}
 */
function discoverCrossOverPreviewBranchUrls(
  candidateUrls,
  baseUrl = 'https://www.codeweavers.com/preview/download',
  options = {}
) {
  return {
    standard: selectPreferredCrossOverPreviewDownloadUrl(candidateUrls, baseUrl, {
      ...options,
      previewBranch: 'standard',
    }),
    arm64: selectPreferredCrossOverPreviewDownloadUrl(candidateUrls, baseUrl, {
      ...options,
      previewBranch: 'arm64',
    }),
  };
}

/**
 * Resolve canonical semver from a CrossOver Preview `.app` bundle `Info.plist` when the filename
 * hint was absent or only carried an 8-digit preview date (`YYYYMMDD`).
 *
 * @param {string} appBundlePath
 * @param {string | null} hintVersion
 * @returns {string | null}
 */
function resolvePreviewBundleVersion(appBundlePath, hintVersion) {
  try {
    const plistPath = path.join(appBundlePath, 'Contents/Info.plist');
    if (fs.existsSync(plistPath) && typeof parsePlistStringValues === 'function') {
      const plistDict = parsePlistStringValues(plistPath);
      const bundleVer = String(plistDict.CFBundleVersion || '').trim();
      const shortVer = String(plistDict.CFBundleShortVersionString || '').trim();
      const semverMatch =
        bundleVer.match(/^(\d+\.\d+\.\d+)(?:\.\d+)?$/) ||
        shortVer.match(/^(\d+\.\d+\.\d+)(?:\.\d+)?$/);
      if (semverMatch) {
        return semverMatch[1];
      }
      const dateHint =
        extractPreviewFilenameVersionHint(bundleVer) ||
        extractPreviewFilenameVersionHint(shortVer) ||
        hintVersion;
      if (dateHint) {
        return dateHint;
      }
      if (shortVer || bundleVer) {
        return shortVer || bundleVer;
      }
    }
  } catch {}
  return hintVersion || null;
}

/**
 * Open a sandboxed in-app CodeWeavers sign-in `BrowserWindow` using persistent partition
 * `'persist:codeweavers-preview'`, auto-redirect to `/preview/download` after login, intercept
 * the official `.zip`/`.dmg` download into `destDir`, and enforce a non-zero default watchdog timeout.
 *
 * @param {string} destDir
 * @param {{ runId: string, componentId: any, action?: any, stepIndex: number, totalSteps: number }} progressCtx
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ archivePath: string, resolvedVersion: string | null, alreadyUpToDate?: boolean, authenticated?: boolean, downloadUrl?: string | null, discoveredBranchUrls?: { standard: string | null, arm64: string | null } }>}
 */
async function captureCodeWeaversPreviewDownload(
  destDir,
  progressCtx,
  options = {},
  signal = undefined
) {
  if (signal?.aborted) {
    const abortErr = new Error('CodeWeavers Preview sign-in cancelled.');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  const requestedBranch = resolvePreviewBranch({
    ...options,
    ...(progressCtx?.componentId ? { componentId: progressCtx.componentId } : {}),
  });

  if (options.authenticateOnly !== true) {
    await fs.promises.mkdir(destDir, { recursive: true });

    const minFreeBytes = Number(options.minFreeBytes || 1200 * 1024 * 1024);
    const diskInfo = await getDiskSpace(destDir, options);
    if (
      typeof diskInfo.availableBytes === 'number' &&
      Number.isFinite(diskInfo.availableBytes) &&
      diskInfo.availableBytes >= 0 &&
      diskInfo.availableBytes < minFreeBytes
    ) {
      throw new Error(
        `Insufficient disk space (${Math.round(diskInfo.availableBytes / (1024 * 1024))} MB free, need at least ${Math.round(minFreeBytes / (1024 * 1024))} MB).`
      );
    }
  }

  if (typeof options.capturePreviewDownloadFn === 'function') {
    emitEnvironmentSetupProgress(
      {
        ...progressCtx,
        phase: 'probing',
        message: 'Sign in to CodeWeavers Preview to start automatic download...',
      },
      options
    );
    const hookRes = await options.capturePreviewDownloadFn({
      destDir,
      progressCtx,
      options,
      signal,
    });
    if (signal?.aborted) {
      const abortErr = new Error('CodeWeavers Preview sign-in cancelled.');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    if (hookRes && typeof hookRes === 'object' && hookRes.alreadyUpToDate === true) {
      return {
        alreadyUpToDate: true,
        archivePath: '',
        resolvedVersion: hookRes.resolvedVersion || hookRes.version || null,
      };
    }
    if (
      options.authenticateOnly === true ||
      (hookRes && typeof hookRes === 'object' && hookRes.authenticated === true)
    ) {
      const hookDownloadUrl =
        hookRes && typeof hookRes === 'object' && typeof hookRes.downloadUrl === 'string'
          ? hookRes.downloadUrl.trim()
          : typeof hookRes === 'string' && /^https?:\/\//i.test(hookRes.trim())
            ? hookRes.trim()
            : null;
      const hookVer =
        hookRes && typeof hookRes === 'object' && typeof hookRes.resolvedVersion === 'string'
          ? hookRes.resolvedVersion.trim()
          : hookRes && typeof hookRes === 'object' && typeof hookRes.version === 'string'
            ? hookRes.version.trim()
            : hookDownloadUrl
              ? extractPreviewFilenameVersionHint(hookDownloadUrl) ||
                extractRunnerPreviewDate(hookDownloadUrl)
              : null;
      return {
        authenticated: true,
        archivePath: '',
        downloadUrl: hookDownloadUrl,
        resolvedVersion: hookVer || null,
      };
    }
    const hookArchivePath =
      typeof hookRes === 'string'
        ? hookRes.trim()
        : hookRes && typeof hookRes.archivePath === 'string'
          ? hookRes.archivePath.trim()
          : '';
    if (!hookArchivePath || !fs.existsSync(hookArchivePath)) {
      throw new Error('Captured CrossOver Preview installer archive was not found on disk.');
    }
    const hookVersion =
      hookRes &&
      typeof hookRes === 'object' &&
      typeof hookRes.version === 'string' &&
      hookRes.version.trim()
        ? hookRes.version.trim()
        : hookRes &&
            typeof hookRes === 'object' &&
            typeof hookRes.resolvedVersion === 'string' &&
            hookRes.resolvedVersion.trim()
          ? hookRes.resolvedVersion.trim()
          : extractPreviewFilenameVersionHint(hookArchivePath);
    return {
      archivePath: hookArchivePath,
      resolvedVersion: hookVersion || null,
    };
  }

  const electronMod = (options && options.electronMod) || getElectron();
  const BrowserWindow = electronMod?.BrowserWindow;
  const sessionMod = electronMod?.session;
  if (
    typeof BrowserWindow !== 'function' ||
    !sessionMod ||
    typeof sessionMod.fromPartition !== 'function'
  ) {
    throw new Error(
      'In-app CodeWeavers Preview sign-in requires an interactive Electron window session.'
    );
  }

  const previewDownloadUrl = String(
    options.previewPortalUrl || 'https://www.codeweavers.com/preview/download'
  ).trim();
  if (!isAllowedCodeWeaversDownloadUrl(previewDownloadUrl, options)) {
    throwBlockedUrlError(`Untrusted CodeWeavers Preview portal URL: ${previewDownloadUrl}`);
  }

  const previewSession = sessionMod.fromPartition('persist:codeweavers-preview');
  const mainWin = typeof getMainWindow === 'function' ? getMainWindow() : null;

  emitEnvironmentSetupProgress(
    {
      ...progressCtx,
      phase: 'probing',
      message: 'Sign in to CodeWeavers Preview to start automatic download...',
    },
    options
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let downloadCaptured = false;
    let closingForCapture = false;
    let sawLoginPage = false;
    let autoTriggeredDownloadAfterLogin = false;
    let autoTriggeredArchiveDownload = false;
    const shouldShowImmediately =
      options.showAuthWindowImmediately === true || options.authenticateOnly === true;
    let authWindowShown = shouldShowImmediately;
    /** @type {{ standard: string | null, arm64: string | null }} */
    let lastDiscoveredBranchUrls = { standard: null, arm64: null };
    /** @type {any} */
    let activeDownloadItem = null;
    /** @type {any} */
    let authWindow = null;
    /** @type {ReturnType<typeof setTimeout>[]} */
    const pendingTimers = [];

    /** @type {(event: any, item: any) => void} */
    let onWillDownload;
    /** @type {() => void} */
    let onAbort;
    /** @type {(currentUrlHint?: string, retryAttempt?: number) => Promise<void>} */
    let inspectPortalAndTriggerDownload = async () => {};

    const clearPendingTimers = () => {
      while (pendingTimers.length > 0) {
        const t = pendingTimers.pop();
        if (t) clearTimeout(t);
      }
    };

    const scheduleBoundedTimer = (/** @type {() => void} */ fn, /** @type {number} */ delayMs) => {
      const handle = setTimeout(() => {
        const idx = pendingTimers.indexOf(handle);
        if (idx >= 0) pendingTimers.splice(idx, 1);
        fn();
      }, delayMs);
      if (handle && typeof handle.unref === 'function') {
        handle.unref();
      }
      pendingTimers.push(handle);
      return handle;
    };

    const revealAuthWindow = () => {
      if (settled || downloadCaptured || closingForCapture) return;
      try {
        if (authWindow && !authWindow.isDestroyed()) {
          if (!authWindowShown) {
            authWindowShown = true;
            if (typeof authWindow.show === 'function') {
              authWindow.show();
            }
          }
          if (typeof authWindow.focus === 'function') {
            authWindow.focus();
          }
          if (typeof authWindow.moveTop === 'function') {
            authWindow.moveTop();
          }
        }
      } catch {}
    };

    const forceCloseAuthWindow = () => {
      closingForCapture = true;
      clearPendingTimers();
      try {
        if (authWindow && !authWindow.isDestroyed()) {
          if (typeof authWindow.hide === 'function') {
            authWindow.hide();
          }
          if (typeof authWindow.destroy === 'function') {
            const winRef = authWindow;
            setImmediate(() => {
              try {
                if (!winRef.isDestroyed()) {
                  winRef.close();
                  if (!winRef.isDestroyed()) {
                    winRef.destroy();
                  }
                }
              } catch {}
            });
          } else {
            authWindow.close();
          }
        }
      } catch {}
    };

    const triggerArchiveDownloadUrl = (/** @type {string} */ targetUrl) => {
      if (
        !targetUrl ||
        settled ||
        downloadCaptured ||
        closingForCapture ||
        autoTriggeredArchiveDownload
      ) {
        return false;
      }
      autoTriggeredArchiveDownload = true;
      lastDiscoveredBranchUrls[requestedBranch] = targetUrl;
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'probing',
          message: 'Authenticated with CodeWeavers — starting CrossOver Preview download...',
        },
        options
      );
      try {
        const wcRef = authWindow && !authWindow.isDestroyed() ? authWindow.webContents : null;
        if (wcRef && typeof wcRef.downloadURL === 'function') {
          wcRef.downloadURL(targetUrl);
          scheduleBoundedTimer(() => {
            if (!settled && !downloadCaptured && !closingForCapture) {
              autoTriggeredArchiveDownload = false;
              revealAuthWindow();
            }
          }, 4000);
          return true;
        }
        if (authWindow && !authWindow.isDestroyed()) {
          Promise.resolve(authWindow.loadURL(targetUrl)).catch(() => {});
          scheduleBoundedTimer(() => {
            if (!settled && !downloadCaptured && !closingForCapture) {
              autoTriggeredArchiveDownload = false;
              revealAuthWindow();
            }
          }, 4000);
          return true;
        }
      } catch {
        autoTriggeredArchiveDownload = false;
      }
      return false;
    };

    const cleanup = () => {
      clearPendingTimers();
      try {
        if (previewSession && onWillDownload) {
          if (typeof previewSession.removeListener === 'function') {
            previewSession.removeListener('will-download', onWillDownload);
          } else if (typeof previewSession.off === 'function') {
            previewSession.off('will-download', onWillDownload);
          }
        }
      } catch {}
      try {
        if (signal && onAbort && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
      } catch {}
      try {
        const wcRef = authWindow && !authWindow.isDestroyed() ? authWindow.webContents : null;
        if (wcRef && typeof wcRef.removeAllListeners === 'function') {
          wcRef.removeAllListeners();
        }
      } catch {}
      try {
        if (authWindow && typeof authWindow.removeAllListeners === 'function') {
          authWindow.removeAllListeners();
        }
      } catch {}
      forceCloseAuthWindow();
    };

    const settleResolve = (
      /** @type {{ archivePath: string, resolvedVersion: string | null, alreadyUpToDate?: boolean, authenticated?: boolean, downloadUrl?: string | null, discoveredBranchUrls?: { standard: string | null, arm64: string | null } }} */ val
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(val);
    };

    const settleReject = (/** @type {any} */ err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    onWillDownload = async (_event, item) => {
      if (settled || downloadCaptured) {
        try {
          if (item && typeof item.cancel === 'function') item.cancel();
        } catch {}
        return;
      }

      const rawChain =
        item && typeof item.getURLChain === 'function' ? item.getURLChain() : [];
      const itemUrl =
        item && typeof item.getURL === 'function' ? String(item.getURL() || '').trim() : '';
      const filename =
        item && typeof item.getFilename === 'function'
          ? String(item.getFilename() || '').trim()
          : '';
      const urlsToCheck = Array.from(
        new Set(
          [...(Array.isArray(rawChain) ? rawChain : []), itemUrl]
            .map((u) => String(u || '').trim())
            .filter(Boolean)
        )
      );

      const allUrlsTrusted =
        urlsToCheck.length > 0 &&
        urlsToCheck.every((u) => isAllowedCodeWeaversDownloadUrl(u, options));
      const hasValidArchiveExt =
        /\.(?:zip|dmg)$/i.test(filename) || /\.(?:zip|dmg)(?:\?|$)/i.test(itemUrl);

      if (!allUrlsTrusted) {
        try {
          if (item && typeof item.cancel === 'function') item.cancel();
        } catch {}
        forceCloseAuthWindow();
        const secErr = /** @type {Error & { code?: string }} */ (
          new Error(
            `Blocked CrossOver Preview download from untrusted host or unsupported URL (${filename || itemUrl || 'unknown'}).`
          )
        );
        secErr.code = 'INSTALLER_URL_BLOCKED';
        settleReject(secErr);
        return;
      }

      if (!hasValidArchiveExt) {
        try {
          if (item && typeof item.cancel === 'function') item.cancel();
        } catch {}
        return;
      }

      if (options.authenticateOnly === true) {
        try {
          if (item && typeof item.cancel === 'function') item.cancel();
        } catch {}
        try {
          if (previewSession?.cookies && typeof previewSession.cookies.flushStore === 'function') {
            await previewSession.cookies.flushStore();
          }
        } catch {}
        forceCloseAuthWindow();
        const candidateVer =
          extractPreviewFilenameVersionHint(filename) ||
          extractRunnerPreviewDate(filename) ||
          extractPreviewFilenameVersionHint(itemUrl) ||
          extractRunnerPreviewDate(itemUrl) ||
          null;
        if (itemUrl && typeof setCachedAuthenticatedPreviewUrl === 'function') {
          const detectedBranch =
            classifyCrossOverPreviewArchiveBranch(itemUrl) ||
            classifyCrossOverPreviewArchiveBranch(filename) ||
            requestedBranch;
          setCachedAuthenticatedPreviewUrl(itemUrl, {
            ...options,
            previewBranch: detectedBranch,
          });
        }
        settleResolve({
          authenticated: true,
          archivePath: '',
          downloadUrl: itemUrl || null,
          resolvedVersion: candidateVer,
        });
        return;
      }

      const itemBranch =
        urlsToCheck.map((u) => classifyCrossOverPreviewArchiveBranch(u)).find(Boolean) ||
        classifyCrossOverPreviewArchiveBranch(filename) ||
        null;
      if (itemBranch && itemBranch !== requestedBranch) {
        try {
          if (item && typeof item.cancel === 'function') item.cancel();
        } catch {}
        const preferredBranchUrl = lastDiscoveredBranchUrls[requestedBranch];
        if (preferredBranchUrl && !autoTriggeredArchiveDownload) {
          triggerArchiveDownloadUrl(preferredBranchUrl);
          return;
        }
        if (!autoTriggeredArchiveDownload) {
          void inspectPortalAndTriggerDownload('', 0);
          return;
        }
        forceCloseAuthWindow();
        settleReject(
          new Error(
            `CrossOver Preview download (${filename || itemUrl}) belongs to the ${itemBranch} branch, but ${requestedBranch} was requested.`
          )
        );
        return;
      }

      downloadCaptured = true;
      activeDownloadItem = item;

      const resolvedVersion =
        extractPreviewFilenameVersionHint(filename) ||
        extractPreviewFilenameVersionHint(itemUrl);
      const isDmgDownload =
        /\.dmg$/i.test(filename) ||
        (!/\.(?:zip|dmg)$/i.test(filename) && /\.dmg(?:\?|$)/i.test(itemUrl));
      const destArchivePath = path.join(
        destDir,
        isDmgDownload ? 'CrossOverPreview.dmg' : 'CrossOverPreview.zip'
      );

      if (typeof item.setSavePath === 'function') {
        item.setSavePath(destArchivePath);
      }

      if (typeof item.on === 'function') {
        item.on('updated', (/** @type {any} */ _uEvt, /** @type {string} */ state) => {
          if (settled || state === 'interrupted') return;
          const received =
            typeof item.getReceivedBytes === 'function'
              ? Number(item.getReceivedBytes() || 0)
              : 0;
          const total =
            typeof item.getTotalBytes === 'function' ? Number(item.getTotalBytes() || 0) : 0;
          if (
            received > MAX_INSTALLER_DOWNLOAD_BYTES ||
            total > MAX_INSTALLER_DOWNLOAD_BYTES
          ) {
            try {
              if (typeof item.cancel === 'function') item.cancel();
            } catch {}
            settleReject(
              new Error('CrossOver Preview download exceeded maximum allowed size.')
            );
            return;
          }
          const progressPercent =
            total > 0 ? Math.min(100, Math.round((received / total) * 100)) : undefined;
          emitEnvironmentSetupProgress(
            {
              ...progressCtx,
              phase: 'downloading',
              bytesDownloaded: received,
              ...(total > 0 ? { totalBytes: total } : {}),
              ...(progressPercent !== undefined ? { progressPercent } : {}),
              message: 'Downloading CrossOver Preview...',
            },
            options
          );
        });
      }

      const onDownloadDone = (/** @type {any} */ _dEvt, /** @type {string} */ state) => {
        if (settled) return;
        if (state === 'completed') {
          settleResolve({
            archivePath: destArchivePath,
            resolvedVersion,
            discoveredBranchUrls: lastDiscoveredBranchUrls,
          });
          return;
        }
        if (state === 'cancelled' || signal?.aborted) {
          const abortErr = new Error('CrossOver Preview download cancelled.');
          abortErr.name = 'AbortError';
          settleReject(abortErr);
          return;
        }
        settleReject(
          new Error(`CrossOver Preview download failed (${state || 'unknown'}).`)
        );
      };

      if (typeof item.once === 'function') {
        item.once('done', onDownloadDone);
      } else if (typeof item.on === 'function') {
        item.on('done', onDownloadDone);
      }

      try {
        if (previewSession?.cookies && typeof previewSession.cookies.flushStore === 'function') {
          await previewSession.cookies.flushStore();
        }
      } catch {}
      if (settled) return;
      forceCloseAuthWindow();

      const initialTotal =
        typeof item.getTotalBytes === 'function' ? Number(item.getTotalBytes() || 0) : 0;
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'downloading',
          bytesDownloaded: 0,
          ...(initialTotal > 0 ? { totalBytes: initialTotal, progressPercent: 0 } : {}),
          message: 'Downloading CrossOver Preview...',
        },
        options
      );
    };

    onAbort = () => {
      if (settled) return;
      try {
        if (activeDownloadItem && typeof activeDownloadItem.cancel === 'function') {
          activeDownloadItem.cancel();
        }
      } catch {}
      forceCloseAuthWindow();
      const abortErr = new Error('CodeWeavers Preview sign-in cancelled.');
      abortErr.name = 'AbortError';
      settleReject(abortErr);
    };

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      previewSession.on('will-download', onWillDownload);

      authWindow = new BrowserWindow({
        width: 560,
        height: 700,
        ...(mainWin && typeof mainWin.isDestroyed === 'function' && !mainWin.isDestroyed()
          ? { parent: mainWin }
          : {}),
        modal: false,
        show: shouldShowImmediately,
        closable: true,
        resizable: true,
        autoHideMenuBar: true,
        title: 'Sign In to CodeWeavers — CrossOver Preview',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: 'persist:codeweavers-preview',
        },
      });

      if (shouldShowImmediately) {
        revealAuthWindow();
      }

      const rawTimeout = options.timeoutMs ?? options.timeout;
      const timeoutMs =
        typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
          ? rawTimeout
          : DEFAULT_PREVIEW_AUTH_TIMEOUT_MS;
      scheduleBoundedTimer(() => {
        if (settled || downloadCaptured) return;
        try {
          if (activeDownloadItem && typeof activeDownloadItem.cancel === 'function') {
            activeDownloadItem.cancel();
          }
        } catch {}
        forceCloseAuthWindow();
        const timeoutErr = /** @type {Error & { code?: string }} */ (
          new Error(`CodeWeavers Preview sign-in timed out after ${timeoutMs}ms.`)
        );
        timeoutErr.name = 'TimeoutError';
        timeoutErr.code = 'ETIMEDOUT';
        settleReject(timeoutErr);
      }, timeoutMs);

      const cleanBrowserUa =
        process.platform === 'win32'
          ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
          : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

      try {
        if (typeof previewSession.setUserAgent === 'function') {
          previewSession.setUserAgent(cleanBrowserUa);
        }
      } catch {}

      scheduleBoundedTimer(() => {
        if (!settled && !downloadCaptured && !closingForCapture && !autoTriggeredArchiveDownload) {
          revealAuthWindow();
        }
      }, 1500);

      const wc = authWindow.webContents;
      try {
        if (typeof wc?.setUserAgent === 'function') {
          wc.setUserAgent(cleanBrowserUa);
        }
      } catch {}

      inspectPortalAndTriggerDownload = async (currentUrlHint = '', retryAttempt = 0) => {
        if (
          settled ||
          downloadCaptured ||
          closingForCapture ||
          autoTriggeredArchiveDownload ||
          !authWindow ||
          authWindow.isDestroyed()
        ) {
          return;
        }

        const currentUrl = String(
          (wc && typeof wc.getURL === 'function' ? wc.getURL() : '') ||
            currentUrlHint ||
            previewDownloadUrl
        ).trim();

        /** @type {URL | null} */
        let parsed = null;
        try {
          parsed = new URL(currentUrl);
        } catch {
          if (retryAttempt > 0) revealAuthWindow();
          return;
        }

        const host = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();
        const isCodeWeaversOrigin =
          host === 'codeweavers.com' ||
          host.endsWith('.codeweavers.com') ||
          (options.allowLoopbackInstallerUrls === true &&
            (host === '127.0.0.1' || host === 'localhost'));

        if (!isCodeWeaversOrigin) {
          sawLoginPage = true;
          revealAuthWindow();
          return;
        }

        const isLoginRoute =
          pathname.includes('/login') ||
          pathname.includes('/signin') ||
          pathname.includes('/sign-in') ||
          pathname.includes('/sign_in') ||
          pathname.startsWith('/account/login') ||
          pathname.startsWith('/account/signin') ||
          pathname.startsWith('/account/auth') ||
          (pathname.startsWith('/account') &&
            (parsed.search.includes('gourl') ||
              parsed.search.includes('login') ||
              parsed.search.includes('signin'))) ||
          pathname.endsWith('/login');
        if (isLoginRoute) {
          sawLoginPage = true;
          autoTriggeredDownloadAfterLogin = false;
          revealAuthWindow();
          return;
        }

        /** @type {string[]} */
        let scrapedHrefs = [];
        let hasPasswordInput = false;
        let hasChallengeDom = false;
        if (wc && typeof wc.executeJavaScript === 'function') {
          try {
            const pageProbe = await wc.executeJavaScript(
              `(() => {
                const hrefs = [];
                for (const el of document.querySelectorAll('a[href], area[href], [data-download-url], [data-url], [data-href], [data-link]')) {
                  const val = el.getAttribute('href') || el.getAttribute('data-download-url') || el.getAttribute('data-url') || el.getAttribute('data-href') || el.getAttribute('data-link') || el.href || '';
                  if (val) hrefs.push(String(val));
                }
                const hasPasswordInput = Boolean(
                  document.querySelector('input[type="password"], form[action*="login"], form[action*="signin"]')
                );
                const hasChallengeDom = Boolean(
                  document.querySelector(
                    '#challenge-form, #cf-challenge-running, #cf-browser-verification, .cf-browser-verification, #challenge-platform, .challenge-platform, iframe[src*="challenges.cloudflare.com"], [name="cf-turnstile-response"]'
                  ) || /Just a moment/i.test(String(document.title || ''))
                );
                const rawHtml = document.body ? document.body.innerHTML.slice(0, 100000) : '';
                const pageTitle = String(document.title || '');
                return { hrefs, hasPasswordInput, hasChallengeDom, rawHtml, pageTitle };
              })()`,
              true
            );
            if (Array.isArray(pageProbe)) {
              scrapedHrefs = pageProbe.map((u) => String(u || ''));
            } else if (pageProbe && typeof pageProbe === 'object') {
              if (Array.isArray(pageProbe.hrefs)) {
                scrapedHrefs = pageProbe.hrefs.map((/** @type {any} */ u) => String(u || ''));
              }
              hasPasswordInput = Boolean(pageProbe.hasPasswordInput);
              hasChallengeDom = Boolean(pageProbe.hasChallengeDom);
              if (!hasChallengeDom && typeof pageProbe.pageTitle === 'string') {
                if (/Just a moment/i.test(pageProbe.pageTitle)) {
                  hasChallengeDom = true;
                }
              }
              if (typeof pageProbe.rawHtml === 'string' && pageProbe.rawHtml) {
                if (
                  !hasChallengeDom &&
                  /id=["']challenge-form["']|id=["']cf-challenge-running["']|cf-browser-verification|challenge-platform|challenges\.cloudflare\.com|cf-turnstile-response|<title>\s*Just a moment\b|\bJust a moment\b/i.test(
                    pageProbe.rawHtml
                  )
                ) {
                  hasChallengeDom = true;
                }
                if (typeof extractCandidateLinksFromText === 'function') {
                  extractCandidateLinksFromText(pageProbe.rawHtml, scrapedHrefs);
                }
              }
            }
          } catch {}
        }

        if (
          settled ||
          downloadCaptured ||
          closingForCapture ||
          autoTriggeredArchiveDownload ||
          !authWindow ||
          authWindow.isDestroyed()
        ) {
          return;
        }

        if (hasPasswordInput || hasChallengeDom) {
          sawLoginPage = true;
          autoTriggeredDownloadAfterLogin = false;
          revealAuthWindow();
          return;
        }

        const candidateHrefs = [...scrapedHrefs];
        if (options.downloadUrl && typeof options.downloadUrl === 'string') {
          candidateHrefs.push(options.downloadUrl.trim());
        }
        if (Array.isArray(options.previewCandidateUrls)) {
          for (const u of options.previewCandidateUrls) {
            if (typeof u === 'string' && u.trim()) candidateHrefs.push(u.trim());
          }
        }

        const discoveredBranches = discoverCrossOverPreviewBranchUrls(
          candidateHrefs,
          currentUrl,
          options
        );
        lastDiscoveredBranchUrls = {
          standard: discoveredBranches.standard || lastDiscoveredBranchUrls.standard,
          arm64: discoveredBranches.arm64 || lastDiscoveredBranchUrls.arm64,
        };
        if (typeof setCachedAuthenticatedPreviewUrl === 'function') {
          if (discoveredBranches.standard) {
            setCachedAuthenticatedPreviewUrl(discoveredBranches.standard, {
              ...options,
              previewBranch: 'standard',
            });
          }
          if (discoveredBranches.arm64) {
            setCachedAuthenticatedPreviewUrl(discoveredBranches.arm64, {
              ...options,
              previewBranch: 'arm64',
            });
          }
        }
        const bestArchiveUrl = discoveredBranches[requestedBranch];

        if (options.authenticateOnly === true) {
          if (bestArchiveUrl) {
            try {
              if (
                previewSession?.cookies &&
                typeof previewSession.cookies.flushStore === 'function'
              ) {
                await previewSession.cookies.flushStore();
              }
            } catch {}
            forceCloseAuthWindow();
            settleResolve({
              authenticated: true,
              archivePath: '',
              downloadUrl: bestArchiveUrl,
              resolvedVersion:
                extractPreviewFilenameVersionHint(bestArchiveUrl) ||
                extractRunnerPreviewDate(bestArchiveUrl) ||
                null,
              discoveredBranchUrls: lastDiscoveredBranchUrls,
            });
            return;
          }
        }

        if (bestArchiveUrl) {
          lastDiscoveredBranchUrls[requestedBranch] = bestArchiveUrl;

          if (
            options._runnerOperation === 'update' &&
            !options.forceReinstall &&
            options.existingLayer
          ) {
            const candidatePreviewDate =
              extractRunnerPreviewDate(bestArchiveUrl) ||
              extractRunnerPreviewDate(path.basename(bestArchiveUrl));
            const existingLayer = options.existingLayer;
            const existingPreviewDate =
              extractRunnerPreviewDate(existingLayer.previewDate) ||
              extractRunnerPreviewDate(existingLayer.displayVersion) ||
              extractRunnerPreviewDate(existingLayer.buildVersion) ||
              extractRunnerPreviewDate(existingLayer.version);

            const candidateDateNum = parseNumericPreviewDate(candidatePreviewDate);
            const existingDateNum = parseNumericPreviewDate(existingPreviewDate);

            let isAlreadyCurrentOrNewer = false;
            if (candidateDateNum !== null && existingDateNum !== null) {
              if (candidateDateNum === existingDateNum) {
                const candidateSemverMatch = path
                  .basename(bestArchiveUrl)
                  .match(/(\d+\.\d+(?:\.\d+)?)/);
                const existingSemver =
                  existingLayer.version && /^\d+\.\d+(?:\.\d+)?$/.test(existingLayer.version)
                    ? existingLayer.version
                    : null;
                if (
                  candidateSemverMatch &&
                  existingSemver &&
                  typeof compareRunnerVersions === 'function'
                ) {
                  isAlreadyCurrentOrNewer =
                    compareRunnerVersions(existingSemver, candidateSemverMatch[1]) >= 0;
                } else {
                  isAlreadyCurrentOrNewer = true;
                }
              } else if (existingDateNum > candidateDateNum) {
                isAlreadyCurrentOrNewer = true;
              }
            } else if (existingDateNum !== null && candidateDateNum === null) {
              isAlreadyCurrentOrNewer = true;
            }

            if (isAlreadyCurrentOrNewer) {
              try {
                if (
                  previewSession?.cookies &&
                  typeof previewSession.cookies.flushStore === 'function'
                ) {
                  await previewSession.cookies.flushStore();
                }
              } catch {}
              forceCloseAuthWindow();
              settleResolve({
                alreadyUpToDate: true,
                archivePath: '',
                downloadUrl: bestArchiveUrl,
                resolvedVersion:
                  candidatePreviewDate || existingPreviewDate || existingLayer.version || null,
                discoveredBranchUrls: lastDiscoveredBranchUrls,
              });
              return;
            }
          }

          triggerArchiveDownloadUrl(bestArchiveUrl);
          return;
        }

        if (!pathname.startsWith('/preview/download') && !autoTriggeredDownloadAfterLogin) {
          autoTriggeredDownloadAfterLogin = true;
          if (authWindow && !authWindow.isDestroyed()) {
            Promise.resolve(authWindow.loadURL(previewDownloadUrl)).catch(() => {});
          }
          return;
        }

        if (retryAttempt === 0) {
          scheduleBoundedTimer(() => {
            void inspectPortalAndTriggerDownload(currentUrl, 1);
          }, 350);
          return;
        }

        revealAuthWindow();
        if (retryAttempt === 1) {
          scheduleBoundedTimer(() => {
            void inspectPortalAndTriggerDownload(currentUrl, 2);
          }, 900);
        }
      };

      if (wc) {
        if (typeof wc.setWindowOpenHandler === 'function') {
          wc.setWindowOpenHandler((/** @type {any} */ details) => {
            const popupUrl = String(details?.url || '').trim();
            if (
              popupUrl &&
              isAllowedCodeWeaversAuthNavigationUrl(popupUrl, options) &&
              authWindow &&
              !authWindow.isDestroyed()
            ) {
              Promise.resolve(authWindow.loadURL(popupUrl)).catch(() => {});
            }
            return { action: 'deny' };
          });
        }

        if (typeof wc.on === 'function') {
          wc.on('will-navigate', (/** @type {any} */ event, /** @type {string} */ navUrl) => {
            if (!isAllowedCodeWeaversAuthNavigationUrl(navUrl, options)) {
              if (event && typeof event.preventDefault === 'function') {
                event.preventDefault();
              }
            }
          });

          wc.on('will-redirect', (/** @type {any} */ event, /** @type {string} */ navUrl) => {
            if (!isAllowedCodeWeaversAuthNavigationUrl(navUrl, options)) {
              if (event && typeof event.preventDefault === 'function') {
                event.preventDefault();
              }
              return;
            }
            try {
              const parsed = new URL(String(navUrl || '').trim());
              const pathname = parsed.pathname.toLowerCase();
              const host = parsed.hostname.toLowerCase();
              const isCodeWeaversOrigin =
                host === 'codeweavers.com' ||
                host.endsWith('.codeweavers.com') ||
                (options.allowLoopbackInstallerUrls === true &&
                  (host === '127.0.0.1' || host === 'localhost'));
              const isAuthOrChallengeHost = !isCodeWeaversOrigin;
              const isLoginPath =
                pathname.includes('/login') ||
                pathname.includes('/signin') ||
                pathname.includes('/sign-in') ||
                pathname.includes('/sign_in') ||
                pathname.startsWith('/account/login') ||
                pathname.startsWith('/account/signin') ||
                pathname.startsWith('/account/auth') ||
                (pathname.startsWith('/account') &&
                  (parsed.search.includes('gourl') ||
                    parsed.search.includes('login') ||
                    parsed.search.includes('signin'))) ||
                isAuthOrChallengeHost;
              if (isLoginPath) {
                sawLoginPage = true;
                autoTriggeredDownloadAfterLogin = false;
                revealAuthWindow();
              }
            } catch {}
          });

          wc.on('did-navigate', (/** @type {any} */ _event, /** @type {string} */ navUrl) => {
            if (settled || downloadCaptured || closingForCapture) return;
            try {
              const parsed = new URL(String(navUrl || '').trim());
              const host = parsed.hostname.toLowerCase();
              const isCodeWeaversOrigin =
                host === 'codeweavers.com' ||
                host.endsWith('.codeweavers.com') ||
                (options.allowLoopbackInstallerUrls === true &&
                  (host === '127.0.0.1' || host === 'localhost'));
              if (!isCodeWeaversOrigin) {
                sawLoginPage = true;
                revealAuthWindow();
                return;
              }
              const pathname = parsed.pathname.toLowerCase();
              const isLoginPath =
                pathname.includes('/login') ||
                pathname.includes('/signin') ||
                pathname.includes('/sign-in') ||
                pathname.includes('/sign_in') ||
                pathname.startsWith('/account/login') ||
                pathname.startsWith('/account/signin') ||
                pathname.startsWith('/account/auth') ||
                (pathname.startsWith('/account') &&
                  (parsed.search.includes('gourl') ||
                    parsed.search.includes('login') ||
                    parsed.search.includes('signin')));
              if (isLoginPath) {
                sawLoginPage = true;
                autoTriggeredDownloadAfterLogin = false;
                revealAuthWindow();
                return;
              }
              if (
                sawLoginPage &&
                !autoTriggeredDownloadAfterLogin &&
                !downloadCaptured &&
                !pathname.startsWith('/preview/download')
              ) {
                autoTriggeredDownloadAfterLogin = true;
                if (authWindow && !authWindow.isDestroyed()) {
                  Promise.resolve(authWindow.loadURL(previewDownloadUrl)).catch(() => {});
                }
              }
            } catch {}
          });

          wc.on(
            'did-navigate-in-page',
            (/** @type {any} */ _event, /** @type {string} */ navUrl) => {
              if (settled || downloadCaptured || closingForCapture) return;
              void inspectPortalAndTriggerDownload(navUrl, 0);
            }
          );

          wc.on('did-finish-load', () => {
            if (settled || downloadCaptured || closingForCapture) return;
            void inspectPortalAndTriggerDownload('', 0);
          });
        }
      }

      if (typeof authWindow.on === 'function') {
        authWindow.on('closed', () => {
          if (!settled && !downloadCaptured && !closingForCapture) {
            const abortErr = new Error('CodeWeavers Preview sign-in cancelled.');
            abortErr.name = 'AbortError';
            settleReject(abortErr);
          }
        });
      }

      Promise.resolve(authWindow.loadURL(previewDownloadUrl)).catch((/** @type {any} */ loadErr) => {
        if (settled || downloadCaptured || closingForCapture) return;
        const msg = String(loadErr?.message || '');
        const isAttachmentAbort =
          loadErr?.errno === -3 ||
          loadErr?.code === 'ERR_ABORTED' ||
          /ERR_ABORTED/i.test(msg);
        if (isAttachmentAbort) return;
        if (options.failOnLoadError === true) {
          forceCloseAuthWindow();
          settleReject(
            loadErr instanceof Error
              ? loadErr
              : new Error(`Failed to load CodeWeavers Preview sign-in page: ${msg}`)
          );
        }
      });
    } catch (initErr) {
      forceCloseAuthWindow();
      settleReject(initErr);
    }
  });
}

module.exports = {
  DEFAULT_PREVIEW_AUTH_TIMEOUT_MS,
  resolveGogTier1Candidates,
  resolveGogTier2WebpageCandidates,
  resolveGogGalaxyInstallerCandidates,
  resolveGogGalaxyInstallerUrl,
  downloadGogGalaxyInstallerToFile,
  isAllowedCodeWeaversAuthNavigationUrl,
  isAllowedCodeWeaversDownloadUrl,
  parseNumericPreviewDate,
  extractPreviewFilenameVersionHint,
  classifyCrossOverPreviewArchiveBranch,
  resolvePreviewBranch,
  selectPreferredCrossOverPreviewDownloadUrl,
  discoverCrossOverPreviewBranchUrls,
  resolvePreviewBundleVersion,
  captureCodeWeaversPreviewDownload,
};
