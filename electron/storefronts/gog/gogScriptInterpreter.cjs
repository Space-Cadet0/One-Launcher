// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const {
  toHostFilesystemPath,
  atomicWriteFileSync,
  isContainedWithinRoot,
} = require('../../launcher/securityAndPathUtils.cjs');
const {
  toWineWindowsPath,
  escapeWineRegString,
  upsertWineSystemRegKeysBatch,
  syncLiveWineRegistryBatchAsync,
  flushLiveWineRegistryAccumulator,
} = require('../../launcher/firstPartyRegistration.cjs');
const { upsertWineUserRegKeysBatch } = require('../../launcher/wineAndCrossOverManager.cjs');
const {
  resolveCaseInsensitiveRelFile,
  hasMalformedBackslashExportForwarder,
} = require('../../launcher/binaryAndManifestInspectors.cjs');

const GOG_SCRIPT_STAMP_FILENAME = '.one_gog_script_applied.json';
const GOG_SCRIPT_STAMP_VERSION = 1;

const ALLOWED_REGISTRY_HIVES = new Set([
  'HKLM',
  'HKEY_LOCAL_MACHINE',
  'HKCU',
  'HKEY_CURRENT_USER',
]);

/**
 * High-risk Windows / Wine persistence, shell, class, loader, and system registry segments that
 * declarative game `.script` files MUST NEVER write to (`P0-02`).
 */
const DENIED_REGISTRY_SEGMENTS = new Set([
  'run',
  'runonce',
  'runonceex',
  'runservices',
  'runservicesonce',
  'winlogon',
  'image file execution options',
  'appinit_dlls',
  'classes',
  'explorer',
  'policies',
  'services',
  'environment',
  'volatile environment',
  'command processor',
  'active setup',
  'aedebug',
  'silentprocessexit',
  'shell extensions',
  'app paths',
  'uninstall',
  'currentcontrolset',
  'controlset001',
  'controlset002',
]);

const DENIED_REGISTRY_VALUE_NAMES = new Set([
  'appinit_dlls',
  'loadappinit_dlls',
  'autorun',
  'userinit',
  'debugger',
]);

const DENIED_MICROSOFT_SUBTREES = new Set([
  'windows',
  'windows nt',
  'command processor',
  'active setup',
  'internet explorer',
  'office',
  'cryptography',
  'systemcertificates',
  'wbem',
  'powershell',
  'dotnetframework',
  'net framework setup',
  'security',
  'defender',
]);

/** @type {Record<string, string>} */
const LANGUAGE_ISO_FALLBACK_MAP = {
  english: 'en-US',
  en: 'en-US',
  'en-us': 'en-US',
  french: 'fr-FR',
  fr: 'fr-FR',
  german: 'de-DE',
  de: 'de-DE',
  spanish: 'es-ES',
  es: 'es-ES',
  italian: 'it-IT',
  it: 'it-IT',
  polish: 'pl-PL',
  pl: 'pl-PL',
  russian: 'ru-RU',
  ru: 'ru-RU',
  japanese: 'ja-JP',
  ja: 'ja-JP',
  korean: 'ko-KR',
  ko: 'ko-KR',
  chinese: 'zh-CN',
  zh: 'zh-CN',
  portuguese: 'pt-BR',
  pt: 'pt-BR',
};

/**
 * Compute a SHA-256 hex digest without storing any raw host paths on disk.
 *
 * @param {string} input
 * @returns {string}
 */
function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

/**
 * Escape RegExp special characters.
 *
 * @param {string} raw
 * @returns {string}
 */
function escapeRegExp(raw) {
  return String(raw || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns `true` if `raw` contains CR, LF, or NUL control characters.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function hasNewlineOrNull(raw) {
  return /[\r\n\0]/.test(String(raw));
}

/**
 * Returns `true` if `raw` contains an unescaped `[` or `]` (section-header injection risk).
 *
 * @param {string} raw
 * @returns {boolean}
 */
function hasUnescapedSectionBracket(raw) {
  const str = String(raw);
  let backslashRun = 0;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '\\') {
      backslashRun += 1;
      continue;
    }
    if ((ch === '[' || ch === ']') && backslashRun % 2 === 0) {
      return true;
    }
    backslashRun = 0;
  }
  return false;
}

/**
 * Returns `true` if `raw` contains CR, LF, NUL, `[` or `]`.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function hasForbiddenSectionOrControlChars(raw) {
  return /[\r\n\0[\]]/.test(String(raw));
}

/**
 * Validates that a GOG script `setRegistry` hive and subkey satisfy the strict allowlist/denylist
 * (`P0-02`): only game-scoped subkeys under `HKCU\Software\...` or `HKLM\Software\...`
 * (including `Software\GOG.com\Games\...`, `Software\Wow6432Node\GOG.com\Games\...`, and safe game
 * vendor subkeys), explicitly blocking `HKCR`, `Run`, `RunOnce`, `Winlogon`,
 * `Image File Execution Options`, `AppInit_DLLs`, `Classes`, `Explorer`, `Policies`, `Services`,
 * `Environment`, `Command Processor`, and control/bracket injection characters.
 *
 * @param {string} rawRoot
 * @param {string} rawSubKey
 * @returns {{ allowed: boolean, normalizedRoot: string, normalizedSubKey: string, reason?: string }}
 */
function isAllowedGogRegistryTarget(rawRoot, rawSubKey) {
  const normalizedRoot = String(rawRoot || 'HKLM')
    .trim()
    .toUpperCase();
  if (!ALLOWED_REGISTRY_HIVES.has(normalizedRoot)) {
    return {
      allowed: false,
      normalizedRoot,
      normalizedSubKey: '',
      reason: `disallowed_hive:${normalizedRoot}`,
    };
  }

  if (typeof rawSubKey !== 'string' || !rawSubKey.trim() || rawSubKey.length > 512) {
    return {
      allowed: false,
      normalizedRoot,
      normalizedSubKey: '',
      reason: 'empty_or_oversized_subkey',
    };
  }
  if (hasForbiddenSectionOrControlChars(rawSubKey)) {
    return {
      allowed: false,
      normalizedRoot,
      normalizedSubKey: '',
      reason: 'forbidden_chars_in_subkey',
    };
  }

  const normalizedSubKey = rawSubKey
    .trim()
    .replace(/\//g, '\\')
    .replace(/^\\+|\\+$/g, '')
    .replace(/\\+/g, '\\');
  if (!normalizedSubKey) {
    return {
      allowed: false,
      normalizedRoot,
      normalizedSubKey: '',
      reason: 'empty_subkey',
    };
  }

  const segments = normalizedSubKey.split('\\');
  const lowerSegments = segments.map((s) => s.trim().toLowerCase());
  if (
    lowerSegments.length < 2 ||
    lowerSegments[0] !== 'software' ||
    lowerSegments.some((s) => !s || s === '.' || s === '..')
  ) {
    return {
      allowed: false,
      normalizedRoot,
      normalizedSubKey,
      reason: 'outside_software_allowlist',
    };
  }

  // Strip leading `Software` and optional `Wow6432Node` to inspect the vendor/game scope.
  const scopeSegments =
    lowerSegments[1] === 'wow6432node' ? lowerSegments.slice(2) : lowerSegments.slice(1);
  if (scopeSegments.length < 1) {
    return {
      allowed: false,
      normalizedRoot,
      normalizedSubKey,
      reason: 'missing_vendor_scope',
    };
  }

  // Explicit denylist check on every path segment (case-insensitive)
  for (const seg of lowerSegments) {
    if (DENIED_REGISTRY_SEGMENTS.has(seg)) {
      return {
        allowed: false,
        normalizedRoot,
        normalizedSubKey,
        reason: `denied_segment:${seg}`,
      };
    }
  }

  // Block OS-owned subtrees under `Software\Microsoft\...` while still permitting game-scoped
  // keys such as `Software\Microsoft\Microsoft Games\...` and `Software\Microsoft\DirectPlay\...`.
  if (scopeSegments[0] === 'microsoft') {
    const msSub = scopeSegments[1] || '';
    if (!msSub || DENIED_MICROSOFT_SUBTREES.has(msSub)) {
      return {
        allowed: false,
        normalizedRoot,
        normalizedSubKey,
        reason: `denied_microsoft_subtree:${msSub || 'root'}`,
      };
    }
  }

  // `Software\GOG.com\...` must stay scoped to `Games\...` (or explicit game product node)
  if (scopeSegments[0] === 'gog.com' && scopeSegments.length >= 2) {
    if (scopeSegments[1] !== 'games' && scopeSegments[1] !== 'galaxy') {
      return {
        allowed: false,
        normalizedRoot,
        normalizedSubKey,
        reason: `disallowed_gog_subtree:${scopeSegments[1]}`,
      };
    }
  }

  return { allowed: true, normalizedRoot, normalizedSubKey };
}

/**
 * Verifies BOTH lexical containment AND `lstat` / `realpath` symlink containment inside
 * `hostInstallDir`, rejecting any symbolic link anywhere along the relative path from
 * `hostInstallDir` to `targetPath` (blocking symlink escape and destination symlink overwrites).
 *
 * @param {string} hostInstallDir
 * @param {string} targetPath
 * @param {{ allowMissingLeaf?: boolean }} [opts]
 * @returns {boolean}
 */
function isRealPathContainedWithinRoot(hostInstallDir, targetPath, opts = {}) {
  if (!hostInstallDir || !targetPath) return false;
  if (!isContainedWithinRoot(hostInstallDir, targetPath, process.platform)) {
    return false;
  }

  let realRoot = '';
  try {
    const rootLstat = fs.lstatSync(hostInstallDir);
    if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
      return false;
    }
    realRoot = fs.realpathSync(hostInstallDir);
  } catch {
    return false;
  }

  const resolvedRoot = path.resolve(hostInstallDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel === '') {
    return true;
  }
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return false;
  }

  const parts = rel.split(path.sep).filter(Boolean);
  let cursor = resolvedRoot;
  let deepestExisting = resolvedRoot;
  let encounteredMissing = false;

  for (let i = 0; i < parts.length; i += 1) {
    cursor = path.join(cursor, parts[i]);
    if (encounteredMissing) {
      continue;
    }
    try {
      const lst = fs.lstatSync(cursor);
      if (lst.isSymbolicLink()) {
        return false;
      }
      deepestExisting = cursor;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
      if (code === 'ENOENT') {
        if (!opts.allowMissingLeaf) {
          return false;
        }
        encounteredMissing = true;
      } else {
        return false;
      }
    }
  }

  try {
    const realExisting = fs.realpathSync(deepestExisting);
    return isContainedWithinRoot(realRoot, realExisting, process.platform);
  } catch {
    return false;
  }
}

/**
 * Discover `goggame-*.script` files inside `hostInstallDir` and bounded support subdirectories.
 *
 * @param {string} hostInstallDir
 * @returns {Array<{ scriptPath: string, productId: string, rawContent: string }>}
 */
function discoverGogScriptFiles(hostInstallDir) {
  /** @type {Array<{ scriptPath: string, productId: string, rawContent: string }>} */
  const found = [];
  const seenPaths = new Set();
  const candidateDirs = [
    hostInstallDir,
    path.join(hostInstallDir, '__support'),
    path.join(hostInstallDir, '__gog_support'),
    path.join(hostInstallDir, 'support'),
  ];

  /** @param {string} dirPath */
  const scanSingleDir = (dirPath) => {
    try {
      if (!isRealPathContainedWithinRoot(hostInstallDir, dirPath, { allowMissingLeaf: false })) {
        return;
      }
      if (!fs.statSync(dirPath).isDirectory()) return;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true }).slice(0, 96);
      for (const dirent of entries) {
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isFile()) {
          const m = dirent.name.match(/^goggame-(\d+)\.script$/i);
          if (!m) continue;
          const full = path.join(dirPath, dirent.name);
          const resolved = path.resolve(full);
          if (seenPaths.has(resolved)) continue;
          if (!isRealPathContainedWithinRoot(hostInstallDir, resolved, { allowMissingLeaf: false })) {
            continue;
          }
          const st = fs.lstatSync(resolved);
          if (st.isSymbolicLink() || !st.isFile() || st.size <= 0 || st.size > 2 * 1024 * 1024) {
            continue;
          }
          const rawContent = fs.readFileSync(resolved, 'utf8');
          seenPaths.add(resolved);
          found.push({ scriptPath: resolved, productId: m[1], rawContent });
        }
      }
    } catch {}
  };

  for (const dir of candidateDirs) {
    scanSingleDir(dir);
    if (dir !== hostInstallDir) {
      try {
        if (
          isRealPathContainedWithinRoot(hostInstallDir, dir, { allowMissingLeaf: false }) &&
          fs.statSync(dir).isDirectory()
        ) {
          const subDirs = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 32);
          for (const sub of subDirs) {
            if (sub.isSymbolicLink()) continue;
            if (sub.isDirectory()) {
              scanSingleDir(path.join(dir, sub.name));
            }
          }
        }
      } catch {}
    }
  }

  found.sort((a, b) => a.scriptPath.localeCompare(b.scriptPath));
  return found;
}

/**
 * Read preferred language metadata from `goggame-<productId>.info` when present.
 *
 * @param {string} hostInstallDir
 * @param {string} productId
 * @param {string} [explicitLanguage]
 */
function resolveGogScriptLanguageTokens(hostInstallDir, productId, explicitLanguage = '') {
  let languageName = 'english';
  let languageCode = 'en-US';
  if (explicitLanguage && typeof explicitLanguage === 'string' && explicitLanguage.trim()) {
    const clean = explicitLanguage.trim();
    const mapped = LANGUAGE_ISO_FALLBACK_MAP[clean.toLowerCase()];
    if (mapped) {
      languageCode = mapped;
      languageName = clean.length > 3 ? clean.toLowerCase() : languageName;
    } else if (/^[a-z]{2}-[a-z]{2}$/i.test(clean)) {
      languageCode = clean;
    } else {
      languageName = clean;
    }
  } else {
    const infoCandidates = [
      productId ? path.join(hostInstallDir, `goggame-${productId}.info`) : '',
    ].filter(Boolean);
    try {
      const rootEntries = fs.readdirSync(hostInstallDir).slice(0, 64);
      for (const name of rootEntries) {
        if (/^goggame-\d+\.info$/i.test(name)) {
          const p = path.join(hostInstallDir, name);
          if (!infoCandidates.includes(p)) infoCandidates.push(p);
        }
      }
    } catch {}
    for (const infoPath of infoCandidates) {
      try {
        if (!isRealPathContainedWithinRoot(hostInstallDir, infoPath, { allowMissingLeaf: false })) {
          continue;
        }
        const parsed = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        if (typeof parsed?.language === 'string' && parsed.language.trim()) {
          languageName = parsed.language.trim();
        }
        if (Array.isArray(parsed?.languages) && typeof parsed.languages[0] === 'string') {
          languageCode = parsed.languages[0].trim() || languageCode;
        } else {
          const mapped = LANGUAGE_ISO_FALLBACK_MAP[languageName.toLowerCase()];
          if (mapped) languageCode = mapped;
        }
        break;
      } catch {}
    }
  }
  const shortLang = languageCode.split(/[-_]/)[0].toLowerCase() || 'en';
  return {
    language: languageName,
    languageCode,
    lang: shortLang,
  };
}

/**
 * Expand `{app}`, `{support}`, `{supportDir}`, `{language}`, `{languageCode}`, and `{lang}`
 * inside a registry or INI value string using target Windows path conventions.
 * Uses function replacers so `$` sequences in paths (e.g. `C:\Games\$Title`) are never corrupted.
 *
 * @param {string} rawTemplate
 * @param {{ winAppPath: string, winSupportPath: string, language: string, languageCode: string, lang: string, productId: string }} ctx
 * @returns {string}
 */
function expandGogValueStringTokens(rawTemplate, ctx) {
  if (typeof rawTemplate !== 'string' || !rawTemplate) {
    return String(rawTemplate ?? '');
  }
  return rawTemplate
    .replace(/\{app\}/gi, () => ctx.winAppPath)
    .replace(/\{supportDir\}/gi, () => ctx.winSupportPath)
    .replace(/\{support\}/gi, () => ctx.winSupportPath)
    .replace(/\{productId\}/gi, () => ctx.productId || '')
    .replace(/\{languageCode\}/gi, () => ctx.languageCode)
    .replace(/\{language\}/gi, () => ctx.language)
    .replace(/\{lang\}/gi, () => ctx.lang);
}

/**
 * Resolve a filesystem `{support}` / `{supportDir}` / `{app}` relative path strictly inside `hostInstallDir`
 * with both lexical and `lstat`/`realpath` symlink containment.
 *
 * @param {string} hostInstallDir
 * @param {string} rawPathExpr
 * @param {string} productId
 * @param {boolean} mustExist
 * @returns {string}
 */
function resolveContainedGogFsPath(hostInstallDir, rawPathExpr, productId, mustExist) {
  if (typeof rawPathExpr !== 'string' || !rawPathExpr.trim() || hasNewlineOrNull(rawPathExpr)) {
    return '';
  }
  const supportRoots = [
    productId ? path.join(hostInstallDir, '__support', productId) : '',
    path.join(hostInstallDir, '__support', 'app'),
    path.join(hostInstallDir, '__support'),
    productId ? path.join(hostInstallDir, '__gog_support', productId) : '',
    path.join(hostInstallDir, '__gog_support'),
    productId ? path.join(hostInstallDir, 'support', productId) : '',
    path.join(hostInstallDir, 'support'),
    hostInstallDir,
  ].filter(Boolean);

  const trimmed = rawPathExpr.trim();
  const usesSupportToken = /\{support(?:Dir)?\}/i.test(trimmed);
  const strippedRel = trimmed
    .replace(/^\{app\}[\\/]?/i, '')
    .replace(/^\{support(?:Dir)?\}[\\/]?/i, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');

  if (!strippedRel) {
    if (usesSupportToken) {
      for (const sr of supportRoots) {
        if (
          isRealPathContainedWithinRoot(hostInstallDir, sr, { allowMissingLeaf: !mustExist }) &&
          (!mustExist || fs.existsSync(sr))
        ) {
          return sr;
        }
      }
    }
    return isRealPathContainedWithinRoot(hostInstallDir, hostInstallDir, { allowMissingLeaf: false })
      ? hostInstallDir
      : '';
  }

  if (strippedRel.split('/').some((seg) => seg === '..')) {
    return '';
  }

  const candidateBases = usesSupportToken ? supportRoots : [hostInstallDir, ...supportRoots];
  for (const base of candidateBases) {
    if (!isRealPathContainedWithinRoot(hostInstallDir, base, { allowMissingLeaf: !mustExist })) {
      continue;
    }
    if (mustExist) {
      const existing = resolveCaseInsensitiveRelFile(base, strippedRel);
      if (
        existing &&
        isRealPathContainedWithinRoot(hostInstallDir, existing, { allowMissingLeaf: false })
      ) {
        return existing;
      }
      const dirCand = path.resolve(base, ...strippedRel.split('/').filter(Boolean));
      if (
        isRealPathContainedWithinRoot(hostInstallDir, dirCand, { allowMissingLeaf: false }) &&
        fs.existsSync(dirCand)
      ) {
        return dirCand;
      }
    } else {
      const targetCand = path.resolve(base, ...strippedRel.split('/').filter(Boolean));
      if (isRealPathContainedWithinRoot(hostInstallDir, targetCand, { allowMissingLeaf: true })) {
        return targetCand;
      }
    }
  }
  return '';
}

/**
 * Given a source DLL path (e.g. `.../add/winmm.dll`), check whether a modern Windows 10/11
 * sibling variant (`<stem>_w10.dll` or `<stem>_win10.dll`) exists alongside it and should be
 * preferred over a legacy XP/Win7 proxy DLL with malformed backslash export forwarders.
 *
 * @param {string} srcFilePath
 * @returns {string}
 */
function selectCompatibleWin10SiblingDll(srcFilePath) {
  if (!srcFilePath || !/\.dll$/i.test(srcFilePath)) {
    return srcFilePath;
  }
  const dir = path.dirname(srcFilePath);
  const ext = path.extname(srcFilePath);
  const stem = path.basename(srcFilePath, ext);
  if (/_(?:w10|win10)$/i.test(stem)) {
    return srcFilePath;
  }
  const siblingNames = [`${stem}_w10${ext}`, `${stem}_win10${ext}`];
  for (const sibName of siblingNames) {
    const resolvedSib = resolveCaseInsensitiveRelFile(dir, sibName);
    if (resolvedSib && !hasMalformedBackslashExportForwarder(resolvedSib)) {
      return resolvedSib;
    }
  }
  return srcFilePath;
}

/**
 * Copy a single support file or directory tree strictly within `hostInstallDir`, verifying
 * `lstat` + `realpath` symlink containment on both source and destination entries and
 * automatically substituting `<stem>_w10.dll` when staging `<stem>.dll` from a support folder.
 *
 * @param {string} hostInstallDir
 * @param {string} srcPath
 * @param {string} destPath
 * @param {boolean} [overwrite]
 * @returns {number}
 */
function copyContainedSupportEntry(hostInstallDir, srcPath, destPath, overwrite = true) {
  if (
    !srcPath ||
    !destPath ||
    !isRealPathContainedWithinRoot(hostInstallDir, srcPath, { allowMissingLeaf: false }) ||
    !isRealPathContainedWithinRoot(hostInstallDir, destPath, { allowMissingLeaf: true })
  ) {
    return 0;
  }
  let srcStat;
  try {
    srcStat = fs.lstatSync(srcPath);
  } catch {
    return 0;
  }
  if (srcStat.isSymbolicLink()) {
    return 0;
  }
  if (srcStat.isFile()) {
    let finalDest = destPath;
    try {
      const destLstat = fs.lstatSync(destPath);
      if (destLstat.isSymbolicLink()) {
        return 0;
      }
      if (destLstat.isDirectory()) {
        finalDest = path.join(destPath, path.basename(srcPath));
      }
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') {
        return 0;
      }
    }
    if (!isRealPathContainedWithinRoot(hostInstallDir, finalDest, { allowMissingLeaf: true })) {
      return 0;
    }
    try {
      const finalDestLstat = fs.lstatSync(finalDest);
      if (finalDestLstat.isSymbolicLink()) {
        return 0;
      }
      if (!overwrite && !hasMalformedBackslashExportForwarder(finalDest)) {
        return 0;
      }
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') {
        return 0;
      }
    }
    const effectiveSrc = selectCompatibleWin10SiblingDll(srcPath);
    if (!isRealPathContainedWithinRoot(hostInstallDir, effectiveSrc, { allowMissingLeaf: false })) {
      return 0;
    }
    try {
      const effStat = fs.lstatSync(effectiveSrc);
      if (effStat.isSymbolicLink() || !effStat.isFile()) {
        return 0;
      }
    } catch {
      return 0;
    }
    if (path.resolve(effectiveSrc) === path.resolve(finalDest)) {
      return 0;
    }
    const destParent = path.dirname(finalDest);
    if (!isRealPathContainedWithinRoot(hostInstallDir, destParent, { allowMissingLeaf: true })) {
      return 0;
    }
    fs.mkdirSync(destParent, { recursive: true });
    if (!isRealPathContainedWithinRoot(hostInstallDir, finalDest, { allowMissingLeaf: true })) {
      return 0;
    }
    fs.copyFileSync(effectiveSrc, finalDest);
    return 1;
  }

  if (srcStat.isDirectory()) {
    let copied = 0;
    if (!isRealPathContainedWithinRoot(hostInstallDir, destPath, { allowMissingLeaf: true })) {
      return 0;
    }
    fs.mkdirSync(destPath, { recursive: true });
    if (!isRealPathContainedWithinRoot(hostInstallDir, destPath, { allowMissingLeaf: false })) {
      return 0;
    }
    const entries = fs.readdirSync(srcPath, { withFileTypes: true }).slice(0, 256);
    for (const dirent of entries) {
      if (dirent.isSymbolicLink()) continue;
      // Skip copying raw `*_w10.dll` helper variants as standalone filenames when `<stem>.dll` is also present
      if (dirent.isFile() && /_(?:w10|win10)\.dll$/i.test(dirent.name)) {
        const baseDllName = dirent.name.replace(/_(?:w10|win10)(\.dll)$/i, '$1');
        if (resolveCaseInsensitiveRelFile(srcPath, baseDllName)) {
          continue;
        }
      }
      copied += copyContainedSupportEntry(
        hostInstallDir,
        path.join(srcPath, dirent.name),
        path.join(destPath, dirent.name),
        overwrite
      );
    }
    return copied;
  }
  return 0;
}

/**
 * Self-heal any top-level proxy `.dll` in `hostInstallDir` that contains a malformed backslash
 * export forwarder when a clean `<stem>_w10.dll` / `<stem>_win10.dll` exists in `add/` or `__support/`.
 * Enforces `lstat` + `realpath` symlink containment on both destination and donor DLLs.
 *
 * @param {string} hostInstallDir
 * @returns {number}
 */
function healMalformedTopLevelProxyDlls(hostInstallDir) {
  let healed = 0;
  if (!isRealPathContainedWithinRoot(hostInstallDir, hostInstallDir, { allowMissingLeaf: false })) {
    return 0;
  }
  const donorDirs = [
    path.join(hostInstallDir, 'add'),
    path.join(hostInstallDir, '__support', 'add'),
    path.join(hostInstallDir, '__gog_support', 'add'),
    path.join(hostInstallDir, 'support', 'add'),
  ];
  try {
    const rootEntries = fs.readdirSync(hostInstallDir, { withFileTypes: true }).slice(0, 128);
    for (const dirent of rootEntries) {
      if (dirent.isSymbolicLink() || !dirent.isFile() || !/\.dll$/i.test(dirent.name)) continue;
      const topDllPath = path.join(hostInstallDir, dirent.name);
      if (!isRealPathContainedWithinRoot(hostInstallDir, topDllPath, { allowMissingLeaf: false })) {
        continue;
      }
      const topLstat = fs.lstatSync(topDllPath);
      if (topLstat.isSymbolicLink() || !topLstat.isFile()) continue;
      if (!hasMalformedBackslashExportForwarder(topDllPath)) continue;

      const ext = path.extname(dirent.name);
      const stem = path.basename(dirent.name, ext);
      let replacement = selectCompatibleWin10SiblingDll(topDllPath);
      if (
        replacement !== topDllPath &&
        !isRealPathContainedWithinRoot(hostInstallDir, replacement, { allowMissingLeaf: false })
      ) {
        replacement = topDllPath;
      }
      if (replacement === topDllPath) {
        for (const dDir of donorDirs) {
          if (!isRealPathContainedWithinRoot(hostInstallDir, dDir, { allowMissingLeaf: false })) {
            continue;
          }
          const candW10 =
            resolveCaseInsensitiveRelFile(dDir, `${stem}_w10${ext}`) ||
            resolveCaseInsensitiveRelFile(dDir, `${stem}_win10${ext}`);
          if (
            candW10 &&
            isRealPathContainedWithinRoot(hostInstallDir, candW10, { allowMissingLeaf: false }) &&
            !hasMalformedBackslashExportForwarder(candW10)
          ) {
            replacement = candW10;
            break;
          }
        }
      }
      if (
        replacement &&
        replacement !== topDllPath &&
        isRealPathContainedWithinRoot(hostInstallDir, replacement, { allowMissingLeaf: false }) &&
        isRealPathContainedWithinRoot(hostInstallDir, topDllPath, { allowMissingLeaf: false })
      ) {
        const repLstat = fs.lstatSync(replacement);
        if (!repLstat.isSymbolicLink() && repLstat.isFile()) {
          fs.copyFileSync(replacement, topDllPath);
          healed += 1;
        }
      }
    }
  } catch {}
  return healed;
}

/**
 * Normalize a raw binary hex string (`"01 02 0a ff"` or `"hex:01,02"`) into clean hex byte pairs.
 *
 * @param {any} rawData
 * @returns {string[]}
 */
function parseRegistryBinaryHexPairs(rawData) {
  const cleaned = String(rawData ?? '')
    .trim()
    .replace(/^hex:/i, '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  if (!cleaned) return [];
  const even = cleaned.length % 2 === 0 ? cleaned : `0${cleaned}`;
  const pairs = [];
  for (let i = 0; i < even.length; i += 2) {
    pairs.push(even.slice(i, i + 2));
  }
  return pairs;
}

/**
 * Safely parses a GOG script `qword` / `REG_QWORD` `valueData` into an unsigned 64-bit `BigInt`
 * without throwing `SyntaxError` / `RangeError` on hex whitespace, floats, or malformed strings
 * (`Finding #17`).
 *
 * @param {unknown} rawValueData
 * @returns {bigint}
 */
function parseSafeRegistryQwordBigInt(rawValueData) {
  if (typeof rawValueData === 'bigint') {
    return BigInt.asUintN(64, rawValueData);
  }
  if (typeof rawValueData === 'number') {
    if (!Number.isFinite(rawValueData)) return 0n;
    return BigInt.asUintN(64, BigInt(Math.trunc(rawValueData)));
  }
  const str = String(rawValueData ?? '').trim();
  if (!str) return 0n;
  try {
    if (/^[+-]?0[xX][0-9a-fA-F_]+$/.test(str)) {
      const cleanedHex = str.replace(/_/g, '');
      const sign = cleanedHex.startsWith('-') ? -1n : 1n;
      const body = cleanedHex.replace(/^[+-]/, '');
      return BigInt.asUintN(64, sign * BigInt(body));
    }
    if (/^[+-]?\d+$/.test(str)) {
      return BigInt.asUintN(64, BigInt(str));
    }
    if (/^[+-]?\d+\.\d+$/.test(str)) {
      const num = Number(str);
      if (Number.isFinite(num)) {
        return BigInt.asUintN(64, BigInt(Math.trunc(num)));
      }
    }
  } catch (err) {
    diagLog.debug('gogScript.invalidQwordValueData', { valueData: str.slice(0, 64), err });
  }
  return 0n;
}

/**
 * Pure helper that applies raw section entries (`@=...` or `hex:...`) to an in-memory Wine `.reg` string.
 * Rejects CR/LF/NUL and section-header bracket injection in subkeys, value names, and RHS data.
 *
 * @param {string} content
 * @param {string} subKeyPath
 * @param {Array<{ valueName: string, rawRegRhs: string }>} rawEntries
 * @param {number} unixSec
 * @returns {{ content: string, normalizedSubKey: string, liveSyncPairs: Array<[string, any]> }}
 */
function applyRawSectionPatchToContent(content, subKeyPath, rawEntries, unixSec) {
  if (typeof subKeyPath !== 'string' || hasForbiddenSectionOrControlChars(subKeyPath)) {
    return { content, normalizedSubKey: '', liveSyncPairs: [] };
  }
  const normalizedSubKey = subKeyPath.trim().replace(/^\\+|\\+$/g, '').replace(/\\+/g, '\\');
  if (!normalizedSubKey) {
    return { content, normalizedSubKey: '', liveSyncPairs: [] };
  }

  const safeEntries = rawEntries.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const vName = item.valueName === undefined || item.valueName === null ? '' : String(item.valueName);
    const rhs = item.rawRegRhs === undefined || item.rawRegRhs === null ? '' : String(item.rawRegRhs);
    if (vName && hasForbiddenSectionOrControlChars(vName)) return false;
    if (hasNewlineOrNull(rhs) || hasUnescapedSectionBracket(rhs)) return false;
    return true;
  });
  if (safeEntries.length === 0) {
    return { content, normalizedSubKey, liveSyncPairs: [] };
  }

  const escapedSectionPath = normalizedSubKey.replace(/\\/g, '\\\\');
  const sectionHeaderRe = new RegExp(
    `^\\[${escapeRegExp(escapedSectionPath)}\\](?:\\s+\\d+)?[^\\r\\n]*$`,
    'im'
  );
  const match = sectionHeaderRe.exec(content);
  const formatLine = (/** @type {{ valueName: string, rawRegRhs: string }} */ item) => {
    if (!item.valueName || item.valueName === '@') {
      return `@=${item.rawRegRhs}`;
    }
    return `"${escapeWineRegString(item.valueName)}"=${item.rawRegRhs}`;
  };

  /** @type {Array<[string, any]>} */
  const liveSyncPairs = safeEntries.map((item) => [
    !item.valueName || item.valueName === '@' ? '@' : String(item.valueName),
    { rawRegRhs: item.rawRegRhs },
  ]);

  if (!match) {
    const lines = safeEntries.map(formatLine).join('\n');
    const sep = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    return {
      content: `${content}${sep}[${escapedSectionPath}] ${unixSec}\n${lines}\n`,
      normalizedSubKey,
      liveSyncPairs,
    };
  }

  const headerEnd = match.index + match[0].length;
  const afterHeader = content.slice(headerEnd);
  const nextSectionMatch = /^\[[^\]]+\]/m.exec(afterHeader);
  const body = nextSectionMatch ? afterHeader.slice(0, nextSectionMatch.index) : afterHeader;
  const rest = nextSectionMatch ? afterHeader.slice(nextSectionMatch.index) : '';
  const bodyLines = body.split(/\r?\n/);

  for (const item of safeEntries) {
    const formatted = formatLine(item);
    const isDefault = !item.valueName || item.valueName === '@';
    let replaced = false;
    for (let i = 0; i < bodyLines.length; i += 1) {
      const line = bodyLines[i];
      if (isDefault && /^\s*@=/.test(line)) {
        bodyLines[i] = formatted;
        replaced = true;
        break;
      }
      if (!isDefault) {
        const kvMatch = line.match(/^\s*"((?:[^"\\]|\\.)+)"\s*=/);
        if (kvMatch) {
          const unescaped = kvMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          if (unescaped.toLowerCase() === item.valueName.toLowerCase()) {
            bodyLines[i] = formatted;
            replaced = true;
            break;
          }
        }
      }
    }
    if (!replaced) {
      let insertIdx = bodyLines.length;
      while (insertIdx > 0 && bodyLines[insertIdx - 1].trim() === '') {
        insertIdx -= 1;
      }
      bodyLines.splice(insertIdx, 0, formatted);
    }
  }

  let rebuiltBody = bodyLines.join('\n');
  if (!rebuiltBody.startsWith('\n')) rebuiltBody = `\n${rebuiltBody}`;
  if (rest && !rebuiltBody.endsWith('\n\n')) {
    rebuiltBody = rebuiltBody.endsWith('\n') ? `${rebuiltBody}\n` : `${rebuiltBody}\n\n`;
  } else if (!rest && !rebuiltBody.endsWith('\n')) {
    rebuiltBody = `${rebuiltBody}\n`;
  }

  return {
    content: content.slice(0, match.index) + `[${escapedSectionPath}] ${unixSec}` + rebuiltBody + rest,
    normalizedSubKey,
    liveSyncPairs,
  };
}

/**
 * Batches multiple raw Wine `.reg` section mutations into a single file read + single atomic write
 * (`Finding #17`), enforcing registry allowlist/denylist & CR/LF/bracket injection rejection (`P0-02`).
 *
 * @param {string} regFilePath
 * @param {Array<{ subKeyPath: string, valueName: string, rawRegRhs: string }>} rawPatchItems
 * @param {Record<string, any>} [options]
 */
function patchRawWineRegistrySectionsBatch(regFilePath, rawPatchItems, options = {}) {
  if (!regFilePath || !Array.isArray(rawPatchItems) || rawPatchItems.length === 0) {
    return;
  }
  /** @type {'HKEY_CURRENT_USER' | 'HKEY_LOCAL_MACHINE'} */
  const hiveName =
    path.basename(regFilePath).toLowerCase() === 'user.reg'
      ? 'HKEY_CURRENT_USER'
      : 'HKEY_LOCAL_MACHINE';
  let content = '';
  try {
    if (fs.existsSync(regFilePath)) {
      content = fs.readFileSync(regFilePath, 'utf8');
    }
  } catch {
    return;
  }
  if (!content.trim()) {
    content =
      hiveName === 'HKEY_CURRENT_USER'
        ? 'WINE REGISTRY Version 2\n;; All keys relative to \\\\User\\\\S-1-5-21-0-0-0-1000\n\n#arch=win64\n'
        : 'WINE REGISTRY Version 2\n;; All keys relative to \\\\Machine\n\n#arch=win64\n';
    try {
      fs.mkdirSync(path.dirname(regFilePath), { recursive: true });
    } catch {}
  }

  /** @type {Map<string, Array<{ valueName: string, rawRegRhs: string }>>} */
  const groupedBySubKey = new Map();
  for (const patch of rawPatchItems) {
    if (!patch || !patch.subKeyPath) continue;
    const verdict = isAllowedGogRegistryTarget(hiveName, patch.subKeyPath);
    if (!verdict.allowed) {
      diagLog.warn('gogScript.blockedRegistryRawPatch', {
        hive: hiveName,
        reason: verdict.reason,
      });
      continue;
    }
    const vName =
      patch.valueName === undefined || patch.valueName === null ? '' : String(patch.valueName);
    const rhs =
      patch.rawRegRhs === undefined || patch.rawRegRhs === null ? '' : String(patch.rawRegRhs);
    if (
      (vName &&
        (hasForbiddenSectionOrControlChars(vName) ||
          DENIED_REGISTRY_VALUE_NAMES.has(vName.trim().toLowerCase()))) ||
      hasNewlineOrNull(rhs) ||
      hasUnescapedSectionBracket(rhs)
    ) {
      diagLog.warn('gogScript.blockedRegistryInjection', {
        hive: hiveName,
        reason: 'forbidden_value_or_rhs',
      });
      continue;
    }
    const normKey = verdict.normalizedSubKey;
    let bucket = groupedBySubKey.get(normKey);
    if (!bucket) {
      bucket = [];
      groupedBySubKey.set(normKey, bucket);
    }
    bucket.push({ valueName: vName, rawRegRhs: rhs });
  }
  if (groupedBySubKey.size === 0) return;

  const unixSec = Math.floor(Date.now() / 1000);
  /** @type {Array<{ hiveName: 'HKEY_CURRENT_USER' | 'HKEY_LOCAL_MACHINE', normalizedSubKey: string, entryPairsOrNullForDelete: Array<[string, any]> }>} */
  const liveBatch = [];

  for (const [subKeyPath, entries] of groupedBySubKey.entries()) {
    const applied = applyRawSectionPatchToContent(content, subKeyPath, entries, unixSec);
    if (!applied.liveSyncPairs.length) continue;
    content = applied.content;
    liveBatch.push({
      hiveName,
      normalizedSubKey: applied.normalizedSubKey,
      entryPairsOrNullForDelete: applied.liveSyncPairs,
    });
  }
  if (liveBatch.length === 0) return;

  atomicWriteFileSync(regFilePath, content);

  if (options && Array.isArray(options.liveSyncAccumulator)) {
    options.liveSyncAccumulator.push(...liveBatch);
  } else {
    const bottlePath =
      typeof options?.bottlePath === 'string' && options.bottlePath
        ? options.bottlePath
        : path.dirname(regFilePath);
    if (bottlePath && options?.skipLiveWineRegSync !== true) {
      syncLiveWineRegistryBatchAsync(bottlePath, hiveName, liveBatch, options).catch(() => {});
    }
  }
}

/**
 * Patch `hex:...` (`REG_BINARY`) or default `@=...` entries directly into a Wine `.reg` file section.
 *
 * @param {string} regFilePath
 * @param {string} subKeyPath
 * @param {Array<{ valueName: string, rawRegRhs: string }>} rawEntries
 * @param {Record<string, any>} [options]
 */
function patchRawWineRegistrySectionLines(regFilePath, subKeyPath, rawEntries, options = {}) {
  if (!regFilePath || !subKeyPath || !Array.isArray(rawEntries) || rawEntries.length === 0) {
    return;
  }
  patchRawWineRegistrySectionsBatch(
    regFilePath,
    rawEntries.map((item) => ({
      subKeyPath,
      valueName: item.valueName,
      rawRegRhs: item.rawRegRhs,
    })),
    options
  );
}

/**
 * Execute an asynchronous `reg.exe add` command on Windows (`win32`) without blocking the event loop
 * and without triggering UAC elevation dialogs.
 *
 * @param {string[]} regArgs
 * @param {Record<string, any>} options
 * @returns {Promise<boolean>}
 */
function runWindowsRegAddAsync(regArgs, options = {}) {
  const isVitest = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
  const execFileImpl =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  if (isVitest && execFileImpl === execFile && !options.allowRealWinRegInTest) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    try {
      execFileImpl(
        'reg.exe',
        regArgs,
        { encoding: 'utf8', timeout: 4000, windowsHide: true },
        (/** @type {Error | null} */ err) => {
          resolve(!err);
        }
      );
    } catch {
      resolve(false);
    }
  });
}

/**
 * Upsert a single `[Section]` `key=value` entry inside an INI file strictly contained within
 * `hostInstallDir` (enforcing `lstat`+`realpath` containment and rejecting CR/LF/NUL/bracket injection).
 *
 * @param {string} hostInstallDir
 * @param {string} targetIniPath
 * @param {string} sectionName
 * @param {string} keyName
 * @param {string} valueStr
 * @returns {boolean}
 */
function upsertContainedIniValue(hostInstallDir, targetIniPath, sectionName, keyName, valueStr) {
  if (
    !targetIniPath ||
    !keyName ||
    !isRealPathContainedWithinRoot(hostInstallDir, targetIniPath, { allowMissingLeaf: true })
  ) {
    return false;
  }

  const rawSection = String(sectionName ?? '');
  const rawKey = String(keyName ?? '');
  const rawValue = String(valueStr ?? '');
  if (
    hasForbiddenSectionOrControlChars(rawSection) ||
    hasForbiddenSectionOrControlChars(rawKey) ||
    rawKey.includes('=') ||
    hasNewlineOrNull(rawValue) ||
    hasUnescapedSectionBracket(rawValue)
  ) {
    diagLog.warn('gogScript.blockedIniInjection', { reason: 'forbidden_ini_chars' });
    return false;
  }

  const cleanSection = rawSection.trim();
  const cleanKey = rawKey.trim();
  if (!cleanKey) {
    return false;
  }

  let existing = '';
  try {
    const lst = fs.lstatSync(targetIniPath);
    if (lst.isSymbolicLink() || !lst.isFile() || lst.size > 1024 * 1024) {
      return false;
    }
    existing = fs.readFileSync(targetIniPath, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') {
      return false;
    }
    existing = '';
  }

  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const newLine = `${cleanKey}=${rawValue}`;

  if (!cleanSection) {
    const keyRe = new RegExp(`^\\s*${escapeRegExp(cleanKey)}\\s*=`, 'i');
    const idx = lines.findIndex((l) => keyRe.test(l));
    if (idx >= 0) {
      lines[idx] = newLine;
    } else {
      lines.push(newLine);
    }
    atomicWriteFileSync(targetIniPath, lines.join(eol));
    return true;
  }

  const secRe = new RegExp(`^\\s*\\[${escapeRegExp(cleanSection)}\\]\\s*$`, 'i');
  const keyRe = new RegExp(`^\\s*${escapeRegExp(cleanKey)}\\s*=`, 'i');
  const secIdx = lines.findIndex((l) => secRe.test(l));
  if (secIdx < 0) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
      lines.push('');
    }
    lines.push(`[${cleanSection}]`, newLine);
    atomicWriteFileSync(targetIniPath, `${lines.join(eol)}${eol}`);
    return true;
  }

  let nextSecIdx = lines.length;
  for (let i = secIdx + 1; i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      nextSecIdx = i;
      break;
    }
  }
  let updated = false;
  for (let i = secIdx + 1; i < nextSecIdx; i += 1) {
    if (keyRe.test(lines[i])) {
      lines[i] = newLine;
      updated = true;
      break;
    }
  }
  if (!updated) {
    let insertAt = nextSecIdx;
    while (insertAt > secIdx + 1 && lines[insertAt - 1].trim() === '') {
      insertAt -= 1;
    }
    lines.splice(insertAt, 0, newLine);
  }
  atomicWriteFileSync(targetIniPath, lines.join(eol));
  return true;
}

/**
 * Execute declarative GOG `goggame-*.script` post-install actions (`setRegistry`, `supportData`,
 * `iniFile`) idempotently on both macOS (Bottled CrossOver/Preview/GPTK/Wine) and Windows (`win32` Native).
 *
 * Uses a SHA-256 stamp (`.one_gog_script_applied.json`) checked FIRST before any sync FS scans
 * or proxy-DLL inspection so repeat warm launches short-circuit in `< 1 ms` while automatically
 * re-applying if the user switches bottles or language.
 *
 * @param {string} installDir
 * @param {Record<string, any>} [options]
 */
async function executeGogGameScript(installDir, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const platform = opts.platform || process.platform;
  if (!installDir || typeof installDir !== 'string') {
    return {
      executed: false,
      skippedCached: false,
      scriptsProcessed: 0,
      registryKeysApplied: 0,
      supportFilesStaged: 0,
      iniEntriesApplied: 0,
    };
  }

  const hostInstallDir = path.resolve(toHostFilesystemPath(installDir));
  const rawBottleDir =
    typeof opts.bottleDir === 'string' && opts.bottleDir.trim()
      ? opts.bottleDir.trim()
      : typeof opts.bottlePath === 'string' && opts.bottlePath.trim()
        ? opts.bottlePath.trim()
        : typeof opts.winePrefix === 'string' && opts.winePrefix.trim()
          ? opts.winePrefix.trim()
          : '';
  const hostBottleDir = rawBottleDir ? path.resolve(toHostFilesystemPath(rawBottleDir)) : '';
  const hasActiveBottle = Boolean(hostBottleDir && platform !== 'win32');
  const normalizedLanguageScope =
    typeof opts.language === 'string' ? opts.language.trim().toLowerCase() : '';

  const targetScopeHash = sha256Hex(
    `${platform}:${hasActiveBottle ? hostBottleDir : platform === 'win32' ? 'win32_native' : 'pending_bottle'}:${hostInstallDir}:${normalizedLanguageScope}`
  );
  const stampPath = path.join(hostInstallDir, GOG_SCRIPT_STAMP_FILENAME);

  // Fast-path: check stamp cache FIRST (async, zero directory walks or proxy-DLL PE parsing)
  // so warm launches return in < 1 ms.
  if (opts.force !== true) {
    try {
      const stampLstat = await fs.promises.lstat(stampPath);
      if (!stampLstat.isSymbolicLink() && stampLstat.isFile() && stampLstat.size <= 64 * 1024) {
        const stampRaw = await fs.promises.readFile(stampPath, 'utf8');
        const stamp = JSON.parse(stampRaw);
        if (
          stamp &&
          stamp.version === GOG_SCRIPT_STAMP_VERSION &&
          typeof stamp.scriptsHash === 'string' &&
          stamp.scriptsHash.length === 64 &&
          stamp.targetScopeHash === targetScopeHash
        ) {
          let bottleHivePresent = true;
          if (hasActiveBottle) {
            try {
              await fs.promises.access(path.join(hostBottleDir, 'system.reg'));
            } catch {
              bottleHivePresent = false;
            }
          }
          if (bottleHivePresent) {
            return {
              executed: false,
              skippedCached: true,
              scriptsProcessed: 0,
              registryKeysApplied: 0,
              supportFilesStaged: 0,
              iniEntriesApplied: 0,
            };
          }
        }
      }
    } catch {}
  }

  try {
    const dirLstat = await fs.promises.lstat(hostInstallDir);
    if (dirLstat.isSymbolicLink() || !dirLstat.isDirectory()) {
      return {
        executed: false,
        skippedCached: false,
        scriptsProcessed: 0,
        registryKeysApplied: 0,
        supportFilesStaged: 0,
        iniEntriesApplied: 0,
      };
    }
  } catch {
    return {
      executed: false,
      skippedCached: false,
      scriptsProcessed: 0,
      registryKeysApplied: 0,
      supportFilesStaged: 0,
      iniEntriesApplied: 0,
    };
  }

  // Cold path: heal any top-level proxy DLL whose PE export table has a malformed backslash forwarder
  const healedDllCount = healMalformedTopLevelProxyDlls(hostInstallDir);

  const scriptFiles = discoverGogScriptFiles(hostInstallDir);
  if (scriptFiles.length === 0) {
    return {
      executed: healedDllCount > 0,
      skippedCached: false,
      scriptsProcessed: 0,
      registryKeysApplied: 0,
      supportFilesStaged: healedDllCount,
      iniEntriesApplied: 0,
    };
  }

  const scriptsDigestInput = scriptFiles
    .map((s) => `${path.basename(s.scriptPath)}:${sha256Hex(s.rawContent)}`)
    .join('|');
  const scriptsHash = sha256Hex(scriptsDigestInput);

  let registryKeysApplied = 0;
  let supportFilesStaged = healedDllCount;
  let iniEntriesApplied = 0;

  /** @type {Map<string, Map<string, any>>} */
  const hklmBatchMap = new Map();
  /** @type {Array<{ subKeyPath: string, valueName: string, rawRegRhs: string }>} */
  const hklmRawPatches = [];
  /** @type {Map<string, Map<string, any>>} */
  const hkcuBatchMap = new Map();
  /** @type {Array<{ subKeyPath: string, valueName: string, rawRegRhs: string }>} */
  const hkcuRawPatches = [];
  /** @type {Array<{ args: string[], required: boolean }>} */
  const win32RegCommands = [];

  /**
   * @param {Map<string, Map<string, any>>} targetMap
   * @param {string} subKeyPath
   * @param {string | null | undefined} valueName
   * @param {any} formattedVal
   */
  const queueBottleMapEntry = (targetMap, subKeyPath, valueName, formattedVal) => {
    const normSub = String(subKeyPath || '')
      .trim()
      .replace(/^\\+|\\+$/g, '')
      .replace(/\\+/g, '\\');
    if (!normSub) return;
    if (!targetMap.has(normSub)) {
      targetMap.set(normSub, new Map());
    }
    if (valueName !== null && valueName !== undefined && valueName !== '' && valueName !== '@') {
      const m = targetMap.get(normSub);
      if (m) m.set(String(valueName), formattedVal);
    }
  };

  for (const scriptItem of scriptFiles) {
    let parsedScript = null;
    try {
      parsedScript = JSON.parse(scriptItem.rawContent);
    } catch (err) {
      diagLog.warn('gogScript.invalidJson', err, { productId: scriptItem.productId });
      continue;
    }

    const langTokens = resolveGogScriptLanguageTokens(
      hostInstallDir,
      scriptItem.productId,
      opts.language
    );
    const supportRootFs =
      resolveContainedGogFsPath(hostInstallDir, '{supportDir}', scriptItem.productId, true) ||
      hostInstallDir;

    const winAppPath = hasActiveBottle
      ? toWineWindowsPath(hostInstallDir, hostBottleDir)
      : platform === 'win32'
        ? path.win32.normalize(installDir.replace(/\//g, '\\'))
        : toWineWindowsPath(hostInstallDir, '');
    const winSupportPath = hasActiveBottle
      ? toWineWindowsPath(supportRootFs, hostBottleDir)
      : platform === 'win32'
        ? path.win32.normalize(supportRootFs.replace(/\//g, '\\'))
        : toWineWindowsPath(supportRootFs, '');

    const tokenCtx = {
      winAppPath,
      winSupportPath,
      language: langTokens.language,
      languageCode: langTokens.languageCode,
      lang: langTokens.lang,
      productId: scriptItem.productId,
    };

    const actions = Array.isArray(parsedScript?.actions) ? parsedScript.actions : [];
    for (const actionEntry of actions) {
      if (!actionEntry || typeof actionEntry !== 'object') continue;
      if (Array.isArray(actionEntry.languages) && actionEntry.languages.length > 0) {
        const lowerAllowed = actionEntry.languages.map((/** @type {any} */ l) =>
          String(l || '').toLowerCase()
        );
        const matchesLang =
          lowerAllowed.includes('*') ||
          lowerAllowed.includes(langTokens.languageCode.toLowerCase()) ||
          lowerAllowed.includes(langTokens.language.toLowerCase()) ||
          lowerAllowed.includes(langTokens.lang.toLowerCase()) ||
          lowerAllowed.some((/** @type {string} */ l) =>
            l.startsWith(`${langTokens.lang.toLowerCase()}-`)
          );
        if (!matchesLang) {
          continue;
        }
      }

      const installBlock =
        actionEntry.install && typeof actionEntry.install === 'object'
          ? actionEntry.install
          : actionEntry;
      const actionType = String(installBlock.action || '').trim();
      const actionArgs =
        installBlock.arguments && typeof installBlock.arguments === 'object'
          ? installBlock.arguments
          : {};

      if (/^setRegistry$/i.test(actionType)) {
        const rawRoot = String(actionArgs.root || actionArgs.hive || 'HKLM')
          .trim()
          .toUpperCase();
        const expandedSubKey = expandGogValueStringTokens(
          String(actionArgs.subkey || actionArgs.key || ''),
          tokenCtx
        );

        const registryVerdict = isAllowedGogRegistryTarget(rawRoot, expandedSubKey);
        if (!registryVerdict.allowed) {
          diagLog.warn('gogScript.blockedRegistryWrite', {
            productId: scriptItem.productId,
            hive: rawRoot,
            reason: registryVerdict.reason,
          });
          continue;
        }

        const rawSubKey = registryVerdict.normalizedSubKey;
        const isHkcu =
          registryVerdict.normalizedRoot === 'HKCU' ||
          registryVerdict.normalizedRoot === 'HKEY_CURRENT_USER';
        const rawValueName =
          actionArgs.valueName !== undefined ? actionArgs.valueName : actionArgs.name;
        const rawValueData =
          actionArgs.valueData !== undefined
            ? actionArgs.valueData
            : actionArgs.value !== undefined
              ? actionArgs.value
              : actionArgs.data;
        const rawValueType = String(actionArgs.valueType || actionArgs.type || 'string')
          .trim()
          .toLowerCase();

        const valNameStr =
          rawValueName === null || rawValueName === undefined ? '' : String(rawValueName);
        if (
          valNameStr &&
          (hasForbiddenSectionOrControlChars(valNameStr) ||
            DENIED_REGISTRY_VALUE_NAMES.has(valNameStr.trim().toLowerCase()))
        ) {
          diagLog.warn('gogScript.blockedRegistryValueName', {
            productId: scriptItem.productId,
            reason: 'forbidden_value_name',
          });
          continue;
        }

        const isKeyOnly =
          (rawValueName === null || rawValueName === undefined || rawValueName === '') &&
          (rawValueData === null || rawValueData === undefined);

        // Validate expanded string value data against control-char & section-header injection
        let validatedExpandedStr = '';
        if (
          !isKeyOnly &&
          rawValueType !== 'dword' &&
          rawValueType !== 'reg_dword' &&
          rawValueType !== 'qword' &&
          rawValueType !== 'reg_qword' &&
          rawValueType !== 'binary' &&
          rawValueType !== 'reg_binary'
        ) {
          validatedExpandedStr = expandGogValueStringTokens(String(rawValueData ?? ''), tokenCtx);
          if (
            hasNewlineOrNull(validatedExpandedStr) ||
            hasUnescapedSectionBracket(validatedExpandedStr)
          ) {
            diagLog.warn('gogScript.blockedRegistryValueData', {
              productId: scriptItem.productId,
              reason: 'forbidden_value_data',
            });
            continue;
          }
        }

        // Build target subkeys (including 32-bit Wow6432Node mirror for HKLM\Software\...)
        /** @type {string[]} */
        const targetSubKeys = [];
        if (!isHkcu && /^software\\/i.test(rawSubKey)) {
          const afterSoftware = rawSubKey.replace(/^software\\/i, '');
          if (!/^wow6432node\\/i.test(afterSoftware)) {
            targetSubKeys.push(`Software\\Wow6432Node\\${afterSoftware}`);
          }
          targetSubKeys.push(`Software\\${afterSoftware}`);
        } else {
          targetSubKeys.push(rawSubKey);
        }

        if (hasActiveBottle) {
          const targetMap = isHkcu ? hkcuBatchMap : hklmBatchMap;
          const targetRawPatches = isHkcu ? hkcuRawPatches : hklmRawPatches;

          for (const sk of targetSubKeys) {
            if (isKeyOnly) {
              queueBottleMapEntry(targetMap, sk, null, null);
              registryKeysApplied += 1;
              continue;
            }
            if (rawValueType === 'dword' || rawValueType === 'reg_dword') {
              const numVal =
                typeof rawValueData === 'string' && /^0x/i.test(rawValueData.trim())
                  ? Number.parseInt(rawValueData.trim(), 16)
                  : Number(rawValueData ?? 0);
              const safeDword = Number.isFinite(numVal) ? numVal >>> 0 : 0;
              if (!valNameStr || valNameStr === '@') {
                queueBottleMapEntry(targetMap, sk, null, null);
                targetRawPatches.push({
                  subKeyPath: sk,
                  valueName: '@',
                  rawRegRhs: `dword:${safeDword.toString(16).padStart(8, '0')}`,
                });
              } else {
                queueBottleMapEntry(targetMap, sk, valNameStr, {
                  type: 'dword',
                  value: safeDword,
                });
              }
            } else if (rawValueType === 'qword' || rawValueType === 'reg_qword') {
              const qVal = parseSafeRegistryQwordBigInt(rawValueData);
              if (!valNameStr || valNameStr === '@') {
                queueBottleMapEntry(targetMap, sk, null, null);
              } else {
                queueBottleMapEntry(targetMap, sk, valNameStr, { type: 'qword', value: qVal });
              }
            } else if (rawValueType === 'binary' || rawValueType === 'reg_binary') {
              const hexPairs = parseRegistryBinaryHexPairs(rawValueData);
              queueBottleMapEntry(targetMap, sk, null, null);
              targetRawPatches.push({
                subKeyPath: sk,
                valueName: valNameStr || '@',
                rawRegRhs: `hex:${hexPairs.join(',')}`,
              });
            } else {
              if (!valNameStr || valNameStr === '@') {
                queueBottleMapEntry(targetMap, sk, null, null);
                targetRawPatches.push({
                  subKeyPath: sk,
                  valueName: '@',
                  rawRegRhs: `"${escapeWineRegString(validatedExpandedStr)}"`,
                });
              } else {
                queueBottleMapEntry(targetMap, sk, valNameStr, {
                  type: 'sz',
                  value: validatedExpandedStr,
                });
              }
            }
            registryKeysApplied += 1;
          }
        } else if (platform === 'win32') {
          let regTypeFlag = 'REG_SZ';
          let regDataStr = '';
          if (!isKeyOnly) {
            if (rawValueType === 'dword' || rawValueType === 'reg_dword') {
              regTypeFlag = 'REG_DWORD';
              const numVal =
                typeof rawValueData === 'string' && /^0x/i.test(rawValueData.trim())
                  ? Number.parseInt(rawValueData.trim(), 16)
                  : Number(rawValueData ?? 0);
              regDataStr = String(Number.isFinite(numVal) ? numVal >>> 0 : 0);
            } else if (rawValueType === 'qword' || rawValueType === 'reg_qword') {
              regTypeFlag = 'REG_QWORD';
              regDataStr = parseSafeRegistryQwordBigInt(rawValueData).toString(10);
            } else if (rawValueType === 'binary' || rawValueType === 'reg_binary') {
              regTypeFlag = 'REG_BINARY';
              regDataStr = parseRegistryBinaryHexPairs(rawValueData).join('');
            } else if (rawValueType === 'expandstring' || rawValueType === 'reg_expand_sz') {
              regTypeFlag = 'REG_EXPAND_SZ';
              regDataStr = validatedExpandedStr;
            } else {
              regTypeFlag = 'REG_SZ';
              regDataStr = validatedExpandedStr;
            }
          }

          /** @type {Array<{ fullKey: string, required: boolean }>} */
          const fullWinKeys = [];
          if (isHkcu) {
            for (const sk of targetSubKeys) {
              fullWinKeys.push({ fullKey: `HKCU\\${sk}`, required: true });
            }
          } else {
            const afterSoft = rawSubKey
              .replace(/^software\\/i, '')
              .replace(/^wow6432node\\/i, '');
            // 1. WOW64 UAC VirtualStore mirror so un-elevated 32-bit `RegOpenKeyExA(HKLM, "Software\\...")` reads it natively
            fullWinKeys.push({
              fullKey: `HKCU\\Software\\Classes\\VirtualStore\\Machine\\SOFTWARE\\Wow6432Node\\${afterSoft}`,
              required: true,
            });
            // 2. Per-user HKCU Software mirrors for dual-hive games
            fullWinKeys.push({
              fullKey: `HKCU\\Software\\Wow6432Node\\${afterSoft}`,
              required: true,
            });
            fullWinKeys.push({
              fullKey: `HKCU\\Software\\${afterSoft}`,
              required: true,
            });
            // 3. Best-effort HKLM 32-bit + 64-bit writes when running in an already-elevated context
            fullWinKeys.push({
              fullKey: `HKLM\\Software\\Wow6432Node\\${afterSoft}`,
              required: false,
            });
            fullWinKeys.push({
              fullKey: `HKLM\\Software\\${afterSoft}`,
              required: false,
            });
          }

          for (const { fullKey, required } of fullWinKeys) {
            if (isKeyOnly) {
              win32RegCommands.push({ args: ['add', fullKey, '/f'], required });
            } else {
              const nameArgs = !valNameStr || valNameStr === '@' ? ['/ve'] : ['/v', valNameStr];
              win32RegCommands.push({
                args: ['add', fullKey, ...nameArgs, '/t', regTypeFlag, '/d', regDataStr, '/f'],
                required,
              });
            }
          }
        }
      } else if (/^(?:supportData|copy|filesystem|copyFile|moveFile)$/i.test(actionType)) {
        const rawSource = String(
          actionArgs.source || actionArgs.src || actionArgs.origin || actionArgs.file || ''
        ).trim();
        const rawTarget = String(
          actionArgs.target || actionArgs.destination || actionArgs.dest || '{app}'
        ).trim();
        const overwrite = actionArgs.overwrite !== false;

        const srcResolved = rawSource
          ? resolveContainedGogFsPath(hostInstallDir, rawSource, scriptItem.productId, true)
          : resolveContainedGogFsPath(hostInstallDir, '{supportDir}/app', scriptItem.productId, true);
        const destResolved = resolveContainedGogFsPath(
          hostInstallDir,
          rawTarget,
          scriptItem.productId,
          false
        );
        if (srcResolved && destResolved) {
          supportFilesStaged += copyContainedSupportEntry(
            hostInstallDir,
            srcResolved,
            destResolved,
            overwrite
          );
        }
      } else if (/^(?:iniFile|setIni)$/i.test(actionType)) {
        const rawIniTarget = String(
          actionArgs.file || actionArgs.filename || actionArgs.target || actionArgs.path || ''
        ).trim();
        const section = expandGogValueStringTokens(String(actionArgs.section || ''), tokenCtx);
        const key = expandGogValueStringTokens(
          String(actionArgs.key || actionArgs.keyName || actionArgs.name || ''),
          tokenCtx
        );
        const val = expandGogValueStringTokens(
          String(
            actionArgs.value !== undefined
              ? actionArgs.value
              : actionArgs.keyValue !== undefined
                ? actionArgs.keyValue
                : actionArgs.data ?? ''
          ),
          tokenCtx
        );
        const resolvedIni = resolveContainedGogFsPath(
          hostInstallDir,
          rawIniTarget,
          scriptItem.productId,
          false
        );
        if (
          resolvedIni &&
          upsertContainedIniValue(hostInstallDir, resolvedIni, section, key, val)
        ) {
          iniEntriesApplied += 1;
        }
      }
    }
  }

  // Flush batched bottle registry mutations on macOS / Wine into a single coalesced live reg.exe import
  if (hasActiveBottle) {
    /** @type {any[]} */
    const liveSyncAccumulator = [];
    const batchOpts = {
      ...opts,
      bottlePath: hostBottleDir,
      liveSyncAccumulator,
    };
    if (hklmBatchMap.size > 0) {
      const specs = Array.from(hklmBatchMap.entries()).map(([subKeyPath, entryMap]) => ({
        subKeyPath,
        entries: Array.from(entryMap.entries()),
      }));
      upsertWineSystemRegKeysBatch(hostBottleDir, specs, batchOpts);
    }
    if (hklmRawPatches.length > 0) {
      const sysRegPath = path.join(hostBottleDir, 'system.reg');
      patchRawWineRegistrySectionsBatch(sysRegPath, hklmRawPatches, batchOpts);
    }
    if (hkcuBatchMap.size > 0) {
      const hkcuSpecs = Array.from(hkcuBatchMap.entries()).map(([subKeyPath, entryMap]) => ({
        subKeyPath,
        entries: Array.from(entryMap.entries()),
      }));
      upsertWineUserRegKeysBatch(hostBottleDir, hkcuSpecs, batchOpts);
    }
    if (hkcuRawPatches.length > 0) {
      const userRegPath = path.join(hostBottleDir, 'user.reg');
      patchRawWineRegistrySectionsBatch(userRegPath, hkcuRawPatches, batchOpts);
    }
    if (liveSyncAccumulator.length > 0) {
      await flushLiveWineRegistryAccumulator(hostBottleDir, liveSyncAccumulator, opts);
    }
  }

  // Flush async non-elevated Windows registry writes on win32 in bounded batches of 8
  let hadWin32RegFailure = false;
  if (platform === 'win32' && win32RegCommands.length > 0) {
    const WIN32_REG_CONCURRENCY = 8;
    let win32RegSucceeded = 0;
    for (let i = 0; i < win32RegCommands.length; i += WIN32_REG_CONCURRENCY) {
      const chunk = win32RegCommands.slice(i, i + WIN32_REG_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((cmd) => runWindowsRegAddAsync(cmd.args, opts))
      );
      for (let j = 0; j < results.length; j += 1) {
        if (results[j]) {
          win32RegSucceeded += 1;
        } else if (chunk[j].required) {
          hadWin32RegFailure = true;
        }
      }
    }
    registryKeysApplied += win32RegSucceeded;
    if (win32RegSucceeded === 0) {
      hadWin32RegFailure = true;
    }
  }

  // Re-verify top-level proxy DLLs in case a script staged a legacy DLL that has a Win10 sibling
  supportFilesStaged += healMalformedTopLevelProxyDlls(hostInstallDir);

  // Never write a success stamp when required `reg.exe` writes failed on win32
  if (!hadWin32RegFailure) {
    try {
      atomicWriteFileSync(
        stampPath,
        `${JSON.stringify(
          {
            version: GOG_SCRIPT_STAMP_VERSION,
            scriptsHash,
            targetScopeHash,
          },
          null,
          2
        )}\n`
      );
    } catch (err) {
      diagLog.debug('gogScript.stampWriteFailed', err);
    }
  }

  return {
    executed: !hadWin32RegFailure || supportFilesStaged > 0 || iniEntriesApplied > 0 || registryKeysApplied > 0,
    skippedCached: false,
    scriptsProcessed: scriptFiles.length,
    registryKeysApplied,
    supportFilesStaged,
    iniEntriesApplied,
  };
}

module.exports = {
  GOG_SCRIPT_STAMP_FILENAME,
  isAllowedGogRegistryTarget,
  expandGogValueStringTokens,
  executeGogGameScript,
  parseSafeRegistryQwordBigInt,
  patchRawWineRegistrySectionsBatch,
  patchRawWineRegistrySectionLines,
  selectCompatibleWin10SiblingDll,
  healMalformedTopLevelProxyDlls,
};
