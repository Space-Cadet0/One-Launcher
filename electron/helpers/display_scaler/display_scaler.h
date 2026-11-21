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
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

#define DS_MARKER_DLL      "OneLauncher.DisplayScaler.v1"
#define DS_MARKER_LAUNCHER "OneLauncher.DisplayLauncher.v1"

/* Maximum synthesized DEVMODE entries (< 64 so fixed 64-slot legacy mode buffers never overflow) */
#define DS_MAX_SYNTH_MODES 52u

/* Maximum OS-union DEVMODE entries for non-legacy / 64-bit targets */
#define DS_MAX_UNION_MODES 128u

/* Shared INI read buffer size (accommodates deep macOS Wine prefix control/status paths) */
#define DS_INI_BUF_BYTES 2048u

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

typedef enum ds_scale_filter_e {
    DS_FILTER_AUTO    = 0,
    DS_FILTER_SHARP   = 1,
    DS_FILTER_LINEAR  = 2,
    DS_FILTER_NEAREST = 3
} ds_scale_filter_t;

typedef enum ds_presenter_tier_e {
    DS_PRESENTER_LEGACY_VIRTUAL     = 0,
    DS_PRESENTER_MODERN_PASSTHROUGH = 1,
    DS_PRESENTER_MODERN_BORDERLESS  = 2
} ds_presenter_tier_t;

typedef struct ds_tier_input_s {
    ds_scaling_mode_t   scaling_mode;
    ds_presenter_tier_t prev_tier;
    bool                is_64bit;
    bool                gl_upscale_active;
    bool                ddraw_gdi_active;
    bool                game_gl_active;
    bool                wined3d_uses_gl;
    bool                wined3d_uses_vulkan;
    bool                ddraw_loaded;
    bool                d3d8_or_9_loaded;
    bool                d3d9_loaded;
    bool                legacy_d3d_loaded;
    bool                dxgi_or_d3d10_plus_loaded;
    bool                vulkan_loaded;
    bool                modern_gfx_loaded;
    bool                fullscreen_active;
    bool                borderless_active;
    bool                window_mutated_by_scaler;
    bool                user_forced_windowed;
    bool                user_forced_fullscreen;
} ds_tier_input_t;

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
    bool              has_safe_inset_top;
    int32_t           safe_inset_top;
    bool              has_filter;
    ds_scale_filter_t filter;
    bool              has_scaling_mode;
    ds_scaling_mode_t scaling_mode;
    bool              has_hotkey;
    bool              hotkey;
    bool              has_user_override;
    bool              user_override;
    bool              has_updated_unix_ms;
    uint64_t          updated_unix_ms;
    bool              has_control_file;
    char              control_file[520];
    bool              has_status_file;
    char              status_file[520];
} ds_control_state_t;

/* Environment & configuration string helpers */
ds_scaling_mode_t ds_parse_scaling_mode(const char *value);
ds_aspect_mode_t  ds_parse_aspect_mode(const char *value);
const char       *ds_aspect_mode_to_string(ds_aspect_mode_t mode);
ds_aspect_mode_t  ds_cycle_aspect_mode(ds_aspect_mode_t current);
ds_scale_filter_t ds_parse_scale_filter(const char *value);
const char       *ds_scale_filter_to_string(ds_scale_filter_t filter);

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

/* Synthesizes deduplicated, sorted 16-bpp & 32-bpp display mode table (strictly <= DS_MAX_SYNTH_MODES entries) */
size_t ds_build_mode_table(
    int32_t            native_w,
    int32_t            native_h,
    int32_t            native_hz,
    ds_display_mode_t *out_modes,
    size_t             max_modes
);

/* Unions OS-reported modes with synthesized modes, deduplicating by (w, h, bpp) preferring OS Hz */
size_t ds_merge_mode_tables(
    const ds_display_mode_t *os_modes,
    size_t                   os_count,
    const ds_display_mode_t *synth_modes,
    size_t                   synth_count,
    ds_display_mode_t       *out_modes,
    size_t                   max_modes
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

/* Pure Three-Tier presenter state transition & 32-bit Vulkan legacy-D3D classification */
bool ds_is_vulkan_legacy_d3d(const ds_tier_input_t *in);
ds_presenter_tier_t ds_compute_presenter_tier(const ds_tier_input_t *in);

/* Per-HGLRC OpenGL context isolation map (native game vs WineD3D probe contexts) */
#define DS_MAX_GL_CTX_MAP 16u

typedef struct ds_gl_ctx_entry_s {
    uintptr_t key;
    uint8_t   is_wined3d; /* 1 = wined3d probe/renderer, 0 = native game/app */
} ds_gl_ctx_entry_t;

/* op: 0 = lookup (-1 unknown / 0 native / 1 wined3d), 1 = record native, 2 = record wined3d, -1 = remove */
int ds_gl_ctx_map_op(ds_gl_ctx_entry_t *slots, size_t cap, uintptr_t key, int op);

/* Per-HGLRC FBO/texture/renderbuffer ownership table (prevents cross-context leaks on switch) */
typedef struct ds_gl_game_fbo_s {
    uint32_t fbo_id;
    uint32_t color_tex;
    uint32_t depth_rb;
    int32_t  w;
    int32_t  h;
    uint32_t game_draw_fbo;
    uint32_t game_read_fbo;
} ds_gl_game_fbo_t;

typedef struct ds_gl_color_fbo_s {
    uint32_t fbo_id;
    uint32_t tex_id;
    int32_t  w;
    int32_t  h;
} ds_gl_color_fbo_t;

typedef struct ds_gl_ctx_fbo_slot_s {
    uintptr_t         ctx_key;
    ds_gl_game_fbo_t  game;
    ds_gl_color_fbo_t sharp;
    ds_gl_color_fbo_t w3d;
    uint32_t          last_used_gen;
} ds_gl_ctx_fbo_slot_t;

ds_gl_ctx_fbo_slot_t *ds_gl_ctx_fbo_acquire(
    ds_gl_ctx_fbo_slot_t *slots,
    size_t                cap,
    uintptr_t             ctx_key,
    bool                  create,
    uint32_t             *io_gen,
    ds_gl_ctx_fbo_slot_t *out_evicted
);

bool ds_gl_ctx_fbo_remove(
    ds_gl_ctx_fbo_slot_t *slots,
    size_t                cap,
    uintptr_t             ctx_key,
    ds_gl_ctx_fbo_slot_t *out_removed
);

/* LRU game_hdc <-> host_hdc map slot selection (protects active bound GL DC from eviction) */
#define DS_MAX_GL_DC_MAP 16u

typedef struct ds_gl_dc_entry_s {
    uintptr_t game_hdc;
    uintptr_t host_hdc;
    uintptr_t host_hwnd;
    uint32_t  last_used_gen;
} ds_gl_dc_entry_t;

size_t ds_gl_dc_map_select_slot(
    const ds_gl_dc_entry_t *slots,
    size_t                  cap,
    uintptr_t               game_hdc,
    uintptr_t               cur_host_hwnd,
    uintptr_t               protected_host_hdc
);

/* WoW64-aware RAWINPUT block validation & alignment (8-byte QWORD under WoW64/x64, 16 vs 24 B header) */
typedef struct ds_rawinput_step_s {
    size_t mouse_offset;
    size_t next_step;
} ds_rawinput_step_t;

bool ds_rawinput_validate_block(
    uint32_t            dw_size,
    uint32_t            cb_size_header,
    size_t              remaining_bytes,
    bool                is_wow64,
    bool                is_64bit,
    ds_rawinput_step_t *out_step
);

/* Khronos Vulkan VkFilter parity helper (0 = VK_FILTER_NEAREST, 1 = VK_FILTER_LINEAR) */
static inline uint32_t ds_vk_choose_blit_filter(ds_aspect_mode_t aspect, ds_scale_filter_t filter)
{
    return (aspect == DS_ASPECT_INTEGER || filter == DS_FILTER_NEAREST) ? 0u : 1u;
}

/* Overflow-safe PE32/PE32+ export directory RVA lookup shared by launcher & ASan harness */
static inline bool ds_pe_rva_to_file_off_checked(
    const uint8_t *buf,
    size_t         fsize,
    size_t         sec_off,
    uint16_t       nsec,
    uint32_t       rva,
    size_t         min_bytes,
    size_t        *out_off
)
{
    if (!buf || !out_off || min_bytes > fsize) return false;
    for (uint16_t si = 0; si < nsec; si++) {
        size_t sh = sec_off + (size_t)si * 40u;
        if (sh > fsize || fsize - sh < 40u) return false;
        uint32_t vs = 0, va = 0, rs = 0, ro = 0;
        memcpy(&vs, buf + sh + 8, 4);
        memcpy(&va, buf + sh + 12, 4);
        memcpy(&rs, buf + sh + 16, 4);
        memcpy(&ro, buf + sh + 20, 4);
        if ((size_t)ro > fsize || (size_t)rs > fsize - (size_t)ro) continue;
        uint32_t span = (vs > rs) ? vs : rs;
        if (rva >= va && (uint32_t)(rva - va) < span) {
            uint32_t delta = rva - va;
            if (delta < rs && min_bytes <= (size_t)(rs - delta)) {
                size_t file_off = (size_t)ro + (size_t)delta;
                if (file_off <= fsize && min_bytes <= fsize - file_off) {
                    *out_off = file_off;
                    return true;
                }
            }
            return false;
        }
    }
    return false;
}

static inline uint32_t ds_find_pe_export_rva_in_buf(const uint8_t *buf, size_t fsize, const char *export_name)
{
    if (!buf || !export_name || !export_name[0] || fsize < 64u) return 0u;
    if (buf[0] != 'M' || buf[1] != 'Z') return 0u;
    size_t ename_len = strlen(export_name);

    uint32_t pe_off32 = 0;
    memcpy(&pe_off32, buf + 0x3c, 4);
    size_t pe_off = (size_t)pe_off32;
    if (pe_off < 64u || pe_off > fsize - 24u) return 0u;
    if (memcmp(buf + pe_off, "PE\0\0", 4) != 0) return 0u;

    uint16_t nsec = 0, opt_sz = 0, magic = 0;
    memcpy(&nsec, buf + pe_off + 6, 2);
    memcpy(&opt_sz, buf + pe_off + 20, 2);
    size_t opt_off = pe_off + 24u;
    if (nsec == 0 || opt_sz < 96u || (size_t)opt_sz > fsize - opt_off) return 0u;

    memcpy(&magic, buf + opt_off, 2);
    size_t num_rva_rel = 0, dd_rel = 0;
    if (magic == 0x010bu) {
        num_rva_rel = 92u;
        dd_rel = 96u;
    } else if (magic == 0x020bu) {
        num_rva_rel = 108u;
        dd_rel = 112u;
    } else {
        return 0u;
    }
    if (dd_rel + 8u > (size_t)opt_sz) return 0u;

    uint32_t num_rva = 0;
    memcpy(&num_rva, buf + opt_off + num_rva_rel, 4);
    if (num_rva < 1u) return 0u;

    size_t sec_off = opt_off + (size_t)opt_sz;
    if (sec_off > fsize || (size_t)nsec > (fsize - sec_off) / 40u) return 0u;

    uint32_t exp_rva = 0, exp_sz = 0;
    memcpy(&exp_rva, buf + opt_off + dd_rel, 4);
    memcpy(&exp_sz, buf + opt_off + dd_rel + 4u, 4);
    if (exp_rva == 0u || exp_sz < 40u) return 0u;

    size_t exp_off = 0;
    if (!ds_pe_rva_to_file_off_checked(buf, fsize, sec_off, nsec, exp_rva, 40u, &exp_off)) {
        return 0u;
    }

    uint32_t num_funcs = 0, num_names = 0, funcs_rva = 0, names_rva = 0, ords_rva = 0;
    memcpy(&num_funcs, buf + exp_off + 20u, 4);
    memcpy(&num_names, buf + exp_off + 24u, 4);
    memcpy(&funcs_rva, buf + exp_off + 28u, 4);
    memcpy(&names_rva, buf + exp_off + 32u, 4);
    memcpy(&ords_rva,  buf + exp_off + 36u, 4);
    if (num_funcs == 0u || num_names == 0u || num_funcs > fsize / 4u || num_names > fsize / 4u) {
        return 0u;
    }

    size_t funcs_off = 0, names_off = 0, ords_off = 0;
    if (!ds_pe_rva_to_file_off_checked(buf, fsize, sec_off, nsec, funcs_rva, (size_t)num_funcs * 4u, &funcs_off) ||
        !ds_pe_rva_to_file_off_checked(buf, fsize, sec_off, nsec, names_rva, (size_t)num_names * 4u, &names_off) ||
        !ds_pe_rva_to_file_off_checked(buf, fsize, sec_off, nsec, ords_rva,  (size_t)num_names * 2u, &ords_off)) {
        return 0u;
    }

    for (uint32_t ni = 0; ni < num_names; ni++) {
        uint32_t nm_rva = 0;
        memcpy(&nm_rva, buf + names_off + (size_t)ni * 4u, 4);
        size_t nm_off = 0;
        if (!ds_pe_rva_to_file_off_checked(buf, fsize, sec_off, nsec, nm_rva, 1u, &nm_off)) {
            continue;
        }
        size_t avail = fsize - nm_off;
        if (ename_len < avail &&
            memcmp(buf + nm_off, export_name, ename_len) == 0 &&
            buf[nm_off + ename_len] == '\0') {
            uint16_t ord_idx = 0;
            memcpy(&ord_idx, buf + ords_off + (size_t)ni * 2u, 2);
            if ((uint32_t)ord_idx < num_funcs) {
                uint32_t fn_rva = 0;
                memcpy(&fn_rva, buf + funcs_off + (size_t)ord_idx * 4u, 4);
                /* Reject forwarded export strings pointing inside the export directory itself */
                if (fn_rva >= exp_rva && (uint32_t)(fn_rva - exp_rva) < exp_sz) {
                    return 0u;
                }
                return fn_rva;
            }
            return 0u;
        }
    }
    return 0u;
}

/* Pure Tier 1 64-bit sub-native exclusive-fullscreen window geometry predicate */
bool ds_is_subnative_exclusive_fullscreen_window(
    int32_t  win_x,
    int32_t  win_y,
    int32_t  win_w,
    int32_t  win_h,
    int32_t  mon_x,
    int32_t  mon_y,
    int32_t  mon_w,
    int32_t  mon_h,
    uint32_t style,
    uint32_t exstyle,
    bool     is_topmost_target,
    bool     is_visible,
    bool     is_iconic,
    bool     is_dialog_class
);

/* Proportional live client-rect backing clamp during windowed->fullscreen GL transition */
void ds_clamp_live_backing_dims(
    int32_t  live_w,
    int32_t  live_h,
    int32_t  virt_w,
    int32_t  virt_h,
    int32_t  real_screen_w,
    int32_t  real_screen_h,
    int32_t  phys_screen_w,
    int32_t  phys_screen_h,
    int32_t *io_backing_w,
    int32_t *io_backing_h
);

/*
 * Canonical monotonic version key for `active_session.ini` shared between `DllMain`
 * initialization and `ds_poll_active_session_if_needed` hot-updates. Prefers
 * `updated_unix_ms` (strictly monotonic across both intra-session toggles and
 * consecutive game launches where `seq` resets to 1) with fallback to `seq`.
 */
static inline uint64_t ds_effective_active_session_seq(const ds_control_state_t *ctl)
{
    if (!ctl) return 0ULL;
    if (ctl->has_updated_unix_ms && ctl->updated_unix_ms > 0ULL) {
        return ctl->updated_unix_ms;
    }
    return ctl->has_seq ? ctl->seq : 1ULL;
}

#ifdef __cplusplus
}
#endif

#endif /* ONE_LAUNCHER_DISPLAY_SCALER_H */
