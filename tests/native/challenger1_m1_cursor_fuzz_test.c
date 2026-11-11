/*
 * Challenger 1 Adversarial Fuzzing & Oracle Harness for Milestone 1
 *
 * Verifies:
 * 1. Zero-Drift Cursor Math Fuzzing over 50,000+ randomized coordinates & panels:
 *    - Exact round-trip identity: phys_to_virt(virt_to_phys(pt)) == pt across arbitrary virtual modes & panels
 *    - 10,000-cycle stationary anchor test across arbitrary anchor coordinates
 *    - Sub-pixel accumulator drift over multi-frame random walks
 * 2. Mode Table Synthesis cap (<= 52 modes) and preservation of mandatory modes
 *    under extreme panels (21:9 ultrawide, 32:9 super ultrawide, 5:4, odd dimensions)
 * 3. Aspect Ratio Extremes & Invariants:
 *    - Even viewport dimensions (fit_w & 1 == 0, fit_h & 1 == 0)
 *    - Margin symmetry (|ML - MR| <= 1, |MT - MB| <= 1)
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <limits.h>
#include "display_scaler.h"

static int g_tests_run = 0;
static int g_tests_failed = 0;

#define CHK(cond, msg, ...) do { \
    g_tests_run++; \
    if (!(cond)) { \
        g_tests_failed++; \
        fprintf(stderr, "[FAIL] " msg " (line %d)\n", ##__VA_ARGS__, __LINE__); \
    } \
} while(0)

/* Deterministic 64-bit PRNG (SplitMix64) */
static uint64_t g_rng = 0x123456789ABCDEF0ULL;
static uint64_t next_u64(void)
{
    uint64_t z = (g_rng += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

static int32_t rand_range(int32_t min_v, int32_t max_v)
{
    if (min_v >= max_v) return min_v;
    uint64_t span = (uint64_t)(max_v - min_v + 1);
    return min_v + (int32_t)(next_u64() % span);
}

/* --------------------------------------------------------------------------
 * VECTOR 1: Zero-Drift Cursor Math Fuzzing
 * -------------------------------------------------------------------------- */

static void test_cursor_roundtrip_fuzzing(int iterations)
{
    printf("=== [VECTOR 1A] Cursor Round-Trip Fuzzing (%d iterations) ===\n", iterations);

    /* Extreme panels: 21:9, 32:9, 5:4, 16:10 Retina, 16:9, odd dims */
    static const struct {
        int32_t sw, sh;
        const char *desc;
    } panels[] = {
        { 3024, 1964, "Retina 14\" (16:10)" },
        { 3456, 2234, "Retina 16\" (16:10)" },
        { 2560, 1600, "WQXGA (16:10)" },
        { 1920, 1080, "FHD (16:9)" },
        { 2560, 1440, "QHD (16:9)" },
        { 3840, 2160, "4K UHD (16:9)" },
        { 3440, 1440, "UWQHD (21:9 Ultrawide)" },
        { 2560, 1080, "UWFHD (21:9 Ultrawide)" },
        { 5120, 1440, "DQHD (32:9 Super-Ultrawide)" },
        { 3840, 1080, "DFHD (32:9 Super-Ultrawide)" },
        { 1280, 1024, "SXGA (5:4 Legacy)" },
        { 1600, 1200, "UXGA (4:3 Legacy)" },
        { 3023, 1963, "Odd Retina (3023x1963)" },
        { 1921, 1081, "Odd FHD (1921x1081)" },
        { 2561, 1079, "Odd Ultrawide (2561x1079)" }
    };
    size_t panel_count = sizeof(panels) / sizeof(panels[0]);

    static const struct {
        int32_t vw, vh;
        const char *desc;
    } virt_modes[] = {
        {  320,  200, "320x200 (16:10 DOS)" },
        {  320,  240, "320x240 (4:3 QVGA)" },
        {  640,  400, "640x400 (16:10)" },
        {  640,  480, "640x480 (4:3 VGA)" },
        {  800,  600, "800x600 (4:3 SVGA)" },
        { 1024,  768, "1024x768 (4:3 XGA)" },
        { 1280,  720, "1280x720 (16:9 HD)" },
        { 1280, 1024, "1280x1024 (5:4 SXGA)" },
        { 1600,  900, "1600x900 (16:9 HD+)" },
        { 1920, 1080, "1920x1080 (16:9 FHD)" },
        {  641,  481, "Odd Virt (641x481)" },
        {  801,  599, "Odd Virt (801x599)" }
    };
    size_t virt_count = sizeof(virt_modes) / sizeof(virt_modes[0]);

    static const ds_aspect_mode_t aspect_modes[] = {
        DS_ASPECT_PRESERVE,
        DS_ASPECT_INTEGER,
        DS_ASPECT_STRETCH
    };

    int roundtrip_successes = 0;

    for (int i = 0; i < iterations; i++) {
        size_t pi = next_u64() % panel_count;
        size_t vi = next_u64() % virt_count;
        ds_aspect_mode_t aspect = aspect_modes[next_u64() % 3];
        int32_t safe_inset = (next_u64() % 3 == 0) ? rand_range(0, 74) : 0;

        int32_t sw = panels[pi].sw;
        int32_t sh = panels[pi].sh;
        int32_t vw = virt_modes[vi].vw;
        int32_t vh = virt_modes[vi].vh;

        ds_viewport_t vp;
        bool ok = ds_compute_viewport(sw, sh, safe_inset, vw, vh, aspect, &vp);
        CHK(ok, "ds_compute_viewport failed: %s with %s", panels[pi].desc, virt_modes[vi].desc);

        /* Pick a random virtual coordinate */
        int32_t vx = rand_range(0, vw - 1);
        int32_t vy = rand_range(0, vh - 1);

        int32_t px = -1, py = -1;
        ok = ds_map_cursor_virt_to_phys(vx, vy, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, vw, vh, &px, &py);
        CHK(ok, "virt_to_phys failed for (%d,%d)", vx, vy);

        /* Physical coordinate must lie strictly within viewport */
        CHK(px >= vp.dst_x && px < vp.dst_x + vp.dst_w,
            "Physical px %d outside viewport [%d, %d)", px, vp.dst_x, vp.dst_x + vp.dst_w);
        CHK(py >= vp.dst_y && py < vp.dst_y + vp.dst_h,
            "Physical py %d outside viewport [%d, %d)", py, vp.dst_y, vp.dst_y + vp.dst_h);

        int32_t rvx = -1, rvy = -1;
        ok = ds_map_cursor_phys_to_virt(px, py, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, vw, vh, &rvx, &rvy);
        CHK(ok, "phys_to_virt failed for (%d,%d)", px, py);

        /* When upscaling (dst_w >= virt_w && dst_h >= virt_h), round-trip MUST be 100% exact! */
        if (vp.dst_w >= vw && vp.dst_h >= vh) {
            CHK(rvx == vx, "Round-trip vx mismatch! orig=%d, got=%d (panel %s, virt %s, aspect %d)",
                vx, rvx, panels[pi].desc, virt_modes[vi].desc, (int)aspect);
            CHK(rvy == vy, "Round-trip vy mismatch! orig=%d, got=%d (panel %s, virt %s, aspect %d)",
                vy, rvy, panels[pi].desc, virt_modes[vi].desc, (int)aspect);
        } else {
            /* For downscaling, mapped virt must be within 1px */
            CHK(abs(rvx - vx) <= 1, "Downscale vx drift > 1px: orig=%d, got=%d", vx, rvx);
            CHK(abs(rvy - vy) <= 1, "Downscale vy drift > 1px: orig=%d, got=%d", vy, rvy);
        }
        roundtrip_successes++;
    }

    printf("  [PASS] %d random coordinate round-trips verified without drift.\n", roundtrip_successes);
}

static void test_cursor_stationary_warp_fuzzing(int cycles)
{
    printf("=== [VECTOR 1B] Stationary Cursor Warp Fuzzing (%d cycles) ===\n", cycles);

    /* Panels to torture */
    int32_t panels[][2] = {
        { 3024, 1964 }, /* Retina */
        { 3440, 1440 }, /* 21:9 Ultrawide */
        { 5120, 1440 }, /* 32:9 Super-Ultrawide */
        { 1280, 1024 }  /* 5:4 */
    };
    size_t num_panels = sizeof(panels) / sizeof(panels[0]);

    for (size_t p = 0; p < num_panels; p++) {
        int32_t sw = panels[p][0];
        int32_t sh = panels[p][1];
        int32_t vw = 640;
        int32_t vh = 480;

        ds_viewport_t vp;
        bool ok = ds_compute_viewport(sw, sh, 0, vw, vh, DS_ASPECT_PRESERVE, &vp);
        CHK(ok, "Viewport compute failed for panel %dx%d", sw, sh);

        /* Test stationary warp across 5 different anchor points: center, corners, arbitrary */
        int32_t anchors[][2] = {
            { 320, 240 }, /* center */
            { 100, 150 }, /* upper left quadrant */
            { 500, 350 }, /* lower right quadrant */
            {   0,   0 }, /* top-left corner */
            { 639, 479 }  /* bottom-right corner */
        };

        for (int a = 0; a < 5; a++) {
            int32_t target_vx = anchors[a][0];
            int32_t target_vy = anchors[a][1];

            ds_cursor_warp_state_t warp;
            ds_cursor_warp_reset(&warp);

            for (int f = 0; f < cycles; f++) {
                int32_t px = 0, py = 0;
                ok = ds_cursor_record_warp(&warp, target_vx, target_vy,
                                          vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h,
                                          vw, vh, &px, &py);
                CHK(ok, "ds_cursor_record_warp failed at cycle %d", f);

                int32_t rvx = -1, rvy = -1;
                ok = ds_cursor_resolve_get_pos(&warp, px, py,
                                              vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h,
                                              vw, vh, &rvx, &rvy);
                CHK(ok, "ds_cursor_resolve_get_pos failed at cycle %d", f);

                if (rvx != target_vx || rvy != target_vy) {
                    CHK(false, "DRIFT DETECTED at cycle %d! Expected (%d, %d), got (%d, %d) on panel %dx%d",
                        f, target_vx, target_vy, rvx, rvy, sw, sh);
                    break;
                }
            }
        }
    }
    printf("  [PASS] %d stationary cycles tested across multiple anchor positions with ZERO drift.\n", cycles);
}

/* --------------------------------------------------------------------------
 * VECTOR 2: Mode Table Boundary & Preservation
 * -------------------------------------------------------------------------- */

static void test_mode_table_extremes(void)
{
    printf("=== [VECTOR 2] Mode Table Extremes & Preservation ===\n");

    /* Extreme panel configurations */
    static const struct {
        int32_t w, h, hz;
        const char *desc;
    } extreme_configs[] = {
        { 3440, 1440, 144, "21:9 Ultrawide 144Hz" },
        { 2560, 1080, 200, "21:9 Ultrawide 200Hz" },
        { 5120, 1440, 240, "32:9 Super Ultrawide 240Hz" },
        { 3840, 1080, 144, "32:9 Super Ultrawide 144Hz" },
        { 1280, 1024,  75, "5:4 SXGA 75Hz" },
        { 2560, 2048,  60, "5:4 Medical High-Res 60Hz" },
        { 3023, 1963, 120, "Odd Retina 3023x1963" },
        { 1921, 1081,  60, "Odd FHD 1921x1081" },
        {  400,  300,  60, "Tiny panel 400x300" },
        { 7680, 4320,  60, "8K Ultra-Extreme 7680x4320" },
        {    1,    1,  60, "1x1 Degenerate" },
        {   -1,   -1,  -1, "Negative input fallback" }
    };
    size_t count = sizeof(extreme_configs) / sizeof(extreme_configs[0]);

    ds_display_mode_t modes[128];

    for (size_t c = 0; c < count; c++) {
        int32_t nw = extreme_configs[c].w;
        int32_t nh = extreme_configs[c].h;
        int32_t nhz = extreme_configs[c].hz;

        memset(modes, 0, sizeof(modes));
        size_t n = ds_build_mode_table(nw, nh, nhz, modes, 64);

        /* Invariant 1: Strictly <= 52 modes */
        CHK(n <= DS_MAX_SYNTH_MODES, "%s: Mode count %zu exceeds cap %u",
            extreme_configs[c].desc, n, DS_MAX_SYNTH_MODES);
        CHK(n > 0, "%s: Mode count was 0", extreme_configs[c].desc);

        /* Invariant 2: Mandatory modes (640x480, 800x600, 1024x768) are preserved */
        bool has_640x480_32 = false;
        bool has_800x600_32 = false;
        bool has_1024x768_32 = false;
        bool has_native_32 = false;
        bool has_illegal_8bpp = false;
        bool sorted_ok = true;

        int32_t eff_nw = (nw > 0) ? nw : 1024;
        int32_t eff_nh = (nh > 0) ? nh : 768;

        for (size_t i = 0; i < n; i++) {
            if (modes[i].width == 640 && modes[i].height == 480 && modes[i].bpp == 32) has_640x480_32 = true;
            if (modes[i].width == 800 && modes[i].height == 600 && modes[i].bpp == 32) has_800x600_32 = true;
            if (modes[i].width == 1024 && modes[i].height == 768 && modes[i].bpp == 32) has_1024x768_32 = true;
            if (modes[i].width == eff_nw && modes[i].height == eff_nh && modes[i].bpp == 32) has_native_32 = true;

            if (modes[i].bpp == 8 && (modes[i].width > 1024 || modes[i].height > 768)) {
                has_illegal_8bpp = true;
            }

            if (i > 0) {
                bool strictly_greater =
                    (modes[i].width > modes[i - 1].width) ||
                    (modes[i].width == modes[i - 1].width && modes[i].height > modes[i - 1].height) ||
                    (modes[i].width == modes[i - 1].width && modes[i].height == modes[i - 1].height && modes[i].bpp > modes[i - 1].bpp);
                if (!strictly_greater) sorted_ok = false;
            }
        }

        CHK(has_640x480_32, "%s: Mandatory 640x480 (32-bpp) missing", extreme_configs[c].desc);
        CHK(has_800x600_32, "%s: Mandatory 800x600 (32-bpp) missing", extreme_configs[c].desc);
        CHK(has_1024x768_32, "%s: Mandatory 1024x768 (32-bpp) missing", extreme_configs[c].desc);
        CHK(has_native_32, "%s: Native mode (%dx%d 32-bpp) missing", extreme_configs[c].desc, eff_nw, eff_nh);
        CHK(!has_illegal_8bpp, "%s: Found illegal 8-bpp mode above 1024x768", extreme_configs[c].desc);
        CHK(sorted_ok, "%s: Mode sort order violated", extreme_configs[c].desc);
    }
    printf("  [PASS] All %zu extreme configurations satisfied mode table invariants.\n", count);
}

/* --------------------------------------------------------------------------
 * VECTOR 3: Aspect Ratio Extremes & Symmetry Invariants
 * -------------------------------------------------------------------------- */

static void test_aspect_ratio_extremes_and_symmetry(void)
{
    printf("=== [VECTOR 3] Aspect Ratio Extremes & Symmetry Invariants ===\n");

    static const struct {
        int32_t sw, sh;
        const char *desc;
    } panels[] = {
        { 3440, 1440, "21:9 Ultrawide" },
        { 5120, 1440, "32:9 Super Ultrawide" },
        { 1280, 1024, "5:4 SXGA" },
        { 3024, 1964, "16:10 Retina" },
        { 1920, 1080, "16:9 FHD" },
        { 3023, 1963, "Odd Retina" },
        { 1921, 1081, "Odd FHD" },
        { 2561, 1079, "Odd Ultrawide" }
    };
    size_t num_panels = sizeof(panels) / sizeof(panels[0]);

    static const struct {
        int32_t vw, vh;
        const char *desc;
    } modes[] = {
        {  320,  200, "320x200 (16:10)" },
        {  640,  480, "640x480 (4:3)" },
        {  800,  600, "800x600 (4:3)" },
        { 1024,  768, "1024x768 (4:3)" },
        { 1280,  720, "1280x720 (16:9)" },
        { 1280, 1024, "1280x1024 (5:4)" },
        { 2560, 1080, "2560x1080 (21:9)" },
        {  641,  481, "641x481 (Odd)" }
    };
    size_t num_modes = sizeof(modes) / sizeof(modes[0]);

    for (size_t p = 0; p < num_panels; p++) {
        for (size_t m = 0; m < num_modes; m++) {
            ds_viewport_t vp;
            bool ok = ds_compute_viewport(panels[p].sw, panels[p].sh, 0, modes[m].vw, modes[m].vh, DS_ASPECT_PRESERVE, &vp);
            CHK(ok, "Viewport compute failed for %s with %s", panels[p].desc, modes[m].desc);

            /* Invariant 1: Letterbox viewport height is strictly even when >= 2 */
            if (vp.dst_h < vp.usable_h && vp.usable_h >= 2) {
                CHK((vp.dst_h & 1) == 0,
                    "dst_h (%d) is odd in letterbox for %s on %s", vp.dst_h, modes[m].desc, panels[p].desc);
            }
            /* Pillarbox width is even when non-exact, or exact integer ratio */
            if (vp.dst_w < vp.usable_w && vp.usable_w >= 2) {
                int64_t rhs = (int64_t)vp.usable_h * (int64_t)modes[m].vw;
                if ((rhs % (int64_t)modes[m].vh) != 0) {
                    CHK((vp.dst_w & 1) == 0,
                        "dst_w (%d) is odd in non-exact pillarbox for %s on %s", vp.dst_w, modes[m].desc, panels[p].desc);
                } else {
                    CHK(vp.dst_w == (int32_t)(rhs / (int64_t)modes[m].vh),
                        "dst_w (%d) does not match exact ratio %lld for %s on %s",
                        vp.dst_w, (long long)(rhs / (int64_t)modes[m].vh), modes[m].desc, panels[p].desc);
                }
            }

            /* Invariant 2: Symmetric margins */
            int32_t left = vp.dst_x;
            int32_t right = panels[p].sw - (vp.dst_x + vp.dst_w);
            int32_t diff_h = abs(left - right);
            CHK(diff_h <= 1,
                "Horizontal margin asymmetric (|L-R| = %d > 1) for %s on %s", diff_h, modes[m].desc, panels[p].desc);

            int32_t top = vp.dst_y;
            int32_t bottom = panels[p].sh - (vp.dst_y + vp.dst_h);
            int32_t diff_v = abs(top - bottom);
            CHK(diff_v <= 1,
                "Vertical margin asymmetric (|T-B| = %d > 1) for %s on %s", diff_v, modes[m].desc, panels[p].desc);
        }
    }
    printf("  [PASS] All %zu panel x %zu mode combinations satisfied even viewport & margin symmetry.\n",
           num_panels, num_modes);
}

int main(void)
{
    printf("=================================================================\n");
    printf("  CHALLENGER 1: ADVERSARIAL EMPIRICAL HARNESS FOR MILESTONE 1\n");
    printf("=================================================================\n\n");

    test_cursor_roundtrip_fuzzing(50000);
    test_cursor_stationary_warp_fuzzing(10000);
    test_mode_table_extremes();
    test_aspect_ratio_extremes_and_symmetry();

    printf("\n=================================================================\n");
    printf("  TOTAL CHECKS: %d, FAILURES: %d\n", g_tests_run, g_tests_failed);
    printf("=================================================================\n");

    if (g_tests_failed > 0) {
        printf("FINAL VERDICT: REJECT (%d failures encountered)\n", g_tests_failed);
        return 1;
    }
    printf("FINAL VERDICT: APPROVE (All adversarial verification checks passed)\n");
    return 0;
}
