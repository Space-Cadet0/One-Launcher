/*
 * Milestone 1 Adversarial Empirical Challenger Stress Test & Oracle Harness
 * Tests:
 * 1. Mode Table Torture across diverse resolutions & refresh rates up to 5120x2880 (5K) and beyond.
 * 2. 10,000-case randomized fuzzer on ds_build_mode_table.
 * 3. Viewport Centering & Margin Symmetry (safe_inset_top = 0) across all standard & non-standard aspect ratios.
 * 4. 10,000-case randomized fuzzer on ds_compute_viewport (PRESERVE, INTEGER, STRETCH).
 * 5. Boundary & Extreme Value Invariants (zero, negative, INT32_MAX, NULL pointers).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <limits.h>
#include "display_scaler.h"

static int g_tests_run = 0;
static int g_tests_failed = 0;

#define CHK(cond, msg, ...) do { \
    g_tests_run++; \
    if (!(cond)) { \
        g_tests_failed++; \
        fprintf(stderr, "[FAIL] " msg " (at line %d)\n", ##__VA_ARGS__, __LINE__); \
    } \
} while(0)

/* Simple LCG PRNG for deterministic, reproducible fuzzing */
static uint64_t g_prng_state = 0x853c49e6748fea9bULL;
static uint32_t prng_u32(void)
{
    g_prng_state = g_prng_state * 6364136223846793005ULL + 1442695040888963407ULL;
    return (uint32_t)(g_prng_state >> 32);
}
static int32_t prng_range(int32_t min_v, int32_t max_v)
{
    if (min_v >= max_v) return min_v;
    uint32_t span = (uint32_t)(max_v - min_v + 1);
    return min_v + (int32_t)(prng_u32() % span);
}

/* --- 1. MODE TABLE TORTURE --- */

typedef struct {
    int32_t w;
    int32_t h;
    const char *desc;
} test_resolution_t;

static const test_resolution_t k_test_resolutions[] = {
    /* Required in dispatch */
    {  320,  200, "320x200 (16:10 legacy)" },
    {  640,  480, "640x480 (4:3 legacy VGA)" },
    {  800,  600, "800x600 (4:3 SVGA)" },
    { 1024,  768, "1024x768 (4:3 XGA)" },
    { 1280,  720, "1280x720 (16:9 HD)" },
    { 1920, 1080, "1920x1080 (16:9 FHD)" },
    { 2560, 1440, "2560x1440 (16:9 QHD)" },
    { 2560, 1600, "2560x1600 (16:10 WQXGA / MBA 13\")" },
    { 3024, 1964, "3024x1964 (16:10 MBP 14\" Liquid Retina)" },
    { 3840, 2160, "3840x2160 (16:9 4K UHD)" },
    { 5120, 2880, "5120x2880 (16:9 5K Retina)" },
    /* Additional torture resolutions */
    { 3456, 2234, "3456x2234 (MBP 16\" Liquid Retina)" },
    { 2880, 1800, "2880x1800 (MBP 15\" Retina)" },
    { 3440, 1440, "3440x1440 (21:9 Ultrawide)" },
    { 5120, 1440, "5120x1440 (32:9 Super Ultrawide)" },
    { 1920, 1200, "1920x1200 (16:10 WUXGA)" },
    { 1280, 1024, "1280x1024 (5:4 SXGA)" },
    { 1366,  768, "1366x768 (16:9 FWXGA)" },
    {  400,  300, "400x300 (Sub-VGA)" },
    { 7680, 4320, "7680x4320 (8K Extreme)" },
    /* Non-standard / odd dimensions */
    { 1921, 1081, "1921x1081 (Odd dimensions)" },
    { 3023, 1963, "3023x1963 (Odd Retina)" },
    /* Portrait / tall screens */
    { 1080, 1920, "1080x1920 (Portrait FHD)" },
    { 1440, 2560, "1440x2560 (Portrait QHD)" }
};

static const int32_t k_test_refresh_rates[] = { 60, 120, 144, 240, 59, 165, 360, 0, -5 };

static void verify_mode_table_invariants(
    const ds_display_mode_t *modes,
    size_t count,
    int32_t nw,
    int32_t nh,
    int32_t hz_in,
    const char *ctx
)
{
    int32_t expected_hz = (hz_in > 0) ? hz_in : 60;
    int32_t eff_nw = (nw > 0) ? nw : 1024;
    int32_t eff_nh = (nh > 0) ? nh : 768;

    /* Invariant 1: Mode count <= 52 (DS_MAX_SYNTH_MODES) */
    CHK(count <= DS_MAX_SYNTH_MODES, "%s: mode count %zu exceeds DS_MAX_SYNTH_MODES (%u)",
        ctx, count, DS_MAX_SYNTH_MODES);

    /* Invariant 2: Mode count >= 1 */
    CHK(count > 0, "%s: returned 0 modes", ctx);

    bool found_native_16 = false;
    bool found_native_32 = false;
    bool has_illegal_8bpp = false;
    bool duplicate_found = false;
    bool sort_violated = false;
    bool wrong_hz = false;

    for (size_t i = 0; i < count; i++) {
        if (modes[i].width == eff_nw && modes[i].height == eff_nh) {
            if (modes[i].bpp == 16) found_native_16 = true;
            if (modes[i].bpp == 32) found_native_32 = true;
        }

        if (modes[i].bpp == 8 && (modes[i].width > 1024 || modes[i].height > 768)) {
            has_illegal_8bpp = true;
        }

        if (modes[i].refresh_hz != expected_hz) {
            wrong_hz = true;
        }

        if (i > 0) {
            bool strictly_greater =
                (modes[i].width > modes[i - 1].width) ||
                (modes[i].width == modes[i - 1].width && modes[i].height > modes[i - 1].height) ||
                (modes[i].width == modes[i - 1].width && modes[i].height == modes[i - 1].height && modes[i].bpp > modes[i - 1].bpp);
            if (!strictly_greater) {
                if (modes[i].width == modes[i - 1].width &&
                    modes[i].height == modes[i - 1].height &&
                    modes[i].bpp == modes[i - 1].bpp) {
                    duplicate_found = true;
                } else {
                    sort_violated = true;
                }
            }
        }
    }

    /* Invariant 3: Native resolution at 16-bpp & 32-bpp NEVER dropped */
    CHK(found_native_16, "%s: native 16-bpp mode DROPPED", ctx);
    CHK(found_native_32, "%s: native 32-bpp mode DROPPED", ctx);

    /* Invariant 4: No 8-bpp above 1024x768 */
    CHK(!has_illegal_8bpp, "%s: contains 8-bpp mode above 1024x768", ctx);

    /* Invariant 5: No duplicates */
    CHK(!duplicate_found, "%s: duplicate modes found", ctx);

    /* Invariant 6: Strictly sorted ascending */
    CHK(!sort_violated, "%s: mode sort order violated", ctx);

    /* Invariant 7: Refresh rate accurate */
    CHK(!wrong_hz, "%s: mode with wrong refresh rate found", ctx);
}

static void test_mode_table_torture(void)
{
    printf("=== Starting Mode Table Torture Suite ===\n");
    size_t num_res = sizeof(k_test_resolutions) / sizeof(k_test_resolutions[0]);
    size_t num_hz = sizeof(k_test_refresh_rates) / sizeof(k_test_refresh_rates[0]);

    ds_display_mode_t modes[128];

    for (size_t r = 0; r < num_res; r++) {
        int32_t nw = k_test_resolutions[r].w;
        int32_t nh = k_test_resolutions[r].h;

        for (size_t h = 0; h < num_hz; h++) {
            int32_t hz_in = k_test_refresh_rates[h];
            memset(modes, 0, sizeof(modes));
            size_t count = ds_build_mode_table(nw, nh, hz_in, modes, 64);

            char ctx[128];
            snprintf(ctx, sizeof(ctx), "Torture %s @ %dHz", k_test_resolutions[r].desc, hz_in);
            verify_mode_table_invariants(modes, count, nw, nh, hz_in, ctx);
        }
    }
    printf("Mode Table Torture: %zu resolutions x %zu refresh rates tested.\n", num_res, num_hz);
}

static void test_mode_table_fuzzer(int iterations)
{
    printf("=== Starting Mode Table Fuzzer (%d iterations) ===\n", iterations);
    ds_display_mode_t modes[128];

    for (int i = 0; i < iterations; i++) {
        int32_t nw = prng_range(1, 8192);
        int32_t nh = prng_range(1, 8192);
        int32_t hz = prng_range(-10, 500);

        memset(modes, 0, sizeof(modes));
        size_t count = ds_build_mode_table(nw, nh, hz, modes, 64);

        char ctx[128];
        snprintf(ctx, sizeof(ctx), "Fuzzer #%d: %dx%d @ %dHz", i, nw, nh, hz);
        verify_mode_table_invariants(modes, count, nw, nh, hz, ctx);
    }
    printf("Mode Table Fuzzer: %d iterations completed successfully.\n", iterations);
}

/* --- 2. VIEWPORT CENTERING & MARGIN EQUALITY --- */

typedef struct {
    int32_t w;
    int32_t h;
    const char *aspect_name;
} test_virtual_mode_t;

static const test_virtual_mode_t k_test_virtual_modes[] = {
    /* 4:3 modes */
    {  320,  240, "4:3 (320x240)" },
    {  640,  480, "4:3 (640x480)" },
    {  800,  600, "4:3 (800x600)" },
    { 1024,  768, "4:3 (1024x768)" },
    { 1600, 1200, "4:3 (1600x1200)" },

    /* 16:9 modes */
    { 1280,  720, "16:9 (1280x720)" },
    { 1366,  768, "16:9 (1366x768)" },
    { 1920, 1080, "16:9 (1920x1080)" },
    { 2560, 1440, "16:9 (2560x1440)" },
    { 3840, 2160, "16:9 (3840x2160)" },

    /* 16:10 modes */
    {  320,  200, "16:10 (320x200)" },
    {  640,  400, "16:10 (640x400)" },
    { 1280,  800, "16:10 (1280x800)" },
    { 1440,  900, "16:10 (1440x900)" },
    { 1680, 1050, "16:10 (1680x1050)" },
    { 1920, 1200, "16:10 (1920x1200)" },
    { 2560, 1600, "16:10 (2560x1600)" },

    /* 21:9 modes */
    { 2560, 1080, "21:9 (2560x1080)" },
    { 3440, 1440, "21:9 (3440x1440)" },

    /* 5:4 mode */
    { 1280, 1024, "5:4 (1280x1024)" }
};

static void test_viewport_centering_and_margins(void)
{
    printf("=== Starting Viewport Centering & Margins Suite ===\n");
    size_t num_screens = sizeof(k_test_resolutions) / sizeof(k_test_resolutions[0]);
    size_t num_virts = sizeof(k_test_virtual_modes) / sizeof(k_test_virtual_modes[0]);

    int strict_equal_vert = 0;
    int parity_vert = 0; /* diff == 1 */
    int failure_vert = 0; /* diff > 1 */

    int strict_equal_horiz = 0;
    int parity_horiz = 0;
    int failure_horiz = 0;

    for (size_t s = 0; s < num_screens; s++) {
        int32_t sw = k_test_resolutions[s].w;
        int32_t sh = k_test_resolutions[s].h;

        for (size_t v = 0; v < num_virts; v++) {
            int32_t vw = k_test_virtual_modes[v].w;
            int32_t vh = k_test_virtual_modes[v].h;

            ds_viewport_t vp;
            bool ok = ds_compute_viewport(sw, sh, 0 /* safe_inset_top = 0 */, vw, vh, DS_ASPECT_PRESERVE, &vp);
            CHK(ok, "ds_compute_viewport failed for screen %s, virt %s",
                k_test_resolutions[s].desc, k_test_virtual_modes[v].aspect_name);

            int32_t top_margin = vp.dst_y;
            int32_t bottom_margin = sh - (vp.dst_y + vp.dst_h);
            int32_t diff_v = abs(top_margin - bottom_margin);

            if (diff_v == 0) {
                strict_equal_vert++;
            } else if (diff_v == 1) {
                parity_vert++;
            } else {
                failure_vert++;
                CHK(false, "Screen %s, virt %s: Vertical margin asymmetric! top=%d, bottom=%d (diff=%d)",
                    k_test_resolutions[s].desc, k_test_virtual_modes[v].aspect_name, top_margin, bottom_margin, diff_v);
            }

            int32_t left_margin = vp.dst_x;
            int32_t right_margin = sw - (vp.dst_x + vp.dst_w);
            int32_t diff_h = abs(left_margin - right_margin);

            if (diff_h == 0) {
                strict_equal_horiz++;
            } else if (diff_h == 1) {
                parity_horiz++;
            } else {
                failure_horiz++;
                CHK(false, "Screen %s, virt %s: Horizontal margin asymmetric! left=%d, right=%d (diff=%d)",
                    k_test_resolutions[s].desc, k_test_virtual_modes[v].aspect_name, left_margin, right_margin, diff_h);
            }

            /* Also check integer scaling */
            ds_viewport_t vp_int;
            ok = ds_compute_viewport(sw, sh, 0, vw, vh, DS_ASPECT_INTEGER, &vp_int);
            CHK(ok, "ds_compute_viewport integer failed for screen %s, virt %s",
                k_test_resolutions[s].desc, k_test_virtual_modes[v].aspect_name);
            int32_t int_top = vp_int.dst_y;
            int32_t int_bottom = sh - (vp_int.dst_y + vp_int.dst_h);
            int32_t int_diff_v = abs(int_top - int_bottom);
            CHK(int_diff_v <= 1, "Integer scale vertical diff %d > 1 for screen %s, virt %s",
                int_diff_v, k_test_resolutions[s].desc, k_test_virtual_modes[v].aspect_name);

            int32_t int_left = vp_int.dst_x;
            int32_t int_right = sw - (vp_int.dst_x + vp_int.dst_w);
            int32_t int_diff_h = abs(int_left - int_right);
            CHK(int_diff_h <= 1, "Integer scale horizontal diff %d > 1 for screen %s, virt %s",
                int_diff_h, k_test_resolutions[s].desc, k_test_virtual_modes[v].aspect_name);
        }
    }

    printf("Viewport Centering Results (PRESERVE):\n");
    printf("  Vertical: %d strictly equal (diff=0), %d 1-pixel integer parity (diff=1), %d failures (diff>1)\n",
           strict_equal_vert, parity_vert, failure_vert);
    printf("  Horizontal: %d strictly equal (diff=0), %d 1-pixel integer parity (diff=1), %d failures (diff>1)\n",
           strict_equal_horiz, parity_horiz, failure_horiz);
}

static void test_viewport_fuzzer(int iterations)
{
    printf("=== Starting Viewport Fuzzer (%d iterations) ===\n", iterations);
    for (int i = 0; i < iterations; i++) {
        int32_t sw = prng_range(1, 8192);
        int32_t sh = prng_range(1, 8192);
        int32_t vw = prng_range(1, 8192);
        int32_t vh = prng_range(1, 8192);
        ds_aspect_mode_t mode = (ds_aspect_mode_t)prng_range(0, 2);

        ds_viewport_t vp;
        bool ok = ds_compute_viewport(sw, sh, 0, vw, vh, mode, &vp);
        CHK(ok, "Viewport fuzzer compute failed");

        CHK(vp.dst_w <= sw, "dst_w (%d) > sw (%d)", vp.dst_w, sw);
        CHK(vp.dst_h <= sh, "dst_h (%d) > sh (%d)", vp.dst_h, sh);
        CHK(vp.dst_x >= 0, "dst_x < 0");
        CHK(vp.dst_y >= 0, "dst_y < 0");

        int32_t top = vp.dst_y;
        int32_t bottom = sh - (vp.dst_y + vp.dst_h);
        int32_t diff_v = abs(top - bottom);
        CHK(diff_v <= 1, "Viewport fuzzer vertical diff %d > 1: sw=%d, sh=%d, vw=%d, vh=%d, mode=%d",
            diff_v, sw, sh, vw, vh, (int)mode);

        int32_t left = vp.dst_x;
        int32_t right = sw - (vp.dst_x + vp.dst_w);
        int32_t diff_h = abs(left - right);
        CHK(diff_h <= 1, "Viewport fuzzer horizontal diff %d > 1: sw=%d, sh=%d, vw=%d, vh=%d, mode=%d",
            diff_h, sw, sh, vw, vh, (int)mode);
    }
    printf("Viewport Fuzzer: %d iterations completed successfully.\n", iterations);
}

/* --- 3. BOUNDARY & ROBUSTNESS TESTS --- */

static void test_boundaries_and_extreme_values(void)
{
    printf("=== Starting Boundary & Extreme Values Suite ===\n");
    ds_display_mode_t modes[64];
    ds_viewport_t vp;

    /* Mode table NULL pointer safety */
    CHK(ds_build_mode_table(1920, 1080, 60, NULL, 64) == 0, "NULL modes buffer did not return 0");
    CHK(ds_build_mode_table(1920, 1080, 60, modes, 0) == 0, "max_modes = 0 did not return 0");

    /* Mode table tiny buffer cap */
    size_t count_1 = ds_build_mode_table(1920, 1080, 60, modes, 1);
    CHK(count_1 == 1, "max_modes = 1 returned %zu", count_1);
    size_t count_10 = ds_build_mode_table(1920, 1080, 60, modes, 10);
    CHK(count_10 == 10, "max_modes = 10 returned %zu", count_10);

    /* Viewport NULL & invalid inputs */
    CHK(!ds_compute_viewport(1920, 1080, 0, 640, 480, DS_ASPECT_PRESERVE, NULL), "NULL out_vp did not return false");
    CHK(!ds_compute_viewport(0, 1080, 0, 640, 480, DS_ASPECT_PRESERVE, &vp), "screen_w=0 did not return false");
    CHK(!ds_compute_viewport(1920, 0, 0, 640, 480, DS_ASPECT_PRESERVE, &vp), "screen_h=0 did not return false");
    CHK(!ds_compute_viewport(1920, 1080, 0, 0, 480, DS_ASPECT_PRESERVE, &vp), "virt_w=0 did not return false");
    CHK(!ds_compute_viewport(1920, 1080, 0, 640, 0, DS_ASPECT_PRESERVE, &vp), "virt_h=0 did not return false");
    CHK(!ds_compute_viewport(-1920, 1080, 0, 640, 480, DS_ASPECT_PRESERVE, &vp), "negative screen_w did not return false");
    CHK(!ds_compute_viewport(1920, -1080, 0, 640, 480, DS_ASPECT_PRESERVE, &vp), "negative screen_h did not return false");

    /* Extreme safe_inset_top clamping */
    CHK(ds_clamp_safe_inset_top(INT32_MAX, 1000) == 249, "INT32_MAX safe_inset_top not clamped to < screen_h/4");
    CHK(ds_clamp_safe_inset_top(-1000, 1000) == 0, "Negative safe_inset_top not clamped to 0");
    CHK(ds_clamp_safe_inset_top(10, 4) == 0, "screen_h <= 4 didn't yield 0 inset");

    /* Cursor map extreme values & boundary clamping */
    int32_t out_vx = -1, out_vy = -1;
    CHK(ds_map_cursor_phys_to_virt(INT32_MIN, INT32_MIN, 100, 100, 1000, 800, 640, 480, &out_vx, &out_vy), "Cursor map min failed");
    CHK(out_vx == 0 && out_vy == 0, "Cursor map min out of range: %d, %d", out_vx, out_vy);

    CHK(ds_map_cursor_phys_to_virt(INT32_MAX, INT32_MAX, 100, 100, 1000, 800, 640, 480, &out_vx, &out_vy), "Cursor map max failed");
    CHK(out_vx == 639 && out_vy == 479, "Cursor map max out of range: %d, %d", out_vx, out_vy);

    printf("Boundary & Extreme Values Suite passed.\n");
}

int main(void)
{
    printf("=== RUNNING MILESTONE 1 CHALLENGER EMPIRICAL VERIFICATION HARNESS ===\n");
    test_mode_table_torture();
    test_mode_table_fuzzer(10000);
    test_viewport_centering_and_margins();
    test_viewport_fuzzer(10000);
    test_boundaries_and_extreme_values();

    printf("\nSUMMARY: %d checks run, %d failures\n", g_tests_run, g_tests_failed);
    if (g_tests_failed > 0) {
        printf("VERDICT: FAIL (%d failures)\n", g_tests_failed);
        return 1;
    }
    printf("VERDICT: PASS (All empirical checks passed successfully)\n");
    return 0;
}
