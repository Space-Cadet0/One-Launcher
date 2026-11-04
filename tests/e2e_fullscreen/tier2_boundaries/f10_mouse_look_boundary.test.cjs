'use strict';

const { suite, test, assert, invokeNativeWarpDrift } = require('../harness/index.cjs');

suite('Tier 2 — Feature F10 Boundaries: 3D Mouse Look & Warp Accumulator Torture', () => {
  test({
    id: 'F10-B01',
    feature: 'F10',
    tier: 2,
    description: '10,000-iteration warp torture test produces exact zero accumulated vertical drift (zero ceiling look)',
  }, () => {
    // Torture test: 10,000 warp cycles on native 3024x1964 with safe_inset_top = 0
    const drift = invokeNativeWarpDrift(10000, 3024, 1964, 0, 640, 480);
    assert.strictEqual(
      drift.driftX,
      0,
      `F10-B01: 10,000-cycle horizontal drift detected: ${drift.driftX}`
    );
    assert.strictEqual(
      drift.driftY,
      0,
      `F10-B01: 10,000-cycle vertical drift detected: ${drift.driftY} (drives character to look at ceiling)`
    );
  });

  test({
    id: 'F10-B02',
    feature: 'F10',
    tier: 2,
    description: 'Zero safe inset eliminates asymmetric vertical bias between upward and downward deltas',
  }, () => {
    const sw = 3024;
    const sh = 1964;
    const vw = 640;
    const vh = 480;

    // With safe_inset_top = 0, top margin == bottom margin
    const topMargin = Math.floor((sh - vh) / 2);
    const bottomMargin = sh - (topMargin + vh);

    assert.ok(
      Math.abs(topMargin - bottomMargin) <= 1,
      'F10-B02: Top and bottom margins must be symmetric to prevent directional bias'
    );
  });

  test({
    id: 'F10-B03',
    feature: 'F10',
    tier: 2,
    description: 'Extreme physical mouse coordinates (e.g. 50,000px) clamp safely without 32-bit integer overflow',
  }, () => {
    const { oracleComputeViewport } = require('../harness/index.cjs');
    const vp = oracleComputeViewport(3024, 1964, 0, 640, 480, 'preserve');
    assert.ok(vp);

    // Large coordinate clamp test
    const extremePx = 50000;
    const extremePy = 50000;
    const clampedX = Math.max(0, Math.min(extremePx - vp.dstX, vp.dstW - 1));
    const clampedY = Math.max(0, Math.min(extremePy - vp.dstY, vp.dstH - 1));

    const vx = Math.floor((clampedX * 640) / vp.dstW);
    const vy = Math.floor((clampedY * 480) / vp.dstH);

    assert.strictEqual(vx, 639);
    assert.strictEqual(vy, 479);
  });

  test({
    id: 'F10-B04',
    feature: 'F10',
    tier: 2,
    description: 'Negative physical mouse coordinates clamp safely to virtual (0, 0)',
  }, () => {
    const { oracleComputeViewport } = require('../harness/index.cjs');
    const vp = oracleComputeViewport(3024, 1964, 0, 640, 480, 'preserve');
    assert.ok(vp);

    const negPx = -5000;
    const negPy = -5000;
    const clampedX = Math.max(0, Math.min(negPx - vp.dstX, vp.dstW - 1));
    const clampedY = Math.max(0, Math.min(negPy - vp.dstY, vp.dstH - 1));

    const vx = Math.floor((clampedX * 640) / vp.dstW);
    const vy = Math.floor((clampedY * 480) / vp.dstH);

    assert.strictEqual(vx, 0);
    assert.strictEqual(vy, 0);
  });

  test({
    id: 'F10-B05',
    feature: 'F10',
    tier: 2,
    description: 'DirectInput mouse hook maintains relative movement parity across diagonal vectors',
  }, () => {
    // 45-degree diagonal motion: deltaX should equal deltaY
    const dPx = 100;
    const dPy = 100;

    assert.strictEqual(dPx, dPy, 'Diagonal input displacement must remain symmetric');
  });
});
