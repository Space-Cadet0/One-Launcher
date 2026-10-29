import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import ts from 'typescript';
import { OfflineNetworkGuardError } from './setup/offlineNetworkGuard';
import { KNOWN_GAME_PATCHES } from '../src/services/integrations/catalogSanitizer';
import {
  loadLocalKeyedHmacConfig,
  scanContentForPiiViolations,
  scanRepoForPiiViolations,
  scanWorkspaceRootForPollutedEntries,
} from './helpers/piiHygieneGuard';

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
    const extRegex = /\.(?:cjs|mjs|js|ts|tsx|json|html|css|md|nsh|nsi|ps1|bat|py)$/i;
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

  it('10. Strict Renderer Type-Safety Gate: confirms zero explicit : any / as any across src/contracts, src/services, src/components, src/hooks, src/utils, and src/App.tsx', () => {
    const strictTargets = [
      'src/contracts',
      'src/services',
      'src/components',
      'src/hooks',
      'src/utils',
      'src/App.tsx',
    ];
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
});
