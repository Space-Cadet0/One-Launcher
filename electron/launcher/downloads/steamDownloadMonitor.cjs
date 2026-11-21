// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const {
  isContainedWithinRoot,
  isAllowedHttpsHost,
  assertSafePublicHttpsUrlSyntax,
  readSafeResponseBuffer,
} = require('../securityAndPathUtils.cjs');
const {
  parseSteamAcf,
  integrateSteamRateSamples,
  parseSteamContentLogForApp,
} = require('../binaryAndManifestInspectors.cjs');
const { resolveBottleSteamExe } = require('../wineAndCrossOverManager.cjs');
const {
  diagLog,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  downloadQueueMap,
  downloadControllers,
  invalidateScanCaches,
  upsertManagedInstallRecord,
} = require('../engineStateRegistry.cjs');
const { getDirectorySizeFastAsync } = require('../diskAndVolumeInspector.cjs');
const macNativeInstallerAndCodesign = /** @type {any} */ (
  require('../macNativeInstallerAndCodesign.cjs')
);
const {
  findPrimaryExecutable,
  resolveSteamAppInfoLaunchSpec,
  resolveDefaultEngineLaunchArguments,
  discoverSteamLocations,
} = macNativeInstallerAndCodesign;
const { parseSteamEaInstallerDataXml } = require('../../storefronts/steamLocalScanner.cjs');
const {
  resolveAnyChainedHandoffId,
  computeSmoothedDownloadSpeed,
  updateDownloadTask,
  isTaskCancelledOrPaused,
} = require('./downloadQueueStore.cjs');
const {
  VENDOR_AUTHENTICODE_SUBJECT_PATTERNS,
  verifyPeAuthenticodeBuffer,
} = require('../provisioner/artifactSignatureVerifier.cjs');

const STEAM_SETUP_DEFAULT_URL =
  'https://cdn.akamai.steamstatic.com/client/installer/SteamSetup.exe';
const STEAM_SETUP_ALLOWED_HOSTS = Object.freeze([
  'steamcdn-a.akamaihd.net',
  'cdn.cloudflare.steamstatic.com',
  'cdn.akamai.steamstatic.com',
]);
const MAX_STEAM_SETUP_BYTES = 16 * 1024 * 1024;
const MAX_STEAM_SETUP_REDIRECTS = 3;

/** @type {((vdfText: string) => { steamId64: string, accountName: string, personaName: string, allowAutoLogin: boolean } | null) | null} */
let cachedParseSteamLoginUsersVdfDetails = null;
/** @type {((userDataDir: string, options: Record<string, any>) => Promise<Record<string, any>>) | null} */
let cachedLoadSavedTokensReadOnly = null;

function getParseSteamLoginUsersVdfDetails() {
  if (!cachedParseSteamLoginUsersVdfDetails) {
    const proberMod = /** @type {any} */ (require('../environmentHealthProber.cjs'));
    cachedParseSteamLoginUsersVdfDetails = proberMod.parseSteamLoginUsersVdfDetails;
  }
  return cachedParseSteamLoginUsersVdfDetails;
}

function getLoadSavedTokensReadOnly() {
  if (!cachedLoadSavedTokensReadOnly) {
    const proberMod = /** @type {any} */ (require('../environmentHealthProber.cjs'));
    cachedLoadSavedTokensReadOnly = proberMod.loadSavedTokensReadOnly;
  }
  return cachedLoadSavedTokensReadOnly;
}

/**
 * Resolve One Launcher's connected 17-digit SteamID64 asynchronously without touching sync vault I/O.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<string>}
 */
async function resolveExpectedSteamId64Async(options = {}) {
  try {
    const loadTokens = getLoadSavedTokensReadOnly();
    if (typeof loadTokens !== 'function') return '';
    const { userDataDir } = resolveIsolatedHomedirAndUserData(options);
    if (!userDataDir) return '';
    const savedTokens = await loadTokens(userDataDir, options);
    const rawId = String(savedTokens?.steam?.steamId || '').trim();
    return /^\d{17}$/.test(rawId) ? rawId : '';
  } catch {
    return '';
  }
}

/**
 * Probe candidate `loginusers.vdf` paths asynchronously (read-only) to determine whether the
 * target Steam instance currently has an authenticated user session on disk (matching
 * `expectedSteamId64` when One Launcher has a connected Steam account).
 *
 * @param {Iterable<string>} vdfPaths
 * @param {string} [expectedSteamId64]
 * @returns {Promise<boolean>}
 */
async function hasAuthenticatedSteamSessionInVdfCandidates(vdfPaths, expectedSteamId64 = '') {
  if (!vdfPaths) return false;
  const parseVdf = getParseSteamLoginUsersVdfDetails();
  if (typeof parseVdf !== 'function') return false;
  const normalizedExpected =
    typeof expectedSteamId64 === 'string' && /^\d{17}$/.test(expectedSteamId64.trim())
      ? expectedSteamId64.trim()
      : '';
  const seen = new Set();
  for (const rawPath of vdfPaths) {
    const p = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!p || seen.has(p)) continue;
    seen.add(p);
    try {
      const text = await fs.promises.readFile(p, 'utf8');
      const parsed = parseVdf(text);
      if (parsed && parsed.steamId64) {
        if (!normalizedExpected || parsed.steamId64 === normalizedExpected) {
          return true;
        }
      }
    } catch {}
  }
  return false;
}

/**
 * Pure-Buffer PE32 / PE32+ Authenticode verification delegating to `artifactSignatureVerifier.cjs`:
 * - DOS `'MZ'` + NT `'PE\0\0'` + `OptionalHeader.DataDirectory[4]` (`IMAGE_DIRECTORY_ENTRY_SECURITY`)
 * - Embedded `WIN_CERTIFICATE` PKCS#7 SignedData ASN.1 structure
 * - Microsoft Authenticode `SpcIndirectDataContent` OID (`1.3.6.1.4.1.311.2.1.4`)
 * - Embedded X.509 signing certificate pinned to Valve (`VENDOR_AUTHENTICODE_SUBJECT_PATTERNS.bottle_steam`)
 *
 * @param {Buffer} buf
 * @param {{ expectedVendorSubjectPattern?: RegExp }} [options]
 * @returns {boolean}
 */
function hasEmbeddedPeAuthenticodeCertificateBuffer(buf, options = {}) {
  const result = verifyPeAuthenticodeBuffer(buf, {
    componentId: 'bottle_steam',
    expectedVendorSubjectPattern:
      options.expectedVendorSubjectPattern instanceof RegExp
        ? options.expectedVendorSubjectPattern
        : VENDOR_AUTHENTICODE_SUBJECT_PATTERNS.bottle_steam,
    requireAuthenticodeOid: true,
    allowSyntheticTestStub: false,
  });
  return result.valid;
}

/**
 * Resolve optional pinned SHA-256 hex digest for `SteamSetup.exe` from options or env.
 *
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolvePinnedSteamSetupSha256(options = {}) {
  const raw = String(
    options?.steamSetupSha256 || process.env.ONE_LAUNCHER_STEAM_SETUP_SHA256 || ''
  )
    .trim()
    .toLowerCase();
  if (!raw) return '';
  return /^[0-9a-f]{64}$/.test(raw) ? raw : 'INVALID_PIN';
}

/**
 * Verify a candidate `SteamSetup.exe` buffer against:
 * 1) bounded size (`256 B .. 16 MiB`)
 * 2) PE header (`MZ` + `PE\0\0`) + embedded Authenticode PKCS#7 SignedData + Authenticode OID +
 *    Valve X.509 signer subject (`VENDOR_AUTHENTICODE_SUBJECT_PATTERNS.bottle_steam`)
 * 3) optional pinned SHA-256 (`ONE_LAUNCHER_STEAM_SETUP_SHA256` / `options.steamSetupSha256`)
 *
 * @param {Buffer} buf
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function verifySteamSetupBuffer(buf, options = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 256 || buf.length > MAX_STEAM_SETUP_BYTES) {
    return false;
  }
  const authCheck = verifyPeAuthenticodeBuffer(buf, {
    componentId: 'bottle_steam',
    expectedVendorSubjectPattern: VENDOR_AUTHENTICODE_SUBJECT_PATTERNS.bottle_steam,
    requireAuthenticodeOid: true,
    allowSyntheticTestStub: false,
  });
  if (!authCheck.valid) {
    return false;
  }
  const pinnedSha = resolvePinnedSteamSetupSha256(options);
  if (pinnedSha === 'INVALID_PIN') {
    return false;
  }
  if (pinnedSha) {
    const actualHex = crypto.createHash('sha256').update(buf).digest('hex');
    const expectedBuf = Buffer.from(pinnedSha, 'hex');
    const actualBuf = Buffer.from(actualHex, 'hex');
    if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return false;
    }
  }
  return true;
}

/**
 * Verify an existing on-disk `SteamSetup.exe` without following symlinks and enforcing size + PE Authenticode + optional SHA-256.
 *
 * @param {string} filePath
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
async function verifyExistingSteamSetupFileAsync(filePath, options = {}) {
  try {
    const st = await fs.promises.lstat(filePath);
    if (!st.isFile() || st.isSymbolicLink()) return false;
    if (st.size < 256 || st.size > MAX_STEAM_SETUP_BYTES) return false;
    const buf = await fs.promises.readFile(filePath);
    return verifySteamSetupBuffer(buf, options);
  } catch {
    return false;
  }
}

/**
 * Validate a candidate Valve CDN URL for `SteamSetup.exe` (strict HTTPS, port 443,
 * no credentials, public host syntax, and Valve CDN host allowlist).
 *
 * @param {unknown} rawUrl
 * @returns {string}
 */
function validateValveSteamSetupUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  try {
    const syntax = assertSafePublicHttpsUrlSyntax(rawUrl);
    if (!isAllowedHttpsHost(syntax.url, STEAM_SETUP_ALLOWED_HOSTS)) {
      return '';
    }
    return syntax.url;
  } catch {
    return '';
  }
}

/**
 * Download `SteamSetup.exe` over HTTPS strictly from allowlisted Valve CDN hosts
 * with validated redirects, a hard 16 MiB ceiling, and verified PE Authenticode / SHA-256.
 *
 * @param {string} initialUrl
 * @param {Record<string, any>} [options]
 * @returns {Promise<Buffer | null>}
 */
async function downloadVerifiedSteamSetupBufferAsync(initialUrl, options = {}) {
  const fetchFn = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  if (typeof fetchFn !== 'function') return null;

  let currentUrl = validateValveSteamSetupUrl(initialUrl);
  if (!currentUrl) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  if (typeof timeout.unref === 'function') timeout.unref();

  try {
    for (let hop = 0; hop <= MAX_STEAM_SETUP_REDIRECTS; hop += 1) {
      const res = await fetchFn(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
      });

      if (res && res.status >= 300 && res.status < 400) {
        const loc = res.headers && typeof res.headers.get === 'function'
          ? res.headers.get('location')
          : null;
        try {
          if (res.body && typeof res.body.cancel === 'function') {
            await res.body.cancel();
          }
        } catch {}
        if (!loc || hop >= MAX_STEAM_SETUP_REDIRECTS) {
          return null;
        }
        let nextResolved = '';
        try {
          nextResolved = new URL(loc, currentUrl).toString();
        } catch {
          return null;
        }
        const validatedNext = validateValveSteamSetupUrl(nextResolved);
        if (!validatedNext) {
          diagLog.warn('ensureWindowsSteamInBottle.blockedRedirect', new Error('Disallowed redirect host'), {
            hop,
          });
          return null;
        }
        currentUrl = validatedNext;
        continue;
      }

      if (!res || !res.ok) {
        try {
          if (res?.body && typeof res.body.cancel === 'function') {
            await res.body.cancel();
          }
        } catch {}
        return null;
      }

      const buf = await readSafeResponseBuffer(res, MAX_STEAM_SETUP_BYTES);
      if (!verifySteamSetupBuffer(buf, options)) {
        diagLog.warn(
          'ensureWindowsSteamInBottle.verificationFailed',
          new Error('Downloaded SteamSetup.exe failed PE Authenticode or SHA-256 verification')
        );
        return null;
      }
      return buf;
    }
    return null;
  } catch (err) {
    diagLog.warn('ensureWindowsSteamInBottle.downloadFailed', err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ensure Windows Steam (steam.exe) is installed inside a CrossOver / Wine bottle on macOS.
 * Hardened against supply-chain tampering (P0-08):
 * - Enforces allowlisted Valve CDN HTTPS URLs
 * - Bounds download to `<= 16 MiB`
 * - Verifies PE (`MZ` + `PE\0\0`) + embedded Authenticode signature + optional `ONE_LAUNCHER_STEAM_SETUP_SHA256`
 * - Re-verifies any pre-existing `SteamSetup.exe` (never blindly trusts temp dir artifacts)
 * - Writes via temp file + atomic rename before executing
 * - Checks cancellation/pause after `await` before spawning and attaches `.on('error', ...)`
 *
 * @param {any} layer
 * @param {string} bottleName
 * @param {string} bottlePath
 * @param {string | null} taskId
 * @param {any} [options]
 * @returns {Promise<string | null>}
 */
async function ensureWindowsSteamInBottle(layer, bottleName, bottlePath, taskId, options = {}) {
  if (!bottlePath) return null;
  const existingSteamExe = resolveBottleSteamExe(bottlePath);
  if (existingSteamExe) return existingSteamExe;

  if (
    options.disableWineSteamSpawn ||
    (options.homedir && options.allowSteamSetupBootstrapInTest !== true) ||
    !layer?.binaryPath ||
    (typeof options.spawnFn !== 'function' && !fs.existsSync(layer.binaryPath))
  ) {
    return null;
  }

  try {
    if (taskId) {
      if (isTaskCancelledOrPaused(taskId)) return null;
      updateDownloadTask(
        taskId,
        {
          statusMessage: 'Bootstrapping Windows Steam client inside CrossOver bottle...',
        },
        options
      );
    }

    const tempDir = path.join(bottlePath, 'drive_c', 'windows', 'temp');
    await fs.promises.mkdir(tempDir, { recursive: true });
    const steamSetupPath = path.join(tempDir, 'SteamSetup.exe');

    // NEVER blindly trust a pre-existing unverified temp executable!
    let verifiedOnDisk = await verifyExistingSteamSetupFileAsync(steamSetupPath, options);
    if (!verifiedOnDisk) {
      try {
        await fs.promises.unlink(steamSetupPath);
      } catch {}

      const sourceUrl = options.steamSetupUrl || STEAM_SETUP_DEFAULT_URL;
      const verifiedBuf = await downloadVerifiedSteamSetupBufferAsync(sourceUrl, options);
      if (!verifiedBuf) {
        return null;
      }

      if (taskId && isTaskCancelledOrPaused(taskId)) {
        return null;
      }

      const tmpName = `SteamSetup.exe.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
      const tmpPath = path.join(tempDir, tmpName);
      try {
        await fs.promises.writeFile(tmpPath, verifiedBuf, { mode: 0o600 });
        await fs.promises.rename(tmpPath, steamSetupPath);
        verifiedOnDisk = await verifyExistingSteamSetupFileAsync(steamSetupPath, options);
      } catch (writeErr) {
        try {
          await fs.promises.unlink(tmpPath);
        } catch {}
        throw writeErr;
      }
    }

    if (!verifiedOnDisk) {
      return null;
    }

    if (taskId && isTaskCancelledOrPaused(taskId)) {
      return null;
    }

    const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;

    await new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearInterval(pollTimer);
        clearTimeout(maxTimer);
        resolve(undefined);
      };

      const pollTimer = setInterval(() => {
        if ((taskId && isTaskCancelledOrPaused(taskId)) || resolveBottleSteamExe(bottlePath)) {
          done();
        }
      }, 500);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();

      const maxTimer = setTimeout(done, 45000);
      if (typeof maxTimer.unref === 'function') maxTimer.unref();

      try {
        const child = spawnImpl(layer.binaryPath, [steamSetupPath, '/S'], {
          env: {
            ...process.env,
            CX_BOTTLE: bottleName,
            WINEPREFIX: bottlePath,
          },
          stdio: 'ignore',
        });
        if (child && typeof child.on === 'function') {
          child.on('error', done);
          child.on('exit', done);
        } else {
          done();
        }
      } catch {
        done();
      }
    });

    return resolveBottleSteamExe(bottlePath);
  } catch (err) {
    diagLog.warn('ensureWindowsSteamInBottle.error', err);
    return null;
  }
}

/**
 * Background monitor for Steam downloads & installations via `appmanifest_<appId>.acf`
 * and incremental byte-offset reading of `logs/content_log.txt`.
 *
 * @param {string} taskId
 * @param {string | number} appId
 * @param {any} [options]
 */
function startSteamInstallMonitor(taskId, appId, options = {}) {
  const intervalMs = Number(options.steamPollIntervalMs || 1200);
  const locationsCacheTtlMs = Number(options.steamLocationsCacheTtlMs ?? 10000);
  const logTailMaxBytes = 512 * 1024;
  let lastBytes = 0;
  let lastTickTime = Date.now();
  /** @type {any} */
  let cachedLocations = null;
  let cachedLocationsAt = 0;
  /** @type {string | null} */
  let lastKnownManifestDir = null;
  let knownDownloadTotal = 0;
  let knownStageTotal = 0;
  let sawSteamActivity = false;
  let inFlightTick = false;

  /**
   * Per-log incremental reader state eliminating repeated 512 KB Buffer allocations every 1.2s.
   * @type {Map<string, { ino: number | bigint, dev: number | bigint, mtimeMs: number, offset: number, tailText: string, parsedLog: any }>}
   */
  const logTailStateByPath = new Map();
  /** @type {Buffer | null} */
  let reusableDeltaBuf = null;

  const getScratchBuf = (/** @type {number} */ neededLen) => {
    const clamped = Math.min(logTailMaxBytes, Math.max(4096, neededLen));
    if (!reusableDeltaBuf || reusableDeltaBuf.length < clamped) {
      reusableDeltaBuf = Buffer.allocUnsafe(clamped);
    }
    return reusableDeltaBuf;
  };

  const retriggerCtx =
    options &&
    options._steamAuthRetrigger &&
    typeof options._steamAuthRetrigger === 'object' &&
    typeof options._steamAuthRetrigger.retriggerInstallAsync === 'function'
      ? options._steamAuthRetrigger
      : null;
  const maxRetriggers = 2;
  let retriggerCount = 0;
  let authDetectedAtMs = 0;
  let lastRetriggerAtMs = 0;

  const resolveTaskStartedAtMs = (/** @type {any} */ taskObj) => {
    if (options.minLogTimestampMs !== undefined) {
      const overrideTs = Number(options.minLogTimestampMs);
      return Number.isFinite(overrideTs) && overrideTs > 0 ? overrideTs : 0;
    }
    if (!taskObj || !taskObj.startedAt) return 0;
    if (typeof taskObj.startedAt === 'number') {
      return Number.isFinite(taskObj.startedAt) && taskObj.startedAt > 0 ? taskObj.startedAt : 0;
    }
    const parsedTs = Date.parse(String(taskObj.startedAt));
    return Number.isFinite(parsedTs) && parsedTs > 0 ? parsedTs : 0;
  };

  const isRelevantParsedLog = (/** @type {any} */ parsedLog) =>
    Boolean(
      parsedLog &&
        (parsedLog.updateStarted ||
          parsedLog.updateCanceled ||
          parsedLog.isRunning ||
          parsedLog.fullyInstalled ||
          parsedLog.bytesToDownload > 0 ||
          parsedLog.bytesToStage > 0 ||
          parsedLog.phase)
    );

  const trimTailText = (/** @type {string} */ text) => {
    if (text.length <= logTailMaxBytes) return text;
    const sliced = text.slice(text.length - logTailMaxBytes);
    const firstNl = sliced.indexOf('\n');
    return firstNl >= 0 && firstNl < 4096 ? sliced.slice(firstNl + 1) : sliced;
  };

  const readContentLogIncrementalSync = (
    /** @type {Iterable<string>} */ steamRoots,
    minTimestampMs = 0,
    nowMs = Date.now()
  ) => {
    /** @type {any} */
    let bestLogInfo = null;
    for (const root of steamRoots) {
      const candidateLogs = [
        path.join(root, 'logs', 'content_log.txt'),
        path.join(root, 'Steam', 'logs', 'content_log.txt'),
      ];
      for (const logPath of candidateLogs) {
        try {
          const st = fs.statSync(logPath);
          const size = Number(st.size || 0);
          if (size <= 0) continue;

          const prev = logTailStateByPath.get(logPath);
          const unchanged =
            prev &&
            prev.offset === size &&
            prev.mtimeMs === st.mtimeMs &&
            prev.ino === st.ino &&
            prev.dev === st.dev;

          let parsedLog;
          if (unchanged && prev) {
            parsedLog = prev.parsedLog;
          } else {
            const canAppend =
              prev &&
              prev.ino === st.ino &&
              prev.dev === st.dev &&
              size > prev.offset &&
              size - prev.offset <= logTailMaxBytes;
            const readOffset = canAppend && prev ? prev.offset : Math.max(0, size - logTailMaxBytes);
            const readLen = size - readOffset;
            const buf = getScratchBuf(readLen);
            const fd = fs.openSync(logPath, 'r');
            let bytesRead = 0;
            try {
              bytesRead = fs.readSync(fd, buf, 0, readLen, readOffset);
            } finally {
              fs.closeSync(fd);
            }
            const chunkText = buf.subarray(0, bytesRead).toString('utf8');
            const nextTailText = trimTailText(canAppend && prev ? prev.tailText + chunkText : chunkText);
            parsedLog = parseSteamContentLogForApp(
              nextTailText,
              String(appId),
              minTimestampMs,
              nowMs
            );
            logTailStateByPath.set(logPath, {
              ino: st.ino,
              dev: st.dev,
              mtimeMs: st.mtimeMs,
              offset: readOffset + bytesRead,
              tailText: nextTailText,
              parsedLog,
            });
          }

          if (isRelevantParsedLog(parsedLog)) {
            bestLogInfo = parsedLog;
          } else if (!bestLogInfo && parsedLog?.speedBytesPerSec > 0) {
            bestLogInfo = parsedLog;
          }
        } catch {}
      }
    }
    return bestLogInfo;
  };

  const readContentLogIncrementalAsync = async (
    /** @type {Iterable<string>} */ steamRoots,
    minTimestampMs = 0,
    nowMs = Date.now()
  ) => {
    /** @type {any} */
    let bestLogInfo = null;
    for (const root of steamRoots) {
      const candidateLogs = [
        path.join(root, 'logs', 'content_log.txt'),
        path.join(root, 'Steam', 'logs', 'content_log.txt'),
      ];
      for (const logPath of candidateLogs) {
        /** @type {fs.promises.FileHandle | null} */
        let fh = null;
        try {
          const st = await fs.promises.stat(logPath);
          const size = Number(st.size || 0);
          if (size <= 0) continue;

          const prev = logTailStateByPath.get(logPath);
          const unchanged =
            prev &&
            prev.offset === size &&
            prev.mtimeMs === st.mtimeMs &&
            prev.ino === st.ino &&
            prev.dev === st.dev;

          let parsedLog;
          if (unchanged && prev) {
            parsedLog = prev.parsedLog;
          } else {
            const canAppend =
              prev &&
              prev.ino === st.ino &&
              prev.dev === st.dev &&
              size > prev.offset &&
              size - prev.offset <= logTailMaxBytes;
            const readOffset = canAppend && prev ? prev.offset : Math.max(0, size - logTailMaxBytes);
            const readLen = size - readOffset;
            const buf = getScratchBuf(readLen);
            fh = await fs.promises.open(logPath, 'r');
            const { bytesRead } = await fh.read(buf, 0, readLen, readOffset);
            await fh.close();
            fh = null;

            const chunkText = buf.subarray(0, bytesRead).toString('utf8');
            const nextTailText = trimTailText(canAppend && prev ? prev.tailText + chunkText : chunkText);
            parsedLog = parseSteamContentLogForApp(
              nextTailText,
              String(appId),
              minTimestampMs,
              nowMs
            );
            logTailStateByPath.set(logPath, {
              ino: st.ino,
              dev: st.dev,
              mtimeMs: st.mtimeMs,
              offset: readOffset + bytesRead,
              tailText: nextTailText,
              parsedLog,
            });
          }

          if (isRelevantParsedLog(parsedLog)) {
            bestLogInfo = parsedLog;
          } else if (!bestLogInfo && parsedLog?.speedBytesPerSec > 0) {
            bestLogInfo = parsedLog;
          }
        } catch {
          // logPath does not exist or unreadable
        } finally {
          if (fh) {
            try {
              await fh.close();
            } catch {}
          }
        }
      }
    }
    return bestLogInfo;
  };

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  const stopMonitor = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    logTailStateByPath.clear();
    reusableDeltaBuf = null;
    downloadControllers.delete(taskId);
  };

  const runTick = () => {
    if (inFlightTick) return;
    inFlightTick = true;
    (async () => {
      const task = downloadQueueMap.get(taskId);
      if (
        !task ||
        task.status === 'cancelled' ||
        task.status === 'completed' ||
        task.status === 'failed'
      ) {
        stopMonitor();
        return;
      }

      if (task.status === 'paused') {
        return;
      }

      const nowMs = Date.now();
      const minTimestampMs = resolveTaskStartedAtMs(task);
      const shouldRefreshLocations =
        !cachedLocations ||
        !cachedLocations.steamappsDirs ||
        (Array.isArray(cachedLocations.steamappsDirs)
          ? cachedLocations.steamappsDirs.length === 0
          : cachedLocations.steamappsDirs.size === 0) ||
        !lastKnownManifestDir ||
        nowMs - cachedLocationsAt >= locationsCacheTtlMs;
      if (shouldRefreshLocations) {
        cachedLocations = discoverSteamLocations(options);
        cachedLocationsAt = nowMs;
      }
      let { steamRoots, steamappsDirs } = cachedLocations;
      const logInfo = options.syncLogSnapshot
        ? readContentLogIncrementalSync(steamRoots, minTimestampMs, nowMs)
        : await readContentLogIncrementalAsync(steamRoots, minTimestampMs, nowMs);

      /** @type {any} */
      let parsed = null;
      /** @type {string | null} */
      let matchedSteamappsDir = null;
      let acfMtimeMs = 0;

      const findManifestInDirsAsync = async (/** @type {Iterable<string>} */ dirs) => {
        const orderedDirs = [];
        if (lastKnownManifestDir) {
          orderedDirs.push(lastKnownManifestDir);
        }
        for (const dir of dirs) {
          if (dir !== lastKnownManifestDir) {
            orderedDirs.push(dir);
          }
        }
        for (const steamappsDir of orderedDirs) {
          const acfPath = path.join(steamappsDir, `appmanifest_${appId}.acf`);
          try {
            const [acfStat, acfText] = await Promise.all([
              fs.promises.stat(acfPath),
              fs.promises.readFile(acfPath, 'utf8'),
            ]);
            const candidateParsed = parseSteamAcf(acfText);
            if (candidateParsed && String(candidateParsed.appId) === String(appId)) {
              parsed = candidateParsed;
              matchedSteamappsDir = steamappsDir;
              lastKnownManifestDir = steamappsDir;
              acfMtimeMs = Number(acfStat?.mtimeMs || 0);
              break;
            }
          } catch {}
        }
      };

      await findManifestInDirsAsync(steamappsDirs);
      if (!matchedSteamappsDir && !shouldRefreshLocations) {
        cachedLocations = discoverSteamLocations(options);
        cachedLocationsAt = nowMs;
        steamRoots = cachedLocations.steamRoots;
        steamappsDirs = cachedLocations.steamappsDirs;
        await findManifestInDirsAsync(steamappsDirs);
      }

      const latestTask = downloadQueueMap.get(taskId);
      if (
        !latestTask ||
        latestTask.status === 'cancelled' ||
        latestTask.status === 'completed' ||
        latestTask.status === 'failed' ||
        latestTask.status === 'paused'
      ) {
        return;
      }

      if (!parsed && sawSteamActivity && logInfo?.updateCanceled && !logInfo.isRunning) {
        stopMonitor();
        updateDownloadTask(
          taskId,
          {
            status: 'cancelled',
            speedBytesPerSec: 0,
            etaSeconds: undefined,
            statusMessage: 'Installation cancelled in Steam client',
          },
          options
        );
        return;
      }

      const acfDownloaded = Number(parsed?.BytesDownloaded || 0);
      const acfTotal = Number(parsed?.BytesToDownload || 0);
      const acfStaged = Number(parsed?.BytesStaged || 0);
      const acfToStage = Number(parsed?.BytesToStage || 0);
      let logDownloaded = Number(logInfo?.bytesDownloaded || 0);
      const logTotal = Number(logInfo?.bytesToDownload || 0);
      const logStaged = Number(logInfo?.bytesStaged || 0);
      const logToStage = Number(logInfo?.bytesToStage || 0);

      if (acfTotal > 0 || logTotal > 0) {
        knownDownloadTotal = acfTotal > 0 ? acfTotal : logTotal;
      }
      if (acfToStage > 0 || logToStage > 0) {
        knownStageTotal = acfToStage > 0 ? acfToStage : logToStage;
      }

      if (
        acfTotal > 0 &&
        acfDownloaded === 0 &&
        logDownloaded >= acfTotal * 0.9 &&
        (!logInfo?.checkpointTs ||
          (minTimestampMs > 0 && logInfo.checkpointTs < minTimestampMs - 15000))
      ) {
        logDownloaded = 0;
      }

      const stateFlags = parsed && parsed.StateFlags ? String(parsed.StateFlags).trim() : '';
      const stateFlagsNum = stateFlags && /^\d+$/.test(stateFlags) ? Number(stateFlags) : NaN;
      const isStateFlagInstalled =
        stateFlags === '4' ||
        (Number.isFinite(stateFlagsNum) &&
          (stateFlagsNum & 4) === 4 &&
          (stateFlagsNum & (2 | 256 | 512 | 1024 | 2048)) === 0);
      const isAcfActivelyUpdating =
        Number.isFinite(stateFlagsNum) && (stateFlagsNum & (256 | 1024)) !== 0;

      const downloadTotal = acfTotal > 0 ? acfTotal : logTotal > 0 ? logTotal : knownDownloadTotal;
      const stageTotal = acfToStage > 0 ? acfToStage : logToStage > 0 ? logToStage : knownStageTotal;

      let estimatedFromRates = 0;
      const lastRateSampleTs =
        Array.isArray(logInfo?.rateSamples) && logInfo.rateSamples.length > 0
          ? Number(logInfo.rateSamples[logInfo.rateSamples.length - 1].tsMs || 0)
          : 0;
      const hasRecentRateTelemetry =
        lastRateSampleTs > 0 && nowMs >= lastRateSampleTs && nowMs - lastRateSampleTs <= 120000;
      const canExtrapolateRates = Boolean(
        logInfo?.isDownloading ||
          (isAcfActivelyUpdating &&
            !logInfo?.isSuspended &&
            !logInfo?.isCommitting &&
            !logInfo?.fullyInstalled)
      );

      if (
        acfDownloaded > 0 &&
        acfMtimeMs > 0 &&
        canExtrapolateRates &&
        hasRecentRateTelemetry &&
        Array.isArray(logInfo?.rateSamples) &&
        logInfo.rateSamples.length > 0
      ) {
        const anchorTs = Math.max(acfMtimeMs, Number(logInfo.checkpointTs || 0));
        const deltaAfterAcf = integrateSteamRateSamples(logInfo.rateSamples, anchorTs, nowMs, true);
        const rawEst = acfDownloaded + deltaAfterAcf;
        estimatedFromRates =
          downloadTotal > 0 ? Math.min(Math.floor(downloadTotal * 0.98), rawEst) : rawEst;
      } else if (acfDownloaded === 0) {
        const baseEstimated = Number(logInfo?.estimatedBytesDownloaded || 0);
        let fallbackIntegrated = 0;
        if (
          baseEstimated === 0 &&
          acfMtimeMs > 0 &&
          canExtrapolateRates &&
          hasRecentRateTelemetry &&
          Array.isArray(logInfo?.rateSamples) &&
          logInfo.rateSamples.length > 0
        ) {
          fallbackIntegrated = integrateSteamRateSamples(logInfo.rateSamples, acfMtimeMs, nowMs, true);
        }
        const rawEst = Math.max(baseEstimated, fallbackIntegrated);
        estimatedFromRates =
          downloadTotal > 0 ? Math.min(Math.floor(downloadTotal * 0.98), rawEst) : rawEst;
      }

      const rawDownloadDone = Math.max(acfDownloaded, logDownloaded, estimatedFromRates);
      const downloadDone =
        downloadTotal > 0 ? Math.min(downloadTotal, rawDownloadDone) : rawDownloadDone;

      const stageDone =
        stageTotal > 0
          ? Math.min(stageTotal, Math.max(acfStaged, logStaged))
          : Math.max(acfStaged, logStaged);

      let effectiveTotal = 0;
      let effectiveDownloaded = 0;

      if (downloadTotal > 0) {
        effectiveTotal = downloadTotal;
        effectiveDownloaded = downloadDone;
      } else if (stageTotal > 0) {
        effectiveTotal = stageTotal;
        effectiveDownloaded = stageDone;
      } else {
        effectiveTotal = Number(parsed?.SizeOnDisk || 0) || latestTask.totalBytes || 0;
        effectiveDownloaded = downloadDone || stageDone || 0;
      }

      if (
        effectiveTotal > 0 &&
        latestTask.totalBytes === effectiveTotal &&
        Number(latestTask.bytesDownloaded || 0) > effectiveDownloaded
      ) {
        effectiveDownloaded = Math.min(effectiveTotal, Number(latestTask.bytesDownloaded));
      }

      let commonInstallPath = null;
      if (matchedSteamappsDir && parsed) {
        const commonRoot = path.join(matchedSteamappsDir, 'common');
        const candidateCommon = path.resolve(commonRoot, parsed.installdir || String(appId));
        if (isContainedWithinRoot(commonRoot, candidateCommon)) {
          commonInstallPath = candidateCommon;
        }
      }

      let commonInstallExists = false;
      if (commonInstallPath) {
        try {
          await fs.promises.access(commonInstallPath);
          commonInstallExists = true;
        } catch {}
      }

      const isComplete =
        Boolean(parsed) &&
        (isStateFlagInstalled || Boolean(logInfo?.fullyInstalled)) &&
        commonInstallExists &&
        (acfTotal === 0 || acfDownloaded >= acfTotal || Boolean(logInfo?.fullyInstalled));

      if (isComplete && commonInstallPath) {
        stopMonitor();

        const hostPlat = options.platform || process.platform;
        const appInfoSpec = resolveSteamAppInfoLaunchSpec(
          matchedSteamappsDir || commonInstallPath,
          appId,
          commonInstallPath,
          { platform: hostPlat }
        );
        const exeDiscovery =
          appInfoSpec &&
          appInfoSpec.executablePath &&
          isContainedWithinRoot(commonInstallPath, appInfoSpec.executablePath)
            ? {
                executablePath: appInfoSpec.executablePath,
                isWindowsBinaryOnMac: appInfoSpec.isWindowsBinaryOnMac,
              }
            : findPrimaryExecutable(commonInstallPath, {
                platform: hostPlat,
                hintName: parsed.name || latestTask.title,
              });
        const isInsideBottle = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(commonInstallPath);
        const isWinOnMac =
          Boolean(exeDiscovery.isWindowsBinaryOnMac) ||
          (hostPlat === 'darwin' && isInsideBottle);
        const launchArguments =
          appInfoSpec?.launchArguments ||
          resolveDefaultEngineLaunchArguments(commonInstallPath, exeDiscovery.executablePath);

        let steamInstallerData = null;
        for (const xmlRel of ['__Installer/installerdata.xml', '__installer/installerdata.xml']) {
          const xmlFull = path.join(commonInstallPath, xmlRel);
          try {
            const xmlText = await fs.promises.readFile(xmlFull, 'utf8');
            steamInstallerData = parseSteamEaInstallerDataXml(xmlText);
            if (steamInstallerData) break;
          } catch {}
        }
        const steamChainedHandoff = resolveAnyChainedHandoffId(
          appInfoSpec?.chainedLauncherHandoff ||
            (steamInstallerData?.isEaChained ? 'ea' : null)
        );
        const steamRequiresProtocol = Boolean(
          appInfoSpec?.requiresStorefrontProtocolLaunch || steamChainedHandoff
        );

        const finalSize =
          Number(parsed.SizeOnDisk || 0) ||
          (await getDirectorySizeFastAsync(commonInstallPath, 3)) ||
          effectiveTotal ||
          latestTask.totalBytes;

        upsertManagedInstallRecord(
          {
            platformId: 'steam',
            platformGameId: String(appId),
            appId: Number(appId),
            title: parsed.name || latestTask.title,
            installPath: commonInstallPath,
            executablePath: exeDiscovery.executablePath,
            ...(launchArguments ? { launchArguments } : {}),
            ...(steamChainedHandoff
              ? {
                  chainedLauncherHandoff: steamChainedHandoff,
                  externalStorefrontHandoff: steamChainedHandoff,
                  chainedHandoffTopology: 'storefront_depot_uri',
                }
              : {}),
            ...(steamRequiresProtocol ? { requiresStorefrontProtocolLaunch: true } : {}),
            ...(steamInstallerData?.contentId
              ? { chainedExternalInstallId: steamInstallerData.contentId }
              : {}),
            installSize: finalSize,
            version: parsed.buildid ? String(parsed.buildid) : undefined,
            runner: 'steam',
            isWindowsBinaryOnMac:
              isWinOnMac || (hostPlat === 'darwin' && Boolean(steamChainedHandoff)),
          },
          options.userDataDir
        );

        updateDownloadTask(
          taskId,
          {
            status: 'completed',
            progressPercent: 100,
            bytesDownloaded: finalSize,
            totalBytes: finalSize,
            speedBytesPerSec: 0,
            etaSeconds: 0,
            finalInstallPath: commonInstallPath,
            executablePath: exeDiscovery.executablePath,
            ...(launchArguments ? { launchArguments } : {}),
            runner: 'steam',
            isWindowsBinaryOnMac: isWinOnMac,
            statusMessage: 'Installed via Steam',
          },
          options
        );
        return;
      }

      const hasActiveLogProgress = Boolean(
        logInfo &&
          (logInfo.updateStarted ||
            logInfo.isRunning ||
            logInfo.fullyInstalled ||
            logInfo.bytesToDownload > 0 ||
            logInfo.bytesToStage > 0 ||
            logInfo.phase)
      );

      if (!parsed && !hasActiveLogProgress) {
        if (!sawSteamActivity && retriggerCtx && !retriggerCtx.wasAuthenticatedAtLaunch) {
          if (retriggerCount < maxRetriggers) {
            const nowAuthed = await hasAuthenticatedSteamSessionInVdfCandidates(
              retriggerCtx.vdfCandidates,
              retriggerCtx.expectedSteamId64
            );
            const postAuthTask = downloadQueueMap.get(taskId);
            if (
              !postAuthTask ||
              postAuthTask.status === 'cancelled' ||
              postAuthTask.status === 'completed' ||
              postAuthTask.status === 'failed' ||
              postAuthTask.status === 'paused'
            ) {
              return;
            }
            if (nowAuthed) {
              const checkNowMs = Date.now();
              if (!authDetectedAtMs) {
                authDetectedAtMs = checkNowMs;
                invalidateScanCaches();
                cachedLocations = null;
              }
              const postLoginDelayMs = Number(
                options.steamPostLoginRetriggerDelayMs ?? (isTestEnvironment(options) ? 20 : 2500)
              );
              const secondRetryDelayMs = Number(
                options.steamPostLoginSecondRetryMs ?? (isTestEnvironment(options) ? 80 : 8000)
              );
              if (retriggerCount === 0 && checkNowMs - authDetectedAtMs >= postLoginDelayMs) {
                retriggerCount = 1;
                lastRetriggerAtMs = checkNowMs;
                invalidateScanCaches();
                cachedLocations = null;
                try {
                  await retriggerCtx.retriggerInstallAsync();
                } catch (retriggerErr) {
                  diagLog.debug('startSteamInstallMonitor.retrigger', retriggerErr, {
                    taskId,
                    appId,
                    attempt: 1,
                  });
                }
              } else if (
                retriggerCount === 1 &&
                checkNowMs - lastRetriggerAtMs >= secondRetryDelayMs
              ) {
                retriggerCount = 2;
                lastRetriggerAtMs = checkNowMs;
                invalidateScanCaches();
                cachedLocations = null;
                try {
                  await retriggerCtx.retriggerInstallAsync();
                } catch (retriggerErr) {
                  diagLog.debug('startSteamInstallMonitor.retrigger', retriggerErr, {
                    taskId,
                    appId,
                    attempt: 2,
                  });
                }
              }
            }
          }

          const pendingAuthStatusMsg =
            retriggerCount >= 1 || authDetectedAtMs > 0
              ? retriggerCtx.launchedViaWineSteam
                ? 'Steam sign-in detected in bottle — triggering game download...'
                : 'Steam sign-in detected — triggering game download...'
              : retriggerCtx.launchedViaWineSteam
                ? 'Installing via Windows Steam in CrossOver / Wine (waiting for Steam sign-in — download starts automatically once signed in)...'
                : 'Installing via Steam client (waiting for Steam sign-in — download starts automatically once signed in)...';

          updateDownloadTask(
            taskId,
            {
              status: 'downloading',
              progressPercent: 0,
              bytesDownloaded: 0,
              speedBytesPerSec: 0,
              statusMessage: pendingAuthStatusMsg,
            },
            options
          );
          return;
        }

        updateDownloadTask(
          taskId,
          {
            status: 'downloading',
            progressPercent: 0,
            bytesDownloaded: 0,
            speedBytesPerSec: 0,
            statusMessage: 'Waiting for confirmation in Steam client...',
          },
          options
        );
        return;
      }

      sawSteamActivity = true;

      const phaseLabel =
        logInfo?.phase ||
        (acfStaged > 0 && acfTotal > 0 && acfDownloaded >= acfTotal ? 'Staging' : 'Downloading');

      if (logInfo?.isCommitting || /^finalizing$/i.test(phaseLabel)) {
        if (effectiveTotal > 0) {
          effectiveDownloaded = Math.max(effectiveDownloaded, Math.floor(effectiveTotal * 0.99));
        }
      }

      const rawRatio = effectiveTotal > 0 ? effectiveDownloaded / effectiveTotal : 0;
      let progressPercent =
        effectiveTotal > 0
          ? Math.min(99, Math.max(latestTask.progressPercent || 0, Math.floor(rawRatio * 100)))
          : latestTask.progressPercent || 0;

      if (logInfo?.isCommitting || /^finalizing$/i.test(phaseLabel)) {
        progressPercent = 99;
      } else if (effectiveDownloaded === 0 && /preallocating|allocating/i.test(phaseLabel)) {
        progressPercent = 0;
      }

      const now = Date.now();
      let rawSpeedBytesPerSec = canExtrapolateRates ? Number(logInfo?.speedBytesPerSec || 0) : 0;
      if (!rawSpeedBytesPerSec && effectiveDownloaded > lastBytes && now > lastTickTime) {
        rawSpeedBytesPerSec = Math.round(
          ((effectiveDownloaded - lastBytes) * 1000) / (now - lastTickTime)
        );
      }
      lastBytes = effectiveDownloaded;
      lastTickTime = now;

      const speedBytesPerSec =
        logInfo?.isSuspended || logInfo?.isCommitting
          ? 0
          : computeSmoothedDownloadSpeed(taskId, {
              bytesDownloaded: effectiveDownloaded,
              rawSpeedBytesPerSec,
              nowMs: now,
            });

      const etaSeconds =
        speedBytesPerSec > 0 && effectiveTotal > effectiveDownloaded
          ? Math.max(1, Math.round((effectiveTotal - effectiveDownloaded) / speedBytesPerSec))
          : logInfo?.isCommitting
            ? 1
            : latestTask.etaSeconds;

      const nextStatus = /staging|extracting|finalizing/i.test(phaseLabel)
        ? 'extracting'
        : /verifying/i.test(phaseLabel)
          ? 'verifying'
          : 'downloading';

      const statusMessage =
        effectiveDownloaded === 0 && /preallocating|allocating/i.test(phaseLabel)
          ? `Steam: Preallocating ${latestTask.title} (0%)...`
          : `Steam: ${phaseLabel} ${latestTask.title} (${progressPercent}%)...`;

      updateDownloadTask(
        taskId,
        {
          status: nextStatus,
          progressPercent,
          bytesDownloaded: effectiveDownloaded,
          totalBytes: effectiveTotal,
          speedBytesPerSec,
          etaSeconds,
          statusMessage,
        },
        options
      );
    })()
      .catch((tickErr) => {
        diagLog.debug('startSteamInstallMonitor.tick', tickErr, { taskId, appId });
      })
      .finally(() => {
        inFlightTick = false;
      });
  };

  timer = setInterval(runTick, intervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  downloadControllers.set(taskId, { type: 'timer', timer });
  Promise.resolve().then(runTick);
  return timer;
}

module.exports = {
  STEAM_SETUP_ALLOWED_HOSTS,
  MAX_STEAM_SETUP_BYTES,
  hasEmbeddedPeAuthenticodeCertificateBuffer,
  verifySteamSetupBuffer,
  validateValveSteamSetupUrl,
  resolveExpectedSteamId64Async,
  hasAuthenticatedSteamSessionInVdfCandidates,
  ensureWindowsSteamInBottle,
  startSteamInstallMonitor,
};
