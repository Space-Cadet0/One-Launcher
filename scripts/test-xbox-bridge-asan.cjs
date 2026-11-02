#!/usr/bin/env node
'use strict';

/**
 * Layer 1 Host Clang C11 `-fsanitize=address,undefined` Sanitizer Runner
 * (`scripts/test-xbox-bridge-asan.cjs`, D9D / Sec 12.2 + Wave 2A)
 *
 * Compiles and executes:
 *  1. `tests/native/xgr_bridge_asan_test.c`
 *  2. Wave 2A C11 sanitizer suite (`xgr_playfab_shim.c`, `XPackage` DLC + locale,
 *     `XStoreQueryLicenseTokenAsync` + `XStorePrice`, `GameInvite`/`GameProtocol` dispatch)
 * together with the production C11 translation units in `electron/helpers/xgr_bridge/`
 * under strict `-std=c11 -O1 -g -fshort-wchar -fsanitize=address,undefined -fno-omit-frame-pointer -Wall -Wextra -Werror`.
 *
 * - On macOS (`darwin`) and Linux, compilation and execution are mandatory.
 * - On Windows (`win32`), probes whether `clang` + POSIX/ASan runtime are available;
 *   skips cleanly with exit code 0 if Windows runners lack POSIX headers/ASan runtime.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_PATH = path.join(ROOT_DIR, 'tests', 'native', 'xgr_bridge_asan_test.c');
const NATIVE_TEST_DIR = path.join(ROOT_DIR, 'tests', 'native');
const WIN32_SHIM_INC = path.join(ROOT_DIR, 'tests', 'native', 'win32_shim');
const XGR_BRIDGE_DIR = path.join(ROOT_DIR, 'electron', 'helpers', 'xgr_bridge');

const PRODUCTION_TUS = [
  'main.c',
  'xgr_playfab_shim.c',
  'xthreading.c',
  'xuser.c',
  'xstore.c',
  'xpackage.c',
  'xsystem_misc.c',
].map((name) => path.join(XGR_BRIDGE_DIR, name));

const WAVE2A_ASAN_TEST_SOURCE = String.raw`/*
 * One Launcher — Wave 2A Host Clang C11 ASan + UBSan Sanitizer Suite
 *
 * Exercises under -fsanitize=address,undefined -Wall -Wextra -Werror:
 *   1. PlayFab PlayFabGameSave.dll dynamic in-proc shim (xgr_playfab_shim.c):
 *      - IAT export replacement resolution for all 5 intercepted entrypoints
 *      - PFGameSaveFilesInitialize NULL/empty saveFolder synthesis & recursive directory creation
 *      - Headless UI callbacks (progress, syncFailed retry -> UseOffline/Cancel, conflict TakeLocal,
 *        contention SyncLastSavedData, outOfStorage retry -> Cancel)
 *      - Bounded pre-uninitialize ReleaseDeviceAsActive upload when online (and skip when offline or already uploaded)
 *   2. XPackageGetUserLocale (session locale + bounds check) & XPackageKind_Content DLC enumeration/mounting/storeId lookup
 *   3. XStoreQueryLicenseTokenAsync (xstore.queryLicenseToken JSON payload) & XStoreProduct/XStorePrice parsing
 *   4. IXGameInviteImpl2 & IXGameProtocolImpl callback registration, async XTaskQueue dispatch, deduplication, and Unreg
 *   5. UninitializeApiImpl() + g_win32_live_allocs == 0 zero-leak invariant
 */

#define WIN32_HOST_SHIM_IMPLEMENTATION
#include <dirent.h>
#include <math.h>
#include "xgr_internal.h"

HRESULT WINAPI InitializeApiImplEx2(ULONG gdkVer, ULONG gsVer, char mode, const struct xgr_initialize_options *options);
HRESULT WINAPI UninitializeApiImpl(void);

static HMODULE g_w2a_bridge_hmod = NULL;
static bool g_w2a_xcurl_active = false;

void xgr_set_bridge_hmodule(HMODULE hmod) { g_w2a_bridge_hmod = hmod; }
void xgr_install_xcurl_shim(void) { g_w2a_xcurl_active = true; }
void xgr_ensure_xcurl_shim(void) { g_w2a_xcurl_active = true; }
bool xgr_is_xcurl_shim_active(void) { return g_w2a_xcurl_active; }
void xgr_uninstall_xcurl_shim(void) { g_w2a_xcurl_active = false; }

#include "xgr_xml_pfn.c"

#define xgr_rpc_is_configured xgr_rpc_is_configured_socket_impl
#define xgr_rpc_call          xgr_rpc_call_socket_impl
#include "xgr_rpc.c"
#undef xgr_rpc_is_configured
#undef xgr_rpc_call

typedef HRESULT (*xgr_mock_rpc_fn)(const char *method, const char *params_json_obj, char **out_result_json);
static xgr_mock_rpc_fn g_w2a_mock_rpc = NULL;

bool xgr_rpc_is_configured(void)
{
    if (g_w2a_mock_rpc != NULL) return true;
    return xgr_rpc_is_configured_socket_impl();
}

HRESULT xgr_rpc_call(const char *method, const char *params_json_obj, char **out_result_json)
{
    if (g_w2a_mock_rpc != NULL) {
        if (out_result_json) *out_result_json = NULL;
        return g_w2a_mock_rpc(method, params_json_obj, out_result_json);
    }
    return xgr_rpc_call_socket_impl(method, params_json_obj, out_result_json);
}

#include "xgamesave.c"

#define DllMain appnotify_DllMain
#if !defined(_WIN32) && defined(__x86_64__)
#define XGR_HOST_RESTORE_X86_64 1
#undef __x86_64__
#endif
#include "appnotify_bridge.c"
#ifdef XGR_HOST_RESTORE_X86_64
#define __x86_64__ 1
#undef XGR_HOST_RESTORE_X86_64
#endif
#undef DllMain

#define ASSERT_TRUE(cond)                                                                      \
    do {                                                                                       \
        if (!(cond)) {                                                                         \
            fprintf(stderr, "[W2A-ASAN-FAIL] %s:%d: assertion failed: %s\n", __FILE__,         \
                    __LINE__, #cond);                                                          \
            abort();                                                                           \
        }                                                                                      \
    } while (0)

#define ASSERT_HR_EQ(actual, expected)                                                         \
    do {                                                                                       \
        HRESULT _a = (actual);                                                                 \
        HRESULT _e = (expected);                                                               \
        if (_a != _e) {                                                                        \
            fprintf(stderr, "[W2A-ASAN-FAIL] %s:%d: HRESULT 0x%08X != expected 0x%08X\n",      \
                    __FILE__, __LINE__, (unsigned int)_a, (unsigned int)_e);                   \
            abort();                                                                           \
        }                                                                                      \
    } while (0)

static void remove_tree_posix(const char *dir_path)
{
    if (!dir_path || !dir_path[0]) return;
    DIR *d = opendir(dir_path);
    if (!d) {
        unlink(dir_path);
        return;
    }
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
        char child[4096];
        snprintf(child, sizeof(child), "%s/%s", dir_path, ent->d_name);
        struct stat st;
        if (lstat(child, &st) == 0 && S_ISDIR(st.st_mode)) {
            remove_tree_posix(child);
        } else {
            unlink(child);
        }
    }
    closedir(d);
    rmdir(dir_path);
}

/* -------------------------------------------------------------------------
 * Mock RPC Handler for Wave 2A Session, DLC, Locale & XStore Tests
 * ------------------------------------------------------------------------- */

static char g_last_license_token_params[1024] = { 0 };

static HRESULT w2a_mock_rpc_handler(const char *method, const char *params_json_obj, char **out_result_json)
{
    if (strcmp(method, "session.init") == 0) {
        const char *resp =
            "{"
            "\"xuid\":\"2533274790395904\","
            "\"gamertag\":\"OnePlayer\","
            "\"offline\":false,"
            "\"locale\":\"ja-JP\","
            "\"scid\":\"00000000-0000-0000-0000-00006743210a\","
            "\"titleId\":\"1732452618\","
            "\"storeId\":\"9NBASEGAME01\","
            "\"packageFamilyName\":\"TestPublisher.BaseGame_8wekyb3d8bbwe\","
            "\"packageIdentifier\":\"9NBASEGAME01_onelauncher\","
            "\"dlcPackages\":["
                "{"
                "\"packageIdentifier\":\"9NDLCEXP0001_dlc_a1b2c3d4e5f6\","
                "\"storeId\":\"9NDLCEXP0001\","
                "\"displayName\":\"Expansion Pack 1\","
                "\"version\":\"1.2.3.4\","
                "\"mountPath\":\"C:\\\\Games\\\\TestGame_DLC1\""
                "},"
                "{"
                "\"packageIdentifier\":\"9NDLCEXP0002_dlc_f6e5d4c3b2a1\","
                "\"storeId\":\"9NDLCEXP0002\","
                "\"displayName\":\"Expansion Pack 2\","
                "\"version\":\"2.0.1.0\","
                "\"mountPath\":\"C:\\\\Games\\\\TestGame_DLC2\""
                "}"
            "]"
            "}";
        *out_result_json = strdup(resp);
        return S_OK;
    }

    if (strcmp(method, "xstore.queryLicenseToken") == 0) {
        snprintf(
            g_last_license_token_params,
            sizeof(g_last_license_token_params),
            "%s",
            params_json_obj ? params_json_obj : ""
        );
        *out_result_json = strdup("{\"token\":\"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJwcm9kdWN0SWRzIjpbIjlOQkFTRUdBTUUwMSJdfQ.sig\"}");
        return S_OK;
    }

    if (strcmp(method, "xstore.queryProducts") == 0) {
        const char *resp =
            "{\"products\":[{"
            "\"storeId\":\"9NDLCEXP0001\","
            "\"title\":\"Expansion Pack 1\","
            "\"description\":\"Story Expansion\","
            "\"language\":\"ja-JP\","
            "\"inAppOfferToken\":\"offer.expansion.1\","
            "\"productKind\":2,"
            "\"hasDigitalDownload\":true,"
            "\"isInUserCollection\":true,"
            "\"skuId\":\"0010\","
            "\"price\":{"
                "\"basePrice\":29.99,"
                "\"price\":19.99,"
                "\"currencyCode\":\"USD\","
                "\"formattedBasePrice\":\"$29.99\","
                "\"formattedPrice\":\"$19.99\","
                "\"formattedRecurrencePrice\":\"\","
                "\"isOnSale\":true"
            "}"
            "}]}";
        *out_result_json = strdup(resp);
        return S_OK;
    }

    *out_result_json = strdup("{}");
    return S_OK;
}

/* -------------------------------------------------------------------------
 * Mock PlayFabGameSave.dll Exports for Shim Verification
 * ------------------------------------------------------------------------- */

static char g_pf_captured_save_folder[1024] = { 0 };
static bool g_pf_init_had_nonnull_folder = false;
static XGR_PFGameSaveUICallbacks g_pf_captured_cbs;
static int g_pf_set_ui_calls = 0;
static int g_pf_add_user_calls = 0;
static int g_pf_upload_calls = 0;
static uint32_t g_pf_last_upload_option = 999u;
static int g_pf_uninit_calls = 0;
static bool g_pf_upload_ran_before_uninit = false;

static int g_pf_progress_resp_calls = 0;
static uint32_t g_pf_sync_failed_actions[8];
static int g_pf_sync_failed_count = 0;
static uint32_t g_pf_contention_action = 999u;
static uint32_t g_pf_conflict_action = 999u;
static uint32_t g_pf_oos_actions[8];
static int g_pf_oos_count = 0;

static HRESULT WINAPI mock_PFGameSaveFilesInitialize(const XGR_PFGameSaveInitArgs *args)
{
    if (!args) return E_INVALIDARG;
    g_pf_init_had_nonnull_folder = (args->saveFolder != NULL);
    snprintf(
        g_pf_captured_save_folder,
        sizeof(g_pf_captured_save_folder),
        "%s",
        args->saveFolder ? args->saveFolder : ""
    );
    return S_OK;
}

static HRESULT WINAPI mock_PFGameSaveFilesSetUiCallbacks(const XGR_PFGameSaveUICallbacks *callbacks)
{
    g_pf_set_ui_calls++;
    if (callbacks) {
        g_pf_captured_cbs = *callbacks;
    } else {
        memset(&g_pf_captured_cbs, 0, sizeof(g_pf_captured_cbs));
    }
    return S_OK;
}

static HRESULT WINAPI mock_PFGameSaveFilesAddUserWithUiAsync(XUserHandle localUser, uint32_t options, XAsyncBlock *async)
{
    (void)localUser;
    (void)options;
    g_pf_add_user_calls++;
    if (async && async->callback) {
        async->callback(async);
    }
    return S_OK;
}

static HRESULT WINAPI mock_PFGameSaveFilesUploadWithUiAsync(XUserHandle localUser, uint32_t option, XAsyncBlock *async)
{
    (void)localUser;
    g_pf_upload_calls++;
    g_pf_last_upload_option = option;
    if (async && async->callback) {
        async->callback(async);
    }
    return S_OK;
}

static HRESULT WINAPI mock_PFGameSaveFilesUninitializeAsync(XAsyncBlock *async)
{
    if (g_pf_upload_calls > 0 && g_pf_last_upload_option == 1u) {
        g_pf_upload_ran_before_uninit = true;
    }
    g_pf_uninit_calls++;
    if (async && async->callback) {
        async->callback(async);
    }
    return S_OK;
}

static HRESULT WINAPI mock_PFGameSaveFilesSetUiProgressResponse(XUserHandle localUser, uint32_t action)
{
    (void)localUser;
    (void)action;
    g_pf_progress_resp_calls++;
    return S_OK;
}

static HRESULT WINAPI mock_PFGameSaveFilesSetUiSyncFailedResponse(XUserHandle localUser, uint32_t action)
{
    (void)localUser;
    if (g_pf_sync_failed_count < 8) {
        g_pf_sync_failed_actions[g_pf_sync_failed_count++] = action;
    }
    return S_OK;
}

static HRESULT WINAPI mock_PFGameSaveFilesSetUiActiveDeviceContentionResponse(XUserHandle localUser, uint32_t action)
{
    (void)localUser;
    g_pf_contention_action = action;
    return S_OK;
}

static HRESULT WINAPI mock_PFGameSaveFilesSetUiConflictResponse(XUserHandle localUser, uint32_t action)
{
    (void)localUser;
    g_pf_conflict_action = action;
    return S_OK;
}

static HRESULT WINAPI mock_PFGameSaveFilesSetUiOutOfStorageResponse(XUserHandle localUser, uint32_t action)
{
    (void)localUser;
    if (g_pf_oos_count < 8) {
        g_pf_oos_actions[g_pf_oos_count++] = action;
    }
    return S_OK;
}

static void *w2a_playfab_resolver(const char *proc_name)
{
    if (strcmp(proc_name, "PFGameSaveFilesInitialize") == 0) return (void *)mock_PFGameSaveFilesInitialize;
    if (strcmp(proc_name, "PFGameSaveFilesSetUiCallbacks") == 0) return (void *)mock_PFGameSaveFilesSetUiCallbacks;
    if (strcmp(proc_name, "PFGameSaveFilesAddUserWithUiAsync") == 0) return (void *)mock_PFGameSaveFilesAddUserWithUiAsync;
    if (strcmp(proc_name, "PFGameSaveFilesUploadWithUiAsync") == 0) return (void *)mock_PFGameSaveFilesUploadWithUiAsync;
    if (strcmp(proc_name, "PFGameSaveFilesUninitializeAsync") == 0) return (void *)mock_PFGameSaveFilesUninitializeAsync;
    if (strcmp(proc_name, "PFGameSaveFilesSetUiProgressResponse") == 0) return (void *)mock_PFGameSaveFilesSetUiProgressResponse;
    if (strcmp(proc_name, "PFGameSaveFilesSetUiSyncFailedResponse") == 0) return (void *)mock_PFGameSaveFilesSetUiSyncFailedResponse;
    if (strcmp(proc_name, "PFGameSaveFilesSetUiActiveDeviceContentionResponse") == 0) return (void *)mock_PFGameSaveFilesSetUiActiveDeviceContentionResponse;
    if (strcmp(proc_name, "PFGameSaveFilesSetUiConflictResponse") == 0) return (void *)mock_PFGameSaveFilesSetUiConflictResponse;
    if (strcmp(proc_name, "PFGameSaveFilesSetUiOutOfStorageResponse") == 0) return (void *)mock_PFGameSaveFilesSetUiOutOfStorageResponse;
    return NULL;
}

/* -------------------------------------------------------------------------
 * Test 1: PlayFabGameSave.dll Dynamic In-Proc Shim
 * ------------------------------------------------------------------------- */
static void test_playfab_inproc_shim(void)
{
    xgr_playfab_shim_reset();
    xgr_playfab_set_symbol_resolver_for_test(w2a_playfab_resolver);

    /* 1a. IAT replacement resolver check */
    ASSERT_TRUE(xgr_playfab_resolve_iat_replacement("PFGameSaveFilesInitialize", (void *)mock_PFGameSaveFilesInitialize) == (void *)xgr_pf_shim_PFGameSaveFilesInitialize);
    ASSERT_TRUE(xgr_playfab_resolve_iat_replacement("PFGameSaveFilesSetUiCallbacks", (void *)mock_PFGameSaveFilesSetUiCallbacks) == (void *)xgr_pf_shim_PFGameSaveFilesSetUiCallbacks);
    ASSERT_TRUE(xgr_playfab_resolve_iat_replacement("PFGameSaveFilesAddUserWithUiAsync", (void *)mock_PFGameSaveFilesAddUserWithUiAsync) == (void *)xgr_pf_shim_PFGameSaveFilesAddUserWithUiAsync);
    ASSERT_TRUE(xgr_playfab_resolve_iat_replacement("PFGameSaveFilesUploadWithUiAsync", (void *)mock_PFGameSaveFilesUploadWithUiAsync) == (void *)xgr_pf_shim_PFGameSaveFilesUploadWithUiAsync);
    ASSERT_TRUE(xgr_playfab_resolve_iat_replacement("PFGameSaveFilesUninitializeAsync", (void *)mock_PFGameSaveFilesUninitializeAsync) == (void *)xgr_pf_shim_PFGameSaveFilesUninitializeAsync);
    ASSERT_TRUE(xgr_playfab_resolve_iat_replacement("PFGameSaveFilesGetFolderSize", NULL) == NULL);

    /* Prime session metadata (XUID + SCID + online mode) */
    xgr_ensure_session_metadata_loaded();
    ASSERT_TRUE(xgr_user_get_primary_xuid() == 2533274790395904ULL);

    /* 1b. PFGameSaveFilesInitialize with saveFolder == NULL synthesizes & creates persistent directory */
    setenv("ONE_XGR_SAVE_ROOT", "C:\\Users\\crossover\\SavedGames", 1);
    XGR_PFGameSaveInitArgs init_args;
    memset(&init_args, 0, sizeof(init_args));
    init_args.options = 0;
    init_args.saveFolder = NULL;

    ASSERT_HR_EQ(xgr_pf_shim_PFGameSaveFilesInitialize(&init_args), S_OK);
    ASSERT_TRUE(g_pf_init_had_nonnull_folder);
    ASSERT_TRUE(
        strcmp(
            g_pf_captured_save_folder,
            "C:\\Users\\crossover\\SavedGames\\xgs\\0009000000000000_00000000-0000-0000-0000-00006743210a\\PlayFabGameSaves"
        ) == 0
    );

    char expected_posix_dir[4096];
    snprintf(
        expected_posix_dir,
        sizeof(expected_posix_dir),
        "%s/Users/crossover/SavedGames/xgs/0009000000000000_00000000-0000-0000-0000-00006743210a/PlayFabGameSaves",
        g_win32_virtual_c_root
    );
    struct stat st;
    ASSERT_TRUE(stat(expected_posix_dir, &st) == 0 && S_ISDIR(st.st_mode));

    /* Explicit saveFolder is preserved verbatim */
    XGR_PFGameSaveInitArgs custom_args;
    memset(&custom_args, 0, sizeof(custom_args));
    custom_args.saveFolder = "C:\\CustomPlayFabFolder";
    ASSERT_HR_EQ(xgr_pf_shim_PFGameSaveFilesInitialize(&custom_args), S_OK);
    ASSERT_TRUE(strcmp(g_pf_captured_save_folder, "C:\\CustomPlayFabFolder") == 0);

    /* 1c. PFGameSaveFilesAddUserWithUiAsync installs headless UI callbacks when game hasn't set any */
    XUserHandle fake_user = (XUserHandle)(uintptr_t)0xCAFE1234u;
    XAsyncBlock ab;
    memset(&ab, 0, sizeof(ab));
    ASSERT_HR_EQ(xgr_pf_shim_PFGameSaveFilesAddUserWithUiAsync(fake_user, 0u, &ab), S_OK);
    ASSERT_TRUE(g_pf_add_user_calls == 1);
    ASSERT_TRUE(g_pf_set_ui_calls == 1);
    ASSERT_TRUE(g_pf_captured_cbs.progressCallback != NULL);
    ASSERT_TRUE(g_pf_captured_cbs.syncFailedCallback != NULL);
    ASSERT_TRUE(g_pf_captured_cbs.activeDeviceContentionCallback != NULL);
    ASSERT_TRUE(g_pf_captured_cbs.conflictCallback != NULL);
    ASSERT_TRUE(g_pf_captured_cbs.outOfStorageCallback != NULL);

    /* Progress callback must NOT cancel sync */
    g_pf_captured_cbs.progressCallback(fake_user, 1u, NULL);
    ASSERT_TRUE(g_pf_progress_resp_calls == 0);

    /* SyncFailed during AddUserWithUiAsync: 1st -> Retry (1), 2nd -> UseOffline (2) */
    g_pf_sync_failed_count = 0;
    g_pf_captured_cbs.syncFailedCallback(fake_user, 1u, E_FAIL, NULL);
    g_pf_captured_cbs.syncFailedCallback(fake_user, 1u, E_FAIL, NULL);
    ASSERT_TRUE(g_pf_sync_failed_count == 2);
    ASSERT_TRUE(g_pf_sync_failed_actions[0] == 1u); /* Retry */
    ASSERT_TRUE(g_pf_sync_failed_actions[1] == 2u); /* UseOffline */

    /* Contention -> SyncLastSavedData (2), Conflict -> TakeLocal (1) */
    g_pf_captured_cbs.activeDeviceContentionCallback(fake_user, NULL, NULL, NULL);
    ASSERT_TRUE(g_pf_contention_action == 2u);
    g_pf_captured_cbs.conflictCallback(fake_user, NULL, NULL, NULL);
    ASSERT_TRUE(g_pf_conflict_action == 1u);

    /* OutOfStorage -> 1st Retry (1), 2nd Cancel (0) */
    g_pf_oos_count = 0;
    g_pf_captured_cbs.outOfStorageCallback(fake_user, 4096ULL, NULL);
    g_pf_captured_cbs.outOfStorageCallback(fake_user, 4096ULL, NULL);
    ASSERT_TRUE(g_pf_oos_count == 2);
    ASSERT_TRUE(g_pf_oos_actions[0] == 1u);
    ASSERT_TRUE(g_pf_oos_actions[1] == 0u);

    /* SyncFailed during UploadWithUiAsync(KeepDeviceActive=0): 1st -> Retry (1), 2nd -> Cancel (0) */
    g_pf_upload_calls = 0;
    g_pf_sync_failed_count = 0;
    ASSERT_HR_EQ(xgr_pf_shim_PFGameSaveFilesUploadWithUiAsync(fake_user, 0u /* KeepDeviceActive */, &ab), S_OK);
    ASSERT_TRUE(g_pf_upload_calls == 1);
    g_pf_captured_cbs.syncFailedCallback(fake_user, 2u, E_FAIL, NULL);
    g_pf_captured_cbs.syncFailedCallback(fake_user, 2u, E_FAIL, NULL);
    ASSERT_TRUE(g_pf_sync_failed_count == 2);
    ASSERT_TRUE(g_pf_sync_failed_actions[0] == 1u); /* Retry */
    ASSERT_TRUE(g_pf_sync_failed_actions[1] == 0u); /* Cancel */

    /* 1d. Pre-uninitialize ReleaseDeviceAsActive upload when game didn't release active device */
    g_pf_upload_calls = 0;
    g_pf_last_upload_option = 999u;
    g_pf_uninit_calls = 0;
    g_pf_upload_ran_before_uninit = false;
    ASSERT_HR_EQ(xgr_pf_shim_PFGameSaveFilesUninitializeAsync(&ab), S_OK);
    ASSERT_TRUE(g_pf_upload_calls == 1);
    ASSERT_TRUE(g_pf_last_upload_option == 1u); /* ReleaseDeviceAsActive */
    ASSERT_TRUE(g_pf_upload_ran_before_uninit);
    ASSERT_TRUE(g_pf_uninit_calls == 1);

    /* When game explicitly uploads with ReleaseDeviceAsActive (1), UninitializeAsync must NOT double-upload */
    ASSERT_HR_EQ(xgr_pf_shim_PFGameSaveFilesAddUserWithUiAsync(fake_user, 0u, &ab), S_OK);
    ASSERT_HR_EQ(xgr_pf_shim_PFGameSaveFilesUploadWithUiAsync(fake_user, 1u /* ReleaseDeviceAsActive */, &ab), S_OK);
    int uploads_before = g_pf_upload_calls;
    ASSERT_HR_EQ(xgr_pf_shim_PFGameSaveFilesUninitializeAsync(&ab), S_OK);
    ASSERT_TRUE(g_pf_upload_calls == uploads_before);

    /* When offline mode is active, UninitializeAsync skips upload immediately */
    xgr_set_offline_mode(true);
    ASSERT_HR_EQ(xgr_pf_shim_PFGameSaveFilesAddUserWithUiAsync(fake_user, 0u, &ab), S_OK);
    uploads_before = g_pf_upload_calls;
    ASSERT_HR_EQ(xgr_pf_shim_PFGameSaveFilesUninitializeAsync(&ab), S_OK);
    ASSERT_TRUE(g_pf_upload_calls == uploads_before);
    xgr_set_offline_mode(false);
}

/* -------------------------------------------------------------------------
 * Test 2: XPackage Locale & DLC (XPackageKind_Content) Enumeration + Mount
 * ------------------------------------------------------------------------- */
struct dlc_enum_capture {
    uint32_t count;
    char ids[4][XGR_PACKAGE_IDENTIFIER_MAX_LEN];
    char store_ids[4][32];
    char names[4][128];
    uint32_t kinds[4];
    XVersion versions[4];
};

static bool CALLBACK capture_dlc_pkg_cb(void *context, const XPackageDetails *details)
{
    struct dlc_enum_capture *cap = (struct dlc_enum_capture *)context;
    if (cap->count < 4 && details) {
        uint32_t idx = cap->count++;
        snprintf(cap->ids[idx], sizeof(cap->ids[idx]), "%s", details->packageIdentifier ? details->packageIdentifier : "");
        snprintf(cap->store_ids[idx], sizeof(cap->store_ids[idx]), "%s", details->storeId ? details->storeId : "");
        snprintf(cap->names[idx], sizeof(cap->names[idx]), "%s", details->displayName ? details->displayName : "");
        cap->kinds[idx] = details->kind;
        cap->versions[idx] = details->version;
    }
    return true;
}

static void test_xpackage_locale_and_dlc_mounting(void)
{
    void *pkg_iface = NULL;
    ASSERT_HR_EQ(QueryApiImpl(&CLSID_XPackageImpl, &IID_IXPackageImpl4, &pkg_iface), S_OK);
    ASSERT_TRUE(pkg_iface != NULL);
    const void *const *vtbl = *(const void *const **)pkg_iface;

    typedef HRESULT (WINAPI *fn_get_locale_t)(void *, size_t, char *);
    typedef HRESULT (WINAPI *fn_enum_pkgs_t)(void *, uint32_t, uint32_t, void *, XPackageEnumerationCallback *);
    typedef HRESULT (WINAPI *fn_get_id_legacy_t)(void *, const char *, SIZE_T, char *);
    typedef HRESULT (WINAPI *fn_mount_legacy_t)(void *, const char *, XPackageMountHandle *);
    typedef HRESULT (WINAPI *fn_get_mount_sz_t)(void *, XPackageMountHandle, SIZE_T *);
    typedef HRESULT (WINAPI *fn_get_mount_path_t)(void *, XPackageMountHandle, SIZE_T, char *);
    typedef void    (WINAPI *fn_close_mount_t)(void *, XPackageMountHandle);
    typedef HRESULT (WINAPI *fn_mount_ui_async_t)(void *, const char *, XAsyncBlock *);
    typedef HRESULT (WINAPI *fn_mount_ui_res_t)(void *, XAsyncBlock *, XPackageMountHandle *);

    fn_get_locale_t pGetLocale = (fn_get_locale_t)vtbl[11];
    fn_mount_legacy_t pMountLegacy = (fn_mount_legacy_t)vtbl[23];
    fn_get_mount_sz_t pGetMountSz = (fn_get_mount_sz_t)vtbl[24];
    fn_get_mount_path_t pGetMountPath = (fn_get_mount_path_t)vtbl[25];
    fn_close_mount_t pCloseMount = (fn_close_mount_t)vtbl[26];
    fn_get_id_legacy_t pGetIdLegacy = (fn_get_id_legacy_t)vtbl[27];
    fn_mount_ui_async_t pMountUiAsync = (fn_mount_ui_async_t)vtbl[37];
    fn_mount_ui_res_t pMountUiRes = (fn_mount_ui_res_t)vtbl[38];
    fn_enum_pkgs_t pEnumPkgs = (fn_enum_pkgs_t)vtbl[39];

    /* Locale bounds check & value from session.init ("ja-JP") */
    char small_loc[4] = { 0 };
    ASSERT_HR_EQ(pGetLocale(pkg_iface, sizeof(small_loc), small_loc), HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER));
    char loc_buf[32] = { 0 };
    ASSERT_HR_EQ(pGetLocale(pkg_iface, sizeof(loc_buf), loc_buf), S_OK);
    ASSERT_TRUE(strcmp(loc_buf, "ja-JP") == 0);

    /* Enumerate XPackageKind_Content (kind == 1) */
    struct dlc_enum_capture cap;
    memset(&cap, 0, sizeof(cap));
    ASSERT_HR_EQ(pEnumPkgs(pkg_iface, 1u /* XPackageKind_Content */, 0u, &cap, capture_dlc_pkg_cb), S_OK);
    ASSERT_TRUE(cap.count == 2);
    ASSERT_TRUE(strcmp(cap.ids[0], "9NDLCEXP0001_dlc_a1b2c3d4e5f6") == 0);
    ASSERT_TRUE(strcmp(cap.store_ids[0], "9NDLCEXP0001") == 0);
    ASSERT_TRUE(strcmp(cap.names[0], "Expansion Pack 1") == 0);
    ASSERT_TRUE(cap.kinds[0] == 1u);
    ASSERT_TRUE(cap.versions[0].major == 1 && cap.versions[0].minor == 2 && cap.versions[0].build == 3 && cap.versions[0].revision == 4);
    ASSERT_TRUE(strcmp(cap.ids[1], "9NDLCEXP0002_dlc_f6e5d4c3b2a1") == 0);

    /* XPackageGetIdentifierLegacy resolves DLC storeId -> DLC packageIdentifier */
    char resolved_id[XGR_PACKAGE_IDENTIFIER_MAX_LEN] = { 0 };
    ASSERT_HR_EQ(pGetIdLegacy(pkg_iface, "9NDLCEXP0002", sizeof(resolved_id), resolved_id), S_OK);
    ASSERT_TRUE(strcmp(resolved_id, "9NDLCEXP0002_dlc_f6e5d4c3b2a1") == 0);

    /* Legacy + WithUiAsync mounting resolves DLC mountPath instead of base game root */
    XPackageMountHandle mh1 = NULL;
    ASSERT_HR_EQ(pMountLegacy(pkg_iface, "9NDLCEXP0001_dlc_a1b2c3d4e5f6", &mh1), S_OK);
    ASSERT_TRUE(mh1 != NULL);
    SIZE_T msz = 0;
    ASSERT_HR_EQ(pGetMountSz(pkg_iface, mh1, &msz), S_OK);
    char mpath[256] = { 0 };
    ASSERT_HR_EQ(pGetMountPath(pkg_iface, mh1, msz, mpath), S_OK);
    ASSERT_TRUE(strcmp(mpath, "C:\\Games\\TestGame_DLC1") == 0);
    pCloseMount(pkg_iface, mh1);

    XAsyncBlock mount_ab;
    memset(&mount_ab, 0, sizeof(mount_ab));
    ASSERT_HR_EQ(pMountUiAsync(pkg_iface, "9NDLCEXP0002_dlc_f6e5d4c3b2a1", &mount_ab), S_OK);
    ASSERT_HR_EQ(xgr_async_get_status(&mount_ab, true), S_OK);
    XPackageMountHandle mh2 = NULL;
    ASSERT_HR_EQ(pMountUiRes(pkg_iface, &mount_ab, &mh2), S_OK);
    ASSERT_TRUE(mh2 != NULL);
    ASSERT_HR_EQ(pGetMountPath(pkg_iface, mh2, sizeof(mpath), mpath), S_OK);
    ASSERT_TRUE(strcmp(mpath, "C:\\Games\\TestGame_DLC2") == 0);
    pCloseMount(pkg_iface, mh2);
}

/* -------------------------------------------------------------------------
 * Test 3: XStoreQueryLicenseTokenAsync & XStoreProduct Price Fields
 * ------------------------------------------------------------------------- */
struct store_prod_capture {
    uint32_t count;
    char store_id[32];
    char offer_token[64];
    float base_price;
    float price;
    bool is_on_sale;
    char currency[16];
    char fmt_base[32];
    char fmt_price[32];
};

static bool CALLBACK capture_store_prod_cb(const XStoreProduct *prod, void *context)
{
    struct store_prod_capture *cap = (struct store_prod_capture *)context;
    if (prod) {
        cap->count++;
        snprintf(cap->store_id, sizeof(cap->store_id), "%s", prod->storeId ? prod->storeId : "");
        snprintf(cap->offer_token, sizeof(cap->offer_token), "%s", prod->inAppOfferToken ? prod->inAppOfferToken : "");
        cap->base_price = prod->price.basePrice;
        cap->price = prod->price.price;
        cap->is_on_sale = prod->price.isOnSale;
        snprintf(cap->currency, sizeof(cap->currency), "%s", prod->price.currencyCode);
        snprintf(cap->fmt_base, sizeof(cap->fmt_base), "%s", prod->price.formattedBasePrice);
        snprintf(cap->fmt_price, sizeof(cap->fmt_price), "%s", prod->price.formattedPrice);
    }
    return true;
}

static void test_xstore_license_token_and_prices(void)
{
    void *store_iface = NULL;
    ASSERT_HR_EQ(QueryApiImpl(&CLSID_XStoreImpl, &IID_IXStoreImpl6, &store_iface), S_OK);
    ASSERT_TRUE(store_iface != NULL);
    const void *const *vtbl = *(const void *const **)store_iface;

    typedef HRESULT (WINAPI *fn_create_ctx_t)(void *, const XUserHandle, XStoreContextHandle *);
    typedef void    (WINAPI *fn_close_ctx_t)(void *, XStoreContextHandle);
    typedef HRESULT (WINAPI *fn_query_prods_async_t)(void *, const XStoreContextHandle, uint32_t, const char **, size_t, const char **, size_t, XAsyncBlock *);
    typedef HRESULT (WINAPI *fn_query_prods_res_t)(void *, XAsyncBlock *, XStoreProductQueryHandle *);
    typedef HRESULT (WINAPI *fn_enum_prods_t)(void *, const XStoreProductQueryHandle, void *, XStoreProductQueryCallback *);
    typedef void    (WINAPI *fn_close_prods_t)(void *, XStoreProductQueryHandle);
    typedef HRESULT (WINAPI *fn_lic_tok_async_t)(void *, const XStoreContextHandle, const char **, size_t, const char *, XAsyncBlock *);
    typedef HRESULT (WINAPI *fn_lic_tok_sz_t)(void *, XAsyncBlock *, size_t *);
    typedef HRESULT (WINAPI *fn_lic_tok_res_t)(void *, XAsyncBlock *, size_t, char *);

    fn_create_ctx_t pCreateCtx = (fn_create_ctx_t)vtbl[3];
    fn_close_ctx_t pCloseCtx = (fn_close_ctx_t)vtbl[4];
    fn_query_prods_async_t pQueryProdsAsync = (fn_query_prods_async_t)vtbl[7];
    fn_query_prods_res_t pQueryProdsRes = (fn_query_prods_res_t)vtbl[8];
    fn_enum_prods_t pEnumProds = (fn_enum_prods_t)vtbl[15];
    fn_close_prods_t pCloseProds = (fn_close_prods_t)vtbl[19];
    fn_lic_tok_async_t pLicTokAsync = (fn_lic_tok_async_t)vtbl[43];
    fn_lic_tok_sz_t pLicTokSz = (fn_lic_tok_sz_t)vtbl[44];
    fn_lic_tok_res_t pLicTokRes = (fn_lic_tok_res_t)vtbl[45];

    XStoreContextHandle sc = NULL;
    ASSERT_HR_EQ(pCreateCtx(store_iface, NULL, &sc), S_OK);
    ASSERT_TRUE(sc != NULL);

    /* 3a. XStoreQueryLicenseTokenAsync */
    const char *pids[2] = { "9NBASEGAME01", "9NDLCEXP0001" };
    XAsyncBlock tok_ab;
    memset(&tok_ab, 0, sizeof(tok_ab));
    ASSERT_HR_EQ(pLicTokAsync(store_iface, sc, pids, 2, "dev-nonce-42", &tok_ab), S_OK);
    ASSERT_HR_EQ(xgr_async_get_status(&tok_ab, true), S_OK);
    ASSERT_TRUE(
        strcmp(
            g_last_license_token_params,
            "{\"productIds\":[\"9NBASEGAME01\",\"9NDLCEXP0001\"],\"customDeveloperString\":\"dev-nonce-42\"}"
        ) == 0
    );

    size_t tok_sz = 0;
    ASSERT_HR_EQ(pLicTokSz(store_iface, &tok_ab, &tok_sz), S_OK);
    const char *expected_jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJwcm9kdWN0SWRzIjpbIjlOQkFTRUdBTUUwMSJdfQ.sig";
    ASSERT_TRUE(tok_sz == strlen(expected_jwt) + 1);
    char *tok_buf = (char *)calloc(1, tok_sz);
    ASSERT_TRUE(tok_buf != NULL);
    ASSERT_HR_EQ(pLicTokRes(store_iface, &tok_ab, tok_sz, tok_buf), S_OK);
    ASSERT_TRUE(strcmp(tok_buf, expected_jwt) == 0);
    free(tok_buf);

    /* 3b. XStoreQueryProductsAsync price & inAppOfferToken hydration */
    const char *q_ids[1] = { "9NDLCEXP0001" };
    XAsyncBlock qp_ab;
    memset(&qp_ab, 0, sizeof(qp_ab));
    ASSERT_HR_EQ(pQueryProdsAsync(store_iface, sc, 0xFFu, q_ids, 1, NULL, 0, &qp_ab), S_OK);
    ASSERT_HR_EQ(xgr_async_get_status(&qp_ab, true), S_OK);

    XStoreProductQueryHandle qh = NULL;
    ASSERT_HR_EQ(pQueryProdsRes(store_iface, &qp_ab, &qh), S_OK);
    ASSERT_TRUE(qh != NULL);

    struct store_prod_capture pcap;
    memset(&pcap, 0, sizeof(pcap));
    ASSERT_HR_EQ(pEnumProds(store_iface, qh, &pcap, capture_store_prod_cb), S_OK);
    ASSERT_TRUE(pcap.count == 1);
    ASSERT_TRUE(strcmp(pcap.store_id, "9NDLCEXP0001") == 0);
    ASSERT_TRUE(strcmp(pcap.offer_token, "offer.expansion.1") == 0);
    ASSERT_TRUE(fabsf(pcap.base_price - 29.99f) < 0.01f);
    ASSERT_TRUE(fabsf(pcap.price - 19.99f) < 0.01f);
    ASSERT_TRUE(pcap.is_on_sale == true);
    ASSERT_TRUE(strcmp(pcap.currency, "USD") == 0);
    ASSERT_TRUE(strcmp(pcap.fmt_base, "$29.99") == 0);
    ASSERT_TRUE(strcmp(pcap.fmt_price, "$19.99") == 0);

    pCloseProds(store_iface, qh);
    pCloseCtx(store_iface, sc);
}

/* -------------------------------------------------------------------------
 * Test 4: GameInvite & GameProtocol Async XTaskQueue Dispatch + Deduplication
 * ------------------------------------------------------------------------- */
struct uri_cb_capture {
    int calls;
    char last_uri[1024];
};

static void CALLBACK on_uri_activated_cb(void *context, const char *uri)
{
    struct uri_cb_capture *cap = (struct uri_cb_capture *)context;
    if (cap) {
        cap->calls++;
        snprintf(cap->last_uri, sizeof(cap->last_uri), "%s", uri ? uri : "");
    }
}

static void test_game_invite_and_protocol_dispatch(void)
{
    void *th_iface = NULL;
    ASSERT_HR_EQ(QueryApiImpl(&CLSID_XThreadingImpl, &IID_IXThreadingImpl, &th_iface), S_OK);
    const void *const *th_vtbl = *(const void *const **)th_iface;

    typedef HRESULT (WINAPI *fn_tq_create_t)(void *, XTaskQueueDispatchMode, XTaskQueueDispatchMode, XTaskQueueHandle *);
    typedef bool    (WINAPI *fn_tq_dispatch_t)(void *, XTaskQueueHandle, XTaskQueuePort, uint32_t);
    typedef void    (WINAPI *fn_tq_close_t)(void *, XTaskQueueHandle);

    fn_tq_create_t pTqCreate = (fn_tq_create_t)th_vtbl[12];
    fn_tq_dispatch_t pTqDispatch = (fn_tq_dispatch_t)th_vtbl[16];
    fn_tq_close_t pTqClose = (fn_tq_close_t)th_vtbl[17];

    XTaskQueueHandle manual_q = NULL;
    ASSERT_HR_EQ(pTqCreate(th_iface, XTaskQueueDispatchMode_Manual, XTaskQueueDispatchMode_Manual, &manual_q), S_OK);
    ASSERT_TRUE(manual_q != NULL);

    void *inv_iface = NULL;
    void *prot_iface = NULL;
    ASSERT_HR_EQ(QueryApiImpl(&CLSID_XGameInviteImpl, &IID_IXGameInviteImpl2, &inv_iface), S_OK);
    ASSERT_HR_EQ(QueryApiImpl(&CLSID_XGameProtocolImpl, &IID_IXGameProtocolImpl, &prot_iface), S_OK);

    const void *const *inv_vtbl = *(const void *const **)inv_iface;
    const void *const *prot_vtbl = *(const void *const **)prot_iface;

    typedef HRESULT (WINAPI *fn_uri_reg_t)(void *, XTaskQueueHandle, void *, void *, XTaskQueueRegistrationToken *);
    typedef BOOLEAN (WINAPI *fn_uri_unreg_t)(void *, XTaskQueueRegistrationToken, BOOLEAN);

    fn_uri_reg_t pInvReg = (fn_uri_reg_t)inv_vtbl[3];
    fn_uri_unreg_t pInvUnreg = (fn_uri_unreg_t)inv_vtbl[4];
    fn_uri_reg_t pProtReg = (fn_uri_reg_t)prot_vtbl[3];
    fn_uri_unreg_t pProtUnreg = (fn_uri_unreg_t)prot_vtbl[4];

    struct uri_cb_capture inv_cap = { 0, { 0 } };
    struct uri_cb_capture prot_cap = { 0, { 0 } };
    XTaskQueueRegistrationToken inv_tok = { 0 };
    XTaskQueueRegistrationToken prot_tok = { 0 };

    ASSERT_HR_EQ(pInvReg(inv_iface, manual_q, &inv_cap, (void *)on_uri_activated_cb, &inv_tok), S_OK);
    ASSERT_TRUE(inv_tok.token != 0);

    /* Push first invite URI -> queued onto manual_q Completion port, not invoked synchronously */
    xgr_set_pending_invite_uri("ms-xbl-6743210a://inviteHandleAccept?handle=alpha99");
    ASSERT_TRUE(inv_cap.calls == 0);
    ASSERT_TRUE(pTqDispatch(th_iface, manual_q, XTaskQueuePort_Completion, 0));
    ASSERT_TRUE(inv_cap.calls == 1);
    ASSERT_TRUE(strcmp(inv_cap.last_uri, "ms-xbl-6743210a://inviteHandleAccept?handle=alpha99") == 0);

    /* Duplicate push of identical URI must be deduplicated */
    xgr_set_pending_invite_uri("ms-xbl-6743210a://inviteHandleAccept?handle=alpha99");
    (void)pTqDispatch(th_iface, manual_q, XTaskQueuePort_Completion, 0);
    ASSERT_TRUE(inv_cap.calls == 1);

    /* Registering GameProtocol AFTER pending URI is already set dispatches immediately on manual_q */
    ASSERT_HR_EQ(pProtReg(prot_iface, manual_q, &prot_cap, (void *)on_uri_activated_cb, &prot_tok), S_OK);
    ASSERT_TRUE(pTqDispatch(th_iface, manual_q, XTaskQueuePort_Completion, 0));
    ASSERT_TRUE(prot_cap.calls == 1);
    ASSERT_TRUE(strcmp(prot_cap.last_uri, "ms-xbl-6743210a://inviteHandleAccept?handle=alpha99") == 0);

    /* Unregister invite callback; push new URI -> only protocol callback receives it */
    ASSERT_TRUE(pInvUnreg(inv_iface, inv_tok, TRUE) == TRUE);
    xgr_set_pending_invite_uri("ms-xbl-6743210a://protocolLaunch?lobby=beta77");
    while (pTqDispatch(th_iface, manual_q, XTaskQueuePort_Completion, 0)) {}
    ASSERT_TRUE(inv_cap.calls == 1);
    ASSERT_TRUE(prot_cap.calls == 2);
    ASSERT_TRUE(strcmp(prot_cap.last_uri, "ms-xbl-6743210a://protocolLaunch?lobby=beta77") == 0);

    ASSERT_TRUE(pProtUnreg(prot_iface, prot_tok, TRUE) == TRUE);
    xgr_set_pending_invite_uri("");
    pTqClose(th_iface, manual_q);
}

int main(void)
{
    char sandbox_template[] = "/tmp/ol-xgr-wave2a-asan-XXXXXX";
    char *sandbox = mkdtemp(sandbox_template);
    ASSERT_TRUE(sandbox != NULL);
    snprintf(g_win32_virtual_c_root, sizeof(g_win32_virtual_c_root), "%s", sandbox);

    g_w2a_mock_rpc = w2a_mock_rpc_handler;
    ASSERT_HR_EQ(InitializeApiImplEx2(202406u, 0u, 0, NULL), S_OK);

    test_playfab_inproc_shim();
    test_xpackage_locale_and_dlc_mounting();
    test_xstore_license_token_and_prices();
    test_game_invite_and_protocol_dispatch();

    xgr_playfab_set_symbol_resolver_for_test(NULL);
    xgr_playfab_shim_reset();
    ASSERT_HR_EQ(UninitializeApiImpl(), S_OK);
    win32_drain_background_workers();

    int64_t live = atomic_load_explicit(&g_win32_live_allocs, memory_order_seq_cst);
    if (live != 0) {
        fprintf(stderr, "[W2A-ASAN-FAIL] Memory leak detected: g_win32_live_allocs = %lld\n", (long long)live);
        remove_tree_posix(sandbox);
        abort();
    }

    remove_tree_posix(sandbox);
    printf("[xgr_wave2a_asan_test] PASS: PlayFab in-proc shim, DLC XPackageKind_Content + locale, XStore license token + prices, and GameInvite/GameProtocol verified with 0 leaks & 0 sanitizer errors.\n");
    return 0;
}
`;

function resolveClangExecutable() {
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/clang')) {
    return '/usr/bin/clang';
  }
  const probe = spawnSync('clang', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) {
    return 'clang';
  }
  return null;
}

function compileAndRunTarget(clangBin, srcPath, binPath, label, env) {
  const compileArgs = [
    '-std=c11',
    '-O1',
    '-g',
    '-fshort-wchar',
    '-fsanitize=address,undefined',
    '-fno-omit-frame-pointer',
    '-Wall',
    '-Wextra',
    '-Werror',
    `-I${WIN32_SHIM_INC}`,
    `-I${NATIVE_TEST_DIR}`,
    `-I${XGR_BRIDGE_DIR}`,
    srcPath,
    ...PRODUCTION_TUS,
    '-lpthread',
    '-o',
    binPath,
  ];

  if (process.platform === 'win32') {
    const winCompile = spawnSync(clangBin, compileArgs, { encoding: 'utf8' });
    if (winCompile.status !== 0) {
      console.log(
        '[test-xbox-bridge-asan] win32 clang lacks POSIX pthread/ASan runtime; skipping host ASan harness cleanly.'
      );
      return { skipped: true, reason: 'win32-no-asan-runtime', stdout: '' };
    }
  } else {
    console.log(
      `[test-xbox-bridge-asan] Compiling ${label} + ${PRODUCTION_TUS.length} xgr_bridge TUs with ${clangBin} (-fshort-wchar -fsanitize=address,undefined -Wall -Wextra -Werror)...`
    );
    execFileSync(clangBin, compileArgs, { stdio: 'inherit' });
  }

  const runRes = spawnSync(binPath, [], {
    env,
    encoding: 'utf8',
  });

  if (runRes.stdout) process.stdout.write(runRes.stdout);
  if (runRes.stderr) process.stderr.write(runRes.stderr);

  if (runRes.status !== 0) {
    console.error(
      `[test-xbox-bridge-asan] Sanitizer binary (${label}) exited with status ${runRes.status} (signal: ${runRes.signal || 'none'})`
    );
    process.exit(runRes.status || 1);
  }

  return { skipped: false, stdout: runRes.stdout || '' };
}

function runNativeAsanHarness() {
  if (!fs.existsSync(SRC_PATH)) {
    console.error(`[test-xbox-bridge-asan] Missing C11 sanitizer harness: ${SRC_PATH}`);
    process.exit(1);
  }
  for (const tuPath of PRODUCTION_TUS) {
    if (!fs.existsSync(tuPath)) {
      console.error(`[test-xbox-bridge-asan] Missing production C11 translation unit: ${tuPath}`);
      process.exit(1);
    }
  }

  const clangBin = resolveClangExecutable();
  if (!clangBin) {
    if (process.platform === 'win32') {
      console.log('[test-xbox-bridge-asan] win32 host without clang in PATH; skipping host POSIX ASan harness.');
      return { skipped: true, reason: 'win32-no-clang' };
    }
    console.error(`[test-xbox-bridge-asan] clang compiler not found on ${process.platform}.`);
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-launcher-xgr-asan-'));
  const binExt = process.platform === 'win32' ? '.exe' : '';
  const baseBinPath = path.join(tmpDir, `xgr_bridge_asan_test${binExt}`);
  const wave2aSrcPath = path.join(tmpDir, 'xgr_wave2a_asan_test.c');
  const wave2aBinPath = path.join(tmpDir, `xgr_wave2a_asan_test${binExt}`);

  try {
    const env = {
      ...process.env,
      ASAN_OPTIONS: 'abort_on_error=1:detect_stack_use_after_return=1:strict_string_checks=1',
      UBSAN_OPTIONS: 'print_stacktrace=1:halt_on_error=1',
    };

    const res1 = compileAndRunTarget(
      clangBin,
      SRC_PATH,
      baseBinPath,
      path.relative(ROOT_DIR, SRC_PATH),
      env
    );
    if (res1.skipped) return res1;

    fs.writeFileSync(wave2aSrcPath, WAVE2A_ASAN_TEST_SOURCE, 'utf8');
    const res2 = compileAndRunTarget(
      clangBin,
      wave2aSrcPath,
      wave2aBinPath,
      'xgr_wave2a_asan_test.c',
      env
    );

    return {
      skipped: false,
      stdout: `${res1.stdout}${res2.stdout}`,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of temp binary + dSYM
    }
  }
}

if (require.main === module) {
  runNativeAsanHarness();
}

module.exports = {
  runNativeAsanHarness,
  resolveClangExecutable,
};
