import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const nodeRequire = createRequire(import.meta.url);
const securityUtils = nodeRequire('../electron/launcher/securityAndPathUtils.cjs');
const uninstallSafety = nodeRequire('../electron/launcher/uninstallSafety.cjs');

function makeTempDir(prefix = 'adversarial-m3-'): string {
  const tmp = path.join(
    os.tmpdir(),
    `${prefix}${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  );
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return tmp;
}

describe('Milestone M3 Adversarial Challenge — Security & Path Sanitization Stress Harness', () => {

  // ==========================================================================
  // Area 1: buildSafeChildEnvironment (Ambient Variable Fuzzing & Injection)
  // ==========================================================================
  describe('Area 1: buildSafeChildEnvironment Fuzzing & Injection Resistance', () => {
    it('strips all 15 dangerous loader, linker, and runtime injection variables across arbitrary casings in baseEnv', () => {
      const dangerousKeys = [
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'LD_AUDIT',
        'DYLD_INSERT_LIBRARIES',
        'DYLD_LIBRARY_PATH',
        'DYLD_FRAMEWORK_PATH',
        'DYLD_FALLBACK_LIBRARY_PATH',
        'DYLD_FORCE_FLAT_NAMESPACE',
        'NODE_OPTIONS',
        'ELECTRON_RUN_AS_NODE',
        'PYTHONHOME',
        'PYTHONPATH',
        'PYTHONSTARTUP',
        'BASH_ENV',
        'CX_ENV',
      ];

      const ambientFuzz: Record<string, string> = {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/testuser',
        SAFE_CUSTOM_VAR: 'game_value_123',
      };

      // Populate uppercase, lowercase, and mixed-case variants
      for (const k of dangerousKeys) {
        ambientFuzz[k] = `/opt/hostile/${k.toLowerCase()}`;
        ambientFuzz[k.toLowerCase()] = `/opt/hostile/${k.toLowerCase()}_lower`;
        ambientFuzz[
          k.charAt(0).toUpperCase() + k.slice(1).toLowerCase()
        ] = `/opt/hostile/${k.toLowerCase()}_title`;
      }

      const safeEnv = securityUtils.buildSafeChildEnvironment(ambientFuzz, {});

      // Verify no variant of dangerous keys survives in child environment
      const survivingKeys = Object.keys(safeEnv).map((k) => k.toUpperCase());
      for (const k of dangerousKeys) {
        expect(survivingKeys).not.toContain(k);
      }

      // Verify legitimate environment variables are preserved
      expect(safeEnv.PATH).toBe('/usr/bin:/bin');
      expect(safeEnv.HOME).toBe('/Users/testuser');
      expect(safeEnv.SAFE_CUSTOM_VAR).toBe('game_value_123');
    });

    it('strips whitespace-padded, null-byte injected, and equals-sign embedded environment keys', () => {
      const hostileKeys = {
        '  LD_PRELOAD  ': '/tmp/evil.so',
        '\t\nNODE_OPTIONS\r\n': '--inspect=0.0.0.0:9229',
        'DYLD_INSERT_LIBRARIES\0': '/tmp/evil.dylib',
        'LD_PRELOAD=/tmp/evil.so': 'val',
        '': 'empty_key',
        '   ': 'spaces_key',
        BENIGN_KEY: 'safe_val',
      };

      const safeEnv = securityUtils.buildSafeChildEnvironment(hostileKeys, {});
      expect(Object.keys(safeEnv)).toEqual(['BENIGN_KEY']);
      expect(safeEnv.BENIGN_KEY).toBe('safe_val');
    });

    it('neutralizes prototype pollution payloads in baseEnv, userEnvMap, and approvalCtx', () => {
      const maliciousBase = JSON.parse(
        '{"__proto__": {"pollutedBase": "yes"}, "constructor": "evilBase", "prototype": "evilBase", "PATH": "/usr/bin"}'
      );
      const maliciousUser = JSON.parse(
        '{"__proto__": {"pollutedUser": "yes"}, "constructor": "evilUser", "prototype": "evilUser", "GAME_SETTING": "ultra"}'
      );

      const safeEnv = securityUtils.buildSafeChildEnvironment(maliciousBase, maliciousUser);

      // Verify prototype is not polluted
      expect((Object.prototype as any).pollutedBase).toBeUndefined();
      expect((Object.prototype as any).pollutedUser).toBeUndefined();
      expect(safeEnv.pollutedBase).toBeUndefined();
      expect(safeEnv.pollutedUser).toBeUndefined();
      expect(safeEnv.constructor).not.toBe('evilBase');
      expect(safeEnv.constructor).not.toBe('evilUser');
      expect(safeEnv.PATH).toBe('/usr/bin');
      expect(safeEnv.GAME_SETTING).toBe('ultra');
    });

    it('coerces and sanitizes diverse data types in baseEnv and userEnvMap without crashing', () => {
      const typeFuzzBase: any = {
        NUMERIC_PORT: 8080,
        BOOLEAN_FLAG: true,
        ARRAY_VAL: ['drop', 'me'],
        OBJ_VAL: { nested: 'drop' },
        FUNC_VAL: () => 'drop',
        NULL_VAL: null,
        UNDEF_VAL: undefined,
        STRING_VAL: 'valid_string',
      };

      const typeFuzzUser: any = {
        USER_NUM: 42,
        USER_BOOL: false,
        USER_OBJ: { a: 1 },
        USER_STR: 'user_string',
      };

      const safeEnv = securityUtils.buildSafeChildEnvironment(typeFuzzBase, typeFuzzUser);

      expect(safeEnv.NUMERIC_PORT).toBe('8080');
      expect(safeEnv.BOOLEAN_FLAG).toBe('true');
      expect(safeEnv.ARRAY_VAL).toBeUndefined();
      expect(safeEnv.OBJ_VAL).toBeUndefined();
      expect(safeEnv.FUNC_VAL).toBeUndefined();
      expect(safeEnv.NULL_VAL).toBeUndefined();
      expect(safeEnv.UNDEF_VAL).toBeUndefined();
      expect(safeEnv.STRING_VAL).toBe('valid_string');
      expect(safeEnv.USER_NUM).toBe('42');
      expect(safeEnv.USER_BOOL).toBe('false');
      expect(safeEnv.USER_OBJ).toBeUndefined();
      expect(safeEnv.USER_STR).toBe('user_string');
    });

    it('strictly isolates unapproved DYLD_INSERT_LIBRARIES while allowing verified cryptographic fingerprints', () => {
      const tmpUserDir = makeTempDir('adv-dyld-approval-');
      try {
        const gameId = 'game_456';
        const targetDylib = '/Users/testuser/Games/MyGame/mod_hook.dylib';
        const cleanFp = securityUtils.computeLaunchEnvApprovalFingerprint(
          'DYLD_INSERT_LIBRARIES',
          targetDylib
        );

        // 1. Unapproved attempt: should be stripped
        const unapproved = securityUtils.buildSafeChildEnvironment(
          {},
          { DYLD_INSERT_LIBRARIES: targetDylib },
          {},
          { gameId, options: { userDataDir: tmpUserDir } }
        );
        expect(unapproved.DYLD_INSERT_LIBRARIES).toBeUndefined();

        // 2. Tampered approval record: should be stripped
        securityUtils.approveLaunchCommands(
          gameId,
          [{ field: 'DYLD_INSERT_LIBRARIES', fingerprint: 'wrong_tampered_fp' }],
          { userDataDir: tmpUserDir }
        );
        const tampered = securityUtils.buildSafeChildEnvironment(
          {},
          { DYLD_INSERT_LIBRARIES: targetDylib },
          {},
          { gameId, options: { userDataDir: tmpUserDir } }
        );
        expect(tampered.DYLD_INSERT_LIBRARIES).toBeUndefined();

        // 3. Legitimate approval registered: permitted
        securityUtils.approveLaunchCommands(
          gameId,
          [{ field: 'DYLD_INSERT_LIBRARIES', fingerprint: cleanFp }],
          { userDataDir: tmpUserDir }
        );
        const approved = securityUtils.buildSafeChildEnvironment(
          {},
          { DYLD_INSERT_LIBRARIES: targetDylib },
          {},
          { gameId, options: { userDataDir: tmpUserDir } }
        );
        expect(approved.DYLD_INSERT_LIBRARIES).toBe(targetDylib);

        // 4. Verify that ambient baseEnv CANNOT bypass approval even when gameId matches
        const ambientAttempt = securityUtils.buildSafeChildEnvironment(
          { DYLD_INSERT_LIBRARIES: targetDylib },
          {},
          {},
          { gameId, options: { userDataDir: tmpUserDir } }
        );
        expect(ambientAttempt.DYLD_INSERT_LIBRARIES).toBeUndefined();
      } finally {
        fs.rmSync(tmpUserDir, { recursive: true, force: true });
      }
    });

    it('preserves trusted internalOverrides and enforces proper layer precedence (baseEnv < userEnvMap < internalOverrides)', () => {
      const baseEnv = { SHARED_VAR: 'base_value', BASE_ONLY: 'base' };
      const userEnv = { SHARED_VAR: 'user_value', USER_ONLY: 'user' };
      const internalOverrides = {
        SHARED_VAR: 'override_value',
        ONE_LAUNCHER_INTERNAL: '1',
      };

      const result = securityUtils.buildSafeChildEnvironment(
        baseEnv,
        userEnv,
        internalOverrides
      );

      expect(result.SHARED_VAR).toBe('override_value');
      expect(result.BASE_ONLY).toBe('base');
      expect(result.USER_ONLY).toBe('user');
      expect(result.ONE_LAUNCHER_INTERNAL).toBe('1');
    });
  });

  // ==========================================================================
  // Area 2: isSafeToDeleteInstallPath (Path Traversal, Symlinks, Roots)
  // ==========================================================================
  describe('Area 2: isSafeToDeleteInstallPath Path Traversal & Containment Torture', () => {
    it('strictly fails closed on all libraryRoot self-deletion permutations across Windows and POSIX', () => {
      const winLib = 'C:\\Games\\OneLauncher';
      const winPermutations = [
        'C:\\Games\\OneLauncher',
        'C:\\Games\\OneLauncher\\',
        'C:\\Games\\OneLauncher\\.',
        'C:\\Games\\OneLauncher\\Sub\\..',
        'c:\\games\\onelauncher',
        '\\\\?\\C:\\Games\\OneLauncher',
        '\\\\.\\C:\\Games\\OneLauncher',
        'C:/Games/OneLauncher',
        'C:/Games/OneLauncher/',
        'C:\\Games\\OneLauncher\\.\\',
        'C:\\Games\\OneLauncher\\Sub\\..\\',
      ];

      for (const perm of winPermutations) {
        const isSafe = uninstallSafety.isSafeToDeleteInstallPath(perm, {
          libraryRoot: winLib,
          platform: 'win32',
        });
        expect(isSafe, `Expected ${perm} to be strictly blocked when libraryRoot=${winLib}`).toBe(false);
      }

      const posixLib = '/Users/testuser/Games/OneLauncher';
      const posixPermutations = [
        '/Users/testuser/Games/OneLauncher',
        '/Users/testuser/Games/OneLauncher/',
        '/Users/testuser/Games/OneLauncher/.',
        '/Users/testuser/Games/OneLauncher/Sub/..',
        '/Users/testuser/Games/OneLauncher/Sub/../',
        '/Users/testuser/Games/OneLauncher/./',
      ];

      for (const perm of posixPermutations) {
        const isSafe = uninstallSafety.isSafeToDeleteInstallPath(perm, {
          libraryRoot: posixLib,
          platform: 'darwin',
        });
        expect(isSafe, `Expected ${perm} to be strictly blocked when libraryRoot=${posixLib}`).toBe(false);
      }

      // Valid nested subfolder should be allowed
      expect(
        uninstallSafety.isSafeToDeleteInstallPath('C:\\Games\\OneLauncher\\DoomEternal', {
          libraryRoot: winLib,
          platform: 'win32',
        })
      ).toBe(true);
      expect(
        uninstallSafety.isSafeToDeleteInstallPath('/Users/testuser/Games/OneLauncher/DoomEternal', {
          libraryRoot: posixLib,
          platform: 'darwin',
        })
      ).toBe(true);
    });

    it('strictly blocks Windows drive letter mismatches, UNC cross-host/cross-share attacks, and UNC roots', () => {
      const missingFsImpl = {
        existsSync: () => false,
        lstatSync: () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        realpathSync: (p: string) => p,
      };
      const winOpts = { platform: 'win32', fsImpl: missingFsImpl };

      // Drive mismatches
      expect(
        uninstallSafety.isSafeToDeleteInstallPath('D:\\Games\\Title', {
          ...winOpts,
          libraryRoot: 'C:\\Games',
        })
      ).toBe(false);
      expect(
        uninstallSafety.isSafeToDeleteInstallPath('C:\\Games\\Title', {
          ...winOpts,
          libraryRoot: 'D:\\Games',
        })
      ).toBe(false);
      expect(
        uninstallSafety.isSafeToDeleteInstallPath('E:\\SteamLibrary\\steamapps\\common\\Game', {
          ...winOpts,
          libraryRoot: 'D:\\SteamLibrary',
        })
      ).toBe(false);

      // UNC paths
      expect(uninstallSafety.isSafeToDeleteInstallPath('\\\\nas\\share', winOpts)).toBe(false);
      expect(uninstallSafety.isSafeToDeleteInstallPath('\\\\nas\\share\\games', winOpts)).toBe(false);
      expect(
        uninstallSafety.isSafeToDeleteInstallPath('\\\\nas\\share\\games', {
          ...winOpts,
          libraryRoot: '\\\\nas\\share\\games',
        })
      ).toBe(false);
      expect(
        uninstallSafety.isSafeToDeleteInstallPath('\\\\nas2\\share\\games\\mygame', {
          ...winOpts,
          libraryRoot: '\\\\nas\\share\\games',
        })
      ).toBe(false);
      expect(
        uninstallSafety.isSafeToDeleteInstallPath('\\\\nas\\other_share\\games\\mygame', {
          ...winOpts,
          libraryRoot: '\\\\nas\\share\\games',
        })
      ).toBe(false);

      // Valid UNC subfolder inside UNC libraryRoot
      expect(
        uninstallSafety.isSafeToDeleteInstallPath('\\\\nas\\share\\games\\mygame', {
          ...winOpts,
          libraryRoot: '\\\\nas\\share\\games',
        })
      ).toBe(true);
    });

    it('blocks directory traversals into protected user trees and system directories', () => {
      const traversals = [
        ['C:\\Games\\OneLauncher\\..\\..\\Windows', { platform: 'win32' }],
        ['C:\\Games\\OneLauncher\\..\\..\\Users\\Alice\\Documents', { platform: 'win32' }],
        ['C:\\Games\\MyGame\\..\\..\\..\\..\\Windows\\System32', { platform: 'win32' }],
        ['/Users/testuser/Games/../../System', { platform: 'darwin' }],
        ['/Users/testuser/Games/../../../etc/passwd', { platform: 'darwin' }],
        ['/Users/testuser/Games/MyGame/../../../../', { platform: 'darwin' }],
        ['C:/Games/MyGame/../../Windows', { platform: 'win32' }],
        ['C:\\Games/MyGame/..\\../Windows', { platform: 'win32' }],
      ];

      for (const [p, opts] of traversals) {
        expect(
          uninstallSafety.isSafeToDeleteInstallPath(p, opts),
          `Expected traversal path ${p} to fail closed`
        ).toBe(false);
      }
    });

    it('empirically tortures real filesystem symlinks on disk: target symlinks, root escapes, homedir escapes, dangling links, and circular ELOOP', () => {
      const tempBase = makeTempDir('adv-symlink-torture-');
      const libraryRoot = path.join(tempBase, 'Games');
      fs.mkdirSync(libraryRoot, { recursive: true });

      const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir';
      const tryCreateNonJunctionSymlink = (target: string, linkPath: string): boolean => {
        try {
          fs.symlinkSync(target, linkPath);
          return true;
        } catch (err: unknown) {
          if (
            process.platform === 'win32' &&
            (err as { code?: string })?.code === 'EPERM'
          ) {
            return false;
          }
          throw err;
        }
      };

      try {
        // 1. Target path itself is a symbolic link / junction
        const realGame = path.join(libraryRoot, 'RealGame');
        fs.mkdirSync(realGame, { recursive: true });
        const symlinkGame = path.join(libraryRoot, 'SymlinkGame');
        fs.symlinkSync(realGame, symlinkGame, dirLinkType);
        expect(
          uninstallSafety.isSafeToDeleteInstallPath(symlinkGame, {
            libraryRoot,
            platform: process.platform,
          })
        ).toBe(false);

        // 2. Symlink / junction inside game directory pointing to OS root
        const escapeRootGame = path.join(libraryRoot, 'EscapeRootGame');
        fs.mkdirSync(escapeRootGame, { recursive: true });
        fs.symlinkSync(
          process.platform === 'win32' ? path.parse(tempBase).root : '/',
          path.join(escapeRootGame, 'root_link'),
          dirLinkType
        );
        expect(
          uninstallSafety.isSafeToDeleteInstallPath(escapeRootGame, {
            libraryRoot,
            platform: process.platform,
          })
        ).toBe(false);

        // 3. Symlink / junction inside game directory pointing to user homedir
        const escapeHomeGame = path.join(libraryRoot, 'EscapeHomeGame');
        fs.mkdirSync(escapeHomeGame, { recursive: true });
        fs.symlinkSync(os.homedir(), path.join(escapeHomeGame, 'home_link'), dirLinkType);
        expect(
          uninstallSafety.isSafeToDeleteInstallPath(escapeHomeGame, {
            libraryRoot,
            platform: process.platform,
          })
        ).toBe(false);

        // 4. Dangling symlink pointing outside install root
        const danglingGame = path.join(libraryRoot, 'DanglingGame');
        fs.mkdirSync(danglingGame, { recursive: true });
        if (
          tryCreateNonJunctionSymlink(
            path.join(tempBase, 'nonexistent_outside_target'),
            path.join(danglingGame, 'dangling_link')
          )
        ) {
          expect(
            uninstallSafety.isSafeToDeleteInstallPath(danglingGame, {
              libraryRoot,
              platform: process.platform,
            })
          ).toBe(false);
        }

        // 5. Circular symlinks triggering ELOOP
        const circularGame = path.join(libraryRoot, 'CircularGame');
        fs.mkdirSync(circularGame, { recursive: true });
        const c1 = path.join(circularGame, 'link1');
        const c2 = path.join(circularGame, 'link2');
        if (tryCreateNonJunctionSymlink(c2, c1) && tryCreateNonJunctionSymlink(c1, c2)) {
          expect(
            uninstallSafety.isSafeToDeleteInstallPath(circularGame, {
              libraryRoot,
              platform: process.platform,
            })
          ).toBe(false);
        }

        // 6. Legitimate INTERNAL symlink / junction pointing inside install directory
        const legitGame = path.join(libraryRoot, 'LegitGame');
        const legitInternalSubdir = path.join(legitGame, 'internal_assets');
        fs.mkdirSync(legitInternalSubdir, { recursive: true });
        const dataFile = path.join(legitInternalSubdir, 'data.bin');
        fs.writeFileSync(dataFile, 'content');
        fs.symlinkSync(legitInternalSubdir, path.join(legitGame, 'assets_link'), dirLinkType);
        expect(
          uninstallSafety.isSafeToDeleteInstallPath(legitGame, {
            libraryRoot,
            platform: process.platform,
          })
        ).toBe(true);
      } finally {
        fs.rmSync(tempBase, { recursive: true, force: true });
      }
    });

    it('empirically blocks all 5 multi-game container sentinels on disk', () => {
      const tempBase = makeTempDir('adv-sentinels-');
      const libraryRoot = path.join(tempBase, 'Games');
      fs.mkdirSync(libraryRoot, { recursive: true });

      try {
        const sentinels = [
          '.GamingRoot',
          'libraryfolders.vdf',
          'cxbottle.conf',
          'drive_c/windows',
          'steamapps',
        ];

        for (const sentinel of sentinels) {
          const gameDir = path.join(
            libraryRoot,
            `GameSentinel_${sentinel.replace(/[\/.]/g, '_')}`
          );
          fs.mkdirSync(gameDir, { recursive: true });
          if (sentinel.includes('/')) {
            const parts = sentinel.split('/');
            fs.mkdirSync(path.join(gameDir, parts[0]), { recursive: true });
            fs.writeFileSync(path.join(gameDir, ...parts), 'sentinel_marker');
          } else {
            fs.writeFileSync(path.join(gameDir, sentinel), 'sentinel_marker');
          }

          expect(
            uninstallSafety.isSafeToDeleteInstallPath(gameDir, {
              libraryRoot,
              platform: process.platform,
            }),
            `Sentinel ${sentinel} must fail closed`
          ).toBe(false);
        }
      } finally {
        fs.rmSync(tempBase, { recursive: true, force: true });
      }
    });
  });

  // ==========================================================================
  // Area 3: wrapIpcMainWithSenderCheck (handle, handleOnce & Re-wrapping)
  // ==========================================================================
  describe('Area 3: wrapIpcMainWithSenderCheck Verification & Torture', () => {
    it('verifies handleOnce rejects untrusted subframes, remote origins, and mismatched windows', () => {
      const handlers: Record<string, Function> = {};
      const fakeIpcMain = {
        handle: (ch: string, fn: Function) => {
          handlers[ch] = fn;
        },
        handleOnce: (ch: string, fn: Function) => {
          handlers[ch] = fn;
        },
      };

      const mockMainWindow = {
        isDestroyed: () => false,
        webContents: { id: 1 },
      };

      const wrapped = securityUtils.wrapIpcMainWithSenderCheck(fakeIpcMain, {
        isPackaged: false,
        allowedDevOrigin: 'http://localhost:5173',
        getMainWindow: () => mockMainWindow,
      });

      wrapped.handleOnce('test:single-invoke', (_event: any, arg: string) => `echo:${arg}`);
      const handlerFn = handlers['test:single-invoke'];
      expect(typeof handlerFn).toBe('function');

      // 1. Untrusted subframe (iframe)
      const subframeEvent = {
        senderFrame: {
          url: 'http://localhost:5173/embed',
          parent: {}, // Non-top-level iframe
        },
        sender: {
          mainFrame: { url: 'http://localhost:5173/main' },
          id: 1,
        },
      };
      let caughtErr1: any = null;
      try {
        handlerFn(subframeEvent, 'test');
      } catch (err: any) {
        caughtErr1 = err;
      }
      expect(caughtErr1).not.toBeNull();
      expect(caughtErr1.code).toBe('ERR_UNTRUSTED_IPC_SENDER');
      expect(caughtErr1.message).toContain('Blocked IPC invocation from untrusted sender frame');

      // 2. Untrusted remote origin
      const remoteEvent = {
        senderFrame: {
          url: 'https://evil.attacker.com',
          parent: null,
        },
        sender: {
          mainFrame: { url: 'https://evil.attacker.com' },
          id: 1,
        },
      };
      let caughtErr2: any = null;
      try {
        handlerFn(remoteEvent, 'test');
      } catch (err: any) {
        caughtErr2 = err;
      }
      expect(caughtErr2).not.toBeNull();
      expect(caughtErr2.code).toBe('ERR_UNTRUSTED_IPC_SENDER');

      // 3. Mismatched window ID
      const wrongWindowEvent = {
        senderFrame: {
          url: 'http://localhost:5173/main',
          parent: null,
        },
        sender: {
          mainFrame: { url: 'http://localhost:5173/main' },
          id: 999, // Unrelated window
        },
      };
      let caughtErr3: any = null;
      try {
        handlerFn(wrongWindowEvent, 'test');
      } catch (err: any) {
        caughtErr3 = err;
      }
      expect(caughtErr3).not.toBeNull();
      expect(caughtErr3.code).toBe('ERR_UNTRUSTED_IPC_SENDER');

      // 4. Packaged application rejects HTTP dev origin on handleOnce
      const topMainFrame = { url: 'http://localhost:5173/main', parent: null };
      const fakePackagedIpcMain = {
        handle: (ch: string, fn: Function) => {
          handlers[ch] = fn;
        },
        handleOnce: (ch: string, fn: Function) => {
          handlers[ch] = fn;
        },
      };
      const packagedWrapped = securityUtils.wrapIpcMainWithSenderCheck(fakePackagedIpcMain, {
        isPackaged: true,
      });
      packagedWrapped.handleOnce('test:packaged-rejection', () => 'ok');
      let caughtErr4: any = null;
      try {
        handlers['test:packaged-rejection']({
          senderFrame: topMainFrame,
          sender: { mainFrame: topMainFrame, id: 1 },
        });
      } catch (err: any) {
        caughtErr4 = err;
      }
      expect(caughtErr4).not.toBeNull();
      expect(caughtErr4.code).toBe('ERR_UNTRUSTED_IPC_SENDER');

      // 5. Valid top-level frame invocation succeeds
      const result = handlerFn({
        senderFrame: topMainFrame,
        sender: { mainFrame: topMainFrame, id: 1 },
      }, 'hello');
      expect(result).toBe('echo:hello');
    });

    it('enforces re-wrapping idempotence and zero proxy layering across 1,000 iterations', () => {
      const fakeIpcMain = {
        handle: vi.fn(),
        handleOnce: vi.fn(),
        removeHandler: vi.fn(),
        on: vi.fn(),
        emit: vi.fn(),
        removeAllListeners: vi.fn(),
      };

      const wrap1 = securityUtils.wrapIpcMainWithSenderCheck(fakeIpcMain);
      const wrap2 = securityUtils.wrapIpcMainWithSenderCheck(wrap1);
      expect(wrap1).toBe(wrap2);
      expect(wrap1.__isIpcSenderCheckWrapped).toBe(true);

      // Loop 1,000 times to verify no proxy nesting or memory leaks
      let current = wrap1;
      for (let i = 0; i < 1000; i++) {
        current = securityUtils.wrapIpcMainWithSenderCheck(current);
      }
      expect(current).toBe(wrap1);

      // Verify non-object and partial inputs fail gracefully
      expect(securityUtils.wrapIpcMainWithSenderCheck(null)).toBeNull();
      expect(securityUtils.wrapIpcMainWithSenderCheck(undefined)).toBeUndefined();
      const emptyObj = {};
      expect(securityUtils.wrapIpcMainWithSenderCheck(emptyObj)).toBe(emptyObj);
    });

    it('preserves native ipcMain methods and ensures correct this binding', () => {
      let thisContext: any = null;
      const targetIpcMain = {
        _secret: 42,
        handle: vi.fn(),
        handleOnce: vi.fn(),
        customMethod() {
          thisContext = this;
          return this._secret;
        },
      };

      const wrapped = securityUtils.wrapIpcMainWithSenderCheck(targetIpcMain);
      const res = wrapped.customMethod();

      expect(res).toBe(42);
      expect(thisContext).toBe(targetIpcMain);
    });
  });
});
