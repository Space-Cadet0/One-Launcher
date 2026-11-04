'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const createdTempDirs = [];

function makeTempDir(prefix = 'ol-e2e') {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`));
  const dir = fs.realpathSync(rawDir);
  createdTempDirs.push(dir);
  return dir;
}

function cleanupTempDirs() {
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop();
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Builds a valid PE32 or PE64 executable buffer with imported DLL names and section table.
 */
function buildSyntheticPeBuffer(spec = {}) {
  const isX64 = spec.arch === 'x64';
  const buf = Buffer.alloc(0x1400, 0);
  const peOffset = 0x80;

  // DOS MZ Header
  buf.writeUInt16LE(0x5a4d, 0x00);
  buf.writeUInt32LE(peOffset, 0x3c);

  // PE Signature
  buf.writeUInt32LE(0x00004550, peOffset);

  // File Header
  buf.writeUInt16LE(isX64 ? 0x8664 : 0x014c, peOffset + 4);
  buf.writeUInt16LE(1, peOffset + 6); // NumberOfSections = 1

  const optHeaderSize = isX64 ? 0xf0 : 0xe0;
  buf.writeUInt16LE(optHeaderSize, peOffset + 20);

  let characteristics = 0x0002; // IMAGE_FILE_EXECUTABLE_IMAGE
  if (spec.largeAddressAware) characteristics |= 0x0020;
  if (!isX64 && !spec.largeAddressAware) characteristics |= 0x0100;
  if (spec.isDll) characteristics |= 0x2000;
  buf.writeUInt16LE(characteristics, peOffset + 22);

  // Optional Header
  const optOffset = peOffset + 24;
  buf.writeUInt16LE(isX64 ? 0x020b : 0x010b, optOffset);
  if (isX64) {
    buf.writeBigUInt64LE(0x0000000140000000n, optOffset + 24);
  } else {
    buf.writeUInt32LE(0x00400000, optOffset + 28);
  }

  let dllChars = 0;
  if (spec.dynamicBase ?? true) dllChars |= 0x0040;
  if (spec.nxCompat ?? true) dllChars |= 0x0100;
  buf.writeUInt16LE(dllChars, optOffset + 70);

  const numRvaOffset = optOffset + (isX64 ? 108 : 92);
  buf.writeUInt32LE(16, numRvaOffset);
  const dataDirOffset = optOffset + (isX64 ? 112 : 96);

  // Section Table (.rdata)
  const secTableOffset = optOffset + optHeaderSize;
  buf.write('.rdata\0\0', secTableOffset, 'ascii');
  buf.writeUInt32LE(0x1000, secTableOffset + 8);  // VirtualSize
  buf.writeUInt32LE(0x1000, secTableOffset + 12); // VirtualAddress
  buf.writeUInt32LE(0x1000, secTableOffset + 16); // SizeOfRawData
  buf.writeUInt32LE(0x0200, secTableOffset + 20); // PointerToRawData
  buf.writeUInt32LE(0x40000040, secTableOffset + 36);

  const rvaToFile = (rva) => 0x0200 + (rva - 0x1000);
  let stringCursorRva = 0x1400;
  const writeAsciiRva = (text) => {
    const rva = stringCursorRva;
    const raw = rvaToFile(rva);
    buf.write(text, raw, 'ascii');
    buf[raw + text.length] = 0;
    stringCursorRva += text.length + 1;
    if (stringCursorRva % 2 !== 0) stringCursorRva += 1;
    return rva;
  };

  const importedDlls = spec.importedDlls || [];
  if (importedDlls.length > 0) {
    const importDirRva = 0x1000;
    const importDirSize = (importedDlls.length + 1) * 20;
    buf.writeUInt32LE(importDirRva, dataDirOffset + 1 * 8);
    buf.writeUInt32LE(importDirSize, dataDirOffset + 1 * 8 + 4);
    for (let i = 0; i < importedDlls.length; i += 1) {
      const nameRva = writeAsciiRva(importedDlls[i]);
      const descFileOff = rvaToFile(importDirRva + i * 20);
      buf.writeUInt32LE(nameRva, descFileOff + 12);
    }
  }

  for (const literal of spec.rdataStrings || []) {
    writeAsciiRva(literal);
  }

  return buf;
}

/**
 * Creates a hermetic Wine prefix bottle with user.reg and system.reg
 */
function createSyntheticBottle(bottleDir, options = {}) {
  fs.mkdirSync(bottleDir, { recursive: true });

  const defaultUserReg = [
    'WINE REGISTRY Version 2',
    ';; All keys relative to \\\\User\\\\S-1-5-21-0-0-0-1000',
    '',
    '[Software\\\\Wine\\\\Mac Driver]',
    options.userRegMacDriver || '"RetinaMode"="y"\n"CaptureDisplaysForFullscreen"="n"\n"UseConfinementCursorClipping"="y"',
    '',
    '[Control Panel\\\\Desktop]',
    '"LogPixels"=dword:00000060',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(bottleDir, 'user.reg'), defaultUserReg, 'utf8');
  fs.writeFileSync(path.join(bottleDir, 'system.reg'), 'WINE REGISTRY Version 2\n\n', 'utf8');

  const cDrive = path.join(bottleDir, 'drive_c');
  fs.mkdirSync(cDrive, { recursive: true });
  fs.mkdirSync(path.join(cDrive, 'windows', 'system32'), { recursive: true });

  return {
    bottleDir,
    cDrive,
    userRegPath: path.join(bottleDir, 'user.reg'),
    systemRegPath: path.join(bottleDir, 'system.reg'),
  };
}

module.exports = {
  makeTempDir,
  cleanupTempDirs,
  buildSyntheticPeBuffer,
  createSyntheticBottle,
};
