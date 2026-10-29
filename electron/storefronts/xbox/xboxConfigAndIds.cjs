'use strict';

/**
 * Canonical Xbox / GDK / Appx Identity, TitleId <-> SCID Derivation & Manifest XML Parser
 * (`xboxConfigAndIds.cjs` — D2.3).
 *
 * Eliminates hex-vs-decimal TitleId ambiguity (`deriveScidFromHexTitleId` vs
 * `deriveScidFromDecimalTitleId` vs `deriveDefaultScidFromTitleId`), strips XML comments
 * (`<!-- ... -->`), decodes standard + numeric XML entities without double-unescaping,
 * and computes deterministic Windows 13-char Crockford/Appx Base32 `PackageFamilyName`s.
 */

const crypto = require('node:crypto');

const APPX_BASE32_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

const HELPER_EXE_BASENAMES = new Set([
  'gamelaunchhelper.exe',
  'crashreportclient.exe',
  'crs-handler.exe',
  'unitycrashhandler64.exe',
  'unitycrashhandler32.exe',
  'ue4prereqsetup_x64.exe',
  'ueprereqsetup_x64.exe',
  'vc_redist.x64.exe',
  'vc_redist.x86.exe',
  'dxsetup.exe',
  'easyanticheat_setup.exe',
  'easyanticheat_eos_setup.exe',
  'beservice_x64.exe',
  'cleanup.exe',
  'touchup.exe',
]);

function normalizeContainerRelPath(rawPath) {
  return String(rawPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
}

/**
 * Strips all `<!-- ... -->` XML comments prior to tag/attribute extraction so commented-out
 * `<Executable>`, `<TitleId>`, or `<Identity>` blocks are never matched.
 *
 * @param {string} xml
 * @returns {string}
 */
function stripXmlComments(xml) {
  return String(xml || '').replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Decodes XML character entities (`&lt;`, `&gt;`, `&quot;`, `&apos;`, `&amp;`, `&#DEC;`, `&#xHEX;`)
 * in a single pass so sequences like `&amp;lt;` become `&lt;` without double-unescaping.
 *
 * @param {string} raw
 * @returns {string}
 */
function decodeXmlEntities(raw) {
  const str = String(raw || '');
  if (!str.includes('&')) return str;
  return str.replace(
    /&(?:#x([0-9a-fA-F]{1,6})|#(\d{1,7})|(lt|gt|quot|apos|amp));/gi,
    (full, hexCp, decCp, named) => {
      if (hexCp !== undefined || decCp !== undefined) {
        const cp = hexCp !== undefined ? parseInt(hexCp, 16) : parseInt(decCp, 10);
        if (
          Number.isInteger(cp) &&
          cp >= 0x01 &&
          cp <= 0x10ffff &&
          !(cp >= 0xd800 && cp <= 0xdfff)
        ) {
          try {
            return String.fromCodePoint(cp);
          } catch {
            return full;
          }
        }
        return full;
      }
      switch (String(named).toLowerCase()) {
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        case 'amp':
          return '&';
        default:
          return full;
      }
    }
  );
}

function extractXmlAttr(tagText, attrName) {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(tagText);
  if (!m) return '';
  const rawVal = m[1] !== undefined ? m[1] : m[2] || '';
  return decodeXmlEntities(rawVal).trim();
}

function extractXmlTagText(xml, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = re.exec(xml);
  return m ? decodeXmlEntities(m[1]).trim() : '';
}

/**
 * Computes Windows 13-character Appx PublisherId from an Identity Publisher DN.
 * Uses SHA-256 over UTF-16LE bytes -> top 64 bits << 1 -> 13x5-bit Appx Base32.
 *
 * @param {string} publisher
 * @returns {string}
 */
function computeAppxPublisherId(publisher) {
  const pubStr = String(publisher || '').trim();
  if (!pubStr) return '';
  const digest = crypto.createHash('sha256').update(Buffer.from(pubStr, 'utf16le')).digest();
  let bits = 0n;
  for (let i = 0; i < 8; i += 1) {
    bits = (bits << 8n) | BigInt(digest[i]);
  }
  bits <<= 1n;
  let out = '';
  for (let i = 12; i >= 0; i -= 1) {
    out += APPX_BASE32_ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  }
  return out;
}

/**
 * Deterministically computes Windows PackageFamilyName (`<IdentityName>_<PublisherId>`).
 *
 * @param {string} identityName
 * @param {string} publisher
 * @returns {string}
 */
function computePackageFamilyName(identityName, publisher) {
  const name = String(identityName || '').trim();
  const pubId = computeAppxPublisherId(publisher);
  if (!name || !pubId) return '';
  return `${name}_${pubId}`;
}

/**
 * Normalizes a TitleId into an 8-character uppercase hexadecimal string (e.g. `"4D530910"`),
 * or `""` if invalid.
 *
 * @param {string|number|bigint|null|undefined} titleId
 * @param {{ format?: 'auto' | 'hex' | 'decimal', isHex?: boolean }} [options]
 * @returns {string}
 */
function normalizeHexTitleId(titleId, options = {}) {
  if (titleId === null || titleId === undefined) return '';
  const formatOpt =
    typeof options?.isHex === 'boolean'
      ? options.isHex
        ? 'hex'
        : 'decimal'
      : options?.format || 'auto';

  if (typeof titleId === 'number') {
    if (!Number.isFinite(titleId) || !Number.isInteger(titleId) || titleId < 0 || titleId > 0xffffffff) {
      return '';
    }
    return (titleId >>> 0).toString(16).padStart(8, '0').toUpperCase();
  }
  if (typeof titleId === 'bigint') {
    if (titleId < 0n || titleId > 0xffffffffn) return '';
    return Number(titleId).toString(16).padStart(8, '0').toUpperCase();
  }

  const raw = String(titleId).trim();
  if (!raw) return '';

  if (formatOpt === 'hex') {
    const clean = raw.replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{1,8}$/.test(clean)) return '';
    return (parseInt(clean, 16) >>> 0).toString(16).padStart(8, '0').toUpperCase();
  }

  if (formatOpt === 'decimal') {
    if (/^0x[0-9a-fA-F]{1,8}$/i.test(raw)) {
      return (parseInt(raw.slice(2), 16) >>> 0).toString(16).padStart(8, '0').toUpperCase();
    }
    if (!/^\d{1,10}$/.test(raw)) return '';
    const num = Number(raw);
    if (!Number.isSafeInteger(num) || num < 0 || num > 0xffffffff) return '';
    return (num >>> 0).toString(16).padStart(8, '0').toUpperCase();
  }

  // format === 'auto'
  if (/^0x[0-9a-fA-F]{1,8}$/i.test(raw)) {
    return (parseInt(raw.slice(2), 16) >>> 0).toString(16).padStart(8, '0').toUpperCase();
  }
  if (/^[0-9a-fA-F]{1,8}$/.test(raw) && /[a-fA-F]/.test(raw)) {
    return (parseInt(raw, 16) >>> 0).toString(16).padStart(8, '0').toUpperCase();
  }
  if (/^\d{9,10}$/.test(raw)) {
    const num = Number(raw);
    if (!Number.isSafeInteger(num) || num < 0 || num > 0xffffffff) return '';
    return (num >>> 0).toString(16).padStart(8, '0').toUpperCase();
  }
  if (/^[0-9a-fA-F]{1,8}$/.test(raw)) {
    return raw.padStart(8, '0').toUpperCase();
  }
  return '';
}

/**
 * Strictly derives a canonical lowercase SCID (`00000000-0000-0000-0000-0000<hex8>`) from a
 * hexadecimal TitleId string (such as `<TitleId>` in `MicrosoftGame.config`).
 *
 * @param {string} hexStr
 * @returns {string}
 */
function deriveScidFromHexTitleId(hexStr) {
  if (typeof hexStr !== 'string' && typeof hexStr !== 'number') return '';
  if (typeof hexStr === 'number') {
    const hex8 = normalizeHexTitleId(hexStr, { format: 'decimal' });
    return hex8 ? `00000000-0000-0000-0000-0000${hex8.toLowerCase()}` : '';
  }
  const hex8 = normalizeHexTitleId(hexStr, { format: 'hex' });
  return hex8 ? `00000000-0000-0000-0000-0000${hex8.toLowerCase()}` : '';
}

/**
 * Strictly derives a canonical lowercase SCID (`00000000-0000-0000-0000-0000<hex8>`) from a
 * decimal uint32 TitleId (such as `modernTitleId` in DisplayCatalog / TitleHub JSON).
 *
 * @param {string|number|bigint} decStrOrNum
 * @returns {string}
 */
function deriveScidFromDecimalTitleId(decStrOrNum) {
  const hex8 = normalizeHexTitleId(decStrOrNum, { format: 'decimal' });
  return hex8 ? `00000000-0000-0000-0000-0000${hex8.toLowerCase()}` : '';
}

/**
 * Derives the canonical Xbox Live SCID (`00000000-0000-0000-0000-0000<hex8>`) from a TitleId.
 * Supports `{ format: 'auto' | 'hex' | 'decimal', isHex?: boolean }`, `0x` prefix, `[a-f]`
 * hex digit detection, and explicit hex/decimal disambiguation.
 *
 * @param {string|number|bigint|null|undefined} titleId
 * @param {{ format?: 'auto' | 'hex' | 'decimal', isHex?: boolean }} [options]
 * @returns {string}
 */
function deriveDefaultScidFromTitleId(titleId, options = {}) {
  const hex8 = normalizeHexTitleId(titleId, options);
  if (!hex8) return '';
  return `00000000-0000-0000-0000-0000${hex8.toLowerCase()}`;
}

/**
 * Parses `MicrosoftGame.config` XML text into canonical One Launcher Xbox metadata.
 * Strips `<!-- ... -->` XML comments and `<DevelopmentOnly>...</DevelopmentOnly>` blocks,
 * decodes XML character/entity references, and enforces `<TitleId>` vs `<ExtendedAttribute Name="Scid">`
 * precedence with `fallbackScid` retention.
 *
 * @param {Buffer|string} xmlInput
 */
function parseMicrosoftGameConfigXml(xmlInput) {
  const rawXml = Buffer.isBuffer(xmlInput)
    ? xmlInput.toString('utf8')
    : String(xmlInput || '');
  const uncommentedXml = stripXmlComments(rawXml).replace(/^\uFEFF/, '');
  if (!uncommentedXml.trim()) return null;

  const xml = uncommentedXml
    .replace(/<DevelopmentOnly\b[^>]*>[\s\S]*?<\/DevelopmentOnly>/gi, '')
    .replace(/<DevelopmentOnly\b[^>]*\/>/gi, '');

  const gameTagMatch = /<Game\b([^>]*)>/i.exec(xml) || /<Game\b([^>]*)>/i.exec(uncommentedXml);
  if (!gameTagMatch) return null;
  const configVersion = Number(extractXmlAttr(gameTagMatch[1], 'configVersion') || '0');

  const identityMatch =
    /<Identity\b([^>]*)\/?>/i.exec(xml) || /<Identity\b([^>]*)\/?>/i.exec(uncommentedXml);
  const identityName = identityMatch ? extractXmlAttr(identityMatch[1], 'Name') : '';
  const publisher = identityMatch ? extractXmlAttr(identityMatch[1], 'Publisher') : '';
  const version = identityMatch ? extractXmlAttr(identityMatch[1], 'Version') : '';
  const packageFamilyName = computePackageFamilyName(identityName, publisher);

  const rawTitleIdText =
    extractXmlTagText(xml, 'TitleId') || extractXmlTagText(uncommentedXml, 'TitleId');
  const rawTitleIdExtracted = rawTitleIdText.replace(/^0x/i, '').toUpperCase();
  const normalizedHexTid = rawTitleIdExtracted
    ? normalizeHexTitleId(rawTitleIdExtracted, { format: 'hex' })
    : '';
  const rawTitleId = normalizedHexTid || rawTitleIdExtracted;
  const titleIdDecimal = normalizedHexTid ? String(parseInt(normalizedHexTid, 16)) : '';
  const msaAppId = extractXmlTagText(xml, 'MSAAppId');
  const storeId = extractXmlTagText(xml, 'StoreId').toUpperCase();

  const defaultTitleScid = normalizedHexTid
    ? deriveScidFromHexTitleId(normalizedHexTid).toLowerCase()
    : '';
  let explicitScid = extractXmlTagText(xml, 'Scid');
  if (!explicitScid) {
    const extScidMatch = /<ExtendedAttribute\b[^>]*Name\s*=\s*["']Scid["'][^>]*>/i.exec(xml);
    if (extScidMatch) {
      explicitScid = extractXmlAttr(extScidMatch[0], 'Value');
    }
  }
  const normalizedExplicitScid = String(explicitScid || '').trim().toLowerCase();
  const titleDerivedScidMatch =
    /^00000000-0000-0000-0000-0000([0-9a-f]{8})$/i.exec(normalizedExplicitScid);

  let scid = '';
  let fallbackScid = '';
  if (normalizedExplicitScid && titleDerivedScidMatch && normalizedHexTid) {
    if (titleDerivedScidMatch[1].toLowerCase() !== normalizedHexTid.toLowerCase()) {
      scid = defaultTitleScid;
      fallbackScid = normalizedExplicitScid;
    } else {
      scid = defaultTitleScid;
    }
  } else if (normalizedExplicitScid) {
    scid = normalizedExplicitScid;
    if (defaultTitleScid && defaultTitleScid !== normalizedExplicitScid) {
      fallbackScid = defaultTitleScid;
    }
  } else {
    scid = defaultTitleScid;
  }

  const reqXblText = extractXmlTagText(xml, 'RequiresXboxLive');
  const requiresXboxLive = reqXblText
    ? /^true$/i.test(reqXblText)
    : Boolean(msaAppId || rawTitleId);

  const aumText = extractXmlTagText(xml, 'AdvancedUserModel');
  const advancedUserModel = aumText ? /^true$/i.test(aumText) : false;

  const desktopRegMatch = /<DesktopRegistration\b[^>]*>([\s\S]*?)<\/DesktopRegistration>/i.exec(xml);
  const desktopRegistration = desktopRegMatch
    ? {
        modFolder: extractXmlAttr(
          (/<ModFolder\b([^>]*)\/?>/i.exec(desktopRegMatch[1]) || [])[1] || '',
          'Name'
        ),
        disableFilesystemWriteVirtualization: /<DisableFilesystemWriteVirtualization\b/i.test(
          desktopRegMatch[1]
        ),
        enableWritesToPackageRoot: /<EnableWritesToPackageRoot\b/i.test(desktopRegMatch[1]),
      }
    : null;

  const shellMatch = /<ShellVisuals\b([^>]*)\/?>/i.exec(xml);
  const shellVisuals = {
    defaultDisplayName: shellMatch ? extractXmlAttr(shellMatch[1], 'DefaultDisplayName') : '',
    publisherDisplayName: shellMatch ? extractXmlAttr(shellMatch[1], 'PublisherDisplayName') : '',
    storeLogo: shellMatch
      ? normalizeContainerRelPath(extractXmlAttr(shellMatch[1], 'StoreLogo'))
      : '',
    square150x150Logo: shellMatch
      ? normalizeContainerRelPath(extractXmlAttr(shellMatch[1], 'Square150x150Logo'))
      : '',
    square480x480Logo: shellMatch
      ? normalizeContainerRelPath(extractXmlAttr(shellMatch[1], 'Square480x480Logo'))
      : '',
    splashScreenImage: shellMatch
      ? normalizeContainerRelPath(extractXmlAttr(shellMatch[1], 'SplashScreenImage'))
      : '',
  };

  const executables = [];
  const exeRegex = /<Executable\b([^>]*)\/?>/gi;
  let exeMatch;
  while ((exeMatch = exeRegex.exec(xml)) !== null) {
    const attrs = exeMatch[1];
    const rawExeName = extractXmlAttr(attrs, 'Name');
    if (!rawExeName) continue;
    const normExePath = normalizeContainerRelPath(rawExeName);
    const deviceFamily = extractXmlAttr(attrs, 'TargetDeviceFamily');
    if (/^(?:XboxOne|Scarlett|Console)$/i.test(deviceFamily)) continue;

    const rawOverrideWd =
      extractXmlAttr(attrs, 'OverrideWorkingDirectory') ||
      extractXmlAttr(attrs, 'WorkingDirectory');
    const overrideWorkingDirectory = rawOverrideWd
      ? normalizeContainerRelPath(rawOverrideWd)
      : '';
    const alias = extractXmlAttr(attrs, 'Alias') || undefined;

    const baseName = normExePath.split('/').pop().toLowerCase();
    executables.push({
      name: normExePath,
      id: extractXmlAttr(attrs, 'Id'),
      ...(alias ? { alias } : {}),
      targetDeviceFamily: deviceFamily || 'PC',
      overrideWorkingDirectory: overrideWorkingDirectory || undefined,
      isGameLaunchHelper: baseName === 'gamelaunchhelper.exe',
      isHelperStub: HELPER_EXE_BASENAMES.has(baseName),
    });
  }

  const primaryExecutableObj =
    executables.find((e) => !e.isHelperStub) || executables[0] || null;

  return {
    configVersion,
    identity: {
      name: identityName,
      publisher,
      version,
    },
    packageFamilyName,
    titleId: rawTitleId,
    titleIdDecimal,
    scid,
    ...(fallbackScid ? { fallbackScid } : {}),
    msaAppId,
    storeId,
    requiresXboxLive,
    advancedUserModel,
    desktopRegistration,
    shellVisuals,
    executables,
    primaryExecutable: primaryExecutableObj ? primaryExecutableObj.name : '',
    overrideWorkingDirectory: primaryExecutableObj?.overrideWorkingDirectory || undefined,
  };
}

/**
 * Parses `AppxManifest.xml` into structured identity, entry-point, and trust metadata.
 * Strips XML comments and decodes XML entities before extracting attributes/tags.
 *
 * @param {Buffer|string} xmlInput
 */
function parseAppxManifestXml(xmlInput) {
  const rawXml = Buffer.isBuffer(xmlInput)
    ? xmlInput.toString('utf8')
    : String(xmlInput || '');
  const xml = stripXmlComments(rawXml).replace(/^\uFEFF/, '');
  if (!xml.trim() || !/<Package\b/i.test(xml)) return null;

  const identityMatch = /<Identity\b([^>]*)\/?>/i.exec(xml);
  const identityName = identityMatch ? extractXmlAttr(identityMatch[1], 'Name') : '';
  const publisher = identityMatch ? extractXmlAttr(identityMatch[1], 'Publisher') : '';
  const version = identityMatch ? extractXmlAttr(identityMatch[1], 'Version') : '';
  const processorArchitecture = identityMatch
    ? extractXmlAttr(identityMatch[1], 'ProcessorArchitecture')
    : '';
  const packageFamilyName = computePackageFamilyName(identityName, publisher);

  const displayName = extractXmlTagText(xml, 'DisplayName');
  const publisherDisplayName = extractXmlTagText(xml, 'PublisherDisplayName');
  const isFramework = /^true$/i.test(extractXmlTagText(xml, 'Framework'));
  const isResourcePackage = /^true$/i.test(extractXmlTagText(xml, 'ResourcePackage'));
  const hasMainPackageDependency = /<(?:[\w-]+:)?MainPackageDependency\b/i.test(xml);

  const applications = [];
  const appRegex = /<Application\b([^>]*)>/gi;
  let appMatch;
  while ((appMatch = appRegex.exec(xml)) !== null) {
    const attrs = appMatch[1];
    const id = extractXmlAttr(attrs, 'Id');
    const executable = normalizeContainerRelPath(extractXmlAttr(attrs, 'Executable'));
    const entryPoint = extractXmlAttr(attrs, 'EntryPoint');
    const trustLevel =
      extractXmlAttr(attrs, 'TrustLevel') || extractXmlAttr(attrs, 'uap10:TrustLevel');
    const isFullTrust =
      /^Windows\.FullTrustApplication$/i.test(entryPoint) || /^mediumIL$/i.test(trustLevel);
    applications.push({
      id,
      executable,
      entryPoint,
      trustLevel,
      isFullTrust,
      isPureUwpCoreWindow: Boolean(!isFullTrust && entryPoint),
    });
  }

  const hasRunFullTrustCapability = /Capability\b[^>]*Name\s*=\s*["']runFullTrust["']/i.test(xml);
  const hasXboxLiveCapability = /Capability\b[^>]*Name\s*=\s*["']xboxLive["']/i.test(xml);
  const hasFullTrustApplication =
    hasRunFullTrustCapability || applications.some((a) => a.isFullTrust);

  return {
    identity: {
      name: identityName,
      publisher,
      version,
      processorArchitecture,
    },
    packageFamilyName,
    displayName,
    publisherDisplayName,
    isFramework,
    isResourcePackage,
    hasMainPackageDependency,
    hasFullTrustApplication,
    hasXboxLiveCapability,
    applications,
  };
}

module.exports = {
  APPX_BASE32_ALPHABET,
  HELPER_EXE_BASENAMES,
  normalizeContainerRelPath,
  stripXmlComments,
  decodeXmlEntities,
  extractXmlAttr,
  extractXmlTagText,
  computeAppxPublisherId,
  computePackageFamilyName,
  normalizeHexTitleId,
  deriveScidFromHexTitleId,
  deriveScidFromDecimalTitleId,
  deriveDefaultScidFromTitleId,
  parseMicrosoftGameConfigXml,
  parseMicrosoftGameConfig: parseMicrosoftGameConfigXml,
  parseAppxManifestXml,
  parseAppxManifest: parseAppxManifestXml,
};
