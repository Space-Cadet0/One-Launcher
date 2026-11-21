/*
 * One Launcher XGR Bridge — IXStoreImpl6 (`CLSID_XStoreImpl`)
 * Worker-thread loopback RPC for game/DLC/durable licenses, product queries, and Store IDs.
 */

#include "xgr_internal.h"

struct XStoreContext {
    volatile LONG ref;
    XUserHandle user;
    uint64_t xuid;
};

struct XStoreLicense {
    volatile LONG ref;
    bool valid;
    char id[96];
};

struct owned_product {
    char store_id[32];
    char title[256];
    char description[512];
    char language[32];
    char offer_token[64];
    char link_uri[256];
    char sku_id[18];
    char currency[16];
    XStoreSku sku;
    XStoreProduct prod;
};

struct XStoreProductQuery {
    volatile LONG ref;
    uint32_t count;
    struct owned_product *items;
};

struct XStoreCanAcquireLicenseResultAbi {
    char licensableSku[5];
    uint32_t status;
};

_Alignas(8) static volatile LONGLONG g_next_store_reg_token = 100;

/* -------------------------------------------------------------------------
 * Helpers for parsing simple JSON object arrays from loopback server
 * ------------------------------------------------------------------------- */

static const char *store_json_locate_key_value(const char *json, const char *key)
{
    if (!json || !key) return NULL;
    size_t key_len = strlen(key);
    const char *p = json;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != '{') return NULL;

    int depth = 0;
    bool expect_key = false;
    while (*p) {
        char ch = *p;
        if (ch == '"') {
            const char *str_start = ++p;
            while (*p && *p != '"') {
                if (*p == '\\') {
                    p++;
                    if (!*p) return NULL;
                }
                p++;
            }
            if (!*p) return NULL;
            const char *str_end = p;
            p++;
            if (depth == 1 && expect_key) {
                bool match = ((size_t)(str_end - str_start) == key_len) &&
                             (key_len == 0 || memcmp(str_start, key, key_len) == 0);
                const char *after = p;
                while (*after == ' ' || *after == '\t' || *after == '\r' || *after == '\n') after++;
                if (*after == ':') {
                    after++;
                    while (*after == ' ' || *after == '\t' || *after == '\r' || *after == '\n') after++;
                    expect_key = false;
                    if (match) return after;
                    p = after;
                    continue;
                }
            }
            continue;
        }
        if (ch == '{') {
            depth++;
            if (depth == 1) expect_key = true;
        } else if (ch == '}') {
            depth--;
            if (depth <= 0) break;
        } else if (ch == '[') {
            depth++;
        } else if (ch == ']') {
            depth--;
            if (depth <= 0) break;
        } else if (depth == 1) {
            if (ch == ',') expect_key = true;
            else if (ch == ':') expect_key = false;
        }
        p++;
    }
    return NULL;
}

static const char *find_json_array(const char *json, const char *key)
{
    const char *v = store_json_locate_key_value(json, key);
    return (v && *v == '[') ? v : NULL;
}

static bool parse_json_float_field(const char *json, const char *key, float *out_val)
{
    if (!json || !key || !out_val) return false;
    const char *v = store_json_locate_key_value(json, key);
    if (!v) return false;
    if (*v == '"') v++;
    char *endp = NULL;
    double val = strtod(v, &endp);
    if (endp == v) return false;
    *out_val = (float)val;
    return true;
}

static const char *next_json_object_in_array(const char *cursor, char **out_obj_str)
{
    if (!cursor || !out_obj_str) return NULL;
    *out_obj_str = NULL;
    const char *p = cursor;
    while (*p && *p != '{' && *p != ']') p++;
    if (*p != '{') return NULL;

    const char *start = p;
    int depth = 0;
    bool in_str = false;
    while (*p) {
        char c = *p;
        if (in_str) {
            if (c == '\\' && p[1]) {
                p += 2;
                continue;
            }
            if (c == '"') in_str = false;
        } else {
            if (c == '"') in_str = true;
            else if (c == '{') depth++;
            else if (c == '}') {
                depth--;
                if (depth == 0) {
                    size_t len = (size_t)(p - start + 1);
                    char *buf = (char *)malloc(len + 1);
                    if (!buf) return NULL;
                    memcpy(buf, start, len);
                    buf[len] = '\0';
                    *out_obj_str = buf;
                    return p + 1;
                }
            }
        }
        p++;
    }
    return NULL;
}

static char *extract_json_subobject(const char *json, const char *key)
{
    const char *v = store_json_locate_key_value(json, key);
    if (!v || *v != '{') return NULL;
    char *sub = NULL;
    if (next_json_object_in_array(v, &sub) != NULL) {
        return sub;
    }
    return NULL;
}

static struct XStoreProductQuery *build_product_query_from_json(
    const char *res_json,
    const char *fallback_store_id,
    uint32_t fallback_kind
)
{
    struct XStoreProductQuery *q = (struct XStoreProductQuery *)calloc(1, sizeof(*q));
    if (!q) return NULL;
    q->ref = 1;

    const char *arr = find_json_array(res_json, "products");
    if (!arr) {
        struct xgr_runtime_config_snapshot cfg;
        xgr_copy_runtime_config_snapshot(&cfg);
        const char *sid = (fallback_store_id && fallback_store_id[0]) ? fallback_store_id : cfg.storeId;
        if (sid && sid[0]) {
            q->items = (struct owned_product *)calloc(1, sizeof(*q->items));
            if (q->items) {
                q->count = 1;
                struct owned_product *op = &q->items[0];
                snprintf(op->store_id, sizeof(op->store_id), "%s", sid);
                snprintf(op->title, sizeof(op->title), "%s", cfg.displayName[0] ? cfg.displayName : "Xbox Game");
                strcpy(op->language, "en-US");
                strcpy(op->sku_id, "0010");
                strcpy(op->currency, "USD");
                op->sku.skuId = op->sku_id;
                op->sku.title = op->title;
                op->sku.description = op->description;
                op->sku.language = op->language;
                op->sku.price.currencyCode = op->currency;
                op->sku.isInUserCollection = true;
                op->sku.collectionData.quantity = 1;
                op->prod.storeId = op->store_id;
                op->prod.title = op->title;
                op->prod.description = op->description;
                op->prod.language = op->language;
                op->prod.inAppOfferToken = op->offer_token;
                op->prod.linkUri = op->link_uri;
                op->prod.productKind = fallback_kind ? fallback_kind : 0x04;
                op->prod.price.currencyCode = op->currency;
                op->prod.hasDigitalDownload = true;
                op->prod.isInUserCollection = true;
                op->prod.skusCount = 1;
                op->prod.skus = &op->sku;
            }
        }
        return q;
    }

    /* Count objects */
    uint32_t cap = 0;
    const char *scan = arr + 1;
    char *obj = NULL;
    while ((scan = next_json_object_in_array(scan, &obj)) != NULL) {
        free(obj);
        cap++;
        if (cap >= 2048) break;
    }
    if (cap == 0) return q;

    q->items = (struct owned_product *)calloc(cap, sizeof(*q->items));
    if (!q->items) return q;

    scan = arr + 1;
    uint32_t idx = 0;
    while (idx < cap && (scan = next_json_object_in_array(scan, &obj)) != NULL) {
        struct owned_product *op = &q->items[idx];
        xgr_json_get_string(obj, "storeId", op->store_id, sizeof(op->store_id));
        xgr_json_get_string(obj, "title", op->title, sizeof(op->title));
        xgr_json_get_string(obj, "description", op->description, sizeof(op->description));
        if (!xgr_json_get_string(obj, "language", op->language, sizeof(op->language))) {
            strcpy(op->language, "en-US");
        }
        xgr_json_get_string(obj, "inAppOfferToken", op->offer_token, sizeof(op->offer_token));
        xgr_json_get_string(obj, "linkUri", op->link_uri, sizeof(op->link_uri));
        if (!xgr_json_get_string(obj, "skuId", op->sku_id, sizeof(op->sku_id))) {
            strcpy(op->sku_id, "0010");
        }
        char *price_obj = extract_json_subobject(obj, "price");
        const char *price_src = price_obj ? price_obj : obj;
        if (!xgr_json_get_string(price_src, "currencyCode", op->currency, sizeof(op->currency)) &&
            (price_src == obj || !xgr_json_get_string(obj, "currencyCode", op->currency, sizeof(op->currency)))) {
            strcpy(op->currency, "USD");
        }
        int64_t kind = 0x04;
        xgr_json_get_int64(obj, "productKind", &kind);
        bool in_coll = true;
        xgr_json_get_bool(obj, "isInUserCollection", &in_coll);
        bool has_dl = true;
        xgr_json_get_bool(obj, "hasDigitalDownload", &has_dl);

        float list_price = 0.0f;
        float base_price = 0.0f;
        bool on_sale = false;
        parse_json_float_field(price_src, "price", &list_price);
        if (!parse_json_float_field(price_src, "basePrice", &base_price) &&
            (price_src == obj || !parse_json_float_field(obj, "basePrice", &base_price))) {
            base_price = list_price;
        }
        if (!xgr_json_get_bool(price_src, "isOnSale", &on_sale) && price_src != obj) {
            xgr_json_get_bool(obj, "isOnSale", &on_sale);
        }

        op->sku.skuId = op->sku_id;
        op->sku.title = op->title;
        op->sku.description = op->description;
        op->sku.language = op->language;
        op->sku.price.price = list_price;
        op->sku.price.basePrice = base_price;
        op->sku.price.isOnSale = on_sale;
        op->sku.price.currencyCode = op->currency;
        if (!xgr_json_get_string(price_src, "formattedPrice", op->sku.price.formattedPrice, sizeof(op->sku.price.formattedPrice)) && price_src != obj) {
            xgr_json_get_string(obj, "formattedPrice", op->sku.price.formattedPrice, sizeof(op->sku.price.formattedPrice));
        }
        if (!xgr_json_get_string(price_src, "formattedBasePrice", op->sku.price.formattedBasePrice, sizeof(op->sku.price.formattedBasePrice)) && price_src != obj) {
            xgr_json_get_string(obj, "formattedBasePrice", op->sku.price.formattedBasePrice, sizeof(op->sku.price.formattedBasePrice));
        }
        if (!xgr_json_get_string(price_src, "formattedRecurrencePrice", op->sku.price.formattedRecurrencePrice, sizeof(op->sku.price.formattedRecurrencePrice)) && price_src != obj) {
            xgr_json_get_string(obj, "formattedRecurrencePrice", op->sku.price.formattedRecurrencePrice, sizeof(op->sku.price.formattedRecurrencePrice));
        }
        free(price_obj);
        op->sku.isInUserCollection = in_coll;
        op->sku.collectionData.quantity = in_coll ? 1 : 0;

        op->prod.storeId = op->store_id;
        op->prod.title = op->title;
        op->prod.description = op->description;
        op->prod.language = op->language;
        op->prod.inAppOfferToken = op->offer_token;
        op->prod.linkUri = op->link_uri;
        op->prod.productKind = (uint32_t)kind;
        op->prod.price = op->sku.price;
        op->prod.hasDigitalDownload = has_dl;
        op->prod.isInUserCollection = in_coll;
        op->prod.skusCount = 1;
        op->prod.skus = &op->sku;

        free(obj);
        idx++;
    }
    q->count = idx;
    return q;
}

/* -------------------------------------------------------------------------
 * Async Providers
 * ------------------------------------------------------------------------- */

static HRESULT CALLBACK store_noop_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    switch (op) {
        case XAsyncOp_Begin: return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: xgr_async_complete(data->async, S_OK, 0); return S_OK;
        default: return S_OK;
    }
}

/* Game License */
struct game_lic_ctx {
    XStoreGameLicense lic;
};

static HRESULT CALLBACK game_lic_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct game_lic_ctx *ctx = (struct game_lic_ctx *)data->context;
    switch (op) {
        case XAsyncOp_Begin:
            return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            struct xgr_runtime_config_snapshot cfg;
            xgr_copy_runtime_config_snapshot(&cfg);
            memset(&ctx->lic, 0, sizeof(ctx->lic));
            snprintf(
                ctx->lic.skuStoreId,
                sizeof(ctx->lic.skuStoreId),
                "%s",
                cfg.storeId[0] ? cfg.storeId : "9N0000000000"
            );
            ctx->lic.isActive = true;
            ctx->lic.expirationDate = 0;

            if (xgr_rpc_is_configured()) {
                char *res = NULL;
                if (SUCCEEDED(xgr_rpc_call("xstore.getGameLicense", "{}", &res)) && res) {
                    xgr_json_get_string(res, "skuStoreId", ctx->lic.skuStoreId, sizeof(ctx->lic.skuStoreId));
                    xgr_json_get_bool(res, "isActive", &ctx->lic.isActive);
                    xgr_json_get_bool(res, "isTrialOwnedByThisUser", &ctx->lic.isTrialOwnedByThisUser);
                    xgr_json_get_bool(res, "isDiscLicense", &ctx->lic.isDiscLicense);
                    xgr_json_get_bool(res, "isTrial", &ctx->lic.isTrial);
                    int64_t rem = 0, exp = 0;
                    if (xgr_json_get_int64(res, "trialTimeRemainingInSeconds", &rem)) {
                        ctx->lic.trialTimeRemainingInSeconds = (uint32_t)rem;
                    }
                    xgr_json_get_string(res, "trialUniqueId", ctx->lic.trialUniqueId, sizeof(ctx->lic.trialUniqueId));
                    if (xgr_json_get_int64(res, "expirationDate", &exp)) {
                        ctx->lic.expirationDate = exp;
                    }
                    free(res);
                }
            }
            xgr_async_complete(data->async, S_OK, sizeof(XStoreGameLicense));
            return S_OK;
        }
        case XAsyncOp_GetResult:
            if (!data->buffer || data->bufferSize < sizeof(XStoreGameLicense)) return E_INVALIDARG;
            memcpy(data->buffer, &ctx->lic, sizeof(XStoreGameLicense));
            return S_OK;
        case XAsyncOp_Cleanup:
            free(ctx);
            return S_OK;
        default:
            return S_OK;
    }
}

/* Acquire License (Package / Durables) */
struct acquire_lic_ctx {
    char id[96];
    XStoreLicenseHandle handle;
};

static HRESULT CALLBACK acquire_lic_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct acquire_lic_ctx *ctx = (struct acquire_lic_ctx *)data->context;
    switch (op) {
        case XAsyncOp_Begin:
            return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            bool valid = true;
            if (xgr_rpc_is_configured()) {
                XgrStrBuf sb;
                xgr_sb_init(&sb);
                xgr_sb_append_cstr(&sb, "{\"packageIdentifier\":");
                xgr_sb_append_json_str(&sb, ctx->id);
                xgr_sb_append_char(&sb, '}');
                char *params = xgr_sb_detach(&sb);
                if (params) {
                    char *res = NULL;
                    if (SUCCEEDED(xgr_rpc_call("xstore.acquirePackageLicense", params, &res)) && res) {
                        xgr_json_get_bool(res, "licensable", &valid);
                        free(res);
                    }
                    free(params);
                }
            }
            XStoreLicenseHandle h = (XStoreLicenseHandle)calloc(1, sizeof(*h));
            if (!h) {
                xgr_async_complete(data->async, E_OUTOFMEMORY, 0);
                return S_OK;
            }
            h->ref = 1;
            h->valid = valid;
            snprintf(h->id, sizeof(h->id), "%s", ctx->id);
            ctx->handle = h;
            xgr_async_complete(data->async, S_OK, sizeof(XStoreLicenseHandle));
            return S_OK;
        }
        case XAsyncOp_GetResult:
            if (!data->buffer || data->bufferSize < sizeof(XStoreLicenseHandle)) return E_INVALIDARG;
            *(XStoreLicenseHandle *)data->buffer = ctx->handle;
            ctx->handle = NULL;
            return S_OK;
        case XAsyncOp_Cleanup:
            if (ctx->handle) free(ctx->handle);
            free(ctx);
            return S_OK;
        default:
            return S_OK;
    }
}

/* Can Acquire License */
static HRESULT CALLBACK can_acquire_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    switch (op) {
        case XAsyncOp_Begin:
            return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork:
            xgr_async_complete(data->async, S_OK, sizeof(struct XStoreCanAcquireLicenseResultAbi));
            return S_OK;
        case XAsyncOp_GetResult: {
            if (!data->buffer || data->bufferSize < sizeof(struct XStoreCanAcquireLicenseResultAbi)) return E_INVALIDARG;
            struct XStoreCanAcquireLicenseResultAbi *out = (struct XStoreCanAcquireLicenseResultAbi *)data->buffer;
            memset(out, 0, sizeof(*out));
            memcpy(out->licensableSku, "0010", 5);
            out->status = 1; /* Licensable */
            return S_OK;
        }
        default:
            return S_OK;
    }
}

/* Product Queries */
struct prod_query_ctx {
    char method[64];
    char *params_json;
    char fallback_store_id[64];
    uint32_t fallback_kind;
    XStoreProductQueryHandle result_handle;
};

static void close_product_query(XStoreProductQueryHandle q)
{
    if (!q) return;
    if (InterlockedDecrement(&q->ref) == 0) {
        free(q->items);
        free(q);
    }
}

static HRESULT CALLBACK prod_query_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct prod_query_ctx *ctx = (struct prod_query_ctx *)data->context;
    switch (op) {
        case XAsyncOp_Begin:
            return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            char *res = NULL;
            if (xgr_rpc_is_configured()) {
                xgr_rpc_call(ctx->method, ctx->params_json ? ctx->params_json : "{}", &res);
            }
            ctx->result_handle = build_product_query_from_json(
                res,
                ctx->fallback_store_id,
                ctx->fallback_kind
            );
            free(res);
            if (!ctx->result_handle) {
                xgr_async_complete(data->async, E_OUTOFMEMORY, 0);
                return S_OK;
            }
            xgr_async_complete(data->async, S_OK, sizeof(XStoreProductQueryHandle));
            return S_OK;
        }
        case XAsyncOp_GetResult:
            if (!data->buffer || data->bufferSize < sizeof(XStoreProductQueryHandle)) return E_INVALIDARG;
            *(XStoreProductQueryHandle *)data->buffer = ctx->result_handle;
            ctx->result_handle = NULL;
            return S_OK;
        case XAsyncOp_Cleanup:
            if (ctx->result_handle) close_product_query(ctx->result_handle);
            free(ctx->params_json);
            free(ctx);
            return S_OK;
        default:
            return S_OK;
    }
}

/* AddOn Licenses */
struct addon_lic_ctx {
    uint32_t count;
    XStoreAddonLicense *items;
};

static HRESULT CALLBACK addon_lic_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct addon_lic_ctx *ctx = (struct addon_lic_ctx *)data->context;
    switch (op) {
        case XAsyncOp_Begin:
            return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            if (xgr_rpc_is_configured()) {
                char *res = NULL;
                if (SUCCEEDED(xgr_rpc_call("xstore.queryAddOnLicenses", "{}", &res)) && res) {
                    const char *arr = find_json_array(res, "licenses");
                    if (arr) {
                        uint32_t cap = 0;
                        const char *scan = arr + 1;
                        char *obj = NULL;
                        while ((scan = next_json_object_in_array(scan, &obj)) != NULL) {
                            free(obj);
                            cap++;
                            if (cap >= 256) break;
                        }
                        if (cap > 0) {
                            ctx->items = (XStoreAddonLicense *)calloc(cap, sizeof(XStoreAddonLicense));
                            if (ctx->items) {
                                scan = arr + 1;
                                uint32_t idx = 0;
                                while (idx < cap && (scan = next_json_object_in_array(scan, &obj)) != NULL) {
                                    xgr_json_get_string(obj, "skuStoreId", ctx->items[idx].skuStoreId, sizeof(ctx->items[idx].skuStoreId));
                                    xgr_json_get_string(obj, "inAppOfferToken", ctx->items[idx].inAppOfferToken, sizeof(ctx->items[idx].inAppOfferToken));
                                    ctx->items[idx].isActive = true;
                                    xgr_json_get_bool(obj, "isActive", &ctx->items[idx].isActive);
                                    int64_t exp = 0;
                                    if (xgr_json_get_int64(obj, "expirationDate", &exp)) {
                                        ctx->items[idx].expirationDate = exp;
                                    }
                                    free(obj);
                                    idx++;
                                }
                                ctx->count = idx;
                            }
                        }
                    }
                    free(res);
                }
            }
            xgr_async_complete(data->async, S_OK, ctx->count * sizeof(XStoreAddonLicense));
            return S_OK;
        }
        case XAsyncOp_GetResult:
            if (ctx->count > 0 && data->buffer) {
                size_t copy_bytes = ctx->count * sizeof(XStoreAddonLicense);
                if (data->bufferSize < copy_bytes) return E_INVALIDARG;
                memcpy(data->buffer, ctx->items, copy_bytes);
            }
            return S_OK;
        case XAsyncOp_Cleanup:
            free(ctx->items);
            free(ctx);
            return S_OK;
        default:
            return S_OK;
    }
}

/* CollectionsId / PurchaseId / LicenseToken String Async */
struct store_str_ctx {
    char method[64];
    char *ticket;
    char *pub_uid;
    char *raw_params_json;
    char *result_str;
    size_t result_size;
};

static HRESULT CALLBACK store_str_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct store_str_ctx *ctx = (struct store_str_ctx *)data->context;
    switch (op) {
        case XAsyncOp_Begin:
            return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            if (xgr_rpc_is_configured()) {
                char *params = NULL;
                if (ctx->raw_params_json) {
                    params = ctx->raw_params_json;
                    ctx->raw_params_json = NULL;
                } else {
                    XgrStrBuf sb;
                    xgr_sb_init(&sb);
                    xgr_sb_append_cstr(&sb, "{\"serviceTicket\":");
                    xgr_sb_append_json_str(&sb, ctx->ticket ? ctx->ticket : "");
                    xgr_sb_append_cstr(&sb, ",\"publisherUserId\":");
                    xgr_sb_append_json_str(&sb, ctx->pub_uid ? ctx->pub_uid : "");
                    xgr_sb_append_char(&sb, '}');
                    params = xgr_sb_detach(&sb);
                }
                if (params) {
                    char *res = NULL;
                    if (SUCCEEDED(xgr_rpc_call(ctx->method, params, &res)) && res) {
                        ctx->result_str = xgr_json_alloc_string(res, "token");
                        free(res);
                    }
                    free(params);
                }
            }
            if (!ctx->result_str) {
                ctx->result_str = (char *)calloc(1, 1);
                if (!ctx->result_str) {
                    xgr_async_complete(data->async, E_OUTOFMEMORY, 0);
                    return S_OK;
                }
            }
            ctx->result_size = strlen(ctx->result_str) + 1;
            xgr_async_complete(data->async, S_OK, ctx->result_size);
            return S_OK;
        }
        case XAsyncOp_GetResult:
            if (!data->buffer || !ctx->result_str || data->bufferSize < ctx->result_size) return E_INVALIDARG;
            memcpy(data->buffer, ctx->result_str, ctx->result_size);
            return S_OK;
        case XAsyncOp_Cleanup:
            free(ctx->ticket);
            free(ctx->pub_uid);
            free(ctx->raw_params_json);
            free(ctx->result_str);
            free(ctx);
            return S_OK;
        default:
            return S_OK;
    }
}

/* -------------------------------------------------------------------------
 * IXStoreImpl6 Methods (Exact 84-slot vtable)
 * ------------------------------------------------------------------------- */

static HRESULT WINAPI xs_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) {
        *ppv = NULL;
        return E_INVALIDARG;
    }
    if (IsEqualGUID(riid, &IID_IUnknown) ||
        IsEqualGUID(riid, &IID_IXStoreImpl) ||
        IsEqualGUID(riid, &IID_IXStoreImpl2) ||
        IsEqualGUID(riid, &IID_IXStoreImpl3) ||
        IsEqualGUID(riid, &IID_IXStoreImpl4) ||
        IsEqualGUID(riid, &IID_IXStoreImpl5) ||
        IsEqualGUID(riid, &IID_IXStoreImpl6)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static ULONG WINAPI xs_AddRef(void *iface) { (void)iface; return 2; }
static ULONG WINAPI xs_Release(void *iface) { (void)iface; return 1; }

static HRESULT WINAPI xs_XStoreCreateContext(void *iface, const XUserHandle user, XStoreContextHandle *out)
{
    (void)iface;
    if (!out) return E_INVALIDARG;
    XStoreContextHandle ctx = (XStoreContextHandle)calloc(1, sizeof(*ctx));
    if (!ctx) return E_OUTOFMEMORY;
    ctx->ref = 1;
    if (user) xgr_user_duplicate(user, &ctx->user);
    ctx->xuid = xgr_user_get_xuid(user);
    *out = ctx;
    return xgr_return_hr(S_OK);
}

static void WINAPI xs_XStoreCloseContextHandle(void *iface, XStoreContextHandle ctx)
{
    (void)iface;
    if (!ctx) return;
    if (InterlockedDecrement(&ctx->ref) == 0) {
        if (ctx->user) xgr_user_close(ctx->user);
        free(ctx);
    }
}

static HRESULT start_product_query_async_ex(
    const char *method,
    char *params_json,
    const char *fallback_store_id,
    uint32_t fallback_kind,
    const void *id,
    const char *name,
    XAsyncBlock *async
)
{
    struct prod_query_ctx *ctx = (struct prod_query_ctx *)calloc(1, sizeof(*ctx));
    if (!ctx) {
        free(params_json);
        return E_OUTOFMEMORY;
    }
    snprintf(ctx->method, sizeof(ctx->method), "%s", method);
    ctx->params_json = params_json;
    if (fallback_store_id && fallback_store_id[0]) {
        snprintf(ctx->fallback_store_id, sizeof(ctx->fallback_store_id), "%s", fallback_store_id);
    }
    ctx->fallback_kind = fallback_kind;
    HRESULT hr = xgr_async_begin(async, ctx, id, name, prod_query_provider);
    if (FAILED(hr)) {
        free(ctx->params_json);
        free(ctx);
    }
    return xgr_return_hr(hr);
}

static HRESULT start_product_query_async(const char *method, char *params_json, const void *id, const char *name, XAsyncBlock *async)
{
    return start_product_query_async_ex(method, params_json, NULL, 0, id, name, async);
}

static HRESULT WINAPI xs_XStoreQueryAssociatedProductsAsync(void *iface, const XStoreContextHandle sc, uint32_t kinds, uint32_t maxItems, XAsyncBlock *async)
{
    (void)iface; (void)sc;
    char *p = (char *)malloc(128);
    if (!p) return E_OUTOFMEMORY;
    snprintf(p, 128, "{\"productKinds\":%u,\"maxItems\":%u}", kinds, maxItems);
    return start_product_query_async("xstore.queryAssociatedProducts", p, (const void *)xs_XStoreQueryAssociatedProductsAsync, "XStoreQueryAssociatedProductsAsync", async);
}

static HRESULT WINAPI xs_XStoreQueryAssociatedProductsResult(void *iface, XAsyncBlock *async, XStoreProductQueryHandle *out)
{
    (void)iface;
    if (!out) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreQueryAssociatedProductsAsync, sizeof(*out), out, NULL));
}

static HRESULT WINAPI xs_XStoreQueryProductsAsync(void *iface, const XStoreContextHandle sc, uint32_t kinds, const char **storeIds, SIZE_T storeIdsCount, const char **actionFilters, SIZE_T actionFiltersCount, XAsyncBlock *async)
{
    (void)iface; (void)sc;
    if (storeIdsCount > 0 && !storeIds) return E_INVALIDARG;
    if (storeIdsCount > 65536) return E_INVALIDARG;

    XgrStrBuf sb;
    xgr_sb_init(&sb);
    xgr_sb_append_fmt(&sb, "{\"productKinds\":%u,\"storeIds\":[", kinds);
    for (SIZE_T i = 0; i < storeIdsCount; i++) {
        if (i > 0) xgr_sb_append_char(&sb, ',');
        xgr_sb_append_json_str(&sb, storeIds[i] ? storeIds[i] : "");
    }
    xgr_sb_append_cstr(&sb, "],\"actionFilters\":[");
    if (actionFilters && actionFiltersCount <= 1024) {
        for (SIZE_T j = 0; j < actionFiltersCount; j++) {
            if (j > 0) xgr_sb_append_char(&sb, ',');
            xgr_sb_append_json_str(&sb, actionFilters[j] ? actionFilters[j] : "");
        }
    }
    xgr_sb_append_cstr(&sb, "]}");
    char *p = xgr_sb_detach(&sb);
    if (!p) return E_OUTOFMEMORY;
    return start_product_query_async("xstore.queryProducts", p, (const void *)xs_XStoreQueryProductsAsync, "XStoreQueryProductsAsync", async);
}

static HRESULT WINAPI xs_XStoreQueryProductsResult(void *iface, XAsyncBlock *async, XStoreProductQueryHandle *out)
{
    (void)iface;
    if (!out) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreQueryProductsAsync, sizeof(*out), out, NULL));
}

static HRESULT WINAPI xs_XStoreQueryEntitledProductsAsync(void *iface, const XStoreContextHandle sc, uint32_t kinds, uint32_t maxItems, XAsyncBlock *async)
{
    (void)iface; (void)sc;
    char *p = (char *)malloc(128);
    if (!p) return E_OUTOFMEMORY;
    snprintf(p, 128, "{\"productKinds\":%u,\"maxItems\":%u}", kinds, maxItems);
    return start_product_query_async("xstore.queryEntitledProducts", p, (const void *)xs_XStoreQueryEntitledProductsAsync, "XStoreQueryEntitledProductsAsync", async);
}

static HRESULT WINAPI xs_XStoreQueryEntitledProductsResult(void *iface, XAsyncBlock *async, XStoreProductQueryHandle *out)
{
    (void)iface;
    if (!out) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreQueryEntitledProductsAsync, sizeof(*out), out, NULL));
}

static HRESULT WINAPI xs_XStoreQueryProductForCurrentGameAsync(void *iface, const XStoreContextHandle sc, XAsyncBlock *async)
{
    (void)iface; (void)sc;
    char *p = (char *)malloc(64);
    if (!p) return E_OUTOFMEMORY;
    strcpy(p, "{\"productKinds\":4,\"maxItems\":1}");
    return start_product_query_async("xstore.queryEntitledProducts", p, (const void *)xs_XStoreQueryProductForCurrentGameAsync, "XStoreQueryProductForCurrentGameAsync", async);
}

static HRESULT WINAPI xs_XStoreQueryProductForCurrentGameResult(void *iface, XAsyncBlock *async, XStoreProductQueryHandle *out)
{
    (void)iface;
    if (!out) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreQueryProductForCurrentGameAsync, sizeof(*out), out, NULL));
}

static HRESULT WINAPI xs_XStoreQueryProductForPackageAsync(void *iface, const XStoreContextHandle sc, uint32_t kinds, const char *pkgId, XAsyncBlock *async)
{
    (void)iface; (void)sc;
    if (!pkgId || !pkgId[0] || !async) return E_INVALIDARG;

    char store_id[64] = { 0 };
    bool have_sid = xgr_package_find_store_id_by_identifier(pkgId, store_id, sizeof(store_id));

    XgrStrBuf sb;
    xgr_sb_init(&sb);
    xgr_sb_append_fmt(&sb, "{\"productKinds\":%u,\"packageIdentifier\":", kinds);
    xgr_sb_append_json_str(&sb, pkgId);
    if (have_sid && store_id[0]) {
        xgr_sb_append_cstr(&sb, ",\"storeId\":");
        xgr_sb_append_json_str(&sb, store_id);
        xgr_sb_append_cstr(&sb, ",\"storeIds\":[");
        xgr_sb_append_json_str(&sb, store_id);
        xgr_sb_append_cstr(&sb, "],\"actionFilters\":[]}");
        char *p = xgr_sb_detach(&sb);
        if (!p) return E_OUTOFMEMORY;
        return start_product_query_async_ex(
            "xstore.queryProducts",
            p,
            store_id,
            kinds ? kinds : 0x01u,
            (const void *)xs_XStoreQueryProductForPackageAsync,
            "XStoreQueryProductForPackageAsync",
            async
        );
    }
    xgr_sb_append_cstr(&sb, ",\"maxItems\":5}");
    char *p = xgr_sb_detach(&sb);
    if (!p) return E_OUTOFMEMORY;
    return start_product_query_async(
        "xstore.queryEntitledProducts",
        p,
        (const void *)xs_XStoreQueryProductForPackageAsync,
        "XStoreQueryProductForPackageAsync",
        async
    );
}

static HRESULT WINAPI xs_XStoreQueryProductForPackageResult(void *iface, XAsyncBlock *async, XStoreProductQueryHandle *out)
{
    (void)iface;
    if (!out) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreQueryProductForPackageAsync, sizeof(*out), out, NULL));
}

static HRESULT WINAPI xs_XStoreEnumerateProductsQuery(void *iface, const XStoreProductQueryHandle q, void *context, XStoreProductQueryCallback *cb)
{
    (void)iface;
    if (!q || !cb) return E_INVALIDARG;
    for (uint32_t i = 0; i < q->count; i++) {
        if (!cb(&q->items[i].prod, context)) break;
    }
    return xgr_return_hr(S_OK);
}

static BOOLEAN WINAPI xs_XStoreProductsQueryHasMorePages(void *iface, const XStoreProductQueryHandle q)
{
    (void)iface; (void)q;
    return FALSE;
}

static HRESULT CALLBACK empty_prod_query_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    XStoreProductQueryHandle *slot = (XStoreProductQueryHandle *)data->context;
    switch (op) {
        case XAsyncOp_Begin:
            return xgr_async_schedule(data->async, 0);
        case XAsyncOp_DoWork: {
            XStoreProductQueryHandle q = (XStoreProductQueryHandle)calloc(1, sizeof(*q));
            if (!q) {
                xgr_async_complete(data->async, E_OUTOFMEMORY, 0);
                return S_OK;
            }
            q->ref = 1;
            *slot = q;
            xgr_async_complete(data->async, S_OK, sizeof(XStoreProductQueryHandle));
            return S_OK;
        }
        case XAsyncOp_GetResult:
            if (!data->buffer || data->bufferSize < sizeof(XStoreProductQueryHandle)) return E_INVALIDARG;
            *(XStoreProductQueryHandle *)data->buffer = *slot;
            *slot = NULL;
            return S_OK;
        case XAsyncOp_Cleanup:
            if (slot) {
                if (*slot) close_product_query(*slot);
                free(slot);
            }
            return S_OK;
        default:
            return S_OK;
    }
}

static HRESULT WINAPI xs_XStoreProductsQueryNextPageAsync(void *iface, const XStoreProductQueryHandle q, XAsyncBlock *async)
{
    (void)iface; (void)q;
    if (!async) return xgr_return_hr(E_INVALIDARG);
    XStoreProductQueryHandle *slot = (XStoreProductQueryHandle *)calloc(1, sizeof(*slot));
    if (!slot) return xgr_return_hr(E_OUTOFMEMORY);
    HRESULT hr = xgr_async_begin(async, slot, (const void *)xs_XStoreProductsQueryNextPageAsync, "XStoreProductsQueryNextPageAsync", empty_prod_query_provider);
    if (FAILED(hr)) free(slot);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xs_XStoreProductsQueryNextPageResult(void *iface, XAsyncBlock *async, XStoreProductQueryHandle *out)
{
    (void)iface;
    if (!out) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreProductsQueryNextPageAsync, sizeof(*out), out, NULL));
}

static void WINAPI xs_XStoreCloseProductsQueryHandle(void *iface, XStoreProductQueryHandle q)
{
    (void)iface;
    close_product_query(q);
}

static HRESULT WINAPI xs_XStoreAcquireLicenseForPackageAsync(void *iface, const void *handle, const char *pkgId, XAsyncBlock *async)
{
    (void)iface; (void)handle;
    if (!pkgId || !async) return E_INVALIDARG;
    struct acquire_lic_ctx *ctx = (struct acquire_lic_ctx *)calloc(1, sizeof(*ctx));
    if (!ctx) return E_OUTOFMEMORY;
    snprintf(ctx->id, sizeof(ctx->id), "%s", pkgId);
    HRESULT hr = xgr_async_begin(async, ctx, (const void *)xs_XStoreAcquireLicenseForPackageAsync, "XStoreAcquireLicenseForPackageAsync", acquire_lic_provider);
    if (FAILED(hr)) free(ctx);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xs_XStoreAcquireLicenseForPackageResult(void *iface, XAsyncBlock *async, XStoreLicenseHandle *out)
{
    (void)iface;
    if (!out) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreAcquireLicenseForPackageAsync, sizeof(*out), out, NULL));
}

static BOOLEAN WINAPI xs_XStoreIsLicenseValid(void *iface, const XStoreLicenseHandle lic)
{
    (void)iface;
    return (lic && lic->valid) ? TRUE : FALSE;
}

static void WINAPI xs_XStoreCloseLicenseHandle(void *iface, XStoreLicenseHandle lic)
{
    (void)iface;
    if (!lic) return;
    if (InterlockedDecrement(&lic->ref) == 0) free(lic);
}

static HRESULT WINAPI xs_XStoreCanAcquireLicenseForStoreIdAsync(void *iface, const XStoreContextHandle sc, const char *storeId, XAsyncBlock *async)
{
    (void)iface; (void)sc; (void)storeId;
    return xgr_return_hr(xgr_async_begin(async, NULL, (const void *)xs_XStoreCanAcquireLicenseForStoreIdAsync, "XStoreCanAcquireLicenseForStoreIdAsync", can_acquire_provider));
}

static HRESULT WINAPI xs_XStoreCanAcquireLicenseForStoreIdResult(void *iface, XAsyncBlock *async, void *out)
{
    (void)iface;
    if (!out) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreCanAcquireLicenseForStoreIdAsync, sizeof(struct XStoreCanAcquireLicenseResultAbi), out, NULL));
}

static HRESULT WINAPI xs_XStoreCanAcquireLicenseForPackageAsync(void *iface, const XStoreContextHandle sc, const char *pkgId, XAsyncBlock *async)
{
    (void)iface; (void)sc; (void)pkgId;
    return xgr_return_hr(xgr_async_begin(async, NULL, (const void *)xs_XStoreCanAcquireLicenseForPackageAsync, "XStoreCanAcquireLicenseForPackageAsync", can_acquire_provider));
}

static HRESULT WINAPI xs_XStoreCanAcquireLicenseForPackageResult(void *iface, XAsyncBlock *async, void *out)
{
    (void)iface;
    if (!out) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreCanAcquireLicenseForPackageAsync, sizeof(struct XStoreCanAcquireLicenseResultAbi), out, NULL));
}

static HRESULT WINAPI xs_XStoreQueryGameLicenseAsync(void *iface, const XStoreContextHandle sc, XAsyncBlock *async)
{
    (void)iface; (void)sc;
    if (!async) return E_INVALIDARG;
    struct game_lic_ctx *ctx = (struct game_lic_ctx *)calloc(1, sizeof(*ctx));
    if (!ctx) return E_OUTOFMEMORY;
    HRESULT hr = xgr_async_begin(async, ctx, (const void *)xs_XStoreQueryGameLicenseAsync, "XStoreQueryGameLicenseAsync", game_lic_provider);
    if (FAILED(hr)) free(ctx);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xs_XStoreQueryGameLicenseResult(void *iface, XAsyncBlock *async, XStoreGameLicense *lic)
{
    (void)iface;
    if (!lic) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreQueryGameLicenseAsync, sizeof(*lic), lic, NULL));
}

static HRESULT WINAPI xs_XStoreQueryAddOnLicensesAsync(void *iface, const XStoreContextHandle sc, XAsyncBlock *async)
{
    (void)iface; (void)sc;
    if (!async) return E_INVALIDARG;
    struct addon_lic_ctx *ctx = (struct addon_lic_ctx *)calloc(1, sizeof(*ctx));
    if (!ctx) return E_OUTOFMEMORY;
    HRESULT hr = xgr_async_begin(async, ctx, (const void *)xs_XStoreQueryAddOnLicensesAsync, "XStoreQueryAddOnLicensesAsync", addon_lic_provider);
    if (FAILED(hr)) free(ctx);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xs_XStoreQueryAddOnLicensesResultCount(void *iface, XAsyncBlock *async, uint32_t *count)
{
    (void)iface;
    if (!count) return E_INVALIDARG;
    size_t sz = 0;
    HRESULT hr = xgr_async_get_result_size(async, &sz);
    if (FAILED(hr)) return xgr_return_hr(hr);
    *count = (uint32_t)(sz / sizeof(XStoreAddonLicense));
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI xs_XStoreQueryAddOnLicensesResult(void *iface, XAsyncBlock *async, uint32_t count, XStoreAddonLicense *out)
{
    (void)iface;
    if (count > 0 && !out) return E_INVALIDARG;
    if ((size_t)count > SIZE_MAX / sizeof(XStoreAddonLicense)) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreQueryAddOnLicensesAsync, (size_t)count * sizeof(XStoreAddonLicense), out, NULL));
}

static HRESULT WINAPI xs_XStoreQueryConsumableBalanceRemainingAsync(void *iface, const XStoreContextHandle sc, const char *pid, XAsyncBlock *async)
{
    (void)iface; (void)sc; (void)pid;
    return xgr_async_begin(async, NULL, NULL, "XStoreQueryConsumableBalanceRemainingAsync", store_noop_provider);
}

static HRESULT WINAPI xs_XStoreQueryConsumableBalanceRemainingResult(void *iface, XAsyncBlock *async, uint32_t *qty)
{
    (void)iface;
    if (qty) *qty = 0;
    return xgr_async_get_result(async, NULL, 0, NULL, NULL);
}

static HRESULT WINAPI xs_XStoreReportConsumableFulfillmentAsync(void *iface, const XStoreContextHandle sc, const char *pid, uint32_t qty, GUID trackingId, XAsyncBlock *async)
{
    (void)iface; (void)sc; (void)pid; (void)qty; (void)trackingId;
    return xgr_async_begin(async, NULL, NULL, "XStoreReportConsumableFulfillmentAsync", store_noop_provider);
}

static HRESULT WINAPI xs_XStoreReportConsumableFulfillmentResult(void *iface, XAsyncBlock *async, uint32_t *qty)
{
    (void)iface;
    if (qty) *qty = 0;
    return xgr_async_get_result(async, NULL, 0, NULL, NULL);
}

static HRESULT start_store_str_async(const char *method, const char *ticket, const char *pub_uid, const void *id, const char *name, XAsyncBlock *async)
{
    if (!async) return E_INVALIDARG;
    struct store_str_ctx *ctx = (struct store_str_ctx *)calloc(1, sizeof(*ctx));
    if (!ctx) return E_OUTOFMEMORY;
    snprintf(ctx->method, sizeof(ctx->method), "%s", method);
    if (ticket) {
        size_t n = strlen(ticket) + 1;
        ctx->ticket = (char *)malloc(n);
        if (!ctx->ticket) {
            free(ctx);
            return xgr_return_hr(E_OUTOFMEMORY);
        }
        memcpy(ctx->ticket, ticket, n);
    }
    if (pub_uid) {
        size_t n = strlen(pub_uid) + 1;
        ctx->pub_uid = (char *)malloc(n);
        if (!ctx->pub_uid) {
            free(ctx->ticket);
            free(ctx);
            return xgr_return_hr(E_OUTOFMEMORY);
        }
        memcpy(ctx->pub_uid, pub_uid, n);
    }
    HRESULT hr = xgr_async_begin(async, ctx, id, name, store_str_provider);
    if (FAILED(hr)) {
        free(ctx->ticket);
        free(ctx->pub_uid);
        free(ctx);
    }
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xs_XStoreGetUserCollectionsIdAsync(void *iface, const XStoreContextHandle sc, const char *ticket, const char *pubUid, XAsyncBlock *async)
{
    (void)iface; (void)sc;
    return start_store_str_async("xstore.getCollectionsId", ticket, pubUid, (const void *)xs_XStoreGetUserCollectionsIdAsync, "XStoreGetUserCollectionsIdAsync", async);
}

static HRESULT WINAPI xs_XStoreGetUserCollectionsIdResultSize(void *iface, XAsyncBlock *async, size_t *size)
{
    (void)iface;
    return xgr_return_hr(xgr_async_get_result_size(async, size));
}

static HRESULT WINAPI xs_XStoreGetUserCollectionsIdResult(void *iface, XAsyncBlock *async, size_t size, char *result)
{
    (void)iface;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreGetUserCollectionsIdAsync, size, result, NULL));
}

static HRESULT WINAPI xs_XStoreGetUserPurchaseIdAsync(void *iface, const XStoreContextHandle sc, const char *ticket, const char *pubUid, XAsyncBlock *async)
{
    (void)iface; (void)sc;
    return start_store_str_async("xstore.getPurchaseId", ticket, pubUid, (const void *)xs_XStoreGetUserPurchaseIdAsync, "XStoreGetUserPurchaseIdAsync", async);
}

static HRESULT WINAPI xs_XStoreGetUserPurchaseIdResultSize(void *iface, XAsyncBlock *async, size_t *size)
{
    (void)iface;
    return xgr_return_hr(xgr_async_get_result_size(async, size));
}

static HRESULT WINAPI xs_XStoreGetUserPurchaseIdResult(void *iface, XAsyncBlock *async, size_t size, char *result)
{
    (void)iface;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreGetUserPurchaseIdAsync, size, result, NULL));
}

static HRESULT WINAPI xs_XStoreQueryLicenseTokenAsync(void *iface, const XStoreContextHandle sc, const char **pids, size_t cnt, const char *devStr, XAsyncBlock *async)
{
    (void)iface; (void)sc;
    if (!async) return xgr_return_hr(E_INVALIDARG);
    if (cnt > 0 && !pids) return xgr_return_hr(E_INVALIDARG);
    if (cnt > 4096) return xgr_return_hr(E_INVALIDARG);

    XgrStrBuf sb;
    xgr_sb_init(&sb);
    xgr_sb_append_cstr(&sb, "{\"productIds\":[");
    for (size_t i = 0; i < cnt; i++) {
        if (i > 0) xgr_sb_append_char(&sb, ',');
        xgr_sb_append_json_str(&sb, pids[i] ? pids[i] : "");
    }
    xgr_sb_append_cstr(&sb, "],\"customDeveloperString\":");
    xgr_sb_append_json_str(&sb, devStr ? devStr : "");
    xgr_sb_append_char(&sb, '}');

    char *raw_params = xgr_sb_detach(&sb);
    if (!raw_params) return xgr_return_hr(E_OUTOFMEMORY);

    struct store_str_ctx *ctx = (struct store_str_ctx *)calloc(1, sizeof(*ctx));
    if (!ctx) {
        free(raw_params);
        return xgr_return_hr(E_OUTOFMEMORY);
    }
    strcpy(ctx->method, "xstore.queryLicenseToken");
    ctx->raw_params_json = raw_params;

    HRESULT hr = xgr_async_begin(
        async,
        ctx,
        (const void *)xs_XStoreQueryLicenseTokenAsync,
        "XStoreQueryLicenseTokenAsync",
        store_str_provider
    );
    if (FAILED(hr)) {
        free(ctx->raw_params_json);
        free(ctx);
    }
    return xgr_return_hr(hr);
}

static HRESULT WINAPI xs_XStoreQueryLicenseTokenResultSize(void *iface, XAsyncBlock *async, size_t *size)
{
    (void)iface;
    return xgr_return_hr(xgr_async_get_result_size(async, size));
}

static HRESULT WINAPI xs_XStoreQueryLicenseTokenResult(void *iface, XAsyncBlock *async, size_t size, char *result)
{
    (void)iface;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreQueryLicenseTokenAsync, size, result, NULL));
}

/* Slots 46-48: XStoreSendRequestAsync / ResultSize / Result (exact __stdcall arity) */
static HRESULT WINAPI xs_XStoreSendRequestAsync(void *iface, const XStoreContextHandle sc, const char *interfaceName, uint32_t requestId, const char *requestData, size_t requestDataSize, XAsyncBlock *async)
{
    (void)iface; (void)sc; (void)interfaceName; (void)requestId; (void)requestData; (void)requestDataSize; (void)async;
    return xgr_return_hr(E_NOTIMPL);
}
static HRESULT WINAPI xs_XStoreSendRequestResultSize(void *iface, XAsyncBlock *async, size_t *size)
{
    (void)iface; (void)async;
    if (size) *size = 0;
    return xgr_return_hr(E_NOTIMPL);
}
static HRESULT WINAPI xs_XStoreSendRequestResult(void *iface, XAsyncBlock *async, size_t size, char *result, size_t *used)
{
    (void)iface; (void)async; (void)size; (void)result;
    if (used) *used = 0;
    return xgr_return_hr(E_NOTIMPL);
}

static HRESULT WINAPI xs_XStoreShowPurchaseUIAsync(void *iface, const XStoreContextHandle sc, const char *sid, const char *name, const char *ext, XAsyncBlock *ab)
{
    (void)iface; (void)sc; (void)sid; (void)name; (void)ext;
    return xgr_async_begin(ab, NULL, NULL, "XStoreShowPurchaseUIAsync", store_noop_provider);
}
static HRESULT WINAPI xs_XStoreShowPurchaseUIResult(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}

static HRESULT WINAPI xs_XStoreShowRateAndReviewUIAsync(void *iface, const XStoreContextHandle sc, XAsyncBlock *ab)
{
    (void)iface; (void)sc;
    return xgr_async_begin(ab, NULL, NULL, "XStoreShowRateAndReviewUIAsync", store_noop_provider);
}
static HRESULT WINAPI xs_XStoreShowRateAndReviewUIResult(void *iface, XAsyncBlock *ab, uint8_t *wasUpdated)
{
    (void)iface;
    if (wasUpdated) *wasUpdated = 0;
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}

static HRESULT WINAPI xs_XStoreShowRedeemTokenUIAsync(void *iface, const XStoreContextHandle sc, const char *tok, const char **sids, SIZE_T cnt, BOOLEAN dis, XAsyncBlock *ab)
{
    (void)iface; (void)sc; (void)tok; (void)sids; (void)cnt; (void)dis;
    return xgr_async_begin(ab, NULL, NULL, "XStoreShowRedeemTokenUIAsync", store_noop_provider);
}
static HRESULT WINAPI xs_XStoreShowRedeemTokenUIResult(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}

static HRESULT WINAPI xs_XStoreQueryGameAndDlcPackageUpdatesAsync(void *iface, const XStoreContextHandle sc, XAsyncBlock *ab)
{
    (void)iface; (void)sc;
    return xgr_async_begin(ab, NULL, NULL, "XStoreQueryGameAndDlcPackageUpdatesAsync", store_noop_provider);
}
static HRESULT WINAPI xs_XStoreQueryGameAndDlcPackageUpdatesResultCount(void *iface, XAsyncBlock *ab, uint32_t *count)
{
    (void)iface;
    HRESULT hr = xgr_async_get_status(ab, false);
    if (FAILED(hr)) return hr;
    if (count) *count = 0;
    return S_OK;
}
static HRESULT WINAPI xs_XStoreQueryGameAndDlcPackageUpdatesResult(void *iface, XAsyncBlock *ab, uint32_t count, XStorePackageUpdate *updates)
{
    (void)iface; (void)count; (void)updates;
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}

static HRESULT WINAPI xs_XStoreDownloadPackageUpdatesAsync(void *iface, const XStoreContextHandle sc, const char **pkgs, SIZE_T cnt, XAsyncBlock *ab)
{
    (void)iface; (void)sc; (void)pkgs; (void)cnt;
    return xgr_async_begin(ab, NULL, NULL, "XStoreDownloadPackageUpdatesAsync", store_noop_provider);
}
static HRESULT WINAPI xs_XStoreDownloadPackageUpdatesResult(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}

static HRESULT WINAPI xs_XStoreDownloadAndInstallPackageUpdatesAsync(void *iface, const XStoreContextHandle sc, const char **pkgs, SIZE_T cnt, XAsyncBlock *ab)
{
    (void)iface; (void)sc; (void)pkgs; (void)cnt;
    return xgr_async_begin(ab, NULL, NULL, "XStoreDownloadAndInstallPackageUpdatesAsync", store_noop_provider);
}
static HRESULT WINAPI xs_XStoreDownloadAndInstallPackageUpdatesResult(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}

static HRESULT WINAPI xs_XStoreDownloadAndInstallPackagesAsync(void *iface, const XStoreContextHandle sc, const char **sids, SIZE_T cnt, XAsyncBlock *ab)
{
    (void)iface; (void)sc; (void)sids; (void)cnt;
    return xgr_async_begin(ab, NULL, NULL, "XStoreDownloadAndInstallPackagesAsync", store_noop_provider);
}
static HRESULT WINAPI xs_XStoreDownloadAndInstallPackagesResultCount(void *iface, XAsyncBlock *ab, uint32_t *count)
{
    (void)iface;
    HRESULT hr = xgr_async_get_status(ab, false);
    if (FAILED(hr)) return hr;
    if (count) *count = 0;
    return S_OK;
}
static HRESULT WINAPI xs_XStoreDownloadAndInstallPackagesResult(void *iface, XAsyncBlock *ab, uint32_t count, char **pkgs)
{
    (void)iface; (void)count; (void)pkgs;
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}

static HRESULT WINAPI xs_XStoreQueryPackageIdentifier(void *iface, const char *storeId, SIZE_T size, char *pkgId)
{
    (void)iface;
    if (!storeId || !storeId[0] || !pkgId) return E_INVALIDARG;
    if (size < XGR_PACKAGE_IDENTIFIER_MAX_LEN) return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
    if (xgr_package_find_identifier_by_store_id(storeId, pkgId, size)) {
        return S_OK;
    }
    struct xgr_runtime_config_snapshot cfg;
    xgr_copy_runtime_config_snapshot(&cfg);
    if (!cfg.storeId[0] && cfg.packageIdentifier[0]) {
        snprintf(pkgId, size, "%s", cfg.packageIdentifier);
        return S_OK;
    }
    return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
}

static HRESULT WINAPI xs_XStoreRegisterGameLicenseChanged(void *iface, XStoreContextHandle sc, XTaskQueueHandle q, void *ctx, void *cb, XTaskQueueRegistrationToken *tok)
{
    (void)iface; (void)sc; (void)q; (void)ctx; (void)cb;
    if (!tok) return E_INVALIDARG;
    tok->token = InterlockedIncrement64((volatile LONGLONG *)&g_next_store_reg_token);
    return S_OK;
}
static BOOLEAN WINAPI xs_XStoreUnregisterGameLicenseChanged(void *iface, XStoreContextHandle sc, XTaskQueueRegistrationToken tok, BOOLEAN wait)
{
    (void)iface; (void)sc; (void)tok; (void)wait;
    return TRUE;
}
static HRESULT WINAPI xs_XStoreRegisterPackageLicenseLost(void *iface, XStoreLicenseHandle lic, XTaskQueueHandle q, void *ctx, void *cb, XTaskQueueRegistrationToken *tok)
{
    (void)iface; (void)lic; (void)q; (void)ctx; (void)cb;
    if (!tok) return E_INVALIDARG;
    tok->token = InterlockedIncrement64((volatile LONGLONG *)&g_next_store_reg_token);
    return S_OK;
}
static BOOLEAN WINAPI xs_XStoreUnregisterPackageLicenseLost(void *iface, XStoreLicenseHandle lic, XTaskQueueRegistrationToken tok, BOOLEAN wait)
{
    (void)iface; (void)lic; (void)tok; (void)wait;
    return TRUE;
}

/* IXStoreImpl2 */
static BOOLEAN WINAPI xs_XStoreIsAvailabilityPurchasable(void *iface, const XStoreAvailability avail)
{
    (void)iface; (void)avail;
    return FALSE;
}

/* IXStoreImpl3 */
static HRESULT WINAPI xs_XStoreAcquireLicenseForDurablesAsync(void *iface, const XStoreContextHandle sc, const char *storeId, XAsyncBlock *async)
{
    (void)iface; (void)sc;
    if (!storeId || !async) return E_INVALIDARG;
    struct acquire_lic_ctx *ctx = (struct acquire_lic_ctx *)calloc(1, sizeof(*ctx));
    if (!ctx) return E_OUTOFMEMORY;
    snprintf(ctx->id, sizeof(ctx->id), "%s", storeId);
    HRESULT hr = xgr_async_begin(async, ctx, (const void *)xs_XStoreAcquireLicenseForDurablesAsync, "XStoreAcquireLicenseForDurablesAsync", acquire_lic_provider);
    if (FAILED(hr)) free(ctx);
    return xgr_return_hr(hr);
}
static HRESULT WINAPI xs_XStoreAcquireLicenseForDurablesResult(void *iface, XAsyncBlock *async, XStoreLicenseHandle *out)
{
    (void)iface;
    if (!out) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreAcquireLicenseForDurablesAsync, sizeof(*out), out, NULL));
}

/* IXStoreImpl4 */
static HRESULT WINAPI xs_XStoreShowAssociatedProductsUIAsync(void *iface, const XStoreContextHandle sc, const char *sid, uint32_t kinds, XAsyncBlock *ab)
{
    (void)iface; (void)sc; (void)sid; (void)kinds;
    return xgr_async_begin(ab, NULL, NULL, "XStoreShowAssociatedProductsUIAsync", store_noop_provider);
}
static HRESULT WINAPI xs_XStoreShowAssociatedProductsUIResult(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}
static HRESULT WINAPI xs_XStoreShowProductPageUIAsync(void *iface, const XStoreContextHandle sc, const char *sid, XAsyncBlock *ab)
{
    (void)iface; (void)sc; (void)sid;
    return xgr_async_begin(ab, NULL, NULL, "XStoreShowProductPageUIAsync", store_noop_provider);
}
static HRESULT WINAPI xs_XStoreShowProductPageUIResult(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}

/* IXStoreImpl5 */
static HRESULT WINAPI xs_XStoreQueryAssociatedProductsForStoreIdAsync(void *iface, const XStoreContextHandle sc, const char *sid, uint32_t kinds, uint32_t maxItems, XAsyncBlock *async)
{
    (void)iface; (void)sc;
    if (!sid || !sid[0] || !async) return E_INVALIDARG;
    XgrStrBuf sb;
    xgr_sb_init(&sb);
    xgr_sb_append_cstr(&sb, "{\"storeId\":");
    xgr_sb_append_json_str(&sb, sid);
    xgr_sb_append_fmt(&sb, ",\"productKinds\":%u,\"maxItems\":%u}", kinds, maxItems);
    char *p = xgr_sb_detach(&sb);
    if (!p) return E_OUTOFMEMORY;
    return start_product_query_async("xstore.queryAssociatedProducts", p, (const void *)xs_XStoreQueryAssociatedProductsForStoreIdAsync, "XStoreQueryAssociatedProductsForStoreIdAsync", async);
}
static HRESULT WINAPI xs_XStoreQueryAssociatedProductsForStoreIdResult(void *iface, XAsyncBlock *async, XStoreProductQueryHandle *out)
{
    (void)iface;
    if (!out) return E_INVALIDARG;
    return xgr_return_hr(xgr_async_get_result(async, (const void *)xs_XStoreQueryAssociatedProductsForStoreIdAsync, sizeof(*out), out, NULL));
}
static HRESULT WINAPI xs_XStoreQueryPackageUpdatesAsync(void *iface, XStoreContextHandle sc, const char **pkgs, SIZE_T cnt, XAsyncBlock *ab)
{
    (void)iface; (void)sc; (void)pkgs; (void)cnt;
    return xgr_async_begin(ab, NULL, NULL, "XStoreQueryPackageUpdatesAsync", store_noop_provider);
}
static HRESULT WINAPI xs_XStoreQueryPackageUpdatesResultCount(void *iface, XAsyncBlock *ab, uint32_t *count)
{
    (void)iface;
    HRESULT hr = xgr_async_get_status(ab, false);
    if (FAILED(hr)) return hr;
    if (count) *count = 0;
    return S_OK;
}
static HRESULT WINAPI xs_XStoreQueryPackageUpdatesResult(void *iface, XAsyncBlock *ab, uint32_t count, XStorePackageUpdate *updates)
{
    (void)iface; (void)count; (void)updates;
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}

/* IXStoreImpl6 */
static HRESULT WINAPI xs_XStoreShowGiftingUIAsync(void *iface, XStoreContextHandle sc, const char *sid, const char *name, const char *ext, XAsyncBlock *ab)
{
    (void)iface; (void)sc; (void)sid; (void)name; (void)ext;
    return xgr_async_begin(ab, NULL, NULL, "XStoreShowGiftingUIAsync", store_noop_provider);
}
static HRESULT WINAPI xs_XStoreShowGiftingUIResult(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    return xgr_async_get_result(ab, NULL, 0, NULL, NULL);
}

typedef struct IXStoreImpl6Vtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);
    ULONG   (WINAPI *AddRef)(void *iface);
    ULONG   (WINAPI *Release)(void *iface);
    HRESULT (WINAPI *XStoreCreateContext)(void *iface, const XUserHandle user, XStoreContextHandle *out);
    void    (WINAPI *XStoreCloseContextHandle)(void *iface, XStoreContextHandle ctx);
    HRESULT (WINAPI *XStoreQueryAssociatedProductsAsync)(void *iface, const XStoreContextHandle sc, uint32_t kinds, uint32_t maxItems, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreQueryAssociatedProductsResult)(void *iface, XAsyncBlock *async, XStoreProductQueryHandle *out);
    HRESULT (WINAPI *XStoreQueryProductsAsync)(void *iface, const XStoreContextHandle sc, uint32_t kinds, const char **storeIds, SIZE_T storeIdsCount, const char **actionFilters, SIZE_T actionFiltersCount, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreQueryProductsResult)(void *iface, XAsyncBlock *async, XStoreProductQueryHandle *out);
    HRESULT (WINAPI *XStoreQueryEntitledProductsAsync)(void *iface, const XStoreContextHandle sc, uint32_t kinds, uint32_t maxItems, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreQueryEntitledProductsResult)(void *iface, XAsyncBlock *async, XStoreProductQueryHandle *out);
    HRESULT (WINAPI *XStoreQueryProductForCurrentGameAsync)(void *iface, const XStoreContextHandle sc, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreQueryProductForCurrentGameResult)(void *iface, XAsyncBlock *async, XStoreProductQueryHandle *out);
    HRESULT (WINAPI *XStoreQueryProductForPackageAsync)(void *iface, const XStoreContextHandle sc, uint32_t kinds, const char *pkgId, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreQueryProductForPackageResult)(void *iface, XAsyncBlock *async, XStoreProductQueryHandle *out);
    HRESULT (WINAPI *XStoreEnumerateProductsQuery)(void *iface, const XStoreProductQueryHandle q, void *context, XStoreProductQueryCallback *cb);
    BOOLEAN (WINAPI *XStoreProductsQueryHasMorePages)(void *iface, const XStoreProductQueryHandle q);
    HRESULT (WINAPI *XStoreProductsQueryNextPageAsync)(void *iface, const XStoreProductQueryHandle q, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreProductsQueryNextPageResult)(void *iface, XAsyncBlock *async, XStoreProductQueryHandle *out);
    void    (WINAPI *XStoreCloseProductsQueryHandle)(void *iface, XStoreProductQueryHandle q);
    HRESULT (WINAPI *XStoreAcquireLicenseForPackageAsync)(void *iface, const void *handle, const char *pkgId, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreAcquireLicenseForPackageResult)(void *iface, XAsyncBlock *async, XStoreLicenseHandle *out);
    BOOLEAN (WINAPI *XStoreIsLicenseValid)(void *iface, const XStoreLicenseHandle lic);
    void    (WINAPI *XStoreCloseLicenseHandle)(void *iface, XStoreLicenseHandle lic);
    HRESULT (WINAPI *XStoreCanAcquireLicenseForStoreIdAsync)(void *iface, const XStoreContextHandle sc, const char *storeId, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreCanAcquireLicenseForStoreIdResult)(void *iface, XAsyncBlock *async, void *out);
    HRESULT (WINAPI *XStoreCanAcquireLicenseForPackageAsync)(void *iface, const XStoreContextHandle sc, const char *pkgId, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreCanAcquireLicenseForPackageResult)(void *iface, XAsyncBlock *async, void *out);
    HRESULT (WINAPI *XStoreQueryGameLicenseAsync)(void *iface, const XStoreContextHandle sc, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreQueryGameLicenseResult)(void *iface, XAsyncBlock *async, XStoreGameLicense *lic);
    HRESULT (WINAPI *XStoreQueryAddOnLicensesAsync)(void *iface, const XStoreContextHandle sc, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreQueryAddOnLicensesResultCount)(void *iface, XAsyncBlock *async, uint32_t *count);
    HRESULT (WINAPI *XStoreQueryAddOnLicensesResult)(void *iface, XAsyncBlock *async, uint32_t count, XStoreAddonLicense *out);
    HRESULT (WINAPI *XStoreQueryConsumableBalanceRemainingAsync)(void *iface, const XStoreContextHandle sc, const char *pid, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreQueryConsumableBalanceRemainingResult)(void *iface, XAsyncBlock *async, uint32_t *qty);
    HRESULT (WINAPI *XStoreReportConsumableFulfillmentAsync)(void *iface, const XStoreContextHandle sc, const char *pid, uint32_t qty, GUID trackingId, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreReportConsumableFulfillmentResult)(void *iface, XAsyncBlock *async, uint32_t *qty);
    HRESULT (WINAPI *XStoreGetUserCollectionsIdAsync)(void *iface, const XStoreContextHandle sc, const char *ticket, const char *pubUid, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreGetUserCollectionsIdResultSize)(void *iface, XAsyncBlock *async, size_t *size);
    HRESULT (WINAPI *XStoreGetUserCollectionsIdResult)(void *iface, XAsyncBlock *async, size_t size, char *result);
    HRESULT (WINAPI *XStoreGetUserPurchaseIdAsync)(void *iface, const XStoreContextHandle sc, const char *ticket, const char *pubUid, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreGetUserPurchaseIdResultSize)(void *iface, XAsyncBlock *async, size_t *size);
    HRESULT (WINAPI *XStoreGetUserPurchaseIdResult)(void *iface, XAsyncBlock *async, size_t size, char *result);
    HRESULT (WINAPI *XStoreQueryLicenseTokenAsync)(void *iface, const XStoreContextHandle sc, const char **pids, size_t cnt, const char *devStr, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreQueryLicenseTokenResultSize)(void *iface, XAsyncBlock *async, size_t *size);
    HRESULT (WINAPI *XStoreQueryLicenseTokenResult)(void *iface, XAsyncBlock *async, size_t size, char *result);
    HRESULT (WINAPI *XStoreSendRequestAsync)(void *iface, const XStoreContextHandle sc, const char *interfaceName, uint32_t requestId, const char *requestData, size_t requestDataSize, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreSendRequestResultSize)(void *iface, XAsyncBlock *async, size_t *size);
    HRESULT (WINAPI *XStoreSendRequestResult)(void *iface, XAsyncBlock *async, size_t size, char *result, size_t *used);
    HRESULT (WINAPI *XStoreShowPurchaseUIAsync)(void *iface, const XStoreContextHandle sc, const char *sid, const char *name, const char *ext, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreShowPurchaseUIResult)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreShowRateAndReviewUIAsync)(void *iface, const XStoreContextHandle sc, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreShowRateAndReviewUIResult)(void *iface, XAsyncBlock *ab, uint8_t *wasUpdated);
    HRESULT (WINAPI *XStoreShowRedeemTokenUIAsync)(void *iface, const XStoreContextHandle sc, const char *tok, const char **sids, SIZE_T cnt, BOOLEAN dis, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreShowRedeemTokenUIResult)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreQueryGameAndDlcPackageUpdatesAsync)(void *iface, const XStoreContextHandle sc, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreQueryGameAndDlcPackageUpdatesResultCount)(void *iface, XAsyncBlock *ab, uint32_t *count);
    HRESULT (WINAPI *XStoreQueryGameAndDlcPackageUpdatesResult)(void *iface, XAsyncBlock *ab, uint32_t count, XStorePackageUpdate *updates);
    HRESULT (WINAPI *XStoreDownloadPackageUpdatesAsync)(void *iface, const XStoreContextHandle sc, const char **pkgs, SIZE_T cnt, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreDownloadPackageUpdatesResult)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreDownloadAndInstallPackageUpdatesAsync)(void *iface, const XStoreContextHandle sc, const char **pkgs, SIZE_T cnt, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreDownloadAndInstallPackageUpdatesResult)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreDownloadAndInstallPackagesAsync)(void *iface, const XStoreContextHandle sc, const char **sids, SIZE_T cnt, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreDownloadAndInstallPackagesResultCount)(void *iface, XAsyncBlock *ab, uint32_t *count);
    HRESULT (WINAPI *XStoreDownloadAndInstallPackagesResult)(void *iface, XAsyncBlock *ab, uint32_t count, char **pkgs);
    HRESULT (WINAPI *XStoreQueryPackageIdentifier)(void *iface, const char *storeId, SIZE_T size, char *pkgId);
    HRESULT (WINAPI *XStoreRegisterGameLicenseChanged)(void *iface, XStoreContextHandle sc, XTaskQueueHandle q, void *ctx, void *cb, XTaskQueueRegistrationToken *tok);
    BOOLEAN (WINAPI *XStoreUnregisterGameLicenseChanged)(void *iface, XStoreContextHandle sc, XTaskQueueRegistrationToken tok, BOOLEAN wait);
    HRESULT (WINAPI *XStoreRegisterPackageLicenseLost)(void *iface, XStoreLicenseHandle lic, XTaskQueueHandle q, void *ctx, void *cb, XTaskQueueRegistrationToken *tok);
    BOOLEAN (WINAPI *XStoreUnregisterPackageLicenseLost)(void *iface, XStoreLicenseHandle lic, XTaskQueueRegistrationToken tok, BOOLEAN wait);
    /* IXStoreImpl2 */
    BOOLEAN (WINAPI *XStoreIsAvailabilityPurchasable)(void *iface, const XStoreAvailability avail);
    /* IXStoreImpl3 */
    HRESULT (WINAPI *XStoreAcquireLicenseForDurablesAsync)(void *iface, const XStoreContextHandle sc, const char *storeId, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreAcquireLicenseForDurablesResult)(void *iface, XAsyncBlock *async, XStoreLicenseHandle *out);
    /* IXStoreImpl4 */
    HRESULT (WINAPI *XStoreShowAssociatedProductsUIAsync)(void *iface, const XStoreContextHandle sc, const char *sid, uint32_t kinds, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreShowAssociatedProductsUIResult)(void *iface, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreShowProductPageUIAsync)(void *iface, const XStoreContextHandle sc, const char *sid, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreShowProductPageUIResult)(void *iface, XAsyncBlock *ab);
    /* IXStoreImpl5 */
    HRESULT (WINAPI *XStoreQueryAssociatedProductsForStoreIdAsync)(void *iface, const XStoreContextHandle sc, const char *sid, uint32_t kinds, uint32_t maxItems, XAsyncBlock *async);
    HRESULT (WINAPI *XStoreQueryAssociatedProductsForStoreIdResult)(void *iface, XAsyncBlock *async, XStoreProductQueryHandle *out);
    HRESULT (WINAPI *XStoreQueryPackageUpdatesAsync)(void *iface, XStoreContextHandle sc, const char **pkgs, SIZE_T cnt, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreQueryPackageUpdatesResultCount)(void *iface, XAsyncBlock *ab, uint32_t *count);
    HRESULT (WINAPI *XStoreQueryPackageUpdatesResult)(void *iface, XAsyncBlock *ab, uint32_t count, XStorePackageUpdate *updates);
    /* IXStoreImpl6 */
    HRESULT (WINAPI *XStoreShowGiftingUIAsync)(void *iface, XStoreContextHandle sc, const char *sid, const char *name, const char *ext, XAsyncBlock *ab);
    HRESULT (WINAPI *XStoreShowGiftingUIResult)(void *iface, XAsyncBlock *ab);
} IXStoreImpl6Vtbl;
_Static_assert(sizeof(IXStoreImpl6Vtbl) == 84 * sizeof(void *), "IXStoreImpl6Vtbl must have 84 slots");

static const IXStoreImpl6Vtbl g_xstore6_vtbl = {
    xs_QueryInterface,                                        /* 0 */
    xs_AddRef,                                                /* 1 */
    xs_Release,                                               /* 2 */
    xs_XStoreCreateContext,                                   /* 3 */
    xs_XStoreCloseContextHandle,                              /* 4 */
    xs_XStoreQueryAssociatedProductsAsync,                    /* 5 */
    xs_XStoreQueryAssociatedProductsResult,                   /* 6 */
    xs_XStoreQueryProductsAsync,                              /* 7 */
    xs_XStoreQueryProductsResult,                             /* 8 */
    xs_XStoreQueryEntitledProductsAsync,                      /* 9 */
    xs_XStoreQueryEntitledProductsResult,                     /* 10 */
    xs_XStoreQueryProductForCurrentGameAsync,                 /* 11 */
    xs_XStoreQueryProductForCurrentGameResult,                /* 12 */
    xs_XStoreQueryProductForPackageAsync,                     /* 13 */
    xs_XStoreQueryProductForPackageResult,                    /* 14 */
    xs_XStoreEnumerateProductsQuery,                          /* 15 */
    xs_XStoreProductsQueryHasMorePages,                       /* 16 */
    xs_XStoreProductsQueryNextPageAsync,                      /* 17 */
    xs_XStoreProductsQueryNextPageResult,                     /* 18 */
    xs_XStoreCloseProductsQueryHandle,                        /* 19 */
    xs_XStoreAcquireLicenseForPackageAsync,                   /* 20 */
    xs_XStoreAcquireLicenseForPackageResult,                  /* 21 */
    xs_XStoreIsLicenseValid,                                  /* 22 */
    xs_XStoreCloseLicenseHandle,                              /* 23 */
    xs_XStoreCanAcquireLicenseForStoreIdAsync,                /* 24 */
    xs_XStoreCanAcquireLicenseForStoreIdResult,               /* 25 */
    xs_XStoreCanAcquireLicenseForPackageAsync,                /* 26 */
    xs_XStoreCanAcquireLicenseForPackageResult,               /* 27 */
    xs_XStoreQueryGameLicenseAsync,                           /* 28 */
    xs_XStoreQueryGameLicenseResult,                          /* 29 */
    xs_XStoreQueryAddOnLicensesAsync,                         /* 30 */
    xs_XStoreQueryAddOnLicensesResultCount,                   /* 31 */
    xs_XStoreQueryAddOnLicensesResult,                        /* 32 */
    xs_XStoreQueryConsumableBalanceRemainingAsync,            /* 33 */
    xs_XStoreQueryConsumableBalanceRemainingResult,           /* 34 */
    xs_XStoreReportConsumableFulfillmentAsync,                /* 35 */
    xs_XStoreReportConsumableFulfillmentResult,               /* 36 */
    xs_XStoreGetUserCollectionsIdAsync,                       /* 37 */
    xs_XStoreGetUserCollectionsIdResultSize,                  /* 38 */
    xs_XStoreGetUserCollectionsIdResult,                      /* 39 */
    xs_XStoreGetUserPurchaseIdAsync,                          /* 40 */
    xs_XStoreGetUserPurchaseIdResultSize,                     /* 41 */
    xs_XStoreGetUserPurchaseIdResult,                         /* 42 */
    xs_XStoreQueryLicenseTokenAsync,                          /* 43 */
    xs_XStoreQueryLicenseTokenResultSize,                     /* 44 */
    xs_XStoreQueryLicenseTokenResult,                         /* 45 */
    xs_XStoreSendRequestAsync,                                /* 46 */
    xs_XStoreSendRequestResultSize,                           /* 47 */
    xs_XStoreSendRequestResult,                               /* 48 */
    xs_XStoreShowPurchaseUIAsync,                             /* 49 */
    xs_XStoreShowPurchaseUIResult,                            /* 50 */
    xs_XStoreShowRateAndReviewUIAsync,                        /* 51 */
    xs_XStoreShowRateAndReviewUIResult,                       /* 52 */
    xs_XStoreShowRedeemTokenUIAsync,                          /* 53 */
    xs_XStoreShowRedeemTokenUIResult,                         /* 54 */
    xs_XStoreQueryGameAndDlcPackageUpdatesAsync,              /* 55 */
    xs_XStoreQueryGameAndDlcPackageUpdatesResultCount,        /* 56 */
    xs_XStoreQueryGameAndDlcPackageUpdatesResult,             /* 57 */
    xs_XStoreDownloadPackageUpdatesAsync,                     /* 58 */
    xs_XStoreDownloadPackageUpdatesResult,                    /* 59 */
    xs_XStoreDownloadAndInstallPackageUpdatesAsync,           /* 60 */
    xs_XStoreDownloadAndInstallPackageUpdatesResult,          /* 61 */
    xs_XStoreDownloadAndInstallPackagesAsync,                 /* 62 */
    xs_XStoreDownloadAndInstallPackagesResultCount,           /* 63 */
    xs_XStoreDownloadAndInstallPackagesResult,                /* 64 */
    xs_XStoreQueryPackageIdentifier,                          /* 65 */
    xs_XStoreRegisterGameLicenseChanged,                      /* 66 */
    xs_XStoreUnregisterGameLicenseChanged,                    /* 67 */
    xs_XStoreRegisterPackageLicenseLost,                      /* 68 */
    xs_XStoreUnregisterPackageLicenseLost,                    /* 69 */
    /* IXStoreImpl2 */
    xs_XStoreIsAvailabilityPurchasable,                       /* 70 */
    /* IXStoreImpl3 */
    xs_XStoreAcquireLicenseForDurablesAsync,                  /* 71 */
    xs_XStoreAcquireLicenseForDurablesResult,                 /* 72 */
    /* IXStoreImpl4 */
    xs_XStoreShowAssociatedProductsUIAsync,                   /* 73 */
    xs_XStoreShowAssociatedProductsUIResult,                  /* 74 */
    xs_XStoreShowProductPageUIAsync,                          /* 75 */
    xs_XStoreShowProductPageUIResult,                         /* 76 */
    /* IXStoreImpl5 */
    xs_XStoreQueryAssociatedProductsForStoreIdAsync,          /* 77 */
    xs_XStoreQueryAssociatedProductsForStoreIdResult,         /* 78 */
    xs_XStoreQueryPackageUpdatesAsync,                        /* 79 */
    xs_XStoreQueryPackageUpdatesResultCount,                  /* 80 */
    xs_XStoreQueryPackageUpdatesResult,                       /* 81 */
    /* IXStoreImpl6 */
    xs_XStoreShowGiftingUIAsync,                              /* 82 */
    xs_XStoreShowGiftingUIResult                              /* 83 */
};

static struct { const IXStoreImpl6Vtbl *lpVtbl; } g_xstore_singleton = { &g_xstore6_vtbl };

HRESULT xgr_query_store(REFIID iid, void **ppv)
{
    return xs_QueryInterface(&g_xstore_singleton, iid, ppv);
}
