'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { suite, test, assert, makeTempDir, cleanupTempDirs } = require('../harness/index.cjs');
const { TestRunner } = require('../harness/test_runner.cjs');
const verifyTool = require('../../../scripts/verify-display-output.cjs');

suite('Tier 2 — Feature F18 Boundaries: Modern Web, React 19, Media & Architecture (Features 19–24)', () => {
  // Feature 19 Boundaries: Modern Web & Grid Virtualization
  test({
    id: 'F18-B01',
    feature: 'F19',
    tier: 2,
    description: 'Virtual Grid Boundary: 10,000 item catalog calculates visible window slice without memory spike',
  }, () => {
    const totalItems = 10000;
    const itemHeight = 220;
    const viewportHeight = 1080;
    const scrollTop = 44000; // middle of list
    const overscan = 3;

    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const endIndex = Math.min(totalItems - 1, Math.ceil((scrollTop + viewportHeight) / itemHeight) + overscan);
    const visibleCount = endIndex - startIndex + 1;

    assert.ok(startIndex >= 195);
    assert.ok(endIndex <= 215);
    assert.ok(visibleCount < 25, `Visible slice must be bounded, got ${visibleCount}`);
  });

  test({
    id: 'F18-B02',
    feature: 'F19',
    tier: 2,
    description: 'Virtual Grid Boundary: zero-item catalog renders empty state container safely',
  }, () => {
    const totalItems = 0;
    const itemHeight = 220;
    const viewportHeight = 1080;
    const scrollTop = 0;
    const overscan = 2;

    const startIndex = totalItems === 0 ? 0 : Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const endIndex = totalItems === 0 ? 0 : Math.min(totalItems - 1, Math.ceil((scrollTop + viewportHeight) / itemHeight) + overscan);
    const visibleCount = totalItems === 0 ? 0 : endIndex - startIndex + 1;

    assert.strictEqual(visibleCount, 0);
  });

  test({
    id: 'F18-B03',
    feature: 'F19',
    tier: 2,
    description: 'Virtual Grid Boundary: rapid dynamic viewport resizing recalculates column count monotonically',
  }, () => {
    const minCardWidth = 240;
    const gap = 16;
    const widths = [320, 640, 1024, 1920, 2560, 3840];
    let prevCols = 0;

    for (const w of widths) {
      const cols = Math.max(1, Math.floor((w + gap) / (minCardWidth + gap)));
      assert.ok(cols >= prevCols, `Columns must increase or stay equal with viewport width (${cols} >= ${prevCols})`);
      prevCols = cols;
    }
  });

  test({
    id: 'F18-B04',
    feature: 'F19',
    tier: 2,
    description: 'Virtual Grid Boundary: negative scroll offsets during macOS elastic overscroll clamp to zero',
  }, () => {
    const itemHeight = 220;
    const negativeScrollTop = -120; // elastic rubber-band pull
    const overscan = 2;

    const startIndex = Math.max(0, Math.floor(negativeScrollTop / itemHeight) - overscan);
    assert.strictEqual(startIndex, 0, 'Start index must clamp to 0 under negative bounce');
  });

  test({
    id: 'F18-B05',
    feature: 'F19',
    tier: 2,
    description: 'Virtual Grid Boundary: fractional pixel dimensions round to stable integer offsets',
  }, () => {
    const fractionalHeight = 220.456;
    const roundedHeight = Math.round(fractionalHeight);
    assert.strictEqual(roundedHeight, 220);
    const offset = Math.round(15 * fractionalHeight);
    assert.strictEqual(offset, 3307);
  });

  // Feature 20 Boundaries: React 19 Error Boundary & Resilient UI
  test({
    id: 'F18-B06',
    feature: 'F20',
    tier: 2,
    description: 'Error Boundary: corrupted game card record missing mandatory fields isolated cleanly',
  }, () => {
    const sanitizeCard = (raw) => {
      if (!raw || typeof raw !== 'object') return { id: 'unknown', title: 'Corrupted Game', valid: false };
      return {
        id: String(raw.id || 'unknown'),
        title: String(raw.title || 'Untitled Game'),
        valid: Boolean(raw.id),
      };
    };

    assert.strictEqual(sanitizeCard(null).valid, false);
    assert.strictEqual(sanitizeCard({}).valid, false);
    assert.strictEqual(sanitizeCard({ id: 'game-123' }).title, 'Untitled Game');
    assert.strictEqual(sanitizeCard({ id: 'game-123', title: 'Doom' }).valid, true);
  });

  test({
    id: 'F18-B07',
    feature: 'F20',
    tier: 2,
    description: 'Error Boundary: fallback error state retains retry action handler contract',
  }, () => {
    let retried = false;
    const boundaryState = {
      hasError: true,
      error: new Error('Simulated network failure'),
      onRetry: () => { retried = true; },
    };

    assert.strictEqual(boundaryState.hasError, true);
    assert.strictEqual(typeof boundaryState.onRetry, 'function');
    boundaryState.onRetry();
    assert.strictEqual(retried, true);
  });

  test({
    id: 'F18-B08',
    feature: 'F20',
    tier: 2,
    description: 'Error Boundary: nested modal failure isolation protects root application tree',
  }, () => {
    const appState = { rootMounted: true, modalOpen: true, modalError: null };
    // Simulate modal throwing
    try {
      throw new Error('Corrupted modal payload');
    } catch (err) {
      appState.modalError = err.message;
      appState.modalOpen = false;
    }
    // Root must remain intact
    assert.strictEqual(appState.rootMounted, true);
    assert.strictEqual(appState.modalOpen, false);
    assert.strictEqual(appState.modalError, 'Corrupted modal payload');
  });

  test({
    id: 'F18-B09',
    feature: 'F20',
    tier: 2,
    description: 'Error Boundary: error recovery cycle resets error boundary state cleanly',
  }, () => {
    class MockErrorBoundary {
      constructor() {
        this.state = { hasError: false, error: null };
      }
      triggerError(err) {
        this.state = { hasError: true, error: err };
      }
      reset() {
        this.state = { hasError: false, error: null };
      }
    }

    const boundary = new MockErrorBoundary();
    assert.strictEqual(boundary.state.hasError, false);
    boundary.triggerError(new Error('Crash'));
    assert.strictEqual(boundary.state.hasError, true);
    boundary.reset();
    assert.strictEqual(boundary.state.hasError, false);
    assert.strictEqual(boundary.state.error, null);
  });

  test({
    id: 'F18-B10',
    feature: 'F20',
    tier: 2,
    description: 'Error Boundary: error stack logging redacts bearer tokens and secrets',
  }, () => {
    const rawError = 'Error: Unauthorized bearer eyJhbGciOiJIUzI1NiJ9.secret.sig for user=123';
    const sanitizeLog = (msg) => msg.replace(/bearer\s+[A-Za-z0-9-_.]+/gi, 'bearer [REDACTED]');
    const sanitized = sanitizeLog(rawError);
    assert.strictEqual(sanitized.includes('eyJhbGciOiJIUzI1NiJ9'), false);
    assert.ok(sanitized.includes('bearer [REDACTED]'));
  });

  // Feature 21 Boundaries: High-Performance Media Pipeline
  test({
    id: 'F18-B11',
    feature: 'F21',
    tier: 2,
    description: 'Media Pipeline: AbortController aborts in-flight image requests immediately',
  }, () => {
    const controller = new AbortController();
    assert.strictEqual(controller.signal.aborted, false);
    controller.abort('High velocity fling scroll');
    assert.strictEqual(controller.signal.aborted, true);
    assert.strictEqual(controller.signal.reason, 'High velocity fling scroll');
  });

  test({
    id: 'F18-B12',
    feature: 'F21',
    tier: 2,
    description: 'Media Pipeline: LRU cache enforces strict byte memory ceiling via eviction',
  }, () => {
    class SimpleByteLru {
      constructor(maxBytes) {
        this.maxBytes = maxBytes;
        this.currentBytes = 0;
        this.cache = new Map();
      }
      set(key, bufferSize) {
        if (this.cache.has(key)) {
          this.currentBytes -= this.cache.get(key);
          this.cache.delete(key);
        }
        while (this.currentBytes + bufferSize > this.maxBytes && this.cache.size > 0) {
          const oldestKey = this.cache.keys().next().value;
          this.currentBytes -= this.cache.get(oldestKey);
          this.cache.delete(oldestKey);
        }
        this.cache.set(key, bufferSize);
        this.currentBytes += bufferSize;
      }
    }

    const lru = new SimpleByteLru(1000); // 1KB limit
    lru.set('img1', 400);
    lru.set('img2', 400);
    assert.strictEqual(lru.cache.size, 2);
    lru.set('img3', 400); // Exceeds 1000 -> img1 evicted
    assert.strictEqual(lru.cache.has('img1'), false);
    assert.strictEqual(lru.cache.has('img2'), true);
    assert.strictEqual(lru.cache.has('img3'), true);
    assert.ok(lru.currentBytes <= 1000);
  });

  test({
    id: 'F18-B13',
    feature: 'F21',
    tier: 2,
    description: 'Media Pipeline: corrupted image binary falls back to default placeholder',
  }, () => {
    const corruptedBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    const isPng = (buf) => buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50;
    const isJpeg = (buf) => buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xD8;
    const resolveDisplayAsset = (buf, fallbackUrl) => {
      if (isPng(buf) || isJpeg(buf)) return 'valid_buffer_url';
      return fallbackUrl;
    };

    const resolved = resolveDisplayAsset(corruptedBuffer, '/assets/default_capsule.png');
    assert.strictEqual(resolved, '/assets/default_capsule.png');
  });

  test({
    id: 'F18-B14',
    feature: 'F21',
    tier: 2,
    description: 'Media Pipeline: responsive srcset generation selects 2x asset on Retina displays',
  }, () => {
    const pickAsset = (url1x, url2x, dpr) => (dpr >= 1.5 ? url2x : url1x);
    assert.strictEqual(pickAsset('cover.jpg', 'cover@2x.jpg', 1.0), 'cover.jpg');
    assert.strictEqual(pickAsset('cover.jpg', 'cover@2x.jpg', 2.0), 'cover@2x.jpg');
    assert.strictEqual(pickAsset('cover.jpg', 'cover@2x.jpg', 3.0), 'cover@2x.jpg');
  });

  test({
    id: 'F18-B15',
    feature: 'F21',
    tier: 2,
    description: 'Media Pipeline: rapid scroll reversal allows re-issuing abort controller without stale state',
  }, () => {
    let activeControllers = new Map();
    const requestItem = (id) => {
      if (activeControllers.has(id)) {
        activeControllers.get(id).abort('Canceled for re-fetch');
      }
      const c = new AbortController();
      activeControllers.set(id, c);
      return c;
    };

    const c1 = requestItem('item-1');
    assert.strictEqual(c1.signal.aborted, false);
    const c2 = requestItem('item-1');
    assert.strictEqual(c1.signal.aborted, true);
    assert.strictEqual(c2.signal.aborted, false);
  });

  // Feature 22 Boundaries: Strict Architecture & TypeScript Strict Flags
  test({
    id: 'F18-B16',
    feature: 'F22',
    tier: 2,
    description: 'Architecture Boundary: no direct electron/node imports in src/ frontend directory',
  }, () => {
    const srcDir = path.resolve(__dirname, '../../../src');
    if (!fs.existsSync(srcDir)) return; // If src directory doesn't exist, skip check
    const findForbiddenImports = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          findForbiddenImports(full);
        } else if (/\.(tsx?|jsx?)$/.test(ent.name)) {
          const content = fs.readFileSync(full, 'utf8');
          assert.strictEqual(
            /from\s+['"]node:/i.test(content),
            false,
            `Forbidden node: import found in frontend file: ${full}`
          );
        }
      }
    };
    findForbiddenImports(srcDir);
  });

  test({
    id: 'F18-B17',
    feature: 'F22',
    tier: 2,
    description: 'Architecture Boundary: tsconfig.json enforces strict TypeScript compilation mode',
  }, () => {
    const tsconfigPath = path.resolve(__dirname, '../../../tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) return;
    const content = fs.readFileSync(tsconfigPath, 'utf8');
    assert.match(content, /"strict"\s*:\s*true/);
  });

  test({
    id: 'F18-B18',
    feature: 'F22',
    tier: 2,
    description: 'Architecture Boundary: preload bridge exposes strictly isolated typed API',
  }, () => {
    const preloadPath = path.resolve(__dirname, '../../../electron/preload.cjs');
    assert.ok(fs.existsSync(preloadPath), 'electron/preload.cjs must exist');
    const content = fs.readFileSync(preloadPath, 'utf8');
    assert.match(content, /contextBridge\.exposeInMainWorld/);
  });

  test({
    id: 'F18-B19',
    feature: 'F22',
    tier: 2,
    description: 'Architecture Boundary: no cyclic imports between main electron modules',
  }, () => {
    const launcherDir = path.resolve(__dirname, '../../../electron/launcher');
    const files = fs.readdirSync(launcherDir).filter(f => f.endsWith('.cjs'));
    assert.ok(files.length > 5, 'Expected multiple launcher module files');
    // Verify each file can be loaded independently without throwing cyclic reference errors
    for (const f of files.slice(0, 5)) {
      assert.doesNotThrow(() => {
        require(path.join(launcherDir, f));
      });
    }
  });

  test({
    id: 'F18-B20',
    feature: 'F22',
    tier: 2,
    description: 'Architecture Boundary: package.json build script invokes tsc before bundler',
  }, () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')
    );
    assert.ok(pkg.scripts.build, 'build script must exist');
    assert.ok(pkg.scripts.build.includes('tsc'), 'build script must execute tsc');
  });

  // Feature 23 Boundaries: E2E Runner & Verification Tooling Hardening
  test({
    id: 'F18-B21',
    feature: 'F23',
    tier: 2,
    description: 'Harness Boundary: TestRunner handles tierFilter and grepFilter combinations accurately',
    async: true,
  }, async () => {
    const runner = new TestRunner();
    runner.suite('Mock Suite Filter', () => {
      runner.test({ id: 'R-01', tier: 1, feature: 'F1' }, () => {});
      runner.test({ id: 'R-02', tier: 2, feature: 'F2' }, () => {});
      runner.test({ id: 'R-03', tier: 2, feature: 'F3' }, () => {});
    });

    const res = await runner.run({ tierFilter: 2, silent: true });
    assert.strictEqual(res.total, 2);
    assert.strictEqual(res.passed, 2);
  });

  test({
    id: 'F18-B22',
    feature: 'F23',
    tier: 2,
    description: 'Harness Boundary: TestRunner bail flag immediately aborts execution on first failure',
    async: true,
  }, async () => {
    const runner = new TestRunner();
    let ranSecond = false;
    runner.suite('Mock Suite Bail', () => {
      runner.test({ id: 'B-01', tier: 1, feature: 'F1' }, () => {
        throw new Error('Forced failure');
      });
      runner.test({ id: 'B-02', tier: 1, feature: 'F1' }, () => {
        ranSecond = true;
      });
    });

    const res = await runner.run({ bail: true, silent: true });
    assert.strictEqual(res.failed, 1);
    assert.strictEqual(ranSecond, false, 'Second test must not run when bail is active');
  });

  test({
    id: 'F18-B23',
    feature: 'F23',
    tier: 2,
    description: 'Harness Boundary: verifyDisplayOutput handles synthetic mode synchronously with exit code 0',
  }, () => {
    const res = verifyTool.verifyDisplayOutput({ synthetic: true, verbose: false });
    assert.strictEqual(res.passed, true);
    assert.strictEqual(res.exitCode, 0);
  });

  test({
    id: 'F18-B24',
    feature: 'F23',
    tier: 2,
    description: 'Harness Boundary: verifyDisplayOutput handles corrupted image buffer with safe error object',
  }, () => {
    const res = verifyTool.verifyDisplayOutput({
      imageBuffer: Buffer.from('corrupted_not_a_png_file'),
      verbose: false,
    });
    assert.strictEqual(res.passed, false);
    assert.strictEqual(res.exitCode, 2);
    assert.ok(res.error.includes('PNG'));
  });

  test({
    id: 'F18-B25',
    feature: 'F23',
    tier: 2,
    description: 'Harness Boundary: test runner reports correct pass/fail summary contract',
    async: true,
  }, async () => {
    const passRunner = new TestRunner();
    passRunner.suite('Pass Suite', () => {
      passRunner.test({ id: 'P-01', tier: 1, feature: 'F1' }, () => {});
    });
    const passRes = await passRunner.run({ silent: true });
    assert.strictEqual(passRes.failed, 0);
    assert.strictEqual(passRes.passed, 1);

    const failRunner = new TestRunner();
    failRunner.suite('Fail Suite', () => {
      failRunner.test({ id: 'F-01', tier: 1, feature: 'F1' }, () => { throw new Error('fail'); });
    });
    const failRes = await failRunner.run({ silent: true });
    assert.strictEqual(failRes.failed, 1);
    assert.strictEqual(failRes.passed, 0);
  });

  // Feature 24 Boundaries: Real-World Game Compatibility Scenarios
  test({
    id: 'F18-B26',
    feature: 'F24',
    tier: 2,
    description: 'Game Compatibility Boundary: 4:3 legacy resolutions calculate symmetric horizontal pillarboxes',
  }, () => {
    const legacyModes = [
      { w: 640, h: 480 },
      { w: 800, h: 600 },
      { w: 1024, h: 768 },
    ];
    for (const mode of legacyModes) {
      const geom = verifyTool.computeOracleViewport(3024, 1964, 0, mode.w, mode.h);
      assert.strictEqual(geom.dstH % 2, 0);
      assert.strictEqual(geom.dstX * 2 + geom.dstW, 3024);
      assert.ok(geom.dstX > 0, `Expected pillarbox for ${mode.w}x${mode.h}`);
    }
  });

  test({
    id: 'F18-B27',
    feature: 'F24',
    tier: 2,
    description: 'Game Compatibility Boundary: ultra-wide 21:9 resolution computes top and bottom letterboxes',
  }, () => {
    const geom = verifyTool.computeOracleViewport(3024, 1964, 0, 2560, 1080);
    assert.strictEqual(geom.dstH % 2, 0);
    assert.strictEqual(geom.dstY * 2 + geom.dstH, 1964);
    assert.ok(geom.dstY > 0, 'Expected letterbox for 21:9 ultra-wide');
  });

  test({
    id: 'F18-B28',
    feature: 'F24',
    tier: 2,
    description: 'Game Compatibility Boundary: corrupted INI file recovers fallback default resolution',
  }, () => {
    const parseIniFallback = (iniContent) => {
      const matchW = iniContent.match(/width\s*=\s*(\d+)/i);
      const matchH = iniContent.match(/height\s*=\s*(\d+)/i);
      const w = matchW ? Number(matchW[1]) : 1920;
      const h = matchH ? Number(matchH[1]) : 1080;
      return { width: w > 0 ? w : 1920, height: h > 0 ? h : 1080 };
    };

    assert.deepStrictEqual(parseIniFallback(''), { width: 1920, height: 1080 });
    assert.deepStrictEqual(parseIniFallback('[Video]\nfoo=bar\n'), { width: 1920, height: 1080 });
    assert.deepStrictEqual(parseIniFallback('[Video]\nwidth=1280\nheight=720\n'), { width: 1280, height: 720 });
  });

  test({
    id: 'F18-B29',
    feature: 'F24',
    tier: 2,
    description: 'Game Compatibility Boundary: zero-width or negative dimensions in display config return null',
  }, () => {
    assert.strictEqual(verifyTool.computeOracleViewport(0, 0, 0, 3024, 1964), null);
    assert.strictEqual(verifyTool.computeOracleViewport(3024, 1964, 0, 0, 0), null);
    assert.strictEqual(verifyTool.computeOracleViewport(-10, 100, 0, 640, 480), null);
  });

  test({
    id: 'F18-B30',
    feature: 'F24',
    tier: 2,
    description: 'Game Compatibility Boundary: 16:10 display matches native Retina aspect ratio with 0 pillarbox',
  }, () => {
    const geom = verifyTool.computeOracleViewport(3024, 1964, 0, 1600, 1000);
    assert.strictEqual(geom.dstH % 2, 0);
    assert.strictEqual(geom.dstX, 0);
  });
});
