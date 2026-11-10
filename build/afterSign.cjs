const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_PYINSTALLER_ENTITLEMENT_KEYS = [
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
];

/**
 * Collect unpacked macOS PyInstaller CLI binaries (`gogdl`, `legendary`) inside a packaged `.app`.
 *
 * @param {string} appPath
 * @returns {string[]}
 */
function collectUnpackedDarwinPyInstallerBinaries(appPath) {
  const results = [];
  if (!appPath || !fs.existsSync(appPath)) return results;
  const unpackedBinRoot = path.join(
    appPath,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'electron',
    'bin'
  );
  if (!fs.existsSync(unpackedBinRoot)) return results;
  for (const entry of fs.readdirSync(unpackedBinRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const darwinDir = path.join(unpackedBinRoot, entry.name, 'darwin');
    if (!fs.existsSync(darwinDir)) continue;
    for (const fileName of fs.readdirSync(darwinDir)) {
      if (fileName !== 'gogdl' && fileName !== 'legendary') continue;
      const fullPath = path.join(darwinDir, fileName);
      try {
        if (fs.statSync(fullPath).isFile()) {
          results.push(fullPath);
        }
      } catch {}
    }
  }
  return results;
}

/**
 * Verify (read-only — never mutating the already-notarized `.app` bundle!) that Developer ID
 * signed macOS builds embedded `entitlements.pyinstaller.plist` on every unpacked `gogdl` and
 * `legendary` binary so Hardened Runtime never aborts Python `.so` extension loading at runtime.
 *
 * @param {string} appPath
 * @param {{ execFileSyncImpl?: typeof execFileSync }} [options]
 */
function verifySignedPyInstallerEntitlements(appPath, options = {}) {
  const execSyncFn =
    typeof options.execFileSyncImpl === 'function' ? options.execFileSyncImpl : execFileSync;
  const binPaths = collectUnpackedDarwinPyInstallerBinaries(appPath);
  for (const binPath of binPaths) {
    const out = String(
      execSyncFn('codesign', ['-d', '--entitlements', ':-', binPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }) || ''
    );
    for (const key of REQUIRED_PYINSTALLER_ENTITLEMENT_KEYS) {
      if (!out.includes(key)) {
        throw new Error(
          `[afterSign] Unpacked PyInstaller binary is missing required Hardened Runtime entitlement "${key}": ${binPath}`
        );
      }
    }
  }
  return { verifiedCount: binPaths.length, binaries: binPaths };
}

exports.default = async function afterSign(context) {
  if (!context || context.electronPlatformName !== 'darwin') {
    return;
  }
  const appName = context.packager?.appInfo?.productFilename;
  if (!appName || !context.appOutDir) return;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) return;

  const { verifiedCount } = verifySignedPyInstallerEntitlements(appPath);
  console.log(
    `  • [afterSign] Verified PyInstaller Hardened Runtime entitlements on ${verifiedCount} unpacked CLI binary(ies): ${appPath}`
  );
};

exports._testHelpers = {
  REQUIRED_PYINSTALLER_ENTITLEMENT_KEYS,
  collectUnpackedDarwinPyInstallerBinaries,
  verifySignedPyInstallerEntitlements,
};
