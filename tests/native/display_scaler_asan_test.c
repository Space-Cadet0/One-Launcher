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
#include "common_process_denylist.h"

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

static void test_v3_user_override_and_mode_union(void)
{
    /* 1. ds_parse_control_ini: user_override defaults from seq (seq <= 1 -> false, seq >= 2 -> true)
     *    and respects explicit user_override=0|1 */
    ds_control_state_t c1, c2, c3, c4, c5;
    const char *ini_seq1 = "seq=1\nfullscreen=1\naspect=preserve_aspect\nsafe_inset_top=0\n";
    ASSERT_TRUE(ds_parse_control_ini(ini_seq1, strlen(ini_seq1), &c1));
    ASSERT_TRUE(c1.has_seq && c1.seq == 1ULL);
    ASSERT_TRUE(c1.has_fullscreen && c1.fullscreen == true);
    ASSERT_TRUE(!c1.has_user_override);
    ASSERT_TRUE(c1.user_override == false);

    const char *ini_seq2 = "seq=2\nfullscreen=0\naspect=preserve_aspect\nsafe_inset_top=0\n";
    ASSERT_TRUE(ds_parse_control_ini(ini_seq2, strlen(ini_seq2), &c2));
    ASSERT_TRUE(c2.has_seq && c2.seq == 2ULL);
    ASSERT_TRUE(c2.has_fullscreen && c2.fullscreen == false);
    ASSERT_TRUE(!c2.has_user_override);
    ASSERT_TRUE(c2.user_override == true);

    const char *ini_exp_0 = "seq=5\nfullscreen=1\nuser_override=0\n";
    ASSERT_TRUE(ds_parse_control_ini(ini_exp_0, strlen(ini_exp_0), &c3));
    ASSERT_TRUE(c3.has_user_override && c3.user_override == false);

    const char *ini_exp_1 = "seq=1\nfullscreen=1\nuser_override=1\n";
    ASSERT_TRUE(ds_parse_control_ini(ini_exp_1, strlen(ini_exp_1), &c4));
    ASSERT_TRUE(c4.has_user_override && c4.user_override == true);

    const char *ini_off = "seq=1\nmode=off\nfullscreen=0\n";
    ASSERT_TRUE(ds_parse_control_ini(ini_off, strlen(ini_off), &c5));
    ASSERT_TRUE(c5.has_scaling_mode && c5.scaling_mode == DS_MODE_PASSTHROUGH);
    ASSERT_TRUE(c5.user_override == false);

    /* 2. ds_merge_mode_tables: OS-union deduplication, OS refresh-rate preference, ascending sort,
     *    and strict DS_MAX_UNION_MODES = 128u capacity bound under ASan/UBSan */
    ds_display_mode_t synth[DS_MAX_SYNTH_MODES];
    size_t synth_n = ds_build_mode_table(3024, 1964, 60, synth, DS_MAX_SYNTH_MODES);
    ASSERT_TRUE(synth_n > 0 && synth_n <= DS_MAX_SYNTH_MODES);

    ds_display_mode_t os_modes[5] = {
        { 3024, 1964, 32, 120 },
        { 1920, 1080, 32, 120 },
        { 2560, 1600, 32, 120 },
        { 1920, 1080, 32, 60 }, /* duplicate lower Hz after 120 Hz */
        { 3024, 1964, 32, 120 }, /* exact duplicate */
    };

    ds_display_mode_t merged[DS_MAX_UNION_MODES];
    size_t merged_n = ds_merge_mode_tables(os_modes, 5, synth, synth_n, merged, DS_MAX_UNION_MODES);
    ASSERT_TRUE(merged_n >= synth_n && merged_n <= DS_MAX_UNION_MODES);

    bool found_3024_120 = false;
    bool found_1920_120 = false;
    bool found_2560_120 = false;
    for (size_t i = 0; i < merged_n; i++) {
        if (i > 0) {
            /* Strictly ascending (width, height, bpp) with zero duplicates */
            ASSERT_TRUE(
                merged[i - 1].width < merged[i].width ||
                (merged[i - 1].width == merged[i].width && merged[i - 1].height < merged[i].height) ||
                (merged[i - 1].width == merged[i].width &&
                 merged[i - 1].height == merged[i].height &&
                 merged[i - 1].bpp < merged[i].bpp)
            );
        }
        if (merged[i].width == 3024 && merged[i].height == 1964 && merged[i].bpp == 32) {
            ASSERT_TRUE(merged[i].refresh_hz == 120);
            found_3024_120 = true;
        }
        if (merged[i].width == 1920 && merged[i].height == 1080 && merged[i].bpp == 32) {
            ASSERT_TRUE(merged[i].refresh_hz == 120);
            found_1920_120 = true;
        }
        if (merged[i].width == 2560 && merged[i].height == 1600 && merged[i].bpp == 32) {
            ASSERT_TRUE(merged[i].refresh_hz == 120);
            found_2560_120 = true;
        }
    }
    ASSERT_TRUE(found_3024_120 && found_1920_120 && found_2560_120);

    /* Capacity saturation test: > 160 distinct OS+synth modes must never overflow DS_MAX_UNION_MODES */
    ds_display_mode_t flood_os[100];
    ds_display_mode_t flood_synth[100];
    for (size_t i = 0; i < 100; i++) {
        flood_os[i].width = (int32_t)(640 + i * 16);
        flood_os[i].height = (int32_t)(480 + i * 10);
        flood_os[i].bpp = 32;
        flood_os[i].refresh_hz = 120;
        flood_synth[i].width = (int32_t)(640 + i * 16);
        flood_synth[i].height = (int32_t)(480 + i * 10);
        flood_synth[i].bpp = 16;
        flood_synth[i].refresh_hz = 60;
    }
    size_t sat_n = ds_merge_mode_tables(flood_os, 100, flood_synth, 100, merged, DS_MAX_UNION_MODES);
    ASSERT_TRUE(sat_n == DS_MAX_UNION_MODES);
    for (size_t i = 1; i < sat_n; i++) {
        ASSERT_TRUE(
            merged[i - 1].width < merged[i].width ||
            (merged[i - 1].width == merged[i].width && merged[i - 1].height < merged[i].height) ||
            (merged[i - 1].width == merged[i].width &&
             merged[i - 1].height == merged[i].height &&
             merged[i - 1].bpp < merged[i].bpp)
        );
    }

    /* Edge cases: NULL inputs and zero capacity */
    ASSERT_TRUE(ds_merge_mode_tables(NULL, 0, NULL, 0, merged, DS_MAX_UNION_MODES) == 0);
    ASSERT_TRUE(ds_merge_mode_tables(os_modes, 5, synth, synth_n, NULL, DS_MAX_UNION_MODES) == 0);
    ASSERT_TRUE(ds_merge_mode_tables(os_modes, 5, synth, synth_n, merged, 0) == 0);
    ASSERT_TRUE(ds_merge_mode_tables(NULL, 0, synth, synth_n, merged, DS_MAX_UNION_MODES) == synth_n);
}

static void test_v3_three_tier_state_machine_and_multimonitor(void)
{
    ds_tier_input_t in;

    /* 1. Tier 0: Legacy 32-bit DDraw / D3D8 / OpenGL stays DS_PRESENTER_LEGACY_VIRTUAL */
    memset(&in, 0, sizeof(in));
    in.scaling_mode = DS_MODE_AUTO_FULLSCREEN;
    in.ddraw_loaded = true;
    in.legacy_d3d_loaded = true;
    ASSERT_TRUE(!ds_is_vulkan_legacy_d3d(&in));
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_LEGACY_VIRTUAL);

    /* 2. Tier 1: Modern 64-bit DX11/DX12/Vulkan in auto_fullscreen -> DS_PRESENTER_MODERN_PASSTHROUGH */
    memset(&in, 0, sizeof(in));
    in.scaling_mode = DS_MODE_AUTO_FULLSCREEN;
    in.is_64bit = true;
    in.dxgi_or_d3d10_plus_loaded = true;
    in.modern_gfx_loaded = true;
    ASSERT_TRUE(!ds_is_vulkan_legacy_d3d(&in));
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_MODERN_PASSTHROUGH);

    /* 3. Tier 2: force_fullscreen or user_forced_fullscreen -> DS_PRESENTER_MODERN_BORDERLESS */
    in.scaling_mode = DS_MODE_FORCE_FULLSCREEN;
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_MODERN_BORDERLESS);
    in.scaling_mode = DS_MODE_AUTO_FULLSCREEN;
    in.user_forced_fullscreen = true;
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_MODERN_BORDERLESS);

    /* 4. F1 regression: Tier 2 -> Windowed (user_forced_windowed = true) stays in Tier 2
     *    so Tier 2's windowed-exit presentation branch executes cleanly */
    in.user_forced_fullscreen = false;
    in.user_forced_windowed = true;
    in.borderless_active = true;
    in.window_mutated_by_scaler = true;
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_MODERN_BORDERLESS);

    /* Even when exiting a native Tier 1 fullscreen game on first Ctrl+Option+F */
    in.borderless_active = false;
    in.window_mutated_by_scaler = false;
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_MODERN_BORDERLESS);

    /* DS_MODE_PASSTHROUGH always resolves to Tier 1 */
    in.scaling_mode = DS_MODE_PASSTHROUGH;
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_MODERN_PASSTHROUGH);

    /* 5. F3 regression: 32-bit Pure D3D9 / D3D8 / DDraw on WineD3D-Vulkan or DXVK */
    memset(&in, 0, sizeof(in));
    in.scaling_mode = DS_MODE_AUTO_FULLSCREEN;
    in.is_64bit = false;
    in.d3d9_loaded = true;
    in.d3d8_or_9_loaded = true;
    in.legacy_d3d_loaded = true;
    in.vulkan_loaded = true;
    in.wined3d_uses_vulkan = true;
    ASSERT_TRUE(ds_is_vulkan_legacy_d3d(&in));
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_MODERN_PASSTHROUGH);
    in.fullscreen_active = true;
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_MODERN_BORDERLESS);

    /* 32-bit D3D8 on WineD3D-Vulkan (no d3d9_loaded) ALSO routes through Vulkan legacy D3D */
    in.d3d9_loaded = false;
    ASSERT_TRUE(ds_is_vulkan_legacy_d3d(&in));
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_MODERN_BORDERLESS);

    /* 32-bit DDraw on WineD3D-Vulkan without GDI path ALSO routes through Vulkan legacy D3D */
    in.d3d8_or_9_loaded = false;
    in.ddraw_loaded = true;
    ASSERT_TRUE(ds_is_vulkan_legacy_d3d(&in));
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_MODERN_BORDERLESS);

    /* 6. F3 regression: 32-bit DDraw/GDI with Vulkan overlay stays Tier 0 Legacy Virtual */
    in.ddraw_gdi_active = true;
    ASSERT_TRUE(!ds_is_vulkan_legacy_d3d(&in));
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_LEGACY_VIRTUAL);

    /* 7. F3 regression: GL-after-Vulkan-probe (wined3d_uses_gl = true wins over prior Vulkan probe) */
    memset(&in, 0, sizeof(in));
    in.scaling_mode = DS_MODE_AUTO_FULLSCREEN;
    in.d3d9_loaded = true;
    in.d3d8_or_9_loaded = true;
    in.legacy_d3d_loaded = true;
    in.vulkan_loaded = true;
    in.wined3d_uses_vulkan = true;
    in.wined3d_uses_gl = true;
    ASSERT_TRUE(!ds_is_vulkan_legacy_d3d(&in));
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_LEGACY_VIRTUAL);

    /* Native OpenGL game with Vulkan overlay also stays Tier 0 */
    memset(&in, 0, sizeof(in));
    in.scaling_mode = DS_MODE_AUTO_FULLSCREEN;
    in.vulkan_loaded = true;
    in.wined3d_uses_vulkan = true;
    in.game_gl_active = true;
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_LEGACY_VIRTUAL);

    /* 64-bit Vulkan + D3D9 never claims 32-bit Vulkan legacy D3D */
    memset(&in, 0, sizeof(in));
    in.scaling_mode = DS_MODE_AUTO_FULLSCREEN;
    in.is_64bit = true;
    in.d3d9_loaded = true;
    in.vulkan_loaded = true;
    in.wined3d_uses_vulkan = true;
    ASSERT_TRUE(!ds_is_vulkan_legacy_d3d(&in));
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_MODERN_PASSTHROUGH);

    /* 8. Multi-monitor negative-origin coordinate mapping (left-of-primary & above-primary monitor) */
    ds_viewport_t neg_vp;
    ASSERT_TRUE(ds_compute_viewport(1920, 1080, 0, 640, 480, DS_ASPECT_PRESERVE, &neg_vp));
    int32_t mon_x = -1920;
    int32_t mon_y = -1080;
    int32_t scr_dst_x = mon_x + neg_vp.dst_x;
    int32_t scr_dst_y = mon_y + neg_vp.dst_y;
    for (int32_t vx = 0; vx < 640; vx += 17) {
        for (int32_t vy = 0; vy < 480; vy += 19) {
            int32_t px = 0, py = 0, rvx = -1, rvy = -1;
            ASSERT_TRUE(ds_map_cursor_virt_to_phys(
                vx, vy, scr_dst_x, scr_dst_y, neg_vp.dst_w, neg_vp.dst_h, 640, 480, &px, &py
            ));
            ASSERT_TRUE(px >= scr_dst_x && px < scr_dst_x + neg_vp.dst_w);
            ASSERT_TRUE(py >= scr_dst_y && py < scr_dst_y + neg_vp.dst_h);
            ASSERT_TRUE(ds_map_cursor_phys_to_virt(
                px, py, scr_dst_x, scr_dst_y, neg_vp.dst_w, neg_vp.dst_h, 640, 480, &rvx, &rvy
            ));
            ASSERT_TRUE(rvx == vx && rvy == vy);
        }
    }
    int32_t sx = 0, sy = 0, sw = 0, sh = 0;
    ASSERT_TRUE(ds_map_subrect_virt_to_phys(
        10, 20, 100, 80, scr_dst_x, scr_dst_y, neg_vp.dst_w, neg_vp.dst_h, 640, 480, &sx, &sy, &sw, &sh
    ));
    ASSERT_TRUE(sx >= scr_dst_x && sy >= scr_dst_y && sw > 0 && sh > 0);
}

static void test_round3_vulkan_d3d9_subnative_viewport_and_cursor(void)
{
    /* L2: Sub-native 32-bit WineD3D Vulkan D3D9 1024x768 -> 3024x1964 across all 3 aspect modes */
    ds_viewport_t vp_preserve, vp_stretch, vp_integer;
    ASSERT_TRUE(ds_compute_viewport(3024, 1964, 0, 1024, 768, DS_ASPECT_PRESERVE, &vp_preserve));
    ASSERT_TRUE(vp_preserve.dst_w == 2620 && vp_preserve.dst_h == 1964);
    ASSERT_TRUE(vp_preserve.dst_x == 202 && vp_preserve.dst_y == 0);
    ASSERT_TRUE((vp_preserve.dst_w % 2) == 0 && (vp_preserve.dst_h % 2) == 0);

    ASSERT_TRUE(ds_compute_viewport(3024, 1964, 0, 1024, 768, DS_ASPECT_STRETCH, &vp_stretch));
    ASSERT_TRUE(vp_stretch.dst_w == 3024 && vp_stretch.dst_h == 1964);
    ASSERT_TRUE(vp_stretch.dst_x == 0 && vp_stretch.dst_y == 0);

    ASSERT_TRUE(ds_compute_viewport(3024, 1964, 0, 1024, 768, DS_ASPECT_INTEGER, &vp_integer));
    ASSERT_TRUE(vp_integer.dst_w == 2048 && vp_integer.dst_h == 1536);
    ASSERT_TRUE(vp_integer.dst_x == 488 && vp_integer.dst_y == 214);

    /* Exact pixel-center cursor round-trip across all 3 sub-native Vulkan D3D9 aspect viewports */
    const ds_viewport_t vps[3] = { vp_preserve, vp_stretch, vp_integer };
    for (int m = 0; m < 3; m++) {
        for (int32_t vx = 0; vx < 1024; vx += 31) {
            for (int32_t vy = 0; vy < 768; vy += 29) {
                int32_t px = 0, py = 0, rvx = -1, rvy = -1;
                ASSERT_TRUE(ds_map_cursor_virt_to_phys(
                    vx, vy, vps[m].dst_x, vps[m].dst_y, vps[m].dst_w, vps[m].dst_h, 1024, 768, &px, &py
                ));
                ASSERT_TRUE(px >= vps[m].dst_x && px < vps[m].dst_x + vps[m].dst_w);
                ASSERT_TRUE(py >= vps[m].dst_y && py < vps[m].dst_y + vps[m].dst_h);
                ASSERT_TRUE(ds_map_cursor_phys_to_virt(
                    px, py, vps[m].dst_x, vps[m].dst_y, vps[m].dst_w, vps[m].dst_h, 1024, 768, &rvx, &rvy
                ));
                ASSERT_TRUE(rvx == vx && rvy == vy);
            }
        }
    }

    /* Pillarbox margin clamping (left & right black bars clamp cleanly to virtual x=0 and x=1023) */
    int32_t cx0 = -1, cy0 = -1, cx1 = -1, cy1 = -1;
    ASSERT_TRUE(ds_map_cursor_phys_to_virt(
        10, 500, vp_preserve.dst_x, vp_preserve.dst_y, vp_preserve.dst_w, vp_preserve.dst_h, 1024, 768, &cx0, &cy0
    ));
    ASSERT_TRUE(cx0 == 0 && cy0 >= 0 && cy0 < 768);
    ASSERT_TRUE(ds_map_cursor_phys_to_virt(
        3020, 500, vp_preserve.dst_x, vp_preserve.dst_y, vp_preserve.dst_w, vp_preserve.dst_h, 1024, 768, &cx1, &cy1
    ));
    ASSERT_TRUE(cx1 == 1023 && cy1 == cy0);

    /* Tier 2 stays active for 32-bit Vulkan D3D9 across fullscreen & user_forced_windowed exit */
    ds_tier_input_t in;
    memset(&in, 0, sizeof(in));
    in.scaling_mode = DS_MODE_AUTO_FULLSCREEN;
    in.d3d9_loaded = true;
    in.d3d8_or_9_loaded = true;
    in.legacy_d3d_loaded = true;
    in.vulkan_loaded = true;
    in.wined3d_uses_vulkan = true;
    in.fullscreen_active = true;
    ASSERT_TRUE(ds_is_vulkan_legacy_d3d(&in));
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_MODERN_BORDERLESS);
    /* Sub-native vs native predicate distinction */
    int32_t virt_w = 1024, virt_h = 768, screen_w = 3024, screen_h = 1964;
    ASSERT_TRUE(ds_is_vulkan_legacy_d3d(&in) && in.fullscreen_active && (virt_w < screen_w || virt_h < screen_h));
    virt_w = 3024; virt_h = 1964;
    ASSERT_TRUE(!(virt_w < screen_w || virt_h < screen_h));
    /* Windowed exit keeps Tier 2 reachable so ds_apply_window_presentation restores windowed bounds */
    in.fullscreen_active = false;
    in.borderless_active = true;
    in.user_forced_windowed = true;
    ASSERT_TRUE(ds_compute_presenter_tier(&in) == DS_PRESENTER_MODERN_BORDERLESS);
}

static void test_round4_gl_ctx_isolation_map(void)
{
    /* R2-L1 (1C): Per-HGLRC isolation map prevents hidden wined3d probes from poisoning native GL */
    ds_gl_ctx_entry_t slots[DS_MAX_GL_CTX_MAP];
    memset(slots, 0, sizeof(slots));

    /* NULL / empty / unknown queries safely return -1 */
    ASSERT_TRUE(ds_gl_ctx_map_op(NULL, DS_MAX_GL_CTX_MAP, 0x1001u, 0) == -1);
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, 0u, 0x1001u, 0) == -1);
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0u, 0) == -1);
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x1001u, 0) == -1);

    /* Record native game context + two hidden wined3d probe contexts */
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x1001u, 1) == 0);
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x2001u, 2) == 1);
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x2002u, 2) == 1);

    /* Lookups remain cleanly isolated */
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x1001u, 0) == 0);
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x2001u, 0) == 1);
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x2002u, 0) == 1);

    /* Delete probe context and verify slot reuse */
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x2001u, -1) == 0);
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x2001u, 0) == -1);
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x2001u, -1) == -1);

    /* Flood remaining slots with wined3d probes -> inserting a 2nd native ctx must evict a probe, never native 0x1001 */
    for (uintptr_t k = 0x3000u; k < 0x3000u + 20u; k++) {
        ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, k, 2) == 1);
    }
    /* Re-insert native ctx 0x1001 + 15 probes, then insert native ctx 0x1002 */
    memset(slots, 0, sizeof(slots));
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x1001u, 1) == 0);
    for (size_t i = 0; i < DS_MAX_GL_CTX_MAP - 1u; i++) {
        ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, (uintptr_t)(0x4000u + i), 2) == 1);
    }
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x1002u, 1) == 0);
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x1001u, 0) == 0);
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x1002u, 0) == 0);

    /* Overflow full native table (17 inserts) -> oldest evicted cleanly without ASan/UB errors */
    memset(slots, 0, sizeof(slots));
    for (size_t i = 0; i < DS_MAX_GL_CTX_MAP + 2u; i++) {
        ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, (uintptr_t)(0x5000u + i), 1) == 0);
    }
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, 0x5000u, 0) == -1);
    ASSERT_TRUE(ds_gl_ctx_map_op(slots, DS_MAX_GL_CTX_MAP, (uintptr_t)(0x5000u + DS_MAX_GL_CTX_MAP + 1u), 0) == 0);
}

static void test_round4_subnative_exclusive_fullscreen_predicate(void)
{
    /* R2-L2: Exhaustive matrix for Tier 1 64-bit sub-native exclusive-fullscreen geometry guard */
    const uint32_t k_popup_vis = 0x80000000u | 0x10000000u; /* WS_POPUP | WS_VISIBLE */
    const uint32_t k_child = 0x40000000u;
    const uint32_t k_caption = 0x00C00000u;
    const uint32_t k_thickframe = 0x00040000u;
    const uint32_t k_dlgframe = 0x00400000u;
    const uint32_t k_border = 0x00800000u;
    const uint32_t k_topmost = 0x00000008u;
    const uint32_t k_toolwindow = 0x00000080u;

    /* Positive cases */
    /* 1. 1920x1080 at (0, 0) on 3024x1964, borderless + WS_EX_TOPMOST */
    ASSERT_TRUE(ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis, k_topmost, false, true, false, false));
    /* 2. 1920x1080 at (0, 66) (2x Retina Cocoa menu bar clamp) on 3024x1964 */
    ASSERT_TRUE(ds_is_subnative_exclusive_fullscreen_window(
        0, 66, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis, k_topmost, false, true, false, false));
    /* 3. Pre-exstyle WM_WINDOWPOSCHANGING with is_topmost_target=true */
    ASSERT_TRUE(ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis, 0u, true, true, false, false));
    /* 4. 1280x720 virtualized at 640x360 (96 DPI 2x) at (0, 33) on 1512x982 */
    ASSERT_TRUE(ds_is_subnative_exclusive_fullscreen_window(
        0, 33, 640, 360, 0, 0, 1512, 982, k_popup_vis, k_topmost, false, true, false, false));
    /* 5. External monitor negative origin (-1920, 0, 1920, 1080) with 1280x720 at (-1920, 24) */
    ASSERT_TRUE(ds_is_subnative_exclusive_fullscreen_window(
        -1920, 24, 1280, 720, -1920, 0, 1920, 1080, k_popup_vis, k_topmost, false, true, false, false));

    /* Negative cases (must NEVER hijack native FS, windowed exits, splashes, dialogs, or tool windows) */
    /* 6. Native 3024x1964 on 3024x1964 */
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 3024, 1964, 0, 0, 3024, 1964, k_popup_vis, k_topmost, false, true, false, false));
    /* 7. External 1080p monitor running native 1920x1080 */
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 1920, 1080, 0, 0, 1920, 1080, k_popup_vis, k_topmost, false, true, false, false));
    /* 8. Windowed exits (WS_CAPTION / WS_THICKFRAME / WS_DLGFRAME / WS_BORDER / WS_CHILD) */
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis | k_caption, k_topmost, false, true, false, false));
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis | k_thickframe, k_topmost, false, true, false, false));
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis | k_dlgframe, k_topmost, false, true, false, false));
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis | k_border, k_topmost, false, true, false, false));
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis | k_child, k_topmost, false, true, false, false));
    /* 9. Neither WS_EX_TOPMOST nor is_topmost_target */
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis, 0u, false, true, false, false));
    /* 10. Centered splash (800x450 at (1112, 757)) */
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        1112, 757, 800, 450, 0, 0, 3024, 1964, k_popup_vis, k_topmost, false, true, false, false));
    /* 11. Dialog (#32770), toolwindow, hidden, minimized, tiny (< 640x360), out-of-range anchor */
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis, k_topmost, false, true, false, true));
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis, k_topmost | k_toolwindow, false, true, false, false));
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis, k_topmost, false, false, false, false));
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis, k_topmost, false, true, true, false));
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 639, 360, 0, 0, 3024, 1964, k_popup_vis, k_topmost, false, true, false, false));
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 0, 640, 359, 0, 0, 3024, 1964, k_popup_vis, k_topmost, false, true, false, false));
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        0, 129, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis, k_topmost, false, true, false, false));
    ASSERT_TRUE(!ds_is_subnative_exclusive_fullscreen_window(
        9, 0, 1920, 1080, 0, 0, 3024, 1964, k_popup_vis, k_topmost, false, true, false, false));
}

static void test_round4_live_backing_clamp(void)
{
    /* L4(b): Live client-rect backing clamp eliminates mid-transition 4x top-left crop */
    /* 1. Retina PMv2 mid-transition (window still 1280x960 before expanding to 3024x1964) */
    int32_t bw = 3024, bh = 1964;
    ds_clamp_live_backing_dims(1280, 960, 640, 480, 3024, 1964, 3024, 1964, &bw, &bh);
    ASSERT_TRUE(bw == 1280 && bh == 960);
    ds_viewport_t vp;
    ASSERT_TRUE(ds_compute_viewport(bw, bh, 0, 640, 480, DS_ASPECT_PRESERVE, &vp));
    ASSERT_TRUE(vp.dst_x == 0 && vp.dst_y == 0 && vp.dst_w == 1280 && vp.dst_h == 960);

    /* 2. Steady-state fullscreen (3024x1964) remains untouched */
    bw = 3024; bh = 1964;
    ds_clamp_live_backing_dims(3024, 1964, 640, 480, 3024, 1964, 3024, 1964, &bw, &bh);
    ASSERT_TRUE(bw == 3024 && bh == 1964);

    /* 3. 96-DPI HWND on 2x Retina (live 640x480 logical on 1512x982 -> 1280x960 physical) */
    bw = 3024; bh = 1964;
    ds_clamp_live_backing_dims(640, 480, 640, 480, 1512, 982, 3024, 1964, &bw, &bh);
    ASSERT_TRUE(bw == 1280 && bh == 960);

    /* 4. Live rect smaller than virtual resolution leaves backing untouched */
    bw = 3024; bh = 1964;
    ds_clamp_live_backing_dims(320, 240, 640, 480, 3024, 1964, 3024, 1964, &bw, &bh);
    ASSERT_TRUE(bw == 3024 && bh == 1964);
}

static void write_u16_le(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v & 0xFFu);
    p[1] = (uint8_t)((v >> 8) & 0xFFu);
}

static void write_u32_le(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v & 0xFFu);
    p[1] = (uint8_t)((v >> 8) & 0xFFu);
    p[2] = (uint8_t)((v >> 16) & 0xFFu);
    p[3] = (uint8_t)((v >> 24) & 0xFFu);
}

static uint8_t *build_synthetic_pe_export_image(
    bool        is_pe64,
    const char *exp_name,
    uint32_t    exp_fn_rva,
    bool        omit_name_nul,
    size_t     *out_size
)
{
    /* Layout:
     *   0x000..0x07F : DOS header (`e_lfanew = 0x80`)
     *   0x080..0x097 : PE sig + COFF header (`nsec = 1`, `opt_sz = 0xE0` PE32 or `0xF0` PE32+)
     *   0x098..      : Optional header (export dir at RVA 0x2000, size 0x100)
     *   sec_off      : 1 section `.edata` (VA=0x2000, VS=0x200, RawOff=0x200, RawSize=exact)
     *   0x200..      : IMAGE_EXPORT_DIRECTORY (40 B) + funcs[1] (4 B) + names[1] (4 B) + ords[1] (2 B) + name bytes
     */
    const size_t pe_off = 0x80u;
    const uint16_t opt_sz = is_pe64 ? 0xF0u : 0xE0u;
    const size_t opt_off = pe_off + 24u;
    const size_t sec_off = opt_off + (size_t)opt_sz;
    const size_t raw_off = 0x200u;
    const size_t name_rel = 40u + 4u + 4u + 2u; /* 50 B */
    const size_t name_len = strlen(exp_name);
    const size_t name_bytes = omit_name_nul ? name_len : (name_len + 1u);
    const size_t raw_sz = name_rel + name_bytes;
    const size_t total_sz = raw_off + raw_sz;

    uint8_t *buf = (uint8_t *)calloc(1u, total_sz);
    ASSERT_TRUE(buf != NULL);

    buf[0] = 'M';
    buf[1] = 'Z';
    write_u32_le(buf + 0x3cu, (uint32_t)pe_off);

    memcpy(buf + pe_off, "PE\0\0", 4u);
    write_u16_le(buf + pe_off + 6u, 1u); /* NumberOfSections */
    write_u16_le(buf + pe_off + 20u, opt_sz); /* SizeOfOptionalHeader */

    write_u16_le(buf + opt_off, is_pe64 ? 0x020bu : 0x010bu);
    const size_t num_rva_rel = is_pe64 ? 108u : 92u;
    const size_t dd_rel = is_pe64 ? 112u : 96u;
    write_u32_le(buf + opt_off + num_rva_rel, 16u); /* NumberOfRvaAndSizes */
    write_u32_le(buf + opt_off + dd_rel, 0x2000u);  /* Export RVA */
    write_u32_le(buf + opt_off + dd_rel + 4u, (uint32_t)raw_sz); /* Export Size */

    /* Section `.edata` */
    memcpy(buf + sec_off, ".edata\0\0", 8u);
    write_u32_le(buf + sec_off + 8u, (uint32_t)raw_sz);  /* VirtualSize */
    write_u32_le(buf + sec_off + 12u, 0x2000u);          /* VirtualAddress */
    write_u32_le(buf + sec_off + 16u, (uint32_t)raw_sz); /* SizeOfRawData */
    write_u32_le(buf + sec_off + 20u, (uint32_t)raw_off);/* PointerToRawData */

    /* IMAGE_EXPORT_DIRECTORY at raw_off (RVA 0x2000) */
    write_u32_le(buf + raw_off + 20u, 1u);               /* NumberOfFunctions */
    write_u32_le(buf + raw_off + 24u, 1u);               /* NumberOfNames */
    write_u32_le(buf + raw_off + 28u, 0x2000u + 40u);    /* AddressOfFunctions */
    write_u32_le(buf + raw_off + 32u, 0x2000u + 44u);    /* AddressOfNames */
    write_u32_le(buf + raw_off + 36u, 0x2000u + 48u);    /* AddressOfNameOrdinals */

    write_u32_le(buf + raw_off + 40u, exp_fn_rva);
    write_u32_le(buf + raw_off + 44u, 0x2000u + (uint32_t)name_rel);
    write_u16_le(buf + raw_off + 48u, 0u);
    memcpy(buf + raw_off + name_rel, exp_name, name_len);
    if (!omit_name_nul) {
        buf[raw_off + name_rel + name_len] = '\0';
    }

    *out_size = total_sz;
    return buf;
}

static void test_r4_pe_export_bounds_and_fuzz(void)
{
    /* DS-06: Overflow-safe PE32 / PE32+ export lookup + adversarial OOB / wraparound rejection */
    const char *k_trigger = "OneLauncherDisplayScalerTriggerScan";

    /* 1. Valid PE32 (0x010b) and PE32+ (0x020b) exact-sized heap images */
    size_t sz32 = 0u;
    uint8_t *pe32 = build_synthetic_pe_export_image(false, k_trigger, 0x1234u, false, &sz32);
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(pe32, sz32, k_trigger) == 0x1234u);
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(pe32, sz32, "MissingExport") == 0u);
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(pe32, sz32, "") == 0u);
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(pe32, sz32, NULL) == 0u);

    size_t sz64 = 0u;
    uint8_t *pe64 = build_synthetic_pe_export_image(true, k_trigger, 0x2468u, false, &sz64);
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(pe64, sz64, k_trigger) == 0x2468u);

    /* 2. Truncated buffers (< 64 B and every byte-length prefix up to sz32 - 1) must NEVER read OOB */
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(NULL, 1024u, k_trigger) == 0u);
    for (size_t trunc = 0u; trunc < sz32; trunc++) {
        uint8_t *sub = (trunc > 0u) ? (uint8_t *)malloc(trunc) : NULL;
        if (trunc > 0u) {
            ASSERT_TRUE(sub != NULL);
            memcpy(sub, pe32, trunc);
        }
        /* Truncated image must either return 0 (incomplete) or never fault under ASan */
        ASSERT_TRUE(ds_find_pe_export_rva_in_buf(sub, trunc, k_trigger) == 0u);
        free(sub);
    }

    /* 3. Non-NUL-terminated export name at exact end of heap buffer (guards 1-byte over-read!) */
    size_t sz_nonul = 0u;
    uint8_t *pe_nonul = build_synthetic_pe_export_image(false, k_trigger, 0x1234u, true, &sz_nonul);
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(pe_nonul, sz_nonul, k_trigger) == 0u);
    free(pe_nonul);

    /* 4. Forwarded export (fn_rva points inside [exp_rva, exp_rva + exp_sz)) must be rejected */
    size_t sz_fwd = 0u;
    uint8_t *pe_fwd = build_synthetic_pe_export_image(true, k_trigger, 0x2010u, false, &sz_fwd);
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(pe_fwd, sz_fwd, k_trigger) == 0u);
    free(pe_fwd);

    /* 5. Corrupt e_lfanew wraparound (0xFFFFFFF0u) & sub-DOS offset (32) */
    uint8_t *corrupt = (uint8_t *)malloc(sz32);
    ASSERT_TRUE(corrupt != NULL);
    memcpy(corrupt, pe32, sz32);
    write_u32_le(corrupt + 0x3cu, 0xFFFFFFF0u);
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(corrupt, sz32, k_trigger) == 0u);
    write_u32_le(corrupt + 0x3cu, 32u);
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(corrupt, sz32, k_trigger) == 0u);

    /* 6. Bad optional magic, NumberOfRvaAndSizes = 0, and nsec = 0xFFFFu overflow */
    memcpy(corrupt, pe32, sz32);
    write_u16_le(corrupt + 0x98u, 0x0107u);
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(corrupt, sz32, k_trigger) == 0u);

    memcpy(corrupt, pe32, sz32);
    write_u32_le(corrupt + 0x98u + 92u, 0u);
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(corrupt, sz32, k_trigger) == 0u);

    memcpy(corrupt, pe32, sz32);
    write_u16_le(corrupt + 0x80u + 6u, 0xFFFFu);
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(corrupt, sz32, k_trigger) == 0u);

    /* 7. Section PointerToRawData + SizeOfRawData uint32 wraparound */
    memcpy(corrupt, pe32, sz32);
    write_u32_le(corrupt + 0x80u + 24u + 0xE0u + 16u, 0x00000100u);
    write_u32_le(corrupt + 0x80u + 24u + 0xE0u + 20u, 0xFFFFFFF0u);
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(corrupt, sz32, k_trigger) == 0u);

    /* 8. NumberOfNames = 0x40000001u (* 4 overflow) and OOB ordinal index >= NumberOfFunctions */
    memcpy(corrupt, pe32, sz32);
    write_u32_le(corrupt + 0x200u + 24u, 0x40000001u);
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(corrupt, sz32, k_trigger) == 0u);

    memcpy(corrupt, pe32, sz32);
    write_u16_le(corrupt + 0x200u + 48u, 99u); /* ord_idx = 99 >= num_funcs (1) */
    ASSERT_TRUE(ds_find_pe_export_rva_in_buf(corrupt, sz32, k_trigger) == 0u);

    free(corrupt);
    free(pe32);
    free(pe64);
}

static void test_r4_lru_dc_map_eviction(void)
{
    /* DS-03: LRU dc_map slot selection + active bound GL DC eviction protection */
    ds_gl_dc_entry_t slots[DS_MAX_GL_DC_MAP];
    memset(slots, 0, sizeof(slots));

    const uintptr_t host_a = 0xAA01u;
    const uintptr_t host_stale = 0xBB02u;

    /* NULL / empty guards */
    ASSERT_TRUE(ds_gl_dc_map_select_slot(NULL, DS_MAX_GL_DC_MAP, 0x1u, host_a, 0u) == 0u);
    ASSERT_TRUE(ds_gl_dc_map_select_slot(slots, 0u, 0x1u, host_a, 0u) == 0u);
    ASSERT_TRUE(ds_gl_dc_map_select_slot(slots, DS_MAX_GL_DC_MAP, 0x100u, host_a, 0u) == 0u);

    /* Partial table selects first empty slot */
    slots[0].game_hdc = 0x100u;
    slots[0].host_hdc = 0x200u;
    slots[0].host_hwnd = host_a;
    slots[0].last_used_gen = 1u;
    ASSERT_TRUE(ds_gl_dc_map_select_slot(slots, DS_MAX_GL_DC_MAP, 0x101u, host_a, 0x200u) == 1u);
    /* Exact existing match returns its existing slot */
    ASSERT_TRUE(ds_gl_dc_map_select_slot(slots, DS_MAX_GL_DC_MAP, 0x100u, host_a, 0x200u) == 0u);

    /* Fill all 16 slots with ascending last_used_gen = 1..16; protect slot 0 (oldest!) */
    for (size_t i = 0u; i < DS_MAX_GL_DC_MAP; i++) {
        slots[i].game_hdc = (uintptr_t)(0x1000u + i);
        slots[i].host_hdc = (uintptr_t)(0x2000u + i);
        slots[i].host_hwnd = host_a;
        slots[i].last_used_gen = (uint32_t)(i + 1u);
    }
    /* Slot 0 is protected (bound GL DC) -> MUST evict slot 1 (next-oldest unprotected), NEVER slot 0 */
    ASSERT_TRUE(ds_gl_dc_map_select_slot(slots, DS_MAX_GL_DC_MAP, 0x9999u, host_a, 0x2000u) == 1u);

    /* Bump slot 1's generation above all others -> slot 2 becomes oldest unprotected */
    slots[1].last_used_gen = 100u;
    ASSERT_TRUE(ds_gl_dc_map_select_slot(slots, DS_MAX_GL_DC_MAP, 0x9999u, host_a, 0x2000u) == 2u);

    /* Stale host_hwnd entry (slot 7, even with newest gen=999) is evicted BEFORE any live entry */
    slots[7].host_hwnd = host_stale;
    slots[7].last_used_gen = 999u;
    ASSERT_TRUE(ds_gl_dc_map_select_slot(slots, DS_MAX_GL_DC_MAP, 0x9999u, host_a, 0x2000u) == 7u);

    /* Unless stale slot 7 is itself the protected bound GL DC -> falls back to oldest unprotected (slot 0) */
    ASSERT_TRUE(ds_gl_dc_map_select_slot(slots, DS_MAX_GL_DC_MAP, 0x9999u, host_a, slots[7].host_hdc) == 0u);

    /* Degenerate fallback: all entries share protected_host_hdc -> picks lru_any safely in bounds */
    for (size_t i = 0u; i < DS_MAX_GL_DC_MAP; i++) {
        slots[i].host_hdc = 0x7777u;
        slots[i].host_hwnd = host_a;
        slots[i].last_used_gen = (uint32_t)(50u - i);
    }
    ASSERT_TRUE(ds_gl_dc_map_select_slot(slots, DS_MAX_GL_DC_MAP, 0x9999u, host_a, 0x7777u) == DS_MAX_GL_DC_MAP - 1u);
}

static void test_r4_ini_2048_deep_paths(void)
{
    /* DS-05: 2048 B INI buffer preserves trailing keys after deep macOS Wine prefix paths */
    ASSERT_TRUE(DS_INI_BUF_BYTES == 2048u);

    char deep_ctl[440];
    char deep_status[440];
    memset(deep_ctl, 0, sizeof(deep_ctl));
    memset(deep_status, 0, sizeof(deep_status));
    const char *prefix = "Z:\\Users\\testuser\\Library\\Application Support\\OneLauncher\\bottles\\deep_nested_prefix\\drive_c\\users\\Public\\OneLauncher\\";
    snprintf(deep_ctl, sizeof(deep_ctl), "%s", prefix);
    snprintf(deep_status, sizeof(deep_status), "%s", prefix);
    while (strlen(deep_ctl) < 395u) {
        strncat(deep_ctl, "sub_segment_dir\\", sizeof(deep_ctl) - strlen(deep_ctl) - 1u);
    }
    strncat(deep_ctl, "display_control.ini", sizeof(deep_ctl) - strlen(deep_ctl) - 1u);
    while (strlen(deep_status) < 395u) {
        strncat(deep_status, "sub_segment_dir\\", sizeof(deep_status) - strlen(deep_status) - 1u);
    }
    strncat(deep_status, "display_status.json", sizeof(deep_status) - strlen(deep_status) - 1u);

    char payload[DS_INI_BUF_BYTES];
    memset(payload, 0, sizeof(payload));
    int pos = 0;
    for (int i = 0; i < 12; i++) {
        int n = snprintf(payload + pos, sizeof(payload) - (size_t)pos,
                         "# round4 padded header comment line %02d for 2048 byte INI boundary test\r\n", i);
        ASSERT_TRUE(n > 0 && (size_t)(pos + n) < sizeof(payload));
        pos += n;
    }
    int tail = snprintf(
        payload + pos,
        sizeof(payload) - (size_t)pos,
        "control_file=%s\r\n"
        "status_file=%s\r\n"
        "seq=99\r\n"
        "fullscreen=1\r\n"
        "aspect=integer\r\n"
        "filter=nearest\r\n"
        "mode=force_fullscreen\r\n"
        "safe_inset_top=74\r\n"
        "hotkey=1\r\n"
        "user_override=1\r\n"
        "updated_unix_ms=1763000000123\r\n",
        deep_ctl,
        deep_status
    );
    ASSERT_TRUE(tail > 0);
    size_t total_len = (size_t)(pos + tail);
    /* Must exceed previous 1024/1536 B limits and stay strictly inside DS_INI_BUF_BYTES */
    ASSERT_TRUE(total_len > 1600u && total_len < DS_INI_BUF_BYTES);

    /* Exact heap-sized non-NUL-terminated copy so ASan detects any 1-byte over-read */
    char *exact_buf = (char *)malloc(total_len);
    ASSERT_TRUE(exact_buf != NULL);
    memcpy(exact_buf, payload, total_len);

    ds_control_state_t st;
    ASSERT_TRUE(ds_parse_control_ini(exact_buf, total_len, &st));
    ASSERT_TRUE(st.has_control_file && strcmp(st.control_file, deep_ctl) == 0);
    ASSERT_TRUE(st.has_status_file && strcmp(st.status_file, deep_status) == 0);
    ASSERT_TRUE(st.has_seq && st.seq == 99ULL);
    ASSERT_TRUE(st.has_fullscreen && st.fullscreen == true);
    ASSERT_TRUE(st.has_aspect && st.aspect == DS_ASPECT_INTEGER);
    ASSERT_TRUE(st.has_filter && st.filter == DS_FILTER_NEAREST);
    ASSERT_TRUE(st.has_scaling_mode && st.scaling_mode == DS_MODE_FORCE_FULLSCREEN);
    ASSERT_TRUE(st.has_safe_inset_top && st.safe_inset_top == 74);
    ASSERT_TRUE(st.has_hotkey && st.hotkey == true);
    ASSERT_TRUE(st.has_user_override && st.user_override == true);
    ASSERT_TRUE(st.has_updated_unix_ms && st.updated_unix_ms == 1763000000123ULL);
    free(exact_buf);

    /* Overlong path (>= 520 B) must be safely rejected without buffer overflow */
    char overlong[600];
    memcpy(overlong, "control_file=", 13u);
    memset(overlong + 13u, 'A', 540u);
    memcpy(overlong + 553u, "\nseq=3\n", 7u);
    ASSERT_TRUE(ds_parse_control_ini(overlong, 560u, &st));
    ASSERT_TRUE(!st.has_control_file);
    ASSERT_TRUE(st.has_seq && st.seq == 3ULL);
}

static void test_r4_wow64_rawinput_alignment(void)
{
    /* DS-07: WoW64 vs native x86 vs x64 RAWINPUT header offset & QWORD stride validation */
    ds_rawinput_step_t step;

    /* 1. Native 32-bit (DWORD 4-byte aligned, 16-byte header) */
    ASSERT_TRUE(ds_rawinput_validate_block(36u, 16u, 64u, false, false, &step));
    ASSERT_TRUE(step.mouse_offset == 16u && step.next_step == 36u);
    ASSERT_TRUE(ds_rawinput_validate_block(34u, 0u, 64u, false, false, &step));
    ASSERT_TRUE(step.mouse_offset == 16u && step.next_step == 36u);

    /* 2. 32-bit under 64-bit Wine/WoW64 (QWORD 8-byte aligned!) */
    ASSERT_TRUE(ds_rawinput_validate_block(36u, 16u, 64u, true, false, &step));
    ASSERT_TRUE(step.mouse_offset == 16u && step.next_step == 40u);
    ASSERT_TRUE(ds_rawinput_validate_block(40u, 16u, 64u, true, false, &step));
    ASSERT_TRUE(step.mouse_offset == 16u && step.next_step == 40u);
    ASSERT_TRUE(ds_rawinput_validate_block(48u, 24u, 64u, true, false, &step));
    ASSERT_TRUE(step.mouse_offset == 24u && step.next_step == 48u);

    /* 3. Native 64-bit (QWORD 8-byte aligned, 24-byte header default) */
    ASSERT_TRUE(ds_rawinput_validate_block(48u, 24u, 96u, false, true, &step));
    ASSERT_TRUE(step.mouse_offset == 24u && step.next_step == 48u);
    ASSERT_TRUE(ds_rawinput_validate_block(44u, 0u, 96u, false, true, &step));
    ASSERT_TRUE(step.mouse_offset == 24u && step.next_step == 48u);

    /* 4. Multi-packet WoW64 buffer walk (two 36 B packets spaced at 40 B QWORD boundaries) */
    size_t offset = 0u;
    const size_t buf_bytes = 80u;
    int packets = 0;
    while (offset < buf_bytes) {
        ASSERT_TRUE(ds_rawinput_validate_block(36u, 16u, buf_bytes - offset, true, false, &step));
        ASSERT_TRUE(step.mouse_offset == 16u && step.next_step == 40u);
        offset += step.next_step;
        packets++;
    }
    ASSERT_TRUE(packets == 2 && offset == 80u);

    /* 5. Malformed header sizes, truncated packets, and zero/huge dwSize rejected cleanly */
    ASSERT_TRUE(!ds_rawinput_validate_block(36u, 12u, 64u, true, false, &step));
    ASSERT_TRUE(!ds_rawinput_validate_block(36u, 20u, 64u, true, false, &step));
    ASSERT_TRUE(!ds_rawinput_validate_block(36u, 32u, 64u, false, true, &step));
    ASSERT_TRUE(!ds_rawinput_validate_block(15u, 16u, 64u, true, false, &step));
    ASSERT_TRUE(!ds_rawinput_validate_block(23u, 24u, 64u, false, true, &step));
    ASSERT_TRUE(!ds_rawinput_validate_block(48u, 24u, 47u, false, true, &step));
    ASSERT_TRUE(!ds_rawinput_validate_block(0u, 16u, 64u, false, false, &step));
    ASSERT_TRUE(!ds_rawinput_validate_block(0xFFFFFFFFu, 16u, 4096u, true, false, &step));
}

static void test_r4_per_hglrc_fbo_lifecycle(void)
{
    /* DS-01: Per-HGLRC FBO/texture/RB ownership, switch preservation, delete & LRU eviction */
    ds_gl_ctx_fbo_slot_t slots[DS_MAX_GL_CTX_MAP];
    memset(slots, 0, sizeof(slots));
    uint32_t gen = 0u;
    ds_gl_ctx_fbo_slot_t evicted, removed;

    /* NULL / zero guards */
    ASSERT_TRUE(ds_gl_ctx_fbo_acquire(NULL, DS_MAX_GL_CTX_MAP, 0xA001u, true, &gen, &evicted) == NULL);
    ASSERT_TRUE(ds_gl_ctx_fbo_acquire(slots, 0u, 0xA001u, true, &gen, &evicted) == NULL);
    ASSERT_TRUE(ds_gl_ctx_fbo_acquire(slots, DS_MAX_GL_CTX_MAP, 0u, true, &gen, &evicted) == NULL);
    ASSERT_TRUE(!ds_gl_ctx_fbo_remove(slots, DS_MAX_GL_CTX_MAP, 0xA001u, &removed));

    /* Create ctx1 & ctx2 with distinct GL objects */
    ds_gl_ctx_fbo_slot_t *s1 = ds_gl_ctx_fbo_acquire(slots, DS_MAX_GL_CTX_MAP, 0xA001u, true, &gen, &evicted);
    ASSERT_TRUE(s1 != NULL && evicted.ctx_key == 0u);
    s1->game.fbo_id = 11u;
    s1->game.color_tex = 12u;
    s1->game.depth_rb = 13u;
    s1->game.w = 640;
    s1->game.h = 480;
    s1->sharp.fbo_id = 14u;
    s1->sharp.tex_id = 15u;
    s1->w3d.fbo_id = 16u;
    s1->w3d.tex_id = 17u;

    ds_gl_ctx_fbo_slot_t *s2 = ds_gl_ctx_fbo_acquire(slots, DS_MAX_GL_CTX_MAP, 0xA002u, true, &gen, &evicted);
    ASSERT_TRUE(s2 != NULL && s2 != s1 && evicted.ctx_key == 0u);
    s2->game.fbo_id = 21u;
    s2->game.color_tex = 22u;
    s2->game.depth_rb = 23u;
    uint32_t s2_gen = s2->last_used_gen;

    /* Context switch back to ctx1 preserves exact FBO handles & advances LRU generation */
    ds_gl_ctx_fbo_slot_t *s1_again = ds_gl_ctx_fbo_acquire(slots, DS_MAX_GL_CTX_MAP, 0xA001u, false, &gen, &evicted);
    ASSERT_TRUE(s1_again == s1);
    ASSERT_TRUE(s1_again->game.fbo_id == 11u && s1_again->game.color_tex == 12u && s1_again->game.depth_rb == 13u);
    ASSERT_TRUE(s1_again->sharp.fbo_id == 14u && s1_again->w3d.fbo_id == 16u);
    ASSERT_TRUE(s1_again->last_used_gen > s2_gen);
    ASSERT_TRUE(ds_gl_ctx_fbo_acquire(slots, DS_MAX_GL_CTX_MAP, 0xA099u, false, &gen, NULL) == NULL);

    /* Delete ctx1 -> returns exact handles for glDeleteFramebuffers/Textures/Renderbuffers & clears slot */
    ASSERT_TRUE(ds_gl_ctx_fbo_remove(slots, DS_MAX_GL_CTX_MAP, 0xA001u, &removed));
    ASSERT_TRUE(removed.ctx_key == 0xA001u && removed.game.fbo_id == 11u && removed.sharp.fbo_id == 14u && removed.w3d.fbo_id == 16u);
    ASSERT_TRUE(!ds_gl_ctx_fbo_remove(slots, DS_MAX_GL_CTX_MAP, 0xA001u, &removed));
    ASSERT_TRUE(ds_gl_ctx_fbo_acquire(slots, DS_MAX_GL_CTX_MAP, 0xA001u, false, &gen, NULL) == NULL);

    /* Saturate all 16 slots, touch slot 0 (0xB000), insert 17th -> LRU slot 1 (0xB001) is evicted, NOT slot 0 */
    memset(slots, 0, sizeof(slots));
    gen = 0u;
    for (size_t i = 0u; i < DS_MAX_GL_CTX_MAP; i++) {
        ds_gl_ctx_fbo_slot_t *s = ds_gl_ctx_fbo_acquire(slots, DS_MAX_GL_CTX_MAP, (uintptr_t)(0xB000u + i), true, &gen, &evicted);
        ASSERT_TRUE(s != NULL && evicted.ctx_key == 0u);
        s->game.fbo_id = (uint32_t)(100u + i);
    }
    ASSERT_TRUE(ds_gl_ctx_fbo_acquire(slots, DS_MAX_GL_CTX_MAP, 0xB000u, false, &gen, NULL) != NULL);

    ds_gl_ctx_fbo_slot_t *s17 = ds_gl_ctx_fbo_acquire(slots, DS_MAX_GL_CTX_MAP, 0xB010u, true, &gen, &evicted);
    ASSERT_TRUE(s17 != NULL && s17->ctx_key == 0xB010u && s17->game.fbo_id == 0u);
    ASSERT_TRUE(evicted.ctx_key == 0xB001u && evicted.game.fbo_id == 101u);
    ASSERT_TRUE(ds_gl_ctx_fbo_acquire(slots, DS_MAX_GL_CTX_MAP, 0xB000u, false, &gen, NULL) != NULL);
    ASSERT_TRUE(ds_gl_ctx_fbo_acquire(slots, DS_MAX_GL_CTX_MAP, 0xB001u, false, &gen, NULL) == NULL);
}

static void test_r4_vulkan_filter_and_shared_denylist(void)
{
    /* DS-10: Vulkan VkFilter parity (`DS_FILTER_NEAREST` and `DS_ASPECT_INTEGER` -> VK_FILTER_NEAREST = 0) */
    ASSERT_TRUE(ds_vk_choose_blit_filter(DS_ASPECT_INTEGER, DS_FILTER_AUTO) == 0u);
    ASSERT_TRUE(ds_vk_choose_blit_filter(DS_ASPECT_INTEGER, DS_FILTER_LINEAR) == 0u);
    ASSERT_TRUE(ds_vk_choose_blit_filter(DS_ASPECT_PRESERVE, DS_FILTER_NEAREST) == 0u);
    ASSERT_TRUE(ds_vk_choose_blit_filter(DS_ASPECT_STRETCH, DS_FILTER_NEAREST) == 0u);
    ASSERT_TRUE(ds_vk_choose_blit_filter(DS_ASPECT_PRESERVE, DS_FILTER_AUTO) == 1u);
    ASSERT_TRUE(ds_vk_choose_blit_filter(DS_ASPECT_PRESERVE, DS_FILTER_SHARP) == 1u);
    ASSERT_TRUE(ds_vk_choose_blit_filter(DS_ASPECT_PRESERVE, DS_FILTER_LINEAR) == 1u);
    ASSERT_TRUE(ds_vk_choose_blit_filter(DS_ASPECT_STRETCH, DS_FILTER_LINEAR) == 1u);

    /* Shared common_process_denylist.h ASCII multi-sz matching (case-insensitive exact match) */
    ASSERT_TRUE(one_denylist_match_ascii_msz("WineDevice.EXE", ONE_DENYLIST_WINE_SYSTEM_MSZ));
    ASSERT_TRUE(one_denylist_match_ascii_msz("EXPLORER.EXE", ONE_DENYLIST_WINE_SYSTEM_MSZ));
    ASSERT_TRUE(one_denylist_match_ascii_msz("rpcss.exe", ONE_DENYLIST_WINE_SYSTEM_MSZ));
    ASSERT_TRUE(one_denylist_match_ascii_msz("one_display_launcher_x86.exe", ONE_DENYLIST_WINE_SYSTEM_MSZ));
    ASSERT_TRUE(one_denylist_match_ascii_msz("SteamWebHelper.exe", ONE_DENYLIST_STOREFRONT_DAEMONS_MSZ));
    ASSERT_TRUE(one_denylist_match_ascii_msz("UnityCrashHandler64.exe", ONE_DENYLIST_STOREFRONT_DAEMONS_MSZ));
    ASSERT_TRUE(one_denylist_match_ascii_msz("GalaxyClient.exe", ONE_DENYLIST_GALAXY_CHAIN_MSZ));
    ASSERT_TRUE(one_denylist_match_ascii_msz("Steam.exe", ONE_DENYLIST_STOREFRONT_CLIENTS_MSZ));
    ASSERT_TRUE(one_denylist_match_ascii_msz("EasyAntiCheat_EOS_Setup.exe", ONE_DENYLIST_INSTALLERS_MSZ));
    ASSERT_TRUE(one_denylist_match_ascii_msz("wineserver", ONE_DENYLIST_UNIX_WINE_MSZ));

    /* Negative cases: normal games & partial/empty/NULL strings must never false-positive */
    ASSERT_TRUE(!one_denylist_match_ascii_msz("game.exe", ONE_DENYLIST_WINE_SYSTEM_MSZ));
    ASSERT_TRUE(!one_denylist_match_ascii_msz("engine64.exe", ONE_DENYLIST_STOREFRONT_DAEMONS_MSZ));
    ASSERT_TRUE(!one_denylist_match_ascii_msz("explorer.exe.bak", ONE_DENYLIST_WINE_SYSTEM_MSZ));
    ASSERT_TRUE(!one_denylist_match_ascii_msz("steam", ONE_DENYLIST_STOREFRONT_CLIENTS_MSZ));
    ASSERT_TRUE(!one_denylist_match_ascii_msz("", ONE_DENYLIST_WINE_SYSTEM_MSZ));
    ASSERT_TRUE(!one_denylist_match_ascii_msz(NULL, ONE_DENYLIST_WINE_SYSTEM_MSZ));
    ASSERT_TRUE(!one_denylist_match_ascii_msz("explorer.exe", NULL));
}

int main(void)
{
    test_viewport_and_notch_geometry();
    test_mode_table_invariants();
    test_cursor_mapping_and_zero_drift_mouselook();
    test_subrect_and_control_ini_parser();
    test_wave2a_exact_cursor_roundtrip_and_even_viewports();
    test_wave2a_watertight_strips_and_extended_ini();
    test_v3_user_override_and_mode_union();
    test_v3_three_tier_state_machine_and_multimonitor();
    test_round3_vulkan_d3d9_subnative_viewport_and_cursor();
    test_round4_gl_ctx_isolation_map();
    test_round4_subnative_exclusive_fullscreen_predicate();
    test_round4_live_backing_clamp();
    test_r4_pe_export_bounds_and_fuzz();
    test_r4_lru_dc_map_eviction();
    test_r4_ini_2048_deep_paths();
    test_r4_wow64_rawinput_alignment();
    test_r4_per_hglrc_fbo_lifecycle();
    test_r4_vulkan_filter_and_shared_denylist();
    printf("[DS-ASAN-PASS] All display_scaler C11 geometry, mode-table, zero-drift mouselook, PE/LRU/WoW64/FBO & INI tests passed.\n");
    return 0;
}
