#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const HELPERS_DIR = path.join(ROOT_DIR, 'electron', 'helpers');
const SRC_PATH = path.join(HELPERS_DIR, 'one_metal_preload.c');
const OUT_DYLIB = path.join(HELPERS_DIR, 'libone_metal_preload.dylib');

function main() {
  if (process.platform !== 'darwin') {
    if (!fs.existsSync(OUT_DYLIB) || fs.statSync(OUT_DYLIB).size === 0) {
      console.error(
        `[build-macos-helpers] Missing prebuilt macOS helper dylib on non-darwin host: ${OUT_DYLIB}`
      );
      process.exit(1);
    }
    console.log(
      `[build-macos-helpers] Non-darwin host (${process.platform}); verified prebuilt ${path.relative(ROOT_DIR, OUT_DYLIB)}`
    );
    process.exit(0);
  }

  if (!fs.existsSync(SRC_PATH)) {
    console.error(`[build-macos-helpers] Missing C source: ${SRC_PATH}`);
    process.exit(1);
  }

  fs.mkdirSync(HELPERS_DIR, { recursive: true });

  console.log(
    `[build-macos-helpers] Compiling universal (arm64 + x86_64) ${path.relative(ROOT_DIR, OUT_DYLIB)}...`
  );

  execFileSync(
    '/usr/bin/clang',
    [
      '-dynamiclib',
      '-O2',
      '-fno-objc-arc',
      '-arch',
      'arm64',
      '-arch',
      'x86_64',
      '-mmacosx-version-min=11.0',
      '-framework',
      'Metal',
      '-framework',
      'CoreFoundation',
      '-install_name',
      '@rpath/libone_metal_preload.dylib',
      SRC_PATH,
      '-o',
      OUT_DYLIB,
    ],
    { stdio: 'inherit' }
  );

  fs.chmodSync(OUT_DYLIB, 0o755);

  try {
    execFileSync('xattr', ['-cr', OUT_DYLIB], { stdio: 'ignore' });
  } catch {
    // Ignore if xattr is unavailable
  }

  execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', OUT_DYLIB], {
    stdio: 'inherit',
  });

  const archs = execFileSync('lipo', ['-archs', OUT_DYLIB], {
    encoding: 'utf8',
  }).trim();
  if (!archs.includes('arm64') || !archs.includes('x86_64')) {
    console.error(
      `[build-macos-helpers] Expected universal arm64 + x86_64 slice, got: ${archs}`
    );
    process.exit(1);
  }

  execFileSync('codesign', ['--verify', '--verbose=2', OUT_DYLIB], {
    stdio: 'inherit',
  });

  console.log(
    `[build-macos-helpers] Built & signed universal helper (${archs}): ${path.relative(ROOT_DIR, OUT_DYLIB)}`
  );
}

main();
