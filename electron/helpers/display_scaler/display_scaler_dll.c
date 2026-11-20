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

void ds_lock(void)
{
    EnterCriticalSection(&g_ds.lock);
}

void ds_unlock(void)
{
    LeaveCriticalSection(&g_ds.lock);
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

HANDLE ds_dpi_guard_enter(HANDLE target_ctx)
{
    if (!target_ctx || !g_ds.p_SetThreadDpiAwarenessContext) {
        return NULL;
    }
    return g_ds.p_SetThreadDpiAwarenessContext(target_ctx);
}

HANDLE ds_dpi_guard_enter_for_hwnd(HWND hwnd)
{
    HANDLE win_ctx = (hwnd && IsWindow(hwnd) && g_ds.p_GetWindowDpiAwarenessContext)
        ? g_ds.p_GetWindowDpiAwarenessContext(hwnd)
        : DS_DPI_CTX_PMV2;
    return ds_dpi_guard_enter(win_ctx);
}

void ds_dpi_guard_leave(HANDLE prev_ctx)
{
    if (!prev_ctx || !g_ds.p_SetThreadDpiAwarenessContext) {
        return;
    }
    (void)g_ds.p_SetThreadDpiAwarenessContext(prev_ctx);
}

BOOL ds_set_window_pos_dpi(HWND hwnd, HWND after, int x, int y, int w, int h, UINT flags, bool clear_present)
{
    if (!g_ds.real_SetWindowPos) return FALSE;
    HANDLE prev_dpi = ds_dpi_guard_enter_for_hwnd(hwnd);
    ds_enter_internal();
    if (clear_present) {
        ds_clear_wine_present_rect_on_hwnd(hwnd);
    }
    BOOL ok = g_ds.real_SetWindowPos(hwnd, after, x, y, w, h, flags);
    ds_leave_internal();
    ds_dpi_guard_leave(prev_dpi);
    return ok;
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
#define DS_MODF_D3D9       (1u << 5)
#define DS_MODF_DDRAW      (1u << 6)
#define DS_MODF_D3D8       (1u << 7)
#define DS_MODF_MODERN_DX  (1u << 8)
#define DS_MODF_VULKAN     (1u << 9)
#define DS_MODF_SKIP_IAT   (1u << 10)

typedef struct {
    HMODULE  hmod;
    uint32_t flags;
} ds_mod_cache_entry_t;

static ds_mod_cache_entry_t s_mod_cache[DS_MOD_CACHE_SLOTS];

DS_ALWAYS_INLINE void ds_invalidate_mod_cache(void)
{
    if (g_ds.lock_initialized) ds_lock();
    memset(s_mod_cache, 0, sizeof(s_mod_cache));
    if (g_ds.lock_initialized) ds_unlock();
}

bool ds_wcs_ieq_ascii(const WCHAR *w, const char *a)
{
    if (!w || !a) return false;
    while (*w && *a) {
        WCHAR cw = *w++;
        unsigned char ca = (unsigned char)*a++;
        if (cw >= L'A' && cw <= L'Z') cw = (WCHAR)(cw + (L'a' - L'A'));
        if (ca >= 'A' && ca <= 'Z') ca = (unsigned char)(ca + ('a' - 'A'));
        if (cw != (WCHAR)ca) return false;
    }
    return (*w == L'\0' && *a == '\0');
}

static const WCHAR k_ds_mod_names_msz[] =
    L"wined3d.dll" L"\0"    L"ddraw.dll" L"\0"      L"d3d8.dll" L"\0"       L"d3d9.dll" L"\0"
    L"dxgi.dll" L"\0"       L"d3d10.dll" L"\0"      L"d3d10_1.dll" L"\0"    L"d3d10core.dll" L"\0"
    L"d3d11.dll" L"\0"      L"d3d12.dll" L"\0"      L"d3d12core.dll" L"\0"  L"d3dmetal.dll" L"\0"
    L"winemetal.dll" L"\0"  L"vulkan-1.dll" L"\0"   L"winevulkan.dll" L"\0" L"opengl32.dll" L"\0"
    L"winemac.drv" L"\0"    L"win32u.dll" L"\0"     L"user32.dll" L"\0"     L"gdi32.dll" L"\0"
    L"ntdll.dll" L"\0"      L"kernel32.dll" L"\0"   L"kernelbase.dll" L"\0" L"ucrtbase.dll" L"\0"
    L"msvcrt.dll" L"\0"     L"advapi32.dll" L"\0"   L"rpcrt4.dll" L"\0"     L"sechost.dll" L"\0";

#define DS_MF_MDX (DS_MODF_MODERN_DX | DS_MODF_SYS_RENDER | DS_MODF_PHYS_SURF)
#define DS_MF_SYS (DS_MODF_SYS_RENDER | DS_MODF_PHYS_SURF | DS_MODF_SKIP_IAT)
static const uint16_t k_ds_mod_flags[28] = {
    DS_MODF_WINED3D | DS_MODF_SYS_RENDER, DS_MODF_DDRAW,                       DS_MODF_D3D8 | DS_MODF_SYS_RENDER, DS_MODF_D3D9 | DS_MODF_SYS_RENDER,
    DS_MF_MDX | DS_MODF_SKIP_IAT,         DS_MF_MDX,                           DS_MF_MDX,                         DS_MF_MDX,
    DS_MF_MDX,                            DS_MF_MDX,                           DS_MF_MDX,                         DS_MF_MDX | DS_MODF_SKIP_IAT,
    DS_MF_MDX | DS_MODF_SKIP_IAT,         DS_MODF_VULKAN | DS_MF_SYS,          DS_MODF_VULKAN | DS_MF_SYS,        DS_MF_SYS,
    DS_MF_SYS,                            DS_MF_SYS,                           DS_MF_SYS,                         DS_MF_SYS,
    DS_MODF_SKIP_IAT,                     DS_MODF_SKIP_IAT,                    DS_MODF_SKIP_IAT,                  DS_MODF_SKIP_IAT,
    DS_MODF_SKIP_IAT,                     DS_MODF_SKIP_IAT,                    DS_MODF_SKIP_IAT,                  DS_MODF_SKIP_IAT,
};

/* DirectInput DLLs must receive physical surface coordinates for 3D mouse look (F10) */
static const WCHAR *const k_phys_surface_mods[] = {
    L"dinput.dll",
    L"dinput8.dll",
};

static uint32_t ds_compute_mod_flags_by_base(const WCHAR *base)
{
    uint32_t flags = DS_MODF_VALID;
    if (!base || !base[0]) return flags;
    if (_wcsnicmp(base, L"one_display_scaler", 18) == 0) {
        return flags | DS_MODF_SELF | DS_MODF_SYS_RENDER | DS_MODF_PHYS_SURF | DS_MODF_SKIP_IAT;
    }
    for (size_t i = 0; i < sizeof(k_phys_surface_mods) / sizeof(k_phys_surface_mods[0]); i++) {
        if (_wcsicmp(base, k_phys_surface_mods[i]) == 0) {
            return flags | DS_MODF_PHYS_SURF;
        }
    }
    size_t idx = 0;
    for (const WCHAR *p = k_ds_mod_names_msz; *p != L'\0' && idx < 28u; p += wcslen(p) + 1, idx++) {
        if (_wcsicmp(base, p) == 0) {
            return flags | (uint32_t)k_ds_mod_flags[idx];
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
    if (g_ds.lock_initialized) ds_lock();
    if (s_mod_cache[slot].hmod == hmod && (s_mod_cache[slot].flags & DS_MODF_VALID) != 0) {
        uint32_t cached = s_mod_cache[slot].flags;
        if (g_ds.lock_initialized) ds_unlock();
        if (out_flags) *out_flags = cached;
        return true;
    }
    if (g_ds.lock_initialized) ds_unlock();

    WCHAR mod_path[MAX_PATH];
    mod_path[0] = L'\0';
    if (GetModuleFileNameW(hmod, mod_path, MAX_PATH - 1) == 0) {
        return false;
    }
    uint32_t computed = ds_compute_mod_flags_by_base(ds_basename_w(mod_path));
    if (g_ds.lock_initialized) ds_lock();
    s_mod_cache[slot].hmod = hmod;
    s_mod_cache[slot].flags = computed;
    if (g_ds.lock_initialized) ds_unlock();

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
    if (g_ds.lock_initialized) ds_lock();
    bool skip_modern = (ds_is_modern_tier_locked() && !ds_is_vulkan_d3d9_subnative_locked());
    if (g_ds.lock_initialized) ds_unlock();
    if (skip_modern) {
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
         * Virtualize WineD3D rects ONLY when WineD3D uses OpenGL (or legacy DDraw/D3D8/D3D9
         * before GL context creation when Vulkan is NOT positively detected), preserving
         * Frame-0 OpenGL Y-flipping while keeping Vulkan-backed WineD3D unvirtualized.
         */
        return (g_ds.wined3d_uses_gl || (g_ds.legacy_d3d_loaded && !g_ds.wined3d_uses_vulkan));
    }
    if ((flags & (DS_MODF_D3D9 | DS_MODF_D3D8 | DS_MODF_DDRAW)) != 0 && g_ds.wined3d_uses_vulkan) {
        return false;
    }
    if ((flags & DS_MODF_PHYS_SURF) != 0) {
        return false;
    }
    return true;
}

static bool ds_current_exe_in_multisz(const char *msz, bool on_err)
{
    WCHAR exe_path[MAX_PATH] = { 0 };
    if (GetModuleFileNameW(NULL, exe_path, MAX_PATH - 1) == 0) {
        return on_err;
    }
    const WCHAR *base = ds_basename_w(exe_path);
    for (const char *p = msz; *p != '\0'; p += strlen(p) + 1) {
        if (ds_wcs_ieq_ascii(base, p)) return true;
    }
    return false;
}

DS_ALWAYS_INLINE bool ds_is_passthrough_chaining_process(void)
{
    static const char k_chain_msz[] =
        "cmd.exe\0powershell.exe\0rundll32.exe\0steam.exe\0"
        "galaxyclient.exe\0galaxyclienthelper.exe\0galaxycommunication.exe\0"
        "epicgameslauncher.exe\0eadesktop.exe\0upc.exe\0";
    return ds_current_exe_in_multisz(k_chain_msz, false);
}

DS_ALWAYS_INLINE bool ds_should_ignore_current_process(void)
{
    static const char k_ignored_msz[] =
        "services.exe\0plugplay.exe\0rpcss.exe\0winedevice.exe\0"
        "explorer.exe\0wineboot.exe\0conhost.exe\0svchost.exe\0"
        "reg.exe\0regedit.exe\0regsvr32.exe\0msiexec.exe\0"
        "one_display_launcher_x86.exe\0one_display_launcher_x64.exe\0"
        "one_xgr_win_launcher.exe\0one_xgr_win_launcher_x86.exe\0"
        "steamwebhelper.exe\0steamservice.exe\0epicwebhelper.exe\0";
    return ds_current_exe_in_multisz(k_ignored_msz, true);
}

bool ds_prefer_16bpp_ddraw(void)
{
    return g_ds.ddraw_loaded && !g_ds.d3d8_or_9_loaded;
}

bool ds_is_vulkan_d3d9_locked(void)
{
#if defined(_WIN64)
    return false;
#else
    return (
        !g_ds.dxgi_or_d3d10_plus_loaded &&
        (g_ds.d3d9_loaded || g_ds.d3d8_or_9_loaded || g_ds.ddraw_loaded) &&
        g_ds.wined3d_uses_vulkan &&
        !g_ds.wined3d_uses_gl &&
        !g_ds.ddraw_gdi_active
    );
#endif
}

bool ds_is_vulkan_d3d9_subnative_locked(void)
{
    int32_t eff_w = (g_ds.phys_screen_w > 0) ? g_ds.phys_screen_w : g_ds.real_screen_w;
    int32_t eff_h = (g_ds.phys_screen_h > 0) ? g_ds.phys_screen_h : g_ds.real_screen_h;
    return (
        ds_is_vulkan_d3d9_locked() &&
        g_ds.fullscreen_active &&
        g_ds.mode_virtualized &&
        g_ds.virt_w > 0 && g_ds.virt_h > 0 &&
        eff_w > 0 && eff_h > 0 &&
        (g_ds.virt_w < eff_w || g_ds.virt_h < eff_h)
    );
}

bool ds_is_modern_tier_locked(void)
{
    return (g_ds.scaling_mode == DS_MODE_PASSTHROUGH ||
            g_ds.presenter_tier != DS_PRESENTER_LEGACY_VIRTUAL);
}

bool ds_is_modern_borderless_locked(void)
{
    return (g_ds.scaling_mode != DS_MODE_PASSTHROUGH &&
            g_ds.presenter_tier == DS_PRESENTER_MODERN_BORDERLESS);
}

bool ds_is_passthrough_locked(void)
{
    return (g_ds.scaling_mode == DS_MODE_PASSTHROUGH ||
            g_ds.presenter_tier == DS_PRESENTER_MODERN_PASSTHROUGH);
}

bool ds_update_presenter_tier_locked(void)
{
    ds_tier_input_t ti;
    ti.scaling_mode              = g_ds.scaling_mode;
    ti.prev_tier                 = g_ds.presenter_tier;
#if defined(_WIN64)
    ti.is_64bit                  = true;
#else
    ti.is_64bit                  = false;
#endif
    ti.gl_upscale_active         = g_ds.gl_upscale_active;
    ti.ddraw_gdi_active          = g_ds.ddraw_gdi_active;
    ti.game_gl_active            = g_ds.game_gl_active;
    ti.wined3d_uses_gl           = g_ds.wined3d_uses_gl;
    ti.wined3d_uses_vulkan       = g_ds.wined3d_uses_vulkan;
    ti.ddraw_loaded              = g_ds.ddraw_loaded;
    ti.d3d8_or_9_loaded          = g_ds.d3d8_or_9_loaded;
    ti.d3d9_loaded               = g_ds.d3d9_loaded;
    ti.legacy_d3d_loaded         = g_ds.legacy_d3d_loaded;
    ti.dxgi_or_d3d10_plus_loaded = g_ds.dxgi_or_d3d10_plus_loaded;
    ti.vulkan_loaded             = g_ds.vulkan_loaded;
    ti.modern_gfx_loaded         = g_ds.modern_gfx_loaded;
    ti.fullscreen_active         = g_ds.fullscreen_active;
    ti.borderless_active         = g_ds.borderless_active;
    ti.window_mutated_by_scaler  = g_ds.window_mutated_by_scaler;
    ti.user_forced_windowed      = g_ds.user_forced_windowed;
    ti.user_forced_fullscreen    = g_ds.user_forced_fullscreen;

    ds_presenter_tier_t prev_tier = g_ds.presenter_tier;
    ds_presenter_tier_t next_tier = ds_compute_presenter_tier(&ti);

    g_ds.presenter_tier = next_tier;
    g_ds.modern_swapchain_passthrough = (next_tier == DS_PRESENTER_MODERN_PASSTHROUGH);

    if (prev_tier == DS_PRESENTER_LEGACY_VIRTUAL && next_tier != DS_PRESENTER_LEGACY_VIRTUAL) {
        bool had_legacy_state = (
            g_ds.fullscreen_active ||
            g_ds.mode_virtualized ||
            g_ds.window_mutated_by_scaler ||
            g_ds.hwnd_gl_host != NULL
        );
        if (next_tier == DS_PRESENTER_MODERN_PASSTHROUGH) {
            g_ds.fullscreen_active = false;
        }
        if (next_tier == DS_PRESENTER_MODERN_PASSTHROUGH || !ds_is_vulkan_d3d9_locked()) {
            g_ds.mode_virtualized = false;
            g_ds.virt_w = g_ds.real_screen_w;
            g_ds.virt_h = g_ds.real_screen_h;
            g_ds.virt_bpp = g_ds.real_bpp;
            g_ds.virt_hz = g_ds.real_hz;
        }
        g_ds.passthrough_restored = false;
        ds_refresh_viewport_locked();
        return had_legacy_state || (g_ds.hwnd_game != NULL);
    }

    return (prev_tier != next_tier);
}

void ds_notify_gl_context_active_locked(void)
{
    (void)ds_update_presenter_tier_locked();
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

DS_ALWAYS_INLINE void ds_fill_devmode_a(DEVMODEA *dm, int32_t w, int32_t h, int32_t bpp, int32_t hz)
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
    pfn_EnumDisplaySettingsExW_t real_eds = g_ds.real_EnumDisplaySettingsExW;
    if (ds_is_internal_call()) {
        return real_eds ? real_eds(lpszDeviceName, iModeNum, lpDevMode, dwFlags) : FALSE;
    }

    ds_lock();
    bool pass_through = (ds_is_modern_tier_locked() && !ds_is_vulkan_d3d9_locked());
    bool non_target_dev = (
        lpszDeviceName != NULL &&
        lpszDeviceName[0] != L'\0' &&
        g_ds.target_device[0] != L'\0' &&
        _wcsicmp(lpszDeviceName, g_ds.target_device) != 0
    );
    bool mode_virt = g_ds.mode_virtualized;
    int32_t phys_x = g_ds.phys_mon_x;
    int32_t phys_y = g_ds.phys_mon_y;
    WCHAR dev_name[32];
    if (g_ds.target_device[0] != L'\0') {
        wcsncpy(dev_name, g_ds.target_device, 31);
        dev_name[31] = L'\0';
    } else {
        wcscpy(dev_name, L"\\\\.\\DISPLAY1");
    }
    ds_unlock();

    if (pass_through || non_target_dev) {
        return real_eds ? real_eds(lpszDeviceName, iModeNum, lpDevMode, dwFlags) : FALSE;
    }

    if (iModeNum == ENUM_CURRENT_SETTINGS || iModeNum == ENUM_REGISTRY_SETTINGS) {
        if (!mode_virt || iModeNum == ENUM_REGISTRY_SETTINGS) {
            return real_eds ? real_eds(lpszDeviceName, iModeNum, lpDevMode, dwFlags) : FALSE;
        }
        BOOL ok = real_eds ? real_eds(lpszDeviceName, ENUM_CURRENT_SETTINGS, lpDevMode, dwFlags) : FALSE;
        if (!ok) {
            WORD sz = lpDevMode->dmSize ? lpDevMode->dmSize : (WORD)sizeof(DEVMODEW);
            memset(lpDevMode, 0, sz);
            lpDevMode->dmSize = sz;
        }
        ds_lock();
        int32_t bpp = ds_prefer_16bpp_ddraw()
            ? 16
            : ((g_ds.virt_bpp > 0) ? g_ds.virt_bpp : g_ds.real_bpp);
        if (g_ds.virt_w > 0 && g_ds.virt_h > 0) {
            ds_fill_devmode_w(lpDevMode, g_ds.virt_w, g_ds.virt_h, bpp, g_ds.virt_hz);
        } else {
            ds_fill_devmode_w(lpDevMode, g_ds.phys_screen_w > 0 ? g_ds.phys_screen_w : g_ds.real_screen_w,
                              g_ds.phys_screen_h > 0 ? g_ds.phys_screen_h : g_ds.real_screen_h, bpp, g_ds.real_hz);
        }
        lpDevMode->dmPosition.x = phys_x;
        lpDevMode->dmPosition.y = phys_y;
        lpDevMode->dmFields |= DM_POSITION;
        ds_unlock();
        return TRUE;
    }

    ds_lock();
    size_t count = g_ds.mode_count;
    ds_display_mode_t m = { 0, 0, 32, 60 };
    bool valid = ((size_t)iModeNum < count);
    if (valid) {
        m = g_ds.modes[iModeNum];
    }
    ds_unlock();

    if (!valid) {
        return FALSE;
    }

    WORD sz = lpDevMode->dmSize ? lpDevMode->dmSize : (WORD)sizeof(DEVMODEW);
    if (sz > sizeof(DEVMODEW)) sz = (WORD)sizeof(DEVMODEW);
    memset(lpDevMode, 0, sz);
    lpDevMode->dmSize = sz;
    wcsncpy((WCHAR *)lpDevMode->dmDeviceName, dev_name, CCHDEVICENAME - 1);
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
    if (ds_is_internal_call()) {
        return g_ds.real_EnumDisplaySettingsExA ? g_ds.real_EnumDisplaySettingsExA(lpszDeviceName, iModeNum, lpDevMode, dwFlags) : FALSE;
    }

    ds_lock();
    bool pass_through = (ds_is_modern_tier_locked() && !ds_is_vulkan_d3d9_locked());
    ds_unlock();
    if (pass_through) {
        return g_ds.real_EnumDisplaySettingsExA ? g_ds.real_EnumDisplaySettingsExA(lpszDeviceName, iModeNum, lpDevMode, dwFlags) : FALSE;
    }

    WCHAR dev_w[64] = { 0 };
    LPCWSTR dev_w_ptr = NULL;
    if (lpszDeviceName != NULL && lpszDeviceName[0] != '\0') {
        if (MultiByteToWideChar(CP_ACP, 0, lpszDeviceName, -1, dev_w, 63) > 0) {
            dev_w[63] = L'\0';
            dev_w_ptr = dev_w;
        }
    }

    DEVMODEW dmw;
    memset(&dmw, 0, sizeof(dmw));
    dmw.dmSize = sizeof(dmw);
    if (!hook_EnumDisplaySettingsExW(dev_w_ptr, iModeNum, &dmw, dwFlags)) {
        return FALSE;
    }

    WORD sz = lpDevMode->dmSize ? lpDevMode->dmSize : (WORD)sizeof(DEVMODEA);
    if (sz > sizeof(DEVMODEA)) sz = (WORD)sizeof(DEVMODEA);
    memset(lpDevMode, 0, sz);
    lpDevMode->dmSize = sz;
    if (dmw.dmDeviceName[0] != L'\0') {
        WideCharToMultiByte(CP_ACP, 0, (LPCWSTR)dmw.dmDeviceName, -1, (LPSTR)lpDevMode->dmDeviceName, CCHDEVICENAME, NULL, NULL);
        lpDevMode->dmDeviceName[CCHDEVICENAME - 1] = '\0';
    } else {
        strncpy((char *)lpDevMode->dmDeviceName, "\\\\.\\DISPLAY1", CCHDEVICENAME - 1);
    }
    ds_fill_devmode_a(lpDevMode, (int32_t)dmw.dmPelsWidth, (int32_t)dmw.dmPelsHeight, (int32_t)dmw.dmBitsPerPel, (int32_t)dmw.dmDisplayFrequency);
    if ((dmw.dmFields & DM_POSITION) != 0) {
        lpDevMode->dmPosition = dmw.dmPosition;
        lpDevMode->dmFields |= DM_POSITION;
    }
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
    ds_tracef("CDS rst=%d %dx%d@%d f=0x%lx h=%p",
              is_reset ? 1 : 0, (int)req_w, (int)req_h, (int)req_bpp, (unsigned long)dwFlags, (void *)g_ds.hwnd_game);
    if (is_reset) {
        ds_lock();
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
            ds_unlock();
            ds_tracef("CDS rst skip blur %dx%d",
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
        ds_unlock();
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

    ds_lock();
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
    ds_unlock();

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

static LONG ds_handle_vulkan_d3d9_change_display(bool is_reset, int32_t req_w, int32_t req_h, DWORD dwFlags)
{
    if ((dwFlags & CDS_TEST) != 0) {
        return DISP_CHANGE_SUCCESSFUL;
    }
    bool need_apply = false;
    ds_lock();
    if (is_reset) {
        g_ds.mode_virtualized = false;
        g_ds.virt_w = g_ds.real_screen_w;
        g_ds.virt_h = g_ds.real_screen_h;
        if (g_ds.fullscreen_active && !g_ds.user_forced_fullscreen) {
            g_ds.fullscreen_active = false;
            (void)ds_update_presenter_tier_locked();
            need_apply = true;
        }
        ds_refresh_viewport_locked();
        ds_cursor_warp_reset(&g_ds.warp);
    } else if (!g_ds.user_forced_windowed &&
               req_w >= 240 && req_h >= 180 &&
               (req_w < g_ds.phys_screen_w || req_h < g_ds.phys_screen_h)) {
        g_ds.virt_w = req_w;
        g_ds.virt_h = req_h;
        g_ds.mode_virtualized = true;
        g_ds.fullscreen_active = true;
        (void)ds_update_presenter_tier_locked();
        ds_refresh_viewport_locked();
        ds_cursor_warp_reset(&g_ds.warp);
        need_apply = true;
    }
    ds_unlock();
    if (need_apply) {
        ds_request_apply_presentation();
        ds_write_status_file();
    }
    return DISP_CHANGE_SUCCESSFUL;
}

static LONG ds_change_display_settings_common(
    bool        is_wide,
    const void *lpszDeviceName,
    void       *lpDevMode,
    HWND        hwnd,
    DWORD       dwFlags,
    LPVOID      lParam,
    const void *caller_ret
)
{
    if (!ds_is_internal_call()) {
        ds_ensure_runtime_started();
    }
    bool call_real = ds_is_internal_call();
    bool vk_d3d9 = false;
    if (!call_real) {
        ds_lock();
        bool modern_tier = ds_is_modern_tier_locked();
        vk_d3d9 = ds_is_vulkan_d3d9_locked();
        ds_unlock();
        call_real = (modern_tier && !vk_d3d9);
    }
    if (!call_real) {
        DWORD dm_fields = 0;
        int32_t w = 0, h = 0, bpp = 0, hz = 0;
        if (lpDevMode) {
            if (is_wide) {
                const DEVMODEW *dm = (const DEVMODEW *)lpDevMode;
                dm_fields = dm->dmFields;
                w = (dm_fields & DM_PELSWIDTH) ? (int32_t)dm->dmPelsWidth : 0;
                h = (dm_fields & DM_PELSHEIGHT) ? (int32_t)dm->dmPelsHeight : 0;
                bpp = (dm_fields & DM_BITSPERPEL) ? (int32_t)dm->dmBitsPerPel : 0;
                hz = (dm_fields & DM_DISPLAYFREQUENCY) ? (int32_t)dm->dmDisplayFrequency : g_ds.real_hz;
            } else {
                const DEVMODEA *dm = (const DEVMODEA *)lpDevMode;
                dm_fields = dm->dmFields;
                w = (dm_fields & DM_PELSWIDTH) ? (int32_t)dm->dmPelsWidth : 0;
                h = (dm_fields & DM_PELSHEIGHT) ? (int32_t)dm->dmPelsHeight : 0;
                bpp = (dm_fields & DM_BITSPERPEL) ? (int32_t)dm->dmBitsPerPel : 0;
                hz = (dm_fields & DM_DISPLAYFREQUENCY) ? (int32_t)dm->dmDisplayFrequency : g_ds.real_hz;
            }
        }
        if (vk_d3d9) {
            if (!lpDevMode) {
                return ds_handle_vulkan_d3d9_change_display(true, 0, 0, dwFlags);
            }
            int32_t vw = (dm_fields & DM_PELSWIDTH) ? w : g_ds.phys_screen_w;
            int32_t vh = (dm_fields & DM_PELSHEIGHT) ? h : g_ds.phys_screen_h;
            if (vw < g_ds.phys_screen_w || vh < g_ds.phys_screen_h) {
                return ds_handle_vulkan_d3d9_change_display(false, vw, vh, dwFlags);
            }
            if ((dwFlags & CDS_TEST) == 0) {
                ds_lock();
                g_ds.mode_virtualized = false;
                g_ds.virt_w = g_ds.real_screen_w;
                g_ds.virt_h = g_ds.real_screen_h;
                ds_refresh_viewport_locked();
                ds_cursor_warp_reset(&g_ds.warp);
                ds_unlock();
            }
            call_real = true;
        } else {
            if (!lpDevMode) {
                return ds_handle_change_display_mode(true, 0, 0, 0, 0, dwFlags, caller_ret);
            }
            if ((dm_fields & DM_PELSWIDTH) == 0) w = g_ds.real_screen_w;
            if ((dm_fields & DM_PELSHEIGHT) == 0) h = g_ds.real_screen_h;
            if (ds_prefer_16bpp_ddraw() && (bpp > 16 || bpp == 0) && w <= 640 && h <= 480) {
                bpp = 16;
                if (is_wide) {
                    ((DEVMODEW *)lpDevMode)->dmBitsPerPel = 16;
                    ((DEVMODEW *)lpDevMode)->dmFields |= DM_BITSPERPEL;
                } else {
                    ((DEVMODEA *)lpDevMode)->dmBitsPerPel = 16;
                    ((DEVMODEA *)lpDevMode)->dmFields |= DM_BITSPERPEL;
                }
            }
            return ds_handle_change_display_mode(false, w, h, bpp, hz, dwFlags, caller_ret);
        }
    }
    if (is_wide) {
        return g_ds.real_ChangeDisplaySettingsExW
            ? g_ds.real_ChangeDisplaySettingsExW((LPCWSTR)lpszDeviceName, (DEVMODEW *)lpDevMode, hwnd, dwFlags, lParam)
            : DISP_CHANGE_SUCCESSFUL;
    }
    return g_ds.real_ChangeDisplaySettingsExA
        ? g_ds.real_ChangeDisplaySettingsExA((LPCSTR)lpszDeviceName, (DEVMODEA *)lpDevMode, hwnd, dwFlags, lParam)
        : DISP_CHANGE_SUCCESSFUL;
}

static LONG WINAPI hook_ChangeDisplaySettingsExW(LPCWSTR lpszDeviceName, DEVMODEW *lpDevMode, HWND hwnd, DWORD dwFlags, LPVOID lParam)
{
    return ds_change_display_settings_common(true, lpszDeviceName, lpDevMode, hwnd, dwFlags, lParam, __builtin_return_address(0));
}

static LONG WINAPI hook_ChangeDisplaySettingsW(DEVMODEW *lpDevMode, DWORD dwFlags)
{
    return ds_change_display_settings_common(true, NULL, lpDevMode, NULL, dwFlags, NULL, __builtin_return_address(0));
}

static LONG WINAPI hook_ChangeDisplaySettingsExA(LPCSTR lpszDeviceName, DEVMODEA *lpDevMode, HWND hwnd, DWORD dwFlags, LPVOID lParam)
{
    return ds_change_display_settings_common(false, lpszDeviceName, lpDevMode, hwnd, dwFlags, lParam, __builtin_return_address(0));
}

static LONG WINAPI hook_ChangeDisplaySettingsA(DEVMODEA *lpDevMode, DWORD dwFlags)
{
    return ds_change_display_settings_common(false, NULL, lpDevMode, NULL, dwFlags, NULL, __builtin_return_address(0));
}

static int WINAPI hook_GetSystemMetrics(int nIndex)
{
    if (!ds_is_internal_call()) {
        ds_ensure_runtime_started();
    }
    if (!ds_is_internal_call() && ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        ds_lock();
        bool virt = g_ds.fullscreen_active && g_ds.virt_w > 0 && g_ds.virt_h > 0;
        int32_t vw = g_ds.virt_w;
        int32_t vh = g_ds.virt_h;
        ds_unlock();

        if (virt) {
            if (nIndex == SM_CXSCREEN || nIndex == SM_CXFULLSCREEN) {
                return vw;
            }
            if (nIndex == SM_CYSCREEN || nIndex == SM_CYFULLSCREEN) {
                return vh;
            }
            if (nIndex == SM_CXVIRTUALSCREEN || nIndex == SM_CYVIRTUALSCREEN ||
                nIndex == SM_XVIRTUALSCREEN || nIndex == SM_YVIRTUALSCREEN) {
                int num_mons = g_ds.real_GetSystemMetrics ? g_ds.real_GetSystemMetrics(SM_CMONITORS) : 1;
                if (num_mons <= 1) {
                    if (nIndex == SM_CXVIRTUALSCREEN) return vw;
                    if (nIndex == SM_CYVIRTUALSCREEN) return vh;
                    return 0;
                }
            }
        }
    }
    return g_ds.real_GetSystemMetrics ? g_ds.real_GetSystemMetrics(nIndex) : 0;
}

/* -------------------------------------------------------------------------
 * Window Geometry & Zero-Drift Cursor Hooks
 * ------------------------------------------------------------------------- */

static HWND ds_on_created_top_window(HWND hwnd, HWND parent, DWORD style, int w, int h)
{
    if (hwnd && !ds_is_internal_call() && parent == NULL && (style & WS_CHILD) == 0) {
        ds_attach_and_apply_game_window(hwnd, w > 0 ? w : 0, h > 0 ? h : 0);
    }
    return hwnd;
}

static HWND WINAPI hook_CreateWindowExW(DWORD dwExStyle, LPCWSTR lpClassName, LPCWSTR lpWindowName, DWORD dwStyle, int X, int Y, int nWidth, int nHeight, HWND hWndParent, HMENU hMenu, HINSTANCE hInstance, LPVOID lpParam)
{
    if (!ds_is_internal_call()) ds_ensure_runtime_started();
    HWND hwnd = g_ds.real_CreateWindowExW
        ? g_ds.real_CreateWindowExW(dwExStyle, lpClassName, lpWindowName, dwStyle, X, Y, nWidth, nHeight, hWndParent, hMenu, hInstance, lpParam)
        : NULL;
    return ds_on_created_top_window(hwnd, hWndParent, dwStyle, nWidth, nHeight);
}

static HWND WINAPI hook_CreateWindowExA(DWORD dwExStyle, LPCSTR lpClassName, LPCSTR lpWindowName, DWORD dwStyle, int X, int Y, int nWidth, int nHeight, HWND hWndParent, HMENU hMenu, HINSTANCE hInstance, LPVOID lpParam)
{
    if (!ds_is_internal_call()) ds_ensure_runtime_started();
    HWND hwnd = g_ds.real_CreateWindowExA
        ? g_ds.real_CreateWindowExA(dwExStyle, lpClassName, lpWindowName, dwStyle, X, Y, nWidth, nHeight, hWndParent, hMenu, hInstance, lpParam)
        : NULL;
    return ds_on_created_top_window(hwnd, hWndParent, dwStyle, nWidth, nHeight);
}

static BOOL ds_handle_show_window_hook(HWND hWnd, int nCmdShow, bool is_async)
{
    if (!ds_is_internal_call()) {
        ds_ensure_runtime_started();
    }
    pfn_ShowWindow_t fn = is_async ? (pfn_ShowWindow_t)g_ds.real_ShowWindowAsync : g_ds.real_ShowWindow;
    if (!fn) return FALSE;
    if (ds_is_internal_call() || !hWnd) {
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

    ds_lock();
    bool modern_tier = ds_is_modern_tier_locked();
    bool tier2_borderless = (ds_is_modern_borderless_locked() && hWnd == g_ds.hwnd_game && g_ds.borderless_active);
    bool is_game_fs = (
        !modern_tier &&
        hWnd == g_ds.hwnd_game &&
        g_ds.fullscreen_active &&
        g_ds.vp.dst_w > 0 &&
        g_ds.vp.dst_h > 0
    );
    ds_unlock();

    if (modern_tier) {
        if (tier2_borderless && is_minimize) {
            ds_demote_fullscreen_on_deactivate(hWnd);
            return TRUE;
        }
        return fn(hWnd, nCmdShow);
    }

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
        ds_lock();
        if (g_ds.app_inactive &&
            (nCmdShow == SW_RESTORE ||
             (nCmdShow != SW_SHOWNA && nCmdShow != SW_SHOWNOACTIVATE && ds_process_owns_foreground_window()))) {
            g_ds.app_inactive = false;
        }
        was_inactive = g_ds.app_inactive;
        ds_unlock();

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
        ds_lock();
        bool fs_dialog_raise = (
            hWnd != g_ds.hwnd_game &&
            g_ds.fullscreen_active &&
            !g_ds.app_inactive &&
            g_ds.real_SetWindowPos != NULL
        );
        ds_unlock();

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

    ds_lock();
    bool modern_tier = ds_is_modern_tier_locked();
    bool is_game_fs = (
        !modern_tier &&
        hWnd == g_ds.hwnd_game &&
        g_ds.fullscreen_active &&
        g_ds.vp.dst_w > 0 &&
        g_ds.vp.dst_h > 0
    );
    int32_t mon_x = g_ds.win_mon_x;
    int32_t mon_y = g_ds.win_mon_y;
    int32_t mon_w = g_ds.real_screen_w;
    int32_t mon_h = g_ds.real_screen_h;
    ds_unlock();

    if (modern_tier) {
        return g_ds.real_SetWindowPlacement(hWnd, lpwndpl);
    }

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
        patched.rcNormalPosition.left = mon_x;
        patched.rcNormalPosition.top = mon_y;
        patched.rcNormalPosition.right = mon_x + mon_w;
        patched.rcNormalPosition.bottom = mon_y + mon_h;
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
DS_ALWAYS_INLINE bool ds_try_promote_fullscreen_resize_locked(
    HWND hWnd,
    HWND hWndInsertAfter,
    int X,
    int Y,
    int cx,
    int cy,
    UINT uFlags,
    bool sys_caller,
    DWORD cur_style,
    bool is_vis)
{
    if (hWnd != g_ds.hwnd_game || g_ds.fullscreen_active || g_ds.user_forced_windowed ||
        ds_is_modern_tier_locked()) {
        return false;
    }
    if ((uFlags & (SWP_NOSIZE | SWP_HIDEWINDOW)) != 0 || cx < 240 || cy < 180 ||
        g_ds.real_screen_w <= 0 || g_ds.real_screen_h <= 0 ||
        (cx >= g_ds.real_screen_w && cy >= g_ds.real_screen_h)) {
        return false;
    }

    bool is_borderless_popup = (cur_style & WS_POPUP) != 0 &&
                               (cur_style & (WS_CAPTION | WS_THICKFRAME)) == 0;
    bool want_promote = false;
    if (sys_caller && (hWndInsertAfter == HWND_TOPMOST || is_borderless_popup)) {
        want_promote = true;
    } else if (!sys_caller && is_borderless_popup &&
               ((uFlags & SWP_NOMOVE) != 0 || (X == g_ds.win_mon_x && Y == g_ds.win_mon_y))) {
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
    if (is_vis) {
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
        ds_lock();
        bool is_legacy_tier = !ds_is_modern_tier_locked();
        bool is_vk_d3d9 = ds_is_vulkan_d3d9_locked();
        int32_t win_scale = ds_get_windowed_scale_locked();
        bool suppress_clamp = (
            target_hwnd == g_ds.hwnd_game &&
            ((is_legacy_tier &&
              (g_ds.fullscreen_active ||
               win_scale > 1 ||
               (!g_ds.user_forced_windowed &&
                (g_ds.mode_virtualized ||
                 (g_ds.real_screen_w > 0 && g_ds.real_screen_h > 0 &&
                  (rc_w < g_ds.real_screen_w || rc_h < g_ds.real_screen_h)))))) ||
             (ds_is_modern_borderless_locked() && (g_ds.borderless_active || is_vk_d3d9) && !g_ds.user_forced_windowed))
        );
        if (suppress_clamp && is_legacy_tier &&
            (!g_ds.mode_virtualized || g_ds.virt_w <= 0 || g_ds.virt_h <= 0 ||
             (g_ds.virt_w >= g_ds.real_screen_w && g_ds.virt_h >= g_ds.real_screen_h))) {
            g_ds.virt_w = rc_w;
            g_ds.virt_h = rc_h;
            ds_refresh_viewport_locked();
        }
        ds_unlock();

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

DS_ALWAYS_INLINE void ds_compute_centered_windowed_bounds(HWND hWnd, int32_t client_w, int32_t client_h, int *out_x, int *out_y, int *out_w, int *out_h)
{
    DWORD cur_style = (DWORD)ds_get_wnd_long_ptr(hWnd, GWL_STYLE);
    DWORD cur_exstyle = (DWORD)ds_get_wnd_long_ptr(hWnd, GWL_EXSTYLE);
    RECT wrc = { 0, 0, client_w, client_h };
    if (g_ds.real_AdjustWindowRectEx) {
        g_ds.real_AdjustWindowRectEx(&wrc, cur_style, FALSE, cur_exstyle);
    }
    int ww = wrc.right - wrc.left;
    int wh = wrc.bottom - wrc.top;
    int wx = g_ds.win_mon_x + (g_ds.real_screen_w - ww) / 2;
    int wy = g_ds.win_mon_y + (g_ds.real_screen_h - wh) / 2;
    *out_x = wx < g_ds.win_mon_x ? g_ds.win_mon_x : wx;
    *out_y = wy < g_ds.win_mon_y ? g_ds.win_mon_y : wy;
    *out_w = ww;
    *out_h = wh;
}

DS_ALWAYS_INLINE bool ds_is_hwnd_already_full_panel_internal(HWND hWnd)
{
    RECT cur_rc = { 0, 0, 0, 0 };
    return IsWindowVisible(hWnd) &&
           g_ds.real_GetWindowRect && g_ds.real_GetWindowRect(hWnd, &cur_rc) &&
           cur_rc.left == g_ds.win_mon_x && cur_rc.top == g_ds.win_mon_y &&
           (cur_rc.right - cur_rc.left) == g_ds.real_screen_w &&
           (cur_rc.bottom - cur_rc.top) == g_ds.real_screen_h;
}

static BOOL ds_call_real_pos_or_move(HWND hWnd, HWND after, int x, int y, int cx, int cy, UINT uFlags, BOOL bRepaint, bool is_move)
{
    return is_move
        ? g_ds.real_MoveWindow(hWnd, x, y, cx, cy, bRepaint)
        : g_ds.real_SetWindowPos(hWnd, after, x, y, cx, cy, uFlags);
}

static BOOL ds_set_or_move_window_common(
    HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy,
    UINT uFlags, BOOL bRepaint, bool is_move, const void *caller_ret
)
{
    if (!ds_is_internal_call()) {
        ds_ensure_runtime_started();
    }
    if (is_move ? (!g_ds.real_MoveWindow) : (!g_ds.real_SetWindowPos)) return FALSE;
    if (ds_is_internal_call() || !hWnd || (is_move && ds_is_passthrough_locked())) {
        return ds_call_real_pos_or_move(hWnd, hWndInsertAfter, X, Y, cx, cy, uFlags, bRepaint, is_move);
    }

    if (!is_move && g_ds.hwnd_game == NULL && (uFlags & SWP_HIDEWINDOW) == 0) {
        ds_attach_and_apply_game_window(hWnd, (uFlags & SWP_NOSIZE) == 0 ? cx : 0, (uFlags & SWP_NOSIZE) == 0 ? cy : 0);
    }

    bool sys_caller = ds_is_system_renderer_caller(caller_ret);
    DWORD cur_style = (DWORD)ds_get_wnd_long_ptr(hWnd, GWL_STYLE);
    bool is_vis = (IsWindowVisible(hWnd) != FALSE);
    ds_lock();
    bool modern_tier = ds_is_modern_tier_locked();
    if (modern_tier) {
        bool vk_d3d9 = ds_is_vulkan_d3d9_locked();
        bool is_target = (hWnd == g_ds.hwnd_game);
        bool app_inact = g_ds.app_inactive;
        int32_t mon_x = g_ds.win_mon_x;
        int32_t mon_y = g_ds.win_mon_y;
        int32_t mon_w = g_ds.real_screen_w;
        int32_t mon_h = g_ds.real_screen_h;
        bool promoted_vk = false;
        if (!is_move && vk_d3d9 && is_target && !g_ds.borderless_active && !g_ds.user_forced_windowed &&
            (uFlags & (SWP_NOSIZE | SWP_HIDEWINDOW)) == 0 &&
            cx >= 240 && cy >= 180 && mon_w > 0 && mon_h > 0 &&
            (cx < mon_w || cy < mon_h)) {
            bool borderless_popup = ((cur_style & WS_POPUP) != 0 && (cur_style & (WS_CAPTION | WS_THICKFRAME)) == 0);
            if ((sys_caller && (hWndInsertAfter == HWND_TOPMOST || borderless_popup)) ||
                (!sys_caller && borderless_popup && ((uFlags & SWP_NOMOVE) != 0 || (X == mon_x && Y == mon_y)))) {
                g_ds.virt_w = cx;
                g_ds.virt_h = cy;
                g_ds.mode_virtualized = true;
                g_ds.fullscreen_active = true;
                g_ds.borderless_active = true;
                g_ds.window_mutated_by_scaler = true;
                (void)ds_update_presenter_tier_locked();
                ds_refresh_viewport_locked();
                ds_cursor_warp_reset(&g_ds.warp);
                promoted_vk = true;
            }
        }
        bool enforce_borderless = (
            ds_is_modern_borderless_locked() &&
            is_target &&
            g_ds.borderless_active &&
            !app_inact &&
            mon_w > 0 && mon_h > 0
        );
        ds_unlock();
        if (enforce_borderless) {
            if (is_move) {
                HANDLE prev_dpi = ds_dpi_guard_enter_for_hwnd(hWnd);
                ds_enter_internal();
                ds_clear_wine_present_rect_on_hwnd(hWnd);
                BOOL bres = g_ds.real_MoveWindow(hWnd, mon_x, mon_y, mon_w, mon_h, bRepaint);
                ds_leave_internal();
                ds_dpi_guard_leave(prev_dpi);
                return bres;
            }
            UINT eff_flags = promoted_vk
                ? ((uFlags & ~(UINT)(SWP_NOMOVE | SWP_NOSIZE)) | SWP_FRAMECHANGED)
                : uFlags;
            int nx = (eff_flags & SWP_NOMOVE) ? X : mon_x;
            int ny = (eff_flags & SWP_NOMOVE) ? Y : mon_y;
            int ncx = (eff_flags & SWP_NOSIZE) ? cx : mon_w;
            int ncy = (eff_flags & SWP_NOSIZE) ? cy : mon_h;
            BOOL bres = ds_set_window_pos_dpi(hWnd, HWND_TOPMOST, nx, ny, ncx, ncy, eff_flags, true);
            if (promoted_vk) {
                ds_write_status_file();
            }
            return bres;
        }
        return ds_call_real_pos_or_move(hWnd, hWndInsertAfter, X, Y, cx, cy, uFlags, bRepaint, is_move);
    }

    bool promoted_fs = ds_try_promote_fullscreen_resize_locked(hWnd, hWndInsertAfter, X, Y, cx, cy, uFlags, sys_caller, cur_style, is_vis);
    bool is_game_fs = (hWnd == g_ds.hwnd_game && g_ds.fullscreen_active && g_ds.vp.dst_w > 0 && g_ds.vp.dst_h > 0);
    bool app_inactive = g_ds.app_inactive;
    bool staging_birth = (!is_move && is_game_fs && !g_ds.cocoa_fs_synced && g_ds.first_visible_tick != 0 &&
                          (GetTickCount() - g_ds.first_visible_tick) < 250);
    int32_t win_scale = (hWnd == g_ds.hwnd_game && !g_ds.fullscreen_active) ? ds_get_windowed_scale_locked() : 1;
    int32_t vw = g_ds.virt_w;
    int32_t vh = g_ds.virt_h;
    int32_t mon_x = g_ds.win_mon_x;
    int32_t mon_y = g_ds.win_mon_y;
    int32_t mon_w = g_ds.real_screen_w;
    int32_t mon_h = g_ds.real_screen_h;
    if (!is_move && !promoted_fs && is_game_fs && (uFlags & SWP_NOSIZE) == 0 && cx >= 240 && cy >= 180 &&
        !sys_caller && !g_ds.mode_virtualized) {
        g_ds.virt_w = cx;
        g_ds.virt_h = cy;
        vw = cx;
        vh = cy;
        ds_refresh_viewport_locked();
    }
    if (is_game_fs) {
        g_ds.window_mutated_by_scaler = true;
    }
    ds_unlock();

    if (is_game_fs) {
        if (GetCurrentThreadId() == g_ds.game_thread_id) {
            ds_ensure_fullscreen_styles_on_owner_thread(hWnd);
        }
        int nx = staging_birth ? (int)(mon_x + (mon_w - 640) / 2) : ((uFlags & SWP_NOMOVE) ? X : mon_x);
        int ny = staging_birth ? (int)(mon_y + (mon_h - 480) / 2) : ((uFlags & SWP_NOMOVE) ? Y : mon_y);
        int ncx = staging_birth ? 640 : ((uFlags & SWP_NOSIZE) ? cx : mon_w);
        int ncy = staging_birth ? 480 : ((uFlags & SWP_NOSIZE) ? cy : mon_h);
        HWND z_order = app_inactive ? HWND_NOTOPMOST : HWND_TOPMOST;
        UINT eff_flags = app_inactive ? (uFlags | SWP_NOACTIVATE) : uFlags;
        if (promoted_fs) {
            eff_flags |= SWP_FRAMECHANGED;
        }
        ds_enter_internal();
        bool already_full = !staging_birth && !promoted_fs && (is_move || !app_inactive) &&
                            ds_is_hwnd_already_full_panel_internal(hWnd) &&
                            (is_move || (eff_flags & (SWP_HIDEWINDOW | SWP_FRAMECHANGED)) == 0);
        BOOL res = TRUE;
        if (already_full && is_move) {
            if (bRepaint) InvalidateRect(hWnd, NULL, FALSE);
        } else {
            if (already_full) {
                eff_flags = (eff_flags & ~(UINT)SWP_SHOWWINDOW) | SWP_NOMOVE | SWP_NOSIZE;
            } else {
                ds_clear_wine_present_rect_on_hwnd(hWnd);
            }
            res = ds_call_real_pos_or_move(hWnd, z_order, nx, ny, ncx, ncy, eff_flags, bRepaint, is_move);
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
        int nx = (uFlags & SWP_NOMOVE) ? X : wx;
        int ny = (uFlags & SWP_NOMOVE) ? Y : wy;
        int ncx = (uFlags & SWP_NOSIZE) ? cx : ww;
        int ncy = (uFlags & SWP_NOSIZE) ? cy : wh;
        ds_enter_internal();
        ds_clear_wine_present_rect_on_hwnd(hWnd);
        BOOL res = ds_call_real_pos_or_move(hWnd, HWND_NOTOPMOST, nx, ny, ncx, ncy, uFlags, bRepaint, is_move);
        ds_leave_internal();
        if (GetCurrentThreadId() == g_ds.game_thread_id) {
            ds_sync_gl_host_bounds_on_owner_thread(hWnd);
        }
        return res;
    }

    BOOL res = ds_call_real_pos_or_move(hWnd, hWndInsertAfter, X, Y, cx, cy, uFlags, bRepaint, is_move);
    if (hWnd == g_ds.hwnd_game && GetCurrentThreadId() == g_ds.game_thread_id) {
        ds_sync_gl_host_bounds_on_owner_thread(hWnd);
    }
    return res;
}

static BOOL WINAPI hook_SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, UINT uFlags)
{
    return ds_set_or_move_window_common(hWnd, hWndInsertAfter, X, Y, cx, cy, uFlags, FALSE, false, __builtin_return_address(0));
}

static BOOL WINAPI hook_MoveWindow(HWND hWnd, int X, int Y, int nWidth, int nHeight, BOOL bRepaint)
{
    return ds_set_or_move_window_common(hWnd, NULL, X, Y, nWidth, nHeight, 0, bRepaint, true, __builtin_return_address(0));
}

static LONG_PTR ds_handle_get_window_long(HWND hWnd, int nIndex, bool unicode)
{
    if (!ds_is_internal_call() && hWnd != NULL && nIndex == GWLP_WNDPROC) {
        ds_lock();
        WNDPROC orig = (hWnd == g_ds.hwnd_game) ? g_ds.orig_wndproc : NULL;
        ds_unlock();
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
        ds_lock();
        bool is_game = (hWnd == g_ds.hwnd_game);
        DWORD owner_tid = g_ds.game_thread_id;
        WNDPROC prev_orig = g_ds.orig_wndproc;
        bool prev_unicode = g_ds.orig_wndproc_unicode;
        if (is_game && (WNDPROC)dwNewLong == ds_game_subclass_wndproc) {
            ds_unlock();
            return (LONG_PTR)prev_orig;
        }
        bool should_rehook = (is_game && (prev_orig != NULL || GetCurrentThreadId() == owner_tid));
        ds_unlock();

        if (should_rehook) {
            /*
             * Keep `ds_game_subclass_wndproc` installed as the outermost `win32u` WndProc
             * when `wined3d` (`wined3d_register_window` / `entry_restore_proc`), SDL, or the
             * game subclasses `GWLP_WNDPROC` after window creation, while syncing per-HWND
             * `DS_PROP_ORIG_*` props outside `ds_lock()`.
             */
            ds_set_hwnd_orig_wndproc_props(hWnd, (WNDPROC)dwNewLong, unicode);
            LONG_PTR ret_for_caller = 0;
            ds_enter_internal();
            if (prev_orig != NULL) {
                ds_set_wnd_long_ptr_raw(hWnd, GWLP_WNDPROC, (LONG_PTR)prev_orig, prev_unicode);
            }
            ret_for_caller = ds_set_wnd_long_ptr_raw(hWnd, GWLP_WNDPROC, (LONG_PTR)ds_game_subclass_wndproc, unicode);
            ds_leave_internal();

            ds_lock();
            if (g_ds.hwnd_game == hWnd) {
                g_ds.orig_wndproc = (WNDPROC)dwNewLong;
                g_ds.orig_wndproc_unicode = unicode;
            }
            ds_unlock();
            return ret_for_caller ? ret_for_caller : (LONG_PTR)prev_orig;
        }
    }

    if (!ds_is_internal_call() && hWnd != NULL && (nIndex == GWL_STYLE || nIndex == GWL_EXSTYLE)) {
        ds_lock();
        bool modern_tier = ds_is_modern_tier_locked();
        bool is_game_fs = (!modern_tier && hWnd == g_ds.hwnd_game && g_ds.fullscreen_active);
        bool app_inactive = g_ds.app_inactive;
        LONG_PTR prev_saved = (nIndex == GWL_STYLE) ? g_ds.saved_style : g_ds.saved_exstyle;
        if (is_game_fs && !ds_is_system_renderer_caller(caller_ret)) {
            if (nIndex == GWL_STYLE) {
                g_ds.saved_style = dwNewLong;
            } else {
                g_ds.saved_exstyle = dwNewLong;
            }
        }
        ds_unlock();

        if (modern_tier) {
            return ds_set_wnd_long_ptr_raw(hWnd, nIndex, dwNewLong, unicode);
        }

        if (is_game_fs) {
            LONG_PTR fs_st = 0, fs_ex = 0;
            ds_compute_fs_styles(
                (nIndex == GWL_STYLE) ? dwNewLong : 0,
                (nIndex == GWL_EXSTYLE) ? dwNewLong : 0,
                app_inactive,
                &fs_st,
                &fs_ex
            );
            ds_enter_internal();
            ds_set_wnd_long_ptr_raw(hWnd, nIndex, (nIndex == GWL_STYLE) ? fs_st : fs_ex, unicode);
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

static bool ds_try_get_virt_rect(HWND hWnd, LPRECT lpRect, bool allow_win_scale, const void *caller_ret)
{
    if (!ds_is_internal_call() && ds_should_virtualize_rect_for_caller(caller_ret)) {
        HWND desk = GetDesktopWindow();
        ds_lock();
        bool match = (hWnd != NULL &&
                      ((hWnd == g_ds.hwnd_game && (g_ds.fullscreen_active || (allow_win_scale && ds_get_windowed_scale_locked() > 1))) ||
                       (hWnd == desk && g_ds.fullscreen_active)) &&
                      g_ds.virt_w > 0 && g_ds.virt_h > 0);
        int32_t vw = g_ds.virt_w;
        int32_t vh = g_ds.virt_h;
        ds_unlock();
        if (match) {
            lpRect->left = 0;
            lpRect->top = 0;
            lpRect->right = vw;
            lpRect->bottom = vh;
            return true;
        }
    }
    return false;
}

static BOOL WINAPI hook_GetClientRect(HWND hWnd, LPRECT lpRect)
{
    if (!lpRect) return FALSE;
    if (ds_try_get_virt_rect(hWnd, lpRect, true, __builtin_return_address(0))) return TRUE;
    return g_ds.real_GetClientRect ? g_ds.real_GetClientRect(hWnd, lpRect) : FALSE;
}

static BOOL WINAPI hook_GetWindowRect(HWND hWnd, LPRECT lpRect)
{
    if (!lpRect) return FALSE;
    if (ds_try_get_virt_rect(hWnd, lpRect, false, __builtin_return_address(0))) return TRUE;
    return g_ds.real_GetWindowRect ? g_ds.real_GetWindowRect(hWnd, lpRect) : FALSE;
}

static void ds_virtualize_monitor_info(HMONITOR hMonitor, LPMONITORINFO lpmi, const void *caller_ret)
{
    if (!lpmi || ds_is_internal_call()) return;
    if (ds_should_virtualize_rect_for_caller(caller_ret)) {
        ds_lock();
        bool is_target_mon = (g_ds.target_monitor == NULL || hMonitor == g_ds.target_monitor);
        bool virt = is_target_mon && g_ds.fullscreen_active && g_ds.virt_w > 0 && g_ds.virt_h > 0;
        int32_t vw = g_ds.virt_w;
        int32_t vh = g_ds.virt_h;
        ds_unlock();
        if (virt) {
            lpmi->rcMonitor.left = 0;
            lpmi->rcMonitor.top = 0;
            lpmi->rcMonitor.right = vw;
            lpmi->rcMonitor.bottom = vh;
            lpmi->rcWork = lpmi->rcMonitor;
        }
    }
}

static BOOL WINAPI hook_GetMonitorInfoW(HMONITOR hMonitor, LPMONITORINFO lpmi)
{
    if (!g_ds.real_GetMonitorInfoW) return FALSE;
    BOOL ok = g_ds.real_GetMonitorInfoW(hMonitor, lpmi);
    if (ok) ds_virtualize_monitor_info(hMonitor, lpmi, __builtin_return_address(0));
    return ok;
}

static BOOL WINAPI hook_GetMonitorInfoA(HMONITOR hMonitor, LPMONITORINFO lpmi)
{
    if (!g_ds.real_GetMonitorInfoA) return FALSE;
    BOOL ok = g_ds.real_GetMonitorInfoA(hMonitor, lpmi);
    if (ok) ds_virtualize_monitor_info(hMonitor, lpmi, __builtin_return_address(0));
    return ok;
}

static bool ds_get_client_origin_internal(HWND hwnd, POINT *out)
{
    if (!out || !hwnd || !IsWindow(hwnd) || !g_ds.real_ClientToScreen) {
        return false;
    }
    out->x = 0;
    out->y = 0;
    ds_enter_internal();
    BOOL ok = g_ds.real_ClientToScreen(hwnd, out);
    ds_leave_internal();
    return ok != FALSE;
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

    ds_lock();
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
            g_ds.win_mon_x + g_ds.vp.dst_x,
            g_ds.win_mon_y + g_ds.vp.dst_y,
            g_ds.vp.dst_w,
            g_ds.vp.dst_h,
            vw,
            vh,
            &vx,
            &vy
        );
    } else if (win_scale > 1) {
        POINT orig;
        if (ds_get_client_origin_internal(hwnd_game, &orig)) {
            int32_t rel_vx = 0, rel_vy = 0;
            ds_cursor_resolve_get_pos(
                &g_ds.warp, phys.x, phys.y, orig.x, orig.y, vw * win_scale, vh * win_scale, vw, vh, &rel_vx, &rel_vy
            );
            vx = orig.x + rel_vx;
            vy = orig.y + rel_vy;
        }
    }
    ds_unlock();

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
    ds_lock();
    int32_t win_scale = ds_get_windowed_scale_locked();
    HWND hwnd_game = g_ds.hwnd_game;
    if (g_ds.fullscreen_active && g_ds.virt_w > 0 && g_ds.virt_h > 0 && g_ds.vp.dst_w > 0 && g_ds.vp.dst_h > 0) {
        ds_cursor_record_warp(
            &g_ds.warp,
            X,
            Y,
            g_ds.win_mon_x + g_ds.vp.dst_x,
            g_ds.win_mon_y + g_ds.vp.dst_y,
            g_ds.vp.dst_w,
            g_ds.vp.dst_h,
            g_ds.virt_w,
            g_ds.virt_h,
            &px,
            &py
        );
    } else if (win_scale > 1) {
        POINT orig;
        if (ds_get_client_origin_internal(hwnd_game, &orig)) {
            ds_cursor_record_warp(
                &g_ds.warp, X - orig.x, Y - orig.y, orig.x, orig.y,
                g_ds.virt_w * win_scale, g_ds.virt_h * win_scale, g_ds.virt_w, g_ds.virt_h, &px, &py
            );
        }
    }
    ds_unlock();
    return g_ds.real_SetCursorPos(px, py);
}

static BOOL WINAPI hook_ClipCursor(const RECT *lpRect)
{
    if (!g_ds.real_ClipCursor) return FALSE;
    if (ds_is_internal_call() || !ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        return g_ds.real_ClipCursor(lpRect);
    }

    ds_lock();
    if (!lpRect) {
        g_ds.has_virtual_clip = false;
        ds_unlock();
        return g_ds.real_ClipCursor(NULL);
    }
    g_ds.has_virtual_clip = true;
    g_ds.virtual_clip_rect = *lpRect;
    if (g_ds.fullscreen_active) {
        ds_reapply_cursor_clip_locked();
        ds_unlock();
        return TRUE;
    }
    int32_t win_scale = ds_get_windowed_scale_locked();
    HWND hwnd_game = g_ds.hwnd_game;
    int32_t vw = g_ds.virt_w;
    int32_t vh = g_ds.virt_h;
    RECT vclip = *lpRect;
    ds_unlock();

    POINT orig;
    if (win_scale > 1 && vw > 0 && vh > 0 && ds_get_client_origin_internal(hwnd_game, &orig)) {
        int32_t rw = vclip.right - vclip.left;
        int32_t rh = vclip.bottom - vclip.top;
        int32_t px = 0, py = 0, pw = 0, ph = 0;
        if (rw > 0 && rh > 0 &&
            ds_map_subrect_virt_to_phys(
                vclip.left - orig.x, vclip.top - orig.y, rw, rh,
                orig.x, orig.y, vw * win_scale, vh * win_scale, vw, vh, &px, &py, &pw, &ph)) {
            RECT phys_clip = { px, py, px + pw, py + ph };
            return g_ds.real_ClipCursor(&phys_clip);
        }
    }
    return g_ds.real_ClipCursor(lpRect);
}

static BOOL WINAPI hook_GetClipCursor(LPRECT lpRect)
{
    if (!lpRect || !g_ds.real_GetClipCursor) return FALSE;
    if (!ds_is_internal_call() && ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        ds_lock();
        if (g_ds.has_virtual_clip) {
            *lpRect = g_ds.virtual_clip_rect;
            ds_unlock();
            return TRUE;
        }
        if (g_ds.fullscreen_active && g_ds.virt_w > 0 && g_ds.virt_h > 0) {
            lpRect->left = 0;
            lpRect->top = 0;
            lpRect->right = g_ds.virt_w;
            lpRect->bottom = g_ds.virt_h;
            ds_unlock();
            return TRUE;
        }
        ds_unlock();
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

    ds_lock();
    int32_t win_scale = ds_get_windowed_scale_locked();
    HWND hwnd_game = g_ds.hwnd_game;
    int32_t vw = g_ds.virt_w;
    int32_t vh = g_ds.virt_h;
    if (g_ds.fullscreen_active && vw > 0 && vh > 0 && g_ds.vp.dst_w > 0 && g_ds.vp.dst_h > 0) {
        ds_map_cursor_phys_to_virt(
            px, py, g_ds.win_mon_x + g_ds.vp.dst_x, g_ds.win_mon_y + g_ds.vp.dst_y,
            g_ds.vp.dst_w, g_ds.vp.dst_h, vw, vh, &vx, &vy
        );
        mapped = true;
    } else if (win_scale > 1 && vw > 0 && vh > 0) {
        POINT orig;
        if (ds_get_client_origin_internal(hwnd_game, &orig)) {
            int32_t rel_vx = 0, rel_vy = 0;
            ds_map_cursor_phys_to_virt(px, py, orig.x, orig.y, vw * win_scale, vh * win_scale, vw, vh, &rel_vx, &rel_vy);
            vx = orig.x + rel_vx;
            vy = orig.y + rel_vy;
            mapped = true;
        }
    }
    ds_unlock();

    return mapped ? (DWORD)MAKELONG((WORD)(short)vx, (WORD)(short)vy) : raw;
}

static LONG ds_remap_raw_axis(LONG raw_v, double base, double span, int32_t dst_origin, int32_t dst_dim)
{
    double phys = base + ((double)raw_v * span) / 65535.0;
    double norm = ((phys - (double)dst_origin) * 65535.0) / (double)dst_dim;
    if (norm < 0.0) norm = 0.0;
    if (norm > 65535.0) norm = 65535.0;
    return (LONG)(norm + 0.5);
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

    ds_lock();
    bool fs_active = (
        (!ds_is_modern_tier_locked() || ds_is_vulkan_d3d9_subnative_locked()) &&
        g_ds.fullscreen_active &&
        g_ds.real_screen_w > 0 &&
        g_ds.real_screen_h > 0 &&
        g_ds.vp.dst_w > 0 &&
        g_ds.vp.dst_h > 0
    );
    int32_t mon_x = g_ds.win_mon_x;
    int32_t mon_y = g_ds.win_mon_y;
    int32_t rsw = g_ds.real_screen_w;
    int32_t rsh = g_ds.real_screen_h;
    ds_viewport_t vp = g_ds.vp;
    ds_unlock();

    if (!fs_active) {
        return;
    }

    double base_x = 0.0;
    double base_y = 0.0;
    double span_w = (double)rsw;
    double span_h = (double)rsh;
    if ((raw->data.mouse.usFlags & MOUSE_VIRTUAL_DESKTOP) != 0 && g_ds.real_GetSystemMetrics) {
        ds_enter_internal();
        int32_t vx0 = g_ds.real_GetSystemMetrics(SM_XVIRTUALSCREEN);
        int32_t vy0 = g_ds.real_GetSystemMetrics(SM_YVIRTUALSCREEN);
        int32_t vsw = g_ds.real_GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int32_t vsh = g_ds.real_GetSystemMetrics(SM_CYVIRTUALSCREEN);
        ds_leave_internal();
        if (vsw > 0 && vsh > 0) {
            base_x = (double)vx0;
            base_y = (double)vy0;
            span_w = (double)vsw;
            span_h = (double)vsh;
        }
    } else if (g_ds.real_GetSystemMetrics) {
        ds_enter_internal();
        int32_t pw = g_ds.real_GetSystemMetrics(SM_CXSCREEN);
        int32_t ph = g_ds.real_GetSystemMetrics(SM_CYSCREEN);
        ds_leave_internal();
        if (pw > 0 && ph > 0) {
            span_w = (double)pw;
            span_h = (double)ph;
        }
    }

    raw->data.mouse.lLastX = ds_remap_raw_axis(raw->data.mouse.lLastX, base_x, span_w, mon_x + vp.dst_x, vp.dst_w);
    raw->data.mouse.lLastY = ds_remap_raw_axis(raw->data.mouse.lLastY, base_y, span_h, mon_y + vp.dst_y, vp.dst_h);
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
                ds_lock();
                g_ds.raw_mouse_nolegacy = want_confine;
                if (want_confine && g_ds.fullscreen_active && !g_ds.app_inactive) {
                    ds_reapply_cursor_clip_locked();
                }
                ds_unlock();
            }
        }
    }
    return ok;
}

static BOOL ds_client_screen_common(HWND hWnd, LPPOINT lpPoint, bool to_screen, const void *caller_ret)
{
    if (!lpPoint) return FALSE;
    if (!ds_is_internal_call() && ds_should_virtualize_rect_for_caller(caller_ret)) {
        ds_lock();
        bool is_game_fs = (hWnd != NULL && hWnd == g_ds.hwnd_game && g_ds.fullscreen_active);
        bool is_game_win_scaled = (hWnd != NULL && hWnd == g_ds.hwnd_game && !g_ds.fullscreen_active && ds_get_windowed_scale_locked() > 1);
        ds_unlock();
        if (is_game_fs) {
            return TRUE;
        }
        POINT orig;
        if (is_game_win_scaled && ds_get_client_origin_internal(hWnd, &orig)) {
            lpPoint->x += to_screen ? orig.x : -orig.x;
            lpPoint->y += to_screen ? orig.y : -orig.y;
            return TRUE;
        }
    }
    return to_screen
        ? (g_ds.real_ClientToScreen ? g_ds.real_ClientToScreen(hWnd, lpPoint) : FALSE)
        : (g_ds.real_ScreenToClient ? g_ds.real_ScreenToClient(hWnd, lpPoint) : FALSE);
}

static BOOL WINAPI hook_ScreenToClient(HWND hWnd, LPPOINT lpPoint)
{
    return ds_client_screen_common(hWnd, lpPoint, false, __builtin_return_address(0));
}

static BOOL WINAPI hook_ClientToScreen(HWND hWnd, LPPOINT lpPoint)
{
    return ds_client_screen_common(hWnd, lpPoint, true, __builtin_return_address(0));
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

        ds_lock();
        HWND hwnd_game = g_ds.hwnd_game;
        bool fs_active = g_ds.fullscreen_active;
        int32_t win_scale = ds_get_windowed_scale_locked();
        ds_unlock();

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
                POINT orig;
                if (win_scale > 1 && ds_get_client_origin_internal(hwnd_game, &orig)) {
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
    return g_ds.real_MapWindowPoints ? g_ds.real_MapWindowPoints(hWndFrom, hWndTo, lpPoints, cPoints) : 0;
}

static HWND WINAPI hook_WindowFromPoint(POINT Point)
{
    if (!g_ds.real_WindowFromPoint) return NULL;
    if (ds_is_internal_call() || !ds_should_virtualize_rect_for_caller(__builtin_return_address(0))) {
        return g_ds.real_WindowFromPoint(Point);
    }

    POINT phys = Point;
    ds_lock();
    HWND hwnd_game = g_ds.hwnd_game;
    HWND hwnd_gl_host = g_ds.hwnd_gl_host;
    int32_t win_scale = ds_get_windowed_scale_locked();
    int32_t vw = g_ds.virt_w, vh = g_ds.virt_h;
    int32_t px = phys.x, py = phys.y, pw = 1, ph = 1;
    if (g_ds.fullscreen_active && vw > 0 && vh > 0 && g_ds.vp.dst_w > 0 && g_ds.vp.dst_h > 0) {
        if (ds_map_subrect_virt_to_phys(
                Point.x, Point.y, 1, 1,
                g_ds.win_mon_x + g_ds.vp.dst_x, g_ds.win_mon_y + g_ds.vp.dst_y,
                g_ds.vp.dst_w, g_ds.vp.dst_h, vw, vh, &px, &py, &pw, &ph)) {
            phys.x = px;
            phys.y = py;
        }
    } else if (win_scale > 1 && vw > 0 && vh > 0) {
        POINT orig;
        if (ds_get_client_origin_internal(hwnd_game, &orig) &&
            ds_map_subrect_virt_to_phys(
                Point.x - orig.x, Point.y - orig.y, 1, 1,
                orig.x, orig.y, vw * win_scale, vh * win_scale, vw, vh, &px, &py, &pw, &ph)) {
            phys.x = px;
            phys.y = py;
        }
    }
    ds_unlock();

    HWND hit = g_ds.real_WindowFromPoint(phys);
    return (hit != NULL && hit == hwnd_gl_host && hwnd_game != NULL) ? hwnd_game : hit;
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
                    ds_tracef("cross-arch APC helper exit=%lu", (unsigned long)helper_exit);
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

static void ds_ascii_to_w(const char *a, WCHAR *w, size_t cap)
{
    size_t i = 0;
    while (a && a[i] && i + 1 < cap) {
        w[i] = (WCHAR)(unsigned char)a[i];
        i++;
    }
    if (cap > 0) w[i] = L'\0';
}

static void ds_append_kv_if_missing_w(WCHAR **buf, size_t *len, size_t *cap, const char *key_a, const WCHAR *val)
{
    if (!key_a || !key_a[0] || !val || !val[0]) return;
    WCHAR key[48];
    ds_ascii_to_w(key_a, key, 48);
    size_t klen = wcslen(key);
    if (ds_env_block_has_key_w(*buf, *len, key, klen)) return;
    WCHAR line[MAX_PATH + 96];
    int n = _snwprintf(line, (sizeof(line) / sizeof(line[0])) - 1, L"%ls=%ls", key, val);
    if (n > 0) {
        line[(sizeof(line) / sizeof(line[0])) - 1] = L'\0';
        (void)ds_append_env_entry_w(buf, len, cap, line, wcslen(line));
    }
}

typedef struct {
    uint16_t field_off;
    char     key[36];
} ds_path_env_t;

static const ds_path_env_t k_ds_path_envs[] = {
    { (uint16_t)offsetof(ds_runtime_t, dll_x86),      "ONE_LAUNCHER_SCALER_DLL_X86" },
    { (uint16_t)offsetof(ds_runtime_t, dll_x64),      "ONE_LAUNCHER_SCALER_DLL_X64" },
    { (uint16_t)offsetof(ds_runtime_t, launcher_x86), "ONE_LAUNCHER_LAUNCHER_EXE_X86" },
    { (uint16_t)offsetof(ds_runtime_t, launcher_x64), "ONE_LAUNCHER_LAUNCHER_EXE_X64" },
    { (uint16_t)offsetof(ds_runtime_t, control_file), "ONE_LAUNCHER_DISPLAY_CONTROL_FILE" },
    { (uint16_t)offsetof(ds_runtime_t, status_file),  "ONE_LAUNCHER_DISPLAY_STATUS_FILE" },
    { (uint16_t)offsetof(ds_runtime_t, trace_file),   "ONE_LAUNCHER_DISPLAY_TRACE_FILE" },
};

DS_ALWAYS_INLINE WCHAR *ds_path_env_field(size_t idx)
{
    return (WCHAR *)(void *)((uint8_t *)&g_ds + k_ds_path_envs[idx].field_off);
}

static WCHAR *ds_build_merged_child_env_w(LPVOID caller_env, DWORD caller_flags)
{
    if (!caller_env) {
        /* When inheriting parent's env block, ensure auto-discovered paths/session files are exported */
        for (size_t i = 0; i < 6; i++) {
            WCHAR *f = ds_path_env_field(i);
            if (f[0]) {
                WCHAR wk[48];
                ds_ascii_to_w(k_ds_path_envs[i].key, wk, 48);
                SetEnvironmentVariableW(wk, f);
            }
        }
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

    ds_lock();
    for (size_t i = 0; i < sizeof(k_ds_path_envs) / sizeof(k_ds_path_envs[0]); i++) {
        ds_append_kv_if_missing_w(&out_buf, &out_len, &out_cap, k_ds_path_envs[i].key, ds_path_env_field(i));
    }
    ds_unlock();

    if (!out_buf) {
        out_buf = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 2 * sizeof(WCHAR));
    }
    return out_buf;
}

DS_ALWAYS_INLINE BOOL ds_finish_created_process(
    BOOL ok, DWORD last_err, WCHAR *merged_env, bool caller_suspended,
    LPPROCESS_INFORMATION caller_pi, LPPROCESS_INFORMATION out_pi
)
{
    if (merged_env) {
        HeapFree(GetProcessHeap(), 0, merged_env);
        SetLastError(last_err);
    }
    if (!ok) return FALSE;
    ds_inject_into_suspended_child(out_pi);
    if (!caller_suspended) {
        ResumeThread(out_pi->hThread);
    }
    if (!caller_pi) {
        CloseHandle(out_pi->hThread);
        CloseHandle(out_pi->hProcess);
    }
    return TRUE;
}

static BOOL ds_create_process_common(
    bool is_wide, const void *lpApp, void *lpCmd, LPSECURITY_ATTRIBUTES lpPA,
    LPSECURITY_ATTRIBUTES lpTA, BOOL bInherit, DWORD dwFlags, LPVOID lpEnv,
    const void *lpDir, void *lpSI, LPPROCESS_INFORMATION lpPI
)
{
    if (is_wide ? !g_ds.real_CreateProcessW : !g_ds.real_CreateProcessA) return FALSE;
    if (ds_is_internal_call()) {
        return is_wide
            ? g_ds.real_CreateProcessW((LPCWSTR)lpApp, (LPWSTR)lpCmd, lpPA, lpTA, bInherit, dwFlags, lpEnv, (LPCWSTR)lpDir, (LPSTARTUPINFOW)lpSI, lpPI)
            : g_ds.real_CreateProcessA((LPCSTR)lpApp, (LPSTR)lpCmd, lpPA, lpTA, bInherit, dwFlags, lpEnv, (LPCSTR)lpDir, (LPSTARTUPINFOA)lpSI, lpPI);
    }
    PROCESS_INFORMATION local_pi;
    memset(&local_pi, 0, sizeof(local_pi));
    LPPROCESS_INFORMATION out_pi = lpPI ? lpPI : &local_pi;
    WCHAR *merged_env = ds_build_merged_child_env_w(lpEnv, dwFlags);
    DWORD eff_flags = (merged_env ? (dwFlags | CREATE_UNICODE_ENVIRONMENT) : dwFlags) | CREATE_SUSPENDED;
    LPVOID eff_env = merged_env ? (LPVOID)merged_env : lpEnv;
    BOOL ok = is_wide
        ? g_ds.real_CreateProcessW((LPCWSTR)lpApp, (LPWSTR)lpCmd, lpPA, lpTA, bInherit, eff_flags, eff_env, (LPCWSTR)lpDir, (LPSTARTUPINFOW)lpSI, out_pi)
        : g_ds.real_CreateProcessA((LPCSTR)lpApp, (LPSTR)lpCmd, lpPA, lpTA, bInherit, eff_flags, eff_env, (LPCSTR)lpDir, (LPSTARTUPINFOA)lpSI, out_pi);
    return ds_finish_created_process(ok, GetLastError(), merged_env, (dwFlags & CREATE_SUSPENDED) != 0, lpPI, out_pi);
}

static BOOL WINAPI hook_CreateProcessW(LPCWSTR lpApp, LPWSTR lpCmd, LPSECURITY_ATTRIBUTES lpPA, LPSECURITY_ATTRIBUTES lpTA, BOOL bInherit, DWORD dwFlags, LPVOID lpEnv, LPCWSTR lpDir, LPSTARTUPINFOW lpSI, LPPROCESS_INFORMATION lpPI)
{
    return ds_create_process_common(true, lpApp, lpCmd, lpPA, lpTA, bInherit, dwFlags, lpEnv, lpDir, lpSI, lpPI);
}

static BOOL WINAPI hook_CreateProcessA(LPCSTR lpApp, LPSTR lpCmd, LPSECURITY_ATTRIBUTES lpPA, LPSECURITY_ATTRIBUTES lpTA, BOOL bInherit, DWORD dwFlags, LPVOID lpEnv, LPCSTR lpDir, LPSTARTUPINFOA lpSI, LPPROCESS_INFORMATION lpPI)
{
    return ds_create_process_common(false, lpApp, lpCmd, lpPA, lpTA, bInherit, dwFlags, lpEnv, lpDir, lpSI, lpPI);
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

static void ds_ensure_shell32_loaded(bool allow_load_library)
{
    if (g_ds.real_ShellExecuteExW) return;
    HMODULE sh32 = GetModuleHandleW(L"shell32.dll");
    if (!sh32 && allow_load_library) {
        ds_enter_internal();
        sh32 = g_ds.real_LoadLibraryW ? g_ds.real_LoadLibraryW(L"shell32.dll") : LoadLibraryW(L"shell32.dll");
        ds_leave_internal();
    }
    if (sh32 && g_ds.real_GetProcAddress) {
        g_ds.real_ShellExecuteA   = (void *)(uintptr_t)g_ds.real_GetProcAddress(sh32, "ShellExecuteA");
        g_ds.real_ShellExecuteW   = (void *)(uintptr_t)g_ds.real_GetProcAddress(sh32, "ShellExecuteW");
        g_ds.real_ShellExecuteExA = (void *)(uintptr_t)g_ds.real_GetProcAddress(sh32, "ShellExecuteExA");
        g_ds.real_ShellExecuteExW = (void *)(uintptr_t)g_ds.real_GetProcAddress(sh32, "ShellExecuteExW");
    }
}

static bool ds_is_batch_extension_w(const WCHAR *path)
{
    if (!path) return false;
    size_t len = wcslen(path);
    if (len < 4) return false;
    const WCHAR *ext = path + len - 4;
    return (ds_wcs_ieq_ascii(ext, ".bat") || ds_wcs_ieq_ascii(ext, ".cmd"));
}

static bool ds_is_exe_extension_w(const WCHAR *path)
{
    if (!path) return false;
    size_t len = wcslen(path);
    return len >= 4 && (ds_wcs_ieq_ascii(path + len - 4, ".exe") || ds_is_batch_extension_w(path));
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

DS_ALWAYS_INLINE WCHAR *ds_alloc_unquoted_w(const WCHAR *src)
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

static WCHAR *ds_search_exe_path_w(const WCHAR *dir, const WCHAR *unquoted, const WCHAR *def_ext)
{
    DWORD need = SearchPathW(dir, unquoted, def_ext, 0, NULL, NULL);
    if (need == 0) return NULL;
    WCHAR *res = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, ((size_t)need + 2) * sizeof(WCHAR));
    if (res && SearchPathW(dir, unquoted, def_ext, need + 1, res, NULL) > 0 && ds_is_exe_extension_w(res)) {
        return res;
    }
    if (res) HeapFree(GetProcessHeap(), 0, res);
    return NULL;
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
        WCHAR *found = ds_search_exe_path_w(work_dir, unquoted, def_ext);
        if (found) return found;
    }
    WCHAR *found = ds_search_exe_path_w(NULL, unquoted, def_ext);
    if (found) return found;

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
    pfn_ShellExecuteExW_t real_sew = (pfn_ShellExecuteExW_t)(uintptr_t)g_ds.real_ShellExecuteExW;
    if (!pExecInfo || pExecInfo->cbSize < sizeof(SHELLEXECUTEINFOW) || ds_is_internal_call()) {
        return real_sew ? real_sew(pExecInfo) : FALSE;
    }

    if ((pExecInfo->fMask & (SEE_MASK_IDLIST | SEE_MASK_CLASSNAME | SEE_MASK_CLASSKEY)) != 0 &&
        (!pExecInfo->lpFile || !ds_is_exe_extension_w(pExecInfo->lpFile))) {
        return real_sew ? real_sew(pExecInfo) : FALSE;
    }

    const WCHAR *verb = pExecInfo->lpVerb;
    bool is_open_verb = (!verb || !verb[0] || ds_wcs_ieq_ascii(verb, "open") || ds_wcs_ieq_ascii(verb, "runas"));
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

    return real_sew ? real_sew(pExecInfo) : FALSE;
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
    pfn_ShellExecuteExA_t real_sea = (pfn_ShellExecuteExA_t)(uintptr_t)g_ds.real_ShellExecuteExA;
    if (!pExecInfo || pExecInfo->cbSize < sizeof(SHELLEXECUTEINFOA) || ds_is_internal_call() ||
        ((pExecInfo->fMask & (SEE_MASK_IDLIST | SEE_MASK_CLASSNAME | SEE_MASK_CLASSKEY)) != 0 && !pExecInfo->lpFile)) {
        return real_sea ? real_sea(pExecInfo) : FALSE;
    }

    WCHAR *wstrs[4] = {
        ds_alloc_wide_from_acp(pExecInfo->lpFile),
        ds_alloc_wide_from_acp(pExecInfo->lpVerb),
        ds_alloc_wide_from_acp(pExecInfo->lpParameters),
        ds_alloc_wide_from_acp(pExecInfo->lpDirectory),
    };

    SHELLEXECUTEINFOW seiW;
    memset(&seiW, 0, sizeof(seiW));
    seiW.cbSize = sizeof(seiW);
    seiW.fMask = pExecInfo->fMask;
    seiW.hwnd = pExecInfo->hwnd;
    seiW.lpFile = wstrs[0];
    seiW.lpVerb = wstrs[1];
    seiW.lpParameters = wstrs[2];
    seiW.lpDirectory = wstrs[3];
    seiW.nShow = pExecInfo->nShow;

    BOOL ok = hook_ShellExecuteExW(&seiW);
    DWORD last_err = GetLastError();
    for (int i = 0; i < 4; i++) {
        if (wstrs[i]) HeapFree(GetProcessHeap(), 0, wstrs[i]);
    }

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

#define DS_HK_LOADER      1u
#define DS_HK_WINE        2u
#define DS_HK_WINED3D_GPA 4u
#define DS_HK_SHELL       8u
#define DS_HK_MOD_U32  1u
#define DS_HK_MOD_G32  2u
#define DS_HK_MOD_GL32 3u

typedef struct ds_hook_entry_s {
    const char *name;
    void       *hook_fn;
    uint16_t    real_off;
    uint8_t     flags;
    uint8_t     mod_id;
} ds_hook_entry_t;

#define DS_HK_OFF(field) ((uint16_t)offsetof(ds_runtime_t, field))

DS_ALWAYS_INLINE void **ds_hk_real_slot(const ds_hook_entry_t *e)
{
    return (void **)(void *)((uint8_t *)&g_ds + e->real_off);
}

static const ds_hook_entry_t k_ds_hook_table[] = {
    { "LoadLibraryA",         (void *)(uintptr_t)hook_LoadLibraryA,         DS_HK_OFF(real_LoadLibraryA),         DS_HK_LOADER, 0 },
    { "LoadLibraryW",         (void *)(uintptr_t)hook_LoadLibraryW,         DS_HK_OFF(real_LoadLibraryW),         DS_HK_LOADER, 0 },
    { "LoadLibraryExA",       (void *)(uintptr_t)hook_LoadLibraryExA,       DS_HK_OFF(real_LoadLibraryExA),       DS_HK_LOADER, 0 },
    { "LoadLibraryExW",       (void *)(uintptr_t)hook_LoadLibraryExW,       DS_HK_OFF(real_LoadLibraryExW),       DS_HK_LOADER, 0 },
    { "CreateProcessA",       (void *)(uintptr_t)hook_CreateProcessA,       DS_HK_OFF(real_CreateProcessA),       DS_HK_LOADER, 0 },
    { "CreateProcessW",       (void *)(uintptr_t)hook_CreateProcessW,       DS_HK_OFF(real_CreateProcessW),       DS_HK_LOADER, 0 },
    { "ShellExecuteA",        (void *)(uintptr_t)hook_ShellExecuteA,        DS_HK_OFF(real_ShellExecuteA),        DS_HK_LOADER | DS_HK_SHELL, 0 },
    { "ShellExecuteW",        (void *)(uintptr_t)hook_ShellExecuteW,        DS_HK_OFF(real_ShellExecuteW),        DS_HK_LOADER | DS_HK_SHELL, 0 },
    { "ShellExecuteExA",      (void *)(uintptr_t)hook_ShellExecuteExA,      DS_HK_OFF(real_ShellExecuteExA),      DS_HK_LOADER | DS_HK_SHELL, 0 },
    { "ShellExecuteExW",      (void *)(uintptr_t)hook_ShellExecuteExW,      DS_HK_OFF(real_ShellExecuteExW),      DS_HK_LOADER | DS_HK_SHELL, 0 },
    { "GetProcAddress",       (void *)(uintptr_t)hook_GetProcAddress,       DS_HK_OFF(real_GetProcAddress),       0, 0 },
    { "EnumDisplaySettingsA",   (void *)(uintptr_t)hook_EnumDisplaySettingsA,   DS_HK_OFF(real_EnumDisplaySettingsA),   0, DS_HK_MOD_U32 },
    { "EnumDisplaySettingsW",   (void *)(uintptr_t)hook_EnumDisplaySettingsW,   DS_HK_OFF(real_EnumDisplaySettingsW),   0, DS_HK_MOD_U32 },
    { "EnumDisplaySettingsExA", (void *)(uintptr_t)hook_EnumDisplaySettingsExA, DS_HK_OFF(real_EnumDisplaySettingsExA), 0, DS_HK_MOD_U32 },
    { "EnumDisplaySettingsExW", (void *)(uintptr_t)hook_EnumDisplaySettingsExW, DS_HK_OFF(real_EnumDisplaySettingsExW), 0, DS_HK_MOD_U32 },
    { "ChangeDisplaySettingsA",   (void *)(uintptr_t)hook_ChangeDisplaySettingsA,   DS_HK_OFF(real_ChangeDisplaySettingsA),   0, DS_HK_MOD_U32 },
    { "ChangeDisplaySettingsW",   (void *)(uintptr_t)hook_ChangeDisplaySettingsW,   DS_HK_OFF(real_ChangeDisplaySettingsW),   0, DS_HK_MOD_U32 },
    { "ChangeDisplaySettingsExA", (void *)(uintptr_t)hook_ChangeDisplaySettingsExA, DS_HK_OFF(real_ChangeDisplaySettingsExA), 0, DS_HK_MOD_U32 },
    { "ChangeDisplaySettingsExW", (void *)(uintptr_t)hook_ChangeDisplaySettingsExW, DS_HK_OFF(real_ChangeDisplaySettingsExW), 0, DS_HK_MOD_U32 },
    { "GetSystemMetrics",     (void *)(uintptr_t)hook_GetSystemMetrics,     DS_HK_OFF(real_GetSystemMetrics),     0, DS_HK_MOD_U32 },
    { "CreateWindowExA",      (void *)(uintptr_t)hook_CreateWindowExA,      DS_HK_OFF(real_CreateWindowExA),      0, DS_HK_MOD_U32 },
    { "CreateWindowExW",      (void *)(uintptr_t)hook_CreateWindowExW,      DS_HK_OFF(real_CreateWindowExW),      0, DS_HK_MOD_U32 },
    { "ShowWindow",           (void *)(uintptr_t)hook_ShowWindow,           DS_HK_OFF(real_ShowWindow),           0, DS_HK_MOD_U32 },
    { "ShowWindowAsync",      (void *)(uintptr_t)hook_ShowWindowAsync,      DS_HK_OFF(real_ShowWindowAsync),      0, DS_HK_MOD_U32 },
    { "SetWindowPlacement",   (void *)(uintptr_t)hook_SetWindowPlacement,   DS_HK_OFF(real_SetWindowPlacement),   0, DS_HK_MOD_U32 },
    { "SetWindowPos",         (void *)(uintptr_t)hook_SetWindowPos,         DS_HK_OFF(real_SetWindowPos),         0, DS_HK_MOD_U32 },
    { "MoveWindow",           (void *)(uintptr_t)hook_MoveWindow,           DS_HK_OFF(real_MoveWindow),           0, DS_HK_MOD_U32 },
    { "GetWindowLongA",       (void *)(uintptr_t)hook_GetWindowLongA,       DS_HK_OFF(real_GetWindowLongA),       0, DS_HK_MOD_U32 },
    { "GetWindowLongW",       (void *)(uintptr_t)hook_GetWindowLongW,       DS_HK_OFF(real_GetWindowLongW),       0, DS_HK_MOD_U32 },
    { "SetWindowLongA",       (void *)(uintptr_t)hook_SetWindowLongA,       DS_HK_OFF(real_SetWindowLongA),       0, DS_HK_MOD_U32 },
    { "SetWindowLongW",       (void *)(uintptr_t)hook_SetWindowLongW,       DS_HK_OFF(real_SetWindowLongW),       0, DS_HK_MOD_U32 },
#if defined(_WIN64)
    { "GetWindowLongPtrA",    (void *)(uintptr_t)hook_GetWindowLongPtrA,    DS_HK_OFF(real_GetWindowLongPtrA),    0, DS_HK_MOD_U32 },
    { "GetWindowLongPtrW",    (void *)(uintptr_t)hook_GetWindowLongPtrW,    DS_HK_OFF(real_GetWindowLongPtrW),    0, DS_HK_MOD_U32 },
    { "SetWindowLongPtrA",    (void *)(uintptr_t)hook_SetWindowLongPtrA,    DS_HK_OFF(real_SetWindowLongPtrA),    0, DS_HK_MOD_U32 },
    { "SetWindowLongPtrW",    (void *)(uintptr_t)hook_SetWindowLongPtrW,    DS_HK_OFF(real_SetWindowLongPtrW),    0, DS_HK_MOD_U32 },
#endif
    { "GetClientRect",        (void *)(uintptr_t)hook_GetClientRect,        DS_HK_OFF(real_GetClientRect),        0, DS_HK_MOD_U32 },
    { "GetWindowRect",        (void *)(uintptr_t)hook_GetWindowRect,        DS_HK_OFF(real_GetWindowRect),        0, DS_HK_MOD_U32 },
    { "GetMonitorInfoA",      (void *)(uintptr_t)hook_GetMonitorInfoA,      DS_HK_OFF(real_GetMonitorInfoA),      0, DS_HK_MOD_U32 },
    { "GetMonitorInfoW",      (void *)(uintptr_t)hook_GetMonitorInfoW,      DS_HK_OFF(real_GetMonitorInfoW),      0, DS_HK_MOD_U32 },
    { "AdjustWindowRect",     NULL,                                         DS_HK_OFF(real_AdjustWindowRect),     0, DS_HK_MOD_U32 },
    { "AdjustWindowRectEx",   NULL,                                         DS_HK_OFF(real_AdjustWindowRectEx),   0, DS_HK_MOD_U32 },
    { "GetCursorPos",         (void *)(uintptr_t)hook_GetCursorPos,         DS_HK_OFF(real_GetCursorPos),         0, DS_HK_MOD_U32 },
    { "SetCursorPos",         (void *)(uintptr_t)hook_SetCursorPos,         DS_HK_OFF(real_SetCursorPos),         0, DS_HK_MOD_U32 },
    { "ClipCursor",           (void *)(uintptr_t)hook_ClipCursor,           DS_HK_OFF(real_ClipCursor),           0, DS_HK_MOD_U32 },
    { "GetClipCursor",        (void *)(uintptr_t)hook_GetClipCursor,        DS_HK_OFF(real_GetClipCursor),        0, DS_HK_MOD_U32 },
    { "GetMessagePos",        (void *)(uintptr_t)hook_GetMessagePos,        DS_HK_OFF(real_GetMessagePos),        0, DS_HK_MOD_U32 },
    { "GetRawInputData",      (void *)(uintptr_t)hook_GetRawInputData,      DS_HK_OFF(real_GetRawInputData),      0, DS_HK_MOD_U32 },
    { "GetRawInputBuffer",    (void *)(uintptr_t)hook_GetRawInputBuffer,    DS_HK_OFF(real_GetRawInputBuffer),    0, DS_HK_MOD_U32 },
    { "RegisterRawInputDevices", (void *)(uintptr_t)hook_RegisterRawInputDevices, DS_HK_OFF(real_RegisterRawInputDevices), 0, DS_HK_MOD_U32 },
    { "ScreenToClient",       (void *)(uintptr_t)hook_ScreenToClient,       DS_HK_OFF(real_ScreenToClient),       0, DS_HK_MOD_U32 },
    { "ClientToScreen",       (void *)(uintptr_t)hook_ClientToScreen,       DS_HK_OFF(real_ClientToScreen),       0, DS_HK_MOD_U32 },
    { "MapWindowPoints",      (void *)(uintptr_t)hook_MapWindowPoints,      DS_HK_OFF(real_MapWindowPoints),      0, DS_HK_MOD_U32 },
    { "WindowFromPoint",      (void *)(uintptr_t)hook_WindowFromPoint,      DS_HK_OFF(real_WindowFromPoint),      0, DS_HK_MOD_U32 },
    { "ReleaseDC",            (void *)(uintptr_t)hook_ReleaseDC,            DS_HK_OFF(real_ReleaseDC),            DS_HK_WINED3D_GPA, DS_HK_MOD_U32 },
    { "SetThreadDpiAwarenessContext",  NULL,                                DS_HK_OFF(p_SetThreadDpiAwarenessContext),  0, DS_HK_MOD_U32 },
    { "GetWindowDpiAwarenessContext",  NULL,                                DS_HK_OFF(p_GetWindowDpiAwarenessContext),  0, DS_HK_MOD_U32 },
    { "SetProcessDpiAwarenessContext", NULL,                                DS_HK_OFF(p_SetProcessDpiAwarenessContext), 0, DS_HK_MOD_U32 },
    { "GetDeviceCaps",        (void *)(uintptr_t)hook_GetDeviceCaps,        DS_HK_OFF(real_GetDeviceCaps),        0, DS_HK_MOD_G32 },
    { "DeleteDC",             (void *)(uintptr_t)hook_DeleteDC,             DS_HK_OFF(real_DeleteDC),             DS_HK_WINED3D_GPA, DS_HK_MOD_G32 },
    { "ChoosePixelFormat",    (void *)(uintptr_t)hook_ChoosePixelFormat,    DS_HK_OFF(real_ChoosePixelFormat),    DS_HK_WINED3D_GPA, DS_HK_MOD_G32 },
    { "DescribePixelFormat",  (void *)(uintptr_t)hook_DescribePixelFormat,  DS_HK_OFF(real_DescribePixelFormat),  DS_HK_WINED3D_GPA, DS_HK_MOD_G32 },
    { "GetPixelFormat",       (void *)(uintptr_t)hook_GetPixelFormat,       DS_HK_OFF(real_GetPixelFormat),       DS_HK_WINED3D_GPA, DS_HK_MOD_G32 },
    { "SetPixelFormat",       (void *)(uintptr_t)hook_SetPixelFormat,       DS_HK_OFF(real_SetPixelFormat),       DS_HK_WINED3D_GPA, DS_HK_MOD_G32 },
    { "BitBlt",               (void *)(uintptr_t)hook_BitBlt,               DS_HK_OFF(real_BitBlt),               0, DS_HK_MOD_G32 },
    { "StretchBlt",           (void *)(uintptr_t)hook_StretchBlt,           DS_HK_OFF(real_StretchBlt),           0, DS_HK_MOD_G32 },
    { "SetDIBitsToDevice",    (void *)(uintptr_t)hook_SetDIBitsToDevice,    DS_HK_OFF(real_SetDIBitsToDevice),    0, DS_HK_MOD_G32 },
    { "StretchDIBits",        (void *)(uintptr_t)hook_StretchDIBits,        DS_HK_OFF(real_StretchDIBits),        0, DS_HK_MOD_G32 },
    { "SwapBuffers",          (void *)(uintptr_t)hook_SwapBuffers,          DS_HK_OFF(real_SwapBuffers),          DS_HK_WINED3D_GPA, DS_HK_MOD_G32 },
    { "D3DKMTEscape",         (void *)(uintptr_t)hook_D3DKMTEscape,         DS_HK_OFF(real_D3DKMTEscape),         DS_HK_WINE | DS_HK_WINED3D_GPA, 0 },
    { "NtGdiDdDDIEscape",     (void *)(uintptr_t)hook_D3DKMTEscape,         DS_HK_OFF(real_NtGdiDdDDIEscape),     DS_HK_WINE | DS_HK_WINED3D_GPA, 0 },
    { "wglCreateContext",       (void *)(uintptr_t)hook_wglCreateContext,       DS_HK_OFF(real_wglCreateContext),       DS_HK_WINED3D_GPA, DS_HK_MOD_GL32 },
    { "wglCreateLayerContext",  (void *)(uintptr_t)hook_wglCreateLayerContext,  DS_HK_OFF(real_wglCreateLayerContext),  DS_HK_WINED3D_GPA, DS_HK_MOD_GL32 },
    { "wglGetCurrentDC",        (void *)(uintptr_t)hook_wglGetCurrentDC,        DS_HK_OFF(real_wglGetCurrentDC),        DS_HK_WINED3D_GPA, DS_HK_MOD_GL32 },
    { "wglChoosePixelFormat",   (void *)(uintptr_t)hook_wglChoosePixelFormat,   DS_HK_OFF(real_wglChoosePixelFormat),   0, DS_HK_MOD_GL32 },
    { "wglDescribePixelFormat", (void *)(uintptr_t)hook_wglDescribePixelFormat, DS_HK_OFF(real_wglDescribePixelFormat), 0, DS_HK_MOD_GL32 },
    { "wglGetPixelFormat",      (void *)(uintptr_t)hook_wglGetPixelFormat,      DS_HK_OFF(real_wglGetPixelFormat),      0, DS_HK_MOD_GL32 },
    { "wglSetPixelFormat",      (void *)(uintptr_t)hook_wglSetPixelFormat,      DS_HK_OFF(real_wglSetPixelFormat),      0, DS_HK_MOD_GL32 },
    { "wglMakeCurrent",         (void *)(uintptr_t)hook_wglMakeCurrent,         DS_HK_OFF(real_wglMakeCurrent),         DS_HK_WINED3D_GPA, DS_HK_MOD_GL32 },
    { "wglDeleteContext",       (void *)(uintptr_t)hook_wglDeleteContext,       DS_HK_OFF(real_wglDeleteContext),       DS_HK_WINED3D_GPA, DS_HK_MOD_GL32 },
    { "wglSwapBuffers",         (void *)(uintptr_t)hook_wglSwapBuffers,         DS_HK_OFF(real_wglSwapBuffers),         DS_HK_WINED3D_GPA, DS_HK_MOD_GL32 },
    { "wglGetProcAddress",      (void *)(uintptr_t)hook_wglGetProcAddress,      DS_HK_OFF(real_wglGetProcAddress),      DS_HK_WINED3D_GPA, DS_HK_MOD_GL32 },
    { "glDrawBuffer",           (void *)(uintptr_t)hook_glDrawBuffer,           DS_HK_OFF(real_glDrawBuffer),           0, DS_HK_MOD_GL32 },
    { "glReadBuffer",           (void *)(uintptr_t)hook_glReadBuffer,           DS_HK_OFF(real_glReadBuffer),           0, DS_HK_MOD_GL32 },
    { "glGetIntegerv",          (void *)(uintptr_t)hook_glGetIntegerv,          DS_HK_OFF(real_glGetIntegerv),          0, DS_HK_MOD_GL32 },
};

static void *ds_lookup_hook_by_name_flags(const char *func_name, uint8_t req_mask, bool allow_loader_hooks, bool allow_shell)
{
    if (!func_name || ((uintptr_t)func_name >> 16) == 0) {
        return NULL;
    }
    for (size_t i = 0; i < sizeof(k_ds_hook_table) / sizeof(k_ds_hook_table[0]); i++) {
        const ds_hook_entry_t *e = &k_ds_hook_table[i];
        if (!e->hook_fn) continue;
        if (req_mask && (e->flags & req_mask) == 0) continue;
        if ((e->flags & DS_HK_LOADER) && !allow_loader_hooks && !(allow_shell && (e->flags & DS_HK_SHELL))) continue;
        if ((e->flags & DS_HK_WINE) && !g_ds.is_wine) continue;
        if (strcmp(func_name, e->name) == 0) return e->hook_fn;
    }
    return NULL;
}

DS_ALWAYS_INLINE void *ds_lookup_hook_by_name(const char *func_name, bool allow_loader_hooks)
{
    return ds_lookup_hook_by_name_flags(func_name, 0, allow_loader_hooks, false);
}

static void *ds_lookup_hook_by_real_ptr(const void *fn_ptr, bool allow_loader_hooks)
{
    if (!fn_ptr) return NULL;
    for (size_t i = 0; i < sizeof(k_ds_hook_table) / sizeof(k_ds_hook_table[0]); i++) {
        const ds_hook_entry_t *e = &k_ds_hook_table[i];
        if (!e->hook_fn) continue;
        if ((e->flags & DS_HK_LOADER) && !allow_loader_hooks) continue;
        if ((e->flags & DS_HK_WINE) && !g_ds.is_wine) continue;
        void *real_fn = *ds_hk_real_slot(e);
        if (real_fn && real_fn == fn_ptr) return e->hook_fn;
    }
    return NULL;
}

DS_ALWAYS_INLINE bool ds_is_nul_terminated_within(const char *s, size_t max_bytes)
{
    if (!s || max_bytes == 0) return false;
    for (size_t i = 0; i < max_bytes; i++) {
        if (s[i] == '\0') return true;
    }
    return false;
}

static void ds_resolve_loaded_system_apis(void);

static void ds_patch_iat_slot_atomic(ULONG_PTR *slot, void *replacement)
{
    if (!slot || !replacement) return;
    if ((uintptr_t)(*slot) == (uintptr_t)replacement) return;
    DWORD old_prot = 0;
    if (VirtualProtect(slot, sizeof(ULONG_PTR), PAGE_READWRITE, &old_prot)) {
        InterlockedExchangePointer((PVOID volatile *)slot, replacement);
        DWORD dummy = 0;
        VirtualProtect(slot, sizeof(ULONG_PTR), old_prot, &dummy);
    }
}

static void *ds_lookup_ibn_hook(
    const uint8_t *img,
    size_t         size_of_image,
    size_t         ibn_rva,
    bool           is_com_loader_only_mod,
    bool           is_wine_gfx_mod
)
{
    if (ibn_rva < sizeof(IMAGE_DOS_HEADER) || ibn_rva + 4 > size_of_image) return NULL;
    const char *fn_name = (const char *)(img + ibn_rva + offsetof(IMAGE_IMPORT_BY_NAME, Name));
    size_t max_name = size_of_image - (ibn_rva + offsetof(IMAGE_IMPORT_BY_NAME, Name));
    if (max_name > 256) max_name = 256;
    if (!ds_is_nul_terminated_within(fn_name, max_name)) return NULL;
    if (is_com_loader_only_mod) {
        for (size_t i = 0; i < 4; i++) {
            if (strcmp(fn_name, k_ds_hook_table[i].name) == 0) return k_ds_hook_table[i].hook_fn;
        }
        return NULL;
    }
    return ds_lookup_hook_by_name(fn_name, !is_wine_gfx_mod);
}

static size_t ds_resolve_delay_rva(DWORD attrs, uintptr_t raw, uintptr_t img_base)
{
    if (raw == 0) return 0;
    if ((attrs & 1u) != 0) return (size_t)raw;
    return (raw >= img_base) ? (size_t)(raw - img_base) : 0;
}

static void ds_patch_single_module_iat(HMODULE hmod)
{
    if (!hmod || hmod == g_ds.self_hmod) return;

    WCHAR mod_path[MAX_PATH] = { 0 };
    if (GetModuleFileNameW(hmod, mod_path, MAX_PATH - 1) == 0) return;
    const WCHAR *base = ds_basename_w(mod_path);

    uint32_t mflags = ds_compute_mod_flags_by_base(base);
    bool mod_state_changed = false;
    bool dxvk_d3d9_hint = false;
    if ((mflags & DS_MODF_D3D9) != 0) {
        /* Positive DXVK d3d9.dll check outside g_ds.lock */
        dxvk_d3d9_hint = (
            GetModuleHandleW(L"wined3d.dll") == NULL &&
            (GetModuleHandleW(L"vulkan-1.dll") != NULL || GetModuleHandleW(L"winevulkan.dll") != NULL)
        );
    }
    bool tier_changed = false;
    bool now_modern = false;
    if ((mflags & (DS_MODF_DDRAW | DS_MODF_D3D8 | DS_MODF_D3D9 | DS_MODF_MODERN_DX | DS_MODF_VULKAN)) != 0) {
        if (g_ds.lock_initialized) ds_lock();
        if ((mflags & DS_MODF_DDRAW) != 0) {
            if (!g_ds.ddraw_loaded || !g_ds.legacy_d3d_loaded) {
                g_ds.ddraw_loaded = true;
                g_ds.legacy_d3d_loaded = true;
                mod_state_changed = true;
            }
        } else if ((mflags & DS_MODF_D3D8) != 0) {
            if (!g_ds.d3d8_or_9_loaded || !g_ds.legacy_d3d_loaded) {
                g_ds.d3d8_or_9_loaded = true;
                g_ds.legacy_d3d_loaded = true;
                mod_state_changed = true;
            }
        } else if ((mflags & DS_MODF_D3D9) != 0) {
            if (!g_ds.d3d8_or_9_loaded || !g_ds.d3d9_loaded || !g_ds.legacy_d3d_loaded) {
                g_ds.d3d8_or_9_loaded = true;
                g_ds.d3d9_loaded = true;
                g_ds.legacy_d3d_loaded = true;
                mod_state_changed = true;
            }
            if (dxvk_d3d9_hint && !g_ds.wined3d_uses_vulkan && !g_ds.wined3d_uses_gl) {
                g_ds.wined3d_uses_vulkan = true;
                mod_state_changed = true;
            }
        } else if ((mflags & DS_MODF_MODERN_DX) != 0) {
            if (!g_ds.dxgi_or_d3d10_plus_loaded || !g_ds.modern_gfx_loaded) {
                g_ds.dxgi_or_d3d10_plus_loaded = true;
                g_ds.modern_gfx_loaded = true;
                mod_state_changed = true;
            }
        } else if ((mflags & DS_MODF_VULKAN) != 0) {
            if (!g_ds.vulkan_loaded) {
                g_ds.vulkan_loaded = true;
                mod_state_changed = true;
            }
            if (!g_ds.wined3d_uses_gl && !g_ds.wined3d_uses_vulkan) {
                g_ds.wined3d_uses_vulkan = true;
                mod_state_changed = true;
            }
        }
        if (mod_state_changed && g_ds.lock_initialized) {
            tier_changed = ds_update_presenter_tier_locked();
            now_modern = ds_is_modern_tier_locked();
        }
        if (g_ds.lock_initialized) ds_unlock();
    }

    if (tier_changed) {
        if (now_modern) {
            ds_request_restore_passthrough();
        } else {
            ds_request_apply_presentation();
        }
        ds_write_status_file();
    }

    if ((mflags & DS_MODF_SKIP_IAT) != 0) return;

    bool is_com_loader_only_mod = (
        ds_wcs_ieq_ascii(base, "ole32.dll") ||
        ds_wcs_ieq_ascii(base, "combase.dll")
    );
    bool is_wine_gfx_mod = ((mflags & (DS_MODF_WINED3D | DS_MODF_DDRAW | DS_MODF_D3D8 | DS_MODF_D3D9)) != 0);

    uint8_t *img = (uint8_t *)hmod;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)img;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew <= 0 || dos->e_lfanew > 0x100000) return;

    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(img + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return;

    size_t size_of_image = (size_t)nt->OptionalHeader.SizeOfImage;
    if (size_of_image < 512 || (size_t)dos->e_lfanew + sizeof(IMAGE_NT_HEADERS) > size_of_image) return;

    IMAGE_DATA_DIRECTORY imp_dir = { 0, 0 };
    if (nt->OptionalHeader.NumberOfRvaAndSizes > IMAGE_DIRECTORY_ENTRY_IMPORT) {
        imp_dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    }
    if (imp_dir.VirtualAddress != 0 && imp_dir.Size != 0 &&
        (size_t)imp_dir.VirtualAddress < size_of_image &&
        (size_t)imp_dir.VirtualAddress + sizeof(IMAGE_IMPORT_DESCRIPTOR) <= size_of_image) {
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
                        replacement = ds_lookup_ibn_hook(img, size_of_image, (size_t)orig_thunk->u1.AddressOfData, is_com_loader_only_mod, is_wine_gfx_mod);
                    }
                }

                if (!replacement) {
                    const void *cur_fn = (const void *)(uintptr_t)iat_thunk->u1.Function;
                    if (is_com_loader_only_mod) {
                        for (size_t i = 0; i < 4; i++) {
                            void *real_fn = *ds_hk_real_slot(&k_ds_hook_table[i]);
                            if (real_fn && real_fn == cur_fn) {
                                replacement = k_ds_hook_table[i].hook_fn;
                                break;
                            }
                        }
                    } else {
                        replacement = ds_lookup_hook_by_real_ptr(cur_fn, !is_wine_gfx_mod);
                    }
                }
                if (!replacement) continue;
                ds_patch_iat_slot_atomic(&iat_thunk->u1.Function, replacement);
            }
        }
    }

    /* Bounded /DELAYLOAD IAT patching for already-resolved delay-loaded imports */
    if (!is_com_loader_only_mod && nt->OptionalHeader.NumberOfRvaAndSizes > IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT) {
        IMAGE_DATA_DIRECTORY delay_dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT];
        if (delay_dir.VirtualAddress != 0 && delay_dir.Size >= 32u &&
            (size_t)delay_dir.VirtualAddress + 32u <= size_of_image) {
            typedef struct ds_delay_desc_s {
                DWORD grAttrs;
                DWORD rvaDLLName;
                DWORD rvaHmod;
                DWORD rvaIAT;
                DWORD rvaINT;
                DWORD rvaBoundIAT;
                DWORD rvaUnloadIAT;
                DWORD dwTimeStamp;
            } ds_delay_desc_t;
            uintptr_t img_base = (uintptr_t)img;
            size_t d_off = (size_t)delay_dir.VirtualAddress;
            for (int di = 0; di < 64 && d_off + sizeof(ds_delay_desc_t) <= size_of_image; di++, d_off += sizeof(ds_delay_desc_t)) {
                const ds_delay_desc_t *dd = (const ds_delay_desc_t *)(img + d_off);
                if (dd->rvaDLLName == 0 && dd->rvaIAT == 0 && dd->rvaINT == 0) break;
                if (dd->rvaIAT == 0) continue;
                size_t iat_rva = ds_resolve_delay_rva(dd->grAttrs, (uintptr_t)dd->rvaIAT, img_base);
                size_t int_rva = ds_resolve_delay_rva(dd->grAttrs, (uintptr_t)dd->rvaINT, img_base);
                if (iat_rva == 0 || iat_rva + sizeof(IMAGE_THUNK_DATA) > size_of_image) continue;
                bool has_int = (int_rva != 0 && int_rva != iat_rva && int_rva + sizeof(IMAGE_THUNK_DATA) <= size_of_image);
                for (size_t io = iat_rva, no = int_rva;
                     io + sizeof(IMAGE_THUNK_DATA) <= size_of_image;
                     io += sizeof(IMAGE_THUNK_DATA), no += sizeof(IMAGE_THUNK_DATA)) {
                    IMAGE_THUNK_DATA *iat_thunk = (IMAGE_THUNK_DATA *)(img + io);
                    if (iat_thunk->u1.Function == 0) break;
                    /* Only patch delay-load slots already resolved outside our image (pointing to real Win32 fn) */
                    const void *cur_fn = (const void *)(uintptr_t)iat_thunk->u1.Function;
                    void *replacement = ds_lookup_hook_by_real_ptr(cur_fn, !is_wine_gfx_mod);
                    if (!replacement && has_int && no + sizeof(IMAGE_THUNK_DATA) <= size_of_image &&
                        ((uintptr_t)cur_fn < img_base || (uintptr_t)cur_fn >= img_base + size_of_image)) {
                        IMAGE_THUNK_DATA *orig_thunk = (IMAGE_THUNK_DATA *)(img + no);
                        if (orig_thunk->u1.AddressOfData != 0 && !IMAGE_SNAP_BY_ORDINAL(orig_thunk->u1.Ordinal)) {
                            size_t ibn_rva = ds_resolve_delay_rva(dd->grAttrs, (uintptr_t)orig_thunk->u1.AddressOfData, img_base);
                            replacement = ds_lookup_ibn_hook(img, size_of_image, ibn_rva, false, is_wine_gfx_mod);
                        }
                    }
                    if (replacement) {
                        ds_patch_iat_slot_atomic(&iat_thunk->u1.Function, replacement);
                    }
                }
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
            void *hk = ds_lookup_hook_by_name_flags(lpProcName, DS_HK_WINED3D_GPA, false, false);
            if (hk) return (FARPROC)(uintptr_t)hk;
            void *w3d_gl = ds_resolve_wined3d_gl_proc(lpProcName, (void *)(uintptr_t)real_fn);
            if (w3d_gl != (void *)(uintptr_t)real_fn) {
                return (FARPROC)(uintptr_t)w3d_gl;
            }
            void *w3d_vk = ds_resolve_wined3d_vk_proc(lpProcName, (void *)(uintptr_t)real_fn);
            if (w3d_vk != (void *)(uintptr_t)real_fn) {
                return (FARPROC)(uintptr_t)w3d_vk;
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
        void *hook_fn = ds_lookup_hook_by_name_flags(lpProcName, 0, false, true);
        if (hook_fn) {
            return (FARPROC)(uintptr_t)hook_fn;
        }
    }
    return real_fn;
}

static HMODULE ds_on_module_loaded(HMODULE h, DWORD dwFlags)
{
    if (h && !ds_is_internal_call() && (dwFlags & (LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE)) == 0) {
        ds_resolve_loaded_system_apis();
        ds_patch_loaded_modules();
    }
    return h;
}

static HMODULE WINAPI hook_LoadLibraryA(LPCSTR lpLibFileName)
{
    return ds_on_module_loaded(g_ds.real_LoadLibraryA ? g_ds.real_LoadLibraryA(lpLibFileName) : NULL, 0);
}

static HMODULE WINAPI hook_LoadLibraryW(LPCWSTR lpLibFileName)
{
    return ds_on_module_loaded(g_ds.real_LoadLibraryW ? g_ds.real_LoadLibraryW(lpLibFileName) : NULL, 0);
}

static HMODULE WINAPI hook_LoadLibraryExA(LPCSTR lpLibFileName, HANDLE hFile, DWORD dwFlags)
{
    return ds_on_module_loaded(g_ds.real_LoadLibraryExA ? g_ds.real_LoadLibraryExA(lpLibFileName, hFile, dwFlags) : NULL, dwFlags);
}

static HMODULE WINAPI hook_LoadLibraryExW(LPCWSTR lpLibFileName, HANDLE hFile, DWORD dwFlags)
{
    return ds_on_module_loaded(g_ds.real_LoadLibraryExW ? g_ds.real_LoadLibraryExW(lpLibFileName, hFile, dwFlags) : NULL, dwFlags);
}

/* -------------------------------------------------------------------------
 * Initialization, Lazy Runtime Start & `DllMain`
 * ------------------------------------------------------------------------- */

DS_ALWAYS_INLINE void ds_read_env_w(const char *name_a, WCHAR *out_buf, size_t max_chars)
{
    out_buf[0] = L'\0';
    WCHAR wk[48];
    ds_ascii_to_w(name_a, wk, 48);
    DWORD n = GetEnvironmentVariableW(wk, out_buf, (DWORD)max_chars);
    if (n == 0 || n >= (DWORD)max_chars) {
        out_buf[0] = L'\0';
    }
}

static void ds_read_env_utf8(const char *name, char *out_buf, size_t max_bytes)
{
    out_buf[0] = '\0';
    DWORD n = GetEnvironmentVariableA(name, out_buf, (DWORD)max_bytes);
    if (n == 0 || n >= (DWORD)max_bytes) {
        out_buf[0] = '\0';
    }
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

DS_ALWAYS_INLINE void ds_fill_sibling_path_if_empty(WCHAR *dst, size_t dst_cch, const WCHAR *dir, const WCHAR *filename)
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

static void ds_probe_wined3d_vulkan_registry(void)
{
    if (!g_ds.is_wine || g_ds.wined3d_uses_vulkan) return;
    HMODULE adv = GetModuleHandleW(L"advapi32.dll");
    if (!adv || !g_ds.real_GetProcAddress) return;
    typedef LONG (WINAPI *pfn_RegOpenKeyExW_t)(HKEY, LPCWSTR, DWORD, REGSAM, PHKEY);
    typedef LONG (WINAPI *pfn_RegQueryValueExW_t)(HKEY, LPCWSTR, LPDWORD, LPDWORD, LPBYTE, LPDWORD);
    typedef LONG (WINAPI *pfn_RegCloseKey_t)(HKEY);
    pfn_RegOpenKeyExW_t pOpen = (pfn_RegOpenKeyExW_t)(uintptr_t)g_ds.real_GetProcAddress(adv, "RegOpenKeyExW");
    pfn_RegQueryValueExW_t pQuery = (pfn_RegQueryValueExW_t)(uintptr_t)g_ds.real_GetProcAddress(adv, "RegQueryValueExW");
    pfn_RegCloseKey_t pClose = (pfn_RegCloseKey_t)(uintptr_t)g_ds.real_GetProcAddress(adv, "RegCloseKey");
    if (!pOpen || !pQuery || !pClose) return;

    WCHAR exe_path[MAX_PATH] = { 0 };
    WCHAR app_subkey[MAX_PATH + 64] = { 0 };
    const WCHAR *paths[2] = { NULL, L"Software\\Wine\\Direct3D" };
    if (GetModuleFileNameW(NULL, exe_path, MAX_PATH - 1) > 0) {
        const WCHAR *base = ds_basename_w(exe_path);
        if (base && base[0]) {
            _snwprintf(app_subkey, (sizeof(app_subkey) / sizeof(WCHAR)) - 1,
                       L"Software\\Wine\\AppDefaults\\%ls\\Direct3D", base);
            paths[0] = app_subkey;
        }
    }
    for (int i = 0; i < 2; i++) {
        if (!paths[i]) continue;
        HKEY hk = NULL;
        if (pOpen(HKEY_CURRENT_USER, paths[i], 0, KEY_READ, &hk) == ERROR_SUCCESS && hk) {
            WCHAR val[32] = { 0 };
            DWORD val_type = 0;
            DWORD val_sz = sizeof(val) - sizeof(WCHAR);
            LONG qres = pQuery(hk, L"renderer", NULL, &val_type, (LPBYTE)val, &val_sz);
            pClose(hk);
            if (qres == ERROR_SUCCESS && val_type == REG_SZ) {
                if (ds_wcs_ieq_ascii(val, "vulkan")) {
                    ds_lock();
                    g_ds.wined3d_uses_vulkan = true;
                    (void)ds_update_presenter_tier_locked();
                    ds_unlock();
                    return;
                }
                if (ds_wcs_ieq_ascii(val, "gl")) {
                    return;
                }
            }
        }
    }
}

void ds_refresh_host_display_metrics_for_hwnd(HWND hwnd)
{
    ds_enter_internal();

    /* Step 1: Physical monitor space (always PER_MONITOR_AWARE_V2 + EnumDisplaySettingsExW) */
    HANDLE prev_phys_dpi = ds_dpi_guard_enter(DS_DPI_CTX_PMV2);
    POINT origin_pt = { 0, 0 };
    HMONITOR hmon = (hwnd && IsWindow(hwnd))
        ? MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        : MonitorFromPoint(origin_pt, MONITOR_DEFAULTTOPRIMARY);

    MONITORINFOEXW mi_phys;
    memset(&mi_phys, 0, sizeof(mi_phys));
    mi_phys.cbSize = sizeof(mi_phys);
    BOOL has_phys_mi = (hmon != NULL && g_ds.real_GetMonitorInfoW &&
                        g_ds.real_GetMonitorInfoW(hmon, (LPMONITORINFO)&mi_phys));
    LPCWSTR dev_name = (has_phys_mi && mi_phys.szDevice[0] != L'\0') ? mi_phys.szDevice : NULL;

    DEVMODEW cur_dm;
    memset(&cur_dm, 0, sizeof(cur_dm));
    cur_dm.dmSize = sizeof(cur_dm);
    BOOL has_dm = g_ds.real_EnumDisplaySettingsExW &&
                  g_ds.real_EnumDisplaySettingsExW(dev_name, ENUM_CURRENT_SETTINGS, &cur_dm, 0);
    if (!has_dm && dev_name != NULL && g_ds.real_EnumDisplaySettingsExW) {
        has_dm = g_ds.real_EnumDisplaySettingsExW(NULL, ENUM_CURRENT_SETTINGS, &cur_dm, 0);
    }

    int32_t phys_w = (has_dm && cur_dm.dmPelsWidth > 0)
        ? (int32_t)cur_dm.dmPelsWidth
        : (has_phys_mi ? (int32_t)(mi_phys.rcMonitor.right - mi_phys.rcMonitor.left) : 0);
    int32_t phys_h = (has_dm && cur_dm.dmPelsHeight > 0)
        ? (int32_t)cur_dm.dmPelsHeight
        : (has_phys_mi ? (int32_t)(mi_phys.rcMonitor.bottom - mi_phys.rcMonitor.top) : 0);
    int32_t real_bpp = (has_dm && cur_dm.dmBitsPerPel >= 8) ? (int32_t)cur_dm.dmBitsPerPel : 32;
    int32_t real_hz  = (has_dm && cur_dm.dmDisplayFrequency > 0) ? (int32_t)cur_dm.dmDisplayFrequency : 60;

#if defined(_WIN64)
    /* Collect real OS modes for 64-bit union table (32-bit stays <= DS_MAX_SYNTH_MODES=52u; modern 32-bit passes straight through) */
    ds_display_mode_t os_modes[DS_MAX_UNION_MODES];
    size_t os_mode_count = 0;
    if (g_ds.real_EnumDisplaySettingsExW) {
        for (DWORD idx = 0; idx < 512u && os_mode_count < DS_MAX_UNION_MODES; idx++) {
            DEVMODEW dm_it;
            memset(&dm_it, 0, sizeof(dm_it));
            dm_it.dmSize = sizeof(dm_it);
            if (!g_ds.real_EnumDisplaySettingsExW(dev_name, idx, &dm_it, 0)) {
                break;
            }
            if (dm_it.dmPelsWidth < 240 || dm_it.dmPelsHeight < 180 || dm_it.dmBitsPerPel < 8) {
                continue;
            }
            int32_t mw = (int32_t)dm_it.dmPelsWidth;
            int32_t mh = (int32_t)dm_it.dmPelsHeight;
            int32_t mb = (int32_t)dm_it.dmBitsPerPel;
            int32_t mhz = (dm_it.dmDisplayFrequency > 0) ? (int32_t)dm_it.dmDisplayFrequency : real_hz;
            bool merged = false;
            for (size_t j = 0; j < os_mode_count; j++) {
                if (os_modes[j].width == mw && os_modes[j].height == mh && os_modes[j].bpp == mb) {
                    if (mhz > os_modes[j].refresh_hz) os_modes[j].refresh_hz = mhz;
                    merged = true;
                    break;
                }
            }
            if (!merged) {
                os_modes[os_mode_count].width = mw;
                os_modes[os_mode_count].height = mh;
                os_modes[os_mode_count].bpp = mb;
                os_modes[os_mode_count].refresh_hz = mhz;
                os_mode_count++;
            }
        }
    }
#endif
    ds_dpi_guard_leave(prev_phys_dpi);

    /*
     * Step 2: Window-DPI coordinate space (`win_mon_*`).
     * Query under `GetWindowDpiAwarenessContext(hwnd)` when `hwnd` exists so 192-DPI windows
     * get 3024x1964 AND truly 96-DPI HWNDs (late --watch-dir or <dpiAware>false</dpiAware>)
     * get 1512x982 without 2x cursor/bounds split-brain; use PMv2 before `hwnd` exists so a
     * transient 96-DPI WM_INITDIALOG thread context can never poison the initial metrics.
     */
    HANDLE win_ctx = (hwnd && IsWindow(hwnd) && g_ds.p_GetWindowDpiAwarenessContext)
        ? g_ds.p_GetWindowDpiAwarenessContext(hwnd)
        : DS_DPI_CTX_PMV2;
    HANDLE prev_win_dpi = ds_dpi_guard_enter(win_ctx);
    MONITORINFOEXW mi_win;
    memset(&mi_win, 0, sizeof(mi_win));
    mi_win.cbSize = sizeof(mi_win);
    BOOL has_win_mi = (hmon != NULL && g_ds.real_GetMonitorInfoW &&
                       g_ds.real_GetMonitorInfoW(hmon, (LPMONITORINFO)&mi_win));
    int32_t sm_w = g_ds.real_GetSystemMetrics ? g_ds.real_GetSystemMetrics(SM_CXSCREEN) : 0;
    int32_t sm_h = g_ds.real_GetSystemMetrics ? g_ds.real_GetSystemMetrics(SM_CYSCREEN) : 0;
    ds_dpi_guard_leave(prev_win_dpi);

    ds_leave_internal();

    int32_t phys_x = has_phys_mi ? (int32_t)mi_phys.rcMonitor.left : 0;
    int32_t phys_y = has_phys_mi ? (int32_t)mi_phys.rcMonitor.top : 0;
    int32_t win_x = has_win_mi ? (int32_t)mi_win.rcMonitor.left : 0;
    int32_t win_y = has_win_mi ? (int32_t)mi_win.rcMonitor.top : 0;
    int32_t win_w = has_win_mi ? (int32_t)(mi_win.rcMonitor.right - mi_win.rcMonitor.left)
                               : ((sm_w > 0) ? sm_w : (phys_w > 0 ? phys_w : 1024));
    int32_t win_h = has_win_mi ? (int32_t)(mi_win.rcMonitor.bottom - mi_win.rcMonitor.top)
                               : ((sm_h > 0) ? sm_h : (phys_h > 0 ? phys_h : 768));
    if (phys_w <= 0) phys_w = win_w;
    if (phys_h <= 0) phys_h = win_h;

    char inset_str[32] = { 0 };
    ds_read_env_utf8("ONE_LAUNCHER_SAFE_INSET_TOP", inset_str, sizeof(inset_str));

    ds_lock();
    g_ds.target_monitor = hmon;
    if (dev_name && dev_name[0] != L'\0') {
        wcsncpy(g_ds.target_device, dev_name, 31);
        g_ds.target_device[31] = L'\0';
    } else if (g_ds.target_device[0] == L'\0') {
        wcscpy(g_ds.target_device, L"\\\\.\\DISPLAY1");
    }
    g_ds.win_mon_x     = win_x;
    g_ds.win_mon_y     = win_y;
    g_ds.phys_mon_x    = phys_x;
    g_ds.phys_mon_y    = phys_y;
    g_ds.real_screen_w = win_w;
    g_ds.real_screen_h = win_h;
    g_ds.phys_screen_w = phys_w;
    g_ds.phys_screen_h = phys_h;
    g_ds.real_bpp      = real_bpp;
    g_ds.real_hz       = real_hz;

    if (inset_str[0] && g_ds.safe_inset_top == 0) {
        int32_t raw_inset = (int32_t)atoi(inset_str);
        if (raw_inset > 48 && g_ds.real_screen_h > 0 &&
            g_ds.phys_screen_h >= g_ds.real_screen_h * 2 - 4) {
            raw_inset = (raw_inset + 1) / 2;
        }
        g_ds.safe_inset_top = ds_clamp_safe_inset_top(raw_inset, g_ds.real_screen_h);
    } else {
        g_ds.safe_inset_top = ds_clamp_safe_inset_top(g_ds.safe_inset_top, g_ds.real_screen_h);
    }

#if defined(_WIN64)
    ds_display_mode_t synth_modes[DS_MAX_SYNTH_MODES];
    size_t synth_count = ds_build_mode_table(
        g_ds.phys_screen_w,
        g_ds.phys_screen_h,
        g_ds.real_hz,
        synth_modes,
        DS_MAX_SYNTH_MODES
    );
    if (os_mode_count > 0) {
        g_ds.mode_count = ds_merge_mode_tables(
            os_modes,
            os_mode_count,
            synth_modes,
            synth_count,
            g_ds.modes,
            DS_MAX_UNION_MODES
        );
    } else {
        memcpy(g_ds.modes, synth_modes, synth_count * sizeof(ds_display_mode_t));
        g_ds.mode_count = synth_count;
    }
#else
    g_ds.mode_count = ds_build_mode_table(
        g_ds.phys_screen_w,
        g_ds.phys_screen_h,
        g_ds.real_hz,
        g_ds.modes,
        DS_MAX_SYNTH_MODES
    );
#endif

    /* Always keep virt_w/virt_h synced when not mode_virtualized (fixes frozen 1512x982 latch) */
    if (!g_ds.mode_virtualized) {
        g_ds.virt_w = g_ds.real_screen_w;
        g_ds.virt_h = g_ds.real_screen_h;
        g_ds.virt_bpp = g_ds.real_bpp;
        g_ds.virt_hz = g_ds.real_hz;
    }
    ds_refresh_viewport_locked();
    InterlockedIncrement(&g_ds.gdi_margin_gen);
    ds_unlock();
}

void ds_refresh_host_display_metrics(void)
{
    HWND target = g_ds.hwnd_game;
    ds_refresh_host_display_metrics_for_hwnd(target);
}

static void ds_resolve_loaded_system_apis(void)
{
    if (!g_ds.real_GetProcAddress) return;

    HMODULE mods[4];
    mods[0] = NULL;
    mods[DS_HK_MOD_U32]  = GetModuleHandleW(L"user32.dll");
    mods[DS_HK_MOD_G32]  = GetModuleHandleW(L"gdi32.dll");
    mods[DS_HK_MOD_GL32] = GetModuleHandleW(L"opengl32.dll");

    for (size_t i = 0; i < sizeof(k_ds_hook_table) / sizeof(k_ds_hook_table[0]); i++) {
        const ds_hook_entry_t *e = &k_ds_hook_table[i];
        void **slot = ds_hk_real_slot(e);
        if (e->mod_id == 0 || *slot != NULL) continue;
        HMODULE hm = mods[e->mod_id];
        if (hm) {
            *slot = (void *)(uintptr_t)g_ds.real_GetProcAddress(hm, e->name);
        }
        if (*slot == NULL && e->mod_id == DS_HK_MOD_GL32 && mods[DS_HK_MOD_G32]) {
            *slot = (void *)(uintptr_t)g_ds.real_GetProcAddress(mods[DS_HK_MOD_G32], e->name);
        }
    }

    if (g_ds.is_wine && !g_ds.real_D3DKMTEscape) {
        HMODULE w32u = GetModuleHandleW(L"win32u.dll");
        if (w32u && !g_ds.real_NtGdiDdDDIEscape) {
            g_ds.real_NtGdiDdDDIEscape = (pfn_D3DKMTEscape_t)(uintptr_t)g_ds.real_GetProcAddress(w32u, "NtGdiDdDDIEscape");
        }
        if (mods[DS_HK_MOD_G32] && !g_ds.real_D3DKMTEscape) {
            g_ds.real_D3DKMTEscape = (pfn_D3DKMTEscape_t)(uintptr_t)g_ds.real_GetProcAddress(mods[DS_HK_MOD_G32], "D3DKMTEscape");
        }
        if (!g_ds.real_D3DKMTEscape) {
            g_ds.real_D3DKMTEscape = g_ds.real_NtGdiDdDDIEscape;
        }
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
    ds_probe_wined3d_vulkan_registry();

    bool need_dpi_init = false;
    if (g_ds.lock_initialized) ds_lock();
    need_dpi_init = (!ds_is_passthrough_locked() && !g_ds.dpi_aware_applied);
    if (g_ds.lock_initialized) ds_unlock();

    if (need_dpi_init) {
        HMODULE u32 = GetModuleHandleW(L"user32.dll");
        if (u32 && g_ds.real_GetProcAddress) {
            ds_enter_internal();
            bool applied = false;
            if (g_ds.p_SetProcessDpiAwarenessContext) {
                applied = (g_ds.p_SetProcessDpiAwarenessContext(DS_DPI_CTX_PMV2) != FALSE);
            }
            if (!applied) {
                typedef BOOL (WINAPI *pfn_SetProcessDPIAware_t)(void);
                pfn_SetProcessDPIAware_t pfn_dpi = (pfn_SetProcessDPIAware_t)(uintptr_t)g_ds.real_GetProcAddress(u32, "SetProcessDPIAware");
                if (pfn_dpi) {
                    pfn_dpi();
                    applied = true;
                }
            }
            ds_leave_internal();
            g_ds.dpi_aware_applied = applied;
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

static void ds_apply_init_ctl_fields(const ds_control_state_t *c)
{
    if (c->has_scaling_mode)   g_ds.scaling_mode   = c->scaling_mode;
    if (c->has_aspect)         g_ds.aspect_mode    = c->aspect;
    if (c->has_filter)         g_ds.scale_filter   = c->filter;
    if (c->has_safe_inset_top) g_ds.safe_inset_top = c->safe_inset_top;
    if (c->has_hotkey)         g_ds.hotkey_enabled = c->hotkey;
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

    char ev[64];
    ds_read_env_utf8("ONE_LAUNCHER_DISPLAY_SCALING_MODE", ev, sizeof(ev));
    g_ds.scaling_mode = ev[0] ? ds_parse_scaling_mode(ev) : DS_MODE_AUTO_FULLSCREEN;
    ds_read_env_utf8("ONE_LAUNCHER_DISPLAY_ASPECT", ev, sizeof(ev));
    g_ds.aspect_mode = ev[0] ? ds_parse_aspect_mode(ev) : DS_ASPECT_PRESERVE;
    ds_read_env_utf8("ONE_LAUNCHER_SCALING_FILTER", ev, sizeof(ev));
    g_ds.scale_filter = ev[0] ? ds_parse_scale_filter(ev) : DS_FILTER_AUTO;
    ds_read_env_utf8("ONE_LAUNCHER_FULLSCREEN_HOTKEY", ev, sizeof(ev));
    g_ds.hotkey_enabled = (ev[0] != '0');
    ds_read_env_utf8("ONE_LAUNCHER_SAFE_INSET_TOP", ev, sizeof(ev));
    g_ds.safe_inset_top = ev[0] ? (int32_t)atoi(ev) : 0;

    for (size_t i = 0; i < sizeof(k_ds_path_envs) / sizeof(k_ds_path_envs[0]); i++) {
        ds_read_env_w(k_ds_path_envs[i].key, ds_path_env_field(i), MAX_PATH);
    }

    if (g_ds.self_dir[0]) {
        static const char k_sib_names[4][30] = {
            "one_display_scaler_x86.dll",
            "one_display_scaler_x64.dll",
            "one_display_launcher_x86.exe",
            "one_display_launcher_x64.exe"
        };
        for (size_t i = 0; i < 4; i++) {
            WCHAR leaf[32];
            ds_ascii_to_w(k_sib_names[i], leaf, 32);
            ds_fill_sibling_path_if_empty(ds_path_env_field(i), MAX_PATH, g_ds.self_dir, leaf);
        }
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
            ds_apply_init_ctl_fields(&act_ctl);
        }
    }

    uint64_t initial_ctl_seq = 0;
    if (g_ds.control_file[0]) {
        ds_control_state_t init_ctl;
        if (ds_read_ini_file_raw(g_ds.control_file, &init_ctl)) {
            if (init_ctl.has_seq) initial_ctl_seq = init_ctl.seq;
            ds_apply_init_ctl_fields(&init_ctl);
            if (init_ctl.has_fullscreen && init_ctl.user_override) {
                g_ds.user_forced_fullscreen = init_ctl.fullscreen;
                g_ds.user_forced_windowed = !init_ctl.fullscreen;
            }
        }
    }
    if (g_ds.scaling_mode == DS_MODE_FORCE_FULLSCREEN) {
        g_ds.user_forced_fullscreen = true;
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

    for (size_t i = 0; i < 6; i++) {
        *ds_hk_real_slot(&k_ds_hook_table[i]) = (void *)(uintptr_t)g_ds.real_GetProcAddress(k32, k_ds_hook_table[i].name);
    }

    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    g_ds.is_wine = (ntdll != NULL && g_ds.real_GetProcAddress(ntdll, "wine_get_version") != NULL);

    if (!is_chaining_wrapper) {
        char aff_env[16] = { 0 };
        ds_read_env_utf8("ONE_LAUNCHER_SINGLE_CORE_AFFINITY", aff_env, sizeof(aff_env));
        bool want_up = (aff_env[0] == '1');
#if !defined(_WIN64)
        if (!want_up && aff_env[0] != '0') {
            HMODULE exe_mod = GetModuleHandleW(NULL);
            if (exe_mod) {
                const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)(const void *)exe_mod;
                if (dos->e_magic == IMAGE_DOS_SIGNATURE && dos->e_lfanew > 0 && dos->e_lfanew < 0x100000) {
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

    /* Record initial_ctl_seq so launch seq=1 is never replayed as a live user override */
    g_ds.last_control_seq = initial_ctl_seq;
    g_ds.active = true;

    ds_patch_loaded_modules();
    ds_lock();
    (void)ds_update_presenter_tier_locked();
    ds_unlock();
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
