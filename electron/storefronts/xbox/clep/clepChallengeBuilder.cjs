// @ts-check
'use strict';

/**
 * CLEP Hardware Attestation Challenge Builder & XML Entity Helpers (`clepChallengeBuilder.cjs`):
 * - Synthetic SMBIOS Type 1 + Disk Serial hardware table synthesis
 * - `ClepV2` / `ClepV4` `<ClepRequest>` challenge construction
 * - Virtual Windows device credential generation & `DeviceAddRequest` XML assembly
 * - Safe XML escaping & single-pass entity decoding (with Unicode codepoint bounds)
 */

const crypto = require('node:crypto');
const os = require('node:os');
const { clepObfuscate } = require('./clepCryptoPrimitives.cjs');

/**
 * @param {string} str
 * @returns {string}
 */
function escapeXmlText(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;');
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeXmlAttr(str) {
  return escapeXmlText(str)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;');
}

/**
 * Single-pass XML entity decoder with strict Unicode scalar value bounds (`<= 0x10FFFF`, non-surrogate).
 *
 * @param {string} str
 * @returns {string}
 */
function decodeXmlEntities(str) {
  const raw = String(str ?? '');
  if (!raw.includes('&')) return raw;
  return raw.replace(
    /&(lt|gt|quot|apos|amp|#x([0-9a-fA-F]{1,8})|#(\d{1,10}));/g,
    (full, ent, hexCp, decCp) => {
      if (ent === 'lt') return '<';
      if (ent === 'gt') return '>';
      if (ent === 'quot') return '"';
      if (ent === 'apos') return "'";
      if (ent === 'amp') return '&';
      if (hexCp !== undefined || decCp !== undefined) {
        const cp = hexCp !== undefined ? parseInt(hexCp, 16) : parseInt(decCp, 10);
        if (
          Number.isInteger(cp) &&
          cp >= 0x01 &&
          cp <= 0x10ffff &&
          !(cp >= 0xd800 && cp <= 0xdfff)
        ) {
          return String.fromCodePoint(cp);
        }
        return full;
      }
      return full;
    }
  );
}

/**
 * Synthesizes deterministic 256-byte SMBIOS Type 1/2/3 tables + 64-byte Disk Serial
 * from a host hardware seed so device identity remains stable per machine without
 * requiring admin/IOKit/WMI privileges.
 *
 * @param {string | Buffer} [hardwareSeed]
 * @returns {{ smbios: Buffer, diskSerial: Buffer }}
 */
function buildSyntheticHardwareTables(hardwareSeed) {
  const seed = String(
    hardwareSeed || `${os.platform()}|${os.arch()}|${os.hostname()}|one-launcher-xbox-v1`
  );
  const hashA = crypto.createHash('sha256').update(`smbios:${seed}`).digest();
  const hashB = crypto.createHash('sha256').update(`disk:${seed}`).digest();

  const smbios = Buffer.alloc(256, 0);
  // Minimal valid SMBIOS System Information (Type 1, length 0x1b, handle 0x0001)
  smbios[0] = 0x01;
  smbios[1] = 0x1b;
  smbios.writeUInt16LE(0x0001, 2);
  smbios[4] = 0x01; // Manufacturer string #1
  smbios[5] = 0x02; // Product Name string #2
  smbios[6] = 0x03; // Version string #3
  smbios[7] = 0x04; // Serial Number string #4
  hashA.subarray(0, 16).copy(smbios, 8); // 16-byte System UUID
  smbios[24] = 0x06; // Wake-up Type: Power Switch
  smbios[25] = 0x05; // SKU Number string #5
  smbios[26] = 0x06; // Family string #6
  const serialHex = hashA.subarray(16, 24).toString('hex').toUpperCase();
  const strings = [
    'System Manufacturer',
    'System Product Name',
    '1.0',
    `OL-${serialHex}`,
    'SKU-PC',
    'Desktop',
  ];
  let strOff = 0x1b;
  for (const s of strings) {
    const bytes = Buffer.from(s, 'ascii');
    if (strOff + bytes.length + 2 >= 254) break;
    bytes.copy(smbios, strOff);
    strOff += bytes.length + 1;
  }
  smbios[strOff] = 0x00; // Double-NUL structure terminator

  const diskSerial = Buffer.alloc(64, 0);
  const diskStr = `NVME-${hashB.subarray(0, 10).toString('hex').toUpperCase()}`;
  Buffer.from(diskStr, 'ascii').copy(diskSerial, 0);

  return { smbios, diskSerial };
}

/**
 * Builds ClepV2 and ClepV4 structures, obfuscates both, and formats the Base64-encoded
 * `<ClepRequest><V2>...</V2><V4>...</V4></ClepRequest>` clientChallenge expected by
 * `deviceaddcredential.srf` and `licensing.mp.microsoft.com/v7.0/licenses/*`.
 *
 * @param {{ smbios?: Buffer, diskSerial?: Buffer, hardwareSeed?: string | Buffer }} [options]
 */
function buildClepChallengeBuffers(options = {}) {
  const synth =
    Buffer.isBuffer(options.smbios) &&
    options.smbios.length === 256 &&
    Buffer.isBuffer(options.diskSerial) &&
    options.diskSerial.length === 64
      ? { smbios: options.smbios, diskSerial: options.diskSerial }
      : buildSyntheticHardwareTables(options.hardwareSeed);

  // ClepV2 (2048 bytes packed)
  const clepV2Raw = Buffer.alloc(2048, 0);
  clepV2Raw.writeUInt32LE(2, 0); // version = 2
  synth.smbios.copy(clepV2Raw, 4); // 4..260
  synth.diskSerial.copy(clepV2Raw, 260); // 260..324
  clepV2Raw.writeUInt32LE(0, 324); // always_0 = 0
  clepV2Raw.writeUInt8(1, 328); // always_1 = true

  // ClepV4 (2048 bytes packed)
  const clepV4Raw = Buffer.alloc(2048, 0);
  clepV4Raw.writeUInt32LE(4, 0); // version = 4
  synth.smbios.copy(clepV4Raw, 4); // 4..260
  synth.diskSerial.copy(clepV4Raw, 260); // 260..324
  clepV4Raw.writeUInt32LE(1, 1231); // debugger_not_present = 1

  const clepV2 = clepObfuscate(clepV2Raw);
  const clepV4 = clepObfuscate(clepV4Raw);
  const clepV2B64 = clepV2.toString('base64');
  const clepV4B64 = clepV4.toString('base64');
  const xml = `<ClepRequest><V2>${clepV2B64}</V2><V4>${clepV4B64}</V4></ClepRequest>`;
  const clientChallenge = Buffer.from(xml, 'utf8').toString('base64');

  return {
    clepV2,
    clepV4,
    clepV2B64,
    clepV4B64,
    xml,
    clientChallenge,
  };
}

/**
 * @param {{ smbios?: Buffer, diskSerial?: Buffer, hardwareSeed?: string | Buffer }} [options]
 * @returns {string}
 */
function getLicenseChallenge(options = {}) {
  return buildClepChallengeBuffers(options).clientChallenge;
}

/**
 * @returns {string}
 */
function generateNumericDeviceMembername() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.randomBytes(14);
  let out = '02';
  for (let i = 0; i < 14; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/**
 * @returns {string}
 */
function generateDevicePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^*_-+=';
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/**
 * @param {{ membername: string, password: string, clepV2B64: string, clepV4B64: string }} params
 * @returns {string}
 */
function buildDeviceAddCredentialXml({ membername, password, clepV2B64, clepV4B64 }) {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<DeviceAddRequest>` +
    `<ClientInfo name="IDCRL" version="1.0"><BinaryVersion>55</BinaryVersion></ClientInfo>` +
    `<Authentication>` +
    `<Membername>${escapeXmlText(membername)}</Membername>` +
    `<Password>${escapeXmlText(password)}</Password>` +
    `</Authentication>` +
    `<DeviceInfo Id="DeviceInfo">` +
    `<Component name="4113">AA==</Component>` +
    `<Component name="4101" error="-2147024894"/>` +
    `<Component name="8196">${escapeXmlText(clepV2B64)}</Component>` +
    `<Component name="8197">${escapeXmlText(clepV4B64)}</Component>` +
    `<Component name="4102" error="-2147024894"/>` +
    `<Component name="4103" error="-2147024894"/>` +
    `<Component name="4104" error="-2147024894"/>` +
    `<Component name="4145">AQAAAA==</Component>` +
    `<Component name="4160" error="-2147024894"/>` +
    `<Component name="4161" error="-2147024894"/>` +
    `</DeviceInfo>` +
    `</DeviceAddRequest>`
  );
}

module.exports = {
  escapeXmlText,
  escapeXmlAttr,
  decodeXmlEntities,
  buildSyntheticHardwareTables,
  buildClepChallengeBuffers,
  getLicenseChallenge,
  generateNumericDeviceMembername,
  generateDevicePassword,
  buildDeviceAddCredentialXml,
};
