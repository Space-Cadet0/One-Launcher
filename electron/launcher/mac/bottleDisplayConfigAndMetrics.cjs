// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { getElectron } = require('../engineStateRegistry.cjs');
const { atomicWriteFileSync } = require('../securityAndPathUtils.cjs');
const {
  resolveDriveCPathCaseInsensitive,
  sandboxWinePrefixUserFolders,
} = require('../wineAndCrossOverManager.cjs');

/**
 * Canonical cache key shared by `applyCrossOverPerGameSettings` and `launchGame` for
 * `recentDisplaySanitizeCache` so display config sanitization runs once per launch.
 *
 * @param {{
 *   prefixPath?: string | null,
 *   highResolutionMode?: boolean | undefined,
 *   displayScalingMode?: string | undefined,
 *   displayAspectRatio?: string | undefined,
 *   installDir?: string | null
 * }} [params]
 * @returns {string}
 */
function buildDisplaySanitizeCacheKey(params = {}) {
  const prefixKey = params.prefixPath ? path.resolve(String(params.prefixPath)) : '';
  const highResKey = String(params.highResolutionMode);
  const scalingKey = String(params.displayScalingMode || 'auto_fullscreen');
  const aspectKey = String(params.displayAspectRatio || 'preserve_aspect');
  const installDirKey =
    typeof params.installDir === 'string' && params.installDir.trim()
      ? path.resolve(params.installDir.trim())
      : '';
  return `${prefixKey}:${highResKey}:${scalingKey}:${aspectKey}:${installDirKey}`;
}

/** @type {{ maxW: number, maxH: number, logW: number, logH: number, panelW: number, panelH: number } | null} */
let cachedHostDisplayMetrics = null;
let cachedHostDisplayMetricsAt = 0;
let hostDisplayMetricsListenerBound = false;
/** @type {(() => void) | null} */
let hostDisplayMetricsListenerFn = null;
/** @type {any} */
let hostDisplayMetricsBoundScreen = null;
const HOST_DISPLAY_METRICS_TTL_MS = 10_000;

/**
 * Remove the registered Electron `screen` `display-metrics-changed` listener on engine shutdown
 * to prevent listener leaks across reloads / teardown (`SUP-09`).
 */
function disposeHostDisplayMetricsListener() {
  if (hostDisplayMetricsBoundScreen && hostDisplayMetricsListenerFn) {
    try {
      if (typeof hostDisplayMetricsBoundScreen.removeListener === 'function') {
        hostDisplayMetricsBoundScreen.removeListener(
          'display-metrics-changed',
          hostDisplayMetricsListenerFn
        );
      } else if (typeof hostDisplayMetricsBoundScreen.off === 'function') {
        hostDisplayMetricsBoundScreen.off('display-metrics-changed', hostDisplayMetricsListenerFn);
      }
    } catch {}
  }
  hostDisplayMetricsListenerBound = false;
  hostDisplayMetricsListenerFn = null;
  hostDisplayMetricsBoundScreen = null;
  cachedHostDisplayMetrics = null;
  cachedHostDisplayMetricsAt = 0;
}

function getHostMaxDisplayResolution(highResolutionMode = true, /** @type {any} */ options = {}) {
  if (Number(options?.maxWidth) > 0 && Number(options?.maxHeight) > 0) {
    const mw = Math.round(Number(options.maxWidth));
    const mh = Math.round(Number(options.maxHeight));
    const lw = Math.round(Number(options.logicalWidth || mw));
    const lh = Math.round(Number(options.logicalHeight || mh));
    const pw = Math.round(Number(options.panelWidth || mw));
    const ph = Math.round(Number(options.panelHeight || mh));
    return {
      width: highResolutionMode ? mw : lw,
      height: highResolutionMode ? mh : lh,
      nativeWidth: mw,
      nativeHeight: mh,
      logicalWidth: lw,
      logicalHeight: lh,
      panelWidth: pw,
      panelHeight: ph,
    };
  }

  const hasCustomProbeFn = typeof options?.execFileSyncFn === 'function';
  const electron = !hasCustomProbeFn ? getElectron() : null;
  if (
    electron &&
    electron.screen &&
    (typeof electron.screen.getPrimaryDisplay === 'function' ||
      typeof electron.screen.getAllDisplays === 'function')
  ) {
    if (!hostDisplayMetricsListenerBound && typeof electron.screen.on === 'function') {
      hostDisplayMetricsListenerBound = true;
      hostDisplayMetricsBoundScreen = electron.screen;
      hostDisplayMetricsListenerFn = () => {
        cachedHostDisplayMetrics = null;
        cachedHostDisplayMetricsAt = 0;
      };
      try {
        electron.screen.on('display-metrics-changed', hostDisplayMetricsListenerFn);
      } catch {}
    }
    try {
      const primary =
        typeof electron.screen.getPrimaryDisplay === 'function'
          ? electron.screen.getPrimaryDisplay()
          : null;
      const allDisplays =
        !primary && typeof electron.screen.getAllDisplays === 'function'
          ? electron.screen.getAllDisplays()
          : [];
      const targetDisplay = primary || (Array.isArray(allDisplays) ? allDisplays[0] : null);
      if (targetDisplay) {
        const w = Number(targetDisplay?.size?.width || targetDisplay?.bounds?.width || 0);
        const h = Number(targetDisplay?.size?.height || targetDisplay?.bounds?.height || 0);
        const scale = Number(targetDisplay?.scaleFactor || 1);
        const backingW = Math.round(w * scale);
        const backingH = Math.round(h * scale);
        const logW = Math.round(w);
        const logH = Math.round(h);
        if (backingW > 0 && backingH > 0) {
          return {
            width: highResolutionMode ? backingW : logW,
            height: highResolutionMode ? backingH : logH,
            nativeWidth: backingW,
            nativeHeight: backingH,
            logicalWidth: logW,
            logicalHeight: logH,
            panelWidth: backingW,
            panelHeight: backingH,
          };
        }
      }
    } catch {}
  }

  const now = typeof options?.nowMs === 'number' ? options.nowMs : Date.now();
  const useProbeCache = !hasCustomProbeFn || options?.useCacheWithProbeFn === true;
  const forceRefresh = Boolean(options?.forceRefresh || !useProbeCache);
  const cacheFresh = Boolean(
    !forceRefresh &&
      cachedHostDisplayMetrics &&
      now - cachedHostDisplayMetricsAt <= HOST_DISPLAY_METRICS_TTL_MS
  );

  /** @type {{ maxW: number, maxH: number, logW: number, logH: number, panelW: number, panelH: number } | null} */
  let probedMetrics = cacheFresh ? cachedHostDisplayMetrics : null;
  if (
    !probedMetrics &&
    (hasCustomProbeFn ||
      (process.platform === 'darwin' && !options?.skipDisplayProbe && !options?.homedir))
  ) {
    try {
      const execFn = hasCustomProbeFn ? options.execFileSyncFn : execFileSync;
      const out = execFn(
        '/usr/sbin/system_profiler',
        ['SPDisplaysDataType', '-json'],
        { timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const parsed = JSON.parse(String(out || '').trim());
      const gpus = Array.isArray(parsed?.SPDisplaysDataType) ? parsed.SPDisplaysDataType : [];
      /** @type {any[]} */
      const allDisplays = [];
      for (const gpu of gpus) {
        const displays = Array.isArray(gpu?.spdisplays_ndrvs) ? gpu.spdisplays_ndrvs : [];
        for (const d of displays) {
          if (d && typeof d === 'object') allDisplays.push(d);
        }
      }
      const primaryDisplay =
        allDisplays.find((d) => String(d?.spdisplays_main || '').toLowerCase() === 'spdisplays_yes') ||
        allDisplays.find((d) => String(d?.spdisplays_online || '').toLowerCase() === 'spdisplays_yes') ||
        allDisplays[0] ||
        null;

      const parseResPair = (/** @type {any} */ val) => {
        const m = String(val || '').match(/(\d{3,5})\s*[xX×]\s*(\d{3,5})/);
        return m ? [Number(m[1]), Number(m[2])] : [0, 0];
      };
      if (primaryDisplay) {
        const [pw, ph] = parseResPair(
          primaryDisplay._spdisplays_pixels ||
            primaryDisplay.spdisplays_pixels ||
            primaryDisplay.spdisplays_pixelresolution
        );
        const [rw, rh] = parseResPair(
          primaryDisplay._spdisplays_resolution || primaryDisplay.spdisplays_resolution
        );
        const isRetina =
          /retina/i.test(String(primaryDisplay.spdisplays_pixelresolution || '')) ||
          /retina/i.test(String(primaryDisplay.spdisplays_display_type || '')) ||
          /retina/i.test(String(primaryDisplay._spdisplays_resolution || '')) ||
          /retina/i.test(String(primaryDisplay.spdisplays_resolution || '')) ||
          String(primaryDisplay.spdisplays_retina || '').toLowerCase() === 'spdisplays_yes' ||
          (pw > 0 && rw > 0 && pw >= rw * 1.5);
        const logicalW = rw > 0 ? rw : isRetina && pw > 0 ? Math.round(pw / 2) : pw;
        const logicalH = rh > 0 ? rh : isRetina && ph > 0 ? Math.round(ph / 2) : ph;
        // Under macOS HiDPI scaling presets ("Default", "More Space", "Larger Text", or 5K scaled),
        // CoreGraphics / winemac.drv presents a 2x virtual backing surface (rw * 2 x rh * 2)
        // whenever logical UI dimensions differ from 1x native panel pixels.
        const useRetina2xBacking = Boolean(isRetina && rw > 0 && rh > 0 && !(rw === pw && rh === ph));
        const backingW = useRetina2xBacking ? rw * 2 : pw || rw;
        const backingH = useRetina2xBacking ? rh * 2 : ph || rh;
        const panelW = pw || backingW;
        const panelH = ph || backingH;
        if (backingW > 0 && backingH > 0) {
          probedMetrics = {
            maxW: Math.round(backingW),
            maxH: Math.round(backingH),
            logW: Math.round(logicalW || backingW),
            logH: Math.round(logicalH || backingH),
            panelW: Math.round(panelW),
            panelH: Math.round(panelH),
          };
          if (useProbeCache) {
            cachedHostDisplayMetrics = probedMetrics;
            cachedHostDisplayMetricsAt = now;
          }
        }
      }
    } catch {}
  }

  const metrics = probedMetrics || {
    maxW: 3840,
    maxH: 2160,
    logW: 1920,
    logH: 1080,
    panelW: 3840,
    panelH: 2160,
  };

  return {
    width: highResolutionMode ? metrics.maxW : metrics.logW,
    height: highResolutionMode ? metrics.maxH : metrics.logH,
    nativeWidth: metrics.maxW,
    nativeHeight: metrics.maxH,
    logicalWidth: metrics.logW,
    logicalHeight: metrics.logH,
    panelWidth: metrics.panelW,
    panelHeight: metrics.panelH,
  };
}

/** @type {Record<number, [number, number]>} */
const IDTECH_R_MODE_RESOLUTIONS = {
  3: [640, 480],
  4: [800, 600],
  5: [1024, 768],
  6: [1152, 864],
  7: [1280, 1024],
  8: [1600, 1200],
  9: [1280, 720],
  10: [1366, 768],
  12: [1680, 1050],
  13: [1600, 900],
  14: [1600, 1024],
  15: [1920, 1200],
  16: [2560, 1600],
  17: [1920, 1080],
  18: [1920, 1200],
  19: [2560, 1600],
};

/** @type {Array<[number, number, number]>} */
const SAFE_IDTECH_MODE_CANDIDATES = [
  [19, 2560, 1600],
  [18, 1920, 1200],
  [17, 1920, 1080],
  [12, 1680, 1050],
  [8, 1600, 1200],
  [13, 1600, 900],
  [7, 1280, 1024],
  [9, 1280, 720],
  [6, 1152, 864],
  [5, 1024, 768],
  [4, 800, 600],
  [3, 640, 480],
];

/**
 * Schema-aware normalizer for bundled `dosbox*.conf` files inside a game's installation folder.
 * Ensures `[sdl]` fullscreen/desktop OpenGL presentation (or windowed when `'windowed'`) and
 * `[render]` aspect-ratio preservation while leaving comments, line endings, and `[autoexec]` untouched.
 *
 * @param {string} installDir
 * @param {Record<string, any>} [options]
 */
function normalizeDosboxDisplayConfigs(installDir, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const rawScaling =
    typeof opts.scalingMode === 'string' && opts.scalingMode !== 'default'
      ? opts.scalingMode
      : typeof opts.displayScalingMode === 'string' && opts.displayScalingMode !== 'default'
        ? opts.displayScalingMode
        : 'auto_fullscreen';
  const rawAspect =
    typeof opts.aspectRatio === 'string' && opts.aspectRatio !== 'default'
      ? opts.aspectRatio
      : typeof opts.displayAspectRatio === 'string' && opts.displayAspectRatio !== 'default'
        ? opts.displayAspectRatio
        : 'preserve_aspect';

  /** @type {Array<{ filePath: string }>} */
  const updatedFiles = [];
  if (
    rawScaling !== 'auto_fullscreen' &&
    rawScaling !== 'force_fullscreen' &&
    rawScaling !== 'windowed'
  ) {
    return { updatedFiles };
  }
  if (!installDir || typeof installDir !== 'string' || !installDir.trim()) {
    return { updatedFiles };
  }
  const resolvedRoot = path.resolve(installDir.trim());
  try {
    if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
      return { updatedFiles };
    }
  } catch {
    return { updatedFiles };
  }

  const isInsideRoot = (/** @type {string} */ candidatePath) => {
    try {
      const lstat = fs.lstatSync(candidatePath);
      if (lstat.isSymbolicLink()) {
        const target = path.resolve(path.dirname(candidatePath), fs.readlinkSync(candidatePath));
        return target === resolvedRoot || target.startsWith(resolvedRoot + path.sep);
      }
      return true;
    } catch {
      return false;
    }
  };

  const wantFullscreen = rawScaling === 'auto_fullscreen' || rawScaling === 'force_fullscreen';
  const wantAspectTrue = rawAspect !== 'stretch';

  const processDosboxConf = (/** @type {string} */ confPath) => {
    try {
      const st = fs.statSync(confPath);
      if (!st.isFile() || st.size <= 0 || st.size > 524288) return;
      const original = fs.readFileSync(confPath, 'utf8');
      const eol = original.includes('\r\n') ? '\r\n' : '\n';
      const lines = original.split(/\r?\n/);

      let currentSection = '';
      let sawSdlSection = false;
      let sawSdlFullscreen = false;
      let sawSdlFullresolution = false;
      let sawSdlOutput = false;
      let lastSdlContentIdx = -1;
      let sawRenderSection = false;
      let sawRenderAspect = false;
      let lastRenderContentIdx = -1;

      /** @type {string[]} */
      const outLines = [];

      const flushSdlMissingKeys = () => {
        if (!sawSdlSection || lastSdlContentIdx < 0) return;
        /** @type {string[]} */
        const inserts = [];
        if (!sawSdlFullscreen) {
          inserts.push(`fullscreen=${wantFullscreen ? 'true' : 'false'}`);
          sawSdlFullscreen = true;
        }
        if (wantFullscreen && !sawSdlFullresolution) {
          inserts.push('fullresolution=desktop');
          sawSdlFullresolution = true;
        }
        if (wantFullscreen && !sawSdlOutput) {
          inserts.push('output=opengl');
          sawSdlOutput = true;
        }
        if (inserts.length > 0) {
          outLines.splice(lastSdlContentIdx + 1, 0, ...inserts);
          if (lastRenderContentIdx > lastSdlContentIdx) {
            lastRenderContentIdx += inserts.length;
          }
          lastSdlContentIdx += inserts.length;
        }
      };

      const flushRenderMissingKeys = () => {
        if (!sawRenderSection || lastRenderContentIdx < 0 || sawRenderAspect) return;
        outLines.splice(lastRenderContentIdx + 1, 0, `aspect=${wantAspectTrue ? 'true' : 'false'}`);
        sawRenderAspect = true;
        if (lastSdlContentIdx > lastRenderContentIdx) {
          lastSdlContentIdx += 1;
        }
        lastRenderContentIdx += 1;
      };

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const secMatch = /^\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(line);
        if (secMatch) {
          if (currentSection === 'sdl') flushSdlMissingKeys();
          if (currentSection === 'render') flushRenderMissingKeys();
          currentSection = secMatch[1].trim().toLowerCase();
          outLines.push(line);
          if (currentSection === 'sdl') {
            sawSdlSection = true;
            lastSdlContentIdx = outLines.length - 1;
          } else if (currentSection === 'render') {
            sawRenderSection = true;
            lastRenderContentIdx = outLines.length - 1;
          }
          continue;
        }

        if (currentSection === 'autoexec' || /^\s*[#;]/.test(line) || !line.trim()) {
          outLines.push(line);
          continue;
        }

        const kvMatch = /^([ \t]*([A-Za-z0-9_]+)[ \t]*=[ \t]*)(.*?)\s*$/.exec(line);
        if (!kvMatch) {
          outLines.push(line);
          continue;
        }

        const prefix = kvMatch[1];
        const keyLower = kvMatch[2].toLowerCase();
        const rawVal = kvMatch[3];
        const valLower = rawVal.trim().toLowerCase();

        if (currentSection === 'sdl') {
          if (keyLower === 'fullscreen') {
            sawSdlFullscreen = true;
            outLines.push(`${prefix}${wantFullscreen ? 'true' : 'false'}`);
            lastSdlContentIdx = outLines.length - 1;
            continue;
          }
          if (keyLower === 'fullresolution') {
            sawSdlFullresolution = true;
            if (wantFullscreen) {
              const resMatch = /^(\d+)x(\d+)$/i.exec(valLower);
              const isLowHardcodedRes =
                Boolean(resMatch) &&
                (Number(resMatch?.[1] || 0) < 1920 || Number(resMatch?.[2] || 0) < 1080);
              if (
                valLower === 'original' ||
                valLower === '0x0' ||
                valLower === '' ||
                isLowHardcodedRes
              ) {
                outLines.push(`${prefix}desktop`);
                lastSdlContentIdx = outLines.length - 1;
                continue;
              }
            }
            outLines.push(line);
            lastSdlContentIdx = outLines.length - 1;
            continue;
          }
          if (keyLower === 'output') {
            sawSdlOutput = true;
            if (
              wantFullscreen &&
              (valLower === 'surface' || valLower === 'overlay' || valLower === 'ddraw')
            ) {
              outLines.push(`${prefix}opengl`);
              lastSdlContentIdx = outLines.length - 1;
              continue;
            }
            outLines.push(line);
            lastSdlContentIdx = outLines.length - 1;
            continue;
          }
          outLines.push(line);
          lastSdlContentIdx = outLines.length - 1;
          continue;
        }

        if (currentSection === 'render') {
          if (keyLower === 'aspect') {
            sawRenderAspect = true;
            outLines.push(`${prefix}${wantAspectTrue ? 'true' : 'false'}`);
            lastRenderContentIdx = outLines.length - 1;
            continue;
          }
          outLines.push(line);
          lastRenderContentIdx = outLines.length - 1;
          continue;
        }

        outLines.push(line);
      }

      if (currentSection === 'sdl') flushSdlMissingKeys();
      if (currentSection === 'render') flushRenderMissingKeys();

      const updated = outLines.join(eol);
      if (updated !== original) {
        atomicWriteFileSync(confPath, updated);
        updatedFiles.push({ filePath: confPath });
      }
    } catch {}
  };

  const skippedDirs = new Set([
    '__support',
    '__gog_support',
    '__installer',
    '_commonredist',
    'redist',
    'directx',
    'vcredist',
    'node_modules',
  ]);

  const walkDosboxDirs = (/** @type {string} */ dirPath, depth = 0) => {
    if (depth > 3 || !dirPath || !isInsideRoot(dirPath)) return;
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (!isInsideRoot(fullPath)) continue;
      if (entry.isDirectory()) {
        if (skippedDirs.has(entry.name.toLowerCase())) continue;
        walkDosboxDirs(fullPath, depth + 1);
      } else if (entry.isFile() && /^dosbox.*\.conf$/i.test(entry.name)) {
        processDosboxConf(fullPath);
      }
    }
  };

  walkDosboxDirs(resolvedRoot, 0);
  return { updatedFiles };
}

function sanitizeWinePrefixDisplayConfigs(winePrefix, /** @type {any} */ options = {}) {
  const hasValidPrefix = Boolean(
    winePrefix && typeof winePrefix === 'string' && fs.existsSync(winePrefix)
  );
  const rawInstallDir =
    options && typeof options.installDir === 'string' && options.installDir.trim()
      ? options.installDir.trim()
      : '';
  const hasValidInstallDir = Boolean(rawInstallDir && fs.existsSync(rawInstallDir));
  if (!hasValidPrefix && !hasValidInstallDir) {
    return { sanitizedFiles: [], maxWidth: 0, maxHeight: 0 };
  }

  if (hasValidPrefix && options?.skipUserFolderSandbox !== true) {
    try {
      sandboxWinePrefixUserFolders(winePrefix, options);
    } catch {}
  }

  const resolvedPrefix = hasValidPrefix ? path.resolve(winePrefix) : '';
  const resolvedInstallDir = hasValidInstallDir ? path.resolve(rawInstallDir) : '';
  let highResolutionMode = true;
  if (typeof options.highResolutionMode === 'boolean') {
    highResolutionMode = options.highResolutionMode;
  } else if (hasValidPrefix) {
    try {
      const userRegPath = path.join(winePrefix, 'user.reg');
      if (fs.existsSync(userRegPath)) {
        const regHead = fs.readFileSync(userRegPath, 'utf8');
        const macSecMatch = /^\[Software\\\\Wine\\\\Mac Driver\](?:\s+\d+)?[^\r\n]*$/im.exec(regHead);
        if (macSecMatch) {
          const afterSec = regHead.slice(macSecMatch.index + macSecMatch[0].length);
          const nextSec = /^\[[^\]]+\]/m.exec(afterSec);
          const secBody = nextSec ? afterSec.slice(0, nextSec.index) : afterSec;
          if (/^"RetinaMode"\s*=\s*"n"/im.test(secBody)) {
            highResolutionMode = false;
          }
        }
      }
    } catch {}
  }

  const effectiveScalingMode =
    options && typeof options.displayScalingMode === 'string' && options.displayScalingMode !== 'default'
      ? options.displayScalingMode
      : options && typeof options.scalingMode === 'string' && options.scalingMode !== 'default'
        ? options.scalingMode
        : 'auto_fullscreen';
  const effectiveAspectRatio =
    options && typeof options.displayAspectRatio === 'string' && options.displayAspectRatio !== 'default'
      ? options.displayAspectRatio
      : options && typeof options.aspectRatio === 'string' && options.aspectRatio !== 'default'
        ? options.aspectRatio
        : 'preserve_aspect';

  const displayRes = getHostMaxDisplayResolution(highResolutionMode, options);
  const maxWidth =
    Number(options.maxWidth) > 0 ? Math.round(Number(options.maxWidth)) : displayRes.width;
  const maxHeight =
    Number(options.maxHeight) > 0 ? Math.round(Number(options.maxHeight)) : displayRes.height;
  const physicalMaxWidth = Math.max(maxWidth, Number(displayRes.nativeWidth) || maxWidth);
  const physicalMaxHeight = Math.max(maxHeight, Number(displayRes.nativeHeight) || maxHeight);
  const isUpscalerFullscreenMode =
    effectiveScalingMode === 'auto_fullscreen' || effectiveScalingMode === 'force_fullscreen';

  /** @type {any[]} */
  const sanitizedFiles = [];
  const skippedDirNames = new Set([
    'public',
    'steam',
    'microsoft',
    'temp',
    'packages',
    'cef',
    'cache',
    'shadercache',
    'd3dscache',
    'crashdumps',
    'logs',
    'add',
    '__support',
    '__gog_support',
    '__installer',
    'support',
    '_commonredist',
    'redist',
    'directx',
    'vcredist',
    'mono',
    'streamingassets',
    'node_modules',
  ]);

  const cfgPairs = [
    ['v_width', 'v_height'],
    ['r_customwidth', 'r_customheight'],
    ['r_width', 'r_height'],
  ];
  const iniPairs = [
    ['ResolutionSizeX', 'ResolutionSizeY'],
    ['LastUserConfirmedResolutionSizeX', 'LastUserConfirmedResolutionSizeY'],
    ['DesiredScreenWidth', 'DesiredScreenHeight'],
  ];

  const isPathInsideAnchor = (
    /** @type {string} */ candidatePath,
    /** @type {string} */ anchorRoot
  ) => {
    if (!anchorRoot) return false;
    try {
      const lstat = fs.lstatSync(candidatePath);
      if (lstat.isSymbolicLink()) {
        const target = path.resolve(path.dirname(candidatePath), fs.readlinkSync(candidatePath));
        return target === anchorRoot || target.startsWith(anchorRoot + path.sep);
      }
      return true;
    } catch {
      return false;
    }
  };

  const explicitScalingMode =
    options && typeof options.displayScalingMode === 'string' && options.displayScalingMode !== 'default'
      ? options.displayScalingMode
      : options && typeof options.scalingMode === 'string' && options.scalingMode !== 'default'
        ? options.scalingMode
        : options && typeof options.effectiveDisplayScalingMode === 'string' && options.effectiveDisplayScalingMode !== 'default'
          ? options.effectiveDisplayScalingMode
          : null;

  // SUP-06: Only skip prefix display-config sanitization when Display Scaler v3 upscaler
  // fullscreen mode (`auto_fullscreen` / `force_fullscreen`) is explicitly active — NEVER skip
  // for `native_driver`, `virtual_desktop`, `off`, or `windowed`.
  const isExplicitUpscalerFullscreenMode =
    explicitScalingMode === 'auto_fullscreen' || explicitScalingMode === 'force_fullscreen';

  if (isExplicitUpscalerFullscreenMode) {
    if (hasValidInstallDir && resolvedInstallDir) {
      try {
        if (fs.statSync(resolvedInstallDir).isDirectory()) {
          normalizeDosboxDisplayConfigs(resolvedInstallDir, {
            scalingMode: effectiveScalingMode,
            aspectRatio: effectiveAspectRatio,
          });
        }
      } catch {}
    }
    return { sanitizedFiles, maxWidth, maxHeight };
  }

  const sanitizeConfigFile = (/** @type {string} */ filePath) => {
    if (isExplicitUpscalerFullscreenMode) return;
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.cfg' && ext !== '.ini') return;
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile() || st.size <= 0 || st.size > 524288) return;
      const original = fs.readFileSync(filePath, 'utf8');
      let updated = original;
      let prevW = 0;
      let prevH = 0;
      let clampedW = maxWidth;
      let clampedH = maxHeight;

      if (ext === '.cfg') {
        for (const [wKey, hKey] of cfgPairs) {
          const wRe = new RegExp(`^([ \\t]*(?:seta?\\s+)?${wKey}\\s+")(\\d+)(".*)$`, 'im');
          const hRe = new RegExp(`^([ \\t]*(?:seta?\\s+)?${hKey}\\s+")(\\d+)(".*)$`, 'im');
          const wMatch = wRe.exec(updated);
          const hMatch = hRe.exec(updated);
          if (wMatch && hMatch) {
            const w = Number(wMatch[2]);
            const h = Number(hMatch[2]);
            if (w > 0 && h > 0 && (w > maxWidth || h > maxHeight)) {
              prevW = w;
              prevH = h;
              updated = updated.replace(wRe, `$1${maxWidth}$3`).replace(hRe, `$1${maxHeight}$3`);
            }
          }
        }

        // Only clamp id Tech `seta r_mode "<N>"` when scaling is NOT `auto_fullscreen` / `force_fullscreen`
        // AND the mode genuinely exceeds physical display pixel bounds (e.g. unplugged 4K external monitor).
        if (!isUpscalerFullscreenMode) {
          const isFullscreenEnabled = /^[ \t]*(?:seta?\s+)?r_fullscreen\s+"?([1-9]\d*)"?/im.test(
            updated
          );
          if (isFullscreenEnabled) {
            const rModeRe = /^([ \t]*(?:seta?\s+)?r_mode\s+")(\d+)(".*)$/im;
            const rModeMatch = rModeRe.exec(updated);
            if (rModeMatch) {
              const modeIdx = Number(rModeMatch[2]);
              const modeRes = IDTECH_R_MODE_RESOLUTIONS[modeIdx];
              if (modeRes && (modeRes[0] > physicalMaxWidth || modeRes[1] > physicalMaxHeight)) {
                const safePick =
                  SAFE_IDTECH_MODE_CANDIDATES.find(
                    ([, cw, ch]) => cw <= physicalMaxWidth && ch <= physicalMaxHeight
                  ) || [3, 640, 480];
                if (!prevW && !prevH) {
                  prevW = modeRes[0];
                  prevH = modeRes[1];
                  clampedW = safePick[1];
                  clampedH = safePick[2];
                }
                updated = updated.replace(rModeRe, `$1${safePick[0]}$3`);
              }
            }
          }
        }
      } else if (ext === '.ini') {
        for (const [wKey, hKey] of iniPairs) {
          const wRe = new RegExp(`^([ \\t]*${wKey}\\s*=\\s*)(\\d+)([ \\t]*)$`, 'im');
          const hRe = new RegExp(`^([ \\t]*${hKey}\\s*=\\s*)(\\d+)([ \\t]*)$`, 'im');
          const wMatch = wRe.exec(updated);
          const hMatch = hRe.exec(updated);
          if (wMatch && hMatch) {
            const w = Number(wMatch[2]);
            const h = Number(hMatch[2]);
            if (w > 0 && h > 0 && (w > maxWidth || h > maxHeight)) {
              prevW = w;
              prevH = h;
              updated = updated.replace(wRe, `$1${maxWidth}$3`).replace(hRe, `$1${maxHeight}$3`);
            }
          }
        }
      }

      if (updated !== original) {
        atomicWriteFileSync(filePath, updated);
        sanitizedFiles.push({
          filePath,
          previousWidth: prevW,
          previousHeight: prevH,
          clampedWidth: clampedW,
          clampedHeight: clampedH,
        });
      }
    } catch {}
  };

  const walkConfigDir = (
    /** @type {string} */ dirPath,
    /** @type {string} */ anchorRoot,
    depth = 0,
    maxDepth = 5
  ) => {
    if (depth > maxDepth || !dirPath || !fs.existsSync(dirPath)) return;
    if (!isPathInsideAnchor(dirPath, anchorRoot)) return;
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (!isPathInsideAnchor(fullPath, anchorRoot)) continue;
      if (entry.isDirectory()) {
        if (skippedDirNames.has(entry.name.toLowerCase())) continue;
        walkConfigDir(fullPath, anchorRoot, depth + 1, maxDepth);
      } else if (entry.isFile()) {
        sanitizeConfigFile(fullPath);
      }
    }
  };

  if (hasValidPrefix) {
    const usersDir = path.join(winePrefix, 'drive_c', 'users');
    if (fs.existsSync(usersDir)) {
      /** @type {fs.Dirent[]} */
      let userEntries = [];
      try {
        userEntries = fs.readdirSync(usersDir, { withFileTypes: true });
      } catch {
        userEntries = [];
      }

      for (const userEntry of userEntries) {
        if (!userEntry.isDirectory() || userEntry.name.startsWith('.')) continue;
        if (userEntry.name.toLowerCase() === 'public') continue;
        const userRoot = path.join(usersDir, userEntry.name);
        const configRoots = [
          path.join(userRoot, 'Saved Games'),
          path.join(userRoot, 'Documents', 'My Games'),
          path.join(userRoot, 'My Documents', 'My Games'),
          path.join(userRoot, 'AppData', 'Local'),
        ];
        for (const root of configRoots) {
          if (fs.existsSync(root) && isPathInsideAnchor(root, resolvedPrefix)) {
            walkConfigDir(root, resolvedPrefix, 0, 5);
          }
        }
      }
    }
  }

  if (hasValidInstallDir && resolvedInstallDir) {
    try {
      if (fs.statSync(resolvedInstallDir).isDirectory()) {
        walkConfigDir(resolvedInstallDir, resolvedInstallDir, 0, 3);
        normalizeDosboxDisplayConfigs(resolvedInstallDir, {
          scalingMode: effectiveScalingMode,
          aspectRatio: effectiveAspectRatio,
        });
      }
    } catch {}
  }

  return { sanitizedFiles, maxWidth, maxHeight };
}


module.exports = {
  buildDisplaySanitizeCacheKey,
  getHostMaxDisplayResolution,
  disposeHostDisplayMetricsListener,
  normalizeDosboxDisplayConfigs,
  sanitizeWinePrefixDisplayConfigs,
};
