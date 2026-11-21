import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import axios from 'axios';
import ts from 'typescript';
import { OfflineNetworkGuardError } from './setup/offlineNetworkGuard';
import { KNOWN_GAME_PATCHES } from '../src/services/integrations/catalogSanitizer';
import { CRITIC_STORAGE_PREFIX } from '../src/contracts/critic';
import { activeGameFilterToLibraryFilterState } from '../src/contracts/filter';
import { resolveHostArch } from '../src/contracts/hostPlatform';
import * as tsConfigSanitizers from '../src/contracts/launchConfigSanitizers';
import * as tsEnvironmentCatalog from '../src/contracts/environmentCatalog';
import * as tsLaunchPolicyResolver from '../src/contracts/launchPolicyResolver';
import {
  loadLocalKeyedHmacConfig,
  scanContentForPiiViolations,
  scanRepoForPiiViolations,
  scanWorkspaceRootForPollutedEntries,
} from './helpers/piiHygieneGuard';

const nodeRequire = createRequire(import.meta.url);

const REPO_ROOT = path.resolve(__dirname, '..');

function walkTextFiles(targetPath: string, exts: RegExp, acc: string[] = []): string[] {
  if (!fs.existsSync(targetPath)) return acc;
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    if (exts.test(targetPath)) acc.push(targetPath);
    return acc;
  }
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === '.git' ||
      entry.name === 'release'
    ) {
      continue;
    }
    const full = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      walkTextFiles(full, exts, acc);
    } else if (entry.isFile() && exts.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe('Static Architecture, Privacy Hygiene & Offline Guard Invariants', () => {
  let cjsFiles: string[] = [];
  let sharedCjsProgram: ts.Program;

  beforeAll(() => {
    cjsFiles = walkTextFiles(path.join(REPO_ROOT, 'electron'), /\.cjs$/i);
    sharedCjsProgram = ts.createProgram(cjsFiles, {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      types: ['node'],
    });
  }, 30000);

  it('1. Zero-PII & Universal Portability Gate: confirms zero personal paths, personal identifiers, personal dumps, or per-game hacks across repo', () => {
    // Structural scripts/ hygiene: only Node build/verification scripts belong in scripts/ (zero raw JSON/TXT/PDF/VDF/Python dumps)
    const unexpectedScriptDumps = walkTextFiles(
      path.join(REPO_ROOT, 'scripts'),
      /\.(?:json|txt|pdf|vdf|py|sh)$/i
    ).map((file) => path.relative(REPO_ROOT, file));
    expect(unexpectedScriptDumps).toEqual([]);

    const scanTargets = [
      'electron',
      'src',
      'build',
      'public',
      'scripts',
      'tests',
      'package.json',
      'README.md',
      'index.html',
      'vite.config.ts',
      'vitest.config.ts',
      'vitest.live.config.ts',
    ];
    const extRegex = /\.(?:cjs|mjs|js|ts|tsx|json|html|css|md|nsh|nsi|ps1|bat|py|c|h)$/i;
    const violations = scanRepoForPiiViolations(REPO_ROOT, scanTargets, extRegex);
    expect(violations).toEqual([]);

    // Workspace root must contain zero polluted backslash or Windows drive-letter entries
    expect(scanWorkspaceRootForPollutedEntries(REPO_ROOT)).toEqual([]);

    // Structural Clean-Sheet Sanitizer Gate: KNOWN_GAME_PATCHES is empty and contains no game-specific lore tokens
    expect(KNOWN_GAME_PATCHES).toEqual({});
    const catalogSanitizerSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/services/integrations/catalogSanitizer.ts'),
      'utf8'
    );
    expect(catalogSanitizerSource).toMatch(
      /export\s+const\s+KNOWN_GAME_PATCHES\s*:\s*Record<string,\s*(?:Partial<CanonicalGame>|CatalogGamePatch)>\s*=\s*\{\s*\}\s*;/
    );
    expect(catalogSanitizerSource).not.toContain('SHODAN');
    expect(catalogSanitizerSource).not.toContain('RAPTURE');
  });

  it('1b. Zero-Oracle PII Hygiene Guard Self-Test: detects structural storefront IDs, personal paths, webmail, hardcoded Bearer tokens, polluted root entries, and optional local HMAC-SHA256', () => {
    const dynSteamReal = ['7656119', '8123498765'].join('');
    const dynSteamSynth = ['7656119', '8000000042'].join('');
    const dynGogReal = ['4968', '9988776655443'].join('');
    const dynEpicReal = `account_id: '${['9f8e7d6c', '5b4a3928', '17263544', '99887766'].join('')}'`;
    const dynEpicSynth = `account_id: '${'0'.repeat(30)}42'`;
    const dynAppNameHex = `app_name: '${['9f8e7d6c', '5b4a3928', '17263544', '99887766'].join('')}'`;
    const dynSteam3 = ['[U:1:', '65432109', ']'].join('');
    const dynUserdata = ['Steam', 'userdata', '87654321', 'config'].join('/');
    const dynMacHome = ['', 'Users', 'realperson', 'Library'].join('/');
    const dynLinuxHome = ['', 'home', 'realperson', '.local'].join('/');
    const dynWinHome = ['C:', 'Users', 'realperson', 'AppData'].join('\\');
    const dynVarFolders = ['var', 'folders', 'ab', 'cd1234567890efgh', 'T'].join('/');
    const dynEmail = ['person', ['gmail', 'com'].join('.')].join('@');
    const dynProton = ['person', ['proton', 'me'].join('.')].join('@');
    const dynBearer = ['Bearer ', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5'].join('');

    expect(scanContentForPiiViolations(dynSteamReal, 'tests/sample.ts')).toHaveLength(1);
    expect(scanContentForPiiViolations(dynSteamSynth, 'tests/sample.ts')).toEqual([]);
    expect(scanContentForPiiViolations(dynGogReal, 'tests/sample.ts')).toHaveLength(1);
    expect(scanContentForPiiViolations(dynEpicReal, 'tests/sample.ts')).toHaveLength(1);
    expect(scanContentForPiiViolations(dynEpicSynth, 'tests/sample.ts')).toEqual([]);
    expect(scanContentForPiiViolations(dynAppNameHex, 'tests/sample.ts')).toEqual([]);
    expect(scanContentForPiiViolations(dynSteam3, 'tests/sample.ts')).toHaveLength(1);
    expect(scanContentForPiiViolations(dynUserdata, 'tests/sample.ts')).toHaveLength(1);
    expect(scanContentForPiiViolations(dynMacHome, 'tests/sample.ts')).toHaveLength(1);
    expect(scanContentForPiiViolations(dynLinuxHome, 'tests/sample.ts')).toHaveLength(1);
    expect(scanContentForPiiViolations(dynWinHome, 'tests/sample.ts')).toHaveLength(1);
    expect(scanContentForPiiViolations(dynVarFolders, 'tests/sample.ts')).toHaveLength(1);
    expect(scanContentForPiiViolations(dynEmail, 'tests/sample.ts')).toHaveLength(1);
    expect(scanContentForPiiViolations(dynProton, 'tests/sample.ts')).toHaveLength(1);
    expect(scanContentForPiiViolations(dynBearer, 'src/service.ts')).toHaveLength(1);
    expect(scanContentForPiiViolations(dynBearer, 'tests/service.test.ts')).toEqual([]);

    // Verify optional local keyed HMAC-SHA256 guard + polluted root scanner in ephemeral temp dir
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-pii-guard-test-'));
    try {
      fs.writeFileSync(path.join(tmpRoot, 'clean.txt'), 'ok', 'utf8');
      if (process.platform !== 'win32') {
        fs.mkdirSync(path.join(tmpRoot, 'C:\\PollutedDir'));
        fs.mkdirSync(path.join(tmpRoot, '\\var\\folders\\polluted'));
        expect(scanWorkspaceRootForPollutedEntries(tmpRoot).sort()).toEqual([
          'C:\\PollutedDir',
          '\\var\\folders\\polluted',
        ]);
      } else {
        expect(scanWorkspaceRootForPollutedEntries(tmpRoot)).toEqual([]);
      }
      expect(
        scanWorkspaceRootForPollutedEntries(tmpRoot, [
          'C:\\PollutedDir',
          '\\var\\folders\\polluted',
          'clean.txt',
        ]).sort()
      ).toEqual(['C:\\PollutedDir', '\\var\\folders\\polluted']);

      const testKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const secretHandle = 'ephemeral_local_handle_99';
      const expectedTag = crypto
        .createHmac('sha256', Buffer.from(testKeyHex, 'hex'))
        .update(secretHandle)
        .digest('hex');
      const hmacCfg = loadLocalKeyedHmacConfig(tmpRoot, {
        ONE_LAUNCHER_PII_HMAC_KEY: testKeyHex,
        ONE_LAUNCHER_PII_HMAC_TAGS: expectedTag,
      });
      expect(hmacCfg).not.toBeNull();
      expect(
        scanContentForPiiViolations(`owner=${secretHandle}`, 'src/app.ts', hmacCfg)
      ).toHaveLength(1);
      expect(
        scanContentForPiiViolations('owner=public_synthetic_user', 'src/app.ts', hmacCfg)
      ).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('2. Discontinued Compatibility Layer Gate: confirms README.md and src/contracts/launcher.ts omit discontinued Whisky references', () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const launcherContract = fs.readFileSync(
      path.join(REPO_ROOT, 'src/contracts/launcher.ts'),
      'utf8'
    );
    expect(readme.toLowerCase()).not.toContain('whisky');
    expect(launcherContract.toLowerCase()).not.toContain('whisky');
  });

  it('3. Stylesheet Compositor & Selector Invariants: verifies src/index.css avoids fixed background repaints and keeps vendor pseudo-elements split', () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, 'src/index.css'), 'utf8');

    expect(css).not.toMatch(/background-attachment\s*:\s*fixed/i);
    expect(css).toContain('.app-drag-region');
    expect(css).toContain('.modal-scroll-body');
    expect(css).toContain('.cv-card-deferred');
    expect(css).toContain('.dual-range-input::-webkit-slider-thumb');
    expect(css).toContain('.dual-range-input::-moz-range-thumb');
    // Vendor slider pseudo-elements must never be comma-combined in a single selector list
    expect(css).not.toMatch(/::-webkit-slider-thumb\s*,\s*[^{]*::-moz-range-thumb/);
  });

  it('4. Windows NSIS String Length & Upgrade Safety Gate: verifies deleteAppDataOnUninstall === false and nsExec lines stay well below NSIS_MAX_STRLEN', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.build?.nsis?.deleteAppDataOnUninstall).toBe(false);

    const nsisFiles = walkTextFiles(path.join(REPO_ROOT, 'build'), /\.(?:nsh|nsi)$/i);
    expect(nsisFiles.length).toBeGreaterThanOrEqual(2);

    for (const nsisFile of nsisFiles) {
      const lines = fs.readFileSync(nsisFile, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        if (line.includes('nsExec::')) {
          expect(
            Buffer.byteLength(line, 'utf8'),
            `nsExec line in ${path.basename(nsisFile)} exceeds safe NSIS_MAX_STRLEN threshold`
          ).toBeLessThan(2048);
        }
      }
    }
  });

  it('5. Global Offline Network Guard Self-Test: blocks unmocked external fetch, axios, and node:https requests while permitting loopback 127.0.0.1', async () => {
    await expect(fetch('https://unmocked-domain.example.invalid/ping')).rejects.toThrow(
      OfflineNetworkGuardError
    );

    await expect(axios.get('https://unmocked-domain.example.invalid/axios')).rejects.toThrow(
      OfflineNetworkGuardError
    );

    expect(() => {
      const req = https.get('https://unmocked-domain.example.invalid/node-https');
      req.destroy();
    }).toThrow(OfflineNetworkGuardError);

    // Ephemeral loopback 127.0.0.1 server must remain permitted
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ loopback: 'ok' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ loopback: 'ok' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it(
    '6. Electron CJS Undeclared Identifier Gate: verifies zero TS2304/TS2552 ReferenceError-class diagnostics across all Electron .cjs modules',
    () => {
      expect(cjsFiles.length).toBeGreaterThanOrEqual(10);

      const cjsSet = new Set(cjsFiles.map((f) => path.resolve(f)));
      const undeclaredViolations: string[] = [];

      for (const sourceFile of sharedCjsProgram.getSourceFiles()) {
        const resolvedFile = path.resolve(sourceFile.fileName);
        if (!cjsSet.has(resolvedFile)) continue;
        const diagnostics = sharedCjsProgram.getSemanticDiagnostics(sourceFile);
        for (const diag of diagnostics) {
          if (diag.code === 2304 || diag.code === 2552) {
            const pos =
              diag.file && diag.start !== undefined
                ? diag.file.getLineAndCharacterOfPosition(diag.start)
                : { line: 0, character: 0 };
            const msg = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
            undeclaredViolations.push(
              `${path.relative(REPO_ROOT, resolvedFile)}:${pos.line + 1}:${pos.character + 1} - TS${diag.code}: ${msg}`
            );
          }
        }
      }

      expect(undeclaredViolations).toEqual([]);
    },
    30000
  );

  it('7. Preload <-> ElectronAPI / OfflineVaultBridge AST Contract Parity Gate: enforces exact 1:1 method/property parity between electron/preload.cjs and src/types/electron.d.ts', () => {
    const preloadPath = path.resolve(REPO_ROOT, 'electron/preload.cjs');
    const preloadSf =
      sharedCjsProgram.getSourceFile(preloadPath) ??
      ts.createSourceFile(
        preloadPath,
        fs.readFileSync(preloadPath, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );

    const preloadTopKeys: string[] = [];
    const preloadVaultKeys: string[] = [];

    const visitPreload = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(preloadSf) === 'contextBridge.exposeInMainWorld' &&
        node.arguments.length >= 2
      ) {
        const apiLiteral = node.arguments[1];
        if (ts.isObjectLiteralExpression(apiLiteral)) {
          for (const prop of apiLiteral.properties) {
            if (ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) {
              const propName = prop.name.getText(preloadSf);
              preloadTopKeys.push(propName);
              if (
                propName === 'offlineVault' &&
                ts.isPropertyAssignment(prop) &&
                ts.isObjectLiteralExpression(prop.initializer)
              ) {
                for (const vaultProp of prop.initializer.properties) {
                  if (ts.isPropertyAssignment(vaultProp) || ts.isMethodDeclaration(vaultProp)) {
                    preloadVaultKeys.push(vaultProp.name.getText(preloadSf));
                  }
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visitPreload);
    };
    visitPreload(preloadSf);

    const dtsPath = path.resolve(REPO_ROOT, 'src/types/electron.d.ts');
    const dtsSf = ts.createSourceFile(
      dtsPath,
      fs.readFileSync(dtsPath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    const dtsTopKeys: string[] = [];
    const dtsVaultKeys: string[] = [];

    for (const stmt of dtsSf.statements) {
      if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === 'ElectronAPI') {
        for (const member of stmt.members) {
          if (member.name) dtsTopKeys.push(member.name.getText(dtsSf));
        }
      } else if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === 'OfflineVaultBridge') {
        for (const member of stmt.members) {
          if (member.name) dtsVaultKeys.push(member.name.getText(dtsSf));
        }
      }
    }

    expect(preloadTopKeys.length).toBeGreaterThanOrEqual(50);
    expect(preloadVaultKeys.length).toBeGreaterThanOrEqual(10);
    expect([...preloadTopKeys].sort()).toEqual([...dtsTopKeys].sort());
    expect([...preloadVaultKeys].sort()).toEqual([...dtsVaultKeys].sort());
  });

  it('8. Zero-Mutation Installed Game Scanner Gate: confirms zero fs.rm*/unlink*/rmdir* calls inside electron/launcher/installedGameScanner.cjs', () => {
    const scannerPath = path.resolve(REPO_ROOT, 'electron/launcher/installedGameScanner.cjs');
    const scannerSf =
      sharedCjsProgram.getSourceFile(scannerPath) ??
      ts.createSourceFile(
        scannerPath,
        fs.readFileSync(scannerPath, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );

    const forbiddenDestructiveCalls = new Set([
      'rm',
      'rmSync',
      'rmdir',
      'rmdirSync',
      'unlink',
      'unlinkSync',
    ]);
    const violations: string[] = [];

    const visitScanner = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        let calleeName = '';
        if (ts.isIdentifier(expr)) {
          calleeName = expr.text;
        } else if (ts.isPropertyAccessExpression(expr)) {
          calleeName = expr.name.text;
        }
        if (forbiddenDestructiveCalls.has(calleeName)) {
          const lc = scannerSf.getLineAndCharacterOfPosition(node.getStart(scannerSf));
          violations.push(`electron/launcher/installedGameScanner.cjs:${lc.line + 1} -> ${calleeName}`);
        }
      }
      ts.forEachChild(node, visitScanner);
    };
    visitScanner(scannerSf);

    expect(violations).toEqual([]);
  });

  it('9. Zero Unused Legacy Dependencies Gate: confirms zero cheerio/clsx/tailwind-merge imports across src/, electron/, and tests/ and removal from package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const removedPackages = ['che' + 'erio', 'clsx', 'tailwind-merge', '@types/dompurify'];
    for (const depName of removedPackages) {
      expect(allDeps[depName], `Package ${depName} must not remain in package.json`).toBeUndefined();
    }

    const forbiddenSpecifiers = new Set(['che' + 'erio', 'clsx', 'tailwind-merge']);
    const codeExt = /\.(?:ts|tsx|js|cjs|mjs)$/i;
    const importViolations: string[] = [];

    for (const dir of ['src', 'electron', 'tests']) {
      for (const file of walkTextFiles(path.join(REPO_ROOT, dir), codeExt)) {
        const raw = fs.readFileSync(file, 'utf8');
        if (
          !raw.includes('che' + 'erio') &&
          !raw.includes('clsx') &&
          !raw.includes('tailwind-merge')
        ) {
          continue;
        }
        const rel = path.relative(REPO_ROOT, file);
        const sf =
          (file.endsWith('.cjs') ? sharedCjsProgram.getSourceFile(path.resolve(file)) : undefined) ??
          ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);

        const checkModuleSpecifier = (specNode: ts.Expression | undefined) => {
          if (specNode && ts.isStringLiteralLike(specNode)) {
            const spec = specNode.text.trim();
            if (forbiddenSpecifiers.has(spec)) {
              const lc = sf.getLineAndCharacterOfPosition(specNode.getStart(sf));
              importViolations.push(`${rel}:${lc.line + 1} imports "${spec}"`);
            }
          }
        };

        const visitImports = (node: ts.Node) => {
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            checkModuleSpecifier(node.moduleSpecifier);
          } else if (ts.isCallExpression(node)) {
            if (
              (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
              node.expression.kind === ts.SyntaxKind.ImportKeyword
            ) {
              checkModuleSpecifier(node.arguments[0]);
            }
          }
          ts.forEachChild(node, visitImports);
        };
        visitImports(sf);
      }
    }

    expect(importViolations).toEqual([]);
  });

  it('10. Strict Renderer & Build-Config Type-Safety Gate: confirms zero explicit : any / as any across all of src/** (including src/types) and vite.config.ts', () => {
    const strictTargets = ['src', 'vite.config.ts'];
    const tsExt = /\.(?:ts|tsx)$/i;
    const anyViolations: string[] = [];

    for (const relTarget of strictTargets) {
      for (const file of walkTextFiles(path.join(REPO_ROOT, relTarget), tsExt)) {
        const raw = fs.readFileSync(file, 'utf8');
        if (!/\bany\b/.test(raw)) continue;
        const rel = path.relative(REPO_ROOT, file);
        const sf = ts.createSourceFile(
          file,
          raw,
          ts.ScriptTarget.Latest,
          true,
          file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );
        const visitAny = (node: ts.Node) => {
          if (node.kind === ts.SyntaxKind.AnyKeyword) {
            const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            anyViolations.push(`${rel}:${lc.line + 1}:${lc.character + 1}`);
          }
          ts.forEachChild(node, visitAny);
        };
        visitAny(sf);
      }
    }

    expect(anyViolations).toEqual([]);
  });

  it('11. Preload Origin Guard & Parameter Forwarding Gate: verifies isTrustedMainRendererOrigin guard and 1:1 parameter forwarding for ipcRenderer.invoke wrappers', () => {
    const preloadPath = path.resolve(REPO_ROOT, 'electron/preload.cjs');
    const preloadRaw = fs.readFileSync(preloadPath, 'utf8');
    expect(preloadRaw).toContain('if (isTrustedMainRendererOrigin())');

    const preloadSf =
      sharedCjsProgram.getSourceFile(preloadPath) ??
      ts.createSourceFile(preloadPath, preloadRaw, ts.ScriptTarget.Latest, true);

    const droppedParamViolations: string[] = [];

    const checkWrapperFn = (propName: string, fn: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration) => {
      if (fn.parameters.length === 0) return;
      const invokeCalls: ts.CallExpression[] = [];
      const findInvoke = (n: ts.Node) => {
        if (
          ts.isCallExpression(n) &&
          n.expression.getText(preloadSf) === 'ipcRenderer.invoke'
        ) {
          invokeCalls.push(n);
        }
        ts.forEachChild(n, findInvoke);
      };
      findInvoke(fn.body ?? fn);
      if (invokeCalls.length !== 1) return;
      const invokeText = invokeCalls[0].getText(preloadSf);
      for (const param of fn.parameters) {
        if (ts.isIdentifier(param.name)) {
          const pName = param.name.text;
          if (!new RegExp(`\\b${pName}\\b`).test(invokeText)) {
            droppedParamViolations.push(`${propName} declares parameter "${pName}" not forwarded to ipcRenderer.invoke`);
          }
        }
      }
    };

    const visitPreload = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(preloadSf) === 'contextBridge.exposeInMainWorld' &&
        node.arguments.length >= 2 &&
        ts.isObjectLiteralExpression(node.arguments[1])
      ) {
        for (const prop of node.arguments[1].properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer))
          ) {
            checkWrapperFn(prop.name.getText(preloadSf), prop.initializer);
          } else if (ts.isMethodDeclaration(prop)) {
            checkWrapperFn(prop.name.getText(preloadSf), prop);
          }
        }
      }
      ts.forEachChild(node, visitPreload);
    };
    visitPreload(preloadSf);

    expect(droppedParamViolations).toEqual([]);
  });

  it('12. Rollup Service Layer DAG Gate: verifies vite.config.ts preserves acyclic 3-layer service chunking without monolithic services-core catch-all', () => {
    const viteConfigRaw = fs.readFileSync(path.join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    expect(viteConfigRaw).toContain("'services-foundation'");
    expect(viteConfigRaw).toContain("'services-catalog'");
    expect(viteConfigRaw).toContain("'services-launcher'");
    expect(viteConfigRaw).not.toContain("'services-core'");
  });

  it('13. Mirrored Launch Policy, Config Sanitizer & Environment Catalog 1:1 Parity Gate: locks TS contracts and Electron CJS policy modules to exact Cartesian deep equality', () => {
    const cjsConfigSanitizers = nodeRequire('../electron/launcher/policy/configSanitizers.cjs');
    const cjsEnvironmentCatalog = nodeRequire('../electron/launcher/policy/environmentCatalog.cjs');
    const cjsLaunchPolicyCore = nodeRequire('../electron/launcher/policy/launchPolicyCore.cjs');
    const cjsFacade = nodeRequire('../electron/launcher/launchPolicyResolver.cjs');

    // 13a. Environment Catalog parity (all 25 components including host_riot + all 15 login targets)
    expect(tsEnvironmentCatalog.ENVIRONMENT_COMPONENT_IDS).toHaveLength(25);
    expect(tsEnvironmentCatalog.ENVIRONMENT_COMPONENT_IDS).toContain('host_riot');
    expect(cjsEnvironmentCatalog.ENVIRONMENT_COMPONENT_IDS).toStrictEqual(
      tsEnvironmentCatalog.ENVIRONMENT_COMPONENT_IDS
    );
    expect(cjsFacade.ENVIRONMENT_COMPONENT_IDS).toStrictEqual(
      tsEnvironmentCatalog.ENVIRONMENT_COMPONENT_IDS
    );

    expect(tsEnvironmentCatalog.CLIENT_LOGIN_TARGET_IDS).toHaveLength(15);
    expect(tsEnvironmentCatalog.CLIENT_LOGIN_TARGET_IDS).toContain('host_riot');
    expect(cjsEnvironmentCatalog.CLIENT_LOGIN_TARGET_IDS).toStrictEqual(
      tsEnvironmentCatalog.CLIENT_LOGIN_TARGET_IDS
    );
    expect(cjsFacade.CLIENT_LOGIN_TARGET_IDS).toStrictEqual(
      tsEnvironmentCatalog.CLIENT_LOGIN_TARGET_IDS
    );

    expect(cjsEnvironmentCatalog.RUNNER_COMPONENT_TO_TYPE).toStrictEqual(
      tsEnvironmentCatalog.RUNNER_COMPONENT_TO_TYPE
    );
    expect(cjsEnvironmentCatalog.HOST_CLIENT_COMPONENT_IDS).toStrictEqual(
      tsEnvironmentCatalog.HOST_CLIENT_COMPONENT_IDS
    );
    expect(cjsEnvironmentCatalog.BOTTLE_CLIENT_COMPONENT_IDS).toStrictEqual(
      tsEnvironmentCatalog.BOTTLE_CLIENT_COMPONENT_IDS
    );
    expect(cjsEnvironmentCatalog.VALID_PREFERRED_RUNNERS).toStrictEqual(
      tsEnvironmentCatalog.VALID_PREFERRED_RUNNERS
    );
    expect(cjsEnvironmentCatalog.TARGET_TO_STOREFRONT_MAP).toStrictEqual(
      tsEnvironmentCatalog.TARGET_TO_STOREFRONT_MAP
    );
    expect(cjsEnvironmentCatalog.TARGET_TO_SCOPE_MAP).toStrictEqual(
      tsEnvironmentCatalog.TARGET_TO_SCOPE_MAP
    );
    expect(cjsEnvironmentCatalog.CLIENT_LOGIN_TARGET_CATALOG).toStrictEqual(
      tsEnvironmentCatalog.CLIENT_LOGIN_TARGET_CATALOG
    );
    expect(cjsEnvironmentCatalog.ENVIRONMENT_COMPONENT_CATALOG).toStrictEqual(
      tsEnvironmentCatalog.ENVIRONMENT_COMPONENT_CATALOG
    );

    // Explicit TS-01 anti-regression: 'host_steam'/'bottle_steam' must never match 'ea'
    expect(tsEnvironmentCatalog.TARGET_TO_STOREFRONT_MAP.host_steam).toBe('steam');
    expect(tsEnvironmentCatalog.TARGET_TO_STOREFRONT_MAP.bottle_steam).toBe('steam');
    expect(tsEnvironmentCatalog.TARGET_TO_STOREFRONT_MAP.host_ea).toBe('ea');
    expect(tsEnvironmentCatalog.TARGET_TO_STOREFRONT_MAP.bottle_ea).toBe('ea');
    expect(tsEnvironmentCatalog.TARGET_TO_STOREFRONT_MAP.host_riot).toBe('riot');

    for (const id of [...tsEnvironmentCatalog.ENVIRONMENT_COMPONENT_IDS, 'unknown_comp', '']) {
      expect(cjsEnvironmentCatalog.isValidEnvironmentComponentId(id)).toBe(
        tsEnvironmentCatalog.isValidEnvironmentComponentId(id)
      );
      expect(cjsEnvironmentCatalog.isValidClientLoginTargetId(id)).toBe(
        tsEnvironmentCatalog.isValidClientLoginTargetId(id)
      );
      expect(cjsEnvironmentCatalog.resolveStorefrontForLoginTarget(id)).toBe(
        tsEnvironmentCatalog.resolveStorefrontForLoginTarget(id)
      );
      expect(cjsEnvironmentCatalog.resolveScopeForLoginTarget(id)).toBe(
        tsEnvironmentCatalog.resolveScopeForLoginTarget(id)
      );
    }
    for (const compId of tsEnvironmentCatalog.ENVIRONMENT_COMPONENT_IDS) {
      for (const host of ['darwin', 'win32', 'linux'] as const) {
        expect(cjsEnvironmentCatalog.resolveComponentScopeForHost(compId, host)).toBe(
          tsEnvironmentCatalog.resolveComponentScopeForHost(compId, host)
        );
      }
    }

    // 13b. Config Sanitizer constants & functions 1:1 parity
    expect(cjsConfigSanitizers.LAUNCH_PROFILE_KEYS).toStrictEqual(
      tsConfigSanitizers.LAUNCH_PROFILE_KEYS
    );
    expect(cjsFacade.LAUNCH_PROFILE_KEYS).toStrictEqual(tsConfigSanitizers.LAUNCH_PROFILE_KEYS);
    expect(cjsConfigSanitizers.DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS).toStrictEqual(
      tsConfigSanitizers.DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS
    );
    expect(cjsConfigSanitizers.WINE_DEBUG_MODE_TO_ENV_MAP).toStrictEqual(
      tsConfigSanitizers.WINE_DEBUG_MODE_TO_ENV_MAP
    );
    expect(cjsFacade.WINE_DEBUG_MODE_TO_ENV_MAP).toStrictEqual(
      tsConfigSanitizers.WINE_DEBUG_MODE_TO_ENV_MAP
    );

    const wineDebugProbes: unknown[] = [
      'off',
      'OFF',
      'fixme_err',
      'warn_err',
      'relay',
      '+loaddll,err+all',
      '-all',
      '-all,err+system',
      '   ',
      '',
      null,
      undefined,
      123,
    ];
    for (const probe of wineDebugProbes) {
      expect(cjsConfigSanitizers.sanitizeWineDebugMode(probe)).toBe(
        tsConfigSanitizers.sanitizeWineDebugMode(probe)
      );
      expect(cjsConfigSanitizers.resolveWineDebugEnvValue(probe)).toBe(
        tsConfigSanitizers.resolveWineDebugEnvValue(probe)
      );
    }
    expect(tsConfigSanitizers.resolveWineDebugEnvValue('off')).toBe('-all');
    expect(tsConfigSanitizers.resolveWineDebugEnvValue('fixme_err')).toBe('fixme+all,err+all');
    expect(tsConfigSanitizers.resolveWineDebugEnvValue('warn_err')).toBe('warn+all,err+all');
    expect(tsConfigSanitizers.resolveWineDebugEnvValue('relay')).toBe('+relay');
    expect(tsConfigSanitizers.resolveWineDebugEnvValue('+loaddll,err+all')).toBe('+loaddll,err+all');

    const compatProbes: unknown[] = [
      'native',
      'crossover',
      'crossover_preview',
      'crossover_preview_arm64',
      'gptk',
      'wine',
      'whisky',
      'WHISKY',
      'unknown',
      '',
      undefined,
    ];
    for (const probe of compatProbes) {
      expect(cjsConfigSanitizers.sanitizeLegacyCompatLayer(probe)).toBe(
        tsConfigSanitizers.sanitizeLegacyCompatLayer(probe)
      );
    }
    expect(tsConfigSanitizers.sanitizeLegacyCompatLayer('whisky')).toBe('crossover');

    const lifecycleProbes: unknown[] = [
      'default',
      'minimal_and_close_if_started',
      'minimal_keep_running',
      'default_client',
      'fast_direct_bypass',
      'shutdown_if_woken',
      'keep_running',
      'bogus',
      '',
      undefined,
    ];
    for (const probe of lifecycleProbes) {
      expect(cjsConfigSanitizers.normalizeStorefrontClientLifecycle(probe)).toBe(
        tsConfigSanitizers.normalizeStorefrontClientLifecycle(probe)
      );
      expect(cjsConfigSanitizers.sanitizeStorefrontLifecyclePolicy(probe)).toBe(
        tsConfigSanitizers.sanitizeStorefrontLifecyclePolicy(probe)
      );
      expect(cjsConfigSanitizers.sanitizeStorefrontLifecycleOverride(probe)).toBe(
        tsConfigSanitizers.sanitizeStorefrontLifecycleOverride(probe)
      );
      expect(
        cjsConfigSanitizers.resolveEffectiveLifecyclePolicy(probe, 'minimal_keep_running')
      ).toBe(
        tsConfigSanitizers.resolveEffectiveLifecyclePolicy(
          probe as string | undefined,
          'minimal_keep_running'
        )
      );
    }

    const scalingProbes: unknown[] = [
      'default',
      'auto_fullscreen',
      'force_fullscreen',
      'native_driver',
      'windowed',
      'virtual_desktop',
      'off',
      'OFF',
      'invalid',
      '',
      undefined,
    ];
    for (const probe of scalingProbes) {
      expect(cjsConfigSanitizers.sanitizeGlobalBottleDisplayScalingMode(probe)).toBe(
        tsConfigSanitizers.sanitizeGlobalBottleDisplayScalingMode(probe)
      );
      expect(cjsConfigSanitizers.sanitizeBottleDisplayScalingMode(probe)).toBe(
        tsConfigSanitizers.sanitizeBottleDisplayScalingMode(probe)
      );
    }
    expect(tsConfigSanitizers.sanitizeBottleDisplayScalingMode('off')).toBe('native_driver');
    expect(tsConfigSanitizers.sanitizeGlobalBottleDisplayScalingMode('off')).toBe('native_driver');

    const hudConfigs = [
      {},
      { performanceHud: 'ON' },
      { performanceHud: 'off' },
      { performanceHud: 'default', metalHud: true },
      { metalHud: true },
      { dxvkHud: true },
      { metalHud: false, dxvkHud: false },
      {
        metalHud: false,
        platformConfigs: {
          steam: { dxvkHud: true },
          gog: { performanceHud: 'OFF' },
        },
      },
    ];
    for (const cfg of hudConfigs) {
      expect(cjsConfigSanitizers.migrateLegacyHudConfig(cfg)).toStrictEqual(
        tsConfigSanitizers.migrateLegacyHudConfig(cfg as Record<string, unknown>)
      );
      for (const globalHud of [false, true]) {
        expect(
          cjsConfigSanitizers.resolveEffectivePerformanceHud(cfg, {
            defaultPerformanceHud: globalHud,
          })
        ).toBe(
          tsConfigSanitizers.resolveEffectivePerformanceHud(cfg as Record<string, unknown>, {
            defaultPerformanceHud: globalHud,
          })
        );
      }
    }

    const perfPayloads = [
      undefined,
      {},
      {
        inGameLauncherBehavior: 'zero_renderer_daemon',
        postGameLauncherBehavior: 'exit_launcher',
        storefrontClientLifecycle: 'shutdown_if_woken',
        defaultBottleDisplayScalingMode: 'off',
        defaultDisplayAspectRatio: 'integer',
        enableMetalHud: true,
        ignoreLeadingTheWhenSorting: false,
      },
      {
        storefrontClientLifecycle: 'keep_running',
        defaultPerformanceHud: false,
        enableMangoHud: true,
      },
    ];
    for (const payload of perfPayloads) {
      expect(cjsConfigSanitizers.sanitizeLauncherPerformanceSettings(payload)).toStrictEqual(
        tsConfigSanitizers.sanitizeLauncherPerformanceSettings(payload)
      );
    }

    const dirtyLaunchCfg = {
      gameId: 'synth-1',
      preferredPlatformId: 'steam' as const,
      launchMethod: 'custom' as const,
      compatibilityLayer: 'whisky' as unknown as 'crossover',
      wineMsync: true,
      wineEsync: true,
      wineDebug: 'WARN_ERR',
      displayScalingMode: 'off' as unknown as 'native_driver',
      virtualDesktopResolution: '1920X1080',
      storefrontClientLifecycle: 'shutdown_if_woken' as unknown as 'minimal_and_close_if_started',
      metalHud: true,
      unknownInjectedField: 'must_be_stripped',
      platformConfigs: {
        gog: {
          launchMethod: 'direct' as const,
          storefrontClientLifecycle: 'default_client' as const,
          dxvkHud: true,
          bogusKey: 99,
        },
      },
    };
    const tsSanitizedCfg = tsConfigSanitizers.sanitizeGameLaunchConfig(dirtyLaunchCfg);
    const cjsSanitizedCfg = cjsConfigSanitizers.sanitizeGameLaunchConfig(dirtyLaunchCfg);
    expect(cjsSanitizedCfg).toStrictEqual(tsSanitizedCfg);
    expect(tsSanitizedCfg.launchMethod).toBe('auto');
    expect(tsSanitizedCfg.compatibilityLayer).toBe('crossover');
    expect(tsSanitizedCfg.wineEsync).toBe(false);
    expect(tsSanitizedCfg.wineDebug).toBe('warn_err');
    expect(tsSanitizedCfg.displayScalingMode).toBe('native_driver');
    expect(tsSanitizedCfg.performanceHud).toBe('on');
    expect('unknownInjectedField' in tsSanitizedCfg).toBe(false);
    expect(tsSanitizedCfg.platformConfigs?.gog?.storefrontClientLifecycle).toBe('default_client');

    // 13c. isBottleCompatibleWithRunner & isRunnerSupportedOnHost matrices
    const bottleCases: Array<{
      bottle: string | { name: string; wineArch?: string; bottleArch?: string };
      opts?: {
        bottleDetails?: Record<string, { wineArch?: string; bottleArch?: string }>;
        allowCustomNewBottleName?: boolean;
      };
    }> = [
      { bottle: '' },
      { bottle: 'OneLauncher' },
      { bottle: 'OneLauncher-arm64' },
      { bottle: 'Steam' },
      { bottle: 'Custom_arm64' },
      { bottle: 'CustomNew', opts: { allowCustomNewBottleName: true } },
      { bottle: 'OneLauncher', opts: { allowCustomNewBottleName: true } },
      { bottle: { name: 'OneLauncher', wineArch: 'win64' } },
      { bottle: { name: 'Legacy32', wineArch: 'win32' } },
      { bottle: { name: 'CustomArm', wineArch: 'arm64' } },
      { bottle: { name: 'FexBottle', bottleArch: 'arm64' } },
      {
        bottle: 'MappedBottle',
        opts: { bottleDetails: { MappedBottle: { wineArch: 'arm64' } } },
      },
    ];
    const runners = [
      'native',
      'crossover',
      'crossover_preview',
      'crossover_preview_arm64',
      'gptk',
      'wine',
      'whisky',
      'skip',
      undefined,
    ];
    for (const runner of runners) {
      for (const bc of bottleCases) {
        expect(
          cjsLaunchPolicyCore.isBottleCompatibleWithRunner(bc.bottle, runner, bc.opts)
        ).toBe(tsLaunchPolicyResolver.isBottleCompatibleWithRunner(bc.bottle, runner, bc.opts));
      }
      for (const [hostPlatform, hostArch] of [
        ['darwin', 'arm64'],
        ['darwin', 'x64'],
        ['win32', 'x64'],
        ['linux', 'x64'],
      ] as const) {
        expect(
          cjsLaunchPolicyCore.isRunnerSupportedOnHost(runner, hostPlatform, hostArch)
        ).toStrictEqual(
          tsLaunchPolicyResolver.isRunnerSupportedOnHost(runner, hostPlatform, hostArch)
        );
      }
    }
    // Explicit Intel x64 crossover_preview_arm64 rejection parity
    expect(
      tsLaunchPolicyResolver.isRunnerSupportedOnHost('crossover_preview_arm64', 'darwin', 'x64')
        .supported
    ).toBe(false);
    expect(
      cjsLaunchPolicyCore.isRunnerSupportedOnHost('crossover_preview_arm64', 'darwin', 'x64')
        .supported
    ).toBe(false);

    // 13d. Comprehensive Cartesian matrix for resolveEffectiveLaunchPolicy
    const hostPairs: Array<readonly ['darwin' | 'win32', 'arm64' | 'x64']> = [
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['win32', 'x64'],
    ];
    const platforms = ['steam', 'gog', 'epic', 'xbox', 'custom'] as const;
    const compatLayers = [
      'native',
      'wine',
      'crossover',
      'crossover_preview',
      'crossover_preview_arm64',
      'gptk',
    ] as const;
    const backends = ['auto', 'dxmt', 'd3dmetal', 'wined3d', 'dxvk'] as const;
    const displayModes = [
      { displayScalingMode: 'default', virtualDesktop: false },
      { displayScalingMode: 'auto_fullscreen', virtualDesktop: false },
      { displayScalingMode: 'force_fullscreen', virtualDesktop: false },
      { displayScalingMode: 'native_driver', virtualDesktop: false },
      { displayScalingMode: 'windowed', virtualDesktop: false },
      { displayScalingMode: 'off', virtualDesktop: false },
      { displayScalingMode: 'default', virtualDesktop: true },
    ] as const;
    const hudToggles = [
      { performanceHud: 'default', globalDefaultPerformanceHud: false },
      { performanceHud: 'default', globalDefaultPerformanceHud: true },
      { performanceHud: 'on', globalDefaultPerformanceHud: false },
      { performanceHud: 'off', globalDefaultPerformanceHud: true },
      { metalHud: true, globalDefaultPerformanceHud: false },
      { dxvkHud: true, globalDefaultPerformanceHud: false },
    ] as const;

    let cartesianCount = 0;
    for (const [hostPlatform, hostArch] of hostPairs) {
      const detectedBuildType: tsLaunchPolicyResolver.LaunchPolicyBuildType =
        hostPlatform === 'win32' ? 'windows_native' : 'windows_exe_on_mac';
      for (const platformId of platforms) {
        for (const compatibilityLayer of compatLayers) {
          for (const crossoverGraphicsBackend of backends) {
            const displaySpec = displayModes[cartesianCount % displayModes.length];
            const hudSpec = hudToggles[cartesianCount % hudToggles.length];
            const input = {
              platformId,
              hostPlatform,
              hostArch,
              detectedBuildType,
              isInstalled: true,
              hasExecutable: true,
              configuredLaunchMethod:
                compatibilityLayer === 'native' ? 'auto' : 'compatibility_layer',
              compatibilityLayer,
              crossoverGraphicsBackend,
              ...displaySpec,
              ...hudSpec,
              globalDisplayScalingMode: 'auto_fullscreen' as const,
            };
            const tsOut = tsLaunchPolicyResolver.resolveEffectiveLaunchPolicy(input);
            const cjsOut = cjsLaunchPolicyCore.resolveEffectiveLaunchPolicy(input);
            const facadeOut = cjsFacade.resolveEffectiveLaunchPolicy(input);
            expect(cjsOut).toStrictEqual(tsOut);
            expect(facadeOut).toStrictEqual(tsOut);

            if (hostPlatform === 'darwin' && hostArch === 'x64' && compatibilityLayer === 'crossover_preview_arm64') {
              expect(tsOut.runnerHostArchSupported).toBe(false);
              expect(tsOut.runnerHostArchError).toContain('Apple Silicon');
              expect(tsOut.supportsMetalfxSpatial).toBe(false);
            }
            cartesianCount += 1;
          }
        }
      }
    }
    expect(cartesianCount).toBe(450);

    // 13e. Additional Wave 1-A contract invariants (critic prefix, filter negative review fix, hostArch CI parity)
    expect(CRITIC_STORAGE_PREFIX).toBe('antigravity_critic_v8_');
    expect(
      activeGameFilterToLibraryFilterState({
        type: 'review',
        label: 'Reviews',
        value: 'Overwhelmingly Negative',
      }).reviewSentiments
    ).toEqual(['negative']);
    expect(
      activeGameFilterToLibraryFilterState({
        type: 'review',
        label: 'Reviews',
        value: 'Mostly Negative',
      }).reviewSentiments
    ).toEqual(['negative']);

    const origArchDesc = Object.getOwnPropertyDescriptor(process, 'arch');
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    try {
      expect(resolveHostArch()).toBe('arm64');
    } finally {
      if (origArchDesc) {
        Object.defineProperty(process, 'arch', origArchDesc);
      }
    }
  });
});
