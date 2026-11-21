// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const {
  diagLog,
  getElectron,
  getMainWindow,
  isTestEnvironment,
  openExternalUri,
  clearMacQuarantineAsync,
  setBoundedMapEntry,
  toLocalFsPath,
  writeManagedInstallSentinel,
  registerExternalCacheInvalidator,
} = require('../engineStateRegistry.cjs');
const { isContainedWithinRoot } = require('../securityAndPathUtils.cjs');
const {
  extractRunnerPreviewDate,
  parsePlistStringValues,
  compareRunnerVersions,
  invalidateCompatLayersCache,
  detectCompatibilityLayers,
  isHomebrewManagedLayer,
  getExternalManagerForLayer,
} = require('./compatLayerRegistryAndDetection.cjs');

/** @type {Set<(event: any) => void>} */
const compatRunnerProgressListeners = new Set();

/** @type {Map<string, { operation: 'install' | 'update', controller: AbortController, promise: Promise<any> }>} */
const activeCompatRunnerOps = new Map();

/**
 * Subscribe to real-time compatibility runner install/update progress events.
 *
 * @param {(event: any) => void} listener
 * @returns {() => boolean}
 */
function onCompatibilityRunnerProgress(listener) {
  if (typeof listener === 'function') {
    compatRunnerProgressListeners.add(listener);
  }
  return () => compatRunnerProgressListeners.delete(listener);
}

/**
 * Emit a compatibility runner progress event to in-process listeners, `options.onRunnerProgress`,
 * and all open Electron `BrowserWindow` instances (`'launcher:compat-runner-progress'`).
 *
 * @param {Record<string, any>} event
 * @param {Record<string, any>} [options]
 */
function emitCompatibilityRunnerProgress(event, options = {}) {
  if (!event || typeof event !== 'object') return;
  const normalized = {
    runnerType: event.runnerType,
    operation: event.operation === 'update' ? 'update' : 'install',
    phase: event.phase || 'probing',
    progressPercent:
      typeof event.progressPercent === 'number' ? event.progressPercent : null,
    ...(typeof event.bytesDownloaded === 'number'
      ? { bytesDownloaded: event.bytesDownloaded }
      : {}),
    ...(typeof event.totalBytes === 'number' ? { totalBytes: event.totalBytes } : {}),
    message: String(event.message || ''),
    ...(event.error ? { error: String(event.error) } : {}),
    updatedAt: event.updatedAt || new Date().toISOString(),
  };

  for (const listener of compatRunnerProgressListeners) {
    try {
      listener(normalized);
    } catch {}
  }

  if (typeof options.onRunnerProgress === 'function') {
    try {
      options.onRunnerProgress(normalized);
    } catch {}
  }

  if (options._skipBroadcastCompatRunnerIpc !== true) {
    try {
      /** @type {Set<any>} */
      const targetWindows = new Set();
      const electronMod = getElectron();
      const BrowserWindow = electronMod?.BrowserWindow;
      if (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function') {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win) targetWindows.add(win);
        }
      }
      if (typeof getMainWindow === 'function') {
        const mainWin = getMainWindow();
        if (mainWin) targetWindows.add(mainWin);
      }
      for (const win of targetWindows) {
        if (
          win &&
          (typeof win.isDestroyed !== 'function' || !win.isDestroyed()) &&
          win.webContents &&
          (typeof win.webContents.isDestroyed !== 'function' || !win.webContents.isDestroyed()) &&
          typeof win.webContents.send === 'function'
        ) {
          win.webContents.send('launcher:compat-runner-progress', normalized);
        }
      }
    } catch {}
  }
}

/**
 * Cancel an active background install or update operation for `runnerType`.
 *
 * @param {string} runnerType
 * @returns {{ success: boolean, cancelled: boolean }}
 */
function cancelCompatibilityLayerOperation(runnerType) {
  const cleanRunnerType = String(runnerType || '')
    .trim()
    .toLowerCase()
    .replace(/^runner_/, '');
  if (!cleanRunnerType) {
    return { success: false, cancelled: false };
  }
  const activeEntry = activeCompatRunnerOps.get(cleanRunnerType);
  if (!activeEntry) {
    return { success: true, cancelled: false };
  }
  try {
    activeEntry.controller.abort();
  } catch {}
  emitCompatibilityRunnerProgress({
    runnerType: cleanRunnerType,
    operation: activeEntry.operation,
    phase: 'cancelled',
    progressPercent: null,
    message: 'Compatibility runner operation cancelled.',
  });
  return { success: true, cancelled: true };
}

/**
 * Open a native macOS file picker restricted to runner installer archives (`.zip`, `.dmg`, `.tar.xz`, `.txz`).
 *
 * @param {string} [defaultPath]
 * @param {Record<string, any>} [options]
 * @returns {Promise<string | null>}
 */
async function selectRunnerArchiveDialog(defaultPath, options = {}) {
  /** @type {Record<string, any>} */
  const dialogOptions = {
    title: 'Select Compatibility Runner Installer Archive',
    buttonLabel: 'Select Archive',
    properties: ['openFile'],
    filters: [
      {
        name: 'Runner Installer Archive',
        extensions: ['zip', 'dmg', 'xz', 'txz'],
      },
    ],
  };
  if (typeof defaultPath === 'string' && defaultPath.trim() && !defaultPath.includes('\0')) {
    dialogOptions.defaultPath = toLocalFsPath(defaultPath.trim());
  }

  if (typeof options.showOpenDialogFn === 'function') {
    const mockRes = await options.showOpenDialogFn(dialogOptions);
    if (!mockRes || mockRes.canceled || !Array.isArray(mockRes.filePaths) || !mockRes.filePaths[0]) {
      return null;
    }
    return String(mockRes.filePaths[0]);
  }

  const electronMod = getElectron();
  const dialog = electronMod?.dialog;
  if (!dialog || typeof dialog.showOpenDialog !== 'function') {
    return null;
  }
  const BrowserWindow = electronMod?.BrowserWindow;
  const focusedWin =
    BrowserWindow && typeof BrowserWindow.getFocusedWindow === 'function'
      ? BrowserWindow.getFocusedWindow()
      : null;
  const res = focusedWin
    ? await dialog.showOpenDialog(focusedWin, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (!res || res.canceled || !Array.isArray(res.filePaths) || !res.filePaths[0]) {
    return null;
  }
  return String(res.filePaths[0]);
}

/**
 * Extract candidate archive download URLs from HTML/RSS/text payloads.
 *
 * @param {string} text
 * @param {string[]} [list]
 * @returns {string[]}
 */
function extractCandidateLinksFromText(text, list = []) {
  if (typeof text !== 'string' || !text) return list;
  const hrefMatches = text.matchAll(
    /\b(?:href|data-href|data-(?:download-)?url)=["']([^"']+)["']/gi
  );
  for (const m of hrefMatches) {
    if (m[1]) list.push(m[1].trim());
  }
  const urlMatches = text.matchAll(/https?:\/\/[^\s"'<>]+\.(?:zip|dmg)\b/gi);
  for (const m of urlMatches) {
    if (m[0]) list.push(m[0].trim());
  }
  const pathMatches = text.matchAll(/\/preview\/download\/[^\s"'<>]+\.(?:zip|dmg)\b/gi);
  for (const m of pathMatches) {
    if (m[0]) list.push(m[0].trim());
  }
  return list;
}

const PREVIEW_DOWNLOAD_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** @type {{ standard: { url: string, timestamp: number } | null, arm64: { url: string, timestamp: number } | null }} */
const cachedPreviewDownloadUrlsByBranch = {
  standard: null,
  arm64: null,
};

/**
 * Parse a strict 8-digit preview build date (`YYYYMMDD`) into a finite integer,
 * guarding against `NaN` from semver or malformed strings.
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
 * Classify a CrossOver Preview target URL or filename into `'arm64'`, `'standard'`, or `null`.
 *
 * @param {unknown} rawTarget
 * @returns {'arm64' | 'standard' | null}
 */
function classifyPreviewBranchFromTarget(rawTarget) {
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
 * Resolve `'standard' | 'arm64'` preview branch from options or runnerType.
 *
 * @param {Record<string, any> | string | null | undefined} branchOrOptions
 * @param {string} [fallbackRunnerType]
 * @returns {'standard' | 'arm64'}
 */
function resolvePreviewBranchFromOptions(branchOrOptions = undefined, fallbackRunnerType = undefined) {
  if (typeof branchOrOptions === 'string') {
    const s = branchOrOptions.trim().toLowerCase();
    if (s === 'arm64' || s === 'crossover_preview_arm64' || s === 'runner_crossover_preview_arm64') {
      return 'arm64';
    }
    if (s === 'standard' || s === 'crossover_preview' || s === 'runner_crossover_preview') {
      return 'standard';
    }
  } else if (branchOrOptions && typeof branchOrOptions === 'object') {
    const rawBranch = String(branchOrOptions.previewBranch || branchOrOptions.branch || '')
      .trim()
      .toLowerCase();
    if (rawBranch === 'arm64') return 'arm64';
    if (rawBranch === 'standard') return 'standard';
    const rawRunner = String(
      branchOrOptions.runnerType || branchOrOptions.componentId || ''
    )
      .trim()
      .toLowerCase();
    if (rawRunner === 'crossover_preview_arm64' || rawRunner === 'runner_crossover_preview_arm64') {
      return 'arm64';
    }
    if (rawRunner === 'crossover_preview' || rawRunner === 'runner_crossover_preview') {
      return 'standard';
    }
  }
  const fb = String(fallbackRunnerType || '').trim().toLowerCase();
  return fb === 'crossover_preview_arm64' || fb === 'runner_crossover_preview_arm64'
    ? 'arm64'
    : 'standard';
}

/**
 * Validate whether a Sparkle `SUFeedURL` is a genuine CrossOver Preview feed URL
 * (rejecting Stable `cxmac.xml` and any non-preview Sparkle feed).
 *
 * @param {string} rawUrl
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isPreviewSparkleFeedUrl(rawUrl, options = {}) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    const isAllowedHost =
      (options.allowLoopbackInstallerUrls === true &&
        (host === '127.0.0.1' || host === 'localhost') &&
        (parsed.protocol === 'http:' || parsed.protocol === 'https:')) ||
      (parsed.protocol === 'https:' &&
        (host === 'codeweavers.com' ||
          host === 'www.codeweavers.com' ||
          host === 'media.codeweavers.com'));
    if (!isAllowedHost) return false;
    const pathname = parsed.pathname.toLowerCase();
    const base = path.basename(pathname);
    if (base === 'cxmac.xml' || !/preview/i.test(pathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that a parsed Sparkle enclosure URL targets CrossOver Preview and matches the
 * requested branch (`'standard'` vs `'arm64'`).
 *
 * @param {string} enclosureUrl
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isPreviewSparkleEnclosureValid(enclosureUrl, options = {}) {
  const raw = String(enclosureUrl || '').trim();
  if (!raw) return false;
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(raw);
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    const isAllowedHost =
      (options.allowLoopbackInstallerUrls === true &&
        (host === '127.0.0.1' || host === 'localhost') &&
        (parsed.protocol === 'http:' || parsed.protocol === 'https:')) ||
      (parsed.protocol === 'https:' &&
        (host === 'codeweavers.com' || host.endsWith('.codeweavers.com')));
    if (!isAllowedHost) return false;
  } catch {
    return false;
  }
  let decodedPathname = parsed.pathname || '';
  try {
    decodedPathname = decodeURIComponent(decodedPathname);
  } catch {}
  if (!/\.(?:zip|dmg)$/i.test(path.basename(decodedPathname))) {
    return false;
  }
  const requestedBranch = resolvePreviewBranchFromOptions(options);
  const classified = classifyPreviewBranchFromTarget(raw);
  if (!classified) return false;
  return classified === requestedBranch;
}

/**
 * Determine whether `branchOrOptions` explicitly specifies a preview branch selector.
 *
 * @param {unknown} branchOrOptions
 * @returns {boolean}
 */
function hasExplicitPreviewBranchSelector(branchOrOptions) {
  if (typeof branchOrOptions === 'string') {
    return branchOrOptions.trim().length > 0;
  }
  if (branchOrOptions && typeof branchOrOptions === 'object') {
    const obj = /** @type {Record<string, any>} */ (branchOrOptions);
    return Boolean(
      String(obj.previewBranch || obj.branch || obj.runnerType || obj.componentId || '').trim()
    );
  }
  return false;
}

/**
 * Store an authenticated CodeWeavers Preview archive URL in the branch-keyed in-memory cache.
 *
 * @param {string} url
 * @param {Record<string, any> | 'standard' | 'arm64'} [branchOrOptions]
 */
function setCachedAuthenticatedPreviewUrl(url, branchOrOptions = undefined) {
  if (typeof url !== 'string' || !url.trim()) return;
  const trimmed = url.trim();
  const opts =
    branchOrOptions && typeof branchOrOptions === 'object'
      ? /** @type {Record<string, any>} */ (branchOrOptions)
      : {};
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) return;
    const host = parsed.hostname.toLowerCase();
    const isAllowedLoopback =
      opts.allowLoopbackInstallerUrls === true &&
      (host === '127.0.0.1' || host === 'localhost') &&
      (parsed.protocol === 'http:' || parsed.protocol === 'https:');
    const isAllowedCodeWeavers =
      parsed.protocol === 'https:' &&
      (host === 'codeweavers.com' || host.endsWith('.codeweavers.com'));
    if (!isAllowedLoopback && !isAllowedCodeWeavers) return;
    let decodedPath = parsed.pathname || '';
    try {
      decodedPath = decodeURIComponent(decodedPath);
    } catch {}
    if (!/\.(?:zip|dmg)$/i.test(path.basename(decodedPath))) return;
  } catch {
    return;
  }
  const branch = hasExplicitPreviewBranchSelector(branchOrOptions)
    ? resolvePreviewBranchFromOptions(branchOrOptions)
    : classifyPreviewBranchFromTarget(trimmed) === 'arm64'
      ? 'arm64'
      : 'standard';
  cachedPreviewDownloadUrlsByBranch[branch] = {
    url: trimmed,
    timestamp: Date.now(),
  };
}

function cacheAuthenticatedPreviewUrl(url, branchOrOptions = undefined) {
  setCachedAuthenticatedPreviewUrl(url, branchOrOptions);
}

/**
 * Clear the cached authenticated Preview URL for a specific branch or all branches.
 *
 * @param {Record<string, any> | 'standard' | 'arm64' | string | null} [branchOrOptions]
 * @param {{ skipProberInvalidation?: boolean }} [internalOpts]
 */
function clearCachedAuthenticatedPreviewUrl(branchOrOptions = undefined, internalOpts = {}) {
  if (!hasExplicitPreviewBranchSelector(branchOrOptions)) {
    cachedPreviewDownloadUrlsByBranch.standard = null;
    cachedPreviewDownloadUrlsByBranch.arm64 = null;
  } else {
    const branch = resolvePreviewBranchFromOptions(branchOrOptions);
    cachedPreviewDownloadUrlsByBranch[branch] = null;
  }
  if (!internalOpts?.skipProberInvalidation) {
    try {
      const prober = require('../environmentHealthProber.cjs');
      if (typeof prober?.invalidateProberRunnerUpdatesCache === 'function') {
        prober.invalidateProberRunnerUpdatesCache({ skipPreviewUrlCacheClear: true });
      }
    } catch {}
  }
}

if (typeof registerExternalCacheInvalidator === 'function') {
  registerExternalCacheInvalidator((invOpts) => {
    if (!invOpts?.skipPreviewUrlCacheClear) {
      clearCachedAuthenticatedPreviewUrl(undefined, { skipProberInvalidation: true });
    }
  });
}

function getCachedAuthenticatedPreviewUrl(options = {}) {
  if (
    options.allowCachedPreviewUrlInTest !== true &&
    (isTestEnvironment(options) ||
      options.previewPortalHtml ||
      options.previewCandidateUrls ||
      options.httpGetText ||
      options.fetchFn)
  ) {
    return null;
  }
  const branch = resolvePreviewBranchFromOptions(options);
  const entry = cachedPreviewDownloadUrlsByBranch[branch];
  if (!entry || !entry.url) return null;
  if (Date.now() - entry.timestamp > PREVIEW_DOWNLOAD_CACHE_TTL_MS) {
    cachedPreviewDownloadUrlsByBranch[branch] = null;
    return null;
  }
  return entry.url;
}

async function checkCompatibilityLayerUpdates(/** @type {any} */ options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const platform = safeOptions.platform || process.platform;
  if (platform !== 'darwin') {
    return {};
  }
  const layers = Array.isArray(safeOptions.layers)
    ? safeOptions.layers
    : detectCompatibilityLayers(safeOptions);
  const runnerTypes = [
    'crossover',
    'crossover_preview',
    'crossover_preview_arm64',
    'gptk',
    'wine',
  ];
  /** @type {Record<string, string>} */
  const defaultDownloadUrls = {
    crossover: 'https://www.codeweavers.com/crossover/download',
    crossover_preview: 'https://www.codeweavers.com/preview/download',
    crossover_preview_arm64: 'https://www.codeweavers.com/preview/download',
    gptk: 'https://github.com/Gcenx/game-porting-toolkit/releases/latest',
    wine: 'https://github.com/Gcenx/macOS_Wine_builds/releases/latest',
  };

  const hostArch = String(options?.arch || process.arch || 'arm64');
  const darwinKernelMajor =
    options?.darwinKernelMajor !== undefined
      ? Number(options.darwinKernelMajor)
      : typeof options?.osRelease === 'string' && options.osRelease.trim()
        ? Number.parseInt(options.osRelease.trim().split('.')[0] || '0', 10) || 24
        : process.platform === 'darwin'
          ? Number.parseInt(String(os.release() || '24.0.0').split('.')[0] || '24', 10) || 24
          : 24;
  const isGptkDirectSupported = hostArch === 'arm64' && darwinKernelMajor >= 23;

  const isAllowedCodeWeaversFeedUrl = (/** @type {string} */ rawUrl) => {
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
        host === 'www.codeweavers.com' ||
        host === 'media.codeweavers.com'
      );
    } catch {
      return false;
    }
  };

  const parseSparkleEnclosureFeed = (
    /** @type {string} */ xml,
    /** @type {string} */ fallbackDownloadUrl
  ) => {
    const encMatch = xml.match(/<enclosure\b([^>]*)>/i);
    if (!encMatch) return null;
    const attrs = encMatch[1];
    const verMatch = attrs.match(/\bsparkle:version=["']([^"']+)["']/i);
    const shortMatch = attrs.match(/\bsparkle:shortVersionString=["']([^"']+)["']/i);
    const urlMatch = attrs.match(/\burl=["']([^"']+)["']/i);
    const lenMatch = attrs.match(/\blength=["'](\d+)["']/i);
    const edSigMatch = attrs.match(/\bsparkle:edSignature=["']([^"']+)["']/i);
    const rawBundleVer = verMatch ? verMatch[1].trim() : '';
    const rawShortVer = shortMatch ? shortMatch[1].trim() : '';
    const parsedLength = lenMatch ? Number.parseInt(lenMatch[1], 10) : 0;
    const candidateUrl = urlMatch ? urlMatch[1].trim() : '';
    const previewDate =
      extractRunnerPreviewDate(rawShortVer) ||
      extractRunnerPreviewDate(rawBundleVer) ||
      extractRunnerPreviewDate(candidateUrl);
    const bundleSemverMatch = rawBundleVer.match(/^(\d+\.\d+\.\d+)(?:\.(\d+))?$/);
    const shortSemverMatch = rawShortVer.match(/(\d+\.\d+(?:\.\d+)?)/);
    const semver = bundleSemverMatch
      ? bundleSemverMatch[1]
      : shortSemverMatch
        ? shortSemverMatch[1]
        : '';
    const buildNum = bundleSemverMatch && bundleSemverMatch[2] ? bundleSemverMatch[2] : '';

    let latestVersion;
    let latestBuildVersion;
    let latestDisplayVersion;

    if (previewDate) {
      latestVersion = previewDate;
      latestBuildVersion = bundleSemverMatch ? rawBundleVer : (previewDate || undefined);
      latestDisplayVersion = semver
        ? `${semver} (Preview ${previewDate})`
        : `Preview ${previewDate}`;
    } else if (semver) {
      latestVersion = semver;
      latestBuildVersion = buildNum ? `Build ${buildNum}` : rawBundleVer || undefined;
      latestDisplayVersion = buildNum
        ? `${semver} (Build ${buildNum})`
        : latestBuildVersion && !String(latestVersion).includes(String(latestBuildVersion))
          ? `${latestVersion} (${latestBuildVersion})`
          : latestVersion;
    } else {
      latestVersion = rawShortVer || rawBundleVer || undefined;
      latestBuildVersion =
        rawBundleVer && rawBundleVer !== latestVersion ? rawBundleVer : undefined;
      latestDisplayVersion = latestBuildVersion
        ? `${latestVersion} (${latestBuildVersion})`
        : latestVersion;
    }

    if (!latestVersion) return null;
    const safeUrl =
      candidateUrl && isAllowedCodeWeaversFeedUrl(candidateUrl)
        ? candidateUrl
        : fallbackDownloadUrl;
    return {
      latestVersion,
      rawBundleVersion: rawBundleVer || undefined,
      latestBuildVersion,
      latestDisplayVersion,
      downloadUrl: safeUrl,
      hasDirectEnclosureUrl: Boolean(candidateUrl && isAllowedCodeWeaversFeedUrl(candidateUrl)),
      ...(previewDate ? { previewDate } : {}),
      ...(semver ? { semver } : {}),
      ...(parsedLength > 0 ? { estimatedDownloadBytes: parsedLength } : {}),
      ...(edSigMatch ? { sparkleEdSignature: edSigMatch[1].trim() } : {}),
    };
  };

  /** @type {Record<string, any>} */
  const feedMap = {};
  const defaultTimeoutMs = Number(options.timeoutMs || 4500);
  if (options.mockFeeds && typeof options.mockFeeds === 'object') {
    for (const rt of runnerTypes) {
      if (options.mockFeeds[rt]) {
        feedMap[rt] = { ...options.mockFeeds[rt] };
      }
    }
  } else if (
    !options.skipNetwork &&
    (options.previewCandidateUrls ||
      options.previewPortalHtml ||
      typeof options.httpGetText === 'function' ||
      typeof options.fetchFn === 'function' ||
      typeof options.previewSessionFetch === 'function' ||
      typeof options.sessionFetch === 'function' ||
      !isTestEnvironment(options) ||
      !options.homedir)
  ) {
    const resolvePreviewFetch = () => {
      if (typeof options.previewSessionFetch === 'function') {
        return options.previewSessionFetch;
      }
      if (typeof options.sessionFetch === 'function') {
        return options.sessionFetch;
      }
      const electronMod = (options && options.electronMod) || getElectron();
      const sessionMod = electronMod?.session;
      if (sessionMod && typeof sessionMod.fromPartition === 'function') {
        try {
          const previewSession = sessionMod.fromPartition('persist:codeweavers-preview');
          const cleanBrowserUa =
            process.platform === 'win32'
              ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
              : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
          try {
            if (typeof previewSession?.setUserAgent === 'function') {
              previewSession.setUserAgent(cleanBrowserUa);
            }
          } catch {}
          if (typeof previewSession?.fetch === 'function') {
            return (/** @type {string} */ u, /** @type {any} */ fetchOpts) => {
              const { redirect: _stripRedirect, ...safeOpts } = fetchOpts || {};
              return previewSession.fetch(u, { ...safeOpts, credentials: 'include' });
            };
          }
          if (previewSession?.net && typeof previewSession.net.fetch === 'function') {
            return (/** @type {string} */ u, /** @type {any} */ fetchOpts) => {
              const { redirect: _stripRedirect, ...safeOpts } = fetchOpts || {};
              return previewSession.net.fetch(u, { ...safeOpts, credentials: 'include' });
            };
          }
        } catch {}
      }
      return null;
    };

    const fetchResponseWithTimeout = async (
      /** @type {string} */ url,
      timeoutMs = defaultTimeoutMs,
      /** @type {((u: string, opts?: any) => Promise<any>) | null} */ customFetchImpl = null
    ) => {
      if (!customFetchImpl && typeof options.httpGetText === 'function') {
        try {
          const text = await options.httpGetText(url);
          return text !== null && text !== undefined
            ? {
                ok: true,
                status: 200,
                url,
                text: String(text),
                isRedirectedToLogin: false,
                hasPasswordInput: false,
              }
            : null;
        } catch {
          return null;
        }
      }
      const fetchImpl =
        customFetchImpl ||
        (typeof options.fetchFn === 'function' ? options.fetchFn : globalThis.fetch);
      if (typeof fetchImpl !== 'function') return null;
      const defaultUa =
        process.platform === 'win32'
          ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
          : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer?.unref === 'function') timer.unref();
      try {
        const res = await fetchImpl(url, {
          signal: controller.signal,
          headers: { 'User-Agent': defaultUa },
        });
        if (!res) return null;
        const resUrl = String(res.url || '').toLowerCase();
        const text = typeof res.text === 'function' ? await res.text() : '';
        const isRedirectedToLogin =
          resUrl.includes('/login') ||
          resUrl.includes('/signin') ||
          resUrl.includes('/account/login') ||
          (typeof text === 'string' &&
            (/<title>[^<]*Sign\s*In[^<]*\|[^<]*CodeWeavers/i.test(text) ||
              /data-gourl=["'][^"']*(?:login|signin)/i.test(text) ||
              /<form[^>]+action=["'][^"']*(?:login|signin)/i.test(text) ||
              /<input[^>]+type=["']password["']/i.test(text)));
        const hasPasswordInput =
          typeof text === 'string' &&
          (/<input[^>]+type=["']password["']/i.test(text) ||
            /<form[^>]+action=["'][^"']*(?:login|signin)/i.test(text) ||
            /<title>[^<]*Sign\s*In[^<]*\|[^<]*CodeWeavers/i.test(text) ||
            /data-gourl=["'][^"']*(?:login|signin)/i.test(text));
        return {
          ok: Boolean(res.ok),
          status: res.status,
          url: res.url,
          isRedirectedToLogin,
          hasPasswordInput,
          text,
        };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    const fetchWithTimeout = async (/** @type {string} */ url, timeoutMs = defaultTimeoutMs) => {
      const resp = await fetchResponseWithTimeout(url, timeoutMs);
      return resp && resp.ok ? resp.text : null;
    };

    const wineLayer = layers.find((/** @type {any} */ l) => l.type === 'wine');
    const gptkLayer = layers.find((/** @type {any} */ l) => l.type === 'gptk');
    const previewStandardLayer = layers.find(
      (/** @type {any} */ l) => l.type === 'crossover_preview'
    );
    const previewArm64Layer = layers.find(
      (/** @type {any} */ l) => l.type === 'crossover_preview_arm64'
    );

    await Promise.all([
      (async () => {
        const xml = await fetchWithTimeout('https://www.codeweavers.com/xml/versions/cxmac.xml');
        if (xml) {
          const parsed = parseSparkleEnclosureFeed(xml, defaultDownloadUrls.crossover);
          if (parsed) {
            const { hasDirectEnclosureUrl: _unused, ...rest } = parsed;
            feedMap.crossover = {
              ...rest,
              updateMethod: 'direct_download',
            };
          }
        }
      })(),
      (async () => {
    const isAllowedCodeWeaversRedirectUrl = (/** @type {string} */ rawUrl) => {
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
    };

    const previewFetch = resolvePreviewFetch();
        const explicitFeedUrl = String(options.previewFeedUrl || '').trim();
        const explicitFeedBranch = explicitFeedUrl
          ? resolvePreviewBranchFromOptions(options)
          : null;

        const tryPreviewSparkleFeed = async (
          /** @type {any} */ targetLayer,
          /** @type {'standard' | 'arm64'} */ branch,
          /** @type {'crossover_preview' | 'crossover_preview_arm64'} */ targetRunnerType
        ) => {
          let plistDict = {};
          if (targetLayer?.appPath) {
            plistDict = parsePlistStringValues(
              path.join(targetLayer.appPath, 'Contents/Info.plist')
            );
          }
          const rawSuFeedUrl =
            explicitFeedUrl && explicitFeedBranch === branch
              ? explicitFeedUrl
              : String(plistDict.SUFeedURL || '').trim();
          const rawSuPubKey = String(plistDict.SUPublicEDKey || '').trim();
          if (!rawSuFeedUrl || !isPreviewSparkleFeedUrl(rawSuFeedUrl, options)) {
            return;
          }
          const feedResp = await fetchResponseWithTimeout(
            rawSuFeedUrl,
            defaultTimeoutMs,
            previewFetch
          );
          if (feedResp?.url) {
            if (!isAllowedCodeWeaversRedirectUrl(feedResp.url)) {
              return;
            }
            try {
              if (path.basename(new URL(feedResp.url).pathname).toLowerCase() === 'cxmac.xml') {
                return;
              }
            } catch {
              return;
            }
          }
          const xml = feedResp && feedResp.ok ? feedResp.text : null;
          if (!xml) return;
          const parsed = parseSparkleEnclosureFeed(xml, defaultDownloadUrls[targetRunnerType]);
          if (
            parsed &&
            parsed.hasDirectEnclosureUrl &&
            isPreviewSparkleEnclosureValid(parsed.downloadUrl, {
              ...options,
              previewBranch: branch,
            })
          ) {
            const { hasDirectEnclosureUrl: _unused, ...rest } = parsed;
            feedMap[targetRunnerType] = {
              ...rest,
              feedUrl: rawSuFeedUrl,
              previewBranch: branch,
              ...(rawSuPubKey ? { sparklePublicEdKey: rawSuPubKey } : {}),
              canAutoUpdate: true,
              updateMethod: 'direct_download',
              authRequired: false,
            };
          }
        };

        await Promise.all([
          tryPreviewSparkleFeed(previewStandardLayer, 'standard', 'crossover_preview'),
          tryPreviewSparkleFeed(previewArm64Layer, 'arm64', 'crossover_preview_arm64'),
        ]);

        if (!feedMap.crossover_preview || !feedMap.crossover_preview_arm64) {
          const rawPortalUrlOpt =
            typeof options.previewPortalUrl === 'string' ? options.previewPortalUrl.trim() : '';
          const isPortalUrlValid =
            !rawPortalUrlOpt || isAllowedCodeWeaversFeedUrl(rawPortalUrlOpt);
          const portalUrl = isPortalUrlValid
            ? rawPortalUrlOpt || defaultDownloadUrls.crossover_preview
            : defaultDownloadUrls.crossover_preview;
          /** @type {string[]} */
          const candidateUrls = [];
          let isPreviewUnauthenticated = false;
          let isCloudflareChallenge = false;
          let portalProbeAttempted = false;
          let portalProbeSucceeded = false;

          const isLoginHtml = (/** @type {string} */ html) =>
            /<input[^>]+type=["']password["']/i.test(html) ||
            /<form[^>]+action=["'][^"']*(?:login|signin)/i.test(html) ||
            /action=["'][^"']*(?:login|signin)/i.test(html) ||
            /<title>[^<]*Sign\s*In[^<]*\|[^<]*CodeWeavers/i.test(html) ||
            /data-gourl=["'][^"']*(?:login|signin)/i.test(html);

          const isChallengeHtml = (/** @type {string} */ html) =>
            /<title>\s*Just a moment\b/i.test(html) ||
            /cf-challenge-running|challenge-platform|challenges\.cloudflare\.com|cf-turnstile-response|id=["']challenge-form["']/i.test(
              html
            );

          if (!isPortalUrlValid) {
            portalProbeAttempted = true;
            portalProbeSucceeded = false;
            isPreviewUnauthenticated = true;
          } else {
            if (Array.isArray(options.previewCandidateUrls)) {
              for (const u of options.previewCandidateUrls) {
                if (typeof u === 'string' && u.trim()) candidateUrls.push(u.trim());
              }
            }
            if (typeof options.previewPortalHtml === 'string' && options.previewPortalHtml.trim()) {
              if (isChallengeHtml(options.previewPortalHtml)) {
                isCloudflareChallenge = true;
              } else if (isLoginHtml(options.previewPortalHtml)) {
                isPreviewUnauthenticated = true;
              } else {
                extractCandidateLinksFromText(options.previewPortalHtml, candidateUrls);
              }
            }
            if (
              candidateUrls.length === 0 &&
              !isPreviewUnauthenticated &&
              !isCloudflareChallenge &&
              !options.skipNetwork
            ) {
              portalProbeAttempted = true;
              const portalProbe = await fetchResponseWithTimeout(
                portalUrl,
                defaultTimeoutMs,
                previewFetch
              );
              if (!portalProbe || !portalProbe.ok) {
                portalProbeSucceeded = false;
                if (portalProbe && (portalProbe.status === 401 || portalProbe.status === 403)) {
                  isPreviewUnauthenticated = true;
                }
                if (portalProbe && typeof portalProbe.text === 'string' && isChallengeHtml(portalProbe.text)) {
                  isCloudflareChallenge = true;
                }
              } else if (portalProbe.url && !isAllowedCodeWeaversRedirectUrl(portalProbe.url)) {
                portalProbeSucceeded = false;
                isPreviewUnauthenticated = true;
              } else {
                const probeText = typeof portalProbe.text === 'string' ? portalProbe.text : '';
                if (isChallengeHtml(probeText)) {
                  isCloudflareChallenge = true;
                } else if (
                  portalProbe.isRedirectedToLogin ||
                  portalProbe.hasPasswordInput ||
                  isLoginHtml(probeText)
                ) {
                  isPreviewUnauthenticated = true;
                } else {
                  portalProbeSucceeded = true;
                  if (probeText) {
                    extractCandidateLinksFromText(probeText, candidateUrls);
                  }
                }
              }
            }
          }

          if (isPreviewUnauthenticated || isCloudflareChallenge) {
            clearCachedAuthenticatedPreviewUrl();
          }

          const canReadCachedUrls =
            !isPreviewUnauthenticated &&
            !isCloudflareChallenge &&
            (!portalProbeAttempted || portalProbeSucceeded);

          const {
            selectPreferredCrossOverPreviewDownloadUrl,
            discoverCrossOverPreviewBranchUrls,
            extractPreviewFilenameVersionHint,
          } = require('../environmentProvisioner.cjs');

          const branchCandidates = [...candidateUrls];
          if (canReadCachedUrls) {
            const cachedStd = getCachedAuthenticatedPreviewUrl({
              ...options,
              previewBranch: 'standard',
            });
            if (cachedStd && !branchCandidates.includes(cachedStd)) {
              branchCandidates.push(cachedStd);
            }
            const cachedArm64 = getCachedAuthenticatedPreviewUrl({
              ...options,
              previewBranch: 'arm64',
            });
            if (cachedArm64 && !branchCandidates.includes(cachedArm64)) {
              branchCandidates.push(cachedArm64);
            }
          }

          const discoveredBranches =
            branchCandidates.length > 0
              ? typeof discoverCrossOverPreviewBranchUrls === 'function'
                ? discoverCrossOverPreviewBranchUrls(branchCandidates, portalUrl, options)
                : {
                    standard: selectPreferredCrossOverPreviewDownloadUrl(
                      branchCandidates,
                      portalUrl,
                      { ...options, previewBranch: 'standard' }
                    ),
                    arm64: selectPreferredCrossOverPreviewDownloadUrl(
                      branchCandidates,
                      portalUrl,
                      { ...options, previewBranch: 'arm64' }
                    ),
                  }
              : { standard: null, arm64: null };

          const applyBranchFeed = (
            /** @type {'standard' | 'arm64'} */ branch,
            /** @type {'crossover_preview' | 'crossover_preview_arm64'} */ targetRunnerType,
            /** @type {any} */ targetLayer
          ) => {
            if (feedMap[targetRunnerType]) return;
            const bestArchiveUrl = discoveredBranches[branch];
            if (bestArchiveUrl) {
              setCachedAuthenticatedPreviewUrl(bestArchiveUrl, {
                ...options,
                previewBranch: branch,
              });
              let filename = '';
              try {
                filename = path.basename(new URL(bestArchiveUrl, portalUrl).pathname);
              } catch {
                filename = path.basename(bestArchiveUrl);
              }
              const previewDate =
                extractRunnerPreviewDate(filename) || extractRunnerPreviewDate(bestArchiveUrl);
              const versionHint = extractPreviewFilenameVersionHint(filename);
              const semverMatch = filename.match(/(\d+\.\d+(?:\.\d+)?)/);
              const layerSemver =
                targetLayer?.version && /^\d+\.\d+(?:\.\d+)?$/.test(targetLayer.version)
                  ? targetLayer.version
                  : null;
              const effectiveSemver = semverMatch ? semverMatch[1] : layerSemver || null;

              const latestVer = previewDate || versionHint || effectiveSemver || 'Preview';
              const latestBuild = previewDate || versionHint || effectiveSemver || 'Preview';
              const latestDisplay = previewDate
                ? effectiveSemver
                  ? `${effectiveSemver} (Preview ${previewDate})`
                  : `Preview ${previewDate}`
                : versionHint || effectiveSemver || 'Preview';

              feedMap[targetRunnerType] = {
                latestVersion: latestVer,
                latestBuildVersion: latestBuild,
                latestDisplayVersion: latestDisplay,
                previewDate: previewDate || undefined,
                semver: effectiveSemver || undefined,
                previewBranch: branch,
                downloadUrl: bestArchiveUrl,
                canAutoUpdate: true,
                updateMethod: 'direct_download',
                authRequired: false,
              };
            } else if (!options.skipNetwork) {
              feedMap[targetRunnerType] = {
                authRequired: true,
                previewBranch: branch,
                canAutoUpdate: true,
                updateMethod: 'direct_download',
              };
            }
          };

          applyBranchFeed('standard', 'crossover_preview', previewStandardLayer);
          applyBranchFeed('arm64', 'crossover_preview_arm64', previewArm64Layer);
        }
      })(),
      (async () => {
        const txt = await fetchWithTimeout(
          'https://api.github.com/repos/Gcenx/game-porting-toolkit/releases/latest'
        );
        if (txt) {
          try {
            const json = JSON.parse(txt);
            const tag = String(json.tag_name || '');
            const m = tag.match(/(\d+\.\d+(?:\.\d+)?(?:[-_][0-9A-Za-z.]+)?)/);
            if (m) {
              const rawVer = m[1];
              const assets = Array.isArray(json.assets) ? json.assets : [];
              const archiveAsset =
                assets.find((/** @type {any} */ a) =>
                  /\.(?:tar\.xz|txz)$/i.test(String(a?.name || ''))
                ) ||
                assets.find((/** @type {any} */ a) => /\.dmg$/i.test(String(a?.name || '')));
              const assetBytes =
                typeof archiveAsset?.size === 'number' && archiveAsset.size > 0
                  ? archiveAsset.size
                  : undefined;
              const externalGptkMgr = getExternalManagerForLayer(gptkLayer);
              feedMap.gptk = {
                latestVersion: rawVer.replace(/[-_]/g, '.'),
                latestBuildVersion: rawVer,
                latestDisplayVersion: rawVer,
                downloadUrl:
                  (isGptkDirectSupported && archiveAsset?.browser_download_url) ||
                  json.html_url ||
                  defaultDownloadUrls.gptk,
                ...(assetBytes ? { estimatedDownloadBytes: assetBytes } : {}),
                updateMethod:
                  !externalGptkMgr && isHomebrewManagedLayer(gptkLayer)
                    ? 'homebrew_cask'
                    : isGptkDirectSupported
                      ? 'direct_download'
                      : 'vendor_portal',
              };
            }
          } catch {}
        }
      })(),
      (async () => {
        const wineBinStr = String(wineLayer?.binaryPath || '').replace(/\\/g, '/');
        const wineAppStr = String(wineLayer?.appPath || '').replace(/\\/g, '/');
        const wineNameStr = String(wineLayer?.name || '');
        const wineCombinedStr = `${wineNameStr} ${wineAppStr} ${wineBinStr}`;

        const isRetiredWineCrossOver =
          Boolean(wineLayer) && /wine[-_\s]*crossover/i.test(wineCombinedStr);
        if (isRetiredWineCrossOver) {
          return;
        }

        const externalWineMgr = getExternalManagerForLayer(wineLayer);
        const explicitWineChan = String(options.wineChannel || '')
          .trim()
          .toLowerCase();
        const wineChannel =
          explicitWineChan === 'staging' ||
          explicitWineChan === 'devel' ||
          explicitWineChan === 'stable'
            ? explicitWineChan
            : /wine[-_\s]*staging/i.test(wineCombinedStr)
              ? 'staging'
              : /wine[-_\s]*devel/i.test(wineCombinedStr)
                ? 'devel'
                : 'stable';

        const caskFeedUrl =
          wineChannel === 'staging'
            ? 'https://formulae.brew.sh/api/cask/wine@staging.json'
            : wineChannel === 'devel'
              ? 'https://formulae.brew.sh/api/cask/wine@devel.json'
              : 'https://formulae.brew.sh/api/cask/wine-stable.json';
        const assetNameRe =
          wineChannel === 'staging'
            ? /wine[-_]?staging.*\.(?:tar\.xz|txz|dmg)$/i
            : wineChannel === 'devel'
              ? /wine[-_]?devel.*\.(?:tar\.xz|txz|dmg)$/i
              : /wine[-_]?stable.*\.(?:tar\.xz|txz|dmg)$/i;

        const [caskTxt, ghListTxt] = await Promise.all([
          fetchWithTimeout(caskFeedUrl),
          fetchWithTimeout(
            'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases?per_page=20'
          ),
        ]);

        /** @type {Record<string, any> | null} */
        let caskCandidate = null;
        if (caskTxt) {
          try {
            const json = JSON.parse(caskTxt);
            if (json && json.version) {
              const rawVer = String(json.version).split(',')[0].trim();
              if (rawVer) {
                caskCandidate = {
                  latestVersion: rawVer.replace(/[-_]/g, '.'),
                  latestBuildVersion: rawVer,
                  latestDisplayVersion: rawVer,
                  downloadUrl: json.url || defaultDownloadUrls.wine,
                };
              }
            }
          } catch {}
        }

        /** @type {Record<string, any> | null} */
        let ghCandidate = null;
        const parseGhReleaseItem = (/** @type {any} */ rel, allowTagFallback = false) => {
          if (!rel || rel.draft) return null;
          const assets = Array.isArray(rel.assets) ? rel.assets : [];
          const matchedAsset = assets.find((/** @type {any} */ a) =>
            assetNameRe.test(String(a?.name || ''))
          );
          if (!matchedAsset && !allowTagFallback) return null;
          const tag = String(rel.tag_name || rel.name || matchedAsset?.name || '');
          const m = tag.match(/(\d+\.\d+(?:\.\d+)?(?:[-_][0-9A-Za-z.]+)?)/);
          const rawVer = m ? m[1] : tag.replace(/^v/i, '').trim();
          if (!rawVer) return null;
          return {
            latestVersion: rawVer.replace(/[-_]/g, '.'),
            latestBuildVersion: rawVer,
            latestDisplayVersion: rawVer,
            downloadUrl:
              matchedAsset?.browser_download_url || rel.html_url || defaultDownloadUrls.wine,
            ...(typeof matchedAsset?.size === 'number' && matchedAsset.size > 0
              ? { estimatedDownloadBytes: matchedAsset.size }
              : {}),
          };
        };

        if (ghListTxt) {
          try {
            const rels = JSON.parse(ghListTxt);
            const relArray = Array.isArray(rels) ? rels : [rels];
            for (const rel of relArray) {
              const parsedRel = parseGhReleaseItem(rel, false);
              if (parsedRel) {
                ghCandidate = parsedRel;
                break;
              }
            }
          } catch {}
        }

        if (!ghCandidate) {
          const ghLatestTxt = await fetchWithTimeout(
            'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases/latest'
          );
          if (ghLatestTxt) {
            try {
              const latestObj = JSON.parse(ghLatestTxt);
              const hasAssetsArray =
                Array.isArray(latestObj?.assets) && latestObj.assets.length > 0;
              ghCandidate = parseGhReleaseItem(latestObj, !hasAssetsArray);
            } catch {}
          }
        }

        const chosenWineFeed = (() => {
          if (caskCandidate && ghCandidate) {
            const cmp = compareRunnerVersions(
              caskCandidate.latestVersion,
              ghCandidate.latestVersion
            );
            if (cmp < 0) return ghCandidate;
            if (cmp > 0) return caskCandidate;
            return {
              ...caskCandidate,
              ...ghCandidate,
            };
          }
          return ghCandidate || caskCandidate;
        })();

        if (chosenWineFeed) {
          feedMap.wine = {
            ...chosenWineFeed,
            updateMethod:
              !externalWineMgr && isHomebrewManagedLayer(wineLayer)
                ? 'homebrew_cask'
                : 'direct_download',
          };
        }
      })(),
    ]);
  }

  const checkedAt = new Date().toISOString();
  /** @type {Record<string, any>} */
  const results = {};

  for (const runnerType of runnerTypes) {
    const isPreviewBranch =
      runnerType === 'crossover_preview' || runnerType === 'crossover_preview_arm64';
    const previewBranch =
      runnerType === 'crossover_preview_arm64'
        ? 'arm64'
        : runnerType === 'crossover_preview'
          ? 'standard'
          : undefined;
    const layer = layers.find((/** @type {any} */ l) => l.type === runnerType);
    const feed = feedMap[runnerType] || {};
    const stableFeed = feedMap.crossover;
    const externalMgr = getExternalManagerForLayer(layer);
    const isRetiredWineCrossOver =
      runnerType === 'wine' &&
      Boolean(layer) &&
      /wine[-_\s]*crossover/i.test(
        `${layer?.binaryPath || ''} ${layer?.appPath || ''} ${layer?.name || ''}`
      );
    const stableSurpassesPreview = Boolean(
      runnerType === 'crossover_preview' &&
        layer &&
        layer.version &&
        stableFeed &&
        stableFeed.latestVersion &&
        compareRunnerVersions(layer.version, stableFeed.latestVersion) < 0
    );

    let latestVersion;
    let latestBuildVersion;
    let latestDisplayVersion;

    if (feed.latestVersion) {
      latestVersion = feed.latestVersion;
      latestBuildVersion = feed.latestBuildVersion;
      latestDisplayVersion =
        feed.latestDisplayVersion ||
        (latestBuildVersion && !String(latestVersion).includes(String(latestBuildVersion))
          ? `${latestVersion} (${latestBuildVersion})`
          : latestVersion);
    } else if (stableSurpassesPreview) {
      latestVersion = stableFeed.latestVersion;
      latestBuildVersion = stableFeed.latestBuildVersion;
      latestDisplayVersion = stableFeed.latestDisplayVersion || latestVersion;
    } else {
      latestVersion = layer?.version;
      latestBuildVersion = layer?.buildVersion;
      latestDisplayVersion = layer?.displayVersion;
    }

    let updateAvailable = false;
    if (layer && (layer.version || layer.previewDate) && !isRetiredWineCrossOver) {
      if (isPreviewBranch) {
        const layerDate =
          extractRunnerPreviewDate(layer) ||
          extractRunnerPreviewDate(options?.currentPreviewVersion) ||
          extractRunnerPreviewDate(options?.configuredPreviewArchive) ||
          extractRunnerPreviewDate(options?.previewDate);
        const feedDate = extractRunnerPreviewDate(feed);
        const layerDateNum = parseNumericPreviewDate(layerDate);
        const feedDateNum = parseNumericPreviewDate(feedDate);
        if (layerDateNum !== null && feedDateNum !== null) {
          if (feedDateNum > layerDateNum) {
            updateAvailable = true;
          } else if (feedDateNum < layerDateNum) {
            updateAvailable = false;
          } else {
            const layerSemver = String(layer.version || '').match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
            const feedSemver =
              feed.semver ||
              String(
                feed.latestDisplayVersion || feed.latestVersion || feed.rawBundleVersion || ''
              ).match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
            if (layerSemver && feedSemver && compareRunnerVersions(layerSemver, feedSemver) < 0) {
              updateAvailable = true;
            }
          }
        } else if (feed.latestVersion) {
          const layerSemver = String(layer.version || '').match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
          const feedSemver =
            feed.semver ||
            String(feed.latestVersion || '').match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
          if (layerSemver && feedSemver) {
            updateAvailable = compareRunnerVersions(layerSemver, feedSemver) < 0;
          } else if (feed.rawBundleVersion && layer.buildVersion) {
            updateAvailable =
              compareRunnerVersions(layer.buildVersion, feed.rawBundleVersion) < 0 ||
              compareRunnerVersions(layer.version, feed.latestVersion) < 0;
          } else {
            updateAvailable = compareRunnerVersions(layer.version, feed.latestVersion) < 0;
          }
        }
      } else if (feed.latestVersion) {
        if (feed.rawBundleVersion && layer.buildVersion) {
          updateAvailable =
            compareRunnerVersions(layer.buildVersion, feed.rawBundleVersion) < 0 ||
            compareRunnerVersions(layer.version, feed.latestVersion) < 0;
        } else {
          updateAvailable = compareRunnerVersions(layer.version, feed.latestVersion) < 0;
        }
      }
      if (!updateAvailable && stableSurpassesPreview) {
        updateAvailable = true;
        if (
          stableFeed.latestVersion &&
          (!latestVersion || compareRunnerVersions(latestVersion, stableFeed.latestVersion) < 0)
        ) {
          latestVersion = stableFeed.latestVersion;
          latestBuildVersion = stableFeed.latestBuildVersion;
          latestDisplayVersion = stableFeed.latestDisplayVersion || latestVersion;
        }
      }
    }

    /** @type {'homebrew_cask' | 'direct_download' | 'vendor_portal' | 'external_manager'} */
    let updateMethod;
    let canAutoUpdate = true;

    if (isRetiredWineCrossOver) {
      updateMethod = 'vendor_portal';
      canAutoUpdate = false;
    } else if (isPreviewBranch) {
      if (
        feed.canAutoUpdate === true ||
        feed.updateMethod === 'direct_download' ||
        stableSurpassesPreview ||
        (Boolean(layer) && updateAvailable)
      ) {
        updateMethod = 'direct_download';
        canAutoUpdate = true;
      } else {
        updateMethod = feed.updateMethod || 'vendor_portal';
        canAutoUpdate = Boolean(feed.canAutoUpdate === true);
      }
    } else if (runnerType === 'gptk') {
      if (!externalMgr && isHomebrewManagedLayer(layer)) {
        updateMethod = 'homebrew_cask';
        canAutoUpdate = true;
      } else if (isGptkDirectSupported) {
        updateMethod = 'direct_download';
        canAutoUpdate = true;
      } else {
        updateMethod = 'vendor_portal';
        canAutoUpdate = false;
      }
    } else if (runnerType === 'crossover') {
      updateMethod = 'direct_download';
      canAutoUpdate = true;
    } else {
      updateMethod =
        !externalMgr && isHomebrewManagedLayer(layer) ? 'homebrew_cask' : 'direct_download';
      canAutoUpdate = true;
    }

    const isAuthRequired = Boolean(
      isPreviewBranch && feed.authRequired && !feed.latestVersion
    );

    const statusMessage = !layer
      ? (isAuthRequired ? 'Sign in to CodeWeavers Preview to install' : 'Not installed')
      : isAuthRequired
        ? `Installed (${layer.displayVersion || layer.version || 'Installed'}) — Sign in to CodeWeavers Preview to check for updates`
        : isRetiredWineCrossOver
          ? `Retired Wine-CrossOver build (${layer.displayVersion || layer.version || 'Installed'})`
          : updateAvailable
            ? `Update available: ${latestDisplayVersion || latestVersion}`
            : `Up to date (${layer.displayVersion || layer.version || 'Installed'})`;

    const portalUrl = isPreviewBranch ? defaultDownloadUrls[runnerType] : undefined;
    const downloadUrl =
      runnerType === 'crossover_preview' &&
      !feed.canAutoUpdate &&
      stableSurpassesPreview &&
      stableFeed?.downloadUrl
        ? stableFeed.downloadUrl
        : isAuthRequired
          ? undefined
          : feed.downloadUrl || defaultDownloadUrls[runnerType];
    const estimatedDownloadBytes =
      runnerType === 'crossover_preview' &&
      !feed.canAutoUpdate &&
      stableSurpassesPreview &&
      typeof stableFeed?.estimatedDownloadBytes === 'number'
        ? stableFeed.estimatedDownloadBytes
        : typeof feed.estimatedDownloadBytes === 'number'
          ? feed.estimatedDownloadBytes
          : undefined;

    results[runnerType] = {
      runnerType,
      installed: Boolean(layer),
      installedVersion: layer?.version,
      installedBuildVersion: layer?.buildVersion,
      installedDisplayVersion: layer?.displayVersion,
      latestVersion,
      latestBuildVersion,
      latestDisplayVersion,
      updateAvailable,
      downloadUrl,
      ...(portalUrl ? { portalUrl } : {}),
      ...(previewBranch ? { previewBranch } : {}),
      ...(estimatedDownloadBytes ? { estimatedDownloadBytes } : {}),
      canAutoUpdate,
      updateMethod,
      ...(isPreviewBranch ? { authRequired: Boolean(isAuthRequired) } : {}),
      ...(feed.previewDate ? { previewDate: feed.previewDate } : {}),
      ...(feed.semver ? { semver: feed.semver } : {}),
      ...(runnerType === 'crossover_preview'
        ? {
            stableSurpassesPreview,
            ...(stableSurpassesPreview && (stableFeed?.latestDisplayVersion || stableFeed?.latestVersion)
              ? {
                  stableFallbackVersion:
                    stableFeed.latestDisplayVersion || stableFeed.latestVersion,
                }
              : {}),
          }
        : {}),
      statusMessage,
      checkedAt,
    };
  }

  return results;
}

async function updateCompatibilityLayer(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
  const effectivePayload =
    typeof payload === 'string'
      ? { runnerType: payload, ...(options && typeof options === 'object' ? options : {}) }
      : payload && typeof payload === 'object'
        ? payload
        : {};
  const effectiveOptions =
    typeof payload === 'string'
      ? (options && typeof options === 'object' ? options : {})
      : options && typeof options === 'object'
        ? options
        : {};
  payload = effectivePayload;
  options = effectiveOptions;
  const runnerType = String(effectivePayload.runnerType || 'crossover')
    .toLowerCase()
    .trim()
    .replace(/^runner_/, '');

  if (effectiveOptions._bypassSingleFlight !== true && activeCompatRunnerOps.has(runnerType)) {
    const existingOp = activeCompatRunnerOps.get(runnerType);
    if (existingOp) {
      return existingOp.promise;
    }
  }

  const controller = new AbortController();
  if (effectiveOptions.signal && typeof effectiveOptions.signal.addEventListener === 'function') {
    if (effectiveOptions.signal.aborted) controller.abort();
    else effectiveOptions.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const runPromise = (async () => {
    const homedir = effectiveOptions.homedir || os.homedir();
    const beforeLayers = Array.isArray(effectiveOptions.layers)
      ? effectiveOptions.layers
      : detectCompatibilityLayers(effectiveOptions);
    const beforeLayer = beforeLayers.find((l) => l.type === runnerType);
    const previousVersion = beforeLayer?.version;
    const previousBuildVersion = beforeLayer?.buildVersion;

    const mockRunnerFn = effectiveOptions.mockUpdater || effectiveOptions.mockUpdateRunnerDirect;
    if (typeof mockRunnerFn === 'function') {
      const mockRes = (await mockRunnerFn(effectivePayload, effectiveOptions)) || {};
      invalidateCompatLayersCache();
      const detectedLayers =
        mockRes.detectedLayers ||
        (Array.isArray(effectiveOptions.layers) ? effectiveOptions.layers : detectCompatibilityLayers(effectiveOptions));
      const newVersion =
        mockRes.newVersion || detectedLayers.find((l) => l.type === runnerType)?.version;
      const updates = await checkCompatibilityLayerUpdates({ ...effectiveOptions, layers: detectedLayers });
      const afterMockLayer = detectedLayers.find((l) => l.type === runnerType);
      const newBuildVersion = afterMockLayer?.buildVersion;
      const updated =
        mockRes.updated !== undefined
          ? Boolean(mockRes.updated)
          : Boolean(
              (newVersion && newVersion !== previousVersion) ||
              (newBuildVersion && newBuildVersion !== previousBuildVersion) ||
              (afterMockLayer?.displayVersion && afterMockLayer?.displayVersion !== beforeLayer?.displayVersion) ||
              (afterMockLayer?.previewDate && afterMockLayer?.previewDate !== beforeLayer?.previewDate)
            );
      if (mockRes && mockRes.authenticated) {
        const previewUpdateInfo = updates[runnerType];
        let authMsg = 'Signed in to CodeWeavers Preview.';
        if (previewUpdateInfo?.updateAvailable) {
          authMsg = `Signed in to CodeWeavers — update available: ${previewUpdateInfo.latestDisplayVersion || `v${previewUpdateInfo.latestVersion}`}.`;
        } else if (!previewUpdateInfo?.authRequired) {
          authMsg = afterMockLayer
            ? `Signed in to CodeWeavers — CrossOver Preview is up to date (${afterMockLayer.displayVersion || afterMockLayer.version || 'latest version'}).`
            : `Signed in to CodeWeavers — ready to install ${previewUpdateInfo?.latestDisplayVersion || `CrossOver Preview (build ${previewUpdateInfo?.latestVersion || 'latest'})`}.`;
        }
        return {
          success: mockRes.success !== false,
          runnerType,
          updated: false,
          authenticated: true,
          previousVersion,
          newVersion,
          openedExternalUrl: false,
          message: mockRes.message || authMsg,
          detectedLayers,
          updateInfo: previewUpdateInfo,
        };
      }
      return {
        success: mockRes.success !== false,
        runnerType,
        updated,
        previousVersion,
        newVersion,
        openedExternalUrl: Boolean(mockRes.openedExternalUrl),
        message:
          mockRes.message ||
          (updated
            ? `Successfully updated ${afterMockLayer?.name || runnerType} to ${afterMockLayer?.displayVersion || newVersion || 'latest version'}.`
            : 'Runner update check completed.'),
        detectedLayers,
        updateInfo: updates[runnerType],
      };
    }

    const {
      installRunnerDirect,
      assertRunnerSafeToReplace,
    } = require('../environmentProvisioner.cjs');

    const effectiveSafetyRunnerType =
      runnerType === 'crossover_preview' && effectivePayload.switchToStableCrossOver === true
        ? 'crossover'
        : runnerType;
    const isSwitchingToStable = effectiveSafetyRunnerType !== runnerType;
    const safetyTargetLayer = isSwitchingToStable
      ? beforeLayers.find((l) => l.type === 'crossover') || null
      : beforeLayers.find((l) => l.type === effectiveSafetyRunnerType) || beforeLayer || null;
    const hostPlatformForUpdate = String(effectiveOptions.platform || process.platform).toLowerCase();
    const hostArchForUpdate = String(effectiveOptions.arch || process.arch || 'arm64').toLowerCase();
    if (
      runnerType === 'crossover_preview_arm64' &&
      (hostPlatformForUpdate !== 'darwin' || hostArchForUpdate !== 'arm64')
    ) {
      const archErrMsg =
        'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.';
      emitCompatibilityRunnerProgress(
        {
          runnerType,
          operation: 'update',
          phase: 'failed',
          progressPercent: null,
          message: archErrMsg,
          error: archErrMsg,
        },
        effectiveOptions
      );
      return {
        success: false,
        runnerType,
        updated: false,
        previousVersion,
        error: archErrMsg,
        message: archErrMsg,
        detectedLayers: beforeLayers,
      };
    }
    if (effectivePayload.authenticateOnly !== true && effectiveOptions.authenticateOnly !== true) {
      const safetyRes = await assertRunnerSafeToReplace(
        effectiveSafetyRunnerType,
        safetyTargetLayer?.appPath || null,
        safetyTargetLayer,
        effectiveOptions
      );
      if (!safetyRes.ok) {
        emitCompatibilityRunnerProgress(
          {
            runnerType,
            operation: 'update',
            phase: 'failed',
            progressPercent: null,
            message: safetyRes.error || 'Runner is currently busy.',
            error: safetyRes.error,
          },
          effectiveOptions
        );
        return {
          success: false,
          runnerType,
          updated: false,
          previousVersion,
          ...(safetyRes.busyCode ? { busyCode: safetyRes.busyCode } : {}),
          error: safetyRes.error,
          message: safetyRes.error || 'Runner is currently busy.',
          detectedLayers: beforeLayers,
        };
      }
    }

    /** @type {Record<string, string>} */
    const defaultUpdateUrls = {
      crossover: 'https://www.codeweavers.com/crossover/download',
      crossover_preview: 'https://www.codeweavers.com/preview/download',
      crossover_preview_arm64: 'https://www.codeweavers.com/preview/download',
      gptk: 'https://github.com/Gcenx/game-porting-toolkit/releases/latest',
      wine: 'https://github.com/Gcenx/macOS_Wine_builds/releases/latest',
    };

    const localArchivePath =
      typeof payload.archivePath === 'string' && payload.archivePath.trim()
        ? payload.archivePath.trim()
        : typeof options.archivePath === 'string' && options.archivePath.trim()
          ? options.archivePath.trim()
          : '';
    const localDmgPath =
      typeof payload.dmgPath === 'string' && payload.dmgPath.trim()
        ? payload.dmgPath.trim()
        : typeof options.dmgPath === 'string' && options.dmgPath.trim()
          ? options.dmgPath.trim()
          : '';
    const hasLocalInstaller = Boolean(localArchivePath || localDmgPath);

    const brewCandidates = [
      options.brewBinaryPath,
      path.join(homedir, 'homebrew/bin/brew'),
      ...(!options.homedir ? ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'] : []),
    ].filter(Boolean);
    const brewPath = brewCandidates.find((p) => fs.existsSync(p));

    const beforeCombinedStr = `${beforeLayer?.name || ''} ${beforeLayer?.appPath || ''} ${beforeLayer?.binaryPath || ''}`.replace(
      /\\/g,
      '/'
    );
    const isWineStagingApp = Boolean(beforeLayer && /wine[-_\s]*staging/i.test(beforeCombinedStr));
    const isWineDevelApp = Boolean(beforeLayer && /wine[-_\s]*devel/i.test(beforeCombinedStr));
    const externalMgr = getExternalManagerForLayer(beforeLayer);

    /** @type {Record<string, string>} */
    const caskMap = {
      crossover: 'crossover',
      wine: isWineStagingApp ? 'wine@staging' : isWineDevelApp ? 'wine@devel' : 'wine-stable',
      gptk: 'game-porting-toolkit',
    };
    const caskName = caskMap[runnerType];
    let updatedViaBrew = false;
    let usedMockBrewHook = false;

    const shouldAttemptHomebrewUpdate =
      Boolean(caskName) &&
      !hasLocalInstaller &&
      payload.switchToStableCrossOver !== true &&
      !externalMgr &&
      (typeof options.onExecBrew === 'function' || Boolean(options.brewBinaryPath));

    if (shouldAttemptHomebrewUpdate && typeof options.onExecBrew === 'function') {
      const args = [
        'upgrade',
        '--cask',
        ...(runnerType === 'wine' ? ['--no-quarantine'] : []),
        caskName,
      ];
      try {
        emitCompatibilityRunnerProgress(
          {
            runnerType,
            operation: 'update',
            phase: 'installing',
            progressPercent: null,
            message: `Upgrading ${caskName} via Homebrew...`,
          },
          options
        );
        await options.onExecBrew(brewPath || '/opt/homebrew/bin/brew', args);
        updatedViaBrew = true;
        usedMockBrewHook = true;
      } catch {}
    } else if (shouldAttemptHomebrewUpdate && brewPath) {
      const args = [
        'upgrade',
        '--cask',
        ...(runnerType === 'wine' ? ['--no-quarantine'] : []),
        caskName,
      ];
      try {
        const isCaskManaged = await new Promise((resolve) => {
          execFile(brewPath, ['list', '--cask', caskName], { timeout: 15000 }, (err) => {
            resolve(!err);
          });
        });
        if (isCaskManaged) {
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'update',
              phase: 'installing',
              progressPercent: null,
              message: `Upgrading ${caskName} via Homebrew...`,
            },
            options
          );
          await new Promise((resolve, reject) => {
            execFile(brewPath, args, { timeout: 300000 }, (err, stdout, stderr) => {
              if (err) reject(err);
              else resolve({ stdout, stderr });
            });
          });
          updatedViaBrew = true;
        }
      } catch {}
    }

    const hostArch = String(options?.arch || process.arch || 'arm64');
    const darwinKernelMajor =
      options?.darwinKernelMajor !== undefined
        ? Number(options.darwinKernelMajor)
        : typeof options?.osRelease === 'string' && options.osRelease.trim()
          ? Number.parseInt(options.osRelease.trim().split('.')[0] || '0', 10) || 24
          : process.platform === 'darwin'
            ? Number.parseInt(String(os.release() || '24.0.0').split('.')[0] || '24', 10) || 24
            : 24;

    const canRunDirectInCurrentEnv =
      hasLocalInstaller ||
      typeof options.capturePreviewDownloadFn === 'function' ||
      options.allowInteractivePreviewCapture === true ||
      !isTestEnvironment(options) ||
      options.allowDirectVendorInstall === true ||
      typeof options.fetchFn === 'function' ||
      typeof options.mockDirectDownload === 'function';

    const isPreviewRunnerType =
      runnerType === 'crossover_preview' || runnerType === 'crossover_preview_arm64';
    const previewBranchForRunner =
      runnerType === 'crossover_preview_arm64' ? 'arm64' : 'standard';
    const previewDisplayLabel =
      runnerType === 'crossover_preview_arm64'
        ? 'CrossOver Preview (Arm64)'
        : 'CrossOver Preview';

    const isDirectUpdateCapable =
      runnerType === 'crossover' ||
      runnerType === 'wine' ||
      (runnerType === 'gptk' &&
        (hasLocalInstaller || (hostArch === 'arm64' && darwinKernelMajor >= 23))) ||
      (runnerType === 'crossover_preview' &&
        (hasLocalInstaller ||
          payload.switchToStableCrossOver === true ||
          options.skipNetwork !== true)) ||
      (runnerType === 'crossover_preview_arm64' &&
        (hasLocalInstaller || options.skipNetwork !== true));

    if (!updatedViaBrew && canRunDirectInCurrentEnv && isDirectUpdateCapable) {
      try {
        const directRes = await installRunnerDirect(runnerType, {
          ...options,
          ...(isPreviewRunnerType ? { previewBranch: previewBranchForRunner } : {}),
          ...(payload.downloadUrl || options.downloadUrl
            ? { downloadUrl: payload.downloadUrl || options.downloadUrl }
            : {}),
          ...(payload.authenticateOnly || options.authenticateOnly
            ? { authenticateOnly: true }
            : {}),
          ...(localDmgPath ? { dmgPath: localDmgPath } : {}),
          ...(localArchivePath ? { archivePath: localArchivePath } : {}),
          ...(runnerType === 'crossover_preview' && payload.switchToStableCrossOver === true
            ? { switchToStableCrossOver: true }
            : {}),
          ...(payload.timeoutMs || options.timeoutMs
            ? { timeoutMs: payload.timeoutMs || options.timeoutMs }
            : {}),
          existingLayer: safetyTargetLayer,
          _runnerOperation: 'update',
          _suppressWizardProgressBroadcast: true,
          _runnerProgressMeta: { runnerType, operation: 'update' },
          signal: controller.signal,
          onRunnerProgress: (/** @type {any} */ evt) =>
            emitCompatibilityRunnerProgress(evt, {
              ...options,
              onRunnerProgress: options.onRunnerProgress,
            }),
        });

        const directResAny = /** @type {any} */ (directRes);
        if (directResAny && (directResAny.cancelled || controller.signal.aborted)) {
          const detectedLayersOnCancel =
            directResAny.detectedLayers ||
            (Array.isArray(options.layers) ? options.layers : detectCompatibilityLayers(options));
          const cancelMsg =
            directResAny.message ||
            (effectivePayload.authenticateOnly || effectiveOptions.authenticateOnly
              ? 'CodeWeavers Preview sign-in cancelled.'
              : 'Compatibility runner update cancelled.');
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'update',
              phase: 'cancelled',
              progressPercent: null,
              message: cancelMsg,
            },
            options
          );
          return {
            success: false,
            cancelled: true,
            runnerType,
            updated: false,
            previousVersion,
            message: cancelMsg,
            detectedLayers: detectedLayersOnCancel,
          };
        }

        if (!directResAny || directResAny.success === false) {
          const detectedLayersOnError =
            directResAny?.detectedLayers ||
            (Array.isArray(options.layers) ? options.layers : detectCompatibilityLayers(options));
          const errMsg =
            directResAny?.error || directResAny?.message || `Failed to update ${runnerType}.`;
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'update',
              phase: 'failed',
              progressPercent: null,
              message: errMsg,
              error: errMsg,
            },
            options
          );
          return {
            success: false,
            runnerType,
            updated: false,
            previousVersion,
            ...(directResAny?.busyCode ? { busyCode: directResAny.busyCode } : {}),
            error: errMsg,
            message: errMsg,
            detectedLayers: detectedLayersOnError,
          };
        }

        const didSwitchToStable =
          runnerType === 'crossover_preview' &&
          (payload.switchToStableCrossOver === true ||
            Boolean(directRes && directRes.switchedToStableCrossOver));
        invalidateCompatLayersCache();
        const detectedLayers =
          (/** @type {any} */ (directRes))?.detectedLayers ||
          (Array.isArray(options.layers) ? options.layers : detectCompatibilityLayers(options));
        const targetAfterType =
          runnerType === 'crossover_preview' && didSwitchToStable
            ? 'crossover'
            : runnerType;
        const afterLayer =
          detectedLayers.find((l) => l.type === targetAfterType) ||
          detectedLayers.find((l) => l.type === runnerType);
        const newVersion = afterLayer?.version || directRes?.version || undefined;
        const targetCandidateUrls = [
          ...(Array.isArray(options.previewCandidateUrls) ? options.previewCandidateUrls : []),
          ...(directRes?.downloadUrl ? [directRes.downloadUrl] : []),
        ];
        const updates = await checkCompatibilityLayerUpdates({
          ...options,
          ...(targetCandidateUrls.length > 0 ? { previewCandidateUrls: targetCandidateUrls } : {}),
          layers: detectedLayers,
        });

        try {
          require('../environmentHealthProber.cjs').invalidateProberRunnerUpdatesCache({
            skipPreviewUrlCacheClear: true,
          });
        } catch {}

        if (directRes && directRes.alreadyUpToDate) {
          const upToDateMsg = `${previewDisplayLabel} is already up to date (${afterLayer?.displayVersion || afterLayer?.version || 'latest version'}).`;
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'update',
              phase: 'completed',
              progressPercent: 100,
              message: upToDateMsg,
            },
            options
          );
          return {
            success: true,
            runnerType,
            updated: false,
            alreadyUpToDate: true,
            previousVersion,
            newVersion,
            openedExternalUrl: false,
            message: upToDateMsg,
            detectedLayers,
            updateInfo: updates[targetAfterType] || updates[runnerType],
          };
        }

        if (directRes && directRes.authenticated) {
          if (directRes.downloadUrl) {
            setCachedAuthenticatedPreviewUrl(directRes.downloadUrl, {
              ...options,
              previewBranch: previewBranchForRunner,
            });
          }
          const previewUpdateInfo = updates[targetAfterType] || updates[runnerType];
          let authMsg = `Signed in to ${previewDisplayLabel}.`;
          if (previewUpdateInfo?.updateAvailable) {
            authMsg = `Signed in to CodeWeavers — update available: ${previewUpdateInfo.latestDisplayVersion || `v${previewUpdateInfo.latestVersion}`}.`;
          } else if (!previewUpdateInfo?.authRequired) {
            authMsg = afterLayer
              ? `Signed in to CodeWeavers — ${previewDisplayLabel} is up to date (${afterLayer.displayVersion || afterLayer.version || 'latest version'}).`
              : `Signed in to CodeWeavers — ready to install ${previewUpdateInfo?.latestDisplayVersion || `${previewDisplayLabel} (build ${previewUpdateInfo?.latestVersion || 'latest'})`}.`;
          }
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'update',
              phase: 'completed',
              progressPercent: 100,
              message: authMsg,
            },
            options
          );
          return {
            success: true,
            runnerType,
            updated: false,
            authenticated: true,
            previousVersion,
            newVersion,
            openedExternalUrl: false,
            message: authMsg,
            detectedLayers,
            updateInfo: previewUpdateInfo,
          };
        }

        if (directRes && directRes.openedExternal) {
          return {
            success: true,
            runnerType,
            updated: false,
            previousVersion,
            newVersion,
            openedExternalUrl: true,
            message: directRes.message,
            detectedLayers,
            updateInfo: updates[targetAfterType] || updates[runnerType],
          };
        }

        const successMsg = didSwitchToStable
          ? `Successfully installed CrossOver Stable ${newVersion || ''}`.trim() + '.'
          : `Successfully updated ${afterLayer?.name || runnerType} to ${afterLayer?.displayVersion || newVersion || 'latest version'}.`;

        emitCompatibilityRunnerProgress(
          {
            runnerType,
            operation: 'update',
            phase: 'completed',
            progressPercent: 100,
            message: successMsg,
          },
          options
        );

        return {
          success: true,
          runnerType,
          updated: Boolean(directRes && directRes.installed),
          previousVersion,
          newVersion,
          openedExternalUrl: false,
          message: successMsg,
          detectedLayers,
          updateInfo: updates[targetAfterType] || updates[runnerType],
        };
      } catch (err) {
        const isCancelled =
          controller.signal.aborted ||
          (err && typeof err === 'object' && /** @type {any} */ (err).name === 'AbortError');
        const detectedLayers =
          Array.isArray(options.layers) ? options.layers : detectCompatibilityLayers(options);
        if (isCancelled) {
          const cancelMsg =
            effectivePayload.authenticateOnly || effectiveOptions.authenticateOnly
              ? 'CodeWeavers Preview sign-in cancelled.'
              : 'Compatibility runner update cancelled.';
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'update',
              phase: 'cancelled',
              progressPercent: null,
              message: cancelMsg,
            },
            options
          );
          return {
            success: false,
            cancelled: true,
            runnerType,
            updated: false,
            previousVersion,
            message: cancelMsg,
            detectedLayers,
          };
        }
        if (options.throwOnError === true) {
          throw err;
        }
        const errObj = /** @type {any} */ (err);
        const errMsg = err instanceof Error ? err.message : String(err);
        emitCompatibilityRunnerProgress(
          {
            runnerType,
            operation: 'update',
            phase: 'failed',
            progressPercent: null,
            message: errMsg,
            error: errMsg,
          },
          options
        );
        return {
          success: false,
          runnerType,
          updated: false,
          previousVersion,
          ...(errObj?.busyCode ? { busyCode: errObj.busyCode } : {}),
          error: errMsg,
          message: errMsg,
          detectedLayers,
        };
      }
    }

    invalidateCompatLayersCache();
    const detectedLayers = detectCompatibilityLayers(options);
    const afterLayer = detectedLayers.find((l) => l.type === runnerType);
    const newVersion = afterLayer?.version;
    const newBuildVersion = afterLayer?.buildVersion;
    const updates = await checkCompatibilityLayerUpdates({ ...options, layers: detectedLayers });

    let openedExternalUrl = false;
    if (!updatedViaBrew) {
      const targetUrl =
        updates[runnerType]?.downloadUrl ||
        updates[runnerType]?.portalUrl ||
        defaultUpdateUrls[runnerType] ||
        defaultUpdateUrls.crossover;
      await openExternalUri(targetUrl, options);
      openedExternalUrl = true;
    }

    const versionChanged = Boolean(
      (newVersion && newVersion !== previousVersion) ||
        (newBuildVersion && newBuildVersion !== previousBuildVersion)
    );
    const updated = usedMockBrewHook
      ? Boolean(versionChanged || updatedViaBrew)
      : versionChanged;

    if (updated) {
      emitCompatibilityRunnerProgress(
        {
          runnerType,
          operation: 'update',
          phase: 'completed',
          progressPercent: 100,
          message: `Successfully updated ${runnerType} to ${newVersion || 'latest version'}.`,
        },
        options
      );
    }

    return {
      success: true,
      runnerType,
      updated,
      previousVersion,
      newVersion,
      openedExternalUrl,
      message: updated
        ? `Successfully updated ${runnerType} to ${newVersion || 'latest version'}.`
        : openedExternalUrl
          ? 'Opened official update page in your browser. Click "Re-Scan Runners" once installation finishes.'
          : 'Runner is already up to date.',
      detectedLayers,
      updateInfo: updates[runnerType],
    };
  })();

  activeCompatRunnerOps.set(runnerType, {
    operation: 'update',
    controller,
    promise: runPromise,
  });

  try {
    return await runPromise;
  } finally {
    invalidateCompatLayersCache();
    const cur = activeCompatRunnerOps.get(runnerType);
    if (cur && cur.promise === runPromise) {
      activeCompatRunnerOps.delete(runnerType);
    }
  }
}

/**
 * Safely mount a macOS .dmg archive via hdiutil attach, copy any .app bundle inside asynchronously
 * via `/usr/bin/ditto` (preserving `.framework` symlinks & code signatures without freezing IPC),
 * strip quarantine attributes, and guarantee hdiutil detach runs inside a finally block.
 */
async function mountAndExtractDmgSafe(dmgPath, targetDestDir, /** @type {any} */ options = {}) {
  const mountPoint = path.join(
    os.tmpdir(),
    `ol-dmg-mount-${process.pid}-${Date.now()}`
  );
  const execFileFn =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  const execHdiutil =
    typeof options.onExecHdiutil === 'function'
      ? options.onExecHdiutil
      : (/** @type {string[]} */ args) =>
          new Promise((resolve, reject) => {
            execFileFn(
              'hdiutil',
              args,
              { timeout: 120000 },
              (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
                if (err) reject(err);
                else resolve({ stdout, stderr });
              }
            );
          });

  const copyMacAppBundleAsync = async (/** @type {string} */ srcApp, /** @type {string} */ destApp) => {
    if (typeof options.onExecDitto === 'function') {
      await options.onExecDitto(srcApp, destApp);
      return;
    }
    const canUseDitto =
      process.platform === 'darwin' ||
      typeof options.execFileFn === 'function' ||
      typeof options.execFileImpl === 'function';
    if (canUseDitto) {
      await new Promise((resolve, reject) => {
        execFileFn(
          '/usr/bin/ditto',
          [srcApp, destApp],
          { timeout: 300000 },
          (/** @type {any} */ err) => {
            if (err) reject(err);
            else resolve(true);
          }
        );
      });
      return;
    }
    await fs.promises.cp(srcApp, destApp, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
  };

  let attached = false;
  try {
    await execHdiutil([
      'attach',
      dmgPath,
      '-mountpoint',
      mountPoint,
      '-nobrowse',
      '-readonly',
      '-quiet',
    ]);
    attached = true;

    if (fs.existsSync(mountPoint) && targetDestDir) {
      await fs.promises.mkdir(targetDestDir, { recursive: true });
      const entries = await fs.promises.readdir(mountPoint);
      const appEntry = entries.find((e) => e.toLowerCase().endsWith('.app'));
      if (appEntry) {
        const srcApp = path.join(mountPoint, appEntry);
        const destApp = path.join(targetDestDir, appEntry);
        await copyMacAppBundleAsync(srcApp, destApp);
        await clearMacQuarantineAsync(destApp, { ...options, force: true });
        if (options.gameId || options.store || options.writeManagedSentinel) {
          writeManagedInstallSentinel(targetDestDir, {
            store: options.store || options.platformId || 'custom',
            gameId: options.gameId || options.platformGameId || appEntry,
            installKind: 'mac-dmg-pkg',
          });
        }
      }
    }
    return { success: true, mountPoint };
  } finally {
    if (attached || typeof options.onExecHdiutil === 'function') {
      try {
        await execHdiutil(['detach', mountPoint, '-force', '-quiet']);
      } catch {}
    }
  }
}

async function installCompatibilityLayer(
  /** @type {any} */ payload = {},
  /** @type {any} */ options = {},
  /** @type {any} */ extraOptions = {}
) {
  const isThreeArgForm =
    typeof payload === 'string' &&
    (typeof options === 'string' || options === undefined || options === null);
  const effectivePayload = isThreeArgForm
    ? {
        runnerType: payload,
        ...(typeof options === 'string' ? { mode: options } : {}),
        ...(extraOptions && typeof extraOptions === 'object' ? extraOptions : {}),
      }
    : typeof payload === 'string'
      ? { runnerType: payload, ...(options && typeof options === 'object' ? options : {}) }
      : payload && typeof payload === 'object'
        ? payload
        : {};
  const effectiveOptions = isThreeArgForm
    ? (extraOptions && typeof extraOptions === 'object' ? extraOptions : {})
    : typeof payload === 'string'
      ? (options && typeof options === 'object' ? options : {})
      : options && typeof options === 'object'
        ? options
        : {};
  const runnerType = String(effectivePayload.runnerType || 'crossover')
    .toLowerCase()
    .trim()
    .replace(/^runner_/, '');
  const mode = String(effectivePayload.mode || 'auto')
    .toLowerCase()
    .trim();
  options = effectiveOptions;
  payload = effectivePayload;

  /** @type {Record<string, string>} */
  const downloadUrls = {
    crossover: 'https://www.codeweavers.com/crossover/download',
    crossover_preview: 'https://www.codeweavers.com/preview/download',
    crossover_preview_arm64: 'https://www.codeweavers.com/preview/download',
    gptk: 'https://github.com/Gcenx/game-porting-toolkit/releases/latest',
    wine: 'https://github.com/Gcenx/macOS_Wine_builds/releases/latest',
  };
  const downloadUrl =
    (typeof payload.downloadUrl === 'string' && payload.downloadUrl.trim()) ||
    (typeof options.downloadUrl === 'string' && options.downloadUrl.trim()) ||
    downloadUrls[runnerType] ||
    downloadUrls.crossover;

  if (mode === 'download') {
    await openExternalUri(downloadUrl, options);
    return {
      success: true,
      openedExternalInstaller: true,
      runnerType,
      message: 'Opened official download page in your browser.',
      layers: detectCompatibilityLayers(options),
    };
  }

  if (options._bypassSingleFlight !== true && activeCompatRunnerOps.has(runnerType)) {
    const existingOp = activeCompatRunnerOps.get(runnerType);
    if (existingOp) {
      return existingOp.promise;
    }
  }

  const controller = new AbortController();
  if (options.signal && typeof options.signal.addEventListener === 'function') {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const runPromise = (async () => {
    const homedir = options.homedir || os.homedir();
    const beforeLayers = detectCompatibilityLayers(options);
    const beforeLayer = beforeLayers.find((l) => l.type === runnerType) || null;

    const {
      installRunnerDirect,
      assertRunnerSafeToReplace,
    } = require('../environmentProvisioner.cjs');

    if (payload.authenticateOnly !== true && options.authenticateOnly !== true) {
      const safetyRes = await assertRunnerSafeToReplace(
        runnerType,
        beforeLayer?.appPath || null,
        beforeLayer,
        options
      );
      if (!safetyRes.ok) {
        emitCompatibilityRunnerProgress(
          {
            runnerType,
            operation: 'install',
            phase: 'failed',
            progressPercent: null,
            message: safetyRes.error || 'Runner is currently busy.',
            error: safetyRes.error,
          },
          options
        );
        return {
          success: false,
          installed: false,
          runnerType,
          ...(safetyRes.busyCode ? { busyCode: safetyRes.busyCode } : {}),
          error: safetyRes.error,
          message: safetyRes.error || 'Runner is currently busy.',
          layers: beforeLayers,
        };
      }
    }

    const archivePath =
      typeof payload.archivePath === 'string' && payload.archivePath.trim()
        ? payload.archivePath.trim()
        : typeof options.archivePath === 'string' && options.archivePath.trim()
          ? options.archivePath.trim()
          : '';
    const dmgPath =
      typeof payload.dmgPath === 'string' && payload.dmgPath.trim()
        ? payload.dmgPath.trim()
        : typeof options.dmgPath === 'string' && options.dmgPath.trim()
          ? options.dmgPath.trim()
          : '';
    const hasLocalInstaller = Boolean(archivePath || dmgPath);

    const brewCandidates = [
      options.brewBinaryPath,
      path.join(homedir, 'homebrew/bin/brew'),
      ...(!options.homedir ? ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'] : []),
    ].filter(Boolean);
    const brewPath = brewCandidates.find((p) => fs.existsSync(p));

    const shouldTryHomebrewInstall =
      !hasLocalInstaller &&
      mode !== 'direct' &&
      (mode === 'brew' ||
        typeof options.onExecBrew === 'function' ||
        Boolean(options.brewBinaryPath)) &&
      (brewPath || typeof options.onExecBrew === 'function') &&
      (runnerType === 'crossover' || runnerType === 'wine');

    if (shouldTryHomebrewInstall) {
      const args =
        runnerType === 'crossover'
          ? ['install', '--cask', 'crossover']
          : ['install', '--cask', '--no-quarantine', 'wine-stable'];
      try {
        emitCompatibilityRunnerProgress(
          {
            runnerType,
            operation: 'install',
            phase: 'installing',
            progressPercent: null,
            message: `Installing ${runnerType} via Homebrew...`,
          },
          options
        );
        if (typeof options.onExecBrew === 'function') {
          await options.onExecBrew(brewPath || '/opt/homebrew/bin/brew', args);
        } else {
          await new Promise((resolve, reject) => {
            execFile(brewPath, args, { timeout: 300000 }, (err, stdout, stderr) => {
              if (err) reject(err);
              else resolve({ stdout, stderr });
            });
          });
        }
        invalidateCompatLayersCache();
        const layers = detectCompatibilityLayers(options);
        if (layers.some((l) => l.type === runnerType)) {
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'install',
              phase: 'completed',
              progressPercent: 100,
              message: 'Successfully installed via Homebrew!',
            },
            options
          );
          return {
            success: true,
            installed: true,
            runnerType,
            message: 'Successfully installed via Homebrew!',
            layers,
          };
        }
      } catch {}
    }

    const hostPlatformForInstall = String(options?.platform || process.platform).toLowerCase();
    const hostArch = String(options?.arch || process.arch || 'arm64');
    if (
      runnerType === 'crossover_preview_arm64' &&
      (hostPlatformForInstall !== 'darwin' || hostArch.toLowerCase() !== 'arm64')
    ) {
      const archErrMsg =
        'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.';
      emitCompatibilityRunnerProgress(
        {
          runnerType,
          operation: 'install',
          phase: 'failed',
          progressPercent: null,
          message: archErrMsg,
          error: archErrMsg,
        },
        options
      );
      return {
        success: false,
        installed: false,
        runnerType,
        error: archErrMsg,
        message: archErrMsg,
        layers: beforeLayers,
      };
    }
    const darwinKernelMajor =
      options?.darwinKernelMajor !== undefined
        ? Number(options.darwinKernelMajor)
        : typeof options?.osRelease === 'string' && options.osRelease.trim()
          ? Number.parseInt(options.osRelease.trim().split('.')[0] || '0', 10) || 24
          : process.platform === 'darwin'
            ? Number.parseInt(String(os.release() || '24.0.0').split('.')[0] || '24', 10) || 24
            : 24;

    const canRunDirectInCurrentEnv =
      hasLocalInstaller ||
      typeof options.capturePreviewDownloadFn === 'function' ||
      options.allowInteractivePreviewCapture === true ||
      !isTestEnvironment(options) ||
      options.allowDirectVendorInstall === true ||
      typeof options.fetchFn === 'function' ||
      typeof options.mockDirectDownload === 'function';

    const isPreviewRunnerType =
      runnerType === 'crossover_preview' || runnerType === 'crossover_preview_arm64';
    const previewBranchForRunner =
      runnerType === 'crossover_preview_arm64' ? 'arm64' : 'standard';

    const isDirectInstallCapable =
      runnerType === 'crossover' ||
      runnerType === 'wine' ||
      (runnerType === 'gptk' &&
        (hasLocalInstaller || (hostArch === 'arm64' && darwinKernelMajor >= 23))) ||
      (isPreviewRunnerType &&
        (hasLocalInstaller ||
          Boolean(payload.downloadUrl || options.downloadUrl) ||
          typeof options.capturePreviewDownloadFn === 'function' ||
          typeof options.mockDirectDownload === 'function' ||
          options.allowInteractivePreviewCapture === true ||
          !isTestEnvironment(options) ||
          options.allowDirectVendorInstall === true));

    const shouldTryDirectInstall =
      mode === 'direct' ||
      ((mode === 'auto' || mode === 'brew') &&
        typeof options.onExecBrew !== 'function' &&
        canRunDirectInCurrentEnv &&
        isDirectInstallCapable);

    if (shouldTryDirectInstall) {
      try {
        const directRes = await installRunnerDirect(runnerType, {
          ...options,
          ...(isPreviewRunnerType ? { previewBranch: previewBranchForRunner } : {}),
          ...(payload.downloadUrl || options.downloadUrl
            ? { downloadUrl: payload.downloadUrl || options.downloadUrl }
            : {}),
          ...(payload.authenticateOnly || options.authenticateOnly
            ? { authenticateOnly: true }
            : {}),
          ...(dmgPath ? { dmgPath } : {}),
          ...(archivePath ? { archivePath } : {}),
          ...(payload.timeoutMs || options.timeoutMs
            ? { timeoutMs: payload.timeoutMs || options.timeoutMs }
            : {}),
          existingLayer: beforeLayer,
          _runnerOperation: 'install',
          _suppressWizardProgressBroadcast: true,
          _runnerProgressMeta: { runnerType, operation: 'install' },
          signal: controller.signal,
          onRunnerProgress: (/** @type {any} */ evt) =>
            emitCompatibilityRunnerProgress(evt, {
              ...options,
              onRunnerProgress: options.onRunnerProgress,
            }),
        });
        if (directRes && directRes.installed) {
          invalidateCompatLayersCache();
          try {
            require('../environmentHealthProber.cjs').invalidateProberRunnerUpdatesCache({
              skipPreviewUrlCacheClear: true,
            });
          } catch {}
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'install',
              phase: 'completed',
              progressPercent: 100,
              message: directRes.message,
            },
            options
          );
          return {
            success: true,
            installed: true,
            runnerType,
            installedPath: directRes.installedPath,
            message: directRes.message,
            layers: detectCompatibilityLayers(options),
          };
        }
        if (directRes && directRes.alreadyUpToDate) {
          try {
            require('../environmentHealthProber.cjs').invalidateProberRunnerUpdatesCache({
              skipPreviewUrlCacheClear: true,
            });
          } catch {}
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'install',
              phase: 'completed',
              progressPercent: 100,
              message: directRes.message,
            },
            options
          );
          return {
            success: true,
            installed: false,
            alreadyUpToDate: true,
            runnerType,
            message: directRes.message,
            layers: detectCompatibilityLayers(options),
          };
        }
        if (directRes && directRes.authenticated) {
          try {
            require('../environmentHealthProber.cjs').invalidateProberRunnerUpdatesCache({
              skipPreviewUrlCacheClear: true,
            });
          } catch {}
          if (directRes.downloadUrl) {
            setCachedAuthenticatedPreviewUrl(directRes.downloadUrl, {
              ...options,
              previewBranch: previewBranchForRunner,
            });
          }
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'install',
              phase: 'completed',
              progressPercent: 100,
              message: directRes.message,
            },
            options
          );
          return {
            success: true,
            installed: false,
            authenticated: true,
            runnerType,
            downloadUrl: directRes.downloadUrl,
            message: directRes.message,
            layers: detectCompatibilityLayers(options),
          };
        }
        if (directRes && directRes.openedExternal) {
          return {
            success: true,
            openedExternalInstaller: true,
            runnerType,
            message: directRes.message,
            layers: detectCompatibilityLayers(options),
          };
        }
        const directInstallAny = /** @type {any} */ (directRes);
        if (directInstallAny && (directInstallAny.cancelled || controller.signal.aborted)) {
          const cancelMsg =
            directInstallAny.message ||
            (effectivePayload.authenticateOnly || effectiveOptions.authenticateOnly
              ? 'CodeWeavers Preview sign-in cancelled.'
              : runnerType === 'crossover_preview_arm64'
                ? 'CrossOver Preview (Arm64) installation cancelled.'
                : runnerType === 'crossover_preview'
                  ? 'CrossOver Preview installation cancelled.'
                  : 'Compatibility runner installation cancelled.');
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'install',
              phase: 'cancelled',
              progressPercent: null,
              message: cancelMsg,
            },
            options
          );
          return {
            success: false,
            cancelled: true,
            installed: false,
            runnerType,
            message: cancelMsg,
            layers: detectCompatibilityLayers(options),
          };
        }
        if (!directInstallAny || directInstallAny.success === false) {
          const errMsg =
            directInstallAny?.error ||
            directInstallAny?.message ||
            `Failed to install ${runnerType}.`;
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'install',
              phase: 'failed',
              progressPercent: null,
              message: errMsg,
              error: errMsg,
            },
            options
          );
          return {
            success: false,
            installed: false,
            runnerType,
            ...(directInstallAny?.busyCode ? { busyCode: directInstallAny.busyCode } : {}),
            error: errMsg,
            message: errMsg,
            layers: detectCompatibilityLayers(options),
          };
        }
      } catch (err) {
        const isCancelled =
          controller.signal.aborted ||
          (err && typeof err === 'object' && /** @type {any} */ (err).name === 'AbortError');
        if (isCancelled) {
          const cancelMsg =
            effectivePayload.authenticateOnly || effectiveOptions.authenticateOnly
              ? 'CodeWeavers Preview sign-in cancelled.'
              : runnerType === 'crossover_preview_arm64'
                ? 'CrossOver Preview (Arm64) installation cancelled.'
                : runnerType === 'crossover_preview'
                  ? 'CrossOver Preview installation cancelled.'
                  : 'Compatibility runner installation cancelled.';
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'install',
              phase: 'cancelled',
              progressPercent: null,
              message: cancelMsg,
            },
            options
          );
          return {
            success: false,
            cancelled: true,
            installed: false,
            runnerType,
            message: cancelMsg,
            layers: detectCompatibilityLayers(options),
          };
        }
        if (options.throwOnError === true) {
          throw err;
        }
        const errObj = /** @type {any} */ (err);
        const errMsg = err instanceof Error ? err.message : String(err);
        emitCompatibilityRunnerProgress(
          {
            runnerType,
            operation: 'install',
            phase: 'failed',
            progressPercent: null,
            message: errMsg,
            error: errMsg,
          },
          options
        );
        if (
          mode === 'direct' ||
          hasLocalInstaller ||
          typeof options.capturePreviewDownloadFn === 'function' ||
          options.allowInteractivePreviewCapture === true ||
          !isTestEnvironment(options) ||
          options.allowDirectVendorInstall === true ||
          typeof options.fetchFn === 'function'
        ) {
          return {
            success: false,
            installed: false,
            runnerType,
            ...(errObj?.busyCode ? { busyCode: errObj.busyCode } : {}),
            error: errMsg,
            message: errMsg,
            layers: detectCompatibilityLayers(options),
          };
        }
      }
    }

    await openExternalUri(downloadUrl, options);
    return {
      success: true,
      openedExternalInstaller: true,
      runnerType,
      message:
        'Opened official installer page in your browser. Click "Re-Scan Runners" once installation finishes.',
      layers: detectCompatibilityLayers(options),
    };
  })();

  activeCompatRunnerOps.set(runnerType, {
    operation: 'install',
    controller,
    promise: runPromise,
  });

  try {
    return await runPromise;
  } finally {
    invalidateCompatLayersCache();
    const cur = activeCompatRunnerOps.get(runnerType);
    if (cur && cur.promise === runPromise) {
      activeCompatRunnerOps.delete(runnerType);
    }
  }
}


module.exports = {
  onCompatibilityRunnerProgress,
  emitCompatibilityRunnerProgress,
  cancelCompatibilityLayerOperation,
  selectRunnerArchiveDialog,
  extractCandidateLinksFromText,
  classifyPreviewBranchFromTarget,
  resolvePreviewBranchFromOptions,
  isPreviewSparkleFeedUrl,
  isPreviewSparkleEnclosureValid,
  setCachedAuthenticatedPreviewUrl,
  cacheAuthenticatedPreviewUrl,
  clearCachedAuthenticatedPreviewUrl,
  getCachedAuthenticatedPreviewUrl,
  checkCompatibilityLayerUpdates,
  updateCompatibilityLayer,
  mountAndExtractDmgSafe,
  installCompatibilityLayer,
};
