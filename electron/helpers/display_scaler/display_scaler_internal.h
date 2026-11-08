/*
 * One Launcher Clean-Room Win32 Universal Display Virtualizer & Fullscreen Presenter
 * Internal Win32 State & Hook Prototypes (`display_scaler_internal.h`)
 */

#ifndef ONE_LAUNCHER_DISPLAY_SCALER_INTERNAL_H
#define ONE_LAUNCHER_DISPLAY_SCALER_INTERNAL_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <wingdi.h>
#include <GL/gl.h>
#include "display_scaler.h"

#ifndef GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
#define GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS 0x00000004
#endif
#ifndef GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT
#define GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT 0x00000002
#endif

/* OpenGL FBO constants (GL 3.0 / ARB_framebuffer_object / EXT_framebuffer_object) */
#ifndef GL_FRAMEBUFFER
#define GL_FRAMEBUFFER                     0x8D40
#define GL_READ_FRAMEBUFFER                0x8CA8
#define GL_DRAW_FRAMEBUFFER                0x8CA9
#define GL_FRAMEBUFFER_BINDING             0x8CA6
#define GL_DRAW_FRAMEBUFFER_BINDING        0x8CA6
#define GL_READ_FRAMEBUFFER_BINDING        0x8CAA
#define GL_RENDERBUFFER                    0x8D41
#define GL_RENDERBUFFER_BINDING            0x8CA7
#define GL_COLOR_ATTACHMENT0               0x8CE0
#define GL_DEPTH_STENCIL_ATTACHMENT        0x821A
#define GL_DEPTH_ATTACHMENT                0x8D00
#define GL_STENCIL_ATTACHMENT              0x8D20
#define GL_DEPTH24_STENCIL8                0x88F0
#define GL_FRAMEBUFFER_COMPLETE            0x8CD5
#define GL_RGBA8                           0x8058
#endif

#ifndef GL_CLAMP_TO_EDGE
#define GL_CLAMP_TO_EDGE                   0x812F
#endif

#ifndef GL_PIXEL_PACK_BUFFER
#define GL_PIXEL_PACK_BUFFER               0x88EB
#define GL_PIXEL_UNPACK_BUFFER             0x88EC
#define GL_PIXEL_PACK_BUFFER_BINDING       0x88ED
#define GL_PIXEL_UNPACK_BUFFER_BINDING     0x88EF
#endif

/* Win32 function pointer typedefs */
typedef HMODULE (WINAPI *pfn_LoadLibraryA_t)(LPCSTR);
typedef HMODULE (WINAPI *pfn_LoadLibraryW_t)(LPCWSTR);
typedef HMODULE (WINAPI *pfn_LoadLibraryExA_t)(LPCSTR, HANDLE, DWORD);
typedef HMODULE (WINAPI *pfn_LoadLibraryExW_t)(LPCWSTR, HANDLE, DWORD);
typedef FARPROC (WINAPI *pfn_GetProcAddress_t)(HMODULE, LPCSTR);
typedef BOOL    (WINAPI *pfn_CreateProcessA_t)(LPCSTR, LPSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCSTR, LPSTARTUPINFOA, LPPROCESS_INFORMATION);
typedef BOOL    (WINAPI *pfn_CreateProcessW_t)(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);

typedef BOOL (WINAPI *pfn_EnumDisplaySettingsA_t)(LPCSTR, DWORD, DEVMODEA *);
typedef BOOL (WINAPI *pfn_EnumDisplaySettingsW_t)(LPCWSTR, DWORD, DEVMODEW *);
typedef BOOL (WINAPI *pfn_EnumDisplaySettingsExA_t)(LPCSTR, DWORD, DEVMODEA *, DWORD);
typedef BOOL (WINAPI *pfn_EnumDisplaySettingsExW_t)(LPCWSTR, DWORD, DEVMODEW *, DWORD);
typedef LONG (WINAPI *pfn_ChangeDisplaySettingsA_t)(DEVMODEA *, DWORD);
typedef LONG (WINAPI *pfn_ChangeDisplaySettingsW_t)(DEVMODEW *, DWORD);
typedef LONG (WINAPI *pfn_ChangeDisplaySettingsExA_t)(LPCSTR, DEVMODEA *, HWND, DWORD, LPVOID);
typedef LONG (WINAPI *pfn_ChangeDisplaySettingsExW_t)(LPCWSTR, DEVMODEW *, HWND, DWORD, LPVOID);
typedef int  (WINAPI *pfn_GetSystemMetrics_t)(int);

typedef HWND (WINAPI *pfn_CreateWindowExA_t)(DWORD, LPCSTR, LPCSTR, DWORD, int, int, int, int, HWND, HMENU, HINSTANCE, LPVOID);
typedef HWND (WINAPI *pfn_CreateWindowExW_t)(DWORD, LPCWSTR, LPCWSTR, DWORD, int, int, int, int, HWND, HMENU, HINSTANCE, LPVOID);
typedef BOOL (WINAPI *pfn_ShowWindow_t)(HWND, int);
typedef BOOL (WINAPI *pfn_ShowWindowAsync_t)(HWND, int);
typedef BOOL (WINAPI *pfn_SetWindowPlacement_t)(HWND, const WINDOWPLACEMENT *);
typedef BOOL (WINAPI *pfn_SetWindowPos_t)(HWND, HWND, int, int, int, int, UINT);
typedef BOOL (WINAPI *pfn_MoveWindow_t)(HWND, int, int, int, int, BOOL);
typedef LONG (WINAPI *pfn_GetWindowLongA_t)(HWND, int);
typedef LONG (WINAPI *pfn_GetWindowLongW_t)(HWND, int);
typedef LONG (WINAPI *pfn_SetWindowLongA_t)(HWND, int, LONG);
typedef LONG (WINAPI *pfn_SetWindowLongW_t)(HWND, int, LONG);
#if defined(_WIN64)
typedef LONG_PTR (WINAPI *pfn_GetWindowLongPtrA_t)(HWND, int);
typedef LONG_PTR (WINAPI *pfn_GetWindowLongPtrW_t)(HWND, int);
typedef LONG_PTR (WINAPI *pfn_SetWindowLongPtrA_t)(HWND, int, LONG_PTR);
typedef LONG_PTR (WINAPI *pfn_SetWindowLongPtrW_t)(HWND, int, LONG_PTR);
#endif
typedef BOOL (WINAPI *pfn_GetClientRect_t)(HWND, LPRECT);
typedef BOOL (WINAPI *pfn_GetWindowRect_t)(HWND, LPRECT);
typedef BOOL (WINAPI *pfn_GetMonitorInfoA_t)(HMONITOR, LPMONITORINFO);
typedef BOOL (WINAPI *pfn_GetMonitorInfoW_t)(HMONITOR, LPMONITORINFO);
typedef BOOL (WINAPI *pfn_AdjustWindowRect_t)(LPRECT, DWORD, BOOL);
typedef BOOL (WINAPI *pfn_AdjustWindowRectEx_t)(LPRECT, DWORD, BOOL, DWORD);

typedef BOOL (WINAPI *pfn_GetCursorPos_t)(LPPOINT);
typedef BOOL (WINAPI *pfn_SetCursorPos_t)(int, int);
typedef BOOL (WINAPI *pfn_ClipCursor_t)(const RECT *);
typedef BOOL (WINAPI *pfn_GetClipCursor_t)(LPRECT);
typedef BOOL (WINAPI *pfn_ScreenToClient_t)(HWND, LPPOINT);
typedef BOOL (WINAPI *pfn_ClientToScreen_t)(HWND, LPPOINT);
typedef int  (WINAPI *pfn_MapWindowPoints_t)(HWND, HWND, LPPOINT, UINT);
typedef HWND (WINAPI *pfn_WindowFromPoint_t)(POINT);
typedef int  (WINAPI *pfn_ReleaseDC_t)(HWND, HDC);

typedef int  (WINAPI *pfn_GetDeviceCaps_t)(HDC, int);
typedef BOOL (WINAPI *pfn_DeleteDC_t)(HDC);
typedef int  (WINAPI *pfn_ChoosePixelFormat_t)(HDC, const PIXELFORMATDESCRIPTOR *);
typedef int  (WINAPI *pfn_DescribePixelFormat_t)(HDC, int, UINT, LPPIXELFORMATDESCRIPTOR);
typedef int  (WINAPI *pfn_GetPixelFormat_t)(HDC);
typedef BOOL (WINAPI *pfn_SetPixelFormat_t)(HDC, int, const PIXELFORMATDESCRIPTOR *);
typedef BOOL (WINAPI *pfn_BitBlt_t)(HDC, int, int, int, int, HDC, int, int, DWORD);
typedef BOOL (WINAPI *pfn_StretchBlt_t)(HDC, int, int, int, int, HDC, int, int, int, int, DWORD);
typedef int  (WINAPI *pfn_SetDIBitsToDevice_t)(HDC, int, int, DWORD, DWORD, int, int, UINT, UINT, const VOID *, const BITMAPINFO *, UINT);
typedef int  (WINAPI *pfn_StretchDIBits_t)(HDC, int, int, int, int, int, int, int, int, const VOID *, const BITMAPINFO *, UINT, DWORD);
typedef BOOL (WINAPI *pfn_SwapBuffers_t)(HDC);

typedef HGLRC (WINAPI *pfn_wglCreateContext_t)(HDC);
typedef HGLRC (WINAPI *pfn_wglCreateLayerContext_t)(HDC, int);
typedef HDC   (WINAPI *pfn_wglGetCurrentDC_t)(void);
typedef int   (WINAPI *pfn_wglChoosePixelFormat_t)(HDC, const PIXELFORMATDESCRIPTOR *);
typedef int   (WINAPI *pfn_wglDescribePixelFormat_t)(HDC, int, UINT, LPPIXELFORMATDESCRIPTOR);
typedef int   (WINAPI *pfn_wglGetPixelFormat_t)(HDC);
typedef BOOL  (WINAPI *pfn_wglSetPixelFormat_t)(HDC, int, const PIXELFORMATDESCRIPTOR *);
typedef BOOL  (WINAPI *pfn_wglMakeCurrent_t)(HDC, HGLRC);
typedef BOOL  (WINAPI *pfn_wglDeleteContext_t)(HGLRC);
typedef BOOL  (WINAPI *pfn_wglSwapBuffers_t)(HDC);
typedef PROC  (WINAPI *pfn_wglGetProcAddress_t)(LPCSTR);
typedef void  (APIENTRY *pfn_glBindFramebuffer_t)(GLenum, GLuint);
typedef void  (APIENTRY *pfn_glDrawBuffer_t)(GLenum);
typedef void  (APIENTRY *pfn_glReadBuffer_t)(GLenum);

/*
 * Wine `win32u` / `wined3d` private `D3DKMTEscape` command (`0x80000001`):
 * `wined3d_swapchain_state_set_fullscreen` / `resize_target` passes a 16-byte `RECT`
 * (`pPrivateDriverData`, `PrivateDriverDataSize == sizeof(RECT)`) and `(UINT)(uintptr_t)hwnd`
 * (`hContext`) to `gdi32!D3DKMTEscape` -> `win32u!NtGdiDdDDIEscape`. When non-empty, `win32u`
 * clamps `rects->visible` (and `wineserver` mouse hit-testing) to that virtual swapchain rect
 * even when `hwnd` covers the full HiDPI physical monitor. Passing `{0,0,0,0}` clears the clamp.
 */
#define DS_WINE_D3DKMT_ESCAPE_SET_PRESENT_RECT 0x80000001u

typedef struct ds_d3dkmt_escape_s {
    UINT  hAdapter;
    UINT  hDevice;
    UINT  Type;
    UINT  Flags;
    void *pPrivateDriverData;
    UINT  PrivateDriverDataSize;
    UINT  hContext;
} ds_d3dkmt_escape_t;

typedef LONG (WINAPI *pfn_D3DKMTEscape_t)(const ds_d3dkmt_escape_t *);

typedef struct ds_runtime_s {
    CRITICAL_SECTION    lock;
    bool                lock_initialized;
    bool                active;
    bool                shutting_down;
    DWORD               tls_depth_idx;
    HMODULE             self_hmod;

    ds_scaling_mode_t   scaling_mode;
    ds_aspect_mode_t    aspect_mode;
    int32_t             safe_inset_top;
    bool                hotkey_enabled;

    WCHAR               dll_x86[MAX_PATH];
    WCHAR               dll_x64[MAX_PATH];
    WCHAR               launcher_x86[MAX_PATH];
    WCHAR               launcher_x64[MAX_PATH];
    WCHAR               control_file[MAX_PATH];
    WCHAR               status_file[MAX_PATH];
    WCHAR               trace_file[MAX_PATH];
    uint64_t            last_control_seq;
    uint64_t            status_seq;

    int32_t             real_screen_w;
    int32_t             real_screen_h;
    int32_t             phys_screen_w;
    int32_t             phys_screen_h;
    int32_t             real_bpp;
    int32_t             real_hz;

    ds_display_mode_t   modes[DS_MAX_SYNTH_MODES];
    size_t              mode_count;

    bool                mode_virtualized;
    bool                fullscreen_active;
    bool                user_forced_windowed;
    bool                is_wine;
    bool                wined3d_uses_gl;
    bool                legacy_d3d_loaded;
    bool                ddraw_loaded;
    bool                d3d8_or_9_loaded;
    int32_t             virt_w;
    int32_t             virt_h;
    int32_t             virt_bpp;
    int32_t             virt_hz;
    ds_viewport_t       vp;

    HWND                hwnd_game;
    DWORD               game_thread_id;
    WNDPROC             orig_wndproc;
    bool                orig_wndproc_unicode;
    bool                has_saved_window_state;
    bool                has_saved_class_bg;
    LONG_PTR            saved_class_bg;
    LONG_PTR            saved_style;
    LONG_PTR            saved_exstyle;
    RECT                saved_window_rect;
    int32_t             saved_client_w;
    int32_t             saved_client_h;
    /* Dedicated child HWND hosting OpenGL drawables so hwnd_game stays pure GDI */
    HWND                hwnd_gl_host;
    bool                gl_host_visible;
    bool                gl_host_want_visible;
    bool                cocoa_fs_synced;
    bool                app_inactive;
    bool                visible_resync_needed;
    bool                visible_resync_done;
    volatile LONG       gl_drawable_rebind_pending;
    DWORD               first_visible_tick;
    UINT                msg_apply_presentation;
    UINT                msg_gl_host_ctl;
    HANDLE              watcher_thread;
    HANDLE              stop_event;

    ds_cursor_warp_state_t warp;
    bool                has_virtual_clip;
    RECT                virtual_clip_rect;

    /* Real unhooked Win32 pointers */
    pfn_LoadLibraryA_t            real_LoadLibraryA;
    pfn_LoadLibraryW_t            real_LoadLibraryW;
    pfn_LoadLibraryExA_t          real_LoadLibraryExA;
    pfn_LoadLibraryExW_t          real_LoadLibraryExW;
    pfn_GetProcAddress_t          real_GetProcAddress;
    pfn_CreateProcessA_t          real_CreateProcessA;
    pfn_CreateProcessW_t          real_CreateProcessW;

    pfn_EnumDisplaySettingsA_t    real_EnumDisplaySettingsA;
    pfn_EnumDisplaySettingsW_t    real_EnumDisplaySettingsW;
    pfn_EnumDisplaySettingsExA_t  real_EnumDisplaySettingsExA;
    pfn_EnumDisplaySettingsExW_t  real_EnumDisplaySettingsExW;
    pfn_ChangeDisplaySettingsA_t  real_ChangeDisplaySettingsA;
    pfn_ChangeDisplaySettingsW_t  real_ChangeDisplaySettingsW;
    pfn_ChangeDisplaySettingsExA_t real_ChangeDisplaySettingsExA;
    pfn_ChangeDisplaySettingsExW_t real_ChangeDisplaySettingsExW;
    pfn_GetSystemMetrics_t        real_GetSystemMetrics;

    pfn_CreateWindowExA_t         real_CreateWindowExA;
    pfn_CreateWindowExW_t         real_CreateWindowExW;
    pfn_ShowWindow_t              real_ShowWindow;
    pfn_ShowWindowAsync_t         real_ShowWindowAsync;
    pfn_SetWindowPlacement_t      real_SetWindowPlacement;
    pfn_SetWindowPos_t            real_SetWindowPos;
    pfn_MoveWindow_t              real_MoveWindow;
    pfn_GetWindowLongA_t          real_GetWindowLongA;
    pfn_GetWindowLongW_t          real_GetWindowLongW;
    pfn_SetWindowLongA_t          real_SetWindowLongA;
    pfn_SetWindowLongW_t          real_SetWindowLongW;
#if defined(_WIN64)
    pfn_GetWindowLongPtrA_t       real_GetWindowLongPtrA;
    pfn_GetWindowLongPtrW_t       real_GetWindowLongPtrW;
    pfn_SetWindowLongPtrA_t       real_SetWindowLongPtrA;
    pfn_SetWindowLongPtrW_t       real_SetWindowLongPtrW;
#endif
    pfn_GetClientRect_t           real_GetClientRect;
    pfn_GetWindowRect_t           real_GetWindowRect;
    pfn_GetMonitorInfoA_t         real_GetMonitorInfoA;
    pfn_GetMonitorInfoW_t         real_GetMonitorInfoW;
    pfn_AdjustWindowRect_t        real_AdjustWindowRect;
    pfn_AdjustWindowRectEx_t      real_AdjustWindowRectEx;

    pfn_GetCursorPos_t            real_GetCursorPos;
    pfn_SetCursorPos_t            real_SetCursorPos;
    pfn_ClipCursor_t              real_ClipCursor;
    pfn_GetClipCursor_t           real_GetClipCursor;
    pfn_ScreenToClient_t          real_ScreenToClient;
    pfn_ClientToScreen_t          real_ClientToScreen;
    pfn_MapWindowPoints_t         real_MapWindowPoints;
    pfn_WindowFromPoint_t         real_WindowFromPoint;
    pfn_ReleaseDC_t               real_ReleaseDC;

    pfn_GetDeviceCaps_t           real_GetDeviceCaps;
    pfn_DeleteDC_t                real_DeleteDC;
    pfn_ChoosePixelFormat_t       real_ChoosePixelFormat;
    pfn_DescribePixelFormat_t     real_DescribePixelFormat;
    pfn_GetPixelFormat_t          real_GetPixelFormat;
    pfn_SetPixelFormat_t          real_SetPixelFormat;
    pfn_BitBlt_t                  real_BitBlt;
    pfn_StretchBlt_t              real_StretchBlt;
    pfn_SetDIBitsToDevice_t       real_SetDIBitsToDevice;
    pfn_StretchDIBits_t           real_StretchDIBits;
    pfn_SwapBuffers_t             real_SwapBuffers;
    pfn_D3DKMTEscape_t            real_D3DKMTEscape;
    pfn_D3DKMTEscape_t            real_NtGdiDdDDIEscape;

    pfn_wglCreateContext_t        real_wglCreateContext;
    pfn_wglCreateLayerContext_t   real_wglCreateLayerContext;
    pfn_wglGetCurrentDC_t         real_wglGetCurrentDC;
    pfn_wglChoosePixelFormat_t    real_wglChoosePixelFormat;
    pfn_wglDescribePixelFormat_t  real_wglDescribePixelFormat;
    pfn_wglGetPixelFormat_t       real_wglGetPixelFormat;
    pfn_wglSetPixelFormat_t       real_wglSetPixelFormat;
    pfn_wglMakeCurrent_t          real_wglMakeCurrent;
    pfn_wglDeleteContext_t        real_wglDeleteContext;
    pfn_wglSwapBuffers_t          real_wglSwapBuffers;
    pfn_wglGetProcAddress_t       real_wglGetProcAddress;
    pfn_glDrawBuffer_t            real_glDrawBuffer;
    pfn_glReadBuffer_t            real_glReadBuffer;
} ds_runtime_t;

extern ds_runtime_t g_ds;

/*
 * 16bpp DirectDraw HAL compatibility preference applies exclusively when `ddraw.dll`
 * is loaded without D3D8/D3D9 (`d3d8.dll` / `d3d9.dll`), preserving 1990s DirectDraw/D3D5-7
 * hardware acceleration while keeping 32bpp untouched for D3D8+ titles.
 */
static inline bool ds_prefer_16bpp_ddraw(void)
{
    return g_ds.ddraw_loaded && !g_ds.d3d8_or_9_loaded;
}

/* Internal recursion guard & caller module classifier (`display_scaler_dll.c`) */
bool ds_is_internal_call(void);
void ds_enter_internal(void);
void ds_leave_internal(void);
uintptr_t ds_suspend_internal_depth(void);
void ds_restore_internal_depth(uintptr_t saved_depth);
bool ds_is_system_renderer_caller(const void *ret_addr);
bool ds_is_wined3d_caller(const void *ret_addr);
bool ds_should_virtualize_rect_for_caller(const void *ret_addr);
void ds_patch_loaded_modules(void);
void ds_refresh_viewport_locked(void);
int32_t ds_get_windowed_scale_locked(void);
void ds_clear_wine_present_rect_on_hwnd(HWND hwnd);
void ds_tracef(const char *fmt, ...);

/* Window, GL host child, WndProc, hotkeys & control-file watcher (`display_scaler_window.c`) */
LRESULT CALLBACK ds_game_subclass_wndproc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);
LONG_PTR ds_get_wnd_long_ptr(HWND hwnd, int idx);
LONG_PTR ds_set_wnd_long_ptr_raw(HWND hwnd, int idx, LONG_PTR val, bool unicode);
bool ds_is_candidate_game_window(HWND hwnd, int32_t *out_cw, int32_t *out_ch);
void ds_attach_and_apply_game_window(HWND hwnd, int32_t hint_virt_w, int32_t hint_virt_h);
void ds_ensure_game_window_bounds(HWND candidate_hwnd);
void ds_ensure_gl_host_child_on_owner_thread(HWND hwnd_parent);
void ds_sync_gl_host_bounds_on_owner_thread(HWND hwnd_parent);
void ds_refresh_gl_host_drawable_on_owner_thread(HWND hwnd_parent);
void ds_demote_fullscreen_on_deactivate(HWND target_hwnd);
void ds_set_gl_host_visible(bool visible);
void ds_reset_gl_host_for_gdi(void);
void ds_set_class_bg_brush(HWND hwnd, LONG_PTR brush_val);
void ds_request_apply_presentation(void);
void ds_ensure_fullscreen_styles_on_owner_thread(HWND hwnd);
void ds_apply_window_presentation_on_owner_thread(HWND hwnd);
void ds_write_status_file(void);
void ds_start_control_watcher(void);
void ds_stop_control_watcher(void);
void ds_reapply_cursor_clip_locked(void);

/* OpenGL FBO, GDI 2D & WineD3D GL drawable upscaler hooks (`display_scaler_gl_gdi.c`) */
void ds_gl_notify_mode_changed(void);
void ds_gl_notify_display_mode_switch(void);
void ds_gl_shutdown(void);
void ds_gl_release_all_host_dcs_for_hwnd(HWND host_hwnd);
void ds_gl_on_release_dc(HWND hwnd, HDC hdc);
void *ds_resolve_gl_hook_proc(const char *name, void *real_fn);
void *ds_resolve_wined3d_gl_proc(const char *name, void *real_fn);

int     WINAPI hook_ReleaseDC(HWND hWnd, HDC hDC);
BOOL    WINAPI hook_DeleteDC(HDC hdc);
int     WINAPI hook_ChoosePixelFormat(HDC hdc, const PIXELFORMATDESCRIPTOR *ppfd);
int     WINAPI hook_DescribePixelFormat(HDC hdc, int iPixelFormat, UINT nBytes, LPPIXELFORMATDESCRIPTOR ppfd);
int     WINAPI hook_GetPixelFormat(HDC hdc);
BOOL    WINAPI hook_SetPixelFormat(HDC hdc, int format, const PIXELFORMATDESCRIPTOR *ppfd);
int     WINAPI hook_GetDeviceCaps(HDC hdc, int index);
BOOL    WINAPI hook_BitBlt(HDC hdcDst, int x, int y, int cx, int cy, HDC hdcSrc, int x1, int y1, DWORD rop);
BOOL    WINAPI hook_StretchBlt(HDC hdcDst, int xDst, int yDst, int wDst, int hDst, HDC hdcSrc, int xSrc, int ySrc, int wSrc, int hSrc, DWORD rop);
int     WINAPI hook_SetDIBitsToDevice(HDC hdc, int xDest, int yDest, DWORD w, DWORD h, int xSrc, int ySrc, UINT StartScan, UINT cLines, const VOID *lpvBits, const BITMAPINFO *lpbmi, UINT ColorUse);
int     WINAPI hook_StretchDIBits(HDC hdc, int xDest, int yDest, int DestWidth, int DestHeight, int xSrc, int ySrc, int SrcWidth, int SrcHeight, const VOID *lpBits, const BITMAPINFO *lpbmi, UINT iUsage, DWORD rop);
BOOL    WINAPI hook_SwapBuffers(HDC hdc);
HGLRC   WINAPI hook_wglCreateContext(HDC hdc);
HGLRC   WINAPI hook_wglCreateLayerContext(HDC hdc, int iLayerPlane);
HDC     WINAPI hook_wglGetCurrentDC(void);
int     WINAPI hook_wglChoosePixelFormat(HDC hdc, const PIXELFORMATDESCRIPTOR *ppfd);
int     WINAPI hook_wglDescribePixelFormat(HDC hdc, int iPixelFormat, UINT nBytes, LPPIXELFORMATDESCRIPTOR ppfd);
int     WINAPI hook_wglGetPixelFormat(HDC hdc);
BOOL    WINAPI hook_wglSetPixelFormat(HDC hdc, int format, const PIXELFORMATDESCRIPTOR *ppfd);
BOOL    WINAPI hook_wglMakeCurrent(HDC hdc, HGLRC hglrc);
BOOL    WINAPI hook_wglDeleteContext(HGLRC hglrc);
BOOL    WINAPI hook_wglSwapBuffers(HDC hdc);
PROC    WINAPI hook_wglGetProcAddress(LPCSTR lpszProc);
void    APIENTRY hook_glDrawBuffer(GLenum mode);
void    APIENTRY hook_glReadBuffer(GLenum mode);

#endif /* ONE_LAUNCHER_DISPLAY_SCALER_INTERNAL_H */
