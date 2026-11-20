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

static LONG_PTR ds_get_class_bg_brush(HWND hwnd)
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
    return g_ds.real_GetWindowLongPtrW ? g_ds.real_GetWindowLongPtrW(hwnd, idx) : GetWindowLongPtrW(hwnd, idx);
#else
    return (LONG_PTR)(g_ds.real_GetWindowLongW ? g_ds.real_GetWindowLongW(hwnd, idx) : GetWindowLongW(hwnd, idx));
#endif
}

LONG_PTR ds_set_wnd_long_ptr_raw(HWND hwnd, int idx, LONG_PTR val, bool unicode)
{
#if defined(_WIN64)
    if (unicode) {
        return g_ds.real_SetWindowLongPtrW ? g_ds.real_SetWindowLongPtrW(hwnd, idx, val) : SetWindowLongPtrW(hwnd, idx, val);
    }
    return g_ds.real_SetWindowLongPtrA ? g_ds.real_SetWindowLongPtrA(hwnd, idx, val) : SetWindowLongPtrA(hwnd, idx, val);
#else
    if (unicode) {
        return (LONG_PTR)(g_ds.real_SetWindowLongW ? g_ds.real_SetWindowLongW(hwnd, idx, (LONG)val) : SetWindowLongW(hwnd, idx, (LONG)val));
    }
    return (LONG_PTR)(g_ds.real_SetWindowLongA ? g_ds.real_SetWindowLongA(hwnd, idx, (LONG)val) : SetWindowLongA(hwnd, idx, (LONG)val));
#endif
}



static BOOL CALLBACK ds_enum_adopt_window_cb(HWND hwnd, LPARAM lParam);

#define DS_GL_HOST_CHILD_CLASS_W L"OneLauncherGLHostChild"

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
    EnterCriticalSection(&g_ds.lock);
    bool fs_active = (hwnd_parent == g_ds.hwnd_game && g_ds.fullscreen_active);
    int32_t rw = g_ds.real_screen_w;
    int32_t rh = g_ds.real_screen_h;
    LeaveCriticalSection(&g_ds.lock);

    if (fs_active && rw > 0 && rh > 0) {
        *out_w = rw;
        *out_h = rh;
        return;
    }

    RECT crc = { 0, 0, 0, 0 };
    ds_enter_internal();
    BOOL ok = g_ds.real_GetClientRect ? g_ds.real_GetClientRect(hwnd_parent, &crc) : GetClientRect(hwnd_parent, &crc);
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

    EnterCriticalSection(&g_ds.lock);
    if (ds_is_modern_tier_locked()) {
        LeaveCriticalSection(&g_ds.lock);
        return;
    }
    HWND host = g_ds.hwnd_gl_host;
    bool vis = g_ds.gl_host_visible;
    LeaveCriticalSection(&g_ds.lock);

    if (!host || !IsWindow(host) || GetParent(host) != hwnd_parent) {
        return;
    }

    int32_t cw = 0, ch = 0;
    ds_get_gl_host_target_size(hwnd_parent, &cw, &ch);

    ds_enter_internal();
    UINT flags = SWP_NOACTIVATE | SWP_NOCOPYBITS | (vis ? SWP_SHOWWINDOW : SWP_NOZORDER);
    if (g_ds.real_SetWindowPos) {
        g_ds.real_SetWindowPos(host, HWND_TOP, 0, 0, cw, ch, flags);
    } else {
        SetWindowPos(host, HWND_TOP, 0, 0, cw, ch, flags);
    }
    ds_leave_internal();
}

void ds_refresh_gl_host_drawable_on_owner_thread(HWND hwnd_parent)
{
    if (!hwnd_parent || !IsWindow(hwnd_parent)) {
        return;
    }

    EnterCriticalSection(&g_ds.lock);
    if (ds_is_modern_tier_locked()) {
        LeaveCriticalSection(&g_ds.lock);
        return;
    }
    HWND host = g_ds.hwnd_gl_host;
    bool vis = (g_ds.gl_host_visible || g_ds.gl_host_want_visible);
    LeaveCriticalSection(&g_ds.lock);
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
    EnterCriticalSection(&g_ds.lock);
    g_ds.app_inactive = true;
    ds_cursor_warp_reset(&g_ds.warp);
    LeaveCriticalSection(&g_ds.lock);

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

void ds_ensure_gl_host_child_on_owner_thread(HWND hwnd_parent)
{
    if (!hwnd_parent || !IsWindow(hwnd_parent)) {
        return;
    }

    EnterCriticalSection(&g_ds.lock);
    if (ds_is_modern_tier_locked()) {
        LeaveCriticalSection(&g_ds.lock);
        return;
    }
    HWND cur_host = g_ds.hwnd_gl_host;
    LeaveCriticalSection(&g_ds.lock);

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

    static volatile LONG s_host_cls_reg = 0;
    if (InterlockedCompareExchange(&s_host_cls_reg, 1, 0) == 0) {
        WNDCLASSEXW wc;
        memset(&wc, 0, sizeof(wc));
        wc.cbSize = sizeof(wc);
        wc.style = 0;
        wc.lpfnWndProc = ds_gl_host_wndproc;
        wc.hInstance = g_ds.self_hmod ? g_ds.self_hmod : GetModuleHandleW(NULL);
        wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
        wc.lpszClassName = DS_GL_HOST_CHILD_CLASS_W;
        if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
            InterlockedExchange(&s_host_cls_reg, 0);
        }
    }

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
    ds_enter_internal();
    HWND host = g_ds.real_CreateWindowExW
        ? g_ds.real_CreateWindowExW(
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
              NULL)
        : CreateWindowExW(
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
              NULL);
    ds_leave_internal();

    EnterCriticalSection(&g_ds.lock);
    g_ds.hwnd_gl_host = host;
    g_ds.gl_host_visible = false;
    LeaveCriticalSection(&g_ds.lock);
}

static void ds_apply_gl_host_ctl_on_owner_thread(HWND hwnd_game, WPARAM mode, LPARAM expected_host)
{
    if (!hwnd_game || !IsWindow(hwnd_game)) {
        return;
    }

    if (mode == 1) {
        EnterCriticalSection(&g_ds.lock);
        bool want_vis = g_ds.gl_host_want_visible;
        HWND cur_host = g_ds.hwnd_gl_host;
        g_ds.gl_host_hide_queued = false;
        LeaveCriticalSection(&g_ds.lock);

        if (!want_vis) {
            return;
        }
        if (expected_host != 0 && cur_host != NULL && (HWND)(uintptr_t)expected_host != cur_host) {
            return;
        }

        ds_ensure_gl_host_child_on_owner_thread(hwnd_game);
        EnterCriticalSection(&g_ds.lock);
        HWND host = g_ds.hwnd_gl_host;
        g_ds.gl_host_visible = (host != NULL && IsWindow(host));
        LeaveCriticalSection(&g_ds.lock);

        if (host && IsWindow(host)) {
            int32_t cw = 0, ch = 0;
            ds_get_gl_host_target_size(hwnd_game, &cw, &ch);
            ds_enter_internal();
            if (g_ds.real_SetWindowPos) {
                g_ds.real_SetWindowPos(host, HWND_TOP, 0, 0, cw, ch, SWP_NOACTIVATE | SWP_NOCOPYBITS | SWP_SHOWWINDOW);
            } else {
                SetWindowPos(host, HWND_TOP, 0, 0, cw, ch, SWP_NOACTIVATE | SWP_NOCOPYBITS | SWP_SHOWWINDOW);
            }
            ds_leave_internal();
        }
        return;
    }

    EnterCriticalSection(&g_ds.lock);
    HWND old_host = g_ds.hwnd_gl_host;
    bool was_visible = g_ds.gl_host_visible;
    g_ds.gl_host_visible = false;
    g_ds.gl_host_want_visible = false;
    g_ds.gl_host_hide_queued = false;
    if (!was_visible && old_host != NULL && IsWindow(old_host) && GetParent(old_host) == hwnd_game) {
        LeaveCriticalSection(&g_ds.lock);
        return;
    }
    g_ds.hwnd_gl_host = NULL;
    LeaveCriticalSection(&g_ds.lock);

    if (old_host) {
        ds_gl_release_all_host_dcs_for_hwnd(old_host);
        if (IsWindow(old_host)) {
            ds_enter_internal();
            if (g_ds.real_ShowWindow) {
                g_ds.real_ShowWindow(old_host, SW_HIDE);
            } else {
                ShowWindow(old_host, SW_HIDE);
            }
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
    EnterCriticalSection(&g_ds.lock);
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
    LeaveCriticalSection(&g_ds.lock);

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
    bool should_post = false;
    EnterCriticalSection(&g_ds.lock);
    HWND hwnd = g_ds.hwnd_game;
    DWORD owner_tid = g_ds.game_thread_id;
    UINT msg = g_ds.msg_gl_host_ctl;
    bool need_hide = (g_ds.gl_host_visible || g_ds.gl_host_want_visible);
    g_ds.gl_host_want_visible = false;
    if (need_hide && !g_ds.gl_host_hide_queued) {
        g_ds.gl_host_hide_queued = true;
        should_post = true;
    }
    LeaveCriticalSection(&g_ds.lock);

    if (!hwnd || !IsWindow(hwnd) || !need_hide) return;
    if (GetCurrentThreadId() == owner_tid) {
        ds_apply_gl_host_ctl_on_owner_thread(hwnd, 0, 0);
    } else if (msg != 0 && should_post) {
        PostMessageW(hwnd, msg, 0, 0);
    }
}

static bool ds_has_dialog_child_controls(HWND hwnd)
{
    static const WCHAR k_dlg_cls_msz[] =
        L"Button\0ComboBox\0Edit\0ListBox\0SysTabControl32\0"
        L"SysListView32\0RichEdit20W\0RichEdit20A\0";
    HWND child = GetWindow(hwnd, GW_CHILD);
    for (int inspected = 0; child && inspected < 24; inspected++, child = GetWindow(child, GW_HWNDNEXT)) {
        if (!IsWindowVisible(child)) continue;
        WCHAR cls[64] = { 0 };
        if (GetClassNameW(child, cls, 63) > 0) {
            for (const WCHAR *p = k_dlg_cls_msz; *p != L'\0'; p += wcslen(p) + 1) {
                if (_wcsicmp(cls, p) == 0) return true;
            }
        }
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
        static const WCHAR k_skip_exact[] = L"#32770\0IME\0MSCTFIME UI\0ConsoleWindowClass\0";
        static const WCHAR k_skip_sub[] = L"WinConsole\0WineExplorer\0WineD3D\0DirectDrawDeviceWnd\0";
        for (const WCHAR *p = k_skip_exact; *p != L'\0'; p += wcslen(p) + 1) {
            if (_wcsicmp(cls, p) == 0) return false;
        }
        for (const WCHAR *p = k_skip_sub; *p != L'\0'; p += wcslen(p) + 1) {
            if (wcsstr(cls, p) != NULL) return false;
        }
    }

    if (GetWindowThreadProcessId(hwnd, NULL) == GetCurrentThreadId()) {
        WCHAR title[96] = { 0 };
        if (GetWindowTextW(hwnd, title, 95) > 0) {
            if (wcsstr(title, L"Console") != NULL) {
                return false;
            }
        }
    }

    if (!g_ds.mode_virtualized && ds_has_dialog_child_controls(hwnd)) {
        return false;
    }

    RECT rc = { 0, 0, 0, 0 };
    ds_enter_internal();
    BOOL ok = g_ds.real_GetClientRect ? g_ds.real_GetClientRect(hwnd, &rc) : GetClientRect(hwnd, &rc);
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
    if (ds_is_modern_tier_locked()) {
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
    EnterCriticalSection(&g_ds.lock);
    if (g_ds.status_file[0] == L'\0') {
        LeaveCriticalSection(&g_ds.lock);
        return;
    }
    WCHAR path_buf[MAX_PATH];
    wcsncpy(path_buf, g_ds.status_file, MAX_PATH - 1);
    path_buf[MAX_PATH - 1] = L'\0';
    uint64_t seq = ++g_ds.status_seq;
    bool fs_active = g_ds.fullscreen_active && !ds_is_passthrough_locked();
    bool passthrough = ds_is_passthrough_locked();
    const char *aspect_str = ds_aspect_mode_to_string(g_ds.aspect_mode);
    const char *filter_str = ds_scale_filter_to_string(g_ds.scale_filter);
    int32_t vw = g_ds.virt_w;
    int32_t vh = g_ds.virt_h;
    int32_t win_scale = ds_get_windowed_scale_locked();
    int32_t dw = fs_active ? g_ds.vp.dst_w : (vw * win_scale);
    int32_t dh = fs_active ? g_ds.vp.dst_h : (vh * win_scale);
    LeaveCriticalSection(&g_ds.lock);

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

    WCHAR tmp_path[MAX_PATH];
    _snwprintf(tmp_path, MAX_PATH - 1, L"%ls.tmp", path_buf);
    tmp_path[MAX_PATH - 1] = L'\0';

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
        WriteFile(hf, json, (DWORD)len, &written, NULL);
        CloseHandle(hf);
        MoveFileExW(tmp_path, path_buf, MOVEFILE_REPLACE_EXISTING);
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

static void ds_compute_fs_styles(LONG_PTR saved_style, LONG_PTR saved_exstyle, bool app_inactive, LONG_PTR *out_style, LONG_PTR *out_ex)
{
    *out_style = (saved_style & ~(LONG_PTR)(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_DLGFRAME | WS_BORDER | WS_MAXIMIZE | WS_MINIMIZE))
               | (LONG_PTR)(WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN);
    LONG_PTR ex = (saved_exstyle & ~(LONG_PTR)(WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE | WS_EX_TOPMOST));
    if (!app_inactive) {
        ex |= (LONG_PTR)WS_EX_TOPMOST;
    }
    *out_ex = ex;
}

LRESULT CALLBACK ds_game_subclass_wndproc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    WNDPROC orig = g_ds.orig_wndproc;
    bool is_unicode = g_ds.orig_wndproc_unicode;

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
            EnterCriticalSection(&g_ds.lock);
            if (wParam == 'F') {
                bool cur_fs = ds_is_modern_tier_locked() ? g_ds.borderless_active : g_ds.fullscreen_active;
                bool next_fs = !cur_fs;
                g_ds.fullscreen_active = next_fs;
                g_ds.user_forced_windowed = !next_fs;
                g_ds.user_forced_fullscreen = next_fs;
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
            LeaveCriticalSection(&g_ds.lock);

            ds_apply_window_presentation_on_owner_thread(hwnd);
            ds_write_status_file();
            return 0;
        }
    }

    if (msg == WM_NCDESTROY) {
        HWND dead_host = NULL;
        EnterCriticalSection(&g_ds.lock);
        if (hwnd == g_ds.hwnd_game) {
            if ((WNDPROC)ds_get_wnd_long_ptr(hwnd, GWLP_WNDPROC) == ds_game_subclass_wndproc) {
                ds_set_wnd_long_ptr_raw(hwnd, GWLP_WNDPROC, (LONG_PTR)orig, is_unicode);
            }
            dead_host = g_ds.hwnd_gl_host;
            g_ds.hwnd_game = NULL;
            g_ds.hwnd_gl_host = NULL;
            g_ds.gl_host_visible = false;
            g_ds.gl_host_want_visible = false;
            g_ds.gl_host_hide_queued = false;
            g_ds.borderless_active = false;
            g_ds.window_mutated_by_scaler = false;
            g_ds.passthrough_restored = false;
            g_ds.cocoa_fs_synced = false;
            g_ds.app_inactive = false;
            g_ds.visible_resync_needed = false;
            g_ds.visible_resync_done = false;
            g_ds.first_visible_tick = 0;
            g_ds.orig_wndproc = NULL;
            g_ds.has_saved_window_state = false;
            g_ds.has_saved_class_bg = false;
            g_ds.has_saved_hmenu = false;
            g_ds.saved_hmenu = NULL;
        }
        LeaveCriticalSection(&g_ds.lock);
        if (dead_host) {
            ds_gl_release_all_host_dcs_for_hwnd(dead_host);
        }
        EnumWindows(ds_enum_adopt_window_cb, 0);
        return ds_forward_to_orig_wndproc(orig, is_unicode, hwnd, msg, wParam, lParam);
    }

    EnterCriticalSection(&g_ds.lock);
    ds_presenter_tier_t tier = (g_ds.scaling_mode == DS_MODE_PASSTHROUGH)
        ? DS_PRESENTER_MODERN_PASSTHROUGH
        : g_ds.presenter_tier;
    bool is_target_hwnd = (hwnd == g_ds.hwnd_game);
    bool borderless_active = (tier == DS_PRESENTER_MODERN_BORDERLESS && is_target_hwnd && g_ds.borderless_active);
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
    LeaveCriticalSection(&g_ds.lock);

    /* Tier 1 (Modern Full Passthrough): zero-overhead transparent forwarding */
    if (tier == DS_PRESENTER_MODERN_PASSTHROUGH) {
        return ds_forward_to_orig_wndproc(orig, is_unicode, hwnd, msg, wParam, lParam);
    }

    /* Tier 2 (Modern Native Borderless): zero mouse/size/style virtualization; only display/focus upkeep */
    if (tier == DS_PRESENTER_MODERN_BORDERLESS) {
        if (msg == WM_DISPLAYCHANGE && !ds_is_internal_call()) {
            ds_refresh_host_display_metrics_for_hwnd(hwnd);
            if (borderless_active) {
                ds_apply_window_presentation_on_owner_thread(hwnd);
            }
        } else if (msg == WM_ACTIVATEAPP && borderless_active) {
            if (wParam == FALSE) {
                EnterCriticalSection(&g_ds.lock);
                g_ds.app_inactive = true;
                LeaveCriticalSection(&g_ds.lock);
                ds_drop_hwnd_topmost_and_unclip(hwnd);
            } else {
                EnterCriticalSection(&g_ds.lock);
                g_ds.app_inactive = false;
                int32_t bx = g_ds.win_mon_x;
                int32_t by = g_ds.win_mon_y;
                int32_t bw = g_ds.real_screen_w;
                int32_t bh = g_ds.real_screen_h;
                LeaveCriticalSection(&g_ds.lock);
                if (g_ds.real_SetWindowPos && bw > 0 && bh > 0) {
                    ds_enter_internal();
                    g_ds.real_SetWindowPos(hwnd, HWND_TOPMOST, bx, by, bw, bh, SWP_SHOWWINDOW | SWP_NOACTIVATE);
                    ds_leave_internal();
                }
            }
        }
        return ds_forward_to_orig_wndproc(orig, is_unicode, hwnd, msg, wParam, lParam);
    }

    if (!fs_active && win_scale > 1 && vw > 0 && vh > 0) {
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
                int32_t cx = (int32_t)(short)LOWORD(lParam);
                int32_t cy = (int32_t)(short)HIWORD(lParam);
                int32_t vx = cx, vy = cy;
                if (ds_map_cursor_phys_to_virt(cx, cy, 0, 0, vw * win_scale, vh * win_scale, vw, vh, &vx, &vy)) {
                    lParam = MAKELPARAM((WORD)(short)vx, (WORD)(short)vy);
                }
                break;
            }
            case WM_MOUSEWHEEL:
            case WM_MOUSEHWHEEL:
            case WM_CONTEXTMENU:
            case WM_NCHITTEST: {
                if (msg == WM_CONTEXTMENU && lParam == (LPARAM)-1) {
                    break;
                }
                if (g_ds.real_ClientToScreen) {
                    POINT orig_pt = { 0, 0 };
                    ds_enter_internal();
                    BOOL has_orig = g_ds.real_ClientToScreen(hwnd, &orig_pt);
                    ds_leave_internal();
                    if (has_orig) {
                        int32_t sx = (int32_t)(short)LOWORD(lParam);
                        int32_t sy = (int32_t)(short)HIWORD(lParam);
                        int32_t rel_x = sx - orig_pt.x;
                        int32_t rel_y = sy - orig_pt.y;
                        bool in_client = (rel_x >= 0 && rel_x < vw * win_scale && rel_y >= 0 && rel_y < vh * win_scale);
                        if (msg != WM_NCHITTEST || in_client) {
                            int32_t rvx = rel_x, rvy = rel_y;
                            if (ds_map_cursor_phys_to_virt(rel_x, rel_y, 0, 0, vw * win_scale, vh * win_scale, vw, vh, &rvx, &rvy)) {
                                lParam = MAKELPARAM((WORD)(short)(orig_pt.x + rvx), (WORD)(short)(orig_pt.y + rvy));
                            }
                        }
                    }
                }
                break;
            }
            case WM_WINDOWPOSCHANGING:
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
                break;
            case WM_SIZE:
                if (wParam != SIZE_MINIMIZED) {
                    lParam = MAKELPARAM((WORD)vw, (WORD)vh);
                }
                break;
            case WM_DISPLAYCHANGE:
                if (!ds_is_internal_call()) {
                    ds_refresh_host_display_metrics_for_hwnd(hwnd);
                }
                break;
            default:
                break;
        }
    }

    if (fs_active && vw > 0 && vh > 0 && vp.dst_w > 0 && vp.dst_h > 0) {
        int32_t scr_dst_x = mon_x + vp.dst_x;
        int32_t scr_dst_y = mon_y + vp.dst_y;
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
                /* Client-relative coordinates: map against client-relative vp.dst_x/y */
                int32_t cx = (int32_t)(short)LOWORD(lParam);
                int32_t cy = (int32_t)(short)HIWORD(lParam);
                int32_t vx = cx, vy = cy;
                if (ds_map_cursor_phys_to_virt(cx, cy, vp.dst_x, vp.dst_y, vp.dst_w, vp.dst_h, vw, vh, &vx, &vy)) {
                    lParam = MAKELPARAM((WORD)(short)vx, (WORD)(short)vy);
                }
                break;
            }
            case WM_MOUSEWHEEL:
            case WM_MOUSEHWHEEL:
            case WM_CONTEXTMENU: {
                /* Screen-absolute coordinates: offset by target monitor origin (mon_x, mon_y) */
                if (msg == WM_CONTEXTMENU && lParam == (LPARAM)-1) {
                    break;
                }
                int32_t sx = (int32_t)(short)LOWORD(lParam);
                int32_t sy = (int32_t)(short)HIWORD(lParam);
                int32_t vx = sx, vy = sy;
                if (ds_map_cursor_phys_to_virt(sx, sy, scr_dst_x, scr_dst_y, vp.dst_w, vp.dst_h, vw, vh, &vx, &vy)) {
                    lParam = MAKELPARAM((WORD)(short)vx, (WORD)(short)vy);
                }
                break;
            }
            case WM_NCHITTEST: {
                int32_t sx = (int32_t)(short)LOWORD(lParam);
                int32_t sy = (int32_t)(short)HIWORD(lParam);
                int32_t vx = sx, vy = sy;
                if (ds_map_cursor_phys_to_virt(sx, sy, scr_dst_x, scr_dst_y, vp.dst_w, vp.dst_h, vw, vh, &vx, &vy)) {
                    lParam = MAKELPARAM((WORD)(short)vx, (WORD)(short)vy);
                }
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
                    ss->styleNew = (ss->styleNew & ~(DWORD)(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_DLGFRAME | WS_BORDER | WS_MAXIMIZE | WS_MINIMIZE))
                                 | (DWORD)(WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN);
                    return 0;
                }
                break;
            case WM_WINDOWPOSCHANGING: {
                EnterCriticalSection(&g_ds.lock);
                bool staging_birth = !g_ds.cocoa_fs_synced && g_ds.first_visible_tick != 0 &&
                                     (GetTickCount() - g_ds.first_visible_tick) < 250;
                LeaveCriticalSection(&g_ds.lock);
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
            case WM_SIZE:
                if (wParam != SIZE_MINIMIZED) {
                    lParam = MAKELPARAM((WORD)vw, (WORD)vh);
                }
                break;
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
                    EnterCriticalSection(&g_ds.lock);
                    bool active_now = !g_ds.app_inactive;
                    LeaveCriticalSection(&g_ds.lock);
                    if (active_now) {
                        ds_request_apply_presentation();
                    }
                }
                break;
            case WM_ACTIVATEAPP:
                if (wParam == FALSE) {
                    EnterCriticalSection(&g_ds.lock);
                    g_ds.app_inactive = true;
                    ds_cursor_warp_reset(&g_ds.warp);
                    LeaveCriticalSection(&g_ds.lock);
                    ds_ensure_fullscreen_styles_on_owner_thread(hwnd);
                    ds_drop_hwnd_topmost_and_unclip(hwnd);
                    if (g_ds.real_ClipCursor) {
                        g_ds.real_ClipCursor(NULL);
                    }
                } else {
                    EnterCriticalSection(&g_ds.lock);
                    g_ds.app_inactive = false;
                    ds_cursor_warp_reset(&g_ds.warp);
                    bool staging_birth = !g_ds.cocoa_fs_synced && g_ds.first_visible_tick != 0 &&
                                         (GetTickCount() - g_ds.first_visible_tick) < 250;
                    int32_t ax = g_ds.win_mon_x;
                    int32_t ay = g_ds.win_mon_y;
                    int32_t aw = g_ds.real_screen_w;
                    int32_t ah = g_ds.real_screen_h;
                    LeaveCriticalSection(&g_ds.lock);
                    if (!staging_birth) {
                        ds_ensure_fullscreen_styles_on_owner_thread(hwnd);
                        if (g_ds.real_SetWindowPos) {
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
                        }
                        ds_refresh_gl_host_drawable_on_owner_thread(hwnd);
                    }
                    EnterCriticalSection(&g_ds.lock);
                    ds_reapply_cursor_clip_locked();
                    LeaveCriticalSection(&g_ds.lock);
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
static void ds_capture_window_baseline_and_subclass_locked(HWND hwnd)
{
    if (!g_ds.has_saved_window_state) {
        g_ds.saved_style = ds_get_wnd_long_ptr(hwnd, GWL_STYLE);
        g_ds.saved_exstyle = ds_get_wnd_long_ptr(hwnd, GWL_EXSTYLE);
        ds_enter_internal();
        if (g_ds.real_GetWindowRect) {
            g_ds.real_GetWindowRect(hwnd, &g_ds.saved_window_rect);
        }
        RECT crc = { 0, 0, 0, 0 };
        if (g_ds.real_GetClientRect && g_ds.real_GetClientRect(hwnd, &crc)) {
            g_ds.saved_client_w = crc.right - crc.left;
            g_ds.saved_client_h = crc.bottom - crc.top;
        }
        ds_leave_internal();
        g_ds.has_saved_window_state = true;
    }
    if (!g_ds.has_saved_hmenu) {
        g_ds.saved_hmenu = GetMenu(hwnd);
        g_ds.has_saved_hmenu = true;
    }
    if (!g_ds.has_saved_class_bg) {
        g_ds.saved_class_bg = ds_get_class_bg_brush(hwnd);
        g_ds.has_saved_class_bg = true;
    }
    if (g_ds.orig_wndproc == NULL) {
        g_ds.orig_wndproc_unicode = (IsWindowUnicode(hwnd) != FALSE);
        WNDPROC cur_proc = (WNDPROC)ds_get_wnd_long_ptr(hwnd, GWLP_WNDPROC);
        if (cur_proc != ds_game_subclass_wndproc) {
            ds_enter_internal();
            g_ds.orig_wndproc = (WNDPROC)ds_set_wnd_long_ptr_raw(
                hwnd,
                GWLP_WNDPROC,
                (LONG_PTR)ds_game_subclass_wndproc,
                g_ds.orig_wndproc_unicode
            );
            ds_leave_internal();
        }
    }
}

void ds_ensure_fullscreen_styles_on_owner_thread(HWND hwnd)
{
    if (!hwnd || !IsWindow(hwnd)) return;

    EnterCriticalSection(&g_ds.lock);
    if (g_ds.hwnd_game != hwnd || !g_ds.fullscreen_active || ds_is_modern_tier_locked()) {
        LeaveCriticalSection(&g_ds.lock);
        return;
    }
    ds_capture_window_baseline_and_subclass_locked(hwnd);
    LONG_PTR saved_style = g_ds.saved_style;
    LONG_PTR saved_exstyle = g_ds.saved_exstyle;
    bool app_inactive = g_ds.app_inactive;
    bool is_unicode = g_ds.orig_wndproc != NULL
        ? g_ds.orig_wndproc_unicode
        : (IsWindowUnicode(hwnd) != FALSE);
    g_ds.window_mutated_by_scaler = true;
    LeaveCriticalSection(&g_ds.lock);

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
    EnterCriticalSection(&g_ds.lock);
    host = g_ds.hwnd_gl_host;
    g_ds.hwnd_gl_host = NULL;
    g_ds.gl_host_visible = false;
    g_ds.gl_host_want_visible = false;
    g_ds.gl_host_hide_queued = false;
    LeaveCriticalSection(&g_ds.lock);

    if (host != NULL) {
        ds_gl_release_all_host_dcs_for_hwnd(host);
        if (IsWindow(host)) {
            ds_enter_internal();
            DestroyWindow(host);
            ds_leave_internal();
        }
    }
}

void ds_restore_window_on_passthrough(HWND hwnd)
{
    if (!hwnd || !IsWindow(hwnd)) return;

    ds_destroy_gl_host_on_owner_thread();
    ds_gl_shutdown();

    EnterCriticalSection(&g_ds.lock);
    if (g_ds.hwnd_game != hwnd) {
        LeaveCriticalSection(&g_ds.lock);
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
    g_ds.mode_virtualized = false;
    g_ds.cocoa_fs_synced = false;
    g_ds.passthrough_restored = true;
    LeaveCriticalSection(&g_ds.lock);

    ds_enter_internal();
    ds_clear_wine_present_rect_on_hwnd(hwnd);
    if (mutated && has_saved) {
        if (has_bg) {
            ds_set_class_bg_brush(hwnd, saved_bg);
        }
        ds_set_wnd_long_ptr_raw(hwnd, GWL_STYLE, saved_style, is_unicode);
        ds_set_wnd_long_ptr_raw(hwnd, GWL_EXSTYLE, saved_exstyle, is_unicode);
        if (saved_menu != NULL && IsMenu(saved_menu) && GetMenu(hwnd) != saved_menu) {
            SetMenu(hwnd, saved_menu);
        }
        if (g_ds.real_SetWindowPos) {
            RECT cur_rc = { 0, 0, 0, 0 };
            BOOL has_cur = g_ds.real_GetWindowRect ? g_ds.real_GetWindowRect(hwnd, &cur_rc) : FALSE;
            bool cur_is_full = has_cur && mon_w > 0 && mon_h > 0 &&
                               (cur_rc.right - cur_rc.left) >= mon_w &&
                               (cur_rc.bottom - cur_rc.top) >= mon_h;
            int sw = saved_rc.right - saved_rc.left;
            int sh = saved_rc.bottom - saved_rc.top;
            if (!cur_is_full && sw > 0 && sh > 0) {
                UINT restore_flags = SWP_NOACTIVATE | SWP_FRAMECHANGED;
                g_ds.real_SetWindowPos(
                    hwnd,
                    HWND_NOTOPMOST,
                    saved_rc.left,
                    saved_rc.top,
                    sw,
                    sh,
                    restore_flags
                );
            } else {
                UINT restore_flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED;
                g_ds.real_SetWindowPos(
                    hwnd,
                    HWND_NOTOPMOST,
                    0,
                    0,
                    0,
                    0,
                    restore_flags
                );
            }
        }
    }
    if (g_ds.real_ClipCursor) {
        g_ds.real_ClipCursor(NULL);
    }
    ds_leave_internal();

    ds_tracef("passthrough_restored hwnd=%p mutated=%d tier=%d", hwnd, (int)mutated, (int)tier);

    /* If transitioning directly from Tier 0 -> Tier 2 (Modern Borderless), apply Tier 2 now */
    if (tier == DS_PRESENTER_MODERN_BORDERLESS) {
        ds_apply_window_presentation_on_owner_thread(hwnd);
    }
}

void ds_request_restore_passthrough(void)
{
    EnterCriticalSection(&g_ds.lock);
    HWND hwnd = g_ds.hwnd_game;
    DWORD owner_tid = g_ds.game_thread_id;
    UINT msg = g_ds.msg_apply_presentation;
    LeaveCriticalSection(&g_ds.lock);

    if (!hwnd || !IsWindow(hwnd)) return;
    if (GetCurrentThreadId() == owner_tid) {
        ds_restore_window_on_passthrough(hwnd);
    } else if (msg != 0) {
        PostMessageW(hwnd, msg, (WPARAM)DS_APPLY_RESTORE_PASSTHROUGH, 0);
    }
}

void ds_apply_window_presentation_on_owner_thread(HWND hwnd)
{
    if (!hwnd || !IsWindow(hwnd)) return;

    /* Keep monitor coordinates & DPI space synchronized if hwnd moved to another monitor */
    HMONITOR cur_mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    if (cur_mon != NULL && cur_mon != g_ds.target_monitor) {
        ds_refresh_host_display_metrics_for_hwnd(hwnd);
    }

    EnterCriticalSection(&g_ds.lock);
    if (g_ds.hwnd_game != hwnd) {
        LeaveCriticalSection(&g_ds.lock);
        return;
    }

    ds_capture_window_baseline_and_subclass_locked(hwnd);

    ds_presenter_tier_t tier = (g_ds.scaling_mode == DS_MODE_PASSTHROUGH)
        ? DS_PRESENTER_MODERN_PASSTHROUGH
        : g_ds.presenter_tier;
    bool need_pt_restore = (!g_ds.passthrough_restored || g_ds.hwnd_gl_host != NULL || g_ds.window_mutated_by_scaler);
    bool app_inactive = g_ds.app_inactive;
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
    bool is_unicode = g_ds.orig_wndproc_unicode;
    LeaveCriticalSection(&g_ds.lock);

    /* Tier 1 (Modern Full Passthrough): ensure clean restoration and never mutate window */
    if (tier == DS_PRESENTER_MODERN_PASSTHROUGH) {
        if (need_pt_restore) {
            ds_restore_window_on_passthrough(hwnd);
        }
        return;
    }

    /* Tier 2 (Modern Native Borderless): toggle WS_POPUP + full monitor only; ZERO GLHost/virtualization */
    if (tier == DS_PRESENTER_MODERN_BORDERLESS) {
        ds_destroy_gl_host_on_owner_thread();
        ds_refresh_host_display_metrics_for_hwnd(hwnd);
        EnterCriticalSection(&g_ds.lock);
        mon_x = g_ds.win_mon_x;
        mon_y = g_ds.win_mon_y;
        mon_w = g_ds.real_screen_w;
        mon_h = g_ds.real_screen_h;
        LeaveCriticalSection(&g_ds.lock);

        HANDLE win_ctx = (g_ds.p_GetWindowDpiAwarenessContext != NULL)
            ? g_ds.p_GetWindowDpiAwarenessContext(hwnd)
            : DS_DPI_CTX_PMV2;
        HANDLE prev_dpi = ds_dpi_guard_enter(win_ctx);
        ds_enter_internal();
        if (want_tier2_fs && mon_w > 0 && mon_h > 0) {
            LONG_PTR fs_style = 0, fs_ex = 0;
            ds_compute_fs_styles(saved_style, saved_exstyle, app_inactive, &fs_style, &fs_ex);
            ds_set_wnd_long_ptr_raw(hwnd, GWL_STYLE, fs_style, is_unicode);
            ds_set_wnd_long_ptr_raw(hwnd, GWL_EXSTYLE, fs_ex, is_unicode);
            if (g_ds.real_SetWindowPos) {
                UINT t2_flags = SWP_FRAMECHANGED | SWP_SHOWWINDOW | (app_inactive ? SWP_NOACTIVATE : 0);
                ds_clear_wine_present_rect_on_hwnd(hwnd);
                g_ds.real_SetWindowPos(
                    hwnd,
                    app_inactive ? HWND_NOTOPMOST : HWND_TOPMOST,
                    mon_x,
                    mon_y,
                    mon_w,
                    mon_h,
                    t2_flags
                );
            }
            EnterCriticalSection(&g_ds.lock);
            g_ds.borderless_active = true;
            g_ds.window_mutated_by_scaler = true;
            LeaveCriticalSection(&g_ds.lock);
        } else {
            LONG_PTR win_style = saved_style;
            if ((win_style & WS_POPUP) != 0) {
                win_style = (win_style & ~(LONG_PTR)WS_POPUP) | (LONG_PTR)(WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX);
            }
            win_style |= WS_VISIBLE;
            ds_set_wnd_long_ptr_raw(hwnd, GWL_STYLE, win_style, is_unicode);
            ds_set_wnd_long_ptr_raw(hwnd, GWL_EXSTYLE, saved_exstyle, is_unicode);
            if (saved_menu != NULL && IsMenu(saved_menu) && GetMenu(hwnd) != saved_menu) {
                SetMenu(hwnd, saved_menu);
            }
            if (g_ds.real_SetWindowPos) {
                int sw = saved_rc.right - saved_rc.left;
                int sh = saved_rc.bottom - saved_rc.top;
                if (sw > 0 && sh > 0) {
                    g_ds.real_SetWindowPos(hwnd, HWND_NOTOPMOST, saved_rc.left, saved_rc.top, sw, sh, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
                } else {
                    g_ds.real_SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
                }
            }
            EnterCriticalSection(&g_ds.lock);
            g_ds.borderless_active = false;
            g_ds.window_mutated_by_scaler = false;
            LeaveCriticalSection(&g_ds.lock);
        }
        ds_leave_internal();
        ds_dpi_guard_leave(prev_dpi);
        return;
    }

    if (fs_active && app_inactive) {
        ds_enter_internal();
        ds_ensure_gl_host_child_on_owner_thread(hwnd);
        ds_leave_internal();
        ds_gl_notify_mode_changed();
        return;
    }

    HANDLE win_ctx = (g_ds.p_GetWindowDpiAwarenessContext != NULL)
        ? g_ds.p_GetWindowDpiAwarenessContext(hwnd)
        : DS_DPI_CTX_PMV2;
    HANDLE prev_dpi = ds_dpi_guard_enter(win_ctx);
    ds_enter_internal();
    if (fs_active && vp.dst_w > 0 && vp.dst_h > 0) {
        EnterCriticalSection(&g_ds.lock);
        g_ds.window_mutated_by_scaler = true;
        LeaveCriticalSection(&g_ds.lock);
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
            EnterCriticalSection(&g_ds.lock);
            g_ds.first_visible_tick = birth_tick;
            g_ds.cocoa_fs_synced = false;
            LeaveCriticalSection(&g_ds.lock);

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
            EnterCriticalSection(&g_ds.lock);
            g_ds.cocoa_fs_synced = true;
            g_ds.first_visible_tick = 0;
            LeaveCriticalSection(&g_ds.lock);

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
                    if (mon_x == 0 && mon_y == 0) {
                        int32_t screen_w = mon_w;
                        int32_t screen_h = mon_h;
                        g_ds.real_SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, screen_w, screen_h, swp_flags);
                    } else {
                        g_ds.real_SetWindowPos(hwnd, HWND_TOPMOST, mon_x, mon_y, mon_w, mon_h, swp_flags);
                    }
                }
                BringWindowToTop(hwnd);
                SetForegroundWindow(hwnd);
                SetActiveWindow(hwnd);
                SetFocus(hwnd);
            }
        }
    } else {
        if (g_ds.has_saved_class_bg) {
            ds_set_class_bg_brush(hwnd, g_ds.saved_class_bg);
        }
        LONG_PTR win_style = saved_style;
        if ((win_style & WS_POPUP) != 0) {
            win_style = (win_style & ~(LONG_PTR)WS_POPUP) | (LONG_PTR)(WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX);
        }
        win_style |= WS_VISIBLE;
        ds_set_wnd_long_ptr_raw(hwnd, GWL_STYLE, win_style, is_unicode);
        ds_set_wnd_long_ptr_raw(hwnd, GWL_EXSTYLE, saved_exstyle, is_unicode);
        BOOL has_restored_menu = FALSE;
        if (saved_menu != NULL && IsMenu(saved_menu)) {
            if (GetMenu(hwnd) != saved_menu) {
                SetMenu(hwnd, saved_menu);
            }
            has_restored_menu = TRUE;
        }

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

    EnterCriticalSection(&g_ds.lock);
    ds_reapply_cursor_clip_locked();
    LeaveCriticalSection(&g_ds.lock);
    ds_gl_notify_mode_changed();
}

void ds_request_apply_presentation(void)
{
    EnterCriticalSection(&g_ds.lock);
    HWND hwnd = g_ds.hwnd_game;
    DWORD owner_tid = g_ds.game_thread_id;
    UINT msg = g_ds.msg_apply_presentation;
    LeaveCriticalSection(&g_ds.lock);

    if (!hwnd || !IsWindow(hwnd)) return;
    if (GetCurrentThreadId() == owner_tid) {
        ds_apply_window_presentation_on_owner_thread(hwnd);
    } else if (msg != 0) {
        PostMessageW(hwnd, msg, 0, 0);
    }
}

void ds_observe_game_window_passive(HWND hwnd)
{
    int32_t cw = 0, ch = 0;
    if (!ds_is_candidate_game_window(hwnd, &cw, &ch)) {
        return;
    }

    bool adopted = false;
    DWORD owner_tid = 0;
    EnterCriticalSection(&g_ds.lock);
    bool should_adopt = (g_ds.hwnd_game == NULL || !IsWindow(g_ds.hwnd_game) || g_ds.hwnd_game == hwnd);
    if (!should_adopt && g_ds.hwnd_game != hwnd) {
        WCHAR prev_cls[64] = { 0 };
        GetClassNameW(g_ds.hwnd_game, prev_cls, 63);
        if (wcsstr(prev_cls, L"Console") != NULL || !IsWindowVisible(g_ds.hwnd_game) || IsIconic(g_ds.hwnd_game)) {
            should_adopt = true;
        }
    }
    if (should_adopt) {
        if (g_ds.hwnd_game != hwnd) {
            g_ds.orig_wndproc = NULL;
            g_ds.has_saved_window_state = false;
            g_ds.has_saved_class_bg = false;
            g_ds.has_saved_hmenu = false;
            g_ds.saved_hmenu = NULL;
            g_ds.borderless_active = false;
            g_ds.window_mutated_by_scaler = false;
            g_ds.passthrough_restored = true;
        }
        g_ds.hwnd_game = hwnd;
        g_ds.game_thread_id = GetWindowThreadProcessId(hwnd, NULL);
        owner_tid = g_ds.game_thread_id;
        adopted = true;
        if (GetCurrentThreadId() == owner_tid) {
            ds_capture_window_baseline_and_subclass_locked(hwnd);
        }
    }
    LeaveCriticalSection(&g_ds.lock);

    if (adopted) {
        ds_refresh_host_display_metrics_for_hwnd(hwnd);
    }
}

void ds_attach_and_apply_game_window(HWND hwnd, int32_t hint_virt_w, int32_t hint_virt_h)
{
    EnterCriticalSection(&g_ds.lock);
    ds_presenter_tier_t tier = (g_ds.scaling_mode == DS_MODE_PASSTHROUGH)
        ? DS_PRESENTER_MODERN_PASSTHROUGH
        : g_ds.presenter_tier;
    bool want_tier2_apply = (
        tier == DS_PRESENTER_MODERN_BORDERLESS &&
        !g_ds.user_forced_windowed &&
        (g_ds.scaling_mode == DS_MODE_FORCE_FULLSCREEN || g_ds.user_forced_fullscreen || g_ds.fullscreen_active)
    );
    LeaveCriticalSection(&g_ds.lock);

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

    EnterCriticalSection(&g_ds.lock);
    if (ds_is_modern_tier_locked()) {
        LeaveCriticalSection(&g_ds.lock);
        return;
    }
    bool should_adopt = (g_ds.hwnd_game == NULL || !IsWindow(g_ds.hwnd_game) || g_ds.hwnd_game == hwnd);
    if (!should_adopt && g_ds.hwnd_game != hwnd) {
        WCHAR prev_cls[64] = { 0 };
        GetClassNameW(g_ds.hwnd_game, prev_cls, 63);
        if (wcsstr(prev_cls, L"Console") != NULL || !IsWindowVisible(g_ds.hwnd_game) || IsIconic(g_ds.hwnd_game)) {
            should_adopt = true;
        }
    }
    if (should_adopt) {
        if (g_ds.hwnd_game != hwnd) {
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
            g_ds.borderless_active = false;
            g_ds.window_mutated_by_scaler = false;
            g_ds.passthrough_restored = false;
        }
        g_ds.hwnd_game = hwnd;
        g_ds.game_thread_id = GetWindowThreadProcessId(hwnd, NULL);
        if (!g_ds.has_saved_window_state) {
            g_ds.saved_style = style;
            g_ds.saved_exstyle = ds_get_wnd_long_ptr(hwnd, GWL_EXSTYLE);
            ds_enter_internal();
            if (g_ds.real_GetWindowRect) {
                g_ds.real_GetWindowRect(hwnd, &g_ds.saved_window_rect);
            }
            ds_leave_internal();
            g_ds.saved_client_w = cw;
            g_ds.saved_client_h = ch;
            g_ds.has_saved_window_state = true;
        }
        if (!g_ds.has_saved_hmenu) {
            g_ds.saved_hmenu = GetMenu(hwnd);
            g_ds.has_saved_hmenu = true;
        }
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
    LeaveCriticalSection(&g_ds.lock);

    if (should_adopt && !should_apply && GetCurrentThreadId() == owner_tid) {
        EnterCriticalSection(&g_ds.lock);
        if (g_ds.orig_wndproc == NULL) {
            g_ds.orig_wndproc_unicode = (IsWindowUnicode(hwnd) != FALSE);
            WNDPROC cur_proc = (WNDPROC)ds_get_wnd_long_ptr(hwnd, GWLP_WNDPROC);
            if (cur_proc != ds_game_subclass_wndproc) {
                ds_enter_internal();
                g_ds.orig_wndproc = (WNDPROC)ds_set_wnd_long_ptr_raw(
                    hwnd,
                    GWLP_WNDPROC,
                    (LONG_PTR)ds_game_subclass_wndproc,
                    g_ds.orig_wndproc_unicode
                );
                ds_leave_internal();
            }
        }
        LeaveCriticalSection(&g_ds.lock);
        ds_enter_internal();
        ds_ensure_gl_host_child_on_owner_thread(hwnd);
        ds_leave_internal();
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

static uint64_t ds_current_unix_ms(void)
{
    FILETIME ft = { 0, 0 };
    GetSystemTimeAsFileTime(&ft);
    uint64_t t100ns = ((uint64_t)ft.dwHighDateTime << 32) | (uint64_t)ft.dwLowDateTime;
    const uint64_t epoch_diff = 116444736000000000ULL;
    return (t100ns > epoch_diff) ? ((t100ns - epoch_diff) / 10000ULL) : 0ULL;
}

static bool ds_read_ini_file_utf8(const WCHAR *path, char *out_buf, size_t cap, size_t *out_len)
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
        bool cur_fs = ds_is_modern_tier_locked() ? g_ds.borderless_active : g_ds.fullscreen_active;
        if (ctl->fullscreen != cur_fs ||
            g_ds.user_forced_fullscreen != ctl->fullscreen ||
            g_ds.user_forced_windowed != !ctl->fullscreen) {
            g_ds.fullscreen_active = ctl->fullscreen;
            g_ds.user_forced_windowed = !ctl->fullscreen;
            g_ds.user_forced_fullscreen = ctl->fullscreen;
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

static void ds_poll_active_session_if_needed(void)
{
    WCHAR sess_path[MAX_PATH];
    WCHAR cur_ctl[MAX_PATH];
    EnterCriticalSection(&g_ds.lock);
    wcsncpy(sess_path, g_ds.active_session_file, MAX_PATH - 1);
    sess_path[MAX_PATH - 1] = L'\0';
    wcsncpy(cur_ctl, g_ds.control_file, MAX_PATH - 1);
    cur_ctl[MAX_PATH - 1] = L'\0';
    LeaveCriticalSection(&g_ds.lock);

    if (sess_path[0] == L'\0') return;
    if (cur_ctl[0] != L'\0') {
        ds_enter_internal();
        DWORD attr = GetFileAttributesW(cur_ctl);
        ds_leave_internal();
        if (attr != INVALID_FILE_ATTRIBUTES) {
            return;
        }
    }

    char buf[1536];
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
    EnterCriticalSection(&g_ds.lock);
    uint64_t eff_seq = ds_effective_active_session_seq(&sess);
    if (new_ctl[0] != L'\0' && _wcsicmp(new_ctl, g_ds.control_file) != 0) {
        wcsncpy(g_ds.control_file, new_ctl, MAX_PATH - 1);
        g_ds.control_file[MAX_PATH - 1] = L'\0';
        g_ds.last_control_seq = 0;
    }
    if (new_status[0] != L'\0' && _wcsicmp(new_status, g_ds.status_file) != 0) {
        wcsncpy(g_ds.status_file, new_status, MAX_PATH - 1);
        g_ds.status_file[MAX_PATH - 1] = L'\0';
    }
    if (eff_seq > g_ds.last_active_session_seq) {
        g_ds.last_active_session_seq = eff_seq;
        changed = ds_apply_parsed_control_locked(&sess);
    }
    LeaveCriticalSection(&g_ds.lock);

    if (changed) {
        if (g_ds.hwnd_game == NULL || !IsWindow(g_ds.hwnd_game)) {
            EnumWindows(ds_enum_adopt_window_cb, 0);
        }
        ds_request_apply_presentation();
        ds_write_status_file();
    }
}

void ds_poll_control_file_once(void)
{
    ds_poll_active_session_if_needed();

    WCHAR ctl_path[MAX_PATH];
    EnterCriticalSection(&g_ds.lock);
    wcsncpy(ctl_path, g_ds.control_file, MAX_PATH - 1);
    ctl_path[MAX_PATH - 1] = L'\0';
    LeaveCriticalSection(&g_ds.lock);

    if (ctl_path[0] == L'\0') return;

    char buf[1536];
    size_t bytes_read = 0;
    if (!ds_read_ini_file_utf8(ctl_path, buf, sizeof(buf), &bytes_read)) {
        return;
    }

    ds_control_state_t ctl;
    if (!ds_parse_control_ini(buf, bytes_read, &ctl) || !ctl.has_seq) {
        return;
    }

    bool changed = false;
    EnterCriticalSection(&g_ds.lock);
    if (ctl.seq > g_ds.last_control_seq) {
        g_ds.last_control_seq = ctl.seq;
        if (ctl.has_status_file && ctl.status_file[0] != '\0' && g_ds.status_file[0] == L'\0') {
            MultiByteToWideChar(CP_UTF8, 0, ctl.status_file, -1, g_ds.status_file, MAX_PATH - 1);
        }
        changed = ds_apply_parsed_control_locked(&ctl);
    }
    LeaveCriticalSection(&g_ds.lock);

    if (changed) {
        if (g_ds.hwnd_game == NULL || !IsWindow(g_ds.hwnd_game)) {
            EnumWindows(ds_enum_adopt_window_cb, 0);
        }
        ds_request_apply_presentation();
        ds_write_status_file();
    }
}

void ds_ensure_game_window_bounds(HWND candidate_hwnd)
{
    if (ds_is_internal_call()) return;

    EnterCriticalSection(&g_ds.lock);
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
    LeaveCriticalSection(&g_ds.lock);

    if (!want_check || app_inactive || mon_w <= 0 || mon_h <= 0) return;
    if (!hwnd || !IsWindow(hwnd)) return;
    if (candidate_hwnd != NULL && candidate_hwnd != hwnd) return;
    if (!IsWindowVisible(hwnd)) return;

    ds_enter_internal();
    RECT rc = { 0, 0, 0, 0 };
    BOOL has_rc = g_ds.real_GetWindowRect ? g_ds.real_GetWindowRect(hwnd, &rc) : FALSE;
    LONG_PTR style = ds_get_wnd_long_ptr(hwnd, GWL_STYLE);
    ds_leave_internal();

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
    static DWORD s_last_hit_probe_tick = 0;
    static int s_consec_resync_attempts = 0;
    EnterCriticalSection(&g_ds.lock);
    if (g_ds.hwnd_game == hwnd && !g_ds.cocoa_fs_synced && g_ds.first_visible_tick != 0) {
        if ((now_tick - g_ds.first_visible_tick) < 250) {
            waiting_birth_drain = true;
        } else {
            g_ds.cocoa_fs_synced = true;
            g_ds.first_visible_tick = 0;
            promote_staged_birth = true;
        }
    } else if (g_ds.hwnd_game == hwnd && g_ds.cocoa_fs_synced && !rect_drifted && !style_drifted &&
               (now_tick - s_last_hit_probe_tick) >= 450) {
        s_last_hit_probe_tick = now_tick;
        check_visible_hit = true;
    }
    LeaveCriticalSection(&g_ds.lock);

    if (waiting_birth_drain) {
        return;
    }

    if (check_visible_hit && GetForegroundWindow() == hwnd && g_ds.real_WindowFromPoint && mon_w > 16) {
        POINT edge_pt = { mon_x + mon_w - 2, mon_y + mon_h / 2 };
        ds_enter_internal();
        HWND hit = g_ds.real_WindowFromPoint(edge_pt);
        ds_leave_internal();
        EnterCriticalSection(&g_ds.lock);
        if (g_ds.hwnd_game == hwnd) {
            if (hit == NULL || hit == GetDesktopWindow()) {
                if (s_consec_resync_attempts < 6) {
                    s_consec_resync_attempts++;
                    g_ds.visible_resync_needed = true;
                    g_ds.visible_resync_done = true;
                    promote_staged_birth = true;
                }
            } else {
                s_consec_resync_attempts = 0;
                g_ds.visible_resync_done = true;
            }
        }
        LeaveCriticalSection(&g_ds.lock);
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

        EnterCriticalSection(&g_ds.lock);
        bool passthrough = ds_is_passthrough_locked();
        LeaveCriticalSection(&g_ds.lock);

        if (!passthrough) {
            if (g_ds.hwnd_game == NULL || !IsWindow(g_ds.hwnd_game)) {
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
    EnterCriticalSection(&g_ds.lock);
    bool passthrough = ds_is_passthrough_locked();
    LeaveCriticalSection(&g_ds.lock);
    if (!passthrough) {
        EnumWindows(ds_enum_adopt_window_cb, 0);
    }
    return 1;
}
