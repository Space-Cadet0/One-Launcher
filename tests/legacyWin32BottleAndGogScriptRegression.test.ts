import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { scanContentForPiiViolations } from './helpers/piiHygieneGuard';

const requireCjs = createRequire(import.meta.url);
const binaryInspectors = requireCjs('../electron/launcher/binaryAndManifestInspectors.cjs');
const gogScriptInterpreter = requireCjs('../electron/storefronts/gog/gogScriptInterpreter.cjs');
const gogDirectInstaller = requireCjs('../electron/launcher/gogRegistryAndDirectInstaller.cjs');
const macInstaller = requireCjs('../electron/launcher/macNativeInstallerAndCodesign.cjs');
const sessionSupervisor = requireCjs('../electron/launcher/sessionAndProcessSupervisor.cjs');
const engineStateRegistry = requireCjs('../electron/launcher/engineStateRegistry.cjs');
const wineManager = requireCjs('../electron/launcher/wineAndCrossOverManager.cjs');
const xboxConfigAndIds = requireCjs('../electron/storefronts/xbox/xboxConfigAndIds.cjs');
const buildXboxBridge = requireCjs('../scripts/build-xbox-bridge.cjs');

// ============================================================================
// Hermetic Offline Socket Guard (permits 127.0.0.1 / ::1 loopback RPC only)
// ============================================================================

function installHermeticOfflineSocketGuard() {
  const origConnect = net.Socket.prototype.connect;
  return vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const first = args[0];
    const host =
      typeof first === 'object' && first !== null && 'host' in first
        ? String((first as { host?: string }).host || '127.0.0.1')
        : typeof args[1] === 'string'
          ? args[1]
          : '127.0.0.1';
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    const isUnixPipe =
      typeof first === 'string' ||
      (typeof first === 'object' && first !== null && 'path' in first);
    if (!isLoopback && !isUnixPipe) {
      throw new Error(`Hermetic test guard blocked outbound TCP connection to "${host}"`);
    }
    return (origConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  });
}

// ============================================================================
// Deterministic Synthetic PE32 (0x014c) & PE32+ (0x8664) Binary Builder
// Real COFF section headers + IMAGE_DIRECTORY_ENTRY_IMPORT + EXPORT forwarders
// ============================================================================

interface SyntheticPeBuildOptions {
  arch: 'x86' | 'x64';
  isDll?: boolean;
  importedDlls?: string[];
  exportForwarders?: string[];
  nonForwardedExportCount?: number;
  idataRawOffset?: number;
  internalDllName?: string;
  embeddedAsciiStrings?: string[];
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function buildSyntheticPeImage(opts: SyntheticPeBuildOptions): Buffer {
  const isPe32 = opts.arch === 'x86';
  const machine = isPe32 ? 0x014c : 0x8664;
  const optMagic = isPe32 ? 0x010b : 0x020b;
  const sizeOfOptionalHeader = isPe32 ? 224 : 240;
  const importedDlls = opts.importedDlls ?? [];
  const exportForwarders = opts.exportForwarders ?? [];
  const nonForwardedExportCount = opts.nonForwardedExportCount ?? 0;
  const totalExports = exportForwarders.length + nonForwardedExportCount;
  const embeddedStrings = opts.embeddedAsciiStrings ?? [];

  // Build .text payload
  const textChunks: Buffer[] = [Buffer.from([0x31, 0xc0, 0xc3, 0x90])];
  for (const s of embeddedStrings) {
    textChunks.push(Buffer.from(`${s}\0`, 'ascii'));
  }
  const textPayload = Buffer.concat(textChunks);
  const textRawOffset = 0x0400;
  const textRawSize = alignUp(Math.max(0x0200, textPayload.length), 0x0200);
  const textRva = 0x1000;

  // Build .idata payload (IMAGE_IMPORT_DESCRIPTOR array + thunk table + ASCII DLL names)
  const hasImports = importedDlls.length > 0;
  const idataRva = 0x20000;
  const idataRawOffset = Math.max(
    textRawOffset + textRawSize,
    alignUp(opts.idataRawOffset ?? 0x0800, 0x0200)
  );
  let idataPayload: Buffer = Buffer.alloc(0);
  if (hasImports) {
    const descriptorTableBytes = (importedDlls.length + 1) * 20;
    const thunkEntrySize = isPe32 ? 4 : 8;
    const thunkTableOffset = descriptorTableBytes;
    const thunkTableBytes = importedDlls.length * (thunkEntrySize * 2);
    const stringsStartOffset = thunkTableOffset + thunkTableBytes;

    const stringBuffers: Buffer[] = [];
    const nameRelOffsets: number[] = [];
    let cursor = stringsStartOffset;
    for (const dllName of importedDlls) {
      nameRelOffsets.push(cursor);
      const nb = Buffer.from(`${dllName}\0`, 'ascii');
      stringBuffers.push(nb);
      cursor += nb.length;
      // Add synthetic hint/name entry ("Fn0") for the import thunk
      const hintName = Buffer.from([0x00, 0x00, 0x46, 0x6e, 0x30, 0x00]);
      stringBuffers.push(hintName);
      cursor += hintName.length;
    }

    idataPayload = Buffer.alloc(cursor, 0);
    let hintCursor = stringsStartOffset;
    for (let i = 0; i < importedDlls.length; i += 1) {
      const descOff = i * 20;
      const thunkOff = thunkTableOffset + i * (thunkEntrySize * 2);
      const dllNameLen = Buffer.byteLength(importedDlls[i], 'ascii') + 1;
      const hintRva = idataRva + hintCursor + dllNameLen;
      hintCursor += dllNameLen + 6;

      idataPayload.writeUInt32LE(idataRva + thunkOff, descOff + 0); // OriginalFirstThunk
      idataPayload.writeUInt32LE(0, descOff + 4); // TimeDateStamp
      idataPayload.writeUInt32LE(0, descOff + 8); // ForwarderChain
      idataPayload.writeUInt32LE(idataRva + nameRelOffsets[i], descOff + 12); // Name RVA
      idataPayload.writeUInt32LE(idataRva + thunkOff, descOff + 16); // FirstThunk
      idataPayload.writeUInt32LE(hintRva, thunkOff);
    }
    Buffer.concat(stringBuffers).copy(idataPayload, stringsStartOffset);
  }
  const idataRawSize = hasImports ? alignUp(Math.max(0x0200, idataPayload.length), 0x0200) : 0;

  // Build .edata payload (IMAGE_EXPORT_DIRECTORY + AddressOfFunctions + forwarder strings)
  const hasExports = totalExports > 0;
  const edataRva = 0x30000;
  const edataRawOffset = hasImports ? idataRawOffset + idataRawSize : textRawOffset + textRawSize;
  let edataPayload: Buffer = Buffer.alloc(0);
  if (hasExports) {
    const expHeaderSize = 40;
    const funcsOffset = expHeaderSize;
    const funcsBytes = totalExports * 4;
    const namesOffset = funcsOffset + funcsBytes;
    const namesBytes = totalExports * 4;
    const ordinalsOffset = namesOffset + namesBytes;
    const ordinalsBytes = alignUp(totalExports * 2, 4);
    let strCursor = ordinalsOffset + ordinalsBytes;

    const extraStrings: Buffer[] = [];
    const internalNameOff = strCursor;
    const internalNameBuf = Buffer.from(
      `${opts.internalDllName || 'synthetic_module.dll'}\0`,
      'ascii'
    );
    extraStrings.push(internalNameBuf);
    strCursor += internalNameBuf.length;

    const exportNameRelOffsets: number[] = [];
    for (let i = 0; i < totalExports; i += 1) {
      exportNameRelOffsets.push(strCursor);
      const nb = Buffer.from(`SynthExport${i}\0`, 'ascii');
      extraStrings.push(nb);
      strCursor += nb.length;
    }

    const forwarderRelOffsets: number[] = [];
    for (const fwd of exportForwarders) {
      forwarderRelOffsets.push(strCursor);
      const fb = Buffer.from(`${fwd}\0`, 'ascii');
      extraStrings.push(fb);
      strCursor += fb.length;
    }

    edataPayload = Buffer.alloc(strCursor, 0);
    edataPayload.writeUInt32LE(edataRva + internalNameOff, 12); // Name RVA
    edataPayload.writeUInt32LE(1, 16); // Base
    edataPayload.writeUInt32LE(totalExports, 20); // NumberOfFunctions
    edataPayload.writeUInt32LE(totalExports, 24); // NumberOfNames
    edataPayload.writeUInt32LE(edataRva + funcsOffset, 28); // AddressOfFunctions
    edataPayload.writeUInt32LE(edataRva + namesOffset, 32); // AddressOfNames
    edataPayload.writeUInt32LE(edataRva + ordinalsOffset, 36); // AddressOfNameOrdinals

    for (let i = 0; i < nonForwardedExportCount; i += 1) {
      // Points into .text RVA (outside [edataRva, edataRva + exportSize)) -> non-forwarded export
      edataPayload.writeUInt32LE(textRva + i * 4, funcsOffset + i * 4);
    }
    for (let j = 0; j < exportForwarders.length; j += 1) {
      const fnIdx = nonForwardedExportCount + j;
      // Points inside [edataRva, edataRva + exportSize) -> PE export forwarder string!
      edataPayload.writeUInt32LE(edataRva + forwarderRelOffsets[j], funcsOffset + fnIdx * 4);
    }
    for (let i = 0; i < totalExports; i += 1) {
      edataPayload.writeUInt32LE(edataRva + exportNameRelOffsets[i], namesOffset + i * 4);
      edataPayload.writeUInt16LE(i, ordinalsOffset + i * 2);
    }
    Buffer.concat(extraStrings).copy(edataPayload, ordinalsOffset + ordinalsBytes);
  }
  const edataRawSize = hasExports ? alignUp(Math.max(0x0200, edataPayload.length), 0x0200) : 0;

  const sections: Array<{
    name: string;
    virtualSize: number;
    virtualAddress: number;
    rawSize: number;
    rawOffset: number;
    characteristics: number;
    payload: Buffer;
  }> = [
    {
      name: '.text',
      virtualSize: textPayload.length,
      virtualAddress: textRva,
      rawSize: textRawSize,
      rawOffset: textRawOffset,
      characteristics: 0x60000020,
      payload: textPayload,
    },
  ];
  if (hasImports) {
    sections.push({
      name: '.idata',
      virtualSize: idataPayload.length,
      virtualAddress: idataRva,
      rawSize: idataRawSize,
      rawOffset: idataRawOffset,
      characteristics: 0x40000040,
      payload: idataPayload,
    });
  }
  if (hasExports) {
    sections.push({
      name: '.edata',
      virtualSize: edataPayload.length,
      virtualAddress: edataRva,
      rawSize: edataRawSize,
      rawOffset: edataRawOffset,
      characteristics: 0x40000040,
      payload: edataPayload,
    });
  }

  const lastSec = sections[sections.length - 1];
  const totalFileSize = lastSec.rawOffset + lastSec.rawSize;
  const image = Buffer.alloc(totalFileSize, 0);

  // DOS Header
  image[0] = 0x4d; // 'M'
  image[1] = 0x5a; // 'Z'
  const peOffset = 0x80;
  image.writeUInt32LE(peOffset, 0x3c);

  // PE Signature + COFF File Header (24 bytes)
  image.writeUInt32LE(0x00004550, peOffset); // 'PE\0\0'
  image.writeUInt16LE(machine, peOffset + 4);
  image.writeUInt16LE(sections.length, peOffset + 6);
  image.writeUInt32LE(0, peOffset + 8); // TimeDateStamp
  image.writeUInt16LE(sizeOfOptionalHeader, peOffset + 20);
  const coffChars =
    0x0002 | (isPe32 ? 0x0100 : 0x0020) | (opts.isDll ? 0x2000 : 0);
  image.writeUInt16LE(coffChars, peOffset + 22);

  // Optional Header
  const optOffset = peOffset + 24;
  image.writeUInt16LE(optMagic, optOffset);
  image.writeUInt32LE(textRva, optOffset + 16); // AddressOfEntryPoint
  if (isPe32) {
    image.writeUInt32LE(0x00400000, optOffset + 28); // ImageBase (PE32)
  } else {
    image.writeBigUInt64LE(0x0000000140000000n, optOffset + 24); // ImageBase (PE32+)
  }
  image.writeUInt32LE(0x1000, optOffset + 32); // SectionAlignment
  image.writeUInt32LE(0x0200, optOffset + 36); // FileAlignment
  image.writeUInt32LE(0x40000, optOffset + 56); // SizeOfImage
  image.writeUInt32LE(textRawOffset, optOffset + 60); // SizeOfHeaders
  image.writeUInt16LE(2, optOffset + 68); // Subsystem = IMAGE_SUBSYSTEM_WINDOWS_GUI

  const numRvaOffset = isPe32 ? optOffset + 92 : optOffset + 108;
  const dataDirOffset = isPe32 ? optOffset + 96 : optOffset + 112;
  image.writeUInt32LE(16, numRvaOffset);
  if (hasExports) {
    image.writeUInt32LE(edataRva, dataDirOffset + 0);
    image.writeUInt32LE(edataPayload.length, dataDirOffset + 4);
  }
  if (hasImports) {
    image.writeUInt32LE(idataRva, dataDirOffset + 8);
    image.writeUInt32LE(idataPayload.length, dataDirOffset + 12);
  }

  // COFF Section Headers
  const secTableOffset = optOffset + sizeOfOptionalHeader;
  for (let i = 0; i < sections.length; i += 1) {
    const sec = sections[i];
    const shOff = secTableOffset + i * 40;
    Buffer.from(sec.name.slice(0, 8), 'ascii').copy(image, shOff);
    image.writeUInt32LE(sec.virtualSize, shOff + 8);
    image.writeUInt32LE(sec.virtualAddress, shOff + 12);
    image.writeUInt32LE(sec.rawSize, shOff + 16);
    image.writeUInt32LE(sec.rawOffset, shOff + 20);
    image.writeUInt32LE(sec.characteristics, shOff + 36);
    sec.payload.copy(image, sec.rawOffset);
  }

  return image;
}

class MockChildProcess extends EventEmitter {
  pid: number;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;

  constructor(pid = 51001) {
    super();
    this.pid = pid;
  }

  kill() {
    this.killed = true;
    this.emit('exit', 0, null);
    this.emit('close', 0, null);
    return true;
  }

  unref() {}
}

function createSyntheticBottle(bottleDir: string): void {
  fs.mkdirSync(path.join(bottleDir, 'drive_c', 'windows', 'system32'), { recursive: true });
  fs.mkdirSync(path.join(bottleDir, 'drive_c', 'windows', 'syswow64'), { recursive: true });
  fs.mkdirSync(path.join(bottleDir, 'drive_c', 'users', 'crossover', 'AppData', 'Local'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(bottleDir, 'cxbottle.conf'),
    '[Bottle]\n"WineArch" = "win64"\n\n[EnvironmentVariables]\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(bottleDir, 'system.reg'),
    'WINE REGISTRY Version 2\n;; All keys relative to \\\\Machine\n\n[Software\\\\Microsoft\\\\Windows NT\\\\CurrentVersion] 1700000000\n"CurrentBuild"="19045"\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(bottleDir, 'user.reg'),
    'WINE REGISTRY Version 2\n;; All keys relative to \\\\User\\\\S-1-5-21-0-0-0-1000\n\n[Software\\\\Wine\\\\Drivers] 1700000000\n"Audio"="coreaudio"\n',
    'utf8'
  );
}

// ============================================================================
// Comprehensive Dual-OS Regression Suite (Legacy Win32, GOG .script, WoW64 & Xbox x86)
// ============================================================================

describe('Universal Legacy Win32, GOG .script, WoW64 Display/GL & Dual-Arch Xbox Regression Suite', () => {
  const tempDirs: string[] = [];
  let socketGuard: ReturnType<typeof installHermeticOfflineSocketGuard>;

  function makeTempDir(label: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ol-legacy-win32-${label}-`));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    socketGuard = installHermeticOfflineSocketGuard();
  });

  afterEach(async () => {
    const activeMap = engineStateRegistry.activeSessions as Map<string, Record<string, unknown>>;
    for (const [gameId, entry] of Array.from(activeMap.entries())) {
      if (entry?.pollTimer) {
        clearInterval(entry.pollTimer as NodeJS.Timeout);
      }
      const loopback = entry?.xboxLoopbackServer as { close?: () => Promise<void> } | undefined;
      if (loopback?.close) {
        await loopback.close().catch(() => {});
      }
      activeMap.delete(gameId);
    }
    await sessionSupervisor.waitForActivePostSessionWork(1500).catch(() => {});
    socketGuard.mockRestore();
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
  });

  // --------------------------------------------------------------------------
  // 1. PE Import/Export & launcher_settings.cfg Capability Inspector
  // --------------------------------------------------------------------------
  describe('1. PE Import/Export & launcher_settings.cfg Capability Inspector (binaryAndManifestInspectors.cjs)', () => {
    it('extracts PE32 (0x014c) and PE32+ (0x8664) machine arch + importedDlls even when .idata is past 4 KB (at 40 KB)', () => {
      const dir = makeTempDir('pe-imports-40kb');
      const glExe32Path = path.join(dir, 'Engine32GL.exe');
      const ddrawExe32Path = path.join(dir, 'SpaceSim97.exe');
      const dx12Exe64Path = path.join(dir, 'ModernEngine64.exe');

      fs.writeFileSync(
        glExe32Path,
        buildSyntheticPeImage({
          arch: 'x86',
          importedDlls: ['OPENGL32.dll', 'WINMM.dll', 'KERNEL32.dll'],
          idataRawOffset: 40 * 1024, // 40 KB raw file offset (well past 4 KB!)
        })
      );
      fs.writeFileSync(
        ddrawExe32Path,
        buildSyntheticPeImage({
          arch: 'x86',
          importedDlls: ['DDRAW.dll', 'USER32.dll'],
          idataRawOffset: 44 * 1024,
        })
      );
      fs.writeFileSync(
        dx12Exe64Path,
        buildSyntheticPeImage({
          arch: 'x64',
          importedDlls: ['d3d12.dll', 'dxgi.dll', 'kernel32.dll'],
          idataRawOffset: 48 * 1024,
        })
      );

      expect(fs.statSync(glExe32Path).size).toBeGreaterThan(40 * 1024);
      expect(fs.statSync(dx12Exe64Path).size).toBeGreaterThan(48 * 1024);

      const glHeader = binaryInspectors.inspectWindowsExecutableHeader(glExe32Path, {
        strictPe: true,
      });
      expect(glHeader.isValidPe).toBe(true);
      expect(glHeader.isX86).toBe(true);
      expect(glHeader.is64Bit).toBe(false);
      expect(glHeader.machine).toBe(0x014c);
      expect(glHeader.machineHex).toBe('0x014c');
      expect(glHeader.importedDlls).toEqual(['opengl32.dll', 'winmm.dll', 'kernel32.dll']);

      const glCaps = binaryInspectors.inspectPeCapabilities(glExe32Path, { strictPe: true });
      expect(glCaps.machineArch).toBe('x86');
      expect(glCaps.importedDlls).toContain('opengl32.dll');
      expect(glCaps.importedDlls).toContain('winmm.dll');

      const ddrawCaps = binaryInspectors.inspectPeCapabilities(ddrawExe32Path, { strictPe: true });
      expect(ddrawCaps.machineArch).toBe('x86');
      expect(ddrawCaps.importedDlls).toEqual(['ddraw.dll', 'user32.dll']);

      const dx12Caps = binaryInspectors.inspectPeCapabilities(dx12Exe64Path, { strictPe: true });
      expect(dx12Caps.machineArch).toBe('x64');
      expect(dx12Caps.isX64).toBe(true);
      expect(dx12Caps.is64Bit).toBe(true);
      expect(dx12Caps.machine).toBe(0x8664);
      expect(dx12Caps.importedDlls).toEqual(['d3d12.dll', 'dxgi.dll', 'kernel32.dll']);

      // Verify parity with wineAndCrossOverManager.inspectPeBinaryImportsSync on 40 KB+ .idata
      const wineImp32 = wineManager.inspectPeBinaryImportsSync(glExe32Path);
      expect(wineImp32.validPe).toBe(true);
      expect(wineImp32.machine).toBe('x86');
      expect(wineImp32.importedDlls).toEqual(['opengl32.dll', 'winmm.dll', 'kernel32.dll']);

      const wineImp64 = wineManager.inspectPeBinaryImportsSync(dx12Exe64Path);
      expect(wineImp64.validPe).toBe(true);
      expect(wineImp64.machine).toBe('x64');
      expect(wineImp64.importedDlls).toEqual(['d3d12.dll', 'dxgi.dll', 'kernel32.dll']);
    });

    it('detects malformed backslash PE export forwarders (C:\\Windows\\System32\\winmm.GetJoystick) vs clean forwarders and non-forwarded exports', () => {
      const dir = makeTempDir('pe-export-forwarders');
      const brokenXpProxyDll = path.join(dir, 'winmm_legacy_xp.dll');
      const validWin10ProxyDll = path.join(dir, 'winmm_w10.dll');
      const pureCodeDll = path.join(dir, 'pure_exports.dll');

      fs.writeFileSync(
        brokenXpProxyDll,
        buildSyntheticPeImage({
          arch: 'x86',
          isDll: true,
          nonForwardedExportCount: 1,
          exportForwarders: [
            'WINMM.timeGetTime',
            'C:\\Windows\\System32\\winmm.GetJoystick',
          ],
        })
      );
      fs.writeFileSync(
        validWin10ProxyDll,
        buildSyntheticPeImage({
          arch: 'x86',
          isDll: true,
          nonForwardedExportCount: 2,
          exportForwarders: ['WINMM.timeGetTime', 'WINMM.joyGetPosEx'],
        })
      );
      fs.writeFileSync(
        pureCodeDll,
        buildSyntheticPeImage({
          arch: 'x86',
          isDll: true,
          nonForwardedExportCount: 4,
          exportForwarders: [],
        })
      );

      expect(binaryInspectors.hasMalformedBackslashExportForwarder(brokenXpProxyDll)).toBe(true);
      const brokenInfo = binaryInspectors.inspectPeExportForwarders(brokenXpProxyDll);
      expect(brokenInfo.isValidPe).toBe(true);
      expect(brokenInfo.hasMalformedBackslashForwarder).toBe(true);
      expect(brokenInfo.forwarders).toContain('C:\\Windows\\System32\\winmm.GetJoystick');

      expect(binaryInspectors.hasMalformedBackslashExportForwarder(validWin10ProxyDll)).toBe(false);
      const validInfo = binaryInspectors.inspectPeExportForwarders(validWin10ProxyDll);
      expect(validInfo.isValidPe).toBe(true);
      expect(validInfo.hasMalformedBackslashForwarder).toBe(false);
      expect(validInfo.forwarders).toEqual(['WINMM.timeGetTime', 'WINMM.joyGetPosEx']);

      expect(binaryInspectors.hasMalformedBackslashExportForwarder(pureCodeDll)).toBe(false);
      const pureInfo = binaryInspectors.inspectPeExportForwarders(pureCodeDll);
      expect(pureInfo.isValidPe).toBe(true);
      expect(pureInfo.forwarders).toEqual([]);
    });

    it('traverses 64-bit or 32-bit Launcher.exe + launcher_settings.cfg (BinaryPath=Engine32GL.exe, LocalePath=X -> EN/Engine32GL.exe) to resolve child PE32 OpenGL capabilities', () => {
      for (const bootstrapArch of ['x64', 'x86'] as const) {
        const installDir = makeTempDir(`launcher-cfg-${bootstrapArch}`);
        const launcherExePath = path.join(installDir, 'Launcher.exe');
        const childDir = path.join(installDir, 'EN');
        fs.mkdirSync(childDir, { recursive: true });
        const childExePath = path.join(childDir, 'Engine32GL.exe');

        fs.writeFileSync(
          launcherExePath,
          buildSyntheticPeImage({
            arch: bootstrapArch,
            importedDlls: ['kernel32.dll', 'shell32.dll'],
          })
        );
        fs.writeFileSync(
          childExePath,
          buildSyntheticPeImage({
            arch: 'x86',
            importedDlls: ['opengl32.dll', 'winmm.dll', 'user32.dll'],
            idataRawOffset: 40 * 1024,
          })
        );
        fs.writeFileSync(
          path.join(installDir, 'launcher_settings.cfg'),
          [
            '# Synthetic classic bootstrapper settings',
            'BinaryPath=Engine32GL.exe',
            'LocalePath=X',
            'Languages=EN,FR,DE',
          ].join('\n'),
          'utf8'
        );

        const cfgParsed = binaryInspectors.parseLauncherSettingsCfg(launcherExePath, installDir);
        expect(cfgParsed.found).toBe(true);
        expect(cfgParsed.binaryPath).toBe('Engine32GL.exe');
        expect(cfgParsed.localePath).toBe('X');
        expect(path.resolve(cfgParsed.resolvedTargetExePath)).toBe(path.resolve(childExePath));

        const caps = binaryInspectors.resolveEffectiveGameExecutableCapabilities(
          launcherExePath,
          installDir,
          { strictPe: true }
        );
        expect(caps.primaryPe.machineArch).toBe(bootstrapArch);
        expect(caps.effectiveMachine).toBe('x86');
        expect(caps.usesOpenGl).toBe(true);
        expect(caps.isLegacy32BitOpenGl).toBe(true);
        expect(caps.needsLegacyDisplayModeSynthesis).toBe(true);
        expect(caps.hasChildGameExecutable).toBe(true);
        expect(caps.targetExeBasenamesLower).toEqual(['launcher.exe', 'engine32gl.exe']);
        expect(caps.importedDlls).toEqual(
          expect.arrayContaining(['opengl32.dll', 'winmm.dll', 'kernel32.dll'])
        );
      }

      // Also verify classic DirectDraw bootstrapper -> SpaceSim97.exe
      const ddrawDir = makeTempDir('launcher-ddraw');
      const ddrawBootPath = path.join(ddrawDir, 'ClassicDdrawStart.exe');
      const ddrawChildPath = path.join(ddrawDir, 'SpaceSim97.exe');
      fs.writeFileSync(
        ddrawBootPath,
        buildSyntheticPeImage({ arch: 'x86', importedDlls: ['kernel32.dll'] })
      );
      fs.writeFileSync(
        ddrawChildPath,
        buildSyntheticPeImage({ arch: 'x86', importedDlls: ['ddraw.dll', 'dsound.dll'] })
      );
      const ddrawCaps = binaryInspectors.resolveEffectiveGameExecutableCapabilities(
        ddrawBootPath,
        ddrawDir,
        { strictPe: true }
      );
      expect(ddrawCaps.effectiveMachine).toBe('x86');
      expect(ddrawCaps.usesLegacyDirectDrawOrD3d).toBe(true);
      expect(ddrawCaps.isLegacy32BitOpenGl).toBe(false);
      expect(ddrawCaps.needsLegacyDisplayModeSynthesis).toBe(true);
      expect(ddrawCaps.hasChildGameExecutable).toBe(true);
      expect(ddrawCaps.targetExeBasenamesLower).toEqual([
        'classicddrawstart.exe',
        'spacesim97.exe',
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Declarative GOG .script Interpreter & V2 OS-Depot Filter
  // --------------------------------------------------------------------------
  describe('2. Declarative GOG .script Interpreter & V2 OS-Depot Filter (gogScriptInterpreter.cjs & gogRegistryAndDirectInstaller.cjs)', () => {
    it('selectMatchingGogV2Depots filters superseded winxp/vista/win7 depots when a win10 depot exists while preserving unconstrained base & support depots', () => {
      const productId = '1000000001';
      const meta = {
        version: 2,
        baseProductId: productId,
        depots: [
          {
            manifest: 'manifest-base-core',
            productId,
            languages: ['*'],
            size: 500_000_000,
          },
          {
            manifest: 'manifest-support-common',
            productId,
            languages: ['en-US'],
            flags: ['support'],
            size: 2_000_000,
          },
          {
            manifest: 'manifest-legacy-winxp',
            productId,
            languages: ['en-US'],
            os: ['winxp'],
            size: 150_000,
          },
          {
            manifest: 'manifest-legacy-vista',
            productId,
            languages: ['en-US'],
            os: 'vista',
            size: 150_000,
          },
          {
            manifest: 'manifest-legacy-win7',
            productId,
            languages: ['en-US'],
            os: ['win7'],
            size: 150_000,
          },
          {
            manifest: 'manifest-modern-win10',
            productId,
            languages: ['en-US'],
            os: ['win10'],
            size: 180_000,
          },
        ],
      };

      const { selectedAllDepots } = gogDirectInstaller.selectMatchingGogV2Depots(meta, productId, {
        locale: 'en-US',
      });
      const selectedManifests = selectedAllDepots.map(
        (d: { manifest: string }) => d.manifest
      );

      expect(selectedManifests).toContain('manifest-base-core');
      expect(selectedManifests).toContain('manifest-support-common');
      expect(selectedManifests).toContain('manifest-modern-win10');
      expect(selectedManifests).not.toContain('manifest-legacy-winxp');
      expect(selectedManifests).not.toContain('manifest-legacy-vista');
      expect(selectedManifests).not.toContain('manifest-legacy-win7');
    });

    it('executeGogGameScript on darwin (Bottled): expands {app} to Z:\\..., mirrors HKLM Software + Wow6432Node (REG_SZ/DWORD/BINARY), blocks ../ traversal, substitutes _w10.dll & heals broken top-level DLLs, and caches/re-applies across bottles with zero PII', async () => {
      const rootDir = makeTempDir('gog-script-darwin');
      const installDir = path.join(rootDir, 'Games', 'SynthSpaceEngine');
      const outsideCanaryPath = path.join(rootDir, 'Games', 'escaped_outside.ini');
      const bottleA = path.join(rootDir, 'Bottles', 'BottleAlpha');
      const bottleB = path.join(rootDir, 'Bottles', 'BottleBeta');
      fs.mkdirSync(installDir, { recursive: true });
      createSyntheticBottle(bottleA);
      createSyntheticBottle(bottleB);

      // Support folder with broken XP winmm.dll AND clean winmm_w10.dll
      const supportAddDir = path.join(installDir, '__support', '1000000001', 'add');
      fs.mkdirSync(supportAddDir, { recursive: true });
      const brokenDllBuf = buildSyntheticPeImage({
        arch: 'x86',
        isDll: true,
        exportForwarders: ['C:\\Windows\\System32\\winmm.GetJoystick'],
      });
      const cleanW10DllBuf = buildSyntheticPeImage({
        arch: 'x86',
        isDll: true,
        exportForwarders: ['WINMM.timeGetTime'],
        embeddedAsciiStrings: ['CLEAN_WIN10_WRAPPER_V2'],
      });
      fs.writeFileSync(path.join(supportAddDir, 'winmm.dll'), brokenDllBuf);
      fs.writeFileSync(path.join(supportAddDir, 'winmm_w10.dll'), cleanW10DllBuf);

      // Also place a pre-existing broken top-level ddraw.dll + donor add/ddraw_w10.dll to test top-level healing
      const topLevelAddDir = path.join(installDir, 'add');
      fs.mkdirSync(topLevelAddDir, { recursive: true });
      const brokenDdrawBuf = buildSyntheticPeImage({
        arch: 'x86',
        isDll: true,
        exportForwarders: ['C:\\Windows\\System32\\ddraw.DirectDrawCreate'],
      });
      const cleanDdrawW10Buf = buildSyntheticPeImage({
        arch: 'x86',
        isDll: true,
        exportForwarders: ['DDRAW.DirectDrawCreate'],
        embeddedAsciiStrings: ['CLEAN_DDRAW_WIN10_WRAPPER'],
      });
      fs.writeFileSync(path.join(installDir, 'ddraw.dll'), brokenDdrawBuf);
      fs.writeFileSync(path.join(topLevelAddDir, 'ddraw_w10.dll'), cleanDdrawW10Buf);

      fs.writeFileSync(
        path.join(installDir, 'goggame-1000000001.info'),
        JSON.stringify({
          gameId: '1000000001',
          name: 'Synthetic Space Engine',
          language: 'English',
          languages: ['en-US'],
        }),
        'utf8'
      );

      const gogScriptJson = {
        productId: '1000000001',
        actions: [
          {
            name: 'setInstallPath',
            install: {
              action: 'setRegistry',
              arguments: {
                root: 'HKLM',
                subkey: 'Software\\SyntheticPub\\SpaceEngine32\\1.0',
                valueName: 'InstallPath',
                valueData: '{app}',
                valueType: 'string',
              },
            },
          },
          {
            name: 'setDisplayDepth',
            install: {
              action: 'setRegistry',
              arguments: {
                root: 'HKLM',
                subkey: 'Software\\SyntheticPub\\SpaceEngine32\\1.0',
                valueName: 'ColorBits',
                valueData: 32,
                valueType: 'dword',
              },
            },
          },
          {
            name: 'setBinarySeed',
            install: {
              action: 'setRegistry',
              arguments: {
                root: 'HKLM',
                subkey: 'Software\\SyntheticPub\\SpaceEngine32\\1.0',
                valueName: 'ConfigBlob',
                valueData: '01 0a ff 42',
                valueType: 'binary',
              },
            },
          },
          {
            name: 'stageWinmmProxy',
            install: {
              action: 'supportData',
              arguments: {
                source: '{supportDir}/add/winmm.dll',
                target: '{app}/winmm.dll',
                overwrite: true,
              },
            },
          },
          {
            name: 'writeEngineIni',
            install: {
              action: 'iniFile',
              arguments: {
                file: '{app}/engine.ini',
                section: 'Paths',
                key: 'BaseDir',
                value: '{app}',
              },
            },
          },
          {
            name: 'maliciousSupportTraversal',
            install: {
              action: 'supportData',
              arguments: {
                source: '{supportDir}/add/winmm_w10.dll',
                target: '{app}/../escaped_outside.dll',
              },
            },
          },
          {
            name: 'maliciousIniTraversal',
            install: {
              action: 'iniFile',
              arguments: {
                file: '{app}/../escaped_outside.ini',
                section: 'Exploit',
                key: 'Pwned',
                value: '1',
              },
            },
          },
        ],
      };
      fs.writeFileSync(
        path.join(installDir, 'goggame-1000000001.script'),
        JSON.stringify(gogScriptJson, null, 2),
        'utf8'
      );

      const res1 = await gogScriptInterpreter.executeGogGameScript(installDir, {
        platform: 'darwin',
        bottleDir: bottleA,
        skipLiveWineRegSync: true,
      });

      expect(res1.executed).toBe(true);
      expect(res1.skippedCached).toBe(false);
      expect(res1.scriptsProcessed).toBe(1);
      expect(res1.registryKeysApplied).toBe(6); // 3 values * 2 subkeys (Wow6432Node + Software)
      expect(res1.iniEntriesApplied).toBe(1);

      // Verify path traversal outside installDir was strictly rejected
      expect(fs.existsSync(outsideCanaryPath)).toBe(false);
      expect(fs.existsSync(path.join(rootDir, 'Games', 'escaped_outside.dll'))).toBe(false);

      // Verify {app} expanded to Wine Z:\... and wrote BOTH Wow6432Node and 64-bit Software in system.reg
      const sysRegA = fs.readFileSync(path.join(bottleA, 'system.reg'), 'utf8');
      expect(sysRegA).toContain(
        '[Software\\\\Wow6432Node\\\\SyntheticPub\\\\SpaceEngine32\\\\1.0]'
      );
      expect(sysRegA).toContain('[Software\\\\SyntheticPub\\\\SpaceEngine32\\\\1.0]');
      expect(sysRegA).toMatch(/"InstallPath"="Z:\\\\[^"]*SynthSpaceEngine"/);
      expect(sysRegA).toContain('"ColorBits"=dword:00000020');
      expect(sysRegA).toContain('"ConfigBlob"=hex:01,0a,ff,42');

      // Verify engine.ini got Wine Z:\ path
      const iniContent = fs.readFileSync(path.join(installDir, 'engine.ini'), 'utf8');
      expect(iniContent).toContain('[Paths]');
      expect(iniContent).toMatch(/BaseDir=Z:\\.*SynthSpaceEngine/);

      // Verify winmm.dll substituted winmm_w10.dll AND pre-existing broken ddraw.dll was healed
      const stagedWinmm = fs.readFileSync(path.join(installDir, 'winmm.dll'));
      expect(stagedWinmm.equals(cleanW10DllBuf)).toBe(true);
      expect(
        binaryInspectors.hasMalformedBackslashExportForwarder(path.join(installDir, 'winmm.dll'))
      ).toBe(false);

      const healedDdraw = fs.readFileSync(path.join(installDir, 'ddraw.dll'));
      expect(healedDdraw.equals(cleanDdrawW10Buf)).toBe(true);
      expect(
        binaryInspectors.hasMalformedBackslashExportForwarder(path.join(installDir, 'ddraw.dll'))
      ).toBe(false);

      // Verify zero-PII stamp structure and < 5 ms repeat short-circuit
      const stampPath = path.join(installDir, gogScriptInterpreter.GOG_SCRIPT_STAMP_FILENAME);
      const stampText = fs.readFileSync(stampPath, 'utf8');
      expect(scanContentForPiiViolations(stampText, 'tests/stamp.json')).toEqual([]);
      expect(stampText).not.toContain(installDir);
      expect(stampText).not.toContain(bottleA);
      const parsedStamp = JSON.parse(stampText);
      expect(Object.keys(parsedStamp).sort()).toEqual([
        'scriptsHash',
        'targetScopeHash',
        'version',
      ]);

      // Warm repeat call on same bottle short-circuits in < 5 ms
      const t0 = performance.now();
      const resCached = await gogScriptInterpreter.executeGogGameScript(installDir, {
        platform: 'darwin',
        bottleDir: bottleA,
        skipLiveWineRegSync: true,
      });
      const elapsedMs = performance.now() - t0;
      expect(resCached.executed).toBe(false);
      expect(resCached.skippedCached).toBe(true);
      expect(elapsedMs).toBeLessThan(5);

      // Switching to a second bottle (bottleB) invalidates targetScopeHash and re-applies cleanly!
      const resBottleB = await gogScriptInterpreter.executeGogGameScript(installDir, {
        platform: 'darwin',
        bottleDir: bottleB,
        skipLiveWineRegSync: true,
      });
      expect(resBottleB.executed).toBe(true);
      expect(resBottleB.skippedCached).toBe(false);
      const sysRegB = fs.readFileSync(path.join(bottleB, 'system.reg'), 'utf8');
      expect(sysRegB).toContain(
        '[Software\\\\Wow6432Node\\\\SyntheticPub\\\\SpaceEngine32\\\\1.0]'
      );
      expect(sysRegB).toContain('"ColorBits"=dword:00000020');
      expect(sysRegB).toContain('"ConfigBlob"=hex:01,0a,ff,42');
    });

    it('executeGogGameScript on win32 (Native): invokes reg.exe add targeting HKCU\\Software\\Classes\\VirtualStore\\Machine\\SOFTWARE\\Wow6432Node\\... without UAC elevation', async () => {
      const installDir = makeTempDir('gog-script-win32');
      fs.writeFileSync(
        path.join(installDir, 'goggame-1000000001.script'),
        JSON.stringify({
          productId: '1000000001',
          actions: [
            {
              install: {
                action: 'setRegistry',
                arguments: {
                  root: 'HKLM',
                  subkey: 'Software\\SyntheticPub\\SpaceEngine32',
                  valueName: 'InstallDir',
                  valueData: '{app}',
                  valueType: 'string',
                },
              },
            },
            {
              install: {
                action: 'setRegistry',
                arguments: {
                  root: 'HKLM',
                  subkey: 'Software\\SyntheticPub\\SpaceEngine32',
                  valueName: 'UseHardwareGL',
                  valueData: '0x00000001',
                  valueType: 'dword',
                },
              },
            },
          ],
        }),
        'utf8'
      );

      const recordedCommands: Array<{ bin: string; args: string[] }> = [];
      const mockExecFile = (
        bin: string,
        args: string[],
        _opts: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        recordedCommands.push({ bin, args });
        cb(null, 'The operation completed successfully.', '');
      };

      const resWin = await gogScriptInterpreter.executeGogGameScript(installDir, {
        platform: 'win32',
        execFileImpl: mockExecFile,
      });

      expect(resWin.executed).toBe(true);
      expect(resWin.skippedCached).toBe(false);
      expect(recordedCommands.length).toBeGreaterThanOrEqual(4);
      expect(recordedCommands.every((c) => c.bin === 'reg.exe')).toBe(true);
      expect(
        recordedCommands.some((c) =>
          c.args.join(' ').toLowerCase().includes('runas')
        )
      ).toBe(false);

      const expectedWinPath = path.win32.normalize(installDir.replace(/\//g, '\\'));
      const virtualStoreSzCmd = recordedCommands.find(
        (c) =>
          c.args[0] === 'add' &&
          c.args[1] ===
            'HKCU\\Software\\Classes\\VirtualStore\\Machine\\SOFTWARE\\Wow6432Node\\SyntheticPub\\SpaceEngine32' &&
          c.args.includes('InstallDir')
      );
      expect(virtualStoreSzCmd).toBeDefined();
      expect(virtualStoreSzCmd?.args).toEqual([
        'add',
        'HKCU\\Software\\Classes\\VirtualStore\\Machine\\SOFTWARE\\Wow6432Node\\SyntheticPub\\SpaceEngine32',
        '/v',
        'InstallDir',
        '/t',
        'REG_SZ',
        '/d',
        expectedWinPath,
        '/f',
      ]);

      const virtualStoreDwordCmd = recordedCommands.find(
        (c) =>
          c.args[0] === 'add' &&
          c.args[1] ===
            'HKCU\\Software\\Classes\\VirtualStore\\Machine\\SOFTWARE\\Wow6432Node\\SyntheticPub\\SpaceEngine32' &&
          c.args.includes('UseHardwareGL')
      );
      expect(virtualStoreDwordCmd).toBeDefined();
      expect(virtualStoreDwordCmd?.args).toEqual([
        'add',
        'HKCU\\Software\\Classes\\VirtualStore\\Machine\\SOFTWARE\\Wow6432Node\\SyntheticPub\\SpaceEngine32',
        '/v',
        'UseHardwareGL',
        '/t',
        'REG_DWORD',
        '/d',
        '1',
        '/f',
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Registry Display Mode Synthesis, EnabledExtensions Guard & r_mode Sanitizer
  // --------------------------------------------------------------------------
  describe('3. Registry Display Mode Synthesis, EnabledExtensions Buffer Guard & <installDir> r_mode Sanitizer (macNativeInstallerAndCodesign.cjs)', () => {
    it('writes OneLauncher Desktop mode, RetinaMode=n, and <1,800-char EnabledExtensions for legacy 32-bit GL, then cleanly removes Desktop on subsequent 64-bit launch', () => {
      const bottleDir = makeTempDir('bottle-display-gl');
      createSyntheticBottle(bottleDir);
      const userRegPath = path.join(bottleDir, 'user.reg');

      const mockLayer = { id: 'crossover', type: 'crossover', name: 'CrossOver' };
      const envLegacy: Record<string, string> = {};

      macInstaller.applyCrossOverPerGameSettings(
        mockLayer,
        { crossoverGraphicsBackend: 'auto' },
        envLegacy,
        bottleDir,
        {
          skipRegistrySpawn: true,
          skipLiveWineRegSync: true,
          maxWidth: 1512,
          maxHeight: 982,
          logicalWidth: 1512,
          logicalHeight: 982,
          enableLegacyDisplayModeSynthesis: true,
          limitLegacy32BitGlExtensions: true,
          usesLegacyDirectDraw: true,
          appLocalDllOverrides: { winmm: 'native,builtin' },
          targetExeNames: ['launcher.exe', 'engine32gl.exe'],
        }
      );

      const regAfterLegacy = fs.readFileSync(userRegPath, 'utf8');
      expect(regAfterLegacy).toContain('[Software\\\\Wine\\\\Explorer\\\\Desktops]');
      expect(regAfterLegacy).toContain('"OneLauncher"="1512x982"');
      expect(regAfterLegacy).toMatch(
        /\[Software\\\\Wine\\\\Explorer\][^\[]*"Desktop"="OneLauncher"/m
      );
      expect(regAfterLegacy).toMatch(
        /\[Software\\\\Wine\\\\AppDefaults\\\\engine32gl\.exe\\\\Explorer\][^\[]*"Desktop"="OneLauncher"/m
      );
      expect(regAfterLegacy).toMatch(
        /\[Software\\\\Wine\\\\AppDefaults\\\\engine32gl\.exe\\\\Mac Driver\][^\[]*"RetinaMode"="n"/m
      );
      expect(regAfterLegacy).toMatch(
        /\[Software\\\\Wine\\\\AppDefaults\\\\engine32gl\.exe\\\\Direct3D\][^\[]*"DirectDrawRenderer"="opengl"/m
      );
      expect(regAfterLegacy).toMatch(
        /\[Software\\\\Wine\\\\AppDefaults\\\\engine32gl\.exe\\\\DllOverrides\][^\[]*"winmm"="native,builtin"/m
      );
      expect(regAfterLegacy).toMatch(
        /\[Software\\\\Wine\\\\Mac Driver\][^\[]*"RetinaMode"="n"/m
      );

      const glSecMatch =
        /\[Software\\\\Wine\\\\AppDefaults\\\\engine32gl\.exe\\\\OpenGL\][^\n]*\n([\s\S]*?)(?=\n\[|$)/.exec(
          regAfterLegacy
        );
      expect(glSecMatch).not.toBeNull();
      const extMatch = /"EnabledExtensions"="([^"]+)"/.exec(glSecMatch?.[1] || '');
      expect(extMatch).not.toBeNull();
      const enabledExtensions = extMatch?.[1] || '';
      expect(enabledExtensions.length).toBeGreaterThan(100);
      expect(enabledExtensions.length).toBeLessThan(1800);
      expect(enabledExtensions).toContain('GL_ARB_multitexture');
      expect(enabledExtensions).toContain('GL_EXT_texture_compression_s3tc');

      // Subsequent launch of a modern 64-bit game on the SAME shared bottle must remove global & AppDefaults "Desktop"
      const envModern: Record<string, string> = {};
      macInstaller.applyCrossOverPerGameSettings(
        mockLayer,
        {
          crossoverGraphicsBackend: 'd3dmetal',
          virtualDesktop: false,
        },
        envModern,
        bottleDir,
        {
          skipRegistrySpawn: true,
          skipLiveWineRegSync: true,
          maxWidth: 3024,
          maxHeight: 1964,
          enableLegacyDisplayModeSynthesis: false,
          limitLegacy32BitGlExtensions: false,
          targetExeNames: ['modernengine64.exe', 'engine32gl.exe'],
        }
      );

      const regAfterModern = fs.readFileSync(userRegPath, 'utf8');
      const explorerSecMatch =
        /\[Software\\\\Wine\\\\Explorer\][^\n]*\n([\s\S]*?)(?=\n\[|$)/.exec(regAfterModern);
      expect(explorerSecMatch?.[1] || '').not.toContain('"Desktop"');

      const appDefExplorerMatch =
        /\[Software\\\\Wine\\\\AppDefaults\\\\engine32gl\.exe\\\\Explorer\][^\n]*\n([\s\S]*?)(?=\n\[|$)/.exec(
          regAfterModern
        );
      expect(appDefExplorerMatch?.[1] || '').not.toContain('"Desktop"');

      const macDriverSecMatch =
        /\[Software\\\\Wine\\\\Mac Driver\][^\n]*\n([\s\S]*?)(?=\n\[|$)/.exec(regAfterModern);
      expect(macDriverSecMatch?.[1] || '').not.toContain('"RetinaMode"="n"');
    });

    it('sanitizeWinePrefixDisplayConfigs with installDir clamps fullscreen seta r_mode "17" (1920x1080) to universal VESA r_mode "5" (1024x768) on a 1512x982 host display', () => {
      const bottleDir = makeTempDir('bottle-rmode');
      const installDir = makeTempDir('install-rmode');
      createSyntheticBottle(bottleDir);

      const baseDir = path.join(installDir, 'base');
      fs.mkdirSync(baseDir, { recursive: true });
      const fullscreenCfgPath = path.join(baseDir, 'autoexec.cfg');
      const windowedCfgPath = path.join(baseDir, 'windowed.cfg');

      fs.writeFileSync(
        fullscreenCfgPath,
        [
          '// Synthetic id Tech 3 config',
          'seta r_fullscreen "1"',
          'seta r_mode "17"',
          'seta com_maxfps "125"',
        ].join('\n'),
        'utf8'
      );
      fs.writeFileSync(
        windowedCfgPath,
        ['seta r_fullscreen "0"', 'seta r_mode "17"'].join('\n'),
        'utf8'
      );

      const res = macInstaller.sanitizeWinePrefixDisplayConfigs(bottleDir, {
        installDir,
        maxWidth: 1512,
        maxHeight: 982,
        logicalWidth: 1512,
        logicalHeight: 982,
        highResolutionMode: false,
        skipDisplayProbe: true,
      });

      expect(res.maxWidth).toBe(1512);
      expect(res.maxHeight).toBe(982);
      expect(res.sanitizedFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filePath: fullscreenCfgPath,
            previousWidth: 1920,
            previousHeight: 1080,
            clampedWidth: 1024,
            clampedHeight: 768,
          }),
        ])
      );

      const updatedFullscreen = fs.readFileSync(fullscreenCfgPath, 'utf8');
      expect(updatedFullscreen).toContain('seta r_mode "5"');
      expect(updatedFullscreen).not.toContain('seta r_mode "17"');

      // Windowed config (r_fullscreen "0") remains untouched
      expect(fs.readFileSync(windowedCfgPath, 'utf8')).toContain('seta r_mode "17"');
    });
  });

  // --------------------------------------------------------------------------
  // 4. Child-Process Supervision, Wine-Staging -> CrossOver Routing & --dll
  // --------------------------------------------------------------------------
  describe('4. Child-Process Supervision (--wait-children + Child PID Re-Latching), Wine-Staging -> CrossOver Routing & Universal --dll Overrides (sessionAndProcessSupervisor.cjs)', () => {
    function setupSyntheticMacCompatTree(baseDir: string) {
      const homedir = path.join(baseDir, 'home');
      const appsDir = path.join(baseDir, 'Applications');
      const bottleDir = path.join(
        homedir,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'OneLauncher'
      );
      createSyntheticBottle(bottleDir);

      // Synthetic CrossOver.app Perl wrapper supporting --wait-children & --dll
      const cxWineBin = path.join(
        appsDir,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver',
        'bin',
        'wine'
      );
      fs.mkdirSync(path.dirname(cxWineBin), { recursive: true });
      fs.writeFileSync(
        cxWineBin,
        '#!/usr/bin/perl\n# Synthetic CXOpts wrapper supporting --wait-children and --dll\nexit 0;\n',
        { mode: 0o755 }
      );

      // Synthetic Wine Staging.app wrapper
      const wineStagingBin = path.join(
        appsDir,
        'Wine Staging.app',
        'Contents',
        'Resources',
        'wine',
        'bin',
        'wine64'
      );
      fs.mkdirSync(path.dirname(wineStagingBin), { recursive: true });
      fs.writeFileSync(wineStagingBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      return { homedir, appsDir, bottleDir, cxWineBin, wineStagingBin };
    }

    it('routes a 32-bit OpenGL game configured with compatibilityLayer: "wine" (Wine-Staging) to ready CrossOver unless forceRequestedCompatLayer === true', async () => {
      const envRoot = makeTempDir('route-winestaging-cx');
      const { homedir, appsDir, cxWineBin, wineStagingBin } =
        setupSyntheticMacCompatTree(envRoot);

      const installDir = path.join(envRoot, 'Games', 'LegacyGlTitle');
      const childDir = path.join(installDir, 'EN');
      fs.mkdirSync(childDir, { recursive: true });
      const bootstrapExe = path.join(installDir, 'LegacyBootstrap.exe');
      const childGlExe = path.join(childDir, 'Engine32GL.exe');

      fs.writeFileSync(
        bootstrapExe,
        buildSyntheticPeImage({ arch: 'x64', importedDlls: ['kernel32.dll'] })
      );
      fs.writeFileSync(
        childGlExe,
        buildSyntheticPeImage({ arch: 'x86', importedDlls: ['opengl32.dll', 'user32.dll'] })
      );
      fs.writeFileSync(
        path.join(installDir, 'launcher_settings.cfg'),
        'BinaryPath=Engine32GL.exe\nLocalePath=X\n',
        'utf8'
      );

      const spawnsAutoRoute: Array<{ cmd: string; args: string[] }> = [];
      const resRouted = await sessionSupervisor.launchGame(
        {
          gameId: 'gog-1000000010',
          platformId: 'gog',
          title: 'Synthetic 32-bit GL Classic',
          installPath: installDir,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            executablePath: bootstrapExe,
            compatibilityLayer: 'wine',
          },
        },
        {
          platform: 'darwin',
          homedir,
          customApplicationsDir: appsDir,
          disableBottleStorefrontLaunch: true,
          skipRegistrySpawn: true,
          skipLiveWineRegSync: true,
          startupWaitMs: 0,
          gameSpawnFn: (cmd: string, args: string[]) => {
            spawnsAutoRoute.push({ cmd, args });
            return new MockChildProcess(51110);
          },
        }
      );

      expect(resRouted.success).toBe(true);
      expect(resRouted.session.launchMethod).toBe('compatibility_layer:crossover');
      expect(spawnsAutoRoute).toHaveLength(1);
      expect(spawnsAutoRoute[0].cmd).toBe(cxWineBin);
      await sessionSupervisor.stopGame({ gameId: 'gog-1000000010' });

      // When forceRequestedCompatLayer === true, Wine-Staging is preserved
      const spawnsForced: Array<{ cmd: string; args: string[] }> = [];
      const resForced = await sessionSupervisor.launchGame(
        {
          gameId: 'gog-1000000011',
          platformId: 'gog',
          title: 'Synthetic Forced Wine-Staging Test',
          installPath: installDir,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            executablePath: bootstrapExe,
            compatibilityLayer: 'wine',
          },
        },
        {
          platform: 'darwin',
          homedir,
          customApplicationsDir: appsDir,
          forceRequestedCompatLayer: true,
          disableBottleStorefrontLaunch: true,
          skipRegistrySpawn: true,
          skipLiveWineRegSync: true,
          startupWaitMs: 0,
          gameSpawnFn: (cmd: string, args: string[]) => {
            spawnsForced.push({ cmd, args });
            return new MockChildProcess(51111);
          },
        }
      );

      expect(resForced.success).toBe(true);
      expect(resForced.session.launchMethod).toBe('compatibility_layer:wine');
      expect(spawnsForced[0].cmd).toBe(wineStagingBin);
      await sessionSupervisor.stopGame({ gameId: 'gog-1000000011' });
    });

    it('passes winmm=n,b in WINEDLLOVERRIDES + --dll + --wait-children to CrossOver bin/wine across gog, steam, and epic when a validated app-local winmm.dll is present', async () => {
      const envRoot = makeTempDir('app-local-winmm-overrides');
      const { homedir, appsDir, cxWineBin } = setupSyntheticMacCompatTree(envRoot);

      const installDir = path.join(envRoot, 'Games', 'MusicWrapperTitle');
      fs.mkdirSync(installDir, { recursive: true });
      const gameExe = path.join(installDir, 'Engine32GL.exe');
      fs.writeFileSync(
        gameExe,
        buildSyntheticPeImage({
          arch: 'x86',
          importedDlls: ['opengl32.dll', 'winmm.dll'],
        })
      );
      fs.writeFileSync(
        path.join(installDir, 'winmm.dll'),
        buildSyntheticPeImage({
          arch: 'x86',
          isDll: true,
          exportForwarders: ['WINMM.timeGetTime'],
        })
      );

      for (const storefront of ['gog', 'steam', 'epic'] as const) {
        const gameId = `${storefront}-1000000020`;
        const capturedSpawns: Array<{
          cmd: string;
          args: string[];
          env: Record<string, string>;
        }> = [];

        const res = await sessionSupervisor.launchGame(
          {
            gameId,
            platformId: storefront,
            title: `Synthetic Wrapper Title (${storefront})`,
            installPath: installDir,
            launchConfig: {
              launchMethod: 'compatibility_layer',
              executablePath: gameExe,
              compatibilityLayer: 'crossover',
            },
          },
          {
            platform: 'darwin',
            homedir,
            customApplicationsDir: appsDir,
            disableBottleStorefrontLaunch: true,
            skipRegistrySpawn: true,
            skipLiveWineRegSync: true,
            startupWaitMs: 0,
            gameSpawnFn: (
              cmd: string,
              args: string[],
              spawnOpts: { env?: Record<string, string> }
            ) => {
              capturedSpawns.push({ cmd, args, env: spawnOpts?.env || {} });
              return new MockChildProcess(51200);
            },
          }
        );

        expect(res.success).toBe(true);
        expect(capturedSpawns).toHaveLength(1);
        expect(capturedSpawns[0].cmd).toBe(cxWineBin);
        expect(capturedSpawns[0].env.WINEDLLOVERRIDES).toContain('winmm=n,b');
        expect(capturedSpawns[0].args).toContain('--wait-children');
        const dllFlagIdx = capturedSpawns[0].args.indexOf('--dll');
        expect(dllFlagIdx).toBeGreaterThanOrEqual(0);
        expect(capturedSpawns[0].args[dllFlagIdx + 1]).toContain('winmm=n,b');

        await sessionSupervisor.stopGame({ gameId });
      }

      // Also verify discoverValidatedAppLocalProxyDllOverrides rejects backslash-forwarded or mismatched-arch DLLs
      const poisonedDir = makeTempDir('app-local-poisoned-winmm');
      fs.writeFileSync(
        path.join(poisonedDir, 'winmm.dll'),
        buildSyntheticPeImage({
          arch: 'x86',
          isDll: true,
          exportForwarders: ['C:\\Windows\\System32\\winmm.GetJoystick'],
        })
      );
      const poisonedCheck = sessionSupervisor.discoverValidatedAppLocalProxyDllOverrides(
        [poisonedDir],
        'x86',
        { strictPe: true }
      );
      expect(poisonedCheck.hasOverrides).toBe(false);
      expect(poisonedCheck.envOverrideSpec).toBe('');

      const archMismatchCheck = sessionSupervisor.discoverValidatedAppLocalProxyDllOverrides(
        [installDir],
        'x64',
        { strictPe: true }
      );
      expect(archMismatchCheck.hasOverrides).toBe(false);
    });

    it('re-latches entry.pid onto live child game .exe when bootstrapper exits after 80 ms (code = 0), preventing premature finalizeGameSession / wineserver -k until child exits', async () => {
      const envRoot = makeTempDir('child-pid-relatch');
      const { homedir, appsDir } = setupSyntheticMacCompatTree(envRoot);

      const installDir = path.join(envRoot, 'Games', 'BootstrapChildTitle');
      const childDir = path.join(installDir, 'EN');
      fs.mkdirSync(childDir, { recursive: true });
      const bootstrapExe = path.join(installDir, 'LegacyBootstrap.exe');
      const childExe = path.join(childDir, 'Engine32GL.exe');

      fs.writeFileSync(
        bootstrapExe,
        buildSyntheticPeImage({ arch: 'x64', importedDlls: ['kernel32.dll'] })
      );
      fs.writeFileSync(
        childExe,
        buildSyntheticPeImage({ arch: 'x86', importedDlls: ['opengl32.dll', 'user32.dll'] })
      );
      fs.writeFileSync(
        path.join(installDir, 'launcher_settings.cfg'),
        'BinaryPath=Engine32GL.exe\nLocalePath=X\n',
        'utf8'
      );

      const gameId = 'gog-1000000030';
      const parentPid = 53001;
      const childPid = 53099;
      let childProcessAlive = true;
      let winePrefixShutdownCount = 0;
      const sessionEvents: Array<{ event?: string; status?: string; session?: { pid?: number } }> =
        [];
      const unsubSession = engineStateRegistry.onSessionUpdated(
        (evt: { event?: string; status?: string; session?: { pid?: number } }) => {
          sessionEvents.push(evt);
        }
      );
      let spawnedBootstrapProc: MockChildProcess | null = null;

      try {
        const mockExecFile = (
          bin: string,
          args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          const callback = typeof _opts === 'function' ? (_opts as typeof cb) : cb;
          if (bin === 'ps') {
            const psLines = [
              '  50100 C:\\windows\\system32\\services.exe',
              '  50104 C:\\windows\\system32\\explorer.exe /desktop=OneLauncher,1512x982',
            ];
            if (childProcessAlive) {
              psLines.push(`  ${childPid} Z:\\Games\\BootstrapChildTitle\\EN\\Engine32GL.exe`);
            }
            callback(null, `${psLines.join('\n')}\n`, '');
            return;
          }
          if (String(bin).includes('wineserver') && Array.isArray(args) && args.includes('-k')) {
            winePrefixShutdownCount += 1;
          }
          callback(null, '', '');
        };

        const launchRes = await sessionSupervisor.launchGame(
          {
            gameId,
            platformId: 'gog',
            title: 'Synthetic Bootstrap Child Re-Latch',
            installPath: installDir,
            launchConfig: {
              launchMethod: 'compatibility_layer',
              executablePath: bootstrapExe,
              compatibilityLayer: 'crossover',
            },
          },
          {
            platform: 'darwin',
            homedir,
            customApplicationsDir: appsDir,
            disableBottleStorefrontLaunch: true,
            skipRegistrySpawn: true,
            skipLiveWineRegSync: true,
            startupWaitMs: 20,
            bottleChildRetryDelayMs: 10,
            bottleChildPollIntervalMs: 25,
            execFileImpl: mockExecFile,
            isProcessAliveFn: (pid: number) => childProcessAlive && pid === childPid,
            onWinePrefixShutdown: () => {
              winePrefixShutdownCount += 1;
            },
            gameSpawnFn: () => {
              spawnedBootstrapProc = new MockChildProcess(parentPid);
              setTimeout(() => {
                spawnedBootstrapProc?.emit('exit', 0, null);
                spawnedBootstrapProc?.emit('close', 0, null);
              }, 80);
              return spawnedBootstrapProc;
            },
          }
        );

        expect(launchRes.success).toBe(true);
        expect(launchRes.session.pid).toBe(parentPid);

        // Wait 130 ms so the 80 ms bootstrapper exit fires and re-latches onto childPid (53099)
        await new Promise((r) => setTimeout(r, 130));

        const activeMap = engineStateRegistry.activeSessions as Map<
          string,
          Record<string, unknown>
        >;
        const reLatchedEntry = activeMap.get(gameId);
        expect(reLatchedEntry).toBeDefined();
        expect(reLatchedEntry?.finalized).toBeFalsy();
        expect(reLatchedEntry?.pid).toBe(childPid);
        expect(reLatchedEntry?.reLatchedBottleChildPid).toBe(childPid);
        expect((reLatchedEntry?.session as { pid?: number })?.pid).toBe(childPid);
        expect(winePrefixShutdownCount).toBe(0);
        expect(
          sessionEvents.some((e) => e.event === 'stopped' || e.event === 'stopping')
        ).toBe(false);

        // Now simulate child Engine32GL.exe exiting cleanly
        childProcessAlive = false;
        await new Promise((r) => setTimeout(r, 90));
        await sessionSupervisor.waitForActivePostSessionWork(1500);

        expect(activeMap.has(gameId)).toBe(false);
        expect(
          sessionEvents.some((e) => e.event === 'stopped' || e.event === 'stopping')
        ).toBe(true);
        expect(winePrefixShutdownCount).toBeGreaterThanOrEqual(1);
      } finally {
        if (typeof unsubSession === 'function') unsubSession();
      }
    });
  });

  // --------------------------------------------------------------------------
  // 5. Dual-Arch (x86 + x64) Xbox Bridge Verification, syswow64 & Win32 Staging
  // --------------------------------------------------------------------------
  describe('5. Dual-Arch (x86 + x64) Xbox Bridge Verification, syswow64 Bottle Staging & Smart Win32 Clientless Staging', () => {
    it('verifies all 4 x86 (0x014c) Xbox bridge binaries in electron/helpers/bin/ have undecorated stdcall exports and match .sha256 sidecars', () => {
      const x86Artifacts = [
        {
          filePath: buildXboxBridge.DLL_X86_PATH as string,
          sidecarPath: buildXboxBridge.SHA256_X86_PATH as string,
          expectedExports: buildXboxBridge.EXPECTED_EXPORTS as string[],
          expectedMarker: buildXboxBridge.EXPECTED_MARKER as string,
          expectedDllName: buildXboxBridge.EXPECTED_DLL_NAME as string,
          requireDllFlag: true,
          requireExports: true,
          expectedSubsystem: null,
        },
        {
          filePath: buildXboxBridge.GAMEINPUT_DLL_X86_PATH as string,
          sidecarPath: buildXboxBridge.GAMEINPUT_SHA256_X86_PATH as string,
          expectedExports: buildXboxBridge.GAMEINPUT_EXPECTED_EXPORTS as string[],
          expectedMarker: buildXboxBridge.GAMEINPUT_EXPECTED_MARKER as string,
          expectedDllName: buildXboxBridge.GAMEINPUT_EXPECTED_DLL_NAME as string,
          requireDllFlag: true,
          requireExports: true,
          expectedSubsystem: null,
        },
        {
          filePath: buildXboxBridge.APPNOTIFY_DLL_X86_PATH as string,
          sidecarPath: buildXboxBridge.APPNOTIFY_SHA256_X86_PATH as string,
          expectedExports: buildXboxBridge.APPNOTIFY_EXPECTED_EXPORTS as string[],
          expectedMarker: buildXboxBridge.APPNOTIFY_EXPECTED_MARKER as string,
          expectedDllName: buildXboxBridge.APPNOTIFY_EXPECTED_DLL_NAME as string,
          requireDllFlag: true,
          requireExports: true,
          expectedSubsystem: null,
        },
        {
          filePath: buildXboxBridge.WIN_LAUNCHER_EXE_X86_PATH as string,
          sidecarPath: buildXboxBridge.WIN_LAUNCHER_SHA256_X86_PATH as string,
          expectedExports: [] as string[],
          expectedMarker: buildXboxBridge.WIN_LAUNCHER_EXPECTED_MARKER as string,
          expectedDllName: null,
          requireDllFlag: false,
          requireExports: false,
          expectedSubsystem: 2,
        },
      ];

      for (const art of x86Artifacts) {
        expect(fs.existsSync(art.filePath)).toBe(true);
        expect(fs.existsSync(art.sidecarPath)).toBe(true);

        const buf = fs.readFileSync(art.filePath);
        const verified = buildXboxBridge.parseAndVerifyPeDll(buf, {
          expectedMachine: 0x014c,
          expectedExports: art.expectedExports,
          expectedMarker: art.expectedMarker,
          expectedDllName: art.expectedDllName,
          requireDeterministicTimestamps: true,
          requireDllFlag: art.requireDllFlag,
          requireExports: art.requireExports,
          expectedSubsystem: art.expectedSubsystem,
        });

        expect(verified.machine).toBe('0x014c');
        // Zero decorated __stdcall `@N` names
        expect(verified.exports.every((name: string) => !name.includes('@'))).toBe(true);

        const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
        const sidecarSha = fs.readFileSync(art.sidecarPath, 'utf8').trim().split(/\s+/)[0];
        expect(verified.sha256).toBe(actualSha);
        expect(sidecarSha).toBe(actualSha);
      }

      // Full dual-arch manifest integrity check (all 8 x64 + x86 binaries + source digests)
      const fullVerify = buildXboxBridge.verifyXboxBridgeDll();
      expect(fullVerify.machine).toBe('0x8664');
    });

    it('parseMicrosoftGameConfigXml extracts processorArchitecture: "x86" and knownDependencies: ["VC14"]', () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="SyntheticStudio.RetroGdk32" Publisher="CN=00000000-0000-0000-0000-000000000001" Version="1.2.0.0" />
  <TitleId>1234ABCD</TitleId>
  <MSAAppId>0000000044556677</MSAAppId>
  <Executables>
    <Executable Name="EN\\RetroGdk32.exe" Id="Game" TargetDeviceFamily="PC" />
  </Executables>
  <DesktopRegistration>
    <ProcessorArchitecture>x86</ProcessorArchitecture>
    <DependencyList>
      <KnownDependency Name="VC14" />
    </DependencyList>
  </DesktopRegistration>
  <ShellVisuals DefaultDisplayName="Synthetic Retro 32" PublisherDisplayName="Synthetic Studio" />
</Game>`;

      const parsed = xboxConfigAndIds.parseMicrosoftGameConfigXml(xml);
      expect(parsed).not.toBeNull();
      expect(parsed.processorArchitecture).toBe('x86');
      expect(parsed.knownDependencies).toEqual(['VC14']);
      expect(parsed.desktopRegistration?.processorArchitecture).toBe('x86');
      expect(parsed.desktopRegistration?.knownDependencies).toEqual(['VC14']);
    });

    it('prepareXboxBottleEnvironment stages x64 bridges in system32, x86 bridges + *_app.dll VCLibs in syswow64, and replaces local 0x014c xgameruntime.dll with x86 bridge', async () => {
      const rootDir = makeTempDir('xbox-bottle-wow64');
      const bottleDir = path.join(rootDir, 'OneLauncherBottle');
      createSyntheticBottle(bottleDir);

      // Create mock Wine runner with i386-windows & x86_64-windows VC14 donor DLLs
      const runnerRoot = path.join(rootDir, 'MockRunner');
      const wineBinPath = path.join(runnerRoot, 'bin', 'wine');
      const i386WineDir = path.join(runnerRoot, 'lib', 'wine', 'i386-windows');
      const x64WineDir = path.join(runnerRoot, 'lib', 'wine', 'x86_64-windows');
      fs.mkdirSync(path.dirname(wineBinPath), { recursive: true });
      fs.mkdirSync(i386WineDir, { recursive: true });
      fs.mkdirSync(x64WineDir, { recursive: true });
      fs.writeFileSync(wineBinPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const synthX86Crt = buildSyntheticPeImage({ arch: 'x86', isDll: true });
      const synthX64Crt = buildSyntheticPeImage({ arch: 'x64', isDll: true });
      for (const crtName of [
        'vcruntime140.dll',
        'msvcp140.dll',
        'concrt140.dll',
        'vccorlib140.dll',
      ]) {
        fs.writeFileSync(path.join(i386WineDir, crtName), synthX86Crt);
        fs.writeFileSync(path.join(x64WineDir, crtName), synthX64Crt);
      }

      // Create synthetic 32-bit Xbox game install directory with a retail 0x014c xgameruntime.dll
      const installDir = path.join(rootDir, 'XboxGames', 'SynthRetroGdk32', 'Content');
      fs.mkdirSync(installDir, { recursive: true });
      const exePath = path.join(installDir, 'RetroGdk32.exe');
      const localXgrPath = path.join(installDir, 'xgameruntime.dll');
      const retailX86XgrBuf = buildSyntheticPeImage({
        arch: 'x86',
        isDll: true,
        embeddedAsciiStrings: ['Microsoft.Retail.XGameRuntime.x86'],
      });
      fs.writeFileSync(
        exePath,
        buildSyntheticPeImage({
          arch: 'x86',
          importedDlls: ['xgameruntime.dll', 'kernel32.dll'],
        })
      );
      fs.writeFileSync(localXgrPath, retailX86XgrBuf);

      const prep = await wineManager.prepareXboxBottleEnvironment({
        bottlePath: bottleDir,
        installDir,
        executablePath: exePath,
        wineBinaryPath: wineBinPath,
        skipLiveWineRegSync: true,
        packageFamilyName: 'SyntheticStudio.RetroGdk32_8wekyb3d8bbwe',
        xuid: '2533274790395904',
        scid: '00000000-0000-0000-0000-00001234abcd',
      });

      expect(prep.provisioned).toBe(true);
      expect(prep.bridgeStaged).toBe(true);
      expect(prep.gameInputStaged).toBe(true);
      expect(prep.appNotifyStaged).toBe(true);
      expect(prep.bridgeX86Staged).toBe(true);
      expect(prep.gameInputX86Staged).toBe(true);
      expect(prep.appNotifyX86Staged).toBe(true);

      // Verify system32 received x64 (0x8664) bridges
      const sys32Xgr = binaryInspectors.inspectWindowsExecutableHeader(prep.system32DllPath, {
        strictPe: true,
      });
      expect(sys32Xgr.isX64).toBe(true);
      expect(sys32Xgr.machine).toBe(0x8664);

      // Verify syswow64 received x86 (0x014c) bridges AND x86 *_app.dll VCLibs
      const syswowDir = path.join(bottleDir, 'drive_c', 'windows', 'syswow64');
      for (const syswowBridge of [
        'xgameruntime.dll',
        'gameinput.dll',
        'gameinputredist.dll',
        'api-ms-win-core-psm-appnotify-l1-1-0.dll',
      ]) {
        const p = path.join(syswowDir, syswowBridge);
        expect(fs.existsSync(p)).toBe(true);
        const hdr = binaryInspectors.inspectWindowsExecutableHeader(p, { strictPe: true });
        expect(hdr.isX86).toBe(true);
        expect(hdr.machine).toBe(0x014c);
      }
      for (const vcAppDll of [
        'vcruntime140_app.dll',
        'msvcp140_app.dll',
        'concrt140_app.dll',
        'vccorlib140_app.dll',
      ]) {
        const p = path.join(syswowDir, vcAppDll);
        expect(fs.existsSync(p)).toBe(true);
        const hdr = binaryInspectors.inspectWindowsExecutableHeader(p, { strictPe: true });
        expect(hdr.isX86).toBe(true);
      }

      // Verify game-local 0x014c xgameruntime.dll was backed up to .msft.bak and replaced with the x86 bridge (NOT x64!)
      expect(fs.existsSync(`${localXgrPath}.msft.bak`)).toBe(true);
      expect(fs.readFileSync(`${localXgrPath}.msft.bak`).equals(retailX86XgrBuf)).toBe(true);

      const expectedX86BridgeSha = fs
        .readFileSync(buildXboxBridge.SHA256_X86_PATH, 'utf8')
        .trim()
        .split(/\s+/)[0];
      const stagedLocalSha = crypto
        .createHash('sha256')
        .update(fs.readFileSync(localXgrPath))
        .digest('hex');
      expect(stagedLocalSha).toBe(expectedX86BridgeSha);
      const localHdr = binaryInspectors.inspectWindowsExecutableHeader(localXgrPath, {
        strictPe: true,
      });
      expect(localHdr.isX86).toBe(true);
      expect(localHdr.isX64).toBe(false);
    });

    it('stageWindowsClientlessXboxBridgeDlls skips non-GDK classic PE32 Win32 games without polluting primaryExeDir, while staging x86 bridge + x86 launcher for 32-bit GDK games', async () => {
      // Case A: Pure classic PE32 Win32 OpenGL game (zero GDK imports, zero GDK DLLs)
      const classicDir = makeTempDir('win32-classic-gl');
      const classicExe = path.join(classicDir, 'ClassicGl32.exe');
      fs.writeFileSync(
        classicExe,
        buildSyntheticPeImage({
          arch: 'x86',
          importedDlls: ['opengl32.dll', 'kernel32.dll'],
          idataRawOffset: 40 * 1024,
        })
      );

      const classicStage = await wineManager.stageWindowsClientlessXboxBridgeDlls({
        installDir: classicDir,
        executablePath: classicExe,
      });

      expect(classicStage.targetMachine).toBe('x86');
      expect(classicStage.requiresXgrInjection).toBe(false);
      expect(classicStage.bridgeStaged).toBe(false);
      expect(classicStage.gameInputStaged).toBe(false);
      expect(classicStage.winLauncherExePath).toBe('');
      expect(classicStage.stagedLocalFiles).toEqual([]);
      expect(fs.readdirSync(classicDir)).toEqual(['ClassicGl32.exe']);

      // Case B: 32-bit GDK game importing xgameruntime.dll
      const gdk32Dir = makeTempDir('win32-gdk-x86');
      const gdk32Exe = path.join(gdk32Dir, 'RetroGdk32.exe');
      fs.writeFileSync(
        gdk32Exe,
        buildSyntheticPeImage({
          arch: 'x86',
          importedDlls: ['xgameruntime.dll', 'kernel32.dll'],
          idataRawOffset: 40 * 1024,
        })
      );

      const gdk32Stage = await wineManager.stageWindowsClientlessXboxBridgeDlls({
        installDir: gdk32Dir,
        executablePath: gdk32Exe,
      });

      expect(gdk32Stage.targetMachine).toBe('x86');
      expect(gdk32Stage.requiresXgrInjection).toBe(true);
      expect(gdk32Stage.bridgeStaged).toBe(true);
      expect(gdk32Stage.gameInputStaged).toBe(true);
      expect(path.basename(gdk32Stage.bridgeDllPath)).toBe('one_xgameruntime_bridge_x86.dll');
      expect(path.basename(gdk32Stage.winLauncherExePath)).toBe('one_xgr_win_launcher_x86.exe');

      const stagedXgrPath = path.join(gdk32Dir, 'xgameruntime.dll');
      expect(fs.existsSync(stagedXgrPath)).toBe(true);
      const stagedHdr = binaryInspectors.inspectWindowsExecutableHeader(stagedXgrPath, {
        strictPe: true,
      });
      expect(stagedHdr.isX86).toBe(true);
      expect(stagedHdr.machine).toBe(0x014c);

      // End-to-end win32 launchGame check: ClassicGl32 spawns directly, RetroGdk32 spawns via one_xgr_win_launcher_x86.exe
      const classicWinSpawns: Array<{ cmd: string; args: string[] }> = [];
      const resWinClassic = await sessionSupervisor.launchGame(
        {
          gameId: 'xbox-9N0000000001',
          platformId: 'xbox',
          title: 'Synthetic Classic Win32 On Game Pass',
          installPath: classicDir,
          isClientlessXboxInstall: true,
          installerId: 'xbox-msixvc-win',
          launchConfig: {
            launchMethod: 'direct',
            executablePath: classicExe,
          },
        },
        {
          platform: 'win32',
          homedir: makeTempDir('win32-home-classic'),
          forceClientlessXboxOnWin32: true,
          startupWaitMs: 0,
          gameSpawnFn: (cmd: string, args: string[]) => {
            classicWinSpawns.push({ cmd, args });
            return new MockChildProcess(54001);
          },
        }
      );
      expect(resWinClassic.success).toBe(true);
      expect(classicWinSpawns).toHaveLength(1);
      expect(classicWinSpawns[0].cmd).toBe(classicExe);
      expect(resWinClassic.session.launchMethod).not.toBe('xbox_win_clientless_injector');
      expect(fs.existsSync(path.join(classicDir, 'xgameruntime.dll'))).toBe(false);
      await sessionSupervisor.stopGame({ gameId: 'xbox-9N0000000001' });

      const gdkWinSpawns: Array<{ cmd: string; args: string[] }> = [];
      const resWinGdk32 = await sessionSupervisor.launchGame(
        {
          gameId: 'xbox-9N0000000002',
          platformId: 'xbox',
          title: 'Synthetic 32-bit GDK Game',
          installPath: gdk32Dir,
          isClientlessXboxInstall: true,
          installerId: 'xbox-msixvc-win',
          launchConfig: {
            launchMethod: 'direct',
            executablePath: gdk32Exe,
          },
        },
        {
          platform: 'win32',
          homedir: makeTempDir('win32-home-gdk32'),
          forceClientlessXboxOnWin32: true,
          startupWaitMs: 0,
          gameSpawnFn: (cmd: string, args: string[]) => {
            gdkWinSpawns.push({ cmd, args });
            return new MockChildProcess(54002);
          },
        }
      );
      expect(resWinGdk32.success).toBe(true);
      expect(resWinGdk32.session.launchMethod).toBe('xbox_win_clientless_injector');
      expect(gdkWinSpawns).toHaveLength(1);
      expect(path.basename(gdkWinSpawns[0].cmd)).toBe('one_xgr_win_launcher_x86.exe');
      expect(gdkWinSpawns[0].args).toEqual(['--dll', stagedXgrPath, '--', gdk32Exe]);
      await sessionSupervisor.stopGame({ gameId: 'xbox-9N0000000002' });
    });
  });
});
