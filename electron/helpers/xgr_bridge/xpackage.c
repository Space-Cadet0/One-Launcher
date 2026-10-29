/*
 * One Launcher XGR Bridge — IXPackageImpl4 & IXPackageLegacy (`CLSID_XPackageImpl`)
 * Package identity, locale, chunk availability (`Ready`), installation monitor (`100%`), and mounting.
 */

#include "xgr_internal.h"

#define E_GAMEPACKAGE_APP_NOT_PACKAGED ((HRESULT)0x87E5000EL)

struct XPackageMountObject {
    volatile LONG ref;
    char path[4096];
};

struct XPackageInstallationMonitorObject {
    volatile LONG ref;
    XPackageInstallationProgress progress;
};

static uint64_t g_next_pkg_token = 500;

HRESULT xgr_package_mount_internal(const char *pkg_id, XPackageMountHandle *out)
{
    if (!out) return E_INVALIDARG;
    *out = NULL;
    if (!pkg_id || !pkg_id[0]) return E_INVALIDARG;

    XPackageMountHandle m = (XPackageMountHandle)calloc(1, sizeof(*m));
    if (!m) return E_OUTOFMEMORY;
    m->ref = 1;

    xgr_copy_game_root_utf8(m->path, sizeof(m->path));
    if (m->path[0]) {
        /* Trim trailing backslash unless drive root like "C:\" */
        size_t len = strlen(m->path);
        while (len > 3 && (m->path[len - 1] == '\\' || m->path[len - 1] == '/')) {
            m->path[--len] = '\0';
        }
    } else {
        strcpy(m->path, "C:\\");
    }

    *out = m;
    return S_OK;
}

static HRESULT create_completed_monitor(XPackageInstallationMonitorHandle *out)
{
    if (!out) return E_INVALIDARG;
    XPackageInstallationMonitorHandle mon = (XPackageInstallationMonitorHandle)calloc(1, sizeof(*mon));
    if (!mon) return E_OUTOFMEMORY;
    mon->ref = 1;
    mon->progress.totalBytes = 1048576ULL;
    mon->progress.installedBytes = 1048576ULL;
    mon->progress.launchBytes = 1048576ULL;
    mon->progress.launchable = true;
    mon->progress.completed = true;
    *out = mon;
    return S_OK;
}

/* -------------------------------------------------------------------------
 * Async Providers for InstallChunksAsync & MountWithUiAsync
 * ------------------------------------------------------------------------- */

struct pkg_mon_async {
    XPackageInstallationMonitorHandle mon;
};

static HRESULT CALLBACK pkg_mon_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct pkg_mon_async *ctx = (struct pkg_mon_async *)data->context;
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            HRESULT hr = create_completed_monitor(&ctx->mon);
            xgr_async_complete(data->async, hr, SUCCEEDED(hr) ? sizeof(XPackageInstallationMonitorHandle) : 0);
            return S_OK;
        }
        case XAsyncOp_GetResult:
            if (!data->buffer || data->bufferSize < sizeof(XPackageInstallationMonitorHandle)) return E_INVALIDARG;
            *(XPackageInstallationMonitorHandle *)data->buffer = ctx->mon;
            ctx->mon = NULL;
            return S_OK;
        case XAsyncOp_Cleanup:
            if (ctx->mon) free(ctx->mon);
            free(ctx);
            return S_OK;
        default:
            return S_OK;
    }
}

struct pkg_mount_async {
    char pkg_id[128];
    XPackageMountHandle mount;
};

static HRESULT CALLBACK pkg_mount_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct pkg_mount_async *ctx = (struct pkg_mount_async *)data->context;
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            HRESULT hr = xgr_package_mount_internal(ctx->pkg_id, &ctx->mount);
            xgr_async_complete(data->async, hr, SUCCEEDED(hr) ? sizeof(XPackageMountHandle) : 0);
            return S_OK;
        }
        case XAsyncOp_GetResult:
            if (!data->buffer || data->bufferSize < sizeof(XPackageMountHandle)) return E_INVALIDARG;
            *(XPackageMountHandle *)data->buffer = ctx->mount;
            ctx->mount = NULL;
            return S_OK;
        case XAsyncOp_Cleanup:
            if (ctx->mount) free(ctx->mount);
            free(ctx);
            return S_OK;
        default:
            return S_OK;
    }
}

/* -------------------------------------------------------------------------
 * IXPackageImpl4 Methods (Exact 42-slot vtable)
 * ------------------------------------------------------------------------- */

static HRESULT WINAPI xp_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) {
        *ppv = NULL;
        return E_INVALIDARG;
    }
    if (IsEqualGUID(riid, &IID_IUnknown) ||
        IsEqualGUID(riid, &IID_IXPackageLegacy) ||
        IsEqualGUID(riid, &IID_IXPackageImpl) ||
        IsEqualGUID(riid, &IID_IXPackageImpl2) ||
        IsEqualGUID(riid, &IID_IXPackageImpl3) ||
        IsEqualGUID(riid, &IID_IXPackageImpl4)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static ULONG WINAPI xp_AddRef(void *iface) { (void)iface; return 2; }
static ULONG WINAPI xp_Release(void *iface) { (void)iface; return 1; }

static HRESULT WINAPI xp_XPackageGetCurrentProcessPackageIdentifier(void *iface, SIZE_T bufferSize, char *buffer)
{
    (void)iface;
    if (!buffer) return E_INVALIDARG;
    struct xgr_runtime_config_snapshot cfg;
    xgr_copy_runtime_config_snapshot(&cfg);
    if (!cfg.packaged) return E_GAMEPACKAGE_APP_NOT_PACKAGED;
    if (bufferSize < XGR_PACKAGE_IDENTIFIER_MAX_LEN) return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
    memset(buffer, 0, bufferSize);
    snprintf(buffer, bufferSize, "%s", cfg.packageIdentifier);
    return xgr_return_hr(S_OK);
}

static BOOLEAN WINAPI xp_XPackageIsPackagedProcess(void *iface)
{
    (void)iface;
    struct xgr_runtime_config_snapshot cfg;
    xgr_copy_runtime_config_snapshot(&cfg);
    return cfg.packaged ? TRUE : FALSE;
}

static HRESULT WINAPI xp_XPackageCreateInstallationMonitor(void *iface, const char *pkgId, uint32_t selCnt, void *sels, uint32_t minMs, XTaskQueueHandle q, XPackageInstallationMonitorHandle *out)
{
    (void)iface; (void)pkgId; (void)selCnt; (void)sels; (void)minMs; (void)q;
    return xgr_return_hr(create_completed_monitor(out));
}

static void WINAPI xp_XPackageCloseInstallationMonitorHandle(void *iface, XPackageInstallationMonitorHandle mon)
{
    (void)iface;
    if (!mon) return;
    if (InterlockedDecrement(&mon->ref) == 0) free(mon);
}

static void WINAPI xp_XPackageGetInstallationProgress(void *iface, XPackageInstallationMonitorHandle mon, XPackageInstallationProgress *prog)
{
    (void)iface;
    if (!prog) return;
    if (mon) {
        *prog = mon->progress;
    } else {
        prog->totalBytes = 1048576ULL;
        prog->installedBytes = 1048576ULL;
        prog->launchBytes = 1048576ULL;
        prog->launchable = true;
        prog->completed = true;
    }
}

static BOOLEAN WINAPI xp_XPackageUpdateInstallationMonitor(void *iface, XPackageInstallationMonitorHandle mon)
{
    (void)iface; (void)mon;
    return FALSE;
}

static HRESULT WINAPI xp_XPackageRegisterInstallationProgressChanged(void *iface, XPackageInstallationMonitorHandle mon, void *ctx, void *cb, XTaskQueueRegistrationToken *tok)
{
    (void)iface; (void)mon; (void)ctx; (void)cb;
    if (!tok) return E_INVALIDARG;
    tok->token = InterlockedIncrement64((volatile LONGLONG *)&g_next_pkg_token);
    return S_OK;
}

static BOOLEAN WINAPI xp_XPackageUnregisterInstallationProgressChanged(void *iface, XPackageInstallationMonitorHandle mon, XTaskQueueRegistrationToken tok, BOOLEAN wait)
{
    (void)iface; (void)mon; (void)tok; (void)wait;
    return TRUE;
}

static HRESULT WINAPI xp_XPackageGetUserLocale(void *iface, SIZE_T localeSize, char *locale)
{
    (void)iface;
    if (!locale) return E_INVALIDARG;
    wchar_t wloc[LOCALE_NAME_MAX_LENGTH] = { 0 };
    char utf8[LOCALE_NAME_MAX_LENGTH * 2] = "en-US";
    if (GetUserDefaultLocaleName(wloc, LOCALE_NAME_MAX_LENGTH) > 0) {
        int n = WideCharToMultiByte(CP_UTF8, 0, wloc, -1, utf8, sizeof(utf8) - 1, NULL, NULL);
        if (n <= 0 || !utf8[0]) strcpy(utf8, "en-US");
    }
    size_t need = strlen(utf8) + 1;
    if (localeSize < need) return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
    memcpy(locale, utf8, need);
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xp_XPackageFindChunkAvailability(void *iface, const char *pkgId, uint32_t selCnt, void *sels, uint32_t *avail)
{
    (void)iface; (void)pkgId; (void)selCnt; (void)sels;
    if (!avail) return E_INVALIDARG;
    *avail = 0; /* XPackageChunkAvailability_Ready */
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xp_XPackageEnumerateChunkAvailability(void *iface, const char *pkgId, uint32_t type, void *ctx, void *cb)
{
    (void)iface; (void)pkgId; (void)type; (void)ctx;
    if (!cb) return E_INVALIDARG;
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xp_XPackageChangeChunkInstallOrder(void *iface, const char *pkgId, uint32_t selCnt, void *sels)
{
    (void)iface; (void)pkgId; (void)selCnt; (void)sels;
    return S_OK;
}

static HRESULT WINAPI xp_XPackageInstallChunks(void *iface, const char *pkgId, uint32_t selCnt, void *sels, uint32_t minMs, BOOLEAN sup, XTaskQueueHandle q, XPackageInstallationMonitorHandle *out)
{
    (void)iface; (void)pkgId; (void)selCnt; (void)sels; (void)minMs; (void)sup; (void)q;
    return xgr_return_hr(create_completed_monitor(out));
}

static HRESULT WINAPI xp_XPackageInstallChunksAsync(void *iface, const char *pkgId, uint32_t selCnt, void *sels, uint32_t minMs, BOOLEAN sup, XAsyncBlock *async)
{
    (void)iface; (void)pkgId; (void)selCnt; (void)sels; (void)minMs; (void)sup;
    if (!async) return E_INVALIDARG;
    struct pkg_mon_async *ctx = (struct pkg_mon_async *)calloc(1, sizeof(*ctx));
    if (!ctx) return E_OUTOFMEMORY;
    HRESULT hr = xgr_async_begin(async, ctx, (const void *)xp_XPackageInstallChunksAsync, "XPackageInstallChunksAsync", pkg_mon_provider);
    if (FAILED(hr)) free(ctx);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xp_XPackageInstallChunksResult(void *iface, XAsyncBlock *async, XPackageInstallationMonitorHandle *out)
{
    (void)iface;
    if (!out) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xp_XPackageInstallChunksAsync, sizeof(*out), out, NULL));
}

static HRESULT WINAPI xp_XPackageEstimateDownloadSize(void *iface, const char *pkgId, uint32_t selCnt, void *sels, uint64_t *dlSize, BOOLEAN *shouldPresent)
{
    (void)iface; (void)pkgId; (void)selCnt; (void)sels;
    if (!dlSize) return E_INVALIDARG;
    *dlSize = 0;
    if (shouldPresent) *shouldPresent = FALSE;
    return S_OK;
}

static HRESULT WINAPI xp_XPackageUninstallChunks(void *iface, const char *pkgId, uint32_t selCnt, void *sels)
{
    (void)iface; (void)pkgId; (void)selCnt; (void)sels;
    return S_OK;
}

static HRESULT enumerate_packages_common(uint32_t kind, uint32_t scope, void *context, XPackageEnumerationCallback *callback)
{
    (void)scope;
    if (!callback) return E_INVALIDARG;
    struct xgr_runtime_config_snapshot cfg;
    xgr_copy_runtime_config_snapshot(&cfg);

    /* XPackageKind_Game == 0 */
    if (kind == 0 && cfg.packaged) {
        XPackageDetails det;
        memset(&det, 0, sizeof(det));
        det.packageIdentifier = cfg.packageIdentifier;
        det.version = cfg.version;
        det.kind = 0;
        det.displayName = cfg.displayName[0] ? cfg.displayName : cfg.identityName;
        det.description = det.displayName;
        det.publisher = cfg.publisher;
        det.storeId = cfg.storeId;
        det.installing = false;
        det.index = 0;
        det.count = 1;
        det.ageRestricted = false;
        det.titleID = cfg.titleIdHex;
        callback(context, &det);
    }
    return S_OK;
}

static HRESULT WINAPI xp_XPackageEnumeratePackages(void *iface, uint32_t kind, uint32_t scope, void *ctx, XPackageEnumerationCallback *cb)
{
    (void)iface;
    return xgr_return_hr(enumerate_packages_common(kind, scope, ctx, cb));
}

static HRESULT WINAPI xp_XPackageRegisterPackageInstalled(void *iface, XTaskQueueHandle q, void *ctx, void *cb, XTaskQueueRegistrationToken *tok)
{
    (void)iface; (void)q; (void)ctx;
    if (!tok || !cb) return E_INVALIDARG;
    tok->token = InterlockedIncrement64((volatile LONGLONG *)&g_next_pkg_token);
    return S_OK;
}

static BOOLEAN WINAPI xp_XPackageUnregisterPackageInstalled(void *iface, XTaskQueueRegistrationToken tok, BOOLEAN wait)
{
    (void)iface; (void)tok; (void)wait;
    return TRUE;
}

static HRESULT WINAPI xp_XPackageMountLegacy(void *iface, const char *pkgId, XPackageMountHandle *mount)
{
    (void)iface;
    return xgr_return_hr(xgr_package_mount_internal(pkgId, mount));
}

static HRESULT WINAPI xp_XPackageGetMountPathSize(void *iface, XPackageMountHandle mount, SIZE_T *pathSize)
{
    (void)iface;
    if (!mount || !pathSize) return E_INVALIDARG;
    *pathSize = strlen(mount->path) + 1;
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xp_XPackageGetMountPath(void *iface, XPackageMountHandle mount, SIZE_T pathSize, char *path)
{
    (void)iface;
    if (!mount || !path) return E_INVALIDARG;
    size_t need = strlen(mount->path) + 1;
    if (pathSize < need) return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
    memcpy(path, mount->path, need);
    return xgr_return_hr(S_OK);
}

static void WINAPI xp_XPackageCloseMountHandle(void *iface, XPackageMountHandle mount)
{
    (void)iface;
    if (!mount) return;
    if (InterlockedDecrement(&mount->ref) == 0) free(mount);
}

static HRESULT WINAPI xp_XPackageGetIdentifierLegacy(void *iface, const char *storeId, SIZE_T size, char *identifier)
{
    (void)iface;
    if (!storeId || !identifier) return E_INVALIDARG;
    if (size < XGR_PACKAGE_IDENTIFIER_MAX_LEN) return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
    struct xgr_runtime_config_snapshot cfg;
    xgr_copy_runtime_config_snapshot(&cfg);
    snprintf(identifier, size, "%s", cfg.packageIdentifier);
    return S_OK;
}

static HRESULT WINAPI xp_XPackageGetWriteStats(void *iface, XPackageWriteStats *stats)
{
    (void)iface;
    if (!stats) return E_INVALIDARG;
    stats->interval = 60000ULL;
    stats->budget = 100ULL * 1024ULL * 1024ULL;
    stats->elapsed = 0ULL;
    stats->bytesWritten = 0ULL;
    return S_OK;
}

static HRESULT WINAPI xp_XPackageEnumerateFeatures(void *iface, const char *pkgId, void *ctx, void *cb)
{
    (void)iface; (void)pkgId; (void)ctx;
    if (!cb) return E_INVALIDARG;
    return S_OK;
}

static HRESULT WINAPI xp_XPackageUninstallUWPInstance(void *iface, const char *pkgName)
{
    (void)iface; (void)pkgName;
    return S_OK;
}

static BOOLEAN WINAPI xp_XPackageUninstallPackage(void *iface, const char *pkgId)
{
    (void)iface; (void)pkgId;
    return FALSE;
}

/* IXPackageImpl2 */
static HRESULT WINAPI xp_XPackageMountWithUiAsync(void *iface, const char *pkgId, XAsyncBlock *async)
{
    (void)iface;
    if (!pkgId || !pkgId[0] || !async) return E_INVALIDARG;
    struct pkg_mount_async *ctx = (struct pkg_mount_async *)calloc(1, sizeof(*ctx));
    if (!ctx) return E_OUTOFMEMORY;
    snprintf(ctx->pkg_id, sizeof(ctx->pkg_id), "%s", pkgId);
    HRESULT hr = xgr_async_begin(async, ctx, (const void *)xp_XPackageMountWithUiAsync, "XPackageMountWithUiAsync", pkg_mount_provider);
    if (FAILED(hr)) free(ctx);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xp_XPackageMountWithUiResult(void *iface, XAsyncBlock *async, XPackageMountHandle *mount)
{
    (void)iface;
    if (!mount) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xp_XPackageMountWithUiAsync, sizeof(*mount), mount, NULL));
}

/* IXPackageImpl4 */
static HRESULT WINAPI xp_XPackageGetKind(void *iface, const char *pkgId, uint32_t *kind)
{
    (void)iface;
    if (!pkgId || !kind) return E_INVALIDARG;
    struct xgr_runtime_config_snapshot cfg;
    xgr_copy_runtime_config_snapshot(&cfg);
    if (cfg.packageIdentifier[0] && _stricmp(pkgId, cfg.packageIdentifier) == 0) {
        *kind = 0; /* XPackageKind_Game */
    } else {
        *kind = 1; /* XPackageKind_Content */
    }
    return S_OK;
}

static const void *const g_xpackage4_vtbl[42] = {
    (const void *)xp_QueryInterface,                                    /* 0 */
    (const void *)xp_AddRef,                                            /* 1 */
    (const void *)xp_Release,                                           /* 2 */
    (const void *)xp_XPackageGetCurrentProcessPackageIdentifier,        /* 3 */
    (const void *)xp_XPackageIsPackagedProcess,                         /* 4 */
    (const void *)xp_XPackageCreateInstallationMonitor,                 /* 5 */
    (const void *)xp_XPackageCloseInstallationMonitorHandle,            /* 6 */
    (const void *)xp_XPackageGetInstallationProgress,                   /* 7 */
    (const void *)xp_XPackageUpdateInstallationMonitor,                 /* 8 */
    (const void *)xp_XPackageRegisterInstallationProgressChanged,       /* 9 */
    (const void *)xp_XPackageUnregisterInstallationProgressChanged,     /* 10 */
    (const void *)xp_XPackageGetUserLocale,                             /* 11 */
    (const void *)xp_XPackageFindChunkAvailability,                     /* 12 */
    (const void *)xp_XPackageEnumerateChunkAvailability,                /* 13 */
    (const void *)xp_XPackageChangeChunkInstallOrder,                   /* 14 */
    (const void *)xp_XPackageInstallChunks,                             /* 15 */
    (const void *)xp_XPackageInstallChunksAsync,                        /* 16 */
    (const void *)xp_XPackageInstallChunksResult,                       /* 17 */
    (const void *)xp_XPackageEstimateDownloadSize,                      /* 18 */
    (const void *)xp_XPackageUninstallChunks,                           /* 19 */
    (const void *)xp_XPackageEnumeratePackages,                         /* 20: Legacy */
    (const void *)xp_XPackageRegisterPackageInstalled,                  /* 21: Legacy */
    (const void *)xp_XPackageUnregisterPackageInstalled,                /* 22 */
    (const void *)xp_XPackageMountLegacy,                               /* 23: Legacy */
    (const void *)xp_XPackageGetMountPathSize,                          /* 24 */
    (const void *)xp_XPackageGetMountPath,                              /* 25 */
    (const void *)xp_XPackageCloseMountHandle,                          /* 26 */
    (const void *)xp_XPackageGetIdentifierLegacy,                       /* 27: Legacy */
    (const void *)xp_XPackageEnumeratePackages,                         /* 28 */
    (const void *)xp_XPackageRegisterPackageInstalled,                  /* 29 */
    (const void *)xp_XPackageGetWriteStats,                             /* 30 */
    (const void *)xp_XPackageEnumerateFeatures,                         /* 31: Legacy */
    (const void *)xp_XPackageUninstallUWPInstance,                      /* 32 */
    (const void *)xp_XPackageEnumerateFeatures,                         /* 33 */
    (const void *)xp_XPackageUninstallPackage,                          /* 34 */
    /* IXPackageImpl2 */
    (const void *)xp_XPackageEnumeratePackages,                         /* 35 */
    (const void *)xp_XPackageRegisterPackageInstalled,                  /* 36 */
    (const void *)xp_XPackageMountWithUiAsync,                          /* 37 */
    (const void *)xp_XPackageMountWithUiResult,                         /* 38 */
    /* IXPackageImpl3 */
    (const void *)xp_XPackageEnumeratePackages,                         /* 39 */
    (const void *)xp_XPackageRegisterPackageInstalled,                  /* 40 */
    /* IXPackageImpl4 */
    (const void *)xp_XPackageGetKind                                    /* 41 */
};

static struct { const void *lpVtbl; } g_xpackage_singleton = { g_xpackage4_vtbl };

HRESULT xgr_query_package(REFIID iid, void **ppv)
{
    return xp_QueryInterface(&g_xpackage_singleton, iid, ppv);
}
