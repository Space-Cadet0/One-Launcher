#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const HELPERS_DIR = path.join(ROOT_DIR, 'electron', 'helpers');
const SRC_PATH = path.join(HELPERS_DIR, 'one_metal_preload.c');
const OUT_DYLIB = path.join(HELPERS_DIR, 'libone_metal_preload.dylib');
const COOP_SRC_PATH = path.join(HELPERS_DIR, 'one_coop_activate.c');
const COOP_OUT_DYLIB = path.join(HELPERS_DIR, 'libone_coop_activate.dylib');

function buildUniversalDylib(srcPath, outDylib, extraArgs) {
  if (!fs.existsSync(srcPath)) {
    console.error(`[build-macos-helpers] Missing C source: ${srcPath}`);
    process.exit(1);
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

  execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', outDylib], {
    stdio: 'inherit',
  });

  const archs = execFileSync('lipo', ['-archs', outDylib], {
    encoding: 'utf8',
  }).trim();
  if (!archs.includes('arm64') || !archs.includes('x86_64')) {
    console.error(
      `[build-macos-helpers] Expected universal arm64 + x86_64 slice, got: ${archs}`
    );
    process.exit(1);
  }

  execFileSync('codesign', ['--verify', '--verbose=2', outDylib], {
    stdio: 'inherit',
  });

  console.log(
    `[build-macos-helpers] Built & signed universal helper (${archs}): ${path.relative(ROOT_DIR, outDylib)}`
  );
}

function main() {
  if (process.platform !== 'darwin') {
    for (const dylib of [OUT_DYLIB, COOP_OUT_DYLIB]) {
      if (!fs.existsSync(dylib) || fs.statSync(dylib).size === 0) {
        console.error(
          `[build-macos-helpers] Missing prebuilt macOS helper dylib on non-darwin host: ${dylib}`
        );
        process.exit(1);
      }
      console.log(
        `[build-macos-helpers] Non-darwin host (${process.platform}); verified prebuilt ${path.relative(ROOT_DIR, dylib)}`
      );
    }
    process.exit(0);
  }

  fs.mkdirSync(HELPERS_DIR, { recursive: true });

  buildUniversalDylib(SRC_PATH, OUT_DYLIB, [
    '-framework',
    'Metal',
    '-framework',
    'CoreFoundation',
    '-install_name',
    '@rpath/libone_metal_preload.dylib',
  ]);

  buildUniversalDylib(COOP_SRC_PATH, COOP_OUT_DYLIB, [
    '-Wl,-undefined,dynamic_lookup',
    '-framework',
    'AppKit',
    '-framework',
    'CoreGraphics',
    '-framework',
    'CoreFoundation',
    '-install_name',
    '@rpath/libone_coop_activate.dylib',
  ]);
}

main();
