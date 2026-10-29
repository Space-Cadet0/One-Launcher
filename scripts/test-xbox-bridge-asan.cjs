#!/usr/bin/env node
'use strict';

/**
 * Layer 1 Host Clang C11 `-fsanitize=address,undefined` Sanitizer Runner
 * (`scripts/test-xbox-bridge-asan.cjs`, D9D / Sec 12.2)
 *
 * Compiles and executes `tests/native/xgr_bridge_asan_test.c` together with the
 * production C11 translation units in `electron/helpers/xgr_bridge/` under strict
 * `-std=c11 -O1 -g -fshort-wchar -fsanitize=address,undefined -fno-omit-frame-pointer -Wall -Wextra -Werror`.
 *
 * - On macOS (`darwin`) and Linux, compilation and execution are mandatory.
 * - On Windows (`win32`), probes whether `clang` + POSIX/ASan runtime are available;
 *   skips cleanly with exit code 0 if Windows runners lack POSIX headers/ASan runtime.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_PATH = path.join(ROOT_DIR, 'tests', 'native', 'xgr_bridge_asan_test.c');
const WIN32_SHIM_INC = path.join(ROOT_DIR, 'tests', 'native', 'win32_shim');
const XGR_BRIDGE_DIR = path.join(ROOT_DIR, 'electron', 'helpers', 'xgr_bridge');

const PRODUCTION_TUS = [
  'main.c',
  'xthreading.c',
  'xuser.c',
  'xstore.c',
  'xpackage.c',
  'xsystem_misc.c',
].map((name) => path.join(XGR_BRIDGE_DIR, name));

function resolveClangExecutable() {
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/clang')) {
    return '/usr/bin/clang';
  }
  const probe = spawnSync('clang', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) {
    return 'clang';
  }
  return null;
}

function runNativeAsanHarness() {
  if (!fs.existsSync(SRC_PATH)) {
    console.error(`[test-xbox-bridge-asan] Missing C11 sanitizer harness: ${SRC_PATH}`);
    process.exit(1);
  }
  for (const tuPath of PRODUCTION_TUS) {
    if (!fs.existsSync(tuPath)) {
      console.error(`[test-xbox-bridge-asan] Missing production C11 translation unit: ${tuPath}`);
      process.exit(1);
    }
  }

  const clangBin = resolveClangExecutable();
  if (!clangBin) {
    if (process.platform === 'win32') {
      console.log('[test-xbox-bridge-asan] win32 host without clang in PATH; skipping host POSIX ASan harness.');
      return { skipped: true, reason: 'win32-no-clang' };
    }
    console.error(`[test-xbox-bridge-asan] clang compiler not found on ${process.platform}.`);
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-launcher-xgr-asan-'));
  const binExt = process.platform === 'win32' ? '.exe' : '';
  const binPath = path.join(tmpDir, `xgr_bridge_asan_test${binExt}`);

  try {
    const compileArgs = [
      '-std=c11',
      '-O1',
      '-g',
      '-fshort-wchar',
      '-fsanitize=address,undefined',
      '-fno-omit-frame-pointer',
      '-Wall',
      '-Wextra',
      '-Werror',
      `-I${WIN32_SHIM_INC}`,
      `-I${XGR_BRIDGE_DIR}`,
      SRC_PATH,
      ...PRODUCTION_TUS,
      '-lpthread',
      '-o',
      binPath,
    ];

    if (process.platform === 'win32') {
      const winCompile = spawnSync(clangBin, compileArgs, { encoding: 'utf8' });
      if (winCompile.status !== 0) {
        console.log(
          '[test-xbox-bridge-asan] win32 clang lacks POSIX pthread/ASan runtime; skipping host ASan harness cleanly.'
        );
        return { skipped: true, reason: 'win32-no-asan-runtime' };
      }
    } else {
      console.log(
        `[test-xbox-bridge-asan] Compiling ${path.relative(ROOT_DIR, SRC_PATH)} + ${PRODUCTION_TUS.length} xgr_bridge TUs with ${clangBin} (-fshort-wchar -fsanitize=address,undefined -Wall -Wextra -Werror)...`
      );
      execFileSync(clangBin, compileArgs, { stdio: 'inherit' });
    }

    const env = {
      ...process.env,
      ASAN_OPTIONS: 'abort_on_error=1:detect_stack_use_after_return=1:strict_string_checks=1',
      UBSAN_OPTIONS: 'print_stacktrace=1:halt_on_error=1',
    };

    const runRes = spawnSync(binPath, [], {
      env,
      encoding: 'utf8',
    });

    if (runRes.stdout) process.stdout.write(runRes.stdout);
    if (runRes.stderr) process.stderr.write(runRes.stderr);

    if (runRes.status !== 0) {
      console.error(
        `[test-xbox-bridge-asan] Sanitizer binary exited with status ${runRes.status} (signal: ${runRes.signal || 'none'})`
      );
      process.exit(runRes.status || 1);
    }

    return { skipped: false, stdout: runRes.stdout || '' };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of temp binary + dSYM
    }
  }
}

if (require.main === module) {
  runNativeAsanHarness();
}

module.exports = {
  runNativeAsanHarness,
  resolveClangExecutable,
};
