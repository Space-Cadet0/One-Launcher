/*
 * One Launcher — Layer 1 Host Clang C11 ASan + UBSan Sanitizer Harness
 * for `electron/helpers/display_scaler/display_scaler_math.c`
 *
 * Exercises under `-std=c11 -O1 -g -fsanitize=address,undefined -Wall -Wextra -Werror`:
 *   1. Notch-safe `ds_compute_viewport` (`preserve_aspect`, `integer`, `stretch`, fallback & clamping)
 *   2. `ds_build_mode_table` (`<= DS_MAX_SYNTH_MODES` modes invariant, ascending sort, deduplication, mandatory modes)
 *   3. `ds_map_cursor_phys_to_virt` & `ds_map_cursor_virt_to_phys` (pillarbox/notch clamping & boundaries)
 *   4. 10,000-frame zero-drift 3D mouse-look `SetCursorPos`/`GetCursorPos` warp torture test + sub-pixel deltas
 *   5. `ds_map_subrect_virt_to_phys` (GDI dirty-rect blits & `ClipCursor`)
 *   6. `ds_parse_control_ini` (valid, comments, overflow `seq`, partial updates, non-NUL bounded buffers)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "display_scaler.h"

#define ASSERT_TRUE(cond)                                                                        \
    do {                                                                                         \
        if (!(cond)) {                                                                           \
            fprintf(stderr, "[DS-ASAN-FAIL] %s:%d: assertion failed: %s\n", __FILE__, __LINE__,  \
                    #cond);                                                                      \
            abort();                                                                             \
        }                                                                                        \
    } while (0)

static void test_viewport_and_notch_geometry(void)
{
    ds_viewport_t vp;

    /* 1. Pure edge-to-edge full panel span: physical Retina (3024x1964, safe_inset_top = 0), 640x480 (4:3) */
    ASSERT_TRUE(ds_compute_viewport(3024, 1964, 0, 640, 480, DS_ASPECT_PRESERVE, &vp));
    ASSERT_TRUE(vp.usable_x == 0 && vp.usable_y == 0);
    ASSERT_TRUE(vp.usable_w == 3024 && vp.usable_h == 1964);
    /* 4:3 spans full physical height (1964px); 1964 * 4 / 3 = 2618.67 -> 2618 / 2619 -> 2620, centered at (3024 - dst_w) / 2 */
    ASSERT_TRUE(vp.dst_y == 0 && vp.dst_h == 1964);
    ASSERT_TRUE(vp.dst_x == (3024 - vp.dst_w) / 2);
    /* Pure symmetric margin invariance: top margin == bottom margin == 0 */
    ASSERT_TRUE(vp.dst_y == (1964 - (vp.dst_y + vp.dst_h)));

    /* 2. Pure symmetric letterbox: 16:9 game (1920x1080) on 3024x1964 (safe_inset_top = 0) */
    ASSERT_TRUE(ds_compute_viewport(3024, 1964, 0, 1920, 1080, DS_ASPECT_PRESERVE, &vp));
    ASSERT_TRUE(vp.dst_x == 0 && vp.dst_w == 3024);
    ASSERT_TRUE(vp.dst_y == (1964 - vp.dst_h) / 2);
    /* Pure symmetric centering: top margin == bottom margin (within integer division parity) */
    ASSERT_TRUE(abs(vp.dst_y - (1964 - (vp.dst_y + vp.dst_h))) <= 1);
    /* Symmetric letterbox bar height ~132px naturally clears MacBook Pro notch (> 74px) */
    ASSERT_TRUE(vp.dst_y >= 74);

    /* 3. Pure symmetric integer scale: 640x480 on 3024x1964 (safe_inset_top = 0) -> k = 4 (2560x1920) */
    ASSERT_TRUE(ds_compute_viewport(3024, 1964, 0, 640, 480, DS_ASPECT_INTEGER, &vp));
    ASSERT_TRUE(vp.integer_scale == 4);
    ASSERT_TRUE(vp.dst_w == 2560 && vp.dst_h == 1920);
    ASSERT_TRUE(vp.dst_x == (3024 - 2560) / 2);
    ASSERT_TRUE(vp.dst_y == (1964 - 1920) / 2);
    ASSERT_TRUE(vp.dst_y == (1964 - (vp.dst_y + vp.dst_h)));

    /* 4. Legacy notch inset compatibility: MacBook Pro 14" (1512x982, safe_inset_top = 32), 640x480 4:3 */
    ASSERT_TRUE(ds_compute_viewport(1512, 982, 32, 640, 480, DS_ASPECT_PRESERVE, &vp));
    ASSERT_TRUE(vp.usable_x == 0 && vp.usable_y == 32);
    ASSERT_TRUE(vp.usable_w == 1512 && vp.usable_h == 950);
    ASSERT_TRUE(vp.dst_y == 32 && vp.dst_h == 950);
    ASSERT_TRUE(vp.dst_w == 1268 && vp.dst_x == 122);
    ASSERT_TRUE(vp.integer_scale == 0);

    /* 5. Stretch fills full usable area */
    ASSERT_TRUE(ds_compute_viewport(3024, 1964, 0, 640, 480, DS_ASPECT_STRETCH, &vp));
    ASSERT_TRUE(vp.dst_x == 0 && vp.dst_y == 0 && vp.dst_w == 3024 && vp.dst_h == 1964);

    /* 6. Oversized safe_inset_top clamped strictly < screen_h / 4 & invalid dims rejected */
    ASSERT_TRUE(ds_clamp_safe_inset_top(500, 1000) == 249);
    ASSERT_TRUE(ds_clamp_safe_inset_top(-10, 1000) == 0);
    ASSERT_TRUE(ds_clamp_safe_inset_top(0, 1964) == 0);
    ASSERT_TRUE(!ds_compute_viewport(0, 1964, 0, 640, 480, DS_ASPECT_PRESERVE, &vp));
    ASSERT_TRUE(!ds_compute_viewport(3024, 0, 0, 640, 480, DS_ASPECT_PRESERVE, &vp));
    ASSERT_TRUE(!ds_compute_viewport(3024, 1964, 0, 0, 480, DS_ASPECT_PRESERVE, &vp));
    ASSERT_TRUE(!ds_compute_viewport(3024, 1964, 0, 640, 480, DS_ASPECT_PRESERVE, NULL));
}

static void test_mode_table_invariants(void)
{
    ds_display_mode_t modes[64];
    memset(modes, 0, sizeof(modes));

    ASSERT_TRUE(DS_MAX_SYNTH_MODES <= 52u);

    /* 1. Primary target: Native MacBook Pro HiDPI Retina (3024x1964, 120Hz) */
    size_t n = ds_build_mode_table(3024, 1964, 120, modes, 64);
    /* Must stay strictly <= 52 (DS_MAX_SYNTH_MODES) so legacy 64-slot DEVMODE buffers never overflow */
    ASSERT_TRUE(n > 0 && n <= DS_MAX_SYNTH_MODES);

    bool has_320x200_8 = false;
    bool has_640_8 = false, has_640_16 = false, has_640_32 = false;
    bool has_800_8 = false, has_800_32 = false, has_1024_8 = false, has_1024_32 = false;
    bool has_1080p_16 = false, has_1080p_32 = false;
    bool has_1440p_16 = false, has_1440p_32 = false;
    bool has_1600p_16 = false, has_1600p_32 = false;
    bool has_native_16 = false, has_native_32 = false;
    bool has_any_8bpp_above_1024 = false;

    for (size_t i = 0; i < n; i++) {
        ASSERT_TRUE(modes[i].refresh_hz == 120);
        ASSERT_TRUE(modes[i].bpp == 8 || modes[i].bpp == 16 || modes[i].bpp == 32);
        if (i > 0) {
            bool ordered = (modes[i].width > modes[i - 1].width) ||
                           (modes[i].width == modes[i - 1].width && modes[i].height > modes[i - 1].height) ||
                           (modes[i].width == modes[i - 1].width && modes[i].height == modes[i - 1].height && modes[i].bpp > modes[i - 1].bpp);
            ASSERT_TRUE(ordered);
        }
        if (modes[i].bpp == 8 && (modes[i].width > 1024 || modes[i].height > 768)) {
            has_any_8bpp_above_1024 = true;
        }
        if (modes[i].width == 320 && modes[i].height == 200 && modes[i].bpp == 8) has_320x200_8 = true;
        if (modes[i].width == 640 && modes[i].height == 480 && modes[i].bpp == 8) has_640_8 = true;
        if (modes[i].width == 640 && modes[i].height == 480 && modes[i].bpp == 16) has_640_16 = true;
        if (modes[i].width == 640 && modes[i].height == 480 && modes[i].bpp == 32) has_640_32 = true;
        if (modes[i].width == 800 && modes[i].height == 600 && modes[i].bpp == 8) has_800_8 = true;
        if (modes[i].width == 800 && modes[i].height == 600 && modes[i].bpp == 32) has_800_32 = true;
        if (modes[i].width == 1024 && modes[i].height == 768 && modes[i].bpp == 8) has_1024_8 = true;
        if (modes[i].width == 1024 && modes[i].height == 768 && modes[i].bpp == 32) has_1024_32 = true;
        if (modes[i].width == 1920 && modes[i].height == 1080 && modes[i].bpp == 16) has_1080p_16 = true;
        if (modes[i].width == 1920 && modes[i].height == 1080 && modes[i].bpp == 32) has_1080p_32 = true;
        if (modes[i].width == 2560 && modes[i].height == 1440 && modes[i].bpp == 16) has_1440p_16 = true;
        if (modes[i].width == 2560 && modes[i].height == 1440 && modes[i].bpp == 32) has_1440p_32 = true;
        if (modes[i].width == 2560 && modes[i].height == 1600 && modes[i].bpp == 16) has_1600p_16 = true;
        if (modes[i].width == 2560 && modes[i].height == 1600 && modes[i].bpp == 32) has_1600p_32 = true;
        if (modes[i].width == 3024 && modes[i].height == 1964 && modes[i].bpp == 16) has_native_16 = true;
        if (modes[i].width == 3024 && modes[i].height == 1964 && modes[i].bpp == 32) has_native_32 = true;
    }

    /* 8-bpp modes must be strictly pruned for resolutions > 1024x768 */
    ASSERT_TRUE(!has_any_8bpp_above_1024);
    ASSERT_TRUE(has_320x200_8 && has_640_8 && has_640_16 && has_640_32);
    ASSERT_TRUE(has_800_8 && has_800_32 && has_1024_8 && has_1024_32);
    ASSERT_TRUE(has_1080p_16 && has_1080p_32);
    ASSERT_TRUE(has_1440p_16 && has_1440p_32);
    ASSERT_TRUE(has_1600p_16 && has_1600p_32);
    /* Native 3024x1964 is guaranteed at 16-bpp and 32-bpp without truncation */
    ASSERT_TRUE(has_native_16 && has_native_32);

    /* 2. Scaled / standard 1512x982 display */
    size_t n_scaled = ds_build_mode_table(1512, 982, 60, modes, 64);
    ASSERT_TRUE(n_scaled > 0 && n_scaled <= DS_MAX_SYNTH_MODES);
    bool has_1512_16 = false, has_1512_32 = false;
    for (size_t i = 0; i < n_scaled; i++) {
        if (modes[i].width == 1512 && modes[i].height == 982 && modes[i].bpp == 16) has_1512_16 = true;
        if (modes[i].width == 1512 && modes[i].height == 982 && modes[i].bpp == 32) has_1512_32 = true;
    }
    ASSERT_TRUE(has_1512_16 && has_1512_32);

    /* 3. Tiny 800x600 desktop: mandatory 1024x768 still included, <= DS_MAX_SYNTH_MODES */
    size_t n_small = ds_build_mode_table(800, 600, 60, modes, 64);
    ASSERT_TRUE(n_small >= 12 && n_small <= DS_MAX_SYNTH_MODES);

    /* 4. 4K 3840x2160: native is NEVER truncated, total <= DS_MAX_SYNTH_MODES */
    size_t n_4k = ds_build_mode_table(3840, 2160, 144, modes, 64);
    ASSERT_TRUE(n_4k > 0 && n_4k <= DS_MAX_SYNTH_MODES);
    bool has_4k_16 = false, has_4k_32 = false;
    for (size_t i = 0; i < n_4k; i++) {
        if (modes[i].width == 3840 && modes[i].height == 2160 && modes[i].bpp == 16) has_4k_16 = true;
        if (modes[i].width == 3840 && modes[i].height == 2160 && modes[i].bpp == 32) has_4k_32 = true;
    }
    ASSERT_TRUE(has_4k_16 && has_4k_32);
}

static void test_cursor_mapping_and_zero_drift_mouselook(void)
{
    int32_t vx = -1, vy = -1;
    /* Left black pillarbox (`px = 10 < dst_x = 123`) clamps cleanly to `vx = 0` */
    ASSERT_TRUE(ds_map_cursor_phys_to_virt(10, 32, 123, 32, 1266, 950, 640, 480, &vx, &vy));
    ASSERT_TRUE(vx == 0 && vy == 0);

    /* Right black pillarbox & bottom corner clamp cleanly to `(639, 479)` */
    ASSERT_TRUE(ds_map_cursor_phys_to_virt(1511, 981, 123, 32, 1266, 950, 640, 480, &vx, &vy));
    ASSERT_TRUE(vx == 639 && vy == 479);

    /* 10,000-frame stationary 3D mouse-look center warp torture test: ZERO drift! */
    ds_cursor_warp_state_t warp;
    ds_cursor_warp_reset(&warp);

    for (int frame = 0; frame < 10000; frame++) {
        int32_t px = 0, py = 0;
        ASSERT_TRUE(ds_cursor_record_warp(&warp, 320, 240, 123, 32, 1266, 950, 640, 480, &px, &py));
        int32_t rvx = 0, rvy = 0;
        ASSERT_TRUE(ds_cursor_resolve_get_pos(&warp, px, py, 123, 32, 1266, 950, 640, 480, &rvx, &rvy));
        ASSERT_TRUE(rvx == 320 && rvy == 240);
    }

    /* Sub-pixel accumulator test: 100 single-physical-pixel steps right (`+1 px` per frame)
     * across `640 / 1266` (`~0.5055` virtual px/frame) must accumulate ~50–51 virtual pixels,
     * NOT collapse to `0`! */
    ds_cursor_warp_reset(&warp);
    int32_t total_delta_vx = 0;
    for (int frame = 0; frame < 100; frame++) {
        int32_t px = 0, py = 0;
        ASSERT_TRUE(ds_cursor_record_warp(&warp, 320, 240, 123, 32, 1266, 950, 640, 480, &px, &py));
        int32_t rvx = 0, rvy = 0;
        ASSERT_TRUE(ds_cursor_resolve_get_pos(&warp, px + 1, py, 123, 32, 1266, 950, 640, 480, &rvx, &rvy));
        total_delta_vx += (rvx - 320);
    }
    ASSERT_TRUE(total_delta_vx >= 49 && total_delta_vx <= 52);
}

static void test_subrect_and_control_ini_parser(void)
{
    int32_t px = 0, py = 0, pw = 0, ph = 0;
    ASSERT_TRUE(ds_map_subrect_virt_to_phys(0, 0, 640, 480, 0, 0, 1266, 950, 640, 480, &px, &py, &pw, &ph));
    ASSERT_TRUE(px == 0 && py == 0 && pw == 1266 && ph == 950);

    /* 1x1 dirty pixel blit still produces >= 1x1 physical rect */
    ASSERT_TRUE(ds_map_subrect_virt_to_phys(100, 100, 1, 1, 0, 0, 1266, 950, 640, 480, &px, &py, &pw, &ph));
    ASSERT_TRUE(pw >= 1 && ph >= 1);

    /* Control INI parser: comments, CRLF, whitespace, valid values */
    const char *ini1 = "# comment\r\n  seq = 42 \r\nfullscreen=0\n aspect = integer \n";
    ds_control_state_t st;
    ASSERT_TRUE(ds_parse_control_ini(ini1, strlen(ini1), &st));
    ASSERT_TRUE(st.has_seq && st.seq == 42ULL);
    ASSERT_TRUE(st.has_fullscreen && st.fullscreen == false);
    ASSERT_TRUE(st.has_aspect && st.aspect == DS_ASPECT_INTEGER);

    /* Non-NUL-terminated slice & u64 overflow safety */
    char *raw_no_nul = (char *)malloc(24);
    ASSERT_TRUE(raw_no_nul != NULL);
    memcpy(raw_no_nul, "seq=99999999999999999999", 24);
    ASSERT_TRUE(!ds_parse_control_ini(raw_no_nul, 24, &st));
    ASSERT_TRUE(!st.has_seq);
    free(raw_no_nul);

    /*Mode & aspect string helpers */
    ASSERT_TRUE(ds_parse_scaling_mode("auto") == DS_MODE_AUTO_FULLSCREEN);
    ASSERT_TRUE(ds_parse_scaling_mode("auto_fullscreen") == DS_MODE_AUTO_FULLSCREEN);
    ASSERT_TRUE(ds_parse_scaling_mode(" FORCE_FULLSCREEN ") == DS_MODE_FORCE_FULLSCREEN);
    ASSERT_TRUE(ds_parse_scaling_mode("windowed") == DS_MODE_PASSTHROUGH);
    ASSERT_TRUE(ds_cycle_aspect_mode(DS_ASPECT_PRESERVE) == DS_ASPECT_INTEGER);
    ASSERT_TRUE(ds_cycle_aspect_mode(DS_ASPECT_INTEGER) == DS_ASPECT_STRETCH);
    ASSERT_TRUE(ds_cycle_aspect_mode(DS_ASPECT_STRETCH) == DS_ASPECT_PRESERVE);
}

static void test_wave2a_exact_cursor_roundtrip_and_even_viewports(void)
{
    static const struct {
        int32_t sw;
        int32_t sh;
        int32_t inset;
    } panels[] = {
        { 3024, 1964, 0 },
        { 3024, 1964, 37 },
        { 3024, 1964, 74 },
        { 2560, 1440, 0 },
        { 1920, 1080, 0 },
    };

    static const struct {
        int32_t vw;
        int32_t vh;
    } modes[] = {
        { 320, 200 },
        { 640, 480 },
        { 800, 600 },
        { 1024, 768 },
        { 1280, 720 },
        { 1600, 900 },
        { 1920, 1080 },
    };

    static const ds_aspect_mode_t aspects[] = {
        DS_ASPECT_PRESERVE,
        DS_ASPECT_INTEGER,
        DS_ASPECT_STRETCH,
    };

    for (size_t pi = 0; pi < sizeof(panels) / sizeof(panels[0]); pi++) {
        for (size_t mi = 0; mi < sizeof(modes) / sizeof(modes[0]); mi++) {
            for (size_t ai = 0; ai < sizeof(aspects) / sizeof(aspects[0]); ai++) {
                ds_viewport_t vp;
                ASSERT_TRUE(ds_compute_viewport(
                    panels[pi].sw,
                    panels[pi].sh,
                    panels[pi].inset,
                    modes[mi].vw,
                    modes[mi].vh,
                    aspects[ai],
                    &vp
                ));

                if (aspects[ai] == DS_ASPECT_PRESERVE) {
                    if (vp.dst_w < vp.usable_w && vp.usable_w >= 2) ASSERT_TRUE((vp.dst_w & 1) == 0);
                    if (vp.dst_h < vp.usable_h && vp.usable_h >= 2) ASSERT_TRUE((vp.dst_h & 1) == 0);
                }

                /* Whenever physical footprint >= virtual dimensions (D >= V >= 1),
                 * pixel-center mapping must satisfy phys_to_virt(virt_to_phys(v)) == v
                 * for EVERY single coordinate without -1 px/frame ceiling drift. */
                if (vp.dst_w >= modes[mi].vw && vp.dst_h >= modes[mi].vh) {
                    for (int32_t vx = 0; vx < modes[mi].vw; vx++) {
                        int32_t px = 0, py = 0, rvx = -1, rvy = -1;
                        ASSERT_TRUE(ds_map_cursor_virt_to_phys(
                            vx, 0,
                            vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h,
                            modes[mi].vw, modes[mi].vh,
                            &px, &py
                        ));
                        ASSERT_TRUE(ds_map_cursor_phys_to_virt(
                            px, py,
                            vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h,
                            modes[mi].vw, modes[mi].vh,
                            &rvx, &rvy
                        ));
                        ASSERT_TRUE(rvx == vx && rvy == 0);
                    }
                    for (int32_t vy = 0; vy < modes[mi].vh; vy++) {
                        int32_t px = 0, py = 0, rvx = -1, rvy = -1;
                        ASSERT_TRUE(ds_map_cursor_virt_to_phys(
                            0, vy,
                            vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h,
                            modes[mi].vw, modes[mi].vh,
                            &px, &py
                        ));
                        ASSERT_TRUE(ds_map_cursor_phys_to_virt(
                            px, py,
                            vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h,
                            modes[mi].vw, modes[mi].vh,
                            &rvx, &rvy
                        ));
                        ASSERT_TRUE(rvx == 0 && rvy == vy);
                    }
                }
            }
        }
    }

    /* Specifically verify 1600x900 on 3024x1964 has even dst_h (1700) and zero drift at center (800, 450) */
    ds_viewport_t vp_900p;
    ASSERT_TRUE(ds_compute_viewport(3024, 1964, 0, 1600, 900, DS_ASPECT_PRESERVE, &vp_900p));
    ASSERT_TRUE(vp_900p.dst_w == 3024 && vp_900p.dst_h == 1700);
    int32_t cpx = 0, cpy = 0, crvx = 0, crvy = 0;
    ASSERT_TRUE(ds_map_cursor_virt_to_phys(800, 450, vp_900p.dst_x, vp_900p.dst_y, vp_900p.dst_w, vp_900p.dst_h, 1600, 900, &cpx, &cpy));
    ASSERT_TRUE(ds_map_cursor_phys_to_virt(cpx, cpy, vp_900p.dst_x, vp_900p.dst_y, vp_900p.dst_w, vp_900p.dst_h, 1600, 900, &crvx, &crvy));
    ASSERT_TRUE(crvx == 800 && crvy == 450);

    /* Verify symmetric pixel-center placement at 640x480 on 3024x1964 (~4.09x footprint):
     * +/- 1 physical pixel around the mapped center remains inside virtual pixel (320, 240)
     * rather than sitting on the left boundary with a 5:1 asymmetric deadzone. */
    ds_viewport_t vp_480p;
    ASSERT_TRUE(ds_compute_viewport(3024, 1964, 0, 640, 480, DS_ASPECT_PRESERVE, &vp_480p));
    ASSERT_TRUE(ds_map_cursor_virt_to_phys(320, 240, vp_480p.dst_x, vp_480p.dst_y, vp_480p.dst_w, vp_480p.dst_h, 640, 480, &cpx, &cpy));
    int32_t lvx = -1, lvy = -1, rvx = -1, rvy = -1;
    ASSERT_TRUE(ds_map_cursor_phys_to_virt(cpx - 1, cpy - 1, vp_480p.dst_x, vp_480p.dst_y, vp_480p.dst_w, vp_480p.dst_h, 640, 480, &lvx, &lvy));
    ASSERT_TRUE(ds_map_cursor_phys_to_virt(cpx + 1, cpy + 1, vp_480p.dst_x, vp_480p.dst_y, vp_480p.dst_w, vp_480p.dst_h, 640, 480, &rvx, &rvy));
    ASSERT_TRUE(lvx == 320 && lvy == 240);
    ASSERT_TRUE(rvx == 320 && rvy == 240);
}

static void test_wave2a_watertight_strips_and_extended_ini(void)
{
    /* Watertight adjacent 1-pixel GDI strip blits across non-integer scale (640x480 -> 2618x1964) */
    ds_viewport_t vp;
    ASSERT_TRUE(ds_compute_viewport(3024, 1964, 0, 640, 480, DS_ASPECT_PRESERVE, &vp));

    int32_t expected_x = vp.dst_x;
    for (int32_t vx = 0; vx < 640; vx++) {
        int32_t px = 0, py = 0, pw = 0, ph = 0;
        ASSERT_TRUE(ds_map_subrect_virt_to_phys(
            vx, 0, 1, 480,
            vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h,
            640, 480,
            &px, &py, &pw, &ph
        ));
        ASSERT_TRUE(px == expected_x);
        ASSERT_TRUE(pw >= 1);
        ASSERT_TRUE(py == vp.dst_y && ph == vp.dst_h);
        expected_x = px + pw;
    }
    ASSERT_TRUE(expected_x == vp.dst_x + vp.dst_w);

    int32_t expected_y = vp.dst_y;
    for (int32_t vy = 0; vy < 480; vy++) {
        int32_t px = 0, py = 0, pw = 0, ph = 0;
        ASSERT_TRUE(ds_map_subrect_virt_to_phys(
            0, vy, 640, 1,
            vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h,
            640, 480,
            &px, &py, &pw, &ph
        ));
        ASSERT_TRUE(py == expected_y);
        ASSERT_TRUE(ph >= 1);
        ASSERT_TRUE(px == vp.dst_x && pw == vp.dst_w);
        expected_y = py + ph;
    }
    ASSERT_TRUE(expected_y == vp.dst_y + vp.dst_h);

    /* Extended active_session.ini & runtime control INI keys */
    const char *session_ini =
        "seq=7\r\n"
        "fullscreen=1\r\n"
        "aspect=preserve\r\n"
        "safe_inset_top=74\r\n"
        "filter=sharp\r\n"
        "mode=auto_fullscreen\r\n"
        "hotkey=1\r\n"
        "updated_unix_ms=1762796867123\r\n"
        "control_file=C:\\users\\Public\\OneLauncher\\display_control.ini\r\n"
        "status_file=C:\\users\\Public\\OneLauncher\\display_status.json\r\n";
    ds_control_state_t st;
    ASSERT_TRUE(ds_parse_control_ini(session_ini, strlen(session_ini), &st));
    ASSERT_TRUE(st.has_seq && st.seq == 7ULL);
    ASSERT_TRUE(st.has_fullscreen && st.fullscreen == true);
    ASSERT_TRUE(st.has_aspect && st.aspect == DS_ASPECT_PRESERVE);
    ASSERT_TRUE(st.has_safe_inset_top && st.safe_inset_top == 74);
    ASSERT_TRUE(st.has_filter && st.filter == DS_FILTER_SHARP);
    ASSERT_TRUE(st.has_scaling_mode && st.scaling_mode == DS_MODE_AUTO_FULLSCREEN);
    ASSERT_TRUE(st.has_hotkey && st.hotkey == true);
    ASSERT_TRUE(st.has_updated_unix_ms && st.updated_unix_ms == 1762796867123ULL);
    ASSERT_TRUE(st.has_control_file && strcmp(st.control_file, "C:\\users\\Public\\OneLauncher\\display_control.ini") == 0);
    ASSERT_TRUE(st.has_status_file && strcmp(st.status_file, "C:\\users\\Public\\OneLauncher\\display_status.json") == 0);

    ASSERT_TRUE(ds_parse_scale_filter("auto") == DS_FILTER_AUTO);
    ASSERT_TRUE(ds_parse_scale_filter("sharp") == DS_FILTER_SHARP);
    ASSERT_TRUE(ds_parse_scale_filter("sharp_bilinear") == DS_FILTER_SHARP);
    ASSERT_TRUE(ds_parse_scale_filter("linear") == DS_FILTER_LINEAR);
    ASSERT_TRUE(ds_parse_scale_filter("nearest") == DS_FILTER_NEAREST);
    ASSERT_TRUE(strcmp(ds_scale_filter_to_string(DS_FILTER_SHARP), "sharp") == 0);

    /* Canonical `active_session.ini` version comparison shared by DllMain & ds_poll_active_session_if_needed */
    const char *sess_v1 = "seq=1\nupdated_unix_ms=1762800000100\naspect=preserve_aspect\n";
    const char *sess_v2 = "seq=2\nupdated_unix_ms=1762800000500\naspect=stretch\n";
    const char *sess_next_game = "seq=1\nupdated_unix_ms=1762800010000\naspect=integer\n";
    ds_control_state_t s1, s2, s3;
    ASSERT_TRUE(ds_parse_control_ini(sess_v1, strlen(sess_v1), &s1));
    ASSERT_TRUE(ds_parse_control_ini(sess_v2, strlen(sess_v2), &s2));
    ASSERT_TRUE(ds_parse_control_ini(sess_next_game, strlen(sess_next_game), &s3));
    ASSERT_TRUE(ds_effective_active_session_seq(&s1) == 1762800000100ULL);
    ASSERT_TRUE(ds_effective_active_session_seq(&s2) > ds_effective_active_session_seq(&s1));
    ASSERT_TRUE(ds_effective_active_session_seq(&s3) > ds_effective_active_session_seq(&s2));
}

int main(void)
{
    test_viewport_and_notch_geometry();
    test_mode_table_invariants();
    test_cursor_mapping_and_zero_drift_mouselook();
    test_subrect_and_control_ini_parser();
    test_wave2a_exact_cursor_roundtrip_and_even_viewports();
    test_wave2a_watertight_strips_and_extended_ini();
    printf("[DS-ASAN-PASS] All display_scaler C11 geometry, mode-table, zero-drift mouselook & INI tests passed.\n");
    return 0;
}
