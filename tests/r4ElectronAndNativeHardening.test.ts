import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import * as tsConfigSanitizers from '../src/contracts/launchConfigSanitizers';
import * as tsEnvironmentCatalog from '../src/contracts/environmentCatalog';
import * as tsLaunchPolicyResolver from '../src/contracts/launchPolicyResolver';
import { scanContentForPiiViolations } from './helpers/piiHygieneGuard';

const nodeRequire = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, '..');

// ============================================================================
// Strongly-typed CJS module contracts (zero `any` across the entire suite)
// ============================================================================

interface CjsConfigSanitizersModule {
  WINE_DEBUG_MODE_TO_ENV_MAP: Readonly<Record<string, string>>;
  sanitizeWineDebugMode: (val: unknown) => string | undefined;
  resolveWineDebugEnvValue: (val: unknown) => string | undefined;
  migrateLegacyHudConfig: <T>(cfg: T) => T;
}

interface CjsEnvironmentCatalogModule {
  TARGET_TO_STOREFRONT_MAP: Readonly<Record<string, string>>;
  TARGET_TO_SCOPE_MAP: Readonly<Record<string, string>>;
  resolveStorefrontForLoginTarget: (targetId: unknown) => string | undefined;
  resolveScopeForLoginTarget: (targetId: unknown) => string | undefined;
}

interface CjsLaunchPolicyCoreModule {
  isRunnerSupportedOnHost: (
    runnerType: unknown,
    hostPlatform?: unknown,
    hostArch?: unknown
  ) => { supported: boolean; reason: string | null };
  resolveEffectiveLaunchPolicy: (input?: Record<string, unknown>) => Record<string, unknown>;
}

interface EncryptedEnvelope {
  _encrypted_v2: boolean;
  _encrypted_v3?: boolean;
  alg?: string;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

interface TokenVaultModule {
  getTokensFilePath: (options?: Record<string, unknown> | string) => string;
  encryptTokensPayload: (
    jsonStr: string,
    options?: Record<string, unknown>
  ) => EncryptedEnvelope;
  encryptTokensPayloadAsync: (
    jsonStr: string,
    options?: Record<string, unknown>
  ) => Promise<EncryptedEnvelope>;
  decryptTokensPayload: (
    payload: EncryptedEnvelope,
    options?: Record<string, unknown>
  ) => Record<string, unknown>;
  decryptTokensPayloadAsync: (
    payload: EncryptedEnvelope,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  runWithVaultMutex: <T>(
    filePath: string,
    task: () => Promise<T> | T,
    lockTimeoutMs?: number
  ) => Promise<T>;
  invalidateVaultMemoryCache: (filePathOrOptions?: string | Record<string, unknown>) => void;
}

interface DiagnosticLoggerModule {
  redactSensitiveDiagnosticText: (input: unknown) => string;
}

interface UninstallSafetyModule {
  validateManagedSentinelContent: (rawContent: unknown) => boolean;
  isSafeToDeleteInstallPath: (targetPath: unknown, options?: Record<string, unknown>) => boolean;
}

interface SecurityAndPathUtilsModule {
  isContainedWithinRoot: (
    anchorRoot: string,
    resolvedPath: string,
    platform?: string
  ) => boolean;
  isTrustedAppRendererUrl: (
    rawUrl: unknown,
    options?: {
      isPackaged?: boolean;
      allowedDevOrigin?: string | null;
      expectedFileHref?: string | null;
    }
  ) => boolean;
  isTrustedIpcSenderEvent: (
    event: unknown,
    options?: {
      isPackaged?: boolean;
      allowedDevOrigin?: string | null;
      expectedFileHref?: string | null;
      strictSenderFrame?: boolean;
    }
  ) => boolean;
  assertTrustedIpcSender: (
    event: unknown,
    options?: {
      isPackaged?: boolean;
      allowedDevOrigin?: string | null;
      expectedFileHref?: string | null;
      strictSenderFrame?: boolean;
      channel?: string;
    }
  ) => void;
}

interface ProcessTreeUtilsModule {
  extractMatchedPidFromProcessOutput: (
    stdout: string,
    exeHints?: string | string[],
    platform?: string
  ) => number;
  collectPosixDescendantPids: (psOutput: string, rootPid: number) => number[];
}

interface XboxAuthProviderInstance {
  getTokenAndSignatureForUrl: (
    params?: Record<string, unknown>
  ) => Promise<{ token: string; signature: string }>;
  dispose: () => void;
}

interface XboxAuthManagerModule {
  XSTS_RELYING_PARTIES: Readonly<Record<string, string>>;
  generateXboxProofKeyPair: () => {
    privateKeyPem: string;
    publicKeyPem: string;
    proofKeyJwk: Record<string, unknown>;
  };
  resolveBuiltInRelyingPartyForUrl: (targetUrl: string) => string | null;
  matchDynamicTitleEndpointRelyingParty: (
    targetUrl: string,
    endPoints?: Array<Record<string, unknown>>
  ) => string | null;
  createXboxAuthProvider: (config?: Record<string, unknown>) => XboxAuthProviderInstance;
}

interface XboxTitleStorageSyncModule {
  formatWgsUserScidFolderName: (xuid: string | number | bigint, scid: string) => string;
}

interface LoopbackServerHandle {
  host: string;
  port: number;
  sessionKey: string;
  close: () => Promise<void>;
}

interface XboxLoopbackServerModule {
  validateSafeScid: (rawScid: unknown, options?: { allowEmpty?: boolean }) => string;
  startXboxRuntimeLoopbackServer: (
    options?: Record<string, unknown>
  ) => Promise<LoopbackServerHandle>;
}

interface LoopbackConnectionHandlerModule {
  isValidLoopbackHostHeader: (rawHost: string | undefined | null) => boolean;
}

interface XvdLayoutResult {
  pageSize: number;
  hashTree: {
    byteOffset: number;
    pageCount: number;
    totalPages: number;
    level0Pages: number;
    level1Pages: number;
    level2Pages: number;
    level3Pages: number;
    level0ByteOffset: number;
    level1ByteOffset: number;
    level2ByteOffset: number;
    level3ByteOffset: number;
    topLevel: number;
    resiliencyMultiplier: number;
  };
  userData: { byteOffset: number; byteLength: number };
  driveData: { byteOffset: number; byteLength: number };
}

interface XvdRangeReader {
  getTotalSize: () => Promise<number | null>;
  readRange: (offset: number, length: number, signal?: AbortSignal) => Promise<Buffer>;
}

interface MsixvcXvdParserModule {
  XVD_PAGE_SIZE: number;
  XVD_HASH_ENTRIES_PER_PAGE: number;
  XVD_HASH_ENTRY_SIZE: number;
  computeXvdLayout: (header: Record<string, unknown>) => XvdLayoutResult;
  computeXvdL0PageHash: (rawPageBuffer: Buffer, hashByteLength?: number) => Buffer;
  computeXvdHashBlockHash: (rawHashPageBuffer: Buffer, hashByteLength?: number) => Buffer;
  createXvdHashTreeVerifier: (params: {
    rangeReader: XvdRangeReader;
    layout: XvdLayoutResult;
    topHashBlockHash: Buffer;
  }) => {
    topLevel: number;
    verifyL0Span: (
      l0SpanBuf: Buffer,
      firstL0LogicalPage: number,
      logicalPageCount: number
    ) => Promise<Buffer[]>;
    getStats: () => {
      topLevel: number;
      cachedUpperPages: number;
      upperFetches: number;
      upperCacheHits: number;
      verifiedL0Count: number;
    };
  };
  readL0EntriesForPages: (
    rangeReader: XvdRangeReader,
    layout: XvdLayoutResult,
    firstPageByteOffset: number,
    pageCount: number,
    options?: Record<string, unknown>
  ) => Promise<{
    enabled: boolean;
    dataUnits: Uint32Array;
    hashes: Array<Buffer | null>;
    merkleVerified: boolean;
  }>;
  verifyXvdContiguousPagesL0: (
    rawPagesBuffer: Buffer,
    l0Hashes: Array<Buffer | null>,
    options?: { firstPageByteOffset?: number; topHashBlockHash?: Buffer }
  ) => boolean;
  validateXvdCdnUrl: (
    rawUrl: unknown,
    options?: { allowedHosts?: Iterable<string>; allowLocalhost?: boolean }
  ) => string;
  createHttpRangeReader: (options?: Record<string, unknown>) => XvdRangeReader;
  fetchRange: (
    targetUrl: string,
    startByte: number,
    endInclusive: number,
    options?: Record<string, unknown>
  ) => Promise<{ status: number; buffer: Buffer; totalSize: number | null }>;
}

interface WindowsXboxOrchestratorModule {
  queryTargetedAppxPackageAsync: (
    targetInfo?: {
      identityName?: string;
      packageFamilyName?: string;
      selectFields?: string | string[];
    },
    options?: Record<string, unknown>
  ) => Promise<{
    found: boolean;
    pkg: Record<string, unknown> | null;
    stdout: string;
    stderr: string;
    error: string | null;
  }>;
  removeTargetedAppxPackageVerifiedAsync: (
    targetInfo?: { identityName?: string; packageFamilyName?: string },
    options?: Record<string, unknown>
  ) => Promise<{ removed: boolean; stillInstalled: boolean; error: string | null }>;
}

interface GogScriptInterpreterModule {
  isAllowedGogRegistryTarget: (
    rawRoot: string,
    rawSubKey: string
  ) => {
    allowed: boolean;
    normalizedRoot: string;
    normalizedSubKey: string;
    reason?: string;
  };
  executeGogGameScript: (
    installDir: string,
    options?: Record<string, unknown>
  ) => Promise<{
    executed: boolean;
    skippedCached: boolean;
    scriptsProcessed: number;
    registryKeysApplied: number;
    supportFilesStaged: number;
    iniEntriesApplied: number;
  }>;
}

interface CloudSaveEngineModule {
  inspectOneDrivePlaceholderStateAsync: (
    targetDir: string,
    options?: Record<string, unknown>
  ) => Promise<{
    hasPlaceholders: boolean;
    blockedBroadRoot: boolean;
    placeholderFiles: string[];
  }>;
}

interface DownloadQueueCoordinatorModule {
  updateDownloadTask: (
    taskId: string,
    partial?: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => { success: boolean; task?: Record<string, unknown>; error?: string };
  gracefulShutdownDownloads: (
    timeoutMs?: number,
    options?: Record<string, unknown>
  ) => Promise<void>;
  clearDownloadQueue: () => void;
}

interface EngineStateRegistryModule {
  downloadQueueMap: Map<string, Record<string, unknown>>;
  downloadControllers: Map<string, Record<string, unknown>>;
  downloadSpeedTrackers: Map<string, unknown>;
  onDownloadUpdated: (
    listener: (payload: { task: Record<string, unknown>; queue: Record<string, unknown>[] }) => void
  ) => () => void;
}

interface OfflineVaultInstance {
  db: { prepare: (sql: string) => unknown } | null;
  stmtCache: { size: number; statements: Map<string, unknown> } | null;
  init: () => OfflineVaultInstance;
  upsertGames: (games: Array<Record<string, unknown>>) => {
    success?: boolean;
    upserted?: number;
    skipped?: number;
  };
  getGameDetail: (gameId: string) => Record<string, unknown> | null;
  getCatalogSnapshot: (options?: Record<string, unknown>) => {
    games?: Array<Record<string, unknown>>;
  };
  close: () => void;
}

interface OfflineVaultServiceModule {
  OfflineVaultService: new (options?: Record<string, unknown>) => OfflineVaultInstance;
  getCriticAuthorityRank: (
    criticObj: unknown,
    options?: { isUserOverride?: boolean }
  ) => number;
  sanitizeVaultPlatformEntry: (
    entry: Record<string, unknown>,
    context?: Record<string, unknown> | null
  ) => { entry: Record<string, unknown> | null; repaired: boolean };
}

interface StorefrontReadinessBarrierModule {
  isBottleWinExeRunning: (
    exeName: string,
    bottlePath?: string,
    options?: Record<string, unknown>
  ) => Promise<boolean>;
}

interface BinaryAndManifestInspectorsModule {
  parseEpicManifestBuffer: (buf: Buffer) => { diskSize: number; downloadSize: number } | null;
}

interface ManifestParsersModule {
  MAX_EPIC_MANIFEST_INFLATE_BYTES: number;
}

interface WineAndCrossOverManagerModule {
  readVerifiedBridgeDllBuffer: (
    dllPath: string,
    options?: Record<string, unknown>
  ) => Promise<{ buf: Buffer | null; sha256: string; sidecarVerified: boolean }>;
}

const cjsConfigSanitizers = nodeRequire(
  '../electron/launcher/policy/configSanitizers.cjs'
) as CjsConfigSanitizersModule;
const cjsEnvironmentCatalog = nodeRequire(
  '../electron/launcher/policy/environmentCatalog.cjs'
) as CjsEnvironmentCatalogModule;
const cjsLaunchPolicyCore = nodeRequire(
  '../electron/launcher/policy/launchPolicyCore.cjs'
) as CjsLaunchPolicyCoreModule;
const tokenVault = nodeRequire('../electron/storefronts/tokenVault.cjs') as TokenVaultModule;
const diagnosticLogger = nodeRequire(
  '../electron/utils/diagnosticLogger.cjs'
) as DiagnosticLoggerModule;
const uninstallSafety = nodeRequire(
  '../electron/launcher/uninstallSafety.cjs'
) as UninstallSafetyModule;
const securityUtils = nodeRequire(
  '../electron/launcher/securityAndPathUtils.cjs'
) as SecurityAndPathUtilsModule;
const processTreeUtils = nodeRequire(
  '../electron/launcher/processTreeUtils.cjs'
) as ProcessTreeUtilsModule;
const xboxAuthManager = nodeRequire(
  '../electron/storefronts/xbox/xboxAuthManager.cjs'
) as XboxAuthManagerModule;
const xboxTitleStorageSync = nodeRequire(
  '../electron/storefronts/xbox/xboxTitleStorageSync.cjs'
) as XboxTitleStorageSyncModule;
const xboxLoopbackServer = nodeRequire(
  '../electron/storefronts/xbox/xboxRuntimeLoopbackServer.cjs'
) as XboxLoopbackServerModule;
const loopbackConnHandler = nodeRequire(
  '../electron/storefronts/xbox/loopback/loopbackConnectionHandler.cjs'
) as LoopbackConnectionHandlerModule;
const msixvcXvdParser = nodeRequire(
  '../electron/storefronts/xbox/msixvcXvdParser.cjs'
) as MsixvcXvdParserModule;
const windowsXboxOrchestrator = nodeRequire(
  '../electron/launcher/windowsXboxAppxAndMsixvcOrchestrator.cjs'
) as WindowsXboxOrchestratorModule;
const gogScriptInterpreter = nodeRequire(
  '../electron/storefronts/gog/gogScriptInterpreter.cjs'
) as GogScriptInterpreterModule;
const cloudSaveEngine = nodeRequire(
  '../electron/launcher/cloudSaveEngine.cjs'
) as CloudSaveEngineModule;
const downloadCoordinator = nodeRequire(
  '../electron/launcher/downloadQueueCoordinator.cjs'
) as DownloadQueueCoordinatorModule;
const engineStateRegistry = nodeRequire(
  '../electron/launcher/engineStateRegistry.cjs'
) as EngineStateRegistryModule;
const offlineVaultMod = nodeRequire(
  '../electron/launcher/offlineVaultService.cjs'
) as OfflineVaultServiceModule;
const readinessBarrier = nodeRequire(
  '../electron/launcher/storefrontReadinessBarrier.cjs'
) as StorefrontReadinessBarrierModule;
const binaryInspectors = nodeRequire(
  '../electron/launcher/binaryAndManifestInspectors.cjs'
) as BinaryAndManifestInspectorsModule;
const manifestParsers = nodeRequire(
  '../electron/launcher/inspectors/manifestParsers.cjs'
) as ManifestParsersModule;
const wineAndCrossOverManager = nodeRequire(
  '../electron/launcher/wineAndCrossOverManager.cjs'
) as WineAndCrossOverManagerModule;

// ============================================================================
// Hermetic Test Helpers (Temp Sandboxes, Raw TCP Helper, Mach-O / PE Parsers)
// ============================================================================

const trackedTempDirs: string[] = [];
const trackedVaults: OfflineVaultInstance[] = [];
const trackedLoopbackServers: LoopbackServerHandle[] = [];
const trackedUnsubscribers: Array<() => void> = [];

function createSandboxDir(prefix = 'ol-r4-hardening-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedTempDirs.push(dir);
  return dir;
}

function sendRawTcpRequest(host: string, port: number, payload: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sock = net.createConnection({ host, port });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    sock.setTimeout(3000, () => finish(new Error('TCP request timed out')));
    sock.on('connect', () => {
      sock.write(payload);
    });
    sock.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    sock.on('end', () => finish());
    sock.on('close', () => finish());
    sock.on('error', (err) => {
      if (chunks.length > 0) finish();
      else finish(err);
    });
  });
}

interface ParsedMachOSlice {
  cpuType: number;
  dylibs: string[];
  codeDirectoryFlags: number | null;
}

function inspectUniversalMachOBinary(filePath: string): ParsedMachOSlice[] {
  const buf = fs.readFileSync(filePath);
  const magicBE = buf.readUInt32BE(0);
  const slices: Buffer[] = [];

  if (magicBE === 0xcafebabe) {
    const nfat = buf.readUInt32BE(4);
    for (let i = 0; i < nfat; i += 1) {
      const off = buf.readUInt32BE(8 + i * 20 + 8);
      const size = buf.readUInt32BE(8 + i * 20 + 12);
      slices.push(buf.subarray(off, off + size));
    }
  } else {
    slices.push(buf);
  }

  return slices.map((slice) => {
    const sliceMagic = slice.readUInt32LE(0);
    const cpuType = slice.readUInt32LE(4);
    const ncmds = slice.readUInt32LE(16);
    const headerSize = sliceMagic === 0xfeedfacf ? 32 : 28;
    let cursor = headerSize;
    const dylibs: string[] = [];
    let codeDirectoryFlags: number | null = null;

    for (let i = 0; i < ncmds; i += 1) {
      const cmd = slice.readUInt32LE(cursor);
      const cmdsize = slice.readUInt32LE(cursor + 4);
      if (cmd === 0x0c || cmd === 0x80000018) {
        const strOff = slice.readUInt32LE(cursor + 8);
        const nulIdx = slice.indexOf(0, cursor + strOff);
        const end = nulIdx > cursor + strOff && nulIdx < cursor + cmdsize ? nulIdx : cursor + cmdsize;
        dylibs.push(slice.subarray(cursor + strOff, end).toString('utf8'));
      } else if (cmd === 0x1d) {
        const dataoff = slice.readUInt32LE(cursor + 8);
        if (dataoff + 12 <= slice.length && slice.readUInt32BE(dataoff) === 0xfade0cc0) {
          const blobCount = slice.readUInt32BE(dataoff + 8);
          for (let b = 0; b < blobCount; b += 1) {
            const slotType = slice.readUInt32BE(dataoff + 12 + b * 8);
            const relOff = slice.readUInt32BE(dataoff + 12 + b * 8 + 4);
            if (slotType === 0) {
              const cdStart = dataoff + relOff;
              if (cdStart + 16 <= slice.length && slice.readUInt32BE(cdStart) === 0xfade0c02) {
                codeDirectoryFlags = slice.readUInt32BE(cdStart + 12);
              }
            }
          }
        }
      }
      cursor += cmdsize;
    }

    return { cpuType, dylibs, codeDirectoryFlags };
  });
}

interface ParsedPeSectionInfo {
  name: string;
  virtualSize: number;
  rawSize: number;
}

interface ParsedPeBinary {
  machine: number;
  optionalMagic: number;
  exceptionDirSize: number;
  sections: ParsedPeSectionInfo[];
}

function inspectPeBinary(filePath: string): ParsedPeBinary {
  const buf = fs.readFileSync(filePath);
  expect(buf.readUInt16LE(0)).toBe(0x5a4d); // 'MZ'
  const peOff = buf.readUInt32LE(0x3c);
  expect(buf.subarray(peOff, peOff + 4).toString('ascii')).toBe('PE\0\0');

  const machine = buf.readUInt16LE(peOff + 4);
  const numSections = buf.readUInt16LE(peOff + 6);
  const optHeaderSize = buf.readUInt16LE(peOff + 20);
  const optOff = peOff + 24;
  const optionalMagic = buf.readUInt16LE(optOff);
  const isPe32Plus = optionalMagic === 0x020b;

  // DataDirectory[3] is Exception Table (.pdata)
  const dataDirBase = optOff + (isPe32Plus ? 112 : 96);
  const exceptionDirSize =
    dataDirBase + 3 * 8 + 8 <= optOff + optHeaderSize
      ? buf.readUInt32LE(dataDirBase + 3 * 8 + 4)
      : 0;

  const sections: ParsedPeSectionInfo[] = [];
  const sectionTableOff = optOff + optHeaderSize;
  for (let i = 0; i < numSections; i += 1) {
    const o = sectionTableOff + i * 40;
    const name = buf.subarray(o, o + 8).toString('ascii').replace(/\0+$/, '');
    const virtualSize = buf.readUInt32LE(o + 8);
    const rawSize = buf.readUInt32LE(o + 16);
    sections.push({ name, virtualSize, rawSize });
  }

  return { machine, optionalMagic, exceptionDirSize, sections };
}

afterEach(async () => {
  vi.restoreAllMocks();

  while (trackedUnsubscribers.length > 0) {
    const unsub = trackedUnsubscribers.pop();
    try {
      unsub?.();
    } catch {}
  }

  while (trackedLoopbackServers.length > 0) {
    const srv = trackedLoopbackServers.pop();
    if (srv) {
      await srv.close().catch(() => {});
    }
  }

  while (trackedVaults.length > 0) {
    const v = trackedVaults.pop();
    try {
      v?.close();
    } catch {}
  }

  downloadCoordinator.clearDownloadQueue();
  engineStateRegistry.downloadQueueMap.clear();
  engineStateRegistry.downloadControllers.clear();
  engineStateRegistry.downloadSpeedTrackers.clear();

  while (trackedTempDirs.length > 0) {
    const dir = trackedTempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ============================================================================
// 1. Mirrored Policy & Gate 13 Contracts (`electron/launcher/policy/*`)
// ============================================================================

describe('1. Mirrored Policy & Gate 13 Contracts (electron/launcher/policy/*)', () => {
  it('1a. WINE_DEBUG_MODE_TO_ENV_MAP maps UI enum tokens and preserves raw Wine channel strings across CJS and TS', () => {
    expect(cjsConfigSanitizers.WINE_DEBUG_MODE_TO_ENV_MAP).toStrictEqual({
      off: '-all',
      fixme_err: 'fixme+all,err+all',
      warn_err: 'warn+all,err+all',
      relay: '+relay',
    });
    expect(cjsConfigSanitizers.WINE_DEBUG_MODE_TO_ENV_MAP).toStrictEqual(
      tsConfigSanitizers.WINE_DEBUG_MODE_TO_ENV_MAP
    );

    const probes: Array<[unknown, string | undefined]> = [
      ['off', '-all'],
      ['OFF', '-all'],
      ['fixme_err', 'fixme+all,err+all'],
      ['warn_err', 'warn+all,err+all'],
      ['relay', '+relay'],
      ['+loaddll,err+all', '+loaddll,err+all'],
      ['-all,err+system,+tid', '-all,err+system,+tid'],
      ['   ', undefined],
      ['', undefined],
      [null, undefined],
    ];

    for (const [input, expected] of probes) {
      expect(cjsConfigSanitizers.resolveWineDebugEnvValue(input)).toBe(expected);
      expect(tsConfigSanitizers.resolveWineDebugEnvValue(input)).toBe(expected);
    }
  });

  it('1b. TARGET_TO_STOREFRONT_MAP maps host/bottle steam, ea, and riot targets accurately without steam->ea substring collisions', () => {
    expect(cjsEnvironmentCatalog.TARGET_TO_STOREFRONT_MAP).toStrictEqual(
      tsEnvironmentCatalog.TARGET_TO_STOREFRONT_MAP
    );
    expect(cjsEnvironmentCatalog.TARGET_TO_STOREFRONT_MAP.host_steam).toBe('steam');
    expect(cjsEnvironmentCatalog.TARGET_TO_STOREFRONT_MAP.bottle_steam).toBe('steam');
    expect(cjsEnvironmentCatalog.TARGET_TO_STOREFRONT_MAP.host_ea).toBe('ea');
    expect(cjsEnvironmentCatalog.TARGET_TO_STOREFRONT_MAP.bottle_ea).toBe('ea');
    expect(cjsEnvironmentCatalog.TARGET_TO_STOREFRONT_MAP.host_riot).toBe('riot');

    expect(cjsEnvironmentCatalog.resolveStorefrontForLoginTarget('host_steam')).toBe('steam');
    expect(cjsEnvironmentCatalog.resolveStorefrontForLoginTarget('bottle_steam')).toBe('steam');
    expect(cjsEnvironmentCatalog.resolveStorefrontForLoginTarget('host_ea')).toBe('ea');
    expect(cjsEnvironmentCatalog.resolveStorefrontForLoginTarget('host_riot')).toBe('riot');
    expect(cjsEnvironmentCatalog.resolveScopeForLoginTarget('host_riot')).toBe('host');
    expect(cjsEnvironmentCatalog.resolveScopeForLoginTarget('bottle_steam')).toBe('bottle');
  });

  it('1c. migrateLegacyHudConfig preserves exact referential identity on already-migrated configs while migrating legacy booleans', () => {
    const alreadyMigratedTop = {
      performanceHud: 'on' as const,
      wineMsync: true,
    };
    const alreadyMigratedNested = {
      performanceHud: 'default' as const,
      platformConfigs: {
        steam: { performanceHud: 'off' as const, launchMethod: 'auto' as const },
        gog: { performanceHud: 'on' as const, launchMethod: 'direct' as const },
      },
    };

    expect(cjsConfigSanitizers.migrateLegacyHudConfig(alreadyMigratedTop)).toBe(alreadyMigratedTop);
    expect(tsConfigSanitizers.migrateLegacyHudConfig(alreadyMigratedTop)).toBe(alreadyMigratedTop);
    expect(cjsConfigSanitizers.migrateLegacyHudConfig(alreadyMigratedNested)).toBe(
      alreadyMigratedNested
    );
    expect(tsConfigSanitizers.migrateLegacyHudConfig(alreadyMigratedNested)).toBe(
      alreadyMigratedNested
    );

    const legacyCfg = {
      metalHud: true,
      platformConfigs: {
        gog: { dxvkHud: true },
      },
    };
    const cjsMigrated = cjsConfigSanitizers.migrateLegacyHudConfig(legacyCfg) as {
      performanceHud?: string;
      platformConfigs?: { gog?: { performanceHud?: string } };
    };
    const tsMigrated = tsConfigSanitizers.migrateLegacyHudConfig(
      legacyCfg as Record<string, unknown>
    ) as {
      performanceHud?: string;
      platformConfigs?: { gog?: { performanceHud?: string } };
    };

    expect(cjsMigrated).not.toBe(legacyCfg);
    expect(cjsMigrated.performanceHud).toBe('on');
    expect(cjsMigrated.platformConfigs?.gog?.performanceHud).toBe('on');
    expect(cjsMigrated).toStrictEqual(tsMigrated);
  });

  it('1d. Rejects crossover_preview_arm64 on Intel x64 macOS and non-macOS hosts in both CJS and TS policy engines', () => {
    const cjsIntel = cjsLaunchPolicyCore.isRunnerSupportedOnHost(
      'crossover_preview_arm64',
      'darwin',
      'x64'
    );
    const tsIntel = tsLaunchPolicyResolver.isRunnerSupportedOnHost(
      'crossover_preview_arm64',
      'darwin',
      'x64'
    );
    expect(cjsIntel.supported).toBe(false);
    expect(cjsIntel.reason).toContain('Apple Silicon');
    expect(cjsIntel).toStrictEqual(tsIntel);

    const cjsWin = cjsLaunchPolicyCore.isRunnerSupportedOnHost(
      'crossover_preview_arm64',
      'win32',
      'x64'
    );
    expect(cjsWin.supported).toBe(false);

    const cjsArm = cjsLaunchPolicyCore.isRunnerSupportedOnHost(
      'crossover_preview_arm64',
      'darwin',
      'arm64'
    );
    expect(cjsArm).toStrictEqual({ supported: true, reason: null });

    const policyInput = {
      platformId: 'steam' as const,
      hostPlatform: 'darwin' as const,
      hostArch: 'x64' as const,
      detectedBuildType: 'windows_exe_on_mac' as const,
      isInstalled: true,
      hasExecutable: true,
      configuredLaunchMethod: 'compatibility_layer' as const,
      compatibilityLayer: 'crossover_preview_arm64' as const,
      crossoverGraphicsBackend: 'dxmt' as const,
    };
    const cjsPolicy = cjsLaunchPolicyCore.resolveEffectiveLaunchPolicy(policyInput);
    const tsPolicy = tsLaunchPolicyResolver.resolveEffectiveLaunchPolicy(policyInput);
    expect(cjsPolicy).toStrictEqual(tsPolicy);
    expect(cjsPolicy.runnerHostArchSupported).toBe(false);
    expect(cjsPolicy.supportsMetalfxSpatial).toBe(false);
    expect(String(cjsPolicy.runnerHostArchError)).toContain('Apple Silicon');
  });
});

// ============================================================================
// 2. Token Vault GCM & Mutex (`electron/storefronts/tokenVault.cjs`)
// ============================================================================

describe('2. Token Vault GCM & Mutex (electron/storefronts/tokenVault.cjs)', () => {
  it('2a. Rejects forged/truncated 8B & 12B GCM auth tags and malformed 11B & 16B IVs fail-closed (sync + async)', async () => {
    const sandbox = createSandboxDir('ol-r4-vault-gcm-');
    const vaultOpts = {
      userDataDir: sandbox,
      machineIdOverride: 'r4-synth-machine-id',
      vaultSecretOverride: 'a'.repeat(64),
    };

    const plaintext = JSON.stringify({ gog: { access_token: 'synth_valid_payload_12345' } });
    const sealed = tokenVault.encryptTokensPayload(plaintext, vaultOpts);

    // Baseline valid 12-byte IV & 16-byte tag decrypt cleanly
    expect(Buffer.from(sealed.iv, 'base64').length).toBe(12);
    expect(Buffer.from(sealed.tag, 'base64').length).toBe(16);
    expect(tokenVault.decryptTokensPayload(sealed, vaultOpts)).toEqual({
      gog: { access_token: 'synth_valid_payload_12345' },
    });
    await expect(tokenVault.decryptTokensPayloadAsync(sealed, vaultOpts)).resolves.toEqual({
      gog: { access_token: 'synth_valid_payload_12345' },
    });

    const fullTag = Buffer.from(sealed.tag, 'base64');
    const truncatedTag8 = { ...sealed, tag: fullTag.subarray(0, 8).toString('base64') };
    const truncatedTag12 = { ...sealed, tag: fullTag.subarray(0, 12).toString('base64') };
    const malformedIv11 = { ...sealed, iv: crypto.randomBytes(11).toString('base64') };
    const malformedIv16 = { ...sealed, iv: crypto.randomBytes(16).toString('base64') };
    const forgedTag16 = {
      ...sealed,
      tag: Buffer.from(fullTag.map((b, i) => (i === 0 ? b ^ 0xff : b))).toString('base64'),
    };

    // Also craft a genuine OpenSSL AES-256-GCM envelope signed with an 8-byte truncated tag to prove CWE-347 is blocked
    const salt = Buffer.from(sealed.salt, 'base64');
    const key = crypto.scryptSync(`one-launcher-vault-v2:${vaultOpts.machineIdOverride}:${vaultOpts.vaultSecretOverride}`, salt, 32);
    const shortTagIv = crypto.randomBytes(12);
    const shortTagCipher = crypto.createCipheriv('aes-256-gcm', key, shortTagIv, { authTagLength: 8 });
    const shortTagCt = Buffer.concat([shortTagCipher.update(plaintext, 'utf8'), shortTagCipher.final()]);
    const genuineShortTagEnvelope: EncryptedEnvelope = {
      ...sealed,
      iv: shortTagIv.toString('base64'),
      tag: shortTagCipher.getAuthTag().toString('base64'),
      data: shortTagCt.toString('base64'),
    };

    for (const badPayload of [
      truncatedTag8,
      truncatedTag12,
      genuineShortTagEnvelope,
      malformedIv11,
      malformedIv16,
      forgedTag16,
    ]) {
      expect(() => tokenVault.decryptTokensPayload(badPayload, vaultOpts)).toThrow();
      await expect(tokenVault.decryptTokensPayloadAsync(badPayload, vaultOpts)).rejects.toThrow();
    }
  });

  it('2b. Non-releasing mutex acquisition timeout prevents a third writer from overlapping an active in-flight writer', async () => {
    const sandbox = createSandboxDir('ol-r4-vault-mutex-');
    const lockFile = path.join(sandbox, 'tokens.json');

    let inFlightCount = 0;
    let maxObservedConcurrency = 0;
    let writer1Finished = false;
    let writer2Ran = false;
    let writer3StartedAfterWriter1Finished = false;
    let releaseWriter1: (() => void) | null = null;

    const writer1Entered = new Promise<void>((resolve) => {
      const p1 = tokenVault.runWithVaultMutex(
        lockFile,
        async () => {
          inFlightCount += 1;
          maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlightCount);
          resolve();
          await new Promise<void>((done) => {
            releaseWriter1 = done;
          });
          writer1Finished = true;
          inFlightCount -= 1;
          return 'w1-ok';
        },
        2000
      );
      void p1;
    });

    await writer1Entered;

    // Waiter #2 times out while Writer #1 is still holding the mutex
    const writer2Promise = tokenVault.runWithVaultMutex(
      lockFile,
      async () => {
        writer2Ran = true;
        return 'w2-should-not-run';
      },
      35
    );

    // Waiter #3 queues behind Waiter #2 with a generous timeout
    const writer3Promise = tokenVault.runWithVaultMutex(
      lockFile,
      async () => {
        inFlightCount += 1;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlightCount);
        writer3StartedAfterWriter1Finished = writer1Finished;
        inFlightCount -= 1;
        return 'w3-ok';
      },
      2000
    );

    await expect(writer2Promise).rejects.toThrow(/timed out/i);
    expect(writer2Ran).toBe(false);

    // Give the microtask/timer queue a tick while Writer #1 is STILL active — Writer #3 must NOT have started!
    await new Promise((r) => setTimeout(r, 40));
    expect(writer3StartedAfterWriter1Finished).toBe(false);
    expect(maxObservedConcurrency).toBe(1);

    // Now finish Writer #1 — Writer #3 acquires strictly sequentially afterward
    expect(releaseWriter1).not.toBeNull();
    releaseWriter1!();

    await expect(writer3Promise).resolves.toBe('w3-ok');
    expect(writer3StartedAfterWriter1Finished).toBe(true);
    expect(writer2Ran).toBe(false);
    expect(maxObservedConcurrency).toBe(1);
  });

  it('2c. Rejects unresolved vault directory fail-closed with ERR_VAULT_DIR_UNRESOLVED (never falling back to process.cwd())', () => {
    const prevVitest = process.env.VITEST;
    const prevNodeEnv = process.env.NODE_ENV;
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;

    const cjsOs = nodeRequire('node:os') as typeof os;
    const homedirSpy = vi.spyOn(cjsOs, 'homedir').mockReturnValue('');

    try {
      delete process.env.VITEST;
      delete process.env.NODE_ENV;
      delete process.env.HOME;
      delete process.env.USERPROFILE;

      let caughtErr: (Error & { code?: string }) | null = null;
      try {
        tokenVault.getTokensFilePath({});
      } catch (err) {
        caughtErr = err as Error & { code?: string };
      }

      expect(caughtErr).not.toBeNull();
      expect(caughtErr?.code).toBe('ERR_VAULT_DIR_UNRESOLVED');
      expect(caughtErr?.message).toMatch(/refusing process\.cwd\(\) fallback/i);
    } finally {
      homedirSpy.mockRestore();
      if (prevVitest !== undefined) process.env.VITEST = prevVitest;
      else delete process.env.VITEST;
      if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
      else delete process.env.NODE_ENV;
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
      else delete process.env.USERPROFILE;
    }
  });
});

// ============================================================================
// 3. Diagnostic Redaction (`electron/utils/diagnosticLogger.cjs`)
// ============================================================================

describe('3. Diagnostic Redaction (electron/utils/diagnosticLogger.cjs)', () => {
  it('3a. Redacts nested escaped JSON, camelCase secrets, raw JWTs, WLID/XBL auth, and Steam API keys while preserving timestamps and line numbers', () => {
    const syntheticJwt = [
      'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiJzeW50aF91c2VyXzAxIn0',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.');

    const rawLine = [
      '[2026-11-21T08:35:00.123Z] [WARN] at launcherEngine.cjs:412:19 pid=48210 status=401',
      'escaped={"inner":"{\\"access_token\\":\\"SECRET_ESC_1\\",\\\\\\"refresh_token\\\\\\":\\\\\\"SECRET_ESC_2\\\\\\"}"}',
      'camel={"accessToken":"SECRET_CAMEL_ACC","webToken":"SECRET_CAMEL_WEB","xstsToken":"SECRET_CAMEL_XSTS"}',
      `jwt=${syntheticJwt}`,
      'xboxAuth="XBL3.0 x=998877665544;SECRET_XBL_PAYLOAD"',
      'storeAuth="WLID1.0=SECRET_WLID_TICKET_PAYLOAD"',
      'steamUrl="https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=STEAM_SECRET_API_KEY_999&format=json"',
    ].join(' ');

    const redacted = diagnosticLogger.redactSensitiveDiagnosticText(rawLine);

    // Secrets MUST be completely scrubbed
    for (const secret of [
      'SECRET_ESC_1',
      'SECRET_ESC_2',
      'SECRET_CAMEL_ACC',
      'SECRET_CAMEL_WEB',
      'SECRET_CAMEL_XSTS',
      syntheticJwt,
      'SECRET_XBL_PAYLOAD',
      'SECRET_WLID_TICKET_PAYLOAD',
      'STEAM_SECRET_API_KEY_999',
    ]) {
      expect(redacted).not.toContain(secret);
    }

    // Structural markers & normal telemetry MUST be preserved
    expect(redacted).toContain('2026-11-21T08:35:00.123Z');
    expect(redacted).toContain('launcherEngine.cjs:412:19');
    expect(redacted).toContain('pid=48210');
    expect(redacted).toContain('status=401');
    expect(redacted).toContain('XBL3.0 x=[REDACTED]');
    expect(redacted).toContain('WLID1.0=[REDACTED]');
    expect(redacted).toContain('?key=[REDACTED]');
    expect(redacted).toContain('&format=json');
  });
});

// ============================================================================
// 4. Uninstall Safety, Security Utils & Process Tree
// ============================================================================

describe('4. Uninstall Safety, Security Utils & Process Tree', () => {
  it('4a. validateManagedSentinelContent rejects 0-byte/invalid sentinels and accepts valid schema sentinels', () => {
    expect(uninstallSafety.validateManagedSentinelContent('')).toBe(false);
    expect(uninstallSafety.validateManagedSentinelContent('   \n  ')).toBe(false);
    expect(uninstallSafety.validateManagedSentinelContent('{}')).toBe(false);
    expect(uninstallSafety.validateManagedSentinelContent('not-json')).toBe(false);
    expect(
      uninstallSafety.validateManagedSentinelContent(
        JSON.stringify({ schemaVersion: 0, store: 'gog', installKind: 'direct' })
      )
    ).toBe(false);
    expect(
      uninstallSafety.validateManagedSentinelContent(
        JSON.stringify({ schemaVersion: 1, store: 'gog', createdAt: 'not-a-date' })
      )
    ).toBe(false);
    expect(
      uninstallSafety.validateManagedSentinelContent(
        JSON.stringify({ schemaVersion: 1, store: 'gog', installKind: 'x'.repeat(9000) })
      )
    ).toBe(false);

    expect(
      uninstallSafety.validateManagedSentinelContent(
        JSON.stringify({
          schemaVersion: 1,
          store: 'gog',
          installKind: 'direct',
          createdAt: '2026-11-21T08:00:00.000Z',
        })
      )
    ).toBe(true);
    expect(
      uninstallSafety.validateManagedSentinelContent(
        JSON.stringify({
          managedBy: 'one-launcher',
          createdAt: '2026-11-21T08:00:00.000Z',
        })
      )
    ).toBe(true);

    // Behavioral disk verification: a 0-byte `.one_launcher_managed` file inside a protected
    // Steam non-common path must NOT bypass containment in `isSafeToDeleteInstallPath`
    const sandbox = createSandboxDir('ol-r4-sentinel-');
    const steamNonCommonDir = path.join(sandbox, 'SteamLibrary', 'steamapps', 'custom_folder');
    fs.mkdirSync(steamNonCommonDir, { recursive: true });
    fs.writeFileSync(path.join(steamNonCommonDir, '.one_launcher_managed'), '', 'utf8');
    expect(
      uninstallSafety.isSafeToDeleteInstallPath(steamNonCommonDir, {
        homedir: path.join(sandbox, 'home'),
        tmpdir: path.join(sandbox, 'tmp'),
      })
    ).toBe(false);

    // Replacing with a valid schema sentinel allows the managed directory
    fs.writeFileSync(
      path.join(steamNonCommonDir, '.one_launcher_managed'),
      JSON.stringify({ schemaVersion: 1, store: 'steam', createdAt: '2026-11-21T08:00:00.000Z' }),
      'utf8'
    );
    expect(
      uninstallSafety.isSafeToDeleteInstallPath(steamNonCommonDir, {
        homedir: path.join(sandbox, 'home'),
        tmpdir: path.join(sandbox, 'tmp'),
      })
    ).toBe(true);
  });

  it('4b. isContainedWithinRoot allows legitimate ..config child names while blocking ../ escapes', () => {
    expect(
      securityUtils.isContainedWithinRoot('/Games/MyTitle', '/Games/MyTitle/..config', 'darwin')
    ).toBe(true);
    expect(
      securityUtils.isContainedWithinRoot(
        '/Games/MyTitle',
        '/Games/MyTitle/..metadata/save.dat',
        'darwin'
      )
    ).toBe(true);
    expect(
      securityUtils.isContainedWithinRoot('C:\\Games\\MyTitle', 'C:\\Games\\MyTitle\\..config', 'win32')
    ).toBe(true);

    expect(
      securityUtils.isContainedWithinRoot('/Games/MyTitle', '/Games/MyTitle/../Secret', 'darwin')
    ).toBe(false);
    expect(
      securityUtils.isContainedWithinRoot('/Games/MyTitle', '/Games/MyTitle/..', 'darwin')
    ).toBe(false);
    expect(
      securityUtils.isContainedWithinRoot(
        'C:\\Games\\MyTitle',
        'C:\\Games\\MyTitle\\..\\Secret',
        'win32'
      )
    ).toBe(false);
    expect(
      securityUtils.isContainedWithinRoot('C:\\Games\\MyTitle', 'D:\\Games\\MyTitle\\bin', 'win32')
    ).toBe(false);
    expect(
      securityUtils.isContainedWithinRoot(
        'C:\\Games\\MyTitle',
        '\\\\?\\C:\\Games\\MyTitle\\..\\Windows',
        'win32'
      )
    ).toBe(false);
  });

  it('4c. isTrustedAppRendererUrl blocks single/double-encoded %2e%2e file:// traversal and isTrustedIpcSenderEvent fails closed on senderFrame === null', () => {
    const expectedHref = 'file:///Applications/OneLauncher/dist/index.html';

    expect(
      securityUtils.isTrustedAppRendererUrl(expectedHref, {
        isPackaged: true,
        expectedFileHref: expectedHref,
      })
    ).toBe(true);

    // Single-encoded, double-encoded, backslash-encoded, and NUL-encoded traversal attempts
    // Single-encoded `%2e%2e` is canonicalized by WHATWG URL outside `dist/` and blocked by `expectedFileHref`
    const anchoredTraversalUrls = [
      'file:///Applications/OneLauncher/dist/%2e%2e/secret.json',
      'file:///Applications/OneLauncher/dist/%252e%252e/secret.json',
      'file:///Applications/OneLauncher/dist/%25252e%25252e/secret.json',
      'file:///Applications/OneLauncher/dist/..%5csecret.json',
      'file:///Applications/OneLauncher/dist/index.html%00.txt',
      'https://evil.example.invalid/index.html',
    ];
    for (const badUrl of anchoredTraversalUrls) {
      expect(
        securityUtils.isTrustedAppRendererUrl(badUrl, {
          isPackaged: true,
          expectedFileHref: expectedHref,
        })
      ).toBe(false);
    }

    // Double/triple-encoded, backslash-escaped, NUL-encoded, and external URLs MUST also fail closed even without `expectedFileHref`
    for (const unanchoredBadUrl of [
      'file:///Applications/OneLauncher/dist/%252e%252e/secret.json',
      'file:///Applications/OneLauncher/dist/%25252e%25252e/secret.json',
      'file:///Applications/OneLauncher/dist/..%5csecret.json',
      'file:///Applications/OneLauncher/dist/index.html%00.txt',
      'https://evil.example.invalid/index.html',
    ]) {
      expect(securityUtils.isTrustedAppRendererUrl(unanchoredBadUrl, { isPackaged: true })).toBe(
        false
      );
    }

    // IPC sender frame fail-closed on explicit `senderFrame === null` (detached/destroyed Electron subframe)
    expect(
      securityUtils.isTrustedIpcSenderEvent({ senderFrame: null, sender: {} }, { isPackaged: true })
    ).toBe(false);
    expect(() =>
      securityUtils.assertTrustedIpcSender(
        { senderFrame: null, sender: {} },
        { isPackaged: true, channel: 'launcher:test' }
      )
    ).toThrow(/Blocked IPC invocation/);

    // Subframe mismatch fails closed; matching top-level mainFrame succeeds
    const mainFrame = { url: expectedHref, parent: null, routingId: 1 };
    const subFrame = { url: expectedHref, parent: mainFrame, routingId: 2 };
    expect(
      securityUtils.isTrustedIpcSenderEvent(
        { senderFrame: subFrame, sender: { mainFrame } },
        { isPackaged: true, expectedFileHref: expectedHref }
      )
    ).toBe(false);
    expect(
      securityUtils.isTrustedIpcSenderEvent(
        { senderFrame: mainFrame, sender: { mainFrame } },
        { isPackaged: true, expectedFileHref: expectedHref }
      )
    ).toBe(true);
  });

  it('4d. processTreeUtils anchored POSIX PID parsing avoids false-matching numeric CLI args and substrings', () => {
    const psOutput = [
      '  101 /bin/ps -ax -o pid=,command=',
      ' 2048 /usr/bin/openjdk --port 99999 --pid 55555 --game-id 12345',
      ' 3099 /usr/local/bin/helper --child-pid 88888 --jk-flag 77777',
      ' 4120 /opt/games/bin/jk --server-port 60000 --worker-pid 91111',
    ].join('\n');

    // Must match PID 4120 (anchored leading PID), NOT 2048 (`openjdk`), NOT 3099 (`--jk-flag`), and NOT any numeric CLI arg!
    expect(processTreeUtils.extractMatchedPidFromProcessOutput(psOutput, ['jk'], 'darwin')).toBe(
      4120
    );
    expect(
      processTreeUtils.extractMatchedPidFromProcessOutput(
        ' 7321 1000 /opt/runner/game.exe --parent 44444 --port 8080',
        ['game.exe'],
        'darwin'
      )
    ).toBe(7321);
    expect(
      processTreeUtils.extractMatchedPidFromProcessOutput(
        ' 7321 /opt/runner/other --arg 99999',
        ['99999'],
        'darwin'
      )
    ).toBe(7321); // Still returns anchored PID 7321, never 99999

    const psTree = [
      '  500    1',
      '  501  500',
      '  502  501',
      '  600  999 --extra-numeric 500', // Malformed trailing tokens ignored by strict /^\s*(\d+)\s+(\d+)\s*$/
    ].join('\n');
    expect(processTreeUtils.collectPosixDescendantPids(psTree, 500)).toEqual([501, 502]);
  });
});

// ============================================================================
// 5. Xbox Security & Merkle Hardening
// ============================================================================

describe('5. Xbox Security & Merkle Hardening', () => {
  it('5a. NSAL routing & getTokenAndSignatureForUrl reject http: and unrecognized https: hosts fail-closed (never falling back to http://xboxlive.com)', async () => {
    // 1. Built-in NSAL URL->RP router rejects http:, non-443 ports, credentials, raw IPs, and unrecognized https: hosts
    expect(xboxAuthManager.resolveBuiltInRelyingPartyForUrl('http://xboxlive.com/users/me')).toBeNull();
    expect(
      xboxAuthManager.resolveBuiltInRelyingPartyForUrl('http://titlestorage.xboxlive.com/connectedstorage')
    ).toBeNull();
    expect(
      xboxAuthManager.resolveBuiltInRelyingPartyForUrl('https://evil.example.invalid/steal-token')
    ).toBeNull();
    expect(
      xboxAuthManager.resolveBuiltInRelyingPartyForUrl('https://user.auth.xboxlive.com:8443/user/auth')
    ).toBeNull();
    expect(
      xboxAuthManager.resolveBuiltInRelyingPartyForUrl('https://user:pass@xboxlive.com/profile')
    ).toBeNull();
    expect(xboxAuthManager.resolveBuiltInRelyingPartyForUrl('https://203.0.113.10/api')).toBeNull();

    // Official HTTPS Xbox Live & PlayFab hosts still resolve their canonical Relying Parties
    expect(
      xboxAuthManager.resolveBuiltInRelyingPartyForUrl('https://titlestorage.xboxlive.com/connectedstorage')
    ).toBe(xboxAuthManager.XSTS_RELYING_PARTIES.XBOX_LIVE);
    expect(
      xboxAuthManager.resolveBuiltInRelyingPartyForUrl('https://title123.playfabapi.com/Client/LoginWithXbox')
    ).toBe(xboxAuthManager.XSTS_RELYING_PARTIES.PLAYFAB);

    // Catch-all `*` wildcard and `http` downgrade dynamic NSAL rules are rejected
    expect(
      xboxAuthManager.matchDynamicTitleEndpointRelyingParty('https://evil.example.invalid/api', [
        { Host: '*', Protocol: 'https', RelyingParty: 'http://xboxlive.com' },
        { Host: '*.invalid', Protocol: 'https', RelyingParty: 'http://xboxlive.com' },
      ])
    ).toBeNull();
    expect(
      xboxAuthManager.matchDynamicTitleEndpointRelyingParty('https://api.studio.example/v1', [
        { Host: 'api.studio.example', Protocol: 'http', RelyingParty: 'https://rp.studio.example' },
      ])
    ).toBeNull();

    // 2. End-to-end provider `getTokenAndSignatureForUrl` invoking internal `resolveRelyingPartyForTargetUrl`
    const sandbox = createSandboxDir('ol-r4-xbox-nsal-');
    const proof = xboxAuthManager.generateXboxProofKeyPair();
    const futureIso = new Date(Date.now() + 3600 * 1000).toISOString();
    const fakeVault = {
      loadSavedTokensAsync: async () => ({
        xbox: {
          xuid: '2533274790395904',
          uhs: '1234567890',
          xstsXboxLiveToken: 'synth_xsts_live_token',
          xstsXboxLiveNotAfter: futureIso,
          xblUserToken: 'synth_user_token',
          xblUserNotAfter: futureIso,
          proofPrivateKeyPem: proof.privateKeyPem,
          proofPublicKeyPem: proof.publicKeyPem,
          proofKeyJwk: proof.proofKeyJwk,
        },
      }),
      saveTokensAsync: async () => {},
      onVaultChange: () => () => {},
    };
    const requestedUrls: string[] = [];
    const provider = xboxAuthManager.createXboxAuthProvider({
      userDataDir: sandbox,
      tokenVault: fakeVault,
      fetchImpl: vi.fn(async (input: string | URL | Request) => {
        const reqUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        requestedUrls.push(reqUrl);
        return new Response(JSON.stringify({ EndPoints: [] }), { status: 200 });
      }),
    });

    try {
      // Non-HTTPS URLs rejected upfront with XBOX_NSAL_UNTRUSTED_TARGET_URL (never touches network or mints XSTS)
      await expect(
        provider.getTokenAndSignatureForUrl({ method: 'GET', url: 'http://xboxlive.com/users/me' })
      ).rejects.toMatchObject({ code: 'XBOX_NSAL_UNTRUSTED_TARGET_URL' });
      await expect(
        provider.getTokenAndSignatureForUrl({ method: 'GET', url: 'https://203.0.113.10/api' })
      ).rejects.toMatchObject({ code: 'XBOX_NSAL_UNTRUSTED_TARGET_URL' });

      // Unrecognized external HTTPS host rejected fail-closed with XBOX_NSAL_UNRECOGNIZED_HOST
      // (NEVER mints `http://xboxlive.com` XSTS token!)
      await expect(
        provider.getTokenAndSignatureForUrl({
          method: 'GET',
          url: 'https://evil.example.invalid/steal-token',
        })
      ).rejects.toMatchObject({ code: 'XBOX_NSAL_UNRECOGNIZED_HOST' });
      expect(requestedUrls.some((u) => u.includes('xsts.auth.xboxlive.com'))).toBe(false);
    } finally {
      provider.dispose();
    }
  });

  it('5b. Loopback server and formatWgsUserScidFolderName reject traversal scid and invalid Host headers', async () => {
    const validXuid = '2533274790395904';
    const validScid = '00000000-0000-0000-0000-000075300001';

    expect(() => xboxTitleStorageSync.formatWgsUserScidFolderName(validXuid, '../../etc')).toThrow();
    expect(() =>
      xboxTitleStorageSync.formatWgsUserScidFolderName(validXuid, '../Windows/System32')
    ).toThrow();
    expect(() => xboxLoopbackServer.validateSafeScid('../../etc')).toThrow();
    expect(xboxTitleStorageSync.formatWgsUserScidFolderName(validXuid, validScid)).toMatch(
      /^[0-9A-F]{16}_00000000-0000-0000-0000-000075300001$/
    );

    expect(loopbackConnHandler.isValidLoopbackHostHeader('127.0.0.1:45123')).toBe(true);
    expect(loopbackConnHandler.isValidLoopbackHostHeader('localhost:45123')).toBe(true);
    expect(loopbackConnHandler.isValidLoopbackHostHeader('evil.example.invalid:45123')).toBe(false);
    expect(loopbackConnHandler.isValidLoopbackHostHeader('127.0.0.1.evil.invalid')).toBe(false);

    const sandbox = createSandboxDir('ol-r4-loopback-');
    const srv = await xboxLoopbackServer.startXboxRuntimeLoopbackServer({
      saveRootDir: path.join(sandbox, 'SystemAppData'),
      enableCloudSaveSync: false,
      enablePresenceHeartbeat: false,
      userProfile: { xuid: validXuid, gamertag: 'SynthTester' },
      gameMetadata: { scid: validScid, packageFamilyName: 'Synth.Game_8wekyb3d8bbwe' },
    });
    trackedLoopbackServers.push(srv);

    // Invalid Host header (DNS rebinding attempt) -> 403 Forbidden
    const badHostResp = await sendRawTcpRequest(
      srv.host,
      srv.port,
      [
        'POST /rpc HTTP/1.1',
        'Host: attacker.example.invalid:1234',
        `X-One-Launcher-Token: ${srv.sessionKey}`,
        'Content-Length: 2',
        'Connection: close',
        '',
        '{}',
      ].join('\r\n')
    );
    expect(badHostResp).toMatch(/^HTTP\/1\.1 403 Forbidden/);

    // Valid loopback Host + valid token, but traversal SCID in RPC params -> rejected with E_INVALIDARG
    const badScidBody = JSON.stringify({
      id: 7,
      method: 'xgamesave.init',
      params: { scid: '../../etc', xuid: validXuid },
    });
    const badScidResp = await sendRawTcpRequest(
      srv.host,
      srv.port,
      [
        'POST /rpc HTTP/1.1',
        `Host: 127.0.0.1:${srv.port}`,
        `X-One-Launcher-Token: ${srv.sessionKey}`,
        `Content-Length: ${Buffer.byteLength(badScidBody, 'utf8')}`,
        'Connection: close',
        '',
        badScidBody,
      ].join('\r\n')
    );
    expect(badScidResp).toMatch(/^HTTP\/1\.1 200 OK/);
    const rpcPayload = JSON.parse(badScidResp.split('\r\n\r\n')[1] || '{}') as {
      ok?: boolean;
      hr?: number;
      error?: string;
    };
    expect(rpcPayload.ok).toBe(false);
    expect(rpcPayload.hr).toBe(-2147024809); // E_INVALIDARG
    expect(rpcPayload.error).toMatch(/SCID/i);
  });

  it('5c. msixvcXvdParser verifies full multi-level Merkle chain up to topHashBlockHash and enforces Microsoft DO/Xbox CDN allowlist', async () => {
    const PAGE = msixvcXvdParser.XVD_PAGE_SIZE;
    const ENTRIES = msixvcXvdParser.XVD_HASH_ENTRIES_PER_PAGE; // 170
    const ENTRY_SIZE = msixvcXvdParser.XVD_HASH_ENTRY_SIZE; // 24

    // Build a 3-level Merkle tree (L0 -> L1 -> L2 -> topHashBlockHash):
    // 170 * 170 + 1 = 28,901 hashed pages -> level0Pages = 171, level1Pages = 2, level2Pages = 1 (topLevel = 2)
    const totalHashedPages = ENTRIES * ENTRIES + 1;
    const layout = msixvcXvdParser.computeXvdLayout({
      embeddedXvdLength: 0,
      mutablePageCount: 0,
      userDataLength: 0,
      xvcDataLength: 0,
      dynamicHeaderLength: 0,
      driveSize: totalHashedPages * PAGE,
      dataIntegrityDisabled: false,
      resiliencyEnabled: false,
    });
    expect(layout.hashTree.topLevel).toBe(2);
    expect(layout.hashTree.level2Pages).toBe(1);
    expect(layout.hashTree.level1Pages).toBe(2);
    expect(layout.hashTree.level0Pages).toBe(171);

    // Create deterministic target data page at hashedIndex = 170 * 170 = 28900 (L0 page 170 -> L1 page 1 -> L2 page 0)
    const targetHashedIdx = ENTRIES * ENTRIES;
    const targetL0PageIdx = Math.floor(targetHashedIdx / ENTRIES); // 170
    const targetL1PageIdx = Math.floor(targetL0PageIdx / ENTRIES); // 1
    const targetDataPage = Buffer.alloc(PAGE, 0x5a);
    targetDataPage.write('SYNTHETIC_XVD_DATA_PAGE_28900', 0, 'ascii');

    const l0Page = Buffer.alloc(PAGE, 0);
    const l0Hash20 = msixvcXvdParser.computeXvdL0PageHash(targetDataPage, 20);
    l0Hash20.copy(l0Page, 0);
    l0Page.writeUInt32LE(targetHashedIdx, 20);

    const l1Page = Buffer.alloc(PAGE, 0);
    const l0BlockHash24 = msixvcXvdParser.computeXvdHashBlockHash(l0Page, 24);
    l0BlockHash24.copy(l1Page, (targetL0PageIdx % ENTRIES) * ENTRY_SIZE);

    const l2RootPage = Buffer.alloc(PAGE, 0);
    const l1BlockHash24 = msixvcXvdParser.computeXvdHashBlockHash(l1Page, 24);
    l1BlockHash24.copy(l2RootPage, targetL1PageIdx * ENTRY_SIZE);

    const topHashBlockHash = msixvcXvdParser.computeXvdHashBlockHash(l2RootPage, 32);

    const l2ByteOff = layout.hashTree.level2ByteOffset;
    const l1ByteOff = layout.hashTree.level1ByteOffset + targetL1PageIdx * PAGE;
    const l0ByteOff = layout.hashTree.level0ByteOffset + targetL0PageIdx * PAGE;
    const targetPageByteOff = layout.userData.byteOffset + targetHashedIdx * PAGE;

    const makeSparseReader = (pagesByOffset: Map<number, Buffer>): XvdRangeReader => ({
      async getTotalSize() {
        return targetPageByteOff + PAGE;
      },
      async readRange(offset: number, length: number) {
        const out = Buffer.alloc(length, 0);
        for (let pos = 0; pos < length; pos += PAGE) {
          const src = pagesByOffset.get(offset + pos);
          if (src) src.copy(out, pos, 0, Math.min(PAGE, length - pos));
        }
        return out;
      },
    });

    // 1. Authentic 3-level chain passes full verification + caches upper hash blocks
    const validPages = new Map<number, Buffer>([
      [l2ByteOff, Buffer.from(l2RootPage)],
      [l1ByteOff, Buffer.from(l1Page)],
      [l0ByteOff, Buffer.from(l0Page)],
    ]);
    const validReader = makeSparseReader(validPages);
    const verifier = msixvcXvdParser.createXvdHashTreeVerifier({
      rangeReader: validReader,
      layout,
      topHashBlockHash,
    });
    const l0Res = await msixvcXvdParser.readL0EntriesForPages(
      validReader,
      layout,
      targetPageByteOff,
      1,
      { topHashBlockHash, hashTreeVerifier: verifier }
    );
    expect(l0Res.merkleVerified).toBe(true);
    expect(l0Res.dataUnits[0]).toBe(targetHashedIdx);
    expect(verifier.getStats().upperFetches).toBe(2); // L1 + L2 fetched once
    expect(
      msixvcXvdParser.verifyXvdContiguousPagesL0(targetDataPage, l0Res.hashes, {
        firstPageByteOffset: targetPageByteOff,
        topHashBlockHash,
      })
    ).toBe(true);

    // 2. Tampering an upper L1 hash entry fails closed (L1->L2 mismatch)
    const tamperedL1 = Buffer.from(l1Page);
    tamperedL1[0] ^= 0x01;
    const readerTamperedL1 = makeSparseReader(
      new Map<number, Buffer>([
        [l2ByteOff, Buffer.from(l2RootPage)],
        [l1ByteOff, tamperedL1],
        [l0ByteOff, Buffer.from(l0Page)],
      ])
    );
    await expect(
      msixvcXvdParser.readL0EntriesForPages(readerTamperedL1, layout, targetPageByteOff, 1, {
        topHashBlockHash,
      })
    ).rejects.toThrow(/L1->L2 SHA-256 integrity check failed/i);

    // 3. Tampering the L2 root hash page fails closed against `topHashBlockHash`
    const tamperedL2 = Buffer.from(l2RootPage);
    tamperedL2[ENTRY_SIZE] ^= 0x80;
    const readerTamperedL2 = makeSparseReader(
      new Map<number, Buffer>([
        [l2ByteOff, tamperedL2],
        [l1ByteOff, Buffer.from(l1Page)],
        [l0ByteOff, Buffer.from(l0Page)],
      ])
    );
    await expect(
      msixvcXvdParser.readL0EntriesForPages(readerTamperedL2, layout, targetPageByteOff, 1, {
        topHashBlockHash,
      })
    ).rejects.toThrow(/topHashBlockHash/i);

    // 4. Tampering an L0 hash page fails closed (L0->L1 mismatch)
    const tamperedL0 = Buffer.from(l0Page);
    tamperedL0[3] ^= 0xff;
    const readerTamperedL0 = makeSparseReader(
      new Map<number, Buffer>([
        [l2ByteOff, Buffer.from(l2RootPage)],
        [l1ByteOff, Buffer.from(l1Page)],
        [l0ByteOff, tamperedL0],
      ])
    );
    await expect(
      msixvcXvdParser.readL0EntriesForPages(readerTamperedL0, layout, targetPageByteOff, 1, {
        topHashBlockHash,
      })
    ).rejects.toThrow(/L0->L1 SHA-256 integrity check failed/i);

    // 5. Tampering the L0 data page itself throws on `verifyXvdContiguousPagesL0`
    const tamperedDataPage = Buffer.from(targetDataPage);
    tamperedDataPage[12] ^= 0x40;
    expect(() =>
      msixvcXvdParser.verifyXvdContiguousPagesL0(tamperedDataPage, l0Res.hashes, {
        firstPageByteOffset: targetPageByteOff,
        topHashBlockHash,
      })
    ).toThrow(/L0 SHA-256 page integrity check failed/i);

    // 6. Microsoft Delivery Optimization / Xbox CDN allowlist enforcement on range readers
    expect(
      msixvcXvdParser.validateXvdCdnUrl('https://assets1.xboxlive.com/Z/pkg.msixvc', {
        allowLocalhost: false,
      })
    ).toBe('https://assets1.xboxlive.com/Z/pkg.msixvc');
    expect(
      msixvcXvdParser.validateXvdCdnUrl('http://tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/abc', {
        allowLocalhost: false,
      })
    ).toBe('http://tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/abc');

    const blockedUrls = [
      'https://evil.example.invalid/game.msixvc',
      'http://evil.example.invalid/game.msixvc',
      'http://cdn.microsoft.com/game.msixvc', // Non-DO plaintext HTTP rejected
      'https://assets1.xboxlive.com:8443/game.msixvc',
      'https://user:pass@assets1.xboxlive.com/game.msixvc',
      'http://127.0.0.1:9999/game.msixvc',
    ];
    for (const badUrl of blockedUrls) {
      expect(() => msixvcXvdParser.validateXvdCdnUrl(badUrl, { allowLocalhost: false })).toThrow();
      expect(() =>
        msixvcXvdParser.createHttpRangeReader({ urls: [badUrl], allowLocalhost: false })
      ).toThrow();
    }

    // Redirect hop to untrusted domain MUST also be blocked by `fetchRange`
    const mockRedirectFetch = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://untrusted-redirect.example.invalid/payload.bin' },
      });
    });
    await expect(
      msixvcXvdParser.fetchRange('https://assets1.xboxlive.com/Z/pkg.msixvc', 0, 15, {
        fetchImpl: mockRedirectFetch,
        allowLocalhost: false,
      })
    ).rejects.toThrow(/Blocked untrusted XVD\/FE3 CDN host/i);
  });

  it('5d. windowsXboxAppxAndMsixvcOrchestrator passes $env:OL_IDENTITY/$env:OL_PFN with zero interpolation and rejects wildcard * identities', async () => {
    const calls: Array<{ file: string; args: string[]; env: Record<string, string | undefined> }> = [];
    const mockExecFile = vi.fn(
      (
        file: string,
        args: string[],
        opts: { env?: Record<string, string | undefined> },
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        calls.push({ file, args, env: opts?.env || {} });
        if (calls.length === 1) {
          // Query call returns matching package JSON
          cb(
            null,
            JSON.stringify({
              Name: 'SynthStudio.SpaceGame',
              PackageFamilyName: 'SynthStudio.SpaceGame_8wekyb3d8bbwe',
              PackageFullName: 'SynthStudio.SpaceGame_1.0.0.0_x64__8wekyb3d8bbwe',
              InstallLocation: 'C:\\XboxGames\\SpaceGame',
              Status: 'Ok',
            }),
            ''
          );
        } else {
          // Remove / post-check calls return empty stdout
          cb(null, '', '');
        }
      }
    );

    // Wildcard `*` and shell-injection identity names MUST be rejected BEFORE spawning PowerShell
    for (const badIdentity of ['*', 'Microsoft.*', 'App*Name', "Game'; Start-Process calc; '", '../evil']) {
      const qBad = await windowsXboxOrchestrator.queryTargetedAppxPackageAsync(
        { identityName: badIdentity },
        { execFileImpl: mockExecFile }
      );
      expect(qBad.found).toBe(false);
      expect(qBad.error).toBe('invalid_identity_name');

      const rBad = await windowsXboxOrchestrator.removeTargetedAppxPackageVerifiedAsync(
        { identityName: badIdentity },
        { execFileImpl: mockExecFile }
      );
      expect(rBad.removed).toBe(false);
      expect(rBad.error).toMatch(/Invalid Appx IdentityName/i);
    }
    expect(mockExecFile).not.toHaveBeenCalled();

    // Valid identity + PFN uses static `$env:OL_IDENTITY` / `$env:OL_PFN` script with zero interpolation
    const validIdentity = 'SynthStudio.SpaceGame';
    const validPfn = 'SynthStudio.SpaceGame_8wekyb3d8bbwe';
    const queryRes = await windowsXboxOrchestrator.queryTargetedAppxPackageAsync(
      { identityName: validIdentity, packageFamilyName: validPfn },
      { execFileImpl: mockExecFile }
    );
    expect(queryRes.found).toBe(true);
    expect(calls).toHaveLength(1);
    const queryCmd = calls[0].args[calls[0].args.indexOf('-Command') + 1];
    expect(queryCmd).toContain('$env:OL_IDENTITY');
    expect(queryCmd).toContain('$env:OL_PFN');
    expect(queryCmd).not.toContain(validIdentity);
    expect(queryCmd).not.toContain(validPfn);
    expect(calls[0].env.OL_IDENTITY).toBe(validIdentity);
    expect(calls[0].env.OL_PFN).toBe(validPfn);

    const removeRes = await windowsXboxOrchestrator.removeTargetedAppxPackageVerifiedAsync(
      { identityName: validIdentity, packageFamilyName: validPfn },
      { execFileImpl: mockExecFile }
    );
    expect(removeRes.removed).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(3); // 1 prior query + remove + post-check query
    const removeCmd = calls[1].args[calls[1].args.indexOf('-Command') + 1];
    expect(removeCmd).toContain('$env:OL_IDENTITY');
    expect(removeCmd).toContain('$env:OL_PFN');
    expect(removeCmd).not.toContain(validIdentity);
    expect(removeCmd).not.toContain(validPfn);
    expect(calls[1].env.OL_IDENTITY).toBe(validIdentity);
    expect(calls[1].env.OL_PFN).toBe(validPfn);
  });
});

// ============================================================================
// 6. GOG Script, Cloud Save, Downloads, Offline Vault, Barrier, Inspectors & Native Binaries
// ============================================================================

describe('6. GOG Script, Cloud Save, Downloads, Offline Vault, Readiness Barrier & Native Binaries', () => {
  it('6a. gogScriptInterpreter blocks dangerous registry subkeys (Run, IFEO, Winlogon) and \\r\\n[] INI/registry injection', async () => {
    expect(
      gogScriptInterpreter.isAllowedGogRegistryTarget(
        'HKCU',
        'Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      ).allowed
    ).toBe(false);
    expect(
      gogScriptInterpreter.isAllowedGogRegistryTarget(
        'HKLM',
        'Software\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\game.exe'
      ).allowed
    ).toBe(false);
    expect(
      gogScriptInterpreter.isAllowedGogRegistryTarget(
        'HKLM',
        'Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
      ).allowed
    ).toBe(false);
    expect(
      gogScriptInterpreter.isAllowedGogRegistryTarget(
        'HKLM',
        'Software\\GOG.com\\Games\\12345]\r\n[Software\\Evil'
      ).allowed
    ).toBe(false);
    expect(
      gogScriptInterpreter.isAllowedGogRegistryTarget('HKLM', 'Software\\GOG.com\\Games\\12345')
        .allowed
    ).toBe(true);

    // End-to-end sandbox execution verifying malicious actions are skipped while safe ones succeed
    const sandbox = createSandboxDir('ol-r4-gog-script-');
    const gameDir = path.join(sandbox, 'GameInstall');
    const bottleDir = path.join(sandbox, 'Bottle');
    fs.mkdirSync(gameDir, { recursive: true });
    fs.mkdirSync(bottleDir, { recursive: true });
    fs.writeFileSync(path.join(bottleDir, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
    fs.writeFileSync(path.join(bottleDir, 'user.reg'), 'WINE REGISTRY Version 2\n', 'utf8');

    const scriptJson = {
      actions: [
        {
          install: {
            action: 'setRegistry',
            arguments: {
              root: 'HKCU',
              subkey: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run',
              valueName: 'Backdoor',
              valueData: 'evil.exe',
            },
          },
        },
        {
          install: {
            action: 'setRegistry',
            arguments: {
              root: 'HKLM',
              subkey: 'Software\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\calc.exe',
              valueName: 'Debugger',
              valueData: 'evil.exe',
            },
          },
        },
        {
          install: {
            action: 'setRegistry',
            arguments: {
              root: 'HKLM',
              subkey: 'Software\\GOG.com\\Games\\90001',
              valueName: 'Injected',
              valueData: 'ok\r\n[Software\\\\InjectedSection]',
            },
          },
        },
        {
          install: {
            action: 'setRegistry',
            arguments: {
              root: 'HKLM',
              subkey: 'Software\\GOG.com\\Games\\90001',
              valueName: 'InstallPath',
              valueData: '{app}',
            },
          },
        },
        {
          install: {
            action: 'iniFile',
            arguments: {
              file: 'game.ini',
              section: 'Graphics]\r\n[Injected',
              key: 'Fullscreen',
              value: '1',
            },
          },
        },
        {
          install: {
            action: 'iniFile',
            arguments: {
              file: 'game.ini',
              section: 'Graphics',
              key: 'Width',
              value: '1920\nInjectedKey=1',
            },
          },
        },
        {
          install: {
            action: 'iniFile',
            arguments: {
              file: 'game.ini',
              section: 'Graphics',
              key: 'SafeWidth',
              value: '1920',
            },
          },
        },
      ],
    };
    fs.writeFileSync(
      path.join(gameDir, 'goggame-90001.script'),
      JSON.stringify(scriptJson, null, 2),
      'utf8'
    );

    const res = await gogScriptInterpreter.executeGogGameScript(gameDir, {
      platform: 'darwin',
      bottleDir,
      skipLiveWineRegSync: true,
    });

    expect(res.scriptsProcessed).toBe(1);
    expect(res.iniEntriesApplied).toBe(1);

    const iniContent = fs.readFileSync(path.join(gameDir, 'game.ini'), 'utf8');
    expect(iniContent).toContain('SafeWidth=1920');
    expect(iniContent).not.toContain('Injected');

    const sysRegContent = fs.readFileSync(path.join(bottleDir, 'system.reg'), 'utf8');
    const userRegContent = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
    expect(sysRegContent).toContain('90001');
    expect(sysRegContent).not.toContain('Image File Execution Options');
    expect(sysRegContent).not.toContain('InjectedSection');
    expect(userRegContent).not.toContain('Backdoor');
  });

  it('6b. cloudSaveEngine inspectOneDrivePlaceholderStateAsync passes OL_ONEDRIVE_TARGET via env safely with Unicode quotes', async () => {
    const sandbox = createSandboxDir('ol-r4-onedrive-');
    const unicodeSaveDir = path.join(
      sandbox,
      'OneDrive',
      'Documents',
      'Baldur\u2019s Gate \u2018Save\u2019 Slot'
    );
    fs.mkdirSync(unicodeSaveDir, { recursive: true });
    const saveFile = path.join(unicodeSaveDir, 'profile.sav');
    fs.writeFileSync(saveFile, 'synth-save-data', 'utf8');

    const captured: { args?: string[]; env?: Record<string, string | undefined> } = {};
    const mockPsExec = vi.fn(
      (
        _file: string,
        args: string[],
        opts: { env?: Record<string, string | undefined> },
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        captured.args = args;
        captured.env = opts?.env;
        cb(null, `${saveFile}\r\n`, '');
      }
    );

    const state = await cloudSaveEngine.inspectOneDrivePlaceholderStateAsync(unicodeSaveDir, {
      platform: 'win32',
      oneDriveAttribExecImpl: mockPsExec,
    });

    expect(mockPsExec).toHaveBeenCalledTimes(1);
    const psCmd = captured.args?.[captured.args.indexOf('-Command') + 1] || '';
    expect(psCmd).toContain('$env:OL_ONEDRIVE_TARGET');
    expect(psCmd).not.toContain('\u2018');
    expect(psCmd).not.toContain('\u2019');
    expect(psCmd).not.toContain('Baldur');
    expect(captured.env?.OL_ONEDRIVE_TARGET).toBe(unicodeSaveDir);
    expect(state.hasPlaceholders).toBe(true);
    expect(state.blockedBroadRoot).toBe(false);
    expect(state.placeholderFiles).toContain(saveFile);

    // Broad root OneDrive\Documents is refused without spawning PowerShell
    const broadRoot = await cloudSaveEngine.inspectOneDrivePlaceholderStateAsync(
      path.join(sandbox, 'OneDrive', 'Documents'),
      { platform: 'win32', oneDriveAttribExecImpl: mockPsExec }
    );
    expect(broadRoot.blockedBroadRoot).toBe(true);
    expect(mockPsExec).toHaveBeenCalledTimes(1);
  });

  it('6c. downloadQueueCoordinator gracefulShutdownDownloads preserves pausedByUser=true/cancelRequested=false and emits distinct statusMessage transitions immediately', async () => {
    const sandbox = createSandboxDir('ol-r4-dl-');
    const emittedMessages: string[] = [];
    const unsub = engineStateRegistry.onDownloadUpdated((payload) => {
      if (payload?.task && typeof payload.task.statusMessage === 'string') {
        emittedMessages.push(payload.task.statusMessage);
      }
    });
    trackedUnsubscribers.push(unsub);

    const taskId = 'dl-r4-status-test';
    const abortCtrl = new AbortController();
    const downloadCtrl: Record<string, unknown> = {
      type: 'abort',
      controller: abortCtrl,
      pausedByUser: false,
      cancelRequested: false,
    };

    engineStateRegistry.downloadQueueMap.set(taskId, {
      taskId,
      gameId: 'xbox-synth-1',
      title: 'Synthetic Game',
      platformId: 'xbox',
      platformGameId: '9N0000000001',
      installDir: sandbox,
      status: 'downloading',
      progressPercent: 10,
      bytesDownloaded: 1000,
      totalBytes: 10000,
      statusMessage: 'Preparing download...',
      _persistedUserDataDir: sandbox,
    });
    engineStateRegistry.downloadControllers.set(taskId, downloadCtrl);

    // Emit two distinct `statusMessage` transitions back-to-back under a long throttle window (5000ms)
    // and identical `progressPercent` — BOTH must fire immediately without throttling loss!
    downloadCoordinator.updateDownloadTask(
      taskId,
      { progressPercent: 10, statusMessage: 'Allocating container...' },
      { broadcastThrottleMs: 5000, userDataDir: sandbox }
    );
    downloadCoordinator.updateDownloadTask(
      taskId,
      { progressPercent: 10, statusMessage: 'Streaming encrypted chunks...' },
      { broadcastThrottleMs: 5000, userDataDir: sandbox }
    );

    expect(emittedMessages).toContain('Allocating container...');
    expect(emittedMessages).toContain('Streaming encrypted chunks...');

    // Graceful shutdown MUST pause cleanly (isPause: true), preserving pausedByUser === true & cancelRequested === false
    await downloadCoordinator.gracefulShutdownDownloads(1500, { userDataDir: sandbox });

    expect(downloadCtrl.pausedByUser).toBe(true);
    expect(downloadCtrl.cancelRequested).toBe(false);
    expect(abortCtrl.signal.aborted).toBe(true);

    const finalTask = engineStateRegistry.downloadQueueMap.get(taskId);
    expect(finalTask?.status).toBe('paused');
    expect(finalTask?.statusMessage).toBe('Paused on exit');
    expect(emittedMessages).toContain('Paused on exit');
  });

  it('6d. offlineVaultService reuses VaultStatementCache, forwards all 13 platform sanitization fields, and ranks untagged Metacritic /user-reviews/ as Rank 1/2 (never Rank 4)', () => {
    const sandbox = createSandboxDir('ol-r4-vault-sql-');
    const vault = new offlineVaultMod.OfflineVaultService({
      userDataDir: sandbox,
      disableAutoStartupSweep: true,
    }).init();
    trackedVaults.push(vault);

    const sampleGame = {
      id: 'xbox-9N0000000042',
      title: 'Synthetic AntiCheat Title',
      platform: 'xbox',
      xboxProductId: '9N0000000042',
      chainedLauncherHandoff: 'ea',
      externalStorefrontHandoff: 'ea',
      externalLauncher: 'EA App',
      externalLauncherUrl: 'https://www.ea.com/ea-app',
      isExternalLauncherStubPackage: true,
      xboxBottleCompatibilityReason: 'Requires EA App Windows launcher',
      maxDownloadSizeBytes: 42_000_000_000,
      pcMaxInstallSizeBytes: 58_000_000_000,
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'EA Javelin',
      drmNotice: 'EA app software installation and background use required',
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9N0000000042',
          storefrontAppId: '9N0000000042',
        },
      ],
      enrichedMetadata: {
        shortDescription: 'Synthetic game synopsis for R4 hardening verification.',
        metadataQuality: 'storefront_native',
        enrichedSource: 'xbox',
        drmNotice: 'EA app software installation and background use required',
      },
    };

    // Warm up statements on first upsert + detail fetch
    vault.upsertGames([sampleGame]);
    const detail1 = vault.getGameDetail('xbox-9N0000000042');
    expect(detail1).not.toBeNull();
    expect(vault.stmtCache).not.toBeNull();
    const warmedCacheSize = vault.stmtCache!.size;
    expect(warmedCacheSize).toBeGreaterThan(0);

    // Spy on `vault.db.prepare`: repeated `upsertGames` and `getGameDetail` MUST hit cached statements (0 new prepares)
    const prepareSpy = vi.spyOn(vault.db!, 'prepare');
    for (let i = 0; i < 5; i += 1) {
      vault.upsertGames([
        {
          ...sampleGame,
          title: `Synthetic AntiCheat Title v${i}`,
        },
      ]);
      expect(vault.getGameDetail('xbox-9N0000000042')).not.toBeNull();
    }
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(vault.stmtCache!.size).toBe(warmedCacheSize);

    // Verify all 13 platform sanitization fields (including the 8 previously dropped anti-cheat/launcher/size fields)
    // were forwarded and persisted on the platform entry returned by `getCatalogSnapshot`
    const snapshot = vault.getCatalogSnapshot();
    const persisted = (snapshot.games || []).find((g) => g.id === 'xbox-9N0000000042');
    expect(persisted).toBeDefined();
    const plat = (persisted?.platforms as Array<Record<string, unknown>>)?.[0];
    expect(plat).toBeDefined();
    expect(plat?.chainedLauncherHandoff).toBe('ea');
    expect(plat?.externalStorefrontHandoff).toBe('ea');
    expect(plat?.isExternalLauncherStubPackage).toBe(true);
    expect(plat?.externalLauncher).toBe('EA App');
    expect(plat?.externalLauncherUrl).toBe('https://www.ea.com/ea-app');
    expect(plat?.xboxBottleCompatibilityReason).toBe('Requires EA App Windows launcher');
    expect(plat?.maxDownloadSizeBytes).toBe(42_000_000_000);
    expect(plat?.pcMaxInstallSizeBytes).toBe(58_000_000_000);
    expect(plat?.requiresKernelAntiCheat).toBe(true);
    expect(plat?.kernelAntiCheatName).toBe('EA Javelin');

    // Untagged Metacritic `/user-reviews/` URLs MUST classify as metacritic_user (Rank 1 if <25, Rank 2 if >=25, NEVER Rank 4)
    expect(
      offlineVaultMod.getCriticAuthorityRank({
        score: 82,
        numReviews: 12,
        url: 'https://www.metacritic.com/game/synthetic-title/user-reviews/',
      })
    ).toBe(1);
    expect(
      offlineVaultMod.getCriticAuthorityRank({
        score: 82,
        numReviews: 120,
        url: 'https://www.metacritic.com/game/synthetic-title/user-reviews/',
      })
    ).toBe(2);
    expect(
      offlineVaultMod.getCriticAuthorityRank({
        score: 84,
        userScoreRaw: 8.4,
        numReviews: 40,
        url: 'https://www.metacritic.com/game/synthetic-title/',
      })
    ).toBe(2);
    // Explicit press Metacritic critic URL remains Rank 4
    expect(
      offlineVaultMod.getCriticAuthorityRank({
        score: 88,
        numReviews: 30,
        url: 'https://www.metacritic.com/game/synthetic-title/critic-reviews/',
      })
    ).toBe(4);
  });

  it('6e. storefrontReadinessBarrier isBottleWinExeRunning matches unquoted macOS WINEPREFIX paths containing spaces', async () => {
    const bottleWithSpaces =
      '/Users/tester/Library/Application Support/CrossOver/Bottles/OneLauncher';
    const otherBottleWithSpaces =
      '/Users/tester/Library/Application Support/CrossOver/Bottles/OtherBottle';

    const psEwwOutput = [
      `C:\\Program Files (x86)\\Steam\\steam.exe -silent WINEPREFIX=${bottleWithSpaces} WINEESYNC=1 WINEDEBUG=-all`,
    ].join('\n');

    const psEwwEndOfLine = [
      `C:\\Program Files (x86)\\Steam\\steam.exe WINEESYNC=1 WINEPREFIX=${bottleWithSpaces}`,
    ].join('\n');

    await expect(
      readinessBarrier.isBottleWinExeRunning('steam.exe', bottleWithSpaces, {
        mockProcessListOutput: psEwwOutput,
      })
    ).resolves.toBe(true);

    await expect(
      readinessBarrier.isBottleWinExeRunning('steam.exe', bottleWithSpaces, {
        mockProcessListOutput: psEwwEndOfLine,
      })
    ).resolves.toBe(true);

    // Must NOT cross-match a different bottle or prefix substring (`OneLauncher-arm64`)
    await expect(
      readinessBarrier.isBottleWinExeRunning('steam.exe', otherBottleWithSpaces, {
        mockProcessListOutput: psEwwOutput,
      })
    ).resolves.toBe(false);
    await expect(
      readinessBarrier.isBottleWinExeRunning('steam.exe', `${bottleWithSpaces}-arm64`, {
        mockProcessListOutput: psEwwOutput,
      })
    ).resolves.toBe(false);
  });

  it('6f. binaryAndManifestInspectors rejects zip-bomb Epic manifests (>64 MiB) and readVerifiedBridgeDllBuffer fails closed on tampered SHA-256', async () => {
    expect(manifestParsers.MAX_EPIC_MANIFEST_INFLATE_BYTES).toBe(64 * 1024 * 1024);

    // Construct a highly compressible 65 MiB payload (> 64 MiB cap) compressed to ~65 KiB in milliseconds
    const hugeZeroJson = Buffer.alloc(65 * 1024 * 1024, 0x20);
    hugeZeroJson.write('{"diskSize":123456', 0, 'ascii');
    hugeZeroJson[hugeZeroJson.length - 1] = 0x7d; // '}'
    const deflatedZipBomb = zlib.deflateSync(hugeZeroJson, { level: 1 });

    // 1. Raw zlib-compressed JSON zip bomb rejected (returns null)
    expect(binaryInspectors.parseEpicManifestBuffer(deflatedZipBomb)).toBeNull();

    // 2. Binary Epic manifest header (0x44bec00c, storedAs=0x1 compressed) wrapping >64 MiB zip bomb rejected
    const header = Buffer.alloc(41, 0);
    header.writeUInt32LE(0x44bec00c, 0); // EPIC_BINARY_MANIFEST_MAGIC
    header.writeUInt32LE(41, 4); // headerSize
    header.writeUInt32LE(hugeZeroJson.length, 8); // uncompressedSize
    header.writeUInt32LE(deflatedZipBomb.length, 12); // compressedSize
    header.writeUInt8(0x01, 40); // storedAs = compressed
    const binaryZipBomb = Buffer.concat([header, deflatedZipBomb]);
    expect(binaryInspectors.parseEpicManifestBuffer(binaryZipBomb)).toBeNull();

    // 3. `readVerifiedBridgeDllBuffer` fails closed by default on tampered SHA-256 or missing sidecar
    const sandbox = createSandboxDir('ol-r4-bridge-sha-');
    const dllPath = path.join(sandbox, 'one_xgameruntime_bridge.dll');
    const shaPath = path.join(sandbox, 'one_xgameruntime_bridge.sha256');
    const authenticBytes = Buffer.from('MZ_SYNTHETIC_BRIDGE_DLL_PAYLOAD');
    const authenticSha = crypto.createHash('sha256').update(authenticBytes).digest('hex');

    fs.writeFileSync(dllPath, authenticBytes);

    // Missing sidecar -> fail closed
    const missingSidecar = await wineAndCrossOverManager.readVerifiedBridgeDllBuffer(dllPath);
    expect(missingSidecar.buf).toBeNull();
    expect(missingSidecar.sidecarVerified).toBe(false);

    // Valid sidecar -> verified
    fs.writeFileSync(shaPath, `${authenticSha}  one_xgameruntime_bridge.dll\n`, 'utf8');
    const validRes = await wineAndCrossOverManager.readVerifiedBridgeDllBuffer(dllPath);
    expect(validRes.buf).not.toBeNull();
    expect(validRes.sidecarVerified).toBe(true);
    expect(validRes.sha256).toBe(authenticSha);

    // Tampered DLL byte -> fail closed by default!
    const tamperedBytes = Buffer.from(authenticBytes);
    tamperedBytes[tamperedBytes.length - 1] ^= 0xff;
    fs.writeFileSync(dllPath, tamperedBytes);
    const tamperedRes = await wineAndCrossOverManager.readVerifiedBridgeDllBuffer(dllPath);
    expect(tamperedRes.buf).toBeNull();
    expect(tamperedRes.sidecarVerified).toBe(false);
  });

  it('6g. Native binaries pass Mach-O ad-hoc/no-Metal checks, display scaler size cap (<= 122,880 B), and Win64 bridge .pdata (> 400 B)', () => {
    const CS_ADHOC = 0x2;
    const CS_RUNTIME = 0x10000;

    for (const dylibName of ['libone_metal_preload.dylib', 'libone_coop_activate.dylib']) {
      const dylibPath = path.join(REPO_ROOT, 'electron', 'helpers', dylibName);
      expect(fs.existsSync(dylibPath), `Missing ${dylibName}`).toBe(true);

      const slices = inspectUniversalMachOBinary(dylibPath);
      expect(slices.length).toBe(2); // Universal fat binary: x86_64 + arm64
      for (const slice of slices) {
        expect(slice.codeDirectoryFlags).not.toBeNull();
        expect((slice.codeDirectoryFlags! & CS_ADHOC) !== 0).toBe(true);
        expect((slice.codeDirectoryFlags! & CS_RUNTIME) === 0).toBe(true);
        expect(slice.dylibs.some((lib) => /Metal\.framework/i.test(lib))).toBe(false);
      }

      if (process.platform === 'darwin') {
        const csRes = spawnSync('codesign', ['-dvvv', dylibPath], { encoding: 'utf8' });
        expect(csRes.status).toBe(0);
        const csCombined = `${csRes.stdout || ''}\n${csRes.stderr || ''}`;
        expect(csCombined).toMatch(/Signature=adhoc/i);
        expect(csCombined).toMatch(/flags=0x[0-9a-f]+\([^)]*\badhoc\b[^)]*\)/i);
        expect(csCombined).not.toMatch(/flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/i);

        const otoolOut = execFileSync('otool', ['-L', dylibPath], { encoding: 'utf8' });
        expect(otoolOut).not.toMatch(/Metal\.framework/i);
      }
    }

    // Display scaler DLLs <= 122,880 B (120 KiB) with valid x86/x64 PE headers
    const scalerX86Path = path.join(
      REPO_ROOT,
      'electron',
      'helpers',
      'bin',
      'one_display_scaler_x86.dll'
    );
    const scalerX64Path = path.join(
      REPO_ROOT,
      'electron',
      'helpers',
      'bin',
      'one_display_scaler_x64.dll'
    );
    expect(fs.statSync(scalerX86Path).size).toBeLessThanOrEqual(122_880);
    expect(fs.statSync(scalerX64Path).size).toBeLessThanOrEqual(122_880);
    expect(inspectPeBinary(scalerX86Path).machine).toBe(0x014c);
    expect(inspectPeBinary(scalerX64Path).machine).toBe(0x8664);

    // Win64 one_xgameruntime_bridge.dll has SEH unwind table `.pdata > 400 B`
    const xgrBridgePath = path.join(
      REPO_ROOT,
      'electron',
      'helpers',
      'bin',
      'one_xgameruntime_bridge.dll'
    );
    const xgrPe = inspectPeBinary(xgrBridgePath);
    expect(xgrPe.machine).toBe(0x8664);
    expect(xgrPe.optionalMagic).toBe(0x020b);
    const pdataSection = xgrPe.sections.find((s) => s.name === '.pdata');
    expect(pdataSection).toBeDefined();
    expect(pdataSection!.virtualSize).toBeGreaterThan(400);
    expect(pdataSection!.rawSize).toBeGreaterThan(400);
    expect(xgrPe.exceptionDirSize).toBeGreaterThan(400);
  });

  it('6h. Self-checks PII hygiene on this regression suite via piiHygieneGuard', () => {
    const selfContent = fs.readFileSync(__filename, 'utf8');
    expect(
      scanContentForPiiViolations(selfContent, 'tests/r4ElectronAndNativeHardening.test.ts')
    ).toEqual([]);
  });
});
