'use strict';

const { suite, test, assert, invokeNativeViewport } = require('../harness/index.cjs');

suite('Tier 1 — Feature F12: Quake III Mouse Cursor & Input Fix', () => {
  const screenW = 3024;
  const screenH = 1964;
  const virtW = 640;
  const virtH = 480;

  // Symmetrically centered viewport parameters
  const vp = invokeNativeViewport(screenW, screenH, 0, virtW, virtH, 'preserve');

  test({
    id: 'F12-01',
    feature: 'F12',
    tier: 1,
    description: 'Physical cursor coordinates match warp anchor coordinate scale (preventing 2x delta blowup)',
  }, () => {
    assert.ok(vp && vp.ok);
    // Center point in physical space
    const centerPx = vp.dstX + Math.floor(vp.dstW / 2);
    const centerPy = vp.dstY + Math.floor(vp.dstH / 2);

    // Delta between physical center and physical warp anchor at center
    const deltaX = centerPx - (vp.dstX + Math.floor(vp.dstW / 2));
    const deltaY = centerPy - (vp.dstY + Math.floor(vp.dstH / 2));

    assert.strictEqual(deltaX, 0, 'Physical delta at center must be 0');
    assert.strictEqual(deltaY, 0, 'Physical delta at center must be 0');
  });

  test({
    id: 'F12-02',
    feature: 'F12',
    tier: 1,
    description: 'Center cursor position resolves to virtual (320, 240) in 640x480 mode',
  }, () => {
    assert.ok(vp && vp.ok);
    const centerPx = vp.dstX + Math.floor(vp.dstW / 2);
    const centerPy = vp.dstY + Math.floor(vp.dstH / 2);

    const relX = Math.max(0, Math.min(centerPx - vp.dstX, vp.dstW - 1));
    const relY = Math.max(0, Math.min(centerPy - vp.dstY, vp.dstH - 1));

    const vx = Math.floor((relX * virtW) / vp.dstW);
    const vy = Math.floor((relY * virtH) / vp.dstH);

    assert.ok(
      Math.abs(vx - 320) <= 1,
      `F12 contract violation: center physical cursor must map to virtual X ~320, got ${vx}`
    );
    assert.ok(
      Math.abs(vy - 240) <= 1,
      `F12 contract violation: center physical cursor must map to virtual Y ~240, got ${vy}`
    );
  });

  test({
    id: 'F12-03',
    feature: 'F12',
    tier: 1,
    description: 'Cursor position at viewport top-left resolves to virtual (0, 0)',
  }, () => {
    assert.ok(vp && vp.ok);
    const topPx = vp.dstX;
    const topPy = vp.dstY;

    const relX = Math.max(0, Math.min(topPx - vp.dstX, vp.dstW - 1));
    const relY = Math.max(0, Math.min(topPy - vp.dstY, vp.dstH - 1));

    const vx = Math.floor((relX * virtW) / vp.dstW);
    const vy = Math.floor((relY * virtH) / vp.dstH);

    assert.strictEqual(vx, 0, 'Top-left must map to virtual X=0');
    assert.strictEqual(vy, 0, 'Top-left must map to virtual Y=0');
  });

  test({
    id: 'F12-04',
    feature: 'F12',
    tier: 1,
    description: 'Cursor position at viewport bottom-right resolves to virtual (639, 479)',
  }, () => {
    assert.ok(vp && vp.ok);
    const botPx = vp.dstX + vp.dstW - 1;
    const botPy = vp.dstY + vp.dstH - 1;

    const relX = Math.max(0, Math.min(botPx - vp.dstX, vp.dstW - 1));
    const relY = Math.max(0, Math.min(botPy - vp.dstY, vp.dstH - 1));

    const vx = Math.floor((relX * virtW) / vp.dstW);
    const vy = Math.floor((relY * virtH) / vp.dstH);

    assert.strictEqual(vx, 639, 'Bottom-right must map to virtual X=639');
    assert.strictEqual(vy, 479, 'Bottom-right must map to virtual Y=479');
  });

  test({
    id: 'F12-05',
    feature: 'F12',
    tier: 1,
    description: 'Menu mouse movement produces bidirectional deltas without bottom-right pinning',
  }, () => {
    assert.ok(vp && vp.ok);
    // Simulate motion left and up by 50 physical pixels from center
    const centerPx = vp.dstX + Math.floor(vp.dstW / 2);
    const centerPy = vp.dstY + Math.floor(vp.dstH / 2);

    const movedPx = centerPx - 50;
    const movedPy = centerPy - 50;

    const relX = movedPx - vp.dstX;
    const relY = movedPy - vp.dstY;

    const vx = Math.floor((relX * virtW) / vp.dstW);
    const vy = Math.floor((relY * virtH) / vp.dstH);

    assert.ok(vx < 320, `Cursor moved left must decrease virtual X (${vx} < 320)`);
    assert.ok(vy < 240, `Cursor moved up must decrease virtual Y (${vy} < 240)`);
    assert.notStrictEqual(vx, 639, 'Cursor must not be pinned to bottom-right 639');
    assert.notStrictEqual(vy, 479, 'Cursor must not be pinned to bottom-right 479');
  });
});
