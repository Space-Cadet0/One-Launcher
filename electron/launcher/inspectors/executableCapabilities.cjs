// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  derivePeGraphicsCapabilities,
  inspectWindowsExecutableHeader,
  inspectPeCapabilities,
  isCompatibleX86OrX64PeHeader,
} = require('./peAndMachOInspector.cjs');
const {
  resolveCaseInsensitiveRelFile,
  parseLauncherSettingsCfg,
  resolveParadoxLauncherSettings,
} = require('./xboxAndAntiCheatInspectors.cjs');

const AUXILIARY_NON_GAME_EXE_RE =
  /^(?:unins\d+|uninstall.*|setup|dxsetup|vcredist.*|vc_redist.*|dotnet.*|ndp\d+.*|oalinst|physx.*|crashreport.*|crashhandler.*|crashsender.*|unitycrashhandler.*|ue4prereqsetup.*|ueprereqsetup.*|gamelaunchhelper|custominstallexec|galaxycommunication|dosbox|scummvm)\.exe$/i;

const SYSTEM_GRAPHICS_PROXY_DLL_RE =
  /^(?:d3d(?:8|9|10|10_1|10core|11|12|12core)|dxgi|ddraw|d3dim|d3dim700|opengl32|vulkan-1|wined3d)\.dll$/i;

const NON_ENGINE_REDIST_DLL_RE =
  /^(?:msvcp\d+|vcruntime\d+|ucrtbase|concrt\d+|vcomp\d+|mfc\d+|api-ms-win-|ext-ms-win-|xinput|dinput|bink|fmod|steam_api|galaxy|eossdk|nvngx|amd_ags|sl\.|libxess|libcef|chrome_elf|libegl|libglesv2|vk_swiftshader|swiftshader|qt\d+(?:webengine|gui|widgets|core|quick|network|qml)|webview2|discord|crashpad|breakpad|sentry|ffmpeg|avcodec|avformat|avutil|swscale|d3dcompiler|dxcompiler|dxil|icu(?:dt|in|uc))/i;

/**
 * Bounded read-only check for Unreal Engine 5 IoStore `.utoc` containers (`<root>/.../Content/Paks/*.utoc`).
 * Max directory depth: 3, max inspected directory entries: 60 per candidate root.
 *
 * @param {string} installDir
 * @param {string} [targetExePath]
 * @returns {boolean}
 */
function detectUe5IoStoreContainer(installDir, targetExePath = '') {
  /** @type {string[]} */
  const candidateRoots = [];
  /** @param {string} dir */
  const pushRoot = (dir) => {
    if (!dir || typeof dir !== 'string') return;
    const resolved = path.resolve(dir);
    if (!candidateRoots.includes(resolved)) {
      candidateRoots.push(resolved);
    }
  };
  if (installDir) pushRoot(installDir);
  if (targetExePath) {
    const exeParent = path.dirname(targetExePath);
    pushRoot(path.resolve(exeParent, '..', '..'));
    pushRoot(exeParent);
  }
  if (candidateRoots.length === 0) return false;

  /**
   * @param {string} paksDir
   * @param {{ remaining: number }} budget
   */
  const paksDirHasUtoc = (paksDir, budget) => {
    if (budget.remaining <= 0) return false;
    try {
      const entries = fs.readdirSync(paksDir, { withFileTypes: true }).slice(0, 60);
      for (let i = 0; i < entries.length && budget.remaining > 0; i += 1) {
        budget.remaining -= 1;
        const entry = entries[i];
        if (entry.isFile() && /\.utoc$/i.test(entry.name)) {
          return true;
        }
      }
    } catch {}
    return false;
  };

  /**
   * @param {string} contentDir
   * @param {{ remaining: number }} budget
   */
  const contentDirHasPaksUtoc = (contentDir, budget) => {
    if (budget.remaining <= 0) return false;
    try {
      const entries = fs.readdirSync(contentDir, { withFileTypes: true }).slice(0, 32);
      for (let i = 0; i < entries.length && budget.remaining > 0; i += 1) {
        budget.remaining -= 1;
        const entry = entries[i];
        if (entry.isDirectory() && entry.name.toLowerCase() === 'paks') {
          if (paksDirHasUtoc(path.join(contentDir, entry.name), budget)) {
            return true;
          }
        }
      }
    } catch {}
    return false;
  };

  const SKIP_UE_SUBDIR_RE =
    /^(?:binaries|engine|saved|intermediate|deriveddatacache|shadercompileworker|redist|_commonredist|__installer|\.git)$/i;

  for (let rIdx = 0; rIdx < candidateRoots.length; rIdx += 1) {
    const rootDir = candidateRoots[rIdx];
    const budget = { remaining: 60 };
    /** @type {Array<{ dir: string, depth: number }>} */
    const queue = [{ dir: rootDir, depth: 0 }];
    while (queue.length > 0 && budget.remaining > 0) {
      const current = queue.shift();
      if (!current) break;
      let entries;
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true }).slice(0, 60);
      } catch {
        continue;
      }
      for (let i = 0; i < entries.length && budget.remaining > 0; i += 1) {
        budget.remaining -= 1;
        const entry = entries[i];
        if (!entry.isDirectory()) continue;
        const lower = entry.name.toLowerCase();
        if (lower === 'content') {
          if (contentDirHasPaksUtoc(path.join(current.dir, entry.name), budget)) {
            return true;
          }
        } else if (current.depth < 3 && !SKIP_UE_SUBDIR_RE.test(entry.name)) {
          queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
        }
      }
    }
  }
  return false;
}

/**
 * Resolve effective architecture and graphics API capabilities across a primary executable
 * and any delegated child game executable (discovered via `launcher_settings.cfg`,
 * `goggame-*.info` `playTasks`, or sibling game `.exe` binaries alongside a lightweight bootstrapper).
 *
 * @param {string} exePath
 * @param {string} [localInstallDir]
 * @param {Record<string, any>} [options]
 */
function resolveEffectiveGameExecutableCapabilities(exePath, localInstallDir = '', options = {}) {
  const normalizedExePath = typeof exePath === 'string' ? exePath.trim() : '';
  const normalizedInstallDir = typeof localInstallDir === 'string' ? localInstallDir.trim() : '';
  const exeDir = normalizedExePath ? path.dirname(normalizedExePath) : '';
  const rdataBudget =
    options && options.rdataBudget && typeof options.rdataBudget.remaining === 'number'
      ? options.rdataBudget
      : { remaining: 16 * 1024 * 1024 };
  const inspectOpts = { ...(options && typeof options === 'object' ? options : {}), rdataBudget };

  /** @type {Record<string, any>} */
  const primaryPe = normalizedExePath
    ? inspectPeCapabilities(normalizedExePath, inspectOpts)
    : {
        exists: false,
        isValidPe: false,
        is32Bit: false,
        is64Bit: false,
        isX64: false,
        isX86: false,
        isArm64: false,
        is16BitDos: false,
        isLargeAddressAware: false,
        isNxCompat: false,
        isDynamicBase: false,
        machineArch: 'unknown',
        importedDlls: /** @type {string[]} */ ([]),
        delayImportedDlls: /** @type {string[]} */ ([]),
        dynamicallyLoadsOpenGl: false,
        dynamicallyLoadsDirectDraw: false,
        dynamicallyLoadsD3d11: false,
        dynamicallyLoadsD3d12: false,
        dynamicallyLoadsDxgi: false,
        dynamicallyLoadsVulkan: false,
        hasDpiAwareManifest: false,
        declaresPerMonitorDpi: false,
        callsPerMonitorDpiApi: false,
        usesDynamicQgl: false,
        importsD3d12: false,
        importsD3d11Or10: false,
        importsD3d9: false,
        importsLegacyD3dOrGl: false,
        importsVulkan: false,
        hasUe5IoStoreContainer: false,
        isD3d12Only: false,
      };

  const launcherSettings = parseLauncherSettingsCfg(
    normalizedExePath || normalizedInstallDir,
    normalizedInstallDir
  );
  const paradoxSettings = resolveParadoxLauncherSettings(
    normalizedExePath || normalizedInstallDir,
    normalizedInstallDir
  );

  const DOSBOX_EXE_RE = /^dosbox[^\\/]*\.exe$/i;
  const hasPrimaryDirectGfx = Boolean(
    primaryPe.importsD3d12 ||
      primaryPe.importsD3d11Or10 ||
      primaryPe.importsD3d9 ||
      primaryPe.importsLegacyD3dOrGl ||
      primaryPe.importsVulkan ||
      primaryPe.importsSdl1 ||
      primaryPe.importsModernSdl
  );
  const isLauncherStubCandidate = Boolean(
    primaryPe.exists && primaryPe.isValidPe && !hasPrimaryDirectGfx && !primaryPe.isDosboxExecutable
  );

  /** @type {string[]} */
  const candidateChildExePaths = [];
  /** @type {string[]} */
  const fallbackEmulatorChildPaths = [];
  /** @type {Set<string>} */
  const discoveredTaskBasenamesLower = new Set();
  /**
   * @param {string} p
   * @param {{ allowEmulator?: boolean }} [opts]
   */
  const pushChildCandidate = (p, opts = {}) => {
    if (!p || typeof p !== 'string') return;
    if (normalizedExePath && path.resolve(p) === path.resolve(normalizedExePath)) return;
    const base = path.basename(p);
    if (DOSBOX_EXE_RE.test(base)) {
      if (opts && opts.allowEmulator) {
        if (!candidateChildExePaths.some((existing) => path.resolve(existing) === path.resolve(p))) {
          candidateChildExePaths.push(p);
        }
      } else if (
        !fallbackEmulatorChildPaths.some((existing) => path.resolve(existing) === path.resolve(p))
      ) {
        fallbackEmulatorChildPaths.push(p);
      }
      return;
    }
    if (AUXILIARY_NON_GAME_EXE_RE.test(base)) return;
    if (!candidateChildExePaths.some((existing) => path.resolve(existing) === path.resolve(p))) {
      candidateChildExePaths.push(p);
    }
  };

  if (launcherSettings.resolvedTargetExePath) {
    pushChildCandidate(launcherSettings.resolvedTargetExePath, { allowEmulator: true });
  }
  if (paradoxSettings.paradoxDirectGameExe) {
    pushChildCandidate(paradoxSettings.paradoxDirectGameExe);
  }

  /** @type {string[]} */
  const compatFlagTokens = [];
  /** @type {string[]} */
  const gogGameCategoryPaths = [];
  /** @type {string[]} */
  const infoSearchDirs = [];
  if (normalizedInstallDir) infoSearchDirs.push(normalizedInstallDir);
  if (exeDir && !infoSearchDirs.includes(exeDir)) infoSearchDirs.push(exeDir);

  for (const searchDir of infoSearchDirs) {
    try {
      if (!fs.existsSync(searchDir) || !fs.statSync(searchDir).isDirectory()) continue;
      const entries = fs.readdirSync(searchDir).slice(0, 64);
      for (const name of entries) {
        if (!/^goggame-\d+\.info$/i.test(name)) continue;
        const infoFile = path.join(searchDir, name);
        const st = fs.statSync(infoFile);
        if (!st.isFile() || st.size <= 0 || st.size > 262144) continue;
        const parsed = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
        const playTasks = Array.isArray(parsed?.playTasks) ? parsed.playTasks : [];
        for (const task of playTasks) {
          if (!task || typeof task !== 'object') continue;
          if (typeof task.compatibilityFlags === 'string' && task.compatibilityFlags.trim()) {
            for (const tok of task.compatibilityFlags.trim().split(/\s+/)) {
              if (tok && !compatFlagTokens.includes(tok)) {
                compatFlagTokens.push(tok);
              }
            }
          }
          if (typeof task.path === 'string' && /\.exe$/i.test(task.path.trim())) {
            const relTaskPath = task.path.trim().replace(/\\/g, '/');
            const rawTaskBase = path.posix.basename(relTaskPath).trim().toLowerCase();
            const isGameTask =
              String(task.category || '').trim().toLowerCase() === 'game' ||
              task.isPrimary === true;
            if (
              rawTaskBase &&
              /\.exe$/i.test(rawTaskBase) &&
              (DOSBOX_EXE_RE.test(rawTaskBase) || !AUXILIARY_NON_GAME_EXE_RE.test(rawTaskBase))
            ) {
              discoveredTaskBasenamesLower.add(rawTaskBase);
            }
            let resolvedTaskExe = resolveCaseInsensitiveRelFile(searchDir, relTaskPath);
            if (!resolvedTaskExe && typeof task.workingDir === 'string' && task.workingDir.trim()) {
              const relWork = task.workingDir.trim().replace(/\\/g, '/');
              resolvedTaskExe = resolveCaseInsensitiveRelFile(
                searchDir,
                `${relWork}/${relTaskPath}`
              );
            }
            if (resolvedTaskExe) {
              pushChildCandidate(resolvedTaskExe, { allowEmulator: true });
              if (
                isGameTask &&
                (!normalizedExePath ||
                  path.resolve(resolvedTaskExe) !== path.resolve(normalizedExePath))
              ) {
                gogGameCategoryPaths.push(resolvedTaskExe);
              }
            }
          }
        }
      }
    } catch {}
  }

  const ENGINE_NON_BINARY_SUBDIR_RE =
    /^(?:__installer|_commonredist|redist|directx|support|prereq|installers|easyanticheat|battleye|crashreporter|engine|content|paks|movies|assets|localization|streamingassets|saved|logs|config|shaders|audio|sound|textures|models|levels|maps|thirdparty|plugins)$/i;
  const ENGINE_BINARY_CONTAINER_RE = /^(?:bin|binaries)$/i;
  const ENGINE_ARCH_SUBDIR_RE = /^(?:win64|win32|wingdk|x64|x86|shipping|retail)$/i;
  const DIRECT_BINARY_SUBDIR_RE =
    /^(?:bin|binaries|win32|win64|wingdk|x86|x64|system|dosbox|[a-z]{2}(?:-[a-z]{2})?)$/i;

  let isLikelyBootstrapper = Boolean(launcherSettings.found || isLauncherStubCandidate);
  if (!isLikelyBootstrapper && normalizedExePath && primaryPe.exists) {
    try {
      const st = fs.statSync(normalizedExePath);
      const baseName = path.basename(normalizedExePath);
      if (
        st.size < 2 * 1024 * 1024 ||
        /(?:start|launcher|bootstrap|autorun|play|loader)/i.test(baseName)
      ) {
        isLikelyBootstrapper = true;
      }
    } catch {}
  }
  const explicitCandidateCount = candidateChildExePaths.length;
  const scanArchBinDir = (/** @type {string} */ binDir) => {
    try {
      const binEntries = fs.readdirSync(binDir, { withFileTypes: true }).slice(0, 16);
      for (const entry of binEntries) {
        if (entry.isFile() && /\.exe$/i.test(entry.name)) {
          pushChildCandidate(path.join(binDir, entry.name));
        } else if (entry.isDirectory() && ENGINE_ARCH_SUBDIR_RE.test(entry.name)) {
          const archDir = path.join(binDir, entry.name);
          const archEntries = fs.readdirSync(archDir, { withFileTypes: true }).slice(0, 16);
          for (const ae of archEntries) {
            if (ae.isFile() && /\.exe$/i.test(ae.name)) {
              pushChildCandidate(path.join(archDir, ae.name));
            }
          }
        }
      }
    } catch {}
  };
  if (isLikelyBootstrapper || (primaryPe.exists && primaryPe.isValidPe && !hasPrimaryDirectGfx)) {
    for (const scanDir of infoSearchDirs) {
      try {
        if (!fs.existsSync(scanDir) || !fs.statSync(scanDir).isDirectory()) continue;
        const dirents = fs.readdirSync(scanDir, { withFileTypes: true }).slice(0, 64);
        for (const dirent of dirents) {
          if (dirent.isFile() && /\.exe$/i.test(dirent.name)) {
            pushChildCandidate(path.join(scanDir, dirent.name));
          } else if (dirent.isDirectory() && DIRECT_BINARY_SUBDIR_RE.test(dirent.name)) {
            const subDir = path.join(scanDir, dirent.name);
            const subEntries = fs.readdirSync(subDir, { withFileTypes: true }).slice(0, 32);
            for (const sub of subEntries) {
              if (sub.isFile() && /\.exe$/i.test(sub.name)) {
                pushChildCandidate(path.join(subDir, sub.name));
              } else if (
                ENGINE_BINARY_CONTAINER_RE.test(dirent.name) &&
                sub.isDirectory() &&
                ENGINE_ARCH_SUBDIR_RE.test(sub.name)
              ) {
                const archDir = path.join(subDir, sub.name);
                const archEntries = fs.readdirSync(archDir, { withFileTypes: true }).slice(0, 16);
                for (const ae of archEntries) {
                  if (ae.isFile() && /\.exe$/i.test(ae.name)) {
                    pushChildCandidate(path.join(archDir, ae.name));
                  }
                }
              }
            }
          } else if (
            dirent.isDirectory() &&
            !dirent.name.startsWith('.') &&
            !ENGINE_NON_BINARY_SUBDIR_RE.test(dirent.name)
          ) {
            const projDir = path.join(scanDir, dirent.name);
            const projEntries = fs.readdirSync(projDir, { withFileTypes: true }).slice(0, 32);
            for (const peEnt of projEntries) {
              if (peEnt.isDirectory() && ENGINE_BINARY_CONTAINER_RE.test(peEnt.name)) {
                scanArchBinDir(path.join(projDir, peEnt.name));
              }
            }
          }
        }
      } catch {}
    }
  }
  if (candidateChildExePaths.length > explicitCandidateCount + 1) {
    const scoreScannedChild = (/** @type {string} */ p) => {
      const base = path.basename(p).toLowerCase();
      const norm = p.replace(/\\/g, '/').toLowerCase();
      let score = 0;
      if (/-shipping\.exe$/i.test(base)) score += 40;
      if (/\/(?:win64|wingdk|x64)\//i.test(norm)) score += 20;
      else if (/\/(?:binaries|bin|win32|x86)\//i.test(norm)) score += 10;
      return score;
    };
    const explicitPart = candidateChildExePaths.slice(0, explicitCandidateCount);
    const scannedPart = candidateChildExePaths
      .slice(explicitCandidateCount)
      .sort((a, b) => scoreScannedChild(b) - scoreScannedChild(a));
    candidateChildExePaths.splice(0, candidateChildExePaths.length, ...explicitPart, ...scannedPart);
  }
  if (candidateChildExePaths.length === 0 && fallbackEmulatorChildPaths.length > 0) {
    for (const emuPath of fallbackEmulatorChildPaths) {
      candidateChildExePaths.push(emuPath);
    }
  }

  /** @type {Array<{ exePath: string, pe: ReturnType<typeof inspectPeCapabilities> }>} */
  const validChildren = [];
  for (const childPath of candidateChildExePaths.slice(0, 12)) {
    const cPe = inspectPeCapabilities(childPath, inspectOpts);
    if (cPe.isValidPe && isCompatibleX86OrX64PeHeader(cPe, options)) {
      validChildren.push({ exePath: childPath, pe: cPe });
    }
  }

  let effectivePe = primaryPe;
  let effectiveExePath = normalizedExePath;
  if (validChildren.length > 0) {
    const fromLauncherCfg = launcherSettings.resolvedTargetExePath
      ? validChildren.find(
          (c) => path.resolve(c.exePath) === path.resolve(launcherSettings.resolvedTargetExePath)
        )
      : paradoxSettings.paradoxDirectGameExe
        ? validChildren.find(
            (c) => path.resolve(c.exePath) === path.resolve(paradoxSettings.paradoxDirectGameExe)
          )
        : gogGameCategoryPaths.length > 0 && !hasPrimaryDirectGfx
          ? validChildren.find((c) =>
              gogGameCategoryPaths.some((gp) => path.resolve(c.exePath) === path.resolve(gp))
            )
          : null;
    const withGraphicsImports = validChildren.find(
      (c) =>
        Boolean(
          c.pe.dynamicallyLoadsOpenGl ||
            c.pe.dynamicallyLoadsDirectDraw ||
            c.pe.dynamicallyLoadsD3d11 ||
            c.pe.dynamicallyLoadsD3d12 ||
            c.pe.dynamicallyLoadsDxgi ||
            c.pe.dynamicallyLoadsVulkan
        ) ||
        c.pe.importedDlls.some(
          (/** @type {string} */ d) =>
            d === 'opengl32.dll' ||
            d === 'ddraw.dll' ||
            d === 'd3dim.dll' ||
            d === 'd3dim700.dll' ||
            d === 'd3d8.dll' ||
            d === 'd3d9.dll' ||
            d === 'd3d10.dll' ||
            d === 'd3d10_1.dll' ||
            d === 'd3d11.dll' ||
            d === 'd3d12.dll' ||
            d === 'dxgi.dll' ||
            d === 'vulkan-1.dll' ||
            d === 'sdl.dll' ||
            d === 'sdl2.dll' ||
            d === 'sdl3.dll'
        )
    );
    if (fromLauncherCfg || !hasPrimaryDirectGfx) {
      const chosenChild = fromLauncherCfg || withGraphicsImports || validChildren[0];
      effectivePe = chosenChild.pe;
      effectiveExePath = chosenChild.exePath;
    }
  }

  const allInspectedPes = [primaryPe, ...validChildren.map((c) => c.pe)];
  /** @type {Set<string>} */
  const dllSet = new Set(primaryPe.importedDlls || []);
  for (const child of validChildren) {
    for (const dll of child.pe.importedDlls || []) {
      dllSet.add(dll);
    }
  }

  let dllDynamicOpenGl = false;
  let dllDynamicDdraw = false;
  let dllDynamicD3d11 = false;
  let dllDynamicD3d12 = false;
  let dllDynamicDxgi = false;
  let dllDynamicVulkan = false;
  const hasDirectGraphicsImport =
    allInspectedPes.some((p) =>
      Boolean(
        p.dynamicallyLoadsOpenGl ||
          p.dynamicallyLoadsDirectDraw ||
          p.dynamicallyLoadsD3d11 ||
          p.dynamicallyLoadsD3d12 ||
          p.dynamicallyLoadsDxgi ||
          p.dynamicallyLoadsVulkan
      )
    ) ||
    Array.from(dllSet).some(
      (d) =>
        d === 'd3d12.dll' ||
        d === 'd3d12core.dll' ||
        d === 'd3d11.dll' ||
        d === 'd3d10.dll' ||
        d === 'd3d10_1.dll' ||
        d === 'd3d10core.dll' ||
        d === 'd3d9.dll' ||
        d === 'd3d8.dll' ||
        d === 'ddraw.dll' ||
        d === 'd3dim.dll' ||
        d === 'd3dim700.dll' ||
        d === 'opengl32.dll' ||
        d === 'vulkan-1.dll' ||
        /^d3dx(?:9|10|11)(?:_\d+)?\.dll$/i.test(d)
    );

  if (!hasDirectGraphicsImport && (effectiveExePath || normalizedInstallDir)) {
    const MODERN_GFX_DLL_SET = new Set([
      'd3d11.dll',
      'd3d12.dll',
      'd3d12core.dll',
      'dxgi.dll',
      'vulkan-1.dll',
    ]);
    /** @type {string[]} */
    const dllScanDirs = [];
    /** @param {string} d */
    const pushDllDir = (d) => {
      if (!d || typeof d !== 'string') return;
      const res = path.resolve(d);
      if (!dllScanDirs.includes(res)) dllScanDirs.push(res);
    };
    if (effectiveExePath) pushDllDir(path.dirname(effectiveExePath));
    if (exeDir) pushDllDir(exeDir);
    if (normalizedInstallDir) pushDllDir(normalizedInstallDir);

    for (const targetExeDir of dllScanDirs) {
      try {
        if (!fs.existsSync(targetExeDir) || !fs.statSync(targetExeDir).isDirectory()) continue;
        const rawEntries = fs.readdirSync(targetExeDir, { withFileTypes: true });
        /** @type {Array<{ name: string, size: number }>} */
        const candidateDllEntries = [];
        /** @type {string[]} */
        const fallbackDllNames = [];
        for (let i = 0; i < rawEntries.length; i += 1) {
          const entry = rawEntries[i];
          if (!entry.isFile() || !/\.dll$/i.test(entry.name)) continue;
          if (SYSTEM_GRAPHICS_PROXY_DLL_RE.test(entry.name)) continue;
          if (NON_ENGINE_REDIST_DLL_RE.test(entry.name)) {
            fallbackDllNames.push(entry.name);
          } else {
            let fileSize = 0;
            try {
              fileSize = fs.statSync(path.join(targetExeDir, entry.name)).size || 0;
            } catch {}
            candidateDllEntries.push({ name: entry.name, size: fileSize });
          }
        }
        candidateDllEntries.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
        const orderedDllNames = candidateDllEntries
          .map((e) => e.name)
          .concat(fallbackDllNames)
          .slice(0, 32);
        for (let i = 0; i < orderedDllNames.length; i += 1) {
          const dllName = orderedDllNames[i];
          if (/^unityplayer\.dll$/i.test(dllName)) {
            dllSet.add('unityplayer.dll');
          }
          const dllPath = path.join(targetExeDir, dllName);
          const isRedistDll = NON_ENGINE_REDIST_DLL_RE.test(dllName);
          const dllHeader = inspectWindowsExecutableHeader(dllPath, {
            ...inspectOpts,
            skipRdataStringScan: isRedistDll ? true : Boolean(options?.skipRdataStringScan),
            skipModernDynamicScan: isRedistDll,
          });
          if (!dllHeader.isValidPe) continue;
          if (effectivePe.isValidPe && Boolean(dllHeader.is64Bit) !== Boolean(effectivePe.is64Bit)) {
            continue;
          }
          if (dllHeader.dynamicallyLoadsOpenGl) {
            dllDynamicOpenGl = true;
          }
          if (dllHeader.dynamicallyLoadsDirectDraw) {
            dllDynamicDdraw = true;
          }
          if (!isRedistDll) {
            if (dllHeader.dynamicallyLoadsD3d11) {
              dllDynamicD3d11 = true;
            }
            if (dllHeader.dynamicallyLoadsD3d12) {
              dllDynamicD3d12 = true;
            }
            if (dllHeader.dynamicallyLoadsDxgi) {
              dllDynamicDxgi = true;
            }
            if (dllHeader.dynamicallyLoadsVulkan) {
              dllDynamicVulkan = true;
            }
          }
          for (const dep of dllHeader.importedDlls || []) {
            if (isRedistDll && MODERN_GFX_DLL_SET.has(String(dep || '').toLowerCase())) {
              continue;
            }
            dllSet.add(dep);
          }
        }
      } catch {}
    }
  }

  for (const inspectedPe of allInspectedPes) {
    if (
      Array.isArray(inspectedPe.delayImportedDlls) &&
      inspectedPe.delayImportedDlls.some(
        (/** @type {string} */ d) => String(d || '').trim().toLowerCase() === 'unityplayer.dll'
      )
    ) {
      dllSet.add('unityplayer.dll');
    }
  }

  const importedDlls = Array.from(dllSet);

  const effectiveMachine =
    effectivePe.machineArch && effectivePe.machineArch !== 'unknown'
      ? effectivePe.machineArch
      : primaryPe.machineArch || 'unknown';

  const is32Bit = effectiveMachine === 'x86' || Boolean(effectivePe.isX86);
  const is64Bit =
    effectiveMachine === 'x64' ||
    effectiveMachine === 'arm64' ||
    effectiveMachine === 'arm64ec' ||
    Boolean(effectivePe.is64Bit);
  const isLargeAddressAware = is64Bit || Boolean(effectivePe.isLargeAddressAware);
  const isNxCompat = effectivePe.isValidPe ? Boolean(effectivePe.isNxCompat) : is64Bit;
  const isDynamicBase = Boolean(effectivePe.isDynamicBase);

  const hasUe5IoStoreContainer =
    Boolean(options?.hasUe5IoStoreContainer) ||
    detectUe5IoStoreContainer(normalizedInstallDir, effectiveExePath);

  const forceGlCore = /(?:^|\s)(?:-force-glcore\d*|-opengl\d*)\b/i.test(
    String(options?.launchArguments || '')
  );
  const isModernUnity64Host = Boolean(
    is64Bit && !is32Bit && dllSet.has('unityplayer.dll') && !forceGlCore
  );

  const anyDynamicQgl =
    dllDynamicOpenGl || allInspectedPes.some((p) => Boolean(p.dynamicallyLoadsOpenGl));
  const anyDynamicDdraw =
    dllDynamicDdraw || allInspectedPes.some((p) => Boolean(p.dynamicallyLoadsDirectDraw));
  const anyDynamicD3d11 =
    dllDynamicD3d11 || allInspectedPes.some((p) => Boolean(p.dynamicallyLoadsD3d11));
  const anyDynamicD3d12 =
    dllDynamicD3d12 || allInspectedPes.some((p) => Boolean(p.dynamicallyLoadsD3d12));
  const anyDynamicDxgi =
    dllDynamicDxgi || allInspectedPes.some((p) => Boolean(p.dynamicallyLoadsDxgi));
  const anyDynamicVulkan =
    dllDynamicVulkan || allInspectedPes.some((p) => Boolean(p.dynamicallyLoadsVulkan));
  const gfxCaps = derivePeGraphicsCapabilities(importedDlls, {
    usesDynamicQgl: anyDynamicQgl,
    dynamicallyLoadsDirectDraw: anyDynamicDdraw,
    dynamicallyLoadsD3d11: anyDynamicD3d11,
    dynamicallyLoadsD3d12: anyDynamicD3d12,
    dynamicallyLoadsDxgi: anyDynamicDxgi,
    dynamicallyLoadsVulkan: anyDynamicVulkan,
    hasUe5IoStoreContainer,
    is64Bit,
    forceGlCore,
  });

  const usesOpenGl =
    (importedDlls.includes('opengl32.dll') || anyDynamicQgl) && !isModernUnity64Host;
  const usesLegacyDirectDrawOrD3d =
    importedDlls.some(
      (d) => d === 'ddraw.dll' || d === 'd3dim.dll' || d === 'd3dim700.dll' || d === 'd3d8.dll'
    ) || anyDynamicDdraw;
  const usesModernGraphicsApi =
    isModernUnity64Host ||
    anyDynamicD3d11 ||
    anyDynamicD3d12 ||
    anyDynamicDxgi ||
    anyDynamicVulkan ||
    importedDlls.some(
      (d) =>
        d === 'd3d12.dll' ||
        d === 'd3d12core.dll' ||
        d === 'vulkan-1.dll' ||
        d === 'dxgi.dll' ||
        d === 'd3d11.dll'
    );
  const hasDiscoveredChildTarget = Boolean(
    validChildren.length > 0 ||
      launcherSettings.resolvedTargetExePath ||
      paradoxSettings.paradoxDirectGameExe
  );
  const isModern64Host = Boolean(
    is64Bit &&
      !is32Bit &&
      usesModernGraphicsApi &&
      !usesLegacyDirectDrawOrD3d &&
      (!usesOpenGl || !forceGlCore)
  );
  const effectiveIsLauncherStubCandidate = isModern64Host
    ? hasDiscoveredChildTarget
    : isLauncherStubCandidate;
  const isLegacy32BitOpenGl =
    effectiveMachine === 'x86' && usesOpenGl && !usesModernGraphicsApi;
  const needsLegacyDisplayModeSynthesis =
    effectiveMachine === 'x86' &&
    (usesOpenGl || usesLegacyDirectDrawOrD3d) &&
    !usesModernGraphicsApi;
  const hasDpiAwareManifest = Boolean(effectivePe.hasDpiAwareManifest);
  const declaresPerMonitorDpi = Boolean(effectivePe.declaresPerMonitorDpi);
  const callsPerMonitorDpiApi = Boolean(effectivePe.callsPerMonitorDpiApi);

  /** @type {string[]} */
  const targetExePaths = [];
  if (normalizedExePath) targetExePaths.push(normalizedExePath);
  for (const child of validChildren) {
    if (!targetExePaths.some((p) => path.resolve(p) === path.resolve(child.exePath))) {
      targetExePaths.push(child.exePath);
    }
  }

  /** @type {Set<string>} */
  const basenameSet = new Set();
  for (const p of targetExePaths) {
    const b = path.basename(p).trim().toLowerCase();
    if (b && /\.exe$/i.test(b)) basenameSet.add(b);
  }
  for (const taskBase of discoveredTaskBasenamesLower) {
    basenameSet.add(taskBase);
  }
  if (launcherSettings.binaryPath) {
    const cfgBase = path.win32.basename(launcherSettings.binaryPath).trim().toLowerCase();
    if (cfgBase && /\.exe$/i.test(cfgBase)) basenameSet.add(cfgBase);
  }
  if (paradoxSettings.paradoxDirectGameExe) {
    const pdxBase = path.basename(paradoxSettings.paradoxDirectGameExe).trim().toLowerCase();
    if (pdxBase && /\.exe$/i.test(pdxBase)) basenameSet.add(pdxBase);
  }

  const isDosboxExecutable = Boolean(
    primaryPe.isDosboxExecutable ||
      effectivePe.isDosboxExecutable ||
      Array.from(basenameSet).some((b) => DOSBOX_EXE_RE.test(b))
  );

  return {
    primaryPe,
    effectivePe,
    effectiveMachine,
    is32Bit,
    is64Bit,
    isLargeAddressAware,
    isNxCompat,
    isDynamicBase,
    importedDlls,
    ...gfxCaps,
    usesOpenGl,
    usesLegacyDirectDrawOrD3d,
    usesModernGraphicsApi,
    isLegacy32BitOpenGl,
    needsLegacyDisplayModeSynthesis,
    hasDpiAwareManifest,
    declaresPerMonitorDpi,
    callsPerMonitorDpiApi,
    isDosboxExecutable,
    isLauncherStubCandidate: effectiveIsLauncherStubCandidate,
    hasChildGameExecutable: hasDiscoveredChildTarget,
    targetExePaths,
    targetExeBasenamesLower: Array.from(basenameSet),
    launcherSettings,
    paradoxLauncherSettings: paradoxSettings,
    paradoxDirectGameExe: paradoxSettings.paradoxDirectGameExe || null,
    gogCompatibilityFlags: compatFlagTokens.join(' '),
  };
}

/**
 * Resolve the preferred GOG `playTasks` FileTask, bypassing macOS Wine-incompatible
 * `category: "launcher"` stubs (`GOGLauncher.exe` or `.NET` `mscoree.dll` launchers
 * with no custom arguments) when a sibling `category: "game"` task exists.
 *
 * @param {any[]} playTasks
 * @param {string[]} [searchDirs]
 * @param {{ platform?: string }} [options]
 * @returns {any | null}
 */
function selectPreferredGogPlayTask(playTasks, searchDirs = [], options = {}) {
  if (!Array.isArray(playTasks) || playTasks.length === 0) return null;
  const platform = options?.platform || process.platform;
  const normalizedSearchDirs = Array.from(
    new Set(
      (Array.isArray(searchDirs) ? searchDirs : [])
        .filter((d) => typeof d === 'string' && d.trim().length > 0)
        .map((d) => path.resolve(d.trim()))
    )
  );
  const isFileTask = (/** @type {any} */ t) =>
    Boolean(t && t.path && (!t.type || String(t.type) === 'FileTask'));
  const primaryTask = playTasks.find((/** @type {any} */ t) => isFileTask(t) && t.isPrimary);
  const gameCategoryTask =
    playTasks.find(
      (/** @type {any} */ t) =>
        isFileTask(t) &&
        String(t.category || '').trim().toLowerCase() === 'game' &&
        !t.isHidden
    ) ||
    playTasks.find(
      (/** @type {any} */ t) =>
        isFileTask(t) && String(t.category || '').trim().toLowerCase() === 'game'
    );

  if (
    platform === 'darwin' &&
    primaryTask &&
    String(primaryTask.category || '').trim().toLowerCase() === 'launcher' &&
    !primaryTask.arguments &&
    gameCategoryTask
  ) {
    const hasLegacyGogLauncherExe = normalizedSearchDirs.some((dir) => {
      try {
        return Boolean(resolveCaseInsensitiveRelFile(dir, 'GOGLauncher.exe'));
      } catch {
        return false;
      }
    });
    let isDotNetClrLauncher = false;
    if (!hasLegacyGogLauncherExe && typeof primaryTask.path === 'string') {
      const relTaskPath = primaryTask.path.trim().replace(/\\/g, '/');
      if (/\.exe$/i.test(relTaskPath)) {
        for (const dir of normalizedSearchDirs) {
          let resolvedPrimaryExe = resolveCaseInsensitiveRelFile(dir, relTaskPath);
          if (
            !resolvedPrimaryExe &&
            typeof primaryTask.workingDir === 'string' &&
            primaryTask.workingDir.trim()
          ) {
            const relWork = primaryTask.workingDir.trim().replace(/\\/g, '/');
            resolvedPrimaryExe = resolveCaseInsensitiveRelFile(dir, `${relWork}/${relTaskPath}`);
          }
          if (resolvedPrimaryExe) {
            const pe = inspectPeCapabilities(resolvedPrimaryExe, { skipRdataStringScan: true });
            if (
              pe.isValidPe &&
              Array.isArray(pe.importedDlls) &&
              pe.importedDlls.includes('mscoree.dll')
            ) {
              isDotNetClrLauncher = true;
            }
            break;
          }
        }
      }
    }
    if (hasLegacyGogLauncherExe || isDotNetClrLauncher) {
      return gameCategoryTask;
    }
  }
  return primaryTask || gameCategoryTask || playTasks.find(isFileTask) || null;
}

module.exports = {
  detectUe5IoStoreContainer,
  resolveEffectiveGameExecutableCapabilities,
  selectPreferredGogPlayTask,
};
