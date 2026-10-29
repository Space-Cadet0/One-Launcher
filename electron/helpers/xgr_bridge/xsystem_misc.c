/*
 * One Launcher XGR Bridge — System, Networking, PLS, GameUI, Error, Display & Auxiliary Providers
 * Pure Win32 C11 — Zero WinRT / RoGetActivationFactory dependencies.
 */

#include "xgr_internal.h"

static uint64_t g_misc_reg_token = 1000;

static HRESULT WINAPI misc_AddRef_2(void *iface) { (void)iface; return 2; }
static ULONG WINAPI misc_AddRef(void *iface) { (void)misc_AddRef_2; (void)iface; return 2; }
static ULONG WINAPI misc_Release(void *iface) { (void)iface; return 1; }
static HRESULT WINAPI misc_NotImpl(void *iface) { (void)iface; return E_NOTIMPL; }
static HRESULT WINAPI misc_Ok0(void *iface) { (void)iface; return S_OK; }

static HRESULT CALLBACK misc_noop_async_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: xgr_async_complete(data->async, S_OK, 0); return S_OK;
        default: return S_OK;
    }
}

/* =========================================================================
 * 1. IXErrorImpl (6 slots, __PADDING__ at slot 3)
 * ========================================================================= */

static SRWLOCK g_err_lock = SRWLOCK_INIT;
static XErrorCallback *g_err_cb = NULL;
static void *g_err_ctx = NULL;
static uint32_t g_err_opt_dbg = 0;
static uint32_t g_err_opt_nodbg = 0;

BOOL xgr_invoke_error_report(HRESULT error, const char *message)
{
    AcquireSRWLockShared(&g_err_lock);
    XErrorCallback *cb = g_err_cb;
    void *ctx = g_err_ctx;
    uint32_t opts = IsDebuggerPresent() ? g_err_opt_dbg : g_err_opt_nodbg;
    ReleaseSRWLockShared(&g_err_lock);

    bool handled = false;
    if (cb) {
        handled = cb(error, message ? message : "", ctx);
    }
    if (!handled && (opts & 0x01) && message) {
        OutputDebugStringA(message);
    }
    return TRUE;
}

static HRESULT WINAPI xerr_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXErrorImpl)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static void WINAPI xerr_SetCallback(void *iface, XErrorCallback *cb, void *ctx)
{
    (void)iface;
    AcquireSRWLockExclusive(&g_err_lock);
    g_err_cb = cb;
    g_err_ctx = ctx;
    ReleaseSRWLockExclusive(&g_err_lock);
}

static void WINAPI xerr_SetOptions(void *iface, uint32_t dbg, uint32_t nodbg)
{
    (void)iface;
    AcquireSRWLockExclusive(&g_err_lock);
    g_err_opt_dbg = dbg;
    g_err_opt_nodbg = nodbg;
    ReleaseSRWLockExclusive(&g_err_lock);
}

static const void *const g_xerror_vtbl[6] = {
    (const void *)xerr_QueryInterface,
    (const void *)misc_AddRef,
    (const void *)misc_Release,
    (const void *)misc_NotImpl, /* 3: __PADDING__ */
    (const void *)xerr_SetCallback,
    (const void *)xerr_SetOptions
};
static struct { const void *lpVtbl; } g_xerror_singleton = { g_xerror_vtbl };

HRESULT xgr_query_error(REFIID iid, void **ppv)
{
    return xerr_QueryInterface(&g_xerror_singleton, iid, ppv);
}

/* =========================================================================
 * 2. IXDisplayImpl (5 slots, __PADDING__ at slot 3) & IXLauncherImpl (6 slots)
 * ========================================================================= */

static HRESULT WINAPI xdisp_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXDisplayImpl)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static uint32_t WINAPI xdisp_TryEnableHdrMode(void *iface, uint32_t pref, float *hdrInfo)
{
    (void)iface; (void)pref;
    if (hdrInfo) {
        hdrInfo[0] = 0.0f;
        hdrInfo[1] = 0.0f;
        hdrInfo[2] = 0.0f;
    }
    return 2; /* XDisplayHdrModeResult_Disabled */
}

static const void *const g_xdisplay_vtbl[5] = {
    (const void *)xdisp_QueryInterface,
    (const void *)misc_AddRef,
    (const void *)misc_Release,
    (const void *)misc_NotImpl, /* 3: __PADDING__ */
    (const void *)xdisp_TryEnableHdrMode
};
static struct { const void *lpVtbl; } g_xdisplay_singleton = { g_xdisplay_vtbl };

HRESULT xgr_query_display(REFIID iid, void **ppv)
{
    return xdisp_QueryInterface(&g_xdisplay_singleton, iid, ppv);
}

static HRESULT WINAPI xlnch_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXLauncherImpl)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static HRESULT WINAPI xlnch_LaunchUri(void *iface, XUserHandle user, const char *uri)
{
    (void)iface; (void)user;
    if (!uri) return E_INVALIDARG;
    return S_OK;
}

static HRESULT WINAPI xlnch_AcquireTimeoutDeferral(void *iface, void **handle)
{
    (void)iface;
    if (!handle) return E_INVALIDARG;
    *handle = (void *)(uintptr_t)0xDEFE0001u;
    return S_OK;
}

static void WINAPI xlnch_CloseTimeoutDeferral(void *iface, void *handle)
{
    (void)iface; (void)handle;
}

static const void *const g_xlauncher_vtbl[6] = {
    (const void *)xlnch_QueryInterface,
    (const void *)misc_AddRef,
    (const void *)misc_Release,
    (const void *)xlnch_LaunchUri,
    (const void *)xlnch_AcquireTimeoutDeferral,
    (const void *)xlnch_CloseTimeoutDeferral
};
static struct { const void *lpVtbl; } g_xlauncher_singleton = { g_xlauncher_vtbl };

HRESULT xgr_query_launcher(REFIID iid, void **ppv)
{
    return xlnch_QueryInterface(&g_xlauncher_singleton, iid, ppv);
}

/* =========================================================================
 * 3. IXGameImpl3 (6 slots)
 * ========================================================================= */

static HRESULT WINAPI xgame_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) ||
        IsEqualGUID(riid, &IID_IXGameImpl) ||
        IsEqualGUID(riid, &IID_IXGameImpl2) ||
        IsEqualGUID(riid, &IID_IXGameImpl3)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static HRESULT WINAPI xgame_GetXboxTitleId(void *iface, uint32_t *titleId)
{
    (void)iface;
    if (!titleId) return E_INVALIDARG;
    struct xgr_runtime_config_snapshot cfg;
    xgr_copy_runtime_config_snapshot(&cfg);
    if (cfg.titleId == 0) {
        *titleId = 0;
        return E_GAME_MISSING_GAME_CONFIG;
    }
    *titleId = cfg.titleId;
    return xgr_return_hr(S_OK);
}

static void WINAPI xgame_LaunchNewGame(void *iface, const char *exe, const char *args, XUserHandle u)
{
    (void)iface; (void)exe; (void)args; (void)u;
}

static HRESULT WINAPI xgame_RestartOnCrash(void *iface, const char *args, uint32_t res)
{
    (void)iface; (void)args; (void)res;
    return S_OK;
}

static const void *const g_xgame_vtbl[6] = {
    (const void *)xgame_QueryInterface,
    (const void *)misc_AddRef,
    (const void *)misc_Release,
    (const void *)xgame_GetXboxTitleId,
    (const void *)xgame_LaunchNewGame,
    (const void *)xgame_RestartOnCrash
};
static struct { const void *lpVtbl; } g_xgame_singleton = { g_xgame_vtbl };

HRESULT xgr_query_game(REFIID iid, void **ppv)
{
    return xgame_QueryInterface(&g_xgame_singleton, iid, ppv);
}

/* =========================================================================
 * 4. IXSystemImpl5 (9 slots) & IXSystemAnalyticsImpl (4 slots)
 * ========================================================================= */

static HRESULT WINAPI xsys_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) ||
        IsEqualGUID(riid, &IID_IXSystemImpl) ||
        IsEqualGUID(riid, &IID_IXSystemImpl2) ||
        IsEqualGUID(riid, &IID_IXSystemImpl3) ||
        IsEqualGUID(riid, &IID_IXSystemImpl4) ||
        IsEqualGUID(riid, &IID_IXSystemImpl5)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static HRESULT WINAPI xsys_GetConsoleId(void *iface, SIZE_T sz, char *out, SIZE_T *used)
{
    (void)iface;
    const char *cid = "00000000.00000000.00000000.00000000.00";
    const SIZE_T need = 39; /* XSystemConsoleIdBytes */
    if (used) *used = need;
    if (!out) return xgr_return_hr(E_POINTER);
    if (sz < need) return xgr_return_hr(HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER));
    memcpy(out, cid, need);
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xsys_GetXboxLiveSandboxId(void *iface, SIZE_T sz, char *out, SIZE_T *used)
{
    (void)iface;
    const char *sbid = "RETAIL";
    const SIZE_T need = 7; /* strlen("RETAIL") + 1; XSystemXboxLiveSandboxIdMaxBytes == 16 */
    if (used) *used = need;
    if (!out) return xgr_return_hr(E_POINTER);
    if (sz < need) return xgr_return_hr(HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER));
    memcpy(out, sbid, need);
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xsys_GetAppSpecificDeviceId(void *iface, SIZE_T sz, char *out, SIZE_T *used)
{
    (void)iface;
    const SIZE_T need = 45; /* XSystemAppSpecificDeviceIdBytes */
    if (used) *used = need;
    if (!out) return xgr_return_hr(E_POINTER);
    if (sz < need) return xgr_return_hr(HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER));

    struct xgr_runtime_config_snapshot cfg;
    xgr_copy_runtime_config_snapshot(&cfg);
    char seed[640];
    wchar_t comp_w[MAX_COMPUTERNAME_LENGTH + 1] = L"MAC";
    DWORD clen = MAX_COMPUTERNAME_LENGTH + 1;
    if (!GetComputerNameW(comp_w, &clen) || clen == 0) {
        wcscpy(comp_w, L"MAC");
    }
    char comp_utf8[(MAX_COMPUTERNAME_LENGTH + 1) * 4] = "MAC";
    int u8len = WideCharToMultiByte(CP_UTF8, 0, comp_w, -1, comp_utf8, (int)sizeof(comp_utf8), NULL, NULL);
    if (u8len <= 0 || !comp_utf8[0]) {
        strcpy(comp_utf8, "MAC");
    }
    snprintf(seed, sizeof(seed), "OneLauncher.DeviceId:%s:%s", comp_utf8, cfg.packageFamilyName);

    uint8_t digest[32];
    xgr_sha256((const uint8_t *)seed, strlen(seed), digest);
    char *b64 = xgr_base64_encode_alloc(digest, 32);
    if (!b64) return xgr_return_hr(E_OUTOFMEMORY);
    /* 32 bytes base64 = 44 chars + NUL = 45 bytes */
    memcpy(out, b64, 44);
    out[44] = '\0';
    free(b64);
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xsys_HandleTrack(void *iface, void *cb, void *ctx)
{
    (void)iface; (void)cb; (void)ctx;
    return S_OK;
}

static BOOLEAN WINAPI xsys_IsHandleValid(void *iface, void *handle)
{
    (void)iface;
    return handle != NULL ? TRUE : FALSE;
}

static void WINAPI xsys_AllowFullDownloadBandwidth(void *iface, BOOLEAN enable)
{
    (void)iface; (void)enable;
}

static const void *const g_xsystem_vtbl[9] = {
    (const void *)xsys_QueryInterface,
    (const void *)misc_AddRef,
    (const void *)misc_Release,
    (const void *)xsys_GetConsoleId,
    (const void *)xsys_GetXboxLiveSandboxId,
    (const void *)xsys_GetAppSpecificDeviceId,
    (const void *)xsys_HandleTrack,
    (const void *)xsys_IsHandleValid,
    (const void *)xsys_AllowFullDownloadBandwidth
};
static struct { const void *lpVtbl; } g_xsystem_singleton = { g_xsystem_vtbl };

HRESULT xgr_query_system(REFIID iid, void **ppv)
{
    return xsys_QueryInterface(&g_xsystem_singleton, iid, ppv);
}

static HRESULT WINAPI xsysa_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXSystemAnalyticsImpl)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static XSystemAnalyticsInfo *WINAPI xsysa_GetAnalyticsInfo(void *iface, XSystemAnalyticsInfo *ret)
{
    (void)iface;
    if (!ret) return NULL;
    memset(ret, 0, sizeof(*ret));
    ret->osVersion.major = 10;
    ret->osVersion.minor = 0;
    ret->osVersion.build = 22631;
    ret->osVersion.revision = 0;
    ret->hostingOsVersion = ret->osVersion;
    strcpy(ret->family, "Windows");
    strcpy(ret->form, "Desktop");
    return ret;
}

static const void *const g_xsystem_analytics_vtbl[4] = {
    (const void *)xsysa_QueryInterface,
    (const void *)misc_AddRef,
    (const void *)misc_Release,
    (const void *)xsysa_GetAnalyticsInfo
};
static struct { const void *lpVtbl; } g_xsystem_analytics_singleton = { g_xsystem_analytics_vtbl };

HRESULT xgr_query_system_analytics(REFIID iid, void **ppv)
{
    return xsysa_QueryInterface(&g_xsystem_analytics_singleton, iid, ppv);
}

/* =========================================================================
 * 5. IXPersistentLocalStorageImpl3 (9 slots)
 * ========================================================================= */

static void resolve_pls_path_utf8(char *out_utf8, size_t out_sz)
{
    struct xgr_runtime_config_snapshot cfg;
    xgr_copy_runtime_config_snapshot(&cfg);
    wchar_t local_app[MAX_PATH * 2] = { 0 };
    DWORD n = GetEnvironmentVariableW(L"ONE_XGR_APPDATA_DIR", local_app, MAX_PATH * 2 - 1);
    if (n == 0 || n >= MAX_PATH * 2 - 1) {
        n = GetEnvironmentVariableW(L"LOCALAPPDATA", local_app, MAX_PATH * 2 - 1);
    }
    if (n == 0 || n >= MAX_PATH * 2 - 1) {
        wcscpy(local_app, L"C:\\users\\Public\\AppData\\Local");
    }

    const char *pfn = cfg.packageFamilyName[0]
        ? cfg.packageFamilyName
        : "OneLauncher.XboxGame_8wekyb3d8bbwe";
    wchar_t pfn_w[256] = { 0 };
    MultiByteToWideChar(CP_UTF8, 0, pfn, -1, pfn_w, 255);

    wchar_t pls_w[MAX_PATH * 2];
    swprintf(pls_w, sizeof(pls_w) / sizeof(pls_w[0]), L"%ls\\Packages\\%ls\\LocalState\\PersistentLocalStorage", local_app, pfn_w);

    /* Ensure directory hierarchy exists */
    for (wchar_t *p = pls_w + 3; *p; p++) {
        if (*p == L'\\') {
            *p = L'\0';
            CreateDirectoryW(pls_w, NULL);
            *p = L'\\';
        }
    }
    CreateDirectoryW(pls_w, NULL);

    WideCharToMultiByte(CP_UTF8, 0, pls_w, -1, out_utf8, (int)(out_sz - 1), NULL, NULL);
    out_utf8[out_sz - 1] = '\0';
}

static HRESULT WINAPI xpls_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) ||
        IsEqualGUID(riid, &IID_IXPersistentLocalStorageImpl) ||
        IsEqualGUID(riid, &IID_IXPersistentLocalStorageImpl2) ||
        IsEqualGUID(riid, &IID_IXPersistentLocalStorageImpl3)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static HRESULT WINAPI xpls_GetPathSize(void *iface, SIZE_T *pathSize)
{
    (void)iface;
    if (!pathSize) return E_INVALIDARG;
    char buf[MAX_PATH * 2] = { 0 };
    resolve_pls_path_utf8(buf, sizeof(buf));
    *pathSize = strlen(buf) + 1;
    return S_OK;
}

static HRESULT WINAPI xpls_GetPath(void *iface, SIZE_T pathSize, char *path, SIZE_T *pathUsed)
{
    (void)iface;
    if (!path) return E_INVALIDARG;
    char buf[MAX_PATH * 2] = { 0 };
    resolve_pls_path_utf8(buf, sizeof(buf));
    size_t need = strlen(buf) + 1;
    if (pathUsed) *pathUsed = need;
    if (pathSize < need) return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
    memcpy(path, buf, need);
    return S_OK;
}

static HRESULT WINAPI xpls_GetSpaceInfo(void *iface, uint64_t *info4)
{
    (void)iface;
    if (!info4) return E_INVALIDARG;
    uint64_t free_bytes = 64ULL * 1024ULL * 1024ULL * 1024ULL;
    info4[0] = free_bytes; /* availableFreeBytes */
    info4[1] = free_bytes; /* totalFreeBytes */
    info4[2] = 0ULL;       /* usedBytes */
    info4[3] = free_bytes; /* totalBytes */
    return S_OK;
}

static HRESULT WINAPI xpls_PromptSpaceAsync(void *iface, uint64_t bytes, XAsyncBlock *ab)
{
    (void)iface; (void)bytes;
    return xgr_async_begin(ab, NULL, NULL, "XPersistentLocalStoragePromptUserForSpaceAsync", misc_noop_async_provider);
}

static HRESULT WINAPI xpls_PromptSpaceResult(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}

static HRESULT WINAPI xpls_MountForPackage(void *iface, const char *pkgId, XPackageMountHandle *mount)
{
    (void)iface;
    return xgr_package_mount_internal(pkgId, mount);
}

static const void *const g_xpls_vtbl[9] = {
    (const void *)xpls_QueryInterface,
    (const void *)misc_AddRef,
    (const void *)misc_Release,
    (const void *)xpls_GetPathSize,
    (const void *)xpls_GetPath,
    (const void *)xpls_GetSpaceInfo,
    (const void *)xpls_PromptSpaceAsync,
    (const void *)xpls_PromptSpaceResult,
    (const void *)xpls_MountForPackage
};
static struct { const void *lpVtbl; } g_xpls_singleton = { g_xpls_vtbl };

HRESULT xgr_query_pls(REFIID iid, void **ppv)
{
    return xpls_QueryInterface(&g_xpls_singleton, iid, ppv);
}

/* =========================================================================
 * 6. IXNetworkingImpl2 (21 slots — fires initial InternetAccess hint!)
 * ========================================================================= */

static void fill_online_hint(XNetworkingConnectivityHint *hint)
{
    if (!hint) return;
    memset(hint, 0, sizeof(*hint));
    hint->connectivityLevel = 3; /* XNetworkingConnectivityLevelHint_InternetAccess */
    hint->connectivityCost = 1;  /* XNetworkingConnectivityCostHint_Unrestricted */
    hint->ianaInterfaceType = 6; /* Ethernet */
    hint->networkInitialized = true;
    hint->approachingDataLimit = false;
    hint->overDataLimit = false;
    hint->roaming = false;
}

struct net_hint_task {
    XNetworkingConnectivityHintChangedCallback *cb;
    void *ctx;
};

static void CALLBACK fire_initial_net_hint_cb(void *context, bool canceled)
{
    struct net_hint_task *t = (struct net_hint_task *)context;
    if (!canceled && t && t->cb) {
        XNetworkingConnectivityHint hint;
        fill_online_hint(&hint);
        t->cb(t->ctx, &hint);
    }
    free(t);
}

static HRESULT CALLBACK net_port_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: xgr_async_complete(data->async, S_OK, sizeof(uint16_t)); return S_OK;
        case XAsyncOp_GetResult:
            if (!data->buffer || data->bufferSize < sizeof(uint16_t)) return E_INVALIDARG;
            *(uint16_t *)data->buffer = 0;
            return S_OK;
        default: return S_OK;
    }
}

struct XNetworkingSecurityInfoAbi {
    uint32_t enabledHttpSecurityProtocolFlags;
    size_t thumbprintCount;
    void *thumbprints;
};

static HRESULT CALLBACK net_sec_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: xgr_async_complete(data->async, S_OK, sizeof(struct XNetworkingSecurityInfoAbi)); return S_OK;
        case XAsyncOp_GetResult: {
            if (!data->buffer || data->bufferSize < sizeof(struct XNetworkingSecurityInfoAbi)) return E_INVALIDARG;
            struct XNetworkingSecurityInfoAbi *sec = (struct XNetworkingSecurityInfoAbi *)data->buffer;
            sec->enabledHttpSecurityProtocolFlags = 0x0C; /* TLS 1.2 | TLS 1.3 */
            sec->thumbprintCount = 0;
            sec->thumbprints = NULL;
            return S_OK;
        }
        default: return S_OK;
    }
}

static HRESULT WINAPI xnet_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) ||
        IsEqualGUID(riid, &IID_IXNetworkingImpl) ||
        IsEqualGUID(riid, &IID_IXNetworkingImpl2)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static HRESULT WINAPI xnet_QueryPrefPort(void *iface, uint16_t *port)
{
    (void)iface;
    if (!port) return E_INVALIDARG;
    *port = 0;
    return S_OK;
}

static HRESULT WINAPI xnet_QueryPrefPortAsync(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    return xgr_async_begin(ab, NULL, (const void *)xnet_QueryPrefPortAsync, "XNetworkingQueryPreferredLocalUdpMultiplayerPortAsync", net_port_provider);
}

static HRESULT WINAPI xnet_QueryPrefPortResult(void *iface, XAsyncBlock *ab, uint16_t *port)
{
    (void)iface;
    if (!port) return E_INVALIDARG;
    return xgr_async_get_result(ab, (const void *)xnet_QueryPrefPortAsync, sizeof(*port), port, NULL);
}

static HRESULT WINAPI xnet_RegPrefPortChanged(void *iface, XTaskQueueHandle q, void *ctx, void *cb, XTaskQueueRegistrationToken *tok)
{
    (void)iface; (void)q; (void)ctx; (void)cb;
    if (!tok) return E_INVALIDARG;
    tok->token = InterlockedIncrement64((volatile LONGLONG *)&g_misc_reg_token);
    return S_OK;
}

static BOOLEAN WINAPI xnet_UnregPrefPortChanged(void *iface, XTaskQueueRegistrationToken tok, BOOLEAN wait)
{
    (void)iface; (void)tok; (void)wait;
    return TRUE;
}

static HRESULT WINAPI xnet_QuerySecUrlAsync(void *iface, const void *url, XAsyncBlock *ab)
{
    (void)iface; (void)url;
    return xgr_async_begin(ab, NULL, (const void *)xnet_QuerySecUrlAsync, "XNetworkingQuerySecurityInformationForUrlAsync", net_sec_provider);
}

static HRESULT WINAPI xnet_QuerySecUrlResultSize(void *iface, XAsyncBlock *ab, SIZE_T *sz)
{
    (void)iface;
    return xgr_async_get_result_size(ab, sz);
}

static HRESULT WINAPI xnet_QuerySecUrlResult(void *iface, XAsyncBlock *ab, SIZE_T sz, SIZE_T *used, uint8_t *buf, void **ptrOut)
{
    (void)iface;
    HRESULT hr = xgr_async_get_result(ab, (const void *)xnet_QuerySecUrlAsync, sz, buf, used);
    if (SUCCEEDED(hr) && ptrOut) *ptrOut = buf;
    return hr;
}

static HRESULT WINAPI xnet_VerifyServerCert(void *iface, void *reqHandle, const void *secInfo)
{
    (void)iface; (void)reqHandle; (void)secInfo;
    return S_OK;
}

static HRESULT WINAPI xnet_GetConnectivityHint(void *iface, XNetworkingConnectivityHint *hint)
{
    (void)iface;
    if (!hint) return E_INVALIDARG;
    fill_online_hint(hint);
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xnet_RegConnectivityHintChanged(void *iface, XTaskQueueHandle queue, void *ctx, XNetworkingConnectivityHintChangedCallback *cb, XTaskQueueRegistrationToken *tok)
{
    (void)iface;
    if (!cb || !tok) return E_INVALIDARG;
    tok->token = InterlockedIncrement64((volatile LONGLONG *)&g_misc_reg_token);

    XTaskQueueHandle target_q = queue;
    bool close_q = false;
    if (!target_q) {
        if (xgr_task_queue_get_process(&target_q) && target_q) {
            close_q = true;
        }
    }

    struct net_hint_task *t = (struct net_hint_task *)malloc(sizeof(*t));
    if (t) {
        t->cb = cb;
        t->ctx = ctx;
        if (!target_q || FAILED(xgr_task_queue_submit_delayed(target_q, XTaskQueuePort_Completion, 0, t, fire_initial_net_hint_cb))) {
            fire_initial_net_hint_cb(t, false);
        }
    }
    if (close_q && target_q) xgr_task_queue_close(target_q);
    return xgr_return_hr(S_OK);
}

static BOOLEAN WINAPI xnet_UnregConnectivityHintChanged(void *iface, XTaskQueueRegistrationToken tok, BOOLEAN wait)
{
    (void)iface; (void)tok; (void)wait;
    return TRUE;
}

static HRESULT WINAPI xnet_QueryConfigSetting(void *iface, uint32_t setting, uint64_t *val)
{
    (void)iface; (void)setting;
    if (!val) return E_INVALIDARG;
    *val = 0;
    return S_OK;
}

static HRESULT WINAPI xnet_SetConfigSetting(void *iface, uint32_t setting, uint64_t val)
{
    (void)iface; (void)setting; (void)val;
    return S_OK;
}

static HRESULT WINAPI xnet_QueryStatistics(void *iface, uint32_t type, void *buf)
{
    (void)iface; (void)type; (void)buf;
    return E_NOTIMPL;
}

static const void *const g_xnetworking_vtbl[21] = {
    (const void *)xnet_QueryInterface,          /* 0 */
    (const void *)misc_AddRef,                  /* 1 */
    (const void *)misc_Release,                 /* 2 */
    (const void *)xnet_QueryPrefPort,           /* 3 */
    (const void *)xnet_QueryPrefPortAsync,      /* 4 */
    (const void *)xnet_QueryPrefPortResult,     /* 5 */
    (const void *)xnet_RegPrefPortChanged,      /* 6 */
    (const void *)xnet_UnregPrefPortChanged,    /* 7 */
    (const void *)xnet_QuerySecUrlAsync,        /* 8 */
    (const void *)xnet_QuerySecUrlResultSize,   /* 9 */
    (const void *)xnet_QuerySecUrlResult,       /* 10 */
    (const void *)xnet_QuerySecUrlAsync,        /* 11: Utf16 */
    (const void *)xnet_QuerySecUrlResultSize,   /* 12: Utf16 */
    (const void *)xnet_QuerySecUrlResult,       /* 13: Utf16 */
    (const void *)xnet_VerifyServerCert,        /* 14 */
    (const void *)xnet_GetConnectivityHint,     /* 15 */
    (const void *)xnet_RegConnectivityHintChanged, /* 16 */
    (const void *)xnet_UnregConnectivityHintChanged, /* 17 */
    (const void *)xnet_QueryConfigSetting,      /* 18 */
    (const void *)xnet_SetConfigSetting,        /* 19 */
    (const void *)xnet_QueryStatistics          /* 20 */
};
static struct { const void *lpVtbl; } g_xnetworking_singleton = { g_xnetworking_vtbl };

HRESULT xgr_query_networking(REFIID iid, void **ppv)
{
    return xnet_QueryInterface(&g_xnetworking_singleton, iid, ppv);
}

/* =========================================================================
 * 7. IXGameUiImpl4 (51 slots, __PADDING__..__PADDING_8__)
 * ========================================================================= */

static HRESULT WINAPI xui_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) ||
        IsEqualGUID(riid, &CLSID_XGameUiImpl) ||
        IsEqualGUID(riid, &IID_IXGameUiImpl) ||
        IsEqualGUID(riid, &IID_IXGameUiImpl2) ||
        IsEqualGUID(riid, &IID_IXGameUiImpl3) ||
        IsEqualGUID(riid, &IID_IXGameUiImpl4) ||
        IsEqualGUID(riid, &IID_IXGameUiImpl_Legacy0) ||
        IsEqualGUID(riid, &IID_IXGameUiImpl_Legacy1) ||
        IsEqualGUID(riid, &IID_IXGameUiImpl_Legacy2)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static HRESULT CALLBACK ui_u32_zero_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: xgr_async_complete(data->async, S_OK, sizeof(uint32_t)); return S_OK;
        case XAsyncOp_GetResult:
            if (data->buffer && data->bufferSize >= sizeof(uint32_t)) *(uint32_t *)data->buffer = 0;
            return S_OK;
        default: return S_OK;
    }
}

static HRESULT CALLBACK ui_player_picker_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: xgr_async_complete(data->async, S_OK, 0); return S_OK;
        default: return S_OK;
    }
}

static HRESULT CALLBACK ui_text_entry_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: xgr_async_complete(data->async, S_OK, 1); return S_OK;
        case XAsyncOp_GetResult:
            if (!data->buffer || data->bufferSize < 1) {
                return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
            }
            ((char *)data->buffer)[0] = '\0';
            return S_OK;
        default: return S_OK;
    }
}

static HRESULT WINAPI xui_ShowMsgDlgAsync(void *iface, XAsyncBlock *ab, const char *t, const char *c, const char *b1, const char *b2, const char *b3, uint32_t defB, uint32_t canB)
{
    (void)iface; (void)t; (void)c; (void)b1; (void)b2; (void)b3; (void)defB; (void)canB;
    return xgr_async_begin(ab, NULL, NULL, "XGameUiShowMessageDialogAsync", ui_u32_zero_provider);
}
static HRESULT WINAPI xui_ShowMsgDlgResult(void *iface, XAsyncBlock *ab, uint32_t *btn)
{
    (void)iface;
    if (!btn) return E_INVALIDARG;
    return xgr_async_get_result(ab, NULL, sizeof(*btn), btn, NULL);
}
static HRESULT WINAPI xui_GenericAsync(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    return xgr_async_begin(ab, NULL, NULL, "XGameUiGenericAsync", misc_noop_async_provider);
}
static HRESULT WINAPI xui_GenericResult(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}
static HRESULT WINAPI xui_ShowPlayerPickerAsync(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    return xgr_async_begin(ab, NULL, (const void *)xui_ShowPlayerPickerAsync, "XGameUiShowPlayerPickerAsync", ui_player_picker_provider);
}
static HRESULT WINAPI xui_PlayerPickerCount(void *iface, XAsyncBlock *ab, uint32_t *cnt)
{
    (void)iface;
    if (!cnt) return E_INVALIDARG;
    size_t sz = 0;
    HRESULT hr = xgr_async_get_result_size(ab, &sz);
    if (FAILED(hr)) {
        *cnt = 0;
        return hr;
    }
    *cnt = (uint32_t)(sz / sizeof(uint64_t));
    return S_OK;
}
static HRESULT WINAPI xui_PlayerPickerResult(void *iface, XAsyncBlock *ab, uint32_t cnt, uint64_t *players, uint32_t *used)
{
    (void)iface;
    size_t used_bytes = 0;
    HRESULT hr = xgr_async_get_result(ab, (const void *)xui_ShowPlayerPickerAsync, (size_t)cnt * sizeof(uint64_t), players, &used_bytes);
    if (used) *used = SUCCEEDED(hr) ? (uint32_t)(used_bytes / sizeof(uint64_t)) : 0;
    return hr;
}
static HRESULT WINAPI xui_ShowTextEntryAsync(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    return xgr_async_begin(ab, NULL, (const void *)xui_ShowTextEntryAsync, "XGameUiShowTextEntryAsync", ui_text_entry_provider);
}
static HRESULT WINAPI xui_TextEntryResultSize(void *iface, XAsyncBlock *ab, uint32_t *sz)
{
    (void)iface;
    if (!sz) return E_INVALIDARG;
    size_t res_sz = 0;
    HRESULT hr = xgr_async_get_result_size(ab, &res_sz);
    if (FAILED(hr)) {
        *sz = 0;
        return hr;
    }
    *sz = (uint32_t)res_sz;
    return S_OK;
}
static HRESULT WINAPI xui_TextEntryResult(void *iface, XAsyncBlock *ab, uint32_t sz, char *buf, uint32_t *used)
{
    (void)iface;
    if (!buf && sz > 0) return E_INVALIDARG;
    size_t used_sz = 0;
    HRESULT hr = xgr_async_get_result(ab, (const void *)xui_ShowTextEntryAsync, (size_t)sz, buf, &used_sz);
    if (used) *used = SUCCEEDED(hr) ? (uint32_t)used_sz : 0;
    return hr;
}
static HRESULT WINAPI xui_WebAuthAsync(void *iface, XAsyncBlock *ab)
{
    (void)iface; (void)ab;
    return E_ABORT;
}

static const void *const g_xgameui4_vtbl[51] = {
    (const void *)xui_QueryInterface,       /* 0 */
    (const void *)misc_AddRef,              /* 1 */
    (const void *)misc_Release,             /* 2 */
    (const void *)xui_ShowMsgDlgAsync,      /* 3 */
    (const void *)xui_ShowMsgDlgResult,     /* 4 */
    (const void *)xui_GenericAsync,         /* 5: ShowSendGameInviteAsync */
    (const void *)xui_GenericResult,        /* 6 */
    (const void *)xui_GenericAsync,         /* 7: ShowPlayerProfileCardAsync */
    (const void *)xui_GenericResult,        /* 8 */
    (const void *)xui_GenericAsync,         /* 9: ShowAchievementsAsync */
    (const void *)xui_GenericResult,        /* 10 */
    (const void *)xui_ShowPlayerPickerAsync, /* 11: ShowPlayerPickerAsync */
    (const void *)xui_PlayerPickerCount,    /* 12 */
    (const void *)xui_PlayerPickerResult,   /* 13 */
    (const void *)xui_GenericAsync,         /* 14: ShowErrorDialogAsync */
    (const void *)xui_GenericResult,        /* 15 */
    (const void *)misc_Ok0,                 /* 16: SetNotificationPositionHint */
    (const void *)xui_ShowTextEntryAsync,   /* 17: ShowTextEntryAsync */
    (const void *)xui_TextEntryResultSize,  /* 18 */
    (const void *)xui_TextEntryResult,      /* 19 */
    (const void *)misc_NotImpl,             /* 20: __PADDING__ */
    (const void *)misc_NotImpl,             /* 21: __PADDING_2__ */
    (const void *)misc_NotImpl,             /* 22: __PADDING_3__ */
    (const void *)misc_NotImpl,             /* 23: __PADDING_4__ */
    (const void *)xui_WebAuthAsync,         /* 24: ShowWebAuthenticationAsync */
    (const void *)misc_NotImpl,             /* 25: ShowWebAuthenticationResultSize */
    (const void *)misc_NotImpl,             /* 26: ShowWebAuthenticationResult */
    (const void *)xui_WebAuthAsync,         /* 27: ShowWebAuthenticationWithOptionsAsync */
    (const void *)misc_NotImpl,             /* 28: __PADDING_5__ */
    (const void *)misc_NotImpl,             /* 29: __PADDING_6__ */
    /* IXGameUiImpl2 */
    (const void *)xui_GenericAsync,         /* 30: ShowMultiplayerActivityGameInviteAsync */
    (const void *)xui_GenericResult,        /* 31 */
    (const void *)misc_NotImpl,             /* 32: __PADDING_7__ */
    (const void *)misc_NotImpl,             /* 33: __PADDING_8__ */
    (const void *)misc_NotImpl,             /* 34: TextEntryOpen */
    (const void *)misc_Ok0,                 /* 35: TextEntryClose */
    (const void *)misc_NotImpl,             /* 36: TextEntryGetState */
    (const void *)misc_NotImpl,             /* 37: TextEntryGetExtents */
    (const void *)misc_Ok0,                 /* 38: TextEntryUpdatePositionHint */
    (const void *)misc_Ok0,                 /* 39: TextEntryUpdateVisibility */
    /* IXGameUiImpl3 */
    (const void *)xui_GenericAsync,         /* 40: ShowStateShareAsync */
    (const void *)xui_GenericResult,        /* 41 */
    /* IXGameUiImpl4 */
    (const void *)misc_Ok0,                 /* 42: SetUiCallbacks */
    (const void *)misc_Ok0,                 /* 43 */
    (const void *)misc_Ok0,                 /* 44 */
    (const void *)misc_Ok0,                 /* 45 */
    (const void *)misc_Ok0,                 /* 46 */
    (const void *)misc_Ok0,                 /* 47 */
    (const void *)misc_Ok0,                 /* 48 */
    (const void *)misc_Ok0,                 /* 49 */
    (const void *)misc_Ok0                  /* 50 */
};
static struct { const void *lpVtbl; } g_xgameui_singleton = { g_xgameui4_vtbl };

HRESULT xgr_query_game_ui(REFIID iid, void **ppv)
{
    return xui_QueryInterface(&g_xgameui_singleton, iid, ppv);
}

/* =========================================================================
 * 8. IXGameRuntimeFeatureImpl (4 slots)
 * ========================================================================= */

static HRESULT WINAPI xfeat_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXGameRuntimeFeatureImpl)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static BOOLEAN WINAPI xfeat_IsFeatureAvailable(void *iface, uint32_t feature)
{
    (void)iface;
    /* 1=XAppCapture, 13=XSpeechSynthesizer, 21=XGameStreaming -> FALSE; all core GDK features -> TRUE */
    if (feature == 1 || feature == 13 || feature == 21) return FALSE;
    return feature <= 21 ? TRUE : FALSE;
}

static const void *const g_xfeat_vtbl[4] = {
    (const void *)xfeat_QueryInterface,
    (const void *)misc_AddRef,
    (const void *)misc_Release,
    (const void *)xfeat_IsFeatureAvailable
};
static struct { const void *lpVtbl; } g_xfeat_singleton = { g_xfeat_vtbl };

HRESULT xgr_query_runtime_feature(REFIID iid, void **ppv)
{
    return xfeat_QueryInterface(&g_xfeat_singleton, iid, ppv);
}

/* =========================================================================
 * 9. Auxiliary Non-Blocking Providers (Accessibility, AppCapture, Protocol,
 *    Activation, Invite, Streaming, Event)
 * ========================================================================= */

/* Accessibility (23 slots) */
static HRESULT WINAPI xacc_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXAccessibilityImpl) || IsEqualGUID(riid, &IID_IXAccessibilityImpl2)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}
static HRESULT WINAPI xacc_CCGetProps(void *iface, void *props)
{
    (void)iface;
    if (!props) return E_INVALIDARG;
    memset(props, 0, 28);
    return S_OK;
}
static HRESULT WINAPI xacc_HCGetMode(void *iface, uint32_t *mode)
{
    (void)iface;
    if (!mode) return E_INVALIDARG;
    *mode = 0; /* None */
    return S_OK;
}

static const void *const g_xacc_vtbl[23] = {
    (const void *)xacc_QueryInterface, (const void *)misc_AddRef, (const void *)misc_Release,
    (const void *)xacc_CCGetProps, (const void *)misc_Ok0, (const void *)xacc_HCGetMode,
    (const void *)misc_Ok0, (const void *)misc_Ok0, (const void *)misc_Ok0,
    (const void *)misc_NotImpl, (const void *)misc_Ok0, (const void *)misc_NotImpl,
    (const void *)misc_NotImpl, (const void *)misc_NotImpl, (const void *)misc_Ok0,
    (const void *)misc_NotImpl, (const void *)misc_NotImpl, (const void *)misc_Ok0,
    (const void *)misc_Ok0, (const void *)misc_Ok0, (const void *)misc_Ok0,
    (const void *)misc_NotImpl, (const void *)misc_NotImpl
};
static struct { const void *lpVtbl; } g_xacc_singleton = { g_xacc_vtbl };
HRESULT xgr_query_accessibility(REFIID iid, void **ppv) { return xacc_QueryInterface(&g_xacc_singleton, iid, ppv); }

/* AppCapture (19 slots) & AppCaptureMetadata (19 slots) */
static HRESULT WINAPI xcap_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXAppCaptureImpl) ||
        IsEqualGUID(riid, &IID_IXAppCaptureImpl2) || IsEqualGUID(riid, &IID_IXAppCaptureImpl3) ||
        IsEqualGUID(riid, &IID_IXAppCaptureImpl4)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}
static const void *const g_xcap_vtbl[19] = {
    (const void *)xcap_QueryInterface, (const void *)misc_AddRef, (const void *)misc_Release,
    (const void *)misc_NotImpl, (const void *)misc_NotImpl, (const void *)misc_NotImpl,
    (const void *)misc_NotImpl, (const void *)misc_NotImpl, (const void *)misc_NotImpl,
    (const void *)misc_Ok0, (const void *)misc_Ok0, (const void *)misc_NotImpl,
    (const void *)misc_NotImpl, (const void *)misc_NotImpl, (const void *)misc_NotImpl,
    (const void *)misc_NotImpl, (const void *)misc_NotImpl, (const void *)misc_NotImpl, (const void *)misc_NotImpl
};
static struct { const void *lpVtbl; } g_xcap_singleton = { g_xcap_vtbl };
HRESULT xgr_query_app_capture(REFIID iid, void **ppv) { return xcap_QueryInterface(&g_xcap_singleton, iid, ppv); }

static HRESULT WINAPI xcapm_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXAppCaptureMetadataImpl)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}
static BOOLEAN WINAPI xcapm_False(void *iface) { (void)iface; return FALSE; }
static BOOLEAN WINAPI xcapm_Unreg(void *iface, XTaskQueueRegistrationToken t, BOOLEAN w) { (void)iface; (void)t; (void)w; return TRUE; }
static HRESULT WINAPI xcapm_Reg(void *iface, XTaskQueueHandle q, void *c, void *cb, XTaskQueueRegistrationToken *t)
{
    (void)iface; (void)q; (void)c; (void)cb;
    if (t) t->token = InterlockedIncrement64((volatile LONGLONG *)&g_misc_reg_token);
    return S_OK;
}
static const void *const g_xcapm_vtbl[19] = {
    (const void *)xcapm_QueryInterface, (const void *)misc_AddRef, (const void *)misc_Release,
    (const void *)xcapm_False, (const void *)misc_NotImpl, (const void *)misc_NotImpl,
    (const void *)xcapm_Reg, (const void *)xcapm_Unreg,
    (const void *)misc_Ok0, (const void *)misc_Ok0, (const void *)misc_Ok0,
    (const void *)misc_Ok0, (const void *)misc_Ok0, (const void *)misc_Ok0,
    (const void *)misc_Ok0, (const void *)misc_Ok0, (const void *)misc_NotImpl,
    (const void *)xcapm_Reg, (const void *)xcapm_Unreg
};
static struct { const void *lpVtbl; } g_xcapm_singleton = { g_xcapm_vtbl };
HRESULT xgr_query_app_capture_metadata(REFIID iid, void **ppv) { return xcapm_QueryInterface(&g_xcapm_singleton, iid, ppv); }

/* GameProtocol (5 slots), GameActivation (6 slots), GameInvite (8 slots) */
static HRESULT WINAPI xprot_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXGameProtocolImpl)) { *ppv = iface; return S_OK; }
    *ppv = NULL; return E_NOINTERFACE;
}
static const void *const g_xprot_vtbl[5] = {
    (const void *)xprot_QueryInterface, (const void *)misc_AddRef, (const void *)misc_Release,
    (const void *)xcapm_Reg, (const void *)xcapm_Unreg
};
static struct { const void *lpVtbl; } g_xprot_singleton = { g_xprot_vtbl };
HRESULT xgr_query_game_protocol(REFIID iid, void **ppv) { return xprot_QueryInterface(&g_xprot_singleton, iid, ppv); }

static HRESULT WINAPI xact_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXGameActivationImpl)) { *ppv = iface; return S_OK; }
    *ppv = NULL; return E_NOINTERFACE;
}
static const void *const g_xact_vtbl[6] = {
    (const void *)xact_QueryInterface, (const void *)misc_AddRef, (const void *)misc_Release,
    (const void *)xcapm_Reg, (const void *)xcapm_Unreg, (const void *)misc_Ok0
};
static struct { const void *lpVtbl; } g_xact_singleton = { g_xact_vtbl };
HRESULT xgr_query_game_activation(REFIID iid, void **ppv) { return xact_QueryInterface(&g_xact_singleton, iid, ppv); }

static HRESULT WINAPI xinv_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXGameInviteImpl) || IsEqualGUID(riid, &IID_IXGameInviteImpl2)) {
        *ppv = iface; return S_OK;
    }
    *ppv = NULL; return E_NOINTERFACE;
}
static const void *const g_xinv_vtbl[8] = {
    (const void *)xinv_QueryInterface, (const void *)misc_AddRef, (const void *)misc_Release,
    (const void *)xcapm_Reg, (const void *)xcapm_Unreg,
    (const void *)xcapm_Reg, (const void *)xcapm_Unreg, (const void *)misc_Ok0
};
static struct { const void *lpVtbl; } g_xinv_singleton = { g_xinv_vtbl };
HRESULT xgr_query_game_invite(REFIID iid, void **ppv) { return xinv_QueryInterface(&g_xinv_singleton, iid, ppv); }

/* GameStreaming (35 slots — IsStreaming returns FALSE) */
static HRESULT WINAPI xstr_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXGameStreamingImpl) ||
        IsEqualGUID(riid, &IID_IXGameStreamingImpl2) || IsEqualGUID(riid, &IID_IXGameStreamingImpl3)) {
        *ppv = iface; return S_OK;
    }
    *ppv = NULL; return E_NOINTERFACE;
}
static void WINAPI xstr_Void(void *iface) { (void)iface; }
static uint32_t WINAPI xstr_Zero32(void *iface) { (void)iface; return 0; }
static SIZE_T WINAPI xstr_ZeroSz(void *iface) { (void)iface; return 0; }

static const void *const g_xstr_vtbl[35] = {
    (const void *)xstr_QueryInterface, (const void *)misc_AddRef, (const void *)misc_Release,
    (const void *)misc_Ok0,     /* 3: Initialize */
    (const void *)xstr_Void,    /* 4: Uninitialize */
    (const void *)xcapm_False,  /* 5: IsStreaming -> FALSE */
    (const void *)misc_Ok0,     /* 6 */
    (const void *)xcapm_False,  /* 7 */
    (const void *)misc_NotImpl, /* 8 */
    (const void *)xstr_Zero32,  /* 9: GetClientCount -> 0 */
    (const void *)misc_Ok0,     /* 10 */
    (const void *)xstr_Zero32,  /* 11 */
    (const void *)xcapm_Reg,    /* 12 */
    (const void *)xcapm_Unreg,  /* 13 */
    (const void *)misc_NotImpl, /* 14 */
    (const void *)xstr_ZeroSz,  /* 15 */
    (const void *)misc_NotImpl, /* 16 */
    (const void *)xstr_Void,    /* 17 */
    (const void *)xstr_Void,    /* 18 */
    (const void *)xstr_Void,    /* 19 */
    (const void *)xstr_Void,    /* 20 */
    (const void *)misc_NotImpl, /* 21 */
    (const void *)misc_NotImpl, /* 22 */
    (const void *)misc_NotImpl, /* 23 */
    (const void *)misc_NotImpl, /* 24 */
    (const void *)misc_Ok0,     /* 25 */
    (const void *)misc_Ok0,     /* 26 */
    (const void *)misc_Ok0,     /* 27 */
    (const void *)misc_Ok0,     /* 28 */
    (const void *)xstr_ZeroSz,  /* 29 */
    (const void *)misc_NotImpl, /* 30 */
    (const void *)misc_NotImpl, /* 31 */
    (const void *)misc_NotImpl, /* 32: Impl2 GetSessionId */
    (const void *)misc_NotImpl, /* 33: Impl3 GetDisplayDetails */
    (const void *)misc_Ok0      /* 34: Impl3 SetResolution */
};
static struct { const void *lpVtbl; } g_xstr_singleton = { g_xstr_vtbl };
HRESULT xgr_query_game_streaming(REFIID iid, void **ppv) { return xstr_QueryInterface(&g_xstr_singleton, iid, ppv); }

/* GameEvent (4 slots — telemetry write succeeds non-blockingly) */
static HRESULT WINAPI xevt_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXGameEventImpl)) { *ppv = iface; return S_OK; }
    *ppv = NULL; return E_NOINTERFACE;
}
static HRESULT WINAPI xevt_Write(void *iface, XUserHandle u, const char *scid, const char *psid, const char *ev, const char *dim, const char *meas)
{
    (void)iface; (void)u; (void)scid; (void)psid; (void)ev; (void)dim; (void)meas;
    return S_OK;
}
static const void *const g_xevt_vtbl[4] = {
    (const void *)xevt_QueryInterface, (const void *)misc_AddRef, (const void *)misc_Release,
    (const void *)xevt_Write
};
static struct { const void *lpVtbl; } g_xevt_singleton = { g_xevt_vtbl };
HRESULT xgr_query_game_event(REFIID iid, void **ppv) { return xevt_QueryInterface(&g_xevt_singleton, iid, ppv); }
