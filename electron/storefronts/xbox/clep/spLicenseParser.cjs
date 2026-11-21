// @ts-check
'use strict';

/**
 * SPLicense Binary TLV & W3C XML-DSig Parser/Verifier (`spLicenseParser.cjs`):
 * - Decodes raw/Base64 `<License>` XML and extracts `<SPLicenseBlock>` payloads
 * - W3C Canonical XML 1.0 (Inclusive + Exclusive C14N) and RSA-SHA256 XML-DSig verification
 *   with optional SPKI SHA-256 pinning (`pinnedSpkiSha256Set`) forwarded from `parseSpLicenseBase64`
 * - Binary `<SPLicenseBlock>` TLV parsing (`0x0001` EncryptedDeviceKey, `0x012d` ClepSignState,
 *   `0x00ca` PackedContentKeys, `0x00cb` LicenseId, `0x00ce` PackageFullName, `0x0101` AES-CMAC,
 *   `0x00cc` server `SIGNATURE_BLOCK` with ECDSA P-256 verification when key material is provided)
 */

const crypto = require('node:crypto');
const {
  BLOCK_ID,
  deriveClepKeyFromSchedule,
  decryptCbcZeroIv,
  aes128Cmac,
  parseBcryptRsaPrivateKeyToPem,
  formatMixedEndianGuid,
} = require('./clepCryptoPrimitives.cjs');

/** @type {Record<string, any> | null} */
let boundFacade = null;

/**
 * @param {Record<string, any>} facade
 */
function bindFacade(facade) {
  boundFacade = facade;
}

/**
 * Decodes an outer XML string when `rawXmlOrBase64` is either raw XML (`<License ...>`)
 * or Base64-encoded XML (`<License ...>`), returning `null` for bare binary TLV Base64.
 *
 * @param {string} rawXmlOrBase64
 * @returns {string | null}
 */
function decodeSpLicenseXmlIfPresent(rawXmlOrBase64) {
  const str = String(rawXmlOrBase64 || '').trim();
  if (!str) return null;

  const strippedStr = str.replace(/^\uFEFF/, '').trimStart();
  if (strippedStr.startsWith('<') || /<(?:[\w-]+:)?SPLicenseBlock\b/i.test(strippedStr)) {
    return strippedStr;
  }

  try {
    const decoded = Buffer.from(str, 'base64');
    if (decoded.length > 0) {
      const headUtf8 = decoded
        .subarray(0, Math.min(decoded.length, 64))
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trimStart();
      if (headUtf8.startsWith('<')) {
        return decoded.toString('utf8').replace(/^\uFEFF/, '');
      }
    }
  } catch {}

  return null;
}

/**
 * Extracts all `<SPLicenseBlock>...</SPLicenseBlock>` Base64 payloads if wrapped in XML
 * (either raw XML or Base64-encoded `<License ...>` XML of arbitrary preamble length),
 * or returns `[trimmedBase64]` if already a bare binary `SPLicenseBlock` Base64 string.
 *
 * @param {string} rawXmlOrBase64
 * @returns {string[]}
 */
function extractAllSpLicenseBase64Blocks(rawXmlOrBase64) {
  const str = String(rawXmlOrBase64 || '').trim();
  if (!str) return [];

  const extractBlocksFromXml = (/** @type {string} */ xmlText) => {
    const matches = [];
    const re = /<(?:[\w-]+:)?SPLicenseBlock[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?SPLicenseBlock>/gi;
    let m;
    while ((m = re.exec(xmlText)) !== null) {
      const cleaned = String(m[1] || '').replace(/\s+/g, '');
      if (cleaned) matches.push(cleaned);
    }
    return matches;
  };

  const decodedXml = decodeSpLicenseXmlIfPresent(str);
  if (decodedXml !== null) {
    return extractBlocksFromXml(decodedXml);
  }

  return [str.replace(/\s+/g, '')];
}

/**
 * Extracts the primary `<SPLicenseBlock>...</SPLicenseBlock>` Base64 payload if wrapped in XML,
 * or returns raw Base64 string if already unwrapped.
 *
 * @param {string} rawXmlOrBase64
 * @returns {string}
 */
function extractSpLicenseBase64(rawXmlOrBase64) {
  const blocks = extractAllSpLicenseBase64Blocks(rawXmlOrBase64);
  return blocks[0] || '';
}

const XMLDSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';
const XML_EXC_C14N_NS = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const XMLDSIG_RSA_SHA256_URI = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const XMLENC_SHA256_URI = 'http://www.w3.org/2001/04/xmlenc#sha256';

/**
 * @typedef {{ type: 'text', value: string }} XmlC14nTextNode
 * @typedef {{ qname: string, prefix: string, localName: string, namespaceUri: string, value: string }} XmlC14nAttr
 * @typedef {{
 *   type: 'element',
 *   qname: string,
 *   prefix: string,
 *   localName: string,
 *   namespaceUri: string,
 *   nsScope: Map<string, string>,
 *   attrs: XmlC14nAttr[],
 *   children: Array<XmlC14nElementNode | XmlC14nTextNode>,
 *   parent: XmlC14nElementNode | null,
 * }} XmlC14nElementNode
 */

/**
 * @param {string} str
 * @param {boolean} [isAttribute]
 * @returns {string}
 */
function decodeXmlEntitiesForC14n(str, isAttribute = false) {
  let s = String(str ?? '');
  if (isAttribute) {
    // XML 1.0 §3.3.3: literal whitespace chars (\t, \n, \r) normalize to 0x20 before entity expansion
    s = s.replace(/[\t\n\r]/g, ' ');
  }
  return s.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-fA-F]+|#\d+);/g, (full, ent) => {
    if (ent === 'lt') return '<';
    if (ent === 'gt') return '>';
    if (ent === 'quot') return '"';
    if (ent === 'apos') return "'";
    if (ent === 'amp') return '&';
    if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const cp = parseInt(ent.slice(2), 16);
      return Number.isInteger(cp) && cp >= 0x01 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
        ? String.fromCodePoint(cp)
        : full;
    }
    if (ent.startsWith('#')) {
      const cp = parseInt(ent.slice(1), 10);
      return Number.isInteger(cp) && cp >= 0x01 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
        ? String.fromCodePoint(cp)
        : full;
    }
    return full;
  });
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeC14nText(str) {
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
function escapeC14nAttr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareCodepoints(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * @param {Buffer} buf
 * @returns {string}
 */
function toUnsignedBase64Url(buf) {
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0x00) {
    start += 1;
  }
  return buf.subarray(start).toString('base64url');
}

/**
 * Parses a well-formed XML document into an element/text tree with full namespace scope tracking
 * for W3C Canonical XML 1.0 (Inclusive & Exclusive).
 *
 * @param {string} rawXml
 * @returns {XmlC14nElementNode}
 */
function parseXmlDocumentForC14n(rawXml) {
  const xml = String(rawXml ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');

  let pos = 0;
  const len = xml.length;
  /** @type {XmlC14nElementNode[]} */
  const stack = [];
  /** @type {XmlC14nElementNode | null} */
  let root = null;

  const appendText = (/** @type {string} */ txt) => {
    if (!txt || stack.length === 0) return;
    stack[stack.length - 1].children.push({ type: 'text', value: txt });
  };

  while (pos < len) {
    const lt = xml.indexOf('<', pos);
    if (lt === -1) {
      appendText(decodeXmlEntitiesForC14n(xml.slice(pos), false));
      break;
    }
    if (lt > pos) {
      appendText(decodeXmlEntitiesForC14n(xml.slice(pos, lt), false));
    }

    if (xml.startsWith('<!--', lt)) {
      const endComment = xml.indexOf('-->', lt + 4);
      if (endComment === -1) throw new Error('Malformed XML comment');
      pos = endComment + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const endCdata = xml.indexOf(']]>', lt + 9);
      if (endCdata === -1) throw new Error('Malformed XML CDATA');
      appendText(xml.slice(lt + 9, endCdata));
      pos = endCdata + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const endPi = xml.indexOf('?>', lt + 2);
      if (endPi === -1) throw new Error('Malformed XML processing instruction');
      pos = endPi + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const endDecl = xml.indexOf('>', lt + 2);
      if (endDecl === -1) throw new Error('Malformed XML declaration');
      pos = endDecl + 1;
      continue;
    }

    if (xml[lt + 1] === '/') {
      const gt = xml.indexOf('>', lt + 2);
      if (gt === -1) throw new Error('Malformed XML closing tag');
      const closeQName = xml.slice(lt + 2, gt).trim();
      const top = stack.pop();
      if (!top || top.qname !== closeQName) {
        throw new Error('Mismatched XML closing tag');
      }
      pos = gt + 1;
      continue;
    }

    let cur = lt + 1;
    while (cur < len && !/[\s/>]/.test(xml[cur])) cur += 1;
    const qname = xml.slice(lt + 1, cur);
    if (!qname) throw new Error('Empty XML element name');

    /** @type {Array<{ prefix: string, uri: string }>} */
    const nsDecls = [];
    /** @type {Array<{ qname: string, value: string }>} */
    const rawAttrs = [];
    let selfClosing = false;

    while (cur < len) {
      while (cur < len && /\s/.test(xml[cur])) cur += 1;
      if (cur >= len) throw new Error('Unterminated XML start tag');
      if (xml[cur] === '>') {
        cur += 1;
        break;
      }
      if (xml[cur] === '/' && xml[cur + 1] === '>') {
        selfClosing = true;
        cur += 2;
        break;
      }

      const nameStart = cur;
      while (cur < len && !/[\s=/>]/.test(xml[cur])) cur += 1;
      const attrName = xml.slice(nameStart, cur);
      if (!attrName) throw new Error('Invalid XML attribute name');
      while (cur < len && /\s/.test(xml[cur])) cur += 1;
      if (xml[cur] !== '=') throw new Error('Missing "=" in XML attribute');
      cur += 1;
      while (cur < len && /\s/.test(xml[cur])) cur += 1;
      const quote = xml[cur];
      if (quote !== '"' && quote !== "'") throw new Error('Missing quote in XML attribute');
      cur += 1;
      const valStart = cur;
      const valEnd = xml.indexOf(quote, valStart);
      if (valEnd === -1) throw new Error('Unterminated XML attribute value');
      const attrVal = decodeXmlEntitiesForC14n(xml.slice(valStart, valEnd), true);
      cur = valEnd + 1;

      if (attrName === 'xmlns') {
        nsDecls.push({ prefix: '', uri: attrVal });
      } else if (attrName.startsWith('xmlns:')) {
        nsDecls.push({ prefix: attrName.slice(6), uri: attrVal });
      } else {
        rawAttrs.push({ qname: attrName, value: attrVal });
      }
    }

    const parentElem = stack.length > 0 ? stack[stack.length - 1] : null;
    const baseScope = parentElem
      ? parentElem.nsScope
      : new Map([
          ['', ''],
          ['xml', 'http://www.w3.org/XML/1998/namespace'],
        ]);
    const nsScope = new Map(baseScope);
    for (const d of nsDecls) {
      nsScope.set(d.prefix, d.uri);
    }

    const colonIdx = qname.indexOf(':');
    const prefix = colonIdx === -1 ? '' : qname.slice(0, colonIdx);
    const localName = colonIdx === -1 ? qname : qname.slice(colonIdx + 1);
    const namespaceUri = nsScope.get(prefix) ?? '';

    const attrs = rawAttrs.map((a) => {
      const cIdx = a.qname.indexOf(':');
      const aPrefix = cIdx === -1 ? '' : a.qname.slice(0, cIdx);
      const aLocal = cIdx === -1 ? a.qname : a.qname.slice(cIdx + 1);
      const aNs = aPrefix ? (nsScope.get(aPrefix) ?? '') : '';
      return {
        qname: a.qname,
        prefix: aPrefix,
        localName: aLocal,
        namespaceUri: aNs,
        value: a.value,
      };
    });

    /** @type {XmlC14nElementNode} */
    const elem = {
      type: 'element',
      qname,
      prefix,
      localName,
      namespaceUri,
      nsScope,
      attrs,
      children: [],
      parent: parentElem,
    };

    if (parentElem) {
      parentElem.children.push(elem);
    } else {
      if (root) throw new Error('Multiple XML root elements');
      root = elem;
    }

    if (!selfClosing) {
      stack.push(elem);
    }
    pos = cur;
  }

  if (stack.length > 0 || !root) {
    throw new Error('Malformed XML document');
  }
  return root;
}

/**
 * Serializes a parsed XML subtree in W3C Inclusive C14N 1.0 or Exclusive C14N 1.0 form.
 *
 * @param {XmlC14nElementNode | XmlC14nTextNode} node
 * @param {{
 *   exclusive?: boolean,
 *   inclusivePrefixes?: Set<string>,
 *   skipElement?: XmlC14nElementNode | null,
 * }} [options]
 * @param {Map<string, string>} [renderedNs]
 * @returns {string}
 */
function serializeC14nNode(
  node,
  options = {},
  renderedNs = new Map([
    ['', ''],
    ['xml', 'http://www.w3.org/XML/1998/namespace'],
  ])
) {
  if (node.type === 'text') {
    return escapeC14nText(node.value);
  }
  if (options.skipElement && node === options.skipElement) {
    return '';
  }

  const nextRenderedNs = new Map(renderedNs);
  /** @type {Array<{ prefix: string, uri: string }>} */
  const nsToEmit = [];

  if (!options.exclusive) {
    const sortedScope = Array.from(node.nsScope.entries()).sort((a, b) =>
      compareCodepoints(a[0], b[0])
    );
    for (const [pfx, uri] of sortedScope) {
      if (pfx === 'xml') continue;
      const prev = renderedNs.get(pfx) ?? '';
      if (pfx === '') {
        if (uri !== prev) {
          nsToEmit.push({ prefix: '', uri });
          nextRenderedNs.set('', uri);
        }
      } else if (uri !== '' && uri !== prev) {
        nsToEmit.push({ prefix: pfx, uri });
        nextRenderedNs.set(pfx, uri);
      }
    }
  } else {
    const utilizedPrefixes = new Set([node.prefix]);
    for (const a of node.attrs) {
      if (a.prefix && a.prefix !== 'xml') {
        utilizedPrefixes.add(a.prefix);
      }
    }
    if (options.inclusivePrefixes) {
      for (const p of options.inclusivePrefixes) {
        utilizedPrefixes.add(p === '#default' ? '' : p);
      }
    }
    const sortedPfx = Array.from(utilizedPrefixes).sort(compareCodepoints);
    for (const pfx of sortedPfx) {
      if (pfx === 'xml') continue;
      const uri = node.nsScope.get(pfx) ?? '';
      const prev = renderedNs.get(pfx) ?? '';
      if (pfx === '') {
        if (uri !== prev) {
          nsToEmit.push({ prefix: '', uri });
          nextRenderedNs.set('', uri);
        }
      } else if (uri !== '' && uri !== prev) {
        nsToEmit.push({ prefix: pfx, uri });
        nextRenderedNs.set(pfx, uri);
      }
    }
  }

  const sortedAttrs = node.attrs.slice().sort((a, b) => {
    const nsCmp = compareCodepoints(a.namespaceUri, b.namespaceUri);
    return nsCmp !== 0 ? nsCmp : compareCodepoints(a.localName, b.localName);
  });

  let out = `<${node.qname}`;
  for (const ns of nsToEmit) {
    if (ns.prefix === '') {
      out += ` xmlns="${escapeC14nAttr(ns.uri)}"`;
    } else {
      out += ` xmlns:${ns.prefix}="${escapeC14nAttr(ns.uri)}"`;
    }
  }
  for (const attr of sortedAttrs) {
    out += ` ${attr.qname}="${escapeC14nAttr(attr.value)}"`;
  }
  out += '>';
  for (const child of node.children) {
    out += serializeC14nNode(child, options, nextRenderedNs);
  }
  out += `</${node.qname}>`;
  return out;
}

/**
 * @param {XmlC14nElementNode} elem
 * @param {string} localName
 * @param {string} [nsUri]
 * @returns {XmlC14nElementNode | null}
 */
function findDirectChildElement(elem, localName, nsUri) {
  for (const c of elem.children) {
    if (c.type === 'element' && c.localName === localName && (!nsUri || c.namespaceUri === nsUri)) {
      return c;
    }
  }
  return null;
}

/**
 * @param {XmlC14nElementNode} elem
 * @param {string} localName
 * @param {string} [nsUri]
 * @returns {XmlC14nElementNode | null}
 */
function findDescendantElement(elem, localName, nsUri) {
  for (const c of elem.children) {
    if (c.type !== 'element') continue;
    if (c.localName === localName && (!nsUri || c.namespaceUri === nsUri)) {
      return c;
    }
    const nested = findDescendantElement(c, localName, nsUri);
    if (nested) return nested;
  }
  return null;
}

/**
 * @param {XmlC14nElementNode | null} elem
 * @returns {string}
 */
function collectElementText(elem) {
  if (!elem) return '';
  let out = '';
  for (const c of elem.children) {
    if (c.type === 'text') out += c.value;
    else out += collectElementText(c);
  }
  return out;
}

/**
 * @param {string} [message]
 * @returns {Error & { code: string }}
 */
function makeXmlDsigTamperedError(message = 'SPLicense XML-DSig verification failed') {
  return Object.assign(new Error(message), {
    code: 'SPLICENSE_SIGNATURE_TAMPERED',
  });
}

/**
 * Parses a caller-supplied ECDSA P-256 public key (PEM string, DER/PEM Buffer, JWK, or KeyObject)
 * for verifying `SIGNATURE_BLOCK` (`0x00cc`) server signatures.
 *
 * @param {string | Buffer | crypto.KeyObject | Record<string, any>} keyMaterial
 * @returns {crypto.KeyObject}
 */
function resolveServerSignaturePublicKey(keyMaterial) {
  if (typeof keyMaterial === 'string' || Buffer.isBuffer(keyMaterial)) {
    return crypto.createPublicKey(keyMaterial);
  }
  if (keyMaterial instanceof crypto.KeyObject) {
    return keyMaterial;
  }
  if (keyMaterial && typeof keyMaterial === 'object' && typeof keyMaterial.kty === 'string') {
    return crypto.createPublicKey({ key: /** @type {any} */ (keyMaterial), format: 'jwk' });
  }
  throw makeXmlDsigTamperedError('Invalid server SIGNATURE_BLOCK (0x00cc) verification key material');
}

/**
 * Cryptographically verifies a `SIGNATURE_BLOCK` (`0x00cc`) ECDSA P-256 SHA-256 IEEE P1363
 * signature over the preceding SPLicense bytes (`buf[0..signatureBlockOffset]`).
 *
 * @param {Buffer} signedSlice
 * @param {{ algorithmId: number, signatureOrigin: number, signature: Buffer }} signatureBlock
 * @param {string | Buffer | crypto.KeyObject | Record<string, any>} keyMaterial
 * @returns {boolean}
 */
function verifyServerSignatureBlock0x00cc(signedSlice, signatureBlock, keyMaterial) {
  if (!signatureBlock || signatureBlock.algorithmId !== 1 || signatureBlock.signature.length !== 64) {
    return false;
  }
  try {
    const pubKeyObj = resolveServerSignaturePublicKey(keyMaterial);
    return crypto.verify(
      'sha256',
      signedSlice,
      { key: pubKeyObj, dsaEncoding: 'ieee-p1363' },
      signatureBlock.signature
    );
  } catch {
    return false;
  }
}

/**
 * Verifies an enveloped W3C XML-DSig (`http://www.w3.org/2000/09/xmldsig#`) `RSA-SHA256` signature
 * and `SHA-256` `<DigestValue>` when present on a Microsoft Store `<License>` XML payload
 * (accepting either raw XML text or Base64-encoded `<License>` XML).
 *
 * Returns `true` when an XML-DSig signature is present and verified, `false` when no enveloped
 * XML-DSig `<Signature>` is present, and throws `SPLICENSE_SIGNATURE_TAMPERED` if either
 * `<DigestValue>` or `<SignatureValue>` fails verification, is malformed, or fails `pinnedSpkiSha256Set`.
 *
 * @param {string} xmlText
 * @param {{ pinnedSpkiSha256Set?: Set<string> | string[] }} [options]
 * @returns {boolean}
 */
function verifyLicenseXmlDsigIfPresent(xmlText, options = {}) {
  const decodedXml = decodeSpLicenseXmlIfPresent(xmlText);
  if (decodedXml === null) {
    return false;
  }
  if (!/<(?:[\w-]+:)?Signature\b/i.test(decodedXml)) {
    return false;
  }

  /** @type {XmlC14nElementNode} */
  let root;
  try {
    root = parseXmlDocumentForC14n(decodedXml);
  } catch {
    throw makeXmlDsigTamperedError();
  }

  const sigElem =
    findDirectChildElement(root, 'Signature', XMLDSIG_NS) ||
    findDescendantElement(root, 'Signature', XMLDSIG_NS);
  if (!sigElem || !sigElem.parent) {
    return false;
  }

  const signedInfoElem = findDirectChildElement(sigElem, 'SignedInfo', XMLDSIG_NS);
  const sigValElem = findDirectChildElement(sigElem, 'SignatureValue', XMLDSIG_NS);
  const rsaKeyValElem = findDescendantElement(sigElem, 'RSAKeyValue', XMLDSIG_NS);
  const modulusElem = rsaKeyValElem
    ? findDirectChildElement(rsaKeyValElem, 'Modulus', XMLDSIG_NS)
    : null;
  const exponentElem = rsaKeyValElem
    ? findDirectChildElement(rsaKeyValElem, 'Exponent', XMLDSIG_NS)
    : null;
  const refElem = signedInfoElem
    ? findDirectChildElement(signedInfoElem, 'Reference', XMLDSIG_NS)
    : null;
  const digestValElem = refElem
    ? findDirectChildElement(refElem, 'DigestValue', XMLDSIG_NS)
    : null;

  if (!signedInfoElem || !sigValElem || !modulusElem || !exponentElem || !refElem || !digestValElem) {
    throw makeXmlDsigTamperedError();
  }

  // Enforce strict SHA-256 + RSA-SHA256 algorithm allowlist (preventing downgrade / confusion)
  const sigMethodElem = findDirectChildElement(signedInfoElem, 'SignatureMethod', XMLDSIG_NS);
  const sigAlg = sigMethodElem?.attrs.find((a) => a.localName === 'Algorithm')?.value || '';
  const digestMethodElem = findDirectChildElement(refElem, 'DigestMethod', XMLDSIG_NS);
  const digestAlg = digestMethodElem?.attrs.find((a) => a.localName === 'Algorithm')?.value || '';
  const refUri = refElem.attrs.find((a) => a.localName === 'URI')?.value ?? '';
  if (sigAlg !== XMLDSIG_RSA_SHA256_URI || digestAlg !== XMLENC_SHA256_URI || refUri !== '') {
    throw makeXmlDsigTamperedError();
  }

  // 1. Enveloped-Signature Transform + C14N over `<License>` (with `<Signature>` stripped) -> SHA-256
  let refUseExclusive = false;
  /** @type {Set<string> | undefined} */
  let refInclusivePrefixes;
  const transformsElem = findDirectChildElement(refElem, 'Transforms', XMLDSIG_NS);
  if (transformsElem) {
    for (const child of transformsElem.children) {
      if (child.type !== 'element' || child.localName !== 'Transform') continue;
      const tAlg = child.attrs.find((a) => a.localName === 'Algorithm')?.value || '';
      if (tAlg.includes('xml-exc-c14n')) {
        refUseExclusive = true;
        const incNs = findDirectChildElement(child, 'InclusiveNamespaces', XML_EXC_C14N_NS);
        const pfxList = incNs?.attrs.find((a) => a.localName === 'PrefixList')?.value || '';
        if (pfxList.trim()) {
          refInclusivePrefixes = new Set(pfxList.trim().split(/\s+/));
        }
      }
    }
  }

  const targetLicenseElem = sigElem.parent;
  const c14nLicenseWithoutSig = serializeC14nNode(targetLicenseElem, {
    exclusive: refUseExclusive,
    inclusivePrefixes: refInclusivePrefixes,
    skipElement: sigElem,
  });
  const computedDigest = crypto.createHash('sha256').update(c14nLicenseWithoutSig, 'utf8').digest();
  const expectedDigestB64 = collectElementText(digestValElem).replace(/\s+/g, '');
  const expectedDigest = expectedDigestB64 ? Buffer.from(expectedDigestB64, 'base64') : Buffer.alloc(0);
  if (
    expectedDigest.length !== computedDigest.length ||
    !crypto.timingSafeEqual(computedDigest, expectedDigest)
  ) {
    throw makeXmlDsigTamperedError();
  }

  // 2. Exclusive C14N (`xml-exc-c14n#`) over `<SignedInfo>` -> RSA-SHA256 verification
  const c14nMethodElem = findDirectChildElement(signedInfoElem, 'CanonicalizationMethod', XMLDSIG_NS);
  const c14nAlg =
    c14nMethodElem?.attrs.find((a) => a.localName === 'Algorithm')?.value || XML_EXC_C14N_NS;
  const signedInfoUseExclusive = c14nAlg.includes('xml-exc-c14n');
  /** @type {Set<string> | undefined} */
  let signedInfoInclusivePrefixes;
  if (signedInfoUseExclusive && c14nMethodElem) {
    const incNs = findDirectChildElement(c14nMethodElem, 'InclusiveNamespaces', XML_EXC_C14N_NS);
    const pfxList = incNs?.attrs.find((a) => a.localName === 'PrefixList')?.value || '';
    if (pfxList.trim()) {
      signedInfoInclusivePrefixes = new Set(pfxList.trim().split(/\s+/));
    }
  }
  const c14nSignedInfo = serializeC14nNode(signedInfoElem, {
    exclusive: signedInfoUseExclusive,
    inclusivePrefixes: signedInfoInclusivePrefixes,
  });

  const modB64 = collectElementText(modulusElem).replace(/\s+/g, '');
  const expB64 = collectElementText(exponentElem).replace(/\s+/g, '');
  const sigB64 = collectElementText(sigValElem).replace(/\s+/g, '');
  if (!modB64 || !expB64 || !sigB64) {
    throw makeXmlDsigTamperedError();
  }

  const modulusBuf = Buffer.from(modB64, 'base64');
  const exponentBuf = Buffer.from(expB64, 'base64');
  const signatureBuf = Buffer.from(sigB64, 'base64');
  if (modulusBuf.length < 64 || exponentBuf.length === 0 || signatureBuf.length === 0) {
    throw makeXmlDsigTamperedError();
  }

  let rsaVerified = false;
  try {
    const publicKey = crypto.createPublicKey({
      key: {
        kty: 'RSA',
        n: toUnsignedBase64Url(modulusBuf),
        e: toUnsignedBase64Url(exponentBuf),
      },
      format: 'jwk',
    });
    if (options?.pinnedSpkiSha256Set) {
      const pinSet =
        options.pinnedSpkiSha256Set instanceof Set
          ? options.pinnedSpkiSha256Set
          : new Set(Array.isArray(options.pinnedSpkiSha256Set) ? options.pinnedSpkiSha256Set : []);
      if (pinSet.size > 0) {
        const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
        const spkiSha256 = crypto.createHash('sha256').update(spkiDer).digest('hex').toLowerCase();
        const matchedPin = Array.from(pinSet).some(
          (p) => String(p || '').trim().toLowerCase() === spkiSha256
        );
        if (!matchedPin) {
          throw makeXmlDsigTamperedError();
        }
      }
    }
    rsaVerified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(c14nSignedInfo, 'utf8'),
      publicKey,
      signatureBuf
    );
  } catch {
    throw makeXmlDsigTamperedError();
  }

  if (!rsaVerified) {
    throw makeXmlDsigTamperedError();
  }

  return true;
}

/**
 * Parses a binary `<SPLicenseBlock>` TLV buffer.
 * Header: 8 bytes (`u32 LE` magic/version + `u32 LE` offset), followed by `[blockId: u32 LE, size: u32 LE, value[size]]`.
 *
 * @param {Buffer} buf
 * @param {{
 *   verifyCmacWithKey?: Buffer | null,
 *   requireCmacSignature?: boolean,
 *   allowUnsigned?: boolean,
 *   verifyServerSignatureWithKey?: string | Buffer | crypto.KeyObject | Record<string, any> | null,
 *   serverSignaturePublicKey?: string | Buffer | crypto.KeyObject | Record<string, any> | null,
 *   serverPublicKey?: string | Buffer | crypto.KeyObject | Record<string, any> | null,
 *   requireServerSignatureVerification?: boolean,
 * }} [options]
 */
function parseSpLicenseBuffer(buf, options = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) {
    throw new Error(`SPLicense buffer too short (${buf?.length || 0} bytes)`);
  }

  const headerMagic = buf.readUInt32LE(0);
  const headerOffset = buf.readUInt32LE(4);

  const blocks = [];
  let deviceKeyBuffer = null;
  let clepRsaKeyPem = null;
  let licenseId = null;
  let packageFullName = null;
  const packedContentKeys = [];
  let cmacBlockOffset = -1;
  let cmacTag = null;
  let signatureBlockOffset = -1;
  let signatureBlock = null;

  let offset = 8;
  while (offset + 8 <= buf.length) {
    const blockStartOffset = offset;
    const blockId = buf.readUInt32LE(offset);
    const size = buf.readUInt32LE(offset + 4);
    const valueStart = offset + 8;
    const valueEnd = valueStart + size;
    if (valueEnd > buf.length) {
      break;
    }
    const payload = buf.subarray(valueStart, valueEnd);
    blocks.push({ blockId, size, offset: blockStartOffset, payload });

    if (blockId === BLOCK_ID.ENCRYPTED_DEVICE_KEY && payload.length >= 534) {
      // EncryptedDeviceKey: u16 size (0..2), u32 version (2..6), key_schedule u32[58] (6..238),
      // _unknown1[280] (238..518), device_key[16] (518..534)
      const scheduleKey = deriveClepKeyFromSchedule(payload.subarray(6, 238));
      const encDeviceKey = payload.subarray(518, 534);
      deviceKeyBuffer = decryptCbcZeroIv(scheduleKey, encDeviceKey);
    } else if (blockId === BLOCK_ID.CLEP_SIGN_STATE && payload.length >= 780) {
      // ClepSignState: u32 version (0..4), key_data[544] (4..548), key_schedule u32[58] (548..780)
      const scheduleKey = deriveClepKeyFromSchedule(payload.subarray(548, 780));
      const decryptedRsaBlob = decryptCbcZeroIv(scheduleKey, payload.subarray(4, 548));
      clepRsaKeyPem = parseBcryptRsaPrivateKeyToPem(decryptedRsaBlob);
    } else if (blockId === BLOCK_ID.PACKED_CONTENT_KEYS && payload.length >= 4) {
      let pkOff = 0;
      while (pkOff + 4 <= payload.length) {
        const idLen = payload.readUInt16LE(pkOff);
        const keyLen = payload.readUInt16LE(pkOff + 2);
        const entryEnd = pkOff + 4 + idLen + keyLen;
        if (idLen < 16 || keyLen <= 0 || entryEnd > payload.length) break;
        const rawGuid16 = Buffer.from(payload.subarray(pkOff + 4, pkOff + 20));
        const keyId = formatMixedEndianGuid(rawGuid16);
        const wrappedCik = Buffer.from(payload.subarray(pkOff + 4 + idLen, entryEnd));
        packedContentKeys.push({
          keyId,
          keyIdRaw: rawGuid16,
          wrappedCik,
        });
        pkOff = entryEnd;
      }
    } else if (blockId === BLOCK_ID.LICENSE_ID && payload.length >= 16) {
      licenseId = formatMixedEndianGuid(payload.subarray(0, 16));
    } else if (blockId === BLOCK_ID.PACKAGE_FULL_NAME && payload.length >= 2) {
      packageFullName = payload
        .toString('utf16le')
        .replace(/\0+$/g, '')
        .trim();
    } else if (blockId === BLOCK_ID.CMAC_SIGNATURE) {
      cmacBlockOffset = blockStartOffset;
      cmacTag =
        payload.length >= 16
          ? Buffer.from(payload.subarray(payload.length - 16))
          : Buffer.from(payload);
    } else if (blockId === BLOCK_ID.SIGNATURE_BLOCK) {
      signatureBlockOffset = blockStartOffset;
      signatureBlock =
        payload.length >= 4
          ? {
              algorithmId: payload.readUInt16LE(0),
              signatureOrigin: payload.readUInt16LE(2),
              signature: Buffer.from(payload.subarray(4)),
            }
          : {
              algorithmId: 0,
              signatureOrigin: 0,
              signature: Buffer.alloc(0),
            };
    }

    offset = valueEnd;
  }

  let cmacVerified = false;
  let serverSignaturePresent = false;
  let serverSignatureVerified = false;
  /** @type {'cmac-0x0101' | 'server-0x00cc' | 'unsigned'} */
  let signatureType = 'unsigned';

  const serverSigKeyMaterial =
    options.verifyServerSignatureWithKey ||
    options.serverSignaturePublicKey ||
    options.serverPublicKey ||
    null;

  if (cmacTag !== null || options.requireCmacSignature === true) {
    if (!cmacTag || cmacBlockOffset < 8) {
      throw Object.assign(
        new Error('SPLicense missing required AES-CMAC signature tag (0x0101)'),
        { code: 'SPLICENSE_UNSIGNED' }
      );
    }

    const cmacKey = Buffer.isBuffer(options.verifyCmacWithKey)
      ? options.verifyCmacWithKey
      : deviceKeyBuffer;
    if (!Buffer.isBuffer(cmacKey) || cmacKey.length !== 16) {
      throw Object.assign(
        new Error('SPLicense missing required AES-CMAC signature tag (0x0101) verification key'),
        { code: 'SPLICENSE_CMAC_TAMPERED' }
      );
    }

    const signedSlice = buf.subarray(0, cmacBlockOffset);
    const expected = aes128Cmac(cmacKey, signedSlice);
    const validCmac = cmacTag.length === 16 && crypto.timingSafeEqual(expected, cmacTag);
    if (!validCmac) {
      throw Object.assign(
        new Error('SPLicense AES-128-CMAC verification failed for signature tag (0x0101)'),
        { code: 'SPLICENSE_CMAC_TAMPERED' }
      );
    }

    cmacVerified = true;
    serverSignaturePresent = Boolean(signatureBlock);
    if (signatureBlock && serverSigKeyMaterial && signatureBlockOffset >= 8) {
      const okServerSig = verifyServerSignatureBlock0x00cc(
        buf.subarray(0, signatureBlockOffset),
        signatureBlock,
        serverSigKeyMaterial
      );
      if (!okServerSig) {
        throw makeXmlDsigTamperedError(
          'SPLicense server SIGNATURE_BLOCK (0x00cc) cryptographic verification failed'
        );
      }
      serverSignatureVerified = true;
    }
    signatureType = 'cmac-0x0101';
  } else if (signatureBlock !== null) {
    const validServerSigStructure =
      headerMagic === 0x00000014 &&
      signatureBlockOffset >= 8 &&
      (8 + headerOffset === signatureBlockOffset || 8 + headerOffset === buf.length) &&
      signatureBlock.algorithmId === 1 &&
      signatureBlock.signature.length === 64 &&
      signatureBlock.signature.some((b) => b !== 0);
    if (!validServerSigStructure) {
      throw Object.assign(
        new Error('SPLicense malformed server SIGNATURE_BLOCK (0x00cc)'),
        { code: 'SPLICENSE_SIGNATURE_TAMPERED' }
      );
    }

    if (serverSigKeyMaterial) {
      const okServerSig = verifyServerSignatureBlock0x00cc(
        buf.subarray(0, signatureBlockOffset),
        signatureBlock,
        serverSigKeyMaterial
      );
      if (!okServerSig) {
        throw Object.assign(
          new Error('SPLicense server SIGNATURE_BLOCK (0x00cc) cryptographic verification failed'),
          { code: 'SPLICENSE_SIGNATURE_TAMPERED' }
        );
      }
      serverSignatureVerified = true;
    } else if (options.requireServerSignatureVerification === true) {
      throw Object.assign(
        new Error('SPLicense server SIGNATURE_BLOCK (0x00cc) verification key material required'),
        { code: 'SPLICENSE_SIGNATURE_TAMPERED' }
      );
    }

    cmacVerified = false;
    serverSignaturePresent = true;
    signatureType = 'server-0x00cc';
  } else if (options.allowUnsigned === true) {
    cmacVerified = false;
    serverSignaturePresent = false;
    signatureType = 'unsigned';
  } else {
    throw Object.assign(
      new Error(
        'SPLicense missing required signature tag (expected 0x0101 AES-CMAC or 0x00cc SIGNATURE_BLOCK)'
      ),
      { code: 'SPLICENSE_UNSIGNED' }
    );
  }

  return {
    headerMagic,
    headerOffset,
    blocks,
    deviceKeyBuffer,
    clepRsaKeyPem,
    licenseId,
    packageFullName,
    packedContentKeys,
    cmacTag,
    cmacVerified,
    signatureBlock,
    serverSignaturePresent,
    serverSignatureVerified,
    signatureType,
  };
}

/**
 * Parses an `<SPLicenseBlock>` payload (raw Base64 TLV, `<License>` XML, or Base64-encoded `<License>` XML),
 * verifying any enveloped W3C XML-DSig `RSA-SHA256` signature (forwarding `options` including
 * `pinnedSpkiSha256Set`!) unless `options.verifyXmlSignature === false`.
 *
 * @param {string} rawXmlOrBase64
 * @param {{
 *   verifyCmacWithKey?: Buffer | null,
 *   requireCmacSignature?: boolean,
 *   allowUnsigned?: boolean,
 *   verifyXmlSignature?: boolean,
 *   pinnedSpkiSha256Set?: Set<string> | string[],
 *   verifyServerSignatureWithKey?: string | Buffer | crypto.KeyObject | Record<string, any> | null,
 *   serverSignaturePublicKey?: string | Buffer | crypto.KeyObject | Record<string, any> | null,
 *   serverPublicKey?: string | Buffer | crypto.KeyObject | Record<string, any> | null,
 *   requireServerSignatureVerification?: boolean,
 * }} [options]
 */
function parseSpLicenseBase64(rawXmlOrBase64, options = {}) {
  const decodedXml = decodeSpLicenseXmlIfPresent(rawXmlOrBase64);
  let xmlSignatureVerified = false;
  if (decodedXml !== null && options.verifyXmlSignature !== false) {
    const verifyFn = boundFacade?.verifyLicenseXmlDsigIfPresent || verifyLicenseXmlDsigIfPresent;
    xmlSignatureVerified = verifyFn(decodedXml, options);
  }

  const b64Blocks = extractAllSpLicenseBase64Blocks(
    decodedXml !== null ? decodedXml : rawXmlOrBase64
  );
  if (b64Blocks.length === 0) {
    throw new Error('Empty SPLicense payload');
  }
  const parseBufferFn = boundFacade?.parseSpLicenseBuffer || parseSpLicenseBuffer;
  const parsedList = b64Blocks.map((b64) => parseBufferFn(Buffer.from(b64, 'base64'), options));
  if (parsedList.length === 1) {
    return {
      ...parsedList[0],
      xmlSignatureVerified,
    };
  }

  const first = parsedList[0];
  const mergedBlocks = [];
  const mergedPackedContentKeys = [];
  let deviceKeyBuffer = null;
  let clepRsaKeyPem = null;
  let licenseId = null;
  let packageFullName = null;
  let cmacTag = null;
  /** @type {boolean | null} */
  let cmacVerified = null;
  let signatureBlock = null;
  let serverSignaturePresent = false;
  /** @type {boolean | null} */
  let serverSignatureVerified = null;
  /** @type {'cmac-0x0101' | 'server-0x00cc' | 'unsigned'} */
  let signatureType = first.signatureType;

  for (const p of parsedList) {
    mergedBlocks.push(...p.blocks);
    mergedPackedContentKeys.push(...p.packedContentKeys);
    if (!deviceKeyBuffer && p.deviceKeyBuffer) deviceKeyBuffer = p.deviceKeyBuffer;
    if (!clepRsaKeyPem && p.clepRsaKeyPem) clepRsaKeyPem = p.clepRsaKeyPem;
    if (!licenseId && p.licenseId) licenseId = p.licenseId;
    if (!packageFullName && p.packageFullName) packageFullName = p.packageFullName;
    if (!cmacTag && p.cmacTag) cmacTag = p.cmacTag;
    if (p.cmacVerified !== null) {
      cmacVerified = cmacVerified === null ? p.cmacVerified : cmacVerified && p.cmacVerified;
    }
    if (!signatureBlock && p.signatureBlock) signatureBlock = p.signatureBlock;
    if (p.serverSignaturePresent) {
      serverSignaturePresent = true;
      serverSignatureVerified =
        serverSignatureVerified === null
          ? Boolean(p.serverSignatureVerified)
          : serverSignatureVerified && Boolean(p.serverSignatureVerified);
    }
    if (p.signatureType === 'cmac-0x0101') signatureType = 'cmac-0x0101';
    else if (signatureType === 'unsigned' && p.signatureType === 'server-0x00cc') {
      signatureType = 'server-0x00cc';
    }
  }

  return {
    headerMagic: first.headerMagic,
    headerOffset: first.headerOffset,
    blocks: mergedBlocks,
    deviceKeyBuffer,
    clepRsaKeyPem,
    licenseId,
    packageFullName,
    packedContentKeys: mergedPackedContentKeys,
    cmacTag,
    cmacVerified: Boolean(cmacVerified),
    signatureBlock,
    serverSignaturePresent,
    serverSignatureVerified: Boolean(serverSignatureVerified),
    signatureType,
    xmlSignatureVerified,
  };
}

module.exports = {
  bindFacade,
  decodeSpLicenseXmlIfPresent,
  extractAllSpLicenseBase64Blocks,
  extractSpLicenseBase64,
  verifyLicenseXmlDsigIfPresent,
  parseSpLicenseBuffer,
  parseSpLicenseBase64,
};
