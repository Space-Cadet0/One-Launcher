'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, invokeNativeWarpDrift } = require('../harness/index.cjs');

suite('Tier 1 — Feature F10: Fix 3D Mouse Look & View Control in JK:DF2', () => {
  test({
    id: 'F10-01',
    feature: 'F10',
    tier: 1,
    description: 'k_phys_surface_mods in display_scaler_dll.c includes L"dinput.dll"',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
      'utf8'
    );

    const hasDinput = /k_phys_surface_mods[\s\S]*?L"dinput\.dll"/m.test(src);
    assert.ok(
      hasDinput,
      'F10 contract violation: k_phys_surface_mods must include L"dinput.dll" so Wine DirectInput receives physical coordinates'
    );
  });

  test({
    id: 'F10-02',
    feature: 'F10',
    tier: 1,
    description: 'k_phys_surface_mods in display_scaler_dll.c includes L"dinput8.dll"',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
      'utf8'
    );

    const hasDinput8 = /k_phys_surface_mods[\s\S]*?L"dinput8\.dll"/m.test(src);
    assert.ok(
      hasDinput8,
      'F10 contract violation: k_phys_surface_mods must include L"dinput8.dll"'
    );
  });

  test({
    id: 'F10-03',
    feature: 'F10',
    tier: 1,
    description: 'DirectInput caller module basename query bypasses virtual coordinate translation',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
      'utf8'
    );

    // Contract: ds_should_virtualize_rect_for_caller must return false for dinput
    const filtersCaller = /_wcsicmp\s*\(\s*base\s*,\s*k_phys_surface_mods\[i\]\s*\)\s*==\s*0/m.test(src);
    assert.ok(
      filtersCaller,
      'F10 contract violation: ds_should_virtualize_rect_for_caller must filter callers against k_phys_surface_mods'
    );
  });

  test({
    id: 'F10-04',
    feature: 'F10',
    tier: 1,
    description: 'Stationary warp anchor test: repeated SetCursorPos(320, 240) produces zero relative drift',
  }, () => {
    // 1000 stationary warp iterations on 3024x1964 screen with safe_inset_top = 0
    const drift = invokeNativeWarpDrift(1000, 3024, 1964, 0, 640, 480);
    assert.strictEqual(
      drift.driftX,
      0,
      `F10 contract violation: horizontal drift detected (${drift.driftX}px)`
    );
    assert.strictEqual(
      drift.driftY,
      0,
      `F10 contract violation: vertical drift detected (${drift.driftY}px), causing ceiling look`
    );
  });

  test({
    id: 'F10-05',
    feature: 'F10',
    tier: 1,
    description: 'Warp accumulator tracks 64-bit sub-pixel remainders to prevent truncation drift',
  }, () => {
    const headerSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler.h'),
      'utf8'
    );

    const has64BitRem = /int64_t\s+rem_num_x/m.test(headerSrc) &&
      /int64_t\s+rem_num_y/m.test(headerSrc);

    assert.ok(
      has64BitRem,
      'F10 contract violation: ds_cursor_warp_state_t must declare int64_t sub-pixel remainders'
    );
  });
});
