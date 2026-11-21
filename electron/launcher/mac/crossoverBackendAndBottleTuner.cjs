// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const {
  diagLog,
  getUserDataDir,
  isTestEnvironment,
  getLauncherPerformanceSettings,
  resolveEffectivePerformancePolicy,
  safeIsBottleSlug,
  recentDisplaySanitizeCache,
  pendingWineRegSyncByPrefix,
  setBoundedMapEntry,
} = require('../engineStateRegistry.cjs');
const { atomicWriteFileSync } = require('../securityAndPathUtils.cjs');
const { resolveWineDebugEnvValue } = require('../policy/configSanitizers.cjs');
const {
  resolveDriveCPathCaseInsensitive,
  sandboxWinePrefixUserFoldersAsync,
  upsertWineUserRegKey,
  upsertWineUserRegKeysBatch,
  applyStrictRosettaAvxEnv,
} = require('../wineAndCrossOverManager.cjs');
const { inspectPeCapabilities } = require('../binaryAndManifestInspectors.cjs');
const {
  extractBottleRootFromPath,
  inspectBottleConfMetadata,
  assertRunnerBottleArchCompatible,
  isValidBottleDirectory,
  hasValidInitializedBottles,
  listBottleSubdirectories,
  extractRunnerVersionInfo,
  invalidateCompatLayersCache,
} = require('./compatLayerRegistryAndDetection.cjs');
const {
  splitDyldInsertLibraries,
  ensureWineMetalPreloadDylib,
  applyUnifiedPerformanceHudEnv,
  deriveCrossOverRootFromBinaryPath,
  alignWineMsyncWithLiveBottle,
  doesWineLoaderAllowDyldInsert,
  resolveSipSafeWineBinaryAndPreloadEnv,
  prepareAlignedBottleWineCommand,
  resolveWineserverBinary,
} = require('./wineRuntimeEnvAndHud.cjs');
const {
  buildDisplaySanitizeCacheKey,
  getHostMaxDisplayResolution,
  sanitizeWinePrefixDisplayConfigs,
} = require('./bottleDisplayConfigAndMetrics.cjs');

/**
 * Curated OpenGL 1.1–3.2 + WGL extension list (< 1,250 bytes) for legacy 32-bit x86 OpenGL engines
 * whose fixed-size stack/static `GL_EXTENSIONS` / `Com_sprintf` buffers overflow when CrossOver 26+
 * advertises its 10,800+ byte Core-Profile / Apple-Silicon GL extension string.
 */
const LEGACY_32BIT_OPENGL_ENABLED_EXTENSIONS = [
  'GL_ARB_multitexture',
  'GL_ARB_texture_compression',
  'GL_ARB_texture_cube_map',
  'GL_ARB_texture_env_add',
  'GL_ARB_texture_env_combine',
  'GL_ARB_texture_env_dot3',
  'GL_ARB_texture_border_clamp',
  'GL_ARB_texture_mirrored_repeat',
  'GL_ARB_texture_non_power_of_two',
  'GL_ARB_vertex_buffer_object',
  'GL_ARB_vertex_program',
  'GL_ARB_fragment_program',
  'GL_ARB_shader_objects',
  'GL_ARB_vertex_shader',
  'GL_ARB_fragment_shader',
  'GL_ARB_shading_language_100',
  'GL_ARB_framebuffer_object',
  'GL_ARB_depth_texture',
  'GL_ARB_shadow',
  'GL_ARB_multisample',
  'GL_ARB_occlusion_query',
  'GL_ARB_pixel_buffer_object',
  'GL_ARB_draw_buffers',
  'GL_ARB_point_sprite',
  'GL_EXT_bgra',
  'GL_EXT_blend_color',
  'GL_EXT_blend_minmax',
  'GL_EXT_blend_subtract',
  'GL_EXT_blend_func_separate',
  'GL_EXT_compiled_vertex_array',
  'GL_EXT_draw_range_elements',
  'GL_EXT_fog_coord',
  'GL_EXT_multi_draw_arrays',
  'GL_EXT_secondary_color',
  'GL_EXT_separate_specular_color',
  'GL_EXT_shadow_funcs',
  'GL_EXT_stencil_two_side',
  'GL_EXT_stencil_wrap',
  'GL_EXT_texture3D',
  'GL_EXT_texture_compression_s3tc',
  'GL_EXT_texture_edge_clamp',
  'GL_EXT_texture_env_add',
  'GL_EXT_texture_env_combine',
  'GL_EXT_texture_env_dot3',
  'GL_EXT_texture_filter_anisotropic',
  'GL_EXT_texture_lod_bias',
  'GL_EXT_framebuffer_object',
  'GL_EXT_framebuffer_blit',
  'GL_ATI_separate_stencil',
  'GL_NV_texgen_reflection',
  'GL_NV_register_combiners',
  'GL_NV_texture_shader',
  'GL_SGIS_generate_mipmap',
  'GL_SGIS_texture_lod',
  'WGL_ARB_extensions_string',
  'WGL_ARB_pixel_format',
  'WGL_ARB_pbuffer',
  'WGL_ARB_render_texture',
  'WGL_ARB_multisample',
  'WGL_EXT_extensions_string',
  'WGL_EXT_swap_control',
].join(' ');

/**
 * Remove a specific named value from a section inside a Wine `.reg` file if present,
 * and record `"ValueName"=-` in `options.liveSyncAccumulator` (or live `wineserver`) when active.
 *
 * @param {string} regFilePath
 * @param {string} subKeyPath
 * @param {string} valueName
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function removeWineRegNamedValue(regFilePath, subKeyPath, valueName, options = {}) {
  if (!regFilePath || !subKeyPath || !valueName || !fs.existsSync(regFilePath)) {
    return false;
  }
  try {
    const content = fs.readFileSync(regFilePath, 'utf8');
    const normalizedSubKey = subKeyPath
      .trim()
      .replace(/^\\+|\\+$/g, '')
      .replace(/\\+/g, '\\');
    const escapedSec = normalizedSubKey
      .replace(/\\/g, '\\\\')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const secRe = new RegExp(`^\\[${escapedSec}\\](?:\\s+\\d+)?[^\\r\\n]*$`, 'im');
    const match = secRe.exec(content);
    if (!match) return false;

    const secStart = match.index + match[0].length;
    const afterSec = content.slice(secStart);
    const nextSec = /^\[[^\]]+\]/m.exec(afterSec);
    const body = nextSec ? afterSec.slice(0, nextSec.index) : afterSec;
    const rest = nextSec ? afterSec.slice(nextSec.index) : '';
    const targetLower = valueName.toLowerCase();
    let removed = false;
    const filteredLines = body.split(/\r?\n/).filter((line) => {
      const kv = line.match(/^\s*"((?:[^"\\]|\\.)+)"\s*=/);
      if (!kv) return true;
      const unescaped = kv[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (unescaped.toLowerCase() === targetLower) {
        removed = true;
        return false;
      }
      return true;
    });
    if (!removed) return false;
    atomicWriteFileSync(regFilePath, content.slice(0, secStart) + filteredLines.join('\n') + rest);

    /** @type {'HKEY_CURRENT_USER' | 'HKEY_LOCAL_MACHINE'} */
    const hiveName =
      path.basename(regFilePath).toLowerCase() === 'user.reg'
        ? 'HKEY_CURRENT_USER'
        : 'HKEY_LOCAL_MACHINE';
    if (options && Array.isArray(options.liveSyncAccumulator)) {
      options.liveSyncAccumulator.push({
        hiveName,
        normalizedSubKey,
        entryPairsOrNullForDelete: [[valueName, { delete: true }]],
      });
    } else if (options && options.bottlePath && options.skipLiveWineRegSync !== true) {
      try {
        const { syncLiveWineRegistryAsync } = require('../firstPartyRegistration.cjs');
        syncLiveWineRegistryAsync(
          options.bottlePath,
          hiveName,
          normalizedSubKey,
          [[valueName, { delete: true }]],
          options
        ).catch(() => {});
      } catch {}
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Compose `;`-delimited `DXMT_CONFIG` / `DXVK_CONFIG` clauses without overwriting existing user clauses.
 *
 * @param {string | undefined | null} existing
 * @param {string | Array<string> | Record<string, string | number | boolean> | undefined | null} additions
 * @param {{ overwriteExisting?: boolean }} [options]
 * @returns {string}
 */
function mergeSemicolonConfigClauses(existing, additions, options = {}) {
  const overwriteExisting = Boolean(options?.overwriteExisting);
  /** @type {Array<{ keyLower: string, clause: string }>} */
  const ordered = [];
  /** @type {Map<string, number>} */
  const keyIndex = new Map();

  const pushClause = (/** @type {string} */ rawClause, /** @type {boolean} */ allowOverwrite) => {
    const trimmed = String(rawClause || '').trim();
    if (!trimmed) return;
    const eqIdx = trimmed.indexOf('=');
    const keyLower = eqIdx > 0 ? trimmed.slice(0, eqIdx).trim().toLowerCase() : trimmed.toLowerCase();
    if (!keyLower) return;
    if (keyIndex.has(keyLower)) {
      if (allowOverwrite) {
        const idx = /** @type {number} */ (keyIndex.get(keyLower));
        ordered[idx] = { keyLower, clause: trimmed };
      }
      return;
    }
    keyIndex.set(keyLower, ordered.length);
    ordered.push({ keyLower, clause: trimmed });
  };

  for (const part of String(existing || '').split(';')) {
    pushClause(part, false);
  }

  if (typeof additions === 'string') {
    for (const part of additions.split(';')) {
      pushClause(part, overwriteExisting);
    }
  } else if (Array.isArray(additions)) {
    for (const item of additions) {
      for (const part of String(item || '').split(';')) {
        pushClause(part, overwriteExisting);
      }
    }
  } else if (additions && typeof additions === 'object') {
    for (const [k, v] of Object.entries(additions)) {
      if (k && v !== undefined && v !== null && String(v).trim() !== '') {
        pushClause(`${k.trim()} = ${String(v).trim()}`, overwriteExisting);
      }
    }
  }

  return ordered.map((entry) => entry.clause).join('; ');
}

/**
 * Detect whether a CrossOver root directory on disk bundles 32-bit DXMT, 32-bit DXVK, and 64-bit D3DMetal.
 * Falls back to `{ has32BitDxmt: true, has32BitDxvk: true, has64BitD3dMetal: true }` when `cxRoot` is virtual
 * in unit tests (i.e. no `lib`/`lib64` backend tree exists on disk).
 *
 * @param {string} cxRoot
 * @param {Record<string, any>} [params]
 */
function detectCrossOverBackendLayerSupport(cxRoot, params = {}) {
  const explicit = params?.layerSupport && typeof params.layerSupport === 'object' ? params.layerSupport : null;
  const layerType = String(
    params?.chosenLayer?.type || params?.compatLayer?.type || params?.layerType || ''
  )
    .trim()
    .toLowerCase();
  const isStandaloneNonCrossOver = layerType === 'wine' || layerType === 'gptk';
  const bottlePath = String(params?.bottlePath || params?.winePrefix || '').trim();

  let has32BitDxmt = !isStandaloneNonCrossOver;
  let has32BitDxvk = !isStandaloneNonCrossOver;
  let has64BitD3dMetal = layerType !== 'wine';
  let hasArm64Dxmt = !isStandaloneNonCrossOver;

  if (cxRoot && typeof cxRoot === 'string') {
    try {
      if (fs.existsSync(cxRoot) && fs.statSync(cxRoot).isDirectory()) {
        const probe32Dxmt =
          fs.existsSync(path.join(cxRoot, 'lib', 'dxmt', 'i386-windows', 'd3d11.dll')) ||
          fs.existsSync(path.join(cxRoot, 'lib', 'wine', 'i386-windows', 'winemetal.dll'));
        const probe32Dxvk =
          fs.existsSync(path.join(cxRoot, 'lib', 'dxvk', 'i386-windows', 'd3d9.dll')) ||
          fs.existsSync(path.join(cxRoot, 'lib', 'dxvk', 'i386-windows', 'd3d11.dll'));
        const probe64D3dMetal =
          fs.existsSync(path.join(cxRoot, 'lib', 'apple_gptk')) ||
          fs.existsSync(path.join(cxRoot, 'lib', 'apple_gptk3')) ||
          fs.existsSync(path.join(cxRoot, 'lib64', 'apple_gptk')) ||
          fs.existsSync(path.join(cxRoot, 'lib64', 'apple_gptk3')) ||
          fs.existsSync(path.join(cxRoot, 'lib', 'external', 'D3DMetal.framework')) ||
          fs.existsSync(path.join(cxRoot, 'lib64', 'external', 'D3DMetal.framework'));
        const probeArm64Dxmt =
          fs.existsSync(path.join(cxRoot, 'lib', 'dxmt', 'aarch64-unix', 'winemetal.so')) ||
          fs.existsSync(path.join(cxRoot, 'lib', 'dxmt', 'aarch64-windows', 'd3d11.dll')) ||
          fs.existsSync(path.join(cxRoot, 'lib', 'dxmt', 'x86_64-windows', 'd3d11.dll'));
        const hasRealBackendTree =
          probe32Dxmt ||
          probe32Dxvk ||
          probe64D3dMetal ||
          probeArm64Dxmt ||
          fs.existsSync(path.join(cxRoot, 'lib', 'wine')) ||
          fs.existsSync(path.join(cxRoot, 'lib64', 'wine'));
        if (hasRealBackendTree || isStandaloneNonCrossOver) {
          has32BitDxmt = probe32Dxmt;
          has32BitDxvk = probe32Dxvk;
          has64BitD3dMetal = probe64D3dMetal || (layerType === 'gptk' && !hasRealBackendTree);
          hasArm64Dxmt =
            probeArm64Dxmt ||
            (layerType === 'crossover_preview_arm64' &&
              !fs.existsSync(path.join(cxRoot, 'lib', 'dxmt')));
        }
      }
    } catch {}
  }

  if (isStandaloneNonCrossOver && bottlePath) {
    try {
      if (fs.existsSync(bottlePath) && fs.statSync(bottlePath).isDirectory()) {
        const syswow64 =
          resolveDriveCPathCaseInsensitive(bottlePath, ['drive_c', 'windows', 'syswow64']) ||
          path.join(bottlePath, 'drive_c', 'windows', 'syswow64');
        if (!has32BitDxmt && fs.existsSync(path.join(syswow64, 'winemetal.dll'))) {
          has32BitDxmt = true;
        }
        if (!has32BitDxvk && fs.existsSync(path.join(syswow64, 'dxvk_config.dll'))) {
          has32BitDxvk = true;
        }
      }
    } catch {}
  }

  if (explicit) {
    if (typeof explicit.has32BitDxmt === 'boolean') has32BitDxmt = explicit.has32BitDxmt;
    if (typeof explicit.has32BitDxvk === 'boolean') has32BitDxvk = explicit.has32BitDxvk;
    if (typeof explicit.has64BitD3dMetal === 'boolean') has64BitD3dMetal = explicit.has64BitD3dMetal;
    if (typeof explicit.hasArm64Dxmt === 'boolean') hasArm64Dxmt = explicit.hasArm64Dxmt;
  }

  return { has32BitDxmt, has32BitDxvk, has64BitD3dMetal, hasArm64Dxmt };
}

/**
 * Deterministic universal CrossOver graphics backend router driven strictly by PE32/PE32+ header bits,
 * PE import/delay-import tables, UE5 IoStore `.utoc` containers, and on-disk layer layout.
 *
 * @param {Record<string, any>} [params]
 */
function resolveEffectiveCrossOverGraphicsBackend(params = {}) {
  const src =
    params?.capabilities && typeof params.capabilities === 'object'
      ? { ...params.capabilities, ...params }
      : params?.peCapabilities && typeof params.peCapabilities === 'object'
        ? { ...params.peCapabilities, ...params }
        : params || {};

  const rawRequested = String(
    src.requestedBackend ?? src.crossoverGraphicsBackend ?? src.backend ?? 'auto'
  )
    .trim()
    .toLowerCase();
  const normalizedRequested = rawRequested || 'auto';

  const cxRoot =
    typeof src.cxRoot === 'string' && src.cxRoot.trim()
      ? src.cxRoot.trim()
      : deriveCrossOverRootFromBinaryPath(
          String(src.wineBinaryPath || src.chosenLayer?.binaryPath || '')
        );
  const layerSupport = detectCrossOverBackendLayerSupport(cxRoot, src);
  const bottlePathStr = String(src.bottlePath || src.winePrefix || '').trim();
  const bottleConfWineArch = bottlePathStr
    ? inspectBottleConfMetadata(bottlePathStr).wineArch
    : undefined;
  const isArm64FexBottle =
    src.chosenLayer?.type === 'crossover_preview_arm64' ||
    src.compatLayer?.type === 'crossover_preview_arm64' ||
    src.layerType === 'crossover_preview_arm64' ||
    src.wineArch === 'arm64' ||
    bottleConfWineArch === 'arm64';

  const is32Bit = Boolean(src.is32Bit || src.effectiveMachine === 'x86' || src.isX86);
  const is64Bit = Boolean(
    !is32Bit &&
      (src.is64Bit ||
        src.effectiveMachine === 'x64' ||
        src.effectiveMachine === 'arm64' ||
        src.effectiveMachine === 'arm64ec' ||
        src.isX64 ||
        src.isArm64)
  );
  const isNxCompat = src.isNxCompat === false ? false : Boolean(src.isNxCompat ?? true);
  const importsD3d12 = Boolean(src.importsD3d12);
  const importsD3d11Or10 = Boolean(src.importsD3d11Or10);
  const importsD3d9 = Boolean(src.importsD3d9);
  const importsLegacyD3dOrGl = Boolean(src.importsLegacyD3dOrGl);
  const importsVulkan = Boolean(src.importsVulkan);
  const hasUe5IoStoreContainer = Boolean(src.hasUe5IoStoreContainer);
  const isD3d12Only =
    typeof src.isD3d12Only === 'boolean'
      ? src.isD3d12Only
      : (importsD3d12 || hasUe5IoStoreContainer) &&
        !importsD3d11Or10 &&
        !importsD3d9 &&
        !importsVulkan &&
        !importsLegacyD3dOrGl;

  let effectiveRequested = normalizedRequested;
  /** @type {string | null} */
  let reroutedReason = null;

  // Hard Safety Guard #2: D3DMetal is 64-bit only (`is_d3dmetal_usable() == 0` on PE32).
  // Treat `'d3dmetal'` on `is32Bit` identically to `'auto'` instead of dropping blindly to CGL OpenGL wined3d.
  if (is32Bit && effectiveRequested === 'd3dmetal') {
    effectiveRequested = 'auto';
    reroutedReason = 'pe32_d3dmetal_unsupported';
  }

  // Hard Safety Guard #1: `is32Bit && isNxCompat === false` + `'dxmt'` MUST NEVER allow `'dxmt'`
  // (prevents 100% CPU `dxmt-encode-thr` Rosetta `rwx` infinite hang).
  if (is32Bit && isNxCompat === false && effectiveRequested === 'dxmt') {
    reroutedReason = 'pe32_non_nx_dxmt_hang_guard';
    if (importsD3d11Or10 && layerSupport.has32BitDxvk) {
      return {
        backend: 'dxvk',
        cxGraphicsBackendEnv: 'dxvk',
        direct3dRenderer: null,
        reroutedReason,
        layerSupport,
      };
    }
    return {
      backend: 'wined3d',
      cxGraphicsBackendEnv: 'wined3d',
      direct3dRenderer: importsD3d9 && !importsLegacyD3dOrGl ? 'vulkan' : null,
      reroutedReason,
      layerSupport,
    };
  }

  // Explicit non-auto backend selection
  if (
    effectiveRequested === 'd3dmetal' ||
    effectiveRequested === 'dxmt' ||
    effectiveRequested === 'dxvk' ||
    effectiveRequested === 'wined3d'
  ) {
    let resolvedExplicit = effectiveRequested;
    if (resolvedExplicit === 'dxmt' && is32Bit && !layerSupport.has32BitDxmt) {
      resolvedExplicit = layerSupport.has32BitDxvk ? 'dxvk' : 'wined3d';
      reroutedReason = 'pe32_dxmt_layer_missing';
    } else if (resolvedExplicit === 'dxvk' && is32Bit && !layerSupport.has32BitDxvk) {
      resolvedExplicit = 'wined3d';
      reroutedReason = 'pe32_dxvk_layer_missing';
    } else if (resolvedExplicit === 'd3dmetal' && is64Bit && !layerSupport.has64BitD3dMetal) {
      resolvedExplicit = 'auto';
      reroutedReason = 'pe64_d3dmetal_layer_missing';
    }
    return {
      backend: resolvedExplicit,
      cxGraphicsBackendEnv: resolvedExplicit === 'auto' ? null : resolvedExplicit,
      direct3dRenderer: null,
      reroutedReason,
      layerSupport,
    };
  }

  // Universal `'auto'` Resolution
  if (is32Bit) {
    if (importsD3d11Or10 && isNxCompat !== false) {
      if (layerSupport.has32BitDxmt) {
        return {
          backend: 'dxmt',
          cxGraphicsBackendEnv: 'dxmt',
          direct3dRenderer: null,
          reroutedReason,
          layerSupport,
        };
      }
      if (layerSupport.has32BitDxvk) {
        return {
          backend: 'dxvk',
          cxGraphicsBackendEnv: 'dxvk',
          direct3dRenderer: null,
          reroutedReason: reroutedReason || 'pe32_dxmt_layer_missing',
          layerSupport,
        };
      }
      return {
        backend: 'wined3d',
        cxGraphicsBackendEnv: 'wined3d',
        direct3dRenderer: 'vulkan',
        reroutedReason: reroutedReason || 'pe32_dxmt_dxvk_missing',
        layerSupport,
      };
    }

    if (importsD3d11Or10 && isNxCompat === false) {
      if (layerSupport.has32BitDxvk) {
        return {
          backend: 'dxvk',
          cxGraphicsBackendEnv: 'dxvk',
          direct3dRenderer: null,
          reroutedReason,
          layerSupport,
        };
      }
      return {
        backend: 'wined3d',
        cxGraphicsBackendEnv: 'wined3d',
        direct3dRenderer: 'vulkan',
        reroutedReason: reroutedReason || 'pe32_dxvk_layer_missing',
        layerSupport,
      };
    }

    if (importsD3d9 && !importsD3d11Or10 && !importsLegacyD3dOrGl) {
      return {
        backend: 'wined3d',
        cxGraphicsBackendEnv: 'wined3d',
        direct3dRenderer: 'vulkan',
        reroutedReason,
        layerSupport,
      };
    }

    if (importsLegacyD3dOrGl) {
      return {
        backend: 'wined3d',
        cxGraphicsBackendEnv: 'wined3d',
        direct3dRenderer: null,
        reroutedReason,
        layerSupport,
      };
    }

    // Packed / dynamically-loaded non-DEP (`isNxCompat === false`) PE32 guard:
    // Pin to `wined3d` rather than leaving `cxGraphicsBackendEnv: null` so CrossOver `cxcompatdb`
    // can never auto-select `dxmt` and trigger Rosetta's `WINE_SIMULATE_WRITECOPY` encode hang.
    if (isNxCompat === false) {
      return {
        backend: 'wined3d',
        cxGraphicsBackendEnv: 'wined3d',
        direct3dRenderer: null,
        reroutedReason: reroutedReason || 'pe32_non_nx_dxmt_hang_guard',
        layerSupport,
      };
    }
  }

  if (
    isArm64FexBottle &&
    !importsLegacyD3dOrGl &&
    !importsVulkan &&
    !(is64Bit && isD3d12Only && layerSupport.has64BitD3dMetal) &&
    layerSupport.hasArm64Dxmt
  ) {
    return {
      backend: 'dxmt',
      cxGraphicsBackendEnv: 'dxmt',
      direct3dRenderer: null,
      reroutedReason: reroutedReason || 'arm64_fex_auto_dxmt',
      layerSupport,
    };
  }

  if (is64Bit && isD3d12Only && layerSupport.has64BitD3dMetal) {
    return {
      backend: 'd3dmetal',
      cxGraphicsBackendEnv: 'd3dmetal',
      direct3dRenderer: null,
      reroutedReason,
      layerSupport,
    };
  }

  return {
    backend: 'auto',
    cxGraphicsBackendEnv: null,
    direct3dRenderer: null,
    reroutedReason,
    layerSupport,
  };
}

const NON_APFS_APPLEDOUBLE_FS_TYPES = new Set([
  'exfat',
  'msdos',
  'fat',
  'fat32',
  'vfat',
  'ntfs',
  'ntfs-3g',
  'tuxera_ntfs',
  'ufsd_ntfs',
  'smbfs',
  'cifs',
  'udf',
]);

/** @type {{ ts: number, raw: string }} */
let cachedDarwinMountTable = { ts: 0, raw: '' };
let darwinMountRefreshInFlight = false;

function getCachedDarwinMountTableOutput() {
  const now = Date.now();
  if (cachedDarwinMountTable.raw && now - cachedDarwinMountTable.ts < 60_000) {
    return cachedDarwinMountTable.raw;
  }
  // If we already have a prior snapshot, refresh asynchronously without stalling the main thread
  if (cachedDarwinMountTable.raw && !darwinMountRefreshInFlight) {
    darwinMountRefreshInFlight = true;
    try {
      execFile('/sbin/mount', [], { timeout: 1500, encoding: 'utf8' }, (err, stdout) => {
        darwinMountRefreshInFlight = false;
        if (!err && stdout) {
          cachedDarwinMountTable = { ts: Date.now(), raw: String(stdout) };
        }
      });
    } catch {
      darwinMountRefreshInFlight = false;
    }
    return cachedDarwinMountTable.raw;
  }
  try {
    const out = execFileSync('/sbin/mount', [], {
      timeout: 1500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    cachedDarwinMountTable = { ts: now, raw: String(out || '') };
    return cachedDarwinMountTable.raw;
  } catch {
    return '';
  }
}

/**
 * Remove macOS Finder `._<name>` AppleDouble resource-fork twins (`0x00051607`) ONLY on non-APFS/HFS+
 * external/network volumes (`exfat`, `msdos`, `ntfs`, `smbfs`) and ONLY when sibling `<name>` exists.
 * Returns `0` in `< 0.1 ms` on internal APFS `/System/Volumes/Data` paths with zero subprocesses.
 *
 * @param {string} targetDir
 * @param {{ platform?: string, fsType?: string, mountOutput?: string, maxDepth?: number, maxDirs?: number }} [options]
 * @returns {number}
 */
function cleanNonApfsAppleDoubleTwins(targetDir, options = {}) {
  const effectivePlatform = options?.platform || process.platform;
  if (effectivePlatform !== 'darwin' || !targetDir || typeof targetDir !== 'string') {
    return 0;
  }
  let realTargetDir = '';
  try {
    if (!fs.existsSync(targetDir)) return 0;
    realTargetDir = fs.realpathSync(targetDir);
  } catch {
    return 0;
  }

  // Fast < 0.1 ms short-circuit for internal APFS/HFS+ paths (/Users, /Applications, /System/Volumes/Data, /private/var, etc.)
  if (!options?.fsType && !options?.mountOutput && !realTargetDir.startsWith('/Volumes/')) {
    return 0;
  }

  let fsTypeLower = typeof options?.fsType === 'string' ? options.fsType.trim().toLowerCase() : '';
  if (!fsTypeLower) {
    const mountRaw =
      typeof options?.mountOutput === 'string'
        ? options.mountOutput
        : getCachedDarwinMountTableOutput();
    if (mountRaw) {
      let longestMountLen = -1;
      for (const line of mountRaw.split(/\r?\n/)) {
        const m = line.match(/\son\s+(\/.+?)\s+\(([^,)\s]+)/);
        if (!m) continue;
        const mountPoint = m[1];
        const fstype = m[2].trim().toLowerCase();
        if (
          realTargetDir === mountPoint ||
          realTargetDir.startsWith(mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`)
        ) {
          if (mountPoint.length > longestMountLen) {
            longestMountLen = mountPoint.length;
            fsTypeLower = fstype;
          }
        }
      }
    }
  }

  if (!fsTypeLower || !NON_APFS_APPLEDOUBLE_FS_TYPES.has(fsTypeLower)) {
    return 0;
  }

  const maxDepth = Number.isFinite(options?.maxDepth)
    ? Math.max(0, Number(options.maxDepth))
    : 5;
  const maxDirs = Number.isFinite(options?.maxDirs)
    ? Math.max(1, Number(options.maxDirs))
    : 200;

  let removedCount = 0;
  let visitedDirs = 0;
  /** @type {Array<{ dir: string, depth: number }>} */
  const queue = [{ dir: realTargetDir, depth: 0 }];

  while (queue.length > 0 && visitedDirs < maxDirs) {
    const current = queue.shift();
    if (!current) break;
    visitedDirs += 1;

    let entries;
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const exactNames = new Set();
    const lowerNames = new Set();
    for (let i = 0; i < entries.length; i += 1) {
      const nm = entries[i].name;
      exactNames.add(nm);
      lowerNames.add(nm.toLowerCase());
    }

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!entry.name.startsWith('._') && current.depth < maxDepth && visitedDirs < maxDirs) {
          queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith('._') || entry.name.length <= 2) {
        continue;
      }
      const baseSibling = entry.name.slice(2);
      if (!exactNames.has(baseSibling) && !lowerNames.has(baseSibling.toLowerCase())) {
        continue;
      }
      const twinPath = path.join(current.dir, entry.name);
      /** @type {number | null} */
      let fd = null;
      let isAppleDouble = false;
      try {
        fd = fs.openSync(twinPath, 'r');
        const magicBuf = Buffer.alloc(4);
        const bytesRead = fs.readSync(fd, magicBuf, 0, 4, 0);
        isAppleDouble = bytesRead === 4 && magicBuf.readUInt32BE(0) === 0x00051607;
      } catch {
        isAppleDouble = false;
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {}
        }
      }
      if (isAppleDouble) {
        try {
          fs.unlinkSync(twinPath);
          removedCount += 1;
        } catch {}
      }
    }
  }

  return removedCount;
}

function applyCrossOverPerGameSettings(
  /** @type {any} */ chosenLayerOrBottlePath,
  /** @type {any} */ launchConfig = {},
  /** @type {any} */ envOrOptions = {},
  /** @type {any} */ bottlePath = '',
  /** @type {any} */ options = {}
) {
  const isStringBottleFirstArg = typeof chosenLayerOrBottlePath === 'string';
  const isSecondArgExe =
    isStringBottleFirstArg &&
    (typeof launchConfig === 'string' || Array.isArray(launchConfig));
  const effectiveOptions = isSecondArgExe
    ? bottlePath && typeof bottlePath === 'object'
      ? bottlePath
      : options && typeof options === 'object'
        ? options
        : {}
    : isStringBottleFirstArg
      ? envOrOptions && typeof envOrOptions === 'object'
        ? envOrOptions
        : {}
      : options && typeof options === 'object'
        ? options
        : {};
  const chosenLayer = isStringBottleFirstArg
    ? {
        type: effectiveOptions.isPreviewArm64Runner
          ? 'crossover_preview_arm64'
          : effectiveOptions.isPreviewRunner
            ? 'crossover_preview'
            : effectiveOptions.runnerType || 'crossover',
        ...(effectiveOptions.wineBinary ? { binaryPath: effectiveOptions.wineBinary } : {}),
        ...(effectiveOptions.runnerVersion ? { version: effectiveOptions.runnerVersion } : {}),
      }
    : chosenLayerOrBottlePath;
  /** @type {Record<string, any>} */
  const env = isStringBottleFirstArg
    ? {}
    : envOrOptions && typeof envOrOptions === 'object'
      ? envOrOptions
      : {};
  const effectiveBottlePathArg = isStringBottleFirstArg
    ? chosenLayerOrBottlePath
    : typeof bottlePath === 'string'
      ? bottlePath
      : '';
  const explicitExeNamesFromArg = isSecondArgExe
    ? Array.isArray(launchConfig)
      ? launchConfig.map((s) => String(s || '').trim()).filter(Boolean)
      : [String(launchConfig || '').trim()].filter(Boolean)
    : [];
  const explicitExeNameFromArg = explicitExeNamesFromArg[0] || '';

  const cfg = isSecondArgExe
    ? envOrOptions && typeof envOrOptions === 'object'
      ? envOrOptions
      : {}
    : launchConfig && typeof launchConfig === 'object'
      ? launchConfig
      : {};
  const requestedBackend =
    typeof cfg.crossoverGraphicsBackend === 'string'
      ? cfg.crossoverGraphicsBackend.toLowerCase().trim()
      : undefined;
  const d3dmVer =
    typeof cfg.crossoverD3DMetalVersion === 'string'
      ? cfg.crossoverD3DMetalVersion.toLowerCase().trim()
      : undefined;

  const candidateWineBin =
    (chosenLayer && typeof chosenLayer === 'object' && chosenLayer.binaryPath) ||
    effectiveOptions.wineBinary ||
    '';

  let peCapsSrc =
    (effectiveOptions.peCapabilities && typeof effectiveOptions.peCapabilities === 'object'
      ? effectiveOptions.peCapabilities
      : null) ||
    (effectiveOptions.effectiveCaps && typeof effectiveOptions.effectiveCaps === 'object'
      ? effectiveOptions.effectiveCaps
      : null) ||
    (cfg.peCapabilities && typeof cfg.peCapabilities === 'object' ? cfg.peCapabilities : null);
  if (!peCapsSrc) {
    const candidateDiskExe =
      (explicitExeNameFromArg &&
      (explicitExeNameFromArg.includes('/') || explicitExeNameFromArg.includes('\\'))
        ? explicitExeNameFromArg
        : '') ||
      (typeof effectiveOptions.exePath === 'string' ? effectiveOptions.exePath : '') ||
      (typeof cfg.executablePath === 'string' ? cfg.executablePath : '');
    if (candidateDiskExe) {
      try {
        if (fs.existsSync(candidateDiskExe) && fs.statSync(candidateDiskExe).isFile()) {
          const autoInspected = inspectPeCapabilities(candidateDiskExe);
          if (autoInspected && autoInspected.isValidPe) {
            peCapsSrc = autoInspected;
          }
        }
      } catch {}
    }
  }
  const hasPeCaps = Boolean(
    peCapsSrc ||
      typeof effectiveOptions.is32Bit === 'boolean' ||
      typeof effectiveOptions.is64Bit === 'boolean' ||
      typeof effectiveOptions.isD3d12Only === 'boolean'
  );
  const peCaps = peCapsSrc || effectiveOptions;

  const resolvedBottlePath = effectiveBottlePathArg || env.WINEPREFIX || '';

  const backendRoute = resolveEffectiveCrossOverGraphicsBackend({
    requestedBackend: requestedBackend || 'auto',
    chosenLayer,
    wineBinaryPath: candidateWineBin,
    bottlePath: resolvedBottlePath,
    cxRoot: effectiveOptions.cxRoot,
    layerSupport: effectiveOptions.layerSupport,
    ...(hasPeCaps
      ? {
          is32Bit: Boolean(peCaps.is32Bit || peCaps.effectiveMachine === 'x86'),
          is64Bit: Boolean(
            peCaps.is64Bit ||
              peCaps.effectiveMachine === 'x64' ||
              peCaps.effectiveMachine === 'arm64' ||
              peCaps.effectiveMachine === 'arm64ec'
          ),
          isLargeAddressAware: peCaps.isLargeAddressAware,
          isNxCompat: peCaps.isNxCompat,
          importsD3d12: Boolean(peCaps.importsD3d12),
          importsD3d11Or10: Boolean(peCaps.importsD3d11Or10),
          importsD3d9: Boolean(peCaps.importsD3d9),
          importsLegacyD3dOrGl: Boolean(peCaps.importsLegacyD3dOrGl),
          importsVulkan: Boolean(peCaps.importsVulkan),
          hasUe5IoStoreContainer: Boolean(peCaps.hasUe5IoStoreContainer),
          isD3d12Only: peCaps.isD3d12Only,
        }
      : {}),
  });
  const backend = backendRoute.backend;

  let isBottleDir = false;
  if (resolvedBottlePath && fs.existsSync(resolvedBottlePath)) {
    try {
      isBottleDir = fs.statSync(resolvedBottlePath).isDirectory();
    } catch {}
  }

  const isCrossOverRunner =
    chosenLayer?.type === 'crossover' ||
    chosenLayer?.type === 'crossover_preview' ||
    chosenLayer?.type === 'crossover_preview_arm64' ||
    Boolean(effectiveOptions.isPreviewRunner) ||
    Boolean(effectiveOptions.isPreviewArm64Runner) ||
    /CrossOver/i.test(String(candidateWineBin || '')) ||
    (isBottleDir && fs.existsSync(path.join(resolvedBottlePath, 'cxbottle.conf')));

  let crossOverMajor = 0;
  const rawLayerVer = String(chosenLayer?.version || effectiveOptions.runnerVersion || '').trim();
  if (rawLayerVer) {
    const parsedMajor = parseInt(rawLayerVer.split('.')[0], 10);
    if (Number.isFinite(parsedMajor) && parsedMajor > 0) {
      crossOverMajor = parsedMajor;
    }
  } else if (isCrossOverRunner && candidateWineBin && fs.existsSync(candidateWineBin)) {
    try {
      const vInfo = extractRunnerVersionInfo(
        chosenLayer?.type || 'crossover',
        candidateWineBin,
        effectiveOptions
      );
      const parsedMajor = parseInt(String(vInfo?.version || '').split('.')[0], 10);
      if (Number.isFinite(parsedMajor) && parsedMajor > 0) {
        crossOverMajor = parsedMajor;
      }
    } catch {}
  }
  const isCrossOver25Plus =
    isCrossOverRunner &&
    (crossOverMajor >= 25 ||
      chosenLayer?.type === 'crossover_preview' ||
      chosenLayer?.type === 'crossover_preview_arm64' ||
      Boolean(effectiveOptions.isPreviewRunner) ||
      Boolean(effectiveOptions.isPreviewArm64Runner));

  if (backendRoute.cxGraphicsBackendEnv) {
    env.CX_GRAPHICS_BACKEND = backendRoute.cxGraphicsBackendEnv;
    if (!isCrossOver25Plus && backendRoute.cxGraphicsBackendEnv === 'd3dmetal') {
      env.WINED3DMETAL = '1';
    } else if (!cfg.environmentVariables?.WINED3DMETAL) {
      delete env.WINED3DMETAL;
    }
  } else {
    if (!cfg.environmentVariables?.CX_GRAPHICS_BACKEND) {
      delete env.CX_GRAPHICS_BACKEND;
    }
    if (!cfg.environmentVariables?.WINED3DMETAL) {
      delete env.WINED3DMETAL;
    }
  }

  const isD3DMetalEligible = !backend || backend === 'auto' || backend === 'd3dmetal';
  const hasMultipleBundledD3dMetal =
    !Array.isArray(chosenLayer?.availableD3DMetalVersions) ||
    chosenLayer.availableD3DMetalVersions.length > 1;
  if (isD3DMetalEligible && (d3dmVer === '3' || d3dmVer === '4') && hasMultipleBundledD3dMetal) {
    env.CX_GRAPHICS_BACKEND_VERSION = d3dmVer;
  } else if (!cfg.environmentVariables?.CX_GRAPHICS_BACKEND_VERSION) {
    delete env.CX_GRAPHICS_BACKEND_VERSION;
  }

  const isPe32Target = Boolean(
    hasPeCaps && (peCaps.is32Bit || peCaps.effectiveMachine === 'x86')
  );
  const isPe32NonLaa = Boolean(
    isPe32Target &&
      peCaps.isLargeAddressAware === false &&
      cfg.forceLargeAddressAware !== true
  );
  const isPe32Laa = Boolean(
    isPe32Target &&
      (peCaps.isLargeAddressAware === true || cfg.forceLargeAddressAware === true)
  );

  const hostArch = String(
    effectiveOptions.arch ||
      chosenLayer?.hostArch ||
      (process.platform === 'darwin' ? process.arch : 'arm64') ||
      'arm64'
  )
    .trim()
    .toLowerCase();
  const rawDarwinMajor =
    effectiveOptions.darwinKernelMajor ??
    chosenLayer?.darwinKernelMajor ??
    (isTestEnvironment(effectiveOptions)
      ? 25
      : process.platform === 'darwin'
        ? Number(String(os.release() || '25.0.0').split('.')[0]) || 25
        : 25);
  const darwinMajor = Number(rawDarwinMajor) || 25;

  const dlssUnsupportedBackend = backend === 'dxvk' || backend === 'wined3d';
  const dlssUnsupportedTarget =
    dlssUnsupportedBackend || isPe32Target || hostArch === 'x64' || darwinMajor < 23;
  const wantMetalFxDlss = cfg.crossoverDlss === true || cfg.metalFxUpscaling === true;
  if (wantMetalFxDlss && !dlssUnsupportedTarget) {
    env.DXMT_ENABLE_NVEXT = '1';
    env.D3DM_ENABLE_METALFX = darwinMajor >= 25 ? '1' : '0';
    if (!isCrossOverRunner && env.D3DM_ENABLE_METALFX === '1' && !env.D3DM_NVNGX_PATH) {
      const wineRootForNgx = candidateWineBin
        ? path.resolve(path.dirname(candidateWineBin), '..')
        : '';
      const ngxDirCandidates = [
        wineRootForNgx ? path.join(wineRootForNgx, 'lib', 'wine', 'x86_64-windows') : '',
        wineRootForNgx ? path.join(wineRootForNgx, 'lib64', 'wine', 'x86_64-windows') : '',
        '/Library/Apple/usr/libexec/oah/libd3dmetal/wine/x86_64-windows',
        '/opt/homebrew/opt/game-porting-toolkit/lib/wine/x86_64-windows',
        '/usr/local/opt/game-porting-toolkit/lib/wine/x86_64-windows',
      ].filter(Boolean);
      for (const ngxDir of ngxDirCandidates) {
        try {
          if (fs.existsSync(path.join(ngxDir, 'nvngx.dll'))) {
            env.D3DM_NVNGX_PATH = ngxDir;
            const curOverrides = String(env.WINEDLLOVERRIDES || '')
              .split(';')
              .map((s) => s.trim())
              .filter(Boolean);
            if (
              !curOverrides.some((tok) => {
                const lhs = tok.split('=')[0].trim().toLowerCase();
                return lhs === 'nvngx' || lhs === 'nvngx,nvapi64';
              })
            ) {
              curOverrides.push('nvngx,nvapi64=n,b');
              env.WINEDLLOVERRIDES = curOverrides.join(';');
            }
            break;
          }
        } catch {}
      }
    }
  } else if (cfg.crossoverDlss === false || (wantMetalFxDlss && dlssUnsupportedTarget)) {
    env.D3DM_ENABLE_METALFX = '0';
    env.DXMT_ENABLE_NVEXT = '0';
  } else {
    if (!cfg.environmentVariables?.D3DM_ENABLE_METALFX) {
      delete env.D3DM_ENABLE_METALFX;
    }
    if (!cfg.environmentVariables?.DXMT_ENABLE_NVEXT) {
      delete env.DXMT_ENABLE_NVEXT;
    }
  }

  if (cfg.wineMsync === false) {
    env.WINEMSYNC = '0';
    if (isCrossOver25Plus) {
      if (!cfg.environmentVariables?.WINEESYNC) delete env.WINEESYNC;
    } else {
      env.WINEESYNC = cfg.wineEsync === false ? '0' : '1';
    }
  } else {
    env.WINEMSYNC = '1';
    if (isCrossOver25Plus) {
      if (!cfg.environmentVariables?.WINEESYNC) delete env.WINEESYNC;
    } else {
      env.WINEESYNC = '0';
    }
  }

  if (isBottleDir) {
    alignWineMsyncWithLiveBottle(resolvedBottlePath, env, effectiveOptions);
  }

  const loaderAllowsDyldInsert =
    !candidateWineBin || doesWineLoaderAllowDyldInsert(candidateWineBin);

  const hudPerfSettings = getLauncherPerformanceSettings(effectiveOptions);
  const unifiedHudResult = applyUnifiedPerformanceHudEnv({
    env,
    launchConfig: cfg,
    perfSettings: hudPerfSettings,
    chosenLayer,
    backend,
    platform: effectiveOptions.platform || process.platform,
    useCompatLayer: true,
    wineBinaryPath: candidateWineBin,
    options: effectiveOptions,
    gameId: effectiveOptions.gameId || cfg.gameId || '',
  });

  if (cfg.audioBufferClamp === false || effectiveOptions.enableAudioBufferClamp === false) {
    env.ONE_LAUNCHER_AUDIO_BUFFER_CLAMP = '0';
  } else if (cfg.audioBufferClamp === true || effectiveOptions.enableAudioBufferClamp === true) {
    if (loaderAllowsDyldInsert) {
      const preloadDylib = ensureWineMetalPreloadDylib(effectiveOptions);
      if (preloadDylib) {
        const existingInsert = splitDyldInsertLibraries(env.DYLD_INSERT_LIBRARIES);
        if (!existingInsert.includes(preloadDylib)) {
          existingInsert.unshift(preloadDylib);
        }
        env.DYLD_INSERT_LIBRARIES = existingInsert.join(':');
        env.ONE_LAUNCHER_AUDIO_BUFFER_CLAMP = '1';
        if (!unifiedHudResult.appliedMetalHud && !env.ONE_LAUNCHER_MOLTENVK_PATH) {
          env.ONE_LAUNCHER_METAL_PRELOAD = '0';
        }
      }
    }
  }

  const resolvedBottleMeta = isBottleDir ? inspectBottleConfMetadata(resolvedBottlePath) : {};
  const isArm64FexBottle =
    chosenLayer?.type === 'crossover_preview_arm64' ||
    Boolean(effectiveOptions.isPreviewArm64Runner) ||
    resolvedBottleMeta.wineArch === 'arm64';

  if (
    (chosenLayer?.type === 'crossover' ||
      chosenLayer?.type === 'crossover_preview' ||
      chosenLayer?.type === 'crossover_preview_arm64') &&
    env.CX_FWD_COMPAT_GL_CTX === undefined &&
    cfg.environmentVariables?.CX_FWD_COMPAT_GL_CTX === undefined
  ) {
    env.CX_FWD_COMPAT_GL_CTX = '1';
  }

  const explicitAvxCfg =
    typeof cfg.advertiseAvx === 'boolean'
      ? cfg.advertiseAvx
      : typeof cfg.rosettaAdvertiseAvx === 'boolean'
        ? cfg.rosettaAdvertiseAvx
        : cfg.environmentVariables?.ROSETTA_ADVERTISE_AVX;
  applyStrictRosettaAvxEnv(env, explicitAvxCfg, {
    ...effectiveOptions,
    isCrossOverWrapper: effectiveOptions.isCrossOverWrapper,
    wineBinaryPath: candidateWineBin,
    compatLayer: chosenLayer,
    layerType:
      chosenLayer?.type ||
      (effectiveOptions.isPreviewArm64Runner ? 'crossover_preview_arm64' : undefined),
    wineArch: resolvedBottleMeta.wineArch || (isArm64FexBottle ? 'arm64' : undefined),
    bottlePath: resolvedBottlePath,
    homedir: effectiveOptions.homedir,
    cxRoot: effectiveOptions.cxRoot,
  });

  if (cfg.environmentVariables && typeof cfg.environmentVariables === 'object') {
    for (const [k, v] of Object.entries(cfg.environmentVariables)) {
      if (/^FEX_/i.test(k) && typeof v === 'string' && env[k] === undefined) {
        const cleanEnvVal = v.replace(/[\r\n\0]/g, '').trim();
        if (cleanEnvVal) {
          env[k] = cleanEnvVal;
        }
      }
    }
  }

  const perfSettings = getLauncherPerformanceSettings(effectiveOptions);
  // TS-02: Translate UI `WineDebugMode` enum tokens ('off', 'fixme_err', 'warn_err', 'relay')
  // into valid Wine WINEDEBUG specs via the canonical Wave 1 sanitizer map.
  const resolvedWineDebug = resolveWineDebugEnvValue(cfg.wineDebug);
  if (resolvedWineDebug) {
    env.WINEDEBUG = resolvedWineDebug;
  } else if (
    perfSettings.suppressWineDebugLogging !== false &&
    !cfg.environmentVariables?.WINEDEBUG &&
    !env.WINEDEBUG
  ) {
    env.WINEDEBUG = '-all';
  }
  if (isCrossOverRunner && env.WINEDEBUG && !cfg.environmentVariables?.CX_DEBUGMSG) {
    env.CX_DEBUGMSG = String(env.WINEDEBUG);
  }

  // 32-bit DXMT dynamic vertex/constant buffer NoWait guard + MetalFX Spatial Swapchain Upscaling
  if (
    isPe32Target &&
    (backend === 'dxmt' || (backend === 'auto' && Boolean(peCaps.importsD3d11Or10)))
  ) {
    env.DXMT_CONFIG = mergeSemicolonConfigClauses(
      env.DXMT_CONFIG,
      'd3d11.ignoreMapFlagNoWait = True'
    );
  }

  const isExplicitNonDxmtBackend =
    backend === 'd3dmetal' || backend === 'dxvk' || backend === 'wined3d';
  const spatialUpscaleFactor = Number(cfg.metalfxSpatialUpscaleFactor);
  if (
    Number.isFinite(spatialUpscaleFactor) &&
    spatialUpscaleFactor > 1 &&
    (backend === 'dxmt' || backend === 'auto')
  ) {
    if (!cfg.environmentVariables?.DXMT_METALFX_SPATIAL_SWAPCHAIN) {
      env.DXMT_METALFX_SPATIAL_SWAPCHAIN = '1';
    }
    env.DXMT_CONFIG = mergeSemicolonConfigClauses(
      env.DXMT_CONFIG,
      `d3d11.metalSpatialUpscaleFactor = ${spatialUpscaleFactor}`,
      {
        overwriteExisting: !String(cfg.environmentVariables?.DXMT_CONFIG || '').includes(
          'd3d11.metalSpatialUpscaleFactor'
        ),
      }
    );
  } else if (isExplicitNonDxmtBackend) {
    // SUP-07 / HI-10: Unconditionally strip stale DXMT spatial upscaling variables whenever an
    // explicit non-DXMT backend (`d3dmetal`, `dxvk`, `wined3d`) is active.
    delete env.DXMT_METALFX_SPATIAL_SWAPCHAIN;
    if (
      typeof env.DXMT_CONFIG === 'string' &&
      /d3d11\.metalSpatialUpscaleFactor/i.test(env.DXMT_CONFIG)
    ) {
      const strippedDxmtCfg = env.DXMT_CONFIG
        .split(';')
        .map((clause) => clause.trim())
        .filter((clause) => clause && !/^d3d11\.metalSpatialUpscaleFactor\s*=/i.test(clause))
        .join('; ');
      if (strippedDxmtCfg) {
        env.DXMT_CONFIG = strippedDxmtCfg;
      } else {
        delete env.DXMT_CONFIG;
      }
    }
  } else if (!cfg.environmentVariables?.DXMT_METALFX_SPATIAL_SWAPCHAIN) {
    delete env.DXMT_METALFX_SPATIAL_SWAPCHAIN;
  }

  // 3-Tier Unified-Memory Cap + Multi-Backend FPS Cap + DXVK_CONFIG_FILE Materialization
  const totalRamMB = Math.floor(
    (Number(effectiveOptions.totalMemoryBytes) || os.totalmem()) / (1024 * 1024)
  );
  if (isPe32NonLaa) {
    env.DXVK_CONFIG = mergeSemicolonConfigClauses(
      env.DXVK_CONFIG,
      'd3d9.maxAvailableMemory = 1536; dxgi.maxDeviceMemory = 1536; dxgi.maxSharedMemory = 1536; d3d9.deferSurfaceCreation = True; d3d9.seamlessCubes = True'
    );
  } else if (isPe32Laa && backend === 'dxvk') {
    const pe32LaaDxgiCap = Math.min(3072, Math.max(2048, Math.floor(totalRamMB * 0.45)));
    env.DXVK_CONFIG = mergeSemicolonConfigClauses(
      env.DXVK_CONFIG,
      `d3d9.maxAvailableMemory = 2048; dxgi.maxDeviceMemory = ${pe32LaaDxgiCap}; dxgi.maxSharedMemory = ${pe32LaaDxgiCap}; d3d9.deferSurfaceCreation = True; d3d9.seamlessCubes = True`
    );
  } else if (backend === 'dxvk' && !isPe32Target) {
    const vramCapMB = Math.max(2048, Math.floor(totalRamMB * 0.45));
    env.DXVK_CONFIG = mergeSemicolonConfigClauses(
      env.DXVK_CONFIG,
      `d3d9.maxAvailableMemory = 4096; dxgi.maxDeviceMemory = ${vramCapMB}; dxgi.maxSharedMemory = ${vramCapMB}`
    );
    if (hasPeCaps && peCaps.importsD3d9) {
      env.DXVK_CONFIG = mergeSemicolonConfigClauses(
        env.DXVK_CONFIG,
        'd3d9.deferSurfaceCreation = True'
      );
    }
  }

  if (Number(cfg.preferredMaxFrameRate) > 0) {
    const maxFps = Math.round(Number(cfg.preferredMaxFrameRate));
    env.DXMT_CONFIG = mergeSemicolonConfigClauses(
      env.DXMT_CONFIG,
      `d3d11.preferredMaxFrameRate = ${maxFps}`
    );
    if (backend === 'dxvk') {
      if (env.DXVK_FRAME_RATE === undefined && cfg.environmentVariables?.DXVK_FRAME_RATE === undefined) {
        env.DXVK_FRAME_RATE = String(maxFps);
      }
      env.DXVK_CONFIG = mergeSemicolonConfigClauses(
        env.DXVK_CONFIG,
        `dxgi.maxFrameRate = ${maxFps}; d3d9.maxFrameRate = ${maxFps}`
      );
    } else if (backend === 'd3dmetal') {
      if (env.D3DM_MAX_FPS === undefined && cfg.environmentVariables?.D3DM_MAX_FPS === undefined) {
        env.D3DM_MAX_FPS = String(maxFps);
      }
    }
  }

  if (
    typeof env.DXVK_CONFIG === 'string' &&
    env.DXVK_CONFIG.trim() &&
    env.DXVK_CONFIG_FILE === undefined &&
    cfg.environmentVariables?.DXVK_CONFIG_FILE === undefined
  ) {
    try {
      const normalizedClauses = env.DXVK_CONFIG.split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      if (normalizedClauses.length > 0) {
        const dxvkConfBody = `${normalizedClauses.join('\n')}\n`;
        const cfgHash = crypto.createHash('sha256').update(dxvkConfBody).digest('hex').slice(0, 12);
        const dxvkConfDir = path.join(
          getUserDataDir(effectiveOptions?.userDataDir),
          'shader-cache',
          'dxvk'
        );
        fs.mkdirSync(dxvkConfDir, { recursive: true });
        const dxvkConfPath = path.join(dxvkConfDir, `dxvk-${cfgHash}.conf`);
        if (!fs.existsSync(dxvkConfPath)) {
          atomicWriteFileSync(dxvkConfPath, dxvkConfBody);
        }
        env.DXVK_CONFIG_FILE = dxvkConfPath;
      }
    } catch {}
  }

  const usesMoltenVkBackend =
    backend === 'dxvk' ||
    backendRoute.direct3dRenderer === 'vulkan' ||
    Boolean(hasPeCaps && peCaps.importsVulkan);
  if (usesMoltenVkBackend) {
    if (
      env.MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS === undefined &&
      cfg.environmentVariables?.MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS === undefined
    ) {
      env.MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS = '0';
    }
    if (
      env.MVK_CONFIG_PREFILL_METAL_COMMAND_BUFFERS === undefined &&
      cfg.environmentVariables?.MVK_CONFIG_PREFILL_METAL_COMMAND_BUFFERS === undefined
    ) {
      env.MVK_CONFIG_PREFILL_METAL_COMMAND_BUFFERS = '2';
    }
    if (
      env.MVK_CONFIG_FAST_MATH_ENABLED === undefined &&
      cfg.environmentVariables?.MVK_CONFIG_FAST_MATH_ENABLED === undefined
    ) {
      env.MVK_CONFIG_FAST_MATH_ENABLED = '1';
    }
    if (
      env.MVK_CONFIG_RESUME_LOST_DEVICE === undefined &&
      cfg.environmentVariables?.MVK_CONFIG_RESUME_LOST_DEVICE === undefined
    ) {
      env.MVK_CONFIG_RESUME_LOST_DEVICE = '1';
    }
  }

  if (
    env.DXVK_STATE_CACHE_PATH === undefined &&
    cfg.environmentVariables?.DXVK_STATE_CACHE_PATH === undefined
  ) {
    try {
      const dxvkCacheDir = path.join(
        getUserDataDir(effectiveOptions?.userDataDir),
        'shader-cache',
        'dxvk'
      );
      fs.mkdirSync(dxvkCacheDir, { recursive: true });
      env.DXVK_STATE_CACHE_PATH = dxvkCacheDir;
    } catch {}
  }

  const isDebugLoggingOff =
    !env.WINEDEBUG || env.WINEDEBUG === '-all' || env.WINEDEBUG === '-all,err+system';
  if (isDebugLoggingOff) {
    if (env.DXVK_LOG_LEVEL === undefined && cfg.environmentVariables?.DXVK_LOG_LEVEL === undefined) {
      env.DXVK_LOG_LEVEL = 'none';
    }
    if (env.DXVK_LOG_PATH === undefined && cfg.environmentVariables?.DXVK_LOG_PATH === undefined) {
      env.DXVK_LOG_PATH = 'none';
    }
    if (env.DXMT_LOG_LEVEL === undefined && cfg.environmentVariables?.DXMT_LOG_LEVEL === undefined) {
      env.DXMT_LOG_LEVEL = 'none';
    }
    if (env.DXMT_LOG_PATH === undefined && cfg.environmentVariables?.DXMT_LOG_PATH === undefined) {
      env.DXMT_LOG_PATH = 'none';
    }
    if (
      env.MVK_CONFIG_LOG_LEVEL === undefined &&
      cfg.environmentVariables?.MVK_CONFIG_LOG_LEVEL === undefined
    ) {
      env.MVK_CONFIG_LOG_LEVEL = '2';
    }
  }

  if (isBottleDir) {
    assertRunnerBottleArchCompatible(
      chosenLayer?.type,
      path.basename(resolvedBottlePath),
      resolvedBottlePath
    );
    const cxbottleConfPath = path.join(resolvedBottlePath, 'cxbottle.conf');
    const isArm64Runner =
      chosenLayer?.type === 'crossover_preview_arm64' ||
      Boolean(effectiveOptions.isPreviewArm64Runner);
    const isPreviewRunner =
      chosenLayer?.type === 'crossover_preview' ||
      isArm64Runner ||
      Boolean(effectiveOptions.isPreviewRunner);
    const isStableCrossOverRunner =
      chosenLayer?.type === 'crossover' && !isPreviewRunner;
    const normBottlePath = resolvedBottlePath.replace(/\\/g, '/');
    const bottleBaseName = path.basename(normBottlePath);
    const isSharedStableBottlePath =
      !isArm64Runner &&
      !isArm64FexBottle &&
      bottleBaseName.toLowerCase() !== 'onelauncher-arm64' &&
      /\/CrossOver\/Bottles\//i.test(normBottlePath) &&
      !/\/CrossOver Preview(?: arm64)?\/Bottles\//i.test(normBottlePath);
    const hasCrossOverEnvConfig =
      requestedBackend !== undefined ||
      backendRoute.cxGraphicsBackendEnv !== null ||
      typeof cfg.crossoverD3DMetalVersion === 'string' ||
      typeof cfg.crossoverDlss === 'boolean' ||
      typeof cfg.wineMsync === 'boolean' ||
      typeof cfg.wineEsync === 'boolean' ||
      chosenLayer?.type === 'crossover' ||
      isPreviewRunner ||
      fs.existsSync(cxbottleConfPath);

    if (hasCrossOverEnvConfig) {
      try {
        let existingConf = fs.existsSync(cxbottleConfPath)
          ? fs.readFileSync(cxbottleConfPath, 'utf8').replace(/\0/g, '')
          : '';

        if (isPreviewRunner) {
          const bottleHeaderRe = /^\[Bottle\]\s*$/m;
          const bottleHeaderMatch = bottleHeaderRe.exec(existingConf);
          const extraTag = isSharedStableBottlePath ? '\n"OneLauncherManagedPreview" = "1"' : '';
          if (bottleHeaderMatch) {
            const secStart = bottleHeaderMatch.index + bottleHeaderMatch[0].length;
            const afterHeader = existingConf.slice(secStart);
            const nextSectionMatch = /^\s*\[[^\]]+\]/m.exec(afterHeader);
            const secBody = nextSectionMatch
              ? afterHeader.slice(0, nextSectionMatch.index)
              : afterHeader;
            const remainder = nextSectionMatch ? afterHeader.slice(nextSectionMatch.index) : '';
            let updatedBottleBody = secBody;
            if (/^\s*"Preview"\s*=\s*"[^"]*"/m.test(updatedBottleBody)) {
              updatedBottleBody = updatedBottleBody.replace(
                /^(\s*)"Preview"\s*=\s*"[^"]*"/m,
                '$1"Preview" = "1"'
              );
            } else {
              updatedBottleBody = `\n"Preview" = "1"${extraTag}${updatedBottleBody}`;
            }
            if (!isSharedStableBottlePath) {
              updatedBottleBody = updatedBottleBody.replace(
                /^\s*"OneLauncherManagedPreview"\s*=\s*"[^"]*"\s*\r?\n?/gm,
                ''
              );
            } else if (!/^\s*"OneLauncherManagedPreview"\s*=\s*"1"/m.test(updatedBottleBody)) {
              updatedBottleBody = updatedBottleBody.replace(
                /^(\s*"Preview"\s*=\s*"1")/m,
                '$1\n"OneLauncherManagedPreview" = "1"'
              );
            }
            existingConf = existingConf.slice(0, secStart) + updatedBottleBody + remainder;
          } else {
            const synthesizedArch = isArm64FexBottle ? 'arm64' : 'win64';
            existingConf = `[Bottle]\n"WineArch" = "${synthesizedArch}"\n"Preview" = "1"${extraTag}\n\n${existingConf}`;
          }
        } else if (
          isStableCrossOverRunner &&
          (isSharedStableBottlePath || /^\s*"OneLauncherManagedPreview"\s*=\s*"1"/m.test(existingConf))
        ) {
          existingConf = existingConf
            .replace(/^\s*"Preview"\s*=\s*"1"\s*\r?\n?/gm, '')
            .replace(/^\s*"OneLauncherManagedPreview"\s*=\s*"[^"]*"\s*\r?\n?/gm, '');
        }

        if (
          !cfg.windowsVersion &&
          !effectiveOptions.windowsVersion &&
          /^"WindowsVersion"\s*=\s*"(?:winxp|winxp64|win7|vista|win2k)"/im.test(existingConf) &&
          (/"WineArch"\s*=\s*"(?:win64|arm64)"/i.test(existingConf) ||
            /"Template"\s*=\s*"win10_64"/i.test(existingConf) ||
            !hasPeCaps ||
            peCaps.is64Bit)
        ) {
          existingConf = existingConf.replace(
            /^("WindowsVersion"\s*=\s*)"(?:winxp|winxp64|win7|vista|win2k)"/im,
            '$1"win10"'
          );
        }

        const updates = new Map();
        const removals = new Set();

        const hasExplicitNonAutoBackend = Boolean(
          requestedBackend && requestedBackend !== 'auto' && backendRoute.cxGraphicsBackendEnv
        );
        if (hasExplicitNonAutoBackend) {
          updates.set('CX_GRAPHICS_BACKEND', backendRoute.cxGraphicsBackendEnv);
        } else {
          removals.add('CX_GRAPHICS_BACKEND');
        }

        if (
          isD3DMetalEligible &&
          (d3dmVer === '3' || d3dmVer === '4') &&
          hasMultipleBundledD3dMetal
        ) {
          updates.set('CX_GRAPHICS_BACKEND_VERSION', d3dmVer);
        } else {
          removals.add('CX_GRAPHICS_BACKEND_VERSION');
        }
        removals.add('WINED3DMETAL');

        if (wantMetalFxDlss && !dlssUnsupportedTarget) {
          updates.set('D3DM_ENABLE_METALFX', darwinMajor >= 25 ? '1' : '0');
          updates.set('DXMT_ENABLE_NVEXT', '1');
        } else if (
          cfg.crossoverDlss === false ||
          (wantMetalFxDlss && dlssUnsupportedTarget)
        ) {
          updates.set('D3DM_ENABLE_METALFX', '0');
          updates.set('DXMT_ENABLE_NVEXT', '0');
        } else {
          removals.add('D3DM_ENABLE_METALFX');
          removals.add('DXMT_ENABLE_NVEXT');
        }

        updates.set('WINEMSYNC', env.WINEMSYNC);
        if (isCrossOver25Plus) {
          removals.add('WINEESYNC');
        } else if (env.WINEESYNC !== undefined) {
          updates.set('WINEESYNC', env.WINEESYNC);
        }
        if (
          !isArm64FexBottle &&
          (env.ROSETTA_ADVERTISE_AVX === '1' || env.ROSETTA_ADVERTISE_AVX === '0')
        ) {
          updates.set('ROSETTA_ADVERTISE_AVX', env.ROSETTA_ADVERTISE_AVX);
        } else if (
          isArm64FexBottle &&
          (explicitAvxCfg === true || explicitAvxCfg === '1')
        ) {
          updates.set('ROSETTA_ADVERTISE_AVX', '1');
        } else {
          removals.add('ROSETTA_ADVERTISE_AVX');
        }
        if (cfg.environmentVariables && typeof cfg.environmentVariables === 'object') {
          for (const [fexKey, fexVal] of Object.entries(cfg.environmentVariables)) {
            if (/^FEX_[A-Z0-9_]+$/i.test(fexKey) && typeof fexVal === 'string') {
              const sanitizedFexVal = fexVal.replace(/["\r\n\0]/g, '').trim();
              if (sanitizedFexVal) {
                updates.set(fexKey, sanitizedFexVal);
              }
            }
          }
        }

        const sectionHeaderRe = /^\[EnvironmentVariables\]\s*$/m;
        const headerMatch = sectionHeaderRe.exec(existingConf);

        if (headerMatch) {
          const sectionStart = headerMatch.index + headerMatch[0].length;
          const afterHeader = existingConf.slice(sectionStart);
          const nextSectionMatch = /^\s*\[[^\]]+\]/m.exec(afterHeader);
          const sectionBody = nextSectionMatch
            ? afterHeader.slice(0, nextSectionMatch.index)
            : afterHeader;
          const remainder = nextSectionMatch ? afterHeader.slice(nextSectionMatch.index) : '';

          const lines = sectionBody.split(/\r?\n/);
          const seenKeys = new Set();
          const updatedLines = [];

          for (const line of lines) {
            const kvMatch = line.match(/^\s*"?([A-Za-z0-9_]+)"?\s*=\s*(.*)$/);
            if (kvMatch) {
              const key = kvMatch[1];
              if (removals.has(key)) {
                continue;
              }
              if (updates.has(key)) {
                seenKeys.add(key);
                updatedLines.push(`"${key}" = "${updates.get(key)}"`);
                continue;
              }
            }
            updatedLines.push(line);
          }

          const newEntries = [];
          for (const [k, v] of updates.entries()) {
            if (!seenKeys.has(k)) {
              newEntries.push(`"${k}" = "${v}"`);
            }
          }

          if (newEntries.length > 0) {
            let insertIdx = updatedLines.length;
            while (insertIdx > 0 && updatedLines[insertIdx - 1].trim() === '') {
              insertIdx--;
            }
            updatedLines.splice(insertIdx, 0, ...newEntries);
          }

          const newSectionBody =
            (updatedLines.length > 0 && updatedLines[0] !== '' ? '\n' : '') +
            updatedLines.join('\n') +
            (remainder && !updatedLines[updatedLines.length - 1]?.endsWith('\n') ? '\n' : '');

          const finalConf =
            existingConf.slice(0, sectionStart) + newSectionBody + remainder;
          atomicWriteFileSync(cxbottleConfPath, finalConf);
        } else {
          const envLines = ['[EnvironmentVariables]'];
          for (const [k, v] of updates.entries()) {
            envLines.push(`"${k}" = "${v}"`);
          }
          const prefix =
            existingConf.length > 0 && !existingConf.endsWith('\n')
              ? `${existingConf}\n\n`
              : existingConf.length > 0
                ? `${existingConf}\n`
                : '';
          atomicWriteFileSync(cxbottleConfPath, `${prefix}${envLines.join('\n')}\n`);
        }
      } catch {}
    }
  }

  const enableLegacyDisplay = Boolean(
    effectiveOptions.enableLegacyDisplayModeSynthesis || cfg.enableLegacyDisplayModeSynthesis
  );
  const usesLegacyDdraw = Boolean(
    effectiveOptions.usesLegacyDirectDraw ||
      cfg.usesLegacyDirectDraw ||
      (hasPeCaps && Boolean(peCaps.usesLegacyDdraw))
  );
  const usesLegacyDdrawOrD3d8 = Boolean(
    usesLegacyDdraw || (hasPeCaps && Boolean(peCaps.importsD3d8))
  );
  const resolvedDisplayPolicy = resolveEffectivePerformancePolicy(cfg, effectiveOptions);
  const validBottleScalingModes = new Set([
    'auto_fullscreen',
    'force_fullscreen',
    'native_driver',
    'windowed',
    'virtual_desktop',
    'off',
  ]);
  const effectiveScalingMode =
    typeof effectiveOptions.displayScalingMode === 'string' &&
    validBottleScalingModes.has(effectiveOptions.displayScalingMode)
      ? effectiveOptions.displayScalingMode
      : typeof cfg.displayScalingMode === 'string' &&
          validBottleScalingModes.has(cfg.displayScalingMode)
        ? cfg.displayScalingMode
        : resolvedDisplayPolicy.effectiveDisplayScalingMode || 'auto_fullscreen';

  const effectiveHighResolutionMode =
    typeof cfg.crossoverHighResolutionMode === 'boolean'
      ? cfg.crossoverHighResolutionMode
      : undefined;

  // Coalesced bottle registry hygiene: RetinaMode (per-exe scoped for legacy 32-bit), LogPixels,
  // Desktops, AppDefaults, Direct3D VideoMemorySize / Vulkan / GL routing, reference-counted
  // EmulateModeset, LargeAddressAware, and baseline system.reg / user.reg prefix hygiene flushed
  // in a single `reg.exe import` call.
  if (isBottleDir) {
    try {
      const {
        isBottleWineserverActive,
        upsertWineSystemRegKeysBatch,
        flushLiveWineRegistryAccumulator,
      } = require('../firstPartyRegistration.cjs');
      const userRegPath = path.join(resolvedBottlePath, 'user.reg');
      const systemRegPath = path.join(resolvedBottlePath, 'system.reg');
      const skipLiveSync = Boolean(
        effectiveOptions.skipRegistrySpawn ||
          effectiveOptions.skipLiveWineRegSync ||
          effectiveOptions.homedir
      );
      /** @type {Array<{ hiveName: 'HKEY_LOCAL_MACHINE' | 'HKEY_CURRENT_USER', normalizedSubKey: string, entryPairsOrNullForDelete: Array<[string, any]> | null }>} */
      const liveSyncAccumulator = [];
      const regUpsertOpts = {
        ...effectiveOptions,
        bottlePath: resolvedBottlePath,
        regFilePath: userRegPath,
        skipLiveWineRegSync: skipLiveSync,
        liveSyncAccumulator,
      };
      /** @type {Array<{ subKeyPath: string, entries: Array<[string, any]> }>} */
      const userRegBatchSpecs = [];

      const rawExeInputs = [
        ...explicitExeNamesFromArg,
        effectiveOptions.exeName,
        cfg.exeName,
        ...(Array.isArray(effectiveOptions.targetExeNames) ? effectiveOptions.targetExeNames : []),
        ...(Array.isArray(cfg.targetExeNames) ? cfg.targetExeNames : []),
      ];
      const targetExeSet = new Set();
      for (const rawExe of rawExeInputs) {
        if (typeof rawExe !== 'string' || !rawExe.trim()) continue;
        const baseLower = path.win32.basename(rawExe.trim()).toLowerCase();
        if (baseLower && /\.exe$/i.test(baseLower)) {
          targetExeSet.add(baseLower);
        }
      }
      const targetExes = Array.from(targetExeSet);

      // Inspect pre-existing user.reg state once for non-destructive RetinaMode, AppCompatFlags\Layers & baseline hygiene
      /** @type {string | null} */
      let priorRetinaModeVal = null;
      /** @type {string | null} */
      let savedPriorRetinaVal = null;
      let hasFontsSectionInUserReg = false;
      let hasValveSteamInUserReg = false;
      /** @type {string | null} */
      let globalWineVersionVal = null;
      /** @type {Map<string, string>} */
      const existingAppCompatLayers = new Map();

      if (fs.existsSync(userRegPath)) {
        try {
          let existingUserReg = fs.readFileSync(userRegPath, 'utf8');
          hasFontsSectionInUserReg = /^\[Software\\\\Wine\\\\Fonts\](?:\s+\d+)?[^\r\n]*$/im.test(
            existingUserReg
          );
          hasValveSteamInUserReg = /^\[Software\\\\Valve\\\\Steam\](?:\s+\d+)?[^\r\n]*$/im.test(
            existingUserReg
          );

          // Remove non-symlink `[Software\\Wow6432Node\\Valve...]` shadow sections when `[Software\\Valve\\Steam]` exists
          if (hasValveSteamInUserReg) {
            const lines = existingUserReg.split(/\r?\n/);
            /** @type {string[]} */
            const cleanedLines = [];
            let i = 0;
            let removedValveShadow = false;
            while (i < lines.length) {
              const secHeader = lines[i].match(/^\[(Software\\\\Wow6432Node\\\\Valve(?:\\\\[^\]]*)?)\]/i);
              if (secHeader) {
                const rawEscapedSec = secHeader[1];
                let endIdx = i + 1;
                while (endIdx < lines.length && !/^\[[^\]]+\]/.test(lines[endIdx])) {
                  endIdx += 1;
                }
                const secSlice = lines.slice(i + 1, endIdx).join('\n');
                if (!/^\s*#link\b/m.test(secSlice)) {
                  removedValveShadow = true;
                  liveSyncAccumulator.push({
                    hiveName: 'HKEY_CURRENT_USER',
                    normalizedSubKey: rawEscapedSec.replace(/\\\\/g, '\\'),
                    entryPairsOrNullForDelete: null,
                  });
                  i = endIdx;
                  continue;
                }
              }
              cleanedLines.push(lines[i]);
              i += 1;
            }
            if (removedValveShadow) {
              existingUserReg = cleanedLines.join('\n');
              atomicWriteFileSync(userRegPath, existingUserReg);
            }
          }

          const macSecMatch = /^\[Software\\\\Wine\\\\Mac Driver\](?:\s+\d+)?[^\r\n]*$/im.exec(
            existingUserReg
          );
          if (macSecMatch) {
            const secStart = macSecMatch.index + macSecMatch[0].length;
            const afterSec = existingUserReg.slice(secStart);
            const nextSec = /^\[[^\]]+\]/m.exec(afterSec);
            const secBody = nextSec ? afterSec.slice(0, nextSec.index) : afterSec;
            const rmMatch = /^"RetinaMode"\s*=\s*"([^"]*)"/im.exec(secBody);
            if (rmMatch) priorRetinaModeVal = rmMatch[1];
            const spMatch = /^"OneLauncherPriorRetina"\s*=\s*"([^"]*)"/im.exec(secBody);
            if (spMatch) savedPriorRetinaVal = spMatch[1];
          }

          const layersSecMatch =
            /^\[Software\\\\Microsoft\\\\Windows NT\\\\CurrentVersion\\\\AppCompatFlags\\\\Layers\](?:\s+\d+)?[^\r\n]*$/im.exec(
              existingUserReg
            );
          if (layersSecMatch) {
            const secStart = layersSecMatch.index + layersSecMatch[0].length;
            const afterSec = existingUserReg.slice(secStart);
            const nextSec = /^\[[^\]]+\]/m.exec(afterSec);
            const secBody = nextSec ? afterSec.slice(0, nextSec.index) : afterSec;
            const kvRe = /^"([^"]+)"\s*=\s*"([^"]*)"/gm;
            let kvMatch;
            while ((kvMatch = kvRe.exec(secBody)) !== null) {
              const kLower = String(kvMatch[1] || '').trim().toLowerCase();
              if (kLower) {
                existingAppCompatLayers.set(kLower, String(kvMatch[2] || ''));
              }
            }
          }

          const globalWineMatch = /^\[Software\\\\Wine\](?:\s+\d+)?[^\r\n]*$/im.exec(
            existingUserReg
          );
          if (globalWineMatch) {
            const secStart = globalWineMatch.index + globalWineMatch[0].length;
            const afterSec = existingUserReg.slice(secStart);
            const nextSec = /^\[[^\]]+\]/m.exec(afterSec);
            const secBody = nextSec ? afterSec.slice(0, nextSec.index) : afterSec;
            const verMatch = /^"Version"\s*=\s*"([^"]*)"/im.exec(secBody);
            if (verMatch) globalWineVersionVal = verMatch[1].trim().toLowerCase();
          }
        } catch {}
      }

      // 1. Per-exe AppDefaults\Mac Driver + Self-healing global RetinaMode & LogPixels DPI hygiene
      const captureDisplaysVal = 'n';
      const commonMacDriverEntries = /** @type {Array<[string, any]>} */ ([
        ['CaptureDisplaysForFullscreen', { type: 'sz', value: captureDisplaysVal }],
        ['UseConfinementCursorClipping', { type: 'sz', value: 'y' }],
        ['OpenGLSurfaceMode', { type: 'sz', value: 'infront' }],
        ['LeftOptionIsAlt', { type: 'sz', value: 'y' }],
        ['RightOptionIsAlt', { type: 'sz', value: 'y' }],
      ]);
      if (effectiveHighResolutionMode === false) {
        const priorToSave = savedPriorRetinaVal || (priorRetinaModeVal === 'n' ? 'y' : priorRetinaModeVal || 'y');
        userRegBatchSpecs.push(
          {
            subKeyPath: 'Software\\Wine\\Mac Driver',
            entries: [
              ['RetinaMode', { type: 'sz', value: 'n' }],
              ['OneLauncherManagedRetina', { type: 'sz', value: '1' }],
              ['OneLauncherPriorRetina', { type: 'sz', value: priorToSave }],
              ...commonMacDriverEntries,
            ],
          },
          {
            subKeyPath: 'Control Panel\\Desktop',
            entries: [['LogPixels', { type: 'dword', value: 0x60 }]],
          },
          {
            subKeyPath: 'Software\\Wine\\Fonts',
            entries: [['LogPixels', { type: 'dword', value: 0x60 }]],
          }
        );
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\Mac Driver`,
            entries: [
              ['RetinaMode', { type: 'sz', value: 'n' }],
              ...commonMacDriverEntries,
            ],
          });
        }
      } else {
        // Both `effectiveHighResolutionMode === true` and `undefined` (Default) enforce/heal
        // global RetinaMode="y" + LogPixels=0xc0 (including fresh CrossOver bottles defaulting to "n"
        // and prior `false` launches) and delete OneLauncherManagedRetina / OneLauncherPriorRetina.
        userRegBatchSpecs.push(
          {
            subKeyPath: 'Software\\Wine\\Mac Driver',
            entries: [['RetinaMode', { type: 'sz', value: 'y' }], ...commonMacDriverEntries],
          },
          {
            subKeyPath: 'Control Panel\\Desktop',
            entries: [['LogPixels', { type: 'dword', value: 0xc0 }]],
          }
        );
        if (hasFontsSectionInUserReg) {
          userRegBatchSpecs.push({
            subKeyPath: 'Software\\Wine\\Fonts',
            entries: [['LogPixels', { type: 'dword', value: 0xc0 }]],
          });
        }
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\Mac Driver`,
            entries: [
              ['RetinaMode', { type: 'sz', value: 'y' }],
              ...commonMacDriverEntries,
            ],
          });
        }
      }

      // 1b. Per-executable Wine-native AppCompatFlags\Layers (`HIGHDPIAWARE`) for crisp native Retina rendering
      const STOREFRONT_DPI_EXCLUDED_EXES = new Set([
        'steam.exe',
        'steamwebhelper.exe',
        'steamservice.exe',
        'galaxyclient.exe',
        'galaxyclienthelper.exe',
        'galaxycommunication.exe',
        'epicgameslauncher.exe',
        'epicwebhelper.exe',
        'upc.exe',
        'eadesktop.exe',
        'battlenet.exe',
        'riotclientservices.exe',
        'origin.exe',
        'explorer.exe',
      ]);
      const SECONDARY_LAUNCHER_UTILITY_RE =
        /(?:launcher|config|setup|updater|redist|crash|bootstrapper)\.exe$/i;
      const primaryExeInput =
        explicitExeNamesFromArg[0] || effectiveOptions.exeName || cfg.exeName || '';
      const primaryExeBasenameLower =
        typeof primaryExeInput === 'string' && primaryExeInput.trim()
          ? path.win32.basename(primaryExeInput.trim()).toLowerCase()
          : '';
      const isUnwrappedLegacyWindowed = Boolean(
        (effectiveScalingMode === 'windowed' || effectiveScalingMode === 'off') &&
          hasPeCaps &&
          (peCaps.is32Bit ||
            peCaps.usesLegacyDdraw ||
            peCaps.importsD3d8 ||
            peCaps.importsOpenGl ||
            peCaps.importsLegacyD3dOrGl) &&
          !peCaps.usesModernGraphicsApi
      );
      const exeDeclaresOwnDpi = Boolean(
        hasPeCaps &&
          (peCaps.hasDpiAwareManifest ||
            peCaps.declaresPerMonitorDpi ||
            peCaps.callsPerMonitorDpiApi)
      );
      const hasNonUtilityTargetExe = targetExes.some(
        (t) => !STOREFRONT_DPI_EXCLUDED_EXES.has(t) && !SECONDARY_LAUNCHER_UTILITY_RE.test(t)
      );
      /** @type {Array<[string, any]>} */
      const appCompatLayersUpserts = [];
      /** @type {string[]} */
      const appCompatLayersRemovals = [];
      for (const tExe of targetExes) {
        if (STOREFRONT_DPI_EXCLUDED_EXES.has(tExe)) continue;
        const isPrimaryLauncherStub = Boolean(
          hasPeCaps &&
            peCaps.hasChildGameExecutable &&
            peCaps.isLauncherStubCandidate &&
            primaryExeBasenameLower &&
            tExe === primaryExeBasenameLower
        );
        if (isPrimaryLauncherStub) continue;
        if (targetExes.length > 1 && hasNonUtilityTargetExe && SECONDARY_LAUNCHER_UTILITY_RE.test(tExe)) {
          continue;
        }
        const wantHighDpiAware =
          effectiveHighResolutionMode !== false &&
          !exeDeclaresOwnDpi &&
          !isUnwrappedLegacyWindowed;
        const rawExisting = existingAppCompatLayers.get(tExe) || '';
        const existingTokens = rawExisting
          .split(/\s+/)
          .map((tok) => tok.trim())
          .filter((tok) => tok && tok !== '~');
        if (wantHighDpiAware) {
          const mergedTokens = existingTokens.slice();
          if (!mergedTokens.some((tok) => /^highdpiaware$/i.test(tok))) {
            mergedTokens.push('HIGHDPIAWARE');
          }
          appCompatLayersUpserts.push([tExe, { type: 'sz', value: `~ ${mergedTokens.join(' ')}` }]);
        } else if (existingAppCompatLayers.has(tExe)) {
          const remainingTokens = existingTokens.filter((tok) => !/^highdpiaware$/i.test(tok));
          if (remainingTokens.length > 0) {
            appCompatLayersUpserts.push([
              tExe,
              { type: 'sz', value: `~ ${remainingTokens.join(' ')}` },
            ]);
          } else {
            appCompatLayersRemovals.push(tExe);
          }
        }
      }
      if (appCompatLayersUpserts.length > 0) {
        userRegBatchSpecs.push({
          subKeyPath: 'Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers',
          entries: appCompatLayersUpserts,
        });
      }

      // 2. Global `[Software\\Wine]` `"Version"` poisoning recovery for 64-bit launches
      if (
        (!hasPeCaps || peCaps.is64Bit) &&
        !cfg.windowsVersion &&
        !effectiveOptions.windowsVersion &&
        globalWineVersionVal &&
        (globalWineVersionVal === 'win7' ||
          globalWineVersionVal === 'winxp' ||
          globalWineVersionVal === 'winxp64' ||
          globalWineVersionVal === 'vista' ||
          globalWineVersionVal === 'win2k')
      ) {
        userRegBatchSpecs.push({
          subKeyPath: 'Software\\Wine',
          entries: [['Version', { type: 'sz', value: 'win10' }]],
        });
      }

      // 3. Per-exe Virtual Desktop containment (NEVER forced globally on Explorer\Desktop)
      const displayProbeOpts = skipLiveSync
        ? { ...effectiveOptions, skipDisplayProbe: true }
        : effectiveOptions;
      const effectiveRetinaCoordSpace =
        typeof effectiveHighResolutionMode === 'boolean'
          ? effectiveHighResolutionMode
          : true;
      const hostRes = getHostMaxDisplayResolution(effectiveRetinaCoordSpace, displayProbeOpts);
      const autoDesktopWidth = Math.max(640, Math.round(Number(hostRes?.width) || 1920));
      const autoDesktopHeight = Math.max(480, Math.round(Number(hostRes?.height) || 1080));

      const wantVirtualDesktop = Boolean(
        effectiveScalingMode === 'virtual_desktop' ||
          (cfg.virtualDesktop === true &&
            (!cfg.displayScalingMode || cfg.displayScalingMode === 'default') &&
            !effectiveOptions.displayScalingMode)
      );

      let desktopModeStr = `${autoDesktopWidth}x${autoDesktopHeight}`;
      if (wantVirtualDesktop && typeof cfg.virtualDesktopResolution === 'string') {
        const presetTrimmed = cfg.virtualDesktopResolution.trim().toLowerCase();
        if (presetTrimmed !== 'auto' && /^\d{3,5}x\d{3,5}$/.test(presetTrimmed)) {
          desktopModeStr = presetTrimmed;
        }
      }

      userRegBatchSpecs.push({
        subKeyPath: 'Software\\Wine\\Explorer\\Desktops',
        entries: [['OneLauncher', { type: 'sz', value: desktopModeStr }]],
      });

      if (wantVirtualDesktop) {
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\Explorer`,
            entries: [['Desktop', { type: 'sz', value: 'OneLauncher' }]],
          });
        }
      }

      const limitLegacyGl = Boolean(
        effectiveOptions.limitLegacy32BitGlExtensions || cfg.limitLegacy32BitGlExtensions
      );
      if (limitLegacyGl) {
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\OpenGL`,
            entries: [['EnabledExtensions', { type: 'sz', value: LEGACY_32BIT_OPENGL_ENABLED_EXTENSIONS }]],
          });
        }
      }

      if (usesLegacyDdrawOrD3d8) {
        for (const tExe of targetExes) {
          /** @type {Array<[string, any]>} */
          const legacyD3dEntries = [];
          if (usesLegacyDdraw) {
            legacyD3dEntries.push(['DirectDrawRenderer', { type: 'sz', value: 'opengl' }]);
          }
          if (backendRoute.direct3dRenderer !== 'vulkan') {
            legacyD3dEntries.push(['renderer', { type: 'sz', value: 'gl' }]);
          }
          if (legacyD3dEntries.length > 0) {
            userRegBatchSpecs.push({
              subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\Direct3D`,
              entries: legacyD3dEntries,
            });
          }
        }
      }

      if (backendRoute.direct3dRenderer === 'vulkan') {
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\Direct3D`,
            entries: [['renderer', { type: 'sz', value: 'vulkan' }]],
          });
        }
      }

      // 32-bit Non-LAA (`1.92 GiB` VA) Direct3D VideoMemorySize cap (`1536` MiB) on non-DXMT backends
      if (isPe32NonLaa && backend !== 'dxmt') {
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\Direct3D`,
            entries: [['VideoMemorySize', { type: 'sz', value: '1536' }]],
          });
        }
      }

      // Opt-in Wine AppDefaults LargeAddressAware (`dword:00000001`) for 32-bit targets
      if (cfg.forceLargeAddressAware === true && isPe32Target) {
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}`,
            entries: [['LargeAddressAware', { type: 'dword', value: 1 }]],
          });
        }
      }

      const wantEmulateModeset =
        cfg.emulateModeset === true || effectiveOptions.emulateModeset === true
          ? true
          : cfg.emulateModeset === false || effectiveOptions.emulateModeset === false
            ? false
            : false;
      if (wantEmulateModeset) {
        userRegBatchSpecs.push({
          subKeyPath: 'Software\\Wine\\AppDefaults\\explorer.exe\\X11 Driver',
          entries: [['EmulateModeset', { type: 'sz', value: 'y' }]],
        });
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\X11 Driver`,
            entries: [['EmulateModeset', { type: 'sz', value: 'y' }]],
          });
        }
      }

      const appLocalDllOverrides =
        effectiveOptions.appLocalDllOverrides &&
        typeof effectiveOptions.appLocalDllOverrides === 'object'
          ? effectiveOptions.appLocalDllOverrides
          : null;
      if (appLocalDllOverrides) {
        const dllEntries = Object.entries(appLocalDllOverrides)
          .filter(([k, v]) => k && typeof v === 'string')
          .map(([k, v]) => /** @type {[string, any]} */ ([k, { type: 'sz', value: v }]));
        if (dllEntries.length > 0) {
          for (const tExe of targetExes) {
            userRegBatchSpecs.push({
              subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\DllOverrides`,
              entries: dllEntries,
            });
          }
        }
      }

      if (userRegBatchSpecs.length > 0) {
        upsertWineUserRegKeysBatch(resolvedBottlePath, userRegBatchSpecs, regUpsertOpts);
      }

      // 4. Value removals in `user.reg` (zero-write when absent; recorded into `liveSyncAccumulator` when removed)
      // ALWAYS delete global `HKCU\Software\Wine\Explorer` -> `"Desktop"` so previously poisoned bottles self-heal!
      removeWineRegNamedValue(userRegPath, 'Software\\Wine\\Explorer', 'Desktop', regUpsertOpts);
      if (!wantVirtualDesktop) {
        for (const tExe of targetExes) {
          removeWineRegNamedValue(
            userRegPath,
            `Software\\Wine\\AppDefaults\\${tExe}\\Explorer`,
            'Desktop',
            regUpsertOpts
          );
        }
      }

      removeWineRegNamedValue(
        userRegPath,
        'Software\\Wine\\AppDefaults\\explorer.exe\\Mac Driver',
        'RetinaMode',
        regUpsertOpts
      );
      if (effectiveHighResolutionMode !== false) {
        removeWineRegNamedValue(
          userRegPath,
          'Software\\Wine\\Mac Driver',
          'OneLauncherManagedRetina',
          regUpsertOpts
        );
        removeWineRegNamedValue(
          userRegPath,
          'Software\\Wine\\Mac Driver',
          'OneLauncherPriorRetina',
          regUpsertOpts
        );
      }
      for (const remExe of appCompatLayersRemovals) {
        removeWineRegNamedValue(
          userRegPath,
          'Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers',
          remExe,
          regUpsertOpts
        );
      }

      if (backendRoute.direct3dRenderer !== 'vulkan' && !usesLegacyDdrawOrD3d8 && hasPeCaps) {
        for (const tExe of targetExes) {
          removeWineRegNamedValue(
            userRegPath,
            `Software\\Wine\\AppDefaults\\${tExe}\\Direct3D`,
            'renderer',
            regUpsertOpts
          );
        }
      }

      if (backend === 'dxmt' || isPe32Laa || (hasPeCaps && peCaps.is64Bit)) {
        for (const tExe of targetExes) {
          removeWineRegNamedValue(
            userRegPath,
            `Software\\Wine\\AppDefaults\\${tExe}\\Direct3D`,
            'VideoMemorySize',
            regUpsertOpts
          );
        }
      }

      if (cfg.forceLargeAddressAware === false || (hasPeCaps && peCaps.is64Bit)) {
        for (const tExe of targetExes) {
          removeWineRegNamedValue(
            userRegPath,
            `Software\\Wine\\AppDefaults\\${tExe}`,
            'LargeAddressAware',
            regUpsertOpts
          );
        }
      }

      if (!wantEmulateModeset) {
        for (const tExe of targetExes) {
          removeWineRegNamedValue(
            userRegPath,
            `Software\\Wine\\AppDefaults\\${tExe}\\X11 Driver`,
            'EmulateModeset',
            regUpsertOpts
          );
        }
        let otherExeStillUsesEmulateModeset = false;
        if (fs.existsSync(userRegPath)) {
          try {
            const curUserReg = fs.readFileSync(userRegPath, 'utf8');
            const appDefX11Re =
              /^\[Software\\\\Wine\\\\AppDefaults\\\\([^\\\]]+)\\\\X11 Driver\](?:\s+\d+)?[^\r\n]*$/gim;
            let x11Match;
            while ((x11Match = appDefX11Re.exec(curUserReg)) !== null) {
              const exeLower = String(x11Match[1] || '').trim().toLowerCase();
              if (!exeLower || exeLower === 'explorer.exe') continue;
              const secStart = x11Match.index + x11Match[0].length;
              const afterSec = curUserReg.slice(secStart);
              const nextSec = /^\[[^\]]+\]/m.exec(afterSec);
              const secBody = nextSec ? afterSec.slice(0, nextSec.index) : afterSec;
              if (/^"EmulateModeset"\s*=\s*"y"/im.test(secBody)) {
                otherExeStillUsesEmulateModeset = true;
                break;
              }
            }
          } catch {}
        }
        if (!otherExeStillUsesEmulateModeset) {
          removeWineRegNamedValue(
            userRegPath,
            'Software\\Wine\\AppDefaults\\explorer.exe\\X11 Driver',
            'EmulateModeset',
            regUpsertOpts
          );
        }
      }

      // 5. Baseline `system.reg` prefix hygiene (FontSubstitutes & ServicesPipeTimeout when initialized)
      if (fs.existsSync(systemRegPath)) {
        try {
          const sysContent = fs.readFileSync(systemRegPath, 'utf8');
          /** @type {Array<{ subKeyPath: string, entries: Array<[string, any]> }>} */
          const sysRegBatchSpecs = [];

          const fontSubRe =
            /^\[Software\\\\Microsoft\\\\Windows NT\\\\CurrentVersion\\\\FontSubstitutes\](?:\s+\d+)?[^\r\n]*$/im;
          const fontSubMatch = fontSubRe.exec(sysContent);
          let fontSubBody = '';
          if (fontSubMatch) {
            const secStart = fontSubMatch.index + fontSubMatch[0].length;
            const afterSec = sysContent.slice(secStart);
            const nextSec = /^\[[^\]]+\]/m.exec(afterSec);
            fontSubBody = nextSec ? afterSec.slice(0, nextSec.index) : afterSec;
          }

          const windowsDir = resolveDriveCPathCaseInsensitive(resolvedBottlePath, [
            'drive_c',
            'windows',
          ]);
          /** @type {Set<string>} */
          const installedFontNamesLower = new Set();
          if (windowsDir && fs.existsSync(windowsDir)) {
            const fontsDir = resolveDriveCPathCaseInsensitive(resolvedBottlePath, [
              'drive_c',
              'windows',
              'fonts',
            ]);
            if (fontsDir && fs.existsSync(fontsDir)) {
              try {
                for (const fn of fs.readdirSync(fontsDir)) {
                  installedFontNamesLower.add(fn.toLowerCase());
                }
              } catch {}
            }
          }

          /** @type {Array<[string, any]>} */
          const missingFontSubs = [];
          if (
            !/^"Palatino Linotype"\s*=/im.test(fontSubBody) &&
            !installedFontNamesLower.has('pala.ttf')
          ) {
            missingFontSubs.push(['Palatino Linotype', { type: 'sz', value: 'Palatino' }]);
          }
          if (windowsDir && fs.existsSync(windowsDir)) {
            if (
              !/^"Segoe UI"\s*=/im.test(fontSubBody) &&
              !installedFontNamesLower.has('segoeui.ttf')
            ) {
              missingFontSubs.push(['Segoe UI', { type: 'sz', value: 'Helvetica Neue' }]);
            }
            if (
              !/^"MS UI Gothic"\s*=/im.test(fontSubBody) &&
              !installedFontNamesLower.has('msgothic.ttc') &&
              !installedFontNamesLower.has('msgothic.ttf')
            ) {
              missingFontSubs.push(['MS UI Gothic', { type: 'sz', value: 'Hiragino Sans' }]);
            }
          }
          if (missingFontSubs.length > 0) {
            sysRegBatchSpecs.push({
              subKeyPath: 'Software\\Microsoft\\Windows NT\\CurrentVersion\\FontSubstitutes',
              entries: missingFontSubs,
            });
          }

          const ctrlSecRe = /^\[System\\\\CurrentControlSet\\\\Control\](?:\s+\d+)?[^\r\n]*$/im;
          const ctrlMatch = ctrlSecRe.exec(sysContent);
          const ctrlBody = ctrlMatch
            ? (() => {
                const secStart = ctrlMatch.index + ctrlMatch[0].length;
                const afterSec = sysContent.slice(secStart);
                const nextSec = /^\[[^\]]+\]/m.exec(afterSec);
                return nextSec ? afterSec.slice(0, nextSec.index) : afterSec;
              })()
            : '';
          if (!/^"ServicesPipeTimeout"\s*=/im.test(ctrlBody)) {
            sysRegBatchSpecs.push({
              subKeyPath: 'System\\CurrentControlSet\\Control',
              entries: [['ServicesPipeTimeout', { type: 'dword', value: 60000 }]],
            });
          }

          if (sysRegBatchSpecs.length > 0) {
            upsertWineSystemRegKeysBatch(resolvedBottlePath, sysRegBatchSpecs, {
              ...effectiveOptions,
              bottlePath: resolvedBottlePath,
              regFilePath: systemRegPath,
              skipLiveWineRegSync: skipLiveSync,
              liveSyncAccumulator,
            });
          }
        } catch {}
      }

      // 6. Single coalesced live `reg.exe import` sync (or explicit `syncLiveWineReg === true` CLI fallback)
      const bottleServerLive = !skipLiveSync && isBottleWineserverActive(resolvedBottlePath, effectiveOptions);
      if (bottleServerLive && liveSyncAccumulator.length > 0) {
        flushLiveWineRegistryAccumulator(resolvedBottlePath, liveSyncAccumulator, {
          ...effectiveOptions,
          wineBinary: candidateWineBin || effectiveOptions.wineBinary,
          layerType: chosenLayer?.type,
          env,
        }).catch(() => {});
      } else if (
        effectiveOptions?.syncLiveWineReg === true &&
        typeof effectiveHighResolutionMode === 'boolean' &&
        !effectiveOptions.homedir &&
        !effectiveOptions.skipRegistrySpawn &&
        chosenLayer?.binaryPath &&
        fs.existsSync(chosenLayer.binaryPath)
      ) {
        const retinaVal = effectiveHighResolutionMode ? 'y' : 'n';
        const logPixelsDec = effectiveHighResolutionMode ? '192' : '96';
        const aligned = prepareAlignedBottleWineCommand({
          wineBinary: chosenLayer.binaryPath,
          bottlePath: resolvedBottlePath,
          env: { ...process.env, ...env },
          suppressGuiDialogs: true,
          layerType: chosenLayer?.type,
        });
        const liveRegExec =
          typeof effectiveOptions.execFileFn === 'function'
            ? effectiveOptions.execFileFn
            : typeof effectiveOptions.execFileImpl === 'function'
              ? effectiveOptions.execFileImpl
              : execFile;
        const runLiveRegAdd = (/** @type {string[]} */ regArgs) =>
          new Promise((resolve) => {
            try {
              liveRegExec(
                aligned.wineBinary,
                [...aligned.prefixArgs, ...regArgs],
                { timeout: 2500, env: aligned.env },
                () => resolve(true)
              );
            } catch {
              resolve(false);
            }
          });
        const prefixKey = path.resolve(resolvedBottlePath);
        const priorPending = pendingWineRegSyncByPrefix.get(prefixKey) || Promise.resolve();
        const syncPromise = priorPending
          .catch(() => {})
          .then(() =>
            Promise.race([
              Promise.all([
                runLiveRegAdd([
                  'reg',
                  'add',
                  'HKCU\\Software\\Wine\\Mac Driver',
                  '/v',
                  'RetinaMode',
                  '/t',
                  'REG_SZ',
                  '/d',
                  retinaVal,
                  '/f',
                ]),
                runLiveRegAdd([
                  'reg',
                  'add',
                  'HKCU\\Control Panel\\Desktop',
                  '/v',
                  'LogPixels',
                  '/t',
                  'REG_DWORD',
                  '/d',
                  logPixelsDec,
                  '/f',
                ]),
                runLiveRegAdd([
                  'reg',
                  'add',
                  'HKCU\\Software\\Wine\\Fonts',
                  '/v',
                  'LogPixels',
                  '/t',
                  'REG_DWORD',
                  '/d',
                  logPixelsDec,
                  '/f',
                ]),
              ]),
              new Promise((resolve) => {
                const t = setTimeout(resolve, 3000);
                if (typeof t.unref === 'function') t.unref();
              }),
            ])
          )
          .finally(() => {
            if (pendingWineRegSyncByPrefix.get(prefixKey) === syncPromise) {
              pendingWineRegSyncByPrefix.delete(prefixKey);
            }
          });
        pendingWineRegSyncByPrefix.set(prefixKey, syncPromise);
      }
    } catch {}
  }

  if (
    isBottleDir &&
    (process.platform === 'darwin' ||
      effectiveOptions.platform === 'darwin' ||
      effectiveOptions.sanitizeDisplayConfigs)
  ) {
    try {
      const effectiveAspectRatio =
        typeof effectiveOptions.displayAspectRatio === 'string' &&
        effectiveOptions.displayAspectRatio
          ? effectiveOptions.displayAspectRatio
          : resolvedDisplayPolicy.effectiveDisplayAspectRatio || 'preserve_aspect';
      sanitizeWinePrefixDisplayConfigs(resolvedBottlePath, {
        ...effectiveOptions,
        displayScalingMode: effectiveScalingMode,
        displayAspectRatio: effectiveAspectRatio,
        ...(typeof effectiveHighResolutionMode === 'boolean'
          ? { highResolutionMode: effectiveHighResolutionMode }
          : {}),
      });
      setBoundedMapEntry(
        recentDisplaySanitizeCache,
        buildDisplaySanitizeCacheKey({
          prefixPath: resolvedBottlePath,
          highResolutionMode: effectiveHighResolutionMode,
          displayScalingMode: effectiveScalingMode,
          displayAspectRatio: effectiveAspectRatio,
          installDir: effectiveOptions.installDir,
        }),
        Date.now(),
        256
      );
    } catch {}
  }

  return env;
}

async function provisionCrossOverBottleViaCxbottle(
  /** @type {any} */ chosenLayer,
  /** @type {string} */ targetBottle,
  /** @type {string} */ bottlePath,
  /** @type {Record<string, any>} */ env = {},
  /** @type {Record<string, any>} */ options = {},
  /** @type {AbortSignal | null | undefined} */ signal = null
) {
  if (!safeIsBottleSlug(targetBottle)) {
    throw new Error(`Invalid CrossOver bottle name "${targetBottle}".`);
  }
  const layerType = String(chosenLayer?.type || '').trim();
  const isArm64Preview = layerType === 'crossover_preview_arm64';
  const homedir = options.homedir || os.homedir();
  const sharedBottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
  const bottlesDir = path.dirname(bottlePath);

  const layerBinaryPath = chosenLayer?.binaryPath ? String(chosenLayer.binaryPath) : '';
  const layerAppPath = chosenLayer?.appPath ? String(chosenLayer.appPath) : '';
  const isIsolatedTestEnv = Boolean(
    options?.homedir || options?.applicationsDirs || options?.customApplicationsDir
  );
  const hasExplicitBundleOnDisk = Boolean(
    (layerAppPath && fs.existsSync(layerAppPath)) ||
      (layerBinaryPath && fs.existsSync(layerBinaryPath))
  );
  const allowHostApplicationsFallback = !isIsolatedTestEnv && !hasExplicitBundleOnDisk;
  const cxbottleCandidates = [
    layerBinaryPath ? path.join(path.dirname(layerBinaryPath), 'cxbottle') : null,
    layerAppPath
      ? path.join(layerAppPath, 'Contents/SharedSupport/CrossOver/bin/cxbottle')
      : null,
    ...(allowHostApplicationsFallback
      ? isArm64Preview
        ? ['/Applications/CrossOver Preview arm64.app/Contents/SharedSupport/CrossOver/bin/cxbottle']
        : layerType === 'crossover_preview'
          ? ['/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/cxbottle']
          : [
              '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/cxbottle',
              '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/cxbottle',
            ]
      : []),
  ].filter(Boolean);
  const cxbottleBin = cxbottleCandidates.find((p) => p && fs.existsSync(p));
  if (!cxbottleBin) {
    throw new Error(
      `CrossOver bottle provisioning failed: cxbottle CLI not found for ${layerType || 'crossover'} (cannot create "${targetBottle}").`
    );
  }

  try {
    if (!fs.existsSync(bottlesDir)) {
      fs.mkdirSync(bottlesDir, { recursive: true });
    }
  } catch {}

  /** @type {Record<string, any>} */
  const cxbottleCreateEnv = { ...process.env, ...env };
  delete cxbottleCreateEnv.DYLD_INSERT_LIBRARIES;
  if (path.resolve(bottlesDir) !== path.resolve(sharedBottlesDir)) {
    cxbottleCreateEnv.CX_BOTTLE_PATH = bottlesDir;
  }

  const args = [
    '--bottle',
    targetBottle,
    '--create',
    '--template',
    'win10_64',
    ...(isArm64Preview ? ['--winearch', 'arm64'] : []),
  ];
  const execFileImpl = typeof options.execFileFn === 'function' ? options.execFileFn : execFile;
  await new Promise((resolve, reject) => {
    try {
      execFileImpl(
        cxbottleBin,
        args,
        {
          timeout: 60000,
          env: cxbottleCreateEnv,
          ...(signal ? { signal } : {}),
        },
        (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
          if (err) {
            const detail = String(stderr || stdout || err.message || err).trim();
            reject(
              new Error(
                `cxbottle failed creating "${targetBottle}" (${layerType || 'crossover'}): ${detail}`
              )
            );
            return;
          }
          invalidateCompatLayersCache();
          resolve(true);
        }
      );
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Compare two directory paths for equivalence, accounting for normalized slashes,
 * case-insensitivity on macOS/Windows, and symlinked temp/parent roots (`realpathSync`).
 *
 * @param {string} dirA
 * @param {string} dirB
 * @returns {boolean}
 */
function areSameNormalizedDirPath(dirA, dirB) {
  if (!dirA || !dirB) return false;
  const norm = (/** @type {string} */ p) =>
    path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (norm(dirA) === norm(dirB)) {
    return true;
  }
  try {
    if (fs.existsSync(dirA) && fs.existsSync(dirB)) {
      return norm(fs.realpathSync(dirA)) === norm(fs.realpathSync(dirB));
    }
  } catch {}
  return false;
}

/**
 * Shared internal CrossOver bottle resolution used by `resolveCrossOverTargetBottleName`,
 * `predictTargetBottlePrefix`, and `ensureCompatibilityLayerReady` so lock prediction and
 * actual bottle provisioning/launching can never diverge.
 *
 * @param {any} chosenLayer
 * @param {any} [launchConfig]
 * @param {any} [options]
 * @returns {{
 *   isArm64Runner: boolean,
 *   sharedBottlesDir: string,
 *   bottlesDir: string,
 *   availableBottles: string[],
 *   compatibleBottles: string[],
 *   targetBottle: string | null,
 *   invalidExplicitBottleName: string | null,
 * } | null}
 */
function resolveCrossOverBottlesDirAndTarget(chosenLayer, launchConfig = {}, options = {}) {
  if (
    !chosenLayer ||
    typeof chosenLayer !== 'object' ||
    (chosenLayer.type !== 'crossover' &&
      chosenLayer.type !== 'crossover_preview' &&
      chosenLayer.type !== 'crossover_preview_arm64')
  ) {
    return null;
  }

  const homedir = options.homedir || os.homedir();
  const isMockHomedir = Boolean(options.homedir || options.customApplicationsDir);
  const isArm64Runner = chosenLayer.type === 'crossover_preview_arm64';
  const sharedBottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
  const previewBottlesDir = path.join(
    homedir,
    'Library/Application Support/CrossOver Preview/Bottles'
  );
  const previewArm64BottlesDir = path.join(
    homedir,
    'Library/Application Support/CrossOver Preview arm64/Bottles'
  );
  const effectivePreviewBottlesDir = hasValidInitializedBottles(previewBottlesDir, false)
    ? previewBottlesDir
    : hasValidInitializedBottles(sharedBottlesDir, false)
      ? sharedBottlesDir
      : isMockHomedir && hasValidInitializedBottles(previewBottlesDir, true)
        ? previewBottlesDir
        : !isMockHomedir && fs.existsSync(sharedBottlesDir)
          ? sharedBottlesDir
          : previewBottlesDir;
  const defaultBottlesDir =
    chosenLayer.type === 'crossover'
      ? sharedBottlesDir
      : isArm64Runner
        ? hasValidInitializedBottles(previewArm64BottlesDir, false)
          ? previewArm64BottlesDir
          : effectivePreviewBottlesDir
        : effectivePreviewBottlesDir;

  const bottlesDir = chosenLayer.bottlesDir || defaultBottlesDir;
  const availableBottles = listBottleSubdirectories(bottlesDir, options);
  const compatibleBottles = availableBottles.filter((bName) => {
    const detailArch = chosenLayer.bottleDetails?.[bName]?.wineArch;
    const metaArch =
      detailArch || inspectBottleConfMetadata(path.join(bottlesDir, bName)).wineArch;
    return isArm64Runner ? metaArch === 'arm64' : metaArch !== 'arm64';
  });

  const explicitBottleName =
    launchConfig && typeof launchConfig.wineBottleName === 'string'
      ? launchConfig.wineBottleName.trim()
      : '';
  if (explicitBottleName) {
    if (!safeIsBottleSlug(explicitBottleName)) {
      return {
        isArm64Runner,
        sharedBottlesDir,
        bottlesDir,
        availableBottles,
        compatibleBottles,
        targetBottle: null,
        invalidExplicitBottleName: explicitBottleName,
      };
    }
    return {
      isArm64Runner,
      sharedBottlesDir,
      bottlesDir,
      availableBottles,
      compatibleBottles,
      targetBottle: explicitBottleName,
      invalidExplicitBottleName: null,
    };
  }

  let targetBottle = '';
  const installPathHint = String(
    options?.installDir || options?.installPath || options?.executablePath || ''
  ).trim();
  const installBottleRoot = installPathHint ? extractBottleRootFromPath(installPathHint) : null;
  if (installBottleRoot) {
    const installParentDir = path.dirname(installBottleRoot);
    const installBottleName = path.basename(installBottleRoot);
    if (
      installBottleName &&
      safeIsBottleSlug(installBottleName) &&
      areSameNormalizedDirPath(installParentDir, bottlesDir)
    ) {
      const matchedCompatBottle = compatibleBottles.find(
        (bName) => bName.toLowerCase() === installBottleName.toLowerCase()
      );
      if (matchedCompatBottle) {
        targetBottle = matchedCompatBottle;
      }
    }
  }

  if (!targetBottle) {
    if (isArm64Runner) {
      targetBottle = compatibleBottles.includes('OneLauncher-arm64')
        ? 'OneLauncher-arm64'
        : compatibleBottles.length > 0 && safeIsBottleSlug(compatibleBottles[0])
          ? compatibleBottles[0]
          : 'OneLauncher-arm64';
    } else if (compatibleBottles.includes('OneLauncher')) {
      targetBottle = 'OneLauncher';
    } else if (compatibleBottles.includes('default')) {
      targetBottle = 'default';
    } else if (compatibleBottles.length > 0 && safeIsBottleSlug(compatibleBottles[0])) {
      targetBottle = compatibleBottles[0];
    } else {
      targetBottle = 'OneLauncher';
    }
  }

  return {
    isArm64Runner,
    sharedBottlesDir,
    bottlesDir,
    availableBottles,
    compatibleBottles,
    targetBottle,
    invalidExplicitBottleName: null,
  };
}

/**
 * Shared target CrossOver bottle name resolver honoring:
 *   1. Explicit `launchConfig.wineBottleName`
 *   2. Install-bottle affinity when `options.installDir || options.installPath || options.executablePath`
 *      resides inside `bottlesDir` in a compatible bottle
 *   3. Canonical runner defaults (`OneLauncher` / `default` / `OneLauncher-arm64` / first compatible)
 *
 * @param {any} chosenLayer
 * @param {any} [launchConfig]
 * @param {any} [options]
 * @returns {string | null}
 */
function resolveCrossOverTargetBottleName(chosenLayer, launchConfig = {}, options = {}) {
  const resolved = resolveCrossOverBottlesDirAndTarget(chosenLayer, launchConfig, options);
  return resolved ? resolved.targetBottle : null;
}

/**
 * Resolve the target Wine prefix for standalone `wine` / `gptk` runners, honoring explicit
 * `launchConfig.winePrefixPath` first and non-CrossOver install-prefix affinity second.
 *
 * @param {any} [launchConfig]
 * @param {any} [options]
 * @returns {string}
 */
function resolveStandaloneWineTargetPrefix(launchConfig = {}, options = {}) {
  if (
    launchConfig &&
    typeof launchConfig.winePrefixPath === 'string' &&
    launchConfig.winePrefixPath.trim()
  ) {
    return path.resolve(launchConfig.winePrefixPath.trim());
  }
  const installPathHint = String(
    options?.installDir || options?.installPath || options?.executablePath || ''
  ).trim();
  const installBottleRoot = installPathHint ? extractBottleRootFromPath(installPathHint) : null;
  if (installBottleRoot && fs.existsSync(installBottleRoot)) {
    const resolvedRoot = path.resolve(installBottleRoot);
    const hasDriveC = fs.existsSync(path.join(resolvedRoot, 'drive_c'));
    const hasCxConf = fs.existsSync(path.join(resolvedRoot, 'cxbottle.conf'));
    const meta = hasCxConf ? inspectBottleConfMetadata(resolvedRoot) : {};
    if (hasDriveC && !hasCxConf && meta.wineArch !== 'arm64') {
      return resolvedRoot;
    }
  }
  const homedir = options.homedir || os.homedir();
  return path.resolve(path.join(homedir, 'Games/OneLauncher/Prefixes/default'));
}

/**
 * Pure, side-effect-free prediction of the target Wine/CrossOver prefix path that
 * `ensureCompatibilityLayerReady` will operate on, so `launchGame` can acquire
 * `pendingBottleLaunches` and await `inFlightPostSessionByBottle` BEFORE mutating the bottle.
 *
 * @param {any} chosenLayer
 * @param {any} [launchConfig]
 * @param {any} [options]
 * @returns {string | null}
 */
function predictTargetBottlePrefix(chosenLayer, launchConfig = {}, options = {}) {
  if (!chosenLayer || typeof chosenLayer !== 'object') return null;
  if (
    launchConfig &&
    typeof launchConfig.winePrefixPath === 'string' &&
    launchConfig.winePrefixPath.trim()
  ) {
    return path.resolve(launchConfig.winePrefixPath.trim());
  }

  const cxResolved = resolveCrossOverBottlesDirAndTarget(chosenLayer, launchConfig, options);
  if (cxResolved) {
    if (!cxResolved.targetBottle) {
      return null;
    }
    return path.resolve(path.join(cxResolved.bottlesDir, cxResolved.targetBottle));
  }

  return resolveStandaloneWineTargetPrefix(launchConfig, options);
}

async function ensureCompatibilityLayerReady(
  /** @type {any} */ chosenLayer,
  /** @type {any} */ launchConfig = {},
  /** @type {Record<string, any>} */ env = {},
  /** @type {any} */ options = {}
) {
  if (!chosenLayer) return {};
  const isMockHomedir = Boolean(options.homedir || options.customApplicationsDir);
  const platform = options.platform || process.platform;
  const hostArch = String(
    options.arch || options.hostArch || process.arch || 'arm64'
  ).toLowerCase();

  if (
    chosenLayer.type === 'crossover_preview_arm64' &&
    platform === 'darwin' &&
    (hostArch !== 'arm64' || chosenLayer.available === false)
  ) {
    throw new Error(
      'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
    );
  }

  const cxResolved = resolveCrossOverBottlesDirAndTarget(chosenLayer, launchConfig, options);
  if (cxResolved) {
    if (cxResolved.invalidExplicitBottleName) {
      throw new Error(`Invalid CrossOver bottle name "${cxResolved.invalidExplicitBottleName}".`);
    }
    const { isArm64Runner, sharedBottlesDir, bottlesDir } = cxResolved;
    const targetBottle = String(cxResolved.targetBottle || 'OneLauncher');

    const bottlePath = path.join(bottlesDir, targetBottle);
    const effectiveBottleCheckPath =
      launchConfig &&
      launchConfig.winePrefixPath &&
      fs.existsSync(launchConfig.winePrefixPath)
        ? launchConfig.winePrefixPath
        : bottlePath;

    assertRunnerBottleArchCompatible(chosenLayer.type, targetBottle, effectiveBottleCheckPath);

    const isBottleInitialized = isValidBottleDirectory(effectiveBottleCheckPath, isMockHomedir);

    if (!isBottleInitialized && !options.skipBottleProvisioning) {
      if (!options.homedir || typeof options.execFileFn === 'function') {
        await provisionCrossOverBottleViaCxbottle(
          chosenLayer,
          targetBottle,
          bottlePath,
          env,
          options,
          options.signal
        );
        assertRunnerBottleArchCompatible(chosenLayer.type, targetBottle, bottlePath);
      }
    }

    env.CX_BOTTLE = targetBottle;
    if (path.resolve(bottlesDir) !== path.resolve(sharedBottlesDir) && !env.CX_BOTTLE_PATH) {
      env.CX_BOTTLE_PATH = bottlesDir;
    }
    if (launchConfig && launchConfig.winePrefixPath) {
      env.WINEPREFIX = launchConfig.winePrefixPath;
    } else if (fs.existsSync(bottlePath)) {
      env.WINEPREFIX = bottlePath;
    }
    env.WINEMSYNC = env.WINEMSYNC ?? '1';
    delete env.WINEESYNC;

    const resolvedBottlePrefix = env.WINEPREFIX || bottlePath;
    const shouldSkipUninitBottleMutations =
      options.skipBottleProvisioning === true &&
      !isValidBottleDirectory(resolvedBottlePrefix, false);
    if (!shouldSkipUninitBottleMutations) {
      try {
        await sandboxWinePrefixUserFoldersAsync(resolvedBottlePrefix, options);
      } catch {}

      applyCrossOverPerGameSettings(
        chosenLayer,
        launchConfig,
        env,
        resolvedBottlePrefix,
        { ...options, skipUserFolderSandbox: true }
      );
      if (resolvedBottlePrefix) {
        const pendingReg = pendingWineRegSyncByPrefix.get(path.resolve(resolvedBottlePrefix));
        if (pendingReg) {
          try {
            await pendingReg;
          } catch {}
        }
      }
    }

    const resolvedWineArch =
      inspectBottleConfMetadata(resolvedBottlePrefix).wineArch ||
      (isArm64Runner ? 'arm64' : 'win64');
    const effectiveWineBinary = resolveSipSafeWineBinaryAndPreloadEnv(chosenLayer.binaryPath, env, {
      layerType: chosenLayer.type,
      wineArch: resolvedWineArch,
    });
    return {
      targetBottle,
      winePrefix: env.WINEPREFIX,
      wineArch: resolvedWineArch,
      wineBinary: effectiveWineBinary,
      wineserverBinary: resolveWineserverBinary(chosenLayer.binaryPath, {
        layerType: chosenLayer.type,
        wineArch: resolvedWineArch,
      }),
    };
  }

  const targetPrefix = resolveStandaloneWineTargetPrefix(launchConfig, options);

  try {
    if (targetPrefix && !fs.existsSync(targetPrefix)) {
      fs.mkdirSync(targetPrefix, { recursive: true });
    }
  } catch {}

  env.WINEPREFIX = targetPrefix;
  if (env.WINEMSYNC === '1') {
    env.WINEESYNC = '0';
  } else if (env.WINEESYNC === '1') {
    env.WINEMSYNC = '0';
  } else {
    env.WINEMSYNC = env.WINEMSYNC ?? '1';
    env.WINEESYNC = env.WINEESYNC ?? (env.WINEMSYNC === '1' ? '0' : '1');
  }
  if (!String(env.WINEDLLOVERRIDES || '').includes('winemenubuilder.exe=d')) {
    env.WINEDLLOVERRIDES = env.WINEDLLOVERRIDES
      ? `${env.WINEDLLOVERRIDES};winemenubuilder.exe=d`
      : 'winemenubuilder.exe=d';
  }

  if (
    targetPrefix &&
    !fs.existsSync(path.join(targetPrefix, 'system.reg')) &&
    !options.skipBottleProvisioning &&
    !options.homedir &&
    (!isTestEnvironment(options) || options.forceStandaloneWineboot === true) &&
    chosenLayer.binaryPath &&
    fs.existsSync(chosenLayer.binaryPath)
  ) {
    try {
      const alignedBoot = prepareAlignedBottleWineCommand({
        wineBinary: chosenLayer.binaryPath,
        bottlePath: targetPrefix,
        env: { ...process.env, ...env },
        suppressGuiDialogs: true,
        layerType: chosenLayer.type,
      });
      const execFileImpl =
        typeof options.execFileFn === 'function' ? options.execFileFn : execFile;
      await new Promise((resolve) => {
        try {
          execFileImpl(
            alignedBoot.wineBinary,
            [...alignedBoot.prefixArgs, 'wineboot', '-u'],
            { timeout: 45000, env: alignedBoot.env },
            () => resolve(true)
          );
        } catch {
          resolve(false);
        }
      });
    } catch {}
  }

  try {
    await sandboxWinePrefixUserFoldersAsync(env.WINEPREFIX || targetPrefix, options);
  } catch {}

  const resolvedTargetPrefix = env.WINEPREFIX || targetPrefix;
  applyCrossOverPerGameSettings(
    chosenLayer,
    launchConfig,
    env,
    resolvedTargetPrefix,
    { ...options, skipUserFolderSandbox: true }
  );
  if (resolvedTargetPrefix) {
    const pendingReg = pendingWineRegSyncByPrefix.get(path.resolve(resolvedTargetPrefix));
    if (pendingReg) {
      try {
        await pendingReg;
      } catch {}
    }
  }

  const effectiveWineBinary = resolveSipSafeWineBinaryAndPreloadEnv(chosenLayer.binaryPath, env, {
    layerType: chosenLayer.type,
  });
  return {
    winePrefix: targetPrefix,
    wineBinary: effectiveWineBinary,
    wineserverBinary: resolveWineserverBinary(chosenLayer.binaryPath),
  };
}

module.exports = {
  LEGACY_32BIT_OPENGL_ENABLED_EXTENSIONS,
  removeWineRegNamedValue,
  mergeSemicolonConfigClauses,
  detectCrossOverBackendLayerSupport,
  resolveEffectiveCrossOverGraphicsBackend,
  cleanNonApfsAppleDoubleTwins,
  applyCrossOverPerGameSettings,
  provisionCrossOverBottleViaCxbottle,
  resolveCrossOverTargetBottleName,
  predictTargetBottlePrefix,
  ensureCompatibilityLayerReady,
};
