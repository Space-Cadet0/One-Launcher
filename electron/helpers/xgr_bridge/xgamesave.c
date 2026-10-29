/*
 * One Launcher XGR Bridge — IXGameSaveImpl4 (`CLSID_XGameSaveImpl`)
 * Reads & writes authentic Windows `SystemAppData\wgs\<HexXuid>_<Scid>\containers.index` (v14)
 * + `<FOLDER_GUID>\container.<N>` (v4, 160-byte blob entries) + `<BLOB_GUID>` files,
 * and bridges `xgamesave.init` / `xgamesave.commit` over loopback RPC to `xboxTitleStorageSync.cjs`.
 */

#include "xgr_internal.h"

#define WGS_WINDOWS_EPOCH_DIFF_SEC 11644473600ULL

_Static_assert(sizeof(GUID) == 16, "GUID must be 16 bytes");

struct wgs_blob_entry {
    char name[128];
    GUID guid_a;
    GUID guid_b;
    uint32_t size;
};

struct wgs_container_entry {
    char name[256];
    char display_name[256];
    char tag[128];
    uint8_t container_num;
    uint32_t state_flags;
    GUID folder_guid;
    uint64_t modified_ft;
    uint64_t entry_unknown;
    uint64_t total_size;
};

struct wgs_index_state {
    int32_t version;
    char pkg_display_name[256];
    char store_pkg_aumid[256];
    uint64_t creation_ft;
    int32_t header_flags;
    char sync_metadata_id[128];
    uint64_t header_unknown;
    uint32_t count;
    struct wgs_container_entry *items;
};

struct XGameSaveProvider {
    CRITICAL_SECTION cs;
    volatile LONG ref;
    volatile LONG api_closed;
    uint64_t xuid;
    char scid[128];
    char pfn[256];
    int64_t quota_bytes;
    wchar_t wgs_user_dir[MAX_PATH * 2];
    wchar_t xgs_user_dir[MAX_PATH * 2];
};

struct XGameSaveContainer {
    volatile LONG ref;
    volatile LONG api_closed;
    XGameSaveProviderHandle provider;
    char name[256];
};

struct update_op {
    char *name;
    uint8_t *data;
    size_t size;
    bool remove;
};

struct XGameSaveUpdate {
    volatile LONG ref;
    volatile LONG api_closed;
    XGameSaveContainerHandle container;
    char *display_name;
    uint32_t count;
    uint32_t cap;
    struct update_op *ops;
    bool submitted;
};

struct gs_ptr_registry {
    void **items;
    size_t count;
    size_t cap;
};

static SRWLOCK g_gs_handles_lock = SRWLOCK_INIT;
static struct gs_ptr_registry g_live_providers = { NULL, 0, 0 };
static struct gs_ptr_registry g_live_containers = { NULL, 0, 0 };
static struct gs_ptr_registry g_live_updates = { NULL, 0, 0 };

static bool gs_reg_insert(struct gs_ptr_registry *r, void *ptr)
{
    if (!r || !ptr) return false;
    AcquireSRWLockExclusive(&g_gs_handles_lock);
    for (size_t i = 0; i < r->count; i++) {
        if (r->items[i] == ptr) {
            ReleaseSRWLockExclusive(&g_gs_handles_lock);
            return true;
        }
    }
    if (r->count == r->cap) {
        size_t ncap = r->cap ? r->cap * 2 : 16;
        void **nitems = (void **)realloc(r->items, ncap * sizeof(void *));
        if (!nitems) {
            ReleaseSRWLockExclusive(&g_gs_handles_lock);
            return false;
        }
        r->items = nitems;
        r->cap = ncap;
    }
    r->items[r->count++] = ptr;
    ReleaseSRWLockExclusive(&g_gs_handles_lock);
    return true;
}

static bool gs_reg_remove(struct gs_ptr_registry *r, void *ptr)
{
    if (!r || !ptr) return false;
    AcquireSRWLockExclusive(&g_gs_handles_lock);
    for (size_t i = 0; i < r->count; i++) {
        if (r->items[i] == ptr) {
            r->items[i] = r->items[--r->count];
            ReleaseSRWLockExclusive(&g_gs_handles_lock);
            return true;
        }
    }
    ReleaseSRWLockExclusive(&g_gs_handles_lock);
    return false;
}

static bool acquire_live_provider(XGameSaveProviderHandle prov)
{
    if (!prov) return false;
    AcquireSRWLockShared(&g_gs_handles_lock);
    for (size_t i = 0; i < g_live_providers.count; i++) {
        if (g_live_providers.items[i] == (void *)prov) {
            if (InterlockedCompareExchange(&prov->api_closed, 0, 0) == 0) {
                InterlockedIncrement(&prov->ref);
                ReleaseSRWLockShared(&g_gs_handles_lock);
                return true;
            }
            break;
        }
    }
    ReleaseSRWLockShared(&g_gs_handles_lock);
    return false;
}

static bool acquire_live_container(XGameSaveContainerHandle cont)
{
    if (!cont) return false;
    AcquireSRWLockShared(&g_gs_handles_lock);
    for (size_t i = 0; i < g_live_containers.count; i++) {
        if (g_live_containers.items[i] == (void *)cont) {
            if (InterlockedCompareExchange(&cont->api_closed, 0, 0) == 0) {
                InterlockedIncrement(&cont->ref);
                ReleaseSRWLockShared(&g_gs_handles_lock);
                return true;
            }
            break;
        }
    }
    ReleaseSRWLockShared(&g_gs_handles_lock);
    return false;
}

static bool acquire_live_update(XGameSaveUpdateHandle upd)
{
    if (!upd) return false;
    AcquireSRWLockShared(&g_gs_handles_lock);
    for (size_t i = 0; i < g_live_updates.count; i++) {
        if (g_live_updates.items[i] == (void *)upd) {
            if (InterlockedCompareExchange(&upd->api_closed, 0, 0) == 0) {
                InterlockedIncrement(&upd->ref);
                ReleaseSRWLockShared(&g_gs_handles_lock);
                return true;
            }
            break;
        }
    }
    ReleaseSRWLockShared(&g_gs_handles_lock);
    return false;
}

/* -------------------------------------------------------------------------
 * Path, GUID & FILETIME Helpers
 * ------------------------------------------------------------------------- */

static uint64_t now_filetime_u64(void)
{
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    return ((uint64_t)ft.dwHighDateTime << 32) | (uint64_t)ft.dwLowDateTime;
}

static int64_t filetime_to_unix_sec(uint64_t ft)
{
    uint64_t sec = ft / 10000000ULL;
    if (sec <= WGS_WINDOWS_EPOCH_DIFF_SEC) return 0;
    return (int64_t)(sec - WGS_WINDOWS_EPOCH_DIFF_SEC);
}

static void guid_to_upper_hex32(const GUID *g, wchar_t out_w[33])
{
    swprintf(
        out_w,
        33,
        L"%08lX%04X%04X%02X%02X%02X%02X%02X%02X%02X%02X",
        (unsigned long)g->Data1,
        (unsigned)g->Data2,
        (unsigned)g->Data3,
        (unsigned)g->Data4[0], (unsigned)g->Data4[1],
        (unsigned)g->Data4[2], (unsigned)g->Data4[3],
        (unsigned)g->Data4[4], (unsigned)g->Data4[5],
        (unsigned)g->Data4[6], (unsigned)g->Data4[7]
    );
}

static bool is_zero_guid(const GUID *g)
{
    static const GUID z = { 0 };
    return memcmp(g, &z, sizeof(GUID)) == 0;
}

static void normalize_scid_lower(const char *in_scid, const char *fallback_scid, char *out_scid, size_t out_sz)
{
    if (!out_scid || out_sz == 0) return;
    out_scid[0] = '\0';
    const char *src = (in_scid && in_scid[0]) ? in_scid : fallback_scid;
    if (!src || !src[0]) src = "00000000-0000-0000-0000-000000000000";
    size_t j = 0;
    for (size_t i = 0; src[i] && j + 1 < out_sz; i++) {
        char c = src[i];
        if (c == '{' || c == '}' || c == ' ' || c == '\t') continue;
        if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
        out_scid[j++] = c;
    }
    out_scid[j] = '\0';
}

static void ensure_dir_recursive_w(const wchar_t *dir_path)
{
    if (!dir_path || !dir_path[0]) return;
    wchar_t tmp[MAX_PATH * 2];
    wcsncpy(tmp, dir_path, (sizeof(tmp) / sizeof(tmp[0])) - 1);
    tmp[(sizeof(tmp) / sizeof(tmp[0])) - 1] = L'\0';

    for (wchar_t *p = tmp; *p; p++) {
        if (*p == L'/') *p = L'\\';
    }
    for (wchar_t *p = tmp + 3; *p; p++) {
        if (*p == L'\\') {
            *p = L'\0';
            CreateDirectoryW(tmp, NULL);
            *p = L'\\';
        }
    }
    CreateDirectoryW(tmp, NULL);
}

static bool resolve_system_appdata_dirs(
    uint64_t xuid,
    const char *scid_lower,
    const char *pfn_utf8,
    wchar_t *out_wgs_dir,
    size_t out_wgs_cch,
    wchar_t *out_xgs_dir,
    size_t out_xgs_cch
)
{
    wchar_t base_local[MAX_PATH * 2] = { 0 };
    DWORD n = GetEnvironmentVariableW(L"ONE_XGR_APPDATA_DIR", base_local, MAX_PATH * 2 - 1);
    if (n == 0 || n >= MAX_PATH * 2 - 1) {
        n = GetEnvironmentVariableW(L"LOCALAPPDATA", base_local, MAX_PATH * 2 - 1);
    }
    if (n == 0 || n >= MAX_PATH * 2 - 1) {
        wcscpy(base_local, L"C:\\users\\Public\\AppData\\Local");
    }

    const char *pfn = (pfn_utf8 && pfn_utf8[0]) ? pfn_utf8 : "OneLauncher.XboxGame_8wekyb3d8bbwe";
    wchar_t pfn_w[256] = { 0 };
    MultiByteToWideChar(CP_UTF8, 0, pfn, -1, pfn_w, 255);

    wchar_t scid_w[128] = { 0 };
    MultiByteToWideChar(CP_UTF8, 0, scid_lower, -1, scid_w, 127);

    swprintf(
        out_wgs_dir,
        out_wgs_cch,
        L"%ls\\Packages\\%ls\\SystemAppData\\wgs\\%016llX_%ls",
        base_local,
        pfn_w,
        (unsigned long long)xuid,
        scid_w
    );
    swprintf(
        out_xgs_dir,
        out_xgs_cch,
        L"%ls\\Packages\\%ls\\SystemAppData\\xgs\\%016llX_%ls",
        base_local,
        pfn_w,
        (unsigned long long)xuid,
        scid_w
    );

    ensure_dir_recursive_w(out_wgs_dir);
    ensure_dir_recursive_w(out_xgs_dir);
    return true;
}

static uint8_t *read_whole_file_w(const wchar_t *path, size_t *out_len)
{
    if (out_len) *out_len = 0;
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return NULL;
    LARGE_INTEGER sz;
    if (!GetFileSizeEx(h, &sz) || sz.QuadPart < 0 || sz.QuadPart > (256LL * 1024LL * 1024LL)) {
        CloseHandle(h);
        return NULL;
    }
    size_t len = (size_t)sz.QuadPart;
    uint8_t *buf = (uint8_t *)malloc(len ? len : 1);
    if (!buf) {
        CloseHandle(h);
        return NULL;
    }
    DWORD got = 0;
    if (len > 0 && (!ReadFile(h, buf, (DWORD)len, &got, NULL) || got != (DWORD)len)) {
        free(buf);
        CloseHandle(h);
        return NULL;
    }
    CloseHandle(h);
    if (out_len) *out_len = len;
    return buf;
}

static bool write_whole_file_atomic_w(const wchar_t *path, const uint8_t *data, size_t len)
{
    wchar_t tmp_path[MAX_PATH * 2];
    swprintf(tmp_path, sizeof(tmp_path) / sizeof(tmp_path[0]), L"%ls.tmp.%lu", path, (unsigned long)GetCurrentThreadId());

    HANDLE h = CreateFileW(tmp_path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    BOOL ok = (len == 0) ? TRUE : WriteFile(h, data, (DWORD)len, &written, NULL);
    FlushFileBuffers(h);
    CloseHandle(h);
    if (!ok || (len > 0 && written != (DWORD)len)) {
        DeleteFileW(tmp_path);
        return false;
    }
    if (!MoveFileExW(tmp_path, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(tmp_path);
        return false;
    }
    return true;
}

/* -------------------------------------------------------------------------
 * Binary `containers.index` (v14) & `container.<N>` (v4) Codec
 * ------------------------------------------------------------------------- */

struct bin_writer {
    uint8_t *buf;
    size_t len;
    size_t cap;
};

static bool bw_append(struct bin_writer *w, const void *src, size_t n)
{
    if (w->len + n > w->cap) {
        size_t ncap = w->cap ? w->cap * 2 : 512;
        while (ncap < w->len + n) ncap *= 2;
        uint8_t *nb = (uint8_t *)realloc(w->buf, ncap);
        if (!nb) return false;
        w->buf = nb;
        w->cap = ncap;
    }
    if (n > 0) memcpy(w->buf + w->len, src, n);
    w->len += n;
    return true;
}

static bool bw_utf16_str(struct bin_writer *w, const char *utf8)
{
    const char *s = utf8 ? utf8 : "";
    if (!s[0]) {
        int32_t zero = 0;
        return bw_append(w, &zero, 4);
    }
    int wlen = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    if (wlen <= 1) {
        int32_t zero = 0;
        return bw_append(w, &zero, 4);
    }
    int32_t char_count = (int32_t)(wlen - 1);
    wchar_t *wbuf = (wchar_t *)malloc((size_t)wlen * sizeof(wchar_t));
    if (!wbuf) return false;
    MultiByteToWideChar(CP_UTF8, 0, s, -1, wbuf, wlen);
    bool ok = bw_append(w, &char_count, 4) && bw_append(w, wbuf, (size_t)char_count * 2);
    free(wbuf);
    return ok;
}

static bool br_utf16_str(const uint8_t *buf, size_t len, size_t *off, char *out_utf8, size_t out_sz)
{
    if (*off + 4 > len) return false;
    int32_t char_count = 0;
    memcpy(&char_count, buf + *off, 4);
    *off += 4;
    if (char_count < 0 || char_count > 65536 || *off + (size_t)char_count * 2 > len) return false;
    if (out_utf8 && out_sz > 0) out_utf8[0] = '\0';
    if (char_count > 0 && out_utf8 && out_sz > 0) {
        const wchar_t *wptr = (const wchar_t *)(buf + *off);
        int n = WideCharToMultiByte(CP_UTF8, 0, wptr, char_count, out_utf8, (int)(out_sz - 1), NULL, NULL);
        if (n > 0) out_utf8[n] = '\0';
    }
    *off += (size_t)char_count * 2;
    return true;
}

static void free_wgs_index(struct wgs_index_state *idx)
{
    if (!idx) return;
    free(idx->items);
    memset(idx, 0, sizeof(*idx));
}

static void init_default_wgs_index(struct wgs_index_state *idx)
{
    struct xgr_runtime_config_snapshot snap;
    xgr_copy_runtime_config_snapshot(&snap);

    memset(idx, 0, sizeof(*idx));
    idx->version = 14;
    snprintf(idx->pkg_display_name, sizeof(idx->pkg_display_name), "%s", snap.displayName);
    if (snap.packageFamilyName[0]) {
        snprintf(idx->store_pkg_aumid, sizeof(idx->store_pkg_aumid), "%s!App", snap.packageFamilyName);
    }
    idx->creation_ft = now_filetime_u64();
    idx->header_unknown = 0;
    idx->count = 0;
    idx->items = NULL;
}

static bool load_wgs_index(const wchar_t *wgs_user_dir, struct wgs_index_state *out)
{
    init_default_wgs_index(out);
    wchar_t idx_path[MAX_PATH * 2];
    swprintf(idx_path, sizeof(idx_path) / sizeof(idx_path[0]), L"%ls\\containers.index", wgs_user_dir);

    size_t len = 0;
    uint8_t *buf = read_whole_file_w(idx_path, &len);
    if (!buf || len < 28) {
        free(buf);
        free_wgs_index(out);
        init_default_wgs_index(out);
        return false;
    }

    size_t off = 0;
    int32_t version = 0, count = 0;
    memcpy(&version, buf + off, 4); off += 4;
    memcpy(&count, buf + off, 4); off += 4;
    if (count < 0 || count > 65536) {
        free(buf);
        free_wgs_index(out);
        init_default_wgs_index(out);
        return false;
    }
    out->version = version;

    if (!br_utf16_str(buf, len, &off, out->pkg_display_name, sizeof(out->pkg_display_name)) ||
        !br_utf16_str(buf, len, &off, out->store_pkg_aumid, sizeof(out->store_pkg_aumid)) ||
        off + 12 > len) {
        free(buf);
        free_wgs_index(out);
        init_default_wgs_index(out);
        return false;
    }
    memcpy(&out->creation_ft, buf + off, 8); off += 8;
    memcpy(&out->header_flags, buf + off, 4); off += 4;

    if (!br_utf16_str(buf, len, &off, out->sync_metadata_id, sizeof(out->sync_metadata_id)) ||
        off + 8 > len) {
        free(buf);
        free_wgs_index(out);
        init_default_wgs_index(out);
        return false;
    }
    memcpy(&out->header_unknown, buf + off, 8); off += 8;

    if (count > 0) {
        out->items = (struct wgs_container_entry *)calloc((size_t)count, sizeof(*out->items));
        if (!out->items) {
            free(buf);
            free_wgs_index(out);
            init_default_wgs_index(out);
            return false;
        }
        for (int32_t i = 0; i < count; i++) {
            struct wgs_container_entry *ce = &out->items[i];
            if (!br_utf16_str(buf, len, &off, ce->name, sizeof(ce->name)) ||
                !br_utf16_str(buf, len, &off, ce->display_name, sizeof(ce->display_name)) ||
                !br_utf16_str(buf, len, &off, ce->tag, sizeof(ce->tag)) ||
                off + 45 > len) {
                free_wgs_index(out);
                init_default_wgs_index(out);
                free(buf);
                return false;
            }
            ce->container_num = buf[off]; off += 1;
            memcpy(&ce->state_flags, buf + off, 4); off += 4;
            memcpy(&ce->folder_guid, buf + off, 16); off += 16;
            memcpy(&ce->modified_ft, buf + off, 8); off += 8;
            memcpy(&ce->entry_unknown, buf + off, 8); off += 8;
            memcpy(&ce->total_size, buf + off, 8); off += 8;
            if (!ce->display_name[0]) snprintf(ce->display_name, sizeof(ce->display_name), "%s", ce->name);
        }
        out->count = (uint32_t)count;
    } else {
        out->count = 0;
        out->items = NULL;
    }

    free(buf);
    return true;
}

static bool save_wgs_index(const wchar_t *wgs_user_dir, const struct wgs_index_state *idx)
{
    struct bin_writer w = { NULL, 0, 0 };
    int32_t ver = idx->version ? idx->version : 14;
    int32_t cnt = (idx->items != NULL) ? (int32_t)idx->count : 0;

    bool ok = bw_append(&w, &ver, 4) &&
              bw_append(&w, &cnt, 4) &&
              bw_utf16_str(&w, idx->pkg_display_name) &&
              bw_utf16_str(&w, idx->store_pkg_aumid) &&
              bw_append(&w, &idx->creation_ft, 8) &&
              bw_append(&w, &idx->header_flags, 4) &&
              bw_utf16_str(&w, idx->sync_metadata_id) &&
              bw_append(&w, &idx->header_unknown, 8);

    for (uint32_t i = 0; ok && idx->items != NULL && i < idx->count; i++) {
        const struct wgs_container_entry *ce = &idx->items[i];
        ok = bw_utf16_str(&w, ce->name) &&
             bw_utf16_str(&w, ce->display_name[0] ? ce->display_name : ce->name) &&
             bw_utf16_str(&w, ce->tag) &&
             bw_append(&w, &ce->container_num, 1) &&
             bw_append(&w, &ce->state_flags, 4) &&
             bw_append(&w, &ce->folder_guid, 16) &&
             bw_append(&w, &ce->modified_ft, 8) &&
             bw_append(&w, &ce->entry_unknown, 8) &&
             bw_append(&w, &ce->total_size, 8);
    }

    if (!ok) {
        free(w.buf);
        return false;
    }

    wchar_t idx_path[MAX_PATH * 2];
    swprintf(idx_path, sizeof(idx_path) / sizeof(idx_path[0]), L"%ls\\containers.index", wgs_user_dir);
    bool wrote = write_whole_file_atomic_w(idx_path, w.buf, w.len);
    free(w.buf);
    return wrote;
}

static bool load_container_blobs(
    const wchar_t *wgs_user_dir,
    const struct wgs_container_entry *ce,
    struct wgs_blob_entry **out_blobs,
    uint32_t *out_count
)
{
    *out_blobs = NULL;
    *out_count = 0;

    wchar_t folder_hex[33];
    guid_to_upper_hex32(&ce->folder_guid, folder_hex);
    wchar_t cfile[MAX_PATH * 2];
    swprintf(cfile, sizeof(cfile) / sizeof(cfile[0]), L"%ls\\%ls\\container.%u", wgs_user_dir, folder_hex, (unsigned)ce->container_num);

    size_t len = 0;
    uint8_t *buf = read_whole_file_w(cfile, &len);
    if (!buf || len < 8) {
        free(buf);
        return true;
    }

    int32_t bcount = 0;
    memcpy(&bcount, buf + 4, 4);
    if (bcount <= 0 || 8 + (size_t)bcount * 160 > len) {
        free(buf);
        return true;
    }

    struct wgs_blob_entry *arr = (struct wgs_blob_entry *)calloc((size_t)bcount, sizeof(*arr));
    if (!arr) {
        free(buf);
        return false;
    }

    for (int32_t i = 0; i < bcount; i++) {
        const uint8_t *rec = buf + 8 + (size_t)i * 160;
        wchar_t wname[65] = { 0 };
        memcpy(wname, rec, 128);
        wname[64] = L'\0';
        WideCharToMultiByte(CP_UTF8, 0, wname, -1, arr[i].name, sizeof(arr[i].name) - 1, NULL, NULL);
        memcpy(&arr[i].guid_a, rec + 128, 16);
        memcpy(&arr[i].guid_b, rec + 144, 16);

        const GUID *active = !is_zero_guid(&arr[i].guid_a) ? &arr[i].guid_a : &arr[i].guid_b;
        wchar_t bhex[33];
        guid_to_upper_hex32(active, bhex);
        wchar_t bpath[MAX_PATH * 2];
        swprintf(bpath, sizeof(bpath) / sizeof(bpath[0]), L"%ls\\%ls\\%ls", wgs_user_dir, folder_hex, bhex);

        WIN32_FILE_ATTRIBUTE_DATA fad;
        if (GetFileAttributesExW(bpath, GetFileExInfoStandard, &fad)) {
            arr[i].size = fad.nFileSizeLow;
        }
    }

    free(buf);
    *out_blobs = arr;
    *out_count = (uint32_t)bcount;
    return true;
}

static bool save_container_blobs(
    const wchar_t *wgs_user_dir,
    const struct wgs_container_entry *ce,
    const struct wgs_blob_entry *blobs,
    uint32_t count
)
{
    wchar_t folder_hex[33];
    guid_to_upper_hex32(&ce->folder_guid, folder_hex);
    wchar_t folder_dir[MAX_PATH * 2];
    swprintf(folder_dir, sizeof(folder_dir) / sizeof(folder_dir[0]), L"%ls\\%ls", wgs_user_dir, folder_hex);
    ensure_dir_recursive_w(folder_dir);

    size_t total = 8 + (size_t)count * 160;
    uint8_t *buf = (uint8_t *)calloc(1, total);
    if (!buf) return false;

    int32_t ver = 4;
    int32_t cnt = (int32_t)count;
    memcpy(buf, &ver, 4);
    memcpy(buf + 4, &cnt, 4);

    for (uint32_t i = 0; i < count; i++) {
        uint8_t *rec = buf + 8 + (size_t)i * 160;
        wchar_t wname[64] = { 0 };
        MultiByteToWideChar(CP_UTF8, 0, blobs[i].name, -1, wname, 64);
        wname[63] = L'\0';
        memcpy(rec, wname, 128);
        memcpy(rec + 128, &blobs[i].guid_a, 16);
        memcpy(rec + 144, &blobs[i].guid_b, 16);
    }

    wchar_t cfile[MAX_PATH * 2];
    swprintf(cfile, sizeof(cfile) / sizeof(cfile[0]), L"%ls\\container.%u", folder_dir, (unsigned)ce->container_num);
    bool ok = write_whole_file_atomic_w(cfile, buf, total);
    free(buf);
    return ok;
}

/* -------------------------------------------------------------------------
 * Provider Initialization & RPC Cloud Sync Triggers
 * ------------------------------------------------------------------------- */

static void notify_rpc_save_init(XGameSaveProviderHandle prov)
{
    if (!xgr_rpc_is_configured()) return;
    XgrStrBuf sb;
    xgr_sb_init(&sb);
    xgr_sb_append_fmt(&sb, "{\"xuid\":\"%llu\",\"scid\":", (unsigned long long)prov->xuid);
    xgr_sb_append_json_str(&sb, prov->scid);
    xgr_sb_append_cstr(&sb, ",\"packageFamilyName\":");
    xgr_sb_append_json_str(&sb, prov->pfn);
    xgr_sb_append_char(&sb, '}');
    char *params = xgr_sb_detach(&sb);
    if (!params) return;

    char *res = NULL;
    if (SUCCEEDED(xgr_rpc_call("xgamesave.init", params, &res)) && res) {
        int64_t q = 0;
        if (xgr_json_get_int64(res, "quotaBytes", &q) && q > 0) {
            prov->quota_bytes = q;
        }
        free(res);
    }
    free(params);
}

static void notify_rpc_save_commit(XGameSaveProviderHandle prov, const char *container_name, bool deleted)
{
    if (!xgr_rpc_is_configured()) return;
    XgrStrBuf sb;
    xgr_sb_init(&sb);
    xgr_sb_append_fmt(&sb, "{\"xuid\":\"%llu\",\"scid\":", (unsigned long long)prov->xuid);
    xgr_sb_append_json_str(&sb, prov->scid);
    xgr_sb_append_cstr(&sb, ",\"packageFamilyName\":");
    xgr_sb_append_json_str(&sb, prov->pfn);
    xgr_sb_append_cstr(&sb, ",\"containerName\":");
    xgr_sb_append_json_str(&sb, container_name ? container_name : "");
    xgr_sb_append_fmt(&sb, ",\"deleted\":%s}", deleted ? "true" : "false");
    char *params = xgr_sb_detach(&sb);
    if (!params) return;

    char *res = NULL;
    if (SUCCEEDED(xgr_rpc_call("xgamesave.commit", params, &res)) && res) {
        free(res);
    }
    free(params);
}

static void provider_release(XGameSaveProviderHandle p);

static HRESULT create_provider_internal(XUserHandle user, const char *config_id, bool register_api_handle, XGameSaveProviderHandle *out)
{
    if (!out) return E_INVALIDARG;
    *out = NULL;

    struct xgr_runtime_config_snapshot snap;
    xgr_copy_runtime_config_snapshot(&snap);

    XGameSaveProviderHandle p = (XGameSaveProviderHandle)calloc(1, sizeof(*p));
    if (!p) return E_OUTOFMEMORY;
    InitializeCriticalSection(&p->cs);
    p->ref = 1;
    p->api_closed = 0;
    p->xuid = xgr_user_get_xuid(user);
    p->quota_bytes = XGR_SAVE_QUOTA_DEFAULT;
    normalize_scid_lower(config_id, snap.scid, p->scid, sizeof(p->scid));
    snprintf(
        p->pfn,
        sizeof(p->pfn),
        "%s",
        snap.packageFamilyName[0] ? snap.packageFamilyName : "OneLauncher.XboxGame_8wekyb3d8bbwe"
    );

    resolve_system_appdata_dirs(
        p->xuid,
        p->scid,
        p->pfn,
        p->wgs_user_dir,
        sizeof(p->wgs_user_dir) / sizeof(p->wgs_user_dir[0]),
        p->xgs_user_dir,
        sizeof(p->xgs_user_dir) / sizeof(p->xgs_user_dir[0])
    );

    notify_rpc_save_init(p);

    /* Ensure a baseline containers.index exists */
    struct wgs_index_state idx;
    if (!load_wgs_index(p->wgs_user_dir, &idx)) {
        save_wgs_index(p->wgs_user_dir, &idx);
    }
    free_wgs_index(&idx);

    if (register_api_handle) {
        if (!gs_reg_insert(&g_live_providers, p)) {
            provider_release(p);
            return E_OUTOFMEMORY;
        }
    }

    *out = p;
    return S_OK;
}

static void provider_release(XGameSaveProviderHandle p)
{
    if (!p) return;
    if (InterlockedDecrement(&p->ref) == 0) {
        DeleteCriticalSection(&p->cs);
        free(p);
    }
}

static void container_release(XGameSaveContainerHandle c)
{
    if (!c) return;
    if (InterlockedDecrement(&c->ref) == 0) {
        provider_release(c->provider);
        free(c);
    }
}

static void update_release(XGameSaveUpdateHandle u)
{
    if (!u) return;
    if (InterlockedDecrement(&u->ref) == 0) {
        for (uint32_t i = 0; i < u->count; i++) {
            free(u->ops[i].name);
            free(u->ops[i].data);
        }
        free(u->ops);
        free(u->display_name);
        container_release(u->container);
        free(u);
    }
}

void xgr_gamesave_shutdown(void)
{
    void **upds = NULL, **conts = NULL, **provs = NULL;
    size_t ucnt = 0, ccnt = 0, pcnt = 0;

    AcquireSRWLockExclusive(&g_gs_handles_lock);
    upds = g_live_updates.items; ucnt = g_live_updates.count;
    g_live_updates.items = NULL; g_live_updates.count = 0; g_live_updates.cap = 0;

    conts = g_live_containers.items; ccnt = g_live_containers.count;
    g_live_containers.items = NULL; g_live_containers.count = 0; g_live_containers.cap = 0;

    provs = g_live_providers.items; pcnt = g_live_providers.count;
    g_live_providers.items = NULL; g_live_providers.count = 0; g_live_providers.cap = 0;
    ReleaseSRWLockExclusive(&g_gs_handles_lock);

    for (size_t i = 0; i < ucnt; i++) {
        XGameSaveUpdateHandle u = (XGameSaveUpdateHandle)upds[i];
        if (u && InterlockedCompareExchange(&u->api_closed, 1, 0) == 0) {
            update_release(u);
        }
    }
    free(upds);

    for (size_t i = 0; i < ccnt; i++) {
        XGameSaveContainerHandle c = (XGameSaveContainerHandle)conts[i];
        if (c && InterlockedCompareExchange(&c->api_closed, 1, 0) == 0) {
            container_release(c);
        }
    }
    free(conts);

    for (size_t i = 0; i < pcnt; i++) {
        XGameSaveProviderHandle p = (XGameSaveProviderHandle)provs[i];
        if (p && InterlockedCompareExchange(&p->api_closed, 1, 0) == 0) {
            provider_release(p);
        }
    }
    free(provs);
}

/* -------------------------------------------------------------------------
 * Core Container Operations (Delete, SubmitUpdate, ReadBlobs)
 * ------------------------------------------------------------------------- */

static bool is_valid_container_name(const char *name)
{
    if (!name || !name[0]) return false;
    size_t len = strlen(name);
    if (len > 255) return false;
    for (size_t i = 0; i < len; i++) {
        char c = name[i];
        if (c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|') {
            return false;
        }
    }
    return true;
}

static void delete_blob_guid_file_w(const wchar_t *folder_dir, const GUID *g)
{
    if (!folder_dir || !g || is_zero_guid(g)) return;
    wchar_t bhex[33], bpath[MAX_PATH * 2];
    guid_to_upper_hex32(g, bhex);
    swprintf(bpath, sizeof(bpath) / sizeof(bpath[0]), L"%ls\\%ls", folder_dir, bhex);
    DeleteFileW(bpath);
}

static bool push_guid_list(GUID **arr, size_t *cnt, size_t *cap, const GUID *g)
{
    if (!g || is_zero_guid(g)) return true;
    for (size_t i = 0; i < *cnt; i++) {
        if (memcmp(&(*arr)[i], g, sizeof(GUID)) == 0) return true;
    }
    if (*cnt == *cap) {
        size_t ncap = *cap ? (*cap * 2) : 8;
        GUID *narr = (GUID *)realloc(*arr, ncap * sizeof(GUID));
        if (!narr) return false;
        *arr = narr;
        *cap = ncap;
    }
    (*arr)[(*cnt)++] = *g;
    return true;
}

static HRESULT delete_container_sync(XGameSaveProviderHandle prov, const char *cname)
{
    if (!prov || !cname) return E_INVALIDARG;
    if (!is_valid_container_name(cname)) return E_GS_INVALID_CONTAINER_NAME;

    EnterCriticalSection(&prov->cs);
    struct wgs_index_state idx;
    load_wgs_index(prov->wgs_user_dir, &idx);

    for (uint32_t i = 0; idx.items != NULL && i < idx.count; i++) {
        if (strcmp(idx.items[i].name, cname) == 0) {
            struct wgs_blob_entry *blobs = NULL;
            uint32_t bcnt = 0;
            wchar_t fhex[33], fdir[MAX_PATH * 2];
            guid_to_upper_hex32(&idx.items[i].folder_guid, fhex);
            swprintf(fdir, sizeof(fdir) / sizeof(fdir[0]), L"%ls\\%ls", prov->wgs_user_dir, fhex);
            if (load_container_blobs(prov->wgs_user_dir, &idx.items[i], &blobs, &bcnt)) {
                for (uint32_t b = 0; b < bcnt; b++) {
                    delete_blob_guid_file_w(fdir, &blobs[b].guid_a);
                    if (memcmp(&blobs[b].guid_b, &blobs[b].guid_a, sizeof(GUID)) != 0) {
                        delete_blob_guid_file_w(fdir, &blobs[b].guid_b);
                    }
                }
                free(blobs);
            }
            wchar_t cfile[MAX_PATH * 2];
            swprintf(cfile, sizeof(cfile) / sizeof(cfile[0]), L"%ls\\container.%u", fdir, (unsigned)idx.items[i].container_num);
            DeleteFileW(cfile);
            RemoveDirectoryW(fdir);

            if (i + 1 < idx.count) {
                memmove(&idx.items[i], &idx.items[i + 1], (idx.count - i - 1) * sizeof(*idx.items));
            }
            idx.count--;
            save_wgs_index(prov->wgs_user_dir, &idx);
            break;
        }
    }

    free_wgs_index(&idx);
    LeaveCriticalSection(&prov->cs);

    notify_rpc_save_commit(prov, cname, true);
    return S_OK;
}

static HRESULT submit_update_sync(XGameSaveUpdateHandle upd)
{
    if (!upd || !upd->container || !upd->container->provider) return E_INVALIDARG;
    if (upd->submitted) return E_GS_HANDLE_EXPIRED;

    size_t total_op_bytes = 0;
    for (uint32_t i = 0; i < upd->count; i++) total_op_bytes += upd->ops[i].size;
    if (total_op_bytes > 16 * 1024 * 1024) return E_GS_UPDATE_TOO_BIG;

    XGameSaveProviderHandle prov = upd->container->provider;
    const char *cname = upd->container->name;

    EnterCriticalSection(&prov->cs);
    struct wgs_index_state idx;
    load_wgs_index(prov->wgs_user_dir, &idx);

    bool is_new_container = false;
    struct wgs_container_entry *ce = NULL;
    for (uint32_t i = 0; idx.items != NULL && i < idx.count; i++) {
        if (strcmp(idx.items[i].name, cname) == 0) {
            ce = &idx.items[i];
            break;
        }
    }

    if (!ce) {
        if (!idx.items) idx.count = 0;
        struct wgs_container_entry *nitems = (struct wgs_container_entry *)realloc(
            idx.items,
            (idx.count + 1) * sizeof(*idx.items)
        );
        if (!nitems) {
            free_wgs_index(&idx);
            LeaveCriticalSection(&prov->cs);
            return E_OUTOFMEMORY;
        }
        idx.items = nitems;
        ce = &idx.items[idx.count++];
        memset(ce, 0, sizeof(*ce));
        snprintf(ce->name, sizeof(ce->name), "%s", cname);
        snprintf(ce->display_name, sizeof(ce->display_name), "%s", (upd->display_name && upd->display_name[0]) ? upd->display_name : cname);
        ce->container_num = 1;
        CoCreateGuid(&ce->folder_guid);
        is_new_container = true;
    } else if (upd->display_name && upd->display_name[0]) {
        snprintf(ce->display_name, sizeof(ce->display_name), "%s", upd->display_name);
    }

    struct wgs_blob_entry *blobs = NULL;
    uint32_t bcnt = 0;
    if (!is_new_container && !load_container_blobs(prov->wgs_user_dir, ce, &blobs, &bcnt)) {
        free_wgs_index(&idx);
        LeaveCriticalSection(&prov->cs);
        return E_OUTOFMEMORY;
    }

    wchar_t fhex[33], fdir[MAX_PATH * 2];
    guid_to_upper_hex32(&ce->folder_guid, fhex);
    swprintf(fdir, sizeof(fdir) / sizeof(fdir[0]), L"%ls\\%ls", prov->wgs_user_dir, fhex);
    ensure_dir_recursive_w(fdir);

    GUID *superseded_guids = NULL;
    size_t superseded_cnt = 0, superseded_cap = 0;
    GUID *newly_written_guids = NULL;
    size_t newly_written_cnt = 0, newly_written_cap = 0;

    HRESULT hr = S_OK;
    for (uint32_t i = 0; i < upd->count; i++) {
        struct update_op *op = &upd->ops[i];
        int found = -1;
        for (uint32_t b = 0; b < bcnt; b++) {
            if (strcmp(blobs[b].name, op->name) == 0) {
                found = (int)b;
                break;
            }
        }

        if (op->remove) {
            if (found >= 0) {
                (void)push_guid_list(&superseded_guids, &superseded_cnt, &superseded_cap, &blobs[found].guid_a);
                (void)push_guid_list(&superseded_guids, &superseded_cnt, &superseded_cap, &blobs[found].guid_b);
                if ((uint32_t)(found + 1) < bcnt) {
                    memmove(&blobs[found], &blobs[found + 1], (bcnt - (uint32_t)found - 1) * sizeof(*blobs));
                }
                bcnt--;
            }
        } else {
            GUID new_guid;
            CoCreateGuid(&new_guid);
            wchar_t new_hex[33], new_path[MAX_PATH * 2];
            guid_to_upper_hex32(&new_guid, new_hex);
            swprintf(new_path, sizeof(new_path) / sizeof(new_path[0]), L"%ls\\%ls", fdir, new_hex);
            if (!write_whole_file_atomic_w(new_path, op->data, op->size)) {
                hr = E_GS_OUT_OF_LOCAL_STORAGE;
                break;
            }
            (void)push_guid_list(&newly_written_guids, &newly_written_cnt, &newly_written_cap, &new_guid);

            if (found >= 0) {
                if (memcmp(&blobs[found].guid_a, &new_guid, sizeof(GUID)) != 0) {
                    (void)push_guid_list(&superseded_guids, &superseded_cnt, &superseded_cap, &blobs[found].guid_a);
                }
                if (memcmp(&blobs[found].guid_b, &new_guid, sizeof(GUID)) != 0) {
                    (void)push_guid_list(&superseded_guids, &superseded_cnt, &superseded_cap, &blobs[found].guid_b);
                }
                blobs[found].guid_a = new_guid;
                memset(&blobs[found].guid_b, 0, sizeof(GUID));
                blobs[found].size = (uint32_t)op->size;
            } else {
                struct wgs_blob_entry *nblobs = (struct wgs_blob_entry *)realloc(blobs, (bcnt + 1) * sizeof(*blobs));
                if (!nblobs) {
                    hr = E_OUTOFMEMORY;
                    break;
                }
                blobs = nblobs;
                memset(&blobs[bcnt], 0, sizeof(blobs[bcnt]));
                snprintf(blobs[bcnt].name, sizeof(blobs[bcnt].name), "%s", op->name);
                blobs[bcnt].guid_a = new_guid;
                memset(&blobs[bcnt].guid_b, 0, sizeof(GUID));
                blobs[bcnt].size = (uint32_t)op->size;
                bcnt++;
            }
        }
    }

    if (SUCCEEDED(hr)) {
        uint64_t sum_bytes = 0;
        for (uint32_t b = 0; b < bcnt; b++) sum_bytes += blobs[b].size;
        ce->total_size = sum_bytes;
        ce->modified_ft = now_filetime_u64();
        ce->state_flags |= 0x01; /* Mark dirty so xboxTitleStorageSync uploads it */

        uint8_t prev_num = ce->container_num;
        uint8_t next_num = is_new_container ? 1 : (uint8_t)((prev_num % 250) + 1);
        wchar_t prev_cfile[MAX_PATH * 2];
        swprintf(prev_cfile, sizeof(prev_cfile) / sizeof(prev_cfile[0]), L"%ls\\container.%u", fdir, (unsigned)prev_num);
        ce->container_num = next_num;

        if (save_container_blobs(prov->wgs_user_dir, ce, blobs, bcnt) &&
            save_wgs_index(prov->wgs_user_dir, &idx)) {
            if (!is_new_container && prev_num != next_num) {
                DeleteFileW(prev_cfile);
            }
            for (size_t s = 0; s < superseded_cnt; s++) {
                delete_blob_guid_file_w(fdir, &superseded_guids[s]);
            }
            upd->submitted = true;
        } else {
            hr = E_GS_OUT_OF_LOCAL_STORAGE;
        }
    }

    if (FAILED(hr)) {
        for (size_t nw = 0; nw < newly_written_cnt; nw++) {
            delete_blob_guid_file_w(fdir, &newly_written_guids[nw]);
        }
    }

    free(superseded_guids);
    free(newly_written_guids);
    free(blobs);
    free_wgs_index(&idx);
    LeaveCriticalSection(&prov->cs);

    if (SUCCEEDED(hr)) {
        notify_rpc_save_commit(prov, cname, false);
    }
    return hr;
}

struct prepared_blob_read {
    uint32_t count;
    size_t total_size;
    uint8_t *packed; /* Relocatable: name & data store byte offsets from base */
};

static HRESULT prepare_blob_read(
    XGameSaveContainerHandle cont,
    const char **blob_names,
    uint32_t name_count,
    struct prepared_blob_read *out
)
{
    memset(out, 0, sizeof(*out));
    if (!cont || !cont->provider) return E_INVALIDARG;

    XGameSaveProviderHandle prov = cont->provider;
    EnterCriticalSection(&prov->cs);

    struct wgs_index_state idx;
    load_wgs_index(prov->wgs_user_dir, &idx);
    struct wgs_container_entry *ce = NULL;
    for (uint32_t i = 0; idx.items != NULL && i < idx.count; i++) {
        if (strcmp(idx.items[i].name, cont->name) == 0) {
            ce = &idx.items[i];
            break;
        }
    }
    if (!ce) {
        free_wgs_index(&idx);
        LeaveCriticalSection(&prov->cs);
        return E_GS_BLOB_NOT_FOUND;
    }

    struct wgs_blob_entry *blobs = NULL;
    uint32_t bcnt = 0;
    load_container_blobs(prov->wgs_user_dir, ce, &blobs, &bcnt);

    wchar_t fhex[33];
    guid_to_upper_hex32(&ce->folder_guid, fhex);

    /* Match requested blobs (or all blobs if blob_names == NULL) */
    uint32_t target_max = (blob_names && name_count > 0) ? name_count : bcnt;
    if (target_max == 0) {
        free(blobs);
        free_wgs_index(&idx);
        LeaveCriticalSection(&prov->cs);
        return (blob_names && name_count > 0) ? E_GS_BLOB_NOT_FOUND : S_OK;
    }

    uint8_t **payloads = (uint8_t **)calloc(target_max, sizeof(uint8_t *));
    size_t *sizes = (size_t *)calloc(target_max, sizeof(size_t));
    const char **matched_names = (const char **)calloc(target_max, sizeof(const char *));
    if (!payloads || !sizes || !matched_names) {
        free(payloads); free(sizes); free(matched_names);
        free(blobs); free_wgs_index(&idx);
        LeaveCriticalSection(&prov->cs);
        return E_OUTOFMEMORY;
    }

    HRESULT hr = S_OK;
    uint32_t actual = 0;

    if (blob_names && name_count > 0) {
        for (uint32_t q = 0; q < name_count; q++) {
            const char *want = blob_names[q];
            int found = -1;
            for (uint32_t b = 0; b < bcnt; b++) {
                if (want && strcmp(blobs[b].name, want) == 0) {
                    found = (int)b;
                    break;
                }
            }
            if (found < 0) {
                hr = E_GS_BLOB_NOT_FOUND;
                break;
            }
            const GUID *ag = !is_zero_guid(&blobs[found].guid_a) ? &blobs[found].guid_a : &blobs[found].guid_b;
            wchar_t bhex[33], bpath[MAX_PATH * 2];
            guid_to_upper_hex32(ag, bhex);
            swprintf(bpath, sizeof(bpath) / sizeof(bpath[0]), L"%ls\\%ls\\%ls", prov->wgs_user_dir, fhex, bhex);
            size_t plen = 0;
            uint8_t *pbuf = read_whole_file_w(bpath, &plen);
            if (!pbuf) {
                hr = E_GS_BLOB_NOT_FOUND;
                break;
            }
            matched_names[actual] = blobs[found].name;
            payloads[actual] = pbuf;
            sizes[actual] = plen;
            actual++;
        }
    } else {
        for (uint32_t b = 0; b < bcnt; b++) {
            const GUID *ag = !is_zero_guid(&blobs[b].guid_a) ? &blobs[b].guid_a : &blobs[b].guid_b;
            wchar_t bhex[33], bpath[MAX_PATH * 2];
            guid_to_upper_hex32(ag, bhex);
            swprintf(bpath, sizeof(bpath) / sizeof(bpath[0]), L"%ls\\%ls\\%ls", prov->wgs_user_dir, fhex, bhex);
            size_t plen = 0;
            uint8_t *pbuf = read_whole_file_w(bpath, &plen);
            if (!pbuf) continue;
            matched_names[actual] = blobs[b].name;
            payloads[actual] = pbuf;
            sizes[actual] = plen;
            actual++;
        }
    }

    if (SUCCEEDED(hr) && actual > 0) {
        size_t total = (size_t)actual * sizeof(XGameSaveBlob);
        for (uint32_t i = 0; i < actual; i++) {
            total += strlen(matched_names[i]) + 1 + sizes[i];
        }
        uint8_t *packed = (uint8_t *)calloc(1, total);
        if (!packed) {
            hr = E_OUTOFMEMORY;
        } else {
            XGameSaveBlob *hdrs = (XGameSaveBlob *)packed;
            size_t cursor = (size_t)actual * sizeof(XGameSaveBlob);
            for (uint32_t i = 0; i < actual; i++) {
                size_t nlen = strlen(matched_names[i]) + 1;
                memcpy(packed + cursor, matched_names[i], nlen);
                hdrs[i].info.name = (const char *)(uintptr_t)cursor;
                hdrs[i].info.size = (uint32_t)sizes[i];
                cursor += nlen;

                if (sizes[i] > 0) memcpy(packed + cursor, payloads[i], sizes[i]);
                hdrs[i].data = (uint8_t *)(uintptr_t)cursor;
                cursor += sizes[i];
            }
            out->count = actual;
            out->total_size = total;
            out->packed = packed;
        }
    }

    for (uint32_t i = 0; i < actual; i++) free(payloads[i]);
    free(payloads);
    free(sizes);
    free(matched_names);
    free(blobs);
    free_wgs_index(&idx);
    LeaveCriticalSection(&prov->cs);
    return hr;
}

static void copy_relocated_blob_read(const struct prepared_blob_read *prep, XGameSaveBlob *dst)
{
    if (!prep || !dst || prep->total_size == 0 || !prep->packed) return;
    memcpy(dst, prep->packed, prep->total_size);
    uint8_t *base = (uint8_t *)dst;
    for (uint32_t i = 0; i < prep->count; i++) {
        dst[i].info.name = (const char *)(base + (uintptr_t)dst[i].info.name);
        dst[i].data = base + (uintptr_t)dst[i].data;
    }
}

/* -------------------------------------------------------------------------
 * Async Providers for IXGameSaveImpl4
 * ------------------------------------------------------------------------- */

struct gs_init_async {
    XUserHandle user;
    char scid[128];
    XGameSaveProviderHandle provider;
};

static HRESULT CALLBACK gs_init_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct gs_init_async *ctx = (struct gs_init_async *)data->context;
    switch (op) {
        case XAsyncOp_Begin:
            return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            HRESULT hr = create_provider_internal(ctx->user, ctx->scid, true, &ctx->provider);
            xgr_async_complete(data->async, hr, SUCCEEDED(hr) ? sizeof(XGameSaveProviderHandle) : 0);
            return S_OK;
        }
        case XAsyncOp_GetResult:
            if (!data->buffer || data->bufferSize < sizeof(XGameSaveProviderHandle)) return E_INVALIDARG;
            *(XGameSaveProviderHandle *)data->buffer = ctx->provider;
            ctx->provider = NULL;
            return S_OK;
        case XAsyncOp_Cleanup:
            if (ctx->provider) {
                if (gs_reg_remove(&g_live_providers, ctx->provider)) {
                    InterlockedExchange(&ctx->provider->api_closed, 1);
                }
                provider_release(ctx->provider);
            }
            if (ctx->user) xgr_user_close(ctx->user);
            free(ctx);
            return S_OK;
        default:
            return S_OK;
    }
}

struct gs_quota_async {
    XGameSaveProviderHandle provider;
    int64_t remaining;
};

static int64_t compute_remaining_quota(XGameSaveProviderHandle prov)
{
    if (!prov) return XGR_SAVE_QUOTA_DEFAULT;
    EnterCriticalSection(&prov->cs);
    struct wgs_index_state idx;
    load_wgs_index(prov->wgs_user_dir, &idx);
    uint64_t used = 0;
    for (uint32_t i = 0; idx.items != NULL && i < idx.count; i++) used += idx.items[i].total_size;
    free_wgs_index(&idx);
    int64_t rem = prov->quota_bytes - (int64_t)used;
    LeaveCriticalSection(&prov->cs);
    return rem > 0 ? rem : 0;
}

static HRESULT CALLBACK gs_quota_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct gs_quota_async *ctx = (struct gs_quota_async *)data->context;
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork:
            ctx->remaining = compute_remaining_quota(ctx->provider);
            xgr_async_complete(data->async, S_OK, sizeof(int64_t));
            return S_OK;
        case XAsyncOp_GetResult:
            if (!data->buffer || data->bufferSize < sizeof(int64_t)) return E_INVALIDARG;
            *(int64_t *)data->buffer = ctx->remaining;
            return S_OK;
        case XAsyncOp_Cleanup:
            provider_release(ctx->provider);
            free(ctx);
            return S_OK;
        default:
            return S_OK;
    }
}

struct gs_del_async {
    XGameSaveProviderHandle provider;
    char cname[256];
};

static HRESULT CALLBACK gs_del_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct gs_del_async *ctx = (struct gs_del_async *)data->context;
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            HRESULT hr = delete_container_sync(ctx->provider, ctx->cname);
            xgr_async_complete(data->async, hr, 0);
            return S_OK;
        }
        case XAsyncOp_Cleanup:
            provider_release(ctx->provider);
            free(ctx);
            return S_OK;
        default:
            return S_OK;
    }
}

struct gs_read_async {
    XGameSaveContainerHandle container;
    uint32_t req_count;
    char **req_names;
    struct prepared_blob_read prep;
    uint32_t *out_count_ptr;
};

static HRESULT CALLBACK gs_read_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct gs_read_async *ctx = (struct gs_read_async *)data->context;
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            HRESULT hr = prepare_blob_read(ctx->container, (const char **)ctx->req_names, ctx->req_count, &ctx->prep);
            xgr_async_complete(data->async, hr, SUCCEEDED(hr) ? ctx->prep.total_size : 0);
            return S_OK;
        }
        case XAsyncOp_GetResult:
            if (data->bufferSize < ctx->prep.total_size) return E_GS_PROVIDED_BUFFER_TOO_SMALL;
            if (!data->buffer && ctx->prep.total_size > 0) return E_INVALIDARG;
            if (ctx->prep.total_size > 0) copy_relocated_blob_read(&ctx->prep, (XGameSaveBlob *)data->buffer);
            if (ctx->out_count_ptr) *ctx->out_count_ptr = ctx->prep.count;
            return S_OK;
        case XAsyncOp_Cleanup:
            for (uint32_t i = 0; i < ctx->req_count; i++) free(ctx->req_names[i]);
            free(ctx->req_names);
            free(ctx->prep.packed);
            container_release(ctx->container);
            free(ctx);
            return S_OK;
        default:
            return S_OK;
    }
}

struct gs_submit_async {
    XGameSaveUpdateHandle update;
};

static HRESULT CALLBACK gs_submit_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct gs_submit_async *ctx = (struct gs_submit_async *)data->context;
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            HRESULT hr = submit_update_sync(ctx->update);
            xgr_async_complete(data->async, hr, 0);
            return S_OK;
        }
        case XAsyncOp_Cleanup:
            update_release(ctx->update);
            free(ctx);
            return S_OK;
        default:
            return S_OK;
    }
}

struct gs_folder_async {
    XUserHandle user;
    char scid[128];
    char folder_utf8[MAX_PATH * 2];
    size_t folder_size;
};

static HRESULT CALLBACK gs_folder_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct gs_folder_async *ctx = (struct gs_folder_async *)data->context;
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            XGameSaveProviderHandle prov = NULL;
            HRESULT hr = create_provider_internal(ctx->user, ctx->scid, false, &prov);
            if (SUCCEEDED(hr) && prov) {
                WideCharToMultiByte(CP_UTF8, 0, prov->xgs_user_dir, -1, ctx->folder_utf8, sizeof(ctx->folder_utf8) - 1, NULL, NULL);
                ctx->folder_size = strlen(ctx->folder_utf8) + 1;
                provider_release(prov);
            }
            xgr_async_complete(data->async, hr, SUCCEEDED(hr) ? ctx->folder_size : 0);
            return S_OK;
        }
        case XAsyncOp_GetResult:
            if (!data->buffer || data->bufferSize < ctx->folder_size) return E_GS_PROVIDED_BUFFER_TOO_SMALL;
            memcpy(data->buffer, ctx->folder_utf8, ctx->folder_size);
            return S_OK;
        case XAsyncOp_Cleanup:
            if (ctx->user) xgr_user_close(ctx->user);
            free(ctx);
            return S_OK;
        default:
            return S_OK;
    }
}

/* -------------------------------------------------------------------------
 * IXGameSaveImpl4 COM Interface Methods
 * ------------------------------------------------------------------------- */

static HRESULT WINAPI xgs_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) ||
        IsEqualGUID(riid, &IID_IXGameSaveImpl) ||
        IsEqualGUID(riid, &IID_IXGameSaveImpl2) ||
        IsEqualGUID(riid, &IID_IXGameSaveImpl3) ||
        IsEqualGUID(riid, &IID_IXGameSaveImpl4)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static ULONG WINAPI xgs_AddRef(void *iface) { (void)iface; return 2; }
static ULONG WINAPI xgs_Release(void *iface) { (void)iface; return 1; }

static HRESULT WINAPI xgs_XGameSaveInitializeProvider(void *iface, XUserHandle user, const char *configId, BOOLEAN syncOnDemand, XGameSaveProviderHandle *out)
{
    (void)iface; (void)syncOnDemand;
    return xgr_return_hr(create_provider_internal(user, configId, true, out));
}

static HRESULT WINAPI xgs_XGameSaveInitializeProviderAsync(void *iface, XUserHandle user, const char *configId, BOOLEAN syncOnDemand, XAsyncBlock *async)
{
    (void)iface; (void)syncOnDemand;
    if (!async) return E_INVALIDARG;
    struct gs_init_async *ctx = (struct gs_init_async *)calloc(1, sizeof(*ctx));
    if (!ctx) return E_OUTOFMEMORY;
    if (user) xgr_user_duplicate(user, &ctx->user);
    if (configId) snprintf(ctx->scid, sizeof(ctx->scid), "%s", configId);
    HRESULT hr = xgr_async_begin(async, ctx, (const void *)xgs_XGameSaveInitializeProviderAsync, "XGameSaveInitializeProviderAsync", gs_init_provider);
    if (FAILED(hr)) {
        if (ctx->user) xgr_user_close(ctx->user);
        free(ctx);
    }
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveInitializeProviderResult(void *iface, XAsyncBlock *async, XGameSaveProviderHandle *out)
{
    (void)iface;
    if (!out) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xgs_XGameSaveInitializeProviderAsync, sizeof(*out), out, NULL));
}

static void WINAPI xgs_XGameSaveCloseProvider(void *iface, XGameSaveProviderHandle prov)
{
    (void)iface;
    if (!prov) return;
    if (gs_reg_remove(&g_live_providers, prov)) {
        if (InterlockedCompareExchange(&prov->api_closed, 1, 0) == 0) {
            provider_release(prov);
        }
    }
}

static HRESULT WINAPI xgs_XGameSaveGetRemainingQuota(void *iface, XGameSaveProviderHandle prov, int64_t *rem)
{
    (void)iface;
    if (!rem || !acquire_live_provider(prov)) return xgr_return_hr(E_INVALIDARG);
    *rem = compute_remaining_quota(prov);
    provider_release(prov);
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xgs_XGameSaveGetRemainingQuotaAsync(void *iface, XGameSaveProviderHandle prov, XAsyncBlock *async)
{
    (void)iface;
    if (!async || !acquire_live_provider(prov)) return xgr_return_hr(E_INVALIDARG);
    struct gs_quota_async *ctx = (struct gs_quota_async *)calloc(1, sizeof(*ctx));
    if (!ctx) {
        provider_release(prov);
        return xgr_return_hr(E_OUTOFMEMORY);
    }
    ctx->provider = prov;
    HRESULT hr = xgr_async_begin(async, ctx, (const void *)xgs_XGameSaveGetRemainingQuotaAsync, "XGameSaveGetRemainingQuotaAsync", gs_quota_provider);
    if (FAILED(hr)) {
        provider_release(prov);
        free(ctx);
    }
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveGetRemainingQuotaResult(void *iface, XAsyncBlock *async, int64_t *rem)
{
    (void)iface;
    if (!rem) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xgs_XGameSaveGetRemainingQuotaAsync, sizeof(*rem), rem, NULL));
}

static HRESULT WINAPI xgs_XGameSaveDeleteContainer(void *iface, XGameSaveProviderHandle prov, const char *cname)
{
    (void)iface;
    if (!cname || !acquire_live_provider(prov)) return xgr_return_hr(E_INVALIDARG);
    HRESULT hr = delete_container_sync(prov, cname);
    provider_release(prov);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveDeleteContainerAsync(void *iface, XGameSaveProviderHandle prov, const char *cname, XAsyncBlock *async)
{
    (void)iface;
    if (!cname || !async) return xgr_return_hr(E_INVALIDARG);
    if (!acquire_live_provider(prov)) return xgr_return_hr(E_INVALIDARG);
    if (!is_valid_container_name(cname)) {
        provider_release(prov);
        return xgr_return_hr(E_GS_INVALID_CONTAINER_NAME);
    }
    struct gs_del_async *ctx = (struct gs_del_async *)calloc(1, sizeof(*ctx));
    if (!ctx) {
        provider_release(prov);
        return xgr_return_hr(E_OUTOFMEMORY);
    }
    ctx->provider = prov;
    snprintf(ctx->cname, sizeof(ctx->cname), "%s", cname);
    HRESULT hr = xgr_async_begin(async, ctx, (const void *)xgs_XGameSaveDeleteContainerAsync, "XGameSaveDeleteContainerAsync", gs_del_provider);
    if (FAILED(hr)) {
        provider_release(prov);
        free(ctx);
    }
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveDeleteContainerResult(void *iface, XAsyncBlock *async)
{
    (void)iface;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xgs_XGameSaveDeleteContainerAsync, 0, NULL, NULL));
}

static HRESULT enumerate_containers_internal(XGameSaveProviderHandle prov, const char *exact_or_prefix, bool exact, void *context, XGameSaveContainerInfoCallback *cb)
{
    if (!prov || !cb) return E_INVALIDARG;
    EnterCriticalSection(&prov->cs);
    struct wgs_index_state idx;
    load_wgs_index(prov->wgs_user_dir, &idx);

    size_t pfx_len = exact_or_prefix ? strlen(exact_or_prefix) : 0;

    for (uint32_t i = 0; idx.items != NULL && i < idx.count; i++) {
        struct wgs_container_entry *ce = &idx.items[i];
        if (exact) {
            if (!exact_or_prefix || strcmp(ce->name, exact_or_prefix) != 0) continue;
        } else if (exact_or_prefix && pfx_len > 0) {
            if (strncmp(ce->name, exact_or_prefix, pfx_len) != 0) continue;
        }

        struct wgs_blob_entry *blobs = NULL;
        uint32_t bcnt = 0;
        load_container_blobs(prov->wgs_user_dir, ce, &blobs, &bcnt);
        free(blobs);

        XGameSaveContainerInfo info;
        memset(&info, 0, sizeof(info));
        info.name = ce->name;
        info.displayName = ce->display_name[0] ? ce->display_name : ce->name;
        info.blobCount = bcnt;
        info.totalSize = ce->total_size;
        info.lastModifiedTime = filetime_to_unix_sec(ce->modified_ft);
        info.needsSync = false;

        bool cont = cb(&info, context);
        if (!cont || exact) break;
    }

    free_wgs_index(&idx);
    LeaveCriticalSection(&prov->cs);
    return S_OK;
}

static HRESULT WINAPI xgs_XGameSaveGetContainerInfo(void *iface, XGameSaveProviderHandle prov, const char *cname, void *ctx, XGameSaveContainerInfoCallback *cb)
{
    (void)iface;
    if (!cb) return xgr_return_hr(E_INVALIDARG);
    if (!cname || !is_valid_container_name(cname)) return xgr_return_hr(E_GS_INVALID_CONTAINER_NAME);
    if (!acquire_live_provider(prov)) return xgr_return_hr(E_INVALIDARG);
    HRESULT hr = enumerate_containers_internal(prov, cname, true, ctx, cb);
    provider_release(prov);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveEnumerateContainerInfo(void *iface, XGameSaveProviderHandle prov, void *ctx, XGameSaveContainerInfoCallback *cb)
{
    (void)iface;
    if (!cb || !acquire_live_provider(prov)) return xgr_return_hr(E_INVALIDARG);
    HRESULT hr = enumerate_containers_internal(prov, NULL, false, ctx, cb);
    provider_release(prov);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveEnumerateContainerInfoByName(void *iface, XGameSaveProviderHandle prov, const char *prefix, void *ctx, XGameSaveContainerInfoCallback *cb)
{
    (void)iface;
    if (!cb || !acquire_live_provider(prov)) return xgr_return_hr(E_INVALIDARG);
    HRESULT hr = enumerate_containers_internal(prov, prefix, false, ctx, cb);
    provider_release(prov);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveCreateContainer(void *iface, XGameSaveProviderHandle prov, const char *cname, XGameSaveContainerHandle *out)
{
    (void)iface;
    if (!cname || !out) return xgr_return_hr(E_INVALIDARG);
    *out = NULL;
    if (!acquire_live_provider(prov)) return xgr_return_hr(E_INVALIDARG);
    if (!is_valid_container_name(cname)) {
        provider_release(prov);
        return xgr_return_hr(E_GS_INVALID_CONTAINER_NAME);
    }
    XGameSaveContainerHandle c = (XGameSaveContainerHandle)calloc(1, sizeof(*c));
    if (!c) {
        provider_release(prov);
        return xgr_return_hr(E_OUTOFMEMORY);
    }
    c->ref = 1;
    c->api_closed = 0;
    c->provider = prov; /* Transfers acquired prov ref */
    snprintf(c->name, sizeof(c->name), "%s", cname);
    if (!gs_reg_insert(&g_live_containers, c)) {
        container_release(c);
        return xgr_return_hr(E_OUTOFMEMORY);
    }
    *out = c;
    return xgr_return_hr(S_OK);
}

static void WINAPI xgs_XGameSaveCloseContainer(void *iface, XGameSaveContainerHandle cont)
{
    (void)iface;
    if (!cont) return;
    if (gs_reg_remove(&g_live_containers, cont)) {
        if (InterlockedCompareExchange(&cont->api_closed, 1, 0) == 0) {
            container_release(cont);
        }
    }
}

static HRESULT enumerate_blobs_internal(XGameSaveContainerHandle cont, const char *prefix, void *ctx, XGameSaveBlobInfoCallback *cb)
{
    if (!cont || !cont->provider || !cb) return E_INVALIDARG;
    XGameSaveProviderHandle prov = cont->provider;
    EnterCriticalSection(&prov->cs);

    struct wgs_index_state idx;
    load_wgs_index(prov->wgs_user_dir, &idx);
    struct wgs_container_entry *ce = NULL;
    for (uint32_t i = 0; idx.items != NULL && i < idx.count; i++) {
        if (strcmp(idx.items[i].name, cont->name) == 0) {
            ce = &idx.items[i];
            break;
        }
    }

    if (ce) {
        struct wgs_blob_entry *blobs = NULL;
        uint32_t bcnt = 0;
        load_container_blobs(prov->wgs_user_dir, ce, &blobs, &bcnt);
        size_t plen = prefix ? strlen(prefix) : 0;
        for (uint32_t b = 0; b < bcnt; b++) {
            if (prefix && plen > 0 && strncmp(blobs[b].name, prefix, plen) != 0) continue;
            XGameSaveBlobInfo bi;
            bi.name = blobs[b].name;
            bi.size = blobs[b].size;
            if (!cb(&bi, ctx)) break;
        }
        free(blobs);
    }

    free_wgs_index(&idx);
    LeaveCriticalSection(&prov->cs);
    return S_OK;
}

static HRESULT WINAPI xgs_XGameSaveEnumerateBlobInfo(void *iface, XGameSaveContainerHandle cont, void *ctx, XGameSaveBlobInfoCallback *cb)
{
    (void)iface;
    if (!cb || !acquire_live_container(cont)) return xgr_return_hr(E_INVALIDARG);
    HRESULT hr = enumerate_blobs_internal(cont, NULL, ctx, cb);
    container_release(cont);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveEnumerateBlobInfoByName(void *iface, XGameSaveContainerHandle cont, const char *prefix, void *ctx, XGameSaveBlobInfoCallback *cb)
{
    (void)iface;
    if (!cb || !acquire_live_container(cont)) return xgr_return_hr(E_INVALIDARG);
    HRESULT hr = enumerate_blobs_internal(cont, prefix, ctx, cb);
    container_release(cont);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveReadBlobData(void *iface, XGameSaveContainerHandle cont, const char **blobNames, uint32_t *countOfBlobs, SIZE_T blobsSize, XGameSaveBlob *blobData)
{
    (void)iface;
    if (!countOfBlobs || (!blobData && blobsSize > 0)) return xgr_return_hr(E_INVALIDARG);
    if (!acquire_live_container(cont)) return xgr_return_hr(E_INVALIDARG);
    struct prepared_blob_read prep;
    HRESULT hr = prepare_blob_read(cont, blobNames, blobNames ? *countOfBlobs : 0, &prep);
    if (SUCCEEDED(hr)) {
        if (blobsSize < prep.total_size) {
            hr = E_GS_PROVIDED_BUFFER_TOO_SMALL;
        } else if (!blobData && prep.total_size > 0) {
            hr = E_INVALIDARG;
        } else {
            if (prep.total_size > 0) copy_relocated_blob_read(&prep, blobData);
            *countOfBlobs = prep.count;
        }
    }
    free(prep.packed);
    container_release(cont);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveReadBlobDataAsync(void *iface, XGameSaveContainerHandle cont, const char **blobNames, uint32_t countOfBlobs, XAsyncBlock *async)
{
    (void)iface;
    if (!async || !acquire_live_container(cont)) return xgr_return_hr(E_INVALIDARG);
    struct gs_read_async *ctx = (struct gs_read_async *)calloc(1, sizeof(*ctx));
    if (!ctx) {
        container_release(cont);
        return xgr_return_hr(E_OUTOFMEMORY);
    }
    ctx->container = cont; /* Transfers acquired cont ref */

    if (blobNames && countOfBlobs > 0) {
        ctx->req_names = (char **)calloc(countOfBlobs, sizeof(char *));
        if (!ctx->req_names) {
            container_release(cont);
            free(ctx);
            return xgr_return_hr(E_OUTOFMEMORY);
        }
        ctx->req_count = countOfBlobs;
        for (uint32_t i = 0; i < countOfBlobs; i++) {
            size_t n = blobNames[i] ? strlen(blobNames[i]) + 1 : 1;
            ctx->req_names[i] = (char *)calloc(1, n);
            if (ctx->req_names[i] && blobNames[i]) memcpy(ctx->req_names[i], blobNames[i], n);
        }
    }

    HRESULT hr = xgr_async_begin(async, ctx, (const void *)xgs_XGameSaveReadBlobDataAsync, "XGameSaveReadBlobDataAsync", gs_read_provider);
    if (FAILED(hr)) {
        for (uint32_t i = 0; i < ctx->req_count; i++) free(ctx->req_names[i]);
        free(ctx->req_names);
        container_release(cont);
        free(ctx);
    }
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveReadBlobDataResult(void *iface, XAsyncBlock *async, SIZE_T blobsSize, XGameSaveBlob *blobData, uint32_t *countOfBlobs)
{
    (void)iface;
    if (!async || !countOfBlobs) return E_INVALIDARG;
    *countOfBlobs = 0;
    void *ctx_ptr = NULL;
    void *st_ref = xgr_async_try_acquire_state(async, &ctx_ptr);
    if (st_ref) {
        if (ctx_ptr) {
            ((struct gs_read_async *)ctx_ptr)->out_count_ptr = countOfBlobs;
        }
        xgr_async_release_state(st_ref);
    }
    HRESULT hr = xgr_async_get_result(async, (const void *)xgs_XGameSaveReadBlobDataAsync, blobsSize, blobData, NULL);
    if (hr == HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER)) {
        hr = E_GS_PROVIDED_BUFFER_TOO_SMALL;
    }
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveCreateUpdate(void *iface, XGameSaveContainerHandle cont, const char *displayName, XGameSaveUpdateHandle *out)
{
    (void)iface;
    if (!out) return xgr_return_hr(E_INVALIDARG);
    *out = NULL;
    if (!acquire_live_container(cont)) return xgr_return_hr(E_INVALIDARG);
    XGameSaveUpdateHandle u = (XGameSaveUpdateHandle)calloc(1, sizeof(*u));
    if (!u) {
        container_release(cont);
        return xgr_return_hr(E_OUTOFMEMORY);
    }
    u->ref = 1;
    u->api_closed = 0;
    u->container = cont; /* Transfers acquired cont ref */
    if (displayName) {
        size_t n = strlen(displayName) + 1;
        u->display_name = (char *)malloc(n);
        if (u->display_name) memcpy(u->display_name, displayName, n);
    }
    if (!gs_reg_insert(&g_live_updates, u)) {
        update_release(u);
        return xgr_return_hr(E_OUTOFMEMORY);
    }
    *out = u;
    return xgr_return_hr(S_OK);
}

static void WINAPI xgs_XGameSaveCloseUpdate(void *iface, XGameSaveUpdateHandle upd)
{
    (void)iface;
    if (!upd) return;
    if (gs_reg_remove(&g_live_updates, upd)) {
        if (InterlockedCompareExchange(&upd->api_closed, 1, 0) == 0) {
            update_release(upd);
        }
    }
}

static HRESULT append_update_op(XGameSaveUpdateHandle upd, const char *bname, const uint8_t *data, size_t len, bool remove)
{
    if (!upd || !bname || !bname[0]) return E_INVALIDARG;
    if (!remove && len > 0 && !data) return E_INVALIDARG;
    if (upd->submitted) return E_GS_HANDLE_EXPIRED;
    for (uint32_t i = 0; i < upd->count; i++) {
        if (strcmp(upd->ops[i].name, bname) == 0) return E_INVALIDARG;
    }
    if (upd->count == upd->cap) {
        uint32_t ncap = upd->cap ? upd->cap * 2 : 8;
        struct update_op *nops = (struct update_op *)realloc(upd->ops, ncap * sizeof(*nops));
        if (!nops) return E_OUTOFMEMORY;
        upd->ops = nops;
        upd->cap = ncap;
    }
    struct update_op *op = &upd->ops[upd->count];
    memset(op, 0, sizeof(*op));
    size_t nlen = strlen(bname) + 1;
    op->name = (char *)malloc(nlen);
    if (!op->name) return E_OUTOFMEMORY;
    memcpy(op->name, bname, nlen);
    op->remove = remove;
    if (!remove) {
        op->data = (uint8_t *)malloc(len ? len : 1);
        if (!op->data) {
            free(op->name);
            return E_OUTOFMEMORY;
        }
        if (len > 0) memcpy(op->data, data, len);
        op->size = len;
    }
    upd->count++;
    return S_OK;
}

static HRESULT WINAPI xgs_XGameSaveSubmitBlobWrite(void *iface, XGameSaveUpdateHandle upd, const char *bname, uint8_t *data, SIZE_T byteCount)
{
    (void)iface;
    if (!data && byteCount > 0) return xgr_return_hr(E_INVALIDARG);
    if (!acquire_live_update(upd)) return xgr_return_hr(E_INVALIDARG);
    HRESULT hr = append_update_op(upd, bname, data, byteCount, false);
    update_release(upd);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveSubmitBlobDelete(void *iface, XGameSaveUpdateHandle upd, const char *bname)
{
    (void)iface;
    if (!acquire_live_update(upd)) return xgr_return_hr(E_INVALIDARG);
    HRESULT hr = append_update_op(upd, bname, NULL, 0, true);
    update_release(upd);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveSubmitUpdate(void *iface, XGameSaveUpdateHandle upd)
{
    (void)iface;
    if (!acquire_live_update(upd)) return xgr_return_hr(E_INVALIDARG);
    HRESULT hr = submit_update_sync(upd);
    update_release(upd);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveSubmitUpdateAsync(void *iface, XGameSaveUpdateHandle upd, XAsyncBlock *async)
{
    (void)iface;
    if (!async || !acquire_live_update(upd)) return xgr_return_hr(E_INVALIDARG);
    struct gs_submit_async *ctx = (struct gs_submit_async *)calloc(1, sizeof(*ctx));
    if (!ctx) {
        update_release(upd);
        return xgr_return_hr(E_OUTOFMEMORY);
    }
    ctx->update = upd; /* Transfers acquired upd ref */
    HRESULT hr = xgr_async_begin(async, ctx, (const void *)xgs_XGameSaveSubmitUpdateAsync, "XGameSaveSubmitUpdateAsync", gs_submit_provider);
    if (FAILED(hr)) {
        update_release(upd);
        free(ctx);
    }
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveSubmitUpdateResult(void *iface, XAsyncBlock *async)
{
    (void)iface;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xgs_XGameSaveSubmitUpdateAsync, 0, NULL, NULL));
}

/* IXGameSaveImpl2 / Impl3: XGameSaveFiles* */
static HRESULT WINAPI xgs_XGameSaveFilesGetFolderWithUiAsync(void *iface, XUserHandle user, const char *configId, XAsyncBlock *async)
{
    (void)iface;
    if (!async) return E_INVALIDARG;
    struct gs_folder_async *ctx = (struct gs_folder_async *)calloc(1, sizeof(*ctx));
    if (!ctx) return E_OUTOFMEMORY;
    if (user) xgr_user_duplicate(user, &ctx->user);
    if (configId) snprintf(ctx->scid, sizeof(ctx->scid), "%s", configId);
    HRESULT hr = xgr_async_begin(async, ctx, (const void *)xgs_XGameSaveFilesGetFolderWithUiAsync, "XGameSaveFilesGetFolderWithUiAsync", gs_folder_provider);
    if (FAILED(hr)) {
        if (ctx->user) xgr_user_close(ctx->user);
        free(ctx);
    }
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveFilesGetFolderWithUiResult(void *iface, XAsyncBlock *async, SIZE_T folderSize, char *folderResult)
{
    (void)iface;
    if (!folderResult) return E_INVALIDARG;
    HRESULT hr = xgr_async_get_result(async, (const void *)xgs_XGameSaveFilesGetFolderWithUiAsync, folderSize, folderResult, NULL);
    if (hr == HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER)) {
        hr = E_GS_PROVIDED_BUFFER_TOO_SMALL;
    }
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xgs_XGameSaveFilesGetRemainingQuota(void *iface, XUserHandle user, const char *configId, int64_t *rem)
{
    (void)iface; (void)user; (void)configId;
    if (!rem) return E_INVALIDARG;
    *rem = XGR_SAVE_QUOTA_DEFAULT;
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xgs_unknown_ext(void *iface) { (void)iface; return xgr_return_hr(E_NOTIMPL); }

static const void *const g_xgamesave4_vtbl[50] = {
    (const void *)xgs_QueryInterface,                               /* 0 */
    (const void *)xgs_AddRef,                                       /* 1 */
    (const void *)xgs_Release,                                      /* 2 */
    (const void *)xgs_XGameSaveInitializeProvider,                  /* 3 */
    (const void *)xgs_XGameSaveInitializeProviderAsync,             /* 4 */
    (const void *)xgs_XGameSaveInitializeProviderResult,            /* 5 */
    (const void *)xgs_XGameSaveCloseProvider,                       /* 6 */
    (const void *)xgs_XGameSaveGetRemainingQuota,                   /* 7 */
    (const void *)xgs_XGameSaveGetRemainingQuotaAsync,              /* 8 */
    (const void *)xgs_XGameSaveGetRemainingQuotaResult,             /* 9 */
    (const void *)xgs_XGameSaveDeleteContainer,                     /* 10 */
    (const void *)xgs_XGameSaveDeleteContainerAsync,                /* 11 */
    (const void *)xgs_XGameSaveDeleteContainerResult,               /* 12 */
    (const void *)xgs_XGameSaveGetContainerInfo,                    /* 13 */
    (const void *)xgs_XGameSaveEnumerateContainerInfo,              /* 14 */
    (const void *)xgs_XGameSaveEnumerateContainerInfoByName,        /* 15 */
    (const void *)xgs_XGameSaveCreateContainer,                     /* 16 */
    (const void *)xgs_XGameSaveCloseContainer,                      /* 17 */
    (const void *)xgs_XGameSaveEnumerateBlobInfo,                   /* 18 */
    (const void *)xgs_XGameSaveEnumerateBlobInfoByName,             /* 19 */
    (const void *)xgs_XGameSaveReadBlobData,                        /* 20 */
    (const void *)xgs_XGameSaveReadBlobDataAsync,                   /* 21 */
    (const void *)xgs_XGameSaveReadBlobDataResult,                  /* 22 */
    (const void *)xgs_XGameSaveCreateUpdate,                        /* 23 */
    (const void *)xgs_XGameSaveCloseUpdate,                         /* 24 */
    (const void *)xgs_XGameSaveSubmitBlobWrite,                     /* 25 */
    (const void *)xgs_XGameSaveSubmitBlobDelete,                    /* 26 */
    (const void *)xgs_XGameSaveSubmitUpdate,                        /* 27 */
    (const void *)xgs_XGameSaveSubmitUpdateAsync,                   /* 28 */
    (const void *)xgs_XGameSaveSubmitUpdateResult,                  /* 29 */
    /* IXGameSaveImpl2 / Impl3 */
    (const void *)xgs_XGameSaveFilesGetFolderWithUiAsync,           /* 30 */
    (const void *)xgs_XGameSaveFilesGetFolderWithUiResult,          /* 31 */
    (const void *)xgs_XGameSaveFilesGetRemainingQuota,              /* 32 */
    /* IXGameSaveImpl4 trailing safety slots */
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext,
    (const void *)xgs_unknown_ext
};

static struct { const void *lpVtbl; } g_xgamesave_singleton = { g_xgamesave4_vtbl };

HRESULT xgr_query_gamesave(REFIID iid, void **ppv)
{
    return xgs_QueryInterface(&g_xgamesave_singleton, iid, ppv);
}
