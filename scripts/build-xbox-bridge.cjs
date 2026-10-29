#!/usr/bin/env node
'use strict';

/**
 * Reproducible cross-compiler & PE32+ ABI verifier for One Launcher's Xbox runtime bridges:
 *   1. `one_xgameruntime_bridge.dll` (`Xgameruntime.dll` clean-room provider)
 *   2. `one_gameinput_bridge.dll` (`GameInput.dll` / `GameInputRedist.dll` v0/v1/v2 COM bridge)
 *   3. `one_appnotify_bridge.dll` (`api-ms-win-core-psm-appnotify-l1-1-0.dll` PSM bridge)
 *   4. `one_xgr_win_launcher.exe` (Win64 GUI-subsystem suspended-APC preloader for clientless Windows)
 * Compiles pure C11 Win32 sources in `electron/helpers/xgr_bridge/` to `x86_64-windows-gnu`
 * via `zig cc`, normalizes PE timestamps and computes deterministic Win32 PE `CheckSum`s,
 * verifies PE Machine `0x8664`, Export Directory `LIBRARY` internal names, exact retail exports,
 * clean Win32 imports, embedded markers, `.sha256` sidecars, and `bridge-build-manifest.json`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'electron', 'helpers', 'xgr_bridge');
const OUT_DIR = path.join(REPO_ROOT, 'electron', 'helpers', 'bin');
const DLL_PATH = path.join(OUT_DIR, 'one_xgameruntime_bridge.dll');
const SHA256_PATH = path.join(OUT_DIR, 'one_xgameruntime_bridge.sha256');
const GAMEINPUT_DLL_PATH = path.join(OUT_DIR, 'one_gameinput_bridge.dll');
const GAMEINPUT_SHA256_PATH = path.join(OUT_DIR, 'one_gameinput_bridge.sha256');
const APPNOTIFY_DLL_PATH = path.join(OUT_DIR, 'one_appnotify_bridge.dll');
const APPNOTIFY_SHA256_PATH = path.join(OUT_DIR, 'one_appnotify_bridge.sha256');
const WIN_LAUNCHER_EXE_PATH = path.join(OUT_DIR, 'one_xgr_win_launcher.exe');
const WIN_LAUNCHER_SHA256_PATH = path.join(OUT_DIR, 'one_xgr_win_launcher.sha256');
const MANIFEST_PATH = path.join(OUT_DIR, 'bridge-build-manifest.json');

const EXPECTED_DLL_NAME = 'Xgameruntime.dll';
const EXPECTED_EXPORTS = [
  'DllCanUnloadNow',
  'InitializeApiImpl',
  'InitializeApiImplEx',
  'InitializeApiImplEx2',
  'QueryApiImpl',
  'UninitializeApiImpl',
  'XErrorReport',
];

const EXPECTED_MARKER = 'OneLauncher.XGRBridge.v1';

const GAMEINPUT_EXPECTED_DLL_NAME = 'GameInput.dll';
const GAMEINPUT_EXPECTED_EXPORTS = [
  'DllCanUnloadNow',
  'GameInputCreate',
];

const GAMEINPUT_EXPECTED_MARKER = 'OneLauncher.GameInputBridge.v1';

const APPNOTIFY_EXPECTED_DLL_NAME = 'api-ms-win-core-psm-appnotify-l1-1-0.dll';
const APPNOTIFY_EXPECTED_EXPORTS = [
  'RegisterAppConstrainedChangeNotification',
  'RegisterAppStateChangeNotification',
  'UnregisterAppConstrainedChangeNotification',
  'UnregisterAppStateChangeNotification',
];

const APPNOTIFY_EXPECTED_MARKER = 'OneLauncher.AppNotifyBridge.v1';

const WIN_LAUNCHER_EXPECTED_MARKER = 'OneLauncher.XGRWinLauncher.v1';

const HEADER_SOURCES = [
  'xgr_internal.h',
];

const DEF_SOURCES = [
  'xgameruntime.def',
  'gameinput.def',
  'appnotify.def',
];

const C_SOURCES = [
  'main.c',
  'xgr_xml_pfn.c',
  'xgr_rpc.c',
  'xgr_xcurl_shim.c',
  'xthreading.c',
  'xuser.c',
  'xstore.c',
  'xgamesave.c',
  'xpackage.c',
  'xsystem_misc.c',
];

const GAMEINPUT_C_SOURCES = [
  'gameinput_bridge.c',
];

const APPNOTIFY_C_SOURCES = [
  'appnotify_bridge.c',
];

const WIN_LAUNCHER_C_SOURCES = [
  'win_xgr_launcher.c',
];

const ALL_TRACKED_BRIDGE_SOURCES = [
  ...HEADER_SOURCES,
  ...DEF_SOURCES,
  ...C_SOURCES,
  ...GAMEINPUT_C_SOURCES,
  ...APPNOTIFY_C_SOURCES,
  ...WIN_LAUNCHER_C_SOURCES,
].sort();

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function resolveZigBinary({ optional = false } = {}) {
  const candidates = [];
  if (process.env.ZIG_BIN) candidates.push(process.env.ZIG_BIN);

  try {
    const locatorCmd = process.platform === 'win32' ? 'where' : 'which';
    const whichOut = execFileSync(locatorCmd, ['zig'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)[0]
      .trim();
    if (whichOut) candidates.push(whichOut);
  } catch {
    // Not in PATH
  }

  const homeDir = os.homedir();
  candidates.push(
    '/opt/homebrew/bin/zig',
    '/usr/local/bin/zig',
    path.join(homeDir, '.cache', 'onelauncher-zig', process.platform === 'win32' ? 'zig.exe' : 'zig')
  );

  for (const cand of candidates) {
    if (cand && fs.existsSync(cand)) {
      return cand;
    }
  }

  if (optional) return null;

  throw new Error(
    'Unable to locate `zig` binary. Set ZIG_BIN=/path/to/zig or install Zig (`brew install zig`).'
  );
}

function getZigVersion(zigBin) {
  if (!zigBin) return null;
  try {
    return execFileSync(zigBin, ['version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function rvaToFileOffset(sections, rva) {
  for (const sec of sections) {
    const span = Math.max(sec.virtualSize, sec.rawSize);
    if (rva >= sec.virtualAddress && rva < sec.virtualAddress + span) {
      const delta = rva - sec.virtualAddress;
      if (delta < sec.rawSize) {
        return sec.rawOffset + delta;
      }
      return -1;
    }
  }
  return -1;
}

function readAsciiCString(buf, offset) {
  if (offset < 0 || offset >= buf.length) return '';
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end += 1;
  return buf.subarray(offset, end).toString('ascii');
}

/**
 * Standard Win32 `MapFileAndCheckSum` / `IMAGEHLP` PE checksum algorithm:
 * 16-bit ones'-complement folding sum across the file skipping the 4-byte
 * `OptionalHeader.CheckSum` field at `checkSumOffset..checkSumOffset + 3`,
 * folded to 16 bits plus `buf.length`.
 */
function computePeCheckSum(buf, checkSumOffset) {
  let sum = 0;
  const len = buf.length;
  const evenLen = len & ~1;
  for (let i = 0; i < evenLen; i += 2) {
    if (i === checkSumOffset || i === checkSumOffset + 2) continue;
    sum += buf.readUInt16LE(i);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  if ((len & 1) !== 0) {
    sum += buf[len - 1];
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  return (sum + len) >>> 0;
}

/**
 * Zeroes COFF TimeDateStamp, Export Directory TimeDateStamp, and any Debug Directory
 * TimeDateStamps, then writes the exact deterministic Win32 PE `OptionalHeader.CheckSum`
 * so PE64 outputs are 100% bit-for-bit reproducible and pass strict PE checksum validators.
 */
function normalizePeDeterminism(pePath) {
  const buf = Buffer.from(fs.readFileSync(pePath));
  if (buf.length < 512 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`Cannot normalize invalid PE image: ${pePath}`);
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`Missing PE signature in ${pePath}`);
  }

  const coffOffset = peOffset + 4;
  const numSections = buf.readUInt16LE(coffOffset + 2);
  const optHeaderSize = buf.readUInt16LE(coffOffset + 16);
  const optOffset = coffOffset + 20;

  // Zero COFF FileHeader.TimeDateStamp
  buf.writeUInt32LE(0, coffOffset + 4);

  const sectionTableOffset = optOffset + optHeaderSize;
  const sections = [];
  for (let i = 0; i < numSections; i += 1) {
    const sh = sectionTableOffset + i * 40;
    sections.push({
      virtualSize: buf.readUInt32LE(sh + 8),
      virtualAddress: buf.readUInt32LE(sh + 12),
      rawSize: buf.readUInt32LE(sh + 16),
      rawOffset: buf.readUInt32LE(sh + 20),
    });
  }

  const dataDirOffset = optOffset + 112;
  if (dataDirOffset + 8 <= buf.length) {
    const exportRva = buf.readUInt32LE(dataDirOffset);
    const exportSize = buf.readUInt32LE(dataDirOffset + 4);
    if (exportRva && exportSize) {
      const expOff = rvaToFileOffset(sections, exportRva);
      if (expOff >= 0 && expOff + 40 <= buf.length) {
        buf.writeUInt32LE(0, expOff + 4);
      }
    }
  }

  // DataDirectory[6] = IMAGE_DIRECTORY_ENTRY_DEBUG
  const debugDirOffset = dataDirOffset + 6 * 8;
  if (debugDirOffset + 8 <= buf.length) {
    const debugRva = buf.readUInt32LE(debugDirOffset);
    const debugSize = buf.readUInt32LE(debugDirOffset + 4);
    if (debugRva && debugSize >= 28) {
      const debugOff = rvaToFileOffset(sections, debugRva);
      const count = Math.floor(debugSize / 28);
      if (debugOff >= 0 && debugOff + count * 28 <= buf.length) {
        for (let i = 0; i < count; i += 1) {
          buf.writeUInt32LE(0, debugOff + i * 28 + 4);
        }
      }
    }
  }

  if (optOffset + 68 <= buf.length) {
    const checkSum = computePeCheckSum(buf, optOffset + 64);
    buf.writeUInt32LE(checkSum, optOffset + 64);
  }

  fs.writeFileSync(pePath, buf);
  return buf;
}

function parseAndVerifyPeDll(
  dllBuffer,
  {
    expectedExports = EXPECTED_EXPORTS,
    expectedMarker = EXPECTED_MARKER,
    expectedDllName = null,
    requireDeterministicTimestamps = false,
    requireDllFlag = true,
    requireExports = true,
    expectedSubsystem = null,
  } = {}
) {
  if (!Buffer.isBuffer(dllBuffer) || dllBuffer.length < 512) {
    throw new Error('PE file is too small to be a valid PE image');
  }
  if (dllBuffer.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('Missing DOS MZ signature');
  }

  const peOffset = dllBuffer.readUInt32LE(0x3c);
  if (peOffset + 24 > dllBuffer.length || dllBuffer.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error('Missing PE\\0\\0 signature');
  }

  const coffOffset = peOffset + 4;
  const machine = dllBuffer.readUInt16LE(coffOffset);
  if (machine !== 0x8664) {
    throw new Error(`Unexpected PE Machine 0x${machine.toString(16)} (expected 0x8664 AMD64)`);
  }

  const numSections = dllBuffer.readUInt16LE(coffOffset + 2);
  const coffTimeDateStamp = dllBuffer.readUInt32LE(coffOffset + 4);
  const optHeaderSize = dllBuffer.readUInt16LE(coffOffset + 16);
  const characteristics = dllBuffer.readUInt16LE(coffOffset + 18);
  if (requireDllFlag) {
    if ((characteristics & 0x2000) === 0) {
      throw new Error('PE Characteristics missing IMAGE_FILE_DLL (0x2000)');
    }
  } else if ((characteristics & 0x2000) !== 0) {
    throw new Error('PE executable Characteristics unexpectedly set IMAGE_FILE_DLL (0x2000)');
  }

  const optOffset = coffOffset + 20;
  const magic = dllBuffer.readUInt16LE(optOffset);
  if (magic !== 0x020b) {
    throw new Error(`Expected PE32+ OptionalHeader magic 0x020b, got 0x${magic.toString(16)}`);
  }

  const checkSumOffset = optOffset + 64;
  const actualCheckSum = dllBuffer.readUInt32LE(checkSumOffset);
  const expectedCheckSum = computePeCheckSum(dllBuffer, checkSumOffset);
  if (requireDeterministicTimestamps || actualCheckSum !== 0) {
    if (actualCheckSum === 0 || actualCheckSum !== expectedCheckSum) {
      throw new Error(
        `PE OptionalHeader.CheckSum mismatch: expected 0x${expectedCheckSum.toString(16)}, got 0x${actualCheckSum.toString(16)}`
      );
    }
  }

  const subsystem = dllBuffer.readUInt16LE(optOffset + 68);
  if (expectedSubsystem !== null && subsystem !== expectedSubsystem) {
    throw new Error(
      `Unexpected PE OptionalHeader.Subsystem ${subsystem} (expected ${expectedSubsystem})`
    );
  }

  const dataDirOffset = optOffset + 112;
  const exportRva = dllBuffer.readUInt32LE(dataDirOffset);
  const exportSize = dllBuffer.readUInt32LE(dataDirOffset + 4);
  const importRva = dllBuffer.readUInt32LE(dataDirOffset + 8);

  const sectionTableOffset = optOffset + optHeaderSize;
  const sections = [];
  for (let i = 0; i < numSections; i += 1) {
    const sh = sectionTableOffset + i * 40;
    sections.push({
      name: readAsciiCString(dllBuffer.subarray(sh, sh + 8), 0),
      virtualSize: dllBuffer.readUInt32LE(sh + 8),
      virtualAddress: dllBuffer.readUInt32LE(sh + 12),
      rawSize: dllBuffer.readUInt32LE(sh + 16),
      rawOffset: dllBuffer.readUInt32LE(sh + 20),
    });
  }

  if (requireDeterministicTimestamps && coffTimeDateStamp !== 0) {
    throw new Error(
      `Non-deterministic PE COFF TimeDateStamp detected (coff=0x${coffTimeDateStamp.toString(16)})`
    );
  }

  let internalName = '';
  const exportsList = [];

  if (requireExports) {
    if (!exportRva || !exportSize) {
      throw new Error('PE image has no Export Directory');
    }

    const expOff = rvaToFileOffset(sections, exportRva);
    if (expOff < 0 || expOff + 40 > dllBuffer.length) {
      throw new Error('Invalid Export Directory RVA');
    }

    const exportTimeDateStamp = dllBuffer.readUInt32LE(expOff + 4);
    const exportNameRva = dllBuffer.readUInt32LE(expOff + 12);
    internalName = exportNameRva
      ? readAsciiCString(dllBuffer, rvaToFileOffset(sections, exportNameRva))
      : '';

    if (expectedDllName && internalName !== expectedDllName) {
      throw new Error(
        `PE Export Directory internal name mismatch: expected "${expectedDllName}", got "${internalName}"`
      );
    }

    if (requireDeterministicTimestamps && exportTimeDateStamp !== 0) {
      throw new Error(
        `Non-deterministic PE Export TimeDateStamp detected (export=0x${exportTimeDateStamp.toString(16)})`
      );
    }

    const numberOfNames = dllBuffer.readUInt32LE(expOff + 24);
    const addressOfNamesRva = dllBuffer.readUInt32LE(expOff + 32);
    const namesOff = rvaToFileOffset(sections, addressOfNamesRva);
    if (namesOff < 0 || namesOff + numberOfNames * 4 > dllBuffer.length) {
      throw new Error('Invalid Export AddressOfNames table');
    }

    for (let i = 0; i < numberOfNames; i += 1) {
      const nameRva = dllBuffer.readUInt32LE(namesOff + i * 4);
      const nameOff = rvaToFileOffset(sections, nameRva);
      exportsList.push(readAsciiCString(dllBuffer, nameOff));
    }

    const sortedActual = [...exportsList].sort();
    const sortedExpected = [...expectedExports].sort();
    if (
      sortedActual.length !== sortedExpected.length ||
      sortedActual.some((name, idx) => name !== sortedExpected[idx])
    ) {
      throw new Error(
        `Export mismatch!\n  Expected: ${sortedExpected.join(', ')}\n  Actual:   ${sortedActual.join(', ')}`
      );
    }
  }

  // Parse Import Directory to ensure zero non-OS runtime DLL dependencies (e.g. libwinpthread)
  const importedDlls = [];
  if (importRva) {
    let impOff = rvaToFileOffset(sections, importRva);
    while (impOff >= 0 && impOff + 20 <= dllBuffer.length) {
      const origFirstThunk = dllBuffer.readUInt32LE(impOff);
      const nameRva = dllBuffer.readUInt32LE(impOff + 12);
      const firstThunk = dllBuffer.readUInt32LE(impOff + 16);
      if (origFirstThunk === 0 && nameRva === 0 && firstThunk === 0) break;
      const dllName = readAsciiCString(dllBuffer, rvaToFileOffset(sections, nameRva));
      if (dllName) importedDlls.push(dllName);
      impOff += 20;
    }
  }

  for (const dll of importedDlls) {
    const lower = dll.toLowerCase();
    if (lower.includes('winpthread') || lower.includes('libgcc') || lower.includes('stdc++')) {
      throw new Error(`Forbidden external MinGW runtime dependency imported: ${dll}`);
    }
  }

  if (!dllBuffer.includes(Buffer.from(expectedMarker, 'ascii'))) {
    throw new Error(`Compiled PE image is missing embedded marker "${expectedMarker}"`);
  }

  const sha256 = sha256Hex(dllBuffer);
  return {
    machine: '0x8664',
    internalName,
    subsystem,
    checkSum: actualCheckSum,
    sizeBytes: dllBuffer.length,
    exports: exportsList,
    imports: importedDlls,
    marker: expectedMarker,
    sha256,
  };
}

const parseAndVerifyPeImage = parseAndVerifyPeDll;

function computeSourceManifestDigests() {
  const sources = {};
  for (const relName of ALL_TRACKED_BRIDGE_SOURCES) {
    const absPath = path.join(SRC_DIR, relName);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Missing tracked bridge source file: ${absPath}`);
    }
    // Normalize CRLF -> LF so Windows checkouts with core.autocrlf=true verify deterministically
    const normalizedText = fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
    sources[relName] = sha256Hex(Buffer.from(normalizedText, 'utf8'));
  }
  return sources;
}

function buildManifestObject({ compilerVersion, xgrInfo, giInfo, appNotifyInfo, winLauncherInfo }) {
  return {
    schemaVersion: 1,
    targetTriple: 'x86_64-windows-gnu',
    compilerVersion: compilerVersion || 'prebuilt',
    sources: computeSourceManifestDigests(),
    outputs: {
      'one_xgameruntime_bridge.dll': {
        internalName: xgrInfo.internalName,
        sha256: xgrInfo.sha256,
        checkSum: xgrInfo.checkSum,
        sizeBytes: xgrInfo.sizeBytes,
        marker: xgrInfo.marker,
        exports: [...xgrInfo.exports].sort(),
      },
      'one_gameinput_bridge.dll': {
        internalName: giInfo.internalName,
        sha256: giInfo.sha256,
        checkSum: giInfo.checkSum,
        sizeBytes: giInfo.sizeBytes,
        marker: giInfo.marker,
        exports: [...giInfo.exports].sort(),
      },
      'one_appnotify_bridge.dll': {
        internalName: appNotifyInfo.internalName,
        sha256: appNotifyInfo.sha256,
        checkSum: appNotifyInfo.checkSum,
        sizeBytes: appNotifyInfo.sizeBytes,
        marker: appNotifyInfo.marker,
        exports: [...appNotifyInfo.exports].sort(),
      },
      'one_xgr_win_launcher.exe': {
        internalName: '',
        subsystem: winLauncherInfo.subsystem,
        sha256: winLauncherInfo.sha256,
        checkSum: winLauncherInfo.checkSum,
        sizeBytes: winLauncherInfo.sizeBytes,
        marker: winLauncherInfo.marker,
        exports: [],
      },
    },
  };
}

function verifySidecarSha256(sidecarPath, expectedSha, label) {
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(`Missing SHA-256 sidecar for ${label}: ${sidecarPath}`);
  }
  const recorded = fs.readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0];
  if (recorded !== expectedSha) {
    throw new Error(
      `SHA-256 sidecar mismatch for ${label}: expected ${expectedSha}, recorded ${recorded}`
    );
  }
}

function verifyBridgeBuildManifest({
  xgrInfo,
  giInfo,
  appNotifyInfo,
  winLauncherInfo,
  manifestPath = MANIFEST_PATH,
} = {}) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing bridge build manifest: ${manifestPath}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in bridge build manifest (${manifestPath}): ${err.message}`);
  }
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.sources !== 'object' || typeof manifest.outputs !== 'object') {
    throw new Error(`Malformed bridge build manifest schema in ${manifestPath}`);
  }

  const currentSources = computeSourceManifestDigests();
  const recordedKeys = Object.keys(manifest.sources).sort();
  const currentKeys = Object.keys(currentSources).sort();
  if (
    recordedKeys.length !== currentKeys.length ||
    recordedKeys.some((k, idx) => k !== currentKeys[idx])
  ) {
    throw new Error('Bridge build manifest source file list is out of sync with xgr_bridge/');
  }

  for (const key of currentKeys) {
    if (manifest.sources[key] !== currentSources[key]) {
      throw new Error(
        `Stale prebuilt DLLs: source "${key}" changed since last build (manifest=${manifest.sources[key]}, current=${currentSources[key]})`
      );
    }
  }

  const xgrOut = manifest.outputs['one_xgameruntime_bridge.dll'];
  const giOut = manifest.outputs['one_gameinput_bridge.dll'];
  const appNotifyOut = manifest.outputs['one_appnotify_bridge.dll'];
  const winLauncherOut = manifest.outputs['one_xgr_win_launcher.exe'];

  if (!xgrOut || xgrOut.sha256 !== xgrInfo.sha256 || xgrOut.internalName !== EXPECTED_DLL_NAME) {
    throw new Error('Bridge build manifest output entry mismatch for one_xgameruntime_bridge.dll');
  }
  if (!giOut || giOut.sha256 !== giInfo.sha256 || giOut.internalName !== GAMEINPUT_EXPECTED_DLL_NAME) {
    throw new Error('Bridge build manifest output entry mismatch for one_gameinput_bridge.dll');
  }
  if (
    appNotifyInfo &&
    (!appNotifyOut ||
      appNotifyOut.sha256 !== appNotifyInfo.sha256 ||
      appNotifyOut.internalName !== APPNOTIFY_EXPECTED_DLL_NAME)
  ) {
    throw new Error('Bridge build manifest output entry mismatch for one_appnotify_bridge.dll');
  }
  if (
    winLauncherInfo &&
    (!winLauncherOut ||
      winLauncherOut.sha256 !== winLauncherInfo.sha256 ||
      winLauncherOut.marker !== WIN_LAUNCHER_EXPECTED_MARKER)
  ) {
    throw new Error('Bridge build manifest output entry mismatch for one_xgr_win_launcher.exe');
  }

  return manifest;
}

function cleanTransientLinkerOutputs() {
  if (!fs.existsSync(OUT_DIR)) return;
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (/\.(?:lib|pdb|exp)$/i.test(name)) {
      fs.rmSync(path.join(OUT_DIR, name), { force: true });
    }
  }
}

function verifyGameInputBridgeDll(dllPath = GAMEINPUT_DLL_PATH) {
  const buf = fs.readFileSync(dllPath);
  return parseAndVerifyPeDll(buf, {
    expectedExports: GAMEINPUT_EXPECTED_EXPORTS,
    expectedMarker: GAMEINPUT_EXPECTED_MARKER,
    expectedDllName: dllPath === GAMEINPUT_DLL_PATH ? GAMEINPUT_EXPECTED_DLL_NAME : null,
    requireDeterministicTimestamps: dllPath === GAMEINPUT_DLL_PATH,
  });
}

function verifyAppNotifyBridgeDll(dllPath = APPNOTIFY_DLL_PATH) {
  const buf = fs.readFileSync(dllPath);
  return parseAndVerifyPeDll(buf, {
    expectedExports: APPNOTIFY_EXPECTED_EXPORTS,
    expectedMarker: APPNOTIFY_EXPECTED_MARKER,
    expectedDllName: dllPath === APPNOTIFY_DLL_PATH ? APPNOTIFY_EXPECTED_DLL_NAME : null,
    requireDeterministicTimestamps: dllPath === APPNOTIFY_DLL_PATH,
  });
}

function verifyWinXgrLauncherExe(exePath = WIN_LAUNCHER_EXE_PATH) {
  const buf = fs.readFileSync(exePath);
  return parseAndVerifyPeDll(buf, {
    expectedExports: [],
    expectedMarker: WIN_LAUNCHER_EXPECTED_MARKER,
    expectedDllName: null,
    requireDeterministicTimestamps: exePath === WIN_LAUNCHER_EXE_PATH,
    requireDllFlag: false,
    requireExports: false,
    expectedSubsystem: 2, // IMAGE_SUBSYSTEM_WINDOWS_GUI
  });
}

function verifyXboxBridgeDll(dllPath = DLL_PATH) {
  const buf = fs.readFileSync(dllPath);
  const xgrInfo = parseAndVerifyPeDll(buf, {
    expectedExports: EXPECTED_EXPORTS,
    expectedMarker: EXPECTED_MARKER,
    expectedDllName: dllPath === DLL_PATH ? EXPECTED_DLL_NAME : null,
    requireDeterministicTimestamps: dllPath === DLL_PATH,
  });
  if (dllPath === DLL_PATH) {
    const giInfo = verifyGameInputBridgeDll(GAMEINPUT_DLL_PATH);
    const appNotifyInfo = verifyAppNotifyBridgeDll(APPNOTIFY_DLL_PATH);
    const winLauncherInfo = verifyWinXgrLauncherExe(WIN_LAUNCHER_EXE_PATH);
    verifySidecarSha256(SHA256_PATH, xgrInfo.sha256, 'one_xgameruntime_bridge.dll');
    verifySidecarSha256(GAMEINPUT_SHA256_PATH, giInfo.sha256, 'one_gameinput_bridge.dll');
    verifySidecarSha256(APPNOTIFY_SHA256_PATH, appNotifyInfo.sha256, 'one_appnotify_bridge.dll');
    verifySidecarSha256(WIN_LAUNCHER_SHA256_PATH, winLauncherInfo.sha256, 'one_xgr_win_launcher.exe');
    const manifest = verifyBridgeBuildManifest({
      xgrInfo,
      giInfo,
      appNotifyInfo,
      winLauncherInfo,
      manifestPath: MANIFEST_PATH,
    });
    return {
      ...xgrInfo,
      manifestPath: MANIFEST_PATH,
      compilerVersion: manifest.compilerVersion,
      gameInputBridge: {
        dllPath: GAMEINPUT_DLL_PATH,
        sha256Path: GAMEINPUT_SHA256_PATH,
        ...giInfo,
      },
      appNotifyBridge: {
        dllPath: APPNOTIFY_DLL_PATH,
        sha256Path: APPNOTIFY_SHA256_PATH,
        ...appNotifyInfo,
      },
      winXgrLauncher: {
        exePath: WIN_LAUNCHER_EXE_PATH,
        sha256Path: WIN_LAUNCHER_SHA256_PATH,
        ...winLauncherInfo,
      },
    };
  }
  return xgrInfo;
}

function buildGameInputBridgeDll({ forceRebuild = false, zigBin: providedZigBin = null } = {}) {
  const zigBin = providedZigBin || resolveZigBinary({ optional: !forceRebuild });
  if (!zigBin) {
    if (fs.existsSync(GAMEINPUT_DLL_PATH) && fs.existsSync(GAMEINPUT_SHA256_PATH)) {
      const info = verifyGameInputBridgeDll(GAMEINPUT_DLL_PATH);
      verifySidecarSha256(GAMEINPUT_SHA256_PATH, info.sha256, 'one_gameinput_bridge.dll');
      return {
        zigBin: null,
        prebuiltVerified: true,
        dllPath: GAMEINPUT_DLL_PATH,
        sha256Path: GAMEINPUT_SHA256_PATH,
        ...info,
      };
    }
    resolveZigBinary({ optional: false });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const defPath = path.join(SRC_DIR, 'gameinput.def');
  const srcPaths = GAMEINPUT_C_SOURCES.map((f) => path.join(SRC_DIR, f));
  const stageDir = path.join(OUT_DIR, '.pe-stage');
  const stagedDllPath = path.join(stageDir, GAMEINPUT_EXPECTED_DLL_NAME);
  fs.mkdirSync(stageDir, { recursive: true });

  const args = [
    'cc',
    '-target',
    'x86_64-windows-gnu',
    '-shared',
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-fno-ident',
    `-ffile-prefix-map=${REPO_ROOT}=.`,
    `-I${SRC_DIR}`,
    ...srcPaths,
    defPath,
    '-Wl,--strip-all',
    '-lkernel32',
    '-luser32',
    '-o',
    stagedDllPath,
  ];

  try {
    execFileSync(zigBin, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    fs.renameSync(stagedDllPath, GAMEINPUT_DLL_PATH);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  cleanTransientLinkerOutputs();
  normalizePeDeterminism(GAMEINPUT_DLL_PATH);

  const info = verifyGameInputBridgeDll(GAMEINPUT_DLL_PATH);
  fs.writeFileSync(GAMEINPUT_SHA256_PATH, `${info.sha256}  one_gameinput_bridge.dll\n`, 'utf8');
  return {
    zigBin,
    dllPath: GAMEINPUT_DLL_PATH,
    sha256Path: GAMEINPUT_SHA256_PATH,
    ...info,
  };
}

function buildAppNotifyBridgeDll({ forceRebuild = false, zigBin: providedZigBin = null } = {}) {
  const zigBin = providedZigBin || resolveZigBinary({ optional: !forceRebuild });
  if (!zigBin) {
    if (fs.existsSync(APPNOTIFY_DLL_PATH) && fs.existsSync(APPNOTIFY_SHA256_PATH)) {
      const info = verifyAppNotifyBridgeDll(APPNOTIFY_DLL_PATH);
      verifySidecarSha256(APPNOTIFY_SHA256_PATH, info.sha256, 'one_appnotify_bridge.dll');
      return {
        zigBin: null,
        prebuiltVerified: true,
        dllPath: APPNOTIFY_DLL_PATH,
        sha256Path: APPNOTIFY_SHA256_PATH,
        ...info,
      };
    }
    resolveZigBinary({ optional: false });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const defPath = path.join(SRC_DIR, 'appnotify.def');
  const srcPaths = APPNOTIFY_C_SOURCES.map((f) => path.join(SRC_DIR, f));
  const stageDir = path.join(OUT_DIR, '.pe-stage');
  const stagedDllPath = path.join(stageDir, APPNOTIFY_EXPECTED_DLL_NAME);
  fs.mkdirSync(stageDir, { recursive: true });

  const args = [
    'cc',
    '-target',
    'x86_64-windows-gnu',
    '-shared',
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-fno-ident',
    `-ffile-prefix-map=${REPO_ROOT}=.`,
    `-I${SRC_DIR}`,
    ...srcPaths,
    defPath,
    '-Wl,--strip-all',
    '-lkernel32',
    '-o',
    stagedDllPath,
  ];

  try {
    execFileSync(zigBin, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    fs.renameSync(stagedDllPath, APPNOTIFY_DLL_PATH);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  cleanTransientLinkerOutputs();
  normalizePeDeterminism(APPNOTIFY_DLL_PATH);

  const info = verifyAppNotifyBridgeDll(APPNOTIFY_DLL_PATH);
  fs.writeFileSync(APPNOTIFY_SHA256_PATH, `${info.sha256}  one_appnotify_bridge.dll\n`, 'utf8');
  return {
    zigBin,
    dllPath: APPNOTIFY_DLL_PATH,
    sha256Path: APPNOTIFY_SHA256_PATH,
    ...info,
  };
}

function buildWinXgrLauncherExe({ forceRebuild = false, zigBin: providedZigBin = null } = {}) {
  const zigBin = providedZigBin || resolveZigBinary({ optional: !forceRebuild });
  if (!zigBin) {
    if (fs.existsSync(WIN_LAUNCHER_EXE_PATH) && fs.existsSync(WIN_LAUNCHER_SHA256_PATH)) {
      const info = verifyWinXgrLauncherExe(WIN_LAUNCHER_EXE_PATH);
      verifySidecarSha256(WIN_LAUNCHER_SHA256_PATH, info.sha256, 'one_xgr_win_launcher.exe');
      return {
        zigBin: null,
        prebuiltVerified: true,
        exePath: WIN_LAUNCHER_EXE_PATH,
        sha256Path: WIN_LAUNCHER_SHA256_PATH,
        ...info,
      };
    }
    resolveZigBinary({ optional: false });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const srcPaths = WIN_LAUNCHER_C_SOURCES.map((f) => path.join(SRC_DIR, f));
  const stageDir = path.join(OUT_DIR, '.pe-stage');
  const stagedExePath = path.join(stageDir, 'one_xgr_win_launcher.exe');
  fs.mkdirSync(stageDir, { recursive: true });

  const args = [
    'cc',
    '-target',
    'x86_64-windows-gnu',
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-fno-ident',
    `-ffile-prefix-map=${REPO_ROOT}=.`,
    `-I${SRC_DIR}`,
    ...srcPaths,
    '-Wl,--subsystem,windows',
    '-Wl,--strip-all',
    '-lkernel32',
    '-o',
    stagedExePath,
  ];

  try {
    execFileSync(zigBin, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    fs.renameSync(stagedExePath, WIN_LAUNCHER_EXE_PATH);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  cleanTransientLinkerOutputs();
  normalizePeDeterminism(WIN_LAUNCHER_EXE_PATH);

  const info = verifyWinXgrLauncherExe(WIN_LAUNCHER_EXE_PATH);
  fs.writeFileSync(WIN_LAUNCHER_SHA256_PATH, `${info.sha256}  one_xgr_win_launcher.exe\n`, 'utf8');
  return {
    zigBin,
    exePath: WIN_LAUNCHER_EXE_PATH,
    sha256Path: WIN_LAUNCHER_SHA256_PATH,
    ...info,
  };
}

function buildXboxBridgeDll({ forceRebuild = false } = {}) {
  const zigBin = resolveZigBinary({ optional: !forceRebuild });
  if (!zigBin) {
    if (
      fs.existsSync(DLL_PATH) &&
      fs.existsSync(SHA256_PATH) &&
      fs.existsSync(GAMEINPUT_DLL_PATH) &&
      fs.existsSync(GAMEINPUT_SHA256_PATH) &&
      fs.existsSync(APPNOTIFY_DLL_PATH) &&
      fs.existsSync(APPNOTIFY_SHA256_PATH) &&
      fs.existsSync(WIN_LAUNCHER_EXE_PATH) &&
      fs.existsSync(WIN_LAUNCHER_SHA256_PATH) &&
      fs.existsSync(MANIFEST_PATH)
    ) {
      const verified = verifyXboxBridgeDll(DLL_PATH);
      return {
        zigBin: null,
        prebuiltVerified: true,
        dllPath: DLL_PATH,
        sha256Path: SHA256_PATH,
        ...verified,
        gameInputBridge: {
          zigBin: null,
          prebuiltVerified: true,
          ...verified.gameInputBridge,
        },
        appNotifyBridge: {
          zigBin: null,
          prebuiltVerified: true,
          ...verified.appNotifyBridge,
        },
        winXgrLauncher: {
          zigBin: null,
          prebuiltVerified: true,
          ...verified.winXgrLauncher,
        },
      };
    }
    resolveZigBinary({ optional: false });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const defPath = path.join(SRC_DIR, 'xgameruntime.def');
  const srcPaths = C_SOURCES.map((f) => path.join(SRC_DIR, f));
  const stageDir = path.join(OUT_DIR, '.pe-stage');
  const stagedDllPath = path.join(stageDir, EXPECTED_DLL_NAME);
  fs.mkdirSync(stageDir, { recursive: true });

  const args = [
    'cc',
    '-target',
    'x86_64-windows-gnu',
    '-shared',
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-fno-ident',
    `-ffile-prefix-map=${REPO_ROOT}=.`,
    `-I${SRC_DIR}`,
    ...srcPaths,
    defPath,
    '-Wl,--strip-all',
    '-lkernel32',
    '-lws2_32',
    '-ladvapi32',
    '-lole32',
    '-lntdll',
    '-o',
    stagedDllPath,
  ];

  try {
    execFileSync(zigBin, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    fs.renameSync(stagedDllPath, DLL_PATH);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  cleanTransientLinkerOutputs();
  const normalizedXgrBuf = normalizePeDeterminism(DLL_PATH);

  const gameInputBridge = buildGameInputBridgeDll({ forceRebuild: true, zigBin });
  const appNotifyBridge = buildAppNotifyBridgeDll({ forceRebuild: true, zigBin });
  const winXgrLauncher = buildWinXgrLauncherExe({ forceRebuild: true, zigBin });

  const info = parseAndVerifyPeDll(normalizedXgrBuf, {
    expectedExports: EXPECTED_EXPORTS,
    expectedMarker: EXPECTED_MARKER,
    expectedDllName: EXPECTED_DLL_NAME,
    requireDeterministicTimestamps: true,
  });
  fs.writeFileSync(SHA256_PATH, `${info.sha256}  one_xgameruntime_bridge.dll\n`, 'utf8');

  const compilerVersion = getZigVersion(zigBin);
  const manifest = buildManifestObject({
    compilerVersion,
    xgrInfo: info,
    giInfo: gameInputBridge,
    appNotifyInfo: appNotifyBridge,
    winLauncherInfo: winXgrLauncher,
  });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    zigBin,
    compilerVersion,
    dllPath: DLL_PATH,
    sha256Path: SHA256_PATH,
    manifestPath: MANIFEST_PATH,
    ...info,
    gameInputBridge,
    appNotifyBridge,
    winXgrLauncher,
  };
}

if (require.main === module) {
  const verifyOnly = process.argv.includes('--verify') || process.argv.includes('--verify-only');
  const forceRebuild = process.argv.includes('--force-rebuild');
  const res = verifyOnly ? verifyXboxBridgeDll() : buildXboxBridgeDll({ forceRebuild });
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: verifyOnly ? 'verify' : 'build',
        ...res,
      },
      null,
      2
    )
  );
}

module.exports = {
  DLL_PATH,
  SHA256_PATH,
  GAMEINPUT_DLL_PATH,
  GAMEINPUT_SHA256_PATH,
  APPNOTIFY_DLL_PATH,
  APPNOTIFY_SHA256_PATH,
  WIN_LAUNCHER_EXE_PATH,
  WIN_LAUNCHER_SHA256_PATH,
  MANIFEST_PATH,
  EXPECTED_DLL_NAME,
  EXPECTED_EXPORTS,
  EXPECTED_MARKER,
  GAMEINPUT_EXPECTED_DLL_NAME,
  GAMEINPUT_EXPECTED_EXPORTS,
  GAMEINPUT_EXPECTED_MARKER,
  APPNOTIFY_EXPECTED_DLL_NAME,
  APPNOTIFY_EXPECTED_EXPORTS,
  APPNOTIFY_EXPECTED_MARKER,
  WIN_LAUNCHER_EXPECTED_MARKER,
  resolveZigBinary,
  computePeCheckSum,
  normalizePeDeterminism,
  parseAndVerifyPeDll,
  parseAndVerifyPeImage,
  computeSourceManifestDigests,
  verifyBridgeBuildManifest,
  verifyXboxBridgeDll,
  verifyGameInputBridgeDll,
  verifyAppNotifyBridgeDll,
  verifyWinXgrLauncherExe,
  buildXboxBridgeDll,
  buildGameInputBridgeDll,
  buildAppNotifyBridgeDll,
  buildWinXgrLauncherExe,
};
