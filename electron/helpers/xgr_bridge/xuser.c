/*
 * One Launcher XGR Bridge — IXUserImpl6, IXUserGamertagImpl & IXUserDeviceImpl2
 * Non-blocking worker-thread loopback RPC for XUserAddAsync & XUserGetTokenAndSignature[Utf16]Async.
 */

#include "xgr_internal.h"

struct XUser {
    volatile LONG ref;
    uint64_t xuid;
    uint64_t local_id;
    XUserAgeGroup age_group;
    char gamertag[16];                /* XUserGamertagComponentClassicMaxBytes == 16 */
    char modern_gamertag[97];         /* XUserGamertagComponentModernMaxBytes == 97 */
    char modern_suffix[15];           /* XUserGamertagComponentModernSuffixMaxBytes == 15 */
    char unique_modern_gamertag[101]; /* XUserGamertagComponentUniqueModernMaxBytes == 101 */
};

struct user_change_reg {
    struct user_change_reg *next;
    uint64_t token;
    XTaskQueueHandle queue;
    void *context;
    XUserChangeEventCallback *callback;
};

static SRWLOCK g_user_lock = SRWLOCK_INIT;
static XUserHandle g_active_user = NULL;
static struct user_change_reg *g_change_regs = NULL;
static uint64_t g_next_change_token = 1;

uint64_t xgr_user_get_xuid(XUserHandle user)
{
    if (user && user->xuid) return user->xuid;
    AcquireSRWLockShared(&g_user_lock);
    uint64_t id = g_active_user ? g_active_user->xuid : 2533274790395904ULL;
    ReleaseSRWLockShared(&g_user_lock);
    return id;
}

HRESULT xgr_user_duplicate(XUserHandle user, XUserHandle *out_user)
{
    if (!user || !out_user) return E_INVALIDARG;
    InterlockedIncrement(&user->ref);
    *out_user = user;
    return S_OK;
}

void xgr_user_close(XUserHandle user)
{
    if (!user) return;
    if (InterlockedDecrement(&user->ref) == 0) {
        free(user);
    }
}

void xgr_user_shutdown(void)
{
    struct user_change_reg *regs = NULL;
    XUserHandle active = NULL;

    AcquireSRWLockExclusive(&g_user_lock);
    regs = g_change_regs;
    g_change_regs = NULL;
    active = g_active_user;
    g_active_user = NULL;
    ReleaseSRWLockExclusive(&g_user_lock);

    while (regs) {
        struct user_change_reg *next = regs->next;
        if (regs->queue) xgr_task_queue_close(regs->queue);
        free(regs);
        regs = next;
    }
    if (active) {
        xgr_user_close(active);
    }
}

static HRESULT ensure_signed_in_user_worker(XUserHandle *out_user)
{
    AcquireSRWLockShared(&g_user_lock);
    if (g_active_user) {
        InterlockedIncrement(&g_active_user->ref);
        *out_user = g_active_user;
        ReleaseSRWLockShared(&g_user_lock);
        return S_OK;
    }
    ReleaseSRWLockShared(&g_user_lock);

    struct xgr_runtime_config_snapshot cfg;
    xgr_copy_runtime_config_snapshot(&cfg);

    XUserHandle u = (XUserHandle)calloc(1, sizeof(*u));
    if (!u) return E_OUTOFMEMORY;
    u->ref = 1;
    u->local_id = 1;
    u->xuid = 2533274790395904ULL;
    u->age_group = XUserAgeGroup_Adult;
    strcpy(u->gamertag, "PlayerOne");
    strcpy(u->modern_gamertag, "PlayerOne");
    strcpy(u->unique_modern_gamertag, "PlayerOne");

    if (xgr_rpc_is_configured()) {
        XgrStrBuf sb;
        xgr_sb_init(&sb);
        xgr_sb_append_cstr(&sb, "{\"titleId\":");
        xgr_sb_append_json_str(&sb, cfg.titleIdHex);
        xgr_sb_append_cstr(&sb, ",\"scid\":");
        xgr_sb_append_json_str(&sb, cfg.scid);
        xgr_sb_append_cstr(&sb, ",\"msaAppId\":");
        xgr_sb_append_json_str(&sb, cfg.msaAppId);
        xgr_sb_append_cstr(&sb, ",\"storeId\":");
        xgr_sb_append_json_str(&sb, cfg.storeId);
        xgr_sb_append_cstr(&sb, ",\"packageFamilyName\":");
        xgr_sb_append_json_str(&sb, cfg.packageFamilyName);
        xgr_sb_append_fmt(&sb, ",\"fullTrust\":%s}", cfg.fullTrust ? "true" : "false");
        char *params = xgr_sb_detach(&sb);
        if (!params) {
            free(u);
            return E_OUTOFMEMORY;
        }

        char *res_json = NULL;
        HRESULT hr = xgr_rpc_call("session.init", params, &res_json);
        free(params);
        if (FAILED(hr)) {
            free(u);
            return hr;
        }
        if (res_json) {
            uint64_t xuid = 0;
            int64_t age = 3;
            if (xgr_json_get_uint64(res_json, "xuid", &xuid) && xuid != 0) u->xuid = xuid;
            if (xgr_json_get_int64(res_json, "ageGroup", &age) && age > 0) u->age_group = (XUserAgeGroup)age;
            xgr_json_get_string(res_json, "gamertag", u->gamertag, sizeof(u->gamertag));
            xgr_json_get_string(res_json, "modernGamertag", u->modern_gamertag, sizeof(u->modern_gamertag));
            xgr_json_get_string(res_json, "modernGamertagSuffix", u->modern_suffix, sizeof(u->modern_suffix));
            xgr_json_get_string(res_json, "uniqueModernGamertag", u->unique_modern_gamertag, sizeof(u->unique_modern_gamertag));
            if (!u->gamertag[0]) strcpy(u->gamertag, "PlayerOne");
            if (!u->modern_gamertag[0]) snprintf(u->modern_gamertag, sizeof(u->modern_gamertag), "%s", u->gamertag);
            if (!u->unique_modern_gamertag[0]) snprintf(u->unique_modern_gamertag, sizeof(u->unique_modern_gamertag), "%s", u->modern_gamertag);
            free(res_json);
        }
    }

    AcquireSRWLockExclusive(&g_user_lock);
    if (!g_active_user) {
        InterlockedIncrement(&u->ref);
        g_active_user = u;
        *out_user = u;
    } else {
        InterlockedIncrement(&g_active_user->ref);
        *out_user = g_active_user;
        xgr_user_close(u);
    }
    ReleaseSRWLockExclusive(&g_user_lock);
    return S_OK;
}

/* XUserAddAsync Provider */
struct user_add_ctx {
    uint32_t options;
    XUserHandle result_user;
};

static HRESULT CALLBACK user_add_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct user_add_ctx *ctx = (struct user_add_ctx *)data->context;
    switch (op) {
        case XAsyncOp_Begin:
            return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            HRESULT hr = ensure_signed_in_user_worker(&ctx->result_user);
            xgr_async_complete(data->async, hr, SUCCEEDED(hr) ? sizeof(XUserHandle) : 0);
            return S_OK;
        }
        case XAsyncOp_GetResult:
            if (!data->buffer || data->bufferSize < sizeof(XUserHandle)) return E_INVALIDARG;
            memcpy(data->buffer, &ctx->result_user, sizeof(XUserHandle));
            ctx->result_user = NULL; /* Ownership transferred to caller */
            return S_OK;
        case XAsyncOp_Cleanup:
            if (ctx->result_user) xgr_user_close(ctx->result_user);
            free(ctx);
            return S_OK;
        case XAsyncOp_Cancel:
            return S_OK;
    }
    return S_OK;
}

/* XUserGetGamerPictureAsync Provider */
struct gamerpic_ctx {
    XUserGamerPictureSize pic_size;
    uint8_t *png_bytes;
    size_t png_len;
};

static const uint8_t k_fallback_png[67] = {
    0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,
    0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1F,0x15,0xC4,
    0x89,0x00,0x00,0x00,0x0D,0x49,0x44,0x41,0x54,0x78,0x9C,0x63,0xF8,0xCF,0x50,0x0F,
    0x00,0x03,0x86,0x01,0x80,0x5A,0x34,0x7D,0x6B,0x00,0x00,0x00,0x00,0x49,0x45,0x4E,
    0x44,0xAE,0x42
};

static HRESULT CALLBACK gamerpic_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct gamerpic_ctx *ctx = (struct gamerpic_ctx *)data->context;
    switch (op) {
        case XAsyncOp_Begin:
            return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            if (xgr_rpc_is_configured()) {
                char params[64];
                snprintf(params, sizeof(params), "{\"size\":%d}", (int)ctx->pic_size);
                char *res_json = NULL;
                if (SUCCEEDED(xgr_rpc_call("xuser.getGamerPicture", params, &res_json)) && res_json) {
                    char *b64 = xgr_json_alloc_string(res_json, "pngBase64");
                    if (b64) {
                        ctx->png_bytes = xgr_base64_decode_alloc(b64, &ctx->png_len);
                        free(b64);
                    }
                    free(res_json);
                }
            }
            if (!ctx->png_bytes || ctx->png_len == 0) {
                free(ctx->png_bytes);
                ctx->png_len = sizeof(k_fallback_png);
                ctx->png_bytes = (uint8_t *)malloc(ctx->png_len);
                if (!ctx->png_bytes) {
                    xgr_async_complete(data->async, E_OUTOFMEMORY, 0);
                    return S_OK;
                }
                memcpy(ctx->png_bytes, k_fallback_png, ctx->png_len);
            }
            xgr_async_complete(data->async, S_OK, ctx->png_len);
            return S_OK;
        }
        case XAsyncOp_GetResult:
            if (!data->buffer || data->bufferSize < ctx->png_len) return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
            memcpy(data->buffer, ctx->png_bytes, ctx->png_len);
            return S_OK;
        case XAsyncOp_Cleanup:
            free(ctx->png_bytes);
            free(ctx);
            return S_OK;
        case XAsyncOp_Cancel:
            return S_OK;
    }
    return S_OK;
}

/* XUserGetTokenAndSignature[Utf16]Async Provider */
struct token_sig_ctx {
    XUserHandle user;
    uint32_t options;
    bool is_utf16;
    char *method;
    char *url;
    char *headers_json;
    uint8_t *body;
    size_t body_len;
    void *packed_buf;
    size_t packed_size;
};

static HRESULT CALLBACK token_sig_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct token_sig_ctx *ctx = (struct token_sig_ctx *)data->context;
    switch (op) {
        case XAsyncOp_Begin:
            return xgr_async_schedule_background(data->async);
        case XAsyncOp_DoWork: {
            char *token_utf8 = NULL;
            char *sig_utf8 = NULL;
            HRESULT hr = S_OK;

            if (xgr_rpc_is_configured()) {
                char *body_b64 = (ctx->body && ctx->body_len > 0)
                    ? xgr_base64_encode_alloc(ctx->body, ctx->body_len)
                    : strdup("");
                const char *hdr_obj = (ctx->headers_json && *ctx->headers_json) ? ctx->headers_json : "{}";
                bool force_refresh = (ctx->options & 0x01) != 0;

                if (!body_b64) {
                    hr = E_OUTOFMEMORY;
                } else {
                    XgrStrBuf sb;
                    xgr_sb_init(&sb);
                    xgr_sb_append_cstr(&sb, "{\"method\":");
                    xgr_sb_append_json_str(&sb, ctx->method ? ctx->method : "GET");
                    xgr_sb_append_cstr(&sb, ",\"url\":");
                    xgr_sb_append_json_str(&sb, ctx->url ? ctx->url : "");
                    xgr_sb_append_cstr(&sb, ",\"headers\":");
                    xgr_sb_append_cstr(&sb, hdr_obj);
                    xgr_sb_append_cstr(&sb, ",\"bodyBase64\":");
                    xgr_sb_append_json_str(&sb, body_b64);
                    xgr_sb_append_fmt(&sb, ",\"options\":%u,\"forceRefresh\":%s}", ctx->options, force_refresh ? "true" : "false");

                    char *params = xgr_sb_detach(&sb);
                    if (!params) {
                        hr = E_OUTOFMEMORY;
                    } else {
                        char *res_json = NULL;
                        hr = xgr_rpc_call("xuser.getTokenAndSignature", params, &res_json);
                        if (SUCCEEDED(hr) && res_json) {
                            token_utf8 = xgr_json_alloc_string(res_json, "token");
                            sig_utf8 = xgr_json_alloc_string(res_json, "signature");
                            free(res_json);
                        }
                        free(params);
                    }
                }
                free(body_b64);
            } else {
                char fallback_tok[128];
                snprintf(fallback_tok, sizeof(fallback_tok), "XBL3.0 x=%llu;offline_token",
                         (unsigned long long)xgr_user_get_xuid(ctx->user));
                token_utf8 = strdup(fallback_tok);
                sig_utf8 = strdup("");
            }

            if (FAILED(hr)) {
                free(token_utf8);
                free(sig_utf8);
                xgr_async_complete(data->async, hr, 0);
                return S_OK;
            }

            if (!token_utf8) token_utf8 = strdup("");
            if (!sig_utf8) sig_utf8 = strdup("");

            if (ctx->is_utf16) {
                int tok_wchars = MultiByteToWideChar(CP_UTF8, 0, token_utf8, -1, NULL, 0);
                if (tok_wchars <= 0) tok_wchars = 1;
                int sig_wchars = sig_utf8[0] ? MultiByteToWideChar(CP_UTF8, 0, sig_utf8, -1, NULL, 0) : 0;
                if (sig_wchars < 0) sig_wchars = 0;
                ctx->packed_size = sizeof(XUserGetTokenAndSignatureUtf16Data) +
                                   (size_t)tok_wchars * sizeof(wchar_t) +
                                   (sig_wchars > 0 ? (size_t)sig_wchars * sizeof(wchar_t) : 0);
                XUserGetTokenAndSignatureUtf16Data *out16 = (XUserGetTokenAndSignatureUtf16Data *)calloc(1, ctx->packed_size);
                if (!out16) {
                    hr = E_OUTOFMEMORY;
                } else {
                    wchar_t *cursor = (wchar_t *)(out16 + 1);
                    MultiByteToWideChar(CP_UTF8, 0, token_utf8, -1, cursor, tok_wchars);
                    out16->tokenCount = (size_t)tok_wchars;
                    out16->token = cursor;
                    cursor += tok_wchars;
                    if (sig_wchars > 0) {
                        MultiByteToWideChar(CP_UTF8, 0, sig_utf8, -1, cursor, sig_wchars);
                        out16->signatureCount = (size_t)sig_wchars;
                        out16->signature = cursor;
                    } else {
                        out16->signatureCount = 0;
                        out16->signature = NULL;
                    }
                    ctx->packed_buf = out16;
                }
            } else {
                size_t tok_len = strlen(token_utf8);
                size_t sig_len = strlen(sig_utf8);
                ctx->packed_size = sizeof(XUserGetTokenAndSignatureData) +
                                   (tok_len + 1) +
                                   (sig_len > 0 ? (sig_len + 1) : 0);
                XUserGetTokenAndSignatureData *out8 = (XUserGetTokenAndSignatureData *)calloc(1, ctx->packed_size);
                if (!out8) {
                    hr = E_OUTOFMEMORY;
                } else {
                    char *cursor = (char *)(out8 + 1);
                    memcpy(cursor, token_utf8, tok_len + 1);
                    out8->tokenSize = tok_len + 1;
                    out8->token = cursor;
                    cursor += tok_len + 1;
                    if (sig_len > 0) {
                        memcpy(cursor, sig_utf8, sig_len + 1);
                        out8->signatureSize = sig_len + 1;
                        out8->signature = cursor;
                    } else {
                        out8->signatureSize = 0;
                        out8->signature = NULL;
                    }
                    ctx->packed_buf = out8;
                }
            }

            free(token_utf8);
            free(sig_utf8);
            xgr_async_complete(data->async, hr, SUCCEEDED(hr) ? ctx->packed_size : 0);
            return S_OK;
        }
        case XAsyncOp_GetResult: {
            if (!data->buffer || data->bufferSize < ctx->packed_size) {
                return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
            }
            char *src_base = (char *)ctx->packed_buf;
            char *dst_base = (char *)data->buffer;
            memcpy(dst_base, src_base, ctx->packed_size);

            if (ctx->is_utf16) {
                XUserGetTokenAndSignatureUtf16Data *res = (XUserGetTokenAndSignatureUtf16Data *)dst_base;
                if (res->token) res->token = (const wchar_t *)(dst_base + ((const char *)res->token - src_base));
                if (res->signature) res->signature = (const wchar_t *)(dst_base + ((const char *)res->signature - src_base));
            } else {
                XUserGetTokenAndSignatureData *res = (XUserGetTokenAndSignatureData *)dst_base;
                if (res->token) res->token = dst_base + (res->token - src_base);
                if (res->signature) res->signature = dst_base + (res->signature - src_base);
            }
            return S_OK;
        }
        case XAsyncOp_Cleanup:
            if (ctx->user) xgr_user_close(ctx->user);
            free(ctx->method);
            free(ctx->url);
            free(ctx->headers_json);
            free(ctx->body);
            free(ctx->packed_buf);
            free(ctx);
            return S_OK;
        case XAsyncOp_Cancel:
            return S_OK;
    }
    return S_OK;
}

static char *serialize_headers_utf8_json(size_t count, const XUserGetTokenAndSignatureHttpHeader *headers)
{
    if (!count || !headers) return strdup("{}");
    XgrStrBuf sb;
    xgr_sb_init(&sb);
    xgr_sb_append_char(&sb, '{');
    bool first = true;
    for (size_t i = 0; i < count; i++) {
        if (!headers[i].name) continue;
        if (!first) xgr_sb_append_char(&sb, ',');
        xgr_sb_append_json_str(&sb, headers[i].name);
        xgr_sb_append_char(&sb, ':');
        xgr_sb_append_json_str(&sb, headers[i].value ? headers[i].value : "");
        first = false;
    }
    xgr_sb_append_char(&sb, '}');
    return xgr_sb_detach(&sb);
}

static char *wide_to_utf8_alloc(const wchar_t *w)
{
    if (!w) return strdup("");
    int len = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    if (len <= 0) return strdup("");
    char *out = (char *)malloc((size_t)len);
    if (!out) return NULL;
    WideCharToMultiByte(CP_UTF8, 0, w, -1, out, len, NULL, NULL);
    return out;
}

static HRESULT CALLBACK noop_ok_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    if (op == XAsyncOp_Begin) return xgr_async_schedule(data->async, 0);
    if (op == XAsyncOp_DoWork) xgr_async_complete(data->async, S_OK, 0);
    return S_OK;
}

/* -------------------------------------------------------------------------
 * IXUserImpl..IXUserImpl6 + IXUserGamertagImpl Dual-Vtable Object
 * ------------------------------------------------------------------------- */

struct xgr_user_impl_obj {
    const void *lpVtbl_user6;
    const void *lpVtbl_gamertag;
};

static struct xgr_user_impl_obj g_xuser_singleton;

static HRESULT WINAPI xu_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    (void)iface;
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) ||
        IsEqualGUID(riid, &IID_IXUserImpl) ||
        IsEqualGUID(riid, &IID_IXUserImpl2) ||
        IsEqualGUID(riid, &IID_IXUserImpl3) ||
        IsEqualGUID(riid, &IID_IXUserImpl4) ||
        IsEqualGUID(riid, &IID_IXUserImpl5) ||
        IsEqualGUID(riid, &IID_IXUserImpl6)) {
        *ppv = &g_xuser_singleton.lpVtbl_user6;
        return S_OK;
    }
    if (IsEqualGUID(riid, &IID_IXUserGamertagImpl)) {
        *ppv = &g_xuser_singleton.lpVtbl_gamertag;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static ULONG WINAPI xu_AddRef(void *iface) { (void)iface; return 2; }
static ULONG WINAPI xu_Release(void *iface) { (void)iface; return 1; }

static HRESULT WINAPI xu_XUserDuplicateHandle(void *iface, XUserHandle h, XUserHandle *dup)
{
    (void)iface;
    return xgr_return_hr(xgr_user_duplicate(h, dup));
}

static void WINAPI xu_XUserCloseHandle(void *iface, XUserHandle user)
{
    (void)iface;
    xgr_user_close(user);
    xgr_sync_teb_last_error();
}

static INT32 WINAPI xu_XUserCompare(void *iface, XUserHandle u1, XUserHandle u2)
{
    (void)iface;
    if (u1 == u2) return 0;
    if (!u1) return -1;
    if (!u2) return 1;
    if (u1->xuid < u2->xuid) return -1;
    if (u1->xuid > u2->xuid) return 1;
    return 0;
}

static HRESULT WINAPI xu_XUserGetMaxUsers(void *iface, UINT32 *maxUsers)
{
    (void)iface;
    if (!maxUsers) return xgr_return_hr(E_INVALIDARG);
    *maxUsers = 1;
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xu_XUserAddAsync(void *iface, XUserAddOptions options, XAsyncBlock *async)
{
    (void)iface;
    if (!async) return xgr_return_hr(E_INVALIDARG);
    struct user_add_ctx *ctx = (struct user_add_ctx *)calloc(1, sizeof(*ctx));
    if (!ctx) return xgr_return_hr(E_OUTOFMEMORY);
    ctx->options = (uint32_t)options;
    HRESULT hr = xgr_async_begin(async, ctx, (const void *)xu_XUserAddAsync, "XUserAddAsync", user_add_provider);
    if (FAILED(hr)) free(ctx);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xu_XUserAddResult(void *iface, XAsyncBlock *async, XUserHandle *newUser)
{
    (void)iface;
    if (!async || !newUser) return xgr_return_hr(E_POINTER);
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xu_XUserAddAsync, sizeof(*newUser), newUser, NULL));
}

static HRESULT WINAPI xu_XUserGetLocalId(void *iface, XUserHandle user, XUserLocalId *localId)
{
    (void)iface;
    if (!user || !localId) return xgr_return_hr(E_INVALIDARG);
    localId->value = user->local_id;
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xu_XUserFindUserByLocalId(void *iface, XUserLocalId localId, XUserHandle *handle)
{
    (void)iface;
    if (!handle) return xgr_return_hr(E_INVALIDARG);
    AcquireSRWLockShared(&g_user_lock);
    if (g_active_user && g_active_user->local_id == localId.value) {
        InterlockedIncrement(&g_active_user->ref);
        *handle = g_active_user;
        ReleaseSRWLockShared(&g_user_lock);
        return xgr_return_hr(S_OK);
    }
    ReleaseSRWLockShared(&g_user_lock);
    return xgr_return_hr(E_GAMEUSER_USER_NOT_FOUND);
}

static HRESULT WINAPI xu_XUserGetId(void *iface, XUserHandle user, UINT64 *userId)
{
    (void)iface;
    if (!user || !userId) return xgr_return_hr(E_INVALIDARG);
    *userId = user->xuid;
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xu_XUserFindUserById(void *iface, UINT64 userId, XUserHandle *handle)
{
    (void)iface;
    if (!handle) return xgr_return_hr(E_INVALIDARG);
    AcquireSRWLockShared(&g_user_lock);
    if (g_active_user && g_active_user->xuid == userId) {
        InterlockedIncrement(&g_active_user->ref);
        *handle = g_active_user;
        ReleaseSRWLockShared(&g_user_lock);
        return xgr_return_hr(S_OK);
    }
    ReleaseSRWLockShared(&g_user_lock);
    return xgr_return_hr(E_GAMEUSER_USER_NOT_FOUND);
}

static HRESULT WINAPI xu_XUserGetIsGuest(void *iface, XUserHandle user, BOOLEAN *isGuest)
{
    (void)iface;
    if (!user || !isGuest) return xgr_return_hr(E_INVALIDARG);
    *isGuest = FALSE;
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xu_XUserGetState(void *iface, XUserHandle user, XUserState *state)
{
    (void)iface;
    if (!user || !state) return xgr_return_hr(E_INVALIDARG);
    *state = user->xuid ? XUserState_SignedIn : XUserState_SignedOut;
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xu_PADDING_1(void *iface) { (void)iface; return xgr_return_hr(E_NOTIMPL); }

static HRESULT WINAPI xu_XUserGetGamerPictureAsync(void *iface, XUserHandle user, XUserGamerPictureSize picSize, XAsyncBlock *async)
{
    (void)iface;
    if (!user || !async) return xgr_return_hr(E_POINTER);
    struct gamerpic_ctx *ctx = (struct gamerpic_ctx *)calloc(1, sizeof(*ctx));
    if (!ctx) return xgr_return_hr(E_OUTOFMEMORY);
    ctx->pic_size = picSize;
    HRESULT hr = xgr_async_begin(async, ctx, NULL, "XUserGetGamerPictureAsync", gamerpic_provider);
    if (FAILED(hr)) free(ctx);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xu_XUserGetGamerPictureResultSize(void *iface, XAsyncBlock *async, SIZE_T *sz)
{
    (void)iface;
    return xgr_return_hr(xgr_async_get_result_size(async, sz));
}

static HRESULT WINAPI xu_XUserGetGamerPictureResult(void *iface, XAsyncBlock *async, SIZE_T bufSize, void *buf, SIZE_T *used)
{
    (void)iface;
    return xgr_return_hr(xgr_async_get_result(async, NULL, bufSize, buf, used));
}

static HRESULT WINAPI xu_XUserGetAgeGroup(void *iface, XUserHandle user, XUserAgeGroup *ageGroup)
{
    (void)iface;
    if (!user || !ageGroup) return xgr_return_hr(E_INVALIDARG);
    *ageGroup = user->age_group ? user->age_group : XUserAgeGroup_Adult;
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xu_XUserCheckPrivilege(void *iface, XUserHandle user, uint32_t opts, uint32_t priv, BOOLEAN *hasPriv, XUserPrivilegeDenyReason *reason)
{
    (void)iface; (void)opts; (void)priv;
    if (!user || !hasPriv) return xgr_return_hr(E_INVALIDARG);
    *hasPriv = TRUE;
    if (reason) *reason = XUserPrivilegeDenyReason_None;
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xu_XUserResolvePrivilegeWithUiAsync(void *iface, XUserHandle user, uint32_t opts, uint32_t priv, XAsyncBlock *async)
{
    (void)iface; (void)user; (void)opts; (void)priv;
    return xgr_async_begin(async, NULL, NULL, "XUserResolvePrivilegeWithUiAsync", noop_ok_provider);
}

static HRESULT WINAPI xu_XUserResolvePrivilegeWithUiResult(void *iface, XAsyncBlock *async)
{
    (void)iface;
    return xgr_async_get_result(async, NULL, 0, NULL, NULL);
}

static HRESULT WINAPI xu_XUserGetTokenAndSignatureAsync(
    void *iface,
    XUserHandle user,
    uint32_t options,
    const char *method,
    const char *url,
    SIZE_T headerCount,
    const XUserGetTokenAndSignatureHttpHeader *headers,
    SIZE_T bodySize,
    const void *bodyBuffer,
    XAsyncBlock *async
)
{
    (void)iface;
    if (!user || !method || !url || !async) return xgr_return_hr(E_INVALIDARG);
    struct token_sig_ctx *ctx = (struct token_sig_ctx *)calloc(1, sizeof(*ctx));
    if (!ctx) return xgr_return_hr(E_OUTOFMEMORY);

    xgr_user_duplicate(user, &ctx->user);
    ctx->options = options;
    ctx->is_utf16 = false;
    ctx->method = strdup(method);
    ctx->url = strdup(url);
    ctx->headers_json = serialize_headers_utf8_json(headerCount, headers);
    if (bodySize > 0 && bodyBuffer) {
        ctx->body = (uint8_t *)malloc(bodySize);
        if (ctx->body) {
            memcpy(ctx->body, bodyBuffer, bodySize);
            ctx->body_len = bodySize;
        }
    }

    HRESULT hr = xgr_async_begin(async, ctx, NULL, "XUserGetTokenAndSignatureAsync", token_sig_provider);
    if (FAILED(hr)) {
        token_sig_provider(XAsyncOp_Cleanup, &(XAsyncProviderData){ .context = ctx });
    }
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xu_XUserGetTokenAndSignatureResultSize(void *iface, XAsyncBlock *async, SIZE_T *sz)
{
    (void)iface;
    return xgr_async_get_result_size(async, sz);
}

static HRESULT WINAPI xu_XUserGetTokenAndSignatureResult(void *iface, XAsyncBlock *async, SIZE_T bufSize, void *buf, XUserGetTokenAndSignatureData **ptrToBuffer, SIZE_T *used)
{
    (void)iface;
    if (!ptrToBuffer) return xgr_return_hr(E_POINTER);
    HRESULT hr = xgr_async_get_result(async, NULL, bufSize, buf, used);
    *ptrToBuffer = SUCCEEDED(hr) ? (XUserGetTokenAndSignatureData *)buf : NULL;
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xu_XUserGetTokenAndSignatureUtf16Async(
    void *iface,
    XUserHandle user,
    uint32_t options,
    const WCHAR *method,
    const WCHAR *url,
    SIZE_T headerCount,
    const XUserGetTokenAndSignatureUtf16HttpHeader *headers,
    SIZE_T bodySize,
    const void *bodyBuffer,
    XAsyncBlock *async
)
{
    (void)iface;
    if (!user || !method || !url || !async) return xgr_return_hr(E_INVALIDARG);
    struct token_sig_ctx *ctx = (struct token_sig_ctx *)calloc(1, sizeof(*ctx));
    if (!ctx) return xgr_return_hr(E_OUTOFMEMORY);

    xgr_user_duplicate(user, &ctx->user);
    ctx->options = options;
    ctx->is_utf16 = true;
    ctx->method = wide_to_utf8_alloc(method);
    ctx->url = wide_to_utf8_alloc(url);

    if (headerCount > 0 && headers) {
        XUserGetTokenAndSignatureHttpHeader *tmp_hdrs =
            (XUserGetTokenAndSignatureHttpHeader *)calloc(headerCount, sizeof(*tmp_hdrs));
        if (tmp_hdrs) {
            for (SIZE_T i = 0; i < headerCount; i++) {
                tmp_hdrs[i].name = wide_to_utf8_alloc(headers[i].name);
                tmp_hdrs[i].value = wide_to_utf8_alloc(headers[i].value);
            }
            ctx->headers_json = serialize_headers_utf8_json(headerCount, tmp_hdrs);
            for (SIZE_T i = 0; i < headerCount; i++) {
                free((void *)tmp_hdrs[i].name);
                free((void *)tmp_hdrs[i].value);
            }
            free(tmp_hdrs);
        }
    } else {
        ctx->headers_json = strdup("{}");
    }

    if (bodySize > 0 && bodyBuffer) {
        ctx->body = (uint8_t *)malloc(bodySize);
        if (ctx->body) {
            memcpy(ctx->body, bodyBuffer, bodySize);
            ctx->body_len = bodySize;
        }
    }

    HRESULT hr = xgr_async_begin(async, ctx, NULL, "XUserGetTokenAndSignatureUtf16Async", token_sig_provider);
    if (FAILED(hr)) {
        token_sig_provider(XAsyncOp_Cleanup, &(XAsyncProviderData){ .context = ctx });
    }
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xu_XUserGetTokenAndSignatureUtf16ResultSize(void *iface, XAsyncBlock *async, SIZE_T *sz)
{
    (void)iface;
    return xgr_async_get_result_size(async, sz);
}

static HRESULT WINAPI xu_XUserGetTokenAndSignatureUtf16Result(void *iface, XAsyncBlock *async, SIZE_T bufSize, void *buf, XUserGetTokenAndSignatureUtf16Data **ptrToBuffer, SIZE_T *used)
{
    (void)iface;
    if (!ptrToBuffer) return xgr_return_hr(E_POINTER);
    HRESULT hr = xgr_async_get_result(async, NULL, bufSize, buf, used);
    *ptrToBuffer = SUCCEEDED(hr) ? (XUserGetTokenAndSignatureUtf16Data *)buf : NULL;
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xu_XUserResolveIssueWithUiAsync(void *iface, XUserHandle user, const char *url, XAsyncBlock *async)
{
    (void)iface; (void)user; (void)url;
    return xgr_async_begin(async, NULL, NULL, "XUserResolveIssueWithUiAsync", noop_ok_provider);
}

static HRESULT WINAPI xu_XUserResolveIssueWithUiResult(void *iface, XAsyncBlock *async)
{
    (void)iface;
    return xgr_async_get_result(async, NULL, 0, NULL, NULL);
}

static HRESULT WINAPI xu_XUserResolveIssueWithUiUtf16Async(void *iface, XUserHandle user, const WCHAR *url, XAsyncBlock *async)
{
    (void)iface; (void)user; (void)url;
    return xgr_async_begin(async, NULL, NULL, "XUserResolveIssueWithUiUtf16Async", noop_ok_provider);
}

static HRESULT WINAPI xu_XUserResolveIssueWithUiUtf16Result(void *iface, XAsyncBlock *async)
{
    (void)iface;
    return xgr_async_get_result(async, NULL, 0, NULL, NULL);
}

static HRESULT WINAPI xu_XUserRegisterForChangeEvent(void *iface, XTaskQueueHandle queue, void *ctx, XUserChangeEventCallback *cb, XTaskQueueRegistrationToken *token)
{
    (void)iface;
    if (!cb || !token) return E_INVALIDARG;
    struct user_change_reg *reg = (struct user_change_reg *)calloc(1, sizeof(*reg));
    if (!reg) return E_OUTOFMEMORY;
    if (queue) xgr_task_queue_duplicate(queue, &reg->queue);
    reg->context = ctx;
    reg->callback = cb;

    AcquireSRWLockExclusive(&g_user_lock);
    reg->token = g_next_change_token++;
    token->token = reg->token;
    reg->next = g_change_regs;
    g_change_regs = reg;
    ReleaseSRWLockExclusive(&g_user_lock);
    return S_OK;
}

static BOOLEAN WINAPI xu_XUserUnregisterForChangeEvent(void *iface, XTaskQueueRegistrationToken token, BOOLEAN wait)
{
    (void)iface; (void)wait;
    AcquireSRWLockExclusive(&g_user_lock);
    struct user_change_reg *prev = NULL, *cur = g_change_regs;
    while (cur) {
        if (cur->token == token.token) {
            if (prev) prev->next = cur->next;
            else g_change_regs = cur->next;
            ReleaseSRWLockExclusive(&g_user_lock);
            if (cur->queue) xgr_task_queue_close(cur->queue);
            free(cur);
            return TRUE;
        }
        prev = cur;
        cur = cur->next;
    }
    ReleaseSRWLockExclusive(&g_user_lock);
    return TRUE;
}

static HRESULT WINAPI xu_XUserGetSignOutDeferral(void *iface, void **deferral)
{
    (void)iface;
    if (!deferral) return E_INVALIDARG;
    *deferral = (void *)(uintptr_t)0x1;
    return S_OK;
}

static void WINAPI xu_XUserCloseSignOutDeferralHandle(void *iface, void *deferral)
{
    (void)iface; (void)deferral;
}

/* IXUserImpl2 */
static HRESULT WINAPI xu_XUserAddByIdWithUiAsync(void *iface, UINT64 userId, XAsyncBlock *async)
{
    (void)userId;
    return xu_XUserAddAsync(iface, XUserAddOptions_AddDefaultUserAllowingUI, async);
}

static HRESULT WINAPI xu_XUserAddByIdWithUiResult(void *iface, XAsyncBlock *async, XUserHandle *newUser)
{
    return xu_XUserAddResult(iface, async, newUser);
}

/* IXUserImpl3 */
static HRESULT WINAPI xu_XUserGetMsaTokenSilentlyAsync(void *iface, XUserHandle user, uint32_t opts, const char *scope, XAsyncBlock *async)
{
    (void)iface; (void)user; (void)opts; (void)scope; (void)async;
    return E_NOTIMPL;
}
static HRESULT WINAPI xu_XUserGetMsaTokenSilentlyResult(void *iface, XAsyncBlock *async, SIZE_T sz, char *tok, SIZE_T *used)
{
    (void)iface; (void)async; (void)sz; (void)tok; (void)used;
    return E_NOTIMPL;
}
static HRESULT WINAPI xu_XUserGetMsaTokenSilentlyResultSize(void *iface, XAsyncBlock *async, SIZE_T *sz)
{
    (void)iface; (void)async; (void)sz;
    return E_NOTIMPL;
}

/* IXUserImpl4 */
static BOOLEAN WINAPI xu_XUserIsStoreUser(void *iface, XUserHandle user)
{
    (void)iface;
    return user != NULL ? TRUE : FALSE;
}

/* IXUserImpl5 */
static HRESULT WINAPI xu_RemoteConnectSetHandlers(void *iface, XTaskQueueHandle q, void *h) { (void)iface; (void)q; (void)h; return S_OK; }
static HRESULT WINAPI xu_RemoteConnectCancel(void *iface, void *op) { (void)iface; (void)op; return S_OK; }
static HRESULT WINAPI xu_SpopSetHandlers(void *iface, XTaskQueueHandle q, void *h, void *c) { (void)iface; (void)q; (void)h; (void)c; return S_OK; }
static HRESULT WINAPI xu_SpopComplete(void *iface, void *op, uint32_t res) { (void)iface; (void)op; (void)res; return S_OK; }

/* IXUserImpl6 */
static BOOLEAN WINAPI xu_XUserIsSignOutPresent(void *iface) { (void)iface; return FALSE; }
static HRESULT WINAPI xu_XUserSignOutAsync(void *iface, XUserHandle u, XAsyncBlock *ab) { (void)iface; (void)u; (void)ab; return E_NOTIMPL; }
static HRESULT WINAPI xu_XUserSignOutResult(void *iface, XAsyncBlock *ab) { (void)iface; (void)ab; return E_NOTIMPL; }

/* IXUserGamertagImpl */
static HRESULT WINAPI xgt_XUserGetGamertag(void *iface, XUserHandle user, XUserGamertagComponent comp, SIZE_T size, char *gamertag, SIZE_T *used)
{
    (void)iface;
    if (!user) return xgr_return_hr(E_INVALIDARG);
    const char *src = user->gamertag;
    switch (comp) {
        case XUserGamertagComponent_Classic: src = user->gamertag; break;
        case XUserGamertagComponent_Modern: src = user->modern_gamertag; break;
        case XUserGamertagComponent_ModernSuffix: src = user->modern_suffix; break;
        case XUserGamertagComponent_UniqueModern: src = user->unique_modern_gamertag; break;
        default: return xgr_return_hr(E_INVALIDARG);
    }
    SIZE_T need = strlen(src) + 1;
    if (used) *used = need;
    if (!gamertag) return xgr_return_hr(E_INVALIDARG);
    if (size < need) return xgr_return_hr(HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER));
    memcpy(gamertag, src, need);
    return xgr_return_hr(S_OK);
}

static const void *const g_xuser6_vtbl[51] = {
    (const void *)xu_QueryInterface,                        /* 0 */
    (const void *)xu_AddRef,                                /* 1 */
    (const void *)xu_Release,                               /* 2 */
    (const void *)xu_XUserDuplicateHandle,                  /* 3 */
    (const void *)xu_XUserCloseHandle,                      /* 4 */
    (const void *)xu_XUserCompare,                          /* 5 */
    (const void *)xu_XUserGetMaxUsers,                      /* 6 */
    (const void *)xu_XUserAddAsync,                         /* 7 */
    (const void *)xu_XUserAddResult,                        /* 8 */
    (const void *)xu_XUserGetLocalId,                       /* 9 */
    (const void *)xu_XUserFindUserByLocalId,                /* 10 */
    (const void *)xu_XUserGetId,                            /* 11 */
    (const void *)xu_XUserFindUserById,                     /* 12 */
    (const void *)xu_XUserGetIsGuest,                       /* 13 */
    (const void *)xu_XUserGetState,                         /* 14 */
    (const void *)xu_PADDING_1,                             /* 15: __PADDING__ */
    (const void *)xu_XUserGetGamerPictureAsync,             /* 16 */
    (const void *)xu_XUserGetGamerPictureResultSize,        /* 17 */
    (const void *)xu_XUserGetGamerPictureResult,            /* 18 */
    (const void *)xu_XUserGetAgeGroup,                      /* 19 */
    (const void *)xu_XUserCheckPrivilege,                   /* 20 */
    (const void *)xu_XUserResolvePrivilegeWithUiAsync,      /* 21 */
    (const void *)xu_XUserResolvePrivilegeWithUiResult,     /* 22 */
    (const void *)xu_XUserGetTokenAndSignatureAsync,        /* 23 */
    (const void *)xu_XUserGetTokenAndSignatureResultSize,   /* 24 */
    (const void *)xu_XUserGetTokenAndSignatureResult,       /* 25 */
    (const void *)xu_XUserGetTokenAndSignatureUtf16Async,   /* 26 */
    (const void *)xu_XUserGetTokenAndSignatureUtf16ResultSize, /* 27 */
    (const void *)xu_XUserGetTokenAndSignatureUtf16Result,  /* 28 */
    (const void *)xu_XUserResolveIssueWithUiAsync,          /* 29 */
    (const void *)xu_XUserResolveIssueWithUiResult,         /* 30 */
    (const void *)xu_XUserResolveIssueWithUiUtf16Async,     /* 31 */
    (const void *)xu_XUserResolveIssueWithUiUtf16Result,    /* 32 */
    (const void *)xu_XUserRegisterForChangeEvent,           /* 33 */
    (const void *)xu_XUserUnregisterForChangeEvent,         /* 34 */
    (const void *)xu_XUserGetSignOutDeferral,               /* 35 */
    (const void *)xu_XUserCloseSignOutDeferralHandle,       /* 36 */
    /* IXUserImpl2 */
    (const void *)xu_XUserAddByIdWithUiAsync,               /* 37 */
    (const void *)xu_XUserAddByIdWithUiResult,              /* 38 */
    /* IXUserImpl3 */
    (const void *)xu_XUserGetMsaTokenSilentlyAsync,         /* 39 */
    (const void *)xu_XUserGetMsaTokenSilentlyResult,        /* 40 */
    (const void *)xu_XUserGetMsaTokenSilentlyResultSize,    /* 41 */
    /* IXUserImpl4 */
    (const void *)xu_XUserIsStoreUser,                      /* 42 */
    /* IXUserImpl5 */
    (const void *)xu_RemoteConnectSetHandlers,              /* 43 */
    (const void *)xu_RemoteConnectCancel,                   /* 44 */
    (const void *)xu_SpopSetHandlers,                       /* 45 */
    (const void *)xu_SpopComplete,                          /* 46 */
    /* IXUserImpl6 */
    (const void *)xu_XUserIsSignOutPresent,                 /* 47 */
    (const void *)xu_XUserSignOutAsync,                     /* 48 */
    (const void *)xu_XUserSignOutResult,                    /* 49 */
    (const void *)xgr_not_impl_stub                         /* 50 */
};

static const void *const g_xgamertag_vtbl[4] = {
    (const void *)xu_QueryInterface,
    (const void *)xu_AddRef,
    (const void *)xu_Release,
    (const void *)xgt_XUserGetGamertag
};

static struct xgr_user_impl_obj g_xuser_singleton = {
    g_xuser6_vtbl,
    g_xgamertag_vtbl
};

HRESULT xgr_query_user(REFIID iid, void **ppv)
{
    return xu_QueryInterface(&g_xuser_singleton, iid, ppv);
}

/* -------------------------------------------------------------------------
 * IXUserDeviceImpl2 (`CLSID_XUserDeviceImpl`)
 * ------------------------------------------------------------------------- */

static HRESULT WINAPI xud_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualGUID(riid, &IID_IUnknown) ||
        IsEqualGUID(riid, &IID_IXUserDeviceImpl) ||
        IsEqualGUID(riid, &IID_IXUserDeviceImpl2)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static HRESULT WINAPI xud_FindForDevice(void *iface, const void *devId, XUserHandle *handle)
{
    (void)iface; (void)devId;
    if (!handle) return E_INVALIDARG;
    AcquireSRWLockShared(&g_user_lock);
    if (g_active_user) {
        InterlockedIncrement(&g_active_user->ref);
        *handle = g_active_user;
        ReleaseSRWLockShared(&g_user_lock);
        return S_OK;
    }
    ReleaseSRWLockShared(&g_user_lock);
    return E_GAMEUSER_USER_NOT_FOUND;
}

static HRESULT WINAPI xud_RegDevAssoc(void *iface, XTaskQueueHandle q, void *c, void *cb, XTaskQueueRegistrationToken *tok)
{
    (void)iface; (void)q; (void)c; (void)cb;
    if (tok) tok->token = 1;
    return S_OK;
}
static BOOLEAN WINAPI xud_UnregDevAssoc(void *iface, XTaskQueueRegistrationToken tok, BOOLEAN w)
{
    (void)iface; (void)tok; (void)w;
    return TRUE;
}
static HRESULT WINAPI xud_GetDefaultAudio(void *iface, XUserLocalId u, uint32_t kind, SIZE_T cnt, WCHAR *out, SIZE_T *used)
{
    (void)iface; (void)u; (void)kind;
    if (used) *used = 1;
    if (out && cnt > 0) out[0] = L'\0';
    return S_OK;
}
static HRESULT WINAPI xud_RegAudio(void *iface, XTaskQueueHandle q, void *c, void *cb, XTaskQueueRegistrationToken *tok)
{
    (void)iface; (void)q; (void)c; (void)cb;
    if (tok) tok->token = 2;
    return S_OK;
}
static BOOLEAN WINAPI xud_UnregAudio(void *iface, XTaskQueueRegistrationToken tok, BOOLEAN w)
{
    (void)iface; (void)tok; (void)w;
    return TRUE;
}
static HRESULT WINAPI xud_FindCtrlAsync(void *iface, XUserHandle u, XAsyncBlock *ab)
{
    (void)iface; (void)u;
    return xgr_async_begin(ab, NULL, NULL, "XUserFindControllerForUserWithUiAsync", noop_ok_provider);
}
static HRESULT WINAPI xud_FindCtrlResult(void *iface, XAsyncBlock *ab, void *devId)
{
    (void)iface;
    if (devId) memset(devId, 0, 32);
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}

static const void *const g_xuser_device_vtbl[11] = {
    (const void *)xud_QueryInterface,
    (const void *)xu_AddRef,
    (const void *)xu_Release,
    (const void *)xud_FindForDevice,
    (const void *)xud_RegDevAssoc,
    (const void *)xud_UnregDevAssoc,
    (const void *)xud_GetDefaultAudio,
    (const void *)xud_RegAudio,
    (const void *)xud_UnregAudio,
    (const void *)xud_FindCtrlAsync,
    (const void *)xud_FindCtrlResult
};

static struct { const void *lpVtbl; } g_xuser_device_singleton = { g_xuser_device_vtbl };

HRESULT xgr_query_user_device(REFIID iid, void **ppv)
{
    return xud_QueryInterface(&g_xuser_device_singleton, iid, ppv);
}
