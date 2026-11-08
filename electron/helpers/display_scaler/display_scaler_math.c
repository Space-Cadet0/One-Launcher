/*
 * One Launcher Clean-Room Win32 Universal Display Virtualizer & Fullscreen Presenter
 * Pure Portable C11 Math, Mode-Table Synthesis & Zero-Drift Cursor Engine (`display_scaler_math.c`)
 */

#include "display_scaler.h"
#include <string.h>

static bool ds_ascii_ieq_span(const char *s, size_t len, const char *lit)
{
    if (!s || !lit) return false;
    size_t lit_len = strlen(lit);
    if (len != lit_len) return false;
    for (size_t i = 0; i < len; i++) {
        unsigned char a = (unsigned char)s[i];
        unsigned char b = (unsigned char)lit[i];
        if (a >= 'A' && a <= 'Z') a = (unsigned char)(a - 'A' + 'a');
        if (b >= 'A' && b <= 'Z') b = (unsigned char)(b - 'A' + 'a');
        if (a != b) return false;
    }
    return true;
}

static void ds_trim_span(const char **inout_ptr, size_t *inout_len)
{
    const char *p = *inout_ptr;
    size_t n = *inout_len;
    while (n > 0 && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) {
        p++;
        n--;
    }
    while (n > 0 && (p[n - 1] == ' ' || p[n - 1] == '\t' || p[n - 1] == '\r' || p[n - 1] == '\n')) {
        n--;
    }
    *inout_ptr = p;
    *inout_len = n;
}

ds_scaling_mode_t ds_parse_scaling_mode(const char *value)
{
    if (!value) return DS_MODE_PASSTHROUGH;
    const char *p = value;
    size_t n = strlen(value);
    ds_trim_span(&p, &n);
    if (ds_ascii_ieq_span(p, n, "auto_fullscreen") || ds_ascii_ieq_span(p, n, "auto")) {
        return DS_MODE_AUTO_FULLSCREEN;
    }
    if (ds_ascii_ieq_span(p, n, "force_fullscreen")) {
        return DS_MODE_FORCE_FULLSCREEN;
    }
    return DS_MODE_PASSTHROUGH;
}

ds_aspect_mode_t ds_parse_aspect_mode(const char *value)
{
    if (!value) return DS_ASPECT_PRESERVE;
    const char *p = value;
    size_t n = strlen(value);
    ds_trim_span(&p, &n);
    if (ds_ascii_ieq_span(p, n, "integer")) {
        return DS_ASPECT_INTEGER;
    }
    if (ds_ascii_ieq_span(p, n, "stretch")) {
        return DS_ASPECT_STRETCH;
    }
    return DS_ASPECT_PRESERVE;
}

const char *ds_aspect_mode_to_string(ds_aspect_mode_t mode)
{
    switch (mode) {
        case DS_ASPECT_INTEGER:
            return "integer";
        case DS_ASPECT_STRETCH:
            return "stretch";
        case DS_ASPECT_PRESERVE:
        default:
            return "preserve_aspect";
    }
}

ds_aspect_mode_t ds_cycle_aspect_mode(ds_aspect_mode_t current)
{
    switch (current) {
        case DS_ASPECT_PRESERVE:
            return DS_ASPECT_INTEGER;
        case DS_ASPECT_INTEGER:
            return DS_ASPECT_STRETCH;
        case DS_ASPECT_STRETCH:
        default:
            return DS_ASPECT_PRESERVE;
    }
}

int32_t ds_clamp_safe_inset_top(int32_t safe_inset_top, int32_t screen_h)
{
    if (screen_h <= 4 || safe_inset_top <= 0) {
        return 0;
    }
    int32_t quarter = screen_h / 4;
    int32_t max_inset = (quarter > 0) ? (quarter - 1) : 0;
    if (safe_inset_top > max_inset) {
        return max_inset;
    }
    return safe_inset_top;
}

static int32_t ds_round_aspect_dim_even_or_exact(int64_t num, int64_t den, int32_t max_bound)
{
    if (den <= 0 || max_bound <= 0) return 1;
    int64_t val = 0;
    if ((num % den) == 0) {
        val = num / den;
    } else {
        val = (num + (den / 2)) / den;
        if ((val & 1) != 0) {
            if (val + 1 <= (int64_t)max_bound) {
                val += 1;
            } else if (val > 1) {
                val -= 1;
            }
        }
    }
    if (val < 1) val = 1;
    if (val > (int64_t)max_bound) val = (int64_t)max_bound;
    return (int32_t)val;
}

bool ds_compute_viewport(
    int32_t          screen_w,
    int32_t          screen_h,
    int32_t          safe_inset_top,
    int32_t          virt_w,
    int32_t          virt_h,
    ds_aspect_mode_t aspect_mode,
    ds_viewport_t   *out_vp
)
{
    if (out_vp) {
        memset(out_vp, 0, sizeof(*out_vp));
    }
    if (!out_vp || screen_w <= 0 || screen_h <= 0 || virt_w <= 0 || virt_h <= 0) {
        return false;
    }

    int32_t safe_top = ds_clamp_safe_inset_top(safe_inset_top, screen_h);
    int32_t usable_x = 0;
    int32_t usable_y = safe_top;
    int32_t usable_w = screen_w;
    int32_t usable_h = screen_h - safe_top;
    if (usable_h < 1) {
        usable_h = 1;
    }

    out_vp->usable_x = usable_x;
    out_vp->usable_y = usable_y;
    out_vp->usable_w = usable_w;
    out_vp->usable_h = usable_h;
    out_vp->integer_scale = 0;

    if (aspect_mode == DS_ASPECT_STRETCH) {
        out_vp->dst_x = usable_x;
        out_vp->dst_y = usable_y;
        out_vp->dst_w = usable_w;
        out_vp->dst_h = usable_h;
        return true;
    }

    if (aspect_mode == DS_ASPECT_INTEGER) {
        int32_t kx = usable_w / virt_w;
        int32_t ky = usable_h / virt_h;
        int32_t k = (kx < ky) ? kx : ky;
        if (k >= 1) {
            int32_t dst_w = virt_w * k;
            int32_t dst_h = virt_h * k;
            out_vp->dst_w = dst_w;
            out_vp->dst_h = dst_h;
            out_vp->dst_x = usable_x + (usable_w - dst_w) / 2;
            out_vp->dst_y = usable_y + (usable_h - dst_h) / 2;
            out_vp->integer_scale = k;
            return true;
        }
        /* k < 1 (virt exceeds usable rect): fall through cleanly to DS_ASPECT_PRESERVE */
    }

    int64_t lhs = (int64_t)usable_w * (int64_t)virt_h;
    int64_t rhs = (int64_t)usable_h * (int64_t)virt_w;
    int32_t dst_w = usable_w;
    int32_t dst_h = usable_h;

    if (lhs > rhs) {
        /* Usable area is wider than virtual aspect -> pillarbox */
        dst_h = usable_h;
        dst_w = ds_round_aspect_dim_even_or_exact(rhs, (int64_t)virt_h, usable_w);
    } else if (lhs < rhs) {
        /* Usable area is taller than virtual aspect -> letterbox */
        dst_w = usable_w;
        dst_h = ds_round_aspect_dim_even_or_exact(lhs, (int64_t)virt_w, usable_h);
    }

    out_vp->dst_w = dst_w;
    out_vp->dst_h = dst_h;
    out_vp->dst_x = usable_x + (usable_w - dst_w) / 2;
    out_vp->dst_y = usable_y + (usable_h - dst_h) / 2;
    return true;
}

typedef struct ds_res_pair_s {
    int32_t w;
    int32_t h;
    bool    mandatory;
} ds_res_pair_t;

size_t ds_build_mode_table(
    int32_t            native_w,
    int32_t            native_h,
    int32_t            native_hz,
    ds_display_mode_t *out_modes,
    size_t             max_modes
)
{
    if (!out_modes || max_modes == 0) {
        return 0;
    }

    if (native_w <= 0) native_w = 1024;
    if (native_h <= 0) native_h = 768;
    int32_t hz = (native_hz > 0) ? native_hz : 60;

    static const ds_res_pair_t k_standard_res[] = {
        {  320,  200, false },
        {  320,  240, false },
        {  400,  300, false },
        {  512,  384, false },
        {  640,  400, false },
        {  640,  480, true  },
        {  800,  600, true  },
        { 1024,  768, true  },
        { 1152,  864, false },
        { 1280,  720, false },
        { 1280,  800, false },
        { 1280,  960, false },
        { 1280, 1024, false },
        { 1366,  768, false },
        { 1440,  900, false },
        { 1600,  900, false },
        { 1600, 1200, false },
        { 1920, 1080, false },
        { 1920, 1200, false },
        { 2560, 1440, false },
        { 2560, 1600, false }
    };

    /* Max unique resolutions (standard + native) -> <= 52 modes (8/16/32 bpp) < 64 */
    ds_res_pair_t unique_res[32];
    size_t res_count = 0;

    size_t std_total = sizeof(k_standard_res) / sizeof(k_standard_res[0]);
    for (size_t i = 0; i < std_total; i++) {
        int32_t cw = k_standard_res[i].w;
        int32_t ch = k_standard_res[i].h;
        bool keep = k_standard_res[i].mandatory || (cw <= native_w && ch <= native_h);
        if (!keep) continue;

        bool dup = false;
        for (size_t j = 0; j < res_count; j++) {
            if (unique_res[j].w == cw && unique_res[j].h == ch) {
                dup = true;
                break;
            }
        }
        if (!dup && res_count < 31) {
            unique_res[res_count++] = k_standard_res[i];
        }
    }

    /* Ensure native desktop resolution is always present and deduplicated */
    bool has_native = false;
    for (size_t j = 0; j < res_count; j++) {
        if (unique_res[j].w == native_w && unique_res[j].h == native_h) {
            unique_res[j].mandatory = true;
            has_native = true;
            break;
        }
    }
    if (!has_native && res_count < 32) {
        unique_res[res_count].w = native_w;
        unique_res[res_count].h = native_h;
        unique_res[res_count].mandatory = true;
        res_count++;
    }

    /* Insertion sort ascending by (width, height) */
    for (size_t i = 1; i < res_count; i++) {
        ds_res_pair_t cur = unique_res[i];
        size_t j = i;
        while (j > 0 &&
               (unique_res[j - 1].w > cur.w ||
                (unique_res[j - 1].w == cur.w && unique_res[j - 1].h > cur.h))) {
            unique_res[j] = unique_res[j - 1];
            j--;
        }
        unique_res[j] = cur;
    }

    size_t hard_cap = (max_modes < DS_MAX_SYNTH_MODES) ? max_modes : DS_MAX_SYNTH_MODES;

    /* Ensure total modes fit within hard_cap without truncating native or mandatory resolutions */
    while (res_count > 0) {
        size_t total_modes = 0;
        for (size_t i = 0; i < res_count; i++) {
            bool inc8 = (unique_res[i].w <= 1024 && unique_res[i].h <= 768);
            total_modes += inc8 ? 3 : 2;
        }
        if (total_modes <= hard_cap) {
            break;
        }
        /* Find a non-mandatory, non-native resolution to prune (preferring uncommon intermediate resolutions) */
        int prune_idx = -1;
        static const struct { int32_t w; int32_t h; } k_prune_pref[] = {
            { 1152,  864 },
            { 1366,  768 },
            { 1600,  900 },
            { 1280,  800 },
            { 1440,  900 },
            {  320,  240 },
            {  512,  384 },
            {  640,  400 },
            {  400,  300 },
            { 1280,  960 }
        };
        size_t prune_pref_count = sizeof(k_prune_pref) / sizeof(k_prune_pref[0]);
        for (size_t p = 0; p < prune_pref_count && prune_idx < 0; p++) {
            for (size_t i = 0; i < res_count; i++) {
                if (unique_res[i].w == k_prune_pref[p].w && unique_res[i].h == k_prune_pref[p].h) {
                    if (!unique_res[i].mandatory &&
                        !(unique_res[i].w == native_w && unique_res[i].h == native_h)) {
                        prune_idx = (int)i;
                        break;
                    }
                }
            }
        }
        if (prune_idx < 0) {
            /* Fallback: pick any non-mandatory, non-native resolution */
            for (size_t i = 0; i < res_count; i++) {
                if (!unique_res[i].mandatory &&
                    !(unique_res[i].w == native_w && unique_res[i].h == native_h)) {
                    prune_idx = (int)i;
                    break;
                }
            }
        }
        if (prune_idx >= 0) {
            for (size_t i = (size_t)prune_idx; i + 1 < res_count; i++) {
                unique_res[i] = unique_res[i + 1];
            }
            res_count--;
        } else {
            break;
        }
    }

    size_t out_count = 0;

    for (size_t i = 0; i < res_count; i++) {
        int32_t rw = unique_res[i].w;
        int32_t rh = unique_res[i].h;
        bool include_8bpp = (rw <= 1024 && rh <= 768);
        if (include_8bpp && out_count < hard_cap) {
            out_modes[out_count].width = rw;
            out_modes[out_count].height = rh;
            out_modes[out_count].bpp = 8;
            out_modes[out_count].refresh_hz = hz;
            out_count++;
        }
        if (out_count < hard_cap) {
            out_modes[out_count].width = rw;
            out_modes[out_count].height = rh;
            out_modes[out_count].bpp = 16;
            out_modes[out_count].refresh_hz = hz;
            out_count++;
        }
        if (out_count < hard_cap) {
            out_modes[out_count].width = rw;
            out_modes[out_count].height = rh;
            out_modes[out_count].bpp = 32;
            out_modes[out_count].refresh_hz = hz;
            out_count++;
        }
    }

    return out_count;
}

static int64_t ds_clamp_i64(int64_t val, int64_t lo, int64_t hi)
{
    if (val < lo) return lo;
    if (val > hi) return hi;
    return val;
}

static int64_t ds_div_round_nearest(int64_t num, int64_t den)
{
    if (den <= 0) return 0;
    if (num >= 0) {
        return (num + (den / 2)) / den;
    }
    return -(((-num) + (den / 2)) / den);
}

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
)
{
    if (out_vx) *out_vx = 0;
    if (out_vy) *out_vy = 0;
    if (!out_vx || !out_vy || dst_w <= 0 || dst_h <= 0 || virt_w <= 0 || virt_h <= 0) {
        return false;
    }

    int64_t rel_x = ds_clamp_i64((int64_t)px - (int64_t)dst_x, 0, (int64_t)dst_w - 1);
    int64_t rel_y = ds_clamp_i64((int64_t)py - (int64_t)dst_y, 0, (int64_t)dst_h - 1);

    int64_t vx = (rel_x * (int64_t)virt_w) / (int64_t)dst_w;
    int64_t vy = (rel_y * (int64_t)virt_h) / (int64_t)dst_h;

    *out_vx = (int32_t)ds_clamp_i64(vx, 0, (int64_t)virt_w - 1);
    *out_vy = (int32_t)ds_clamp_i64(vy, 0, (int64_t)virt_h - 1);
    return true;
}

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
)
{
    if (out_px) *out_px = 0;
    if (out_py) *out_py = 0;
    if (!out_px || !out_py || dst_w <= 0 || dst_h <= 0 || virt_w <= 0 || virt_h <= 0) {
        return false;
    }

    int64_t cvx = ds_clamp_i64((int64_t)vx, 0, (int64_t)virt_w - 1);
    int64_t cvy = ds_clamp_i64((int64_t)vy, 0, (int64_t)virt_h - 1);

    int64_t px = (int64_t)dst_x + (cvx * (int64_t)dst_w) / (int64_t)virt_w;
    int64_t py = (int64_t)dst_y + (cvy * (int64_t)dst_h) / (int64_t)virt_h;

    *out_px = (int32_t)ds_clamp_i64(px, (int64_t)dst_x, (int64_t)dst_x + (int64_t)dst_w - 1);
    *out_py = (int32_t)ds_clamp_i64(py, (int64_t)dst_y, (int64_t)dst_y + (int64_t)dst_h - 1);
    return true;
}

void ds_cursor_warp_reset(ds_cursor_warp_state_t *warp)
{
    if (!warp) return;
    memset(warp, 0, sizeof(*warp));
}

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
)
{
    int32_t px = 0;
    int32_t py = 0;
    if (!warp || !ds_map_cursor_virt_to_phys(vx, vy, dst_x, dst_y, dst_w, dst_h, virt_w, virt_h, &px, &py)) {
        if (out_phys_x) *out_phys_x = 0;
        if (out_phys_y) *out_phys_y = 0;
        return false;
    }

    int32_t clamped_vx = (int32_t)ds_clamp_i64((int64_t)vx, 0, (int64_t)virt_w - 1);
    int32_t clamped_vy = (int32_t)ds_clamp_i64((int64_t)vy, 0, (int64_t)virt_h - 1);

    if (warp->valid && warp->virt_x == clamped_vx && warp->virt_y == clamped_vy) {
        /* Re-warp to identical anchor (3D mouse-look center reset): commit sub-pixel remainder */
        if (warp->has_pending_rem) {
            warp->rem_num_x = warp->pending_rem_num_x;
            warp->rem_num_y = warp->pending_rem_num_y;
            warp->has_pending_rem = false;
        }
    } else {
        warp->rem_num_x = 0;
        warp->rem_num_y = 0;
        warp->pending_rem_num_x = 0;
        warp->pending_rem_num_y = 0;
        warp->has_pending_rem = false;
    }

    warp->valid = true;
    warp->virt_x = clamped_vx;
    warp->virt_y = clamped_vy;
    warp->phys_x = px;
    warp->phys_y = py;

    if (out_phys_x) *out_phys_x = px;
    if (out_phys_y) *out_phys_y = py;
    return true;
}

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
)
{
    if (!out_vx || !out_vy || dst_w <= 0 || dst_h <= 0 || virt_w <= 0 || virt_h <= 0) {
        if (out_vx) *out_vx = 0;
        if (out_vy) *out_vy = 0;
        return false;
    }

    if (!warp || !warp->valid) {
        return ds_map_cursor_phys_to_virt(
            cur_px, cur_py, dst_x, dst_y, dst_w, dst_h, virt_w, virt_h, out_vx, out_vy);
    }

    int64_t dpx = (int64_t)cur_px - (int64_t)warp->phys_x;
    int64_t dpy = (int64_t)cur_py - (int64_t)warp->phys_y;

    if (dpx == 0 && dpy == 0) {
        /* Exact stationary warp anchor -> guaranteed zero integer-rounding camera drift */
        warp->pending_rem_num_x = warp->rem_num_x;
        warp->pending_rem_num_y = warp->rem_num_y;
        warp->has_pending_rem = true;
        *out_vx = (int32_t)ds_clamp_i64((int64_t)warp->virt_x, 0, (int64_t)virt_w - 1);
        *out_vy = (int32_t)ds_clamp_i64((int64_t)warp->virt_y, 0, (int64_t)virt_h - 1);
        return true;
    }

    int64_t dvx = 0;
    int64_t next_rem_x = warp->rem_num_x;
    if (dpx != 0) {
        int64_t total_num_x = dpx * (int64_t)virt_w + warp->rem_num_x;
        dvx = ds_div_round_nearest(total_num_x, (int64_t)dst_w);
        next_rem_x = total_num_x - dvx * (int64_t)dst_w;
    }

    int64_t dvy = 0;
    int64_t next_rem_y = warp->rem_num_y;
    if (dpy != 0) {
        int64_t total_num_y = dpy * (int64_t)virt_h + warp->rem_num_y;
        dvy = ds_div_round_nearest(total_num_y, (int64_t)dst_h);
        next_rem_y = total_num_y - dvy * (int64_t)dst_h;
    }

    warp->pending_rem_num_x = next_rem_x;
    warp->pending_rem_num_y = next_rem_y;
    warp->has_pending_rem = true;

    *out_vx = (int32_t)ds_clamp_i64((int64_t)warp->virt_x + dvx, 0, (int64_t)virt_w - 1);
    *out_vy = (int32_t)ds_clamp_i64((int64_t)warp->virt_y + dvy, 0, (int64_t)virt_h - 1);
    return true;
}

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
)
{
    if (out_px) *out_px = 0;
    if (out_py) *out_py = 0;
    if (out_pw) *out_pw = 0;
    if (out_ph) *out_ph = 0;
    if (!out_px || !out_py || !out_pw || !out_ph || dst_w <= 0 || dst_h <= 0 || virt_w <= 0 || virt_h <= 0) {
        return false;
    }

    int64_t x0 = (int64_t)vx;
    int64_t y0 = (int64_t)vy;
    int64_t x1 = x0 + (int64_t)vw;
    int64_t y1 = y0 + (int64_t)vh;

    int64_t px0 = (int64_t)dst_origin_x + (x0 * (int64_t)dst_w) / (int64_t)virt_w;
    int64_t py0 = (int64_t)dst_origin_y + (y0 * (int64_t)dst_h) / (int64_t)virt_h;
    int64_t px1 = (int64_t)dst_origin_x + (x1 * (int64_t)dst_w) / (int64_t)virt_w;
    int64_t py1 = (int64_t)dst_origin_y + (y1 * (int64_t)dst_h) / (int64_t)virt_h;

    if (vw > 0 && px1 <= px0) px1 = px0 + 1;
    if (vh > 0 && py1 <= py0) py1 = py0 + 1;

    *out_px = (int32_t)px0;
    *out_py = (int32_t)py0;
    *out_pw = (int32_t)(px1 - px0);
    *out_ph = (int32_t)(py1 - py0);
    return true;
}

static bool ds_parse_u64_span(const char *s, size_t len, uint64_t *out_val)
{
    if (!s || len == 0 || !out_val) return false;
    uint64_t acc = 0;
    for (size_t i = 0; i < len; i++) {
        char c = s[i];
        if (c < '0' || c > '9') return false;
        uint64_t digit = (uint64_t)(c - '0');
        if (acc > (UINT64_MAX - digit) / 10ULL) return false;
        acc = acc * 10ULL + digit;
    }
    *out_val = acc;
    return true;
}

bool ds_parse_control_ini(const char *text, size_t len, ds_control_state_t *out_state)
{
    if (out_state) {
        memset(out_state, 0, sizeof(*out_state));
    }
    if (!text || !out_state) {
        return false;
    }

    size_t i = 0;
    while (i < len && text[i] != '\0') {
        size_t line_start = i;
        while (i < len && text[i] != '\0' && text[i] != '\n' && text[i] != '\r') {
            i++;
        }
        size_t line_len = i - line_start;
        while (i < len && (text[i] == '\n' || text[i] == '\r')) {
            i++;
        }

        const char *line = text + line_start;
        ds_trim_span(&line, &line_len);
        if (line_len == 0 || line[0] == '#' || line[0] == ';' || line[0] == '[') {
            continue;
        }

        const char *eq = NULL;
        for (size_t k = 0; k < line_len; k++) {
            if (line[k] == '=') {
                eq = line + k;
                break;
            }
        }
        if (!eq) continue;

        const char *key = line;
        size_t key_len = (size_t)(eq - line);
        const char *val = eq + 1;
        size_t val_len = line_len - key_len - 1;
        ds_trim_span(&key, &key_len);
        ds_trim_span(&val, &val_len);
        if (key_len == 0) continue;

        if (ds_ascii_ieq_span(key, key_len, "seq")) {
            uint64_t parsed_seq = 0;
            if (ds_parse_u64_span(val, val_len, &parsed_seq)) {
                out_state->has_seq = true;
                out_state->seq = parsed_seq;
            }
        } else if (ds_ascii_ieq_span(key, key_len, "fullscreen")) {
            if (ds_ascii_ieq_span(val, val_len, "1") || ds_ascii_ieq_span(val, val_len, "true")) {
                out_state->has_fullscreen = true;
                out_state->fullscreen = true;
            } else if (ds_ascii_ieq_span(val, val_len, "0") || ds_ascii_ieq_span(val, val_len, "false")) {
                out_state->has_fullscreen = true;
                out_state->fullscreen = false;
            }
        } else if (ds_ascii_ieq_span(key, key_len, "aspect")) {
            if (ds_ascii_ieq_span(val, val_len, "preserve_aspect")) {
                out_state->has_aspect = true;
                out_state->aspect = DS_ASPECT_PRESERVE;
            } else if (ds_ascii_ieq_span(val, val_len, "integer")) {
                out_state->has_aspect = true;
                out_state->aspect = DS_ASPECT_INTEGER;
            } else if (ds_ascii_ieq_span(val, val_len, "stretch")) {
                out_state->has_aspect = true;
                out_state->aspect = DS_ASPECT_STRETCH;
            }
        }
    }

    return out_state->has_seq || out_state->has_fullscreen || out_state->has_aspect;
}
