/*
 * One Launcher XGR Bridge — System, Networking, PLS, GameUI, Error, Display & Auxiliary Providers
 * Pure Win32 C11 — Zero WinRT / RoGetActivationFactory dependencies.
 */

#include "xgr_internal.h"

_Alignas(8) static volatile LONGLONG g_misc_reg_token = 1000;

static ULONG WINAPI misc_AddRef(void *iface) { (void)iface; return 2; }
static ULONG WINAPI misc_Release(void *iface) { (void)iface; return 1; }

static HRESULT CALLBACK misc_noop_async_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: xgr_async_complete(data->async, S_OK, 0); return S_OK;
        default: return S_OK;
    }
}

/* =========================================================================
 * 1. IXErrorImpl (6 slots, XErrorReport at slot 3)
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
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXErrorImpl)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static BOOL WINAPI xerr_Report(void *iface, HRESULT error, const char *message)
{
    (void)iface;
    return xgr_invoke_error_report(error, message);
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

typedef struct IXErrorImplVtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    BOOL    (WINAPI *XErrorReport)(void *iface, HRESULT error, const char *message);
    void    (WINAPI *XErrorSetCallback)(void *iface, XErrorCallback *cb, void *ctx);
    void    (WINAPI *XErrorSetOptions)(void *iface, uint32_t dbg, uint32_t nodbg);
} IXErrorImplVtbl;
_Static_assert(sizeof(IXErrorImplVtbl) == 6 * sizeof(void *), "IXErrorImplVtbl must have 6 slots");

static const IXErrorImplVtbl g_xerror_vtbl = {
    xerr_QueryInterface,
    misc_AddRef,
    misc_Release,
    xerr_Report,
    xerr_SetCallback,
    xerr_SetOptions
};
static struct { const IXErrorImplVtbl *lpVtbl; } g_xerror_singleton = { &g_xerror_vtbl };

HRESULT xgr_query_error(REFIID iid, void **ppv)
{
    return xerr_QueryInterface(&g_xerror_singleton, iid, ppv);
}

/* =========================================================================
 * 2. IXDisplayImpl (5 slots) & IXLauncherImpl (6 slots)
 * ========================================================================= */

static HRESULT WINAPI xdisp_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXDisplayImpl)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static HRESULT WINAPI xdisp_ReservedSlot3(void *iface, void **out)
{
    (void)iface;
    if (out) *out = NULL;
    return E_NOTIMPL;
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

typedef struct IXDisplayImplVtbl {
    HRESULT  (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG    (WINAPI *AddRef)(void *iface);
    ULONG    (WINAPI *Release)(void *iface);
    HRESULT  (WINAPI *ReservedSlot3)(void *iface, void **out);
    uint32_t (WINAPI *XDisplayTryEnableHdrMode)(void *iface, uint32_t pref, float *hdrInfo);
} IXDisplayImplVtbl;
_Static_assert(sizeof(IXDisplayImplVtbl) == 5 * sizeof(void *), "IXDisplayImplVtbl must have 5 slots");

static const IXDisplayImplVtbl g_xdisplay_vtbl = {
    xdisp_QueryInterface,
    misc_AddRef,
    misc_Release,
    xdisp_ReservedSlot3,
    xdisp_TryEnableHdrMode
};
static struct { const IXDisplayImplVtbl *lpVtbl; } g_xdisplay_singleton = { &g_xdisplay_vtbl };

HRESULT xgr_query_display(REFIID iid, void **ppv)
{
    return xdisp_QueryInterface(&g_xdisplay_singleton, iid, ppv);
}

static HRESULT WINAPI xlnch_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
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

typedef struct IXLauncherImplVtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    HRESULT (WINAPI *XLaunchUri)(void *iface, XUserHandle user, const char *uri);
    HRESULT (WINAPI *XDisplayAcquireTimeoutDeferral)(void *iface, void **handle);
    void    (WINAPI *XDisplayCloseTimeoutDeferralHandle)(void *iface, void *handle);
} IXLauncherImplVtbl;
_Static_assert(sizeof(IXLauncherImplVtbl) == 6 * sizeof(void *), "IXLauncherImplVtbl must have 6 slots");

static const IXLauncherImplVtbl g_xlauncher_vtbl = {
    xlnch_QueryInterface,
    misc_AddRef,
    misc_Release,
    xlnch_LaunchUri,
    xlnch_AcquireTimeoutDeferral,
    xlnch_CloseTimeoutDeferral
};
static struct { const IXLauncherImplVtbl *lpVtbl; } g_xlauncher_singleton = { &g_xlauncher_vtbl };

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
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
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

typedef struct IXGameImpl3Vtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    HRESULT (WINAPI *XGameGetXboxTitleId)(void *iface, uint32_t *titleId);
    void    (WINAPI *XLaunchNewGame)(void *iface, const char *exe, const char *args, XUserHandle u);
    HRESULT (WINAPI *XLaunchRestartOnCrash)(void *iface, const char *args, uint32_t res);
} IXGameImpl3Vtbl;
_Static_assert(sizeof(IXGameImpl3Vtbl) == 6 * sizeof(void *), "IXGameImpl3Vtbl must have 6 slots");

static const IXGameImpl3Vtbl g_xgame_vtbl = {
    xgame_QueryInterface,
    misc_AddRef,
    misc_Release,
    xgame_GetXboxTitleId,
    xgame_LaunchNewGame,
    xgame_RestartOnCrash
};
static struct { const IXGameImpl3Vtbl *lpVtbl; } g_xgame_singleton = { &g_xgame_vtbl };

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
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
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

#if defined(__GNUC__) || defined(__clang__)
__attribute__((used))
#endif
static const char g_xgr_default_sandbox_id[] = "RETAIL";

static HRESULT WINAPI xsys_GetXboxLiveSandboxId(void *iface, SIZE_T sz, char *out, SIZE_T *used)
{
    (void)iface;
    volatile const char *sbid = g_xgr_default_sandbox_id;
    const SIZE_T need = 7; /* strlen("RETAIL") + 1; XSystemXboxLiveSandboxIdMaxBytes == 16 */
    if (used) *used = need;
    if (!out) return xgr_return_hr(E_POINTER);
    if (sz < need) return xgr_return_hr(HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER));
    for (SIZE_T i = 0; i < need; i++) out[i] = sbid[i];
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

typedef struct IXSystemImpl5Vtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    HRESULT (WINAPI *XSystemGetConsoleId)(void *iface, SIZE_T sz, char *out, SIZE_T *used);
    HRESULT (WINAPI *XSystemGetXboxLiveSandboxId)(void *iface, SIZE_T sz, char *out, SIZE_T *used);
    HRESULT (WINAPI *XSystemGetAppSpecificDeviceId)(void *iface, SIZE_T sz, char *out, SIZE_T *used);
    HRESULT (WINAPI *XSystemHandleTrack)(void *iface, void *cb, void *ctx);
    BOOLEAN (WINAPI *XSystemIsHandleValid)(void *iface, void *handle);
    void    (WINAPI *XSystemAllowFullDownloadBandwidth)(void *iface, BOOLEAN enable);
} IXSystemImpl5Vtbl;
_Static_assert(sizeof(IXSystemImpl5Vtbl) == 9 * sizeof(void *), "IXSystemImpl5Vtbl must have 9 slots");

static const IXSystemImpl5Vtbl g_xsystem_vtbl = {
    xsys_QueryInterface,
    misc_AddRef,
    misc_Release,
    xsys_GetConsoleId,
    xsys_GetXboxLiveSandboxId,
    xsys_GetAppSpecificDeviceId,
    xsys_HandleTrack,
    xsys_IsHandleValid,
    xsys_AllowFullDownloadBandwidth
};
static struct { const IXSystemImpl5Vtbl *lpVtbl; } g_xsystem_singleton = { &g_xsystem_vtbl };

HRESULT xgr_query_system(REFIID iid, void **ppv)
{
    return xsys_QueryInterface(&g_xsystem_singleton, iid, ppv);
}

static HRESULT WINAPI xsysa_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
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

typedef struct IXSystemAnalyticsImplVtbl {
    HRESULT               (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG                 (WINAPI *AddRef)(void *iface);
    ULONG                 (WINAPI *Release)(void *iface);
    XSystemAnalyticsInfo *(WINAPI *XSystemGetAnalyticsInfo)(void *iface, XSystemAnalyticsInfo *ret);
} IXSystemAnalyticsImplVtbl;
_Static_assert(sizeof(IXSystemAnalyticsImplVtbl) == 4 * sizeof(void *), "IXSystemAnalyticsImplVtbl must have 4 slots");

static const IXSystemAnalyticsImplVtbl g_xsystem_analytics_vtbl = {
    xsysa_QueryInterface,
    misc_AddRef,
    misc_Release,
    xsysa_GetAnalyticsInfo
};
static struct { const IXSystemAnalyticsImplVtbl *lpVtbl; } g_xsystem_analytics_singleton = { &g_xsystem_analytics_vtbl };

HRESULT xgr_query_system_analytics(REFIID iid, void **ppv)
{
    return xsysa_QueryInterface(&g_xsystem_analytics_singleton, iid, ppv);
}

/* =========================================================================
 * 5. IXPersistentLocalStorageImpl3 (9 slots)
 * ========================================================================= */

static void resolve_pls_path_utf8(char *out_utf8, size_t out_sz)
{
    if (!out_utf8 || out_sz == 0) return;
    out_utf8[0] = '\0';
    if (out_sz < 2) return;

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

    const char *pfn = (cfg.packageFamilyName[0] && xgr_is_safe_path_segment(cfg.packageFamilyName, 192))
        ? cfg.packageFamilyName
        : "OneLauncher.XboxGame_8wekyb3d8bbwe";
    wchar_t pfn_w[256] = { 0 };
    if (MultiByteToWideChar(CP_UTF8, 0, pfn, -1, pfn_w, 255) <= 0 || !pfn_w[0]) {
        wcscpy(pfn_w, L"OneLauncher.XboxGame_8wekyb3d8bbwe");
    }

    wchar_t pls_w[MAX_PATH * 2] = { 0 };
    int wn = swprintf(
        pls_w,
        sizeof(pls_w) / sizeof(pls_w[0]),
        L"%ls\\Packages\\%ls\\LocalState\\PersistentLocalStorage",
        local_app,
        pfn_w
    );
    if (wn <= 0 || (size_t)wn >= sizeof(pls_w) / sizeof(pls_w[0])) {
        return;
    }

    /* Ensure directory hierarchy exists (safe for short, drive, UNC, or POSIX paths) */
    size_t len_w = wcslen(pls_w);
    size_t start = 0;
    if (len_w >= 3 && pls_w[1] == L':' && (pls_w[2] == L'\\' || pls_w[2] == L'/')) {
        start = 3;
    } else if (len_w >= 1 && (pls_w[0] == L'\\' || pls_w[0] == L'/')) {
        start = 1;
    }
    for (size_t i = start; i < len_w; i++) {
        if (pls_w[i] == L'\\' || pls_w[i] == L'/') {
            wchar_t saved = pls_w[i];
            pls_w[i] = L'\0';
            if (pls_w[0]) CreateDirectoryW(pls_w, NULL);
            pls_w[i] = saved;
        }
    }
    CreateDirectoryW(pls_w, NULL);

    int cap = (out_sz - 1 > (size_t)INT_MAX) ? INT_MAX : (int)(out_sz - 1);
    int u8 = WideCharToMultiByte(CP_UTF8, 0, pls_w, -1, out_utf8, cap, NULL, NULL);
    if (u8 <= 0) {
        out_utf8[0] = '\0';
    } else {
        out_utf8[out_sz - 1] = '\0';
    }
}

static HRESULT WINAPI xpls_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
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

typedef struct IXPersistentLocalStorageImpl3Vtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    HRESULT (WINAPI *XPersistentLocalStorageGetPathSize)(void *iface, SIZE_T *pathSize);
    HRESULT (WINAPI *XPersistentLocalStorageGetPath)(void *iface, SIZE_T pathSize, char *path, SIZE_T *pathUsed);
    HRESULT (WINAPI *XPersistentLocalStorageGetSpaceInfo)(void *iface, uint64_t *info4);
    HRESULT (WINAPI *XPersistentLocalStoragePromptUserForSpaceAsync)(void *iface, uint64_t bytes, XAsyncBlock *ab);
    HRESULT (WINAPI *XPersistentLocalStoragePromptUserForSpaceResult)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *XPersistentLocalStorageMountForPackage)(void *iface, const char *pkgId, XPackageMountHandle *mount);
} IXPersistentLocalStorageImpl3Vtbl;
_Static_assert(sizeof(IXPersistentLocalStorageImpl3Vtbl) == 9 * sizeof(void *), "IXPersistentLocalStorageImpl3Vtbl must have 9 slots");

static const IXPersistentLocalStorageImpl3Vtbl g_xpls_vtbl = {
    xpls_QueryInterface,
    misc_AddRef,
    misc_Release,
    xpls_GetPathSize,
    xpls_GetPath,
    xpls_GetSpaceInfo,
    xpls_PromptSpaceAsync,
    xpls_PromptSpaceResult,
    xpls_MountForPackage
};
static struct { const IXPersistentLocalStorageImpl3Vtbl *lpVtbl; } g_xpls_singleton = { &g_xpls_vtbl };

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

#define XGR_MAX_NET_HINT_SLOTS 32

struct net_hint_slot {
    bool in_use;
    bool unregistering;
    uint64_t token;
    XNetworkingConnectivityHintChangedCallback *cb;
    void *ctx;
    int32_t in_flight;
    DWORD running_tid;
};

struct net_hint_task {
    uint64_t token;
};

static INIT_ONCE g_net_hint_once = INIT_ONCE_STATIC_INIT;
static CRITICAL_SECTION g_net_hint_cs;
static CONDITION_VARIABLE g_net_hint_cv;
static struct net_hint_slot g_net_hint_slots[XGR_MAX_NET_HINT_SLOTS];

static BOOL CALLBACK net_hint_sync_init_fn(PINIT_ONCE once, PVOID param, PVOID *ctx)
{
    (void)once; (void)param; (void)ctx;
    InitializeCriticalSection(&g_net_hint_cs);
    InitializeConditionVariable(&g_net_hint_cv);
    return TRUE;
}

static void net_hint_ensure_sync(void)
{
    InitOnceExecuteOnce(&g_net_hint_once, net_hint_sync_init_fn, NULL, NULL);
}

static void CALLBACK fire_initial_net_hint_cb(void *context, bool canceled)
{
    struct net_hint_task *t = (struct net_hint_task *)context;
    if (!t) return;
    if (!canceled) {
        net_hint_ensure_sync();
        XNetworkingConnectivityHintChangedCallback *cb = NULL;
        void *cb_ctx = NULL;
        size_t slot_idx = XGR_MAX_NET_HINT_SLOTS;

        EnterCriticalSection(&g_net_hint_cs);
        for (size_t i = 0; i < XGR_MAX_NET_HINT_SLOTS; i++) {
            if (g_net_hint_slots[i].in_use &&
                !g_net_hint_slots[i].unregistering &&
                g_net_hint_slots[i].token == t->token) {
                cb = g_net_hint_slots[i].cb;
                cb_ctx = g_net_hint_slots[i].ctx;
                g_net_hint_slots[i].in_flight++;
                g_net_hint_slots[i].running_tid = GetCurrentThreadId();
                slot_idx = i;
                break;
            }
        }
        LeaveCriticalSection(&g_net_hint_cs);

        if (cb) {
            XNetworkingConnectivityHint hint;
            fill_online_hint(&hint);
            cb(cb_ctx, &hint);
        }

        if (slot_idx < XGR_MAX_NET_HINT_SLOTS) {
            EnterCriticalSection(&g_net_hint_cs);
            g_net_hint_slots[slot_idx].in_flight--;
            if (g_net_hint_slots[slot_idx].in_flight <= 0) {
                g_net_hint_slots[slot_idx].in_flight = 0;
                g_net_hint_slots[slot_idx].running_tid = 0;
                if (g_net_hint_slots[slot_idx].unregistering) {
                    memset(&g_net_hint_slots[slot_idx], 0, sizeof(g_net_hint_slots[slot_idx]));
                }
                WakeAllConditionVariable(&g_net_hint_cv);
            }
            LeaveCriticalSection(&g_net_hint_cs);
        }
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
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
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
    tok->token = (uint64_t)InterlockedIncrement64(&g_misc_reg_token);
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

static HRESULT WINAPI xnet_QuerySecUrlResultSize(void *iface, XAsyncBlock *ab, size_t *sz)
{
    (void)iface;
    return xgr_async_get_result_size(ab, sz);
}

static HRESULT WINAPI xnet_QuerySecUrlResult(void *iface, XAsyncBlock *ab, size_t sz, size_t *used, uint8_t *buf, void **ptrOut)
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

    net_hint_ensure_sync();
    uint64_t token_val = (uint64_t)InterlockedIncrement64(&g_misc_reg_token);
    bool stored = false;

    EnterCriticalSection(&g_net_hint_cs);
    for (size_t i = 0; i < XGR_MAX_NET_HINT_SLOTS; i++) {
        if (!g_net_hint_slots[i].in_use) {
            memset(&g_net_hint_slots[i], 0, sizeof(g_net_hint_slots[i]));
            g_net_hint_slots[i].in_use = true;
            g_net_hint_slots[i].token = token_val;
            g_net_hint_slots[i].cb = cb;
            g_net_hint_slots[i].ctx = ctx;
            stored = true;
            break;
        }
    }
    LeaveCriticalSection(&g_net_hint_cs);

    if (!stored) return xgr_return_hr(E_OUTOFMEMORY);
    tok->token = token_val;

    XTaskQueueHandle target_q = queue;
    bool close_q = false;
    if (!target_q) {
        if (xgr_task_queue_get_process(&target_q) && target_q) {
            close_q = true;
        }
    }

    struct net_hint_task *t = (struct net_hint_task *)malloc(sizeof(*t));
    if (t) {
        t->token = token_val;
        if (!target_q || FAILED(xgr_task_queue_submit_delayed(target_q, XTaskQueuePort_Completion, 0, t, fire_initial_net_hint_cb))) {
            fire_initial_net_hint_cb(t, false);
        }
    }
    if (close_q && target_q) xgr_task_queue_close(target_q);
    return xgr_return_hr(S_OK);
}

static BOOLEAN WINAPI xnet_UnregConnectivityHintChanged(void *iface, XTaskQueueRegistrationToken tok, BOOLEAN wait)
{
    (void)iface;
    net_hint_ensure_sync();
    DWORD self_tid = GetCurrentThreadId();
    BOOLEAN result = TRUE;

    EnterCriticalSection(&g_net_hint_cs);
    for (size_t i = 0; i < XGR_MAX_NET_HINT_SLOTS; i++) {
        if (g_net_hint_slots[i].in_use && g_net_hint_slots[i].token == tok.token) {
            g_net_hint_slots[i].unregistering = true;
            if (g_net_hint_slots[i].in_flight > 0) {
                if (!wait || g_net_hint_slots[i].running_tid == self_tid) {
                    result = FALSE;
                } else {
                    while (g_net_hint_slots[i].in_use &&
                           g_net_hint_slots[i].token == tok.token &&
                           g_net_hint_slots[i].in_flight > 0) {
                        SleepConditionVariableCS(&g_net_hint_cv, &g_net_hint_cs, 50);
                    }
                    result = TRUE;
                }
            } else {
                memset(&g_net_hint_slots[i], 0, sizeof(g_net_hint_slots[i]));
                result = TRUE;
            }
            break;
        }
    }
    LeaveCriticalSection(&g_net_hint_cs);
    return result;
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

typedef struct IXNetworkingImpl2Vtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    HRESULT (WINAPI *XNetworkingQueryPreferredLocalUdpMultiplayerPort)(void *iface, uint16_t *port);
    HRESULT (WINAPI *XNetworkingQueryPreferredLocalUdpMultiplayerPortAsync)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *XNetworkingQueryPreferredLocalUdpMultiplayerPortResult)(void *iface, XAsyncBlock *ab, uint16_t *port);
    HRESULT (WINAPI *XNetworkingRegisterPreferredLocalUdpMultiplayerPortChanged)(void *iface, XTaskQueueHandle q, void *ctx, void *cb, XTaskQueueRegistrationToken *tok);
    BOOLEAN (WINAPI *XNetworkingUnregisterPreferredLocalUdpMultiplayerPortChanged)(void *iface, XTaskQueueRegistrationToken tok, BOOLEAN wait);
    HRESULT (WINAPI *XNetworkingQuerySecurityInformationForUrlAsync)(void *iface, const void *url, XAsyncBlock *ab);
    HRESULT (WINAPI *XNetworkingQuerySecurityInformationForUrlResultSize)(void *iface, XAsyncBlock *ab, size_t *sz);
    HRESULT (WINAPI *XNetworkingQuerySecurityInformationForUrlResult)(void *iface, XAsyncBlock *ab, size_t sz, size_t *used, uint8_t *buf, void **ptrOut);
    HRESULT (WINAPI *XNetworkingQuerySecurityInformationForUrlUtf16Async)(void *iface, const void *url, XAsyncBlock *ab);
    HRESULT (WINAPI *XNetworkingQuerySecurityInformationForUrlUtf16ResultSize)(void *iface, XAsyncBlock *ab, size_t *sz);
    HRESULT (WINAPI *XNetworkingQuerySecurityInformationForUrlUtf16Result)(void *iface, XAsyncBlock *ab, size_t sz, size_t *used, uint8_t *buf, void **ptrOut);
    HRESULT (WINAPI *XNetworkingVerifyServerCertificate)(void *iface, void *reqHandle, const void *secInfo);
    HRESULT (WINAPI *XNetworkingGetConnectivityHint)(void *iface, XNetworkingConnectivityHint *hint);
    HRESULT (WINAPI *XNetworkingRegisterConnectivityHintChanged)(void *iface, XTaskQueueHandle queue, void *ctx, XNetworkingConnectivityHintChangedCallback *cb, XTaskQueueRegistrationToken *tok);
    BOOLEAN (WINAPI *XNetworkingUnregisterConnectivityHintChanged)(void *iface, XTaskQueueRegistrationToken tok, BOOLEAN wait);
    HRESULT (WINAPI *XNetworkingQueryConfigurationSetting)(void *iface, uint32_t setting, uint64_t *val);
    HRESULT (WINAPI *XNetworkingSetConfigurationSetting)(void *iface, uint32_t setting, uint64_t val);
    HRESULT (WINAPI *XNetworkingQueryStatistics)(void *iface, uint32_t type, void *buf);
} IXNetworkingImpl2Vtbl;
_Static_assert(sizeof(IXNetworkingImpl2Vtbl) == 21 * sizeof(void *), "IXNetworkingImpl2Vtbl must have 21 slots");

static const IXNetworkingImpl2Vtbl g_xnetworking_vtbl = {
    xnet_QueryInterface,                /* 0 */
    misc_AddRef,                        /* 1 */
    misc_Release,                       /* 2 */
    xnet_QueryPrefPort,                 /* 3 */
    xnet_QueryPrefPortAsync,            /* 4 */
    xnet_QueryPrefPortResult,           /* 5 */
    xnet_RegPrefPortChanged,            /* 6 */
    xnet_UnregPrefPortChanged,          /* 7 */
    xnet_QuerySecUrlAsync,              /* 8 */
    xnet_QuerySecUrlResultSize,         /* 9 */
    xnet_QuerySecUrlResult,             /* 10 */
    xnet_QuerySecUrlAsync,              /* 11: Utf16 */
    xnet_QuerySecUrlResultSize,         /* 12: Utf16 */
    xnet_QuerySecUrlResult,             /* 13: Utf16 */
    xnet_VerifyServerCert,              /* 14 */
    xnet_GetConnectivityHint,           /* 15 */
    xnet_RegConnectivityHintChanged,    /* 16 */
    xnet_UnregConnectivityHintChanged,  /* 17 */
    xnet_QueryConfigSetting,            /* 18 */
    xnet_SetConfigSetting,              /* 19 */
    xnet_QueryStatistics                /* 20 */
};
static struct { const IXNetworkingImpl2Vtbl *lpVtbl; } g_xnetworking_singleton = { &g_xnetworking_vtbl };

HRESULT xgr_query_networking(REFIID iid, void **ppv)
{
    return xnet_QueryInterface(&g_xnetworking_singleton, iid, ppv);
}

/* =========================================================================
 * 7. IXGameUiImpl4 (51 slots — exact __stdcall arity per GDK vtable)
 * ========================================================================= */

static HRESULT WINAPI xui_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
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
static HRESULT WINAPI xui_ShowSendGameInviteAsync(void *iface, XAsyncBlock *ab, XUserHandle reqUser, const char *scid, const char *tmpl, const char *sessId, const char *invText, const char *customCtx)
{
    (void)iface; (void)reqUser; (void)scid; (void)tmpl; (void)sessId; (void)invText; (void)customCtx;
    return xgr_async_begin(ab, NULL, NULL, "XGameUiShowSendGameInviteAsync", misc_noop_async_provider);
}
static HRESULT WINAPI xui_GenericResult(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}
static HRESULT WINAPI xui_ShowPlayerProfileCardAsync(void *iface, XAsyncBlock *ab, XUserHandle reqUser, uint64_t targetPlayer)
{
    (void)iface; (void)reqUser; (void)targetPlayer;
    return xgr_async_begin(ab, NULL, NULL, "XGameUiShowPlayerProfileCardAsync", misc_noop_async_provider);
}
static HRESULT WINAPI xui_ShowAchievementsAsync(void *iface, XAsyncBlock *ab, XUserHandle reqUser, uint32_t titleId)
{
    (void)iface; (void)reqUser; (void)titleId;
    return xgr_async_begin(ab, NULL, NULL, "XGameUiShowAchievementsAsync", misc_noop_async_provider);
}
static HRESULT WINAPI xui_ShowPlayerPickerAsync(void *iface, XAsyncBlock *ab, XUserHandle reqUser, const char *promptText, uint32_t selectCount, const uint64_t *selectPlayers, uint32_t preCount, const uint64_t *prePlayers, uint32_t minSel, uint32_t maxSel)
{
    (void)iface; (void)reqUser; (void)promptText; (void)selectCount; (void)selectPlayers;
    (void)preCount; (void)prePlayers; (void)minSel; (void)maxSel;
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
    if ((size_t)cnt > SIZE_MAX / sizeof(uint64_t)) return E_INVALIDARG;
    size_t used_bytes = 0;
    HRESULT hr = xgr_async_get_result(ab, (const void *)xui_ShowPlayerPickerAsync, (size_t)cnt * sizeof(uint64_t), players, &used_bytes);
    if (used) *used = SUCCEEDED(hr) ? (uint32_t)(used_bytes / sizeof(uint64_t)) : 0;
    return hr;
}
static HRESULT WINAPI xui_ShowErrorDialogAsync(void *iface, XAsyncBlock *ab, HRESULT errorCode, const char *context)
{
    (void)iface; (void)errorCode; (void)context;
    return xgr_async_begin(ab, NULL, NULL, "XGameUiShowErrorDialogAsync", misc_noop_async_provider);
}
static HRESULT WINAPI xui_SetNotificationPositionHint(void *iface, uint32_t position)
{
    (void)iface; (void)position;
    return S_OK;
}
static HRESULT WINAPI xui_ShowTextEntryAsync(void *iface, XAsyncBlock *ab, const char *titleText, const char *descriptionText, const char *defaultText, uint32_t inputScope, uint32_t maxTextLength)
{
    (void)iface; (void)titleText; (void)descriptionText; (void)defaultText; (void)inputScope; (void)maxTextLength;
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
static HRESULT WINAPI xui_ReservedNotImpl2(void *iface, XAsyncBlock *ab)
{
    (void)iface; (void)ab;
    return E_NOTIMPL;
}
static HRESULT WINAPI xui_ShowWebAuthAsync(void *iface, XAsyncBlock *ab, XUserHandle reqUser, const char *reqUri, const char *compUri)
{
    (void)iface; (void)ab; (void)reqUser; (void)reqUri; (void)compUri;
    return E_ABORT;
}
static HRESULT WINAPI xui_ShowWebAuthResultSize(void *iface, XAsyncBlock *ab, size_t *bufferSize)
{
    (void)iface; (void)ab;
    if (bufferSize) *bufferSize = 0;
    return E_NOTIMPL;
}
static HRESULT WINAPI xui_ShowWebAuthResult(void *iface, XAsyncBlock *ab, size_t bufferSize, void *buffer, void **ptrToBuffer, size_t *bufferUsed)
{
    (void)iface; (void)ab; (void)bufferSize; (void)buffer;
    if (ptrToBuffer) *ptrToBuffer = NULL;
    if (bufferUsed) *bufferUsed = 0;
    return E_NOTIMPL;
}
static HRESULT WINAPI xui_ShowWebAuthWithOptionsAsync(void *iface, XAsyncBlock *ab, XUserHandle reqUser, const char *reqUri, const char *compUri, uint32_t options)
{
    (void)iface; (void)ab; (void)reqUser; (void)reqUri; (void)compUri; (void)options;
    return E_ABORT;
}
static HRESULT WINAPI xui_ShowMultiplayerActivityGameInviteAsync(void *iface, XAsyncBlock *ab, XUserHandle reqUser)
{
    (void)iface; (void)reqUser;
    return xgr_async_begin(ab, NULL, NULL, "XGameUiShowMultiplayerActivityGameInviteAsync", misc_noop_async_provider);
}
static HRESULT WINAPI xui_TextEntryOpen(void *iface, const void *options, uint32_t maxLength, const char *initialText, uint32_t initialCursorIndex, void **handle)
{
    (void)iface; (void)options; (void)maxLength; (void)initialText; (void)initialCursorIndex;
    if (handle) *handle = NULL;
    return E_NOTIMPL;
}
static void WINAPI xui_TextEntryClose(void *iface, void *handle)
{
    (void)iface; (void)handle;
}
static HRESULT WINAPI xui_TextEntryGetState(void *iface, void *handle, uint32_t *changeType, uint32_t *cursorIndex, uint32_t *imeStart, uint32_t *imeEnd, uint32_t bufferSize, char *buffer, uint32_t *bufferUsed)
{
    (void)iface; (void)handle; (void)bufferSize; (void)buffer;
    if (changeType) *changeType = 0;
    if (cursorIndex) *cursorIndex = 0;
    if (imeStart) *imeStart = 0;
    if (imeEnd) *imeEnd = 0;
    if (bufferUsed) *bufferUsed = 0;
    return E_NOTIMPL;
}
static HRESULT WINAPI xui_TextEntryGetExtents(void *iface, void *handle, void *extents)
{
    (void)iface; (void)handle; (void)extents;
    return E_NOTIMPL;
}
static HRESULT WINAPI xui_TextEntryUpdatePositionHint(void *iface, void *handle, uint32_t positionHint)
{
    (void)iface; (void)handle; (void)positionHint;
    return S_OK;
}
static HRESULT WINAPI xui_TextEntryUpdateVisibility(void *iface, void *handle, uint32_t visibilityFlags)
{
    (void)iface; (void)handle; (void)visibilityFlags;
    return S_OK;
}
static HRESULT WINAPI xui_ShowStateShareAsync(void *iface, XAsyncBlock *ab, XUserHandle reqUser, const char *linkToken)
{
    (void)iface; (void)reqUser; (void)linkToken;
    return xgr_async_begin(ab, NULL, NULL, "XGameUiShowStateShareAsync", misc_noop_async_provider);
}
static HRESULT WINAPI xui_SetUiCallbacks(void *iface, const void *callbacks, BOOLEAN useSystemUiIfAvailable)
{
    (void)iface; (void)callbacks; (void)useSystemUiIfAvailable;
    return S_OK;
}
static HRESULT WINAPI xui_SetMessageDialogUiResponse(void *iface, void *cbHandle, uint32_t response)
{
    (void)iface; (void)cbHandle; (void)response;
    return S_OK;
}
static HRESULT WINAPI xui_SetSimpleUiResponse(void *iface, void *cbHandle)
{
    (void)iface; (void)cbHandle;
    return S_OK;
}
static HRESULT WINAPI xui_SetTextEntryUiResponse(void *iface, void *cbHandle, const char *response)
{
    (void)iface; (void)cbHandle; (void)response;
    return S_OK;
}
static HRESULT WINAPI xui_SetPlayerPickerUiResponse(void *iface, void *cbHandle, uint32_t count, const uint64_t *players)
{
    (void)iface; (void)cbHandle; (void)count; (void)players;
    return S_OK;
}

typedef struct IXGameUiImpl4Vtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    HRESULT (WINAPI *XGameUiShowMessageDialogAsync)(void *iface, XAsyncBlock *ab, const char *t, const char *c, const char *b1, const char *b2, const char *b3, uint32_t defB, uint32_t canB);
    HRESULT (WINAPI *XGameUiShowMessageDialogResult)(void *iface, XAsyncBlock *ab, uint32_t *btn);
    HRESULT (WINAPI *XGameUiShowSendGameInviteAsync)(void *iface, XAsyncBlock *ab, XUserHandle reqUser, const char *scid, const char *tmpl, const char *sessId, const char *invText, const char *customCtx);
    HRESULT (WINAPI *XGameUiShowSendGameInviteResult)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *XGameUiShowPlayerProfileCardAsync)(void *iface, XAsyncBlock *ab, XUserHandle reqUser, uint64_t targetPlayer);
    HRESULT (WINAPI *XGameUiShowPlayerProfileCardResult)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *XGameUiShowAchievementsAsync)(void *iface, XAsyncBlock *ab, XUserHandle reqUser, uint32_t titleId);
    HRESULT (WINAPI *XGameUiShowAchievementsResult)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *XGameUiShowPlayerPickerAsync)(void *iface, XAsyncBlock *ab, XUserHandle reqUser, const char *promptText, uint32_t selectCount, const uint64_t *selectPlayers, uint32_t preCount, const uint64_t *prePlayers, uint32_t minSel, uint32_t maxSel);
    HRESULT (WINAPI *XGameUiShowPlayerPickerResultCount)(void *iface, XAsyncBlock *ab, uint32_t *cnt);
    HRESULT (WINAPI *XGameUiShowPlayerPickerResult)(void *iface, XAsyncBlock *ab, uint32_t cnt, uint64_t *players, uint32_t *used);
    HRESULT (WINAPI *XGameUiShowErrorDialogAsync)(void *iface, XAsyncBlock *ab, HRESULT errorCode, const char *context);
    HRESULT (WINAPI *XGameUiShowErrorDialogResult)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *XGameUiSetNotificationPositionHint)(void *iface, uint32_t position);
    HRESULT (WINAPI *XGameUiShowTextEntryAsync)(void *iface, XAsyncBlock *ab, const char *titleText, const char *descriptionText, const char *defaultText, uint32_t inputScope, uint32_t maxTextLength);
    HRESULT (WINAPI *XGameUiShowTextEntryResultSize)(void *iface, XAsyncBlock *ab, uint32_t *sz);
    HRESULT (WINAPI *XGameUiShowTextEntryResult)(void *iface, XAsyncBlock *ab, uint32_t sz, char *buf, uint32_t *used);
    HRESULT (WINAPI *ReservedSlot20)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *ReservedSlot21)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *ReservedSlot22)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *ReservedSlot23)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *XGameUiShowWebAuthenticationAsync)(void *iface, XAsyncBlock *ab, XUserHandle reqUser, const char *reqUri, const char *compUri);
    HRESULT (WINAPI *XGameUiShowWebAuthenticationResultSize)(void *iface, XAsyncBlock *ab, size_t *bufferSize);
    HRESULT (WINAPI *XGameUiShowWebAuthenticationResult)(void *iface, XAsyncBlock *ab, size_t bufferSize, void *buffer, void **ptrToBuffer, size_t *bufferUsed);
    HRESULT (WINAPI *XGameUiShowWebAuthenticationWithOptionsAsync)(void *iface, XAsyncBlock *ab, XUserHandle reqUser, const char *reqUri, const char *compUri, uint32_t options);
    HRESULT (WINAPI *ReservedSlot28)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *ReservedSlot29)(void *iface, XAsyncBlock *ab);
    /* IXGameUiImpl2 */
    HRESULT (WINAPI *XGameUiShowMultiplayerActivityGameInviteAsync)(void *iface, XAsyncBlock *ab, XUserHandle reqUser);
    HRESULT (WINAPI *XGameUiShowMultiplayerActivityGameInviteResult)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *ReservedSlot32)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *ReservedSlot33)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *XGameUiTextEntryOpen)(void *iface, const void *options, uint32_t maxLength, const char *initialText, uint32_t initialCursorIndex, void **handle);
    void    (WINAPI *XGameUiTextEntryClose)(void *iface, void *handle);
    HRESULT (WINAPI *XGameUiTextEntryGetState)(void *iface, void *handle, uint32_t *changeType, uint32_t *cursorIndex, uint32_t *imeStart, uint32_t *imeEnd, uint32_t bufferSize, char *buffer, uint32_t *bufferUsed);
    HRESULT (WINAPI *XGameUiTextEntryGetExtents)(void *iface, void *handle, void *extents);
    HRESULT (WINAPI *XGameUiTextEntryUpdatePositionHint)(void *iface, void *handle, uint32_t positionHint);
    HRESULT (WINAPI *XGameUiTextEntryUpdateVisibility)(void *iface, void *handle, uint32_t visibilityFlags);
    /* IXGameUiImpl3 */
    HRESULT (WINAPI *XGameUiShowStateShareAsync)(void *iface, XAsyncBlock *ab, XUserHandle reqUser, const char *linkToken);
    HRESULT (WINAPI *XGameUiShowStateShareResult)(void *iface, XAsyncBlock *ab);
    /* IXGameUiImpl4 */
    HRESULT (WINAPI *XGameUiSetUiCallbacks)(void *iface, const void *callbacks, BOOLEAN useSystemUiIfAvailable);
    HRESULT (WINAPI *XGameUiSetMessageDialogUiResponse)(void *iface, void *cbHandle, uint32_t response);
    HRESULT (WINAPI *XGameUiSetErrorDialogUiResponse)(void *iface, void *cbHandle);
    HRESULT (WINAPI *XGameUiSetTextEntryUiResponse)(void *iface, void *cbHandle, const char *response);
    HRESULT (WINAPI *XGameUiSetPlayerPickerUiResponse)(void *iface, void *cbHandle, uint32_t count, const uint64_t *players);
    HRESULT (WINAPI *XGameUiSetPlayerProfileCardUiResponse)(void *iface, void *cbHandle);
    HRESULT (WINAPI *XGameUiSetSendGameInviteUiResponse)(void *iface, void *cbHandle);
    HRESULT (WINAPI *XGameUiSetAchievementsUiResponse)(void *iface, void *cbHandle);
    HRESULT (WINAPI *XGameUiSetMultiplayerActivityGameInviteUiResponse)(void *iface, void *cbHandle);
} IXGameUiImpl4Vtbl;
_Static_assert(sizeof(IXGameUiImpl4Vtbl) == 51 * sizeof(void *), "IXGameUiImpl4Vtbl must have 51 slots");

static const IXGameUiImpl4Vtbl g_xgameui4_vtbl = {
    xui_QueryInterface,                       /* 0 */
    misc_AddRef,                              /* 1 */
    misc_Release,                             /* 2 */
    xui_ShowMsgDlgAsync,                      /* 3 */
    xui_ShowMsgDlgResult,                     /* 4 */
    xui_ShowSendGameInviteAsync,              /* 5 */
    xui_GenericResult,                        /* 6 */
    xui_ShowPlayerProfileCardAsync,           /* 7 */
    xui_GenericResult,                        /* 8 */
    xui_ShowAchievementsAsync,                /* 9 */
    xui_GenericResult,                        /* 10 */
    xui_ShowPlayerPickerAsync,                /* 11 */
    xui_PlayerPickerCount,                    /* 12 */
    xui_PlayerPickerResult,                   /* 13 */
    xui_ShowErrorDialogAsync,                 /* 14 */
    xui_GenericResult,                        /* 15 */
    xui_SetNotificationPositionHint,          /* 16 */
    xui_ShowTextEntryAsync,                   /* 17 */
    xui_TextEntryResultSize,                  /* 18 */
    xui_TextEntryResult,                      /* 19 */
    xui_ReservedNotImpl2,                     /* 20: __PADDING__ */
    xui_ReservedNotImpl2,                     /* 21: __PADDING_2__ */
    xui_ReservedNotImpl2,                     /* 22: __PADDING_3__ */
    xui_ReservedNotImpl2,                     /* 23: __PADDING_4__ */
    xui_ShowWebAuthAsync,                     /* 24 */
    xui_ShowWebAuthResultSize,                /* 25 */
    xui_ShowWebAuthResult,                    /* 26 */
    xui_ShowWebAuthWithOptionsAsync,          /* 27 */
    xui_ReservedNotImpl2,                     /* 28: __PADDING_5__ */
    xui_ReservedNotImpl2,                     /* 29: __PADDING_6__ */
    /* IXGameUiImpl2 */
    xui_ShowMultiplayerActivityGameInviteAsync, /* 30 */
    xui_GenericResult,                        /* 31 */
    xui_ReservedNotImpl2,                     /* 32: __PADDING_7__ */
    xui_ReservedNotImpl2,                     /* 33: __PADDING_8__ */
    xui_TextEntryOpen,                        /* 34 */
    xui_TextEntryClose,                       /* 35 */
    xui_TextEntryGetState,                    /* 36 */
    xui_TextEntryGetExtents,                  /* 37 */
    xui_TextEntryUpdatePositionHint,          /* 38 */
    xui_TextEntryUpdateVisibility,            /* 39 */
    /* IXGameUiImpl3 */
    xui_ShowStateShareAsync,                  /* 40 */
    xui_GenericResult,                        /* 41 */
    /* IXGameUiImpl4 */
    xui_SetUiCallbacks,                       /* 42 */
    xui_SetMessageDialogUiResponse,           /* 43 */
    xui_SetSimpleUiResponse,                  /* 44 */
    xui_SetTextEntryUiResponse,               /* 45 */
    xui_SetPlayerPickerUiResponse,            /* 46 */
    xui_SetSimpleUiResponse,                  /* 47 */
    xui_SetSimpleUiResponse,                  /* 48 */
    xui_SetSimpleUiResponse,                  /* 49 */
    xui_SetSimpleUiResponse                   /* 50 */
};
static struct { const IXGameUiImpl4Vtbl *lpVtbl; } g_xgameui_singleton = { &g_xgameui4_vtbl };

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
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
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

typedef struct IXGameRuntimeFeatureImplVtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    BOOLEAN (WINAPI *XGameRuntimeIsFeatureAvailable)(void *iface, uint32_t feature);
} IXGameRuntimeFeatureImplVtbl;
_Static_assert(sizeof(IXGameRuntimeFeatureImplVtbl) == 4 * sizeof(void *), "IXGameRuntimeFeatureImplVtbl must have 4 slots");

static const IXGameRuntimeFeatureImplVtbl g_xfeat_vtbl = {
    xfeat_QueryInterface,
    misc_AddRef,
    misc_Release,
    xfeat_IsFeatureAvailable
};
static struct { const IXGameRuntimeFeatureImplVtbl *lpVtbl; } g_xfeat_singleton = { &g_xfeat_vtbl };

HRESULT xgr_query_runtime_feature(REFIID iid, void **ppv)
{
    return xfeat_QueryInterface(&g_xfeat_singleton, iid, ppv);
}

/* =========================================================================
 * 9. Auxiliary Non-Blocking Providers (Accessibility, AppCapture, Protocol,
 *    Activation, Invite, Streaming, Event — all strictly typed for x86!)
 * ========================================================================= */

/* Accessibility (23 slots) */
static HRESULT WINAPI xacc_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
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
static HRESULT WINAPI xacc_CCSetEnabled(void *iface, BOOLEAN enabled)
{
    (void)iface; (void)enabled;
    return S_OK;
}
static HRESULT WINAPI xacc_HCGetMode(void *iface, uint32_t *mode)
{
    (void)iface;
    if (!mode) return E_INVALIDARG;
    *mode = 0; /* None */
    return S_OK;
}
static HRESULT WINAPI xacc_SttSetPositionHint(void *iface, uint32_t position)
{
    (void)iface; (void)position;
    return S_OK;
}
static HRESULT WINAPI xacc_SttSendString(void *iface, const char *speakerName, const char *content, uint32_t type)
{
    (void)iface; (void)speakerName; (void)content; (void)type;
    return S_OK;
}
static HRESULT WINAPI xacc_SynthEnumVoices(void *iface, void *context, void *callback)
{
    (void)iface; (void)context; (void)callback;
    return S_OK;
}
static HRESULT WINAPI xacc_SynthCreate(void *iface, void **synthesizer)
{
    (void)iface;
    if (synthesizer) *synthesizer = NULL;
    return E_NOTIMPL;
}
static HRESULT WINAPI xacc_SynthCloseHandle(void *iface, void *synthesizer)
{
    (void)iface; (void)synthesizer;
    return S_OK;
}
static HRESULT WINAPI xacc_SynthSetDefaultVoice(void *iface, void *synthesizer)
{
    (void)iface; (void)synthesizer;
    return E_NOTIMPL;
}
static HRESULT WINAPI xacc_SynthSetCustomVoice(void *iface, void *synthesizer, const char *voiceId)
{
    (void)iface; (void)synthesizer; (void)voiceId;
    return E_NOTIMPL;
}
static HRESULT WINAPI xacc_SynthCreateStreamFromText(void *iface, void *synthesizer, const char *text, void **stream)
{
    (void)iface; (void)synthesizer; (void)text;
    if (stream) *stream = NULL;
    return E_NOTIMPL;
}
static HRESULT WINAPI xacc_SynthCloseStreamHandle(void *iface, void *stream)
{
    (void)iface; (void)stream;
    return S_OK;
}
static HRESULT WINAPI xacc_SynthGetStreamDataSize(void *iface, void *stream, size_t *bufferSize)
{
    (void)iface; (void)stream;
    if (bufferSize) *bufferSize = 0;
    return E_NOTIMPL;
}
static HRESULT WINAPI xacc_SynthGetStreamData(void *iface, void *stream, size_t bufferSize, void *buffer, size_t *bufferUsed)
{
    (void)iface; (void)stream; (void)bufferSize; (void)buffer;
    if (bufferUsed) *bufferUsed = 0;
    return E_NOTIMPL;
}
static HRESULT WINAPI xacc_SttBeginHypothesis(void *iface, const char *speakerName, const char *content, uint32_t type, uint32_t *hypothesisId)
{
    (void)iface; (void)speakerName; (void)content; (void)type;
    if (hypothesisId) *hypothesisId = 1;
    return S_OK;
}
static HRESULT WINAPI xacc_SttUpdateHypothesis(void *iface, uint32_t hypothesisId, const char *content)
{
    (void)iface; (void)hypothesisId; (void)content;
    return S_OK;
}
static HRESULT WINAPI xacc_SttFinalizeHypothesis(void *iface, uint32_t hypothesisId, const char *content)
{
    (void)iface; (void)hypothesisId; (void)content;
    return S_OK;
}
static HRESULT WINAPI xacc_SttCancelHypothesis(void *iface, uint32_t hypothesisId)
{
    (void)iface; (void)hypothesisId;
    return S_OK;
}
static HRESULT WINAPI xacc_SynthCreateStreamFromSsml(void *iface, void *synthesizer, const char *ssml, void **stream)
{
    (void)iface; (void)synthesizer; (void)ssml;
    if (stream) *stream = NULL;
    return E_NOTIMPL;
}
static HRESULT WINAPI xacc_SynthSetVolume(void *iface, void *synthesizer, float volume)
{
    (void)iface; (void)synthesizer; (void)volume;
    return E_NOTIMPL;
}

typedef struct IXAccessibilityImpl2Vtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    HRESULT (WINAPI *XClosedCaptionGetProperties)(void *iface, void *props);
    HRESULT (WINAPI *XClosedCaptionSetEnabled)(void *iface, BOOLEAN enabled);
    HRESULT (WINAPI *XHighContrastGetMode)(void *iface, uint32_t *mode);
    HRESULT (WINAPI *XSpeechToTextSetPositionHint)(void *iface, uint32_t position);
    HRESULT (WINAPI *XSpeechToTextSendString)(void *iface, const char *speakerName, const char *content, uint32_t type);
    HRESULT (WINAPI *XSpeechSynthesizerEnumerateInstalledVoices)(void *iface, void *context, void *callback);
    HRESULT (WINAPI *XSpeechSynthesizerCreate)(void *iface, void **synthesizer);
    HRESULT (WINAPI *XSpeechSynthesizerCloseHandle)(void *iface, void *synthesizer);
    HRESULT (WINAPI *XSpeechSynthesizerSetDefaultVoice)(void *iface, void *synthesizer);
    HRESULT (WINAPI *XSpeechSynthesizerSetCustomVoice)(void *iface, void *synthesizer, const char *voiceId);
    HRESULT (WINAPI *XSpeechSynthesizerCreateStreamFromText)(void *iface, void *synthesizer, const char *text, void **stream);
    HRESULT (WINAPI *XSpeechSynthesizerCloseStreamHandle)(void *iface, void *stream);
    HRESULT (WINAPI *XSpeechSynthesizerGetStreamDataSize)(void *iface, void *stream, size_t *bufferSize);
    HRESULT (WINAPI *XSpeechSynthesizerGetStreamData)(void *iface, void *stream, size_t bufferSize, void *buffer, size_t *bufferUsed);
    HRESULT (WINAPI *XSpeechToTextBeginHypothesisString)(void *iface, const char *speakerName, const char *content, uint32_t type, uint32_t *hypothesisId);
    HRESULT (WINAPI *XSpeechToTextUpdateHypothesisString)(void *iface, uint32_t hypothesisId, const char *content);
    HRESULT (WINAPI *XSpeechToTextFinalizeHypothesisString)(void *iface, uint32_t hypothesisId, const char *content);
    HRESULT (WINAPI *XSpeechToTextCancelHypothesisString)(void *iface, uint32_t hypothesisId);
    HRESULT (WINAPI *XSpeechSynthesizerCreateStreamFromSsml)(void *iface, void *synthesizer, const char *ssml, void **stream);
    HRESULT (WINAPI *XSpeechSynthesizerSetVolume)(void *iface, void *synthesizer, float volume);
} IXAccessibilityImpl2Vtbl;
_Static_assert(sizeof(IXAccessibilityImpl2Vtbl) == 23 * sizeof(void *), "IXAccessibilityImpl2Vtbl must have 23 slots");

static const IXAccessibilityImpl2Vtbl g_xacc_vtbl = {
    xacc_QueryInterface,
    misc_AddRef,
    misc_Release,
    xacc_CCGetProps,
    xacc_CCSetEnabled,
    xacc_HCGetMode,
    xacc_SttSetPositionHint,
    xacc_SttSendString,
    xacc_SynthEnumVoices,
    xacc_SynthCreate,
    xacc_SynthCloseHandle,
    xacc_SynthSetDefaultVoice,
    xacc_SynthSetCustomVoice,
    xacc_SynthCreateStreamFromText,
    xacc_SynthCloseStreamHandle,
    xacc_SynthGetStreamDataSize,
    xacc_SynthGetStreamData,
    xacc_SttBeginHypothesis,
    xacc_SttUpdateHypothesis,
    xacc_SttFinalizeHypothesis,
    xacc_SttCancelHypothesis,
    xacc_SynthCreateStreamFromSsml,
    xacc_SynthSetVolume
};
static struct { const IXAccessibilityImpl2Vtbl *lpVtbl; } g_xacc_singleton = { &g_xacc_vtbl };
HRESULT xgr_query_accessibility(REFIID iid, void **ppv) { return xacc_QueryInterface(&g_xacc_singleton, iid, ppv); }

/* AppCapture (19 slots) & AppCaptureMetadata (19 slots) */
static HRESULT WINAPI xcap_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXAppCaptureImpl) ||
        IsEqualGUID(riid, &IID_IXAppCaptureImpl2) || IsEqualGUID(riid, &IID_IXAppCaptureImpl3) ||
        IsEqualGUID(riid, &IID_IXAppCaptureImpl4)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}
static HRESULT WINAPI xcap_RecordDiagnosticClip(void *iface, int64_t startTime, uint32_t durationMs, const char *prefix, void *result)
{
    (void)iface; (void)startTime; (void)durationMs; (void)prefix; (void)result;
    return E_NOTIMPL;
}
static HRESULT WINAPI xcap_TakeDiagnosticScreenshot(void *iface, BOOLEAN gameScreenOnly, uint32_t options, const char *prefix, void *result)
{
    (void)iface; (void)gameScreenOnly; (void)options; (void)prefix; (void)result;
    return E_NOTIMPL;
}
static HRESULT WINAPI xcap_OpenScreenshotStream(void *iface, const char *localId, uint32_t fileType, void **handle, uint64_t *totalSizeBytes)
{
    (void)iface; (void)localId; (void)fileType;
    if (handle) *handle = NULL;
    if (totalSizeBytes) *totalSizeBytes = 0;
    return E_NOTIMPL;
}
static HRESULT WINAPI xcap_ReadScreenshotStream(void *iface, void *handle, uint64_t startPosition, uint32_t bytesToRead, uint8_t *buffer, uint32_t *bytesWritten)
{
    (void)iface; (void)handle; (void)startPosition; (void)bytesToRead; (void)buffer;
    if (bytesWritten) *bytesWritten = 0;
    return E_NOTIMPL;
}
static HRESULT WINAPI xcap_CloseScreenshotStream(void *iface, void *handle)
{
    (void)iface; (void)handle;
    return E_NOTIMPL;
}
static HRESULT WINAPI xcap_TakeScreenshot(void *iface, XUserHandle user, void *result)
{
    (void)iface; (void)user; (void)result;
    return E_NOTIMPL;
}
static HRESULT WINAPI xcap_EnableRecord(void *iface)
{
    (void)iface;
    return S_OK;
}
static HRESULT WINAPI xcap_DisableRecord(void *iface)
{
    (void)iface;
    return S_OK;
}
static HRESULT WINAPI xcap_GetVideoCaptureSettings(void *iface, void *settings)
{
    (void)iface; (void)settings;
    return E_NOTIMPL;
}
static HRESULT WINAPI xcap_RecordTimespan(void *iface, const void *startTimestamp, uint32_t durationMs, void *result)
{
    (void)iface; (void)startTimestamp; (void)durationMs; (void)result;
    return E_NOTIMPL;
}
static HRESULT WINAPI xcap_ReadLocalStream(void *iface, void *handle, size_t startPosition, uint32_t bytesToRead, uint8_t *buffer, uint32_t *bytesWritten)
{
    (void)iface; (void)handle; (void)startPosition; (void)bytesToRead; (void)buffer;
    if (bytesWritten) *bytesWritten = 0;
    return E_NOTIMPL;
}
static HRESULT WINAPI xcap_CloseLocalStream(void *iface, void *handle)
{
    (void)iface; (void)handle;
    return E_NOTIMPL;
}
static HRESULT WINAPI xcap_ExtReg(void *iface, XTaskQueueHandle q, void *ctx, void *cb, XTaskQueueRegistrationToken *tok)
{
    (void)iface; (void)q; (void)ctx; (void)cb;
    if (tok) tok->token = 0;
    return E_NOTIMPL;
}
static HRESULT WINAPI xcap_ExtUnreg(void *iface, XTaskQueueRegistrationToken tok, BOOLEAN wait)
{
    (void)iface; (void)tok; (void)wait;
    return E_NOTIMPL;
}
static HRESULT WINAPI xcap_Ext2(void *iface, void *a)
{
    (void)iface; (void)a;
    return E_NOTIMPL;
}
static HRESULT WINAPI xcap_Ext3(void *iface, void *a, void *b)
{
    (void)iface; (void)a; (void)b;
    return E_NOTIMPL;
}

typedef struct IXAppCaptureImpl4Vtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    HRESULT (WINAPI *XAppCaptureRecordDiagnosticClip)(void *iface, int64_t startTime, uint32_t durationMs, const char *prefix, void *result);
    HRESULT (WINAPI *XAppCaptureTakeDiagnosticScreenshot)(void *iface, BOOLEAN gameScreenOnly, uint32_t options, const char *prefix, void *result);
    HRESULT (WINAPI *XAppCaptureOpenScreenshotStream)(void *iface, const char *localId, uint32_t fileType, void **handle, uint64_t *totalSizeBytes);
    HRESULT (WINAPI *XAppCaptureReadScreenshotStream)(void *iface, void *handle, uint64_t startPosition, uint32_t bytesToRead, uint8_t *buffer, uint32_t *bytesWritten);
    HRESULT (WINAPI *XAppCaptureCloseScreenshotStream)(void *iface, void *handle);
    HRESULT (WINAPI *XAppCaptureTakeScreenshot)(void *iface, XUserHandle user, void *result);
    HRESULT (WINAPI *XAppCaptureEnableRecord)(void *iface);
    HRESULT (WINAPI *XAppCaptureDisableRecord)(void *iface);
    HRESULT (WINAPI *XAppCaptureGetVideoCaptureSettings)(void *iface, void *settings);
    HRESULT (WINAPI *XAppCaptureRecordTimespan)(void *iface, const void *startTimestamp, uint32_t durationMs, void *result);
    HRESULT (WINAPI *XAppCaptureReadLocalStream)(void *iface, void *handle, size_t startPosition, uint32_t bytesToRead, uint8_t *buffer, uint32_t *bytesWritten);
    HRESULT (WINAPI *XAppCaptureCloseLocalStream)(void *iface, void *handle);
    HRESULT (WINAPI *XAppCaptureExt15)(void *iface, XTaskQueueHandle q, void *ctx, void *cb, XTaskQueueRegistrationToken *tok);
    HRESULT (WINAPI *XAppCaptureExt16)(void *iface, XTaskQueueRegistrationToken tok, BOOLEAN wait);
    HRESULT (WINAPI *XAppCaptureExt17)(void *iface, void *a);
    HRESULT (WINAPI *XAppCaptureExt18)(void *iface, void *a, void *b);
} IXAppCaptureImpl4Vtbl;
_Static_assert(sizeof(IXAppCaptureImpl4Vtbl) == 19 * sizeof(void *), "IXAppCaptureImpl4Vtbl must have 19 slots");

static const IXAppCaptureImpl4Vtbl g_xcap_vtbl = {
    xcap_QueryInterface,
    misc_AddRef,
    misc_Release,
    xcap_RecordDiagnosticClip,
    xcap_TakeDiagnosticScreenshot,
    xcap_OpenScreenshotStream,
    xcap_ReadScreenshotStream,
    xcap_CloseScreenshotStream,
    xcap_TakeScreenshot,
    xcap_EnableRecord,
    xcap_DisableRecord,
    xcap_GetVideoCaptureSettings,
    xcap_RecordTimespan,
    xcap_ReadLocalStream,
    xcap_CloseLocalStream,
    xcap_ExtReg,
    xcap_ExtUnreg,
    xcap_Ext2,
    xcap_Ext3
};
static struct { const IXAppCaptureImpl4Vtbl *lpVtbl; } g_xcap_singleton = { &g_xcap_vtbl };
HRESULT xgr_query_app_capture(REFIID iid, void **ppv) { return xcap_QueryInterface(&g_xcap_singleton, iid, ppv); }

static HRESULT WINAPI xcapm_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXAppCaptureMetadataImpl)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}
static BOOLEAN WINAPI xcapm_IsMetadataEnabled(void *iface) { (void)iface; return FALSE; }
static HRESULT WINAPI xcapm_EnableMetadata(void *iface, BOOLEAN enable) { (void)iface; (void)enable; return E_NOTIMPL; }
static HRESULT WINAPI xcapm_GetState(void *iface, void *state) { (void)iface; (void)state; return E_NOTIMPL; }
static HRESULT WINAPI xcapm_Reg(void *iface, XTaskQueueHandle q, void *c, void *cb, XTaskQueueRegistrationToken *t)
{
    (void)iface; (void)q; (void)c; (void)cb;
    if (t) t->token = (uint64_t)InterlockedIncrement64(&g_misc_reg_token);
    return S_OK;
}
static BOOLEAN WINAPI xcapm_Unreg(void *iface, XTaskQueueRegistrationToken t, BOOLEAN w)
{
    (void)iface; (void)t; (void)w;
    return TRUE;
}
static HRESULT WINAPI xcapm_AddStringEvent(void *iface, const char *name, const char *value, uint32_t priority)
{
    (void)iface; (void)name; (void)value; (void)priority;
    return S_OK;
}
static HRESULT WINAPI xcapm_AddInt32Event(void *iface, const char *name, int32_t value, uint32_t priority)
{
    (void)iface; (void)name; (void)value; (void)priority;
    return S_OK;
}
static HRESULT WINAPI xcapm_AddDoubleEvent(void *iface, const char *name, double value, uint32_t priority)
{
    (void)iface; (void)name; (void)value; (void)priority;
    return S_OK;
}
static HRESULT WINAPI xcapm_StartStringState(void *iface, const char *name, const char *value, uint32_t priority)
{
    (void)iface; (void)name; (void)value; (void)priority;
    return S_OK;
}
static HRESULT WINAPI xcapm_StartInt32State(void *iface, const char *name, int32_t value, uint32_t priority)
{
    (void)iface; (void)name; (void)value; (void)priority;
    return S_OK;
}
static HRESULT WINAPI xcapm_StartDoubleState(void *iface, const char *name, double value, uint32_t priority)
{
    (void)iface; (void)name; (void)value; (void)priority;
    return S_OK;
}
static HRESULT WINAPI xcapm_StopState(void *iface, const char *name)
{
    (void)iface; (void)name;
    return S_OK;
}
static HRESULT WINAPI xcapm_StopAllStates(void *iface)
{
    (void)iface;
    return S_OK;
}
static HRESULT WINAPI xcapm_RemainingStorageBytesAvailable(void *iface, uint64_t *value)
{
    (void)iface;
    if (value) *value = 0;
    return E_NOTIMPL;
}

typedef struct IXAppCaptureMetadataImplVtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    BOOLEAN (WINAPI *XAppCaptureIsMetadataEnabled)(void *iface);
    HRESULT (WINAPI *XAppCaptureSetMetadataEnabled)(void *iface, BOOLEAN enable);
    HRESULT (WINAPI *XAppCaptureGetMetadataState)(void *iface, void *state);
    HRESULT (WINAPI *XAppCaptureRegisterIsUserInControlChanged)(void *iface, XTaskQueueHandle q, void *c, void *cb, XTaskQueueRegistrationToken *t);
    BOOLEAN (WINAPI *XAppCaptureUnregisterIsUserInControlChanged)(void *iface, XTaskQueueRegistrationToken t, BOOLEAN w);
    HRESULT (WINAPI *XAppCaptureMetadataAddStringEvent)(void *iface, const char *name, const char *value, uint32_t priority);
    HRESULT (WINAPI *XAppCaptureMetadataAddInt32Event)(void *iface, const char *name, int32_t value, uint32_t priority);
    HRESULT (WINAPI *XAppCaptureMetadataAddDoubleEvent)(void *iface, const char *name, double value, uint32_t priority);
    HRESULT (WINAPI *XAppCaptureMetadataStartStringState)(void *iface, const char *name, const char *value, uint32_t priority);
    HRESULT (WINAPI *XAppCaptureMetadataStartInt32State)(void *iface, const char *name, int32_t value, uint32_t priority);
    HRESULT (WINAPI *XAppCaptureMetadataStartDoubleState)(void *iface, const char *name, double value, uint32_t priority);
    HRESULT (WINAPI *XAppCaptureMetadataStopState)(void *iface, const char *name);
    HRESULT (WINAPI *XAppCaptureMetadataStopAllStates)(void *iface);
    HRESULT (WINAPI *XAppCaptureMetadataRemainingStorageBytesAvailable)(void *iface, uint64_t *value);
    HRESULT (WINAPI *XAppCaptureRegisterMetadataPurged)(void *iface, XTaskQueueHandle q, void *c, void *cb, XTaskQueueRegistrationToken *t);
    BOOLEAN (WINAPI *XAppCaptureUnregisterMetadataPurged)(void *iface, XTaskQueueRegistrationToken t, BOOLEAN w);
} IXAppCaptureMetadataImplVtbl;
_Static_assert(sizeof(IXAppCaptureMetadataImplVtbl) == 19 * sizeof(void *), "IXAppCaptureMetadataImplVtbl must have 19 slots");

static const IXAppCaptureMetadataImplVtbl g_xcapm_vtbl = {
    xcapm_QueryInterface,
    misc_AddRef,
    misc_Release,
    xcapm_IsMetadataEnabled,
    xcapm_EnableMetadata,
    xcapm_GetState,
    xcapm_Reg,
    xcapm_Unreg,
    xcapm_AddStringEvent,
    xcapm_AddInt32Event,
    xcapm_AddDoubleEvent,
    xcapm_StartStringState,
    xcapm_StartInt32State,
    xcapm_StartDoubleState,
    xcapm_StopState,
    xcapm_StopAllStates,
    xcapm_RemainingStorageBytesAvailable,
    xcapm_Reg,
    xcapm_Unreg
};
static struct { const IXAppCaptureMetadataImplVtbl *lpVtbl; } g_xcapm_singleton = { &g_xcapm_vtbl };
HRESULT xgr_query_app_capture_metadata(REFIID iid, void **ppv) { return xcapm_QueryInterface(&g_xcapm_singleton, iid, ppv); }

/* GameProtocol (5 slots), GameActivation (6 slots), GameInvite (8 slots) */
typedef void (CALLBACK XgrUriActivationCallback)(void *context, const char *uri);

#define XGR_MAX_INVITE_CALLBACKS 8

struct xgr_invite_slot {
    bool in_use;
    bool unregistering;
    uint64_t token;
    XTaskQueueHandle queue;
    void *context;
    XgrUriActivationCallback *callback;
    int32_t in_flight;
    DWORD running_tid;
    char last_dispatched_uri[1024];
};

struct xgr_invite_dispatch_item {
    uint64_t token;
    char uri[1024];
};

static INIT_ONCE g_invite_once = INIT_ONCE_STATIC_INIT;
static CRITICAL_SECTION g_invite_cs;
static CONDITION_VARIABLE g_invite_cv;
static struct xgr_invite_slot g_invite_slots[XGR_MAX_INVITE_CALLBACKS];
static char g_pending_invite_uri[1024] = { 0 };

static BOOL CALLBACK invite_sync_init_fn(PINIT_ONCE once, PVOID param, PVOID *ctx)
{
    (void)once; (void)param; (void)ctx;
    InitializeCriticalSection(&g_invite_cs);
    InitializeConditionVariable(&g_invite_cv);
    return TRUE;
}

static void invite_ensure_sync(void)
{
    InitOnceExecuteOnce(&g_invite_once, invite_sync_init_fn, NULL, NULL);
}

static void CALLBACK xinvite_dispatch_task_cb(void *ctx, bool canceled)
{
    struct xgr_invite_dispatch_item *item = (struct xgr_invite_dispatch_item *)ctx;
    if (!item) return;

    if (!canceled) {
        invite_ensure_sync();
        XgrUriActivationCallback *cb = NULL;
        void *cb_ctx = NULL;
        size_t slot_idx = XGR_MAX_INVITE_CALLBACKS;

        EnterCriticalSection(&g_invite_cs);
        for (size_t i = 0; i < XGR_MAX_INVITE_CALLBACKS; i++) {
            if (g_invite_slots[i].in_use &&
                !g_invite_slots[i].unregistering &&
                g_invite_slots[i].token == item->token) {
                cb = g_invite_slots[i].callback;
                cb_ctx = g_invite_slots[i].context;
                g_invite_slots[i].in_flight++;
                g_invite_slots[i].running_tid = GetCurrentThreadId();
                slot_idx = i;
                break;
            }
        }
        LeaveCriticalSection(&g_invite_cs);

        if (cb) {
            cb(cb_ctx, item->uri);
        }

        if (slot_idx < XGR_MAX_INVITE_CALLBACKS) {
            XTaskQueueHandle deferred_close = NULL;
            EnterCriticalSection(&g_invite_cs);
            g_invite_slots[slot_idx].in_flight--;
            if (g_invite_slots[slot_idx].in_flight <= 0) {
                g_invite_slots[slot_idx].in_flight = 0;
                g_invite_slots[slot_idx].running_tid = 0;
                if (g_invite_slots[slot_idx].unregistering) {
                    deferred_close = g_invite_slots[slot_idx].queue;
                    memset(&g_invite_slots[slot_idx], 0, sizeof(g_invite_slots[slot_idx]));
                }
                WakeAllConditionVariable(&g_invite_cv);
            }
            LeaveCriticalSection(&g_invite_cs);
            if (deferred_close) {
                xgr_task_queue_close(deferred_close);
            }
        }
    }
    free(item);
}

static void schedule_invite_dispatch_unlocked(XTaskQueueHandle slot_queue, uint64_t token, const char *uri)
{
    if (!uri || !uri[0]) return;

    struct xgr_invite_dispatch_item *item =
        (struct xgr_invite_dispatch_item *)calloc(1, sizeof(*item));
    if (!item) return;
    item->token = token;
    snprintf(item->uri, sizeof(item->uri), "%s", uri);

    XTaskQueueHandle target_q = slot_queue;
    bool close_target = false;
    if (!target_q) {
        if (xgr_task_queue_get_process(&target_q) && target_q) {
            close_target = true;
        }
    }

    HRESULT hr = target_q
        ? xgr_task_queue_submit_delayed(target_q, XTaskQueuePort_Completion, 0, item, xinvite_dispatch_task_cb)
        : E_FAIL;
    if (close_target && target_q) {
        xgr_task_queue_close(target_q);
    }
    if (FAILED(hr)) {
        free(item);
    }
}

void xgr_set_pending_invite_uri(const char *uri)
{
    invite_ensure_sync();
    struct {
        XTaskQueueHandle queue;
        uint64_t token;
    } pending_targets[XGR_MAX_INVITE_CALLBACKS];
    size_t target_count = 0;
    char uri_snapshot[1024] = { 0 };

    EnterCriticalSection(&g_invite_cs);
    if (!uri || !uri[0]) {
        g_pending_invite_uri[0] = '\0';
        LeaveCriticalSection(&g_invite_cs);
        return;
    }
    snprintf(g_pending_invite_uri, sizeof(g_pending_invite_uri), "%s", uri);
    snprintf(uri_snapshot, sizeof(uri_snapshot), "%s", g_pending_invite_uri);

    for (size_t i = 0; i < XGR_MAX_INVITE_CALLBACKS; i++) {
        if (!g_invite_slots[i].in_use || g_invite_slots[i].unregistering || !g_invite_slots[i].callback) continue;
        if (strcmp(g_invite_slots[i].last_dispatched_uri, uri_snapshot) == 0) continue;

        snprintf(
            g_invite_slots[i].last_dispatched_uri,
            sizeof(g_invite_slots[i].last_dispatched_uri),
            "%s",
            uri_snapshot
        );
        XTaskQueueHandle q_dup = NULL;
        if (g_invite_slots[i].queue) {
            (void)xgr_task_queue_duplicate(g_invite_slots[i].queue, &q_dup);
        }
        pending_targets[target_count].queue = q_dup;
        pending_targets[target_count].token = g_invite_slots[i].token;
        target_count++;
    }
    LeaveCriticalSection(&g_invite_cs);

    for (size_t i = 0; i < target_count; i++) {
        schedule_invite_dispatch_unlocked(pending_targets[i].queue, pending_targets[i].token, uri_snapshot);
        if (pending_targets[i].queue) {
            xgr_task_queue_close(pending_targets[i].queue);
        }
    }
}

void xgr_invite_callbacks_reset(void)
{
    invite_ensure_sync();
    XTaskQueueHandle to_close[XGR_MAX_INVITE_CALLBACKS];
    size_t close_count = 0;

    EnterCriticalSection(&g_invite_cs);
    g_pending_invite_uri[0] = '\0';
    for (size_t i = 0; i < XGR_MAX_INVITE_CALLBACKS; i++) {
        if (g_invite_slots[i].in_use) {
            if (g_invite_slots[i].in_flight > 0) {
                g_invite_slots[i].unregistering = true;
            } else {
                if (g_invite_slots[i].queue) {
                    to_close[close_count++] = g_invite_slots[i].queue;
                }
                memset(&g_invite_slots[i], 0, sizeof(g_invite_slots[i]));
            }
        }
    }
    LeaveCriticalSection(&g_invite_cs);

    for (size_t i = 0; i < close_count; i++) {
        xgr_task_queue_close(to_close[i]);
    }

    net_hint_ensure_sync();
    EnterCriticalSection(&g_net_hint_cs);
    for (size_t i = 0; i < XGR_MAX_NET_HINT_SLOTS; i++) {
        if (g_net_hint_slots[i].in_use) {
            if (g_net_hint_slots[i].in_flight > 0) {
                g_net_hint_slots[i].unregistering = true;
            } else {
                memset(&g_net_hint_slots[i], 0, sizeof(g_net_hint_slots[i]));
            }
        }
    }
    LeaveCriticalSection(&g_net_hint_cs);
}

static HRESULT WINAPI xinvite_Reg(
    void *iface,
    XTaskQueueHandle q,
    void *c,
    void *cb,
    XTaskQueueRegistrationToken *t
)
{
    (void)iface;
    if (!cb || !t) return xgr_return_hr(E_INVALIDARG);

    invite_ensure_sync();
    xgr_ensure_session_metadata_loaded();

    XTaskQueueHandle q_dup = NULL;
    if (q) {
        HRESULT qhr = xgr_task_queue_duplicate(q, &q_dup);
        if (FAILED(qhr)) return xgr_return_hr(qhr);
    }

    uint64_t tok = (uint64_t)InterlockedIncrement64(&g_misc_reg_token);
    char uri_to_dispatch[1024] = { 0 };
    XTaskQueueHandle dispatch_q_dup = NULL;
    bool stored = false;

    EnterCriticalSection(&g_invite_cs);
    for (size_t i = 0; i < XGR_MAX_INVITE_CALLBACKS; i++) {
        if (!g_invite_slots[i].in_use) {
            memset(&g_invite_slots[i], 0, sizeof(g_invite_slots[i]));
            g_invite_slots[i].in_use = true;
            g_invite_slots[i].token = tok;
            g_invite_slots[i].queue = q_dup;
            g_invite_slots[i].context = c;
            g_invite_slots[i].callback = (XgrUriActivationCallback *)cb;
            if (g_pending_invite_uri[0]) {
                snprintf(uri_to_dispatch, sizeof(uri_to_dispatch), "%s", g_pending_invite_uri);
                snprintf(
                    g_invite_slots[i].last_dispatched_uri,
                    sizeof(g_invite_slots[i].last_dispatched_uri),
                    "%s",
                    g_pending_invite_uri
                );
                if (q_dup) {
                    (void)xgr_task_queue_duplicate(q_dup, &dispatch_q_dup);
                }
            }
            stored = true;
            break;
        }
    }
    LeaveCriticalSection(&g_invite_cs);

    if (!stored) {
        if (q_dup) xgr_task_queue_close(q_dup);
        return xgr_return_hr(E_OUTOFMEMORY);
    }

    t->token = tok;
    if (uri_to_dispatch[0]) {
        schedule_invite_dispatch_unlocked(dispatch_q_dup, tok, uri_to_dispatch);
        if (dispatch_q_dup) xgr_task_queue_close(dispatch_q_dup);
    }
    return xgr_return_hr(S_OK);
}

static BOOLEAN WINAPI xinvite_Unreg(void *iface, XTaskQueueRegistrationToken t, BOOLEAN w)
{
    (void)iface;
    invite_ensure_sync();
    XTaskQueueHandle q_to_close = NULL;
    DWORD self_tid = GetCurrentThreadId();
    BOOLEAN result = TRUE;

    EnterCriticalSection(&g_invite_cs);
    for (size_t i = 0; i < XGR_MAX_INVITE_CALLBACKS; i++) {
        if (g_invite_slots[i].in_use && g_invite_slots[i].token == t.token) {
            g_invite_slots[i].unregistering = true;
            if (g_invite_slots[i].in_flight > 0) {
                if (!w || g_invite_slots[i].running_tid == self_tid) {
                    result = FALSE;
                } else {
                    while (g_invite_slots[i].in_use &&
                           g_invite_slots[i].token == t.token &&
                           g_invite_slots[i].in_flight > 0) {
                        SleepConditionVariableCS(&g_invite_cv, &g_invite_cs, 50);
                    }
                    result = TRUE;
                }
            } else {
                q_to_close = g_invite_slots[i].queue;
                memset(&g_invite_slots[i], 0, sizeof(g_invite_slots[i]));
                result = TRUE;
            }
            break;
        }
    }
    LeaveCriticalSection(&g_invite_cs);

    if (q_to_close) {
        xgr_task_queue_close(q_to_close);
    }
    return result;
}

static HRESULT WINAPI xinvite_AcceptPendingInvite(void *iface, const char *inviteUri)
{
    (void)iface; (void)inviteUri;
    return S_OK;
}

static HRESULT WINAPI xprot_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXGameProtocolImpl)) { *ppv = iface; return S_OK; }
    *ppv = NULL; return E_NOINTERFACE;
}
typedef struct IXGameProtocolImplVtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    HRESULT (WINAPI *XGameProtocolRegisterForActivation)(void *iface, XTaskQueueHandle q, void *c, void *cb, XTaskQueueRegistrationToken *t);
    BOOLEAN (WINAPI *XGameProtocolUnregisterForActivation)(void *iface, XTaskQueueRegistrationToken t, BOOLEAN w);
} IXGameProtocolImplVtbl;
_Static_assert(sizeof(IXGameProtocolImplVtbl) == 5 * sizeof(void *), "IXGameProtocolImplVtbl must have 5 slots");

static const IXGameProtocolImplVtbl g_xprot_vtbl = {
    xprot_QueryInterface, misc_AddRef, misc_Release,
    xinvite_Reg, xinvite_Unreg
};
static struct { const IXGameProtocolImplVtbl *lpVtbl; } g_xprot_singleton = { &g_xprot_vtbl };
HRESULT xgr_query_game_protocol(REFIID iid, void **ppv) { return xprot_QueryInterface(&g_xprot_singleton, iid, ppv); }

static HRESULT WINAPI xact_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXGameActivationImpl)) { *ppv = iface; return S_OK; }
    *ppv = NULL; return E_NOINTERFACE;
}
typedef struct IXGameActivationImplVtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    HRESULT (WINAPI *XGameActivationRegisterForEvent)(void *iface, XTaskQueueHandle q, void *c, void *cb, XTaskQueueRegistrationToken *t);
    BOOLEAN (WINAPI *XGameActivationUnregisterForEvent)(void *iface, XTaskQueueRegistrationToken t, BOOLEAN w);
    HRESULT (WINAPI *XGameActivationAcceptPendingInvite)(void *iface, const char *inviteUri);
} IXGameActivationImplVtbl;
_Static_assert(sizeof(IXGameActivationImplVtbl) == 6 * sizeof(void *), "IXGameActivationImplVtbl must have 6 slots");

static const IXGameActivationImplVtbl g_xact_vtbl = {
    xact_QueryInterface, misc_AddRef, misc_Release,
    xcapm_Reg, xcapm_Unreg, xinvite_AcceptPendingInvite
};
static struct { const IXGameActivationImplVtbl *lpVtbl; } g_xact_singleton = { &g_xact_vtbl };
HRESULT xgr_query_game_activation(REFIID iid, void **ppv) { return xact_QueryInterface(&g_xact_singleton, iid, ppv); }

static HRESULT WINAPI xinv_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXGameInviteImpl) || IsEqualGUID(riid, &IID_IXGameInviteImpl2)) {
        *ppv = iface; return S_OK;
    }
    *ppv = NULL; return E_NOINTERFACE;
}
typedef struct IXGameInviteImpl2Vtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    HRESULT (WINAPI *XGameInviteRegisterForEvent)(void *iface, XTaskQueueHandle q, void *c, void *cb, XTaskQueueRegistrationToken *t);
    BOOLEAN (WINAPI *XGameInviteUnregisterForEvent)(void *iface, XTaskQueueRegistrationToken t, BOOLEAN w);
    HRESULT (WINAPI *XGameInviteRegisterForPendingEvent)(void *iface, XTaskQueueHandle q, void *c, void *cb, XTaskQueueRegistrationToken *t);
    BOOLEAN (WINAPI *XGameInviteUnregisterForPendingEvent)(void *iface, XTaskQueueRegistrationToken t, BOOLEAN w);
    HRESULT (WINAPI *XGameInviteAcceptPendingInvite)(void *iface, const char *inviteUri);
} IXGameInviteImpl2Vtbl;
_Static_assert(sizeof(IXGameInviteImpl2Vtbl) == 8 * sizeof(void *), "IXGameInviteImpl2Vtbl must have 8 slots");

static const IXGameInviteImpl2Vtbl g_xinv_vtbl = {
    xinv_QueryInterface, misc_AddRef, misc_Release,
    xinvite_Reg, xinvite_Unreg,
    xinvite_Reg, xinvite_Unreg, xinvite_AcceptPendingInvite
};
static struct { const IXGameInviteImpl2Vtbl *lpVtbl; } g_xinv_singleton = { &g_xinv_vtbl };
HRESULT xgr_query_game_invite(REFIID iid, void **ppv) { return xinv_QueryInterface(&g_xinv_singleton, iid, ppv); }

/* GameStreaming (35 slots — IsStreaming returns FALSE, exact __stdcall arity!) */
static HRESULT WINAPI xstr_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXGameStreamingImpl) ||
        IsEqualGUID(riid, &IID_IXGameStreamingImpl2) || IsEqualGUID(riid, &IID_IXGameStreamingImpl3)) {
        *ppv = iface; return S_OK;
    }
    *ppv = NULL; return E_NOINTERFACE;
}
static HRESULT WINAPI xstr_Initialize(void *iface) { (void)iface; return S_OK; }
static void WINAPI xstr_Uninitialize(void *iface) { (void)iface; }
static BOOLEAN WINAPI xstr_IsStreaming(void *iface) { (void)iface; return FALSE; }
static HRESULT WINAPI xstr_GetClientsLegacy(void *iface, uint32_t count, uint64_t *clients, uint32_t *used)
{
    (void)iface; (void)count; (void)clients;
    if (used) *used = 0;
    return S_OK;
}
static BOOLEAN WINAPI xstr_IsTouchInputEnabled(void *iface, uint64_t client) { (void)iface; (void)client; return FALSE; }
static HRESULT WINAPI xstr_GetLastFrameDisplayed(void *iface, uint64_t client, uint64_t *token)
{
    (void)iface; (void)client;
    if (token) *token = 0;
    return E_NOTIMPL;
}
static uint32_t WINAPI xstr_GetClientCount(void *iface) { (void)iface; return 0; }
static HRESULT WINAPI xstr_GetClients(void *iface, uint32_t count, uint64_t *clients, uint32_t *used)
{
    (void)iface; (void)count; (void)clients;
    if (used) *used = 0;
    return S_OK;
}
static uint32_t WINAPI xstr_GetConnectionState(void *iface, uint64_t client) { (void)iface; (void)client; return 0; }
static HRESULT WINAPI xstr_GetServerLocationName(void *iface, size_t size, char *name)
{
    (void)iface; (void)size; (void)name;
    return E_NOTIMPL;
}
static SIZE_T WINAPI xstr_GetServerLocationNameSize(void *iface) { (void)iface; return 0; }
static HRESULT WINAPI xstr_GetAssociatedFrame(void *iface, void *reading, uint64_t *token)
{
    (void)iface; (void)reading;
    if (token) *token = 0;
    return E_NOTIMPL;
}
static void WINAPI xstr_HideTouchControls(void *iface) { (void)iface; }
static void WINAPI xstr_HideTouchControlsOnClient(void *iface, uint64_t client) { (void)iface; (void)client; }
static void WINAPI xstr_ShowTouchControlLayout(void *iface, const char *layout) { (void)iface; (void)layout; }
static void WINAPI xstr_ShowTouchControlLayoutOnClient(void *iface, uint64_t client, const char *layout) { (void)iface; (void)client; (void)layout; }
static HRESULT WINAPI xstr_ShowTouchControlsWithStateUpdate(void *iface, const char *layout, size_t count, const void *ops)
{
    (void)iface; (void)layout; (void)count; (void)ops;
    return E_NOTIMPL;
}
static HRESULT WINAPI xstr_ShowTouchControlsWithStateUpdateOnClient(void *iface, uint64_t client, const char *layout, size_t count, const void *ops)
{
    (void)iface; (void)client; (void)layout; (void)count; (void)ops;
    return E_NOTIMPL;
}
static HRESULT WINAPI xstr_UpdateTouchControlsState(void *iface, size_t count, const void *ops)
{
    (void)iface; (void)count; (void)ops;
    return E_NOTIMPL;
}
static HRESULT WINAPI xstr_UpdateTouchControlsStateOnClient(void *iface, uint64_t client, size_t count, const void *ops)
{
    (void)iface; (void)client; (void)count; (void)ops;
    return E_NOTIMPL;
}
static HRESULT WINAPI xstr_RegClientPropertiesChanged(void *iface, uint64_t client, XTaskQueueHandle q, void *ctx, void *cb, XTaskQueueRegistrationToken *tok)
{
    (void)iface; (void)client; (void)q; (void)ctx; (void)cb;
    if (tok) tok->token = (uint64_t)InterlockedIncrement64(&g_misc_reg_token);
    return S_OK;
}
static BOOLEAN WINAPI xstr_UnregClientPropertiesChanged(void *iface, uint64_t client, XTaskQueueRegistrationToken tok, BOOLEAN wait)
{
    (void)iface; (void)client; (void)tok; (void)wait;
    return TRUE;
}
static HRESULT WINAPI xstr_GetStreamPhysicalDimensions(void *iface, uint64_t client, uint32_t *w, uint32_t *h)
{
    (void)iface; (void)client;
    if (w) *w = 0;
    if (h) *h = 0;
    return S_OK;
}
static HRESULT WINAPI xstr_GetTouchBundleVersion(void *iface, uint64_t client, void *version, size_t nameSize, char *name)
{
    (void)iface; (void)client; (void)version; (void)nameSize;
    if (name && nameSize > 0) name[0] = '\0';
    return S_OK;
}
static SIZE_T WINAPI xstr_GetTouchBundleVersionNameSize(void *iface, uint64_t client) { (void)iface; (void)client; return 0; }
static HRESULT WINAPI xstr_GetClientIPAddress(void *iface, uint64_t client, size_t size, char *ip)
{
    (void)iface; (void)client; (void)size; (void)ip;
    return E_NOTIMPL;
}
static HRESULT WINAPI xstr_GetGamepadPhysicality(void *iface, void *reading, uint64_t *phys, uint64_t *virt)
{
    (void)iface; (void)reading;
    if (phys) *phys = 0;
    if (virt) *virt = 0;
    return E_NOTIMPL;
}
static HRESULT WINAPI xstr_GetSessionId(void *iface, uint64_t client, size_t size, char *sessionId, size_t *used)
{
    (void)iface; (void)client; (void)size; (void)sessionId;
    if (used) *used = 0;
    return E_NOTIMPL;
}
static HRESULT WINAPI xstr_GetDisplayDetails(void *iface, uint64_t client, uint32_t maxPixels, float widest, float tallest, void *details)
{
    (void)iface; (void)client; (void)maxPixels; (void)widest; (void)tallest; (void)details;
    return E_NOTIMPL;
}
static HRESULT WINAPI xstr_SetResolution(void *iface, uint32_t width, uint32_t height)
{
    (void)iface; (void)width; (void)height;
    return S_OK;
}

typedef struct IXGameStreamingImpl3Vtbl {
    HRESULT  (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG    (WINAPI *AddRef)(void *iface);
    ULONG    (WINAPI *Release)(void *iface);
    HRESULT  (WINAPI *XGameStreamingInitialize)(void *iface);
    void     (WINAPI *XGameStreamingUninitialize)(void *iface);
    BOOLEAN  (WINAPI *XGameStreamingIsStreaming)(void *iface);
    HRESULT  (WINAPI *XGameStreamingGetClientsLegacy)(void *iface, uint32_t count, uint64_t *clients, uint32_t *used);
    BOOLEAN  (WINAPI *XGameStreamingIsTouchInputEnabled)(void *iface, uint64_t client);
    HRESULT  (WINAPI *XGameStreamingGetLastFrameDisplayed)(void *iface, uint64_t client, uint64_t *token);
    uint32_t (WINAPI *XGameStreamingGetClientCount)(void *iface);
    HRESULT  (WINAPI *XGameStreamingGetClients)(void *iface, uint32_t count, uint64_t *clients, uint32_t *used);
    uint32_t (WINAPI *XGameStreamingGetConnectionState)(void *iface, uint64_t client);
    HRESULT  (WINAPI *XGameStreamingRegisterConnectionStateChanged)(void *iface, XTaskQueueHandle q, void *c, void *cb, XTaskQueueRegistrationToken *t);
    BOOLEAN  (WINAPI *XGameStreamingUnregisterConnectionStateChanged)(void *iface, XTaskQueueRegistrationToken t, BOOLEAN w);
    HRESULT  (WINAPI *XGameStreamingGetServerLocationName)(void *iface, size_t size, char *name);
    SIZE_T   (WINAPI *XGameStreamingGetServerLocationNameSize)(void *iface);
    HRESULT  (WINAPI *XGameStreamingGetAssociatedFrame)(void *iface, void *reading, uint64_t *token);
    void     (WINAPI *XGameStreamingHideTouchControls)(void *iface);
    void     (WINAPI *XGameStreamingHideTouchControlsOnClient)(void *iface, uint64_t client);
    void     (WINAPI *XGameStreamingShowTouchControlLayout)(void *iface, const char *layout);
    void     (WINAPI *XGameStreamingShowTouchControlLayoutOnClient)(void *iface, uint64_t client, const char *layout);
    HRESULT  (WINAPI *XGameStreamingShowTouchControlsWithStateUpdate)(void *iface, const char *layout, size_t count, const void *ops);
    HRESULT  (WINAPI *XGameStreamingShowTouchControlsWithStateUpdateOnClient)(void *iface, uint64_t client, const char *layout, size_t count, const void *ops);
    HRESULT  (WINAPI *XGameStreamingUpdateTouchControlsState)(void *iface, size_t count, const void *ops);
    HRESULT  (WINAPI *XGameStreamingUpdateTouchControlsStateOnClient)(void *iface, uint64_t client, size_t count, const void *ops);
    HRESULT  (WINAPI *XGameStreamingRegisterClientPropertiesChanged)(void *iface, uint64_t client, XTaskQueueHandle q, void *ctx, void *cb, XTaskQueueRegistrationToken *tok);
    BOOLEAN  (WINAPI *XGameStreamingUnregisterClientPropertiesChanged)(void *iface, uint64_t client, XTaskQueueRegistrationToken tok, BOOLEAN wait);
    HRESULT  (WINAPI *XGameStreamingGetStreamPhysicalDimensions)(void *iface, uint64_t client, uint32_t *w, uint32_t *h);
    HRESULT  (WINAPI *XGameStreamingGetTouchBundleVersion)(void *iface, uint64_t client, void *version, size_t nameSize, char *name);
    SIZE_T   (WINAPI *XGameStreamingGetTouchBundleVersionNameSize)(void *iface, uint64_t client);
    HRESULT  (WINAPI *XGameStreamingGetClientIPAddress)(void *iface, uint64_t client, size_t size, char *ip);
    HRESULT  (WINAPI *XGameStreamingGetGamepadPhysicality)(void *iface, void *reading, uint64_t *phys, uint64_t *virt);
    HRESULT  (WINAPI *XGameStreamingGetSessionId)(void *iface, uint64_t client, size_t size, char *sessionId, size_t *used);
    HRESULT  (WINAPI *XGameStreamingGetDisplayDetails)(void *iface, uint64_t client, uint32_t maxPixels, float widest, float tallest, void *details);
    HRESULT  (WINAPI *XGameStreamingSetResolution)(void *iface, uint32_t width, uint32_t height);
} IXGameStreamingImpl3Vtbl;
_Static_assert(sizeof(IXGameStreamingImpl3Vtbl) == 35 * sizeof(void *), "IXGameStreamingImpl3Vtbl must have 35 slots");

static const IXGameStreamingImpl3Vtbl g_xstr_vtbl = {
    xstr_QueryInterface,                             /* 0 */
    misc_AddRef,                                     /* 1 */
    misc_Release,                                    /* 2 */
    xstr_Initialize,                                 /* 3 */
    xstr_Uninitialize,                               /* 4 */
    xstr_IsStreaming,                                /* 5 */
    xstr_GetClientsLegacy,                           /* 6 */
    xstr_IsTouchInputEnabled,                        /* 7 */
    xstr_GetLastFrameDisplayed,                      /* 8 */
    xstr_GetClientCount,                             /* 9 */
    xstr_GetClients,                                 /* 10 */
    xstr_GetConnectionState,                         /* 11 */
    xcapm_Reg,                                       /* 12 */
    xcapm_Unreg,                                     /* 13 */
    xstr_GetServerLocationName,                      /* 14 */
    xstr_GetServerLocationNameSize,                  /* 15 */
    xstr_GetAssociatedFrame,                         /* 16 */
    xstr_HideTouchControls,                          /* 17 */
    xstr_HideTouchControlsOnClient,                  /* 18 */
    xstr_ShowTouchControlLayout,                     /* 19 */
    xstr_ShowTouchControlLayoutOnClient,             /* 20 */
    xstr_ShowTouchControlsWithStateUpdate,           /* 21 */
    xstr_ShowTouchControlsWithStateUpdateOnClient,   /* 22 */
    xstr_UpdateTouchControlsState,                   /* 23 */
    xstr_UpdateTouchControlsStateOnClient,           /* 24 */
    xstr_RegClientPropertiesChanged,                 /* 25 */
    xstr_UnregClientPropertiesChanged,               /* 26 */
    xstr_GetStreamPhysicalDimensions,                /* 27 */
    xstr_GetTouchBundleVersion,                      /* 28 */
    xstr_GetTouchBundleVersionNameSize,              /* 29 */
    xstr_GetClientIPAddress,                         /* 30 */
    xstr_GetGamepadPhysicality,                      /* 31 */
    xstr_GetSessionId,                               /* 32: Impl2 */
    xstr_GetDisplayDetails,                          /* 33: Impl3 */
    xstr_SetResolution                               /* 34: Impl3 */
};
static struct { const IXGameStreamingImpl3Vtbl *lpVtbl; } g_xstr_singleton = { &g_xstr_vtbl };
HRESULT xgr_query_game_streaming(REFIID iid, void **ppv) { return xstr_QueryInterface(&g_xstr_singleton, iid, ppv); }

/* GameEvent (4 slots — telemetry write succeeds non-blockingly) */
static HRESULT WINAPI xevt_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) { *ppv = NULL; return E_INVALIDARG; }
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXGameEventImpl)) { *ppv = iface; return S_OK; }
    *ppv = NULL; return E_NOINTERFACE;
}
static HRESULT WINAPI xevt_Write(void *iface, XUserHandle u, const char *scid, const char *psid, const char *ev, const char *dim, const char *meas)
{
    (void)iface; (void)u; (void)scid; (void)psid; (void)ev; (void)dim; (void)meas;
    return S_OK;
}
typedef struct IXGameEventImplVtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    HRESULT (WINAPI *XGameEventWrite)(void *iface, XUserHandle u, const char *scid, const char *psid, const char *ev, const char *dim, const char *meas);
} IXGameEventImplVtbl;
_Static_assert(sizeof(IXGameEventImplVtbl) == 4 * sizeof(void *), "IXGameEventImplVtbl must have 4 slots");

static const IXGameEventImplVtbl g_xevt_vtbl = {
    xevt_QueryInterface, misc_AddRef, misc_Release,
    xevt_Write
};
static struct { const IXGameEventImplVtbl *lpVtbl; } g_xevt_singleton = { &g_xevt_vtbl };
HRESULT xgr_query_game_event(REFIID iid, void **ppv) { return xevt_QueryInterface(&g_xevt_singleton, iid, ppv); }
