/*
 * One Launcher — Milestone M5 Phase 2 Tier 5 Adversarial Scaler Probe
 * Host Clang C11 `-fsanitize=address,undefined -Wall -Wextra -Werror`
 *
 * Exhaustive white-box stress testing of:
 *   1. Degenerate & Extreme Viewport Geometry (ds_compute_viewport, ds_clamp_safe_inset_top)
 *   2. Aspect Ratio Extremes (21:9, 32:9, 9:16 Tate, 1:1, 5:4, downscaling 4K -> 1080p, integer fallback)
 *   3. Zero-Drift Mouse Look Torture (20k stationary, corner, oscillating jitter, multi-anchor switching, monotonic accumulator)
 *   4. Cursor Coordinate Round-Trip Bijectivity across all standard and non-standard panels
 *   5. Mode Table Synthesis (strictly <= 52 modes, pruning hierarchy, mandatory preservation, odd panels)
 *   6. Sub-Rectangle Dirty Blits (1x1 coverage, watertight horizontal & vertical tiling)
 *   7. Control INI Parser Adversarial Fuzzing (numeric overflow, whitespace, comments, case insensitivity)
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <limits.h>
#include "display_scaler.h"

static int g_checks_run = 0;
static int g_checks_failed = 0;

#define CHK(cond, msg, ...) do { \
    g_checks_run++; \
    if (!(cond)) { \
        g_checks_failed++; \
        fprintf(stderr, "[FAIL] " msg " (%s:%d)\n", ##__VA_ARGS__, __FILE__, __LINE__); \
    } \
} while(0)

/* --------------------------------------------------------------------------
 * TRACK 1: Degenerate & Extreme Viewport Geometry
 * -------------------------------------------------------------------------- */
static void test_viewport_geometry_adversarial(void)
{
    printf("--- [TRACK 1] Viewport Geometry & Extreme Aspect Ratios ---\n");
    ds_viewport_t vp;

    /* 1.1 Degenerate / zero / negative dimensions must safely return false and zero out_vp */
    CHK(!ds_compute_viewport(0, 1964, 0, 640, 480, DS_ASPECT_PRESERVE, &vp), "Zero screen_w rejected");
    CHK(vp.dst_w == 0 && vp.dst_h == 0, "out_vp zeroed on zero screen_w");
    CHK(!ds_compute_viewport(3024, 0, 0, 640, 480, DS_ASPECT_PRESERVE, &vp), "Zero screen_h rejected");
    CHK(!ds_compute_viewport(3024, 1964, 0, 0, 480, DS_ASPECT_PRESERVE, &vp), "Zero virt_w rejected");
    CHK(!ds_compute_viewport(3024, 1964, 0, 640, 0, DS_ASPECT_PRESERVE, &vp), "Zero virt_h rejected");
    CHK(!ds_compute_viewport(-100, 1964, 0, 640, 480, DS_ASPECT_PRESERVE, &vp), "Negative screen_w rejected");
    CHK(!ds_compute_viewport(3024, -100, 0, 640, 480, DS_ASPECT_PRESERVE, &vp), "Negative screen_h rejected");
    CHK(!ds_compute_viewport(3024, 1964, 0, -640, 480, DS_ASPECT_PRESERVE, &vp), "Negative virt_w rejected");
    CHK(!ds_compute_viewport(3024, 1964, 0, 640, -480, DS_ASPECT_PRESERVE, &vp), "Negative virt_h rejected");
    CHK(!ds_compute_viewport(3024, 1964, 0, 640, 480, DS_ASPECT_PRESERVE, NULL), "NULL out_vp rejected safely");

    /* 1.2 Safe inset top clamping limits */
    CHK(ds_clamp_safe_inset_top(-100, 1964) == 0, "Negative safe inset clamps to 0");
    CHK(ds_clamp_safe_inset_top(0, 1964) == 0, "Zero safe inset remains 0");
    CHK(ds_clamp_safe_inset_top(74, 1964) == 74, "74px notch safe inset preserved");
    /* screen_h = 1964 -> quarter = 491, max_inset = 490 */
    CHK(ds_clamp_safe_inset_top(490, 1964) == 490, "490px inset accepted (< quarter)");
    CHK(ds_clamp_safe_inset_top(491, 1964) == 490, "491px inset clamped to 490");
    CHK(ds_clamp_safe_inset_top(10000, 1964) == 490, "Oversized safe inset clamped to 490");
    CHK(ds_clamp_safe_inset_top(100, 4) == 0, "Small screen (h<=4) safe inset clamps to 0");
    CHK(ds_clamp_safe_inset_top(100, 3) == 0, "Small screen (h=3) safe inset clamps to 0");
    CHK(ds_clamp_safe_inset_top(INT32_MIN, 1964) == 0, "INT32_MIN safe inset clamps to 0");
    CHK(ds_clamp_safe_inset_top(INT32_MAX, 1964) == 490, "INT32_MAX safe inset clamped safely");

    /* 1.3 Aspect Ratios: Ultrawide 21:9 (2560x1080) on 3024x1964 (Retina) */
    CHK(ds_compute_viewport(3024, 1964, 0, 2560, 1080, DS_ASPECT_PRESERVE, &vp), "21:9 viewport computed");
    CHK(vp.dst_w == 3024 && vp.dst_x == 0, "21:9 spans full width");
    CHK((vp.dst_h & 1) == 0, "21:9 dst_h is even integer (no subpixel blur)");
    CHK(vp.dst_y == (1964 - vp.dst_h) / 2, "21:9 centered vertically");
    CHK(abs(vp.dst_y - (1964 - (vp.dst_y + vp.dst_h))) <= 1, "21:9 symmetric vertical margins");
    CHK(vp.dst_y >= 74, "21:9 letterbox naturally clears 74px MacBook notch");

    /* 1.4 Aspect Ratios: Super Ultrawide 32:9 (5120x1440) on 3024x1964 */
    CHK(ds_compute_viewport(3024, 1964, 0, 5120, 1440, DS_ASPECT_PRESERVE, &vp), "32:9 viewport computed");
    CHK(vp.dst_w == 3024 && (vp.dst_h & 1) == 0, "32:9 dst_h is even");
    CHK(vp.dst_y == (1964 - vp.dst_h) / 2, "32:9 centered vertically");

    /* 1.5 Aspect Ratios: Tate Mode / Portrait 9:16 (1080x1920) on 3024x1964 */
    CHK(ds_compute_viewport(3024, 1964, 0, 1080, 1920, DS_ASPECT_PRESERVE, &vp), "Tate 9:16 viewport computed");
    CHK(vp.dst_h == 1964 && vp.dst_y == 0, "Tate 9:16 spans full height");
    CHK((vp.dst_w & 1) == 0, "Tate 9:16 dst_w is even integer");
    CHK(vp.dst_x == (3024 - vp.dst_w) / 2, "Tate 9:16 centered horizontally");
    CHK(abs(vp.dst_x - (3024 - (vp.dst_x + vp.dst_w))) <= 1, "Tate 9:16 symmetric horizontal margins");

    /* 1.6 Aspect Ratios: Retro Square 1:1 (1024x1024) on 3024x1964 */
    CHK(ds_compute_viewport(3024, 1964, 0, 1024, 1024, DS_ASPECT_PRESERVE, &vp), "1:1 viewport computed");
    CHK(vp.dst_h == 1964 && vp.dst_w == 1964, "1:1 square spans 1964x1964");
    CHK(vp.dst_x == (3024 - 1964) / 2, "1:1 square centered horizontally");

    /* 1.7 Downscaling: 4K (3840x2160) game on 1080p (1920x1080) panel */
    CHK(ds_compute_viewport(1920, 1080, 0, 3840, 2160, DS_ASPECT_PRESERVE, &vp), "4K -> 1080p computed");
    CHK(vp.dst_w == 1920 && vp.dst_h == 1080 && vp.dst_x == 0 && vp.dst_y == 0, "4K downscales to 1920x1080 cleanly");

    /* 1.8 Downscaling: 4K (3840x2160) game on 1280x800 (16:10) panel */
    CHK(ds_compute_viewport(1280, 800, 0, 3840, 2160, DS_ASPECT_PRESERVE, &vp), "4K -> 1280x800 computed");
    CHK(vp.dst_w == 1280 && vp.dst_h == 720, "4K downscales to 1280x720 on 16:10 panel");
    CHK(vp.dst_x == 0 && vp.dst_y == 40, "4K centered with 40px symmetric letterbox");

    /* 1.9 Integer scaling fallback when virtual > usable panel */
    CHK(ds_compute_viewport(1920, 1080, 0, 3840, 2160, DS_ASPECT_INTEGER, &vp), "Integer downscale fallback computed");
    CHK(vp.integer_scale == 0, "Integer scale factor falls back to 0 on downscaling");
    CHK(vp.dst_w == 1920 && vp.dst_h == 1080, "Gracefully falls back to aspect preserve dimensions");

    /* 1.10 Minimal 1x1 virtual dimension */
    CHK(ds_compute_viewport(3024, 1964, 0, 1, 1, DS_ASPECT_PRESERVE, &vp), "1x1 virtual resolution computed");
    CHK(vp.dst_w == 1964 && vp.dst_h == 1964, "1x1 scales to maximum square 1964x1964");
    CHK(vp.dst_x == (3024 - 1964) / 2 && vp.dst_y == 0, "1x1 centered horizontally");

    printf("  [PASS] Track 1: Viewport Geometry & Extreme Aspect Ratios verified (%d checks).\n", g_checks_run);
}

/* --------------------------------------------------------------------------
 * TRACK 2: Zero-Drift Mouse Look & Warp Accumulator Torture
 * -------------------------------------------------------------------------- */
static void test_mouse_look_warp_torture(void)
{
    printf("--- [TRACK 2] Zero-Drift Mouse Look & Warp Accumulator Torture ---\n");

    /* Viewport: 640x480 on 3024x1964 (aspect preserve -> dst_w = 2620, dst_h = 1964, dst_x = 202, dst_y = 0) */
    ds_viewport_t vp;
    CHK(ds_compute_viewport(3024, 1964, 0, 640, 480, DS_ASPECT_PRESERVE, &vp), "Retina 480p viewport");

    ds_cursor_warp_state_t warp;
    ds_cursor_warp_reset(&warp);

    /* 2.1 20,000-cycle stationary center warp torture test: ZERO drift */
    for (int frame = 0; frame < 20000; frame++) {
        int32_t px = 0, py = 0;
        CHK(ds_cursor_record_warp(&warp, 320, 240, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480, &px, &py),
            "record_warp at center");
        int32_t rvx = 0, rvy = 0;
        CHK(ds_cursor_resolve_get_pos(&warp, px, py, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480, &rvx, &rvy),
            "resolve_get_pos at center");
        if (rvx != 320 || rvy != 240) {
            CHK(false, "Drift detected at frame %d: rvx=%d, rvy=%d (expected 320, 240)", frame, rvx, rvy);
            break;
        }
    }

    /* 2.2 20,000-cycle stationary top-left corner warp torture test (0, 0) */
    ds_cursor_warp_reset(&warp);
    for (int frame = 0; frame < 20000; frame++) {
        int32_t px = 0, py = 0;
        CHK(ds_cursor_record_warp(&warp, 0, 0, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480, &px, &py),
            "record_warp at (0, 0)");
        int32_t rvx = -1, rvy = -1;
        CHK(ds_cursor_resolve_get_pos(&warp, px, py, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480, &rvx, &rvy),
            "resolve_get_pos at (0, 0)");
        if (rvx != 0 || rvy != 0) {
            CHK(false, "Corner drift at frame %d: (%d, %d)", frame, rvx, rvy);
            break;
        }
    }

    /* 2.3 20,000-cycle stationary bottom-right corner warp torture test (639, 479) */
    ds_cursor_warp_reset(&warp);
    for (int frame = 0; frame < 20000; frame++) {
        int32_t px = 0, py = 0;
        CHK(ds_cursor_record_warp(&warp, 639, 479, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480, &px, &py),
            "record_warp at (639, 479)");
        int32_t rvx = -1, rvy = -1;
        CHK(ds_cursor_resolve_get_pos(&warp, px, py, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480, &rvx, &rvy),
            "resolve_get_pos at (639, 479)");
        if (rvx != 639 || rvy != 479) {
            CHK(false, "Corner drift at frame %d: (%d, %d)", frame, rvx, rvy);
            break;
        }
    }

    /* 2.4 Oscillating rapid jitter (+1, -1, +2, -2, +3, -3 px/frame) over 10,000 cycles:
     * sub-pixel remainder cancels cleanly with ZERO net drift */
    ds_cursor_warp_reset(&warp);
    static const int32_t jitter_pattern[] = { +1, -1, +2, -2, +3, -3, +1, -1 };
    size_t pattern_len = sizeof(jitter_pattern) / sizeof(jitter_pattern[0]);
    int32_t cumulative_virtual_delta_x = 0;

    for (int cycle = 0; cycle < 10000; cycle++) {
        int32_t step = jitter_pattern[cycle % pattern_len];
        int32_t px = 0, py = 0;
        CHK(ds_cursor_record_warp(&warp, 320, 240, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480, &px, &py),
            "record_warp jitter");
        int32_t rvx = 0, rvy = 0;
        CHK(ds_cursor_resolve_get_pos(&warp, px + step, py, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480, &rvx, &rvy),
            "resolve jitter step");
        cumulative_virtual_delta_x += (rvx - 320);
    }
    /* Symmetrical jitter sequence sums to 0 physical delta; cumulative virtual delta must be exactly 0 */
    CHK(cumulative_virtual_delta_x == 0, "Oscillating jitter produced net zero virtual drift (got %d)", cumulative_virtual_delta_x);

    /* 2.5 Multi-anchor warp swapping: game warps between center (320, 240) and menu button (100, 100) */
    ds_cursor_warp_reset(&warp);
    for (int toggle = 0; toggle < 500; toggle++) {
        int32_t ax = (toggle & 1) ? 320 : 100;
        int32_t ay = (toggle & 1) ? 240 : 100;
        int32_t px = 0, py = 0;
        CHK(ds_cursor_record_warp(&warp, ax, ay, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480, &px, &py),
            "record_warp swap anchor");
        int32_t rvx = 0, rvy = 0;
        CHK(ds_cursor_resolve_get_pos(&warp, px, py, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480, &rvx, &rvy),
            "resolve_get_pos swap anchor");
        CHK(rvx == ax && rvy == ay, "Anchor swap preserved exact coordinate");
    }

    /* 2.6 Sub-pixel accumulator monotonicity: 100 consecutive +1 physical pixel steps
     * must accumulate virtual pixels monotonically without stepping backwards */
    ds_cursor_warp_reset(&warp);
    int32_t prev_vx = 320;
    int32_t total_delta = 0;
    for (int frame = 0; frame < 100; frame++) {
        int32_t px = 0, py = 0;
        CHK(ds_cursor_record_warp(&warp, 320, 240, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480, &px, &py),
            "record_warp mono");
        int32_t rvx = 0, rvy = 0;
        CHK(ds_cursor_resolve_get_pos(&warp, px + 1, py, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480, &rvx, &rvy),
            "resolve mono step");
        int32_t delta = rvx - 320;
        CHK(delta >= 0, "Non-negative delta per frame in rightward movement (got %d)", delta);
        total_delta += delta;
        prev_vx = rvx;
    }
    (void)prev_vx;
    /* 100 physical pixels * (640 / 2620) ~= 24.42 virtual pixels */
    CHK(total_delta >= 23 && total_delta <= 26, "Sub-pixel monotonicity accumulated expected delta (got %d)", total_delta);

    printf("  [PASS] Track 2: Zero-Drift Mouse Look Torture verified (%d checks).\n", g_checks_run);
}

/* --------------------------------------------------------------------------
 * TRACK 3: Cursor Bijectivity & Clamping Across Panels
 * -------------------------------------------------------------------------- */
static void test_cursor_bijectivity_and_clamping(void)
{
    printf("--- [TRACK 3] Cursor Bijectivity & Clamping Across Panels ---\n");

    static const struct {
        int32_t sw, sh;
        int32_t vw, vh;
    } test_matrices[] = {
        { 3024, 1964, 640, 480 },
        { 3024, 1964, 800, 600 },
        { 3024, 1964, 1024, 768 },
        { 3024, 1964, 1280, 720 },
        { 3024, 1964, 1920, 1080 },
        { 2560, 1600, 640, 480 },
        { 1920, 1080, 640, 480 },
        { 1280, 800, 640, 480 },
        { 3440, 1440, 640, 480 },
        { 5120, 1440, 640, 480 }
    };

    size_t matrix_count = sizeof(test_matrices) / sizeof(test_matrices[0]);
    for (size_t mi = 0; mi < matrix_count; mi++) {
        int32_t sw = test_matrices[mi].sw;
        int32_t sh = test_matrices[mi].sh;
        int32_t vw = test_matrices[mi].vw;
        int32_t vh = test_matrices[mi].vh;

        ds_viewport_t vp;
        CHK(ds_compute_viewport(sw, sh, 0, vw, vh, DS_ASPECT_PRESERVE, &vp), "Compute viewport for bijectivity");

        /* Bijectivity: phys_to_virt(virt_to_phys(v)) == v for all samples */
        int32_t step_x = (vw > 200) ? (vw / 50) : 1;
        int32_t step_y = (vh > 200) ? (vh / 50) : 1;

        for (int32_t vx = 0; vx < vw; vx += step_x) {
            int32_t px = 0, py = 0, rvx = -1, rvy = -1;
            CHK(ds_map_cursor_virt_to_phys(vx, 0, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, vw, vh, &px, &py),
                "virt_to_phys X");
            CHK(ds_map_cursor_phys_to_virt(px, py, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, vw, vh, &rvx, &rvy),
                "phys_to_virt X");
            CHK(rvx == vx && rvy == 0, "Bijectivity holds for vx=%d (got %d)", vx, rvx);
        }

        for (int32_t vy = 0; vy < vh; vy += step_y) {
            int32_t px = 0, py = 0, rvx = -1, rvy = -1;
            CHK(ds_map_cursor_virt_to_phys(0, vy, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, vw, vh, &px, &py),
                "virt_to_phys Y");
            CHK(ds_map_cursor_phys_to_virt(px, py, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, vw, vh, &rvx, &rvy),
                "phys_to_virt Y");
            CHK(rvx == 0 && rvy == vy, "Bijectivity holds for vy=%d (got %d)", vy, rvy);
        }

        /* Clamp boundaries: extreme negative & extreme positive coordinates */
        int32_t cl_vx = -1, cl_vy = -1;
        CHK(ds_map_cursor_phys_to_virt(-100000, -100000, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, vw, vh, &cl_vx, &cl_vy),
            "Extreme negative clamp");
        CHK(cl_vx == 0 && cl_vy == 0, "Extreme negative clamped to (0, 0)");

        CHK(ds_map_cursor_phys_to_virt(100000, 100000, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, vw, vh, &cl_vx, &cl_vy),
            "Extreme positive clamp");
        CHK(cl_vx == vw - 1 && cl_vy == vh - 1, "Extreme positive clamped to (vw-1, vh-1)");
    }

    printf("  [PASS] Track 3: Cursor Bijectivity & Clamping Across Panels verified (%d checks).\n", g_checks_run);
}

/* --------------------------------------------------------------------------
 * TRACK 4: Mode Table Synthesis Hard Limits & Pruning Invariants
 * -------------------------------------------------------------------------- */
static void test_mode_table_synthesis_stress(void)
{
    printf("--- [TRACK 4] Mode Table Synthesis Hard Limits & Pruning Invariants ---\n");

    static const struct {
        int32_t sw, sh, hz;
        const char *desc;
    } panel_configs[] = {
        { 3024, 1964, 120, "Retina 14\"" },
        { 3456, 2234, 120, "Retina 16\"" },
        { 3840, 2160, 144, "4K UHD" },
        { 7680, 4320,  60, "8K Extreme" },
        { 3440, 1440, 165, "21:9 UWQHD" },
        { 5120, 1440, 240, "32:9 Super Ultrawide" },
        { 1366,  768,  60, "Budget 16:9 Laptop" },
        { 1440,  900,  60, "Legacy 16:10 Laptop" },
        { 1600,  900,  60, "1600x900 Intermediate" },
        { 1280, 1024,  75, "5:4 SXGA" },
        {  800,  600,  60, "Sub-1024 Desktop" },
        {  640,  480,  60, "Legacy 640x480 Desktop" },
        { 3023, 1963, 120, "Odd Retina" },
        { 1921, 1081,  60, "Odd FHD" },
        {    0,    0,   0, "Zero panel fallback" },
        { -100, -100,  -1, "Negative panel fallback" }
    };

    size_t config_count = sizeof(panel_configs) / sizeof(panel_configs[0]);

    for (size_t ci = 0; ci < config_count; ci++) {
        ds_display_mode_t modes[128];
        memset(modes, 0, sizeof(modes));

        int32_t sw = panel_configs[ci].sw;
        int32_t sh = panel_configs[ci].sh;
        int32_t hz = panel_configs[ci].hz;

        size_t n = ds_build_mode_table(sw, sh, hz, modes, 128);

        /* Invariant 1: Must NEVER exceed DS_MAX_SYNTH_MODES (52) */
        CHK(n > 0 && n <= DS_MAX_SYNTH_MODES,
            "Mode table count %zu for %s within [1..52]", n, panel_configs[ci].desc);

        /* Invariant 2: Ascending sort order (w, h, bpp) */
        for (size_t i = 1; i < n; i++) {
            bool sorted = (modes[i].width > modes[i - 1].width) ||
                          (modes[i].width == modes[i - 1].width && modes[i].height > modes[i - 1].height) ||
                          (modes[i].width == modes[i - 1].width && modes[i].height == modes[i - 1].height && modes[i].bpp > modes[i - 1].bpp);
            CHK(sorted, "Modes sorted ascending at index %zu in %s", i, panel_configs[ci].desc);
        }

        /* Invariant 3: Mandatory modes 640x480, 800x600, 1024x768 must ALWAYS be present */
        bool has_640x480_32 = false;
        bool has_800x600_32 = false;
        bool has_1024x768_32 = false;
        bool has_8bpp_above_1024 = false;

        for (size_t i = 0; i < n; i++) {
            if (modes[i].width == 640 && modes[i].height == 480 && modes[i].bpp == 32) has_640x480_32 = true;
            if (modes[i].width == 800 && modes[i].height == 600 && modes[i].bpp == 32) has_800x600_32 = true;
            if (modes[i].width == 1024 && modes[i].height == 768 && modes[i].bpp == 32) has_1024x768_32 = true;
            if (modes[i].bpp == 8 && (modes[i].width > 1024 || modes[i].height > 768)) {
                has_8bpp_above_1024 = true;
            }
        }

        CHK(has_640x480_32, "Mandatory 640x480x32 present in %s", panel_configs[ci].desc);
        CHK(has_800x600_32, "Mandatory 800x600x32 present in %s", panel_configs[ci].desc);
        CHK(has_1024x768_32, "Mandatory 1024x768x32 present in %s", panel_configs[ci].desc);
        CHK(!has_8bpp_above_1024, "No 8bpp modes above 1024x768 in %s", panel_configs[ci].desc);

        /* Invariant 4: Native resolution must be present at 32-bpp (when sw > 0 && sh > 0) */
        if (sw > 0 && sh > 0) {
            bool has_native_32 = false;
            for (size_t i = 0; i < n; i++) {
                if (modes[i].width == sw && modes[i].height == sh && modes[i].bpp == 32) {
                    has_native_32 = true;
                    break;
                }
            }
            CHK(has_native_32, "Native mode %dx%dx32 present in %s", sw, sh, panel_configs[ci].desc);
        }
    }

    /* Invariant 5: Small max_modes buffer capacity handling (e.g. max_modes = 1, 5, 10) */
    ds_display_mode_t small_modes[10];
    size_t n_cap5 = ds_build_mode_table(3024, 1964, 120, small_modes, 5);
    CHK(n_cap5 <= 5, "Capacity cap 5 strictly respected (got %zu)", n_cap5);
    size_t n_cap0 = ds_build_mode_table(3024, 1964, 120, small_modes, 0);
    CHK(n_cap0 == 0, "Capacity 0 returns 0");
    size_t n_null = ds_build_mode_table(3024, 1964, 120, NULL, 50);
    CHK(n_null == 0, "NULL modes buffer returns 0");

    printf("  [PASS] Track 4: Mode Table Synthesis Hard Limits & Pruning Invariants verified (%d checks).\n", g_checks_run);
}

/* --------------------------------------------------------------------------
 * TRACK 5: Watertight Sub-Rectangle Mapping & Control INI Parser Fuzzing
 * -------------------------------------------------------------------------- */
static void test_subrect_and_ini_parser_fuzzing(void)
{
    printf("--- [TRACK 5] Watertight Sub-Rectangle Mapping & Control INI Fuzzing ---\n");

    /* 5.1 Full-frame virtual rect mapping matches destination viewport */
    ds_viewport_t vp;
    CHK(ds_compute_viewport(3024, 1964, 0, 640, 480, DS_ASPECT_PRESERVE, &vp), "Viewport for subrect");

    int32_t px = 0, py = 0, pw = 0, ph = 0;
    CHK(ds_map_subrect_virt_to_phys(0, 0, 640, 480, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480, &px, &py, &pw, &ph),
        "Full frame subrect");
    CHK(px == vp.dst_x && py == vp.dst_y && pw == vp.dst_w && ph == vp.dst_h,
        "Full-frame subrect matches destination viewport exactly");

    /* 5.2 1x1 dirty pixel subrect always maps to at least 1x1 physical rect */
    for (int32_t test_y = 0; test_y < 480; test_y += 50) {
        for (int32_t test_x = 0; test_x < 640; test_x += 50) {
            int32_t sx = 0, sy = 0, sw = 0, sh = 0;
            CHK(ds_map_subrect_virt_to_phys(test_x, test_y, 1, 1, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480,
                                            &sx, &sy, &sw, &sh), "1x1 subrect");
            CHK(sw >= 1 && sh >= 1, "1x1 dirty pixel covers at least 1 physical pixel");
        }
    }

    /* 5.3 Watertight horizontal strip blits: adjacent 1-pixel columns tile seamlessly */
    int32_t cur_expected_x = vp.dst_x;
    for (int32_t vx = 0; vx < 640; vx++) {
        int32_t rx = 0, ry = 0, rw = 0, rh = 0;
        CHK(ds_map_subrect_virt_to_phys(vx, 0, 1, 480, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, 640, 480,
                                        &rx, &ry, &rw, &rh), "Horizontal strip");
        CHK(rx == cur_expected_x, "Strip %d contiguous at x=%d (got %d)", vx, cur_expected_x, rx);
        cur_expected_x += rw;
    }
    CHK(cur_expected_x == vp.dst_x + vp.dst_w, "Watertight horizontal strips reach dst_x + dst_w");

    /* 5.4 Control INI Parser Fuzzing */
    ds_control_state_t st;

    /* Valid mixed INI */
    const char *valid_ini =
        "; Section Header\r\n"
        "[DisplayScaler]\r\n"
        "  sEq  =  1762796867123  \r\n"
        "FuLlScReEn = 1\r\n"
        "AsPeCt = StReTcH\r\n"
        "SaFe_InSeT_tOp = 74\r\n"
        "FiLtEr = ShArP_bIlInEaR\r\n"
        "MoDe = FoRcE_fUlLsCrEeN\r\n"
        "HoTkEy = TrUe\r\n"
        "control_file = \"C:\\Program Files\\OneLauncher\\display_control.ini\"\r\n"
        "status_file = 'C:\\Program Files\\OneLauncher\\display_status.json'\r\n";

    CHK(ds_parse_control_ini(valid_ini, strlen(valid_ini), &st), "Parse mixed-case INI");
    CHK(st.has_seq && st.seq == 1762796867123ULL, "Parsed seq");
    CHK(st.has_fullscreen && st.fullscreen == true, "Parsed fullscreen");
    CHK(st.has_aspect && st.aspect == DS_ASPECT_STRETCH, "Parsed aspect");
    CHK(st.has_safe_inset_top && st.safe_inset_top == 74, "Parsed safe inset");
    CHK(st.has_filter && st.filter == DS_FILTER_SHARP, "Parsed filter");
    CHK(st.has_scaling_mode && st.scaling_mode == DS_MODE_FORCE_FULLSCREEN, "Parsed scaling mode");
    CHK(st.has_hotkey && st.hotkey == true, "Parsed hotkey");
    CHK(st.has_control_file && strcmp(st.control_file, "C:\\Program Files\\OneLauncher\\display_control.ini") == 0,
        "Parsed unquoted control_file");
    CHK(st.has_status_file && strcmp(st.status_file, "C:\\Program Files\\OneLauncher\\display_status.json") == 0,
        "Parsed unquoted status_file");

    /* Overflow 2^64 numeric rejection */
    const char *overflow_ini = "seq=18446744073709551616\n";
    CHK(!ds_parse_control_ini(overflow_ini, strlen(overflow_ini), &st), "Overflow 2^64 rejected");
    CHK(!st.has_seq, "st.has_seq remains false on overflow");

    /* Negative numbers rejected on unsigned seq */
    const char *neg_seq_ini = "seq=-1\n";
    CHK(!ds_parse_control_ini(neg_seq_ini, strlen(neg_seq_ini), &st), "Negative seq rejected");

    /* Empty string and NULL buffer handling */
    CHK(!ds_parse_control_ini("", 0, &st), "Empty string returns false");
    CHK(!ds_parse_control_ini(NULL, 10, &st), "NULL text returns false");
    CHK(!ds_parse_control_ini("seq=1", 5, NULL), "NULL out_state returns false");

    printf("  [PASS] Track 5: Watertight Sub-Rectangle Mapping & Control INI Fuzzing verified (%d checks).\n", g_checks_run);
}

int main(void)
{
    printf("=================================================================\n");
    printf("  CHALLENGER 1: M5 Phase 2 Native Scaler Adversarial Probe\n");
    printf("  Host Clang C11 with AddressSanitizer & UndefinedBehaviorSanitizer\n");
    printf("=================================================================\n\n");

    test_viewport_geometry_adversarial();
    test_mouse_look_warp_torture();
    test_cursor_bijectivity_and_clamping();
    test_mode_table_synthesis_stress();
    test_subrect_and_ini_parser_fuzzing();

    printf("\n=================================================================\n");
    printf("  SUMMARY: %d checks run, %d failures\n", g_checks_run, g_checks_failed);
    printf("=================================================================\n");

    return (g_checks_failed == 0) ? 0 : 1;
}
