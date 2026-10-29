/*
 * One Launcher — Host POSIX Win32 Compatibility Shim (`tests/native/win32_host_shim.h`)
 *
 * Allows compiling the unmodified Win32 C11 Xbox Game Runtime Bridge translation units
 * (`electron/helpers/xgr_bridge/`) directly on macOS / Linux Host Clang with:
 *   -std=c11 -O1 -g -fshort-wchar -fsanitize=address,undefined -fno-omit-frame-pointer -Wall -Wextra -Werror
 */

#ifndef ONE_TEST_WIN32_HOST_SHIM_H
#define ONE_TEST_WIN32_HOST_SHIM_H

#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE 1
#endif
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <sched.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

_Static_assert(sizeof(wchar_t) == 2, "win32_host_shim.h requires -fshort-wchar (2-byte UTF-16LE wchar_t)");

/* -------------------------------------------------------------------------
 * Atomic Heap Leak Tracker (shared across all translation units)
 * ------------------------------------------------------------------------- */

extern _Atomic int64_t g_win32_live_allocs;

static inline void *win32_tracked_malloc(size_t sz)
{
    void *p = malloc(sz ? sz : 1);
    if (p) atomic_fetch_add_explicit(&g_win32_live_allocs, 1, memory_order_relaxed);
    return p;
}

static inline void *win32_tracked_calloc(size_t count, size_t sz)
{
    void *p = calloc(count ? count : 1, sz ? sz : 1);
    if (p) atomic_fetch_add_explicit(&g_win32_live_allocs, 1, memory_order_relaxed);
    return p;
}

static inline void *win32_tracked_realloc(void *old_ptr, size_t sz)
{
    if (!old_ptr) return win32_tracked_malloc(sz);
    return realloc(old_ptr, sz ? sz : 1);
}

static inline char *win32_tracked_strdup(const char *s)
{
    const char *src = s ? s : "";
    size_t n = strlen(src) + 1;
    char *p = (char *)win32_tracked_malloc(n);
    if (p) memcpy(p, src, n);
    return p;
}

static inline void win32_tracked_free(void *p)
{
    if (!p) return;
    atomic_fetch_sub_explicit(&g_win32_live_allocs, 1, memory_order_relaxed);
    free(p);
}

/* -------------------------------------------------------------------------
 * Win32 Calling Conventions & Scalar Types
 * ------------------------------------------------------------------------- */

#define WINAPI
#define CALLBACK
#define NTAPI
#define PASCAL

typedef void VOID;
typedef int BOOL;
typedef uint8_t BOOLEAN;
typedef uint8_t BYTE;
typedef uint8_t UCHAR;
typedef uint16_t USHORT;
typedef uint16_t WORD;
typedef uint32_t DWORD;
typedef uint32_t ULONG;
typedef int32_t LONG;
typedef int32_t INT32;
typedef uint32_t UINT32;
typedef int64_t INT64;
typedef uint64_t UINT64;
typedef int64_t LONGLONG;
typedef uint64_t ULONGLONG;
typedef size_t SIZE_T;
typedef int32_t HRESULT;
typedef wchar_t WCHAR;
typedef void *PVOID;
typedef void *LPVOID;
typedef const void *LPCVOID;
typedef WCHAR *LPWSTR;
typedef const WCHAR *LPCWSTR;
typedef char *LPSTR;
typedef const char *LPCSTR;
typedef void *HANDLE;
typedef void *HINSTANCE;
typedef void *HMODULE;

#ifndef TRUE
#define TRUE 1
#endif
#ifndef FALSE
#define FALSE 0
#endif

#define MAX_PATH                    260
#define MAX_COMPUTERNAME_LENGTH     15
#define LOCALE_NAME_MAX_LENGTH      85
#define CP_UTF8                     65001
#define INFINITE                    0xFFFFFFFFu
#define INVALID_HANDLE_VALUE        ((HANDLE)(intptr_t)-1)
#define TLS_OUT_OF_INDEXES          0xFFFFFFFFu

#define WAIT_OBJECT_0               0x00000000u
#define WAIT_TIMEOUT                258u
#define WAIT_FAILED                 0xFFFFFFFFu
#define WT_EXECUTEDEFAULT           0x00000000u

#define DLL_PROCESS_DETACH          0u
#define DLL_PROCESS_ATTACH          1u
#define DLL_THREAD_ATTACH           2u
#define DLL_THREAD_DETACH           3u

#define GENERIC_READ                0x80000000u
#define GENERIC_WRITE               0x40000000u
#define FILE_SHARE_READ             0x00000001u
#define FILE_SHARE_WRITE            0x00000002u
#define CREATE_ALWAYS               2u
#define OPEN_EXISTING               3u
#define FILE_ATTRIBUTE_DIRECTORY    0x00000010u
#define FILE_ATTRIBUTE_NORMAL       0x00000080u
#define MOVEFILE_REPLACE_EXISTING   0x00000001u
#define MOVEFILE_WRITE_THROUGH      0x00000008u

/* Win32 Error Codes & Standard HRESULTs */
#define ERROR_SUCCESS               0u
#define ERROR_FILE_NOT_FOUND        2u
#define ERROR_PATH_NOT_FOUND        3u
#define ERROR_ACCESS_DENIED         5u
#define ERROR_INVALID_HANDLE        6u
#define ERROR_NOT_ENOUGH_MEMORY     8u
#define ERROR_INVALID_PARAMETER     87u
#define ERROR_INSUFFICIENT_BUFFER   122u
#define ERROR_ENVVAR_NOT_FOUND      203u
#define ERROR_NOT_FOUND             1168u
#define ERROR_CONNECTION_REFUSED    1225u
#define ERROR_CONNECTION_ABORTED    1236u

#define S_OK                        ((HRESULT)0x00000000L)
#define S_FALSE                     ((HRESULT)0x00000001L)
#define E_PENDING                   ((HRESULT)0x8000000AL)
#define E_NOTIMPL                   ((HRESULT)0x80004001L)
#define E_NOINTERFACE               ((HRESULT)0x80004002L)
#define E_POINTER                   ((HRESULT)0x80004003L)
#define E_ABORT                     ((HRESULT)0x80004004L)
#define E_FAIL                      ((HRESULT)0x80004005L)
#define E_UNEXPECTED                ((HRESULT)0x8000FFFFL)
#define E_ACCESSDENIED              ((HRESULT)0x80070005L)
#define E_OUTOFMEMORY               ((HRESULT)0x8007000EL)
#define E_INVALIDARG                ((HRESULT)0x80070057L)
#ifndef REGDB_E_CLASSNOTREG
#define REGDB_E_CLASSNOTREG         ((HRESULT)0x80040154L)
#endif

#define SUCCEEDED(hr)               (((HRESULT)(hr)) >= 0)
#define FAILED(hr)                  (((HRESULT)(hr)) < 0)
#define HRESULT_FROM_WIN32(x)       ((HRESULT)(x) <= 0 ? ((HRESULT)(x)) : ((HRESULT)(((x) & 0x0000FFFFu) | 0x80070000u)))

/* -------------------------------------------------------------------------
 * GUID & COM Primitives
 * ------------------------------------------------------------------------- */

typedef struct _GUID {
    uint32_t Data1;
    uint16_t Data2;
    uint16_t Data3;
    uint8_t Data4[8];
} GUID;

typedef GUID IID;
typedef GUID CLSID;
typedef const GUID *REFGUID;
typedef const IID *REFIID;
typedef const CLSID *REFCLSID;

extern const GUID IID_IUnknown;
extern _Atomic uint64_t g_win32_guid_counter;

static inline BOOL IsEqualGUID(REFGUID r1, REFGUID r2)
{
    if (r1 == r2) return TRUE;
    if (!r1 || !r2) return FALSE;
    return memcmp(r1, r2, sizeof(GUID)) == 0 ? TRUE : FALSE;
}

static inline HRESULT CoCreateGuid(GUID *pguid)
{
    if (!pguid) return E_INVALIDARG;
    /* Write all 16 bytes deterministically so ASan catches any undersized buffer immediately */
    uint64_t seq = atomic_fetch_add_explicit(&g_win32_guid_counter, 1, memory_order_relaxed);
    uint64_t a = 0x9E3779B97F4A7C15ULL ^ (seq * 0xBF58476D1CE4E5B9ULL);
    uint64_t b = 0xD1B54A32D192ED03ULL ^ ((seq + 1ULL) * 0x94D049BB133111EBULL);
    pguid->Data1 = (uint32_t)(a >> 32);
    pguid->Data2 = (uint16_t)(a >> 16);
    pguid->Data3 = (uint16_t)((a & 0x0FFFu) | 0x4000u); /* RFC-4122 v4 */
    for (int i = 0; i < 8; i++) {
        pguid->Data4[i] = (uint8_t)(b >> (i * 8));
    }
    pguid->Data4[0] = (uint8_t)((pguid->Data4[0] & 0x3Fu) | 0x80u);
    return S_OK;
}

/* -------------------------------------------------------------------------
 * Winsock2 Compatibility Layer
 * ------------------------------------------------------------------------- */

typedef int SOCKET;
#define INVALID_SOCKET (-1)

typedef struct WSAData {
    WORD wVersion;
    WORD wHighVersion;
} WSADATA;

#define MAKEWORD(a, b) ((WORD)(((BYTE)((a) & 0xff)) | ((WORD)((BYTE)((b) & 0xff))) << 8))

static inline int WSAStartup(WORD ver, WSADATA *wsa)
{
    if (wsa) {
        wsa->wVersion = ver;
        wsa->wHighVersion = ver;
    }
    return 0;
}

static inline int WSACleanup(void) { return 0; }
static inline int closesocket(SOCKET s) { return (s >= 0) ? close(s) : 0; }

/* -------------------------------------------------------------------------
 * CRT Aliases, SecureZeroMemory & LastError
 * ------------------------------------------------------------------------- */

#define _strnicmp strncasecmp
#define _stricmp  strcasecmp
#define _strtoi64 strtoll
#define _strtoui64 strtoull

static inline PVOID SecureZeroMemory(PVOID ptr, SIZE_T cnt)
{
    volatile uint8_t *vptr = (volatile uint8_t *)ptr;
    while (cnt--) *vptr++ = 0;
    return ptr;
}

extern _Thread_local DWORD g_win32_tls_last_error;

static inline DWORD GetLastError(void) { return g_win32_tls_last_error; }
static inline void SetLastError(DWORD err) { g_win32_tls_last_error = err; }
static inline void __writegsdword(unsigned long offset, DWORD data) { (void)offset; (void)data; }
static inline BOOL DisableThreadLibraryCalls(HMODULE hMod) { (void)hMod; return TRUE; }
static inline BOOL IsDebuggerPresent(void) { return FALSE; }
static inline void OutputDebugStringA(LPCSTR str) { (void)str; }

extern _Atomic uint32_t g_win32_next_tid;
extern _Thread_local uint32_t g_win32_self_tid;

static inline DWORD GetCurrentThreadId(void)
{
    if (g_win32_self_tid == 0) {
        g_win32_self_tid = atomic_fetch_add_explicit(&g_win32_next_tid, 1, memory_order_relaxed);
    }
    return g_win32_self_tid;
}

static inline ULONGLONG GetTickCount64(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (ULONGLONG)ts.tv_sec * 1000ULL + (ULONGLONG)(ts.tv_nsec / 1000000L);
}

static inline void Sleep(DWORD ms)
{
    struct timespec req;
    req.tv_sec = (time_t)(ms / 1000u);
    req.tv_nsec = (long)(ms % 1000u) * 1000000L;
    nanosleep(&req, NULL);
}

typedef struct _FILETIME {
    DWORD dwLowDateTime;
    DWORD dwHighDateTime;
} FILETIME;

typedef union _LARGE_INTEGER {
    struct {
        DWORD LowPart;
        LONG HighPart;
    };
    LONGLONG QuadPart;
} LARGE_INTEGER;

static inline void GetSystemTimeAsFileTime(FILETIME *ft)
{
    if (!ft) return;
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    uint64_t ticks = ((uint64_t)ts.tv_sec + 11644473600ULL) * 10000000ULL + (uint64_t)(ts.tv_nsec / 100L);
    ft->dwLowDateTime = (DWORD)(ticks & 0xFFFFFFFFULL);
    ft->dwHighDateTime = (DWORD)(ticks >> 32);
}

/* -------------------------------------------------------------------------
 * Self-Contained 2-Byte UTF-16LE Wide String & UTF-8 Conversion Helpers
 * (Never calls macOS libSystem 4-byte wchar_t functions!)
 * ------------------------------------------------------------------------- */

static inline size_t win32_wcslen(const wchar_t *s)
{
    if (!s) return 0;
    size_t n = 0;
    while (s[n] != 0) n++;
    return n;
}

static inline wchar_t *win32_wcscpy(wchar_t *dst, const wchar_t *src)
{
    if (!dst) return NULL;
    size_t i = 0;
    if (src) {
        while (src[i] != 0) {
            dst[i] = src[i];
            i++;
        }
    }
    dst[i] = 0;
    return dst;
}

static inline wchar_t *win32_wcsncpy(wchar_t *dst, const wchar_t *src, size_t n)
{
    if (!dst) return NULL;
    size_t i = 0;
    if (src) {
        for (; i < n && src[i] != 0; i++) {
            dst[i] = src[i];
        }
    }
    for (; i < n; i++) {
        dst[i] = 0;
    }
    return dst;
}

static inline wchar_t *win32_wcsrchr(const wchar_t *s, wchar_t ch)
{
    if (!s) return NULL;
    const wchar_t *last = NULL;
    for (; *s != 0; s++) {
        if (*s == ch) last = s;
    }
    if (ch == 0) return (wchar_t *)s;
    return (wchar_t *)last;
}

static inline int MultiByteToWideChar(
    UINT32 codePage,
    DWORD flags,
    LPCSTR src,
    int cbMultiByte,
    LPWSTR dst,
    int cchWideChar
)
{
    (void)codePage;
    (void)flags;
    if (!src) return 0;

    bool include_nul = (cbMultiByte < 0);
    size_t slen = include_nul ? strlen(src) : (size_t)cbMultiByte;

    size_t needed = 0;
    size_t i = 0;
    while (i < slen) {
        uint32_t cp = 0;
        uint8_t b0 = (uint8_t)src[i];
        if (b0 < 0x80u) {
            cp = b0;
            i += 1;
        } else if ((b0 & 0xE0u) == 0xC0u && i + 1 < slen) {
            cp = ((uint32_t)(b0 & 0x1Fu) << 6) | ((uint32_t)src[i + 1] & 0x3Fu);
            i += 2;
        } else if ((b0 & 0xF0u) == 0xE0u && i + 2 < slen) {
            cp = ((uint32_t)(b0 & 0x0Fu) << 12) |
                 (((uint32_t)src[i + 1] & 0x3Fu) << 6) |
                 ((uint32_t)src[i + 2] & 0x3Fu);
            i += 3;
        } else if ((b0 & 0xF8u) == 0xF0u && i + 3 < slen) {
            cp = ((uint32_t)(b0 & 0x07u) << 18) |
                 (((uint32_t)src[i + 1] & 0x3Fu) << 12) |
                 (((uint32_t)src[i + 2] & 0x3Fu) << 6) |
                 ((uint32_t)src[i + 3] & 0x3Fu);
            i += 4;
        } else {
            cp = 0xFFFDu;
            i += 1;
        }
        needed += (cp <= 0xFFFFu) ? 1u : 2u;
    }
    if (include_nul) needed += 1u;

    if (cchWideChar == 0 || !dst) {
        return (int)needed;
    }

    size_t cap = (size_t)cchWideChar;
    size_t out = 0;
    i = 0;
    while (i < slen && out < cap) {
        uint32_t cp = 0;
        uint8_t b0 = (uint8_t)src[i];
        if (b0 < 0x80u) {
            cp = b0;
            i += 1;
        } else if ((b0 & 0xE0u) == 0xC0u && i + 1 < slen) {
            cp = ((uint32_t)(b0 & 0x1Fu) << 6) | ((uint32_t)src[i + 1] & 0x3Fu);
            i += 2;
        } else if ((b0 & 0xF0u) == 0xE0u && i + 2 < slen) {
            cp = ((uint32_t)(b0 & 0x0Fu) << 12) |
                 (((uint32_t)src[i + 1] & 0x3Fu) << 6) |
                 ((uint32_t)src[i + 2] & 0x3Fu);
            i += 3;
        } else if ((b0 & 0xF8u) == 0xF0u && i + 3 < slen) {
            cp = ((uint32_t)(b0 & 0x07u) << 18) |
                 (((uint32_t)src[i + 1] & 0x3Fu) << 12) |
                 (((uint32_t)src[i + 2] & 0x3Fu) << 6) |
                 ((uint32_t)src[i + 3] & 0x3Fu);
            i += 4;
        } else {
            cp = 0xFFFDu;
            i += 1;
        }

        if (cp <= 0xFFFFu) {
            dst[out++] = (wchar_t)cp;
        } else {
            if (out + 1 >= cap) break;
            uint32_t adj = cp - 0x10000u;
            dst[out++] = (wchar_t)(0xD800u | (adj >> 10));
            dst[out++] = (wchar_t)(0xDC00u | (adj & 0x3FFu));
        }
    }

    if (include_nul) {
        if (out < cap) {
            dst[out++] = 0;
        } else {
            SetLastError(ERROR_INSUFFICIENT_BUFFER);
            return 0;
        }
    }
    return (int)out;
}

static inline int WideCharToMultiByte(
    UINT32 codePage,
    DWORD flags,
    LPCWSTR src,
    int cchWideChar,
    LPSTR dst,
    int cbMultiByte,
    LPCSTR defaultChar,
    BOOL *usedDefaultChar
)
{
    (void)codePage;
    (void)flags;
    (void)defaultChar;
    if (usedDefaultChar) *usedDefaultChar = FALSE;
    if (!src) return 0;

    bool include_nul = (cchWideChar < 0);
    size_t wlen = include_nul ? win32_wcslen(src) : (size_t)cchWideChar;

    size_t needed = 0;
    size_t i = 0;
    while (i < wlen) {
        uint32_t cp = (uint16_t)src[i++];
        if (cp >= 0xD800u && cp <= 0xDBFFu && i < wlen) {
            uint32_t lo = (uint16_t)src[i];
            if (lo >= 0xDC00u && lo <= 0xDFFFu) {
                cp = 0x10000u + (((cp - 0xD800u) << 10) | (lo - 0xDC00u));
                i++;
            } else {
                cp = 0xFFFDu;
            }
        } else if (cp >= 0xDC00u && cp <= 0xDFFFu) {
            cp = 0xFFFDu;
        }
        if (cp <= 0x7Fu) needed += 1u;
        else if (cp <= 0x7FFu) needed += 2u;
        else if (cp <= 0xFFFFu) needed += 3u;
        else needed += 4u;
    }
    if (include_nul) needed += 1u;

    if (cbMultiByte == 0 || !dst) {
        return (int)needed;
    }

    size_t cap = (size_t)cbMultiByte;
    size_t out = 0;
    i = 0;
    while (i < wlen && out < cap) {
        uint32_t cp = (uint16_t)src[i++];
        if (cp >= 0xD800u && cp <= 0xDBFFu && i < wlen) {
            uint32_t lo = (uint16_t)src[i];
            if (lo >= 0xDC00u && lo <= 0xDFFFu) {
                cp = 0x10000u + (((cp - 0xD800u) << 10) | (lo - 0xDC00u));
                i++;
            } else {
                cp = 0xFFFDu;
            }
        } else if (cp >= 0xDC00u && cp <= 0xDFFFu) {
            cp = 0xFFFDu;
        }

        if (cp <= 0x7Fu) {
            dst[out++] = (char)cp;
        } else if (cp <= 0x7FFu) {
            if (out + 2 > cap) break;
            dst[out++] = (char)(0xC0u | (cp >> 6));
            dst[out++] = (char)(0x80u | (cp & 0x3Fu));
        } else if (cp <= 0xFFFFu) {
            if (out + 3 > cap) break;
            dst[out++] = (char)(0xE0u | (cp >> 12));
            dst[out++] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
            dst[out++] = (char)(0x80u | (cp & 0x3Fu));
        } else {
            if (out + 4 > cap) break;
            dst[out++] = (char)(0xF0u | (cp >> 18));
            dst[out++] = (char)(0x80u | ((cp >> 12) & 0x3Fu));
            dst[out++] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
            dst[out++] = (char)(0x80u | (cp & 0x3Fu));
        }
    }

    if (include_nul) {
        if (out < cap) {
            dst[out++] = '\0';
        } else {
            dst[cap - 1] = '\0';
            SetLastError(ERROR_INSUFFICIENT_BUFFER);
            return 0;
        }
    }
    return (int)out;
}

static inline int win32_swprintf(wchar_t *dst, size_t max_cch, const wchar_t *fmt_w, ...)
{
    if (!dst || max_cch == 0 || !fmt_w) return -1;
    dst[0] = 0;

    char accum[8192];
    size_t acc_len = 0;
    accum[0] = '\0';

    va_list ap;
    va_start(ap, fmt_w);

    const wchar_t *p = fmt_w;
    while (*p != 0 && acc_len + 8 < sizeof(accum)) {
        if (*p != (wchar_t)'%') {
            wchar_t one[2] = { *p++, 0 };
            char u8[8] = { 0 };
            int n = WideCharToMultiByte(CP_UTF8, 0, one, 1, u8, (int)sizeof(u8), NULL, NULL);
            if (n > 0 && acc_len + (size_t)n < sizeof(accum)) {
                memcpy(accum + acc_len, u8, (size_t)n);
                acc_len += (size_t)n;
            }
            continue;
        }
        p++; /* skip '%' */
        if (*p == (wchar_t)'%') {
            accum[acc_len++] = '%';
            p++;
            continue;
        }

        char spec[32];
        size_t sl = 0;
        spec[sl++] = '%';
        while (*p && sl + 4 < sizeof(spec) &&
               (*p == '-' || *p == '+' || *p == ' ' || *p == '#' || *p == '0' || *p == '.' ||
                (*p >= '0' && *p <= '9'))) {
            spec[sl++] = (char)*p++;
        }

        int len_mod = 0; /* 0=none, 1=l, 2=ll, 3=z */
        if (*p == 'l') {
            p++;
            if (*p == 'l') {
                p++;
                len_mod = 2;
                spec[sl++] = 'l';
                spec[sl++] = 'l';
            } else {
                len_mod = 1;
                if (*p != 's') spec[sl++] = 'l';
            }
        } else if (*p == 'z') {
            p++;
            len_mod = 3;
            spec[sl++] = 'z';
        }

        char conv = (char)*p;
        if (!conv) break;
        p++;

        if ((conv == 's' && len_mod == 1) || conv == 'S') {
            const wchar_t *ws = va_arg(ap, const wchar_t *);
            if (ws) {
                int need = WideCharToMultiByte(CP_UTF8, 0, ws, -1, NULL, 0, NULL, NULL);
                if (need > 1 && acc_len + (size_t)need < sizeof(accum)) {
                    int got = WideCharToMultiByte(CP_UTF8, 0, ws, -1, accum + acc_len, need, NULL, NULL);
                    if (got > 1) acc_len += (size_t)(got - 1);
                }
            }
        } else if (conv == 's') {
            const char *cs = va_arg(ap, const char *);
            if (cs) {
                size_t cl = strlen(cs);
                if (acc_len + cl < sizeof(accum)) {
                    memcpy(accum + acc_len, cs, cl);
                    acc_len += cl;
                }
            }
        } else {
            spec[sl++] = conv;
            spec[sl] = '\0';
            char formatted[128] = { 0 };
            int fn = 0;
            if (conv == 'p') {
                void *vp = va_arg(ap, void *);
                fn = snprintf(formatted, sizeof(formatted), spec, vp);
            } else if (conv == 'd' || conv == 'i') {
                if (len_mod == 2) fn = snprintf(formatted, sizeof(formatted), spec, va_arg(ap, long long));
                else if (len_mod == 1) fn = snprintf(formatted, sizeof(formatted), spec, va_arg(ap, long));
                else if (len_mod == 3) fn = snprintf(formatted, sizeof(formatted), spec, va_arg(ap, ssize_t));
                else fn = snprintf(formatted, sizeof(formatted), spec, va_arg(ap, int));
            } else {
                if (len_mod == 2) fn = snprintf(formatted, sizeof(formatted), spec, va_arg(ap, unsigned long long));
                else if (len_mod == 1) fn = snprintf(formatted, sizeof(formatted), spec, va_arg(ap, unsigned long));
                else if (len_mod == 3) fn = snprintf(formatted, sizeof(formatted), spec, va_arg(ap, size_t));
                else fn = snprintf(formatted, sizeof(formatted), spec, va_arg(ap, unsigned int));
            }
            if (fn > 0 && acc_len + (size_t)fn < sizeof(accum)) {
                memcpy(accum + acc_len, formatted, (size_t)fn);
                acc_len += (size_t)fn;
            }
        }
    }

    va_end(ap);
    accum[acc_len] = '\0';

    int wwritten = MultiByteToWideChar(CP_UTF8, 0, accum, -1, dst, (int)max_cch);
    if (wwritten <= 0) {
        dst[max_cch - 1] = 0;
        return -1;
    }
    return wwritten - 1;
}

#define wcslen  win32_wcslen
#define wcscpy  win32_wcscpy
#define wcsncpy win32_wcsncpy
#define wcsrchr win32_wcsrchr
#define swprintf win32_swprintf

static inline BOOL GetComputerNameW(LPWSTR buf, DWORD *size)
{
    const char *cname = "ONELAUNCHER-MAC";
    int need = MultiByteToWideChar(CP_UTF8, 0, cname, -1, NULL, 0);
    if (!buf || !size || *size < (DWORD)need) return FALSE;
    MultiByteToWideChar(CP_UTF8, 0, cname, -1, buf, (int)*size);
    *size = (DWORD)(need - 1);
    return TRUE;
}

static inline int GetUserDefaultLocaleName(LPWSTR buf, int cch)
{
    if (!buf || cch < 6) return 0;
    return MultiByteToWideChar(CP_UTF8, 0, "en-US", -1, buf, cch);
}

/* -------------------------------------------------------------------------
 * Interlocked Atomics & Synchronization Primitives
 * ------------------------------------------------------------------------- */

static inline LONG InterlockedIncrement(volatile LONG *p)
{
    return __atomic_add_fetch(p, 1, __ATOMIC_SEQ_CST);
}

static inline LONG InterlockedDecrement(volatile LONG *p)
{
    return __atomic_sub_fetch(p, 1, __ATOMIC_SEQ_CST);
}

static inline LONG InterlockedExchange(volatile LONG *p, LONG v)
{
    return __atomic_exchange_n(p, v, __ATOMIC_SEQ_CST);
}

static inline LONG InterlockedCompareExchange(volatile LONG *p, LONG exch, LONG comp)
{
    LONG expected = comp;
    __atomic_compare_exchange_n(p, &expected, exch, false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
    return expected;
}

static inline LONGLONG InterlockedIncrement64(volatile LONGLONG *p)
{
    return __atomic_add_fetch(p, 1, __ATOMIC_SEQ_CST);
}

static inline PVOID InterlockedExchangePointer(PVOID volatile *target, PVOID val)
{
    return __atomic_exchange_n(target, val, __ATOMIC_SEQ_CST);
}

/* Zero-alloc atomic SRWLOCK supporting SRWLOCK_INIT ({0}) */
typedef struct _SRWLOCK {
    volatile int32_t state; /* 0 = unlocked, >0 = readers, -1 = exclusive writer */
} SRWLOCK;
#define SRWLOCK_INIT { 0 }

static inline void AcquireSRWLockExclusive(SRWLOCK *lock)
{
    for (;;) {
        int32_t expected = 0;
        if (__atomic_compare_exchange_n(&lock->state, &expected, -1, false, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) {
            return;
        }
        sched_yield();
    }
}

static inline void ReleaseSRWLockExclusive(SRWLOCK *lock)
{
    __atomic_store_n(&lock->state, 0, __ATOMIC_RELEASE);
}

static inline void AcquireSRWLockShared(SRWLOCK *lock)
{
    for (;;) {
        int32_t cur = __atomic_load_n(&lock->state, __ATOMIC_RELAXED);
        if (cur >= 0) {
            if (__atomic_compare_exchange_n(&lock->state, &cur, cur + 1, false, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) {
                return;
            }
        } else {
            sched_yield();
        }
    }
}

static inline void ReleaseSRWLockShared(SRWLOCK *lock)
{
    __atomic_sub_fetch(&lock->state, 1, __ATOMIC_RELEASE);
}

/* CRITICAL_SECTION & CONDITION_VARIABLE */
typedef struct _CRITICAL_SECTION {
    pthread_mutex_t mu;
    bool initialized;
} CRITICAL_SECTION;

typedef struct _CONDITION_VARIABLE {
    pthread_cond_t cv;
    bool initialized;
} CONDITION_VARIABLE;

static inline void InitializeCriticalSection(CRITICAL_SECTION *cs)
{
    pthread_mutexattr_t attr;
    pthread_mutexattr_init(&attr);
    pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_RECURSIVE);
    pthread_mutex_init(&cs->mu, &attr);
    pthread_mutexattr_destroy(&attr);
    cs->initialized = true;
}

static inline void DeleteCriticalSection(CRITICAL_SECTION *cs)
{
    if (cs && cs->initialized) {
        pthread_mutex_destroy(&cs->mu);
        cs->initialized = false;
    }
}

static inline void EnterCriticalSection(CRITICAL_SECTION *cs)
{
    pthread_mutex_lock(&cs->mu);
}

static inline void LeaveCriticalSection(CRITICAL_SECTION *cs)
{
    pthread_mutex_unlock(&cs->mu);
}

static inline void InitializeConditionVariable(CONDITION_VARIABLE *cv)
{
    pthread_cond_init(&cv->cv, NULL);
    cv->initialized = true;
}

static inline void WakeConditionVariable(CONDITION_VARIABLE *cv)
{
    pthread_cond_signal(&cv->cv);
}

static inline void WakeAllConditionVariable(CONDITION_VARIABLE *cv)
{
    pthread_cond_broadcast(&cv->cv);
}

static inline BOOL SleepConditionVariableCS(CONDITION_VARIABLE *cv, CRITICAL_SECTION *cs, DWORD timeoutMs)
{
    if (timeoutMs == INFINITE) {
        return pthread_cond_wait(&cv->cv, &cs->mu) == 0 ? TRUE : FALSE;
    }
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += (time_t)(timeoutMs / 1000u);
    ts.tv_nsec += (long)(timeoutMs % 1000u) * 1000000L;
    if (ts.tv_nsec >= 1000000000L) {
        ts.tv_sec += 1;
        ts.tv_nsec -= 1000000000L;
    }
    int rc = pthread_cond_timedwait(&cv->cv, &cs->mu, &ts);
    if (rc == ETIMEDOUT) {
        SetLastError(WAIT_TIMEOUT);
        return FALSE;
    }
    return rc == 0 ? TRUE : FALSE;
}

/* INIT_ONCE supporting both INIT_ONCE_STATIC_INIT and InitOnceInitialize reset */
typedef struct _INIT_ONCE {
    volatile int32_t state; /* 0 = uninit, 1 = running, 2 = done */
} INIT_ONCE, *PINIT_ONCE;
#define INIT_ONCE_STATIC_INIT { 0 }

typedef BOOL (CALLBACK *PINIT_ONCE_FN)(PINIT_ONCE, PVOID, PVOID *);

static inline void InitOnceInitialize(PINIT_ONCE once)
{
    if (once) __atomic_store_n(&once->state, 0, __ATOMIC_SEQ_CST);
}

static inline BOOL InitOnceExecuteOnce(PINIT_ONCE once, PINIT_ONCE_FN fn, PVOID param, PVOID *ctx)
{
    for (;;) {
        int32_t cur = __atomic_load_n(&once->state, __ATOMIC_ACQUIRE);
        if (cur == 2) return TRUE;
        if (cur == 0) {
            int32_t expected = 0;
            if (__atomic_compare_exchange_n(&once->state, &expected, 1, false, __ATOMIC_ACQ_REL, __ATOMIC_RELAXED)) {
                BOOL ok = fn(once, param, ctx);
                __atomic_store_n(&once->state, ok ? 2 : 0, __ATOMIC_RELEASE);
                return ok;
            }
        }
        sched_yield();
    }
}

/* Thread-Local Storage Table (TlsAlloc / TlsGetValue / TlsSetValue / TlsFree) */
#define WIN32_MAX_TLS_SLOTS 64
extern SRWLOCK g_win32_tls_lock;
extern bool g_win32_tls_used[WIN32_MAX_TLS_SLOTS];
extern pthread_key_t g_win32_tls_keys[WIN32_MAX_TLS_SLOTS];

static inline DWORD TlsAlloc(void)
{
    AcquireSRWLockExclusive(&g_win32_tls_lock);
    for (DWORD i = 0; i < WIN32_MAX_TLS_SLOTS; i++) {
        if (!g_win32_tls_used[i]) {
            if (pthread_key_create(&g_win32_tls_keys[i], NULL) == 0) {
                g_win32_tls_used[i] = true;
                ReleaseSRWLockExclusive(&g_win32_tls_lock);
                return i;
            }
            break;
        }
    }
    ReleaseSRWLockExclusive(&g_win32_tls_lock);
    return TLS_OUT_OF_INDEXES;
}

static inline LPVOID TlsGetValue(DWORD idx)
{
    if (idx >= WIN32_MAX_TLS_SLOTS) return NULL;
    return pthread_getspecific(g_win32_tls_keys[idx]);
}

static inline BOOL TlsSetValue(DWORD idx, LPVOID val)
{
    if (idx >= WIN32_MAX_TLS_SLOTS) return FALSE;
    return pthread_setspecific(g_win32_tls_keys[idx], val) == 0 ? TRUE : FALSE;
}

static inline BOOL TlsFree(DWORD idx)
{
    if (idx >= WIN32_MAX_TLS_SLOTS) return FALSE;
    AcquireSRWLockExclusive(&g_win32_tls_lock);
    bool was_used = g_win32_tls_used[idx];
    if (was_used) {
        pthread_key_delete(g_win32_tls_keys[idx]);
        g_win32_tls_used[idx] = false;
    }
    ReleaseSRWLockExclusive(&g_win32_tls_lock);
    return was_used ? TRUE : FALSE;
}

/* -------------------------------------------------------------------------
 * Tagged Kernel Handles (Files, Events, Threads, Waiters & Threadpool)
 * ------------------------------------------------------------------------- */

enum win32_handle_kind {
    WIN32_HANDLE_FILE   = 0x46494C45u,
    WIN32_HANDLE_EVENT  = 0x45564E54u,
    WIN32_HANDLE_THREAD = 0x54485244u
};

struct win32_handle_obj {
    uint32_t kind;
    int fd;
    pthread_mutex_t mu;
    pthread_cond_t cv;
    bool manual_reset;
    bool signaled;
    pthread_t thread;
    bool thread_joined;
    DWORD (WINAPI *thread_fn)(LPVOID);
    LPVOID thread_arg;
};

static inline HANDLE CreateEventW(void *sec, BOOL manualReset, BOOL initialState, LPCWSTR name)
{
    (void)sec;
    (void)name;
    struct win32_handle_obj *h = (struct win32_handle_obj *)win32_tracked_calloc(1, sizeof(*h));
    if (!h) return NULL;
    h->kind = WIN32_HANDLE_EVENT;
    h->fd = -1;
    pthread_mutex_init(&h->mu, NULL);
    pthread_cond_init(&h->cv, NULL);
    h->manual_reset = (manualReset != 0);
    h->signaled = (initialState != 0);
    return (HANDLE)h;
}

static inline BOOL SetEvent(HANDLE handle)
{
    struct win32_handle_obj *h = (struct win32_handle_obj *)handle;
    if (!h || h->kind != WIN32_HANDLE_EVENT) return FALSE;
    pthread_mutex_lock(&h->mu);
    h->signaled = true;
    pthread_cond_broadcast(&h->cv);
    pthread_mutex_unlock(&h->mu);
    return TRUE;
}

static inline void *win32_thread_trampoline(void *arg)
{
    struct win32_handle_obj *h = (struct win32_handle_obj *)arg;
    if (h->thread_fn) {
        (void)h->thread_fn(h->thread_arg);
    }
    pthread_mutex_lock(&h->mu);
    h->signaled = true;
    pthread_cond_broadcast(&h->cv);
    pthread_mutex_unlock(&h->mu);
    return NULL;
}

typedef DWORD (WINAPI *LPTHREAD_START_ROUTINE)(LPVOID);

static inline HANDLE CreateThread(
    void *sec,
    SIZE_T stackSize,
    LPTHREAD_START_ROUTINE startFn,
    LPVOID param,
    DWORD flags,
    DWORD *outTid
)
{
    (void)sec;
    (void)stackSize;
    (void)flags;
    if (outTid) *outTid = 0;
    struct win32_handle_obj *h = (struct win32_handle_obj *)win32_tracked_calloc(1, sizeof(*h));
    if (!h) return NULL;
    h->kind = WIN32_HANDLE_THREAD;
    h->fd = -1;
    pthread_mutex_init(&h->mu, NULL);
    pthread_cond_init(&h->cv, NULL);
    h->manual_reset = true;
    h->signaled = false;
    h->thread_fn = startFn;
    h->thread_arg = param;
    if (pthread_create(&h->thread, NULL, win32_thread_trampoline, h) != 0) {
        pthread_cond_destroy(&h->cv);
        pthread_mutex_destroy(&h->mu);
        win32_tracked_free(h);
        return NULL;
    }
    return (HANDLE)h;
}

static inline DWORD WaitForSingleObject(HANDLE handle, DWORD timeoutMs)
{
    struct win32_handle_obj *h = (struct win32_handle_obj *)handle;
    if (!h || handle == INVALID_HANDLE_VALUE) return WAIT_FAILED;
    if (h->kind != WIN32_HANDLE_EVENT && h->kind != WIN32_HANDLE_THREAD) return WAIT_FAILED;

    pthread_mutex_lock(&h->mu);
    if (timeoutMs == 0) {
        bool ready = h->signaled;
        if (ready && !h->manual_reset) h->signaled = false;
        pthread_mutex_unlock(&h->mu);
        return ready ? WAIT_OBJECT_0 : WAIT_TIMEOUT;
    }
    if (timeoutMs == INFINITE) {
        while (!h->signaled) {
            pthread_cond_wait(&h->cv, &h->mu);
        }
        if (!h->manual_reset) h->signaled = false;
        pthread_mutex_unlock(&h->mu);
        return WAIT_OBJECT_0;
    }

    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += (time_t)(timeoutMs / 1000u);
    ts.tv_nsec += (long)(timeoutMs % 1000u) * 1000000L;
    if (ts.tv_nsec >= 1000000000L) {
        ts.tv_sec += 1;
        ts.tv_nsec -= 1000000000L;
    }
    while (!h->signaled) {
        if (pthread_cond_timedwait(&h->cv, &h->mu, &ts) == ETIMEDOUT) {
            bool ready = h->signaled;
            if (ready && !h->manual_reset) h->signaled = false;
            pthread_mutex_unlock(&h->mu);
            return ready ? WAIT_OBJECT_0 : WAIT_TIMEOUT;
        }
    }
    if (!h->manual_reset) h->signaled = false;
    pthread_mutex_unlock(&h->mu);
    return WAIT_OBJECT_0;
}

static inline DWORD WaitForMultipleObjects(DWORD count, const HANDLE *handles, BOOL waitAll, DWORD timeoutMs)
{
    if (!handles || count == 0) return WAIT_FAILED;
    if (waitAll) {
        ULONGLONG start = GetTickCount64();
        for (DWORD i = 0; i < count; i++) {
            DWORD rem = timeoutMs;
            if (timeoutMs != INFINITE) {
                ULONGLONG elapsed = GetTickCount64() - start;
                rem = elapsed >= timeoutMs ? 0 : (DWORD)(timeoutMs - elapsed);
            }
            DWORD rc = WaitForSingleObject(handles[i], rem);
            if (rc != WAIT_OBJECT_0) return rc;
        }
        return WAIT_OBJECT_0;
    }
    return WaitForSingleObject(handles[0], timeoutMs);
}

static inline BOOL CloseHandle(HANDLE handle)
{
    if (!handle || handle == INVALID_HANDLE_VALUE) return FALSE;
    struct win32_handle_obj *h = (struct win32_handle_obj *)handle;
    if (h->kind == WIN32_HANDLE_FILE) {
        if (h->fd >= 0) close(h->fd);
        win32_tracked_free(h);
        return TRUE;
    }
    if (h->kind == WIN32_HANDLE_THREAD) {
        if (!h->thread_joined) {
            pthread_join(h->thread, NULL);
            h->thread_joined = true;
        }
        pthread_cond_destroy(&h->cv);
        pthread_mutex_destroy(&h->mu);
        win32_tracked_free(h);
        return TRUE;
    }
    if (h->kind == WIN32_HANDLE_EVENT) {
        pthread_cond_destroy(&h->cv);
        pthread_mutex_destroy(&h->mu);
        win32_tracked_free(h);
        return TRUE;
    }
    return FALSE;
}

/* Threadpool & RegisterWaitForSingleObject */
typedef void *PTP_CALLBACK_INSTANCE;
typedef struct win32_tp_work *PTP_WORK;
typedef VOID (CALLBACK *PTP_WORK_CALLBACK)(PTP_CALLBACK_INSTANCE, PVOID, PTP_WORK);
typedef VOID (CALLBACK *PTP_SIMPLE_CALLBACK)(PTP_CALLBACK_INSTANCE, PVOID);
typedef VOID (CALLBACK *WAITORTIMERCALLBACK)(PVOID, BOOLEAN);

extern _Atomic int32_t g_win32_active_bg_workers;

struct win32_tp_work {
    PTP_WORK_CALLBACK cb;
    PVOID ctx;
};

static inline PTP_WORK CreateThreadpoolWork(PTP_WORK_CALLBACK cb, PVOID ctx, void *env)
{
    (void)env;
    struct win32_tp_work *w = (struct win32_tp_work *)win32_tracked_calloc(1, sizeof(*w));
    if (!w) return NULL;
    w->cb = cb;
    w->ctx = ctx;
    return w;
}

static inline void CloseThreadpoolWork(PTP_WORK work)
{
    win32_tracked_free(work);
}

static inline void *win32_tp_work_runner(void *arg)
{
    struct win32_tp_work *w = (struct win32_tp_work *)arg;
    if (w && w->cb) {
        w->cb(NULL, w->ctx, w);
    }
    atomic_fetch_sub_explicit(&g_win32_active_bg_workers, 1, memory_order_seq_cst);
    return NULL;
}

static inline void SubmitThreadpoolWork(PTP_WORK work)
{
    if (!work) return;
    atomic_fetch_add_explicit(&g_win32_active_bg_workers, 1, memory_order_seq_cst);
    pthread_t th;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    if (pthread_create(&th, &attr, win32_tp_work_runner, work) != 0) {
        pthread_attr_destroy(&attr);
        win32_tp_work_runner(work);
        return;
    }
    pthread_attr_destroy(&attr);
}

struct win32_simple_tp_task {
    PTP_SIMPLE_CALLBACK simple_cb;
    LPTHREAD_START_ROUTINE legacy_cb;
    PVOID ctx;
};

static inline void *win32_simple_tp_runner(void *arg)
{
    struct win32_simple_tp_task *t = (struct win32_simple_tp_task *)arg;
    if (t->simple_cb) t->simple_cb(NULL, t->ctx);
    else if (t->legacy_cb) (void)t->legacy_cb(t->ctx);
    win32_tracked_free(t);
    atomic_fetch_sub_explicit(&g_win32_active_bg_workers, 1, memory_order_seq_cst);
    return NULL;
}

static inline BOOL TrySubmitThreadpoolCallback(PTP_SIMPLE_CALLBACK cb, PVOID ctx, void *env)
{
    (void)env;
    struct win32_simple_tp_task *t = (struct win32_simple_tp_task *)win32_tracked_calloc(1, sizeof(*t));
    if (!t) return FALSE;
    t->simple_cb = cb;
    t->ctx = ctx;
    atomic_fetch_add_explicit(&g_win32_active_bg_workers, 1, memory_order_seq_cst);
    pthread_t th;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    if (pthread_create(&th, &attr, win32_simple_tp_runner, t) != 0) {
        pthread_attr_destroy(&attr);
        win32_tracked_free(t);
        atomic_fetch_sub_explicit(&g_win32_active_bg_workers, 1, memory_order_seq_cst);
        return FALSE;
    }
    pthread_attr_destroy(&attr);
    return TRUE;
}

static inline BOOL QueueUserWorkItem(LPTHREAD_START_ROUTINE cb, PVOID ctx, DWORD flags)
{
    (void)flags;
    struct win32_simple_tp_task *t = (struct win32_simple_tp_task *)win32_tracked_calloc(1, sizeof(*t));
    if (!t) return FALSE;
    t->legacy_cb = cb;
    t->ctx = ctx;
    atomic_fetch_add_explicit(&g_win32_active_bg_workers, 1, memory_order_seq_cst);
    pthread_t th;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    if (pthread_create(&th, &attr, win32_simple_tp_runner, t) != 0) {
        pthread_attr_destroy(&attr);
        win32_tracked_free(t);
        atomic_fetch_sub_explicit(&g_win32_active_bg_workers, 1, memory_order_seq_cst);
        return FALSE;
    }
    pthread_attr_destroy(&attr);
    return TRUE;
}

static inline void win32_drain_background_workers(void)
{
    while (atomic_load_explicit(&g_win32_active_bg_workers, memory_order_seq_cst) > 0) {
        Sleep(1);
    }
}

struct win32_waiter_obj {
    HANDLE target_event;
    WAITORTIMERCALLBACK cb;
    PVOID ctx;
    _Atomic int32_t cancel;
    pthread_t th;
};

static inline void *win32_waiter_thread(void *arg)
{
    struct win32_waiter_obj *wo = (struct win32_waiter_obj *)arg;
    while (!atomic_load_explicit(&wo->cancel, memory_order_acquire)) {
        if (WaitForSingleObject(wo->target_event, 2) == WAIT_OBJECT_0) {
            if (!atomic_load_explicit(&wo->cancel, memory_order_acquire) && wo->cb) {
                wo->cb(wo->ctx, FALSE);
            }
            break;
        }
    }
    return NULL;
}

static inline BOOL RegisterWaitForSingleObject(
    HANDLE *outWaitObj,
    HANDLE hObject,
    WAITORTIMERCALLBACK cb,
    PVOID ctx,
    DWORD dwMilliseconds,
    ULONG dwFlags
)
{
    (void)dwMilliseconds;
    (void)dwFlags;
    if (!outWaitObj || !hObject || !cb) {
        SetLastError(ERROR_INVALID_PARAMETER);
        return FALSE;
    }
    struct win32_waiter_obj *wo = (struct win32_waiter_obj *)win32_tracked_calloc(1, sizeof(*wo));
    if (!wo) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return FALSE;
    }
    wo->target_event = hObject;
    wo->cb = cb;
    wo->ctx = ctx;
    atomic_init(&wo->cancel, 0);
    if (pthread_create(&wo->th, NULL, win32_waiter_thread, wo) != 0) {
        win32_tracked_free(wo);
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return FALSE;
    }
    *outWaitObj = (HANDLE)wo;
    return TRUE;
}

static inline BOOL UnregisterWaitEx(HANDLE waitHandle, HANDLE completionEvent)
{
    (void)completionEvent;
    if (!waitHandle) return FALSE;
    struct win32_waiter_obj *wo = (struct win32_waiter_obj *)waitHandle;
    atomic_store_explicit(&wo->cancel, 1, memory_order_release);
    pthread_join(wo->th, NULL);
    win32_tracked_free(wo);
    return TRUE;
}

/* -------------------------------------------------------------------------
 * Virtual `C:\` Drive Mapping, Environment & POSIX Filesystem Bridge
 * ------------------------------------------------------------------------- */

extern char g_win32_virtual_c_root[2048];
extern char g_win32_mock_module_path_utf8[2048];

static inline bool win32_translate_path_w(LPCWSTR wpath, char *out_posix, size_t out_cap)
{
    if (!wpath || !out_posix || out_cap < 8) return false;
    char utf8[4096] = { 0 };
    if (WideCharToMultiByte(CP_UTF8, 0, wpath, -1, utf8, (int)sizeof(utf8), NULL, NULL) <= 0) {
        return false;
    }
    for (char *p = utf8; *p; p++) {
        if (*p == '\\') *p = '/';
    }

    if ((utf8[0] == 'C' || utf8[0] == 'c') && utf8[1] == ':') {
        const char *sub = utf8 + 2;
        while (*sub == '/') sub++;
        int n = (*sub)
            ? snprintf(out_posix, out_cap, "%s/%s", g_win32_virtual_c_root, sub)
            : snprintf(out_posix, out_cap, "%s", g_win32_virtual_c_root);
        return n > 0 && (size_t)n < out_cap;
    }

    int n = snprintf(out_posix, out_cap, "%s", utf8);
    return n > 0 && (size_t)n < out_cap;
}

static inline DWORD GetEnvironmentVariableW(LPCWSTR name, LPWSTR buf, DWORD size)
{
    if (!name || !*name) {
        SetLastError(ERROR_ENVVAR_NOT_FOUND);
        return 0;
    }
    char name_u8[256] = { 0 };
    if (WideCharToMultiByte(CP_UTF8, 0, name, -1, name_u8, (int)sizeof(name_u8), NULL, NULL) <= 0) {
        SetLastError(ERROR_ENVVAR_NOT_FOUND);
        return 0;
    }
    const char *val = getenv(name_u8);
    if (!val) {
        SetLastError(ERROR_ENVVAR_NOT_FOUND);
        return 0;
    }
    int need_with_nul = MultiByteToWideChar(CP_UTF8, 0, val, -1, NULL, 0);
    if (need_with_nul <= 0) {
        SetLastError(ERROR_ENVVAR_NOT_FOUND);
        return 0;
    }
    if (!buf || size < (DWORD)need_with_nul) {
        return (DWORD)need_with_nul;
    }
    int written = MultiByteToWideChar(CP_UTF8, 0, val, -1, buf, (int)size);
    return written > 0 ? (DWORD)(written - 1) : 0;
}

static inline DWORD GetModuleFileNameW(HMODULE hMod, LPWSTR buf, DWORD size)
{
    (void)hMod;
    if (!buf || size == 0) return 0;
    const char *src = g_win32_mock_module_path_utf8[0]
        ? g_win32_mock_module_path_utf8
        : "C:\\Games\\TestGame\\Game.exe";
    int need = MultiByteToWideChar(CP_UTF8, 0, src, -1, NULL, 0);
    if (need <= 0) return 0;
    if ((DWORD)need > size) {
        MultiByteToWideChar(CP_UTF8, 0, src, -1, buf, (int)size);
        buf[size - 1] = 0;
        SetLastError(ERROR_INSUFFICIENT_BUFFER);
        return size;
    }
    MultiByteToWideChar(CP_UTF8, 0, src, -1, buf, (int)size);
    return (DWORD)(need - 1);
}

static inline BOOL CreateDirectoryW(LPCWSTR path, void *sec)
{
    (void)sec;
    char posix[4096];
    if (!win32_translate_path_w(path, posix, sizeof(posix))) return FALSE;
    if (mkdir(posix, 0755) == 0 || errno == EEXIST) return TRUE;
    return FALSE;
}

static inline BOOL RemoveDirectoryW(LPCWSTR path)
{
    char posix[4096];
    if (!win32_translate_path_w(path, posix, sizeof(posix))) return FALSE;
    return rmdir(posix) == 0 ? TRUE : FALSE;
}

static inline BOOL DeleteFileW(LPCWSTR path)
{
    char posix[4096];
    if (!win32_translate_path_w(path, posix, sizeof(posix))) return FALSE;
    return unlink(posix) == 0 ? TRUE : FALSE;
}

static inline BOOL MoveFileExW(LPCWSTR src, LPCWSTR dst, DWORD flags)
{
    (void)flags;
    char psrc[4096], pdst[4096];
    if (!win32_translate_path_w(src, psrc, sizeof(psrc))) return FALSE;
    if (!win32_translate_path_w(dst, pdst, sizeof(pdst))) return FALSE;
    return rename(psrc, pdst) == 0 ? TRUE : FALSE;
}

static inline HANDLE CreateFileW(
    LPCWSTR path,
    DWORD access,
    DWORD share,
    void *sec,
    DWORD disp,
    DWORD attrs,
    HANDLE tmpl
)
{
    (void)share;
    (void)sec;
    (void)attrs;
    (void)tmpl;
    char posix[4096];
    if (!win32_translate_path_w(path, posix, sizeof(posix))) {
        SetLastError(ERROR_PATH_NOT_FOUND);
        return INVALID_HANDLE_VALUE;
    }

    int oflags = 0;
    if ((access & GENERIC_READ) && (access & GENERIC_WRITE)) oflags = O_RDWR;
    else if (access & GENERIC_WRITE) oflags = O_WRONLY;
    else oflags = O_RDONLY;

    if (disp == CREATE_ALWAYS) {
        oflags |= O_CREAT | O_TRUNC;
    }

    int fd = open(posix, oflags, 0644);
    if (fd < 0) {
        SetLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_HANDLE_VALUE;
    }

    struct win32_handle_obj *h = (struct win32_handle_obj *)win32_tracked_calloc(1, sizeof(*h));
    if (!h) {
        close(fd);
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return INVALID_HANDLE_VALUE;
    }
    h->kind = WIN32_HANDLE_FILE;
    h->fd = fd;
    return (HANDLE)h;
}

static inline BOOL GetFileSizeEx(HANDLE handle, LARGE_INTEGER *outSize)
{
    struct win32_handle_obj *h = (struct win32_handle_obj *)handle;
    if (!h || h == (struct win32_handle_obj *)INVALID_HANDLE_VALUE || h->kind != WIN32_HANDLE_FILE || !outSize) {
        return FALSE;
    }
    struct stat st;
    if (fstat(h->fd, &st) != 0) return FALSE;
    outSize->QuadPart = (LONGLONG)st.st_size;
    return TRUE;
}

static inline BOOL ReadFile(HANDLE handle, LPVOID buf, DWORD bytesToRead, DWORD *bytesRead, void *overlapped)
{
    (void)overlapped;
    if (bytesRead) *bytesRead = 0;
    struct win32_handle_obj *h = (struct win32_handle_obj *)handle;
    if (!h || h == (struct win32_handle_obj *)INVALID_HANDLE_VALUE || h->kind != WIN32_HANDLE_FILE) return FALSE;
    uint8_t *dst = (uint8_t *)buf;
    size_t total = 0;
    while (total < (size_t)bytesToRead) {
        ssize_t got = read(h->fd, dst + total, (size_t)bytesToRead - total);
        if (got < 0) {
            if (errno == EINTR) continue;
            return FALSE;
        }
        if (got == 0) break;
        total += (size_t)got;
    }
    if (bytesRead) *bytesRead = (DWORD)total;
    return TRUE;
}

static inline BOOL WriteFile(HANDLE handle, LPCVOID buf, DWORD bytesToWrite, DWORD *bytesWritten, void *overlapped)
{
    (void)overlapped;
    if (bytesWritten) *bytesWritten = 0;
    struct win32_handle_obj *h = (struct win32_handle_obj *)handle;
    if (!h || h == (struct win32_handle_obj *)INVALID_HANDLE_VALUE || h->kind != WIN32_HANDLE_FILE) return FALSE;
    const uint8_t *src = (const uint8_t *)buf;
    size_t total = 0;
    while (total < (size_t)bytesToWrite) {
        ssize_t put = write(h->fd, src + total, (size_t)bytesToWrite - total);
        if (put < 0) {
            if (errno == EINTR) continue;
            return FALSE;
        }
        total += (size_t)put;
    }
    if (bytesWritten) *bytesWritten = (DWORD)total;
    return TRUE;
}

static inline BOOL FlushFileBuffers(HANDLE handle)
{
    struct win32_handle_obj *h = (struct win32_handle_obj *)handle;
    if (!h || h == (struct win32_handle_obj *)INVALID_HANDLE_VALUE || h->kind != WIN32_HANDLE_FILE) return FALSE;
    return TRUE;
}

typedef enum _GET_FILEEX_INFO_LEVELS {
    GetFileExInfoStandard = 0
} GET_FILEEX_INFO_LEVELS;

typedef struct _WIN32_FILE_ATTRIBUTE_DATA {
    DWORD dwFileAttributes;
    FILETIME ftCreationTime;
    FILETIME ftLastAccessTime;
    FILETIME ftLastWriteTime;
    DWORD nFileSizeHigh;
    DWORD nFileSizeLow;
} WIN32_FILE_ATTRIBUTE_DATA;

static inline BOOL GetFileAttributesExW(LPCWSTR path, GET_FILEEX_INFO_LEVELS level, LPVOID info)
{
    (void)level;
    if (!info) return FALSE;
    char posix[4096];
    if (!win32_translate_path_w(path, posix, sizeof(posix))) return FALSE;
    struct stat st;
    if (stat(posix, &st) != 0) {
        SetLastError(ERROR_FILE_NOT_FOUND);
        return FALSE;
    }
    WIN32_FILE_ATTRIBUTE_DATA *fad = (WIN32_FILE_ATTRIBUTE_DATA *)info;
    memset(fad, 0, sizeof(*fad));
    fad->dwFileAttributes = S_ISDIR(st.st_mode) ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL;
    uint64_t sz = (uint64_t)st.st_size;
    fad->nFileSizeLow = (DWORD)(sz & 0xFFFFFFFFULL);
    fad->nFileSizeHigh = (DWORD)(sz >> 32);
    return TRUE;
}

/* -------------------------------------------------------------------------
 * Shared Global Definitions (emitted once in xgr_bridge_asan_test.c)
 * ------------------------------------------------------------------------- */

#ifdef WIN32_HOST_SHIM_IMPLEMENTATION
_Atomic int64_t g_win32_live_allocs = 0;
const GUID IID_IUnknown = { 0x00000000u, 0x0000u, 0x0000u, { 0xC0u, 0x00u, 0x00u, 0x00u, 0x00u, 0x00u, 0x00u, 0x46u } };
_Atomic uint64_t g_win32_guid_counter = 1;
_Thread_local DWORD g_win32_tls_last_error = 0;
_Atomic uint32_t g_win32_next_tid = 100;
_Thread_local uint32_t g_win32_self_tid = 0;
SRWLOCK g_win32_tls_lock = SRWLOCK_INIT;
bool g_win32_tls_used[WIN32_MAX_TLS_SLOTS] = { false };
pthread_key_t g_win32_tls_keys[WIN32_MAX_TLS_SLOTS];
_Atomic int32_t g_win32_active_bg_workers = 0;
char g_win32_virtual_c_root[2048] = "/tmp";
char g_win32_mock_module_path_utf8[2048] = "C:\\Games\\TestGame\\Game.exe";
#endif

/* Route production C heap calls through atomic leak tracker */
#define malloc  win32_tracked_malloc
#define calloc  win32_tracked_calloc
#define realloc win32_tracked_realloc
#define strdup  win32_tracked_strdup
#define free    win32_tracked_free

#endif /* ONE_TEST_WIN32_HOST_SHIM_H */
