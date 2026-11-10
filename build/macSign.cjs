const path = require('node:path');

const PYINSTALLER_ENTITLEMENTS_PATH = path.join(__dirname, 'entitlements.pyinstaller.plist');
const MAC_ENTITLEMENTS_PATH = path.join(__dirname, 'entitlements.mac.plist');

const PYINSTALLER_DARWIN_BIN_RE =
  /app\.asar\.unpacked[\\/]electron[\\/]bin[\\/][^\\/]+[\\/]darwin[\\/](?:gogdl|legendary)$/i;

/**
 * Determine whether a file inside the `.app` bundle is an unpacked PyInstaller CLI binary
 * (`gogdl` or `legendary`) that extracts and dlopens unsigned Python `.so` extensions at runtime
 * and therefore requires `build/entitlements.pyinstaller.plist` under Hardened Runtime.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isUnpackedPyInstallerCliBinary(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return PYINSTALLER_DARWIN_BIN_RE.test(filePath);
}

/**
 * Build a wrapped `@electron/osx-sign` `optionsForFile` callback that assigns
 * `build/entitlements.pyinstaller.plist` exclusively to unpacked `gogdl`/`legendary` binaries
 * while preserving strict `build/entitlements.mac.plist` (without `disable-library-validation`)
 * on the Electron main process, helper apps, frameworks, and helper dylibs.
 *
 * @param {((filePath: string) => Record<string, any>) | undefined | null} baseOptionsForFile
 * @returns {(filePath: string) => Record<string, any>}
 */
function createPerFileSignOptionsResolver(baseOptionsForFile) {
  return (filePath) => {
    const base =
      typeof baseOptionsForFile === 'function' ? baseOptionsForFile(filePath) || {} : {};
    if (isUnpackedPyInstallerCliBinary(filePath)) {
      return {
        ...base,
        hardenedRuntime: true,
        entitlements: PYINSTALLER_ENTITLEMENTS_PATH,
      };
    }
    return {
      ...base,
      entitlements: base.entitlements || MAC_ENTITLEMENTS_PATH,
    };
  };
}

/**
 * Custom `electron-builder` `mac.sign` hook invoked during Developer ID signing (`CSC_LINK`)
 * BEFORE Apple notarization (`notarizeIfProvided`) runs, ensuring `gogdl` and `legendary` are
 * signed inside-out with `entitlements.pyinstaller.plist` prior to sealing the outer `.app`.
 *
 * @param {Record<string, any>} opts
 */
exports.default = async function customMacSign(opts) {
  const macCodeSign = require('app-builder-lib/out/codeSign/macCodeSign');
  const wrappedOptionsForFile = createPerFileSignOptionsResolver(opts && opts.optionsForFile);
  return macCodeSign.sign({
    ...opts,
    optionsForFile: wrappedOptionsForFile,
  });
};

exports._testHelpers = {
  PYINSTALLER_ENTITLEMENTS_PATH,
  MAC_ENTITLEMENTS_PATH,
  isUnpackedPyInstallerCliBinary,
  createPerFileSignOptionsResolver,
};
