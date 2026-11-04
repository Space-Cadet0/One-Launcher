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
#include <objc/message.h>
#include <objc/runtime.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* Minimal ABI-stable Node-API v1 declarations */
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;

typedef enum {
    napi_ok = 0
} napi_status;

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

static bool is_ignored_helper_owner(const char *lower_owner) {
    static const char *const kIgnored[] = {
        "explorer.exe",
        "services.exe",
        "winedevice.exe",
        "plugplay.exe",
        "svchost.exe",
        "rpcss.exe",
        "conhost.exe",
        "tabtip.exe",
        "one_display_launcher_x86.exe",
        "one_display_launcher_x64.exe",
        "galaxyclient.exe",
        "galaxyclient helper.exe",
        "gog galaxy notifications renderer.exe",
        "qtwebengineprocess.exe",
        "python.exe",
        "steam.exe",
        "steamwebhelper.exe",
        "epicgameslauncher.exe",
        "epicwebhelper.exe",
    };
    for (size_t i = 0; i < sizeof(kIgnored) / sizeof(kIgnored[0]); i++) {
        if (strcmp(lower_owner, kIgnored[i]) == 0) {
            return true;
        }
    }
    return false;
}

static bool find_top_bottled_game_window(int32_t *out_pid, int32_t *out_layer) {
    *out_pid = 0;
    *out_layer = 0;

    CFArrayRef win_list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID
    );
    if (!win_list) {
        return false;
    }

    bool found = false;
    CFIndex count = CFArrayGetCount(win_list);
    for (CFIndex i = 0; i < count; i++) {
        CFDictionaryRef dict = (CFDictionaryRef)CFArrayGetValueAtIndex(win_list, i);
        if (!dict || CFGetTypeID(dict) != CFDictionaryGetTypeID()) continue;

        CFStringRef owner_ref = (CFStringRef)CFDictionaryGetValue(dict, kCGWindowOwnerName);
        if (!owner_ref || CFGetTypeID(owner_ref) != CFStringGetTypeID()) continue;

        char owner_buf[256];
        if (!CFStringGetCString(owner_ref, owner_buf, sizeof(owner_buf), kCFStringEncodingUTF8)) {
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

        *out_pid = pid;
        *out_layer = layer;
        found = true;
        break;
    }

    CFRelease(win_list);
    return found;
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

    SEL sel_responds = sel_registerName("respondsToSelector:");
    BOOL (*msg_responds)(id, SEL, SEL) = (BOOL (*)(id, SEL, SEL))objc_msgSend;

    SEL sel_yield = sel_registerName("yieldActivationToApplication:");
    if (ns_app && msg_responds(ns_app, sel_responds, sel_yield)) {
        void (*msg_yield)(id, SEL, id) = (void (*)(id, SEL, id))objc_msgSend;
        msg_yield(ns_app, sel_yield, target_app);
    }

    SEL sel_current_app = sel_registerName("currentApplication");
    id current_app = msg_id((id)cls_run_app, sel_current_app);

    SEL sel_act_from = sel_registerName("activateFromApplication:options:");
    if (current_app && msg_responds(target_app, sel_responds, sel_act_from)) {
        /* NSApplicationActivateAllWindows = 1 << 0 */
        BOOL (*msg_act_from)(id, SEL, id, uintptr_t) =
            (BOOL (*)(id, SEL, id, uintptr_t))objc_msgSend;
        (void)msg_act_from(target_app, sel_act_from, current_app, (uintptr_t)1);
    } else {
        SEL sel_act_opts = sel_registerName("activateWithOptions:");
        if (msg_responds(target_app, sel_responds, sel_act_opts)) {
            BOOL (*msg_act_opts)(id, SEL, uintptr_t) =
                (BOOL (*)(id, SEL, uintptr_t))objc_msgSend;
            (void)msg_act_opts(target_app, sel_act_opts, (uintptr_t)3);
        }
    }

    return msg_bool(target_app, sel_is_active) != 0;
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
    (void)info;
    int32_t pid = 0;
    int32_t layer = 0;
    int32_t encoded = 0;

    if (find_top_bottled_game_window(&pid, &layer)) {
        bool active = coop_activate_pid(pid);
        int32_t clamped_layer = layer < 0 ? 0 : (layer > 8191 ? 8191 : layer);
        int32_t pid_tag = (pid & 0x7fff);
        encoded = 1 | (active ? 2 : 0) | (clamped_layer << 2) | (pid_tag << 16);
    }

    napi_value out = NULL;
    napi_create_int32(env, encoded, &out);
    return out;
}

__attribute__((visibility("default")))
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    napi_value fn = NULL;
    if (napi_create_function(
            env,
            "pollAndActivateBottledGame",
            26,
            poll_and_activate_bottled_game,
            NULL,
            &fn) == napi_ok &&
        fn != NULL) {
        napi_set_named_property(env, exports, "pollAndActivateBottledGame", fn);
    }
    return exports;
}
