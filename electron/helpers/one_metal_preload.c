/*
 * One Launcher macOS Metal, MoltenVK & CoreAudio Preload Helper (`one_metal_preload.c`)
 *
 * 1. Clamps the macOS default output device CoreAudio HAL buffer size down to ~5 ms
 *    (e.g. 512 -> 240 frames @ 48 kHz) when `ONE_LAUNCHER_AUDIO_BUFFER_CLAMP != "0"`,
 *    so 10.67 ms CoreAudio pull cycles never underrun Wine's 10 ms WASAPI period.
 * 2. Preloads Apple's Metal framework and MoltenVK (`MVK_ICD_LIBRARY_PATH` or
 *    `ONE_LAUNCHER_MOLTENVK_PATH`) before CrossOver/Wine initializes Vulkan/D3DMetal,
 *    checking loaded dyld images (`_dyld_image_count` / `_dyld_get_image_name`) first
 *    so MoltenVK is never instantiated twice in the same process (`D7.2`).
 *
 * Clean-room MIT implementation using public Apple CoreAudio & dyld APIs.
 */

#include <CoreAudio/CoreAudio.h>
#include <crt_externs.h>
#include <dlfcn.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <mach/thread_policy.h>
#include <math.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

typedef OSStatus (*one_audio_get_prop_fn)(
    AudioObjectID inObjectID,
    const AudioObjectPropertyAddress *inAddress,
    UInt32 inQualifierDataSize,
    const void *inQualifierData,
    UInt32 *ioDataSize,
    void *outData
);

typedef OSStatus (*one_audio_set_prop_fn)(
    AudioObjectID inObjectID,
    const AudioObjectPropertyAddress *inAddress,
    UInt32 inQualifierDataSize,
    const void *inQualifierData,
    UInt32 inDataSize,
    const void *inData
);

static int ascii_tolower_char(int c) {
    return (c >= 'A' && c <= 'Z') ? (c + ('a' - 'A')) : c;
}

static int contains_ascii_icase(const char *haystack, const char *needle) {
    if (!haystack || !needle || !needle[0]) return 0;
    for (const char *h = haystack; *h; ++h) {
        const char *p = h;
        const char *n = needle;
        while (*p && *n && ascii_tolower_char((unsigned char)*p) == ascii_tolower_char((unsigned char)*n)) {
            ++p;
            ++n;
        }
        if (*n == '\0') return 1;
    }
    return 0;
}

static int is_moltenvk_already_loaded(void) {
    uint32_t count = _dyld_image_count();
    for (uint32_t i = 0; i < count; ++i) {
        const char *name = _dyld_get_image_name(i);
        if (name && contains_ascii_icase(name, "MoltenVK")) {
            return 1;
        }
    }
    return 0;
}

static void clamp_default_output_audio_buffer_to_5ms(void) {
    const char *clamp_env = getenv("ONE_LAUNCHER_AUDIO_BUFFER_CLAMP");
    if (clamp_env && clamp_env[0] == '0') {
        return;
    }

    void *ca_handle = dlopen("/System/Library/Frameworks/CoreAudio.framework/CoreAudio", RTLD_LAZY | RTLD_LOCAL);
    if (!ca_handle) {
        return;
    }

    one_audio_get_prop_fn get_prop = (one_audio_get_prop_fn)dlsym(ca_handle, "AudioObjectGetPropertyData");
    one_audio_set_prop_fn set_prop = (one_audio_set_prop_fn)dlsym(ca_handle, "AudioObjectSetPropertyData");
    if (!get_prop || !set_prop) {
        return;
    }

    AudioObjectID output_device = kAudioObjectUnknown;
    UInt32 prop_size = (UInt32)sizeof(output_device);
    AudioObjectPropertyAddress dev_addr = {
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        0
    };
    if (get_prop(kAudioObjectSystemObject, &dev_addr, 0, NULL, &prop_size, &output_device) != noErr ||
        output_device == kAudioObjectUnknown) {
        return;
    }

    /*
     * Skip 5 ms CoreAudio buffer clamping on wireless / network audio transports
     * (Bluetooth, Bluetooth LE, AirPlay, AVB) where aggressive 240-frame pull cycles
     * starve packetized wireless codecs.
     */
    {
        UInt32 transport_type = 0;
        UInt32 trans_size = (UInt32)sizeof(transport_type);
        AudioObjectPropertyAddress trans_addr = {
            kAudioDevicePropertyTransportType,
            kAudioObjectPropertyScopeGlobal,
            0
        };
        OSStatus trans_st = get_prop(output_device, &trans_addr, 0, NULL, &trans_size, &transport_type);
        if (trans_st != noErr) {
            trans_addr.mScope = kAudioObjectPropertyScopeOutput;
            trans_size = (UInt32)sizeof(transport_type);
            trans_st = get_prop(output_device, &trans_addr, 0, NULL, &trans_size, &transport_type);
        }
        if (trans_st == noErr) {
#ifndef kAudioDeviceTransportTypeBluetooth
#define kAudioDeviceTransportTypeBluetooth   0x626c7574u /* 'blut' */
#endif
#ifndef kAudioDeviceTransportTypeBluetoothLE
#define kAudioDeviceTransportTypeBluetoothLE 0x626c6561u /* 'blea' */
#endif
#ifndef kAudioDeviceTransportTypeAirPlay
#define kAudioDeviceTransportTypeAirPlay     0x61697270u /* 'airp' */
#endif
#ifndef kAudioDeviceTransportTypeAVB
#define kAudioDeviceTransportTypeAVB         0x65617662u /* 'eavb' */
#endif
            if (transport_type == kAudioDeviceTransportTypeBluetooth ||
                transport_type == kAudioDeviceTransportTypeBluetoothLE ||
                transport_type == kAudioDeviceTransportTypeAirPlay ||
                transport_type == kAudioDeviceTransportTypeAVB) {
                return;
            }
        }
    }

    Float64 sample_rate = 0.0;
    prop_size = (UInt32)sizeof(sample_rate);
    AudioObjectPropertyAddress rate_addr = {
        kAudioDevicePropertyNominalSampleRate,
        kAudioObjectPropertyScopeOutput,
        0
    };
    if (get_prop(output_device, &rate_addr, 0, NULL, &prop_size, &sample_rate) != noErr || sample_rate <= 0.0) {
        rate_addr.mScope = kAudioObjectPropertyScopeGlobal;
        prop_size = (UInt32)sizeof(sample_rate);
        if (get_prop(output_device, &rate_addr, 0, NULL, &prop_size, &sample_rate) != noErr) {
            return;
        }
    }
    if (!isfinite(sample_rate) || sample_rate < 8000.0 || sample_rate > 384000.0) {
        return;
    }

    AudioValueRange frame_range = { 0.0, 0.0 };
    prop_size = (UInt32)sizeof(frame_range);
    AudioObjectPropertyAddress range_addr = {
        kAudioDevicePropertyBufferFrameSizeRange,
        kAudioObjectPropertyScopeOutput,
        0
    };
    if (get_prop(output_device, &range_addr, 0, NULL, &prop_size, &frame_range) != noErr ||
        !isfinite(frame_range.mMinimum) || !isfinite(frame_range.mMaximum) ||
        frame_range.mMaximum <= 0.0) {
        range_addr.mScope = kAudioObjectPropertyScopeGlobal;
        prop_size = (UInt32)sizeof(frame_range);
        if (get_prop(output_device, &range_addr, 0, NULL, &prop_size, &frame_range) != noErr ||
            !isfinite(frame_range.mMinimum) || !isfinite(frame_range.mMaximum) ||
            frame_range.mMaximum <= 0.0) {
            return;
        }
    }

    UInt32 current_frames = 0;
    prop_size = (UInt32)sizeof(current_frames);
    AudioObjectPropertyAddress buf_addr = {
        kAudioDevicePropertyBufferFrameSize,
        kAudioObjectPropertyScopeOutput,
        0
    };
    if (get_prop(output_device, &buf_addr, 0, NULL, &prop_size, &current_frames) != noErr ||
        current_frames == 0) {
        buf_addr.mScope = kAudioObjectPropertyScopeGlobal;
        prop_size = (UInt32)sizeof(current_frames);
        if (get_prop(output_device, &buf_addr, 0, NULL, &prop_size, &current_frames) != noErr ||
            current_frames == 0) {
            return;
        }
    }

    double desired_5ms_frames = ceil(sample_rate * 0.005);
    double min_allowed = frame_range.mMinimum > 32.0 ? frame_range.mMinimum : 32.0;
    double max_allowed = frame_range.mMaximum < 65536.0 ? frame_range.mMaximum : 65536.0;
    if (max_allowed < min_allowed) {
        max_allowed = min_allowed < 65536.0 ? min_allowed : 65536.0;
    }
    double clamped_frames = desired_5ms_frames < min_allowed ? min_allowed : desired_5ms_frames;
    if (clamped_frames > max_allowed) {
        clamped_frames = max_allowed;
    }
    if (!isfinite(clamped_frames) || clamped_frames < 32.0 || clamped_frames > 65536.0) {
        return;
    }

    UInt32 target_frames = (UInt32)clamped_frames;
    if (target_frames >= 32 && current_frames > target_frames) {
        set_prop(output_device, &buf_addr, 0, NULL, (UInt32)sizeof(target_frames), &target_frames);
    }
}

/*
 * Promote Wine's CoreAudio timer loop thread ("audio_client_timer") to Mach
 * THREAD_TIME_CONSTRAINT_POLICY (10 ms period, 5 ms computation, 10 ms constraint,
 * preemptible = 1) so periodic audio buffer wakeups are not starved by E-core scheduling
 * or Rosetta JIT translation bursts.
 */
static void promote_current_thread_to_audio_realtime(void) {
    const char *rt_env = getenv("ONE_LAUNCHER_AUDIO_RT_THREAD");
    if (rt_env && rt_env[0] == '0') {
        return;
    }

    mach_timebase_info_data_t tb = { 0, 0 };
    if (mach_timebase_info(&tb) != KERN_SUCCESS || tb.numer == 0 || tb.denom == 0) {
        return;
    }

    const uint64_t ns_per_ms    = 1000000ULL;
    const uint64_t period_ticks = (10ULL * ns_per_ms * (uint64_t)tb.denom) / (uint64_t)tb.numer;
    const uint64_t comp_ticks   = (5ULL  * ns_per_ms * (uint64_t)tb.denom) / (uint64_t)tb.numer;
    const uint64_t constr_ticks = (10ULL * ns_per_ms * (uint64_t)tb.denom) / (uint64_t)tb.numer;

    if (period_ticks == 0 || comp_ticks == 0 || constr_ticks == 0 ||
        period_ticks > (uint64_t)UINT32_MAX ||
        comp_ticks > (uint64_t)UINT32_MAX ||
        constr_ticks > (uint64_t)UINT32_MAX) {
        return;
    }

    thread_time_constraint_policy_data_t policy;
    policy.period      = (uint32_t)period_ticks;
    policy.computation = (uint32_t)comp_ticks;
    policy.constraint  = (uint32_t)constr_ticks;
    policy.preemptible = 1;

    mach_port_t self_thread = mach_thread_self();
    if (self_thread != MACH_PORT_NULL) {
        (void)thread_policy_set(
            self_thread,
            THREAD_TIME_CONSTRAINT_POLICY,
            (thread_policy_t)&policy,
            THREAD_TIME_CONSTRAINT_POLICY_COUNT
        );
        (void)mach_port_deallocate(mach_task_self(), self_thread);
    }
}

static int one_launcher_pthread_setname_np(const char *name) {
    int rc = pthread_setname_np(name);
    if (name && strcmp(name, "audio_client_timer") == 0) {
        promote_current_thread_to_audio_realtime();
    }
    return rc;
}

typedef struct one_launcher_dyld_interpose_tuple {
    const void *replacement;
    const void *replacee;
} one_launcher_dyld_interpose_tuple_t;

__attribute__((used, section("__DATA,__interpose")))
#if defined(__has_feature)
#  if __has_feature(address_sanitizer)
__attribute__((no_sanitize("address")))
#  endif
#endif
static const one_launcher_dyld_interpose_tuple_t g_one_launcher_interpose_tuples[] = {
    {
        (const void *)(uintptr_t)&one_launcher_pthread_setname_np,
        (const void *)(uintptr_t)&pthread_setname_np,
    },
};

static int arg_basename_matches_ci(const char *arg, const char *target_lower) {
    if (!arg || !target_lower) {
        return 0;
    }
    const char *base = arg;
    for (const char *p = arg; *p != '\0'; ++p) {
        if (*p == '/' || *p == '\\') {
            base = p + 1;
        }
    }
    return strcasecmp(base, target_lower) == 0;
}

/*
 * Guard non-GUI Wine daemon/helper processes (reg.exe, wineboot.exe, conhost.exe,
 * services.exe, plugplay.exe, rpcss.exe, svchost.exe, winedevice.exe) so preloading via
 * CX_ENV never initializes Metal HUD / CFRunLoopRun or touches CoreAudio inside background helpers.
 */
static int is_non_gui_wine_helper_process(void) {
    const char *suppress = getenv("ONE_LAUNCHER_SUPPRESS_PRELOAD");
    if (suppress && suppress[0] == '1') {
        return 1;
    }

    int *argc_ptr = _NSGetArgc();
    char ***argv_ptr = _NSGetArgv();
    if (!argc_ptr || !argv_ptr || !*argv_ptr || *argc_ptr <= 0) {
        return 0;
    }

    static const char *const k_loader_wrappers[] = {
        "wine",
        "wine64",
        "wine32on64",
        "wine-preloader",
        "wine64-preloader",
        "wine32on64-preloader",
        "crossover",
        "start.exe",
        "start",
    };

    static const char *const k_helper_exes[] = {
        "wineserver",
        "reg.exe",
        "reg",
        "regedit.exe",
        "regsvr32.exe",
        "wineboot.exe",
        "wineboot",
        "conhost.exe",
        "services.exe",
        "plugplay.exe",
        "rpcss.exe",
        "svchost.exe",
        "winedevice.exe",
        "winecfg.exe",
        "explorer.exe",
        "rundll32.exe",
        "cmd.exe",
        "powershell.exe",
        "one_display_launcher_x86.exe",
        "one_display_launcher_x64.exe",
        "one_xgr_win_launcher.exe",
        "one_xgr_win_launcher_x86.exe",
    };

    const int argc = *argc_ptr < 32 ? *argc_ptr : 32;
    char **argv = *argv_ptr;
    if (argv[0] && arg_basename_matches_ci(argv[0], "wineserver")) {
        return 1;
    }

    for (int i = 1; i < argc; ++i) {
        const char *arg = argv[i];
        if (!arg || arg[0] == '\0' || arg[0] == '-') {
            continue;
        }
        /* Skip start.exe switch flags such as /unix, /exec, /b, /wait, /min */
        if (arg[0] == '/' && strlen(arg) <= 6 && strchr(arg + 1, '/') == NULL) {
            continue;
        }

        int is_wrapper = 0;
        for (size_t w = 0; w < sizeof(k_loader_wrappers) / sizeof(k_loader_wrappers[0]); ++w) {
            if (arg_basename_matches_ci(arg, k_loader_wrappers[w])) {
                is_wrapper = 1;
                break;
            }
        }
        if (is_wrapper) {
            continue;
        }

        for (size_t h = 0; h < sizeof(k_helper_exes) / sizeof(k_helper_exes[0]); ++h) {
            if (arg_basename_matches_ci(arg, k_helper_exes[h])) {
                return 1;
            }
        }
        /* First real target executable token inspected: if it is not a helper daemon, allow preload */
        break;
    }
    return 0;
}

__attribute__((constructor))
static void preload_metal_and_moltenvk(void) {
    if (is_non_gui_wine_helper_process()) {
        return;
    }

    clamp_default_output_audio_buffer_to_5ms();

    const char *enabled = getenv("ONE_LAUNCHER_METAL_PRELOAD");
    if (enabled && enabled[0] == '0') {
        return;
    }

    /* Warm Metal framework early so Wine's winemetal / DXMT / D3DMetal finds symbols resident */
    dlopen("/System/Library/Frameworks/Metal.framework/Metal", RTLD_LAZY | RTLD_GLOBAL);

    /* D7.2: Skip dlopen if any MoltenVK dylib is already mapped into dyld */
    if (is_moltenvk_already_loaded()) {
        return;
    }

    const char *mvk_path = getenv("MVK_ICD_LIBRARY_PATH");
    if (mvk_path && mvk_path[0]) {
        if (dlopen(mvk_path, RTLD_LAZY | RTLD_GLOBAL) != NULL || is_moltenvk_already_loaded()) {
            return;
        }
    }

    const char *legacy_mvk_path = getenv("ONE_LAUNCHER_MOLTENVK_PATH");
    if (legacy_mvk_path && legacy_mvk_path[0]) {
        if (dlopen(legacy_mvk_path, RTLD_LAZY | RTLD_GLOBAL) != NULL || is_moltenvk_already_loaded()) {
            return;
        }
    }

    if (!is_moltenvk_already_loaded()) {
        dlopen("libMoltenVK.dylib", RTLD_LAZY | RTLD_GLOBAL);
    }
}
