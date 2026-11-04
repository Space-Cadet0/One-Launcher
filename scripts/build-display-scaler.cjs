#!/usr/bin/env node
/**
 * Build & verify One Launcher's clean-room Win32 Fullscreen Presenter,
 * Display Virtualizer, and Preloader/Watcher Launcher binaries:
 *   - `one_display_scaler_x86.dll`   (PE32  `0x014c`, `x86-windows-gnu`)
 *   - `one_display_scaler_x64.dll`   (PE32+ `0x8664`, `x86_64-windows-gnu`)
 *   - `one_display_launcher_x86.exe` (PE32  `0x014c`, `x86-windows-gnu`, subsystem GUI)
 *   - `one_display_launcher_x64.exe` (PE32+ `0x8664`, `x86_64-windows-gnu`, subsystem GUI)
 *
 * Enforces deterministic PE timestamps, RFC-compliant PE CheckSum headers,
 * embedded clean-room markers, undecorated export tables, zero MinGW runtime
 * DLL dependencies, `< 120 KB` stripped binary size budgets, `.sha256` sidecars,
 * and `display-scaler-manifest.json`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'electron', 'helpers', 'display_scaler');
const OUT_DIR = path.join(REPO_ROOT, 'electron', 'helpers', 'bin');

const SCALER_DLL_X86_PATH = path.join(OUT_DIR, 'one_display_scaler_x86.dll');
const SCALER_SHA256_X86_PATH = path.join(OUT_DIR, 'one_display_scaler_x86.sha256');
const SCALER_DLL_X64_PATH = path.join(OUT_DIR, 'one_display_scaler_x64.dll');
const SCALER_SHA256_X64_PATH = path.join(OUT_DIR, 'one_display_scaler_x64.sha256');

const LAUNCHER_EXE_X86_PATH = path.join(OUT_DIR, 'one_display_launcher_x86.exe');
const LAUNCHER_SHA256_X86_PATH = path.join(OUT_DIR, 'one_display_launcher_x86.sha256');
const LAUNCHER_EXE_X64_PATH = path.join(OUT_DIR, 'one_display_launcher_x64.exe');
const LAUNCHER_SHA256_X64_PATH = path.join(OUT_DIR, 'one_display_launcher_x64.sha256');

const MANIFEST_PATH = path.join(OUT_DIR, 'display-scaler-manifest.json');

const EXPECTED_SCALER_DLL_INTERNAL_NAME = 'one_display_scaler.dll';
const EXPECTED_SCALER_EXPORTS = [
  'OneLauncherDisplayScalerGetVersion',
  'OneLauncherDisplayScalerTriggerScan',
];
const EXPECTED_SCALER_MARKER = 'OneLauncher.DisplayScaler.v1';
const EXPECTED_LAUNCHER_MARKER = 'OneLauncher.DisplayLauncher.v1';
const MAX_BINARY_SIZE_BYTES = 120 * 1024;

const SCALER_DLL_SOURCES = [
  'display_scaler_math.c',
  'display_scaler_gl_gdi.c',
  'display_scaler_window.c',
  'display_scaler_dll.c',
];
const LAUNCHER_EXE_SOURCES = ['display_launcher.c'];

const TRACKED_MANIFEST_SOURCES = [
  'electron/helpers/display_scaler/display_scaler.h',
  'electron/helpers/display_scaler/display_scaler_internal.h',
  'electron/helpers/display_scaler/display_scaler_math.c',
  'electron/helpers/display_scaler/display_scaler_gl_gdi.c',
  'electron/helpers/display_scaler/display_scaler_window.c',
  'electron/helpers/display_scaler/display_scaler_dll.c',
  'electron/helpers/display_scaler/display_launcher.c',
  'electron/helpers/display_scaler/display_scaler.def',
  'scripts/build-display-scaler.cjs',
];

function resolveZigBinary({ optional = false } = {}) {
  const candidates = [];
  if (process.env.ZIG_BIN) {
    candidates.push(process.env.ZIG_BIN);
  }
  if (process.env.ZIG_PATH) {
    candidates.push(process.env.ZIG_PATH);
  }

  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const whichOut = execFileSync(whichCmd, ['zig'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split(/\r?\n/)[0];
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

const x86ToolchainCache = new Map();

function resolveX86WinGnuToolchain(zigBin) {
  if (x86ToolchainCache.has(zigBin)) {
    return x86ToolchainCache.get(zigBin);
  }
  let targetTriple = 'x86-windows-gnu';
  const tmpProbeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ds-x86-probe-'));
  try {
    const srcProbe = path.join(tmpProbeDir, 'probe.c');
    const outProbe = path.join(tmpProbeDir, 'probe.dll');
    fs.writeFileSync(srcProbe, 'int __stdcall ProbeFn(int x) { return x; }\n', 'utf8');
    const i686Res = spawnSync(
      zigBin,
      ['cc', '-target', 'i686-windows-gnu', '-shared', srcProbe, '-Wl,--kill-at', '-o', outProbe],
      { encoding: 'utf8' }
    );
    if (i686Res.status === 0) {
      const cfg = { targetTriple: 'i686-windows-gnu', extraLinkerFlags: ['-Wl,--kill-at'] };
      x86ToolchainCache.set(zigBin, cfg);
      return cfg;
    }
    const x86KillAtRes = spawnSync(
      zigBin,
      ['cc', '-target', 'x86-windows-gnu', '-shared', srcProbe, '-Wl,--kill-at', '-o', outProbe],
      { encoding: 'utf8' }
    );
    if (x86KillAtRes.status === 0) {
      const cfg = { targetTriple: 'x86-windows-gnu', extraLinkerFlags: ['-Wl,--kill-at'] };
      x86ToolchainCache.set(zigBin, cfg);
      return cfg;
    }
    if (
      String(i686Res.stderr || '').includes('UnknownArchitecture') === false &&
      spawnSync(zigBin, ['cc', '-target', 'i686-windows-gnu', '-shared', srcProbe, '-o', outProbe], {
        encoding: 'utf8',
      }).status === 0
    ) {
      targetTriple = 'i686-windows-gnu';
    }
  } finally {
    fs.rmSync(tmpProbeDir, { recursive: true, force: true });
  }
  const cfg = { targetTriple, extraLinkerFlags: [] };
  x86ToolchainCache.set(zigBin, cfg);
  return cfg;
}

function normalizePeDeterminism(pePathOrBuf) {
  const isBufferInput = Buffer.isBuffer(pePathOrBuf);
  const buf = isBufferInput ? pePathOrBuf : Buffer.from(fs.readFileSync(pePathOrBuf));
  const label = isBufferInput ? '<buffer>' : pePathOrBuf;
  if (buf.length < 512 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`Cannot normalize invalid PE image: ${label}`);
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`Cannot normalize invalid PE signature: ${label}`);
  }

  const coffOffset = peOffset + 4;
  const numberOfSections = buf.readUInt16LE(coffOffset + 2);
  const sizeOfOptionalHeader = buf.readUInt16LE(coffOffset + 16);
  buf.writeUInt32LE(0, coffOffset + 4);

  const optOffset = coffOffset + 20;
  const optMagic = buf.readUInt16LE(optOffset);
  if (optMagic !== 0x010b && optMagic !== 0x020b) {
    throw new Error(`Unsupported PE OptionalHeader magic 0x${optMagic.toString(16)} in ${label}`);
  }
  const isPe32Plus = optMagic === 0x020b;
  const dataDirBase = optOffset + (isPe32Plus ? 112 : 96);
  const numRvaAndSizes = buf.readUInt32LE(optOffset + (isPe32Plus ? 108 : 92));

  const sectionTableOffset = optOffset + sizeOfOptionalHeader;
  const sections = [];
  for (let i = 0; i < numberOfSections; i += 1) {
    const sh = sectionTableOffset + i * 40;
    sections.push({
      virtualSize: buf.readUInt32LE(sh + 8),
      virtualAddress: buf.readUInt32LE(sh + 12),
      rawSize: buf.readUInt32LE(sh + 16),
      rawOffset: buf.readUInt32LE(sh + 20),
    });
  }

  if (numRvaAndSizes >= 1) {
    const exportDirRva = buf.readUInt32LE(dataDirBase);
    const exportDirSize = buf.readUInt32LE(dataDirBase + 4);
    if (exportDirRva !== 0 && exportDirSize >= 40) {
      const exportDirOff = rvaToFileOffset(sections, exportDirRva);
      if (exportDirOff >= 0 && exportDirOff + 8 <= buf.length) {
        buf.writeUInt32LE(0, exportDirOff + 4);
      }
    }
  }

  if (numRvaAndSizes >= 7) {
    const debugDirRva = buf.readUInt32LE(dataDirBase + 6 * 8);
    const debugDirSize = buf.readUInt32LE(dataDirBase + 6 * 8 + 4);
    if (debugDirRva !== 0 && debugDirSize >= 28) {
      const debugDirOff = rvaToFileOffset(sections, debugDirRva);
      const count = Math.floor(debugDirSize / 28);
      if (debugDirOff >= 0 && debugDirOff + count * 28 <= buf.length) {
        for (let i = 0; i < count; i += 1) {
          buf.writeUInt32LE(0, debugDirOff + i * 28 + 4);
        }
      }
    }
  }

  const checkSumOffset = optOffset + 64;
  buf.writeUInt32LE(0, checkSumOffset);
  const checksum = computePeCheckSum(buf, checkSumOffset);
  buf.writeUInt32LE(checksum, checkSumOffset);

  if (!isBufferInput) {
    fs.writeFileSync(pePathOrBuf, buf);
  }
  return buf;
}

function parseAndVerifyPeImage(pePathOrBuf, options = {}) {
  const {
    expectedMachine = 0x8664,
    expectDll = true,
    expectedSubsystem = null,
    expectedExports = [],
    expectedMarker = null,
    expectedDllName = null,
    allowedImportPatterns = null,
    requireDeterministicTimestamps = true,
    maxSizeBytes = MAX_BINARY_SIZE_BYTES,
  } = options;

  const isBufferInput = Buffer.isBuffer(pePathOrBuf);
  const label = isBufferInput ? '<buffer>' : pePathOrBuf;
  if (!isBufferInput && !fs.existsSync(pePathOrBuf)) {
    throw new Error(`Expected PE image does not exist: ${pePathOrBuf}`);
  }
  const buf = isBufferInput ? pePathOrBuf : fs.readFileSync(pePathOrBuf);
  if (buf.length < 512) {
    throw new Error(`PE image is truncated (${buf.length} bytes): ${label}`);
  }
  if (maxSizeBytes > 0 && buf.length >= maxSizeBytes) {
    throw new Error(
      `PE image exceeds size budget (${buf.length} bytes >= ${maxSizeBytes} bytes): ${label}`
    );
  }

  if (buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`Invalid MZ header in ${label}`);
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`Invalid PE\\0\\0 signature in ${label}`);
  }

  const coffOffset = peOffset + 4;
  const machine = buf.readUInt16LE(coffOffset);
  if (machine !== expectedMachine) {
    throw new Error(
      `Unexpected COFF machine 0x${machine.toString(16)} (expected 0x${expectedMachine.toString(16)}) in ${label}`
    );
  }

  const numberOfSections = buf.readUInt16LE(coffOffset + 2);
  const coffTimeDateStamp = buf.readUInt32LE(coffOffset + 4);
  if (requireDeterministicTimestamps && coffTimeDateStamp !== 0) {
    throw new Error(
      `Non-deterministic COFF TimeDateStamp 0x${coffTimeDateStamp.toString(16)} in ${label}`
    );
  }
  const sizeOfOptionalHeader = buf.readUInt16LE(coffOffset + 16);
  const characteristics = buf.readUInt16LE(coffOffset + 18);
  const isDllFlag = (characteristics & 0x2000) !== 0;
  if (expectDll && !isDllFlag) {
    throw new Error(`COFF Characteristics missing IMAGE_FILE_DLL (0x2000) in ${label}`);
  }
  if (!expectDll && isDllFlag) {
    throw new Error(`EXE image unexpectedly carries IMAGE_FILE_DLL (0x2000) in ${label}`);
  }

  const optOffset = coffOffset + 20;
  const optMagic = buf.readUInt16LE(optOffset);
  const expectedOptMagic = expectedMachine === 0x014c ? 0x010b : 0x020b;
  if (optMagic !== expectedOptMagic) {
    throw new Error(
      `Unexpected OptionalHeader magic 0x${optMagic.toString(16)} (expected 0x${expectedOptMagic.toString(16)}) in ${label}`
    );
  }

  const checkSumOffset = optOffset + 64;
  const headerCheckSum = buf.readUInt32LE(checkSumOffset);
  const computedCheckSum = computePeCheckSum(buf, checkSumOffset);
  if (requireDeterministicTimestamps && headerCheckSum !== computedCheckSum) {
    throw new Error(
      `PE OptionalHeader.CheckSum mismatch in ${label}: header=0x${headerCheckSum.toString(16)} expected=0x${computedCheckSum.toString(16)}`
    );
  }

  const subsystem = buf.readUInt16LE(optOffset + 68);
  if (expectedSubsystem !== null && subsystem !== expectedSubsystem) {
    throw new Error(
      `Unexpected PE subsystem ${subsystem} (expected ${expectedSubsystem}) in ${label}`
    );
  }

  const isPe32Plus = optMagic === 0x020b;
  const numRvaAndSizes = buf.readUInt32LE(optOffset + (isPe32Plus ? 108 : 92));
  if (numRvaAndSizes < 2) {
    throw new Error(`OptionalHeader NumberOfRvaAndSizes (${numRvaAndSizes}) < 2 in ${label}`);
  }
  const dataDirBase = optOffset + (isPe32Plus ? 112 : 96);
  const exportDirRva = buf.readUInt32LE(dataDirBase);
  const exportDirSize = buf.readUInt32LE(dataDirBase + 4);
  const importDirRva = buf.readUInt32LE(dataDirBase + 8);
  const importDirSize = buf.readUInt32LE(dataDirBase + 12);

  const sectionTableOffset = optOffset + sizeOfOptionalHeader;
  const sections = [];
  for (let i = 0; i < numberOfSections; i += 1) {
    const sh = sectionTableOffset + i * 40;
    sections.push({
      name: buf.subarray(sh, sh + 8).toString('ascii').replace(/\0+$/g, ''),
      virtualSize: buf.readUInt32LE(sh + 8),
      virtualAddress: buf.readUInt32LE(sh + 12),
      rawSize: buf.readUInt32LE(sh + 16),
      rawOffset: buf.readUInt32LE(sh + 20),
    });
  }

  let internalDllName = null;
  const exportedNames = [];
  if (expectedExports.length > 0 || expectedDllName) {
    if (exportDirRva === 0 || exportDirSize === 0) {
      throw new Error(`PE Export Directory is empty in ${label}`);
    }
    const exportDirOff = rvaToFileOffset(sections, exportDirRva);
    if (exportDirOff < 0 || exportDirOff + 40 > buf.length) {
      throw new Error(`Invalid Export Directory RVA 0x${exportDirRva.toString(16)} in ${label}`);
    }
    const exportTimeDateStamp = buf.readUInt32LE(exportDirOff + 4);
    if (requireDeterministicTimestamps && exportTimeDateStamp !== 0) {
      throw new Error(
        `Non-deterministic Export Directory TimeDateStamp 0x${exportTimeDateStamp.toString(16)} in ${label}`
      );
    }
    const dllNameRva = buf.readUInt32LE(exportDirOff + 12);
    internalDllName = readAsciiCString(buf, rvaToFileOffset(sections, dllNameRva));
    if (expectedDllName && internalDllName.toLowerCase() !== expectedDllName.toLowerCase()) {
      throw new Error(
        `Export table internal DLL name mismatch: got "${internalDllName}", expected "${expectedDllName}"`
      );
    }
    const numberOfNames = buf.readUInt32LE(exportDirOff + 24);
    const addressOfNamesRva = buf.readUInt32LE(exportDirOff + 32);
    const namesTableOff = rvaToFileOffset(sections, addressOfNamesRva);
    if (namesTableOff < 0 || namesTableOff + numberOfNames * 4 > buf.length) {
      throw new Error(`Invalid Export AddressOfNames table in ${label}`);
    }
    for (let i = 0; i < numberOfNames; i += 1) {
      const nameRva = buf.readUInt32LE(namesTableOff + i * 4);
      exportedNames.push(readAsciiCString(buf, rvaToFileOffset(sections, nameRva)));
    }
    for (const req of expectedExports) {
      if (!exportedNames.includes(req)) {
        throw new Error(`Missing required export "${req}" in ${label} (found: ${exportedNames.join(', ')})`);
      }
    }
  }

  const importedDlls = [];
  if (importDirRva !== 0 && importDirSize >= 20) {
    let impOff = rvaToFileOffset(sections, importDirRva);
    while (impOff >= 0 && impOff + 20 <= buf.length) {
      const nameRva = buf.readUInt32LE(impOff + 12);
      const firstThunk = buf.readUInt32LE(impOff + 16);
      if (nameRva === 0 && firstThunk === 0) break;
      if (nameRva !== 0) {
        const impName = readAsciiCString(buf, rvaToFileOffset(sections, nameRva));
        if (impName) importedDlls.push(impName.toLowerCase());
      }
      impOff += 20;
    }
  }

  for (const imp of importedDlls) {
    if (
      imp.startsWith('libgcc') ||
      imp.startsWith('libwinpthread') ||
      imp.startsWith('libstdc++')
    ) {
      throw new Error(`Forbidden MinGW runtime DLL dependency "${imp}" in ${label}`);
    }
    if (Array.isArray(allowedImportPatterns) && allowedImportPatterns.length > 0) {
      const ok = allowedImportPatterns.some((rx) => rx.test(imp));
      if (!ok) {
        throw new Error(`Unexpected DLL import "${imp}" in ${label} (imports: ${importedDlls.join(', ')})`);
      }
    }
  }

  if (expectedMarker && !buf.includes(Buffer.from(expectedMarker, 'ascii'))) {
    throw new Error(`Missing clean-room marker "${expectedMarker}" in ${label}`);
  }

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    sizeBytes: buf.length,
    sha256,
    machine: `0x${machine.toString(16)}`,
    subsystem,
    peCheckSum: `0x${headerCheckSum.toString(16).padStart(8, '0')}`,
    internalDllName,
    exportedCount: exportedNames.length,
    exportedNames,
    importedDlls,
    sections: sections.map((s) => s.name),
  };
}

function verifySidecarSha256(sidecarPath, expectedSha256, label) {
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(`Missing SHA-256 sidecar file for ${label}: ${sidecarPath}`);
  }
  const recordedSha = fs.readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0];
  if (recordedSha !== expectedSha256) {
    throw new Error(
      `SHA-256 mismatch for ${label}: sidecar=${recordedSha} actual=${expectedSha256}`
    );
  }
}

function computeSourceManifestDigests() {
  const out = {};
  for (const rel of TRACKED_MANIFEST_SOURCES) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`Missing tracked display scaler source file: ${abs}`);
    }
    const normalizedText = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    out[rel] = crypto.createHash('sha256').update(Buffer.from(normalizedText, 'utf8')).digest('hex');
  }
  return out;
}

const SCALER_DLL_ALLOWED_IMPORTS = [
  /^kernel32\.dll$/,
  /^user32\.dll$/,
  /^gdi32\.dll$/,
  /^msvcrt\.dll$/,
  /^ucrtbase\.dll$/,
  /^api-ms-win-crt-.*\.dll$/,
];

const LAUNCHER_EXE_ALLOWED_IMPORTS = [
  /^kernel32\.dll$/,
  /^msvcrt\.dll$/,
  /^ucrtbase\.dll$/,
  /^api-ms-win-crt-.*\.dll$/,
];

function verifyScalerX86Dll(dllPath = SCALER_DLL_X86_PATH) {
  return parseAndVerifyPeImage(dllPath, {
    expectedMachine: 0x014c,
    expectDll: true,
    expectedExports: EXPECTED_SCALER_EXPORTS,
    expectedMarker: EXPECTED_SCALER_MARKER,
    expectedDllName: EXPECTED_SCALER_DLL_INTERNAL_NAME,
    allowedImportPatterns: SCALER_DLL_ALLOWED_IMPORTS,
  });
}

function verifyScalerX64Dll(dllPath = SCALER_DLL_X64_PATH) {
  return parseAndVerifyPeImage(dllPath, {
    expectedMachine: 0x8664,
    expectDll: true,
    expectedExports: EXPECTED_SCALER_EXPORTS,
    expectedMarker: EXPECTED_SCALER_MARKER,
    expectedDllName: EXPECTED_SCALER_DLL_INTERNAL_NAME,
    allowedImportPatterns: SCALER_DLL_ALLOWED_IMPORTS,
  });
}

function verifyLauncherX86Exe(exePath = LAUNCHER_EXE_X86_PATH) {
  return parseAndVerifyPeImage(exePath, {
    expectedMachine: 0x014c,
    expectDll: false,
    expectedSubsystem: 2,
    expectedMarker: EXPECTED_LAUNCHER_MARKER,
    allowedImportPatterns: LAUNCHER_EXE_ALLOWED_IMPORTS,
  });
}

function verifyLauncherX64Exe(exePath = LAUNCHER_EXE_X64_PATH) {
  return parseAndVerifyPeImage(exePath, {
    expectedMachine: 0x8664,
    expectDll: false,
    expectedSubsystem: 2,
    expectedMarker: EXPECTED_LAUNCHER_MARKER,
    allowedImportPatterns: LAUNCHER_EXE_ALLOWED_IMPORTS,
  });
}

function cleanTransientLinkerOutputs() {
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (name.endsWith('.lib') || name.endsWith('.pdb') || name.endsWith('.exp')) {
      fs.rmSync(path.join(OUT_DIR, name), { force: true });
    }
  }
}

function buildManifestObject({ compilerVersion, scalerX86, scalerX64, launcherX86, launcherX64 }) {
  return {
    schemaVersion: 1,
    toolchain: {
      compiler: 'zig cc',
      zigVersion: compilerVersion || 'unknown',
      targets: ['x86-windows-gnu', 'x86_64-windows-gnu'],
      flags: ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fno-ident', '-Wl,--strip-all'],
    },
    sources: computeSourceManifestDigests(),
    outputs: {
      'one_display_scaler_x86.dll': {
        sha256: scalerX86.sha256,
        sizeBytes: scalerX86.sizeBytes,
        machine: scalerX86.machine,
        peCheckSum: scalerX86.peCheckSum,
        exportedCount: scalerX86.exportedCount,
      },
      'one_display_scaler_x64.dll': {
        sha256: scalerX64.sha256,
        sizeBytes: scalerX64.sizeBytes,
        machine: scalerX64.machine,
        peCheckSum: scalerX64.peCheckSum,
        exportedCount: scalerX64.exportedCount,
      },
      'one_display_launcher_x86.exe': {
        sha256: launcherX86.sha256,
        sizeBytes: launcherX86.sizeBytes,
        machine: launcherX86.machine,
        subsystem: launcherX86.subsystem,
        peCheckSum: launcherX86.peCheckSum,
      },
      'one_display_launcher_x64.exe': {
        sha256: launcherX64.sha256,
        sizeBytes: launcherX64.sizeBytes,
        machine: launcherX64.machine,
        subsystem: launcherX64.subsystem,
        peCheckSum: launcherX64.peCheckSum,
      },
    },
  };
}

function verifyDisplayScalerManifest({ scalerX86, scalerX64, launcherX86, launcherX64 }) {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Missing display scaler manifest: ${MANIFEST_PATH}`);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const currentSources = computeSourceManifestDigests();
  for (const [rel, sha] of Object.entries(currentSources)) {
    if (!manifest.sources || manifest.sources[rel] !== sha) {
      throw new Error(
        `Manifest source digest stale for ${rel}: manifest=${manifest.sources && manifest.sources[rel]} current=${sha}`
      );
    }
  }
  const expectedMap = {
    'one_display_scaler_x86.dll': scalerX86.sha256,
    'one_display_scaler_x64.dll': scalerX64.sha256,
    'one_display_launcher_x86.exe': launcherX86.sha256,
    'one_display_launcher_x64.exe': launcherX64.sha256,
  };
  for (const [binName, sha] of Object.entries(expectedMap)) {
    const rec = manifest.outputs && manifest.outputs[binName];
    if (!rec || rec.sha256 !== sha) {
      throw new Error(
        `Manifest output digest mismatch for ${binName}: manifest=${rec && rec.sha256} actual=${sha}`
      );
    }
  }
  return manifest;
}

function verifyDisplayScalerBinaries() {
  const scalerX86 = verifyScalerX86Dll();
  verifySidecarSha256(SCALER_SHA256_X86_PATH, scalerX86.sha256, 'one_display_scaler_x86.dll');

  const scalerX64 = verifyScalerX64Dll();
  verifySidecarSha256(SCALER_SHA256_X64_PATH, scalerX64.sha256, 'one_display_scaler_x64.dll');

  const launcherX86 = verifyLauncherX86Exe();
  verifySidecarSha256(LAUNCHER_SHA256_X86_PATH, launcherX86.sha256, 'one_display_launcher_x86.exe');

  const launcherX64 = verifyLauncherX64Exe();
  verifySidecarSha256(LAUNCHER_SHA256_X64_PATH, launcherX64.sha256, 'one_display_launcher_x64.exe');

  verifyDisplayScalerManifest({ scalerX86, scalerX64, launcherX86, launcherX64 });

  return {
    manifestPath: MANIFEST_PATH,
    scalerX86: { path: SCALER_DLL_X86_PATH, sha256Path: SCALER_SHA256_X86_PATH, ...scalerX86 },
    scalerX64: { path: SCALER_DLL_X64_PATH, sha256Path: SCALER_SHA256_X64_PATH, ...scalerX64 },
    launcherX86: { path: LAUNCHER_EXE_X86_PATH, sha256Path: LAUNCHER_SHA256_X86_PATH, ...launcherX86 },
    launcherX64: { path: LAUNCHER_EXE_X64_PATH, sha256Path: LAUNCHER_SHA256_X64_PATH, ...launcherX64 },
  };
}

function compileSingleTarget({
  zigBin,
  targetTriple,
  isDll,
  sources,
  defFile = null,
  extraLinkerFlags = [],
  libs = [],
  stagedName,
  finalOutPath,
  sha256OutPath,
  verifyFn,
}) {
  const stageDir = fs.mkdtempSync(path.join(OUT_DIR, '.ds-pe-stage-'));
  const stagedPath = path.join(stageDir, stagedName);
  const srcPaths = sources.map((f) => path.join(SRC_DIR, f));

  const args = [
    'cc',
    '-target',
    targetTriple,
    ...(isDll ? ['-shared'] : []),
    '-std=c11',
    '-Os',
    '-ffunction-sections',
    '-fdata-sections',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-fno-ident',
    `-ffile-prefix-map=${REPO_ROOT}=.`,
    `-I${SRC_DIR}`,
    ...srcPaths,
    ...(defFile ? [defFile] : []),
    ...(!isDll ? ['-Wl,--subsystem,windows'] : []),
    ...extraLinkerFlags,
    '-Wl,--gc-sections',
    '-Wl,--strip-all',
    ...libs,
    '-o',
    stagedPath,
  ];

  try {
    execFileSync(zigBin, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    fs.renameSync(stagedPath, finalOutPath);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  cleanTransientLinkerOutputs();
  normalizePeDeterminism(finalOutPath);
  const info = verifyFn(finalOutPath);
  const baseFileName = path.basename(finalOutPath);
  fs.writeFileSync(sha256OutPath, `${info.sha256}  ${baseFileName}\n`, 'utf8');
  return {
    path: finalOutPath,
    sha256Path: sha256OutPath,
    ...info,
  };
}

function buildDisplayScalerBinaries({ forceRebuild = false } = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (!forceRebuild) {
    try {
      const verified = verifyDisplayScalerBinaries();
      return {
        prebuiltVerified: true,
        ...verified,
      };
    } catch {
      // Proceed to compile via Zig
    }
  }

  const zigBin = resolveZigBinary({ optional: false });
  const x86Cfg = resolveX86WinGnuToolchain(zigBin);
  const defPath = path.join(SRC_DIR, 'display_scaler.def');

  const scalerX86 = compileSingleTarget({
    zigBin,
    targetTriple: x86Cfg.targetTriple,
    isDll: true,
    sources: SCALER_DLL_SOURCES,
    defFile: defPath,
    extraLinkerFlags: x86Cfg.extraLinkerFlags,
    libs: ['-lkernel32', '-luser32', '-lgdi32'],
    stagedName: EXPECTED_SCALER_DLL_INTERNAL_NAME,
    finalOutPath: SCALER_DLL_X86_PATH,
    sha256OutPath: SCALER_SHA256_X86_PATH,
    verifyFn: verifyScalerX86Dll,
  });

  const scalerX64 = compileSingleTarget({
    zigBin,
    targetTriple: 'x86_64-windows-gnu',
    isDll: true,
    sources: SCALER_DLL_SOURCES,
    defFile: defPath,
    extraLinkerFlags: [],
    libs: ['-lkernel32', '-luser32', '-lgdi32'],
    stagedName: EXPECTED_SCALER_DLL_INTERNAL_NAME,
    finalOutPath: SCALER_DLL_X64_PATH,
    sha256OutPath: SCALER_SHA256_X64_PATH,
    verifyFn: verifyScalerX64Dll,
  });

  const launcherX86 = compileSingleTarget({
    zigBin,
    targetTriple: x86Cfg.targetTriple,
    isDll: false,
    sources: LAUNCHER_EXE_SOURCES,
    extraLinkerFlags: [],
    libs: ['-lkernel32'],
    stagedName: 'one_display_launcher_x86.exe',
    finalOutPath: LAUNCHER_EXE_X86_PATH,
    sha256OutPath: LAUNCHER_SHA256_X86_PATH,
    verifyFn: verifyLauncherX86Exe,
  });

  const launcherX64 = compileSingleTarget({
    zigBin,
    targetTriple: 'x86_64-windows-gnu',
    isDll: false,
    sources: LAUNCHER_EXE_SOURCES,
    extraLinkerFlags: [],
    libs: ['-lkernel32'],
    stagedName: 'one_display_launcher_x64.exe',
    finalOutPath: LAUNCHER_EXE_X64_PATH,
    sha256OutPath: LAUNCHER_SHA256_X64_PATH,
    verifyFn: verifyLauncherX64Exe,
  });

  const compilerVersion = getZigVersion(zigBin);
  const manifest = buildManifestObject({
    compilerVersion,
    scalerX86,
    scalerX64,
    launcherX86,
    launcherX64,
  });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    zigBin,
    compilerVersion,
    manifestPath: MANIFEST_PATH,
    scalerX86,
    scalerX64,
    launcherX86,
    launcherX64,
  };
}

if (require.main === module) {
  const verifyOnly = process.argv.includes('--verify') || process.argv.includes('--verify-only');
  const forceRebuild = process.argv.includes('--force-rebuild');
  const res = verifyOnly
    ? verifyDisplayScalerBinaries()
    : buildDisplayScalerBinaries({ forceRebuild });
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
  SCALER_DLL_X86_PATH,
  SCALER_SHA256_X86_PATH,
  SCALER_DLL_X64_PATH,
  SCALER_SHA256_X64_PATH,
  LAUNCHER_EXE_X86_PATH,
  LAUNCHER_SHA256_X86_PATH,
  LAUNCHER_EXE_X64_PATH,
  LAUNCHER_SHA256_X64_PATH,
  MANIFEST_PATH,
  EXPECTED_SCALER_DLL_INTERNAL_NAME,
  EXPECTED_SCALER_EXPORTS,
  EXPECTED_SCALER_MARKER,
  EXPECTED_LAUNCHER_MARKER,
  MAX_BINARY_SIZE_BYTES,
  resolveZigBinary,
  computePeCheckSum,
  normalizePeDeterminism,
  parseAndVerifyPeImage,
  computeSourceManifestDigests,
  verifyScalerX86Dll,
  verifyScalerX64Dll,
  verifyLauncherX86Exe,
  verifyLauncherX64Exe,
  verifyDisplayScalerBinaries,
  buildDisplayScalerBinaries,
};
