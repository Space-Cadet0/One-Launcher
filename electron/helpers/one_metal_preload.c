/*
 * One Launcher macOS Metal & MoltenVK Preload Helper (`one_metal_preload.c`)
 *
 * Preloads Apple's Metal framework and MoltenVK before CrossOver/Wine initializes
 * Vulkan/D3DMetal, checking loaded dyld images (`_dyld_image_count` / `_dyld_get_image_name`)
 * first so MoltenVK is never instantiated twice in the same process (`D7.2`).
 *
 * Compile with:
 *   clang -dynamiclib -arch x86_64 -arch arm64 -O2 \
 *     -framework Foundation -framework Metal -framework QuartzCore \
 *     electron/helpers/one_metal_preload.c -o electron/helpers/bin/one_metal_preload.dylib
 */

#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdlib.h>

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

__attribute__((constructor))
static void preload_metal_and_moltenvk(void) {
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

    if (!is_moltenvk_already_loaded()) {
        dlopen("libMoltenVK.dylib", RTLD_LAZY | RTLD_GLOBAL);
    }
}
