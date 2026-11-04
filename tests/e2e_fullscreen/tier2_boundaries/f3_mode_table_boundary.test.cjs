'use strict';

const { suite, test, assert, invokeNativeModeTable } = require('../harness/index.cjs');

suite('Tier 2 — Feature F3 Boundaries: Mode Table Limit & Edge Resolutions', () => {
  test({
    id: 'F3-B01',
    feature: 'F3',
    tier: 2,
    description: 'No 8-bpp mode is emitted for native resolution 3024x1964 (saving slot for high-res modes)',
  }, () => {
    const modes = invokeNativeModeTable(3024, 1964, 120);
    const has3024x1964x8 = modes.some(m => m.width === 3024 && m.height === 1964 && m.bpp === 8);
    assert.strictEqual(
      has3024x1964x8,
      false,
      'F3-B01: 8-bpp palette mode must NOT be emitted for 3024x1964'
    );
  });

  test({
    id: 'F3-B02',
    feature: 'F3',
    tier: 2,
    description: '4K display (3840x2160) synthesis includes 4K modes without exceeding 52-mode cap',
  }, () => {
    const modes = invokeNativeModeTable(3840, 2160, 60);
    assert.ok(modes.length <= 52, `Mode count for 4K display must be <= 52, got ${modes.length}`);
    const has4K32 = modes.some(m => m.width === 3840 && m.height === 2160 && m.bpp === 32);
    assert.strictEqual(has4K32, true, '4K 32-bpp mode must be present');
  });

  test({
    id: 'F3-B03',
    feature: 'F3',
    tier: 2,
    description: 'Small display (1280x800) synthesis generates strictly valid modes <= 1280x800',
  }, () => {
    const modes = invokeNativeModeTable(1280, 800, 60);
    assert.ok(modes.length > 0 && modes.length <= 52);
    // Standard mandatory modes like 640x480, 800x600, 1024x768 and native 1280x800
    const hasNative = modes.some(m => m.width === 1280 && m.height === 800 && m.bpp === 32);
    assert.strictEqual(hasNative, true, 'Native 1280x800 mode must be present');

    // No modes exceeding 1280 width should be present
    const oversized = modes.filter(m => m.width > 1280);
    assert.deepStrictEqual(oversized, [], 'No modes wider than screen should be emitted');
  });

  test({
    id: 'F3-B04',
    feature: 'F3',
    tier: 2,
    description: 'High refresh rate (144Hz / 240Hz) is faithfully preserved across all synthesized modes',
  }, () => {
    const modes144 = invokeNativeModeTable(3024, 1964, 144);
    assert.ok(modes144.length > 0);
    for (const m of modes144) {
      assert.strictEqual(m.refreshHz, 144, `Mode ${m.width}x${m.height} must have refreshHz=144`);
    }
  });

  test({
    id: 'F3-B05',
    feature: 'F3',
    tier: 2,
    description: 'Native resolution matching a standard resolution (e.g. 1920x1080) is not duplicated',
  }, () => {
    const modes = invokeNativeModeTable(1920, 1080, 60);
    const modes1080p32 = modes.filter(m => m.width === 1920 && m.height === 1080 && m.bpp === 32);
    assert.strictEqual(
      modes1080p32.length,
      1,
      `F3-B05: Standard resolution matching native must not be duplicated (found ${modes1080p32.length})`
    );
  });
});
