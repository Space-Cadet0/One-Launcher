// @ts-check
'use strict';

/**
 * `RST2.srf` SOAP Client & WS-Security Exclusive XML-C14N Signing/Decryption (`rst2SoapClient.cjs`):
 * - Builds W3C Exclusive C14N signed `RST2.srf` envelopes (RSA-SHA256 & SP800-108 HMAC-SHA256)
 * - Decrypts `<psf:EncryptedPP>` and `<s:Body>` `<EncryptedData>` elements independently
 * - Parses `<RequestSecurityTokenResponse>` blocks and exchanges user LegacyTokens on `RST2.srf`
 * - Provides fetch timeout signals, caller-isolated abort racing, and PII-redacted fault extraction
 */

const crypto = require('node:crypto');
const { XBOX_HTTP_TIMEOUT_MS, buildXboxFetchSignal } = require('../xboxConfigAndIds.cjs');
const {
  HOSTING_APP_DEFAULT_IDCRL,
  HOSTING_APP_MS_STORE,
  getCachedRsaPrivateKeyObject,
  deriveDoubleDerivedHmacKey,
} = require('./clepCryptoPrimitives.cjs');
const {
  escapeXmlText,
  escapeXmlAttr,
  decodeXmlEntities,
} = require('./clepChallengeBuilder.cjs');

const MSA_DEVICE_ADD_URL = 'https://login.live.com/ppsecure/deviceaddcredential.srf';
const MSA_RST2_URL = 'https://login.live.com/RST2.srf';
const MSA_WINDOWS_USER_AGENT =
  'MSAWindows/55 (OS 10.0.26100.0.0 ge_release; IDK 10.0.26100.5074 ge_release; Cfg 16.000.29325.00; Test 0)';

const DEFAULT_CLEP_HTTP_TIMEOUT_MS = XBOX_HTTP_TIMEOUT_MS;

/**
 * @param {AbortSignal | undefined} outerSignal
 * @param {number} [timeoutMs]
 */
function createClepFetchSignal(outerSignal, timeoutMs = DEFAULT_CLEP_HTTP_TIMEOUT_MS) {
  return buildXboxFetchSignal(outerSignal, timeoutMs);
}

/**
 * @template T
 * @param {Promise<T>} sharedPromise
 * @param {AbortSignal | undefined} callerSignal
 * @returns {Promise<T>}
 */
function raceClepPromiseWithCallerSignal(sharedPromise, callerSignal) {
  if (!callerSignal) return sharedPromise;
  if (callerSignal.aborted) {
    const err =
      callerSignal.reason instanceof Error
        ? callerSignal.reason
        : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const err =
        callerSignal.reason instanceof Error
          ? callerSignal.reason
          : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      reject(err);
    };
    callerSignal.addEventListener('abort', onAbort, { once: true });
    sharedPromise.then(
      (val) => {
        callerSignal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        callerSignal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/**
 * @param {string} rawMsg
 * @param {number} [maxLen]
 * @returns {string}
 */
function scrubPiiFromErrorText(rawMsg, maxLen = 140) {
  const cleaned = String(rawMsg || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]')
    .replace(/\b(?:[td]|XBL3\.0\s+x)=[^\s,;)"']+/gi, '[redacted-token]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*){1,4}\b/g, '[redacted-jwt]')
    .replace(/\b(?:puid|xuid|membername|cid|ANID)\s*[:=]\s*[^\s,;)"']+/gi, '[redacted-id]')
    .replace(/\b[0-9A-Fa-f]{16,}\b/g, '[redacted-hex]')
    .replace(/\b\d{12,}\b/g, '[redacted-num]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, maxLen);
}

/**
 * @param {string} xml
 * @param {string} localTagName
 * @returns {string}
 */
function extractXmlTagText(xml, localTagName) {
  const safeTag = String(localTagName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!safeTag) return '';
  const re = new RegExp(
    `<(?:[\\w-]+:)?${safeTag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${safeTag}>`,
    'i'
  );
  const m = String(xml || '').match(re);
  return m && m[1] ? decodeXmlEntities(m[1].trim()) : '';
}

/**
 * @param {string} rawXml
 * @returns {string}
 */
function extractSafeSoapFaultSuffix(rawXml) {
  const str = String(rawXml || '');
  if (!str) return '';
  const code =
    extractXmlTagText(str, 'reqstatus') ||
    extractXmlTagText(str, 'code') ||
    extractXmlTagText(str, 'Value');
  if (!code) return '';
  const safeCode = code.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
  return safeCode ? `, code=${safeCode}` : '';
}

/**
 * Builds an Exclusive XML-C14N (`http://www.w3.org/2001/10/xml-exc-c14n#`) signed `RST2.srf` SOAP
 * envelope where `#RST0` (or `#RSTS`), `#Timestamp`, `#PPAuthInfo`, and `<SignedInfo>` are emitted
 * directly in exact W3C Exclusive Canonical Form so their SHA-256 digests and XML-DSig signature
 * verify cleanly against `https://login.live.com:443/RST2.srf`.
 *
 * @param {Record<string, any>} params
 * @returns {string}
 */
function buildSignedRst2SoapEnvelope({
  authBlockXml = '',
  hostingApp = HOSTING_APP_DEFAULT_IDCRL,
  ssoFlags = '',
  inlineUx = 'TokenBroker',
  inlineFt = '',
  licenseSignatureKeyVersion = '2',
  scopeAddress,
  policy,
  scopes,
  signingMode, // 'rsa' | 'hmac'
  rsaPrivateKeyPem,
  clepHmacSecret,
  tpmSecret,
  derivedKeyRefUri = '',
  legacyTokenIdRef,
  nowMs = Date.now(),
}) {
  const nowSec = Math.floor(nowMs / 1000);
  const createdIso = new Date(nowSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expiresIso = new Date((nowSec + 300) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Canonical `#Timestamp` (Exclusive C14N: xmlns:wsu declared on wsu:Timestamp)
  const canonicalTimestamp =
    `<wsu:Timestamp xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" wsu:Id="Timestamp">` +
    `<wsu:Created>${createdIso}</wsu:Created>` +
    `<wsu:Expires>${expiresIso}</wsu:Expires>` +
    `</wsu:Timestamp>`;

  // Canonical `#PPAuthInfo` (Exclusive C14N: xmlns:ps declared on ps:AuthInfo)
  const licSigVerXml =
    licenseSignatureKeyVersion !== null &&
    licenseSignatureKeyVersion !== undefined &&
    licenseSignatureKeyVersion !== ''
      ? `<ps:LicenseSignatureKeyVersion>${escapeXmlText(licenseSignatureKeyVersion)}</ps:LicenseSignatureKeyVersion>`
      : '';
  const inlineFtXml = inlineFt ? `<ps:InlineFT>${escapeXmlText(inlineFt)}</ps:InlineFT>` : '';

  const canonicalAuthInfo =
    `<ps:AuthInfo xmlns:ps="http://schemas.microsoft.com/Passport/SoapServices/PPCRL" Id="PPAuthInfo">` +
    `<ps:SSOFlags>${escapeXmlText(ssoFlags)}</ps:SSOFlags>` +
    `<ps:HostingApp>${escapeXmlText(hostingApp)}</ps:HostingApp>` +
    `<ps:BinaryVersion>55</ps:BinaryVersion>` +
    `<ps:UIVersion>1</ps:UIVersion>` +
    `<ps:InlineUX>${escapeXmlText(inlineUx)}</ps:InlineUX>` +
    `<ps:IsAdmin>1</ps:IsAdmin>` +
    `<ps:Cookies></ps:Cookies>` +
    `<ps:RequestParams>AQAAAAIAAABsYwQAAAAxMDMz</ps:RequestParams>` +
    `<ps:WindowsClientString>b4d/QB7Zy5pjUAY9ByQ1echTyTITx6ZCErOEztuIVtw=</ps:WindowsClientString>` +
    licSigVerXml +
    `<ps:ClientCapabilities>1</ps:ClientCapabilities>` +
    inlineFtXml +
    `</ps:AuthInfo>`;

  const normalizedScopes =
    Array.isArray(scopes) && scopes.length > 0
      ? scopes
      : [{ scopeAddress: scopeAddress || 'http://Passport.NET/tb', policy: policy || '' }];

  const buildSingleRst = (/** @type {{ scopeAddress: string, policy?: string }} */ item, /** @type {number} */ idx) => {
    const polXml = item.policy
      ? `<wsp:PolicyReference xmlns:wsp="http://schemas.xmlsoap.org/ws/2004/09/policy" URI="${escapeXmlAttr(item.policy)}"></wsp:PolicyReference>`
      : '';
    return (
      `<wst:RequestSecurityToken xmlns:wst="http://schemas.xmlsoap.org/ws/2005/02/trust" Id="RST${idx}">` +
      `<wst:RequestType>http://schemas.xmlsoap.org/ws/2005/02/trust/Issue</wst:RequestType>` +
      `<wsp:AppliesTo xmlns:wsp="http://schemas.xmlsoap.org/ws/2004/09/policy">` +
      `<wsa:EndpointReference xmlns:wsa="http://www.w3.org/2005/08/addressing">` +
      `<wsa:Address>${escapeXmlText(item.scopeAddress)}</wsa:Address>` +
      `</wsa:EndpointReference>` +
      `</wsp:AppliesTo>` +
      polXml +
      `</wst:RequestSecurityToken>`
    );
  };

  const isMultiScope = normalizedScopes.length > 1;
  const canonicalBodyTarget = isMultiScope
    ? `<ps:RequestMultipleSecurityTokens xmlns:ps="http://schemas.microsoft.com/Passport/SoapServices/PPCRL" Id="RSTS">` +
      normalizedScopes.map((s, idx) => buildSingleRst(s, idx)).join('') +
      `</ps:RequestMultipleSecurityTokens>`
    : buildSingleRst(normalizedScopes[0], 0);
  const bodyRefUri = isMultiScope ? '#RSTS' : '#RST0';

  const digestBody = crypto.createHash('sha256').update(canonicalBodyTarget, 'utf8').digest('base64');
  const digestTs = crypto.createHash('sha256').update(canonicalTimestamp, 'utf8').digest('base64');
  const digestAuthInfo = crypto.createHash('sha256').update(canonicalAuthInfo, 'utf8').digest('base64');

  const sigAlg =
    signingMode === 'rsa'
      ? 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
      : 'http://www.w3.org/2001/04/xmldsig-more#hmac-sha256';

  const makeRef = (/** @type {string} */ uri, /** @type {string} */ digestB64) =>
    `<Reference URI="${uri}">` +
    `<Transforms><Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></Transform></Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></DigestMethod>` +
    `<DigestValue>${digestB64}</DigestValue>` +
    `</Reference>`;

  const canonicalSignedInfo =
    `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="${sigAlg}"></SignatureMethod>` +
    makeRef(bodyRefUri, digestBody) +
    makeRef('#Timestamp', digestTs) +
    makeRef('#PPAuthInfo', digestAuthInfo) +
    `</SignedInfo>`;

  let signatureValueB64 = '';
  let derivedKeyTokenXml = '';
  let keyInfoXml = '';

  if (signingMode === 'rsa') {
    const rsaKeyObj = getCachedRsaPrivateKeyObject(rsaPrivateKeyPem);
    signatureValueB64 = crypto
      .sign('RSA-SHA256', Buffer.from(canonicalSignedInfo, 'utf8'), rsaKeyObj)
      .toString('base64');
  } else {
    const nonce = crypto.randomBytes(32);
    const hmacKey = deriveDoubleDerivedHmacKey(clepHmacSecret, nonce, tpmSecret);
    signatureValueB64 = crypto
      .createHmac('sha256', hmacKey)
      .update(canonicalSignedInfo, 'utf8')
      .digest('base64');

    const resolvedRefUri =
      derivedKeyRefUri !== undefined
        ? String(derivedKeyRefUri)
        : legacyTokenIdRef
          ? String(legacyTokenIdRef)
          : '';

    derivedKeyTokenXml =
      `<wssc:DerivedKeyToken wsu:Id="SignKey" Algorithm="urn:liveid:SP800108_CTR_HMAC_SHA256_DOUBLEDERIVED">` +
      `<wsse:RequestedTokenReference>` +
      `<wsse:KeyIdentifier ValueType="http://docs.oasis-open.org/wss/2004/XX/oasis-2004XX-wss-saml-token-profile-1.0#SAMLAssertionID"></wsse:KeyIdentifier>` +
      `<wsse:Reference URI="${escapeXmlAttr(resolvedRefUri)}"></wsse:Reference>` +
      `</wsse:RequestedTokenReference>` +
      `<wssc:Nonce>${nonce.toString('base64')}</wssc:Nonce>` +
      `</wssc:DerivedKeyToken>`;

    keyInfoXml =
      `<KeyInfo>` +
      `<wsse:SecurityTokenReference>` +
      `<wsse:Reference URI="#SignKey"></wsse:Reference>` +
      `</wsse:SecurityTokenReference>` +
      `</KeyInfo>`;
  }

  const signatureXml =
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    canonicalSignedInfo +
    `<SignatureValue>${signatureValueB64}</SignatureValue>` +
    keyInfoXml +
    `</Signature>`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:ps="http://schemas.microsoft.com/Passport/SoapServices/PPCRL" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:saml="urn:oasis:names:tc:SAML:1.0:assertion" xmlns:wsp="http://schemas.xmlsoap.org/ws/2004/09/policy" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns:wsa="http://www.w3.org/2005/08/addressing" xmlns:wssc="http://schemas.xmlsoap.org/ws/2005/02/sc" xmlns:wst="http://schemas.xmlsoap.org/ws/2005/02/trust">` +
    `<s:Header>` +
    `<wsa:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/02/trust/RST/Issue</wsa:Action>` +
    `<wsa:To s:mustUnderstand="1">https://login.live.com:443/RST2.srf</wsa:To>` +
    `<wsa:MessageID>${nowSec}</wsa:MessageID>` +
    canonicalAuthInfo +
    `<wsse:Security>` +
    authBlockXml +
    derivedKeyTokenXml +
    canonicalTimestamp +
    signatureXml +
    `</wsse:Security>` +
    `</s:Header>` +
    `<s:Body>` +
    canonicalBodyTarget +
    `</s:Body>` +
    `</s:Envelope>`
  );
}

/**
 * @param {string} soapXml
 * @returns {Map<string, string>}
 */
function extractDerivedKeyNoncesMap(soapXml) {
  /** @type {Map<string, string>} */
  const nonces = new Map();
  const dktRegex = /<(?:[\w-]+:)?DerivedKeyToken\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?DerivedKeyToken>/gi;
  let m;
  while ((m = dktRegex.exec(String(soapXml || ''))) !== null) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    const idMatch = attrs.match(/\b(?:[\w-]+:)?Id="([^"]+)"/i);
    const nonceMatch = inner.match(/<(?:[\w-]+:)?Nonce[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Nonce>/i);
    if (idMatch && nonceMatch) {
      nonces.set(idMatch[1].trim(), nonceMatch[1].replace(/\s+/g, ''));
    }
  }
  return nonces;
}

/**
 * @param {string} encDataXml
 * @param {Map<string, string>} nonces
 * @param {Buffer} clepHmacSecret
 * @returns {string | null}
 */
function decryptSingleEncryptedDataElement(encDataXml, nonces, clepHmacSecret) {
  if (!encDataXml || !Buffer.isBuffer(clepHmacSecret)) return null;
  const cipherMatch = encDataXml.match(/<(?:[\w-]+:)?CipherValue[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?CipherValue>/i);
  if (!cipherMatch || !cipherMatch[1]) return null;

  const refMatch = encDataXml.match(/<(?:[\w-]+:)?Reference\b[^>]*\bURI="#?([^"]+)"/i);
  const targetId = refMatch ? refMatch[1].trim() : Array.from(nonces.keys())[0];
  const nonceB64 = targetId ? nonces.get(targetId) : null;
  if (!nonceB64) return null;

  const nonceBuf = Buffer.from(nonceB64, 'base64');
  const aesKey32 = deriveDoubleDerivedHmacKey(clepHmacSecret, nonceBuf);
  const cipherPayload = Buffer.from(cipherMatch[1].replace(/\s+/g, ''), 'base64');
  if (cipherPayload.length <= 16 || cipherPayload.length % 16 !== 0) {
    throw new Error('Invalid EncryptedData CipherValue length');
  }

  const iv = cipherPayload.subarray(0, 16);
  const encrypted = cipherPayload.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey32, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Decrypts both `<psf:EncryptedPP>` (in `<s:Header>`) and `<EncryptedData>` (in `<s:Body>`)
 * independently so header `<psf:EncryptedPP>` never shadows the `<s:Body>` token payload.
 *
 * @param {string} soapXml
 * @param {Buffer} clepHmacSecret
 * @returns {{ decryptedPpXml: string | null, decryptedBodyXml: string | null, rawBodyXml: string }}
 */
function decryptRst2SoapEnvelope(soapXml, clepHmacSecret) {
  const xml = String(soapXml || '');
  const nonces = extractDerivedKeyNoncesMap(xml);

  let decryptedPpXml = null;
  const encPpMatch = xml.match(/<(?:[\w-]+:)?EncryptedPP\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?EncryptedPP>/i);
  if (encPpMatch && encPpMatch[1]) {
    const ppEncData = encPpMatch[1].match(/<(?:[\w-]+:)?EncryptedData\b[\s\S]*?<\/(?:[\w-]+:)?EncryptedData>/i);
    if (ppEncData) {
      try {
        decryptedPpXml = decryptSingleEncryptedDataElement(ppEncData[0], nonces, clepHmacSecret);
      } catch {}
    }
  }

  const bodyMatch = xml.match(/<(?:[\w-]+:)?Body\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Body>/i);
  const rawBodyXml = bodyMatch ? bodyMatch[1] : xml;
  let decryptedBodyXml = null;

  const bodyWithoutPp = bodyMatch
    ? rawBodyXml
    : xml.replace(/<(?:[\w-]+:)?EncryptedPP\b[\s\S]*?<\/(?:[\w-]+:)?EncryptedPP>/gi, '');
  const bodyEncData = bodyWithoutPp.match(
    /<(?:[\w-]+:)?EncryptedData\b[\s\S]*?<\/(?:[\w-]+:)?EncryptedData>/i
  );
  if (bodyEncData) {
    decryptedBodyXml = decryptSingleEncryptedDataElement(bodyEncData[0], nonces, clepHmacSecret);
  }

  return {
    decryptedPpXml,
    decryptedBodyXml,
    rawBodyXml,
  };
}

/**
 * Decrypts a WS-Security `<EncryptedData>` `<CipherValue>` (`iv[16] || AES-256-CBC-PKCS7(plaintext)`)
 * using the `DerivedKeyToken` `<Nonce>` and `clepHmacSecret`, prioritizing `<s:Body>` over `<psf:EncryptedPP>`.
 *
 * @param {string} soapXml
 * @param {Buffer} clepHmacSecret
 * @returns {string | null}
 */
function decryptRst2EncryptedDataXml(soapXml, clepHmacSecret) {
  const { decryptedBodyXml, decryptedPpXml } = decryptRst2SoapEnvelope(soapXml, clepHmacSecret);
  return decryptedBodyXml || decryptedPpXml || null;
}

/**
 * @param {string} xml
 * @returns {string}
 */
function extractCompactBinarySecurityToken(xml) {
  const bstMatch = String(xml || '').match(
    /<(?:[\w-]+:)?BinarySecurityToken\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?BinarySecurityToken>/i
  );
  if (!bstMatch || !bstMatch[1]) return '';
  return decodeXmlEntities(bstMatch[1].trim());
}

/**
 * Parses one or more `<RequestSecurityTokenResponse>` blocks from a decrypted `RST2.srf` `<s:Body>`.
 *
 * @param {string} bodyXml
 */
function parseRst2TokenResponses(bodyXml) {
  const tokens = [];
  const rstrRegex =
    /<(?:[\w-]+:)?RequestSecurityTokenResponse\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?RequestSecurityTokenResponse>/gi;
  let m;
  while ((m = rstrRegex.exec(String(bodyXml || ''))) !== null) {
    const block = m[1] || '';
    const tokenType = extractXmlTagText(block, 'TokenType');
    const scopeAddress = extractXmlTagText(block, 'Address');
    const created = extractXmlTagText(block, 'Created');
    const expires = extractXmlTagText(block, 'Expires');
    const binarySecretB64 = extractXmlTagText(block, 'BinarySecret');
    const rawCompact = extractCompactBinarySecurityToken(block);
    const encDataMatch = block.match(
      /<(?:[\w-]+:)?EncryptedData\b[\s\S]*?<\/(?:[\w-]+:)?EncryptedData>/i
    );
    const legacyTokenXml = encDataMatch ? encDataMatch[0] : '';
    const keyName = legacyTokenXml ? extractXmlTagText(legacyTokenXml, 'KeyName') : '';

    let compactToken = '';
    if (rawCompact) {
      compactToken = tokenType === 'urn:passport:delegationcompact' ? `d=${rawCompact}` : rawCompact;
    }

    tokens.push({
      scopeAddress,
      tokenType,
      compactToken,
      legacyTokenXml,
      binarySecretB64,
      keyName,
      created,
      expires,
    });
  }
  return tokens;
}

/**
 * Exchanges a user `LegacyToken` (`DAProperty.sDAToken` from `InlineLogin.srf` or saved
 * `http://Passport.NET/STS` `userStsLegacyTokenXml`) + virtual Windows `deviceLegacyTokenXml`
 * against `https://login.live.com/RST2.srf`.
 *
 * @param {{
 *   userLegacyTokenXml: string,
 *   username?: string,
 *   deviceLegacyTokenXml: string,
 *   clepHmacSecret: Buffer,
 *   inlineFt?: string,
 *   inlineUx?: string,
 *   hostingApp?: string,
 *   scopes?: Array<{ scopeAddress: string, policy: string }>,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 * }} params
 */
async function exchangeUserTokenOnRst2({
  userLegacyTokenXml,
  username,
  deviceLegacyTokenXml,
  clepHmacSecret,
  inlineFt = '',
  inlineUx = 'TokenBroker',
  hostingApp = HOSTING_APP_MS_STORE,
  scopes = [{ scopeAddress: 'www.microsoft.com', policy: 'mbi_ssl' }],
  fetchImpl = globalThis.fetch,
  signal,
}) {
  if (!userLegacyTokenXml || !deviceLegacyTokenXml || !Buffer.isBuffer(clepHmacSecret)) {
    throw new Error(
      'exchangeUserTokenOnRst2 requires userLegacyTokenXml, deviceLegacyTokenXml, and clepHmacSecret'
    );
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('exchangeUserTokenOnRst2 requires a fetch implementation');
  }

  const cleanUserTokenXml = String(userLegacyTokenXml).trim();
  const cleanDeviceTokenXml = String(deviceLegacyTokenXml).trim();

  const authBlockXml =
    `<wsse:UsernameToken wsu:Id="user">` +
    `<wsse:UsernameHint>${escapeXmlText(username || 'user@example.com')}</wsse:UsernameHint>` +
    `<wsse:LoginOption>1</wsse:LoginOption>` +
    `</wsse:UsernameToken>` +
    cleanUserTokenXml +
    `<wsse:BinarySecurityToken id="DeviceDAToken" ValueType="urn:liveid:device">` +
    escapeXmlText(cleanDeviceTokenXml) +
    `</wsse:BinarySecurityToken>`;

  const soapXml = buildSignedRst2SoapEnvelope({
    authBlockXml,
    hostingApp,
    ssoFlags: 'SsoRestr',
    inlineUx,
    inlineFt,
    licenseSignatureKeyVersion: null,
    scopes,
    signingMode: 'hmac',
    clepHmacSecret,
    derivedKeyRefUri: '#DeviceDAToken',
  });

  const res = await fetchImpl(MSA_RST2_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/soap+xml',
      'User-Agent': MSA_WINDOWS_USER_AGENT,
    },
    body: soapXml,
    signal: createClepFetchSignal(signal),
  });

  const respXml = await res.text();
  const { decryptedPpXml, decryptedBodyXml, rawBodyXml } = decryptRst2SoapEnvelope(
    respXml,
    clepHmacSecret
  );
  const effectiveBody = decryptedBodyXml || rawBodyXml;
  const effectivePp = decryptedPpXml || respXml;

  if (/<(?:[\w-]+:)?Fault\b/i.test(effectiveBody)) {
    return {
      fault: true,
      status: res.status,
      reqStatus: extractXmlTagText(effectivePp, 'reqstatus'),
      inlineAuthUrl: extractXmlTagText(effectivePp, 'inlineauthurl'),
      inlineEndAuthUrl: extractXmlTagText(effectivePp, 'inlineendauthurl'),
      faultReason: extractXmlTagText(effectiveBody, 'Text') || `RST2 Fault (${res.status})`,
      tokens: [],
    };
  }

  const tokens = parseRst2TokenResponses(effectiveBody);
  return {
    fault: false,
    status: res.status,
    reqStatus: extractXmlTagText(effectivePp, 'reqstatus'),
    inlineAuthUrl: '',
    tokens,
  };
}

module.exports = {
  MSA_DEVICE_ADD_URL,
  MSA_RST2_URL,
  MSA_WINDOWS_USER_AGENT,
  DEFAULT_CLEP_HTTP_TIMEOUT_MS,
  createClepFetchSignal,
  raceClepPromiseWithCallerSignal,
  scrubPiiFromErrorText,
  extractXmlTagText,
  extractSafeSoapFaultSuffix,
  buildSignedRst2SoapEnvelope,
  extractDerivedKeyNoncesMap,
  decryptSingleEncryptedDataElement,
  decryptRst2SoapEnvelope,
  decryptRst2EncryptedDataXml,
  extractCompactBinarySecurityToken,
  parseRst2TokenResponses,
  exchangeUserTokenOnRst2,
};
