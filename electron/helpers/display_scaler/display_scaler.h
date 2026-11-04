/*
 * One Launcher Clean-Room Win32 Universal Display Virtualizer & Fullscreen Presenter
 * Shared Portable C11 Header (`display_scaler.h`)
 *
 * Pure C11 types and deterministic geometry, mode-table synthesis, cursor mapping,
 * zero-drift 3D mouse-look warp anchoring, and live control-file parsing declarations.
 * Compiles cleanly on both Win32/Win64 (`zig cc`) and POSIX Host Clang (`-fsanitize=address,undefined`).
 */

#ifndef ONE_LAUNCHER_DISPLAY_SCALER_H
#define ONE_LAUNCHER_DISPLAY_SCALER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define DS_MARKER_DLL      "OneLauncher.DisplayScaler.v1"
#define DS_MARKER_LAUNCHER "OneLauncher.DisplayLauncher.v1"

/* Maximum synthesized DEVMODE entries (< 64 so fixed 64-slot legacy mode buffers never overflow) */
#define DS_MAX_SYNTH_MODES 52u

typedef enum ds_scaling_mode_e {
    DS_MODE_PASSTHROUGH      = 0,
    DS_MODE_AUTO_FULLSCREEN  = 1,
    DS_MODE_FORCE_FULLSCREEN = 2
} ds_scaling_mode_t;

typedef enum ds_aspect_mode_e {
    DS_ASPECT_PRESERVE = 0,
    DS_ASPECT_INTEGER  = 1,
    DS_ASPECT_STRETCH  = 2
} ds_aspect_mode_t;

typedef struct ds_viewport_s {
    int32_t usable_x;
    int32_t usable_y;
    int32_t usable_w;
    int32_t usable_h;
    int32_t dst_x;
    int32_t dst_y;
    int32_t dst_w;
    int32_t dst_h;
    int32_t integer_scale; /* >= 1 when integer scale is active, 0 for preserve/stretch */
} ds_viewport_t;

typedef struct ds_display_mode_s {
    int32_t width;
    int32_t height;
    int32_t bpp;
    int32_t refresh_hz;
} ds_display_mode_t;

typedef struct ds_cursor_warp_state_s {
    bool    valid;
    int32_t virt_x;
    int32_t virt_y;
    int32_t phys_x;
    int32_t phys_y;
    int64_t rem_num_x;
    int64_t rem_num_y;
    int64_t pending_rem_num_x;
    int64_t pending_rem_num_y;
    bool    has_pending_rem;
} ds_cursor_warp_state_t;

typedef struct ds_control_state_s {
    bool              has_seq;
    uint64_t          seq;
    bool              has_fullscreen;
    bool              fullscreen;
    bool              has_aspect;
    ds_aspect_mode_t  aspect;
} ds_control_state_t;

/* Environment & configuration string helpers */
ds_scaling_mode_t ds_parse_scaling_mode(const char *value);
ds_aspect_mode_t  ds_parse_aspect_mode(const char *value);
const char       *ds_aspect_mode_to_string(ds_aspect_mode_t mode);
ds_aspect_mode_t  ds_cycle_aspect_mode(ds_aspect_mode_t current);

/* Clamps top safe-area notch inset so 0 <= safe_top < screen_h / 4 (0 when screen_h < 4) */
int32_t ds_clamp_safe_inset_top(int32_t safe_inset_top, int32_t screen_h);

/* Computes notch-safe aspect-correct destination viewport rectangle */
bool ds_compute_viewport(
    int32_t          screen_w,
    int32_t          screen_h,
    int32_t          safe_inset_top,
    int32_t          virt_w,
    int32_t          virt_h,
    ds_aspect_mode_t aspect_mode,
    ds_viewport_t   *out_vp
);

/* Synthesizes deduplicated, sorted 16-bpp & 32-bpp display mode table (strictly <= 40 entries) */
size_t ds_build_mode_table(
    int32_t            native_w,
    int32_t            native_h,
    int32_t            native_hz,
    ds_display_mode_t *out_modes,
    size_t             max_modes
);

/* 2D physical <-> virtual cursor coordinate mapping (clamped to [0..virt_w-1, 0..virt_h-1]) */
bool ds_map_cursor_phys_to_virt(
    int32_t  px,
    int32_t  py,
    int32_t  dst_x,
    int32_t  dst_y,
    int32_t  dst_w,
    int32_t  dst_h,
    int32_t  virt_w,
    int32_t  virt_h,
    int32_t *out_vx,
    int32_t *out_vy
);

bool ds_map_cursor_virt_to_phys(
    int32_t  vx,
    int32_t  vy,
    int32_t  dst_x,
    int32_t  dst_y,
    int32_t  dst_w,
    int32_t  dst_h,
    int32_t  virt_w,
    int32_t  virt_h,
    int32_t *out_px,
    int32_t *out_py
);

/* Zero-drift 3D mouse-look SetCursorPos / GetCursorPos warp anchor + sub-pixel accumulator */
void ds_cursor_warp_reset(ds_cursor_warp_state_t *warp);

bool ds_cursor_record_warp(
    ds_cursor_warp_state_t *warp,
    int32_t                 vx,
    int32_t                 vy,
    int32_t                 dst_x,
    int32_t                 dst_y,
    int32_t                 dst_w,
    int32_t                 dst_h,
    int32_t                 virt_w,
    int32_t                 virt_h,
    int32_t                *out_phys_x,
    int32_t                *out_phys_y
);

bool ds_cursor_resolve_get_pos(
    ds_cursor_warp_state_t *warp,
    int32_t                 cur_px,
    int32_t                 cur_py,
    int32_t                 dst_x,
    int32_t                 dst_y,
    int32_t                 dst_w,
    int32_t                 dst_h,
    int32_t                 virt_w,
    int32_t                 virt_h,
    int32_t                *out_vx,
    int32_t                *out_vy
);

/* Proportional virtual-to-physical sub-rectangle mapping (GDI dirty-rect blits & ClipCursor) */
bool ds_map_subrect_virt_to_phys(
    int32_t  vx,
    int32_t  vy,
    int32_t  vw,
    int32_t  vh,
    int32_t  dst_origin_x,
    int32_t  dst_origin_y,
    int32_t  dst_w,
    int32_t  dst_h,
    int32_t  virt_w,
    int32_t  virt_h,
    int32_t *out_px,
    int32_t *out_py,
    int32_t *out_pw,
    int32_t *out_ph
);

/* Live control INI file parser (`seq=...`, `fullscreen=0|1`, `aspect=...`) */
bool ds_parse_control_ini(const char *text, size_t len, ds_control_state_t *out_state);

#ifdef __cplusplus
}
#endif

#endif /* ONE_LAUNCHER_DISPLAY_SCALER_H */
