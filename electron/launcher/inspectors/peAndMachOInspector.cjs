// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');

/**
 * Map a PE Relative Virtual Address (RVA) to a physical file offset using COFF section headers.
 *
 * @param {number} rva
 * @param {Array<{ virtualSize: number, virtualAddress: number, rawSize: number, rawPtr: number }>} sections
 * @param {number} headerLimit
 * @param {number} fileSize
 * @returns {number}
 */
function mapPeRvaToFileOffset(rva, sections, headerLimit, fileSize) {
  if (!Number.isFinite(rva) || rva <= 0 || !Number.isFinite(fileSize) || fileSize <= 0) {
    return -1;
  }
  for (let i = 0; i < sections.length; i += 1) {
    const sec = sections[i];
    const span = Math.max(sec.virtualSize >>> 0, sec.rawSize >>> 0);
    if (span > 0 && rva >= sec.virtualAddress && rva < sec.virtualAddress + span) {
      const delta = rva - sec.virtualAddress;
      if (sec.rawSize > 0 && delta >= sec.rawSize) {
        return -1;
      }
      const off = sec.rawPtr + delta;
      return off >= 0 && off < fileSize ? off : -1;
    }
  }
  if (headerLimit > 0 && rva < headerLimit && rva < fileSize) {
    return rva;
  }
  return -1;
}

/**
 * Read a NUL-terminated printable ASCII string from an open file descriptor at `fileOffset`.
 *
 * @param {number} fd
 * @param {number} fileOffset
 * @param {number} maxLen
 * @param {number} fileSize
 * @returns {string}
 */
function readAsciiCStringFromFd(fd, fileOffset, maxLen, fileSize) {
  if (fileOffset < 0 || fileOffset >= fileSize || maxLen <= 0) {
    return '';
  }
  const toRead = Math.min(maxLen, fileSize - fileOffset);
  if (toRead <= 0) return '';
  const buf = Buffer.alloc(toRead);
  const bytesRead = fs.readSync(fd, buf, 0, toRead, fileOffset);
  if (bytesRead <= 0) return '';
  let end = 0;
  while (end < bytesRead && buf[end] !== 0) {
    const b = buf[end];
    if (b < 0x20 || b > 0x7e) {
      return '';
    }
    end += 1;
  }
  if (end === 0) return '';
  return buf.subarray(0, end).toString('ascii');
}

/**
 * Parse COFF section headers and Optional Header Data Directories (Export=0, Import=1, DelayImport=13) from an open PE fd.
 *
 * @param {number} fd
 * @param {number} peOffset
 * @param {number} fileSize
 */
function readPeSectionsAndDataDirectories(fd, peOffset, fileSize) {
  const empty = {
    sections: /** @type {Array<{ name: string, virtualSize: number, virtualAddress: number, rawSize: number, rawPtr: number }>} */ ([]),
    exportDir: { rva: 0, size: 0 },
    importDir: { rva: 0, size: 0 },
    delayImportDir: { rva: 0, size: 0 },
    imageBase: 0n,
    headerLimit: 0,
  };
  if (peOffset + 24 > fileSize) return empty;
  const coffBuf = Buffer.alloc(24);
  if (fs.readSync(fd, coffBuf, 0, 24, peOffset) < 24) {
    return empty;
  }
  const numSections = coffBuf.readUInt16LE(6);
  const sizeOfOptionalHeader = coffBuf.readUInt16LE(20);
  const optOffset = peOffset + 24;
  if (sizeOfOptionalHeader < 2 || optOffset + sizeOfOptionalHeader > fileSize) {
    return empty;
  }

  const optReadLen = Math.min(sizeOfOptionalHeader, 264);
  const optBuf = Buffer.alloc(optReadLen);
  if (fs.readSync(fd, optBuf, 0, optReadLen, optOffset) < 2) {
    return empty;
  }
  const magic = optBuf.readUInt16LE(0);
  let numDirsOffset = -1;
  let dataDirOffset = -1;
  let imageBase = 0n;
  if (magic === 0x010b) {
    numDirsOffset = 92;
    dataDirOffset = 96;
    if (optBuf.length >= 32) {
      imageBase = BigInt(optBuf.readUInt32LE(28));
    }
  } else if (magic === 0x020b) {
    numDirsOffset = 108;
    dataDirOffset = 112;
    if (optBuf.length >= 32) {
      imageBase = optBuf.readBigUInt64LE(24);
    }
  }

  let headerLimit = optBuf.length >= 64 ? optBuf.readUInt32LE(60) : 0;
  const exportDir = { rva: 0, size: 0 };
  const importDir = { rva: 0, size: 0 };
  const delayImportDir = { rva: 0, size: 0 };
  if (numDirsOffset >= 0 && optBuf.length >= numDirsOffset + 4) {
    const numRvaAndSizes = Math.min(optBuf.readUInt32LE(numDirsOffset), 16);
    if (numRvaAndSizes >= 1 && optBuf.length >= dataDirOffset + 8) {
      exportDir.rva = optBuf.readUInt32LE(dataDirOffset);
      exportDir.size = optBuf.readUInt32LE(dataDirOffset + 4);
    }
    if (numRvaAndSizes >= 2 && optBuf.length >= dataDirOffset + 16) {
      importDir.rva = optBuf.readUInt32LE(dataDirOffset + 8);
      importDir.size = optBuf.readUInt32LE(dataDirOffset + 12);
    }
    if (numRvaAndSizes >= 14 && optBuf.length >= dataDirOffset + 112) {
      delayImportDir.rva = optBuf.readUInt32LE(dataDirOffset + 104);
      delayImportDir.size = optBuf.readUInt32LE(dataDirOffset + 108);
    }
  }

  const boundedSections = Math.min(numSections, 96);
  const secTableOffset = optOffset + sizeOfOptionalHeader;
  /** @type {Array<{ name: string, virtualSize: number, virtualAddress: number, rawSize: number, rawPtr: number }>} */
  const sections = [];
  if (boundedSections > 0 && secTableOffset + boundedSections * 40 <= fileSize) {
    const secBuf = Buffer.alloc(boundedSections * 40);
    if (fs.readSync(fd, secBuf, 0, secBuf.length, secTableOffset) === secBuf.length) {
      for (let i = 0; i < boundedSections; i += 1) {
        const base = i * 40;
        const name = secBuf
          .subarray(base, base + 8)
          .toString('ascii')
          .replace(/\0+$/, '');
        const virtualSize = secBuf.readUInt32LE(base + 8);
        const virtualAddress = secBuf.readUInt32LE(base + 12);
        const rawSize = secBuf.readUInt32LE(base + 16);
        const rawPtr = secBuf.readUInt32LE(base + 20);
        if (virtualAddress > 0 && (headerLimit === 0 || virtualAddress < headerLimit)) {
          headerLimit = virtualAddress;
        }
        sections.push({ name, virtualSize, virtualAddress, rawSize, rawPtr });
      }
    }
  }

  return { sections, exportDir, importDir, delayImportDir, imageBase, headerLimit };
}

/**
 * Read deduplicated lowercase imported DLL names from a PE Import Directory (`IMAGE_DIRECTORY_ENTRY_IMPORT`).
 *
 * @param {number} fd
 * @param {{ sections: Array<{ name: string, virtualSize: number, virtualAddress: number, rawSize: number, rawPtr: number }>, importDir: { rva: number, size: number }, headerLimit: number }} layout
 * @param {number} fileSize
 * @returns {string[]}
 */
function readPeImportedDllNamesFromFd(fd, layout, fileSize) {
  if (!layout || !layout.importDir || layout.importDir.rva <= 0) {
    return [];
  }
  const descFileOff = mapPeRvaToFileOffset(
    layout.importDir.rva,
    layout.sections,
    layout.headerLimit,
    fileSize
  );
  if (descFileOff < 0 || descFileOff + 20 > fileSize) {
    return [];
  }
  const maxDescriptors = 256;
  const maxBytes = Math.min(
    maxDescriptors * 20,
    fileSize - descFileOff,
    layout.importDir.size >= 20 ? Math.max(layout.importDir.size, 20) : maxDescriptors * 20
  );
  const descBuf = Buffer.alloc(maxBytes);
  const bytesRead = fs.readSync(fd, descBuf, 0, maxBytes, descFileOff);
  if (bytesRead < 20) return [];

  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const importedDlls = [];
  const count = Math.floor(bytesRead / 20);
  for (let i = 0; i < count; i += 1) {
    const base = i * 20;
    const origFirstThunk = descBuf.readUInt32LE(base);
    const timeDateStamp = descBuf.readUInt32LE(base + 4);
    const forwarderChain = descBuf.readUInt32LE(base + 8);
    const nameRva = descBuf.readUInt32LE(base + 12);
    const firstThunk = descBuf.readUInt32LE(base + 16);
    if (
      origFirstThunk === 0 &&
      timeDateStamp === 0 &&
      forwarderChain === 0 &&
      nameRva === 0 &&
      firstThunk === 0
    ) {
      break;
    }
    if (nameRva === 0) continue;
    const nameOff = mapPeRvaToFileOffset(nameRva, layout.sections, layout.headerLimit, fileSize);
    if (nameOff < 0) continue;
    const rawDllName = readAsciiCStringFromFd(fd, nameOff, 128, fileSize).trim().toLowerCase();
    if (!rawDllName || rawDllName.length > 120) continue;
    const baseDll = rawDllName.split(/[\\/]/).pop() || rawDllName;
    if (baseDll && !seen.has(baseDll)) {
      seen.add(baseDll);
      importedDlls.push(baseDll);
    }
  }
  return importedDlls;
}

/**
 * Read deduplicated lowercase delay-imported DLL names from a PE Delay-Load Import Directory
 * (`IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT`, DataDirectory[13], 32-byte `ImgDelayDescr` entries).
 *
 * @param {number} fd
 * @param {{ sections: Array<{ name: string, virtualSize: number, virtualAddress: number, rawSize: number, rawPtr: number }>, delayImportDir?: { rva: number, size: number }, imageBase?: bigint, headerLimit: number }} layout
 * @param {number} fileSize
 * @returns {string[]}
 */
function readPeDelayImportedDllNamesFromFd(fd, layout, fileSize) {
  if (!layout || !layout.delayImportDir || layout.delayImportDir.rva <= 0) {
    return [];
  }
  const descFileOff = mapPeRvaToFileOffset(
    layout.delayImportDir.rva,
    layout.sections,
    layout.headerLimit,
    fileSize
  );
  if (descFileOff < 0 || descFileOff + 32 > fileSize) {
    return [];
  }
  const maxDescriptors = 256;
  const maxBytes = Math.min(
    maxDescriptors * 32,
    fileSize - descFileOff,
    layout.delayImportDir.size >= 32
      ? Math.max(layout.delayImportDir.size, 32)
      : maxDescriptors * 32
  );
  const descBuf = Buffer.alloc(maxBytes);
  const bytesRead = fs.readSync(fd, descBuf, 0, maxBytes, descFileOff);
  if (bytesRead < 32) return [];

  const imgBaseBig = typeof layout.imageBase === 'bigint' ? layout.imageBase : 0n;
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const delayDlls = [];
  const count = Math.floor(bytesRead / 32);
  for (let i = 0; i < count; i += 1) {
    const base = i * 32;
    const grAttrs = descBuf.readUInt32LE(base);
    const rvaDllName = descBuf.readUInt32LE(base + 4);
    const rvaHmod = descBuf.readUInt32LE(base + 8);
    const rvaIat = descBuf.readUInt32LE(base + 12);
    const rvaInt = descBuf.readUInt32LE(base + 16);
    if (grAttrs === 0 && rvaDllName === 0 && rvaHmod === 0 && rvaIat === 0 && rvaInt === 0) {
      break;
    }
    if (rvaDllName === 0) continue;

    let effectiveNameRva = rvaDllName;
    if ((grAttrs & 1) === 0 && imgBaseBig > 0n) {
      const rvaBig = BigInt(rvaDllName);
      if (rvaBig >= imgBaseBig) {
        const diff = rvaBig - imgBaseBig;
        if (diff <= 0xffffffffn) {
          effectiveNameRva = Number(diff);
        }
      }
    }
    const nameOff = mapPeRvaToFileOffset(
      effectiveNameRva,
      layout.sections,
      layout.headerLimit,
      fileSize
    );
    if (nameOff < 0) continue;
    const rawDllName = readAsciiCStringFromFd(fd, nameOff, 128, fileSize).trim().toLowerCase();
    if (!rawDllName || rawDllName.length > 120) continue;
    const baseDll = rawDllName.split(/[\\/]/).pop() || rawDllName;
    if (baseDll && !seen.has(baseDll)) {
      seen.add(baseDll);
      delayDlls.push(baseDll);
    }
  }
  return delayDlls;
}

/**
 * Derive normalized graphics & legacy API capability flags from deduplicated lowercase DLL names.
 *
 * @param {string[]} importedDlls
 * @param {{
 *   usesDynamicQgl?: boolean,
 *   dynamicallyLoadsDirectDraw?: boolean,
 *   dynamicallyLoadsD3d11?: boolean,
 *   dynamicallyLoadsD3d12?: boolean,
 *   dynamicallyLoadsDxgi?: boolean,
 *   dynamicallyLoadsVulkan?: boolean,
 *   hasUe5IoStoreContainer?: boolean,
 *   is64Bit?: boolean,
 *   forceGlCore?: boolean,
 * }} [extra]
 */
function derivePeGraphicsCapabilities(importedDlls, extra = {}) {
  const dllList = Array.isArray(importedDlls) ? importedDlls : [];
  const dllSet = new Set(dllList.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean));
  const usesDynamicQgl = Boolean(extra.usesDynamicQgl);
  const dynamicallyLoadsDirectDraw = Boolean(extra.dynamicallyLoadsDirectDraw);
  const dynamicallyLoadsD3d11 = Boolean(extra.dynamicallyLoadsD3d11);
  const dynamicallyLoadsD3d12 = Boolean(extra.dynamicallyLoadsD3d12);
  const dynamicallyLoadsDxgi = Boolean(extra.dynamicallyLoadsDxgi);
  const dynamicallyLoadsVulkan = Boolean(extra.dynamicallyLoadsVulkan);
  const hasUe5IoStoreContainer = Boolean(extra.hasUe5IoStoreContainer);
  const is64Bit = Boolean(extra.is64Bit);
  const forceGlCore = Boolean(extra.forceGlCore);

  const importsUnityPlayer = dllSet.has('unityplayer.dll');
  const isModernUnity64Host = Boolean(importsUnityPlayer && is64Bit && !forceGlCore);
  const importsDdraw2d = dllSet.has('ddraw.dll') || dynamicallyLoadsDirectDraw;
  const importsD3dImmediateMode = dllSet.has('d3dim.dll') || dllSet.has('d3dim700.dll');
  const usesLegacyDdraw = Boolean(importsDdraw2d || importsD3dImmediateMode);
  const importsD3d8 = dllSet.has('d3d8.dll');
  const importsOpenGl = dllSet.has('opengl32.dll') || usesDynamicQgl;
  const importsSdl1 = dllSet.has('sdl.dll');
  const importsModernSdl = dllSet.has('sdl2.dll') || dllSet.has('sdl3.dll');

  const importsD3d12 =
    dllSet.has('d3d12.dll') || dllSet.has('d3d12core.dll') || dynamicallyLoadsD3d12;
  const importsD3d9 =
    dllSet.has('d3d9.dll') || dllList.some((d) => /^d3dx9(?:_\d+)?\.dll$/i.test(d));
  const importsVulkan = dllSet.has('vulkan-1.dll') || dynamicallyLoadsVulkan;
  const importsLegacyD3dOrGl =
    importsD3d8 || usesLegacyDdraw || (importsOpenGl && !isModernUnity64Host);
  const hasExplicitD3d11Or10 =
    dllSet.has('d3d11.dll') ||
    dllSet.has('d3d10.dll') ||
    dllSet.has('d3d10_1.dll') ||
    dllSet.has('d3d10core.dll') ||
    dynamicallyLoadsD3d11 ||
    dllList.some((d) => /^d3dx1[01](?:_\d+)?\.dll$/i.test(d));
  const importsD3d11Or10 =
    hasExplicitD3d11Or10 ||
    isModernUnity64Host ||
    ((dllSet.has('dxgi.dll') || dynamicallyLoadsDxgi) && !importsD3d12 && !hasUe5IoStoreContainer);
  const isD3d12Only =
    (importsD3d12 || hasUe5IoStoreContainer) &&
    !importsD3d11Or10 &&
    !importsD3d9 &&
    !importsVulkan &&
    !importsLegacyD3dOrGl;

  return {
    usesDynamicQgl,
    importsUnityPlayer,
    importsDdraw2d,
    importsD3dImmediateMode,
    usesLegacyDdraw,
    importsD3d8,
    importsOpenGl,
    importsSdl1,
    importsModernSdl,
    importsD3d12,
    importsD3d11Or10,
    importsD3d9,
    importsLegacyD3dOrGl,
    importsVulkan,
    hasUe5IoStoreContainer,
    isD3d12Only,
  };
}

const PE_HEADER_INSPECT_CACHE_MAX = 512;
/** @type {Map<string, Record<string, any>>} */
const peHeaderInspectCache = new Map();

/**
 * Bounded LRU read/write helpers for `inspectWindowsExecutableHeader` stat-keyed cache.
 *
 * @param {string} key
 * @returns {Record<string, any> | null}
 */
function getCachedPeHeader(key) {
  const hit = peHeaderInspectCache.get(key);
  if (!hit) return null;
  peHeaderInspectCache.delete(key);
  peHeaderInspectCache.set(key, hit);
  return hit;
}

/**
 * @param {string} key
 * @param {Record<string, any>} value
 */
function setCachedPeHeader(key, value) {
  if (peHeaderInspectCache.has(key)) {
    peHeaderInspectCache.delete(key);
  } else if (peHeaderInspectCache.size >= PE_HEADER_INSPECT_CACHE_MAX) {
    const oldestKey = peHeaderInspectCache.keys().next().value;
    if (oldestKey !== undefined) {
      peHeaderInspectCache.delete(oldestKey);
    }
  }
  peHeaderInspectCache.set(key, value);
}

const PE_SCAN_CHUNK_BYTES = 262144; // 256 KiB
const PE_SCAN_OVERLAP_BYTES = 64;
const PE_SCAN_PER_FILE_MAX_BYTES = 12 * 1024 * 1024; // 12 MiB

const N_OPENGL32_DLL = Buffer.from('opengl32.dll\0', 'latin1');
const N_OPENGL32 = Buffer.from('opengl32\0', 'latin1');
const N_WGL_CREATE = Buffer.from('wglCreateContext\0', 'latin1');
const N_WGL_MAKE_CUR = Buffer.from('wglMakeCurrent\0', 'latin1');
const N_WGL_GET_PROC = Buffer.from('wglGetProcAddress\0', 'latin1');
const N_CHOOSE_PF = Buffer.from('ChoosePixelFormat\0', 'latin1');
const N_SET_PF = Buffer.from('SetPixelFormat\0', 'latin1');
const N_SWAP_BUFFERS = Buffer.from('SwapBuffers\0', 'latin1');
const N_DDRAW_DLL = Buffer.from('ddraw.dll\0', 'latin1');
const N_DDRAW = Buffer.from('ddraw\0', 'latin1');
const N_DDRAW_CREATE = Buffer.from('directdrawcreate', 'latin1');
const N_D3D11_DLL = Buffer.from('d3d11.dll\0', 'latin1');
const N_D3D11_DLL_U16 = Buffer.from('d3d11.dll\0', 'utf16le');
const N_D3D11_HINT = Buffer.from('d3d11', 'latin1');
const N_D3D11_CREATE = Buffer.from('D3D11CreateDevice', 'latin1');
const N_D3D12_DLL = Buffer.from('d3d12.dll\0', 'latin1');
const N_D3D12_DLL_U16 = Buffer.from('d3d12.dll\0', 'utf16le');
const N_D3D12CORE_DLL = Buffer.from('d3d12core.dll\0', 'latin1');
const N_D3D12CORE_DLL_U16 = Buffer.from('d3d12core.dll\0', 'utf16le');
const N_D3D12_CREATE = Buffer.from('D3D12CreateDevice\0', 'latin1');
const N_DXGI_DLL = Buffer.from('dxgi.dll\0', 'latin1');
const N_DXGI_DLL_U16 = Buffer.from('dxgi.dll\0', 'utf16le');
const N_DXGI_HINT = Buffer.from('dxgi', 'latin1');
const N_DXGI_FACTORY = Buffer.from('CreateDXGIFactory', 'latin1');
const N_VULKAN_DLL = Buffer.from('vulkan-1.dll\0', 'latin1');
const N_VULKAN_DLL_U16 = Buffer.from('vulkan-1.dll\0', 'utf16le');
const N_VK_CREATE_INST = Buffer.from('vkCreateInstance\0', 'latin1');
const N_SET_DPI_CTX = Buffer.from('SetProcessDpiAwarenessContext\0', 'latin1');
const N_SET_DPI_AWARE = Buffer.from('SetProcessDpiAwareness\0', 'latin1');

/**
 * @param {Buffer} buf
 * @param {number} idx
 * @param {boolean} [isUtf16]
 * @returns {boolean}
 */
function hasWordBoundaryBefore(buf, idx, isUtf16 = false) {
  if (idx <= 0) return true;
  if (isUtf16) {
    if (idx < 2) return true;
    const lo = buf[idx - 2];
    const hi = buf[idx - 1];
    if (hi !== 0) return true;
    return !(
      (lo >= 48 && lo <= 57) ||
      (lo >= 65 && lo <= 90) ||
      (lo >= 97 && lo <= 122) ||
      lo === 95
    );
  }
  const c = buf[idx - 1];
  return !(
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 95
  );
}

/**
 * @param {Buffer} buf
 * @param {number} len
 * @param {Buffer} needle
 * @param {boolean} [isUtf16]
 * @returns {number}
 */
function indexOfWordBoundary(buf, len, needle, isUtf16 = false) {
  let pos = 0;
  while (pos < len) {
    const idx = buf.indexOf(needle, pos);
    if (idx < 0 || idx + needle.length > len) return -1;
    if (hasWordBoundaryBefore(buf, idx, isUtf16)) return idx;
    pos = idx + 1;
  }
  return -1;
}

/**
 * Streaming `Buffer.indexOf` scanner over PE `.rdata` / `.data` / `.idata` ranges
 * with bounded per-file and shared aggregate byte budgets.
 *
 * @param {number} fd
 * @param {Array<{ offset: number, length: number }>} scanRanges
 * @param {{
 *   isX86: boolean,
 *   scanLegacy: boolean,
 *   scanModern: boolean,
 *   scanDpiApi: boolean,
 *   importedGdi32: boolean,
 *   rdataBudget?: { remaining: number } | null,
 * }} scanOpts
 */
function scanPeDynamicStringsFromFd(fd, scanRanges, scanOpts) {
  const result = {
    dynamicallyLoadsOpenGl: false,
    dynamicallyLoadsDirectDraw: false,
    dynamicallyLoadsD3d11: false,
    dynamicallyLoadsD3d12: false,
    dynamicallyLoadsDxgi: false,
    dynamicallyLoadsVulkan: false,
    callsPerMonitorDpiApi: false,
    budgetExhausted: false,
  };
  if (!Array.isArray(scanRanges) || scanRanges.length === 0) {
    return result;
  }

  let sawOpengl32 = false;
  let sawOpengl32DllLiteral = false;
  let sawWglCreateContext = false;
  let sawPixelFormatSymbol = false;
  let sawSwapBuffersSymbol = false;
  let sawDdraw = false;
  let sawDirectDrawCreate = false;
  let sawD3d11CreateDevice = false;
  let sawD3d11OrDxgiHint = false;
  let sawDxgiDll = false;
  let sawDxgiFactory = false;
  let sawVulkanDll = false;
  let sawVkCreateInstance = false;

  const chunkBuf = Buffer.allocUnsafe(PE_SCAN_CHUNK_BYTES + PE_SCAN_OVERLAP_BYTES);
  const lowerBuf = Buffer.allocUnsafe(PE_SCAN_CHUNK_BYTES + PE_SCAN_OVERLAP_BYTES);
  let fileBytesRemaining = PE_SCAN_PER_FILE_MAX_BYTES;
  const aggBudget =
    scanOpts.rdataBudget && typeof scanOpts.rdataBudget.remaining === 'number'
      ? scanOpts.rdataBudget
      : null;

  for (let rIdx = 0; rIdx < scanRanges.length; rIdx += 1) {
    const range = scanRanges[rIdx];
    if (!range || range.length <= 16) continue;

    let pos = 0;
    let carry = 0;
    while (pos < range.length) {
      const wantMoreLegacy =
        scanOpts.scanLegacy &&
        (!result.dynamicallyLoadsOpenGl || (scanOpts.isX86 && !result.dynamicallyLoadsDirectDraw));
      const wantMoreModern =
        scanOpts.scanModern &&
        !(
          result.dynamicallyLoadsD3d11 &&
          result.dynamicallyLoadsD3d12 &&
          result.dynamicallyLoadsVulkan
        );
      const wantMoreDpi = scanOpts.scanDpiApi && !result.callsPerMonitorDpiApi;
      if (!wantMoreLegacy && !wantMoreModern && !wantMoreDpi) {
        break;
      }

      if (fileBytesRemaining <= 0) {
        break;
      }
      if (aggBudget && aggBudget.remaining <= 0) {
        result.budgetExhausted = true;
        break;
      }

      let toRead = Math.min(PE_SCAN_CHUNK_BYTES, range.length - pos, fileBytesRemaining);
      if (aggBudget) {
        toRead = Math.min(toRead, aggBudget.remaining);
      }
      if (toRead <= 0) {
        result.budgetExhausted = true;
        break;
      }

      const nRead = fs.readSync(fd, chunkBuf, carry, toRead, range.offset + pos);
      if (nRead <= 0) break;
      pos += nRead;
      fileBytesRemaining -= nRead;
      if (aggBudget) {
        aggBudget.remaining -= nRead;
      }

      const totalLen = carry + nRead;
      for (let i = 0; i < totalLen; i += 1) {
        const c = chunkBuf[i];
        lowerBuf[i] = c >= 65 && c <= 90 ? c + 32 : c;
      }

      if (wantMoreLegacy) {
        if (!result.dynamicallyLoadsOpenGl) {
          if (
            !sawOpengl32DllLiteral &&
            indexOfWordBoundary(lowerBuf, totalLen, N_OPENGL32_DLL) >= 0
          ) {
            sawOpengl32DllLiteral = true;
            sawOpengl32 = true;
          }
          if (!sawOpengl32 && indexOfWordBoundary(lowerBuf, totalLen, N_OPENGL32) >= 0) {
            sawOpengl32 = true;
          }
          if (
            !sawWglCreateContext &&
            (indexOfWordBoundary(chunkBuf, totalLen, N_WGL_CREATE) >= 0 ||
              indexOfWordBoundary(chunkBuf, totalLen, N_WGL_MAKE_CUR) >= 0 ||
              indexOfWordBoundary(chunkBuf, totalLen, N_WGL_GET_PROC) >= 0)
          ) {
            sawWglCreateContext = true;
          }
          if (
            scanOpts.importedGdi32 &&
            !sawPixelFormatSymbol &&
            (indexOfWordBoundary(chunkBuf, totalLen, N_CHOOSE_PF) >= 0 ||
              indexOfWordBoundary(chunkBuf, totalLen, N_SET_PF) >= 0)
          ) {
            sawPixelFormatSymbol = true;
          }
          if (
            scanOpts.importedGdi32 &&
            !sawSwapBuffersSymbol &&
            indexOfWordBoundary(chunkBuf, totalLen, N_SWAP_BUFFERS) >= 0
          ) {
            sawSwapBuffersSymbol = true;
          }
          if (
            sawOpengl32DllLiteral ||
            (sawOpengl32 && sawWglCreateContext) ||
            (scanOpts.importedGdi32 && sawPixelFormatSymbol && sawSwapBuffersSymbol)
          ) {
            result.dynamicallyLoadsOpenGl = true;
          }
        }
        if (scanOpts.isX86 && !result.dynamicallyLoadsDirectDraw) {
          if (
            !sawDdraw &&
            (indexOfWordBoundary(lowerBuf, totalLen, N_DDRAW_DLL) >= 0 ||
              indexOfWordBoundary(lowerBuf, totalLen, N_DDRAW) >= 0)
          ) {
            sawDdraw = true;
          }
          if (
            !sawDirectDrawCreate &&
            indexOfWordBoundary(lowerBuf, totalLen, N_DDRAW_CREATE) >= 0
          ) {
            sawDirectDrawCreate = true;
          }
          if (sawDdraw && sawDirectDrawCreate) {
            result.dynamicallyLoadsDirectDraw = true;
          }
        }
      }

      if (wantMoreModern) {
        if (!result.dynamicallyLoadsD3d11) {
          if (
            indexOfWordBoundary(lowerBuf, totalLen, N_D3D11_DLL) >= 0 ||
            indexOfWordBoundary(lowerBuf, totalLen, N_D3D11_DLL_U16, true) >= 0
          ) {
            result.dynamicallyLoadsD3d11 = true;
          } else {
            if (
              !sawD3d11CreateDevice &&
              indexOfWordBoundary(chunkBuf, totalLen, N_D3D11_CREATE) >= 0
            ) {
              sawD3d11CreateDevice = true;
            }
            if (
              !sawD3d11OrDxgiHint &&
              (indexOfWordBoundary(lowerBuf, totalLen, N_D3D11_HINT) >= 0 ||
                indexOfWordBoundary(lowerBuf, totalLen, N_DXGI_HINT) >= 0)
            ) {
              sawD3d11OrDxgiHint = true;
            }
            if (sawD3d11CreateDevice && sawD3d11OrDxgiHint) {
              result.dynamicallyLoadsD3d11 = true;
            }
          }
        }
        if (!result.dynamicallyLoadsD3d12) {
          if (
            indexOfWordBoundary(lowerBuf, totalLen, N_D3D12_DLL) >= 0 ||
            indexOfWordBoundary(lowerBuf, totalLen, N_D3D12_DLL_U16, true) >= 0 ||
            indexOfWordBoundary(lowerBuf, totalLen, N_D3D12CORE_DLL) >= 0 ||
            indexOfWordBoundary(lowerBuf, totalLen, N_D3D12CORE_DLL_U16, true) >= 0 ||
            indexOfWordBoundary(chunkBuf, totalLen, N_D3D12_CREATE) >= 0
          ) {
            result.dynamicallyLoadsD3d12 = true;
          }
        }
        if (!result.dynamicallyLoadsDxgi) {
          if (
            !sawDxgiDll &&
            (indexOfWordBoundary(lowerBuf, totalLen, N_DXGI_DLL) >= 0 ||
              indexOfWordBoundary(lowerBuf, totalLen, N_DXGI_DLL_U16, true) >= 0)
          ) {
            sawDxgiDll = true;
          }
          if (!sawDxgiFactory && indexOfWordBoundary(chunkBuf, totalLen, N_DXGI_FACTORY) >= 0) {
            sawDxgiFactory = true;
          }
          if (sawDxgiDll && sawDxgiFactory) {
            result.dynamicallyLoadsDxgi = true;
          }
        }
        if (!result.dynamicallyLoadsVulkan) {
          if (
            !sawVulkanDll &&
            (indexOfWordBoundary(lowerBuf, totalLen, N_VULKAN_DLL) >= 0 ||
              indexOfWordBoundary(lowerBuf, totalLen, N_VULKAN_DLL_U16, true) >= 0)
          ) {
            sawVulkanDll = true;
          }
          if (
            !sawVkCreateInstance &&
            indexOfWordBoundary(chunkBuf, totalLen, N_VK_CREATE_INST) >= 0
          ) {
            sawVkCreateInstance = true;
          }
          if (sawVulkanDll && sawVkCreateInstance) {
            result.dynamicallyLoadsVulkan = true;
          }
        }
      }

      if (wantMoreDpi) {
        if (
          indexOfWordBoundary(chunkBuf, totalLen, N_SET_DPI_CTX) >= 0 ||
          indexOfWordBoundary(chunkBuf, totalLen, N_SET_DPI_AWARE) >= 0
        ) {
          result.callsPerMonitorDpiApi = true;
        }
      }

      carry = Math.min(PE_SCAN_OVERLAP_BYTES, totalLen);
      if (carry > 0) {
        chunkBuf.copy(chunkBuf, 0, totalLen - carry, totalLen);
      }
    }
  }

  return result;
}

/**
 * Inspect Windows executable DOS/PE header to distinguish valid 32/64-bit PE executables
 * from legacy 16-bit MS-DOS MZ executables and identify 64-bit PE32+/ARM64 binaries and imported DLLs.
 *
 * @param {string} filePath
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
function inspectWindowsExecutableHeader(filePath, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const allowSyntheticStub = Boolean(
    opts.allowSyntheticStub ||
      ((process.env.VITEST || process.env.NODE_ENV === 'test') && !opts.strictPe)
  );
  if (!filePath || typeof filePath !== 'string') {
    return {
      exists: false,
      isValidPe: false,
      arch: 'unknown',
      is64Bit: false,
      isX64: false,
      isX86: false,
      isArm64: false,
      is16BitDos: false,
      importedDlls: /** @type {string[]} */ ([]),
    };
  }
  /** @type {number | null} */
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return {
        exists: false,
        isValidPe: false,
        is64Bit: false,
        isX64: false,
        isX86: false,
        isArm64: false,
        is16BitDos: false,
        importedDlls: /** @type {string[]} */ ([]),
      };
    }
    const size = stat.size;
    const isExeTarget = /\.exe$/i.test(filePath);
    const wantDpiManifest = opts.inspectDpiManifest !== false && isExeTarget;
    const sidecarManifestPath = `${filePath}.manifest`;
    let sidecarManifestSig = '';
    if (opts.inspectElevationManifest || wantDpiManifest) {
      try {
        const mst = fs.statSync(sidecarManifestPath);
        if (mst.isFile()) {
          sidecarManifestSig = `${mst.mtimeMs}:${mst.size}`;
        }
      } catch {}
    }
    const cacheKey = `${path.resolve(filePath)}|${stat.mtimeMs}|${size}|${opts.skipImports ? 1 : 0}|${opts.skipRdataStringScan ? 1 : 0}|${opts.skipModernDynamicScan ? 1 : 0}|${opts.inspectElevationManifest ? 1 : 0}|${wantDpiManifest ? 1 : 0}|${allowSyntheticStub ? 1 : 0}|${sidecarManifestSig}`;
    const cachedHit = getCachedPeHeader(cacheKey);
    if (cachedHit) {
      return cachedHit;
    }

    if (size < 2) {
      return {
        exists: true,
        isValidPe: false,
        is64Bit: false,
        isX64: false,
        isX86: false,
        isArm64: false,
        is16BitDos: false,
        importedDlls: /** @type {string[]} */ ([]),
      };
    }

    const readLen = Math.min(64, size);
    const dosHeader = Buffer.alloc(readLen);
    const bytesRead = fs.readSync(fd, dosHeader, 0, readLen, 0);
    if (bytesRead < 2 || dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      return {
        exists: true,
        isValidPe: false,
        is64Bit: false,
        isX64: false,
        isX86: false,
        isArm64: false,
        is16BitDos: false,
        importedDlls: /** @type {string[]} */ ([]),
      };
    }

    if (size < 64 || bytesRead < 64) {
      const isAsciiSyntheticMz =
        allowSyntheticStub &&
        dosHeader
          .subarray(2, bytesRead)
          .every((b) => b === 0 || (b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d);
      if (!isAsciiSyntheticMz) {
        return {
          exists: true,
          isValidPe: false,
          is64Bit: false,
          isX64: false,
          isX86: false,
          isArm64: false,
          is16BitDos: false,
          importedDlls: /** @type {string[]} */ ([]),
        };
      }
      return {
        exists: true,
        isValidPe: true,
        is64Bit: false,
        isX64: false,
        isX86: false,
        isArm64: false,
        is16BitDos: false,
        isSyntheticStub: true,
        importedDlls: /** @type {string[]} */ ([]),
      };
    }

    const peOffset = dosHeader.readUInt32LE(0x3c);
    const isZeroedSyntheticMz =
      peOffset === 0 && dosHeader.subarray(2, 64).every((b) => b === 0);
    if (peOffset < 0x40 || peOffset + 6 > size) {
      if (allowSyntheticStub && isZeroedSyntheticMz) {
        return {
          exists: true,
          isValidPe: true,
          is64Bit: false,
          isX64: false,
          isX86: false,
          isArm64: false,
          is16BitDos: false,
          isSyntheticStub: true,
          importedDlls: /** @type {string[]} */ ([]),
        };
      }
      return {
        exists: true,
        isValidPe: false,
        is64Bit: false,
        isX64: false,
        isX86: false,
        isArm64: false,
        is16BitDos: !isZeroedSyntheticMz && peOffset < 0x40,
        importedDlls: /** @type {string[]} */ ([]),
      };
    }

    const peHeaderSliceLen = Math.min(264, size - peOffset);
    const peBuf = Buffer.alloc(peHeaderSliceLen);
    const peBytesRead = fs.readSync(fd, peBuf, 0, peHeaderSliceLen, peOffset);
    if (
      peBytesRead < 6 ||
      peBuf[0] !== 0x50 ||
      peBuf[1] !== 0x45 ||
      peBuf[2] !== 0x00 ||
      peBuf[3] !== 0x00
    ) {
      return {
        exists: true,
        isValidPe: false,
        is64Bit: false,
        isX64: false,
        isX86: false,
        isArm64: false,
        isArm64Ec: false,
        is16BitDos: true,
        importedDlls: /** @type {string[]} */ ([]),
      };
    }

    const machine = peBuf.readUInt16LE(4);
    const machineHex = `0x${machine.toString(16).padStart(4, '0')}`;
    const isX64 = machine === 0x8664;
    const isX86 = machine === 0x014c;
    const isArm64Ec = machine === 0xa641;
    const isArm64 = machine === 0xaa64 || isArm64Ec;
    const is64Bit = isX64 || isArm64;
    const is32Bit = isX86;

    const sizeOfOptionalHeader = peBytesRead >= 24 ? peBuf.readUInt16LE(20) : 0;
    const coffCharacteristics = peBytesRead >= 24 ? peBuf.readUInt16LE(22) : 0;
    const isLargeAddressAware = is64Bit || (coffCharacteristics & 0x0020) !== 0;

    const hasDllCharacteristics = sizeOfOptionalHeader >= 72 && peBytesRead >= 96;
    const dllCharacteristics = hasDllCharacteristics ? peBuf.readUInt16LE(94) : 0;
    const isNxCompat = hasDllCharacteristics ? (dllCharacteristics & 0x0100) !== 0 : is64Bit;
    const isDynamicBase = hasDllCharacteristics ? (dllCharacteristics & 0x0040) !== 0 : false;

    /** @type {string[]} */
    let importedDlls = [];
    /** @type {string[]} */
    let delayImportedDlls = [];
    let dynamicallyLoadsOpenGl = false;
    let dynamicallyLoadsDirectDraw = false;
    let dynamicallyLoadsD3d11 = false;
    let dynamicallyLoadsD3d12 = false;
    let dynamicallyLoadsDxgi = false;
    let dynamicallyLoadsVulkan = false;
    let callsPerMonitorDpiApi = false;
    let scanBudgetExhausted = false;
    /** @type {ReturnType<typeof readPeSectionsAndDataDirectories> | null} */
    let peLayout = null;
    if (opts.skipImports !== true) {
      try {
        peLayout = readPeSectionsAndDataDirectories(fd, peOffset, size);
        const directImports = readPeImportedDllNamesFromFd(fd, peLayout, size);
        delayImportedDlls = readPeDelayImportedDllNamesFromFd(fd, peLayout, size);
        if (delayImportedDlls.length > 0) {
          const mergedSet = new Set(directImports);
          for (let dIdx = 0; dIdx < delayImportedDlls.length; dIdx += 1) {
            mergedSet.add(delayImportedDlls[dIdx]);
          }
          importedDlls = Array.from(mergedSet);
        } else {
          importedDlls = directImports;
        }
        const hasModernGfxImports = importedDlls.some(
          (d) =>
            d === 'd3d11.dll' ||
            d === 'd3d12.dll' ||
            d === 'd3d12core.dll' ||
            d === 'dxgi.dll' ||
            d === 'vulkan-1.dll'
        );
        const wantLegacyScan =
          (isX86 || isX64) &&
          opts.skipRdataStringScan !== true &&
          !hasModernGfxImports &&
          (!importedDlls.includes('opengl32.dll') || !importedDlls.includes('ddraw.dll'));
        const wantModernScan =
          (isX86 || isX64) &&
          opts.skipRdataStringScan !== true &&
          opts.skipModernDynamicScan !== true &&
          !hasModernGfxImports;
        const wantDpiApiScan =
          (isX86 || isX64) && opts.skipRdataStringScan !== true && isExeTarget;
        if (wantLegacyScan || wantModernScan || wantDpiApiScan) {
          const dataSections = peLayout.sections
            .filter(
              (sec) =>
                (sec.name === '.idata' || sec.name === '.rdata' || sec.name === '.data') &&
                sec.rawPtr > 0 &&
                sec.rawSize > 0 &&
                sec.rawPtr < size
            )
            .sort((a, b) => {
              const rank = (/** @type {string} */ name) =>
                name === '.idata' ? 0 : name === '.rdata' ? 1 : 2;
              return rank(a.name) - rank(b.name);
            });
          /** @type {Array<{ offset: number, length: number }>} */
          const scanRanges = [];
          /**
           * @param {number} offset
           * @param {number} length
           */
          const pushRange = (offset, length) => {
            if (length <= 16 || offset < 0 || offset >= size) return;
            const clampedLen = Math.min(length, size - offset);
            if (clampedLen > 16) {
              scanRanges.push({ offset, length: clampedLen });
            }
          };
          if (peLayout.importDir && peLayout.importDir.rva > 0 && peLayout.importDir.size > 0) {
            const importFileOff = mapPeRvaToFileOffset(
              peLayout.importDir.rva,
              peLayout.sections,
              peLayout.headerLimit,
              size
            );
            if (importFileOff > 0 && importFileOff < size) {
              pushRange(importFileOff, Math.min(Math.max(peLayout.importDir.size, 65536), 262144));
            }
          }
          if (dataSections.length > 0) {
            const perSecCap =
              wantLegacyScan || wantModernScan ? PE_SCAN_PER_FILE_MAX_BYTES : 524288;
            for (let sIdx = 0; sIdx < dataSections.length; sIdx += 1) {
              const sec = dataSections[sIdx];
              const avail = Math.min(sec.rawSize, size - sec.rawPtr);
              if (avail <= perSecCap) {
                pushRange(sec.rawPtr, avail);
              } else {
                const headLen = Math.floor((perSecCap * 3) / 4);
                const tailLen = perSecCap - headLen;
                pushRange(sec.rawPtr, headLen);
                pushRange(sec.rawPtr + avail - tailLen, tailLen);
              }
            }
          } else {
            const fallbackStart = Math.min(peLayout.headerLimit || 4096, size);
            pushRange(fallbackStart, Math.min(262144, Math.max(0, size - fallbackStart)));
          }

          const scanRes = scanPeDynamicStringsFromFd(fd, scanRanges, {
            isX86,
            scanLegacy: wantLegacyScan,
            scanModern: wantModernScan,
            scanDpiApi: wantDpiApiScan,
            importedGdi32: importedDlls.includes('gdi32.dll'),
            rdataBudget: opts.rdataBudget || null,
          });
          dynamicallyLoadsOpenGl = scanRes.dynamicallyLoadsOpenGl;
          dynamicallyLoadsDirectDraw = scanRes.dynamicallyLoadsDirectDraw;
          dynamicallyLoadsD3d11 = scanRes.dynamicallyLoadsD3d11;
          dynamicallyLoadsD3d12 = scanRes.dynamicallyLoadsD3d12;
          dynamicallyLoadsDxgi = scanRes.dynamicallyLoadsDxgi;
          dynamicallyLoadsVulkan = scanRes.dynamicallyLoadsVulkan;
          callsPerMonitorDpiApi = scanRes.callsPerMonitorDpiApi;
          scanBudgetExhausted = scanRes.budgetExhausted;
        }
      } catch {
        importedDlls = [];
        delayImportedDlls = [];
      }
    }

    let requiresElevation = false;
    let hasDpiAwareManifest = false;
    let declaresPerMonitorDpi = false;
    if (opts.inspectElevationManifest || wantDpiManifest) {
      const elevationRe =
        /requestedExecutionLevel[^>]*level\s*=\s*["'](?:requireAdministrator|highestAvailable)["']/i;
      const dpiAwareRe =
        /<(?:[a-z0-9_-]+:)?dpiAware\b[^>]*>\s*(?:true|true\/pm|per\s*monitor)\s*</i;
      const dpiAwarenessRe =
        /<(?:[a-z0-9_-]+:)?dpiAwareness\b[^>]*>[^<]*(?:PerMonitor|System)[^<]*</i;
      const perMonitorAwareRe = /<(?:[a-z0-9_-]+:)?dpiAware\b[^>]*>\s*true\/pm\s*</i;
      const perMonitorAwarenessRe = /<(?:[a-z0-9_-]+:)?dpiAwareness\b[^>]*>[^<]*PerMonitor[^<]*</i;
      /** @param {string} text */
      const applyManifestText = (text) => {
        if (!text) return;
        if (opts.inspectElevationManifest && !requiresElevation && elevationRe.test(text)) {
          requiresElevation = true;
        }
        if (wantDpiManifest) {
          if (!hasDpiAwareManifest && (dpiAwareRe.test(text) || dpiAwarenessRe.test(text))) {
            hasDpiAwareManifest = true;
          }
          if (
            !declaresPerMonitorDpi &&
            (perMonitorAwareRe.test(text) || perMonitorAwarenessRe.test(text))
          ) {
            declaresPerMonitorDpi = true;
          }
        }
      };
      try {
        if (sidecarManifestSig && fs.existsSync(sidecarManifestPath)) {
          applyManifestText(fs.readFileSync(sidecarManifestPath, 'utf8'));
        }
      } catch {}
      const stillNeedElevation = Boolean(opts.inspectElevationManifest && !requiresElevation);
      const stillNeedDpi = Boolean(
        wantDpiManifest && (!hasDpiAwareManifest || !declaresPerMonitorDpi)
      );
      if (stillNeedElevation || stillNeedDpi) {
        try {
          const layout = peLayout || readPeSectionsAndDataDirectories(fd, peOffset, size);
          let scanOffset = Math.max(0, size - 262144);
          let scanLen = Math.min(262144, size - scanOffset);
          for (let i = 0; i < layout.sections.length; i += 1) {
            const sec = layout.sections[i];
            if (sec.name === '.rsrc' && sec.rawPtr > 0 && sec.rawSize > 0 && sec.rawPtr < size) {
              scanOffset = sec.rawPtr;
              scanLen = Math.min(sec.rawSize, 524288, size - sec.rawPtr);
              break;
            }
          }
          if (scanLen > 0) {
            const rsrcBuf = Buffer.alloc(scanLen);
            const rsrcRead = fs.readSync(fd, rsrcBuf, 0, scanLen, scanOffset);
            if (rsrcRead > 0) {
              applyManifestText(rsrcBuf.subarray(0, rsrcRead).toString('latin1'));
            }
          }
        } catch {}
      }
    }
    const arch = isX86
      ? 'x86'
      : isX64
        ? 'x64'
        : isArm64Ec
          ? 'arm64ec'
          : isArm64
            ? 'arm64'
            : 'unknown';
    const peResult = {
      exists: true,
      isValidPe: true,
      arch,
      is32Bit,
      is64Bit,
      isX64,
      isX86,
      isArm64,
      isArm64Ec,
      is16BitDos: false,
      isSyntheticStub: false,
      machine,
      machineHex,
      coffCharacteristics,
      dllCharacteristics,
      isLargeAddressAware,
      isNxCompat,
      isDynamicBase,
      importedDlls,
      delayImportedDlls,
      dynamicallyLoadsOpenGl,
      dynamicallyLoadsDirectDraw,
      dynamicallyLoadsD3d11,
      dynamicallyLoadsD3d12,
      dynamicallyLoadsDxgi,
      dynamicallyLoadsVulkan,
      hasDpiAwareManifest,
      declaresPerMonitorDpi,
      callsPerMonitorDpiApi,
      ...(opts.inspectElevationManifest ? { requiresElevation } : {}),
    };
    if (!scanBudgetExhausted) {
      setCachedPeHeader(cacheKey, peResult);
    }
    return peResult;
  } catch (err) {
    diagLog.debug('inspector.peHeader', err, { filePath });
    return {
      exists: false,
      isValidPe: false,
      arch: 'unknown',
      is32Bit: false,
      is64Bit: false,
      isX64: false,
      isX86: false,
      isArm64: false,
      isArm64Ec: false,
      is16BitDos: false,
      isLargeAddressAware: false,
      isNxCompat: false,
      isDynamicBase: false,
      importedDlls: /** @type {string[]} */ ([]),
      delayImportedDlls: /** @type {string[]} */ ([]),
    };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
  }
}

/**
 * Inspect PE architecture and imported DLL capabilities for a Windows executable or DLL.
 *
 * @param {string} exePath
 * @param {Record<string, any>} [options]
 */
function inspectPeCapabilities(exePath, options = {}) {
  const pe = /** @type {any} */ (inspectWindowsExecutableHeader(exePath, options));
  const machineArch = pe.isX64
    ? 'x64'
    : pe.isX86
      ? 'x86'
      : pe.isArm64Ec
        ? 'arm64ec'
        : pe.isArm64
          ? 'arm64'
          : 'unknown';
  const importedDlls = Array.isArray(pe.importedDlls) ? pe.importedDlls : [];
  const delayImportedDlls = Array.isArray(pe.delayImportedDlls) ? pe.delayImportedDlls : [];
  const is32Bit = Boolean(pe.isX86);
  const is64Bit = Boolean(pe.is64Bit);
  const isLargeAddressAware = is64Bit || Boolean(pe.isLargeAddressAware);
  const isNxCompat = pe.isValidPe ? Boolean(pe.isNxCompat) : false;
  const isDynamicBase = Boolean(pe.isDynamicBase);
  const dynamicallyLoadsOpenGl = Boolean(pe.dynamicallyLoadsOpenGl);
  const dynamicallyLoadsDirectDraw = Boolean(pe.dynamicallyLoadsDirectDraw);
  const dynamicallyLoadsD3d11 = Boolean(pe.dynamicallyLoadsD3d11);
  const dynamicallyLoadsD3d12 = Boolean(pe.dynamicallyLoadsD3d12);
  const dynamicallyLoadsDxgi = Boolean(pe.dynamicallyLoadsDxgi);
  const dynamicallyLoadsVulkan = Boolean(pe.dynamicallyLoadsVulkan);
  const hasDpiAwareManifest = Boolean(pe.hasDpiAwareManifest);
  const declaresPerMonitorDpi = Boolean(pe.declaresPerMonitorDpi);
  const callsPerMonitorDpiApi = Boolean(pe.callsPerMonitorDpiApi);
  const forceGlCore = /(?:^|\s)(?:-force-glcore\d*|-opengl\d*)\b/i.test(
    String(options?.launchArguments || '')
  );
  const mergedForGfx = delayImportedDlls.some(
    (/** @type {string} */ d) => String(d || '').trim().toLowerCase() === 'unityplayer.dll'
  )
    ? Array.from(new Set([...importedDlls, 'unityplayer.dll']))
    : importedDlls;
  const gfxCaps = derivePeGraphicsCapabilities(mergedForGfx, {
    usesDynamicQgl: dynamicallyLoadsOpenGl,
    dynamicallyLoadsDirectDraw,
    dynamicallyLoadsD3d11,
    dynamicallyLoadsD3d12,
    dynamicallyLoadsDxgi,
    dynamicallyLoadsVulkan,
    hasUe5IoStoreContainer: Boolean(options?.hasUe5IoStoreContainer),
    is64Bit,
    forceGlCore,
  });
  const isDosboxExecutable =
    typeof exePath === 'string' && /^dosbox[^\\/]*\.exe$/i.test(path.win32.basename(exePath.trim()));
  return {
    ...pe,
    machineArch,
    is32Bit,
    is64Bit,
    isLargeAddressAware,
    isNxCompat,
    isDynamicBase,
    importedDlls,
    delayImportedDlls,
    dynamicallyLoadsOpenGl,
    dynamicallyLoadsDirectDraw,
    dynamicallyLoadsD3d11,
    dynamicallyLoadsD3d12,
    dynamicallyLoadsDxgi,
    dynamicallyLoadsVulkan,
    hasDpiAwareManifest,
    declaresPerMonitorDpi,
    callsPerMonitorDpiApi,
    isDosboxExecutable,
    ...gfxCaps,
  };
}

/**
 * Inspect PE Export Directory (`IMAGE_DIRECTORY_ENTRY_EXPORT`) forwarder strings in a DLL.
 * Detects malformed export forwarders containing literal backslashes (e.g. hardcoded `C:\Windows\System32\...`
 * forwarders from legacy WinXP/Win7 proxy wrappers that fail on Win10/11 and Wine's PE loader).
 *
 * @param {string} dllPath
 */
function inspectPeExportForwarders(dllPath) {
  const empty = {
    isValidPe: false,
    forwarders: /** @type {string[]} */ ([]),
    hasMalformedBackslashForwarder: false,
  };
  if (!dllPath || typeof dllPath !== 'string') {
    return empty;
  }
  /** @type {number | null} */
  let fd = null;
  try {
    fd = fs.openSync(dllPath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 64) {
      return empty;
    }
    const size = stat.size;
    const dosHeader = Buffer.alloc(64);
    if (
      fs.readSync(fd, dosHeader, 0, 64, 0) < 64 ||
      dosHeader[0] !== 0x4d ||
      dosHeader[1] !== 0x5a
    ) {
      return empty;
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset < 0x40 || peOffset + 24 > size) {
      return empty;
    }
    const sigBuf = Buffer.alloc(4);
    if (
      fs.readSync(fd, sigBuf, 0, 4, peOffset) < 4 ||
      sigBuf[0] !== 0x50 ||
      sigBuf[1] !== 0x45 ||
      sigBuf[2] !== 0x00 ||
      sigBuf[3] !== 0x00
    ) {
      return empty;
    }
    const layout = readPeSectionsAndDataDirectories(fd, peOffset, size);
    const expRva = layout.exportDir.rva;
    const expSize = layout.exportDir.size;
    if (expRva <= 0 || expSize < 40) {
      return { isValidPe: true, forwarders: [], hasMalformedBackslashForwarder: false };
    }
    const expFileOff = mapPeRvaToFileOffset(expRva, layout.sections, layout.headerLimit, size);
    if (expFileOff < 0 || expFileOff + 40 > size) {
      return { isValidPe: true, forwarders: [], hasMalformedBackslashForwarder: false };
    }
    const expDirBuf = Buffer.alloc(40);
    if (fs.readSync(fd, expDirBuf, 0, 40, expFileOff) < 40) {
      return { isValidPe: true, forwarders: [], hasMalformedBackslashForwarder: false };
    }
    const numberOfFunctions = Math.min(expDirBuf.readUInt32LE(20), 4096);
    const addressOfFunctionsRva = expDirBuf.readUInt32LE(28);
    if (numberOfFunctions === 0 || addressOfFunctionsRva === 0) {
      return { isValidPe: true, forwarders: [], hasMalformedBackslashForwarder: false };
    }
    const funcsOff = mapPeRvaToFileOffset(
      addressOfFunctionsRva,
      layout.sections,
      layout.headerLimit,
      size
    );
    if (funcsOff < 0 || funcsOff + 4 > size) {
      return { isValidPe: true, forwarders: [], hasMalformedBackslashForwarder: false };
    }
    const tableBytes = Math.min(numberOfFunctions * 4, size - funcsOff);
    const funcsBuf = Buffer.alloc(tableBytes);
    const funcsRead = fs.readSync(fd, funcsBuf, 0, tableBytes, funcsOff);
    const count = Math.floor(funcsRead / 4);
    /** @type {string[]} */
    const forwarders = [];
    let hasMalformedBackslashForwarder = false;
    /** @type {Set<string>} */
    const seen = new Set();
    for (let i = 0; i < count; i += 1) {
      const fnRva = funcsBuf.readUInt32LE(i * 4);
      if (fnRva >= expRva && fnRva < expRva + expSize) {
        const strOff = mapPeRvaToFileOffset(fnRva, layout.sections, layout.headerLimit, size);
        if (strOff < 0) continue;
        const fwdStr = readAsciiCStringFromFd(fd, strOff, 260, size);
        if (!fwdStr) continue;
        if (!seen.has(fwdStr)) {
          seen.add(fwdStr);
          forwarders.push(fwdStr);
        }
        if (fwdStr.includes('\\')) {
          hasMalformedBackslashForwarder = true;
        }
      }
    }
    return {
      isValidPe: true,
      forwarders,
      hasMalformedBackslashForwarder,
    };
  } catch {
    return empty;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
  }
}

/**
 * Convenience predicate returning `true` when `dllPath` contains any PE export forwarder with a literal `\`.
 *
 * @param {string} dllPath
 * @returns {boolean}
 */
function hasMalformedBackslashExportForwarder(dllPath) {
  return Boolean(inspectPeExportForwarders(dllPath).hasMalformedBackslashForwarder);
}

/**
 * Returns `true` when `peInfo` represents an executable runnable under x64/x86 Wine or x64 Windows
 * (`AMD64` `0x8664`, `I386` `0x014c`, or synthetic test MZ stubs), rejecting `ARM64` (`0xaa64`) and
 * `ARM64EC` (`0xa641`) binaries unless running natively on Windows ARM64 or explicitly inside an
 * Apple Silicon arm64 FEX bottle (`options.allowArm64Pe === true` or `options.wineArch === 'arm64'`).
 *
 * @param {Record<string, any> | null | undefined} peInfo
 * @param {{ hostPlatform?: string, hostArch?: string, allowArm64Pe?: boolean, wineArch?: string }} [options]
 * @returns {boolean}
 */
function isCompatibleX86OrX64PeHeader(peInfo, options = {}) {
  if (!peInfo || peInfo.isValidPe !== true) return false;
  const hostPlatform = options.hostPlatform || process.platform;
  const hostArch = options.hostArch || process.arch;
  if (
    peInfo.machine === 0xaa64 ||
    peInfo.machine === 0xa641 ||
    peInfo.isArm64 === true ||
    peInfo.isArm64Ec === true
  ) {
    if (hostPlatform === 'win32' && hostArch === 'arm64') {
      return true;
    }
    if (
      hostPlatform === 'darwin' &&
      hostArch === 'arm64' &&
      (options.allowArm64Pe === true || options.wineArch === 'arm64')
    ) {
      return true;
    }
    return false;
  }
  return true;
}

/**
 * Inspect macOS Mach-O executable header to distinguish 64-bit, 32-bit only (i386),
 * and Universal (32-bit FAT `0xcafebabe` & 64-bit FAT64 `0xcafebabf`/`0xbfbafeca`) binaries.
 *
 * @param {string} filePath
 * @returns {{ isMachO: boolean, is64Bit: boolean, is32BitOnly: boolean }}
 */
function inspectMacMachOHeader(filePath) {
  /** @type {number | null} */
  let fd = null;
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { isMachO: false, is64Bit: false, is32BitOnly: false };
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 4) {
      return { isMachO: false, is64Bit: false, is32BitOnly: false };
    }
    fd = fs.openSync(filePath, 'r');
    // 8-byte fat_header + up to 8 * 32-byte fat_arch_64 descriptors = 264 bytes
    const buf = Buffer.alloc(264);
    const bytesRead = fs.readSync(fd, buf, 0, 264, 0);
    if (bytesRead < 4) {
      return { isMachO: false, is64Bit: false, is32BitOnly: false };
    }

    const magicLE = buf.readUInt32LE(0);
    const magicBE = buf.readUInt32BE(0);

    if (magicLE === 0xfeedfacf || magicBE === 0xfeedfacf) {
      return { isMachO: true, is64Bit: true, is32BitOnly: false };
    }
    if (magicLE === 0xfeedface || magicBE === 0xfeedface) {
      return { isMachO: true, is64Bit: false, is32BitOnly: true };
    }

    // 32-bit Universal Fat Mach-O (`0xcafebabe` BE / `0xbebafeca` LE, 20-byte `fat_arch`)
    // and 64-bit Universal Fat Mach-O (`0xcafebabf` BE / `0xbfbafeca` LE, 32-byte `fat_arch_64`)
    const isFat32BE = magicBE === 0xcafebabe;
    const isFat32LE = magicBE === 0xbebafeca;
    const isFat64BE = magicBE === 0xcafebabf;
    const isFat64LE = magicBE === 0xbfbafeca;
    if ((isFat32BE || isFat32LE || isFat64BE || isFat64LE) && bytesRead >= 8) {
      const isBigEndian = isFat32BE || isFat64BE;
      const entrySize = isFat64BE || isFat64LE ? 32 : 20;
      const nfat = isBigEndian ? buf.readUInt32BE(4) : buf.readUInt32LE(4);
      if (nfat >= 1 && nfat <= 8 && bytesRead >= 8 + nfat * entrySize) {
        let has64 = false;
        let has32 = false;
        for (let i = 0; i < nfat; i += 1) {
          const entryOff = 8 + i * entrySize;
          const cputype = isBigEndian ? buf.readUInt32BE(entryOff) : buf.readUInt32LE(entryOff);
          if ((cputype & 0x01000000) !== 0) {
            has64 = true;
          } else {
            has32 = true;
          }
        }
        return { isMachO: true, is64Bit: has64, is32BitOnly: !has64 && has32 };
      }
    }
    return { isMachO: false, is64Bit: false, is32BitOnly: false };
  } catch (err) {
    diagLog.debug('inspector.machOHeader', err, { filePath });
    return { isMachO: false, is64Bit: false, is32BitOnly: false };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
  }
}

module.exports = {
  mapPeRvaToFileOffset,
  readAsciiCStringFromFd,
  readPeSectionsAndDataDirectories,
  readPeImportedDllNamesFromFd,
  readPeDelayImportedDllNamesFromFd,
  derivePeGraphicsCapabilities,
  inspectWindowsExecutableHeader,
  inspectPeCapabilities,
  inspectPeExportForwarders,
  hasMalformedBackslashExportForwarder,
  isCompatibleX86OrX64PeHeader,
  inspectMacMachOHeader,
};
