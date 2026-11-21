/*
 * One Launcher XGR Bridge — PlayFabGameSave.dll Dynamic In-Proc Shim
 *
 * Bridges Microsoft GDK PlayFab Game Saves in-proc (`ForceUseInprocGameSaves = 1`)
 * gaps across CrossOver/Wine (`darwin`) and GamingServices-less Windows (`win32`):
 *
 * 1. `PFGameSaveFilesInitialize`: when `args->saveFolder == NULL || args->saveFolder[0] == '\0'`,
 *    synthesizes a persistent UTF-8 directory path under `ONE_XGR_SAVE_ROOT\xgs\<Hex16Xuid>_<scid>\PlayFabGameSaves`
 *    (with fallback to `<AppData>\Packages\<PFN>\SystemAppData\xgs\PlayFabGameSaves`),
 *    recursively creates all parent directories, and passes a patched `PFGameSaveInitArgs` copy.
 * 2. `PFGameSaveFilesSetUiCallbacks` / `PFGameSaveFilesAddUserWithUiAsync`: when the game has not
 *    registered custom UI callbacks, installs non-blocking headless UI callbacks so in-proc sync
 *    never stalls or fails with `E_PF_GAMESAVE_USER_CANCELLED` due to missing stock GamingServices UI.
 * 3. `PFGameSaveFilesUploadWithUiAsync` / `PFGameSaveFilesUninitializeAsync`: if the game exits
 *    without calling `PFGameSaveFilesUploadWithUiAsync(..., ReleaseDeviceAsActive, ...)` (a Console/Windows
 *    out-of-proc habit), triggers a bounded (<= 5000 ms) `ReleaseDeviceAsActive` upload when online
 *    before forwarding `PFGameSaveFilesUninitializeAsync`.
 */

#include "xgr_internal.h"

/* PFGameSaveFilesUi*UserAction & PFGameSaveFilesUploadOption ordinals (PFGameSaveFilesUi.h) */
#define XGR_PF_CONFLICT_CANCEL                  0u
#define XGR_PF_CONFLICT_TAKE_LOCAL              1u
#define XGR_PF_CONFLICT_TAKE_REMOTE             2u

#define XGR_PF_SYNC_FAILED_CANCEL               0u
#define XGR_PF_SYNC_FAILED_RETRY                1u
#define XGR_PF_SYNC_FAILED_USE_OFFLINE          2u

#define XGR_PF_CONTENTION_CANCEL                0u
#define XGR_PF_CONTENTION_RETRY                 1u
#define XGR_PF_CONTENTION_SYNC_LAST_SAVED_DATA  2u

#define XGR_PF_OUT_OF_STORAGE_CANCEL            0u
#define XGR_PF_OUT_OF_STORAGE_RETRY             1u

#define XGR_PF_UPLOAD_KEEP_DEVICE_ACTIVE        0u
#define XGR_PF_UPLOAD_RELEASE_DEVICE_AS_ACTIVE  1u

#define XGR_PF_PRE_UNINIT_UPLOAD_TIMEOUT_MS     5000u

typedef HRESULT (WINAPI *PFN_PFGameSaveFilesInitialize)(const XGR_PFGameSaveInitArgs *args);
typedef HRESULT (WINAPI *PFN_PFGameSaveFilesSetUiCallbacks)(const XGR_PFGameSaveUICallbacks *callbacks);
typedef HRESULT (WINAPI *PFN_PFGameSaveFilesAddUserWithUiAsync)(XUserHandle localUser, uint32_t options, XAsyncBlock *async);
typedef HRESULT (WINAPI *PFN_PFGameSaveFilesUploadWithUiAsync)(XUserHandle localUser, uint32_t option, XAsyncBlock *async);
typedef HRESULT (WINAPI *PFN_PFGameSaveFilesUninitializeAsync)(XAsyncBlock *async);

typedef HRESULT (WINAPI *PFN_PFGameSaveFilesSetUiSyncFailedResponse)(XUserHandle localUser, uint32_t action);
typedef HRESULT (WINAPI *PFN_PFGameSaveFilesSetUiActiveDeviceContentionResponse)(XUserHandle localUser, uint32_t action);
typedef HRESULT (WINAPI *PFN_PFGameSaveFilesSetUiConflictResponse)(XUserHandle localUser, uint32_t action);
typedef HRESULT (WINAPI *PFN_PFGameSaveFilesSetUiOutOfStorageResponse)(XUserHandle localUser, uint32_t action);

static SRWLOCK g_pf_lock = SRWLOCK_INIT;
static xgr_playfab_proc_resolver_fn g_pf_test_resolver = NULL;
static volatile LONG g_pf_uninit_timeout_ms = (LONG)XGR_PF_PRE_UNINIT_UPLOAD_TIMEOUT_MS;

static PFN_PFGameSaveFilesInitialize g_real_Initialize = NULL;
static PFN_PFGameSaveFilesSetUiCallbacks g_real_SetUiCallbacks = NULL;
static PFN_PFGameSaveFilesAddUserWithUiAsync g_real_AddUserWithUiAsync = NULL;
static PFN_PFGameSaveFilesUploadWithUiAsync g_real_UploadWithUiAsync = NULL;
static PFN_PFGameSaveFilesUninitializeAsync g_real_UninitializeAsync = NULL;

static PFN_PFGameSaveFilesSetUiSyncFailedResponse g_real_SetUiSyncFailedResponse = NULL;
static PFN_PFGameSaveFilesSetUiActiveDeviceContentionResponse g_real_SetUiContentionResponse = NULL;
static PFN_PFGameSaveFilesSetUiConflictResponse g_real_SetUiConflictResponse = NULL;
static PFN_PFGameSaveFilesSetUiOutOfStorageResponse g_real_SetUiOutOfStorageResponse = NULL;

static char g_pf_resolved_save_folder[1024] = { 0 };
static XUserHandle g_pf_active_user = NULL;
static bool g_pf_active_user_owned = false;

static volatile LONG g_pf_game_set_ui_callbacks = 0;
static volatile LONG g_pf_default_ui_installed = 0;
static volatile LONG g_pf_uploaded_release_active = 0;
static volatile LONG g_pf_in_add_user = 0;
static volatile LONG g_pf_sync_retry_count = 0;
static volatile LONG g_pf_oos_retry_count = 0;

void xgr_playfab_set_symbol_resolver_for_test(xgr_playfab_proc_resolver_fn resolver)
{
    AcquireSRWLockExclusive(&g_pf_lock);
    g_pf_test_resolver = resolver;
    ReleaseSRWLockExclusive(&g_pf_lock);
}

void xgr_playfab_set_uninit_timeout_ms_for_test(uint32_t timeout_ms)
{
    if (timeout_ms == 0 || timeout_ms > XGR_PF_PRE_UNINIT_UPLOAD_TIMEOUT_MS) {
        timeout_ms = XGR_PF_PRE_UNINIT_UPLOAD_TIMEOUT_MS;
    }
    InterlockedExchange(&g_pf_uninit_timeout_ms, (LONG)timeout_ms);
}

static void pf_set_active_user(XUserHandle new_user)
{
    XUserHandle stored_user = NULL;
    bool stored_owned = false;
    if (new_user) {
        if (SUCCEEDED(xgr_user_duplicate(new_user, &stored_user)) && stored_user) {
            stored_owned = true;
        } else {
            /* Opaque external handle not tracked in local xuser registry; retain without closing. */
            stored_user = new_user;
            stored_owned = false;
        }
    }
    AcquireSRWLockExclusive(&g_pf_lock);
    XUserHandle old_user = g_pf_active_user;
    bool old_owned = g_pf_active_user_owned;
    g_pf_active_user = stored_user;
    g_pf_active_user_owned = stored_owned;
    ReleaseSRWLockExclusive(&g_pf_lock);
    if (old_user && old_owned) {
        xgr_user_close(old_user);
    }
}

void xgr_playfab_shim_reset(void)
{
    XUserHandle old_user = NULL;
    bool old_owned = false;
    AcquireSRWLockExclusive(&g_pf_lock);
    g_real_Initialize = NULL;
    g_real_SetUiCallbacks = NULL;
    g_real_AddUserWithUiAsync = NULL;
    g_real_UploadWithUiAsync = NULL;
    g_real_UninitializeAsync = NULL;
    g_real_SetUiSyncFailedResponse = NULL;
    g_real_SetUiContentionResponse = NULL;
    g_real_SetUiConflictResponse = NULL;
    g_real_SetUiOutOfStorageResponse = NULL;
    memset(g_pf_resolved_save_folder, 0, sizeof(g_pf_resolved_save_folder));
    old_user = g_pf_active_user;
    old_owned = g_pf_active_user_owned;
    g_pf_active_user = NULL;
    g_pf_active_user_owned = false;
    ReleaseSRWLockExclusive(&g_pf_lock);

    if (old_user && old_owned) {
        xgr_user_close(old_user);
    }

    InterlockedExchange(&g_pf_uninit_timeout_ms, (LONG)XGR_PF_PRE_UNINIT_UPLOAD_TIMEOUT_MS);
    InterlockedExchange(&g_pf_game_set_ui_callbacks, 0);
    InterlockedExchange(&g_pf_default_ui_installed, 0);
    InterlockedExchange(&g_pf_uploaded_release_active, 0);
    InterlockedExchange(&g_pf_in_add_user, 0);
    InterlockedExchange(&g_pf_sync_retry_count, 0);
    InterlockedExchange(&g_pf_oos_retry_count, 0);
}

static void *resolve_playfab_export(const char *proc_name)
{
    if (!proc_name || !proc_name[0]) return NULL;

    AcquireSRWLockShared(&g_pf_lock);
    xgr_playfab_proc_resolver_fn test_fn = g_pf_test_resolver;
    ReleaseSRWLockShared(&g_pf_lock);

    if (test_fn) {
        return test_fn(proc_name);
    }

#ifdef _WIN32
    HMODULE hPf = GetModuleHandleW(L"PlayFabGameSave.dll");
    if (hPf) {
        return (void *)GetProcAddress(hPf, proc_name);
    }
#endif
    return NULL;
}

void *xgr_playfab_resolve_iat_replacement(const char *fn_name, void *orig_proc)
{
    if (!fn_name || !fn_name[0]) return NULL;

    if (strcmp(fn_name, "PFGameSaveFilesInitialize") == 0) {
        if (orig_proc && orig_proc != (void *)xgr_pf_shim_PFGameSaveFilesInitialize) {
            AcquireSRWLockExclusive(&g_pf_lock);
            if (!g_real_Initialize) g_real_Initialize = (PFN_PFGameSaveFilesInitialize)orig_proc;
            ReleaseSRWLockExclusive(&g_pf_lock);
        }
        return (void *)xgr_pf_shim_PFGameSaveFilesInitialize;
    }
    if (strcmp(fn_name, "PFGameSaveFilesSetUiCallbacks") == 0) {
        if (orig_proc && orig_proc != (void *)xgr_pf_shim_PFGameSaveFilesSetUiCallbacks) {
            AcquireSRWLockExclusive(&g_pf_lock);
            if (!g_real_SetUiCallbacks) g_real_SetUiCallbacks = (PFN_PFGameSaveFilesSetUiCallbacks)orig_proc;
            ReleaseSRWLockExclusive(&g_pf_lock);
        }
        return (void *)xgr_pf_shim_PFGameSaveFilesSetUiCallbacks;
    }
    if (strcmp(fn_name, "PFGameSaveFilesAddUserWithUiAsync") == 0) {
        if (orig_proc && orig_proc != (void *)xgr_pf_shim_PFGameSaveFilesAddUserWithUiAsync) {
            AcquireSRWLockExclusive(&g_pf_lock);
            if (!g_real_AddUserWithUiAsync) g_real_AddUserWithUiAsync = (PFN_PFGameSaveFilesAddUserWithUiAsync)orig_proc;
            ReleaseSRWLockExclusive(&g_pf_lock);
        }
        return (void *)xgr_pf_shim_PFGameSaveFilesAddUserWithUiAsync;
    }
    if (strcmp(fn_name, "PFGameSaveFilesUploadWithUiAsync") == 0) {
        if (orig_proc && orig_proc != (void *)xgr_pf_shim_PFGameSaveFilesUploadWithUiAsync) {
            AcquireSRWLockExclusive(&g_pf_lock);
            if (!g_real_UploadWithUiAsync) g_real_UploadWithUiAsync = (PFN_PFGameSaveFilesUploadWithUiAsync)orig_proc;
            ReleaseSRWLockExclusive(&g_pf_lock);
        }
        return (void *)xgr_pf_shim_PFGameSaveFilesUploadWithUiAsync;
    }
    if (strcmp(fn_name, "PFGameSaveFilesUninitializeAsync") == 0) {
        if (orig_proc && orig_proc != (void *)xgr_pf_shim_PFGameSaveFilesUninitializeAsync) {
            AcquireSRWLockExclusive(&g_pf_lock);
            if (!g_real_UninitializeAsync) g_real_UninitializeAsync = (PFN_PFGameSaveFilesUninitializeAsync)orig_proc;
            ReleaseSRWLockExclusive(&g_pf_lock);
        }
        return (void *)xgr_pf_shim_PFGameSaveFilesUninitializeAsync;
    }
    return NULL;
}

static void create_single_dir_utf8(const char *dir_utf8)
{
    if (!dir_utf8 || !dir_utf8[0]) return;
    WCHAR wpath[1024] = { 0 };
    if (MultiByteToWideChar(CP_UTF8, 0, dir_utf8, -1, wpath, 1024) > 0) {
        CreateDirectoryW(wpath, NULL);
    }
}

static void ensure_directory_tree_utf8(const char *full_path)
{
    if (!full_path || !full_path[0]) return;
    char partial[1024];
    snprintf(partial, sizeof(partial), "%s", full_path);

    size_t len = strlen(partial);
    size_t start = 0;
    if (len >= 3 &&
        ((partial[0] >= 'A' && partial[0] <= 'Z') || (partial[0] >= 'a' && partial[0] <= 'z')) &&
        partial[1] == ':' &&
        (partial[2] == '\\' || partial[2] == '/')) {
        start = 3;
    } else if (partial[0] == '/' || partial[0] == '\\') {
        start = 1;
    }

    for (size_t i = start; i < len; i++) {
        if (partial[i] == '\\' || partial[i] == '/') {
            char saved = partial[i];
            partial[i] = '\0';
            if (partial[0]) create_single_dir_utf8(partial);
            partial[i] = saved;
        }
    }
    create_single_dir_utf8(partial);
}

static bool ends_with_xgs_segment(const char *path)
{
    if (!path) return false;
    size_t len = strlen(path);
    if (len < 4) return false;
    const char *tail = path + (len - 4);
    return (tail[0] == '\\' || tail[0] == '/') &&
           (tail[1] == 'x' || tail[1] == 'X') &&
           (tail[2] == 'g' || tail[2] == 'G') &&
           (tail[3] == 's' || tail[3] == 'S');
}

static void trim_trailing_seps(char *path)
{
    if (!path) return;
    size_t len = strlen(path);
    size_t min_len = 1;
    if (len >= 3 && path[1] == ':' && (path[2] == '\\' || path[2] == '/')) {
        min_len = 3;
    }
    while (len > min_len && (path[len - 1] == '\\' || path[len - 1] == '/')) {
        path[--len] = '\0';
    }
}

static void resolve_and_create_playfab_save_folder_locked(char *out_buf, size_t out_cap)
{
    struct xgr_runtime_config_snapshot cfg;
    xgr_copy_runtime_config_snapshot(&cfg);

    uint64_t xuid = xgr_user_get_primary_xuid();
    char xuid_hex[32] = { 0 };
    if (xuid != 0) {
        snprintf(xuid_hex, sizeof(xuid_hex), "%016llX", (unsigned long long)xuid);
    }

    char save_root[MAX_PATH] = { 0 };
    if (cfg.saveRootUtf8[0]) {
        snprintf(save_root, sizeof(save_root), "%s", cfg.saveRootUtf8);
    } else if (!xgr_get_env_utf8(L"ONE_XGR_SAVE_ROOT", save_root, sizeof(save_root))) {
        xgr_get_env_utf8(L"ONE_LAUNCHER_XBOX_SAVE_ROOT", save_root, sizeof(save_root));
    }
    trim_trailing_seps(save_root);

    const char *safe_scid = xgr_is_safe_path_segment(cfg.scid, 128) ? cfg.scid : "";
    if (save_root[0]) {
        char sep = (save_root[0] == '/') ? '/' : '\\';
        char user_scid_seg[192] = { 0 };
        if (xuid_hex[0] && safe_scid[0]) {
            snprintf(user_scid_seg, sizeof(user_scid_seg), "%s_%s", xuid_hex, safe_scid);
        } else if (xuid_hex[0]) {
            snprintf(user_scid_seg, sizeof(user_scid_seg), "%s", xuid_hex);
        } else if (safe_scid[0]) {
            snprintf(user_scid_seg, sizeof(user_scid_seg), "0000000000000000_%s", safe_scid);
        } else {
            strcpy(user_scid_seg, "default");
        }

        if (ends_with_xgs_segment(save_root)) {
            snprintf(out_buf, out_cap, "%s%c%s%cPlayFabGameSaves", save_root, sep, user_scid_seg, sep);
        } else {
            snprintf(out_buf, out_cap, "%s%cxgs%c%s%cPlayFabGameSaves", save_root, sep, sep, user_scid_seg, sep);
        }
    } else {
        char appdata[MAX_PATH] = { 0 };
        if (!xgr_get_env_utf8(L"ONE_XGR_APPDATA_DIR", appdata, sizeof(appdata)) || !appdata[0]) {
            if (!xgr_get_env_utf8(L"LOCALAPPDATA", appdata, sizeof(appdata)) || !appdata[0]) {
                strcpy(appdata, "C:\\Users\\Public\\AppData\\Local");
            }
        }
        trim_trailing_seps(appdata);
        char sep = (appdata[0] == '/') ? '/' : '\\';
        const char *pfn = xgr_is_safe_path_segment(cfg.packageFamilyName, 256)
            ? cfg.packageFamilyName
            : "OneLauncher.Default_8wekyb3d8bbwe";
        snprintf(
            out_buf,
            out_cap,
            "%s%cPackages%c%s%cSystemAppData%cxgs%cPlayFabGameSaves",
            appdata, sep, sep, pfn, sep, sep, sep
        );
    }

    ensure_directory_tree_utf8(out_buf);
}

/* -------------------------------------------------------------------------
 * Default Headless Non-Blocking UI Callbacks
 * ------------------------------------------------------------------------- */

static PFN_PFGameSaveFilesSetUiSyncFailedResponse get_sync_failed_resp_fn(void)
{
    AcquireSRWLockShared(&g_pf_lock);
    PFN_PFGameSaveFilesSetUiSyncFailedResponse fn = g_real_SetUiSyncFailedResponse;
    ReleaseSRWLockShared(&g_pf_lock);
    if (fn) return fn;

    fn = (PFN_PFGameSaveFilesSetUiSyncFailedResponse)resolve_playfab_export("PFGameSaveFilesSetUiSyncFailedResponse");
    if (fn) {
        AcquireSRWLockExclusive(&g_pf_lock);
        g_real_SetUiSyncFailedResponse = fn;
        ReleaseSRWLockExclusive(&g_pf_lock);
    }
    return fn;
}

static PFN_PFGameSaveFilesSetUiActiveDeviceContentionResponse get_contention_resp_fn(void)
{
    AcquireSRWLockShared(&g_pf_lock);
    PFN_PFGameSaveFilesSetUiActiveDeviceContentionResponse fn = g_real_SetUiContentionResponse;
    ReleaseSRWLockShared(&g_pf_lock);
    if (fn) return fn;

    fn = (PFN_PFGameSaveFilesSetUiActiveDeviceContentionResponse)resolve_playfab_export(
        "PFGameSaveFilesSetUiActiveDeviceContentionResponse"
    );
    if (fn) {
        AcquireSRWLockExclusive(&g_pf_lock);
        g_real_SetUiContentionResponse = fn;
        ReleaseSRWLockExclusive(&g_pf_lock);
    }
    return fn;
}

static PFN_PFGameSaveFilesSetUiConflictResponse get_conflict_resp_fn(void)
{
    AcquireSRWLockShared(&g_pf_lock);
    PFN_PFGameSaveFilesSetUiConflictResponse fn = g_real_SetUiConflictResponse;
    ReleaseSRWLockShared(&g_pf_lock);
    if (fn) return fn;

    fn = (PFN_PFGameSaveFilesSetUiConflictResponse)resolve_playfab_export("PFGameSaveFilesSetUiConflictResponse");
    if (fn) {
        AcquireSRWLockExclusive(&g_pf_lock);
        g_real_SetUiConflictResponse = fn;
        ReleaseSRWLockExclusive(&g_pf_lock);
    }
    return fn;
}

static PFN_PFGameSaveFilesSetUiOutOfStorageResponse get_oos_resp_fn(void)
{
    AcquireSRWLockShared(&g_pf_lock);
    PFN_PFGameSaveFilesSetUiOutOfStorageResponse fn = g_real_SetUiOutOfStorageResponse;
    ReleaseSRWLockShared(&g_pf_lock);
    if (fn) return fn;

    fn = (PFN_PFGameSaveFilesSetUiOutOfStorageResponse)resolve_playfab_export("PFGameSaveFilesSetUiOutOfStorageResponse");
    if (fn) {
        AcquireSRWLockExclusive(&g_pf_lock);
        g_real_SetUiOutOfStorageResponse = fn;
        ReleaseSRWLockExclusive(&g_pf_lock);
    }
    return fn;
}

static void CALLBACK pf_default_progress_cb(XUserHandle localUser, uint32_t syncState, void *context)
{
    /* Informational progress notification; calling SetUiProgressResponse(Cancel=0) would abort sync. */
    (void)localUser;
    (void)syncState;
    (void)context;
}

static void CALLBACK pf_default_sync_failed_cb(XUserHandle localUser, uint32_t syncState, HRESULT error, void *context)
{
    (void)syncState;
    (void)error;
    (void)context;

    PFN_PFGameSaveFilesSetUiSyncFailedResponse resp_fn = get_sync_failed_resp_fn();
    if (!resp_fn) return;

    bool in_add_user = (InterlockedCompareExchange(&g_pf_in_add_user, 0, 0) != 0);
    if (!xgr_is_offline_mode() && InterlockedIncrement(&g_pf_sync_retry_count) <= 1) {
        resp_fn(localUser, XGR_PF_SYNC_FAILED_RETRY);
        return;
    }

    /* Per PlayFab GDK contract, UseOffline (2) is valid during AddUserWithUiAsync; Upload uses Cancel (0). */
    resp_fn(localUser, in_add_user ? XGR_PF_SYNC_FAILED_USE_OFFLINE : XGR_PF_SYNC_FAILED_CANCEL);
}

static void CALLBACK pf_default_contention_cb(
    XUserHandle localUser,
    void *localGameSave,
    void *remoteGameSave,
    void *context
)
{
    (void)localGameSave;
    (void)remoteGameSave;
    (void)context;

    PFN_PFGameSaveFilesSetUiActiveDeviceContentionResponse resp_fn = get_contention_resp_fn();
    if (resp_fn) {
        resp_fn(localUser, XGR_PF_CONTENTION_SYNC_LAST_SAVED_DATA);
    }
}

static void CALLBACK pf_default_conflict_cb(
    XUserHandle localUser,
    void *localGameSave,
    void *remoteGameSave,
    void *context
)
{
    (void)localGameSave;
    (void)remoteGameSave;
    (void)context;

    PFN_PFGameSaveFilesSetUiConflictResponse resp_fn = get_conflict_resp_fn();
    if (resp_fn) {
        resp_fn(localUser, XGR_PF_CONFLICT_TAKE_LOCAL);
    }
}

static void CALLBACK pf_default_out_of_storage_cb(XUserHandle localUser, uint64_t requiredBytes, void *context)
{
    (void)requiredBytes;
    (void)context;

    PFN_PFGameSaveFilesSetUiOutOfStorageResponse resp_fn = get_oos_resp_fn();
    if (!resp_fn) return;

    if (InterlockedIncrement(&g_pf_oos_retry_count) <= 1) {
        resp_fn(localUser, XGR_PF_OUT_OF_STORAGE_RETRY);
    } else {
        resp_fn(localUser, XGR_PF_OUT_OF_STORAGE_CANCEL);
    }
}

static void ensure_default_ui_callbacks_installed(void)
{
    if (InterlockedCompareExchange(&g_pf_game_set_ui_callbacks, 0, 0) != 0) {
        return;
    }
    if (InterlockedCompareExchange(&g_pf_default_ui_installed, 1, 0) != 0) {
        return;
    }

    AcquireSRWLockShared(&g_pf_lock);
    PFN_PFGameSaveFilesSetUiCallbacks set_fn = g_real_SetUiCallbacks;
    ReleaseSRWLockShared(&g_pf_lock);

    if (!set_fn) {
        set_fn = (PFN_PFGameSaveFilesSetUiCallbacks)resolve_playfab_export("PFGameSaveFilesSetUiCallbacks");
        if (set_fn) {
            AcquireSRWLockExclusive(&g_pf_lock);
            g_real_SetUiCallbacks = set_fn;
            ReleaseSRWLockExclusive(&g_pf_lock);
        }
    }
    if (!set_fn) {
        InterlockedExchange(&g_pf_default_ui_installed, 0);
        return;
    }

    /* Warm response function pointers if available */
    (void)resolve_playfab_export("PFGameSaveFilesSetUiProgressResponse");
    (void)get_sync_failed_resp_fn();
    (void)get_contention_resp_fn();
    (void)get_conflict_resp_fn();
    (void)get_oos_resp_fn();

    XGR_PFGameSaveUICallbacks cbs;
    memset(&cbs, 0, sizeof(cbs));
    cbs.progressCallback = pf_default_progress_cb;
    cbs.syncFailedCallback = pf_default_sync_failed_cb;
    cbs.activeDeviceContentionCallback = pf_default_contention_cb;
    cbs.conflictCallback = pf_default_conflict_cb;
    cbs.outOfStorageCallback = pf_default_out_of_storage_cb;

    if (FAILED(set_fn(&cbs))) {
        InterlockedExchange(&g_pf_default_ui_installed, 0);
    }
}

/* -------------------------------------------------------------------------
 * Intercepted PlayFabGameSave.dll Entrypoints
 * ------------------------------------------------------------------------- */

HRESULT WINAPI xgr_pf_shim_PFGameSaveFilesInitialize(const XGR_PFGameSaveInitArgs *args)
{
    AcquireSRWLockShared(&g_pf_lock);
    PFN_PFGameSaveFilesInitialize real_fn = g_real_Initialize;
    ReleaseSRWLockShared(&g_pf_lock);

    if (!real_fn) {
        real_fn = (PFN_PFGameSaveFilesInitialize)resolve_playfab_export("PFGameSaveFilesInitialize");
        if (real_fn) {
            AcquireSRWLockExclusive(&g_pf_lock);
            g_real_Initialize = real_fn;
            ReleaseSRWLockExclusive(&g_pf_lock);
        }
    }
    if (!real_fn) {
        return xgr_return_hr(E_NOTIMPL);
    }

    InterlockedExchange(&g_pf_uploaded_release_active, 0);
    InterlockedExchange(&g_pf_sync_retry_count, 0);
    InterlockedExchange(&g_pf_oos_retry_count, 0);

    if (args && (!args->saveFolder || args->saveFolder[0] == '\0')) {
        xgr_ensure_session_metadata_loaded();
        XGR_PFGameSaveInitArgs patched = *args;
        char folder_copy[1024] = { 0 };
        AcquireSRWLockExclusive(&g_pf_lock);
        resolve_and_create_playfab_save_folder_locked(
            g_pf_resolved_save_folder,
            sizeof(g_pf_resolved_save_folder)
        );
        snprintf(folder_copy, sizeof(folder_copy), "%s", g_pf_resolved_save_folder);
        ReleaseSRWLockExclusive(&g_pf_lock);

        patched.saveFolder = folder_copy;
        HRESULT hr = real_fn(&patched);
        return xgr_return_hr(hr);
    }

    HRESULT hr = real_fn(args);
    return xgr_return_hr(hr);
}

HRESULT WINAPI xgr_pf_shim_PFGameSaveFilesSetUiCallbacks(const XGR_PFGameSaveUICallbacks *callbacks)
{
    AcquireSRWLockShared(&g_pf_lock);
    PFN_PFGameSaveFilesSetUiCallbacks real_fn = g_real_SetUiCallbacks;
    ReleaseSRWLockShared(&g_pf_lock);

    if (!real_fn) {
        real_fn = (PFN_PFGameSaveFilesSetUiCallbacks)resolve_playfab_export("PFGameSaveFilesSetUiCallbacks");
        if (real_fn) {
            AcquireSRWLockExclusive(&g_pf_lock);
            g_real_SetUiCallbacks = real_fn;
            ReleaseSRWLockExclusive(&g_pf_lock);
        }
    }
    if (!real_fn) {
        return xgr_return_hr(E_NOTIMPL);
    }

    if (callbacks != NULL) {
        InterlockedExchange(&g_pf_game_set_ui_callbacks, 1);
    } else {
        InterlockedExchange(&g_pf_game_set_ui_callbacks, 0);
        InterlockedExchange(&g_pf_default_ui_installed, 0);
    }
    HRESULT hr = real_fn(callbacks);
    return xgr_return_hr(hr);
}

HRESULT WINAPI xgr_pf_shim_PFGameSaveFilesAddUserWithUiAsync(
    XUserHandle localUser,
    uint32_t options,
    XAsyncBlock *async
)
{
    AcquireSRWLockShared(&g_pf_lock);
    PFN_PFGameSaveFilesAddUserWithUiAsync real_fn = g_real_AddUserWithUiAsync;
    ReleaseSRWLockShared(&g_pf_lock);

    if (!real_fn) {
        real_fn = (PFN_PFGameSaveFilesAddUserWithUiAsync)resolve_playfab_export("PFGameSaveFilesAddUserWithUiAsync");
        if (real_fn) {
            AcquireSRWLockExclusive(&g_pf_lock);
            g_real_AddUserWithUiAsync = real_fn;
            ReleaseSRWLockExclusive(&g_pf_lock);
        }
    }
    if (!real_fn) {
        return xgr_return_hr(E_NOTIMPL);
    }

    /* Ensure session metadata (XUID/locale/offline state) is loaded when RPC is active */
    xgr_ensure_session_metadata_loaded();

    pf_set_active_user(localUser);

    InterlockedExchange(&g_pf_uploaded_release_active, 0);
    InterlockedExchange(&g_pf_sync_retry_count, 0);
    InterlockedExchange(&g_pf_oos_retry_count, 0);
    InterlockedExchange(&g_pf_in_add_user, 1);

    ensure_default_ui_callbacks_installed();

    HRESULT hr = real_fn(localUser, options, async);
    return xgr_return_hr(hr);
}

HRESULT WINAPI xgr_pf_shim_PFGameSaveFilesUploadWithUiAsync(
    XUserHandle localUser,
    uint32_t option,
    XAsyncBlock *async
)
{
    AcquireSRWLockShared(&g_pf_lock);
    PFN_PFGameSaveFilesUploadWithUiAsync real_fn = g_real_UploadWithUiAsync;
    ReleaseSRWLockShared(&g_pf_lock);

    if (!real_fn) {
        real_fn = (PFN_PFGameSaveFilesUploadWithUiAsync)resolve_playfab_export("PFGameSaveFilesUploadWithUiAsync");
        if (real_fn) {
            AcquireSRWLockExclusive(&g_pf_lock);
            g_real_UploadWithUiAsync = real_fn;
            ReleaseSRWLockExclusive(&g_pf_lock);
        }
    }
    if (!real_fn) {
        return xgr_return_hr(E_NOTIMPL);
    }

    InterlockedExchange(&g_pf_in_add_user, 0);
    InterlockedExchange(&g_pf_sync_retry_count, 0);

    if (localUser) {
        pf_set_active_user(localUser);
    }
    if (option == XGR_PF_UPLOAD_RELEASE_DEVICE_AS_ACTIVE) {
        InterlockedExchange(&g_pf_uploaded_release_active, 1);
    }

    HRESULT hr = real_fn(localUser, option, async);
    return xgr_return_hr(hr);
}

typedef struct PfPreUninitCtx {
    XAsyncBlock upload_ab;
    XAsyncBlock inner_uninit_ab;
    XAsyncBlock *game_uninit_async;
    PFN_PFGameSaveFilesUninitializeAsync real_uninit;
    XUserHandle user;
    bool user_owned;
    uint32_t timeout_ms;
    CRITICAL_SECTION wd_cs;
    CONDITION_VARIABLE wd_cv;
    bool upload_done;
    volatile LONG refs;
    volatile LONG uninit_dispatched;
    volatile LONG inner_uninit_done;
    volatile LONG upload_cb_ran;
    volatile LONG uninit_hr;
} PfPreUninitCtx;

static void pf_pre_uninit_ctx_release(PfPreUninitCtx *ctx)
{
    if (!ctx) return;
    if (InterlockedDecrement(&ctx->refs) == 0) {
        DeleteCriticalSection(&ctx->wd_cs);
        if (ctx->user && ctx->user_owned) {
            xgr_user_close(ctx->user);
        }
        free(ctx);
    }
}

static HRESULT CALLBACK pf_pre_uninit_async_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    PfPreUninitCtx *ctx = data ? (PfPreUninitCtx *)data->context : NULL;
    switch (op) {
        case XAsyncOp_Begin:
            /* Completion is driven explicitly by pf_inner_uninit_done_cb / timeout path. */
            return S_OK;
        case XAsyncOp_GetResult:
            return S_OK;
        case XAsyncOp_Cleanup:
            pf_pre_uninit_ctx_release(ctx);
            return S_OK;
        default:
            return S_OK;
    }
}

static void CALLBACK pf_inner_uninit_done_cb(XAsyncBlock *ab)
{
    if (!ab || !ab->context) return;
    PfPreUninitCtx *ctx = (PfPreUninitCtx *)ab->context;
    if (InterlockedCompareExchange(&ctx->inner_uninit_done, 1, 0) == 0) {
        HRESULT hr = (HRESULT)InterlockedCompareExchange(&ctx->uninit_hr, 0, 0);
        if (ctx->game_uninit_async) {
            xgr_async_complete(ctx->game_uninit_async, hr, 0);
        }
    }
    pf_pre_uninit_ctx_release(ctx);
}

static void pf_pre_uninit_dispatch_real_uninit(PfPreUninitCtx *ctx)
{
    if (!ctx) return;
    if (InterlockedCompareExchange(&ctx->uninit_dispatched, 1, 0) != 0) {
        return;
    }
    InterlockedExchange(&g_pf_default_ui_installed, 0);

    InterlockedIncrement(&ctx->refs); /* Owned by pf_inner_uninit_done_cb */
    memset(&ctx->inner_uninit_ab, 0, sizeof(ctx->inner_uninit_ab));
    ctx->inner_uninit_ab.queue = ctx->game_uninit_async ? ctx->game_uninit_async->queue : NULL;
    ctx->inner_uninit_ab.context = ctx;
    ctx->inner_uninit_ab.callback = pf_inner_uninit_done_cb;

    HRESULT hr = ctx->real_uninit(&ctx->inner_uninit_ab);
    InterlockedExchange(&ctx->uninit_hr, (LONG)hr);
    if (FAILED(hr)) {
        if (InterlockedCompareExchange(&ctx->inner_uninit_done, 1, 0) == 0) {
            if (ctx->game_uninit_async) {
                xgr_async_complete(ctx->game_uninit_async, hr, 0);
            }
            pf_pre_uninit_ctx_release(ctx);
        }
    }
}

static void CALLBACK pf_pre_uninit_upload_done_cb(XAsyncBlock *ab)
{
    if (!ab || !ab->context) return;
    PfPreUninitCtx *ctx = (PfPreUninitCtx *)ab->context;
    InterlockedExchange(&ctx->upload_cb_ran, 1);

    EnterCriticalSection(&ctx->wd_cs);
    ctx->upload_done = true;
    WakeAllConditionVariable(&ctx->wd_cv);
    LeaveCriticalSection(&ctx->wd_cs);

    pf_pre_uninit_dispatch_real_uninit(ctx);
    pf_pre_uninit_ctx_release(ctx);
}

static DWORD WINAPI pf_pre_uninit_watchdog_thread(LPVOID param)
{
    PfPreUninitCtx *ctx = (PfPreUninitCtx *)param;
    if (!ctx) return 0;

    ULONGLONG deadline = GetTickCount64() + (ULONGLONG)ctx->timeout_ms;
    EnterCriticalSection(&ctx->wd_cs);
    while (!ctx->upload_done) {
        ULONGLONG now = GetTickCount64();
        if (now >= deadline) break;
        DWORD rem = (DWORD)(deadline - now);
        SleepConditionVariableCS(&ctx->wd_cv, &ctx->wd_cs, rem);
    }
    LeaveCriticalSection(&ctx->wd_cs);

    /* If the background upload stalled beyond the bounded timeout, proceed with uninit now. */
    pf_pre_uninit_dispatch_real_uninit(ctx);
    pf_pre_uninit_ctx_release(ctx);
    return 0;
}

HRESULT WINAPI xgr_pf_shim_PFGameSaveFilesUninitializeAsync(XAsyncBlock *async)
{
    AcquireSRWLockShared(&g_pf_lock);
    PFN_PFGameSaveFilesUninitializeAsync real_uninit = g_real_UninitializeAsync;
    PFN_PFGameSaveFilesUploadWithUiAsync real_upload = g_real_UploadWithUiAsync;
    ReleaseSRWLockShared(&g_pf_lock);

    if (!real_uninit) {
        real_uninit = (PFN_PFGameSaveFilesUninitializeAsync)resolve_playfab_export("PFGameSaveFilesUninitializeAsync");
        if (real_uninit) {
            AcquireSRWLockExclusive(&g_pf_lock);
            g_real_UninitializeAsync = real_uninit;
            ReleaseSRWLockExclusive(&g_pf_lock);
        }
    }
    if (!real_uninit) {
        return xgr_return_hr(E_NOTIMPL);
    }

    InterlockedExchange(&g_pf_in_add_user, 0);

    AcquireSRWLockExclusive(&g_pf_lock);
    XUserHandle active_user = g_pf_active_user;
    bool active_user_owned = g_pf_active_user_owned;
    g_pf_active_user = NULL;
    g_pf_active_user_owned = false;
    ReleaseSRWLockExclusive(&g_pf_lock);

    if (async != NULL &&
        InterlockedExchange(&g_pf_uploaded_release_active, 1) == 0 &&
        active_user != NULL &&
        !xgr_is_offline_mode()) {
        if (!real_upload) {
            real_upload = (PFN_PFGameSaveFilesUploadWithUiAsync)resolve_playfab_export("PFGameSaveFilesUploadWithUiAsync");
            if (real_upload) {
                AcquireSRWLockExclusive(&g_pf_lock);
                g_real_UploadWithUiAsync = real_upload;
                ReleaseSRWLockExclusive(&g_pf_lock);
            }
        }
        if (real_upload) {
            PfPreUninitCtx *ctx = (PfPreUninitCtx *)calloc(1, sizeof(*ctx));
            if (ctx) {
                InitializeCriticalSection(&ctx->wd_cs);
                InitializeConditionVariable(&ctx->wd_cv);
                InterlockedExchange(&g_pf_sync_retry_count, 0);

                uint32_t timeout_ms = (uint32_t)InterlockedCompareExchange(&g_pf_uninit_timeout_ms, 0, 0);
                if (timeout_ms == 0 || timeout_ms > XGR_PF_PRE_UNINIT_UPLOAD_TIMEOUT_MS) {
                    timeout_ms = XGR_PF_PRE_UNINIT_UPLOAD_TIMEOUT_MS;
                }

                ctx->game_uninit_async = async;
                ctx->real_uninit = real_uninit;
                ctx->user = active_user;
                ctx->user_owned = active_user_owned;
                ctx->timeout_ms = timeout_ms;
                active_user = NULL;
                active_user_owned = false;

                /* Ref 1: caller, Ref 2: xgr_async_begin (Cleanup) */
                ctx->refs = 2;
                ctx->uninit_hr = (LONG)S_OK;

                /* Register caller's XAsyncBlock as E_PENDING BEFORE starting background upload
                 * so XAsyncGetStatus(async, true) waits cleanly until real_uninit completes (no UAF!). */
                HRESULT bhr = xgr_async_begin(
                    async,
                    ctx,
                    (const void *)xgr_pf_shim_PFGameSaveFilesUninitializeAsync,
                    "PFGameSaveFilesUninitializeAsync",
                    pf_pre_uninit_async_provider
                );
                if (SUCCEEDED(bhr)) {
                    InterlockedIncrement(&ctx->refs); /* Ref 3: pf_pre_uninit_upload_done_cb */
                    ctx->upload_ab.queue = async->queue;
                    ctx->upload_ab.context = ctx;
                    ctx->upload_ab.callback = pf_pre_uninit_upload_done_cb;

                    HRESULT uhr = real_upload(ctx->user, XGR_PF_UPLOAD_RELEASE_DEVICE_AS_ACTIVE, &ctx->upload_ab);
                    if (SUCCEEDED(uhr)) {
                        /* Only spawn bounded watchdog if upload did not already complete synchronously. */
                        if (InterlockedCompareExchange(&ctx->uninit_dispatched, 0, 0) == 0) {
                            InterlockedIncrement(&ctx->refs); /* Ref 4: watchdog thread */
                            HANDLE wd = CreateThread(NULL, 0, pf_pre_uninit_watchdog_thread, ctx, 0, NULL);
                            if (wd) {
                                CloseHandle(wd);
                            } else {
                                pf_pre_uninit_ctx_release(ctx);
                            }
                        }
                        HRESULT hr = (InterlockedCompareExchange(&ctx->uninit_dispatched, 0, 0) != 0)
                            ? (HRESULT)InterlockedCompareExchange(&ctx->uninit_hr, 0, 0)
                            : S_OK;
                        pf_pre_uninit_ctx_release(ctx);
                        return xgr_return_hr(hr);
                    }

                    /* Upload failed synchronously: release upload ref if callback didn't fire, then run uninit. */
                    if (InterlockedCompareExchange(&ctx->upload_cb_ran, 0, 0) == 0) {
                        pf_pre_uninit_ctx_release(ctx);
                    }
                    pf_pre_uninit_dispatch_real_uninit(ctx);
                    HRESULT hr = (HRESULT)InterlockedCompareExchange(&ctx->uninit_hr, 0, 0);
                    pf_pre_uninit_ctx_release(ctx);
                    return xgr_return_hr(hr);
                }

                /* xgr_async_begin failed: restore user and fall through to direct real_uninit(async). */
                active_user = ctx->user;
                active_user_owned = ctx->user_owned;
                ctx->user = NULL;
                ctx->user_owned = false;
                DeleteCriticalSection(&ctx->wd_cs);
                free(ctx);
            }
        }
    }

    if (active_user && active_user_owned) {
        xgr_user_close(active_user);
    }

    InterlockedExchange(&g_pf_default_ui_installed, 0);

    HRESULT hr = real_uninit(async);
    return xgr_return_hr(hr);
}
