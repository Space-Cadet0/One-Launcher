/*
 * One Launcher Clean-Room Win32 Universal Display Virtualizer & Fullscreen Presenter
 * Core PE IAT Patcher, Mode Virtualizer, Window/Cursor Hooks & Child Propagation
 * (`display_scaler_dll.c`)
 */

#include "display_scaler_internal.h"
#include <tlhelp32.h>
#include <shellapi.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#if defined(__GNUC__) || defined(__clang__)
__attribute__((used))
#endif
const char g_onelauncher_display_scaler_marker[] = DS_MARKER_DLL;

ds_runtime_t g_ds = { 0 };

uint32_t WINAPI OneLauncherDisplayScalerGetVersion(void)
{
    volatile const char *m = g_onelauncher_display_scaler_marker;
    return (m && m[0]) ? 0x00010000u : 0u;
}

bool ds_is_internal_call(void)
{
    if (g_ds.tls_depth_idx == TLS_OUT_OF_INDEXES) return false;
    return (uintptr_t)TlsGetValue(g_ds.tls_depth_idx) > 0;
}

void ds_enter_internal(void)
{
    if (g_ds.tls_depth_idx == TLS_OUT_OF_INDEXES) return;
    uintptr_t cur = (uintptr_t)TlsGetValue(g_ds.tls_depth_idx);
    TlsSetValue(g_ds.tls_depth_idx, (LPVOID)(cur + 1));
}

void ds_leave_internal(void)
{
    if (g_ds.tls_depth_idx == TLS_OUT_OF_INDEXES) return;
    uintptr_t cur = (uintptr_t)TlsGetValue(g_ds.tls_depth_idx);
    if (cur > 0) {
        TlsSetValue(g_ds.tls_depth_idx, (LPVOID)(cur - 1));
    }
}

uintptr_t ds_suspend_internal_depth(void)
{
    if (g_ds.tls_depth_idx == TLS_OUT_OF_INDEXES) return 0;
    uintptr_t cur = (uintptr_t)TlsGetValue(g_ds.tls_depth_idx);
    if (cur > 0) {
        TlsSetValue(g_ds.tls_depth_idx, (LPVOID)0);
    }
    return cur;
}

void ds_restore_internal_depth(uintptr_t saved_depth)
{
    if (g_ds.tls_depth_idx == TLS_OUT_OF_INDEXES || saved_depth == 0) return;
    TlsSetValue(g_ds.tls_depth_idx, (LPVOID)saved_depth);
}

static const WCHAR *ds_basename_w(const WCHAR *path)
{
    if (!path) return L"";
    const WCHAR *base = path;
    for (const WCHAR *p = path; *p; p++) {
        if (*p == L'\\' || *p == L'/') {
            base = p + 1;
        }
    }
    return base;
}

#define DS_MOD_CACHE_SLOTS 32u
#define DS_MODF_VALID      (1u << 0)
#define DS_MODF_SELF       (1u << 1)
#define DS_MODF_WINED3D    (1u << 2)
#define DS_MODF_SYS_RENDER (1u << 3)
#define DS_MODF_PHYS_SURF  (1u << 4)

typedef struct {
    HMODULE  hmod;
    uint32_t flags;
} ds_mod_cache_entry_t;

static ds_mod_cache_entry_t s_mod_cache[DS_MOD_CACHE_SLOTS];

static void ds_invalidate_mod_cache(void)
{
    if (g_ds.lock_initialized) EnterCriticalSection(&g_ds.lock);
    memset(s_mod_cache, 0, sizeof(s_mod_cache));
    if (g_ds.lock_initialized) LeaveCriticalSection(&g_ds.lock);
}

static uint32_t ds_compute_mod_flags_by_base(const WCHAR *base)
{
    uint32_t flags = DS_MODF_VALID;
    if (!base || !base[0]) return flags;
    if (_wcsnicmp(base, L"one_display_scaler", 18) == 0) {
        return flags | DS_MODF_SELF | DS_MODF_SYS_RENDER | DS_MODF_PHYS_SURF;
    }
    if (_wcsicmp(base, L"wined3d.dll") == 0) {
        return flags | DS_MODF_WINED3D | DS_MODF_SYS_RENDER;
    }
    static const WCHAR *const k_sys_render_mods[] = {
        L"d3d8.dll",
        L"d3d9.dll",
        L"d3d10.dll",
        L"d3d10_1.dll",
        L"d3d10core.dll",
        L"d3d11.dll",
        L"d3d12.dll",
        L"d3d12core.dll",
        L"dxgi.dll",
        L"opengl32.dll",
        L"vulkan-1.dll",
        L"winevulkan.dll",
        L"d3dmetal.dll",
        L"winemetal.dll",
        L"winemac.drv",
        L"win32u.dll",
        L"user32.dll",
        L"gdi32.dll"
    };
    for (size_t i = 0; i < sizeof(k_sys_render_mods) / sizeof(k_sys_render_mods[0]); i++) {
        if (_wcsicmp(base, k_sys_render_mods[i]) == 0) {
            flags |= DS_MODF_SYS_RENDER;
            break;
        }
    }
    static const WCHAR *const k_phys_surface_mods[] = {
        L"dxgi.dll",
        L"d3d10.dll",
        L"d3d10_1.dll",
        L"d3d10core.dll",
        L"d3d11.dll",
        L"d3d12.dll",
        L"d3d12core.dll",
        L"opengl32.dll",
        L"vulkan-1.dll",
        L"winevulkan.dll",
        L"d3dmetal.dll",
        L"winemetal.dll",
        L"winemac.drv",
        L"win32u.dll",
        L"user32.dll",
        L"gdi32.dll",
        L"dinput.dll",
        L"dinput8.dll"
    };
    for (size_t i = 0; i < sizeof(k_phys_surface_mods) / sizeof(k_phys_surface_mods[0]); i++) {
        if (_wcsicmp(base, k_phys_surface_mods[i]) == 0) {
            flags |= DS_MODF_PHYS_SURF;
            break;
        }
    }
    return flags;
}

static bool ds_classify_caller_module(const void *ret_addr, uint32_t *out_flags)
{
    if (out_flags) *out_flags = 0;
    if (!ret_addr) return false;
    HMODULE hmod = NULL;
    if (!GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            (LPCWSTR)ret_addr,
            &hmod) || !hmod) {
        return false;
    }
    if (hmod == g_ds.self_hmod) {
        if (out_flags) *out_flags = DS_MODF_VALID | DS_MODF_SELF | DS_MODF_SYS_RENDER | DS_MODF_PHYS_SURF;
        return true;
    }

    size_t slot = (size_t)((((uintptr_t)hmod >> 16) ^ ((uintptr_t)hmod >> 4)) & (DS_MOD_CACHE_SLOTS - 1u));
    if (g_ds.lock_initialized) EnterCriticalSection(&g_ds.lock);
    if (s_mod_cache[slot].hmod == hmod && (s_mod_cache[slot].flags & DS_MODF_VALID) != 0) {
        uint32_t cached = s_mod_cache[slot].flags;
        if (g_ds.lock_initialized) LeaveCriticalSection(&g_ds.lock);
        if (out_flags) *out_flags = cached;
        return true;
    }
    if (g_ds.lock_initialized) LeaveCriticalSection(&g_ds.lock);

    WCHAR mod_path[MAX_PATH];
    mod_path[0] = L'\0';
    if (GetModuleFileNameW(hmod, mod_path, MAX_PATH - 1) == 0) {
        return false;
    }
    uint32_t computed = ds_compute_mod_flags_by_base(ds_basename_w(mod_path));
    if (g_ds.lock_initialized) EnterCriticalSection(&g_ds.lock);
    s_mod_cache[slot].hmod = hmod;
    s_mod_cache[slot].flags = computed;
    if (g_ds.lock_initialized) LeaveCriticalSection(&g_ds.lock);

    if (out_flags) *out_flags = computed;
    return true;
}

bool ds_is_wined3d_caller(const void *ret_addr)
{
    uint32_t flags = 0;
    if (!ds_classify_caller_module(ret_addr, &flags)) {
        return false;
    }
    return (flags & DS_MODF_WINED3D) != 0;
}

bool ds_is_system_renderer_caller(const void *ret_addr)
{
    uint32_t flags = 0;
    if (!ds_classify_caller_module(ret_addr, &flags)) {
        return false;
    }
    return (flags & (DS_MODF_SELF | DS_MODF_SYS_RENDER)) != 0;
}

bool ds_should_virtualize_rect_for_caller(const void *ret_addr)
{
    if (ds_is_passthrough_locked()) {
        return false;
    }
    uint32_t flags = 0;
    if (!ds_classify_caller_module(ret_addr, &flags)) {
        return true;
    }
    if ((flags & DS_MODF_SELF) != 0) {
        return false;
    }
    if ((flags & DS_MODF_WINED3D) != 0) {
        /*
         * When WineD3D uses its OpenGL renderer (all DirectDraw / D3D2-D3D9 games, or GL-mode
         * WineD3D), virtualizing window/monitor rects keeps WineD3D's front_buffer height equal
         * to dst_rect height so OpenGL Y-flipping never clips, while hook_wglSwapBuffers GPU-upscales
         * the finished GL_BACK frame to vp.dst_w x vp.dst_h. When WineD3D uses Vulkan for DXGI/D3D11,
         * expose physical window bounds so VkSwapchainKHR scales natively.
         */
        return (g_ds.wined3d_uses_gl || g_ds.legacy_d3d_loaded);
    }
    if ((flags & DS_MODF_PHYS_SURF) != 0) {
        return false;
    }
    return true;
}

static bool ds_should_skip_iat_patch_module(const WCHAR *base)
{
    if (!base || !base[0]) return true;
    static const WCHAR *const k_skip_mods[] = {
        L"ntdll.dll",
        L"kernel32.dll",
        L"kernelbase.dll",
        L"win32u.dll",
        L"user32.dll",
        L"gdi32.dll",
        L"opengl32.dll",
        L"ucrtbase.dll",
        L"msvcrt.dll",
        L"advapi32.dll",
        L"rpcrt4.dll",
        L"sechost.dll",
        L"winemac.drv",
        L"winevulkan.dll",
        L"vulkan-1.dll",
        L"d3dmetal.dll",
        L"winemetal.dll",
        L"one_display_scaler_x86.dll",
        L"one_display_scaler_x64.dll"
    };
    for (size_t i = 0; i < sizeof(k_skip_mods) / sizeof(k_skip_mods[0]); i++) {
        if (_wcsicmp(base, k_skip_mods[i]) == 0) {
            return true;
        }
    }
    return false;
}

static bool ds_is_passthrough_chaining_process(void)
{
    WCHAR exe_path[MAX_PATH] = { 0 };
    if (GetModuleFileNameW(NULL, exe_path, MAX_PATH - 1) == 0) {
        return false;
    }
    const WCHAR *base = ds_basename_w(exe_path);
    static const WCHAR *const k_chain_only_procs[] = {
        L"cmd.exe",
        L"powershell.exe",
        L"rundll32.exe",
        L"steam.exe",
        L"galaxyclient.exe",
        L"galaxyclienthelper.exe",
        L"galaxycommunication.exe",
        L"epicgameslauncher.exe",
        L"eadesktop.exe",
        L"upc.exe"
    };
    for (size_t i = 0; i < sizeof(k_chain_only_procs) / sizeof(k_chain_only_procs[0]); i++) {
        if (_wcsicmp(base, k_chain_only_procs[i]) == 0) {
            return true;
        }
    }
    return false;
}

static bool ds_should_ignore_current_process(void)
{
    WCHAR exe_path[MAX_PATH] = { 0 };
    if (GetModuleFileNameW(NULL, exe_path, MAX_PATH - 1) == 0) {
        return true;
    }
    const WCHAR *base = ds_basename_w(exe_path);
    static const WCHAR *const k_ignored_procs[] = {
        L"services.exe",
        L"plugplay.exe",
        L"rpcss.exe",
        L"winedevice.exe",
        L"explorer.exe",
        L"wineboot.exe",
        L"conhost.exe",
        L"svchost.exe",
        L"reg.exe",
        L"regedit.exe",
        L"regsvr32.exe",
        L"msiexec.exe",
        L"one_display_launcher_x86.exe",
        L"one_display_launcher_x64.exe",
        L"one_xgr_win_launcher.exe",
        L"one_xgr_win_launcher_x86.exe",
        L"steamwebhelper.exe",
        L"steamservice.exe",
        L"epicwebhelper.exe"
    };
    for (size_t i = 0; i < sizeof(k_ignored_procs) / sizeof(k_ignored_procs[0]); i++) {
        if (_wcsicmp(base, k_ignored_procs[i]) == 0) {
            return true;
        }
    }
    return false;
}

static bool ds_recompute_modern_passthrough_locked(void)
{
    bool want = (
        g_ds.modern_gfx_loaded &&
        !g_ds.wined3d_uses_gl &&
        !g_ds.game_gl_active &&
        !g_ds.legacy_d3d_loaded
    );
    bool prev = g_ds.modern_swapchain_passthrough;
    g_ds.modern_swapchain_passthrough = want;
    if (!prev && want &&
        g_ds.scaling_mode == DS_MODE_AUTO_FULLSCREEN &&
        !g_ds.user_forced_fullscreen) {
        bool had_virt = (g_ds.fullscreen_active || g_ds.mode_virtualized);
        g_ds.fullscreen_active = false;
        g_ds.mode_virtualized = false;
        g_ds.virt_w = g_ds.real_screen_w;
        g_ds.virt_h = g_ds.real_screen_h;
        g_ds.virt_bpp = g_ds.real_bpp;
        g_ds.virt_hz = g_ds.real_hz;
        ds_refresh_viewport_locked();
        return had_virt;
    }
    return false;
}

void ds_notify_gl_context_active_locked(void)
{
    (void)ds_recompute_modern_passthrough_locked();
}

void ds_refresh_viewport_locked(void)
{
    int32_t vw = g_ds.virt_w > 0 ? g_ds.virt_w : g_ds.real_screen_w;
    int32_t vh = g_ds.virt_h > 0 ? g_ds.virt_h : g_ds.real_screen_h;
    ds_compute_viewport(
        g_ds.real_screen_w,
        g_ds.real_screen_h,
        g_ds.safe_inset_top,
        vw,
        vh,
        g_ds.aspect_mode,
        &g_ds.vp
    );
}

int32_t ds_get_windowed_scale_locked(void)
{
    if (g_ds.fullscreen_active || g_ds.virt_w <= 0 || g_ds.virt_h <= 0) {
        return 1;
    }
    if (!g_ds.user_forced_windowed && !g_ds.mode_virtualized) {
        return 1;
    }
    if (g_ds.real_screen_w >= 2000 &&
        g_ds.virt_w * 2 <= g_ds.real_screen_w &&
        g_ds.virt_h * 2 <= g_ds.real_screen_h) {
        return 2;
    }
    return 1;
}

void ds_tracef(const char *fmt, ...)
{
    static volatile LONG s_trace_lines = 0;
    if (g_ds.trace_file[0] == L'\0' || !fmt) return;
    LONG n = InterlockedIncrement(&s_trace_lines);
    if (n > 50000) return;

    char line[512];
    int pfx = snprintf(line, sizeof(line), "[pid=%lu #%ld] ", (unsigned long)GetCurrentProcessId(), (long)n);
    if (pfx < 0 || pfx >= (int)sizeof(line) - 4) return;

    va_list ap;
    va_start(ap, fmt);
    int body = vsnprintf(line + pfx, sizeof(line) - (size_t)pfx - 2, fmt, ap);
    va_end(ap);
    if (body < 0) return;
    size_t total = (size_t)pfx + (size_t)body;
    if (total >= sizeof(line) - 2) total = sizeof(line) - 2;
    line[total++] = '\n';
    line[total] = '\0';

    ds_enter_internal();
    HANDLE hf = CreateFileW(
        g_ds.trace_file,
        FILE_APPEND_DATA,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );
    if (hf != INVALID_HANDLE_VALUE) {
        DWORD written = 0;
        WriteFile(hf, line, (DWORD)total, &written, NULL);
        CloseHandle(hf);
    }
    ds_leave_internal();
}

/* -------------------------------------------------------------------------
 * Display Mode Synthesis & Mode-Switch Virtualization
 * ------------------------------------------------------------------------- */

static void ds_fill_devmode_w(DEVMODEW *dm, int32_t w, int32_t h, int32_t bpp, int32_t hz)
{
    dm->dmPelsWidth = (DWORD)w;
    dm->dmPelsHeight = (DWORD)h;
    dm->dmBitsPerPel = (DWORD)(bpp > 0 ? bpp : 32);
    dm->dmDisplayFrequency = (DWORD)(hz > 0 ? hz : 60);
    dm->dmDisplayFlags = 0;
    dm->dmFields |= DM_BITSPERPEL | DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY | DM_DISPLAYFLAGS;
}

static void ds_fill_devmode_a(DEVMODEA *dm, int32_t w, int32_t h, int32_t bpp, int32_t hz)
{
    dm->dmPelsWidth = (DWORD)w;
    dm->dmPelsHeight = (DWORD)h;
    dm->dmBitsPerPel = (DWORD)(bpp > 0 ? bpp : 32);
    dm->dmDisplayFrequency = (DWORD)(hz > 0 ? hz : 60);
    dm->dmDisplayFlags = 0;
    dm->dmFields |= DM_BITSPERPEL | DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY | DM_DISPLAYFLAGS;
}

static BOOL WINAPI hook_EnumDisplaySettingsExW(LPCWSTR lpszDeviceName, DWORD iModeNum, DEVMODEW *lpDevMode, DWORD dwFlags)
{
    if (!lpDevMode) return FALSE;
    if (!ds_is_internal_call()) {
        ds_ensure_runtime_started();
    }
    if (ds_is_internal_call() || ds_is_passthrough_locked()) {
        return g_ds.real_EnumDisplaySettingsExW ? g_ds.real_EnumDisplaySettingsExW(lpszDeviceName, iModeNum, lpDevMode, dwFlags) : FALSE;
    }

    if (iModeNum == ENUM_CURRENT_SETTINGS || iModeNum == ENUM_REGISTRY_SETTINGS) {
        BOOL ok = g_ds.real_EnumDisplaySettingsExW
            ? g_ds.real_EnumDisplaySettingsExW(lpszDeviceName, ENUM_CURRENT_SETTINGS, lpDevMode, dwFlags)
            : FALSE;
        if (!ok) {
            WORD sz = lpDevMode->dmSize ? lpDevMode->dmSize : (WORD)sizeof(DEVMODEW);
            memset(lpDevMode, 0, sz);
            lpDevMode->dmSize = sz;
        }
        EnterCriticalSection(&g_ds.lock);
        int32_t bpp = ds_prefer_16bpp_ddraw()
            ? 16
            : ((iModeNum == ENUM_CURRENT_SETTINGS && g_ds.mode_virtualized && g_ds.virt_bpp > 0) ? g_ds.virt_bpp : g_ds.real_bpp);
        if (iModeNum == ENUM_CURRENT_SETTINGS && g_ds.mode_virtualized && g_ds.virt_w > 0 && g_ds.virt_h > 0) {
            ds_fill_devmode_w(lpDevMode, g_ds.virt_w, g_ds.virt_h, bpp, g_ds.virt_hz);
        } else {
            ds_fill_devmode_w(lpDevMode, g_ds.real_screen_w, g_ds.real_screen_h, bpp, g_ds.real_hz);
        }
        LeaveCriticalSection(&g_ds.lock);
        return TRUE;
    }

    EnterCriticalSection(&g_ds.lock);
    size_t count = g_ds.mode_count;
    ds_display_mode_t m = { 0, 0, 32, 60 };
    bool valid = ((size_t)iModeNum < count);
    if (valid) {
        m = g_ds.modes[iModeNum];
    }
    LeaveCriticalSection(&g_ds.lock);

    if (!valid) {
        return FALSE;
    }

    WORD sz = lpDevMode->dmSize ? lpDevMode->dmSize : (WORD)sizeof(DEVMODEW);
    if (sz > sizeof(DEVMODEW)) sz = (WORD)sizeof(DEVMODEW);
    memset(lpDevMode, 0, sz);
    lpDevMode->dmSize = sz;
    wcsncpy((WCHAR *)lpDevMode->dmDeviceName, L"\\\\.\\DISPLAY1", CCHDEVICENAME - 1);
    ds_fill_devmode_w(lpDevMode, m.width, m.height, m.bpp, m.refresh_hz);
    return TRUE;
}

static BOOL WINAPI hook_EnumDisplaySettingsW(LPCWSTR lpszDeviceName, DWORD iModeNum, DEVMODEW *lpDevMode)
{
    return hook_EnumDisplaySettingsExW(lpszDeviceName, iModeNum, lpDevMode, 0);
}

static BOOL WINAPI hook_EnumDisplaySettingsExA(LPCSTR lpszDeviceName, DWORD iModeNum, DEVMODEA *lpDevMode, DWORD dwFlags)
{
    if (!lpDevMode) return FALSE;
    if (!ds_is_internal_call()) {
        ds_ensure_runtime_started();
    }
    if (ds_is_internal_call() || ds_is_passthrough_locked()) {
        return g_ds.real_EnumDisplaySettingsExA ? g_ds.real_EnumDisplaySettingsExA(lpszDeviceName, iModeNum, lpDevMode, dwFlags) : FALSE;
    }

    DEVMODEW dmw;
    memset(&dmw, 0, sizeof(dmw));
    dmw.dmSize = sizeof(dmw);
    if (!hook_EnumDisplaySettingsExW(NULL, iModeNum, &dmw, dwFlags)) {
        return FALSE;
    }

    WORD sz = lpDevMode->dmSize ? lpDevMode->dmSize : (WORD)sizeof(DEVMODEA);
    if (sz > sizeof(DEVMODEA)) sz = (WORD)sizeof(DEVMODEA);
    memset(lpDevMode, 0, sz);
    lpDevMode->dmSize = sz;
    strncpy((char *)lpDevMode->dmDeviceName, "\\\\.\\DISPLAY1", CCHDEVICENAME - 1);
    ds_fill_devmode_a(lpDevMode, (int32_t)dmw.dmPelsWidth, (int32_t)dmw.dmPelsHeight, (int32_t)dmw.dmBitsPerPel, (int32_t)dmw.dmDisplayFrequency);
    return TRUE;
}

static BOOL WINAPI hook_EnumDisplaySettingsA(LPCSTR lpszDeviceName, DWORD iModeNum, DEVMODEA *lpDevMode)
{
    return hook_EnumDisplaySettingsExA(lpszDeviceName, iModeNum, lpDevMode, 0);
}

static bool ds_process_owns_foreground_window(void)
{
    HWND fg = GetForegroundWindow();
    if (!fg) return false;
    DWORD fg_pid = 0;
    GetWindowThreadProcessId(fg, &fg_pid);
    return fg_pid == GetCurrentProcessId();
}

static LONG ds_handle_change_display_mode(bool is_reset, int32_t req_w, int32_t req_h, int32_t req_bpp, int32_t req_hz, DWORD dwFlags, const void *caller_ret)
{
    ds_tracef("ChangeDisplaySettings is_reset=%d req=%dx%d@%dbpp flags=0x%lx hwnd=%p",
              is_reset ? 1 : 0, (int)req_w, (int)req_h, (int)req_bpp, (unsigned long)dwFlags, (void *)g_ds.hwnd_game);
    if (is_reset) {
        EnterCriticalSection(&g_ds.lock);
        bool ignore_focus_loss_reset = (
            ds_is_wined3d_caller(caller_ret) &&
            g_ds.fullscreen_active &&
            (g_ds.app_inactive || (g_ds.cocoa_fs_synced && !ds_process_owns_foreground_window()))
        );
        if (ignore_focus_loss_reset) {
            g_ds.app_inactive = true;
            ds_cursor_warp_reset(&g_ds.warp);
            int32_t keep_vw = g_ds.virt_w;
            int32_t keep_vh = g_ds.virt_h;
            LeaveCriticalSection(&g_ds.lock);
            ds_tracef("ChangeDisplaySettings reset ignored during focus-loss (preserving virt=%dx%d)",
                      (int)keep_vw, (int)keep_vh);
            return DISP_CHANGE_SUCCESSFUL;
        }
        g_ds.mode_virtualized = false;
        bool keep_window_fs = (
            g_ds.hwnd_game != NULL &&
            IsWindow(g_ds.hwnd_game) &&
            !g_ds.user_forced_windowed &&
            !ds_is_passthrough_locked()
        );
        g_ds.virt_w = g_ds.real_screen_w;
        g_ds.virt_h = g_ds.real_screen_h;
        g_ds.virt_bpp = g_ds.real_bpp;
        g_ds.virt_hz = g_ds.real_hz;
        if (keep_window_fs) {
            g_ds.fullscreen_active = true;
        } else {
            g_ds.fullscreen_active = (g_ds.scaling_mode == DS_MODE_FORCE_FULLSCREEN && !g_ds.user_forced_windowed);
        }
        ds_refresh_viewport_locked();
        ds_cursor_warp_reset(&g_ds.warp);
        LeaveCriticalSection(&g_ds.lock);
        ds_request_apply_presentation();
        ds_gl_notify_display_mode_switch();
        ds_write_status_file();
        return DISP_CHANGE_SUCCESSFUL;
    }

    if (req_w <= 0 || req_h <= 0) {
        return DISP_CHANGE_SUCCESSFUL;
    }
    if (req_w < 240 || req_h < 180 || req_w > 7680 || req_h > 4320) {
        return DISP_CHANGE_BADMODE;
    }
    if ((dwFlags & CDS_TEST) != 0) {
        return DISP_CHANGE_SUCCESSFUL;
    }

    HWND target_hwnd = NULL;
    bool mode_actually_changed = false;
    int32_t eff_bpp = 32;

    EnterCriticalSection(&g_ds.lock);
    eff_bpp = req_bpp > 0 ? req_bpp : (g_ds.virt_bpp > 0 ? g_ds.virt_bpp : g_ds.real_bpp);
    if (ds_prefer_16bpp_ddraw() && eff_bpp > 16 && req_w <= 640 && req_h <= 480) {
        eff_bpp = 16;
    }
    mode_actually_changed = (
        !g_ds.mode_virtualized ||
        g_ds.virt_w != req_w ||
        g_ds.virt_h != req_h ||
        g_ds.virt_bpp != eff_bpp
    );
    g_ds.mode_virtualized = true;
    g_ds.virt_w = req_w;
    g_ds.virt_h = req_h;
    g_ds.virt_bpp = eff_bpp;
    g_ds.virt_hz = req_hz > 0 ? req_hz : g_ds.real_hz;
    if (!g_ds.user_forced_windowed) {
        g_ds.fullscreen_active = true;
    }
    ds_refresh_viewport_locked();
    ds_cursor_warp_reset(&g_ds.warp);
    target_hwnd = g_ds.hwnd_game;
    LeaveCriticalSection(&g_ds.lock);

    if (target_hwnd && IsWindow(target_hwnd)) {
        ds_request_apply_presentation();
        if (mode_actually_changed) {
            ds_gl_notify_display_mode_switch();
            RedrawWindow(target_hwnd, NULL, NULL, RDW_INVALIDATE);
        }
        (void)eff_bpp;
    }
    ds_write_status_file();
    return DISP_CHANGE_SUCCESSFUL;
}

static LONG ds_change_display_settings_w_impl(LPCWSTR lpszDeviceName, DEVMODEW *lpDevMode, HWND hwnd, DWORD dwFlags, LPVOID lParam, const void *caller_ret)
{
    if (!ds_is_internal_call()) {
        ds_ensure_runtime_started();
    }
    if (ds_is_internal_call() || ds_is_passthrough_locked()) {
        return g_ds.real_ChangeDisplaySettingsExW
            ? g_ds.real_ChangeDisplaySettingsExW(lpszDeviceName, lpDevMode, hwnd, dwFlags, lParam)
            : DISP_CHANGE_SUCCESSFUL;
    }
    if (!lpDevMode) {
        return ds_handle_change_display_mode(true, 0, 0, 0, 0, dwFlags, caller_ret);
    }
    int32_t w = (lpDevMode->dmFields & DM_PELSWIDTH) ? (int32_t)lpDevMode->dmPelsWidth : g_ds.real_screen_w;
    int32_t h = (lpDevMode->dmFields & DM_PELSHEIGHT) ? (int32_t)lpDevMode->dmPelsHeight : g_ds.real_screen_h;
    int32_t bpp = (lpDevMode->dmFields & DM_BITSPERPEL) ? (int32_t)lpDevMode->dmBitsPerPel : 0;
    int32_t hz = (lpDevMode->dmFields & DM_DISPLAYFREQUENCY) ? (int32_t)lpDevMode->dmDisplayFrequency : g_ds.real_hz;
    if (ds_prefer_16bpp_ddraw() && (bpp > 16 || bpp == 0) && w <= 640 && h <= 480) {
        bpp = 16;
        lpDevMode->dmBitsPerPel = 16;
        lpDevMode->dmFields |= DM_BITSPERPEL;
    }
    return ds_handle_change_display_mode(false, w, h, bpp, hz, dwFlags, caller_ret);
}

static LONG WINAPI hook_ChangeDisplaySettingsExW(LPCWSTR lpszDeviceName, DEVMODEW *lpDevMode, HWND hwnd, DWORD dwFlags, LPVOID lParam)
{
    return ds_change_display_settings_w_impl(lpszDeviceName, lpDevMode, hwnd, dwFlags, lParam, __builtin_return_address(0));
}

static LONG WINAPI hook_ChangeDisplaySettingsW(DEVMODEW *lpDevMode, DWORD dwFlags)
{
    return ds_change_display_settings_w_impl(NULL, lpDevMode, NULL, dwFlags, NULL, __builtin_return_address(0));
}

static LONG ds_change_display_settings_a_impl(LPCSTR lpszDeviceName, DEVMODEA *lpDevMode, HWND hwnd, DWORD dwFlags, LPVOID lParam, const void *caller_ret)
{
    if (!ds_is_internal_call()) {
        ds_ensure_runtime_started();
    }
    if (ds_is_internal_call() || ds_is_passthrough_locked()) {
        return g_ds.real_ChangeDisplaySettingsExA
            ? g_ds.real_ChangeDisplaySettingsExA(lpszDeviceName, lpDevMode, hwnd, dwFlags, lParam)
            : DISP_CHANGE_SUCCESSFUL;
    }
    if (!lpDevMode) {
        return ds_handle_change_display_mode(true, 0, 0, 0, 0, dwFlags, caller_ret);
    }
    int32_t w = (lpDevMode->dmFields & DM_PELSWIDTH) ? (int32_t)lpDevMode->dmPelsWidth : g_ds.real_screen_w;
    int32_t h = (lpDevMode->dmFields & DM_PELSHEIGHT) ? (int32_t)lpDevMode->dmPelsHeight : g_ds.real_screen_h;
    int32_t bpp = (lpDevMode->dmFields & DM_BITSPERPEL) ? (int32_t)lpDevMode->dmBitsPerPel : 0;
    int32_t hz = (lpDevMode->dmFields & DM_DISPLAYFREQUENCY) ? (int32_t)lpDevMode->dmDisplayFrequency : g_ds.real_hz;
    if (ds_prefer_16bpp_ddraw() && (bpp > 16 || bpp == 0) && w <= 640 && h <= 480) {
        bpp = 16;
        lpDevMode->dmBitsPerPel = 16;
        lpDevMode->dmFields |= DM_BITSPERPEL;
    }
    return ds_handle_change_display_mode(false, w, h, bpp, hz, dwFlags, caller_ret);
}

static LONG WINAPI hook_ChangeDisplaySettingsExA(LPCSTR lpszDeviceName, DEVMODEA *lpDevMode, HWND hwnd, DWORD dwFlags, LPVOID lParam)
{
    return ds_change_display_settings_a_impl(lpszDeviceName, lpDevMode, hwnd, dwFlags, lParam, __builtin_return_address(0));
}

static LONG WINAPI hook_ChangeDisplaySettingsA(DEVMODEA *lpDevMode, DWORD dwFlags)
{
    return ds_change_display_settings_a_impl(NULL, lpDevMode, NULL, dwFlags, NULL, __builtin_return_address(0));
}

static int WINAPI hook_GetSystemMetrics(int nIndex)
{
    if (!ds_is_internal_call()) {
        ds_ensure_runtime_started();
    }
    if (!ds_is_internal_call() && ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        EnterCriticalSection(&g_ds.lock);
        bool virt = g_ds.fullscreen_active && g_ds.virt_w > 0 && g_ds.virt_h > 0;
        int32_t vw = g_ds.virt_w;
        int32_t vh = g_ds.virt_h;
        LeaveCriticalSection(&g_ds.lock);

        if (virt) {
            if (nIndex == SM_CXSCREEN || nIndex == SM_CXFULLSCREEN || nIndex == SM_CXVIRTUALSCREEN) {
                return vw;
            }
            if (nIndex == SM_CYSCREEN || nIndex == SM_CYFULLSCREEN || nIndex == SM_CYVIRTUALSCREEN) {
                return vh;
            }
            if (nIndex == SM_XVIRTUALSCREEN || nIndex == SM_YVIRTUALSCREEN) {
                return 0;
            }
        }
    }
    return g_ds.real_GetSystemMetrics ? g_ds.real_GetSystemMetrics(nIndex) : 0;
}

/* -------------------------------------------------------------------------
 * Window Geometry & Zero-Drift Cursor Hooks
 * ------------------------------------------------------------------------- */

static HWND WINAPI hook_CreateWindowExW(DWORD dwExStyle, LPCWSTR lpClassName, LPCWSTR lpWindowName, DWORD dwStyle, int X, int Y, int nWidth, int nHeight, HWND hWndParent, HMENU hMenu, HINSTANCE hInstance, LPVOID lpParam)
{
    if (!ds_is_internal_call()) {
        ds_ensure_runtime_started();
    }
    HWND hwnd = g_ds.real_CreateWindowExW
        ? g_ds.real_CreateWindowExW(dwExStyle, lpClassName, lpWindowName, dwStyle, X, Y, nWidth, nHeight, hWndParent, hMenu, hInstance, lpParam)
        : NULL;
    if (hwnd && !ds_is_internal_call() && !ds_is_passthrough_locked() && hWndParent == NULL && (dwStyle & WS_CHILD) == 0) {
        ds_attach_and_apply_game_window(hwnd, nWidth > 0 ? nWidth : 0, nHeight > 0 ? nHeight : 0);
    }
    return hwnd;
}

static HWND WINAPI hook_CreateWindowExA(DWORD dwExStyle, LPCSTR lpClassName, LPCSTR lpWindowName, DWORD dwStyle, int X, int Y, int nWidth, int nHeight, HWND hWndParent, HMENU hMenu, HINSTANCE hInstance, LPVOID lpParam)
{
    if (!ds_is_internal_call()) {
        ds_ensure_runtime_started();
    }
    HWND hwnd = g_ds.real_CreateWindowExA
        ? g_ds.real_CreateWindowExA(dwExStyle, lpClassName, lpWindowName, dwStyle, X, Y, nWidth, nHeight, hWndParent, hMenu, hInstance, lpParam)
        : NULL;
    if (hwnd && !ds_is_internal_call() && !ds_is_passthrough_locked() && hWndParent == NULL && (dwStyle & WS_CHILD) == 0) {
        ds_attach_and_apply_game_window(hwnd, nWidth > 0 ? nWidth : 0, nHeight > 0 ? nHeight : 0);
    }
    return hwnd;
}

static BOOL ds_handle_show_window_hook(HWND hWnd, int nCmdShow, bool is_async)
{
    if (!ds_is_internal_call()) {
        ds_ensure_runtime_started();
    }
    pfn_ShowWindow_t fn = is_async ? (pfn_ShowWindow_t)g_ds.real_ShowWindowAsync : g_ds.real_ShowWindow;
    if (!fn) return FALSE;
    if (ds_is_internal_call() || !hWnd || ds_is_passthrough_locked()) {
        return fn(hWnd, nCmdShow);
    }

    bool is_hide = (nCmdShow == SW_HIDE);
    bool is_minimize = (
        nCmdShow == SW_MINIMIZE ||
        nCmdShow == SW_SHOWMINIMIZED ||
        nCmdShow == SW_SHOWMINNOACTIVE ||
        nCmdShow == SW_FORCEMINIMIZE
    );
    if (g_ds.hwnd_game == NULL && !is_hide && !is_minimize) {
        ds_attach_and_apply_game_window(hWnd, 0, 0);
    }

    EnterCriticalSection(&g_ds.lock);
    bool is_game_fs = (
        hWnd == g_ds.hwnd_game &&
        g_ds.fullscreen_active &&
        g_ds.vp.dst_w > 0 &&
        g_ds.vp.dst_h > 0
    );
    LeaveCriticalSection(&g_ds.lock);

    if (is_game_fs && is_minimize) {
        /*
         * In CrossOver/winemac.drv, NtUserShowWindow(SW_MINIMIZE) on a borderless WS_POPUP
         * window invokes -[NSWindow orderOut:nil] because borderless windows cannot miniaturize
         * to the Dock, detaching the Cocoa CGLSurface from OneLauncherGLHostChild.
         * Convert fullscreen auto-minimize on focus loss into cooperative HWND_NOTOPMOST demotion.
         */
        ds_demote_fullscreen_on_deactivate(hWnd);
        return TRUE;
    }

    if (is_game_fs && !is_hide && !is_minimize) {
        bool was_inactive = false;
        EnterCriticalSection(&g_ds.lock);
        if (g_ds.app_inactive &&
            (nCmdShow == SW_RESTORE ||
             (nCmdShow != SW_SHOWNA && nCmdShow != SW_SHOWNOACTIVATE && ds_process_owns_foreground_window()))) {
            g_ds.app_inactive = false;
        }
        was_inactive = g_ds.app_inactive;
        LeaveCriticalSection(&g_ds.lock);

        if (was_inactive) {
            ds_enter_internal();
            BOOL res_na = fn(hWnd, SW_SHOWNA);
            ds_leave_internal();
            return res_na;
        }

        /*
         * Classic Win32/DirectDraw titles call ShowWindow(hWnd, SW_MAXIMIZE)
         * when entering fullscreen 3D. In Wine/winemac.drv, NtUserShowWindow(SW_MAXIMIZE)
         * bypasses user32!SetWindowPos and maximizes the Cocoa NSWindow to full monitor bounds.
         * Clamp to SW_SHOW / SW_RESTORE / SW_SHOWNA and enforce our fullscreen viewport immediately.
         */
        int safe_cmd = (nCmdShow == SW_SHOWNA || nCmdShow == SW_SHOWNOACTIVATE)
            ? nCmdShow
            : (IsIconic(hWnd) ? SW_RESTORE : SW_SHOW);
        ds_enter_internal();
        BOOL res = fn(hWnd, safe_cmd);
        ds_leave_internal();
        ds_request_apply_presentation();
        if (GetCurrentThreadId() == g_ds.game_thread_id) {
            ds_refresh_gl_host_drawable_on_owner_thread(hWnd);
        } else {
            InterlockedExchange(&g_ds.gl_drawable_rebind_pending, 1);
        }
        return res;
    }

    if (!is_hide && !is_minimize && hWnd) {
        EnterCriticalSection(&g_ds.lock);
        bool fs_dialog_raise = (
            hWnd != g_ds.hwnd_game &&
            g_ds.fullscreen_active &&
            !g_ds.app_inactive &&
            g_ds.real_SetWindowPos != NULL
        );
        LeaveCriticalSection(&g_ds.lock);

        if (fs_dialog_raise) {
            DWORD wnd_pid = 0;
            GetWindowThreadProcessId(hWnd, &wnd_pid);
            if (wnd_pid == GetCurrentProcessId()) {
                WCHAR cls[16] = { 0 };
                if (GetClassNameW(hWnd, cls, 15) > 0 && wcscmp(cls, L"#32770") == 0) {
                    BOOL dlg_res = fn(hWnd, nCmdShow);
                    if (g_ds.real_ClipCursor) {
                        g_ds.real_ClipCursor(NULL);
                    }
                    ds_enter_internal();
                    g_ds.real_SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                    ds_leave_internal();
                    return dlg_res;
                }
            }
        }
    }

    return fn(hWnd, nCmdShow);
}

static BOOL WINAPI hook_ShowWindow(HWND hWnd, int nCmdShow)
{
    return ds_handle_show_window_hook(hWnd, nCmdShow, false);
}

static BOOL WINAPI hook_ShowWindowAsync(HWND hWnd, int nCmdShow)
{
    return ds_handle_show_window_hook(hWnd, nCmdShow, true);
}

static BOOL WINAPI hook_SetWindowPlacement(HWND hWnd, const WINDOWPLACEMENT *lpwndpl)
{
    if (!g_ds.real_SetWindowPlacement) return FALSE;
    if (ds_is_internal_call() || !hWnd || !lpwndpl) {
        return g_ds.real_SetWindowPlacement(hWnd, lpwndpl);
    }

    EnterCriticalSection(&g_ds.lock);
    bool is_game_fs = (
        hWnd == g_ds.hwnd_game &&
        g_ds.fullscreen_active &&
        g_ds.vp.dst_w > 0 &&
        g_ds.vp.dst_h > 0
    );
    LeaveCriticalSection(&g_ds.lock);

    bool is_minimize_cmd = (
        lpwndpl->showCmd == SW_MINIMIZE ||
        lpwndpl->showCmd == SW_SHOWMINIMIZED ||
        lpwndpl->showCmd == SW_SHOWMINNOACTIVE ||
        lpwndpl->showCmd == SW_FORCEMINIMIZE
    );
    if (is_game_fs && is_minimize_cmd) {
        ds_demote_fullscreen_on_deactivate(hWnd);
        return TRUE;
    }

    if (is_game_fs && lpwndpl->showCmd != SW_HIDE && !is_minimize_cmd) {
        WINDOWPLACEMENT patched = *lpwndpl;
        patched.showCmd = SW_SHOWNORMAL;
        patched.rcNormalPosition.left = 0;
        patched.rcNormalPosition.top = 0;
        patched.rcNormalPosition.right = g_ds.real_screen_w;
        patched.rcNormalPosition.bottom = g_ds.real_screen_h;
        ds_enter_internal();
        BOOL res = g_ds.real_SetWindowPlacement(hWnd, &patched);
        ds_leave_internal();
        ds_request_apply_presentation();
        return res;
    }

    return g_ds.real_SetWindowPlacement(hWnd, lpwndpl);
}

/*
 * Promotes an adopted game window into fullscreen virtualization immediately when a graphics
 * runtime (`wined3d`, `ddraw`, `d3d8`, `d3d9`, `dxgi`) or the game itself resizes `hwnd_game`
 * to a sub-panel fullscreen mode BEFORE calling `ChangeDisplaySettings*`.
 *
 * Without immediate promotion, `SetWindowPos(hwnd_game, HWND_TOPMOST, 0, 0, 1280, 1024, ...)`
 * on an initially screen-sized window shrinks `wineserver`'s server-side `win->rects.visible`
 * to `(0,0)-(1280,1024)`. When `ChangeDisplaySettings` subsequently expands the window back to
 * `(0,0)-(real_screen_w, real_screen_h)`, Cocoa suppresses `windowDidResize:` because the
 * `NSWindow` frame never changed, leaving `wineserver` hit-testing (`window_from_point` inside
 * `NtUserPeekMessage`) permanently clamped to the top-left `1280x1024` sub-rectangle.
 */
static bool ds_try_promote_fullscreen_resize_locked(
    HWND hWnd,
    HWND hWndInsertAfter,
    int X,
    int Y,
    int cx,
    int cy,
    UINT uFlags,
    bool sys_caller)
{
    if (hWnd != g_ds.hwnd_game || g_ds.fullscreen_active || g_ds.user_forced_windowed ||
        ds_is_passthrough_locked()) {
        return false;
    }
    if ((uFlags & (SWP_NOSIZE | SWP_HIDEWINDOW)) != 0 || cx < 240 || cy < 180 ||
        g_ds.real_screen_w <= 0 || g_ds.real_screen_h <= 0 ||
        (cx >= g_ds.real_screen_w && cy >= g_ds.real_screen_h)) {
        return false;
    }

    DWORD cur_style = (DWORD)ds_get_wnd_long_ptr(hWnd, GWL_STYLE);
    bool is_borderless_popup = (cur_style & WS_POPUP) != 0 &&
                               (cur_style & (WS_CAPTION | WS_THICKFRAME)) == 0;
    bool want_promote = false;
    if (sys_caller && (hWndInsertAfter == HWND_TOPMOST || is_borderless_popup)) {
        want_promote = true;
    } else if (!sys_caller && is_borderless_popup && ((uFlags & SWP_NOMOVE) != 0 || (X == 0 && Y == 0))) {
        want_promote = true;
    } else if (g_ds.scaling_mode == DS_MODE_FORCE_FULLSCREEN) {
        want_promote = true;
    } else if (g_ds.scaling_mode == DS_MODE_AUTO_FULLSCREEN && !sys_caller &&
               (cur_style & WS_THICKFRAME) == 0 &&
               cx <= 1440 && cy <= (g_ds.real_screen_h * 85) / 100) {
        want_promote = true;
    }
    if (!want_promote) {
        return false;
    }

    g_ds.fullscreen_active = true;
    g_ds.visible_resync_needed = false;
    g_ds.visible_resync_done = false;
    if (IsWindowVisible(hWnd) != FALSE) {
        g_ds.cocoa_fs_synced = true;
        g_ds.first_visible_tick = 0;
    } else if (g_ds.real_screen_w >= 800 && g_ds.real_screen_h >= 600) {
        DWORD now_t = GetTickCount();
        g_ds.first_visible_tick = now_t ? now_t : 1;
        g_ds.cocoa_fs_synced = false;
    }
    if (!g_ds.mode_virtualized || g_ds.virt_w <= 0 || g_ds.virt_h <= 0 ||
        (g_ds.virt_w >= g_ds.real_screen_w && g_ds.virt_h >= g_ds.real_screen_h)) {
        g_ds.virt_w = cx;
        g_ds.virt_h = cy;
    }
    ds_refresh_viewport_locked();
    return true;
}

/*
 * Clears Wine's per-HWND swapchain present rect (`win->present_rect` in `win32u.so`, set via
 * `NtGdiDdDDIEscape` command `0x80000001`). When `wined3d` creates or resizes a fullscreen
 * swapchain (`wined3d_swapchain_state_set_fullscreen` / `resize_target`), it sets this rect to
 * the virtual mode (e.g. `0,0..1280,1024`), causing `win32u` (`get_d3d_present_rect`) to clamp
 * `rects->visible` and `wineserver` mouse hit-testing (`window_from_point`) to the top-left
 * virtual sub-rectangle even when `hwnd` covers the full HiDPI monitor. Resetting it to
 * `{0,0,0,0}` restores full-window hit-testing and GDI surface coverage.
 */
void ds_clear_wine_present_rect_on_hwnd(HWND hwnd)
{
    pfn_D3DKMTEscape_t fn = g_ds.real_D3DKMTEscape
        ? g_ds.real_D3DKMTEscape
        : g_ds.real_NtGdiDdDDIEscape;
    if (!g_ds.is_wine || !fn || !hwnd || hwnd == GetDesktopWindow() || !IsWindow(hwnd)) {
        return;
    }
    DWORD wnd_pid = 0;
    if (GetWindowThreadProcessId(hwnd, &wnd_pid) == 0 || wnd_pid != GetCurrentProcessId()) {
        return;
    }
    RECT empty_rc = { 0, 0, 0, 0 };
    ds_d3dkmt_escape_t esc;
    memset(&esc, 0, sizeof(esc));
    esc.Type = DS_WINE_D3DKMT_ESCAPE_SET_PRESENT_RECT;
    esc.pPrivateDriverData = &empty_rc;
    esc.PrivateDriverDataSize = (UINT)sizeof(empty_rc);
    esc.hContext = (UINT)(uintptr_t)hwnd;
    ds_enter_internal();
    (void)fn(&esc);
    ds_leave_internal();
}

static LONG WINAPI hook_D3DKMTEscape(const ds_d3dkmt_escape_t *desc)
{
    pfn_D3DKMTEscape_t real_fn = g_ds.real_D3DKMTEscape
        ? g_ds.real_D3DKMTEscape
        : g_ds.real_NtGdiDdDDIEscape;
    if (!real_fn) {
        return (LONG)0xC0000002L;
    }
    if (!g_ds.is_wine || ds_is_internal_call() || ds_is_passthrough_locked() || !desc ||
        desc->Type != DS_WINE_D3DKMT_ESCAPE_SET_PRESENT_RECT ||
        desc->PrivateDriverDataSize != (UINT)sizeof(RECT) ||
        desc->pPrivateDriverData == NULL) {
        return real_fn(desc);
    }

    HWND target_hwnd = (HWND)(uintptr_t)desc->hContext;
    const RECT *src_rc = (const RECT *)desc->pPrivateDriverData;
    int32_t rc_w = src_rc->right - src_rc->left;
    int32_t rc_h = src_rc->bottom - src_rc->top;

    if (target_hwnd != NULL && target_hwnd != GetDesktopWindow() && rc_w > 0 && rc_h > 0) {
        if (g_ds.hwnd_game == NULL) {
            ds_attach_and_apply_game_window(target_hwnd, rc_w, rc_h);
        }
        EnterCriticalSection(&g_ds.lock);
        int32_t win_scale = ds_get_windowed_scale_locked();
        bool suppress_clamp = (
            target_hwnd == g_ds.hwnd_game &&
            !ds_is_passthrough_locked() &&
            (g_ds.fullscreen_active ||
             win_scale > 1 ||
             (!g_ds.user_forced_windowed &&
              (g_ds.mode_virtualized ||
               (g_ds.real_screen_w > 0 && g_ds.real_screen_h > 0 &&
                (rc_w < g_ds.real_screen_w || rc_h < g_ds.real_screen_h)))))
        );
        if (suppress_clamp &&
            (!g_ds.mode_virtualized || g_ds.virt_w <= 0 || g_ds.virt_h <= 0 ||
             (g_ds.virt_w >= g_ds.real_screen_w && g_ds.virt_h >= g_ds.real_screen_h))) {
            g_ds.virt_w = rc_w;
            g_ds.virt_h = rc_h;
            ds_refresh_viewport_locked();
        }
        LeaveCriticalSection(&g_ds.lock);

        if (suppress_clamp) {
            RECT empty_rc = { 0, 0, 0, 0 };
            ds_d3dkmt_escape_t patched = *desc;
            patched.pPrivateDriverData = &empty_rc;
            patched.PrivateDriverDataSize = (UINT)sizeof(empty_rc);
            return real_fn(&patched);
        }
    }

    return real_fn(desc);
}

static void ds_compute_centered_windowed_bounds(HWND hWnd, int32_t client_w, int32_t client_h, int *out_x, int *out_y, int *out_w, int *out_h)
{
    DWORD cur_style = (DWORD)ds_get_wnd_long_ptr(hWnd, GWL_STYLE);
    DWORD cur_exstyle = (DWORD)ds_get_wnd_long_ptr(hWnd, GWL_EXSTYLE);
    RECT wrc = { 0, 0, client_w, client_h };
    if (g_ds.real_AdjustWindowRectEx) {
        g_ds.real_AdjustWindowRectEx(&wrc, cur_style, FALSE, cur_exstyle);
    }
    int ww = wrc.right - wrc.left;
    int wh = wrc.bottom - wrc.top;
    int wx = (g_ds.real_screen_w - ww) / 2;
    int wy = (g_ds.real_screen_h - wh) / 2;
    *out_x = wx < 0 ? 0 : wx;
    *out_y = wy < 0 ? 0 : wy;
    *out_w = ww;
    *out_h = wh;
}

static bool ds_is_hwnd_already_full_panel_internal(HWND hWnd)
{
    RECT cur_rc = { 0, 0, 0, 0 };
    return IsWindowVisible(hWnd) &&
           g_ds.real_GetWindowRect && g_ds.real_GetWindowRect(hWnd, &cur_rc) &&
           cur_rc.left == 0 && cur_rc.top == 0 &&
           (cur_rc.right - cur_rc.left) == g_ds.real_screen_w &&
           (cur_rc.bottom - cur_rc.top) == g_ds.real_screen_h;
}

static BOOL WINAPI hook_SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, UINT uFlags)
{
    if (!ds_is_internal_call()) {
        ds_ensure_runtime_started();
    }
    if (!g_ds.real_SetWindowPos) return FALSE;
    if (ds_is_internal_call() || !hWnd || ds_is_passthrough_locked()) {
        return g_ds.real_SetWindowPos(hWnd, hWndInsertAfter, X, Y, cx, cy, uFlags);
    }

    const void *caller_ret = __builtin_return_address(0);
    if (g_ds.hwnd_game == NULL && (uFlags & SWP_HIDEWINDOW) == 0) {
        ds_attach_and_apply_game_window(hWnd, (uFlags & SWP_NOSIZE) == 0 ? cx : 0, (uFlags & SWP_NOSIZE) == 0 ? cy : 0);
    }

    bool sys_caller = ds_is_system_renderer_caller(caller_ret);
    EnterCriticalSection(&g_ds.lock);
    bool promoted_fs = ds_try_promote_fullscreen_resize_locked(hWnd, hWndInsertAfter, X, Y, cx, cy, uFlags, sys_caller);
    bool is_game_fs = (hWnd == g_ds.hwnd_game && g_ds.fullscreen_active && g_ds.vp.dst_w > 0 && g_ds.vp.dst_h > 0);
    bool app_inactive = g_ds.app_inactive;
    bool staging_birth = (is_game_fs && !g_ds.cocoa_fs_synced && g_ds.first_visible_tick != 0 &&
                          (GetTickCount() - g_ds.first_visible_tick) < 250);
    int32_t win_scale = (hWnd == g_ds.hwnd_game && !g_ds.fullscreen_active) ? ds_get_windowed_scale_locked() : 1;
    int32_t vw = g_ds.virt_w;
    int32_t vh = g_ds.virt_h;
    if (!promoted_fs && is_game_fs && (uFlags & SWP_NOSIZE) == 0 && cx >= 240 && cy >= 180 &&
        !sys_caller && !g_ds.mode_virtualized) {
        g_ds.virt_w = cx;
        g_ds.virt_h = cy;
        vw = cx;
        vh = cy;
        ds_refresh_viewport_locked();
    }
    LeaveCriticalSection(&g_ds.lock);

    if (is_game_fs) {
        if (GetCurrentThreadId() == g_ds.game_thread_id) {
            ds_ensure_fullscreen_styles_on_owner_thread(hWnd);
        }
        int nx = staging_birth ? (int)((g_ds.real_screen_w - 640) / 2) : ((uFlags & SWP_NOMOVE) ? X : 0);
        int ny = staging_birth ? (int)((g_ds.real_screen_h - 480) / 2) : ((uFlags & SWP_NOMOVE) ? Y : 0);
        int ncx = staging_birth ? 640 : ((uFlags & SWP_NOSIZE) ? cx : g_ds.real_screen_w);
        int ncy = staging_birth ? 480 : ((uFlags & SWP_NOSIZE) ? cy : g_ds.real_screen_h);
        HWND z_order = app_inactive ? HWND_NOTOPMOST : HWND_TOPMOST;
        UINT eff_flags = app_inactive ? (uFlags | SWP_NOACTIVATE) : uFlags;
        if (promoted_fs) {
            eff_flags |= SWP_FRAMECHANGED;
        }
        ds_enter_internal();
        bool already_full = !staging_birth && !promoted_fs && !app_inactive &&
                            ds_is_hwnd_already_full_panel_internal(hWnd) &&
                            (eff_flags & (SWP_HIDEWINDOW | SWP_FRAMECHANGED)) == 0;
        if (already_full) {
            eff_flags = (eff_flags & ~(UINT)SWP_SHOWWINDOW) | SWP_NOMOVE | SWP_NOSIZE;
        } else {
            ds_clear_wine_present_rect_on_hwnd(hWnd);
        }
        BOOL res = g_ds.real_SetWindowPos(hWnd, z_order, nx, ny, ncx, ncy, eff_flags);
        if (GetCurrentThreadId() == g_ds.game_thread_id) {
            if (promoted_fs) {
                ds_ensure_gl_host_child_on_owner_thread(hWnd);
            } else {
                ds_sync_gl_host_bounds_on_owner_thread(hWnd);
            }
        }
        ds_leave_internal();
        if (promoted_fs) {
            ds_gl_notify_mode_changed();
            ds_write_status_file();
        }
        return res;
    }

    if (win_scale > 1 && vw > 0 && vh > 0) {
        int wx = 0, wy = 0, ww = 0, wh = 0;
        ds_compute_centered_windowed_bounds(hWnd, vw * win_scale, vh * win_scale, &wx, &wy, &ww, &wh);
        int nx = (uFlags & SWP_NOMOVE) ? X : wx;
        int ny = (uFlags & SWP_NOMOVE) ? Y : wy;
        int ncx = (uFlags & SWP_NOSIZE) ? cx : ww;
        int ncy = (uFlags & SWP_NOSIZE) ? cy : wh;
        ds_enter_internal();
        ds_clear_wine_present_rect_on_hwnd(hWnd);
        BOOL res = g_ds.real_SetWindowPos(hWnd, HWND_NOTOPMOST, nx, ny, ncx, ncy, uFlags);
        ds_leave_internal();
        if (GetCurrentThreadId() == g_ds.game_thread_id) {
            ds_sync_gl_host_bounds_on_owner_thread(hWnd);
        }
        return res;
    }

    BOOL res = g_ds.real_SetWindowPos(hWnd, hWndInsertAfter, X, Y, cx, cy, uFlags);
    if (hWnd == g_ds.hwnd_game && GetCurrentThreadId() == g_ds.game_thread_id) {
        ds_sync_gl_host_bounds_on_owner_thread(hWnd);
    }
    return res;
}

static BOOL WINAPI hook_MoveWindow(HWND hWnd, int X, int Y, int nWidth, int nHeight, BOOL bRepaint)
{
    if (!ds_is_internal_call()) {
        ds_ensure_runtime_started();
    }
    if (!g_ds.real_MoveWindow) return FALSE;
    if (ds_is_internal_call() || !hWnd || ds_is_passthrough_locked()) {
        return g_ds.real_MoveWindow(hWnd, X, Y, nWidth, nHeight, bRepaint);
    }

    bool sys_caller = ds_is_system_renderer_caller(__builtin_return_address(0));
    EnterCriticalSection(&g_ds.lock);
    bool promoted_fs = ds_try_promote_fullscreen_resize_locked(hWnd, NULL, X, Y, nWidth, nHeight, 0, sys_caller);
    bool is_game_fs = (hWnd == g_ds.hwnd_game && g_ds.fullscreen_active && g_ds.vp.dst_w > 0 && g_ds.vp.dst_h > 0);
    int32_t win_scale = (hWnd == g_ds.hwnd_game && !g_ds.fullscreen_active) ? ds_get_windowed_scale_locked() : 1;
    int32_t vw = g_ds.virt_w;
    int32_t vh = g_ds.virt_h;
    LeaveCriticalSection(&g_ds.lock);

    if (is_game_fs) {
        if (GetCurrentThreadId() == g_ds.game_thread_id) {
            ds_ensure_fullscreen_styles_on_owner_thread(hWnd);
        }
        ds_enter_internal();
        bool already_full = !promoted_fs && ds_is_hwnd_already_full_panel_internal(hWnd);
        if (!already_full) {
            ds_clear_wine_present_rect_on_hwnd(hWnd);
        }
        BOOL res = already_full
            ? TRUE
            : g_ds.real_MoveWindow(hWnd, 0, 0, g_ds.real_screen_w, g_ds.real_screen_h, bRepaint);
        if (already_full && bRepaint) {
            InvalidateRect(hWnd, NULL, FALSE);
        }
        if (GetCurrentThreadId() == g_ds.game_thread_id) {
            if (promoted_fs) {
                ds_ensure_gl_host_child_on_owner_thread(hWnd);
            } else {
                ds_sync_gl_host_bounds_on_owner_thread(hWnd);
            }
        }
        ds_leave_internal();
        if (promoted_fs) {
            ds_gl_notify_mode_changed();
            ds_write_status_file();
        }
        return res;
    }
    if (win_scale > 1 && vw > 0 && vh > 0) {
        int wx = 0, wy = 0, ww = 0, wh = 0;
        ds_compute_centered_windowed_bounds(hWnd, vw * win_scale, vh * win_scale, &wx, &wy, &ww, &wh);
        ds_enter_internal();
        ds_clear_wine_present_rect_on_hwnd(hWnd);
        BOOL res = g_ds.real_MoveWindow(hWnd, wx, wy, ww, wh, bRepaint);
        ds_leave_internal();
        if (GetCurrentThreadId() == g_ds.game_thread_id) {
            ds_sync_gl_host_bounds_on_owner_thread(hWnd);
        }
        return res;
    }
    BOOL res = g_ds.real_MoveWindow(hWnd, X, Y, nWidth, nHeight, bRepaint);
    if (hWnd == g_ds.hwnd_game && GetCurrentThreadId() == g_ds.game_thread_id) {
        ds_sync_gl_host_bounds_on_owner_thread(hWnd);
    }
    return res;
}

static LONG_PTR ds_handle_get_window_long(HWND hWnd, int nIndex, bool unicode)
{
    if (!ds_is_internal_call() && hWnd != NULL && nIndex == GWLP_WNDPROC) {
        EnterCriticalSection(&g_ds.lock);
        WNDPROC orig = (hWnd == g_ds.hwnd_game) ? g_ds.orig_wndproc : NULL;
        LeaveCriticalSection(&g_ds.lock);
        if (orig != NULL) {
            return (LONG_PTR)orig;
        }
    }
#if defined(_WIN64)
    if (unicode) {
        return g_ds.real_GetWindowLongPtrW ? g_ds.real_GetWindowLongPtrW(hWnd, nIndex) : 0;
    }
    return g_ds.real_GetWindowLongPtrA ? g_ds.real_GetWindowLongPtrA(hWnd, nIndex) : 0;
#else
    if (unicode) {
        return (LONG_PTR)(g_ds.real_GetWindowLongW ? g_ds.real_GetWindowLongW(hWnd, nIndex) : 0);
    }
    return (LONG_PTR)(g_ds.real_GetWindowLongA ? g_ds.real_GetWindowLongA(hWnd, nIndex) : 0);
#endif
}

static LONG WINAPI hook_GetWindowLongA(HWND hWnd, int nIndex)
{
    return (LONG)ds_handle_get_window_long(hWnd, nIndex, false);
}

static LONG WINAPI hook_GetWindowLongW(HWND hWnd, int nIndex)
{
    return (LONG)ds_handle_get_window_long(hWnd, nIndex, true);
}

#if defined(_WIN64)
static LONG_PTR WINAPI hook_GetWindowLongPtrA(HWND hWnd, int nIndex)
{
    return ds_handle_get_window_long(hWnd, nIndex, false);
}

static LONG_PTR WINAPI hook_GetWindowLongPtrW(HWND hWnd, int nIndex)
{
    return ds_handle_get_window_long(hWnd, nIndex, true);
}
#endif

static LONG_PTR ds_handle_set_window_long(HWND hWnd, int nIndex, LONG_PTR dwNewLong, bool unicode, const void *caller_ret)
{
    if (!ds_is_internal_call() && hWnd != NULL && nIndex == GWLP_WNDPROC && dwNewLong != 0) {
        EnterCriticalSection(&g_ds.lock);
        bool is_game = (hWnd == g_ds.hwnd_game);
        DWORD owner_tid = g_ds.game_thread_id;
        WNDPROC prev_orig = g_ds.orig_wndproc;
        bool prev_unicode = g_ds.orig_wndproc_unicode;
        if (is_game && (WNDPROC)dwNewLong == ds_game_subclass_wndproc) {
            LeaveCriticalSection(&g_ds.lock);
            return (LONG_PTR)prev_orig;
        }
        if (is_game && (prev_orig != NULL || GetCurrentThreadId() == owner_tid)) {
            /*
             * Keep `ds_game_subclass_wndproc` installed as the outermost `win32u` WndProc
             * when `wined3d` (`wined3d_register_window` / `entry_restore_proc`), SDL, or the
             * game subclasses `GWLP_WNDPROC` after window creation. This guarantees mouse
             * coordinate remapping, `WM_ACTIVATEAPP`, and hotkeys execute before `wined3d_wndproc`
             * (even when `wined3d` temporarily sets `entry->filter_messages = 1`).
             */
            LONG_PTR ret_for_caller = 0;
            ds_enter_internal();
            if (prev_orig != NULL) {
                ds_set_wnd_long_ptr_raw(hWnd, GWLP_WNDPROC, (LONG_PTR)prev_orig, prev_unicode);
            }
            ret_for_caller = ds_set_wnd_long_ptr_raw(hWnd, GWLP_WNDPROC, (LONG_PTR)ds_game_subclass_wndproc, unicode);
            ds_leave_internal();
            g_ds.orig_wndproc = (WNDPROC)dwNewLong;
            g_ds.orig_wndproc_unicode = unicode;
            LeaveCriticalSection(&g_ds.lock);
            return ret_for_caller ? ret_for_caller : (LONG_PTR)prev_orig;
        }
        LeaveCriticalSection(&g_ds.lock);
    }

    if (!ds_is_internal_call() && hWnd != NULL && (nIndex == GWL_STYLE || nIndex == GWL_EXSTYLE)) {
        EnterCriticalSection(&g_ds.lock);
        bool is_game_fs = (hWnd == g_ds.hwnd_game && g_ds.fullscreen_active);
        bool app_inactive = g_ds.app_inactive;
        LONG_PTR prev_saved = (nIndex == GWL_STYLE) ? g_ds.saved_style : g_ds.saved_exstyle;
        if (is_game_fs && !ds_is_system_renderer_caller(caller_ret)) {
            if (nIndex == GWL_STYLE) {
                g_ds.saved_style = dwNewLong;
            } else {
                g_ds.saved_exstyle = dwNewLong;
            }
        }
        LeaveCriticalSection(&g_ds.lock);

        if (is_game_fs) {
            LONG_PTR fs_val = dwNewLong;
            if (nIndex == GWL_STYLE) {
                fs_val = (dwNewLong & ~(LONG_PTR)(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_DLGFRAME | WS_BORDER | WS_MAXIMIZE | WS_MINIMIZE))
                       | (LONG_PTR)(WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN);
            } else {
                fs_val = (dwNewLong & ~(LONG_PTR)(WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE | WS_EX_TOPMOST));
                if (!app_inactive) {
                    fs_val |= (LONG_PTR)WS_EX_TOPMOST;
                }
            }
            ds_enter_internal();
            ds_set_wnd_long_ptr_raw(hWnd, nIndex, fs_val, unicode);
            ds_leave_internal();
            return prev_saved;
        }
    }

    return ds_set_wnd_long_ptr_raw(hWnd, nIndex, dwNewLong, unicode);
}

static LONG WINAPI hook_SetWindowLongA(HWND hWnd, int nIndex, LONG dwNewLong)
{
    return (LONG)ds_handle_set_window_long(hWnd, nIndex, (LONG_PTR)dwNewLong, false, __builtin_return_address(0));
}

static LONG WINAPI hook_SetWindowLongW(HWND hWnd, int nIndex, LONG dwNewLong)
{
    return (LONG)ds_handle_set_window_long(hWnd, nIndex, (LONG_PTR)dwNewLong, true, __builtin_return_address(0));
}

#if defined(_WIN64)
static LONG_PTR WINAPI hook_SetWindowLongPtrA(HWND hWnd, int nIndex, LONG_PTR dwNewLong)
{
    return ds_handle_set_window_long(hWnd, nIndex, dwNewLong, false, __builtin_return_address(0));
}

static LONG_PTR WINAPI hook_SetWindowLongPtrW(HWND hWnd, int nIndex, LONG_PTR dwNewLong)
{
    return ds_handle_set_window_long(hWnd, nIndex, dwNewLong, true, __builtin_return_address(0));
}
#endif

static BOOL WINAPI hook_GetClientRect(HWND hWnd, LPRECT lpRect)
{
    if (!lpRect) return FALSE;
    if (!ds_is_internal_call() && ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        HWND desk = GetDesktopWindow();
        EnterCriticalSection(&g_ds.lock);
        bool is_game_virt = (hWnd != NULL &&
                             ((hWnd == g_ds.hwnd_game && (g_ds.fullscreen_active || ds_get_windowed_scale_locked() > 1)) ||
                              (hWnd == desk && g_ds.fullscreen_active)) &&
                             g_ds.virt_w > 0 && g_ds.virt_h > 0);
        int32_t vw = g_ds.virt_w;
        int32_t vh = g_ds.virt_h;
        LeaveCriticalSection(&g_ds.lock);

        if (is_game_virt) {
            lpRect->left = 0;
            lpRect->top = 0;
            lpRect->right = vw;
            lpRect->bottom = vh;
            return TRUE;
        }
    }
    return g_ds.real_GetClientRect ? g_ds.real_GetClientRect(hWnd, lpRect) : FALSE;
}

static BOOL WINAPI hook_GetWindowRect(HWND hWnd, LPRECT lpRect)
{
    if (!lpRect) return FALSE;
    if (!ds_is_internal_call() && ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        EnterCriticalSection(&g_ds.lock);
        bool is_game_fs = ((hWnd == g_ds.hwnd_game || hWnd == GetDesktopWindow()) &&
                           g_ds.fullscreen_active && g_ds.virt_w > 0 && g_ds.virt_h > 0);
        int32_t vw = g_ds.virt_w;
        int32_t vh = g_ds.virt_h;
        LeaveCriticalSection(&g_ds.lock);

        if (is_game_fs) {
            lpRect->left = 0;
            lpRect->top = 0;
            lpRect->right = vw;
            lpRect->bottom = vh;
            return TRUE;
        }
    }
    return g_ds.real_GetWindowRect ? g_ds.real_GetWindowRect(hWnd, lpRect) : FALSE;
}

static BOOL WINAPI hook_GetMonitorInfoW(HMONITOR hMonitor, LPMONITORINFO lpmi)
{
    if (!g_ds.real_GetMonitorInfoW) return FALSE;
    BOOL ok = g_ds.real_GetMonitorInfoW(hMonitor, lpmi);
    if (!ok || !lpmi || ds_is_internal_call()) {
        return ok;
    }
    if (ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        EnterCriticalSection(&g_ds.lock);
        bool virt = g_ds.fullscreen_active && g_ds.virt_w > 0 && g_ds.virt_h > 0;
        int32_t vw = g_ds.virt_w;
        int32_t vh = g_ds.virt_h;
        LeaveCriticalSection(&g_ds.lock);
        if (virt) {
            lpmi->rcMonitor.left = 0;
            lpmi->rcMonitor.top = 0;
            lpmi->rcMonitor.right = vw;
            lpmi->rcMonitor.bottom = vh;
            lpmi->rcWork = lpmi->rcMonitor;
        }
    }
    return ok;
}

static BOOL WINAPI hook_GetMonitorInfoA(HMONITOR hMonitor, LPMONITORINFO lpmi)
{
    if (!g_ds.real_GetMonitorInfoA) return FALSE;
    BOOL ok = g_ds.real_GetMonitorInfoA(hMonitor, lpmi);
    if (!ok || !lpmi || ds_is_internal_call()) {
        return ok;
    }
    if (ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        EnterCriticalSection(&g_ds.lock);
        bool virt = g_ds.fullscreen_active && g_ds.virt_w > 0 && g_ds.virt_h > 0;
        int32_t vw = g_ds.virt_w;
        int32_t vh = g_ds.virt_h;
        LeaveCriticalSection(&g_ds.lock);
        if (virt) {
            lpmi->rcMonitor.left = 0;
            lpmi->rcMonitor.top = 0;
            lpmi->rcMonitor.right = vw;
            lpmi->rcMonitor.bottom = vh;
            lpmi->rcWork = lpmi->rcMonitor;
        }
    }
    return ok;
}

static BOOL WINAPI hook_GetCursorPos(LPPOINT lpPoint)
{
    if (!lpPoint || !g_ds.real_GetCursorPos) return FALSE;
    POINT phys = { 0, 0 };
    if (!g_ds.real_GetCursorPos(&phys)) {
        return FALSE;
    }
    if (ds_is_internal_call() || !ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        *lpPoint = phys;
        return TRUE;
    }

    EnterCriticalSection(&g_ds.lock);
    bool fs_active = (g_ds.fullscreen_active && g_ds.virt_w > 0 && g_ds.virt_h > 0 && g_ds.vp.dst_w > 0 && g_ds.vp.dst_h > 0);
    int32_t win_scale = ds_get_windowed_scale_locked();
    HWND hwnd_game = g_ds.hwnd_game;
    int32_t vw = g_ds.virt_w;
    int32_t vh = g_ds.virt_h;
    int32_t vx = phys.x;
    int32_t vy = phys.y;
    if (fs_active) {
        ds_cursor_resolve_get_pos(
            &g_ds.warp,
            phys.x,
            phys.y,
            g_ds.vp.dst_x,
            g_ds.vp.dst_y,
            g_ds.vp.dst_w,
            g_ds.vp.dst_h,
            g_ds.virt_w,
            g_ds.virt_h,
            &vx,
            &vy
        );
    } else if (win_scale > 1 && hwnd_game && IsWindow(hwnd_game) && g_ds.real_ClientToScreen) {
        POINT orig = { 0, 0 };
        ds_enter_internal();
        BOOL has_orig = g_ds.real_ClientToScreen(hwnd_game, &orig);
        ds_leave_internal();
        if (has_orig) {
            int32_t rel_vx = 0, rel_vy = 0;
            ds_cursor_resolve_get_pos(
                &g_ds.warp,
                phys.x,
                phys.y,
                orig.x,
                orig.y,
                vw * win_scale,
                vh * win_scale,
                vw,
                vh,
                &rel_vx,
                &rel_vy
            );
            vx = orig.x + rel_vx;
            vy = orig.y + rel_vy;
        }
    }
    LeaveCriticalSection(&g_ds.lock);

    lpPoint->x = vx;
    lpPoint->y = vy;
    return TRUE;
}

static BOOL WINAPI hook_SetCursorPos(int X, int Y)
{
    if (!g_ds.real_SetCursorPos) return FALSE;
    if (ds_is_internal_call() || !ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        return g_ds.real_SetCursorPos(X, Y);
    }

    int32_t px = X;
    int32_t py = Y;
    EnterCriticalSection(&g_ds.lock);
    int32_t win_scale = ds_get_windowed_scale_locked();
    HWND hwnd_game = g_ds.hwnd_game;
    if (g_ds.fullscreen_active && g_ds.virt_w > 0 && g_ds.virt_h > 0 && g_ds.vp.dst_w > 0 && g_ds.vp.dst_h > 0) {
        ds_cursor_record_warp(
            &g_ds.warp,
            X,
            Y,
            g_ds.vp.dst_x,
            g_ds.vp.dst_y,
            g_ds.vp.dst_w,
            g_ds.vp.dst_h,
            g_ds.virt_w,
            g_ds.virt_h,
            &px,
            &py
        );
    } else if (win_scale > 1 && hwnd_game && IsWindow(hwnd_game) && g_ds.real_ClientToScreen) {
        POINT orig = { 0, 0 };
        ds_enter_internal();
        BOOL has_orig = g_ds.real_ClientToScreen(hwnd_game, &orig);
        ds_leave_internal();
        if (has_orig) {
            ds_cursor_record_warp(
                &g_ds.warp,
                X - orig.x,
                Y - orig.y,
                orig.x,
                orig.y,
                g_ds.virt_w * win_scale,
                g_ds.virt_h * win_scale,
                g_ds.virt_w,
                g_ds.virt_h,
                &px,
                &py
            );
        }
    }
    LeaveCriticalSection(&g_ds.lock);
    return g_ds.real_SetCursorPos(px, py);
}

static BOOL WINAPI hook_ClipCursor(const RECT *lpRect)
{
    if (!g_ds.real_ClipCursor) return FALSE;
    if (ds_is_internal_call() || !ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        return g_ds.real_ClipCursor(lpRect);
    }

    EnterCriticalSection(&g_ds.lock);
    if (!lpRect) {
        g_ds.has_virtual_clip = false;
        LeaveCriticalSection(&g_ds.lock);
        return g_ds.real_ClipCursor(NULL);
    }
    g_ds.has_virtual_clip = true;
    g_ds.virtual_clip_rect = *lpRect;
    bool fs_active = g_ds.fullscreen_active;
    if (fs_active) {
        ds_reapply_cursor_clip_locked();
        LeaveCriticalSection(&g_ds.lock);
        return TRUE;
    }
    int32_t win_scale = ds_get_windowed_scale_locked();
    HWND hwnd_game = g_ds.hwnd_game;
    int32_t vw = g_ds.virt_w;
    int32_t vh = g_ds.virt_h;
    RECT vclip = *lpRect;
    LeaveCriticalSection(&g_ds.lock);

    if (win_scale > 1 && vw > 0 && vh > 0 && hwnd_game && IsWindow(hwnd_game) && g_ds.real_ClientToScreen) {
        POINT orig = { 0, 0 };
        ds_enter_internal();
        BOOL has_orig = g_ds.real_ClientToScreen(hwnd_game, &orig);
        ds_leave_internal();
        if (has_orig) {
            int32_t rw = vclip.right - vclip.left;
            int32_t rh = vclip.bottom - vclip.top;
            int32_t px = 0, py = 0, pw = 0, ph = 0;
            if (rw > 0 && rh > 0 &&
                ds_map_subrect_virt_to_phys(
                    vclip.left - orig.x,
                    vclip.top - orig.y,
                    rw,
                    rh,
                    orig.x,
                    orig.y,
                    vw * win_scale,
                    vh * win_scale,
                    vw,
                    vh,
                    &px,
                    &py,
                    &pw,
                    &ph)) {
                RECT phys_clip = { px, py, px + pw, py + ph };
                return g_ds.real_ClipCursor(&phys_clip);
            }
        }
    }
    return g_ds.real_ClipCursor(lpRect);
}

static BOOL WINAPI hook_GetClipCursor(LPRECT lpRect)
{
    if (!lpRect || !g_ds.real_GetClipCursor) return FALSE;
    if (!ds_is_internal_call() && ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        EnterCriticalSection(&g_ds.lock);
        if (g_ds.has_virtual_clip) {
            *lpRect = g_ds.virtual_clip_rect;
            LeaveCriticalSection(&g_ds.lock);
            return TRUE;
        }
        if (g_ds.fullscreen_active && g_ds.virt_w > 0 && g_ds.virt_h > 0) {
            lpRect->left = 0;
            lpRect->top = 0;
            lpRect->right = g_ds.virt_w;
            lpRect->bottom = g_ds.virt_h;
            LeaveCriticalSection(&g_ds.lock);
            return TRUE;
        }
        LeaveCriticalSection(&g_ds.lock);
    }
    return g_ds.real_GetClipCursor(lpRect);
}

static DWORD WINAPI hook_GetMessagePos(void)
{
    DWORD raw = g_ds.real_GetMessagePos ? g_ds.real_GetMessagePos() : 0;
    if (ds_is_internal_call() || !ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        return raw;
    }

    int32_t px = (int32_t)(short)LOWORD(raw);
    int32_t py = (int32_t)(short)HIWORD(raw);
    int32_t vx = px;
    int32_t vy = py;
    bool mapped = false;

    EnterCriticalSection(&g_ds.lock);
    int32_t win_scale = ds_get_windowed_scale_locked();
    HWND hwnd_game = g_ds.hwnd_game;
    int32_t vw = g_ds.virt_w;
    int32_t vh = g_ds.virt_h;
    if (g_ds.fullscreen_active && vw > 0 && vh > 0 && g_ds.vp.dst_w > 0 && g_ds.vp.dst_h > 0) {
        ds_map_cursor_phys_to_virt(
            px,
            py,
            g_ds.vp.dst_x,
            g_ds.vp.dst_y,
            g_ds.vp.dst_w,
            g_ds.vp.dst_h,
            vw,
            vh,
            &vx,
            &vy
        );
        mapped = true;
    } else if (win_scale > 1 && vw > 0 && vh > 0 && hwnd_game && IsWindow(hwnd_game) && g_ds.real_ClientToScreen) {
        POINT orig = { 0, 0 };
        ds_enter_internal();
        BOOL has_orig = g_ds.real_ClientToScreen(hwnd_game, &orig);
        ds_leave_internal();
        if (has_orig) {
            int32_t rel_vx = 0, rel_vy = 0;
            ds_map_cursor_phys_to_virt(
                px,
                py,
                orig.x,
                orig.y,
                vw * win_scale,
                vh * win_scale,
                vw,
                vh,
                &rel_vx,
                &rel_vy
            );
            vx = orig.x + rel_vx;
            vy = orig.y + rel_vy;
            mapped = true;
        }
    }
    LeaveCriticalSection(&g_ds.lock);

    if (!mapped) {
        return raw;
    }
    return (DWORD)MAKELONG((WORD)(short)vx, (WORD)(short)vy);
}

static void ds_remap_rawinput_mouse_packet(RAWINPUT *raw)
{
    if (!raw || raw->header.dwType != RIM_TYPEMOUSE) {
        return;
    }
    /* Preserve relative 3D camera mickeys 1:1; only remap normalized absolute coords */
    if ((raw->data.mouse.usFlags & MOUSE_MOVE_ABSOLUTE) == 0) {
        return;
    }

    EnterCriticalSection(&g_ds.lock);
    bool fs_active = (
        g_ds.fullscreen_active &&
        g_ds.real_screen_w > 0 &&
        g_ds.real_screen_h > 0 &&
        g_ds.vp.dst_w > 0 &&
        g_ds.vp.dst_h > 0
    );
    int32_t rsw = g_ds.real_screen_w;
    int32_t rsh = g_ds.real_screen_h;
    ds_viewport_t vp = g_ds.vp;
    LeaveCriticalSection(&g_ds.lock);

    if (!fs_active) {
        return;
    }

    double phys_x = ((double)raw->data.mouse.lLastX * (double)rsw) / 65535.0;
    double phys_y = ((double)raw->data.mouse.lLastY * (double)rsh) / 65535.0;
    double norm_x = ((phys_x - (double)vp.dst_x) * 65535.0) / (double)vp.dst_w;
    double norm_y = ((phys_y - (double)vp.dst_y) * 65535.0) / (double)vp.dst_h;
    if (norm_x < 0.0) norm_x = 0.0;
    if (norm_x > 65535.0) norm_x = 65535.0;
    if (norm_y < 0.0) norm_y = 0.0;
    if (norm_y > 65535.0) norm_y = 65535.0;
    raw->data.mouse.lLastX = (LONG)(norm_x + 0.5);
    raw->data.mouse.lLastY = (LONG)(norm_y + 0.5);
}

static UINT WINAPI hook_GetRawInputData(HRAWINPUT hRawInput, UINT uiCommand, LPVOID pData, PUINT pcbSize, UINT cbSizeHeader)
{
    if (!g_ds.real_GetRawInputData) return (UINT)-1;
    UINT res = g_ds.real_GetRawInputData(hRawInput, uiCommand, pData, pcbSize, cbSizeHeader);
    if (res != (UINT)-1 &&
        pData != NULL &&
        uiCommand == RID_INPUT &&
        res >= (UINT)sizeof(RAWINPUTHEADER) &&
        !ds_is_internal_call() &&
        ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        ds_remap_rawinput_mouse_packet((RAWINPUT *)pData);
    }
    return res;
}

static UINT WINAPI hook_GetRawInputBuffer(PRAWINPUT pData, PUINT pcbSize, UINT cbSizeHeader)
{
    if (!g_ds.real_GetRawInputBuffer) return (UINT)-1;
    UINT res = g_ds.real_GetRawInputBuffer(pData, pcbSize, cbSizeHeader);
    if (res != (UINT)-1 &&
        res > 0 &&
        pData != NULL &&
        !ds_is_internal_call() &&
        ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        uint8_t *cur = (uint8_t *)pData;
        for (UINT i = 0; i < res; i++) {
            RAWINPUT *pkt = (RAWINPUT *)(void *)cur;
            if (pkt->header.dwSize < sizeof(RAWINPUTHEADER)) {
                break;
            }
            ds_remap_rawinput_mouse_packet(pkt);
            size_t step = ((size_t)pkt->header.dwSize + sizeof(ULONG_PTR) - 1u) & ~(sizeof(ULONG_PTR) - 1u);
            if (step == 0) break;
            cur += step;
        }
    }
    return res;
}

static BOOL WINAPI hook_RegisterRawInputDevices(PCRAWINPUTDEVICE pRawInputDevices, UINT uiNumDevices, UINT cbSize)
{
    if (!g_ds.real_RegisterRawInputDevices) return FALSE;
    BOOL ok = g_ds.real_RegisterRawInputDevices(pRawInputDevices, uiNumDevices, cbSize);
    if (ok && !ds_is_internal_call() && pRawInputDevices && cbSize >= sizeof(RAWINPUTDEVICE)) {
        const uint8_t *base = (const uint8_t *)pRawInputDevices;
        for (UINT i = 0; i < uiNumDevices; i++) {
            const RAWINPUTDEVICE *dev = (const RAWINPUTDEVICE *)(const void *)(base + (size_t)i * (size_t)cbSize);
            if (dev->usUsagePage == 0x01 && dev->usUsage == 0x02) {
                bool remove_dev = (dev->dwFlags & 0x00000001u) != 0;
                bool want_confine = !remove_dev && (dev->dwFlags & (RIDEV_NOLEGACY | RIDEV_CAPTUREMOUSE)) != 0;
                EnterCriticalSection(&g_ds.lock);
                g_ds.raw_mouse_nolegacy = want_confine;
                if (want_confine && g_ds.fullscreen_active && !g_ds.app_inactive) {
                    ds_reapply_cursor_clip_locked();
                }
                LeaveCriticalSection(&g_ds.lock);
            }
        }
    }
    return ok;
}

static BOOL WINAPI hook_ScreenToClient(HWND hWnd, LPPOINT lpPoint)
{
    if (!lpPoint) return FALSE;
    if (!ds_is_internal_call() && ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        EnterCriticalSection(&g_ds.lock);
        bool is_game_fs = (hWnd != NULL && hWnd == g_ds.hwnd_game && g_ds.fullscreen_active);
        bool is_game_win_scaled = (hWnd != NULL && hWnd == g_ds.hwnd_game && !g_ds.fullscreen_active && ds_get_windowed_scale_locked() > 1);
        LeaveCriticalSection(&g_ds.lock);
        if (is_game_fs) {
            /* Virtual screen origin is already (0, 0) == virtual client origin (0, 0) */
            return TRUE;
        }
        if (is_game_win_scaled && g_ds.real_ClientToScreen) {
            POINT orig = { 0, 0 };
            ds_enter_internal();
            BOOL has_orig = g_ds.real_ClientToScreen(hWnd, &orig);
            ds_leave_internal();
            if (has_orig) {
                lpPoint->x -= orig.x;
                lpPoint->y -= orig.y;
                return TRUE;
            }
        }
    }
    return g_ds.real_ScreenToClient ? g_ds.real_ScreenToClient(hWnd, lpPoint) : FALSE;
}

static BOOL WINAPI hook_ClientToScreen(HWND hWnd, LPPOINT lpPoint)
{
    if (!lpPoint) return FALSE;
    if (!ds_is_internal_call() && ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        EnterCriticalSection(&g_ds.lock);
        bool is_game_fs = (hWnd != NULL && hWnd == g_ds.hwnd_game && g_ds.fullscreen_active);
        bool is_game_win_scaled = (hWnd != NULL && hWnd == g_ds.hwnd_game && !g_ds.fullscreen_active && ds_get_windowed_scale_locked() > 1);
        LeaveCriticalSection(&g_ds.lock);
        if (is_game_fs) {
            return TRUE;
        }
        if (is_game_win_scaled && g_ds.real_ClientToScreen) {
            POINT orig = { 0, 0 };
            ds_enter_internal();
            BOOL has_orig = g_ds.real_ClientToScreen(hWnd, &orig);
            ds_leave_internal();
            if (has_orig) {
                lpPoint->x += orig.x;
                lpPoint->y += orig.y;
                return TRUE;
            }
        }
    }
    return g_ds.real_ClientToScreen ? g_ds.real_ClientToScreen(hWnd, lpPoint) : FALSE;
}

static int WINAPI hook_MapWindowPoints(HWND hWndFrom, HWND hWndTo, LPPOINT lpPoints, UINT cPoints)
{
    if (!lpPoints) {
        return g_ds.real_MapWindowPoints ? g_ds.real_MapWindowPoints(hWndFrom, hWndTo, lpPoints, cPoints) : 0;
    }
    if (!ds_is_internal_call() && ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        HWND desk = GetDesktopWindow();
        bool from_desk = (hWndFrom == NULL || hWndFrom == desk);
        bool to_desk = (hWndTo == NULL || hWndTo == desk);

        EnterCriticalSection(&g_ds.lock);
        HWND hwnd_game = g_ds.hwnd_game;
        bool fs_active = g_ds.fullscreen_active;
        int32_t win_scale = ds_get_windowed_scale_locked();
        LeaveCriticalSection(&g_ds.lock);

        if (hwnd_game != NULL && (hWndFrom == hwnd_game || hWndTo == hwnd_game)) {
            if (hWndFrom == hWndTo) {
                SetLastError(0);
                return 0;
            }
            if ((hWndFrom == hwnd_game && to_desk) || (from_desk && hWndTo == hwnd_game)) {
                if (fs_active) {
                    SetLastError(0);
                    return 0;
                }
                if (win_scale > 1 && g_ds.real_ClientToScreen) {
                    POINT orig = { 0, 0 };
                    ds_enter_internal();
                    BOOL has_orig = g_ds.real_ClientToScreen(hwnd_game, &orig);
                    ds_leave_internal();
                    if (has_orig) {
                        LONG dx = (hWndFrom == hwnd_game) ? orig.x : -orig.x;
                        LONG dy = (hWndFrom == hwnd_game) ? orig.y : -orig.y;
                        for (UINT i = 0; i < cPoints; i++) {
                            lpPoints[i].x += dx;
                            lpPoints[i].y += dy;
                        }
                        SetLastError(0);
                        return (int)(DWORD)MAKELONG((WORD)(short)dx, (WORD)(short)dy);
                    }
                }
            }
        }
    }
    return g_ds.real_MapWindowPoints ? g_ds.real_MapWindowPoints(hWndFrom, hWndTo, lpPoints, cPoints) : 0;
}

static HWND WINAPI hook_WindowFromPoint(POINT Point)
{
    if (!g_ds.real_WindowFromPoint) return NULL;
    if (ds_is_internal_call() || !ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        return g_ds.real_WindowFromPoint(Point);
    }

    POINT phys = Point;
    EnterCriticalSection(&g_ds.lock);
    HWND hwnd_game = g_ds.hwnd_game;
    HWND hwnd_gl_host = g_ds.hwnd_gl_host;
    int32_t win_scale = ds_get_windowed_scale_locked();
    if (g_ds.fullscreen_active && g_ds.virt_w > 0 && g_ds.virt_h > 0 && g_ds.vp.dst_w > 0 && g_ds.vp.dst_h > 0) {
        int32_t px = phys.x, py = phys.y, pw = 1, ph = 1;
        if (ds_map_subrect_virt_to_phys(
                Point.x,
                Point.y,
                1,
                1,
                g_ds.vp.dst_x,
                g_ds.vp.dst_y,
                g_ds.vp.dst_w,
                g_ds.vp.dst_h,
                g_ds.virt_w,
                g_ds.virt_h,
                &px,
                &py,
                &pw,
                &ph)) {
            phys.x = px;
            phys.y = py;
        }
    } else if (win_scale > 1 && g_ds.virt_w > 0 && g_ds.virt_h > 0 && hwnd_game && IsWindow(hwnd_game) && g_ds.real_ClientToScreen) {
        POINT orig = { 0, 0 };
        ds_enter_internal();
        BOOL has_orig = g_ds.real_ClientToScreen(hwnd_game, &orig);
        ds_leave_internal();
        if (has_orig) {
            int32_t px = phys.x, py = phys.y, pw = 1, ph = 1;
            if (ds_map_subrect_virt_to_phys(
                    Point.x - orig.x,
                    Point.y - orig.y,
                    1,
                    1,
                    orig.x,
                    orig.y,
                    g_ds.virt_w * win_scale,
                    g_ds.virt_h * win_scale,
                    g_ds.virt_w,
                    g_ds.virt_h,
                    &px,
                    &py,
                    &pw,
                    &ph)) {
                phys.x = px;
                phys.y = py;
            }
        }
    }
    LeaveCriticalSection(&g_ds.lock);

    HWND hit = g_ds.real_WindowFromPoint(phys);
    if (hit != NULL && hit == hwnd_gl_host && hwnd_game != NULL) {
        return hwnd_game;
    }
    return hit;
}

/* -------------------------------------------------------------------------
 * Child Process Propagation (32/64-bit Launcher Stubs -> Child Game Executables)
 * ------------------------------------------------------------------------- */

static bool ds_probe_child_pe_is_x86(HANDLE hProcess, bool *out_is_x86)
{
    if (!hProcess || !out_is_x86) return false;
    typedef BOOL (WINAPI *pfn_QueryFullProcessImageNameW_t)(HANDLE, DWORD, LPWSTR, PDWORD);
    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    pfn_QueryFullProcessImageNameW_t p_query_img = (k32 && g_ds.real_GetProcAddress)
        ? (pfn_QueryFullProcessImageNameW_t)(uintptr_t)g_ds.real_GetProcAddress(k32, "QueryFullProcessImageNameW")
        : NULL;
    if (!p_query_img) return false;

    WCHAR img_path[MAX_PATH] = { 0 };
    DWORD cch = MAX_PATH;
    if (!p_query_img(hProcess, 0, img_path, &cch) || cch == 0 || !img_path[0]) {
        return false;
    }

    bool known = false;
    ds_enter_internal();
    HANDLE hf = CreateFileW(
        img_path,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );
    if (hf != INVALID_HANDLE_VALUE) {
        IMAGE_DOS_HEADER dos;
        DWORD rd = 0;
        if (ReadFile(hf, &dos, (DWORD)sizeof(dos), &rd, NULL) &&
            rd == (DWORD)sizeof(dos) &&
            dos.e_magic == IMAGE_DOS_SIGNATURE &&
            dos.e_lfanew > 0 &&
            dos.e_lfanew < 0x100000) {
            if (SetFilePointer(hf, dos.e_lfanew, NULL, FILE_BEGIN) != INVALID_SET_FILE_POINTER) {
                struct {
                    DWORD Signature;
                    IMAGE_FILE_HEADER FileHeader;
                } pe_hdr;
                DWORD prd = 0;
                if (ReadFile(hf, &pe_hdr, (DWORD)sizeof(pe_hdr), &prd, NULL) &&
                    prd == (DWORD)sizeof(pe_hdr) &&
                    pe_hdr.Signature == IMAGE_NT_SIGNATURE) {
                    if (pe_hdr.FileHeader.Machine == IMAGE_FILE_MACHINE_I386) {
                        *out_is_x86 = true;
                        known = true;
                    } else if (pe_hdr.FileHeader.Machine == 0x8664u || pe_hdr.FileHeader.Machine == 0xAA64u) {
                        *out_is_x86 = false;
                        known = true;
                    }
                }
            }
        }
        CloseHandle(hf);
    }
    ds_leave_internal();
    return known;
}

static void ds_inject_into_suspended_child(const PROCESS_INFORMATION *pi)
{
    if (!pi || !pi->hProcess || !pi->hThread) return;

    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    bool child_is_x86 = false;
    if (!ds_probe_child_pe_is_x86(pi->hProcess, &child_is_x86)) {
        BOOL is_wow64 = FALSE;
        typedef BOOL (WINAPI *pfn_IsWow64Process_t)(HANDLE, PBOOL);
        pfn_IsWow64Process_t p_is_wow64 = k32 && g_ds.real_GetProcAddress
            ? (pfn_IsWow64Process_t)(uintptr_t)g_ds.real_GetProcAddress(k32, "IsWow64Process")
            : NULL;
        if (p_is_wow64 && p_is_wow64(pi->hProcess, &is_wow64)) {
            if (is_wow64) {
                child_is_x86 = true;
            } else {
#if !defined(_WIN64)
                BOOL self_wow64 = FALSE;
                if (p_is_wow64(GetCurrentProcess(), &self_wow64) && !self_wow64) {
                    child_is_x86 = true;
                }
#endif
            }
        } else {
#if !defined(_WIN64)
            child_is_x86 = true;
#endif
        }
    }

#if defined(_WIN64)
    const bool self_is_x86 = false;
#else
    const bool self_is_x86 = true;
#endif

    const WCHAR *target_dll = child_is_x86 ? g_ds.dll_x86 : g_ds.dll_x64;
    if (!target_dll[0]) return;

    if (child_is_x86 == self_is_x86) {
        FARPROC p_load_lib = k32 && g_ds.real_GetProcAddress ? g_ds.real_GetProcAddress(k32, "LoadLibraryW") : NULL;
        SIZE_T bytes = (wcslen(target_dll) + 1) * sizeof(WCHAR);
        LPVOID remote = p_load_lib ? VirtualAllocEx(pi->hProcess, NULL, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE) : NULL;
        if (remote) {
            SIZE_T written = 0;
            if (WriteProcessMemory(pi->hProcess, remote, target_dll, bytes, &written) && written == bytes) {
                if (QueueUserAPC((PAPCFUNC)(uintptr_t)p_load_lib, pi->hThread, (ULONG_PTR)remote) == 0) {
                    VirtualFreeEx(pi->hProcess, remote, 0, MEM_RELEASE);
                }
            } else {
                VirtualFreeEx(pi->hProcess, remote, 0, MEM_RELEASE);
            }
        }
    } else {
        const WCHAR *helper_exe = child_is_x86 ? g_ds.launcher_x86 : g_ds.launcher_x64;
        if (helper_exe[0] && g_ds.real_CreateProcessW) {
            WCHAR cmd[1024];
            _snwprintf(
                cmd,
                1023,
                L"\"%ls\" --inject-pid %lu --tid %lu --dll \"%ls\"",
                helper_exe,
                (unsigned long)pi->dwProcessId,
                (unsigned long)pi->dwThreadId,
                target_dll
            );
            cmd[1023] = L'\0';
            STARTUPINFOW si;
            PROCESS_INFORMATION hpi;
            memset(&si, 0, sizeof(si));
            memset(&hpi, 0, sizeof(hpi));
            si.cb = sizeof(si);
            ds_enter_internal();
            if (g_ds.real_CreateProcessW(helper_exe, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &hpi)) {
                WaitForSingleObject(hpi.hProcess, 5000);
                DWORD helper_exit = 1;
                GetExitCodeProcess(hpi.hProcess, &helper_exit);
                CloseHandle(hpi.hThread);
                CloseHandle(hpi.hProcess);
                if (helper_exit != 0) {
                    ds_tracef("cross-architecture APC injection helper exited with code %lu", (unsigned long)helper_exit);
                }
            }
            ds_leave_internal();
        }
    }
}

static bool ds_env_block_has_key_w(const WCHAR *block, size_t block_chars, const WCHAR *key, size_t key_len)
{
    if (!block || block_chars == 0 || !key || key_len == 0) return false;
    size_t pos = 0;
    while (pos < block_chars && block[pos] != L'\0') {
        const WCHAR *entry = block + pos;
        size_t len = wcslen(entry);
        if (len > key_len && entry[key_len] == L'=' && _wcsnicmp(entry, key, key_len) == 0) {
            return true;
        }
        pos += len + 1;
    }
    return false;
}

static bool ds_append_env_entry_w(WCHAR **buf, size_t *len, size_t *cap, const WCHAR *entry, size_t entry_len)
{
    if (!buf || !len || !cap || !entry || entry_len == 0) return false;
    size_t need = *len + entry_len + 2;
    if (need > *cap) {
        size_t new_cap = (*cap > 0) ? (*cap * 2) : 1024;
        while (new_cap < need) new_cap *= 2;
        WCHAR *nb = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, new_cap * sizeof(WCHAR));
        if (!nb) return false;
        if (*buf && *len > 0) {
            memcpy(nb, *buf, (*len) * sizeof(WCHAR));
        }
        if (*buf) HeapFree(GetProcessHeap(), 0, *buf);
        *buf = nb;
        *cap = new_cap;
    }
    memcpy((*buf) + (*len), entry, entry_len * sizeof(WCHAR));
    (*buf)[*len + entry_len] = L'\0';
    *len += entry_len + 1;
    (*buf)[*len] = L'\0';
    return true;
}

static void ds_append_kv_if_missing_w(WCHAR **buf, size_t *len, size_t *cap, const WCHAR *key, const WCHAR *val)
{
    if (!key || !key[0] || !val || !val[0]) return;
    size_t klen = wcslen(key);
    if (ds_env_block_has_key_w(*buf, *len, key, klen)) return;
    WCHAR line[MAX_PATH + 96];
    int n = _snwprintf(line, (sizeof(line) / sizeof(line[0])) - 1, L"%ls=%ls", key, val);
    if (n > 0) {
        line[(sizeof(line) / sizeof(line[0])) - 1] = L'\0';
        (void)ds_append_env_entry_w(buf, len, cap, line, wcslen(line));
    }
}

static WCHAR *ds_build_merged_child_env_w(LPVOID caller_env, DWORD caller_flags)
{
    if (!caller_env) {
        /* When inheriting parent's env block, ensure auto-discovered paths/session files are exported */
        if (g_ds.dll_x86[0]) SetEnvironmentVariableW(L"ONE_LAUNCHER_SCALER_DLL_X86", g_ds.dll_x86);
        if (g_ds.dll_x64[0]) SetEnvironmentVariableW(L"ONE_LAUNCHER_SCALER_DLL_X64", g_ds.dll_x64);
        if (g_ds.launcher_x86[0]) SetEnvironmentVariableW(L"ONE_LAUNCHER_LAUNCHER_EXE_X86", g_ds.launcher_x86);
        if (g_ds.launcher_x64[0]) SetEnvironmentVariableW(L"ONE_LAUNCHER_LAUNCHER_EXE_X64", g_ds.launcher_x64);
        if (g_ds.control_file[0]) SetEnvironmentVariableW(L"ONE_LAUNCHER_DISPLAY_CONTROL_FILE", g_ds.control_file);
        if (g_ds.status_file[0]) SetEnvironmentVariableW(L"ONE_LAUNCHER_DISPLAY_STATUS_FILE", g_ds.status_file);
        return NULL;
    }

    WCHAR *out_buf = NULL;
    size_t out_len = 0;
    size_t out_cap = 0;

    if ((caller_flags & CREATE_UNICODE_ENVIRONMENT) != 0) {
        const WCHAR *p = (const WCHAR *)caller_env;
        while (*p != L'\0') {
            size_t elen = wcslen(p);
            if (!ds_append_env_entry_w(&out_buf, &out_len, &out_cap, p, elen)) {
                if (out_buf) HeapFree(GetProcessHeap(), 0, out_buf);
                return NULL;
            }
            p += elen + 1;
        }
    } else {
        const char *p = (const char *)caller_env;
        while (*p != '\0') {
            size_t alen = strlen(p);
            int wneed = MultiByteToWideChar(CP_ACP, 0, p, (int)alen, NULL, 0);
            if (wneed > 0) {
                WCHAR *tmp = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, ((size_t)wneed + 1) * sizeof(WCHAR));
                if (tmp) {
                    MultiByteToWideChar(CP_ACP, 0, p, (int)alen, tmp, wneed);
                    tmp[wneed] = L'\0';
                    (void)ds_append_env_entry_w(&out_buf, &out_len, &out_cap, tmp, (size_t)wneed);
                    HeapFree(GetProcessHeap(), 0, tmp);
                }
            }
            p += alen + 1;
        }
    }

    /* Merge parent ONE_LAUNCHER_* variables that were stripped by the caller's custom lpEnvironment */
    LPWCH parent_env = GetEnvironmentStringsW();
    if (parent_env) {
        const WCHAR *pe = parent_env;
        while (*pe != L'\0') {
            size_t elen = wcslen(pe);
            if (_wcsnicmp(pe, L"ONE_LAUNCHER_", 13) == 0) {
                const WCHAR *eq = wcschr(pe, L'=');
                if (eq && eq > pe) {
                    size_t klen = (size_t)(eq - pe);
                    if (!ds_env_block_has_key_w(out_buf, out_len, pe, klen)) {
                        (void)ds_append_env_entry_w(&out_buf, &out_len, &out_cap, pe, elen);
                    }
                }
            }
            pe += elen + 1;
        }
        FreeEnvironmentStringsW(parent_env);
    }

    EnterCriticalSection(&g_ds.lock);
    ds_append_kv_if_missing_w(&out_buf, &out_len, &out_cap, L"ONE_LAUNCHER_SCALER_DLL_X86", g_ds.dll_x86);
    ds_append_kv_if_missing_w(&out_buf, &out_len, &out_cap, L"ONE_LAUNCHER_SCALER_DLL_X64", g_ds.dll_x64);
    ds_append_kv_if_missing_w(&out_buf, &out_len, &out_cap, L"ONE_LAUNCHER_LAUNCHER_EXE_X86", g_ds.launcher_x86);
    ds_append_kv_if_missing_w(&out_buf, &out_len, &out_cap, L"ONE_LAUNCHER_LAUNCHER_EXE_X64", g_ds.launcher_x64);
    ds_append_kv_if_missing_w(&out_buf, &out_len, &out_cap, L"ONE_LAUNCHER_DISPLAY_CONTROL_FILE", g_ds.control_file);
    ds_append_kv_if_missing_w(&out_buf, &out_len, &out_cap, L"ONE_LAUNCHER_DISPLAY_STATUS_FILE", g_ds.status_file);
    ds_append_kv_if_missing_w(&out_buf, &out_len, &out_cap, L"ONE_LAUNCHER_DISPLAY_TRACE_FILE", g_ds.trace_file);
    LeaveCriticalSection(&g_ds.lock);

    if (!out_buf) {
        out_buf = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 2 * sizeof(WCHAR));
    }
    return out_buf;
}

static BOOL WINAPI hook_CreateProcessW(LPCWSTR lpApp, LPWSTR lpCmd, LPSECURITY_ATTRIBUTES lpPA, LPSECURITY_ATTRIBUTES lpTA, BOOL bInherit, DWORD dwFlags, LPVOID lpEnv, LPCWSTR lpDir, LPSTARTUPINFOW lpSI, LPPROCESS_INFORMATION lpPI)
{
    if (!g_ds.real_CreateProcessW) return FALSE;
    if (ds_is_internal_call()) {
        return g_ds.real_CreateProcessW(lpApp, lpCmd, lpPA, lpTA, bInherit, dwFlags, lpEnv, lpDir, lpSI, lpPI);
    }

    PROCESS_INFORMATION local_pi;
    memset(&local_pi, 0, sizeof(local_pi));
    LPPROCESS_INFORMATION out_pi = lpPI ? lpPI : &local_pi;
    bool caller_suspended = (dwFlags & CREATE_SUSPENDED) != 0;

    WCHAR *merged_env = ds_build_merged_child_env_w(lpEnv, dwFlags);
    LPVOID eff_env = merged_env ? (LPVOID)merged_env : lpEnv;
    DWORD eff_flags = merged_env ? (dwFlags | CREATE_UNICODE_ENVIRONMENT) : dwFlags;

    BOOL ok = g_ds.real_CreateProcessW(lpApp, lpCmd, lpPA, lpTA, bInherit, eff_flags | CREATE_SUSPENDED, eff_env, lpDir, lpSI, out_pi);
    DWORD last_err = GetLastError();
    if (merged_env) {
        HeapFree(GetProcessHeap(), 0, merged_env);
        SetLastError(last_err);
    }
    if (!ok) return FALSE;

    ds_inject_into_suspended_child(out_pi);
    if (!caller_suspended) {
        ResumeThread(out_pi->hThread);
    }
    if (!lpPI) {
        CloseHandle(local_pi.hThread);
        CloseHandle(local_pi.hProcess);
    }
    return TRUE;
}

static BOOL WINAPI hook_CreateProcessA(LPCSTR lpApp, LPSTR lpCmd, LPSECURITY_ATTRIBUTES lpPA, LPSECURITY_ATTRIBUTES lpTA, BOOL bInherit, DWORD dwFlags, LPVOID lpEnv, LPCSTR lpDir, LPSTARTUPINFOA lpSI, LPPROCESS_INFORMATION lpPI)
{
    if (!g_ds.real_CreateProcessA) return FALSE;
    if (ds_is_internal_call()) {
        return g_ds.real_CreateProcessA(lpApp, lpCmd, lpPA, lpTA, bInherit, dwFlags, lpEnv, lpDir, lpSI, lpPI);
    }

    PROCESS_INFORMATION local_pi;
    memset(&local_pi, 0, sizeof(local_pi));
    LPPROCESS_INFORMATION out_pi = lpPI ? lpPI : &local_pi;
    bool caller_suspended = (dwFlags & CREATE_SUSPENDED) != 0;

    WCHAR *merged_env = ds_build_merged_child_env_w(lpEnv, dwFlags);
    LPVOID eff_env = merged_env ? (LPVOID)merged_env : lpEnv;
    DWORD eff_flags = merged_env ? (dwFlags | CREATE_UNICODE_ENVIRONMENT) : dwFlags;

    BOOL ok = g_ds.real_CreateProcessA(lpApp, lpCmd, lpPA, lpTA, bInherit, eff_flags | CREATE_SUSPENDED, eff_env, lpDir, lpSI, out_pi);
    DWORD last_err = GetLastError();
    if (merged_env) {
        HeapFree(GetProcessHeap(), 0, merged_env);
        SetLastError(last_err);
    }
    if (!ok) return FALSE;

    ds_inject_into_suspended_child(out_pi);
    if (!caller_suspended) {
        ResumeThread(out_pi->hThread);
    }
    if (!lpPI) {
        CloseHandle(local_pi.hThread);
        CloseHandle(local_pi.hProcess);
    }
    return TRUE;
}

/* -------------------------------------------------------------------------
 * ShellExecute & ShellExecuteEx Hooks for Universal Process Chaining
 * ------------------------------------------------------------------------- */

#ifndef SEE_MASK_CLASSNAME
#define SEE_MASK_CLASSNAME      0x00000001
#endif
#ifndef SEE_MASK_CLASSKEY
#define SEE_MASK_CLASSKEY       0x00000003
#endif
#ifndef SEE_MASK_IDLIST
#define SEE_MASK_IDLIST         0x00000004
#endif
#ifndef SEE_MASK_NOCLOSEPROCESS
#define SEE_MASK_NOCLOSEPROCESS 0x00000040
#endif
#ifndef SEE_MASK_FLAG_NO_UI
#define SEE_MASK_FLAG_NO_UI     0x00000400
#endif
#ifndef SEE_MASK_NO_CONSOLE
#define SEE_MASK_NO_CONSOLE     0x00008000
#endif
#ifndef SE_ERR_FNF
#define SE_ERR_FNF              2
#endif
#ifndef SE_ERR_OOM
#define SE_ERR_OOM              8
#endif

typedef HINSTANCE (WINAPI *pfn_ShellExecuteA_t)(HWND, LPCSTR, LPCSTR, LPCSTR, LPCSTR, INT);
typedef HINSTANCE (WINAPI *pfn_ShellExecuteW_t)(HWND, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR, INT);
typedef BOOL (WINAPI *pfn_ShellExecuteExA_t)(SHELLEXECUTEINFOA *);
typedef BOOL (WINAPI *pfn_ShellExecuteExW_t)(SHELLEXECUTEINFOW *);

static pfn_ShellExecuteA_t   s_real_ShellExecuteA   = NULL;
static pfn_ShellExecuteW_t   s_real_ShellExecuteW   = NULL;
static pfn_ShellExecuteExA_t s_real_ShellExecuteExA = NULL;
static pfn_ShellExecuteExW_t s_real_ShellExecuteExW = NULL;

static void ds_ensure_shell32_loaded(bool allow_load_library)
{
    if (s_real_ShellExecuteExW) return;
    HMODULE sh32 = GetModuleHandleW(L"shell32.dll");
    if (!sh32 && allow_load_library) {
        ds_enter_internal();
        sh32 = g_ds.real_LoadLibraryW ? g_ds.real_LoadLibraryW(L"shell32.dll") : LoadLibraryW(L"shell32.dll");
        ds_leave_internal();
    }
    if (sh32 && g_ds.real_GetProcAddress) {
        s_real_ShellExecuteA   = (pfn_ShellExecuteA_t)(uintptr_t)g_ds.real_GetProcAddress(sh32, "ShellExecuteA");
        s_real_ShellExecuteW   = (pfn_ShellExecuteW_t)(uintptr_t)g_ds.real_GetProcAddress(sh32, "ShellExecuteW");
        s_real_ShellExecuteExA = (pfn_ShellExecuteExA_t)(uintptr_t)g_ds.real_GetProcAddress(sh32, "ShellExecuteExA");
        s_real_ShellExecuteExW = (pfn_ShellExecuteExW_t)(uintptr_t)g_ds.real_GetProcAddress(sh32, "ShellExecuteExW");
    }
}

static bool ds_is_batch_extension_w(const WCHAR *path)
{
    if (!path) return false;
    size_t len = wcslen(path);
    if (len < 4) return false;
    const WCHAR *ext = path + len - 4;
    return (_wcsicmp(ext, L".bat") == 0 || _wcsicmp(ext, L".cmd") == 0);
}

static bool ds_is_exe_extension_w(const WCHAR *path)
{
    if (!path) return false;
    size_t len = wcslen(path);
    if (len < 4) return false;
    const WCHAR *ext = path + len - 4;
    return (_wcsicmp(ext, L".exe") == 0 ||
            _wcsicmp(ext, L".bat") == 0 ||
            _wcsicmp(ext, L".cmd") == 0);
}

static bool ds_is_url_or_protocol_w(const WCHAR *str)
{
    if (!str || !str[0]) return false;
    if (wcsstr(str, L"://") != NULL) return true;
    /* Single-letter drive prefix `C:\` or `C:/` is a local path, not a URI scheme */
    if (((str[0] >= L'A' && str[0] <= L'Z') || (str[0] >= L'a' && str[0] <= L'z')) &&
        str[1] == L':' && (str[2] == L'\\' || str[2] == L'/' || str[2] == L'\0')) {
        return false;
    }
    const WCHAR *colon = wcschr(str, L':');
    const WCHAR *slash = wcschr(str, L'\\');
    const WCHAR *fslash = wcschr(str, L'/');
    if (colon && colon > str + 1 &&
        (!slash || colon < slash) &&
        (!fslash || colon < fslash)) {
        return true;
    }
    return false;
}

static WCHAR *ds_alloc_unquoted_w(const WCHAR *src)
{
    if (!src) return NULL;
    while (*src == L' ' || *src == L'\t') src++;
    size_t len = wcslen(src);
    WCHAR *buf = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (len + 1) * sizeof(WCHAR));
    if (!buf) return NULL;
    size_t dst = 0;
    for (size_t i = 0; i < len; i++) {
        if (src[i] != L'"') {
            buf[dst++] = src[i];
        }
    }
    while (dst > 0 && (buf[dst - 1] == L' ' || buf[dst - 1] == L'\t')) {
        dst--;
    }
    buf[dst] = L'\0';
    return buf;
}

static WCHAR *ds_resolve_shell_exec_target_w(const WCHAR *unquoted, const WCHAR *work_dir, bool *out_had_exe_ext)
{
    if (out_had_exe_ext) *out_had_exe_ext = false;
    if (!unquoted || !unquoted[0] || ds_is_url_or_protocol_w(unquoted)) {
        return NULL;
    }

    bool has_exe_ext = ds_is_exe_extension_w(unquoted);
    if (out_had_exe_ext) *out_had_exe_ext = has_exe_ext;

    const WCHAR *base = ds_basename_w(unquoted);
    bool has_any_dot = (wcschr(base, L'.') != NULL);
    if (has_any_dot && !has_exe_ext) {
        return NULL;
    }

    const WCHAR *def_ext = has_exe_ext ? NULL : L".exe";
    bool is_rooted = (
        (unquoted[0] == L'\\' || unquoted[0] == L'/') ||
        (((unquoted[0] >= L'A' && unquoted[0] <= L'Z') || (unquoted[0] >= L'a' && unquoted[0] <= L'z')) &&
         unquoted[1] == L':')
    );

    if (!is_rooted && work_dir && work_dir[0]) {
        DWORD need = SearchPathW(work_dir, unquoted, def_ext, 0, NULL, NULL);
        if (need > 0) {
            WCHAR *res = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, ((size_t)need + 2) * sizeof(WCHAR));
            if (res && SearchPathW(work_dir, unquoted, def_ext, need + 1, res, NULL) > 0 && ds_is_exe_extension_w(res)) {
                return res;
            }
            if (res) HeapFree(GetProcessHeap(), 0, res);
        }
    }

    DWORD need = SearchPathW(NULL, unquoted, def_ext, 0, NULL, NULL);
    if (need > 0) {
        WCHAR *res = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, ((size_t)need + 2) * sizeof(WCHAR));
        if (res && SearchPathW(NULL, unquoted, def_ext, need + 1, res, NULL) > 0 && ds_is_exe_extension_w(res)) {
            return res;
        }
        if (res) HeapFree(GetProcessHeap(), 0, res);
    }

    if (has_exe_ext) {
        DWORD attrs = GetFileAttributesW(unquoted);
        if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0) {
            size_t n = wcslen(unquoted);
            WCHAR *copy = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (n + 1) * sizeof(WCHAR));
            if (copy) {
                memcpy(copy, unquoted, n * sizeof(WCHAR));
                copy[n] = L'\0';
                return copy;
            }
        }
    }

    return NULL;
}

static BOOL WINAPI hook_ShellExecuteExW(SHELLEXECUTEINFOW *pExecInfo)
{
    ds_ensure_shell32_loaded(!ds_is_internal_call());
    if (!pExecInfo || pExecInfo->cbSize < sizeof(SHELLEXECUTEINFOW)) {
        return s_real_ShellExecuteExW ? s_real_ShellExecuteExW(pExecInfo) : FALSE;
    }
    if (ds_is_internal_call()) {
        return s_real_ShellExecuteExW ? s_real_ShellExecuteExW(pExecInfo) : FALSE;
    }

    if ((pExecInfo->fMask & (SEE_MASK_IDLIST | SEE_MASK_CLASSNAME | SEE_MASK_CLASSKEY)) != 0 &&
        (!pExecInfo->lpFile || !ds_is_exe_extension_w(pExecInfo->lpFile))) {
        return s_real_ShellExecuteExW ? s_real_ShellExecuteExW(pExecInfo) : FALSE;
    }

    const WCHAR *verb = pExecInfo->lpVerb;
    bool is_open_verb = (!verb || !verb[0] || _wcsicmp(verb, L"open") == 0 || _wcsicmp(verb, L"runas") == 0);
    const WCHAR *file = pExecInfo->lpFile;

    if (is_open_verb && file && file[0]) {
        bool suppress_ui = (pExecInfo->fMask & SEE_MASK_FLAG_NO_UI) != 0;
        UINT prev_err_mode = suppress_ui ? SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX) : 0;

        WCHAR *unquoted = ds_alloc_unquoted_w(file);
        const WCHAR *work_dir = (pExecInfo->lpDirectory && pExecInfo->lpDirectory[0]) ? pExecInfo->lpDirectory : NULL;
        bool had_exe_ext = false;
        WCHAR *resolved_exe = ds_resolve_shell_exec_target_w(unquoted, work_dir, &had_exe_ext);

        if (suppress_ui) {
            SetErrorMode(prev_err_mode);
        }

        if (resolved_exe) {
            const WCHAR *params = pExecInfo->lpParameters ? pExecInfo->lpParameters : L"";
            bool is_batch = ds_is_batch_extension_w(resolved_exe);
            WCHAR comspec[MAX_PATH] = { 0 };
            if (is_batch) {
                DWORD cn = GetEnvironmentVariableW(L"ComSpec", comspec, MAX_PATH);
                if (cn == 0 || cn >= MAX_PATH) {
                    UINT sn = GetSystemDirectoryW(comspec, MAX_PATH - 16);
                    if (sn > 0 && sn < MAX_PATH - 16) {
                        wcscat(comspec, L"\\cmd.exe");
                    } else {
                        wcscpy(comspec, L"C:\\windows\\system32\\cmd.exe");
                    }
                }
            }
            size_t exe_len = wcslen(resolved_exe);
            size_t param_len = wcslen(params);
            size_t com_len = is_batch ? wcslen(comspec) : 0;
            size_t max_cmd = com_len + exe_len + param_len + 32;
            WCHAR *cmdline = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, max_cmd * sizeof(WCHAR));
            if (cmdline) {
                if (is_batch) {
                    if (param_len > 0) {
                        _snwprintf(cmdline, max_cmd - 1, L"\"%ls\" /s /c \"\"%ls\" %ls\"", comspec, resolved_exe, params);
                    } else {
                        _snwprintf(cmdline, max_cmd - 1, L"\"%ls\" /s /c \"\"%ls\"\"", comspec, resolved_exe);
                    }
                } else {
                    if (param_len > 0) {
                        _snwprintf(cmdline, max_cmd - 1, L"\"%ls\" %ls", resolved_exe, params);
                    } else {
                        _snwprintf(cmdline, max_cmd - 1, L"\"%ls\"", resolved_exe);
                    }
                }
                cmdline[max_cmd - 1] = L'\0';

                STARTUPINFOW si;
                PROCESS_INFORMATION pi;
                memset(&si, 0, sizeof(si));
                memset(&pi, 0, sizeof(pi));
                si.cb = sizeof(si);
                if (pExecInfo->nShow != 0) {
                    si.dwFlags |= STARTF_USESHOWWINDOW;
                    si.wShowWindow = (WORD)pExecInfo->nShow;
                }

                DWORD dwFlags = 0;
                if (pExecInfo->fMask & SEE_MASK_NO_CONSOLE) {
                    dwFlags |= CREATE_NO_WINDOW;
                }

                BOOL ok = hook_CreateProcessW(
                    is_batch ? comspec : resolved_exe,
                    cmdline,
                    NULL,
                    NULL,
                    FALSE,
                    dwFlags,
                    NULL,
                    work_dir,
                    &si,
                    &pi
                );
                DWORD create_err = GetLastError();
                HeapFree(GetProcessHeap(), 0, cmdline);
                HeapFree(GetProcessHeap(), 0, resolved_exe);
                if (unquoted) HeapFree(GetProcessHeap(), 0, unquoted);

                if (ok) {
                    pExecInfo->hInstApp = (HINSTANCE)(intptr_t)42;
                    if (pExecInfo->fMask & SEE_MASK_NOCLOSEPROCESS) {
                        pExecInfo->hProcess = pi.hProcess;
                        CloseHandle(pi.hThread);
                    } else {
                        CloseHandle(pi.hThread);
                        CloseHandle(pi.hProcess);
                    }
                    return TRUE;
                }
                pExecInfo->hInstApp = (HINSTANCE)(intptr_t)SE_ERR_FNF;
                SetLastError(create_err ? create_err : ERROR_FILE_NOT_FOUND);
                return FALSE;
            }
            HeapFree(GetProcessHeap(), 0, resolved_exe);
            if (unquoted) HeapFree(GetProcessHeap(), 0, unquoted);
            pExecInfo->hInstApp = (HINSTANCE)(intptr_t)SE_ERR_OOM;
            SetLastError(ERROR_NOT_ENOUGH_MEMORY);
            return FALSE;
        }

        bool url_target = ds_is_url_or_protocol_w(unquoted);
        if (unquoted) HeapFree(GetProcessHeap(), 0, unquoted);

        /* Never fall through to CrossOver `cxnativeopen` for missing `.exe/.bat/.cmd` paths */
        if (had_exe_ext && !url_target) {
            pExecInfo->hInstApp = (HINSTANCE)(intptr_t)SE_ERR_FNF;
            SetLastError(ERROR_FILE_NOT_FOUND);
            return FALSE;
        }
    }

    if (s_real_ShellExecuteExW) {
        return s_real_ShellExecuteExW(pExecInfo);
    }
    return FALSE;
}

static WCHAR *ds_alloc_wide_from_acp(const char *src)
{
    if (!src) return NULL;
    int need = MultiByteToWideChar(CP_ACP, 0, src, -1, NULL, 0);
    if (need <= 0) return NULL;
    WCHAR *buf = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (size_t)need * sizeof(WCHAR));
    if (!buf) return NULL;
    MultiByteToWideChar(CP_ACP, 0, src, -1, buf, need);
    return buf;
}

static BOOL WINAPI hook_ShellExecuteExA(SHELLEXECUTEINFOA *pExecInfo)
{
    ds_ensure_shell32_loaded(!ds_is_internal_call());
    if (!pExecInfo || pExecInfo->cbSize < sizeof(SHELLEXECUTEINFOA)) {
        return s_real_ShellExecuteExA ? s_real_ShellExecuteExA(pExecInfo) : FALSE;
    }
    if (ds_is_internal_call()) {
        return s_real_ShellExecuteExA ? s_real_ShellExecuteExA(pExecInfo) : FALSE;
    }
    if ((pExecInfo->fMask & (SEE_MASK_IDLIST | SEE_MASK_CLASSNAME | SEE_MASK_CLASSKEY)) != 0 &&
        !pExecInfo->lpFile) {
        return s_real_ShellExecuteExA ? s_real_ShellExecuteExA(pExecInfo) : FALSE;
    }

    WCHAR *wFile = ds_alloc_wide_from_acp(pExecInfo->lpFile);
    WCHAR *wVerb = ds_alloc_wide_from_acp(pExecInfo->lpVerb);
    WCHAR *wParams = ds_alloc_wide_from_acp(pExecInfo->lpParameters);
    WCHAR *wDir = ds_alloc_wide_from_acp(pExecInfo->lpDirectory);

    SHELLEXECUTEINFOW seiW;
    memset(&seiW, 0, sizeof(seiW));
    seiW.cbSize = sizeof(seiW);
    seiW.fMask = pExecInfo->fMask;
    seiW.hwnd = pExecInfo->hwnd;
    seiW.lpVerb = wVerb;
    seiW.lpFile = wFile;
    seiW.lpParameters = wParams;
    seiW.lpDirectory = wDir;
    seiW.nShow = pExecInfo->nShow;

    BOOL ok = hook_ShellExecuteExW(&seiW);
    DWORD last_err = GetLastError();

    if (wFile) HeapFree(GetProcessHeap(), 0, wFile);
    if (wVerb) HeapFree(GetProcessHeap(), 0, wVerb);
    if (wParams) HeapFree(GetProcessHeap(), 0, wParams);
    if (wDir) HeapFree(GetProcessHeap(), 0, wDir);

    pExecInfo->hInstApp = seiW.hInstApp;
    if (ok) {
        if (pExecInfo->fMask & SEE_MASK_NOCLOSEPROCESS) {
            pExecInfo->hProcess = seiW.hProcess;
        }
        return TRUE;
    }

    SetLastError(last_err);
    return FALSE;
}

static HINSTANCE WINAPI hook_ShellExecuteW(HWND hwnd, LPCWSTR lpOperation, LPCWSTR lpFile, LPCWSTR lpParameters, LPCWSTR lpDirectory, INT nShowCmd)
{
    SHELLEXECUTEINFOW sei;
    memset(&sei, 0, sizeof(sei));
    sei.cbSize = sizeof(sei);
    sei.fMask = SEE_MASK_FLAG_NO_UI;
    sei.hwnd = hwnd;
    sei.lpVerb = lpOperation;
    sei.lpFile = lpFile;
    sei.lpParameters = lpParameters;
    sei.lpDirectory = lpDirectory;
    sei.nShow = nShowCmd;
    if (hook_ShellExecuteExW(&sei)) {
        return sei.hInstApp ? sei.hInstApp : (HINSTANCE)(intptr_t)42;
    }
    return sei.hInstApp ? sei.hInstApp : (HINSTANCE)(intptr_t)SE_ERR_FNF;
}

static HINSTANCE WINAPI hook_ShellExecuteA(HWND hwnd, LPCSTR lpOperation, LPCSTR lpFile, LPCSTR lpParameters, LPCSTR lpDirectory, INT nShowCmd)
{
    SHELLEXECUTEINFOA sei;
    memset(&sei, 0, sizeof(sei));
    sei.cbSize = sizeof(sei);
    sei.fMask = SEE_MASK_FLAG_NO_UI;
    sei.hwnd = hwnd;
    sei.lpVerb = lpOperation;
    sei.lpFile = lpFile;
    sei.lpParameters = lpParameters;
    sei.lpDirectory = lpDirectory;
    sei.nShow = nShowCmd;
    if (hook_ShellExecuteExA(&sei)) {
        return sei.hInstApp ? sei.hInstApp : (HINSTANCE)(intptr_t)42;
    }
    return sei.hInstApp ? sei.hInstApp : (HINSTANCE)(intptr_t)SE_ERR_FNF;
}

/* -------------------------------------------------------------------------
 * PE IAT Patching & Dynamic `LoadLibrary` / `GetProcAddress` Interception
 * ------------------------------------------------------------------------- */

static FARPROC WINAPI hook_GetProcAddress(HMODULE hModule, LPCSTR lpProcName);
static HMODULE WINAPI hook_LoadLibraryA(LPCSTR lpLibFileName);
static HMODULE WINAPI hook_LoadLibraryW(LPCWSTR lpLibFileName);
static HMODULE WINAPI hook_LoadLibraryExA(LPCSTR lpLibFileName, HANDLE hFile, DWORD dwFlags);
static HMODULE WINAPI hook_LoadLibraryExW(LPCWSTR lpLibFileName, HANDLE hFile, DWORD dwFlags);

static void *ds_lookup_hook_by_name(const char *func_name, bool allow_loader_hooks)
{
    if (!func_name || ((uintptr_t)func_name >> 16) == 0) {
        return NULL;
    }

    if (allow_loader_hooks) {
        if (strcmp(func_name, "LoadLibraryA") == 0) return (void *)(uintptr_t)hook_LoadLibraryA;
        if (strcmp(func_name, "LoadLibraryW") == 0) return (void *)(uintptr_t)hook_LoadLibraryW;
        if (strcmp(func_name, "LoadLibraryExA") == 0) return (void *)(uintptr_t)hook_LoadLibraryExA;
        if (strcmp(func_name, "LoadLibraryExW") == 0) return (void *)(uintptr_t)hook_LoadLibraryExW;
        if (strcmp(func_name, "CreateProcessA") == 0) return (void *)(uintptr_t)hook_CreateProcessA;
        if (strcmp(func_name, "CreateProcessW") == 0) return (void *)(uintptr_t)hook_CreateProcessW;
        if (strcmp(func_name, "ShellExecuteA") == 0) return (void *)(uintptr_t)hook_ShellExecuteA;
        if (strcmp(func_name, "ShellExecuteW") == 0) return (void *)(uintptr_t)hook_ShellExecuteW;
        if (strcmp(func_name, "ShellExecuteExA") == 0) return (void *)(uintptr_t)hook_ShellExecuteExA;
        if (strcmp(func_name, "ShellExecuteExW") == 0) return (void *)(uintptr_t)hook_ShellExecuteExW;
    }
    if (strcmp(func_name, "GetProcAddress") == 0) return (void *)(uintptr_t)hook_GetProcAddress;

    if (strcmp(func_name, "EnumDisplaySettingsA") == 0) return (void *)(uintptr_t)hook_EnumDisplaySettingsA;
    if (strcmp(func_name, "EnumDisplaySettingsW") == 0) return (void *)(uintptr_t)hook_EnumDisplaySettingsW;
    if (strcmp(func_name, "EnumDisplaySettingsExA") == 0) return (void *)(uintptr_t)hook_EnumDisplaySettingsExA;
    if (strcmp(func_name, "EnumDisplaySettingsExW") == 0) return (void *)(uintptr_t)hook_EnumDisplaySettingsExW;
    if (strcmp(func_name, "ChangeDisplaySettingsA") == 0) return (void *)(uintptr_t)hook_ChangeDisplaySettingsA;
    if (strcmp(func_name, "ChangeDisplaySettingsW") == 0) return (void *)(uintptr_t)hook_ChangeDisplaySettingsW;
    if (strcmp(func_name, "ChangeDisplaySettingsExA") == 0) return (void *)(uintptr_t)hook_ChangeDisplaySettingsExA;
    if (strcmp(func_name, "ChangeDisplaySettingsExW") == 0) return (void *)(uintptr_t)hook_ChangeDisplaySettingsExW;
    if (strcmp(func_name, "GetSystemMetrics") == 0) return (void *)(uintptr_t)hook_GetSystemMetrics;

    if (strcmp(func_name, "CreateWindowExA") == 0) return (void *)(uintptr_t)hook_CreateWindowExA;
    if (strcmp(func_name, "CreateWindowExW") == 0) return (void *)(uintptr_t)hook_CreateWindowExW;
    if (strcmp(func_name, "ShowWindow") == 0) return (void *)(uintptr_t)hook_ShowWindow;
    if (strcmp(func_name, "ShowWindowAsync") == 0) return (void *)(uintptr_t)hook_ShowWindowAsync;
    if (strcmp(func_name, "SetWindowPlacement") == 0) return (void *)(uintptr_t)hook_SetWindowPlacement;
    if (strcmp(func_name, "SetWindowPos") == 0) return (void *)(uintptr_t)hook_SetWindowPos;
    if (strcmp(func_name, "MoveWindow") == 0) return (void *)(uintptr_t)hook_MoveWindow;
    if (strcmp(func_name, "GetWindowLongA") == 0) return (void *)(uintptr_t)hook_GetWindowLongA;
    if (strcmp(func_name, "GetWindowLongW") == 0) return (void *)(uintptr_t)hook_GetWindowLongW;
    if (strcmp(func_name, "SetWindowLongA") == 0) return (void *)(uintptr_t)hook_SetWindowLongA;
    if (strcmp(func_name, "SetWindowLongW") == 0) return (void *)(uintptr_t)hook_SetWindowLongW;
#if defined(_WIN64)
    if (strcmp(func_name, "GetWindowLongPtrA") == 0) return (void *)(uintptr_t)hook_GetWindowLongPtrA;
    if (strcmp(func_name, "GetWindowLongPtrW") == 0) return (void *)(uintptr_t)hook_GetWindowLongPtrW;
    if (strcmp(func_name, "SetWindowLongPtrA") == 0) return (void *)(uintptr_t)hook_SetWindowLongPtrA;
    if (strcmp(func_name, "SetWindowLongPtrW") == 0) return (void *)(uintptr_t)hook_SetWindowLongPtrW;
#endif
    if (strcmp(func_name, "GetClientRect") == 0) return (void *)(uintptr_t)hook_GetClientRect;
    if (strcmp(func_name, "GetWindowRect") == 0) return (void *)(uintptr_t)hook_GetWindowRect;
    if (strcmp(func_name, "GetMonitorInfoA") == 0) return (void *)(uintptr_t)hook_GetMonitorInfoA;
    if (strcmp(func_name, "GetMonitorInfoW") == 0) return (void *)(uintptr_t)hook_GetMonitorInfoW;

    if (strcmp(func_name, "GetCursorPos") == 0) return (void *)(uintptr_t)hook_GetCursorPos;
    if (strcmp(func_name, "SetCursorPos") == 0) return (void *)(uintptr_t)hook_SetCursorPos;
    if (strcmp(func_name, "ClipCursor") == 0) return (void *)(uintptr_t)hook_ClipCursor;
    if (strcmp(func_name, "GetClipCursor") == 0) return (void *)(uintptr_t)hook_GetClipCursor;
    if (strcmp(func_name, "GetMessagePos") == 0) return (void *)(uintptr_t)hook_GetMessagePos;
    if (strcmp(func_name, "GetRawInputData") == 0) return (void *)(uintptr_t)hook_GetRawInputData;
    if (strcmp(func_name, "GetRawInputBuffer") == 0) return (void *)(uintptr_t)hook_GetRawInputBuffer;
    if (strcmp(func_name, "RegisterRawInputDevices") == 0) return (void *)(uintptr_t)hook_RegisterRawInputDevices;
    if (strcmp(func_name, "ScreenToClient") == 0) return (void *)(uintptr_t)hook_ScreenToClient;
    if (strcmp(func_name, "ClientToScreen") == 0) return (void *)(uintptr_t)hook_ClientToScreen;
    if (strcmp(func_name, "MapWindowPoints") == 0) return (void *)(uintptr_t)hook_MapWindowPoints;
    if (strcmp(func_name, "WindowFromPoint") == 0) return (void *)(uintptr_t)hook_WindowFromPoint;
    if (strcmp(func_name, "ReleaseDC") == 0) return (void *)(uintptr_t)hook_ReleaseDC;

    if (strcmp(func_name, "GetDeviceCaps") == 0) return (void *)(uintptr_t)hook_GetDeviceCaps;
    if (strcmp(func_name, "DeleteDC") == 0) return (void *)(uintptr_t)hook_DeleteDC;
    if (strcmp(func_name, "ChoosePixelFormat") == 0) return (void *)(uintptr_t)hook_ChoosePixelFormat;
    if (strcmp(func_name, "DescribePixelFormat") == 0) return (void *)(uintptr_t)hook_DescribePixelFormat;
    if (strcmp(func_name, "GetPixelFormat") == 0) return (void *)(uintptr_t)hook_GetPixelFormat;
    if (strcmp(func_name, "SetPixelFormat") == 0) return (void *)(uintptr_t)hook_SetPixelFormat;
    if (strcmp(func_name, "BitBlt") == 0) return (void *)(uintptr_t)hook_BitBlt;
    if (strcmp(func_name, "StretchBlt") == 0) return (void *)(uintptr_t)hook_StretchBlt;
    if (strcmp(func_name, "SetDIBitsToDevice") == 0) return (void *)(uintptr_t)hook_SetDIBitsToDevice;
    if (strcmp(func_name, "StretchDIBits") == 0) return (void *)(uintptr_t)hook_StretchDIBits;
    if (strcmp(func_name, "SwapBuffers") == 0) return (void *)(uintptr_t)hook_SwapBuffers;
    if (g_ds.is_wine) {
        if (strcmp(func_name, "D3DKMTEscape") == 0) return (void *)(uintptr_t)hook_D3DKMTEscape;
        if (strcmp(func_name, "NtGdiDdDDIEscape") == 0) return (void *)(uintptr_t)hook_D3DKMTEscape;
    }

    if (strcmp(func_name, "wglCreateContext") == 0) return (void *)(uintptr_t)hook_wglCreateContext;
    if (strcmp(func_name, "wglCreateLayerContext") == 0) return (void *)(uintptr_t)hook_wglCreateLayerContext;
    if (strcmp(func_name, "wglGetCurrentDC") == 0) return (void *)(uintptr_t)hook_wglGetCurrentDC;
    if (strcmp(func_name, "wglChoosePixelFormat") == 0) return (void *)(uintptr_t)hook_wglChoosePixelFormat;
    if (strcmp(func_name, "wglDescribePixelFormat") == 0) return (void *)(uintptr_t)hook_wglDescribePixelFormat;
    if (strcmp(func_name, "wglGetPixelFormat") == 0) return (void *)(uintptr_t)hook_wglGetPixelFormat;
    if (strcmp(func_name, "wglSetPixelFormat") == 0) return (void *)(uintptr_t)hook_wglSetPixelFormat;
    if (strcmp(func_name, "wglMakeCurrent") == 0) return (void *)(uintptr_t)hook_wglMakeCurrent;
    if (strcmp(func_name, "wglDeleteContext") == 0) return (void *)(uintptr_t)hook_wglDeleteContext;
    if (strcmp(func_name, "wglSwapBuffers") == 0) return (void *)(uintptr_t)hook_wglSwapBuffers;
    if (strcmp(func_name, "wglGetProcAddress") == 0) return (void *)(uintptr_t)hook_wglGetProcAddress;
    if (strcmp(func_name, "glDrawBuffer") == 0) return (void *)(uintptr_t)hook_glDrawBuffer;
    if (strcmp(func_name, "glReadBuffer") == 0) return (void *)(uintptr_t)hook_glReadBuffer;
    if (strcmp(func_name, "glGetIntegerv") == 0) return (void *)(uintptr_t)hook_glGetIntegerv;

    return NULL;
}

static void *ds_lookup_hook_by_real_ptr(const void *fn_ptr, bool allow_loader_hooks)
{
    if (!fn_ptr) return NULL;

    if (allow_loader_hooks) {
        if (fn_ptr == (const void *)(uintptr_t)g_ds.real_LoadLibraryA) return (void *)(uintptr_t)hook_LoadLibraryA;
        if (fn_ptr == (const void *)(uintptr_t)g_ds.real_LoadLibraryW) return (void *)(uintptr_t)hook_LoadLibraryW;
        if (fn_ptr == (const void *)(uintptr_t)g_ds.real_LoadLibraryExA) return (void *)(uintptr_t)hook_LoadLibraryExA;
        if (fn_ptr == (const void *)(uintptr_t)g_ds.real_LoadLibraryExW) return (void *)(uintptr_t)hook_LoadLibraryExW;
        if (fn_ptr == (const void *)(uintptr_t)g_ds.real_CreateProcessA) return (void *)(uintptr_t)hook_CreateProcessA;
        if (fn_ptr == (const void *)(uintptr_t)g_ds.real_CreateProcessW) return (void *)(uintptr_t)hook_CreateProcessW;
        if (fn_ptr == (const void *)(uintptr_t)s_real_ShellExecuteA) return (void *)(uintptr_t)hook_ShellExecuteA;
        if (fn_ptr == (const void *)(uintptr_t)s_real_ShellExecuteW) return (void *)(uintptr_t)hook_ShellExecuteW;
        if (fn_ptr == (const void *)(uintptr_t)s_real_ShellExecuteExA) return (void *)(uintptr_t)hook_ShellExecuteExA;
        if (fn_ptr == (const void *)(uintptr_t)s_real_ShellExecuteExW) return (void *)(uintptr_t)hook_ShellExecuteExW;
    }
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetProcAddress) return (void *)(uintptr_t)hook_GetProcAddress;

    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_EnumDisplaySettingsA) return (void *)(uintptr_t)hook_EnumDisplaySettingsA;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_EnumDisplaySettingsW) return (void *)(uintptr_t)hook_EnumDisplaySettingsW;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_EnumDisplaySettingsExA) return (void *)(uintptr_t)hook_EnumDisplaySettingsExA;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_EnumDisplaySettingsExW) return (void *)(uintptr_t)hook_EnumDisplaySettingsExW;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_ChangeDisplaySettingsA) return (void *)(uintptr_t)hook_ChangeDisplaySettingsA;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_ChangeDisplaySettingsW) return (void *)(uintptr_t)hook_ChangeDisplaySettingsW;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_ChangeDisplaySettingsExA) return (void *)(uintptr_t)hook_ChangeDisplaySettingsExA;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_ChangeDisplaySettingsExW) return (void *)(uintptr_t)hook_ChangeDisplaySettingsExW;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetSystemMetrics) return (void *)(uintptr_t)hook_GetSystemMetrics;

    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_CreateWindowExA) return (void *)(uintptr_t)hook_CreateWindowExA;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_CreateWindowExW) return (void *)(uintptr_t)hook_CreateWindowExW;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_ShowWindow) return (void *)(uintptr_t)hook_ShowWindow;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_ShowWindowAsync) return (void *)(uintptr_t)hook_ShowWindowAsync;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_SetWindowPlacement) return (void *)(uintptr_t)hook_SetWindowPlacement;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_SetWindowPos) return (void *)(uintptr_t)hook_SetWindowPos;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_MoveWindow) return (void *)(uintptr_t)hook_MoveWindow;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetWindowLongA) return (void *)(uintptr_t)hook_GetWindowLongA;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetWindowLongW) return (void *)(uintptr_t)hook_GetWindowLongW;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_SetWindowLongA) return (void *)(uintptr_t)hook_SetWindowLongA;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_SetWindowLongW) return (void *)(uintptr_t)hook_SetWindowLongW;
#if defined(_WIN64)
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetWindowLongPtrA) return (void *)(uintptr_t)hook_GetWindowLongPtrA;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetWindowLongPtrW) return (void *)(uintptr_t)hook_GetWindowLongPtrW;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_SetWindowLongPtrA) return (void *)(uintptr_t)hook_SetWindowLongPtrA;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_SetWindowLongPtrW) return (void *)(uintptr_t)hook_SetWindowLongPtrW;
#endif
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetClientRect) return (void *)(uintptr_t)hook_GetClientRect;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetWindowRect) return (void *)(uintptr_t)hook_GetWindowRect;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetMonitorInfoA) return (void *)(uintptr_t)hook_GetMonitorInfoA;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetMonitorInfoW) return (void *)(uintptr_t)hook_GetMonitorInfoW;

    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetCursorPos) return (void *)(uintptr_t)hook_GetCursorPos;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_SetCursorPos) return (void *)(uintptr_t)hook_SetCursorPos;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_ClipCursor) return (void *)(uintptr_t)hook_ClipCursor;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetClipCursor) return (void *)(uintptr_t)hook_GetClipCursor;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetMessagePos) return (void *)(uintptr_t)hook_GetMessagePos;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetRawInputData) return (void *)(uintptr_t)hook_GetRawInputData;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetRawInputBuffer) return (void *)(uintptr_t)hook_GetRawInputBuffer;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_RegisterRawInputDevices) return (void *)(uintptr_t)hook_RegisterRawInputDevices;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_ScreenToClient) return (void *)(uintptr_t)hook_ScreenToClient;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_ClientToScreen) return (void *)(uintptr_t)hook_ClientToScreen;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_MapWindowPoints) return (void *)(uintptr_t)hook_MapWindowPoints;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_WindowFromPoint) return (void *)(uintptr_t)hook_WindowFromPoint;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_ReleaseDC) return (void *)(uintptr_t)hook_ReleaseDC;

    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetDeviceCaps) return (void *)(uintptr_t)hook_GetDeviceCaps;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_DeleteDC) return (void *)(uintptr_t)hook_DeleteDC;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_ChoosePixelFormat) return (void *)(uintptr_t)hook_ChoosePixelFormat;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_DescribePixelFormat) return (void *)(uintptr_t)hook_DescribePixelFormat;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_GetPixelFormat) return (void *)(uintptr_t)hook_GetPixelFormat;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_SetPixelFormat) return (void *)(uintptr_t)hook_SetPixelFormat;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_BitBlt) return (void *)(uintptr_t)hook_BitBlt;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_StretchBlt) return (void *)(uintptr_t)hook_StretchBlt;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_SetDIBitsToDevice) return (void *)(uintptr_t)hook_SetDIBitsToDevice;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_StretchDIBits) return (void *)(uintptr_t)hook_StretchDIBits;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_SwapBuffers) return (void *)(uintptr_t)hook_SwapBuffers;
    if (g_ds.is_wine) {
        if (g_ds.real_D3DKMTEscape && fn_ptr == (const void *)(uintptr_t)g_ds.real_D3DKMTEscape) return (void *)(uintptr_t)hook_D3DKMTEscape;
        if (g_ds.real_NtGdiDdDDIEscape && fn_ptr == (const void *)(uintptr_t)g_ds.real_NtGdiDdDDIEscape) return (void *)(uintptr_t)hook_D3DKMTEscape;
    }

    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_wglCreateContext) return (void *)(uintptr_t)hook_wglCreateContext;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_wglCreateLayerContext) return (void *)(uintptr_t)hook_wglCreateLayerContext;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_wglGetCurrentDC) return (void *)(uintptr_t)hook_wglGetCurrentDC;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_wglChoosePixelFormat) return (void *)(uintptr_t)hook_wglChoosePixelFormat;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_wglDescribePixelFormat) return (void *)(uintptr_t)hook_wglDescribePixelFormat;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_wglGetPixelFormat) return (void *)(uintptr_t)hook_wglGetPixelFormat;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_wglSetPixelFormat) return (void *)(uintptr_t)hook_wglSetPixelFormat;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_wglMakeCurrent) return (void *)(uintptr_t)hook_wglMakeCurrent;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_wglDeleteContext) return (void *)(uintptr_t)hook_wglDeleteContext;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_wglSwapBuffers) return (void *)(uintptr_t)hook_wglSwapBuffers;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_wglGetProcAddress) return (void *)(uintptr_t)hook_wglGetProcAddress;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_glDrawBuffer) return (void *)(uintptr_t)hook_glDrawBuffer;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_glReadBuffer) return (void *)(uintptr_t)hook_glReadBuffer;
    if (fn_ptr == (const void *)(uintptr_t)g_ds.real_glGetIntegerv) return (void *)(uintptr_t)hook_glGetIntegerv;

    return NULL;
}

static bool ds_is_nul_terminated_within(const char *s, size_t max_bytes)
{
    if (!s || max_bytes == 0) return false;
    for (size_t i = 0; i < max_bytes; i++) {
        if (s[i] == '\0') return true;
    }
    return false;
}

static void ds_resolve_loaded_system_apis(void);

static void ds_patch_single_module_iat(HMODULE hmod)
{
    if (!hmod || hmod == g_ds.self_hmod) return;

    WCHAR mod_path[MAX_PATH] = { 0 };
    if (GetModuleFileNameW(hmod, mod_path, MAX_PATH - 1) == 0) return;
    const WCHAR *base = ds_basename_w(mod_path);

    bool mod_state_changed = false;
    if (_wcsicmp(base, L"ddraw.dll") == 0) {
        if (!g_ds.ddraw_loaded || !g_ds.legacy_d3d_loaded) {
            g_ds.ddraw_loaded = true;
            g_ds.legacy_d3d_loaded = true;
            mod_state_changed = true;
        }
    } else if (_wcsicmp(base, L"d3d8.dll") == 0 || _wcsicmp(base, L"d3d9.dll") == 0) {
        if (!g_ds.d3d8_or_9_loaded || !g_ds.legacy_d3d_loaded) {
            g_ds.d3d8_or_9_loaded = true;
            g_ds.legacy_d3d_loaded = true;
            mod_state_changed = true;
        }
    } else if (_wcsicmp(base, L"d3d10.dll") == 0 ||
               _wcsicmp(base, L"d3d10_1.dll") == 0 ||
               _wcsicmp(base, L"d3d10core.dll") == 0 ||
               _wcsicmp(base, L"d3d11.dll") == 0 ||
               _wcsicmp(base, L"d3d12.dll") == 0 ||
               _wcsicmp(base, L"d3d12core.dll") == 0 ||
               _wcsicmp(base, L"vulkan-1.dll") == 0 ||
               _wcsicmp(base, L"winevulkan.dll") == 0 ||
               _wcsicmp(base, L"d3dmetal.dll") == 0 ||
               _wcsicmp(base, L"winemetal.dll") == 0) {
        if (!g_ds.modern_gfx_loaded) {
            g_ds.modern_gfx_loaded = true;
            mod_state_changed = true;
        }
    }

    if (mod_state_changed && g_ds.lock_initialized) {
        EnterCriticalSection(&g_ds.lock);
        bool need_restore = ds_recompute_modern_passthrough_locked();
        LeaveCriticalSection(&g_ds.lock);
        if (need_restore) {
            ds_request_apply_presentation();
            ds_write_status_file();
        }
    }

    if (ds_should_skip_iat_patch_module(base)) return;

    bool is_com_loader_only_mod = (
        _wcsicmp(base, L"ole32.dll") == 0 ||
        _wcsicmp(base, L"combase.dll") == 0
    );
    bool is_wine_gfx_mod = (
        _wcsicmp(base, L"wined3d.dll") == 0 ||
        _wcsicmp(base, L"ddraw.dll") == 0 ||
        _wcsicmp(base, L"d3d8.dll") == 0 ||
        _wcsicmp(base, L"d3d9.dll") == 0 ||
        _wcsicmp(base, L"dxgi.dll") == 0
    );

    uint8_t *img = (uint8_t *)hmod;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)img;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew <= 0 || dos->e_lfanew > 0x1000) return;

    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(img + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return;

    size_t size_of_image = (size_t)nt->OptionalHeader.SizeOfImage;
    if (size_of_image < 512) return;

    IMAGE_DATA_DIRECTORY imp_dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (imp_dir.VirtualAddress == 0 || imp_dir.Size == 0) return;
    if ((size_t)imp_dir.VirtualAddress >= size_of_image ||
        (size_t)imp_dir.VirtualAddress + sizeof(IMAGE_IMPORT_DESCRIPTOR) > size_of_image) {
        return;
    }

    size_t desc_off = (size_t)imp_dir.VirtualAddress;
    for (; desc_off + sizeof(IMAGE_IMPORT_DESCRIPTOR) <= size_of_image; desc_off += sizeof(IMAGE_IMPORT_DESCRIPTOR)) {
        IMAGE_IMPORT_DESCRIPTOR *desc = (IMAGE_IMPORT_DESCRIPTOR *)(img + desc_off);
        if (desc->Name == 0 && desc->FirstThunk == 0) break;
        if (desc->Name == 0 || (size_t)desc->Name >= size_of_image) continue;
        if (desc->FirstThunk == 0 || (size_t)desc->FirstThunk + sizeof(IMAGE_THUNK_DATA) > size_of_image) continue;

        bool has_distinct_int = (
            desc->OriginalFirstThunk != 0 &&
            desc->OriginalFirstThunk != desc->FirstThunk &&
            (size_t)desc->OriginalFirstThunk + sizeof(IMAGE_THUNK_DATA) <= size_of_image
        );

        size_t iat_off = (size_t)desc->FirstThunk;
        size_t orig_off = has_distinct_int ? (size_t)desc->OriginalFirstThunk : 0;

        for (; iat_off + sizeof(IMAGE_THUNK_DATA) <= size_of_image;
             iat_off += sizeof(IMAGE_THUNK_DATA), orig_off += sizeof(IMAGE_THUNK_DATA)) {
            IMAGE_THUNK_DATA *iat_thunk = (IMAGE_THUNK_DATA *)(img + iat_off);
            if (iat_thunk->u1.Function == 0) break;

            void *replacement = NULL;
            if (has_distinct_int && orig_off + sizeof(IMAGE_THUNK_DATA) <= size_of_image) {
                IMAGE_THUNK_DATA *orig_thunk = (IMAGE_THUNK_DATA *)(img + orig_off);
                if (orig_thunk->u1.AddressOfData == 0) break;
                if (!IMAGE_SNAP_BY_ORDINAL(orig_thunk->u1.Ordinal)) {
                    size_t ibn_rva = (size_t)orig_thunk->u1.AddressOfData;
                    if (ibn_rva >= sizeof(IMAGE_DOS_HEADER) && ibn_rva + 4 <= size_of_image) {
                        const char *fn_name = (const char *)(img + ibn_rva + offsetof(IMAGE_IMPORT_BY_NAME, Name));
                        size_t max_name = size_of_image - (ibn_rva + offsetof(IMAGE_IMPORT_BY_NAME, Name));
                        if (max_name > 256) max_name = 256;
                        if (ds_is_nul_terminated_within(fn_name, max_name)) {
                            if (is_com_loader_only_mod) {
                                if (strcmp(fn_name, "LoadLibraryA") == 0) replacement = (void *)(uintptr_t)hook_LoadLibraryA;
                                else if (strcmp(fn_name, "LoadLibraryW") == 0) replacement = (void *)(uintptr_t)hook_LoadLibraryW;
                                else if (strcmp(fn_name, "LoadLibraryExA") == 0) replacement = (void *)(uintptr_t)hook_LoadLibraryExA;
                                else if (strcmp(fn_name, "LoadLibraryExW") == 0) replacement = (void *)(uintptr_t)hook_LoadLibraryExW;
                            } else {
                                replacement = ds_lookup_hook_by_name(fn_name, !is_wine_gfx_mod);
                            }
                        }
                    }
                }
            }

            if (!replacement) {
                const void *cur_fn = (const void *)(uintptr_t)iat_thunk->u1.Function;
                if (is_com_loader_only_mod) {
                    if (cur_fn == (const void *)(uintptr_t)g_ds.real_LoadLibraryA) replacement = (void *)(uintptr_t)hook_LoadLibraryA;
                    else if (cur_fn == (const void *)(uintptr_t)g_ds.real_LoadLibraryW) replacement = (void *)(uintptr_t)hook_LoadLibraryW;
                    else if (cur_fn == (const void *)(uintptr_t)g_ds.real_LoadLibraryExA) replacement = (void *)(uintptr_t)hook_LoadLibraryExA;
                    else if (cur_fn == (const void *)(uintptr_t)g_ds.real_LoadLibraryExW) replacement = (void *)(uintptr_t)hook_LoadLibraryExW;
                } else {
                    replacement = ds_lookup_hook_by_real_ptr(cur_fn, !is_wine_gfx_mod);
                }
            }
            if (!replacement) continue;

            if ((uintptr_t)iat_thunk->u1.Function == (uintptr_t)replacement) continue;
            DWORD old_prot = 0;
            if (VirtualProtect(&iat_thunk->u1.Function, sizeof(ULONG_PTR), PAGE_READWRITE, &old_prot)) {
                iat_thunk->u1.Function = (ULONG_PTR)(uintptr_t)replacement;
                DWORD dummy = 0;
                VirtualProtect(&iat_thunk->u1.Function, sizeof(ULONG_PTR), old_prot, &dummy);
            }
        }
    }
}

void ds_patch_loaded_modules(void)
{
    ds_invalidate_mod_cache();
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
    if (snap == INVALID_HANDLE_VALUE) {
        ds_patch_single_module_iat(GetModuleHandleW(NULL));
        return;
    }

    MODULEENTRY32W me;
    memset(&me, 0, sizeof(me));
    me.dwSize = sizeof(me);
    if (Module32FirstW(snap, &me)) {
        do {
            ds_patch_single_module_iat(me.hModule);
        } while (Module32NextW(snap, &me));
    }
    CloseHandle(snap);
}

static FARPROC WINAPI hook_GetProcAddress(HMODULE hModule, LPCSTR lpProcName)
{
    if (!g_ds.real_GetProcAddress) return NULL;
    const void *caller_ret = __builtin_return_address(0);
    FARPROC real_fn = g_ds.real_GetProcAddress(hModule, lpProcName);
    if (!real_fn || ds_is_internal_call()) {
        return real_fn;
    }
    if (ds_is_wined3d_caller(caller_ret)) {
        if (lpProcName && ((uintptr_t)lpProcName >> 16) != 0) {
            if (strcmp(lpProcName, "wglCreateContext") == 0) return (FARPROC)(uintptr_t)hook_wglCreateContext;
            if (strcmp(lpProcName, "wglCreateLayerContext") == 0) return (FARPROC)(uintptr_t)hook_wglCreateLayerContext;
            if (strcmp(lpProcName, "wglGetCurrentDC") == 0) return (FARPROC)(uintptr_t)hook_wglGetCurrentDC;
            if (strcmp(lpProcName, "wglMakeCurrent") == 0) return (FARPROC)(uintptr_t)hook_wglMakeCurrent;
            if (strcmp(lpProcName, "wglSwapBuffers") == 0) return (FARPROC)(uintptr_t)hook_wglSwapBuffers;
            if (strcmp(lpProcName, "wglDeleteContext") == 0) return (FARPROC)(uintptr_t)hook_wglDeleteContext;
            if (strcmp(lpProcName, "wglGetProcAddress") == 0) return (FARPROC)(uintptr_t)hook_wglGetProcAddress;
            if (strcmp(lpProcName, "ChoosePixelFormat") == 0) return (FARPROC)(uintptr_t)hook_ChoosePixelFormat;
            if (strcmp(lpProcName, "DescribePixelFormat") == 0) return (FARPROC)(uintptr_t)hook_DescribePixelFormat;
            if (strcmp(lpProcName, "GetPixelFormat") == 0) return (FARPROC)(uintptr_t)hook_GetPixelFormat;
            if (strcmp(lpProcName, "SetPixelFormat") == 0) return (FARPROC)(uintptr_t)hook_SetPixelFormat;
            if (strcmp(lpProcName, "ReleaseDC") == 0) return (FARPROC)(uintptr_t)hook_ReleaseDC;
            if (strcmp(lpProcName, "DeleteDC") == 0) return (FARPROC)(uintptr_t)hook_DeleteDC;
            if (strcmp(lpProcName, "SwapBuffers") == 0) return (FARPROC)(uintptr_t)hook_SwapBuffers;
            if (g_ds.is_wine) {
                if (strcmp(lpProcName, "D3DKMTEscape") == 0) return (FARPROC)(uintptr_t)hook_D3DKMTEscape;
                if (strcmp(lpProcName, "NtGdiDdDDIEscape") == 0) return (FARPROC)(uintptr_t)hook_D3DKMTEscape;
            }
            void *w3d_gl = ds_resolve_wined3d_gl_proc(lpProcName, (void *)(uintptr_t)real_fn);
            if (w3d_gl != (void *)(uintptr_t)real_fn) {
                return (FARPROC)(uintptr_t)w3d_gl;
            }
        }
        return real_fn;
    }
    if (ds_is_system_renderer_caller(caller_ret)) {
        return real_fn;
    }
    if (lpProcName && ((uintptr_t)lpProcName >> 16) != 0) {
        void *gl_hook = ds_resolve_gl_hook_proc(lpProcName, (void *)(uintptr_t)real_fn);
        if (gl_hook != (void *)(uintptr_t)real_fn) {
            return (FARPROC)(uintptr_t)gl_hook;
        }
        void *hook_fn = ds_lookup_hook_by_name(lpProcName, false);
        if (hook_fn) {
            return (FARPROC)(uintptr_t)hook_fn;
        }
        if (strcmp(lpProcName, "ShellExecuteA") == 0) return (FARPROC)(uintptr_t)hook_ShellExecuteA;
        if (strcmp(lpProcName, "ShellExecuteW") == 0) return (FARPROC)(uintptr_t)hook_ShellExecuteW;
        if (strcmp(lpProcName, "ShellExecuteExA") == 0) return (FARPROC)(uintptr_t)hook_ShellExecuteExA;
        if (strcmp(lpProcName, "ShellExecuteExW") == 0) return (FARPROC)(uintptr_t)hook_ShellExecuteExW;
    }
    return real_fn;
}

static HMODULE WINAPI hook_LoadLibraryA(LPCSTR lpLibFileName)
{
    HMODULE h = g_ds.real_LoadLibraryA ? g_ds.real_LoadLibraryA(lpLibFileName) : NULL;
    if (h && !ds_is_internal_call()) {
        ds_resolve_loaded_system_apis();
        ds_patch_loaded_modules();
    }
    return h;
}

static HMODULE WINAPI hook_LoadLibraryW(LPCWSTR lpLibFileName)
{
    HMODULE h = g_ds.real_LoadLibraryW ? g_ds.real_LoadLibraryW(lpLibFileName) : NULL;
    if (h && !ds_is_internal_call()) {
        ds_resolve_loaded_system_apis();
        ds_patch_loaded_modules();
    }
    return h;
}

static HMODULE WINAPI hook_LoadLibraryExA(LPCSTR lpLibFileName, HANDLE hFile, DWORD dwFlags)
{
    HMODULE h = g_ds.real_LoadLibraryExA ? g_ds.real_LoadLibraryExA(lpLibFileName, hFile, dwFlags) : NULL;
    if (h && !ds_is_internal_call() && (dwFlags & (LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE)) == 0) {
        ds_resolve_loaded_system_apis();
        ds_patch_loaded_modules();
    }
    return h;
}

static HMODULE WINAPI hook_LoadLibraryExW(LPCWSTR lpLibFileName, HANDLE hFile, DWORD dwFlags)
{
    HMODULE h = g_ds.real_LoadLibraryExW ? g_ds.real_LoadLibraryExW(lpLibFileName, hFile, dwFlags) : NULL;
    if (h && !ds_is_internal_call() && (dwFlags & (LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE)) == 0) {
        ds_resolve_loaded_system_apis();
        ds_patch_loaded_modules();
    }
    return h;
}

/* -------------------------------------------------------------------------
 * Initialization, Lazy Runtime Start & `DllMain`
 * ------------------------------------------------------------------------- */

static void ds_read_env_w(const WCHAR *name, WCHAR *out_buf, size_t max_chars)
{
    out_buf[0] = L'\0';
    DWORD n = GetEnvironmentVariableW(name, out_buf, (DWORD)max_chars);
    if (n == 0 || n >= (DWORD)max_chars) {
        out_buf[0] = L'\0';
    }
}

static void ds_read_env_utf8(const WCHAR *name, char *out_buf, size_t max_bytes)
{
    out_buf[0] = '\0';
    WCHAR wbuf[256] = { 0 };
    DWORD n = GetEnvironmentVariableW(name, wbuf, 255);
    if (n == 0 || n >= 255) return;
    WideCharToMultiByte(CP_UTF8, 0, wbuf, -1, out_buf, (int)max_bytes, NULL, NULL);
}

static bool ds_read_ini_file_raw(const WCHAR *path, ds_control_state_t *out_ctl)
{
    if (!path || !path[0] || !out_ctl) return false;
    HANDLE hf = CreateFileW(
        path,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );
    if (hf == INVALID_HANDLE_VALUE) return false;
    char buf[1024];
    DWORD bytes_read = 0;
    BOOL ok = ReadFile(hf, buf, (DWORD)(sizeof(buf) - 1), &bytes_read, NULL);
    CloseHandle(hf);
    if (!ok || bytes_read == 0) return false;
    buf[bytes_read] = '\0';
    return ds_parse_control_ini(buf, (size_t)bytes_read, out_ctl);
}

static void ds_fill_sibling_path_if_empty(WCHAR *dst, size_t dst_cch, const WCHAR *dir, const WCHAR *filename)
{
    if (!dst || dst[0] != L'\0' || !dir || !dir[0] || !filename) return;
    WCHAR candidate[MAX_PATH] = { 0 };
    int n = _snwprintf(candidate, MAX_PATH - 1, L"%ls\\%ls", dir, filename);
    if (n <= 0 || n >= MAX_PATH - 1) return;
    candidate[MAX_PATH - 1] = L'\0';
    DWORD attrs = GetFileAttributesW(candidate);
    if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0) {
        wcsncpy(dst, candidate, dst_cch - 1);
        dst[dst_cch - 1] = L'\0';
    }
}

void ds_refresh_host_display_metrics(void)
{
    ds_enter_internal();
    int32_t sm_w = g_ds.real_GetSystemMetrics ? g_ds.real_GetSystemMetrics(SM_CXSCREEN) : 0;
    int32_t sm_h = g_ds.real_GetSystemMetrics ? g_ds.real_GetSystemMetrics(SM_CYSCREEN) : 0;

    DEVMODEW cur_dm;
    memset(&cur_dm, 0, sizeof(cur_dm));
    cur_dm.dmSize = sizeof(cur_dm);
    BOOL has_dm = g_ds.real_EnumDisplaySettingsExW &&
                  g_ds.real_EnumDisplaySettingsExW(NULL, ENUM_CURRENT_SETTINGS, &cur_dm, 0);
    ds_leave_internal();

    char inset_str[32] = { 0 };
    ds_read_env_utf8(L"ONE_LAUNCHER_SAFE_INSET_TOP", inset_str, sizeof(inset_str));

    EnterCriticalSection(&g_ds.lock);
    /*
     * Always prefer GetSystemMetrics(SM_CXSCREEN / SM_CYSCREEN) for real_screen_w / real_screen_h
     * because Win32 window placement and cursor coordinates operate in the calling process's
     * DPI coordinate space (logical points for non-DPI-aware processes vs physical Retina pixels
     * after SetProcessDPIAware()).
     */
    g_ds.real_screen_w = (sm_w > 0) ? sm_w : (has_dm && cur_dm.dmPelsWidth > 0 ? (int32_t)cur_dm.dmPelsWidth : 1024);
    g_ds.real_screen_h = (sm_h > 0) ? sm_h : (has_dm && cur_dm.dmPelsHeight > 0 ? (int32_t)cur_dm.dmPelsHeight : 768);
    g_ds.real_bpp      = (has_dm && cur_dm.dmBitsPerPel >= 8) ? (int32_t)cur_dm.dmBitsPerPel : 32;
    g_ds.real_hz       = (has_dm && cur_dm.dmDisplayFrequency > 0) ? (int32_t)cur_dm.dmDisplayFrequency : 60;

    g_ds.phys_screen_w = (has_dm && cur_dm.dmPelsWidth > 0)
        ? (int32_t)cur_dm.dmPelsWidth
        : g_ds.real_screen_w;
    g_ds.phys_screen_h = (has_dm && cur_dm.dmPelsHeight > 0)
        ? (int32_t)cur_dm.dmPelsHeight
        : g_ds.real_screen_h;

    if (inset_str[0] && g_ds.safe_inset_top == 0) {
        int32_t raw_inset = (int32_t)atoi(inset_str);
        if (raw_inset > 48 && has_dm && g_ds.real_screen_h > 0 &&
            (int32_t)cur_dm.dmPelsHeight >= g_ds.real_screen_h * 2 - 4) {
            raw_inset = (raw_inset + 1) / 2;
        }
        g_ds.safe_inset_top = ds_clamp_safe_inset_top(raw_inset, g_ds.real_screen_h);
    } else {
        g_ds.safe_inset_top = ds_clamp_safe_inset_top(g_ds.safe_inset_top, g_ds.real_screen_h);
    }

    g_ds.mode_count = ds_build_mode_table(
        g_ds.real_screen_w,
        g_ds.real_screen_h,
        g_ds.real_hz,
        g_ds.modes,
        DS_MAX_SYNTH_MODES
    );
    if (!g_ds.mode_virtualized && (g_ds.virt_w <= 0 || g_ds.virt_h <= 0)) {
        g_ds.virt_w = g_ds.real_screen_w;
        g_ds.virt_h = g_ds.real_screen_h;
        g_ds.virt_bpp = g_ds.real_bpp;
        g_ds.virt_hz = g_ds.real_hz;
    }
    ds_refresh_viewport_locked();
    InterlockedIncrement(&g_ds.gdi_margin_gen);
    LeaveCriticalSection(&g_ds.lock);
}

static void ds_resolve_loaded_system_apis(void)
{
    if (!g_ds.real_GetProcAddress) return;

    HMODULE u32 = GetModuleHandleW(L"user32.dll");
    if (u32 && !g_ds.real_EnumDisplaySettingsExW) {
        g_ds.real_EnumDisplaySettingsA    = (pfn_EnumDisplaySettingsA_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "EnumDisplaySettingsA");
        g_ds.real_EnumDisplaySettingsW    = (pfn_EnumDisplaySettingsW_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "EnumDisplaySettingsW");
        g_ds.real_EnumDisplaySettingsExA  = (pfn_EnumDisplaySettingsExA_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "EnumDisplaySettingsExA");
        g_ds.real_EnumDisplaySettingsExW  = (pfn_EnumDisplaySettingsExW_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "EnumDisplaySettingsExW");
        g_ds.real_ChangeDisplaySettingsA  = (pfn_ChangeDisplaySettingsA_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "ChangeDisplaySettingsA");
        g_ds.real_ChangeDisplaySettingsW  = (pfn_ChangeDisplaySettingsW_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "ChangeDisplaySettingsW");
        g_ds.real_ChangeDisplaySettingsExA = (pfn_ChangeDisplaySettingsExA_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "ChangeDisplaySettingsExA");
        g_ds.real_ChangeDisplaySettingsExW = (pfn_ChangeDisplaySettingsExW_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "ChangeDisplaySettingsExW");
        g_ds.real_GetSystemMetrics        = (pfn_GetSystemMetrics_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "GetSystemMetrics");
        g_ds.real_CreateWindowExA         = (pfn_CreateWindowExA_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "CreateWindowExA");
        g_ds.real_CreateWindowExW         = (pfn_CreateWindowExW_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "CreateWindowExW");
        g_ds.real_ShowWindow              = (pfn_ShowWindow_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "ShowWindow");
        g_ds.real_ShowWindowAsync         = (pfn_ShowWindowAsync_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "ShowWindowAsync");
        g_ds.real_SetWindowPlacement      = (pfn_SetWindowPlacement_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "SetWindowPlacement");
        g_ds.real_SetWindowPos            = (pfn_SetWindowPos_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "SetWindowPos");
        g_ds.real_MoveWindow              = (pfn_MoveWindow_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "MoveWindow");
        g_ds.real_GetWindowLongA          = (pfn_GetWindowLongA_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "GetWindowLongA");
        g_ds.real_GetWindowLongW          = (pfn_GetWindowLongW_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "GetWindowLongW");
        g_ds.real_SetWindowLongA          = (pfn_SetWindowLongA_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "SetWindowLongA");
        g_ds.real_SetWindowLongW          = (pfn_SetWindowLongW_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "SetWindowLongW");
#if defined(_WIN64)
        g_ds.real_GetWindowLongPtrA       = (pfn_GetWindowLongPtrA_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "GetWindowLongPtrA");
        g_ds.real_GetWindowLongPtrW       = (pfn_GetWindowLongPtrW_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "GetWindowLongPtrW");
        g_ds.real_SetWindowLongPtrA       = (pfn_SetWindowLongPtrA_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "SetWindowLongPtrA");
        g_ds.real_SetWindowLongPtrW       = (pfn_SetWindowLongPtrW_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "SetWindowLongPtrW");
#endif
        g_ds.real_GetClientRect           = (pfn_GetClientRect_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "GetClientRect");
        g_ds.real_GetWindowRect           = (pfn_GetWindowRect_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "GetWindowRect");
        g_ds.real_GetMonitorInfoA         = (pfn_GetMonitorInfoA_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "GetMonitorInfoA");
        g_ds.real_GetMonitorInfoW         = (pfn_GetMonitorInfoW_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "GetMonitorInfoW");
        g_ds.real_AdjustWindowRect        = (pfn_AdjustWindowRect_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "AdjustWindowRect");
        g_ds.real_AdjustWindowRectEx      = (pfn_AdjustWindowRectEx_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "AdjustWindowRectEx");
        g_ds.real_GetCursorPos            = (pfn_GetCursorPos_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "GetCursorPos");
        g_ds.real_SetCursorPos            = (pfn_SetCursorPos_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "SetCursorPos");
        g_ds.real_ClipCursor              = (pfn_ClipCursor_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "ClipCursor");
        g_ds.real_GetClipCursor           = (pfn_GetClipCursor_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "GetClipCursor");
        g_ds.real_GetMessagePos           = (pfn_GetMessagePos_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "GetMessagePos");
        g_ds.real_GetRawInputData         = (pfn_GetRawInputData_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "GetRawInputData");
        g_ds.real_GetRawInputBuffer       = (pfn_GetRawInputBuffer_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "GetRawInputBuffer");
        g_ds.real_RegisterRawInputDevices = (pfn_RegisterRawInputDevices_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "RegisterRawInputDevices");
        g_ds.real_ScreenToClient          = (pfn_ScreenToClient_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "ScreenToClient");
        g_ds.real_ClientToScreen          = (pfn_ClientToScreen_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "ClientToScreen");
        g_ds.real_MapWindowPoints         = (pfn_MapWindowPoints_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "MapWindowPoints");
        g_ds.real_WindowFromPoint         = (pfn_WindowFromPoint_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "WindowFromPoint");
        g_ds.real_ReleaseDC               = (pfn_ReleaseDC_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "ReleaseDC");
    }

    HMODULE g32 = GetModuleHandleW(L"gdi32.dll");
    if (g32 && !g_ds.real_GetDeviceCaps) {
        g_ds.real_GetDeviceCaps       = (pfn_GetDeviceCaps_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "GetDeviceCaps");
        g_ds.real_DeleteDC            = (pfn_DeleteDC_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "DeleteDC");
        g_ds.real_ChoosePixelFormat   = (pfn_ChoosePixelFormat_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "ChoosePixelFormat");
        g_ds.real_DescribePixelFormat = (pfn_DescribePixelFormat_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "DescribePixelFormat");
        g_ds.real_GetPixelFormat      = (pfn_GetPixelFormat_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "GetPixelFormat");
        g_ds.real_SetPixelFormat      = (pfn_SetPixelFormat_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "SetPixelFormat");
        g_ds.real_BitBlt              = (pfn_BitBlt_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "BitBlt");
        g_ds.real_StretchBlt          = (pfn_StretchBlt_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "StretchBlt");
        g_ds.real_SetDIBitsToDevice   = (pfn_SetDIBitsToDevice_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "SetDIBitsToDevice");
        g_ds.real_StretchDIBits       = (pfn_StretchDIBits_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "StretchDIBits");
        g_ds.real_SwapBuffers         = (pfn_SwapBuffers_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "SwapBuffers");
    }

    if (g_ds.is_wine && !g_ds.real_D3DKMTEscape) {
        HMODULE w32u = GetModuleHandleW(L"win32u.dll");
        if (w32u && !g_ds.real_NtGdiDdDDIEscape) {
            g_ds.real_NtGdiDdDDIEscape = (pfn_D3DKMTEscape_t)(uintptr_t)g_ds.real_GetProcAddress(w32u, "NtGdiDdDDIEscape");
        }
        if (g32 && !g_ds.real_D3DKMTEscape) {
            g_ds.real_D3DKMTEscape = (pfn_D3DKMTEscape_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "D3DKMTEscape");
        }
        if (!g_ds.real_D3DKMTEscape) {
            g_ds.real_D3DKMTEscape = g_ds.real_NtGdiDdDDIEscape;
        }
    }

    HMODULE gl32 = GetModuleHandleW(L"opengl32.dll");
    if (gl32 && !g_ds.real_wglCreateContext) {
        g_ds.real_wglCreateContext       = (pfn_wglCreateContext_t)(uintptr_t)g_ds.real_GetProcAddress(gl32, "wglCreateContext");
        g_ds.real_wglCreateLayerContext  = (pfn_wglCreateLayerContext_t)(uintptr_t)g_ds.real_GetProcAddress(gl32, "wglCreateLayerContext");
        g_ds.real_wglGetCurrentDC        = (pfn_wglGetCurrentDC_t)(uintptr_t)g_ds.real_GetProcAddress(gl32, "wglGetCurrentDC");
        g_ds.real_wglChoosePixelFormat   = (pfn_wglChoosePixelFormat_t)(uintptr_t)g_ds.real_GetProcAddress(gl32, "wglChoosePixelFormat");
        g_ds.real_wglDescribePixelFormat = (pfn_wglDescribePixelFormat_t)(uintptr_t)g_ds.real_GetProcAddress(gl32, "wglDescribePixelFormat");
        g_ds.real_wglGetPixelFormat      = (pfn_wglGetPixelFormat_t)(uintptr_t)g_ds.real_GetProcAddress(gl32, "wglGetPixelFormat");
        g_ds.real_wglSetPixelFormat      = (pfn_wglSetPixelFormat_t)(uintptr_t)g_ds.real_GetProcAddress(gl32, "wglSetPixelFormat");
        g_ds.real_wglMakeCurrent         = (pfn_wglMakeCurrent_t)(uintptr_t)g_ds.real_GetProcAddress(gl32, "wglMakeCurrent");
        g_ds.real_wglDeleteContext       = (pfn_wglDeleteContext_t)(uintptr_t)g_ds.real_GetProcAddress(gl32, "wglDeleteContext");
        g_ds.real_wglSwapBuffers         = (pfn_wglSwapBuffers_t)(uintptr_t)g_ds.real_GetProcAddress(gl32, "wglSwapBuffers");
        g_ds.real_wglGetProcAddress      = (pfn_wglGetProcAddress_t)(uintptr_t)g_ds.real_GetProcAddress(gl32, "wglGetProcAddress");
        g_ds.real_glDrawBuffer           = (pfn_glDrawBuffer_t)(uintptr_t)g_ds.real_GetProcAddress(gl32, "glDrawBuffer");
        g_ds.real_glReadBuffer           = (pfn_glReadBuffer_t)(uintptr_t)g_ds.real_GetProcAddress(gl32, "glReadBuffer");
        g_ds.real_glGetIntegerv          = (pfn_glGetIntegerv_t)(uintptr_t)g_ds.real_GetProcAddress(gl32, "glGetIntegerv");
    }
    if (g32) {
        if (!g_ds.real_wglChoosePixelFormat)   g_ds.real_wglChoosePixelFormat   = (pfn_wglChoosePixelFormat_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "wglChoosePixelFormat");
        if (!g_ds.real_wglDescribePixelFormat) g_ds.real_wglDescribePixelFormat = (pfn_wglDescribePixelFormat_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "wglDescribePixelFormat");
        if (!g_ds.real_wglGetPixelFormat)      g_ds.real_wglGetPixelFormat      = (pfn_wglGetPixelFormat_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "wglGetPixelFormat");
        if (!g_ds.real_wglSetPixelFormat)      g_ds.real_wglSetPixelFormat      = (pfn_wglSetPixelFormat_t)(uintptr_t)g_ds.real_GetProcAddress(g32, "wglSetPixelFormat");
    }

    ds_ensure_shell32_loaded(false);
}

void ds_ensure_runtime_started(void)
{
    static volatile LONG s_runtime_started = 0;
    if (!g_ds.active || g_ds.shutting_down) return;
    if (InterlockedCompareExchange(&s_runtime_started, 1, 0) != 0) {
        return;
    }

    ds_resolve_loaded_system_apis();

    if (!ds_is_passthrough_locked() && !g_ds.dpi_aware_applied) {
        HMODULE u32 = GetModuleHandleW(L"user32.dll");
        if (u32 && g_ds.real_GetProcAddress) {
            typedef BOOL (WINAPI *pfn_SetProcessDPIAware_t)(void);
            pfn_SetProcessDPIAware_t pfn_dpi = (pfn_SetProcessDPIAware_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "SetProcessDPIAware");
            if (pfn_dpi) {
                ds_enter_internal();
                pfn_dpi();
                ds_leave_internal();
                g_ds.dpi_aware_applied = true;
            }
        }
    }

    if (g_ds.msg_apply_presentation == 0) {
        g_ds.msg_apply_presentation = RegisterWindowMessageW(L"OneLauncher_ApplyDisplayPresentation");
        g_ds.msg_gl_host_ctl = RegisterWindowMessageW(L"OneLauncher_GLHostControl");
    }

    if (g_ds.scaling_mode != DS_MODE_PASSTHROUGH) {
        ds_refresh_host_display_metrics();
        ds_start_control_watcher();
    }
}

static void ds_resolve_real_apis_and_init(HMODULE hinstDLL)
{
    bool is_chaining_wrapper = ds_is_passthrough_chaining_process();

    /* Discover <self_dir> and <self_dir>\active_session.ini before touching any Win32 state */
    WCHAR self_path[MAX_PATH] = { 0 };
    if (GetModuleFileNameW(hinstDLL, self_path, MAX_PATH - 1) > 0) {
        WCHAR *last_sep = NULL;
        for (WCHAR *p = self_path; *p; p++) {
            if (*p == L'\\' || *p == L'/') last_sep = p;
        }
        if (last_sep) {
            *last_sep = L'\0';
            wcsncpy(g_ds.self_dir, self_path, MAX_PATH - 1);
            g_ds.self_dir[MAX_PATH - 1] = L'\0';
            _snwprintf(g_ds.active_session_file, MAX_PATH - 1, L"%ls\\active_session.ini", g_ds.self_dir);
            g_ds.active_session_file[MAX_PATH - 1] = L'\0';
        }
    }

    char mode_str[64] = { 0 };
    char aspect_str[64] = { 0 };
    char filter_str[32] = { 0 };
    char inset_str[32] = { 0 };
    char hotkey_str[16] = { 0 };
    ds_read_env_utf8(L"ONE_LAUNCHER_DISPLAY_SCALING_MODE", mode_str, sizeof(mode_str));
    ds_read_env_utf8(L"ONE_LAUNCHER_DISPLAY_ASPECT", aspect_str, sizeof(aspect_str));
    ds_read_env_utf8(L"ONE_LAUNCHER_SCALING_FILTER", filter_str, sizeof(filter_str));
    ds_read_env_utf8(L"ONE_LAUNCHER_SAFE_INSET_TOP", inset_str, sizeof(inset_str));
    ds_read_env_utf8(L"ONE_LAUNCHER_FULLSCREEN_HOTKEY", hotkey_str, sizeof(hotkey_str));

    g_ds.scaling_mode   = mode_str[0] ? ds_parse_scaling_mode(mode_str) : DS_MODE_AUTO_FULLSCREEN;
    g_ds.aspect_mode    = aspect_str[0] ? ds_parse_aspect_mode(aspect_str) : DS_ASPECT_PRESERVE;
    g_ds.scale_filter   = filter_str[0] ? ds_parse_scale_filter(filter_str) : DS_FILTER_AUTO;
    g_ds.hotkey_enabled = (hotkey_str[0] != '0');
    g_ds.safe_inset_top = inset_str[0] ? (int32_t)atoi(inset_str) : 0;

    ds_read_env_w(L"ONE_LAUNCHER_SCALER_DLL_X86", g_ds.dll_x86, MAX_PATH);
    ds_read_env_w(L"ONE_LAUNCHER_SCALER_DLL_X64", g_ds.dll_x64, MAX_PATH);
    ds_read_env_w(L"ONE_LAUNCHER_LAUNCHER_EXE_X86", g_ds.launcher_x86, MAX_PATH);
    ds_read_env_w(L"ONE_LAUNCHER_LAUNCHER_EXE_X64", g_ds.launcher_x64, MAX_PATH);
    ds_read_env_w(L"ONE_LAUNCHER_DISPLAY_CONTROL_FILE", g_ds.control_file, MAX_PATH);
    ds_read_env_w(L"ONE_LAUNCHER_DISPLAY_STATUS_FILE", g_ds.status_file, MAX_PATH);
    ds_read_env_w(L"ONE_LAUNCHER_DISPLAY_TRACE_FILE", g_ds.trace_file, MAX_PATH);

    if (g_ds.self_dir[0]) {
        ds_fill_sibling_path_if_empty(g_ds.dll_x86, MAX_PATH, g_ds.self_dir, L"one_display_scaler_x86.dll");
        ds_fill_sibling_path_if_empty(g_ds.dll_x64, MAX_PATH, g_ds.self_dir, L"one_display_scaler_x64.dll");
        ds_fill_sibling_path_if_empty(g_ds.launcher_x86, MAX_PATH, g_ds.self_dir, L"one_display_launcher_x86.exe");
        ds_fill_sibling_path_if_empty(g_ds.launcher_x64, MAX_PATH, g_ds.self_dir, L"one_display_launcher_x64.exe");
    }

    /*
     * Cross-track warm daemon & runtime --watch-dir recovery:
     * When ONE_LAUNCHER_DISPLAY_CONTROL_FILE is missing or points to a stale/deleted session INI,
     * adopt <self_dir>\active_session.ini.
     */
    bool control_missing_or_stale = (
        !g_ds.control_file[0] ||
        GetFileAttributesW(g_ds.control_file) == INVALID_FILE_ATTRIBUTES
    );
    if (control_missing_or_stale && g_ds.active_session_file[0]) {
        ds_control_state_t act_ctl;
        if (ds_read_ini_file_raw(g_ds.active_session_file, &act_ctl)) {
            g_ds.last_active_session_seq = ds_effective_active_session_seq(&act_ctl);
            if (act_ctl.has_control_file) {
                MultiByteToWideChar(CP_UTF8, 0, act_ctl.control_file, -1, g_ds.control_file, MAX_PATH);
                g_ds.control_file[MAX_PATH - 1] = L'\0';
            }
            if (act_ctl.has_status_file) {
                MultiByteToWideChar(CP_UTF8, 0, act_ctl.status_file, -1, g_ds.status_file, MAX_PATH);
                g_ds.status_file[MAX_PATH - 1] = L'\0';
            }
            if (act_ctl.has_scaling_mode)   g_ds.scaling_mode   = act_ctl.scaling_mode;
            if (act_ctl.has_aspect)         g_ds.aspect_mode    = act_ctl.aspect;
            if (act_ctl.has_filter)         g_ds.scale_filter   = act_ctl.filter;
            if (act_ctl.has_safe_inset_top) g_ds.safe_inset_top = act_ctl.safe_inset_top;
            if (act_ctl.has_hotkey)         g_ds.hotkey_enabled = act_ctl.hotkey;
        }
    }

    if (g_ds.control_file[0]) {
        ds_control_state_t init_ctl;
        if (ds_read_ini_file_raw(g_ds.control_file, &init_ctl)) {
            if (init_ctl.has_scaling_mode)   g_ds.scaling_mode   = init_ctl.scaling_mode;
            if (init_ctl.has_aspect)         g_ds.aspect_mode    = init_ctl.aspect;
            if (init_ctl.has_filter)         g_ds.scale_filter   = init_ctl.filter;
            if (init_ctl.has_safe_inset_top) g_ds.safe_inset_top = init_ctl.safe_inset_top;
            if (init_ctl.has_hotkey)         g_ds.hotkey_enabled = init_ctl.hotkey;
        }
    }

    /* Check "off"/passthrough mode BEFORE SetProcessDPIAware(), TLS/lock init, or IAT patching */
    if (!is_chaining_wrapper && g_ds.scaling_mode == DS_MODE_PASSTHROUGH) {
        return;
    }
    if (is_chaining_wrapper) {
        g_ds.scaling_mode = DS_MODE_PASSTHROUGH;
    }

    g_ds.self_hmod = hinstDLL;
    g_ds.tls_depth_idx = TlsAlloc();
    InitializeCriticalSection(&g_ds.lock);
    g_ds.lock_initialized = true;
    InitOnceInitialize(&g_ds.watcher_once);

    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    g_ds.real_GetProcAddress = k32 ? (pfn_GetProcAddress_t)(uintptr_t)GetProcAddress(k32, "GetProcAddress") : NULL;
    if (!g_ds.real_GetProcAddress) return;

    g_ds.real_LoadLibraryA   = (pfn_LoadLibraryA_t)(uintptr_t)g_ds.real_GetProcAddress(k32, "LoadLibraryA");
    g_ds.real_LoadLibraryW   = (pfn_LoadLibraryW_t)(uintptr_t)g_ds.real_GetProcAddress(k32, "LoadLibraryW");
    g_ds.real_LoadLibraryExA = (pfn_LoadLibraryExA_t)(uintptr_t)g_ds.real_GetProcAddress(k32, "LoadLibraryExA");
    g_ds.real_LoadLibraryExW = (pfn_LoadLibraryExW_t)(uintptr_t)g_ds.real_GetProcAddress(k32, "LoadLibraryExW");
    g_ds.real_CreateProcessA = (pfn_CreateProcessA_t)(uintptr_t)g_ds.real_GetProcAddress(k32, "CreateProcessA");
    g_ds.real_CreateProcessW = (pfn_CreateProcessW_t)(uintptr_t)g_ds.real_GetProcAddress(k32, "CreateProcessW");

    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    g_ds.is_wine = (ntdll != NULL && g_ds.real_GetProcAddress(ntdll, "wine_get_version") != NULL);

    if (!is_chaining_wrapper) {
        char aff_env[16] = { 0 };
        ds_read_env_utf8(L"ONE_LAUNCHER_SINGLE_CORE_AFFINITY", aff_env, sizeof(aff_env));
        bool want_up = (aff_env[0] == '1');
#if !defined(_WIN64)
        if (!want_up && aff_env[0] != '0') {
            HMODULE exe_mod = GetModuleHandleW(NULL);
            if (exe_mod) {
                const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)(const void *)exe_mod;
                if (dos->e_magic == IMAGE_DOS_SIGNATURE && dos->e_lfanew > 0 && dos->e_lfanew < 0x1000) {
                    const IMAGE_NT_HEADERS *nt = (const IMAGE_NT_HEADERS *)((const uint8_t *)exe_mod + dos->e_lfanew);
                    if (nt->Signature == IMAGE_NT_SIGNATURE &&
                        (nt->FileHeader.Characteristics & IMAGE_FILE_UP_SYSTEM_ONLY) != 0) {
                        want_up = true;
                    }
                }
            }
        }
#endif
        if (want_up) {
            typedef BOOL (WINAPI *pfn_SetProcessAffinityMask_t)(HANDLE, DWORD_PTR);
            pfn_SetProcessAffinityMask_t pfnSetAffinity = (pfn_SetProcessAffinityMask_t)(uintptr_t)g_ds.real_GetProcAddress(k32, "SetProcessAffinityMask");
            if (pfnSetAffinity) {
                pfnSetAffinity(GetCurrentProcess(), 1);
            }
        }
    }

    /* Resolve ONLY already-mapped system DLLs under loader lock; never call LoadLibraryW here */
    ds_resolve_loaded_system_apis();
    if (!is_chaining_wrapper && g_ds.real_GetSystemMetrics) {
        ds_refresh_host_display_metrics();
    } else {
        g_ds.real_screen_w = 1024;
        g_ds.real_screen_h = 768;
        g_ds.phys_screen_w = 1024;
        g_ds.phys_screen_h = 768;
        g_ds.real_bpp = 32;
        g_ds.real_hz = 60;
    }

    g_ds.last_control_seq = 0;
    g_ds.active = true;

    ds_patch_loaded_modules();
}

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved)
{
    if (fdwReason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinstDLL);
        if (!ds_should_ignore_current_process()) {
            ds_resolve_real_apis_and_init(hinstDLL);
        }
    } else if (fdwReason == DLL_PROCESS_DETACH) {
        g_ds.shutting_down = true;
        if (g_ds.active) {
            /* Never block with WaitForSingleObject under LdrpLoaderLock during detach */
            ds_stop_control_watcher(true);
            if (lpvReserved == NULL) {
                ds_gl_shutdown();
                if (g_ds.tls_depth_idx != TLS_OUT_OF_INDEXES) {
                    TlsFree(g_ds.tls_depth_idx);
                    g_ds.tls_depth_idx = TLS_OUT_OF_INDEXES;
                }
                if (g_ds.lock_initialized) {
                    DeleteCriticalSection(&g_ds.lock);
                    g_ds.lock_initialized = false;
                }
            }
        }
    }
    return TRUE;
}
