/*
 * One Launcher Clean-Room Win32 Universal Display Virtualizer & Fullscreen Presenter
 * Single-Window Borderless Presenter, OpenGL Child Host, Subclass & Live Control Watcher
 * (`display_scaler_window.c`)
 */

#include "display_scaler_internal.h"
#include <stdio.h>
#include <string.h>
#include <wchar.h>

/* REMOVED: OneLauncherBackdropWnd — Single borderless game window with BLACK_BRUSH now covers full screen */

#ifndef GCLP_HBRBACKGROUND
#define GCLP_HBRBACKGROUND (-10)
#endif

DS_ALWAYS_INLINE LONG_PTR ds_get_class_bg_brush(HWND hwnd)
{
#if defined(_WIN64)
    return (LONG_PTR)GetClassLongPtrW(hwnd, GCLP_HBRBACKGROUND);
#else
    return (LONG_PTR)GetClassLongW(hwnd, GCLP_HBRBACKGROUND);
#endif
}

void ds_set_class_bg_brush(HWND hwnd, LONG_PTR brush_val)
{
#if defined(_WIN64)
    SetClassLongPtrW(hwnd, GCLP_HBRBACKGROUND, brush_val);
#else
    SetClassLongW(hwnd, GCLP_HBRBACKGROUND, (LONG)brush_val);
#endif
}

LONG_PTR ds_get_wnd_long_ptr(HWND hwnd, int idx)
{
#if defined(_WIN64)
    pfn_GetWindowLongPtrW_t fn = g_ds.real_GetWindowLongPtrW ? g_ds.real_GetWindowLongPtrW : GetWindowLongPtrW;
    return fn(hwnd, idx);
#else
    pfn_GetWindowLongW_t fn = g_ds.real_GetWindowLongW ? g_ds.real_GetWindowLongW : GetWindowLongW;
    return (LONG_PTR)fn(hwnd, idx);
#endif
}

LONG_PTR ds_set_wnd_long_ptr_raw(HWND hwnd, int idx, LONG_PTR val, bool unicode)
{
#if defined(_WIN64)
    if (unicode) {
        pfn_SetWindowLongPtrW_t fn = g_ds.real_SetWindowLongPtrW ? g_ds.real_SetWindowLongPtrW : SetWindowLongPtrW;
        return fn(hwnd, idx, val);
    }
    pfn_SetWindowLongPtrA_t fn = g_ds.real_SetWindowLongPtrA ? g_ds.real_SetWindowLongPtrA : SetWindowLongPtrA;
    return fn(hwnd, idx, val);
#else
    if (unicode) {
        pfn_SetWindowLongW_t fn = g_ds.real_SetWindowLongW ? g_ds.real_SetWindowLongW : SetWindowLongW;
        return (LONG_PTR)fn(hwnd, idx, (LONG)val);
    }
    pfn_SetWindowLongA_t fn = g_ds.real_SetWindowLongA ? g_ds.real_SetWindowLongA : SetWindowLongA;
    return (LONG_PTR)fn(hwnd, idx, (LONG)val);
#endif
}



static BOOL CALLBACK ds_enum_adopt_window_cb(HWND hwnd, LPARAM lParam);

#define DS_GL_HOST_CHILD_CLASS_W L"OneLauncherGLHostChild"
#define DS_PROP_ORIG_PROC_W      L"DS_OrigProc"
#define DS_PROP_ORIG_UNI_W       L"DS_OrigUni"

static LRESULT CALLBACK ds_gl_host_wndproc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
        case WM_NCHITTEST:
            return HTTRANSPARENT;
        case WM_MOUSEACTIVATE:
            return MA_NOACTIVATE;
        case WM_ERASEBKGND:
            return 1;
        case WM_SETFOCUS: {
            HWND parent = GetParent(hwnd);
            if (parent && IsWindow(parent)) {
                SetFocus(parent);
                return 0;
            }
            break;
        }
        case WM_SETCURSOR: {
            HWND parent = GetParent(hwnd);
            if (parent && IsWindow(parent)) {
                return SendMessageW(parent, msg, (WPARAM)parent, lParam);
            }
            break;
        }
        default:
            if (msg >= WM_MOUSEFIRST && msg <= WM_MOUSELAST) {
                HWND parent = GetParent(hwnd);
                if (parent && IsWindow(parent)) {
                    return SendMessageW(parent, msg, wParam, lParam);
                }
            }
            break;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

static void ds_get_gl_host_target_size(HWND hwnd_parent, int32_t *out_w, int32_t *out_h)
{
    ds_lock();
    bool fs_active = (hwnd_parent == g_ds.hwnd_game && g_ds.fullscreen_active);
    int32_t rw = g_ds.real_screen_w;
    int32_t rh = g_ds.real_screen_h;
    ds_unlock();

    if (fs_active && rw > 0 && rh > 0) {
        *out_w = rw;
        *out_h = rh;
        return;
    }

    RECT crc = { 0, 0, 0, 0 };
    pfn_GetClientRect_t gcr = g_ds.real_GetClientRect ? g_ds.real_GetClientRect : GetClientRect;
    ds_enter_internal();
    BOOL ok = gcr(hwnd_parent, &crc);
    ds_leave_internal();

    int32_t cw = ok ? (crc.right - crc.left) : 0;
    int32_t ch = ok ? (crc.bottom - crc.top) : 0;
    if (cw <= 0) cw = (rw > 0) ? rw : 640;
    if (ch <= 0) ch = (rh > 0) ? rh : 480;
    *out_w = cw;
    *out_h = ch;
}

void ds_sync_gl_host_bounds_on_owner_thread(HWND hwnd_parent)
{
    if (!hwnd_parent || !IsWindow(hwnd_parent)) {
        return;
    }

    ds_lock();
    if (ds_is_modern_tier_locked()) {
        ds_unlock();
        return;
    }
    HWND host = g_ds.hwnd_gl_host;
    bool vis = g_ds.gl_host_visible;
    ds_unlock();

    if (!host || !IsWindow(host) || GetParent(host) != hwnd_parent) {
        return;
    }

    int32_t cw = 0, ch = 0;
    ds_get_gl_host_target_size(hwnd_parent, &cw, &ch);

    RECT cur_rc = { 0, 0, 0, 0 };
    pfn_GetClientRect_t gcr = g_ds.real_GetClientRect ? g_ds.real_GetClientRect : GetClientRect;
    pfn_SetWindowPos_t swp = g_ds.real_SetWindowPos ? g_ds.real_SetWindowPos : SetWindowPos;
    ds_enter_internal();
    BOOL has_cur = gcr(host, &cur_rc);
    int32_t cur_w = cur_rc.right - cur_rc.left;
    int32_t cur_h = cur_rc.bottom - cur_rc.top;
    UINT flags = SWP_NOACTIVATE | SWP_NOCOPYBITS | (vis ? SWP_SHOWWINDOW : SWP_NOZORDER);
    swp(host, HWND_TOP, 0, 0, cw, ch, flags);
    ds_leave_internal();
    if (vis && (!has_cur || cur_w != cw || cur_h != ch)) {
        InterlockedExchange(&g_ds.gl_drawable_rebind_pending, 1);
    }
}

void ds_refresh_gl_host_drawable_on_owner_thread(HWND hwnd_parent)
{
    if (!hwnd_parent || !IsWindow(hwnd_parent)) {
        return;
    }

    ds_lock();
    if (ds_is_modern_tier_locked()) {
        ds_unlock();
        return;
    }
    HWND host = g_ds.hwnd_gl_host;
    bool vis = (g_ds.gl_host_visible || g_ds.gl_host_want_visible);
    ds_unlock();
    InterlockedExchange(&g_ds.gl_drawable_rebind_pending, 1);

    if (!host || !IsWindow(host) || GetParent(host) != hwnd_parent || !vis) {
        return;
    }

    int32_t cw = 0, ch = 0;
    ds_get_gl_host_target_size(hwnd_parent, &cw, &ch);
    if (cw <= 0 || ch <= 0) {
        return;
    }

    int32_t nudge_h = (ch > 1) ? (ch - 1) : ch;
    pfn_SetWindowPos_t swp = g_ds.real_SetWindowPos ? g_ds.real_SetWindowPos : SetWindowPos;
    ds_enter_internal();
    if (nudge_h != ch) {
        swp(host, HWND_TOP, 0, 0, cw, nudge_h, SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOCOPYBITS);
    }
    swp(host, HWND_TOP, 0, 0, cw, ch, SWP_NOACTIVATE | SWP_NOCOPYBITS | SWP_SHOWWINDOW);
    ds_leave_internal();
}

void ds_demote_fullscreen_on_deactivate(HWND target_hwnd)
{
    ds_lock();
    g_ds.app_inactive = true;
    ds_cursor_warp_reset(&g_ds.warp);
    ds_unlock();

    ds_enter_internal();
    if (GetCurrentThreadId() == g_ds.game_thread_id) {
        ds_ensure_fullscreen_styles_on_owner_thread(target_hwnd);
    }
    if (g_ds.real_SetWindowPos) {
        g_ds.real_SetWindowPos(target_hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
    if (g_ds.real_ClipCursor) {
        g_ds.real_ClipCursor(NULL);
    }
    ds_leave_internal();
}

static BOOL CALLBACK ds_register_gl_host_class_once_cb(PINIT_ONCE init_once, PVOID param, PVOID *ctx)
{
    (void)init_once;
    (void)param;
    (void)ctx;
    WNDCLASSEXW wc;
    memset(&wc, 0, sizeof(wc));
    wc.cbSize = sizeof(wc);
    wc.style = 0;
    wc.lpfnWndProc = ds_gl_host_wndproc;
    wc.hInstance = g_ds.self_hmod ? g_ds.self_hmod : GetModuleHandleW(NULL);
    wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    wc.lpszClassName = DS_GL_HOST_CHILD_CLASS_W;
    return (RegisterClassExW(&wc) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS) ? TRUE : FALSE;
}

void ds_ensure_gl_host_child_on_owner_thread(HWND hwnd_parent)
{
    if (!hwnd_parent || !IsWindow(hwnd_parent)) {
        return;
    }

    ds_lock();
    if (ds_is_modern_tier_locked()) {
        ds_unlock();
        return;
    }
    HWND cur_host = g_ds.hwnd_gl_host;
    ds_unlock();

    if (cur_host != NULL && IsWindow(cur_host) && GetParent(cur_host) == hwnd_parent) {
        ds_sync_gl_host_bounds_on_owner_thread(hwnd_parent);
        return;
    }

    if (cur_host != NULL) {
        ds_gl_release_all_host_dcs_for_hwnd(cur_host);
        if (IsWindow(cur_host)) {
            ds_enter_internal();
            DestroyWindow(cur_host);
            ds_leave_internal();
        }
    }

    static INIT_ONCE s_host_cls_once = INIT_ONCE_STATIC_INIT;
    InitOnceExecuteOnce(&s_host_cls_once, ds_register_gl_host_class_once_cb, NULL, NULL);

    int32_t cw = 0, ch = 0;
    ds_get_gl_host_target_size(hwnd_parent, &cw, &ch);

    /*
     * Do NOT set WS_DISABLED on OneLauncherGLHostChild: in Win32 / Wine win32u
     * (window_from_point), a visible WS_DISABLED child short-circuits hit-testing to
     * HTERROR (-2) before WM_NCHITTEST is ever sent, causing PeekMessage / mouse dispatch
     * to drop all WM_MOUSEMOVE and WM_LBUTTONDOWN events. Keeping the child enabled with
     * WM_NCHITTEST -> HTTRANSPARENT lets hit-testing pass cleanly through to hwnd_parent.
     */
    HINSTANCE hinst = g_ds.self_hmod ? g_ds.self_hmod : GetModuleHandleW(NULL);
    pfn_CreateWindowExW_t cwe = g_ds.real_CreateWindowExW ? g_ds.real_CreateWindowExW : CreateWindowExW;
    ds_enter_internal();
    HWND host = cwe(
        WS_EX_NOPARENTNOTIFY | WS_EX_TRANSPARENT,
        DS_GL_HOST_CHILD_CLASS_W,
        L"",
        WS_CHILD | WS_CLIPSIBLINGS,
        0,
        0,
        cw,
        ch,
        hwnd_parent,
        NULL,
        hinst,
        NULL
    );
    ds_leave_internal();

    ds_lock();
    g_ds.hwnd_gl_host = host;
    g_ds.gl_host_visible = false;
    ds_unlock();
}

static void ds_apply_gl_host_ctl_on_owner_thread(HWND hwnd_game, WPARAM mode, LPARAM expected_host)
{
    if (!hwnd_game || !IsWindow(hwnd_game)) {
        return;
    }

    if (mode == 1) {
        ds_lock();
        bool want_vis = g_ds.gl_host_want_visible;
        HWND cur_host = g_ds.hwnd_gl_host;
        g_ds.gl_host_hide_queued = false;
        ds_unlock();

        if (!want_vis) {
            return;
        }
        if (expected_host != 0 && cur_host != NULL && (HWND)(uintptr_t)expected_host != cur_host) {
            return;
        }

        ds_ensure_gl_host_child_on_owner_thread(hwnd_game);
        ds_lock();
        HWND host = g_ds.hwnd_gl_host;
        bool was_visible = g_ds.gl_host_visible;
        g_ds.gl_host_visible = (host != NULL && IsWindow(host));
        ds_unlock();

        if (host && IsWindow(host)) {
            if (!was_visible) {
                ds_refresh_gl_host_drawable_on_owner_thread(hwnd_game);
            } else {
                ds_sync_gl_host_bounds_on_owner_thread(hwnd_game);
            }
        }
        return;
    }

    ds_lock();
    HWND old_host = g_ds.hwnd_gl_host;
    bool was_visible = g_ds.gl_host_visible;
    g_ds.gl_host_visible = false;
    g_ds.gl_host_want_visible = false;
    g_ds.gl_host_hide_queued = false;
    if (!was_visible && old_host != NULL && IsWindow(old_host) && GetParent(old_host) == hwnd_game) {
        ds_unlock();
        return;
    }
    g_ds.hwnd_gl_host = NULL;
    ds_unlock();

    if (old_host) {
        ds_gl_release_all_host_dcs_for_hwnd(old_host);
        if (IsWindow(old_host)) {
            pfn_ShowWindow_t sw = g_ds.real_ShowWindow ? g_ds.real_ShowWindow : ShowWindow;
            ds_enter_internal();
            sw(old_host, SW_HIDE);
            DestroyWindow(old_host);
            ds_leave_internal();
        }
    }

    ds_ensure_gl_host_child_on_owner_thread(hwnd_game);
    InterlockedIncrement(&g_ds.gdi_margin_gen);
    ds_enter_internal();
    InvalidateRect(hwnd_game, NULL, FALSE);
    ds_leave_internal();
}

void ds_set_gl_host_visible(bool visible)
{
    bool should_post = false;
    ds_lock();
    HWND hwnd = g_ds.hwnd_game;
    HWND host = g_ds.hwnd_gl_host;
    DWORD owner_tid = g_ds.game_thread_id;
    UINT msg = g_ds.msg_gl_host_ctl;
    bool cur_vis = g_ds.gl_host_visible;
    bool prev_want = g_ds.gl_host_want_visible;
    g_ds.gl_host_want_visible = visible;
    if (visible) {
        g_ds.gl_host_hide_queued = false;
        should_post = !prev_want;
    } else if (!g_ds.gl_host_hide_queued && (cur_vis || prev_want)) {
        g_ds.gl_host_hide_queued = true;
        should_post = true;
    }
    ds_unlock();

    if (!hwnd || !IsWindow(hwnd)) return;
    if (visible && cur_vis && prev_want) return;
    if (!visible && !cur_vis && !prev_want) return;

    if (GetCurrentThreadId() == owner_tid) {
        ds_apply_gl_host_ctl_on_owner_thread(hwnd, visible ? 1 : 0, (LPARAM)(uintptr_t)host);
    } else if (msg != 0 && should_post) {
        PostMessageW(hwnd, msg, visible ? 1 : 0, (LPARAM)(uintptr_t)host);
    }
}

void ds_reset_gl_host_for_gdi(void)
{
    ds_set_gl_host_visible(false);
}

DS_ALWAYS_INLINE bool ds_has_dialog_child_controls(HWND hwnd)
{
    static const char k_dlg_cls_msz[] =
        "Button\0ComboBox\0Edit\0ListBox\0SysTabControl32\0"
        "SysListView32\0RichEdit20W\0RichEdit20A\0";
    HWND child = GetWindow(hwnd, GW_CHILD);
    for (int inspected = 0; child && inspected < 24; inspected++, child = GetWindow(child, GW_HWNDNEXT)) {
        if (!IsWindowVisible(child)) continue;
        WCHAR cls[64] = { 0 };
        if (GetClassNameW(child, cls, 63) > 0) {
            for (const char *p = k_dlg_cls_msz; *p != '\0'; p += strlen(p) + 1) {
                if (ds_wcs_ieq_ascii(cls, p)) return true;
            }
        }
    }
    return false;
}

static bool ds_wcs_has_ascii(const WCHAR *hay, const char *needle)
{
    if (!hay || !needle || !needle[0]) return false;
    for (; *hay; hay++) {
        const WCHAR *h = hay;
        const char *n = needle;
        while (*h && *n && *h == (WCHAR)(unsigned char)*n) { h++; n++; }
        if (*n == '\0') return true;
    }
    return false;
}

bool ds_is_candidate_game_window(HWND hwnd, int32_t *out_cw, int32_t *out_ch)
{
    if (out_cw) *out_cw = 0;
    if (out_ch) *out_ch = 0;
    if (!hwnd || !IsWindow(hwnd)) {
        return false;
    }

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != GetCurrentProcessId()) {
        return false;
    }

    LONG_PTR style = ds_get_wnd_long_ptr(hwnd, GWL_STYLE);
    LONG_PTR exstyle = ds_get_wnd_long_ptr(hwnd, GWL_EXSTYLE);
    if ((style & WS_CHILD) != 0 || (exstyle & WS_EX_TOOLWINDOW) != 0) {
        return false;
    }

    WCHAR cls[96] = { 0 };
    if (GetClassNameW(hwnd, cls, 95) > 0) {
        static const char k_skip_exact[] = "#32770\0IME\0MSCTFIME UI\0ConsoleWindowClass\0";
        static const char k_skip_sub[] = "WinConsole\0WineExplorer\0WineD3D\0DirectDrawDeviceWnd\0";
        for (const char *p = k_skip_exact; *p != '\0'; p += strlen(p) + 1) {
            if (ds_wcs_ieq_ascii(cls, p)) return false;
        }
        for (const char *p = k_skip_sub; *p != '\0'; p += strlen(p) + 1) {
            if (ds_wcs_has_ascii(cls, p)) return false;
        }
    }

    if (GetWindowThreadProcessId(hwnd, NULL) == GetCurrentThreadId()) {
        WCHAR title[96] = { 0 };
        if (GetWindowTextW(hwnd, title, 95) > 0 && ds_wcs_has_ascii(title, "Console")) {
            return false;
        }
    }

    ds_lock();
    bool mode_virt = g_ds.mode_virtualized;
    ds_unlock();
    if (!mode_virt && ds_has_dialog_child_controls(hwnd)) {
        return false;
    }

    RECT rc = { 0, 0, 0, 0 };
    pfn_GetClientRect_t gcr = g_ds.real_GetClientRect ? g_ds.real_GetClientRect : GetClientRect;
    ds_enter_internal();
    BOOL ok = gcr(hwnd, &rc);
    ds_leave_internal();
    if (!ok) {
        return false;
    }

    int32_t cw = rc.right - rc.left;
    int32_t ch = rc.bottom - rc.top;
    if (cw < 240 || ch < 180) {
        return false;
    }
    if (out_cw) *out_cw = cw;
    if (out_ch) *out_ch = ch;
    return true;
}

void ds_reapply_cursor_clip_locked(void)
{
    if (!g_ds.real_ClipCursor) return;
    if (g_ds.app_inactive || ds_is_passthrough_locked() || !g_ds.fullscreen_active) {
        g_ds.real_ClipCursor(NULL);
        return;
    }
    if (ds_is_modern_tier_locked() && !ds_is_vulkan_d3d9_subnative_locked()) {
        return;
    }
    int32_t scr_dst_x = g_ds.win_mon_x + g_ds.vp.dst_x;
    int32_t scr_dst_y = g_ds.win_mon_y + g_ds.vp.dst_y;
    if (g_ds.has_virtual_clip && g_ds.virt_w > 0 && g_ds.virt_h > 0 &&
        g_ds.vp.dst_w > 0 && g_ds.vp.dst_h > 0) {
        int32_t vw = g_ds.virtual_clip_rect.right - g_ds.virtual_clip_rect.left;
        int32_t vh = g_ds.virtual_clip_rect.bottom - g_ds.virtual_clip_rect.top;
        int32_t px = 0, py = 0, pw = 0, ph = 0;
        if (vw > 0 && vh > 0 &&
            ds_map_subrect_virt_to_phys(
                g_ds.virtual_clip_rect.left,
                g_ds.virtual_clip_rect.top,
                vw,
                vh,
                scr_dst_x,
                scr_dst_y,
                g_ds.vp.dst_w,
                g_ds.vp.dst_h,
                g_ds.virt_w,
                g_ds.virt_h,
                &px,
                &py,
                &pw,
                &ph)) {
            RECT phys_clip = { px, py, px + pw, py + ph };
            g_ds.real_ClipCursor(&phys_clip);
            return;
        }
    }
    if (g_ds.raw_mouse_nolegacy && g_ds.vp.dst_w > 0 && g_ds.vp.dst_h > 0) {
        RECT vp_clip = {
            scr_dst_x,
            scr_dst_y,
            scr_dst_x + g_ds.vp.dst_w,
            scr_dst_y + g_ds.vp.dst_h
        };
        g_ds.real_ClipCursor(&vp_clip);
    }
}

void ds_write_status_file(void)
{
    ds_lock();
    if (g_ds.status_file[0] == L'\0') {
        ds_unlock();
        return;
    }
    WCHAR path_buf[MAX_PATH];
    wcsncpy(path_buf, g_ds.status_file, MAX_PATH - 1);
    path_buf[MAX_PATH - 1] = L'\0';
    uint64_t seq = ++g_ds.status_seq;
#if defined(_WIN64)
    bool modern_fs = g_ds.modern_subnative_fs_expanded;
    bool fs_active = (g_ds.fullscreen_active && !ds_is_passthrough_locked()) || modern_fs;
#else
    bool fs_active = g_ds.fullscreen_active && !ds_is_passthrough_locked();
#endif
    bool passthrough = ds_is_passthrough_locked();
    const char *aspect_str = ds_aspect_mode_to_string(g_ds.aspect_mode);
    const char *filter_str = ds_scale_filter_to_string(g_ds.scale_filter);
    int32_t vw = g_ds.virt_w;
    int32_t vh = g_ds.virt_h;
    int32_t win_scale = ds_get_windowed_scale_locked();
#if defined(_WIN64)
    int32_t dw = modern_fs ? g_ds.real_screen_w : (fs_active ? g_ds.vp.dst_w : (vw * win_scale));
    int32_t dh = modern_fs ? g_ds.real_screen_h : (fs_active ? g_ds.vp.dst_h : (vh * win_scale));
#else
    int32_t dw = fs_active ? g_ds.vp.dst_w : (vw * win_scale);
    int32_t dh = fs_active ? g_ds.vp.dst_h : (vh * win_scale);
#endif
    ds_unlock();

    char json[448];
    int len = snprintf(
        json,
        sizeof(json),
        "{\"seq\":%llu,\"fullscreen\":%s,\"aspect\":\"%s\",\"filter\":\"%s\",\"passthrough\":%s,\"virtWidth\":%d,\"virtHeight\":%d,\"dstWidth\":%d,\"dstHeight\":%d}\n",
        (unsigned long long)seq,
        fs_active ? "true" : "false",
        aspect_str,
        filter_str,
        passthrough ? "true" : "false",
        (int)vw,
        (int)vh,
        (int)dw,
        (int)dh
    );
    if (len <= 0) return;
    size_t write_len = ((size_t)len < sizeof(json)) ? (size_t)len : (sizeof(json) - 1u);

    WCHAR tmp_path[MAX_PATH + 32];
    size_t tmp_cap = sizeof(tmp_path) / sizeof(WCHAR);
    int tn = _snwprintf(tmp_path, tmp_cap, L"%ls.tmp.%lu", path_buf, (unsigned long)GetCurrentThreadId());
    if (tn <= 0 || (size_t)tn >= tmp_cap) return;
    tmp_path[tmp_cap - 1] = L'\0';

    ds_enter_internal();
    HANDLE hf = CreateFileW(
        tmp_path,
        GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );
    if (hf != INVALID_HANDLE_VALUE) {
        DWORD written = 0;
        BOOL wok = WriteFile(hf, json, (DWORD)write_len, &written, NULL);
        CloseHandle(hf);
        if (!wok || written != (DWORD)write_len ||
            !MoveFileExW(tmp_path, path_buf, MOVEFILE_REPLACE_EXISTING)) {
            DeleteFileW(tmp_path);
        }
    }
    ds_leave_internal();
}

static void ds_drop_hwnd_topmost_and_unclip(HWND hwnd)
{
    if (g_ds.real_SetWindowPos) {
        ds_enter_internal();
        g_ds.real_SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        ds_leave_internal();
    }
    if (g_ds.real_ClipCursor) {
        g_ds.real_ClipCursor(NULL);
    }
}

static LRESULT ds_forward_to_orig_wndproc(WNDPROC orig, bool is_unicode, HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    if (!orig) {
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
    /*
     * Suspend `tls_depth_idx` before handing execution to external WndProc handlers
     * (`wined3d_wndproc`, SDL, or the game's own WndProc) so synchronous re-entrant calls
     * they make inside `WM_WINDOWPOSCHANGED`, `WM_SIZE`, or `WM_ACTIVATEAPP` observe
     * virtualized metrics (`GetClientRect` / `GetSystemMetrics`) and pass through our
     * `SetWindowPos` / `MoveWindow` / `ShowWindow` fullscreen guards instead of bypassing them.
     */
    uintptr_t saved_internal = ds_suspend_internal_depth();
    LRESULT res = is_unicode
        ? CallWindowProcW(orig, hwnd, msg, wParam, lParam)
        : CallWindowProcA(orig, hwnd, msg, wParam, lParam);
    ds_restore_internal_depth(saved_internal);
    return res;
}

static void ds_reset_hwnd_tracking_locked(bool is_passive)
{
    g_ds.orig_wndproc = NULL;
    g_ds.has_saved_window_state = false;
    g_ds.has_saved_class_bg = false;
    g_ds.has_saved_hmenu = false;
    g_ds.saved_hmenu = NULL;
    g_ds.gl_host_hide_queued = false;
    g_ds.cocoa_fs_synced = false;
    g_ds.app_inactive = false;
    g_ds.visible_resync_needed = false;
    g_ds.visible_resync_done = false;
    g_ds.first_visible_tick = 0;
    g_ds.last_hit_probe_tick = 0;
    g_ds.consec_resync_attempts = 0;
    g_ds.borderless_active = false;
    g_ds.modern_subnative_fs_expanded = false;
    g_ds.window_mutated_by_scaler = false;
    g_ds.passthrough_restored = is_passive;
}

void ds_compute_fs_styles(LONG_PTR saved_style, LONG_PTR saved_exstyle, bool app_inactive, LONG_PTR *out_style, LONG_PTR *out_ex)
{
    *out_style = (saved_style & ~(LONG_PTR)(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_DLGFRAME | WS_BORDER | WS_MAXIMIZE | WS_MINIMIZE))
               | (LONG_PTR)(WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN);
    LONG_PTR ex = (saved_exstyle & ~(LONG_PTR)(WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE | WS_EX_TOPMOST));
    if (!app_inactive) {
        ex |= (LONG_PTR)WS_EX_TOPMOST;
    }
    *out_ex = ex;
}

void ds_set_hwnd_orig_wndproc_props(HWND hwnd, WNDPROC orig, bool is_unicode)
{
    if (!hwnd || !orig || orig == ds_game_subclass_wndproc) {
        return;
    }
    SetPropW(hwnd, DS_PROP_ORIG_PROC_W, (HANDLE)(uintptr_t)orig);
    SetPropW(hwnd, DS_PROP_ORIG_UNI_W, (HANDLE)(uintptr_t)(is_unicode ? 2u : 1u));
}

static void ds_unsubclass_hwnd(HWND hwnd, WNDPROC orig, bool is_unicode)
{
    if (orig && orig != ds_game_subclass_wndproc &&
        (WNDPROC)ds_get_wnd_long_ptr(hwnd, GWLP_WNDPROC) == ds_game_subclass_wndproc) {
        ds_enter_internal();
        ds_set_wnd_long_ptr_raw(hwnd, GWLP_WNDPROC, (LONG_PTR)orig, is_unicode);
        ds_leave_internal();
    }
    RemovePropW(hwnd, DS_PROP_ORIG_PROC_W);
    RemovePropW(hwnd, DS_PROP_ORIG_UNI_W);
}

static bool ds_remap_wnd_mouse_lparam(
    HWND hwnd,
    UINT msg,
    WPARAM wParam,
    LPARAM *lp,
    int32_t dx,
    int32_t dy,
    int32_t dw,
    int32_t dh,
    int32_t vw,
    int32_t vh,
    int32_t mon_x,
    int32_t mon_y,
    bool win_scaled
)
{
    switch (msg) {
        case WM_MOUSEMOVE:
        case WM_LBUTTONDOWN:
        case WM_LBUTTONUP:
        case WM_LBUTTONDBLCLK:
        case WM_RBUTTONDOWN:
        case WM_RBUTTONUP:
        case WM_RBUTTONDBLCLK:
        case WM_MBUTTONDOWN:
        case WM_MBUTTONUP:
        case WM_MBUTTONDBLCLK:
        case WM_XBUTTONDOWN:
        case WM_XBUTTONUP: {
            int32_t cx = (int32_t)(short)LOWORD(*lp);
            int32_t cy = (int32_t)(short)HIWORD(*lp);
            int32_t vx = cx, vy = cy;
            if (ds_map_cursor_phys_to_virt(cx, cy, dx, dy, dw, dh, vw, vh, &vx, &vy)) {
                *lp = MAKELPARAM((WORD)(short)vx, (WORD)(short)vy);
            }
            return false;
        }
        case WM_MOUSEWHEEL:
        case WM_MOUSEHWHEEL:
        case WM_CONTEXTMENU:
        case WM_NCHITTEST: {
            if (msg == WM_CONTEXTMENU && *lp == (LPARAM)-1) {
                return false;
            }
            int32_t sx = (int32_t)(short)LOWORD(*lp);
            int32_t sy = (int32_t)(short)HIWORD(*lp);
            if (win_scaled) {
                if (g_ds.real_ClientToScreen) {
                    POINT orig_pt = { 0, 0 };
                    ds_enter_internal();
                    BOOL has_orig = g_ds.real_ClientToScreen(hwnd, &orig_pt);
                    ds_leave_internal();
                    if (has_orig) {
                        int32_t rel_x = sx - orig_pt.x;
                        int32_t rel_y = sy - orig_pt.y;
                        if (msg != WM_NCHITTEST || (rel_x >= 0 && rel_x < dw && rel_y >= 0 && rel_y < dh)) {
                            int32_t rvx = rel_x, rvy = rel_y;
                            if (ds_map_cursor_phys_to_virt(rel_x, rel_y, 0, 0, dw, dh, vw, vh, &rvx, &rvy)) {
                                *lp = MAKELPARAM((WORD)(short)(orig_pt.x + rvx), (WORD)(short)(orig_pt.y + rvy));
                            }
                        }
                    }
                }
                return false;
            }
            int32_t vx = sx, vy = sy;
            if (ds_map_cursor_phys_to_virt(sx, sy, mon_x + dx, mon_y + dy, dw, dh, vw, vh, &vx, &vy)) {
                *lp = MAKELPARAM((WORD)(short)vx, (WORD)(short)vy);
            }
            return (msg == WM_NCHITTEST);
        }
        case WM_SIZE:
            if (wParam != SIZE_MINIMIZED) {
                *lp = MAKELPARAM((WORD)vw, (WORD)vh);
            }
            return false;
        default:
            return false;
    }
}

static LRESULT ds_handle_fs_nchittest(WNDPROC orig, bool is_unicode, HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    if (!orig) {
        return HTCLIENT;
    }
    uintptr_t saved_ht_depth = ds_suspend_internal_depth();
    LRESULT ht_res = is_unicode
        ? CallWindowProcW(orig, hwnd, msg, wParam, lParam)
        : CallWindowProcA(orig, hwnd, msg, wParam, lParam);
    ds_restore_internal_depth(saved_ht_depth);
    if (ht_res == HTNOWHERE || ht_res == HTCAPTION || (ht_res >= HTSIZEFIRST && ht_res <= HTSIZELAST)) {
        return HTCLIENT;
    }
    return ht_res;
}

LRESULT CALLBACK ds_game_subclass_wndproc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    WNDPROC prop_orig = (WNDPROC)(uintptr_t)GetPropW(hwnd, DS_PROP_ORIG_PROC_W);
    uintptr_t prop_uni = (uintptr_t)GetPropW(hwnd, DS_PROP_ORIG_UNI_W);

    ds_lock();
    bool is_cur_game = (hwnd == g_ds.hwnd_game);
    bool use_live = (is_cur_game && g_ds.orig_wndproc != NULL);
    WNDPROC orig = use_live ? g_ds.orig_wndproc : prop_orig;
    bool is_unicode = use_live
        ? g_ds.orig_wndproc_unicode
        : ((prop_uni != 0) ? (prop_uni == 2u) : (IsWindowUnicode(hwnd) != FALSE));
    ds_unlock();
    if (orig == ds_game_subclass_wndproc) {
        orig = NULL;
    }

    /* If g_ds.hwnd_game moved to a newer window, unsubclass this stale HWND cleanly */
    if (!is_cur_game && msg != WM_NCDESTROY) {
        ds_unsubclass_hwnd(hwnd, orig, is_unicode);
        return ds_forward_to_orig_wndproc(orig, is_unicode, hwnd, msg, wParam, lParam);
    }

    if (g_ds.msg_apply_presentation != 0 && msg == g_ds.msg_apply_presentation) {
        if (wParam == (WPARAM)DS_APPLY_RESTORE_PASSTHROUGH) {
            ds_restore_window_on_passthrough(hwnd);
        } else {
            ds_apply_window_presentation_on_owner_thread(hwnd);
        }
        return 0;
    }
    if (g_ds.msg_gl_host_ctl != 0 && msg == g_ds.msg_gl_host_ctl) {
        ds_apply_gl_host_ctl_on_owner_thread(hwnd, wParam, lParam);
        return 0;
    }

    if (g_ds.hotkey_enabled && (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) && ((lParam & (1L << 30)) == 0)) {
        bool ctrl_down = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
        bool alt_down  = (GetKeyState(VK_MENU) & 0x8000) != 0;
        if (ctrl_down && alt_down && (wParam == 'F' || wParam == 'A')) {
            RECT cur_rc = { 0, 0, 0, 0 };
            BOOL has_cur_rc = (wParam == 'F') ? ds_get_rect_dpi(hwnd, &cur_rc, false) : FALSE;
            ds_lock();
            if (wParam == 'F') {
                bool cur_fs = g_ds.fullscreen_active;
                if (ds_is_modern_tier_locked()) {
                    bool native_full = (
                        g_ds.presenter_tier == DS_PRESENTER_MODERN_PASSTHROUGH &&
                        has_cur_rc &&
                        g_ds.real_screen_w > 0 && g_ds.real_screen_h > 0 &&
                        (cur_rc.right - cur_rc.left) >= g_ds.real_screen_w &&
                        (cur_rc.bottom - cur_rc.top) >= g_ds.real_screen_h
                    );
                    cur_fs = g_ds.borderless_active || native_full;
#if defined(_WIN64)
                    cur_fs = cur_fs || g_ds.modern_subnative_fs_expanded;
#endif
                }
                bool next_fs = !cur_fs;
                g_ds.fullscreen_active = next_fs;
                g_ds.user_forced_windowed = !next_fs;
                g_ds.user_forced_fullscreen = next_fs;
#if defined(_WIN64)
                if (!next_fs) {
                    g_ds.modern_subnative_fs_expanded = false;
                }
#endif
                (void)ds_update_presenter_tier_locked();
                g_ds.cocoa_fs_synced = false;
                g_ds.app_inactive = false;
                if (g_ds.presenter_tier == DS_PRESENTER_LEGACY_VIRTUAL &&
                    g_ds.fullscreen_active && (g_ds.virt_w <= 0 || g_ds.virt_h <= 0)) {
                    g_ds.virt_w = g_ds.saved_client_w > 0 ? g_ds.saved_client_w : 640;
                    g_ds.virt_h = g_ds.saved_client_h > 0 ? g_ds.saved_client_h : 480;
                }
            } else {
                g_ds.aspect_mode = ds_cycle_aspect_mode(g_ds.aspect_mode);
            }
            ds_refresh_viewport_locked();
            ds_cursor_warp_reset(&g_ds.warp);
            ds_unlock();

            ds_apply_window_presentation_on_owner_thread(hwnd);
            ds_write_status_file();
            return 0;
        }
    }

    if (msg == WM_NCDESTROY) {
        ds_unsubclass_hwnd(hwnd, orig, is_unicode);

        HWND dead_host = NULL;
        ds_lock();
        if (hwnd == g_ds.hwnd_game) {
            dead_host = g_ds.hwnd_gl_host;
            g_ds.hwnd_game = NULL;
            g_ds.hwnd_gl_host = NULL;
            g_ds.gl_host_visible = false;
            g_ds.gl_host_want_visible = false;
            ds_reset_hwnd_tracking_locked(false);
        }
        ds_unlock();
        if (dead_host) {
            ds_gl_release_all_host_dcs_for_hwnd(dead_host);
        }
        EnumWindows(ds_enum_adopt_window_cb, 0);
        return ds_forward_to_orig_wndproc(orig, is_unicode, hwnd, msg, wParam, lParam);
    }

    ds_lock();
    ds_presenter_tier_t tier = (g_ds.scaling_mode == DS_MODE_PASSTHROUGH)
        ? DS_PRESENTER_MODERN_PASSTHROUGH
        : g_ds.presenter_tier;
    bool is_target_hwnd = (hwnd == g_ds.hwnd_game);
    bool borderless_active = (tier == DS_PRESENTER_MODERN_BORDERLESS && is_target_hwnd && g_ds.borderless_active);
    bool vk_subnative = (tier == DS_PRESENTER_MODERN_BORDERLESS && is_target_hwnd && ds_is_vulkan_d3d9_subnative_locked());
    bool fs_active = (tier == DS_PRESENTER_LEGACY_VIRTUAL && is_target_hwnd && g_ds.fullscreen_active);
    int32_t win_scale = (tier == DS_PRESENTER_LEGACY_VIRTUAL && is_target_hwnd && !g_ds.fullscreen_active)
        ? ds_get_windowed_scale_locked()
        : 1;
    int32_t vw = g_ds.virt_w;
    int32_t vh = g_ds.virt_h;
    int32_t mon_x = g_ds.win_mon_x;
    int32_t mon_y = g_ds.win_mon_y;
    int32_t mon_w = g_ds.real_screen_w;
    int32_t mon_h = g_ds.real_screen_h;
    ds_viewport_t vp = g_ds.vp;
    bool has_menu_win = (g_ds.has_saved_hmenu && g_ds.saved_hmenu != NULL);
#if defined(_WIN64)
    ds_scaling_mode_t scaling_mode = g_ds.scaling_mode;
    bool user_forced_win = g_ds.user_forced_windowed;
    bool app_inactive = g_ds.app_inactive;
    bool modern_fs_expanded = g_ds.modern_subnative_fs_expanded;
    HMONITOR target_mon = g_ds.target_monitor;
#endif
    ds_unlock();

    /* Tier 1 (Modern Full Passthrough): transparent forwarding + 64-bit sub-native exclusive-FS guard */
    if (tier == DS_PRESENTER_MODERN_PASSTHROUGH) {
#if defined(_WIN64)
        if (is_target_hwnd && scaling_mode == DS_MODE_AUTO_FULLSCREEN && !user_forced_win) {
            const LONG_PTR k_chrome_mask = (LONG_PTR)(WS_CAPTION | WS_THICKFRAME | WS_DLGFRAME | WS_BORDER);
            if (msg == WM_WINDOWPOSCHANGING && !ds_is_internal_call() && lParam != 0) {
                WINDOWPOS *wp = (WINDOWPOS *)lParam;
                LONG_PTR style = ds_get_wnd_long_ptr(hwnd, GWL_STYLE);
                LONG_PTR exstyle = ds_get_wnd_long_ptr(hwnd, GWL_EXSTYLE);
                if ((style & k_chrome_mask) != 0 ||
                    ((wp->flags & SWP_NOZORDER) == 0 && wp->hwndInsertAfter == HWND_NOTOPMOST)) {
                    if (modern_fs_expanded) {
                        ds_lock();
                        g_ds.modern_subnative_fs_expanded = false;
                        ds_unlock();
                    }
                } else if (!app_inactive && ((wp->flags & (SWP_NOSIZE | SWP_NOMOVE)) != (SWP_NOSIZE | SWP_NOMOVE))) {
                    HMONITOR cur_mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                    if (mon_w <= 0 || mon_h <= 0 || (cur_mon != NULL && cur_mon != target_mon)) {
                        ds_refresh_host_display_metrics_for_hwnd(hwnd);
                        ds_lock();
                        mon_x = g_ds.win_mon_x;
                        mon_y = g_ds.win_mon_y;
                        mon_w = g_ds.real_screen_w;
                        mon_h = g_ds.real_screen_h;
                        ds_unlock();
                    }
                    RECT cur_rc = { 0, 0, 0, 0 };
                    BOOL has_cur_rc = ((wp->flags & (SWP_NOMOVE | SWP_NOSIZE)) != 0)
                        ? ds_get_rect_dpi(hwnd, &cur_rc, false)
                        : FALSE;
                    int32_t cand_x = ((wp->flags & SWP_NOMOVE) == 0) ? wp->x : (has_cur_rc ? cur_rc.left : mon_x);
                    int32_t cand_y = ((wp->flags & SWP_NOMOVE) == 0) ? wp->y : (has_cur_rc ? cur_rc.top : mon_y);
                    int32_t cand_w = ((wp->flags & SWP_NOSIZE) == 0) ? wp->cx : (has_cur_rc ? (cur_rc.right - cur_rc.left) : 0);
                    int32_t cand_h = ((wp->flags & SWP_NOSIZE) == 0) ? wp->cy : (has_cur_rc ? (cur_rc.bottom - cur_rc.top) : 0);
                    bool is_topmost_target = ((wp->flags & SWP_NOZORDER) == 0 && wp->hwndInsertAfter == HWND_TOPMOST);
                    bool is_vis = ((wp->flags & SWP_SHOWWINDOW) != 0) || (IsWindowVisible(hwnd) != FALSE);
                    WCHAR cls[16] = { 0 };
                    bool is_dialog_cls = (GetClassNameW(hwnd, cls, 15) > 0 && ds_wcs_ieq_ascii(cls, "#32770"));
                    if (ds_is_subnative_exclusive_fullscreen_window(
                            cand_x, cand_y, cand_w, cand_h,
                            mon_x, mon_y, mon_w, mon_h,
                            (uint32_t)style, (uint32_t)exstyle,
                            is_topmost_target, is_vis, IsIconic(hwnd) != FALSE, is_dialog_cls)) {
                        wp->x = mon_x;
                        wp->y = mon_y;
                        wp->cx = mon_w;
                        wp->cy = mon_h;
                        wp->flags &= ~(UINT)(SWP_NOMOVE | SWP_NOSIZE);
                        ds_lock();
                        g_ds.modern_subnative_fs_expanded = true;
                        ds_unlock();
                        if (g_ds.trace_file[0] != L'\0') {
                            static volatile LONG s_mfs_logs = 0;
                            if (InterlockedIncrement(&s_mfs_logs) <= 16) {
                                ds_tracef("modern_fs_expand: %dx%d->%dx%d", (int)cand_w, (int)cand_h, (int)mon_w, (int)mon_h);
                            }
                        }
                    }
                }
            } else if (msg == WM_STYLECHANGED && wParam == (WPARAM)GWL_STYLE && modern_fs_expanded && lParam != 0) {
                const STYLESTRUCT *ss = (const STYLESTRUCT *)lParam;
                if ((ss->styleNew & (DWORD)(WS_CAPTION | WS_THICKFRAME | WS_DLGFRAME | WS_BORDER)) != 0) {
                    ds_lock();
                    g_ds.modern_subnative_fs_expanded = false;
                    ds_unlock();
                }
            } else if (msg == WM_GETMINMAXINFO && modern_fs_expanded && lParam != 0) {
                LRESULT r = ds_forward_to_orig_wndproc(orig, is_unicode, hwnd, msg, wParam, lParam);
                MINMAXINFO *mmi = (MINMAXINFO *)lParam;
                if (mon_w > 0 && mmi->ptMaxTrackSize.x < mon_w) mmi->ptMaxTrackSize.x = mon_w;
                if (mon_h > 0 && mmi->ptMaxTrackSize.y < mon_h) mmi->ptMaxTrackSize.y = mon_h;
                return r;
            } else if (msg == WM_ACTIVATEAPP && modern_fs_expanded) {
                if (wParam == FALSE) {
                    ds_lock();
                    g_ds.app_inactive = true;
                    ds_unlock();
                    ds_drop_hwnd_topmost_and_unclip(hwnd);
                } else {
                    ds_lock();
                    g_ds.app_inactive = false;
                    int32_t bx = g_ds.win_mon_x;
                    int32_t by = g_ds.win_mon_y;
                    int32_t bw = g_ds.real_screen_w;
                    int32_t bh = g_ds.real_screen_h;
                    ds_unlock();
                    LONG_PTR st = ds_get_wnd_long_ptr(hwnd, GWL_STYLE);
                    if (bw > 0 && bh > 0 && (st & (k_chrome_mask | (LONG_PTR)WS_CHILD)) == 0) {
                        ds_set_window_pos_dpi(hwnd, HWND_TOPMOST, bx, by, bw, bh, SWP_SHOWWINDOW | SWP_NOACTIVATE, true);
                    }
                }
            } else if (msg == WM_DISPLAYCHANGE && modern_fs_expanded && !ds_is_internal_call()) {
                ds_refresh_host_display_metrics_for_hwnd(hwnd);
                ds_apply_window_presentation_on_owner_thread(hwnd);
            }
        }
#endif
        return ds_forward_to_orig_wndproc(orig, is_unicode, hwnd, msg, wParam, lParam);
    }

    /* Tier 2 (Modern Native Borderless): display/focus upkeep + sub-native Vulkan D3D9 input remap */
    if (tier == DS_PRESENTER_MODERN_BORDERLESS) {
        if (msg == WM_DISPLAYCHANGE && !ds_is_internal_call()) {
            ds_refresh_host_display_metrics_for_hwnd(hwnd);
            if (borderless_active) {
                ds_apply_window_presentation_on_owner_thread(hwnd);
            }
        } else if (msg == WM_ACTIVATEAPP && borderless_active) {
            if (wParam == FALSE) {
                ds_lock();
                g_ds.app_inactive = true;
                ds_unlock();
                ds_drop_hwnd_topmost_and_unclip(hwnd);
            } else {
                ds_lock();
                g_ds.app_inactive = false;
                int32_t bx = g_ds.win_mon_x;
                int32_t by = g_ds.win_mon_y;
                int32_t bw = g_ds.real_screen_w;
                int32_t bh = g_ds.real_screen_h;
                ds_unlock();
                if (bw > 0 && bh > 0) {
                    ds_set_window_pos_dpi(hwnd, HWND_TOPMOST, bx, by, bw, bh, SWP_SHOWWINDOW | SWP_NOACTIVATE, false);
                }
            }
        } else if (vk_subnative && vw > 0 && vh > 0 && vp.dst_w > 0 && vp.dst_h > 0) {
            if (ds_remap_wnd_mouse_lparam(hwnd, msg, wParam, &lParam, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, vw, vh, mon_x, mon_y, false)) {
                return ds_handle_fs_nchittest(orig, is_unicode, hwnd, msg, wParam, lParam);
            }
        }
        return ds_forward_to_orig_wndproc(orig, is_unicode, hwnd, msg, wParam, lParam);
    }

    if (!fs_active && win_scale > 1 && vw > 0 && vh > 0) {
        ds_remap_wnd_mouse_lparam(hwnd, msg, wParam, &lParam, 0, 0, vw * win_scale, vh * win_scale, vw, vh, 0, 0, true);
        if (msg == WM_WINDOWPOSCHANGING) {
            if (!ds_is_internal_call() && lParam != 0) {
                WINDOWPOS *wp = (WINDOWPOS *)lParam;
                if ((wp->flags & SWP_NOSIZE) == 0) {
                    DWORD cur_style = (DWORD)ds_get_wnd_long_ptr(hwnd, GWL_STYLE);
                    DWORD cur_exstyle = (DWORD)ds_get_wnd_long_ptr(hwnd, GWL_EXSTYLE);
                    RECT wrc = { 0, 0, vw * win_scale, vh * win_scale };
                    if (g_ds.real_AdjustWindowRectEx) {
                        g_ds.real_AdjustWindowRectEx(&wrc, cur_style, has_menu_win ? TRUE : FALSE, cur_exstyle);
                    }
                    int32_t ww = wrc.right - wrc.left;
                    int32_t wh = wrc.bottom - wrc.top;
                    if (wp->cx < ww - 16 || wp->cy < wh - 16) {
                        wp->cx = ww;
                        wp->cy = wh;
                    }
                }
            }
        } else if (msg == WM_DISPLAYCHANGE && !ds_is_internal_call()) {
            ds_refresh_host_display_metrics_for_hwnd(hwnd);
        }
    }

    if (fs_active && vw > 0 && vh > 0 && vp.dst_w > 0 && vp.dst_h > 0) {
        if (ds_remap_wnd_mouse_lparam(hwnd, msg, wParam, &lParam, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, vw, vh, mon_x, mon_y, false)) {
            return ds_handle_fs_nchittest(orig, is_unicode, hwnd, msg, wParam, lParam);
        }
        switch (msg) {
            case WM_ERASEBKGND: {
                HDC hdc = (HDC)wParam;
                if (hdc) {
                    RECT rc = { 0, 0, mon_w, mon_h };
                    FillRect(hdc, &rc, (HBRUSH)GetStockObject(BLACK_BRUSH));
                }
                InterlockedIncrement(&g_ds.gdi_margin_gen);
                return 1;
            }
            case WM_GETMINMAXINFO:
                if (lParam != 0) {
                    MINMAXINFO *mmi = (MINMAXINFO *)lParam;
                    mmi->ptMaxPosition.x = mon_x;
                    mmi->ptMaxPosition.y = mon_y;
                    mmi->ptMaxSize.x = mon_w;
                    mmi->ptMaxSize.y = mon_h;
                    mmi->ptMaxTrackSize.x = mon_w;
                    mmi->ptMaxTrackSize.y = mon_h;
                    return 0;
                }
                break;
            case WM_STYLECHANGING:
                if (!ds_is_internal_call() && wParam == (WPARAM)GWL_STYLE && lParam != 0) {
                    STYLESTRUCT *ss = (STYLESTRUCT *)lParam;
                    LONG_PTR fs_st = 0, fs_ex = 0;
                    ds_compute_fs_styles((LONG_PTR)ss->styleNew, 0, false, &fs_st, &fs_ex);
                    ss->styleNew = (DWORD)fs_st;
                    return 0;
                }
                break;
            case WM_WINDOWPOSCHANGING: {
                ds_lock();
                bool staging_birth = !g_ds.cocoa_fs_synced && g_ds.first_visible_tick != 0 &&
                                     (GetTickCount() - g_ds.first_visible_tick) < 250;
                ds_unlock();
                if (!ds_is_internal_call() && !staging_birth && lParam != 0) {
                    WINDOWPOS *wp = (WINDOWPOS *)lParam;
                    if ((wp->flags & SWP_NOMOVE) == 0) {
                        wp->x = mon_x;
                        wp->y = mon_y;
                    }
                    if ((wp->flags & SWP_NOSIZE) == 0) {
                        wp->cx = mon_w;
                        wp->cy = mon_h;
                    }
                }
                break;
            }
            case WM_DISPLAYCHANGE:
                if (!ds_is_internal_call()) {
                    ds_refresh_host_display_metrics_for_hwnd(hwnd);
                    ds_apply_window_presentation_on_owner_thread(hwnd);
                }
                return 0;
            case WM_SYSCOMMAND:
                if ((wParam & 0xFFF0) == SC_MINIMIZE) {
                    ds_demote_fullscreen_on_deactivate(hwnd);
                    return 0;
                }
                break;
            case WM_ENABLE:
                if (wParam == FALSE) {
                    ds_drop_hwnd_topmost_and_unclip(hwnd);
                } else {
                    ds_lock();
                    bool active_now = !g_ds.app_inactive;
                    ds_unlock();
                    if (active_now) {
                        ds_request_apply_presentation();
                    }
                }
                break;
            case WM_ACTIVATEAPP:
                if (wParam == FALSE) {
                    ds_lock();
                    g_ds.app_inactive = true;
                    ds_cursor_warp_reset(&g_ds.warp);
                    ds_unlock();
                    ds_ensure_fullscreen_styles_on_owner_thread(hwnd);
                    /* ds_drop_hwnd_topmost_and_unclip demotes HWND_NOTOPMOST and calls real_ClipCursor(NULL) */
                    ds_drop_hwnd_topmost_and_unclip(hwnd);
                } else {
                    ds_lock();
                    g_ds.app_inactive = false;
                    ds_cursor_warp_reset(&g_ds.warp);
                    bool staging_birth = !g_ds.cocoa_fs_synced && g_ds.first_visible_tick != 0 &&
                                         (GetTickCount() - g_ds.first_visible_tick) < 250;
                    int32_t ax = g_ds.win_mon_x;
                    int32_t ay = g_ds.win_mon_y;
                    int32_t aw = g_ds.real_screen_w;
                    int32_t ah = g_ds.real_screen_h;
                    ds_unlock();
                    if (!staging_birth) {
                        ds_ensure_fullscreen_styles_on_owner_thread(hwnd);
                        if (g_ds.real_SetWindowPos) {
                            HANDLE prev_dpi = ds_dpi_guard_enter_for_hwnd(hwnd);
                            ds_enter_internal();
                            ds_clear_wine_present_rect_on_hwnd(hwnd);
                            g_ds.real_SetWindowPos(
                                hwnd,
                                HWND_TOPMOST,
                                ax,
                                ay,
                                aw,
                                ah,
                                SWP_FRAMECHANGED | SWP_SHOWWINDOW
                            );
                            BringWindowToTop(hwnd);
                            SetForegroundWindow(hwnd);
                            SetActiveWindow(hwnd);
                            SetFocus(hwnd);
                            InvalidateRect(hwnd, NULL, FALSE);
                            ds_leave_internal();
                            ds_dpi_guard_leave(prev_dpi);
                        }
                        ds_refresh_gl_host_drawable_on_owner_thread(hwnd);
                    }
                    ds_lock();
                    ds_reapply_cursor_clip_locked();
                    ds_unlock();
                }
                break;
            default:
                break;
        }
    }

    return ds_forward_to_orig_wndproc(orig, is_unicode, hwnd, msg, wParam, lParam);
}

#if defined(__GNUC__) || defined(__clang__)
__attribute__((noinline))
#endif
static void ds_capture_window_baseline_and_subclass(HWND hwnd)
{
    if (!hwnd || !IsWindow(hwnd)) return;

    ds_lock();
    if (g_ds.hwnd_game != hwnd) {
        ds_unlock();
        return;
    }
    bool need_state = !g_ds.has_saved_window_state;
    bool need_menu = !g_ds.has_saved_hmenu;
    bool need_bg = !g_ds.has_saved_class_bg;
    bool need_subclass = (g_ds.orig_wndproc == NULL);
    ds_unlock();

    if (!need_state && !need_menu && !need_bg && !need_subclass) {
        return;
    }

    LONG_PTR s_style = 0, s_ex = 0, s_bg = 0;
    RECT s_wrc = { 0, 0, 0, 0 };
    int32_t s_cw = 0, s_ch = 0;
    HMENU s_menu = NULL;
    WNDPROC s_orig = NULL;
    bool s_uni = false;

    if (need_state) {
        HANDLE prev_dpi = ds_dpi_guard_enter_for_hwnd(hwnd);
        ds_enter_internal();
        s_style = ds_get_wnd_long_ptr(hwnd, GWL_STYLE);
        s_ex = ds_get_wnd_long_ptr(hwnd, GWL_EXSTYLE);
        if (g_ds.real_GetWindowRect) {
            g_ds.real_GetWindowRect(hwnd, &s_wrc);
        }
        RECT crc = { 0, 0, 0, 0 };
        if (g_ds.real_GetClientRect && g_ds.real_GetClientRect(hwnd, &crc)) {
            s_cw = crc.right - crc.left;
            s_ch = crc.bottom - crc.top;
        }
        ds_leave_internal();
        ds_dpi_guard_leave(prev_dpi);
    }
    if (need_menu) {
        s_menu = GetMenu(hwnd);
    }
    if (need_bg) {
        s_bg = ds_get_class_bg_brush(hwnd);
    }
    if (need_subclass) {
        s_uni = (IsWindowUnicode(hwnd) != FALSE);
        WNDPROC cur_proc = (WNDPROC)ds_get_wnd_long_ptr(hwnd, GWLP_WNDPROC);
        if (cur_proc == ds_game_subclass_wndproc) {
            s_orig = (WNDPROC)(uintptr_t)GetPropW(hwnd, DS_PROP_ORIG_PROC_W);
        } else {
            /* Pre-seed per-HWND props BEFORE SetWindowLongPtr so cross-thread owner dispatch never sees NULL */
            ds_set_hwnd_orig_wndproc_props(hwnd, cur_proc, s_uni);
            ds_enter_internal();
            s_orig = (WNDPROC)ds_set_wnd_long_ptr_raw(
                hwnd,
                GWLP_WNDPROC,
                (LONG_PTR)ds_game_subclass_wndproc,
                s_uni
            );
            ds_leave_internal();
            if (s_orig == ds_game_subclass_wndproc) {
                s_orig = (WNDPROC)(uintptr_t)GetPropW(hwnd, DS_PROP_ORIG_PROC_W);
            } else if (s_orig != NULL && s_orig != cur_proc) {
                ds_set_hwnd_orig_wndproc_props(hwnd, s_orig, s_uni);
            } else if (s_orig == NULL) {
                RemovePropW(hwnd, DS_PROP_ORIG_PROC_W);
                RemovePropW(hwnd, DS_PROP_ORIG_UNI_W);
            }
        }
    }

    ds_lock();
    if (g_ds.hwnd_game == hwnd) {
        if (need_state && !g_ds.has_saved_window_state) {
            g_ds.saved_style = s_style;
            g_ds.saved_exstyle = s_ex;
            g_ds.saved_window_rect = s_wrc;
            g_ds.saved_client_w = s_cw;
            g_ds.saved_client_h = s_ch;
            g_ds.has_saved_window_state = true;
        }
        if (need_menu && !g_ds.has_saved_hmenu) {
            g_ds.saved_hmenu = s_menu;
            g_ds.has_saved_hmenu = true;
        }
        if (need_bg && !g_ds.has_saved_class_bg) {
            g_ds.saved_class_bg = s_bg;
            g_ds.has_saved_class_bg = true;
        }
        if (need_subclass && g_ds.orig_wndproc == NULL && s_orig != NULL) {
            g_ds.orig_wndproc = s_orig;
            g_ds.orig_wndproc_unicode = s_uni;
        }
    }
    ds_unlock();
}

void ds_ensure_fullscreen_styles_on_owner_thread(HWND hwnd)
{
    if (!hwnd || !IsWindow(hwnd)) return;

    ds_capture_window_baseline_and_subclass(hwnd);

    ds_lock();
    if (g_ds.hwnd_game != hwnd || !g_ds.fullscreen_active || ds_is_modern_tier_locked()) {
        ds_unlock();
        return;
    }
    LONG_PTR saved_style = g_ds.saved_style;
    LONG_PTR saved_exstyle = g_ds.saved_exstyle;
    bool app_inactive = g_ds.app_inactive;
    bool is_unicode = g_ds.orig_wndproc != NULL
        ? g_ds.orig_wndproc_unicode
        : (IsWindowUnicode(hwnd) != FALSE);
    g_ds.window_mutated_by_scaler = true;
    ds_unlock();

    LONG_PTR fs_style = 0, fs_ex = 0;
    ds_compute_fs_styles(saved_style, saved_exstyle, app_inactive, &fs_style, &fs_ex);

    ds_enter_internal();
    ds_set_class_bg_brush(hwnd, (LONG_PTR)GetStockObject(BLACK_BRUSH));
    if (GetMenu(hwnd) != NULL) {
        SetMenu(hwnd, NULL);
    }
    if (ds_get_wnd_long_ptr(hwnd, GWL_STYLE) != fs_style) {
        ds_set_wnd_long_ptr_raw(hwnd, GWL_STYLE, fs_style, is_unicode);
    }
    LONG_PTR cur_ex = ds_get_wnd_long_ptr(hwnd, GWL_EXSTYLE);
    bool has_topmost = (cur_ex & (LONG_PTR)WS_EX_TOPMOST) != 0;
    if (has_topmost == app_inactive) {
        ds_set_wnd_long_ptr_raw(hwnd, GWL_EXSTYLE, fs_ex, is_unicode);
    }
    ds_leave_internal();
}

static void ds_destroy_gl_host_on_owner_thread(void)
{
    HWND host = NULL;
    ds_lock();
    host = g_ds.hwnd_gl_host;
    g_ds.hwnd_gl_host = NULL;
    g_ds.gl_host_visible = false;
    g_ds.gl_host_want_visible = false;
    g_ds.gl_host_hide_queued = false;
    ds_unlock();

    if (host != NULL) {
        ds_gl_release_all_host_dcs_for_hwnd(host);
        if (IsWindow(host)) {
            ds_enter_internal();
            DestroyWindow(host);
            ds_leave_internal();
        }
    }
}

static BOOL ds_apply_win_style_and_menu(
    HWND hwnd,
    LONG_PTR saved_style,
    LONG_PTR saved_exstyle,
    HMENU saved_menu,
    bool is_unicode,
    bool ensure_windowed,
    bool require_caption
)
{
    LONG_PTR win_style = saved_style;
    LONG_PTR win_ex = saved_exstyle;
    if (ensure_windowed) {
        if ((win_style & WS_POPUP) != 0 || (require_caption && (win_style & WS_CAPTION) == 0)) {
            win_style = (win_style & ~(LONG_PTR)WS_POPUP) | (LONG_PTR)(WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX);
        }
        win_style |= WS_VISIBLE;
        if (require_caption) {
            win_ex &= ~(LONG_PTR)WS_EX_TOPMOST;
        }
    }
    ds_set_wnd_long_ptr_raw(hwnd, GWL_STYLE, win_style, is_unicode);
    ds_set_wnd_long_ptr_raw(hwnd, GWL_EXSTYLE, win_ex, is_unicode);
    if (saved_menu != NULL && IsMenu(saved_menu)) {
        if (GetMenu(hwnd) != saved_menu) {
            SetMenu(hwnd, saved_menu);
        }
        return TRUE;
    }
    return FALSE;
}

void ds_restore_window_on_passthrough(HWND hwnd)
{
    if (!hwnd || !IsWindow(hwnd)) return;

    ds_destroy_gl_host_on_owner_thread();
    ds_gl_shutdown();

    ds_lock();
    if (g_ds.hwnd_game != hwnd) {
        ds_unlock();
        return;
    }
    bool mutated = g_ds.window_mutated_by_scaler;
    bool has_saved = g_ds.has_saved_window_state;
    bool has_bg = g_ds.has_saved_class_bg;
    LONG_PTR saved_bg = g_ds.saved_class_bg;
    LONG_PTR saved_style = g_ds.saved_style;
    LONG_PTR saved_exstyle = g_ds.saved_exstyle;
    HMENU saved_menu = g_ds.has_saved_hmenu ? g_ds.saved_hmenu : NULL;
    RECT saved_rc = g_ds.saved_window_rect;
    bool is_unicode = g_ds.orig_wndproc != NULL
        ? g_ds.orig_wndproc_unicode
        : (IsWindowUnicode(hwnd) != FALSE);
    int32_t mon_w = g_ds.real_screen_w;
    int32_t mon_h = g_ds.real_screen_h;
    ds_presenter_tier_t tier = (g_ds.scaling_mode == DS_MODE_PASSTHROUGH)
        ? DS_PRESENTER_MODERN_PASSTHROUGH
        : g_ds.presenter_tier;
    g_ds.window_mutated_by_scaler = false;
    g_ds.borderless_active = false;
    g_ds.modern_subnative_fs_expanded = false;
    g_ds.mode_virtualized = false;
    g_ds.cocoa_fs_synced = false;
    g_ds.passthrough_restored = true;
    ds_unlock();

    ds_enter_internal();
    ds_clear_wine_present_rect_on_hwnd(hwnd);
    if (mutated && has_saved) {
        if (has_bg) {
            ds_set_class_bg_brush(hwnd, saved_bg);
        }
        (void)ds_apply_win_style_and_menu(hwnd, saved_style, saved_exstyle, saved_menu, is_unicode, false, false);
        if (g_ds.real_SetWindowPos) {
            int sw = saved_rc.right - saved_rc.left;
            int sh = saved_rc.bottom - saved_rc.top;
            bool saved_is_windowed = (
                sw > 0 && sh > 0 &&
                (mon_w <= 0 || mon_h <= 0 || sw < mon_w || sh < mon_h)
            );
            ds_set_window_pos_dpi(
                hwnd,
                HWND_NOTOPMOST,
                saved_is_windowed ? saved_rc.left : 0,
                saved_is_windowed ? saved_rc.top : 0,
                saved_is_windowed ? sw : 0,
                saved_is_windowed ? sh : 0,
                saved_is_windowed
                    ? (SWP_NOACTIVATE | SWP_FRAMECHANGED)
                    : (SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED),
                false
            );
        }
    }
    if (g_ds.real_ClipCursor) {
        g_ds.real_ClipCursor(NULL);
    }
    ds_leave_internal();

    ds_tracef("pt_restore h=%p m=%d t=%d", hwnd, (int)mutated, (int)tier);

    /* If transitioning directly from Tier 0 -> Tier 2 (Modern Borderless), apply Tier 2 now */
    if (tier == DS_PRESENTER_MODERN_BORDERLESS) {
        ds_apply_window_presentation_on_owner_thread(hwnd);
    }
}

static void ds_dispatch_presentation_req(bool restore_pt)
{
    ds_lock();
    HWND hwnd = g_ds.hwnd_game;
    DWORD owner_tid = g_ds.game_thread_id;
    UINT msg = g_ds.msg_apply_presentation;
    ds_unlock();

    if (!hwnd || !IsWindow(hwnd)) return;
    if (GetCurrentThreadId() == owner_tid) {
        if (restore_pt) {
            ds_restore_window_on_passthrough(hwnd);
        } else {
            ds_apply_window_presentation_on_owner_thread(hwnd);
        }
    } else if (msg != 0) {
        PostMessageW(hwnd, msg, restore_pt ? (WPARAM)DS_APPLY_RESTORE_PASSTHROUGH : 0, 0);
    }
}

void ds_request_restore_passthrough(void)
{
    ds_dispatch_presentation_req(true);
}

void ds_apply_window_presentation_on_owner_thread(HWND hwnd)
{
    if (!hwnd || !IsWindow(hwnd)) return;

    /* Keep monitor coordinates & DPI space synchronized if hwnd moved to another monitor */
    HMONITOR cur_mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    ds_lock();
    HMONITOR saved_mon = g_ds.target_monitor;
    ds_unlock();
    if (cur_mon != NULL && cur_mon != saved_mon) {
        ds_refresh_host_display_metrics_for_hwnd(hwnd);
    }

    ds_capture_window_baseline_and_subclass(hwnd);

    ds_lock();
    if (g_ds.hwnd_game != hwnd) {
        ds_unlock();
        return;
    }

    ds_presenter_tier_t tier = (g_ds.scaling_mode == DS_MODE_PASSTHROUGH)
        ? DS_PRESENTER_MODERN_PASSTHROUGH
        : g_ds.presenter_tier;
    bool need_pt_restore = (!g_ds.passthrough_restored || g_ds.hwnd_gl_host != NULL || g_ds.window_mutated_by_scaler);
    bool app_inactive = g_ds.app_inactive;
#if defined(_WIN64)
    ds_scaling_mode_t scaling_mode = g_ds.scaling_mode;
    bool user_forced_win = g_ds.user_forced_windowed;
    bool modern_fs_expanded = g_ds.modern_subnative_fs_expanded;
#endif
    bool want_tier2_fs = (
        tier == DS_PRESENTER_MODERN_BORDERLESS &&
        !g_ds.user_forced_windowed &&
        (g_ds.scaling_mode == DS_MODE_FORCE_FULLSCREEN || g_ds.user_forced_fullscreen || g_ds.fullscreen_active)
    );
    bool fs_active = (tier == DS_PRESENTER_LEGACY_VIRTUAL) && g_ds.fullscreen_active;
    bool cocoa_synced = g_ds.cocoa_fs_synced;
    bool resync_visible = g_ds.visible_resync_needed;
    g_ds.visible_resync_needed = false;
    DWORD vis_tick = g_ds.first_visible_tick;
    int32_t mon_x = g_ds.win_mon_x;
    int32_t mon_y = g_ds.win_mon_y;
    int32_t mon_w = g_ds.real_screen_w;
    int32_t mon_h = g_ds.real_screen_h;
    int32_t vw = g_ds.virt_w > 0 ? g_ds.virt_w : (g_ds.saved_client_w > 0 ? g_ds.saved_client_w : 640);
    int32_t vh = g_ds.virt_h > 0 ? g_ds.virt_h : (g_ds.saved_client_h > 0 ? g_ds.saved_client_h : 480);
    if (tier == DS_PRESENTER_LEGACY_VIRTUAL) {
        g_ds.virt_w = vw;
        g_ds.virt_h = vh;
        ds_refresh_viewport_locked();
    }
    ds_viewport_t vp = g_ds.vp;
    LONG_PTR saved_style = g_ds.saved_style;
    LONG_PTR saved_exstyle = g_ds.saved_exstyle;
    RECT saved_rc = g_ds.saved_window_rect;
    HMENU saved_menu = g_ds.has_saved_hmenu ? g_ds.saved_hmenu : NULL;
    bool has_saved_bg = g_ds.has_saved_class_bg;
    LONG_PTR saved_bg = g_ds.saved_class_bg;
    bool is_unicode = g_ds.orig_wndproc_unicode;
    ds_unlock();

    /* Tier 1 (Modern Full Passthrough): ensure clean restoration and never mutate styles */
    if (tier == DS_PRESENTER_MODERN_PASSTHROUGH) {
#if defined(_WIN64)
        if (modern_fs_expanded && !user_forced_win && scaling_mode == DS_MODE_AUTO_FULLSCREEN) {
            if (!app_inactive) {
                ds_refresh_host_display_metrics_for_hwnd(hwnd);
                ds_lock();
                mon_x = g_ds.win_mon_x;
                mon_y = g_ds.win_mon_y;
                mon_w = g_ds.real_screen_w;
                mon_h = g_ds.real_screen_h;
                ds_unlock();

                HANDLE prev_dpi = ds_dpi_guard_enter_for_hwnd(hwnd);
                pfn_GetWindowRect_t gwr = g_ds.real_GetWindowRect ? g_ds.real_GetWindowRect : GetWindowRect;
                ds_enter_internal();
                RECT rc = { 0, 0, 0, 0 };
                BOOL has_rc = gwr(hwnd, &rc);
                LONG_PTR st = ds_get_wnd_long_ptr(hwnd, GWL_STYLE);
                LONG_PTR ex = ds_get_wnd_long_ptr(hwnd, GWL_EXSTYLE);
                WCHAR cls[16] = { 0 };
                bool is_dlg = (GetClassNameW(hwnd, cls, 15) > 0 && ds_wcs_ieq_ascii(cls, "#32770"));
                bool still_subnative = has_rc && ds_is_subnative_exclusive_fullscreen_window(
                    rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top,
                    mon_x, mon_y, mon_w, mon_h,
                    (uint32_t)st, (uint32_t)ex, false,
                    IsWindowVisible(hwnd) != FALSE, IsIconic(hwnd) != FALSE, is_dlg
                );
                bool borderless_topmost_drift = (
                    has_rc && !is_dlg && IsWindowVisible(hwnd) && !IsIconic(hwnd) &&
                    (st & (LONG_PTR)(WS_CHILD | WS_CAPTION | WS_THICKFRAME | WS_DLGFRAME | WS_BORDER)) == 0 &&
                    (ex & (LONG_PTR)WS_EX_TOPMOST) != 0 &&
                    (rc.left != mon_x || rc.top != mon_y || (rc.right - rc.left) != mon_w || (rc.bottom - rc.top) != mon_h)
                );
                ds_leave_internal();
                ds_dpi_guard_leave(prev_dpi);

                if ((still_subnative || borderless_topmost_drift) && mon_w > 0 && mon_h > 0) {
                    /* Expand geometry ONLY — never touch GWL_STYLE/GWL_EXSTYLE so D3DMetal windowed exit matches */
                    ds_enter_internal();
                    ds_set_window_pos_dpi(hwnd, HWND_TOPMOST, mon_x, mon_y, mon_w, mon_h, SWP_FRAMECHANGED | SWP_SHOWWINDOW, true);
                    ds_leave_internal();
                } else if ((st & (LONG_PTR)(WS_CAPTION | WS_THICKFRAME | WS_DLGFRAME | WS_BORDER)) != 0 ||
                           (ex & (LONG_PTR)WS_EX_TOPMOST) == 0) {
                    ds_lock();
                    g_ds.modern_subnative_fs_expanded = false;
                    ds_unlock();
                }
            }
            return;
        }
#endif
        if (need_pt_restore) {
            ds_restore_window_on_passthrough(hwnd);
        }
        return;
    }

    /* Tier 2 (Modern Native Borderless): toggle WS_POPUP + full monitor only; ZERO GLHost/virtualization */
    if (tier == DS_PRESENTER_MODERN_BORDERLESS) {
        ds_destroy_gl_host_on_owner_thread();
        ds_refresh_host_display_metrics_for_hwnd(hwnd);
        ds_lock();
        mon_x = g_ds.win_mon_x;
        mon_y = g_ds.win_mon_y;
        mon_w = g_ds.real_screen_w;
        mon_h = g_ds.real_screen_h;
        ds_unlock();

        ds_enter_internal();
        if (want_tier2_fs && mon_w > 0 && mon_h > 0) {
            LONG_PTR fs_style = 0, fs_ex = 0;
            ds_compute_fs_styles(saved_style, saved_exstyle, app_inactive, &fs_style, &fs_ex);
            ds_set_wnd_long_ptr_raw(hwnd, GWL_STYLE, fs_style, is_unicode);
            ds_set_wnd_long_ptr_raw(hwnd, GWL_EXSTYLE, fs_ex, is_unicode);
            ds_set_window_pos_dpi(
                hwnd,
                app_inactive ? HWND_NOTOPMOST : HWND_TOPMOST,
                mon_x,
                mon_y,
                mon_w,
                mon_h,
                SWP_FRAMECHANGED | SWP_SHOWWINDOW | (app_inactive ? SWP_NOACTIVATE : 0),
                true
            );
            ds_lock();
            g_ds.borderless_active = true;
            g_ds.window_mutated_by_scaler = true;
            ds_unlock();
        } else {
            (void)ds_apply_win_style_and_menu(hwnd, saved_style, saved_exstyle, saved_menu, is_unicode, true, true);
            int sw = saved_rc.right - saved_rc.left;
            int sh = saved_rc.bottom - saved_rc.top;
            bool saved_windowed = (sw > 0 && sh > 0 && (mon_w <= 0 || mon_h <= 0 || sw < mon_w || sh < mon_h));
            int wx = saved_windowed ? saved_rc.left : (mon_x + (mon_w - (mon_w * 3) / 4) / 2);
            int wy = saved_windowed ? saved_rc.top : (mon_y + (mon_h - (mon_h * 3) / 4) / 2);
            int ww = saved_windowed ? sw : ((mon_w * 3) / 4);
            int wh = saved_windowed ? sh : ((mon_h * 3) / 4);
            UINT wf = (saved_windowed || (mon_w > 0 && mon_h > 0))
                ? (SWP_FRAMECHANGED | SWP_SHOWWINDOW)
                : (SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
            ds_set_window_pos_dpi(hwnd, HWND_NOTOPMOST, wx, wy, ww, wh, wf, false);
            ds_lock();
            g_ds.borderless_active = false;
            g_ds.window_mutated_by_scaler = false;
            ds_unlock();
        }
        ds_leave_internal();
        return;
    }

    if (fs_active && app_inactive) {
        ds_enter_internal();
        ds_ensure_gl_host_child_on_owner_thread(hwnd);
        ds_leave_internal();
        ds_gl_notify_mode_changed();
        return;
    }

    HANDLE prev_dpi = ds_dpi_guard_enter_for_hwnd(hwnd);
    ds_enter_internal();
    if (fs_active && vp.dst_w > 0 && vp.dst_h > 0) {
        ds_lock();
        g_ds.window_mutated_by_scaler = true;
        ds_unlock();
        ds_set_class_bg_brush(hwnd, (LONG_PTR)GetStockObject(BLACK_BRUSH));
        if (GetMenu(hwnd) != NULL) {
            SetMenu(hwnd, NULL);
        }
        LONG_PTR fs_style = 0, fs_ex = 0;
        ds_compute_fs_styles(saved_style, saved_exstyle, false, &fs_style, &fs_ex);

        bool was_visible = (IsWindowVisible(hwnd) != FALSE);
        DWORD now_tick = GetTickCount();

        if (!was_visible && !cocoa_synced && mon_w >= 800 && mon_h >= 600) {
            DWORD birth_tick = now_tick ? now_tick : 1;
            ds_lock();
            g_ds.first_visible_tick = birth_tick;
            g_ds.cocoa_fs_synced = false;
            ds_unlock();

            ds_set_wnd_long_ptr_raw(hwnd, GWL_STYLE, fs_style & ~(LONG_PTR)WS_VISIBLE, is_unicode);
            ds_set_wnd_long_ptr_raw(hwnd, GWL_EXSTYLE, fs_ex, is_unicode);
            if (g_ds.real_SetWindowPos) {
                ds_clear_wine_present_rect_on_hwnd(hwnd);
                int32_t sx = mon_x + (mon_w - 640) / 2;
                int32_t sy = mon_y + (mon_h - 480) / 2;
                g_ds.real_SetWindowPos(hwnd, HWND_TOPMOST, sx, sy, 640, 480, SWP_SHOWWINDOW | SWP_FRAMECHANGED);
            }
        } else if (!cocoa_synced && vis_tick != 0 && (now_tick - vis_tick) < 250) {
            /* Hold centered birth rect briefly while Wine drains initial Cocoa frame events */
        } else {
            ds_lock();
            g_ds.cocoa_fs_synced = true;
            g_ds.first_visible_tick = 0;
            ds_unlock();

            LONG_PTR cur_style = ds_get_wnd_long_ptr(hwnd, GWL_STYLE);
            LONG_PTR cur_ex = ds_get_wnd_long_ptr(hwnd, GWL_EXSTYLE);
            RECT cur_rc = { 0, 0, 0, 0 };
            BOOL has_rc = g_ds.real_GetWindowRect ? g_ds.real_GetWindowRect(hwnd, &cur_rc) : FALSE;
            bool style_changed = (cur_style != fs_style) || ((cur_ex & (LONG_PTR)WS_EX_TOPMOST) == 0);
            bool rect_changed = !has_rc ||
                                cur_rc.left != mon_x ||
                                cur_rc.top != mon_y ||
                                (cur_rc.right - cur_rc.left) != mon_w ||
                                (cur_rc.bottom - cur_rc.top) != mon_h ||
                                !was_visible;

            if (style_changed) {
                ds_set_wnd_long_ptr_raw(hwnd, GWL_STYLE, fs_style, is_unicode);
                ds_set_wnd_long_ptr_raw(hwnd, GWL_EXSTYLE, fs_ex, is_unicode);
            }
            if (g_ds.real_SetWindowPos) {
                ds_clear_wine_present_rect_on_hwnd(hwnd);
                if (resync_visible || style_changed || rect_changed) {
                    UINT swp_flags = SWP_SHOWWINDOW |
                                     ((resync_visible || style_changed) ? SWP_FRAMECHANGED : 0) |
                                     (resync_visible ? (SWP_NOACTIVATE | SWP_NOCOPYBITS) : 0);
                    g_ds.real_SetWindowPos(hwnd, HWND_TOPMOST, mon_x, mon_y, mon_w, mon_h, swp_flags);
                    if (rect_changed) {
                        InvalidateRect(hwnd, NULL, FALSE);
                        ds_lock();
                        HWND inv_host = g_ds.gl_host_visible ? g_ds.hwnd_gl_host : NULL;
                        ds_unlock();
                        if (inv_host && IsWindow(inv_host)) {
                            InvalidateRect(inv_host, NULL, FALSE);
                        }
                    }
                }
                BringWindowToTop(hwnd);
                SetForegroundWindow(hwnd);
                SetActiveWindow(hwnd);
                SetFocus(hwnd);
            }
        }
    } else {
        if (has_saved_bg) {
            ds_set_class_bg_brush(hwnd, saved_bg);
        }
        BOOL has_restored_menu = ds_apply_win_style_and_menu(hwnd, saved_style, saved_exstyle, saved_menu, is_unicode, true, false);
        LONG_PTR win_style = ds_get_wnd_long_ptr(hwnd, GWL_STYLE);

        int32_t scale_factor = (mon_w >= 2000) ? 2 : 1;
        if (vw * scale_factor > mon_w || vh * scale_factor > mon_h) {
            scale_factor = 1;
        }
        int32_t client_w = vw * scale_factor;
        int32_t client_h = vh * scale_factor;
        RECT wrc = { 0, 0, client_w, client_h };
        if (g_ds.real_AdjustWindowRectEx) {
            g_ds.real_AdjustWindowRectEx(&wrc, (DWORD)win_style, has_restored_menu, (DWORD)saved_exstyle);
        }
        int32_t ww = wrc.right - wrc.left;
        int32_t wh = wrc.bottom - wrc.top;
        int32_t wx = mon_x + (mon_w - ww) / 2;
        int32_t wy = mon_y + (mon_h - wh) / 2;
        if (wx < mon_x) wx = mon_x;
        if (wy < mon_y) wy = mon_y;

        if (g_ds.real_SetWindowPos) {
            if (scale_factor > 1) {
                ds_clear_wine_present_rect_on_hwnd(hwnd);
            }
            g_ds.real_SetWindowPos(hwnd, HWND_NOTOPMOST, wx, wy, ww, wh, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        }
        InvalidateRect(hwnd, NULL, TRUE);
    }
    ds_ensure_gl_host_child_on_owner_thread(hwnd);
    ds_leave_internal();
    ds_dpi_guard_leave(prev_dpi);

    ds_lock();
    ds_reapply_cursor_clip_locked();
    ds_unlock();
    ds_gl_notify_mode_changed();
}

void ds_request_apply_presentation(void)
{
    ds_dispatch_presentation_req(false);
}

static bool ds_should_adopt_hwnd_locked(HWND hwnd, bool is_passive)
{
    bool should_adopt = (g_ds.hwnd_game == NULL || !IsWindow(g_ds.hwnd_game) || g_ds.hwnd_game == hwnd);
    if (!should_adopt && g_ds.hwnd_game != hwnd) {
        WCHAR prev_cls[64] = { 0 };
        GetClassNameW(g_ds.hwnd_game, prev_cls, 63);
        if (ds_wcs_has_ascii(prev_cls, "Console") || !IsWindowVisible(g_ds.hwnd_game) || IsIconic(g_ds.hwnd_game)) {
            should_adopt = true;
        }
    }
    if (!should_adopt) {
        return false;
    }
    if (g_ds.hwnd_game != hwnd) {
        ds_reset_hwnd_tracking_locked(is_passive);
    }
    g_ds.hwnd_game = hwnd;
    g_ds.game_thread_id = GetWindowThreadProcessId(hwnd, NULL);
    return true;
}

#if defined(_WIN64)
static void ds_check_modern_subnative_fs_and_request(HWND hwnd)
{
    if (!hwnd || !IsWindow(hwnd) || ds_is_internal_call()) return;

    ds_lock();
    ds_presenter_tier_t tier = (g_ds.scaling_mode == DS_MODE_PASSTHROUGH)
        ? DS_PRESENTER_MODERN_PASSTHROUGH
        : g_ds.presenter_tier;
    bool eligible = (
        tier == DS_PRESENTER_MODERN_PASSTHROUGH &&
        g_ds.hwnd_game == hwnd &&
        g_ds.scaling_mode == DS_MODE_AUTO_FULLSCREEN &&
        !g_ds.user_forced_windowed &&
        !g_ds.app_inactive
    );
    bool was_expanded = g_ds.modern_subnative_fs_expanded;
    HMONITOR target_mon = g_ds.target_monitor;
    int32_t mon_x = g_ds.win_mon_x;
    int32_t mon_y = g_ds.win_mon_y;
    int32_t mon_w = g_ds.real_screen_w;
    int32_t mon_h = g_ds.real_screen_h;
    ds_unlock();

    if (!eligible) return;

    HMONITOR cur_mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    if (mon_w <= 0 || mon_h <= 0 || (cur_mon != NULL && cur_mon != target_mon)) {
        ds_refresh_host_display_metrics_for_hwnd(hwnd);
        ds_lock();
        mon_x = g_ds.win_mon_x;
        mon_y = g_ds.win_mon_y;
        mon_w = g_ds.real_screen_w;
        mon_h = g_ds.real_screen_h;
        ds_unlock();
    }

    HANDLE prev_dpi = ds_dpi_guard_enter_for_hwnd(hwnd);
    pfn_GetWindowRect_t gwr = g_ds.real_GetWindowRect ? g_ds.real_GetWindowRect : GetWindowRect;
    ds_enter_internal();
    RECT rc = { 0, 0, 0, 0 };
    BOOL has_rc = gwr(hwnd, &rc);
    LONG_PTR style = ds_get_wnd_long_ptr(hwnd, GWL_STYLE);
    LONG_PTR exstyle = ds_get_wnd_long_ptr(hwnd, GWL_EXSTYLE);
    bool is_vis = (IsWindowVisible(hwnd) != FALSE);
    bool is_ico = (IsIconic(hwnd) != FALSE);
    WCHAR cls[16] = { 0 };
    bool is_dlg = (GetClassNameW(hwnd, cls, 15) > 0 && ds_wcs_ieq_ascii(cls, "#32770"));
    ds_leave_internal();
    ds_dpi_guard_leave(prev_dpi);

    if (has_rc && ds_is_subnative_exclusive_fullscreen_window(
            rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top,
            mon_x, mon_y, mon_w, mon_h,
            (uint32_t)style, (uint32_t)exstyle,
            false, is_vis, is_ico, is_dlg)) {
        ds_lock();
        if (g_ds.hwnd_game == hwnd) {
            g_ds.modern_subnative_fs_expanded = true;
        }
        ds_unlock();
        ds_request_apply_presentation();
        ds_write_status_file();
    } else if (was_expanded &&
               ((style & (LONG_PTR)(WS_CAPTION | WS_THICKFRAME | WS_DLGFRAME | WS_BORDER)) != 0 ||
                (exstyle & (LONG_PTR)WS_EX_TOPMOST) == 0)) {
        ds_lock();
        if (g_ds.hwnd_game == hwnd) {
            g_ds.modern_subnative_fs_expanded = false;
        }
        ds_unlock();
        ds_write_status_file();
    }
}
#endif

void ds_observe_game_window_passive(HWND hwnd)
{
    int32_t cw = 0, ch = 0;
    if (!ds_is_candidate_game_window(hwnd, &cw, &ch)) {
        return;
    }

    ds_lock();
    bool adopted = ds_should_adopt_hwnd_locked(hwnd, true);
    ds_unlock();

    if (adopted) {
        ds_capture_window_baseline_and_subclass(hwnd);
        ds_refresh_host_display_metrics_for_hwnd(hwnd);
#if defined(_WIN64)
        ds_check_modern_subnative_fs_and_request(hwnd);
#endif
    }
}

void ds_attach_and_apply_game_window(HWND hwnd, int32_t hint_virt_w, int32_t hint_virt_h)
{
    ds_lock();
    ds_presenter_tier_t tier = (g_ds.scaling_mode == DS_MODE_PASSTHROUGH)
        ? DS_PRESENTER_MODERN_PASSTHROUGH
        : g_ds.presenter_tier;
    bool want_tier2_apply = (
        tier == DS_PRESENTER_MODERN_BORDERLESS &&
        (g_ds.scaling_mode == DS_MODE_FORCE_FULLSCREEN ||
         g_ds.user_forced_fullscreen ||
         g_ds.fullscreen_active ||
         g_ds.user_forced_windowed)
    );
    ds_unlock();

    if (tier != DS_PRESENTER_LEGACY_VIRTUAL) {
        ds_observe_game_window_passive(hwnd);
        if (want_tier2_apply && g_ds.hwnd_game == hwnd) {
            ds_request_apply_presentation();
            ds_write_status_file();
        }
        return;
    }

    int32_t cw = 0, ch = 0;
    if (!ds_is_candidate_game_window(hwnd, &cw, &ch)) {
        return;
    }

    /* Refresh dual-DPI monitor metrics for this exact HWND before deciding adoption/fullscreen */
    ds_refresh_host_display_metrics_for_hwnd(hwnd);

    LONG_PTR style = ds_get_wnd_long_ptr(hwnd, GWL_STYLE);
    bool should_apply = false;

    ds_lock();
    if (ds_is_modern_tier_locked()) {
        ds_unlock();
        return;
    }
    bool should_adopt = ds_should_adopt_hwnd_locked(hwnd, false);
    if (should_adopt) {
        if (g_ds.virt_w <= 0 || g_ds.virt_h <= 0) {
            g_ds.virt_w = hint_virt_w > 0 ? hint_virt_w : cw;
            g_ds.virt_h = hint_virt_h > 0 ? hint_virt_h : ch;
        }
        if (!g_ds.user_forced_windowed && !g_ds.fullscreen_active) {
            if (g_ds.scaling_mode == DS_MODE_FORCE_FULLSCREEN) {
                g_ds.fullscreen_active = (g_ds.mode_virtualized || cw < g_ds.real_screen_w || ch < g_ds.real_screen_h);
            } else if (g_ds.scaling_mode == DS_MODE_AUTO_FULLSCREEN) {
                bool small_fixed = ((style & WS_THICKFRAME) == 0) &&
                                   cw <= 1440 &&
                                   ch <= ((g_ds.real_screen_h * 85) / 100);
                g_ds.fullscreen_active = (g_ds.mode_virtualized || small_fixed);
            }
        }
        ds_refresh_viewport_locked();
        should_apply = g_ds.fullscreen_active;
    }
    DWORD owner_tid = g_ds.game_thread_id;
    ds_unlock();

    if (should_adopt) {
        ds_capture_window_baseline_and_subclass(hwnd);
        if (!should_apply && GetCurrentThreadId() == owner_tid) {
            ds_enter_internal();
            ds_ensure_gl_host_child_on_owner_thread(hwnd);
            ds_leave_internal();
        }
    }

    if (should_apply) {
        ds_request_apply_presentation();
        ds_write_status_file();
    }
}

static BOOL CALLBACK ds_enum_adopt_window_cb(HWND hwnd, LPARAM lParam)
{
    (void)lParam;
    if (!IsWindowVisible(hwnd)) return TRUE;
    int32_t cw = 0, ch = 0;
    if (ds_is_candidate_game_window(hwnd, &cw, &ch)) {
        ds_attach_and_apply_game_window(hwnd, cw, ch);
        if (g_ds.hwnd_game == hwnd) {
            return FALSE;
        }
    }
    return TRUE;
}

DS_ALWAYS_INLINE uint64_t ds_current_unix_ms(void)
{
    FILETIME ft = { 0, 0 };
    GetSystemTimeAsFileTime(&ft);
    uint64_t t100ns = ((uint64_t)ft.dwHighDateTime << 32) | (uint64_t)ft.dwLowDateTime;
    const uint64_t epoch_diff = 116444736000000000ULL;
    return (t100ns > epoch_diff) ? ((t100ns - epoch_diff) / 10000ULL) : 0ULL;
}

bool ds_read_ini_file_utf8(const WCHAR *path, char *out_buf, size_t cap, size_t *out_len)
{
    if (out_len) *out_len = 0;
    if (!path || path[0] == L'\0' || !out_buf || cap < 2) return false;

    ds_enter_internal();
    HANDLE hf = CreateFileW(
        path,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );
    if (hf == INVALID_HANDLE_VALUE) {
        ds_leave_internal();
        return false;
    }

    DWORD bytes_read = 0;
    BOOL ok = ReadFile(hf, out_buf, (DWORD)(cap - 1), &bytes_read, NULL);
    CloseHandle(hf);
    ds_leave_internal();

    if (!ok || bytes_read == 0) return false;
    out_buf[bytes_read] = '\0';
    if (out_len) *out_len = (size_t)bytes_read;
    return true;
}

static bool ds_apply_parsed_control_locked(const ds_control_state_t *ctl)
{
    bool changed = false;
    if (ctl->has_scaling_mode && ctl->scaling_mode != g_ds.scaling_mode) {
        g_ds.scaling_mode = ctl->scaling_mode;
#if defined(_WIN64)
        if (g_ds.scaling_mode == DS_MODE_PASSTHROUGH) {
            g_ds.modern_subnative_fs_expanded = false;
        }
#endif
        changed = true;
    }
    if (ctl->has_aspect && ctl->aspect != g_ds.aspect_mode) {
        g_ds.aspect_mode = ctl->aspect;
        changed = true;
    }
    if (ctl->has_filter && ctl->filter != g_ds.scale_filter) {
        g_ds.scale_filter = ctl->filter;
        changed = true;
    }
    if (ctl->has_safe_inset_top) {
        int32_t raw_inset = ctl->safe_inset_top;
        if (raw_inset > 48 && g_ds.real_screen_h > 0 &&
            g_ds.phys_screen_h >= g_ds.real_screen_h * 2 - 4) {
            raw_inset = (raw_inset + 1) / 2;
        }
        int32_t clamped = ds_clamp_safe_inset_top(raw_inset, g_ds.real_screen_h);
        if (clamped != g_ds.safe_inset_top) {
            g_ds.safe_inset_top = clamped;
            changed = true;
        }
    }
    if (ctl->has_hotkey && ctl->hotkey != g_ds.hotkey_enabled) {
        g_ds.hotkey_enabled = ctl->hotkey;
    }
    /*
     * Only treat `fullscreen=0|1` as a live user override when `ctl->user_override` is true
     * (i.e., `seq >= 2` from `toggleSessionFullscreen()` or explicit `user_override=1`).
     * Launch-initial `seq=1, fullscreen=1` MUST NOT force `user_forced_fullscreen=true` or
     * disable modern swapchain passthrough.
     */
    if (ctl->has_fullscreen && ctl->user_override) {
#if defined(_WIN64)
        bool cur_fs = ds_is_modern_tier_locked()
            ? (g_ds.borderless_active || g_ds.modern_subnative_fs_expanded)
            : g_ds.fullscreen_active;
#else
        bool cur_fs = ds_is_modern_tier_locked() ? g_ds.borderless_active : g_ds.fullscreen_active;
#endif
        if (ctl->fullscreen != cur_fs ||
            g_ds.user_forced_fullscreen != ctl->fullscreen ||
            g_ds.user_forced_windowed != !ctl->fullscreen) {
            g_ds.fullscreen_active = ctl->fullscreen;
            g_ds.user_forced_windowed = !ctl->fullscreen;
            g_ds.user_forced_fullscreen = ctl->fullscreen;
#if defined(_WIN64)
            if (!ctl->fullscreen) {
                g_ds.modern_subnative_fs_expanded = false;
            }
#endif
            g_ds.cocoa_fs_synced = false;
            g_ds.app_inactive = false;
            if (ctl->fullscreen && g_ds.scaling_mode == DS_MODE_PASSTHROUGH) {
                g_ds.scaling_mode = DS_MODE_FORCE_FULLSCREEN;
            }
            changed = true;
        }
    }
    if (ds_update_presenter_tier_locked()) {
        changed = true;
    }
    if (changed) {
        ds_refresh_viewport_locked();
        ds_cursor_warp_reset(&g_ds.warp);
    }
    return changed;
}

static void ds_copy_wpath(WCHAR *dst, const WCHAR *src)
{
    wcsncpy(dst, src, MAX_PATH - 1);
    dst[MAX_PATH - 1] = L'\0';
}

static void ds_notify_control_changed(void)
{
    ds_lock();
    HWND cur_game = g_ds.hwnd_game;
    ds_unlock();
    if (cur_game == NULL || !IsWindow(cur_game)) {
        EnumWindows(ds_enum_adopt_window_cb, 0);
    }
    ds_request_apply_presentation();
    ds_write_status_file();
}

static void ds_poll_active_session_if_needed(void)
{
    WCHAR sess_path[MAX_PATH];
    WCHAR cur_ctl[MAX_PATH];
    ds_lock();
    ds_copy_wpath(sess_path, g_ds.active_session_file);
    ds_copy_wpath(cur_ctl, g_ds.control_file);
    ds_unlock();

    if (sess_path[0] == L'\0') return;
    if (cur_ctl[0] != L'\0') {
        ds_enter_internal();
        DWORD attr = GetFileAttributesW(cur_ctl);
        ds_leave_internal();
        if (attr != INVALID_FILE_ATTRIBUTES) {
            return;
        }
    }

    char buf[DS_INI_BUF_BYTES];
    size_t len = 0;
    if (!ds_read_ini_file_utf8(sess_path, buf, sizeof(buf), &len)) {
        return;
    }

    ds_control_state_t sess;
    if (!ds_parse_control_ini(buf, len, &sess)) {
        return;
    }
    if (sess.has_updated_unix_ms && sess.updated_unix_ms > 0) {
        uint64_t now_ms = ds_current_unix_ms();
        const uint64_t max_age_ms = 6ULL * 3600ULL * 1000ULL;
        if (now_ms > sess.updated_unix_ms && (now_ms - sess.updated_unix_ms) > max_age_ms) {
            return;
        }
    }

    WCHAR new_ctl[MAX_PATH] = { 0 };
    WCHAR new_status[MAX_PATH] = { 0 };
    if (sess.has_control_file && sess.control_file[0] != '\0') {
        MultiByteToWideChar(CP_UTF8, 0, sess.control_file, -1, new_ctl, MAX_PATH - 1);
        if (new_ctl[0] != L'\0') {
            ds_enter_internal();
            DWORD ctl_attr = GetFileAttributesW(new_ctl);
            ds_leave_internal();
            if (ctl_attr == INVALID_FILE_ATTRIBUTES) {
                new_ctl[0] = L'\0';
            }
        }
    }
    if (sess.has_status_file && sess.status_file[0] != '\0') {
        MultiByteToWideChar(CP_UTF8, 0, sess.status_file, -1, new_status, MAX_PATH - 1);
    }

    bool changed = false;
    ds_lock();
    uint64_t eff_seq = ds_effective_active_session_seq(&sess);
    if (new_ctl[0] != L'\0' && _wcsicmp(new_ctl, g_ds.control_file) != 0) {
        ds_copy_wpath(g_ds.control_file, new_ctl);
        g_ds.last_control_seq = 0;
    }
    if (new_status[0] != L'\0' && _wcsicmp(new_status, g_ds.status_file) != 0) {
        ds_copy_wpath(g_ds.status_file, new_status);
    }
    if (eff_seq > g_ds.last_active_session_seq) {
        g_ds.last_active_session_seq = eff_seq;
        changed = ds_apply_parsed_control_locked(&sess);
    }
    ds_unlock();

    if (changed) {
        ds_notify_control_changed();
    }
}

void ds_poll_control_file_once(void)
{
    ds_poll_active_session_if_needed();

    WCHAR ctl_path[MAX_PATH];
    ds_lock();
    ds_copy_wpath(ctl_path, g_ds.control_file);
    ds_unlock();

    if (ctl_path[0] == L'\0') return;

    char buf[DS_INI_BUF_BYTES];
    size_t bytes_read = 0;
    if (!ds_read_ini_file_utf8(ctl_path, buf, sizeof(buf), &bytes_read)) {
        return;
    }

    ds_control_state_t ctl;
    if (!ds_parse_control_ini(buf, bytes_read, &ctl) || !ctl.has_seq) {
        return;
    }

    bool changed = false;
    ds_lock();
    if (ctl.seq > g_ds.last_control_seq) {
        g_ds.last_control_seq = ctl.seq;
        if (ctl.has_status_file && ctl.status_file[0] != '\0' && g_ds.status_file[0] == L'\0') {
            MultiByteToWideChar(CP_UTF8, 0, ctl.status_file, -1, g_ds.status_file, MAX_PATH - 1);
        }
        changed = ds_apply_parsed_control_locked(&ctl);
    }
    ds_unlock();

    if (changed) {
        ds_notify_control_changed();
    }
}

void ds_ensure_game_window_bounds(HWND candidate_hwnd)
{
    if (ds_is_internal_call()) return;

    ds_lock();
    HWND hwnd = g_ds.hwnd_game;
    ds_presenter_tier_t tier = (g_ds.scaling_mode == DS_MODE_PASSTHROUGH)
        ? DS_PRESENTER_MODERN_PASSTHROUGH
        : g_ds.presenter_tier;
    bool app_inactive = g_ds.app_inactive;
    bool want_check = (tier == DS_PRESENTER_MODERN_BORDERLESS)
        ? g_ds.borderless_active
        : (tier == DS_PRESENTER_LEGACY_VIRTUAL && g_ds.fullscreen_active && g_ds.vp.dst_w > 0 && g_ds.vp.dst_h > 0);
    int32_t mon_x = g_ds.win_mon_x;
    int32_t mon_y = g_ds.win_mon_y;
    int32_t mon_w = g_ds.real_screen_w;
    int32_t mon_h = g_ds.real_screen_h;
    ds_unlock();

#if defined(_WIN64)
    if (tier == DS_PRESENTER_MODERN_PASSTHROUGH) {
        if (!app_inactive && hwnd && IsWindow(hwnd) && (candidate_hwnd == NULL || candidate_hwnd == hwnd)) {
            ds_check_modern_subnative_fs_and_request(hwnd);
        }
        return;
    }
#endif

    if (!want_check || app_inactive || mon_w <= 0 || mon_h <= 0) return;
    if (!hwnd || !IsWindow(hwnd)) return;
    if (candidate_hwnd != NULL && candidate_hwnd != hwnd) return;
    if (!IsWindowVisible(hwnd)) return;

    RECT rc = { 0, 0, 0, 0 };
    BOOL has_rc = ds_get_rect_dpi(hwnd, &rc, false);
    LONG_PTR style = ds_get_wnd_long_ptr(hwnd, GWL_STYLE);

    bool rect_drifted = !has_rc ||
                        rc.left != mon_x ||
                        rc.top != mon_y ||
                        (rc.right - rc.left) != mon_w ||
                        (rc.bottom - rc.top) != mon_h;
    bool style_drifted = (style & (LONG_PTR)(WS_CAPTION | WS_THICKFRAME | WS_BORDER | WS_DLGFRAME | WS_MAXIMIZE | WS_MINIMIZE)) != 0;
    if (tier == DS_PRESENTER_MODERN_BORDERLESS) {
        if (rect_drifted || style_drifted) {
            ds_request_apply_presentation();
        }
        return;
    }
    DWORD now_tick = GetTickCount();
    bool waiting_birth_drain = false;
    bool promote_staged_birth = false;
    bool check_visible_hit = false;
    ds_lock();
    if (g_ds.hwnd_game == hwnd && !g_ds.cocoa_fs_synced && g_ds.first_visible_tick != 0) {
        if ((now_tick - g_ds.first_visible_tick) < 250) {
            waiting_birth_drain = true;
        } else {
            g_ds.cocoa_fs_synced = true;
            g_ds.first_visible_tick = 0;
            promote_staged_birth = true;
        }
    } else if (g_ds.hwnd_game == hwnd && g_ds.cocoa_fs_synced && !rect_drifted && !style_drifted &&
               (now_tick - g_ds.last_hit_probe_tick) >= 450) {
        g_ds.last_hit_probe_tick = now_tick;
        check_visible_hit = true;
    }
    ds_unlock();

    if (waiting_birth_drain) {
        return;
    }

    if (check_visible_hit && GetForegroundWindow() == hwnd && g_ds.real_WindowFromPoint && mon_w > 16) {
        POINT edge_pt = { mon_x + mon_w - 2, mon_y + mon_h / 2 };
        ds_enter_internal();
        HWND hit = g_ds.real_WindowFromPoint(edge_pt);
        ds_leave_internal();
        ds_lock();
        if (g_ds.hwnd_game == hwnd) {
            if (hit == NULL || hit == GetDesktopWindow()) {
                if (g_ds.consec_resync_attempts < 6) {
                    g_ds.consec_resync_attempts++;
                    g_ds.visible_resync_needed = true;
                    g_ds.visible_resync_done = true;
                    promote_staged_birth = true;
                }
            } else {
                g_ds.consec_resync_attempts = 0;
                g_ds.visible_resync_done = true;
            }
        }
        ds_unlock();
    }

    if (rect_drifted || style_drifted || promote_staged_birth) {
        ds_request_apply_presentation();
    }
}

static DWORD WINAPI ds_control_watcher_proc(LPVOID param)
{
    (void)param;
    while (!g_ds.shutting_down) {
        HANDLE ev = g_ds.stop_event;
        if (ev && WaitForSingleObject(ev, 150) == WAIT_OBJECT_0) {
            break;
        }
        if (g_ds.shutting_down) break;

        ds_poll_control_file_once();

        ds_lock();
        bool passthrough = ds_is_passthrough_locked();
        HWND cur_game = g_ds.hwnd_game;
#if defined(_WIN64)
        bool watch_modern_fs = (g_ds.scaling_mode == DS_MODE_AUTO_FULLSCREEN && !g_ds.user_forced_windowed);
#else
        bool watch_modern_fs = false;
#endif
        ds_unlock();

        if (!passthrough || watch_modern_fs) {
            if (cur_game == NULL || !IsWindow(cur_game)) {
                EnumWindows(ds_enum_adopt_window_cb, 0);
            } else {
                ds_ensure_game_window_bounds(NULL);
            }
        }
    }
    return 0;
}

static BOOL CALLBACK ds_start_watcher_once_cb(PINIT_ONCE InitOnce, PVOID Parameter, PVOID *Context)
{
    (void)InitOnce;
    (void)Parameter;
    (void)Context;
    if (g_ds.shutting_down || !g_ds.active) {
        return TRUE;
    }
    ds_enter_internal();
    g_ds.stop_event = CreateEventW(NULL, TRUE, FALSE, NULL);
    g_ds.watcher_thread = CreateThread(NULL, 0, ds_control_watcher_proc, NULL, 0, NULL);
    ds_leave_internal();
    return TRUE;
}

void ds_start_control_watcher(void)
{
    if (!g_ds.active || g_ds.shutting_down) return;
    InitOnceExecuteOnce(&g_ds.watcher_once, ds_start_watcher_once_cb, NULL, NULL);
}

void ds_stop_control_watcher(bool process_terminating)
{
    g_ds.shutting_down = true;
    if (g_ds.stop_event) {
        SetEvent(g_ds.stop_event);
    }
    if (process_terminating) {
        return;
    }
    /*
     * Never block inside `DllMain(DLL_PROCESS_DETACH)` waiting on `watcher_thread`:
     * under the OS loader lock, a worker thread cannot complete `DLL_THREAD_DETACH`.
     * Perform a non-blocking poll (`timeout == 0`) and only close `stop_event` if the
     * thread has already exited; otherwise leak-safe handle release keeps `stop_event`
     * valid until the thread wakes and returns.
     */
    if (g_ds.watcher_thread) {
        bool exited = (WaitForSingleObject(g_ds.watcher_thread, 0) == WAIT_OBJECT_0);
        CloseHandle(g_ds.watcher_thread);
        g_ds.watcher_thread = NULL;
        if (exited && g_ds.stop_event) {
            CloseHandle(g_ds.stop_event);
            g_ds.stop_event = NULL;
        }
    } else if (g_ds.stop_event) {
        CloseHandle(g_ds.stop_event);
        g_ds.stop_event = NULL;
    }
}

DWORD WINAPI OneLauncherDisplayScalerTriggerScan(LPVOID lpParam)
{
    (void)lpParam;
    if (!g_ds.active || g_ds.shutting_down) {
        return 0;
    }
    ds_ensure_runtime_started();
    ds_patch_loaded_modules();
    ds_poll_control_file_once();
    ds_lock();
    bool passthrough = ds_is_passthrough_locked();
#if defined(_WIN64)
    bool watch_modern_fs = (g_ds.scaling_mode == DS_MODE_AUTO_FULLSCREEN && !g_ds.user_forced_windowed);
#else
    bool watch_modern_fs = false;
#endif
    ds_unlock();
    if (!passthrough || watch_modern_fs) {
        EnumWindows(ds_enum_adopt_window_cb, 0);
    }
    return 1;
}
