/*
 * One Launcher — Layer 1 Host Clang C11 ASan + UBSan Sanitizer Harness
 * (`tests/native/xgr_bridge_asan_test.c`)
 *
 * Compiles and links the ACTUAL production Win32 C11 Xbox Game Runtime Bridge
 * translation units from `electron/helpers/xgr_bridge/` under Host Clang with:
 *   /usr/bin/clang -std=c11 -O1 -g -fshort-wchar -fsanitize=address,undefined
 *     -fno-omit-frame-pointer -Wall -Wextra -Werror
 *
 * Directly exercises:
 *   1. Production `xgr_rpc.c` (`XgrStrBuf` 1..600 StoreIds + `SIZE_MAX` guard,
 *      tight-heap `xgr_json_extract_string` `\u` / UTF-16 surrogates, Base64 codec).
 *   2. Production `xgr_xml_pfn.c` (`<DevelopmentOnly>` block stripping, `<TitleId>` vs
 *      mismatched `00000000-...` dev `Scid` reconciliation, custom XDP UUID `Scid`
 *      preservation, single-pass XML entity decoding, Crockford Base32 PFN hash).
 *   3. Production `xgamesave.c` binary v14 `containers.index` & v4 `container.<N>` codecs:
 *      missing `containers.index` AND valid 40-byte `version=14, count=0` index
 *      (`idx.count == 0 && idx.items == NULL`), 16-byte `CoCreateGuid` stack safety,
 *      `submit_update_sync` (write -> reload -> `prepare_blob_read` -> overwrite -> delete).
 *   4. Mono GC shared-provider idempotency & edge-case GDK contracts:
 *      double `XGameSaveCloseProvider(prov)` + `XGameSaveCloseContainer(C1)` while `C2`
 *      stays live (0 UAF), post-close `E_INVALIDARG`, `XGameSaveGetContainerInfo` `S_OK`
 *      (0 callbacks) on missing container, `0x80830007` (`E_GS_PROVIDED_BUFFER_TOO_SMALL`)
 *      on `ReadBlobDataResult` & `FilesGetFolderWithUiResult`, and `E_INVALIDARG` on
 *      `SubmitBlobWrite(NULL, len > 0)`.
 *   5. Production `xuser.c` `XUserGetTokenAndSignature` & `Utf16` NUL-inclusive `tokenSize` /
 *      `tokenCount`, `signature == NULL` (`0` size/count) when unsigned, non-empty signature
 *      relocation, and `Manual` work queue non-blocking completion without pumping work port.
 *   6. Production `main.c` / `xsystem_misc.c` / `xthreading.c` / `appnotify_bridge.c`:
 *      all 24 coclasses (25 COM vtables, 513 total vtable slots non-NULL), `IXGameUiImpl`
 *      3 legacy IIDs (`{a26365fb-...}`, `{121248e5-...}`, `{72c4e70f-...}`), unknown CLSID
 *      `REGDB_E_CLASSNOTREG` (`0x80040154`), `XThreadVerifyNotTimeSensitive` (`S_OK` vs
 *      `0x89235100`), and `AppNotify` registration/unregistration.
 *   7. Production `xthreading.c` 10,000-cycle multi-threaded `XAsync` stress & 512-slot
 *      completed ring wrap + `UninitializeApiImpl()` + `g_win32_live_allocs == 0` leak gate.
 */

#define WIN32_HOST_SHIM_IMPLEMENTATION
#include <dirent.h>
#include "xgr_internal.h"

/* -------------------------------------------------------------------------
 * Exported entrypoints in `main.c`
 * ------------------------------------------------------------------------- */
HRESULT WINAPI DllCanUnloadNow(void);
HRESULT WINAPI InitializeApiImpl(ULONG gdkVer, ULONG gsVer);
HRESULT WINAPI InitializeApiImplEx(ULONG gdkVer, ULONG gsVer, char mode);
HRESULT WINAPI InitializeApiImplEx2(ULONG gdkVer, ULONG gsVer, char mode, const struct xgr_initialize_options *options);
HRESULT WINAPI UninitializeApiImpl(void);
BOOL WINAPI XErrorReport(HRESULT error, const char *message);

/* -------------------------------------------------------------------------
 * Host stubs for `xgr_xcurl_shim.c` (PE IAT patcher is Win64-specific)
 * ------------------------------------------------------------------------- */
static HMODULE g_test_bridge_hmod = NULL;
static bool g_test_xcurl_active = false;

void xgr_set_bridge_hmodule(HMODULE hmod) { g_test_bridge_hmod = hmod; }
void xgr_install_xcurl_shim(void) { g_test_xcurl_active = true; }
void xgr_ensure_xcurl_shim(void) { g_test_xcurl_active = true; }
bool xgr_is_xcurl_shim_active(void) { return g_test_xcurl_active; }
void xgr_uninstall_xcurl_shim(void) { g_test_xcurl_active = false; }

/* -------------------------------------------------------------------------
 * Direct inclusion of `xgr_xml_pfn.c`, `xgr_rpc.c`, `xgamesave.c`,
 * and `appnotify_bridge.c` to test internal static codecs under ASan+UBSan
 * ------------------------------------------------------------------------- */
#include "xgr_xml_pfn.c"

#define xgr_rpc_is_configured xgr_rpc_is_configured_socket_impl
#define xgr_rpc_call          xgr_rpc_call_socket_impl
#include "xgr_rpc.c"
#undef xgr_rpc_is_configured
#undef xgr_rpc_call

typedef HRESULT (*xgr_mock_rpc_fn)(const char *method, const char *params_json_obj, char **out_result_json);
static xgr_mock_rpc_fn g_mock_rpc_handler = NULL;

bool xgr_rpc_is_configured(void)
{
    if (g_mock_rpc_handler != NULL) return true;
    return xgr_rpc_is_configured_socket_impl();
}

HRESULT xgr_rpc_call(const char *method, const char *params_json_obj, char **out_result_json)
{
    if (g_mock_rpc_handler != NULL) {
        if (out_result_json) *out_result_json = NULL;
        return g_mock_rpc_handler(method, params_json_obj, out_result_json);
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

/* -------------------------------------------------------------------------
 * Assertion Macros & POSIX Temp Directory Helpers
 * ------------------------------------------------------------------------- */

#define ASSERT_TRUE(cond)                                                                      \
    do {                                                                                       \
        if (!(cond)) {                                                                         \
            fprintf(stderr, "[ASAN-FAIL] %s:%d: assertion failed: %s\n", __FILE__, __LINE__,   \
                    #cond);                                                                    \
            abort();                                                                           \
        }                                                                                      \
    } while (0)

#define ASSERT_HR_EQ(actual, expected)                                                         \
    do {                                                                                       \
        HRESULT _a = (actual);                                                                 \
        HRESULT _e = (expected);                                                               \
        if (_a != _e) {                                                                        \
            fprintf(stderr, "[ASAN-FAIL] %s:%d: expected HRESULT 0x%08X, got 0x%08X\n",        \
                    __FILE__, __LINE__, (unsigned int)_e, (unsigned int)_a);                   \
            abort();                                                                           \
        }                                                                                      \
    } while (0)

#define ASSERT_STREQ(actual, expected)                                                         \
    do {                                                                                       \
        const char *_a = (actual);                                                             \
        const char *_e = (expected);                                                           \
        if (!_a || !_e || strcmp(_a, _e) != 0) {                                               \
            fprintf(stderr, "[ASAN-FAIL] %s:%d: expected \"%s\", got \"%s\"\n", __FILE__,      \
                    __LINE__, _e ? _e : "(null)", _a ? _a : "(null)");                         \
            abort();                                                                           \
        }                                                                                      \
    } while (0)

static void rm_rf_posix(const char *dir_path)
{
    if (!dir_path || !dir_path[0] || strcmp(dir_path, "/") == 0) return;
    DIR *d = opendir(dir_path);
    if (!d) {
        unlink(dir_path);
        return;
    }
    struct dirent *ent = NULL;
    while ((ent = readdir(d)) != NULL) {
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
        char child[4096];
        int n = snprintf(child, sizeof(child), "%s/%s", dir_path, ent->d_name);
        if (n <= 0 || (size_t)n >= sizeof(child)) continue;
        struct stat st;
        if (lstat(child, &st) == 0 && S_ISDIR(st.st_mode)) {
            rm_rf_posix(child);
        } else {
            unlink(child);
        }
    }
    closedir(d);
    rmdir(dir_path);
}

/* Allocates exact tight heap buffer (strlen + 1) so ASan traps any 1-byte over-read! */
static char *dup_tight(const char *src)
{
    size_t n = strlen(src);
    char *p = (char *)malloc(n + 1);
    ASSERT_TRUE(p != NULL);
    memcpy(p, src, n + 1);
    return p;
}

static wchar_t *utf8_to_wstr_test(const char *s)
{
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    ASSERT_TRUE(n > 0);
    wchar_t *w = (wchar_t *)calloc((size_t)n, sizeof(wchar_t));
    ASSERT_TRUE(w != NULL);
    MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n);
    return w;
}

/* =========================================================================
 * Suite 1: Production `xgr_rpc.c` (`XgrStrBuf`, Tight-Heap JSON & Base64)
 * ========================================================================= */

static void test_production_strbuf_json_and_base64(void)
{
    for (size_t count = 1; count <= 600; count = (count < 16 ? count + 1 : count + 37)) {
        XgrStrBuf sb;
        xgr_sb_init(&sb);
        ASSERT_TRUE(xgr_sb_append_cstr(&sb, "{\"storeIds\":["));
        for (size_t i = 0; i < count; i++) {
            if (i > 0) ASSERT_TRUE(xgr_sb_append_char(&sb, ','));
            char raw_id[96];
            snprintf(raw_id, sizeof(raw_id), "9NSTORE%04zu_\"quote\"_\\slash_\n_\x07", i);
            ASSERT_TRUE(xgr_sb_append_json_str(&sb, raw_id));
        }
        ASSERT_TRUE(xgr_sb_append_fmt(&sb, "],\"count\":%zu}", count));
        ASSERT_TRUE(!sb.failed);
        ASSERT_TRUE(sb.len > 0 && sb.len < sb.cap);
        ASSERT_TRUE(sb.buf[sb.len] == '\0');

        char *detached = xgr_sb_detach(&sb);
        ASSERT_TRUE(detached != NULL);
        ASSERT_TRUE(strstr(detached, "\\u0007") != NULL);
        ASSERT_TRUE(strstr(detached, "\\\"quote\\\"") != NULL);
        free(detached);
    }

    /* Exact 600 Store IDs */
    {
        XgrStrBuf sb;
        xgr_sb_init(&sb);
        ASSERT_TRUE(xgr_sb_append_cstr(&sb, "["));
        for (size_t i = 0; i < 600; i++) {
            if (i > 0) ASSERT_TRUE(xgr_sb_append_char(&sb, ','));
            char id[32];
            snprintf(id, sizeof(id), "9NPID%07zu", i);
            ASSERT_TRUE(xgr_sb_append_json_str(&sb, id));
        }
        ASSERT_TRUE(xgr_sb_append_cstr(&sb, "]"));
        char *json = xgr_sb_detach(&sb);
        ASSERT_TRUE(json != NULL);
        ASSERT_TRUE(strlen(json) == 2 + 600 * 14 + 599);
        free(json);
    }

    /* SIZE_MAX overflow guard */
    {
        XgrStrBuf sb;
        xgr_sb_init(&sb);
        ASSERT_TRUE(xgr_sb_append_cstr(&sb, "seed"));
        ASSERT_TRUE(!xgr_sb_reserve(&sb, SIZE_MAX));
        ASSERT_TRUE(sb.failed);
        ASSERT_TRUE(xgr_sb_detach(&sb) == NULL);
    }

    /* Tight-heap truncated \u / surrogate pair fuzzing */
    const char *truncated_inputs[] = {
        "{\"gamertag\":\"abc\\",
        "{\"gamertag\":\"abc\\u",
        "{\"gamertag\":\"abc\\u1",
        "{\"gamertag\":\"abc\\u12",
        "{\"gamertag\":\"abc\\u123",
        "{\"gamertag\":\"abc\\u12GZ\"",
        "{\"gamertag\":\"\\uD83C\\",
        "{\"gamertag\":\"\\uD83C\\u",
        "{\"gamertag\":\"\\uD83C\\uDF",
        "{\"gamertag\":\"\\uD83C\"",
        "{\"gamertag\":\"\\uDC00\""
    };
    for (size_t i = 0; i < sizeof(truncated_inputs) / sizeof(truncated_inputs[0]); i++) {
        char *tight = dup_tight(truncated_inputs[i]);
        char out[128];
        ASSERT_TRUE(xgr_json_extract_string(tight, "gamertag", out, sizeof(out)));
        free(tight);
    }

    /* Surrogate pair \uD83C\uDFAE -> 🎮 and direct multi-byte UTF-8 */
    {
        char *tight = dup_tight("{\"gamertag\":\"PlayerOne \\uD83C\\uDFAE \\u65E5\\u672C\"}");
        char out[128];
        ASSERT_TRUE(xgr_json_extract_string(tight, "gamertag", out, sizeof(out)));
        ASSERT_STREQ(out, "PlayerOne \xF0\x9F\x8E\xAE \xE6\x97\xA5\xE6\x9C\xAC");
        free(tight);

        char *tight2 = dup_tight("{\"modernGamertag\":\"Spartan_\xCE\xA9_\xE7\x8B\xBC_\xF0\x9F\x9A\x80#4412\"}");
        ASSERT_TRUE(xgr_json_extract_string(tight2, "modernGamertag", out, sizeof(out)));
        ASSERT_STREQ(out, "Spartan_\xCE\xA9_\xE7\x8B\xBC_\xF0\x9F\x9A\x80#4412");
        free(tight2);
    }

    /* Base64 encode/decode round-trip */
    {
        const uint8_t raw[11] = { 0x00, 0xFF, 0x4F, 0x6E, 0x65, 0x58, 0x47, 0x52, 0x10, 0x20, 0x7F };
        char *b64 = xgr_base64_encode_alloc(raw, sizeof(raw));
        ASSERT_TRUE(b64 != NULL);
        size_t dec_len = 0;
        uint8_t *dec = xgr_base64_decode_alloc(b64, &dec_len);
        ASSERT_TRUE(dec != NULL);
        ASSERT_TRUE(dec_len == sizeof(raw));
        ASSERT_TRUE(memcmp(dec, raw, sizeof(raw)) == 0);
        free(dec);
        free(b64);
    }
}

/* =========================================================================
 * Suite 2: Production `xgr_xml_pfn.c` (`<DevelopmentOnly>`, Dev SCID
 *          Reconciliation, Custom UUID Preservation, Entities & Base32 PFN)
 * ========================================================================= */

static void reset_global_runtime_cfg(void)
{
    memset(&g_xgr_cfg, 0, sizeof(g_xgr_cfg));
}

static void test_production_xml_pfn_and_scid_reconciliation(void)
{
    /* 1. Tight-heap XML comment stripping */
    {
        char *tight = dup_tight(
            "<Game><!-- <TitleId>DEADBEEF</TitleId> --><!--second-->"
            "<TitleId>6A86E84F</TitleId><!-- unclosed trailing comment"
        );
        char *stripped = xml_strip_comments_alloc(tight);
        ASSERT_TRUE(stripped != NULL);
        ASSERT_STREQ(stripped, "<Game><TitleId>6A86E84F</TitleId>");
        free(stripped);
        free(tight);

        const char *short_prefixes[] = { "", "<", "<!", "<!-", "<!--" };
        for (size_t k = 0; k < sizeof(short_prefixes) / sizeof(short_prefixes[0]); k++) {
            char *t = dup_tight(short_prefixes[k]);
            char *s = xml_strip_comments_alloc(t);
            ASSERT_TRUE(s != NULL);
            free(s);
            free(t);
        }
    }

    /* 2. Single-pass entity decoding: &amp;lt; MUST become &lt; (never <) */
    {
        const char *raw = "Ben &amp;lt;script&amp;gt; &amp; Jerry&#x26;Co &#60;RPG&#62; &#x1F3AE;";
        char out[128] = { 0 };
        xml_copy_decoded_slice(raw, raw + strlen(raw), out, sizeof(out));
        ASSERT_STREQ(out, "Ben &lt;script&gt; & Jerry&Co <RPG> \xF0\x9F\x8E\xAE");
    }

    /* 3. Retail Microsoft Crockford Base32 PFN publisher hash */
    {
        char pfn[256] = { 0 };
        ASSERT_TRUE(xgr_compute_package_family_name(
            "Microsoft.HaloInfinite",
            "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US",
            pfn,
            sizeof(pfn)
        ));
        ASSERT_STREQ(pfn, "Microsoft.HaloInfinite_8wekyb3d8bbwe");
    }

    /* 4. <DevelopmentOnly> stripping + <TitleId>71b6a9d4</TitleId> vs mismatched
     *    00000000-0000-0000-0000-0000790907e2 dev <ExtendedAttribute Name="Scid"> reconciliation */
    {
        reset_global_runtime_cfg();
        const char *brotato_like_xml =
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
            "<Game configVersion=\"1\">"
            "  <Identity Name=\"Blobfish.Brotato\" Publisher=\"CN=C4736910-1234-4567-89AB-CDEF01234567\" Version=\"1.0.1.3\" />"
            "  <DevelopmentOnly>"
            "    <TitleId>DEADBEEF</TitleId>"
            "    <Scid>00000000-0000-0000-0000-0000deadbeef</Scid>"
            "  </DevelopmentOnly>"
            "  <TitleId>71b6a9d4</TitleId>"
            "  <MSAAppId>000000004C2B71B6</MSAAppId>"
            "  <StoreId>9nbrotatostore</StoreId>"
            "  <ExtendedAttributeList>"
            "    <ExtendedAttribute Name=\"Scid\" Value=\"00000000-0000-0000-0000-0000790907e2\" />"
            "  </ExtendedAttributeList>"
            "  <ShellVisuals DefaultDisplayName=\"Brotato &amp; Friends\" />"
            "</Game>";

        apply_game_config_xml(brotato_like_xml);
        ASSERT_TRUE(g_xgr_cfg.titleId == 0x71B6A9D4u);
        ASSERT_STREQ(g_xgr_cfg.titleIdHex, "71B6A9D4");
        ASSERT_STREQ(g_xgr_cfg.scid, "00000000-0000-0000-0000-000071b6a9d4");
        ASSERT_STREQ(g_xgr_cfg.storeId, "9NBROTATOSTORE");
        ASSERT_STREQ(g_xgr_cfg.displayName, "Brotato & Friends");
    }

    /* 5. Genuine custom XDP Partner Center UUID SCID (non-00000000-... prefix) MUST be preserved! */
    {
        reset_global_runtime_cfg();
        const char *custom_uuid_xml =
            "<Game configVersion=\"0\">"
            "  <Identity Name=\"Studio.CustomScidGame\" Publisher=\"CN=Microsoft Corporation\" Version=\"2.1.0.0\" />"
            "  <TitleId>71b6a9d4</TitleId>"
            "  <Scid>A1B2C3D4-E5F6-4711-8899-AABBCCDDEEFF</Scid>"
            "</Game>";

        apply_game_config_xml(custom_uuid_xml);
        ASSERT_TRUE(g_xgr_cfg.titleId == 0x71B6A9D4u);
        ASSERT_STREQ(g_xgr_cfg.scid, "a1b2c3d4-e5f6-4711-8899-aabbccddeeff");
    }

    /* 6. Fallback when <TitleId> exists ONLY inside <DevelopmentOnly> */
    {
        reset_global_runtime_cfg();
        const char *dev_only_tid_xml =
            "<Game configVersion=\"1\">"
            "  <DevelopmentOnly><TitleId>12AB34CD</TitleId></DevelopmentOnly>"
            "</Game>";
        apply_game_config_xml(dev_only_tid_xml);
        ASSERT_TRUE(g_xgr_cfg.titleId == 0x12AB34CDu);
        ASSERT_STREQ(g_xgr_cfg.scid, "00000000-0000-0000-0000-000012ab34cd");
    }

    reset_global_runtime_cfg();
}

/* =========================================================================
 * Suite 3: Production `xgamesave.c` Binary v14 Index, 40-Byte Empty Index,
 *          16-Byte `CoCreateGuid` Stack Safety & Full Blob Lifecycle
 * ========================================================================= */

struct enum_capture {
    uint32_t container_calls;
    char last_container[256];
    uint32_t last_blob_count;
    uint32_t blob_calls;
    char last_blob_name[128];
    uint32_t last_blob_size;
};

static bool CALLBACK capture_container_cb(const XGameSaveContainerInfo *info, void *ctx)
{
    struct enum_capture *cap = (struct enum_capture *)ctx;
    cap->container_calls++;
    snprintf(cap->last_container, sizeof(cap->last_container), "%s", info->name ? info->name : "");
    cap->last_blob_count = info->blobCount;
    return true;
}

static bool CALLBACK capture_blob_cb(const XGameSaveBlobInfo *info, void *ctx)
{
    struct enum_capture *cap = (struct enum_capture *)ctx;
    cap->blob_calls++;
    snprintf(cap->last_blob_name, sizeof(cap->last_blob_name), "%s", info->name ? info->name : "");
    cap->last_blob_size = info->size;
    return true;
}

static void test_production_wgs_index_and_blob_lifecycle(void)
{
    wchar_t *wgs_dir = utf8_to_wstr_test(
        "C:\\TestAppData\\Packages\\Blobfish.Brotato_8wekyb3d8bbwe\\SystemAppData\\wgs\\0009000001234567_00000000-0000-0000-0000-000071b6a9d4"
    );
    ensure_dir_recursive_w(wgs_dir);

    /* A. Missing containers.index -> returns false, idx.version == 14, count == 0, items == NULL */
    {
        struct wgs_index_state idx;
        bool loaded = load_wgs_index(wgs_dir, &idx);
        ASSERT_TRUE(!loaded);
        ASSERT_TRUE(idx.version == 14);
        ASSERT_TRUE(idx.count == 0);
        ASSERT_TRUE(idx.items == NULL);
        free_wgs_index(&idx);
    }

    /* B. Exact 40-byte binary v14 containers.index (version=14, count=0, empty UTF-16 header strings) */
    {
        struct wgs_index_state empty_idx;
        memset(&empty_idx, 0, sizeof(empty_idx));
        empty_idx.version = 14;
        empty_idx.creation_ft = 133700000000000000ULL;
        empty_idx.count = 0;
        empty_idx.items = NULL;
        ASSERT_TRUE(save_wgs_index(wgs_dir, &empty_idx));

        wchar_t idx_file[MAX_PATH * 2];
        swprintf(idx_file, sizeof(idx_file) / sizeof(idx_file[0]), L"%ls\\containers.index", wgs_dir);
        size_t raw_len = 0;
        uint8_t *raw_bytes = read_whole_file_w(idx_file, &raw_len);
        ASSERT_TRUE(raw_bytes != NULL);
        ASSERT_TRUE(raw_len == 40);
        free(raw_bytes);

        struct wgs_index_state reloaded;
        ASSERT_TRUE(load_wgs_index(wgs_dir, &reloaded));
        ASSERT_TRUE(reloaded.version == 14);
        ASSERT_TRUE(reloaded.count == 0);
        ASSERT_TRUE(reloaded.items == NULL);
        free_wgs_index(&reloaded);
    }

    free(wgs_dir);

    /* C. End-to-end internal WGS provider -> write first blob -> reload -> read -> overwrite -> delete */
    XGameSaveProviderHandle prov = NULL;
    ASSERT_HR_EQ(create_provider_internal(NULL, "00000000-0000-0000-0000-000071b6a9d4", true, &prov), S_OK);
    ASSERT_TRUE(prov != NULL);

    struct enum_capture cap;
    memset(&cap, 0, sizeof(cap));
    ASSERT_HR_EQ(enumerate_containers_internal(prov, NULL, false, &cap, capture_container_cb), S_OK);
    ASSERT_TRUE(cap.container_calls == 0);

    XGameSaveContainerHandle cont = NULL;
    ASSERT_HR_EQ(xgs_XGameSaveCreateContainer(NULL, prov, "SaveSlot_01", &cont), S_OK);
    ASSERT_TRUE(cont != NULL);

    /* Unmaterialized container (prior to first SubmitUpdate): prepare_blob_read returns E_GS_BLOB_NOT_FOUND */
    {
        struct prepared_blob_read prep_all;
        ASSERT_HR_EQ(prepare_blob_read(cont, NULL, 0, &prep_all), E_GS_BLOB_NOT_FOUND);
        ASSERT_TRUE(prep_all.count == 0 && prep_all.packed == NULL);

        const char *missing_name = "progress.json";
        struct prepared_blob_read prep_missing;
        ASSERT_HR_EQ(prepare_blob_read(cont, &missing_name, 1, &prep_missing), E_GS_BLOB_NOT_FOUND);
        ASSERT_TRUE(prep_missing.packed == NULL);
    }

    /* Write first blob via submit_update_sync (exercises CoCreateGuid 16-byte stack safety) */
    const uint8_t first_payload[] = "{\"wave\":12,\"gold\":450}";
    {
        XGameSaveUpdateHandle upd = NULL;
        ASSERT_HR_EQ(xgs_XGameSaveCreateUpdate(NULL, cont, "Slot 1 Display", &upd), S_OK);
        ASSERT_HR_EQ(xgs_XGameSaveSubmitBlobWrite(NULL, upd, "progress.json", (uint8_t *)first_payload, sizeof(first_payload) - 1), S_OK);
        ASSERT_HR_EQ(submit_update_sync(upd), S_OK);
        /* Duplicate submission on same update handle must return E_GS_HANDLE_EXPIRED */
        ASSERT_HR_EQ(submit_update_sync(upd), E_GS_HANDLE_EXPIRED);
        xgs_XGameSaveCloseUpdate(NULL, upd);
    }

    /* Reload containers.index & enumerate containers + blobs */
    {
        struct wgs_index_state idx_after;
        ASSERT_TRUE(load_wgs_index(prov->wgs_user_dir, &idx_after));
        ASSERT_TRUE(idx_after.count == 1 && idx_after.items != NULL);
        ASSERT_STREQ(idx_after.items[0].name, "SaveSlot_01");
        ASSERT_STREQ(idx_after.items[0].display_name, "Slot 1 Display");
        ASSERT_TRUE(idx_after.items[0].container_num == 1);
        ASSERT_TRUE(idx_after.items[0].total_size == sizeof(first_payload) - 1);
        free_wgs_index(&idx_after);

        memset(&cap, 0, sizeof(cap));
        ASSERT_HR_EQ(enumerate_containers_internal(prov, NULL, false, &cap, capture_container_cb), S_OK);
        ASSERT_TRUE(cap.container_calls == 1 && cap.last_blob_count == 1);
        ASSERT_STREQ(cap.last_container, "SaveSlot_01");

        ASSERT_HR_EQ(enumerate_blobs_internal(cont, NULL, &cap, capture_blob_cb), S_OK);
        ASSERT_TRUE(cap.blob_calls == 1 && cap.last_blob_size == sizeof(first_payload) - 1);
        ASSERT_STREQ(cap.last_blob_name, "progress.json");
    }

    /* Read blob via prepare_blob_read + copy_relocated_blob_read */
    {
        const char *want = "progress.json";
        struct prepared_blob_read prep;
        ASSERT_HR_EQ(prepare_blob_read(cont, &want, 1, &prep), S_OK);
        ASSERT_TRUE(prep.count == 1 && prep.total_size > sizeof(XGameSaveBlob) && prep.packed != NULL);
        XGameSaveBlob *reloc = (XGameSaveBlob *)calloc(1, prep.total_size);
        ASSERT_TRUE(reloc != NULL);
        copy_relocated_blob_read(&prep, reloc);
        ASSERT_STREQ(reloc[0].info.name, "progress.json");
        ASSERT_TRUE(reloc[0].info.size == sizeof(first_payload) - 1);
        ASSERT_TRUE(memcmp(reloc[0].data, first_payload, sizeof(first_payload) - 1) == 0);
        free(reloc);
        free(prep.packed);
    }

    /* Overwrite blob via second submit_update_sync (rotates container.1 -> container.2 & cleans old GUID) */
    const uint8_t second_payload[] = "{\"wave\":20,\"gold\":9999,\"endless\":true}";
    {
        XGameSaveUpdateHandle upd2 = NULL;
        ASSERT_HR_EQ(xgs_XGameSaveCreateUpdate(NULL, cont, "Slot 1 Cleared", &upd2), S_OK);
        ASSERT_HR_EQ(xgs_XGameSaveSubmitBlobWrite(NULL, upd2, "progress.json", (uint8_t *)second_payload, sizeof(second_payload) - 1), S_OK);
        ASSERT_HR_EQ(submit_update_sync(upd2), S_OK);
        xgs_XGameSaveCloseUpdate(NULL, upd2);

        const char *want = "progress.json";
        struct prepared_blob_read prep2;
        ASSERT_HR_EQ(prepare_blob_read(cont, &want, 1, &prep2), S_OK);
        XGameSaveBlob *reloc2 = (XGameSaveBlob *)calloc(1, prep2.total_size);
        copy_relocated_blob_read(&prep2, reloc2);
        ASSERT_TRUE(reloc2[0].info.size == sizeof(second_payload) - 1);
        ASSERT_TRUE(memcmp(reloc2[0].data, second_payload, sizeof(second_payload) - 1) == 0);
        free(reloc2);
        free(prep2.packed);
    }

    /* Delete container and verify index returns to count == 0 */
    ASSERT_HR_EQ(delete_container_sync(prov, "SaveSlot_01"), S_OK);
    {
        struct wgs_index_state idx_del;
        ASSERT_TRUE(load_wgs_index(prov->wgs_user_dir, &idx_del));
        ASSERT_TRUE(idx_del.count == 0 && idx_del.items == NULL);
        free_wgs_index(&idx_del);
    }

    xgs_XGameSaveCloseContainer(NULL, cont);
    xgs_XGameSaveCloseProvider(NULL, prov);
}

/* =========================================================================
 * Suite 4: Mono GC Shared-Provider Idempotency & Edge-Case GDK Contracts
 * ========================================================================= */

typedef HRESULT (WINAPI *fn_xgs_init_prov_t)(void *, XUserHandle, const char *, bool, XGameSaveProviderHandle *);
typedef void    (WINAPI *fn_xgs_close_prov_t)(void *, XGameSaveProviderHandle);
typedef HRESULT (WINAPI *fn_xgs_get_quota_t)(void *, XGameSaveProviderHandle, int64_t *);
typedef HRESULT (WINAPI *fn_xgs_get_cinfo_t)(void *, XGameSaveProviderHandle, const char *, void *, XGameSaveContainerInfoCallback *);
typedef HRESULT (WINAPI *fn_xgs_create_cont_t)(void *, XGameSaveProviderHandle, const char *, XGameSaveContainerHandle *);
typedef void    (WINAPI *fn_xgs_close_cont_t)(void *, XGameSaveContainerHandle);
typedef HRESULT (WINAPI *fn_xgs_enum_blobs_t)(void *, XGameSaveContainerHandle, void *, XGameSaveBlobInfoCallback *);
typedef HRESULT (WINAPI *fn_xgs_read_blobs_t)(void *, XGameSaveContainerHandle, const char **, uint32_t *, SIZE_T, XGameSaveBlob *);
typedef HRESULT (WINAPI *fn_xgs_read_async_t)(void *, XGameSaveContainerHandle, const char **, uint32_t, XAsyncBlock *);
typedef HRESULT (WINAPI *fn_xgs_read_res_t)(void *, XAsyncBlock *, SIZE_T, XGameSaveBlob *, uint32_t *);
typedef HRESULT (WINAPI *fn_xgs_create_upd_t)(void *, XGameSaveContainerHandle, const char *, XGameSaveUpdateHandle *);
typedef void    (WINAPI *fn_xgs_close_upd_t)(void *, XGameSaveUpdateHandle);
typedef HRESULT (WINAPI *fn_xgs_blob_write_t)(void *, XGameSaveUpdateHandle, const char *, uint8_t *, SIZE_T);
typedef HRESULT (WINAPI *fn_xgs_submit_upd_t)(void *, XGameSaveUpdateHandle);
typedef HRESULT (WINAPI *fn_xgs_files_async_t)(void *, XUserHandle, const char *, XAsyncBlock *);
typedef HRESULT (WINAPI *fn_xgs_files_res_t)(void *, XAsyncBlock *, SIZE_T, char *);

static void test_mono_gc_shared_provider_and_edge_contracts(void)
{
    void *gs_iface = NULL;
    ASSERT_HR_EQ(QueryApiImpl(&CLSID_XGameSaveImpl, &IID_IXGameSaveImpl4, &gs_iface), S_OK);
    ASSERT_TRUE(gs_iface != NULL);
    const void *const *vtbl = *(const void *const **)gs_iface;

    fn_xgs_init_prov_t   pInitProv   = (fn_xgs_init_prov_t)vtbl[3];
    fn_xgs_close_prov_t  pCloseProv  = (fn_xgs_close_prov_t)vtbl[6];
    fn_xgs_get_quota_t   pGetQuota   = (fn_xgs_get_quota_t)vtbl[7];
    fn_xgs_get_cinfo_t   pGetCInfo   = (fn_xgs_get_cinfo_t)vtbl[13];
    fn_xgs_create_cont_t pCreateCont = (fn_xgs_create_cont_t)vtbl[16];
    fn_xgs_close_cont_t  pCloseCont  = (fn_xgs_close_cont_t)vtbl[17];
    fn_xgs_enum_blobs_t  pEnumBlobs  = (fn_xgs_enum_blobs_t)vtbl[18];
    fn_xgs_read_blobs_t  pReadBlobs  = (fn_xgs_read_blobs_t)vtbl[20];
    fn_xgs_read_async_t  pReadAsync  = (fn_xgs_read_async_t)vtbl[21];
    fn_xgs_read_res_t    pReadRes    = (fn_xgs_read_res_t)vtbl[22];
    fn_xgs_create_upd_t  pCreateUpd  = (fn_xgs_create_upd_t)vtbl[23];
    fn_xgs_close_upd_t   pCloseUpd   = (fn_xgs_close_upd_t)vtbl[24];
    fn_xgs_blob_write_t  pBlobWrite  = (fn_xgs_blob_write_t)vtbl[25];
    fn_xgs_submit_upd_t  pSubmitUpd  = (fn_xgs_submit_upd_t)vtbl[27];
    fn_xgs_files_async_t pFilesAsync = (fn_xgs_files_async_t)vtbl[30];
    fn_xgs_files_res_t   pFilesRes   = (fn_xgs_files_res_t)vtbl[31];

    XGameSaveProviderHandle prov = NULL;
    ASSERT_HR_EQ(pInitProv(gs_iface, NULL, "00000000-0000-0000-0000-000071b6a9d4", false, &prov), S_OK);
    ASSERT_TRUE(prov != NULL);

    /* XGameSaveGetContainerInfo on non-existent container MUST return S_OK with 0 callbacks! */
    struct enum_capture cap;
    memset(&cap, 0, sizeof(cap));
    ASSERT_HR_EQ(pGetCInfo(gs_iface, prov, "MissingContainerName", &cap, capture_container_cb), S_OK);
    ASSERT_TRUE(cap.container_calls == 0);

    /* Create C1 and C2 sharing `prov` */
    XGameSaveContainerHandle c1 = NULL, c2 = NULL;
    ASSERT_HR_EQ(pCreateCont(gs_iface, prov, "Container_C1", &c1), S_OK);
    ASSERT_HR_EQ(pCreateCont(gs_iface, prov, "Container_C2", &c2), S_OK);
    ASSERT_TRUE(c1 != NULL && c2 != NULL);

    /* Call XGameSaveCloseProvider TWICE + XGameSaveCloseContainer(C1) TWICE (Mono GC race!) */
    pCloseProv(gs_iface, prov);
    pCloseProv(gs_iface, prov);
    pCloseCont(gs_iface, c1);
    pCloseCont(gs_iface, c1);

    /* Operations on closed `prov` and closed `c1` MUST return E_INVALIDARG (0 UAF!) */
    int64_t rem_quota = 0;
    XGameSaveContainerHandle dummy_cont = NULL;
    ASSERT_HR_EQ(pGetQuota(gs_iface, prov, &rem_quota), E_INVALIDARG);
    ASSERT_HR_EQ(pCreateCont(gs_iface, prov, "AfterClose", &dummy_cont), E_INVALIDARG);
    ASSERT_HR_EQ(pEnumBlobs(gs_iface, c1, &cap, capture_blob_cb), E_INVALIDARG);

    /* Meanwhile `c2` retains its internal ref on `prov` and MUST keep working with 0 UAF! */
    memset(&cap, 0, sizeof(cap));
    ASSERT_HR_EQ(pEnumBlobs(gs_iface, c2, &cap, capture_blob_cb), S_OK);
    ASSERT_TRUE(cap.blob_calls == 0);

    const char *blob_name = "settings.bin";
    uint32_t bcount = 1;
    uint8_t small_read_buf[128];
    ASSERT_HR_EQ(
        pReadBlobs(gs_iface, c2, &blob_name, &bcount, sizeof(small_read_buf), (XGameSaveBlob *)small_read_buf),
        E_GS_BLOB_NOT_FOUND
    );

    /* Write blob on C2; also verify NULL buffer + len > 0 returns E_INVALIDARG */
    XGameSaveUpdateHandle upd = NULL;
    ASSERT_HR_EQ(pCreateUpd(gs_iface, c2, "C2 Save", &upd), S_OK);
    ASSERT_HR_EQ(pBlobWrite(gs_iface, upd, "settings.bin", NULL, 16), E_INVALIDARG);

    const uint8_t c2_payload[] = "MONO-GC-SAFE-PAYLOAD-2026";
    ASSERT_HR_EQ(pBlobWrite(gs_iface, upd, "settings.bin", (uint8_t *)c2_payload, sizeof(c2_payload) - 1), S_OK);
    ASSERT_HR_EQ(pSubmitUpd(gs_iface, upd), S_OK);
    pCloseUpd(gs_iface, upd);
    pCloseUpd(gs_iface, upd); /* Double close update handle idempotency */

    /* XGameSaveReadBlobDataAsync + XGameSaveReadBlobDataResult with too-small buffer -> 0x80830007 */
    {
        XAsyncBlock ab;
        memset(&ab, 0, sizeof(ab));
        ASSERT_HR_EQ(pReadAsync(gs_iface, c2, &blob_name, 1, &ab), S_OK);
        ASSERT_HR_EQ(xgr_async_get_status(&ab, true), S_OK);

        uint8_t tiny_buf[8];
        uint32_t out_cnt = 0;
        ASSERT_HR_EQ(
            pReadRes(gs_iface, &ab, sizeof(tiny_buf), (XGameSaveBlob *)tiny_buf, &out_cnt),
            E_GS_PROVIDED_BUFFER_TOO_SMALL
        );

        size_t req_sz = 0;
        ASSERT_HR_EQ(xgr_async_get_result_size(&ab, &req_sz), S_OK);
        ASSERT_TRUE(req_sz > sizeof(XGameSaveBlob));
        XGameSaveBlob *full_buf = (XGameSaveBlob *)calloc(1, req_sz);
        ASSERT_HR_EQ(pReadRes(gs_iface, &ab, req_sz, full_buf, &out_cnt), S_OK);
        ASSERT_TRUE(out_cnt == 1);
        ASSERT_STREQ(full_buf[0].info.name, "settings.bin");
        ASSERT_TRUE(full_buf[0].info.size == sizeof(c2_payload) - 1);
        ASSERT_TRUE(memcmp(full_buf[0].data, c2_payload, sizeof(c2_payload) - 1) == 0);
        free(full_buf);
    }

    /* Close C2 (drops final ref on `prov` cleanly); post-close C2 must return E_INVALIDARG */
    pCloseCont(gs_iface, c2);
    pCloseCont(gs_iface, c2);
    ASSERT_HR_EQ(pEnumBlobs(gs_iface, c2, &cap, capture_blob_cb), E_INVALIDARG);

    /* XGameSaveFilesGetFolderWithUiResult with too-small buffer -> E_GS_PROVIDED_BUFFER_TOO_SMALL (0x80830007) */
    {
        XAsyncBlock ab_files;
        memset(&ab_files, 0, sizeof(ab_files));
        ASSERT_HR_EQ(pFilesAsync(gs_iface, NULL, "00000000-0000-0000-0000-000071b6a9d4", &ab_files), S_OK);
        ASSERT_HR_EQ(xgr_async_get_status(&ab_files, true), S_OK);

        char tiny_folder[4] = { 0 };
        ASSERT_HR_EQ(pFilesRes(gs_iface, &ab_files, sizeof(tiny_folder), tiny_folder), E_GS_PROVIDED_BUFFER_TOO_SMALL);

        char full_folder[MAX_PATH * 2] = { 0 };
        ASSERT_HR_EQ(pFilesRes(gs_iface, &ab_files, sizeof(full_folder), full_folder), S_OK);
        ASSERT_TRUE(strstr(full_folder, "SystemAppData\\xgs\\") != NULL);
    }
}

/* =========================================================================
 * Suite 5: `XUserGetTokenAndSignature` / `Utf16` NUL-Inclusive Sizes,
 *          Unsigned `signature == NULL` & `Manual` Work Queue Completion
 * ========================================================================= */

static bool g_mock_return_signature = false;

static HRESULT mock_xuser_rpc_handler(const char *method, const char *params_json_obj, char **out_result_json)
{
    (void)params_json_obj;
    if (strcmp(method, "session.init") == 0) {
        *out_result_json = strdup(
            "{\"xuid\":\"2533274790395904\",\"gamertag\":\"CommanderShepard\","
            "\"modernGamertag\":\"CommanderShepard\",\"modernGamertagSuffix\":\"77\","
            "\"uniqueModernGamertag\":\"CommanderShepard#77\",\"ageGroup\":3}"
        );
        return S_OK;
    }
    if (strcmp(method, "xuser.getTokenAndSignature") == 0) {
        if (g_mock_return_signature) {
            *out_result_json = strdup(
                "{\"token\":\"XBL3.0 x=2533274790395904;eyJhbGciOiJIUzI1NiJ9\","
                "\"signature\":\"AAAAAQIDBAUGBwg=\"}"
            );
        } else {
            *out_result_json = strdup(
                "{\"token\":\"XBL3.0 x=2533274790395904;eyJhbGciOiJIUzI1NiJ9\","
                "\"signature\":\"\"}"
            );
        }
        return S_OK;
    }
    *out_result_json = strdup("{}");
    return S_OK;
}

typedef HRESULT (WINAPI *fn_th_create_queue_t)(void *, XTaskQueueDispatchMode, XTaskQueueDispatchMode, XTaskQueueHandle *);
typedef BOOLEAN (WINAPI *fn_th_dispatch_t)(void *, XTaskQueueHandle, XTaskQueuePort, UINT32);
typedef void    (WINAPI *fn_th_close_queue_t)(void *, XTaskQueueHandle);

typedef void    (WINAPI *fn_xu_close_user_t)(void *, XUserHandle);
typedef HRESULT (WINAPI *fn_xu_add_async_t)(void *, XUserAddOptions, XAsyncBlock *);
typedef HRESULT (WINAPI *fn_xu_add_res_t)(void *, XAsyncBlock *, XUserHandle *);
typedef HRESULT (WINAPI *fn_xu_tok_async_t)(void *, XUserHandle, uint32_t, const char *, const char *, SIZE_T, const XUserGetTokenAndSignatureHttpHeader *, SIZE_T, const void *, XAsyncBlock *);
typedef HRESULT (WINAPI *fn_xu_tok_size_t)(void *, XAsyncBlock *, SIZE_T *);
typedef HRESULT (WINAPI *fn_xu_tok_res_t)(void *, XAsyncBlock *, SIZE_T, void *, XUserGetTokenAndSignatureData **, SIZE_T *);
typedef HRESULT (WINAPI *fn_xu_tok16_async_t)(void *, XUserHandle, uint32_t, const WCHAR *, const WCHAR *, SIZE_T, const XUserGetTokenAndSignatureUtf16HttpHeader *, SIZE_T, const void *, XAsyncBlock *);
typedef HRESULT (WINAPI *fn_xu_tok16_size_t)(void *, XAsyncBlock *, SIZE_T *);
typedef HRESULT (WINAPI *fn_xu_tok16_res_t)(void *, XAsyncBlock *, SIZE_T, void *, XUserGetTokenAndSignatureUtf16Data **, SIZE_T *);

static void CALLBACK manual_queue_completion_cb(XAsyncBlock *ab)
{
    if (ab && ab->context) {
        _Atomic int32_t *flag = (_Atomic int32_t *)ab->context;
        atomic_store_explicit(flag, 1, memory_order_release);
    }
}

static void test_xuser_token_signature_and_manual_work_queue(void)
{
    g_mock_rpc_handler = mock_xuser_rpc_handler;

    void *th_iface = NULL, *xu_iface = NULL;
    ASSERT_HR_EQ(QueryApiImpl(&CLSID_XThreadingImpl, &IID_IXThreadingImpl, &th_iface), S_OK);
    ASSERT_HR_EQ(QueryApiImpl(&CLSID_XUserImpl, &IID_IXUserImpl6, &xu_iface), S_OK);
    const void *const *th_vtbl = *(const void *const **)th_iface;
    const void *const *xu_vtbl = *(const void *const **)xu_iface;

    fn_th_create_queue_t pCreateQueue = (fn_th_create_queue_t)th_vtbl[12];
    fn_th_dispatch_t     pDispatch    = (fn_th_dispatch_t)th_vtbl[16];
    fn_th_close_queue_t  pCloseQueue  = (fn_th_close_queue_t)th_vtbl[17];

    fn_xu_close_user_t  pCloseUser  = (fn_xu_close_user_t)xu_vtbl[4];
    fn_xu_add_async_t   pAddAsync   = (fn_xu_add_async_t)xu_vtbl[7];
    fn_xu_add_res_t     pAddRes     = (fn_xu_add_res_t)xu_vtbl[8];
    fn_xu_tok_async_t   pTokAsync   = (fn_xu_tok_async_t)xu_vtbl[23];
    fn_xu_tok_size_t    pTokSize    = (fn_xu_tok_size_t)xu_vtbl[24];
    fn_xu_tok_res_t     pTokRes     = (fn_xu_tok_res_t)xu_vtbl[25];
    fn_xu_tok16_async_t pTok16Async = (fn_xu_tok16_async_t)xu_vtbl[26];
    fn_xu_tok16_size_t  pTok16Size  = (fn_xu_tok16_size_t)xu_vtbl[27];
    fn_xu_tok16_res_t   pTok16Res   = (fn_xu_tok16_res_t)xu_vtbl[28];

    /* Acquire signed-in XUserHandle */
    XUserHandle user = NULL;
    {
        XAsyncBlock ab;
        memset(&ab, 0, sizeof(ab));
        ASSERT_HR_EQ(pAddAsync(xu_iface, XUserAddOptions_AddDefaultUserSilently, &ab), S_OK);
        ASSERT_HR_EQ(xgr_async_get_status(&ab, true), S_OK);
        ASSERT_HR_EQ(pAddRes(xu_iface, &ab, &user), S_OK);
        ASSERT_TRUE(user != NULL);
    }

    /* Create Manual work + Manual completion queue: NEVER pump XTaskQueuePort_Work! */
    XTaskQueueHandle manual_q = NULL;
    ASSERT_HR_EQ(pCreateQueue(th_iface, XTaskQueueDispatchMode_Manual, XTaskQueueDispatchMode_Manual, &manual_q), S_OK);
    ASSERT_TRUE(manual_q != NULL);

    const char *expected_tok = "XBL3.0 x=2533274790395904;eyJhbGciOiJIUzI1NiJ9";
    const char *expected_sig = "AAAAAQIDBAUGBwg=";

    /* 1. UTF-8 Unsigned on Manual work queue (must NOT deadlock without pumping Work port!) */
    g_mock_return_signature = false;
    {
        _Atomic int32_t cb_fired = 0;
        XAsyncBlock ab;
        memset(&ab, 0, sizeof(ab));
        ab.queue = manual_q;
        ab.context = &cb_fired;
        ab.callback = manual_queue_completion_cb;
        ASSERT_HR_EQ(pTokAsync(xu_iface, user, 0, "GET", "https://title.mgt.xboxlive.com/", 0, NULL, 0, NULL, &ab), S_OK);

        /* Wait until background pool worker enqueues completion onto manual_q's Completion port */
        bool completed = false;
        for (int tries = 0; tries < 500; tries++) {
            if (pDispatch(th_iface, manual_q, XTaskQueuePort_Completion, 5)) {
                completed = true;
                break;
            }
        }
        ASSERT_TRUE(completed);
        ASSERT_TRUE(atomic_load_explicit(&cb_fired, memory_order_acquire) == 1);
        ASSERT_HR_EQ(xgr_async_get_status(&ab, false), S_OK);

        SIZE_T req_sz = 0, used_sz = 0;
        ASSERT_HR_EQ(pTokSize(xu_iface, &ab, &req_sz), S_OK);
        void *buf = calloc(1, req_sz);
        XUserGetTokenAndSignatureData *data = NULL;
        ASSERT_HR_EQ(pTokRes(xu_iface, &ab, req_sz, buf, &data, &used_sz), S_OK);
        ASSERT_TRUE(data == (XUserGetTokenAndSignatureData *)buf);
        ASSERT_TRUE(data->token != NULL);
        ASSERT_STREQ(data->token, expected_tok);
        ASSERT_TRUE(data->tokenSize == strlen(expected_tok) + 1);
        ASSERT_TRUE(data->token[data->tokenSize - 1] == '\0');
        ASSERT_TRUE(data->signatureSize == 0);
        ASSERT_TRUE(data->signature == NULL);
        free(buf);
    }

    /* 2. UTF-8 Signed relocation */
    g_mock_return_signature = true;
    {
        XAsyncBlock ab;
        memset(&ab, 0, sizeof(ab));
        ASSERT_HR_EQ(pTokAsync(xu_iface, user, 0, "POST", "https://userpresence.xboxlive.com/", 0, NULL, 2, "{}", &ab), S_OK);
        ASSERT_HR_EQ(xgr_async_get_status(&ab, true), S_OK);

        SIZE_T req_sz = 0;
        ASSERT_HR_EQ(pTokSize(xu_iface, &ab, &req_sz), S_OK);
        void *buf = calloc(1, req_sz);
        XUserGetTokenAndSignatureData *data = NULL;
        ASSERT_HR_EQ(pTokRes(xu_iface, &ab, req_sz, buf, &data, NULL), S_OK);
        ASSERT_STREQ(data->token, expected_tok);
        ASSERT_TRUE(data->tokenSize == strlen(expected_tok) + 1);
        ASSERT_TRUE(data->signature != NULL);
        ASSERT_STREQ(data->signature, expected_sig);
        ASSERT_TRUE(data->signatureSize == strlen(expected_sig) + 1);
        free(buf);
    }

    /* 3. UTF-16 Unsigned + Signed NUL-inclusive tokenCount / signatureCount */
    wchar_t *w_method = utf8_to_wstr_test("GET");
    wchar_t *w_url = utf8_to_wstr_test("https://titlestorage.xboxlive.com/");

    g_mock_return_signature = false;
    {
        XAsyncBlock ab;
        memset(&ab, 0, sizeof(ab));
        ASSERT_HR_EQ(pTok16Async(xu_iface, user, 0, w_method, w_url, 0, NULL, 0, NULL, &ab), S_OK);
        ASSERT_HR_EQ(xgr_async_get_status(&ab, true), S_OK);

        SIZE_T req_sz = 0;
        ASSERT_HR_EQ(pTok16Size(xu_iface, &ab, &req_sz), S_OK);
        void *buf = calloc(1, req_sz);
        XUserGetTokenAndSignatureUtf16Data *wdata = NULL;
        ASSERT_HR_EQ(pTok16Res(xu_iface, &ab, req_sz, buf, &wdata, NULL), S_OK);
        ASSERT_TRUE(wdata != NULL && wdata->token != NULL);
        ASSERT_TRUE(wdata->tokenCount == wcslen(wdata->token) + 1);
        ASSERT_TRUE(wdata->tokenCount == strlen(expected_tok) + 1);
        ASSERT_TRUE(wdata->token[wdata->tokenCount - 1] == 0);
        ASSERT_TRUE(wdata->signatureCount == 0);
        ASSERT_TRUE(wdata->signature == NULL);
        free(buf);
    }

    g_mock_return_signature = true;
    {
        XAsyncBlock ab;
        memset(&ab, 0, sizeof(ab));
        ASSERT_HR_EQ(pTok16Async(xu_iface, user, 0, w_method, w_url, 0, NULL, 0, NULL, &ab), S_OK);
        ASSERT_HR_EQ(xgr_async_get_status(&ab, true), S_OK);

        SIZE_T req_sz = 0;
        ASSERT_HR_EQ(pTok16Size(xu_iface, &ab, &req_sz), S_OK);
        void *buf = calloc(1, req_sz);
        XUserGetTokenAndSignatureUtf16Data *wdata = NULL;
        ASSERT_HR_EQ(pTok16Res(xu_iface, &ab, req_sz, buf, &wdata, NULL), S_OK);
        ASSERT_TRUE(wdata->tokenCount == wcslen(wdata->token) + 1);
        ASSERT_TRUE(wdata->signature != NULL);
        ASSERT_TRUE(wdata->signatureCount == wcslen(wdata->signature) + 1);
        ASSERT_TRUE(wdata->signatureCount == strlen(expected_sig) + 1);
        free(buf);
    }

    free(w_method);
    free(w_url);
    pCloseQueue(th_iface, manual_q);
    pCloseUser(xu_iface, user);
    win32_drain_background_workers();
    g_mock_rpc_handler = NULL;
}

/* =========================================================================
 * Suite 6: All 24 Coclasses (25 COM Vtables), `IXGameUiImpl` 3 Legacy IIDs,
 *          `REGDB_E_CLASSNOTREG`, `XThreadVerifyNotTimeSensitive` & `AppNotify`
 * ========================================================================= */

typedef HRESULT (WINAPI *fn_qi_t)(void *, REFIID, void **);
typedef ULONG   (WINAPI *fn_rel_t)(void *);
typedef HRESULT (WINAPI *fn_set_ts_t)(void *, BOOLEAN);
typedef HRESULT (WINAPI *fn_verify_not_ts_t)(void *);
typedef BOOLEAN (WINAPI *fn_is_ts_t)(void *);

static void NTAPI dummy_appstate_cb(BOOLEAN quiesced, PVOID ctx) { (void)quiesced; (void)ctx; }
static void NTAPI dummy_appconstrained_cb(BOOLEAN constrained, PVOID ctx) { (void)constrained; (void)ctx; }

static void test_com_vtables_legacy_iids_threading_and_appnotify(void)
{
    /* 1. Unknown CLSID -> REGDB_E_CLASSNOTREG (0x80040154) */
    const GUID unknown_clsid = { 0xDEADBEEFu, 0x1111u, 0x2222u, { 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA } };
    void *unk_out = (void *)(uintptr_t)0x1234;
    ASSERT_HR_EQ(QueryApiImpl(&unknown_clsid, &IID_IUnknown, &unk_out), REGDB_E_CLASSNOTREG);
    ASSERT_TRUE(unk_out == NULL);

    /* 2. All 24 Coclasses (25 COM Vtables = 513 total function pointer slots) MUST be non-NULL! */
    struct vtbl_spec {
        const char *name;
        const GUID *clsid;
        const GUID *iid;
        size_t slots;
    };
    const struct vtbl_spec specs[25] = {
        { "IXThreadingImpl",               &CLSID_XThreadingImpl,              &IID_IXThreadingImpl,               31 },
        { "IXErrorImpl",                   &CLSID_XErrorImpl,                  &IID_IXErrorImpl,                    6 },
        { "IXUserImpl6",                   &CLSID_XUserImpl,                   &IID_IXUserImpl6,                   51 },
        { "IXUserGamertagImpl",            &CLSID_XUserImpl,                   &IID_IXUserGamertagImpl,             4 },
        { "IXUserDeviceImpl2",             &CLSID_XUserDeviceImpl,             &IID_IXUserDeviceImpl2,             11 },
        { "IXStoreImpl6",                  &CLSID_XStoreImpl,                  &IID_IXStoreImpl6,                  84 },
        { "IXGameSaveImpl4",               &CLSID_XGameSaveImpl,               &IID_IXGameSaveImpl4,               50 },
        { "IXPackageImpl4",                &CLSID_XPackageImpl,                &IID_IXPackageImpl4,                42 },
        { "IXGameImpl3",                   &CLSID_XGameImpl,                   &IID_IXGameImpl3,                    6 },
        { "IXSystemImpl5",                 &CLSID_XSystemImpl,                 &IID_IXSystemImpl5,                  9 },
        { "IXSystemAnalyticsImpl",         &CLSID_XSystemAnalyticsImpl,        &IID_IXSystemAnalyticsImpl,          4 },
        { "IXPersistentLocalStorageImpl3", &CLSID_XPersistentLocalStorageImpl, &IID_IXPersistentLocalStorageImpl3,  9 },
        { "IXNetworkingImpl2",             &CLSID_XNetworkingImpl,             &IID_IXNetworkingImpl2,             21 },
        { "IXGameUiImpl4",                 &CLSID_XGameUiImpl,                 &IID_IXGameUiImpl4,                 51 },
        { "IXGameRuntimeFeatureImpl",      &CLSID_XGameRuntimeFeatureImpl,     &IID_IXGameRuntimeFeatureImpl,       4 },
        { "IXDisplayImpl",                 &CLSID_XDisplayImpl,                &IID_IXDisplayImpl,                  5 },
        { "IXLauncherImpl",                &CLSID_XLauncherImpl,               &IID_IXLauncherImpl,                 6 },
        { "IXAccessibilityImpl2",          &CLSID_XAccessibilityImpl,          &IID_IXAccessibilityImpl2,          23 },
        { "IXAppCaptureImpl4",             &CLSID_XAppCaptureImpl,             &IID_IXAppCaptureImpl4,             19 },
        { "IXAppCaptureMetadataImpl",      &CLSID_XAppCaptureMetadataImpl,     &IID_IXAppCaptureMetadataImpl,      19 },
        { "IXGameProtocolImpl",            &CLSID_XGameProtocolImpl,           &IID_IXGameProtocolImpl,             5 },
        { "IXGameActivationImpl",          &CLSID_XGameActivationImpl,         &IID_IXGameActivationImpl,           6 },
        { "IXGameInviteImpl2",             &CLSID_XGameInviteImpl,             &IID_IXGameInviteImpl2,              8 },
        { "IXGameStreamingImpl3",          &CLSID_XGameStreamingImpl,          &IID_IXGameStreamingImpl3,          35 },
        { "IXGameEventImpl",               &CLSID_XGameEventImpl,              &IID_IXGameEventImpl,                4 }
    };

    for (size_t i = 0; i < 25; i++) {
        void *iface = NULL;
        ASSERT_HR_EQ(QueryApiImpl(specs[i].clsid, specs[i].iid, &iface), S_OK);
        ASSERT_TRUE(iface != NULL);
        const void *const *vtbl = *(const void *const **)iface;
        ASSERT_TRUE(vtbl != NULL);
        for (size_t s = 0; s < specs[i].slots; s++) {
            if (vtbl[s] == NULL) {
                fprintf(stderr, "[ASAN-FAIL] NULL COM vtable slot: %s[%zu]\n", specs[i].name, s);
                abort();
            }
        }
        fn_rel_t pRel = (fn_rel_t)vtbl[2];
        (void)pRel(iface);
    }

    /* 3. IXGameUiImpl QueryInterface MUST accept all 3 legacy IIDs ({a26365fb-...}, {121248e5-...}, {72c4e70f-...}) */
    {
        const GUID *legacy_ui_iids[3] = {
            &IID_IXGameUiImpl_Legacy0,
            &IID_IXGameUiImpl_Legacy1,
            &IID_IXGameUiImpl_Legacy2
        };
        for (int i = 0; i < 3; i++) {
            void *ui_iface = NULL;
            ASSERT_HR_EQ(QueryApiImpl(&CLSID_XGameUiImpl, legacy_ui_iids[i], &ui_iface), S_OK);
            ASSERT_TRUE(ui_iface != NULL);

            const void *const *vtbl = *(const void *const **)ui_iface;
            fn_qi_t pQI = (fn_qi_t)vtbl[0];
            void *via_qi = NULL;
            ASSERT_HR_EQ(pQI(ui_iface, legacy_ui_iids[(i + 1) % 3], &via_qi), S_OK);
            ASSERT_TRUE(via_qi == ui_iface);
        }
    }

    /* 4. XThreadSetTimeSensitive / XThreadIsTimeSensitive / XThreadVerifyNotTimeSensitive */
    {
        void *th_iface = NULL;
        ASSERT_HR_EQ(QueryApiImpl(&CLSID_XThreadingImpl, &IID_IXThreadingImpl, &th_iface), S_OK);
        const void *const *th_vtbl = *(const void *const **)th_iface;
        fn_set_ts_t        pSetTs       = (fn_set_ts_t)th_vtbl[27];
        fn_verify_not_ts_t pVerifyNotTs = (fn_verify_not_ts_t)th_vtbl[28];
        fn_is_ts_t         pIsTs        = (fn_is_ts_t)th_vtbl[30];

        ASSERT_TRUE(pIsTs(th_iface) == FALSE);
        ASSERT_HR_EQ(pVerifyNotTs(th_iface), S_OK);

        ASSERT_HR_EQ(pSetTs(th_iface, TRUE), S_OK);
        ASSERT_TRUE(pIsTs(th_iface) == TRUE);
        ASSERT_HR_EQ(pVerifyNotTs(th_iface), (HRESULT)0x89235100L);

        ASSERT_HR_EQ(pSetTs(th_iface, FALSE), S_OK);
        ASSERT_TRUE(pIsTs(th_iface) == FALSE);
        ASSERT_HR_EQ(pVerifyNotTs(th_iface), S_OK);
    }

    /* 5. AppNotify Bridge (`one_appnotify_bridge.dll`) registration & unregistration */
    {
        PAPPSTATE_REGISTRATION sreg1 = NULL, sreg2 = NULL;
        ASSERT_TRUE(RegisterAppStateChangeNotification(NULL, NULL, &sreg1) == ERROR_INVALID_PARAMETER);
        ASSERT_TRUE(RegisterAppStateChangeNotification(dummy_appstate_cb, NULL, NULL) == ERROR_INVALID_PARAMETER);
        ASSERT_TRUE(RegisterAppStateChangeNotification(dummy_appstate_cb, (PVOID)0x1, &sreg1) == ERROR_SUCCESS);
        ASSERT_TRUE(RegisterAppStateChangeNotification(dummy_appstate_cb, (PVOID)0x2, &sreg2) == ERROR_SUCCESS);
        ASSERT_TRUE(sreg1 != NULL && sreg2 != NULL && sreg1 != sreg2);
        UnregisterAppStateChangeNotification(sreg1);
        UnregisterAppStateChangeNotification(sreg2);

        PAPPCONSTRAINED_REGISTRATION creg1 = NULL;
        ASSERT_TRUE(RegisterAppConstrainedChangeNotification(NULL, NULL, &creg1) == ERROR_INVALID_PARAMETER);
        ASSERT_TRUE(RegisterAppConstrainedChangeNotification(dummy_appconstrained_cb, NULL, NULL) == ERROR_INVALID_PARAMETER);
        ASSERT_TRUE(RegisterAppConstrainedChangeNotification(dummy_appconstrained_cb, NULL, &creg1) == ERROR_SUCCESS);
        ASSERT_TRUE(creg1 != NULL);
        UnregisterAppConstrainedChangeNotification(creg1);
    }
}

/* =========================================================================
 * Suite 7: Production `xthreading.c` 10,000-Cycle Multi-Threaded `XAsync`
 *          Stress & 512-Slot Completed Ring Wrap (0 UAF, 0 UB)
 * ========================================================================= */

struct stress_payload {
    uint64_t magic_value;
    _Atomic int32_t cleanup_count;
};

static const int k_stress_identity_tag = 42;

static HRESULT CALLBACK stress_async_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct stress_payload *p = (struct stress_payload *)data->context;
    switch (op) {
        case XAsyncOp_Begin:
            return S_OK;
        case XAsyncOp_DoWork:
            xgr_async_complete(data->async, S_OK, sizeof(uint64_t));
            return S_OK;
        case XAsyncOp_GetResult:
            if (p && data->buffer && data->bufferSize >= sizeof(uint64_t)) {
                memcpy(data->buffer, &p->magic_value, sizeof(uint64_t));
            }
            return S_OK;
        case XAsyncOp_Cleanup:
            if (p) atomic_fetch_add_explicit(&p->cleanup_count, 1, memory_order_relaxed);
            return S_OK;
        default:
            return S_OK;
    }
}

static void CALLBACK self_freeing_completion_cb(XAsyncBlock *ab)
{
    uint64_t out_val = 0;
    size_t used = 0;
    HRESULT hr = xgr_async_get_result(ab, &k_stress_identity_tag, sizeof(out_val), &out_val, &used);
    ASSERT_HR_EQ(hr, S_OK);
    ASSERT_TRUE(used == sizeof(uint64_t));
    ASSERT_TRUE(out_val == 0xCAFEBABE12345678ULL);
    /* Free heap XAsyncBlock inside completion callback to prove 0 UAF in xthreading.c! */
    free(ab);
}

struct stress_worker_args {
    int thread_id;
    XTaskQueueHandle imm_queue;
    struct stress_payload *payload;
};

static void *concurrent_xasync_stress_worker(void *arg)
{
    struct stress_worker_args *wargs = (struct stress_worker_args *)arg;
    for (int i = 0; i < 1000; i++) {
        XAsyncBlock *ab = (XAsyncBlock *)calloc(1, sizeof(*ab));
        ASSERT_TRUE(ab != NULL);
        ab->queue = wargs->imm_queue;
        if (((i + wargs->thread_id) & 1) == 0) {
            ab->callback = self_freeing_completion_cb;
            ASSERT_HR_EQ(xgr_async_begin(ab, wargs->payload, &k_stress_identity_tag, "stress", stress_async_provider), S_OK);
            ASSERT_HR_EQ(xgr_async_schedule(ab, 0), S_OK);
        } else {
            ASSERT_HR_EQ(xgr_async_begin(ab, wargs->payload, &k_stress_identity_tag, "stress", stress_async_provider), S_OK);
            ASSERT_HR_EQ(xgr_async_schedule(ab, 0), S_OK);
            if ((i % 3) == 0) {
                uint64_t v = 0;
                HRESULT get_hr = xgr_async_get_result(ab, &k_stress_identity_tag, sizeof(v), &v, NULL);
                ASSERT_TRUE(get_hr == S_OK || get_hr == E_INVALIDARG);
                if (get_hr == S_OK) {
                    ASSERT_TRUE(v == 0xCAFEBABE12345678ULL);
                }
            }
            free(ab);
        }
    }
    return NULL;
}

static struct stress_payload g_stress_payload;

static void test_production_xasync_10000_cycles(void)
{
    void *th_iface = NULL;
    ASSERT_HR_EQ(QueryApiImpl(&CLSID_XThreadingImpl, &IID_IXThreadingImpl, &th_iface), S_OK);
    const void *const *th_vtbl = *(const void *const **)th_iface;
    fn_th_create_queue_t pCreateQueue = (fn_th_create_queue_t)th_vtbl[12];
    fn_th_close_queue_t  pCloseQueue  = (fn_th_close_queue_t)th_vtbl[17];

    XTaskQueueHandle imm_q = NULL;
    ASSERT_HR_EQ(pCreateQueue(th_iface, XTaskQueueDispatchMode_Immediate, XTaskQueueDispatchMode_Immediate, &imm_q), S_OK);
    ASSERT_TRUE(imm_q != NULL);

    g_stress_payload.magic_value = 0xCAFEBABE12345678ULL;
    atomic_init(&g_stress_payload.cleanup_count, 0);

    XAsyncBlock stale_copy;
    memset(&stale_copy, 0, sizeof(stale_copy));

    /* 6,000 single-threaded rapid cycles */
    for (int i = 0; i < 6000; i++) {
        if ((i % 3) == 0) {
            XAsyncBlock *heap_ab = (XAsyncBlock *)calloc(1, sizeof(*heap_ab));
            ASSERT_TRUE(heap_ab != NULL);
            heap_ab->queue = imm_q;
            heap_ab->callback = self_freeing_completion_cb;
            ASSERT_HR_EQ(xgr_async_begin(heap_ab, &g_stress_payload, &k_stress_identity_tag, "stress", stress_async_provider), S_OK);
            ASSERT_HR_EQ(xgr_async_schedule(heap_ab, 0), S_OK);
        } else if ((i % 3) == 1) {
            XAsyncBlock stack_ab;
            memset(&stack_ab, 0, sizeof(stack_ab));
            stack_ab.queue = imm_q;
            ASSERT_HR_EQ(xgr_async_begin(&stack_ab, &g_stress_payload, &k_stress_identity_tag, "stress", stress_async_provider), S_OK);
            ASSERT_HR_EQ(xgr_async_schedule(&stack_ab, 0), S_OK);
            ASSERT_HR_EQ(xgr_async_get_status(&stack_ab, false), S_OK);
            uint64_t val = 0;
            size_t used = 0;
            ASSERT_HR_EQ(xgr_async_get_result(&stack_ab, &k_stress_identity_tag, sizeof(val), &val, &used), S_OK);
            ASSERT_TRUE(val == 0xCAFEBABE12345678ULL);
            /* Retired block returns cached S_OK on status and rejects duplicate buffer read */
            ASSERT_HR_EQ(xgr_async_get_status(&stack_ab, false), S_OK);
            ASSERT_HR_EQ(xgr_async_get_result(&stack_ab, &k_stress_identity_tag, sizeof(val), &val, &used), E_INVALIDARG);
        } else {
            XAsyncBlock uncollected;
            memset(&uncollected, 0, sizeof(uncollected));
            uncollected.queue = imm_q;
            ASSERT_HR_EQ(xgr_async_begin(&uncollected, &g_stress_payload, &k_stress_identity_tag, "stress", stress_async_provider), S_OK);
            ASSERT_HR_EQ(xgr_async_schedule(&uncollected, 0), S_OK);
            if (i == 2) {
                memcpy(&stale_copy, &uncollected, sizeof(stale_copy));
            }
        }
    }

    /* Stale cookie from i == 2 was evicted > 10x ago from the 512-slot ring -> E_INVALIDARG (0 UAF!) */
    ASSERT_HR_EQ(xgr_async_get_status(&stale_copy, false), E_INVALIDARG);

    /* Plus 4 concurrent pthreads x 1,000 cycles = 4,000 concurrent cycles (10,000 total!) */
    pthread_t threads[4];
    struct stress_worker_args wargs[4];
    for (int t = 0; t < 4; t++) {
        wargs[t].thread_id = t;
        wargs[t].imm_queue = imm_q;
        wargs[t].payload = &g_stress_payload;
        ASSERT_TRUE(pthread_create(&threads[t], NULL, concurrent_xasync_stress_worker, &wargs[t]) == 0);
    }
    for (int t = 0; t < 4; t++) {
        ASSERT_TRUE(pthread_join(threads[t], NULL) == 0);
    }

    pCloseQueue(th_iface, imm_q);
}

/* =========================================================================
 * Main Runner & Zero-Leak Verification Gate
 * ========================================================================= */

int main(void)
{
    char tmp_template[] = "/tmp/one-xgr-asan-cdrive-XXXXXX";
    char *created_root = mkdtemp(tmp_template);
    ASSERT_TRUE(created_root != NULL);
    snprintf(g_win32_virtual_c_root, sizeof(g_win32_virtual_c_root), "%s", created_root);
    setenv("ONE_XGR_APPDATA_DIR", "C:\\TestAppData", 1);

    /* Suite 1 & 2 (pre-runtime pure codecs & XML reconciliation) */
    test_production_strbuf_json_and_base64();
    test_production_xml_pfn_and_scid_reconciliation();

    /* Initialize production XGR Bridge runtime with inline retail config */
    const char *runtime_xml =
        "<Game configVersion=\"1\">"
        "  <Identity Name=\"Blobfish.Brotato\" Publisher=\"CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US\" Version=\"1.0.1.3\"/>"
        "  <TitleId>71B6A9D4</TitleId>"
        "  <ShellVisuals DefaultDisplayName=\"Brotato\"/>"
        "</Game>";
    struct xgr_initialize_options init_opts = { .gameConfig = runtime_xml, .isInline = true };
    ASSERT_HR_EQ(InitializeApiImplEx2(0, 0, 0, &init_opts), S_OK);
    ASSERT_HR_EQ(DllCanUnloadNow(), S_FALSE);

    /* Suite 3..7 (production WGS binary v14, Mono GC shared provider, XUser, 25 COM vtables, AppNotify, 10k XAsync) */
    test_production_wgs_index_and_blob_lifecycle();
    test_mono_gc_shared_provider_and_edge_contracts();
    test_xuser_token_signature_and_manual_work_queue();
    test_com_vtables_legacy_iids_threading_and_appnotify();
    test_production_xasync_10000_cycles();

    /* Drain any detached pool workers and uninitialize entire production runtime */
    win32_drain_background_workers();
    ASSERT_HR_EQ(UninitializeApiImpl(), S_OK);
    win32_drain_background_workers();
    ASSERT_HR_EQ(DllCanUnloadNow(), S_OK);
    ASSERT_TRUE(atomic_load_explicit(&g_stress_payload.cleanup_count, memory_order_seq_cst) == 10000);

    rm_rf_posix(g_win32_virtual_c_root);

    int64_t remaining = atomic_load_explicit(&g_win32_live_allocs, memory_order_seq_cst);
    if (remaining != 0) {
        fprintf(stderr, "[ASAN-FAIL] Leaked %" PRId64 " heap/handle allocations across production xgr_bridge!\n", remaining);
        return 1;
    }

    printf(
        "[xgr_bridge_asan_test] PASS — Production xgr_bridge C11 TUs: WGS v14 40B/blob lifecycle, "
        "Mono GC double-CloseProvider, XUser NUL+ManualQueue, XML <DevelopmentOnly>/SCID, "
        "25 COM vtables (513 slots) + AppNotify & 10,000 XAsync cycles (0 UAF, 0 UB, 0 leaks)\n"
    );
    return 0;
}
