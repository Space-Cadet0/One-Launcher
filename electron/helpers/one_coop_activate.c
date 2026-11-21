/*
 * one_coop_activate.c
 *
 * Clean-room macOS Cooperative Application Activation helper for One Launcher.
 * Loaded directly into Electron's main process via Node-API (`process.dlopen`)
 * so that One Launcher (`NSApp`) cooperatively yields and transfers frontmost
 * WindowServer focus + Menu Bar ownership to newly mapped bottled game windows
 * on macOS 14+ (Sonoma / Sequoia / Tahoe) without AppleEvents or TCC prompts:
 *
 *   [NSApp yieldActivationToApplication:targetApp];
 *   [targetApp activateFromApplication:[NSRunningApplication currentApplication] options:0];
 *
 * Falls back cleanly to `[targetApp activateWithOptions:3]` on macOS 11-13.
 */

#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <ctype.h>
#include <errno.h>
#include <libproc.h>
#include <objc/message.h>
#include <objc/runtime.h>
#include <pthread.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/sysctl.h>

#include "common_process_denylist.h"

extern void *objc_autoreleasePoolPush(void);
extern void objc_autoreleasePoolPop(void *pool);

/* Minimal ABI-stable Node-API v1 declarations */
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;

typedef enum {
    napi_ok = 0
} napi_status;

typedef enum {
    napi_undefined = 0,
    napi_null = 1,
    napi_boolean = 2,
    napi_number = 3,
    napi_string = 4,
    napi_symbol = 5,
    napi_object = 6,
    napi_function = 7,
    napi_external = 8,
    napi_bigint = 9
} napi_valuetype;

typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

extern napi_status napi_create_function(
    napi_env env,
    const char *utf8name,
    size_t length,
    napi_callback cb,
    void *data,
    napi_value *result
);
extern napi_status napi_set_named_property(
    napi_env env,
    napi_value object,
    const char *utf8name,
    napi_value value
);
extern napi_status napi_create_int32(
    napi_env env,
    int32_t value,
    napi_value *result
);
extern napi_status napi_get_boolean(
    napi_env env,
    bool value,
    napi_value *result
);
extern napi_status napi_get_cb_info(
    napi_env env,
    napi_callback_info cbinfo,
    size_t *argc,
    napi_value *argv,
    napi_value *this_arg,
    void **data
);
extern napi_status napi_typeof(
    napi_env env,
    napi_value value,
    napi_valuetype *result
);
extern napi_status napi_get_named_property(
    napi_env env,
    napi_value object,
    const char *utf8name,
    napi_value *result
);
extern napi_status napi_get_value_int32(
    napi_env env,
    napi_value value,
    int32_t *result
);
extern napi_status napi_get_value_double(
    napi_env env,
    napi_value value,
    double *result
);
extern napi_status napi_is_array(
    napi_env env,
    napi_value value,
    bool *result
);
extern napi_status napi_get_array_length(
    napi_env env,
    napi_value value,
    uint32_t *result
);
extern napi_status napi_get_element(
    napi_env env,
    napi_value object,
    uint32_t index,
    napi_value *result
);
extern napi_status napi_get_value_string_utf8(
    napi_env env,
    napi_value value,
    char *buf,
    size_t bufsize,
    size_t *result
);

static void str_to_lower_ascii(const char *src, char *dst, size_t dst_cap) {
    if (dst_cap == 0) return;
    size_t i = 0;
    for (; src[i] != '\0' && i + 1 < dst_cap; i++) {
        unsigned char c = (unsigned char)src[i];
        dst[i] = (char)tolower(c);
    }
    dst[i] = '\0';
}

static bool ends_with_ascii(const char *str, const char *suffix) {
    size_t slen = strlen(str);
    size_t xlen = strlen(suffix);
    if (slen < xlen) return false;
    return memcmp(str + (slen - xlen), suffix, xlen) == 0;
}

static bool starts_with_ascii(const char *str, const char *prefix) {
    size_t plen = strlen(prefix);
    return strncmp(str, prefix, plen) == 0;
}

static bool contains_ascii_sub(const char *haystack, const char *needle) {
    if (!haystack || !needle || !needle[0]) return false;
    return strstr(haystack, needle) != NULL;
}

/*
 * Shared Wine/storefront helper denylist (steamwebhelper.exe, epicgameslauncher.exe,
 * galaxyclient.exe, eadesktop.exe, upc.exe, etc. via common_process_denylist.h)
 * so cooperative focus transfer never activates background daemons or storefront clients.
 */
static bool is_ignored_helper_owner(const char *lower_owner) {
    static const char k_ignored_msz[] =
        ONE_DENYLIST_WINE_SYSTEM_MSZ
        ONE_DENYLIST_SHELL_MSZ
        ONE_DENYLIST_STOREFRONT_DAEMONS_MSZ
        ONE_DENYLIST_GALAXY_CHAIN_MSZ
        ONE_DENYLIST_STOREFRONT_CLIENTS_MSZ
        "python.exe\0";
    return one_denylist_match_ascii_msz(lower_owner, k_ignored_msz);
}

static bool cfstring_copy_utf8_truncated(CFStringRef ref, char *dst, size_t dst_cap) {
    if (!ref || !dst || dst_cap == 0) return false;
    dst[0] = '\0';
    if (CFStringGetCString(ref, dst, (CFIndex)dst_cap, kCFStringEncodingUTF8)) {
        return dst[0] != '\0';
    }
    CFIndex slen = CFStringGetLength(ref);
    if (slen <= 0) return false;
    CFIndex used_bytes = 0;
    CFStringGetBytes(
        ref,
        CFRangeMake(0, slen),
        kCFStringEncodingUTF8,
        '?',
        false,
        (UInt8 *)dst,
        (CFIndex)(dst_cap - 1),
        &used_bytes
    );
    if (used_bytes < 0) used_bytes = 0;
    if ((size_t)used_bytes >= dst_cap) used_bytes = (CFIndex)(dst_cap - 1);
    dst[used_bytes] = '\0';
    return used_bytes > 0;
}

#define COOP_MAX_TARGET_EXES  16
#define COOP_MAX_EXE_NAME     128
#define COOP_MAX_BOTTLE_PATH  1024
#define COOP_MAX_PROCARGS_BUF (256u * 1024u)

typedef struct coop_scope_s {
    int32_t root_pid;
    size_t  target_count;
    char    target_exes[COOP_MAX_TARGET_EXES][COOP_MAX_EXE_NAME];
    char    bottle_path[COOP_MAX_BOTTLE_PATH];
} coop_scope_t;

static const char *ascii_basename(const char *path) {
    if (!path) return "";
    const char *base = path;
    for (const char *p = path; *p != '\0'; p++) {
        if (*p == '/' || *p == '\\') {
            base = p + 1;
        }
    }
    return base;
}

static void normalize_bottle_path_lower(const char *src, char *dst, size_t dst_cap) {
    if (!dst || dst_cap == 0) return;
    dst[0] = '\0';
    if (!src || !src[0]) return;
    size_t j = 0;
    for (size_t i = 0; src[i] != '\0' && j + 1 < dst_cap; i++) {
        unsigned char c = (unsigned char)src[i];
        if (c == '\\') c = '/';
        dst[j++] = (char)tolower(c);
    }
    while (j > 1 && dst[j - 1] == '/') {
        j--;
    }
    dst[j] = '\0';
}

static bool pid_is_descendant_of(int32_t pid, int32_t root_pid) {
    if (pid <= 0 || root_pid <= 0) return false;
    if (pid == root_pid) return true;
    int32_t cur = pid;
    for (int hop = 0; hop < 12 && cur > 1; hop++) {
        struct proc_bsdinfo bsd;
        memset(&bsd, 0, sizeof(bsd));
        int ret = proc_pidinfo(cur, PROC_PIDTBSDINFO, 0, &bsd, (int)sizeof(bsd));
        if (ret < (int)sizeof(bsd)) {
            break;
        }
        int32_t ppid = (int32_t)bsd.pbi_ppid;
        if (ppid == root_pid) return true;
        if (ppid <= 1 || ppid == cur) break;
        cur = ppid;
    }
    return false;
}

/*
 * MH-04: Dynamically size the KERN_PROCARGS2 sysctl buffer by querying the
 * required byte count first (with KERN_ARGMAX / ENOMEM retry fallback capped at
 * 256 KiB) so Wine/CrossOver processes with large CX_ENV + PATH environments
 * never silently fail with ENOMEM.
 */
static char *read_procargs2_dynamic(int32_t pid, size_t *out_size) {
    if (out_size) *out_size = 0;
    if (pid <= 0) return NULL;

    int mib[3] = { CTL_KERN, KERN_PROCARGS2, (int)pid };
    size_t sz = 0;
    if (sysctl(mib, 3, NULL, &sz, NULL, 0) != 0 || sz <= sizeof(int)) {
        int argmax_mib[2] = { CTL_KERN, KERN_ARGMAX };
        int argmax = 0;
        size_t am_sz = sizeof(argmax);
        if (sysctl(argmax_mib, 2, &argmax, &am_sz, NULL, 0) == 0 && argmax > 0) {
            sz = (size_t)argmax;
        } else {
            sz = 65536u;
        }
    }
    if (sz < 4096u) sz = 4096u;
    if (sz > COOP_MAX_PROCARGS_BUF) sz = COOP_MAX_PROCARGS_BUF;

    for (int attempt = 0; attempt < 3; attempt++) {
        char *buf = (char *)malloc(sz + 1u);
        if (!buf) return NULL;
        size_t req_sz = sz;
        if (sysctl(mib, 3, buf, &req_sz, NULL, 0) == 0 && req_sz > sizeof(int)) {
            buf[req_sz] = '\0';
            if (out_size) *out_size = req_sz;
            return buf;
        }
        int err = errno;
        free(buf);
        if (err == ENOMEM && sz < COOP_MAX_PROCARGS_BUF) {
            sz = (sz * 2u <= COOP_MAX_PROCARGS_BUF) ? (sz * 2u) : COOP_MAX_PROCARGS_BUF;
            continue;
        }
        return NULL;
    }
    return NULL;
}

static void proc_args_inspect_pid(
    int32_t pid,
    const coop_scope_t *scope,
    bool *out_matched_exe,
    bool *out_matched_bottle
) {
    if (out_matched_exe) *out_matched_exe = false;
    if (out_matched_bottle) *out_matched_bottle = false;
    if (!scope || pid <= 0) return;
    bool want_exe = (scope->target_count > 0);
    bool want_bottle = (scope->bottle_path[0] != '\0');
    if (!want_exe && !want_bottle) return;

    size_t sz = 0;
    char *buf = read_procargs2_dynamic(pid, &sz);
    if (!buf || sz <= sizeof(int)) {
        free(buf);
        return;
    }

    int argc_val = 0;
    memcpy(&argc_val, buf, sizeof(int));
    if (argc_val < 0) argc_val = 0;
    if (argc_val > 64) argc_val = 64;

    size_t pos = sizeof(int);
    /* Skip exec_path and trailing NUL padding */
    while (pos < sz && buf[pos] != '\0') pos++;
    while (pos < sz && buf[pos] == '\0') pos++;

    bool matched_exe = false;
    bool matched_bottle = false;

    /* Walk argv[0..argc_val-1] */
    for (int ai = 0; ai < argc_val && pos < sz; ai++) {
        const char *arg = buf + pos;
        size_t alen = strnlen(arg, sz - pos);
        if (alen > 0) {
            if (want_exe && !matched_exe) {
                char lower_base[COOP_MAX_EXE_NAME];
                str_to_lower_ascii(ascii_basename(arg), lower_base, sizeof(lower_base));
                for (size_t t = 0; t < scope->target_count; t++) {
                    if (strcmp(lower_base, scope->target_exes[t]) == 0) {
                        matched_exe = true;
                        break;
                    }
                }
            }
            if (want_bottle && !matched_bottle) {
                char norm_arg[COOP_MAX_BOTTLE_PATH];
                normalize_bottle_path_lower(arg, norm_arg, sizeof(norm_arg));
                if (contains_ascii_sub(norm_arg, scope->bottle_path)) {
                    matched_bottle = true;
                }
            }
        }
        pos += alen + 1u;
    }

    /* Walk envp[] entries for WINEPREFIX= / CX_BOTTLE= when bottle scoping is active */
    if (want_bottle && !matched_bottle) {
        const char *bottle_base = ascii_basename(scope->bottle_path);
        while (pos < sz) {
            while (pos < sz && buf[pos] == '\0') pos++;
            if (pos >= sz) break;
            const char *env_ent = buf + pos;
            size_t elen = strnlen(env_ent, sz - pos);
            if (elen > 11 && strncasecmp(env_ent, "WINEPREFIX=", 11) == 0) {
                char norm_wp[COOP_MAX_BOTTLE_PATH];
                normalize_bottle_path_lower(env_ent + 11, norm_wp, sizeof(norm_wp));
                if (strcmp(norm_wp, scope->bottle_path) == 0) {
                    matched_bottle = true;
                    break;
                }
            } else if (elen > 10 && strncasecmp(env_ent, "CX_BOTTLE=", 10) == 0 && bottle_base[0] != '\0') {
                char lower_cx[COOP_MAX_EXE_NAME];
                str_to_lower_ascii(env_ent + 10, lower_cx, sizeof(lower_cx));
                if (strcmp(lower_cx, bottle_base) == 0) {
                    matched_bottle = true;
                    break;
                }
            }
            pos += elen + 1u;
        }
    }

    free(buf);
    if (out_matched_exe) *out_matched_exe = matched_exe;
    if (out_matched_bottle) *out_matched_bottle = matched_bottle;
}

static bool target_exes_match_owner_or_title(
    const char *lower_owner,
    const char *lower_title,
    const coop_scope_t *scope
) {
    if (!scope || scope->target_count == 0) return false;
    for (size_t t = 0; t < scope->target_count; t++) {
        const char *target = scope->target_exes[t];
        if (!target[0]) continue;
        if (strcmp(lower_owner, target) == 0) {
            return true;
        }
        if (lower_title && lower_title[0]) {
            if (contains_ascii_sub(lower_title, target)) {
                return true;
            }
            if (ends_with_ascii(target, ".exe")) {
                size_t stem_len = strlen(target) - 4;
                if (stem_len >= 3 && stem_len < COOP_MAX_EXE_NAME) {
                    char stem[COOP_MAX_EXE_NAME];
                    memcpy(stem, target, stem_len);
                    stem[stem_len] = '\0';
                    if (contains_ascii_sub(lower_title, stem)) {
                        return true;
                    }
                }
            }
        }
    }
    return false;
}

/*
 * Detect full-display borderless game windows (e.g., D3D12/D3DMetal games such as
 * Hades II presenting Composited at layer == 0 covering >= 95% of display bounds).
 */
static bool is_borderless_fullscreen_rect(CGRect rect, CGRect disp_bounds, int32_t layer) {
    if (layer != 0) return false;
    if (disp_bounds.size.width <= 0.0 || disp_bounds.size.height <= 0.0) return false;
    return (rect.size.width >= disp_bounds.size.width * 0.95) &&
           (rect.size.height >= disp_bounds.size.height * 0.95);
}

/*
 * AppKit NSApplicationPresentationOptions ABI bitflags (macOS 10.6+):
 *   NSApplicationPresentationDefault         = 0
 *   NSApplicationPresentationAutoHideDock    = 1 << 0
 *   NSApplicationPresentationAutoHideMenuBar = 1 << 2
 */
#define ONE_NS_APP_PRESENTATION_DEFAULT            ((uintptr_t)0)
#define ONE_NS_APP_PRESENTATION_AUTO_HIDE_DOCK     ((uintptr_t)(1u << 0))
#define ONE_NS_APP_PRESENTATION_AUTO_HIDE_MENU_BAR ((uintptr_t)(1u << 2))
#define ONE_NS_APP_PRESENTATION_BORDERLESS_MASK \
    (ONE_NS_APP_PRESENTATION_AUTO_HIDE_MENU_BAR | ONE_NS_APP_PRESENTATION_AUTO_HIDE_DOCK)

static bool g_borderless_presentation_applied = false;
static uintptr_t g_saved_presentation_options = ONE_NS_APP_PRESENTATION_DEFAULT;

static bool set_borderless_presentation_options(bool enable) {
    if (!enable && !g_borderless_presentation_applied) {
        return true;
    }
    if (!pthread_main_np()) {
        return false;
    }
    Class cls_ns_app = objc_getClass("NSApplication");
    if (!cls_ns_app) {
        return false;
    }
    SEL sel_shared_app = sel_registerName("sharedApplication");
    id (*msg_id)(id, SEL) = (id (*)(id, SEL))objc_msgSend;
    id ns_app = msg_id((id)cls_ns_app, sel_shared_app);
    if (!ns_app) {
        return false;
    }

    SEL sel_responds = sel_registerName("respondsToSelector:");
    BOOL (*msg_responds)(id, SEL, SEL) = (BOOL (*)(id, SEL, SEL))objc_msgSend;
    SEL sel_get_opts = sel_registerName("presentationOptions");
    SEL sel_set_opts = sel_registerName("setPresentationOptions:");
    if (!msg_responds(ns_app, sel_responds, sel_get_opts) ||
        !msg_responds(ns_app, sel_responds, sel_set_opts)) {
        return false;
    }

    uintptr_t (*msg_get_opts)(id, SEL) = (uintptr_t (*)(id, SEL))objc_msgSend;
    void (*msg_set_opts)(id, SEL, uintptr_t) = (void (*)(id, SEL, uintptr_t))objc_msgSend;

    if (enable) {
        if (!g_borderless_presentation_applied) {
            g_saved_presentation_options = msg_get_opts(ns_app, sel_get_opts);
        }
        uintptr_t target_opts = g_saved_presentation_options | ONE_NS_APP_PRESENTATION_BORDERLESS_MASK;
        msg_set_opts(ns_app, sel_set_opts, target_opts);
        g_borderless_presentation_applied = true;
        return true;
    }

    msg_set_opts(ns_app, sel_set_opts, g_saved_presentation_options);
    g_borderless_presentation_applied = false;
    g_saved_presentation_options = ONE_NS_APP_PRESENTATION_DEFAULT;
    return true;
}

static bool find_top_bottled_game_window(
    const coop_scope_t *scope,
    int32_t *out_pid,
    int32_t *out_layer,
    bool *out_is_borderless_fullscreen
) {
    *out_pid = 0;
    *out_layer = 0;
    if (out_is_borderless_fullscreen) *out_is_borderless_fullscreen = false;

    CFArrayRef win_list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID
    );
    if (!win_list) {
        return false;
    }

    bool found = false;
    double best_score = -1.0;
    int32_t best_pid = 0;
    int32_t best_layer = 0;
    bool best_is_borderless_fullscreen = false;

    CFIndex count = CFArrayGetCount(win_list);
    for (CFIndex i = 0; i < count; i++) {
        CFDictionaryRef dict = (CFDictionaryRef)CFArrayGetValueAtIndex(win_list, i);
        if (!dict || CFGetTypeID(dict) != CFDictionaryGetTypeID()) continue;

        CFStringRef owner_ref = (CFStringRef)CFDictionaryGetValue(dict, kCGWindowOwnerName);
        if (!owner_ref || CFGetTypeID(owner_ref) != CFStringGetTypeID()) continue;

        char owner_buf[256];
        if (!cfstring_copy_utf8_truncated(owner_ref, owner_buf, sizeof(owner_buf))) {
            continue;
        }

        char lower_buf[256];
        str_to_lower_ascii(owner_buf, lower_buf, sizeof(lower_buf));
        if ((!ends_with_ascii(lower_buf, ".exe") && !starts_with_ascii(lower_buf, "wine")) ||
            is_ignored_helper_owner(lower_buf)) {
            continue;
        }

        CFDictionaryRef bounds_ref = (CFDictionaryRef)CFDictionaryGetValue(dict, kCGWindowBounds);
        if (!bounds_ref || CFGetTypeID(bounds_ref) != CFDictionaryGetTypeID()) continue;

        CGRect rect = CGRectZero;
        if (!CGRectMakeWithDictionaryRepresentation(bounds_ref, &rect)) continue;
        if (rect.size.width < 320.0 || rect.size.height < 240.0) continue;

        CFNumberRef pid_ref = (CFNumberRef)CFDictionaryGetValue(dict, kCGWindowOwnerPID);
        int32_t pid = 0;
        if (!pid_ref || !CFNumberGetValue(pid_ref, kCFNumberSInt32Type, &pid) || pid <= 0) {
            continue;
        }

        int32_t layer = 0;
        CFNumberRef layer_ref = (CFNumberRef)CFDictionaryGetValue(dict, kCGWindowLayer);
        if (layer_ref) {
            CFNumberGetValue(layer_ref, kCFNumberSInt32Type, &layer);
        }

        /* Multi-monitor per-display target bounds scoring (prefer center point to prevent edge bleed) */
        CGDirectDisplayID disp_id = CGMainDisplayID();
        uint32_t disp_count = 0;
        CGPoint center_pt = CGPointMake(
            rect.origin.x + rect.size.width * 0.5,
            rect.origin.y + rect.size.height * 0.5
        );
        if (CGGetDisplaysWithPoint(center_pt, 1, &disp_id, &disp_count) != kCGErrorSuccess || disp_count == 0) {
            disp_count = 0;
            if (CGGetDisplaysWithRect(rect, 1, &disp_id, &disp_count) != kCGErrorSuccess || disp_count == 0) {
                disp_id = CGMainDisplayID();
            }
        }
        CGRect disp_bounds = CGDisplayBounds(disp_id);
        double screen_area = (disp_bounds.size.width > 0.0 && disp_bounds.size.height > 0.0)
            ? (disp_bounds.size.width * disp_bounds.size.height)
            : 0.0;

        double area = rect.size.width * rect.size.height;
        bool is_borderless_fs = is_borderless_fullscreen_rect(rect, disp_bounds, layer);
        bool is_near_fullscreen =
            is_borderless_fs || (screen_area > 0.0 && area >= screen_area * 0.80);
        double score = area;
        if (is_near_fullscreen) {
            score += 1.0e12;
        }
        if (layer > 0) {
            score += 1.0e10;
        }

        /*
         * MH-05: When caller specifies a target scope (bottlePath, rootPid, or
         * targetExeNames), strictly require a match rather than activating an
         * unrelated Wine window from another bottle.
         */
        bool has_bottle_scope = (scope && scope->bottle_path[0] != '\0');
        bool has_pid_scope = (scope && scope->root_pid > 0);
        bool has_exe_scope = (scope && scope->target_count > 0);
        if (has_bottle_scope || has_pid_scope || has_exe_scope) {
            char lower_title[256];
            lower_title[0] = '\0';
            CFStringRef name_ref = (CFStringRef)CFDictionaryGetValue(dict, kCGWindowName);
            if (name_ref && CFGetTypeID(name_ref) == CFStringGetTypeID()) {
                char title_buf[256];
                if (cfstring_copy_utf8_truncated(name_ref, title_buf, sizeof(title_buf))) {
                    str_to_lower_ascii(title_buf, lower_title, sizeof(lower_title));
                }
            }

            bool matched_args_exe = false;
            bool matched_bottle = false;
            proc_args_inspect_pid(pid, scope, &matched_args_exe, &matched_bottle);

            bool matched_exe =
                target_exes_match_owner_or_title(lower_buf, lower_title, scope) ||
                matched_args_exe;
            bool matched_tree = (has_pid_scope && pid_is_descendant_of(pid, scope->root_pid));

            if (has_bottle_scope && !matched_bottle && !matched_tree) {
                continue;
            }
            if (!matched_exe && !matched_tree && !matched_bottle) {
                continue;
            }

            if (matched_bottle) {
                score += 2.0e14;
            }
            if (matched_exe) {
                score += 1.0e14;
            }
            if (matched_tree) {
                score += 5.0e13;
            }
        }

        /* Strict '>' preserves frontmost WindowServer Z-order on equal-sized windows */
        if (!found || score > best_score) {
            found = true;
            best_score = score;
            best_pid = pid;
            best_layer = layer;
            best_is_borderless_fullscreen = is_borderless_fs;
        }
    }

    CFRelease(win_list);
    if (found) {
        *out_pid = best_pid;
        *out_layer = best_layer;
        if (out_is_borderless_fullscreen) {
            *out_is_borderless_fullscreen = best_is_borderless_fullscreen;
        }
    }
    return found;
}

static const char *nsstring_to_utf8(id ns_str) {
    if (!ns_str) return NULL;
    SEL sel_utf8 = sel_registerName("UTF8String");
    const char *(*msg_utf8)(id, SEL) = (const char *(*)(id, SEL))objc_msgSend;
    return msg_utf8(ns_str, sel_utf8);
}

/*
 * Guard against stealing focus when the user Cmd+Tab's to an unrelated macOS app
 * (Safari, Finder, Terminal, etc.) during launch polling: only transfer activation
 * when One Launcher itself or a Wine/CrossOver bottle helper is currently frontmost.
 */
static bool can_cooperatively_transfer_from_frontmost(id ns_app, id current_app, int32_t target_pid) {
    SEL sel_is_active = sel_registerName("isActive");
    BOOL (*msg_bool)(id, SEL) = (BOOL (*)(id, SEL))objc_msgSend;
    if (ns_app && msg_bool(ns_app, sel_is_active)) {
        return true;
    }

    Class cls_ws = objc_getClass("NSWorkspace");
    if (!cls_ws) {
        return true;
    }
    SEL sel_shared_ws = sel_registerName("sharedWorkspace");
    id (*msg_id)(id, SEL) = (id (*)(id, SEL))objc_msgSend;
    id shared_ws = msg_id((id)cls_ws, sel_shared_ws);
    if (!shared_ws) {
        return true;
    }

    SEL sel_front = sel_registerName("frontmostApplication");
    id front_app = msg_id(shared_ws, sel_front);
    if (!front_app) {
        return true;
    }

    SEL sel_pid = sel_registerName("processIdentifier");
    int32_t (*msg_pid)(id, SEL) = (int32_t (*)(id, SEL))objc_msgSend;
    int32_t front_pid = msg_pid(front_app, sel_pid);
    if (front_pid == target_pid) {
        return true;
    }
    if (current_app && front_pid == msg_pid(current_app, sel_pid)) {
        return true;
    }

    /*
     * MH-05: Never substring-match bare "electron" here — our own Electron PID is
     * already matched above via current_app.processIdentifier, and matching "electron"
     * would steal focus from unrelated user apps (VS Code, Slack, Discord, etc.).
     */
    SEL sel_bundle_id = sel_registerName("bundleIdentifier");
    const char *bundle_utf8 = nsstring_to_utf8(msg_id(front_app, sel_bundle_id));
    if (bundle_utf8 && bundle_utf8[0]) {
        char lower_bid[256];
        str_to_lower_ascii(bundle_utf8, lower_bid, sizeof(lower_bid));
        if (contains_ascii_sub(lower_bid, "crossover") ||
            contains_ascii_sub(lower_bid, "wine") ||
            contains_ascii_sub(lower_bid, "onelauncher")) {
            return true;
        }
    }

    SEL sel_loc_name = sel_registerName("localizedName");
    const char *name_utf8 = nsstring_to_utf8(msg_id(front_app, sel_loc_name));
    if (name_utf8 && name_utf8[0]) {
        char lower_name[256];
        str_to_lower_ascii(name_utf8, lower_name, sizeof(lower_name));
        if (starts_with_ascii(lower_name, "wine") ||
            ends_with_ascii(lower_name, ".exe") ||
            contains_ascii_sub(lower_name, "crossover") ||
            contains_ascii_sub(lower_name, "one launcher") ||
            contains_ascii_sub(lower_name, "onelauncher")) {
            return true;
        }
    }

    SEL sel_exe_url = sel_registerName("executableURL");
    SEL sel_path = sel_registerName("path");
    id exe_url = msg_id(front_app, sel_exe_url);
    const char *exe_utf8 = exe_url ? nsstring_to_utf8(msg_id(exe_url, sel_path)) : NULL;
    if (exe_utf8 && exe_utf8[0]) {
        char lower_exe[512];
        str_to_lower_ascii(exe_utf8, lower_exe, sizeof(lower_exe));
        if (contains_ascii_sub(lower_exe, "/wine") ||
            contains_ascii_sub(lower_exe, "crossover") ||
            contains_ascii_sub(lower_exe, "gameportingtoolkit")) {
            return true;
        }
    }

    return false;
}

static bool coop_activate_pid(int32_t pid) {
    Class cls_run_app = objc_getClass("NSRunningApplication");
    Class cls_ns_app = objc_getClass("NSApplication");
    if (!cls_run_app || !cls_ns_app) {
        return false;
    }

    SEL sel_with_pid = sel_registerName("runningApplicationWithProcessIdentifier:");
    id (*msg_with_pid)(id, SEL, int32_t) = (id (*)(id, SEL, int32_t))objc_msgSend;
    id target_app = msg_with_pid((id)cls_run_app, sel_with_pid, pid);
    if (!target_app) {
        return false;
    }

    SEL sel_is_active = sel_registerName("isActive");
    BOOL (*msg_bool)(id, SEL) = (BOOL (*)(id, SEL))objc_msgSend;
    if (msg_bool(target_app, sel_is_active)) {
        return true;
    }

    SEL sel_shared_app = sel_registerName("sharedApplication");
    id (*msg_id)(id, SEL) = (id (*)(id, SEL))objc_msgSend;
    id ns_app = msg_id((id)cls_ns_app, sel_shared_app);

    SEL sel_current_app = sel_registerName("currentApplication");
    id current_app = msg_id((id)cls_run_app, sel_current_app);

    if (!can_cooperatively_transfer_from_frontmost(ns_app, current_app, pid)) {
        return false;
    }

    SEL sel_responds = sel_registerName("respondsToSelector:");
    BOOL (*msg_responds)(id, SEL, SEL) = (BOOL (*)(id, SEL, SEL))objc_msgSend;

    SEL sel_yield = sel_registerName("yieldActivationToApplication:");
    if (ns_app && msg_responds(ns_app, sel_responds, sel_yield)) {
        void (*msg_yield)(id, SEL, id) = (void (*)(id, SEL, id))objc_msgSend;
        msg_yield(ns_app, sel_yield, target_app);
    }

    SEL sel_act_from = sel_registerName("activateFromApplication:options:");
    if (current_app && msg_responds(target_app, sel_responds, sel_act_from)) {
        /* NSApplicationActivateAllWindows = 1 << 0 */
        BOOL (*msg_act_from)(id, SEL, id, uintptr_t) =
            (BOOL (*)(id, SEL, id, uintptr_t))objc_msgSend;
        (void)msg_act_from(target_app, sel_act_from, current_app, (uintptr_t)1);
    }
    if (!msg_bool(target_app, sel_is_active)) {
        SEL sel_act_opts = sel_registerName("activateWithOptions:");
        if (msg_responds(target_app, sel_responds, sel_act_opts)) {
            BOOL (*msg_act_opts)(id, SEL, uintptr_t) =
                (BOOL (*)(id, SEL, uintptr_t))objc_msgSend;
            (void)msg_act_opts(target_app, sel_act_opts, (uintptr_t)3);
        }
    }

    return msg_bool(target_app, sel_is_active) != 0;
}

static void parse_optional_scope_arg(napi_env env, napi_callback_info info, coop_scope_t *out_scope) {
    memset(out_scope, 0, sizeof(*out_scope));
    size_t argc = 1;
    napi_value argv[1] = { NULL };
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 || !argv[0]) {
        return;
    }
    napi_valuetype arg_type = napi_undefined;
    if (napi_typeof(env, argv[0], &arg_type) != napi_ok || arg_type != napi_object) {
        return;
    }

    napi_value root_pid_val = NULL;
    if (napi_get_named_property(env, argv[0], "rootPid", &root_pid_val) == napi_ok && root_pid_val) {
        napi_valuetype pid_type = napi_undefined;
        if (napi_typeof(env, root_pid_val, &pid_type) == napi_ok && pid_type == napi_number) {
            int32_t rpid = 0;
            if (napi_get_value_int32(env, root_pid_val, &rpid) == napi_ok && rpid > 0) {
                out_scope->root_pid = rpid;
            }
        }
    }

    napi_value exes_val = NULL;
    if (napi_get_named_property(env, argv[0], "targetExeNames", &exes_val) == napi_ok && exes_val) {
        bool is_arr = false;
        if (napi_is_array(env, exes_val, &is_arr) == napi_ok && is_arr) {
            uint32_t arr_len = 0;
            if (napi_get_array_length(env, exes_val, &arr_len) == napi_ok) {
                for (uint32_t i = 0; i < arr_len && out_scope->target_count < COOP_MAX_TARGET_EXES; i++) {
                    napi_value item = NULL;
                    if (napi_get_element(env, exes_val, i, &item) != napi_ok || !item) continue;
                    napi_valuetype item_type = napi_undefined;
                    if (napi_typeof(env, item, &item_type) != napi_ok || item_type != napi_string) continue;
                    char raw[COOP_MAX_EXE_NAME];
                    size_t copied = 0;
                    if (napi_get_value_string_utf8(env, item, raw, sizeof(raw), &copied) == napi_ok && copied > 0) {
                        raw[sizeof(raw) - 1] = '\0';
                        char lower_base[COOP_MAX_EXE_NAME];
                        str_to_lower_ascii(ascii_basename(raw), lower_base, sizeof(lower_base));
                        if (lower_base[0] != '\0') {
                            strncpy(out_scope->target_exes[out_scope->target_count], lower_base, COOP_MAX_EXE_NAME - 1);
                            out_scope->target_exes[out_scope->target_count][COOP_MAX_EXE_NAME - 1] = '\0';
                            out_scope->target_count++;
                        }
                    }
                }
            }
        }
    }
    napi_value bottle_val = NULL;
    if (napi_get_named_property(env, argv[0], "bottlePath", &bottle_val) == napi_ok && bottle_val) {
        napi_valuetype bt_type = napi_undefined;
        if (napi_typeof(env, bottle_val, &bt_type) == napi_ok && bt_type == napi_string) {
            char raw_bottle[COOP_MAX_BOTTLE_PATH];
            size_t copied = 0;
            if (napi_get_value_string_utf8(env, bottle_val, raw_bottle, sizeof(raw_bottle), &copied) == napi_ok &&
                copied > 0) {
                raw_bottle[sizeof(raw_bottle) - 1] = '\0';
                normalize_bottle_path_lower(raw_bottle, out_scope->bottle_path, sizeof(out_scope->bottle_path));
            }
        }
    }
}

/*
 * JS return encoding (int32):
 *   0 => no candidate bottled game window on screen yet
 *   bit 0 (1) => candidate window found
 *   bit 1 (2) => target game NSRunningApplication.isActive == true
 *   bits 2..15 => clamped kCGWindowLayer (0..8191)
 *   bits 16..30 => lower 15 bits of pid (for transition detection)
 */
static napi_value poll_and_activate_bottled_game(napi_env env, napi_callback_info info) {
    coop_scope_t scope;
    parse_optional_scope_arg(env, info, &scope);

    int32_t pid = 0;
    int32_t layer = 0;
    bool is_borderless_fs = false;
    int32_t encoded = 0;

    /* MH-04: Drain autoreleased AppKit/ObjC objects on every 200ms poll tick */
    void *pool = objc_autoreleasePoolPush();
    if (find_top_bottled_game_window(&scope, &pid, &layer, &is_borderless_fs)) {
        bool active = coop_activate_pid(pid);
        bool should_auto_hide_chrome = false;
        if (is_borderless_fs) {
            /*
             * Apply NSApplicationPresentationAutoHideMenuBar | NSApplicationPresentationAutoHideDock
             * when a borderless fullscreen game covers >= 95% of the display at layer == 0,
             * and restore cleanly when windowed or when the user switches to another app.
             */
            Class cls_run_app = objc_getClass("NSRunningApplication");
            Class cls_ns_app = objc_getClass("NSApplication");
            id (*msg_id)(id, SEL) = (id (*)(id, SEL))objc_msgSend;
            id ns_app = cls_ns_app ? msg_id((id)cls_ns_app, sel_registerName("sharedApplication")) : NULL;
            id current_app = cls_run_app ? msg_id((id)cls_run_app, sel_registerName("currentApplication")) : NULL;
            should_auto_hide_chrome =
                active || can_cooperatively_transfer_from_frontmost(ns_app, current_app, pid);
        }
        if (should_auto_hide_chrome) {
            (void)set_borderless_presentation_options(true);
        } else if (g_borderless_presentation_applied) {
            (void)set_borderless_presentation_options(false);
        }
        int32_t clamped_layer = layer < 0 ? 0 : (layer > 8191 ? 8191 : layer);
        int32_t pid_tag = (pid & 0x7fff);
        encoded = 1 | (active ? 2 : 0) | (clamped_layer << 2) | (pid_tag << 16);
    } else if (g_borderless_presentation_applied) {
        (void)set_borderless_presentation_options(false);
    }
    objc_autoreleasePoolPop(pool);

    napi_value out = NULL;
    napi_create_int32(env, encoded, &out);
    return out;
}

static napi_value restore_presentation_options(napi_env env, napi_callback_info info) {
    (void)info;
    void *pool = objc_autoreleasePoolPush();
    bool ok = set_borderless_presentation_options(false);
    objc_autoreleasePoolPop(pool);

    napi_value out = NULL;
    napi_get_boolean(env, ok, &out);
    return out;
}

static napi_value is_borderless_fullscreen_window_js(napi_env env, napi_callback_info info) {
    size_t argc = 5;
    napi_value argv[5] = { NULL, NULL, NULL, NULL, NULL };
    bool result = false;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc >= 5) {
        double fw = 0.0, fh = 0.0, sw = 0.0, sh = 0.0;
        int32_t layer = 0;
        if (napi_get_value_double(env, argv[0], &fw) == napi_ok &&
            napi_get_value_double(env, argv[1], &fh) == napi_ok &&
            napi_get_value_double(env, argv[2], &sw) == napi_ok &&
            napi_get_value_double(env, argv[3], &sh) == napi_ok &&
            napi_get_value_int32(env, argv[4], &layer) == napi_ok) {
            result = is_borderless_fullscreen_rect(
                CGRectMake(0.0, 0.0, fw, fh),
                CGRectMake(0.0, 0.0, sw, sh),
                layer
            );
        }
    }
    napi_value out = NULL;
    napi_get_boolean(env, result, &out);
    return out;
}

/*
 * MH-05 / MH-06 / SUP-05: Restore permanent host CoreGraphics display modes and
 * ColorSync gamma tables after an abnormal/SIGKILL game exit.
 */
static napi_value restore_host_display_configuration(napi_env env, napi_callback_info info) {
    (void)info;
    void *pool = objc_autoreleasePoolPush();
    (void)set_borderless_presentation_options(false);
    CGRestorePermanentDisplayConfiguration();
    CGDisplayRestoreColorSyncSettings();
    objc_autoreleasePoolPop(pool);

    napi_value out = NULL;
    napi_get_boolean(env, true, &out);
    return out;
}

/*
 * MH-06: Fast in-process CoreGraphics screen-lock check (replaces slow `swift -e`
 * shell invocation in scripts/verify-display-output.cjs).
 */
static napi_value is_session_screen_locked(napi_env env, napi_callback_info info) {
    (void)info;
    bool locked = false;
    CFDictionaryRef sess = CGSessionCopyCurrentDictionary();
    if (sess) {
        CFTypeRef val = CFDictionaryGetValue(sess, CFSTR("CGSSessionScreenIsLocked"));
        if (val) {
            if (CFGetTypeID(val) == CFBooleanGetTypeID()) {
                locked = CFBooleanGetValue((CFBooleanRef)val) != 0;
            } else if (CFGetTypeID(val) == CFNumberGetTypeID()) {
                int num = 0;
                if (CFNumberGetValue((CFNumberRef)val, kCFNumberIntType, &num)) {
                    locked = (num != 0);
                }
            }
        }
        CFRelease(sess);
    }
    napi_value out = NULL;
    napi_get_boolean(env, locked, &out);
    return out;
}

static void export_napi_fn(napi_env env, napi_value exports, const char *name, napi_callback cb) {
    napi_value fn = NULL;
    if (napi_create_function(env, name, strlen(name), cb, NULL, &fn) == napi_ok && fn != NULL) {
        napi_set_named_property(env, exports, name, fn);
    }
}

__attribute__((visibility("default")))
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    export_napi_fn(env, exports, "pollAndActivateBottledGame", poll_and_activate_bottled_game);
    export_napi_fn(env, exports, "restorePresentationOptions", restore_presentation_options);
    export_napi_fn(env, exports, "isBorderlessFullscreenWindow", is_borderless_fullscreen_window_js);
    export_napi_fn(env, exports, "restoreHostDisplayConfiguration", restore_host_display_configuration);
    export_napi_fn(env, exports, "isSessionScreenLocked", is_session_screen_locked);
    return exports;
}
