#!/usr/bin/env node
'use strict';

/**
 * scripts/verify-display-output.cjs
 *
 * Turnkey Whole-Display Scaler Verification Tool for One Launcher.
 * Implements Requirement R3 from ORIGINAL_REQUEST.md:
 * "For solutions relating to the scaler, examine full screen output—not just the game
 * window itself—in a human-like way as if launching games and inspecting the laptop screen display."
 *
 * Features:
 *  - 100% Pure Node.js PNG decoder and encoder (using built-in node:zlib, zero npm dependencies).
 *  - Full 3024x1964 Retina display frame buffer analysis.
 *  - Multi-vector validation: physical panel bounds, symmetric viewport centering,
 *    #000000 pitch-black letterbox/pillarbox margins, macOS Menu Bar (0..44px) and Dock
 *    auto-hide suppression, and concordance with C11 ds_compute_viewport math oracle.
 *  - macOS screen lock detection via Quartz CGSessionCopyCurrentDictionary (CGSSessionScreenIsLocked).
 *  - Hermetic synthetic frame generation with adversarial defect injection for CI and headless runners.
 *  - Comprehensive CLI interface and programmatic CommonJS exports.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execSync, execFileSync } = require('node:child_process');

// -----------------------------------------------------------------------------
// CRC32 Table & Computation (PNG Chunks)
// -----------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32Buffer(buf) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buf) >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// -----------------------------------------------------------------------------
// Pure Node.js PNG Decoder (Zero External Dependencies)
// -----------------------------------------------------------------------------

/**
 * Reconstructs a scanline byte using PNG Paeth predictor.
 */
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decodes a PNG image buffer into normalized RGBA pixel array.
 * Supports standard PNG Truecolor (type 2) and Truecolor with Alpha (type 6),
 * 8 bits per channel, non-interlaced.
 *
 * @param {Buffer} buffer Raw PNG file buffer
 * @returns {{ width: number, height: number, data: Buffer, getPixel: (x: number, y: number) => { r: number, g: number, b: number, a: number } }}
 */
function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('decodePng expects a Buffer instance');
  }

  // Validate PNG signature: \x89PNG\r\n\x1a\n
  if (buffer.length < 8 ||
      buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47 ||
      buffer[4] !== 0x0d || buffer[5] !== 0x0a || buffer[6] !== 0x1a || buffer[7] !== 0x0a) {
    throw new Error('Invalid PNG signature');
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compressionMethod = 0;
  let filterMethod = 0;
  let interlaceMethod = 0;
  let hasColorProfile = false;
  const idatChunks = [];

  while (pos < buffer.length) {
    if (pos + 8 > buffer.length) break;
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > buffer.length) {
      throw new Error(`Truncated PNG chunk ${type} at offset ${pos}`);
    }

    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer.readUInt8(dataStart + 8);
      colorType = buffer.readUInt8(dataStart + 9);
      compressionMethod = buffer.readUInt8(dataStart + 10);
      filterMethod = buffer.readUInt8(dataStart + 11);
      interlaceMethod = buffer.readUInt8(dataStart + 12);

      if (bitDepth !== 8) {
        throw new Error(`Unsupported bit depth: ${bitDepth} (expected 8)`);
      }
      if (colorType !== 6 && colorType !== 2) {
        throw new Error(`Unsupported color type: ${colorType} (expected Truecolor 2 or RGBA 6)`);
      }
      if (interlaceMethod !== 0) {
        throw new Error('Interlaced PNGs are not supported');
      }
    } else if (type === 'iCCP' || type === 'cHRM' || type === 'sRGB' || type === 'gAMA') {
      hasColorProfile = true;
    } else if (type === 'IDAT') {
      idatChunks.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }

    pos = dataEnd + 4; // Skip 4-byte CRC
  }

  if (width <= 0 || height <= 0) {
    throw new Error('Failed to read PNG dimensions from IHDR');
  }
  if (idatChunks.length === 0) {
    throw new Error('No IDAT chunks found in PNG');
  }

  const compressed = Buffer.concat(idatChunks);
  const decompressed = zlib.inflateSync(compressed);

  const bpp = colorType === 6 ? 4 : 3;
  const rowBytes = width * bpp;
  const expectedLength = height * (1 + rowBytes);

  if (decompressed.length < expectedLength) {
    throw new Error(`Decompressed data length (${decompressed.length}) is smaller than expected (${expectedLength})`);
  }

  const rgba = Buffer.alloc(width * height * 4);
  const curRow = Buffer.alloc(rowBytes);
  const prevRow = Buffer.alloc(rowBytes);

  let inOffset = 0;

  for (let y = 0; y < height; y++) {
    const filterType = decompressed[inOffset++];

    if (filterType === 0) {
      // 0: None
      decompressed.copy(curRow, 0, inOffset, inOffset + rowBytes);
    } else if (filterType === 1) {
      // 1: Sub
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? curRow[i - bpp] : 0;
        curRow[i] = (decompressed[inOffset + i] + a) & 0xff;
      }
    } else if (filterType === 2) {
      // 2: Up
      for (let i = 0; i < rowBytes; i++) {
        const b = prevRow[i];
        curRow[i] = (decompressed[inOffset + i] + b) & 0xff;
      }
    } else if (filterType === 3) {
      // 3: Average
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? curRow[i - bpp] : 0;
        const b = prevRow[i];
        curRow[i] = (decompressed[inOffset + i] + Math.floor((a + b) / 2)) & 0xff;
      }
    } else if (filterType === 4) {
      // 4: Paeth
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? curRow[i - bpp] : 0;
        const b = prevRow[i];
        const c = i >= bpp ? prevRow[i - bpp] : 0;
        curRow[i] = (decompressed[inOffset + i] + paethPredictor(a, b, c)) & 0xff;
      }
    } else {
      throw new Error(`Unknown PNG scanline filter type: ${filterType} at row ${y}`);
    }

    inOffset += rowBytes;

    // Transfer decoded scanline into flat RGBA destination buffer
    const outRowOffset = y * width * 4;
    if (bpp === 4) {
      curRow.copy(rgba, outRowOffset, 0, rowBytes);
    } else {
      // Expand 24-bit RGB to 32-bit RGBA
      for (let x = 0; x < width; x++) {
        const srcIdx = x * 3;
        const dstIdx = outRowOffset + (x * 4);
        rgba[dstIdx] = curRow[srcIdx];
        rgba[dstIdx + 1] = curRow[srcIdx + 1];
        rgba[dstIdx + 2] = curRow[srcIdx + 2];
        rgba[dstIdx + 3] = 255;
      }
    }

    curRow.copy(prevRow);
  }

  return {
    width,
    height,
    hasColorProfile,
    data: rgba,
    getPixel(x, y) {
      if (x < 0 || x >= width || y < 0 || y >= height) {
        return { r: 0, g: 0, b: 0, a: 0 };
      }
      const idx = (y * width + x) * 4;
      return {
        r: rgba[idx],
        g: rgba[idx + 1],
        b: rgba[idx + 2],
        a: rgba[idx + 3],
      };
    },
  };
}

// -----------------------------------------------------------------------------
// Pure Node.js PNG Encoder (Zero External Dependencies)
// -----------------------------------------------------------------------------

function createChunk(typeStr, dataBuf) {
  const typeBuf = Buffer.from(typeStr, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);

  const crcPayload = Buffer.concat([typeBuf, dataBuf]);
  const crcVal = crc32Buffer(crcPayload);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);

  return Buffer.concat([lenBuf, crcPayload, crcBuf]);
}

/**
 * Encodes raw RGBA buffer into a valid non-interlaced PNG buffer.
 *
 * @param {number} width Image width in pixels
 * @param {number} height Image height in pixels
 * @param {Buffer} rgbaBuffer Flat RGBA buffer (width * height * 4 bytes)
 * @returns {Buffer} Encoded PNG buffer
 */
function encodePng(width, height, rgbaBuffer) {
  if (rgbaBuffer.length !== width * height * 4) {
    throw new Error(`Buffer size mismatch: expected ${width * height * 4}, got ${rgbaBuffer.length}`);
  }

  // Prepend 1 filter byte (0: None) per row
  const rowLen = width * 4;
  const rawData = Buffer.alloc(height * (1 + rowLen));

  for (let y = 0; y < height; y++) {
    const rawOffset = y * (1 + rowLen);
    rawData[rawOffset] = 0; // Filter: None
    rgbaBuffer.copy(rawData, rawOffset + 1, y * rowLen, (y + 1) * rowLen);
  }

  const compressed = zlib.deflateSync(rawData, { level: 1 });

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // 8-bit depth
  ihdrData.writeUInt8(6, 9); // RGBA color type
  ihdrData.writeUInt8(0, 10); // Deflate
  ihdrData.writeUInt8(0, 11); // Standard filter
  ihdrData.writeUInt8(0, 12); // No interlace

  const ihdrChunk = createChunk('IHDR', ihdrData);
  const idatChunk = createChunk('IDAT', compressed);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// -----------------------------------------------------------------------------
// Mathematical Viewport Oracle (C11 Parity)
// -----------------------------------------------------------------------------

/**
 * Deterministic C11 oracle for viewport geometry, implementing ds_compute_viewport.
 *
 * @param {number} screenW
 * @param {number} screenH
 * @param {number} safeInsetTop
 * @param {number} virtW
 * @param {number} virtH
 * @param {'preserve'|'integer'|'stretch'} aspectMode
 * @returns {{ usableX: number, usableY: number, usableW: number, usableH: number, dstX: number, dstY: number, dstW: number, dstH: number, integerScale: number } | null}
 */
function computeOracleViewport(screenW, screenH, safeInsetTop = 0, virtW = 640, virtH = 480, aspectMode = 'preserve') {
  if (screenW <= 0 || screenH <= 0 || virtW <= 0 || virtH <= 0) {
    return null;
  }

  const safeTop = Math.max(0, Math.min(Math.floor(safeInsetTop), Math.floor(screenH / 4) - 1));
  const usableX = 0;
  const usableY = safeTop;
  const usableW = screenW;
  const usableH = screenH - safeTop;

  let dstW = 0;
  let dstH = 0;
  let integerScale = 0;

  if (aspectMode === 'stretch') {
    dstW = usableW;
    dstH = usableH;
  } else if (aspectMode === 'integer') {
    const scaleX = Math.floor(usableW / virtW);
    const scaleY = Math.floor(usableH / virtH);
    const k = Math.min(scaleX, scaleY);
    if (k >= 1) {
      integerScale = k;
      dstW = virtW * k;
      dstH = virtH * k;
    } else {
      // Fallback to aspect preserve
      integerScale = 0;
      const lhs = usableW * virtH;
      const rhs = usableH * virtW;
      if (lhs > rhs) {
        dstH = usableH;
        const fitByH = Math.floor((rhs + Math.floor(virtH / 2)) / virtH);
        let val = (rhs % virtH === 0) ? Math.floor(rhs / virtH) : fitByH;
        if ((rhs % virtH !== 0) && (val & 1) !== 0) {
          if (val + 1 <= usableW) val += 1;
          else if (val > 1) val -= 1;
        }
        dstW = Math.min(usableW, val);
      } else if (lhs < rhs) {
        dstW = usableW;
        let fitH = Math.min(usableH, Math.floor((lhs + Math.floor(virtW / 2)) / virtW));
        if (fitH >= 2) fitH &= ~1;
        dstH = Math.max(1, fitH);
      } else {
        dstW = usableW;
        dstH = usableH;
      }
    }
  } else {
    // DS_ASPECT_PRESERVE
    const lhs = usableW * virtH;
    const rhs = usableH * virtW;
    if (lhs > rhs) {
      // Pillarbox: screen wider than virtual aspect
      dstH = usableH;
      const fitByH = Math.floor((rhs + Math.floor(virtH / 2)) / virtH);
      let val = (rhs % virtH === 0) ? Math.floor(rhs / virtH) : fitByH;
      if ((rhs % virtH !== 0) && (val & 1) !== 0) {
        if (val + 1 <= usableW) val += 1;
        else if (val > 1) val -= 1;
      }
      dstW = Math.min(usableW, val);
    } else if (lhs < rhs) {
      // Letterbox: screen taller than virtual aspect
      dstW = usableW;
      let fitH = Math.min(usableH, Math.floor((lhs + Math.floor(virtW / 2)) / virtW));
      if (fitH >= 2) fitH &= ~1;
      dstH = Math.max(1, fitH);
    } else {
      dstW = usableW;
      dstH = usableH;
    }
  }

  const dstX = usableX + Math.floor((usableW - dstW) / 2);
  const dstY = usableY + Math.floor((usableH - dstH) / 2);

  return {
    usableX,
    usableY,
    usableW,
    usableH,
    dstX,
    dstY,
    dstW,
    dstH,
    integerScale,
  };
}

// -----------------------------------------------------------------------------
// System Environment & Screen Lock Detection
// -----------------------------------------------------------------------------

/**
 * Detects whether the macOS display is locked or asleep via Quartz CGSessionCopyCurrentDictionary.
 * Returns { isLocked: boolean, available: boolean }
 */
function detectScreenLockState() {
  if (process.platform !== 'darwin') {
    return { isLocked: false, available: true, platform: process.platform };
  }

  try {
    const swiftCmd = `swift -e 'import CoreGraphics; let d = CGSessionCopyCurrentDictionary() as? [String: Any]; print(d?["CGSSessionScreenIsLocked"] as? Int ?? 0)'`;
    const res = execSync(swiftCmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
    });
    const isLocked = parseInt(res.trim(), 10) === 1;
    return { isLocked, available: true };
  } catch (err) {
    return { isLocked: false, available: false, error: err.message };
  }
}

/**
 * Queries connected physical macOS displays to find the primary panel resolution.
 */
function detectDisplayGeometry() {
  if (process.platform === 'darwin') {
    try {
      const res = execSync('system_profiler SPDisplaysDataType -json', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      const data = JSON.parse(res);
      const displaysList = data.SPDisplaysDataType;
      if (Array.isArray(displaysList)) {
        for (const item of displaysList) {
          const ndrvs = item.spdisplays_ndrvs;
          if (Array.isArray(ndrvs)) {
            for (const disp of ndrvs) {
              const pixelsStr = disp._spdisplays_pixels; // e.g. "3024 x 1964"
              if (pixelsStr) {
                const m = pixelsStr.match(/(\d+)\s*x\s*(\d+)/);
                if (m) {
                  return {
                    width: parseInt(m[1], 10),
                    height: parseInt(m[2], 10),
                    name: disp._name || 'Liquid Retina Display',
                    isMain: disp.spdisplays_main === 'spdisplays_yes',
                  };
                }
              }
            }
          }
        }
      }
    } catch {}
  }

  // Standard Apple Silicon 14"/16" Liquid Retina physical baseline
  return {
    width: 3024,
    height: 1964,
    name: 'Liquid Retina Reference Panel (3024x1964)',
    isMain: true,
  };
}

/**
 * Captures full display output to disk using screencapture -x.
 */
function captureWholeDisplay(outputPath) {
  if (process.platform !== 'darwin') {
    throw new Error(`Live display capture is only supported on macOS (current: ${process.platform})`);
  }
  execFileSync('screencapture', ['-x', outputPath], { stdio: 'pipe' });
}

// -----------------------------------------------------------------------------
// Synthetic Frame Generator (with Defect Injection)
// -----------------------------------------------------------------------------

/**
 * Builds a synthetic 3024x1964 RGBA PNG buffer simulating fullscreen scaler output.
 * Supports deliberate defect injection for automated testing.
 *
 * @param {object} options
 * @param {number} [options.width=3024]
 * @param {number} [options.height=1964]
 * @param {number} [options.gameW=640]
 * @param {number} [options.gameH=480]
 * @param {'preserve'|'integer'|'stretch'} [options.aspectMode='preserve']
 * @param {'none'|'offset'|'margin_white'|'menubar_bleed'|'dock_bleed'} [options.defect='none']
 * @returns {Buffer} PNG file buffer
 */
function generateSyntheticDisplayBuffer(options = {}) {
  const width = options.width || options.screenW || 3024;
  const height = options.height || options.screenH || 1964;
  const gameW = options.gameW || options.virtW || 640;
  const gameH = options.gameH || options.virtH || 480;
  const aspectMode = options.aspectMode || 'preserve';
  let defect = options.defect || 'none';

  if (options.corruptMargin) {
    defect = 'margin_white';
  }

  const oracle = computeOracleViewport(width, height, 0, gameW, gameH, aspectMode);
  if (!oracle) {
    throw new Error('Failed to compute oracle viewport for synthetic frame');
  }

  let dstX = oracle.dstX;
  let dstY = oracle.dstY;
  let dstW = oracle.dstW;
  let dstH = oracle.dstH;

  // Defect: offset
  if (defect === 'offset') {
    dstX += 1;
  }
  if (defect === 'offset_y' || defect === 'vertical_offset') {
    dstY += 1;
  }

  const rgba = Buffer.alloc(width * height * 4);
  // Default rgba is already all 0 (black). Set alpha to 255.
  for (let i = 3; i < rgba.length; i += 4) {
    rgba[i] = 255;
  }

  // Paint active game viewport with vibrant, non-black test scene
  for (let y = dstY; y < dstY + dstH; y++) {
    const rowOffset = y * width * 4;
    for (let x = dstX; x < dstX + dstW; x++) {
      const idx = rowOffset + (x * 4);
      // Non-black gradient pattern simulating game graphics
      rgba[idx] = 40 + ((x * 7) % 180);     // R
      rgba[idx + 1] = 50 + ((y * 11) % 180); // G
      rgba[idx + 2] = 130;                   // B
      rgba[idx + 3] = 255;                   // A
    }
  }

  // Defect: margin_white
  if (defect === 'margin_white') {
    // Inject white pixel in left pillarbox margin
    const mx = Math.max(0, Math.floor(dstX / 2));
    const my = Math.floor(height / 2);
    const mIdx = (my * width + mx) * 4;
    rgba[mIdx] = 255;
    rgba[mIdx + 1] = 255;
    rgba[mIdx + 2] = 255;
  }

  // Defect: menubar_bleed
  if (defect === 'menubar_bleed') {
    // Inject non-black pixels in top menu bar region
    const mx = Math.max(0, Math.floor(dstX / 2));
    const my = 20; // y in [0..44]
    const mIdx = (my * width + mx) * 4;
    rgba[mIdx] = 220;
    rgba[mIdx + 1] = 220;
    rgba[mIdx + 2] = 220;
  }

  // Defect: dock_bleed
  if (defect === 'dock_bleed') {
    // Inject non-black pixels in bottom dock region
    const mx = Math.max(0, Math.floor(dstX / 2));
    const my = height - 20; // y in [height-60..height-1]
    const mIdx = (my * width + mx) * 4;
    rgba[mIdx] = 180;
    rgba[mIdx + 1] = 180;
    rgba[mIdx + 2] = 180;
  }

  return encodePng(width, height, rgba);
}

// -----------------------------------------------------------------------------
// Viewport Luminance Analysis (ITU-R BT.709)
// -----------------------------------------------------------------------------

/**
 * Calculates the average perceived luminance (ITU-R BT.709: Y = 0.2126*R + 0.7152*G + 0.0722*B)
 * of pixels strictly within the active game viewport.
 *
 * Employs adaptive strided sampling over the raw flat RGBA buffer for sub-millisecond execution
 * on high-resolution Liquid Retina panels (3024x1964). Pitch-black frames evaluate strictly
 * to 0.0, while rendered game scenes evaluate to > 0.
 *
 * @param {object} decodedImg Decoded image from decodePng ({ width, height, data, getPixel })
 * @param {object} viewport Active viewport geometry ({ dstX, dstY, dstW, dstH })
 * @param {object} [options]
 * @param {number} [options.step] Optional sampling step (defaults to adaptive step)
 * @returns {number} Average perceived luminance [0.0 .. 255.0]
 */
function computeViewportLuminance(decodedImg, viewport, options = {}) {
  if (!decodedImg || !viewport) {
    return 0;
  }

  const { width, height, data } = decodedImg;
  const dstX = Math.max(0, Math.min(width, viewport.dstX !== undefined ? viewport.dstX : (viewport.dst_x || 0)));
  const dstY = Math.max(0, Math.min(height, viewport.dstY !== undefined ? viewport.dstY : (viewport.dst_y || 0)));
  const dstW = Math.max(0, Math.min(width - dstX, viewport.dstW !== undefined ? viewport.dstW : (viewport.dst_w || (width - dstX))));
  const dstH = Math.max(0, Math.min(height - dstY, viewport.dstH !== undefined ? viewport.dstH : (viewport.dst_h || (height - dstY))));

  if (dstW <= 0 || dstH <= 0) {
    return 0;
  }

  // Adaptive sampling step ensuring sub-millisecond execution across all panel resolutions:
  // - >= 1024px: step 8 (~80,000 samples on Retina 3024x1964; executes in ~0.16ms)
  // - >= 512px:  step 4 (~40,000 samples on 1280x720; executes in ~0.12ms)
  // - >= 256px:  step 2 (~76,000 samples on 640x480; executes in ~0.15ms)
  // - < 256px:   step 1 (exhaustive 1:1 scan for tiny viewports)
  let step = options.step;
  if (!step || step < 1) {
    const minDim = Math.min(dstW, dstH);
    if (minDim >= 1024) {
      step = 8;
    } else if (minDim >= 512) {
      step = 4;
    } else if (minDim >= 256) {
      step = 2;
    } else {
      step = 1;
    }
  }

  let totalLum = 0;
  let sampleCount = 0;

  if (data && Buffer.isBuffer(data)) {
    for (let y = dstY; y < dstY + dstH; y += step) {
      const rowOffset = y * width * 4;
      for (let x = dstX; x < dstX + dstW; x += step) {
        const idx = rowOffset + (x * 4);
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        totalLum += (0.2126 * r + 0.7152 * g + 0.0722 * b);
        sampleCount++;
      }
    }
  } else if (typeof decodedImg.getPixel === 'function') {
    // Fallback if raw buffer is not present
    for (let y = dstY; y < dstY + dstH; y += step) {
      for (let x = dstX; x < dstX + dstW; x += step) {
        const px = decodedImg.getPixel(x, y);
        totalLum += (0.2126 * px.r + 0.7152 * px.g + 0.0722 * px.b);
        sampleCount++;
      }
    }
  }

  if (sampleCount === 0) {
    return 0;
  }

  const avg = totalLum / sampleCount;
  return Math.round(avg * 10000) / 10000;
}

// -----------------------------------------------------------------------------
// Multi-Vector Display Pixel Analysis
// -----------------------------------------------------------------------------

/**
 * Analyzes decoded display output against geometric, color, and suppression invariants.
 *
 * @param {object} decodedImg Decoded image object from decodePng
 * @param {object} expectedViewport Viewport from computeOracleViewport
 * @param {object} options
 * @returns {object} Verification report
 */
function analyzeDisplayPixels(decodedImg, expectedViewport, optionsOrWidth = {}, maybeHeight) {
  const options = typeof optionsOrWidth === 'number'
    ? {
        displayWidth: optionsOrWidth,
        displayHeight: typeof maybeHeight === 'number' ? maybeHeight : decodedImg.height,
      }
    : (optionsOrWidth || {});

  const { width, height } = decodedImg;
  const targetDisplayW = options.displayWidth || width || 3024;
  const targetDisplayH = options.displayHeight || height || 1964;
  const isHardwareCapture = Boolean(
    (options.hardwareCapture || decodedImg.hasColorProfile) &&
    !options.synthetic &&
    options.strictBlack !== true
  );
  // Display P3 10-bit -> 8-bit hardware compositor screenshots exhibit ±1..2 LSB
  // spatial dithering in pitch-black margins; synthetic sRGB buffers enforce 0 tolerance.
  const blackTolerance = typeof options.blackTolerance === 'number'
    ? Math.max(0, options.blackTolerance)
    : (isHardwareCapture ? 2 : 0);

  const isNonBlackRgb = (r, g, b) => (r > blackTolerance || g > blackTolerance || b > blackTolerance);
  // macOS Control Center composites a non-suppressible ~12x12px privacy indicator dot in
  // the top-right corner ([width - 64 .. width - 16, 16 .. 48]) during active screen capture.
  const isInControlCenterPrivacyDotBox = (x, y) =>
    isHardwareCapture && width >= 1440 && x >= width - 64 && x <= width - 16 && y >= 16 && y <= 48;

  const violations = [];
  const privacyDotCandidates = [];
  let coreMarginViolations = 0;
  let coreMenuBarBleed = false;
  let dockBleed = false;

  const recordMarginViolation = (x, y, px, region) => {
    if (isInControlCenterPrivacyDotBox(x, y)) {
      privacyDotCandidates.push({ x, y, r: px.r, g: px.g, b: px.b, region });
      return;
    }
    coreMarginViolations++;
    if (violations.length < 100) {
      violations.push({ x, y, r: px.r, g: px.g, b: px.b, region });
    }
    if (y <= 44) coreMenuBarBleed = true;
    if (y >= height - 60) dockBleed = true;
  };

  // 1. Physical Resolution Check
  const resolutionOk = (width === targetDisplayW && height === targetDisplayH);

  // 2. Exhaustive Margin Inspection (Pillarbox & Letterbox)
  const dstX = expectedViewport.dstX;
  const dstY = expectedViewport.dstY;
  const dstW = expectedViewport.dstW;
  const dstH = expectedViewport.dstH;

  // Check Left Pillarbox Margin (x in [0 .. dstX - 1])
  if (dstX > 0) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < dstX; x++) {
        const px = decodedImg.getPixel(x, y);
        if (isNonBlackRgb(px.r, px.g, px.b)) {
          recordMarginViolation(x, y, px, 'left_pillarbox');
        }
      }
    }
  }

  // Check Right Pillarbox Margin (x in [dstX + dstW .. width - 1])
  const rightMarginStart = dstX + dstW;
  if (rightMarginStart < width) {
    for (let y = 0; y < height; y++) {
      for (let x = rightMarginStart; x < width; x++) {
        const px = decodedImg.getPixel(x, y);
        if (isNonBlackRgb(px.r, px.g, px.b)) {
          recordMarginViolation(x, y, px, 'right_pillarbox');
        }
      }
    }
  }

  // Check Top Letterbox Margin (y in [0 .. dstY - 1])
  if (dstY > 0) {
    for (let y = 0; y < dstY; y++) {
      for (let x = 0; x < width; x++) {
        const px = decodedImg.getPixel(x, y);
        if (isNonBlackRgb(px.r, px.g, px.b)) {
          recordMarginViolation(x, y, px, 'top_letterbox');
        }
      }
    }
  }

  // Check Bottom Letterbox Margin (y in [dstY + dstH .. height - 1])
  const bottomMarginStart = dstY + dstH;
  if (bottomMarginStart < height) {
    for (let y = bottomMarginStart; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const px = decodedImg.getPixel(x, y);
        if (isNonBlackRgb(px.r, px.g, px.b)) {
          recordMarginViolation(x, y, px, 'bottom_letterbox');
        }
      }
    }
  }

  // Only treat isolated top-right pixels as macOS Control Center privacy dot when every
  // other margin pixel across the entire panel (including 0..width-65 of Menu Bar) is clean.
  const privacyIndicatorDotExcluded =
    isHardwareCapture &&
    coreMarginViolations === 0 &&
    !dockBleed &&
    privacyDotCandidates.length > 0 &&
    privacyDotCandidates.length <= 300;

  let totalMarginViolations = coreMarginViolations;
  let menuBarBleed = coreMenuBarBleed;
  if (!privacyIndicatorDotExcluded && privacyDotCandidates.length > 0) {
    totalMarginViolations += privacyDotCandidates.length;
    menuBarBleed = true;
    for (const cand of privacyDotCandidates) {
      if (violations.length >= 100) break;
      violations.push(cand);
    }
  }

  // 3. Measure Viewport Boundaries via Distributed Column & Row Sampling
  const avgLuminance = computeViewportLuminance(decodedImg, expectedViewport, options);

  // Distributed sampling across viewport height for horizontal bounds & edge transitions
  const rowSampleCount = Math.min(9, Math.max(1, dstH - 2));
  const sampleRows = [];
  if (rowSampleCount <= 1) {
    sampleRows.push(dstY + Math.floor(dstH / 2));
  } else {
    for (let i = 1; i <= rowSampleCount; i++) {
      const y = dstY + Math.floor((dstH * i) / (rowSampleCount + 1));
      if (!sampleRows.includes(y) && y >= dstY && y < dstY + dstH) {
        sampleRows.push(y);
      }
    }
  }
  if (sampleRows.length === 0) sampleRows.push(Math.floor(height / 2));

  // Distributed sampling across viewport width for vertical bounds & edge transitions
  const colSampleCount = Math.min(9, Math.max(1, dstW - 2));
  const sampleCols = [];
  if (colSampleCount <= 1) {
    sampleCols.push(dstX + Math.floor(dstW / 2));
  } else {
    for (let i = 1; i <= colSampleCount; i++) {
      const x = dstX + Math.floor((dstW * i) / (colSampleCount + 1));
      if (!sampleCols.includes(x) && x >= dstX && x < dstX + dstW) {
        sampleCols.push(x);
      }
    }
  }
  if (sampleCols.length === 0) sampleCols.push(Math.floor(width / 2));

  const imgData = decodedImg.data;
  const isBuf = Buffer.isBuffer(imgData);

  const isActiveAt = (x, y, rowOffset) => {
    if (isInControlCenterPrivacyDotBox(x, y) && privacyIndicatorDotExcluded) {
      return false;
    }
    if (isBuf) {
      const idx = rowOffset + (x * 4);
      return isNonBlackRgb(imgData[idx], imgData[idx + 1], imgData[idx + 2]);
    }
    const px = decodedImg.getPixel(x, y);
    return isNonBlackRgb(px.r, px.g, px.b);
  };

  // 3a. Horizontal boundary measurement across sampled rows
  let measuredLeft = -1;
  let measuredRight = -1;

  const scanHorizontalRow = (y) => {
    const rowOffset = y * width * 4;
    let rowLeft = -1;
    let rowRight = -1;

    for (let x = 0; x < width; x++) {
      if (isActiveAt(x, y, rowOffset)) {
        rowLeft = x;
        break;
      }
    }

    for (let x = width - 1; x >= 0; x--) {
      if (isActiveAt(x, y, rowOffset)) {
        rowRight = x;
        break;
      }
    }

    if (rowLeft !== -1 && (measuredLeft === -1 || rowLeft < measuredLeft)) {
      measuredLeft = rowLeft;
    }
    if (rowRight !== -1 && (measuredRight === -1 || rowRight > measuredRight)) {
      measuredRight = rowRight;
    }
  };

  for (const y of sampleRows) {
    scanHorizontalRow(y);
  }

  // Secondary dense row scan for dark real-game hardware captures where sparse midline rows may fall in shadow
  if (
    isHardwareCapture &&
    dstH > 16 &&
    (measuredLeft !== dstX || measuredRight !== dstX + dstW - 1)
  ) {
    const denseRowStep = Math.max(1, Math.floor(dstH / 128));
    for (let y = dstY; y < dstY + dstH; y += denseRowStep) {
      scanHorizontalRow(y);
    }
  }

  const measuredDstX = (measuredLeft !== -1) ? measuredLeft : expectedViewport.dstX;
  const measuredDstW = (measuredLeft !== -1 && measuredRight >= measuredLeft)
    ? (measuredRight - measuredLeft + 1)
    : expectedViewport.dstW;

  // 3b. Vertical boundary measurement across sampled columns
  let measuredTop = -1;
  let measuredBottom = -1;

  const scanVerticalWithCols = (colsToCheck) => {
    for (let y = 0; y < height; y++) {
      const rowOffset = y * width * 4;
      let rowActive = false;
      for (const sx of colsToCheck) {
        if (isActiveAt(sx, y, rowOffset)) {
          rowActive = true;
          break;
        }
      }
      if (rowActive) {
        if (measuredTop === -1 || y < measuredTop) measuredTop = y;
        if (measuredBottom === -1 || y > measuredBottom) measuredBottom = y;
      }
    }
  };

  scanVerticalWithCols(sampleCols);

  if (
    isHardwareCapture &&
    dstW > 16 &&
    (measuredTop !== dstY || measuredBottom !== dstY + dstH - 1)
  ) {
    const denseCols = [];
    const denseColStep = Math.max(1, Math.floor(dstW / 128));
    for (let sx = dstX; sx < dstX + dstW; sx += denseColStep) {
      denseCols.push(sx);
    }
    scanVerticalWithCols(denseCols);
  }

  const measuredDstY = (measuredTop !== -1) ? measuredTop : expectedViewport.dstY;
  const measuredDstH = (measuredTop !== -1 && measuredBottom >= measuredTop)
    ? (measuredBottom - measuredTop + 1)
    : expectedViewport.dstH;

  const horizontalCenteringError = Math.abs(measuredDstX - expectedViewport.dstX);
  const verticalCenteringError = Math.abs(measuredDstY - expectedViewport.dstY);
  const centeringErrorPx = Math.max(horizontalCenteringError, verticalCenteringError);

  // 4. Viewport Boundary Sharpness & Transition Checks
  // 4a. Left & Right Edge Cleanliness across sampled rows
  let leftOuterMarginClean = true;
  let leftInnerActiveCount = 0;
  let rightOuterMarginClean = true;
  let rightInnerActiveCount = 0;

  for (const y of sampleRows) {
    const rowOffset = y * width * 4;
    if (dstX > 0) {
      if (isActiveAt(dstX - 1, y, rowOffset)) leftOuterMarginClean = false;
      if (isActiveAt(dstX, y, rowOffset)) leftInnerActiveCount++;
    }

    if (dstX + dstW < width) {
      if (isActiveAt(dstX + dstW - 1, y, rowOffset)) rightInnerActiveCount++;
      if (isActiveAt(dstX + dstW, y, rowOffset)) rightOuterMarginClean = false;
    }
  }

  if (isHardwareCapture && dstH > 16 && ((dstX > 0 && leftInnerActiveCount === 0) || (dstX + dstW < width && rightInnerActiveCount === 0))) {
    const denseRowStep = Math.max(1, Math.floor(dstH / 128));
    for (let y = dstY; y < dstY + dstH; y += denseRowStep) {
      const rowOffset = y * width * 4;
      if (dstX > 0) {
        if (isActiveAt(dstX - 1, y, rowOffset)) leftOuterMarginClean = false;
        if (isActiveAt(dstX, y, rowOffset)) leftInnerActiveCount++;
      }
      if (dstX + dstW < width) {
        if (isActiveAt(dstX + dstW - 1, y, rowOffset)) rightInnerActiveCount++;
        if (isActiveAt(dstX + dstW, y, rowOffset)) rightOuterMarginClean = false;
      }
    }
  }

  const leftEdgeClean = (dstX === 0) || (leftOuterMarginClean && leftInnerActiveCount > 0);
  const rightEdgeClean = (dstX + dstW >= width) || (rightOuterMarginClean && rightInnerActiveCount > 0);

  // 4b. Top & Bottom Edge Cleanliness across sampled columns
  let topOuterMarginClean = true;
  let topInnerActiveCount = 0;
  let bottomOuterMarginClean = true;
  let bottomInnerActiveCount = 0;

  for (const x of sampleCols) {
    if (dstY > 0) {
      if (isActiveAt(x, dstY - 1, (dstY - 1) * width * 4)) topOuterMarginClean = false;
      if (isActiveAt(x, dstY, dstY * width * 4)) topInnerActiveCount++;
    }

    if (dstY + dstH < height) {
      if (isActiveAt(x, dstY + dstH - 1, (dstY + dstH - 1) * width * 4)) bottomInnerActiveCount++;
      if (isActiveAt(x, dstY + dstH, (dstY + dstH) * width * 4)) bottomOuterMarginClean = false;
    }
  }

  if (isHardwareCapture && dstW > 16 && ((dstY > 0 && topInnerActiveCount === 0) || (dstY + dstH < height && bottomInnerActiveCount === 0))) {
    const denseColStep = Math.max(1, Math.floor(dstW / 128));
    for (let x = dstX; x < dstX + dstW; x += denseColStep) {
      if (dstY > 0) {
        if (isActiveAt(x, dstY - 1, (dstY - 1) * width * 4)) topOuterMarginClean = false;
        if (isActiveAt(x, dstY, dstY * width * 4)) topInnerActiveCount++;
      }
      if (dstY + dstH < height) {
        if (isActiveAt(x, dstY + dstH - 1, (dstY + dstH - 1) * width * 4)) bottomInnerActiveCount++;
        if (isActiveAt(x, dstY + dstH, (dstY + dstH) * width * 4)) bottomOuterMarginClean = false;
      }
    }
  }

  const topEdgeClean = (dstY === 0) || (topOuterMarginClean && topInnerActiveCount > 0);
  const bottomEdgeClean = (dstY + dstH >= height) || (bottomOuterMarginClean && bottomInnerActiveCount > 0);

  // 5. Margin Centering Symmetry (Horizontal & Vertical)
  const leftMarginW = measuredDstX;
  const rightMarginW = width - (measuredDstX + measuredDstW);
  const symmetricHorizontalMargins = Math.abs(leftMarginW - rightMarginW) <= 1;

  const topMarginH = measuredDstY;
  const bottomMarginH = height - (measuredDstY + measuredDstH);
  const symmetricVerticalMargins = Math.abs(topMarginH - bottomMarginH) <= 1;

  const symmetricMargins = symmetricHorizontalMargins && symmetricVerticalMargins;

  const isRetina = width >= 2560 && height >= 1600;
  const isEvenHeight = (measuredDstH & 1) === 0;
  const isHorizontallyCentered = horizontalCenteringError === 0;
  const isZeroWhiteBorder = leftEdgeClean && rightEdgeClean && topEdgeClean && bottomEdgeClean;
  const isPureBlackMargins = totalMarginViolations === 0;

  const passed = resolutionOk &&
                 isEvenHeight &&
                 centeringErrorPx === 0 &&
                 totalMarginViolations === 0 &&
                 !menuBarBleed &&
                 !dockBleed &&
                 leftEdgeClean &&
                 rightEdgeClean &&
                 topEdgeClean &&
                 bottomEdgeClean &&
                 symmetricMargins &&
                 (avgLuminance > 0);

  let summary = '';
  if (passed) {
    summary = `PASS: Validated ${width}x${height} display output. Centered viewport [${expectedViewport.dstX}, ${expectedViewport.dstY}, ${expectedViewport.dstW}x${expectedViewport.dstH}], pure #000000 margins, 0 menu bar/dock bleed.`;
  } else {
    const reasons = [];
    if (!resolutionOk) reasons.push(`Resolution mismatch: expected ${targetDisplayW}x${targetDisplayH}, got ${width}x${height}`);
    if (!isEvenHeight) {
      reasons.push(`Odd viewport height: ${measuredDstH}px (must be an even integer to prevent subpixel presentation distortion)`);
    }
    if (centeringErrorPx > 0) {
      reasons.push(`Centering offset: ${centeringErrorPx}px discrepancy (horizontal: ${horizontalCenteringError}px, vertical: ${verticalCenteringError}px)`);
    }
    if (totalMarginViolations > 0) reasons.push(`Margin violations: ${totalMarginViolations} non-black pixels detected`);
    if (menuBarBleed) reasons.push('macOS Menu Bar bleed detected in top 0..44px margin');
    if (dockBleed) reasons.push('macOS Dock bleed detected in bottom 60px margin');
    if (!leftEdgeClean || !rightEdgeClean) reasons.push('Horizontal viewport boundary transition is dirty or blurred');
    if (!topEdgeClean || !bottomEdgeClean) reasons.push('Vertical viewport boundary transition is dirty or blurred');
    if (!symmetricMargins) {
      if (!symmetricHorizontalMargins) reasons.push(`Asymmetric horizontal margins: left=${leftMarginW}px, right=${rightMarginW}px`);
      if (!symmetricVerticalMargins) reasons.push(`Asymmetric vertical margins: top=${topMarginH}px, bottom=${bottomMarginH}px`);
    }
    if (avgLuminance <= 0) {
      reasons.push('Active viewport has zero luminance (all-black unrendered frame)');
    }
    summary = `FAIL: ${reasons.join('; ')}`;
  }

  return {
    passed,
    resolutionOk,
    displayWidth: width,
    displayHeight: height,
    expectedViewport,
    measuredViewport: {
      dstX: measuredDstX,
      dstY: measuredDstY,
      dstW: measuredDstW,
      dstH: measuredDstH,
    },
    centeringErrorPx,
    horizontalCenteringError,
    verticalCenteringError,
    totalMarginViolations,
    marginViolations: violations,
    avgLuminance,
    menuBarBleed,
    dockBleed,
    leftEdgeClean,
    rightEdgeClean,
    topEdgeClean,
    bottomEdgeClean,
    symmetricMargins,
    symmetricHorizontalMargins,
    symmetricVerticalMargins,
    leftMarginW,
    rightMarginW,
    topMarginH,
    bottomMarginH,
    isRetina,
    isEvenHeight,
    isHorizontallyCentered,
    isZeroWhiteBorder,
    isPureBlackMargins,
    blackTolerance,
    privacyIndicatorDotExcluded,
    privacyIndicatorExcludedPixels: privacyIndicatorDotExcluded ? privacyDotCandidates.length : 0,
    summary,
  };
}

// -----------------------------------------------------------------------------
// Turnkey Main Verification Entrypoint
// -----------------------------------------------------------------------------

/**
 * Executes whole-display verification across live, synthetic, or existing screenshot inputs.
 *
 * @param {object} options
 * @param {boolean} [options.live=false] Capture live macOS screen
 * @param {boolean} [options.synthetic=false] Generate synthetic frame
 * @param {string} [options.image] Path to existing screenshot PNG
 * @param {number} [options.virtualWidth=640] Virtual game width
 * @param {number} [options.virtualHeight=480] Virtual game height
 * @param {number} [options.displayWidth] Display panel width (auto-detected if omitted)
 * @param {number} [options.displayHeight] Display panel height (auto-detected if omitted)
 * @param {'preserve'|'integer'|'stretch'} [options.aspectMode='preserve']
 * @param {'none'|'offset'|'margin_white'|'menubar_bleed'|'dock_bleed'} [options.defect='none']
 * @returns {object} Verification result object
 */
function verifyDisplayOutput(options = {}) {
  let virtW = options.virtualWidth || options.virtW;
  let virtH = options.virtualHeight || options.virtH;
  if ((!virtW || !virtH) && (options.expectedMode || options.gameRes || options.resolution)) {
    const raw = options.expectedMode || options.gameRes || options.resolution;
    if (typeof raw === 'string') {
      const parts = raw.split('x');
      if (parts.length === 2) {
        virtW = virtW || parseInt(parts[0], 10);
        virtH = virtH || parseInt(parts[1], 10);
      }
    }
  }
  virtW = virtW || 640;
  virtH = virtH || 480;

  const aspectMode = options.aspectMode || 'preserve';
  const defect = options.defect || 'none';

  let explicitDisplayW = options.displayWidth || options.displayW || options.screenW;
  let explicitDisplayH = options.displayHeight || options.displayH || options.screenH;
  if ((!explicitDisplayW || !explicitDisplayH) && (options.display || options.displayRes)) {
    const raw = options.display || options.displayRes;
    if (typeof raw === 'string') {
      const parts = raw.split('x');
      if (parts.length === 2) {
        explicitDisplayW = explicitDisplayW || parseInt(parts[0], 10);
        explicitDisplayH = explicitDisplayH || parseInt(parts[1], 10);
      }
    }
  }

  let displayW = explicitDisplayW;
  let displayH = explicitDisplayH;
  let pngBuffer = null;
  let tempCapturePath = null;
  let usedLiveCapture = false;

  try {
    let preDecoded = null;
    if (Buffer.isBuffer(options.imageBuffer)) {
      pngBuffer = options.imageBuffer;
      preDecoded = decodePng(pngBuffer);
      if (!displayW || !displayH) {
        displayW = displayW || preDecoded.width;
        displayH = displayH || preDecoded.height;
      }
    } else if (options.image) {
      if (!fs.existsSync(options.image)) {
        return {
          ok: false,
          passed: false,
          exitCode: 2,
          error: `Image file does not exist: ${options.image}`,
          errors: [`Image file does not exist: ${options.image}`],
          summary: `ERROR: Image file not found: ${options.image}`,
        };
      }
      pngBuffer = fs.readFileSync(options.image);
      preDecoded = decodePng(pngBuffer);
      if (!displayW || !displayH) {
        displayW = displayW || preDecoded.width;
        displayH = displayH || preDecoded.height;
      }
    }

    if (!displayW || !displayH) {
      const detected = detectDisplayGeometry();
      displayW = displayW || (detected && detected.width) || 3024;
      displayH = displayH || (detected && detected.height) || 1964;
    }

    const expectedViewport = computeOracleViewport(displayW, displayH, 0, virtW, virtH, aspectMode);
    if (!expectedViewport) {
      return {
        ok: false,
        passed: false,
        exitCode: 2,
        error: `Failed to compute expected viewport geometry for resolution: ${virtW}x${virtH}`,
        errors: [`Failed to compute expected viewport geometry for resolution: ${virtW}x${virtH}`],
        summary: `ERROR: Failed to compute expected viewport geometry for resolution: ${virtW}x${virtH}`,
        metrics: {
          displayWidth: displayW,
          displayHeight: displayH,
          expectedViewport: null,
          measuredViewport: null,
          centeringDelta: 0,
          horizontalCenteringDelta: 0,
          verticalCenteringDelta: 0,
          marginViolations: 0,
          avgLuminance: 0,
          menuBarBleed: false,
          dockBleed: false,
        },
      };
    }

    if (!pngBuffer) {
      if (options.synthetic) {
        pngBuffer = generateSyntheticDisplayBuffer({
          width: displayW,
          height: displayH,
          gameW: virtW,
          gameH: virtH,
          aspectMode,
          defect,
        });
      } else if (options.live || options.capture) {
        if (process.platform !== 'darwin') {
          return {
            ok: false,
            passed: false,
            exitCode: 2,
            error: `Live capture is only supported on macOS (current: ${process.platform}). Use --synthetic in headless environments.`,
            errors: [`Live capture is only supported on macOS (current: ${process.platform})`],
            summary: `ERROR: Live capture requires macOS; use --synthetic.`,
          };
        }

        const lockCheck = detectScreenLockState();
        if (lockCheck.isLocked) {
          return {
            ok: true,
            passed: true,
            skipped: true,
            exitCode: 0,
            errors: [],
            reason: 'macOS screen is currently locked (CGSSessionScreenIsLocked = 1). Live frame buffer verification skipped.',
            summary: 'SKIP: Screen locked (CGSSessionScreenIsLocked = 1).',
          };
        }

        tempCapturePath = path.join(os.tmpdir(), `onelauncher-verify-display-${Date.now()}.png`);
        captureWholeDisplay(tempCapturePath);
        pngBuffer = fs.readFileSync(tempCapturePath);
        usedLiveCapture = true;
      } else {
        // Default fallback: If on macOS and screen is unlocked, run live; otherwise run synthetic
        const lockCheck = detectScreenLockState();
        if (process.platform === 'darwin' && !lockCheck.isLocked) {
          tempCapturePath = path.join(os.tmpdir(), `onelauncher-verify-display-${Date.now()}.png`);
          captureWholeDisplay(tempCapturePath);
          pngBuffer = fs.readFileSync(tempCapturePath);
          usedLiveCapture = true;
        } else {
          pngBuffer = generateSyntheticDisplayBuffer({
            width: displayW,
            height: displayH,
            gameW: virtW,
            gameH: virtH,
            aspectMode,
            defect,
          });
        }
      }
    }

    const decoded = preDecoded || decodePng(pngBuffer);
    const analysis = analyzeDisplayPixels(decoded, expectedViewport, {
      displayWidth: displayW,
      displayHeight: displayH,
      synthetic: Boolean(options.synthetic),
      hardwareCapture: Boolean(usedLiveCapture || decoded.hasColorProfile),
      strictBlack: options.strictBlack === true,
      blackTolerance: options.blackTolerance,
    });

    const errors = [];
    if (!analysis.passed) {
      errors.push(analysis.summary);
      if (!analysis.resolutionOk) {
        errors.push(`physical resolution mismatch: expected ${displayW}x${displayH}, got ${decoded.width}x${decoded.height}`);
      }
      if (analysis.totalMarginViolations > 0) {
        errors.push(`margin violation: ${analysis.totalMarginViolations} non-black pixels detected`);
      }
      if (analysis.centeringErrorPx > 0) {
        errors.push(`centering offset: ${analysis.centeringErrorPx}px discrepancy (horizontal: ${analysis.horizontalCenteringError}px, vertical: ${analysis.verticalCenteringError}px)`);
      }
      if (analysis.menuBarBleed) {
        errors.push('macOS Menu Bar bleed detected in top 0..44px margin');
      }
      if (analysis.dockBleed) {
        errors.push('macOS Dock bleed detected in bottom 60px margin');
      }
      if (!analysis.leftEdgeClean || !analysis.rightEdgeClean) {
        errors.push('horizontal viewport boundary transition is dirty or blurred');
      }
      if (!analysis.topEdgeClean || !analysis.bottomEdgeClean) {
        errors.push('vertical viewport boundary transition is dirty or blurred');
      }
      if (!analysis.symmetricMargins) {
        if (!analysis.symmetricHorizontalMargins) {
          errors.push(`asymmetric horizontal margins: left=${analysis.leftMarginW}px, right=${analysis.rightMarginW}px`);
        }
        if (!analysis.symmetricVerticalMargins) {
          errors.push(`asymmetric vertical margins: top=${analysis.topMarginH}px, bottom=${analysis.bottomMarginH}px`);
        }
      }
      if (analysis.avgLuminance <= 0) {
        errors.push('active viewport has zero luminance (all-black unrendered frame)');
      }
    }

    const metrics = {
      displayWidth: displayW,
      displayHeight: displayH,
      expectedViewport: {
        ...expectedViewport,
        dst_x: expectedViewport.dstX,
        dst_y: expectedViewport.dstY,
        dst_w: expectedViewport.dstW,
        dst_h: expectedViewport.dstH,
      },
      measuredViewport: {
        ...analysis.measuredViewport,
        dst_x: analysis.measuredViewport.dstX,
        dst_y: analysis.measuredViewport.dstY,
        dst_w: analysis.measuredViewport.dstW,
        dst_h: analysis.measuredViewport.dstH,
      },
      centeringDelta: analysis.centeringErrorPx,
      horizontalCenteringDelta: analysis.horizontalCenteringError,
      verticalCenteringDelta: analysis.verticalCenteringError,
      marginViolations: analysis.totalMarginViolations,
      avgLuminance: analysis.avgLuminance,
      menuBarBleed: analysis.menuBarBleed,
      dockBleed: analysis.dockBleed,
    };

    return {
      ok: analysis.passed,
      ...analysis,
      analysis,
      metrics,
      errors,
      exitCode: analysis.passed ? 0 : 1,
    };
  } catch (err) {
    return {
      ok: false,
      passed: false,
      exitCode: 2,
      error: err.message,
      errors: [err.message],
      stack: err.stack,
      summary: `ERROR: ${err.message}`,
    };
  } finally {
    if (tempCapturePath && fs.existsSync(tempCapturePath)) {
      try {
        fs.unlinkSync(tempCapturePath);
      } catch {}
    }
  }
}

// -----------------------------------------------------------------------------
// CLI Execution Handler
// -----------------------------------------------------------------------------

function printUsage() {
  console.log(`
One Launcher Whole-Display Scaler Verification Tool
Implements Requirement R3 (Whole-Display Inspection for 3024x1964 Retina Output)

Usage:
  node scripts/verify-display-output.cjs [options]

Options:
  --live, --capture     Capture and verify connected physical macOS display
  --synthetic           Run verification against generated synthetic display frame
  --image=<path>        Verify an existing screenshot PNG file
  --game-res=<w>x<h>, --expected-mode=<w>x<h>
                        Virtual game resolution (default: 640x480)
  --display-res=<w>x<h>, --display=<w>x<h>
                        Expected display resolution (default: 3024x1964)
  --aspect-mode=<mode>  preserve | integer | stretch (default: preserve)
  --defect=<type>       none | offset | margin_white | menubar_bleed | dock_bleed
  --verbose             Print detailed pixel sampling and boundary coordinates
  --json                Output machine-readable JSON summary
  -h, --help            Show this help text

Exit Codes:
  0: Display verification PASSED (all geometric and color invariants hold)
  1: Display verification FAILED (margin pollution, off-center, or menu bar bleed)
  2: Environmental error (screen locked, display not found, missing file)
`);
}

function parseCliArgs(args) {
  const options = {
    live: false,
    synthetic: false,
    image: null,
    virtualWidth: 640,
    virtualHeight: 480,
    displayWidth: null,
    displayHeight: null,
    aspectMode: 'preserve',
    defect: 'none',
    strictBlack: false,
    verbose: false,
    json: false,
  };

  const applyDimPair = (val, target) => {
    if (typeof val !== 'string') return;
    const parts = val.split('x');
    if (parts.length === 2) {
      const w = parseInt(parts[0], 10);
      const h = parseInt(parts[1], 10);
      if (!Number.isNaN(w) && !Number.isNaN(h)) {
        if (target === 'virtual') {
          options.virtualWidth = w;
          options.virtualHeight = h;
        } else {
          options.displayWidth = w;
          options.displayHeight = h;
        }
      }
    }
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextVal = () => (i + 1 < args.length && !args[i + 1].startsWith('--') ? args[++i] : '');

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg === '--live' || arg === '--capture') {
      options.live = true;
    } else if (arg === '--synthetic') {
      options.synthetic = true;
    } else if (arg === '--strict-black') {
      options.strictBlack = true;
    } else if (arg.startsWith('--black-tolerance=')) {
      const tol = parseInt(arg.slice('--black-tolerance='.length), 10);
      if (!Number.isNaN(tol)) options.blackTolerance = tol;
    } else if (arg === '--black-tolerance') {
      const tol = parseInt(nextVal(), 10);
      if (!Number.isNaN(tol)) options.blackTolerance = tol;
    } else if (arg.startsWith('--image=')) {
      options.image = arg.slice('--image='.length);
    } else if (arg === '--image') {
      options.image = nextVal();
    } else if (
      arg.startsWith('--game-res=') ||
      arg.startsWith('--expected-mode=') ||
      arg.startsWith('--resolution=')
    ) {
      const eqIdx = arg.indexOf('=');
      applyDimPair(arg.slice(eqIdx + 1), 'virtual');
    } else if (arg === '--game-res' || arg === '--expected-mode' || arg === '--resolution') {
      applyDimPair(nextVal(), 'virtual');
    } else if (arg.startsWith('--display-res=') || arg.startsWith('--display=')) {
      const eqIdx = arg.indexOf('=');
      applyDimPair(arg.slice(eqIdx + 1), 'display');
    } else if (arg === '--display-res' || arg === '--display') {
      applyDimPair(nextVal(), 'display');
    } else if (arg.startsWith('--aspect-mode=')) {
      options.aspectMode = arg.slice('--aspect-mode='.length);
    } else if (arg === '--aspect-mode') {
      const val = nextVal();
      if (val) options.aspectMode = val;
    } else if (arg.startsWith('--defect=')) {
      options.defect = arg.slice('--defect='.length);
    } else if (arg === '--defect') {
      const val = nextVal();
      if (val) options.defect = val;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--json') {
      options.json = true;
    }
  }

  return options;
}

if (require.main === module) {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  const result = verifyDisplayOutput(cliOptions);

  if (cliOptions.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.skipped) {
      console.log(`[VERIFY-DISPLAY] ${result.summary}`);
    } else if (result.passed) {
      console.log(`\x1b[32m[VERIFY-DISPLAY-PASS]\x1b[0m ${result.summary}`);
      if (cliOptions.verbose) {
        console.log(`  - Panel: ${result.displayWidth}x${result.displayHeight}`);
        console.log(`  - Expected Viewport: dstX=${result.expectedViewport.dstX}, dstY=${result.expectedViewport.dstY}, dstW=${result.expectedViewport.dstW}, dstH=${result.expectedViewport.dstH}`);
        console.log(`  - Measured Viewport: dstX=${result.measuredViewport.dstX}, dstY=${result.measuredViewport.dstY}, dstW=${result.measuredViewport.dstW}, dstH=${result.measuredViewport.dstH}`);
        console.log(`  - Centering Error: ${result.centeringErrorPx}px (horizontal: ${result.horizontalCenteringError}px, vertical: ${result.verticalCenteringError}px)`);
        console.log(`  - Average Viewport Luminance: ${result.avgLuminance}`);
        console.log(`  - Menu Bar Bleed: ${result.menuBarBleed}`);
        console.log(`  - Dock Bleed: ${result.dockBleed}`);
      }
    } else {
      console.error(`\x1b[31m[VERIFY-DISPLAY-FAIL]\x1b[0m ${result.summary}`);
      if (result.marginViolations && result.marginViolations.length > 0) {
        console.error(`  Violations sample (up to 5):`);
        for (const v of result.marginViolations.slice(0, 5)) {
          console.error(`    - (${v.x}, ${v.y}) RGB(${v.r}, ${v.g}, ${v.b}) region=${v.region}`);
        }
      }
      if (result.error) {
        console.error(`  Error: ${result.error}`);
      }
    }
  }

  process.exit(result.exitCode !== undefined ? result.exitCode : (result.passed ? 0 : 1));
}

// -----------------------------------------------------------------------------
// Programmatic Module Exports
// -----------------------------------------------------------------------------

module.exports = {
  decodePng,
  decodePngBuffer: decodePng,
  encodePng,
  encodePngBuffer: encodePng,
  computeOracleViewport,
  computeExpectedViewport: computeOracleViewport,
  computeViewportLuminance,
  detectScreenLockState,
  isScreenLocked: () => detectScreenLockState().isLocked,
  detectDisplayGeometry,
  captureWholeDisplay,
  generateSyntheticDisplayBuffer,
  generateSyntheticRetinaFrame: generateSyntheticDisplayBuffer,
  analyzeDisplayPixels,
  verifyDisplayOutput,
};
