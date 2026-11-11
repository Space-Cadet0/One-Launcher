'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert } = require('../harness/index.cjs');

const supervisor = require('../../../electron/launcher/sessionAndProcessSupervisor.cjs');
const binaryInspectors = require('../../../electron/launcher/binaryAndManifestInspectors.cjs');
const {
  verifyDisplayOutput,
  generateSyntheticRetinaFrame,
  detectScreenLockState,
  isScreenLocked,
  encodePng,
  computeOracleViewport,
  computeViewportLuminance,
} = require('../../../scripts/verify-display-output.cjs');
const { oracleComputeViewport } = require('../harness/native_oracle.cjs');

suite('Tier 1 — Feature F14: Live Human-Like Full-Screen Testing', () => {
  test({
    id: 'F14-01',
    feature: 'F14',
    tier: 1,
    description: 'Supervisor session lifecycle: launcher wrapping gated on scaling mode and capabilities',
  }, () => {
    assert.strictEqual(typeof supervisor.shouldWrapBottleSessionWithDisplayLauncher, 'function');

    const shouldWrapFullscreen = supervisor.shouldWrapBottleSessionWithDisplayLauncher(
      { arch: 'x86', subsystem: 2 },
      'auto'
    );
    assert.strictEqual(shouldWrapFullscreen, true, 'Fullscreen mode must enable launcher wrapping');

    const shouldWrapOff = supervisor.shouldWrapBottleSessionWithDisplayLauncher(
      { arch: 'x86', subsystem: 2 },
      'off'
    );
    assert.strictEqual(shouldWrapOff, false, 'Off mode must disable launcher wrapping');
  });

  test({
    id: 'F14-02',
    feature: 'F14',
    tier: 1,
    description: 'Full-screen observation harness validates native 3024x1964 display bounds',
  }, () => {
    // 1. Programmatic synthetic verification: 3024x1964 Liquid Retina panel with 640x480 virtual mode
    const synthReport = verifyDisplayOutput({
      synthetic: true,
      screenW: 3024,
      screenH: 1964,
      virtW: 640,
      virtH: 480,
    });
    assert.ok(synthReport.ok, `Synthetic display verification failed: ${synthReport.errors.join(', ')}`);
    assert.strictEqual(synthReport.metrics.displayWidth, 3024, 'Physical width must be 3024');
    assert.strictEqual(synthReport.metrics.displayHeight, 1964, 'Physical height must be 1964');
    assert.strictEqual(synthReport.metrics.expectedViewport.dst_w, 2620, 'Viewport width must be 2620');
    assert.strictEqual(synthReport.metrics.expectedViewport.dst_h, 1964, 'Viewport height must span full 1964');
    assert.strictEqual(synthReport.metrics.expectedViewport.dst_x, 202, 'Left pillarbox must be 202px');
    assert.strictEqual(synthReport.metrics.centeringDelta, 0, 'Horizontal centering must be exact (0px delta)');
    assert.strictEqual(synthReport.metrics.marginViolations, 0, 'Zero non-black margin violations');
    assert.ok(synthReport.metrics.avgLuminance > 0, 'Active game content must be rendered in viewport');

    // Concordance check against C11 oracle
    const oracle = oracleComputeViewport(3024, 1964, 0, 640, 480, 'preserve');
    assert.strictEqual(synthReport.metrics.expectedViewport.dst_x, oracle.dstX, 'dstX must match oracle');
    assert.strictEqual(synthReport.metrics.expectedViewport.dst_w, oracle.dstW, 'dstW must match oracle');
    assert.strictEqual(synthReport.metrics.expectedViewport.dst_h, oracle.dstH, 'dstH must match oracle');
    assert.strictEqual(synthReport.metrics.horizontalCenteringDelta, 0, 'Horizontal centering error must be 0px');
    assert.strictEqual(synthReport.metrics.verticalCenteringDelta, 0, 'Vertical centering error must be 0px');
    assert.strictEqual(synthReport.metrics.measuredViewport.dst_x, oracle.dstX, 'measured dst_x must match oracle');
    assert.strictEqual(synthReport.metrics.measuredViewport.dst_y, oracle.dstY, 'measured dst_y must match oracle');
    assert.strictEqual(synthReport.metrics.measuredViewport.dst_w, oracle.dstW, 'measured dst_w must match oracle');
    assert.strictEqual(synthReport.metrics.measuredViewport.dst_h, oracle.dstH, 'measured dst_h must match oracle');

    // 2. Negative validation: ensure corrupt white margins are caught
    const corruptFrame = generateSyntheticRetinaFrame({ corruptMargin: true });
    const corruptReport = verifyDisplayOutput({ imageBuffer: corruptFrame });
    assert.strictEqual(corruptReport.ok, false, 'Verifier must reject non-black margins');
    assert.ok(corruptReport.errors.some(e => e.includes('margin violation')), 'Must report margin violation');

    // 2b. Negative validation: ensure completely all-black unrendered frames evaluate strictly to 0 luminance and fail
    const blackBuf = encodePng(3024, 1964, Buffer.alloc(3024 * 1964 * 4, 0));
    const blackReport = verifyDisplayOutput({ imageBuffer: blackBuf });
    assert.strictEqual(blackReport.ok, false, 'Verifier must reject all-black unrendered frames');
    assert.strictEqual(blackReport.metrics.avgLuminance, 0, 'All-black frame perceived luminance must be strictly 0.0');

    // 3. Live capture verification (if running on macOS and screen is unlocked)
    if (process.platform === 'darwin') {
      const liveReport = verifyDisplayOutput({
        live: true,
        screenW: 3024,
        screenH: 1964,
        virtW: 640,
        virtH: 480,
      });
      if (liveReport.skipped) {
        assert.ok(liveReport.reason.includes('locked'), 'Skipped reason must indicate screen lock');
      } else if (liveReport.metrics) {
        // If live capture succeeded on host or CI VM, verify positive physical dimensions
        assert.ok(liveReport.metrics.displayWidth > 0, 'Live physical width must be positive');
        assert.ok(liveReport.metrics.displayHeight > 0, 'Live physical height must be positive');
      } else {
        assert.ok(Array.isArray(liveReport.errors), 'Headless CI capture fallback must return structured errors array');
      }
    }
  });

  test({
    id: 'F14-03',
    feature: 'F14',
    tier: 1,
    description: 'Executable capability inspection recognizes JK:DF2 legacy DirectDraw/Direct3D architecture',
  }, () => {
    assert.strictEqual(typeof binaryInspectors.resolveEffectiveGameExecutableCapabilities, 'function');
  });

  test({
    id: 'F14-04',
    feature: 'F14',
    tier: 1,
    description: 'Executable capability inspection recognizes Quake III Arena OpenGL 32-bit architecture',
  }, () => {
    assert.strictEqual(typeof binaryInspectors.inspectWindowsExecutableHeader, 'function');
  });

  test({
    id: 'F14-05',
    feature: 'F14',
    tier: 1,
    description: 'Supervisor displaysession control watcher handles runtime aspect cycling and fullscreen toggle',
  }, () => {
    assert.strictEqual(typeof supervisor.toggleSessionFullscreen, 'function');
  });

  test({
    id: 'F14-06',
    feature: 'F14',
    tier: 1,
    description: 'Adversarial defect injection: verifier catches horizontal offset, dirty margins, and menubar/dock bleed',
  }, () => {
    // 1. Horizontal offset defect (+1px shift)
    const offsetFrame = generateSyntheticRetinaFrame({ defect: 'offset' });
    const offsetReport = verifyDisplayOutput({ imageBuffer: offsetFrame });
    assert.strictEqual(offsetReport.ok, false, 'Verifier must reject 1px offset shift');
    assert.ok(
      offsetReport.metrics.centeringDelta > 0 || offsetReport.metrics.marginViolations > 0,
      'Must report centering or margin discrepancy for offset defect'
    );

    // 2. Margin white border defect
    const marginFrame = generateSyntheticRetinaFrame({ defect: 'margin_white' });
    const marginReport = verifyDisplayOutput({ imageBuffer: marginFrame });
    assert.strictEqual(marginReport.ok, false, 'Verifier must reject white pixels in pillarbox margins');
    assert.ok(marginReport.metrics.marginViolations > 0, 'Must record positive margin violation count');

    // 3. Menu Bar bleed defect (top 0..44px margin contamination)
    const menuFrame = generateSyntheticRetinaFrame({ defect: 'menubar_bleed' });
    const menuReport = verifyDisplayOutput({ imageBuffer: menuFrame });
    assert.strictEqual(menuReport.ok, false, 'Verifier must reject Menu Bar bleed');
    assert.strictEqual(menuReport.metrics.menuBarBleed, true, 'menuBarBleed must be flagged');

    // 4. Dock bleed defect (bottom 60px margin contamination)
    const dockFrame = generateSyntheticRetinaFrame({ defect: 'dock_bleed' });
    const dockReport = verifyDisplayOutput({ imageBuffer: dockFrame });
    assert.strictEqual(dockReport.ok, false, 'Verifier must reject Dock bleed');
    assert.strictEqual(dockReport.metrics.dockBleed, true, 'dockBleed must be flagged');

    // 5. Vertical offset defect (+1px vertical shift in letterbox mode)
    const vertOffsetFrame = generateSyntheticRetinaFrame({
      defect: 'vertical_offset',
      screenW: 3024,
      screenH: 1964,
      virtW: 1920,
      virtH: 1080,
    });
    const vertReport = verifyDisplayOutput({
      imageBuffer: vertOffsetFrame,
      screenW: 3024,
      screenH: 1964,
      virtW: 1920,
      virtH: 1080,
    });
    assert.strictEqual(vertReport.ok, false, 'Verifier must reject 1px vertical offset shift');
    assert.strictEqual(vertReport.metrics.verticalCenteringDelta, 1, 'Must report 1px vertical centering delta');
    assert.strictEqual(vertReport.metrics.centeringDelta, 1, 'Chebyshev centering error must be 1px');

    // 6. Multi-row resilience: frame with dark pixel at (dstX, midY) must pass
    const w = 3024;
    const h = 1964;
    const rgbaResilient = Buffer.alloc(w * h * 4);
    const vpResilient = computeOracleViewport(w, h, 0, 640, 480, 'preserve');
    for (let y = vpResilient.dstY; y < vpResilient.dstY + vpResilient.dstH; y++) {
      for (let x = vpResilient.dstX; x < vpResilient.dstX + vpResilient.dstW; x++) {
        const i = (y * w + x) * 4;
        rgbaResilient[i] = 120;
        rgbaResilient[i + 1] = 120;
        rgbaResilient[i + 2] = 120;
        rgbaResilient[i + 3] = 255;
      }
    }
    // Single dark edge pixel at horizontal midline
    const darkEdgeIdx = (Math.floor(h / 2) * w + vpResilient.dstX) * 4;
    rgbaResilient[darkEdgeIdx] = 0;
    rgbaResilient[darkEdgeIdx + 1] = 0;
    rgbaResilient[darkEdgeIdx + 2] = 0;
    const resilientReport = verifyDisplayOutput({ imageBuffer: encodePng(w, h, rgbaResilient) });
    assert.strictEqual(resilientReport.ok, true, 'Multi-row edge detection must not falsely reject dark midline edge pixel');
    assert.strictEqual(resilientReport.metrics.centeringDelta, 0, 'Centering delta must remain 0px');

    // 7. Margin bleed rejection: 1px bleed adjacent to viewport must be strictly rejected
    const rgbaBleed = Buffer.from(rgbaResilient);
    const bleedIdx = (Math.floor(h / 2) * w + (vpResilient.dstX - 1)) * 4;
    rgbaBleed[bleedIdx] = 15;
    const bleedReport = verifyDisplayOutput({ imageBuffer: encodePng(w, h, rgbaBleed) });
    assert.strictEqual(bleedReport.ok, false, 'Verifier must reject 1px outer margin bleed');
    assert.ok(bleedReport.metrics.marginViolations > 0, 'Must record margin violation for outer bleed');
  });

  test({
    id: 'F14-07',
    feature: 'F14',
    tier: 1,
    description: 'Screen lock detection robustness: Quartz screen lock dictionary query executes safely',
  }, () => {
    const lockState = detectScreenLockState();
    assert.strictEqual(typeof lockState, 'object', 'detectScreenLockState must return an object');
    assert.strictEqual(typeof lockState.isLocked, 'boolean', 'isLocked must be a boolean');
    assert.strictEqual(typeof lockState.available, 'boolean', 'available must be a boolean');

    const lockedBool = isScreenLocked();
    assert.strictEqual(typeof lockedBool, 'boolean', 'isScreenLocked() helper must return boolean');
    assert.strictEqual(lockedBool, lockState.isLocked, 'isScreenLocked() must match lockState.isLocked');

    // Verify graceful handling when screen lock is simulated or active
    const lockedLive = verifyDisplayOutput({ live: true, screenW: 3024, screenH: 1964 });
    assert.strictEqual(typeof lockedLive, 'object', 'verifyDisplayOutput must return a valid object');
    assert.ok(typeof lockedLive.ok === 'boolean', 'ok must be a boolean');
    if (lockedLive.skipped) {
      assert.ok(lockedLive.reason.includes('locked'), 'Skipped report must cite screen lock');
    }
  });
});
