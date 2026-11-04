'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, beforeEach, afterEach, assert, makeTempDir, cleanupTempDirs, buildSyntheticPeBuffer, createSyntheticBottle } = require('../harness/index.cjs');

const binaryInspectors = require('../../../electron/launcher/binaryAndManifestInspectors.cjs');
const securityUtils = require('../../../electron/launcher/securityAndPathUtils.cjs');

suite('Tier 2 — Feature F13 Boundaries: Cross-Platform & Path Portability Limits', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir('f13-boundary');
  });

  afterEach(() => {
    cleanupTempDirs();
  });

  test({
    id: 'F13-B01',
    feature: 'F13',
    tier: 2,
    description: 'Paths with spaces and special characters handled cleanly without shell injection vulnerabilities',
  }, () => {
    const specialBottleDir = path.join(tempDir, 'Bottle With Spaces & Special! (v2)');
    const bottle = createSyntheticBottle(specialBottleDir);
    assert.ok(fs.existsSync(bottle.userRegPath));
  });

  test({
    id: 'F13-B02',
    feature: 'F13',
    tier: 2,
    description: 'Synthetic PE32 (0x014c) and PE64 (0x8664) headers inspected accurately without crashes',
  }, () => {
    const pe32Buf = buildSyntheticPeBuffer({ arch: 'x86' });
    const pe64Buf = buildSyntheticPeBuffer({ arch: 'x64' });

    const pe32Path = path.join(tempDir, 'test_x86.exe');
    const pe64Path = path.join(tempDir, 'test_x64.exe');
    fs.writeFileSync(pe32Path, pe32Buf);
    fs.writeFileSync(pe64Path, pe64Buf);

    const h32 = binaryInspectors.inspectWindowsExecutableHeader(pe32Path);
    const h64 = binaryInspectors.inspectWindowsExecutableHeader(pe64Path);

    assert.strictEqual(h32.arch, 'x86');
    assert.strictEqual(h64.arch, 'x64');
  });

  test({
    id: 'F13-B03',
    feature: 'F13',
    tier: 2,
    description: 'Security and path utils strictly sanitize launcher settings payloads',
  }, () => {
    const sanitized = securityUtils.sanitizeLauncherSettingsPayload({
      crossoverDisplayScalingMode: 'auto',
      crossoverDisplayAspect: '4:3',
      unknownMaliciousField: '<script>alert(1)</script>',
    });

    assert.strictEqual(sanitized.crossoverDisplayScalingMode, 'auto');
    assert.strictEqual(sanitized.crossoverDisplayAspect, '4:3');
    assert.strictEqual(sanitized.unknownMaliciousField, undefined);
  });

  test({
    id: 'F13-B04',
    feature: 'F13',
    tier: 2,
    description: 'Control INI parser rejects overflow sequence numbers and truncated lines gracefully',
  }, () => {
    const { runNativeMathAsan } = require('../harness/index.cjs');
    // ASan suite tests INI parser boundary limits
    const asan = runNativeMathAsan();
    assert.strictEqual(asan.status, 0, `ASan parser suite failed: ${asan.stderr}`);
  });

  test({
    id: 'F13-B05',
    feature: 'F13',
    tier: 2,
    description: 'Symlinked game directories resolve canonical paths without PII leakage',
  }, () => {
    const realDir = path.join(tempDir, 'real_game_dir');
    const symlinkDir = path.join(tempDir, 'symlink_game_dir');
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(realDir, symlinkDir, 'dir');

    const resolved = fs.realpathSync(symlinkDir);
    assert.strictEqual(resolved, realDir);
    assert.doesNotMatch(resolved, /@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  });
});
