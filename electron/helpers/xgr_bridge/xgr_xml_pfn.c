/*
 * One Launcher XGR Bridge — Pure-C11 SHA-256, Appx Base32 PFN & Manifest Walker
 * Zero external XML/crypto DLL dependencies.
 */

#include "xgr_internal.h"
#include <ctype.h>

static const uint32_t k_sha256[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
};

static inline uint32_t rotr32(uint32_t x, uint32_t n)
{
    return (x >> n) | (x << (32u - n));
}

static void sha256_transform(uint32_t state[8], const uint8_t block[64])
{
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
        w[i] = ((uint32_t)block[i * 4] << 24) |
               ((uint32_t)block[i * 4 + 1] << 16) |
               ((uint32_t)block[i * 4 + 2] << 8) |
               ((uint32_t)block[i * 4 + 3]);
    }
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }

    uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
    uint32_t e = state[4], f = state[5], g = state[6], h = state[7];

    for (int i = 0; i < 64; i++) {
        uint32_t S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
        uint32_t ch = (e & f) ^ ((~e) & g);
        uint32_t temp1 = h + S1 + ch + k_sha256[i] + w[i];
        uint32_t S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
        uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t temp2 = S0 + maj;

        h = g; g = f; f = e; e = d + temp1;
        d = c; c = b; b = a; a = temp1 + temp2;
    }

    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
}

void xgr_sha256(const uint8_t *data, size_t len, uint8_t out_digest[32])
{
    uint32_t state[8] = {
        0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u
    };
    uint8_t block[64];
    size_t offset = 0;
    while (len - offset >= 64) {
        sha256_transform(state, data + offset);
        offset += 64;
    }

    size_t rem = len - offset;
    memset(block, 0, sizeof(block));
    if (rem > 0) memcpy(block, data + offset, rem);
    block[rem] = 0x80u;

    if (rem >= 56) {
        sha256_transform(state, block);
        memset(block, 0, sizeof(block));
    }

    uint64_t bit_len = (uint64_t)len * 8ull;
    for (int i = 0; i < 8; i++) {
        block[63 - i] = (uint8_t)(bit_len >> (i * 8));
    }
    sha256_transform(state, block);

    for (int i = 0; i < 8; i++) {
        out_digest[i * 4]     = (uint8_t)(state[i] >> 24);
        out_digest[i * 4 + 1] = (uint8_t)(state[i] >> 16);
        out_digest[i * 4 + 2] = (uint8_t)(state[i] >> 8);
        out_digest[i * 4 + 3] = (uint8_t)(state[i]);
    }
}

bool xgr_compute_package_family_name(const char *identity_name, const char *publisher, char *out_pfn, size_t out_size)
{
    static const char alphabet[] = "0123456789abcdefghjkmnpqrstvwxyz";
    if (!identity_name || !*identity_name || !publisher || !*publisher || !out_pfn || out_size < 16)
        return false;

    int wlen = MultiByteToWideChar(CP_UTF8, 0, publisher, -1, NULL, 0);
    if (wlen <= 1) return false;
    wchar_t *wpub = (wchar_t *)calloc((size_t)wlen, sizeof(wchar_t));
    if (!wpub) return false;
    MultiByteToWideChar(CP_UTF8, 0, publisher, -1, wpub, wlen);

    uint8_t digest[32];
    xgr_sha256((const uint8_t *)wpub, (size_t)(wlen - 1) * sizeof(wchar_t), digest);
    free(wpub);

    /* Top 64 bits (8 bytes) << 1 zero bit = 65 bits -> 13 x 5-bit symbols */
    uint64_t hi64 = 0;
    for (int i = 0; i < 8; i++) {
        hi64 = (hi64 << 8) | (uint64_t)digest[i];
    }

    char pub_id[14];
    for (int i = 0; i < 12; i++) {
        uint32_t shift = (uint32_t)(59 - i * 5);
        pub_id[i] = alphabet[(hi64 >> shift) & 0x1fu];
    }
    pub_id[12] = alphabet[(uint32_t)((hi64 & 0x0fu) << 1)];
    pub_id[13] = '\0';

    int written = snprintf(out_pfn, out_size, "%s_%s", identity_name, pub_id);
    return written > 0 && (size_t)written < out_size;
}

/* Lightweight comment-stripping, entity-decoding & case-insensitive XML helpers */
static const char *ci_find(const char *haystack, const char *needle)
{
    if (!haystack || !needle || !*needle) return NULL;
    size_t nlen = strlen(needle);
    for (const char *p = haystack; *p; p++) {
        if (_strnicmp(p, needle, nlen) == 0) return p;
    }
    return NULL;
}

static char *xml_strip_comments_alloc(const char *xml)
{
    if (!xml) return NULL;
    size_t len = strlen(xml);
    char *out = (char *)malloc(len + 1);
    if (!out) return NULL;

    size_t o = 0;
    const char *p = xml;
    while (*p) {
        if (p[0] == '<' && p[1] == '!' && p[2] == '-' && p[3] == '-') {
            const char *end = strstr(p + 4, "-->");
            if (!end) break;
            p = end + 3;
            continue;
        }
        out[o++] = *p++;
    }
    out[o] = '\0';
    return out;
}

static char *xml_strip_tag_blocks_ci_alloc(const char *xml, const char *tag_name)
{
    if (!xml || !tag_name || !*tag_name) return NULL;
    size_t len = strlen(xml);
    char *out = (char *)malloc(len + 1);
    if (!out) return NULL;

    char open_pat[64], close_pat[64];
    snprintf(open_pat, sizeof(open_pat), "<%s", tag_name);
    snprintf(close_pat, sizeof(close_pat), "</%s", tag_name);
    size_t open_len = strlen(open_pat);
    size_t close_len = strlen(close_pat);

    size_t o = 0;
    const char *p = xml;
    while (*p) {
        if (_strnicmp(p, open_pat, open_len) == 0) {
            char next_ch = p[open_len];
            if (next_ch == '>' || next_ch == '/' || isspace((unsigned char)next_ch)) {
                const char *gt = strchr(p + open_len, '>');
                if (!gt) break;
                if (gt > p && gt[-1] == '/') {
                    p = gt + 1;
                    continue;
                }
                const char *close_tag = ci_find(gt + 1, close_pat);
                if (!close_tag) break;
                const char *close_gt = strchr(close_tag + close_len, '>');
                if (!close_gt) break;
                p = close_gt + 1;
                continue;
            }
        }
        out[o++] = *p++;
    }
    out[o] = '\0';
    return out;
}

static bool is_titleid_derived_scid_prefix(const char *scid)
{
    if (!scid || strlen(scid) != 36) return false;
    if (_strnicmp(scid, "00000000-0000-0000-0000-0000", 28) != 0) return false;
    for (size_t i = 28; i < 36; i++) {
        unsigned char c = (unsigned char)scid[i];
        bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        if (!hex) return false;
    }
    return true;
}

static size_t encode_utf8_cp_to_buf(uint32_t cp, char out[4])
{
    if (cp == 0 || (cp >= 0xD800u && cp <= 0xDFFFu) || cp > 0x10FFFFu) {
        cp = 0xFFFDu;
    }
    if (cp <= 0x7Fu) {
        out[0] = (char)cp;
        return 1;
    }
    if (cp <= 0x7FFu) {
        out[0] = (char)(0xC0u | (cp >> 6));
        out[1] = (char)(0x80u | (cp & 0x3Fu));
        return 2;
    }
    if (cp <= 0xFFFFu) {
        out[0] = (char)(0xE0u | (cp >> 12));
        out[1] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
        out[2] = (char)(0x80u | (cp & 0x3Fu));
        return 3;
    }
    out[0] = (char)(0xF0u | (cp >> 18));
    out[1] = (char)(0x80u | ((cp >> 12) & 0x3Fu));
    out[2] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
    out[3] = (char)(0x80u | (cp & 0x3Fu));
    return 4;
}

static void xml_copy_decoded_slice(const char *start, const char *end, char *out, size_t out_size)
{
    if (!out || out_size == 0) return;
    size_t o = 0;
    const char *p = start;
    while (p < end && o + 1 < out_size) {
        if (*p == '&') {
            const char *semi = (const char *)memchr(p + 1, ';', (size_t)(end - (p + 1)));
            if (semi && (size_t)(semi - p) <= 16) {
                size_t elen = (size_t)(semi - (p + 1));
                const char *ent = p + 1;
                char repl[4];
                size_t rlen = 0;

                if (elen == 2 && strncmp(ent, "lt", 2) == 0) {
                    repl[0] = '<'; rlen = 1;
                } else if (elen == 2 && strncmp(ent, "gt", 2) == 0) {
                    repl[0] = '>'; rlen = 1;
                } else if (elen == 3 && strncmp(ent, "amp", 3) == 0) {
                    repl[0] = '&'; rlen = 1;
                } else if (elen == 4 && strncmp(ent, "quot", 4) == 0) {
                    repl[0] = '"'; rlen = 1;
                } else if (elen == 4 && strncmp(ent, "apos", 4) == 0) {
                    repl[0] = '\''; rlen = 1;
                } else if (elen >= 2 && ent[0] == '#') {
                    char num_buf[16] = { 0 };
                    int base = 10;
                    const char *digits = ent + 1;
                    size_t dlen = elen - 1;
                    if (dlen >= 2 && (digits[0] == 'x' || digits[0] == 'X')) {
                        base = 16;
                        digits++;
                        dlen--;
                    }
                    if (dlen > 0 && dlen < sizeof(num_buf)) {
                        memcpy(num_buf, digits, dlen);
                        num_buf[dlen] = '\0';
                        char *ep = NULL;
                        unsigned long cp = strtoul(num_buf, &ep, base);
                        if (ep && *ep == '\0' && cp > 0 && cp <= 0x10FFFFul) {
                            rlen = encode_utf8_cp_to_buf((uint32_t)cp, repl);
                        }
                    }
                }

                if (rlen > 0) {
                    if (o + rlen >= out_size) break;
                    memcpy(out + o, repl, rlen);
                    o += rlen;
                    p = semi + 1;
                    continue;
                }
            }
        }
        out[o++] = *p++;
    }
    out[o] = '\0';
}

static bool xml_extract_tag_value(const char *xml, const char *tag_name, char *out, size_t out_size)
{
    char open_pat[64], close_pat[64];
    snprintf(open_pat, sizeof(open_pat), "<%s", tag_name);
    snprintf(close_pat, sizeof(close_pat), "</%s>", tag_name);

    const char *p = xml;
    size_t open_len = strlen(open_pat);
    while ((p = ci_find(p, open_pat)) != NULL) {
        char next_ch = p[open_len];
        if (next_ch != '>' && next_ch != '/' && next_ch != ' ' && next_ch != '\t' && next_ch != '\r' && next_ch != '\n') {
            p += open_len;
            continue;
        }
        const char *gt = strchr(p, '>');
        if (!gt) return false;
        if (gt > p && gt[-1] == '/') {
            p = gt + 1;
            continue;
        }
        gt++;
        const char *end = ci_find(gt, close_pat);
        if (!end) return false;
        while (gt < end && isspace((unsigned char)*gt)) gt++;
        while (end > gt && isspace((unsigned char)end[-1])) end--;
        xml_copy_decoded_slice(gt, end, out, out_size);
        return out[0] != '\0';
    }
    return false;
}

static bool xml_extract_attr_from_element(const char *elem_start, const char *elem_end, const char *attr_name, char *out, size_t out_size)
{
    size_t alen = strlen(attr_name);
    for (const char *p = elem_start; p + alen + 2 < elem_end; p++) {
        if (_strnicmp(p, attr_name, alen) == 0 &&
            (p == elem_start || isspace((unsigned char)p[-1]))) {
            const char *q = p + alen;
            while (q < elem_end && isspace((unsigned char)*q)) q++;
            if (q >= elem_end || *q != '=') continue;
            q++;
            while (q < elem_end && isspace((unsigned char)*q)) q++;
            if (q >= elem_end || (*q != '"' && *q != '\'')) continue;
            char quote = *q++;
            const char *val_end = (const char *)memchr(q, quote, (size_t)(elem_end - q));
            if (!val_end) return false;
            xml_copy_decoded_slice(q, val_end, out, out_size);
            return true;
        }
    }
    return false;
}

static bool xml_extract_tag_attr(const char *xml, const char *tag_name, const char *attr_name, char *out, size_t out_size)
{
    char open_pat[64];
    snprintf(open_pat, sizeof(open_pat), "<%s", tag_name);
    const char *p = xml;
    size_t open_len = strlen(open_pat);
    while ((p = ci_find(p, open_pat)) != NULL) {
        char next_ch = p[open_len];
        if (!isspace((unsigned char)next_ch) && next_ch != '>' && next_ch != '/') {
            p += open_len;
            continue;
        }
        const char *gt = strchr(p, '>');
        if (!gt) return false;
        if (xml_extract_attr_from_element(p + open_len, gt, attr_name, out, out_size))
            return true;
        p = gt + 1;
    }
    return false;
}

static uint32_t parse_flexible_title_id(const char *raw, int default_base)
{
    if (!raw || !*raw) return 0;
    while (*raw && isspace((unsigned char)*raw)) raw++;
    if (!*raw) return 0;
    if (raw[0] == '0' && (raw[1] == 'x' || raw[1] == 'X')) {
        return (uint32_t)strtoul(raw + 2, NULL, 16);
    }
    size_t len = 0;
    bool all_dec = true;
    bool has_hex_alpha = false;
    while (raw[len] && !isspace((unsigned char)raw[len])) {
        unsigned char c = (unsigned char)raw[len];
        if (c >= '0' && c <= '9') {
            /* decimal or hex digit */
        } else if ((c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
            all_dec = false;
            has_hex_alpha = true;
        } else {
            return 0;
        }
        len++;
    }
    if (len == 0) return 0;
    if (has_hex_alpha) return (uint32_t)strtoul(raw, NULL, 16);
    if (all_dec && len > 8) return (uint32_t)strtoul(raw, NULL, 10);
    return (uint32_t)strtoul(raw, NULL, default_base);
}

static void parse_version_quad(const char *ver_str, XVersion *out_ver)
{
    unsigned int ma = 1, mi = 0, bu = 0, re = 0;
    if (ver_str && *ver_str) {
        sscanf(ver_str, "%u.%u.%u.%u", &ma, &mi, &bu, &re);
    }
    out_ver->major = (uint16_t)ma;
    out_ver->minor = (uint16_t)mi;
    out_ver->build = (uint16_t)bu;
    out_ver->revision = (uint16_t)re;
}

static char *read_utf8_file_alloc(const wchar_t *path)
{
    if (!path || !*path) return NULL;
    HANDLE hf = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hf == INVALID_HANDLE_VALUE) return NULL;
    LARGE_INTEGER sz;
    if (!GetFileSizeEx(hf, &sz) || sz.QuadPart <= 0 || sz.QuadPart > 4 * 1024 * 1024) {
        CloseHandle(hf);
        return NULL;
    }
    char *buf = (char *)calloc((size_t)sz.QuadPart + 1, 1);
    if (!buf) {
        CloseHandle(hf);
        return NULL;
    }
    DWORD rd = 0;
    if (!ReadFile(hf, buf, (DWORD)sz.QuadPart, &rd, NULL)) {
        free(buf);
        CloseHandle(hf);
        return NULL;
    }
    buf[rd] = '\0';
    CloseHandle(hf);
    /* Strip UTF-8 BOM if present */
    if (rd >= 3 && (uint8_t)buf[0] == 0xEF && (uint8_t)buf[1] == 0xBB && (uint8_t)buf[2] == 0xBF) {
        memmove(buf, buf + 3, rd - 2);
    }
    return buf;
}

static WCHAR *utf8_to_wide_heap(const char *utf8)
{
    if (!utf8 || !*utf8) return NULL;
    int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, NULL, 0);
    if (wlen <= 0) return NULL;
    WCHAR *wbuf = (WCHAR *)malloc((size_t)wlen * sizeof(WCHAR));
    if (!wbuf) return NULL;
    if (MultiByteToWideChar(CP_UTF8, 0, utf8, -1, wbuf, wlen) <= 0) {
        free(wbuf);
        return NULL;
    }
    return wbuf;
}

static WCHAR *get_main_module_path_heap(void)
{
    DWORD cap = 1024;
    while (cap <= 32768) {
        WCHAR *buf = (WCHAR *)calloc(cap, sizeof(WCHAR));
        if (!buf) return NULL;
        DWORD n = GetModuleFileNameW(NULL, buf, cap);
        if (n == 0) {
            free(buf);
            return NULL;
        }
        if (n < cap - 1) {
            buf[n] = L'\0';
            return buf;
        }
        free(buf);
        cap *= 2;
    }
    return NULL;
}

static WCHAR *join_wide_path_heap(const WCHAR *dir, const WCHAR *rel)
{
    if (!dir || !rel) return NULL;
    size_t dlen = wcslen(dir);
    size_t rlen = wcslen(rel);
    WCHAR *out = (WCHAR *)malloc((dlen + 1 + rlen + 1) * sizeof(WCHAR));
    if (!out) return NULL;
    memcpy(out, dir, dlen * sizeof(WCHAR));
    out[dlen] = L'\\';
    memcpy(out + dlen + 1, rel, (rlen + 1) * sizeof(WCHAR));
    return out;
}

static void store_game_root_wide(const WCHAR *dir)
{
    if (!dir || !*dir) return;
    size_t wcap = sizeof(g_xgr_cfg.gameRootWide) / sizeof(g_xgr_cfg.gameRootWide[0]);
    wcsncpy(g_xgr_cfg.gameRootWide, dir, wcap - 1);
    g_xgr_cfg.gameRootWide[wcap - 1] = L'\0';
    int n = WideCharToMultiByte(
        CP_UTF8,
        0,
        g_xgr_cfg.gameRootWide,
        -1,
        g_xgr_cfg.gameRootUtf8,
        (int)sizeof(g_xgr_cfg.gameRootUtf8) - 1,
        NULL,
        NULL
    );
    if (n <= 0) g_xgr_cfg.gameRootUtf8[0] = '\0';
    else g_xgr_cfg.gameRootUtf8[sizeof(g_xgr_cfg.gameRootUtf8) - 1] = '\0';
}

static void apply_game_config_xml(const char *raw_xml)
{
    if (!raw_xml || !*raw_xml) return;
    char *clean = xml_strip_comments_alloc(raw_xml);
    const char *comment_free = clean ? clean : raw_xml;
    char *no_dev = xml_strip_tag_blocks_ci_alloc(comment_free, "DevelopmentOnly");

    char ver_str[64] = {0};
    char tmp[512] = {0};

    /* Prefer XML with <DevelopmentOnly> stripped; fall back to comment-free XML only if
     * <TitleId> was exclusively inside <DevelopmentOnly> and absent outside it. */
    const char *xml = comment_free;
    if (no_dev) {
        bool has_retail_tid = xml_extract_tag_value(no_dev, "TitleId", tmp, sizeof(tmp)) && tmp[0];
        bool has_any_tid = has_retail_tid || (xml_extract_tag_value(comment_free, "TitleId", tmp, sizeof(tmp)) && tmp[0]);
        if (has_retail_tid || !has_any_tid) {
            xml = no_dev;
        }
        tmp[0] = '\0';
    }

    g_xgr_cfg.packaged = true;
    g_xgr_cfg.fullTrust = true;

    if (xml_extract_tag_attr(xml, "Identity", "Name", tmp, sizeof(tmp)) && tmp[0])
        snprintf(g_xgr_cfg.identityName, sizeof(g_xgr_cfg.identityName), "%s", tmp);
    if (xml_extract_tag_attr(xml, "Identity", "Publisher", tmp, sizeof(tmp)) && tmp[0])
        snprintf(g_xgr_cfg.publisher, sizeof(g_xgr_cfg.publisher), "%s", tmp);
    if (xml_extract_tag_attr(xml, "Identity", "Version", ver_str, sizeof(ver_str)) && ver_str[0])
        parse_version_quad(ver_str, &g_xgr_cfg.version);

    if (xml_extract_tag_value(xml, "TitleId", tmp, sizeof(tmp)) && tmp[0]) {
        uint32_t tid = parse_flexible_title_id(tmp, 16);
        if (tid != 0) {
            g_xgr_cfg.titleId = tid;
            snprintf(g_xgr_cfg.titleIdHex, sizeof(g_xgr_cfg.titleIdHex), "%08X", g_xgr_cfg.titleId);
        }
    }
    if (xml_extract_tag_value(xml, "MSAAppId", tmp, sizeof(tmp)) && tmp[0])
        snprintf(g_xgr_cfg.msaAppId, sizeof(g_xgr_cfg.msaAppId), "%s", tmp);
    if (xml_extract_tag_value(xml, "StoreId", tmp, sizeof(tmp)) && tmp[0]) {
        for (size_t i = 0; tmp[i]; i++) tmp[i] = (char)toupper((unsigned char)tmp[i]);
        snprintf(g_xgr_cfg.storeId, sizeof(g_xgr_cfg.storeId), "%s", tmp);
    }
    if (xml_extract_tag_value(xml, "Scid", tmp, sizeof(tmp)) && tmp[0]) {
        for (size_t i = 0; tmp[i]; i++) tmp[i] = (char)tolower((unsigned char)tmp[i]);
        snprintf(g_xgr_cfg.scid, sizeof(g_xgr_cfg.scid), "%s", tmp);
    }
    if (!g_xgr_cfg.scid[0]) {
        /* Also check <ExtendedAttribute Name="Scid" Value="..." /> */
        const char *ext = ci_find(xml, "Name=\"Scid\"");
        if (!ext) ext = ci_find(xml, "Name='Scid'");
        if (ext) {
            const char *lt = ext;
            while (lt > xml && *lt != '<') lt--;
            const char *gt = strchr(ext, '>');
            if (gt && xml_extract_attr_from_element(lt, gt, "Value", tmp, sizeof(tmp)) && tmp[0]) {
                for (size_t i = 0; tmp[i]; i++) tmp[i] = (char)tolower((unsigned char)tmp[i]);
                snprintf(g_xgr_cfg.scid, sizeof(g_xgr_cfg.scid), "%s", tmp);
            }
        }
    }
    if (g_xgr_cfg.titleId != 0) {
        char canonical_scid[64];
        snprintf(canonical_scid, sizeof(canonical_scid), "00000000-0000-0000-0000-0000%08x", g_xgr_cfg.titleId);
        if (!g_xgr_cfg.scid[0] ||
            (is_titleid_derived_scid_prefix(g_xgr_cfg.scid) && _stricmp(g_xgr_cfg.scid, canonical_scid) != 0)) {
            snprintf(g_xgr_cfg.scid, sizeof(g_xgr_cfg.scid), "%s", canonical_scid);
        }
    }
    if (xml_extract_tag_attr(xml, "ShellVisuals", "DefaultDisplayName", tmp, sizeof(tmp)) && tmp[0])
        snprintf(g_xgr_cfg.displayName, sizeof(g_xgr_cfg.displayName), "%s", tmp);

    free(no_dev);
    free(clean);
}

static void apply_appx_manifest_xml(const char *raw_xml)
{
    if (!raw_xml || !*raw_xml) return;
    char *clean = xml_strip_comments_alloc(raw_xml);
    const char *xml = clean ? clean : raw_xml;

    char tmp[512] = {0};
    g_xgr_cfg.packaged = true;

    if (!g_xgr_cfg.identityName[0] && xml_extract_tag_attr(xml, "Identity", "Name", tmp, sizeof(tmp)))
        snprintf(g_xgr_cfg.identityName, sizeof(g_xgr_cfg.identityName), "%s", tmp);
    if (!g_xgr_cfg.publisher[0] && xml_extract_tag_attr(xml, "Identity", "Publisher", tmp, sizeof(tmp)))
        snprintf(g_xgr_cfg.publisher, sizeof(g_xgr_cfg.publisher), "%s", tmp);
    if (g_xgr_cfg.version.Value == 0 && xml_extract_tag_attr(xml, "Identity", "Version", tmp, sizeof(tmp)))
        parse_version_quad(tmp, &g_xgr_cfg.version);
    if (!g_xgr_cfg.displayName[0] && xml_extract_tag_value(xml, "DisplayName", tmp, sizeof(tmp)))
        snprintf(g_xgr_cfg.displayName, sizeof(g_xgr_cfg.displayName), "%s", tmp);
    if (ci_find(xml, "Windows.FullTrustApplication") || ci_find(xml, "runFullTrust") || ci_find(xml, "mediumIL"))
        g_xgr_cfg.fullTrust = true;

    free(clean);
}

static bool read_first_nonempty_env(const WCHAR *primary_name, const WCHAR *secondary_name, char *out_buf, size_t out_cap)
{
    if (primary_name && xgr_get_env_utf8(primary_name, out_buf, out_cap) && out_buf[0]) {
        return true;
    }
    if (secondary_name && xgr_get_env_utf8(secondary_name, out_buf, out_cap) && out_buf[0]) {
        return true;
    }
    return false;
}

void xgr_load_runtime_config(const struct xgr_initialize_options *options)
{
    AcquireSRWLockExclusive(&g_xgr_cfg.lock);
    if (g_xgr_cfg.initialized && !(options && options->gameConfig)) {
        ReleaseSRWLockExclusive(&g_xgr_cfg.lock);
        return;
    }

    if (!g_xgr_cfg.initialized) {
        g_xgr_cfg.version.major = 1;
        g_xgr_cfg.fullTrust = true;
    }

    /* 1. Inline MicrosoftGame.config XML or UTF-8 path passed directly via InitializeApiImplEx2 */
    if (options && options->gameConfig && options->gameConfig[0]) {
        if (options->isInline || strchr(options->gameConfig, '<') != NULL) {
            apply_game_config_xml(options->gameConfig);
        } else {
            WCHAR *cfg_path = utf8_to_wide_heap(options->gameConfig);
            if (cfg_path) {
                char *xml = read_utf8_file_alloc(cfg_path);
                if (xml) {
                    apply_game_config_xml(xml);
                    free(xml);
                }
                free(cfg_path);
            }
        }
    }

    /* 2. Walk up to 5 parent directories from dynamic heap GetModuleFileNameW(NULL) */
    char receipt_pfn[256] = {0};
    char receipt_scid[128] = {0};
    char receipt_store_id[64] = {0};
    char receipt_title_id[64] = {0};

    WCHAR *dir = get_main_module_path_heap();
    if (dir) {
        WCHAR *slash = wcsrchr(dir, L'\\');
        if (!slash) slash = wcsrchr(dir, L'/');
        if (slash) *slash = L'\0';

        if (!g_xgr_cfg.gameRootWide[0]) {
            store_game_root_wide(dir);
        }

        for (int depth = 0; depth <= 5 && dir[0]; depth++) {
            /* Probe One Launcher install/receipt metadata (executable dir + ancestor dirs) */
            const WCHAR *meta_rel[2] = { L".onelauncher-xbox-receipt.json", L".onelauncher-xbox-install.json" };
            for (int r = 0; r < 2; r++) {
                WCHAR *candidate = join_wide_path_heap(dir, meta_rel[r]);
                if (!candidate) continue;
                char *meta_json = read_utf8_file_alloc(candidate);
                free(candidate);
                if (meta_json) {
                    if (!receipt_pfn[0])
                        xgr_json_get_string(meta_json, "packageFamilyName", receipt_pfn, sizeof(receipt_pfn));
                    if (!receipt_scid[0])
                        xgr_json_get_string(meta_json, "scid", receipt_scid, sizeof(receipt_scid));
                    if (!receipt_store_id[0])
                        xgr_json_get_string(meta_json, "xboxProductId", receipt_store_id, sizeof(receipt_store_id));
                    if (!receipt_title_id[0])
                        xgr_json_get_string(meta_json, "xboxTitleId", receipt_title_id, sizeof(receipt_title_id));
                    if (!g_xgr_cfg.msaAppId[0])
                        xgr_json_get_string(meta_json, "msaAppId", g_xgr_cfg.msaAppId, sizeof(g_xgr_cfg.msaAppId));
                    free(meta_json);
                }
            }

            /* Probe <dir>\MicrosoftGame.config and <dir>\Content\MicrosoftGame.config (including common case variants) */
            if (!g_xgr_cfg.identityName[0] || (!g_xgr_cfg.titleId && !g_xgr_cfg.storeId[0])) {
                const WCHAR *mgc_rel[6] = {
                    L"MicrosoftGame.config", L"MicrosoftGame.Config", L"microsoftgame.config",
                    L"Content\\MicrosoftGame.config", L"Content\\MicrosoftGame.Config", L"Content\\microsoftgame.config"
                };
                for (int r = 0; r < 6; r++) {
                    WCHAR *candidate = join_wide_path_heap(dir, mgc_rel[r]);
                    if (!candidate) continue;
                    char *xml = read_utf8_file_alloc(candidate);
                    free(candidate);
                    if (xml) {
                        apply_game_config_xml(xml);
                        free(xml);
                        store_game_root_wide(dir);
                        break;
                    }
                }
            }

            /* Probe <dir>\AppxManifest.xml and <dir>\Content\AppxManifest.xml (including lowercase appxmanifest.xml) */
            if (!g_xgr_cfg.identityName[0] || !g_xgr_cfg.publisher[0]) {
                const WCHAR *appx_rel[4] = {
                    L"AppxManifest.xml", L"appxmanifest.xml",
                    L"Content\\AppxManifest.xml", L"Content\\appxmanifest.xml"
                };
                for (int r = 0; r < 4; r++) {
                    WCHAR *candidate = join_wide_path_heap(dir, appx_rel[r]);
                    if (!candidate) continue;
                    char *xml = read_utf8_file_alloc(candidate);
                    free(candidate);
                    if (xml) {
                        apply_appx_manifest_xml(xml);
                        free(xml);
                        break;
                    }
                }
            }

            if (receipt_pfn[0] && g_xgr_cfg.identityName[0] && (g_xgr_cfg.titleId != 0 || g_xgr_cfg.storeId[0]))
                break;

            WCHAR *parent_slash = wcsrchr(dir, L'\\');
            if (!parent_slash) parent_slash = wcsrchr(dir, L'/');
            if (!parent_slash || parent_slash <= dir + 2) break;
            *parent_slash = L'\0';
        }
        free(dir);
    }

    /* 3. Allow explicit wide environment overrides passed by One Launcher (both canonical & short names) */
    char env_buf[512];
    if (read_first_nonempty_env(L"ONE_LAUNCHER_XBOX_PFN", L"ONE_XGR_PFN", env_buf, sizeof(env_buf))) {
        snprintf(g_xgr_cfg.packageFamilyName, sizeof(g_xgr_cfg.packageFamilyName), "%s", env_buf);
    }
    if (read_first_nonempty_env(L"ONE_LAUNCHER_XBOX_SCID", L"ONE_XGR_SCID", env_buf, sizeof(env_buf))) {
        for (size_t i = 0; env_buf[i]; i++) env_buf[i] = (char)tolower((unsigned char)env_buf[i]);
        snprintf(g_xgr_cfg.scid, sizeof(g_xgr_cfg.scid), "%s", env_buf);
    }
    if (read_first_nonempty_env(L"ONE_LAUNCHER_XBOX_STORE_ID", L"ONE_XGR_STORE_ID", env_buf, sizeof(env_buf))) {
        for (size_t i = 0; env_buf[i]; i++) env_buf[i] = (char)toupper((unsigned char)env_buf[i]);
        snprintf(g_xgr_cfg.storeId, sizeof(g_xgr_cfg.storeId), "%s", env_buf);
    }
    if (read_first_nonempty_env(L"ONE_LAUNCHER_XBOX_TITLE_ID", L"ONE_XGR_TITLE_ID", env_buf, sizeof(env_buf))) {
        uint32_t env_tid = parse_flexible_title_id(env_buf, 16);
        if (env_tid != 0) {
            g_xgr_cfg.titleId = env_tid;
            snprintf(g_xgr_cfg.titleIdHex, sizeof(g_xgr_cfg.titleIdHex), "%08X", g_xgr_cfg.titleId);
        }
    }

    /* 4. Fall back to Store catalog metadata in .onelauncher-xbox-{receipt,install}.json before hashing CN=... */
    if (!g_xgr_cfg.packageFamilyName[0] && receipt_pfn[0]) {
        snprintf(g_xgr_cfg.packageFamilyName, sizeof(g_xgr_cfg.packageFamilyName), "%s", receipt_pfn);
    }
    if (!g_xgr_cfg.scid[0] && receipt_scid[0]) {
        for (size_t i = 0; receipt_scid[i]; i++) receipt_scid[i] = (char)tolower((unsigned char)receipt_scid[i]);
        snprintf(g_xgr_cfg.scid, sizeof(g_xgr_cfg.scid), "%s", receipt_scid);
    }
    if (!g_xgr_cfg.storeId[0] && receipt_store_id[0]) {
        for (size_t i = 0; receipt_store_id[i]; i++) receipt_store_id[i] = (char)toupper((unsigned char)receipt_store_id[i]);
        snprintf(g_xgr_cfg.storeId, sizeof(g_xgr_cfg.storeId), "%s", receipt_store_id);
    }
    if (!g_xgr_cfg.titleId && receipt_title_id[0]) {
        uint32_t rtid = parse_flexible_title_id(receipt_title_id, 16);
        if (rtid != 0) {
            g_xgr_cfg.titleId = rtid;
            snprintf(g_xgr_cfg.titleIdHex, sizeof(g_xgr_cfg.titleIdHex), "%08X", g_xgr_cfg.titleId);
        }
    }

    if (!g_xgr_cfg.packageFamilyName[0] && g_xgr_cfg.identityName[0] && g_xgr_cfg.publisher[0]) {
        xgr_compute_package_family_name(
            g_xgr_cfg.identityName,
            g_xgr_cfg.publisher,
            g_xgr_cfg.packageFamilyName,
            sizeof(g_xgr_cfg.packageFamilyName)
        );
    }
    if (!g_xgr_cfg.packageFamilyName[0]) {
        snprintf(g_xgr_cfg.packageFamilyName, sizeof(g_xgr_cfg.packageFamilyName), "OneLauncher.XboxTitle_8wekyb3d8bbwe");
    }
    if (!g_xgr_cfg.scid[0] && g_xgr_cfg.titleId != 0) {
        snprintf(g_xgr_cfg.scid, sizeof(g_xgr_cfg.scid), "00000000-0000-0000-0000-0000%08x", g_xgr_cfg.titleId);
    }
    if (!g_xgr_cfg.displayName[0]) {
        snprintf(g_xgr_cfg.displayName, sizeof(g_xgr_cfg.displayName), "%s",
                 g_xgr_cfg.identityName[0] ? g_xgr_cfg.identityName : "Xbox Game");
    }

    /* Canonical 32-char packageIdentifier derived from PFN or StoreId */
    if (g_xgr_cfg.storeId[0]) {
        snprintf(g_xgr_cfg.packageIdentifier, sizeof(g_xgr_cfg.packageIdentifier), "%s_onelauncher", g_xgr_cfg.storeId);
    } else {
        snprintf(g_xgr_cfg.packageIdentifier, sizeof(g_xgr_cfg.packageIdentifier), "%.32s", g_xgr_cfg.packageFamilyName);
    }

    g_xgr_cfg.initialized = true;
    ReleaseSRWLockExclusive(&g_xgr_cfg.lock);
}

void xgr_copy_runtime_config_snapshot(struct xgr_runtime_config_snapshot *out_snap)
{
    if (!out_snap) return;
    AcquireSRWLockShared(&g_xgr_cfg.lock);
    bool init = g_xgr_cfg.initialized;
    ReleaseSRWLockShared(&g_xgr_cfg.lock);
    if (!init) {
        xgr_load_runtime_config(NULL);
    }

    AcquireSRWLockShared(&g_xgr_cfg.lock);
    out_snap->initialized = g_xgr_cfg.initialized;
    out_snap->packaged = g_xgr_cfg.packaged;
    out_snap->fullTrust = g_xgr_cfg.fullTrust;
    out_snap->titleId = g_xgr_cfg.titleId;
    memcpy(out_snap->titleIdHex, g_xgr_cfg.titleIdHex, sizeof(out_snap->titleIdHex));
    memcpy(out_snap->scid, g_xgr_cfg.scid, sizeof(out_snap->scid));
    memcpy(out_snap->msaAppId, g_xgr_cfg.msaAppId, sizeof(out_snap->msaAppId));
    memcpy(out_snap->storeId, g_xgr_cfg.storeId, sizeof(out_snap->storeId));
    memcpy(out_snap->identityName, g_xgr_cfg.identityName, sizeof(out_snap->identityName));
    memcpy(out_snap->publisher, g_xgr_cfg.publisher, sizeof(out_snap->publisher));
    memcpy(out_snap->packageFamilyName, g_xgr_cfg.packageFamilyName, sizeof(out_snap->packageFamilyName));
    memcpy(out_snap->packageIdentifier, g_xgr_cfg.packageIdentifier, sizeof(out_snap->packageIdentifier));
    memcpy(out_snap->displayName, g_xgr_cfg.displayName, sizeof(out_snap->displayName));
    out_snap->version = g_xgr_cfg.version;
    ReleaseSRWLockShared(&g_xgr_cfg.lock);
}

void xgr_copy_game_root_utf8(char *out_buf, size_t out_size)
{
    if (!out_buf || out_size == 0) return;
    AcquireSRWLockShared(&g_xgr_cfg.lock);
    bool init = g_xgr_cfg.initialized;
    ReleaseSRWLockShared(&g_xgr_cfg.lock);
    if (!init) {
        xgr_load_runtime_config(NULL);
    }

    AcquireSRWLockShared(&g_xgr_cfg.lock);
    snprintf(out_buf, out_size, "%s", g_xgr_cfg.gameRootUtf8);
    ReleaseSRWLockShared(&g_xgr_cfg.lock);
}
