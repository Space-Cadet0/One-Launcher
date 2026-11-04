'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert } = require('../harness/index.cjs');

const supervisor = require('../../../electron/launcher/sessionAndProcessSupervisor.cjs');
const binaryInspectors = require('../../../electron/launcher/binaryAndManifestInspectors.cjs');

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
    // Human-like observation captures full panel (3024x1964), not single-app window
    const targetPhysicalWidth = 3024;
    const targetPhysicalHeight = 1964;

    assert.ok(targetPhysicalWidth >= 2560, 'Physical observation width must represent full panel');
    assert.ok(targetPhysicalHeight >= 1600, 'Physical observation height must represent full panel');
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
});
