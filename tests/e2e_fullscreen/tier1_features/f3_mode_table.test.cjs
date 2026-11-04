'use strict';

const { suite, test, assert, invokeNativeModeTable } = require('../harness/index.cjs');

suite('Tier 1 — Feature F3: Mode Table Extension up to 3024x1964', () => {
  test({
    id: 'F3-01',
    feature: 'F3',
    tier: 1,
    description: 'Mode table includes native physical resolution 3024x1964 at 32-bpp',
  }, () => {
    const modes = invokeNativeModeTable(3024, 1964, 120);
    const hasNative32 = modes.some(m => m.width === 3024 && m.height === 1964 && m.bpp === 32);
    assert.strictEqual(
      hasNative32,
      true,
      'F3 contract violation: native physical resolution 3024x1964 at 32-bpp must be present in mode table'
    );
  });

  test({
    id: 'F3-02',
    feature: 'F3',
    tier: 1,
    description: 'Mode table includes native physical resolution 3024x1964 at 16-bpp',
  }, () => {
    const modes = invokeNativeModeTable(3024, 1964, 120);
    const hasNative16 = modes.some(m => m.width === 3024 && m.height === 1964 && m.bpp === 16);
    assert.strictEqual(
      hasNative16,
      true,
      'F3 contract violation: native physical resolution 3024x1964 at 16-bpp must be present in mode table'
    );
  });

  test({
    id: 'F3-03',
    feature: 'F3',
    tier: 1,
    description: 'Mode table total count is strictly <= 52 entries (legacy fixed-slot buffer safety)',
  }, () => {
    const modes = invokeNativeModeTable(3024, 1964, 120);
    assert.ok(
      modes.length <= 52,
      `F3 contract violation: synthesized mode count (${modes.length}) exceeds safety limit of 52`
    );
    assert.ok(
      modes.length >= 35,
      `F3 contract violation: synthesized mode count (${modes.length}) is unexpectedly sparse`
    );
  });

  test({
    id: 'F3-04',
    feature: 'F3',
    tier: 1,
    description: 'Mode table is strictly sorted in ascending order (width, height, bpp)',
  }, () => {
    const modes = invokeNativeModeTable(3024, 1964, 120);
    for (let i = 1; i < modes.length; i++) {
      const prev = modes[i - 1];
      const curr = modes[i];
      const ordered =
        curr.width > prev.width ||
        (curr.width === prev.width && curr.height > prev.height) ||
        (curr.width === prev.width && curr.height === prev.height && curr.bpp > prev.bpp);
      assert.ok(
        ordered,
        `F3 contract violation: mode table not strictly sorted at index ${i}: ` +
        `prev=(${prev.width}x${prev.height}x${prev.bpp}) curr=(${curr.width}x${curr.height}x${curr.bpp})`
      );
    }
  });

  test({
    id: 'F3-05',
    feature: 'F3',
    tier: 1,
    description: '8-bpp modes are strictly restricted to resolutions <= 1024x768',
  }, () => {
    const modes = invokeNativeModeTable(3024, 1964, 120);
    const invalid8bpp = modes.filter(m => m.bpp === 8 && (m.width > 1024 || m.height > 768));
    assert.deepStrictEqual(
      invalid8bpp,
      [],
      'F3 contract violation: 8-bpp modes must only be generated for resolutions <= 1024x768'
    );
  });
});
