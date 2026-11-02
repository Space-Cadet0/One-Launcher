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

typedef HRESULT (WINAPI *PFN_PFGameSaveFilesSetUiProgressResponse)(XUserHandle localUser, uint32_t action);
typedef HRESULT (WINAPI *PFN_PFGameSaveFilesSetUiSyncFailedResponse)(XUserHandle localUser, uint32_t action);
typedef HRESULT (WINAPI *PFN_PFGameSaveFilesSetUiActiveDeviceContentionResponse)(XUserHandle localUser, uint32_t action);
typedef HRESULT (WINAPI *PFN_PFGameSaveFilesSetUiConflictResponse)(XUserHandle localUser, uint32_t action);
typedef HRESULT (WINAPI *PFN_PFGameSaveFilesSetUiOutOfStorageResponse)(XUserHandle localUser, uint32_t action);

static SRWLOCK g_pf_lock = SRWLOCK_INIT;
static xgr_playfab_proc_resolver_fn g_pf_test_resolver = NULL;

static PFN_PFGameSaveFilesInitialize g_real_Initialize = NULL;
static PFN_PFGameSaveFilesSetUiCallbacks g_real_SetUiCallbacks = NULL;
static PFN_PFGameSaveFilesAddUserWithUiAsync g_real_AddUserWithUiAsync = NULL;
static PFN_PFGameSaveFilesUploadWithUiAsync g_real_UploadWithUiAsync = NULL;
static PFN_PFGameSaveFilesUninitializeAsync g_real_UninitializeAsync = NULL;

static PFN_PFGameSaveFilesSetUiProgressResponse g_real_SetUiProgressResponse = NULL;
static PFN_PFGameSaveFilesSetUiSyncFailedResponse g_real_SetUiSyncFailedResponse = NULL;
static PFN_PFGameSaveFilesSetUiActiveDeviceContentionResponse g_real_SetUiContentionResponse = NULL;
static PFN_PFGameSaveFilesSetUiConflictResponse g_real_SetUiConflictResponse = NULL;
static PFN_PFGameSaveFilesSetUiOutOfStorageResponse g_real_SetUiOutOfStorageResponse = NULL;

static char g_pf_resolved_save_folder[1024] = { 0 };
static XUserHandle g_pf_active_user = NULL;

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

void xgr_playfab_shim_reset(void)
{
    AcquireSRWLockExclusive(&g_pf_lock);
    g_real_Initialize = NULL;
    g_real_SetUiCallbacks = NULL;
    g_real_AddUserWithUiAsync = NULL;
    g_real_UploadWithUiAsync = NULL;
    g_real_UninitializeAsync = NULL;
    g_real_SetUiProgressResponse = NULL;
    g_real_SetUiSyncFailedResponse = NULL;
    g_real_SetUiContentionResponse = NULL;
    g_real_SetUiConflictResponse = NULL;
    g_real_SetUiOutOfStorageResponse = NULL;
    memset(g_pf_resolved_save_folder, 0, sizeof(g_pf_resolved_save_folder));
    g_pf_active_user = NULL;
    ReleaseSRWLockExclusive(&g_pf_lock);

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

    if (save_root[0]) {
        char sep = (save_root[0] == '/') ? '/' : '\\';
        char user_scid_seg[192] = { 0 };
        if (xuid_hex[0] && cfg.scid[0]) {
            snprintf(user_scid_seg, sizeof(user_scid_seg), "%s_%s", xuid_hex, cfg.scid);
        } else if (xuid_hex[0]) {
            snprintf(user_scid_seg, sizeof(user_scid_seg), "%s", xuid_hex);
        } else if (cfg.scid[0]) {
            snprintf(user_scid_seg, sizeof(user_scid_seg), "0000000000000000_%s", cfg.scid);
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
        const char *pfn = cfg.packageFamilyName[0] ? cfg.packageFamilyName : "OneLauncher.Default_8wekyb3d8bbwe";
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
        AcquireSRWLockExclusive(&g_pf_lock);
        resolve_and_create_playfab_save_folder_locked(
            g_pf_resolved_save_folder,
            sizeof(g_pf_resolved_save_folder)
        );
        patched.saveFolder = g_pf_resolved_save_folder;
        ReleaseSRWLockExclusive(&g_pf_lock);

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

    InterlockedExchange(&g_pf_game_set_ui_callbacks, callbacks != NULL ? 1 : 0);
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

    AcquireSRWLockExclusive(&g_pf_lock);
    g_pf_active_user = localUser;
    ReleaseSRWLockExclusive(&g_pf_lock);

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
        AcquireSRWLockExclusive(&g_pf_lock);
        g_pf_active_user = localUser;
        ReleaseSRWLockExclusive(&g_pf_lock);
    }
    if (option == XGR_PF_UPLOAD_RELEASE_DEVICE_AS_ACTIVE) {
        InterlockedExchange(&g_pf_uploaded_release_active, 1);
    }

    HRESULT hr = real_fn(localUser, option, async);
    return xgr_return_hr(hr);
}

static void CALLBACK pf_pre_uninit_upload_done_cb(XAsyncBlock *ab)
{
    if (ab && ab->context) {
        SetEvent((HANDLE)ab->context);
    }
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
    g_pf_active_user = NULL;
    ReleaseSRWLockExclusive(&g_pf_lock);

    if (InterlockedExchange(&g_pf_uploaded_release_active, 1) == 0 &&
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
            InterlockedExchange(&g_pf_sync_retry_count, 0);
            HANDLE ev = CreateEventW(NULL, TRUE, FALSE, NULL);
            XAsyncBlock upload_ab;
            memset(&upload_ab, 0, sizeof(upload_ab));
            upload_ab.context = (void *)ev;
            upload_ab.callback = pf_pre_uninit_upload_done_cb;

            HRESULT uhr = real_upload(active_user, XGR_PF_UPLOAD_RELEASE_DEVICE_AS_ACTIVE, &upload_ab);
            if (SUCCEEDED(uhr) && ev != NULL) {
                (void)WaitForSingleObject(ev, XGR_PF_PRE_UNINIT_UPLOAD_TIMEOUT_MS);
            }
            if (ev != NULL) {
                CloseHandle(ev);
            }
        }
    }

    InterlockedExchange(&g_pf_default_ui_installed, 0);

    HRESULT hr = real_uninit(async);
    return xgr_return_hr(hr);
}
