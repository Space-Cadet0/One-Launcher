import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { createRequire } from 'module';

import {
  createDomain12DeepRenderer,
  buildValidMinimalPe64Buffer,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';
import { scanContentForPiiViolations } from './helpers/piiHygieneGuard';

import {
  resolveXboxSyncModeCatalogCopy,
  resolveXboxDetailTierBadgeLabel,
  resolveXboxCompactTierBadge,
  formatXboxSubscriptionDate,
  XboxIntegrationService,
} from '../src/services/integrations/xboxIntegration';
import {
  mergeStorefrontGames,
  recordVerifiedUserEntitlements,
  getVerifiedUserEntitlements,
  formatXboxIntegrationStatusMessage,
  saveIntegrations,
  loadIntegrations,
  saveXboxProfileState,
} from '../src/services/integrations/integrationStorage';
import { buildLibraryFilterIndex } from '../src/services/filter/libraryFilterIndex';
import { IntegrationsModal } from '../src/components/Navigation/IntegrationsModal';
import { StorefrontAccountsStep } from '../src/components/Launcher/SystemSetupWizard/steps/StorefrontAccountsStep';
import { PlatformBadges } from '../src/components/SteamStoreDetail/PlatformBadges';
import { renderLibraryGridCard } from '../src/components/Library/Grid/LibraryGridCard';
import { LibrarySidebar } from '../src/components/Library/LibrarySidebar';

import type { CanonicalGame, XboxSubscriptionSummary } from '../src/contracts/game';
import type { EnvironmentHealthSnapshot } from '../src/contracts/environmentSetup';
import type { StorefrontId } from '../src/contracts/platform';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const xboxCatalogAndGamePass = require('../electron/storefronts/xbox/xboxCatalogAndGamePass.cjs');
const xboxAuthManager = require('../electron/storefronts/xbox/xboxAuthManager.cjs');
const storeSync = require('../electron/storeSync.cjs');
const offlineVaultMod = require('../electron/launcher/offlineVaultService.cjs');
const federatorMod = require('../electron/launcher/storefrontLocalCacheFederator.cjs');

// ============================================================================
// Synthetic Zero-PII Constants & Hermetic Browser / Socket Polyfills
// ============================================================================

const SYNTH_XUID = '2533274790000777';
const SYNTH_GAMERTAG = 'SyntheticPilot';
const SYNTH_UHS = 'synthuhs0777';
const SYNTH_MSA_TICKET = 't=SYNTHETIC_MSA_WLID_TICKET_0001_ZERO_PII';
const SYNTH_STORE_AUTH = `XBL3.0 x=${SYNTH_UHS};SYNTHETIC_MSSTORE_XSTS_JWT_0001`;
const FIXED_NOW_MS = Date.parse('2026-06-15T12:00:00.000Z');
const FUTURE_END_ISO = '2026-07-20T00:00:00.000Z';
const PAST_END_ISO = '2026-05-01T00:00:00.000Z';

// Synthetic 12-char Store BigIds (Zero real commercial game titles or commercial BigIds)
const BIGID_PCGP_CORE = '9NSYNTH00101'; // Standard PCGP & Ultimate .msixvc
const BIGID_EA_PLAY = '9NSYNTH00102'; // EA Play PC handoff (bundled in PCGP & Ultimate)
const BIGID_UBI_ULT_A = '9NSYNTH00103'; // Ubisoft+ Classics stub (Ultimate-exclusive, NOT in PCGP)
const BIGID_UBI_ULT_B = '9NSYNTH00104'; // Ubisoft+ Classics stub w/ over-stamped KGQ8 key in DisplayCatalog
const BIGID_ULT_EXCL = '9NSYNTH00105'; // Ultimate-exclusive native .msixvc
const BIGID_OWNED_PC = '9NSYNTH00106'; // Permanently owned MS Store PC game
const BIGID_OWNED_AND_SUB = '9NSYNTH00107'; // Both permanently owned AND in subscription SIGL
const BIGID_PREMIUM_PC = '9NSYNTH00108'; // Game Pass Premium PC game
const BIGID_ESSENTIAL_PC = '9NSYNTH00109'; // Game Pass Essential PC game
const BIGID_GOLD_DISCOUNT_TRAP = '9NSYNTH00110'; // LegacyDiscountGold remediation trap (NOT in SatisfyingEntitlementKeys)
const BIGID_WIN8X_APPX = '9NSYNTH00111'; // Gate 2 Windows.Windows8x Appx desktop classic
const BIGID_CONSOLE_XVC = '9NSYNTH00112'; // Console-only Windows.Xbox XVC (must be rejected)
const BIGID_INSTALLED_SOUNDTRACK_TOOL = '9NSYNTH00113'; // Gate 5 installed override test
const BIGID_US_REGIONAL_ONLY = '9NSYNTH00119'; // US-market-only PCGP title

function getXboxBigIdFromGame(g: CanonicalGame): string {
  return String(
    g.platforms?.find((p) => p.platformId === 'xbox')?.xboxProductId ||
      g.platforms?.[0]?.platformGameId ||
      ''
  ).toUpperCase();
}

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
      navigator: { userAgent: 'Macintosh', language: 'en-GB' },
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
    const rawUrl = typeof input === 'string' ? input : String(input?.url || '');
    throw new Error(`HERMETIC_FETCH_GUARD: Unmocked global fetch("${rawUrl}") is forbidden`);
  }) as any;

  return () => {
    net.Socket.prototype.connect = origConnect;
    globalThis.fetch = origFetch;
  };
}

// ============================================================================
// VNode Traversal & WCAG 2.2 AA Accessibility Auditor
// ============================================================================

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

function extractVNodeText(node: any): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractVNodeText).join('');
  if (typeof node === 'object' && node.props?.children !== undefined) {
    return extractVNodeText(node.props.children);
  }
  return '';
}

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
      if (
        !/\b(min-h-6|min-w-6|p-\d|py-\d|px-\d|h-\d|underline|card-stretched-trigger|inset-0)\b/.test(
          cls
        )
      ) {
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
// Synthetic DisplayCatalog, SIGL v3/v2, PCGAFD & Collections v6.0 Builders
// ============================================================================

interface SyntheticProductSpec {
  productId: string;
  title: string;
  productType?: string;
  productKind?: string;
  packageFormat?: string;
  platformName?: string;
  packageFamilyName?: string;
  satisfyingEntitlementKeys?: string[];
  remediationBigIds?: string[];
  affirmationBigIds?: string[];
  availabilityStartIso?: string;
  availabilityEndIso?: string;
  externalClientName?: string;
  includePackages?: boolean;
  bundledSkus?: Array<{ BigId: string; SkuId?: string }>;
}

function makeDisplayCatalogProduct(spec: SyntheticProductSpec) {
  const {
    productId,
    title,
    productType = 'Game',
    productKind = 'Game',
    packageFormat = 'MSIXVC',
    platformName = 'Windows.Desktop',
    packageFamilyName = `SyntheticStudio.${productId}_8wekyb3d8bbwe`,
    satisfyingEntitlementKeys = [],
    remediationBigIds = [],
    affirmationBigIds = [],
    availabilityStartIso = '2024-01-01T00:00:00.000Z',
    availabilityEndIso = '2099-12-31T00:00:00.000Z',
    externalClientName,
    includePackages = true,
    bundledSkus = [],
  } = spec;

  const packages = includePackages
    ? [
        {
          PackageId: `pkg-${productId.toLowerCase()}`,
          PackageFormat: packageFormat,
          PackageFullName: `SyntheticStudio.${productId}_1.0.0.0_x64__8wekyb3d8bbwe`,
          ContentId: `00000000-0000-4000-8000-${productId.toLowerCase()}`,
          MaxDownloadSizeInBytes: 12 * 1024 * 1024 * 1024,
          PlatformDependencies: [{ PlatformName: platformName }],
          PackageDownloadUris: [{ Uri: `http://127.0.0.1/msixvc/${productId}.msixvc`, Rank: 1 }],
        },
      ]
    : [];

  return {
    ProductId: productId,
    ProductKind: productKind,
    ProductType: productType,
    LocalizedProperties: [
      {
        ProductTitle: title,
        ShortDescription: `Synthetic description for ${title}.`,
        ProductDescription: `Synthetic full description for ${title}.`,
        DeveloperName: 'Synthetic Interactive',
        PublisherName: 'Synthetic Publishing',
        Images: [
          {
            ImagePurpose: 'Poster',
            Uri: `//images-eds-ssl.xboxlive.com/image?url=synth_${productId}`,
            Width: 600,
            Height: 900,
          },
        ],
      },
    ],
    MarketProperties: [{ OriginalReleaseDate: '2025-03-14T00:00:00.000Z' }],
    Properties: {
      Category: 'Action & adventure',
      Categories: ['Action & adventure'],
      PackageFamilyName: packageFamilyName,
      XboxLiveTier: 'Full',
    },
    AlternateIds: [
      { IdType: 'XboxTitleId', Value: '170000001' },
      { IdType: 'PackageFamilyName', Value: packageFamilyName },
    ],
    DisplaySkuAvailabilities: [
      {
        Sku: {
          SkuId: '0010',
          SkuType: 'Full',
          Properties: {
            Packages: packages,
            BundledSkus: bundledSkus,
            ...(externalClientName
              ? {
                  FulfillmentPlugin: {
                    Plugin: 'ExternalClient',
                    ExternalClient: { Name: externalClientName },
                  },
                }
              : {}),
          },
        },
        Availabilities: [
          {
            Actions: ['Fulfill', 'Launch', 'Browse', 'Details'],
            Conditions: {
              StartDate: availabilityStartIso,
              EndDate: availabilityEndIso,
              ClientConditions: {
                AllowedPlatforms: [{ PlatformName: platformName }],
              },
            },
            LicensingData: {
              SatisfyingEntitlementKeys: satisfyingEntitlementKeys.map((k) => ({
                EntitlementKeys: [k],
              })),
            },
            Remediations: remediationBigIds.map((id) => ({
              RemediationId: `rem-${id}`,
              Type: 'LegacyDiscountGold',
              BigId: id,
            })),
            Properties: {},
          },
        ],
      },
    ],
    EligibilityProperties: {
      Affirmations: affirmationBigIds.map((id) => ({
        AffirmationId: `aff-${id}`,
        AffirmationProductId: id,
        Description: 'Legacy discount affirmation',
      })),
      Remediations: remediationBigIds.map((id) => ({
        RemediationId: `elig-rem-${id}`,
        Description: 'Save with pass',
        BigId: id,
      })),
    },
  };
}

function buildStandardSyntheticProductCatalog(): Record<string, any> {
  return {
    [BIGID_PCGP_CORE]: makeDisplayCatalogProduct({
      productId: BIGID_PCGP_CORE,
      title: 'Synthetic Astral Odyssey',
      satisfyingEntitlementKeys: ['big:CFQ7TTC0KHS0:0004', 'big:CFQ7TTC0KGQ8:0001'],
    }),
    [BIGID_EA_PLAY]: makeDisplayCatalogProduct({
      productId: BIGID_EA_PLAY,
      title: 'Synthetic Striker League',
      packageFamilyName: 'ElectronicArts.SyntheticStriker_q5ha1ztykcgvj',
      externalClientName: 'EA Desktop',
      includePackages: false,
      satisfyingEntitlementKeys: [
        'big:CFQ7TTC0KHS0:0004',
        'big:CFQ7TTC0KGQ8:0001',
        'big:CFQ7TTC0K5DH:0006',
      ],
    }),
    [BIGID_UBI_ULT_A]: makeDisplayCatalogProduct({
      productId: BIGID_UBI_ULT_A,
      title: 'Synthetic Nebula Classics Alpha',
      packageFamilyName: 'Ubisoft.SyntheticNebulaAlpha_ngz4m517e0mpw',
      externalClientName: 'UbisoftConnect',
      includePackages: false,
      satisfyingEntitlementKeys: ['big:CFQ7TTC0KHS0:0004', 'big:CFQ7TTBZT8LN:0002'],
    }),
    [BIGID_UBI_ULT_B]: makeDisplayCatalogProduct({
      productId: BIGID_UBI_ULT_B,
      title: 'Synthetic Nebula Classics Bravo',
      packageFamilyName: 'Ubisoft.SyntheticNebulaBeta_ngz4m517e0mpw',
      externalClientName: 'UbisoftConnect',
      includePackages: false,
      // Deliberately over-stamps CFQ7TTC0KGQ8 in DisplayCatalog just like Microsoft's real 40 Ubisoft+ Classics stubs!
      // Authoritative sigls/v3 routing MUST still exclude this title for PC Game Pass subscribers!
      satisfyingEntitlementKeys: [
        'big:CFQ7TTC0KHS0:0004',
        'big:CFQ7TTC0KGQ8:0001',
        'big:CFQ7TTBZT8LN:0002',
      ],
    }),
    [BIGID_ULT_EXCL]: makeDisplayCatalogProduct({
      productId: BIGID_ULT_EXCL,
      title: 'Synthetic Vortex Ultimate Edition',
      satisfyingEntitlementKeys: ['big:CFQ7TTC0KHS0:0004'],
    }),
    [BIGID_OWNED_PC]: makeDisplayCatalogProduct({
      productId: BIGID_OWNED_PC,
      title: 'Synthetic Permanence Chronicles',
      satisfyingEntitlementKeys: [],
    }),
    [BIGID_OWNED_AND_SUB]: makeDisplayCatalogProduct({
      productId: BIGID_OWNED_AND_SUB,
      title: 'Synthetic Dual Entitlement Saga',
      satisfyingEntitlementKeys: ['big:CFQ7TTC0KHS0:0004', 'big:CFQ7TTC0KGQ8:0001'],
    }),
    [BIGID_PREMIUM_PC]: makeDisplayCatalogProduct({
      productId: BIGID_PREMIUM_PC,
      title: 'Synthetic Premium Horizon',
      satisfyingEntitlementKeys: ['big:CFQ7TTC0P85B:0001', 'big:CFQ7TTC0KHS0:0004'],
    }),
    [BIGID_ESSENTIAL_PC]: makeDisplayCatalogProduct({
      productId: BIGID_ESSENTIAL_PC,
      title: 'Synthetic Solaris Essential',
      satisfyingEntitlementKeys: ['big:CFQ7TTC0K5DJ:000K', 'big:CFQ7TTC0KHS0:0004'],
    }),
    [BIGID_GOLD_DISCOUNT_TRAP]: makeDisplayCatalogProduct({
      productId: BIGID_GOLD_DISCOUNT_TRAP,
      title: 'Synthetic Gold Discount Trap',
      // Only Ultimate in LicensingData.SatisfyingEntitlementKeys; Essential is ONLY in Remediations/Affirmations!
      satisfyingEntitlementKeys: ['big:CFQ7TTC0KHS0:0004'],
      remediationBigIds: ['CFQ7TTC0K5DJ'],
      affirmationBigIds: ['CFQ7TTC0K5DJ'],
    }),
    [BIGID_WIN8X_APPX]: makeDisplayCatalogProduct({
      productId: BIGID_WIN8X_APPX,
      title: 'Synthetic Quantum Appx Classic',
      packageFormat: 'Appx',
      platformName: 'Windows.Windows8x',
      satisfyingEntitlementKeys: ['big:CFQ7TTC0KGQ8:0001', 'big:CFQ7TTC0KHS0:0004'],
    }),
    [BIGID_CONSOLE_XVC]: makeDisplayCatalogProduct({
      productId: BIGID_CONSOLE_XVC,
      title: 'Synthetic Console Only Arena',
      packageFormat: 'XVC',
      platformName: 'Windows.Xbox',
      satisfyingEntitlementKeys: ['big:CFQ7TTC0KHS0:0004'],
    }),
    [BIGID_INSTALLED_SOUNDTRACK_TOOL]: makeDisplayCatalogProduct({
      productId: BIGID_INSTALLED_SOUNDTRACK_TOOL,
      title: 'Synthetic Chrono Original Soundtrack',
      satisfyingEntitlementKeys: ['big:CFQ7TTC0KGQ8:0001'],
    }),
    [BIGID_US_REGIONAL_ONLY]: makeDisplayCatalogProduct({
      productId: BIGID_US_REGIONAL_ONLY,
      title: 'Synthetic Frontier US Regional',
      satisfyingEntitlementKeys: ['big:CFQ7TTC0KGQ8:0001', 'big:CFQ7TTC0KHS0:0004'],
    }),
  };
}

function makeSiglPayload(title: string, productIds: string[]) {
  return [
    {
      siglId: 'synthetic-sigl-header',
      title,
      description: `Synthetic SIGL feed for ${title}`,
    },
    ...productIds.map((id) => ({ id })),
  ];
}

function jsonResponse(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeMinimalEnvironmentHealthSnapshot(
  connectedStorefronts: StorefrontId[] = ['xbox']
): EnvironmentHealthSnapshot {
  return {
    probedAt: '2026-06-15T12:00:00.000Z',
    probeDurationMs: 12,
    hostPlatform: 'darwin',
    hostArch: 'arm64',
    isAppleSiliconMac: true,
    hasWriteAccessToSystemApplications: true,
    preferredMacApplicationsDir: '/Applications',
    connectedStorefronts,
    bundledHelpers: {
      gogdlReady: true,
      legendaryReady: true,
      xboxGdkBridgesReady: true,
      metalPreloadReady: true,
    },
    detectedRunners: [],
    bottleSummary: {
      runnerType: null,
      runnerInstalled: false,
      availableBottles: [],
      recommendedBottleMode: 'create_dedicated',
      recommendedBottleName: 'OneLauncher',
    },
    components: {} as any,
    clientLogins: {} as any,
    localStoreHints: [],
    counts: {
      readyCount: 4,
      missingRecommendedCount: 0,
      removedSinceLastSetupCount: 0,
      pendingClientLoginCount: 0,
      accountMismatchCount: 0,
      updateAvailableCount: 0,
    },
  };
}

function buildGamingRootBinaryBuffer(relativeUtf16Folder: string): Buffer {
  const header = Buffer.alloc(8);
  header.write('RGBX', 0, 4, 'ascii');
  header.writeUInt32LE(1, 4);
  const pathBuf = Buffer.from(`${relativeUtf16Folder}\0`, 'utf16le');
  return Buffer.concat([header, pathBuf]);
}

// ============================================================================
// Test Lifecycle Setup & Teardown
// ============================================================================

describe('Xbox Subscription Tier Authority, sigls/v3 Routing, Collections v6.0 & Reconciliation Suite', () => {
  let restoreHermeticGuard: () => void;
  let tmpRoot: string;

  beforeEach(() => {
    ensureWindowAndStorageGlobals();
    memStorage.clear();
    federatorMod.clearFederatorCaches();
    restoreHermeticGuard = installHermeticOfflineSocketGuard();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-xbox-tier-siglv3-'));
  });

  afterEach(() => {
    xboxCatalogAndGamePass.closeXboxCatalogCacheStore(tmpRoot);
    federatorMod.clearFederatorCaches();
    restoreHermeticGuard();
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  // ==========================================================================
  // DOMAIN 1: All Subscription Profiles & Exact `sigls/v3` Routing (`GB` & `US`)
  // ==========================================================================
  describe('1. Subscription Profiles & Exact catalog.gamepass.com/sigls/v3 Routing (GB & US)', () => {
    function createProtocolRouterFetch(options: {
      pcgafdSubscriptions?: any[];
      collectionsPassItems?: any[];
      ownedItems?: any[];
      extraProducts?: Record<string, any>;
    }) {
      const requestedUrls: string[] = [];
      const catalogMap = {
        ...buildStandardSyntheticProductCatalog(),
        ...(options.extraProducts || {}),
      };
      const { GAMEPASS_SIGL_IDS } = xboxCatalogAndGamePass;

      const fetchImpl = vi.fn(async (rawUrl: string, init?: any) => {
        const urlStr = String(rawUrl);
        requestedUrls.push(urlStr);
        const parsed = new URL(urlStr);

        if (parsed.hostname === 'beige.xboxservices.com') {
          if (parsed.pathname.endsWith('/PCGAFD/entitlements/subscriptions')) {
            return jsonResponse({ subscriptions: options.pcgafdSubscriptions || [] });
          }
          if (parsed.pathname.endsWith('/PCGAFD/entitlements')) {
            return jsonResponse({ entitlements: options.ownedItems || [] });
          }
        }

        if (
          parsed.hostname === 'collections.mp.microsoft.com' &&
          parsed.pathname === '/v6.0/collections/query'
        ) {
          let bodyObj: any = {};
          try {
            bodyObj = JSON.parse(String(init?.body || '{}'));
          } catch {}
          if (
            Array.isArray(bodyObj.productTypes) &&
            bodyObj.productTypes.length === 1 &&
            bodyObj.productTypes[0] === 'Pass'
          ) {
            return jsonResponse({ items: options.collectionsPassItems || [] });
          }
          return jsonResponse({ items: options.ownedItems || [] });
        }

        if (parsed.hostname === 'catalog.gamepass.com' && parsed.pathname === '/sigls/v3') {
          const siglId = parsed.searchParams.get('id');
          const mkt = (parsed.searchParams.get('market') || 'US').toUpperCase();
          const subCtx = (parsed.searchParams.get('subscriptionContext') || '').toLowerCase();

          if (siglId === GAMEPASS_SIGL_IDS.ULTIMATE_ALL_PC && subCtx === 'cfq7ttc0khs0') {
            return jsonResponse(
              makeSiglPayload('Xbox Game Pass Ultimate PC', [
                BIGID_PCGP_CORE,
                BIGID_EA_PLAY,
                BIGID_UBI_ULT_A,
                BIGID_UBI_ULT_B,
                BIGID_ULT_EXCL,
                BIGID_OWNED_AND_SUB,
                BIGID_CONSOLE_XVC,
              ])
            );
          }

          if (siglId === GAMEPASS_SIGL_IDS.PC_GAME_PASS_ALL && subCtx === 'cfq7ttc0kgq8') {
            const pcgpList = [
              BIGID_PCGP_CORE,
              BIGID_EA_PLAY,
              BIGID_OWNED_AND_SUB,
              ...(mkt === 'US' ? [BIGID_US_REGIONAL_ONLY] : []),
            ];
            return jsonResponse(makeSiglPayload('PC Game Pass', pcgpList));
          }

          if (siglId === GAMEPASS_SIGL_IDS.PREMIUM && subCtx === 'cfq7ttc0p85b') {
            // Injects an Ultimate-only product alongside Premium to verify Layer-3 blocks unentitled SIGL bleed
            return jsonResponse(
              makeSiglPayload('Xbox Game Pass Premium PC', [BIGID_PREMIUM_PC, BIGID_ULT_EXCL])
            );
          }

          if (siglId === GAMEPASS_SIGL_IDS.ESSENTIAL && subCtx === 'cfq7ttc0k5dj') {
            // Includes LegacyDiscountGold trap to prove Layer-3 only trusts SatisfyingEntitlementKeys
            return jsonResponse(
              makeSiglPayload('Xbox Game Pass Essential PC', [
                BIGID_ESSENTIAL_PC,
                BIGID_GOLD_DISCOUNT_TRAP,
              ])
            );
          }

          if (siglId === GAMEPASS_SIGL_IDS.EA_PLAY_PC && subCtx === 'cfq7ttc0kgq8') {
            return jsonResponse(makeSiglPayload('EA Play PC', [BIGID_EA_PLAY]));
          }

          if (siglId === GAMEPASS_SIGL_IDS.UBISOFT_CLASSICS_PC && subCtx === 'cfq7ttbzt8ln') {
            return jsonResponse(
              makeSiglPayload('Ubisoft+ Classics PC', [BIGID_UBI_ULT_A, BIGID_UBI_ULT_B])
            );
          }

          if (siglId === GAMEPASS_SIGL_IDS.LEAVING_SOON) {
            return jsonResponse(makeSiglPayload('Leaving Soon', [BIGID_PCGP_CORE]));
          }

          if (siglId === GAMEPASS_SIGL_IDS.RECENTLY_ADDED_PC) {
            return jsonResponse(makeSiglPayload('Recently Added', [BIGID_EA_PLAY]));
          }

          return jsonResponse({ error: 'Unexpected sigls/v3 query' }, 400);
        }

        if (parsed.hostname === 'catalog.gamepass.com' && parsed.pathname === '/sigls/v2') {
          return jsonResponse(makeSiglPayload('Legacy v2 Aux', []));
        }

        if (parsed.hostname === 'displaycatalog.mp.microsoft.com') {
          const bigIds = (parsed.searchParams.get('bigIds') || '')
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean);
          const products = bigIds.map((id) => catalogMap[id]).filter(Boolean);
          return jsonResponse({ Products: products });
        }

        throw new Error(`Unhandled synthetic fetch URL: ${urlStr} (${init?.method || 'GET'})`);
      });

      return { fetchImpl, requestedUrls };
    }

    it('routes Xbox Game Pass Ultimate (CFQ7TTC0KHS0) to 97c6c862... with subscriptionContext=cfq7ttc0khs0 and admits PCGP + EA Play + Ubisoft+ Classics + Ultimate-exclusive titles', async () => {
      const { fetchImpl, requestedUrls } = createProtocolRouterFetch({
        pcgafdSubscriptions: [
          {
            productId: 'CFQ7TTC0KHS0',
            status: 'Active',
            autoRenew: true,
            endDate: FUTURE_END_ISO,
          },
        ],
        collectionsPassItems: [
          {
            productId: 'CFQ7TTC0KHS0',
            skuId: '0004',
            status: 'Active',
            endDate: FUTURE_END_ISO,
          },
        ],
      });

      const result = await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        syncMode: 'full_pc_game_pass',
        market: 'GB',
        locale: 'en-GB',
        userDataDir: tmpRoot,
        fetchImpl,
        nowMs: FIXED_NOW_MS,
      });

      expect(result.authoritativeComplete).toBe(true);
      expect(result.subscription).toMatchObject({
        hasActiveSubscription: true,
        tierId: 'ultimate',
        tierDisplayName: 'Xbox Game Pass Ultimate',
        hasPcCatalogAccess: true,
        activeProductIds: ['CFQ7TTC0KHS0'],
      });
      expect(result.subscription.expandedCapabilityPassIds).toEqual(
        expect.arrayContaining([
          'CFQ7TTC0KHS0',
          'CFQ7TTC0KGQ8',
          'CFQ7TTC0P85B',
          'CFQ7TTC0K5DJ',
          'CFQ7TTC0K5DH',
          'CFQ7TTBZT8LN',
        ])
      );

      const siglUrls = requestedUrls.filter((u) => u.includes('/sigls/v3'));
      expect(
        siglUrls.some(
          (u) =>
            u.includes('id=97c6c862-d28a-4907-a3d5-c401f2296a53') &&
            u.includes('language=en-gb') &&
            u.includes('market=GB') &&
            u.includes('platformContext=pc') &&
            u.includes('subscriptionContext=cfq7ttc0khs0')
        )
      ).toBe(true);
      expect(siglUrls.some((u) => u.includes('id=609d944c-d395-4c0a-9ea4-e9f39b52c1ad'))).toBe(
        false
      );

      const syncedBigIds = result.games.map(getXboxBigIdFromGame).sort();
      expect(syncedBigIds).toEqual(
        [
          BIGID_PCGP_CORE,
          BIGID_EA_PLAY,
          BIGID_UBI_ULT_A,
          BIGID_UBI_ULT_B,
          BIGID_ULT_EXCL,
          BIGID_OWNED_AND_SUB,
        ].sort()
      );
      // Console-only XVC must still be rejected by 5-Gate desktop filter
      expect(syncedBigIds).not.toContain(BIGID_CONSOLE_XVC);

      const ubiGame = result.games.find(
        (g: CanonicalGame) => getXboxBigIdFromGame(g) === BIGID_UBI_ULT_A
      );
      expect(ubiGame?.platforms[0]).toMatchObject({
        platformId: 'xbox',
        ownershipType: 'subscription',
        gamePassTier: 'Xbox Game Pass Ultimate',
      });
      expect(ubiGame?.platforms[0]?.satisfyingPassIds).toEqual(
        expect.arrayContaining(['CFQ7TTC0KHS0'])
      );
    });

    it('routes PC Game Pass (CFQ7TTC0KGQ8) to 609d944c... (subscriptionContext=cfq7ttc0kgq8), EXCLUDES over-stamped Ubisoft+ Classics Ultimate stubs, and honors GB vs US regional delta', async () => {
      const pcgpSubscriptions = [
        {
          productId: 'CFQ7TTC0KGQ8',
          status: 'Active',
          autoRenew: false,
          endDate: FUTURE_END_ISO,
        },
      ];
      const pcgpCollections = [
        {
          productId: 'CFQ7TTC0KGQ8',
          skuId: '0001',
          status: 'Active',
          endDate: FUTURE_END_ISO,
        },
      ];
      const ownedItems = [
        {
          productId: BIGID_OWNED_PC,
          productKind: 'Game',
          ownershipType: 'owned',
          status: 'Active',
        },
        {
          productId: BIGID_OWNED_AND_SUB,
          productKind: 'Game',
          ownershipType: 'owned',
          status: 'Active',
        },
      ];

      // 1) GB market sync (with mismatched en-US locale aligned automatically to en-GB)
      expect(xboxCatalogAndGamePass.alignXboxLocaleWithMarket('en-US', 'GB')).toBe('en-GB');
      const gbDir = path.join(tmpRoot, 'gb');
      fs.mkdirSync(gbDir, { recursive: true });
      const gbRouter = createProtocolRouterFetch({
        pcgafdSubscriptions: pcgpSubscriptions,
        collectionsPassItems: pcgpCollections,
        ownedItems,
      });

      const gbResult = await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        syncMode: 'full_pc_game_pass',
        market: 'GB',
        locale: 'en-US', // must auto-align to en-gb in SIGL request!
        userDataDir: gbDir,
        fetchImpl: gbRouter.fetchImpl,
        nowMs: FIXED_NOW_MS,
      });
      xboxCatalogAndGamePass.closeXboxCatalogCacheStore(gbDir);

      expect(gbResult.subscription).toMatchObject({
        hasActiveSubscription: true,
        tierId: 'pc',
        tierDisplayName: 'PC Game Pass',
        autoRenew: false,
        activeProductIds: ['CFQ7TTC0KGQ8'],
      });
      expect(gbResult.subscription.expandedCapabilityPassIds).toEqual(
        expect.arrayContaining(['CFQ7TTC0KGQ8', 'CFQ7TTC0K5DH'])
      );
      expect(gbResult.subscription.expandedCapabilityPassIds).not.toContain('CFQ7TTBZT8LN');
      expect(gbResult.subscription.expandedCapabilityPassIds).not.toContain('CFQ7TTC0KHS0');

      const gbSiglUrls = gbRouter.requestedUrls.filter((u) => u.includes('/sigls/v3'));
      expect(
        gbSiglUrls.some(
          (u) =>
            u.includes('id=609d944c-d395-4c0a-9ea4-e9f39b52c1ad') &&
            u.includes('language=en-gb') &&
            u.includes('market=GB') &&
            u.includes('platformContext=pc') &&
            u.includes('subscriptionContext=cfq7ttc0kgq8')
        )
      ).toBe(true);
      // Core regression invariant: Ultimate PC feed (97c6c862...) and Ubisoft+ feed (66ec875c...) MUST NOT be queried!
      expect(gbSiglUrls.some((u) => u.includes('97c6c862-d28a-4907-a3d5-c401f2296a53'))).toBe(
        false
      );
      expect(gbSiglUrls.some((u) => u.includes('66ec875c-a391-44f5-9a54-a28bd6f976ce'))).toBe(
        false
      );

      const gbIds = gbResult.games.map(getXboxBigIdFromGame).sort();
      expect(gbIds).toEqual(
        [BIGID_PCGP_CORE, BIGID_EA_PLAY, BIGID_OWNED_PC, BIGID_OWNED_AND_SUB].sort()
      );
      // Even though BIGID_UBI_ULT_B over-stamped big:CFQ7TTC0KGQ8:0001 in DisplayCatalog, sigls/v3 excluded it!
      expect(gbIds).not.toContain(BIGID_UBI_ULT_A);
      expect(gbIds).not.toContain(BIGID_UBI_ULT_B);
      expect(gbIds).not.toContain(BIGID_ULT_EXCL);
      expect(gbIds).not.toContain(BIGID_US_REGIONAL_ONLY);

      const dualGame = gbResult.games.find(
        (g: CanonicalGame) => getXboxBigIdFromGame(g) === BIGID_OWNED_AND_SUB
      );
      expect(dualGame?.platforms[0]?.ownershipType).toBe('owned_and_subscription');
      const eaGame = gbResult.games.find(
        (g: CanonicalGame) => getXboxBigIdFromGame(g) === BIGID_EA_PLAY
      );
      expect(eaGame?.platforms[0]?.gamePassTier).toBe('PC Game Pass');
      expect(eaGame?.platforms[0]?.satisfyingPassIds).toEqual(['CFQ7TTC0KGQ8']);

      // 2) US market sync includes US-regional title with language=en-us&market=US
      const usDir = path.join(tmpRoot, 'us');
      fs.mkdirSync(usDir, { recursive: true });
      const usRouter = createProtocolRouterFetch({
        pcgafdSubscriptions: pcgpSubscriptions,
        collectionsPassItems: pcgpCollections,
        ownedItems: [],
      });

      const usResult = await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        syncMode: 'full_pc_game_pass',
        market: 'US',
        locale: 'en-US',
        userDataDir: usDir,
        fetchImpl: usRouter.fetchImpl,
        nowMs: FIXED_NOW_MS,
      });
      xboxCatalogAndGamePass.closeXboxCatalogCacheStore(usDir);

      expect(
        usRouter.requestedUrls.some(
          (u) =>
            u.includes('id=609d944c-d395-4c0a-9ea4-e9f39b52c1ad') &&
            u.includes('language=en-us') &&
            u.includes('market=US')
        )
      ).toBe(true);
      expect(usResult.games.map(getXboxBigIdFromGame)).toContain(BIGID_US_REGIONAL_ONLY);
    });

    it('routes Game Pass Premium (CFQ7TTC0P85B) to 09a72c0d... and blocks Ultimate/PCGP-only products at Layer-3', async () => {
      const { fetchImpl, requestedUrls } = createProtocolRouterFetch({
        pcgafdSubscriptions: [
          { productId: 'CFQ7TTC0P85B', status: 'Active', autoRenew: true, endDate: FUTURE_END_ISO },
        ],
        collectionsPassItems: [
          { productId: 'CFQ7TTC0P85B', skuId: '0001', status: 'Active', endDate: FUTURE_END_ISO },
        ],
      });

      const result = await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        syncMode: 'full_pc_game_pass',
        market: 'GB',
        locale: 'en-GB',
        userDataDir: tmpRoot,
        fetchImpl,
        nowMs: FIXED_NOW_MS,
      });

      expect(result.subscription.tierId).toBe('premium');
      expect(result.subscription.tierDisplayName).toBe('Xbox Game Pass Premium');
      expect(
        requestedUrls.some(
          (u) =>
            u.includes('id=09a72c0d-c466-426a-9580-b78955d8173a') &&
            u.includes('platformContext=pc') &&
            u.includes('subscriptionContext=cfq7ttc0p85b')
        )
      ).toBe(true);
      // BIGID_ULT_EXCL was present in the mocked SIGL array, but Layer-3 rejected it because it only has CFQ7TTC0KHS0!
      expect(result.games.map(getXboxBigIdFromGame)).toEqual([BIGID_PREMIUM_PC]);
    });

    it('routes Game Pass Essential (CFQ7TTC0K5DJ) to 34031711... (hasPcCatalogAccess: true) and ignores LegacyDiscountGold Remediations/Affirmations', async () => {
      const { fetchImpl, requestedUrls } = createProtocolRouterFetch({
        pcgafdSubscriptions: [
          { productId: 'CFQ7TTC0K5DJ', status: 'Active', autoRenew: true, endDate: FUTURE_END_ISO },
        ],
        collectionsPassItems: [
          { productId: 'CFQ7TTC0K5DJ', skuId: '000K', status: 'Active', endDate: FUTURE_END_ISO },
        ],
      });

      const result = await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        syncMode: 'full_pc_game_pass',
        market: 'GB',
        locale: 'en-GB',
        userDataDir: tmpRoot,
        fetchImpl,
        nowMs: FIXED_NOW_MS,
      });

      expect(result.subscription).toMatchObject({
        hasActiveSubscription: true,
        tierId: 'essential',
        tierDisplayName: 'Xbox Game Pass Essential',
        hasPcCatalogAccess: true,
      });
      expect(
        requestedUrls.some(
          (u) =>
            u.includes('id=34031711-5a70-4196-bab7-45757dc2294e') &&
            u.includes('platformContext=pc') &&
            u.includes('subscriptionContext=cfq7ttc0k5dj')
        )
      ).toBe(true);

      const ids = result.games.map(getXboxBigIdFromGame);
      expect(ids).toEqual([BIGID_ESSENTIAL_PC]);
      // BIGID_GOLD_DISCOUNT_TRAP had CFQ7TTC0K5DJ in Remediations & Affirmations, NOT SatisfyingEntitlementKeys!
      expect(ids).not.toContain(BIGID_GOLD_DISCOUNT_TRAP);
    });

    it('routes Standalone EA Play (CFQ7TTC0K5DH) to 1d33fbb9... with subscriptionContext=cfq7ttc0kgq8 (NEVER cfq7ttc0k5dh)', async () => {
      const { fetchImpl, requestedUrls } = createProtocolRouterFetch({
        pcgafdSubscriptions: [
          { productId: 'CFQ7TTC0K5DH', status: 'Active', autoRenew: true, endDate: FUTURE_END_ISO },
        ],
        collectionsPassItems: [
          { productId: 'CFQ7TTC0K5DH', skuId: '0006', status: 'Active', endDate: FUTURE_END_ISO },
        ],
      });

      const result = await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        syncMode: 'full_pc_game_pass',
        market: 'US',
        locale: 'en-US',
        userDataDir: tmpRoot,
        fetchImpl,
        nowMs: FIXED_NOW_MS,
      });

      expect(result.subscription.tierId).toBe('ea_play');
      expect(result.subscription.tierDisplayName).toBe('EA Play');
      const siglUrls = requestedUrls.filter((u) => u.includes('/sigls/v3'));
      expect(
        siglUrls.some(
          (u) =>
            u.includes('id=1d33fbb9-b895-4732-a8ca-a55c8b99fa2c') &&
            u.includes('platformContext=pc') &&
            u.includes('subscriptionContext=cfq7ttc0kgq8')
        )
      ).toBe(true);
      expect(siglUrls.some((u) => u.toLowerCase().includes('subscriptioncontext=cfq7ttc0k5dh'))).toBe(
        false
      );
      expect(result.games.map(getXboxBigIdFromGame)).toEqual([BIGID_EA_PLAY]);
      expect(result.games[0].platforms[0].gamePassTier).toBe('EA Play');
    });

    it('unions multi-pass combinations: (PC Game Pass + Ubisoft+ Premium) and (Game Pass Premium + EA Play) with exact per-game tier attribution', async () => {
      // Case A: PC Game Pass (CFQ7TTC0KGQ8) + Ubisoft+ Premium (CFQ7TTC0QH5H -> expands CFQ7TTBZT8LN)
      const dirA = path.join(tmpRoot, 'union-pc-ubi');
      fs.mkdirSync(dirA, { recursive: true });
      const routerA = createProtocolRouterFetch({
        collectionsPassItems: [
          { productId: 'CFQ7TTC0KGQ8', skuId: '0001', status: 'Active', endDate: FUTURE_END_ISO },
          { productId: 'CFQ7TTC0QH5H', skuId: '0001', status: 'Active', endDate: FUTURE_END_ISO },
        ],
      });

      const resA = await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        syncMode: 'full_pc_game_pass',
        market: 'GB',
        locale: 'en-GB',
        userDataDir: dirA,
        fetchImpl: routerA.fetchImpl,
        nowMs: FIXED_NOW_MS,
      });
      xboxCatalogAndGamePass.closeXboxCatalogCacheStore(dirA);

      expect(resA.subscription.tierId).toBe('pc');
      expect(resA.subscription.tierDisplayName).toBe('PC Game Pass + Ubisoft+ Premium');
      expect(resA.subscription.expandedCapabilityPassIds).toEqual(
        expect.arrayContaining(['CFQ7TTC0KGQ8', 'CFQ7TTC0K5DH', 'CFQ7TTC0QH5H', 'CFQ7TTBZT8LN'])
      );
      expect(
        routerA.requestedUrls.some(
          (u) =>
            u.includes('id=609d944c-d395-4c0a-9ea4-e9f39b52c1ad') &&
            u.includes('subscriptionContext=cfq7ttc0kgq8')
        )
      ).toBe(true);
      expect(
        routerA.requestedUrls.some(
          (u) =>
            u.includes('id=66ec875c-a391-44f5-9a54-a28bd6f976ce') &&
            u.includes('subscriptionContext=cfq7ttbzt8ln')
        )
      ).toBe(true);

      const idsA = resA.games.map(getXboxBigIdFromGame).sort();
      expect(idsA).toEqual(
        [BIGID_PCGP_CORE, BIGID_EA_PLAY, BIGID_UBI_ULT_A, BIGID_UBI_ULT_B, BIGID_OWNED_AND_SUB].sort()
      );
      const ubiAlpha = resA.games.find(
        (g: CanonicalGame) => getXboxBigIdFromGame(g) === BIGID_UBI_ULT_A
      );
      expect(ubiAlpha?.platforms[0]?.gamePassTier).toBe('Ubisoft+ Premium');
      expect(ubiAlpha?.platforms[0]?.satisfyingPassIds).toContain('CFQ7TTC0QH5H');

      // Case B: Game Pass Premium (CFQ7TTC0P85B) + EA Play (CFQ7TTC0K5DH)
      const dirB = path.join(tmpRoot, 'union-prem-ea');
      fs.mkdirSync(dirB, { recursive: true });
      const routerB = createProtocolRouterFetch({
        collectionsPassItems: [
          { productId: 'CFQ7TTC0P85B', skuId: '0001', status: 'Active', endDate: FUTURE_END_ISO },
          { productId: 'CFQ7TTC0K5DH', skuId: '0006', status: 'Active', endDate: FUTURE_END_ISO },
        ],
      });

      const resB = await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        syncMode: 'full_pc_game_pass',
        market: 'GB',
        locale: 'en-GB',
        userDataDir: dirB,
        fetchImpl: routerB.fetchImpl,
        nowMs: FIXED_NOW_MS,
      });
      xboxCatalogAndGamePass.closeXboxCatalogCacheStore(dirB);

      expect(resB.subscription.tierDisplayName).toBe('Xbox Game Pass Premium + EA Play');
      expect(resB.games.map(getXboxBigIdFromGame).sort()).toEqual(
        [BIGID_PREMIUM_PC, BIGID_EA_PLAY].sort()
      );
      const eaUnionGame = resB.games.find(
        (g: CanonicalGame) => getXboxBigIdFromGame(g) === BIGID_EA_PLAY
      );
      expect(eaUnionGame?.platforms[0]?.gamePassTier).toBe('EA Play');
      expect(eaUnionGame?.platforms[0]?.satisfyingPassIds).toContain('CFQ7TTC0K5DH');
    });

    it('fetches 0 Game Pass SIGLs for Console-Only (CFQ7TTC0K6L8) and No-Subscription accounts while syncing owned MS Store PC games', async () => {
      const routerConsole = createProtocolRouterFetch({
        pcgafdSubscriptions: [
          { productId: 'CFQ7TTC0K6L8', status: 'Active', autoRenew: true, endDate: FUTURE_END_ISO },
        ],
        collectionsPassItems: [
          { productId: 'CFQ7TTC0K6L8', skuId: '0001', status: 'Active', endDate: FUTURE_END_ISO },
        ],
        ownedItems: [
          { productId: BIGID_OWNED_PC, productKind: 'Game', ownershipType: 'owned', status: 'Active' },
        ],
      });

      const consoleRes = await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        syncMode: 'full_pc_game_pass',
        market: 'GB',
        locale: 'en-GB',
        userDataDir: tmpRoot,
        fetchImpl: routerConsole.fetchImpl,
        nowMs: FIXED_NOW_MS,
      });

      expect(consoleRes.subscription).toMatchObject({
        hasActiveSubscription: true,
        tierId: 'console_only',
        hasPcCatalogAccess: false,
      });
      expect(routerConsole.requestedUrls.filter((u) => u.includes('catalog.gamepass.com'))).toEqual(
        []
      );
      expect(consoleRes.games.map(getXboxBigIdFromGame)).toEqual([BIGID_OWNED_PC]);
      expect(consoleRes.games[0].platforms[0].ownershipType).toBe('owned');
    });
  });

  // ==========================================================================
  // DOMAIN 2: Collections v6.0 WLID1.0, Non-Gaming CFQ7TTC* & Dynamic Passes
  // ==========================================================================
  describe('2. Collections v6.0 WLID1.0 Contract, Non-Gaming CFQ7TTC* Rejection, CFQ7TTBZ* Pass Recognition & Dynamic Hydration', () => {
    it('sends WLID1.0="<cleanTicket>" and beneficiaries[{ identityType: "msa" }] (never b2b or device-less XBL3.0) and merges skuId with PCGAFD autoRenew/isTrial', async () => {
      let capturedHeaders: Record<string, string> = {};
      let capturedBody: any = null;

      const fetchImpl = vi.fn(async (rawUrl: string, init?: any) => {
        const parsed = new URL(String(rawUrl));
        if (parsed.hostname === 'beige.xboxservices.com') {
          return jsonResponse({
            subscriptions: [
              {
                productId: 'CFQ7TTC0KGQ8',
                status: 'Active',
                autoRenew: true,
                isTrial: true,
                endDate: FUTURE_END_ISO,
              },
            ],
          });
        }
        if (parsed.hostname === 'collections.mp.microsoft.com') {
          capturedHeaders = Object.fromEntries(
            Object.entries(init?.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
          );
          capturedBody = JSON.parse(String(init?.body || '{}'));
          return jsonResponse({
            items: [
              {
                productId: 'CFQ7TTC0KGQ8',
                skuId: '0002', // Real trial SKU from Collections v6.0
                status: 'Active',
                endDate: FUTURE_END_ISO,
              },
            ],
          });
        }
        throw new Error(`Unexpected URL: ${rawUrl}`);
      });

      const sub = await xboxCatalogAndGamePass.detectXboxSubscriptions({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: `t=${SYNTH_MSA_TICKET.slice(2)}`,
        market: 'GB',
        locale: 'en-GB',
        fetchImpl,
        nowMs: FIXED_NOW_MS,
      });

      expect(capturedHeaders.authorization).toBe(
        `WLID1.0="${SYNTH_MSA_TICKET.replace(/^t=/i, '')}"`
      );
      expect(capturedHeaders.authorization).not.toContain('XBL3.0');
      expect(capturedBody).toMatchObject({
        market: 'GB',
        includeDuplicates: true,
        productTypes: ['Pass'],
        statusFilters: ['Active'],
        entitlementFilters: ['*:*'],
        maxPageSize: 1000,
        beneficiaries: [
          {
            identityType: 'msa',
            identityValue: SYNTH_MSA_TICKET.replace(/^t=/i, ''),
            localTicketReference: 'primary',
          },
        ],
      });
      expect(JSON.stringify(capturedBody)).not.toContain('"b2b"');

      // Real skuId (0002) from Collections overrides PCGAFD's missing skuId while preserving PCGAFD autoRenew & isTrial
      expect(sub.isTrial).toBe(true);
      expect(sub.autoRenew).toBe(true);
      expect(sub.activeEntitlementKeys).toContain('CFQ7TTC0KGQ8:0002');
    });

    it('rejects Expired/Revoked/Banned/past-endDate records from Collections v6.0 while preserving Active + autoRenew:false until endDate elapses', async () => {
      const fetchImpl = vi.fn(async (rawUrl: string) => {
        const parsed = new URL(String(rawUrl));
        if (parsed.hostname === 'beige.xboxservices.com') {
          return jsonResponse({
            subscriptions: [
              {
                productId: 'CFQ7TTC0KGQ8',
                status: 'Active',
                autoRenew: false,
                endDate: FUTURE_END_ISO,
              },
            ],
          });
        }
        if (parsed.hostname === 'collections.mp.microsoft.com') {
          return jsonResponse({
            items: [
              // Server returned stale/revoked Ultimate & Ubisoft records despite statusFilters: ['Active']
              { productId: 'CFQ7TTC0KHS0', skuId: '0004', status: 'Expired', endDate: FUTURE_END_ISO },
              { productId: 'CFQ7TTC0QH5H', skuId: '0001', status: 'Revoked', endDate: FUTURE_END_ISO },
              { productId: 'CFQ7TTC0P85B', skuId: '0001', status: 'Banned', endDate: FUTURE_END_ISO },
              { productId: 'CFQ7TTC0K5DH', skuId: '0006', status: 'Active', endDate: PAST_END_ISO },
              // Valid cancelled-but-unexpired PC Game Pass record
              {
                productId: 'CFQ7TTC0KGQ8',
                skuId: '0001',
                status: 'Active',
                autoRenew: false,
                endDate: FUTURE_END_ISO,
              },
            ],
          });
        }
        throw new Error(`Unexpected URL: ${rawUrl}`);
      });

      const beforeExpiry = await xboxCatalogAndGamePass.detectXboxSubscriptions({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        market: 'GB',
        fetchImpl,
        nowMs: FIXED_NOW_MS,
      });

      expect(beforeExpiry).toMatchObject({
        hasActiveSubscription: true,
        tierId: 'pc',
        autoRenew: false,
        activeProductIds: ['CFQ7TTC0KGQ8'],
      });

      // Advance clock past FUTURE_END_ISO -> immediately transitions to inactive!
      const afterExpiry = await xboxCatalogAndGamePass.detectXboxSubscriptions({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        market: 'GB',
        fetchImpl,
        nowMs: Date.parse('2026-07-21T00:00:00.000Z'),
      });
      expect(afterExpiry.hasActiveSubscription).toBe(false);
      expect(afterExpiry.tierId).toBe('none');
    });

    it('rejects active Microsoft 365 (CFQ7TTC0K5BF), OneDrive (CFQ7TTC0TS2G), and Fortnite Crew (CFQ7TTC0L23L) alongside expired Game Pass', async () => {
      const fetchImpl = vi.fn(async (rawUrl: string) => {
        const parsed = new URL(String(rawUrl));
        if (parsed.hostname === 'beige.xboxservices.com') {
          return jsonResponse({
            subscriptions: [
              { productId: 'CFQ7TTC0KHS0', status: 'Expired', endDate: PAST_END_ISO },
            ],
          });
        }
        if (parsed.hostname === 'collections.mp.microsoft.com') {
          return jsonResponse({
            items: [
              { productId: 'CFQ7TTC0K5BF', skuId: '0001', status: 'Active', endDate: FUTURE_END_ISO },
              { productId: 'CFQ7TTC0TS2G', skuId: '0001', status: 'Active', endDate: FUTURE_END_ISO },
              { productId: 'CFQ7TTC0L23L', skuId: '0001', status: 'Active', endDate: FUTURE_END_ISO },
              { productId: 'CFQ7TTC0KHS0', skuId: '0004', status: 'Expired', endDate: PAST_END_ISO },
            ],
          });
        }
        throw new Error(`Unexpected URL: ${rawUrl}`);
      });

      const sub = await xboxCatalogAndGamePass.detectXboxSubscriptions({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        market: 'GB',
        fetchImpl,
        nowMs: FIXED_NOW_MS,
      });

      expect(sub.hasActiveSubscription).toBe(false);
      expect(sub.tierId).toBe('none');
      expect(sub.activeProductIds).toEqual([]);
      // Zero DisplayCatalog calls wasted on known non-gaming ignore-list passes
      expect(
        fetchImpl.mock.calls.some(([u]) => String(u).includes('displaycatalog.mp.microsoft.com'))
      ).toBe(false);
    });

    it('recognizes CFQ7TTBZT8LN (CFQ7TTBZ* prefix) as a pass and NEVER misclassifies pass-satisfied games as permanently owned', async () => {
      expect(xboxCatalogAndGamePass.isXboxPassProductId('CFQ7TTBZT8LN')).toBe(true);
      expect(xboxCatalogAndGamePass.isXboxPassProductId('CFQ7TTBZT8K1')).toBe(true);
      expect(xboxCatalogAndGamePass.isXboxPassProductId(BIGID_OWNED_PC)).toBe(false);

      const classified = xboxCatalogAndGamePass.classifyXboxEntitlement({
        productId: BIGID_UBI_ULT_A,
        productKind: 'Game',
        status: 'Active',
        satisfiedByProductIds: ['CFQ7TTBZT8LN'],
      });
      expect(classified.include).toBe(true);
      expect(classified.ownershipType).toBe('subscription');
      expect(classified.satisfiedByPassIds).toContain('CFQ7TTBZT8LN');

      const passItself = xboxCatalogAndGamePass.classifyXboxEntitlement({
        productId: 'CFQ7TTBZT8LN',
        productKind: 'Pass',
        status: 'Active',
      });
      expect(passItself.include).toBe(false);
      expect(passItself.reason).toBe('subscription_pass_sku');

      const ownedRes = await xboxCatalogAndGamePass.fetchXboxOwnedEntitlements({
        storeToken: SYNTH_STORE_AUTH,
        fetchImpl: async () =>
          jsonResponse({
            entitlements: [
              {
                productId: BIGID_UBI_ULT_A,
                productKind: 'Game',
                status: 'Active',
                satisfiedByProductIds: ['CFQ7TTBZT8LN'],
              },
              {
                productId: BIGID_OWNED_PC,
                productKind: 'Game',
                ownershipType: 'owned',
                status: 'Active',
              },
              {
                productId: 'CFQ7TTBZT8LN',
                productKind: 'Pass',
                status: 'Active',
              },
            ],
          }),
      });

      expect(ownedRes.ownedProductIds.has(BIGID_OWNED_PC)).toBe(true);
      expect(ownedRes.ownedProductIds.has(BIGID_UBI_ULT_A)).toBe(false);
      expect(ownedRes.subscriptionSatisfiedIds.get(BIGID_UBI_ULT_A)?.has('CFQ7TTBZT8LN')).toBe(
        true
      );
      expect(ownedRes.ownedProductIds.has('CFQ7TTBZT8LN')).toBe(false);
    });

    it('hydrates unknown active CFQ7TT* gaming passes dynamically via multi-hop BundledSkus (depth <= 3) while rejecting unknown productivity passes', async () => {
      const SYNTH_FUTURE_BUNDLE_HOP1 = 'CFQ7TTC0ZZ99';
      const SYNTH_FUTURE_BUNDLE_HOP2 = 'CFQ7TTC0ZZ98';
      const SYNTH_PRODUCTIVITY_PASS = 'CFQ7TTC0YY88';

      const dynamicCatalog: Record<string, any> = {
        [SYNTH_FUTURE_BUNDLE_HOP1]: makeDisplayCatalogProduct({
          productId: SYNTH_FUTURE_BUNDLE_HOP1,
          title: 'Synthetic Future Carrier Bundle',
          productKind: 'Pass',
          productType: 'Pass',
          includePackages: false,
          bundledSkus: [{ BigId: SYNTH_FUTURE_BUNDLE_HOP2, SkuId: '0001' }],
        }),
        [SYNTH_FUTURE_BUNDLE_HOP2]: makeDisplayCatalogProduct({
          productId: SYNTH_FUTURE_BUNDLE_HOP2,
          title: 'Synthetic Carrier Gaming Sub-Pass',
          productKind: 'Pass',
          productType: 'Pass',
          includePackages: false,
          bundledSkus: [{ BigId: 'CFQ7TTC0KHS0', SkuId: '0004' }],
        }),
        [SYNTH_PRODUCTIVITY_PASS]: makeDisplayCatalogProduct({
          productId: SYNTH_PRODUCTIVITY_PASS,
          title: 'Contoso Cloud Storage Workspace 1TB',
          productKind: 'Pass',
          productType: 'Pass',
          includePackages: false,
          bundledSkus: [],
        }),
      };

      const fetchForDynamic = vi.fn(async (rawUrl: string) => {
        const parsed = new URL(String(rawUrl));
        if (parsed.hostname === 'beige.xboxservices.com') {
          return jsonResponse({ subscriptions: [] });
        }
        if (parsed.hostname === 'collections.mp.microsoft.com') {
          return jsonResponse({
            items: [
              {
                productId: SYNTH_FUTURE_BUNDLE_HOP1,
                skuId: '0001',
                status: 'Active',
                endDate: FUTURE_END_ISO,
              },
              {
                productId: SYNTH_PRODUCTIVITY_PASS,
                skuId: '0001',
                status: 'Active',
                endDate: FUTURE_END_ISO,
              },
            ],
          });
        }
        if (parsed.hostname === 'displaycatalog.mp.microsoft.com') {
          const bigIds = (parsed.searchParams.get('bigIds') || '')
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean);
          return jsonResponse({
            Products: bigIds.map((id) => dynamicCatalog[id]).filter(Boolean),
          });
        }
        throw new Error(`Unexpected URL: ${rawUrl}`);
      });

      const sub = await xboxCatalogAndGamePass.detectXboxSubscriptions({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        market: 'US',
        locale: 'en-US',
        fetchImpl: fetchForDynamic,
        nowMs: FIXED_NOW_MS,
      });

      expect(sub.hasActiveSubscription).toBe(true);
      expect(sub.tierId).toBe('ultimate');
      expect(sub.expandedCapabilityPassIds).toEqual(
        expect.arrayContaining([
          SYNTH_FUTURE_BUNDLE_HOP1,
          'CFQ7TTC0KHS0',
          'CFQ7TTC0KGQ8',
          'CFQ7TTC0K5DH',
          'CFQ7TTBZT8LN',
        ])
      );
      // Non-gaming productivity pass was NOT admitted
      expect(sub.activeProductIds).not.toContain(SYNTH_PRODUCTIVITY_PASS);
      expect(sub.expandedCapabilityPassIds).not.toContain(SYNTH_PRODUCTIVITY_PASS);
    });
  });

  // ==========================================================================
  // DOMAIN 3: Keep-Current Lifecycle, Cache Invalidation, Fallbacks & Gates 2+5
  // ==========================================================================
  describe('3. Keep-Current Lifecycle, _compactV3 Cache Invalidation, sigls/v3 Fallbacks, xstsMpNotAfter & Gates 2 + 5', () => {
    it('evicts legacy _compactV2 SQLite rows on read, upgrades to _compactV3 with _compactDesktopLicensing, and blocks expired Availability EndDate grants', async () => {
      const store = xboxCatalogAndGamePass.openXboxCatalogCacheStore(tmpRoot);
      expect(store).not.toBeNull();

      // Inject a legacy _compactV2 row directly into SQLite display_catalog_products
      const rawDb = new DatabaseSync(store.dbPath);
      const cacheKey = `GB:${BIGID_PCGP_CORE}`;
      rawDb
        .prepare(
          `INSERT OR REPLACE INTO display_catalog_products (cache_key, big_id, market, product_json, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          cacheKey,
          BIGID_PCGP_CORE,
          'GB',
          JSON.stringify({ _compactV2: true, ProductId: BIGID_PCGP_CORE }),
          Date.now()
        );
      rawDb.close();

      // getProducts must treat _compactV2 as a cache miss and delete it from SQLite
      const firstRead = store.getProducts([BIGID_PCGP_CORE], 'GB');
      expect(firstRead.size).toBe(0);

      const verifyDb = new DatabaseSync(store.dbPath);
      const remainingRow = verifyDb
        .prepare(`SELECT cache_key FROM display_catalog_products WHERE cache_key = ?`)
        .get(cacheKey);
      verifyDb.close();
      expect(remainingRow).toBeUndefined();

      // Hydrating writes _compactV3 with _compactDesktopLicensing
      const catalog = buildStandardSyntheticProductCatalog();
      const hydrated = await xboxCatalogAndGamePass.hydrateDisplayCatalogProducts(
        [BIGID_PCGP_CORE],
        {
          market: 'GB',
          languages: 'en-GB,neutral',
          cacheStore: store,
          fetchImpl: async () => jsonResponse({ Products: [catalog[BIGID_PCGP_CORE]] }),
        }
      );

      const projected = hydrated.get(BIGID_PCGP_CORE);
      expect(projected._compactV3).toBe(true);
      expect(projected._compactDesktopLicensing?.passGrants?.length).toBeGreaterThan(0);

      // Expired availability EndDate <= nowMs must be rejected by evaluateLayer3DesktopLicenseGate
      const expiredProduct = xboxCatalogAndGamePass.projectCompactDisplayCatalogProduct(
        makeDisplayCatalogProduct({
          productId: '9NSYNTH00190',
          title: 'Synthetic Expired Window Game',
          availabilityStartIso: '2024-01-01T00:00:00.000Z',
          availabilityEndIso: '2026-06-01T00:00:00.000Z', // before FIXED_NOW_MS
          satisfyingEntitlementKeys: ['big:CFQ7TTC0KGQ8:0001'],
        })
      );
      const gateRes = xboxCatalogAndGamePass.evaluateLayer3DesktopLicenseGate(
        expiredProduct,
        null,
        new Map([['9NSYNTH00190', expiredProduct]]),
        new Set(['CFQ7TTC0KGQ8']),
        FIXED_NOW_MS
      );
      expect(gateRes.allowed).toBe(false);
    });

    it('bypasses the 5-minute SIGL soft-TTL immediately when subscriptionFingerprint changes (Ultimate -> PC Game Pass -> none)', async () => {
      const catalog = buildStandardSyntheticProductCatalog();
      let currentTier: 'ultimate' | 'pc' | 'none' = 'ultimate';
      let siglNetworkHits = 0;

      const fetchImpl = vi.fn(async (rawUrl: string) => {
        const parsed = new URL(String(rawUrl));
        if (parsed.hostname === 'beige.xboxservices.com') {
          if (parsed.pathname.endsWith('/PCGAFD/entitlements/subscriptions')) {
            if (currentTier === 'ultimate') {
              return jsonResponse({
                subscriptions: [
                  { productId: 'CFQ7TTC0KHS0', status: 'Active', endDate: FUTURE_END_ISO },
                ],
              });
            }
            if (currentTier === 'pc') {
              return jsonResponse({
                subscriptions: [
                  { productId: 'CFQ7TTC0KGQ8', status: 'Active', endDate: FUTURE_END_ISO },
                ],
              });
            }
            return jsonResponse({ subscriptions: [] });
          }
          return jsonResponse({ entitlements: [] });
        }
        if (parsed.hostname === 'collections.mp.microsoft.com') {
          if (currentTier === 'ultimate') {
            return jsonResponse({
              items: [
                {
                  productId: 'CFQ7TTC0KHS0',
                  skuId: '0004',
                  status: 'Active',
                  endDate: FUTURE_END_ISO,
                },
              ],
            });
          }
          if (currentTier === 'pc') {
            return jsonResponse({
              items: [
                {
                  productId: 'CFQ7TTC0KGQ8',
                  skuId: '0001',
                  status: 'Active',
                  endDate: FUTURE_END_ISO,
                },
              ],
            });
          }
          return jsonResponse({ items: [] });
        }
        if (parsed.hostname === 'catalog.gamepass.com') {
          siglNetworkHits++;
          const id = parsed.searchParams.get('id');
          if (id === xboxCatalogAndGamePass.GAMEPASS_SIGL_IDS.ULTIMATE_ALL_PC) {
            return jsonResponse(makeSiglPayload('Ultimate', [BIGID_PCGP_CORE, BIGID_UBI_ULT_A]));
          }
          if (id === xboxCatalogAndGamePass.GAMEPASS_SIGL_IDS.PC_GAME_PASS_ALL) {
            return jsonResponse(makeSiglPayload('PCGP', [BIGID_PCGP_CORE]));
          }
          return jsonResponse(makeSiglPayload('Aux', []));
        }
        if (parsed.hostname === 'displaycatalog.mp.microsoft.com') {
          const bigIds = (parsed.searchParams.get('bigIds') || '')
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean);
          return jsonResponse({ Products: bigIds.map((id) => catalog[id]).filter(Boolean) });
        }
        throw new Error(`Unexpected URL: ${rawUrl}`);
      });

      // Sync 1: Ultimate at T=0
      const sync1 = await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        syncMode: 'full_pc_game_pass',
        market: 'GB',
        locale: 'en-GB',
        userDataDir: tmpRoot,
        fetchImpl,
        nowMs: FIXED_NOW_MS,
      });
      expect(sync1.games.map(getXboxBigIdFromGame).sort()).toEqual(
        [BIGID_PCGP_CORE, BIGID_UBI_ULT_A].sort()
      );
      const hitsAfterSync1 = siglNetworkHits;

      // Sync 2: Same Ultimate fingerprint immediately -> hits SQLite v3: SIGL soft-TTL cache (0 network SIGL calls)
      await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        cachedSubscription: sync1.subscription,
        syncMode: 'full_pc_game_pass',
        market: 'GB',
        locale: 'en-GB',
        userDataDir: tmpRoot,
        fetchImpl,
        nowMs: FIXED_NOW_MS + 30_000,
      });
      expect(siglNetworkHits).toBe(hitsAfterSync1);

      // Sync 3: User downgrades to PC Game Pass (well inside 5-min TTL) -> subscriptionChanged forces network refresh!
      currentTier = 'pc';
      const sync3 = await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        cachedSubscription: sync1.subscription,
        syncMode: 'full_pc_game_pass',
        market: 'GB',
        locale: 'en-GB',
        userDataDir: tmpRoot,
        fetchImpl,
        nowMs: FIXED_NOW_MS + 60_000,
      });
      expect(sync3.subscriptionChanged).toBe(true);
      expect(siglNetworkHits).toBeGreaterThan(hitsAfterSync1);
      expect(sync3.games.map(getXboxBigIdFromGame)).toEqual([BIGID_PCGP_CORE]);

      // Sync 4: Subscription expires -> 0 subscription games immediately
      currentTier = 'none';
      const sync4 = await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        cachedSubscription: sync3.subscription,
        syncMode: 'full_pc_game_pass',
        market: 'GB',
        locale: 'en-GB',
        userDataDir: tmpRoot,
        fetchImpl,
        nowMs: FIXED_NOW_MS + 90_000,
      });
      expect(sync4.subscriptionChanged).toBe(true);
      expect(sync4.games).toEqual([]);
    });

    it('falls back deterministically on HTTP 400/404 from /sigls/v3 across ultimate/pc/premium/essential/ea_play, while Ubisoft+ Classics (66ec875c...) NEVER calls /sigls/v2', async () => {
      const { GAMEPASS_SIGL_IDS } = xboxCatalogAndGamePass;

      for (const statusCode of [400, 404]) {
        const tierProfiles = [
          {
            tierId: 'ultimate',
            activeProductIds: ['CFQ7TTC0KHS0'],
            expandedCapabilityPassIds: ['CFQ7TTC0KHS0'],
          },
          {
            tierId: 'pc',
            activeProductIds: ['CFQ7TTC0KGQ8'],
            expandedCapabilityPassIds: ['CFQ7TTC0KGQ8'],
          },
          {
            tierId: 'premium',
            activeProductIds: ['CFQ7TTC0P85B'],
            expandedCapabilityPassIds: ['CFQ7TTC0P85B'],
          },
          {
            tierId: 'essential',
            activeProductIds: ['CFQ7TTC0K5DJ'],
            expandedCapabilityPassIds: ['CFQ7TTC0K5DJ'],
          },
          {
            tierId: 'ea_play',
            activeProductIds: ['CFQ7TTC0K5DH'],
            expandedCapabilityPassIds: ['CFQ7TTC0K5DH'],
          },
        ];

        for (const prof of tierProfiles) {
          const calls: string[] = [];
          const sets = await xboxCatalogAndGamePass.fetchActiveTierSiglSets(
            {
              hasActiveSubscription: true,
              hasPcCatalogAccess: true,
              tierId: prof.tierId,
              activeProductIds: prof.activeProductIds,
              expandedCapabilityPassIds: prof.expandedCapabilityPassIds,
            },
            null,
            {
              market: 'GB',
              locale: 'en-GB',
              forceNetwork: true,
              fetchImpl: async (rawUrl: string) => {
                const url = String(rawUrl);
                calls.push(url);
                if (url.includes('/sigls/v3')) {
                  return jsonResponse({ error: 'v3 HTTP failure' }, statusCode);
                }
                if (url.includes('/sigls/v2')) {
                  return jsonResponse(makeSiglPayload('v2 Fallback', [BIGID_PCGP_CORE]));
                }
                throw new Error(`Unexpected URL: ${url}`);
              },
            }
          );
          expect(calls.some((u) => u.includes('/sigls/v2'))).toBe(true);
          expect(sets.siglFetchAuthoritative).toBe(true);
          expect(sets.activePcSiglSet.has(BIGID_PCGP_CORE)).toBe(true);
        }

        // Ubisoft+ Classics (66ec875c-a391-44f5-9a54-a28bd6f976ce) MUST NEVER call /sigls/v2!
        const ubiCalls: string[] = [];
        const ubiSets = await xboxCatalogAndGamePass.fetchActiveTierSiglSets(
          {
            hasActiveSubscription: true,
            hasPcCatalogAccess: true,
            tierId: 'ubisoft_classics',
            activeProductIds: ['CFQ7TTBZT8LN'],
            expandedCapabilityPassIds: ['CFQ7TTBZT8LN'],
          },
          null,
          {
            market: 'GB',
            locale: 'en-GB',
            forceNetwork: true,
            fetchImpl: async (rawUrl: string) => {
              const url = String(rawUrl);
              ubiCalls.push(url);
              if (url.includes(GAMEPASS_SIGL_IDS.UBISOFT_CLASSICS_PC)) {
                return jsonResponse({ error: 'v3 unavailable' }, statusCode);
              }
              return jsonResponse(makeSiglPayload('Aux', []));
            },
          }
        );
        expect(ubiCalls.some((u) => u.includes('/sigls/v2') && u.includes('66ec875c'))).toBe(false);
        expect(ubiSets.siglFetchAuthoritative).toBe(false);
      }
    });

    it('auto-refreshes expired subscription state in storeSync.getXboxStatus even when refreshSubscription is omitted or false', async () => {
      await storeSync.saveTokensAsync(
        'xbox',
        {
          xuid: SYNTH_XUID,
          gamertag: SYNTH_GAMERTAG,
          uhs: SYNTH_UHS,
          msaRefreshToken: 'SYNTH_MSA_REFRESH_TOKEN_VALID',
          xblUserToken: 'SYNTH_XBL_USER_JWT',
          xblUserNotAfter: '2099-01-01T00:00:00.000Z',
          xstsXboxLiveToken: 'SYNTH_XSTS_TOKEN_VALID',
          xstsXboxLiveNotAfter: '2099-01-01T00:00:00.000Z',
          storeTicket: SYNTH_MSA_TICKET,
          storeTicketExpiresAt: '2099-01-01T00:00:00.000Z',
          collectionsTicket: SYNTH_MSA_TICKET,
          collectionsTicketExpiresAt: '2099-01-01T00:00:00.000Z',
          xstsMpToken: 'SYNTH_MP_XSTS_TOKEN_VALID',
          xstsMpUhs: SYNTH_UHS,
          xstsMpNotAfter: '2099-01-01T00:00:00.000Z',
          syncMode: 'full_pc_game_pass',
          subscription: {
            hasActiveSubscription: true,
            tierId: 'ultimate',
            tierDisplayName: 'Xbox Game Pass Ultimate',
            hasPcCatalogAccess: true,
            endDate: PAST_END_ISO, // already past Date.now()!
            earliestActivePassEndDate: PAST_END_ISO,
            checkedAt: '2026-04-01T00:00:00.000Z',
            subscriptionFingerprint:
              'v2|mkt=GB|tier=ultimate|passes=CFQ7TTC0KHS0|caps=CFQ7TTC0KHS0',
          },
        },
        { userDataDir: tmpRoot }
      );

      let refreshQueried = false;
      const status = await storeSync.getXboxStatus({
        userDataDir: tmpRoot,
        refreshSubscription: false, // explicitly false, yet expired endDate must force auto-refresh!
        fetchFn: async (rawUrl: string) => {
          const parsed = new URL(String(rawUrl));
          if (parsed.hostname === 'beige.xboxservices.com') {
            refreshQueried = true;
            return jsonResponse({
              subscriptions: [
                {
                  productId: 'CFQ7TTC0KGQ8',
                  status: 'Active',
                  autoRenew: true,
                  endDate: '2099-08-01T00:00:00.000Z',
                },
              ],
            });
          }
          if (parsed.hostname === 'collections.mp.microsoft.com') {
            refreshQueried = true;
            return jsonResponse({
              items: [
                {
                  productId: 'CFQ7TTC0KGQ8',
                  skuId: '0001',
                  status: 'Active',
                  endDate: '2099-08-01T00:00:00.000Z',
                },
              ],
            });
          }
          return jsonResponse({});
        },
      });

      expect(refreshQueried).toBe(true);
      expect(status.subscription?.tierId).toBe('pc');
      expect(status.subscription?.tierDisplayName).toBe('PC Game Pass');
    });

    it('persists refreshed xstsMpNotAfter (plus xstsMpToken & xstsMpUhs) to encrypted tokens.json in xboxAuthManager.getXstsToken(MS_STORE)', async () => {
      await storeSync.saveTokensAsync(
        'xbox',
        {
          xuid: SYNTH_XUID,
          gamertag: SYNTH_GAMERTAG,
          uhs: SYNTH_UHS,
          xblUserToken: 'SYNTH_XBL_USER_JWT',
          xblUserNotAfter: '2099-01-01T00:00:00.000Z',
          xstsMpToken: 'STALE_MP_TOKEN',
          xstsMpUhs: SYNTH_UHS,
          xstsMpNotAfter: '2020-01-01T00:00:00.000Z', // expired!
        },
        { userDataDir: tmpRoot }
      );

      const refreshedNotAfter = '2099-09-15T18:30:00.000Z';
      const provider = xboxAuthManager.createXboxAuthProvider({
        userDataDir: tmpRoot,
        fetchImpl: async (rawUrl: string) => {
          if (String(rawUrl).includes('xsts.auth.xboxlive.com/xsts/authorize')) {
            return jsonResponse({
              IssueInstant: '2026-06-15T12:00:00.000Z',
              NotAfter: refreshedNotAfter,
              Token: 'FRESH_MSSTORE_XSTS_JWT_2099',
              DisplayClaims: {
                xui: [{ uhs: SYNTH_UHS, xid: SYNTH_XUID, gtg: SYNTH_GAMERTAG }],
              },
            });
          }
          throw new Error(`Unexpected auth URL: ${rawUrl}`);
        },
      });

      const minted = await provider.getXstsToken(xboxAuthManager.XSTS_RELYING_PARTIES.MS_STORE);
      expect(minted.token).toBe('FRESH_MSSTORE_XSTS_JWT_2099');

      const reloadedXbox = storeSync.loadSavedTokens({ userDataDir: tmpRoot })?.xbox;
      expect(reloadedXbox?.xstsMpToken).toBe('FRESH_MSSTORE_XSTS_JWT_2099');
      expect(reloadedXbox?.xstsMpUhs).toBe(SYNTH_UHS);
      expect(reloadedXbox?.xstsMpNotAfter).toBe(refreshedNotAfter);
    });

    it('admits Windows.Windows8x Appx desktop packages at Gate 2 and preserves isInstalled:true titles at Gate 5', () => {
      const catalog = buildStandardSyntheticProductCatalog();

      // Gate 2: Windows.Windows8x Appx classic desktop package -> admitted!
      const win8xEval = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct(
        catalog[BIGID_WIN8X_APPX]
      );
      expect(win8xEval.eligible).toBe(true);
      expect(win8xEval.platforms.windows).toBe(true);

      // Gate 2 negative control: Windows.Xbox XVC console package -> rejected!
      const consoleEval = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct(
        catalog[BIGID_CONSOLE_XVC]
      );
      expect(consoleEval.eligible).toBe(false);
      expect(consoleEval.gate).toBe('gate2_console_only');

      // Gate 5: Uninstalled soundtrack item is rejected as non-game, while isInstalled:true preserves it!
      const uninstalledSoundtrack = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct(
        catalog[BIGID_INSTALLED_SOUNDTRACK_TOOL],
        { isInstalled: false }
      );
      expect(uninstalledSoundtrack.eligible).toBe(false);
      expect(uninstalledSoundtrack.gate).toBe('gate5_non_game_classifier');

      const installedSoundtrack = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct(
        catalog[BIGID_INSTALLED_SOUNDTRACK_TOOL],
        { isInstalled: true }
      );
      expect(installedSoundtrack.eligible).toBe(true);
    });
  });

  // ==========================================================================
  // DOMAIN 4: End-to-End Reconciliation, Outage Safety, Vault Cleanup & Dual-OS
  // ==========================================================================
  describe('4. End-to-End Reconciliation, Outage Safety (authoritativeComplete: false), Vault Orphan Cleanup & Dual-OS (darwin + win32)', () => {
    it('reconciles Ultimate -> PC Game Pass -> Expired downgrades cleanly across mergeStorefrontGames, verified entitlements & OfflineVaultService while preserving installed & owned games', () => {
      const deleteGamesSpy = vi.fn().mockResolvedValue({ success: true, deleted: 2 });
      (globalThis as any).window.electronAPI = {
        offlineVault: {
          deleteGames: deleteGamesSpy,
        },
      };

      const gInstalledSub = makeCanonicalGameFixture({
        id: `xbox_${BIGID_PCGP_CORE.toLowerCase()}`,
        title: 'Synthetic Astral Odyssey',
        tags: ['Xbox Game Pass Ultimate', 'Action'],
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: BIGID_PCGP_CORE,
            xboxProductId: BIGID_PCGP_CORE,
            installed: true,
            installPath: '/SyntheticGames/AstralOdyssey',
            ownershipType: 'subscription',
            subscriptionTierId: 'ultimate',
            gamePassTier: 'Xbox Game Pass Ultimate',
            satisfyingPassIds: ['CFQ7TTC0KHS0', 'CFQ7TTC0KGQ8'],
          },
        ],
      });
      const gUltUninstalledA = makeCanonicalGameFixture({
        id: `xbox_${BIGID_UBI_ULT_A.toLowerCase()}`,
        title: 'Synthetic Nebula Classics Alpha',
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: BIGID_UBI_ULT_A,
            xboxProductId: BIGID_UBI_ULT_A,
            installed: false,
            ownershipType: 'subscription',
            subscriptionTierId: 'ultimate',
            gamePassTier: 'Ubisoft+ Classics',
            satisfyingPassIds: ['CFQ7TTC0KHS0', 'CFQ7TTBZT8LN'],
          },
        ],
      });
      const gUltUninstalledB = makeCanonicalGameFixture({
        id: `xbox_${BIGID_UBI_ULT_B.toLowerCase()}`,
        title: 'Synthetic Nebula Classics Bravo',
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: BIGID_UBI_ULT_B,
            xboxProductId: BIGID_UBI_ULT_B,
            installed: false,
            ownershipType: 'subscription',
            subscriptionTierId: 'ultimate',
            gamePassTier: 'Ubisoft+ Classics',
            satisfyingPassIds: ['CFQ7TTC0KHS0', 'CFQ7TTBZT8LN'],
          },
        ],
      });
      const gOwned = makeCanonicalGameFixture({
        id: `xbox_${BIGID_OWNED_PC.toLowerCase()}`,
        title: 'Synthetic Permanence Chronicles',
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: BIGID_OWNED_PC,
            xboxProductId: BIGID_OWNED_PC,
            installed: false,
            ownershipType: 'owned',
          },
        ],
      });
      const gOwnedAndSub = makeCanonicalGameFixture({
        id: `xbox_${BIGID_OWNED_AND_SUB.toLowerCase()}`,
        title: 'Synthetic Dual Entitlement Saga',
        tags: ['Xbox Game Pass Ultimate', 'EA Play', 'Ubisoft+ Classics', 'Leaving Soon', 'RPG'],
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: BIGID_OWNED_AND_SUB,
            xboxProductId: BIGID_OWNED_AND_SUB,
            installed: false,
            ownershipType: 'owned_and_subscription',
            subscriptionTierId: 'ultimate',
            gamePassTier: 'Xbox Game Pass Ultimate',
            satisfyingPassIds: ['CFQ7TTC0KHS0'],
            isLeavingSoon: true,
          },
        ],
      });

      const initialCatalog = [
        gInstalledSub,
        gUltUninstalledA,
        gUltUninstalledB,
        gOwned,
        gOwnedAndSub,
      ];

      // Also verify real SQLite OfflineVaultService.deleteGames removes orphaned vault_games rows
      const vaultDir = path.join(tmpRoot, 'vault');
      fs.mkdirSync(vaultDir, { recursive: true });
      const vaultService = offlineVaultMod.createOfflineVaultService({ userDataDir: vaultDir });
      vaultService.upsertGames(initialCatalog);
      expect(vaultService.getStats().totalGames).toBe(5);

      recordVerifiedUserEntitlements('xbox', initialCatalog, { replaceStorefront: true });
      expect(getVerifiedUserEntitlements().xbox).toContain(BIGID_UBI_ULT_A.toLowerCase());

      // Step 1: Downgrade Ultimate -> PC Game Pass (incoming contains PCGP core + Owned + OwnedAndSub, WITHOUT Ubi A/B)
      const incomingPcgp = [
        {
          ...gInstalledSub,
          tags: ['PC Game Pass', 'Action'],
          platforms: [
            {
              ...gInstalledSub.platforms[0],
              subscriptionTierId: 'pc' as const,
              gamePassTier: 'PC Game Pass',
              satisfyingPassIds: ['CFQ7TTC0KGQ8'],
            },
          ],
        },
        gOwned,
        {
          ...gOwnedAndSub,
          platforms: [
            {
              ...gOwnedAndSub.platforms[0],
              subscriptionTierId: 'pc' as const,
              gamePassTier: 'PC Game Pass',
              satisfyingPassIds: ['CFQ7TTC0KGQ8'],
            },
          ],
        },
      ];

      const afterPcgp = mergeStorefrontGames(initialCatalog, incomingPcgp, 'xbox', {
        authoritativeComplete: true,
      });
      recordVerifiedUserEntitlements('xbox', incomingPcgp, {
        replaceStorefront: true,
        preservedInstalledCatalog: afterPcgp,
      });

      const afterPcgpIds = afterPcgp.map(getXboxBigIdFromGame).sort();
      expect(afterPcgpIds).toEqual(
        [BIGID_PCGP_CORE, BIGID_OWNED_PC, BIGID_OWNED_AND_SUB].sort()
      );
      expect(deleteGamesSpy).toHaveBeenCalledWith(
        expect.arrayContaining([
          `xbox_${BIGID_UBI_ULT_A.toLowerCase()}`,
          `xbox_${BIGID_UBI_ULT_B.toLowerCase()}`,
        ])
      );

      // Verify real SQLite OfflineVaultService deletes those exact orphan IDs cleanly
      const delRes = vaultService.deleteGames([
        `xbox_${BIGID_UBI_ULT_A.toLowerCase()}`,
        `xbox_${BIGID_UBI_ULT_B.toLowerCase()}`,
      ]);
      expect(delRes).toEqual({ success: true, deleted: 2 });
      expect(vaultService.getStats().totalGames).toBe(3);
      vaultService.shutdown();

      // Verified entitlements registry replaced stale Ultimate IDs!
      expect(getVerifiedUserEntitlements().xbox).not.toContain(BIGID_UBI_ULT_A.toLowerCase());
      expect(getVerifiedUserEntitlements().xbox).not.toContain(BIGID_UBI_ULT_B.toLowerCase());

      // Step 2: Downgrade PC Game Pass -> Expired (incoming contains ONLY owned MS Store games)
      const incomingExpired = [
        gOwned,
        {
          ...gOwnedAndSub,
          tags: ['RPG'],
          platforms: [
            {
              platformId: 'xbox' as const,
              platformGameId: BIGID_OWNED_AND_SUB,
              xboxProductId: BIGID_OWNED_AND_SUB,
              installed: false,
              ownershipType: 'owned' as const,
            },
          ],
        },
      ];

      const afterExpired = mergeStorefrontGames(afterPcgp, incomingExpired, 'xbox', {
        authoritativeComplete: true,
      });
      recordVerifiedUserEntitlements('xbox', incomingExpired, {
        replaceStorefront: true,
        preservedInstalledCatalog: afterExpired,
      });

      // Installed subscription game stays in library with subscriptionExpired: true
      const keptInstalled = afterExpired.find((g) => getXboxBigIdFromGame(g) === BIGID_PCGP_CORE);
      expect(keptInstalled).toBeDefined();
      expect(keptInstalled?.platforms[0]).toMatchObject({
        installed: true,
        ownershipType: 'subscription',
        subscriptionExpired: true,
      });

      // Owned + Sub downgraded cleanly to 'owned' with subscriptionExpired: false and stale pass tags stripped!
      const downgradedOwned = afterExpired.find(
        (g) => getXboxBigIdFromGame(g) === BIGID_OWNED_AND_SUB
      );
      expect(downgradedOwned?.platforms[0]).toMatchObject({
        ownershipType: 'owned',
        subscriptionExpired: false,
      });
      expect(downgradedOwned?.platforms[0]?.gamePassTier).toBeUndefined();
      expect(downgradedOwned?.platforms[0]?.subscriptionTierId).toBeUndefined();
      expect(downgradedOwned?.platforms[0]?.satisfyingPassIds).toBeUndefined();
      expect(downgradedOwned?.tags).toEqual(['RPG']);
    });

    it('preserves 100% of library and marks 0 installed games subscriptionExpired during transient 503 outage (authoritativeComplete: false)', async () => {
      const cachedSub: XboxSubscriptionSummary = {
        hasActiveSubscription: true,
        tierId: 'pc',
        tierDisplayName: 'PC Game Pass',
        hasPcCatalogAccess: true,
        endDate: FUTURE_END_ISO,
        earliestActivePassEndDate: FUTURE_END_ISO,
        checkedAt: '2026-06-15T11:55:00.000Z',
        subscriptionFingerprint:
          'v2|mkt=GB|tier=pc|passes=CFQ7TTC0KGQ8|caps=CFQ7TTC0K5DH,CFQ7TTC0KGQ8',
      };

      const outageRes = await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: SYNTH_STORE_AUTH,
        collectionsToken: SYNTH_MSA_TICKET,
        cachedSubscription: cachedSub,
        syncMode: 'full_pc_game_pass',
        market: 'GB',
        locale: 'en-GB',
        userDataDir: tmpRoot,
        nowMs: FIXED_NOW_MS,
        fetchImpl: async () => jsonResponse({ error: 'Service Unavailable' }, 503),
      });

      expect(outageRes.authoritativeComplete).toBe(false);
      // Unexpired cached subscription preserved during 503 outage!
      expect(outageRes.subscription.hasActiveSubscription).toBe(true);
      expect(outageRes.subscription.tierId).toBe('pc');

      const deleteGamesSpy = vi.fn().mockResolvedValue({ success: true });
      (globalThis as any).window.electronAPI = {
        offlineVault: { deleteGames: deleteGamesSpy },
      };

      const existingGames = [
        makeCanonicalGameFixture({
          id: `xbox_${BIGID_PCGP_CORE.toLowerCase()}`,
          title: 'Synthetic Astral Odyssey',
          platforms: [
            {
              platformId: 'xbox',
              platformGameId: BIGID_PCGP_CORE,
              xboxProductId: BIGID_PCGP_CORE,
              installed: true,
              ownershipType: 'subscription',
            },
          ],
        }),
        makeCanonicalGameFixture({
          id: `xbox_${BIGID_EA_PLAY.toLowerCase()}`,
          title: 'Synthetic Striker League',
          platforms: [
            {
              platformId: 'xbox',
              platformGameId: BIGID_EA_PLAY,
              xboxProductId: BIGID_EA_PLAY,
              installed: false,
              ownershipType: 'subscription',
            },
          ],
        }),
      ];

      const merged = mergeStorefrontGames(existingGames, [], 'xbox', {
        authoritativeComplete: false,
      });

      expect(merged).toHaveLength(2);
      expect(deleteGamesSpy).not.toHaveBeenCalled();
      expect(merged.every((g) => !g.platforms[0].subscriptionExpired)).toBe(true);
    });

    it('discovers D:\\XboxGames and E:\\.GamingRoot (RGBX UTF-16LE) on cold win32 boot via synchronous Win32_LogicalDisk probe while keeping darwin hermetic', () => {
      federatorMod.clearFederatorCaches();
      const pe64 = buildValidMinimalPe64Buffer();

      // Synthetic Windows drive mounts in tmpRoot
      const fakeDriveC = path.join(tmpRoot, 'win32_C');
      const fakeDriveD = path.join(tmpRoot, 'win32_D');
      const fakeDriveE = path.join(tmpRoot, 'win32_E');
      const winHome = path.join(fakeDriveC, 'Users', 'SyntheticUser');
      fs.mkdirSync(winHome, { recursive: true });

      // D:\XboxGames\Synthetic Secondary Drive Saga\Content\MicrosoftGame.config
      const gameDirD = path.join(
        fakeDriveD,
        'XboxGames',
        'Synthetic Secondary Drive Saga',
        'Content'
      );
      fs.mkdirSync(gameDirD, { recursive: true });
      fs.writeFileSync(path.join(gameDirD, 'SynthDriveD.exe'), pe64);
      fs.writeFileSync(
        path.join(gameDirD, 'MicrosoftGame.config'),
        `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="SyntheticStudio.SecondaryDriveSaga" Publisher="CN=11111111-2222-3333-4444-555555555555" Version="1.0.0.0" />
  <StoreId>9NSYNTH00141</StoreId>
  <TitleId>0A1B2C3D</TitleId>
  <ExecutableList><Executable Name="SynthDriveD.exe" Id="Game" /></ExecutableList>
  <ShellVisuals DefaultDisplayName="Synthetic Secondary Drive Saga" PublisherDisplayName="Synthetic Studio" />
</Game>`,
        'utf8'
      );

      // E:\.GamingRoot pointing to CustomXboxVault\Synthetic GamingRoot Tactics
      fs.mkdirSync(fakeDriveE, { recursive: true });
      fs.writeFileSync(
        path.join(fakeDriveE, '.GamingRoot'),
        buildGamingRootBinaryBuffer('CustomXboxVault\\')
      );
      const gameDirE = path.join(
        fakeDriveE,
        'CustomXboxVault',
        'Synthetic GamingRoot Tactics',
        'Content'
      );
      fs.mkdirSync(gameDirE, { recursive: true });
      fs.writeFileSync(path.join(gameDirE, 'SynthDriveE.exe'), pe64);
      fs.writeFileSync(
        path.join(gameDirE, 'MicrosoftGame.config'),
        `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="SyntheticStudio.GamingRootTactics" Publisher="CN=11111111-2222-3333-4444-555555555555" Version="1.2.0.0" />
  <StoreId>9NSYNTH00142</StoreId>
  <TitleId>0B2C3D4E</TitleId>
  <ExecutableList><Executable Name="SynthDriveE.exe" Id="Game" /></ExecutableList>
  <ShellVisuals DefaultDisplayName="Synthetic GamingRoot Tactics" PublisherDisplayName="Synthetic Studio" />
</Game>`,
        'utf8'
      );

      const psSyncCalls: Array<{ bin: string; args: string[] }> = [];
      const execFileSyncFn = (bin: string, args: string[]) => {
        psSyncCalls.push({ bin, args });
        return 'C:\\\r\nD:\\\r\nE:\\\r\n';
      };

      // 1) Cold-boot win32 synchronous scan (cachedWin32LocalDrives === null!)
      const discoveredWin32 = federatorMod.listLocalXboxInstalledGames({
        platform: 'win32',
        homedir: winHome,
        bottlePaths: [],
        execFileSyncFn,
        driveRootPathMap: {
          'C:\\': fakeDriveC,
          'D:\\': fakeDriveD,
          'E:\\': fakeDriveE,
        },
      });

      expect(psSyncCalls).toHaveLength(1);
      expect(psSyncCalls[0].bin).toBe('powershell.exe');
      expect(psSyncCalls[0].args.join(' ')).toContain('Win32_LogicalDisk');
      expect(psSyncCalls[0].args.join(' ')).toContain('DriveType=2 OR DriveType=3');
      expect(discoveredWin32.map((g: any) => g.xboxProductId).sort()).toEqual([
        '9NSYNTH00141',
        '9NSYNTH00142',
      ]);

      // 2) macOS (`darwin`) bottle scan discovers drive_c/XboxGames and NEVER spawns powershell.exe
      const macHome = path.join(tmpRoot, 'darwin_home');
      const macBottle = path.join(macHome, 'BottleOne');
      const macBottleGame = path.join(
        macBottle,
        'drive_c',
        'XboxGames',
        'Synthetic Bottle Quest',
        'Content'
      );
      fs.mkdirSync(macBottleGame, { recursive: true });
      fs.writeFileSync(path.join(macBottleGame, 'BottleQuest.exe'), pe64);
      fs.writeFileSync(
        path.join(macBottleGame, 'MicrosoftGame.config'),
        `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="SyntheticStudio.BottleQuest" Publisher="CN=11111111-2222-3333-4444-555555555555" Version="1.0.0.0" />
  <StoreId>9NSYNTH00143</StoreId>
  <ExecutableList><Executable Name="BottleQuest.exe" Id="Game" /></ExecutableList>
  <ShellVisuals DefaultDisplayName="Synthetic Bottle Quest" />
</Game>`,
        'utf8'
      );

      const macPsSpy = vi.fn(() => '');
      const discoveredDarwin = federatorMod.listLocalXboxInstalledGames({
        platform: 'darwin',
        homedir: macHome,
        bottlePaths: [macBottle],
        execFileSyncFn: macPsSpy,
      });

      expect(macPsSpy).not.toHaveBeenCalled();
      expect(discoveredDarwin.map((g: any) => g.xboxProductId)).toEqual(['9NSYNTH00143']);
    });
  });

  // ==========================================================================
  // DOMAIN 5: Tier-Aware UI, Modal Auto-Refresh, WCAG 2.2 AA & Zero-PII Audit
  // ==========================================================================
  describe('5. Tier-Aware UI Rendering, Modal Auto-Refresh, WCAG 2.2 AA Compliance & Zero-PII Self-Audit', () => {
    it('formats tier-accurate copy, compact pills, detail badges, and status messages across all Xbox subscription tiers', async () => {
      // Sync-mode radio copy
      expect(
        resolveXboxSyncModeCatalogCopy({
          hasActiveSubscription: true,
          tierId: 'pc',
          tierDisplayName: 'PC Game Pass',
          hasPcCatalogAccess: true,
        }).fullCatalogLabel
      ).toBe('Full PC Game Pass Catalog');

      expect(
        resolveXboxSyncModeCatalogCopy({
          hasActiveSubscription: true,
          tierId: 'essential',
          tierDisplayName: 'Xbox Game Pass Essential',
          hasPcCatalogAccess: true,
        }).fullCatalogLabel
      ).toBe('Full Game Pass Essential PC Catalog');

      expect(
        resolveXboxSyncModeCatalogCopy({
          hasActiveSubscription: true,
          tierId: 'ea_play',
          tierDisplayName: 'EA Play',
          hasPcCatalogAccess: true,
        }).fullCatalogLabel
      ).toBe('Full EA Play PC Catalog');

      expect(
        resolveXboxSyncModeCatalogCopy({
          hasActiveSubscription: true,
          tierId: 'ubisoft_classics',
          tierDisplayName: 'Ubisoft+ Classics',
          hasPcCatalogAccess: true,
        }).fullCatalogLabel
      ).toBe('Full Ubisoft+ Classics PC Catalog');

      const consoleOnlyCopy = resolveXboxSyncModeCatalogCopy({
        hasActiveSubscription: true,
        tierId: 'console_only',
        tierDisplayName: 'Xbox Game Pass Console',
        hasPcCatalogAccess: false,
      });
      expect(consoleOnlyCopy.fullCatalogLabel).toBe('Full Subscription Catalog (No PC Catalog)');

      // Compact badges (PCGP, GPU, GPP, GPE, EA, Ubi+) + Detail badges
      expect(
        resolveXboxCompactTierBadge({
          platformId: 'xbox',
          platformGameId: BIGID_PCGP_CORE,
          installed: false,
          ownershipType: 'subscription',
          subscriptionTierId: 'pc',
          gamePassTier: 'PC Game Pass',
        })
      ).toEqual({ shortLabel: 'PCGP', fullTitle: 'PC Game Pass' });

      expect(
        resolveXboxCompactTierBadge({
          platformId: 'xbox',
          platformGameId: BIGID_PCGP_CORE,
          installed: false,
          ownershipType: 'subscription',
          subscriptionTierId: 'ultimate',
          gamePassTier: 'Xbox Game Pass Ultimate',
        })
      ).toEqual({ shortLabel: 'GPU', fullTitle: 'Xbox Game Pass Ultimate' });

      expect(
        resolveXboxCompactTierBadge({
          platformId: 'xbox',
          platformGameId: BIGID_PREMIUM_PC,
          installed: false,
          ownershipType: 'subscription',
          subscriptionTierId: 'premium',
          gamePassTier: 'Xbox Game Pass Premium',
        })
      ).toEqual({ shortLabel: 'GPP', fullTitle: 'Xbox Game Pass Premium' });

      expect(
        resolveXboxCompactTierBadge({
          platformId: 'xbox',
          platformGameId: BIGID_ESSENTIAL_PC,
          installed: false,
          ownershipType: 'subscription',
          subscriptionTierId: 'essential',
          gamePassTier: 'Xbox Game Pass Essential',
        })
      ).toEqual({ shortLabel: 'GPE', fullTitle: 'Xbox Game Pass Essential' });

      expect(
        resolveXboxCompactTierBadge({
          platformId: 'xbox',
          platformGameId: BIGID_EA_PLAY,
          installed: false,
          ownershipType: 'subscription',
          satisfyingPassIds: ['CFQ7TTC0K5DH'],
        })
      ).toEqual({ shortLabel: 'EA', fullTitle: 'EA Play' });

      expect(
        resolveXboxCompactTierBadge({
          platformId: 'xbox',
          platformGameId: BIGID_UBI_ULT_A,
          installed: false,
          ownershipType: 'subscription',
          satisfyingPassIds: ['CFQ7TTBZT8LN'],
        })
      ).toEqual({ shortLabel: 'Ubi+', fullTitle: 'Ubisoft+ Classics' });

      expect(
        resolveXboxDetailTierBadgeLabel({
          platformId: 'xbox',
          platformGameId: BIGID_UBI_ULT_A,
          installed: false,
          ownershipType: 'subscription',
          satisfyingPassIds: ['CFQ7TTBZT8LN'],
        })
      ).toBe('Ubisoft+ Classics');

      // Status message formatting (never hardcoded to generic "Game Pass Active")
      const statusMsg = formatXboxIntegrationStatusMessage(SYNTH_GAMERTAG, 42, {
        hasActiveSubscription: true,
        tierId: 'pc',
        tierDisplayName: 'PC Game Pass',
        hasPcCatalogAccess: true,
      });
      expect(statusMsg).toContain('PC Game Pass (42 Xbox titles synced)');
      expect(statusMsg).not.toContain('Ultimate');

      const consoleStatusMsg = formatXboxIntegrationStatusMessage(SYNTH_GAMERTAG, 3, {
        hasActiveSubscription: true,
        tierId: 'console_only',
        tierDisplayName: 'Xbox Game Pass Console',
        hasPcCatalogAccess: false,
      });
      expect(consoleStatusMsg).toContain('Xbox Game Pass Console · Owned Only');

      expect(formatXboxSubscriptionDate(FUTURE_END_ISO)).toMatch(/2026/);

      // XboxIntegrationService forwards authoritativeComplete & subscriptionChanged
      (globalThis as any).window.electronAPI = {
        syncStore: vi.fn().mockResolvedValue({
          success: true,
          accountName: SYNTH_GAMERTAG,
          xuid: SYNTH_XUID,
          games: [],
          authoritativeComplete: true,
          subscriptionChanged: true,
          subscription: {
            hasActiveSubscription: true,
            tierId: 'pc',
            tierDisplayName: 'PC Game Pass',
          },
        }),
      };
      const res = await new XboxIntegrationService().syncXboxAccount();
      expect(res.authoritativeComplete).toBe(true);
      expect(res.subscriptionChanged).toBe(true);
    });

    it('renders IntegrationsModal, StorefrontAccountsStep, PlatformBadges, LibraryGridCard & LibrarySidebar across all tiers with 0 WCAG 2.2 AA violations and triggers modal auto-refresh when stale', async () => {
      const liveFutureEndIso = new Date(Date.now() + 90 * 24 * 3600_000).toISOString();
      const getXboxStatusSpy = vi.fn().mockResolvedValue({
        connected: true,
        gamertag: SYNTH_GAMERTAG,
        xuid: SYNTH_XUID,
        syncMode: 'full_pc_game_pass',
        subscription: {
          hasActiveSubscription: true,
          tierId: 'pc',
          tierDisplayName: 'PC Game Pass',
          autoRenew: false,
          endDate: liveFutureEndIso,
          earliestActivePassEndDate: liveFutureEndIso,
          hasPcCatalogAccess: true,
          checkedAt: new Date().toISOString(),
          subscriptionFingerprint:
            'v2|mkt=GB|tier=pc|passes=CFQ7TTC0KGQ8|caps=CFQ7TTC0K5DH,CFQ7TTC0KGQ8',
        },
      });

      (globalThis as any).window.electronAPI = {
        getSavedTokens: vi.fn().mockResolvedValue({
          xbox: {
            connected: true,
            gamertag: SYNTH_GAMERTAG,
            xuid: SYNTH_XUID,
            syncMode: 'full_pc_game_pass',
          },
        }),
        getXboxStatus: getXboxStatusSpy,
        offlineVault: {
          getStats: vi.fn().mockResolvedValue({
            tier: 'balanced',
            totalBytes: 0,
            maxBytes: 1024 * 1024 * 1024,
            blobCount: 0,
            totalGames: 4,
          }),
        },
      };

      const baseIntegrations = loadIntegrations().map((item) =>
        item.storefrontId === 'xbox'
          ? {
              ...item,
              isConnected: true,
              accountName: SYNTH_GAMERTAG,
              accountId: SYNTH_XUID,
              gamesCount: 4,
              statusMessage: `Connected as ${SYNTH_GAMERTAG} • PC Game Pass Active (4 titles)`,
            }
          : item
      );
      saveIntegrations(baseIntegrations);

      const tierProfiles: Array<{
        sub: XboxSubscriptionSummary;
        expectedBadgeText: string;
        expectedRenewOrExpirePrefix: string;
      }> = [
        {
          sub: {
            hasActiveSubscription: true,
            tierId: 'pc',
            tierDisplayName: 'PC Game Pass',
            autoRenew: false,
            endDate: liveFutureEndIso,
            earliestActivePassEndDate: liveFutureEndIso,
            hasPcCatalogAccess: true,
            checkedAt: '2026-01-01T00:00:00.000Z', // stale & missing v2| -> refreshSubscription: true!
          },
          expectedBadgeText: 'PC Game Pass',
          expectedRenewOrExpirePrefix: 'Expires',
        },
        {
          sub: {
            hasActiveSubscription: true,
            tierId: 'ultimate',
            tierDisplayName: 'Xbox Game Pass Ultimate',
            autoRenew: true,
            endDate: liveFutureEndIso,
            earliestActivePassEndDate: liveFutureEndIso,
            hasPcCatalogAccess: true,
            checkedAt: new Date().toISOString(),
            subscriptionFingerprint:
              'v2|mkt=GB|tier=ultimate|passes=CFQ7TTC0KHS0|caps=CFQ7TTC0KHS0',
          },
          expectedBadgeText: 'Xbox Game Pass Ultimate',
          expectedRenewOrExpirePrefix: 'Renews',
        },
        {
          sub: {
            hasActiveSubscription: true,
            tierId: 'essential',
            tierDisplayName: 'Xbox Game Pass Essential',
            autoRenew: true,
            endDate: liveFutureEndIso,
            earliestActivePassEndDate: liveFutureEndIso,
            hasPcCatalogAccess: true,
            checkedAt: new Date().toISOString(),
            subscriptionFingerprint:
              'v2|mkt=GB|tier=essential|passes=CFQ7TTC0K5DJ|caps=CFQ7TTC0K5DJ',
          },
          expectedBadgeText: 'Xbox Game Pass Essential',
          expectedRenewOrExpirePrefix: 'Renews',
        },
        {
          sub: {
            hasActiveSubscription: true,
            tierId: 'console_only',
            tierDisplayName: 'Xbox Game Pass Console',
            hasPcCatalogAccess: false,
            checkedAt: new Date().toISOString(),
            subscriptionFingerprint:
              'v2|mkt=GB|tier=console_only|passes=CFQ7TTC0K6L8|caps=CFQ7TTC0K6L8',
          },
          expectedBadgeText: 'Xbox Game Pass Console',
          expectedRenewOrExpirePrefix: '',
        },
      ];

      for (let i = 0; i < tierProfiles.length; i++) {
        const profile = tierProfiles[i];
        getXboxStatusSpy.mockClear();
        getXboxStatusSpy.mockResolvedValue({
          connected: true,
          gamertag: SYNTH_GAMERTAG,
          xuid: SYNTH_XUID,
          syncMode: 'full_pc_game_pass',
          subscription: {
            ...profile.sub,
            checkedAt: new Date().toISOString(),
            subscriptionFingerprint:
              profile.sub.subscriptionFingerprint ||
              `v2|mkt=GB|tier=${profile.sub.tierId}|passes=SYNTH`,
          },
        });
        saveXboxProfileState({
          connected: true,
          gamertag: SYNTH_GAMERTAG,
          xuid: SYNTH_XUID,
          syncMode: 'full_pc_game_pass',
          subscription: profile.sub,
        });

        // 1) IntegrationsModal deep render + mount effects + switch to Xbox tab + WCAG 2.2 AA audit
        const modalRenderer = createDomain12DeepRenderer(IntegrationsModal, {
          isOpen: true,
          onClose: () => {},
          onLibraryUpdated: () => {},
        });
        let modalTree = modalRenderer.render();
        await Promise.resolve();
        await Promise.resolve();

        if (i === 0) {
          // Stale/missing v2| fingerprint MUST request refreshSubscription: true
          expect(getXboxStatusSpy).toHaveBeenCalledWith({ refreshSubscription: true });
        } else {
          // Fresh v2| fingerprint + unexpired endDate MUST avoid redundant network refresh (refreshSubscription: false)
          expect(getXboxStatusSpy).toHaveBeenCalledWith({ refreshSubscription: false });
        }

        // Switch IntegrationsModal from default Steam tab to Xbox tab so full Xbox subscription card + sync modes render
        const xboxTabBtn = findVNodes(
          modalTree,
          (el) =>
            el.type === 'button' &&
            typeof el.props?.onClick === 'function' &&
            extractVNodeText(el).includes('Xbox')
        )[0];
        expect(xboxTabBtn).toBeDefined();
        xboxTabBtn!.props.onClick();
        modalTree = modalRenderer.render();

        const modalHtml = renderToStaticMarkup(modalTree as React.ReactElement);
        expect(modalHtml).toContain(profile.expectedBadgeText);
        if (profile.expectedRenewOrExpirePrefix) {
          expect(modalHtml).toContain(profile.expectedRenewOrExpirePrefix);
        }
        expect(auditWcag22AA(modalTree)).toEqual([]);
        modalRenderer.unmount();

        // 2) StorefrontAccountsStep deep render + WCAG 2.2 AA audit
        const stepRenderer = createDomain12DeepRenderer(StorefrontAccountsStep, {
          snapshot: makeMinimalEnvironmentHealthSnapshot(['xbox']),
          connectedStorefronts: ['xbox'],
          onAccountsChanged: () => {},
        });
        let stepTree = stepRenderer.render();
        await Promise.resolve();
        stepTree = stepRenderer.render();
        const stepHtml = renderToStaticMarkup(stepTree as React.ReactElement);
        expect(stepHtml).toContain(profile.expectedBadgeText);
        expect(auditWcag22AA(stepTree)).toEqual([]);
        stepRenderer.unmount();
      }

      // 3) PlatformBadges (horizontal & vertical-stacked), LibraryGridCard & LibrarySidebar across PCGP, GPU, GPE, EA, Ubi+, Expired & Owned
      const sampleGames: CanonicalGame[] = [
        makeCanonicalGameFixture({
          id: `xbox_${BIGID_PCGP_CORE.toLowerCase()}`,
          title: 'Synthetic Astral Odyssey',
          platforms: [
            {
              platformId: 'xbox',
              platformGameId: BIGID_PCGP_CORE,
              xboxProductId: BIGID_PCGP_CORE,
              installed: false,
              ownershipType: 'subscription',
              subscriptionTierId: 'pc',
              gamePassTier: 'PC Game Pass',
              satisfyingPassIds: ['CFQ7TTC0KGQ8'],
            },
          ],
        }),
        makeCanonicalGameFixture({
          id: `xbox_${BIGID_UBI_ULT_A.toLowerCase()}`,
          title: 'Synthetic Nebula Classics Alpha',
          platforms: [
            {
              platformId: 'xbox',
              platformGameId: BIGID_UBI_ULT_A,
              xboxProductId: BIGID_UBI_ULT_A,
              installed: false,
              ownershipType: 'subscription',
              subscriptionTierId: 'ubisoft_classics',
              gamePassTier: 'Ubisoft+ Classics',
              satisfyingPassIds: ['CFQ7TTBZT8LN'],
            },
          ],
        }),
        makeCanonicalGameFixture({
          id: `xbox_${BIGID_EA_PLAY.toLowerCase()}`,
          title: 'Synthetic Striker League',
          platforms: [
            {
              platformId: 'xbox',
              platformGameId: BIGID_EA_PLAY,
              xboxProductId: BIGID_EA_PLAY,
              installed: false,
              ownershipType: 'subscription',
              subscriptionTierId: 'ea_play',
              gamePassTier: 'EA Play',
              satisfyingPassIds: ['CFQ7TTC0K5DH'],
            },
          ],
        }),
        makeCanonicalGameFixture({
          id: `xbox_${BIGID_ESSENTIAL_PC.toLowerCase()}`,
          title: 'Synthetic Solaris Essential',
          platforms: [
            {
              platformId: 'xbox',
              platformGameId: BIGID_ESSENTIAL_PC,
              xboxProductId: BIGID_ESSENTIAL_PC,
              installed: true,
              ownershipType: 'subscription',
              subscriptionExpired: true,
              subscriptionTierId: 'essential',
              gamePassTier: 'Xbox Game Pass Essential',
            },
          ],
        }),
      ];

      const filterIndex = buildLibraryFilterIndex(sampleGames, { hostPlatform: 'darwin' });

      for (const game of sampleGames) {
        for (const layout of ['horizontal', 'vertical-stacked'] as const) {
          const badgeRenderer = createDomain12DeepRenderer(PlatformBadges, {
            platforms: game.platforms,
            game,
            layout,
            connectedStorefronts: ['xbox'],
          });
          const badgeTree = badgeRenderer.render();
          expect(auditWcag22AA(badgeTree)).toEqual([]);
          badgeRenderer.unmount();
        }

        const CardWrapper: React.FC = () =>
          renderLibraryGridCard({
            game,
            idx: 0,
            sortBy: 'alphabetical',
            userOverridesMap: {},
            coverOverrides: {},
            connectedSet: new Set<StorefrontId>(['xbox']),
            effectiveFilterIndex: filterIndex,
            contextMenuOpenRef: { current: false },
            onDismissContextMenu: () => {},
            onSelectGame: () => {},
            onNeedCoverLookup: () => {},
            onMouseEnter: () => {},
            onMouseLeave: () => {},
            onContextMenu: () => {},
            resolveGameCriticData: () => null,
          });
        const cardRenderer = createDomain12DeepRenderer(CardWrapper, {});
        const cardTree = cardRenderer.render();
        const cardHtml = renderToStaticMarkup(cardTree as React.ReactElement);
        expect(cardHtml).not.toContain('>PCGP<');
        expect(cardHtml).not.toContain('>GPU<');
        expect(cardHtml).not.toContain('>Ubi+<');
        expect(cardHtml).not.toContain('>EA<');
        expect(auditWcag22AA(cardTree)).toEqual([]);
        cardRenderer.unmount();
      }

      const sidebarRenderer = createDomain12DeepRenderer(LibrarySidebar, {
        games: sampleGames,
        selectedGameId: sampleGames[0].id,
        onSelectGame: () => {},
        searchQuery: '',
        onSearchChange: () => {},
        selectedPlatform: 'all',
        onSelectPlatform: () => {},
        installedOnly: false,
        onToggleInstalledOnly: () => {},
        collections: [],
        onOpenManageCollectionsModal: () => {},
        onToggleGameInCollection: () => {},
        connectedStorefronts: ['xbox'],
      });
      const sidebarTree = sidebarRenderer.render();
      const sidebarHtml = renderToStaticMarkup(sidebarTree as React.ReactElement);
      expect(sidebarHtml).not.toContain('>PCGP<');
      expect(sidebarHtml).not.toContain('>GPU<');
      expect(sidebarHtml).not.toContain('>Ubi+<');
      expect(sidebarHtml).not.toContain('>EA<');
      expect(sidebarHtml).toContain('Expired');
      expect(auditWcag22AA(sidebarTree)).toEqual([]);
      sidebarRenderer.unmount();
    });

    it('passes zero-PII and zero-commercial-fixture hygiene audit on this test file', () => {
      const selfPath = path.resolve(
        __dirname,
        'xboxSubscriptionTierAndSiglV3Authority.test.tsx'
      );
      const content = fs.readFileSync(selfPath, 'utf8');
      const violations = scanContentForPiiViolations(content, selfPath);
      expect(violations).toEqual([]);
    });
  });
});
