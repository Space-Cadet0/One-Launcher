'use strict';

const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');
const SCALER_DIR = path.join(ROOT_DIR, 'electron', 'helpers', 'display_scaler');
const MATH_SRC = path.join(SCALER_DIR, 'display_scaler_math.c');

let cachedProbeBinary = null;
let cachedProbeTmpDir = null;

process.on('exit', () => {
  if (cachedProbeTmpDir) {
    try {
      fs.rmSync(cachedProbeTmpDir, { recursive: true, force: true });
    } catch {}
    cachedProbeTmpDir = null;
  }
});

function compileProbeBinary(probeCPath, binPath) {
  const commonArgs = [
    '-std=c11',
    '-O1',
    `-I${SCALER_DIR}`,
    MATH_SRC,
    probeCPath,
    '-o',
    binPath,
  ];
  const compilers = [
    ['zig', ['cc', ...commonArgs]],
    ['clang', commonArgs],
    ['gcc', commonArgs],
    ['cc', commonArgs],
  ];
  const homeCacheZig = path.join(
    os.homedir(),
    '.cache',
    'onelauncher-zig',
    process.platform === 'win32' ? 'zig.exe' : 'zig'
  );
  if (fs.existsSync(homeCacheZig)) {
    compilers.unshift([homeCacheZig, ['cc', ...commonArgs]]);
  }
  const zigCacheRoot = path.join(ROOT_DIR, '.cache', 'zig');
  if (fs.existsSync(zigCacheRoot)) {
    try {
      for (const entry of fs.readdirSync(zigCacheRoot)) {
        const zigBin = path.join(
          zigCacheRoot,
          entry,
          process.platform === 'win32' ? 'zig.exe' : 'zig'
        );
        if (fs.existsSync(zigBin)) {
          compilers.push([zigBin, ['cc', ...commonArgs]]);
        }
      }
    } catch {}
  }

  let lastErr = null;
  for (const [cmd, args] of compilers) {
    try {
      execFileSync(cmd, args, { cwd: ROOT_DIR, stdio: 'pipe' });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Failed to compile native display_scaler probe');
}

function ensureNativeProbe() {
  if (cachedProbeBinary && fs.existsSync(cachedProbeBinary)) {
    return cachedProbeBinary;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ds-probe-'));
  cachedProbeTmpDir = tmpDir;
  const binPath = path.join(
    tmpDir,
    process.platform === 'win32' ? 'ds_probe.exe' : 'ds_probe'
  );

  const probeCSource = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "display_scaler.h"

int main(int argc, char **argv) {
    if (argc < 2) return 1;

    if (strcmp(argv[1], "mode_table") == 0 && argc >= 5) {
        int32_t w = atoi(argv[2]);
        int32_t h = atoi(argv[3]);
        int32_t hz = atoi(argv[4]);
        ds_display_mode_t modes[128];
        memset(modes, 0, sizeof(modes));
        size_t n = ds_build_mode_table(w, h, hz, modes, 128);
        printf("[");
        for (size_t i = 0; i < n; i++) {
            printf("{\\"width\\":%d,\\"height\\":%d,\\"bpp\\":%d,\\"refreshHz\\":%d}%s",
                modes[i].width, modes[i].height, modes[i].bpp, modes[i].refresh_hz,
                (i + 1 < n) ? "," : "");
        }
        printf("]\\n");
        return 0;
    }

    if (strcmp(argv[1], "viewport") == 0 && argc >= 8) {
        int32_t sw = atoi(argv[2]);
        int32_t sh = atoi(argv[3]);
        int32_t safe = atoi(argv[4]);
        int32_t vw = atoi(argv[5]);
        int32_t vh = atoi(argv[6]);
        const char *asp_str = argv[7];
        ds_aspect_mode_t asp = DS_ASPECT_PRESERVE;
        if (strcmp(asp_str, "integer") == 0) asp = DS_ASPECT_INTEGER;
        else if (strcmp(asp_str, "stretch") == 0) asp = DS_ASPECT_STRETCH;

        ds_viewport_t vp;
        memset(&vp, 0, sizeof(vp));
        bool ok = ds_compute_viewport(sw, sh, safe, vw, vh, asp, &vp);
        if (!ok) {
            printf("null\\n");
            return 0;
        }
        printf("{\\"ok\\":true,\\"usableX\\":%d,\\"usableY\\":%d,\\"usableW\\":%d,\\"usableH\\":%d,"
               "\\"dstX\\":%d,\\"dstY\\":%d,\\"dstW\\":%d,\\"dstH\\":%d,\\"integerScale\\":%d}\\n",
               vp.usable_x, vp.usable_y, vp.usable_w, vp.usable_h,
               vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, vp.integer_scale);
        return 0;
    }

    if (strcmp(argv[1], "warp_drift") == 0 && argc >= 7) {
        int32_t iters = atoi(argv[2]);
        int32_t sw = atoi(argv[3]);
        int32_t sh = atoi(argv[4]);
        int32_t safe = atoi(argv[5]);
        int32_t vw = atoi(argv[6]);
        int32_t vh = atoi(argv[7]);

        ds_viewport_t vp;
        if (!ds_compute_viewport(sw, sh, safe, vw, vh, DS_ASPECT_PRESERVE, &vp)) return 1;

        ds_cursor_warp_state_t warp;
        ds_cursor_warp_reset(&warp);

        int32_t center_vx = vw / 2;
        int32_t center_vy = vh / 2;
        int32_t drift_x = 0;
        int32_t drift_y = 0;

        for (int i = 0; i < iters; i++) {
            int32_t px = 0, py = 0;
            ds_cursor_record_warp(&warp, center_vx, center_vy,
                                  vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h,
                                  vw, vh, &px, &py);
            int32_t out_vx = 0, out_vy = 0;
            ds_cursor_resolve_get_pos(&warp, px, py,
                                      vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h,
                                      vw, vh, &out_vx, &out_vy);
            drift_x += (out_vx - center_vx);
            drift_y += (out_vy - center_vy);
        }

        printf("{\\"iterations\\":%d,\\"driftX\\":%d,\\"driftY\\":%d}\\n", iters, drift_x, drift_y);
        return 0;
    }

    return 2;
}
`;

  const probeCPath = path.join(tmpDir, 'ds_probe.c');
  fs.writeFileSync(probeCPath, probeCSource, 'utf8');

  compileProbeBinary(probeCPath, binPath);

  cachedProbeBinary = binPath;
  return binPath;
}

function invokeNativeModeTable(nativeW, nativeH, nativeHz = 120) {
  const bin = ensureNativeProbe();
  const res = spawnSync(bin, ['mode_table', String(nativeW), String(nativeH), String(nativeHz)], {
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`Native mode_table probe failed: ${res.stderr || res.stdout}`);
  }
  return JSON.parse(res.stdout.trim());
}

function invokeNativeViewport(screenW, screenH, safeInsetTop, virtW, virtH, aspectMode = 'preserve') {
  const bin = ensureNativeProbe();
  const res = spawnSync(bin, [
    'viewport',
    String(screenW),
    String(screenH),
    String(safeInsetTop),
    String(virtW),
    String(virtH),
    aspectMode,
  ], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`Native viewport probe failed: ${res.stderr || res.stdout}`);
  }
  const raw = res.stdout.trim();
  return raw === 'null' ? null : JSON.parse(raw);
}

function invokeNativeWarpDrift(iterations, screenW, screenH, safeInsetTop, virtW, virtH) {
  const bin = ensureNativeProbe();
  const res = spawnSync(bin, [
    'warp_drift',
    String(iterations),
    String(screenW),
    String(screenH),
    String(safeInsetTop),
    String(virtW),
    String(virtH),
  ], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`Native warp_drift probe failed: ${res.stderr || res.stdout}`);
  }
  return JSON.parse(res.stdout.trim());
}

/**
 * Authoritative mathematical reference for viewport calculation.
 */
function oracleComputeViewport(screenW, screenH, safeInsetTop, virtW, virtH, aspectMode) {
  if (screenW <= 0 || screenH <= 0 || virtW <= 0 || virtH <= 0) {
    return null;
  }

  const safeTop = Math.max(0, Math.min(Math.floor(safeInsetTop), Math.floor(screenH / 4) - 1));
  const usableX = 0;
  const usableY = safeTop;
  const usableW = screenW;
  const usableH = screenH - safeTop;

  let dstW = 0;
  let dstH = 0;
  let integerScale = 0;

  if (aspectMode === 'stretch') {
    dstW = usableW;
    dstH = usableH;
  } else if (aspectMode === 'integer') {
    const scaleX = Math.floor(usableW / virtW);
    const scaleY = Math.floor(usableH / virtH);
    const k = Math.min(scaleX, scaleY);
    if (k >= 1) {
      integerScale = k;
      dstW = virtW * k;
      dstH = virtH * k;
    } else {
      integerScale = 0;
      const lhs = usableW * virtH;
      const rhs = usableH * virtW;
      if (lhs > rhs) {
        dstH = usableH;
        const fitByH = Math.floor((rhs + Math.floor(virtH / 2)) / virtH);
        dstW = Math.min(usableW, (rhs % virtH === 0) ? Math.floor(rhs / virtH) : ((fitByH + 1) & ~1));
      } else if (lhs < rhs) {
        dstW = usableW;
        let fitH = Math.min(usableH, Math.floor((lhs + Math.floor(virtW / 2)) / virtW));
        if (fitH >= 2) fitH &= ~1;
        dstH = Math.max(1, fitH);
      } else {
        dstW = usableW;
        dstH = usableH;
      }
    }
  } else {
    const lhs = usableW * virtH;
    const rhs = usableH * virtW;
    if (lhs > rhs) {
      dstH = usableH;
      const fitByH = Math.floor((rhs + Math.floor(virtH / 2)) / virtH);
      dstW = Math.min(usableW, (rhs % virtH === 0) ? Math.floor(rhs / virtH) : ((fitByH + 1) & ~1));
    } else if (lhs < rhs) {
      dstW = usableW;
      let fitH = Math.min(usableH, Math.floor((lhs + Math.floor(virtW / 2)) / virtW));
      if (fitH >= 2) fitH &= ~1;
      dstH = Math.max(1, fitH);
    } else {
      dstW = usableW;
      dstH = usableH;
    }
  }

  const dstX = usableX + Math.floor((usableW - dstW) / 2);
  const dstY = usableY + Math.floor((usableH - dstH) / 2);

  return {
    usableX,
    usableY,
    usableW,
    usableH,
    dstX,
    dstY,
    dstW,
    dstH,
    integerScale,
  };
}

/**
 * Runs the native C11 AddressSanitizer math suite.
 */
function runNativeMathAsan() {
  const runnerScript = path.join(ROOT_DIR, 'scripts', 'test-display-scaler-asan.cjs');
  const res = spawnSync(process.execPath, [runnerScript], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

module.exports = {
  ensureNativeProbe,
  invokeNativeModeTable,
  invokeNativeViewport,
  invokeNativeWarpDrift,
  oracleComputeViewport,
  runNativeMathAsan,
};
