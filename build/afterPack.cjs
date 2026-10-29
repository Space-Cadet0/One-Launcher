const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const MACHO_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
]);

/**
 * Win32 PE64 bridge DLLs required on BOTH Windows native and macOS CrossOver/GPTK/Wine
 * bottles (injected into bottled Xbox GDK games). Never strip these on darwin or win32!
 */
const KEEP_CROSSOVER_BRIDGE_DLLS = new Set([
  'one_xgameruntime_bridge.dll',
  'one_gameinput_bridge.dll',
  'one_appnotify_bridge.dll',
]);

const ALLOWED_LOCALES = new Set(['en-us.pak']);
const ALLOWED_LPROJ_DIRS = new Set(['en.lproj', 'en_us.lproj', 'base.lproj']);

function isMachOFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 4) {
      return false;
    }
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4);
      const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
      if (bytesRead < 4) return false;
      return MACHO_MAGICS.has(buf.readUInt32BE(0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function collectNestedMachOFiles(dirPath, skipExactPaths = new Set()) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;

  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '_CodeSignature') continue;
      const fullPath = path.join(current, entry.name);
      let lstat;
      try {
        lstat = fs.lstatSync(fullPath);
      } catch {
        continue;
      }
      if (lstat.isSymbolicLink()) continue;
      if (lstat.isDirectory()) {
        walk(fullPath);
      } else if (lstat.isFile() && !skipExactPaths.has(fullPath) && isMachOFile(fullPath)) {
        results.push(fullPath);
      }
    }
  };

  walk(dirPath);
  results.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  return results;
}

/**
 * Prunes Chromium locales/*.pak on Windows/Linux builds, keeping only en-US.pak (~48.3 MB saved).
 */
function pruneChromiumLocalePaks(localesDir) {
  if (!fs.existsSync(localesDir)) {
    return { removedCount: 0, reclaimedBytes: 0 };
  }

  let removedCount = 0;
  let reclaimedBytes = 0;

  for (const entry of fs.readdirSync(localesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.pak')) continue;
    if (ALLOWED_LOCALES.has(entry.name.toLowerCase())) continue;

    const fullPath = path.join(localesDir, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      fs.rmSync(fullPath, { force: true });
      removedCount += 1;
      reclaimedBytes += stat.size;
    } catch {
      // Ignore individual unlink failures
    }
  }

  return { removedCount, reclaimedBytes };
}

/**
 * Prunes non-English *.lproj folders on macOS builds (defense-in-depth alongside electronLanguages).
 */
function pruneMacLprojDirs(resourcesDir) {
  if (!fs.existsSync(resourcesDir)) {
    return { removedCount: 0 };
  }

  let removedCount = 0;
  for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith('.lproj')) continue;
    if (ALLOWED_LPROJ_DIRS.has(entry.name.toLowerCase())) continue;
    try {
      fs.rmSync(path.join(resourcesDir, entry.name), { recursive: true, force: true });
      removedCount += 1;
    } catch {
      // Ignore individual removal failures
    }
  }
  return { removedCount };
}

/**
 * Strips cross-OS unpacked waste from app.asar.unpacked:
 * - On Windows/Linux: strips macOS-only *.dylib, *.icns, and electron/bin/* /darwin directories.
 * - On macOS: strips Windows-only *.ico, electron/bin/* /win32 directories, and Windows-only
 *   *.dll / *.exe files EXCEPT one_xgameruntime_bridge.dll, one_gameinput_bridge.dll, and
 *   one_appnotify_bridge.dll (which macOS CrossOver/GPTK/Wine bottles inject into bottled Xbox GDK games).
 */
function pruneUnpackedCrossOsAssets(unpackedDir, platformName) {
  if (!fs.existsSync(unpackedDir)) {
    return { removedCount: 0, reclaimedBytes: 0 };
  }

  let removedCount = 0;
  let reclaimedBytes = 0;

  const measureDirBytes = (dir) => {
    let total = 0;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const st = fs.lstatSync(p);
        if (st.isDirectory() && !st.isSymbolicLink()) total += measureDirBytes(p);
        else if (st.isFile()) total += st.size;
      }
    } catch {
      // Ignore
    }
    return total;
  };

  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      let lstat;
      try {
        lstat = fs.lstatSync(fullPath);
      } catch {
        continue;
      }
      if (lstat.isSymbolicLink()) continue;

      if (lstat.isDirectory()) {
        const lowerDir = entry.name.toLowerCase();
        const parentBase = path.basename(path.dirname(current)).toLowerCase();
        const isOppositeOsBinDir =
          parentBase === 'bin' &&
          ((platformName === 'darwin' && (lowerDir === 'win32' || lowerDir === 'linux')) ||
            (platformName === 'win32' && (lowerDir === 'darwin' || lowerDir === 'linux')) ||
            (platformName === 'linux' && (lowerDir === 'darwin' || lowerDir === 'win32')));

        if (isOppositeOsBinDir) {
          reclaimedBytes += measureDirBytes(fullPath);
          fs.rmSync(fullPath, { recursive: true, force: true });
          removedCount += 1;
          continue;
        }

        walk(fullPath);
        continue;
      }

      if (!lstat.isFile()) continue;

      const lowerName = entry.name.toLowerCase();
      let shouldRemove = false;

      if (platformName !== 'darwin') {
        if (lowerName.endsWith('.dylib') || lowerName.endsWith('.icns')) {
          shouldRemove = true;
        }
      } else {
        if (lowerName.endsWith('.ico')) {
          shouldRemove = true;
        } else if (lowerName.endsWith('.dll') && !KEEP_CROSSOVER_BRIDGE_DLLS.has(lowerName)) {
          shouldRemove = true;
        } else if (lowerName.endsWith('.exe')) {
          shouldRemove = true;
        }
      }

      if (shouldRemove) {
        reclaimedBytes += lstat.size;
        fs.rmSync(fullPath, { force: true });
        removedCount += 1;
      }
    }
  };

  walk(unpackedDir);
  return { removedCount, reclaimedBytes };
}

/**
 * electron-builder afterPack hook:
 * 1. Prunes unused Chromium locale packs (keeping en-US.pak on Windows/Linux, saving ~48.3 MB)
 *    and strips cross-OS unpacked assets while preserving CrossOver Xbox GDK bridge DLLs.
 * 2. Ensures macOS ARM64/x64 bundles have all nested unpacked PyInstaller CLI binaries
 *    (gogdl, legendary), helper dylibs, frameworks, helper .app bundles, and the outer
 *    .app bundle signed strictly inside-out with Hardened Runtime WITHOUT `codesign --deep`
 *    (which would clobber nested PyInstaller entitlements).
 */
exports.default = async function afterPack(context) {
  const platformName = context.electronPlatformName;

  if (platformName !== 'darwin') {
    const localesResult = pruneChromiumLocalePaks(path.join(context.appOutDir, 'locales'));
    const unpackedResult = pruneUnpackedCrossOsAssets(
      path.join(context.appOutDir, 'resources', 'app.asar.unpacked'),
      platformName
    );
    const totalMb = ((localesResult.reclaimedBytes + unpackedResult.reclaimedBytes) / (1024 * 1024)).toFixed(2);
    console.log(
      `  • [afterPack] (${platformName}) Pruned ${localesResult.removedCount} unused locale .pak files & ${unpackedResult.removedCount} cross-OS unpacked files (-${totalMb} MB)`
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) {
    return;
  }

  const buildDir = __dirname;
  const macEntitlementsPath = path.join(buildDir, 'entitlements.mac.plist');
  const pyinstallerEntitlementsPath = path.join(buildDir, 'entitlements.pyinstaller.plist');

  // Prune any non-English .lproj folders and cross-OS unpacked waste BEFORE signing
  pruneMacLprojDirs(path.join(appPath, 'Contents', 'Resources'));
  pruneMacLprojDirs(
    path.join(
      appPath,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Resources'
    )
  );
  const macUnpackedPrune = pruneUnpackedCrossOsAssets(
    path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked'),
    'darwin'
  );
  if (macUnpackedPrune.removedCount > 0) {
    const savedKb = (macUnpackedPrune.reclaimedBytes / 1024).toFixed(1);
    console.log(
      `  • [afterPack] (darwin) Pruned ${macUnpackedPrune.removedCount} cross-OS unpacked files (-${savedKb} KB)`
    );
  }

  try {
    execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });
  } catch {
    // Ignore if xattr is unavailable
  }

  const unpackedElectronRoot = path.join(
    appPath,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'electron'
  );
  const unpackedBinRoot = path.join(unpackedElectronRoot, 'bin');
  const unpackedHelpersDir = path.join(unpackedElectronRoot, 'helpers');

  const darwinBinFiles = [];
  if (fs.existsSync(unpackedBinRoot)) {
    for (const archEntry of fs.readdirSync(unpackedBinRoot, { withFileTypes: true })) {
      if (!archEntry.isDirectory()) continue;
      const darwinArchDir = path.join(unpackedBinRoot, archEntry.name, 'darwin');
      if (!fs.existsSync(darwinArchDir)) continue;
      for (const fileName of fs.readdirSync(darwinArchDir)) {
        const binPath = path.join(darwinArchDir, fileName);
        if (fs.statSync(binPath).isFile()) {
          fs.chmodSync(binPath, 0o755);
          darwinBinFiles.push(binPath);
        }
      }
    }
  }

  const helperDylibFiles = [];
  if (fs.existsSync(unpackedHelpersDir)) {
    for (const entry of fs.readdirSync(unpackedHelpersDir)) {
      if (!entry.endsWith('.dylib')) continue;
      const dylibPath = path.join(unpackedHelpersDir, entry);
      if (fs.statSync(dylibPath).isFile()) {
        fs.chmodSync(dylibPath, 0o755);
        helperDylibFiles.push(dylibPath);
      }
    }
  }

  // When CSC_LINK is provided, electron-builder performs real Developer ID signing after afterPack;
  // do not overwrite or pre-seal with ad-hoc '-' signatures.
  if (process.env.CSC_LINK) {
    console.log(
      `  • [afterPack] CSC_LINK detected; prepared permissions & xattr for Developer ID signing: ${appPath}`
    );
    return;
  }

  // Note: macOS dyld4 Library Validation (`--options runtime` without `disable-library-validation`)
  // requires a non-empty Apple Developer TeamIdentifier shared between the main binary and
  // `@rpath/Electron Framework.framework`. Ad-hoc (`--sign -`) signatures have no TeamIdentifier,
  // causing dyld4 to abort at launch ("mapping process and mapped file (non-platform) have different Team IDs").
  // Real Developer ID builds (`CSC_LINK` above) receive full `hardenedRuntime: true` from electron-builder,
  // while ad-hoc (`--sign -`) builds omit `--options runtime` unless explicitly overridden.
  const useAdHocHardenedRuntime = process.env.ONE_LAUNCHER_ADHOC_HARDENED_RUNTIME === '1';
  const runtimeArgs = useAdHocHardenedRuntime ? ['--options', 'runtime'] : [];

  console.log(
    `  • [afterPack] Inside-out ad-hoc signing macOS bundle (adHocHardenedRuntime=${useAdHocHardenedRuntime}): ${appPath}`
  );

  // 1. Sign unpacked PyInstaller CLI binaries (gogdl, legendary) with PyInstaller JIT/memory entitlements
  for (const binPath of darwinBinFiles) {
    execFileSync(
      'codesign',
      [
        '--force',
        '--sign',
        '-',
        ...runtimeArgs,
        '--entitlements',
        pyinstallerEntitlementsPath,
        binPath,
      ],
      { stdio: 'inherit' }
    );
  }

  // 2. Sign unpacked macOS helper dylibs (libone_metal_preload.dylib)
  for (const dylibPath of helperDylibFiles) {
    execFileSync('codesign', ['--force', '--sign', '-', ...runtimeArgs, dylibPath], {
      stdio: 'inherit',
    });
  }

  // 3. Sign Contents/Frameworks/*.framework and Contents/Frameworks/*.app strictly inside-out
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  if (fs.existsSync(frameworksDir)) {
    const frameworkEntries = fs.readdirSync(frameworksDir);

    for (const entryName of frameworkEntries) {
      if (!entryName.endsWith('.framework')) continue;
      const frameworkPath = path.join(frameworksDir, entryName);
      const frameworkBaseName = entryName.slice(0, -'.framework'.length);
      const mainFrameworkBinary = path.join(
        frameworkPath,
        'Versions',
        'A',
        frameworkBaseName
      );
      const nestedMachOs = collectNestedMachOFiles(
        path.join(frameworkPath, 'Versions', 'A'),
        new Set([mainFrameworkBinary])
      );
      for (const nestedBin of nestedMachOs) {
        execFileSync('codesign', ['--force', '--sign', '-', ...runtimeArgs, nestedBin], {
          stdio: 'inherit',
        });
      }
      execFileSync('codesign', ['--force', '--sign', '-', ...runtimeArgs, frameworkPath], {
        stdio: 'inherit',
      });
    }

    for (const entryName of frameworkEntries) {
      if (!entryName.endsWith('.app')) continue;
      const helperAppPath = path.join(frameworksDir, entryName);
      const helperBaseName = entryName.slice(0, -'.app'.length);
      const mainHelperBinary = path.join(
        helperAppPath,
        'Contents',
        'MacOS',
        helperBaseName
      );
      const nestedHelperMachOs = collectNestedMachOFiles(
        path.join(helperAppPath, 'Contents'),
        new Set([mainHelperBinary])
      );
      for (const nestedBin of nestedHelperMachOs) {
        execFileSync('codesign', ['--force', '--sign', '-', ...runtimeArgs, nestedBin], {
          stdio: 'inherit',
        });
      }
      execFileSync(
        'codesign',
        [
          '--force',
          '--sign',
          '-',
          ...runtimeArgs,
          '--entitlements',
          macEntitlementsPath,
          helperAppPath,
        ],
        { stdio: 'inherit' }
      );
    }
  }

  // 4. Sign the outer .app bundle WITHOUT --deep so nested PyInstaller & Helper entitlements remain intact
  execFileSync(
    'codesign',
    [
      '--force',
      '--sign',
      '-',
      ...runtimeArgs,
      '--entitlements',
      macEntitlementsPath,
      '--identifier',
      'com.onelauncher.app',
      '-r=designated => identifier "com.onelauncher.app"',
      appPath,
    ],
    { stdio: 'inherit' }
  );

  // 5. Strictly verify the complete bundle hierarchy on disk
  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=1', appPath],
    { stdio: 'inherit' }
  );
  console.log(`  • [afterPack] Verified macOS bundle signature: ${appPath}`);
};

exports._testHelpers = {
  KEEP_CROSSOVER_BRIDGE_DLLS,
  pruneChromiumLocalePaks,
  pruneMacLprojDirs,
  pruneUnpackedCrossOsAssets,
};
