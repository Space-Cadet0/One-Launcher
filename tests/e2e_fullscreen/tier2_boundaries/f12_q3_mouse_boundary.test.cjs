'use strict';

const { suite, test, assert, invokeNativeViewport } = require('../harness/index.cjs');

suite('Tier 2 — Feature F12 Boundaries: Quake III Cursor Clamping & Delta Boundaries', () => {
  const sw = 3024;
  const sh = 1964;
  const vw = 640;
  const vh = 480;
  const vp = invokeNativeViewport(sw, sh, 0, vw, vh, 'preserve');

  test({
    id: 'F12-B01',
    feature: 'F12',
    tier: 2,
    description: 'Cursor moved deep into left pillarbox bar (x=50) clamps cleanly to virtual x=0',
  }, () => {
    assert.ok(vp && vp.ok);
    const inLeftPillar = 50; // In pillarbox bar (dstX ~203)
    const relX = Math.max(0, Math.min(inLeftPillar - vp.dstX, vp.dstW - 1));
    const vx = Math.floor((relX * vw) / vp.dstW);

    assert.strictEqual(vx, 0, 'Cursor in left pillarbox must clamp to virtual X=0');
  });

  test({
    id: 'F12-B02',
    feature: 'F12',
    tier: 2,
    description: 'Cursor moved deep into right pillarbox bar (x=3000) clamps cleanly to virtual x=639',
  }, () => {
    assert.ok(vp && vp.ok);
    const inRightPillar = 3000;
    const relX = Math.max(0, Math.min(inRightPillar - vp.dstX, vp.dstW - 1));
    const vx = Math.floor((relX * vw) / vp.dstW);

    assert.strictEqual(vx, 639, 'Cursor in right pillarbox must clamp to virtual X=639');
  });

  test({
    id: 'F12-B03',
    feature: 'F12',
    tier: 2,
    description: 'Rapid diagonal sweep across 100 sample points maintains monotonic coordinate progression',
  }, () => {
    assert.ok(vp && vp.ok);
    let prevVx = -1;
    let prevVy = -1;

    for (let i = 0; i < 100; i++) {
      const px = vp.dstX + Math.floor((i * (vp.dstW - 1)) / 99);
      const py = vp.dstY + Math.floor((i * (vp.dstH - 1)) / 99);

      const relX = Math.max(0, Math.min(px - vp.dstX, vp.dstW - 1));
      const relY = Math.max(0, Math.min(py - vp.dstY, vp.dstH - 1));

      const vx = Math.floor((relX * vw) / vp.dstW);
      const vy = Math.floor((relY * vh) / vp.dstH);

      assert.ok(vx >= prevVx, `Monotonic progression violated for vx at step ${i}`);
      assert.ok(vy >= prevVy, `Monotonic progression violated for vy at step ${i}`);
      prevVx = vx;
      prevVy = vy;
    }
  });

  test({
    id: 'F12-B04',
    feature: 'F12',
    tier: 2,
    description: 'Virtual-to-physical roundtrip coordinate mapping has maximum error <= 1 pixel',
  }, () => {
    assert.ok(vp && vp.ok);
    for (let testVx = 0; testVx < vw; testVx += 64) {
      for (let testVy = 0; testVy < vh; testVy += 48) {
        // Map virt to phys
        const px = vp.dstX + Math.floor((testVx * vp.dstW) / vw);
        const py = vp.dstY + Math.floor((testVy * vp.dstH) / vh);

        // Map phys back to virt
        const relX = Math.max(0, Math.min(px - vp.dstX, vp.dstW - 1));
        const relY = Math.max(0, Math.min(py - vp.dstY, vp.dstH - 1));
        const roundVx = Math.floor((relX * vw) / vp.dstW);
        const roundVy = Math.floor((relY * vh) / vp.dstH);

        assert.ok(
          Math.abs(roundVx - testVx) <= 1,
          `Roundtrip error on X for ${testVx}: got ${roundVx}`
        );
        assert.ok(
          Math.abs(roundVy - testVy) <= 1,
          `Roundtrip error on Y for ${testVy}: got ${roundVy}`
        );
      }
    }
  });

  test({
    id: 'F12-B05',
    feature: 'F12',
    tier: 2,
    description: 'Cursor mapping succeeds for non-standard 16:9 virtual resolutions (1280x720)',
  }, () => {
    const vp169 = invokeNativeViewport(sw, sh, 0, 1280, 720, 'preserve');
    assert.ok(vp169 && vp169.ok);

    const centerPx = vp169.dstX + Math.floor(vp169.dstW / 2);
    const centerPy = vp169.dstY + Math.floor(vp169.dstH / 2);

    const relX = Math.max(0, Math.min(centerPx - vp169.dstX, vp169.dstW - 1));
    const relY = Math.max(0, Math.min(centerPy - vp169.dstY, vp169.dstH - 1));

    const vx = Math.floor((relX * 1280) / vp169.dstW);
    const vy = Math.floor((relY * 720) / vp169.dstH);

    assert.ok(Math.abs(vx - 640) <= 1);
    assert.ok(Math.abs(vy - 360) <= 1);
  });
});
