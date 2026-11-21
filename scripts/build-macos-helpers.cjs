#!/usr/bin/env node
'use strict';

/**
 * Build & verify One Launcher's universal (arm64 + x86_64) macOS helper dylibs:
 *   - `electron/helpers/libone_metal_preload.dylib` (zero static Metal/CoreFoundation links!)
 *   - `electron/helpers/libone_coop_activate.dylib` (AppKit/CoreGraphics N-API focus & display restore)
 *
 * Security & AMFI Invariants (HI-9 / MH-01 / MH-02):
 *   - Ad-hoc signing (`--sign -`) MUST NEVER include `--options runtime` (Hardened Runtime
 *     on an ad-hoc signature triggers dyld4 Team ID / Library Validation aborts when
 *     injected via DYLD_INSERT_LIBRARIES into CrossOver/Wine processes).
 *   - `libone_metal_preload.dylib` MUST NOT statically link Metal.framework,
 *     CoreFoundation.framework, or CoreAudio.framework so non-GUI Wine daemons
 *     (`wineserver`, `reg.exe`, `wineboot.exe`) never run framework initializers
 *     before the constructor's process-denylist guard executes.
 *   - `electron/helpers/macos-helpers-manifest.json` is strictly a build/CI `--verify`
 *     artifact — NEVER runtime-verified against packaged `.app` dylibs because
 *     `build/afterPack.cjs` re-signs `.app` dylibs with Developer ID during packaging.
 */

const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const HELPERS_DIR = path.join(ROOT_DIR, 'electron', 'helpers');
const SRC_PATH = path.join(HELPERS_DIR, 'one_metal_preload.c');
const OUT_DYLIB = path.join(HELPERS_DIR, 'libone_metal_preload.dylib');
const COOP_SRC_PATH = path.join(HELPERS_DIR, 'one_coop_activate.c');
const COOP_OUT_DYLIB = path.join(HELPERS_DIR, 'libone_coop_activate.dylib');
const MANIFEST_PATH = path.join(HELPERS_DIR, 'macos-helpers-manifest.json');

const TRACKED_MANIFEST_SOURCES = [
  'electron/helpers/common_process_denylist.h',
  'electron/helpers/one_metal_preload.c',
  'electron/helpers/one_coop_activate.c',
  'scripts/build-macos-helpers.cjs',
];

const METAL_PRELOAD_FORBIDDEN_LINK_DEPS = [
  'Metal.framework',
  'CoreFoundation.framework',
  'CoreAudio.framework',
];

function computeBufferSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function computeSourceManifestDigests() {
  const out = {};
  for (const rel of TRACKED_MANIFEST_SOURCES) {
    const abs = path.join(ROOT_DIR, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`Missing tracked macOS helper source file: ${abs}`);
    }
    const normalizedText = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    out[rel] = computeBufferSha256(Buffer.from(normalizedText, 'utf8'));
  }
  return out;
}

function inspectUniversalMachOHeader(dylibPath) {
  if (!fs.existsSync(dylibPath)) {
    throw new Error(`Missing macOS helper dylib: ${dylibPath}`);
  }
  const buf = fs.readFileSync(dylibPath);
  if (buf.length <= 16384) {
    throw new Error(`macOS helper dylib unexpectedly small (${buf.length} bytes): ${dylibPath}`);
  }
  // Universal Mach-O fat magic 0xcafebabe
  const magic = buf.readUInt32BE(0);
  if (magic !== 0xcafebabe) {
    throw new Error(`Expected universal Mach-O magic 0xcafebabe, got 0x${magic.toString(16)} in ${dylibPath}`);
  }
  const nFatArch = buf.readUInt32BE(4);
  if (nFatArch < 2) {
    throw new Error(`Expected >= 2 fat arch slices in ${dylibPath}, got ${nFatArch}`);
  }
  const cpuTypes = [];
  for (let i = 0; i < nFatArch; i += 1) {
    cpuTypes.push(buf.readUInt32BE(8 + i * 20));
  }
  const hasX86_64 = cpuTypes.includes(0x01000007);
  const hasArm64 = cpuTypes.includes(0x0100000c);
  if (!hasX86_64 || !hasArm64) {
    throw new Error(
      `Expected universal arm64 (0x0100000c) + x86_64 (0x01000007) slices in ${dylibPath}, got ${cpuTypes.map((c) => `0x${c.toString(16)}`).join(', ')}`
    );
  }
  return {
    sizeBytes: buf.length,
    sha256: computeBufferSha256(buf),
    archs: ['arm64', 'x86_64'],
  };
}

function verifyCodesignAdhocWithoutRuntime(dylibPath) {
  execFileSync('codesign', ['--verify', '--verbose=2', dylibPath], {
    stdio: 'pipe',
  });

  const csInfo = spawnSync('codesign', ['-dvvv', dylibPath], {
    encoding: 'utf8',
  });
  if (csInfo.status !== 0) {
    throw new Error(
      `codesign -dvvv failed for ${dylibPath}: ${csInfo.stderr || csInfo.stdout || `exit ${csInfo.status}`}`
    );
  }
  const combined = `${csInfo.stdout || ''}\n${csInfo.stderr || ''}`;
  const flagsMatch = combined.match(/CodeDirectory[^\n]*flags=([^\n]+)/i);
  const flagsStr = flagsMatch ? flagsMatch[1].trim() : '';
  if (/\bruntime\b/i.test(flagsStr)) {
    throw new Error(
      `HI-9 / MH-01 violation: ad-hoc signed ${path.relative(ROOT_DIR, dylibPath)} must NOT carry hardened runtime flag (flags=${flagsStr})`
    );
  }
  return flagsStr;
}

function verifyOtoolLinkedDeps(dylibPath, forbiddenSubstrings) {
  const depsByArch = {};
  for (const arch of ['arm64', 'x86_64']) {
    const out = execFileSync('otool', ['-arch', arch, '-L', dylibPath], {
      encoding: 'utf8',
    });
    const deps = out
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);
    depsByArch[arch] = deps;
    for (const forbidden of forbiddenSubstrings) {
      const hit = deps.find((d) => d.includes(forbidden));
      if (hit) {
        throw new Error(
          `MH-02 violation: ${path.relative(ROOT_DIR, dylibPath)} (${arch}) must NOT statically link ${forbidden} (found: ${hit})`
        );
      }
    }
  }
  return depsByArch;
}

function buildUniversalDylib(srcPath, outDylib, extraArgs, forbiddenLinkDeps = []) {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Missing C source: ${srcPath}`);
  }

  console.log(
    `[build-macos-helpers] Compiling universal (arm64 + x86_64) ${path.relative(ROOT_DIR, outDylib)}...`
  );

  execFileSync(
    '/usr/bin/clang',
    [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-dynamiclib',
      '-O2',
      '-fno-objc-arc',
      '-arch',
      'arm64',
      '-arch',
      'x86_64',
      '-mmacosx-version-min=11.0',
      ...extraArgs,
      srcPath,
      '-o',
      outDylib,
    ],
    { stdio: 'inherit' }
  );

  fs.chmodSync(outDylib, 0o755);

  try {
    execFileSync('xattr', ['-cr', outDylib], { stdio: 'ignore' });
  } catch {
    // Ignore if xattr is unavailable
  }

  // MH-01: Ad-hoc sign WITHOUT `--options runtime` so AMFI/dyld4 never aborts on preload
  execFileSync('codesign', ['--force', '--sign', '-', outDylib], {
    stdio: 'inherit',
  });

  const archs = execFileSync('lipo', ['-archs', outDylib], {
    encoding: 'utf8',
  }).trim();
  if (!archs.includes('arm64') || !archs.includes('x86_64')) {
    throw new Error(`Expected universal arm64 + x86_64 slice, got: ${archs}`);
  }

  const csFlags = verifyCodesignAdhocWithoutRuntime(outDylib);
  const linkedDeps = verifyOtoolLinkedDeps(outDylib, forbiddenLinkDeps);
  const info = inspectUniversalMachOHeader(outDylib);

  console.log(
    `[build-macos-helpers] Built & ad-hoc signed (${archs}, ${csFlags}): ${path.relative(ROOT_DIR, outDylib)} (${info.sizeBytes} bytes)`
  );

  return {
    path: outDylib,
    ...info,
    codesignFlags: csFlags,
    linkedDeps,
  };
}

function buildManifestObject({ metalPreload, coopActivate }) {
  return {
    schemaVersion: 1,
    usage: 'build-and-ci-verification-only',
    note: 'Never verify this pre-signed manifest at runtime against packaged .app dylibs because build/afterPack.cjs re-signs bundled dylibs.',
    sources: computeSourceManifestDigests(),
    outputs: {
      'libone_metal_preload.dylib': {
        sha256: metalPreload.sha256,
        sizeBytes: metalPreload.sizeBytes,
        archs: metalPreload.archs,
        adhocWithoutHardenedRuntime: true,
        forbiddenStaticLinks: METAL_PRELOAD_FORBIDDEN_LINK_DEPS,
      },
      'libone_coop_activate.dylib': {
        sha256: coopActivate.sha256,
        sizeBytes: coopActivate.sizeBytes,
        archs: coopActivate.archs,
        adhocWithoutHardenedRuntime: true,
      },
    },
  };
}

function verifyMacosHelpers() {
  const metalInfo = inspectUniversalMachOHeader(OUT_DYLIB);
  const coopInfo = inspectUniversalMachOHeader(COOP_OUT_DYLIB);

  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Missing macOS helpers manifest: ${MANIFEST_PATH}`);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const currentSources = computeSourceManifestDigests();
  for (const [rel, sha] of Object.entries(currentSources)) {
    if (!manifest.sources || manifest.sources[rel] !== sha) {
      throw new Error(
        `Manifest source digest stale for ${rel}: manifest=${manifest.sources && manifest.sources[rel]} current=${sha}`
      );
    }
  }

  const expectedOutputs = {
    'libone_metal_preload.dylib': metalInfo,
    'libone_coop_activate.dylib': coopInfo,
  };
  for (const [name, actual] of Object.entries(expectedOutputs)) {
    const rec = manifest.outputs && manifest.outputs[name];
    if (!rec || rec.sha256 !== actual.sha256) {
      throw new Error(
        `Manifest output digest mismatch for ${name}: manifest=${rec && rec.sha256} actual=${actual.sha256}`
      );
    }
    if (rec.sizeBytes !== actual.sizeBytes) {
      throw new Error(
        `Manifest output size mismatch for ${name}: manifest=${rec.sizeBytes} actual=${actual.sizeBytes}`
      );
    }
  }

  let metalFlags = null;
  let coopFlags = null;
  let metalDeps = null;
  let coopDeps = null;
  if (process.platform === 'darwin') {
    for (const dylib of [OUT_DYLIB, COOP_OUT_DYLIB]) {
      const archs = execFileSync('lipo', ['-archs', dylib], { encoding: 'utf8' }).trim();
      if (!archs.includes('arm64') || !archs.includes('x86_64')) {
        throw new Error(`Expected universal arm64 + x86_64 in ${dylib}, got: ${archs}`);
      }
    }
    metalFlags = verifyCodesignAdhocWithoutRuntime(OUT_DYLIB);
    coopFlags = verifyCodesignAdhocWithoutRuntime(COOP_OUT_DYLIB);
    metalDeps = verifyOtoolLinkedDeps(OUT_DYLIB, METAL_PRELOAD_FORBIDDEN_LINK_DEPS);
    coopDeps = verifyOtoolLinkedDeps(COOP_OUT_DYLIB, []);
  }

  return {
    manifestPath: MANIFEST_PATH,
    metalPreload: {
      path: OUT_DYLIB,
      ...metalInfo,
      codesignFlags: metalFlags,
      linkedDeps: metalDeps,
    },
    coopActivate: {
      path: COOP_OUT_DYLIB,
      ...coopInfo,
      codesignFlags: coopFlags,
      linkedDeps: coopDeps,
    },
  };
}

function buildMacosHelpers() {
  if (process.platform !== 'darwin') {
    const verified = verifyMacosHelpers();
    console.log(
      `[build-macos-helpers] Non-darwin host (${process.platform}); verified prebuilt macOS helpers & manifest.`
    );
    return { prebuiltVerified: true, ...verified };
  }

  fs.mkdirSync(HELPERS_DIR, { recursive: true });

  // MH-02: Zero static -framework Metal or -framework CoreFoundation links on preload dylib!
  const metalPreload = buildUniversalDylib(
    SRC_PATH,
    OUT_DYLIB,
    ['-install_name', '@rpath/libone_metal_preload.dylib'],
    METAL_PRELOAD_FORBIDDEN_LINK_DEPS
  );

  const coopActivate = buildUniversalDylib(
    COOP_SRC_PATH,
    COOP_OUT_DYLIB,
    [
      '-Wl,-undefined,dynamic_lookup',
      '-framework',
      'AppKit',
      '-framework',
      'CoreGraphics',
      '-framework',
      'CoreFoundation',
      '-install_name',
      '@rpath/libone_coop_activate.dylib',
    ],
    []
  );

  const manifest = buildManifestObject({ metalPreload, coopActivate });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    manifestPath: MANIFEST_PATH,
    metalPreload,
    coopActivate,
  };
}

if (require.main === module) {
  const verifyOnly = process.argv.includes('--verify') || process.argv.includes('--verify-only');
  try {
    const res = verifyOnly ? verifyMacosHelpers() : buildMacosHelpers();
    if (verifyOnly) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: 'verify',
            manifestPath: path.relative(ROOT_DIR, res.manifestPath),
            metalPreload: {
              sizeBytes: res.metalPreload.sizeBytes,
              sha256: res.metalPreload.sha256,
              archs: res.metalPreload.archs,
              codesignFlags: res.metalPreload.codesignFlags,
              linkedDeps: res.metalPreload.linkedDeps,
            },
            coopActivate: {
              sizeBytes: res.coopActivate.sizeBytes,
              sha256: res.coopActivate.sha256,
              archs: res.coopActivate.archs,
              codesignFlags: res.coopActivate.codesignFlags,
            },
          },
          null,
          2
        )
      );
    }
  } catch (err) {
    console.error(`[build-macos-helpers] ${err.message || err}`);
    process.exit(1);
  }
}

module.exports = {
  OUT_DYLIB,
  COOP_OUT_DYLIB,
  MANIFEST_PATH,
  TRACKED_MANIFEST_SOURCES,
  METAL_PRELOAD_FORBIDDEN_LINK_DEPS,
  computeSourceManifestDigests,
  inspectUniversalMachOHeader,
  buildMacosHelpers,
  verifyMacosHelpers,
};
