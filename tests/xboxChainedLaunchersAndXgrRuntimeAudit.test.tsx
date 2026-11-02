import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

import {
  createDomain12DeepRenderer,
  buildValidMinimalPe64Buffer,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';
import { scanContentForPiiViolations } from './helpers/piiHygieneGuard';

import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';
import { launcherService } from '../src/services/launcher/launcherService';
import { buildLaunchPolicyPreview } from '../src/services/launcher/launchPolicyPreview';
import { GameInstallModal } from '../src/components/Launcher/GameInstallModal';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { SteamSidebarNotices } from '../src/components/SteamStoreDetail/SteamSidebarNotices';

import type { CanonicalGame } from '../src/contracts/game';
import type { GameInstallInfo } from '../src/contracts/launcher';

const require = createRequire(import.meta.url);
const xboxRuntimeLoopbackServer = require('../electron/storefronts/xbox/xboxRuntimeLoopbackServer.cjs');
const xboxAchievementsAndStats = require('../electron/storefronts/xbox/xboxAchievementsAndStats.cjs');
const xboxCatalogAndGamePass = require('../electron/storefronts/xbox/xboxCatalogAndGamePass.cjs');
const nonGameClassifier = require('../electron/storefronts/nonGameClassifier.cjs');
const offlineVaultMod = require('../electron/launcher/offlineVaultService.cjs');
const chainedPublisherLaunchers = require('../electron/launcher/chainedPublisherLaunchers.cjs');
const wineAndCrossOverManager = require('../electron/launcher/wineAndCrossOverManager.cjs');
const downloadQueueCoordinator = require('../electron/launcher/downloadQueueCoordinator.cjs');
const environmentProvisioner = require('../electron/launcher/environmentProvisioner.cjs');
const environmentHealthProber = require('../electron/launcher/environmentHealthProber.cjs');
const binaryAndManifestInspectors = require('../electron/launcher/binaryAndManifestInspectors.cjs');
const diskAndVolumeInspector = require('../electron/launcher/diskAndVolumeInspector.cjs');
const sessionAndProcessSupervisor = require('../electron/launcher/sessionAndProcessSupervisor.cjs');
const engineStateRegistry = require('../electron/launcher/engineStateRegistry.cjs');

// ============================================================================
// Synthetic Zero-PII Constants & Hermetic Browser/DOM Polyfills
// ============================================================================

const SYNTH_XUID = '2533274790000001';
const SYNTH_GAMERTAG = 'TestPlayer';
const SYNTH_UHS = 'synthuhs0001';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, val: string): void {
    this.map.set(key, String(val));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
}

const memStorage = new MemoryStorage();

function ensureWindowAndStorageGlobals(): void {
  const g = globalThis as Record<string, any>;
  if (!g.localStorage) {
    g.localStorage = memStorage;
  }
  if (!g.CustomEvent) {
    g.CustomEvent = class CustomEvent {
      type: string;
      detail: any;
      constructor(type: string, init?: { detail?: any }) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
  }
  const listeners: Record<string, Array<(ev: any) => void>> = {};
  if (!g.window) {
    g.window = {
      localStorage: g.localStorage,
      location: { hostname: '' },
      navigator: { userAgent: 'Macintosh' },
      addEventListener: (ev: string, fn: (e: any) => void) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(fn);
      },
      removeEventListener: (ev: string, fn: (e: any) => void) => {
        if (listeners[ev]) {
          listeners[ev] = listeners[ev].filter((f) => f !== fn);
        }
      },
      dispatchEvent: (event: any) => {
        for (const fn of (listeners[event.type] || []).slice()) {
          fn(event);
        }
        return true;
      },
    };
  } else if (!g.window.localStorage) {
    g.window.localStorage = g.localStorage;
  }
}

ensureWindowAndStorageGlobals();

function findVNodes(root: any, predicate: (node: any) => boolean): any[] {
  const matches: any[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (predicate(node)) matches.push(node);
    if (node.props?.children !== undefined) {
      visit(node.props.children);
    }
  };
  visit(root);
  return matches;
}

function findVNodeByTestId(root: any, testId: string): any | undefined {
  return findVNodes(root, (n) => n.props?.['data-testid'] === testId)[0];
}

function extractVNodeText(node: any): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractVNodeText).join('');
  if (typeof node === 'object' && node.props?.children !== undefined) {
    return extractVNodeText(node.props.children);
  }
  return '';
}

/**
 * Deterministic WCAG 2.2 AA accessibility auditor over rendered VNode trees & static HTML markup.
 */
function auditWcag22AA(tree: any): string[] {
  const violations: string[] = [];
  const allElements = findVNodes(tree, (n) => typeof n.type === 'string');

  const elementsById = new Map<string, any>();
  const labelForIds = new Set<string>();
  const implicitlyLabelledControls = new WeakSet<object>();

  for (const el of allElements) {
    const id = el.props?.id;
    if (typeof id === 'string' && id.trim()) {
      if (elementsById.has(id)) {
        violations.push(`duplicate-id: Duplicate id="${id}" on <${el.type}>`);
      } else {
        elementsById.set(id, el);
      }
    }
    if (el.type === 'label') {
      if (typeof el.props?.htmlFor === 'string' && el.props.htmlFor.trim()) {
        labelForIds.add(el.props.htmlFor.trim());
      } else if (extractVNodeText(el).trim().length > 0) {
        const nestedControls = findVNodes(
          el,
          (n) => n.type === 'input' || n.type === 'select' || n.type === 'textarea'
        );
        if (nestedControls.length === 1) {
          implicitlyLabelledControls.add(nestedControls[0]);
        }
      }
    }
  }

  const html = renderToStaticMarkup(tree as React.ReactElement);
  const parseErrors: string[] = [];
  new XmlDomParser({
    errorHandler: {
      warning: () => {},
      error: (msg: string) => parseErrors.push(msg),
      fatalError: (msg: string) => parseErrors.push(msg),
    },
  }).parseFromString(`<div>${html}</div>`, 'text/html');
  if (parseErrors.length > 0) {
    violations.push(`html-well-formedness: ${parseErrors.join('; ')}`);
  }

  for (const el of allElements) {
    const tag = el.type as string;
    const props = el.props || {};
    const testId = props['data-testid'] ? `[data-testid="${props['data-testid']}"]` : `<${tag}>`;

    for (const refAttr of ['aria-labelledby', 'aria-describedby'] as const) {
      if (typeof props[refAttr] === 'string' && props[refAttr].trim()) {
        for (const refId of props[refAttr].trim().split(/\s+/)) {
          if (!elementsById.has(refId)) {
            violations.push(
              `aria-valid-attr-value: ${testId} has ${refAttr}="${refId}" referencing non-existent id`
            );
          }
        }
      }
    }
    if (tag === 'label' && typeof props.htmlFor === 'string' && props.htmlFor.trim()) {
      if (!elementsById.has(props.htmlFor.trim())) {
        violations.push(
          `label-ValidFor: <label htmlFor="${props.htmlFor}"> references non-existent control id`
        );
      }
    }

    if (tag === 'dialog') {
      const hasLabelledBy =
        typeof props['aria-labelledby'] === 'string' &&
        props['aria-labelledby']
          .trim()
          .split(/\s+/)
          .every((id: string) => {
            const target = elementsById.get(id);
            return Boolean(target && extractVNodeText(target).trim().length > 0);
          });
      const hasAriaLabel =
        typeof props['aria-label'] === 'string' && props['aria-label'].trim().length > 0;
      if (!hasLabelledBy && !hasAriaLabel) {
        violations.push(`dialog-name: ${testId} lacks accessible name`);
      }
    }

    if (tag === 'button') {
      if (!['button', 'submit', 'reset'].includes(String(props.type || ''))) {
        violations.push(`button-type: ${testId} is missing explicit type="button|submit|reset"`);
      }
      const visibleText = extractVNodeText(el).trim();
      const ariaLabel = typeof props['aria-label'] === 'string' ? props['aria-label'].trim() : '';
      const labelledByText =
        typeof props['aria-labelledby'] === 'string'
          ? props['aria-labelledby']
              .trim()
              .split(/\s+/)
              .map((id: string) => extractVNodeText(elementsById.get(id)).trim())
              .join(' ')
              .trim()
          : '';
      if (!visibleText && !ariaLabel && !labelledByText) {
        violations.push(`button-name: ${testId} has no accessible name`);
      }
      const cls = String(props.className || '');
      if (!/\b(min-h-6|min-w-6|p-\d|py-\d|px-\d|h-\d|underline)\b/.test(cls)) {
        violations.push(
          `target-size (WCAG 2.2 SC 2.5.8): ${testId} lacks >=24px target sizing class ("${cls}")`
        );
      }
    }

    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (props.type === 'hidden') continue;
      const ariaLabel = typeof props['aria-label'] === 'string' ? props['aria-label'].trim() : '';
      const ariaLabelledBy =
        typeof props['aria-labelledby'] === 'string' ? props['aria-labelledby'].trim() : '';
      const hasExplicitLabel = typeof props.id === 'string' && labelForIds.has(props.id);
      const hasImplicitLabel = implicitlyLabelledControls.has(el);
      if (!ariaLabel && !ariaLabelledBy && !hasExplicitLabel && !hasImplicitLabel) {
        violations.push(`label: ${testId} (${tag}) lacks accessible label`);
      }
    }

    if (tag === 'progress') {
      const ariaLabel = typeof props['aria-label'] === 'string' ? props['aria-label'].trim() : '';
      const ariaLabelledBy =
        typeof props['aria-labelledby'] === 'string' ? props['aria-labelledby'].trim() : '';
      if (!ariaLabel && !ariaLabelledBy) {
        violations.push(`progressbar-name: <progress> lacks accessible name`);
      }
    }

    if (
      tag !== 'svg' &&
      tag !== 'path' &&
      props['aria-hidden'] !== 'true' &&
      props['aria-hidden'] !== true &&
      props.disabled !== true
    ) {
      const cls = String(props.className || '');
      if (
        /\btext-(?:slate|gray|zinc)-[56789]00\b/.test(cls) &&
        extractVNodeText(el).trim().length > 0
      ) {
        violations.push(`color-contrast: ${testId} uses low-contrast muted text class ("${cls}")`);
      }
    }
  }

  return violations;
}

// ============================================================================
// Hermetic Network Socket Guard & Loopback RPC / Protobuf Wire Helpers
// ============================================================================

function installHermeticOfflineSocketGuard(): () => void {
  const origConnect = net.Socket.prototype.connect;
  const origFetch = globalThis.fetch;

  (net.Socket.prototype as any).connect = function (...args: any[]) {
    let targetHost = '';
    const first = args[0];
    if (typeof first === 'object' && first !== null) {
      if (first.path) {
        return origConnect.apply(this, args as any);
      }
      targetHost = String(first.host || first.hostname || '127.0.0.1');
    } else if (typeof args[1] === 'string') {
      targetHost = args[1];
    } else {
      targetHost = '127.0.0.1';
    }
    const cleanHost = targetHost.trim().toLowerCase();
    if (cleanHost !== '127.0.0.1' && cleanHost !== 'localhost' && cleanHost !== '::1') {
      throw new Error(
        `HERMETIC_OFFLINE_SOCKET_GUARD: Blocked external TCP socket to "${targetHost}"`
      );
    }
    return origConnect.apply(this, args as any);
  };

  globalThis.fetch = (async (input: any) => {
    const urlStr = typeof input === 'string' ? input : String(input?.url || input);
    throw new Error(`HERMETIC_OFFLINE_FETCH_GUARD: Unmocked fetch call to "${urlStr}"`);
  }) as any;

  return () => {
    net.Socket.prototype.connect = origConnect;
    globalThis.fetch = origFetch;
  };
}

async function sendLoopbackRpc(
  port: number,
  sessionKey: string,
  method: string,
  params: Record<string, any> = {}
): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      const reqFrame = xboxRuntimeLoopbackServer.encodeRpcFrame({
        id: 1,
        key: sessionKey,
        method,
        params,
      });
      sock.write(reqFrame);
    });
    const chunks: Buffer[] = [];
    sock.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const merged = Buffer.concat(chunks);
      if (merged.length >= 4) {
        const bodyLen = merged.readUInt32LE(0);
        if (merged.length >= 4 + bodyLen) {
          const jsonText = merged.subarray(4, 4 + bodyLen).toString('utf8');
          sock.destroy();
          try {
            resolve(JSON.parse(jsonText));
          } catch (err) {
            reject(err);
          }
        }
      }
    });
    sock.on('error', reject);
  });
}

function encodeProtobufVarint(val: number): Buffer {
  const bytes: number[] = [];
  let v = val >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encodeProtobufTag(fieldNumber: number, wireType: number): Buffer {
  return encodeProtobufVarint((fieldNumber << 3) | wireType);
}

function encodeProtobufString(fieldNumber: number, text: string): Buffer {
  const strBuf = Buffer.from(text, 'utf8');
  return Buffer.concat([
    encodeProtobufTag(fieldNumber, 2),
    encodeProtobufVarint(strBuf.length),
    strBuf,
  ]);
}

function encodeProtobufSubmessage(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([
    encodeProtobufTag(fieldNumber, 2),
    encodeProtobufVarint(payload.length),
    payload,
  ]);
}

function encodeProtobufVarintField(fieldNumber: number, val: number): Buffer {
  return Buffer.concat([encodeProtobufTag(fieldNumber, 0), encodeProtobufVarint(val)]);
}

function buildSyntheticBattleNetProductInstallBytes(entry: {
  uid: string;
  productCode: string;
  installPath: string;
  playRegion?: string;
  installed: boolean;
  playable: boolean;
  version?: string;
}): Buffer {
  const userSettings = Buffer.concat([
    encodeProtobufString(1, entry.installPath),
    ...(entry.playRegion ? [encodeProtobufString(2, entry.playRegion)] : []),
  ]);
  const baseProductState = Buffer.concat([
    encodeProtobufVarintField(1, entry.installed ? 1 : 0),
    encodeProtobufVarintField(2, entry.playable ? 1 : 0),
    ...(entry.version ? [encodeProtobufString(7, entry.version)] : []),
  ]);
  const cachedProductState = encodeProtobufSubmessage(1, baseProductState);
  const productInstall = Buffer.concat([
    encodeProtobufString(1, entry.uid),
    encodeProtobufString(2, entry.productCode),
    encodeProtobufSubmessage(3, userSettings),
    encodeProtobufSubmessage(4, cachedProductState),
  ]);
  return encodeProtobufSubmessage(1, productInstall);
}

// ============================================================================
// Wave 3A Regression Suite
// ============================================================================

describe('Xbox Chained Publisher Launchers & XGR Runtime Audit (Wave 3A)', () => {
  let tmpRoot = '';
  let restoreNetworkGuard: (() => void) | null = null;

  beforeEach(() => {
    memStorage.clear();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-wave3a-xgr-'));
    restoreNetworkGuard = installHermeticOfflineSocketGuard();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      sessionAndProcessSupervisor.shutdownLauncherEngine();
    } catch {}
    if (restoreNetworkGuard) {
      restoreNetworkGuard();
      restoreNetworkGuard = null;
    }
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // 1. XGR Loopback Store Runtime, Installed DLC Discovery & Offline Auth Resilience
  // ==========================================================================
  describe('Domain 1: XGR Loopback Store Runtime, Installed DLC Discovery & Offline Auth Resilience', () => {
    it('auto-instantiates createXboxStoreRuntimeProvider in startXboxRuntimeLoopbackServer for live XStore products, add-on licenses, acquireStoreLicenseToken, collectionsId & purchaseId', async () => {
      const gameRootDir = path.join(tmpRoot, 'Games', 'SynthGdkRpg');
      const saveRootDir = path.join(tmpRoot, 'Packages', 'SynthPub.SynthGdkRpg_8wekyb3d8bbwe', 'SystemAppData');
      fs.mkdirSync(gameRootDir, { recursive: true });
      fs.mkdirSync(saveRootDir, { recursive: true });

      const capturedHttpCalls: Array<{ url: string; method: string; authHeader: string; body: string }> = [];

      const mockFetch = vi.fn(async (rawUrl: string, init?: any) => {
        const url = String(rawUrl);
        const method = String(init?.method || 'GET').toUpperCase();
        const headers = init?.headers || {};
        const authHeader = String(headers.Authorization || headers.authorization || '');
        const body = typeof init?.body === 'string' ? init.body : '';
        capturedHttpCalls.push({ url, method, authHeader, body });

        if (url.includes('userpresence.xboxlive.com')) {
          return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        }
        if (url.includes('entitlements') || url.includes('collections/query')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [
                {
                  productId: '9NBASEGAME01',
                  skuId: '0010',
                  status: 'Active',
                  productKind: 'Game',
                },
                {
                  productId: '9NADDON00001',
                  skuId: '0010',
                  status: 'Active',
                  productKind: 'Durable',
                },
                {
                  productId: '9NOTHERGAME9',
                  skuId: '0010',
                  status: 'Active',
                  productKind: 'Game',
                },
              ],
            }),
            text: async () => '',
          };
        }
        if (url.includes('displaycatalog.mp.microsoft.com')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              Products: [
                {
                  ProductId: '9NBASEGAME01',
                  ProductKind: 'Game',
                  LocalizedProperties: [
                    { ProductTitle: 'Synthetic GDK Odyssey', ShortDescription: 'Base GDK Game' },
                  ],
                  DisplaySkuAvailabilities: [
                    {
                      Sku: { SkuId: '0010', Properties: { IsTrial: false } },
                      Availabilities: [
                        {
                          OrderManagementData: {
                            Price: { ListPrice: 39.99, MSRP: 59.99, CurrencyCode: 'USD' },
                          },
                        },
                      ],
                    },
                  ],
                },
                {
                  ProductId: '9NADDON00001',
                  ProductKind: 'Durable',
                  LocalizedProperties: [
                    { ProductTitle: 'Crimson Expansion Pack', ShortDescription: 'Owned Story DLC' },
                  ],
                  DisplaySkuAvailabilities: [
                    {
                      Sku: {
                        SkuId: '0010',
                        Properties: { IsTrial: false, InAppOfferToken: 'crimson_dlc_offer' },
                      },
                      Availabilities: [
                        {
                          OrderManagementData: {
                            Price: { ListPrice: 14.99, MSRP: 19.99, CurrencyCode: 'USD' },
                          },
                        },
                      ],
                    },
                  ],
                },
                {
                  ProductId: '9NUNOWNED002',
                  ProductKind: 'Durable',
                  LocalizedProperties: [
                    { ProductTitle: 'Unowned Cosmetic Pack', ShortDescription: 'Optional Add-On' },
                  ],
                  DisplaySkuAvailabilities: [
                    {
                      Sku: {
                        SkuId: '0010',
                        Properties: { IsTrial: false, InAppOfferToken: 'cosmetic_offer_02' },
                      },
                      Availabilities: [
                        {
                          OrderManagementData: {
                            Price: { ListPrice: 4.99, MSRP: 4.99, CurrencyCode: 'USD' },
                          },
                        },
                      ],
                    },
                  ],
                },
                {
                  ProductId: '9NOTHERGAME9',
                  ProductKind: 'Game',
                  LocalizedProperties: [{ ProductTitle: 'Unrelated Standalone Game' }],
                  DisplaySkuAvailabilities: [{ Sku: { SkuId: '0010', Properties: {} }, Availabilities: [] }],
                },
              ],
            }),
            text: async () => '',
          };
        }
        if (url.includes('licensing.mp.microsoft.com/v8.0/licenseToken')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.SYNTH_STORE_LICENSE_JWT.sig',
            }),
            text: async () => '',
          };
        }
        if (url === 'https://collections.mp.microsoft.com/v6.0/collections/b2ctoken') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ token: 'SYNTH_COLLECTIONS_B2C_ID_TOKEN_01' }),
            text: async () => '',
          };
        }
        if (url === 'https://purchase.mp.microsoft.com/v6.0/users/me/b2ctoken') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ token: 'SYNTH_PURCHASE_B2C_ID_TOKEN_01' }),
            text: async () => '',
          };
        }
        return { ok: false, status: 404, json: async () => ({}), text: async () => 'Not Found' };
      });

      const authProvider = {
        async getUserProfile() {
          return { xuid: SYNTH_XUID, gamertag: SYNTH_GAMERTAG, uhs: SYNTH_UHS };
        },
        async getStoreMsaToken(opts?: { forLicensing?: boolean }) {
          return opts?.forLicensing ? 't=SYNTH_MSA_LICENSING_TICKET' : 't=SYNTH_MSA_B2C_TICKET';
        },
        async ensureDeviceContext() {
          return { deviceToken: 'd=SYNTH_DEVICE_DAT_TOKEN_0001' };
        },
        async getXstsToken() {
          return {
            uhs: SYNTH_UHS,
            token: 'SYNTH_XSTS_TOKEN',
            authorizationHeader: `XBL3.0 x=${SYNTH_UHS};SYNTH_XSTS_TOKEN`,
          };
        },
        async getTokenAndSignatureForUrl() {
          return { token: `XBL3.0 x=${SYNTH_UHS};SYNTH_PRESENCE_XSTS` };
        },
      };

      const server = await xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
        authProvider,
        gameMetadata: {
          titleId: '1A2B3C4D',
          scid: '00000000-0000-0000-0000-00001a2b3c4d',
          storeId: '9NBASEGAME01',
          packageFamilyName: 'SynthPub.SynthGdkRpg_8wekyb3d8bbwe',
          displayName: 'Synthetic GDK Odyssey',
        },
        gameRootDir,
        saveRootDir,
        locale: 'ja-JP',
        inviteUri: 'ms-xbl-1a2b3c4d://invite?session=0001',
        userDataDir: path.join(tmpRoot, 'userdata'),
        fetchImpl: mockFetch,
      });

      try {
        expect(server.env.ONE_XGR_LOCALE).toBe('ja-JP');
        expect(server.env.ONE_XGR_SAVE_ROOT).toMatch(/^Z:\\/i);
        expect(server.env.ONE_XGR_SAVE_ROOT).toContain('SystemAppData');
        expect(server.env.ONE_XGR_INVITE_URI).toBe('ms-xbl-1a2b3c4d://invite?session=0001');

        const queryProductsRes = await sendLoopbackRpc(
          server.port,
          server.sessionKey,
          'xstore.queryProducts',
          {
            storeIds: ['9NBASEGAME01', '9NADDON00001', '9NUNOWNED002'],
            productKinds: 0x1f,
          }
        );
        expect(queryProductsRes.ok).toBe(true);
        const products = queryProductsRes.result.products;
        expect(products).toHaveLength(3);

        const baseProd = products.find((p: any) => p.storeId === '9NBASEGAME01');
        const ownedAddon = products.find((p: any) => p.storeId === '9NADDON00001');
        const unownedAddon = products.find((p: any) => p.storeId === '9NUNOWNED002');
        expect(baseProd).toMatchObject({
          storeId: '9NBASEGAME01',
          price: 39.99,
          basePrice: 59.99,
          formattedPrice: '$39.99',
          formattedBasePrice: '$59.99',
          isOnSale: true,
          isInUserCollection: true,
        });
        expect(ownedAddon).toMatchObject({
          storeId: '9NADDON00001',
          inAppOfferToken: 'crimson_dlc_offer',
          price: 14.99,
          basePrice: 19.99,
          formattedPrice: '$14.99',
          isOnSale: true,
          isInUserCollection: true,
        });
        expect(unownedAddon).toMatchObject({
          storeId: '9NUNOWNED002',
          price: 4.99,
          isOnSale: false,
          isInUserCollection: false,
        });

        const addonLicensesRes = await sendLoopbackRpc(
          server.port,
          server.sessionKey,
          'xstore.queryAddOnLicenses',
          {}
        );
        expect(addonLicensesRes.ok).toBe(true);
        expect(addonLicensesRes.result.licenses).toEqual([
          expect.objectContaining({
            skuStoreId: '9NADDON00001/0010',
            inAppOfferToken: 'crimson_dlc_offer',
            isActive: true,
          }),
        ]);

        const licTokenRes = await sendLoopbackRpc(
          server.port,
          server.sessionKey,
          'xstore.queryLicenseToken',
          {
            productIds: ['9NBASEGAME01', '9NADDON00001'],
            customDeveloperString: 'synth-challenge-nonce',
          }
        );
        expect(licTokenRes.ok).toBe(true);
        expect(licTokenRes.result.token).toBe(
          'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.SYNTH_STORE_LICENSE_JWT.sig'
        );
        const clepCall = capturedHttpCalls.find((c) =>
          c.url.includes('licensing.mp.microsoft.com/v8.0/licenseToken')
        );
        expect(clepCall).toBeDefined();
        expect(clepCall!.authHeader).toBe('t=SYNTH_DEVICE_DAT_TOKEN_0001');
        expect(JSON.parse(clepCall!.body)).toMatchObject({
          parentProductId: '9NBASEGAME01',
          relatedProductIds: ['9NBASEGAME01', '9NADDON00001'],
          customDeveloperString: 'synth-challenge-nonce',
        });

        const colIdRes = await sendLoopbackRpc(
          server.port,
          server.sessionKey,
          'xstore.getCollectionsId',
          {
            serviceTicket: 'playfab-svc-ticket-01',
            publisherUserId: 'pub-user-001',
          }
        );
        expect(colIdRes.ok).toBe(true);
        expect(colIdRes.result.token).toBe('SYNTH_COLLECTIONS_B2C_ID_TOKEN_01');

        const purIdRes = await sendLoopbackRpc(
          server.port,
          server.sessionKey,
          'xstore.getPurchaseId',
          {
            serviceTicket: 'playfab-purchase-ticket-01',
            publisherUserId: 'pub-user-001',
          }
        );
        expect(purIdRes.ok).toBe(true);
        expect(purIdRes.result.token).toBe('SYNTH_PURCHASE_B2C_ID_TOKEN_01');
      } finally {
        await server.stop();
        xboxCatalogAndGamePass.closeXboxCatalogCacheStore({
          userDataDir: path.join(tmpRoot, 'userdata'),
        });
      }
    });

    it('discovers .onelauncher-dlc packages (stripping <DevelopmentOnly>), exposes dlcPackages + locale via session.init, and handles presence heartbeats cleanly online & offline', async () => {
      const gameRootDir = path.join(tmpRoot, 'Games', 'SynthRacingStyle');
      const dlcAlphaContentDir = path.join(
        gameRootDir,
        '.onelauncher-dlc',
        '01_ExpansionAlpha',
        'Content'
      );
      const dlcBetaDir = path.join(gameRootDir, '.onelauncher-dlc', '02_VehiclePackBeta');
      fs.mkdirSync(dlcAlphaContentDir, { recursive: true });
      fs.mkdirSync(dlcBetaDir, { recursive: true });

      fs.writeFileSync(
        path.join(dlcAlphaContentDir, 'MicrosoftGame.config'),
        `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <DevelopmentOnly>
    <StoreId>9NBOGUSDEV00</StoreId>
    <Identity Name="Bogus.DevIdentity" Publisher="CN=Dev" Version="9.9.9.9" />
  </DevelopmentOnly>
  <Identity Name="SynthPub.ExpansionAlpha" Publisher="CN=00000000-0000-0000-0000-000000000001" Version="1.4.2.0" />
  <StoreId>9NDLCALPHA01</StoreId>
  <ShellVisuals DefaultDisplayName="Synthetic Ridge Expansion" />
</Game>`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(path.dirname(dlcAlphaContentDir), '.onelauncher-dlc.json'),
        JSON.stringify({
          packageFullName: 'SynthPub.ExpansionAlpha_1.4.2.0_x64__8wekyb3d8bbwe',
        }),
        'utf8'
      );

      fs.writeFileSync(
        path.join(dlcBetaDir, 'AppxManifest.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<Package>
  <Identity Name="SynthPub.VehiclePackBeta" Version="2.0.1.0" />
  <Properties><DisplayName>Synthetic Touring Pack</DisplayName></Properties>
</Package>`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(dlcBetaDir, '.onelauncher-dlc.json'),
        JSON.stringify({ storeId: '9NDLCBETA002' }),
        'utf8'
      );

      const discovered = xboxRuntimeLoopbackServer.discoverInstalledDlcPackages(gameRootDir);
      expect(discovered).toHaveLength(2);
      expect(discovered[0]).toMatchObject({
        packageFullName: 'SynthPub.ExpansionAlpha_1.4.2.0_x64__8wekyb3d8bbwe',
        storeId: '9NDLCALPHA01',
        displayName: 'Synthetic Ridge Expansion',
        version: '1.4.2.0',
        mountPathHost: dlcAlphaContentDir,
      });
      expect(discovered[0].mountPathWin).toMatch(/^Z:\\/i);
      expect(discovered[1]).toMatchObject({
        storeId: '9NDLCBETA002',
        displayName: 'Synthetic Touring Pack',
        version: '2.0.1.0',
        mountPathHost: dlcBetaDir,
      });

      const presenceCalls: Array<{ method: string; url: string; body: string }> = [];
      const mockFetch = vi.fn(async (rawUrl: string, init?: any) => {
        const url = String(rawUrl);
        if (url.includes('userpresence.xboxlive.com')) {
          presenceCalls.push({
            method: String(init?.method || 'GET').toUpperCase(),
            url,
            body: String(init?.body || ''),
          });
          return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        }
        return { ok: true, status: 200, json: async () => ({ items: [] }), text: async () => '' };
      });

      const server = await xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
        authProvider: {
          async getUserProfile() {
            return { xuid: SYNTH_XUID, gamertag: SYNTH_GAMERTAG, uhs: SYNTH_UHS };
          },
          async getXstsToken() {
            return {
              uhs: SYNTH_UHS,
              token: 'SYNTH_PRESENCE_TOK',
              authorizationHeader: `XBL3.0 x=${SYNTH_UHS};SYNTH_PRESENCE_TOK`,
            };
          },
          async getTokenAndSignatureForUrl() {
            return { token: `XBL3.0 x=${SYNTH_UHS};SYNTH_PRESENCE_TOK` };
          },
        },
        gameMetadata: {
          titleId: '1890123456',
          scid: '00000000-0000-0000-0000-000070a8d2c0',
          storeId: '9NRACEBASE01',
        },
        gameRootDir,
        saveRootDir: path.join(tmpRoot, 'RacingSaves'),
        locale: 'de-DE',
        fetchImpl: mockFetch,
      });

      const initRes = await sendLoopbackRpc(server.port, server.sessionKey, 'session.init', {});
      await new Promise((r) => setImmediate(r));
      expect(initRes.ok).toBe(true);
      expect(initRes.result.locale).toBe('de-DE');
      expect(initRes.result.xuid).toBe(SYNTH_XUID);
      expect(initRes.result.gamertag).toBe(SYNTH_GAMERTAG);
      expect(initRes.result.dlcPackages).toHaveLength(2);
      expect(initRes.result.dlcPackages[0].storeId).toBe('9NDLCALPHA01');

      expect(
        presenceCalls.some(
          (c) =>
            c.method === 'POST' &&
            c.url ===
              `https://userpresence.xboxlive.com/users/xuid(${SYNTH_XUID})/devices/current/titles/current` &&
            JSON.parse(c.body).state === 'active'
        )
      ).toBe(true);

      await server.stop();

      expect(
        presenceCalls.some(
          (c) =>
            c.method === 'DELETE' &&
            c.url ===
              `https://userpresence.xboxlive.com/users/xuid(${SYNTH_XUID})/devices/current/titles/current`
        )
      ).toBe(true);

      // Offline resilience: postXboxTitlePresenceHeartbeat must never throw on ENOTFOUND/ETIMEDOUT
      const offlineHeartbeat = await xboxAchievementsAndStats.postXboxTitlePresenceHeartbeat({
        state: 'active',
        titleId: '1890123456',
        xuid: SYNTH_XUID,
        uhs: SYNTH_UHS,
        xstsToken: 'SYNTH_OFFLINE_TOK',
        fetchImpl: async () => {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND userpresence.xboxlive.com'), {
            code: 'ENOTFOUND',
          });
        },
      });
      expect(offlineHeartbeat).toEqual({ ok: false, status: 0 });
    });

    it('falls back to cached Xbox identity on transient ENOTFOUND/ETIMEDOUT in resolveXboxAuthAndSession (darwin & win32), without leaking stale identity when connected === false', async () => {
      const homeDir = path.join(tmpRoot, 'OfflineAuthHome');
      const userDataDir = path.join(homeDir, '.one-launcher');
      const customApplicationsDir = path.join(homeDir, 'Applications');
      const bottlePath = path.join(
        homeDir,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'OneLauncher'
      );
      const gameInstallDir = path.join(homeDir, 'Games', 'OneLauncher', 'SynthOfflineGdk');
      const fakeWineBin = path.join(
        customApplicationsDir,
        'CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine'
      );
      const fakeBridgeDll = path.join(tmpRoot, 'one_xgameruntime_bridge.dll');
      const fakeGameInputDll = path.join(tmpRoot, 'one_gameinput_bridge.dll');
      const fakeAppNotifyDll = path.join(tmpRoot, 'one_appnotify_bridge.dll');

      fs.mkdirSync(path.join(bottlePath, 'drive_c', 'windows', 'system32'), { recursive: true });
      fs.mkdirSync(gameInstallDir, { recursive: true });
      fs.mkdirSync(path.dirname(fakeWineBin), { recursive: true });
      fs.writeFileSync(fakeWineBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const pe64 = buildValidMinimalPe64Buffer();
      fs.writeFileSync(fakeBridgeDll, pe64);
      fs.writeFileSync(fakeGameInputDll, pe64);
      fs.writeFileSync(fakeAppNotifyDll, pe64);

      const gameExePath = path.join(gameInstallDir, 'SynthOfflineGame.exe');
      fs.writeFileSync(gameExePath, pe64);
      fs.writeFileSync(
        path.join(gameInstallDir, 'MicrosoftGame.config'),
        `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="SynthPub.SynthOfflineGame" Publisher="CN=Synth" Version="1.0.0.0" />
  <TitleId>2B3C4D5E</TitleId>
  <StoreId>9NOFFLINEGDK</StoreId>
  <Executables><Executable Name="SynthOfflineGame.exe" Id="Game" /></Executables>
</Game>`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(gameInstallDir, '.onelauncher-xbox.json'),
        JSON.stringify({
          packageFamilyName: 'SynthPub.SynthOfflineGame_8wekyb3d8bbwe',
          xboxProductId: '9NOFFLINEGDK',
          xboxTitleId: '725372254',
        }),
        'utf8'
      );

      const offlineFetch = async () => {
        throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      };

      const runLaunchAndInspectLoopbackProfile = async (
        targetPlatform: 'darwin' | 'win32',
        authProvider: Record<string, any>,
        gameIdSuffix: string
      ) => {
        let capturedEnv: Record<string, string> = {};
        let spawnedChild: (EventEmitter & { pid: number; kill: () => boolean; unref: () => void }) | null =
          null;

        const spawnFn = (_cmd: string, _args: string[], opts: any) => {
          capturedEnv = { ...(opts?.env || {}) };
          const ee = Object.assign(new EventEmitter(), {
            pid: 44100,
            kill: () => true,
            unref: () => {},
          });
          spawnedChild = ee;
          return ee;
        };

        const launchRes = await sessionAndProcessSupervisor.launchGame(
          {
            gameId: `xbox-offline-check-${gameIdSuffix}`,
            platformId: 'xbox',
            platformGameId: '9NOFFLINEGDK',
            title: 'Synthetic Offline GDK',
            installPath: gameInstallDir,
            executablePath: gameExePath,
            isClientlessXboxInstall: true,
          },
          {
            platform: targetPlatform,
            homedir: homeDir,
            userDataDir,
            customApplicationsDir,
            spawnFn,
            fetchImpl: offlineFetch,
            xboxAuthProvider: authProvider,
            xboxBridgeDllPath: fakeBridgeDll,
            gameInputBridgeDllPath: fakeGameInputDll,
            xboxAppNotifyBridgeDllPath: fakeAppNotifyDll,
            forceClientlessXboxOnWin32: true,
            disableXboxWinLauncher: true,
          }
        );

        expect(launchRes.success).toBe(true);
        const loopbackPort = Number(capturedEnv.ONE_XGR_PORT || 0);
        const loopbackKey = String(capturedEnv.ONE_XGR_KEY || '');
        expect(loopbackPort).toBeGreaterThan(0);
        expect(loopbackKey).toHaveLength(64);

        try {
          const rpcInit = await sendLoopbackRpc(loopbackPort, loopbackKey, 'session.init', {});
          expect(rpcInit.ok).toBe(true);
          return rpcInit.result;
        } finally {
          if (spawnedChild) {
            (spawnedChild as EventEmitter).emit('exit', 0, null);
          }
          await sessionAndProcessSupervisor.waitForActivePostSessionWork();
        }
      };

      // Case A (darwin): Connected user hits ENOTFOUND -> falls back to cached { xuid, gamertag, uhs, offline: true }
      const darwinConnectedOfflineAuth = {
        async getValidXboxSession() {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND user.auth.xboxlive.com'), {
            code: 'ENOTFOUND',
          });
        },
        getAuthStatus() {
          return { connected: true, authenticated: true };
        },
        getCachedProfile() {
          return { xuid: SYNTH_XUID, gamertag: SYNTH_GAMERTAG, uhs: SYNTH_UHS };
        },
      };
      const darwinSessionInit = await runLaunchAndInspectLoopbackProfile(
        'darwin',
        darwinConnectedOfflineAuth,
        'darwin-connected'
      );
      expect(darwinSessionInit.xuid).toBe(SYNTH_XUID);
      expect(darwinSessionInit.gamertag).toBe(SYNTH_GAMERTAG);

      // Case B (win32): Connected user hits ETIMEDOUT -> falls back to cached { xuid, gamertag, uhs, offline: true }
      const win32ConnectedOfflineAuth = {
        async getValidXboxSession() {
          throw Object.assign(new Error('connect ETIMEDOUT 20.42.0.1:443'), {
            code: 'ETIMEDOUT',
          });
        },
        getAuthStatus() {
          return { connected: true, authenticated: true };
        },
        getCachedProfile() {
          return { xuid: SYNTH_XUID, gamertag: SYNTH_GAMERTAG, uhs: SYNTH_UHS };
        },
      };
      const win32SessionInit = await runLaunchAndInspectLoopbackProfile(
        'win32',
        win32ConnectedOfflineAuth,
        'win32-connected'
      );
      expect(win32SessionInit.xuid).toBe(SYNTH_XUID);
      expect(win32SessionInit.gamertag).toBe(SYNTH_GAMERTAG);

      // Case C (Logged-out guard): Explicit connected === false MUST NOT leak stale cached profile!
      const loggedOutStaleAuth = {
        async getValidXboxSession() {
          return null;
        },
        getAuthStatus() {
          return { connected: false, authenticated: false, loggedOut: true };
        },
        getCachedProfile() {
          return { xuid: SYNTH_XUID, gamertag: SYNTH_GAMERTAG, uhs: SYNTH_UHS };
        },
      };
      const loggedOutSessionInit = await runLaunchAndInspectLoopbackProfile(
        'darwin',
        loggedOutStaleAuth,
        'logged-out'
      );
      expect(loggedOutSessionInit.xuid).not.toBe(SYNTH_XUID);
      expect(loggedOutSessionInit.gamertag).not.toBe(SYNTH_GAMERTAG);
    });
  });

  // ==========================================================================
  // 2. Xbox Catalog Attribution & Vault Self-Healing (F-CHAIN-01 & F-CHAIN-02)
  // ==========================================================================
  describe('Domain 2: Xbox Catalog Attribution & Vault Self-Healing (F-CHAIN-01 & F-CHAIN-02)', () => {
    it('preserves stub metadata, full PC install sizes, rockstar handoff, standalone >100MiB MSIXVC immunity, cross-platform mac runtime, and non-game suppression end-to-end through syncXboxCatalog -> sanitizeGameCatalog -> OfflineVaultService', async () => {
      const vaultUserDataDir = path.join(tmpRoot, 'vault-userdata');
      fs.mkdirSync(vaultUserDataDir, { recursive: true });

      const GIB = 1024 * 1024 * 1024;
      const MIB = 1024 * 1024;

      const bnetStubProduct = {
        ProductId: '9NBNETSTUB01',
        ProductKind: 'Game',
        LocalizedProperties: [
          {
            ProductTitle: 'Synthetic Dungeon IV (PC)',
            DeveloperName: 'Blizzard Entertainment',
            PublisherName: 'Blizzard Entertainment',
            ShortDescription: 'Action RPG delegated to Battle.net via Game Pass account link.',
          },
        ],
        Properties: {
          PackageFamilyName: 'BlizzardEntertainment.SynthDungeonStub_kdg5n7x41qwkg',
          ApproximateSizeInBytes: 90 * GIB,
        },
        DisplaySkuAvailabilities: [
          {
            Sku: {
              SkuId: '0010',
              Properties: {
                FulfillmentData: { WuCategoryId: '11111111-2222-3333-4444-555555555555' },
                Packages: [
                  {
                    PackageId: 'bnet-gdk-stub',
                    PackageFullName:
                      'BlizzardEntertainment.SynthDungeonStub_1.0.0.0_x64__kdg5n7x41qwkg',
                    ContentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001',
                    PackageFormat: 'MSIXVC',
                    MaxDownloadSizeInBytes: 12 * MIB,
                    PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
                    FulfillmentData: {
                      WuCategoryId: '11111111-2222-3333-4444-555555555555',
                    },
                  },
                ],
                AdditionalIdentifiers: [],
              },
              LocalizedProperties: [
                {
                  MinimumNotes: 'Storage: 90 GB available space',
                },
              ],
            },
            Availabilities: [{ Actions: ['Fulfill', 'Browse', 'Purchase'] }],
          },
        ],
        MarketProperties: [{ OriginalReleaseDate: '2024-03-28T00:00:00Z' }],
      };

      const rockstarStubProduct = {
        ProductId: '9NROCKSTAR01',
        ProductKind: 'Game',
        LocalizedProperties: [
          {
            ProductTitle: 'Synthetic Metro V (PC)',
            DeveloperName: 'Synthetic North Studio',
            PublisherName: 'Rockstar Games',
            ShortDescription: 'Includes Story Mode and online play via Rockstar Games Launcher.',
          },
        ],
        Properties: {
          PackageFamilyName: 'RockstarGames.SynthMetroStub_8wekyb3d8bbwe',
        },
        DisplaySkuAvailabilities: [
          {
            Sku: {
              SkuId: '0010',
              Properties: {
                MaxInstallSizeInBytes: 110 * GIB,
                Packages: [
                  {
                    PackageId: 'rgl-gdk-stub',
                    PackageFullName: 'RockstarGames.SynthMetroStub_1.0.0.0_x64__8wekyb3d8bbwe',
                    ContentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0002',
                    PackageFormat: 'MSIXVC',
                    MaxDownloadSizeInBytes: 14 * MIB,
                    PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
                  },
                ],
              },
              LocalizedProperties: [
                {
                  MinimumNotes: 'Storage: 110 GB SSD required',
                },
              ],
            },
            Availabilities: [{ Actions: ['Fulfill', 'Browse'] }],
          },
        ],
      };

      const standaloneNativeMsixvcProduct = {
        ProductId: '9NNATIVEMSIX',
        ProductKind: 'Game',
        LocalizedProperties: [
          {
            ProductTitle: 'Synthetic Native GDK Cosmos-Class Title',
            DeveloperName: 'Synthetic Studio',
            PublisherName: 'Ubisoft', // Publisher makes chained titles, but THIS title ships a full 68 GiB standalone MSIXVC!
            ShortDescription: 'Standalone native Win32 GDK MSIXVC package.',
          },
        ],
        Properties: {
          PackageFamilyName: 'SyntheticStudio.SynthCosmosClass_8wekyb3d8bbwe',
          XboxLiveTitleId: '1987654321',
        },
        DisplaySkuAvailabilities: [
          {
            Sku: {
              SkuId: '0010',
              Properties: {
                Packages: [
                  {
                    PackageId: 'native-full-msixvc',
                    PackageFullName:
                      'SyntheticStudio.SynthCosmosClass_1.2.0.0_x64__8wekyb3d8bbwe',
                    ContentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0003',
                    PackageFormat: 'MSIXVC',
                    MaxDownloadSizeInBytes: 68 * GIB,
                    PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
                  },
                ],
              },
            },
            Availabilities: [{ Actions: ['Fulfill', 'Browse'] }],
          },
        ],
      };

      const crossPlatformJavaEditionProduct = {
        ProductId: '9NCROSSMAC01',
        ProductKind: 'Game',
        LocalizedProperties: [
          {
            ProductTitle: 'Synthetic Voxel: Java Edition',
            DeveloperName: 'Synthetic Voxel Studio',
            PublisherName: 'Xbox Game Studios',
            ShortDescription: 'Cross-platform Java Edition runtime.',
          },
        ],
        Properties: {
          PackageFamilyName: 'Microsoft.SynthJavaRuntime_8wekyb3d8bbwe',
        },
        DisplaySkuAvailabilities: [
          {
            Sku: {
              SkuId: '0010',
              Properties: {
                Packages: [
                  {
                    PackageId: 'cross-bootstrapper',
                    PackageFullName: 'Microsoft.SynthJavaRuntime_1.1.28.0_x64__8wekyb3d8bbwe',
                    ContentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0004',
                    PackageFormat: 'MSIXVC',
                    MaxDownloadSizeInBytes: 18 * MIB,
                    PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
                  },
                ],
              },
            },
            Availabilities: [{ Actions: ['Fulfill', 'Browse'] }],
          },
        ],
      };

      const standaloneLauncherClientProduct = {
        ProductId: '9NMCLAUNCH01',
        ProductKind: 'Game',
        LocalizedProperties: [
          {
            ProductTitle: 'Minecraft Launcher',
            DeveloperName: 'Synthetic Voxel Studio',
            PublisherName: 'Xbox Game Studios',
          },
        ],
        Properties: {
          PackageFamilyName: 'Microsoft.SynthLauncherClient_8wekyb3d8bbwe',
        },
        DisplaySkuAvailabilities: [
          {
            Sku: {
              SkuId: '0010',
              Properties: {
                Packages: [
                  {
                    PackageFullName: 'Microsoft.SynthLauncherClient_1.1.28.0_x64__8wekyb3d8bbwe',
                    PackageFormat: 'MSIXVC',
                    MaxDownloadSizeInBytes: 12 * MIB,
                    PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
                  },
                ],
              },
            },
            Availabilities: [{ Actions: ['Fulfill'] }],
          },
        ],
      };

      // Verify standalone storefront launcher utility classifier directly across all chained clients
      for (const utilityTitle of [
        'Minecraft Launcher',
        'EA App',
        'Ubisoft Connect',
        'Battle.net',
        'Rockstar Games Launcher',
        'Riot Client',
      ]) {
        const cls = nonGameClassifier.classifyNonGameStorefrontItem({
          title: utilityTitle,
          platformId: 'xbox',
        });
        expect(typeof cls).toBe('string');
        expect(cls).toContain('Filtered:');
      }

      const catalogByBigId = new Map<string, any>([
        ['9NBNETSTUB01', bnetStubProduct],
        ['9NROCKSTAR01', rockstarStubProduct],
        ['9NNATIVEMSIX', standaloneNativeMsixvcProduct],
        ['9NCROSSMAC01', crossPlatformJavaEditionProduct],
        ['9NMCLAUNCH01', standaloneLauncherClientProduct],
      ]);

      const mockFetch = vi.fn(async (rawUrl: string) => {
        const url = String(rawUrl);
        if (url.includes('/entitlements/subscriptions')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              subscriptions: [
                {
                  productId: 'CFQ7TTC0KGQ8', // PC Game Pass
                  skuId: '0010',
                  status: 'Active',
                },
              ],
            }),
            text: async () => '',
          };
        }
        if (url.includes('/entitlements') || url.includes('collections/query')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: Array.from(catalogByBigId.keys()).map((pid) => ({
                productId: pid,
                skuId: '0010',
                status: 'Active',
                productKind: 'Game',
              })),
            }),
            text: async () => '',
          };
        }
        if (url.includes('catalog.gamepass.com/sigls/v2')) {
          return {
            ok: true,
            status: 200,
            json: async () => [{ siglId: 'fdd9e2a7-0fee-49f6-ad69-4354098401ff' }],
            text: async () => '',
          };
        }
        if (url.includes('displaycatalog.mp.microsoft.com')) {
          const parsedUrl = new URL(url);
          const requestedIds = (parsedUrl.searchParams.get('bigIds') || '')
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean);
          const Products = requestedIds
            .map((id) => catalogByBigId.get(id))
            .filter(Boolean);
          return {
            ok: true,
            status: 200,
            json: async () => ({ Products }),
            text: async () => '',
          };
        }
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      });

      const syncRes = await xboxCatalogAndGamePass.syncXboxCatalog({
        userDataDir: vaultUserDataDir,
        syncMode: 'full_pc_game_pass',
        fetchImpl: mockFetch,
        authProvider: {
          async getStoreMsaToken() {
            return 't=SYNTH_STORE_TICKET';
          },
          async checkMinecraftJavaEntitlement() {
            return { owned: true, productId: '9NCROSSMAC01', permanentOwnership: true };
          },
        },
      });

      try {
        // Standalone `Minecraft Launcher` utility must be suppressed into `suppressedItems`
        expect(syncRes.suppressedItems.some((s: any) => s.platformGameId === '9NMCLAUNCH01')).toBe(
          true
        );
        expect(syncRes.games.some((g: any) => g.id === 'xbox-9NMCLAUNCH01')).toBe(false);

        // Sanitize through renderer catalogSanitizer -> persist into SQLite OfflineVaultService -> cold reload
        const sanitized = sanitizeGameCatalog(syncRes.games as CanonicalGame[]);
        expect(sanitized).toHaveLength(4);

        const vaultWriter = offlineVaultMod.createOfflineVaultService({
          userDataDir: vaultUserDataDir,
        });
        let snapshot: any;
        try {
          const upsertRes = vaultWriter.upsertGames(sanitized);
          expect(upsertRes.success).toBe(true);
        } finally {
          vaultWriter.shutdown();
        }

        const vaultReader = offlineVaultMod.createOfflineVaultService({
          userDataDir: vaultUserDataDir,
        });
        try {
          snapshot = vaultReader.getCatalogSnapshot();
        } finally {
          vaultReader.shutdown();
        }

        const vaultGames: CanonicalGame[] = snapshot.games;
        expect(vaultGames).toHaveLength(4);

        // 1) Battle.net stub preserves stub flag, externalLauncher, reason, and full 90 GiB PC size (not 12 MiB!)
        const bnetGame = vaultGames.find((g) => g.id === 'xbox-9NBNETSTUB01')!;
        expect(bnetGame).toBeDefined();
        const bnetPlat = bnetGame.platforms[0];
        expect(bnetPlat.isExternalLauncherStubPackage).toBe(true);
        expect(bnetPlat.chainedLauncherHandoff).toBe('bnet');
        expect(bnetPlat.externalLauncher).toBe('Battle.net');
        expect(bnetPlat.externalLauncherUrl).toBeTruthy();
        expect(bnetPlat.xboxBottleCompatibilityReason).toBeTruthy();
        expect(bnetPlat.pcMaxInstallSizeBytes).toBe(90 * GIB);
        expect(bnetPlat.maxDownloadSizeBytes).toBe(90 * GIB);

        // 2) Rockstar stub attributes `rockstar` handoff and promotes 110 GiB size over 14 MiB stub
        const rockstarGame = vaultGames.find((g) => g.id === 'xbox-9NROCKSTAR01')!;
        expect(rockstarGame).toBeDefined();
        const rockstarPlat = rockstarGame.platforms[0];
        expect(rockstarPlat.isExternalLauncherStubPackage).toBe(true);
        expect(rockstarPlat.chainedLauncherHandoff).toBe('rockstar');
        expect(rockstarPlat.externalStorefrontHandoff).toBe('rockstar');
        expect(rockstarPlat.externalLauncher).toBe('Rockstar Games Launcher');
        expect(rockstarPlat.externalLauncherUrl).toBe(
          'https://socialclub.rockstargames.com/rockstar-games-launcher'
        );
        expect(rockstarPlat.pcMaxInstallSizeBytes).toBe(110 * GIB);
        expect(rockstarPlat.maxDownloadSizeBytes).toBe(110 * GIB);

        // 3) Standalone >100 MiB (68 GiB) native MSIXVC is NOT misclassified as external launcher stub!
        const nativeGdkGame = vaultGames.find((g) => g.id === 'xbox-9NNATIVEMSIX')!;
        expect(nativeGdkGame).toBeDefined();
        const nativePlat = nativeGdkGame.platforms[0];
        expect(nativePlat.isExternalLauncherStubPackage).toBeUndefined();
        expect(nativePlat.chainedLauncherHandoff).toBeUndefined();
        expect(nativePlat.maxDownloadSizeBytes).toBe(68 * GIB);

        // 4) Cross-platform Java Edition (<=100 MiB bootstrapper + runtime entitlement) sets mac: true & isCrossPlatformLauncherRuntime: true
        const crossGame = vaultGames.find((g) => g.id === 'xbox-9NCROSSMAC01')!;
        expect(crossGame).toBeDefined();
        const crossPlat = crossGame.platforms[0];
        expect(crossPlat.isCrossPlatformLauncherRuntime).toBe(true);
        expect(crossPlat.platforms?.mac).toBe(true);
        expect(crossGame.worksOn?.mac).toBe(true);
      } finally {
        xboxCatalogAndGamePass.closeXboxCatalogCacheStore({ userDataDir: vaultUserDataDir });
      }
    });
  });

  // ==========================================================================
  // 3. Chained Publisher Provisioning, Scanners, Auth & Launch CLI (F-CHAIN-03 – F-CHAIN-12)
  // ==========================================================================
  describe('Domain 3: Chained Publisher Provisioning, Scanners, Auth & Launch CLI (F-CHAIN-03 – F-CHAIN-12)', () => {
    it('F-CHAIN-03: aligns resolveDefaultChainedBottleName across Setup Wizard preferredBottleName, health prober, provisioner, install queue & launch supervisor', async () => {
      const discovered = [
        { name: 'CustomGamingBottle', hasSteam: false },
        { name: 'Steam', hasSteam: true },
      ];
      // Explicit > GameConfig > Wizard preferredBottleName > OneLauncher > Steam > first discovered
      expect(
        chainedPublisherLaunchers.resolveDefaultChainedBottleName({
          wizardPreferredBottleName: 'customgamingbottle',
          discoveredBottleNames: discovered,
          runnerType: 'crossover',
        })
      ).toBe('CustomGamingBottle');

      expect(
        chainedPublisherLaunchers.resolveDefaultChainedBottleName({
          discoveredBottleNames: discovered,
          runnerType: 'crossover',
        })
      ).toBe('Steam');

      expect(
        chainedPublisherLaunchers.resolveDefaultChainedBottleName({
          discoveredBottleNames: [...discovered, 'OneLauncher'],
          runnerType: 'crossover',
        })
      ).toBe('OneLauncher');

      expect(
        chainedPublisherLaunchers.resolveDefaultChainedBottleName({
          discoveredBottleNames: [],
          runnerType: 'wine',
        })
      ).toBe('default');

      // Verify end-to-end alignment with environmentHealthProber when Setup Wizard state sets preferredBottleName
      const homeDir = path.join(tmpRoot, 'WizardAlignHome');
      const userDataDir = path.join(homeDir, '.one-launcher');
      const customAppsDir = path.join(homeDir, 'Applications');
      const bottlesRoot = path.join(homeDir, 'Library/Application Support/CrossOver/Bottles');
      const wizBottleDir = path.join(bottlesRoot, 'WizardChosenBottle');
      const otherBottleDir = path.join(bottlesRoot, 'Steam');
      fs.mkdirSync(path.join(wizBottleDir, 'drive_c'), { recursive: true });
      fs.mkdirSync(path.join(otherBottleDir, 'drive_c'), { recursive: true });
      fs.mkdirSync(userDataDir, { recursive: true });
      environmentHealthProber.saveSetupWizardState(
        {
          preferredRunnerType: 'crossover',
          preferredBottleName: 'WizardChosenBottle',
        },
        { homedir: homeDir, userDataDir }
      );

      const fakeCxWine = path.join(
        customAppsDir,
        'CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine'
      );
      fs.mkdirSync(path.dirname(fakeCxWine), { recursive: true });
      fs.writeFileSync(fakeCxWine, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const probeSnap = await environmentHealthProber.probeEnvironmentHealth({
        platform: 'darwin',
        homedir: homeDir,
        userDataDir,
        customApplicationsDir: customAppsDir,
      });
      expect(probeSnap.bottleSummary.recommendedBottleName).toBe('WizardChosenBottle');
      expect(probeSnap.bottleSummary.activeBottlePath).toBe(wizBottleDir);
    });

    it('F-CHAIN-04 & CrossOver 26.3.0: strips Run/RunOnce autostart entries across ea/ubisoft/bnet/rockstar in user.reg & system.reg, applies CX_ROOT/CX_HOME/DOTNET_EnableWriteXorExecute=0, and strips global wined3d from cxbottle.conf', () => {
      const bottleDir = path.join(tmpRoot, 'BottleHygiene');
      fs.mkdirSync(bottleDir, { recursive: true });

      fs.writeFileSync(
        path.join(bottleDir, 'user.reg'),
        `WINE REGISTRY Version 2

[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run] 1730000001
"EA Background Service"="\\"C:\\\\Program Files\\\\Electronic Arts\\\\EA Desktop\\\\EA Desktop\\\\EABackgroundService.exe\\""
"Ubisoft Connect"="\\"C:\\\\Program Files (x86)\\\\Ubisoft\\\\Ubisoft Game Launcher\\\\UbisoftConnect.exe\\" -upc_uplay_id"
"KeepUserTool"="\\"C:\\\\Tools\\\\AudioHelper.exe\\""

[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\RunOnce] 1730000002
"Battle.net"="\\"C:\\\\Program Files (x86)\\\\Battle.net\\\\Battle.net Launcher.exe\\" --autostart"

[Software\\\\Electronic Arts\\\\EA Desktop] 1730000003
"startOnBootFlag"=dword:00000001
`,
        'utf8'
      );

      fs.writeFileSync(
        path.join(bottleDir, 'system.reg'),
        `WINE REGISTRY Version 2

[Software\\\\Wow6432Node\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run] 1730000004
"Rockstar Games Launcher"="\\"C:\\\\Program Files\\\\Rockstar Games\\\\Launcher\\\\Launcher.exe\\" -minmodeApp=tray"
"Battle.net Helper"="\\"C:\\\\Program Files (x86)\\\\Battle.net\\\\Battle.net.exe\\""
"SystemDriverKeep"="\\"C:\\\\Windows\\\\System32\\\\spoolsv.exe\\""

[Software\\\\Wow6432Node\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\RunOnce] 1730000005
"UplayLaunch"="\\"C:\\\\Program Files (x86)\\\\Ubisoft\\\\Ubisoft Game Launcher\\\\upc.exe\\""
`,
        'utf8'
      );

      const modified = chainedPublisherLaunchers.sanitizeChainedPublisherAutostartInBottleRegs(
        bottleDir
      );
      expect(modified).toBe(true);

      const cleanedUserReg = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      const cleanedSysReg = fs.readFileSync(path.join(bottleDir, 'system.reg'), 'utf8');

      expect(cleanedUserReg).not.toContain('EABackgroundService.exe');
      expect(cleanedUserReg).not.toContain('UbisoftConnect.exe');
      expect(cleanedUserReg).not.toContain('Battle.net Launcher.exe');
      expect(cleanedUserReg).toContain('"KeepUserTool"');
      expect(cleanedUserReg).toContain('"startOnBootFlag"=dword:00000000');

      expect(cleanedSysReg).not.toContain('Rockstar Games');
      expect(cleanedSysReg).not.toContain('Battle.net.exe');
      expect(cleanedSysReg).not.toContain('upc.exe');
      expect(cleanedSysReg).toContain('"SystemDriverKeep"');

      // Idempotent second pass returns false
      expect(
        chainedPublisherLaunchers.sanitizeChainedPublisherAutostartInBottleRegs(bottleDir)
      ).toBe(false);

      // CrossOver 26.3.0 env hygiene: CX_ROOT, CX_HOME, DOTNET_EnableWriteXorExecute='0'
      const cxRootDir = path.join(
        tmpRoot,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver'
      );
      const cxWineBin = path.join(cxRootDir, 'bin', 'wine');
      fs.mkdirSync(path.dirname(cxWineBin), { recursive: true });
      fs.writeFileSync(cxWineBin, '#!/usr/bin/perl\nexit 0;\n', { mode: 0o755 });

      const synthHome = path.join(tmpRoot, 'Users', 'TestPlayer');
      const envObj: Record<string, string> = {};
      wineAndCrossOverManager.applyCrossOverEnvironmentHygiene(envObj, {
        platform: 'darwin',
        homedir: synthHome,
        wineBinaryPath: cxWineBin,
        layerType: 'crossover',
      });
      expect(envObj.CX_ROOT).toBe(cxRootDir);
      expect(envObj.CX_HOME).toBe(path.join(synthHome, 'Library', 'Application Support', 'CrossOver'));
      expect(envObj.DOTNET_EnableWriteXorExecute).toBe('0');

      // cxbottle.conf global wined3d stripping
      const confPath = path.join(bottleDir, 'cxbottle.conf');
      fs.writeFileSync(
        confPath,
        `[Bottle]\n"WineVersion" = "26.3.0"\n\n[EnvironmentVariables]\n"CX_GRAPHICS_BACKEND" = "wined3d"\n"WINEDEBUG" = "-all"\n`,
        'utf8'
      );
      expect(wineAndCrossOverManager.sanitizeProvisionedBottleGraphicsBackend(bottleDir)).toBe(true);
      const cleanedConf = fs.readFileSync(confPath, 'utf8');
      expect(cleanedConf).not.toContain('wined3d');
      expect(cleanedConf).toContain('"WINEDEBUG" = "-all"');
      expect(wineAndCrossOverManager.sanitizeProvisionedBottleGraphicsBackend(bottleDir)).toBe(false);
    });

    it('F-CHAIN-05, F-CHAIN-06 & F-CHAIN-07: detects macOS native EA/Battle.net/Riot .app bundles, enforces Riot win32-only bootstrapper (supportedInWineBottle: false), and validates ground-truth auth probes across EA 13.813+ nested CEF, Battle.net, Ubisoft, Rockstar & Riot', async () => {
      const macAppsDir = path.join(tmpRoot, 'Applications');
      const eaMacBin = path.join(macAppsDir, 'EA app.app', 'Contents', 'MacOS', 'EADesktop');
      const bnetMacBin = path.join(macAppsDir, 'Battle.net.app', 'Contents', 'MacOS', 'Battle.net');
      const riotMacBin = path.join(
        macAppsDir,
        'Riot Client.app',
        'Contents',
        'MacOS',
        'RiotClientServices'
      );
      fs.mkdirSync(path.dirname(eaMacBin), { recursive: true });
      fs.mkdirSync(path.dirname(bnetMacBin), { recursive: true });
      fs.mkdirSync(path.dirname(riotMacBin), { recursive: true });
      fs.writeFileSync(eaMacBin, '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(bnetMacBin, '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(riotMacBin, '#!/bin/sh\n', { mode: 0o755 });

      const eaBundle = chainedPublisherLaunchers.detectMacNativePublisherBundle('ea', {
        customApplicationsDir: macAppsDir,
      });
      const bnetBundle = chainedPublisherLaunchers.detectMacNativePublisherBundle('bnet', {
        customApplicationsDir: macAppsDir,
      });
      const riotBundle = chainedPublisherLaunchers.detectMacNativePublisherBundle('riot', {
        customApplicationsDir: macAppsDir,
      });
      expect(eaBundle).toMatchObject({ installed: true, handoffId: 'ea', binaryPath: eaMacBin });
      expect(bnetBundle).toMatchObject({ installed: true, handoffId: 'bnet', binaryPath: bnetMacBin });
      expect(riotBundle).toMatchObject({ installed: true, handoffId: 'riot', binaryPath: riotMacBin });

      // F-CHAIN-06: Riot ecosystem exposes official win32 bootstrapper while blocking Wine bottles (vgk.sys)
      const riotEco = chainedPublisherLaunchers.CHAINED_PUBLISHER_ECOSYSTEMS.riot;
      expect(riotEco.installerUrl).toMatch(/^https:\/\//);
      expect(riotEco.installerFileName).toBe('Install Riot Client.exe');
      expect(riotEco.silentArgs).toEqual(['--skip-to-install']);
      expect(riotEco.supportedInWineBottle).toBe(false);
      expect(riotEco.unsupportedBottleReason).toContain('vgk.sys');

      await expect(
        environmentProvisioner.ensureChainedPublisherLauncherInstalled(
          { handoffId: 'riot', platform: 'darwin' },
          { platform: 'darwin', homedir: tmpRoot }
        )
      ).rejects.toThrow(/vgk\.sys|Wine\/CrossOver/i);

      // F-CHAIN-07: Ground-truth auth probes reject logged-out states & detect EA 13.813+ nested CEF Cookies!
      // 0) EA Desktop 13.813+ nested `CEF/2/EADesktop/BrowserCache/Network/Cookies` (> 4096 B) + `user_*.ini`
      const eaLocalDir13813 = path.join(tmpRoot, 'EADesktopLocal13813');
      const eaNestedCookiesPath = path.join(
        eaLocalDir13813,
        'CEF',
        '2',
        'EADesktop',
        'BrowserCache',
        'Network',
        'Cookies'
      );
      fs.mkdirSync(path.dirname(eaNestedCookiesPath), { recursive: true });
      fs.writeFileSync(eaNestedCookiesPath, Buffer.alloc(8192, 0x53));
      fs.writeFileSync(
        path.join(eaLocalDir13813, 'user_1001.ini'),
        'user.ignoreRememberMe=false\n',
        'utf8'
      );
      expect(chainedPublisherLaunchers.hasEaLocalSessionInDir(eaLocalDir13813)).toBe(true);
      fs.writeFileSync(
        path.join(eaLocalDir13813, 'user_1001.ini'),
        'user.ignoreRememberMe=true\n',
        'utf8'
      );
      expect(chainedPublisherLaunchers.hasEaLocalSessionInDir(eaLocalDir13813)).toBe(false);

      // 1) Battle.net: SavedAccountNames present + AutoLogin: "false" -> FALSE; AutoLogin: "true" -> TRUE
      const bnetCfgPath = path.join(tmpRoot, 'Battle.net.config');
      fs.writeFileSync(
        bnetCfgPath,
        JSON.stringify({
          Client: { SavedAccountNames: 'testplayer@example.test', AutoLogin: 'false' },
        }),
        'utf8'
      );
      expect(chainedPublisherLaunchers.hasBattleNetLocalSessionInConfigFile(bnetCfgPath)).toBe(false);
      fs.writeFileSync(
        bnetCfgPath,
        JSON.stringify({
          Client: { SavedAccountNames: 'testplayer@example.test', AutoLogin: 'true' },
        }),
        'utf8'
      );
      expect(chainedPublisherLaunchers.hasBattleNetLocalSessionInConfigFile(bnetCfgPath)).toBe(true);

      // 2) Ubisoft: user.dat exists + settings.yml remember_me: false -> FALSE; remember_me: true -> TRUE
      const ubiLocalDir = path.join(tmpRoot, 'Ubisoft Game Launcher');
      fs.mkdirSync(ubiLocalDir, { recursive: true });
      fs.writeFileSync(path.join(ubiLocalDir, 'users.dat'), Buffer.alloc(128, 0x42));
      fs.writeFileSync(
        path.join(ubiLocalDir, 'settings.yml'),
        'user:\n  remember_me: false\n  syncsavegames: true\n',
        'utf8'
      );
      expect(chainedPublisherLaunchers.hasUbisoftLocalSessionInDir(ubiLocalDir)).toBe(false);
      fs.writeFileSync(
        path.join(ubiLocalDir, 'settings.yml'),
        'user:\n  remember_me: true\n  syncsavegames: true\n',
        'utf8'
      );
      expect(chainedPublisherLaunchers.hasUbisoftLocalSessionInDir(ubiLocalDir)).toBe(true);

      // 3) Rockstar: Empty Social Club profile dir `<hex>` -> FALSE; non-empty settings_account.dat -> TRUE
      const rglLocalDir = path.join(tmpRoot, 'RockstarLocal');
      const emptyScProfilesDir = path.join(tmpRoot, 'Documents/Rockstar Games/Social Club/Profiles');
      fs.mkdirSync(path.join(emptyScProfilesDir, 'A1B2C3D4'), { recursive: true });
      expect(
        chainedPublisherLaunchers.hasRockstarLocalSessionInDir(rglLocalDir, emptyScProfilesDir)
      ).toBe(false);
      const rglHexDir = path.join(rglLocalDir, 'profiles', 'A1B2C3D4');
      fs.mkdirSync(rglHexDir, { recursive: true });
      fs.writeFileSync(path.join(rglHexDir, 'settings_account.dat'), Buffer.from('SYNTH_AUTH_BLOB'));
      expect(
        chainedPublisherLaunchers.hasRockstarLocalSessionInDir(rglLocalDir, emptyScProfilesDir)
      ).toBe(true);

      // 4) Riot: Telemetry-only `tdid` without `ssid` -> FALSE; `ssid` present -> TRUE
      const riotYamlPath = path.join(tmpRoot, 'RiotGamesPrivateSettings.yaml');
      fs.writeFileSync(
        riotYamlPath,
        `riot-login:
  persist:
    region: "NA"
    session:
      cookies:
        - domain: "auth.riotgames.com"
          name: "tdid"
          value: "telemetry-only-device-cookie"
`,
        'utf8'
      );
      expect(chainedPublisherLaunchers.hasRiotLocalSessionInFile(riotYamlPath)).toBe(false);
      fs.writeFileSync(
        riotYamlPath,
        `riot-login:
  persist:
    region: "NA"
    session:
      cookies:
        - domain: "auth.riotgames.com"
          name: "ssid"
          value: "synth-authenticated-riot-session-cookie"
`,
        'utf8'
      );
      expect(chainedPublisherLaunchers.hasRiotLocalSessionInFile(riotYamlPath)).toBe(true);
    });

    it('F-CHAIN-08: scans installed games across EA (machine.ini), Ubisoft (settings.yaml 175.x), Battle.net (product.db), Rockstar & Riot in both darwin bottles and win32 hosts', () => {
      const pe64 = buildValidMinimalPe64Buffer();

      // 1) Bottle scan (`darwin`) across EA, Ubisoft (`settings.yaml` 175.x), Battle.net (`product.db`), and Rockstar
      const bottleDir = path.join(tmpRoot, 'ScannerBottle');
      const driveC = path.join(bottleDir, 'drive_c');
      const eaGameDir = path.join(driveC, 'CustomEaLib', 'Synthetic Galaxy Quest');
      const ubiGameDir = path.join(driveC, 'UbisoftCustomLib', 'Synthetic Sands Quest');
      const bnetGameDir = path.join(driveC, 'Program Files (x86)', 'Synthetic Dungeon IV');
      const rglGameDir = path.join(driveC, 'Program Files', 'Rockstar Games', 'Synthetic Noir 3');

      fs.mkdirSync(path.join(eaGameDir, '__Installer'), { recursive: true });
      fs.mkdirSync(ubiGameDir, { recursive: true });
      fs.mkdirSync(bnetGameDir, { recursive: true });
      fs.mkdirSync(rglGameDir, { recursive: true });

      fs.writeFileSync(path.join(eaGameDir, 'SynthGalaxy.exe'), pe64);
      fs.writeFileSync(
        path.join(eaGameDir, '__Installer', 'installerdata.xml'),
        `<?xml version="1.0" encoding="utf-8"?><DiPManifest><contentIDs><contentID>Origin.OFR.50.0009999</contentID></contentIDs><gameTitles><gameTitle locale="en_US">Synthetic Galaxy Quest</gameTitle></gameTitles></DiPManifest>`,
        'utf8'
      );
      const eaMachineIniDir = path.join(driveC, 'ProgramData', 'EA Desktop');
      fs.mkdirSync(eaMachineIniDir, { recursive: true });
      fs.writeFileSync(
        path.join(eaMachineIniDir, 'machine.ini'),
        'machine.downloadinplacedir=C:\\CustomEaLib\n',
        'utf8'
      );

      fs.writeFileSync(path.join(ubiGameDir, 'SynthSands.exe'), pe64);
      const ubiBottleCfgDir = path.join(
        driveC,
        'users',
        'crossover',
        'AppData',
        'Local',
        'Ubisoft Game Launcher'
      );
      fs.mkdirSync(ubiBottleCfgDir, { recursive: true });
      fs.writeFileSync(
        path.join(ubiBottleCfgDir, 'settings.yaml'),
        'misc:\n  game_installation_path: "C:/UbisoftCustomLib/"\n',
        'utf8'
      );

      fs.writeFileSync(path.join(bnetGameDir, 'SynthDungeon4.exe'), pe64);
      const bnetAgentDir = path.join(driveC, 'ProgramData', 'Battle.net', 'Agent');
      fs.mkdirSync(bnetAgentDir, { recursive: true });
      fs.writeFileSync(
        path.join(bnetAgentDir, 'product.db'),
        buildSyntheticBattleNetProductInstallBytes({
          uid: 'fenris',
          productCode: 'fenris',
          installPath: 'C:/Program Files (x86)/Synthetic Dungeon IV',
          installed: true,
          playable: true,
        })
      );

      fs.writeFileSync(path.join(rglGameDir, 'SynthNoir3.exe'), pe64);

      const bottleScanned = chainedPublisherLaunchers.scanBottlePublisherInstalledGames(bottleDir, {
        platform: 'darwin',
        homedir: tmpRoot,
      });
      expect(bottleScanned.map((g: any) => g.handoffId).sort()).toEqual([
        'bnet',
        'ea',
        'rockstar',
        'ubisoft',
      ]);
      expect(bottleScanned.find((g: any) => g.handoffId === 'bnet')?.launchProductCode).toBe('Fen');
      expect(bottleScanned.find((g: any) => g.handoffId === 'ea')?.externalInstallId).toBe(
        'Origin.OFR.50.0009999'
      );

      // 2) Host scan (`win32`) including Riot `Metadata/*.live/*.product_settings.yaml`
      const winSandbox = path.join(tmpRoot, 'WinScannerHost');
      const winProgData = path.join(winSandbox, 'ProgramData');
      const winLocalApp = path.join(winSandbox, 'AppData', 'Local');
      const winRoamingApp = path.join(winSandbox, 'AppData', 'Roaming');
      const winProgFiles = path.join(winSandbox, 'Program Files');
      const winProgFilesX86 = path.join(winSandbox, 'Program Files (x86)');

      const riotGameDir = path.join(winSandbox, 'Riot Games', 'SyntheticArena', 'live');
      fs.mkdirSync(riotGameDir, { recursive: true });
      fs.writeFileSync(path.join(riotGameDir, 'SynthArena.exe'), pe64);
      const riotMetaDir = path.join(winProgData, 'Riot Games', 'Metadata', 'syntharena.live');
      fs.mkdirSync(riotMetaDir, { recursive: true });
      fs.writeFileSync(
        path.join(riotMetaDir, 'syntharena.live.product_settings.yaml'),
        `product_install_full_path: "${riotGameDir.replace(/\\/g, '/')}"\n`,
        'utf8'
      );

      const winRglDir = path.join(winProgFiles, 'Rockstar Games', 'Synthetic Frontier 2');
      fs.mkdirSync(winRglDir, { recursive: true });
      fs.writeFileSync(path.join(winRglDir, 'SynthFrontier2.exe'), pe64);

      const hostScanned = chainedPublisherLaunchers.scanHostPublisherInstalledGames({
        platform: 'win32',
        homedir: winSandbox,
        programDataDir: winProgData,
        localAppDataDir: winLocalApp,
        appDataDir: winRoamingApp,
        programFilesDir: winProgFiles,
        programFilesX86Dir: winProgFilesX86,
        execFileSyncFn: () => '',
      });
      expect(
        hostScanned.some((g: any) => g.handoffId === 'riot' && g.externalInstallId === 'syntharena')
      ).toBe(true);
      expect(hostScanned.some((g: any) => g.handoffId === 'rockstar')).toBe(true);
    });

    it('F-CHAIN-09, F-CHAIN-10, F-CHAIN-11 & F-CHAIN-12: measures staging delta bytes without walking broad Program Files (x86), decodes Battle.net product.db Protobuf + product codes, and builds Rockstar Launcher.exe -launchTitleInFolder / PlaySynthMetro.exe -nobattleye specs', () => {
      // F-CHAIN-09: Staging byte measurement on darwin bottle & win32 host
      const bottlePath = path.join(tmpRoot, 'StagingBottle');
      const driveC = path.join(bottlePath, 'drive_c');
      const broadProgFilesX86 = path.join(driveC, 'Program Files (x86)');
      const unrelatedHugeDir = path.join(broadProgFilesX86, 'UnrelatedOtherVendor');
      const bnetSpecificDir = path.join(broadProgFilesX86, 'Synthetic Dungeon IV');
      fs.mkdirSync(unrelatedHugeDir, { recursive: true });
      fs.mkdirSync(bnetSpecificDir, { recursive: true });
      fs.writeFileSync(path.join(unrelatedHugeDir, 'unrelated.bin'), Buffer.alloc(64 * 1024, 0xaa));

      // `Battle.net.config` points DefaultInstallPath at broad `C:\Program Files (x86)` — must NEVER walk unrelated dirs!
      const bnetAppDataDir = path.join(driveC, 'users', 'crossover', 'AppData', 'Roaming', 'Battle.net');
      fs.mkdirSync(bnetAppDataDir, { recursive: true });
      fs.writeFileSync(
        path.join(bnetAppDataDir, 'Battle.net.config'),
        JSON.stringify({
          Client: { Install: { DefaultInstallPath: 'C:\\Program Files (x86)' } },
        }),
        'utf8'
      );

      const darwinStagingDirs = chainedPublisherLaunchers.resolvePublisherStagingDirs('bnet', {
        platform: 'darwin',
        bottlePath,
      });
      expect(
        darwinStagingDirs.some(
          (d: string) => path.resolve(d).toLowerCase() === path.resolve(broadProgFilesX86).toLowerCase()
        )
      ).toBe(false);

      const darwinBaseBytes = downloadQueueCoordinator.measurePublisherStagingBytes(
        'bnet',
        'darwin',
        bottlePath,
        { platform: 'darwin', homedir: tmpRoot }
      );
      expect(darwinBaseBytes).toBe(0);

      // Write 16 KiB into Battle.net ProgramData Agent cache and verify exact delta on darwin
      const bnetAgentData = path.join(driveC, 'ProgramData', 'Battle.net', 'Agent', 'data');
      fs.mkdirSync(bnetAgentData, { recursive: true });
      fs.writeFileSync(path.join(bnetAgentData, 'chunk01.idx'), Buffer.alloc(16 * 1024, 0x11));
      const darwinAfterBytes = downloadQueueCoordinator.measurePublisherStagingBytes(
        'bnet',
        'darwin',
        bottlePath,
        { platform: 'darwin', homedir: tmpRoot }
      );
      expect(darwinAfterBytes - darwinBaseBytes).toBe(16 * 1024);

      // Same delta verification on win32 host
      const winHostRoot = path.join(tmpRoot, 'Win32Host');
      const winProgramData = path.join(winHostRoot, 'ProgramData');
      const winLocalAppData = path.join(winHostRoot, 'Users', 'TestPlayer', 'AppData', 'Local');
      const winAppData = path.join(winHostRoot, 'Users', 'TestPlayer', 'AppData', 'Roaming');
      const winProgFilesX86 = path.join(winHostRoot, 'Program Files (x86)');
      fs.mkdirSync(path.join(winProgFilesX86, 'UnrelatedWinApp'), { recursive: true });
      fs.writeFileSync(
        path.join(winProgFilesX86, 'UnrelatedWinApp', 'big.dat'),
        Buffer.alloc(32 * 1024, 0x22)
      );
      fs.mkdirSync(path.join(winAppData, 'Battle.net'), { recursive: true });
      fs.writeFileSync(
        path.join(winAppData, 'Battle.net', 'Battle.net.config'),
        JSON.stringify({
          Client: { Install: { DefaultInstallPath: winProgFilesX86 } },
        }),
        'utf8'
      );

      const winEnvOpts = {
        platform: 'win32',
        homedir: path.join(winHostRoot, 'Users', 'TestPlayer'),
        env: {
          PROGRAMDATA: winProgramData,
          LOCALAPPDATA: winLocalAppData,
          APPDATA: winAppData,
          'PROGRAMFILES(X86)': winProgFilesX86,
          PROGRAMFILES: path.join(winHostRoot, 'Program Files'),
        },
      };
      const winBaseBytes = downloadQueueCoordinator.measurePublisherStagingBytes(
        'bnet',
        'win32',
        '',
        winEnvOpts
      );
      expect(winBaseBytes).toBe(0);
      fs.mkdirSync(path.join(winProgramData, 'Battle.net', 'Agent'), { recursive: true });
      fs.writeFileSync(
        path.join(winProgramData, 'Battle.net', 'Agent', 'dl.part'),
        Buffer.alloc(24 * 1024, 0x33)
      );
      const winAfterBytes = downloadQueueCoordinator.measurePublisherStagingBytes(
        'bnet',
        'win32',
        '',
        winEnvOpts
      );
      expect(winAfterBytes - winBaseBytes).toBe(24 * 1024);

      // F-CHAIN-10 & F-CHAIN-11: Battle.net real Protobuf wire decoding + case-sensitive launch product codes
      const productDbWire = Buffer.concat([
        buildSyntheticBattleNetProductInstallBytes({
          uid: 'agent',
          productCode: 'agent',
          installPath: 'C:/ProgramData/Battle.net/Agent',
          installed: true,
          playable: true,
        }),
        buildSyntheticBattleNetProductInstallBytes({
          uid: 'bna',
          productCode: 'bna',
          installPath: 'C:/Program Files (x86)/Battle.net',
          installed: true,
          playable: true,
        }),
        buildSyntheticBattleNetProductInstallBytes({
          uid: 'fenris',
          productCode: 'fenris',
          installPath: 'C:/Program Files (x86)/Synthetic Dungeon IV',
          playRegion: 'us',
          installed: true,
          playable: true,
          version: '2.1.0.58901',
        }),
        buildSyntheticBattleNetProductInstallBytes({
          uid: 'prometheus',
          productCode: 'pro',
          installPath: 'C:/Program Files (x86)/Synthetic Hero Team',
          playRegion: 'us',
          installed: false,
          playable: false,
          version: '1.14.0',
        }),
      ]);

      const decodedInstalls = chainedPublisherLaunchers.parseBattleNetProductDbBuffer(productDbWire);
      expect(decodedInstalls).toHaveLength(2);
      expect(decodedInstalls[0]).toMatchObject({
        uid: 'fenris',
        productCode: 'fenris',
        launchProductCode: 'Fen',
        installPath: 'C:/Program Files (x86)/Synthetic Dungeon IV',
        installed: true,
        playable: true,
        currentVersionStr: '2.1.0.58901',
      });
      expect(decodedInstalls[1]).toMatchObject({
        uid: 'prometheus',
        productCode: 'pro',
        launchProductCode: 'Pro',
        installed: false,
        playable: false,
      });

      const expectedCodeMappings: Array<[string, string]> = [
        ['fenris', 'Fen'],
        ['pro', 'Pro'],
        ['prometheus', 'Pro'],
        ['hsb', 'WTCG'],
        ['osi', 'OSI'],
        ['wow', 'WoW'],
        ['wlby', 'WLBY'],
      ];
      for (const [rawUid, expectedLaunchCode] of expectedCodeMappings) {
        expect(chainedPublisherLaunchers.normalizeBattleNetLaunchProductCode(rawUid)).toBe(
          expectedLaunchCode
        );
        const spec = chainedPublisherLaunchers.buildChainedLauncherLaunchSpec({
          handoffId: 'bnet',
          externalInstallId: rawUid,
          launcherBinaryPath: 'C:\\Program Files (x86)\\Battle.net\\Battle.net.exe',
          platform: 'win32',
        });
        expect(spec.launcherExe).toBe('C:\\Program Files (x86)\\Battle.net\\Battle.net.exe');
        expect(spec.args).toEqual([`--exec=launch ${expectedLaunchCode}`]);
      }

      // F-CHAIN-12: Rockstar silentArgs ['/s', '/f'] + Launcher.exe -launchTitleInFolder "C:\..." + PlaySynthMetro.exe -nobattleye bottle fallback
      expect(chainedPublisherLaunchers.CHAINED_PUBLISHER_ECOSYSTEMS.rockstar.silentArgs).toEqual([
        '/s',
        '/f',
      ]);

      const rglBottleRoot = path.join(tmpRoot, 'RockstarBottle');
      const rglBottleGameDir = path.join(
        rglBottleRoot,
        'drive_c',
        'Program Files',
        'Rockstar Games',
        'Synthetic Metro V'
      );
      const rglBottleLauncherExe = path.join(
        rglBottleRoot,
        'drive_c',
        'Program Files',
        'Rockstar Games',
        'Launcher',
        'Launcher.exe'
      );
      fs.mkdirSync(rglBottleGameDir, { recursive: true });
      fs.mkdirSync(path.dirname(rglBottleLauncherExe), { recursive: true });
      fs.writeFileSync(rglBottleLauncherExe, buildValidMinimalPe64Buffer());
      fs.writeFileSync(path.join(rglBottleGameDir, 'SynthMetro5.exe'), buildValidMinimalPe64Buffer());

      const rglWithClientSpec = chainedPublisherLaunchers.buildChainedLauncherLaunchSpec({
        handoffId: 'rockstar',
        launcherBinaryPath: rglBottleLauncherExe,
        installDir: rglBottleGameDir,
        gameExecutablePath: path.join(rglBottleGameDir, 'SynthMetro5.exe'),
        bottlePath: rglBottleRoot,
        platform: 'darwin',
      });
      expect(rglWithClientSpec.launcherExe).toBe(rglBottleLauncherExe);
      expect(rglWithClientSpec.args).toEqual([
        '-launchTitleInFolder',
        'C:\\Program Files\\Rockstar Games\\Synthetic Metro V',
      ]);

      // Without Launcher.exe: never spawns raw SynthMetro5.exe args:[]; uses PlaySynthMetro.exe -nobattleye when BattlEye is present in bottle
      const rglNoClientSpecBeforeBe = chainedPublisherLaunchers.buildChainedLauncherLaunchSpec({
        handoffId: 'rockstar',
        launcherBinaryPath: '',
        installDir: rglBottleGameDir,
        gameExecutablePath: path.join(rglBottleGameDir, 'SynthMetro5.exe'),
        bottlePath: rglBottleRoot,
        platform: 'darwin',
      });
      expect(rglNoClientSpecBeforeBe.launcherExe).toBe('');

      const playStoryBootstrapExe = path.join(rglBottleGameDir, 'PlaySynthMetro.exe');
      fs.writeFileSync(playStoryBootstrapExe, buildValidMinimalPe64Buffer());
      fs.writeFileSync(
        path.join(rglBottleGameDir, 'SynthMetro5_BE.exe'),
        buildValidMinimalPe64Buffer()
      );
      const rglStoryBypassSpec = chainedPublisherLaunchers.buildChainedLauncherLaunchSpec({
        handoffId: 'rockstar',
        launcherBinaryPath: '',
        installDir: rglBottleGameDir,
        gameExecutablePath: path.join(rglBottleGameDir, 'SynthMetro5.exe'),
        bottlePath: rglBottleRoot,
        platform: 'darwin',
      });
      expect(rglStoryBypassSpec.launcherExe).toBe(playStoryBootstrapExe);
      expect(rglStoryBypassSpec.args).toEqual(['-nobattleye']);
    });
  });

  // ==========================================================================
  // 4. Teardown, Non-Resurrecting Uninstall, Anti-Cheat, Paradox dowser.exe, APFS & UI (F-CHAIN-13 – F-CHAIN-16)
  // ==========================================================================
  describe('Domain 4: Teardown, Non-Resurrecting Uninstall, Anti-Cheat, Paradox dowser.exe, APFS & WCAG 2.2 AA UI (F-CHAIN-13 – F-CHAIN-16)', () => {
    it('F-CHAIN-13: excludes publisher helper/bootstrapper daemons in BOTTLE_SYSTEM_DAEMON_EXE_SET and reaps woken bottle publisher daemons on darwin only when no sibling session shares bottlePath', async () => {
      const bottlePath = path.join(tmpRoot, 'TeardownBottle');
      const gameDir = path.join(bottlePath, 'drive_c', 'Games', 'SynthGrandStrategy');
      fs.mkdirSync(gameDir, { recursive: true });

      const pe64 = buildValidMinimalPe64Buffer();
      for (const exeName of [
        'synthstrategy.exe',
        'dowser.exe',
        'LauncherPatcher.exe',
        'EABackgroundService.exe',
        'UbisoftGameLauncher.exe',
        'BlizzardError.exe',
      ]) {
        fs.writeFileSync(path.join(gameDir, exeName), pe64);
      }

      const candidateExes: string[] =
        sessionAndProcessSupervisor.collectChainedGameCandidateExeNames(
          gameDir,
          path.join(gameDir, 'dowser.exe')
        );
      expect(candidateExes).toContain('synthstrategy.exe');
      expect(candidateExes).not.toContain('dowser.exe');
      expect(candidateExes).not.toContain('launcherpatcher.exe');
      expect(candidateExes).not.toContain('eabackgroundservice.exe');
      expect(candidateExes).not.toContain('ubisoftgamelauncher.exe');
      expect(candidateExes).not.toContain('blizzarderror.exe');

      // Verify `findLiveBottleGameChildPid` ignores helper daemons and latches onto real `synthstrategy.exe` PID
      const psSnapshotOnlyDaemons = [
        `50101 WINEPREFIX="${bottlePath}" C:\\Program Files\\Electronic Arts\\EA Desktop\\EABackgroundService.exe`,
        `50102 WINEPREFIX="${bottlePath}" C:\\Games\\SynthGrandStrategy\\dowser.exe`,
        `50103 WINEPREFIX="${bottlePath}" C:\\Program Files\\Rockstar Games\\Launcher\\LauncherPatcher.exe`,
        `50104 WINEPREFIX="${bottlePath}" C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\UbisoftGameLauncher.exe`,
        `50105 WINEPREFIX="${bottlePath}" C:\\Program Files (x86)\\Battle.net\\BlizzardError.exe`,
      ].join('\n');
      const pidWhenOnlyDaemons = await sessionAndProcessSupervisor.findLiveBottleGameChildPid(
        {
          bottleDir: bottlePath,
          targetExeBasenamesLower: candidateExes,
          localInstallDir: gameDir,
          resolvedExePath: path.join(gameDir, 'dowser.exe'),
        },
        { platform: 'darwin', mockProcessListOutput: psSnapshotOnlyDaemons }
      );
      expect(pidWhenOnlyDaemons).toBe(0);

      const psSnapshotWithGame = `${psSnapshotOnlyDaemons}\n50222 WINEPREFIX="${bottlePath}" C:\\Games\\SynthGrandStrategy\\synthstrategy.exe`;
      const pidWhenGameAlive = await sessionAndProcessSupervisor.findLiveBottleGameChildPid(
        {
          bottleDir: bottlePath,
          targetExeBasenamesLower: candidateExes,
          localInstallDir: gameDir,
          resolvedExePath: path.join(gameDir, 'dowser.exe'),
        },
        { platform: 'darwin', mockProcessListOutput: psSnapshotWithGame }
      );
      expect(pidWhenGameAlive).toBe(50222);

      // Verify `shutdownEphemeralStorefrontClient` reaps woken bottle publisher daemons matching `bottlePath` on darwin
      const killedPids: Array<{ pid: number; sig: string }> = [];
      const otherBottle = path.join(tmpRoot, 'OtherBottle');
      const daemonPsOutput = [
        `60111 WINEPREFIX=${bottlePath} C:\\Program Files\\Electronic Arts\\EA Desktop\\EADesktop.exe`,
        `60112 WINEPREFIX=${bottlePath} C:\\Program Files\\Electronic Arts\\EA Desktop\\EABackgroundService.exe`,
        `60113 WINEPREFIX=${bottlePath} C:\\Program Files (x86)\\Battle.net\\Agent.exe`,
        `60299 WINEPREFIX=${otherBottle} C:\\Program Files\\Electronic Arts\\EA Desktop\\EADesktop.exe`,
      ].join('\n');

      const teardownRes = await sessionAndProcessSupervisor.shutdownEphemeralStorefrontClient(
        {
          gameId: 'xbox-synth-ea-1',
          platformId: 'xbox',
          effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
          wokePublisherClientByLauncher: true,
          wasPublisherClientRunningAtStart: false,
          chainedLauncherHandoff: 'ea',
          winePrefix: bottlePath,
          bottlePath,
        },
        {
          platform: 'darwin',
          mockProcessListOutput: daemonPsOutput,
          killPidFn: (pid: number, sig: string) => {
            killedPids.push({ pid, sig });
          },
        }
      );
      expect(teardownRes.closed).toBe(true);
      expect(killedPids.map((k) => k.pid)).toContain(60111);
      expect(killedPids.map((k) => k.pid)).toContain(60112);
      // Never kills another publisher's daemon (60113 = Battle.net Agent.exe) or another bottle's daemon (60299)!
      expect(killedPids.map((k) => k.pid)).not.toContain(60113);
      expect(killedPids.map((k) => k.pid)).not.toContain(60299);

      const bnetKilledPids: number[] = [];
      const bnetTeardownRes = await sessionAndProcessSupervisor.shutdownEphemeralStorefrontClient(
        {
          gameId: 'xbox-synth-bnet-1',
          platformId: 'xbox',
          effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
          wokePublisherClientByLauncher: true,
          chainedLauncherHandoff: 'bnet',
          winePrefix: bottlePath,
          bottlePath,
        },
        {
          platform: 'darwin',
          mockProcessListOutput: daemonPsOutput,
          killPidFn: (pid: number) => {
            bnetKilledPids.push(pid);
          },
        }
      );
      expect(bnetTeardownRes.closed).toBe(true);
      expect(bnetKilledPids).toEqual([60113]);

      // When a sibling active session shares the same `bottlePath`, teardown MUST block with `other_session_active`!
      const siblingKilledPids: number[] = [];
      engineStateRegistry.activeSessions.set('sibling-steam-bottle-game', {
        gameId: 'sibling-steam-bottle-game',
        platformId: 'steam',
        winePrefix: bottlePath,
        bottlePath,
        finalized: false,
      });
      try {
        const blockedBySibling =
          await sessionAndProcessSupervisor.shutdownEphemeralStorefrontClient(
            {
              gameId: 'xbox-synth-ea-2',
              platformId: 'xbox',
              effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
              wokePublisherClientByLauncher: true,
              chainedLauncherHandoff: 'ea',
              winePrefix: bottlePath,
              bottlePath,
            },
            {
              platform: 'darwin',
              mockProcessListOutput: daemonPsOutput,
              killPidFn: (pid: number) => {
                siblingKilledPids.push(pid);
              },
            }
          );
        expect(blockedBySibling.closed).toBe(false);
        expect(blockedBySibling.reason).toBe('other_session_active');
        expect(siblingKilledPids).toEqual([]);
      } finally {
        engineStateRegistry.activeSessions.delete('sibling-steam-bottle-game');
      }
    });

    it('F-CHAIN-14: strips bnet & rockstar game Uninstall keys from bottle system.reg while preserving launcher keys, and preserves win32 managed record when user cancels publisher uninstaller', async () => {
      const bottleDir = path.join(tmpRoot, 'UninstallBottle');
      const bnetGameDir = path.join(
        bottleDir,
        'drive_c',
        'Program Files (x86)',
        'Synthetic Dungeon IV'
      );
      const rglGameDir = path.join(
        bottleDir,
        'drive_c',
        'Program Files',
        'Rockstar Games',
        'Synthetic Metro V'
      );
      fs.mkdirSync(bnetGameDir, { recursive: true });
      fs.mkdirSync(rglGameDir, { recursive: true });

      const sysRegPath = path.join(bottleDir, 'system.reg');
      fs.writeFileSync(
        sysRegPath,
        `WINE REGISTRY Version 2

[Software\\\\Wow6432Node\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\Battle.net] 1730000100
"DisplayName"="Battle.net"
"InstallLocation"="C:\\\\Program Files (x86)\\\\Battle.net"

[Software\\\\Wow6432Node\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\Synthetic Dungeon IV] 1730000101
"DisplayName"="Synthetic Dungeon IV"
"InstallLocation"="C:\\\\Program Files (x86)\\\\Synthetic Dungeon IV"

[Software\\\\Wow6432Node\\\\Rockstar Games\\\\Launcher] 1730000102
"InstallFolder"="C:\\\\Program Files\\\\Rockstar Games\\\\Launcher"

[Software\\\\Wow6432Node\\\\Rockstar Games\\\\Synthetic Metro V] 1730000103
"InstallFolder"="C:\\\\Program Files\\\\Rockstar Games\\\\Synthetic Metro V"

[Software\\\\Wow6432Node\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\{SYNTH-METRO-GUID}] 1730000104
"DisplayName"="Synthetic Metro V"
"InstallLocation"="C:\\\\Program Files\\\\Rockstar Games\\\\Synthetic Metro V"
`,
        'utf8'
      );

      const stripBnet = chainedPublisherLaunchers.stripPublisherUninstallKeysFromSystemReg(
        bottleDir,
        bnetGameDir,
        'bnet'
      );
      expect(stripBnet.modified).toBe(true);

      const stripRgl = chainedPublisherLaunchers.stripPublisherUninstallKeysFromSystemReg(
        bottleDir,
        rglGameDir,
        'rockstar'
      );
      expect(stripRgl.modified).toBe(true);

      const updatedReg = fs.readFileSync(sysRegPath, 'utf8');
      expect(updatedReg).not.toContain('Uninstall\\\\Synthetic Dungeon IV]');
      expect(updatedReg).not.toContain('Rockstar Games\\\\Synthetic Metro V]');
      expect(updatedReg).not.toContain('Uninstall\\\\{SYNTH-METRO-GUID}]');
      // Launcher client sections remain untouched!
      expect(updatedReg).toContain('Uninstall\\\\Battle.net]');
      expect(updatedReg).toContain('Rockstar Games\\\\Launcher]');

      // win32 non-resurrecting / non-data-losing uninstall when user cancels publisher uninstaller
      const winHome = path.join(tmpRoot, 'WinUninstallHome');
      const winUserData = path.join(winHome, '.one-launcher');
      const winGameDir = path.join(winHome, 'Games', 'Synthetic Metro V');
      const winUninstExe = path.join(winGameDir, 'uninstall.exe');
      fs.mkdirSync(winUserData, { recursive: true });
      fs.mkdirSync(winGameDir, { recursive: true });
      fs.writeFileSync(winUninstExe, buildValidMinimalPe64Buffer());
      fs.writeFileSync(path.join(winGameDir, 'SynthMetro5.exe'), buildValidMinimalPe64Buffer());

      const managedJsonPath = path.join(winUserData, 'one_launcher_installed.json');
      fs.writeFileSync(
        managedJsonPath,
        JSON.stringify(
          [
            {
              gameId: 'xbox-9NROCKSTAR01',
              platformId: 'xbox',
              platformGameId: '9NROCKSTAR01',
              title: 'Synthetic Metro V',
              installPath: winGameDir,
              executablePath: path.join(winGameDir, 'SynthMetro5.exe'),
              chainedLauncherHandoff: 'rockstar',
            },
          ],
          null,
          2
        ),
        'utf8'
      );

      // Simulate user clicking "Cancel" inside Rockstar uninstaller (process exits 0, game folder still exists on disk)
      const cancelRes = await sessionAndProcessSupervisor.uninstallGame(
        {
          gameId: 'xbox-9NROCKSTAR01',
          platformId: 'xbox',
          platformGameId: '9NROCKSTAR01',
          title: 'Synthetic Metro V',
          installPath: winGameDir,
          chainedLauncherHandoff: 'rockstar',
        },
        {
          platform: 'win32',
          homedir: winHome,
          userDataDir: winUserData,
          publisherUninstallPollTimeoutMs: 25,
          publisherUninstallPollIntervalMs: 10,
          spawnFn: () => {
            const ee = new EventEmitter();
            setImmediate(() => ee.emit('exit', 0));
            return ee;
          },
        }
      );

      expect(cancelRes.success).toBe(false);
      expect(cancelRes.cancelled).toBe(true);
      expect(cancelRes.stillInstalled).toBe(true);
      const preservedRecords = JSON.parse(fs.readFileSync(managedJsonPath, 'utf8'));
      expect(preservedRecords).toHaveLength(1);
      expect(preservedRecords[0].gameId).toBe('xbox-9NROCKSTAR01');
    });

    it('F-CHAIN-15 & F-CHAIN-16: detects kernel anti-cheat markers (vgk.sys, randgrid.sys, EA Javelin, BEService_x64.exe + PlaySynthMetro.exe bypass), resolves Paradox dowser.exe -> launcher-settings.json while blocking .. traversal, and detects APFS case sensitivity', () => {
      // 1) Riot Vanguard (vgk.sys)
      const vanguardDir = path.join(tmpRoot, 'ac-vanguard');
      fs.mkdirSync(vanguardDir, { recursive: true });
      fs.writeFileSync(path.join(vanguardDir, 'vgk.sys'), Buffer.from('MZ'));
      expect(binaryAndManifestInspectors.detectKernelAntiCheatMarkersInDir(vanguardDir)).toEqual({
        requiresKernelAntiCheat: true,
        kernelAntiCheatName: 'Riot Vanguard',
        storyModeBypassAvailable: false,
      });

      // 2) Activision Ricochet (randgrid.sys)
      const ricochetDir = path.join(tmpRoot, 'ac-ricochet');
      fs.mkdirSync(ricochetDir, { recursive: true });
      fs.writeFileSync(path.join(ricochetDir, 'randgrid.sys'), Buffer.from('MZ'));
      expect(binaryAndManifestInspectors.detectKernelAntiCheatMarkersInDir(ricochetDir)).toEqual({
        requiresKernelAntiCheat: true,
        kernelAntiCheatName: 'RICOCHET Anti-Cheat',
        storyModeBypassAvailable: false,
      });

      // 3) EA Javelin (EAAntiCheat.GameServiceLauncher.exe)
      const javelinDir = path.join(tmpRoot, 'ac-javelin');
      fs.mkdirSync(javelinDir, { recursive: true });
      fs.writeFileSync(
        path.join(javelinDir, 'EAAntiCheat.GameServiceLauncher.exe'),
        buildValidMinimalPe64Buffer()
      );
      expect(binaryAndManifestInspectors.detectKernelAntiCheatMarkersInDir(javelinDir)).toEqual({
        requiresKernelAntiCheat: true,
        kernelAntiCheatName: 'EA Javelin Anti-Cheat',
        storyModeBypassAvailable: false,
      });

      // 4) BattlEye (BEService_x64.exe) WITHOUT vs WITH PlaySynthMetro.exe Story Mode (-nobattleye) bypass
      const battleyeStrictDir = path.join(tmpRoot, 'ac-battleye-strict');
      fs.mkdirSync(path.join(battleyeStrictDir, 'BattlEye'), { recursive: true });
      fs.writeFileSync(
        path.join(battleyeStrictDir, 'BattlEye', 'BEService_x64.exe'),
        buildValidMinimalPe64Buffer()
      );
      expect(
        binaryAndManifestInspectors.detectKernelAntiCheatMarkersInDir(battleyeStrictDir)
      ).toEqual({
        requiresKernelAntiCheat: true,
        kernelAntiCheatName: 'BattlEye',
        storyModeBypassAvailable: false,
      });

      const battleyeStoryDir = path.join(tmpRoot, 'ac-battleye-story');
      fs.mkdirSync(path.join(battleyeStoryDir, 'BattlEye'), { recursive: true });
      fs.writeFileSync(
        path.join(battleyeStoryDir, 'BattlEye', 'BEService_x64.exe'),
        buildValidMinimalPe64Buffer()
      );
      fs.writeFileSync(
        path.join(battleyeStoryDir, 'PlaySynthMetro.exe'),
        buildValidMinimalPe64Buffer()
      );
      expect(
        binaryAndManifestInspectors.detectKernelAntiCheatMarkersInDir(battleyeStoryDir)
      ).toEqual({
        requiresKernelAntiCheat: false,
        kernelAntiCheatName: 'BattlEye',
        storyModeBypassAvailable: true,
      });

      // 5) Paradox dowser.exe -> launcher-settings.json exePath resolution + `..` traversal rejection
      const pdxDir = path.join(tmpRoot, 'ParadoxGame');
      const pdxBinDir = path.join(pdxDir, 'binaries');
      fs.mkdirSync(pdxBinDir, { recursive: true });
      const realGameExe = path.join(pdxBinDir, 'synthdynasty.exe');
      const dowserExe = path.join(pdxDir, 'launcher', 'dowser.exe');
      fs.mkdirSync(path.dirname(dowserExe), { recursive: true });
      fs.writeFileSync(realGameExe, buildValidMinimalPe64Buffer());
      fs.writeFileSync(dowserExe, buildValidMinimalPe64Buffer());
      fs.writeFileSync(
        path.join(pdxDir, 'launcher-settings.json'),
        JSON.stringify({
          rawVersion: '1.12.5',
          exePath: 'binaries/synthdynasty.exe',
          exeArgs: ['--gdpr-compliant'],
        }),
        'utf8'
      );

      const resolvedPdx = binaryAndManifestInspectors.resolveParadoxLauncherSettings(
        dowserExe,
        pdxDir
      );
      expect(resolvedPdx.found).toBe(true);
      expect(resolvedPdx.paradoxDirectGameExe).toBe(realGameExe);
      expect(resolvedPdx.exeArgs).toEqual(['--gdpr-compliant']);

      // Path traversal attempt (`../../Evil.exe`) MUST be rejected!
      const pdxTraversalDir = path.join(tmpRoot, 'ParadoxTraversal');
      fs.mkdirSync(pdxTraversalDir, { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'Evil.exe'), buildValidMinimalPe64Buffer());
      fs.writeFileSync(
        path.join(pdxTraversalDir, 'launcher-settings.json'),
        JSON.stringify({ exePath: '../Evil.exe' }),
        'utf8'
      );
      const traversalRes = binaryAndManifestInspectors.resolveParadoxLauncherSettings(
        pdxTraversalDir
      );
      expect(traversalRes.paradoxDirectGameExe).toBeNull();

      // 6) APFS volume case-sensitivity detection (case-sensitive vs case-insensitive + win32 no-op)
      expect(
        diskAndVolumeInspector.checkVolumeCaseSensitivity('C:\\Games', { platform: 'win32' })
      ).toEqual({ caseSensitive: false });

      const caseSensitiveCheck = diskAndVolumeInspector.checkVolumeCaseSensitivity(
        '/Volumes/CaseSensitiveSSD/Games',
        {
          platform: 'darwin',
          mountedVolumes: ['CaseSensitiveSSD'],
          statSyncFn: (p: string) => {
            if (p === '/Volumes/CaseSensitiveSSD/Games' || p === '/Volumes/CaseSensitiveSSD') {
              return { dev: 77, ino: p.length, isDirectory: () => true };
            }
            if (p === '/Volumes') {
              return { dev: 1, ino: 2, isDirectory: () => true };
            }
            // Toggled case `/Volumes/CaseSensitiveSSD/gAMES` throws ENOENT on case-sensitive APFS
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          },
        }
      );
      expect(caseSensitiveCheck).toEqual({ caseSensitive: true });

      const caseInsensitiveCheck = diskAndVolumeInspector.checkVolumeCaseSensitivity(
        '/Volumes/StandardAPFS/Games',
        {
          platform: 'darwin',
          mountedVolumes: ['StandardAPFS'],
          statSyncFn: (p: string) => {
            if (p === '/Volumes') return { dev: 1, ino: 2, isDirectory: () => true };
            if (p.toLowerCase() === '/volumes/standardapfs/games') {
              return { dev: 88, ino: 9001, isDirectory: () => true };
            }
            return { dev: 88, ino: 8000, isDirectory: () => true };
          },
        }
      );
      expect(caseInsensitiveCheck).toEqual({ caseSensitive: false });
    });

    it('propagates structural anti-cheat across Steam->Xbox siblings in catalogSanitizer, builds honest Chained LaunchPolicyPreview labels, and renders GameInstallModal / SteamLibraryActionBar / SteamSidebarNotices with 0 WCAG 2.2 AA violations', async () => {
      // 1) Structural anti-cheat sibling propagation (Steam DRM notice -> Xbox chained sibling)
      const crossMergedGame = makeCanonicalGameFixture({
        id: 'merged-javelin-synth',
        title: 'Synthetic Tactical Title',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '999001',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
          {
            platformId: 'xbox',
            platformGameId: '9NSYNTHTAC01',
            xboxProductId: '9NSYNTHTAC01',
            installed: false,
            chainedLauncherHandoff: 'ea',
            externalStorefrontHandoff: 'ea',
            externalLauncher: 'EA App',
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
        enrichedMetadata: {
          name: 'Synthetic Tactical Title',
          drmNotice: 'EA Anticheat (Kernel-level anti-cheat required); EA app account link',
          platforms: { windows: true, mac: false, linux: false },
        } as any,
      });

      const [sanitizedMerged] = sanitizeGameCatalog([crossMergedGame]);
      expect(sanitizedMerged.requiresKernelAntiCheat).toBe(true);
      expect(sanitizedMerged.kernelAntiCheatName).toBe('EA Javelin Anti-Cheat');
      const sanitizedXboxSibling = sanitizedMerged.platforms.find((p) => p.platformId === 'xbox')!;
      expect(sanitizedXboxSibling.requiresKernelAntiCheat).toBe(true);
      expect(sanitizedXboxSibling.kernelAntiCheatName).toBe('EA Javelin Anti-Cheat');

      // 2) Honest `buildLaunchPolicyPreview` labels on darwin & win32 (never claiming clientless 0 MB XboxPcApp.exe for chained Xbox games!)
      const bnetXboxGame = makeCanonicalGameFixture({
        id: 'xbox-9NBNETSTUB01',
        title: 'Synthetic Dungeon IV',
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NBNETSTUB01',
            xboxProductId: '9NBNETSTUB01',
            installed: false,
            chainedLauncherHandoff: 'bnet',
            externalStorefrontHandoff: 'bnet',
            externalLauncher: 'Battle.net',
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      const macChainedPreview = buildLaunchPolicyPreview({
        game: bnetXboxGame,
        preferredPlatformId: 'xbox',
        hostPlatform: 'darwin',
        globalStorefrontLifecycle: 'minimal_and_close_if_started',
        layers: [
          {
            id: 'crossover',
            type: 'crossover',
            name: 'CrossOver',
            version: '26.3.0',
            binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
            availableBottles: ['OneLauncher'],
          },
        ],
      });
      expect(macChainedPreview.modeLabel).toContain(
        'Chained Compatibility Bottle (Xbox Game Pass → Battle.net'
      );
      expect(macChainedPreview.autoResolvedSummary).not.toContain('XboxPcApp.exe');

      const winChainedPreview = buildLaunchPolicyPreview({
        game: bnetXboxGame,
        preferredPlatformId: 'xbox',
        hostPlatform: 'win32',
        globalStorefrontLifecycle: 'minimal_and_close_if_started',
        layers: [],
      });
      expect(winChainedPreview.modeLabel).toContain(
        'Chained Host Publisher Handoff (Xbox Game Pass → Battle.net)'
      );
      expect(winChainedPreview.autoResolvedSummary).not.toContain('XboxPcApp.exe');

      const macRing0Preview = buildLaunchPolicyPreview({
        game: sanitizedMerged,
        preferredPlatformId: 'xbox',
        hostPlatform: 'darwin',
        globalStorefrontLifecycle: 'minimal_and_close_if_started',
        layers: [],
      });
      expect(macRing0Preview.modeLabel).toContain('Unsupported on macOS Bottle');
      expect(macRing0Preview.modeLabel).toContain('EA Javelin');

      // 3) UI + WCAG 2.2 AA Audit across `GameInstallModal`, `SteamLibraryActionBar`, and `SteamSidebarNotices`
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(false);
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        {
          id: 'crossover',
          type: 'crossover',
          name: 'CrossOver',
          version: '26.3.0',
          binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
          availableBottles: ['OneLauncher'],
        },
      ]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(undefined);
      vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
        targetPath: '/Volumes/CaseSensitiveGames/OneLauncher',
        freeBytes: 250 * 1024 * 1024 * 1024,
        totalBytes: 500 * 1024 * 1024 * 1024,
        usedBytes: 250 * 1024 * 1024 * 1024,
        caseSensitive: true,
      } as any);

      const macXboxInstallInfo: GameInstallInfo = {
        platformId: 'xbox',
        platformGameId: '9NSYNTHTAC01',
        canDirectDownload: true,
        defaultInstallDir: '/Volumes/CaseSensitiveGames/OneLauncher',
        availableInstallDirs: ['/Volumes/CaseSensitiveGames/OneLauncher'],
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        externalLauncher: 'EA App',
        requiresKernelAntiCheat: true,
        kernelAntiCheatName: 'EA Javelin Anticheat',
        antiCheatName: 'EA Javelin Anticheat',
        availableInstallers: [
          {
            id: 'xbox-chained-bottle-launcher',
            name: 'EA App (Bottle)',
            os: 'windows',
            language: 'en',
            totalSizeBytes: 85 * 1024 * 1024 * 1024,
            chainedLauncherHandoff: 'ea',
            externalStorefrontHandoff: 'ea',
            requiresKernelAntiCheat: true,
            antiCheatName: 'EA Javelin Anticheat',
          },
        ],
      };
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue(macXboxInstallInfo);
      vi.spyOn(launcherService, 'getCachedInstallInfo').mockReturnValue(macXboxInstallInfo);

      // 3a) GameInstallModal on darwin (Xbox <-> Publisher account-link callout + kernel anti-cheat warning + APFS case-sensitive warning)
      const macModal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game: sanitizedMerged,
        initialPlatformId: 'xbox',
        onClose: vi.fn(),
      });
      try {
        macModal.render();
        await Promise.resolve();
        await Promise.resolve();
        const macModalTree = macModal.render();

        const accountLinkCallout = findVNodeByTestId(
          macModalTree,
          'xbox-publisher-account-link-callout'
        );
        expect(accountLinkCallout).toBeDefined();
        expect(extractVNodeText(accountLinkCallout)).toContain('Xbox ↔ EA App Account Link Required');

        const acWarning = findVNodeByTestId(macModalTree, 'macos-kernel-anticheat-warning');
        expect(acWarning).toBeDefined();
        expect(extractVNodeText(acWarning)).toContain('EA Javelin');

        const apfsWarning = findVNodeByTestId(macModalTree, 'macos-case-sensitive-volume-warning');
        expect(apfsWarning).toBeDefined();
        expect(extractVNodeText(apfsWarning)).toContain('Case-Sensitive APFS');

        expect(auditWcag22AA(macModalTree)).toEqual([]);
      } finally {
        macModal.unmount();
      }

      // 3b) SteamLibraryActionBar on darwin (ring-0 anti-cheat banner + chained bottle banner)
      const actionBarRing0 = createDomain12DeepRenderer(SteamLibraryActionBar, {
        game: {
          ...sanitizedMerged,
          platforms: [sanitizedXboxSibling],
        },
        connectedStorefronts: ['xbox'],
      });
      try {
        const barTree = actionBarRing0.render();
        const banner = findVNodeByTestId(barTree, 'actionbar-compat-handoff-banner');
        expect(banner).toBeDefined();
        expect(extractVNodeText(banner)).toContain('EA Javelin');
        expect(auditWcag22AA(barTree)).toEqual([]);
      } finally {
        actionBarRing0.unmount();
      }

      vi.spyOn(launcherService, 'getCachedInstallInfo').mockReturnValue(undefined as any);
      const actionBarChained = createDomain12DeepRenderer(SteamLibraryActionBar, {
        game: bnetXboxGame,
        connectedStorefronts: ['xbox'],
      });
      try {
        const chainedBarTree = actionBarChained.render();
        const chainedBanner = findVNodeByTestId(chainedBarTree, 'actionbar-compat-handoff-banner');
        expect(chainedBanner).toBeDefined();
        expect(extractVNodeText(chainedBanner)).toContain('Battle.net');
        expect(extractVNodeText(chainedBanner)).toContain('linked to your Xbox profile');
        expect(auditWcag22AA(chainedBarTree)).toEqual([]);
      } finally {
        actionBarChained.unmount();
      }

      // 3c) SteamSidebarNotices on darwin (chained launcher notice + kernel anti-cheat notice)
      const sidebarHarness = createDomain12DeepRenderer(SteamSidebarNotices, {
        title: sanitizedMerged.title,
        genres: ['Action'],
        developers: ['Synthetic Studio'],
        publishers: ['Electronic Arts'],
        drmNotice: undefined,
        activePlatform: sanitizedXboxSibling,
      });
      try {
        const sidebarTree = sidebarHarness.render();
        const chainedNotice = findVNodeByTestId(sidebarTree, 'sidebar-chained-launcher-notice');
        const kernelNotice = findVNodeByTestId(sidebarTree, 'sidebar-kernel-anticheat-notice');
        expect(chainedNotice).toBeDefined();
        expect(extractVNodeText(chainedNotice)).toContain('Requires EA App');
        expect(kernelNotice).toBeDefined();
        expect(extractVNodeText(kernelNotice)).toContain('EA Javelin');
        expect(auditWcag22AA(sidebarTree)).toEqual([]);
      } finally {
        sidebarHarness.unmount();
      }

      // 3d) GameInstallModal on win32: shows Xbox <-> Publisher account-link callout + chained notice, hides macOS warnings
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');
      vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(true);
      vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
        targetPath: 'C:\\Games\\OneLauncher',
        freeBytes: 250 * 1024 * 1024 * 1024,
        totalBytes: 500 * 1024 * 1024 * 1024,
        usedBytes: 250 * 1024 * 1024 * 1024,
        caseSensitive: false,
      } as any);
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        ...macXboxInstallInfo,
        defaultInstallDir: 'C:\\Games\\OneLauncher',
        availableInstallDirs: ['C:\\Games\\OneLauncher'],
        availableInstallers: [
          {
            id: 'xbox-chained-host-launcher',
            name: 'EA App (Windows)',
            os: 'windows',
            language: 'en',
            totalSizeBytes: 85 * 1024 * 1024 * 1024,
            chainedLauncherHandoff: 'ea',
            externalStorefrontHandoff: 'ea',
            requiresKernelAntiCheat: true,
            antiCheatName: 'EA Javelin Anti-Cheat',
          },
        ],
      });

      const winModal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game: sanitizedMerged,
        initialPlatformId: 'xbox',
        onClose: vi.fn(),
      });
      try {
        winModal.render();
        await Promise.resolve();
        await Promise.resolve();
        const winModalTree = winModal.render();

        expect(findVNodeByTestId(winModalTree, 'chained-launcher-install-notice')).toBeDefined();
        expect(findVNodeByTestId(winModalTree, 'xbox-publisher-account-link-callout')).toBeDefined();
        expect(findVNodeByTestId(winModalTree, 'macos-kernel-anticheat-warning')).toBeUndefined();
        expect(
          findVNodeByTestId(winModalTree, 'macos-case-sensitive-volume-warning')
        ).toBeUndefined();
        expect(auditWcag22AA(winModalTree)).toEqual([]);
      } finally {
        winModal.unmount();
      }
    });

    it('passes zero-PII self-audit across this entire test file', () => {
      const selfPath = path.resolve(
        __dirname,
        'xboxChainedLaunchersAndXgrRuntimeAudit.test.tsx'
      );
      const content = fs.readFileSync(selfPath, 'utf8');
      const violations = scanContentForPiiViolations(
        content,
        'tests/xboxChainedLaunchersAndXgrRuntimeAudit.test.tsx',
        null
      );
      expect(violations).toEqual([]);
    });
  });
});
