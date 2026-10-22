const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

/**
 * electron-builder afterPack hook:
 * Ensures macOS ARM64/x64 bundles have all nested unpacked binaries (gogdl, legendary),
 * frameworks, helpers, and the top-level .app bundle properly ad-hoc signed and sealed
 * (binding Info.plist and _CodeSignature/CodeResources) when building without a paid
 * Apple Developer ID certificate (CSC_IDENTITY_AUTO_DISCOVERY=false).
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) {
    return;
  }

  console.log(`  • [afterPack] Ad-hoc signing macOS bundle: ${appPath}`);

  try {
    execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });
  } catch {
    // Ignore if xattr is unavailable
  }

  // Sign nested unpacked CLI binaries and Mach-O helper dylibs first (inside-out signing order required by Apple codesign)
  const unpackedDirs = [
    path.join(
      appPath,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'electron',
      'bin',
      'arm64',
      'darwin'
    ),
    path.join(
      appPath,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'electron',
      'helpers'
    ),
  ];
  for (const unpackedDir of unpackedDirs) {
    if (!fs.existsSync(unpackedDir)) continue;
    for (const entry of fs.readdirSync(unpackedDir)) {
      if (entry.endsWith('.c') || entry.endsWith('.h') || entry.endsWith('.md')) continue;
      const binPath = path.join(unpackedDir, entry);
      if (fs.statSync(binPath).isFile()) {
        fs.chmodSync(binPath, 0o755);
        execFileSync('codesign', ['--force', '--sign', '-', binPath], {
          stdio: 'inherit',
        });
      }
    }
  }

  // Deep ad-hoc sign the entire application bundle (Frameworks, Helpers, Main Executable, Info.plist & CodeResources)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });

  // Strictly verify the resulting bundle signature on disk
  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=1', appPath],
    { stdio: 'inherit' }
  );
  console.log(`  • [afterPack] Verified macOS bundle signature: ${appPath}`);
};
