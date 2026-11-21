'use strict';

/**
 * Xbox `.msixvc` Package Delivery Resolver (`packagespc.xboxlive.com` + `FE3` SOAP),
 * enforcing strict Microsoft / Xbox Delivery Optimization CDN host allowlists (`P0-04`).
 */

const path = require('node:path');
const crypto = require('node:crypto');
const { XSTS_RELYING_PARTIES } = require('../xboxAuthManager.cjs');
const xboxConfigAndIds = require('../xboxConfigAndIds.cjs');
const { buildXboxFetchSignal, makeCorrelationVector } = xboxConfigAndIds;

const {
  PACKAGES_PC_BASE_URL,
  FE3_DELIVERY_SOAP_URL,
  resolveFetchImpl,
  resolveDefaultXboxLocaleAndMarket,
  escapeXml,
  normalizeAllowedPackageDeliveryUrl,
} = require('./xboxCatalogConstants.cjs');
const { openXboxCatalogCacheStore } = require('./xboxCatalogSqliteCache.cjs');
const { deriveDefaultScidFromTitleId } = require('./xboxCatalogMediaAndSanitizer.cjs');
const {
  hydrateDisplayCatalogProducts,
  detectXboxSubscriptions,
} = require('./xboxSubscriptionAndEntitlements.cjs');
const { evaluateDisplayCatalogProduct } = require('./xboxCatalogGatesAndMapper.cjs');

async function resolveFe3DeliveryUrls(wuCategoryId, fetchImpl, signal = undefined) {
  if (!wuCategoryId || typeof fetchImpl !== 'function') return [];

  const safeWuCategoryId = escapeXml(String(wuCategoryId).trim());

  const syncSoap =
    `<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:s="http://www.w3.org/2003/05/soap-envelope">` +
    `<s:Header>` +
    `<a:Action s:mustUnderstand="1">http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService/SyncUpdates</a:Action>` +
    `<a:MessageID>urn:uuid:${crypto.randomUUID()}</a:MessageID>` +
    `<a:To s:mustUnderstand="1">${escapeXml(FE3_DELIVERY_SOAP_URL)}</a:To>` +
    `</s:Header>` +
    `<s:Body>` +
    `<SyncUpdates xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">` +
    `<cookie><Expiration>2099-01-01T00:00:00Z</Expiration></cookie>` +
    `<parameters>` +
    `<ExpressQuery>false</ExpressQuery>` +
    `<InstalledNonLeafUpdateIDs><int>1</int><int>2</int><int>10</int><int>19</int></InstalledNonLeafUpdateIDs>` +
    `<SkipSoftwareSync>false</SkipSoftwareSync>` +
    `<NeedTwoGroupOutOfScopeUpdates>true</NeedTwoGroupOutOfScopeUpdates>` +
    `<FilterAppCategoryIds><CategoryIdentifier><Id>${safeWuCategoryId}</Id></CategoryIdentifier></FilterAppCategoryIds>` +
    `<TreatAppCategoryIdsAsInstalled>true</TreatAppCategoryIdsAsInstalled>` +
    `</parameters>` +
    `</SyncUpdates>` +
    `</s:Body>` +
    `</s:Envelope>`;

  const syncRes = await fetchImpl(FE3_DELIVERY_SOAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    body: syncSoap,
    signal: buildXboxFetchSignal(signal),
  });
  if (!syncRes.ok) return [];
  const syncXml = await syncRes.text();

  const updatePairs = [];
  const updateBlockRegex =
    /<(?:[\w-]+:)?(?:UpdateInfo|Update)\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?(?:UpdateInfo|Update)>/gi;
  let blockMatch;
  while ((blockMatch = updateBlockRegex.exec(syncXml)) !== null) {
    const blockXml = blockMatch[1] || '';
    const idMatch = blockXml.match(/<(?:[\w-]+:)?ID\b[^>]*>\s*(\d+)\s*<\/(?:[\w-]+:)?ID>/i);
    const identityMatch = blockXml.match(/<(?:[\w-]+:)?UpdateIdentity\b([^>]*)\/?>/i);
    if (!identityMatch) continue;
    const identityAttrs = identityMatch[1] || '';
    const updateId = xboxConfigAndIds.extractXmlAttr(identityAttrs, 'UpdateID');
    const revisionNumber = xboxConfigAndIds.extractXmlAttr(identityAttrs, 'RevisionNumber');
    if (updateId && revisionNumber) {
      updatePairs.push({
        intId: idMatch ? idMatch[1] : '',
        updateId,
        revisionNumber,
      });
    }
  }
  if (updatePairs.length === 0) return [];

  const revXml = updatePairs
    .map(
      (u) =>
        `<UpdateIdentity><UpdateID>${escapeXml(u.updateId)}</UpdateID><RevisionNumber>${escapeXml(u.revisionNumber)}</RevisionNumber></UpdateIdentity>`
    )
    .join('');

  const extSoap =
    `<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:s="http://www.w3.org/2003/05/soap-envelope">` +
    `<s:Header>` +
    `<a:Action s:mustUnderstand="1">http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService/GetExtendedUpdateInfo2</a:Action>` +
    `<a:MessageID>urn:uuid:${crypto.randomUUID()}</a:MessageID>` +
    `<a:To s:mustUnderstand="1">${escapeXml(FE3_DELIVERY_SOAP_URL)}</a:To>` +
    `</s:Header>` +
    `<s:Body>` +
    `<GetExtendedUpdateInfo2 xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">` +
    `<updateIDs>${revXml}</updateIDs>` +
    `<infoTypes><XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType></infoTypes>` +
    `<deviceAttributes>E:BranchReadinessLevel=CB&amp;ProcessorArchitecture=AMD64&amp;OSVersion=10.0.26100.0</deviceAttributes>` +
    `</GetExtendedUpdateInfo2>` +
    `</s:Body>` +
    `</s:Envelope>`;

  const extRes = await fetchImpl(FE3_DELIVERY_SOAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    body: extSoap,
    signal: buildXboxFetchSignal(signal),
  });
  if (!extRes.ok) return [];
  const extXml = await extRes.text();

  const files = [];
  const locBlockRegex = /<(?:[\w-]+:)?FileLocation\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?FileLocation>/gi;
  let lm;
  while ((lm = locBlockRegex.exec(extXml)) !== null) {
    const locInner = lm[1] || '';
    const urlMatch = locInner.match(/<(?:[\w-]+:)?Url\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Url>/i);
    if (!urlMatch) continue;
    const rawUrl = xboxConfigAndIds.decodeXmlEntities(urlMatch[1] || '').trim();
    const safeUrl = normalizeAllowedPackageDeliveryUrl(rawUrl);
    if (safeUrl) {
      let fileName = 'package.msixvc';
      try {
        fileName = path.posix.basename(new URL(safeUrl).pathname) || 'package.msixvc';
      } catch {}
      files.push({
        fileName,
        downloadUrls: [safeUrl],
        source: 'fe3_soap',
      });
    }
  }
  return files;
}

/**
 * Resolves `.msixvc` CDN download URLs, `ContentId`, `PackageFullName`, `PackageFamilyName`,
 * and `satisfyingEntitlementKeys` for a given `storeId` (`BigId`) via DisplayCatalog +
 * `GET https://packagespc.xboxlive.com/GetBasePackage/{ContentId}` (`x-xbl-contract-version: 3`)
 * with automatic `FE3` Windows Update SOAP fallback.
 */
async function resolveXboxPackageDeliveryInfo(params = {}) {
  const defaults = resolveDefaultXboxLocaleAndMarket(params);
  const {
    storeId,
    contentId: explicitContentId,
    authProvider,
    market = defaults.market,
    languages = `${defaults.locale},neutral`,
    userDataDir,
  } = params;
  const fetchImpl = resolveFetchImpl(params);

  const cleanStoreId = String(storeId || '')
    .replace(/^xbox[-_:]/i, '')
    .trim()
    .toUpperCase();

  let evalMeta = null;
  if (cleanStoreId && /^[A-Z0-9]{12}$/.test(cleanStoreId)) {
    const cacheStore = openXboxCatalogCacheStore(userDataDir);
    try {
      const map = await hydrateDisplayCatalogProducts([cleanStoreId], {
        market,
        languages,
        cacheStore,
        fetchImpl,
        signal: params.signal,
      });
      const prod = map.get(cleanStoreId);
      if (prod) {
        const res = evaluateDisplayCatalogProduct(prod);
        if (!res.eligible && res.isBundleWrapper && res.bundledSkus?.length > 0) {
          const primaryChild = res.bundledSkus.find((b) => b.isPrimary) || res.bundledSkus[0];
          const childMap = await hydrateDisplayCatalogProducts([primaryChild.bigId], {
            market,
            languages,
            cacheStore,
            fetchImpl,
            signal: params.signal,
          });
          const childProd = childMap.get(primaryChild.bigId);
          if (childProd) {
            evalMeta = evaluateDisplayCatalogProduct(childProd);
            evalMeta._parentBundleKey = `${cleanStoreId}:${res.selectedSkuId || '0010'}`;
          }
        } else if (res.eligible) {
          evalMeta = res;
        }
      }
    } finally {
      cacheStore.close();
    }
  }

  const contentId = String(explicitContentId || evalMeta?.contentId || '').trim();
  const wuCategoryId = String(params.wuCategoryId || evalMeta?.wuCategoryId || '').trim();

  if (!contentId && !wuCategoryId && !evalMeta?.externalLauncherUrl) {
    throw new Error(
      `Unable to resolve ContentId or WuCategoryId for Xbox product ${cleanStoreId || '(unknown)'}`
    );
  }

  const packageFiles = [];

  if (contentId && authProvider && typeof authProvider.getXstsToken === 'function') {
    try {
      const updateXsts = await authProvider.getXstsToken(XSTS_RELYING_PARTIES.UPDATE_XBL);
      const pkgUrl = `${PACKAGES_PC_BASE_URL}/${encodeURIComponent(contentId)}`;
      const res = await fetchImpl(pkgUrl, {
        method: 'GET',
        headers: {
          Authorization: updateXsts.authorizationHeader,
          'x-xbl-contract-version': '3',
          Accept: 'application/json',
          'MS-CV': makeCorrelationVector(),
        },
        signal: buildXboxFetchSignal(params.signal),
      });

      if (res.ok) {
        const json = await res.json();
        const rawFiles = Array.isArray(json?.PackageFiles)
          ? json.PackageFiles
          : Array.isArray(json?.packageFiles)
            ? json.packageFiles
            : [];
        for (const pf of rawFiles) {
          const fileName = String(pf?.FileName ?? pf?.fileName ?? '').trim();
          const relUrl = String(pf?.RelativeUrl ?? pf?.relativeUrl ?? '').trim();
          const roots = Array.isArray(pf?.CdnRootPaths)
            ? pf.CdnRootPaths
            : Array.isArray(pf?.cdnRootPaths)
              ? pf.cdnRootPaths
              : Array.isArray(pf?.BackgroundCdnRootPaths)
                ? pf.BackgroundCdnRootPaths
                : [];
          const downloadUrls = roots
            .map((r) => {
              const base = String(r || '').trim().replace(/\/+$/, '');
              if (!base || !relUrl) return '';
              const joined = relUrl.startsWith('/') ? `${base}${relUrl}` : `${base}/${relUrl}`;
              return normalizeAllowedPackageDeliveryUrl(joined);
            })
            .filter(Boolean);

          if (downloadUrls.length > 0) {
            const rawSize = Number(pf?.FileSize ?? pf?.fileSize ?? 0);
            const rawLicenseId = pf?.EkbId ?? pf?.ekbId ?? pf?.KeyBlob ?? undefined;
            packageFiles.push({
              fileName,
              fileSize: rawSize > 0 ? rawSize : undefined,
              isMsixvc: /\.(?:msixvc|xvc|eappx)$/i.test(fileName),
              licenseId: rawLicenseId || undefined,
              downloadUrls,
              source: 'packagespc',
            });
          }
        }
      }
    } catch {}
  }

  if (packageFiles.length === 0 && wuCategoryId) {
    try {
      const fe3Files = await resolveFe3DeliveryUrls(wuCategoryId, fetchImpl, params.signal);
      packageFiles.push(...fe3Files);
    } catch {}
  }

  const primaryMsixvc =
    packageFiles.find((f) => /\.msixvc$/i.test(f.fileName)) ||
    packageFiles.find((f) => 'isMsixvc' in f && Boolean(f.isMsixvc)) ||
    packageFiles[0] ||
    null;

  const satisfyingEntitlementKeys = [];
  if (evalMeta?.productId) {
    satisfyingEntitlementKeys.push(`${evalMeta.productId}:${evalMeta.selectedSkuId || '0010'}`);
  }
  if (evalMeta?._parentBundleKey && !satisfyingEntitlementKeys.includes(evalMeta._parentBundleKey)) {
    satisfyingEntitlementKeys.push(evalMeta._parentBundleKey);
  }
  if (authProvider) {
    try {
      const subInfo = await detectXboxSubscriptions({
        authProvider,
        market,
        fetchImpl,
        signal: params.signal,
      });
      if (Array.isArray(subInfo?.activeEntitlementKeys)) {
        for (const subKey of subInfo.activeEntitlementKeys) {
          if (subKey && !satisfyingEntitlementKeys.includes(subKey)) {
            satisfyingEntitlementKeys.push(subKey);
          }
        }
      }
    } catch {}
  }

  const STUB_PACKAGE_MAX_BYTES = 32 * 1024 * 1024;
  const primaryMsixvcSize =
    primaryMsixvc && 'fileSize' in primaryMsixvc ? Number(primaryMsixvc.fileSize || 0) : 0;
  const isExternalLauncherStubPackage = Boolean(
    evalMeta?.externalStorefrontHandoff &&
      ((primaryMsixvcSize > 0 && primaryMsixvcSize <= STUB_PACKAGE_MAX_BYTES) ||
        evalMeta?.isExternalLauncherStubPackage ||
        /gdkstubgame/i.test(String(primaryMsixvc?.fileName || '')))
  );
  const resolvedMaxDownloadSizeBytes = isExternalLauncherStubPackage
    ? Number(evalMeta?.pcMaxInstallSizeBytes || 0) > STUB_PACKAGE_MAX_BYTES
      ? Number(evalMeta.pcMaxInstallSizeBytes)
      : Number(evalMeta?.maxDownloadSizeBytes || 0) > STUB_PACKAGE_MAX_BYTES
        ? Number(evalMeta.maxDownloadSizeBytes)
        : undefined
    : (primaryMsixvcSize > 0 ? primaryMsixvcSize : undefined) || evalMeta?.maxDownloadSizeBytes;

  return {
    storeId: evalMeta?.productId || cleanStoreId,
    title: evalMeta?.title || undefined,
    contentId: contentId || undefined,
    wuCategoryId: wuCategoryId || undefined,
    packageFamilyName: evalMeta?.packageFamilyName || undefined,
    packageFullName: evalMeta?.packageFullName || undefined,
    xboxTitleId: evalMeta?.xboxTitleId || undefined,
    scid: evalMeta?.scid || deriveDefaultScidFromTitleId(evalMeta?.xboxTitleId) || undefined,
    msaAppId: evalMeta?.msaAppId || undefined,
    maxDownloadSizeBytes: resolvedMaxDownloadSizeBytes,
    ...(evalMeta?.pcMaxInstallSizeBytes
      ? { pcMaxInstallSizeBytes: evalMeta.pcMaxInstallSizeBytes }
      : {}),
    primaryDownloadUrl: primaryMsixvc?.downloadUrls?.[0] || undefined,
    downloadUrls: primaryMsixvc?.downloadUrls || [],
    fileName: primaryMsixvc?.fileName || undefined,
    packageFiles,
    satisfyingEntitlementKeys,
    chainedLauncherHandoff: evalMeta?.externalStorefrontHandoff || undefined,
    externalStorefrontHandoff: evalMeta?.externalStorefrontHandoff || undefined,
    ...(evalMeta?.externalStorefrontHandoff
      ? { chainedHandoffTopology: 'publisher_managed' }
      : {}),
    externalLauncher: evalMeta?.externalLauncher || undefined,
    externalLauncherUrl: evalMeta?.externalLauncherUrl || undefined,
    xboxBottleCompatibilityTier: evalMeta?.xboxBottleCompatibilityTier || undefined,
    xboxBottleCompatibilityReason: evalMeta?.xboxBottleCompatibilityReason || undefined,
    isCrossPlatformLauncherRuntime: Boolean(evalMeta?.isCrossPlatformLauncherRuntime),
    ...(isExternalLauncherStubPackage ? { isExternalLauncherStubPackage: true } : {}),
  };
}

module.exports = {
  resolveFe3DeliveryUrls,
  resolveXboxPackageDeliveryInfo,
};
