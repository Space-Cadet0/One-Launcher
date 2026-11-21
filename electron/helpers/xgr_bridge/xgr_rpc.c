/*
 * One Launcher XGR Bridge — Authenticated 127.0.0.1 Loopback RPC Client & JSON/Base64 Codec
 * Wire format: [u32 lengthLE][UTF-8 JSON]
 *
 * Hardened in Wave 1B:
 * - Overflow-safe `XgrStrBuf` dynamic JSON/string builder (`SIZE_MAX / 2` guard).
 * - Persistent `CRITICAL_SECTION`-protected loopback `SOCKET` with `TCP_NODELAY`,
 *   4 KiB pre-auth handshake unlock, and transparent 1-retry stale-socket reconnect.
 * - Bounds-checked `\uXXXX` + UTF-16 surrogate pair -> UTF-8 JSON string decoder.
 * - Wide `GetEnvironmentVariableW` -> UTF-8 environment reader (`xgr_get_env_utf8`).
 */

#include "xgr_internal.h"
#include <ctype.h>
#include <errno.h>
#ifndef _WIN32
#include <sys/select.h>
#endif

static volatile LONG g_rpc_seq = 1;
static INIT_ONCE g_rpc_once = INIT_ONCE_STATIC_INIT;
static volatile LONG g_rpc_cs_ready = 0;
static CRITICAL_SECTION g_rpc_cs;
static bool g_wsa_ok = false;

static SOCKET g_rpc_sock = INVALID_SOCKET;
static uint16_t g_rpc_sock_port = 0;
static char g_rpc_sock_key[65] = { 0 };
static bool g_rpc_sock_authed = false;

/* -------------------------------------------------------------------------
 * Growable Overflow-Safe String & JSON Builder (`XgrStrBuf`)
 * ------------------------------------------------------------------------- */

void xgr_sb_init(XgrStrBuf *sb)
{
    if (!sb) return;
    sb->buf = NULL;
    sb->len = 0;
    sb->cap = 0;
    sb->failed = false;
}

bool xgr_sb_reserve(XgrStrBuf *sb, size_t extra)
{
    if (!sb || sb->failed) return false;
    if (extra > SIZE_MAX - sb->len - 1) {
        sb->failed = true;
        return false;
    }
    size_t needed = sb->len + extra + 1;
    if (needed <= sb->cap) return true;

    size_t ncap = sb->cap ? sb->cap : 128;
    while (ncap < needed) {
        if (ncap > SIZE_MAX / 2) {
            ncap = needed;
            break;
        }
        ncap *= 2;
    }

    char *nbuf = (char *)realloc(sb->buf, ncap);
    if (!nbuf) {
        sb->failed = true;
        return false;
    }
    sb->buf = nbuf;
    sb->cap = ncap;
    sb->buf[sb->len] = '\0';
    return true;
}

bool xgr_sb_append_len(XgrStrBuf *sb, const char *str, size_t n)
{
    if (n > 0 && !str) {
        if (sb) sb->failed = true;
        return false;
    }
    if (!xgr_sb_reserve(sb, n)) return false;
    if (n > 0) {
        memcpy(sb->buf + sb->len, str, n);
    }
    sb->len += n;
    sb->buf[sb->len] = '\0';
    return true;
}

bool xgr_sb_append_cstr(XgrStrBuf *sb, const char *str)
{
    if (!str) return xgr_sb_append_len(sb, "", 0);
    return xgr_sb_append_len(sb, str, strlen(str));
}

bool xgr_sb_append_char(XgrStrBuf *sb, char c)
{
    return xgr_sb_append_len(sb, &c, 1);
}

bool xgr_sb_append_json_str(XgrStrBuf *sb, const char *raw)
{
    if (!raw) raw = "";
    size_t len = strlen(raw);
    if (len <= (SIZE_MAX - 16) / 2) {
        if (!xgr_sb_reserve(sb, len + 2)) return false;
    }
    if (!xgr_sb_append_char(sb, '"')) return false;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)raw[i];
        switch (c) {
            case '"':  if (!xgr_sb_append_len(sb, "\\\"", 2)) return false; break;
            case '\\': if (!xgr_sb_append_len(sb, "\\\\", 2)) return false; break;
            case '\b': if (!xgr_sb_append_len(sb, "\\b", 2)) return false; break;
            case '\f': if (!xgr_sb_append_len(sb, "\\f", 2)) return false; break;
            case '\n': if (!xgr_sb_append_len(sb, "\\n", 2)) return false; break;
            case '\r': if (!xgr_sb_append_len(sb, "\\r", 2)) return false; break;
            case '\t': if (!xgr_sb_append_len(sb, "\\t", 2)) return false; break;
            default:
                if (c < 0x20) {
                    char uesc[7];
                    snprintf(uesc, sizeof(uesc), "\\u%04x", (unsigned int)c);
                    if (!xgr_sb_append_len(sb, uesc, 6)) return false;
                } else {
                    if (!xgr_sb_append_char(sb, (char)c)) return false;
                }
                break;
        }
    }
    return xgr_sb_append_char(sb, '"');
}

bool xgr_sb_append_fmt(XgrStrBuf *sb, const char *fmt, ...)
{
    if (!sb || sb->failed || !fmt) return false;
    char stack_buf[256];
    va_list ap, ap2;
    va_start(ap, fmt);
    va_copy(ap2, ap);
    int n = vsnprintf(stack_buf, sizeof(stack_buf), fmt, ap);
    va_end(ap);

    if (n < 0) {
        va_end(ap2);
        sb->failed = true;
        return false;
    }
    if ((size_t)n < sizeof(stack_buf)) {
        va_end(ap2);
        return xgr_sb_append_len(sb, stack_buf, (size_t)n);
    }
    if (!xgr_sb_reserve(sb, (size_t)n)) {
        va_end(ap2);
        return false;
    }
    int n2 = vsnprintf(sb->buf + sb->len, (size_t)n + 1, fmt, ap2);
    va_end(ap2);
    if (n2 < 0) {
        sb->failed = true;
        return false;
    }
    size_t written = (n2 > n) ? (size_t)n : (size_t)n2;
    sb->len += written;
    sb->buf[sb->len] = '\0';
    return true;
}

char *xgr_sb_detach(XgrStrBuf *sb)
{
    if (!sb) return NULL;
    if (sb->failed) {
        free(sb->buf);
        xgr_sb_init(sb);
        return NULL;
    }
    if (!sb->buf) {
        char *empty = (char *)calloc(1, 1);
        return empty;
    }
    char *res = sb->buf;
    xgr_sb_init(sb);
    return res;
}

void xgr_sb_free(XgrStrBuf *sb)
{
    if (!sb) return;
    if (sb->buf) {
        free(sb->buf);
    }
    xgr_sb_init(sb);
}

char *xgr_json_escape_alloc(const char *raw)
{
    if (!raw) raw = "";
    XgrStrBuf sb;
    xgr_sb_init(&sb);
    size_t len = strlen(raw);
    if (len <= (SIZE_MAX - 8) / 2) {
        (void)xgr_sb_reserve(&sb, len);
    }
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)raw[i];
        switch (c) {
            case '"':  xgr_sb_append_len(&sb, "\\\"", 2); break;
            case '\\': xgr_sb_append_len(&sb, "\\\\", 2); break;
            case '\b': xgr_sb_append_len(&sb, "\\b", 2); break;
            case '\f': xgr_sb_append_len(&sb, "\\f", 2); break;
            case '\n': xgr_sb_append_len(&sb, "\\n", 2); break;
            case '\r': xgr_sb_append_len(&sb, "\\r", 2); break;
            case '\t': xgr_sb_append_len(&sb, "\\t", 2); break;
            default:
                if (c < 0x20) {
                    char uesc[7];
                    snprintf(uesc, sizeof(uesc), "\\u%04x", (unsigned int)c);
                    xgr_sb_append_len(&sb, uesc, 6);
                } else {
                    xgr_sb_append_char(&sb, (char)c);
                }
                break;
        }
    }
    return xgr_sb_detach(&sb);
}

/* -------------------------------------------------------------------------
 * Wide Environment Reader (`GetEnvironmentVariableW` -> UTF-8)
 * ------------------------------------------------------------------------- */

static int hex_nibble(char c);

bool xgr_get_env_utf8(const WCHAR *name, char *out_buf, size_t out_cap)
{
    if (!out_buf || out_cap == 0) return false;
    out_buf[0] = '\0';
    /* Reject out_cap < 2: passing cbMultiByte == 0 to WideCharToMultiByte queries length without writing! */
    if (out_cap < 2 || !name || !*name) return false;

    int mb_cap = (out_cap - 1 > (size_t)INT_MAX) ? INT_MAX : (int)(out_cap - 1);
    WCHAR stack_w[512];
    DWORD wlen = GetEnvironmentVariableW(name, stack_w, (DWORD)(sizeof(stack_w) / sizeof(stack_w[0])));
    if (wlen == 0) return false;

    if (wlen < (DWORD)(sizeof(stack_w) / sizeof(stack_w[0]))) {
        int u8 = WideCharToMultiByte(CP_UTF8, 0, stack_w, (int)wlen, out_buf, mb_cap, NULL, NULL);
        if (u8 <= 0 || (size_t)u8 >= out_cap) {
            out_buf[0] = '\0';
            return false;
        }
        out_buf[u8] = '\0';
        return true;
    }

    if (wlen > 32768) return false;
    WCHAR *heap_w = (WCHAR *)malloc(((size_t)wlen + 1) * sizeof(WCHAR));
    if (!heap_w) return false;
    DWORD got = GetEnvironmentVariableW(name, heap_w, wlen + 1);
    if (got == 0 || got > wlen) {
        free(heap_w);
        return false;
    }
    int u8 = WideCharToMultiByte(CP_UTF8, 0, heap_w, (int)got, out_buf, mb_cap, NULL, NULL);
    free(heap_w);
    if (u8 <= 0 || (size_t)u8 >= out_cap) {
        out_buf[0] = '\0';
        return false;
    }
    out_buf[u8] = '\0';
    return true;
}

static bool read_bridge_env(uint16_t *out_port, char out_key[65])
{
    char port_str[32] = { 0 };
    char key_buf[128] = { 0 };
    if (!xgr_get_env_utf8(L"ONE_XGR_PORT", port_str, sizeof(port_str))) return false;
    if (!xgr_get_env_utf8(L"ONE_XGR_KEY", key_buf, sizeof(key_buf))) return false;
    if (strlen(key_buf) != 64) {
        SecureZeroMemory(key_buf, sizeof(key_buf));
        return false;
    }
    for (size_t i = 0; i < 64; i++) {
        if (hex_nibble(key_buf[i]) < 0) {
            SecureZeroMemory(key_buf, sizeof(key_buf));
            return false;
        }
    }
    char *end = NULL;
    unsigned long p = strtoul(port_str, &end, 10);
    if (!p || p > 65535 || (end && *end != '\0')) {
        SecureZeroMemory(key_buf, sizeof(key_buf));
        return false;
    }
    memcpy(out_key, key_buf, 64);
    out_key[64] = '\0';
    SecureZeroMemory(key_buf, sizeof(key_buf));
    *out_port = (uint16_t)p;
    return true;
}

bool xgr_rpc_is_configured(void)
{
    uint16_t port = 0;
    char key[65];
    bool ok = read_bridge_env(&port, key);
    SecureZeroMemory(key, sizeof(key));
    return ok;
}

/* -------------------------------------------------------------------------
 * JSON Value & Unicode Escape Parser
 * ------------------------------------------------------------------------- */

static int hex_nibble(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static bool parse_hex4_strict(const char *s, uint32_t *out_val)
{
    uint32_t v = 0;
    for (int i = 0; i < 4; i++) {
        int nib = hex_nibble(s[i]);
        if (nib < 0) return false;
        v = (v << 4) | (uint32_t)nib;
    }
    *out_val = v;
    return true;
}

static bool append_utf8_codepoint(XgrStrBuf *sb, uint32_t cp)
{
    char u8[4];
    if (cp == 0) {
        /* Never inject embedded NUL into C strings */
        return xgr_sb_append_len(sb, "\xEF\xBF\xBD", 3);
    }
    if (cp <= 0x7Fu) {
        u8[0] = (char)cp;
        return xgr_sb_append_len(sb, u8, 1);
    }
    if (cp <= 0x7FFu) {
        u8[0] = (char)(0xC0u | (cp >> 6));
        u8[1] = (char)(0x80u | (cp & 0x3Fu));
        return xgr_sb_append_len(sb, u8, 2);
    }
    if (cp >= 0xD800u && cp <= 0xDFFFu) {
        cp = 0xFFFDu; /* Replace unpaired UTF-16 surrogate with U+FFFD */
    }
    if (cp <= 0xFFFFu) {
        u8[0] = (char)(0xE0u | (cp >> 12));
        u8[1] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
        u8[2] = (char)(0x80u | (cp & 0x3Fu));
        return xgr_sb_append_len(sb, u8, 3);
    }
    if (cp <= 0x10FFFFu) {
        u8[0] = (char)(0xF0u | (cp >> 18));
        u8[1] = (char)(0x80u | ((cp >> 12) & 0x3Fu));
        u8[2] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
        u8[3] = (char)(0x80u | (cp & 0x3Fu));
        return xgr_sb_append_len(sb, u8, 4);
    }
    return xgr_sb_append_len(sb, "\xEF\xBF\xBD", 3);
}

static const char *json_locate_key_value(const char *json, const char *key)
{
    if (!json || !key) return NULL;
    size_t key_len = strlen(key);

    const char *p = json;
    while (*p && isspace((unsigned char)*p)) p++;
    if (*p != '{') return NULL;

    int depth = 0;
    bool expect_key = false;

    while (*p) {
        char ch = *p;
        if (ch == '"') {
            const char *str_start = ++p;
            bool has_escape = false;
            while (*p && *p != '"') {
                if (*p == '\\') {
                    has_escape = true;
                    p++;
                    if (!*p) return NULL;
                }
                p++;
            }
            if (!*p) return NULL;
            const char *str_end = p;
            p++; /* consume closing '"' */

            if (depth == 1 && expect_key) {
                bool key_match = false;
                if (!has_escape) {
                    key_match = ((size_t)(str_end - str_start) == key_len) &&
                                (key_len == 0 || memcmp(str_start, key, key_len) == 0);
                } else {
                    size_t ki = 0;
                    const char *sp = str_start;
                    key_match = true;
                    while (sp < str_end) {
                        char kc = *sp++;
                        if (kc == '\\' && sp < str_end) {
                            char esc = *sp++;
                            switch (esc) {
                                case '"':  kc = '"'; break;
                                case '\\': kc = '\\'; break;
                                case '/':  kc = '/'; break;
                                case 'b':  kc = '\b'; break;
                                case 'f':  kc = '\f'; break;
                                case 'n':  kc = '\n'; break;
                                case 'r':  kc = '\r'; break;
                                case 't':  kc = '\t'; break;
                                default:   key_match = false; break;
                            }
                        }
                        if (!key_match || ki >= key_len || kc != key[ki]) {
                            key_match = false;
                            break;
                        }
                        ki++;
                    }
                    if (ki != key_len) key_match = false;
                }

                const char *after = p;
                while (*after && isspace((unsigned char)*after)) after++;
                if (*after == ':') {
                    p = after + 1;
                    expect_key = false;
                    if (key_match) {
                        while (*p && isspace((unsigned char)*p)) p++;
                        return p;
                    }
                    continue;
                }
            }
            continue;
        }

        if (ch == '{') {
            depth++;
            if (depth == 1) expect_key = true;
            p++;
            continue;
        }
        if (ch == '}') {
            depth--;
            p++;
            if (depth <= 0) break;
            continue;
        }
        if (ch == '[') {
            depth++;
            p++;
            continue;
        }
        if (ch == ']') {
            depth--;
            p++;
            if (depth <= 0) break;
            continue;
        }
        if (depth == 1) {
            if (ch == ',') {
                expect_key = true;
            } else if (ch == ':') {
                expect_key = false;
            }
        }
        p++;
    }
    return NULL;
}

char *xgr_json_alloc_string(const char *json, const char *key)
{
    const char *v = json_locate_key_value(json, key);
    if (!v || *v != '"') return NULL;
    v++;

    XgrStrBuf sb;
    xgr_sb_init(&sb);
    if (!xgr_sb_reserve(&sb, 64)) return NULL;

    while (*v && *v != '"') {
        unsigned char ch = (unsigned char)*v++;
        if (ch == '\\') {
            if (!*v) break;
            char esc = *v++;
            switch (esc) {
                case '"':  xgr_sb_append_char(&sb, '"'); break;
                case '\\': xgr_sb_append_char(&sb, '\\'); break;
                case '/':  xgr_sb_append_char(&sb, '/'); break;
                case 'b':  xgr_sb_append_char(&sb, '\b'); break;
                case 'f':  xgr_sb_append_char(&sb, '\f'); break;
                case 'n':  xgr_sb_append_char(&sb, '\n'); break;
                case 'r':  xgr_sb_append_char(&sb, '\r'); break;
                case 't':  xgr_sb_append_char(&sb, '\t'); break;
                case 'u': {
                    uint32_t cp = 0;
                    if (parse_hex4_strict(v, &cp)) {
                        v += 4;
                        if (cp >= 0xD800u && cp <= 0xDBFFu && v[0] == '\\' && v[1] == 'u') {
                            uint32_t low = 0;
                            if (parse_hex4_strict(v + 2, &low) && low >= 0xDC00u && low <= 0xDFFFu) {
                                v += 6;
                                cp = 0x10000u + (((cp - 0xD800u) << 10) | (low - 0xDC00u));
                            }
                        }
                        append_utf8_codepoint(&sb, cp);
                    } else {
                        /* Malformed \u escape: never advance past NUL */
                        xgr_sb_append_char(&sb, 'u');
                    }
                    break;
                }
                default:
                    xgr_sb_append_char(&sb, esc);
                    break;
            }
        } else {
            xgr_sb_append_char(&sb, (char)ch);
        }
        if (sb.failed) {
            xgr_sb_free(&sb);
            return NULL;
        }
    }
    if (*v != '"') {
        /* Unterminated JSON string */
        xgr_sb_free(&sb);
        return NULL;
    }
    return xgr_sb_detach(&sb);
}

bool xgr_json_extract_string(const char *json, const char *key, char *out_buf, size_t out_size)
{
    if (!out_buf || out_size == 0) return false;
    out_buf[0] = '\0';
    char *s = xgr_json_alloc_string(json, key);
    if (!s) return false;
    snprintf(out_buf, out_size, "%s", s);
    free(s);
    return true;
}

bool xgr_json_get_string(const char *json, const char *key, char *out_buf, size_t out_size)
{
    return xgr_json_extract_string(json, key, out_buf, out_size);
}

static bool json_is_num_delim(char c, bool quoted)
{
    if (quoted) return c == '"';
    return c == '\0' || c == ',' || c == '}' || c == ']' || isspace((unsigned char)c);
}

bool xgr_json_get_int64(const char *json, const char *key, int64_t *out_val)
{
    const char *v = json_locate_key_value(json, key);
    if (!v || !out_val) return false;
    bool quoted = (*v == '"');
    if (quoted) v++;
    errno = 0;
    char *end = NULL;
    long long parsed = _strtoi64(v, &end, 10);
    if (end == v || errno == ERANGE || !json_is_num_delim(*end, quoted)) return false;
    *out_val = (int64_t)parsed;
    return true;
}

bool xgr_json_get_uint64(const char *json, const char *key, uint64_t *out_val)
{
    const char *v = json_locate_key_value(json, key);
    if (!v || !out_val) return false;
    bool quoted = (*v == '"');
    if (quoted) v++;
    if (*v == '-') return false;
    errno = 0;
    char *end = NULL;
    unsigned long long parsed = _strtoui64(v, &end, 10);
    if (end == v || errno == ERANGE || !json_is_num_delim(*end, quoted)) return false;
    *out_val = (uint64_t)parsed;
    return true;
}

bool xgr_json_get_bool(const char *json, const char *key, bool *out_val)
{
    const char *v = json_locate_key_value(json, key);
    if (!v || !out_val) return false;
    if (strncmp(v, "true", 4) == 0 && json_is_num_delim(v[4], false)) { *out_val = true; return true; }
    if (strncmp(v, "false", 5) == 0 && json_is_num_delim(v[5], false)) { *out_val = false; return true; }
    return false;
}

static char *extract_json_subobject_alloc(const char *json, const char *key)
{
    const char *v = json_locate_key_value(json, key);
    if (!v || *v != '{') return NULL;
    int depth = 0;
    bool in_str = false;
    bool escaped = false;
    for (const char *p = v; *p; p++) {
        if (in_str) {
            if (escaped) {
                escaped = false;
            } else if (*p == '\\') {
                escaped = true;
            } else if (*p == '"') {
                in_str = false;
            }
            continue;
        }
        if (*p == '"') {
            in_str = true;
            escaped = false;
        } else if (*p == '{') {
            depth++;
        } else if (*p == '}') {
            depth--;
            if (depth == 0) {
                size_t len = (size_t)(p - v + 1);
                char *sub = (char *)malloc(len + 1);
                if (!sub) return NULL;
                memcpy(sub, v, len);
                sub[len] = '\0';
                return sub;
            }
        }
    }
    return NULL;
}

/* -------------------------------------------------------------------------
 * Base64 Codec
 * ------------------------------------------------------------------------- */

static const char k_b64_enc[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

char *xgr_base64_encode_alloc(const uint8_t *data, size_t len)
{
    if (len > 0 && !data) return NULL;
    if (len > (SIZE_MAX - 8) / 4 * 3) return NULL;
    size_t out_len = ((len + 2) / 3) * 4;
    char *out = (char *)malloc(out_len + 1);
    if (!out) return NULL;
    size_t j = 0;
    for (size_t i = 0; i < len; i += 3) {
        uint32_t a = data[i];
        uint32_t b = (i + 1 < len) ? data[i + 1] : 0;
        uint32_t c = (i + 2 < len) ? data[i + 2] : 0;
        uint32_t triple = (a << 16) | (b << 8) | c;
        out[j++] = k_b64_enc[(triple >> 18) & 0x3F];
        out[j++] = k_b64_enc[(triple >> 12) & 0x3F];
        out[j++] = (i + 1 < len) ? k_b64_enc[(triple >> 6) & 0x3F] : '=';
        out[j++] = (i + 2 < len) ? k_b64_enc[triple & 0x3F] : '=';
    }
    out[j] = '\0';
    return out;
}

static int b64_val(unsigned char c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+' || c == '-') return 62;
    if (c == '/' || c == '_') return 63;
    return -1;
}

uint8_t *xgr_base64_decode_alloc(const char *b64, size_t *out_len)
{
    if (out_len) *out_len = 0;
    if (!b64) return NULL;
    size_t slen = strlen(b64);
    if (slen > (SIZE_MAX - 8) / 3) return NULL;
    uint8_t *out = (uint8_t *)malloc((slen / 4 + 1) * 3 + 1);
    if (!out) return NULL;

    size_t o = 0;
    uint32_t buf = 0;
    int bits = 0;
    for (size_t i = 0; i < slen; i++) {
        if (b64[i] == '=') break;
        int v = b64_val((unsigned char)b64[i]);
        if (v < 0) continue;
        buf = (buf << 6) | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (uint8_t)((buf >> bits) & 0xFFu);
        }
    }
    if (out_len) *out_len = o;
    return out;
}

/* -------------------------------------------------------------------------
 * Persistent Loopback Socket Transport (`xgr_rpc_call` / `xgr_rpc_shutdown`)
 * ------------------------------------------------------------------------- */

static BOOL CALLBACK init_rpc_once(PINIT_ONCE once, PVOID param, PVOID *ctx)
{
    (void)once; (void)param; (void)ctx;
    InitializeCriticalSection(&g_rpc_cs);
    WSADATA wsa;
    g_wsa_ok = (WSAStartup(MAKEWORD(2, 2), &wsa) == 0);
    InterlockedExchange(&g_rpc_cs_ready, 1);
    return TRUE;
}

static bool send_all(SOCKET s, const char *buf, size_t len)
{
    while (len > 0) {
        int chunk = len > 0x7fffffff ? 0x7fffffff : (int)len;
        int n = send(s, buf, chunk, 0);
        if (n <= 0) return false;
        buf += n;
        len -= (size_t)n;
    }
    return true;
}

static bool recv_all(SOCKET s, char *buf, size_t len)
{
    while (len > 0) {
        int chunk = len > 0x7fffffff ? 0x7fffffff : (int)len;
        int n = recv(s, buf, chunk, 0);
        if (n <= 0) return false;
        buf += n;
        len -= (size_t)n;
    }
    return true;
}

static void close_rpc_sock_locked(void)
{
    if (g_rpc_sock != INVALID_SOCKET) {
        closesocket(g_rpc_sock);
        g_rpc_sock = INVALID_SOCKET;
    }
    g_rpc_sock_port = 0;
    g_rpc_sock_authed = false;
    SecureZeroMemory(g_rpc_sock_key, sizeof(g_rpc_sock_key));
}

void xgr_rpc_shutdown(void)
{
    if (InterlockedCompareExchange(&g_rpc_cs_ready, 0, 0) == 0) return;
    EnterCriticalSection(&g_rpc_cs);
    close_rpc_sock_locked();
    LeaveCriticalSection(&g_rpc_cs);
}

/* Establish a loopback TCP socket with a bounded 2500 ms connect timeout OUTSIDE g_rpc_cs */
static SOCKET dial_rpc_sock_bounded(uint16_t port)
{
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return INVALID_SOCKET;

    int nodelay = 1;
    (void)setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char *)&nodelay, sizeof(nodelay));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    addr.sin_addr.s_addr = htonl(0x7f000001u);

    bool connected = false;
#ifdef _WIN32
    u_long nb = 1;
    bool switched_nb = (ioctlsocket(s, FIONBIO, &nb) == 0);
    if (connect(s, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
        connected = true;
    } else if (switched_nb) {
        int werr = WSAGetLastError();
        if (werr == WSAEWOULDBLOCK || werr == WSAEINPROGRESS) {
            fd_set wfds, efds;
            FD_ZERO(&wfds);
            FD_ZERO(&efds);
            FD_SET(s, &wfds);
            FD_SET(s, &efds);
            struct timeval tv;
            tv.tv_sec = 2;
            tv.tv_usec = 500000;
            int sel = select(0, NULL, &wfds, &efds, &tv);
            if (sel > 0 && FD_ISSET(s, &wfds) && !FD_ISSET(s, &efds)) {
                int so_err = 0;
                int so_len = (int)sizeof(so_err);
                if (getsockopt(s, SOL_SOCKET, SO_ERROR, (char *)&so_err, &so_len) == 0 && so_err == 0) {
                    connected = true;
                }
            }
        }
    }
    if (switched_nb) {
        nb = 0;
        (void)ioctlsocket(s, FIONBIO, &nb);
    }
    DWORD timeout_ms = 15000;
    (void)setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));
    (void)setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));
#else
    int flags = fcntl(s, F_GETFL, 0);
    bool switched_nb = (flags >= 0 && fcntl(s, F_SETFL, flags | O_NONBLOCK) == 0);
    if (connect(s, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
        connected = true;
    } else if (switched_nb && errno == EINPROGRESS) {
        fd_set wfds;
        FD_ZERO(&wfds);
        FD_SET(s, &wfds);
        struct timeval tv;
        tv.tv_sec = 2;
        tv.tv_usec = 500000;
        int sel = select(s + 1, NULL, &wfds, NULL, &tv);
        if (sel > 0 && FD_ISSET(s, &wfds)) {
            int so_err = 0;
            socklen_t so_len = (socklen_t)sizeof(so_err);
            if (getsockopt(s, SOL_SOCKET, SO_ERROR, &so_err, &so_len) == 0 && so_err == 0) {
                connected = true;
            }
        }
    }
    if (switched_nb) {
        (void)fcntl(s, F_SETFL, flags);
    }
    struct timeval io_tv;
    io_tv.tv_sec = 15;
    io_tv.tv_usec = 0;
    (void)setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &io_tv, sizeof(io_tv));
    (void)setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &io_tv, sizeof(io_tv));
#endif

    if (!connected) {
        closesocket(s);
        return INVALID_SOCKET;
    }
    return s;
}

static HRESULT exchange_rpc_frame_locked(
    const char *body,
    size_t body_len,
    char **out_resp_buf,
    uint32_t *out_resp_len
)
{
    *out_resp_buf = NULL;
    *out_resp_len = 0;
    if (body_len == 0 || body_len > 16 * 1024 * 1024) return E_INVALIDARG;

    uint32_t len_le = (uint32_t)body_len;
    if (!send_all(g_rpc_sock, (const char *)&len_le, 4) ||
        !send_all(g_rpc_sock, body, body_len)) {
        return HRESULT_FROM_WIN32(ERROR_CONNECTION_ABORTED);
    }

    uint32_t resp_len = 0;
    if (!recv_all(g_rpc_sock, (char *)&resp_len, 4)) {
        return HRESULT_FROM_WIN32(ERROR_CONNECTION_ABORTED);
    }
    if (resp_len == 0 || resp_len > 16 * 1024 * 1024) {
        return E_UNEXPECTED;
    }

    char *resp_buf = (char *)malloc((size_t)resp_len + 1);
    if (!resp_buf) return E_OUTOFMEMORY;

    if (!recv_all(g_rpc_sock, resp_buf, resp_len)) {
        free(resp_buf);
        return HRESULT_FROM_WIN32(ERROR_CONNECTION_ABORTED);
    }
    resp_buf[resp_len] = '\0';
    *out_resp_buf = resp_buf;
    *out_resp_len = resp_len;
    return S_OK;
}

static HRESULT ensure_socket_preauthed_for_large_frame_locked(const char key[65])
{
    if (g_rpc_sock_authed) return S_OK;
    XgrStrBuf auth_sb;
    xgr_sb_init(&auth_sb);
    xgr_sb_append_cstr(&auth_sb, "{\"id\":0,\"key\":");
    xgr_sb_append_json_str(&auth_sb, key);
    xgr_sb_append_cstr(&auth_sb, ",\"method\":\"auth\",\"params\":{}}");
    size_t auth_len = auth_sb.len;
    char *auth_body = xgr_sb_detach(&auth_sb);
    if (!auth_body || auth_len == 0) {
        free(auth_body);
        return E_OUTOFMEMORY;
    }

    char *auth_resp = NULL;
    uint32_t auth_resp_len = 0;
    HRESULT hr = exchange_rpc_frame_locked(auth_body, auth_len, &auth_resp, &auth_resp_len);
    SecureZeroMemory(auth_body, auth_len);
    free(auth_body);
    if (FAILED(hr)) return hr;

    bool ok = false;
    bool parsed = xgr_json_get_bool(auth_resp, "ok", &ok);
    if (!parsed || !ok) {
        int64_t remote_hr = (int64_t)E_ACCESSDENIED;
        xgr_json_get_int64(auth_resp, "hr", &remote_hr);
        hr = (HRESULT)(uint32_t)remote_hr;
        if (SUCCEEDED(hr)) hr = E_ACCESSDENIED;
    } else {
        g_rpc_sock_authed = true;
        hr = S_OK;
    }

    SecureZeroMemory(auth_resp, auth_resp_len);
    free(auth_resp);
    return hr;
}

HRESULT xgr_rpc_call(const char *method, const char *params_json_obj, char **out_result_json)
{
    if (out_result_json) *out_result_json = NULL;
    if (!method || !*method) return E_INVALIDARG;

    uint16_t port = 0;
    char key[65];
    if (!read_bridge_env(&port, key)) {
        return HRESULT_FROM_WIN32(ERROR_ENVVAR_NOT_FOUND);
    }

    if (!InitOnceExecuteOnce(&g_rpc_once, init_rpc_once, NULL, NULL) || !g_wsa_ok) {
        SecureZeroMemory(key, sizeof(key));
        return E_FAIL;
    }

    const char *params = (params_json_obj && *params_json_obj) ? params_json_obj : "{}";
    LONG req_id = InterlockedIncrement(&g_rpc_seq);

    XgrStrBuf req_sb;
    xgr_sb_init(&req_sb);
    xgr_sb_append_fmt(&req_sb, "{\"id\":%ld,\"key\":", (long)req_id);
    xgr_sb_append_json_str(&req_sb, key);
    xgr_sb_append_cstr(&req_sb, ",\"method\":");
    xgr_sb_append_json_str(&req_sb, method);
    xgr_sb_append_cstr(&req_sb, ",\"params\":");
    xgr_sb_append_cstr(&req_sb, params);
    xgr_sb_append_char(&req_sb, '}');

    size_t body_len = req_sb.len;
    char *body = xgr_sb_detach(&req_sb);
    if (!body || body_len == 0 || body_len > 16 * 1024 * 1024) {
        if (body) {
            SecureZeroMemory(body, body_len);
            free(body);
        }
        SecureZeroMemory(key, sizeof(key));
        return body ? E_INVALIDARG : E_OUTOFMEMORY;
    }

    HRESULT hr = S_OK;
    char *resp_buf = NULL;
    uint32_t resp_len = 0;

    EnterCriticalSection(&g_rpc_cs);

    if (g_rpc_sock != INVALID_SOCKET &&
        (g_rpc_sock_port != port || strcmp(g_rpc_sock_key, key) != 0)) {
        close_rpc_sock_locked();
    }

    bool reused_existing = (g_rpc_sock != INVALID_SOCKET);
    for (int attempt = 0; attempt < 2; attempt++) {
        if (g_rpc_sock == INVALID_SOCKET) {
            /* Dial outside g_rpc_cs with bounded 2.5s timeout so other threads never stall on dead port */
            LeaveCriticalSection(&g_rpc_cs);
            SOCKET dialed = dial_rpc_sock_bounded(port);
            EnterCriticalSection(&g_rpc_cs);
            if (dialed == INVALID_SOCKET) {
                if (g_rpc_sock == INVALID_SOCKET ||
                    g_rpc_sock_port != port ||
                    strcmp(g_rpc_sock_key, key) != 0) {
                    hr = HRESULT_FROM_WIN32(ERROR_CONNECTION_REFUSED);
                    break;
                }
            } else if (g_rpc_sock != INVALID_SOCKET &&
                       g_rpc_sock_port == port &&
                       strcmp(g_rpc_sock_key, key) == 0) {
                /* Another thread already established a matching socket while we dialed */
                closesocket(dialed);
            } else {
                close_rpc_sock_locked();
                g_rpc_sock = dialed;
                g_rpc_sock_port = port;
                memcpy(g_rpc_sock_key, key, 65);
                g_rpc_sock_authed = false;
            }
        }

        if (!g_rpc_sock_authed && body_len > 3500) {
            hr = ensure_socket_preauthed_for_large_frame_locked(key);
            if (FAILED(hr)) {
                close_rpc_sock_locked();
                if (attempt == 0 && reused_existing && hr == HRESULT_FROM_WIN32(ERROR_CONNECTION_ABORTED)) {
                    reused_existing = false;
                    continue;
                }
                break;
            }
        }

        hr = exchange_rpc_frame_locked(body, body_len, &resp_buf, &resp_len);
        if (FAILED(hr)) {
            close_rpc_sock_locked();
            if (attempt == 0 && reused_existing) {
                reused_existing = false;
                continue;
            }
            if (hr == HRESULT_FROM_WIN32(ERROR_CONNECTION_ABORTED)) {
                hr = HRESULT_FROM_WIN32(ERROR_CONNECTION_REFUSED);
            }
            break;
        }
        break;
    }

    if (SUCCEEDED(hr) && resp_buf) {
        int64_t resp_id = 0;
        if (xgr_json_get_int64(resp_buf, "id", &resp_id) && resp_id != (int64_t)req_id) {
            /* Response id desync on persistent stream: close socket and fail closed */
            close_rpc_sock_locked();
            hr = E_UNEXPECTED;
        } else {
            bool ok = false;
            if (!xgr_json_get_bool(resp_buf, "ok", &ok) || !ok) {
                int64_t remote_hr = (int64_t)E_FAIL;
                xgr_json_get_int64(resp_buf, "hr", &remote_hr);
                hr = (HRESULT)(uint32_t)remote_hr;
                if (SUCCEEDED(hr)) hr = E_FAIL;
            } else {
                g_rpc_sock_authed = true;
                if (out_result_json) {
                    *out_result_json = extract_json_subobject_alloc(resp_buf, "result");
                    if (!*out_result_json) *out_result_json = strdup("{}");
                }
            }
        }
    }

    LeaveCriticalSection(&g_rpc_cs);

    SecureZeroMemory(body, body_len);
    free(body);
    SecureZeroMemory(key, sizeof(key));
    if (resp_buf) {
        SecureZeroMemory(resp_buf, resp_len);
        free(resp_buf);
    }
    xgr_sync_teb_last_error();
    return hr;
}
