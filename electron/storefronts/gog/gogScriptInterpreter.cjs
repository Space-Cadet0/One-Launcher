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

  const scanSingleDir = (dirPath) => {
    try {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true }).slice(0, 96);
      for (const dirent of entries) {
        if (dirent.isFile()) {
          const m = dirent.name.match(/^goggame-(\d+)\.script$/i);
          if (!m) continue;
          const full = path.join(dirPath, dirent.name);
          const resolved = path.resolve(full);
          if (seenPaths.has(resolved)) continue;
          if (!isContainedWithinRoot(hostInstallDir, resolved, process.platform)) continue;
          const st = fs.statSync(resolved);
          if (!st.isFile() || st.size <= 0 || st.size > 2 * 1024 * 1024) continue;
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
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          const subDirs = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 32);
          for (const sub of subDirs) {
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
        if (!fs.existsSync(infoPath)) continue;
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
    .replace(/\{app\}/gi, ctx.winAppPath)
    .replace(/\{supportDir\}/gi, ctx.winSupportPath)
    .replace(/\{support\}/gi, ctx.winSupportPath)
    .replace(/\{productId\}/gi, ctx.productId || '')
    .replace(/\{languageCode\}/gi, ctx.languageCode)
    .replace(/\{language\}/gi, ctx.language)
    .replace(/\{lang\}/gi, ctx.lang);
}

/**
 * Resolve a filesystem `{support}` / `{supportDir}` / `{app}` relative path strictly inside `hostInstallDir`.
 *
 * @param {string} hostInstallDir
 * @param {string} rawPathExpr
 * @param {string} productId
 * @param {boolean} mustExist
 * @returns {string}
 */
function resolveContainedGogFsPath(hostInstallDir, rawPathExpr, productId, mustExist) {
  if (typeof rawPathExpr !== 'string' || !rawPathExpr.trim()) {
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
          isContainedWithinRoot(hostInstallDir, sr, process.platform) &&
          (!mustExist || fs.existsSync(sr))
        ) {
          return sr;
        }
      }
    }
    return hostInstallDir;
  }

  if (strippedRel.split('/').some((seg) => seg === '..')) {
    return '';
  }

  const candidateBases = usesSupportToken ? supportRoots : [hostInstallDir, ...supportRoots];
  for (const base of candidateBases) {
    if (!isContainedWithinRoot(hostInstallDir, base, process.platform)) continue;
    if (mustExist) {
      const existing = resolveCaseInsensitiveRelFile(base, strippedRel);
      if (existing && isContainedWithinRoot(hostInstallDir, existing, process.platform)) {
        return existing;
      }
      const dirCand = path.resolve(base, ...strippedRel.split('/').filter(Boolean));
      if (
        isContainedWithinRoot(hostInstallDir, dirCand, process.platform) &&
        fs.existsSync(dirCand)
      ) {
        return dirCand;
      }
    } else {
      const targetCand = path.resolve(base, ...strippedRel.split('/').filter(Boolean));
      if (isContainedWithinRoot(hostInstallDir, targetCand, process.platform)) {
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
 * Copy a single support file or directory tree strictly within `hostInstallDir`, automatically
 * substituting `<stem>_w10.dll` when staging `<stem>.dll` from a support folder.
 *
 * @param {string} hostInstallDir
 * @param {string} srcPath
 * @param {string} destPath
 * @param {boolean} overwrite
 * @returns {number}
 */
function copyContainedSupportEntry(hostInstallDir, srcPath, destPath, overwrite = true) {
  if (
    !srcPath ||
    !destPath ||
    !isContainedWithinRoot(hostInstallDir, srcPath, process.platform) ||
    !isContainedWithinRoot(hostInstallDir, destPath, process.platform) ||
    !fs.existsSync(srcPath)
  ) {
    return 0;
  }
  const srcStat = fs.statSync(srcPath);
  if (srcStat.isFile()) {
    let finalDest = destPath;
    try {
      if (fs.existsSync(destPath) && fs.statSync(destPath).isDirectory()) {
        finalDest = path.join(destPath, path.basename(srcPath));
      }
    } catch {}
    if (!isContainedWithinRoot(hostInstallDir, finalDest, process.platform)) {
      return 0;
    }
    if (!overwrite && fs.existsSync(finalDest) && !hasMalformedBackslashExportForwarder(finalDest)) {
      return 0;
    }
    const effectiveSrc = selectCompatibleWin10SiblingDll(srcPath);
    if (path.resolve(effectiveSrc) === path.resolve(finalDest)) {
      return 0;
    }
    fs.mkdirSync(path.dirname(finalDest), { recursive: true });
    fs.copyFileSync(effectiveSrc, finalDest);
    return 1;
  }

  if (srcStat.isDirectory()) {
    let copied = 0;
    fs.mkdirSync(destPath, { recursive: true });
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
 *
 * @param {string} hostInstallDir
 * @returns {number}
 */
function healMalformedTopLevelProxyDlls(hostInstallDir) {
  let healed = 0;
  const donorDirs = [
    path.join(hostInstallDir, 'add'),
    path.join(hostInstallDir, '__support', 'add'),
    path.join(hostInstallDir, '__gog_support', 'add'),
    path.join(hostInstallDir, 'support', 'add'),
  ];
  try {
    const rootEntries = fs.readdirSync(hostInstallDir, { withFileTypes: true }).slice(0, 128);
    for (const dirent of rootEntries) {
      if (!dirent.isFile() || !/\.dll$/i.test(dirent.name)) continue;
      const topDllPath = path.join(hostInstallDir, dirent.name);
      if (!isContainedWithinRoot(hostInstallDir, topDllPath, process.platform)) continue;
      if (!hasMalformedBackslashExportForwarder(topDllPath)) continue;

      const ext = path.extname(dirent.name);
      const stem = path.basename(dirent.name, ext);
      let replacement = selectCompatibleWin10SiblingDll(topDllPath);
      if (replacement === topDllPath) {
        for (const dDir of donorDirs) {
          if (!isContainedWithinRoot(hostInstallDir, dDir, process.platform)) continue;
          const candW10 =
            resolveCaseInsensitiveRelFile(dDir, `${stem}_w10${ext}`) ||
            resolveCaseInsensitiveRelFile(dDir, `${stem}_win10${ext}`);
          if (candW10 && !hasMalformedBackslashExportForwarder(candW10)) {
            replacement = candW10;
            break;
          }
        }
      }
      if (replacement && replacement !== topDllPath) {
        fs.copyFileSync(replacement, topDllPath);
        healed += 1;
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

  const normalizedSubKey = subKeyPath.trim().replace(/^\\+|\\+$/g, '').replace(/\\+/g, '\\');
  const escapedSectionPath = normalizedSubKey.replace(/\\/g, '\\\\');
  const sectionHeaderRe = new RegExp(
    `^\\[${escapeRegExp(escapedSectionPath)}\\](?:\\s+\\d+)?[^\\r\\n]*$`,
    'im'
  );
  const match = sectionHeaderRe.exec(content);
  const unixSec = Math.floor(Date.now() / 1000);
  const formatLine = (/** @type {{ valueName: string, rawRegRhs: string }} */ item) => {
    if (!item.valueName || item.valueName === '@') {
      return `@=${item.rawRegRhs}`;
    }
    return `"${escapeWineRegString(item.valueName)}"=${item.rawRegRhs}`;
  };

  /** @type {Array<[string, any]>} */
  const liveSyncPairs = rawEntries.map((item) => [
    !item.valueName || item.valueName === '@' ? '@' : String(item.valueName),
    { rawRegRhs: item.rawRegRhs },
  ]);

  if (!match) {
    const lines = rawEntries.map(formatLine).join('\n');
    const sep = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    atomicWriteFileSync(regFilePath, `${content}${sep}[${escapedSectionPath}] ${unixSec}\n${lines}\n`);
  } else {
    const headerEnd = match.index + match[0].length;
    const afterHeader = content.slice(headerEnd);
    const nextSectionMatch = /^\[[^\]]+\]/m.exec(afterHeader);
    const body = nextSectionMatch ? afterHeader.slice(0, nextSectionMatch.index) : afterHeader;
    const rest = nextSectionMatch ? afterHeader.slice(nextSectionMatch.index) : '';
    const bodyLines = body.split(/\r?\n/);

    for (const item of rawEntries) {
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
    atomicWriteFileSync(
      regFilePath,
      content.slice(0, match.index) + `[${escapedSectionPath}] ${unixSec}` + rebuiltBody + rest
    );
  }

  if (options && Array.isArray(options.liveSyncAccumulator)) {
    options.liveSyncAccumulator.push({
      hiveName,
      normalizedSubKey,
      entryPairsOrNullForDelete: liveSyncPairs,
    });
  } else {
    const bottlePath =
      typeof options?.bottlePath === 'string' && options.bottlePath
        ? options.bottlePath
        : path.dirname(regFilePath);
    if (bottlePath && options?.skipLiveWineRegSync !== true) {
      syncLiveWineRegistryBatchAsync(
        bottlePath,
        hiveName,
        [{ hiveName, normalizedSubKey, entryPairsOrNullForDelete: liveSyncPairs }],
        options
      ).catch(() => {});
    }
  }
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
        (err) => {
          resolve(!err);
        }
      );
    } catch {
      resolve(false);
    }
  });
}

/**
 * Upsert a single `[Section]` `key=value` entry inside an INI file contained within `hostInstallDir`.
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
    !isContainedWithinRoot(hostInstallDir, targetIniPath, process.platform)
  ) {
    return false;
  }
  let existing = '';
  try {
    if (fs.existsSync(targetIniPath)) {
      const st = fs.statSync(targetIniPath);
      if (st.size > 1024 * 1024) return false;
      existing = fs.readFileSync(targetIniPath, 'utf8');
    }
  } catch {
    existing = '';
  }

  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const cleanSection = String(sectionName || '').trim();
  const cleanKey = String(keyName || '').trim();
  const newLine = `${cleanKey}=${valueStr}`;

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
 * Uses a SHA-256 stamp (`.one_gog_script_applied.json`) containing zero raw host paths so repeat
 * launches short-circuit in `< 1 ms` while automatically re-applying if the user switches bottles.
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
  try {
    if (!fs.existsSync(hostInstallDir) || !fs.statSync(hostInstallDir).isDirectory()) {
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

  // Always heal any top-level proxy DLL whose PE export table has a malformed backslash forwarder
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

  const scriptsDigestInput = scriptFiles
    .map((s) => `${path.basename(s.scriptPath)}:${sha256Hex(s.rawContent)}`)
    .join('|');
  const scriptsHash = sha256Hex(scriptsDigestInput);
  const targetScopeHash = sha256Hex(
    `${platform}:${hasActiveBottle ? hostBottleDir : platform === 'win32' ? 'win32_native' : 'pending_bottle'}:${hostInstallDir}`
  );

  const stampPath = path.join(hostInstallDir, GOG_SCRIPT_STAMP_FILENAME);
  if (opts.force !== true && healedDllCount === 0) {
    try {
      if (fs.existsSync(stampPath)) {
        const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
        const bottleHivePresent =
          !hasActiveBottle || fs.existsSync(path.join(hostBottleDir, 'system.reg'));
        if (
          stamp &&
          stamp.version === GOG_SCRIPT_STAMP_VERSION &&
          stamp.scriptsHash === scriptsHash &&
          stamp.targetScopeHash === targetScopeHash &&
          bottleHivePresent
        ) {
          return {
            executed: false,
            skippedCached: true,
            scriptsProcessed: scriptFiles.length,
            registryKeysApplied: 0,
            supportFilesStaged: 0,
            iniEntriesApplied: 0,
          };
        }
      }
    } catch {}
  }

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
  /** @type {Array<string[]>} */
  const win32RegCommands = [];

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
        const lowerAllowed = actionEntry.languages.map((l) => String(l || '').toLowerCase());
        const matchesLang =
          lowerAllowed.includes('*') ||
          lowerAllowed.includes(langTokens.languageCode.toLowerCase()) ||
          lowerAllowed.includes(langTokens.language.toLowerCase()) ||
          lowerAllowed.includes(langTokens.lang.toLowerCase()) ||
          lowerAllowed.some((l) => l.startsWith(`${langTokens.lang.toLowerCase()}-`));
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
        const rawSubKey = expandGogValueStringTokens(
          String(actionArgs.subkey || actionArgs.key || ''),
          tokenCtx
        )
          .trim()
          .replace(/\//g, '\\')
          .replace(/^\\+|\\+$/g, '')
          .replace(/\\+/g, '\\');
        if (!rawSubKey) continue;

        const isHkcu = rawRoot === 'HKCU' || rawRoot === 'HKEY_CURRENT_USER';
        const isHkcr = rawRoot === 'HKCR' || rawRoot === 'HKEY_CLASSES_ROOT';
        const rawValueName =
          actionArgs.valueName !== undefined ? actionArgs.valueName : actionArgs.name;
        const rawValueData =
          actionArgs.valueData !== undefined
            ? actionArgs.valueData
            : actionArgs.value !== undefined
              ? actionArgs.value
              : actionArgs.data;
        const rawValueType = String(
          actionArgs.valueType || actionArgs.type || 'string'
        )
          .trim()
          .toLowerCase();

        // Build target subkeys (including 32-bit Wow6432Node mirror for Software\...)
        /** @type {string[]} */
        const targetSubKeys = [];
        if (isHkcr) {
          targetSubKeys.push(`Software\\Classes\\${rawSubKey}`);
        } else if (!isHkcu && /^software\\/i.test(rawSubKey)) {
          const afterSoftware = rawSubKey.replace(/^software\\/i, '');
          if (!/^wow6432node\\/i.test(afterSoftware)) {
            targetSubKeys.push(`Software\\Wow6432Node\\${afterSoftware}`);
          }
          targetSubKeys.push(`Software\\${afterSoftware}`);
        } else {
          targetSubKeys.push(rawSubKey);
        }

        const isKeyOnly =
          (rawValueName === null || rawValueName === undefined || rawValueName === '') &&
          (rawValueData === null || rawValueData === undefined);

        if (hasActiveBottle) {
          const targetMap = isHkcu ? hkcuBatchMap : hklmBatchMap;
          const targetRawPatches = isHkcu ? hkcuRawPatches : hklmRawPatches;

          for (const sk of targetSubKeys) {
            if (isKeyOnly) {
              queueBottleMapEntry(targetMap, sk, null, null);
              registryKeysApplied += 1;
              continue;
            }
            const valNameStr =
              rawValueName === null || rawValueName === undefined ? '' : String(rawValueName);
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
              const qVal = BigInt(rawValueData ?? 0);
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
              const expandedStr = expandGogValueStringTokens(String(rawValueData ?? ''), tokenCtx);
              if (!valNameStr || valNameStr === '@') {
                queueBottleMapEntry(targetMap, sk, null, null);
                targetRawPatches.push({
                  subKeyPath: sk,
                  valueName: '@',
                  rawRegRhs: `"${escapeWineRegString(expandedStr)}"`,
                });
              } else {
                queueBottleMapEntry(targetMap, sk, valNameStr, {
                  type: 'sz',
                  value: expandedStr,
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
              regDataStr = String(rawValueData ?? '0');
            } else if (rawValueType === 'binary' || rawValueType === 'reg_binary') {
              regTypeFlag = 'REG_BINARY';
              regDataStr = parseRegistryBinaryHexPairs(rawValueData).join('');
            } else if (rawValueType === 'expandstring' || rawValueType === 'reg_expand_sz') {
              regTypeFlag = 'REG_EXPAND_SZ';
              regDataStr = expandGogValueStringTokens(String(rawValueData ?? ''), tokenCtx);
            } else {
              regTypeFlag = 'REG_SZ';
              regDataStr = expandGogValueStringTokens(String(rawValueData ?? ''), tokenCtx);
            }
          }

          /** @type {string[]} */
          const fullWinKeys = [];
          if (isHkcu || isHkcr) {
            for (const sk of targetSubKeys) {
              fullWinKeys.push(`HKCU\\${sk}`);
            }
          } else if (/^software\\/i.test(rawSubKey)) {
            const afterSoft = rawSubKey.replace(/^software\\/i, '').replace(/^wow6432node\\/i, '');
            // 1. WOW64 UAC VirtualStore mirror so un-elevated 32-bit `RegOpenKeyExA(HKLM, "Software\\...")` reads it natively
            fullWinKeys.push(
              `HKCU\\Software\\Classes\\VirtualStore\\Machine\\SOFTWARE\\Wow6432Node\\${afterSoft}`
            );
            // 2. Per-user HKCU Software mirrors for dual-hive games
            fullWinKeys.push(`HKCU\\Software\\Wow6432Node\\${afterSoft}`);
            fullWinKeys.push(`HKCU\\Software\\${afterSoft}`);
            // 3. Best-effort HKLM 32-bit + 64-bit writes when running in an already-elevated context (quietly ignored otherwise)
            fullWinKeys.push(`HKLM\\Software\\Wow6432Node\\${afterSoft}`);
            fullWinKeys.push(`HKLM\\Software\\${afterSoft}`);
          } else {
            fullWinKeys.push(`HKCU\\Software\\Classes\\VirtualStore\\Machine\\${rawSubKey}`);
          }

          for (const fullKey of fullWinKeys) {
            if (isKeyOnly) {
              win32RegCommands.push(['add', fullKey, '/f']);
            } else {
              const valNameStr =
                rawValueName === null || rawValueName === undefined ? '' : String(rawValueName);
              const nameArgs = !valNameStr || valNameStr === '@' ? ['/ve'] : ['/v', valNameStr];
              win32RegCommands.push([
                'add',
                fullKey,
                ...nameArgs,
                '/t',
                regTypeFlag,
                '/d',
                regDataStr,
                '/f',
              ]);
            }
            registryKeysApplied += 1;
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
      for (const patch of hklmRawPatches) {
        patchRawWineRegistrySectionLines(sysRegPath, patch.subKeyPath, [patch], batchOpts);
      }
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
      for (const patch of hkcuRawPatches) {
        patchRawWineRegistrySectionLines(userRegPath, patch.subKeyPath, [patch], batchOpts);
      }
    }
    if (liveSyncAccumulator.length > 0) {
      await flushLiveWineRegistryAccumulator(hostBottleDir, liveSyncAccumulator, opts);
    }
  }

  // Flush async non-elevated Windows registry writes on win32 in bounded batches of 8
  if (platform === 'win32' && win32RegCommands.length > 0) {
    const WIN32_REG_CONCURRENCY = 8;
    for (let i = 0; i < win32RegCommands.length; i += WIN32_REG_CONCURRENCY) {
      await Promise.all(
        win32RegCommands
          .slice(i, i + WIN32_REG_CONCURRENCY)
          .map((cmdArgs) => runWindowsRegAddAsync(cmdArgs, opts))
      );
    }
  }

  // Re-verify top-level proxy DLLs in case a script staged a legacy DLL that has a Win10 sibling
  supportFilesStaged += healMalformedTopLevelProxyDlls(hostInstallDir);

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

  return {
    executed: true,
    skippedCached: false,
    scriptsProcessed: scriptFiles.length,
    registryKeysApplied,
    supportFilesStaged,
    iniEntriesApplied,
  };
}

module.exports = {
  GOG_SCRIPT_STAMP_FILENAME,
  executeGogGameScript,
  patchRawWineRegistrySectionLines,
  selectCompatibleWin10SiblingDll,
  healMalformedTopLevelProxyDlls,
};
