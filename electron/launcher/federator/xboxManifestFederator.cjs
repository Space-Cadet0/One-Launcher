// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isContainedWithinRoot } = require('../securityAndPathUtils.cjs');
const {
  computePackageFamilyName,
  parseMicrosoftGameConfigXml: parseCoreMicrosoftGameConfigXml,
  parseAppxManifestXml,
  extractXmlAttr,
  stripXmlComments,
} = require('../../storefronts/xbox/xboxConfigAndIds.cjs');
const {
  setBoundedCache,
  isExistingDirectory,
  isExistingDirectoryAsync,
  isExistingFile,
  validateFederatedImageFile,
  validateFederatedImageFileAsync,
  discoverStorefrontCacheRoots,
  discoverStorefrontCacheRootsAsync,
  extractXboxParams,
  isFederatedStoreUrlCompatible,
} = require('./cacheRootDiscovery.cjs');

/** @type {Map<string, any>} */
const xboxManifestScanLookup = new Map();
const MAX_XBOX_MANIFEST_LOOKUP_ENTRIES = 256;

/**
 * Resolves a manifest-relative executable or visual asset path strictly contained within
 * `configDir` (and optional `xboxRoot`), closing absolute-path (`C:\Windows\...`, `/bin/sh`,
 * UNC `\\...`) and `..` traversal escapes.
 *
 * @param {string} configDir
 * @param {unknown} rawRel
 * @param {string} [xboxRoot]
 * @param {string} [platform]
 * @returns {string}
 */
function resolveContainedManifestAssetPath(configDir, rawRel, xboxRoot, platform) {
  if (typeof rawRel !== 'string') return '';
  const trimmed = rawRel.trim();
  if (!trimmed || trimmed.includes('\0')) return '';
  // Reject absolute POSIX paths, UNC paths, leading slashes, and Windows drive-letter roots
  if (
    /^[\\/]/.test(trimmed) ||
    /^[a-zA-Z]:/.test(trimmed) ||
    path.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed) ||
    path.posix.isAbsolute(trimmed)
  ) {
    return '';
  }
  const normalizedRel = trimmed.replace(/[\\/]+/g, path.sep);
  const segments = normalizedRel.split(path.sep);
  if (segments.some((seg) => seg === '..')) {
    return '';
  }
  const resolvedPath = path.resolve(configDir, normalizedRel);
  const containPlatform = platform || process.platform;
  if (!isContainedWithinRoot(configDir, resolvedPath, containPlatform)) {
    return '';
  }
  if (xboxRoot && !isContainedWithinRoot(xboxRoot, resolvedPath, containPlatform)) {
    return '';
  }
  return resolvedPath;
}

/**
 * Verifies an extracted executable path is an existing regular non-symlink file whose
 * canonical realpath stays strictly contained inside `configDir` (and optional `xboxRoot`).
 *
 * @param {string} candidatePath
 * @param {string} configDir
 * @param {string} [xboxRoot]
 * @param {string} [platform]
 * @returns {string | undefined}
 */
function verifyContainedExecutableFile(candidatePath, configDir, xboxRoot, platform) {
  if (!candidatePath) return undefined;
  try {
    const lst = fs.lstatSync(candidatePath);
    if (lst.isSymbolicLink() || !lst.isFile()) return undefined;
    const containPlatform = platform || process.platform;
    const realCandidate = fs.realpathSync(candidatePath);
    const realConfigDir = fs.realpathSync(configDir);
    if (!isContainedWithinRoot(realConfigDir, realCandidate, containPlatform)) {
      return undefined;
    }
    if (xboxRoot) {
      try {
        const realXboxRoot = fs.realpathSync(xboxRoot);
        if (!isContainedWithinRoot(realXboxRoot, realCandidate, containPlatform)) {
          return undefined;
        }
      } catch {
        return undefined;
      }
    }
    return candidatePath;
  } catch {
    return undefined;
  }
}

/**
 * Delegates `MicrosoftGame.config` XML parsing to `../../storefronts/xbox/xboxConfigAndIds.cjs`
 * (`parseCoreMicrosoftGameConfigXml` + `computePackageFamilyName` + sibling `AppxManifest.xml` PFN enrichment).
 * Supports both 1-arg `(xmlStr)` export compatibility and 4-arg federated manifest resolution.
 *
 * @param {string} xmlStr
 * @param {string} [configFilePath]
 * @param {string} [gameFolderPath]
 * @param {string} [xboxRoot]
 * @param {string} [platform]
 */
function parseMicrosoftGameConfigXml(xmlStr, configFilePath, gameFolderPath, xboxRoot, platform) {
  if (!xmlStr || typeof xmlStr !== 'string') return null;
  if (arguments.length <= 1 || !configFilePath) {
    return parseCoreMicrosoftGameConfigXml(xmlStr);
  }

  const configDir = path.dirname(configFilePath);
  const wrappedXml = /<Game\b/i.test(xmlStr) ? xmlStr : `<Game configVersion="1">${xmlStr}</Game>`;
  const coreParsed = parseCoreMicrosoftGameConfigXml(wrappedXml);
  if (!coreParsed) return null;

  let identityName = String(coreParsed.identity?.name || '').trim();
  let identityPublisher = String(coreParsed.identity?.publisher || '').trim();
  let identityVersion = String(coreParsed.identity?.version || '').trim();
  let packageFamilyName = String(
    coreParsed.packageFamilyName || computePackageFamilyName(identityName, identityPublisher) || ''
  ).trim();
  if (!packageFamilyName && /_[0-9a-hjkmnp-tv-z]{13}$/i.test(identityName)) {
    packageFamilyName = identityName;
  }

  // Enrich missing PFN / Publisher from sibling AppxManifest.xml when present
  let appxFallbackDisplayName = '';
  let appxFallbackPublisherDisplayName = '';
  if (!packageFamilyName || !identityName) {
    const appxCandidates = [
      path.join(configDir, 'AppxManifest.xml'),
      ...(gameFolderPath && gameFolderPath !== configDir
        ? [path.join(gameFolderPath, 'AppxManifest.xml')]
        : []),
    ];
    for (const appxPath of appxCandidates) {
      if (!isExistingFile(appxPath)) continue;
      if (xboxRoot && !isContainedWithinRoot(xboxRoot, appxPath, platform || process.platform)) {
        continue;
      }
      try {
        const appxParsed = parseAppxManifestXml(fs.readFileSync(appxPath, 'utf8'));
        if (appxParsed) {
          if (!identityName && appxParsed.identity?.name) {
            identityName = appxParsed.identity.name;
          }
          if (!identityPublisher && appxParsed.identity?.publisher) {
            identityPublisher = appxParsed.identity.publisher;
          }
          if (!identityVersion && appxParsed.identity?.version) {
            identityVersion = appxParsed.identity.version;
          }
          if (!packageFamilyName) {
            packageFamilyName =
              appxParsed.packageFamilyName ||
              computePackageFamilyName(identityName, identityPublisher) ||
              '';
          }
          appxFallbackDisplayName = appxParsed.displayName || '';
          appxFallbackPublisherDisplayName = appxParsed.publisherDisplayName || '';
          break;
        }
      } catch {}
    }
  }

  const cleanXml = stripXmlComments(wrappedXml)
    .replace(/^\uFEFF/, '')
    .replace(/<DevelopmentOnly\b[^>]*>[\s\S]*?<\/DevelopmentOnly>/gi, '')
    .replace(/<DevelopmentOnly\b[^>]*\/>/gi, '');

  const shellMatch = /<ShellVisuals\b([^>]*)\/?>/i.exec(cleanXml);
  const rawSquare480 = shellMatch ? extractXmlAttr(shellMatch[1], 'Square480x480Logo') : '';
  const rawSplashScreen = shellMatch ? extractXmlAttr(shellMatch[1], 'SplashScreenImage') : '';
  const rawSquare150 = shellMatch ? extractXmlAttr(shellMatch[1], 'Square150x150Logo') : '';
  const rawSquare44 = shellMatch ? extractXmlAttr(shellMatch[1], 'Square44x44Logo') : '';
  const rawStoreLogo = shellMatch ? extractXmlAttr(shellMatch[1], 'StoreLogo') : '';

  const rawTitleIdMatch = cleanXml.match(/<TitleId[^>]*>([^<]+)<\/TitleId>/i);
  const rawTitleIdStr = rawTitleIdMatch ? rawTitleIdMatch[1].trim() : '';
  let titleId = '';
  if (rawTitleIdStr) {
    if (/^\d+$/.test(rawTitleIdStr)) {
      titleId = rawTitleIdStr;
    } else if (/^(?:0x)?[0-9a-f]+$/i.test(rawTitleIdStr)) {
      titleId = String(parseInt(rawTitleIdStr.replace(/^0x/i, ''), 16) >>> 0);
    } else {
      titleId = coreParsed.titleIdDecimal || coreParsed.titleId || rawTitleIdStr;
    }
  }

  const rawStoreId = String(coreParsed.storeId || '').trim().toUpperCase();
  const productId = /^[A-Z0-9]{12}$/.test(rawStoreId) ? rawStoreId : '';

  /** @param {unknown} rel */
  const normalizeRelAsset = (rel) =>
    resolveContainedManifestAssetPath(configDir, rel, xboxRoot, platform);

  // Use raw XML attribute values (before core parser's `normalizeContainerRelPath` strips leading `/`)
  // so absolute POSIX (`/etc/passwd`, `/bin/sh`), UNC (`\\server\...`), and drive-letter paths are rejected.
  /** @type {Record<string, any>} */
  const sv = coreParsed.shellVisuals || {};
  const square480Path = normalizeRelAsset(rawSquare480);
  const splashScreenPath = normalizeRelAsset(rawSplashScreen);
  const square150Path = normalizeRelAsset(rawSquare150);
  const square44Path = normalizeRelAsset(rawSquare44);
  const storeLogoPath = normalizeRelAsset(rawStoreLogo);

  /** @type {string[]} */
  const rawExecutables = [];
  const exeRegex = /<Executable\b([^>]*)\/?>/gi;
  let exeMatch;
  while ((exeMatch = exeRegex.exec(cleanXml)) !== null) {
    const attrs = exeMatch[1];
    const rawExeName = extractXmlAttr(attrs, 'Name');
    if (!rawExeName) continue;
    const deviceFamily = extractXmlAttr(attrs, 'TargetDeviceFamily');
    if (/^(?:XboxOne|Scarlett|Console)$/i.test(deviceFamily)) continue;
    rawExecutables.push(rawExeName);
  }
  const exeRel = rawExecutables[0] || '';
  const executablePath = exeRel ? normalizeRelAsset(exeRel) : '';

  const displayName =
    sv.defaultDisplayName ||
    appxFallbackDisplayName ||
    (gameFolderPath ? path.basename(gameFolderPath) : '');
  const publisherDisplayName =
    sv.publisherDisplayName || appxFallbackPublisherDisplayName || '';

  return {
    xboxRoot,
    gameFolderPath,
    configDir,
    configFilePath,
    productId,
    identityName,
    identityPublisher,
    packageFamilyName,
    identityVersion,
    titleId,
    titleIdHex: coreParsed.titleId || '',
    scid: coreParsed.scid || '',
    msaAppId: coreParsed.msaAppId || '',
    title: displayName,
    publisher: publisherDisplayName,
    executablePath: verifyContainedExecutableFile(executablePath, configDir, xboxRoot, platform),
    visuals: {
      square480Path,
      splashScreenPath,
      square150Path,
      square44Path,
      storeLogoPath,
    },
  };
}

/**
 * @param {string} xmlStr
 * @param {string} appxFilePath
 * @param {string} gameFolderPath
 * @param {string} [xboxRoot]
 * @param {string} [platform]
 */
function parseAppxManifestFolderFallback(xmlStr, appxFilePath, gameFolderPath, xboxRoot, platform) {
  const appxParsed = parseAppxManifestXml(xmlStr);
  if (!appxParsed || appxParsed.isFramework || appxParsed.isResourcePackage) return null;
  const configDir = path.dirname(appxFilePath);
  const identityName = String(appxParsed.identity?.name || '').trim();
  const identityPublisher = String(appxParsed.identity?.publisher || '').trim();
  const packageFamilyName = String(
    appxParsed.packageFamilyName || computePackageFamilyName(identityName, identityPublisher) || ''
  ).trim();

  /** @param {unknown} rel */
  const normalizeRelAsset = (rel) =>
    resolveContainedManifestAssetPath(configDir, rel, xboxRoot, platform);

  const cleanXml = stripXmlComments(String(xmlStr || '')).replace(/^\uFEFF/, '');
  const firstAppMatch = /<Application\b([^>]*)>/i.exec(cleanXml);
  const rawAppExe = firstAppMatch ? extractXmlAttr(firstAppMatch[1], 'Executable') : '';
  const executablePath = rawAppExe ? normalizeRelAsset(rawAppExe) : '';
  const visualMatch = /<uap:VisualElements\b([^>]*)\/?>/i.exec(cleanXml);
  const square150Path = visualMatch
    ? normalizeRelAsset(extractXmlAttr(visualMatch[1], 'Square150x150Logo'))
    : '';
  const square44Path = visualMatch
    ? normalizeRelAsset(extractXmlAttr(visualMatch[1], 'Square44x44Logo'))
    : '';
  const storeLogoTag = /<Logo[^>]*>([^<]+)<\/Logo>/i.exec(cleanXml);
  const storeLogoPath = storeLogoTag ? normalizeRelAsset(storeLogoTag[1].trim()) : '';

  return {
    xboxRoot,
    gameFolderPath,
    configDir,
    configFilePath: appxFilePath,
    productId: '',
    identityName,
    identityPublisher,
    packageFamilyName,
    identityVersion: String(appxParsed.identity?.version || '').trim(),
    titleId: '',
    titleIdHex: '',
    scid: '',
    msaAppId: '',
    title:
      (appxParsed.displayName && !appxParsed.displayName.startsWith('ms-resource:')
        ? appxParsed.displayName
        : '') || path.basename(gameFolderPath),
    publisher:
      appxParsed.publisherDisplayName && !appxParsed.publisherDisplayName.startsWith('ms-resource:')
        ? appxParsed.publisherDisplayName
        : '',
    executablePath: verifyContainedExecutableFile(executablePath, configDir, xboxRoot, platform),
    visuals: {
      square480Path: '',
      splashScreenPath: '',
      square150Path,
      square44Path,
      storeLogoPath,
    },
  };
}

/**
 * @param {any} roots
 * @param {Record<string, any>} [options]
 */
function scanLocalXboxGameManifests(roots, options = {}) {
  const xboxRoots = Array.isArray(roots?.xboxGamesRoots) ? roots.xboxGamesRoots : [];
  /** @type {any[]} */
  const manifests = [];

  for (const xboxRoot of xboxRoots) {
    if (!isExistingDirectory(xboxRoot)) continue;
    let gameDirs = [];
    try {
      gameDirs = fs.readdirSync(xboxRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of gameDirs) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      const gameFolderPath = path.join(xboxRoot, dirent.name);
      const configCandidates = [
        path.join(gameFolderPath, 'Content', 'MicrosoftGame.config'),
        path.join(gameFolderPath, 'MicrosoftGame.config'),
      ];

      let foundForFolder = false;
      for (const cfgPath of configCandidates) {
        if (!isExistingFile(cfgPath)) continue;
        if (!isContainedWithinRoot(xboxRoot, cfgPath, options.platform)) continue;
        try {
          const st = fs.statSync(cfgPath);
          const cacheKey = `${cfgPath}::${st.mtimeMs}::${st.size}`;
          let parsed = xboxManifestScanLookup.get(cacheKey);
          if (!parsed) {
            const xmlStr = fs.readFileSync(cfgPath, 'utf8');
            parsed = parseMicrosoftGameConfigXml(
              xmlStr,
              cfgPath,
              gameFolderPath,
              xboxRoot,
              options.platform
            );
            if (parsed) {
              setBoundedCache(
                xboxManifestScanLookup,
                cacheKey,
                parsed,
                MAX_XBOX_MANIFEST_LOOKUP_ENTRIES
              );
            }
          }
          if (parsed) {
            manifests.push(parsed);
            foundForFolder = true;
            break;
          }
        } catch {}
      }

      if (!foundForFolder) {
        const appxCandidates = [
          path.join(gameFolderPath, 'Content', 'AppxManifest.xml'),
          path.join(gameFolderPath, 'AppxManifest.xml'),
        ];
        for (const appxPath of appxCandidates) {
          if (!isExistingFile(appxPath)) continue;
          if (!isContainedWithinRoot(xboxRoot, appxPath, options.platform)) continue;
          try {
            const st = fs.statSync(appxPath);
            const cacheKey = `appx::${appxPath}::${st.mtimeMs}::${st.size}`;
            let parsed = xboxManifestScanLookup.get(cacheKey);
            if (!parsed) {
              const xmlStr = fs.readFileSync(appxPath, 'utf8');
              parsed = parseAppxManifestFolderFallback(
                xmlStr,
                appxPath,
                gameFolderPath,
                xboxRoot,
                options.platform
              );
              if (parsed) {
                setBoundedCache(
                  xboxManifestScanLookup,
                  cacheKey,
                  parsed,
                  MAX_XBOX_MANIFEST_LOOKUP_ENTRIES
                );
              }
            }
            if (parsed) {
              manifests.push(parsed);
              break;
            }
          } catch {}
        }
      }
    }
  }

  return manifests;
}

/**
 * Async variant of `scanLocalXboxGameManifests` using `fs.promises`.
 *
 * @param {any} roots
 * @param {Record<string, any>} [options]
 */
async function scanLocalXboxGameManifestsAsync(roots, options = {}) {
  const xboxRoots = Array.isArray(roots?.xboxGamesRoots) ? roots.xboxGamesRoots : [];
  /** @type {any[]} */
  const manifests = [];

  for (const xboxRoot of xboxRoots) {
    if (!(await isExistingDirectoryAsync(xboxRoot))) continue;
    let gameDirs = [];
    try {
      gameDirs = await fs.promises.readdir(xboxRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of gameDirs) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      const gameFolderPath = path.join(xboxRoot, dirent.name);
      const configCandidates = [
        path.join(gameFolderPath, 'Content', 'MicrosoftGame.config'),
        path.join(gameFolderPath, 'MicrosoftGame.config'),
      ];

      let foundForFolder = false;
      for (const cfgPath of configCandidates) {
        if (!isContainedWithinRoot(xboxRoot, cfgPath, options.platform)) continue;
        try {
          const st = await fs.promises.stat(cfgPath);
          if (!st.isFile()) continue;
          const cacheKey = `${cfgPath}::${st.mtimeMs}::${st.size}`;
          let parsed = xboxManifestScanLookup.get(cacheKey);
          if (!parsed) {
            const xmlStr = await fs.promises.readFile(cfgPath, 'utf8');
            parsed = parseMicrosoftGameConfigXml(
              xmlStr,
              cfgPath,
              gameFolderPath,
              xboxRoot,
              options.platform
            );
            if (parsed) {
              setBoundedCache(
                xboxManifestScanLookup,
                cacheKey,
                parsed,
                MAX_XBOX_MANIFEST_LOOKUP_ENTRIES
              );
            }
          }
          if (parsed) {
            manifests.push(parsed);
            foundForFolder = true;
            break;
          }
        } catch {}
      }

      if (!foundForFolder) {
        const appxCandidates = [
          path.join(gameFolderPath, 'Content', 'AppxManifest.xml'),
          path.join(gameFolderPath, 'AppxManifest.xml'),
        ];
        for (const appxPath of appxCandidates) {
          if (!isContainedWithinRoot(xboxRoot, appxPath, options.platform)) continue;
          try {
            const st = await fs.promises.stat(appxPath);
            if (!st.isFile()) continue;
            const cacheKey = `appx::${appxPath}::${st.mtimeMs}::${st.size}`;
            let parsed = xboxManifestScanLookup.get(cacheKey);
            if (!parsed) {
              const xmlStr = await fs.promises.readFile(appxPath, 'utf8');
              parsed = parseAppxManifestFolderFallback(
                xmlStr,
                appxPath,
                gameFolderPath,
                xboxRoot,
                options.platform
              );
              if (parsed) {
                setBoundedCache(
                  xboxManifestScanLookup,
                  cacheKey,
                  parsed,
                  MAX_XBOX_MANIFEST_LOOKUP_ENTRIES
                );
              }
            }
            if (parsed) {
              manifests.push(parsed);
              break;
            }
          } catch {}
        }
      }
    }
  }

  return manifests;
}

/**
 * @param {any[]} manifests
 * @param {{ productId?: string, pfn?: string, titleId?: string, title?: string }} query
 */
function matchXboxManifest(manifests, { productId = '', pfn = '', titleId = '', title = '' }) {
  const cleanProd = String(productId || '').toUpperCase();
  const cleanPfnLower = String(pfn || '').toLowerCase();
  const pfnPrefixLower = cleanPfnLower.includes('_')
    ? cleanPfnLower.slice(0, cleanPfnLower.lastIndexOf('_'))
    : cleanPfnLower;
  const cleanTid = String(titleId || '').trim();
  const cleanTidUpper = cleanTid.replace(/^0x/i, '').toUpperCase();
  const normTitle = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  for (const m of manifests) {
    if (cleanProd && m.productId && m.productId === cleanProd) return m;
    if (cleanPfnLower) {
      if (m.packageFamilyName && m.packageFamilyName.toLowerCase() === cleanPfnLower) {
        return m;
      }
      if (m.identityName) {
        const idLower = m.identityName.toLowerCase();
        if (idLower === cleanPfnLower || (pfnPrefixLower && idLower === pfnPrefixLower)) {
          return m;
        }
      }
    }
    if (
      cleanTid &&
      ((m.titleId && m.titleId === cleanTid) ||
        (m.titleIdHex && m.titleIdHex.toUpperCase() === cleanTidUpper))
    ) {
      return m;
    }
  }

  if (normTitle) {
    for (const m of manifests) {
      const candNorm = String(m.title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      if (candNorm && candNorm === normTitle) return m;
    }
  }
  return null;
}

/**
 * Resolves a zero-copy local Xbox artwork asset from `<Drive>:\XboxGames\*\Content\MicrosoftGame.config`
 * `<ShellVisuals>` or `Microsoft.GamingApp_8wekyb3d8bbwe\LocalState` / `LocalCache` image caches.
 *
 * @param {any} xboxParamsOrPayload
 * @param {any} [role]
 * @param {any} [url]
 * @param {any} [roots]
 * @param {Record<string, any>} [options]
 */
function resolveXboxFederatedAsset(xboxParamsOrPayload, role, url, roots, options = {}) {
  if (
    arguments.length <= 2 &&
    xboxParamsOrPayload &&
    typeof xboxParamsOrPayload === 'object' &&
    (!roots || typeof roots !== 'object')
  ) {
    const opts = role && typeof role === 'object' ? role : {};
    const resolvedRoots = opts._precomputedRoots || discoverStorefrontCacheRoots(opts);
    const extracted = extractXboxParams(xboxParamsOrPayload);
    const resolvedRole = String(xboxParamsOrPayload.role || 'cover').trim();
    const resolvedUrl =
      typeof xboxParamsOrPayload.url === 'string' ? xboxParamsOrPayload.url.trim() : '';
    return resolveXboxFederatedAsset(extracted, resolvedRole, resolvedUrl, resolvedRoots, {
      ...opts,
      title: xboxParamsOrPayload.title || opts.title,
    });
  }
  const xboxParams = xboxParamsOrPayload || {};
  if (url && !isFederatedStoreUrlCompatible('xbox', url, xboxParams)) {
    return null;
  }
  const manifests = scanLocalXboxGameManifests(roots, options);
  const matched = matchXboxManifest(manifests, {
    ...xboxParams,
    title: options.title,
  });

  if (matched) {
    const v = matched.visuals || {};
    const orderedCandidates =
      role === 'header'
        ? [v.splashScreenPath, v.square480Path, v.storeLogoPath]
        : role === 'icon'
          ? [v.square150Path, v.square44Path, v.storeLogoPath, v.square480Path]
          : [v.square480Path, v.storeLogoPath, v.square150Path, v.splashScreenPath];

    for (const candidate of orderedCandidates) {
      if (!candidate) continue;
      const validated = validateFederatedImageFile(candidate, matched.xboxRoot, options);
      if (validated.valid) {
        return {
          path: validated.path,
          mimeType: validated.mimeType,
          ext: validated.ext,
          sizeBytes: validated.sizeBytes,
          source: 'xbox_microsoft_game_config',
        };
      }
    }
  }

  const cacheDirs = Array.isArray(roots?.xboxAppCacheDirs) ? roots.xboxAppCacheDirs : [];
  if (cacheDirs.length > 0 && (xboxParams.productId || url)) {
    const urlHash =
      url && /^https?:\/\//i.test(url)
        ? crypto.createHash('sha256').update(url).digest('hex')
        : '';
    const stems = [
      ...(xboxParams.productId
        ? [`${xboxParams.productId}_${role}`, xboxParams.productId]
        : []),
      ...(urlHash ? [urlHash] : []),
    ];
    const exts = ['png', 'jpg', 'jpeg', 'webp'];

    for (const cacheDir of cacheDirs) {
      const subDirs = [cacheDir, path.join(cacheDir, 'ImageCache'), path.join(cacheDir, 'Images')];
      for (const dir of subDirs) {
        if (!isExistingDirectory(dir)) continue;
        for (const stem of stems) {
          for (const ext of exts) {
            const candidate = path.join(dir, `${stem}.${ext}`);
            const validated = validateFederatedImageFile(candidate, cacheDir, options);
            if (validated.valid) {
              return {
                path: validated.path,
                mimeType: validated.mimeType,
                ext: validated.ext,
                sizeBytes: validated.sizeBytes,
                source: 'xbox_gaming_app_cache',
              };
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Async variant of `resolveXboxFederatedAsset` using `fs.promises`.
 *
 * @param {any} xboxParamsOrPayload
 * @param {any} [role]
 * @param {any} [url]
 * @param {any} [roots]
 * @param {Record<string, any>} [options]
 */
async function resolveXboxFederatedAssetAsync(xboxParamsOrPayload, role, url, roots, options = {}) {
  if (
    arguments.length <= 2 &&
    xboxParamsOrPayload &&
    typeof xboxParamsOrPayload === 'object' &&
    (!roots || typeof roots !== 'object')
  ) {
    const opts = role && typeof role === 'object' ? role : {};
    const resolvedRoots = opts._precomputedRoots || (await discoverStorefrontCacheRootsAsync(opts));
    const extracted = extractXboxParams(xboxParamsOrPayload);
    const resolvedRole = String(xboxParamsOrPayload.role || 'cover').trim();
    const resolvedUrl =
      typeof xboxParamsOrPayload.url === 'string' ? xboxParamsOrPayload.url.trim() : '';
    return resolveXboxFederatedAssetAsync(extracted, resolvedRole, resolvedUrl, resolvedRoots, {
      ...opts,
      title: xboxParamsOrPayload.title || opts.title,
    });
  }
  const xboxParams = xboxParamsOrPayload || {};
  if (url && !isFederatedStoreUrlCompatible('xbox', url, xboxParams)) {
    return null;
  }
  const manifests = await scanLocalXboxGameManifestsAsync(roots, options);
  const matched = matchXboxManifest(manifests, {
    ...xboxParams,
    title: options.title,
  });

  if (matched) {
    const v = matched.visuals || {};
    const orderedCandidates =
      role === 'header'
        ? [v.splashScreenPath, v.square480Path, v.storeLogoPath]
        : role === 'icon'
          ? [v.square150Path, v.square44Path, v.storeLogoPath, v.square480Path]
          : [v.square480Path, v.storeLogoPath, v.square150Path, v.splashScreenPath];

    for (const candidate of orderedCandidates) {
      if (!candidate) continue;
      const validated = await validateFederatedImageFileAsync(candidate, matched.xboxRoot, options);
      if (validated.valid) {
        return {
          path: validated.path,
          mimeType: validated.mimeType,
          ext: validated.ext,
          sizeBytes: validated.sizeBytes,
          source: 'xbox_microsoft_game_config',
        };
      }
    }
  }

  const cacheDirs = Array.isArray(roots?.xboxAppCacheDirs) ? roots.xboxAppCacheDirs : [];
  if (cacheDirs.length > 0 && (xboxParams.productId || url)) {
    const urlHash =
      url && /^https?:\/\//i.test(url)
        ? crypto.createHash('sha256').update(url).digest('hex')
        : '';
    const stems = [
      ...(xboxParams.productId
        ? [`${xboxParams.productId}_${role}`, xboxParams.productId]
        : []),
      ...(urlHash ? [urlHash] : []),
    ];
    const exts = ['png', 'jpg', 'jpeg', 'webp'];

    for (const cacheDir of cacheDirs) {
      const subDirs = [cacheDir, path.join(cacheDir, 'ImageCache'), path.join(cacheDir, 'Images')];
      for (const dir of subDirs) {
        if (!(await isExistingDirectoryAsync(dir))) continue;
        for (const stem of stems) {
          for (const ext of exts) {
            const candidate = path.join(dir, `${stem}.${ext}`);
            const validated = await validateFederatedImageFileAsync(candidate, cacheDir, options);
            if (validated.valid) {
              return {
                path: validated.path,
                mimeType: validated.mimeType,
                ext: validated.ext,
                sizeBytes: validated.sizeBytes,
                source: 'xbox_gaming_app_cache',
              };
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Resolves local Xbox game metadata from installed `MicrosoftGame.config` files.
 *
 * @param {string | Record<string, any>} productIdOrPayload
 * @param {Record<string, any>} [options]
 */
function resolveLocalXboxMetadata(productIdOrPayload, options = {}) {
  const payload =
    typeof productIdOrPayload === 'string'
      ? { xboxProductId: productIdOrPayload }
      : productIdOrPayload || {};
  const xboxParams = extractXboxParams(payload);
  const title = payload.title || options.title || '';
  if (!xboxParams.productId && !xboxParams.pfn && !xboxParams.titleId && !title) {
    return null;
  }

  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);
  const manifests = scanLocalXboxGameManifests(roots, options);
  const matched = matchXboxManifest(manifests, { ...xboxParams, title });
  if (!matched) return null;

  return {
    appId: 0,
    xboxProductId: matched.productId || xboxParams.productId || undefined,
    identityName: matched.identityName || undefined,
    packageFamilyName:
      matched.packageFamilyName || xboxParams.pfn || matched.identityName || undefined,
    xboxTitleId: matched.titleId || xboxParams.titleId || undefined,
    scid: matched.scid || undefined,
    msaAppId: matched.msaAppId || undefined,
    name: matched.title || undefined,
    title: matched.title || undefined,
    shortDescription: '',
    detailedDescription: '',
    aboutTheGame: '',
    developers: matched.publisher ? [matched.publisher] : [],
    publishers: matched.publisher ? [matched.publisher] : [],
    genres: [],
    tags: ['Xbox'],
    categories: [],
    screenshots: [],
    movies: [],
    releaseDate: '',
    installPath: matched.configDir,
    executablePath: matched.executablePath,
    platforms: { windows: true, mac: false, linux: false },
    metadataQuality: 'local_federated',
  };
}

/**
 * Async variant of `resolveLocalXboxMetadata`.
 *
 * @param {string | Record<string, any>} productIdOrPayload
 * @param {Record<string, any>} [options]
 */
async function resolveLocalXboxMetadataAsync(productIdOrPayload, options = {}) {
  const payload =
    typeof productIdOrPayload === 'string'
      ? { xboxProductId: productIdOrPayload }
      : productIdOrPayload || {};
  const xboxParams = extractXboxParams(payload);
  const title = payload.title || options.title || '';
  if (!xboxParams.productId && !xboxParams.pfn && !xboxParams.titleId && !title) {
    return null;
  }

  const roots = options._precomputedRoots || (await discoverStorefrontCacheRootsAsync(options));
  const manifests = await scanLocalXboxGameManifestsAsync(roots, options);
  const matched = matchXboxManifest(manifests, { ...xboxParams, title });
  if (!matched) return null;

  return {
    appId: 0,
    xboxProductId: matched.productId || xboxParams.productId || undefined,
    identityName: matched.identityName || undefined,
    packageFamilyName:
      matched.packageFamilyName || xboxParams.pfn || matched.identityName || undefined,
    xboxTitleId: matched.titleId || xboxParams.titleId || undefined,
    scid: matched.scid || undefined,
    msaAppId: matched.msaAppId || undefined,
    name: matched.title || undefined,
    title: matched.title || undefined,
    shortDescription: '',
    detailedDescription: '',
    aboutTheGame: '',
    developers: matched.publisher ? [matched.publisher] : [],
    publishers: matched.publisher ? [matched.publisher] : [],
    genres: [],
    tags: ['Xbox'],
    categories: [],
    screenshots: [],
    movies: [],
    releaseDate: '',
    installPath: matched.configDir,
    executablePath: matched.executablePath,
    platforms: { windows: true, mac: false, linux: false },
    metadataQuality: 'local_federated',
  };
}

/**
 * Enumerates all locally installed Xbox games discovered via `MicrosoftGame.config` / `AppxManifest.xml`.
 *
 * @param {Record<string, any>} [options]
 */
function listLocalXboxInstalledGames(options = {}) {
  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);
  return scanLocalXboxGameManifests(roots, options).map((m) => ({
    xboxProductId: m.productId || undefined,
    identityName: m.identityName || undefined,
    packageFamilyName: m.packageFamilyName || undefined,
    pfn: m.packageFamilyName || undefined,
    scid: m.scid || undefined,
    version: m.identityVersion || undefined,
    xboxTitleId: m.titleId || undefined,
    msaAppId: m.msaAppId || undefined,
    title: m.title,
    publisher: m.publisher || undefined,
    installPath: m.configDir,
    gameFolderPath: m.gameFolderPath,
    executablePath: m.executablePath,
  }));
}

function clearXboxManifestCaches() {
  xboxManifestScanLookup.clear();
}

module.exports = {
  resolveContainedManifestAssetPath,
  parseMicrosoftGameConfigXml,
  parseAppxManifestFolderFallback,
  scanLocalXboxGameManifests,
  scanLocalXboxGameManifestsAsync,
  matchXboxManifest,
  resolveXboxFederatedAsset,
  resolveXboxFederatedAssetAsync,
  resolveLocalXboxMetadata,
  resolveLocalXboxMetadataAsync,
  listLocalXboxInstalledGames,
  clearXboxManifestCaches,
};
