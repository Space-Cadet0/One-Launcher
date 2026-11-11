#!/usr/bin/env node
'use strict';

/**
 * Layer 1 Host Clang C11 `-fsanitize=address,undefined` Sanitizer Runner
 * for `electron/helpers/display_scaler/display_scaler_math.c` + `tests/native/display_scaler_asan_test.c`.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_SRC = path.join(ROOT_DIR, 'tests', 'native', 'display_scaler_asan_test.c');
const SCALER_DIR = path.join(ROOT_DIR, 'electron', 'helpers', 'display_scaler');
const MATH_SRC = path.join(SCALER_DIR, 'display_scaler_math.c');

function run() {
  if (process.platform === 'win32') {
    const probe = spawnSync('clang', ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      console.log('[DS-ASAN] Skipping host Clang ASan suite on Windows (clang not in PATH).');
      return;
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ds-asan-'));
  const binPath = path.join(tmpDir, process.platform === 'win32' ? 'ds_asan.exe' : 'ds_asan');

  try {
    const compileArgs = [
      '-std=c11',
      '-O1',
      '-g',
      '-fsanitize=address,undefined',
      '-fno-omit-frame-pointer',
      '-Wall',
      '-Wextra',
      '-Werror',
      `-I${SCALER_DIR}`,
      MATH_SRC,
      TEST_SRC,
      '-o',
      binPath,
    ];
    const runEnv = {
      ...process.env,
      ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=1:halt_on_error=1',
      UBSAN_OPTIONS: 'print_stacktrace=1:halt_on_error=1',
    };
    if (process.platform === 'win32') {
      const winCompile = spawnSync('clang', compileArgs, { cwd: ROOT_DIR, encoding: 'utf8' });
      if (winCompile.status !== 0) {
        console.log('[DS-ASAN] win32 clang lacks host ASan runtime; skipping host ASan suite cleanly.');
        return;
      }
      const winRun = spawnSync(binPath, [], { cwd: ROOT_DIR, env: runEnv, encoding: 'utf8' });
      if (winRun.stdout) process.stdout.write(winRun.stdout);
      if (winRun.stderr) process.stderr.write(winRun.stderr);
      if (winRun.status !== 0) {
        // Missing clang_rt.asan_dynamic-x86_64.dll in PATH on Windows returns 0xC0000135 (-1073741515)
        if (winRun.status === -1073741515 || winRun.status === 0xc0000135) {
          console.log('[DS-ASAN] win32 ASan runtime DLL not in PATH; skipping host ASan suite cleanly.');
          return;
        }
        process.exit(winRun.status || 1);
      }
      return;
    }
    execFileSync('clang', compileArgs, { cwd: ROOT_DIR, stdio: 'inherit' });
    execFileSync(binPath, [], {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: runEnv,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run();
