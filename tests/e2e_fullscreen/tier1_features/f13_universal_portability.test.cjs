'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert } = require('../harness/index.cjs');

suite('Tier 1 — Feature F13: Universal Portability & De-Hacking', () => {
  test({
    id: 'F13-01',
    feature: 'F13',
    tier: 1,
    description: 'macNativeInstaller gates macOS Mac Driver operations on process.platform === "darwin"',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/launcher/macNativeInstallerAndCodesign.cjs'),
      'utf8'
    );

    const hasDarwinGating = /process\.platform\s*===\s*['"]darwin['"]/m.test(src);
    assert.ok(
      hasDarwinGating,
      'F13 contract violation: macOS display operations must be gated on process.platform === "darwin"'
    );
  });

  test({
    id: 'F13-02',
    feature: 'F13',
    tier: 1,
    description: 'Native Windows (win32) sessions bypass Mac driver registry manipulation',
  }, () => {
    const supervisorSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/launcher/sessionAndProcessSupervisor.cjs'),
      'utf8'
    );

    const gatesDarwinInSupervisor = /process\.platform\s*===\s*['"]darwin['"]/m.test(supervisorSrc);
    assert.ok(
      gatesDarwinInSupervisor,
      'F13 contract violation: session supervisor must gate macOS bottle helpers on darwin'
    );
  });

  test({
    id: 'F13-03',
    feature: 'F13',
    tier: 1,
    description: 'Zero Per-Game patches: core math engine contains zero executable name hardcoding',
  }, () => {
    const mathSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_math.c'),
      'utf8'
    );

    const hasGameExeHack = /"JK\.EXE"/i.test(mathSrc) ||
      /"quake3\.exe"/i.test(mathSrc) ||
      /"Jedi/i.test(mathSrc);

    assert.strictEqual(
      hasGameExeHack,
      false,
      'F13 contract violation: display_scaler_math.c must remain universally portable with zero per-game executable hacks'
    );
  });

  test({
    id: 'F13-04',
    feature: 'F13',
    tier: 1,
    description: 'Zero Per-User patches: configuration resolution works on fresh installs without user manual setup',
  }, () => {
    const engineState = require('../../../electron/launcher/engineStateRegistry.cjs');
    // Default launch profile must exist and be valid
    assert.ok(engineState.DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS);
    assert.strictEqual(typeof engineState.DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS, 'object');
  });

  test({
    id: 'F13-05',
    feature: 'F13',
    tier: 1,
    description: 'Zero-PII invariant: source code and manifests contain no local usernames, emails, or personal paths',
  }, () => {
    const filesToAudit = [
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler.h'),
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_math.c'),
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
    ];

    const piiRegex = /\/Users\/(?!runner|Shared)[a-zA-Z0-9_-]+\/|@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

    for (const file of filesToAudit) {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf8');
        const match = piiRegex.exec(content);
        assert.strictEqual(
          match,
          null,
          `F13 contract violation: PII detected in ${path.basename(file)}: ${match ? match[0] : ''}`
        );
      }
    }
  });
});
